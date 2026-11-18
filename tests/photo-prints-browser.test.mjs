// The scanner learns cards from the family's photos (js/scan/photo-prints.js,
// js/scan/photo-prints-app.js; DESIGN.md "The scanner learns from the
// family's photos"), end to end in headless Chromium against
// tests/scan-harness.mjs (Supabase and TCGdex are never reached).
//
// The owner's document holds a copy of mep-037 and a card record with one
// front photo of it saved on the phone. mep-037 is not in the fingerprint
// index (js/vision/index-names.json holds no MEP set), so only the photo can
// recognise it. The camera is tests/scan-scene.mjs's canvas, showing a
// synthetic card picture (coloured blocks in a yellow border, nothing the
// index holds) in the guide: the photo's picture, a few pixels shifted and
// slightly blurred and brightened, as the capture. The scanner must name
// mep-037 by the picture alone, with no text read, and a second, unrelated
// picture must not be named mep-037. A card the index does hold is not
// learned: its photo makes no print.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/photo-prints-browser.test.mjs

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakeRates} from './fake-rates.mjs';
import {untilInPage} from './poll.mjs';
import {countLooks, LOOK_MS, startScanHarness} from './scan-harness.mjs';
import {sceneCamera} from './scan-scene.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const FRAME = {height: 3840, width: 2160};
const PRINTS_KEY = 'card-tracker:photo-prints:v1';
const AT = '2026-11-01T00:00:00.000Z';

// A card the index lacks (MEP Black Star Promos), and one it holds
// (Pikachu, 151).
const LEARNED = 'mep-037';
const HELD = 'sv03.5-025';
const PHOTO_ID = 'photo-mep-037';
const HELD_PHOTO_ID = 'photo-sv03.5-025';

let harness;
let browser;
// PNG bytes (base64): the owner's photo, the capture of it a little
// changed, and an unrelated picture.
let pictures;

// A card-shaped 600 x 840 picture of coloured blocks, different for every
// seed, in a yellow border. shift moves the picture by a few pixels, and
// soften blurs and brightens it, as a second look at the same card would.
const drawCard = ({seed, shift = 0, soften = false}) => {
	let s = seed * 9973 + 1;
	const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
	const width = 600;
	const height = 840;
	const canvas = document.createElement('canvas');

	canvas.width = width;
	canvas.height = height;

	const ctx = canvas.getContext('2d');

	ctx.fillStyle = '#e4c33a';
	ctx.fillRect(0, 0, width, height);
	ctx.save();

	if (soften) {
		ctx.filter = 'blur(1.2px) brightness(1.07)';
	}

	ctx.translate(shift, shift / 2);
	ctx.beginPath();
	ctx.rect(30, 30, width - 60, height - 60);
	ctx.clip();
	ctx.fillStyle = '#e6dcc8';
	ctx.fillRect(0, 0, width, height);

	for (let i = 0; i < 40; i++) {
		ctx.fillStyle = `rgb(${Math.round(rand() * 255)}, ${Math.round(rand() * 255)}, ${Math.round(rand() * 255)})`;
		ctx.fillRect(30 + rand() * (width - 60), 30 + rand() * (height - 60), 30 + rand() * 180, 30 + rand() * 240);
	}

	ctx.restore();

	return canvas.toDataURL('image/png').split(',')[1];
};

before(async () => {
	harness = await startScanHarness();
	browser = await chromium.launch();

	const page = await browser.newPage();

	await fakeRates(page.context());
	await page.goto(`${harness.origin}${BASE}`, {waitUntil: 'domcontentloaded'});
	pictures = await page.evaluate(`(() => {
		const drawCard = ${drawCard.toString()};

		return {
			changed: drawCard({seed: 7, shift: 3, soften: true}),
			photo: drawCard({seed: 7}),
			unrelated: drawCard({seed: 21}),
		};
	})()`);
	await page.close();
});

after(async () => {
	await browser.close();
	await harness.close();
});

const documentWith = (cards, cardInfo) => ({binders: [], card_info: cardInfo, cards, collections: [], goals: [], openings: [], person: 'local', updated_at: AT, user_id: null, version: 1, wishlist: []});

const copy = (id, cardId) => ({card_id: cardId, catalog: 'international', created_at: AT, deleted_at: null, id, language: 'en', language_source: 'import', updated_at: AT, variant_id: null});

// The card record of one card with one front photo saved on the phone.
const record = (cardId, photoId) => ({
	card_id: cardId,
	catalog: 'international',
	created_at: AT,
	deleted_at: null,
	id: `international~${cardId}~en`,
	language: 'en',
	main_image: null,
	notes: '',
	photos: [{created_at: AT, deleted_at: null, id: photoId, path: null, side: 'front'}],
	updated_at: AT,
});

// The app, with the owner's document and the photos' blobs on the phone,
// and the camera showing `scene` (tests/scan-scene.mjs). Every outside host
// is answered with a failure, TCGdex included: the scanner names a card
// without the catalog, from the index and the prints.
async function open({cardInfo, cards, photos, scene = {kind: 'table'}}) {
	const context = await browser.newContext({deviceScaleFactor: 2.8125, viewport: {height: 900, width: 384}});

	await fakeRates(context);
	await context.grantPermissions(['camera'], {origin: harness.origin});
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());

	const outside = [];

	await context.route((url) => !/^(localhost|127\.0\.0\.1)$/.test(url.hostname) && url.hostname !== 'api.frankfurter.dev', (route) => {
		outside.push(route.request().url());

		return route.abort('internetdisconnected');
	});

	const png = (name) => (route) => route.fulfill({body: Buffer.from(pictures[name], 'base64'), contentType: 'image/png'});

	await context.route('**/__test-card.webp', png('changed'));
	await context.route('**/__test-card-b.webp', png('unrelated'));
	await context.route('**/__test-card-c.webp', png('unrelated'));
	await context.addInitScript((first) => {
		if (sessionStorage.getItem('test-scene') === null) {
			sessionStorage.setItem('test-scene', JSON.stringify(first));
		}
	}, scene);
	await context.addInitScript(sceneCamera, FRAME);
	await context.addInitScript(countLooks, LOOK_MS);
	// Hand-held; the scanner still takes a card held still in the guide.
	await context.addInitScript(() => {
		if (localStorage.getItem('card-tracker:scan-holder') === null) {
			localStorage.setItem('card-tracker:scan-holder', 'off');
		}
	});

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(String(err)));

	// The owner's document, and the photos as saved on this phone
	// (js/photos/store.js savePhotoLocally), before Scan opens.
	await page.goto(`${harness.origin}${BASE}cards`);
	await page.evaluate(async ({doc, files}) => {
		await new Promise((resolve, reject) => {
			const request = indexedDB.open('card-tracker-collection', 1);

			request.onupgradeneeded = () => request.result.createObjectStore('documents');
			request.onsuccess = () => {
				const tx = request.result.transaction('documents', 'readwrite');

				tx.objectStore('documents').put(doc, 'local');
				tx.oncomplete = () => {
					request.result.close();
					resolve();
				};
				tx.onerror = () => reject(tx.error);
			};
			request.onerror = () => reject(request.error);
		});

		const {savePhotoLocally} = await import('/pokemon-card-tracker/js/photos/store.js');

		for (const {base64, id} of files) {
			const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));

			await savePhotoLocally(id, new Blob([bytes], {type: 'image/png'}));
		}
	}, {doc: documentWith(cards, cardInfo), files: photos.map((id) => ({base64: pictures.photo, id}))});

	await page.goto(`${harness.origin}${BASE}scan`);
	await page.waitForSelector('#scan-guide:not([hidden])', {timeout: 30000});
	await page.waitForFunction(() => document.getElementById('scan-video').videoWidth > 0);
	await page.waitForSelector('#scan-shutter:not([disabled])');

	return {context, errors, outside, page};
}

// The prints the phone keeps (js/scan/photo-prints-app.js PRINTS_KEY), by
// photo id. They are written in the same turn the prints go to the picture
// matcher (identify.js setPhotoPrints), so a photo's entry means the
// matcher has it.
const keptPrints = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}'), PRINTS_KEY);

// The tray as the draft keeps it. The picture's cards are ids in a draft
// that has settled and objects ({id, set, score, ...}) before, so both are
// read as ids.
const items = (page) => page.evaluate(async () => {
	const session = await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession();
	const idOf = (card) => (typeof card === 'string' ? card : card.id);
	const picture = (found) => found && {gap: found.gap, groups: found.groups.map((group) => ({cards: group.cards.map(idOf), score: group.score}))};

	return session ? session.items.map((item) => ({card: item.card && item.card.id, id: item.id, picture: picture(item.picture), read: item.read && {name: item.read.name, number: item.read.number}, status: item.status, sure: item.sure, timings: item.timings, why: item.why})) : [];
});

const captures = (page) => page.evaluate(async () => (await import('/pokemon-card-tracker/js/scan/view.js')).scanStats.captures);

// The tray once it holds `count` cards, none still being read.
async function settledItems(page, count, what) {
	return untilInPage(page, what, async (want) => {
		const session = await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession();
		const list = session ? session.items : [];

		return list.length === want && list.every((item) => item.status !== 'reading' && item.status !== 'matching');
	}, {arg: count, timeout: 90000}).then(() => items(page), async (err) => {
		throw new Error(`${err.message}; tray: ${JSON.stringify(await items(page))}; captures: ${await captures(page)}`);
	});
}

// Shows the scene to the camera and waits for the scanner to take it: a
// card held still in the guide is taken on its own, in hand-held mode too.
async function take(page, scene) {
	const before = await captures(page);

	await page.evaluate((next) => {
		window.scene = next;
	}, scene);
	await untilInPage(page, 'the scene drawn in the camera', () => (window.drawScene(), true));
	await untilInPage(page, 'the card taken', async (count) => (await import('/pokemon-card-tracker/js/scan/view.js')).scanStats.captures > count, {arg: before, timeout: 30000});
}

const names = JSON.parse(await readFile(new URL('../js/vision/index-names.json', import.meta.url), 'utf8'));
const indexHolds = (id) => Object.entries(names.cards).some(([key, cards]) => key.startsWith('en|') && id in cards);

describe('the scanner learns a card from the owner\'s photo', () => {
	test('the fixtures: the index lacks mep-037 and holds the Pikachu', () => {
		assert.equal(indexHolds(LEARNED), false, `${LEARNED} is not in the index`);
		assert.equal(indexHolds(HELD), true, `${HELD} is in the index`);
	});

	test('a card the index lacks is named by the picture of the owner\'s photo, and an unrelated picture is not', async () => {
		const {context, errors, outside, page} = await open({
			cardInfo: [record(LEARNED, PHOTO_ID)],
			cards: [copy('owned-mep-037', LEARNED)],
			photos: [PHOTO_ID],
			scene: {kind: 'table'},
		});

		// Scan has fingerprinted the photo and handed its print to the matcher.
		await untilInPage(page, 'the photo\'s print made', (key) => Boolean(JSON.parse(localStorage.getItem(key) || '{}')['photo-mep-037']), {arg: PRINTS_KEY, timeout: 60000});
		assert.deepEqual(Object.keys(await keptPrints(page)), [PHOTO_ID], 'one print, of the one photo');

		// The capture: the photo's picture a few pixels off, a little blurred
		// and brighter, a little turned in the guide.
		await take(page, {cards: [{card: 'a', size: 0.9}]});

		const [first] = await settledItems(page, 1, 'the first capture settled');

		assert.equal(first.card, LEARNED, `the tray card is ${LEARNED}: ${JSON.stringify(first)}`);

		// By the picture alone: the lead group is mep-037, which only a photo
		// print can name, and no text was read.
		const lead = first.picture.groups[0];

		assert.deepEqual(lead.cards, [LEARNED]);
		assert.ok(lead.score <= 45, `the picture is close to the photo (distance ${lead.score})`);
		assert.equal(first.timings.ocr, null, 'no text was read');
		assert.equal(first.sure, true, 'the picture settled the card');

		// An unrelated picture is not mep-037.
		await take(page, {cards: [{card: 'b', size: 0.9}]});

		const [, second] = await settledItems(page, 2, 'the second capture settled');

		assert.notEqual(second.card, LEARNED, `an unrelated picture is not ${LEARNED}: ${JSON.stringify(second)}`);

		const near = second.picture && second.picture.groups.find((group) => group.cards.includes(LEARNED));

		assert.ok(!near || near.score > 60, `the unrelated picture is far from the photo's print (distance ${near && near.score})`);
		assert.deepEqual(errors, []);
		// Only the catalog's and PokeAPI's hosts, which the app asks for by
		// design and the route refused, may have been tried.
		assert.deepEqual(outside.filter((url) => !/^https:\/\/(api|assets)\.tcgdex\.net\/|pokeapi\.co/.test(url)), [], 'no real service was asked for');
		await context.close();
	});

	test('control: the same capture with no photo of the card is not named mep-037', async () => {
		const {context, errors, page} = await open({cardInfo: [], cards: [copy('owned-mep-037', LEARNED)], photos: []});

		await untilInPage(page, 'Scan to have decided about the photos', (key) => localStorage.getItem(key) !== null, {arg: PRINTS_KEY, timeout: 60000});
		assert.deepEqual(await keptPrints(page), {}, 'no photo, no print');
		await take(page, {cards: [{card: 'a', size: 0.9}]});

		const [only] = await settledItems(page, 1, 'the capture settled');

		assert.notEqual(only.card, LEARNED, `without the photo the picture does not name ${LEARNED}: ${JSON.stringify(only)}`);
		assert.ok(!only.picture || !only.picture.groups.some((group) => group.cards.includes(LEARNED)), 'no print of it to match');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a card the index holds is not learned from its photo', async () => {
		const {context, errors, page} = await open({
			cardInfo: [record(HELD, HELD_PHOTO_ID), record(LEARNED, PHOTO_ID)],
			cards: [copy('owned-pikachu', HELD), copy('owned-mep-037', LEARNED)],
			photos: [HELD_PHOTO_ID, PHOTO_ID],
		});

		// Both photos are on the phone and both cards are in the document;
		// the refresh that made mep-037's print has also decided about the
		// Pikachu's (it writes the whole cache at once).
		await untilInPage(page, 'the photo prints made', (key) => Object.keys(JSON.parse(localStorage.getItem(key) || '{}')).length > 0, {arg: PRINTS_KEY, timeout: 60000});

		const kept = await keptPrints(page);

		assert.deepEqual(Object.keys(kept), [PHOTO_ID], `only the card the index lacks has a print: ${Object.keys(kept)}`);
		assert.equal(HELD_PHOTO_ID in kept, false, 'the Pikachu\'s photo made no print');
		assert.equal(await page.evaluate(async (id) => Boolean(await (await import('/pokemon-card-tracker/js/photos/store.js')).localPhoto(id)), HELD_PHOTO_ID), true, 'its photo is on the phone, so it was skipped for its card, not for want of pixels');
		assert.deepEqual(errors, []);
		await context.close();
	});
});
