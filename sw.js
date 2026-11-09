// Service worker: caches the app shell so the app opens with no connection,
// and caches catalog images so a set seen once still shows its cards.
//
// To ship a change to any shell file, bump VERSION. The browser sees that
// sw.js changed, installs the new cache, and deletes the old one. The image
// caches are not versioned, so a new version keeps the images already saved.
//
// Catalog JSON is not cached here: the app keeps it in IndexedDB
// (js/catalog.js), which lets it show a saved copy and refresh it behind.

const VERSION = 'v68';
const PREFIX = 'card-tracker-shell-';
const CACHE = PREFIX + VERSION;

const IMAGE_HOST = 'assets.tcgdex.net';

// The memory of images that fail in cors mode, the English image rule, and
// the opaque cache's size (js/image-folders.js, a classic script shared with
// the Node tests).
importScripts('js/image-folders.js');

const {englishOf, imageMemory, opaqueLimit} = self.imageFolders;

// Two image caches, each trimmed least recently used first.
//
// assets.tcgdex.net sends Access-Control-Allow-Origin once on most card
// images, but twice on some, and a browser fails a cors request whose
// header is doubled. It varies image by image inside one set folder: on
// 2026-10-15, 6 of 40 sampled Portuguese and French images (pt/me/me01/001
// and 003 doubled, 002 not); on 2026-11-05, pt/me/me01/001 doubled and 002
// not, both from the same object store, and en/me/me01/001 not. So each
// image is fetched in cors mode first, and in no-cors mode only when that
// fails; an image that failed is remembered on its own, fetched straight in
// no-cors mode, and tried in cors mode again only now and then
// (js/image-folders.js imageMemory). The memory is kept in its own cache,
// so a new worker starts from it.
//
// A cors response counts its true size: a grid image is about 16 to 20 KB,
// a detail image about 90 KB, a logo up to 100 KB, so 3,000 entries is
// roughly 50 to 120 MB.
//
// A no-cors response is opaque. Chrome pads each opaque entry by a random
// 0 to 14 MiB in quota accounting (about 7 MiB on average), so its real
// size cannot be learned: measured in Chromium on 2026-10-01, 10 grid
// images took 177 KB of quota as cors entries and 88 MB as opaque ones
// (2026-10-15: 200 opaque 20 KB images counted 1.4 to 1.5 GB, about 7.5 MB
// each, while the files on disk took 5.9 MB). So the opaque cache holds a
// tenth of the origin's quota in padded entries at 8 MiB each, 100 to 1,000
// entries (opaqueLimit; about 120 on Eric's phone, whose quota is 10 GB),
// which leaves the rest to the IndexedDB data and photos that share the
// quota. For every image kept opaque, the English image of the same card
// is kept at its true size too (keepEnglish), so the app has a stand-in
// once the opaque copy is trimmed (js/tile.js). An opaque status cannot be
// read either, so the app deletes an entry whose image fails to decode
// (js/tile.js forgetImage).
const IMAGE_CACHES = [
	{limit: 3000, name: 'card-tracker-images'},
	{name: 'card-tracker-images-opaque', sized: true},
];

const FOLDERS_CACHE = 'card-tracker-image-folders';

let opaqueLimitOnce = null;

// A cache's entry limit; the opaque cache's from the quota, worked out once
// per worker.
function limitOf(target) {
	if (!target.sized) {
		return Promise.resolve(target.limit);
	}

	if (!opaqueLimitOnce) {
		opaqueLimitOnce = (async () => {
			try {
				const {quota} = await navigator.storage.estimate();

				return opaqueLimit(quota);
			}
			catch {
				return opaqueLimit(0);
			}
		})();
	}

	return opaqueLimitOnce;
}

// The OCR engine's worker, WebAssembly core, and English model, kept the
// first time the scanner starts the engine (about 7 MB on a phone: the one
// core of three that suits its browser, plus the 2.9 MB model). The cache is
// named for the Tesseract.js version rather than VERSION, so a new app
// version does not download them again, and activate leaves it alone.
const OCR_CACHE = 'card-tracker-ocr-tesseract-7.0.0';
const OCR_PATH = 'lab/vendor/tesseract/';

// The OCR models by version: the first 12 hex digits of each file's SHA-256
// (tests/scan-cjk.test.mjs checks them against the files). A model is kept
// under its address with ?v=<version>, so a changed model, whose new version
// comes with a new sw.js, is fetched again, and the copy of the old one is
// dropped when the new one is kept.
const OCR_MODELS = {eng: '45b4cb346724', jpn: 'c68c7f1f569c', kor: '8c9482fbc70e'};

async function ocrResponse(event) {
	const cache = await caches.open(OCR_CACHE);
	const url = new URL(event.request.url);
	const model = /\/([a-z_]+)\.traineddata\.gz$/.exec(url.pathname);
	const version = model ? OCR_MODELS[model[1]] : null;
	const key = version ? `${url.origin}${url.pathname}?v=${version}` : event.request;
	const hit = await cache.match(key, {ignoreSearch: !version});

	if (hit) {
		return hit;
	}

	const response = await fetch(event.request);

	if (response.ok) {
		const copy = response.clone();

		event.waitUntil((async () => {
			if (version) {
				for (const kept of await cache.keys()) {
					if (new URL(kept.url).pathname === url.pathname && kept.url !== key) {
						await cache.delete(kept);
					}
				}
			}

			await cache.put(key, copy);
		})().catch(() => {}));
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
	'js/binder-hand.js',
	'js/binder-layout.js',
	'js/binder-presets.js',
	'js/binder-rule-view.js',
	'js/binder-rules.js',
	'js/binder-sources.js',
	'js/binder-spread.js',
	'js/binders.js',
	'js/pocket-drag.js',
	'js/auth.js',
	'js/card-info.js',
	'js/card-search.js',
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
	'js/scan-reports-view.js',
	'js/pokemon-cards-view.js',
	'js/pokemon-cards.js',
	'js/price-view.js',
	'js/prices.js',
	'js/photos/adjust.js',
	'js/photos/adjust-view.js',
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
	'js/photo-cleanup.js',
	'js/photo-cleanup-view.js',
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
	// Japanese and Korean names (Eric, 2026-11-04): the reader and the name
	// table (43 KB, 17 KB gzipped). The Japanese and Korean OCR models are
	// not here: ocrResponse keeps them the first time a card asks for one.
	'js/scan/cjk.js',
	'js/scan/asian-names.json',
	'js/scan/draft.js',
	'js/scan/finish.js',
	'js/scan/identify.js',
	'js/scan/image.js',
	'js/scan/local-names.js',
	'js/scan/local-names.json',
	'js/scan/log.js',
	'js/scan/report-file.js',
	'js/scan/report-queue.js',
	'js/scan/report-scans.js',
	'js/scan/reports.js',
	'js/scan/drop.js',
	'js/scan/see-worker.js',
	'js/scan/match.js',
	'js/scan/routes.js',
	'js/scan/session.js',
	'js/scan/sheets.js',
	'js/scan/steady.js',
	'js/scan/tile.js',
	// Trade or sale mode (Eric, 2026-11-06).
	'js/scan/trade.js',
	'js/scan/trade-sheets.js',
	'js/scan/view.js',
	'js/scan/worth.js',
	'js/settings.js',
	'js/sheet.js',
	'js/photos/shared.js',
	'js/shell.js',
	'js/snap.js',
	'js/stamp.js',
	'js/start-over.js',
	'js/moves.js',
	'js/moves-view.js',
	'js/placeholder-fill.js',
	'js/fill-view.js',
	'js/pocket-viewer.js',
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
	'js/image-folders.js',
	'js/goals-view.js',
	'js/collections.js',
	'js/collections-view.js',
	'js/reorder.js',
	'js/filter-bar.js',
	'js/card-view-mode.js',
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
	'css/card-views.css',
	'css/value-sheet.css',
	'css/whats-new.css',
	'css/moves.css',
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

const [CORS_IMAGES, OPAQUE_IMAGES] = IMAGE_CACHES;

const cachedImage = async (url) => {
	for (const target of IMAGE_CACHES) {
		const cached = await caches.match(url, {cacheName: target.name});

		if (cached) {
			return {cached, target};
		}
	}

	return null;
};

// ------------------------------------------------------- image memory

let memoryRead = null;

// The images that failed in cors mode (js/image-folders.js imageMemory),
// read once per worker from its cache.
function images() {
	if (!memoryRead) {
		memoryRead = (async () => {
			let saved = {};

			try {
				const hit = await caches.match(scopeUrl('image-folders.json'), {cacheName: FOLDERS_CACHE});

				if (hit) {
					saved = await hit.json();
				}
			}
			catch {
				// Unreadable: every image is tried in cors mode again.
			}

			return imageMemory(saved);
		})();
	}

	return memoryRead;
}

// Saves are chained, so the last state is the one kept, and changes made
// while a save waits go out with it.
let memorySaved = Promise.resolve();
let saveWaiting = false;

function remember(memory) {
	if (!saveWaiting) {
		saveWaiting = true;
		memorySaved = memorySaved
			.then(() => {
				saveWaiting = false;

				return caches.open(FOLDERS_CACHE);
			})
			.then((cache) => cache.put(scopeUrl('image-folders.json'), new Response(JSON.stringify(memory), {headers: {'Content-Type': 'application/json'}})))
			.catch(() => {});
	}

	return memorySaved;
}

// --------------------------------------------- work behind the screen

// The English stand-ins and the cors tries of opaque images run two at a
// time, so the images on screen go first. pending: the URLs queued or
// running, so one is never fetched twice at once.
let slotsRunning = 0;
const slotsWaiting = [];
const pending = new Set();

async function slot(work) {
	while (slotsRunning >= 2) {
		await new Promise((resolve) => slotsWaiting.push(resolve));
	}

	slotsRunning++;

	try {
		return await work();
	}
	finally {
		slotsRunning--;

		const next = slotsWaiting.shift();

		if (next) {
			next();
		}
	}
}

function behind(event, url, work) {
	if (pending.has(url)) {
		return;
	}

	pending.add(url);
	event.waitUntil(work().catch(() => {}).finally(() => pending.delete(url)));
}

// The English image of a Portuguese or French one kept opaque, fetched in
// cors mode and kept at its true size (about 16 KB). Never kept opaque, and
// not tried while it is remembered as failing in cors mode.
function keepEnglish(event, memory, url) {
	const english = englishOf(url);

	if (!english || memory.remembered(english)) {
		return;
	}

	behind(event, english, () => slot(async () => {
		if (await cachedImage(english)) {
			return;
		}

		const response = await fetch(english, {credentials: 'omit', mode: 'cors'});

		if (response.ok) {
			await (await caches.open(CORS_IMAGES.name)).put(english, response);
			await trimImages(CORS_IMAGES);
		}
	}));
}

// An image kept opaque, fetched again in cors mode when its try is due
// (imageMemory check) and moved to the cors cache when that works, which
// gives back its padding. cache: 'reload' skips the HTTP cache, which keeps
// the doubled header for a year (max-age=31536000). A failure, or an error
// status, is remembered, so neither this worker nor the next tries it again
// before it is due.
// Offline nothing is tried: it would only fail.
function upgrade(event, url) {
	if (self.navigator && self.navigator.onLine === false) {
		return;
	}

	behind(event, url, async () => {
		const memory = await images();

		if (!memory.check(url)) {
			return;
		}

		await slot(async () => {
			let response = null;

			try {
				response = await fetch(url, {cache: 'reload', credentials: 'omit', mode: 'cors'});
			}
			catch {
				// Still doubled (or the network dropped): it stays opaque.
				memory.failed(url);
				await remember(memory);

				return;
			}

			if (!response.ok) {
				// An error status (a 503 in an outage): the opaque copy stays,
				// and the try waits until it is due again.
				memory.failed(url);
				await remember(memory);

				return;
			}

			await (await caches.open(CORS_IMAGES.name)).put(url, response);
			await (await caches.open(OPAQUE_IMAGES.name)).delete(url);
			memory.worked(url);
			await remember(memory);
			await trimImages(CORS_IMAGES);
		});
	});
}

// ------------------------------------------------------------ images

// Images put again since this worker started, so a grid scrolled back and
// forth moves each one to the end once, not at every draw.
const touched = new Set();

async function imageResponse(event) {
	const url = event.request.url;
	const hit = await cachedImage(url);

	if (hit) {
		// Put again, it moves to the end of the trim order. The count stays
		// the same, so there is nothing to trim.
		if (!touched.has(url)) {
			const copy = hit.cached.clone();

			touched.add(url);
			event.waitUntil(caches.open(hit.target.name).then((cache) => cache.put(url, copy)).catch(() => {}));
		}

		if (hit.target === OPAQUE_IMAGES) {
			upgrade(event, url);
		}

		return hit.cached;
	}

	// Each image is tried in cors mode first, unless it failed there and is
	// not due a try (imageMemory plan).
	const memory = await images();
	const plan = memory.plan(url);

	if (plan !== 'no-cors') {
		try {
			// A retry skips the HTTP cache, which may hold the doubled header.
			const response = await fetch(url, {cache: plan === 'retry' ? 'reload' : 'default', credentials: 'omit', mode: 'cors'});

			// A 503 from an image host outage is passed on, never kept, and
			// teaches nothing.
			if (response.ok) {
				if (memory.worked(url)) {
					event.waitUntil(remember(memory));
				}

				keep(event, CORS_IMAGES, url, response);
			}

			return response;
		}
		catch {
			// CORS failed (the doubled header, or a 404, which TCGdex sends
			// without CORS headers) or the network is down.
		}
	}

	try {
		const response = await fetch(url, {credentials: 'omit', mode: 'no-cors'});

		if (response.type === 'opaque') {
			// The network is up, so the cors try just made failed on the
			// header (or the image is missing). Only this image is
			// remembered.
			if (plan !== 'no-cors') {
				memory.failed(url);
				event.waitUntil(remember(memory));
			}

			keep(event, OPAQUE_IMAGES, url, response);
			keepEnglish(event, memory, url);
		}
		else if (response.ok) {
			keep(event, CORS_IMAGES, url, response);
		}

		return response;
	}
	catch {
		// Offline or unreachable: the app shows the English image if it is
		// kept (js/tile.js), else its card-back tile.
		return Response.error();
	}
}

// A file shared to the installed app (manifest share_target, Android): the
// share sheet POSTs it here as multipart form data. It is kept in its own
// cache until the Import screen picks it up and deletes it (js/import-view.js),
// and the 303 sends the person there. Nothing is imported until they tap Save.
const SHARE_CACHE = 'card-tracker-share';
const SHARE_ACTION = 'share-import';

async function shareResponse(event) {
	let shared = 'none';

	try {
		const form = await event.request.formData();
		const file = form.getAll('file').find((item) => item && typeof item === 'object' && item.size > 0);

		if (file) {
			const cache = await caches.open(SHARE_CACHE);

			await cache.put(scopeUrl(SHARE_ACTION), new Response(file, {
				headers: {
					'Content-Type': file.type || 'application/octet-stream',
					'X-File-Name': encodeURIComponent(file.name || ''),
				},
			}));
			shared = '1';
		}
	}
	catch {
		// An unreadable form is reported as no file, as is an empty one.
	}

	return Response.redirect(scopeUrl(`import?shared=${shared}`), 303);
}

self.addEventListener('fetch', (event) => {
	const request = event.request;

	if (request.method === 'POST' && request.url.split('?')[0] === scopeUrl(SHARE_ACTION)) {
		event.respondWith(shareResponse(event));

		return;
	}

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
