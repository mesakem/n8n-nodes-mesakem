import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Standard Webhooks v1 verification (https://www.standardwebhooks.com), the algorithm Mesakem signs
 * every delivery with:
 *
 *   webhook-signature: v1,<base64(HMAC-SHA256(base64decode(secret without "whsec_"), "<id>.<ts>.<body>"))>
 *
 * Several space-separated signatures may be present while a secret is being rotated; any one
 * matching is enough. The body must be the exact bytes Mesakem sent.
 */

export const SECRET_PREFIX = 'whsec_';
export const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

export function isWebhookSecret(value: unknown): value is string {
	if (typeof value !== 'string' || !value.startsWith(SECRET_PREFIX)) return false;
	const raw = value.slice(SECRET_PREFIX.length);
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return false;
	const bytes = Buffer.from(raw, 'base64');
	return bytes.length >= 24 && bytes.length <= 64;
}

/** The bare base64 signature (without the "v1," prefix). */
export function standardSignature(
	secret: string,
	messageId: string,
	timestampSeconds: number,
	body: string,
): string {
	const key = Buffer.from(secret.slice(SECRET_PREFIX.length), 'base64');
	return createHmac('sha256', key).update(`${messageId}.${timestampSeconds}.${body}`).digest('base64');
}

export interface WebhookHeaders {
	'webhook-id'?: string;
	'webhook-timestamp'?: string;
	'webhook-signature'?: string;
}

/** Picks the three Standard Webhooks headers from any header object (any case). */
export function webhookHeaders(raw: unknown): WebhookHeaders {
	const out: WebhookHeaders = {};
	if (!raw || typeof raw !== 'object') return out;
	for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
		const key = name.toLowerCase();
		if (key !== 'webhook-id' && key !== 'webhook-timestamp' && key !== 'webhook-signature') continue;
		const first = Array.isArray(value) ? value[0] : value;
		if (first !== undefined && first !== null) out[key] = String(first);
	}
	return out;
}

export function verifyStandardWebhook(input: {
	secret: string;
	headers: WebhookHeaders;
	body: string;
	nowSeconds?: number;
	toleranceSeconds?: number;
}): boolean {
	const id = input.headers['webhook-id'];
	const timestamp = input.headers['webhook-timestamp'];
	const signatureHeader = input.headers['webhook-signature'];
	if (!id || !timestamp || !signatureHeader || !/^\d{1,12}$/.test(timestamp)) return false;
	if (!isWebhookSecret(input.secret) || typeof input.body !== 'string') return false;
	const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
	const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
	if (Math.abs(now - Number(timestamp)) > tolerance) return false;
	const expected = Buffer.from(
		standardSignature(input.secret, id, Number(timestamp), input.body),
		'base64',
	);
	return signatureHeader.split(' ').some((part) => {
		const [version, value] = part.split(',', 2);
		if (version !== 'v1' || !value) return false;
		const given = Buffer.from(value, 'base64');
		return given.length === expected.length && timingSafeEqual(given, expected);
	});
}
