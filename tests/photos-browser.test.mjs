// Browser tests for the owner's card photos and the image carousel
// (js/photos/). Headless Chromium at 360 x 740 against
// tests/photos-harness.mjs: the real modules mounted on a harness page,
// served by tests/pages-server.mjs.
//
// Supabase is tests/photos-fake-storage.mjs (tests/fake-supabase.mjs plus
// Storage), never the real project. The card image is a real TCGdex English
// high.webp, fetched once by Node and served to the page from memory; the
// "phone photo" is that image warped onto a dark background with a
// perspective tilt, made in the page. With no network, a drawn stand-in
// card is used instead and the test says so.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/photos-browser.test.mjs

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {FakeStorageSupabase, SUPABASE_ORIGIN} from './photos-fake-storage.mjs';
import {HARNESS_PATH, routeHarness, startHarness} from './photos-harness.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const VIEWPORT = {height: 740, width: 360};
const SHOTS = process.env.SHOTS || '/tmp';
const IMAGE = 'https://assets.tcgdex.net/en/me/me01/001';

let harness;
let browser;
const images = {};

before(async () => {
	harness = await startHarness();
	browser = await chromium.launch({args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']});

	for (const size of ['high', 'low']) {
		try {
			const response = await fetch(`${IMAGE}/${size}.webp`);

			images[size] = response.ok ? Buffer.from(await response.arrayBuffer()) : null;
		}
		catch {
			images[size] = null;
		}
	}

	if (!images.high) {
		console.log('# TCGdex was not reachable: the test photo uses a drawn stand-in card.');
	}
});

after(async () => {
	await browser.close();
	await harness.close();
});

// The card's corners in the made-up 1200 x 1600 phone photo: a perspective
// tilt, the top edge further away than the bottom.
const QUAD = [{x: 330, y: 250}, {x: 905, y: 300}, {x: 990, y: 1290}, {x: 215, y: 1235}];
const BACK_QUAD = [{x: 260, y: 300}, {x: 940, y: 260}, {x: 960, y: 1240}, {x: 240, y: 1260}];

async function device(fake, user, {offline}) {
	const context = await browser.newContext({viewport: VIEWPORT});
	const errors = [];

	await fake.attach(context, 'phone');
	await routeHarness(context, harness.origin, {offline});
	await context.route('https://assets.tcgdex.net/**', (route) => {
		const size = route.request().url().endsWith('/low.webp') ? 'low' : 'high';

		return images[size]
			? route.fulfill({body: images[size], contentType: 'image/webp', headers: {'access-control-allow-origin': '*'}})
			: route.fulfill({status: 404});
	});

	if (user) {
		const session = fake.session(user);

		await context.addInitScript((value) => {
			if (!localStorage.getItem('card-tracker-auth')) {
				localStorage.setItem('card-tracker-auth', value);
			}
		}, JSON.stringify(session));
	}

	const page = await context.newPage();

	page.on('pageerror', (err) => errors.push(String(err)));
	page.on('console', (message) => {
		if (message.type() === 'error' && !/Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(message.text())) {
			errors.push(message.text());
		}
	});

	return {context, errors, page};
}

async function open(page) {
	await page.goto(`${harness.origin}${HARNESS_PATH}`);
	await page.waitForFunction(() => document.body.dataset.ready);

	const state = await page.evaluate(() => [document.body.dataset.ready, document.body.dataset.error]);

	assert.equal(state[0], 'true', state[1]);
}

// What the phone's screen shows, after any slide has settled.
async function shot(page, name) {
	await page.waitForTimeout(300);
	await page.screenshot({path: `${SHOTS}/photos-${name}.png`});
}

// Picks the made-up photo through the real "Choose from gallery" input.
async function pickPhoto(page, quad, {side = 'front'} = {}) {
	const base64 = await page.evaluate((q) => window.H.makeTestPhoto({quad: q}), quad);

	await page.click('.ph-add');
	await page.waitForSelector('.ph-sheet .ph-pick');

	if (side === 'back') {
		await page.check('.ph-side input[value="back"]');
	}

	const chooser = page.waitForEvent('filechooser');

	await page.click('.ph-pick');
	await (await chooser).setFiles({buffer: Buffer.from(base64, 'base64'), mimeType: 'image/jpeg', name: 'card.jpg'});
	await page.waitForSelector('.ph-stage .ph-handle');
}

// Polls an async check in the page until it is true. page.waitForFunction
// does not wait for a promise: an async predicate passes at once.
async function until(page, check, arg = null, timeout = 10000) {
	const end = Date.now() + timeout;

	while (Date.now() < end) {
		if (await page.evaluate(check, arg)) {
			return;
		}

		await page.waitForTimeout(100);
	}

	throw new Error(`Timed out after ${timeout} ms waiting for ${check}`);
}

const corners = (page) => page.$$eval('.ph-handle', (handles) => handles.map((handle) => ({x: Number(handle.dataset.x), y: Number(handle.dataset.y)})));

async function save(page) {
	await page.click('.ph-save');
	await page.waitForSelector('.ph-sheet', {state: 'detached'});
}

const entryOf = (page, key) => page.evaluate(async (k) => (await window.H.listCards()).find((card) => card.id === window.H.ids()[k]), key);

const tileImage = (page, key) => page.evaluate((k) => {
	const tile = document.querySelector(`.tile[data-entry="${window.H.ids()[k]}"]`);
	const img = tile && tile.querySelector('img');

	return {kind: tile && tile.dataset.kind, src: img ? img.getAttribute('src') : null};
}, key);

async function waitForTilePhoto(page, key) {
	await page.waitForFunction((k) => {
		const tile = document.querySelector(`.tile[data-entry="${window.H.ids()[k]}"]`);
		const img = tile && tile.querySelector('img');

		return img && img.getAttribute('src').startsWith('blob:') && img.complete && img.naturalWidth > 0;
	}, key);
}

describe('own photos and the carousel', () => {
	const fake = new FakeStorageSupabase();
	const owner = fake.addUser('owner@example.test');
	let offline = false;
	let phone;
	let firstPhoto;

	before(async () => {
		phone = await device(fake, owner, {offline: () => offline});
	});

	after(async () => {
		await phone.context.close();
	});

	test('signed in, a card with an official image shows it and Add photo; the Korean card shows the card back', async () => {
		const {page} = phone;

		await open(page);
		assert.deepEqual(await page.evaluate(() => window.H.user() && window.H.user().email), owner.email);

		assert.equal((await tileImage(page, 'e1')).kind, 'official');
		assert.equal((await tileImage(page, 'k1')).kind, 'none');
		assert.equal(await page.locator(`.tile[data-entry] .card-back`).count(), 1, 'the Korean card has no image yet');

		await page.evaluate(() => window.H.openDetail('e1'));
		await page.waitForSelector('.ph-carousel .ph-slide img');
		assert.equal(await page.locator('.ph-carousel .ph-slide').count(), 1);
		assert.equal(await page.locator('.ph-dots').isHidden(), true, 'no dots for one image');
		assert.equal(await page.locator('.ph-use-main').isHidden(), true, 'nothing to choose between');
		assert.equal(await page.locator('.ph-source').first().textContent(), 'Official');
		assert.equal(await page.locator('.ph-add').isVisible(), true);
		await shot(page, '1-detail-official');
	});

	test('picking a photo of the card on a dark table finds its four corners', async () => {
		const {page} = phone;

		await pickPhoto(page, QUAD);
		await shot(page, '2-editor-detected');

		const found = await corners(page);
		const stage = await page.$eval('.ph-stage', (el) => ({found: el.dataset.found, method: el.dataset.method}));
		const errors = found.map((p, i) => Math.hypot(p.x - QUAD[i].x, p.y - QUAD[i].y));

		console.log(`# detected by ${stage.method}; corner errors in px of a 1200 x 1600 photo: ${errors.map((e) => e.toFixed(1)).join(', ')}`);
		assert.equal(stage.found, 'true');

		// 1.5 percent of the photo's diagonal is 30 px.
		for (const [i, e] of errors.entries()) {
			assert.ok(e < 30, `corner ${i} is ${e.toFixed(1)} px off`);
		}

		// Every handle is a 48 px touch target.
		for (const box of await page.$$eval('.ph-handle', (handles) => handles.map((handle) => handle.getBoundingClientRect().toJSON()))) {
			assert.ok(Math.round(box.width) >= 48 && Math.round(box.height) >= 48, `handle is ${box.width} x ${box.height}`);
		}
	});

	test('dragging a corner moves it and re-warps the preview live', async () => {
		const {page} = phone;
		const before = await corners(page);
		const version = Number(await page.$eval('.ph-preview', (el) => el.dataset.version));
		const box = await page.locator('.ph-handle[data-corner="1"]').boundingBox();
		const x = box.x + box.width / 2;
		const y = box.y + box.height / 2;

		await page.mouse.move(x, y);
		await page.mouse.down();

		for (let i = 1; i <= 6; i++) {
			await page.mouse.move(x - i * 4, y + i * 3);
		}

		assert.equal(await page.locator('.ph-loupe').isVisible(), true, 'the loupe shows while dragging');
		await page.mouse.up();

		const after = await corners(page);
		const scale = await page.$eval('.ph-photo', (el) => el.getBoundingClientRect().width / 1200);
		const moved = Number(await page.$eval('.ph-preview', (el) => el.dataset.version));

		assert.ok(moved > version + 1, `the preview redrew during the drag (${version} to ${moved})`);
		assert.ok(Math.abs((after[1].x - before[1].x) - (-24 / scale)) < 2, `moved left by the drag: ${after[1].x - before[1].x}`);
		assert.ok(Math.abs((after[1].y - before[1].y) - (18 / scale)) < 2, `moved down by the drag: ${after[1].y - before[1].y}`);
		assert.deepEqual(after[0], before[0], 'the other corners stay');
		await shot(page, '3-editor-dragged');

		// Back to the detected corners, then save.
		await page.click('.ph-reset');
		assert.deepEqual(await corners(page), before);
	});

	test('Save stores a 600 x 840 WebP of about 80 KB, on the phone and in the bucket', async () => {
		const {page} = phone;

		await save(page);

		const entry = await entryOf(page, 'e1');

		assert.equal(entry.photos.length, 1);
		firstPhoto = entry.photos[0];
		assert.equal(firstPhoto.side, 'front');
		assert.equal(firstPhoto.deleted_at, null);
		assert.equal(firstPhoto.path, `${owner.id}/${entry.id}/${firstPhoto.id}.webp`);
		assert.equal(entry.main_image, undefined, 'no pin yet: the default order applies');

		const info = await page.evaluate((id) => window.H.photoInfo(id), firstPhoto.id);

		console.log(`# saved photo: ${info.width} x ${info.height} ${info.type}, ${(info.bytes / 1024).toFixed(1)} KB`);
		assert.equal(info.width, 600);
		assert.equal(info.height, 840);
		assert.equal(info.type, 'image/webp');
		assert.ok(info.bytes > 20 * 1024 && info.bytes < 140 * 1024, `about 80 KB, got ${info.bytes}`);

		await page.waitForFunction(() => window.H.store.pendingUploads().size === 0);

		const object = fake.objects.get(firstPhoto.path);

		assert.ok(object, 'uploaded to card-photos');
		assert.equal(object.contentType, 'image/webp');
		assert.equal(object.bytes.length, info.bytes);
		assert.equal(object.owner, owner.id);
	});

	test('the carousel shows the official image, then the photo, with dots, labels, and full screen', async () => {
		const {page} = phone;

		await page.waitForFunction(() => document.querySelectorAll('.ph-carousel .ph-slide').length === 2);
		await page.waitForSelector('.ph-slide[data-slide]:nth-child(2) img');

		assert.equal(await page.locator('.ph-dot').count(), 2);
		assert.deepEqual(await page.locator('.ph-source').allTextContents(), ['Official', 'Your photo']);
		assert.equal(await page.locator('.ph-carousel').getAttribute('data-index'), '1', 'opens on the new photo');
		await shot(page, '4-carousel-photo');

		await page.locator('.ph-dot').first().click();
		assert.equal(await page.locator('.ph-carousel').getAttribute('data-index'), '0');
		assert.equal(await page.locator('.ph-use-main').textContent(), 'Main image', 'the official image is the main image');

		// Tap opens full screen; Escape closes it.
		await page.locator('.ph-viewport').click();
		await page.waitForSelector('.ph-full');
		assert.match(await page.locator('.ph-full-label').textContent(), /^1 of 2 · Official$/);
		await shot(page, '5-full-screen');
		await page.keyboard.press('Escape');
		await page.waitForSelector('.ph-full', {state: 'detached'});
	});

	test('swiping the carousel changes the image and never reaches the page\'s own swipe', async () => {
		const {page} = phone;
		const box = await page.locator('.ph-viewport').boundingBox();
		const y = box.y + box.height / 2;

		await page.mouse.move(box.x + box.width - 20, y);
		await page.mouse.down();

		for (let i = 1; i <= 10; i++) {
			await page.mouse.move(box.x + box.width - 20 - i * 18, y + i);
		}

		await page.mouse.up();
		assert.equal(await page.locator('.ph-carousel').getAttribute('data-index'), '1');

		const counts = await page.evaluate(() => ({...window.H.counts}));

		assert.equal(counts.pageSwipes, 0, 'the page saw no swipe');
		assert.equal(counts.pagePointerMovesFromCarousel, 0, 'no pointer move left the carousel');
		assert.equal(counts.carouselSwipes, 1, 'the page was told the carousel used a swipe');

		// The same drag on the page itself is a page swipe (the stand-in works).
		const area = await page.locator('#page-area').boundingBox();

		await page.mouse.move(area.x + area.width - 10, area.y + area.height / 2);
		await page.mouse.down();
		await page.mouse.move(area.x + 20, area.y + area.height / 2, {steps: 8});
		await page.mouse.up();
		assert.equal(await page.evaluate(() => window.H.counts.pageSwipes), 1);
	});

	test('"Use as main image" pins the photo, and the tile draws it', async () => {
		const {page} = phone;

		assert.equal(await page.locator('.ph-use-main').textContent(), 'Use as main image');
		await page.click('.ph-use-main');
		await page.waitForFunction(() => document.querySelector('.ph-use-main').textContent === 'Main image');

		const entry = await entryOf(page, 'e1');

		assert.equal(entry.main_image, firstPhoto.id);
		await page.evaluate(() => window.H.drawTiles());
		await waitForTilePhoto(page, 'e1');
		assert.equal((await tileImage(page, 'e1')).kind, 'photo');
		await shot(page, '6-main-image');
	});

	test('the Korean card with no official image shows its photo on the tile by default', async () => {
		const {page} = phone;

		await page.evaluate(() => window.H.openDetail('k1'));
		await page.waitForSelector('.ph-carousel .card-back');
		await pickPhoto(page, QUAD);
		await save(page);
		await page.waitForSelector('.ph-carousel .ph-slide img');
		assert.equal(await page.locator('.ph-dots').isHidden(), true, 'one image, no dots');
		await page.evaluate(() => window.H.drawTiles());
		await waitForTilePhoto(page, 'k1');

		const entry = await entryOf(page, 'k1');

		assert.equal(entry.main_image, undefined, 'no pin needed');
		assert.equal((await tileImage(page, 'k1')).kind, 'photo');
		await page.waitForFunction(() => window.H.store.pendingUploads().size === 0);
		assert.equal(fake.objects.size, 2);
		await shot(page, '7-korean-tile');
	});

	test('after a reload the main image and the photos are still there', async () => {
		const {page} = phone;

		await open(page);
		await waitForTilePhoto(page, 'e1');
		await waitForTilePhoto(page, 'k1');
		await page.evaluate(() => window.H.openDetail('e1'));
		await page.waitForFunction(() => document.querySelectorAll('.ph-carousel .ph-slide img').length === 2);
		assert.equal(await page.locator('.ph-card').getAttribute('data-main'), firstPhoto.id);
	});

	test('offline, the app reopens and shows the photos from the phone, asking the server for nothing', async () => {
		const {context, page} = phone;
		const downloads = fake.storageLog('download').length;

		offline = true;
		fake.offline = true;
		await context.setOffline(true);
		await open(page);
		assert.equal(await page.evaluate(() => navigator.onLine), false);
		await waitForTilePhoto(page, 'e1');
		await waitForTilePhoto(page, 'k1');
		await page.evaluate(() => window.H.openDetail('e1'));
		await page.waitForFunction(() => document.querySelectorAll('.ph-carousel .ph-slide img').length === 2);
		assert.equal(fake.storageLog('download').length, downloads);
		assert.deepEqual(fake.offlineAttempts.filter((attempt) => attempt.path.startsWith('/storage/')), [], 'no storage request while offline');
		await shot(page, '8-offline');
	});

	test('a photo taken offline waits on the phone and uploads when the signal comes back', async () => {
		const {context, page} = phone;
		const objects = fake.objects.size;

		await page.evaluate(() => window.H.openDetail('k1'));
		await page.waitForSelector('.ph-carousel .ph-slide img');
		await pickPhoto(page, BACK_QUAD, {side: 'back'});
		await save(page);

		await page.waitForFunction(() => document.querySelectorAll('.ph-carousel .ph-slide').length === 2);
		assert.equal(await page.evaluate(() => window.H.store.pendingUploads().size), 1);
		assert.deepEqual(await page.locator('.ph-source').allTextContents(), ['Your photo', 'Your photo, back']);
		assert.equal(await page.locator('.ph-slide:nth-child(2) .ph-pending').isVisible(), true, 'marked as waiting to upload');
		assert.equal(fake.objects.size, objects, 'nothing reached the server');

		const entry = await entryOf(page, 'k1');
		const back = entry.photos.find((photo) => photo.side === 'back');

		assert.equal(back.path, `${owner.id}/${entry.id}/${back.id}.webp`);
		await shot(page, '9-offline-waiting');

		// Signal again: the queue flushes by itself.
		offline = false;
		fake.offline = false;
		await context.setOffline(false);
		await page.waitForFunction(() => window.H.store.pendingUploads().size === 0, null, {timeout: 10000});
		assert.equal(fake.objects.size, objects + 1);
		assert.ok(fake.objects.has(back.path));
		await page.waitForFunction(() => !document.querySelector('.ph-waiting'));
		assert.equal(await page.locator('.ph-pending:visible').count(), 0);
	});

	test('a photo not on this phone is fetched from the bucket once, then kept', async () => {
		const {page} = phone;
		const downloads = fake.storageLog('download').length;

		await page.evaluate(async (id) => window.H.store.forgetLocalPhoto(id), firstPhoto.id);
		await page.evaluate(() => window.H.drawTiles());
		await waitForTilePhoto(page, 'e1');
		assert.equal(fake.storageLog('download').length, downloads + 1);
		assert.ok(await page.evaluate((id) => window.H.store.localPhoto(id).then(Boolean), firstPhoto.id), 'kept on the phone');
	});

	test('removing a photo tombstones it, clears the pin, and deletes it from the bucket after the grace period', async () => {
		const {page} = phone;

		await page.evaluate(() => window.H.openDetail('e1'));
		await page.waitForFunction(() => document.querySelectorAll('.ph-carousel .ph-slide img').length === 2);
		await page.locator('.ph-dot').nth(1).click();
		await page.locator('.ph-viewport').click();
		await page.waitForSelector('.ph-full-remove');
		page.once('dialog', (dialog) => dialog.accept());
		await page.click('.ph-full-remove');
		await page.waitForFunction(() => document.querySelectorAll('.ph-carousel .ph-slide').length === 1);

		const entry = await entryOf(page, 'e1');

		assert.ok(entry.photos[0].deleted_at, 'kept as a tombstone');
		assert.equal(entry.main_image, null, 'the pin went with it');
		await page.waitForFunction(() => window.H.store.pendingUploads().size === 0);
		assert.equal(await page.evaluate((id) => window.H.store.localPhoto(id).then(Boolean), firstPhoto.id), false, 'the phone\'s copy goes at once');

		// The bucket's copy waits 14 days, for phones that may still show it.
		const [row] = await page.evaluate(() => window.H.store.queuedItems());
		const days = (row.not_before - row.at) / (24 * 60 * 60 * 1000);

		assert.equal(row.op, 'delete');
		assert.equal(row.path, firstPhoto.path);
		assert.equal(days, 14);
		await page.evaluate(() => window.H.store.flushQueue());
		assert.ok(fake.objects.has(firstPhoto.path), 'still in the bucket during the grace period');

		// Once the grace period has passed and the server holds the removal,
		// the file goes.
		await page.evaluate(() => window.H.expireDeletes());
		await until(page, async () => (await window.H.store.queuedItems()).length === 0);
		assert.equal(fake.objects.has(firstPhoto.path), false);
	});

	test('nothing on the page logged an error', () => {
		assert.deepEqual(phone.errors, []);
	});
});

describe('signed out', () => {
	test('a photo taken signed out waits, goes up under the account that signs in, and survives a sync that drops it', async () => {
		const fake = new FakeStorageSupabase();
		const user = fake.addUser('later@example.test');
		const {context, errors, page} = await device(fake, null, {offline: () => false});

		await open(page);
		await page.evaluate(() => window.H.openDetail('e1'));
		await pickPhoto(page, QUAD);
		await save(page);

		let entry = await entryOf(page, 'e1');

		assert.equal(entry.photos[0].path, null, 'no account yet, so no folder');
		assert.equal(await page.evaluate(() => window.H.store.pendingUploads().size), 1);
		assert.deepEqual(fake.log.filter((item) => item.storage), [], 'nothing sent signed out');
		// Signed out, the photo says when it will upload (Q-32).
		await page.waitForFunction(() => {
			const badge = document.querySelector('.ph-slide .ph-pending:not([hidden])');

			return badge && badge.textContent === 'Saved on this phone; uploads after you sign in';
		});
		await shot(page, '11-signed-out-waiting');

		// Signing in adopts the phone's document; the queue then uploads.
		await page.evaluate((session) => localStorage.setItem('card-tracker-auth', session), JSON.stringify(fake.session(user)));
		await page.evaluate(() => window.H.start());
		await page.waitForFunction(() => window.H.store.pendingUploads().size === 0, null, {timeout: 10000});

		entry = await entryOf(page, 'e1');
		assert.equal(entry.photos[0].path, `${user.id}/${entry.id}/${entry.photos[0].id}.webp`);
		assert.ok(fake.objects.has(entry.photos[0].path));

		// Another phone that never saw the photo saves a newer edit of the
		// card; entries merge whole, so the sync drops the photo, and this
		// phone puts it back.
		const photoId = entry.photos[0].id;

		await page.evaluate(async (edited) => {
			const {mergeIntoLocal} = await import('/pokemon-card-tracker/js/collection.js');

			await mergeIntoLocal({cards: [edited]});
		}, {...entry, condition: 'Near Mint', photos: [], updated_at: new Date(Date.now() + 60000).toISOString()});
		await until(page, async (id) => {
			const card = (await window.H.listCards()).find((item) => item.id === window.H.ids().e1);

			return card.condition === 'Near Mint' && (card.photos || []).some((photo) => photo.id === id);
		}, photoId);
		assert.deepEqual(errors, []);
		await context.close();
	});
});

describe('uploads the server refuses', () => {
	const badge = (page) => page.evaluate(() => {
		const shown = document.querySelector('.ph-slide .ph-pending:not([hidden])');

		return shown ? {problem: shown.classList.contains('ph-problem'), text: shown.textContent} : null;
	});

	async function photoOn(page) {
		await open(page);
		await page.evaluate(() => window.H.openDetail('e1'));
		await pickPhoto(page, QUAD);
		await save(page);
	}

	test('a refused upload says why on the photo, and Retry sends it again', async () => {
		const fake = new FakeStorageSupabase();
		const user = fake.addUser('owner@example.test');
		const {context, errors, page} = await device(fake, user, {offline: () => false});

		fake.refuse = {error: 'Payload too large', message: 'The object exceeded the maximum allowed size', status: 413};
		await photoOn(page);
		await page.waitForFunction(() => {
			const shown = document.querySelector('.ph-slide .ph-pending:not([hidden])');

			return shown && shown.classList.contains('ph-problem');
		}, null, {timeout: 10000});
		assert.deepEqual(await badge(page), {problem: true, text: 'Not uploaded: too large for the server'});
		await shot(page, '12-refused');

		const failed = await page.evaluate(() => window.H.store.failedUploads());

		assert.equal(failed.length, 1);
		assert.equal(failed[0].kind, 'refused');
		assert.equal(failed[0].text, 'Not uploaded: too large for the server');

		// Refused is not retried on a timer; Retry sends it once the server
		// takes it.
		fake.refuse = null;
		await page.evaluate((id) => window.H.store.retryUpload(id), failed[0].photo_id);
		await page.waitForFunction(() => window.H.store.pendingUploads().size === 0, null, {timeout: 10000});
		await page.waitForFunction(() => !document.querySelector('.ph-slide .ph-pending:not([hidden])'));
		assert.equal(fake.objects.size, 1);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a 401 is not permanent: the session is refreshed and the photo goes up without waiting for the next start', async () => {
		const fake = new FakeStorageSupabase();
		const user = fake.addUser('owner@example.test');
		const {context, errors, page} = await device(fake, user, {offline: () => false});

		await open(page);

		const refreshes = fake.log.filter((item) => item.search === '?grant_type=refresh_token').length;

		fake.refuse = {error: 'Unauthorized', message: 'jwt expired', once: true, status: 401};
		await page.evaluate(() => window.H.openDetail('e1'));
		await pickPhoto(page, QUAD);
		await save(page);
		// Well inside the 30 s retry timer.
		await page.waitForFunction(() => window.H.store.pendingUploads().size === 0, null, {timeout: 10000});
		assert.equal(fake.storageLog('upload').length, 2, 'refused once, then sent again');
		assert.ok(fake.log.filter((item) => item.search === '?grant_type=refresh_token').length > refreshes, 'the session was refreshed');
		assert.equal(fake.objects.size, 1);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a session the server ended says Sign in again on the photo, and the photo goes up after a new sign-in', async () => {
		const fake = new FakeStorageSupabase();
		const user = fake.addUser('member-a@family.invalid', {password: 'first-password'});
		const {context, errors, page} = await device(fake, user, {offline: () => false});

		await open(page);
		fake.revoke(user.id);
		await page.evaluate(() => window.H.openDetail('e1'));
		await pickPhoto(page, QUAD);
		await save(page);
		await page.waitForFunction(() => {
			const shown = document.querySelector('.ph-slide .ph-pending:not([hidden])');

			return shown && shown.textContent === 'Sign in again to upload';
		}, null, {timeout: 15000});
		assert.equal(fake.objects.size, 0);
		assert.equal((await page.evaluate(() => window.H.store.failedUploads()))[0].kind, 'auth');

		await page.evaluate(async () => (await import('/pokemon-card-tracker/js/auth.js')).signInWithName('member-a', 'first-password'));
		await page.waitForFunction(() => window.H.store.pendingUploads().size === 0, null, {timeout: 15000});
		assert.equal(fake.objects.size, 1);
		assert.deepEqual(errors.filter((text) => !/40[13]/.test(text)), []);
		await context.close();
	});
});

describe('duplicate copies', () => {
	test('a photo on a collapsed duplicate still uploads, under the survivor', async () => {
		const fake = new FakeStorageSupabase();
		const user = fake.addUser('dupes@example.test');
		let offline = false;
		const {context, errors, page} = await device(fake, user, {offline: () => offline});
		const key = 'monprice|me01_int_001|en|NORMAL|0';

		await open(page);

		// This copy came from an import; another phone imported the same row
		// earlier, which this phone has not seen yet.
		const e1 = await page.evaluate(async (importKey) => {
			const {updateCards} = await import('/pokemon-card-tracker/js/collection.js');
			const [entry] = await updateCards([{id: window.H.ids().e1, patch: {import_key: importKey}}]);

			return entry;
		}, key);

		offline = true;
		fake.offline = true;
		await context.setOffline(true);
		await page.evaluate(() => window.H.openDetail('e1'));
		await pickPhoto(page, QUAD);
		await save(page);
		assert.equal(await page.evaluate(() => window.H.store.pendingUploads().size), 1);

		const taken = (await entryOf(page, 'e1')).photos[0];

		// The sync brings the older copy in, and the merge folds this one
		// into it.
		await page.evaluate(async ({entry, importKey}) => {
			const {mergeIntoLocal} = await import('/pokemon-card-tracker/js/collection.js');
			const older = '2026-01-01T00:00:00.000Z';

			await mergeIntoLocal({cards: [{
				card_id: entry.card_id, catalog: entry.catalog, created_at: older, deleted_at: null, id: 'older-copy',
				import_key: importKey, language: entry.language, language_source: 'import', updated_at: older,
			}]});
		}, {entry: e1, importKey: key});

		const folded = await page.evaluate(async (id) => (await window.H.loadDocument()).cards.find((card) => card.id === id), e1.id);

		assert.equal(folded.merged_into, 'older-copy');

		offline = false;
		fake.offline = false;
		await context.setOffline(false);
		await page.waitForFunction(() => window.H.store.pendingUploads().size === 0, null, {timeout: 10000});

		const survivor = await page.evaluate(async () => (await window.H.listCards()).find((card) => card.id === 'older-copy'));
		const moved = survivor.photos.find((item) => item.id === taken.id);

		assert.ok(moved, 'the survivor holds the photo');
		assert.equal(moved.path, taken.path, 'it keeps the folder it was taken in');
		assert.ok(fake.objects.has(taken.path), 'and it reached the bucket');
		assert.deepEqual(errors, []);
		await context.close();
	});
});

describe('housekeeping', () => {
	test('a deleted card\'s photo leaves the phone, and the bucket after the grace period', async () => {
		const fake = new FakeStorageSupabase();
		const user = fake.addUser('sweep@example.test');
		const {context, errors, page} = await device(fake, user, {offline: () => false});

		await open(page);
		await page.evaluate(() => window.H.openDetail('e1'));
		await pickPhoto(page, QUAD);
		await save(page);
		await page.waitForFunction(() => window.H.store.pendingUploads().size === 0, null, {timeout: 10000});

		const taken = (await entryOf(page, 'e1')).photos[0];

		assert.ok(fake.objects.has(taken.path));
		await page.evaluate(async (id) => {
			const {deleteCard} = await import('/pokemon-card-tracker/js/collection.js');

			await deleteCard(id);
			await window.H.sync.syncNow();
		}, await page.evaluate(() => window.H.ids().e1));

		await until(page, async (id) => !(await window.H.store.localPhoto(id)), taken.id);
		await until(page, async () => (await window.H.store.queuedItems()).some((row) => row.op === 'delete'));

		const [row] = await page.evaluate(() => window.H.store.queuedItems());

		assert.equal(row.photo_id, taken.id);
		assert.ok(fake.objects.has(taken.path), 'the bucket keeps it during the grace period');

		await page.evaluate(() => window.H.expireDeletes());
		await until(page, async () => (await window.H.store.queuedItems()).length === 0);
		assert.equal(fake.objects.has(taken.path), false);

		// Queued once: a later sync does not queue it again.
		await page.evaluate(() => window.H.sync.syncNow());
		await page.evaluate(() => window.H.store.sweepPhotos());
		assert.deepEqual(await page.evaluate(() => window.H.store.queuedItems()), []);
		assert.deepEqual(errors, []);
		await context.close();
	});
});

describe('the camera', () => {
	test('Take photo opens the rear camera with the guide frame, and a capture goes to the corner editor', async () => {
		const fake = new FakeStorageSupabase();
		const user = fake.addUser('camera@example.test');
		const {context, errors, page} = await device(fake, user, {offline: () => false});

		await open(page);
		await page.evaluate(() => window.H.openDetail('e1'));
		await page.click('.ph-add');
		await page.click('.ph-take');
		await page.waitForSelector('.ph-shutter:not([disabled])');

		const guide = await page.locator('.ph-guide').boundingBox();

		assert.ok(guide.width > 50 && guide.height > guide.width, 'a portrait guide frame');
		await shot(page, '10-camera');
		await page.click('.ph-shutter');
		await page.waitForSelector('.ph-stage .ph-handle');
		assert.equal(await page.locator('.ph-handle').count(), 4);
		await page.keyboard.press('Escape');
		await page.waitForSelector('.ph-sheet', {state: 'detached'});
		assert.deepEqual(errors, []);
		await context.close();
	});
});
