// A new card means a new picture (Eric, 2026-10-16), in headless Chromium,
// against tests/scan-harness.mjs (Supabase is never reached; TCGdex answers
// are replayed from the harness cache), with the canvas camera of
// tests/scan-scene.mjs:
//
// - holder mode: a different card landing on the very spot of the last is
//   taken; the same card dropped again on it asks "Same card as the last
//   one." (Add a copy, Mistake) and takes nothing; the last card nudged
//   takes nothing and asks nothing (js/scan/drop.js contentCheck,
//   contentAt, disturbedBy; view.js holderTick);
// - hand-held: Eric's pile method (scan the top card, take it off, scan the
//   card beneath) takes each card, and the same card found again after a
//   hand passed over it asks (steady.js createAutoCapture's disturbance,
//   view.js readItemNow).
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/scan-newcard-browser.test.mjs

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {cardImage, routeTcgdex, startScanHarness} from './scan-harness.mjs';
import {sceneCamera} from './scan-scene.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const CARDS = {a: 'me01-001', b: 'sv03.5-025', c: 'swsh3-102'};
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

// The camera shows `scene` from its first frame (see
// tests/scan-holder-browser.test.mjs open).
async function open({holder = true, scene = holder ? {background: 'box', cards: []} : {kind: 'table'}} = {}) {
	const context = await browser.newContext({deviceScaleFactor: 2.8125, viewport: {height: 900, width: 384}});

	await context.grantPermissions(['camera'], {origin: harness.origin});
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await routeTcgdex(context);

	for (const [key, id] of Object.entries(CARDS)) {
		await context.route(`**/__test-card${key === 'a' ? '' : `-${key}`}.webp`, async (route) => route.fulfill({contentType: 'image/webp', path: await cardImage(id)}));
	}

	await context.addInitScript((first) => {
		if (sessionStorage.getItem('test-scene') === null) {
			sessionStorage.setItem('test-scene', JSON.stringify(first));
		}
	}, scene);
	await context.addInitScript(sceneCamera, FRAME);
	await context.addInitScript((on) => {
		localStorage.setItem('card-tracker:scan-holder', on ? 'on' : 'off');
		localStorage.setItem('card-tracker:scan-log', 'on');
	}, holder);

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(String(err)));
	await page.goto(`${harness.origin}${BASE}scan`);
	await page.waitForSelector('#scan-guide:not([hidden])', {timeout: 30000});
	await page.waitForFunction(() => document.getElementById('scan-video').videoWidth > 0);
	await page.waitForSelector('#scan-shutter:not([disabled])');

	return {context, errors, page};
}

const setScene = (page, scene) => page.evaluate((next) => {
	window.scene = next;
}, scene);

const captures = (page) => page.evaluate(async () => (await import('/pokemon-card-tracker/js/scan/view.js')).scanStats.captures);

const items = (page) => page.evaluate(async () => {
	const session = await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession();

	return session ? session.items.map((item) => ({card: item.card && item.card.id, copies: item.copies || 1, drop: item.report && item.report.geometry && item.report.geometry.drop, id: item.id, status: item.status})) : [];
});

const holderLog = (page) => page.evaluate(async () => (await (await import('/pokemon-card-tracker/js/scan/log.js')).listEntries()).filter((entry) => entry.how === 'holder').map((entry) => ({drop: entry.drop, outcome: entry.outcome && entry.outcome.kind, why: entry.why})));

// The scene drawn again a moment later: the canvas stream can drop the one
// frame drawn right after a quick run of changes, and an unchanged scene is
// not drawn again (tests/scan-scene.mjs), which leaves the hand on the
// picture.
async function repaint(page) {
	await page.waitForTimeout(250);
	await page.evaluate(() => {
		window.scene = {...window.scene};
	});
}

const barOpen = (page) => page.locator('#scan-repeat-add').count();

async function until(check, what, timeout = 30000) {
	const end = Date.now() + timeout;

	while (!(await check())) {
		assert.ok(Date.now() < end, what);
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
}

async function readAll(page, count) {
	await until(async () => {
		const list = await items(page);

		return list.length === count && list.every((item) => item.status !== 'reading' && item.status !== 'matching');
	}, `${count} cards read`, 60000);
}

// Drops `card` onto the pile from above the frame, as
// tests/scan-holder-browser.test.mjs does.
function drop(page, pile, card) {
	return page.evaluate(async ({below, falling}) => {
		for (let step = 6; step >= 0; step--) {
			window.scene = {background: 'box', cards: [...below, {...falling, angle: (falling.angle || 0) + step * 4, dy: (falling.dy || 0) - step * 0.16}]};
			await new Promise((resolve) => setTimeout(resolve, 60));
		}
	}, {below: pile, falling: card});
}

describe('holder mode: a new card is a new picture', () => {
	test('a different card on the very spot is taken; the same card dropped again asks and takes nothing; Add a copy adds one', async () => {
		const {context, errors, page} = await open();
		const spot = {angle: 1, dx: 0.01, dy: 0.02, size: 0.88};

		await page.waitForTimeout(1500);
		await drop(page, [], {...spot, card: 'a'});
		await until(async () => (await captures(page)) === 1, 'card a taken', 8000);
		await page.waitForTimeout(900);

		// b exactly on a's spot.
		await drop(page, [{...spot, card: 'a'}], {...spot, card: 'b'});
		await until(async () => (await captures(page)) === 2, 'card b on the very spot taken', 8000);
		await readAll(page, 2);
		await page.waitForTimeout(900);

		// b again, a second copy, exactly on b.
		await drop(page, [{...spot, card: 'a'}, {...spot, card: 'b'}], {...spot, card: 'b'});
		await page.waitForSelector('#scan-repeat-add', {timeout: 8000});
		assert.equal(await page.locator('#scan-repeat-text').textContent(), 'Same card as the last one.');
		assert.equal(await captures(page), 2, 'the same card again takes no picture');
		await page.click('#scan-repeat-add');

		let list = await items(page);

		await until(async () => {
			list = await items(page);

			return list.length === 2 && list[1].copies === 2;
		}, 'Add a copy adds one to the last card');
		assert.deepEqual(list.map((item) => item.card), [CARDS.a, CARDS.b]);
		assert.equal(list[1].drop.printVerdict, 'new', 'b was told new by its picture');
		assert.ok(list[1].drop.print >= 24, `b's print far from a's: ${list[1].drop.print}`);

		// The repeat in the scan log, with its answer.
		await until(async () => (await holderLog(page)).some((entry) => entry.why === 'same card again' && entry.outcome === 'added-copy'), 'the repeat in the scan log');

		const repeat = (await holderLog(page)).find((entry) => entry.why === 'same card again');

		assert.equal(repeat.drop.printVerdict, 'same');
		assert.equal(repeat.drop.disturbed, true);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('the last card nudged takes nothing and asks nothing; Mistake on a repeat adds nothing', async () => {
		const {context, errors, page} = await open();
		const spot = {angle: 1, dx: 0.01, dy: 0.02, size: 0.88};

		await page.waitForTimeout(1500);
		await drop(page, [], {...spot, card: 'c'});
		await until(async () => (await captures(page)) === 1, 'card c taken', 8000);
		await readAll(page, 1);
		await page.waitForTimeout(1200);

		// Nudged: moved and turned a little from one frame to the next, as a
		// knock on the box moves it.
		await setScene(page, {background: 'box', cards: [{...spot, angle: 2.5, card: 'c', dx: 0.025, dy: 0.03}]});
		await page.waitForTimeout(2500);
		assert.equal(await captures(page), 1, 'a nudge takes nothing');
		assert.equal(await barOpen(page), 0, 'a nudge asks nothing');

		// The same card again after a drop's disturbance, answered Mistake.
		const nudged = {...spot, angle: 2.5, card: 'c', dx: 0.025, dy: 0.03};

		await drop(page, [nudged], nudged);
		await page.waitForSelector('#scan-repeat-add', {timeout: 8000});
		await page.click('#scan-repeat-no');
		assert.equal(await barOpen(page), 0);

		const list = await items(page);

		assert.equal(list.length, 1);
		assert.equal(list[0].copies, 1, 'Mistake adds nothing');
		assert.equal(await captures(page), 1);
		assert.deepEqual(errors, []);
		await context.close();
	});
});

describe('hand-held: a new card is a new picture', () => {
	test('Eric\'s pile method: the top card is taken, taken off, and the card beneath is taken', async () => {
		const {context, errors, page} = await open({holder: false});
		const pile = [{card: 'a', size: 0.95}, {angle: 0.6, card: 'c', size: 0.95}];

		await setScene(page, {cards: pile});
		await until(async () => (await captures(page)) === 1, 'the top card taken', 10000);
		await readAll(page, 1);

		// A hand takes the top card off: it comes over the pile and goes,
		// the top card with it.
		for (const [k, dx] of [0.5, 0.25, 0, -0.25, -0.5].entries()) {
			await setScene(page, {cards: k < 2 ? pile : pile.slice(0, 1), hand: {dx, dy: 0.1, r: 0.35}});
			await page.waitForTimeout(110);
		}

		await setScene(page, {cards: pile.slice(0, 1)});
		await repaint(page);
		await until(async () => (await captures(page)) === 2, 'the card beneath taken', 10000);
		await readAll(page, 2);

		const list = await items(page);

		assert.deepEqual(list.map((item) => item.card), [CARDS.c, CARDS.a]);
		assert.equal(await barOpen(page), 0);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('the same card found again after a hand passed over it asks Add a copy or Mistake', async () => {
		const {context, errors, page} = await open({holder: false});
		const card = {card: 'b', size: 0.95};

		await setScene(page, {cards: [card]});
		await until(async () => (await captures(page)) === 1, 'the card taken', 10000);
		await readAll(page, 1);
		await page.waitForTimeout(1500);
		assert.equal(await captures(page), 1, 'held still: taken once');

		for (const dx of [0.5, 0.25, 0, -0.25, -0.5]) {
			await setScene(page, {cards: [card], hand: {dx, dy: 0.1, r: 0.35}});
			await page.waitForTimeout(110);
		}

		await setScene(page, {cards: [card]});
		await repaint(page);
		await page.waitForSelector('#scan-repeat-add', {timeout: 30000});
		await page.click('#scan-repeat-no');

		const list = await items(page);

		assert.equal(list.length, 1);
		assert.deepEqual(errors, []);
		await context.close();
	});
});
