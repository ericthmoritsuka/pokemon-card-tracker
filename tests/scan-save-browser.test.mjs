// Saving a whole session (Eric, version 38, his phone): "tapping Save N
// cards did nothing at all", the screen seemed frozen until he left the
// scanner and came back. Each tray card was saved on its own (js/collection.js
// addCard), so a tray of 48 wrote the whole document 48 times and woke every
// listener as often: sync's diff, the scanner's owned index, a redraw of the
// tray and the Done sheet. With 1500 cards owned and the CPU slowed 6 times
// (a mid-range phone) that held the page for about 15 s with nothing on the
// screen changing. Now the tray is one save, and Save says at once that it
// is saving.
//
// Headless Chromium against tests/scan-harness.mjs, with the canvas camera
// of tests/scan-scene.mjs (an empty table). The collection and the draft
// tray are written before Scan opens; Supabase is never reached.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/scan-save-browser.test.mjs

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {cardImage, routeTcgdex, startScanHarness} from './scan-harness.mjs';
import {sceneCamera} from './scan-scene.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const OWNED = 1500;
const TRAY = 48;

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

async function open() {
	const context = await browser.newContext({deviceScaleFactor: 2.8125, viewport: {height: 780, width: 384}});

	await context.grantPermissions(['camera'], {origin: harness.origin});
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await routeTcgdex(context);
	await context.addInitScript(sceneCamera, {height: 3840, width: 2160});
	await context.addInitScript(() => localStorage.setItem('card-tracker:scan-holder', 'off'));

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(String(err)));

	// The collection, and a tray of cards ready to save, before Scan opens.
	await page.goto(`${harness.origin}${BASE}cards`);
	await page.evaluate(async ({owned, tray}) => {
		const collection = await import('/pokemon-card-tracker/js/collection.js');
		const draft = await import('/pokemon-card-tracker/js/scan/draft.js');
		const S = await import('/pokemon-card-tracker/js/scan/session.js');
		const list = [];

		for (let i = 0; i < owned; i++) {
			list.push({card_id: `sv0${1 + (i % 8)}-${String(1 + (i % 200)).padStart(3, '0')}`, catalog: 'international', condition: 'NM', language: 'en', variant_id: null});
		}

		await collection.addCards(list);

		const session = S.newSession();

		for (let i = 0; i < tray; i++) {
			const item = S.addCapture(session, {id: `tray-${i}`});

			Object.assign(item, {
				card: {catalog: 'international', id: `me01-${String(1 + i).padStart(3, '0')}`, lang: 'en', localId: String(1 + i), name: `Card ${i + 1}`, official: '132', setId: 'me01', setName: 'Mega Evolution'},
				confirmed: true,
				language: 'pt',
				languageBy: 'hand',
				status: 'ready',
				sure: true,
				variantId: null,
				variants: [],
			});
		}

		await draft.saveSession(session);
	}, {owned: OWNED, tray: TRAY});
	await page.goto(`${harness.origin}${BASE}scan`);
	await page.waitForSelector('#scan-shutter:not([disabled])', {timeout: 30000});
	await page.waitForFunction((tray) => document.getElementById('scan-done-open').textContent === `Done ${tray}`, TRAY);

	return {context, errors, page};
}

describe('Save on the Done sheet', () => {
	test('a tray of 48 is one save of the document, Save says at once it is saving, and every card lands', async () => {
		const {context, errors, page} = await open();

		await page.click('#scan-done-open');
		await page.waitForSelector('#scan-save-session');
		assert.equal(await page.locator('#scan-save-session').textContent(), `Save ${TRAY} cards`);

		// The saves the document takes from here on.
		await page.evaluate(async () => {
			const collection = await import('/pokemon-card-tracker/js/collection.js');

			window.saves = 0;
			collection.onChange(() => {
				window.saves++;
			});
		});

		const cdp = await context.newCDPSession(page);

		await cdp.send('Emulation.setCPUThrottlingRate', {rate: 6});

		// The label changes in the same task as the tap.
		const shown = await page.evaluate(() => {
			const button = document.getElementById('scan-save-session');

			button.click();

			const now = document.getElementById('scan-save-session');

			return {busy: now.getAttribute('aria-busy'), disabled: now.disabled, discard: document.getElementById('scan-discard-session').disabled, text: now.textContent};
		});

		assert.deepEqual(shown, {busy: 'true', disabled: true, discard: true, text: `Saving ${TRAY} cards…`});

		const started = Date.now();

		await page.waitForSelector('#scan-saved-line', {timeout: 60000});

		const tookMs = Date.now() - started;

		await cdp.send('Emulation.setCPUThrottlingRate', {rate: 1});

		const result = await page.evaluate(async () => {
			const collection = await import('/pokemon-card-tracker/js/collection.js');
			const cards = await collection.listCards();
			const scanned = cards.filter((entry) => entry.card_id.startsWith('me01-'));

			return {
				languages: [...new Set(scanned.map((entry) => entry.language))],
				saves: window.saves,
				scanned: scanned.map((entry) => entry.card_id).sort(),
				source: [...new Set(scanned.map((entry) => entry.language_source))],
				total: cards.length,
				tray: document.getElementById('scan-done-open').textContent,
			};
		});

		assert.equal(result.saves, 1, 'the tray is written in one save of the document');
		assert.equal(result.total, OWNED + TRAY);
		assert.deepEqual(result.scanned, Array.from({length: TRAY}, (_, i) => `me01-${String(1 + i).padStart(3, '0')}`));
		assert.deepEqual(result.languages, ['pt']);
		assert.deepEqual(result.source, ['scan']);
		assert.equal(result.tray, 'Done');
		assert.equal(await page.locator('#scan-saved-line').textContent(), `Saved ${TRAY} cards`);
		// Generous for a busy machine: card by card it took about 15 s here.
		assert.ok(tookMs < 8000, `saved in ${tookMs} ms with the CPU slowed 6 times`);
		assert.deepEqual(errors, []);
		await context.close();
	});
});

// The other half of Eric's version 38 report: a shutter capture that never
// got an answer sat "Reading…" for five minutes (its scan log entry had the
// straightened picture, and no answer, report, or timings), and held Save
// back as "1 still reading" until he removed it. The same happened twice on
// version 32. Whatever throws after the picture is matched, the card now
// asks for a look, and the error is in the scan log.
describe('a read that throws part way', () => {
	test('the card needs a look instead of reading forever, the error is logged, and Save is not held back', async () => {
		const context = await browser.newContext({deviceScaleFactor: 2.8125, viewport: {height: 780, width: 384}});

		await context.grantPermissions(['camera'], {origin: harness.origin});
		await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
		await routeTcgdex(context);
		await context.route('**/__test-card.webp', async (route) => route.fulfill({contentType: 'image/webp', path: await cardImage('me01-001')}));
		await context.addInitScript(() => sessionStorage.setItem('test-scene', JSON.stringify({background: 'table', cards: [{card: 'a', size: 0.9}]})));
		await context.addInitScript(sceneCamera, {height: 3840, width: 2160});
		await context.addInitScript(() => {
			localStorage.setItem('card-tracker:scan-holder', 'off');
			localStorage.setItem('card-tracker:scan-log', 'on');
			// The draft's copy of the tray throws once, the moment a capture
			// whose picture is matched is marked as being looked up: a stand-in
			// for whatever stopped the phone's read there.
			const stringify = JSON.stringify;

			window.breakOnce = true;
			JSON.stringify = function (value, ...rest) {
				if (window.breakOnce && value && Array.isArray(value.items) && value.items.some((item) => item.status === 'matching' && item.picture && !item.card)) {
					window.breakOnce = false;

					throw new TypeError('test: the read stopped here');
				}

				return stringify.call(this, value, ...rest);
			};
		});

		const page = await context.newPage();

		await page.goto(`${harness.origin}${BASE}scan`);
		await page.waitForSelector('#scan-shutter:not([disabled])', {timeout: 30000});
		await page.click('#scan-shutter');
		await page.waitForFunction(() => window.breakOnce === false, null, {timeout: 60000});
		await page.waitForFunction(() => {
			// The shutter's capture is the oldest tile: the card lying still
			// on the table may be taken again on its own after it.
			const tiles = document.querySelectorAll('#scan-tray [data-item]');
			const tile = tiles[tiles.length - 1];

			return tile && tile.dataset.status !== 'reading' && tile.dataset.status !== 'matching';
		}, null, {timeout: 30000});

		const state = await page.evaluate(async () => {
			const session = await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession();
			const log = JSON.parse(await (await (await import('/pokemon-card-tracker/js/scan/log.js')).logFile()).text());

			const tiles = document.querySelectorAll('#scan-tray [data-item]');
			const shutter = log.entries.find((entry) => entry.how === 'shutter');

			return {entry: {error: shutter.error, status: shutter.first && shutter.first.status}, errors: log.entries.filter((entry) => entry.error).length, item: (({status, why}) => ({status, why}))(session.items[0]), tile: tiles[tiles.length - 1].dataset.status};
		});

		assert.deepEqual(state.item, {status: 'ready', why: 'The read stopped before an answer. Scan the card again, or search for it.'});
		assert.equal(state.tile, 'unmatched');
		assert.equal(state.errors, 1, 'only the read that threw is marked');
		assert.match(state.entry.error, /the read stopped here/);
		assert.equal(state.entry.status, 'unmatched');

		// Save opens the card for a look rather than waiting on it.
		await page.click('#scan-done-open');
		await page.waitForSelector('#scan-save-session:not([disabled])');
		await page.click('#scan-save-session');
		await page.waitForSelector('#scan-confirm');
		await context.close();
	});
});
