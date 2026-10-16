// Automatic holder mode (Eric, 2026-10-16), in headless Chromium, against
// tests/scan-harness.mjs (Supabase is never reached; TCGdex answers are
// replayed from the harness cache), with the canvas camera of
// tests/scan-scene.mjs and the phone's motion sensors played by the test
// (DeviceMotionEvent, every 16 ms):
//
// - Auto, the first choice: the phone still for 2 s with a still picture
//   turns holder mode on ("Holder (auto)"); a card dropped in is taken and
//   changes nothing; picking the phone up turns it off ("Hand-held
//   (auto)"); the scan log keeps each switch with its evidence;
// - nothing switches while a picture is being matched: the switch waits;
// - Holder and Hand-held, chosen on the chip, override the sensors; with
//   no sensor at all, Auto stays hand-held.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/scan-auto-holder-browser.test.mjs

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

// A picture worker that loads and then never answers (see
// tests/scan-safety-browser.test.mjs).
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

// The phone's motion, played in the page: window.motion = {rotation (degrees
// a second), shake (m/s2)} or null (no sensor), sent as a DeviceMotionEvent
// every 16 ms, each sample wobbling a little.
function motionSensor() {
	window.motion = null;

	let k = 0;

	setInterval(() => {
		const motion = window.motion;

		if (!motion) {
			return;
		}

		const wobble = k++ % 2 ? 1 : -1;

		window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
			acceleration: {x: motion.shake * wobble, y: motion.shake * 0.5, z: 0},
			accelerationIncludingGravity: {x: motion.shake * wobble, y: 9.81, z: 0},
			interval: 16,
			rotationRate: {alpha: motion.rotation * (1 + 0.2 * wobble), beta: motion.rotation * 0.3, gamma: 0},
		}));
	}, 16);
}

async function open({choice = null, silentWorker = false} = {}) {
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
			sessionStorage.setItem('test-scene', JSON.stringify({background: 'box', cards: []}));
		}

		localStorage.setItem('card-tracker:scan-log', 'on');
	});
	await context.addInitScript((value) => {
		if (value && localStorage.getItem('card-tracker:scan-holder') === null) {
			localStorage.setItem('card-tracker:scan-holder', value);
		}
	}, choice);
	await context.addInitScript(sceneCamera, FRAME);
	await context.addInitScript(motionSensor);

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(String(err)));
	await page.goto(`${harness.origin}${BASE}scan`);
	await page.waitForSelector('#scan-guide:not([hidden])', {timeout: 30000});
	await page.waitForFunction(() => document.getElementById('scan-video').videoWidth > 0);
	await page.waitForSelector('#scan-shutter:not([disabled])');

	return {context, errors, page};
}

const setMotion = (page, motion) => page.evaluate((next) => {
	window.motion = next;
}, motion);

const STILL = {rotation: 0.2, shake: 0.02};
const PICKUP = {rotation: 80, shake: 3};
const HAND = {rotation: 4, shake: 0.25};

const chip = (page) => page.locator('#scan-holder').textContent();

const captures = (page) => page.evaluate(async () => (await import('/pokemon-card-tracker/js/scan/view.js')).scanStats.captures);

const modeLog = (page) => page.evaluate(async () => (await (await import('/pokemon-card-tracker/js/scan/log.js')).listEntries()).filter((entry) => entry.how === 'mode').map((entry) => ({evidence: entry.evidence, mode: entry.mode, why: entry.why})));

async function until(check, what, timeout = 30000) {
	const end = Date.now() + timeout;

	while (!(await check())) {
		assert.ok(Date.now() < end, what);
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

// Drops `card` into the box from above the frame (see
// tests/scan-holder-browser.test.mjs).
function drop(page, card) {
	return page.evaluate(async (falling) => {
		for (let step = 6; step >= 0; step--) {
			window.scene = {background: 'box', cards: [{...falling, angle: (falling.angle || 0) + step * 4, dy: (falling.dy || 0) - step * 0.16}]};
			await new Promise((resolve) => setTimeout(resolve, 60));
		}
	}, card);
}

describe('automatic holder mode: the phone\'s stillness, not a switch', () => {
	test('Auto: still for 2 s turns holder mode on, a card dropped in is taken and changes nothing, picking the phone up turns it off', async () => {
		const {context, errors, page} = await open();

		assert.equal(await chip(page), 'Hand-held (auto)', 'Auto is the first choice, hand-held until the phone says otherwise');
		await setMotion(page, STILL);

		const stillAt = Date.now();

		await until(async () => (await chip(page)) === 'Holder (auto)', 'holder mode on by itself', 15000);
		assert.ok(Date.now() - stillAt >= 1900, `after the phone lay still for 2 s (${Date.now() - stillAt} ms)`);
		assert.equal(await page.getAttribute('#scan-holder', 'data-holder'), 'on');
		assert.equal(await page.locator('#scan-hint').textContent(), 'Drop a card in.');

		// A card falls into the box: the picture moves, the phone does not.
		await page.waitForTimeout(1500);
		await drop(page, {card: 'a', size: 0.86});
		await until(async () => (await captures(page)) === 1, 'the card taken in holder mode', 10000);
		await page.waitForTimeout(1500);
		assert.equal(await chip(page), 'Holder (auto)', 'a card dropped is no pickup');

		// Picked up, then held.
		await setMotion(page, PICKUP);
		await page.waitForTimeout(600);
		await setMotion(page, HAND);
		await until(async () => (await chip(page)) === 'Hand-held (auto)', 'hand-held by itself', 10000);
		assert.equal(await page.getAttribute('#scan-holder', 'data-holder'), 'off');

		// Held in a hand, it stays hand-held.
		await page.waitForTimeout(3000);
		assert.equal(await chip(page), 'Hand-held (auto)');

		const log = await modeLog(page);

		assert.deepEqual(log.map((entry) => entry.why), ['holder (auto)', 'hand-held (auto)']);
		assert.ok(log[0].evidence.sensor && log[0].evidence.stillMs >= 2000 && log[0].evidence.pictureStillMs >= 1000 && log[0].evidence.rotation < 1.5, JSON.stringify(log[0].evidence));
		assert.ok(log[1].evidence.movingMs >= 200 || log[1].evidence.rotation !== null, JSON.stringify(log[1].evidence));
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('nothing switches while a picture is being matched; the switch waits for it', async () => {
		const {context, errors, page} = await open({silentWorker: true});

		await page.evaluate(async () => {
			const identify = await import('/pokemon-card-tracker/js/scan/identify.js');

			identify.WORKER_LIMITS.job = 4000;
		});
		await setMotion(page, STILL);
		await until(async () => (await chip(page)) === 'Holder (auto)', 'holder mode on by itself', 15000);
		await page.waitForTimeout(1500);
		await drop(page, {card: 'b', size: 0.86});
		await until(async () => (await captures(page)) === 1, 'the card taken', 10000);

		// Picked up while its picture waits on a worker that never answers.
		const pickedAt = Date.now();

		await setMotion(page, PICKUP);
		await page.waitForTimeout(600);
		await setMotion(page, HAND);
		await page.waitForTimeout(1000);
		assert.equal(await chip(page), 'Holder (auto)', 'no switch while the picture is matched');
		await until(async () => (await chip(page)) === 'Hand-held (auto)', 'hand-held once the picture is matched', 20000);
		assert.ok(Date.now() - pickedAt >= 3000, 'after the worker was let go and the picture matched here');

		const reasons = () => page.evaluate(async () => (await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession()).items.map((item) => item.report && item.report.pictureWhy));

		await until(async () => (await reasons()).every(Boolean), 'the card read', 30000);
		assert.deepEqual(await reasons(), ['timeout']);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('Holder and Hand-held chosen on the chip override the sensors; with no sensor, Auto stays hand-held', async () => {
		let {context, errors, page} = await open({choice: 'on'});

		assert.equal(await chip(page), 'Holder');
		await setMotion(page, PICKUP);
		await page.waitForTimeout(800);
		await setMotion(page, HAND);
		await page.waitForTimeout(1500);
		assert.equal(await chip(page), 'Holder', 'Holder chosen: picked up, still holder');
		assert.deepEqual(errors, []);
		await context.close();

		({context, errors, page} = await open({choice: 'off'}));
		assert.equal(await chip(page), 'Hand-held');
		await setMotion(page, STILL);
		await page.waitForTimeout(4000);
		assert.equal(await chip(page), 'Hand-held', 'Hand-held chosen: still, still hand-held');

		// Back to Auto on the chip: Hand-held, then Auto.
		await page.click('#scan-holder');
		assert.equal(await chip(page), 'Hand-held (auto)');
		await until(async () => (await chip(page)) === 'Holder (auto)', 'Auto chosen: holder mode on by itself', 15000);
		assert.deepEqual((await modeLog(page)).map((entry) => entry.why), ['auto chosen', 'holder (auto)']);
		assert.deepEqual(errors, []);
		await context.close();

		({context, errors, page} = await open());
		await page.waitForTimeout(4000);
		assert.equal(await chip(page), 'Hand-held (auto)', 'no sensor: hand-held');
		assert.deepEqual(errors, []);
		await context.close();
	});
});
