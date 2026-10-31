// Offering to delete the owner's photos of cards that have since gained an
// official image (DESIGN.md section 5, "Offer to delete photos once the
// catalog has an image"). The rules, with no page or storage of their own,
// so the unit tests run them in Node; js/photo-cleanup-view.js shows the
// notice and the Review sheet and hands these the real functions.
//
// A card "gained" its image when the card index (js/catalog.js) recorded it
// with no image in any language, and the full TCGdex record saved on the
// phone since (refreshed by My Cards' background pass, or by opening the
// card) has one. Only the person's own photos already in the bucket (a
// path) are offered: a photo still waiting to upload takes no bucket space,
// and Undo puts a photo back by its path.

import {infoKey} from './card-info.js';
import {indexKey} from './catalog.js';
import {livePhotos} from './photos/model.js';

const catalogOf = (item) => item.catalog || 'international';

// The index record had an image in some language.
const hadImage = (record) => Object.values((record && record.localizations) || {}).some((local) => local && local.image);

// The cards to offer, by name:
// [{key, card: {catalog, card_id, language}, recordId, image, name,
//   photos: [{photo, pinned}]}]
// records: the person's card_info list; index: the card index Map;
// saved: savedCardRecords() for those records, keyed "<catalog>|<card id>".
export function cleanupCandidates(records, index, saved) {
	const out = [];

	for (const record of records || []) {
		if (!record || record.deleted_at || !record.card_id) {
			continue;
		}

		const photos = livePhotos(record).map(({photo}) => photo).filter((photo) => photo.path);

		if (!photos.length) {
			continue;
		}

		const key = indexKey(catalogOf(record), record.card_id);
		const known = index.get(key);
		const full = saved.get(key);
		const image = full && typeof full.image === 'string' && full.image ? full.image : null;

		// No index record: nothing says the card ever lacked its image.
		if (!known || hadImage(known) || !image) {
			continue;
		}

		const local = (known.localizations || {})[record.language] || Object.values(known.localizations || {})[0] || {};

		out.push({
			card: {card_id: record.card_id, catalog: catalogOf(record), language: record.language || null},
			image,
			key: infoKey(record),
			name: local.name || full.name || record.card_id,
			photos: photos.map((photo) => ({photo, pinned: record.main_image === photo.id})),
			recordId: record.id,
		});
	}

	return out.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

export const photoCount = (candidates) => candidates.reduce((sum, item) => sum + item.photos.length, 0);

// "5 cards now have official images. You can delete your 7 photos of them
// to save space."
export function noticeText(candidates) {
	const cards = candidates.length;
	const photos = photoCount(candidates);
	const first = cards === 1 ? '1 card now has an official image.' : `${cards} cards now have official images.`;
	const yours = photos === 1 ? 'your photo' : `your ${photos} photos`;

	return `${first} You can delete ${yours} of ${cards === 1 ? 'it' : 'them'} to save space.`;
}

// The photo ids ticked when Review opens: every one but a pinned main image.
export const initialTicks = (candidates) => new Set(candidates.flatMap((item) => item.photos.filter((entry) => !entry.pinned).map((entry) => entry.photo.id)));

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

export const shouldOffer = (candidates, seen) => candidates.some((item) => !seen.has(item.key));

// ------------------------------------------------------- Delete, Undo

// Removes the ticked photos through the normal removal (`remove`, which is
// js/photos/store.js removePhotoFromEntry: a tombstone, the pin cleared, and
// the bucket file deleted 14 days later). readBlob(photoId) keeps the
// phone's copy for Undo. Returns what Undo needs:
// [{card, photo, pinned, blob}].
export async function deletePhotos(candidates, ticks, {readBlob = async () => null, remove}) {
	const removed = [];

	for (const item of candidates) {
		for (const {photo, pinned} of item.photos) {
			if (!ticks.has(photo.id)) {
				continue;
			}

			const blob = await readBlob(photo.id).catch(() => null);

			await remove(item.recordId, photo.id);
			removed.push({blob, card: item.card, photo, pinned});
		}
	}

	return removed;
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

// The card index records that give each deleted card its official image,
// so its tile shows it rather than a card back: every language the index
// holds with no image takes the saved one.
export function indexImages(candidates, index, deletedCards) {
	const keys = new Set(deletedCards.map((card) => indexKey(catalogOf(card), card.card_id)));
	const records = [];

	for (const item of candidates) {
		const key = indexKey(item.card.catalog, item.card.card_id);
		const known = index.get(key);

		if (!keys.has(key) || !known) {
			continue;
		}

		keys.delete(key);

		const localizations = {};

		for (const [lang, local] of Object.entries(known.localizations || {})) {
			if (local && !local.image) {
				localizations[lang] = {...local, image: item.image};
			}
		}

		records.push({catalog: item.card.catalog, id: item.card.card_id, localizations});
	}

	return records;
}
