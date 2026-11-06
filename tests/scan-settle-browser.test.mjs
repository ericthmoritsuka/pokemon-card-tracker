// Holder mode takes a card only once it has settled (Eric, 2026-11-06,
// version 62), in headless Chromium, against tests/scan-harness.mjs
// (Supabase is never reached; TCGdex answers are replayed from the harness
// cache), with the canvas camera of tests/scan-scene.mjs.
//
// His v60 phone log: cards taken soft in the middle of a drop, and cards
// taken twice from one drop, about a second apart, with the next card in his
// hand out of focus over the card on top (js/scan/drop.js settleVerdict,
// view.js considerDrop). Here:
//
// - a card that lands soft and lies still a moment is not taken soft: it is
//   taken once it is sharp;
// - a card with a blurred card held over it, moving a little as a hand
//   does, waits, and is taken once, sharp, when the hand leaves;
// - the card just taken, with a blurred card held over it and then taken
//   away, is not taken again;
// - two different cards dropped one straight after the other are both
//   taken.
//
// The cards used are the harness's 'a' and 'c': the canvas draws card 'b'
// a little soft (its scan reads soft, so it is taken on patience).
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/scan-settle-browser.test.mjs

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

// Holder mode on, the scan log recording, the phone over the empty box from
// the first frame (tests/scan-holder-browser.test.mjs open says why).
async function open() {
	const context = await browser.newContext({deviceScaleFactor: 2.8125, viewport: {height: 900, width: 384}});

	await context.grantPermissions(['camera'], {origin: harness.origin});
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await routeTcgdex(context);

	for (const [key, id] of Object.entries(CARDS)) {
		await context.route(`**/__test-card${key === 'a' ? '' : `-${key}`}.webp`, async (route) => route.fulfill({contentType: 'image/webp', path: await cardImage(id)}));
	}

	await context.addInitScript(() => {
		if (sessionStorage.getItem('test-scene') === null) {
			sessionStorage.setItem('test-scene', JSON.stringify({background: 'box', cards: []}));
		}
	});
	await context.addInitScript(sceneCamera, FRAME);
	await context.addInitScript(() => {
		localStorage.setItem('card-tracker:scan-holder', 'on');
		localStorage.setItem('card-tracker:scan-log', 'on');
	});

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(String(err)));
	await page.goto(`${harness.origin}${BASE}scan`);
	await page.waitForSelector('#scan-guide:not([hidden])', {timeout: 30000});
	await page.waitForFunction(() => document.getElementById('scan-video').videoWidth > 0);
	await page.waitForSelector('#scan-shutter:not([disabled])');
	// The detector's first base: a second of a still empty box.
	await page.waitForTimeout(1500);

	return {context, errors, page};
}

const setScene = (page, scene) => page.evaluate((next) => {
	window.scene = next;
}, scene);

const captures = (page) => page.evaluate(async () => (await import('/pokemon-card-tracker/js/scan/view.js')).scanStats.captures);

const items = (page) => page.evaluate(async () => {
	const session = await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession();

	return session ? session.items.map((item) => ({card: item.card && item.card.id, copies: item.copies || 1, drop: item.report && item.report.geometry && item.report.geometry.drop, status: item.status})) : [];
});

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
// tests/scan-holder-browser.test.mjs does; `last` is drawn for its last step
// (a card landing soft), and `held` over everything throughout.
function drop(page, pile, card, {held = null, last = card} = {}) {
	return page.evaluate(async ({below, falling, hand, landed}) => {
		for (let step = 6; step >= 0; step--) {
			const now = step ? {...falling, angle: (falling.angle || 0) + step * 4, dy: (falling.dy || 0) - step * 0.16} : landed;

			window.scene = {background: 'box', cards: [...below, now], held: hand};
			await new Promise((resolve) => setTimeout(resolve, 60));
		}
	}, {below: pile, falling: card, hand: held, landed: last});
}

// A card held over the pile out of focus, moving a little every `every` ms
// as a hand does, for `ms` (the page's own timer, so the test's round trips
// cannot hold it still), over `pile`.
function hover(page, pile, held, {every = 140, ms = 3000, sway = 0.03} = {}) {
	return page.evaluate(async ({cards, card, each, total, by}) => {
		const end = performance.now() + total;

		for (let k = 0; performance.now() < end; k++) {
			window.scene = {background: 'box', cards, held: {...card, dx: (card.dx || 0) + (k % 2 ? by : -by), dy: (card.dy || 0) + (k % 3 ? by / 2 : 0)}};
			await new Promise((resolve) => setTimeout(resolve, each));
		}
	}, {by: sway, card: held, cards: pile, each: every, total: ms});
}

// The next card in the hand, over the bottom of the box, near the lens.
const HELD = {angle: -8, blur: 0.02, card: 'a', dx: 0.05, dy: 0.42, size: 1.25};
const SPOT = {angle: 1, dx: 0.01, dy: 0.02, size: 0.88};
// How that hand moves: a few pixels every quarter second, for two seconds
// (less than drop.js SETTLE_LIMIT_MS), so the view is still enough for the
// drop detector to judge it, as Eric's hand was in his v60 log.
const HAND = {every: 250, ms: 2000, sway: 0.006};

describe('holder mode takes a card once it has settled', () => {
	test('a card that lands soft is taken once it is sharp; with a blurred card held over it, it waits until the hand leaves', async () => {
		const {context, errors, page} = await open();

		// Lands soft and lies still for a moment (timed in the page, so the
		// test's round trips cannot stretch it past drop.js
		// SETTLE_PATIENCE_MS), then sharp.
		await drop(page, [], {...SPOT, card: 'c'}, {last: {...SPOT, blur: 0.012, card: 'c'}});

		const whileSoft = await page.evaluate(async (sharp) => {
			const view = await import('/pokemon-card-tracker/js/scan/view.js');

			await new Promise((resolve) => setTimeout(resolve, 700));

			const taken = view.scanStats.captures;

			window.scene = {background: 'box', cards: [sharp]};

			return taken;
		}, {...SPOT, card: 'c'});

		assert.equal(whileSoft, 0, 'not taken while soft');
		await until(async () => (await captures(page)) === 1, 'taken once sharp', 8000);

		// The next card lands with a blurred card held over the bottom of the
		// pile, moving a little as a hand does: nothing is taken while the
		// hand is there.
		const pile = [{...SPOT, card: 'c'}];
		const next = {angle: -1, card: 'a', dx: 0.02, dy: 0.03, size: 0.88};

		await page.waitForTimeout(900);
		await drop(page, pile, next, {held: HELD});
		await hover(page, [...pile, next], HELD, HAND);
		assert.equal(await captures(page), 1, 'nothing taken with the hand over the card');

		// The hand leaves: the card is taken, once.
		await setScene(page, {background: 'box', cards: [...pile, next]});
		await until(async () => (await captures(page)) === 2, 'taken once the hand left', 8000);
		await page.waitForTimeout(1500);
		assert.equal(await captures(page), 2, 'taken once');
		await readAll(page, 2);

		const list = await items(page);

		assert.deepEqual(list.map((item) => item.card), [CARDS.c, CARDS.a], JSON.stringify(list.map((item) => item.drop && item.drop.settle)));

		for (const [index, item] of list.entries()) {
			assert.ok(item.drop.settle, `drop ${index + 1}: its settle numbers are logged`);
			assert.ok(item.drop.settle.blur <= 0.09, `drop ${index + 1} taken sharp: ${JSON.stringify(item.drop.settle)}`);
			assert.equal(item.drop.settle.patience, false, `drop ${index + 1}: not taken on patience`);
			assert.equal(item.drop.settle.limit, false, `drop ${index + 1}: not taken for waiting too long`);
		}

		assert.ok(list[0].drop.settle.waited.includes('soft'), `the first waited while soft: ${JSON.stringify(list[0].drop.settle)}`);

		assert.deepEqual(errors, []);
		await context.close();
	});

	test('the card just taken is not taken again when a blurred card is held over it and taken away', async () => {
		const {context, errors, page} = await open();
		const pile = [{...SPOT, card: 'c'}];

		await drop(page, [], pile[0]);
		await until(async () => (await captures(page)) === 1, 'card c taken', 8000);
		await readAll(page, 1);
		await page.waitForTimeout(900);

		// The hand comes in over the card, holds still for a second, and
		// goes (version 61 took the card again here: its print read new under
		// the hand); then it comes in moving a little, and then passes over it
		// moving a lot: the card is not taken again. (A hand passing with a
		// disturbance like a drop's may bring up the repeat bar, version 40,
		// which takes nothing.)
		await hover(page, pile, HELD, {every: 250, ms: 1000, sway: 0});
		await setScene(page, {background: 'box', cards: pile});
		await page.waitForTimeout(2000);
		assert.equal(await captures(page), 1, 'not taken again after a hand held still over it');
		await setScene(page, {background: 'box', cards: pile, held: HELD});
		await hover(page, pile, HELD, HAND);
		await setScene(page, {background: 'box', cards: pile});
		await page.waitForTimeout(2000);
		assert.equal(await captures(page), 1, 'not taken again');
		await hover(page, pile, HELD, {every: 140, ms: 2000, sway: 0.03});
		await setScene(page, {background: 'box', cards: pile});
		await page.waitForTimeout(2000);
		assert.equal(await captures(page), 1, 'not taken again after a hand passing');
		assert.equal((await items(page)).length, 1);
		assert.equal((await items(page))[0].copies, 1, 'no copy added');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('two different cards dropped one straight after the other are both taken', async () => {
		const {context, errors, page} = await open();
		const first = {...SPOT, card: 'a'};
		const second = {angle: -2, card: 'c', dx: -0.02, dy: 0.05, size: 0.9};

		await drop(page, [], first);
		await until(async () => (await captures(page)) === 1, 'the first taken', 8000);
		await drop(page, [first], second);
		await until(async () => (await captures(page)) === 2, 'the second taken', 8000);
		await readAll(page, 2);
		assert.deepEqual((await items(page)).map((item) => item.card), [CARDS.a, CARDS.c]);
		assert.deepEqual(errors, []);
		await context.close();
	});
});
