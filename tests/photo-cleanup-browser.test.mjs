// Browser test for the offer to delete photos once the catalog has an image
// (js/photo-cleanup-view.js): the notice, Not now, Review with its ticks,
// Delete through the normal removal, and Undo. Headless Chromium at
// 360 x 740 on tests/photos-harness.mjs, the real modules over
// tests/photos-fake-storage.mjs (never the real Supabase). TCGdex is faked
// by a Playwright route: a card record and a drawn image, no network.
// Invented data only.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/photo-cleanup-browser.test.mjs

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, test} from 'node:test';

import {FakeStorageSupabase} from './photos-fake-storage.mjs';
import {HARNESS_PATH, routeHarness, startHarness} from './photos-harness.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const CARD = {card_id: 'me01-001', catalog: 'international', language: 'en'};
const IMAGE = 'https://assets.tcgdex.net/en/me/me01/001';
const ART = '<svg xmlns="http://www.w3.org/2000/svg" width="63" height="88"><rect width="63" height="88" fill="#eec834"/></svg>';

let harness;
let browser;

before(async () => {
	harness = await startHarness();
	browser = await chromium.launch();
});

after(async () => {
	await browser.close();
	await harness.close();
});

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

// The card's record: its photos and pin.
const recordOf = (page) => page.evaluate(async () => {
	const doc = await window.H.loadDocument();

	return (doc.card_info || []).find((item) => item.id === 'international~me01-001~en') || {photos: []};
});

test('the notice, Not now, Review, Delete, and Undo', async () => {
	const fake = new FakeStorageSupabase();
	const user = fake.addUser('owner@example.test');
	const context = await browser.newContext({viewport: {height: 740, width: 360}});
	const errors = [];

	await fake.attach(context, 'phone');
	await routeHarness(context, harness.origin);
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({body: ART, contentType: 'image/svg+xml', headers: {'access-control-allow-origin': '*'}}));
	await context.route('https://api.tcgdex.net/**', (route) => (route.request().url().endsWith('/v2/en/cards/me01-001')
		? route.fulfill({body: JSON.stringify({id: 'me01-001', image: IMAGE, localId: '001', name: 'Test Bulbasaur', set: {id: 'me01', name: 'Test Set'}}), contentType: 'application/json'})
		: route.fulfill({status: 404})));
	await context.addInitScript((value) => {
		if (!localStorage.getItem('card-tracker-auth')) {
			localStorage.setItem('card-tracker-auth', value);
		}
	}, JSON.stringify(fake.session(user)));

	const page = await context.newPage();

	page.on('pageerror', (err) => errors.push(String(err)));

	try {
		await page.goto(`${harness.origin}${HARNESS_PATH}`);
		await page.waitForFunction(() => document.body.dataset.ready);
		assert.equal(await page.evaluate(() => document.body.dataset.ready), 'true', await page.evaluate(() => document.body.dataset.error));

		// Two uploaded photos of the card, the back one pinned as its main
		// image; the card index recorded it with no image, and the refreshed
		// TCGdex record now has one.
		await page.evaluate(async ({base, card}) => {
			const {newId, updateCardInfo} = await import(`${base}js/collection.js`);
			const {newPhoto} = await import(`${base}js/photos/model.js`);
			const catalog = await import(`${base}js/catalog.js`);
			const canvas = document.createElement('canvas');

			canvas.width = 60;
			canvas.height = 84;
			canvas.getContext('2d').fillRect(0, 0, 60, 84);

			const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.8));
			const front = newPhoto({created_at: new Date().toISOString(), id: newId(), side: 'front'});
			const back = newPhoto({created_at: new Date().toISOString(), id: newId(), side: 'back'});

			await window.H.store.addPhotoToCard(card, front, blob);
			await window.H.store.addPhotoToCard(card, back, blob);
			await updateCardInfo([card], () => ({main_image: back.id}));
			await catalog.saveToCardIndex([{catalog: 'international', id: card.card_id, localizations: {en: {image: null, lang: 'en', name: 'Test Bulbasaur', set_name: 'Test Set'}}, set_id: 'me01'}]);
			await catalog.cardDetail('en', card.card_id);

			const toasts = document.createElement('div');

			toasts.id = 'toasts';
			toasts.className = 'toasts';
			document.body.append(toasts);
			window.cleanup = await import(`${base}js/photo-cleanup-view.js`);
		}, {base: BASE, card: CARD});
		await until(page, async () => {
			const doc = await window.H.loadDocument();
			const record = (doc.card_info || []).find((item) => item.id === 'international~me01-001~en');

			return record && record.photos.length === 2 && record.photos.every((photo) => photo.path);
		});

		const [front, back] = (await recordOf(page)).photos;

		// The notice, then Not now: not shown again for the same card.
		assert.equal(await page.evaluate(() => window.cleanup.offerPhotoCleanup()), 1);
		assert.equal(await page.textContent('#photo-cleanup-notice .toast-text'), '1 card now has an official image. You can delete your 2 photos of it to save space.');
		await page.click('#photo-cleanup-notice >> text=Not now');
		assert.equal(await page.$('#photo-cleanup-notice'), null);
		assert.equal(await page.evaluate(() => window.cleanup.offerPhotoCleanup()), 0, 'Not now holds for the same card');

		// As if another card had gained an image since: offered again.
		await page.evaluate(() => {
			for (const key of Object.keys(localStorage).filter((name) => name.startsWith('card-tracker-photo-cleanup:'))) {
				localStorage.removeItem(key);
			}
		});
		assert.equal(await page.evaluate(() => window.cleanup.offerPhotoCleanup()), 1);

		// Review: official image and photo side by side, the pinned photo
		// unticked.
		await page.click('#photo-cleanup-notice >> text=Review');
		await page.waitForSelector('#photo-cleanup-sheet[open]');

		const ticks = await page.$$eval('.pc-tick', (boxes) => boxes.map((box) => [box.dataset.photo, box.checked]));

		assert.deepEqual(ticks, [[front.id, true], [back.id, false]]);
		assert.equal(await page.$$eval('.pc-row .pc-official', (imgs) => imgs.length), 2);
		assert.equal(await page.textContent('.pc-delete'), 'Delete 1 photo');
		await page.screenshot({path: `${process.env.SHOTS || '/tmp'}/photo-cleanup-review.png`});

		// Delete: through the normal removal, the bucket file queued for 14
		// days from now.
		await page.click('.pc-delete');
		await page.waitForSelector('#photo-cleanup-sheet', {state: 'detached'});

		const removed = await recordOf(page);

		assert.ok(removed.photos.find((photo) => photo.id === front.id).deleted_at, 'the front photo is removed');
		assert.ok(!removed.photos.find((photo) => photo.id === back.id).deleted_at, 'the pinned photo stays');
		assert.equal(removed.main_image, back.id);

		const row = await page.evaluate(async (id) => (await window.H.store.queuedItems()).find((item) => item.photo_id === id && item.op === 'delete'), front.id);
		const days = (row.not_before - Date.now()) / (24 * 60 * 60 * 1000);

		assert.ok(days > 13.9 && days <= 14, `the bucket delete waits 14 days (${days})`);
		assert.equal(await page.evaluate(async () => {
			const catalog = await import('/pokemon-card-tracker/js/catalog.js');

			return (await catalog.cardIndex()).get('international|me01-001').localizations.en.image;
		}), IMAGE, 'the tile shows the official image now');

		// Undo: the photo is back on the same file, and the bucket delete is
		// cancelled at the next flush.
		await page.click('.toast >> text=Undo');
		await until(page, async (path) => {
			const doc = await window.H.loadDocument();
			const record = doc.card_info.find((item) => item.id === 'international~me01-001~en');

			return record.photos.some((photo) => !photo.deleted_at && photo.path === path);
		}, front.path);
		await page.evaluate(() => window.H.store.flushQueue());
		await until(page, async (id) => !(await window.H.store.queuedItems()).some((item) => item.photo_id === id && item.op === 'delete'), front.id);
		assert.equal(await page.evaluate(() => window.cleanup.offerPhotoCleanup()), 0, 'the card was offered: no notice again');
		assert.deepEqual(errors, []);
	}
	finally {
		await context.close();
	}
});
