// Browser tests for Adjust on the owner's photos (DESIGN.md section 5,
// "Adjust a photo"): open a card with photos, Adjust one, Auto, Save; the
// card shows the new photo in the same place with the pin and an adjusted
// detail copy; Undo edit brings the old photo back with its file under a
// new id, and a sync keeps it; an adjusted photo taken offline waits to
// upload; Cancel changes nothing; a family member's photo and a member's
// read-only card have no Adjust; an Undo edit that fails part way leaves the
// adjusted photo in place; Undo edit on a photo that never went up queues it
// again; Save while the old photo is still going up keeps its file's delete. Headless Chromium at 360 x 740 against tests/photos-harness.mjs.
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
	let restored;

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

	test('Undo edit brings the old photo back with its file under a new id, and a sync keeps it', async () => {
		const {page} = phone;

		await page.evaluate(() => window.H.sync.syncNow());
		await page.click('#toasts button:has-text("Undo edit")');
		await until(page, (id) => {
			const main = document.querySelector('.ph-card').dataset.main;

			return Boolean(main) && main !== id;
		}, adjusted.id);

		const back = await record(page);

		restored = back.photos.find((photo) => !photo.deleted_at && photo.path === first.path);
		assert.ok(restored, 'the old file is live again');
		assert.notEqual(restored.id, first.id, 'under a new id: a tombstone wins every merge, on v51 too');
		assert.deepEqual(Object.keys(restored).sort(), Object.keys(first).sort(), 'nothing new on the photo');
		assert.equal(restored.side, first.side);
		assert.equal(restored.created_at, first.created_at);
		assert.deepEqual(restored.detail, first.detail);
		assert.ok(back.photos.find((photo) => photo.id === first.id).deleted_at, 'the old id stays removed');
		assert.ok(back.photos.find((photo) => photo.id === adjusted.id).deleted_at, 'the adjusted photo is removed');
		assert.equal(back.main_image, restored.id, 'the pin moved back');
		assert.deepEqual(await slideIds(page), ['official', restored.id, second.id], 'in the old photo\'s place');
		assert.ok((await brightness(page, restored.id)).mean > 0, 'its file is on the phone');
		assert.ok(await brightness(page, `${restored.id}#detail`), 'and its detail copy');
		assert.equal(await page.evaluate((id) => window.H.store.pendingUploads().has(id), restored.id), false, 'nothing to upload: the file is in the bucket');

		// The server held the removal; the new id is live everywhere, and the
		// old file's waiting delete is dropped, since a live photo shows it.
		await page.evaluate(() => window.H.sync.syncNow());
		await until(page, (path) => window.H.store.queuedItems().then((rows) => !rows.some((row) => row.op === 'delete' && (row.paths || [row.path]).includes(path))), first.path);

		const synced = await record(page);

		assert.equal(synced.photos.find((photo) => photo.id === restored.id).deleted_at, null);
		assert.equal(synced.main_image, restored.id);
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
		const made = after.photos.find((photo) => !photo.deleted_at && ![restored.id, second.id, adjusted.id].includes(photo.id));

		assert.ok(made);
		assert.equal(await page.evaluate((id) => window.H.store.pendingUploads().has(id), made.id), true);
		assert.equal(fake.objects.size, objects, 'nothing reached the server');
		assert.deepEqual(await slideIds(page), ['official', restored.id, made.id]);

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

	// Saves the pinned photo adjusted, the way Save does, then Undo edit with
	// a failure at `failAt`; then Undo edit again with nothing failing.
	const failedUndo = (page, failAt) => page.evaluate(async (step) => {
		const {saveAdjustedPhoto} = await import('/pokemon-card-tracker/js/photos/index.js');
		const {neutralSettings} = await import('/pokemon-card-tracker/js/photos/adjust.js');
		const {store} = window.H;
		// A copy of the record as it is now: the document is changed in place.
		const english = async () => {
			const doc = await window.H.loadDocument();
			const copy = doc.cards.find((card) => card.id === window.H.ids().e1);

			return structuredClone(doc.card_info.find((item) => item.id === `${copy.catalog || 'international'}~${copy.card_id}~${copy.language || ''}`));
		};
		const canvas = document.createElement('canvas');

		canvas.width = 60;
		canvas.height = 84;
		canvas.getContext('2d').fillRect(0, 0, 60, 84);

		const before = await english();
		const old = before.photos.find((photo) => photo.id === before.main_image);
		const {photo, undo} = await saveAdjustedPhoto({canvas, old, record: before, settings: {...neutralSettings(), brightness: 30}});
		let error = null;

		try {
			await store.undoReplacePhoto(undo, {step: (name) => {
				if (name === step) {
					throw new Error(`failed at ${name}`);
				}
			}});
		}
		catch (err) {
			error = err.message;
		}

		const failed = await english();
		const live = failed.photos.filter((item) => !item.deleted_at);
		const files = await Promise.all(live.map(async (item) => [item.id, Boolean(await store.localPhoto(item.id))]));
		const rows = await store.queuedItems();
		const known = new Set(failed.photos.map((item) => item.id));
		const strayFile = !known.has(undo.restoredId) && Boolean(await store.localPhoto(undo.restoredId));

		await store.undoReplacePhoto(undo);

		const done = await english();
		let again = null;

		try {
			await store.undoReplacePhoto(undo);
		}
		catch (err) {
			again = err.message;
		}

		return {
			adjustedLive: live.some((item) => item.id === photo.id),
			again,
			after: (await english()).photos.filter((item) => !item.deleted_at).map((item) => item.id),
			done: {
				adjustedLive: done.photos.some((item) => item.id === photo.id && !item.deleted_at),
				file: Boolean(await store.localPhoto(undo.restoredId)),
				live: done.photos.filter((item) => !item.deleted_at && item.path === old.path).map((item) => item.id),
				main: done.main_image,
			},
			error,
			files,
			main: failed.main_image,
			oldPath: live.filter((item) => item.path === old.path).map((item) => item.id),
			photoId: photo.id,
			restoredId: undo.restoredId,
			strayFile,
			strayRows: rows.filter((row) => !known.has(row.photo_id)).map((row) => row.photo_id),
		};
	}, failAt);

	for (const step of ['photo file', 'detail file', 'queue', 'add', 'pins', 'remove']) {
		test(`an Undo edit that fails at "${step}" leaves the adjusted photo in place, and works when tried again`, async () => {
			const result = await failedUndo(phone.page, step);
			const added = ['pins', 'remove'].includes(step);

			assert.equal(result.error, `failed at ${step}`);
			assert.equal(result.adjustedLive, true, 'the adjusted photo is still there');
			assert.equal(result.main, step === 'remove' ? result.restoredId : result.photoId, 'the pin moves only once the old photo is back');
			assert.deepEqual(result.oldPath, added ? [result.restoredId] : [], 'the old photo is back only once its files are');
			assert.deepEqual(result.files.filter(([, has]) => !has), [], 'every live photo has its file on the phone');
			assert.equal(result.strayFile, false, 'no file left for a photo that is not there');
			assert.deepEqual(result.strayRows, [], 'no queue row for a photo that is not there');

			assert.equal(result.done.adjustedLive, false, 'tried again, it removes the adjusted photo');
			assert.deepEqual(result.done.live, [result.restoredId], 'and the old file is live once');
			assert.equal(result.done.main, result.restoredId);
			assert.equal(result.done.file, true);
			assert.ok(result.again, 'a second Undo edit is refused');
			assert.equal(result.after.filter((id) => id === result.restoredId).length, 1);
		});
	}

	test('offline, Undo edit on a photo that never went up queues it again, and it goes up to its own path', async () => {
		const {context, page} = phone;

		offline = true;
		fake.offline = true;
		await context.setOffline(true);

		const result = await page.evaluate(async () => {
			const {saveAdjustedPhoto, savePhoto} = await import('/pokemon-card-tracker/js/photos/index.js');
			const {neutralSettings} = await import('/pokemon-card-tracker/js/photos/adjust.js');
			const {store} = window.H;
			const doc = await window.H.loadDocument();
			const copy = doc.cards.find((card) => card.id === window.H.ids().e1);
			const canvas = document.createElement('canvas');

			canvas.width = 60;
			canvas.height = 84;
			canvas.getContext('2d').fillRect(0, 0, 60, 84);

			const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
			const old = await savePhoto({blob, entry: copy, side: 'back', type: 'image/webp'});
			const holder = (await window.H.loadDocument()).card_info.find((item) => (item.photos || []).some((photo) => photo.id === old.id));
			const {photo, undo} = await saveAdjustedPhoto({canvas, old, record: holder, settings: {...neutralSettings(), brightness: 30}});
			const back = await store.undoReplacePhoto(undo);
			const rows = await store.queuedItems();

			return {
				adjusted: photo.id,
				back,
				old,
				pending: [...store.pendingUploads()],
				uploads: rows.filter((row) => row.op === 'upload').map((row) => row.photo_id),
			};
		});

		assert.equal(result.back.path, result.old.path, 'the old path');
		assert.ok(result.pending.includes(result.back.id), 'waiting to upload again');
		assert.ok(!result.pending.includes(result.old.id) && !result.pending.includes(result.adjusted));
		assert.ok(result.uploads.includes(result.back.id) && !result.uploads.includes(result.adjusted));
		assert.equal(fake.objects.has(result.old.path), false);

		offline = false;
		fake.offline = false;
		await context.setOffline(false);
		await page.evaluate(() => window.dispatchEvent(new Event('online')));
		await until(page, (id) => !window.H.store.pendingUploads().has(id), result.back.id);
		assert.ok(fake.objects.has(result.old.path), 'it went up to the old path');
		assert.equal(fake.storageLog('upload').some((entry) => entry.path.includes(`/${result.adjusted}/`)), false, 'the adjusted photo never went up');
	});

	test('Save while the old photo is still going up keeps its delete, so its file is not left in the bucket', async () => {
		const {page} = phone;
		let release;

		fake.hold = new Promise((resolve) => {
			release = resolve;
		});

		const uploading = await page.evaluate(async () => {
			const {savePhoto} = await import('/pokemon-card-tracker/js/photos/index.js');
			const doc = await window.H.loadDocument();
			const copy = doc.cards.find((card) => card.id === window.H.ids().e1);
			const canvas = document.createElement('canvas');

			canvas.width = 60;
			canvas.height = 84;
			canvas.getContext('2d').fillRect(0, 0, 60, 84);

			const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));

			return savePhoto({blob, entry: copy, side: 'back', type: 'image/webp'});
		});

		const end = Date.now() + 10000;

		while (!fake.storageLog('upload').some((entry) => entry.path.endsWith(uploading.path))) {
			assert.ok(Date.now() < end, 'the upload reached the server');
			await page.waitForTimeout(50);
		}

		const adjustedId = await page.evaluate(async (id) => {
			const {saveAdjustedPhoto} = await import('/pokemon-card-tracker/js/photos/index.js');
			const {neutralSettings} = await import('/pokemon-card-tracker/js/photos/adjust.js');
			const doc = await window.H.loadDocument();
			const holder = doc.card_info.find((item) => (item.photos || []).some((photo) => photo.id === id));
			const old = holder.photos.find((photo) => photo.id === id);
			const canvas = document.createElement('canvas');

			canvas.width = 60;
			canvas.height = 84;
			canvas.getContext('2d').fillRect(0, 0, 60, 84);

			return (await saveAdjustedPhoto({canvas, old, record: holder, settings: {...neutralSettings(), brightness: 30}})).photo.id;
		}, uploading.id);

		release();
		fake.hold = null;
		await until(page, (ids) => window.H.store.queuedItems().then((rows) => !rows.some((row) => row.op !== 'delete' && ids.includes(row.photo_id))), [uploading.id, adjustedId]);
		await page.evaluate(() => window.H.store.flushQueue());

		const rows = await page.evaluate(() => window.H.store.queuedItems());
		const waiting = rows.find((row) => row.photo_id === uploading.id);

		assert.ok(fake.objects.has(uploading.path), 'the old photo\'s upload finished');
		assert.ok(waiting && waiting.op === 'delete' && waiting.paths.includes(uploading.path), 'its delete still waits for the grace period');
	});
});
