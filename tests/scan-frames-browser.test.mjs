// What the scanner does with frames that are not a card held to the guide,
// in headless Chromium, against tests/scan-harness.mjs (Supabase is never
// reached; TCGdex answers are replayed from the harness cache).
//
// - Q-19: a blank frame or a sheet of paper taken with the shutter does not
//   join the tray, and a card held too far away is never taken on its own
//   but shows "Move closer".
// - Q-20: opening Scan again with the card just added still in front of
//   the camera does not add it again, unless the shutter is tapped.
// - The continuous scanning tests (tests/scan-log-browser.test.mjs) use
//   the same canvas camera, with a second card.
//
// getUserMedia is replaced by a portrait canvas stream, as in
// tests/scan-guide-browser.test.mjs, whose scene the test sets through
// window.scene: a table, a sheet of printed paper, or a TCGdex card scan at
// a share of the guide's height.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/scan-frames-browser.test.mjs

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {cardImage, routeTcgdex, startScanHarness} from './scan-harness.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const CARD = 'me01-001';
const CARD_B = 'sv03.5-025';
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

// In the page before any script: getUserMedia answers with a portrait
// canvas stream showing window.scene ({kind: 'table' | 'paper' | 'card',
// size, card: 'a' | 'b'}), the card or paper placed where the guide
// outline is. navigator.vibrate records each buzz in window.buzzes.
function portraitCamera({height, width}) {
	const canvas = document.createElement('canvas');
	const ctx = canvas.getContext('2d');
	const cards = {a: new Image(), b: new Image()};

	canvas.width = width;
	canvas.height = height;
	cards.a.src = '/__test-card.webp';
	cards.b.src = '/__test-card-b.webp';
	window.buzzes = [];
	navigator.vibrate = (pattern) => {
		window.buzzes.push(pattern);

		return true;
	};
	// Kept across a reload, as a card on the table would be.
	window.scene = JSON.parse(sessionStorage.getItem('test-scene') || 'null') || {kind: 'table'};

	const draw = () => {
		ctx.fillStyle = '#7a6250';
		ctx.fillRect(0, 0, width, height);

		const guide = document.getElementById('scan-guide');
		const video = document.getElementById('scan-video');
		const scene = window.scene;

		if (scene.kind === 'table' || !guide || guide.hidden || !video) {
			return;
		}

		// The guide's layout box, not its drawn one: the capture flash
		// scales the guide for a moment, and a real camera's picture does
		// not follow it.
		const stage = guide.offsetParent.getBoundingClientRect();
		const g = {height: guide.offsetHeight, left: stage.left + guide.offsetLeft, top: stage.top + guide.offsetTop, width: guide.offsetWidth};
		const v = video.getBoundingClientRect();
		const scale = Math.max(v.width / width, v.height / height);
		const offsetX = v.left + (v.width - width * scale) / 2;
		const offsetY = v.top + (v.height - height * scale) / 2;
		const cx = (g.left + g.width / 2 - offsetX) / scale;
		const cy = (g.top + g.height / 2 - offsetY) / scale;
		const gh = g.height / scale;

		if (scene.kind === 'paper') {
			const ph = gh * 1.1;
			const pw = ph * 0.75;

			ctx.fillStyle = '#f4f1ea';
			ctx.fillRect(cx - pw / 2, cy - ph / 2, pw, ph);
			ctx.fillStyle = '#222';
			ctx.font = `${Math.round(ph / 40)}px serif`;

			for (let i = 1; i < 34; i++) {
				ctx.fillText('The quick brown fox jumps over the lazy dog, 12 34', cx - pw / 2 + pw * 0.06, cy - ph / 2 + i * ph / 34);
			}

			return;
		}

		const card = cards[scene.card || 'a'];

		if (card.complete) {
			const ch = gh * scene.size;
			const cw = ch * 63 / 88;

			ctx.save();
			ctx.translate(cx, cy);
			ctx.rotate(0.6 * Math.PI / 180);
			ctx.drawImage(card, -cw / 2, -ch / 2, cw, ch);
			ctx.restore();
		}
	};

	draw();
	setInterval(draw, 40);

	// A new stream each time: leaving Scan stops the tracks of the last one.
	navigator.mediaDevices.getUserMedia = async () => canvas.captureStream(25);
}

async function open({record = false, viewport = {height: 780, width: 384}} = {}) {
	const context = await browser.newContext({acceptDownloads: true, deviceScaleFactor: 2.8125, viewport});

	await context.grantPermissions(['camera'], {origin: harness.origin});
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await routeTcgdex(context);
	await context.route('**/__test-card.webp', async (route) => route.fulfill({contentType: 'image/webp', path: await cardImage(CARD)}));
	await context.route('**/__test-card-b.webp', async (route) => route.fulfill({contentType: 'image/webp', path: await cardImage(CARD_B)}));
	await context.addInitScript(portraitCamera, FRAME);

	if (record) {
		await context.addInitScript(() => localStorage.setItem('card-tracker:scan-log', 'on'));
	}

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(String(err)));
	await gotoScan(page);

	return {context, errors, page};
}

async function gotoScan(page) {
	await page.goto(`${harness.origin}${BASE}scan`);
	await page.waitForSelector('#scan-guide:not([hidden])', {timeout: 30000});
	await page.waitForFunction(() => document.getElementById('scan-video').videoWidth > 0);
	await page.waitForSelector('#scan-shutter:not([disabled])');
}

const setScene = (page, scene) => page.evaluate((next) => {
	window.scene = next;
	sessionStorage.setItem('test-scene', JSON.stringify(next));
}, scene);

const captures = (page) => page.evaluate(async () => (await import('/pokemon-card-tracker/js/scan/view.js')).scanStats.captures);

// Waits until the scanner has taken at least `count` pictures since the
// page loaded.
async function capturesReach(page, count, timeout = 10000) {
	const until = Date.now() + timeout;

	while (await captures(page) < count) {
		assert.ok(Date.now() < until, `${count} captures within ${timeout} ms`);
		await page.waitForTimeout(100);
	}
}

const tiles = (page) => page.locator('#scan-tray .scan-tile').count();

const noteText = (page) => page.evaluate(() => document.getElementById('scan-note').textContent);

// Waits until no card in the tray is still being read or looked up.
async function settled(page, timeout = 90000) {
	await page.waitForFunction(() => ![...document.querySelectorAll('#scan-tray .scan-tile')].some((tile) => ['reading', 'matching'].includes(tile.dataset.status)), null, {polling: 200, timeout});
}

describe('frames with no card, and a card held too far away (Q-19)', () => {
	test('a blank frame taken with the shutter does not join the tray', async () => {
		const {context, errors, page} = await open();

		await page.waitForTimeout(1500);
		assert.equal(await captures(page), 0, 'the table alone is never taken on its own');

		await page.click('#scan-shutter');
		await page.waitForFunction(() => /did not look like a card/.test(document.getElementById('scan-note').textContent), null, {polling: 200, timeout: 90000});

		assert.equal(await tiles(page), 0);
		assert.equal(await captures(page), 1);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a sheet of printed paper taken with the shutter does not join the tray', async () => {
		const {context, errors, page} = await open();

		await setScene(page, {kind: 'paper'});
		await page.waitForTimeout(1500);
		assert.equal(await captures(page), 0, 'paper is never taken on its own');

		await page.click('#scan-shutter');
		await page.waitForFunction(() => /did not look like a card/.test(document.getElementById('scan-note').textContent), null, {polling: 200, timeout: 90000});

		assert.equal(await tiles(page), 0);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a card held too far away shows Move closer, is not taken on its own, and stays when the shutter takes it', async () => {
		const {context, errors, page} = await open();

		await setScene(page, {kind: 'card', size: 0.42});
		await page.waitForFunction(() => document.getElementById('scan-hint').textContent === 'Move closer.', null, {polling: 100, timeout: 5000});
		await page.waitForTimeout(2000);
		assert.equal(await captures(page), 0, 'not taken on its own');

		await page.click('#scan-shutter');
		await page.waitForFunction(() => document.querySelectorAll('#scan-tray .scan-tile').length === 1, null, {timeout: 5000});
		await settled(page);

		assert.equal(await tiles(page), 1, 'the shutter keeps a card held too far away');
		assert.match(await noteText(page), /Move closer/);
		assert.deepEqual(errors, []);
		await context.close();
	});
});

describe('opening Scan again with the same card in view (Q-20)', () => {
	test('the card is not added again, and the shutter still adds it', async () => {
		const {context, errors, page} = await open();
		const sessionCards = () => page.evaluate(async () => {
			const session = await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession();

			return session ? session.items.map((item) => item.card && item.card.id) : [];
		});
		// The tray as kept on the phone (draft.js), which is written a moment
		// after the screen changes.
		const sessionIs = async (cards) => {
			for (let i = 0; i < 100 && JSON.stringify(await sessionCards()) !== JSON.stringify(cards); i++) {
				await page.waitForTimeout(100);
			}

			assert.deepEqual(await sessionCards(), cards);
		};

		await setScene(page, {kind: 'card', size: 0.95});
		await page.waitForFunction(() => document.querySelectorAll('#scan-tray .scan-tile').length === 1, null, {timeout: 10000});
		await settled(page);
		await sessionIs([CARD]);

		// Away to My Cards and back, the card still in front of the camera.
		// (The first card's sheet is open over the Close button.)
		await page.evaluate(async () => (await import('/pokemon-card-tracker/js/dom.js')).go('cards'));
		await page.waitForURL((url) => !url.pathname.endsWith('/scan'));
		await page.waitForTimeout(500);
		await page.evaluate(async () => (await import('/pokemon-card-tracker/js/dom.js')).go('scan'));
		await page.waitForSelector('#scan-shutter:not([disabled])', {timeout: 30000});
		await capturesReach(page, 2);
		await settled(page);
		await page.waitForFunction(() => /just added/.test(document.getElementById('scan-note').textContent), null, {polling: 200, timeout: 30000});
		assert.equal(await tiles(page), 1, 'back on Scan: still one card');

		// A reload, the same, once the tray on the phone has caught up.
		await sessionIs([CARD]);
		await page.reload();
		await page.waitForSelector('#scan-shutter:not([disabled])', {timeout: 30000});
		await capturesReach(page, 1);
		await settled(page);
		await page.waitForFunction(() => /just added/.test(document.getElementById('scan-note').textContent), null, {polling: 200, timeout: 30000});
		assert.equal(await tiles(page), 1, 'after a reload: still one card');

		// The shutter means it: a second copy.
		await page.click('#scan-shutter');
		await page.waitForFunction(() => document.querySelectorAll('#scan-tray .scan-tile').length === 2, null, {timeout: 10000});
		await settled(page);
		await sessionIs([CARD, CARD]);
		assert.deepEqual(errors, []);
		await context.close();
	});
});
