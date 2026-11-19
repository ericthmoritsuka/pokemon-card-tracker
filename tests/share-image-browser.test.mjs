// Browser tests for Share on card detail and Share page in a binder
// (js/share-image.js; 2026-11-19, from a survey of other collection apps):
// a tap makes a PNG of the card, or of the open pages, and hands it to
// navigator.share, which is stubbed here to keep the file; with no
// navigator.share (a computer), the PNG downloads instead. A picture TCGdex
// will not hand over in cors mode leaves a card back with the name, never a
// failed share. Headless Chromium against tests/pages-server.mjs, signed
// out.
//
// Every outside service is faked: TCGdex answers the card page with the
// record saved in tests/prices-fixtures and every picture with a small card
// PNG made here (Access-Control-Allow-Origin once, or doubled when
// `net.nocors`, which fails a cors read the way TCGdex's does while an <img>
// still shows it), frankfurter.dev with a fixed rate, PokeAPI with
// tests/fake-pokeapi.mjs. Supabase must never be contacted, and
// ligapokemon.com.br is never requested. Cards and binders are invented.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/share-image-browser.test.mjs
// Screenshots: $SHOTS, else /tmp/share-image

import assert from 'node:assert/strict';
import {mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';
import {deflateSync} from 'node:zlib';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {fakeRates} from './fake-rates.mjs';
import {startPagesServer} from './pages-server.mjs';
import {untilInPage} from './poll.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const SHOTS = process.env.SHOTS || '/tmp/share-image';
const PHONE = {height: 740, width: 360};
const WIDE = {height: 900, width: 1100};
const AT = '2026-11-01T00:00:00.000Z';

// ------------------------------------------------------------ a card PNG

const CRC = Array.from({length: 256}, (_, n) => {
	let c = n;

	for (let k = 0; k < 8; k++) {
		c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	}

	return c >>> 0;
});

function crc32(bytes) {
	let c = 0xffffffff;

	for (const byte of bytes) {
		c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
	}

	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const out = Buffer.alloc(12 + data.length);

	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, 'latin1');
	data.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);

	return out;
}

// A card-shaped RGB PNG: yellow with a blue art box, so the picture is told
// apart from the card back (dark blue) by one pixel near its top.
function cardPng(width = 245, height = 342) {
	const rows = Buffer.alloc((width * 3 + 1) * height);

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const art = x > 20 && x < width - 20 && y > 40 && y < height / 2;
			const o = y * (width * 3 + 1) + 1 + x * 3;

			rows[o] = art ? 0x9a : 0xee;
			rows[o + 1] = art ? 0xc7 : 0xc8;
			rows[o + 2] = art ? 0xe0 : 0x34;
		}
	}

	const header = Buffer.alloc(13);

	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(rows)),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

const PNG = cardPng();

// ------------------------------------------------------------ the device

let server;
let browser;
let en;

before(async () => {
	await mkdir(SHOTS, {recursive: true});
	server = await startPagesServer();
	browser = await chromium.launch();
	en = JSON.parse(await readFile(new URL('./prices-fixtures/en-sv08.5-001.json', import.meta.url), 'utf8'));
});

after(async () => {
	await browser?.close();
	await server?.close();
});

const url = (path = '') => `${server.origin}${BASE}${path}`;

// navigator.share kept the files it was handed, each with its size, type,
// first bytes, decoded size, and the pixels the tests look at
// (window.T.pixel). share: false takes navigator.share away, as on a
// computer.
function shareStub(share) {
	window.T = {files: [], shared: []};

	if (!share) {
		delete Navigator.prototype.share;
		delete Navigator.prototype.canShare;

		return;
	}

	Object.defineProperty(navigator, 'canShare', {configurable: true, value: (data) => Boolean(data && Array.isArray(data.files))});
	Object.defineProperty(navigator, 'share', {configurable: true, value: async (data) => {
		const file = data.files[0];
		const bitmap = await createImageBitmap(file);

		window.T.files.push(file);
		window.T.shared.push({
			count: data.files.length,
			head: [...new Uint8Array(await file.slice(0, 8).arrayBuffer())],
			height: bitmap.height,
			name: file.name,
			size: file.size,
			title: data.title,
			type: file.type,
			width: bitmap.width,
		});
		bitmap.close();
	}});

	// The color at x, y of the last file shared.
	window.T.pixel = async (x, y) => {
		const bitmap = await createImageBitmap(window.T.files.at(-1));
		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		const ctx = canvas.getContext('2d');

		ctx.drawImage(bitmap, 0, 0);

		return [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3)];
	};
}

async function open(viewport, {share = true} = {}) {
	const context = await browser.newContext({acceptDownloads: true, serviceWorkers: 'block', viewport});
	const seen = {liga: [], supabase: []};
	const net = {nocors: false, pictures: []};

	await fakeRates(context);
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await context.route(/ligapokemon\.com\.br/, (route) => {
		seen.liga.push(route.request().url());

		return route.abort('blockedbyclient');
	});
	await context.route('https://*.supabase.co/**', (route) => {
		seen.supabase.push(route.request().url());

		return route.abort('blockedbyclient');
	});
	await context.route('https://api.tcgdex.net/**', (route) => {
		const path = new URL(route.request().url()).pathname.replace(/^\/v2\//, '');

		return route.fulfill(path === `en/cards/${en.id}`
			? {body: JSON.stringify(en), contentType: 'application/json', status: 200}
			: {body: '{}', contentType: 'application/json', status: 404});
	});
	await context.route('https://assets.tcgdex.net/**', (route) => {
		net.pictures.push(route.request().url());

		// A doubled header reaches the browser as "*, *", which fails a cors
		// read; never kept by the HTTP cache, so each read sees the mode of
		// the moment.
		return route.fulfill({body: PNG, contentType: 'image/webp', headers: {'access-control-allow-origin': net.nocors ? '*, *' : '*', 'cache-control': 'no-store'}});
	});
	await context.route(/githubusercontent/, (route) => route.abort());
	await fakePokeApi(context);
	await context.addInitScript(shareStub, share);

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err));

	const done = async () => {
		assert.deepEqual(errors.map(String), []);
		assert.deepEqual(await page.locator('#errors .error').allTextContents(), []);
		assert.deepEqual(seen.liga, [], 'Liga Pokémon is never requested');
		assert.deepEqual(seen.supabase, [], 'Supabase is never contacted');
		await context.close();
	};

	await page.goto(url('cards'));
	await page.waitForSelector('#cards-empty');

	return {done, net, page};
}

const shared = (page) => page.evaluate(() => window.T.shared);

const waitShared = (page, n = 1) => untilInPage(page, `${n} shared file(s)`, (count) => window.T.shared.length >= count, {arg: n});

const toastTexts = (page) => page.locator('#toasts .toast-text').allTextContents();

// A PNG of a sensible size: the PNG signature, its type and name, and no
// bigger than a family chat takes without fuss.
function assertPng(file, name) {
	assert.equal(file.count, 1);
	assert.equal(file.type, 'image/png');
	assert.equal(file.name, name);
	assert.deepEqual(file.head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	assert.ok(file.size > 10000 && file.size < 6000000, `${file.size} bytes`);
}

// ------------------------------------------------------------ card detail

// Two English copies (one Reverse holo) and one Portuguese.
const seedCopies = (page) => page.evaluate(async ({cardId, reverse}) => {
	const collection = await import('/pokemon-card-tracker/js/collection.js');

	await collection.addCard({card_id: cardId, catalog: 'international', language: 'en', language_source: 'manual', variant_id: reverse});
	await collection.addCard({card_id: cardId, catalog: 'international', language: 'en', language_source: 'manual'});
	await collection.addCard({card_id: cardId, catalog: 'international', language: 'pt', language_source: 'manual'});
}, {cardId: en.id, reverse: en.variants_detailed.find((variant) => variant.type === 'reverse' && !variant.foil).variantId});

async function cardPage(page) {
	await page.goto(url(`cards/en/${en.id}`));
	await page.waitForSelector('#card-share');
	await page.waitForFunction(() => {
		const img = document.querySelector('.ph-carousel .ph-slide img');

		return img && img.complete && img.naturalWidth > 0;
	});
}

describe('Share on card detail', () => {
	test('a tap hands the share sheet a PNG of the card with its picture, name, and copies', async () => {
		const {done, page} = await open(PHONE);

		await seedCopies(page);
		await cardPage(page);

		// Last in the row under Ver na Liga, after the card's other actions,
		// and a full touch target.
		assert.deepEqual(await page.locator('.copies-collect-row > button').evaluateAll((nodes) => nodes.map((node) => node.id)), ['copies-collect', 'copies-binder', 'card-move', 'card-share']);

		const box = await page.locator('#card-share').boundingBox();

		assert.ok(box.height >= 40 && box.x >= 0 && box.x + box.width <= PHONE.width, JSON.stringify(box));
		await page.locator('#card-share').scrollIntoViewIfNeeded();
		await page.screenshot({path: `${SHOTS}/card-share-360.png`});

		await page.click('#card-share');
		await waitShared(page);

		const [file] = await shared(page);

		assertPng(file, 'Exeggcute - Prismatic Evolutions 001.png');
		assert.equal(file.title, 'Exeggcute');
		assert.equal(file.width, 1080);
		assert.ok(file.height > 1400 && file.height < 2200, `${file.height} tall`);

		// The card's own picture near the top of the art (yellow), not a card
		// back (dark blue).
		const [r, g, b] = await page.evaluate(() => window.T.pixel(540, 100));

		assert.ok(r > 200 && g > 150 && b < 110, `art pixel ${[r, g, b]}`);
		assert.equal(await page.locator('#card-share').textContent(), 'Share');
		assert.equal(await page.locator('#card-share').isDisabled(), false);

		await writeFile(`${SHOTS}/card-share.png`, Buffer.from(await page.evaluate(async () => [...new Uint8Array(await window.T.files.at(-1).arrayBuffer())])));
		await done();
	});

	test('a picture TCGdex will not hand over leaves the card back with the name, and still shares', async () => {
		const {done, net, page} = await open(PHONE);

		await seedCopies(page);
		await cardPage(page);
		net.nocors = true;
		await page.click('#card-share');
		await waitShared(page);

		const [file] = await shared(page);

		assertPng(file, 'Exeggcute - Prismatic Evolutions 001.png');

		const [r, g, b] = await page.evaluate(() => window.T.pixel(540, 100));

		assert.ok(b > r && b > 80 && r < 80, `card back pixel ${[r, g, b]}`);
		assert.ok((await toastTexts(page)).includes('The card\'s picture could not be added, so the image shows its name.'));
		await done();
	});

	test('with no navigator.share (a computer), the PNG downloads', async () => {
		const {done, page} = await open(WIDE, {share: false});

		await seedCopies(page);
		await cardPage(page);

		const [download] = await Promise.all([page.waitForEvent('download'), page.click('#card-share')]);
		const path = await download.path();
		const bytes = await readFile(path);

		assert.equal(download.suggestedFilename(), 'Exeggcute - Prismatic Evolutions 001.png');
		assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		assert.ok((await stat(path)).size > 10000);
		await page.waitForFunction(() => [...document.querySelectorAll('#toasts .toast-text')].some((node) => node.textContent === 'Saved Exeggcute - Prismatic Evolutions 001.png.'));
		await done();
	});
});

// ------------------------------------------------------------ a binder

const card = (id, cardId, fields = {}) => ({card_id: cardId, catalog: 'international', created_at: AT, deleted_at: null, id, language: 'en', language_source: 'manual', updated_at: AT, ...fields});

const record = (id, name) => ({
	catalog: 'international',
	category: 'Pokemon',
	collector_number: id.split('-')[1],
	dex_ids: [1],
	id,
	illustrator: null,
	localizations: {en: {image: `https://assets.tcgdex.net/en/tst/${id.split('-')[0]}/${id.split('-')[1]}`, lang: 'en', name, set_name: 'Test set'}},
	rarity: 'Common',
	release_date: '2024-01-01',
	set_id: id.split('-')[0],
	types: ['Grass'],
});

const RECORDS = [record('tst1-001', 'Test Sprout'), record('tst1-004', 'Test Ember'), record('tst1-007', 'Test Splash')];

// Vitrine, 3 x 3, 3 pages: a card in page 2 pocket 1 and page 3 pocket 5,
// a placeholder in page 3 pocket 9; every other pocket empty.
const VITRINE = {
	art: [],
	cols: 3,
	cover_color: '#7a1f1f',
	created_at: AT,
	deleted_at: null,
	id: 'vitrine',
	name: 'Vitrine',
	notes: '',
	page_count: 3,
	rows: 3,
	slots: [
		{entry_id: 'c1', page: 2, placed_at: AT, position: 1},
		{entry_id: 'c2', page: 3, placed_at: AT, position: 5},
		{page: 3, placed_at: AT, position: 9, want: {card_id: 'tst1-007', catalog: 'international', image: null, name: 'Test Splash', variant_id: null}},
	],
	updated_at: AT,
};

const BINDER_DOC = {
	binders: [VITRINE],
	cards: [card('c1', 'tst1-001'), card('c2', 'tst1-004')],
	collections: [],
	goals: [],
	openings: [],
	person: 'local',
	updated_at: AT,
	user_id: null,
	version: 1,
	wishlist: [],
};

// The document straight into the phone's store, and the card records into
// its card index, as tests/binder-view-browser.test.mjs seeds them.
async function seedBinder(page) {
	await page.evaluate(async ({records, stored}) => {
		await new Promise((resolve, reject) => {
			const request = indexedDB.open('card-tracker-collection', 1);

			request.onupgradeneeded = () => request.result.createObjectStore('documents');
			request.onsuccess = () => {
				const tx = request.result.transaction('documents', 'readwrite');

				tx.objectStore('documents').put(stored, 'local');
				tx.oncomplete = () => {
					request.result.close();
					resolve();
				};
				tx.onerror = () => reject(tx.error);
			};
			request.onerror = () => reject(request.error);
		});
		await (await import('/pokemon-card-tracker/js/catalog.js')).saveToCardIndex(records);
	}, {records: RECORDS, stored: BINDER_DOC});
	await page.reload();
}

// The spread with pages 2 and 3, its two cards' art loaded.
async function openSpread(page) {
	await page.goto(url('binders/vitrine?spread=2'));
	await page.waitForSelector('#binder-share');
	await page.waitForFunction(() => {
		const imgs = [...document.querySelectorAll('#binder-spread .pocket[data-kind="card"] img:not(.flag)')];

		return imgs.length === 2 && imgs.every((img) => img.complete && img.naturalWidth > 0);
	});
}

describe('Share page in a binder', () => {
	test('a tap hands the share sheet a PNG of both open pages, pockets and all', async () => {
		const {done, page} = await open(WIDE);

		await seedBinder(page);
		await openSpread(page);

		// First of the binder's buttons.
		assert.equal(await page.locator('#binder-body .actions > button:not([hidden])').first().getAttribute('id'), 'binder-share');
		assert.equal(await page.locator('#binder-share').textContent(), 'Share page');

		await page.click('#binder-share');
		await waitShared(page);

		const [file] = await shared(page);

		assertPng(file, 'Vitrine - Pages 2 and 3.png');
		assert.equal(file.title, 'Vitrine, pages 2 and 3');

		// The picture is laid out as js/share-image.js pageLayout says; its
		// pockets are sampled there: page 2 pocket 1 holds the card's picture,
		// page 2 pocket 2 is empty, page 3 pocket 9 is the dimmed placeholder.
		const at = await page.evaluate(async () => {
			const {pageLayout} = await import('/pokemon-card-tracker/js/share-image.js');
			const layout = pageLayout({cols: 3, pages: [2, 3], rows: 3});
			const near = (pocket) => window.T.pixel(pocket.x + (pocket.w / 2), pocket.y + 6);

			return {
				card: await near(layout.pages[0].pockets[0]),
				cover: await window.T.pixel(4, 4),
				empty: await near(layout.pages[0].pockets[1]),
				size: [layout.width, layout.height],
			};
		});

		assert.deepEqual([file.width, file.height], at.size);
		assert.ok(file.width > file.height, 'a spread is wider than tall');
		assert.deepEqual(at.cover, [0x7a, 0x1f, 0x1f], 'the cover color around the pages');
		assert.ok(at.card[0] > 200 && at.card[1] > 150 && at.card[2] < 110, `card pixel ${at.card}`);
		assert.deepEqual(at.empty, [0xec, 0xeb, 0xe5], 'an empty pocket');

		await writeFile(`${SHOTS}/binder-share.png`, Buffer.from(await page.evaluate(async () => [...new Uint8Array(await window.T.files.at(-1).arrayBuffer())])));
		await done();
	});

	test('a phone held upright shares the page it has open', async () => {
		const {done, page} = await open(PHONE);

		await seedBinder(page);
		await page.goto(url('binders/vitrine?spread=2'));
		await page.waitForSelector('.bs-open[data-open="3"]');
		await page.click('.bs-open[data-open="3"]');
		await page.waitForFunction(() => document.getElementById('binder-spread').dataset.zoom === '3');
		await page.waitForFunction(() => {
			const img = document.querySelector('#bs-zoom-sheet .pocket[data-kind="card"] img:not(.flag)');

			return img && img.complete && img.naturalWidth > 0;
		});

		const box = await page.locator('#binder-share').boundingBox();

		assert.ok(box.height >= 44 && box.x >= 0 && box.x + box.width <= PHONE.width, JSON.stringify(box));
		await page.click('#binder-share');
		await waitShared(page);

		const [file] = await shared(page);

		assertPng(file, 'Vitrine - Page 3.png');
		assert.ok(file.height > file.width, 'one page is taller than wide');
		await done();
	});

	test('with no navigator.share, the page downloads', async () => {
		const {done, page} = await open(WIDE, {share: false});

		await seedBinder(page);
		await openSpread(page);

		const [download] = await Promise.all([page.waitForEvent('download'), page.click('#binder-share')]);

		assert.equal(download.suggestedFilename(), 'Vitrine - Pages 2 and 3.png');
		assert.ok((await stat(await download.path())).size > 10000);
		await done();
	});
});
