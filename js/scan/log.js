// The scan log: with "Record every scan" on (Phone check), every camera
// capture and every picked photo leaves one entry on this phone, so a long
// run of real cards can be handed to the developer as one file. Off by
// default: nobody records by surprise.
//
// Its own database (js/idb.js), apart from the draft tray and the person's
// cards; nothing here is synced.
//   entries   one per scan, key "<tray item id>"
//   pictures  the straightened card as a JPEG Blob, key "<tray item id>",
//             and for a holder drop the view before and after it (about
//             320 px, keys "<id>:before" and "<id>:after"), for replaying
//             the drop (lab/holder/replay.mjs --log)
//
// An entry, as stored (the export adds `picture` as a data URL):
//   {id, at, app, source, how, phone, report, first, firstLocked, outcome}
// report is js/scan/session.js reportOfRead with its match (the same data
// as the per-card Scan report); first is what the scanner answered on its
// own, before anyone touched the card (view.js keeps it up to date until
// the first tap that changes the card, language, or finish); outcome is
// filled in later: saved (with what was saved, how many copies, whether it
// differs from first, and undone when Undo session took it back), removed,
// discarded, skipped (already owned), handmade (saved as a hand-made card),
// or dropped by the scanner itself (with why: not a card, repeat, repeat on
// reopen). A holder drop that took nothing (logEvent) is an entry of its
// own, how 'holder', with the drop's numbers and why: none, small, large,
// shape (judged on the change), moved, light, off the frame (on the card).
// scanner: SCANNER, the scanner's own version, kept even where the app's
// version cannot be read.
//
// Writes are serialized, so a later change never lands before an earlier
// one, and none of them throws: a log that cannot be kept must never stop
// a scan.

import {appVersions} from '../whats-new.js';
import {database} from '../idb.js';
import {captureStamp} from './image.js';

const ENTRIES = 'entries';
const PICTURES = 'pictures';

const db = database('card-tracker-scan-log', [ENTRIES, PICTURES]);

// The most entries kept: past it, the oldest go first.
export const LOG_MAX = 500;

// The scanner's version, in every entry.
export const SCANNER = 36;

// The most entries whose drop views (before and after, about 15 KB each)
// are kept: past it, the oldest entries' views go first.
export const VIEWS_MAX = 80;

// The switches, on this phone only, in localStorage.
const RECORD_KEY = 'card-tracker:scan-log';
const PICTURES_KEY = 'card-tracker:scan-log-pictures';

// What each switch was last set to here, for a browser with storage off.
const switches = {pictures: true, record: false};

function readSwitch(key, fallback) {
	try {
		const value = localStorage.getItem(key);

		return value === null ? fallback : value === 'on';
	}
	catch {
		return fallback;
	}
}

function writeSwitch(key, on) {
	try {
		localStorage.setItem(key, on ? 'on' : 'off');
	}
	catch {
		// Storage turned off: the switch lasts this visit only.
	}
}

export const recording = () => readSwitch(RECORD_KEY, switches.record);

export function setRecording(on) {
	switches.record = Boolean(on);
	writeSwitch(RECORD_KEY, switches.record);
}

export const picturesOn = () => readSwitch(PICTURES_KEY, switches.pictures);

export function setPictures(on) {
	switches.pictures = Boolean(on);
	writeSwitch(PICTURES_KEY, switches.pictures);
}

// The app's version (js/whats-new.js appVersions), asked once per visit.
let versionPromise = null;

function appVersion() {
	if (!versionPromise) {
		versionPromise = appVersions().then((found) => found.current || null).catch(() => null);
	}

	return versionPromise;
}

let queue = Promise.resolve();

// Runs task after every write before it. The answer rejects when the task
// fails; the queue goes on either way.
function serial(task) {
	const next = queue.then(task);

	queue = next.catch(() => null);

	return next;
}

// A write the scanner makes: it never throws.
const quiet = (promise) => promise.catch(() => null);

const get = (store, key) => db.run(store, 'readonly', (s) => s.get(key));
const put = (store, key, value) => db.run(store, 'readwrite', (s) => s.put(value, key));

// A new entry for a scan (only while recording is on). fields: {at, source,
// how, phone}.
export function startEntry(id, fields) {
	if (!recording()) {
		return Promise.resolve(null);
	}

	return quiet(serial(async () => {
		const app = await appVersion();

		await put(ENTRIES, id, {app, first: null, firstLocked: false, how: null, id, outcome: null, phone: null, report: null, scanner: SCANNER, source: null, ...fields});
		await trim();

		return id;
	}));
}

// Changes an entry that exists; a scan taken with recording off has none,
// and is left alone. change: an object to merge, or a function of the entry
// that returns one (or null for no change).
export function updateEntry(id, change) {
	return quiet(serial(async () => {
		const entry = await get(ENTRIES, id);

		if (!entry) {
			return null;
		}

		const patch = typeof change === 'function' ? change(entry) : change;

		if (!patch) {
			return entry;
		}

		const next = {...entry, ...patch};

		await put(ENTRIES, id, next);

		return next;
	}));
}

// The scanner's own answer, until the entry is locked by a change made by
// hand.
export const noteFirst = (id, first, extra = {}) => updateEntry(id, (entry) => (entry.firstLocked ? (Object.keys(extra).length ? extra : null) : {...extra, first}));

// The first change made by hand: the answer before it stays the first one.
export const lockFirst = (id) => updateEntry(id, (entry) => (entry.firstLocked ? null : {firstLocked: true}));

// How a scan ended. Never replaces an outcome already there, except that
// Undo (a removed card or a discarded session brought back) clears it
// (null).
export const setOutcome = (id, outcome) => updateEntry(id, (entry) => {
	if (outcome === null) {
		return entry.outcome && ['discarded', 'removed'].includes(entry.outcome.kind) ? {outcome: null} : null;
	}

	return entry.outcome ? null : {outcome: {at: new Date().toISOString(), ...outcome}};
});

// Saved with Done: what was saved ({card, catalog, language, finish}), and
// whether it differs from the scanner's first answer. changes names what
// differs: card, language, finish. The finish counts only when the first
// answer had one (a card changed by hand before its finishes loaded had
// none, and any finish saved then would read as a change).
export const savedOutcome = (id, saved) => updateEntry(id, (entry) => {
	if (entry.outcome) {
		return null;
	}

	const first = entry.first || {};
	const changes = [];

	if (!first.card || first.card.id !== saved.card || (first.card.catalog && first.card.catalog !== saved.catalog)) {
		changes.push('card');
	}

	if (first.language !== saved.language) {
		changes.push('language');
	}

	if (first.finish && first.finish !== saved.finish) {
		changes.push('finish');
	}

	return {outcome: {at: new Date().toISOString(), kind: 'saved', ...saved, changed: changes.length > 0, changes}};
});

// Undo session took a saved scan back.
export const markUndone = (id) => updateEntry(id, (entry) => (entry.outcome && entry.outcome.kind === 'saved' ? {outcome: {...entry.outcome, undone: true}} : null));

// The straightened card's picture, when the switch is on and the entry
// exists.
export function savePicture(id, blob) {
	if (!blob || !picturesOn()) {
		return Promise.resolve(null);
	}

	return quiet(serial(async () => {
		if (await get(ENTRIES, id)) {
			await put(PICTURES, id, blob);
		}
	}));
}

// A holder drop that took nothing (only while recording is on): {at, how,
// why, drop}.
let eventSeq = 0;

export function logEvent(event) {
	if (!recording()) {
		return Promise.resolve(null);
	}

	const id = `event-${Date.now()}-${++eventSeq}`;

	return quiet(serial(async () => {
		const app = await appVersion();

		await put(ENTRIES, id, {app, first: null, firstLocked: true, id, outcome: {at: event.at, kind: 'skipped', why: event.why}, phone: null, report: null, scanner: SCANNER, source: 'camera', ...event});
		await trim();

		return id;
	}));
}

// The view before and after a holder drop ({before, after}: JPEG Blobs),
// when the pictures switch is on and the entry exists; past VIEWS_MAX
// entries with views, the oldest lose theirs.
export function saveViews(id, {after = null, before = null} = {}) {
	if (!picturesOn() || (!after && !before)) {
		return Promise.resolve(null);
	}

	return quiet(serial(async () => {
		if (!(await get(ENTRIES, id))) {
			return;
		}

		if (before) {
			await put(PICTURES, `${id}:before`, before);
		}

		if (after) {
			await put(PICTURES, `${id}:after`, after);
		}

		const keys = ((await db.run(PICTURES, 'readonly', (s) => s.getAllKeys())) || []).filter((key) => String(key).endsWith(':after'));

		if (keys.length > VIEWS_MAX) {
			const entries = (await db.run(ENTRIES, 'readonly', (s) => s.getAll())) || [];
			const at = new Map(entries.map((entry) => [entry.id, String(entry.at)]));
			const old = keys.map((key) => String(key).slice(0, -':after'.length)).sort((a, b) => (at.get(a) || '').localeCompare(at.get(b) || '')).slice(0, keys.length - VIEWS_MAX);

			for (const owner of old) {
				await db.run(PICTURES, 'readwrite', (s) => s.delete(`${owner}:before`));
				await db.run(PICTURES, 'readwrite', (s) => s.delete(`${owner}:after`));
			}
		}
	}));
}

// Past LOG_MAX entries, the oldest go, with their pictures.
async function trim() {
	if (await db.run(ENTRIES, 'readonly', (s) => s.count()) <= LOG_MAX) {
		return;
	}

	const entries = (await db.run(ENTRIES, 'readonly', (s) => s.getAll())) || [];
	const old = entries.sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(0, entries.length - LOG_MAX);

	for (const entry of old) {
		await db.run(ENTRIES, 'readwrite', (s) => s.delete(entry.id));
		await db.run(PICTURES, 'readwrite', (s) => s.delete(entry.id));
		await db.run(PICTURES, 'readwrite', (s) => s.delete(`${entry.id}:before`));
		await db.run(PICTURES, 'readwrite', (s) => s.delete(`${entry.id}:after`));
	}
}

// Every entry, oldest first.
export function listEntries() {
	return serial(async () => ((await db.run(ENTRIES, 'readonly', (s) => s.getAll())) || []).sort((a, b) => String(a.at).localeCompare(String(b.at))));
}

// {count, bytes}: how many scans are kept and about how much room they take
// (the entries as JSON, plus the pictures).
export async function logSize() {
	try {
		return await serial(async () => {
			const entries = (await db.run(ENTRIES, 'readonly', (s) => s.getAll())) || [];
			const pictures = (await db.run(PICTURES, 'readonly', (s) => s.getAll())) || [];
			const bytes = entries.reduce((sum, entry) => sum + JSON.stringify(entry).length, 0) + pictures.reduce((sum, blob) => sum + (blob && blob.size ? blob.size : 0), 0);

			return {bytes, count: entries.length};
		});
	}
	catch {
		return {bytes: 0, count: 0};
	}
}

export function clearLog() {
	return serial(async () => {
		await db.run(ENTRIES, 'readwrite', (s) => s.clear());
		await db.run(PICTURES, 'readwrite', (s) => s.clear());
	});
}

const dataUrl = (blob) => new Promise((resolve) => {
	const reader = new FileReader();

	reader.onload = () => resolve(reader.result);
	reader.onerror = () => resolve(null);
	reader.readAsDataURL(blob);
});

// The whole log as one file, scan-log-YYYYMMDD-HHMMSS.json, holding {app,
// exported, entries}, each entry with its picture as a data URL (or null),
// and a holder drop's views as {before, after} data URLs when kept.
export async function logFile(at = new Date()) {
	const entries = await listEntries();
	const out = [];

	for (const entry of entries) {
		const blob = await get(PICTURES, entry.id).catch(() => null);
		const before = await get(PICTURES, `${entry.id}:before`).catch(() => null);
		const after = await get(PICTURES, `${entry.id}:after`).catch(() => null);
		const {firstLocked, ...rest} = entry;
		const views = before || after ? {after: after ? await dataUrl(after) : null, before: before ? await dataUrl(before) : null} : undefined;

		out.push({...rest, picture: blob ? await dataUrl(blob) : null, ...(views ? {views} : {})});
	}

	const text = JSON.stringify({app: await appVersion(), entries: out, exported: at.toISOString()}, null, 1);

	return new File([text], `scan-log-${captureStamp(at)}.json`, {type: 'application/json'});
}
