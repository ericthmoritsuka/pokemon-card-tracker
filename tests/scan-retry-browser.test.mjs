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
//   passes, marked to check when its match is not sure;
// - a card whose own print reads soft, as a basic Energy's does, is added,
//   not held back, and not marked when its match is sure;
// - a card dropped on a blurred one waiting is its own card, and the
//   waiting one is added first, marked to check;
// - a card landing under a hand held over it, the hand leaving without
//   dropping, is one card, for a moment or past RETRY_MS;
// - the hand holding the next card over the card on top, then dropping it
//   there: each card once;
// - Log it while a capture waits: it waits, and the card joins the tray;
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
// the first frame (tests/scan-holder-browser.test.mjs open says why). trade:
// Scan opens in Trade or sale, with `drafts` (trays) written first.
async function open({drafts = null, trade = false} = {}) {
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
	await context.addInitScript((mode) => {
		localStorage.setItem('card-tracker:scan-holder', 'on');
		localStorage.setItem('card-tracker:scan-log', 'on');
		localStorage.setItem('card-tracker:scan-mode', mode);
	}, trade ? 'trade' : 'add');

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(String(err)));

	if (drafts) {
		await page.goto(`${harness.origin}${BASE}cards`);
		await page.evaluate(async (trays) => {
			const draft = await import('/pokemon-card-tracker/js/scan/draft.js');

			for (const tray of trays) {
				await draft.saveSession(tray);
			}
		}, drafts);
	}

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

// The tray as kept in the draft: each card's match, whether the match is
// sure, whether it was added blurred and needs a look (marked to check),
// its status, and its drop's numbers.
const items = (page) => page.evaluate(async () => {
	const session = await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession();
	const S = await import('/pokemon-card-tracker/js/scan/session.js');

	return session ? session.items.map((item) => ({blurred: Boolean(item.blurred), card: item.card && item.card.id, copies: item.copies || 1, drop: item.report && item.report.geometry && item.report.geometry.drop, id: item.id, look: S.needsLook(item), status: item.status, sure: Boolean(item.sure)})) : [];
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

// Until no card in the tray is still being read.
const settled = (page) => untilInPage(page, 'every card read', async () => {
	const session = await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession();

	return Boolean(session) && session.items.every((item) => item.status !== 'reading' && item.status !== 'matching');
}, {timeout: 60000});

// Holds the next card in the hand, out of focus, over `pile` for `ms` (timed
// in the page), then takes the hand away; with `next`, drops that card
// instead as the hand goes, as drop does.
function hover(page, pile, hand, ms, next = null) {
	return page.evaluate(async ({cards, held, wait, then}) => {
		window.scene = {background: 'box', cards, held};
		await new Promise((resolve) => setTimeout(resolve, wait));

		if (then) {
			for (let step = 6; step >= 0; step--) {
				window.scene = {background: 'box', cards: [...cards, step ? {...then, angle: (then.angle || 0) + step * 4, dy: (then.dy || 0) - step * 0.16} : then]};
				await new Promise((resolve) => setTimeout(resolve, 60));
			}

			return;
		}

		window.scene = {background: 'box', cards};
	}, {cards: pile, held: hand, then: next, wait: ms});
}

// Drops `card` onto the pile from above the frame, as
// tests/scan-holder-browser.test.mjs does; `last` is drawn for its last step
// (a card landing blurred), and `held` over everything throughout; steps:
// how many looks it falls for (a quick drop falls for fewer).
function drop(page, pile, card, {held = null, last = card, steps = 6} = {}) {
	return page.evaluate(async ({below, falling, hand, landed, from}) => {
		for (let step = from; step >= 0; step--) {
			const now = step ? {...falling, angle: (falling.angle || 0) + step * 4, dy: (falling.dy || 0) - step * 0.16} : landed;

			window.scene = {background: 'box', cards: [...below, now], held: hand};
			await new Promise((resolve) => setTimeout(resolve, 60));
		}
	}, {below: pile, falling: card, from: steps, hand: held, landed: last});
}

const SPOT = {angle: 1, dx: 0.01, dy: 0.02, size: 0.88};
// The next card in the hand, out of focus near the lens, over most of the
// card on top.
const HELD = {angle: -6, blur: 0.016, card: 'a', dx: 0.03, dy: 0.05, size: 1.02};
// The same, over the lower part of the card only: its top stays in view.
const HELD_LOW = {angle: -6, blur: 0.016, card: 'a', dx: 0.04, dy: 0.34, size: 0.8};

// Makes the blurred cards a test draws before it draws them: making one
// holds the page for up to a second (tests/scan-scene.mjs warmBlur), which
// would stretch a hand held for a moment past its time.
async function warm(page, ...placed) {
	for (const card of placed) {
		await untilInPage(page, `the blurred card ${JSON.stringify(card)} made`, (one) => window.warmBlur(one), {arg: card});
	}

	// The detector's base again after the page was held.
	await page.waitForTimeout(1500);
}

describe('holder mode retries a blurred capture, and never adds a repeat (version 64)', () => {
	test('a card that lands blurred and then lies sharp is added once, from its sharp look', async () => {
		const {context, errors, page} = await open();

		await warm(page, {...SPOT, blur: 0.012, card: 'c'});

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

	test('a card that stays blurred is added all the same once RETRY_MS passes, marked to check when its match is not sure', async () => {
		const {context, errors, page} = await open();

		await warm(page, {...SPOT, blur: 0.02, card: 'c'});
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

		assert.equal(item.blurred, true, 'its picture was blurred');
		assert.equal(item.sure, false, `this blurred its match is not sure: ${JSON.stringify(item)}`);
		assert.equal(item.look, true, 'marked to check');
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

	test('a card whose own print reads soft, as a basic Energy\'s does, is added, not held back, and not marked when its match is sure', async () => {
		const {context, errors, page} = await open();
		// A print a little soft of its own, lying dead still: no sharper look
		// ever comes.
		const soft = {...SPOT, blur: 0.001, card: 'a'};

		await warm(page, soft);
		await drop(page, [], {...SPOT, card: 'a'}, {last: soft});
		await capturedAt(page, 1, 'the soft card added', 6000);
		await page.waitForTimeout(2500);
		assert.equal(await captures(page), 1, 'added once');
		await readAll(page, 1, errors);

		const [item] = await items(page);

		const {focus, retry} = item.drop;

		// It reads soft, waits RETRY_MS for a sharper look that never comes,
		// and is added as it is; its match is sure, so it is not marked
		// (Eric, 2026-11-06: what the scanner is sure of is never marked).
		assert.ok(retry && retry.verdict === 'kept blurred' && retry.ms <= 2500, `waited for a sharper look, then added: ${JSON.stringify(retry)}`);
		assert.ok(focus && focus.why, `its focus is logged: ${JSON.stringify(focus)}`);
		assert.equal(item.card, CARDS.a);
		assert.equal(item.sure, true, `its match is sure: ${JSON.stringify(item)}`);
		assert.equal(item.look, false, 'not marked to check');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('the card just taken is not added again when a blurred card is held over it and taken away', async () => {
		const {context, errors, page} = await open();
		const pile = [{...SPOT, card: 'c'}];
		const held = HELD;

		await warm(page, held);
		await drop(page, [], pile[0]);
		await capturedAt(page, 1, 'card c taken');
		await readAll(page, 1, errors);
		await page.waitForTimeout(1000);

		// The next card in the hand, out of focus near the lens, held still
		// over most of the card on top for under a second, then taken away:
		// version 63 took it, blurred, and then the card beneath again. Now
		// and then the test camera's picture of the hand is judged the card
		// beneath (its content check reads the same card, and nothing is
		// taken, as before): the hand comes again, up to three times, until
		// its look is taken blurred.
		const retried = async () => (await skipped(page)).some((entry) => ['repeat', 'blurred, nothing left'].includes(entry.why) && entry.retry);

		for (let attempt = 0; attempt < 3 && !await retried(); attempt++) {
			await page.evaluate(async ({cards, hand}) => {
				window.scene = {background: 'box', cards, held: hand};
				await new Promise((resolve) => setTimeout(resolve, 900));
				window.scene = {background: 'box', cards};
			}, {cards: pile, hand: held});
			await page.waitForTimeout(3000);
			assert.equal(await captures(page), 1, `not added again: ${JSON.stringify(await skipped(page))}`);
		}

		const list = await items(page);

		assert.equal(list.length, 1);
		assert.equal(list[0].copies, 1, 'no copy added');
		assert.ok(await retried(), `the blurred look is logged, and why it was not added: ${JSON.stringify(await skipped(page))}`);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a blurred card held over the card on top for longer than RETRY_MS is added as it is, and the card beneath is not added again', async () => {
		const {context, errors, page} = await open();
		const pile = [{...SPOT, card: 'c'}];
		const held = HELD;

		await warm(page, held);
		await drop(page, [], pile[0]);
		await capturedAt(page, 1, 'card c taken');
		await readAll(page, 1, errors);
		await page.waitForTimeout(1000);

		// Held still past RETRY_MS, then taken away; again, up to three
		// times, while the camera's picture of the hand is judged the card
		// beneath (see the test before). The card beneath is never added
		// again (version 63 added it again, and the hand's look unmarked).
		let list = [];

		for (let attempt = 0; attempt < 3 && !list.some((item) => item.blurred); attempt++) {
			await page.evaluate(async ({cards, hand}) => {
				window.scene = {background: 'box', cards, held: hand};
				await new Promise((resolve) => setTimeout(resolve, 2600));
				window.scene = {background: 'box', cards};
			}, {cards: pile, hand: held});
			await page.waitForTimeout(3000);
			list = await items(page);
			assert.equal(list.filter((item) => !item.blurred).length, 1, `the card beneath not added again: ${JSON.stringify(list.map((item) => [item.card, item.blurred, item.drop && item.drop.retry]))}`);
		}

		assert.equal(list.length, 2, `the blurred look added once, the card beneath not again: ${JSON.stringify(list.map((item) => [item.card, item.blurred, item.drop && item.drop.retry]))}`);
		assert.equal(list[0].blurred, false);
		assert.equal(list[1].blurred, true, 'the blurred look is marked to check');
		assert.equal(list[1].drop.retry.reason, 'time');
		assert.ok((await skipped(page)).some((entry) => entry.why === 'repeat'), 'the card beneath, seen again, is logged as a repeat');
		assert.deepEqual(errors, []);
		await context.close();
	});

	// Never lose a card (Eric, 2026-11-06): a card dropped on a blurred one
	// waiting for a sharper look is its own card, and the waiting one is
	// added first (version 64 as first built took the new card's sharp look
	// for the waiting card's, and the waiting card was lost).
	test('a card that lands blurred, then another dropped on top of it within a second: both added, the first first', async () => {
		const {context, errors, page} = await open();
		const blurred = {...SPOT, blur: 0.02, card: 'c'};
		const second = {angle: -2, card: 'a', dx: 0.02, dy: 0.03, size: 0.88};

		await warm(page, blurred);
		await drop(page, [], {...SPOT, card: 'c'}, {last: blurred});

		// The first waits for a sharper look (scanStats.retries); the second
		// falls on it at once, well within RETRY_MS of the first's capture.
		await untilInPage(page, 'the first waiting for a sharper look', async () => (await import('/pokemon-card-tracker/js/scan/view.js')).scanStats.retries >= 1, {interval: 30, timeout: 5000});
		assert.equal(await captures(page), 0, 'the first waits for a sharper look');
		await drop(page, [blurred], second, {steps: 3});
		await capturedAt(page, 2, 'both cards added', 8000);
		await readAll(page, 2, errors);
		await page.waitForTimeout(1500);
		assert.equal(await captures(page), 2, 'each once');

		const list = await items(page);

		assert.equal(list[0].blurred, true, `the waiting card first, as it was taken: ${JSON.stringify(list.map((item) => [item.card, item.blurred, item.drop && item.drop.retry]))}`);
		// Added because the second landed on it (marked, however sure), or,
		// when the test camera's picture lags past RETRY_MS, because its
		// wait ran out first; either way before the second, never replaced.
		assert.ok(['next card', 'time'].includes(list[0].drop.retry.reason), JSON.stringify(list[0].drop.retry));

		if (list[0].drop.retry.reason === 'next card') {
			assert.equal(list[0].look, true, 'the waiting card is marked to check: never added silently');
		}

		assert.equal(list[1].card, CARDS.a, 'then the card dropped on it');
		assert.deepEqual(errors, []);
		await context.close();
	});

	// Review of 2026-11-06: the hand bringing the next card hovered over the
	// card that just landed before its first still look; when it left, the
	// card's sharp look read as another card dropped on it, and the card was
	// added twice.
	for (const [name, ms] of [['for a moment', 900], ['for longer than RETRY_MS', 2600]]) {
		test(`a card that lands under a hand held over it ${name}, the hand leaving without dropping: one card`, async () => {
			const {context, errors, page} = await open();
			const first = {...SPOT, card: 'c'};

			await warm(page, HELD_LOW);
			await drop(page, [], first, {held: HELD_LOW});
			await hover(page, [first], HELD_LOW, ms);
			await page.waitForTimeout(3500);
			await settled(page);

			const list = await items(page);

			assert.deepEqual(list.map((item) => item.card), [CARDS.c], `one card: ${JSON.stringify(list.map((item) => [item.card, item.blurred, item.look, item.drop && item.drop.retry]))}`);
			assert.equal(list[0].blurred, false, 'from its sharp look');
			assert.deepEqual(errors, []);
			await context.close();
		});
	}

	test('the hand holds the next card over the card on top for a moment, then drops it there: each card once', async () => {
		const {context, errors, page} = await open();
		const first = {...SPOT, card: 'c'};
		const next = {angle: -2, card: 'a', dx: 0.02, dy: 0.03, size: 0.88};

		await warm(page, HELD_LOW);
		await drop(page, [], first);
		await capturedAt(page, 1, 'card c taken');
		await readAll(page, 1, errors);
		await page.waitForTimeout(1000);
		await hover(page, [first], HELD_LOW, 900, next);
		await page.waitForTimeout(3500);
		await settled(page);

		const list = await items(page);

		assert.deepEqual(list.map((item) => item.card), [CARDS.c, CARDS.a], `c once, a once: ${JSON.stringify(list.map((item) => [item.card, item.blurred, item.look, item.drop && item.drop.retry]))}`);
		assert.deepEqual(errors, []);
		await context.close();
	});

	// Review of 2026-11-06: Log it while the last capture waited for its
	// sharper look built the form without it, and the save then deleted it
	// from the trade tray with its side.
	test('Log it while a capture waits for a sharper look: it waits, and the card joins the trade tray', async () => {
		const at = '2026-11-06T10:00:00.000Z';
		const card = {catalog: 'international', id: CARDS.a, image: null, lang: 'en', localId: '1', name: 'Card in', official: '99', setId: 'me01', setName: 'Test'};
		const tray = {created_at: at, id: 'trade-1', items: [{candidates: [], captured_at: at, card, condition: null, confirmed: true, finishBy: 'plain', id: 't1', language: 'en', languageBy: 'hand', names: [], read: null, side: 'in', status: 'ready', sure: true, timings: {}, variantId: null, variants: [], why: null}], lastSave: null, mode: 'trade', sheetShown: false, side: 'in', updated_at: at};
		const {context, errors, page} = await open({drafts: [tray], trade: true});
		const blurred = {...SPOT, blur: 0.02, card: 'c'};

		await warm(page, blurred);
		await drop(page, [], {...SPOT, card: 'c'}, {last: blurred});
		await page.waitForTimeout(700);
		assert.equal(await captures(page), 0, 'the capture waits for a sharper look');
		await page.click('#scan-done-open');
		assert.match(await page.textContent('#scan-note'), /A card is still being taken\./);
		assert.equal(new URL(page.url()).pathname, `${BASE}scan`, 'the form does not open yet');
		await untilInPage(page, 'the card in the trade tray', async () => {
			const session = await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession('trade');

			return Boolean(session) && session.items.length === 2;
		}, {timeout: 10000});
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
