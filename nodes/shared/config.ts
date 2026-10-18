/**
 * Shared constants and small pure helpers for the Mesakem nodes.
 *
 * The API base comes from the credential (default production). Every request is built as
 * `<base><path>` from ids that pass `RESOURCE_ID`, never from a URL found inside a webhook
 * payload, so the API key is only ever sent to the configured Mesakem server.
 */

export const DEFAULT_API_BASE = 'https://mesakem.com/api/v1';
export const STAGING_API_BASE = 'https://staging.mesakem.com/api/v1';
export const CREDENTIAL_NAME = 'mesakemApi';
export const SETTINGS_PATH = 'Mesakem → Settings → API & webhooks';
export const USER_AGENT = 'n8n-nodes-mesakem/0.1';

/** Same rule as the server's path ids. */
export const RESOURCE_ID = /^[A-Za-z0-9_-]{1,200}$/;

/** Mesakem page size limit for list endpoints. */
export const MAX_PAGE_SIZE = 100;

export type BaseUrlResult = { ok: true; base: string } | { ok: false; message: string };

/** Validates the credential's Base URL and returns it without a trailing slash. */
export function normalizeBaseUrl(raw: unknown): BaseUrlResult {
	const value = typeof raw === 'string' ? raw.trim() : '';
	if (!value) return { ok: true, base: DEFAULT_API_BASE };
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return {
			ok: false,
			message: `The Base URL "${value}" is not a valid address. Use ${DEFAULT_API_BASE}`,
		};
	}
	const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
	if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
		return {
			ok: false,
			message: 'The Base URL must start with https:// (plain http:// is allowed for localhost only).',
		};
	}
	if (url.search || url.hash || url.username || url.password) {
		return {
			ok: false,
			message: `The Base URL must be a plain address such as ${DEFAULT_API_BASE} (no query, fragment or user name).`,
		};
	}
	return { ok: true, base: `${url.origin}${url.pathname.replace(/\/+$/, '')}` };
}

/** URL-safe path segment for a Mesakem id, or null when the value is not a valid id. */
export function idSegment(value: unknown): string | null {
	return typeof value === 'string' && RESOURCE_ID.test(value) ? encodeURIComponent(value) : null;
}

export function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function str(value: unknown): string | null {
	return typeof value === 'string' && value !== '' ? value : null;
}

/** Query parameters without empty values. */
export function cleanQuery(params: Record<string, unknown> | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(params ?? {})) {
		if (value === undefined || value === null || value === '') continue;
		if (Array.isArray(value)) {
			if (value.length) out[key] = value.join(',');
			continue;
		}
		out[key] = String(value);
	}
	return out;
}
