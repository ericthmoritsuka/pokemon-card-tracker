// Sync stamps: the ISO times every synced record carries (updated_at,
// deleted_at, restored_at, placed_at, and the per-key stamps), written and
// read the same way everywhere (plans/audit-engineering.md E-34). Pure, so
// Node tests it (tests/merge.test.mjs).

// A stamp as milliseconds, or `fallback` when it is missing or not a date.
// Each caller picks what a missing stamp means: the merge treats it as older
// than everything (-Infinity, the default).
export function stampMs(value, fallback = -Infinity) {
	const ms = Date.parse(value);

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
