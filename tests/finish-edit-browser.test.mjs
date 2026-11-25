// Browser tests for editing a copy's finish when the catalog does not list it
// (Eric, 2026-11-18: "Sometimes they appear as a certain collection or as
// normal or as 1st edition, but they are normal, or reverse holo, or holo,
// or not 1st edition"; "Sometimes I have a holo and a non holo copy"). The
// copy sheet (js/copy-sheet.js) offers Normal, Holo, and Reverse holo beside
// the catalog's printings, marked "(not listed)", and stores them as an
// unmatched monprice import does (finish_raw, no variant_id). Headless
// Chromium at 360 x 740 against tests/pages-server.mjs, signed out.
//
// Every outside service is faked: TCGdex answers with the invented records
// below, frankfurter.dev with tests/fake-rates.mjs, PokeAPI with
// tests/fake-pokeapi.mjs. Supabase must never be contacted, and
// ligapokemon.com.br is never requested.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/finish-edit-browser.test.mjs
// Screenshots: /tmp/finish-edit-*.png

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {fakeRates} from './fake-rates.mjs';
import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const PHONE = {height: 740, width: 360};

// Invented records. One TCGdex lists only as a 1st Edition holo, as a card
// whose plain print it leaves out; one listed only as a plain Normal.
const SET = {cardCount: {official: 102, total: 102}, id: 'tst2', name: 'Test set tst2'};
const FIRST_ONLY = {
	category: 'Pokemon',
	id: 'tst2-004',
	localId: '004',
	name: 'Test holo',
	set: SET,
	variants_detailed: [{size: 'standard', stamp: ['1st-edition'], type: 'holo', variantId: 'v-first'}],
};
const NORMAL_ONLY = {
	category: 'Pokemon',
	id: 'tst2-050',
	localId: '050',
	name: 'Test common',
	set: SET,
	variants_detailed: [{size: 'standard', type: 'normal', variantId: 'v-normal'}],
};

let server;
let browser;

before(async () => {
	server = await startPagesServer();
	browser = await chromium.launch();
});

after(async () => {
	await browser.close();
	await server.close();
});

const url = (path = '') => `${server.origin}${BASE}${path}`;

async function phone() {
	const context = await browser.newContext({serviceWorkers: 'block', viewport: PHONE});
	const seen = {liga: [], supabase: []};
	const records = {
		[`en/cards/${FIRST_ONLY.id}`]: FIRST_ONLY,
		[`en/cards/${NORMAL_ONLY.id}`]: NORMAL_ONLY,
	};

	await fakeRates(context);
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await context.route(/ligapokemon\.com\.br/, (route) => {
		seen.liga.push(route.request().url());

		return route.abort('blockedbyclient');
	});
	await context.route('https://*.supabase.co/**', (route) => {
		seen.supabase.push(route.request().url());

		return route.abort('blockedbyclient');
	});
	await context.route('https://api.tcgdex.net/**', (route) => {
		const record = records[new URL(route.request().url()).pathname.replace(/^\/v2\//, '')];

		return route.fulfill(record
			? {body: JSON.stringify(record), contentType: 'application/json', status: 200}
			: {body: '{}', contentType: 'application/json', status: 404});
	});
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));
	await fakePokeApi(context, {english: {}});

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err));

	const done = async () => {
		assert.deepEqual(errors.map(String), []);
		assert.deepEqual(await page.locator('#errors .error').allTextContents(), []);
		assert.deepEqual(seen.liga, [], 'Liga Pokémon is never requested');
		assert.deepEqual(seen.supabase, [], 'Supabase is never contacted');
		await context.close();
	};

	await page.goto(url('cards'));
	await page.waitForSelector('#cards-empty');

	return {done, page};
}

const addCard = (page, fields) => page.evaluate(async (card) => (await import('/pokemon-card-tracker/js/collection.js')).addCard(card), fields);

const entries = (page) => page.evaluate(async () => (await import('/pokemon-card-tracker/js/collection.js')).loadDocument().then((doc) => doc.cards.filter((card) => !card.deleted_at)));

const rowTexts = (page) => page.locator('.copies .copy-text').allTextContents();

const rowCounts = (page) => page.locator('.copies .step-count').evaluateAll((inputs) => inputs.map((input) => input.value));

// Nothing in the open sheet runs past the screen's right edge.
const sheetFits = (page) => page.evaluate(() => {
	const sheet = document.querySelector('#copy-sheet');
	const width = document.documentElement.clientWidth;

	return [...sheet.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > width + 0.5).map((el) => el.id || el.className || el.tagName);
});

describe('a finish the catalog does not list', () => {
	test('a copy shown as 1st Edition is set to Holo (not listed), saved on close, and loses its 1st corner and gets HOLO', async () => {
		const {done, page} = await phone();

		// As an import of a monprice 1st Edition row stores it, matched to
		// the card's only printing.
		await addCard(page, {card_id: FIRST_ONLY.id, catalog: 'international', import_key: 'monprice|TS_int_4|en|FIRST_EDITION|0', language: 'en', language_source: 'import', variant_id: 'v-first'});

		// My Cards: the tile's corner says 1st Edition.
		await page.goto(url('cards'));
		await page.waitForSelector('.card-grid .tile');
		assert.equal(await page.locator('.card-grid .tile .badge-finish').getAttribute('aria-label'), '1st Edition');

		await page.goto(url(`cards/en/${FIRST_ONLY.id}`));
		await page.waitForSelector('.copies .copy-row');
		assert.deepEqual(await rowTexts(page), ['Holo, 1st Edition stamp']);

		await page.click('.copies .copy-row');
		await page.waitForSelector('#copy-sheet[open]');
		assert.deepEqual(await page.locator('#copy-finish option').allTextContents(), ['Not set', 'Holo, 1st Edition stamp', 'Normal (not listed)', 'Holo (not listed)', 'Reverse holo (not listed)']);
		assert.equal(await page.locator('#copy-finish').inputValue(), 'v-first');
		assert.equal(await page.locator('#copy-scope-hint').count(), 0, 'one copy: no scope to choose');
		await page.selectOption('#copy-finish', {label: 'Holo (not listed)'});
		await page.screenshot({path: '/tmp/finish-edit-not-listed.png'});

		// Close, not Save: it is kept (v73).
		await page.click('#copy-sheet-close');
		await page.waitForSelector('#copy-sheet', {state: 'hidden'});
		await page.waitForSelector('.copies .copy-text:has-text("Holo (not listed)")');
		assert.deepEqual(await rowTexts(page), ['Holo (not listed)']);
		await page.waitForSelector('.toast:has-text("Copy saved.")');

		const [entry] = await entries(page);

		assert.equal(entry.variant_id, null);
		assert.equal(entry.finish_raw, 'HOLOFOIL');

		// It opens again as Holo (not listed), and a sheet only opened and
		// closed writes nothing.
		await page.click('.copies .copy-row');
		await page.waitForSelector('#copy-sheet[open]');
		assert.equal(await page.locator('#copy-finish option:checked').textContent(), 'Holo (not listed)');
		await page.click('#copy-sheet-close');
		await page.waitForSelector('#copy-sheet', {state: 'hidden'});
		assert.equal((await entries(page))[0].updated_at, entry.updated_at);

		// My Cards: no 1st corner. A holo gets its own, HOLO (Eric,
		// 2026-11-24).
		await page.goto(url('cards'));
		await page.waitForSelector('.card-grid .tile');
		assert.equal(await page.locator('.card-grid .tile .badge-finish').count(), 1);
		assert.equal(await page.locator('.card-grid .tile .badge-finish').textContent(), 'HOLO');
		assert.equal(await page.locator('.card-grid .tile .badge-finish').getAttribute('aria-label'), 'Holo');

		// Back to the catalog's printing: the word goes.
		await page.goto(url(`cards/en/${FIRST_ONLY.id}`));
		await page.click('.copies .copy-row');
		await page.waitForSelector('#copy-sheet[open]');
		await page.selectOption('#copy-finish', 'v-first');
		await page.click('#copy-save');
		await page.waitForSelector('.copies .copy-text:text-is("Holo, 1st Edition stamp")');

		const [back] = await entries(page);

		assert.equal(back.variant_id, 'v-first');
		assert.equal(back.finish_raw, null);
		await done();
	});

	test('Add a copy offers the finishes not listed too', async () => {
		const {done, page} = await phone();

		await page.goto(url(`cards/en/${FIRST_ONLY.id}`));
		await page.waitForSelector('#copy-add');
		await page.click('#copy-add');
		await page.waitForSelector('#copy-sheet[open]');
		await page.selectOption('#copy-finish', {label: 'Normal (not listed)'});
		await page.click('#copy-add-save');
		await page.waitForSelector('.copies .copy-text:has-text("Normal (not listed)")');

		const [entry] = await entries(page);

		assert.equal(entry.variant_id, null);
		assert.equal(entry.finish_raw, 'NORMAL');
		await done();
	});

	test('of two alike copies, one is set to Holo and the other stays Normal, as two rows', async () => {
		const {done, page} = await phone();

		for (let i = 0; i < 2; i++) {
			await addCard(page, {card_id: NORMAL_ONLY.id, catalog: 'international', language: 'en', language_source: 'scan', variant_id: 'v-normal'});
		}

		await page.goto(url(`cards/en/${NORMAL_ONLY.id}`));
		await page.waitForSelector('.copies .copy-row');
		assert.deepEqual(await rowTexts(page), ['Normal']);
		assert.deepEqual(await rowCounts(page), ['2']);

		await page.click('.copies .copy-row');
		await page.waitForSelector('#copy-sheet[open]');
		assert.equal(await page.locator('#copy-sheet-title').textContent(), 'Edit copies (2 alike)');

		// The scope comes first, named and explained, on This copy.
		const scope = page.getByRole('radiogroup', {name: 'Change'});

		assert.equal(await scope.getAttribute('aria-describedby'), 'copy-scope-hint');
		assert.equal(await page.locator('#copy-scope-hint').textContent(), 'Change one copy to give it its own finish. It then shows as its own row.');
		assert.ok(await page.locator('#copy-scope-hint').isVisible());
		assert.equal(await page.locator('input[name="copy-scope"]:checked').getAttribute('value'), 'one');

		const above = await page.evaluate(() => document.querySelector('.copy-scope').getBoundingClientRect().bottom <= document.querySelector('#copy-language').getBoundingClientRect().top);

		assert.ok(above, 'the scope sits above the fields');
		assert.deepEqual(await sheetFits(page), [], 'nothing runs off a 360 px screen');

		// Larger system text: the hint wraps rather than running off.
		await page.evaluate(() => document.documentElement.style.setProperty('font-size', '150%'));
		assert.deepEqual(await sheetFits(page), [], 'nothing runs off with larger text');
		await page.screenshot({path: '/tmp/finish-edit-scope.png'});
		await page.evaluate(() => document.documentElement.style.removeProperty('font-size'));

		await page.selectOption('#copy-finish', {label: 'Holo (not listed)'});
		await page.click('#copy-sheet-close');
		await page.waitForFunction(() => document.querySelectorAll('.copies .copy-row').length === 2);
		assert.deepEqual((await rowTexts(page)).sort(), ['Holo (not listed)', 'Normal']);
		assert.deepEqual(await rowCounts(page), ['1', '1']);

		const saved = await entries(page);

		assert.deepEqual(saved.map((entry) => [entry.variant_id, entry.finish_raw || null]).sort(), [[null, 'HOLOFOIL'], ['v-normal', null]]);
		await done();
	});
});
