// Monprice import check (Eric, 2026-11-26): the groups of copies the import
// made where one card, language, and finish has more than one copy, for him
// to count in his hands. Since v122 a second copy in the same finish is a
// spare and gets listed for sale, so a duplicate the import made by mistake
// would be sold. The screen (js/import-dup-view.js) lists each group with a
// link to the card page, where a copy that is not there is removed with the
// existing Undo, and a Checked mark that hides the group.
//
// An imported copy carries an import_key (js/monprice.js importKey). The
// finish is told apart as the spares tell it (js/wishlist.js copyFinishKey),
// so a group here is exactly a group whose extra copies count as spares.
// Only the imported copies count: a copy he added by hand beside them is not
// the import's, and Check spares lists it.
//
// Worked out without the page, so node can test it
// (tests/import-dup-check.test.mjs).

import {cardLanguageKey} from './binder-rules.js';
import {isLive} from './collection.js';
import {copyFinishKey} from './wishlist.js';

// Whether a copy came in with the import.
export const isImported = (entry) => Boolean(entry) && isLive(entry) && Boolean(entry.import_key);

// The groups of imported copies of one card, language, and finish with more
// than one copy: [{key, card_id, catalog, language, finish, copies, first,
// last, rows}], rows being the copies, the oldest first. Most copies first,
// then the earliest added, so the biggest worry is on top.
// finishKey: how a copy's finish is told apart.
export function importDuplicates(cards, {finishKey = copyFinishKey} = {}) {
	const groups = new Map();

	for (const entry of cards || []) {
		if (!isImported(entry)) {
			continue;
		}

		const key = JSON.stringify([cardLanguageKey(entry), finishKey(entry)]);

		if (!groups.has(key)) {
			groups.set(key, {entries: [], finish: finishKey(entry), key});
		}

		groups.get(key).entries.push(entry);
	}

	return [...groups.values()]
		.filter(({entries}) => entries.length > 1)
		.map(({entries, finish, key}) => {
			const rows = [...entries].sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || String(a.id).localeCompare(String(b.id)));
			const times = rows.map((entry) => String(entry.created_at || '')).filter(Boolean);

			return {
				card_id: rows[0].card_id,
				catalog: rows[0].catalog || 'international',
				copies: rows.length,
				finish,
				first: times[0] || null,
				key,
				language: rows[0].language || null,
				last: times[times.length - 1] || null,
				rows,
			};
		})
		.sort((a, b) => (b.copies - a.copies) || String(a.first || '').localeCompare(String(b.first || '')) || a.key.localeCompare(b.key));
}

// ------------------------------------------------------------- Checked
//
// "Checked, I have them": the group leaves the list. The mark is a note on
// this phone, {group key: signature}, that changes no copy. The signature is
// the copies' IDs, so the group comes back when its count changes (a copy
// removed or added), and when one is swapped for another.

export const checkedSignature = (group) => JSON.stringify(group.rows.map((entry) => String(entry.id)).sort());

export const isChecked = (group, checked) => Boolean(checked) && Object.hasOwn(checked, group.key) && checked[group.key] === checkedSignature(group);

// The marks that still hold for a whole list of groups, so a mark on a
// group that changed, or that is gone, is forgotten.
export function keepChecked(groups, checked) {
	const kept = {};

	for (const group of groups) {
		if (isChecked(group, checked)) {
			kept[group.key] = checked[group.key];
		}
	}

	return kept;
}

// The groups still to check, and the groups marked Checked.
export const toCheck = (groups, checked) => groups.filter((group) => !isChecked(group, checked));
export const markedChecked = (groups, checked) => groups.filter((group) => isChecked(group, checked));

// ---------------------------------------------------------------- words

// "2026-10-31" and "10:22", the phone's own day and time, from the ISO time
// a copy was added.
export function dayAndTime(iso) {
	const date = new Date(iso);

	if (!iso || Number.isNaN(date.getTime())) {
		return null;
	}

	const two = (n) => String(n).padStart(2, '0');

	return {day: `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`, time: `${two(date.getHours())}:${two(date.getMinutes())}`};
}

// When a group's copies were added: "Added 2026-10-31 at 10:22", the same
// minute for all; "Added 2026-10-31 at 10:22 to 10:25" within one day;
// "Added 2026-10-31 at 10:22 to 2026-11-02 at 09:00" otherwise. parts: how a
// time is read, for a test that fixes the zone.
export function addedText(group, parts = dayAndTime) {
	const first = parts(group.first);
	const last = parts(group.last);

	if (!first) {
		return 'Added at an unknown time';
	}

	if (!last || (last.day === first.day && last.time === first.time)) {
		return `Added ${first.day} at ${first.time}`;
	}

	return last.day === first.day
		? `Added ${first.day} at ${first.time} to ${last.time}`
		: `Added ${first.day} at ${first.time} to ${last.day} at ${last.time}`;
}
