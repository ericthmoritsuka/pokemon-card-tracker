// Browser tests for Add to binder on card detail (js/binder-hand.js, with
// the card in hand drawn by js/binders-view.js): the button beside Add to
// collection, the sheet of hand-made binders, placing in a tapped pocket,
// Next free pocket, Keep in tray, the placeholder waiting for the card, Undo
// on each, Cancel and Back leaving the card behind, and the sheet once every
// copy is in a pocket. Headless Chromium against tests/pages-server.mjs,
// signed out, on a wide screen where the pages take a tap directly.
//
// Every outside service is faked: TCGdex answers with the record saved in
// tests/prices-fixtures, frankfurter.dev with a fixed rate, PokeAPI with
// tests/fake-pokeapi.mjs. Supabase must never be contacted, and
// ligapokemon.com.br is never requested. Binders and copies are invented.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/add-to-binder-browser.test.mjs
// Screenshots: /tmp/add-to-binder-*.png

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const WIDE = {height: 900, width: 1100};
const RATE = [{base: 'USD', date: '2026-10-01', quote: 'BRL', rate: 5.1877}];
const OTHER = {category: 'Pokemon', id: 'tst9-002', localId: '002', name: 'Testmon', set: {cardCount: {official: 90, total: 99}, id: 'tst9', name: 'Test set nine'}, variants_detailed: []};

let server;
let browser;
let en;

before(async () => {
	server = await startPagesServer();
	browser = await chromium.launch();
	en = JSON.parse(await readFile(new URL('./prices-fixtures/en-sv08.5-001.json', import.meta.url), 'utf8'));
});

after(async () => {
	await browser.close();
	await server.close();
});

const url = (path = '') => `${server.origin}${BASE}${path}`;

async function open() {
	const context = await browser.newContext({serviceWorkers: 'block', viewport: WIDE});
	const seen = {liga: [], supabase: []};
	const records = {'en/cards/sv08.5-001': en, 'en/cards/tst9-002': OTHER};

	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await context.route(/ligapokemon\.com\.br/, (route) => {
		seen.liga.push(route.request().url());

		return route.abort('blockedbyclient');
	});
	await context.route('https://*.supabase.co/**', (route) => {
		seen.supabase.push(route.request().url());

		return route.abort('blockedbyclient');
	});
	await context.route('https://api.frankfurter.dev/**', (route) => route.fulfill({
		body: JSON.stringify(RATE),
		contentType: 'application/json',
		headers: {'Access-Control-Allow-Origin': '*'},
		status: 200,
	}));
	await context.route('https://api.tcgdex.net/**', (route) => {
		const record = records[new URL(route.request().url()).pathname.replace(/^\/v2\//, '')];

		return route.fulfill(record
			? {body: JSON.stringify(record), contentType: 'application/json', status: 200}
			: {body: '{}', contentType: 'application/json', status: 404});
	});
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));
	await fakePokeApi(context);

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

// Three copies of the card, one other card in Vitrine's first pocket, and a
// placeholder for the card in Estante, page 1, pocket 4.
const seed = (page) => page.evaluate(async (cardId) => {
	const collection = await import('/pokemon-card-tracker/js/collection.js');
	const binders = await import('/pokemon-card-tracker/js/binders.js');
	const copies = [];

	for (const language of ['en', 'en', 'pt']) {
		copies.push((await collection.addCard({card_id: cardId, catalog: 'international', language, language_source: 'manual'})).id);
	}

	const other = await collection.addCard({card_id: 'tst9-002', catalog: 'international', language: 'en', language_source: 'manual'});
	const vitrine = await binders.createBinder({cols: 3, cover_color: '#1d2e60', name: 'Vitrine', page_count: 2, rows: 3});
	const estante = await binders.createBinder({cols: 2, cover_color: '#7a1f1f', name: 'Estante', page_count: 3, rows: 2});

	await binders.placeCard(vitrine.id, 1, 1, other.id);
	await binders.placePlaceholder(estante.id, 1, 4, {card_id: cardId, catalog: 'international', name: 'Exeggcute'});

	return {copies, estante: estante.id, vitrine: vitrine.id};
}, en.id);

const pocket = (page, pg, position) => page.locator(`#binder-spread button.pocket[data-page="${pg}"][data-position="${position}"]`).first();

const kindOf = (page, pg, position) => pocket(page, pg, position).getAttribute('data-kind');

const where = (page, entryId) => page.evaluate(async (id) => (await import('/pokemon-card-tracker/js/binders.js')).binderLocation(id), entryId);

const trayOfBinder = (page, binderId) => page.evaluate(async (id) => {
	const binders = await import('/pokemon-card-tracker/js/binders.js');

	return binders.stagedOf(await binders.getBinder(id));
}, binderId);

const undoOn = (page, text) => page.locator('#toasts .toast', {hasText: text}).locator('button', {hasText: 'Undo'});

// Escape closes a pocket's sheet, and its history entry is gone before
// the next Back.
async function closePocketSheet(page) {
	await page.keyboard.press('Escape');
	await page.waitForFunction(() => !document.querySelector('#pocket-sheet[open]') && !(history.state && history.state.sheet));
}

async function cardPage(page) {
	await page.goto(url(`cards/en/${en.id}`));
	await page.waitForSelector('#copies-binder');
}

// From card detail: Add to binder, then the binder named.
async function chooseBinder(page, name) {
	await page.click('#copies-binder');
	await page.waitForSelector('#add-binder-sheet[open]');
	await page.click(`#add-binder-list .atb-binder:has-text("${name}")`);
	await page.waitForSelector('#binder-hand:not([hidden])');
}

describe('Add to binder from a card\'s page', () => {
	test('the button, the sheet, a tapped pocket, Undo, Cancel, and Back', async () => {
		const {done, page} = await open();
		const {copies, vitrine} = await seed(page);

		await cardPage(page);
		assert.equal(await page.locator('#copies-binder').textContent(), 'Add to binder');
		assert.equal(await page.locator('#copies-binder').evaluate((button) => button.previousElementSibling.id), 'copies-collect', 'beside Add to collection');

		await page.click('#copies-binder');
		await page.waitForSelector('#add-binder-sheet[open]');
		assert.equal(await page.locator('#add-binder-sheet-title').textContent(), 'Add to binder');
		assert.deepEqual(await page.locator('#add-binder-list .atb-name').allTextContents(), ['Vitrine', 'Estante']);
		assert.deepEqual(await page.locator('#add-binder-list .atb-fill').allTextContents(), ['1 of 18 pockets', '0 of 12 pockets']);
		assert.equal(await page.locator('#add-binder-list .atb-thumb').first().evaluate((node) => node.style.getPropertyValue('--cover')), '#1d2e60');
		await page.screenshot({path: '/tmp/add-to-binder-sheet.png'});

		await page.click('#add-binder-list .atb-binder:has-text("Vitrine")');
		await page.waitForSelector('#binder-hand:not([hidden])');
		assert.equal(new URL(page.url()).pathname, `${BASE}binders/${vitrine}`);
		// The name comes with the catalog record, read if the phone has none.
		await page.waitForFunction(() => document.getElementById('bh-name').textContent === 'Exeggcute');
		assert.equal(await page.locator('#bh-status').textContent(), 'Tap an empty pocket');
		assert.ok(await page.locator('#bh-wait').isHidden(), 'no placeholder waits in Vitrine');
		assert.equal(await page.locator('#binder-hand').getAttribute('aria-label'), 'Card in hand');
		await page.screenshot({path: '/tmp/add-to-binder-hand.png'});

		// A taken pocket says so and opens nothing.
		await pocket(page, 1, 1).click();
		assert.equal(await page.locator('#bh-status').textContent(), 'That pocket is taken. Tap an empty pocket.');
		assert.equal(await page.locator('#pocket-sheet[open]').count(), 0);

		// An empty pocket takes one copy, and the card is put down.
		await pocket(page, 1, 5).click();
		await page.waitForFunction(() => document.querySelector('#binder-spread button.pocket[data-page="1"][data-position="5"]').dataset.kind === 'card');
		assert.ok(await page.locator('#binder-hand').isHidden());
		assert.equal((await where(page, copies[0])).position, 5);

		await undoOn(page, 'Placed on page 1, pocket 5.').click();
		await page.waitForFunction(() => document.querySelector('#binder-spread button.pocket[data-page="1"][data-position="5"]').dataset.kind === 'open');
		assert.equal(await where(page, copies[0]), null);

		// With nothing in hand a pocket opens its sheet again.
		await pocket(page, 1, 6).click();
		await page.waitForSelector('#pocket-sheet[open]');
		await closePocketSheet(page);

		// Back off the binder leaves the card behind: card detail again.
		await page.goBack();
		await page.waitForSelector('#copies-binder');
		await chooseBinder(page, 'Vitrine');
		await page.click('#bh-cancel');
		assert.ok(await page.locator('#binder-hand').isHidden(), 'Cancel puts the card down');
		await pocket(page, 1, 2).click();
		await page.waitForSelector('#pocket-sheet[open]');
		await closePocketSheet(page);

		await page.goBack();
		await page.waitForSelector('#copies-binder');
		await chooseBinder(page, 'Vitrine');
		await page.goBack();
		await page.waitForSelector('#copies-binder');
		assert.equal(new URL(page.url()).pathname, `${BASE}cards/en/${en.id}`);
		assert.equal(await page.locator('#binder-hand').count(), 0);
		await done();
	});

	test('Next free pocket, Keep in tray, the waiting placeholder, and every copy placed', async () => {
		const {done, page} = await open();
		const {copies, estante, vitrine} = await seed(page);

		// Next free pocket: the first empty one in reading order.
		await cardPage(page);
		await chooseBinder(page, 'Vitrine');
		await page.click('#bh-next');
		await page.waitForFunction(() => document.querySelector('#binder-spread button.pocket[data-page="1"][data-position="2"]').dataset.kind === 'card');
		assert.ok(await page.locator('#binder-hand').isHidden());
		assert.equal(await page.locator('#toasts .toast-text', {hasText: 'Placed on page 1, pocket 2.'}).count(), 1);

		// Keep in tray, and its Undo.
		await page.goBack();
		await page.waitForSelector('#copies-binder');
		await chooseBinder(page, 'Vitrine');
		assert.ok(await page.locator('#binder-tray').isHidden(), 'the bar takes the tray\'s place');
		await page.click('#bh-tray');
		await page.waitForSelector('#binder-tray:not([hidden]) .bt-card');
		assert.deepEqual(await trayOfBinder(page, vitrine), [copies[1]]);
		await undoOn(page, 'In the tray of Vitrine.').click();
		await page.waitForSelector('#binder-tray', {state: 'hidden'});
		assert.deepEqual(await trayOfBinder(page, vitrine), []);

		// Estante has a placeholder waiting for the card.
		await page.goBack();
		await page.waitForSelector('#copies-binder');
		await chooseBinder(page, 'Estante');
		assert.equal(await page.locator('#bh-wait-text').textContent(), 'Page 1, pocket 4 is waiting for this card');
		await page.screenshot({path: '/tmp/add-to-binder-waiting.png'});
		await page.click('#bh-wait-place');
		await page.waitForFunction(() => document.querySelector('#binder-spread button.pocket[data-page="1"][data-position="4"]')?.dataset.kind === 'card');
		assert.deepEqual(await where(page, copies[1]).then((at) => [at.binder_id, at.page, at.position]), [estante, 1, 4]);

		// Undo brings the placeholder back.
		await undoOn(page, 'Placed on page 1, pocket 4.').click();
		await page.waitForFunction(() => document.querySelector('#binder-spread button.pocket[data-page="1"][data-position="4"]')?.dataset.kind === 'want');

		// The placeholder takes a tap as well.
		await page.goBack();
		await page.waitForSelector('#copies-binder');
		await chooseBinder(page, 'Estante');
		await pocket(page, 1, 4).click();
		await page.waitForFunction(() => document.querySelector('#binder-spread button.pocket[data-page="1"][data-position="4"]')?.dataset.kind === 'card');

		// The last copy, then the sheet says every copy is in a pocket.
		await page.goBack();
		await page.waitForSelector('#copies-binder');
		await chooseBinder(page, 'Estante');
		await pocket(page, 1, 1).click();
		await page.waitForFunction(() => document.querySelector('#binder-spread button.pocket[data-page="1"][data-position="1"]')?.dataset.kind === 'card');
		await page.goBack();
		await page.waitForSelector('#copies-binder');
		await page.click('#copies-binder');
		await page.waitForSelector('#add-binder-sheet[open]');
		assert.equal(await page.locator('#add-binder-all-placed').textContent(), 'All 3 copies of this card are already in pockets.');
		assert.deepEqual(await page.locator('#add-binder-where li').allTextContents(), ['Vitrine, page 1, pocket 2', 'Estante, page 1, pocket 4', 'Estante, page 1, pocket 1']);
		assert.equal(await page.locator('#add-binder-list').count(), 0);
		await page.screenshot({path: '/tmp/add-to-binder-all-placed.png'});
		await done();
	});
});
