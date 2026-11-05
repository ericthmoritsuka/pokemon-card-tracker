// What the service worker remembers about the card images it could not
// fetch in cors mode, and how many opaque images it keeps (E-20). A classic
// script, not a module: sw.js is registered without type: 'module' and
// loads it with importScripts, and the Node tests import it for
// globalThis.imageFolders. No DOM, no storage: sw.js keeps the memory in
// Cache Storage.
//
// assets.tcgdex.net sends Access-Control-Allow-Origin twice on some images
// and once on others, and a browser fails a cors request whose header is
// doubled (curl, 2026-11-05: pt/me/me01/001 doubled and 002 single, both
// from its object store, as their x-amz-request-id shows; en/me/me01/001
// single). Such an image can only be kept as an opaque response, which
// Chrome pads in quota accounting (sw.js, IMAGE_CACHES).

(() => {
	// An image folder: the host and the first path segment, which on
	// assets.tcgdex.net is the language ("assets.tcgdex.net/pt").
	function folderOf(url) {
		const {hostname, pathname} = new URL(url);

		return `${hostname}/${pathname.split('/')[1] || ''}`;
	}

	// The English image of the same card, for a Portuguese or French one:
	// international prints share one card ID in every Western language, so
	// only the language in the path differs. Null for any other image.
	// js/tile.js englishImage is the same rule for the page.
	const LOCALIZED = /^(https:\/\/assets\.tcgdex\.net\/)(?:pt|fr)(\/)/;

	const englishOf = (url) => (LOCALIZED.test(String(url || '')) ? String(url).replace(LOCALIZED, '$1en$2') : null);

	// TCGdex doubles the header image by image inside one folder (curl,
	// 2026-11-05: pt/me/me01/001 doubled, 002 single, both from the store), so
	// the worker learns it per image: every image not kept yet is fetched in
	// cors mode first, and in no-cors mode only when that fails. An image
	// whose cors request failed while a no-cors fetch of it came back opaque
	// is remembered with the time it failed, and it is fetched straight in
	// no-cors mode, and not tried in cors mode again, until one of these:
	//
	//   - a week has passed since it failed (RETRY_AFTER_MS);
	//   - its folder (host and language) has had no cors try for an hour
	//     (PROBE_AFTER_MS): the first remembered image of the folder shown
	//     after that is tried, so a fix reaches the phone within the hour
	//     without trying every image;
	//   - another remembered image of its folder worked in cors mode since it
	//     failed: TCGdex fixed something there, so each one is worth one try.
	//
	// A failed try sets its time again. The folder never sends an image to
	// no-cors: it only decides when to try again.
	//
	// The worker cannot tell the doubled header from a missing image: TCGdex
	// answers a 404 without CORS headers, so its cors request fails too, and
	// in no-cors mode every answer is opaque. Either one is remembered for
	// that image only, so missing English images never send the next English
	// image to no-cors.
	const RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
	const PROBE_AFTER_MS = 60 * 60 * 1000;

	// Images remembered at most, the ones that failed longest ago forgotten
	// first (the cors cache's limit; about 70 bytes each when saved).
	const IMAGES_MAX = 3000;

	// The memory, from what toJSON() saved. now: injectable for tests.
	//
	//   plan(url)      for an image not kept: 'cors', 'retry' (a cors try of
	//                  an image that failed before, skipping the HTTP cache,
	//                  which keeps the doubled header for a year), or
	//                  'no-cors'
	//   check(url)     for an image kept opaque: true when a cors try is due
	//                  (also for one kept with nothing remembered, such as an
	//                  earlier version's)
	//   failed(url)    the cors request failed and a no-cors fetch came back
	//                  opaque
	//   worked(url)    a cors request worked; true when the state to save
	//                  changed
	//   remembered(url) true when the image failed and is not due a try
	function imageMemory(saved = {}, now = () => Date.now()) {
		const images = new Map();
		const folders = new Map();
		const source = saved && typeof saved === 'object' ? saved : {};

		for (const [url, failedAt] of Object.entries(source.images && typeof source.images === 'object' ? source.images : {})) {
			if (Number.isFinite(failedAt)) {
				images.set(url, failedAt);
			}
		}

		for (const [folder, state] of Object.entries(source.folders && typeof source.folders === 'object' ? source.folders : {})) {
			if (state && typeof state === 'object') {
				folders.set(folder, {fixedAt: Number(state.fixedAt) || 0, probedAt: Number(state.probedAt) || 0});
			}
		}

		const folderState = (url) => {
			const folder = folderOf(url);

			if (!folders.has(folder)) {
				folders.set(folder, {fixedAt: 0, probedAt: 0});
			}

			return folders.get(folder);
		};

		// True when the remembered image is due a cors try. claim: take the
		// folder's hourly try, so the next image shown waits another hour.
		function due(url, claim) {
			const failedAt = images.get(url);
			const folder = folderState(url);

			if (now() - failedAt >= RETRY_AFTER_MS || folder.fixedAt > failedAt) {
				return true;
			}

			if (now() - folder.probedAt >= PROBE_AFTER_MS) {
				if (claim) {
					folder.probedAt = now();
				}

				return true;
			}

			return false;
		}

		return {
			check: (url) => !images.has(url) || due(url, true),

			failed(url) {
				images.delete(url);
				images.set(url, now());
				folderState(url).probedAt = now();

				for (const old of images.keys()) {
					if (images.size <= IMAGES_MAX) {
						break;
					}

					images.delete(old);
				}

				return true;
			},

			plan(url) {
				if (!images.has(url)) {
					return 'cors';
				}

				return due(url, true) ? 'retry' : 'no-cors';
			},

			remembered: (url) => images.has(url) && !due(url, false),

			toJSON: () => ({folders: Object.fromEntries(folders), images: Object.fromEntries(images)}),

			worked(url) {
				if (!images.has(url)) {
					return false;
				}

				images.delete(url);
				folderState(url).fixedAt = now();

				return true;
			},
		};
	}

	// The opaque cache's size, counted in entries and in the bytes Chrome
	// counts for them. Chrome adds a random 0 to 14,431 KiB of padding to each
	// opaque entry in quota accounting (Chromium's kPaddingRange), about
	// 7 MiB on average, while the file on disk is its real size (a grid image
	// is about 16 KB); measured, 7.5 to 9 MB each (DESIGN.md section 5).
	// So the cache holds half the origin's quota in padded entries at 8 MiB
	// each, never fewer than 100 nor more than 3,000 (the cors cache's
	// limit). Eric's phone reports a 10 GB quota: about 600 entries, about
	// 5 GB counted and about 10 MB on disk.
	const OPAQUE_PAD = 8 * 1024 * 1024;
	const OPAQUE_SHARE = 0.5;
	const OPAQUE_MIN = 100;
	const OPAQUE_MAX = 3000;

	function opaqueLimit(quota) {
		if (!(quota > 0)) {
			return OPAQUE_MIN;
		}

		return Math.max(OPAQUE_MIN, Math.min(OPAQUE_MAX, Math.floor(quota * OPAQUE_SHARE / OPAQUE_PAD)));
	}

	globalThis.imageFolders = {
		IMAGES_MAX,
		OPAQUE_MAX,
		OPAQUE_MIN,
		OPAQUE_PAD,
		PROBE_AFTER_MS,
		RETRY_AFTER_MS,
		englishOf,
		folderOf,
		imageMemory,
		opaqueLimit,
	};
})();
