// The valuable card highlight and the rising price mark (Eric, 2026-10-15,
// js/scan/worth.js), in headless Chromium at 384 px against
// tests/scan-harness.mjs.
//
// The camera is tests/scan-scene.mjs's canvas, Bulbasaur (me01-001) held to
// the guide. Its TCGdex record is replayed from the harness cache with made
// up prices (a normal print at US$ 3, its Cardmarket price up 20 % on its 30
// day average; a reverse holo at US$ 20), and the dollar and euro rates are
// saved on the phone (R$ 5 and R$ 6), so frankfurter.dev is never asked
// (any request to it fails). Supabase is never reached.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/scan-worth-browser.test.mjs

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {after, before, describe, test} from 'node:test';

import {CACHE_DIR, cardImage, routeTcgdex, startScanHarness} from './scan-harness.mjs';
import {sceneCamera} from './scan-scene.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const CARD = 'me01-001';
const NORMAL = 'endfynwn4n10gzq';
const REVERSE = 'cm4kqul3x1bwlz1f';
const FRAME = {height: 3840, width: 2160};
const SHOTS = process.env.SHOTS || '/tmp';
const VALUABLE_BUZZ = [40, 60, 40, 60, 40];

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

// The harness cache's file for a TCGdex URL (scan-harness.mjs safeName).
const cacheFile = (url) => join(CACHE_DIR, 'tcgdex', url.replace(/^https:\/\//, '').replace(/[^a-zA-Z0-9.-]+/g, '_').slice(0, 180));

const PRICING = {
	cardmarket: {avg30: 2, 'avg30-holo': 15, avg7: 2.4, 'avg7-holo': 15, idProduct: 1, trend: 2, 'trend-holo': 15, unit: 'EUR', updated: '2026-10-14T00:00:00.000Z'},
	tcgplayer: {normal: {marketPrice: 3, productId: 9}, 'reverse-holofoil': {marketPrice: 20, productId: 9}, unit: 'USD', updated: '2026-10-14T00:00:00.000Z'},
};

// Bulbasaur's record with the made-up prices on every printing.
async function pricedRecord(url) {
	const file = cacheFile(url);
	let record;

	try {
		record = JSON.parse(await readFile(file, 'utf8'));
	}
	catch {
		// Not in the cache yet: a record with its two printings alone.
		record = {category: 'Pokemon', id: CARD, localId: '001', name: 'Bulbasaur', set: {id: 'me01', name: 'Mega Evolution'}, variants_detailed: [{size: 'standard', type: 'normal', variantId: NORMAL}, {size: 'standard', type: 'reverse', variantId: REVERSE}]};
	}

	record.pricing = PRICING;
	record.variants_detailed = (record.variants_detailed || []).map((variant) => ({...variant, pricing: PRICING}));

	return record;
}

async function open({finish = 'normal', hold = null, record = true, settings = {}} = {}) {
	const context = await browser.newContext({deviceScaleFactor: 2.8125, viewport: {height: 900, width: 384}});

	await context.grantPermissions(['camera'], {origin: harness.origin});
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await context.route('https://*.supabase.co/**', (route) => route.abort());
	await context.route('https://api.frankfurter.dev/**', (route) => route.abort());
	await routeTcgdex(context);
	// After routeTcgdex, so it answers first: Bulbasaur's record, priced,
	// held back until `hold` resolves when one is given.
	await context.route(/^https:\/\/api\.tcgdex\.net\/v2\/[a-z-]+\/cards\/me01-001$/, async (route) => {
		const body = JSON.stringify(await pricedRecord(route.request().url()));

		if (hold) {
			await hold;
		}

		await route.fulfill({body, contentType: 'application/json', headers: {'access-control-allow-origin': '*'}}).catch(() => {});
	});

	for (const name of ['', '-b', '-c']) {
		await context.route(`**/__test-card${name}.webp`, async (route) => route.fulfill({contentType: 'image/webp', path: await cardImage(CARD)}));
	}

	await context.addInitScript(() => sessionStorage.setItem('test-scene', JSON.stringify({background: 'table', cards: []})));
	await context.addInitScript(sceneCamera, FRAME);
	await context.addInitScript(({finish: chosen, log, set}) => {
		const now = Date.now();
		const day = new Date(now).toISOString().slice(0, 10);

		localStorage.setItem('card-tracker:scan-holder', 'off');
		localStorage.setItem('card-tracker:scan-finish', chosen);
		localStorage.setItem('cardTracker.rates', JSON.stringify({brlPerUsd: 5, date: day, fetchedAt: now}));
		localStorage.setItem('cardTracker.rates.eur', JSON.stringify({brlPerEur: 6, date: day, fetchedAt: now}));

		if (log) {
			localStorage.setItem('card-tracker:scan-log', 'on');
		}

		for (const [key, value] of Object.entries(set)) {
			if (localStorage.getItem(key) === null) {
				localStorage.setItem(key, value);
			}
		}
	}, {finish, log: record, set: settings});

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(String(err)));
	await page.goto(`${harness.origin}${BASE}scan`);
	await page.waitForSelector('#scan-guide:not([hidden])', {timeout: 30000});
	await page.waitForFunction(() => document.getElementById('scan-video').videoWidth > 0);

	return {context, errors, page};
}

// Holds the card to the guide; auto capture takes it.
const showCard = (page) => page.evaluate(() => {
	window.scene = {background: 'table', cards: [{angle: 0.6, card: 'a', size: 0.95}]};
});

const tile = (page) => page.$eval('#scan-tray li:last-child .scan-tile', (el) => ({
	label: el.getAttribute('aria-label'),
	rising: (el.querySelector('.scan-tile-rising') || {}).textContent || null,
	star: (el.querySelector('.scan-tile-star') || {}).textContent || null,
	status: el.dataset.status,
	valuable: el.classList.contains('is-valuable'),
}));

const prized = (page) => page.evaluate(async () => (await import('/pokemon-card-tracker/js/scan/view.js')).scanStats.prized.length);

const buzzCount = (page, pattern) => page.evaluate((wanted) => window.buzzes.filter((one) => JSON.stringify(one) === JSON.stringify(wanted)).length, pattern);

async function until(check, what, timeout = 60000) {
	const end = Date.now() + timeout;

	while (!(await check())) {
		assert.ok(Date.now() < end, what);
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
}

const space = (text) => String(text).replace(/ /g, ' ');

describe('valuable cards and rising prices in Scan', () => {
	test('a reverse holo worth R$ 100: a gold rim and a star, a gold flash, three short buzzes once, and the scan log keeps it', async () => {
		const {context, errors, page} = await open({finish: 'reverse'});

		await showCard(page);
		await until(async () => (await page.locator('#scan-tray .scan-tile').count()) === 1 && (await tile(page)).valuable, 'the card valuable in the tray');

		const shown = await tile(page);

		assert.equal(space(shown.star), '★ R$ 100,00');
		assert.match(space(shown.label), /valuable, worth about R\$ 100,00/);
		assert.equal(shown.rising, null, 'the reverse holo\'s price is steady');
		await page.waitForTimeout(1500);
		assert.equal(await prized(page), 1);
		assert.equal(await buzzCount(page, VALUABLE_BUZZ), 1, 'the valuable buzz, once');
		assert.ok(await buzzCount(page, 40) <= 1, 'the plain answer buzz at most once before the price came');
		await page.screenshot({path: `${SHOTS}/scan-valuable-tray.png`});

		await page.click('#scan-tray li:last-child .scan-tile');
		await page.waitForSelector('#scan-worth-line');
		assert.equal(space(await page.locator('#scan-worth-line').textContent()), '★ Worth about R$ 100,00 (TCGplayer market). Valuable: at or above your R$ 50,00 mark.');
		await page.screenshot({path: `${SHOTS}/scan-valuable-sheet.png`});

		// The card sheet's finish changes the worth: the normal print is
		// R$ 15, not valuable, and its Cardmarket price is up 20 %.
		await page.click(`#scan-finish-${NORMAL}`);
		await until(async () => (await page.locator('#scan-rising-line').count()) === 1, 'the rising line');
		assert.equal(await page.locator('#scan-rising-line').textContent(), '▲ Up 20% in 30 days (Cardmarket).');
		assert.equal(space(await page.locator('#scan-worth-line').textContent()), 'Worth about R$ 15,00 (TCGplayer market).');
		await page.click('#scan-sheet-close');

		const after = await tile(page);

		assert.equal(after.valuable, false);
		assert.equal(after.rising, '▲20%');
		assert.match(after.label, /price up 20% in 30 days/);
		assert.equal(await buzzCount(page, VALUABLE_BUZZ), 1, 'no buzz for a change by hand');

		const [entry] = await page.evaluate(async () => (await import('/pokemon-card-tracker/js/scan/log.js')).listEntries());

		assert.equal(entry.first.worth.valuable, true, 'the scanner\'s own answer was valuable');
		assert.equal(entry.first.worth.brl, 100);
		assert.equal(entry.first.worth.min, 50);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a price that comes after the answer: the plain buzz, then the valuable one, never twice', async () => {
		let release;
		const hold = new Promise((resolve) => {
			release = resolve;
		});
		const {context, errors, page} = await open({finish: 'reverse', hold});

		await showCard(page);
		await until(async () => (await page.locator('#scan-tray .scan-tile').count()) === 1, 'the card in the tray');
		await until(async () => (await buzzCount(page, 40)) === 1, 'the plain answer buzz');
		assert.equal(await prized(page), 0, 'no price yet');

		release();
		await until(async () => (await tile(page)).valuable, 'valuable once its price came');
		await page.waitForTimeout(1000);
		assert.equal(await buzzCount(page, VALUABLE_BUZZ), 1);
		assert.equal(await prized(page), 1);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('the settings: the threshold, off, the rise, and the chime, remembered; a change tells nothing', async () => {
		const {context, errors, page} = await open({finish: 'normal'});

		await showCard(page);
		await until(async () => (await page.locator('#scan-tray .scan-tile').count()) === 1 && (await tile(page)).rising !== null, 'the card with its rising mark');
		assert.equal((await tile(page)).valuable, false, 'R$ 15 is under R$ 50');

		await page.click('#scan-settings-open');
		await page.waitForSelector('#scan-settings');
		assert.equal(await page.getAttribute('#scan-worth-on', 'aria-checked'), 'true');
		assert.equal(await page.getAttribute('#scan-worth-on', 'role'), 'switch');
		assert.equal(await page.inputValue('#scan-worth-min'), '50');
		assert.equal(await page.inputValue('#scan-worth-rise'), '15');
		assert.equal(await page.getAttribute('#scan-chime', 'aria-checked'), 'false', 'no chime at first');
		await page.screenshot({path: `${SHOTS}/scan-settings.png`});

		await page.fill('#scan-worth-min', '10');
		await page.press('#scan-worth-min', 'Enter');
		await page.locator('#scan-worth-min').evaluate((input) => input.dispatchEvent(new Event('change')));
		await until(async () => (await tile(page)).valuable, 'valuable from R$ 10');
		assert.equal(await prized(page), 0, 'a settings change tells nothing');

		await page.fill('#scan-worth-rise', '25');
		await page.locator('#scan-worth-rise').evaluate((input) => input.dispatchEvent(new Event('change')));
		await until(async () => (await tile(page)).rising === null, 'no rising mark past 25 %');

		await page.click('#scan-worth-on');
		await until(async () => !(await tile(page)).valuable, 'the highlight off');
		assert.equal(await page.isDisabled('#scan-worth-min'), true);
		await page.click('#scan-chime');
		assert.equal(await page.getAttribute('#scan-chime', 'aria-checked'), 'true');

		// Remembered: the highlight off, 25 %, the chime on; switching the
		// highlight on brings back R$ 10.
		await page.reload();
		await page.waitForSelector('#scan-settings-open');
		await page.click('#scan-settings-open');
		await page.waitForSelector('#scan-settings');
		assert.equal(await page.getAttribute('#scan-worth-on', 'aria-checked'), 'false');
		assert.equal(await page.inputValue('#scan-worth-rise'), '25');
		assert.equal(await page.getAttribute('#scan-chime', 'aria-checked'), 'true');
		await page.click('#scan-worth-on');
		assert.equal(await page.getAttribute('#scan-worth-on', 'aria-checked'), 'true');
		assert.equal(await page.evaluate(() => localStorage.getItem('card-tracker:scan-worth-min')), '50', 'off, then on: the default again after a reload');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('the card page says a rising price in words, in light and dark', async () => {
		for (const scheme of ['light', 'dark']) {
			const context = await browser.newContext({colorScheme: scheme, viewport: {height: 740, width: 360}});

			await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
			await context.route('https://*.supabase.co/**', (route) => route.abort());
			await context.route('https://api.frankfurter.dev/**', (route) => route.abort());
			await context.route('https://api.tcgdex.net/**', (route) => route.abort());

			const page = await context.newPage();
			const errors = [];

			page.on('pageerror', (err) => errors.push(String(err)));
			await page.goto(`${harness.origin}${BASE}cards`);
			await page.evaluate(async ({pricing, variantId}) => {
				const {priceSection} = await import('/pokemon-card-tracker/js/price-view.js');
				const card = {id: 'me01-001', name: 'Bulbasaur', variants_detailed: [{pricing, size: 'standard', type: 'normal', variantId}]};
				const section = priceSection({card, eurRates: {brlPerEur: 6, date: '2026-10-15'}, ligaHref: null, rates: {brlPerUsd: 5, date: '2026-10-15'}});
				const main = document.querySelector('main') || document.body;

				main.replaceChildren(section);
			}, {pricing: PRICING, variantId: NORMAL});
			await page.waitForSelector('.price-rising');
			assert.equal(await page.locator('.price-rising').textContent(), '▲ Up 20% in 30 days (Cardmarket)');

			const colours = await page.$eval('.price-rising', (el) => [getComputedStyle(el).color, getComputedStyle(document.body).backgroundColor]);

			assert.notEqual(colours[0], colours[1]);
			await page.screenshot({path: `${SHOTS}/price-rising-${scheme}.png`});
			assert.deepEqual(errors, []);
			await context.close();
		}
	});
});
