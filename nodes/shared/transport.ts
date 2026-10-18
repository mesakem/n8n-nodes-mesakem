import { createHash } from 'node:crypto';
import {
	NodeApiError,
	NodeOperationError,
	type IDataObject,
	type IExecuteFunctions,
	type IHookFunctions,
	type IHttpRequestMethods,
	type IHttpRequestOptions,
	type ILoadOptionsFunctions,
	type IN8nHttpFullResponse,
	type IWebhookFunctions,
	type JsonObject,
} from 'n8n-workflow';
import {
	CREDENTIAL_NAME,
	MAX_PAGE_SIZE,
	USER_AGENT,
	cleanQuery,
	isObject,
	normalizeBaseUrl,
} from './config';
import { apiError, type OperationInfo } from './errors';

export type MesakemContext =
	| IExecuteFunctions
	| IHookFunctions
	| IWebhookFunctions
	| ILoadOptionsFunctions;

export interface MesakemRequest {
	method: IHttpRequestMethods;
	/** Path under the API base, e.g. `/meetings/run_1`. */
	path: string;
	qs?: Record<string, unknown>;
	body?: IDataObject;
	/** Sent as `Idempotency-Key` (writes that must never run twice). */
	idempotencyKey?: string;
	/** `text` for text formats (plain-text transcripts, Markdown or HTML summaries): returns a string body. */
	accept?: 'json' | 'text';
	/** Statuses returned to the caller instead of throwing (e.g. 404 = deleted meanwhile). */
	allowStatuses?: number[];
	operation?: OperationInfo;
	itemIndex?: number;
}

export interface MesakemResponse {
	statusCode: number;
	body: unknown;
	headers: Record<string, unknown>;
}

/** The validated API base of the connected credential. */
export async function apiBase(this: MesakemContext): Promise<string> {
	const credentials = await this.getCredentials(CREDENTIAL_NAME);
	const result = normalizeBaseUrl(credentials.baseUrl);
	if (!result.ok) throw new NodeOperationError(this.getNode(), result.message);
	return result.base;
}

function parseJsonBody(body: unknown): unknown {
	if (typeof body === 'string') {
		const trimmed = body.trim();
		if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
			try {
				return JSON.parse(trimmed);
			} catch {
				return body;
			}
		}
	}
	return body;
}

/**
 * One request to the Mesakem API with the credential's key (added by n8n from the credential;
 * the key is never read or logged here). Errors become friendly NodeApiErrors.
 */
export async function mesakemRequest(
	this: MesakemContext,
	request: MesakemRequest,
): Promise<MesakemResponse> {
	const base = await apiBase.call(this);
	const text = request.accept === 'text';
	const headers: IDataObject = {
		Accept: text ? '*/*' : 'application/json',
		'User-Agent': USER_AGENT,
	};
	if (request.body !== undefined) headers['Content-Type'] = 'application/json';
	if (request.idempotencyKey) headers['Idempotency-Key'] = request.idempotencyKey;

	const options: IHttpRequestOptions = {
		method: request.method,
		url: `${base}${request.path}`,
		qs: cleanQuery(request.qs),
		headers,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	};
	if (request.body !== undefined) options.body = request.body;
	if (text) options.encoding = 'text';
	else options.json = true;

	let response: IN8nHttpFullResponse;
	try {
		response = (await this.helpers.httpRequestWithAuthentication.call(
			this,
			CREDENTIAL_NAME,
			options,
		)) as IN8nHttpFullResponse;
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as JsonObject, {
			message: 'Could not reach Mesakem',
			description:
				'Check the Base URL in the Mesakem credential and that this n8n instance can reach the internet.',
			itemIndex: request.itemIndex,
		});
	}

	const statusCode = Number(response.statusCode);
	const responseHeaders = (isObject(response.headers) ? response.headers : {}) as Record<
		string,
		unknown
	>;
	const body = text && statusCode < 400 ? response.body : parseJsonBody(response.body);
	if (statusCode >= 400 && !(request.allowStatuses ?? []).includes(statusCode)) {
		throw apiError(
			this.getNode(),
			statusCode,
			body,
			responseHeaders,
			request.operation,
			request.itemIndex,
		);
	}
	return { statusCode, body, headers: responseHeaders };
}

/** JSON body of a successful request. */
export async function mesakemJson(
	this: MesakemContext,
	request: MesakemRequest,
): Promise<IDataObject> {
	const response = await mesakemRequest.call(this, request);
	return (isObject(response.body) ? response.body : {}) as IDataObject;
}

/**
 * Follows `next_cursor` until `limit` items are collected (or every item when `returnAll`).
 * Each page is one request of at most 100 items.
 */
export async function mesakemList(
	this: MesakemContext,
	request: MesakemRequest,
	returnAll: boolean,
	limit: number,
): Promise<IDataObject[]> {
	const items: IDataObject[] = [];
	let cursor: string | null = null;
	const wanted = returnAll ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor(limit));
	do {
		const pageSize = Math.min(MAX_PAGE_SIZE, wanted - items.length);
		const page: IDataObject = await mesakemJson.call(this, {
			...request,
			qs: { ...(request.qs ?? {}), limit: pageSize, cursor: cursor ?? undefined },
		});
		const data = Array.isArray(page.data) ? (page.data.filter(isObject) as IDataObject[]) : [];
		items.push(...data);
		cursor = page.has_more === true && typeof page.next_cursor === 'string' ? page.next_cursor : null;
		if (data.length === 0) break;
	} while (cursor && items.length < wanted);
	return returnAll ? items : items.slice(0, wanted);
}

/**
 * Idempotency key for a write: stable for the same execution, node and item, so n8n's
 * "Retry On Fail" never sends a second bot or creates a second task.
 */
export function idempotencyKey(
	executionId: string,
	nodeId: string,
	itemIndex: number,
	operation: string,
): string {
	const digest = createHash('sha256')
		.update(`${executionId}|${nodeId}|${itemIndex}|${operation}`)
		.digest('hex');
	return `n8n-${digest.slice(0, 48)}`;
}
