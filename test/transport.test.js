'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { NodeApiError, NodeOperationError } = require('n8n-workflow');
const { dist, executeContext, BASE, CREDENTIALS } = require('./helpers');

const { normalizeBaseUrl, idSegment, cleanQuery, DEFAULT_API_BASE } = dist('nodes/shared/config.js');
const { describeApiError, retryAfterSeconds } = dist('nodes/shared/errors.js');
const { mesakemRequest, mesakemList, idempotencyKey } = dist('nodes/shared/transport.js');
const { toApiDate } = dist('nodes/shared/dates.js');
const { MesakemApi } = dist('credentials/MesakemApi.credentials.js');

const errorBody = (code, details = [], extra = {}) => ({ error: { code, message: 'Server message.', details, request_id: 'apireq_1', ...extra } });

test('credential: API key is a password, base URL defaults to production, test calls GET /me', () => {
	const credential = new MesakemApi();
	assert.equal(credential.name, 'mesakemApi');
	const apiKey = credential.properties.find((p) => p.name === 'apiKey');
	assert.equal(apiKey.typeOptions.password, true);
	assert.equal(apiKey.required, true);
	const baseUrl = credential.properties.find((p) => p.name === 'baseUrl');
	assert.equal(baseUrl.default, DEFAULT_API_BASE);
	assert.equal(credential.authenticate.properties.headers.Authorization, '=Bearer {{$credentials.apiKey}}');
	assert.equal(credential.test.request.url, '/me');
	assert.equal(credential.test.request.baseURL, '={{$credentials.baseUrl}}');
});

test('base URL: https only (http for localhost), no query or credentials, trailing slash removed', () => {
	assert.deepEqual(normalizeBaseUrl(''), { ok: true, base: DEFAULT_API_BASE });
	assert.deepEqual(normalizeBaseUrl('https://staging.mesakem.com/api/v1/'), { ok: true, base: 'https://staging.mesakem.com/api/v1' });
	assert.deepEqual(normalizeBaseUrl('http://localhost:3000/api/v1'), { ok: true, base: 'http://localhost:3000/api/v1' });
	assert.equal(normalizeBaseUrl('http://mesakem.com/api/v1').ok, false);
	assert.equal(normalizeBaseUrl('https://mesakem.com/api/v1?x=1').ok, false);
	assert.equal(normalizeBaseUrl('https://user:pass@mesakem.com/api/v1').ok, false);
	assert.equal(normalizeBaseUrl('not a url').ok, false);
});

test('ids: only Mesakem-shaped ids become path segments', () => {
	assert.equal(idSegment('run_abc-123'), 'run_abc-123');
	assert.equal(idSegment('../../admin'), null);
	assert.equal(idSegment('https://evil.example/x'), null);
	assert.equal(idSegment(''), null);
	assert.equal(idSegment(42), null);
	assert.deepEqual(cleanQuery({ a: '', b: null, c: undefined, d: 0, e: ['x', 'y'], f: [] }), { d: '0', e: 'x,y' });
});

test('requests go to the credential base with the credential, JSON headers and a User-Agent', async () => {
	const { context, calls } = executeContext({ routes: { 'GET /me': { body: { object: 'api_key_context' } } } });
	const response = await mesakemRequest.call(context, { method: 'GET', path: '/me' });
	assert.equal(response.statusCode, 200);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].credentialName, 'mesakemApi');
	assert.equal(calls[0].url, `${BASE}/me`);
	assert.equal(calls[0].headers.Accept, 'application/json');
	assert.match(calls[0].headers['User-Agent'], /^n8n-nodes-mesakem\//);
	assert.equal(calls[0].options.ignoreHttpStatusErrors, true);
	assert.equal(calls[0].options.returnFullResponse, true);
	// The node never handles the key itself: n8n adds it from the credential.
	assert.equal(JSON.stringify(calls[0]).includes(CREDENTIALS.apiKey), false);
});

test('an invalid credential base URL fails before any request', async () => {
	const { context, calls } = executeContext({ credentials: { apiKey: 'msk_live_x', baseUrl: 'http://evil.example/api/v1' } });
	await assert.rejects(mesakemRequest.call(context, { method: 'GET', path: '/me' }), (error) => error instanceof NodeOperationError && /https/.test(error.message));
	assert.equal(calls.length, 0);
});

test('errors: 401, plan_required on a write, missing scope, quota, org policy', () => {
	const write = { label: 'Create a task', scope: 'tasks:write', write: true };
	assert.match(describeApiError(401, errorBody('unauthorized'), {}).message, /did not accept this API key/);
	const plan = describeApiError(403, errorBody('plan_required'), {}, write);
	assert.match(plan.message, /plan cannot run "Create a task"/);
	assert.match(plan.description, /read-only API access/);
	assert.match(plan.description, /paid Mesakem plan/);
	assert.match(plan.description, /apireq_1/);
	const scope = describeApiError(403, errorBody('insufficient_scope'), {}, write);
	assert.match(scope.message, /missing the "tasks:write" permission/);
	assert.match(scope.description, /Settings → API & webhooks/);
	assert.match(describeApiError(403, errorBody('quota_exceeded'), {}, write).message, /meeting quota/);
	assert.match(describeApiError(403, errorBody('organization_policy'), {}, write).message, /organization admin/);
});

test('errors: webhook registration on a read-only key, endpoint limit and refused URL', () => {
	const hook = { label: 'Register the Mesakem webhook', scope: 'webhooks:write', webhook: true };
	const scope = describeApiError(403, errorBody('insufficient_scope'), {}, hook);
	assert.match(scope.message, /Manage webhooks/);
	assert.match(scope.description, /Manual/);
	const limit = describeApiError(403, errorBody('plan_required', [{ field: 'endpoints', message: 'This plan allows 10 endpoint(s).' }]), {}, hook);
	assert.match(limit.message, /limit of webhook endpoints/);
	assert.match(limit.description, /10 endpoint/);
	const url = describeApiError(400, errorBody('bad_request', [{ field: 'url', message: 'url_not_public' }]), {}, hook);
	assert.match(url.description, /public https/);
});

test('errors: 404, 409 bot already active, 413, 429 with Retry-After, 5xx, text bodies', () => {
	assert.match(describeApiError(404, errorBody('not_found'), {}).message, /could not find this item/);
	const bot = describeApiError(409, errorBody('meeting_bot_already_active', [], { meeting_id: 'run_9' }), {}, { label: 'Send the notetaker', scope: 'bot:write', write: true });
	assert.match(bot.message, /already in this meeting/);
	assert.match(bot.description, /run_9/);
	assert.match(describeApiError(413, errorBody('payload_too_large'), {}).message, /too large/);
	const limited = describeApiError(429, errorBody('rate_limited'), { 'Retry-After': '17' });
	assert.match(limited.description, /17 seconds/);
	assert.equal(retryAfterSeconds({}), 60);
	assert.match(describeApiError(503, 'gateway down', {}).message, /temporarily unavailable \(HTTP 503\)/);
	assert.match(describeApiError(400, JSON.stringify(errorBody('bad_request', [{ field: 'status', message: 'Unknown status.' }])), {}).description, /Unknown status/);
});

test('a failed request throws a NodeApiError with the friendly message and the HTTP code', async () => {
	const { context } = executeContext({ routes: { 'POST /tasks': { statusCode: 403, body: errorBody('plan_required') } } });
	await assert.rejects(
		mesakemRequest.call(context, { method: 'POST', path: '/tasks', body: { title: 'x' }, operation: { label: 'Create a task', scope: 'tasks:write', write: true } }),
		(error) => error instanceof NodeApiError && /plan cannot run/.test(error.message) && error.httpCode === '403',
	);
});

test('allowed statuses are returned instead of thrown (404 = deleted meanwhile)', async () => {
	const { context } = executeContext({ routes: {} });
	const response = await mesakemRequest.call(context, { method: 'GET', path: '/meetings/run_gone', allowStatuses: [404] });
	assert.equal(response.statusCode, 404);
});

test('lists follow next_cursor and stop at the limit', async () => {
	const pages = [
		{ body: { object: 'list', data: [{ id: 'run_1' }, { id: 'run_2' }], has_more: true, next_cursor: 'c2' } },
		{ body: { object: 'list', data: [{ id: 'run_3' }], has_more: false, next_cursor: null } },
	];
	const { context, calls } = executeContext({ routes: { 'GET /meetings': pages } });
	const all = await mesakemList.call(context, { method: 'GET', path: '/meetings', qs: { status: 'completed' } }, true, 0);
	assert.deepEqual(all.map((row) => row.id), ['run_1', 'run_2', 'run_3']);
	assert.equal(calls.length, 2);
	assert.equal(calls[0].qs.limit, '100');
	assert.equal(calls[1].qs.cursor, 'c2');
	assert.equal(calls[1].qs.status, 'completed');

	const one = executeContext({ routes: { 'GET /meetings': [{ body: { data: [{ id: 'a' }, { id: 'b' }], has_more: true, next_cursor: 'n' } }] } });
	const limited = await mesakemList.call(one.context, { method: 'GET', path: '/meetings' }, false, 2);
	assert.equal(limited.length, 2);
	assert.equal(one.calls.length, 1);
	assert.equal(one.calls[0].qs.limit, '2');
});

test('idempotency keys are stable per execution, node, item and operation', () => {
	const a = idempotencyKey('exec-1', 'node-1', 0, 'bot.send');
	assert.equal(a, idempotencyKey('exec-1', 'node-1', 0, 'bot.send'));
	assert.notEqual(a, idempotencyKey('exec-1', 'node-1', 1, 'bot.send'));
	assert.notEqual(a, idempotencyKey('exec-2', 'node-1', 0, 'bot.send'));
	assert.match(a, /^n8n-[0-9a-f]{48}$/);
});

test('dates: naive picker values use the workflow time zone; zoned values and plain dates pass through', () => {
	assert.equal(toApiDate('2026-10-18T09:30:00', 'Asia/Jerusalem'), '2026-10-18T06:30:00Z');
	assert.equal(toApiDate('2026-01-18T09:30:00', 'Asia/Jerusalem'), '2026-01-18T07:30:00Z');
	assert.equal(toApiDate('2026-10-18T09:30:00', 'UTC'), '2026-10-18T09:30:00Z');
	assert.equal(toApiDate('2026-10-18T09:30:00+02:00', 'Asia/Jerusalem'), '2026-10-18T09:30:00+02:00');
	assert.equal(toApiDate('2026-10-18', 'Asia/Jerusalem'), '2026-10-18');
	assert.equal(toApiDate('', 'UTC'), undefined);
	assert.equal(toApiDate({ toISO: () => '2026-10-18T00:00:00.000+03:00' }), '2026-10-18T00:00:00.000+03:00');
	assert.equal(toApiDate('2026-10-18T09:30:00', 'Not/AZone'), '2026-10-18T09:30:00Z');
});
