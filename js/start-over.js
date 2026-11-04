// "Start over with this file" on the monprice import (DESIGN.md section 7;
// Eric, 2026-10-30): every live copy is removed, except hand-made cards,
// which a monprice file cannot hold, and every matched row of the file is
// added as a new copy. Photos, notes, and the main-image pin live on the
// card's record (js/card-info.js), which this never touches, so they show
// again on the copies added. Binder pockets that held a removed copy become
// that card's placeholder, trays and hand-picked collections drop removed
// copies, and a list binder's hand picks of removed copies go back to the
// default. When "Fill binder placeholders automatically" is on (Profile),
// the added copies then fill the placeholders waiting for them, those
// pockets included (js/placeholder-fill.js), and wishlist items that only
// the file's copies fit move to Got it. Undo puts back what this wrote,
// wherever it still holds what this wrote.
//
// planStartOver and planUndo are pure: each takes the document and returns
// a changed structuredClone, so the preview and the save run the same step
// and Node tests it (tests/start-over.test.mjs). The saves go through
// saveCopy, which replaces the document on screen only once the write
// succeeded.

import {isLive, loadDocument, newId, planImport, readMeta, saveCopy, writeMeta} from './collection.js';
import {isCustom} from './custom-card.js';
import {handBinders, inGrid, liveBinders, placements, stagedOf} from './binders.js';
import {pickEntry} from './binder-rules.js';
import {START_OVER_META, autoFillOn, planAfterAdding} from './placeholder-fill.js';
import {copyFits, planUngot} from './wishlist.js';
import {isMember, memberIds, withMembers, withoutMembers} from './collections.js';
import {infoKey} from './card-info.js';
import {nextStamp, restoreEntry, stableJson, stampEntry} from './merge.js';

// The ids the added copies take: new random ids, never the import's own
// (importEntryId) or any id worked out from the key. Two phones that each
// start over then add different copies of each row, and the merge folds
// them into one by import_key (js/merge.js collapseImportDuplicates). An id
// worked out from the key would be the same on both phones, so an Undo on
// one would remove the copies the other added. Map import_key -> id.
export async function startOverIds(cards, entries) {
	const taken = new Set((cards || []).map((card) => card && card.id));
	const ids = new Map();

	for (const {import_key: key} of entries) {
		if (!key || ids.has(key)) {
			continue;
		}

		let id = newId();

		while (taken.has(id)) {
			id = newId();
		}

		taken.add(id);
		ids.set(key, id);
	}

	return ids;
}

// A changed copy of a binder, stamped against it (js/merge.js stampEntry),
// or the binder itself when change() left it the same.
function editBinder(binder, now, change) {
	const next = structuredClone(binder);

	next.slots = Array.isArray(next.slots) ? next.slots : [];

	const before = stableJson(next);

	change(next);

	if (stableJson(next) === before) {
		return binder;
	}

	next.updated_at = nextStamp(binder.updated_at, now);

	return stampEntry(binder, next);
}

const pocketOf = (slots, {page, position}) => (slots || []).find((slot) => slot && slot.page === page && slot.position === position && !slot.cleared) || null;

// The placeholder a removed copy leaves: its card, finish, and language,
// so the copy that fills it again is the most alike (js/placeholder-fill.js).
const wantOf = (entry) => ({
	card_id: entry.card_id,
	catalog: entry.catalog || 'international',
	image: null,
	...(entry.language ? {language: entry.language} : {}),
	name: entry.name_local || null,
	variant_id: entry.variant_id || null,
});

// What a copy holds of its own and Start over does not copy to the new
// copies (Eric, 2026-10-30): grade, price, favorite, condition, Stored in,
// and pack opening.
const DETAIL_FIELDS = ['grader', 'grade', 'cert_number', 'graded_price', 'purchase_price', 'price_manual', 'is_favorite', 'condition', 'storage', 'opening_id'];

const hasDetails = (entry) => DETAIL_FIELDS.some((key) => entry[key] !== undefined && entry[key] !== null && entry[key] !== '' && entry[key] !== false);

const hasNotes = (record) => Boolean(String(Array.isArray(record.notes) ? record.notes.join('') : record.notes || '').trim());

// A short hash of what a copy holds, for Undo to tell whether an added copy
// changed since: its bookkeeping (stamps, deleted_at, restored_at) left out,
// and an empty field (undefined, null, '', false, []) the same as a missing
// one, so a sync round trip, which drops undefined, does not count as a
// change.
const BOOKKEEPING = new Set(['deleted_at', 'field_stamps', 'restored_at', 'updated_at']);

const empty = (value) => value === undefined || value === null || value === '' || value === false || (Array.isArray(value) && !value.length);

export function copyHash(entry) {
	const kept = {};

	for (const key of Object.keys(entry || {}).sort()) {
		if (!BOOKKEEPING.has(key) && !empty(entry[key])) {
			kept[key] = entry[key];
		}
	}

	// cyrb53: 53 bits, plenty for telling one copy's versions apart.
	const text = stableJson(kept);
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;

	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);

		h1 = Math.imul(h1 ^ code, 2654435761);
		h2 = Math.imul(h2 ^ code, 1597334677);
	}

	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// A copy holding a live photo with no path, on the copy or on its card's
// record: a v47 phone took it and has not uploaded it yet. Removing the copy
// would give the photo up (js/card-info.js fileGone), so Start over leaves
// it.
function uploading(entry, records) {
	const record = records.get(infoKey(entry));
	const held = new Map((record && Array.isArray(record.photos) ? record.photos : []).filter(Boolean).map((photo) => [photo.id, photo]));

	return (Array.isArray(entry.photos) ? entry.photos : []).some((photo) => photo && photo.id && !photo.deleted_at && !photo.path && !(held.get(photo.id) || {}).path);
}

const livePhotos = (record) => (Array.isArray(record.photos) ? record.photos : []).filter((photo) => photo && photo.id && !photo.deleted_at).length;

// The part of a change that takes copies out and puts copies in, shared by
// Start over and the trades log (js/moves.js), on `next`, a structuredClone
// of `doc` whose cards already hold the removed copies as tombstones.
// removed: Map id -> the tombstone; added: the new copies, which this puts
// into next.cards. A removed copy's real binder pocket becomes its card's
// placeholder (a stale slot of it goes), trays drop it, a list binder's hand
// pick of it goes back to the default, and hand-picked collections drop it;
// then the added copies fill the placeholders waiting for them when fill is
// on, and move the wishes they fit to Got it (js/placeholder-fill.js
// planAfterAdding; skipWish as its skipWish, fillUndo as fillPlan's undo).
// Returns {after, pockets, undo}: planAfterAdding's result, the pockets
// turned into placeholders, and what undoSwap needs besides the added ids
// and their hashes.
export function planSwap(doc, next, removed, added, {fill = false, fillUndo = null, now = Date.now(), skipWish = null} = {}) {
	next.cards.push(...added);

	// Pockets: the copy's real pocket becomes its card's placeholder, and a
	// stale slot of it (a merge left it behind) goes.
	const placed = placements(doc.binders || []);
	const hand = new Set(handBinders(doc.binders || []).map((binder) => binder.id));
	const undoBinders = [];
	let pockets = 0;

	next.binders = (next.binders || []).map((binder) => {
		if (!binder || !liveBinders([binder]).length) {
			return binder;
		}

		const turned = [];
		const changed = editBinder(binder, now, (draft) => {
			if (hand.has(binder.id)) {
				draft.slots = draft.slots.flatMap((slot) => {
					if (!slot || !removed.has(slot.entry_id)) {
						return [slot];
					}

					const real = placed.get(slot.entry_id);

					if (!real || real.binder.id !== binder.id || real.slot.page !== slot.page || real.slot.position !== slot.position || !inGrid(binder, slot)) {
						return [];
					}

					turned.push({entry_id: slot.entry_id, page: slot.page, position: slot.position});

					return [{page: slot.page, placed_at: new Date(now).toISOString(), position: slot.position, want: wantOf(removed.get(slot.entry_id))}];
				});
			}

			if (stagedOf(binder).some((id) => removed.has(id))) {
				draft.staged = stagedOf(binder).filter((id) => !removed.has(id));
			}
		});

		if (changed === binder) {
			return binder;
		}

		pockets += turned.length;
		undoBinders.push({
			id: binder.id,
			pockets: turned,
			staged: stableJson(changed.staged) === stableJson(binder.staged) ? null : {after: stagedOf(changed), before: stagedOf(binder)},
		});

		return changed;
	});

	// The added copies go into the placeholders waiting for them, the ones
	// just made included, and fill the wishes they fit.
	const after = planAfterAdding(next, added, {at: new Date(now).toISOString(), fill, now, skipWish, undo: fillUndo});

	// What each pocket holds now, for Undo to tell whether it still does.
	const finalOf = new Map(next.binders.filter(Boolean).map((binder) => [binder.id, binder]));

	for (const item of undoBinders) {
		item.pockets = item.pockets.map((pocket) => ({...pocket, written: stableJson(pocketOf(finalOf.get(item.id).slots, pocket))}));
	}

	// A list binder's hand pick of a removed copy goes back to the default.
	const undoPicks = [];

	next.binder_picks = (Array.isArray(next.binder_picks) ? next.binder_picks : []).map((pick) => {
		if (!pick || pick.deleted_at || !removed.has(pick.entry_id)) {
			return pick;
		}

		const cleared = pickEntry({at: nextStamp(pick.updated_at, now), binderId: pick.binder_id, entryId: null, key: pick.key, previous: pick});

		undoPicks.push({entry_id: pick.entry_id, id: pick.id, written: cleared.updated_at});

		return cleared;
	});

	if (!undoPicks.length && !Array.isArray(doc.binder_picks)) {
		delete next.binder_picks;
	}

	// Hand-picked collections drop removed copies.
	const undoCollections = [];

	next.collections = (next.collections || []).map((item) => {
		if (!item || !isLive(item) || item.kind !== 'hand') {
			return item;
		}

		const ids = memberIds(item).filter((id) => removed.has(id));
		const changed = withoutMembers(item, ids, now);

		if (changed !== item) {
			undoCollections.push({id: item.id, ids, written: ids.map((id) => changed.removed_ids[id])});
		}

		return changed;
	});

	return {
		after,
		pockets,
		undo: {
			binders: undoBinders,
			collections: undoCollections,
			fills: after.placed.map((row) => ({binder_id: row.binderId, entry_id: row.entryId, page: row.page, position: row.position, want: row.want})),
			picks: undoPicks,
			removed: [...removed.values()].map((entry) => ({deleted_at: entry.deleted_at, id: entry.id})),
			wishes: after.got,
		},
	};
}

// What Start over does to `doc`, given the import's entries
// (js/monprice.js importEntries) and their ids (startOverIds). Returns
// {doc, counts, undo}: the changed copy, the counts the preview shows, and
// what planUndo needs. `doc` itself is not changed. The counts:
// removed, added, pockets; photos, on the records the copies after Start
// over show; details, the removed copies with details of their own
// (DETAIL_FIELDS) that the new copies do not get; gone, each card and
// language with no copy after Start over, {card_id, catalog, language,
// name, copies}; and hiddenPhotos and hiddenNotes, the live photos and the
// notes on those cards' records, kept but not shown until a copy comes back.
// The document is marked with the run (start_over: {id, at}), which syncs,
// so an Undo from an earlier run can tell it is no longer the latest.
// fill: whether the added copies fill the placeholders waiting for them
// (the Profile setting; the callers below pass it); counts.filled says how
// many did, and counts.got how many wishlist items moved to Got it: only
// items no copy fitted before, since the file's copies are mostly the same
// cards added again.
export function planStartOver(doc, entries, {fill = false, ids = new Map(), now = Date.now(), run = newId()} = {}) {
	const next = structuredClone(doc);
	const removed = new Map();
	const infoById = new Map((doc.card_info || []).filter(Boolean).map((record) => [record.id, record]));
	const left = [];

	// Newer than any run this phone knows of, even with its clock behind.
	next.start_over = {at: nextStamp(doc.start_over && doc.start_over.at, now), id: run};

	next.cards = (next.cards || []).map((entry) => {
		if (!entry || !isLive(entry) || isCustom(entry)) {
			return entry;
		}

		if (uploading(entry, infoById)) {
			left.push(entry.id);

			return entry;
		}

		const at = nextStamp(entry.updated_at, now);
		const gone = stampEntry(entry, {...entry, deleted_at: at, updated_at: at});

		removed.set(entry.id, gone);

		return gone;
	});

	// New copies the way the import builds them, from an empty list, so no
	// earlier copy or tombstone of a key stops one from being added.
	const added = planImport([], entries, {ids, now}).cards;

	// The added copies go into the placeholders waiting for them, the ones
	// just made included, and fill wishes that no copy fitted before.
	const before = (doc.cards || []).filter((entry) => entry && isLive(entry));
	const swap = planSwap(doc, next, removed, added, {fill, now, skipWish: (item) => before.some((entry) => copyFits(item, entry))});

	// Card records: the ones a live copy shows after Start over, and the
	// cards whose every copy goes. Their records are kept, since card_info
	// is never touched, but nothing shows them until the card is added again.
	const shown = new Set(next.cards.filter((entry) => entry && isLive(entry)).map((entry) => infoKey(entry)));
	const gone = new Map();

	for (const entry of removed.values()) {
		const key = infoKey(entry);

		if (shown.has(key)) {
			continue;
		}

		const there = gone.get(key) || {card_id: entry.card_id, catalog: entry.catalog || 'international', copies: 0, language: entry.language || '', name: null};

		there.copies++;
		there.name = there.name || entry.name_local || null;
		gone.set(key, there);
	}

	const records = (next.card_info || []).filter((record) => record && isLive(record));
	const photos = records.filter((record) => shown.has(record.id)).reduce((sum, record) => sum + livePhotos(record), 0);
	const hidden = records.filter((record) => gone.has(record.id));

	return {
		counts: {
			added: added.length,
			details: [...removed.values()].filter(hasDetails).length,
			filled: swap.after.placed.length,
			gone: [...gone.values()].sort((a, b) => `${a.card_id}~${a.language}`.localeCompare(`${b.card_id}~${b.language}`)),
			got: swap.after.got.length,
			hiddenNotes: hidden.filter(hasNotes).length,
			hiddenPhotos: hidden.reduce((sum, record) => sum + livePhotos(record), 0),
			photos,
			pockets: swap.pockets,
			removed: removed.size,
			uploading: left.length,
		},
		doc: next,
		undo: {
			added: added.map((entry) => entry.id),
			hashes: Object.fromEntries(added.map((entry) => [entry.id, copyHash(entry)])),
			left,
			run,
			...swap.undo,
		},
	};
}

// True when Undo would put old copies back beside another run's: the
// document's latest Start over is not the one `undo` undoes (another phone
// of the account, or this one, started over since), or this run's added
// copies were folded into another run's (two phones started over offline,
// then synced).
export function staleUndo(doc, undo) {
	if (!doc || !doc.start_over) {
		return false;
	}

	if (doc.start_over.id !== (undo && undo.run)) {
		return true;
	}

	// Copies this run added, or left for an uploading photo: an added copy
	// folded into one of those is still this run's.
	const ours = new Set([...(undo.added || []), ...(undo.left || [])]);

	return (doc.cards || []).some((entry) => entry && ours.has(entry.id) && entry.merged_into && !ours.has(entry.merged_into));
}

// Undo for planStartOver: removed copies come back (js/merge.js
// restoreEntry) and added copies are removed, pockets, trays, picks, and
// collections go back to what they held, each only while it still holds
// what Start over wrote, so an edit another phone synced since stays. An
// added copy changed since (graded, priced, favorited; copyHash) stays,
// and so do its pockets; counts.kept counts them. A pocket Start over
// turned into a placeholder gets its old copy back while it holds what
// Start over wrote or an added copy that goes (filled since by "Fill
// placeholders", the automatic fill, or by hand); any other pocket holding
// an added copy that goes keeps that card's placeholder, and a tray drops
// it. An added copy that the merge folded
// another phone's copy into (merged_into) stays: it stands for that
// phone's Start over too, so removing it could leave the card with no
// copy. A placeholder an added copy filled gets its placeholder back while
// the pocket still holds that copy and the copy goes; a pocket Start over
// turned into a placeholder and then filled gets its old copy back. A
// wishlist item an added copy moved to Got it goes back to wanted when
// that copy goes. Returns {doc, counts, stale}; `doc` itself is not changed. When the
// document's latest run is another one (staleUndo), nothing is undone and
// stale is true: undoing would bring the old copies back beside that
// run's.
export function planUndo(doc, undo, {now = Date.now()} = {}) {
	if (staleUndo(doc, undo)) {
		return {counts: {added: 0, kept: 0, restored: 0}, doc: structuredClone(doc), stale: true};
	}

	return undoSwap(doc, undo, {now});
}

// planUndo's work, for any change planSwap made (Start over, a move in the
// trades log): `undo` is planSwap's undo with added (the ids of the copies
// put in) and hashes (copyHash of each, as written). drop: fields a copy
// that comes back loses (a move's left_via), stamped as changed so a merge
// with the tombstone does not bring them back. Returns {counts, doc}; `doc`
// itself is not changed.
export function undoSwap(doc, undo, {drop = [], now = Date.now()} = {}) {
	const next = structuredClone(doc);
	const removedAt = new Map(undo.removed.map((item) => [item.id, item.deleted_at]));
	const added = new Set(undo.added);
	const hashes = undo.hashes || null;
	const folded = new Set((doc.cards || []).filter((entry) => entry && entry.deleted_at && entry.merged_into && !added.has(entry.id)).map((entry) => entry.merged_into));
	const counts = {added: 0, kept: 0, restored: 0};
	const gone = new Set();
	const goneEntries = new Map();

	next.cards = (next.cards || []).map((entry) => {
		if (!entry) {
			return entry;
		}

		if (entry.deleted_at && removedAt.get(entry.id) === entry.deleted_at) {
			counts.restored++;

			const back = restoreEntry(entry, now);

			if (!drop.some((key) => key in back)) {
				return back;
			}

			const clean = {...back};

			for (const key of drop) {
				delete clean[key];
			}

			return stampEntry(entry, clean);
		}

		if (added.has(entry.id) && isLive(entry) && !folded.has(entry.id)) {
			if (hashes && hashes[entry.id] !== copyHash(entry)) {
				counts.kept++;

				return entry;
			}

			const at = nextStamp(entry.updated_at, now);

			counts.added++;
			gone.add(entry.id);
			goneEntries.set(entry.id, entry);

			return stampEntry(entry, {...entry, deleted_at: at, updated_at: at});
		}

		return entry;
	});

	const byBinder = new Map(undo.binders.map((item) => [item.id, item]));
	const placed = placements(doc.binders || []);
	const fills = new Map();

	for (const fill of undo.fills || []) {
		fills.set(fill.binder_id, [...(fills.get(fill.binder_id) || []), fill]);
	}

	next.binders = (next.binders || []).map((binder) => {
		if (!binder || !liveBinders([binder]).length) {
			return binder;
		}

		const was = byBinder.get(binder.id);

		return editBinder(binder, now, (draft) => {
			const putBack = new Map();
			// An added copy that stays (changed since, or standing for
			// another phone's copy) keeps its pocket.
			const stays = (slot) => Boolean(slot.entry_id) && added.has(slot.entry_id) && !gone.has(slot.entry_id);

			// A pocket Start over turned into a placeholder gets its old copy
			// back while it still holds what Start over wrote, or an added
			// copy that goes: filled since by "Fill placeholders" or the
			// automatic fill, or by hand.
			for (const pocket of (was && was.pockets) || []) {
				const slot = pocketOf(draft.slots, pocket);

				if (slot && !stays(slot) && (stableJson(slot) === pocket.written || gone.has(slot.entry_id))) {
					putBack.set(slot, {entry_id: pocket.entry_id, page: pocket.page, placed_at: nextStamp(slot.placed_at, now), position: pocket.position});
				}
			}

			for (const fill of fills.get(binder.id) || []) {
				const slot = pocketOf(draft.slots, fill);

				if (slot && !putBack.has(slot) && slot.entry_id === fill.entry_id && gone.has(fill.entry_id)) {
					putBack.set(slot, {page: fill.page, placed_at: nextStamp(slot.placed_at, now), position: fill.position, want: fill.want});
				}
			}

			// Any other pocket holding an added copy that goes keeps that
			// card's placeholder; a stale slot of it (the copy's real pocket
			// is elsewhere) goes.
			for (const slot of draft.slots) {
				if (!slot || putBack.has(slot) || !gone.has(slot.entry_id)) {
					continue;
				}

				const real = placed.get(slot.entry_id);

				if (real && real.binder.id === binder.id && real.slot.page === slot.page && real.slot.position === slot.position && inGrid(binder, slot)) {
					putBack.set(slot, {page: slot.page, placed_at: nextStamp(slot.placed_at, now), position: slot.position, want: wantOf(goneEntries.get(slot.entry_id))});
				}
			}

			draft.slots = draft.slots
				.filter((slot) => putBack.has(slot) || !(slot && gone.has(slot.entry_id)))
				.map((slot) => putBack.get(slot) || slot);

			if (was && was.staged && stableJson(stagedOf(draft)) === stableJson(was.staged.after)) {
				draft.staged = was.staged.before;
			}

			if (stagedOf(draft).some((id) => gone.has(id))) {
				draft.staged = stagedOf(draft).filter((id) => !gone.has(id));
			}
		});
	});

	const byPick = new Map(undo.picks.map((item) => [item.id, item]));

	if (Array.isArray(next.binder_picks)) {
		next.binder_picks = next.binder_picks.map((pick) => {
			const was = pick && byPick.get(pick.id);

			if (!was || pick.deleted_at || pick.entry_id !== null || pick.updated_at !== was.written) {
				return pick;
			}

			return pickEntry({at: nextStamp(pick.updated_at, now), binderId: pick.binder_id, entryId: was.entry_id, key: pick.key, previous: pick});
		});
	}

	const byCollection = new Map(undo.collections.map((item) => [item.id, item]));

	next.collections = (next.collections || []).map((item) => {
		const was = item && byCollection.get(item.id);

		if (!was || !isLive(item)) {
			return item;
		}

		const back = was.ids.filter((id, i) => !isMember(item, id) && (item.removed_ids || {})[id] === was.written[i]);

		return withMembers(item, back, now);
	});

	// Wishes an added copy that goes had moved to Got it are wanted again.
	const ungot = planUngot(next.wishlist || [], (undo.wishes || []).filter((mark) => gone.has(mark.entry_id)), {now});

	if (ungot.length) {
		const byWish = new Map(ungot.map((item) => [item.id, item]));

		next.wishlist = next.wishlist.map((item) => (item && byWish.get(item.id)) || item);
	}

	return {counts, doc: next};
}

// Saved: the preview, as Start over would do it now.
export async function previewStartOver(entries) {
	const doc = await loadDocument();
	const ids = await startOverIds(doc.cards, entries);

	return planStartOver(doc, entries, {fill: autoFillOn(doc), ids}).counts;
}

// The last Start over's undo is kept beside the document (writeMeta), so
// the import screen offers Undo after the screen was left or the page
// reloaded: for UNDO_DAYS days, to the account that started over, until it
// is used or another Start over replaces it.
const UNDO_META = START_OVER_META;

export const UNDO_DAYS = 7;

// The kept undo, {at, counts, undo, user_id}, or null. One from before the
// document's latest run (staleUndo) is dropped.
export async function savedUndo({now = Date.now()} = {}) {
	const [kept, doc] = await Promise.all([readMeta(UNDO_META).catch(() => null), loadDocument()]);

	if (!kept || !kept.undo || now - Date.parse(kept.at) > UNDO_DAYS * 24 * 60 * 60 * 1000 || (kept.user_id || null) !== (doc.user_id || null)) {
		return null;
	}

	if (staleUndo(doc, kept.undo)) {
		await writeMeta(UNDO_META, null).catch(() => {});

		return null;
	}

	return kept;
}

export const STALE_UNDO_TEXT = 'You started over again, on this phone or another, so this Undo would put old copies back beside the new ones. Nothing was changed.';

// Saved: Start over in one save. Resolves {counts, undo}; on a failed write
// it rejects and the document on the phone is as it was. A failed write of
// the kept undo only loses Undo after leaving the screen.
export async function applyStartOver(entries) {
	const current = await loadDocument();
	const ids = await startOverIds(current.cards, entries);
	const {counts, doc, undo} = planStartOver(current, entries, {fill: autoFillOn(current), ids});

	await saveCopy(doc);
	await writeMeta(UNDO_META, {at: new Date().toISOString(), counts, undo, user_id: current.user_id || null}).catch(() => {});

	return {counts, undo};
}

// Saved: Undo for applyStartOver, in one save. Resolves its counts. Rejects
// with an error whose stale is true, and drops the kept undo, when the
// document's latest run is another one.
export async function undoStartOver(undo) {
	const {counts, doc, stale} = planUndo(await loadDocument(), undo);

	if (stale) {
		await writeMeta(UNDO_META, null).catch(() => {});

		throw Object.assign(new Error(STALE_UNDO_TEXT), {stale: true});
	}

	await saveCopy(doc);
	await writeMeta(UNDO_META, null).catch(() => {});

	return counts;
}
