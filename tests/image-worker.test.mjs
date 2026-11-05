// The service worker's card image caching (sw.js imageResponse, with
// js/image-folders.js), run in Node over a fake Cache Storage and network
// (tests/sw-harness.mjs): which images are kept opaque, which requests a
// visit makes, and what a new worker does with what the last one learned.
// No browser, no network. The browser side is in
// tests/my-cards-browser.test.mjs, "card images".
//
// TCGdex sends its CORS header twice on some images and once on others in
// the same folder (curl, 2026-11-05: pt/me/me01/001 doubled, 002 single), so
// the worker learns it image by image.
//
// Run: node --test tests/image-worker.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {cors, makeClock, makeStorage, opaque, startWorker} from './sw-harness.mjs';

const CORS_CACHE = 'card-tracker-images';
const OPAQUE_CACHE = 'card-tracker-images-opaque';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const pt = (n) => `https://assets.tcgdex.net/pt/me/me01/${String(n).padStart(3, '0')}/low.webp`;
const en = (url) => url.replace(/\/(?:pt|fr)\//, '/en/');

const ALL = Array.from({length: 60}, (_, i) => pt(i + 1));
// Three doubled in a row first, which sent the whole folder to no-cors when
// the worker learned it per folder, then a mix.
const DOUBLED = [1, 2, 3, 5, 7, 8, 11, 13, 14, 17, 19, 22, 23, 25, 29].map(pt);

// TCGdex as the browser sees it. A doubled header fails a cors request; a
// missing image is a 404 without CORS headers, which fails a cors request
// too; in no-cors mode every answer is opaque. net.offline fails every
// request.
function tcgdex({doubled = DOUBLED, missing = []} = {}) {
	const net = {doubled: new Set(doubled), missing: new Set(missing), offline: false, status: 200};

	net.fetch = async (url, init) => {
		if (net.offline) {
			throw new TypeError('Failed to fetch (offline)');
		}

		if (init.mode !== 'cors') {
			return opaque();
		}

		if (net.doubled.has(url) || net.missing.has(url)) {
			throw new TypeError('Failed to fetch (CORS)');
		}

		return cors(net.status);
	};

	return net;
}

async function visit(worker, urls) {
	for (const url of urls) {
		await worker.show(url);
	}
}

const sorted = (list) => [...list].sort();

// What one worker fetched, as "mode cache url" lines, for the images given.
const fetched = (worker, {mode, cache} = {}) => worker.log
	.filter((entry) => (!mode || entry.mode === mode) && (!cache || entry.cache === cache))
	.map((entry) => entry.url);

describe('a folder that doubles some images and not others', () => {
	test('only the doubled images are kept opaque, whatever their order, each with its English stand-in', async () => {
		const storage = makeStorage();
		const net = tcgdex();
		const worker = startWorker(storage, net.fetch);

		await visit(worker, ALL);

		assert.deepEqual(sorted(storage.urls(OPAQUE_CACHE)), sorted(DOUBLED), 'no single-header image in the padded cache');
		assert.deepEqual(sorted(storage.urls(CORS_CACHE)), sorted([...ALL.filter((url) => !DOUBLED.includes(url)), ...DOUBLED.map(en)]));

		// Each single-header image: one cors request. Each doubled one: a cors
		// try, a no-cors fetch, and its English image in cors mode.
		assert.deepEqual(sorted(fetched(worker, {mode: 'no-cors'})), sorted(DOUBLED));
		assert.deepEqual(sorted(fetched(worker, {mode: 'cors'}).filter((url) => url.includes('/pt/'))), sorted(ALL));
		assert.deepEqual(sorted(fetched(worker, {mode: 'cors'}).filter((url) => url.includes('/en/'))), sorted(DOUBLED.map(en)));
	});

	test('a new worker fetches nothing for images already kept, visit after visit', async () => {
		const storage = makeStorage();
		const net = tcgdex();
		const clock = makeClock();

		await visit(startWorker(storage, net.fetch, {clock}), ALL);

		for (let again = 2; again <= 6; again++) {
			clock.now += 5 * 60 * 1000;

			const worker = startWorker(storage, net.fetch, {clock});

			await visit(worker, ALL);
			assert.deepEqual(worker.log, [], `visit ${again}: no request, no cors retry of an opaque image`);
		}

		assert.equal(storage.urls(OPAQUE_CACHE).length, DOUBLED.length);
	});

	test('an image whose cors request failed is fetched straight in no-cors mode next time, by a new worker too', async () => {
		const storage = makeStorage();
		const net = tcgdex();
		const clock = makeClock();

		await visit(startWorker(storage, net.fetch, {clock}), ALL);

		// Trimmed from the phone, then shown again.
		for (const url of DOUBLED) {
			await (await storage.caches.open(OPAQUE_CACHE)).delete(url);
		}

		clock.now += 10 * 60 * 1000;

		const worker = startWorker(storage, net.fetch, {clock});

		await visit(worker, DOUBLED);
		assert.deepEqual(worker.log.map((entry) => entry.mode), DOUBLED.map(() => 'no-cors'), 'no failing cors request first');
		assert.deepEqual(sorted(storage.urls(OPAQUE_CACHE)), sorted(DOUBLED));
	});

	test('an hour later, one cors try for the folder lands on a doubled image, fails, and changes nothing else', async () => {
		const storage = makeStorage();
		const net = tcgdex();
		const clock = makeClock();

		await visit(startWorker(storage, net.fetch, {clock}), ALL);
		clock.now += HOUR;

		const worker = startWorker(storage, net.fetch, {clock});

		await visit(worker, ALL);
		assert.deepEqual(worker.log, [{cache: 'reload', mode: 'cors', url: DOUBLED[0]}], 'one try, skipping the HTTP cache, on the first opaque image shown');
		assert.deepEqual(sorted(storage.urls(OPAQUE_CACHE)), sorted(DOUBLED));

		// New images in the folder still go cors first: the failure sent no
		// single-header image to the padded cache.
		const more = Array.from({length: 20}, (_, i) => pt(61 + i));

		net.doubled.add(pt(61)).add(pt(62)).add(pt(63));
		await visit(worker, more);
		assert.deepEqual(sorted(storage.urls(OPAQUE_CACHE)), sorted([...DOUBLED, pt(61), pt(62), pt(63)]));
		assert.ok(more.slice(3).every((url) => storage.urls(CORS_CACHE).includes(url)));

		// A new worker in the same hour tries nothing.
		clock.now += 10 * 60 * 1000;

		const next = startWorker(storage, net.fetch, {clock});

		await visit(next, [...ALL, ...more]);
		assert.deepEqual(next.log, []);
	});

	test('a week later each opaque image is tried once, two requests at a time, and not again after it fails', async () => {
		const storage = makeStorage();
		const net = tcgdex();
		const clock = makeClock();

		await visit(startWorker(storage, net.fetch, {clock}), ALL);
		clock.now += 7 * DAY;

		// The whole grid at once, as a page draws it.
		const worker = startWorker(storage, net.fetch, {clock});

		await Promise.all(ALL.map((url) => worker.show(url)));
		assert.deepEqual(sorted(fetched(worker)), sorted(DOUBLED), 'each opaque image once, nothing else');
		assert.ok(worker.log.every((entry) => entry.cache === 'reload' && entry.mode === 'cors'));
		assert.ok(worker.counts.maxInFlight <= 2, `at most two at a time (${worker.counts.maxInFlight})`);

		for (let again = 0; again < 3; again++) {
			clock.now += HOUR - 1;

			const next = startWorker(storage, net.fetch, {clock});

			await visit(next, ALL);
			assert.ok(next.log.length <= 1, `restart ${again}: at most the folder's one try an hour (${next.log.length})`);
		}
	});

	test('the English stand-ins share the two requests at a time', async () => {
		const storage = makeStorage();
		const net = tcgdex();
		let running = 0;
		let most = 0;

		// Counts only the requests the worker makes on its own: the English
		// stand-ins.
		const worker = startWorker(storage, async (url, init) => {
			if (!url.includes('/en/')) {
				return net.fetch(url, init);
			}

			running++;
			most = Math.max(most, running);

			try {
				await new Promise((resolve) => setTimeout(resolve, 5));

				return await net.fetch(url, init);
			}
			finally {
				running--;
			}
		});

		await Promise.all(ALL.map((url) => worker.show(url)));
		assert.equal(fetched(worker).filter((url) => url.includes('/en/')).length, DOUBLED.length);
		assert.ok(most <= 2, `at most two at a time (${most})`);
	});

	test('when TCGdex fixes the header, the next try works and each opaque image moves to the cors cache when shown, once', async () => {
		const storage = makeStorage();
		const net = tcgdex();
		const clock = makeClock();

		await visit(startWorker(storage, net.fetch, {clock}), ALL);
		net.doubled.clear();
		clock.now += HOUR;

		const worker = startWorker(storage, net.fetch, {clock});

		await visit(worker, ALL);
		assert.deepEqual(fetched(worker), DOUBLED, 'each opaque image once, in the order shown');
		assert.ok(worker.log.every((entry) => entry.cache === 'reload' && entry.mode === 'cors'));
		assert.deepEqual(storage.urls(OPAQUE_CACHE), []);
		assert.ok(DOUBLED.every((url) => storage.urls(CORS_CACHE).includes(url)));

		const next = startWorker(storage, net.fetch, {clock});

		await visit(next, ALL);
		assert.deepEqual(next.log, []);
	});

	test('an opaque image an earlier version kept is tried once in cors mode: it moves when that works, and is remembered when it fails', async () => {
		const storage = makeStorage();
		const net = tcgdex({doubled: [pt(1)]});
		const clock = makeClock();
		const opaqueCache = await storage.caches.open(OPAQUE_CACHE);

		await opaqueCache.put(pt(1), opaque());
		await opaqueCache.put(pt(2), opaque());

		const worker = startWorker(storage, net.fetch, {clock});

		await visit(worker, [pt(1), pt(2)]);
		assert.deepEqual(worker.log.map((entry) => `${entry.mode} ${entry.cache} ${entry.url}`), [`cors reload ${pt(1)}`, `cors reload ${pt(2)}`]);
		assert.deepEqual(storage.urls(OPAQUE_CACHE), [pt(1)]);
		assert.deepEqual(storage.urls(CORS_CACHE), [pt(2)]);

		// The next worker leaves it alone until it is due (here, the folder's
		// try an hour later).
		clock.now += 30 * 60 * 1000;

		const next = startWorker(storage, net.fetch, {clock});

		await visit(next, [pt(1), pt(2)]);
		assert.deepEqual(next.log, []);
		assert.deepEqual(Object.keys((await storage.memory()).images), [pt(1)]);
	});

	test('offline, an opaque image is not tried in cors mode', async () => {
		const storage = makeStorage();
		const net = tcgdex();
		const clock = makeClock();

		await visit(startWorker(storage, net.fetch, {clock}), ALL);
		clock.now += 8 * DAY;
		net.offline = true;

		const worker = startWorker(storage, net.fetch, {clock, online: false});

		await visit(worker, ALL);
		assert.deepEqual(worker.log, []);
		assert.equal(storage.urls(OPAQUE_CACHE).length, DOUBLED.length);
	});
});

describe('errors are not the doubled header', () => {
	const english = (n) => `https://assets.tcgdex.net/en/sv/sv01/${String(n).padStart(3, '0')}/low.webp`;

	test('missing English images (404s without a CORS header) leave the next English images on cors', async () => {
		const storage = makeStorage();
		const net = tcgdex({doubled: [], missing: [english(1), english(2), english(3), english(4)]});
		const worker = startWorker(storage, net.fetch);

		await visit(worker, [english(1), english(2), english(3), english(4)]);

		const before = worker.log.length;

		await visit(worker, [5, 6, 7, 8].map(english));
		assert.deepEqual(worker.log.slice(before).map((entry) => entry.mode), ['cors', 'cors', 'cors', 'cors']);
		assert.deepEqual(storage.urls(CORS_CACHE), [5, 6, 7, 8].map(english));
	});

	test('a 503 is passed on and kept nowhere, and the next request tries cors again', async () => {
		const storage = makeStorage();
		const net = tcgdex({doubled: []});
		const worker = startWorker(storage, net.fetch);

		net.status = 503;
		assert.equal((await worker.show(pt(4))).status, 503);
		net.status = 200;
		assert.equal((await worker.show(pt(4))).status, 200);
		assert.deepEqual(worker.log.map((entry) => entry.mode), ['cors', 'cors']);
		assert.deepEqual(storage.urls(CORS_CACHE), [pt(4)]);
		assert.deepEqual(storage.urls(OPAQUE_CACHE), []);
	});

	test('a request that fails offline teaches nothing: back online, the image is tried in cors mode', async () => {
		const storage = makeStorage();
		const net = tcgdex({doubled: []});
		const worker = startWorker(storage, net.fetch);

		net.offline = true;
		assert.equal((await worker.show(pt(4))).type, 'error');
		net.offline = false;
		await worker.show(pt(4));
		assert.deepEqual(worker.log.map((entry) => entry.mode), ['cors', 'no-cors', 'cors']);
		assert.deepEqual(storage.urls(CORS_CACHE), [pt(4)]);
	});
});
