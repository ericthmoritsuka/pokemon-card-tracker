// Browser tests for the scanner's default finish (Eric, 2026-10-15,
// js/scan/finish.js DEFAULT_FINISHES): the settings chip at the foot of the
// camera, its sheet, the choice remembered on the phone, and a picked photo of a
// card starting on that finish, or asking for one.
//
// Headless Chromium at 360 x 740 against tests/scan-harness.mjs, with no
// camera (the scanner opens with the camera off) and a photo picked from
// the gallery: Bulbasaur (Mega Evolution, me01-001), which has a normal
// print and a reverse holo. TCGdex answers are replayed from the harness
// cache; any Supabase request is refused.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/scan-finish-browser.test.mjs

import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {after, before, describe, test} from 'node:test';

import {cardImage, routeTcgdex, startScanHarness} from './scan-harness.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const VIEWPORT = {height: 740, width: 360};
const SHOTS = process.env.SHOTS || '/tmp';
const PHOTOS = '/tmp/scan-finish-photos';

const BULBASAUR = 'me01-001';
const NORMAL = 'endfynwn4n10gzq';
const REVERSE = 'cm4kqul3x1bwlz1f';

let harness;
let browser;
let photo;

const url = (path = '') => `${harness.origin}${BASE}${path}`;

async function until(check, timeout = 30000, what = 'a condition') {
	const end = Date.now() + timeout;

	while (!(await check())) {
		if (Date.now() > end) {
			throw new Error(`Timed out waiting for ${what}.`);
		}

		await new Promise((resolve) => setTimeout(resolve, 150));
	}
}

// Bulbasaur's TCGdex scan on a table, turned 8 degrees, as a JPEG.
async function makePhoto(page) {
	const webp = (await readFile(await cardImage(BULBASAUR))).toString('base64');
	const jpeg = await page.evaluate(async (data) => {
		const img = new Image();

		img.src = `data:image/webp;base64,${data}`;
		await img.decode();

		const canvas = document.createElement('canvas');

		canvas.width = Math.round(img.naturalWidth * 1.3);
		canvas.height = Math.round(img.naturalHeight * 1.3);

		const ctx = canvas.getContext('2d');

		ctx.fillStyle = '#6b5442';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.translate(canvas.width / 2, canvas.height / 2);
		ctx.rotate((8 * Math.PI) / 180);
		ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);

		return canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
	}, webp);
	const file = join(PHOTOS, `photo-${randomUUID()}.jpg`);

	await mkdir(PHOTOS, {recursive: true});
	await writeFile(file, Buffer.from(jpeg, 'base64'));

	return file;
}

async function open() {
	const context = await browser.newContext({viewport: VIEWPORT});
	const supabase = [];

	await context.addInitScript(() => localStorage.setItem('card-tracker:scan-log', 'on'));
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await context.route('https://*.supabase.co/**', (route) => {
		supabase.push(route.request().url());

		return route.abort();
	});
	await routeTcgdex(context);

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err));

	return {context, errors, page, supabase};
}

async function close({context, errors, supabase}) {
	await context.close();
	assert.deepEqual(errors.map(String), [], 'no script errors');
	assert.deepEqual(supabase, [], 'no Supabase request');
}

const text = (page, selector) => page.locator(selector).textContent();

const tileOf = (page) => page.$eval('#scan-tray li:last-child .scan-tile', (tile) => ({
	finish: (tile.querySelector('.scan-finish') || {}).textContent || null,
	label: tile.getAttribute('aria-label'),
	status: tile.dataset.status,
}));

async function setDefault(page, value, label) {
	await page.click('#scan-settings-open');
	await page.waitForSelector('#scan-settings');
	await page.click(`#scan-finish-default-${value}`);
	assert.equal(await page.getAttribute(`#scan-finish-default-${value}`, 'aria-pressed'), 'true');
	assert.match(await page.getAttribute('#scan-settings-open', 'aria-label'), new RegExp(`default finish ${label},`));
	await page.click('#scan-sheet-close');
	await page.waitForSelector('#scan-settings', {state: 'detached'});
}

async function pickPhoto(page) {
	await page.setInputFiles('#scan-photo-input', photo);
	await page.waitForSelector('#scan-confirm #scan-card-name', {timeout: 60000});
	assert.equal(await text(page, '#scan-card-name'), 'Bulbasaur');
	await page.waitForSelector(`#scan-finish-${REVERSE}`, {timeout: 60000});
}

describe('the default finish', () => {
	before(async () => {
		harness = await startScanHarness();
		browser = await chromium.launch();

		const scratch = await browser.newPage();

		photo = await makePhoto(scratch);
		await scratch.close();
	});

	after(async () => {
		await browser.close();
		await harness.close();
	});

	test('a chip opens the setting, which is remembered, and a scanned card starts on it', async () => {
		const app = await open();
		const {page} = app;

		await page.goto(url('scan'));
		await page.waitForSelector('#scan-camera-off:not([hidden])');
		assert.equal(await text(page, '#scan-settings-open'), 'Settings');
		assert.match(await page.getAttribute('#scan-settings-open', 'aria-label'), /^Scanner settings: default finish Normal, valuable cards from R\$\s50,00$/, 'Normal until one is picked');

		await page.click('#scan-settings-open');
		await page.waitForSelector('#scan-settings');
		assert.equal(await page.getAttribute('#scan-finish-default-values', 'role'), 'group');
		assert.deepEqual(await page.$$eval('#scan-finish-default-values .scan-chip', (chips) => chips.map((chip) => [chip.textContent, chip.getAttribute('aria-pressed')])),
			[['Normal', 'true'], ['Holo', 'false'], ['Reverse holo', 'false'], ['Ask', 'false']]);
		await page.screenshot({path: `${SHOTS}/scan-finish-default.png`});
		await page.click('#scan-sheet-close');

		await setDefault(page, 'reverse', 'Reverse holo');
		assert.equal(await page.evaluate(() => localStorage.getItem('card-tracker:scan-finish')), 'reverse');

		// Bulbasaur lists a reverse holo, so it starts on it.
		await pickPhoto(page);
		assert.equal(await page.getAttribute(`#scan-finish-${REVERSE}`, 'aria-pressed'), 'true');
		assert.equal(await page.getAttribute(`#scan-finish-${NORMAL}`, 'aria-pressed'), 'false');
		assert.equal(await text(page, '#scan-finish-source'), 'your default finish');

		// The card sheet still changes it.
		await page.click(`#scan-finish-${NORMAL}`);
		assert.equal(await page.getAttribute(`#scan-finish-${NORMAL}`, 'aria-pressed'), 'true');
		assert.equal(await page.locator('#scan-finish-source').count(), 0, 'no longer the default');
		await page.click(`#scan-finish-${REVERSE}`);
		await page.click('#scan-sheet-close');
		assert.equal((await tileOf(page)).finish, 'REV');

		// The scan log keeps where the finish came from: the scanner's own
		// answer was the default.
		await until(async () => {
			const entries = await page.evaluate(async () => (await import('/pokemon-card-tracker/js/scan/log.js')).listEntries());

			return entries.length === 1 && entries[0].first && entries[0].first.finishBy === 'default' && entries[0].first.finish === REVERSE;
		}, 10000, 'the scan log entry with finishBy default');

		// Remembered after a reload.
		await page.reload();
		await page.waitForSelector('#scan-settings-open');
		assert.match(await page.getAttribute('#scan-settings-open', 'aria-label'), /default finish Reverse holo,/);

		await close(app);
	});

	test('Ask leaves a card with more than one finish for a tap', async () => {
		const app = await open();
		const {page} = app;

		await page.goto(url('scan'));
		await page.waitForSelector('#scan-camera-off:not([hidden])');
		await setDefault(page, 'ask', 'Ask');

		await pickPhoto(page);
		assert.equal(await page.getAttribute(`#scan-finish-${REVERSE}`, 'aria-pressed'), 'false');
		assert.equal(await page.getAttribute(`#scan-finish-${NORMAL}`, 'aria-pressed'), 'false');
		assert.equal(await text(page, '#scan-finish-source'), 'pick one');
		assert.equal(await text(page, '#scan-why'), '? Pick the finish of this card.');
		assert.equal(await text(page, '#scan-save-why'), 'Pick the finish before saving.');
		assert.equal(await page.getAttribute('#scan-save', 'disabled'), '');

		const asking = await tileOf(page);

		assert.equal(asking.status, 'finish');
		assert.match(asking.label, /Pick the finish, opens the review/);
		await page.screenshot({path: `${SHOTS}/scan-finish-ask.png`});

		await page.click(`#scan-finish-${NORMAL}`);
		await until(async () => (await tileOf(page)).status === 'ready', 5000, 'the card ready once its finish is picked');

		await close(app);
	});
});
