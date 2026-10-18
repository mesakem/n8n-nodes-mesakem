'use strict';

/**
 * Fake n8n contexts for unit tests. HTTP is mocked at `helpers.httpRequestWithAuthentication`, the
 * one place the nodes call the network, so every request (method, URL, query, body, headers) is
 * recorded and no test ever reaches a server.
 */

const { createHmac } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const BASE = 'https://mesakem.test/api/v1';
const SECRET = 'whsec_' + Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
const CREDENTIALS = { apiKey: 'msk_live_unit_test_key', baseUrl: BASE };
const NODE = { id: 'node-1', name: 'Mesakem', type: 'n8n-nodes-mesakem.mesakem', typeVersion: 1, position: [0, 0], parameters: {} };

function dist(relative) {
	return require(path.join(__dirname, '..', 'dist', relative));
}

/** `routes` maps "METHOD /path" (no base, no query) to a response or a function of the request. */
function httpMock(routes = {}) {
	const calls = [];
	async function httpRequestWithAuthentication(credentialName, options) {
		const url = new URL(options.url);
		const key = `${options.method} ${url.pathname.replace('/api/v1', '')}`;
		calls.push({ credentialName, key, url: options.url, qs: options.qs || {}, body: options.body, headers: options.headers || {}, options });
		let route = routes[key];
		if (typeof route === 'function') route = route(options, calls.length);
		if (Array.isArray(route)) route = route.shift();
		if (!route) return { statusCode: 404, headers: {}, body: { error: { code: 'not_found', message: 'Not found.', details: [], request_id: 'apireq_test' } } };
		return { statusCode: route.statusCode || 200, headers: route.headers || {}, body: route.body };
	}
	return { calls, httpRequestWithAuthentication };
}

function paramReader(params) {
	return (name, itemIndexOrFallback, maybeFallback) => {
		// IExecuteFunctions: (name, itemIndex, fallback); hook/webhook functions: (name, fallback).
		const fallback = typeof itemIndexOrFallback === 'number' ? maybeFallback : itemIndexOrFallback;
		if (Object.prototype.hasOwnProperty.call(params, name)) return params[name];
		if (fallback !== undefined) return fallback;
		throw new Error(`missing parameter ${name}`);
	};
}

function executeContext({ params = {}, items = [{ json: {} }], routes = {}, credentials = CREDENTIALS, continueOnFail = false } = {}) {
	const http = httpMock(routes);
	const context = {
		getInputData: () => items,
		getNodeParameter: paramReader(params),
		getNode: () => NODE,
		getCredentials: async () => credentials,
		getExecutionId: () => 'exec-1',
		getTimezone: () => 'Asia/Jerusalem',
		continueOnFail: () => continueOnFail,
		helpers: { httpRequestWithAuthentication: http.httpRequestWithAuthentication },
	};
	return { context, calls: http.calls };
}

function hookContext({ params = {}, routes = {}, staticData = {}, url = 'https://n8n.example.com/webhook/abc/webhook', workflow = { id: 'wf1', name: 'Summaries to Slack' } } = {}) {
	const http = httpMock(routes);
	const context = {
		getNodeParameter: paramReader(params),
		getNode: () => ({ ...NODE, name: 'Mesakem Trigger', type: 'n8n-nodes-mesakem.mesakemTrigger' }),
		getCredentials: async () => CREDENTIALS,
		getNodeWebhookUrl: () => url,
		getWorkflowStaticData: () => staticData,
		getWorkflow: () => workflow,
		getMode: () => 'trigger',
		helpers: { httpRequestWithAuthentication: http.httpRequestWithAuthentication },
	};
	return { context, calls: http.calls, staticData };
}

function sign(body, { secret = SECRET, id = 'msg_test_1', timestamp = Math.floor(Date.now() / 1000) } = {}) {
	const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
	const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
	return { 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': `v1,${signature}` };
}

function webhookContext({ params = {}, routes = {}, staticData = {}, body, headers = {}, mode = 'webhook', rawBody = true } = {}) {
	const http = httpMock(routes);
	const response = { statusCode: 200, sent: undefined };
	const raw = typeof body === 'string' ? body : JSON.stringify(body);
	const warnings = [];
	const context = {
		getNodeParameter: paramReader(params),
		getNode: () => ({ ...NODE, name: 'Mesakem Trigger', type: 'n8n-nodes-mesakem.mesakemTrigger' }),
		getCredentials: async () => CREDENTIALS,
		getWorkflowStaticData: () => staticData,
		getMode: () => mode,
		getHeaderData: () => headers,
		getBodyData: () => JSON.parse(raw),
		getRequestObject: () => (rawBody ? { rawBody: Buffer.from(raw, 'utf8') } : {}),
		getResponseObject: () => ({
			status(code) {
				response.statusCode = code;
				return this;
			},
			json(value) {
				response.sent = value;
				return this;
			},
		}),
		logger: { warn: (message) => warnings.push(message), info() {}, debug() {}, error() {} },
		helpers: { httpRequestWithAuthentication: http.httpRequestWithAuthentication },
	};
	return { context, calls: http.calls, response, warnings };
}

function envelope(type, data, extra = {}) {
	return {
		id: 'msg_2f9c1b7a0d8e4c6b9a1f3e5d7c9b0a12',
		type,
		api_version: '2026-10',
		created_at: '2026-10-18T09:00:00.000Z',
		workspace_id: 'ws_1',
		data,
		...extra,
	};
}

// Inside the Mesakem monorepo the spec lives at docs/api/openapi.v1.json; the standalone package repo
// ships a copy at test/fixtures/openapi.v1.json. Prefer the fixture when present.
const OPENAPI_FIXTURE = path.join(__dirname, 'fixtures', 'openapi.v1.json');
const OPENAPI_PATH = require('node:fs').existsSync(OPENAPI_FIXTURE) ? OPENAPI_FIXTURE : path.join(__dirname, '..', '..', '..', 'docs', 'api', 'openapi.v1.json');

/** The repo's OpenAPI document, or null when this package is used outside the Mesakem repo. */
function openapi() {
	return fs.existsSync(OPENAPI_PATH) ? JSON.parse(fs.readFileSync(OPENAPI_PATH, 'utf8')) : null;
}

/** True when "METHOD /concrete/path" matches an OpenAPI operation (path templates allowed). */
function openapiHasOperation(doc, method, concretePath) {
	const lower = method.toLowerCase();
	return Object.entries(doc.paths).some(([template, operations]) => {
		if (!operations[lower]) return false;
		const pattern = new RegExp(`^${template.replace(/\{[^}]+\}/g, '[^/]+')}$`);
		return pattern.test(concretePath);
	});
}

module.exports = {
	BASE,
	SECRET,
	CREDENTIALS,
	NODE,
	dist,
	httpMock,
	executeContext,
	hookContext,
	webhookContext,
	sign,
	envelope,
	openapi,
	openapiHasOperation,
};
