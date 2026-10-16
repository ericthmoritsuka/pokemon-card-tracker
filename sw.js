// Service worker: caches the app shell so the app opens with no connection,
// and caches catalog images so a set seen once still shows its cards.
//
// To ship a change to any shell file, bump VERSION. The browser sees that
// sw.js changed, installs the new cache, and deletes the old one. The image
// caches are not versioned, so a new version keeps the images already saved.
//
// Catalog JSON is not cached here: the app keeps it in IndexedDB
// (js/catalog.js), which lets it show a saved copy and refresh it behind.

const VERSION = 'v42';
const PREFIX = 'card-tracker-shell-';
const CACHE = PREFIX + VERSION;

const IMAGE_HOST = 'assets.tcgdex.net';

// Two image caches, each trimmed least recently used first.
//
// assets.tcgdex.net sends Access-Control-Allow-Origin: * once on most card
// images, but twice on some Portuguese and French ones (checked 2026-10-15:
// 6 of 40 sampled, image by image, so pt/me/me01/001 and 003 doubled and 002
// not), and a browser fails a CORS request whose header is doubled. So each
// image is fetched in cors mode first, and in no-cors mode when that fails.
//
// A cors response counts its true size: a grid image is about 20 KB, a detail
// image about 90 KB, a logo up to 100 KB, so 3,000 entries is roughly 60 to
// 120 MB.
//
// A no-cors response is opaque. Chrome pads each opaque entry by a random
// amount in quota accounting, so its real size cannot be learned: measured in
// Chromium on 2026-10-01, 10 grid images took 177 KB of quota as cors
// entries and 88 MB as opaque ones, about 9 MB each (2026-10-15: 200 opaque
// 20 KB images counted 1.4 to 1.5 GB, about 7.5 MB each, while the files on
// disk took 5.9 MB). So the opaque cache holds a tenth of the origin's quota
// in padded entries (limitOf), never fewer than 100 nor more than 300 (about
// 2.3 GB counted, so the storage Chrome shows stays modest), which keeps
// the padding from crowding out the IndexedDB data that shares the quota. An opaque status cannot be read either, so the app deletes an
// entry whose image fails to decode (js/catalog-views.js).
const IMAGE_CACHES = [
	{limit: 3000, name: 'card-tracker-images'},
	{limit: 100, name: 'card-tracker-images-opaque', sized: true},
];

const OPAQUE_PAD = 8 * 1024 * 1024;

let opaqueLimit = null;

// The opaque cache's entry limit from the quota, worked out once per worker.
function limitOf(target) {
	if (!target.sized) {
		return Promise.resolve(target.limit);
	}

	if (!opaqueLimit) {
		opaqueLimit = (async () => {
			try {
				const {quota} = await navigator.storage.estimate();

				return Math.max(target.limit, Math.min(300, Math.floor((quota || 0) / 10 / OPAQUE_PAD)));
			}
			catch {
				return target.limit;
			}
		})();
	}

	return opaqueLimit;
}

// The OCR engine's worker, WebAssembly core, and English model, kept the
// first time the scanner starts the engine (about 7 MB on a phone: the one
// core of three that suits its browser, plus the 2.9 MB model). The cache is
// named for the Tesseract.js version rather than VERSION, so a new app
// version does not download them again, and activate leaves it alone.
const OCR_CACHE = 'card-tracker-ocr-tesseract-7.0.0';
const OCR_PATH = 'lab/vendor/tesseract/';

async function ocrResponse(event) {
	const cache = await caches.open(OCR_CACHE);
	const hit = await cache.match(event.request, {ignoreSearch: true});

	if (hit) {
		return hit;
	}

	const response = await fetch(event.request);

	if (response.ok) {
		const copy = response.clone();

		event.waitUntil(cache.put(event.request, copy).catch(() => {}));
	}

	return response;
}

const SHELL = [
	'./',
	'index.html',
	'app.js',
	'js/account-views.js',
	'js/binders-view.js',
	'js/binder-cover.js',
	'js/binder-presets.js',
	'js/binder-rule-view.js',
	'js/binder-rules.js',
	'js/binder-sources.js',
	'js/binder-spread.js',
	'js/binders.js',
	'js/auth.js',
	'js/card-swipe.js',
	'js/cards-view.js',
	'js/catalog-views.js',
	'js/catalog.js',
	'js/checklists-view.js',
	'js/checklists.js',
	'js/collection.js',
	'js/copy-sheet.js',
	'js/corners.js',
	'js/dom.js',
	'js/family.js',
	'js/flags.js',
	'js/import-view.js',
	'js/languages.js',
	'js/liga.js',
	'js/merge.js',
	'js/monprice.js',
	'js/names.js',
	'js/phone-check.js',
	'js/pokemon-cards-view.js',
	'js/pokemon-cards.js',
	'js/price-view.js',
	'js/prices.js',
	'js/photos/carousel.js',
	'js/photos/detect.js',
	'js/photos/editor.js',
	'js/photos/encode.js',
	'js/photos/geometry.js',
	'js/photos/index.js',
	'js/photos/model.js',
	'js/photos/store.js',
	'js/photos/viewer.js',
	'js/photos/zoom.js',
	'js/scan/artwork.js',
	'js/scan/evidence.js',
	'js/scan/ocr.js',
	'js/scan/read.js',
	'js/scan/rectify.js',
	'js/scan/picture.js',
	'js/vision/fingerprint.js',
	'js/vision/matcher.js',
	'js/vision/pack.js',
	'js/vision/index.bin',
	'js/scan/camera.js',
	'js/scan/chime.js',
	'js/scan/draft.js',
	'js/scan/finish.js',
	'js/scan/identify.js',
	'js/scan/image.js',
	'js/scan/local-names.js',
	'js/scan/local-names.json',
	'js/scan/log.js',
	'js/scan/drop.js',
	'js/scan/see-worker.js',
	'js/scan/match.js',
	'js/scan/routes.js',
	'js/scan/session.js',
	'js/scan/sheets.js',
	'js/scan/steady.js',
	'js/scan/tile.js',
	'js/scan/view.js',
	'js/scan/worth.js',
	'js/settings.js',
	'js/sheet.js',
	'js/shell.js',
	'js/snap.js',
	'js/stamp.js',
	'js/sync.js',
	'js/tcgdex.js',
	'js/themes.js',
	'js/tile.js',
	'js/trade-view.js',
	'js/custom-card.js',
	'js/custom-card-view.js',
	'js/format.js',
	'js/goals.js',
	'js/idb.js',
	'js/goals-view.js',
	'js/collections.js',
	'js/collections-view.js',
	'js/reorder.js',
	'js/filter-bar.js',
	'js/value-sheet.js',
	'js/whats-new.js',
	'js/twins-view.js',
	'js/twins.js',
	'js/wishlist-view.js',
	'js/wishlist.js',
	'js/vision/camera.js',
	'js/vision/match.js',
	'js/vision/pipeline.js',
	'js/vision/rectify.js',
	'lab/vendor/tesseract/tesseract.esm.min.js',
	'vendor/supabase-js.js',
	'vendor/flags/br.svg',
	'vendor/flags/cn.svg',
	'vendor/flags/de.svg',
	'vendor/flags/es.svg',
	'vendor/flags/fr.svg',
	'vendor/flags/it.svg',
	'vendor/flags/jp.svg',
	'vendor/flags/kr.svg',
	'vendor/flags/tw.svg',
	'vendor/flags/us.svg',
	'vendor/fonts/poppins-latin-400-normal.woff2',
	'vendor/fonts/poppins-latin-600-normal.woff2',
	'vendor/fonts/poppins-latin-700-normal.woff2',
	'style.css',
	'css/binders.css',
	'css/wishlist.css',
	'css/scan.css',
	'css/photos.css',
	'css/binder-spread.css',
	'css/pokemon-cards.css',
	'css/twins.css',
	'css/prices.css',
	'css/copies.css',
	'css/trade.css',
	'css/custom-card.css',
	'css/goals.css',
	'css/collections.css',
	'css/reorder.css',
	'css/filter-bar.css',
	'css/value-sheet.css',
	'css/whats-new.css',
	'manifest.webmanifest',
	'icons/icon-192.png',
	'icons/icon-512.png',
	'icons/icon-maskable-512.png',
	'icons/apple-touch-icon.png',
];

const scopeUrl = (path) => new URL(path, self.registration.scope).href;

self.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE);

			// cache: 'reload' skips the HTTP cache, so a new version never
			// precaches a stale copy of a file.
			await cache.addAll(
				SHELL.map((path) => new Request(scopeUrl(path), {cache: 'reload'}))
			);
		})()
	);
});

// A new version waits until the person taps Reload, so an open page never
// mixes its old modules with new ones (a tab that loads on first open, such
// as Scan, would otherwise import files from the new version). The first
// install has nothing to wait for and takes over at once.
self.addEventListener('message', (event) => {
	if (event.data === 'skip-waiting') {
		self.skipWaiting();
	}

	// The version, for Profile's line (js/whats-new.js).
	if (event.data && event.data.type === 'version' && event.ports[0]) {
		event.ports[0].postMessage({version: VERSION});
	}
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			const keys = await caches.keys();

			await Promise.all(
				keys
					.filter((key) => key.startsWith(PREFIX) && key !== CACHE)
					.map((key) => caches.delete(key))
			);

			await self.clients.claim();
		})()
	);
});

// Cache Storage lists keys in the order they were added, and putting a key
// again moves it to the end, so trimming from the front removes the images
// used longest ago (imageResponse puts a hit again). One trim per cache runs
// at a time.
const trimming = new Map();

function trimImages(target) {
	const {name} = target;

	if (!trimming.has(name)) {
		trimming.set(name, (async () => {
			const limit = await limitOf(target);
			const cache = await caches.open(name);
			const keys = await cache.keys();

			for (let i = 0; i < keys.length - limit; i++) {
				await cache.delete(keys[i]);
			}
		})().finally(() => trimming.delete(name)));
	}

	return trimming.get(name);
}

function keep(event, target, url, response) {
	const copy = response.clone();

	event.waitUntil(
		caches.open(target.name)
			.then((cache) => cache.put(url, copy))
			.then(() => trimImages(target))
			.catch(() => {})
	);
}

// Images that failed in cors mode and then loaded in no-cors mode: fetched
// again (after a trim), they skip the cors attempt. TCGdex doubles the header
// image by image, not by folder or language, so it is learned per image; a
// folder memory sent a whole set to the small opaque cache after one doubled
// image. Kept while this worker runs.
const corsFails = new Set();

// Images put again since this worker started, so a grid scrolled back and
// forth moves each one to the end once, not at every draw.
const touched = new Set();

async function imageResponse(event) {
	const request = event.request;
	const url = request.url;

	for (const target of IMAGE_CACHES) {
		const cached = await caches.match(url, {cacheName: target.name});

		if (cached) {
			// Put again, it moves to the end of the trim order. The count
			// stays the same, so there is nothing to trim.
			if (!touched.has(url)) {
				const copy = cached.clone();

				touched.add(url);
				event.waitUntil(caches.open(target.name).then((cache) => cache.put(url, copy)).catch(() => {}));
			}

			return cached;
		}
	}

	const [corsCache, opaqueCache] = IMAGE_CACHES;

	if (!corsFails.has(url)) {
		try {
			const response = await fetch(url, {credentials: 'omit', mode: 'cors'});

			// A 503 from an image host outage is passed on, never kept.
			if (response.ok) {
				keep(event, corsCache, url, response);
			}

			return response;
		}
		catch {
			// CORS failed (the doubled header) or the network is down.
		}
	}

	try {
		const response = await fetch(url, {credentials: 'omit', mode: 'no-cors'});

		if (response.type === 'opaque') {
			// The network is up, so the cors attempt failed on the header.
			corsFails.add(url);
		}

		if (response.type === 'opaque' || response.ok) {
			keep(event, response.type === 'opaque' ? opaqueCache : corsCache, url, response);
		}

		return response;
	}
	catch {
		// Offline or unreachable: the app shows its card-back tile.
		return Response.error();
	}
}

self.addEventListener('fetch', (event) => {
	const request = event.request;

	if (request.method !== 'GET') {
		return;
	}

	const url = new URL(request.url);

	// Card images, and the PokeAPI sprites the checklists show, so a list
	// opened once still has its pictures offline in a store.
	const isSprite = url.hostname === 'raw.githubusercontent.com' && url.pathname.startsWith('/PokeAPI/sprites/');

	if (url.hostname === IMAGE_HOST || isSprite) {
		event.respondWith(imageResponse(event));

		return;
	}

	if (url.origin !== self.location.origin || !request.url.startsWith(self.registration.scope)) {
		return;
	}

	// The OCR engine's files: cache first, kept on first use (ocrResponse).
	if (url.pathname.startsWith(new URL(OCR_PATH, self.registration.scope).pathname) && !url.pathname.endsWith('.esm.min.js')) {
		event.respondWith(ocrResponse(event));

		return;
	}

	// Every page in the app is the same shell; app.js routes by path. Serving
	// the cached shell for any path is what makes /sets/en/base1 and /camera
	// open offline, and spares a round trip through 404.html when online.
	// The scan lab is its own page, not part of the app shell.
	if (request.mode === 'navigate' && url.pathname.startsWith(new URL('lab/', self.registration.scope).pathname)) {
		return;
	}

	if (request.mode === 'navigate') {
		event.respondWith(
			(async () => {
				const shell = await caches.match(scopeUrl('index.html'), {cacheName: CACHE});

				if (shell) {
					return shell;
				}

				return fetch(request);
			})()
		);

		return;
	}

	event.respondWith(
		(async () => {
			const cached = await caches.match(request, {cacheName: CACHE});

			return cached || fetch(request);
		})()
	);
});
