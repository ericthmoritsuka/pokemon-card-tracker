// The owner's card photos and the image carousel: what card detail
// (js/catalog-views.js) and the tiles (js/cards-view.js) import.
//
//   cardPhotos({cardId, catalog})   card detail's image block: the carousel
//                                   with "Use as main image" and "Add photo"
//   photoCarousel(...)              the carousel alone (carousel.js)
//   addPhotoButton(...)             the Add photo button alone
//   mainImage(entry, catalogImage)  what a tile should draw (model.js)
//   tileSrc, withMainPhoto          the same for js/tile.js cardTile(): the
//                                   URL to pass, then the photo filled in
//                                   when it was not in memory yet
//                                   (a family member's photo when the
//                                   card has no image at all, shared.js)
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

import {recordsForCopies, shownRecords} from '../card-info.js';
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

// The card a group of copies is, for the family's photos of it.
function cardOf(entries, fallback = {}) {
	const entry = (Array.isArray(entries) ? entries : [entries]).find((item) => item && !item.deleted_at && item.card_id);

	return entry ? {card_id: entry.card_id, catalog: entry.catalog, language: entry.language || ''} : fallback;
}

// The family's photos of the copies' card, or none when `family` is off
// (a family member's read-only cards).
function familyFor(entries, family) {
	if (!family) {
		return [];
	}

	startSharedPhotos();

	return sharedPhotosFor(cardOf(entries));
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

// For js/tile.js cardTile({art: {src}}), which takes a URL now: the main
// image's URL when it is known at once (the official image, a twin, or a
// photo already opened this session), otherwise the official image or null.
// withMainPhoto() then fills in a photo that was not ready.
//
// family: false leaves out family members' photos (a member's read-only
// cards); otherwise a card with no image at all shows one (shared.js).
//
// records: the card records the copies' photos come from (js/card-info.js),
// a family member's for their cards; the person's own when left out.
export function tileSrc(entries, catalogImage, {family = true, records = null, twins = []} = {}) {
	const choice = mainImage(recordsForCopies(records || cardInfoList(), entries), catalogImage, {family: familyFor(entries, family), twins});

	if (choice.kind !== 'photo' && choice.kind !== 'family') {
		return choice.src;
	}

	return cachedPhotoUrl(choice.photo.id) || catalogImage || null;
}

// Puts the owner's photo into a finished tile (its .art-wrap's .art) when
// the photo is the main image and was not ready for tileSrc(), shimmering
// until it arrives; the corner badges stay. art(src) draws the card shape,
// as the tile did. A family member's photo also gets the line "Photo by
// <name>" under the tile's meta, and one known only once the family's
// photo lists have loaded is put in then. Returns the tile.
export function withMainPhoto(tile, entries, catalogImage, art = plainArt, {family = true, records = null, twins = []} = {}) {
	const holders = recordsForCopies(records || cardInfoList(), entries);
	const choice = mainImage(holders, catalogImage, {family: familyFor(entries, family), twins});

	if (choice.kind === 'none' && family) {
		sharedReady().then(() => sharedSettled()).then(() => {
			const later = mainImage(recordsForCopies(records || cardInfoList(), entries), catalogImage, {family: familyFor(entries, family), twins});

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
