// What the service worker remembers about each image folder, and how many
// opaque images it keeps (E-20). A classic script, not a module: sw.js is
// registered without type: 'module' and loads it with importScripts, and
// the Node tests import it for globalThis.imageFolders. No DOM, no storage:
// sw.js keeps the memory in Cache Storage.
//
// assets.tcgdex.net sends Access-Control-Allow-Origin twice on some images,
// the ones whose response carries an x-amz-request-id, so most likely those
// proxied from an object store (checked 2026-11-05: pt/me/me01/001 and
// fr/me/me01/001 doubled; en/me/me01/001 once, without the id), and a
// browser fails a cors request whose header is doubled.
// Such an image can only be kept as an opaque response, which Chrome pads
// in quota accounting (sw.js, IMAGE_CACHES).

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

	// A folder goes straight to no-cors after this many cors failures in a
	// row. Not after one: on 2026-10-15 one set folder doubled 001 and 003
	// but not 002, and a folder that switched on the first failure sent its
	// single-header images to the padded cache too.
	const FLIP_AFTER = 3;

	// A folder on no-cors tries cors again on every 20th image, or on the
	// first one an hour after its last try, so a folder TCGdex fixes
	// switches back.
	const PROBE_EVERY = 20;
	const PROBE_AFTER_MS = 60 * 60 * 1000;

	const blank = () => ({fails: 0, mode: 'cors', probedAt: 0, recovered: false});

	// The memory, from what toJSON() saved. now: injectable for tests.
	//
	//   plan(folder)          'cors', 'no-cors', or 'probe' (a cors try for a
	//                         folder on no-cors) for an image not kept yet
	//   record(folder, ok)    a cors try worked (ok) or failed on the header
	//                         while the network was up; true when the state
	//                         to save changed
	//   mode(folder)          'cors' or 'no-cors'
	//   recovered(folder)     true when the folder came back to cors after
	//                         being on no-cors, so its opaque images are
	//                         worth fetching again in cors mode
	function folderMemory(saved = {}, now = () => Date.now()) {
		const folders = new Map();
		// Images sent no-cors since the folder's last cors try. Only in
		// memory: a worker that restarts counts again, and the hour rule
		// still applies.
		const skipped = new Map();

		for (const [folder, state] of Object.entries(saved && typeof saved === 'object' ? saved : {})) {
			if (state && (state.mode === 'cors' || state.mode === 'no-cors')) {
				folders.set(folder, {
					fails: Number(state.fails) || 0,
					mode: state.mode,
					probedAt: Number(state.probedAt) || 0,
					recovered: state.recovered === true,
				});
			}
		}

		const stateOf = (folder) => {
			if (!folders.has(folder)) {
				folders.set(folder, blank());
			}

			return folders.get(folder);
		};

		return {
			mode: (folder) => (folders.get(folder) || blank()).mode,

			plan(folder) {
				const state = folders.get(folder);

				if (!state || state.mode === 'cors') {
					return 'cors';
				}

				const count = (skipped.get(folder) || 0) + 1;

				if (count >= PROBE_EVERY || now() - state.probedAt >= PROBE_AFTER_MS) {
					skipped.set(folder, 0);
					state.probedAt = now();

					return 'probe';
				}

				skipped.set(folder, count);

				return 'no-cors';
			},

			record(folder, ok) {
				const state = stateOf(folder);

				if (ok) {
					if (state.mode === 'cors' && !state.fails) {
						return false;
					}

					state.recovered = state.recovered || state.mode === 'no-cors';
					state.fails = 0;
					state.mode = 'cors';

					return true;
				}

				state.fails += 1;

				if (state.mode === 'cors' && state.fails >= FLIP_AFTER) {
					state.mode = 'no-cors';
					state.probedAt = now();
					state.recovered = false;
					skipped.set(folder, 0);
				}

				return true;
			},

			recovered: (folder) => Boolean(folders.get(folder) && folders.get(folder).mode === 'cors' && folders.get(folder).recovered),

			toJSON: () => Object.fromEntries(folders),
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
		FLIP_AFTER,
		OPAQUE_MAX,
		OPAQUE_MIN,
		OPAQUE_PAD,
		PROBE_AFTER_MS,
		PROBE_EVERY,
		englishOf,
		folderMemory,
		folderOf,
		opaqueLimit,
	};
})();
