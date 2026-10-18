'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { NodeApiError } = require('n8n-workflow');
const { dist, hookContext, webhookContext, sign, envelope, SECRET, BASE, openapi, openapiHasOperation } = require('./helpers');

const { MesakemTrigger } = dist('nodes/MesakemTrigger/MesakemTrigger.node.js');
const { EVENT_TYPES } = dist('nodes/shared/events.js');

const trigger = new MesakemTrigger();
const hooks = trigger.webhookMethods.default;
const URL_PROD = 'https://n8n.example.com/webhook/abc/webhook';
const errorBody = (code, details = []) => ({ error: { code, message: 'x', details, request_id: 'apireq_3' } });

const endpointResponse = (events, extra = {}) => ({
	statusCode: 201,
	body: { object: 'webhook_endpoint', id: 'whk_1', url: URL_PROD, events, enabled: true, status: 'healthy', secret: SECRET, ...extra },
});

/** A signed delivery to a trigger that was activated (secret stored for its URL). */
function delivery(event, { params = {}, routes = {}, mode = 'webhook', headers, secret = SECRET, rawBody = true } = {}) {
	const body = JSON.stringify(event);
	const staticData = { endpoints: { [URL_PROD]: { id: 'whk_1', secret, events: [event.type] } } };
	return webhookContext({
		params: { registration: 'automatic', events: [event.type], options: {}, ...params },
		routes,
		staticData,
		body,
		headers: headers || sign(body),
		mode,
		rawBody,
	});
}

test('trigger description: instant webhook only, empty inputs, all 24 events', () => {
	const description = trigger.description;
	assert.equal(description.name, 'mesakemTrigger');
	assert.deepEqual(description.inputs, []);
	assert.equal(description.polling, undefined);
	assert.equal(trigger.poll, undefined);
	assert.deepEqual(description.webhooks, [{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' }]);
	const events = description.properties.find((p) => p.name === 'events').options.map((o) => o.value);
	assert.equal(events.length, 24);
	assert.deepEqual([...events].sort(), [...EVENT_TYPES].sort());
	assert.ok(!events.includes('webhook.test'));
	// Canonical names only: no alias event names.
	assert.ok(events.every((name) => !/initial_summary_ready|meeting\.transcript_ready/.test(name)));
});

test('activate: creates one standard-signed endpoint and stores its id + secret for this URL', async () => {
	const { context, calls, staticData } = hookContext({
		params: { registration: 'automatic', events: ['task.created', 'summary.ready'], sources: ['zoom'] },
		routes: { 'POST /webhooks': endpointResponse(['summary.ready', 'task.created']) },
	});
	assert.equal(await hooks.create.call(context), true);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, `${BASE}/webhooks`);
	assert.deepEqual(calls[0].body, {
		url: URL_PROD,
		events: ['summary.ready', 'task.created'],
		description: 'n8n: Summaries to Slack',
		signature_format: 'standard',
		filters: { sources: ['zoom'] },
	});
	assert.deepEqual(staticData.endpoints[URL_PROD], { id: 'whk_1', secret: SECRET, events: ['summary.ready', 'task.created'] });
});

test('activate again after a settings change: the old endpoint is deleted first (no leaks)', async () => {
	const staticData = { endpoints: { [URL_PROD]: { id: 'whk_old', secret: SECRET, events: ['task.created'] } } };
	const { context, calls } = hookContext({
		params: { registration: 'automatic', events: ['summary.ready'], sources: [] },
		staticData,
		routes: { 'DELETE /webhooks/whk_old': { body: { deleted: true } }, 'POST /webhooks': endpointResponse(['summary.ready'], { id: 'whk_new' }) },
	});
	await hooks.create.call(context);
	assert.deepEqual(calls.map((call) => call.key), ['DELETE /webhooks/whk_old', 'POST /webhooks']);
	assert.equal(staticData.endpoints[URL_PROD].id, 'whk_new');
	assert.equal(calls[1].body.filters, undefined);
});

test('activate with a read-only (Free / trial) key: clear message pointing to Manual registration', async () => {
	const { context } = hookContext({
		params: { registration: 'automatic', events: ['summary.ready'], sources: [] },
		routes: { 'POST /webhooks': { statusCode: 403, body: errorBody('insufficient_scope') } },
	});
	await assert.rejects(hooks.create.call(context), (error) => {
		assert.ok(error instanceof NodeApiError);
		assert.match(error.message, /Manage webhooks/);
		assert.match(error.description, /Manual/);
		return true;
	});
});

test('activate when the plan limit is reached, or the n8n address is not public', async () => {
	const limit = hookContext({
		params: { registration: 'automatic', events: ['summary.ready'], sources: [] },
		routes: { 'POST /webhooks': { statusCode: 403, body: errorBody('plan_required', [{ field: 'endpoints', message: 'This plan allows 10 endpoint(s).' }]) } },
	});
	await assert.rejects(hooks.create.call(limit.context), /limit of webhook endpoints/);
	const local = hookContext({
		url: 'http://localhost:5678/webhook-test/abc/webhook',
		params: { registration: 'automatic', events: ['summary.ready'], sources: [] },
		routes: { 'POST /webhooks': { statusCode: 400, body: errorBody('bad_request', [{ field: 'url', message: 'invalid_url: https only' }]) } },
	});
	await assert.rejects(hooks.create.call(local.context), (error) => /webhook address/.test(error.message) && /public https/.test(error.description));
});

test('checkExists: true only for the same URL, events and an enabled endpoint', async () => {
	const stored = () => ({ endpoints: { [URL_PROD]: { id: 'whk_1', secret: SECRET, events: ['summary.ready'] } } });
	const params = { registration: 'automatic', events: ['summary.ready'] };
	const ok = hookContext({ params, staticData: stored(), routes: { 'GET /webhooks/whk_1': { body: { id: 'whk_1', url: URL_PROD, events: ['summary.ready'], enabled: true, status: 'healthy' } } } });
	assert.equal(await hooks.checkExists.call(ok.context), true);
	assert.equal(ok.calls.length, 1);

	const changed = hookContext({ params: { ...params, events: ['task.created'] }, staticData: stored(), routes: { 'GET /webhooks/whk_1': { body: { id: 'whk_1', url: URL_PROD, events: ['summary.ready'], enabled: true } } } });
	assert.equal(await hooks.checkExists.call(changed.context), false);

	const disabled = hookContext({ params, staticData: stored(), routes: { 'GET /webhooks/whk_1': { body: { id: 'whk_1', url: URL_PROD, events: ['summary.ready'], enabled: false, status: 'disabled' } } } });
	assert.equal(await hooks.checkExists.call(disabled.context), false);

	const gone = hookContext({ params, staticData: stored(), routes: {} });
	assert.equal(await hooks.checkExists.call(gone.context), false);

	const nothing = hookContext({ params, staticData: {} });
	assert.equal(await hooks.checkExists.call(nothing.context), false);
	assert.equal(nothing.calls.length, 0);
});

test('deactivate: deletes the endpoint (404 = already gone) and forgets it', async () => {
	const staticData = { endpoints: { [URL_PROD]: { id: 'whk_1', secret: SECRET, events: ['summary.ready'] }, 'https://n8n.example.com/webhook-test/abc/webhook': { id: 'whk_t', secret: SECRET, events: [] } } };
	const { context, calls } = hookContext({ params: { registration: 'automatic' }, staticData, routes: { 'DELETE /webhooks/whk_1': { body: { deleted: true } } } });
	assert.equal(await hooks.delete.call(context), true);
	assert.deepEqual(calls.map((call) => call.key), ['DELETE /webhooks/whk_1']);
	assert.equal(staticData.endpoints[URL_PROD], undefined);
	// The test-URL endpoint of the same node is untouched.
	assert.ok(staticData.endpoints['https://n8n.example.com/webhook-test/abc/webhook']);

	const again = hookContext({ params: { registration: 'automatic' }, staticData: { endpoints: { [URL_PROD]: { id: 'whk_1', secret: SECRET, events: [] } } }, routes: {} });
	assert.equal(await hooks.delete.call(again.context), true);
});

test('manual registration: no API calls on activate / deactivate', async () => {
	const { context, calls } = hookContext({ params: { registration: 'manual', events: ['summary.ready'] } });
	assert.equal(await hooks.checkExists.call(context), true);
	assert.equal(await hooks.create.call(context), true);
	assert.equal(await hooks.delete.call(context), true);
	assert.equal(calls.length, 0);
});

test('delivery with a valid signature: summary + meeting fetched by id (2 requests), never via links.api', async () => {
	const event = envelope('summary.ready', {
		object: 'summary',
		meeting_id: 'run_1',
		summary_id: 'sum_1',
		counts: { action_items: 1, decisions: 1 },
		links: { api: 'https://evil.example/steal', app: 'https://mesakem.com/dashboard/meeting/run_1' },
	});
	const { context, calls } = delivery(event, {
		routes: {
			'GET /meetings/run_1/summary': { body: { object: 'summary', id: 'sum_1', action_items: [{ text: 'Send deck' }], decisions: [{ text: 'Go' }] } },
			'GET /meetings/run_1': { body: { object: 'meeting', id: 'run_1', title: 'Weekly sync' } },
		},
	});
	const result = await trigger.webhook.call(context);
	assert.equal(calls.length, 2);
	assert.ok(calls.every((call) => call.url.startsWith(`${BASE}/`)));
	assert.equal(calls[0].qs.format, 'json');
	const [items] = result.workflowData;
	assert.equal(items.length, 1);
	const json = items[0].json;
	assert.equal(json.type, 'summary.ready');
	assert.equal(json.signature_verified, true);
	assert.equal(json.meeting.title, 'Weekly sync');
	assert.equal(json.summary.id, 'sum_1');
	assert.equal(json.action_items_text, 'Send deck');
	assert.equal(json.decisions_text, 'Go');
	assert.equal(json.resource_deleted, false);
});

test('forged or tampered deliveries are dropped with 401 and cost no API requests', async () => {
	const event = envelope('task.created', { object: 'task', task_id: 'task_1' });
	const wrongSecret = 'whsec_' + Buffer.from('ffffffffffffffffffffffffffffffff').toString('base64');
	const forged = delivery(event, { headers: sign(JSON.stringify(event), { secret: wrongSecret }) });
	const result = await trigger.webhook.call(forged.context);
	assert.deepEqual(result, { noWebhookResponse: true });
	assert.equal(forged.response.statusCode, 401);
	assert.equal(forged.calls.length, 0);
	assert.equal(forged.warnings.length, 1);

	const unsigned = delivery(event, { headers: {} });
	assert.deepEqual(await trigger.webhook.call(unsigned.context), { noWebhookResponse: true });
	assert.equal(unsigned.response.statusCode, 401);

	const stale = delivery(event, { headers: sign(JSON.stringify(event), { timestamp: Math.floor(Date.now() / 1000) - 3600 }) });
	assert.deepEqual(await trigger.webhook.call(stale.context), { noWebhookResponse: true });
});

test('no stored secret: 401 with a hint to re-activate', async () => {
	const event = envelope('task.created', { object: 'task', task_id: 'task_1' });
	const body = JSON.stringify(event);
	const { context, response, warnings } = webhookContext({ params: { registration: 'automatic', events: ['task.created'], options: {} }, staticData: {}, body, headers: sign(body) });
	await trigger.webhook.call(context);
	assert.equal(response.statusCode, 401);
	assert.match(warnings[0], /Deactivate and activate/);
});

test('signature is checked on the raw bytes; without rawBody the compact JSON is used', async () => {
	const event = envelope('task.created', { object: 'task', task_id: 'task_1', status: 'open' });
	const { context, calls } = delivery(event, { rawBody: false, routes: { 'GET /tasks/task_1': { body: { id: 'task_1', title: 'Deck' } } } });
	const result = await trigger.webhook.call(context);
	assert.equal(result.workflowData[0][0].json.task.title, 'Deck');
	assert.equal(calls.length, 1);
});

test('manual registration verifies with the pasted secret', async () => {
	const event = envelope('meeting.ended', { object: 'meeting', meeting_id: 'run_1', end_time: '2026-10-18T09:00:00Z' });
	const body = JSON.stringify(event);
	const ok = webhookContext({
		params: { registration: 'manual', signingSecret: SECRET, events: ['meeting.ended'], options: {} },
		body,
		headers: sign(body),
		routes: { 'GET /meetings/run_1': { body: { id: 'run_1', status: 'processing' } } },
	});
	const result = await trigger.webhook.call(ok.context);
	assert.equal(result.workflowData[0][0].json.meeting.status, 'processing');
	const bad = webhookContext({ params: { registration: 'manual', signingSecret: 'whsec_' + Buffer.from('x'.repeat(32)).toString('base64'), events: ['meeting.ended'], options: {} }, body, headers: sign(body) });
	await trigger.webhook.call(bad.context);
	assert.equal(bad.response.statusCode, 401);
});

test('Settings "Send test": shown while listening in the editor, ignored by an active workflow', async () => {
	const event = envelope('webhook.test', { object: 'webhook', endpoint_id: 'whk_1' });
	const listening = delivery(event, { mode: 'manual', params: { events: ['summary.ready'] } });
	const shown = await trigger.webhook.call(listening.context);
	assert.equal(shown.workflowData[0][0].json.type, 'webhook.test');
	assert.equal(listening.calls.length, 0);
	const active = delivery(event, { params: { events: ['summary.ready'] } });
	assert.deepEqual(await trigger.webhook.call(active.context), { webhookResponse: { received: true, ignored: 'webhook.test' } });
});

test('events not selected are acknowledged and ignored', async () => {
	const event = envelope('task.deleted', { object: 'task', task_id: 'task_1' });
	const { context, calls } = delivery(event, { params: { events: ['summary.ready'] } });
	assert.deepEqual(await trigger.webhook.call(context), { webhookResponse: { received: true, ignored: 'task.deleted' } });
	assert.equal(calls.length, 0);
});

test('Fetch Details off: only the short event, zero requests', async () => {
	const event = envelope('summary.ready', { object: 'summary', meeting_id: 'run_1', summary_id: 'sum_1' });
	const { context, calls } = delivery(event, { params: { options: { fetchDetails: false } } });
	const result = await trigger.webhook.call(context);
	assert.equal(calls.length, 0);
	assert.equal(result.workflowData[0][0].json.data.summary_id, 'sum_1');
});

test('deleted before fetching: thin event with resource_deleted', async () => {
	const event = envelope('summary.ready', { object: 'summary', meeting_id: 'run_gone', summary_id: 'sum_1' });
	const { context, calls } = delivery(event, { routes: {} });
	const json = (await trigger.webhook.call(context)).workflowData[0][0].json;
	assert.equal(json.resource_deleted, true);
	assert.equal(calls.length, 1);
});

test('action items: one item per new task, from ONE task list request plus the meeting', async () => {
	const event = envelope('action_items.created', { object: 'action_items', meeting_id: 'run_1', summary_id: 'sum_1', task_ids: ['task_1', 'task_2'], count: 2 });
	const { context, calls } = delivery(event, {
		routes: {
			'GET /tasks': { body: { data: [{ id: 'task_2', title: 'B' }, { id: 'task_1', title: 'A' }, { id: 'task_0', title: 'old' }] } },
			'GET /meetings/run_1': { body: { id: 'run_1', title: 'Weekly sync' } },
		},
	});
	const [items] = (await trigger.webhook.call(context)).workflowData;
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[0].qs, { meeting_id: 'run_1', status: 'all', order: 'recent', limit: '2' });
	assert.deepEqual(items.map((item) => item.json.task.title), ['A', 'B']);
	assert.ok(items.every((item) => item.json.meeting.title === 'Weekly sync' && item.json.task_found === true));
});

test('transcript events: meeting + optional plain text (cut at 200,000 characters)', async () => {
	const event = envelope('transcript.ready', { object: 'transcript', meeting_id: 'run_1', transcript_id: 'tr_1', language: 'he' });
	const { context, calls } = delivery(event, {
		params: { options: { includeTranscriptText: true } },
		routes: { 'GET /meetings/run_1': { body: { id: 'run_1' } }, 'GET /meetings/run_1/transcript': { body: 'x'.repeat(200_010) } },
	});
	const json = (await trigger.webhook.call(context)).workflowData[0][0].json;
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[1].qs, { format: 'text' });
	assert.equal(json.transcript_text.length, 200_000);
	assert.equal(json.transcript_text_truncated, true);
	assert.equal(json.transcript_text_status, 'included');
});

test('every event type costs at most two API requests, and only documented paths', async () => {
	const doc = openapi();
	const data = { meeting_id: 'run_1', summary_id: 'sum_1', task_id: 'task_1', task_ids: ['task_1', 'task_2', 'task_3'], count: 3, call_id: 'run_1', transcript_id: 'tr_1', room_id: 'room_1', share_id: 'shr_1', upload_id: 'upl_1' };
	for (const type of EVENT_TYPES) {
		const event = envelope(type, { object: 'x', ...data });
		const { context, calls } = delivery(event, {
			params: { options: { includeTranscriptText: true, includeMeeting: true } },
			routes: new Proxy({}, { get: (_, key) => (typeof key === 'string' && key.startsWith('GET ') ? { body: key.endsWith('/transcript') ? 'text' : { id: 'x', data: [] } } : undefined) }),
		});
		const result = await trigger.webhook.call(context);
		assert.ok(result.workflowData[0].length >= 1, type);
		assert.ok(calls.length <= 2, `${type} made ${calls.length} requests`);
		assert.ok(calls.every((call) => call.options.method === 'GET'), type);
		if (doc) for (const call of calls) assert.ok(openapiHasOperation(doc, 'GET', new URL(call.url).pathname.replace('/api/v1', '')), call.url);
	}
});

test('webhook management paths exist in docs/api/openapi.v1.json and signature_format "standard" is accepted', (t) => {
	const doc = openapi();
	if (!doc) return t.skip('OpenAPI document not found');
	assert.ok(openapiHasOperation(doc, 'POST', '/webhooks'));
	assert.ok(openapiHasOperation(doc, 'GET', '/webhooks/whk_1'));
	assert.ok(openapiHasOperation(doc, 'DELETE', '/webhooks/whk_1'));
	const create = doc.components.schemas.WebhookCreate;
	assert.ok(create.properties.signature_format.enum.includes('standard'));
	const subscribable = create.properties.events.items.enum;
	for (const type of EVENT_TYPES) assert.ok(subscribable.includes(type), type);
});
