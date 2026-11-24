// Browser tests for the Shop screen (js/shop-view.js, Eric, 2026-11-24):
// opened from Shop on the Spares screen, one row per card and language with
// spares, a price saved on one card, the Priced and Not priced filters,
// Price all shown over a search, Undo, and the price surviving a reload.
// Headless Chromium against tests/pages-server.mjs, signed out, with the
// invented copies of tests/trade-harness.mjs.
//
// Every outside service is faked by tests/my-cards-fixtures.mjs
// fakeServices (TCGdex, frankfurter.dev) and tests/fake-pokeapi.mjs.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/shop-browser.test.mjs
// Screenshots: /tmp/shop-*.png, or under SHOTS when set.

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {BASE, fakeServices, seed} from './my-cards-fixtures.mjs';
import {startPagesServer} from './pages-server.mjs';
import {SPARE_COPIES} from './trade-harness.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const SHOTS = process.env.SHOTS || '/tmp';
const TIMEOUT = {timeout: 20000};
const CHARMANDER_EN = '#shop-international-tsa1-004-en';

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

const plain = (text) => String(text).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

async function phone() {
	const context = await browser.newContext({serviceWorkers: 'block', viewport: {height: 844, width: 390}});

	await fakeServices(context);
	await fakePokeApi(context);

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err.message));
	await seed(page, server.origin, {binders: [], copies: SPARE_COPIES});

	return {context, errors, page};
}

async function openShop(page) {
	await page.goto(`${server.origin}${BASE}trade`);
	await page.locator('#trade-shop').waitFor(TIMEOUT);
	await page.click('#trade-shop');
	await page.waitForFunction(() => document.querySelector('.view-head h2').textContent === 'Shop');
	await page.locator('.shop-row').first().waitFor(TIMEOUT);
}

const summary = async (page) => plain(await page.locator('#shop-summary').textContent());

async function pickShow(page, value) {
	await page.click(`#shop-filter input[value="${value}"] + span`);
}

describe('Shop', () => {
	test('lists each card and language with spares, none priced at first', async () => {
		const {context, errors, page} = await phone();

		await openShop(page);
		assert.equal(new URL(page.url()).pathname, `${BASE}shop`);
		await pickShow(page, 'all');
		assert.equal(await page.locator('.shop-row').count(), 5, 'the five Spares tiles');
		assert.match(await summary(page), /^0 of 5 cards priced, 6 spares in all\.$/);
		assert.match(plain(await page.locator(`${CHARMANDER_EN} .shop-meta`).textContent()), /2 spares$/);
		assert.match(plain(await page.locator(`${CHARMANDER_EN} .shop-state`).textContent()), /^Not priced/);
		assert.equal(await page.locator('.shop-row:has-text("Bulbasaur")').count(), 0, 'one copy is no spare');
		assert.equal(await page.getByText('Ver na Liga').count(), 0, 'no Liga link in the Shop');
		await page.screenshot({fullPage: true, path: `${SHOTS}/shop-list.png`});
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a price saved on one card moves it to Priced, survives a reload, and Undo takes it back', async () => {
		const {context, errors, page} = await phone();

		await openShop(page);
		await pickShow(page, 'all');
		await page.fill(`${CHARMANDER_EN} .shop-price-input`, '2,30');
		await page.click(`${CHARMANDER_EN} .shop-save`);
		await page.waitForFunction((sel) => /For sale at/.test(document.querySelector(`${sel} .shop-state`).textContent), CHARMANDER_EN, TIMEOUT);
		assert.match(plain(await page.locator(`${CHARMANDER_EN} .shop-state`).textContent()), /^For sale at R\$ 2,30 each$/);
		assert.match(await summary(page), /^1 of 5 cards priced, 6 spares in all\. The priced spares come to R\$ 4,60\.$/);

		await pickShow(page, 'unpriced');
		assert.equal(await page.locator(CHARMANDER_EN).count(), 0, 'Not priced hides it');
		await pickShow(page, 'priced');
		assert.equal(await page.locator('.shop-row').count(), 1);

		await page.reload();
		await page.locator('.shop-row').first().waitFor(TIMEOUT);
		assert.match(plain(await page.locator(`${CHARMANDER_EN} .shop-state`).textContent()), /^For sale at R\$ 2,30 each$/, 'kept, and the Priced choice too');
		assert.equal(await page.locator(`${CHARMANDER_EN} .shop-price-input`).inputValue(), '2,30');

		// Clear, then Undo puts the price back.
		await page.click(`${CHARMANDER_EN} .shop-clear`);
		await page.locator('.toast button:has-text("Undo")').waitFor(TIMEOUT);
		assert.equal(await page.locator(CHARMANDER_EN).count(), 0, 'cleared, it leaves Priced');
		await page.click('.toast button:has-text("Undo")');
		await page.locator(CHARMANDER_EN).waitFor(TIMEOUT);
		assert.match(plain(await page.locator(`${CHARMANDER_EN} .shop-state`).textContent()), /^For sale at R\$ 2,30 each$/);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a typing slip is refused in place', async () => {
		const {context, errors, page} = await phone();

		await openShop(page);
		await pickShow(page, 'all');
		await page.fill(`${CHARMANDER_EN} .shop-price-input`, 'abc');
		await page.click(`${CHARMANDER_EN} .shop-save`);
		await page.locator(`${CHARMANDER_EN} .form-error:not([hidden])`).waitFor(TIMEOUT);
		assert.match(await page.locator(`${CHARMANDER_EN} .form-error`).textContent(), /Type the price as 30,50/);
		assert.match(await summary(page), /^0 of 5 cards priced/);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('Price all shown prices every card the search shows, and only those', async () => {
		const {context, errors, page} = await phone();

		await openShop(page);
		await pickShow(page, 'all');
		await page.fill('#shop-search', 'Pikachu');
		await page.waitForFunction(() => document.querySelectorAll('.shop-row').length === 2);
		assert.equal(plain(await page.locator('#shop-bulk-set').textContent()), 'Price all 2 shown');
		await page.fill('#shop-bulk-price', '1');
		await page.click('#shop-bulk-set');
		await page.waitForFunction(() => /^2 of 5 cards priced/.test(document.querySelector('#shop-summary').textContent));

		const states = (await page.locator('.shop-row .shop-state').allTextContents()).map(plain);

		assert.deepEqual(states, ['For sale at R$ 1,00 each', 'For sale at R$ 1,00 each']);
		await page.fill('#shop-search', '');
		await pickShow(page, 'unpriced');
		await page.waitForFunction(() => document.querySelectorAll('.shop-row').length === 3);
		await page.screenshot({fullPage: true, path: `${SHOTS}/shop-bulk.png`});
		assert.deepEqual(errors, []);
		await context.close();
	});
});
