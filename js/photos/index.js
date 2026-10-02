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
//   mainImageArt(entries, src, art) the main image as an element
//   startPhotoSync()                the upload queue and photo restore
//   photoSettingsCard()             Profile's "Keep a detail copy of new
//                                   photos" switch, for this phone
//
// DESIGN.md section 5 ("Own photos, cropped to the card" and "Image
// carousel per card") is the spec; supabase/photos.sql makes the bucket.

import {listCards, loadDocument, newId, nowIso, onChange, updateCards} from '../collection.js';
import {h} from '../dom.js';

import {SWIPE_EVENT, gestureConsumed, isCarouselGesture, openViewer, photoCarousel} from './carousel.js';
import {describeCopy, openAddPhoto} from './editor.js';
import {DETAIL_HEIGHT, DETAIL_MAX_BYTES, DETAIL_WIDTH, TARGET_BYTES} from './encode.js';
import {gallerySlides, mainImage, mainSlideId, newPhoto, photoPath, pinnedImage} from './model.js';
import {
	addPhotoToEntry,
	cachedPhotoUrl,
	detailUrl,
	keepDetailCopies,
	onPhotosChange,
	pendingUploads,
	photoUrl,
	removePhotoFromEntry,
	setKeepDetailCopies,
	startPhotoSync,
} from './store.js';

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

// A card-shaped image with no names, for callers that pass no art function.
function plainArt(src) {
	const frame = h('div', {class: 'art'});

	frame.append(src
		? h('img', {alt: '', decoding: 'async', src})
		: h('div', {class: 'card-back'}, h('span', {class: 'card-back-status'}, 'No image')));

	return frame;
}

// Saves a straightened photo onto one copy: on the phone at once, uploaded
// when there is signal (store.js). detail, when given, is the detail copy
// {blob, type, width, height}. Resolves with the new photo record.
export async function savePhoto({blob, detail = null, entry, side = 'front', type}) {
	const doc = await loadDocument();
	const id = newId();
	const photo = newPhoto({
		created_at: nowIso(),
		detail: detail && detail.blob ? {height: detail.height, type: detail.type || detail.blob.type, width: detail.width} : null,
		id,
		path: doc.user_id ? photoPath(doc.user_id, entry.id, id, type || blob.type) : null,
		side,
	});

	await addPhotoToEntry(entry, photo, blob, photo.detail ? detail.blob : null);

	return photo;
}

// The Add photo button and the sheet it opens. close() closes that sheet
// and stops onSaved: the screen it belonged to is going.
function addPhotoControl({describe = describeCopy, entries, label = 'Add photo', onSaved = null}) {
	const button = h('button', {class: 'ph-add', type: 'button'}, label);
	let sheet = null;
	let alive = true;

	button.addEventListener('click', () => {
		const list = entries();

		if (!list.length || !alive) {
			return;
		}

		if (sheet) {
			sheet.close();
		}

		sheet = openAddPhoto({
			describe,
			entries: list,
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

// The Add photo button. entries() returns the live copies the photo can go
// on; the button hides itself while there are none (photos belong to a
// physical card). onSaved(photo) runs after a save.
export function addPhotoButton(options) {
	return addPhotoControl(options).button;
}

// Card detail's image block for one card. Call show() from every render
// with the card's names (for the card-back fallback), its official image URL
// (null when the catalog has none), and the art function (catalog-views.js
// cardArt); it returns the same element each time, so the carousel keeps its
// place. destroy() when the view goes.
//
// entries: the copies to show photos of. Leave it out for the signed-in
// person's own copies of cardId in catalog, kept current as they change.
// readOnly: no Add photo or Use as main image (someone else's cards).
export function cardPhotos({cardId, catalog, describe = describeCopy, entries: given = null, readOnly = false, twins = []}) {
	let entries = given || [];
	let official = null;
	let info = {};
	let art = plainArt;
	let alive = true;
	let wantSlide = null;

	startPhotoSync();

	const carousel = photoCarousel({
		art: (src, opts) => art(info, src, opts),
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

	function draw() {
		if (!alive) {
			return;
		}

		const slides = gallerySlides({entries, official, twins});
		const mainId = mainSlideId(slides, pinnedImage(entries));

		carousel.update({mainId, pending: pendingUploads(), slides});

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

	async function useAsMain(id) {
		const own = entries.filter((entry) => !entry.deleted_at);

		if (own.length) {
			await updateCards(own.map((entry) => ({id: entry.id, patch: {main_image: id}})));
		}
	}

	const stopChange = onChange(() => load());
	const stopPhotos = onPhotosChange(() => draw());

	load();

	return {
		destroy() {
			alive = false;
			stopChange();
			stopPhotos();
			carousel.destroy();

			if (addControl) {
				addControl.close();
			}
		},
		element,
		refresh: load,
		show(next = {}) {
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

// A tile's image as an element: the main image of a group of copies (or
// one copy). art(src) draws the card shape (cardArt bound to the tile's
// names); catalogImage is the official image in the tile's size, or null.
// When the main image is the owner's photo, it is drawn from this phone, or
// fetched once from the bucket; if neither has it, the official image or
// the card back shows instead.
export function mainImageArt(entries, catalogImage, art = plainArt, {twins = []} = {}) {
	const choice = mainImage(entries, catalogImage, {twins});

	if (choice.kind !== 'photo') {
		return art(choice.src);
	}

	startPhotoSync();

	const ready = cachedPhotoUrl(choice.photo.id);

	if (ready) {
		return art(ready);
	}

	// display: contents, so the tile's layout and corner badges see the art
	// itself.
	const slot = h('div', {class: 'ph-tile-slot', 'data-photo': choice.photo.id}, h('div', {class: 'art loading'}));

	photoUrl(choice.photo).then((url) => {
		slot.replaceChildren(art(url || catalogImage || null));
		slot.dataset.src = url ? 'photo' : 'fallback';
	});

	return slot;
}

// For js/tile.js cardTile({art: {src}}), which takes a URL now: the main
// image's URL when it is known at once (the official image, a twin, or a
// photo already opened this session), otherwise the official image or null.
// withMainPhoto() then fills in a photo that was not ready.
export function tileSrc(entries, catalogImage, {twins = []} = {}) {
	const choice = mainImage(entries, catalogImage, {twins});

	if (choice.kind !== 'photo') {
		return choice.src;
	}

	return cachedPhotoUrl(choice.photo.id) || catalogImage || null;
}

// Puts the owner's photo into a finished tile (its .art-wrap's .art) when
// the photo is the main image and was not ready for tileSrc(), shimmering
// until it arrives; the corner badges stay. art(src) draws the card shape,
// as the tile did. Returns the tile.
export function withMainPhoto(tile, entries, catalogImage, art = plainArt, {twins = []} = {}) {
	const choice = mainImage(entries, catalogImage, {twins});

	if (choice.kind !== 'photo' || cachedPhotoUrl(choice.photo.id)) {
		return tile;
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

const thousands = (n) => n.toLocaleString('en-US');

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
		+ `so the free 1 GB of storage holds about ${thousands(math.withDetail)} photos with detail copies, `
		+ `instead of over ${thousands(math.withoutDetail)} without. `
		+ 'Detail copies are downloaded only when you zoom in, then kept on the phone. '
		+ 'A photo where the card is small in the frame gets none, since it holds no more detail.');

	box.setAttribute('aria-describedby', 'ph-detail-help');
	box.addEventListener('change', () => setKeepDetailCopies(box.checked));

	return h('section', {'aria-labelledby': 'ph-settings-heading', class: 'card ph-settings', id: 'photo-settings'},
		h('h3', {id: 'ph-settings-heading'}, 'Card photos'),
		h('label', {class: 'ph-detail-label', for: 'ph-detail-setting'}, box, h('span', null, 'Keep a detail copy of new photos')),
		help);
}
