// The last progress the Lists tab counted for each of your checklists and
// goals, kept on this phone for Stats (DESIGN.md section 11, "Stats").
//
// Stats asks nothing of the network and reads no large cache: counting a
// checklist needs the Pokédex map (about 750 KB) and a goal its whole card
// list, which is why Stats first left them out. The Lists tab counts them
// anyway, so it leaves its counts here and Stats shows them as counted then,
// with the day, and says when the cards have changed since.
//
// Kept per account in this browser's storage, never synced: each phone
// counts from its own saved catalog data, as the value history does
// (js/value-history.js). A list deleted since is dropped by Stats, which
// shows only the lists still in the document, under their current names.
//
// Saved: {[list id]: {at, owned, stamp, total, unit, unresolved}}, where
// stamp is the newest change to any copy when the count began
// (cardStamp), unit is 'finishes' for a master set goal and null
// otherwise, and unresolved is the cards a checklist could not check.

import {currentUser} from './auth.js';
import {loadDocument} from './collection.js';
import {newestCardStamp} from './stats.js';

const KEY = 'cardTracker.listProgress';

const keyFor = (userKey) => `${KEY}.${userKey || 'local'}`;

// Whose counts: the signed-in account's, else the phone's own.
export const progressOwner = () => {
	const user = currentUser();

	return (user && user.id) || 'local';
};

// The newest change to any copy in the document on this phone.
export async function cardStamp() {
	return newestCardStamp((await loadDocument()).cards);
}

export function readListProgress(userKey = progressOwner()) {
	try {
		const saved = JSON.parse(localStorage.getItem(keyFor(userKey)) || 'null');

		return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
	}
	catch {
		return {};
	}
}

// Keeps some lists' counts: [{id, owned, total, unit, unresolved}], each
// counted from the copies as they stood at stamp.
export function recordListProgress(counts, {stamp = null, userKey = progressOwner()} = {}) {
	const saved = readListProgress(userKey);
	const at = new Date().toISOString();

	for (const {id, owned, total, unit = null, unresolved = 0} of counts) {
		if (id && Number.isInteger(owned) && Number.isInteger(total)) {
			saved[id] = {at, owned, stamp, total, unit, unresolved};
		}
	}

	try {
		localStorage.setItem(keyFor(userKey), JSON.stringify(saved));
	}
	catch {
		// Private mode or storage full: Stats leaves out the lists.
	}
}
