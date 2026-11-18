// The scanner learns cards from the family's own photos (Eric, 2026-11-18,
// v79): a card the catalog has no picture of (every MEP Black Star Promo,
// 30th Classic Collection, most Korean prints) is not in the fingerprint
// index (js/vision/index.bin is built from TCGdex's images), so the picture
// route could never find it and every scan of it read its text, 5 to 10 s
// on Eric's phone. A photo the owner took of it (js/photos, a straightened
// 600 x 840 card) is fingerprinted the way build-index.mjs fingerprints a
// catalog image, and the scanner matches the capture against those prints
// beside the index (js/scan/picture.js matchCrops).
//
// Only cards missing from the index count, so a photo never competes with
// a catalog picture that already works. Each photo's print is kept on the
// phone (PRINTS_KEY), so a photo is decoded once; a photo the phone cannot
// get right now (offline, not uploaded) is left out and tried again later.
//
// describeCard and buildPhotoIndex are pure (tests/photo-prints.test.mjs);
// photoPrintEntries takes its reads as arguments, so Node tests it too.

import {ART, colorLayout, FACE, phash, thumbnail} from '../vision/fingerprint.js';
import {packIndex, unpackIndex} from '../vision/pack.js';

// What build-index.mjs keeps per card (its FIELDS): the 128-bit art-box
// hash, the 128-bit whole-card hash, and the colour layout of the art box.
const FIELDS = {art: {bytes: 16, type: 'u32'}, card: {bytes: 16, type: 'u32'}, color: {bytes: 16, type: 'i8'}};

// A straightened card (ImageData-shaped) as the index describes a catalog
// image: lab/fingerprints/harness.js record() on its thumbnail.
export function describeCard(img) {
	const thumb = thumbnail(img);

	return {art: phash(thumb, ART, 128), card: phash(thumb, FACE, 128), color: colorLayout(thumb, ART)};
}

// A print as 48 bytes in base64, for the phone's cache, and back.
export function encodePrint({art, card, color}) {
	const bytes = new Uint8Array(48);

	bytes.set(new Uint8Array(art.buffer, art.byteOffset, 16), 0);
	bytes.set(new Uint8Array(card.buffer, card.byteOffset, 16), 16);
	bytes.set(new Uint8Array(color.buffer, color.byteOffset, 16), 32);

	return btoa(String.fromCharCode(...bytes));
}

export function decodePrint(text) {
	try {
		const bytes = Uint8Array.from(atob(String(text)), (ch) => ch.charCodeAt(0));

		if (bytes.length !== 48) {
			return null;
		}

		return {art: new Uint32Array(bytes.buffer.slice(0, 16)), card: new Uint32Array(bytes.buffer.slice(16, 32)), color: new Int8Array(bytes.buffer.slice(32, 48))};
	}
	catch {
		return null;
	}
}

// The prints ([{id, catalog, set, art, card, color}]) as an index the
// matcher reads (js/vision/pack.js), with the main index's weights; the
// photos of one card share an artwork group. null when there are none.
export function buildPhotoIndex(entries, {weights}) {
	if (!entries || !entries.length) {
		return null;
	}

	const catalogs = [...new Set(entries.map((entry) => entry.catalog))];
	const sets = [...new Set(entries.map((entry) => entry.set))];
	const localIds = [];
	const oddIds = {};
	const groupOf = new Map();
	const cards = entries.map((entry, i) => {
		const prefix = `${entry.set}-`;

		if (entry.id.startsWith(prefix)) {
			localIds.push(entry.id.slice(prefix.length));
		}
		else {
			localIds.push('');
			oddIds[i] = entry.id;
		}

		const key = `${entry.catalog}|${entry.id}`;

		if (!groupOf.has(key)) {
			groupOf.set(key, i);
		}

		return {art: entry.art, card: entry.card, catalog: catalogs.indexOf(entry.catalog), color: entry.color, flags: 0, group: groupOf.get(key), set: sets.indexOf(entry.set)};
	});

	return unpackIndex(packIndex({cards, fields: FIELDS, header: {built: new Date(0).toISOString(), catalogs, fields: FIELDS, localIds: localIds.join('|'), oddIds, series: sets.map(() => ''), sets, source: 'the family\'s photos', version: 1, weights}}));
}

// The main index's answer with the photo index's merged in: every group by
// score, the best `top` kept. A photo's card has no catalog picture (image
// null: the tray shows the photo, js/photos tileSrc) and is marked photo;
// a card with several photos is one card in its group.
export function mergePhotoMatches(main, photos, top = 5) {
	if (!photos || !photos.groups || !photos.groups.length) {
		return main;
	}

	const fromPhotos = photos.groups.map((group) => {
		const seen = new Set();

		return {...group, cards: group.cards.filter((card) => !seen.has(card.id) && seen.add(card.id)).map((card) => ({...card, image: null, photo: true}))};
	});

	return {...main, groups: [...main.groups, ...fromPhotos].sort((a, b) => a.score - b.score).slice(0, top)};
}

// The catalog an index entry is in, for a card record's catalog
// (js/catalog.js catalogFor: Western prints share the international one).
const indexCatalog = (catalog) => (catalog === 'international' ? 'en' : catalog);

// The set of a card id: everything before its last hyphen
// (js/pokemon-cards.js setIdOf without the known sets).
const setOfId = (id) => {
	const text = String(id);
	const cut = text.lastIndexOf('-');

	return cut > 0 ? text.slice(0, cut) : text;
};

// The prints of the family's photos of cards missing from the index.
// records: js/collection.js cardInfoList (and family records, when given),
// each {card_id, catalog, photos: [{id, side, deleted_at}], deleted_at};
// inIndex(catalog, id): whether the index holds the card; imageOf(photo):
// its straightened pixels, or null when the phone cannot get them now;
// cache: {photoId: encodePrint text}, read and filled in. Returns
// {entries, cache}.
export async function photoPrintEntries({cache = {}, imageOf, inIndex, records}) {
	const entries = [];
	const kept = {...cache};
	const live = (item) => item && !item.deleted_at;

	for (const record of records || []) {
		if (!live(record) || !record.card_id || !record.catalog || record.catalog === 'custom') {
			continue;
		}

		const catalog = indexCatalog(record.catalog);

		if (inIndex(catalog, record.card_id)) {
			continue;
		}

		for (const photo of record.photos || []) {
			if (!live(photo) || (photo.side && photo.side !== 'front')) {
				continue;
			}

			let print = kept[photo.id] ? decodePrint(kept[photo.id]) : null;

			if (!print) {
				const img = await imageOf(photo).catch(() => null);

				if (!img) {
					continue;
				}

				print = describeCard(img);
				kept[photo.id] = encodePrint(print);
			}

			entries.push({...print, catalog, id: record.card_id, photoId: photo.id, set: setOfId(record.card_id)});
		}
	}

	return {cache: kept, entries};
}
