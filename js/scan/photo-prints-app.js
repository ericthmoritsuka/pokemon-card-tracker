// The app's side of js/scan/photo-prints.js: reads the owner's card records
// and the family's shared photo lists (js/photos/shared.js) with their
// photos, keeps each photo's print on the phone, and hands the prints to
// the picture matcher (js/scan/identify.js setPhotoPrints). Scan
// calls refreshPhotoPrints once its picture index is in (js/scan/view.js
// startEngine), so opening Scan never waits for it: until it is done, the
// capture is matched against the index alone, as before.

import {cardInfoList} from '../collection.js';
import {onSharedPhotosChange, sharedPhotoRecords, sharedReady} from '../photos/shared.js';
import {photoUrl} from '../photos/store.js';
import {setPhotoPrints} from './identify.js';
import {photoPrintEntries} from './photo-prints.js';
import {loadIndexNames} from './picture.js';

// {photoId: print} on this phone: a photo is decoded once.
const PRINTS_KEY = 'card-tracker:photo-prints';

function readCache() {
	try {
		const value = JSON.parse(localStorage.getItem(PRINTS_KEY) || '{}');

		return value && typeof value === 'object' ? value : {};
	}
	catch {
		return {};
	}
}

function writeCache(cache, live) {
	try {
		// Only the prints of photos still in use are kept.
		localStorage.setItem(PRINTS_KEY, JSON.stringify(Object.fromEntries(Object.entries(cache).filter(([id]) => live.has(id)))));
	}
	catch {
		// Not kept: the next visit decodes the photos again.
	}
}

// A photo's straightened pixels, or null when the phone cannot get it now.
async function pixelsOf(photo) {
	const url = await photoUrl(photo);

	if (!url) {
		return null;
	}

	const bitmap = await createImageBitmap(await (await fetch(url)).blob());
	const canvas = document.createElement('canvas');

	canvas.width = bitmap.width;
	canvas.height = bitmap.height;

	const ctx = canvas.getContext('2d', {willReadFrequently: true});

	ctx.drawImage(bitmap, 0, 0);
	bitmap.close();

	return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

let running = null;
let following = false;

// How long a refresh waits for the family's photo lists to load from the
// phone before going on with the owner's photos alone.
const FAMILY_WAIT_MS = 3000;

// Collects the prints, of the owner's photos and the family's, and hands
// them to the matcher; a call while one is running waits for it. After the
// first call, a change to the family's photo lists collects them again.
// Resolves with how many prints were handed over.
export function refreshPhotoPrints() {
	if (!following) {
		following = true;
		onSharedPhotosChange(() => refreshPhotoPrints());
	}

	running = (running || Promise.resolve()).then(async () => {
		await Promise.race([sharedReady().catch(() => {}), new Promise((resolve) => setTimeout(resolve, FAMILY_WAIT_MS))]);

		const table = await loadIndexNames();
		// The index's cards as "<catalog>|<id>". With no names table, every
		// card counts as in the index: no photo is taken for a card it may hold.
		const held = table ? new Set(Object.entries(table.cards).flatMap(([key, cards]) => Object.keys(cards).map((id) => `${key.split('|')[0]}|${id}`))) : null;
		const inIndex = (catalog, id) => !held || held.has(`${catalog}|${id}`);
		const {cache, entries} = await photoPrintEntries({cache: readCache(), imageOf: pixelsOf, inIndex, records: [...cardInfoList(), ...sharedPhotoRecords()]});

		writeCache(cache, new Set(entries.map((entry) => entry.photoId)));
		setPhotoPrints(entries);

		return entries.length;
	}).catch(() => 0);

	return running;
}
