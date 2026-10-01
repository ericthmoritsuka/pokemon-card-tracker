// Merging two versions of one person's document, entry by entry (DESIGN.md
// section 3). Pure functions with no DOM or storage, so Node can test them
// (tests/merge.test.mjs).
//
// The rules, for two versions of the entry with one id:
//   1. The newer updated_at wins.
//   2. At the same updated_at, a tombstone (deleted_at set) wins.
//   3. Otherwise the one whose content sorts last wins, so every device makes
//      the same choice and the two copies end up identical.
// A tombstone is an entry like any other, so a deletion is never dropped and
// a phone holding an older copy cannot bring the card back.

export const LISTS = ['cards', 'collections', 'goals', 'binders', 'wishlist', 'openings'];

function time(value) {
	const ms = Date.parse(value);

	return Number.isNaN(ms) ? -Infinity : ms;
}

// JSON with the keys sorted, so equal content gives equal text.
export function stableJson(value) {
	if (Array.isArray(value)) {
		return `[${value.map(stableJson).join(',')}]`;
	}

	if (value && typeof value === 'object') {
		return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
	}

	return JSON.stringify(value === undefined ? null : value);
}

export function newerEntry(a, b) {
	const diff = time(a.updated_at) - time(b.updated_at);

	if (diff !== 0) {
		return diff > 0 ? a : b;
	}

	if (Boolean(a.deleted_at) !== Boolean(b.deleted_at)) {
		return a.deleted_at ? a : b;
	}

	return stableJson(a) >= stableJson(b) ? a : b;
}

// Merges two versions of one list. Entries keep the local order, and entries
// only the other side has follow in its order. Neither input is changed.
export function mergeEntries(local, remote) {
	const merged = new Map();
	const loose = [];

	for (const entry of local || []) {
		if (entry && entry.id) {
			merged.set(entry.id, entry);
		}
		else {
			loose.push(entry);
		}
	}

	for (const entry of remote || []) {
		if (!entry || !entry.id) {
			continue;
		}

		const mine = merged.get(entry.id);

		merged.set(entry.id, mine ? newerEntry(mine, entry) : entry);
	}

	return [...merged.values(), ...loose];
}

const later = (a, b) => (time(a) >= time(b) ? a : b);

// Merges two whole documents. Every list is merged entry by entry; settings
// go to whichever side changed them last; other fields keep the local value
// and gain any the remote side has that the local one lacks.
export function mergeDocuments(local, remote) {
	local = local || {};
	remote = remote || {};

	const out = {...remote, ...local};
	const lists = new Set(LISTS);

	for (const key of Object.keys(out)) {
		if (Array.isArray(local[key]) || Array.isArray(remote[key])) {
			lists.add(key);
		}
	}

	for (const key of lists) {
		out[key] = mergeEntries(Array.isArray(local[key]) ? local[key] : [], Array.isArray(remote[key]) ? remote[key] : []);
	}

	if (local.settings || remote.settings) {
		const mine = local.settings || {};
		const theirs = remote.settings || {};
		const newest = time(theirs.updated_at) > time(mine.updated_at) ? theirs : mine;

		out.settings = {...(newest === mine ? theirs : mine), ...newest};
	}

	if (local.updated_at || remote.updated_at) {
		out.updated_at = later(local.updated_at, remote.updated_at);
	}

	return out;
}

// "list|id" -> updated_at for every entry, plus "settings" -> its content:
// what a document holds, in a form two documents can be compared by.
export function stamps(doc) {
	const out = new Map();

	if (doc && doc.settings) {
		out.set('settings', stableJson(doc.settings));
	}

	for (const [key, value] of Object.entries(doc || {})) {
		if (!Array.isArray(value)) {
			continue;
		}

		for (const entry of value) {
			if (entry && entry.id) {
				out.set(`${key}|${entry.id}`, String(entry.updated_at));
			}
		}
	}

	return out;
}

// True when the two documents hold the same entries at the same versions,
// and the same settings.
export function sameContent(a, b) {
	const left = stamps(a);
	const right = stamps(b);

	if (left.size !== right.size) {
		return false;
	}

	for (const [key, value] of left) {
		if (right.get(key) !== value) {
			return false;
		}
	}

	return true;
}

// Entries in doc that differ from the stamps last known to be on the server.
export function countChanged(doc, base) {
	let changed = 0;

	for (const [key, value] of stamps(doc)) {
		if (!base || base.get(key) !== value) {
			changed++;
		}
	}

	return changed;
}
