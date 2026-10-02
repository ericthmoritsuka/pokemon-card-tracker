// What a card's images are and which one a tile shows (DESIGN.md section
// 5, "Image carousel per card"). Pure functions over card entries, so Node
// tests them (tests/photos.test.mjs).
//
// An entry carries two optional fields for this (DESIGN.md section 4):
//
//   photos      [{id, path, side, created_at, deleted_at}], one per photo the
//               owner took of that physical card. path is
//               <user_id>/<entry_id>/<photo_id>.webp in the card-photos
//               bucket, null until the first upload knows the user. side is
//               "front" or "back". A removed photo stays as a tombstone
//               (deleted_at set), like a removed entry. detail, only on a
//               photo saved with a detail copy, is {type, width, height}
//               of that copy, kept beside it at detailPath(path, type).
//   main_image  "official", "twin", or a photo id: what tiles show. Absent
//               means the default order.
//
// The default order, which is also the carousel's order: the official
// catalog image, then an international print's image (a "twin", when a hook
// provides one), then the owner's photos, fronts before backs, oldest first.

export const SIDES = ['front', 'back'];

export const LABELS = {
	official: 'Official',
	photo: 'Your photo',
	twin: 'International print',
};

export const PHOTO_BUCKET = 'card-photos';

const isLive = (item) => item && !item.deleted_at;

const time = (value) => {
	const ms = Date.parse(value);

	return Number.isNaN(ms) ? 0 : ms;
};

// The extension a photo's path ends in, from its encoded type.
export const photoExtension = (type) => (type === 'image/jpeg' ? 'jpg' : 'webp');

export const photoType = (path) => (/\.jpe?g$/i.test(String(path || '')) ? 'image/jpeg' : 'image/webp');

export function photoPath(userId, entryId, photoId, type = 'image/webp') {
	return `${userId}/${entryId}/${photoId}.${photoExtension(type)}`;
}

// The detail copy's path beside the normal copy's (DESIGN.md section 5,
// "Inspection viewer"): <user_id>/<entry_id>/<photo_id>-detail.webp. The
// photo id is a UUID, so the name stays inside the 64 characters
// supabase/photos.sql allows. Null when the normal path is not known yet.
export function detailPath(path, type = 'image/webp') {
	const base = path ? String(path).replace(/\.(webp|jpe?g)$/i, '') : '';

	return base ? `${base}-detail.${photoExtension(type)}` : null;
}

// The user a path belongs to: its first folder.
export const pathOwner = (path) => (path ? String(path).split('/')[0] || null : null);

export function newPhoto({created_at, detail = null, id, path = null, side = 'front'}) {
	const photo = {
		created_at,
		deleted_at: null,
		id,
		path,
		side: SIDES.includes(side) ? side : 'front',
	};

	if (detail && detail.width > 0 && detail.height > 0) {
		photo.detail = {height: detail.height, type: detail.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp', width: detail.width};
	}

	return photo;
}

const entriesOf = (entryOrEntries) => (Array.isArray(entryOrEntries) ? entryOrEntries : [entryOrEntries]).filter(Boolean);

const sideRank = (photo) => (photo.side === 'back' ? 1 : 0);

// Every live photo of one entry or of a group of entries (a tile's copies),
// in carousel order, each with the entry it belongs to:
// [{entry, photo}].
export function livePhotos(entryOrEntries) {
	const out = [];
	const seen = new Set();

	for (const entry of entriesOf(entryOrEntries)) {
		if (!isLive(entry) || !Array.isArray(entry.photos)) {
			continue;
		}

		for (const photo of entry.photos) {
			if (isLive(photo) && photo.id && !seen.has(photo.id)) {
				seen.add(photo.id);
				out.push({entry, photo});
			}
		}
	}

	return out.sort((a, b) => sideRank(a.photo) - sideRank(b.photo)
		|| time(a.photo.created_at) - time(b.photo.created_at)
		|| String(a.photo.id).localeCompare(String(b.photo.id)));
}

// The pin that applies to a group of copies: the most recently changed live
// entry that has one. One entry is a group of one.
export function pinnedImage(entryOrEntries) {
	let best = null;

	for (const entry of entriesOf(entryOrEntries)) {
		if (isLive(entry) && entry.main_image && (!best || time(entry.updated_at) > time(best.updated_at))) {
			best = entry;
		}
	}

	return best ? best.main_image : null;
}

// The carousel's slides, in order: [{id, kind, label, src, photo, entry}].
// id is "official", "twin", or the photo's id, matching main_image. `twins`
// is an optional list of {src, label} from the international-twin hook;
// only the first is shown, labelled "International print" unless it says
// otherwise.
export function gallerySlides({entries = [], official = null, twins = []} = {}) {
	const slides = [];

	if (official) {
		slides.push({entry: null, id: 'official', kind: 'official', label: LABELS.official, photo: null, src: official});
	}

	const twin = (twins || []).find((item) => item && item.src);

	if (twin) {
		slides.push({entry: null, id: 'twin', kind: 'twin', label: twin.label || LABELS.twin, photo: null, src: twin.src});
	}

	for (const {entry, photo} of livePhotos(entries)) {
		slides.push({
			entry,
			id: photo.id,
			kind: 'photo',
			label: photo.side === 'back' ? `${LABELS.photo}, back` : LABELS.photo,
			photo,
			src: null,
		});
	}

	return slides;
}

// The slide id a tile shows: the pin when it still points at an image that
// exists, otherwise the first slide. Null when there is no image at all.
export function mainSlideId(slides, pin) {
	if (pin && slides.some((slide) => slide.id === pin)) {
		return pin;
	}

	return slides.length ? slides[0].id : null;
}

// Compare's two images when it opens on slide `at` (DESIGN.md section 5,
// "Inspection viewer"): a reference print (the official image, else the
// international print) beside the person's photo, the photo being the
// current slide when it is one, else the first photo. Without both kinds,
// the current slide and its neighbor. Returns two slide indexes, or null
// for fewer than two slides.
export function comparePair(slides, at = 0) {
	const count = Array.isArray(slides) ? slides.length : 0;

	if (count < 2) {
		return null;
	}

	const here = Math.min(count - 1, Math.max(0, at));
	const photo = slides[here].kind === 'photo' ? here : slides.findIndex((slide) => slide.kind === 'photo');
	const reference = slides.findIndex((slide) => slide.kind === 'official') >= 0
		? slides.findIndex((slide) => slide.kind === 'official')
		: slides.findIndex((slide) => slide.kind !== 'photo');

	if (photo >= 0 && reference >= 0) {
		return [reference, photo];
	}

	return here + 1 < count ? [here, here + 1] : [here - 1, here];
}

// What a tile should draw for an entry, or for a group of copies of one
// card (pass the array). catalogImage is the official image's URL in the
// tile's size, or null when the catalog has none (a Korean print on a
// Japanese record with no images). Returns one of:
//
//   {kind: 'official', src, label}
//   {kind: 'twin', src, label}
//   {kind: 'photo', src: null, photo, entry, label}   src comes from the
//                                                      photo store
//   {kind: 'none', src: null, label: null}
export function mainImage(entry, catalogImage, {twins = []} = {}) {
	const entries = entriesOf(entry);
	const slides = gallerySlides({entries, official: catalogImage || null, twins});
	const id = mainSlideId(slides, pinnedImage(entries));
	const slide = slides.find((item) => item.id === id);

	if (!slide) {
		return {kind: 'none', label: null, src: null};
	}

	if (slide.kind === 'photo') {
		return {entry: slide.entry, kind: 'photo', label: slide.label, photo: slide.photo, src: null};
	}

	return {kind: slide.kind, label: slide.label, src: slide.src};
}

// --------------------------------------------------------------- merging

// Merges two versions of one entry's photo list by photo id: a tombstone
// wins, then the version that knows its path, so neither an upload nor a
// removal is lost. Order follows `local`, then photos only `remote` has.
export function mergePhotoLists(local, remote) {
	const merged = new Map();

	const pickPhoto = (a, b) => {
		if (Boolean(a.deleted_at) !== Boolean(b.deleted_at)) {
			return a.deleted_at ? a : b;
		}

		if (Boolean(a.path) !== Boolean(b.path)) {
			return a.path ? a : b;
		}

		return a;
	};

	for (const photo of Array.isArray(local) ? local : []) {
		if (photo && photo.id) {
			merged.set(photo.id, photo);
		}
	}

	for (const photo of Array.isArray(remote) ? remote : []) {
		if (photo && photo.id) {
			merged.set(photo.id, merged.has(photo.id) ? pickPhoto(merged.get(photo.id), photo) : photo);
		}
	}

	return [...merged.values()];
}

// The photos field an entry needs so it again holds every photo this phone
// made for it, or null when it already does. Entries merge whole (the newer
// one wins, js/merge.js), so an edit made on another phone that never saw a
// photo would otherwise drop it from the document. A photo the entry holds
// as a tombstone stays removed.
export function restoredPhotos(entry, made) {
	if (!isLive(entry)) {
		return null;
	}

	const have = new Set((entry.photos || []).map((photo) => photo && photo.id));
	const missing = made.filter((photo) => photo && photo.id && !have.has(photo.id));

	return missing.length ? mergePhotoLists(entry.photos || [], missing) : null;
}

// The photos field with one photo changed by `patch` (for example its path
// once uploaded, or deleted_at when removed). Null when the photo is not
// there.
export function patchedPhotos(entry, photoId, patch) {
	const photos = Array.isArray(entry.photos) ? entry.photos : [];

	if (!photos.some((photo) => photo && photo.id === photoId)) {
		return null;
	}

	return photos.map((photo) => (photo && photo.id === photoId ? {...photo, ...patch} : photo));
}

// ------------------------------------------------------- bucket deletes

// How long a removed photo or binder cover stays in the bucket after it is
// removed, for other phones that may still show it (Eric, 2026-10-02).
export const BUCKET_DELETE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

// Whether a queued delete of a bucket file may go now, for card photos
// (js/photos/store.js) and binder covers (js/binder-cover.js) alike. The
// phone's own copy is deleted at once; the bucket's waits, because another
// phone may still show the file, or bring the photo or cover back.
//
// row: the queue row, {path, paths?, photo_id? | image_id?, list, entry_id,
//      not_before, at}. list is 'cards' or 'binders', entry_id the entry
//      or binder the file belonged to.
// doc: the phone's document now.
// serverHolds(list, id, updated_at): true when the server holds that
//      version of the entry (js/sync.js).
//
// Returns:
//   'cancel'  the photo or cover is live again, or a live entry or binder
//             still shows the file: drop the delete;
//   'go'      the grace period has passed and the server holds the version
//             that removed it: delete the file;
//   'wait'    anything else.
export function bucketDeleteState(row, doc, serverHolds, now = Date.now(), graceMs = BUCKET_DELETE_GRACE_MS) {
	const paths = new Set([row.path, ...(Array.isArray(row.paths) ? row.paths : [])].filter(Boolean));
	const cards = (doc && Array.isArray(doc.cards) ? doc.cards : []).filter(Boolean);
	const binders = (doc && Array.isArray(doc.binders) ? doc.binders : []).filter(Boolean);
	let holder = null;

	for (const card of cards) {
		for (const photo of Array.isArray(card.photos) ? card.photos : []) {
			const files = photo && photo.path ? [photo.path, photo.detail ? detailPath(photo.path, photo.detail.type) : null] : [];
			const same = photo && ((row.photo_id && photo.id === row.photo_id) || files.some((file) => file && paths.has(file)));

			if (!same) {
				continue;
			}

			if (isLive(card) && isLive(photo)) {
				return 'cancel';
			}

			if (photo.id === row.photo_id && (!holder || isLive(card))) {
				holder = card;
			}
		}
	}

	for (const binder of binders) {
		const cover = isLive(binder) ? binder.cover_image : null;

		if (cover && ((row.image_id && cover.id === row.image_id) || (cover.path && paths.has(cover.path)))) {
			return 'cancel';
		}
	}

	const notBefore = Number.isFinite(row.not_before) ? row.not_before : (Number(row.at) || 0) + graceMs;

	if (now < notBefore) {
		return 'wait';
	}

	const list = row.list || (row.image_id ? 'binders' : 'cards');
	const entry = list === 'cards'
		? holder || cards.find((card) => card.id === row.entry_id)
		: binders.find((binder) => binder.id === (row.entry_id || row.binder_id));

	if (entry && !serverHolds(list, entry.id, entry.updated_at)) {
		return 'wait';
	}

	return 'go';
}
