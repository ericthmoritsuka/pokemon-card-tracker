// The shutter sound (Eric, 2026-10-15, js/scan/chime.js playShutter), in
// headless Chromium against tests/scan-harness.mjs, with AudioContext
// replaced by a stub that counts the sounds started (no sound is made).
//
// The camera is tests/scan-scene.mjs's canvas. One click per capture, at
// the moment it is taken: auto capture, the shutter, and a frame with no
// card (which leaves the tray after, and plays nothing more); none once
// switched off, which is remembered; on until then.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/scan-sound-browser.test.mjs

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

// In the page before any script: an AudioContext that makes no sound and
// counts each noise burst started (the shutter's click) and each note
// (an oscillator: the click's thump, or the valuable card chime).
function stubAudio() {
	window.sounds = {bursts: 0, notes: 0};

	const node = () => ({connect: (next) => next, frequency: {exponentialRampToValueAtTime() {}, setValueAtTime() {}}, gain: {exponentialRampToValueAtTime() {}, setValueAtTime() {}, value: 1}});

	window.AudioContext = class {
		constructor() {
			this.currentTime = 0;
			this.destination = {};
			this.sampleRate = 48000;
			this.state = 'running';
		}

		createBuffer(channels, length) {
			const data = new Float32Array(length);

			return {getChannelData: () => data};
		}

		createBufferSource() {
			return {...node(), start: () => window.sounds.bursts++};
		}

		createGain() {
			return node();
		}

		createOscillator() {
			return {...node(), start: () => window.sounds.notes++, stop() {}};
		}

		resume() {
			return Promise.resolve();
		}
	};
}

async function open(context) {
	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(String(err)));
	await page.goto(`${harness.origin}${BASE}scan`);
	await page.waitForSelector('#scan-guide:not([hidden])', {timeout: 30000});
	await page.waitForFunction(() => document.getElementById('scan-video').videoWidth > 0);
	await page.waitForSelector('#scan-shutter:not([disabled])');

	return {errors, page};
}

const captures = (page) => page.evaluate(async () => (await import('/pokemon-card-tracker/js/scan/view.js')).scanStats.captures);

const bursts = (page) => page.evaluate(() => window.sounds.bursts);

async function until(check, what, timeout = 30000) {
	const end = Date.now() + timeout;

	while (!(await check())) {
		assert.ok(Date.now() < end, what);
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
}

describe('the shutter sound', () => {
	test('one click per capture, on until switched off, and remembered', async () => {
		const context = await browser.newContext({deviceScaleFactor: 2.8125, viewport: {height: 900, width: 384}});

		await context.grantPermissions(['camera'], {origin: harness.origin});
		await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
		await context.route('https://*.supabase.co/**', (route) => route.abort());
		await context.route('https://api.frankfurter.dev/**', (route) => route.abort());
		await routeTcgdex(context);

		for (const name of ['', '-b', '-c']) {
			await context.route(`**/__test-card${name}.webp`, async (route) => route.fulfill({contentType: 'image/webp', path: await cardImage(CARD)}));
		}

		await context.addInitScript(() => {
			if (sessionStorage.getItem('test-scene') === null) {
				sessionStorage.setItem('test-scene', JSON.stringify({background: 'table', cards: []}));
			}

			localStorage.setItem('card-tracker:scan-holder', 'off');
		});
		await context.addInitScript(sceneCamera, FRAME);
		await context.addInitScript(stubAudio);

		const {errors, page} = await open(context);

		// The table alone: nothing taken, nothing heard.
		await page.waitForTimeout(1000);
		assert.equal(await bursts(page), 0);

		// Auto capture of a card held still: one click, then the read adds
		// nothing.
		await page.evaluate(() => {
			window.scene = {background: 'table', cards: [{angle: 0.6, card: 'a', size: 0.95}]};
		});
		await until(async () => (await captures(page)) === 1, 'auto capture');
		await page.waitForFunction(() => document.querySelectorAll('#scan-tray .scan-tile:not([data-status="reading"]):not([data-status="matching"])').length === 1, null, {timeout: 60000});
		assert.equal(await bursts(page), 1, 'one click for the auto capture');

		// A frame with no card, by the shutter: its click at the moment it is
		// taken, and nothing more once it is found to hold no card.
		await page.evaluate(() => {
			window.scene = {background: 'table', cards: []};
		});
		await page.waitForTimeout(600);
		await page.click('#scan-shutter');
		await until(async () => (await captures(page)) === 2, 'the shutter took the blank frame', 5000);
		await page.waitForFunction(() => /did not look like a card/.test(document.getElementById('scan-note').textContent), null, {polling: 200, timeout: 60000});
		assert.equal(await bursts(page), 2, 'one click for the blank frame, none after it was dropped');

		// Switched off in the settings: the next capture is silent.
		await page.click('#scan-settings-open');
		await page.waitForSelector('#scan-settings');
		assert.equal(await page.getAttribute('#scan-shutter-sound', 'aria-checked'), 'true', 'on at first');
		await page.click('#scan-shutter-sound');
		assert.equal(await page.getAttribute('#scan-shutter-sound', 'aria-checked'), 'false');
		await page.click('#scan-sheet-close');
		await page.click('#scan-shutter');
		await until(async () => (await captures(page)) === 3, 'the shutter took a picture', 5000);
		await page.waitForTimeout(500);
		assert.equal(await bursts(page), 2, 'no click once switched off');

		// Remembered across a reload.
		await page.reload();
		await page.waitForSelector('#scan-shutter:not([disabled])');
		await page.click('#scan-settings-open');
		await page.waitForSelector('#scan-settings');
		assert.equal(await page.getAttribute('#scan-shutter-sound', 'aria-checked'), 'false');
		assert.deepEqual(errors, []);
		await context.close();
	});
});
