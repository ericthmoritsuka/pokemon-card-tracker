// Browser tests for the Shop screen (js/shop-view.js, Eric, 2026-11-24):
// opened by its address (the header's Shop is the family owner's), one row per finish of a card
// and language with spares, each with its own price (Eric, 2026-11-24), prices typed as drafts and saved together from the bar above the
// tabs (Eric: "enter the prices and press save at the end"), drafts that
// survive a search and a trip away, Enter to the next field, Discard, a
// typing slip that stops the save, Fill all shown, Undo, and the prices
// surviving a reload. Headless Chromium against tests/pages-server.mjs,
// signed out, with the invented copies of tests/trade-harness.mjs.
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
const CHARIZARD = '#shop-international-tsa1-006-en';
// Charmander EN's spares are c-04, with no finish set, and c-03, a Reverse
// holo: two rows, two prices.
const CHARMANDER_EN_REVERSE = '#shop-international-tsa1-004-en-raw-Reverse-Holofoil';

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

async function phone(copies = SPARE_COPIES) {
	const context = await browser.newContext({serviceWorkers: 'block', viewport: {height: 844, width: 390}});

	await fakeServices(context);
	await fakePokeApi(context);

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err.message));
	await seed(page, server.origin, {binders: [], copies});

	return {context, errors, page};
}

// Signed out, as here, the header shows no Shop (it is the family owner's,
// tests/shop-owner-browser.test.mjs), so the address opens it.
async function openShop(page) {
	await page.goto(`${server.origin}${BASE}shop`);
	await page.waitForFunction(() => document.querySelector('.view-head h2').textContent === 'Shop');
	await page.locator('.shop-row').first().waitFor(TIMEOUT);
}

const summary = async (page) => plain(await page.locator('#shop-summary').textContent());

const state = async (page, row) => plain(await page.locator(`${row} .shop-state`).textContent());

async function pickShow(page, value) {
	await page.click(`#shop-filter input[value="${value}"] + span`);
}

async function type(page, row, text) {
	await page.fill(`${row} .shop-price-input`, text);
}

async function saveAll(page) {
	await page.click('#shop-save-all');
	await page.locator('#shop-savebar').waitFor({state: 'hidden', ...TIMEOUT});
}

describe('Shop', () => {
	test('lists each finish of a card and language with spares, none priced at first, and no bar', async () => {
		const {context, errors, page} = await phone();

		await openShop(page);
		assert.equal(new URL(page.url()).pathname, `${BASE}shop`);
		await pickShow(page, 'all');
		assert.equal(await page.locator('.shop-row').count(), 6, 'the five Spares tiles, Charmander EN split by finish');
		assert.match(await summary(page), /^0 of 6 cards priced, 6 spares in all\.$/);
		assert.match(plain(await page.locator(`${CHARMANDER_EN} .shop-meta`).textContent()), /1 spare$/);
		assert.match(plain(await page.locator(`${CHARMANDER_EN_REVERSE} .shop-meta`).textContent()), /1 spare$/);
		assert.equal(plain(await page.locator(`${CHARMANDER_EN} .shop-finish`).textContent()), 'Normal');
		assert.equal(plain(await page.locator(`${CHARMANDER_EN_REVERSE} .shop-finish`).textContent()), 'Reverse Holofoil', 'named by its word, not the card\'s only printing');
		assert.equal(await page.getAttribute(`${CHARMANDER_EN_REVERSE} .shop-price-input`, 'aria-label'), 'Sale price for Charmander, Reverse Holofoil');
		assert.match(await state(page, CHARMANDER_EN), /^Not priced/);
		assert.equal(await page.locator('.shop-row:has-text("Bulbasaur")').count(), 0, 'one copy is no spare');
		assert.equal(await page.getByText('Ver na Liga').count(), 0, 'no Liga link in the Shop');
		assert.equal(await page.locator('.shop-save').count(), 0, 'no Save on each row');
		assert.ok(await page.locator('#shop-savebar').isHidden(), 'nothing typed, no bar');
		await page.screenshot({fullPage: true, path: `${SHOTS}/shop-list.png`});
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('several prices typed are saved together, survive a search and a reload, and Undo takes them all back', async () => {
		const {context, errors, page} = await phone();

		await openShop(page);
		await pickShow(page, 'all');
		await type(page, CHARMANDER_EN, '2,30');
		assert.equal(plain(await page.locator('#shop-save-all').textContent()), 'Save 1 price');
		assert.match(await state(page, CHARMANDER_EN), /^Not priced/, 'typing saves nothing');
		assert.ok(await page.locator(`${CHARMANDER_EN} .shop-draft`).isVisible());

		// Enter moves on to the next card's field.
		await page.press(`${CHARMANDER_EN} .shop-price-input`, 'Enter');
		assert.equal(await page.evaluate(() => document.activeElement.closest('.shop-row').id), 'shop-international-tsa1-004-en-raw-Reverse-Holofoil', 'the same card\'s next finish');

		await type(page, CHARIZARD, '150');
		assert.equal(plain(await page.locator('#shop-save-all').textContent()), 'Save 2 prices');

		// A search redraws the rows; the drafts stay.
		await page.fill('#shop-search', 'Pikachu');
		await page.waitForFunction(() => document.querySelectorAll('.shop-row').length === 2);
		assert.equal(plain(await page.locator('#shop-save-all').textContent()), 'Save 2 prices');
		await page.fill('#shop-search', '');
		await page.waitForFunction(() => document.querySelectorAll('.shop-row').length === 6);
		assert.equal(await page.locator(`${CHARIZARD} .shop-price-input`).inputValue(), '150');
		await page.screenshot({fullPage: true, path: `${SHOTS}/shop-drafts.png`});

		await saveAll(page);
		assert.match(await state(page, CHARMANDER_EN), /^For sale at R\$ 2,30 each$/);
		assert.match(await state(page, CHARIZARD), /^For sale at R\$ 150,00 each$/);
		assert.match(await summary(page), /^2 of 6 cards priced, 6 spares in all\. The priced spares come to R\$ 152,30\.$/);
		assert.match(await state(page, CHARMANDER_EN_REVERSE), /^Not priced/, 'the other finish keeps its own price');
		await page.locator('.toast:has-text("2 prices saved.")').waitFor(TIMEOUT);

		await page.reload();
		await page.locator('.shop-row').first().waitFor(TIMEOUT);
		await pickShow(page, 'priced');
		assert.equal(await page.locator('.shop-row').count(), 2);
		assert.equal(await page.locator(`${CHARMANDER_EN} .shop-price-input`).inputValue(), '2,30');

		// Clear one, change the other, save, then Undo both.
		await page.click(`${CHARMANDER_EN} .shop-clear`);
		await type(page, CHARIZARD, '120');
		await saveAll(page);
		await page.locator('.toast button:has-text("Undo")').waitFor(TIMEOUT);
		assert.equal(await page.locator(CHARMANDER_EN).count(), 0, 'cleared, it leaves Priced');
		assert.match(await state(page, CHARIZARD), /^For sale at R\$ 120,00 each$/);
		await page.click('.toast button:has-text("Undo")');
		await page.locator(CHARMANDER_EN).waitFor(TIMEOUT);
		assert.match(await state(page, CHARMANDER_EN), /^For sale at R\$ 2,30 each$/);
		assert.match(await state(page, CHARIZARD), /^For sale at R\$ 150,00 each$/);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('drafts come back after leaving the screen, and Discard drops them', async () => {
		const {context, errors, page} = await phone();

		await openShop(page);
		await pickShow(page, 'all');
		await type(page, CHARMANDER_EN, '3');
		await page.click('.tabs a[data-tab="cards"]');
		await page.locator('#view .view-head h2').filter({hasText: 'My Cards'}).waitFor(TIMEOUT);
		await page.goBack();
		await page.locator('.shop-row').first().waitFor(TIMEOUT);
		assert.equal(await page.locator(`${CHARMANDER_EN} .shop-price-input`).inputValue(), '3');
		assert.equal(plain(await page.locator('#shop-save-all').textContent()), 'Save 1 price');

		await page.click('#shop-discard');
		assert.ok(await page.locator('#shop-savebar').isHidden());
		assert.equal(await page.locator(`${CHARMANDER_EN} .shop-price-input`).inputValue(), '');
		assert.match(await summary(page), /^0 of 6 cards priced/);

		// Typing the saved value back is no change.
		await type(page, CHARMANDER_EN, '1');
		await type(page, CHARMANDER_EN, '');
		assert.ok(await page.locator('#shop-savebar').isHidden());
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a typing slip stops the whole save and says where', async () => {
		const {context, errors, page} = await phone();

		await openShop(page);
		await pickShow(page, 'all');
		await type(page, CHARMANDER_EN, 'abc');
		await type(page, CHARIZARD, '10');
		await page.click('#shop-save-all');
		await page.locator(`${CHARMANDER_EN} .form-error:not([hidden])`).waitFor(TIMEOUT);
		assert.match(await page.locator(`${CHARMANDER_EN} .form-error`).textContent(), /Type the price as 30,50/);
		assert.match(plain(await page.locator('#shop-save-status').textContent()), /^1 price needs fixing first\. Nothing was saved\.$/);
		assert.equal(await page.evaluate(() => document.activeElement.closest('.shop-row').id), 'shop-international-tsa1-004-en');
		assert.match(await summary(page), /^0 of 6 cards priced/, 'Charizard was not saved either');

		await type(page, CHARMANDER_EN, '2');
		await saveAll(page);
		assert.match(await summary(page), /^2 of 6 cards priced/);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('saving again replaces the Shop\'s toast, and no screen shows more than three toasts', async () => {
		const {context, errors, page} = await phone();

		await openShop(page);
		await pickShow(page, 'all');
		await type(page, CHARMANDER_EN, '2');
		await saveAll(page);
		await page.locator('.toast:has-text("1 price saved.")').waitFor(TIMEOUT);
		await type(page, CHARIZARD, '9');
		await saveAll(page);
		await page.waitForFunction(() => [...document.querySelectorAll('.toast')].map((toast) => toast.querySelector('.toast-text').textContent).join('|') === '1 price saved.' && document.querySelectorAll('.toast').length === 1);
		assert.match(await state(page, CHARIZARD), /^For sale at R\$ 9,00 each$/, 'the second save is the one shown');

		// Any five toasts at once leave the latest three.
		const texts = await page.evaluate(async () => {
			const shell = await import('/pokemon-card-tracker/js/shell.js');

			for (const n of [1, 2, 3, 4, 5]) {
				shell.toast(`Toast ${n}`, {timeout: 0});
			}

			return [...document.querySelectorAll('.toast .toast-text')].map((node) => node.textContent);
		});

		assert.deepEqual(texts, ['Toast 3', 'Toast 4', 'Toast 5']);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('ticked cards share one price, ticks survive a search, and the other cards stay as they were', async () => {
		const {context, errors, page} = await phone();
		const PIKACHU = '#shop-international-tsb2-025-en';

		await openShop(page);
		await pickShow(page, 'all');
		await page.check(`${CHARMANDER_EN} .shop-pick`);
		assert.equal(plain(await page.locator('#shop-bulk-set').textContent()), 'Fill 1 selected');
		await page.fill('#shop-search', 'Pikachu');
		await page.waitForFunction(() => document.querySelectorAll('.shop-row').length === 2);
		await page.check(`${PIKACHU} .shop-pick`);
		assert.equal(plain(await page.locator('#shop-bulk-set').textContent()), 'Fill 2 selected', 'the hidden Charmander stays ticked');
		await page.fill('#shop-search', '');
		await page.waitForFunction(() => document.querySelectorAll('.shop-row').length === 6);
		assert.ok(await page.locator(`${CHARMANDER_EN} .shop-pick`).isChecked());
		await page.screenshot({fullPage: true, path: `${SHOTS}/shop-selected.png`});
		await page.fill('#shop-bulk-price', '3');
		await page.click('#shop-bulk-set');

		const fields = await page.locator('.shop-row').evaluateAll((rows) => Object.fromEntries(rows.map((row) => [row.id, row.querySelector('.shop-price-input').value])));

		assert.equal(fields['shop-international-tsa1-004-en'], '3,00');
		assert.equal(fields['shop-international-tsb2-025-en'], '3,00');
		assert.equal(Object.values(fields).filter((value) => value).length, 2, 'only the ticked cards');
		assert.equal(await page.locator('.shop-pick:checked').count(), 0, 'the ticks are cleared after filling');
		assert.equal(plain(await page.locator('#shop-bulk-set').textContent()), 'Fill all 6 shown');
		await saveAll(page);
		assert.match(await summary(page), /^2 of 6 cards priced/);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('Fill all shown types one price into every card the search shows, saved with the bar', async () => {
		const {context, errors, page} = await phone();

		await openShop(page);
		await pickShow(page, 'all');
		await page.fill('#shop-search', 'Pikachu');
		await page.waitForFunction(() => document.querySelectorAll('.shop-row').length === 2);
		assert.equal(plain(await page.locator('#shop-bulk-set').textContent()), 'Fill all 2 shown');
		await page.fill('#shop-bulk-price', '1');
		await page.click('#shop-bulk-set');
		assert.deepEqual(await page.locator('.shop-row .shop-price-input').evaluateAll((inputs) => inputs.map((input) => input.value)), ['1,00', '1,00']);
		assert.match(await summary(page), /^0 of 6 cards priced/, 'filled, not saved');
		assert.equal(plain(await page.locator('#shop-save-all').textContent()), 'Save 2 prices');
		await saveAll(page);

		const states = (await page.locator('.shop-row .shop-state').allTextContents()).map(plain);

		assert.deepEqual(states, ['For sale at R$ 1,00 each', 'For sale at R$ 1,00 each']);
		await page.fill('#shop-search', '');
		await pickShow(page, 'unpriced');
		await page.waitForFunction(() => document.querySelectorAll('.shop-row').length === 4);
		await page.screenshot({fullPage: true, path: `${SHOTS}/shop-bulk.png`});
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a hand-made copy of a catalog card counts with it, and a card with no picture offers one', async () => {
		const hand = (id, fields) => ({
			card_id: 'hand_0123456789abcdef0123456789abcdef', catalog: 'custom', created_at: `2026-09-${id.slice(2)}T12:00:00.000Z`, deleted_at: null,
			id, language: 'en', language_source: 'manual', name_local: 'Homemade Mon', number_local: '7', set_code: 'XYZ', set_name_local: 'Nowhere', updated_at: `2026-09-${id.slice(2)}T12:00:00.000Z`, variant_id: null, ...fields,
		});
		// Bulbasaur's one catalog copy and one added by hand before the
		// catalog listed it (set code tsa1, number 001): one spare. The
		// hand-made Homemade Mon, two copies, no catalog picture.
		const copies = [
			...SPARE_COPIES,
			hand('h-20', {card_id: 'hand_fedcba9876543210fedcba9876543210', name_local: 'Bulbasaur', number_local: '1', set_code: 'tsa1'}),
			hand('h-21'),
			hand('h-22'),
		];
		const {context, errors, page} = await phone(copies);

		await openShop(page);
		await pickShow(page, 'all');
		assert.equal(await page.locator('.shop-row').count(), 8, 'the six rows, Bulbasaur, and Homemade Mon');
		assert.equal(await page.locator('#shop-international-tsa1-001-en').count(), 1, 'Bulbasaur has a spare now');
		assert.match(plain(await page.locator('#shop-international-tsa1-001-en .shop-meta').textContent()), /1 spare$/);

		const homemade = page.locator('.shop-row:has-text("Homemade Mon")');

		assert.equal(await homemade.locator('.shop-add-picture').count(), 1, 'no picture: Add a listing picture');
		assert.deepEqual(errors, []);
		await context.close();
	});
});
