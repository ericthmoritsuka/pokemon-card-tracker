// The owner's card photos and the image carousel: what card detail
// (js/catalog-views.js) and the tiles (js/cards-view.js) import.
//
//   cardPhotos({cardId, catalog})   card detail's image block: the carousel
//                                   with "Use as main image" and "Add photo"
//   photoCarousel(...)              the carousel alone (carousel.js)
//   addPhotoButton(...)             the Add photo button alone
//   mainImage(entry, catalogImage)  what a tile should draw (model.js)
//   tileSrc, withMainPhoto, mainArt the same for every screen that draws a
//                                   card (js/tile.js cardTile, tileArt,
//                                   cardArt): the URL to pass, then the
//                                   photo filled in when it was not in
//                                   memory yet (a family member's photo
//                                   when the card has no image at all,
//                                   shared.js)
//   onImagesChange(listener)        tells a screen which cards' images a
//                                   save or a twin changed
//   startPhotoSync()                the upload queue and photo restore
//   photoSettingsCard()             Profile's "Keep a detail copy of new
//                                   photos" switch, for this phone
//
// Each of the owner's photos on card detail also gets Adjust (DESIGN.md
// section 5, "Adjust a photo"): adjust-view.js is the sheet, adjust.js the
// pixel work, and saveAdjustedPhoto below puts the result in the photo's
// place, with Undo edit on a toast.
//
// DESIGN.md section 5 ("Own photos, cropped to the card" and "Image
// carousel per card") is the spec; supabase/photos.sql makes the bucket.

import {mainImageOf, shownRecords} from '../card-info.js';
import {loadTwins, onTwinsChange, twinSlides} from '../twins.js';
import {cardInfoList, listCards, loadDocument, newId, nowIso, onChange, updateCardInfo} from '../collection.js';
import {errorText, h} from '../dom.js';
import {formatCount} from '../format.js';
import {languageLabel} from '../languages.js';
import {UNDO_MS} from '../reorder.js';
import {toast} from '../shell.js';

import {applyAdjust} from './adjust.js';
import {openAdjustPhoto} from './adjust-view.js';
import {SWIPE_EVENT, gestureConsumed, isCarouselGesture, openViewer, photoCarousel} from './carousel.js';
import {describeCopy, openAddPhoto} from './editor.js';
import {
	DETAIL_HEIGHT,
	DETAIL_MAX_BYTES,
	DETAIL_SOURCE_SIDE,
	DETAIL_WIDTH,
	TARGET_BYTES,
	canvasOf,
	decodeImageFile,
	encodeDetail,
	encodePhoto,
	pixelsOf,
	putPixels,
} from './encode.js';
import {gallerySlides, mainImage, mainSlideId, newPhoto, photoPath, pinnedImage} from './model.js';
import {
	addPhotoToCard,
	cachedPhotoUrl,
	detailKey,
	detailUrl,
	keepDetailCopies,
	localPhoto,
	onPhotosChange,
	pendingUploads,
	photoUrl,
	removePhotoFromEntry,
	replacePhoto,
	setKeepDetailCopies,
	startPhotoSync,
	undoReplacePhoto,
	uploadProblems,
	waitingText,
} from './store.js';
import {onSharedPhotosChange, sharedPhotosFor, sharedReady, sharedSettled, startSharedPhotos} from './shared.js';

export {
	SWIPE_EVENT,
	gestureConsumed,
	isCarouselGesture,
	keepDetailCopies,
	mainImage,
	openViewer,
	photoCarousel,
	setKeepDetailCopies,
	startPhotoSync,
};

// The same detection and straightening, for the scanner to give scanned
// cards their photo (DESIGN.md section 5).
export {detectCorners} from './detect.js';
export {encodePhoto, straighten} from './encode.js';

// The card a group of copies is (or a card with no copy, as tileSrc takes
// it), for the family's photos of it and its twin.
function cardOf(entries, fallback = {}) {
	const entry = (Array.isArray(entries) ? entries : [entries]).find((item) => item && !item.deleted_at && item.card_id);

	return entry ? {card_id: entry.card_id, catalog: entry.catalog, language: entry.language || ''} : fallback;
}

// The family's photos of the copies' card, or none when `family` is off
// (a family member's read-only cards). A function for mainImage, which
// calls it only when the card has no official image, twin, or own photo,
// so most tiles never look the family's photos up.
function familyFor(entries, family) {
	if (!family) {
		return [];
	}

	const card = cardOf(entries, null);

	if (!card) {
		return [];
	}

	startSharedPhotos();

	return () => sharedPhotosFor(card);
}

// A card-shaped image with no names, for callers that pass no art function.
function plainArt(src) {
	const frame = h('div', {class: 'art'});

	frame.append(src
		? h('img', {alt: '', decoding: 'async', src})
		: h('div', {class: 'card-back'}, h('span', {class: 'card-back-status'}, 'No image')));

	return frame;
}

// Saves a straightened photo onto a card in one language (entry: a record,
// a copy, or {catalog, card_id, language}; js/card-info.js): on the phone at
// once, uploaded when there is signal (store.js). detail, when given, is the
// detail copy {blob, type, width, height}. Resolves with the new photo
// record. Its folder in the bucket is its own id.
export async function savePhoto({blob, detail = null, entry, side = 'front', type}) {
	const photo = await photoRecord({detail, side, type: type || blob.type});

	await addPhotoToCard(entry, photo, blob, photo.detail ? detail.blob : null);

	return photo;
}

// A new photo record with a fresh id, its folder in the bucket its own id.
async function photoRecord({created_at = nowIso(), detail = null, side = 'front', type}) {
	const doc = await loadDocument();
	const id = newId();

	return newPhoto({
		created_at,
		detail: detail && detail.blob ? {height: detail.height, type: detail.type || detail.blob.type, width: detail.width} : null,
		id,
		path: doc.user_id ? photoPath(doc.user_id, id, id, type) : null,
		side,
	});
}

// ------------------------------------------------------------- adjust

// A photo's file (its detail copy with key detailKey(id)) as a Blob: from
// the phone, or from the bucket through the url the store resolves. Null
// when it cannot be had now (offline and never on this phone).
async function photoBlob(key, urlPromise) {
	const url = await urlPromise;

	if (!url) {
		return null;
	}

	const local = await localPhoto(key).catch(() => null);

	if (local) {
		return local;
	}

	const response = await fetch(url);

	return response.ok ? response.blob() : null;
}

// The old photo's detail copy with the same settings, encoded as a detail
// copy, or null when it could not be loaded.
async function adjustedDetail(old, settings) {
	const blob = await photoBlob(detailKey(old.id), detailUrl(old)).catch(() => null);

	if (!blob) {
		return null;
	}

	const source = await decodeImageFile(blob, DETAIL_SOURCE_SIDE);
	const canvas = canvasOf(source.width, source.height);

	putPixels(canvas, applyAdjust(pixelsOf(source), settings));

	const encoded = await encodeDetail(canvas);

	return {blob: encoded.blob, height: encoded.height, type: encoded.type, width: encoded.width};
}

// Saves an adjusted photo in the place of `old` on `record` (DESIGN.md
// section 5, "Adjust a photo"): a new photo with the old one's side and
// created_at, so it takes the same place in the carousel, and its pin
// (store.js replacePhoto). When the old photo has a detail copy, the same
// settings make the new one's; detailMissing is true when that copy could
// not be loaded, and the new photo then has none. Settings are applied,
// never stored. Resolves with {detailMissing, photo, undo}; undo goes to
// store.js undoReplacePhoto.
export async function saveAdjustedPhoto({canvas, old, record, settings}) {
	const {blob, type} = await encodePhoto(canvas);
	let detail = null;

	if (old.detail) {
		detail = await adjustedDetail(old, settings).catch(() => null);
	}

	const photo = await photoRecord({created_at: old.created_at || nowIso(), detail, side: old.side, type});
	const undo = await replacePhoto(record, old.id, photo, blob, photo.detail ? detail.blob : null);

	return {detailMissing: Boolean(old.detail) && !photo.detail, photo, undo};
}

// Where a photo of these copies can go: one target per language among
// them, {catalog, card_id, language}, since photos belong to the card in a
// language, not to a copy (js/card-info.js).
function photoTargets(copies) {
	const targets = new Map();

	for (const copy of copies || []) {
		if (copy && !copy.deleted_at && copy.card_id && !targets.has(copy.language || '')) {
			targets.set(copy.language || '', {card_id: copy.card_id, catalog: copy.catalog || 'international', language: copy.language || ''});
		}
	}

	return [...targets.values()];
}

const describeLanguage = (target) => languageLabel(target.language) || 'This card';

// The Add photo button and the sheet it opens. close() closes that sheet
// and stops onSaved: the screen it belonged to is going. entries() returns
// the copies; the sheet asks which of their languages the photo is of.
function addPhotoControl({describe = describeLanguage, entries, label = 'Add photo', onSaved = null}) {
	const button = h('button', {class: 'ph-add', type: 'button'}, label);
	let sheet = null;
	let alive = true;

	button.addEventListener('click', () => {
		const list = photoTargets(entries());

		if (!list.length || !alive) {
			return;
		}

		if (sheet) {
			sheet.close();
		}

		sheet = openAddPhoto({
			describe: describe === describeCopy ? describeLanguage : describe,
			entries: list,
			pickLabel: 'Language',
			keepDetail: keepDetailCopies(),
			async save(fields) {
				const photo = await savePhoto(fields);

				if (onSaved && alive) {
					onSaved(photo);
				}

				return photo;
			},
		});
	});

	return {
		button,
		close() {
			alive = false;

			if (sheet) {
				sheet.close();
				sheet = null;
			}
		},
	};
}

// The Add photo button. entries() returns the live copies of the card; the
// photo goes on the card in one of their languages, and the button hides
// itself while there are none. onSaved(photo) runs after a save.
export function addPhotoButton(options) {
	return addPhotoControl(options).button;
}

// Card detail's image block for one card. Call show() from every render
// with the card's names (for the card-back fallback), its official image URL
// (null when the catalog has none), and the art function (catalog-views.js
// cardArt); it returns the same element each time, so the carousel keeps its
// place. destroy() when the view goes.
//
// entries: the copies whose card's photos show. Leave it out for the
// signed-in person's own copies of cardId in catalog, kept current as they
// change. The photos and pin come from the card's records (js/card-info.js)
// in the copies' languages, or the page's language at zero copies, falling
// back to another language's photos; records: a family member's records
// (with their entries), else the person's own.
// readOnly: no Add photo or Use as main image (someone else's cards).
// language: the card page's language, which a family member's photo
// (shared.js) is preferred in; the person's own copies' language otherwise.
// Only the person's own card page (no entries given, not readOnly) shows
// the family's photos.
export function cardPhotos({cardId, catalog, describe = describeLanguage, entries: given = null, language = null, readOnly = false, records: givenRecords = null, twins = []}) {
	let entries = given || [];
	let official = null;
	let info = {};
	// Called as art(info, src, opts), like catalog-views.js cardArt.
	let art = (_info, src) => plainArt(src);
	let alive = true;
	let wantSlide = null;
	let shown = false;

	const withFamily = !readOnly && !given;

	startPhotoSync();

	if (withFamily) {
		startSharedPhotos();
	}

	const carousel = photoCarousel({
		art: (src, opts) => art(info, src, opts),
		onAdjust: readOnly ? null : (slide) => adjust(slide),
		onRemove: readOnly ? null : (slide) => removePhotoFromEntry(slide.entry, slide.id),
		onUseAsMain: readOnly ? null : (slide) => useAsMain(slide.id),
		readOnly,
		resolveDetail: (slide) => detailUrl(slide.photo),
		resolveSrc: (slide) => photoUrl(slide.photo),
	});
	// Destroyed with the card page: its Add photo sheet closes with it, so
	// nothing is captured or saved for the copies of a card no longer shown.
	const addControl = readOnly ? null : addPhotoControl({
		describe,
		entries: () => entries,
		onSaved(photo) {
			if (alive) {
				wantSlide = photo.id;
			}
		},
	});
	const add = addControl ? addControl.button : null;
	const element = h('div', {class: 'ph-card'}, carousel.element, add);
	let adjustSheet = null;

	// Adjust on one of the owner's photos: the sheet, then the adjusted
	// photo in its place, shown, with Undo edit on a toast.
	function adjust(slide) {
		if (!alive || !slide || slide.kind !== 'photo' || !slide.photo) {
			return;
		}

		if (adjustSheet) {
			adjustSheet.close();
		}

		const old = slide.photo;
		const record = slide.entry;

		adjustSheet = openAdjustPhoto({
			async load() {
				const blob = await photoBlob(old.id, photoUrl(old));

				if (!blob) {
					throw new Error('This photo is not on this phone. Connect to the internet and try again.');
				}

				return decodeImageFile(blob);
			},
			async save({canvas, settings}) {
				const {detailMissing, photo, undo} = await saveAdjustedPhoto({canvas, old, record, settings});

				if (alive) {
					wantSlide = photo.id;
				}

				toast(detailMissing ? 'Photo adjusted. Its detail copy could not be loaded, so the new photo has none.' : 'Photo adjusted.', {
					action: () => undoReplacePhoto(undo)
						.then((back) => {
							if (alive) {
								wantSlide = back.id;
								draw();
							}
						})
						.catch((err) => toast(`Could not undo the edit. ${errorText(err)}`)),
					actionLabel: 'Undo edit',
					timeout: UNDO_MS,
				});
			},
		});
	}

	function draw() {
		if (!alive) {
			return;
		}

		const fallback = {card_id: cardId, catalog, language: language || ''};
		// Only once show() has said whether there is an official image, so a
		// card that has one never flashes a family photo first.
		const family = withFamily && shown ? sharedPhotosFor(language ? fallback : cardOf(entries, fallback)) : [];
		const live = entries.filter((entry) => entry && !entry.deleted_at);
		const languages = live.length ? [...new Set(live.map((entry) => entry.language || ''))] : (language ? [language] : []);

		const holders = shownRecords(givenRecords || cardInfoList(), {card_id: cardId, catalog}, languages);

		const slides = gallerySlides({entries: holders, family, official, twins});
		const mainId = mainSlideId(slides, pinnedImage(holders));

		carousel.update({mainId, pending: pendingUploads(), problems: uploadProblems(), slides, waitingText: waitingText()});

		if (wantSlide && slides.some((slide) => slide.id === wantSlide)) {
			carousel.show(wantSlide);
			wantSlide = null;
		}

		if (add) {
			add.hidden = !entries.length;
		}

		element.dataset.main = mainId || '';
	}

	async function load() {
		if (given) {
			draw();

			return;
		}

		const cards = await listCards().catch(() => []);

		entries = cards.filter((entry) => entry.card_id === cardId && (!catalog || entry.catalog === catalog));
		draw();
	}

	// The pin goes on the card in each language its copies are in (the
	// page's language at zero copies).
	async function useAsMain(id) {
		const live = entries.filter((entry) => !entry.deleted_at);
		const targets = live.length ? photoTargets(live) : [{card_id: cardId, catalog: catalog || 'international', language: language || ''}];

		await updateCardInfo(targets, (record) => (record.main_image === id ? null : {main_image: id}));
	}

	const stopChange = onChange(() => load());
	const stopPhotos = onPhotosChange(() => draw());
	const stopShared = withFamily ? onSharedPhotosChange(() => draw()) : () => {};

	load();

	return {
		destroy() {
			alive = false;
			stopChange();
			stopPhotos();
			stopShared();
			carousel.destroy();

			if (addControl) {
				addControl.close();
			}

			if (adjustSheet) {
				adjustSheet.close();
			}
		},
		element,
		refresh: load,
		show(next = {}) {
			shown = true;

			if ('official' in next) {
				official = next.official || null;
			}

			if (next.info) {
				info = next.info;
			}

			if (next.art) {
				art = next.art;
			}

			if (next.twins) {
				twins = next.twins;
			}

			draw();

			return element;
		},
	};
}

// The main image of a card, on every screen that draws one (DESIGN.md
// section 5, "Image carousel per card"), the way My Cards picks it: the
// official catalog image, then a confident international twin (js/twins.js),
// then the person's own photos, the "Use as main image" pin winning over
// that order, and the card back when there is none. Two calls, the same
// options for both:
//
//   tileSrc(target, catalogImage, options)   the URL to draw the art with
//   withMainPhoto(tile, target, catalogImage, art, options)
//                                            the photo filled in when it
//                                            was not in memory for tileSrc
//
// mainArt() below does both for art drawn on its own (a binder pocket, the
// tray, a picker), and every screen calls one of the three.
//
// target: the copies the tile stands for (one entry or an array), or a card
// with no copy there ({catalog, card_id, language}, no language for any):
// a placeholder, a wish, a card missing from a set or a list. A card keeps
// its record at zero copies, so its photos still show (js/card-info.js
// recordsForCard).
//
// catalogImage: the official image's URL in the tile's size, or null when
// the catalog has none (most Korean prints).
//
// records: the card records the photos and pin come from: a family
// member's card_info on their screens. Left out, the person's own; but on a
// read-only screen (family: false) none, never the viewer's own
// (card-info.js imageRecords).
//
// family: false on a family member's read-only cards: no family photos,
// and no records but the ones passed. Otherwise a card with no image at all
// shows a family member's photo of it (shared.js).
//
// twins: the twin slides (js/twins.js twinSlides); left out, the card's
// own twin in the low size, once the twins saved on this phone are read
// (onImagesChange below redraws a screen when they are).
function twinsOf(target, twins) {
	if (Array.isArray(twins)) {
		return twins;
	}

	const card = cardOf(target, null);

	if (!card || card.catalog === 'custom') {
		return [];
	}

	readTwins();

	return twinSlides({card_id: card.card_id, catalog: card.catalog || 'international'}, {size: 'low'});
}

function choose(target, catalogImage, {family = true, records = null, twins = null} = {}) {
	return mainImageOf(target, catalogImage, {family: familyFor(target, family), own: cardInfoList, readOnly: !family, records, twins: twinsOf(target, twins)});
}

export function tileSrc(target, catalogImage, options = {}) {
	const choice = choose(target, catalogImage, options);

	if (choice.kind !== 'photo' && choice.kind !== 'family') {
		return choice.src;
	}

	return cachedPhotoUrl(choice.photo.id) || catalogImage || null;
}

// Puts the person's photo into a finished tile (its .art-wrap's .art, or
// the .art inside the element given) when the photo is the main image and
// was not ready for tileSrc(), shimmering until it arrives; the corner
// badges stay. art(src) draws the card shape, as the tile did. A family
// member's photo also gets the line "Photo by <name>" under a tile's meta,
// and one known only once the family's photo lists have loaded is put in
// then. Returns the tile.
export function withMainPhoto(tile, target, catalogImage, art = plainArt, options = {}) {
	const {family = true} = options;
	const choice = choose(target, catalogImage, options);

	if (choice.kind === 'none' && family) {
		sharedReady().then(() => sharedSettled()).then(() => {
			const later = choose(target, catalogImage, options);

			if (later.kind === 'family' && !tile.querySelector('.ph-by')) {
				fillPhoto(tile, later, catalogImage, art);
			}
		}).catch(() => {});

		return tile;
	}

	if (choice.kind !== 'photo' && choice.kind !== 'family') {
		return tile;
	}

	if (choice.kind === 'family') {
		byLine(tile, choice.label);
	}

	return cachedPhotoUrl(choice.photo.id) ? tile : fillPhoto(tile, choice, catalogImage, art);
}

// Art drawn on its own, with the main image: draw(src) makes the element
// (js/tile.js tileArt, or a frame holding cardArt), and frame(src) the bare
// card shape a photo that arrives later is drawn in (cardArt). Returns the
// element.
export function mainArt(target, catalogImage, draw, frame, options = {}) {
	return withMainPhoto(draw(tileSrc(target, catalogImage, options)), target, catalogImage, frame, options);
}

// The twins saved on this phone, read once a session.
let twinsRead = false;
let twinsReading = null;

function readTwins() {
	if (!twinsReading) {
		twinsReading = loadTwins().then(() => {
			twinsRead = true;
		}, () => {});
	}

	return twinsReading;
}

// What a screen that draws card images listens to, so its tiles follow a
// new photo or pin without the screen being opened again: the person's
// card records changing (a photo added, removed, or uploaded, the pin
// moved; on this phone, from a sync, or from another tab), and an
// international twin found or answered, or the twins saved on the phone
// read after the screen first drew. listener(cards) gets the cards whose
// image may have changed, as a Set of "catalog~card_id", or null for any
// card (the twins read). A save that changes no record calls nothing, so a
// screen that already redraws on every save need not listen for records.
// Returns the unsubscribe function.
//
// records: false leaves the records out, for a screen that draws again on
// every save already, or one showing a family member's cards; twins: false
// leaves the twins out, for a screen that follows them itself. frame: true
// calls listener at most once an animation frame, with every card changed
// since (null when any was null), for a screen that would otherwise draw
// again for each of a burst of twin answers (My Cards' lookups give one per
// card, and keep running after it is left).
export function onImagesChange(given, {frame = false, records = true, twins = true} = {}) {
	let alive = true;
	let waiting = null;
	let frameId = 0;
	const listener = frame
		? (cards) => {
			waiting = cards === null || waiting === ANY_CARD ? ANY_CARD : new Set([...(waiting || []), ...cards]);

			if (!frameId) {
				frameId = requestAnimationFrame(() => {
					const changed = waiting;

					frameId = 0;
					waiting = null;

					if (alive) {
						given(changed === ANY_CARD ? null : changed);
					}
				});
			}
		}
		: given;
	let stamps = records ? recordStamps(cardInfoList()) : null;
	const stopRecords = records
		? onChange((doc) => {
			const next = recordStamps(doc && Array.isArray(doc.card_info) ? doc.card_info : cardInfoList());
			const changed = new Set();

			for (const [id, stamp] of next) {
				if (stamps.get(id) !== stamp) {
					changed.add(id.slice(0, id.lastIndexOf('~')));
				}
			}

			for (const id of stamps.keys()) {
				if (!next.has(id)) {
					changed.add(id.slice(0, id.lastIndexOf('~')));
				}
			}

			stamps = next;

			if (changed.size) {
				listener(changed);
			}
		})
		: () => {};
	const stopTwins = twins ? onTwinsChange((key) => listener(key ? new Set([String(key).replace('|', '~')]) : null)) : () => {};

	if (twins && !twinsRead) {
		readTwins().then(() => alive && listener(null));
	}

	return () => {
		alive = false;
		stopRecords();
		stopTwins();

		if (frameId) {
			cancelAnimationFrame(frameId);
		}
	};
}

// onImagesChange's "any card" while a frame gathers the cards changed.
const ANY_CARD = Symbol('any card');

// A family member's photos of a card as one card record, for tileSrc's
// records on a screen of theirs that does not read their whole document
// (their wishlist reads the wishlist alone): from the photo index the
// family shares (shared.js), so only photos already uploaded, and no pin.
// card is {catalog, card_id, language}. [] when they have none.
export function sharedRecordsFor(userId, card) {
	if (!card || !card.card_id) {
		return [];
	}

	startSharedPhotos();

	// Their photos picked before the family's cap of four, so another
	// member's photos of the card never crowd theirs out.
	const photos = sharedPhotosFor({catalog: card.catalog || 'international', card_id: card.card_id, language: card.language || ''}, {userId})
		.map((item) => ({created_at: null, deleted_at: null, id: item.photo.id, path: item.photo.path, side: 'front'}));

	return photos.length ? [{card_id: card.card_id, catalog: card.catalog || 'international', deleted_at: null, id: `${card.catalog || 'international'}~${card.card_id}~${card.language || ''}`, language: card.language || '', photos}] : [];
}

// Runs listener() when the family's shared photo lists change; returns the
// unsubscribe function.
export const onFamilyPhotosChange = (listener) => onSharedPhotosChange(listener);

// "catalog~card_id" of a card, as onImagesChange names it.
export const imageCardKey = (item) => `${(item && item.catalog) || 'international'}~${item && item.card_id}`;

// Each record's id and version, for onImagesChange.
const recordStamps = (records) => new Map((records || []).filter((record) => record && record.id).map((record) => [record.id, `${record.updated_at}|${record.deleted_at || ''}`]));

// The "Photo by <name>" line, after the tile's meta line.
function byLine(tile, label) {
	const line = h('span', {class: 'tile-meta ph-by'}, label);
	const meta = tile.querySelector('.tile-meta');

	if (meta) {
		meta.after(line);
	}
	else {
		tile.append(line);
	}
}

// Swaps the tile's art for the photo, shimmering until it arrives.
function fillPhoto(tile, choice, catalogImage, art) {
	if (choice.kind === 'family' && !tile.querySelector('.ph-by')) {
		byLine(tile, choice.label);
	}

	const current = tile.querySelector('.art-wrap > .art') || tile.querySelector('.art');

	if (!current) {
		return tile;
	}

	startPhotoSync();

	const placeholder = h('div', {class: 'art loading', 'data-photo': choice.photo.id});

	current.replaceWith(placeholder);
	photoUrl(choice.photo).then((url) => {
		const next = art(url || catalogImage || null);

		next.dataset.photo = url ? 'photo' : 'fallback';
		placeholder.replaceWith(next);
	});

	return tile;
}

// ------------------------------------------------------------- the setting

const KB = 1024;
const GB_KB = 1024 * 1024;

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

// What the help text says, from the sizes the encoder uses: a normal copy
// of about TARGET_BYTES, a detail copy of at most DETAIL_MAX_BYTES, and the
// free tier's 1 GB of file storage (DESIGN.md section 8).
export function detailCopyArithmetic() {
	const normal = Math.round(TARGET_BYTES / KB);
	const detail = Math.round(DETAIL_MAX_BYTES / KB);

	return {
		detailKb: detail,
		normalKb: normal,
		ratio: Math.round(detail / normal),
		withDetail: Math.floor(GB_KB / (normal + detail) / 100) * 100,
		withoutDetail: Math.floor(GB_KB / normal / 1000) * 1000,
	};
}

// Profile's switch for this phone: "Keep a detail copy of new photos", off
// by default, with what it costs. Returns the card element.
export function photoSettingsCard() {
	const math = detailCopyArithmetic();
	const box = h('input', {checked: keepDetailCopies(), class: 'ph-detail-setting', id: 'ph-detail-setting', type: 'checkbox'});
	const help = h('p', {class: 'muted ph-detail-help', id: 'ph-detail-help'},
		`Saves a second, sharper copy of each photo you take on this phone from now on, up to ${DETAIL_WIDTH} x ${DETAIL_HEIGHT} pixels, `
		+ 'for zooming in on print details when checking a card. '
		+ `Each detail copy is up to ${math.detailKb} KB, about ${WORDS[math.ratio] || math.ratio} normal photos' worth (${math.normalKb} KB each), `
		+ `so the free 1 GB of storage holds about ${formatCount(math.withDetail)} photos with detail copies, `
		+ `instead of over ${formatCount(math.withoutDetail)} without. `
		+ 'Detail copies are downloaded only when you zoom in, then kept on the phone. '
		+ 'A photo where the card is small in the frame gets none, since it holds no more detail.');

	box.setAttribute('aria-describedby', 'ph-detail-help');
	box.addEventListener('change', () => setKeepDetailCopies(box.checked));

	return h('section', {'aria-labelledby': 'ph-settings-heading', class: 'card ph-settings', id: 'photo-settings'},
		h('h3', {id: 'ph-settings-heading'}, 'Card photos'),
		h('label', {class: 'ph-detail-label', for: 'ph-detail-setting'}, box, h('span', null, 'Keep a detail copy of new photos')),
		help);
}
