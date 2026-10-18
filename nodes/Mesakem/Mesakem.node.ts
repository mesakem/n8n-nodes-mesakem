import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	type IDataObject,
	type IExecuteFunctions,
	type ILoadOptionsFunctions,
	type INodeExecutionData,
	type INodeListSearchResult,
	type INodeType,
	type INodeTypeDescription,
} from 'n8n-workflow';
import { idSegment, isObject, str } from '../shared/config';
import { toApiDate } from '../shared/dates';
import type { OperationInfo } from '../shared/errors';
import {
	idempotencyKey,
	mesakemJson,
	mesakemList,
	mesakemRequest,
	type MesakemContext,
} from '../shared/transport';
import {
	botProperties,
	documentProperties,
	meetingProperties,
	operationProperties,
	resourceProperty,
	taskProperties,
} from './descriptions';

/** Label + scope of every operation, for clear plan / permission errors. */
export const OPERATIONS: Record<string, OperationInfo> = {
	'meeting.get': { label: 'Get a meeting', scope: 'meetings:read' },
	'meeting.getAll': { label: 'Get many meetings', scope: 'meetings:read' },
	'meeting.summary': { label: 'Get a meeting summary', scope: 'summaries:read' },
	'meeting.transcript': { label: 'Get a meeting transcript', scope: 'transcripts:read' },
	'meeting.upcoming': { label: 'Get upcoming meetings', scope: 'calendar:read' },
	'task.get': { label: 'Get a task', scope: 'tasks:read' },
	'task.getAll': { label: 'Get many tasks', scope: 'tasks:read' },
	'task.create': { label: 'Create a task', scope: 'tasks:write', write: true },
	'task.update': { label: 'Update a task', scope: 'tasks:write', write: true },
	'task.delete': { label: 'Delete a task', scope: 'tasks:write', write: true },
	'bot.send': { label: 'Send the notetaker', scope: 'bot:write', write: true },
	'bot.schedule': { label: 'Schedule the notetaker', scope: 'bot:write', write: true },
	'bot.cancel': { label: 'Cancel the notetaker', scope: 'bot:write', write: true },
	'document.get': { label: 'Get a document', scope: 'summaries:read' },
	'me.get': { label: 'Get the account of this key', scope: 'none' },
};

function locatorValue(value: unknown): string {
	if (isObject(value)) return String(value.value ?? '').trim();
	return String(value ?? '').trim();
}

function compact(values: IDataObject): IDataObject {
	const out: IDataObject = {};
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined || value === null || value === '') continue;
		if (Array.isArray(value) && value.length === 0) continue;
		out[key] = value;
	}
	return out;
}

function shortDate(value: unknown): string {
	return typeof value === 'string' && value.length >= 10 ? value.slice(0, 16).replace('T', ' ') : '';
}

async function searchList(
	context: MesakemContext,
	path: string,
	operation: OperationInfo,
	filter: string | undefined,
	paginationToken: string | undefined,
	qs: IDataObject,
	label: (row: IDataObject) => string,
): Promise<INodeListSearchResult> {
	const page = await mesakemJson.call(context, {
		method: 'GET',
		path,
		qs: { ...qs, limit: 50, cursor: paginationToken },
		operation,
	});
	const rows = Array.isArray(page.data) ? (page.data.filter(isObject) as IDataObject[]) : [];
	const needle = (filter ?? '').trim().toLowerCase();
	const results = rows
		.map((row) => ({ name: label(row), value: String(row.id ?? ''), url: str(row.app_url) ?? undefined }))
		.filter((row) => row.value && (!needle || row.name.toLowerCase().includes(needle)));
	const next = page.has_more === true && typeof page.next_cursor === 'string' ? page.next_cursor : undefined;
	return { results, paginationToken: next };
}

export class Mesakem implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Mesakem',
		name: 'mesakem',
		icon: { light: 'file:../../icons/mesakem.svg', dark: 'file:../../icons/mesakem.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Read meetings, summaries, transcripts and tasks from Mesakem, manage tasks and send the notetaker',
		defaults: { name: 'Mesakem' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'mesakemApi', required: true }],
		properties: [
			resourceProperty,
			...operationProperties,
			...meetingProperties,
			...taskProperties,
			...botProperties,
			...documentProperties,
		],
	};

	methods = {
		listSearch: {
			async searchMeetings(
				this: ILoadOptionsFunctions,
				filter?: string,
				paginationToken?: string,
			): Promise<INodeListSearchResult> {
				return searchList(this, '/meetings', OPERATIONS['meeting.getAll'], filter, paginationToken, {}, (row) => {
					const when = shortDate(row.start_time ?? row.created_at);
					return `${str(row.title) ?? 'Untitled meeting'}${when ? ` (${when})` : ''}`;
				});
			},
			async searchUpcomingMeetings(
				this: ILoadOptionsFunctions,
				filter?: string,
				paginationToken?: string,
			): Promise<INodeListSearchResult> {
				return searchList(this, '/meetings/upcoming', OPERATIONS['meeting.upcoming'], filter, paginationToken, {}, (row) => {
					const when = shortDate(row.start_time);
					return `${str(row.title) ?? 'Untitled meeting'}${when ? ` (${when})` : ''}`;
				});
			},
			async searchTasks(
				this: ILoadOptionsFunctions,
				filter?: string,
				paginationToken?: string,
			): Promise<INodeListSearchResult> {
				return searchList(this, '/tasks', OPERATIONS['task.getAll'], filter, paginationToken, { status: 'active' }, (row) => {
					const status = str(row.status);
					return `${str(row.title) ?? 'Untitled task'}${status ? ` [${status}]` : ''}`;
				});
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const output: INodeExecutionData[] = [];
		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				const resource = this.getNodeParameter('resource', itemIndex) as string;
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				const rows = await runOperation.call(this, resource, operation, itemIndex);
				for (const json of rows) output.push({ json, pairedItem: { item: itemIndex } });
			} catch (error) {
				if (this.continueOnFail()) {
					output.push({ json: { error: (error as Error).message }, pairedItem: { item: itemIndex } });
					continue;
				}
				const failure =
					error instanceof NodeApiError || error instanceof NodeOperationError
						? error
						: new NodeOperationError(this.getNode(), error as Error, { itemIndex });
				throw failure;
			}
		}
		return [output];
	}
}

function requireId(context: IExecuteFunctions, value: unknown, what: string, itemIndex: number): string {
	const segment = idSegment(locatorValue(value));
	if (!segment) {
		throw new NodeOperationError(context.getNode(), `Choose a ${what} or enter its Mesakem ID`, { itemIndex });
	}
	return segment;
}

async function runOperation(
	this: IExecuteFunctions,
	resource: string,
	operation: string,
	itemIndex: number,
): Promise<IDataObject[]> {
	const key = `${resource}.${operation}`;
	const info = OPERATIONS[key];
	if (!info) {
		throw new NodeOperationError(this.getNode(), `The operation "${operation}" is not supported for "${resource}"`, { itemIndex });
	}
	const timeZone = this.getTimezone();
	const date = (value: unknown) => toApiDate(value, timeZone);
	const base = { operation: info, itemIndex };
	const writeKey = () => idempotencyKey(this.getExecutionId(), this.getNode().id, itemIndex, key);

	switch (key) {
		case 'me.get':
			return [await mesakemJson.call(this, { ...base, method: 'GET', path: '/me' })];

		case 'meeting.get': {
			const id = requireId(this, this.getNodeParameter('meetingId', itemIndex), 'meeting', itemIndex);
			const expand = this.getNodeParameter('expand', itemIndex, []) as string[];
			return [await mesakemJson.call(this, { ...base, method: 'GET', path: `/meetings/${id}`, qs: { expand } })];
		}

		case 'meeting.getAll': {
			const returnAll = this.getNodeParameter('returnAll', itemIndex) as boolean;
			const limit = returnAll ? 0 : (this.getNodeParameter('limit', itemIndex) as number);
			const filters = this.getNodeParameter('filters', itemIndex, {}) as IDataObject;
			const qs = compact({
				status: filters.status,
				order: filters.order,
				expand: filters.expand,
				from: date(filters.from),
				to: date(filters.to),
				updated_since: date(filters.updated_since),
			});
			return mesakemList.call(this, { ...base, method: 'GET', path: '/meetings', qs }, returnAll, limit);
		}

		case 'meeting.upcoming': {
			const returnAll = this.getNodeParameter('returnAll', itemIndex) as boolean;
			const limit = returnAll ? 0 : (this.getNodeParameter('limit', itemIndex) as number);
			const filters = this.getNodeParameter('upcomingFilters', itemIndex, {}) as IDataObject;
			const qs = compact({ within_hours: filters.within_hours, from: date(filters.from), to: date(filters.to) });
			return mesakemList.call(this, { ...base, method: 'GET', path: '/meetings/upcoming', qs }, returnAll, limit);
		}

		case 'meeting.summary': {
			const id = requireId(this, this.getNodeParameter('meetingId', itemIndex), 'meeting', itemIndex);
			const format = this.getNodeParameter('summaryFormat', itemIndex, 'json') as string;
			if (format === 'json') {
				return [await mesakemJson.call(this, { ...base, method: 'GET', path: `/meetings/${id}/summary`, qs: { format } })];
			}
			const response = await mesakemRequest.call(this, {
				...base,
				method: 'GET',
				path: `/meetings/${id}/summary`,
				qs: { format },
				accept: 'text',
			});
			return [{ meeting_id: decodeURIComponent(id), format, content: String(response.body ?? '') }];
		}

		case 'meeting.transcript': {
			const id = requireId(this, this.getNodeParameter('meetingId', itemIndex), 'meeting', itemIndex);
			const format = this.getNodeParameter('transcriptFormat', itemIndex, 'text') as string;
			if (format !== 'json') {
				const response = await mesakemRequest.call(this, {
					...base,
					method: 'GET',
					path: `/meetings/${id}/transcript`,
					qs: { format },
					accept: 'text',
				});
				return [{ meeting_id: decodeURIComponent(id), format, text: String(response.body ?? '') }];
			}
			const all = this.getNodeParameter('returnAllSegments', itemIndex, true) as boolean;
			let cursor: string | undefined;
			let first: IDataObject | null = null;
			const segments: unknown[] = [];
			do {
				const page = await mesakemJson.call(this, {
					...base,
					method: 'GET',
					path: `/meetings/${id}/transcript`,
					qs: { format: 'json', limit: 100, cursor },
				});
				if (!first) first = page;
				if (Array.isArray(page.segments)) segments.push(...page.segments);
				cursor = all && page.has_more === true && typeof page.next_cursor === 'string' ? page.next_cursor : undefined;
			} while (cursor);
			const transcript = { ...(first ?? {}), segments } as IDataObject;
			if (all) {
				transcript.has_more = false;
				transcript.next_cursor = null;
			}
			return [transcript];
		}

		case 'document.get': {
			const raw = this.getNodeParameter('documentId', itemIndex) as string;
			const id = requireId(this, raw, 'document', itemIndex);
			const format = this.getNodeParameter('documentFormat', itemIndex, 'json') as string;
			return [await mesakemJson.call(this, { ...base, method: 'GET', path: `/documents/${id}`, qs: { format } })];
		}

		case 'task.get': {
			const id = requireId(this, this.getNodeParameter('taskId', itemIndex), 'task', itemIndex);
			const options = this.getNodeParameter('taskOptions', itemIndex, {}) as IDataObject;
			return [await mesakemJson.call(this, { ...base, method: 'GET', path: `/tasks/${id}`, qs: compact({ items_limit: options.items_limit }) })];
		}

		case 'task.getAll': {
			const returnAll = this.getNodeParameter('returnAll', itemIndex) as boolean;
			const limit = returnAll ? 0 : (this.getNodeParameter('limit', itemIndex) as number);
			const filters = this.getNodeParameter('taskFilters', itemIndex, {}) as IDataObject;
			const qs = compact({
				status: filters.status,
				source: filters.source,
				meeting_id: filters.meeting_id,
				order: filters.order,
				updated_since: date(filters.updated_since),
				due_after: date(filters.due_after),
				due_before: date(filters.due_before),
			});
			return mesakemList.call(this, { ...base, method: 'GET', path: '/tasks', qs }, returnAll, limit);
		}

		case 'task.create': {
			const title = String(this.getNodeParameter('title', itemIndex) ?? '').trim();
			if (!title) throw new NodeOperationError(this.getNode(), 'The task needs a title', { itemIndex });
			const fields = this.getNodeParameter('additionalFields', itemIndex, {}) as IDataObject;
			const items = String(fields.items ?? '')
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean);
			if (items.length > 24) {
				throw new NodeOperationError(this.getNode(), 'A task can have at most 24 checklist items', { itemIndex });
			}
			const assignee = compact({ name: fields.assigneeName, email: fields.assigneeEmail });
			const body = compact({
				title,
				description: fields.description,
				status: fields.status,
				due_at: date(fields.dueAt),
				assignee: Object.keys(assignee).length ? assignee : undefined,
				items: items.length ? items : undefined,
			});
			return [await mesakemJson.call(this, { ...base, method: 'POST', path: '/tasks', body, idempotencyKey: writeKey() })];
		}

		case 'task.update': {
			const id = requireId(this, this.getNodeParameter('taskId', itemIndex), 'task', itemIndex);
			const fields = this.getNodeParameter('updateFields', itemIndex, {}) as IDataObject;
			const body = compact({ title: fields.title, description: fields.description, status: fields.status });
			if (Object.keys(body).length === 0) {
				throw new NodeOperationError(this.getNode(), 'Add at least one field to update', { itemIndex });
			}
			return [await mesakemJson.call(this, { ...base, method: 'PATCH', path: `/tasks/${id}`, body, idempotencyKey: writeKey() })];
		}

		case 'task.delete': {
			const id = requireId(this, this.getNodeParameter('taskId', itemIndex), 'task', itemIndex);
			return [await mesakemJson.call(this, { ...base, method: 'DELETE', path: `/tasks/${id}` })];
		}

		case 'bot.send': {
			const meetingUrl = String(this.getNodeParameter('meetingUrl', itemIndex) ?? '').trim();
			if (!meetingUrl) throw new NodeOperationError(this.getNode(), 'Enter the meeting link', { itemIndex });
			const fields = this.getNodeParameter('botFields', itemIndex, {}) as IDataObject;
			const body = compact({
				meeting_url: meetingUrl,
				title: fields.title,
				language: fields.language,
				summary_language: fields.summary_language,
				summary_recipient_email: fields.summary_recipient_email,
				start_time: date(fields.start_time),
				end_time: date(fields.end_time),
			});
			return [await mesakemJson.call(this, { ...base, method: 'POST', path: '/meetings/bot', body, idempotencyKey: writeKey() })];
		}

		case 'bot.schedule': {
			const id = requireId(this, this.getNodeParameter('eventId', itemIndex), 'upcoming meeting', itemIndex);
			const applyToSeries = this.getNodeParameter('applyToSeries', itemIndex, false) as boolean;
			return [
				await mesakemJson.call(this, {
					...base,
					method: 'POST',
					path: `/meetings/${id}/bot`,
					body: { apply_to_series: applyToSeries },
					idempotencyKey: writeKey(),
				}),
			];
		}

		case 'bot.cancel': {
			const id = requireId(this, this.getNodeParameter('cancelTarget', itemIndex), 'meeting', itemIndex);
			const applyToSeries = this.getNodeParameter('applyToSeries', itemIndex, false) as boolean;
			const qs = id.startsWith('cal_evt_') && applyToSeries ? { apply_to_series: 'true' } : {};
			return [await mesakemJson.call(this, { ...base, method: 'DELETE', path: `/meetings/${id}/bot`, qs })];
		}
	}
	throw new NodeOperationError(this.getNode(), `The operation "${operation}" is not supported for "${resource}"`, { itemIndex });
}
