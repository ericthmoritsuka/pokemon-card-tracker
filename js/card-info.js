// Photos, notes, and the main-image pin belong to the card, not the copy
// (DESIGN.md section 3, "Photos and notes belong to the card, not the copy";
// Eric, 2026-10-22 and 2026-10-30). Pure functions over one person's
// document, so Node tests them (tests/card-info.test.mjs).
//
// The document's top-level list card_info holds one record per card and
// language, its id from infoKey:
//
//   {id, catalog, card_id, language, photos, notes, main_image,
//    created_at, updated_at, deleted_at, field_stamps}
//
// photos and main_image have the shape copies used to carry
// (js/photos/model.js), so the carousel and tile functions take records
// where they took copies. It merges like every other list (js/merge.js):
// field by field, photos joined by id. Records are never deleted: a card at
// zero copies keeps its photos and notes.
//
// Moving the old per-copy fields (moveToCardInfo) runs on every load, save,
// and merge, not once, because a phone still on v47 keeps writing them:
//   - A copy's photo joins its card's record. Once the record holds it with
//     its uploaded path, the copy's photo becomes a tombstone marked moved,
//     so a v47 phone neither shows it nor, when the copy is deleted, queues
//     its bucket file for deletion (v47 only deletes the files of live
//     photos on deleted copies). A photo still waiting to upload stays live
//     on its copy until the path is known, so the v47 phone that took it
//     still uploads it. A photo a v47 phone removed (a tombstone not marked
//     moved) is removed from the record too.
//   - A copy's note joins the record's notes, newest first, unless the
//     record already holds that text, and the copy's note is cleared.
//   - A copy's pin becomes the record's pin when it is newer, and is cleared.
// Every stamp is one millisecond after what it replaces, never the clock,
// so two phones that move the same copies get the same versions.
//
// Notes from two phones that each moved different copies before syncing
// would otherwise lose one side by the clock: while a record's notes came
// only from copies (notes_source 'copies'), two different versions join
// (mergeCardInfo). A note typed on the card clears notes_source.

import {mergePhotoLists, photoIndexKey} from './photos/model.js';
import {stampMs} from './stamp.js';
import {mergeEntry, stampEntry} from './merge.js';

export const CARD_INFO = 'card_info';

// The record id for a card in one language: catalog~card_id~language.
export const infoKey = photoIndexKey;

const time = (value) => stampMs(value);

const isLive = (item) => Boolean(item) && !item.deleted_at;

const catalogOf = (item) => (item && item.catalog) || 'international';

// One millisecond after the latest of the stamps, never the clock.
function after(...stamps) {
	const known = stamps.map(time).filter(Number.isFinite);

	return new Date((known.length ? Math.max(...known) : 0) + 1).toISOString();
}

// ------------------------------------------------------------- notes

const paragraphs = (text) => String(text || '').split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);

// True when every paragraph of text is already in notes.
export function holdsNote(notes, text) {
	const have = new Set(paragraphs(notes));
	const want = paragraphs(text);

	return want.length > 0 && want.every((part) => have.has(part));
}

// The notes with each text not already held put first, in the order given.
export function joinNotes(notes, texts) {
	const added = [];

	for (const text of texts) {
		const clean = String(text || '').trim();

		if (clean && !holdsNote([...added, notes].join('\n\n'), clean)) {
			added.push(clean);
		}
	}

	return [...added, String(notes || '').trim()].filter(Boolean).join('\n\n');
}

// --------------------------------------------------------------- records

export function newRecord(item, at) {
	return {
		card_id: item.card_id,
		catalog: catalogOf(item),
		created_at: at,
		deleted_at: null,
		id: infoKey(item),
		language: item.language || '',
		photos: [],
		updated_at: at,
	};
}

const fieldStampOf = (entry, key) => {
	const stamps = entry && entry.field_stamps;
	const own = stamps && typeof stamps === 'object' ? stamps[key] : null;

	return own || (entry && (entry.updated_at || entry.created_at)) || null;
};

// A photo as the record keeps it: the copy's, without the moved mark.
function asRecordPhoto(photo) {
	const {moved: _moved, ...rest} = photo;

	return rest;
}

// The move for one card and language: the record (or null) and its copies.
// Returns {record, copies} with only what changed, or null.
function moveGroup(record, copies) {
	let photos = record ? (Array.isArray(record.photos) ? record.photos : []) : [];
	let notes = record ? record.notes || '' : '';
	let pin = record ? record.main_image : undefined;
	let pinFrom = record ? fieldStampOf(record, 'main_image') : null;
	const texts = [];

	// Photos first, from every copy, so the tombstones below see the paths.
	for (const copy of copies) {
		for (const photo of Array.isArray(copy.photos) ? copy.photos : []) {
			if (!photo || !photo.id || photo.moved) {
				continue;
			}

			const held = photos.find((item) => item && item.id === photo.id);

			// A removed photo the record never held stays out of it.
			if (photo.deleted_at && !held) {
				continue;
			}

			photos = mergePhotoLists(photos, [asRecordPhoto(photo)]);
		}
	}

	const newestFirst = [...copies].sort((a, b) => time(fieldStampOf(b, 'notes')) - time(fieldStampOf(a, 'notes')) || String(a.id).localeCompare(String(b.id)));

	for (const copy of newestFirst) {
		if (typeof copy.notes === 'string' && copy.notes.trim()) {
			texts.push(copy.notes);
		}

		if (copy.main_image && time(fieldStampOf(copy, 'main_image')) > time(pinFrom)) {
			pin = copy.main_image;
			pinFrom = fieldStampOf(copy, 'main_image');
		}
	}

	notes = joinNotes(notes, texts);

	const byId = new Map(photos.map((photo) => [photo.id, photo]));
	const changedCopies = [];

	for (const copy of copies) {
		let copyChanged = false;
		const next = {...copy};

		if (Array.isArray(copy.photos)) {
			next.photos = copy.photos.map((photo) => {
				const held = photo && photo.id && !photo.moved && !photo.deleted_at ? byId.get(photo.id) : null;

				if (held && (held.deleted_at || held.path)) {
					copyChanged = true;

					return {...photo, deleted_at: held.deleted_at || after(copy.updated_at), moved: true};
				}

				return photo;
			});
		}

		if (typeof copy.notes === 'string' && copy.notes.trim()) {
			next.notes = null;
			copyChanged = true;
		}

		if (copy.main_image) {
			next.main_image = null;
			copyChanged = true;
		}

		if (copyChanged) {
			const at = after(copy.updated_at);

			changedCopies.push(stampEntry(copy, {...next, updated_at: at}, {at}));
		}
	}

	const was = record || {};
	const sameRecord = record
		&& JSON.stringify(photos) === JSON.stringify(was.photos || [])
		&& notes === (was.notes || '')
		&& (pin || null) === (was.main_image || null);

	if (sameRecord && !changedCopies.length) {
		return null;
	}

	// Nothing to keep yet (only photos removed before the move): no record.
	if (!record && !photos.length && !notes && !pin) {
		return changedCopies.length ? {copies: changedCopies, record: null} : null;
	}

	let nextRecord = null;

	if (!sameRecord) {
		const at = after(was.updated_at, ...copies.map((copy) => copy.updated_at));
		const base = record || newRecord(copies[0], at);
		const body = {...base, photos};

		if (notes) {
			body.notes = notes;
		}
		else {
			delete body.notes;
		}

		if (pin) {
			body.main_image = pin;
		}
		else {
			delete body.main_image;
		}

		if (!record || (record.notes_source === 'copies' && notes !== (was.notes || '')) || (!was.notes && notes)) {
			body.notes_source = 'copies';
		}

		nextRecord = record ? stampEntry(record, {...body, updated_at: at}, {at}) : {...body, updated_at: at};
	}

	return {copies: changedCopies, record: nextRecord};
}

// Moves the per-copy photos, notes, and pins in `doc` onto card_info, in
// place: doc.cards and doc.card_info become new arrays when anything moved,
// and no entry object is changed. Returns true when anything changed.
export function moveToCardInfo(doc) {
	if (!doc || typeof doc !== 'object' || !Array.isArray(doc.cards)) {
		return false;
	}

	const groups = new Map();

	for (const copy of doc.cards) {
		if (!copy || !copy.id || !copy.card_id) {
			continue;
		}

		const carries = (Array.isArray(copy.photos) && copy.photos.some((photo) => photo && photo.id && !photo.moved))
			|| (typeof copy.notes === 'string' && copy.notes.trim())
			|| Boolean(copy.main_image);

		if (!carries) {
			continue;
		}

		const key = infoKey(copy);

		if (!groups.has(key)) {
			groups.set(key, []);
		}

		groups.get(key).push(copy);
	}

	if (!groups.size) {
		return false;
	}

	const records = Array.isArray(doc[CARD_INFO]) ? [...doc[CARD_INFO]] : [];
	const at = new Map(records.map((record, i) => [record && record.id, i]));
	const replace = new Map();
	let changed = false;

	for (const [key, copies] of groups) {
		const i = at.has(key) ? at.get(key) : -1;
		const moved = moveGroup(i >= 0 ? records[i] : null, copies);

		if (!moved) {
			continue;
		}

		changed = true;

		if (moved.record) {
			if (i >= 0) {
				records[i] = moved.record;
			}
			else {
				at.set(key, records.length);
				records.push(moved.record);
			}
		}

		for (const copy of moved.copies) {
			replace.set(copy.id, copy);
		}
	}

	if (!changed) {
		return false;
	}

	doc[CARD_INFO] = records;

	if (replace.size) {
		doc.cards = doc.cards.map((copy) => (copy && replace.get(copy.id)) || copy);
	}

	return true;
}

// A copy of `doc` with the move made, for a family member's document read
// only: `doc` itself is not changed.
export function cardInfoView(doc) {
	if (!doc || typeof doc !== 'object') {
		return doc;
	}

	const out = {...doc};

	moveToCardInfo(out);

	return out;
}

// Merges two versions of one record: as every entry (js/merge.js), except
// that two versions whose notes both came only from copies join their
// notes, so two phones that each moved a different copy's note keep both.
export function mergeCardInfo(a, b) {
	const out = mergeEntry(a, b);

	if (!isLive(out) || !isLive(a) || !isLive(b) || a.notes_source !== 'copies' || b.notes_source !== 'copies' || (a.notes || '') === (b.notes || '')) {
		return out;
	}

	const first = (out.notes || '') === (a.notes || '') ? a : b;
	const other = first === a ? b : a;
	const notes = joinNotes(first.notes, [other.notes]);

	if (notes === (out.notes || '')) {
		return out;
	}

	const stamp = after(a.updated_at, b.updated_at, out.updated_at);
	const stamps = out.field_stamps && typeof out.field_stamps === 'object' ? out.field_stamps : {since: out.created_at || stamp};

	return {...out, field_stamps: {...stamps, at: stamp, notes: stamp}, notes, notes_source: 'copies', updated_at: stamp};
}

// ------------------------------------------------------------- lookups

// The live records of one card (catalog and card_id), any language.
export function recordsOfCard(records, card) {
	return (Array.isArray(records) ? records : []).filter((record) => isLive(record)
		&& record.card_id === card.card_id && catalogOf(record) === catalogOf(card));
}

const hasLivePhoto = (record) => Array.isArray(record.photos) && record.photos.some((photo) => isLive(photo) && photo.id);

// The records whose photos and pin show for a card, in the given languages
// (the languages of its copies, or the page's): those languages' records,
// and when none of them has a photo, the other languages' records that do
// (a language without its own photo shows another's). With no language
// given, every record of the card.
export function shownRecords(records, card, languages = []) {
	const all = recordsOfCard(records, card);
	const wanted = new Set((languages || []).map((language) => language || ''));

	if (!wanted.size) {
		return all;
	}

	const same = all.filter((record) => wanted.has(record.language || ''));

	if (same.some(hasLivePhoto)) {
		return same;
	}

	return [...same, ...all.filter((record) => !wanted.has(record.language || '') && hasLivePhoto(record))];
}

// The records for a group of copies (a tile, a card page's copies).
export function recordsForCopies(records, copies) {
	const live = (Array.isArray(copies) ? copies : [copies]).filter((copy) => isLive(copy) && copy.card_id);

	if (!live.length) {
		return [];
	}

	return shownRecords(records, live[0], [...new Set(live.map((copy) => copy.language || ''))]);
}

// The record of one card and language in `records`, or null.
export function recordOf(records, item) {
	const key = infoKey(item);

	return (Array.isArray(records) ? records : []).find((record) => record && record.id === key) || null;
}

// The record holding photo `photoId`, live first, or null.
export function recordWithPhoto(records, photoId) {
	let found = null;

	for (const record of Array.isArray(records) ? records : []) {
		const photo = record && Array.isArray(record.photos) ? record.photos.find((item) => item && item.id === photoId) : null;

		if (photo && (!found || !photo.deleted_at)) {
			found = record;

			if (!photo.deleted_at) {
				break;
			}
		}
	}

	return found;
}
