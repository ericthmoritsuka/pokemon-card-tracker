// Browser tests for Adjust on the owner's photos (DESIGN.md section 5,
// "Adjust a photo"): open a card with photos, Adjust one, Auto, Save; the
// card shows the new photo in the same place with the pin and an adjusted
// detail copy; Undo edit brings the old photo back exactly, and a sync
// keeps it; an adjusted photo taken offline waits to upload; Cancel changes
// nothing; a family member's photo and a member's read-only card have no
// Adjust. Headless Chromium at 360 x 740 against tests/photos-harness.mjs.
//
// Supabase is tests/photos-fake-storage.mjs, never the real project. The
// photos are invented: dark gradients drawn in the page.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/photo-adjust-browser.test.mjs

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {FakeStorageSupabase} from './photos-fake-storage.mjs';
import {HARNESS_PATH, routeHarness, startHarness} from './photos-harness.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const VIEWPORT = {height: 740, width: 360};
const SHOTS = process.env.SHOTS || '/tmp';

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

async function device(fake, user, {offline}) {
	const context = await browser.newContext({viewport: VIEWPORT});
	const errors = [];

	await fake.attach(context, 'phone');
	await routeHarness(context, harness.origin, {offline});
	// No catalog image: the official slide is a stand-in that never loads.
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));

	const session = fake.session(user);

	await context.addInitScript((value) => {
		if (!localStorage.getItem('card-tracker-auth')) {
			localStorage.setItem('card-tracker-auth', value);
		}
	}, JSON.stringify(session));

	const page = await context.newPage();

	page.on('pageerror', (err) => errors.push(String(err)));
	page.on('console', (message) => {
		if (message.type() === 'error' && !/Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(message.text())) {
			errors.push(message.text());
		}
	});

	return {context, errors, page};
}

// Polls an async check in the page until it is true.
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

// The English card's record, which holds its photos and pin.
const record = (page) => page.evaluate(async () => {
	const doc = await window.H.loadDocument();
	const copy = doc.cards.find((card) => card.id === window.H.ids().e1);
	const id = `${copy.catalog || 'international'}~${copy.card_id}~${copy.language || ''}`;

	return (doc.card_info || []).find((item) => item.id === id) || {id, photos: []};
});

const slideIds = (page) => page.$$eval('.ph-card .ph-slide[data-slide]', (nodes) => nodes.map((node) => node.dataset.slide));

// The mean brightness (0 to 255) of a file on the phone, or null.
const brightness = (page, key) => page.evaluate(async (k) => {
	const blob = await window.H.store.localPhoto(k);

	if (!blob) {
		return null;
	}

	const bitmap = await createImageBitmap(blob);
	const canvas = document.createElement('canvas');

	canvas.width = bitmap.width;
	canvas.height = bitmap.height;

	const ctx = canvas.getContext('2d');

	ctx.drawImage(bitmap, 0, 0);

	const {data} = ctx.getImageData(0, 0, canvas.width, canvas.height);
	let sum = 0;

	for (let i = 0; i < data.length; i += 4) {
		sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
	}

	return {mean: sum / (data.length / 4), width: bitmap.width};
}, key);

// Two dark front photos of the English card, the first with a detail copy,
// saved the way Add photo saves them.
async function seedPhotos(page) {
	return page.evaluate(async () => {
		const {savePhoto} = await import('/pokemon-card-tracker/js/photos/index.js');

		const draw = async (width, height, tint) => {
			const canvas = document.createElement('canvas');

			canvas.width = width;
			canvas.height = height;

			const ctx = canvas.getContext('2d');
			const fill = ctx.createLinearGradient(0, 0, width, height);

			fill.addColorStop(0, `rgb(${10 + tint}, 12, 20)`);
			fill.addColorStop(0.5, `rgb(70, ${50 + tint}, 30)`);
			fill.addColorStop(1, 'rgb(30, 60, 85)');
			ctx.fillStyle = fill;
			ctx.fillRect(0, 0, width, height);
			ctx.fillStyle = 'rgb(90, 80, 70)';
			ctx.fillRect(width * 0.1, height * 0.1, width * 0.8, height * 0.45);

			return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
		};

		const doc = await window.H.loadDocument();
		const copy = doc.cards.find((card) => card.id === window.H.ids().e1);
		const detail = await draw(1440, 2016, 0);
		const first = await savePhoto({blob: await draw(600, 840, 0), detail: {blob: detail, height: 2016, type: detail.type, width: 1440}, entry: copy, side: 'front', type: 'image/webp'});

		await new Promise((resolve) => setTimeout(resolve, 5));

		const second = await savePhoto({blob: await draw(600, 840, 20), entry: copy, side: 'front', type: 'image/webp'});

		return {first, second};
	});
}

async function openCard(page) {
	await page.evaluate(() => window.H.openDetail('e1'));
	await page.waitForSelector('.ph-card .ph-slide[data-slide]');
}

// The toasts box the app's index.html has (js/shell.js toast).
const addToasts = (page) => page.evaluate(() => {
	if (!document.getElementById('toasts')) {
		document.body.append(Object.assign(document.createElement('div'), {className: 'toasts', id: 'toasts'}));
	}
});

async function showSlide(page, id) {
	const index = (await slideIds(page)).indexOf(id);

	assert.ok(index >= 0, `slide ${id}`);
	await page.click(`.ph-dot >> nth=${index}`);
	await page.waitForFunction((i) => document.querySelector('.ph-card .ph-carousel').dataset.index === String(i), index);
}

async function openAdjust(page) {
	assert.equal(await page.isVisible('.ph-adjust-open'), true, 'Adjust shows under the photo');
	await page.click('.ph-adjust-open');
	await page.waitForSelector('.ph-adjust-preview');
}

const setSlider = (page, key, value) => page.evaluate(([k, v]) => {
	const input = document.querySelector(`.ph-adjust-slider[data-key="${k}"]`);

	input.value = String(v);
	input.dispatchEvent(new Event('input', {bubbles: true}));
}, [key, value]);

describe('Adjust a photo', () => {
	const fake = new FakeStorageSupabase();
	const owner = fake.addUser('owner@example.test');
	let offline = false;
	let phone;
	let first;
	let second;
	let adjusted;

	before(async () => {
		phone = await device(fake, owner, {offline: () => offline});
	});

	after(async () => {
		await phone.context.close();
	});

	test('two photos on a card, the first pinned as the main image', async () => {
		const {page} = phone;

		await page.goto(`${harness.origin}${HARNESS_PATH}`);
		await page.waitForFunction(() => document.body.dataset.ready);
		assert.equal(await page.evaluate(() => document.body.dataset.ready), 'true');
		await addToasts(page);

		({first, second} = await seedPhotos(page));
		await until(page, (ids) => window.H.store.pendingUploads().size === 0 && ids.length, [first.id]);
		await openCard(page);
		assert.deepEqual(await slideIds(page), ['official', first.id, second.id]);

		await showSlide(page, first.id);
		await page.click('.ph-use-main');
		await until(page, (id) => document.querySelector('.ph-card').dataset.main === id, first.id);
		assert.equal((await record(page)).main_image, first.id);
		assert.equal(await page.isVisible('.ph-adjust-open'), true);

		// Not on the official image.
		await showSlide(page, 'official');
		assert.equal(await page.isVisible('.ph-adjust-open'), false);
	});

	test('Cancel changes nothing', async () => {
		const {page} = phone;
		const before = await record(page);

		await showSlide(page, first.id);
		await openAdjust(page);
		await setSlider(page, 'brightness', 40);
		await page.click('.ph-adjust-sheet .ph-cancel');
		await page.waitForSelector('.ph-adjust-sheet', {state: 'detached'});
		assert.deepEqual(await record(page), before);
	});

	test('Auto and Save put a brighter photo in the old one\'s place, with the pin and an adjusted detail copy', async () => {
		const {page} = phone;
		const old = await brightness(page, first.id);
		const oldDetail = await brightness(page, `${first.id}#detail`);

		await showSlide(page, first.id);
		await openAdjust(page);
		assert.equal(await page.isDisabled('.ph-adjust-save'), true, 'nothing to save yet');

		const version = await page.$eval('.ph-adjust-preview', (node) => Number(node.dataset.version));

		await page.click('.ph-adjust-auto');
		await page.waitForFunction((v) => Number(document.querySelector('.ph-adjust-preview').dataset.version) > v, version);
		assert.equal(await page.getAttribute('.ph-adjust-auto', 'aria-pressed'), 'true');

		// Before and after.
		await page.click('.ph-adjust-original');
		await page.waitForFunction(() => document.querySelector('.ph-adjust-preview').dataset.showing === 'original');
		assert.equal(await page.isVisible('.ph-adjust-badge'), true);
		await page.click('.ph-adjust-original');
		await page.waitForFunction(() => document.querySelector('.ph-adjust-preview').dataset.showing === 'adjusted');

		// Reset clears Auto; Auto again.
		await page.click('.ph-adjust-reset');
		assert.equal(await page.isDisabled('.ph-adjust-save'), true);
		await page.click('.ph-adjust-auto');
		await setSlider(page, 'warmth', 10);
		await page.screenshot({path: `${SHOTS}/photo-adjust-sheet.png`});
		await page.click('.ph-adjust-save');
		await page.waitForSelector('.ph-adjust-sheet', {state: 'detached'});

		const after = await record(page);
		const gone = after.photos.find((photo) => photo.id === first.id);

		adjusted = after.photos.find((photo) => !photo.deleted_at && photo.id !== first.id && photo.id !== second.id);
		assert.ok(adjusted, 'a new photo');
		assert.ok(gone.deleted_at, 'the old photo is removed');
		assert.equal(adjusted.side, first.side);
		assert.equal(adjusted.created_at, first.created_at);
		assert.ok(adjusted.detail && adjusted.detail.width > 600, 'the new photo has a detail copy');
		assert.deepEqual(Object.keys(adjusted).sort(), ['created_at', 'deleted_at', 'detail', 'id', 'path', 'side'], 'nothing new on the photo');
		assert.equal(after.main_image, adjusted.id, 'the pin moved');

		await until(page, (id) => document.querySelector('.ph-card').dataset.main === id, adjusted.id);
		assert.deepEqual(await slideIds(page), ['official', adjusted.id, second.id], 'same place in the carousel');

		const now = await brightness(page, adjusted.id);
		const nowDetail = await brightness(page, `${adjusted.id}#detail`);

		assert.ok(now.mean > old.mean + 30, `photo ${old.mean.toFixed(1)} -> ${now.mean.toFixed(1)}`);
		assert.ok(nowDetail && nowDetail.width > 600 && nowDetail.mean > oldDetail.mean + 30, 'the detail copy is adjusted too');
		assert.equal(await brightness(page, first.id), null, 'the old file left the phone');

		// It uploads like a new photo; the old file stays for the grace period.
		await until(page, (id) => !window.H.store.pendingUploads().has(id), adjusted.id);
		await until(page, (id) => window.H.store.queuedItems().then((rows) => !rows.some((row) => row.op !== 'delete' && row.photo_id === id)), adjusted.id);
		assert.ok(fake.objects.has(adjusted.path));
		assert.ok(fake.objects.has(first.path), 'the old file is still in the bucket');
		assert.match(await page.textContent('#toasts'), /Photo adjusted\./);
		await page.screenshot({path: `${SHOTS}/photo-adjust-saved.png`});
	});

	test('Undo edit brings the old photo back exactly, and a sync keeps it', async () => {
		const {page} = phone;

		await page.evaluate(() => window.H.sync.syncNow());
		await page.click('#toasts button:has-text("Undo edit")');
		await until(page, (id) => document.querySelector('.ph-card').dataset.main === id, first.id);

		const back = await record(page);
		const old = back.photos.find((photo) => photo.id === first.id);

		assert.equal(old.deleted_at, null);
		assert.equal(old.path, first.path);
		assert.equal(old.created_at, first.created_at);
		assert.deepEqual(old.detail, first.detail);
		assert.equal(back.main_image, first.id);
		assert.ok(back.photos.find((photo) => photo.id === adjusted.id).deleted_at, 'the adjusted photo is removed');
		assert.deepEqual(await slideIds(page), ['official', first.id, second.id]);
		assert.ok((await brightness(page, first.id)).mean > 0, 'the old file is on the phone again');
		assert.ok(await brightness(page, `${first.id}#detail`), 'and its detail copy');
		assert.equal((await page.evaluate(() => window.H.store.queuedItems())).some((row) => row.photo_id === first.id), false, 'no delete waits for the old file');

		// The server held the removal; the restore wins the merge.
		await page.evaluate(() => window.H.sync.syncNow());
		await page.waitForTimeout(300);

		const synced = await record(page);

		assert.equal(synced.photos.find((photo) => photo.id === first.id).deleted_at, null);
		assert.equal(synced.main_image, first.id);
		assert.ok(fake.objects.has(first.path));
	});

	test('offline, an adjusted photo waits to upload like a new one', async () => {
		const {context, page} = phone;
		const objects = fake.objects.size;

		offline = true;
		fake.offline = true;
		await context.setOffline(true);

		await showSlide(page, second.id);
		await openAdjust(page);
		await setSlider(page, 'brightness', 50);
		await page.click('.ph-adjust-save');
		await page.waitForSelector('.ph-adjust-sheet', {state: 'detached'});

		const after = await record(page);
		const made = after.photos.find((photo) => !photo.deleted_at && ![first.id, second.id, adjusted.id].includes(photo.id));

		assert.ok(made);
		assert.equal(await page.evaluate((id) => window.H.store.pendingUploads().has(id), made.id), true);
		assert.equal(fake.objects.size, objects, 'nothing reached the server');
		assert.deepEqual(await slideIds(page), ['official', first.id, made.id]);

		offline = false;
		fake.offline = false;
		await context.setOffline(false);
		await page.evaluate(() => window.dispatchEvent(new Event('online')));
		await until(page, (id) => !window.H.store.pendingUploads().has(id), made.id);
		assert.ok(fake.objects.has(made.path));
	});

	test('a member\'s read-only card and a family member\'s photo have no Adjust', async () => {
		const {errors, page} = phone;

		const shown = await page.evaluate(async () => {
			const {cardPhotos, photoCarousel} = await import('/pokemon-card-tracker/js/photos/index.js');
			const doc = await window.H.loadDocument();
			const copy = doc.cards.find((card) => card.id === window.H.ids().e1);
			const records = doc.card_info.filter((item) => item.card_id === copy.card_id);

			// As js/catalog-views.js memberPhotos mounts a member's card.
			const block = cardPhotos({cardId: copy.card_id, catalog: copy.catalog, entries: [copy], readOnly: true, records});
			const host = document.createElement('div');

			document.body.append(host);
			host.append(block.show({official: null}));

			const photoSlides = host.querySelectorAll('.ph-slide[data-slide]').length;
			const readOnlyAdjust = [...host.querySelectorAll('.ph-adjust-open')].some((button) => !button.hidden);

			// A family member's photo on your own card page.
			const carousel = photoCarousel({
				onAdjust: () => {},
				slides: [{by: 'Member A', entry: null, id: 'f1', kind: 'family', label: 'Photo by Member A', photo: {id: 'f1', path: 'x/f1/f1.webp'}, src: null}],
			});

			host.append(carousel.element);

			const familyAdjust = !carousel.element.querySelector('.ph-adjust-open').hidden;

			block.destroy();
			carousel.destroy();
			host.remove();

			return {familyAdjust, photoSlides, readOnlyAdjust};
		});

		assert.ok(shown.photoSlides >= 2, 'the read-only card shows the photos');
		assert.equal(shown.readOnlyAdjust, false);
		assert.equal(shown.familyAdjust, false);
		assert.deepEqual(errors, []);
	});
});
