'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { NodeApiError } = require('n8n-workflow');
const { dist, executeContext, BASE, openapi, openapiHasOperation } = require('./helpers');

const { Mesakem, OPERATIONS } = dist('nodes/Mesakem/Mesakem.node.js');

const node = new Mesakem();
const id = (value) => ({ __rl: true, mode: 'id', value });
const errorBody = (code, details = []) => ({ error: { code, message: 'Server message.', details, request_id: 'apireq_2' } });

async function run(params, routes = {}, options = {}) {
	const { context, calls } = executeContext({ params, routes, ...options });
	const [items] = await node.execute.call(context);
	return { items, calls };
}

test('node description: resources, credentials, usable as a tool, no polling', () => {
	const description = node.description;
	assert.equal(description.name, 'mesakem');
	assert.deepEqual(description.credentials, [{ name: 'mesakemApi', required: true }]);
	assert.equal(description.usableAsTool, true);
	assert.equal(description.polling, undefined);
	const resources = description.properties.find((p) => p.name === 'resource').options.map((o) => o.value).sort();
	assert.deepEqual(resources, ['bot', 'document', 'me', 'meeting', 'task']);
	const ops = (resource) =>
		description.properties
			.filter((p) => p.name === 'operation' && p.displayOptions.show.resource.includes(resource))
			.flatMap((p) => p.options.map((o) => o.value))
			.sort();
	assert.deepEqual(ops('meeting'), ['get', 'getAll', 'summary', 'transcript', 'upcoming']);
	assert.deepEqual(ops('task'), ['create', 'delete', 'get', 'getAll', 'update']);
	assert.deepEqual(ops('bot'), ['cancel', 'schedule', 'send']);
	assert.deepEqual(ops('document'), ['get']);
	assert.deepEqual(ops('me'), ['get']);
	// Every operation in the UI has a label + scope for clear errors.
	for (const resource of resources) for (const op of ops(resource)) assert.ok(OPERATIONS[`${resource}.${op}`], `${resource}.${op}`);
});

test('account: GET /me', async () => {
	const { items, calls } = await run({ resource: 'me', operation: 'get' }, { 'GET /me': { body: { object: 'api_key_context', user: { email: 'a@b.co' } } } });
	assert.equal(calls[0].url, `${BASE}/me`);
	assert.equal(items[0].json.user.email, 'a@b.co');
	assert.deepEqual(items[0].pairedItem, { item: 0 });
});

test('meeting get: id from the resource locator, expand as a comma list', async () => {
	const { items, calls } = await run(
		{ resource: 'meeting', operation: 'get', meetingId: id('run_1'), expand: ['participants', 'documents'] },
		{ 'GET /meetings/run_1': { body: { id: 'run_1', object: 'meeting' } } },
	);
	assert.equal(calls[0].url, `${BASE}/meetings/run_1`);
	assert.equal(calls[0].qs.expand, 'participants,documents');
	assert.equal(items[0].json.id, 'run_1');
});

test('meeting get: an invalid id never reaches the API', async () => {
	const { context, calls } = executeContext({ params: { resource: 'meeting', operation: 'get', meetingId: id('../tasks'), expand: [] } });
	await assert.rejects(node.execute.call(context), /Choose a meeting/);
	assert.equal(calls.length, 0);
});

test('meeting getAll: filters, dates in the workflow time zone, one item per meeting', async () => {
	const { items, calls } = await run(
		{
			resource: 'meeting',
			operation: 'getAll',
			returnAll: false,
			limit: 2,
			filters: { status: 'completed', from: '2026-10-01T00:00:00', order: 'recent', expand: ['participants'] },
		},
		{ 'GET /meetings': { body: { data: [{ id: 'run_1' }, { id: 'run_2' }], has_more: true, next_cursor: 'x' } } },
	);
	assert.equal(items.length, 2);
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].qs, { status: 'completed', order: 'recent', expand: 'participants', from: '2026-09-30T21:00:00Z', limit: '2' });
});

test('meeting summary: JSON object, or text formats as content', async () => {
	const json = await run(
		{ resource: 'meeting', operation: 'summary', meetingId: id('run_1'), summaryFormat: 'json' },
		{ 'GET /meetings/run_1/summary': { body: { object: 'summary', id: 'sum_1' } } },
	);
	assert.equal(json.calls[0].qs.format, 'json');
	assert.equal(json.items[0].json.id, 'sum_1');

	const md = await run(
		{ resource: 'meeting', operation: 'summary', meetingId: id('run_1'), summaryFormat: 'markdown' },
		{ 'GET /meetings/run_1/summary': { body: '# Weekly sync\n- Ship it' } },
	);
	assert.equal(md.calls[0].qs.format, 'markdown');
	assert.equal(md.calls[0].options.encoding, 'text');
	assert.deepEqual(md.items[0].json, { meeting_id: 'run_1', format: 'markdown', content: '# Weekly sync\n- Ship it' });
});

test('meeting transcript: text in one request; JSON follows segment pages', async () => {
	const text = await run(
		{ resource: 'meeting', operation: 'transcript', meetingId: id('run_1'), transcriptFormat: 'text' },
		{ 'GET /meetings/run_1/transcript': { body: 'Dana: hi' } },
	);
	assert.equal(text.calls.length, 1);
	assert.deepEqual(text.calls[0].qs, { format: 'text' });
	assert.equal(text.items[0].json.text, 'Dana: hi');

	const pages = [
		{ body: { object: 'transcript', meeting_id: 'run_1', segments: [{ i: 1 }], has_more: true, next_cursor: 'p2' } },
		{ body: { object: 'transcript', meeting_id: 'run_1', segments: [{ i: 2 }], has_more: false, next_cursor: null } },
	];
	const json = await run(
		{ resource: 'meeting', operation: 'transcript', meetingId: id('run_1'), transcriptFormat: 'json', returnAllSegments: true },
		{ 'GET /meetings/run_1/transcript': pages },
	);
	assert.equal(json.calls.length, 2);
	assert.equal(json.calls[1].qs.cursor, 'p2');
	assert.deepEqual(json.items[0].json.segments, [{ i: 1 }, { i: 2 }]);
	assert.equal(json.items[0].json.has_more, false);
});

test('meeting upcoming: within_hours filter', async () => {
	const { items, calls } = await run(
		{ resource: 'meeting', operation: 'upcoming', returnAll: false, limit: 10, upcomingFilters: { within_hours: 48 } },
		{ 'GET /meetings/upcoming': { body: { data: [{ id: 'cal_evt_1', object: 'upcoming_meeting' }], has_more: false } } },
	);
	assert.equal(calls[0].qs.within_hours, '48');
	assert.equal(items[0].json.id, 'cal_evt_1');
});

test('document get: format query', async () => {
	const { calls } = await run(
		{ resource: 'document', operation: 'get', documentId: 'doc_sum_1', documentFormat: 'markdown' },
		{ 'GET /documents/doc_sum_1': { body: { object: 'document', content: '# x' } } },
	);
	assert.equal(calls[0].qs.format, 'markdown');
});

test('task getAll and get', async () => {
	const list = await run(
		{ resource: 'task', operation: 'getAll', returnAll: true, taskFilters: { status: 'all', source: 'meeting_summary', meeting_id: 'run_1' } },
		{ 'GET /tasks': { body: { data: [{ id: 'task_1' }], has_more: false } } },
	);
	assert.deepEqual(list.calls[0].qs, { status: 'all', source: 'meeting_summary', meeting_id: 'run_1', limit: '100' });
	const one = await run(
		{ resource: 'task', operation: 'get', taskId: id('task_1'), taskOptions: { items_limit: 20 } },
		{ 'GET /tasks/task_1': { body: { id: 'task_1', object: 'task' } } },
	);
	assert.equal(one.calls[0].qs.items_limit, '20');
});

test('task create: JSON body with assignee and checklist, plus an Idempotency-Key', async () => {
	const { items, calls } = await run(
		{
			resource: 'task',
			operation: 'create',
			title: '  Send the deck  ',
			additionalFields: { description: 'v2', dueAt: '2026-10-20T12:00:00', assigneeEmail: 'dana@acme.co.il', items: 'Slides\n\n Numbers ' },
		},
		{ 'POST /tasks': { statusCode: 201, body: { id: 'task_9', object: 'task' } } },
	);
	assert.equal(items[0].json.id, 'task_9');
	assert.equal(calls[0].headers['Content-Type'], 'application/json');
	assert.match(calls[0].headers['Idempotency-Key'], /^n8n-[0-9a-f]{48}$/);
	assert.deepEqual(calls[0].body, {
		title: 'Send the deck',
		description: 'v2',
		due_at: '2026-10-20T09:00:00Z',
		assignee: { email: 'dana@acme.co.il' },
		items: ['Slides', 'Numbers'],
	});
});

test('task create on a Free / trial key: a clear read-only plan error', async () => {
	const { context } = executeContext({
		params: { resource: 'task', operation: 'create', title: 'x', additionalFields: {} },
		routes: { 'POST /tasks': { statusCode: 403, body: errorBody('plan_required') } },
	});
	await assert.rejects(node.execute.call(context), (error) => {
		assert.ok(error instanceof NodeApiError);
		assert.match(error.message, /plan cannot run "Create a task"/);
		assert.match(error.description, /read-only API access/);
		return true;
	});
});

test('task update needs a field; update and delete call PATCH / DELETE', async () => {
	const { context, calls } = executeContext({ params: { resource: 'task', operation: 'update', taskId: id('task_1'), updateFields: {} } });
	await assert.rejects(node.execute.call(context), /at least one field/);
	assert.equal(calls.length, 0);

	const update = await run(
		{ resource: 'task', operation: 'update', taskId: id('task_1'), updateFields: { status: 'done' } },
		{ 'PATCH /tasks/task_1': { body: { id: 'task_1', status: 'done' } } },
	);
	assert.deepEqual(update.calls[0].body, { status: 'done' });
	const removed = await run({ resource: 'task', operation: 'delete', taskId: id('task_1') }, { 'DELETE /tasks/task_1': { body: { id: 'task_1', status: 'cancelled' } } });
	assert.equal(removed.calls[0].options.method, 'DELETE');
});

test('missing scope on a write names the permission', async () => {
	const { context } = executeContext({
		params: { resource: 'task', operation: 'update', taskId: id('task_1'), updateFields: { title: 'x' } },
		routes: { 'PATCH /tasks/task_1': { statusCode: 403, body: errorBody('insufficient_scope') } },
	});
	await assert.rejects(node.execute.call(context), /missing the "tasks:write" permission/);
});

test('notetaker send / schedule / cancel', async () => {
	const send = await run(
		{ resource: 'bot', operation: 'send', meetingUrl: 'https://meet.google.com/abc-defg-hij', botFields: { summary_language: 'en', start_time: '2026-10-20T10:00:00Z' } },
		{ 'POST /meetings/bot': { statusCode: 202, body: { object: 'bot_dispatch', meeting_id: 'run_5', status: 'scheduling' } } },
	);
	assert.deepEqual(send.calls[0].body, { meeting_url: 'https://meet.google.com/abc-defg-hij', summary_language: 'en', start_time: '2026-10-20T10:00:00Z' });
	assert.ok(send.calls[0].headers['Idempotency-Key']);
	assert.equal(send.items[0].json.meeting_id, 'run_5');

	const schedule = await run(
		{ resource: 'bot', operation: 'schedule', eventId: id('cal_evt_7'), applyToSeries: true },
		{ 'POST /meetings/cal_evt_7/bot': { statusCode: 202, body: { object: 'bot_schedule' } } },
	);
	assert.deepEqual(schedule.calls[0].body, { apply_to_series: true });

	const skip = await run(
		{ resource: 'bot', operation: 'cancel', cancelTarget: id('cal_evt_7'), applyToSeries: true },
		{ 'DELETE /meetings/cal_evt_7/bot': { statusCode: 202, body: { object: 'bot_schedule', status: 'cancelling' } } },
	);
	assert.deepEqual(skip.calls[0].qs, { apply_to_series: 'true' });
	const leave = await run(
		{ resource: 'bot', operation: 'cancel', cancelTarget: id('run_5'), applyToSeries: true },
		{ 'DELETE /meetings/run_5/bot': { statusCode: 202, body: { object: 'bot_leave' } } },
	);
	assert.deepEqual(leave.calls[0].qs, {});
});

test('notetaker already in the meeting: 409 with the meeting id', async () => {
	const { context } = executeContext({
		params: { resource: 'bot', operation: 'send', meetingUrl: 'https://zoom.us/j/1', botFields: {} },
		routes: { 'POST /meetings/bot': { statusCode: 409, body: { error: { code: 'meeting_bot_already_active', message: 'x', details: [], meeting_id: 'run_3' } } } },
	});
	await assert.rejects(node.execute.call(context), (error) => /already in this meeting/.test(error.message) && /run_3/.test(error.description));
});

test('continue on fail: the error becomes an item and other items still run', async () => {
	const { context, calls } = executeContext({
		params: { resource: 'me', operation: 'get' },
		items: [{ json: {} }, { json: {} }],
		routes: { 'GET /me': [{ statusCode: 401, body: errorBody('unauthorized') }, { body: { object: 'api_key_context' } }] },
		continueOnFail: true,
	});
	const [items] = await node.execute.call(context);
	assert.equal(calls.length, 2);
	assert.match(items[0].json.error, /did not accept this API key/);
	assert.deepEqual(items[1].pairedItem, { item: 1 });
});

test('list search: meetings dropdown filters titles and pages with the cursor', async () => {
	const { context, calls } = executeContext({
		routes: { 'GET /meetings': { body: { data: [{ id: 'run_1', title: 'Weekly sync', start_time: '2026-10-15T09:00:00Z', app_url: 'https://mesakem.com/dashboard/meeting/run_1' }, { id: 'run_2', title: 'Board' }], has_more: true, next_cursor: 'c' } } },
	});
	const result = await node.methods.listSearch.searchMeetings.call(context, 'week');
	assert.deepEqual(result.results, [{ name: 'Weekly sync (2026-10-15 09:00)', value: 'run_1', url: 'https://mesakem.com/dashboard/meeting/run_1' }]);
	assert.equal(result.paginationToken, 'c');
	assert.equal(calls[0].qs.limit, '50');
	const tasks = executeContext({ routes: { 'GET /tasks': { body: { data: [{ id: 'task_1', title: 'Deck', status: 'open' }], has_more: false } } } });
	const taskResult = await node.methods.listSearch.searchTasks.call(tasks.context);
	assert.equal(taskResult.results[0].name, 'Deck [open]');
	assert.equal(tasks.calls[0].qs.status, 'active');
	const upcoming = executeContext({ routes: { 'GET /meetings/upcoming': { body: { data: [{ id: 'cal_evt_1', title: 'Demo' }] } } } });
	assert.equal((await node.methods.listSearch.searchUpcomingMeetings.call(upcoming.context)).results[0].value, 'cal_evt_1');
});

test('every request the action node makes exists in docs/api/openapi.v1.json', async (t) => {
	const doc = openapi();
	if (!doc) return t.skip('OpenAPI document not found (package used outside the Mesakem repo)');
	const used = [
		['GET', '/me'], ['GET', '/meetings'], ['GET', '/meetings/upcoming'], ['GET', '/meetings/run_1'], ['GET', '/meetings/run_1/summary'],
		['GET', '/meetings/run_1/transcript'], ['GET', '/documents/doc_1'], ['GET', '/tasks'], ['GET', '/tasks/task_1'], ['POST', '/tasks'],
		['PATCH', '/tasks/task_1'], ['DELETE', '/tasks/task_1'], ['POST', '/meetings/bot'], ['POST', '/meetings/cal_evt_1/bot'],
		['DELETE', '/meetings/cal_evt_1/bot'],
	];
	for (const [method, path] of used) assert.ok(openapiHasOperation(doc, method, path), `${method} ${path}`);
	// Scopes in the error messages match the API's own security requirements.
	const scopeOf = (method, template) => doc.paths[template][method.toLowerCase()].security[0].bearerAuth[0];
	assert.equal(scopeOf('POST', '/tasks'), OPERATIONS['task.create'].scope);
	assert.equal(scopeOf('POST', '/meetings/bot'), OPERATIONS['bot.send'].scope);
	assert.equal(scopeOf('GET', '/meetings/upcoming'), OPERATIONS['meeting.upcoming'].scope);
	assert.equal(scopeOf('GET', '/documents/{document_id}'), OPERATIONS['document.get'].scope);
	assert.equal(scopeOf('GET', '/meetings/{meeting_id}/transcript'), OPERATIONS['meeting.transcript'].scope);
});
