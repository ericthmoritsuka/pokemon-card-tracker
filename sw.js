// Service worker: caches the app shell so the app opens with no connection,
// and caches catalog images so a set seen once still shows its cards.
//
// To ship a change to any shell file, bump VERSION. The browser sees that
// sw.js changed, installs the new cache, and deletes the old one. The image
// caches are not versioned, so a new version keeps the images already saved.
//
// Catalog JSON is not cached here: the app keeps it in IndexedDB
// (js/catalog.js), which lets it show a saved copy and refresh it behind.

const VERSION = 'v11';
const PREFIX = 'card-tracker-shell-';
const CACHE = PREFIX + VERSION;

const IMAGE_HOST = 'assets.tcgdex.net';

// Two image caches, each trimmed oldest first.
//
// assets.tcgdex.net sends Access-Control-Allow-Origin: * on English card
// images, but most Portuguese and French card images, and some logos, send
// that header twice, and a browser fails a CORS request whose header is
// doubled. So each image is fetched in cors mode first, and in no-cors mode
// when that fails.
//
// A cors response counts its true size: a grid image is about 20 KB, a detail
// image about 90 KB, a logo up to 100 KB, so 3,000 entries is roughly 60 to
// 120 MB.
//
// A no-cors response is opaque. Chrome pads each opaque entry by a random
// amount in quota accounting, so its real size cannot be learned: measured in
// Chromium on 2026-10-01, 10 grid images took 177 KB of quota as cors
// entries and 88 MB as opaque ones, about 9 MB each. So the opaque cache
// holds 100 entries, roughly 0.9 GB of counted quota, which keeps the padding
// from crowding out the IndexedDB data that shares the origin's quota. An
// opaque status cannot be read either, so the app deletes an entry whose
// image fails to decode (js/catalog-views.js).
const IMAGE_CACHES = [
	{limit: 3000, name: 'card-tracker-images'},
	{limit: 100, name: 'card-tracker-images-opaque'},
];

const SHELL = [
	'./',
	'index.html',
	'app.js',
	'js/account-views.js',
	'js/binders-view.js',
	'js/binders.js',
	'js/auth.js',
	'js/cards-view.js',
	'js/catalog-views.js',
	'js/catalog.js',
	'js/checklists-view.js',
	'js/checklists.js',
	'js/collection.js',
	'js/dom.js',
	'js/flags.js',
	'js/import-view.js',
	'js/liga.js',
	'js/merge.js',
	'js/monprice.js',
	'js/names.js',
	'js/phone-check.js',
	'js/settings.js',
	'js/sync.js',
	'js/themes.js',
	'js/wishlist-view.js',
	'js/wishlist.js',
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
	'style.css',
	'css/binders.css',
	'css/wishlist.css',
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

			await self.skipWaiting();
		})()
	);
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

// Cache Storage lists keys in the order they were added, so trimming from
// the front removes the oldest images. One trim per cache runs at a time.
const trimming = new Map();

function trimImages({limit, name}) {
	if (!trimming.has(name)) {
		trimming.set(name, (async () => {
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

async function imageResponse(event) {
	const request = event.request;
	const url = request.url;

	for (const {name} of IMAGE_CACHES) {
		const cached = await caches.match(url, {cacheName: name});

		if (cached) {
			return cached;
		}
	}

	const [corsCache, opaqueCache] = IMAGE_CACHES;

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

	try {
		const response = await fetch(url, {credentials: 'omit', mode: 'no-cors'});

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
