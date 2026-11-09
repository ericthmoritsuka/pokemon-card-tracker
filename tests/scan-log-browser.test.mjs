// Continuous scanning and the scan log (Eric, 2026-10-09), in headless
// Chromium, against tests/scan-harness.mjs (Supabase is never reached;
// TCGdex answers are replayed from the harness cache), with the canvas
// camera of tests/scan-frames-browser.test.mjs and a second card.
//
// - No sheet opens by itself; a card held still is taken once, and a card
//   swapped straight for another is taken.
// - The same card again asks Add a copy or Mistake; A, B, A asks nothing.
// - The tile's x removes a card with Undo; the Copies stepper saves that
//   many; the scan log records each scan and its outcome, and Phone check
//   downloads and clears it.
// - The running count sits above the guide.
//
// getUserMedia is replaced by a portrait canvas stream, as in
// tests/scan-guide-browser.test.mjs, whose scene the test sets through
// window.scene: a table, a sheet of printed paper, or one of two TCGdex card
// scans at a share of the guide's height.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/scan-log-browser.test.mjs
//
// Made to hold on a busy machine (2026-11-09): every wait is for the state
// it checks, in the page where a round trip from here could miss it, and
// "nothing more happens" is counted in the scanner's own looks, not in
// wall-clock time. Each test has TEST_MS: a hang fails in minutes, not in
// the 8 hours an overnight run once stalled here.

import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {after, afterEach, before, describe, test} from 'node:test';

import {untilInPage} from './poll.mjs';
import {cardImage, countLooks, LOOK_MS, routeTcgdex, startScanHarness} from './scan-harness.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const CARD = 'me01-001';
const CARD_B = 'sv03.5-025';
const FRAME = {height: 3840, width: 2160};

// The most one test may take. The slowest takes about 75 s on a quiet
// machine and a few minutes on a busy one; past this it is stuck, not slow.
const TEST_MS = 10 * 60 * 1000;

let harness;
let browser;

// The contexts still open. A test that fails leaves its page scanning
// (frame loop, picture worker, OCR) until the file ends, which loaded the
// machine for every test after it: each is closed after its test, whatever
// happened.
const contexts = new Set();

before(async () => {
	harness = await startScanHarness();
	browser = await chromium.launch();
}, {timeout: TEST_MS});

afterEach(async () => {
	const left = [...contexts];

	contexts.clear();
	await Promise.all(left.map((context) => context.close().catch(() => {})));
}, {timeout: 60000});

after(async () => {
	await browser.close();
	await harness.close();
}, {timeout: 60000});

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

async function open({record = false, slowPhotos = 0, viewport = {height: 780, width: 384}} = {}) {
	const context = await browser.newContext({acceptDownloads: true, deviceScaleFactor: 2.8125, viewport});

	contexts.add(context);
	await context.grantPermissions(['camera'], {origin: harness.origin});
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await routeTcgdex(context);
	await context.route('**/__test-card.webp', async (route) => route.fulfill({contentType: 'image/webp', path: await cardImage(CARD)}));
	await context.route('**/__test-card-b.webp', async (route) => route.fulfill({contentType: 'image/webp', path: await cardImage(CARD_B)}));
	await context.addInitScript(portraitCamera, FRAME);
	await context.addInitScript(countLooks, LOOK_MS);

	if (record) {
		await context.addInitScript(() => localStorage.setItem('card-tracker:scan-log', 'on'));
	}

	// Every photo encoded slowly, as a phone encodes a 4K frame.
	if (slowPhotos) {
		await context.addInitScript((ms) => {
			const toBlob = HTMLCanvasElement.prototype.toBlob;

			HTMLCanvasElement.prototype.toBlob = function (callback, ...rest) {
				toBlob.call(this, (blob) => setTimeout(() => callback(blob), ms), ...rest);
			};
		}, slowPhotos);
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
// page loaded. Ten seconds was too few on a busy machine, where each look
// runs late; a card that is never taken still fails.
const capturesReach = (page, count, timeout = 60000) => untilInPage(page, `${count} captures`, async (want) => (await import('/pokemon-card-tracker/js/scan/view.js')).scanStats.captures >= want, {arg: count, timeout});

// Lets the scanner look at the camera `count` more times (LOOK_MS each
// when the machine keeps up), for checking that nothing more is taken: a
// fixed wait gave a busy machine fewer looks, and so fewer chances to get
// it wrong.
async function looksPass(page, count) {
	const from = await page.evaluate(() => window.looks);

	await page.waitForFunction((target) => window.looks >= target, from + count, {polling: 50, timeout: 120000});
}

// The scanner's looks in `ms` of a machine that keeps up.
const looksIn = (ms) => Math.ceil(ms / LOOK_MS);

const tiles = (page) => page.locator('#scan-tray .scan-tile').count();

const noteText = (page) => page.evaluate(() => document.getElementById('scan-note').textContent);

// Waits until no card in the tray is still being read or looked up.
async function settled(page, timeout = 90000) {
	await page.waitForFunction(() => ![...document.querySelectorAll('#scan-tray .scan-tile')].some((tile) => ['reading', 'matching'].includes(tile.dataset.status)), null, {polling: 200, timeout});
}

// ----------------------------------------------------------------- continuous scanning

const sessionItems = (page) => page.evaluate(async () => {
	const session = await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession();

	return session ? session.items.map((item) => ({card: item.card && item.card.id, copies: item.copies || 1, id: item.id, status: item.status})) : [];
});

// The tray as kept on the phone, once it has caught up with the screen.
async function trayIs(page, check, what, timeout = 60000) {
	const until = Date.now() + timeout;
	let items = await sessionItems(page);

	while (!check(items)) {
		assert.ok(Date.now() < until, `${what}: ${JSON.stringify(items)}`);
		await page.waitForTimeout(150);
		items = await sessionItems(page);
	}

	return items;
}

const logEntries = (page) => page.evaluate(async () => (await import('/pokemon-card-tracker/js/scan/log.js')).listEntries());

// The card leaves the guide until the scanner has seen it gone, then `card`
// is held in it. Auto capture takes the same card again only after a look
// that finds no card (steady.js createAutoCapture), and the frame loop
// marks each look on the guide (is-seen, on while a card is seen), so the
// mark is set here with the table and the card comes back once a look has
// cleared it. A fixed 700 ms let a busy machine miss the empty table, and
// the card held on was never taken again.
async function holdAgain(page, card) {
	await page.evaluate(() => {
		window.scene = {kind: 'table'};
		sessionStorage.setItem('test-scene', JSON.stringify(window.scene));
		document.getElementById('scan-guide').classList.add('is-seen');
	});
	await page.waitForFunction(() => !document.getElementById('scan-guide').classList.contains('is-seen'), null, {polling: 50, timeout: 60000});
	await setScene(page, {card, kind: 'card', size: 0.95});
}

const barOpen = (page) => page.locator('#scan-repeat-add').count();

// Waits in the page for the repeat bar and, with `tap` ('add' or 'no'),
// answers it the moment it opens, as a finger would: the bar closes as No
// by itself 8 s after it opens (view.js REPEAT_ASK_MS), and on a busy
// machine a round trip to see it and another to tap it took longer than
// that. The button tapped is the one on top at its middle. Answers what
// the bar showed, or null when it did not open within `timeout` ms.
const whenBarOpens = (page, {tap = null, timeout = 60000} = {}) => page.evaluate(async ({tap: which, timeout: ms}) => {
	const until = Date.now() + ms;

	while (!document.getElementById('scan-repeat-add')) {
		if (Date.now() > until) {
			return null;
		}

		await new Promise((resolve) => setTimeout(resolve, 20));
	}

	const box = (id) => document.querySelector(id).getBoundingClientRect();
	const button = which && document.getElementById(`scan-repeat-${which}`);
	const at = button ? button.getBoundingClientRect() : null;
	const tapped = at ? document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2) : null;
	const seen = {
		bar: box('#scan-repeat'),
		confirm: document.querySelectorAll('#scan-confirm').length,
		heights: {'#scan-repeat-add': box('#scan-repeat-add').height, '#scan-repeat-no': box('#scan-repeat-no').height},
		shutter: box('#scan-shutter'),
		tapped: Boolean(tapped && button.contains(tapped)),
		text: document.getElementById('scan-repeat-text').textContent,
	};

	if (seen.tapped) {
		tapped.click();
	}

	return seen;
}, {tap, timeout});

async function waitUntil(check, what, timeout = 30000) {
	const end = Date.now() + timeout;

	while (!(await check())) {
		assert.ok(Date.now() < end, what);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

describe('continuous scanning (Eric, 2026-10-09)', () => {
	test('a card held still is taken once, a card swapped straight for another is taken, and no sheet opens', {timeout: TEST_MS}, async () => {
		const {context, errors, page} = await open();

		await setScene(page, {card: 'a', kind: 'card', size: 0.95});
		await trayIs(page, (items) => items.length === 1 && items[0].card === CARD, 'card A taken');
		await settled(page);
		await looksPass(page, looksIn(2500));
		assert.equal(await captures(page), 1, 'card A held still: one capture');
		assert.equal(await page.locator('#scan-confirm').count(), 0, 'no sheet opened by itself');
		assert.equal(await page.locator('#scan-run-count').textContent(), 'Add · 1 card');
		assert.ok((await page.evaluate(() => window.buzzes)).includes(40), 'a sure card buzzes once, short');

		// B straight in A's place, with no empty frame between.
		await setScene(page, {card: 'b', kind: 'card', size: 0.95});
		await capturesReach(page, 2);
		await trayIs(page, (items) => items.length === 2 && items[1].card === CARD_B, 'card B taken');
		await settled(page);
		await looksPass(page, looksIn(2000));
		assert.equal(await captures(page), 2, 'card B held still: one capture');
		assert.equal(await page.locator('#scan-run-count').textContent(), 'Add · 2 cards');
		assert.equal(await page.locator('#scan-confirm').count(), 0);
		assert.equal(await barOpen(page), 0, 'a different card asks nothing');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('the same card again by auto capture asks Add a copy or Mistake; no answer is Mistake', {timeout: TEST_MS}, async () => {
		const {context, errors, page} = await open({record: true});

		await setScene(page, {card: 'a', kind: 'card', size: 0.95});
		await trayIs(page, (items) => items.length === 1 && items[0].status === 'ready', 'card A ready');

		// Mistake: nothing added. The bar is read and answered in one step in
		// the page (whenBarOpens): it closes as No by itself 8 s after it
		// opens (REPEAT_ASK_MS), and on a busy machine a round trip per check
		// plus a screenshot took longer than that, so Mistake was never
		// clicked.
		await holdAgain(page, 'a');

		const seen = await whenBarOpens(page, {tap: 'no'});

		assert.ok(seen, 'the bar opens');
		assert.equal(seen.text, 'Same card as the last one.');
		assert.equal(seen.confirm, 0, 'a bar, not a sheet');
		assert.ok(seen.bar.y + seen.bar.height <= seen.shutter.y, 'the bar is clear of the shutter');

		for (const [id, height] of Object.entries(seen.heights)) {
			assert.ok(height >= 44, `${id} is at least 44 px tall`);
		}

		assert.ok(seen.tapped, 'Mistake is on top where it is tapped');
		assert.equal(await barOpen(page), 0);
		await trayIs(page, (items) => items.length === 1 && items[0].copies === 1, 'Mistake adds nothing');

		// No answer: the same as Mistake, after about 8 s. The bar's picture
		// is taken here, where nothing has to be tapped before it closes.
		await holdAgain(page, 'a');
		assert.ok(await whenBarOpens(page), 'the bar opens again');
		await page.screenshot({path: '/tmp/scan-repeat-bar.png'});
		// Closed by its own timer in the page; the deadline here only has to
		// outlast a busy machine's late timers.
		await page.waitForSelector('#scan-repeat-add', {state: 'detached', timeout: 30000});
		await trayIs(page, (items) => items.length === 1 && items[0].copies === 1, 'no answer adds nothing');

		// Add a copy: the tile stands for two. Tapped in the page the moment
		// the bar opens, for the same reason as Mistake.
		const before = (await page.evaluate(() => window.buzzes)).length;

		await holdAgain(page, 'a');

		const added = await whenBarOpens(page, {tap: 'add'});

		assert.ok(added, 'the bar opens a third time');
		assert.ok(added.tapped, 'Add a copy is on top where it is tapped');
		await trayIs(page, (items) => items.length === 1 && items[0].copies === 2, 'Add a copy');
		assert.equal(await barOpen(page), 0);
		assert.ok((await page.evaluate(() => window.buzzes)).slice(before).includes(40), 'Add a copy buzzes');
		await page.waitForFunction(() => document.querySelector('#scan-tray .scan-tile-copies') && document.querySelector('#scan-tray .scan-tile-copies').textContent === '×2');
		assert.equal(await page.locator('#scan-tray .scan-qty').count(), 0, 'the quantity badge is for copies beyond this card\'s own');

		// The log is written behind the screen: wait until every scan after
		// the first has its outcome, then check them all.
		const outcomes = await untilInPage(page, 'an outcome for every scan after the first', async () => {
			const entries = await (await import('/pokemon-card-tracker/js/scan/log.js')).listEntries();
			const list = entries.map((entry) => entry.outcome && `${entry.outcome.kind}${entry.outcome.why ? ` ${entry.outcome.why}` : ''}`);

			return list.length >= 4 && list.slice(1).every(Boolean) ? list : null;
		}, {timeout: 30000});

		assert.deepEqual(outcomes, [null, 'dropped repeat', 'dropped repeat', 'added-copy']);
		assert.deepEqual(errors, []);
		await context.close();
	});

	// Eric's log (version 32): the same card taken by auto capture 2.6 s
	// after the first, both read as sure in 0.3 s, joined the tray as a second
	// tile instead of asking. The picture was kept on the card only after
	// its photos were saved, which on his phone (a 4K frame encoded as JPEG
	// beside it) took longer than that. Here every photo takes 8 s to encode.
	//
	// Whether the second capture came before the first photo was saved is
	// checked in the page the moment the scanner counts it, against the
	// saved photo itself: on a busy machine the test's own clock ran
	// seconds behind the scanner, and a 4 s window measured from it failed
	// on v47 and v48 alike.
	test('the same card again by auto capture 2.6 s later, while the first one\'s photo is still being saved, asks Add a copy or Mistake', {timeout: TEST_MS}, async () => {
		const {context, errors, page} = await open({record: true, slowPhotos: 8000});

		await setScene(page, {card: 'a', kind: 'card', size: 0.95});
		await capturesReach(page, 1);

		const [{id: firstId}] = await trayIs(page, (list) => list.length === 1, 'the first tile');

		// Read in a moment; its photo is still being encoded.
		await waitUntil(async () => (await page.evaluate(async () => (await import('/pokemon-card-tracker/js/scan/view.js')).scanStats.reads.length)) >= 1, 'the first read', 30000);
		await holdAgain(page, 'a');

		const firstSaved = await page.evaluate(async (id) => {
			const {scanStats} = await import('/pokemon-card-tracker/js/scan/view.js');
			const {loadPhoto} = await import('/pokemon-card-tracker/js/scan/draft.js');
			const until = Date.now() + 60000;

			while (scanStats.captures < 2) {
				if (Date.now() > until) {
					return null;
				}

				await new Promise((resolve) => setTimeout(resolve, 20));
			}

			return Boolean(await loadPhoto(id));
		}, firstId);

		assert.notEqual(firstSaved, null, '2 captures within 60000 ms');
		assert.equal(firstSaved, false, 'taken again before the first photo was saved');

		// Read and answered in one step, as in the test above: the bar closes
		// as No by itself 8 s after it opens.
		const seen = await whenBarOpens(page, {tap: 'no'});

		assert.ok(seen, 'the bar opens');
		assert.equal(seen.text, 'Same card as the last one.');
		assert.ok(seen.tapped, 'Mistake is on top where it is tapped');
		assert.equal(await barOpen(page), 0);

		const items = await trayIs(page, (list) => list.length === 1 && list[0].status === 'ready', 'one tile');

		assert.equal(items[0].card, CARD);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('A, B, A by auto capture gives three tiles and no bar; the shutter on A adds a fourth; the tile x removes one, and Undo brings it back', {timeout: TEST_MS}, async () => {
		const {context, errors, page} = await open({record: true});

		await setScene(page, {card: 'a', kind: 'card', size: 0.95});
		await trayIs(page, (items) => items.length === 1 && items[0].status === 'ready', 'A');
		await setScene(page, {card: 'b', kind: 'card', size: 0.95});
		await trayIs(page, (items) => items.length === 2 && items[1].status === 'ready', 'A, B');
		await setScene(page, {card: 'a', kind: 'card', size: 0.95});

		let items = await trayIs(page, (list) => list.length === 3 && list[2].status === 'ready', 'A, B, A');

		assert.deepEqual(items.map((item) => item.card), [CARD, CARD_B, CARD]);
		assert.equal(await barOpen(page), 0, 'no bar');

		await page.click('#scan-shutter');
		items = await trayIs(page, (list) => list.length === 4 && list[3].status === 'ready', 'the shutter on A');
		assert.equal(items[3].card, CARD);
		assert.equal(await barOpen(page), 0, 'the shutter asks nothing');
		await settled(page);

		// The newest tile's x: gone at once, no sheet, Undo below.
		const newest = items[3];
		const x = page.locator(`#scan-tray [data-remove="${newest.id}"]`);
		const box = await x.boundingBox();

		assert.ok(box.width >= 32 && box.height >= 32, 'a 32 px target');
		assert.equal(await x.getAttribute('aria-label'), 'Remove Bulbasaur');
		await page.screenshot({path: '/tmp/scan-tile-remove.png'});
		await x.click();
		await trayIs(page, (list) => list.length === 3, 'removed');
		assert.equal(await page.locator('#scan-confirm').count(), 0, 'the sheet does not open');
		assert.equal(await page.locator('#scan-removed-line').textContent(), 'Removed Bulbasaur.');

		const outcomeOf = async (id) => {
			const entry = (await logEntries(page)).find((one) => one.id === id);

			return entry.outcome;
		};

		assert.equal((await outcomeOf(newest.id)).kind, 'removed');

		await page.click('#scan-undo-remove');
		items = await trayIs(page, (list) => list.length === 4, 'back');
		assert.deepEqual(items[3], newest, 'back exactly as it was');
		assert.equal(await outcomeOf(newest.id), null, 'Undo clears the log outcome');
		assert.equal(await page.locator('#scan-run-count').textContent(), 'Add · 4 cards');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('the Copies stepper: 3 copies are kept through a reload, saved as 3, and Undo session takes all 3 back; the log records it', {timeout: TEST_MS}, async () => {
		const {context, errors, page} = await open({record: true});
		const liveCards = () => page.evaluate(async () => (await (await import('/pokemon-card-tracker/js/collection.js')).listCards()).length);

		await setScene(page, {card: 'a', kind: 'card', size: 0.95});

		const [item] = await trayIs(page, (items) => items.length === 1 && items[0].status === 'ready', 'card A ready');

		await settled(page);
		await page.click('#scan-tray .scan-tile');
		await page.waitForSelector('#scan-confirm #scan-copies');
		await page.click('#scan-copies-more');
		await page.click('#scan-copies-more');
		assert.equal(await page.inputValue('#scan-copies'), '3');
		await page.screenshot({path: '/tmp/scan-copies.png'});
		await page.click('#scan-sheet-close');
		await trayIs(page, (items) => items.length === 1 && items[0].copies === 3, 'three copies');

		await page.reload();
		await page.waitForSelector('#scan-shutter:not([disabled])', {timeout: 30000});
		await page.waitForFunction(() => document.querySelector('#scan-tray .scan-tile-copies') && document.querySelector('#scan-tray .scan-tile-copies').textContent === '×3');
		await settled(page);

		await page.click('#scan-done-open');
		await page.waitForSelector('#scan-done');
		assert.equal(await page.locator('#scan-save-session').textContent(), 'Save 3 cards');
		await page.click('#scan-save-session');
		await page.waitForSelector('#scan-undo-session');
		assert.equal(await page.locator('#scan-saved-line').textContent(), 'Saved 3 cards');
		assert.equal(await liveCards(), 3);

		// The log is written behind the screen. Five seconds of polling, with
		// nothing said when they ran out, was too few on a busy machine.
		const entryOf = (what, done) => untilInPage(page, what, async ({id, done: check}) => {
			const found = (await (await import('/pokemon-card-tracker/js/scan/log.js')).listEntries()).find((one) => one.id === id);

			return found && found.outcome && (check !== 'undone' || found.outcome.undone) ? found : null;
		}, {arg: {done, id: item.id}, timeout: 30000});
		let entry = await entryOf('the scan\'s logged outcome', 'outcome');

		assert.equal(entry.source, 'camera');
		assert.equal(entry.how, 'auto');
		assert.equal(entry.first.card.id, CARD);
		assert.equal(entry.outcome.kind, 'saved');
		assert.equal(entry.outcome.card, CARD);
		assert.equal(entry.outcome.copies, 3);
		assert.equal(entry.outcome.changed, false, 'saved as the scanner first answered');
		assert.ok(entry.report && entry.report.picture && entry.report.picture.groups.length, 'the report with the picture match');

		await page.click('#scan-undo-session');
		await untilInPage(page, 'Undo to leave no cards in the collection', async () => (await (await import('/pokemon-card-tracker/js/collection.js')).listCards()).length === 0, {timeout: 30000});

		entry = await entryOf('the logged outcome marked undone', 'undone');
		assert.equal(entry.outcome.undone, true);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('Phone check: the log switches, its size, one file to download, and Clear log with a confirmation', {timeout: TEST_MS}, async () => {
		const {context, errors, page} = await open({record: true});

		await setScene(page, {card: 'a', kind: 'card', size: 0.95});
		await trayIs(page, (items) => items.length === 1 && items[0].status === 'ready', 'card A ready');
		await untilInPage(page, 'the scan log\'s first entry to be ready', async () => {
			const [entry] = await (await import('/pokemon-card-tracker/js/scan/log.js')).listEntries();

			return Boolean(entry && entry.first && entry.first.status === 'ready');
		}, {interval: 200, timeout: 30000});

		// A share sheet that takes files, as Chrome on Android has.
		await page.addInitScript(() => {
			window.shared = [];
			navigator.canShare = () => true;
			navigator.share = async ({files}) => {
				window.shared.push({name: files[0].name, text: await files[0].text(), type: files[0].type});
			};
		});
		await page.goto(`${harness.origin}${BASE}check`);
		await page.waitForSelector('#scan-log-record');
		assert.equal(await page.isChecked('#scan-log-record'), true);
		assert.equal(await page.isChecked('#scan-log-pictures'), true, 'pictures on by default');
		await page.waitForFunction(() => /^1 scan recorded · \d+\.\d MB$/.test(document.getElementById('scan-log-size').textContent));
		await page.screenshot({fullPage: true, path: '/tmp/scan-log-phone-check.png'});

		const download = page.waitForEvent('download');

		await page.click('#scan-log-download');

		const file = await download;

		assert.match(file.suggestedFilename(), /^scan-log-\d{8}-\d{6}\.json$/);

		const data = JSON.parse(await readFile(await file.path(), 'utf8'));

		assert.deepEqual(Object.keys(data).sort(), ['app', 'entries', 'exported']);
		assert.equal(data.entries.length, 1);
		assert.match(data.entries[0].picture, /^data:image\/jpeg;base64,/);
		assert.equal(data.entries[0].first.card.id, CARD);
		assert.ok(data.entries[0].phone && data.entries[0].phone.userAgent, 'the phone');
		assert.ok(data.entries[0].report.geometry, 'the geometry');
		assert.equal('firstLocked' in data.entries[0], false);
		await writeFile('/tmp/scan-log-sample.json', JSON.stringify({...data, entries: data.entries.map((entry) => ({...entry, picture: `${entry.picture.slice(0, 40)}...`}))}, null, 1));
		assert.match(await page.locator('#scan-log-status').textContent(), /Send that file to Eric/);

		// Share hands over a file made ahead, so the sheet opens within the
		// tap's few seconds, as plain text with the same JSON inside.
		await page.waitForSelector('#scan-log-share:not([hidden])');
		//
		// A tap answers in the status line once it is done: Shared., or, when
		// the file was not made yet, Ready. Tap Share again. The line was read
		// right after the tap, while the share was still under way and the
		// line still held the download's message, and the test then tapped
		// again: two shares, and a wait for exactly one that never ended.
		const statusAfter = async (...before) => {
			await page.waitForFunction((was) => !was.includes(document.getElementById('scan-log-status').textContent), before, {polling: 50, timeout: 60000});

			return page.locator('#scan-log-status').textContent();
		};
		const savedSaid = await page.locator('#scan-log-status').textContent();

		await page.click('#scan-log-share');

		if (await statusAfter(savedSaid, 'Getting the file ready...') === 'Ready. Tap Share again.') {
			await page.click('#scan-log-share');
			await statusAfter('Ready. Tap Share again.');
		}

		assert.equal(await page.evaluate(() => window.shared.length), 1, 'shared once');

		const shared = await page.evaluate(() => window.shared[0]);

		assert.match(shared.name, /^scan-log-\d{8}-\d{6}\.txt$/);
		assert.equal(shared.type, 'text/plain');
		assert.equal(JSON.parse(shared.text).entries.length, 1);
		assert.equal(await page.locator('#scan-log-status').textContent(), 'Shared.');

		// Clear log asks on the page first; Keep them keeps them.
		await page.click('#scan-log-clear');
		assert.equal(await page.locator('#scan-log-confirm-text').textContent(), 'Delete all 1 recorded scan from this phone?');
		await page.click('#scan-log-clear-no');
		assert.ok(await page.locator('#scan-log-confirm').isHidden());
		await page.click('#scan-log-clear');
		await page.click('#scan-log-clear-yes');
		await page.waitForFunction(() => document.getElementById('scan-log-size').textContent === 'No scans recorded yet.');

		// Off: nothing more is recorded.
		await page.uncheck('#scan-log-record');
		assert.equal(await page.evaluate(() => localStorage.getItem('card-tracker:scan-log')), 'off');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('the running count sits over the camera, above the guide and clear of the shutter, at 360 and 384 px wide', {timeout: TEST_MS}, async () => {
		for (const width of [360, 384]) {
			const {context, errors, page} = await open({viewport: {height: 780, width}});

			await setScene(page, {card: 'a', kind: 'card', size: 0.95});
			await trayIs(page, (items) => items.length === 1 && items[0].status === 'ready', 'card A ready');
			// Measured at rest: the count shown, and the capture flash, which
			// scales the guide, over. A fixed 300 ms was not always enough.
			await page.waitForFunction(() => {
				const guide = document.getElementById('scan-guide');

				return !document.getElementById('scan-run-count').hidden && !guide.getAnimations().some((animation) => animation instanceof CSSAnimation);
			}, null, {polling: 50, timeout: 30000});

			const count = await page.locator('#scan-run-count').boundingBox();
			const guide = await page.locator('#scan-guide').boundingBox();
			const stage = await page.locator('#scan-stage').boundingBox();

			await page.screenshot({path: `/tmp/scan-run-count-${width}.png`});
			assert.equal(await page.locator('#scan-run-count').getAttribute('aria-live'), 'polite');
			assert.ok(count.y >= stage.y && count.y + count.height <= stage.y + stage.height, `${width}: over the camera`);
			assert.ok(count.y + count.height <= guide.y + 2, `${width}: above the guide (count ends at ${count.y + count.height}, the guide starts at ${guide.y})`);
			assert.deepEqual(errors, []);
			await context.close();
		}
	});
});
