// Import "Match this file" (DESIGN.md section 5, "Import "Match this
// file""; Eric, 2026-10-22): the monprice file is the truth for how many
// copies exist of each card, language, and finish, copies scanned or added
// in the app included. The normal import (js/collection.js planImport) only
// adds what an import_key does not hold yet; this one counts.
//
// Per group (catalog, card, language, and finish: variant_id, or the raw
// monprice finish when no variant was found):
//   - the oldest live copies (created_at, then id) are kept, up to the
//     file's count; the extras are removed (soft delete, as deleteCard);
//   - the shortfall is added. An earlier deleted copy never blocks an add,
//     unlike the normal import, because copies are counted, not keyed;
//   - kept copies take the file's import_keys they lack, and added copies
//     the rest, so the normal import of the same file afterwards adds
//     nothing.
// A group on this phone that the file does not name has 0 copies in the
// file, and its copies are removed, except copies the file could not speak
// for, which are left as they are and reported: hand-made cards (no file
// can match them), copies of a row the file could not match to the catalog
// (by its monprice id, or by its number and language), and copies of a row
// left out of the import (a large count not ticked).
//
// Condition, Stored in, and favorite carry over from removed copies onto
// kept or added copies of the same card and language that have none of the
// three, as far as the new count allows, in the removed copy's own finish
// first. A binder pocket whose copy is removed takes another live copy of
// that card and language that is in no pocket, or becomes that card's
// placeholder when none is left. Photos and notes live on the card
// (js/card-info.js), so removing copies never touches them.
//
// planMatch is pure, so Node tests it (tests/match-file.test.mjs). Apply
// writes cards and binders in one save, and returns what undoMatch needs to
// put both back as they were.

import {editDocument, importEntryId, isLive, loadDocument, newId} from './collection.js';
import {nextStamp, restoreEntry, stampEntry} from './merge.js';
import {liveBinders, placements, setPocket, stagedOf} from './binders.js';
import {CARD_INFO, recordOf} from './card-info.js';
import {localPart} from './monprice.js';

const catalogOf = (item) => (item && item.catalog) || 'international';

// The group a copy or a file entry counts in.
export const groupKey = (item) => [
	catalogOf(item),
	item.card_id,
	item.language || '',
	item.variant_id || (item.finish_raw ? `raw:${item.finish_raw}` : ''),
].join('|');

// The card a copy is a copy of, in its language: the unit for carry-over
// and pockets, as for photos and notes.
const cardKey = (item) => [catalogOf(item), item.card_id, item.language || ''].join('|');

const byAge = (a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || String(a.id).localeCompare(String(b.id));

// The per-copy details that carry over (DESIGN.md: condition, Stored in,
// favorite).
const DETAILS = ['condition', 'storage', 'is_favorite'];

const hasDetail = (key, value) => (key === 'is_favorite' ? value === true : value !== undefined && value !== null && value !== '');

const isBlank = (copy) => !DETAILS.some((key) => hasDetail(key, copy[key]));

// "001/165" and "1" alike, "TG02" as "TG2" (js/monprice.js normalizeNumber).
const normalNumber = (value) => String(value ?? '').trim().toUpperCase().replace(/\d+/g, (digits) => String(Number(digits)));

// A catalog card id ends with its number: "sv1-001", "M6-012".
const numberOfCard = (cardId) => normalNumber(String(cardId || '').split('-').pop());

function groupBy(list, key) {
	const groups = new Map();

	for (const item of list) {
		const value = key(item);

		if (!groups.has(value)) {
			groups.set(value, []);
		}

		groups.get(value).push(item);
	}

	return groups;
}

// Whether a file row the import could not match speaks for this copy: the
// same monprice id in its import_key, or the same number in the same
// language (and catalog, when the row's region named one).
function spokenFor(copy, rows) {
	return rows.some(({catalog, row}) => {
		if (!row) {
			return false;
		}

		if (row.monpriceId && String(copy.import_key || '').startsWith(`monprice|${row.monpriceId}|`)) {
			return true;
		}

		if (row.language && row.language !== copy.language) {
			return false;
		}

		if (catalog && catalog !== catalogOf(copy)) {
			return false;
		}

		return Boolean(row.number) && numberOfCard(copy.card_id) === normalNumber(localPart(row.number));
	});
}

// A version of entry with change applied, stamped as an edit (js/merge.js
// stampEntry), one millisecond after its last version at the earliest.
function edited(entry, change, now) {
	const next = {...entry, ...change, updated_at: nextStamp(entry.updated_at, now)};

	for (const [key, value] of Object.entries(change)) {
		if (value === undefined) {
			delete next[key];
		}
	}

	return stampEntry(entry, next);
}

const removedVersion = (entry, now) => {
	const at = nextStamp(entry.updated_at, now);

	return stampEntry(entry, {...entry, deleted_at: at, updated_at: at});
};

// The placeholder for a removed copy's pocket.
const wantOf = (copy) => ({
	card_id: copy.card_id,
	catalog: catalogOf(copy),
	image: null,
	name: copy.name_local || null,
	variant_id: copy.variant_id || null,
});

// What matching the file does, without saving anything.
//   doc       the person's document: cards, binders, card_info
//   entries   js/monprice.js importEntries of the rows to match, one per copy
//   ids       import_key -> id for new copies (importEntryId); a missing or
//             taken one gets a new id
//   unmatched [{row, catalog}]: rows the import could not match, and rows
//             the file could not describe; their cards are left alone
//   skipped   entries of rows left out of this import (a large count not
//             ticked); their groups are left alone
// Returns {cards, binders, counts, undo}: new lists (changed entries are
// new objects, the doc is not changed), the numbers for the preview, and
// the before-images undoMatch needs.
export function planMatch(doc, entries, {ids = new Map(), now = Date.now(), skipped = [], unmatched = []} = {}) {
	const cards = Array.isArray(doc.cards) ? doc.cards : [];
	const binders = Array.isArray(doc.binders) ? doc.binders : [];
	const records = Array.isArray(doc[CARD_INFO]) ? doc[CARD_INFO] : [];
	const at = new Date(now).toISOString();
	const counts = {added: 0, carried: 0, hand: 0, kept: 0, leftAlone: 0, photosKept: 0, pocketsMoved: 0, pocketsToPlaceholder: 0, removed: 0};

	const wanted = groupBy(entries.filter((fields) => fields && fields.card_id), groupKey);
	const live = cards.filter((card) => card && isLive(card));
	const have = groupBy(live.filter((card) => card.card_id), groupKey);
	const skippedKeys = new Set(skipped.filter((fields) => fields && fields.card_id).map(groupKey));

	const kept = [];
	const removed = [];
	// group key -> {fileKeys, keep, shortfall, entries}
	const plans = new Map();

	for (const copies of have.values()) {
		copies.sort(byAge);
	}

	for (const card of live) {
		if (!card.card_id || catalogOf(card) === 'custom') {
			counts.hand++;
		}
	}

	for (const key of new Set([...wanted.keys(), ...have.keys()])) {
		const copies = have.get(key) || [];
		const fileList = wanted.get(key);

		if (!fileList) {
			// The file names no copy of this group: removed, unless the file
			// could not speak for it.
			for (const copy of copies) {
				if (catalogOf(copy) === 'custom') {
					continue;
				}

				if (skippedKeys.has(key) || spokenFor(copy, unmatched)) {
					counts.leftAlone++;
				}
				else {
					removed.push(copy);
				}
			}

			continue;
		}

		const keep = copies.slice(0, fileList.length);

		kept.push(...keep);
		removed.push(...copies.slice(fileList.length));
		plans.set(key, {entries: fileList, keep, shortfall: fileList.length - keep.length});
	}

	const removedIds = new Set(removed.map((copy) => copy.id));
	const out = [...cards];
	const position = new Map(out.map((card, i) => [card.id, i]));
	const taken = new Set(cards.map((card) => card.id));
	const before = new Map();
	const patches = new Map();
	const patch = (copy, change) => patches.set(copy.id, {...(patches.get(copy.id) || {}), ...change});

	// import_keys every copy that stays live holds, so no key is held twice.
	const held = new Set(live.filter((card) => !removedIds.has(card.id) && card.import_key).map((card) => card.import_key));
	const added = [];
	let n = 0;

	for (const [key, plan] of plans) {
		const fileKeys = plan.entries.map((fields) => fields.import_key).filter(Boolean);
		const own = new Set(fileKeys);
		const free = fileKeys.filter((importKey) => !held.has(importKey));

		for (const copy of plan.keep) {
			if (copy.import_key && own.has(copy.import_key)) {
				continue;
			}

			const next = free.shift();

			if (next) {
				patch(copy, {import_key: next});
				held.add(next);
			}
		}

		for (let i = 0; i < plan.shortfall; i++) {
			const fields = plan.entries[plan.keep.length + i];
			const importKey = free.shift() || null;
			const wantedId = importKey ? ids.get(importKey) : null;
			const id = wantedId && !taken.has(wantedId) ? wantedId : newId();
			const stamp = new Date(now + n++).toISOString();
			const entry = Object.fromEntries(Object.entries({...fields, import_key: importKey}).filter(([, value]) => value !== undefined));

			Object.assign(entry, {created_at: stamp, deleted_at: null, id, updated_at: stamp});

			if (!importKey) {
				delete entry.import_key;
			}
			else {
				held.add(importKey);
			}

			taken.add(id);
			added.push({entry, group: key});
		}
	}

	// Carry-over: each removed copy with details goes to a blank kept or
	// added copy of the same card and language: first within its own
	// finish, then, for the donors left, to any finish. Older donors and
	// kept copies (oldest first) before added ones.
	const targets = [...kept.sort(byAge).map((copy) => ({copy, group: groupKey(copy)})), ...added.map(({entry, group}) => ({copy: entry, group}))];
	const addedIds = new Set(added.map(({entry}) => entry.id));
	const filled = new Set();
	let donors = [...removed].sort(byAge).filter((donor) => !isBlank(donor));

	for (const sameFinish of [true, false]) {
		donors = donors.filter((donor) => {
			const target = targets.find(({copy, group}) => cardKey(copy) === cardKey(donor)
				&& (!sameFinish || group === groupKey(donor))
				&& !filled.has(copy.id)
				&& isBlank({...copy, ...(patches.get(copy.id) || {})}));

			if (!target) {
				return true;
			}

			const change = {};

			for (const field of DETAILS) {
				if (hasDetail(field, donor[field])) {
					change[field] = donor[field];
				}
			}

			filled.add(target.copy.id);
			counts.carried++;

			if (addedIds.has(target.copy.id)) {
				Object.assign(target.copy, change);
			}
			else {
				patch(target.copy, change);
			}

			return false;
		});
	}

	for (const [id, change] of patches) {
		const i = position.get(id);

		before.set(id, out[i]);
		out[i] = edited(out[i], change, now);
	}

	for (const copy of removed) {
		const i = position.get(copy.id);

		before.set(copy.id, out[i]);
		out[i] = removedVersion(out[i], now);
	}

	out.push(...added.map(({entry}) => entry));

	// Pockets: a removed copy's pocket takes another copy of the card, or
	// its placeholder.
	const placed = placements(binders);
	const staged = new Set(liveBinders(binders).flatMap((binder) => stagedOf(binder)));
	const liveAfter = out.filter((card) => card && isLive(card) && card.card_id);
	const spare = groupBy(liveAfter.filter((card) => !placed.has(card.id)), cardKey);
	let current = binders;
	const changedBinders = new Map();

	for (const copy of [...removed].sort(byAge)) {
		const where = placed.get(copy.id);

		if (!where) {
			continue;
		}

		const pool = spare.get(cardKey(copy)) || [];
		const rank = (card) => (groupKey(card) === groupKey(copy) ? 0 : 1) + (staged.has(card.id) ? 2 : 0);
		const choice = [...pool].sort((a, b) => rank(a) - rank(b) || byAge(a, b))[0];
		const content = choice ? {entry_id: choice.id} : {want: wantOf(copy)};

		if (choice) {
			pool.splice(pool.indexOf(choice), 1);
			counts.pocketsMoved++;
		}
		else {
			counts.pocketsToPlaceholder++;
		}

		const next = setPocket(current, {at, binderId: where.binder.id, content, page: where.slot.page, position: where.slot.position});

		for (const binder of next) {
			if (!changedBinders.has(binder.id)) {
				changedBinders.set(binder.id, binders.find((item) => item.id === binder.id));
			}
		}

		current = current.map((binder) => next.find((item) => item.id === binder.id) || binder);
	}

	// Photos kept: the card's own photos (js/card-info.js) on every card and
	// language that loses copies. They stay; this only counts them.
	for (const key of new Set(removed.map(cardKey))) {
		const copy = removed.find((item) => cardKey(item) === key);
		const record = recordOf(records, copy);

		if (record && !record.deleted_at && Array.isArray(record.photos)) {
			counts.photosKept += record.photos.filter((photo) => photo && photo.id && !photo.deleted_at).length;
		}
	}

	counts.added = added.length;
	counts.removed = removed.length;
	counts.kept = kept.length;

	return {
		binders: current,
		cards: out,
		counts,
		undo: {
			added: added.map(({entry}) => entry.id),
			binders: [...changedBinders.values()].map((binder) => structuredClone(binder)),
			cards: [...before.values()].map((card) => structuredClone(card)),
		},
	};
}

// What matching the file would do now, for the preview.
export async function previewMatch(entries, options = {}) {
	return planMatch(await loadDocument(), entries, options).counts;
}

// Matches the file in one save of cards and binders. Returns {counts, undo}.
export async function applyMatch(entries, options = {}) {
	const ids = new Map();

	for (const fields of entries) {
		if (fields.import_key && !ids.has(fields.import_key)) {
			ids.set(fields.import_key, await importEntryId(fields.import_key));
		}
	}

	return editDocument((doc) => {
		const plan = planMatch(doc, entries, {...options, ids, now: Date.now()});

		doc.cards = plan.cards;
		doc.binders = plan.binders;

		return {counts: plan.counts, undo: plan.undo};
	});
}

// The fields Undo puts back on a copy: everything but the bookkeeping.
const BOOKKEEPING = new Set(['id', 'created_at', 'updated_at', 'deleted_at', 'restored_at', 'merged_into', 'field_stamps']);

// Puts the cards and binders back as they were before planMatch, in place
// on doc: added copies removed, removed copies restored (js/merge.js
// restoreEntry, so the merge lets them win over the tombstone), changed
// copies' fields and changed binders' pockets and trays as they were. Every
// step is a new stamped edit, so it syncs like any other. Pure but for doc.
export function undoPlan(doc, undo, now = Date.now()) {
	const cards = doc.cards;
	const index = new Map(cards.map((card, i) => [card.id, i]));

	for (const id of undo.added || []) {
		const i = index.get(id);

		if (i !== undefined && isLive(cards[i])) {
			cards[i] = removedVersion(cards[i], now);
		}
	}

	for (const was of undo.cards || []) {
		const i = index.get(was.id);

		if (i === undefined) {
			continue;
		}

		let entry = cards[i];

		if (entry.deleted_at && !was.deleted_at) {
			entry = restoreEntry(entry, now);
		}

		const change = {};

		for (const key of new Set([...Object.keys(was), ...Object.keys(entry)])) {
			if (!BOOKKEEPING.has(key) && JSON.stringify(was[key]) !== JSON.stringify(entry[key])) {
				change[key] = was[key];
			}
		}

		cards[i] = Object.keys(change).length ? edited(entry, change, now) : entry;
	}

	const binders = Array.isArray(doc.binders) ? doc.binders : [];

	for (const was of undo.binders || []) {
		const i = binders.findIndex((binder) => binder && binder.id === was.id);

		if (i < 0) {
			continue;
		}

		const there = binders[i];
		const next = {...structuredClone(there), slots: structuredClone(was.slots || []), updated_at: nextStamp(there.updated_at, now)};

		if (Object.hasOwn(was, 'staged')) {
			next.staged = [...was.staged];
		}
		else {
			delete next.staged;
		}

		binders[i] = stampEntry(there, next);
	}

	doc.binders = binders;
}

// Saved: undoes applyMatch's change in one save.
export function undoMatch(undo) {
	return editDocument((doc) => undoPlan(doc, undo, Date.now()));
}
