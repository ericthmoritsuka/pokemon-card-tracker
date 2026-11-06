// Holder mode retries a blurred capture and never adds a repeat (Eric,
// 2026-11-06, version 64), in headless Chromium, against
// tests/scan-harness.mjs (Supabase is never reached; TCGdex answers are
// replayed from the harness cache), with the canvas camera of
// tests/scan-scene.mjs.
//
// His phone log of versions 60 to 63: cards taken blurred while his hand
// brought the next card near the lens, out of focus, over the card on top,
// and the card on top taken twice about a second apart, the second time
// with that hand over it (js/scan/view.js captureDrop, drop.js
// retryVerdict). His rule: never lose a card. Here:
//
// - a card that lands blurred and then lies sharp is added once, from the
//   sharp look;
// - a card that stays blurred is added all the same once drop.js RETRY_MS
//   passes, marked to check;
// - a card whose own print reads soft, as a basic Energy's does, is added,
//   not held back;
// - the card just taken, with a blurred card held over it and then taken
//   away, is not added again (logged as a repeat), and with the blurred
//   card held there past RETRY_MS, the blurred look is added marked and the
//   card beneath is still not added again;
// - two different cards dropped one straight after the other, the second
//   on top of the first, are both added.
//
// The cards used are the harness's 'a' and 'c', which the canvas draws
// sharp.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/scan-retry-browser.test.mjs

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {untilInPage} from './poll.mjs';
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

// The tray as kept in the draft: each card's match, status, whether it was
// added blurred, and its drop's numbers.
const items = (page) => page.evaluate(async () => {
	const session = await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession();

	return session ? session.items.map((item) => ({blurred: Boolean(item.blurred), card: item.card && item.card.id, copies: item.copies || 1, drop: item.report && item.report.geometry && item.report.geometry.drop, id: item.id, status: item.status})) : [];
});

// The holder entries of the scan log that took nothing: why, and the wait
// of a blurred capture.
const skipped = (page) => page.evaluate(async () => {
	const log = await import('/pokemon-card-tracker/js/scan/log.js');

	return (await log.listEntries()).filter((entry) => entry.how === 'holder').map((entry) => ({drop: entry.drop, retry: entry.drop && entry.drop.retry, why: entry.why}));
});

// Until scanStats.captures reaches `count`, polled in the page.
const capturedAt = (page, count, what, timeout = 10000) => untilInPage(page, what, async (n) => (await import('/pokemon-card-tracker/js/scan/view.js')).scanStats.captures >= n, {arg: count, timeout});

// Until `count` cards are in the tray and read. errors: the page's errors,
// named in the failure.
const readAll = (page, count, errors = []) => untilInPage(page, `${count} cards read (errors: ${errors.join('; ') || 'none'})`, async (n) => {
	const session = await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession();

	return Boolean(session) && session.items.length === n && session.items.every((item) => item.status !== 'reading' && item.status !== 'matching');
}, {arg: count, timeout: 60000});

// Drops `card` onto the pile from above the frame, as
// tests/scan-holder-browser.test.mjs does; `last` is drawn for its last step
// (a card landing blurred), and `held` over everything throughout.
function drop(page, pile, card, {held = null, last = card} = {}) {
	return page.evaluate(async ({below, falling, hand, landed}) => {
		for (let step = 6; step >= 0; step--) {
			const now = step ? {...falling, angle: (falling.angle || 0) + step * 4, dy: (falling.dy || 0) - step * 0.16} : landed;

			window.scene = {background: 'box', cards: [...below, now], held: hand};
			await new Promise((resolve) => setTimeout(resolve, 60));
		}
	}, {below: pile, falling: card, hand: held, landed: last});
}

const SPOT = {angle: 1, dx: 0.01, dy: 0.02, size: 0.88};

describe('holder mode retries a blurred capture, and never adds a repeat (version 64)', () => {
	test('a card that lands blurred and then lies sharp is added once, from its sharp look', async () => {
		const {context, errors, page} = await open();

		// Lands blurred and lies still a moment (timed in the page, so the
		// test's round trips cannot stretch it past drop.js RETRY_MS), then
		// sharp.
		await drop(page, [], {...SPOT, card: 'c'}, {last: {...SPOT, blur: 0.012, card: 'c'}});

		const whileBlurred = await page.evaluate(async (sharp) => {
			const view = await import('/pokemon-card-tracker/js/scan/view.js');

			await new Promise((resolve) => setTimeout(resolve, 700));

			const taken = view.scanStats.captures;

			window.scene = {background: 'box', cards: [sharp]};

			return taken;
		}, {...SPOT, card: 'c'});

		assert.equal(whileBlurred, 0, 'not added while blurred (version 63 took it at once)');
		await capturedAt(page, 1, 'added once sharp');
		await page.waitForTimeout(2000);
		assert.equal(await captures(page), 1, 'added once');
		await readAll(page, 1, errors);

		const [item] = await items(page);

		assert.equal(item.card, CARDS.c);
		assert.equal(item.blurred, false, 'not marked: its picture is the sharp look');
		assert.ok(item.drop.retry && ['sharp', 'retaken'].includes(item.drop.retry.verdict), `taken from a sharper look: ${JSON.stringify(item.drop.retry)}`);
		assert.ok(item.drop.retry.blur > 0.09 || item.drop.retry.why === 'plain', `the first look read out of focus: ${JSON.stringify(item.drop.retry)}`);
		assert.ok(item.drop.focus && item.drop.focus.why === null, `the look taken reads sharp: ${JSON.stringify(item.drop.focus)}`);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a card that stays blurred is added all the same once RETRY_MS passes, marked to check', async () => {
		const {context, errors, page} = await open();

		await drop(page, [], {...SPOT, card: 'c'}, {last: {...SPOT, blur: 0.02, card: 'c'}});

		const early = await page.evaluate(async () => {
			const view = await import('/pokemon-card-tracker/js/scan/view.js');

			await new Promise((resolve) => setTimeout(resolve, 700));

			return view.scanStats.captures;
		});

		assert.equal(early, 0, 'it waits for a sharper look first');
		await capturedAt(page, 1, 'added once no sharper look came', 6000);
		await page.waitForTimeout(1500);
		assert.equal(await captures(page), 1, 'added once');
		await readAll(page, 1, errors);

		const [item] = await items(page);

		assert.equal(item.blurred, true, 'marked: its picture was blurred');
		assert.equal(item.drop.retry.verdict, 'kept blurred');
		assert.equal(item.drop.retry.reason, 'time');
		assert.ok(item.drop.retry.ms >= 1400, `it waited RETRY_MS: ${item.drop.retry.ms} ms`);

		// The tray says to check it, and its sheet says why.
		await page.waitForSelector(`[data-item="${item.id}"] .scan-status-look, #scan-look-count`);
		await page.click('#scan-look-count');
		await page.waitForSelector('#scan-why');
		assert.match(await page.textContent('#scan-why'), /Check this one: its picture was blurred\./);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a card whose own print reads soft, as a basic Energy\'s does, is added and not held back', async () => {
		const {context, errors, page} = await open();
		// A print a little soft of its own, lying dead still: no sharper look
		// ever comes.
		const soft = {...SPOT, blur: 0.007, card: 'a'};

		await drop(page, [], {...SPOT, card: 'a'}, {last: soft});
		await capturedAt(page, 1, 'the soft card added', 6000);
		await page.waitForTimeout(2500);
		assert.equal(await captures(page), 1, 'added once');
		await readAll(page, 1, errors);

		const [item] = await items(page);

		const {retry} = item.drop;

		// Taken at once when it reads sharp enough here, else after waiting
		// RETRY_MS for a sharper look that never comes, and then marked.
		assert.ok(!retry || retry.ms <= 2500, `added within RETRY_MS of its capture: ${JSON.stringify(retry)}`);
		assert.equal(item.blurred, Boolean(retry && retry.verdict === 'kept blurred'), `marked only when kept blurred: ${JSON.stringify(retry)}`);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('the card just taken is not added again when a blurred card is held over it and taken away', async () => {
		const {context, errors, page} = await open();
		const pile = [{...SPOT, card: 'c'}];

		await drop(page, [], pile[0]);
		await capturedAt(page, 1, 'card c taken');
		await readAll(page, 1, errors);
		await page.waitForTimeout(1000);

		// The next card in the hand, out of focus near the lens, held still
		// over most of the card on top for under a second, then taken away:
		// version 63 took it, blurred, and then the card beneath again.
		const held = {angle: -6, blur: 0.016, card: 'a', dx: 0.03, dy: 0.05, size: 1.02};

		await page.evaluate(async ({cards, hand}) => {
			window.scene = {background: 'box', cards, held: hand};
			await new Promise((resolve) => setTimeout(resolve, 900));
			window.scene = {background: 'box', cards};
		}, {cards: pile, hand: held});
		await page.waitForTimeout(3000);
		assert.equal(await captures(page), 1, `not added again: ${JSON.stringify(await skipped(page))}`);

		const list = await items(page);

		assert.equal(list.length, 1);
		assert.equal(list[0].copies, 1, 'no copy added');

		const log = await skipped(page);

		assert.ok(log.some((entry) => ['repeat', 'blurred, nothing left'].includes(entry.why) && entry.retry), `the blurred look is logged, and why it was not added: ${JSON.stringify(log)}`);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a blurred card held over the card on top for longer than RETRY_MS is added marked, and the card beneath is not added again', async () => {
		const {context, errors, page} = await open();
		const pile = [{...SPOT, card: 'c'}];
		const held = {angle: -6, blur: 0.016, card: 'a', dx: 0.03, dy: 0.05, size: 1.02};

		await drop(page, [], pile[0]);
		await capturedAt(page, 1, 'card c taken');
		await readAll(page, 1, errors);
		await page.waitForTimeout(1000);

		await page.evaluate(async ({cards, hand}) => {
			window.scene = {background: 'box', cards, held: hand};
			await new Promise((resolve) => setTimeout(resolve, 2600));
			window.scene = {background: 'box', cards};
		}, {cards: pile, hand: held});
		await page.waitForTimeout(3000);

		const list = await items(page);

		assert.equal(list.length, 2, `the blurred look added once, the card beneath not again: ${JSON.stringify(list.map((item) => [item.card, item.blurred, item.drop && item.drop.retry]))}`);
		assert.equal(list[0].blurred, false);
		assert.equal(list[1].blurred, true, 'the blurred look is marked to check');
		assert.ok((await skipped(page)).some((entry) => entry.why === 'repeat'), 'the card beneath, seen again, is logged as a repeat');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('two different cards dropped one straight after the other, the second on top of the first, are both added', async () => {
		const {context, errors, page} = await open();
		const first = {...SPOT, card: 'a'};
		const second = {angle: -2, card: 'c', dx: -0.02, dy: 0.05, size: 0.9};
		const third = {angle: 3, card: 'a', dx: 0.03, dy: 0.0, size: 0.86};

		await drop(page, [], first);
		await capturedAt(page, 1, 'the first added');
		await drop(page, [first], second);
		await capturedAt(page, 2, 'the second, on top of the first, added');
		await drop(page, [first, second], third);
		await capturedAt(page, 3, 'the third, on top of the second, added');
		await readAll(page, 3, errors);
		await page.waitForTimeout(1500);
		assert.deepEqual((await items(page)).map((item) => item.card), [CARDS.a, CARDS.c, CARDS.a]);
		assert.deepEqual(errors, []);
		await context.close();
	});
});
