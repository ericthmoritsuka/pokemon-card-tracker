// "Start over with this file" on the monprice import (DESIGN.md section 7;
// Eric, 2026-10-30): every live copy is removed, except hand-made cards,
// which a monprice file cannot hold, and every matched row of the file is
// added as a new copy. Photos, notes, and the main-image pin live on the
// card's record (js/card-info.js), which this never touches, so they show
// again on the copies added. Binder pockets that held a removed copy become
// that card's placeholder, trays and hand-picked collections drop removed
// copies, and a list binder's hand picks of removed copies go back to the
// default. Undo puts back what this wrote, wherever it still holds what
// this wrote.
//
// planStartOver and planUndo are pure: each takes the document and returns
// a changed structuredClone, so the preview and the save run the same step
// and Node tests it (tests/start-over.test.mjs). The saves go through
// saveCopy, which replaces the document on screen only once the write
// succeeded.

import {importEntryId, isLive, loadDocument, planImport, saveCopy} from './collection.js';
import {isCustom} from './custom-card.js';
import {handBinders, inGrid, liveBinders, placements, stagedOf} from './binders.js';
import {pickEntry} from './binder-rules.js';
import {isMember, memberIds, withMembers, withoutMembers} from './collections.js';
import {infoKey} from './card-info.js';
import {nextStamp, restoreEntry, stableJson, stampEntry} from './merge.js';

// The ids the added copies take: the id the normal import would give a key
// (importEntryId), or, when an entry already holds it (the copy this
// removes, or an older tombstone), the id of the key with "|again|<n>" for
// the first free n, so two phones starting over from the same document
// still agree. Map import_key -> id.
export async function startOverIds(cards, entries) {
	const taken = new Set((cards || []).map((card) => card && card.id));
	const ids = new Map();

	for (const {import_key: key} of entries) {
		if (!key || ids.has(key)) {
			continue;
		}

		let id = await importEntryId(key);

		for (let n = 1; taken.has(id) && n < 100; n++) {
			id = await importEntryId(`${key}|again|${n}`);
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

const wantOf = (entry) => ({
	card_id: entry.card_id,
	catalog: entry.catalog || 'international',
	image: null,
	name: entry.name_local || null,
	variant_id: entry.variant_id || null,
});

const livePhotos = (record) => (Array.isArray(record.photos) ? record.photos : []).filter((photo) => photo && photo.id && !photo.deleted_at).length;

// What Start over does to `doc`, given the import's entries
// (js/monprice.js importEntries) and their ids (startOverIds). Returns
// {doc, counts, undo}: the changed copy, {removed, added, photos, pockets},
// and what planUndo needs. `doc` itself is not changed.
export function planStartOver(doc, entries, {ids = new Map(), now = Date.now()} = {}) {
	const next = structuredClone(doc);
	const removed = new Map();

	next.cards = (next.cards || []).map((entry) => {
		if (!entry || !isLive(entry) || isCustom(entry)) {
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
			pockets: turned.map((pocket) => ({...pocket, written: stableJson(pocketOf(changed.slots, pocket))})),
			staged: stableJson(changed.staged) === stableJson(binder.staged) ? null : {after: stagedOf(changed), before: stagedOf(binder)},
		});

		return changed;
	});

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

	// Photos on the card records the added copies show.
	const shown = new Set(added.map((entry) => infoKey(entry)));
	const photos = (next.card_info || []).filter((record) => record && isLive(record) && shown.has(record.id)).reduce((sum, record) => sum + livePhotos(record), 0);

	return {
		counts: {added: added.length, photos, pockets, removed: removed.size},
		doc: next,
		undo: {
			added: added.map((entry) => entry.id),
			binders: undoBinders,
			collections: undoCollections,
			picks: undoPicks,
			removed: [...removed.values()].map((entry) => ({deleted_at: entry.deleted_at, id: entry.id})),
		},
	};
}

// Undo for planStartOver: removed copies come back (js/merge.js
// restoreEntry) and added copies are removed, pockets, trays, picks, and
// collections go back to what they held, each only while it still holds
// what Start over wrote, so an edit another phone synced since stays. A
// pocket or tray holding an added copy by now is emptied, since that copy
// goes. Returns {doc, counts}; `doc` itself is not changed.
export function planUndo(doc, undo, {now = Date.now()} = {}) {
	const next = structuredClone(doc);
	const removedAt = new Map(undo.removed.map((item) => [item.id, item.deleted_at]));
	const added = new Set(undo.added);
	const counts = {added: 0, restored: 0};

	next.cards = (next.cards || []).map((entry) => {
		if (!entry) {
			return entry;
		}

		if (entry.deleted_at && removedAt.get(entry.id) === entry.deleted_at) {
			counts.restored++;

			return restoreEntry(entry, now);
		}

		if (added.has(entry.id) && isLive(entry)) {
			const at = nextStamp(entry.updated_at, now);

			counts.added++;

			return stampEntry(entry, {...entry, deleted_at: at, updated_at: at});
		}

		return entry;
	});

	const byBinder = new Map(undo.binders.map((item) => [item.id, item]));

	next.binders = (next.binders || []).map((binder) => {
		if (!binder || !liveBinders([binder]).length) {
			return binder;
		}

		const was = byBinder.get(binder.id);

		return editBinder(binder, now, (draft) => {
			const putBack = new Map();

			for (const pocket of (was && was.pockets) || []) {
				const slot = pocketOf(draft.slots, pocket);

				if (slot && stableJson(slot) === pocket.written) {
					putBack.set(slot, {entry_id: pocket.entry_id, page: pocket.page, placed_at: nextStamp(slot.placed_at, now), position: pocket.position});
				}
			}

			draft.slots = draft.slots
				.filter((slot) => !(slot && added.has(slot.entry_id)))
				.map((slot) => putBack.get(slot) || slot);

			if (was && was.staged && stableJson(stagedOf(draft)) === stableJson(was.staged.after)) {
				draft.staged = was.staged.before;
			}

			if (stagedOf(draft).some((id) => added.has(id))) {
				draft.staged = stagedOf(draft).filter((id) => !added.has(id));
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

	return {counts, doc: next};
}

// Saved: the preview, as Start over would do it now.
export async function previewStartOver(entries) {
	const doc = await loadDocument();
	const ids = await startOverIds(doc.cards, entries);

	return planStartOver(doc, entries, {ids}).counts;
}

// Saved: Start over in one save. Resolves {counts, undo}; on a failed write
// it rejects and the document on the phone is as it was.
export async function applyStartOver(entries) {
	const current = await loadDocument();
	const ids = await startOverIds(current.cards, entries);
	const {counts, doc, undo} = planStartOver(current, entries, {ids});

	await saveCopy(doc);

	return {counts, undo};
}

// Saved: Undo for applyStartOver, in one save. Resolves its counts.
export async function undoStartOver(undo) {
	const {counts, doc} = planUndo(await loadDocument(), undo);

	await saveCopy(doc);

	return counts;
}
