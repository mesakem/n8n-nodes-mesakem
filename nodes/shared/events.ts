import type { IDataObject, INodePropertyOptions } from 'n8n-workflow';
import { idSegment, isObject, str } from './config';
import { mesakemRequest, type MesakemContext } from './transport';

/**
 * The Mesakem webhook event catalog (24 types) and how the trigger turns a thin delivery into
 * useful data. Payloads carry ids only:
 *
 *   { id, type, api_version, created_at, workspace_id, data: { object, …ids, links } }
 *
 * so the trigger fetches details BY ID from the credential's API base, in at most TWO requests per
 * event. `data.links.api` is never followed. A 404 (deleted meanwhile) keeps the thin event and sets
 * `resource_deleted: true` instead of failing.
 */

export const WEBHOOK_API_VERSION = '2026-10';
export const TEST_EVENT = 'webhook.test';

export interface EventDefinition {
	type: string;
	name: string;
	description: string;
}

export const EVENTS: readonly EventDefinition[] = [
	{ type: 'summary.ready', name: 'Summary Ready', description: 'The first summary of a meeting is ready' },
	{ type: 'summary.updated', name: 'Summary Updated', description: 'A summary was regenerated or edited' },
	{ type: 'action_items.created', name: 'Action Items Created', description: 'Action items from a meeting or call were added to tasks' },
	{ type: 'transcript.ready', name: 'Transcript Ready', description: 'A meeting transcript is ready' },
	{ type: 'recording.ready', name: 'Recording Ready', description: 'The recording is stored and can be fetched' },
	{ type: 'meeting.scheduled', name: 'Meeting Scheduled', description: 'A meeting was scheduled for the notetaker' },
	{ type: 'meeting.bot_status_changed', name: 'Notetaker Status Changed', description: 'The notetaker is joining, waiting in the lobby, was not admitted or was removed' },
	{ type: 'meeting.started', name: 'Meeting Started', description: 'Recording started' },
	{ type: 'meeting.ended', name: 'Meeting Ended', description: 'The meeting ended and processing began' },
	{ type: 'meeting.failed', name: 'Meeting Failed', description: 'The meeting ended without a recording' },
	{ type: 'meeting.deleted', name: 'Meeting Deleted', description: 'A meeting was deleted' },
	{ type: 'call.transcript_ready', name: 'Call Transcript Ready', description: 'A phone call transcript is ready' },
	{ type: 'call.summarized', name: 'Call Summarized', description: 'A phone call was summarized' },
	{ type: 'task.created', name: 'Task Created', description: 'A task was created' },
	{ type: 'task.updated', name: 'Task Updated', description: 'A task changed (title, status, due date or items)' },
	{ type: 'task.deleted', name: 'Task Deleted', description: 'A task was deleted' },
	{ type: 'share.created', name: 'Share Link Created', description: 'A public link to a meeting or room was created' },
	{ type: 'share.revoked', name: 'Share Link Revoked', description: 'A public link was turned off' },
	{ type: 'room.created', name: 'Room Created', description: 'A room was created' },
	{ type: 'room.updated', name: 'Room Updated', description: 'A room was renamed or its settings changed' },
	{ type: 'room.archived', name: 'Room Archived', description: 'A room was archived' },
	{ type: 'room.meeting_added', name: 'Room Meeting Added', description: 'A meeting was added to a room' },
	{ type: 'room.meeting_removed', name: 'Room Meeting Removed', description: 'A meeting was removed from a room' },
	{ type: 'upload.failed', name: 'Upload Failed', description: 'An uploaded recording could not be processed' },
];

export const EVENT_TYPES: readonly string[] = EVENTS.map((event) => event.type);

export const EVENT_OPTIONS: INodePropertyOptions[] = [...EVENTS]
	.sort((a, b) => a.name.localeCompare(b.name))
	.map((event) => ({ name: event.name, value: event.type, description: event.description }));

/** Meeting sources accepted by the webhook `filters.sources` field. */
export const SOURCE_OPTIONS: INodePropertyOptions[] = [
	{ name: 'Desktop App', value: 'desktop' },
	{ name: 'Email', value: 'email' },
	{ name: 'Google Meet', value: 'google_meet' },
	{ name: 'Microsoft Teams', value: 'teams' },
	{ name: 'Phone Call', value: 'phone' },
	{ name: 'Upload', value: 'upload' },
	{ name: 'Zoom', value: 'zoom' },
];

const SUMMARY_EVENTS = new Set(['summary.ready', 'summary.updated', 'call.summarized']);
const MEETING_EVENTS = new Set([
	'meeting.scheduled',
	'meeting.bot_status_changed',
	'meeting.started',
	'meeting.ended',
	'meeting.failed',
	'recording.ready',
]);
const TRANSCRIPT_EVENTS = new Set(['transcript.ready', 'call.transcript_ready']);
const TASK_EVENTS = new Set(['task.created', 'task.updated']);

export const TRANSCRIPT_TEXT_MAX_CHARS = 200_000;

export interface HydrateOptions {
	/** Summary events: also fetch the meeting (second request). */
	includeMeeting: boolean;
	/** Transcript events: also fetch the transcript as plain text (second request). */
	includeTranscriptText: boolean;
}

export function dataOf(envelope: IDataObject): IDataObject {
	return (isObject(envelope.data) ? envelope.data : {}) as IDataObject;
}

/** The thin event, as every trigger item starts. */
export function eventBase(envelope: IDataObject, verified: boolean): IDataObject {
	return {
		id: str(envelope.id),
		type: str(envelope.type),
		api_version: str(envelope.api_version) ?? WEBHOOK_API_VERSION,
		created_at: str(envelope.created_at),
		workspace_id: str(envelope.workspace_id),
		signature_verified: verified,
		resource_deleted: false,
		data: dataOf(envelope),
	};
}

async function getOptional(
	this: MesakemContext,
	scope: string,
	path: string,
	qs?: Record<string, unknown>,
	text = false,
	allow: number[] = [],
): Promise<{ status: number; body: unknown }> {
	const response = await mesakemRequest.call(this, {
		method: 'GET',
		path,
		qs,
		accept: text ? 'text' : 'json',
		allowStatuses: [404, ...allow],
		operation: { label: 'Fetch event details', scope },
	});
	return { status: response.statusCode, body: response.statusCode >= 400 ? null : response.body };
}

function texts(items: unknown): string[] {
	return Array.isArray(items)
		? items
				.map((item) => (isObject(item) && typeof item.text === 'string' ? item.text.trim() : ''))
				.filter(Boolean)
		: [];
}

/** Turns one verified delivery into one or more trigger items (at most two API requests). */
export async function hydrateEvent(
	this: MesakemContext,
	envelope: IDataObject,
	verified: boolean,
	options: HydrateOptions,
): Promise<IDataObject[]> {
	const type = str(envelope.type) ?? '';
	const data = dataOf(envelope);
	const out = eventBase(envelope, verified);
	const meetingSegment = idSegment(data.meeting_id);
	if (data.meeting_id !== undefined) out.meeting_id = str(data.meeting_id);

	if (SUMMARY_EVENTS.has(type)) {
		if (type === 'call.summarized') out.call_id = str(data.call_id);
		out.summary_id = str(data.summary_id);
		if (!meetingSegment) return [out];
		const summary = await getOptional.call(this, 'summaries:read', `/meetings/${meetingSegment}/summary`, { format: 'json' });
		if (summary.status === 404) return [{ ...out, resource_deleted: true }];
		const summaryBody = isObject(summary.body) ? (summary.body as IDataObject) : null;
		out.summary = summaryBody;
		out.action_items_text = summaryBody ? texts(summaryBody.action_items).join('\n') : '';
		out.decisions_text = summaryBody ? texts(summaryBody.decisions).join('\n') : '';
		if (options.includeMeeting) {
			const meeting = await getOptional.call(this, 'meetings:read', `/meetings/${meetingSegment}`);
			out.meeting = isObject(meeting.body) ? meeting.body : null;
			if (meeting.status === 404) out.resource_deleted = true;
		}
		return [out];
	}

	if (MEETING_EVENTS.has(type)) {
		if (!meetingSegment) return [out];
		const meeting = await getOptional.call(this, 'meetings:read', `/meetings/${meetingSegment}`);
		out.meeting = isObject(meeting.body) ? meeting.body : null;
		out.resource_deleted = meeting.status === 404;
		return [out];
	}

	if (TRANSCRIPT_EVENTS.has(type)) {
		out.transcript_id = str(data.transcript_id);
		if (type === 'call.transcript_ready') out.call_id = str(data.call_id);
		if (!meetingSegment) return [out];
		const meeting = await getOptional.call(this, 'meetings:read', `/meetings/${meetingSegment}`);
		if (meeting.status === 404) return [{ ...out, resource_deleted: true }];
		out.meeting = isObject(meeting.body) ? meeting.body : null;
		if (options.includeTranscriptText) {
			const transcript = await getOptional.call(
				this,
				'transcripts:read',
				`/meetings/${meetingSegment}/transcript`,
				{ format: 'text' },
				true,
				[400, 413],
			);
			let text = typeof transcript.body === 'string' ? transcript.body : null;
			const truncated = text !== null && text.length > TRANSCRIPT_TEXT_MAX_CHARS;
			if (text !== null && truncated) text = text.slice(0, TRANSCRIPT_TEXT_MAX_CHARS);
			out.transcript_text = text;
			out.transcript_text_status =
				transcript.status === 413 ? 'too_long' : text === null ? 'unavailable' : 'included';
			out.transcript_text_truncated = truncated;
		}
		return [out];
	}

	if (TASK_EVENTS.has(type)) {
		const taskSegment = idSegment(data.task_id);
		out.task_id = str(data.task_id);
		if (!taskSegment) return [out];
		const task = await getOptional.call(this, 'tasks:read', `/tasks/${taskSegment}`);
		out.task = isObject(task.body) ? task.body : null;
		out.resource_deleted = task.status === 404;
		return [out];
	}

	if (type === 'action_items.created') {
		out.summary_id = str(data.summary_id);
		const taskIds = Array.isArray(data.task_ids)
			? data.task_ids.filter((id): id is string => typeof id === 'string')
			: [];
		if (!meetingSegment || taskIds.length === 0) return [out];
		// One request for every new task: the meeting's most recent tasks, then keep the new ones.
		const count = Math.min(100, Math.max(taskIds.length, Number(data.count) || 0));
		const page = await getOptional.call(this, 'tasks:read', '/tasks', {
			meeting_id: data.meeting_id,
			status: 'all',
			order: 'recent',
			limit: count,
		});
		const rows =
			isObject(page.body) && Array.isArray(page.body.data)
				? (page.body.data.filter(isObject) as IDataObject[])
				: [];
		const byId = new Map(rows.map((row) => [String(row.id), row]));
		const meeting = await getOptional.call(this, 'meetings:read', `/meetings/${meetingSegment}`);
		const meetingBody = isObject(meeting.body) ? meeting.body : null;
		return taskIds.map((taskId) => {
			const task = byId.get(taskId) ?? null;
			return {
				...out,
				task_id: taskId,
				task,
				task_found: task !== null,
				meeting: meetingBody,
				resource_deleted: meeting.status === 404,
			};
		});
	}

	if (type === 'task.deleted') out.task_id = str(data.task_id);
	if (type === 'meeting.deleted') out.resource_deleted = true;
	return [out];
}
