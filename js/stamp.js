// Sync stamps: the ISO times every synced record carries (updated_at,
// deleted_at, restored_at, placed_at, and the per-key stamps), written and
// read the same way everywhere (plans/audit-engineering.md E-34). Pure, so
// Node tests it (tests/merge.test.mjs).

// A stamp as milliseconds, or `fallback` when it is missing or not a date.
// Each caller picks what a missing stamp means: the merge treats it as older
// than everything (-Infinity, the default).
//
// A merge reads the same few thousand stamps many times over, and parsing
// them took about 600 ms of a 1,600-copy merge on a slow phone, so each
// text's time is kept once parsed (the same answer Date.parse gives).
const parsed = new Map();
const PARSED_MAX = 50000;

export function stampMs(value, fallback = -Infinity) {
	let ms;

	if (typeof value === 'string') {
		ms = parsed.get(value);

		if (ms === undefined) {
			ms = Date.parse(value);

			if (parsed.size >= PARSED_MAX) {
				parsed.clear();
			}

			parsed.set(value, ms);
		}
	}
	else {
		ms = Date.parse(value);
	}

	return Number.isNaN(ms) ? fallback : ms;
}

// A stamp strictly newer than the entry's last one, so the merge always
// takes the new version: even when two edits land in one millisecond, and
// even on a phone whose clock is behind the phone that wrote `previous`.
// Every write in the app takes its updated_at from here.
export function nextStamp(previous, now = Date.now()) {
	const before = Date.parse(previous);

	return new Date(Number.isNaN(before) || now > before ? now : before + 1).toISOString();
}
