// Review (Eric, 2026-10-09): from the Done sheet, the cards that need a
// look open one after another. Once the card open is settled (the right one
// tapped), the next opens by itself; Next card skips ahead; after the last,
// the Done sheet comes back. Stop, or Back, ends the run, and the cards left
// stay marked in the tray.
//
// Headless Chromium against tests/scan-harness.mjs, with the canvas camera
// of tests/scan-scene.mjs showing an empty table, and a tray of three cards
// that need a look put in the draft before Scan opens (TCGdex answers are
// replayed from the harness cache; Supabase is never reached).
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/scan-review-browser.test.mjs

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {routeTcgdex, startScanHarness} from './scan-harness.mjs';
import {sceneCamera} from './scan-scene.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';

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

// Three tray cards the picture could not settle, each with two candidates
// to tap, their language already picked.
const CANDIDATES = [
	[{id: 'me01-001', localId: '001', name: 'Bulbasaur', official: '132', setId: 'me01', setName: 'Mega Evolution'}, {id: 'sv03.5-001', localId: '001', name: 'Bulbasaur', official: '165', setId: 'sv03.5', setName: '151'}],
	[{id: 'sv03.5-025', localId: '025', name: 'Pikachu', official: '165', setId: 'sv03.5', setName: '151'}, {id: 'svp-046', localId: '046', name: 'Pikachu', official: null, setId: 'svp', setName: 'SVP Black Star Promos'}],
	[{id: 'swsh3-102', localId: '102', name: 'Spinarak', official: '189', setId: 'swsh3', setName: 'Darkness Ablaze'}, {id: 'swsh10.5-001', localId: '001', name: 'Spinarak', official: null, setId: 'swsh10.5', setName: 'Pokémon GO'}],
];

async function open() {
	const context = await browser.newContext({deviceScaleFactor: 2.8125, viewport: {height: 780, width: 384}});

	await context.grantPermissions(['camera'], {origin: harness.origin});
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await routeTcgdex(context);
	await context.addInitScript(sceneCamera, {height: 3840, width: 2160});

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(String(err)));

	// The draft tray, written before Scan opens.
	await page.goto(`${harness.origin}${BASE}cards`);
	await page.evaluate(async (lists) => {
		const draft = await import('/pokemon-card-tracker/js/scan/draft.js');
		const S = await import('/pokemon-card-tracker/js/scan/session.js');
		const session = S.newSession();

		lists.forEach((candidates, index) => {
			const item = S.addCapture(session, {id: `look-${index + 1}`});

			Object.assign(item, {
				candidates: candidates.map((c) => ({...c, catalog: 'international', image: null, lang: 'en', reasons: ['picture']})),
				language: 'en',
				languageBy: 'hand',
				status: 'ready',
				why: 'The picture was not clear. Tap the right card.',
			});
		});

		await draft.saveSession(session);
	}, CANDIDATES);
	await page.goto(`${harness.origin}${BASE}scan`);
	await page.waitForSelector('#scan-shutter:not([disabled])', {timeout: 30000});
	await page.waitForFunction(() => /3 to check/.test(document.getElementById('scan-done-open').textContent));

	return {context, errors, page};
}

const runCount = (page) => page.locator('#scan-review-count').textContent();

describe('Review: the cards that need a look, one after another', () => {
	test('settling a card opens the next by itself, Next card skips one, the last brings back Done, and Stop leaves the rest marked', async () => {
		const {context, errors, page} = await open();

		await page.click('#scan-done-open');
		await page.waitForSelector('#scan-done-review');
		await page.click('#scan-done-review');
		await page.waitForSelector('#scan-review-bar');
		assert.equal(await runCount(page), 'Card 1 of 3 to check');
		assert.equal(await page.getAttribute('#scan-review-bar', 'role'), 'group');
		assert.equal(await page.locator('#scan-review-next').textContent(), 'Next card');
		assert.ok((await page.locator('#scan-review-stop').boundingBox()).height >= 44, 'Stop is at least 44 px tall');

		// The right card tapped: the next opens by itself.
		await page.click('#scan-confirm .scan-candidate[data-card="me01-001"]');
		await page.waitForFunction(() => document.getElementById('scan-review-count') && document.getElementById('scan-review-count').textContent === 'Card 2 of 3 to check', null, {timeout: 5000});
		assert.equal(await page.locator('#scan-confirm .scan-candidate[data-card="sv03.5-025"]').count(), 1, 'the second card is open');
		await page.screenshot({path: '/tmp/scan-review-run.png'});

		// Next card: the second is skipped, still needing a look.
		await page.click('#scan-review-next');
		await page.waitForFunction(() => document.getElementById('scan-review-count').textContent === 'Card 3 of 3 to check');
		assert.equal(await page.locator('#scan-review-next').count(), 0, 'the last card has Done, not Next card');

		// The last settled: Done comes back, with the skipped card still to check.
		await page.click('#scan-confirm .scan-candidate[data-card="swsh3-102"]');
		await page.waitForSelector('#scan-done', {timeout: 5000});
		await page.waitForFunction(() => /1 needs a look/.test(document.getElementById('scan-done-look').textContent));
		assert.match(await page.locator('#scan-live').textContent(), /No more cards to check/);

		// Review again: Stop ends it, and the card stays marked in the tray.
		await page.click('#scan-done-review');
		await page.waitForSelector('#scan-review-bar');
		assert.equal(await runCount(page), 'Card 1 of 1 to check');
		await page.click('#scan-review-stop');
		await page.waitForSelector('#scan-sheet-layer', {state: 'hidden'});
		assert.match(await page.locator('#scan-done-open').textContent(), /1 to check/);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('Back closes the sheet and ends the run, and stays on the scanner', async () => {
		const {context, errors, page} = await open();

		await page.click('#scan-done-open');
		await page.click('#scan-done-review');
		await page.waitForSelector('#scan-review-bar');
		await page.click('#scan-confirm .scan-candidate[data-card="me01-001"]');
		await page.waitForFunction(() => document.getElementById('scan-review-count') && document.getElementById('scan-review-count').textContent === 'Card 2 of 3 to check', null, {timeout: 5000});
		await page.goBack();
		await page.waitForSelector('#scan-sheet-layer', {state: 'hidden'});
		assert.ok(new URL(page.url()).pathname.endsWith('/scan'), 'still on the scanner');
		await page.waitForTimeout(1200);
		assert.equal(await page.locator('#scan-confirm').count(), 0, 'no card opens after Back');

		// A tile opened by hand is no run.
		await page.click('#scan-tray [data-item]');
		await page.waitForSelector('#scan-confirm');
		assert.equal(await page.locator('#scan-review-bar').count(), 0);
		assert.deepEqual(errors, []);
		await context.close();
	});
});
