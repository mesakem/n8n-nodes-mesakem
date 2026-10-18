/**
 * n8n date pickers produce "2026-10-18T09:30:00" without a time zone, while the Mesakem API wants
 * ISO 8601 with an offset (or a plain date). Naive values are read in the workflow's time zone.
 */

const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

function zoneOffsetMinutes(utcMs: number, timeZone: string): number {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	}).formatToParts(new Date(utcMs));
	const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
	const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
	return Math.round((asUtc - utcMs) / 60000);
}

function validZone(timeZone: string): string {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone });
		return timeZone;
	} catch {
		return 'UTC';
	}
}

/** Returns an API-ready date string, or undefined for an empty value. */
export function toApiDate(value: unknown, timeZone = 'UTC'): string | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	if (typeof value === 'object' && typeof (value as { toISO?: unknown }).toISO === 'function') {
		return String((value as { toISO: () => string }).toISO());
	}
	if (value instanceof Date) return value.toISOString();
	const text = String(value).trim();
	if (!text) return undefined;
	if (DATE_ONLY.test(text) || HAS_ZONE.test(text)) return text;
	const match = text.match(NAIVE);
	if (!match) return text;
	const [, y, mo, d, h, mi, s] = match;
	const wallMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
	const zone = validZone(timeZone);
	// Two passes handle the hour around a daylight-saving change.
	let utcMs = wallMs - zoneOffsetMinutes(wallMs, zone) * 60000;
	utcMs = wallMs - zoneOffsetMinutes(utcMs, zone) * 60000;
	return new Date(utcMs).toISOString().replace('.000Z', 'Z');
}
