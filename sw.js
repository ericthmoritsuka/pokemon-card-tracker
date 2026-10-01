// Service worker: caches the app shell so the app opens with no connection.
//
// To ship a change to any shell file, bump VERSION. The browser sees that
// sw.js changed, installs the new cache, and deletes the old one.

const VERSION = 'v2';
const PREFIX = 'card-tracker-shell-';
const CACHE = PREFIX + VERSION;

const SHELL = [
	'./',
	'index.html',
	'app.js',
	'style.css',
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

self.addEventListener('fetch', (event) => {
	const request = event.request;

	if (request.method !== 'GET') {
		return;
	}

	const url = new URL(request.url);

	if (url.origin !== self.location.origin || !request.url.startsWith(self.registration.scope)) {
		return;
	}

	// Every page in the app is the same shell; app.js routes by path. Serving
	// the cached shell for any path is what makes /camera and /storage open
	// offline, and spares a round trip through 404.html when online.
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
