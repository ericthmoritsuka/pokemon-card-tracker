// The full-resolution capture read off the main thread (camera.js
// grabBitmap, see-worker.js), in headless Chromium, against
// tests/scan-harness.mjs (Supabase is never reached; TCGdex answers are
// replayed from the harness cache).
//
// The camera is tests/scan-scene.mjs's canvas at 2160 x 3840, a card held
// to the guide. The shutter takes it three times with the capture read in
// the worker, then three times with the developer switch that reads it on
// the main thread (card-tracker:scan-grab-here, the way before version
// 39), at full speed and with the CPU slowed four times. Each run prints
// the main thread's long tasks (PerformanceObserver longtask) from the
// shutter until the card is in the tray: their sum and the longest. The
// numbers are printed, not asserted: this machine's load moves them.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/scan-grab-browser.test.mjs

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {cardImage, routeTcgdex, startScanHarness} from './scan-harness.mjs';
import {sceneCamera} from './scan-scene.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const CARD = 'me01-001';
const FRAME = {height: 3840, width: 2160};
const SHOTS = 3;

let harness;
let browser;
const table = [];

before(async () => {
	harness = await startScanHarness();
	browser = await chromium.launch();
});

after(async () => {
	await browser.close();
	await harness.close();

	if (table.length) {
		console.log('# Main thread long tasks from the shutter to the card in the tray (headless Chromium on this machine):');

		for (const row of table) {
			console.log(`# ${row.mode}, CPU x${row.throttle}: grab ${row.grab.join(', ')} ms; long tasks ${row.sums.join(', ')} ms in all, longest ${row.longest.join(', ')} ms`);
		}
	}
});

async function open({here}) {
	const context = await browser.newContext({acceptDownloads: true, deviceScaleFactor: 2.8125, viewport: {height: 900, width: 384}});

	await context.grantPermissions(['camera'], {origin: harness.origin});
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await context.route('https://*.supabase.co/**', (route) => route.abort());
	await routeTcgdex(context);

	for (const name of ['', '-b', '-c']) {
		await context.route(`**/__test-card${name}.webp`, async (route) => route.fulfill({contentType: 'image/webp', path: await cardImage(CARD)}));
	}

	// The table alone at first, so nothing is taken until the shutter.
	await context.addInitScript(() => sessionStorage.setItem('test-scene', JSON.stringify({background: 'table', cards: []})));
	await context.addInitScript(sceneCamera, FRAME);
	await context.addInitScript((on) => {
		localStorage.setItem('card-tracker:scan-holder', 'off');
		localStorage.setItem('card-tracker:scan-grab-here', on ? 'on' : 'off');
		window.longTasks = [];
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				window.longTasks.push({at: entry.startTime, ms: entry.duration});
			}
		}).observe({type: 'longtask'});
	}, here);

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(String(err)));
	await page.goto(`${harness.origin}${BASE}scan`);
	await page.waitForSelector('#scan-guide:not([hidden])', {timeout: 30000});
	await page.waitForFunction(() => document.getElementById('scan-video').videoWidth > 0);
	await page.waitForSelector('#scan-shutter:not([disabled])');

	return {context, errors, page};
}

async function waitSettled(page) {
	await page.waitForFunction(() => ![...document.querySelectorAll('#scan-tray .scan-tile')].some((tile) => ['reading', 'matching'].includes(tile.dataset.status)), null, {polling: 100, timeout: 120000});
}

const settledTiles = (page) => page.evaluate(() => [...document.querySelectorAll('#scan-tray .scan-tile')].filter((tile) => !['reading', 'matching'].includes(tile.dataset.status)).length);

async function measure(here, throttle) {
	const {context, errors, page} = await open({here});
	const cdp = await context.newCDPSession(page);

	// The picture index loaded and the card in place before the first shot.
	await page.evaluate(async () => (await import('/pokemon-card-tracker/js/scan/identify.js')).warmPicture());
	await page.evaluate(() => {
		window.scene = {background: 'table', cards: [{angle: 0.6, card: 'a', size: 0.95}]};
	});
	await page.waitForTimeout(400);

	if (throttle > 1) {
		await cdp.send('Emulation.setCPUThrottlingRate', {rate: throttle});
	}

	const sums = [];
	const longest = [];
	const grab = [];

	for (let shot = 1; shot <= SHOTS; shot++) {
		// Auto capture may take the card held still too: each shot waits for
		// one more card than the tray had.
		await waitSettled(page);

		const had = await page.locator('#scan-tray .scan-tile').count();
		const from = await page.evaluate(() => performance.now());

		await page.click('#scan-shutter');

		const end = Date.now() + 120000;

		while (await settledTiles(page) < had + 1) {
			assert.ok(Date.now() < end, `shot ${shot} read`);
			await page.waitForTimeout(100);
		}

		const tasks = await page.evaluate((start) => window.longTasks.filter((task) => task.at >= start), from);

		sums.push(Math.round(tasks.reduce((sum, task) => sum + task.ms, 0)));
		longest.push(Math.round(Math.max(0, ...tasks.map((task) => task.ms))));
	}

	await cdp.send('Emulation.setCPUThrottlingRate', {rate: 1});

	const stats = await page.evaluate(async () => (await import('/pokemon-card-tracker/js/scan/view.js')).scanStats.grabs);
	const items = await page.evaluate(async () => (await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession()).items.map((item) => ({card: item.card && item.card.id, captureMs: item.report && item.report.captureMs, frame: item.report && item.report.frame})));

	for (const item of items) {
		grab.push(item.captureMs);
	}

	table.push({grab, longest, mode: here ? 'pixels read on the main thread' : 'bitmap read in the worker', sums, throttle});

	return {context, errors, items, page, stats};
}

// The grab alone, ten times each way on the live video: how long the main
// thread is held (grabFrame's drawImage and getImageData, all of it on the
// main thread; grabBitmap's call, and the longest the event loop then
// waits while the bitmap is made), and the worker's turning the bitmap into
// pixels, which the main thread never waits for.
async function grabAlone(page) {
	return page.evaluate(async () => {
		const camera = await import('/pokemon-card-tracker/js/scan/camera.js');
		const video = document.getElementById('scan-video');
		const region = {h: Math.round(video.videoHeight * 0.7), w: Math.round(video.videoWidth * 0.88), x: Math.round(video.videoWidth * 0.06), y: Math.round(video.videoHeight * 0.15)};
		const here = [];
		const call = [];
		const lag = [];
		const lagOf = async (promise) => {
			let worst = 0;
			let last = performance.now();
			let done = false;

			promise.finally(() => {
				done = true;
			});

			while (!done) {
				await new Promise((resolve) => setTimeout(resolve, 0));

				const now = performance.now();

				worst = Math.max(worst, now - last);
				last = now;
			}

			return worst;
		};

		for (let i = 0; i < 10; i++) {
			let at = performance.now();

			camera.grabFrame(video, region);
			here.push(performance.now() - at);
			at = performance.now();

			const pending = camera.grabBitmap(video, region);

			call.push(performance.now() - at);
			lag.push(await lagOf(pending));
			(await pending).bitmap.close();
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

		const median = (list) => Math.round(list.slice().sort((a, b) => a - b)[list.length >> 1]);

		return {call: median(call), here: median(here), lag: median(lag), size: `${region.w} x ${region.h}`};
	});
}

describe('the full capture read off the main thread', () => {
	for (const throttle of [1, 4]) {
		test(`the grab alone, CPU x${throttle}`, async () => {
			const {context, errors, page} = await open({here: false});
			const cdp = await context.newCDPSession(page);

			await page.evaluate(() => {
				window.scene = {background: 'table', cards: [{angle: 0.6, card: 'a', size: 0.95}]};
			});
			await page.waitForTimeout(400);
			await cdp.send('Emulation.setCPUThrottlingRate', {rate: throttle});

			const alone = await grabAlone(page);

			await cdp.send('Emulation.setCPUThrottlingRate', {rate: 1});
			console.log(`# The grab alone, ${alone.size}, CPU x${throttle} (median of 10): grabFrame holds the main thread ${alone.here} ms; grabBitmap's call ${alone.call} ms, the event loop's longest wait while it runs ${alone.lag} ms`);
			assert.ok(alone.here >= 0 && alone.call >= 0);
			assert.deepEqual(errors, []);
			await context.close();
		});
	}

	for (const throttle of [1, 4]) {
		test(`in the worker, CPU x${throttle}: each shot is read, and its capture image can still be saved`, async () => {
			const {context, errors, items, page, stats} = await measure(false, throttle);

			assert.ok(stats.away >= SHOTS && stats.here === 0, `every capture went to the worker as a bitmap: ${JSON.stringify(stats)}`);
			assert.ok(items.length >= SHOTS && items.every((item) => item.card === CARD), JSON.stringify(items));
			assert.ok(items.every((item) => /^\d+ x \d+$/.test(item.frame) && Number(item.frame.split(' x ')[1]) > 1500), `full resolution: ${items.map((item) => item.frame).join(', ')}`);

			// Each card was looked up after its full capture was kept in the
			// draft (view.js waits for the worker's JPEG before the match), and
			// the pixels came back for the scan report's capture image.
			if (throttle === 1) {
				// The newest tile (the tray shows the newest first): its capture is among
				// the last few kept in memory.
				await page.click('#scan-tray li:first-child .scan-tile');
				await page.waitForSelector('#scan-report-open');
				await page.click('#scan-report-open');
				await page.waitForSelector('#scan-report-capture');

				const downloads = [];

				page.on('download', (download) => downloads.push(download));
				await page.click('#scan-report-capture');

				const end = Date.now() + 15000;

				while (downloads.length < 2) {
					assert.ok(Date.now() < end, 'two capture images');
					await page.waitForTimeout(100);
				}
			}

			assert.deepEqual(errors, []);
			await context.close();
		});

		test(`on the main thread (the developer switch), CPU x${throttle}: for comparison`, async () => {
			const {context, errors, items, stats} = await measure(true, throttle);

			assert.ok(stats.here >= SHOTS && stats.away === 0, JSON.stringify(stats));
			assert.ok(items.length >= SHOTS && items.every((item) => item.card === CARD), JSON.stringify(items));
			assert.deepEqual(errors, []);
			await context.close();
		});
	}

});
