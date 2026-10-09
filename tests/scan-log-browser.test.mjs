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

import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
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

async function open({record = false, slowPhotos = 0, viewport = {height: 780, width: 384}} = {}) {
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

// The card leaves the guide for a moment, then `card` is held in it.
async function holdAgain(page, card) {
	await setScene(page, {kind: 'table'});
	await page.waitForTimeout(700);
	await setScene(page, {card, kind: 'card', size: 0.95});
}

const barOpen = (page) => page.locator('#scan-repeat-add').count();

async function waitUntil(check, what, timeout = 30000) {
	const end = Date.now() + timeout;

	while (!(await check())) {
		assert.ok(Date.now() < end, what);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

describe('continuous scanning (Eric, 2026-10-09)', () => {
	test('a card held still is taken once, a card swapped straight for another is taken, and no sheet opens', async () => {
		const {context, errors, page} = await open();

		await setScene(page, {card: 'a', kind: 'card', size: 0.95});
		await trayIs(page, (items) => items.length === 1 && items[0].card === CARD, 'card A taken');
		await settled(page);
		await page.waitForTimeout(2500);
		assert.equal(await captures(page), 1, 'card A held still: one capture');
		assert.equal(await page.locator('#scan-confirm').count(), 0, 'no sheet opened by itself');
		assert.equal(await page.locator('#scan-run-count').textContent(), '1 card');
		assert.ok((await page.evaluate(() => window.buzzes)).includes(40), 'a sure card buzzes once, short');

		// B straight in A's place, with no empty frame between.
		await setScene(page, {card: 'b', kind: 'card', size: 0.95});
		await capturesReach(page, 2);
		await trayIs(page, (items) => items.length === 2 && items[1].card === CARD_B, 'card B taken');
		await settled(page);
		await page.waitForTimeout(2000);
		assert.equal(await captures(page), 2, 'card B held still: one capture');
		assert.equal(await page.locator('#scan-run-count').textContent(), '2 cards');
		assert.equal(await page.locator('#scan-confirm').count(), 0);
		assert.equal(await barOpen(page), 0, 'a different card asks nothing');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('the same card again by auto capture asks Add a copy or Mistake; no answer is Mistake', async () => {
		const {context, errors, page} = await open({record: true});

		await setScene(page, {card: 'a', kind: 'card', size: 0.95});
		await trayIs(page, (items) => items.length === 1 && items[0].status === 'ready', 'card A ready');

		// Mistake: nothing added.
		await holdAgain(page, 'a');
		await page.waitForSelector('#scan-repeat-add', {timeout: 30000});
		assert.equal(await page.locator('#scan-repeat-text').textContent(), 'Same card as the last one.');
		assert.equal(await page.locator('#scan-confirm').count(), 0, 'a bar, not a sheet');

		const shutter = await page.locator('#scan-shutter').boundingBox();
		const bar = await page.locator('#scan-repeat').boundingBox();

		assert.ok(bar.y + bar.height <= shutter.y, 'the bar is clear of the shutter');

		for (const id of ['#scan-repeat-add', '#scan-repeat-no']) {
			assert.ok((await page.locator(id).boundingBox()).height >= 44, `${id} is at least 44 px tall`);
		}

		await page.screenshot({path: '/tmp/scan-repeat-bar.png'});
		await page.click('#scan-repeat-no');
		assert.equal(await barOpen(page), 0);
		await trayIs(page, (items) => items.length === 1 && items[0].copies === 1, 'Mistake adds nothing');

		// No answer: the same as Mistake, after about 8 s.
		await holdAgain(page, 'a');
		await page.waitForSelector('#scan-repeat-add', {timeout: 30000});
		await page.waitForSelector('#scan-repeat-add', {state: 'detached', timeout: 12000});
		await trayIs(page, (items) => items.length === 1 && items[0].copies === 1, 'no answer adds nothing');

		// Add a copy: the tile stands for two.
		const before = (await page.evaluate(() => window.buzzes)).length;

		await holdAgain(page, 'a');
		await page.waitForSelector('#scan-repeat-add', {timeout: 30000});
		await page.click('#scan-repeat-add');
		await trayIs(page, (items) => items.length === 1 && items[0].copies === 2, 'Add a copy');
		assert.equal(await barOpen(page), 0);
		assert.ok((await page.evaluate(() => window.buzzes)).slice(before).includes(40), 'Add a copy buzzes');
		await page.waitForFunction(() => document.querySelector('#scan-tray .scan-tile-copies') && document.querySelector('#scan-tray .scan-tile-copies').textContent === '×2');
		assert.equal(await page.locator('#scan-tray .scan-qty').count(), 0, 'the quantity badge is for copies beyond this card\'s own');

		let outcomes = [];

		for (let i = 0; i < 50; i++) {
			outcomes = (await logEntries(page)).map((entry) => entry.outcome && `${entry.outcome.kind}${entry.outcome.why ? ` ${entry.outcome.why}` : ''}`);

			if (outcomes.length === 4 && outcomes[3]) {
				break;
			}

			await page.waitForTimeout(100);
		}

		assert.deepEqual(outcomes, [null, 'dropped repeat', 'dropped repeat', 'added-copy']);
		assert.deepEqual(errors, []);
		await context.close();
	});

	// Eric's log (version 32): the same card taken by auto capture 2.6 s
	// after the first, both read as sure in 0.3 s, joined the tray as a second
	// tile instead of asking. The picture was kept on the card only after
	// its photos were saved, which on his phone (a 4K frame encoded as JPEG
	// beside it) took longer than that. Here every photo takes 4 s to encode.
	test('the same card again by auto capture 2.6 s later, while the first one\'s photo is still being saved, asks Add a copy or Mistake', async () => {
		const {context, errors, page} = await open({record: true, slowPhotos: 4000});

		await setScene(page, {card: 'a', kind: 'card', size: 0.95});
		await capturesReach(page, 1);

		const first = Date.now();

		// Read in a moment; its photo is still being encoded.
		await waitUntil(async () => (await page.evaluate(async () => (await import('/pokemon-card-tracker/js/scan/view.js')).scanStats.reads.length)) >= 1, 'the first read', 30000);
		await holdAgain(page, 'a');
		await capturesReach(page, 2, 15000);
		assert.ok(Date.now() - first < 4000, 'taken again before the first photo was saved');
		await page.waitForSelector('#scan-repeat-add', {timeout: 30000});
		assert.equal(await page.locator('#scan-repeat-text').textContent(), 'Same card as the last one.');
		await page.click('#scan-repeat-no');

		const items = await trayIs(page, (list) => list.length === 1 && list[0].status === 'ready', 'one tile');

		assert.equal(items[0].card, CARD);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('A, B, A by auto capture gives three tiles and no bar; the shutter on A adds a fourth; the tile x removes one, and Undo brings it back', async () => {
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
		assert.equal(await page.locator('#scan-run-count').textContent(), '4 cards');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('the Copies stepper: 3 copies are kept through a reload, saved as 3, and Undo session takes all 3 back; the log records it', async () => {
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

		let entry = null;

		for (let i = 0; i < 50 && !(entry && entry.outcome); i++) {
			entry = (await logEntries(page)).find((one) => one.id === item.id);
			await page.waitForTimeout(100);
		}

		assert.equal(entry.source, 'camera');
		assert.equal(entry.how, 'auto');
		assert.equal(entry.first.card.id, CARD);
		assert.equal(entry.outcome.kind, 'saved');
		assert.equal(entry.outcome.card, CARD);
		assert.equal(entry.outcome.copies, 3);
		assert.equal(entry.outcome.changed, false, 'saved as the scanner first answered');
		assert.ok(entry.report && entry.report.picture && entry.report.picture.groups.length, 'the report with the picture match');

		await page.click('#scan-undo-session');
		await page.waitForFunction(async () => (await (await import('/pokemon-card-tracker/js/collection.js')).listCards()).length === 0);

		for (let i = 0; i < 50 && !entry.outcome.undone; i++) {
			entry = (await logEntries(page)).find((one) => one.id === item.id);
			await page.waitForTimeout(100);
		}

		assert.equal(entry.outcome.undone, true);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('Phone check: the log switches, its size, one file to download, and Clear log with a confirmation', async () => {
		const {context, errors, page} = await open({record: true});

		await setScene(page, {card: 'a', kind: 'card', size: 0.95});
		await trayIs(page, (items) => items.length === 1 && items[0].status === 'ready', 'card A ready');
		await page.waitForFunction(async () => {
			const [entry] = await (await import('/pokemon-card-tracker/js/scan/log.js')).listEntries();

			return Boolean(entry && entry.first && entry.first.status === 'ready');
		}, null, {polling: 200, timeout: 30000});

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
		await page.click('#scan-log-share');

		if ((await page.locator('#scan-log-status').textContent()) !== 'Shared.') {
			await page.waitForFunction(() => /Tap Share again|Shared\./.test(document.getElementById('scan-log-status').textContent));
			await page.click('#scan-log-share');
		}

		await page.waitForFunction(() => window.shared.length === 1);

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

	test('the running count sits over the camera, above the guide and clear of the shutter, at 360 and 384 px wide', async () => {
		for (const width of [360, 384]) {
			const {context, errors, page} = await open({viewport: {height: 780, width}});

			await setScene(page, {card: 'a', kind: 'card', size: 0.95});
			await trayIs(page, (items) => items.length === 1 && items[0].status === 'ready', 'card A ready');
			await page.waitForTimeout(300);

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
