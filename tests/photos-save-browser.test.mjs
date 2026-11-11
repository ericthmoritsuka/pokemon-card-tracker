// Browser tests for saving a card's picture from card detail (Eric,
// 2026-11-11): the browser's own image menu on the carousel and the
// full-screen viewer, and the carousel's Save image button
// (js/photos/save.js). Headless Chromium at 360 x 740 against
// tests/photos-harness.mjs, the real modules on a harness page.
//
// Supabase is tests/photos-fake-storage.mjs, never the real project. TCGdex
// is a Playwright route serving a small PNG made here, never the real host:
// `net.mode` decides what it answers. 'ok' sends Access-Control-Allow-Origin
// once; 'nocors' sends it doubled, which fails a cors read the way TCGdex's
// does (an <img> still shows the image); 'nopng' answers the PNG with a 404,
// as TCGdex does for a missing file.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/photos-save-browser.test.mjs

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {deflateSync} from 'node:zlib';

import {FakeStorageSupabase} from './photos-fake-storage.mjs';
import {HARNESS_PATH, routeHarness, startHarness} from './photos-harness.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const VIEWPORT = {height: 740, width: 360};
const IMAGE = 'https://assets.tcgdex.net/en/me/me01/001';
const QUAD = [{x: 330, y: 250}, {x: 905, y: 300}, {x: 990, y: 1290}, {x: 215, y: 1235}];

// ------------------------------------------------------------ a small PNG

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

// A width x height RGB PNG: a yellow card with a blue art box, so it reads
// as a card in the screenshots.
function cardPng(width = 300, height = 413) {
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

async function device(fake, user, net) {
	const context = await browser.newContext({acceptDownloads: true, viewport: VIEWPORT});
	const errors = [];

	await fake.attach(context, 'phone');
	await routeHarness(context, harness.origin, {offline: () => net.offline});
	await context.route('https://assets.tcgdex.net/**', async (route) => {
		const url = route.request().url();
		const png = url.endsWith('.png');

		net.requests.push(url);

		if (net.offline) {
			return route.abort('internetdisconnected');
		}

		if (net.hold && png) {
			await net.hold;
		}

		if (png && net.mode === 'nopng') {
			return route.fulfill({status: 404});
		}

		// A doubled header reaches the browser as one value, "*, *", which
		// fails a cors read. (Leaving the header out would not do: Playwright
		// adds one to a fulfilled cross-origin answer that has none.) Never
		// kept by the HTTP cache, so each read sees the mode of the moment.
		const headers = {'access-control-allow-origin': net.mode === 'nocors' ? '*, *' : '*', 'cache-control': 'no-store'};

		return route.fulfill({body: !png && net.webp ? net.webp : PNG, contentType: png ? 'image/png' : 'image/webp', headers});
	});

	const session = fake.session(user);

	await context.addInitScript((value) => {
		if (!localStorage.getItem('card-tracker-auth')) {
			localStorage.setItem('card-tracker-auth', value);
		}
	}, JSON.stringify(session));

	const page = await context.newPage();

	page.on('pageerror', (err) => errors.push(String(err)));

	return {context, errors, page};
}

async function open(page) {
	await page.goto(`${harness.origin}${HARNESS_PATH}`);
	await page.waitForFunction(() => document.body.dataset.ready);

	const state = await page.evaluate(() => [document.body.dataset.ready, document.body.dataset.error]);

	assert.equal(state[0], 'true', state[1]);

	// The app's toast box (index.html), which the harness page leaves out.
	await page.evaluate(() => {
		if (!document.getElementById('toasts')) {
			document.body.append(Object.assign(document.createElement('div'), {className: 'toasts', id: 'toasts'}));
		}
	});
}

async function openCard(page) {
	await page.evaluate(() => window.H.openDetail('e1'));
	await page.waitForFunction(() => {
		const img = document.querySelector('.ph-carousel .ph-slide img');

		return img && img.complete && img.naturalWidth > 0;
	});
}

// The element at the centre of `selector`'s box, as the browser hit-tests
// it for a right-click or a long-press.
const hitAtCentre = (page, selector) => page.evaluate((s) => {
	const box = document.querySelector(s).getBoundingClientRect();
	const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);

	return hit ? `${hit.tagName.toLowerCase()}${hit.className ? `.${String(hit.className).split(' ').join('.')}` : ''}` : null;
}, selector);

const toastText = (page) => page.locator('#toasts .toast-text').last().textContent();

async function pickAndSavePhoto(page) {
	const base64 = await page.evaluate((q) => window.H.makeTestPhoto({quad: q}), QUAD);

	await page.click('.ph-add');
	await page.waitForSelector('.ph-sheet .ph-pick');

	const chooser = page.waitForEvent('filechooser');

	await page.click('.ph-pick');
	await (await chooser).setFiles({buffer: Buffer.from(base64, 'base64'), mimeType: 'image/jpeg', name: 'card.jpg'});
	await page.waitForSelector('.ph-stage .ph-handle');
	await page.click('.ph-save');
	await page.waitForSelector('.ph-sheet', {state: 'detached'});
}

// ------------------------------------------------------------ the tests

describe('saving a card\'s picture', () => {
	const fake = new FakeStorageSupabase();
	const owner = fake.addUser('owner@example.test');
	const net = {hold: null, mode: 'ok', offline: false, requests: []};
	let phone;

	before(async () => {
		phone = await device(fake, owner, net);
		await open(phone.page);
		await openCard(phone.page);
	});

	after(async () => {
		assert.deepEqual(phone.errors, []);
		await phone.context.close();
	});

	test('a right-click on the official image lands on the image, and the page lets the browser\'s menu open', async () => {
		const {page} = phone;

		assert.equal(await hitAtCentre(page, '.ph-viewport'), 'img', 'the image itself is hit, not the viewport');
		assert.equal(await page.locator('.ph-slide img').first().getAttribute('draggable'), 'false');

		await page.evaluate(() => {
			window.menus = [];
			document.addEventListener('contextmenu', (event) => {
				window.menus.push({prevented: event.defaultPrevented, target: event.target.tagName});
			});
		});

		const box = await page.locator('.ph-viewport').boundingBox();

		await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, {button: 'right'});
		await page.waitForFunction(() => window.menus.length === 1);
		assert.deepEqual(await page.evaluate(() => window.menus), [{prevented: false, target: 'IMG'}]);
		assert.equal(await page.locator('.ph-full').count(), 0, 'a right-click is not a tap: no full screen');
	});

	test('a tap still opens full screen, where the image is hit too; a long press does not open it', async () => {
		const {page} = phone;
		const box = await page.locator('.ph-viewport').boundingBox();
		const x = box.x + box.width / 2;
		const y = box.y + box.height / 2;

		await page.mouse.move(x, y);
		await page.mouse.down();
		await page.waitForTimeout(750);
		await page.mouse.up();
		await page.waitForTimeout(200);
		assert.equal(await page.locator('.ph-full').count(), 0, 'a long press is not a tap');

		await page.mouse.click(x, y);
		await page.waitForSelector('.ph-full .ph-pane[data-ready="true"]');
		assert.equal(await hitAtCentre(page, '.ph-full .ph-pane'), 'img.ph-full-img');
		assert.equal(await page.locator('.ph-full-img').first().getAttribute('draggable'), 'false');
		await page.keyboard.press('Escape');
		await page.waitForSelector('.ph-full', {state: 'detached'});
	});

	test('Save image on the official image downloads its PNG named after the card, once, with a busy button', async () => {
		const {page} = phone;
		let release;

		net.hold = new Promise((resolve) => {
			release = resolve;
		});
		net.requests = [];

		const button = page.locator('.ph-save-image');

		assert.equal(await button.textContent(), 'Save image');

		const download = page.waitForEvent('download');

		await button.click();
		await page.waitForFunction(() => document.querySelector('.ph-save-image').textContent === 'Saving…');
		assert.equal(await button.isDisabled(), true);
		await button.dispatchEvent('click');
		release();
		net.hold = null;

		const file = await download;

		assert.equal(file.suggestedFilename(), 'Test Bulbasaur - Test set 001 (EN).png');
		assert.deepEqual(await readFile(await file.path()), PNG);
		await page.waitForFunction(() => document.querySelector('.ph-save-image').textContent === 'Save image');
		assert.equal(await button.isDisabled(), false);
		assert.deepEqual(net.requests.filter((url) => url.endsWith('.png')), [`${IMAGE}/high.png`], 'one read for two taps');
	});

	test('with no PNG to read, the WebP is read and saved as a PNG', async () => {
		const {page} = phone;

		// Real WebP bytes, so the PNG below comes from decoding and
		// re-encoding rather than from the stub.
		net.webp = Buffer.from(await page.evaluate(async () => {
			const canvas = document.createElement('canvas');

			canvas.width = 60;
			canvas.height = 84;
			canvas.getContext('2d').fillRect(0, 0, 30, 42);

			const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp'));

			return [...new Uint8Array(await blob.arrayBuffer())];
		}));
		assert.equal(net.webp.subarray(8, 12).toString(), 'WEBP');
		net.mode = 'nopng';

		const download = page.waitForEvent('download');

		await page.click('.ph-save-image');

		const file = await download;
		const bytes = await readFile(await file.path());

		assert.equal(file.suggestedFilename(), 'Test Bulbasaur - Test set 001 (EN).png');
		assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'the file really is a PNG');
		net.mode = 'ok';
		net.webp = null;
	});

	test('when the cors read fails, the PNG opens in a new tab and a toast says to save it there', async () => {
		const {context, page} = phone;
		let downloaded = false;
		const onDownload = () => {
			downloaded = true;
		};

		net.mode = 'nocors';
		page.on('download', onDownload);

		const popup = context.waitForEvent('page');

		await page.click('.ph-save-image');

		const tab = await popup;

		assert.equal(tab.url(), `${IMAGE}/high.png`);
		assert.equal(await tab.evaluate(() => window.opener), null, 'the tab cannot reach the app');
		assert.equal(await toastText(page), 'Opened the image in a new tab. Save it from there.');
		assert.equal(downloaded, false);
		page.off('download', onDownload);
		await tab.close();
		net.mode = 'ok';
	});

	test('offline, it says saving needs a connection and opens no tab', async () => {
		const {context, page} = phone;
		let opened = false;
		const onPage = () => {
			opened = true;
		};

		context.on('page', onPage);
		net.offline = true;
		await context.setOffline(true);
		await page.click('.ph-save-image');
		await page.waitForFunction(() => [...document.querySelectorAll('#toasts .toast-text')].some((node) => node.textContent === 'Saving the image needs a connection.'));
		await page.waitForTimeout(300);
		assert.equal(opened, false);
		context.off('page', onPage);
		net.offline = false;
		await context.setOffline(false);
	});

	test('Save image on the person\'s own photo downloads that photo with its own type', async () => {
		const {page} = phone;

		await pickAndSavePhoto(page);
		await page.waitForFunction(() => document.querySelectorAll('.ph-carousel .ph-slide').length === 2);
		await page.waitForFunction(() => document.querySelector('.ph-carousel').dataset.index === '1');
		await page.waitForSelector('.ph-slide[data-slide]:nth-child(2) img');

		const photoId = await page.locator('.ph-slide[data-slide]:nth-child(2)').getAttribute('data-slide');
		const stored = await page.evaluate(async (id) => {
			const blob = await window.H.store.localPhoto(id);

			return {bytes: [...new Uint8Array(await blob.arrayBuffer())], type: blob.type};
		}, photoId);

		assert.equal(await page.locator('.ph-save-image').isVisible(), true);

		const download = page.waitForEvent('download');

		net.requests = [];
		await page.click('.ph-save-image');

		const file = await download;

		assert.equal(file.suggestedFilename(), `Test Bulbasaur - Test set 001 photo 1.${stored.type === 'image/webp' ? 'webp' : 'jpg'}`);
		assert.deepEqual([...await readFile(await file.path())], stored.bytes);
		assert.deepEqual(net.requests, [], 'no image host request for a photo');
	});

	test('the carousel still swipes from the image, and the page never sees the swipe', async () => {
		const {page} = phone;

		await page.locator('.ph-dot').first().click();
		assert.equal(await page.locator('.ph-carousel').getAttribute('data-index'), '0');

		const before = await page.evaluate(() => ({...window.H.counts}));
		const box = await page.locator('.ph-viewport').boundingBox();
		const y = box.y + box.height / 2;

		assert.equal(await hitAtCentre(page, '.ph-viewport'), 'img');
		await page.mouse.move(box.x + box.width - 20, y);
		await page.mouse.down();

		for (let i = 1; i <= 10; i++) {
			await page.mouse.move(box.x + box.width - 20 - i * 18, y + i);
		}

		await page.mouse.up();
		assert.equal(await page.locator('.ph-carousel').getAttribute('data-index'), '1');

		const counts = await page.evaluate(() => ({...window.H.counts}));

		assert.equal(counts.pageSwipes, before.pageSwipes, 'the page saw no swipe');
		assert.equal(counts.pagePointerMovesFromCarousel, 0, 'no pointer move left the carousel');
		assert.equal(counts.carouselSwipes, before.carouselSwipes + 1);
		assert.equal(await page.locator('.ph-full').count(), 0, 'a swipe is not a tap');
	});

	test('a family member\'s card (read only) has Save image and no Use as main image', async () => {
		const {page} = phone;

		await page.evaluate(async () => {
			const {cardPhotos} = await import('/pokemon-card-tracker/js/photos/index.js');
			const {cardArt} = await import('/pokemon-card-tracker/js/catalog-views.js');
			const block = cardPhotos({cardId: 'me01-001', catalog: 'international', entries: [], readOnly: true, records: []});

			document.getElementById('detail').replaceChildren(block.show({
				art: cardArt,
				info: {name: 'Test Bulbasaur', number: '001', setName: 'Test set'},
				official: 'https://assets.tcgdex.net/en/me/me01/001/high.webp',
			}));
		});
		await page.waitForSelector('.ph-carousel .ph-slide img');
		assert.equal(await page.locator('.ph-use-main').isHidden(), true);
		assert.equal(await page.locator('.ph-add').count(), 0);

		const download = page.waitForEvent('download');

		await page.click('.ph-save-image');
		assert.equal((await download).suggestedFilename(), 'Test Bulbasaur - Test set 001 (EN).png');
	});
});
