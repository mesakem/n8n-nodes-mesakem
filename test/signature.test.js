'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { dist, SECRET, sign } = require('./helpers');

const { standardSignature, verifyStandardWebhook, webhookHeaders, isWebhookSecret } = dist('nodes/shared/signature.js');

// The Standard Webhooks specification test vector (the server's sign.ts is tested with it too).
const VECTOR = {
	secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
	id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
	timestamp: 1614265330,
	body: '{"test": 2432232314}',
	signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
};

const vectorHeaders = (signature = VECTOR.signature, timestamp = VECTOR.timestamp) => ({
	'webhook-id': VECTOR.id,
	'webhook-timestamp': String(timestamp),
	'webhook-signature': signature,
});

test('matches the Standard Webhooks test vector', () => {
	assert.equal(`v1,${standardSignature(VECTOR.secret, VECTOR.id, VECTOR.timestamp, VECTOR.body)}`, VECTOR.signature);
	assert.equal(
		verifyStandardWebhook({ secret: VECTOR.secret, headers: vectorHeaders(), body: VECTOR.body, nowSeconds: VECTOR.timestamp }),
		true,
	);
});

test('rejects a wrong secret, a changed body, another version prefix and missing headers', () => {
	const base = { secret: VECTOR.secret, headers: vectorHeaders(), body: VECTOR.body, nowSeconds: VECTOR.timestamp };
	assert.equal(verifyStandardWebhook({ ...base, secret: 'whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }), false);
	assert.equal(verifyStandardWebhook({ ...base, body: '{"test": 2432232315}' }), false);
	assert.equal(verifyStandardWebhook({ ...base, headers: vectorHeaders(VECTOR.signature.replace('v1,', 'v2,')) }), false);
	assert.equal(verifyStandardWebhook({ ...base, headers: {} }), false);
	assert.equal(verifyStandardWebhook({ ...base, headers: { ...vectorHeaders(), 'webhook-timestamp': 'soon' } }), false);
});

test('accepts any matching signature during a secret rotation', () => {
	const headers = vectorHeaders(`v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= ${VECTOR.signature}`);
	assert.equal(verifyStandardWebhook({ secret: VECTOR.secret, headers, body: VECTOR.body, nowSeconds: VECTOR.timestamp }), true);
});

test('rejects timestamps outside the 5-minute window', () => {
	const base = { secret: VECTOR.secret, headers: vectorHeaders(), body: VECTOR.body };
	assert.equal(verifyStandardWebhook({ ...base, nowSeconds: VECTOR.timestamp + 299 }), true);
	assert.equal(verifyStandardWebhook({ ...base, nowSeconds: VECTOR.timestamp + 301 }), false);
	assert.equal(verifyStandardWebhook({ ...base, nowSeconds: VECTOR.timestamp - 301 }), false);
});

test('reads the three headers in any case and ignores the rest', () => {
	const headers = webhookHeaders({ 'Webhook-Id': 'msg_1', 'WEBHOOK-TIMESTAMP': ['123'], 'webhook-signature': 'v1,x', authorization: 'secret' });
	assert.deepEqual(headers, { 'webhook-id': 'msg_1', 'webhook-timestamp': '123', 'webhook-signature': 'v1,x' });
});

test('recognises Mesakem signing secrets only', () => {
	assert.equal(isWebhookSecret(SECRET), true);
	assert.equal(isWebhookSecret('whsec_short'), false);
	assert.equal(isWebhookSecret('whsec_not base64!!'), false);
	assert.equal(isWebhookSecret('msk_live_abc'), false);
	assert.equal(isWebhookSecret(undefined), false);
});

test('the test helper signs exactly like Mesakem', () => {
	const body = JSON.stringify({ id: 'msg_1', type: 'task.created' });
	assert.equal(verifyStandardWebhook({ secret: SECRET, headers: sign(body), body }), true);
});
