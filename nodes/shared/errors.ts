import { NodeApiError, type INode, type JsonObject } from 'n8n-workflow';
import { SETTINGS_PATH, isObject } from './config';

/**
 * Friendly errors for the Mesakem API error shape
 * `{ error: { code, message, details: [{ field, message }], request_id } }`.
 *
 * The API is the source of truth for plans and scopes: Free and trial keys are read-only (every
 * write answers 403 `plan_required`) and each route needs one scope (403 `insufficient_scope`).
 * The nodes never pre-check with an extra request; they turn those answers into clear messages.
 */

export interface OperationInfo {
	/** Shown in messages, e.g. "Create a task". */
	label: string;
	/** The scope the route needs, e.g. "tasks:write". */
	scope: string;
	/** True for routes that change data (paid plans only). */
	write?: boolean;
	/** True for webhook management calls made by the trigger. */
	webhook?: boolean;
}

export interface ApiErrorParts {
	code: string | null;
	message: string | null;
	details: Array<{ field?: string; message?: string }>;
	requestId: string | null;
	meetingId: string | null;
}

function parseBody(body: unknown): unknown {
	if (typeof body === 'string' && body.trim().startsWith('{')) {
		try {
			return JSON.parse(body);
		} catch {
			return null;
		}
	}
	return body;
}

function headerValue(headers: Record<string, unknown> | undefined, name: string): string | null {
	if (!headers) return null;
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() !== wanted) continue;
		if (Array.isArray(value)) return value.length ? String(value[0]) : null;
		return value === undefined || value === null ? null : String(value);
	}
	return null;
}

export function apiErrorParts(body: unknown, headers?: Record<string, unknown>): ApiErrorParts {
	const parsed = parseBody(body);
	const error = isObject(parsed) && isObject(parsed.error) ? parsed.error : {};
	const details = Array.isArray(error.details)
		? (error.details.filter(isObject) as Array<{ field?: string; message?: string }>)
		: [];
	return {
		code: typeof error.code === 'string' ? error.code : null,
		message: typeof error.message === 'string' ? error.message : null,
		details,
		requestId:
			typeof error.request_id === 'string' ? error.request_id : headerValue(headers, 'x-request-id'),
		meetingId: typeof error.meeting_id === 'string' ? error.meeting_id : null,
	};
}

export function retryAfterSeconds(headers?: Record<string, unknown>): number {
	const raw = (headerValue(headers, 'retry-after') ?? '').trim();
	if (/^\d{1,7}$/.test(raw)) return Math.max(1, Number(raw));
	const date = Date.parse(raw);
	if (Number.isFinite(date)) return Math.max(1, Math.ceil((date - Date.now()) / 1000));
	return 60;
}

function detailText(parts: ApiErrorParts): string {
	return parts.details
		.map((item) => (typeof item.message === 'string' ? item.message : ''))
		.filter(Boolean)
		.join(' ');
}

/** Message + description for a failed Mesakem response. Pure, so it is easy to test. */
export function describeApiError(
	status: number,
	body: unknown,
	headers: Record<string, unknown> | undefined,
	operation?: OperationInfo,
): { message: string; description: string; code: string } {
	const parts = apiErrorParts(body, headers);
	const detail = detailText(parts);
	const ref = parts.requestId ? `Mesakem request id: ${parts.requestId}.` : '';
	const what = operation ? `"${operation.label}"` : 'This step';
	const code = parts.code ?? `http_${status}`;
	const out = (message: string, extra = '') => ({
		message,
		description: [extra, detail && !extra.includes(detail) ? `Details: ${detail}` : '', ref]
			.filter(Boolean)
			.join(' '),
		code,
	});

	if (status === 401) {
		return out(
			'Mesakem did not accept this API key',
			`The key may be mistyped, revoked or expired. Create a new key in ${SETTINGS_PATH} and update the Mesakem credential in n8n.`,
		);
	}

	if (status === 403) {
		if (operation?.webhook && parts.details.some((item) => item.field === 'endpoints')) {
			return out(
				"You have reached your Mesakem plan's limit of webhook endpoints",
				`Each active Mesakem Trigger uses one endpoint. Deactivate a workflow you no longer need, or delete an unused endpoint in ${SETTINGS_PATH}.`,
			);
		}
		if (operation?.webhook && (parts.code === 'insufficient_scope' || parts.code === 'plan_required')) {
			return out(
				"Automatic registration needs a key with the 'Manage webhooks' permission on a paid plan",
				`Create a key that includes 'Manage webhooks' (webhooks:write) in ${SETTINGS_PATH} and update the credential. ` +
					"On the Free plan, set 'Registration' to 'Manual' and add this workflow's address as your one webhook in Mesakem Settings.",
			);
		}
		if (parts.code === 'plan_required') {
			return out(
				`Your Mesakem plan cannot run ${what}`,
				operation?.write
					? 'Free and trial plans have read-only API access. Creating, changing or deleting data and sending the notetaker need a paid Mesakem plan. Upgrade in Mesakem, then run the step again.'
					: 'Your plan does not include this part of the Mesakem API.',
			);
		}
		if (parts.code === 'insufficient_scope') {
			const scope = operation?.scope ? ` "${operation.scope}"` : '';
			return out(
				`This API key is missing the${scope} permission that ${what} needs`,
				`Create a key that includes it in ${SETTINGS_PATH}, then update the Mesakem credential in n8n.`,
			);
		}
		if (parts.code === 'quota_exceeded') {
			return out(
				"Your Mesakem plan's meeting quota does not allow this right now",
				'The notetaker cannot join more meetings on this plan this period. Check your plan in Mesakem.',
			);
		}
		if (parts.code === 'organization_policy') {
			return out(
				'Your organization admin has turned off API keys and webhooks for members',
				'Ask an admin of your Mesakem organization to allow members to use the API.',
			);
		}
		return out('This API key cannot access this item', parts.message ?? '');
	}

	if (status === 404) {
		if (operation?.webhook) {
			return out(
				'Webhooks are not available for this Mesakem account or server yet',
				'Check the Base URL in the credential, or contact Mesakem support.',
			);
		}
		if (operation?.write) {
			return out(
				'Mesakem could not find this item, or this part of the API is not switched on yet',
				'The item may have been deleted, or this key cannot see it.',
			);
		}
		return out(
			'Mesakem could not find this item',
			'It may have been deleted, or this API key cannot see it.',
		);
	}

	if (status === 409) {
		if (parts.code === 'meeting_bot_already_active') {
			return out(
				'A Mesakem notetaker is already in this meeting',
				parts.meetingId ? `Meeting ID: ${parts.meetingId}.` : '',
			);
		}
		return out(`Mesakem refused ${what} because of a conflict`, parts.message ?? '');
	}

	if (status === 429) {
		const seconds = retryAfterSeconds(headers);
		return out(
			"Mesakem's rate limit was reached",
			`Try again in about ${seconds} seconds, or turn on "Retry On Fail" in the node settings.`,
		);
	}

	if (status === 413) {
		return out(
			'The item is too large for Mesakem to return in one response',
			'Use a smaller limit or another format.',
		);
	}

	if (status >= 500) {
		return out(
			`Mesakem is temporarily unavailable (HTTP ${status})`,
			'Please try again in a few minutes.',
		);
	}

	if (status === 400 && operation?.webhook && parts.details.some((item) => item.field === 'url')) {
		return out(
			"Mesakem refused this workflow's webhook address",
			'Mesakem only delivers to public https addresses (port 443 or 8443). Make sure n8n is reachable from the internet over https (the WEBHOOK_URL setting of your n8n instance).',
		);
	}

	return out(
		`Mesakem rejected the request (HTTP ${status})`,
		parts.message && !detail ? parts.message : '',
	);
}

export function apiError(
	node: INode,
	status: number,
	body: unknown,
	headers: Record<string, unknown> | undefined,
	operation?: OperationInfo,
	itemIndex?: number,
): NodeApiError {
	const { message, description } = describeApiError(status, body, headers, operation);
	const parsed = parseBody(body);
	const response = (isObject(parsed) ? parsed : { body: String(parsed ?? '') }) as JsonObject;
	return new NodeApiError(node, response, {
		message,
		description,
		httpCode: String(status),
		itemIndex,
	});
}
