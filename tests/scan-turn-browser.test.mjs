// A card upside down or on its side (js/scan/picture.js matchCrops turns),
// in headless Chromium, against tests/scan-harness.mjs (Supabase is never
// reached; TCGdex answers are replayed from the harness cache).
//
// The camera is tests/scan-scene.mjs's canvas: a card held to the guide
// upside down, and cards dropped under a phone in a holder upside down and
// on their side. Each must be named, its tray photo turned upright, and its
// scan report must say how it lay.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/scan-turn-browser.test.mjs

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {cardImage, routeTcgdex, startScanHarness} from './scan-harness.mjs';
import {sceneCamera} from './scan-scene.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const CARDS = {a: 'me01-001', b: 'sv03.5-025'};
const FRAME = {height: 3840, width: 2160};

let harness;
let browser;

before(async () => {
	harness = await startScanHarness();
	browser = await chromium.launch();
});

after(async () => {
	await browser.close();
	await harness.close();
});

async function open({holder, scene}) {
	const context = await browser.newContext({deviceScaleFactor: 2.8125, viewport: {height: 900, width: 384}});

	await context.grantPermissions(['camera'], {origin: harness.origin});
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await context.route('https://*.supabase.co/**', (route) => route.abort());
	await routeTcgdex(context);

	for (const [key, id] of Object.entries(CARDS)) {
		await context.route(`**/__test-card${key === 'a' ? '' : `-${key}`}.webp`, async (route) => route.fulfill({contentType: 'image/webp', path: await cardImage(id)}));
	}

	await context.route('**/__test-card-c.webp', async (route) => route.fulfill({contentType: 'image/webp', path: await cardImage(CARDS.a)}));
	await context.addInitScript((first) => sessionStorage.setItem('test-scene', JSON.stringify(first)), scene);
	await context.addInitScript(sceneCamera, FRAME);
	await context.addInitScript((on) => localStorage.setItem('card-tracker:scan-holder', on ? 'on' : 'off'), holder);

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(String(err)));
	await page.goto(`${harness.origin}${BASE}scan`);
	await page.waitForSelector('#scan-guide:not([hidden])', {timeout: 30000});
	await page.waitForFunction(() => document.getElementById('scan-video').videoWidth > 0);
	await page.waitForSelector('#scan-shutter:not([disabled])');

	return {context, errors, page};
}

const captures = (page) => page.evaluate(async () => (await import('/pokemon-card-tracker/js/scan/view.js')).scanStats.captures);

const items = (page) => page.evaluate(async () => {
	const session = await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession();

	return session ? session.items.map((item) => ({card: item.card && item.card.id, picture: item.report && item.report.picture && {how: item.report.picture.how, top: item.report.picture.groups.slice(0, 2), turn: item.report.picture.turn}, status: item.status, sure: item.sure})) : [];
});

async function until(check, what, timeout = 30000) {
	const end = Date.now() + timeout;

	while (!(await check())) {
		assert.ok(Date.now() < end, what);
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
}

const read = async (page, count) => {
	await until(async () => {
		const list = await items(page);

		return list.length === count && !['reading', 'matching'].includes(list[count - 1].status);
	}, `${count} cards read`, 90000);

	return items(page);
};

// The tray photo of the last card against the card's own image, upright
// and upside down, as the mean difference of 24 x 33 grey thumbnails.
const photoLooks = (page) => page.evaluate(async () => {
	const photo = document.querySelector('#scan-tray li:last-child .scan-tile-photo');

	if (!photo) {
		return null;
	}

	await photo.decode();

	const card = new Image();

	card.src = '/__test-card.webp';
	await card.decode();

	const grey = (image, turned) => {
		const canvas = document.createElement('canvas');

		canvas.width = 24;
		canvas.height = 33;

		const ctx = canvas.getContext('2d');

		if (turned) {
			ctx.translate(24, 33);
			ctx.rotate(Math.PI);
		}

		ctx.drawImage(image, 0, 0, 24, 33);

		const {data} = ctx.getImageData(0, 0, 24, 33);

		return Array.from({length: 24 * 33}, (_, i) => data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2]);
	};
	const mine = grey(photo, false);
	const away = (other) => other.reduce((sum, value, i) => sum + Math.abs(value - mine[i]), 0) / other.length;

	return {ratio: photo.naturalWidth / photo.naturalHeight, turned: Math.round(away(grey(card, true))), upright: Math.round(away(grey(card, false)))};
});

describe('a card that lies another way', () => {
	test('held to the guide upside down: named, turned upright, and the report says so', async () => {
		const {context, errors, page} = await open({holder: false, scene: {background: 'table', cards: [{angle: 180.6, card: 'a', size: 0.95}]}});
		const upright = (await (async () => {
			await until(async () => (await captures(page)) >= 1, 'auto capture of the card held still', 15000);

			return read(page, 1);
		})())[0];

		assert.equal(upright.card, CARDS.a, JSON.stringify(upright));
		assert.equal(upright.picture.turn, 2, 'it lay upside down');
		assert.match(upright.picture.how, /upside down/);

		const looks = await photoLooks(page);

		assert.ok(looks && looks.ratio < 1, 'the tray photo stands upright');
		assert.ok(looks.upright < looks.turned, `the tray photo matches the card upright, not upside down (${JSON.stringify(looks)})`);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('dropped under a holder upside down and on its side: each named', async () => {
		const {context, errors, page} = await open({holder: true, scene: {background: 'box', cards: []}});

		await page.waitForTimeout(1500);

		const drops = [
			{angle: 179, card: 'a', size: 0.86},
			{angle: 91, card: 'b', dx: 0.02, dy: 0.04, size: 0.62},
		];
		const pile = [];

		for (const [index, card] of drops.entries()) {
			await page.evaluate(async ({below, falling}) => {
				for (let step = 6; step >= 0; step--) {
					window.scene = {background: 'box', cards: [...below, {...falling, angle: falling.angle + step * 4, dy: (falling.dy || 0) - step * 0.16}]};
					await new Promise((resolve) => setTimeout(resolve, 60));
				}
			}, {below: pile, falling: card});
			await until(async () => (await captures(page)) === index + 1, `drop ${index + 1} taken`, 10000);
			pile.push(card);
			await read(page, index + 1);
		}

		const list = await items(page);

		// The picture names each card's artwork first (Pikachu's group holds
		// its Japanese twin too, which the number read chooses between).
		assert.equal(list[0].card, CARDS.a, JSON.stringify(list));
		assert.equal(list[0].picture.turn, 2, 'the first lay upside down');
		assert.ok(list[1].picture.top[0].cards.includes(CARDS.b), `the second, on its side, is named by its picture: ${JSON.stringify(list[1])}`);
		assert.ok(list[1].picture.top[1].score - list[1].picture.top[0].score >= 10, 'with a clear lead');
		assert.deepEqual(errors, []);
		await context.close();
	});
});
