// Offering to delete the owner's photos of cards that have since gained an
// official image (DESIGN.md section 5, "Offer to delete photos once the
// catalog has an image"). The rules, with no page or storage of their own,
// so the unit tests run them in Node; js/photo-cleanup-view.js shows the
// notice and the Review sheet and hands these the real functions.
//
// A copy's photos are offered when its own language "gained" its image: the
// card index (js/catalog.js) recorded that language with no image, and the
// full TCGdex record in that language saved on the phone since (refreshed
// by My Cards' background pass, or by opening the card) has one. A French
// copy is never judged by the English art, and a Korean copy on a Japanese
// record (no Korean print in that catalog) is never offered. Only the
// person's own front photos already in the bucket (a path) are offered: a
// photo still waiting to upload takes no bucket space, Undo puts a photo
// back by its path, and the official image shows only the front, so a back
// photo still records the card's condition.

import {infoKey} from './card-info.js';
import {indexKey} from './catalog.js';
import {plural} from './format.js';
import {catalogFor, catalogLanguage} from './languages.js';
import {livePhotos} from './photos/model.js';

const catalogOf = (item) => item.catalog || 'international';

// The language whose saved record and card index localization stand for a
// copy's art, or null for a copy on another catalog's record (ko on ja).
export function ownLanguage(record) {
	const catalog = catalogOf(record);
	const lang = record.language || catalogLanguage(catalog);

	return catalogFor(lang) === catalog ? lang : null;
}

// The key a full TCGdex record is saved under on the phone (js/catalog.js
// importApi.cardDetail).
export const savedKey = (lang, cardId) => `card:${lang}:${cardId}`;

// The cards to offer, by name:
// [{key, card: {catalog, card_id, language}, lang, recordId, image, name,
//   photos: [{photo, pinned}]}]
// records: the person's card_info list; index: the card index Map; saved:
// the saved full records in each copy's own language, keyed by savedKey.
export function cleanupCandidates(records, index, saved) {
	const out = [];

	for (const record of records || []) {
		if (!record || record.deleted_at || !record.card_id) {
			continue;
		}

		const lang = ownLanguage(record);
		const photos = livePhotos(record).map(({photo}) => photo).filter((photo) => photo.path && photo.side !== 'back');

		if (!lang || !photos.length) {
			continue;
		}

		const known = index.get(indexKey(catalogOf(record), record.card_id));
		const local = known && (known.localizations || {})[lang];
		const full = saved.get(savedKey(lang, record.card_id));
		const image = full && typeof full.image === 'string' && full.image ? full.image : null;

		// No index record in that language: nothing says it ever lacked
		// its image.
		if (!local || local.image || !image) {
			continue;
		}

		out.push({
			card: {card_id: record.card_id, catalog: catalogOf(record), language: record.language || null},
			image,
			key: infoKey(record),
			lang,
			name: local.name || full.name || record.card_id,
			photos: photos.map((photo) => ({photo, pinned: record.main_image === photo.id})),
			recordId: record.id,
		});
	}

	return out.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

// The photo ids ticked when Review opens: every one but a pinned main image.
export const initialTicks = (candidates) => new Set(candidates.flatMap((item) => item.photos.filter((entry) => !entry.pinned).map((entry) => entry.photo.id)));

// The cards with a photo ticked from the start; a card whose offered photos
// are all pinned is listed in Review but not counted in the notice.
const tickedCards = (candidates) => candidates.filter((item) => item.photos.some((entry) => !entry.pinned));

// "5 cards now have official images. You can delete your 7 photos of them
// to save space."
export function noticeText(candidates) {
	const cards = tickedCards(candidates).length;
	const photos = initialTicks(candidates).size;
	const first = cards === 1 ? '1 card now has an official image.' : `${cards} cards now have official images.`;
	const yours = photos === 1 ? 'your photo' : `your ${photos} photos`;

	return `${first} You can delete ${yours} of ${cards === 1 ? 'it' : 'them'} to save space.`;
}

// ------------------------------------------------------------ Not now

// The cards already offered, per person, on this phone: Not now, Review
// closed, or Delete. The notice shows again only for a card not in it.
export const SEEN_KEY = 'card-tracker-photo-cleanup';

const seenKey = (userId) => `${SEEN_KEY}:${userId || 'local'}`;

export function readSeen(storage, userId) {
	try {
		const list = JSON.parse(storage.getItem(seenKey(userId)) || '[]');

		return new Set(Array.isArray(list) ? list : []);
	}
	catch {
		return new Set();
	}
}

export function rememberSeen(storage, userId, keys) {
	const seen = readSeen(storage, userId);

	for (const key of keys) {
		seen.add(key);
	}

	try {
		storage.setItem(seenKey(userId), JSON.stringify([...seen]));
	}
	catch {
		// Private mode: the notice may show again next time.
	}

	return seen;
}

export const shouldOffer = (candidates, seen) => tickedCards(candidates).some((item) => !seen.has(item.key));

// ------------------------------------------------------- Delete, Undo

// Removes the ticked photos through the normal removal (`remove`, which is
// js/photos/store.js removePhotoFromEntry: a tombstone, the pin cleared, and
// the bucket file deleted 14 days later; it resolves true when it removed
// the photo, false when another phone already had). readBlob(photoId) keeps
// the phone's copy for Undo. Stops at the first error. Returns
// {removed: [{card, photo, pinned, blob}], left: [{key, photo}], error}:
// removed holds only what this call removed, which is what Undo needs, and
// left the ticked photos not removed because of the error.
export async function deletePhotos(candidates, ticks, {readBlob = async () => null, remove}) {
	const todo = candidates.flatMap((item) => item.photos.filter((entry) => ticks.has(entry.photo.id)).map((entry) => ({...entry, item})));
	const removed = [];

	for (const [i, {item, photo, pinned}] of todo.entries()) {
		const blob = await Promise.resolve().then(() => readBlob(photo.id)).catch(() => null);

		try {
			if (await remove(item.recordId, photo.id)) {
				removed.push({blob, card: item.card, photo, pinned});
			}
		}
		catch (error) {
			return {error, left: todo.slice(i).map((entry) => ({key: entry.item.key, photo: entry.photo})), removed};
		}
	}

	return {error: null, left: [], removed};
}

// The toast after Delete: "Deleted 3 photos." and, when some failed,
// "2 could not be deleted."
export function deletedText({left, removed}) {
	const done = removed.length || !left.length ? `Deleted ${plural(removed.length, 'photo')}.` : 'Could not delete the photos.';

	return left.length && removed.length ? `${done} ${left.length} could not be deleted.` : done;
}

// Puts the removed photos back on their cards, each under a new id with the
// same file: a tombstone wins every merge (js/photos/model.js
// mergePhotoLists), so the old id cannot come back once a sync carried it,
// while a live photo at the same path cancels the queued bucket delete
// (bucketDeleteState). A pinned photo is pinned again when nothing else
// was pinned since. update is js/collection.js updateCardInfo.
export async function undoDelete(removed, {newId, saveBlob = async () => {}, update}) {
	const byCard = new Map();

	for (const item of removed) {
		const key = infoKey(item.card);

		if (!byCard.has(key)) {
			byCard.set(key, {card: item.card, items: []});
		}

		byCard.get(key).items.push({...item, id: newId()});
	}

	for (const group of byCard.values()) {
		for (const item of group.items) {
			if (item.blob) {
				await saveBlob(item.id, item.blob).catch(() => {});
			}
		}
	}

	await update([...byCard.values()].map((group) => group.card), (record) => {
		const group = byCard.get(infoKey(record));

		if (!group) {
			return null;
		}

		const photos = [...(Array.isArray(record.photos) ? record.photos : []), ...group.items.map((item) => ({...item.photo, deleted_at: null, id: item.id}))];
		const pin = group.items.find((item) => item.pinned);

		return pin && !record.main_image ? {main_image: pin.id, photos} : {photos};
	});

	return [...byCard.values()].flatMap((group) => group.items.map((item) => item.id));
}

// The card index records that give each card about to lose its photos its
// official image, so its tile shows it rather than a card back: only the
// localization of the copy's own language, and only while it has none.
// cards: the cards ({catalog, card_id, language}) with a ticked photo.
export function indexImages(candidates, index, cards) {
	const keys = new Set(cards.map((card) => infoKey(card)));
	const byCard = new Map();

	for (const item of candidates) {
		const key = indexKey(item.card.catalog, item.card.card_id);
		const known = index.get(key);
		const local = known && (known.localizations || {})[item.lang];

		if (!keys.has(item.key) || !local || local.image) {
			continue;
		}

		if (!byCard.has(key)) {
			byCard.set(key, {catalog: item.card.catalog, id: item.card.card_id, localizations: {}});
		}

		byCard.get(key).localizations[item.lang] = {...local, image: item.image};
	}

	return [...byCard.values()];
}
