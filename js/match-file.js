// Import "Match this file" (DESIGN.md section 5, "Import "Match this
// file""; Eric, 2026-10-22): the monprice file is the truth for how many
// copies exist of each card and language, copies scanned or added in the
// app included. The normal import (js/collection.js planImport) only adds
// what an import_key does not hold yet; this one counts.
//
// The rule (Eric, 2026-10-30): a copy he still owns is never removed and
// replaced by a new blank one. So, per card and language:
//   - each copy counts under the card the file gives its monprice row (the
//     monprice id in its import_key), else under its own card. A copy the
//     old import put on another card (an international fallback that now
//     matches a Japanese record, say) is the same card;
//   - the file's copies are matched to existing ones: the same import_key,
//     then the same monprice row, then the same finish, then any finish.
//     Within each step, copies that hold something he set (details,
//     purchase or grading, favorite, a pocket, a tray, a hand-picked
//     collection) go first, then the oldest (created_at, then id);
//   - a matched copy is kept and updated from the file: card and catalog
//     when they moved, the finish (variant_id, or the raw monprice finish
//     when no variant was found; a copy's own variant stays when the file
//     found none), and import_key. Every field he set stays;
//   - only the copies left over are removed (soft delete, as deleteCard),
//     and only the file's copies left over are added. An earlier deleted
//     copy never blocks an add, because copies are counted, not keyed.
// Copies the file could not speak for are left as they are and reported:
// hand-made cards, copies of a row the import could not match (by monprice
// id, or a leftover with the same number and language), and copies of a
// row left out of the import (a large count not ticked: by monprice id,
// and leftovers of the same card and language).
//
// What a removed copy held moves to a kept copy of the same card and
// language that holds none of it, own finish first: condition, Stored in,
// favorite, purchase price and currency, grading, Liga price, opening, and
// its hand-picked collections. A binder pocket or tray holding a removed
// copy takes another unplaced copy of that card and language; a pocket
// with none left becomes that card's placeholder, and a tray drops it. A
// rule binder's hand pick (binder_picks) of a removed copy is left alone:
// it shows the default copy (js/binder-rules.js shownCopy) until Undo
// brings the copy back. Photos and notes live on the card (js/card-info.js)
// and stay; when every copy of a card moved to another card, its record
// moves with them (as linking a hand-made card does, js/collection.js
// moveCardInfo).
//
// planMatch is pure, so Node tests it (tests/match-file.test.mjs). Apply
// writes everything in one save, and Undo reverts only what still holds
// the value Apply wrote, so an edit synced from another phone since stays.

import {editDocument, importEntryId, isLive, loadDocument, newId} from './collection.js';
import {nextStamp, restoreEntry, stampEntry} from './merge.js';
import {liveBinders, placements, setPocket, slotsOf, stagedOf} from './binders.js';
import {CARD_INFO, infoKey, joinNotes, newRecord, recordOf} from './card-info.js';
import {localPart} from './monprice.js';
import {mergePhotoLists} from './photos/model.js';
import {stampMs} from './stamp.js';

const catalogOf = (item) => (item && item.catalog) || 'international';

// The finish group a copy or a file entry is in: catalog, card, language,
// and variant_id, or the raw monprice finish when no variant was found.
export const groupKey = (item) => [
	catalogOf(item),
	item.card_id,
	item.language || '',
	item.variant_id || (item.finish_raw ? `raw:${item.finish_raw}` : ''),
].join('|');

// The card a copy is a copy of, in its language: the unit that is counted,
// as for photos and notes.
const cardKey = (item) => [catalogOf(item), item.card_id, item.language || ''].join('|');

const byAge = (a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || String(a.id).localeCompare(String(b.id));

// What a person sets on a copy, which moves from a removed copy to a kept
// one (js/merge.js USER_FIELDS, but notes, which move to the card record,
// plus favorite and the Liga price).
const CARRIED = ['condition', 'storage', 'is_favorite', 'purchase_price', 'purchase_currency', 'grader', 'grade', 'cert_number', 'graded_price', 'price_manual', 'opening_id'];

const hasDetail = (key, value) => (key === 'is_favorite' ? value === true : value !== undefined && value !== null && value !== '');

const isBlank = (copy) => !CARRIED.some((key) => hasDetail(key, copy[key]));

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// "001/165" and "1" alike, "TG02" as "TG2" (js/monprice.js normalizeNumber).
const normalNumber = (value) => String(value ?? '').trim().toUpperCase().replace(/\d+/g, (digits) => String(Number(digits)));

// A catalog card id ends with its number: "sv1-001", "M6-012".
const numberOfCard = (cardId) => normalNumber(String(cardId || '').split('-').pop());

// The parts of a monprice import_key (js/monprice.js importKey):
// monprice|<id>|<language>|<finish>|<copy index>.
function monpriceKey(key) {
	const parts = String(key || '').split('|');

	if (parts[0] !== 'monprice' || parts.length < 5 || !parts[1]) {
		return null;
	}

	return {card: `${parts[1]}|${parts[2]}`, finish: parts[3], id: parts[1], row: parts.slice(0, 4).join('|')};
}

// The first entry of each monprice row and each monprice id and language.
function rowsOf(entries) {
	const row = new Map();
	const card = new Map();

	for (const entry of entries) {
		const key = monpriceKey(entry.import_key);

		if (key && !row.has(key.row)) {
			row.set(key.row, entry);
		}

		if (key && !card.has(key.card)) {
			card.set(key.card, entry);
		}
	}

	return {card, row};
}

// Whether a copy and a file entry name the same finish.
function sameFinish(copy, entry) {
	if (copy.variant_id && entry.variant_id) {
		return copy.variant_id === entry.variant_id;
	}

	const raw = entry.finish_raw || (monpriceKey(entry.import_key) || {}).finish;

	return !copy.variant_id && Boolean(copy.finish_raw) && copy.finish_raw === raw;
}

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

// Whether a file row the import could not match speaks for this copy by
// its number: the same number in the same language (and catalog, when the
// row's region named one).
function spokenFor(copy, rows) {
	return rows.some(({catalog, row}) => {
		if (!row) {
			return false;
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

// The fields that differ between two versions of an entry, for Undo:
// [{key, before, after}].
const BOOKKEEPING = new Set(['id', 'created_at', 'updated_at', 'deleted_at', 'restored_at', 'merged_into', 'field_stamps']);

function fieldChanges(before, after) {
	const out = [];

	for (const key of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
		if (!BOOKKEEPING.has(key) && !same((before || {})[key], (after || {})[key])) {
			out.push({after: structuredClone((after || {})[key]), before: structuredClone((before || {})[key]), key});
		}
	}

	return out;
}

// The fields of entry put back to `before` where they still hold `after`.
function reverted(entry, fields, now) {
	const change = {};

	for (const {after, before, key} of fields) {
		if (same(entry[key], after)) {
			change[key] = before;
		}
	}

	return Object.keys(change).length ? edited(entry, change, now) : entry;
}

// A hand-picked collection's membership (js/collections.js isMember; that
// module needs a browser, so the two small edits are here).
function memberOf(collection, id) {
	const added = collection.entry_ids && collection.entry_ids[id];
	const removed = collection.removed_ids && collection.removed_ids[id];

	return added !== undefined && (removed === undefined || stampMs(added) > stampMs(removed));
}

function withMembership(collection, id, member, now) {
	const stamp = nextStamp(collection.updated_at, now);
	const added = {...(collection.entry_ids || {})};
	const removed = {...(collection.removed_ids || {})};

	if (member) {
		added[id] = stamp;
		delete removed[id];
	}
	else {
		delete added[id];
		removed[id] = stamp;
	}

	const next = {...collection, entry_ids: added, removed_ids: removed, updated_at: stamp};

	if (!Object.keys(removed).length) {
		delete next.removed_ids;
	}

	return stampEntry(collection, next);
}

// The placeholder for a removed copy's pocket.
const wantOf = (copy) => ({
	card_id: copy.card_id,
	catalog: catalogOf(copy),
	image: null,
	name: copy.name_local || null,
	variant_id: copy.variant_id || null,
});

// What a pocket holds, comparable across versions.
function contentOf(slot) {
	if (!slot) {
		return null;
	}

	if (slot.entry_id) {
		return {entry_id: slot.entry_id};
	}

	if (slot.want) {
		return {want: slot.want};
	}

	if (slot.art) {
		return {art: slot.art};
	}

	return slot.empty ? {empty: true} : null;
}

const pocketsOf = (binder, binders) => new Map(slotsOf(binder, placements(binders)).map((slot) => [`${slot.page}|${slot.position}`, contentOf(slot)]));

// What Apply changed in each binder, for Undo: the pockets, before and
// after, and the ids it put in or took out of the tray.
function binderChanges(before, after) {
	const out = [];

	for (const binder of after) {
		const was = before.find((item) => item.id === binder.id);

		if (!was || was === binder) {
			continue;
		}

		const old = pocketsOf(was, before);
		const now = pocketsOf(binder, after);
		const pockets = [];

		for (const key of new Set([...old.keys(), ...now.keys()])) {
			if (!same(old.get(key), now.get(key))) {
				const [page, position] = key.split('|').map(Number);

				pockets.push({after: now.get(key) || null, before: old.get(key) || null, page, position});
			}
		}

		const trayBefore = stagedOf(was);
		const trayAfter = stagedOf(binder);

		out.push({
			id: binder.id,
			pockets,
			trayIn: trayAfter.filter((id) => !trayBefore.includes(id)),
			trayOut: trayBefore.filter((id) => !trayAfter.includes(id)),
		});
	}

	return out;
}

// What matching the file does, without saving anything.
//   doc       the person's document: cards, binders, card_info, collections
//   entries   js/monprice.js importEntries of the rows to match, one per copy
//   ids       import_key -> id for new copies (importEntryId); a missing or
//             taken one gets a new id
//   unmatched [{row, catalog}]: rows the import could not match, and rows
//             the file could not describe; their copies are left alone
//   skipped   entries of rows left out of this import (a large count not
//             ticked); their copies are left alone
// Returns {cards, binders, card_info, collections, counts, undo}: new lists
// (card_info and collections only when they changed; changed entries are
// new objects, the doc is not changed), the numbers for the preview, and
// what undoPlan needs.
export function planMatch(doc, entries, {ids = new Map(), now = Date.now(), skipped = [], unmatched = []} = {}) {
	const cards = Array.isArray(doc.cards) ? doc.cards : [];
	const binders = Array.isArray(doc.binders) ? doc.binders : [];
	const records = Array.isArray(doc[CARD_INFO]) ? doc[CARD_INFO] : [];
	const collections = Array.isArray(doc.collections) ? doc.collections : [];
	const at = new Date(now).toISOString();
	const counts = {added: 0, carried: 0, hand: 0, kept: 0, leftAlone: 0, photosKept: 0, pocketsMoved: 0, pocketsToPlaceholder: 0, removed: 0};

	const fileEntries = entries.filter((fields) => fields && fields.card_id);
	const skippedEntries = skipped.filter((fields) => fields && fields.card_id);
	const wanted = groupBy(fileEntries, cardKey);
	const fileRows = rowsOf(fileEntries);
	const skippedRows = rowsOf(skippedEntries);
	const skippedCards = new Set(skippedEntries.map(cardKey));
	const unmatchedIds = new Set(unmatched.map((item) => item && item.row && item.row.monpriceId).filter(Boolean));

	const live = cards.filter((card) => card && isLive(card));
	const placed = placements(binders);
	const staged = new Set(liveBinders(binders).flatMap((binder) => stagedOf(binder)));
	const hands = collections.filter((item) => item && !item.deleted_at && item.kind === 'hand');
	const holding = new Map(live.map((copy) => [copy.id, !isBlank(copy) || placed.has(copy.id) || staged.has(copy.id) || hands.some((item) => memberOf(item, copy.id))]));
	const keepFirst = (a, b) => Number(holding.get(b.id)) - Number(holding.get(a.id)) || byAge(a, b);

	// Each copy's card and language, as the file sees it.
	const home = new Map();
	const pools = new Map();

	for (const copy of live) {
		if (!copy.card_id || catalogOf(copy) === 'custom') {
			counts.hand++;

			continue;
		}

		const key = monpriceKey(copy.import_key);
		const sameLanguage = (entry) => Boolean(entry) && (entry.language || '') === (copy.language || '');
		let target = cardKey(copy);

		if (key) {
			if (sameLanguage(fileRows.row.get(key.row))) {
				target = cardKey(fileRows.row.get(key.row));
			}
			else if (skippedRows.row.has(key.row)) {
				target = null;
			}
			else if (sameLanguage(fileRows.card.get(key.card))) {
				target = cardKey(fileRows.card.get(key.card));
			}
			else if (skippedRows.card.has(key.card) || unmatchedIds.has(key.id)) {
				target = null;
			}
		}

		if (!target) {
			counts.leftAlone++;

			continue;
		}

		home.set(copy.id, target);

		if (!pools.has(target)) {
			pools.set(target, []);
		}

		pools.get(target).push(copy);
	}

	// Match the file's copies to the existing ones, card and language by
	// card and language.
	const matched = [];
	const removed = [];
	const shortfall = [];

	for (const key of new Set([...wanted.keys(), ...pools.keys()])) {
		const free = [...(pools.get(key) || [])].sort(keepFirst);
		const open = [...(wanted.get(key) || [])];
		const take = (fits) => {
			for (let i = 0; i < open.length;) {
				const j = free.findIndex((copy) => fits(copy, open[i]));

				if (j < 0) {
					i++;

					continue;
				}

				matched.push({copy: free[j], entry: open[i], key});
				free.splice(j, 1);
				open.splice(i, 1);
			}
		};

		take((copy, entry) => Boolean(entry.import_key) && copy.import_key === entry.import_key);
		take((copy, entry) => {
			const a = monpriceKey(copy.import_key);
			const b = monpriceKey(entry.import_key);

			return Boolean(a && b) && a.row === b.row;
		});
		take(sameFinish);
		take(() => true);

		shortfall.push(...open.map((entry) => ({entry, key})));

		for (const copy of free) {
			if (skippedCards.has(key) || spokenFor(copy, unmatched)) {
				counts.leftAlone++;
			}
			else {
				removed.push(copy);
			}
		}
	}

	const removedIds = new Set(removed.map((copy) => copy.id));
	const matchedIds = new Set(matched.map(({copy}) => copy.id));
	// import_keys held by copies that stay as they are, so no key is held twice.
	const heldElsewhere = new Set(live.filter((card) => !removedIds.has(card.id) && !matchedIds.has(card.id) && card.import_key).map((card) => card.import_key));
	const freeKey = (entry) => (entry.import_key && !heldElsewhere.has(entry.import_key) ? entry.import_key : null);

	const patches = new Map();
	const patch = (copy, change) => patches.set(copy.id, {...(patches.get(copy.id) || {}), ...change});
	const moves = [];

	for (const {copy, entry} of matched) {
		const change = {};
		const moved = cardKey(copy) !== cardKey(entry);

		if (moved) {
			moves.push({from: copy, to: entry});
			change.catalog = catalogOf(entry);
			change.card_id = entry.card_id;

			for (const field of ['name_local', 'set_name_local']) {
				if (entry[field]) {
					change[field] = entry[field];
				}
			}
		}

		if (!same(copy.fallback, entry.fallback)) {
			change.fallback = entry.fallback || undefined;
		}

		if (entry.variant_id) {
			if (copy.variant_id !== entry.variant_id) {
				change.variant_id = entry.variant_id;
			}

			if (Object.hasOwn(copy, 'finish_raw')) {
				change.finish_raw = undefined;
			}
		}
		else if (moved || !copy.variant_id) {
			if (copy.variant_id) {
				change.variant_id = null;
			}

			if (entry.finish_raw && copy.finish_raw !== entry.finish_raw) {
				change.finish_raw = entry.finish_raw;
			}
		}

		const importKey = freeKey(entry);

		if (importKey && copy.import_key !== importKey) {
			change.import_key = importKey;
		}

		for (const [field, value] of Object.entries(change)) {
			if (same(copy[field], value) && (value !== undefined || !Object.hasOwn(copy, field))) {
				delete change[field];
			}
		}

		if (Object.keys(change).length) {
			patch(copy, change);
		}
	}

	const taken = new Set(cards.map((card) => card.id));
	const added = [];
	let n = 0;

	for (const {entry: fields, key} of shortfall) {
		const importKey = freeKey(fields);
		const wantedId = importKey ? ids.get(importKey) : null;
		const id = wantedId && !taken.has(wantedId) ? wantedId : newId();
		const stamp = new Date(now + n++).toISOString();
		const entry = Object.fromEntries(Object.entries({...fields, import_key: importKey}).filter(([, value]) => value !== undefined));

		Object.assign(entry, {created_at: stamp, deleted_at: null, id, updated_at: stamp});

		if (!importKey) {
			delete entry.import_key;
		}

		taken.add(id);
		added.push({entry, group: key});
	}

	// Carry-over: what a removed copy holds goes to a kept copy of the same
	// card and language that holds none of it, own finish first; oldest
	// donors and targets first. A removed copy's place in a hand-picked
	// collection goes with it.
	const after = (copy) => ({...copy, ...(patches.get(copy.id) || {})});
	const filled = new Set();
	const joins = [];

	for (const donor of removed.filter((copy) => !isBlank(copy)).sort(byAge)) {
		const options = matched
			.filter(({copy, key}) => key === home.get(donor.id) && !filled.has(copy.id) && isBlank(after(copy)))
			.map(({copy}) => copy)
			.sort(byAge);
		const target = options.find((copy) => sameFinish(donor, after(copy)) || groupKey(after(copy)) === groupKey(donor)) || options[0];

		if (!target) {
			continue;
		}

		const change = {};

		for (const field of CARRIED) {
			if (hasDetail(field, donor[field])) {
				change[field] = donor[field];
			}
		}

		filled.add(target.id);
		patch(target, change);
		joins.push({donor, target});
		counts.carried++;
	}

	const out = [...cards];
	const position = new Map(out.map((card, i) => [card.id, i]));
	const cardUndo = [];

	for (const [id, change] of patches) {
		const i = position.get(id);
		const was = out[i];

		out[i] = edited(was, change, now);
		cardUndo.push({fields: fieldChanges(was, out[i]), id});
	}

	for (const copy of removed) {
		const i = position.get(copy.id);

		out[i] = removedVersion(out[i], now);
		cardUndo.push({id: copy.id, removed: true});
	}

	out.push(...added.map(({entry}) => entry));

	// Hand-picked collections: a kept copy takes a removed copy's place.
	let collectionsOut = null;
	const collectionUndo = [];

	for (const {donor, target} of joins) {
		for (const item of hands) {
			const list = collectionsOut || collections;
			const i = list.findIndex((entry) => entry && entry.id === item.id);
			const current = list[i];

			if (!memberOf(current, donor.id) || memberOf(current, target.id)) {
				continue;
			}

			collectionsOut = collectionsOut || [...collections];
			collectionsOut[i] = withMembership(current, target.id, true, now);
			collectionUndo.push({entryId: target.id, id: current.id, stamp: collectionsOut[i].entry_ids[target.id]});
		}
	}

	// Pockets: a removed copy's pocket takes another copy of the card, or
	// its placeholder.
	const liveAfter = out.filter((card) => card && isLive(card) && card.card_id);
	const spare = groupBy(liveAfter.filter((card) => !placed.has(card.id)), cardKey);
	let current = binders;
	const homeOf = (copy) => home.get(copy.id) || cardKey(copy);

	for (const copy of [...removed].sort(byAge)) {
		const where = placed.get(copy.id);

		if (!where) {
			continue;
		}

		const pool = spare.get(homeOf(copy)) || [];
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

		current = current.map((binder) => next.find((item) => item.id === binder.id) || binder);
	}

	// Trays: a removed copy in a tray gives its place to another unplaced
	// copy of the card that is in no tray, or leaves the tray.
	const inTrays = new Set(liveBinders(current).flatMap((binder) => stagedOf(binder)));

	current = current.map((binder) => {
		if (!binder || !isLive(binder) || !stagedOf(binder).some((id) => removedIds.has(id))) {
			return binder;
		}

		const tray = [];

		for (const id of stagedOf(binder)) {
			if (!removedIds.has(id)) {
				tray.push(id);

				continue;
			}

			const copy = cards.find((card) => card.id === id);
			const pool = spare.get(homeOf(copy)) || [];
			const choice = pool.filter((card) => !inTrays.has(card.id)).sort((a, b) => Number(groupKey(b) === groupKey(copy)) - Number(groupKey(a) === groupKey(copy)) || byAge(a, b))[0];

			if (choice) {
				pool.splice(pool.indexOf(choice), 1);
				inTrays.add(choice.id);
				tray.push(choice.id);
			}
		}

		return stampEntry(binder, {...binder, staged: tray, updated_at: nextStamp(binder.updated_at, now)});
	});

	// Card records: when every copy of a card moved to another card, the
	// record (photos, notes, pin) moves with them.
	let infoOut = null;
	const infoUndo = [];
	const liveKeys = new Set(liveAfter.map(cardKey));

	for (const {from, to} of moves) {
		const list = infoOut || records;
		const si = list.findIndex((record) => record && record.id === infoKey(from));

		if (liveKeys.has(cardKey(from)) || si < 0 || list[si].deleted_at || infoKey(from) === infoKey(to)) {
			continue;
		}

		infoOut = infoOut || [...records];

		const source = infoOut[si];
		const ti = infoOut.findIndex((record) => record && record.id === infoKey(to));
		const was = ti < 0 ? null : infoOut[ti];
		const base = was && !was.deleted_at ? was : null;
		const start = was ? (was.deleted_at ? restoreEntry(was, now) : was) : newRecord(to, at);
		const stamp = nextStamp(start.updated_at, now);
		const merged = stampEntry(start, {
			...start,
			deleted_at: null,
			main_image: (base && base.main_image) || source.main_image || null,
			notes: joinNotes(base ? base.notes : null, [source.notes]) || null,
			photos: mergePhotoLists(base ? base.photos : [], source.photos),
			updated_at: stamp,
		});

		if (ti < 0) {
			infoOut.push(merged);
		}
		else {
			infoOut[ti] = merged;
		}

		infoOut[si] = removedVersion(source, now);
		infoUndo.push({id: source.id, removed: true});
		infoUndo.push({created: !base, fields: fieldChanges(base, merged), id: merged.id});
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
	counts.kept = matched.length;

	return {
		binders: current,
		card_info: infoOut || undefined,
		cards: out,
		collections: collectionsOut || undefined,
		counts,
		undo: {
			added: added.map(({entry}) => entry.id),
			binders: binderChanges(binders, current),
			card_info: infoUndo,
			cards: cardUndo,
			collections: collectionUndo,
		},
	};
}

// What matching the file would do now, for the preview.
export async function previewMatch(entries, options = {}) {
	return planMatch(await loadDocument(), entries, options).counts;
}

// Matches the file in one save of cards, binders, card records, and
// collections. Returns {counts, undo}.
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

		if (plan.card_info) {
			doc[CARD_INFO] = plan.card_info;
		}

		if (plan.collections) {
			doc.collections = plan.collections;
		}

		return {counts: plan.counts, undo: plan.undo};
	});
}

// Puts back what planMatch changed, in place on doc, where it still holds
// the value Apply wrote: an edit made since, here or synced from another
// phone, stays. Added copies are removed and every pocket or tray still
// holding one is cleared; removed copies are restored (js/merge.js
// restoreEntry, so the merge lets them win over the tombstone); changed
// fields, pockets, trays, card records, and collection places go back.
// Every step is a new stamped edit, so it syncs like any other. Pure but
// for doc.
export function undoPlan(doc, undo, now = Date.now()) {
	const at = new Date(now).toISOString();
	const cards = Array.isArray(doc.cards) ? doc.cards : [];
	const index = new Map(cards.map((card, i) => [card.id, i]));
	const gone = new Set();

	for (const id of undo.added || []) {
		const i = index.get(id);

		if (i !== undefined && isLive(cards[i])) {
			cards[i] = removedVersion(cards[i], now);
			gone.add(id);
		}
	}

	for (const change of undo.cards || []) {
		const i = index.get(change.id);

		if (i === undefined) {
			continue;
		}

		if (change.removed) {
			cards[i] = restoreEntry(cards[i], now);
		}
		else {
			cards[i] = reverted(cards[i], change.fields || [], now);
		}
	}

	doc.cards = cards;

	let binders = Array.isArray(doc.binders) ? doc.binders : [];
	const put = (next) => {
		binders = binders.map((binder) => next.find((item) => item.id === binder.id) || binder);
	};
	const pocket = (binderId, page, position, content) => {
		try {
			put(setPocket(binders, {at, binderId, content, page, position}));
		}
		catch {
			// The binder was deleted or made smaller since: nothing to put back.
		}
	};

	for (const change of undo.binders || []) {
		if (!liveBinders(binders).some((binder) => binder.id === change.id)) {
			continue;
		}

		for (const {after, before, page, position} of change.pockets || []) {
			const there = liveBinders(binders).find((binder) => binder.id === change.id);

			if (same(pocketsOf(there, binders).get(`${page}|${position}`) || null, after)) {
				pocket(change.id, page, position, before);
			}
		}

		const there = liveBinders(binders).find((binder) => binder.id === change.id);
		const placedNow = placements(binders);
		const inTrays = new Set(liveBinders(binders).flatMap((binder) => stagedOf(binder)));
		const liveIds = new Set(cards.filter((card) => card && isLive(card)).map((card) => card.id));
		const tray = stagedOf(there).filter((id) => !(change.trayIn || []).includes(id));

		for (const id of change.trayOut || []) {
			if (liveIds.has(id) && !placedNow.has(id) && !inTrays.has(id)) {
				tray.push(id);
			}
		}

		if (!same(tray, stagedOf(there))) {
			put([stampEntry(there, {...there, staged: tray, updated_at: nextStamp(there.updated_at, now)})]);
		}
	}

	// A copy Undo removed leaves every pocket and tray it is still in.
	if (gone.size) {
		for (const binder of liveBinders(binders)) {
			for (const slot of slotsOf(binder, placements(binders))) {
				if (gone.has(slot.entry_id)) {
					pocket(binder.id, slot.page, slot.position, null);
				}
			}
		}

		for (const binder of liveBinders(binders)) {
			if (stagedOf(binder).some((id) => gone.has(id))) {
				put([stampEntry(binder, {...binder, staged: stagedOf(binder).filter((id) => !gone.has(id)), updated_at: nextStamp(binder.updated_at, now)})]);
			}
		}
	}

	doc.binders = binders;

	if ((undo.card_info || []).length && Array.isArray(doc[CARD_INFO])) {
		const records = doc[CARD_INFO];

		for (const change of undo.card_info) {
			const i = records.findIndex((record) => record && record.id === change.id);

			if (i < 0) {
				continue;
			}

			if (change.removed) {
				records[i] = restoreEntry(records[i], now);
			}
			else if (change.created) {
				if (!records[i].deleted_at && change.fields.every(({after, key}) => same(records[i][key], after))) {
					records[i] = removedVersion(records[i], now);
				}
			}
			else {
				records[i] = reverted(records[i], change.fields || [], now);
			}
		}
	}

	if ((undo.collections || []).length && Array.isArray(doc.collections)) {
		for (const {entryId, id, stamp} of undo.collections) {
			const i = doc.collections.findIndex((item) => item && item.id === id);
			const item = doc.collections[i];

			if (item && memberOf(item, entryId) && item.entry_ids[entryId] === stamp) {
				doc.collections[i] = withMembership(item, entryId, false, now);
			}
		}
	}
}

// Saved: undoes applyMatch's change in one save.
export function undoMatch(undo) {
	return editDocument((doc) => undoPlan(doc, undo, Date.now()));
}
