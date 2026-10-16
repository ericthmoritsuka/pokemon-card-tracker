// The read's safety nets (Eric's v38 phone log, 2026-10-15), in headless
// Chromium, against tests/scan-harness.mjs (Supabase is never reached;
// TCGdex answers are replayed from the harness cache), with the canvas
// camera of tests/scan-scene.mjs:
//
// - a picture worker that stops answering is let go after its time limit
//   (js/scan/identify.js WORKER_LIMITS), and the pictures it held are
//   matched on the main thread, so no card hangs at "Reading"; the scan
//   report says where each picture ran and why;
// - label checks behind the tray (identify.js readLanguageLabel) wait for
//   the cards being read, and their OCR calls never take a worker a card's
//   read is waiting for (js/scan/ocr.js createSlots).
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/scan-safety-browser.test.mjs

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

// A picture worker that loads (it answers the warm-up) and then never
// answers a picture: the worker the page cannot tell is dead.
const SILENT_WORKER = `self.addEventListener('message', ({data}) => {
	if (data && data.warm) {
		self.postMessage({ok: true, warm: true});
	}
});`;

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

async function open({silentWorker = false} = {}) {
	const context = await browser.newContext({deviceScaleFactor: 2.8125, viewport: {height: 900, width: 384}});

	await context.grantPermissions(['camera'], {origin: harness.origin});
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await routeTcgdex(context);

	for (const [key, id] of Object.entries(CARDS)) {
		await context.route(`**/__test-card${key === 'a' ? '' : `-${key}`}.webp`, async (route) => route.fulfill({contentType: 'image/webp', path: await cardImage(id)}));
	}

	if (silentWorker) {
		await context.route('**/js/scan/see-worker.js', (route) => route.fulfill({body: SILENT_WORKER, contentType: 'text/javascript'}));
	}

	await context.addInitScript(() => {
		if (sessionStorage.getItem('test-scene') === null) {
			sessionStorage.setItem('test-scene', JSON.stringify({kind: 'table'}));
		}

		localStorage.setItem('card-tracker:scan-holder', 'off');
		localStorage.setItem('card-tracker:scan-log', 'on');
	});
	await context.addInitScript(sceneCamera, FRAME);

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

const items = (page) => page.evaluate(async () => {
	const session = await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession();

	return session ? session.items.map((item) => ({card: item.card && item.card.id, pictureIn: item.report && item.report.pictureIn, pictureWhy: item.report && item.report.pictureWhy, status: item.status})) : [];
});

async function until(check, what, timeout = 30000) {
	const end = Date.now() + timeout;

	while (!(await check())) {
		assert.ok(Date.now() < end, what);
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
}

describe('a picture worker that stops answering', () => {
	test('is let go after its time limit, and its picture is matched on the main thread; the next picture goes there at once', async () => {
		const {context, errors, page} = await open({silentWorker: true});

		await page.evaluate(async () => {
			const identify = await import('/pokemon-card-tracker/js/scan/identify.js');

			identify.WORKER_LIMITS.job = 1500;
			await identify.warmPicture();
		});

		const started = Date.now();

		await setScene(page, {cards: [{card: 'a', size: 0.95}]});
		await until(async () => {
			const list = await items(page);

			return list.length === 1 && list[0].status === 'ready';
		}, 'the card is read although the worker never answered', 60000);

		let list = await items(page);

		assert.equal(list[0].card, CARDS.a);
		assert.equal(list[0].pictureIn, 'main');
		assert.equal(list[0].pictureWhy, 'timeout');
		assert.ok(Date.now() - started >= 1500, 'after the time limit');

		// The next card: no worker this visit, matched here straight away.
		await setScene(page, {kind: 'table'});
		await page.waitForTimeout(800);
		await setScene(page, {cards: [{card: 'b', size: 0.95}]});
		await until(async () => {
			const now = await items(page);

			return now.length === 2 && now[1].status === 'ready';
		}, 'the second card is read', 60000);
		list = await items(page);
		assert.equal(list[1].card, CARDS.b);
		assert.equal(list[1].pictureIn, 'main');
		assert.equal(list[1].pictureWhy, 'no worker');

		const report = await page.evaluate(async () => {
			const entries = await (await import('/pokemon-card-tracker/js/scan/log.js')).listEntries();

			return entries.filter((entry) => entry.report).map((entry) => [entry.report.pictureIn, entry.report.pictureWhy]);
		});

		assert.deepEqual(report, [['main', 'timeout'], ['main', 'no worker']], 'the scan log says where each picture ran');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a worker that answers is used, and the scan report says so', async () => {
		const {context, errors, page} = await open();

		await setScene(page, {cards: [{card: 'c', size: 0.95}]});
		await until(async () => {
			const list = await items(page);

			return list.length === 1 && list[0].status === 'ready';
		}, 'the card is read', 60000);

		const [item] = await items(page);

		assert.equal(item.card, CARDS.c);
		assert.equal(item.pictureIn, 'worker');
		assert.equal(item.pictureWhy, null);
		assert.deepEqual(errors, []);
		await context.close();
	});
});

describe('label checks behind the tray (Eric\'s phone, version 38: card reads waited up to 17 s behind them)', () => {
	test('wait for a card being read, and never take a worker it is waiting for', async () => {
		const {context, errors, page} = await open();

		const run = await page.evaluate(async () => {
			const identify = await import('/pokemon-card-tracker/js/scan/identify.js');
			const engine = await identify.warmEngine();
			const image = new Image();

			image.src = '/__test-card.webp';
			await image.decode();

			const canvas = document.createElement('canvas');

			canvas.width = 301;
			canvas.height = 420;

			const ctx = canvas.getContext('2d', {willReadFrequently: true});

			ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

			const card = ctx.getImageData(0, 0, canvas.width, canvas.height);
			const from = engine.trace.length;
			const labels = [0, 1, 2].map(() => identify.readLanguageLabel(card).then((label) => ({...label, at: performance.now()})));

			// The first label check under way, then a card whose text is read
			// in full (no picture index answer).
			await new Promise((resolve) => setTimeout(resolve, 60));

			const textAt = performance.now();

			await identify.identifyText({card, needsText: true, picture: null, timings: {total: 0}, trace: {regions: []}});

			const textEnd = performance.now();
			const done = await Promise.all(labels);

			return {calls: engine.trace.slice(from).map((call) => ({...call})), done, size: engine.size, textAt, textEnd};
		});

		const front = run.calls.filter((call) => !call.background);
		const back = run.calls.filter((call) => call.background);

		assert.ok(front.length >= 5 && back.length >= 3, `the read and the label checks both ran OCR (${front.length} and ${back.length} calls)`);

		// No label check call took a worker while a card's call waited.
		for (const b of back) {
			for (const f of front) {
				assert.ok(!(f.queued <= b.started && b.started < f.started), `a label check call started at ${Math.round(b.started)} while a read's call queued at ${Math.round(f.queued)} waited until ${Math.round(f.started)}`);
			}
		}

		// The second and third label checks waited for the read to end.
		for (const label of run.done.slice(1)) {
			const startedAt = label.at - label.ms;

			assert.ok(startedAt >= run.textEnd - 5, `a label check started ${Math.round(run.textEnd - startedAt)} ms before the read ended`);
			assert.ok(label.waitedMs > 0);
		}

		assert.deepEqual(errors, []);
		await context.close();
	});
});
