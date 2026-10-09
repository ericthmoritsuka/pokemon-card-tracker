// Browser tests for the prices in the app itself (js/price-view.js placed by
// js/catalog-views.js, js/cards-view.js, and js/binders-view.js): the price
// slot on card detail, a tile's price, the on-demand Value sheet on My
// Cards, a set, and a binder. Headless Chromium at 360 x 740
// against tests/pages-server.mjs, signed out.
//
// Every outside service is faked: TCGdex answers with the records saved in
// tests/prices-fixtures, frankfurter.dev with a fixed rate, and PokeAPI with
// tests/fake-pokeapi.mjs. Supabase must never be contacted, and
// ligapokemon.com.br is never requested (any attempt is counted and fails
// the test).
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/prices-app.test.mjs
// Screenshots: /tmp/prices-app-*.png, or under SHOTS when set.

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {extractPrices} from '../js/prices.js';
import {fakePokeApi} from './fake-pokeapi.mjs';
import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const SHOTS = process.env.SHOTS || '/tmp';
const VIEWPORT = {height: 740, width: 360};
// As frankfurter answered on 2026-10-01.
const RATE = [{base: 'USD', date: '2026-10-01', quote: 'BRL', rate: 5.1877}];
const EURO_RATE = [{base: 'EUR', date: '2026-10-01', quote: 'BRL', rate: 5.8814}];

const fixture = async (name) => JSON.parse(await readFile(new URL(`./prices-fixtures/${name}.json`, import.meta.url), 'utf8'));

let server;
let browser;
let charizard;
let exeggcute;

before(async () => {
	server = await startPagesServer();
	browser = await chromium.launch();
	[charizard, exeggcute] = await Promise.all([fixture('en-base1-4'), fixture('en-sv08.5-001')]);
});

after(async () => {
	await browser.close();
	await server.close();
});

const url = (path = '') => `${server.origin}${BASE}${path}`;

// Intl writes a no-break space after the currency symbol.
const plain = (text) => String(text).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

const variant = (card, label) => extractPrices(card).find((finish) => finish.label === label).variantId;

async function phone({colorScheme = 'light', viewport = VIEWPORT} = {}) {
	const context = await browser.newContext({colorScheme, serviceWorkers: 'block', viewport});
	const seen = {liga: [], supabase: []};
	const records = {
		[`en/cards/${charizard.id}`]: charizard,
		[`en/cards/${exeggcute.id}`]: exeggcute,
		// The set's list, as TCGdex gives it: brief cards, no prices.
		[`en/sets/${charizard.set.id}`]: {
			cardCount: charizard.set.cardCount,
			cards: [{id: charizard.id, image: null, localId: charizard.localId, name: charizard.name}],
			id: charizard.set.id,
			name: charizard.set.name,
		},
	};

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
		body: JSON.stringify(/base=EUR/.test(route.request().url()) ? EURO_RATE : RATE),
		contentType: 'application/json',
		headers: {'Access-Control-Allow-Origin': '*'},
		status: 200,
	}));
	await context.route('https://api.tcgdex.net/**', (route) => {
		const key = new URL(route.request().url()).pathname.replace(/^\/v2\//, '');
		const record = records[key];

		return route.fulfill(record
			? {body: JSON.stringify(record), contentType: 'application/json', status: 200}
			: {body: '{}', contentType: 'application/json', status: 404});
	});
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));
	await fakePokeApi(context);

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err));

	return {context, errors, page, seen};
}

const addCard = (page, fields) => page.evaluate(async (card) => (await import('/pokemon-card-tracker/js/collection.js')).addCard(card), fields);

async function noSideways(page, where, limit = VIEWPORT.width) {
	const width = await page.evaluate(() => document.documentElement.scrollWidth);

	assert.ok(width <= limit, `no sideways scroll at ${limit} px on ${where} (${width})`);
}

describe('prices in the app', () => {
	test('card detail price slot, tile prices, and the Value sheet on My Cards, a set, and a binder', async () => {
		const device = await phone();
		const {page} = device;

		await page.goto(url('cards'));
		await page.waitForSelector('#cards-empty');

		const first = await addCard(page, {card_id: charizard.id, catalog: 'international', language: 'en', language_source: 'manual', variant_id: variant(charizard, 'Holo, Unlimited')});
		const second = await addCard(page, {
			card_id: exeggcute.id,
			catalog: 'international',
			language: 'en',
			language_source: 'manual',
			price_manual: {avg: 52.3, currency: 'BRL', date: '2026-09-19', low_nm: 45.9, source: 'Liga Pokémon'},
			variant_id: variant(exeggcute, 'Normal'),
		});

		// Card detail: the hero, Your copies, Ver na Liga, then the price,
		// full width (Q-04), and no Ver na Liga in the hero facts.
		await page.goto(url(`cards/en/${charizard.id}`));
		await page.waitForSelector('#card-price .price');
		await page.waitForSelector('#card-liga a.liga-link');
		// The international twin picker sits after the hero only when it has
		// something to ask, and is hidden otherwise.
		assert.deepEqual(await page.evaluate(() => {
			const order = [];
			let next = document.querySelector('.card-hero').nextElementSibling;

			while (next && order.length < 4) {
				if (!(next.classList.contains('tw-block') && next.hidden)) {
					order.push(next.id || next.className);
				}

				next = next.nextElementSibling;
			}

			return order;
		}), ['copies', 'card-liga', 'copies-collect-row', 'card-price'], 'the slot follows Your copies, Ver na Liga, and Add to collection');
		assert.equal(await page.locator('#card-liga a:has-text("Ver na Liga")').count(), 1);
		// Ver na Liga is not among the facts; the illustrator's goal link is.
		assert.equal(await page.locator('.hero-facts a:not(.illustrator-goal), .hero-facts .liga-none').count(), 0);

		const slot = await page.evaluate(() => {
			const rect = (selector) => document.querySelector(selector).getBoundingClientRect();

			return {detail: rect('.card-detail').width, price: rect('#card-price').width};
		});

		assert.ok(slot.price >= slot.detail - 1, `full width (${slot.price} of ${slot.detail})`);
		await page.waitForSelector('#card-price .price-us-value');
		assert.match(plain(await page.locator('#card-price .price-us-value').textContent()), /R\$ 4\.899,94/);
		await page.waitForSelector('.copies li');
		assert.equal(await page.locator('.copies .copy-price').count(), 0, 'no Liga price on the copy yet');
		await noSideways(page, 'card detail');

		// My Cards: the Liga price on one tile, the US estimate on the other,
		// each the last line under the name.
		await page.goto(url('cards'));
		await page.waitForSelector('.tile:has-text("Exeggcute") .tile-price');
		await page.waitForSelector('.tile:has-text("Charizard") .tile-price');
		assert.equal(plain(await page.locator('.tile:has-text("Exeggcute") .tile-price').textContent()), 'R$ 52,30');
		assert.equal(plain(await page.locator('.tile:has-text("Charizard") .tile-price').textContent()), '~R$ 4.900US');
		assert.ok(await page.locator('.tile:has-text("Charizard")').evaluate((tile) => tile.lastElementChild.classList.contains('tile-price')), 'the price is the last line');
		await page.screenshot({fullPage: false, path: '/tmp/prices-app-tiles.png'});

		// The whole collection's value is on demand: a small Value button
		// opens a sheet led by how many copies are priced.
		assert.equal(await page.locator('.price-stats').count(), 0, 'no headline total');
		await page.click('#cards-value');
		await page.waitForSelector('.value-sheet[open] .price-stats');
		assert.equal(plain(await page.locator('.value-sheet .vs-coverage').textContent()), 'Priced: 2 of 2 copies');
		assert.equal(await page.locator('.value-sheet .price-stats').getAttribute('aria-label'), 'Value of your collection');
		assert.match(plain(await page.locator('.value-sheet .price-stats-counts').textContent()), /1 copy by Liga.*1 copy by US estimate/);
		assert.equal(plain(await page.locator('.value-sheet .price-stats-total').textContent()), '~R$ 4.952,24');
		await page.keyboard.press('Escape');
		await page.waitForSelector('.value-sheet', {state: 'detached'});
		await noSideways(page, 'My Cards');

		// Back on card detail: the Liga price kept on the Exeggcute shows on
		// its row and as one line in the price panel, with no form to type a
		// new one. Remove takes it off; the toast's Undo puts it back.
		await page.goto(url(`cards/en/${exeggcute.id}`));
		await page.waitForSelector('#card-price .price-liga');
		assert.equal(plain(await page.locator('.copies .copy-price').textContent()), 'Liga, 19 Sep 2026: lowest NM R$ 45,90 · average R$ 52,30');
		assert.equal(plain(await page.locator('#card-price .price-liga-text').textContent()), 'Liga, 19 Sep 2026: lowest NM R$ 45,90 · average R$ 52,30');
		assert.equal(await page.locator('#card-price form, #card-price input').count(), 0, 'no Liga price form');
		assert.ok(await page.locator('#card-price .price-liga-link').isHidden(), 'Ver na Liga stays the one above');
		await page.click('#card-price .price-remove');
		await page.waitForSelector('#card-price .price-liga', {state: 'detached'});
		await page.waitForSelector('.copies .copy-price', {state: 'detached'});
		assert.equal(await page.locator('#card-price .price-us-value').count(), 1, 'the automatic price stays');
		await page.click('#toasts button:has-text("Undo")');
		await page.waitForSelector('#card-price .price-liga');
		await page.waitForSelector('.copies .copy-price');
		await page.screenshot({fullPage: true, path: `${SHOTS}/prices-app-card.png`});

		// The set: no big box, a small Value button that opens the sheet
		// over the copies owned from it.
		await page.goto(url(`sets/en/${charizard.set.id}`));
		await page.waitForSelector('#set-stats #set-value');
		assert.equal(await page.locator('.price-stats').count(), 0, 'no inline statistics on the set');
		await page.click('#set-value');
		await page.waitForSelector('.value-sheet[open] .price-stats');
		assert.equal(await page.locator('.value-sheet .price-stats').getAttribute('aria-label'), `Value of your cards from ${charizard.set.name}`);
		assert.equal(plain(await page.locator('.value-sheet .vs-coverage').textContent()), 'Priced: 1 of 1 copy');
		assert.equal(plain(await page.locator('.value-sheet .price-stats-total').textContent()), '~R$ 4.899,94');
		await page.keyboard.press('Escape');
		await page.waitForSelector('.value-sheet', {state: 'detached'});
		await noSideways(page, 'the set');

		// A binder holding both copies: its Value button at the top.
		const binderId = await page.evaluate(async ([a, b]) => {
			const binders = await import('/pokemon-card-tracker/js/binders.js');
			const binder = await binders.createBinder({cols: 3, name: 'Vitrine', page_count: 1, rows: 3});

			await binders.placeCard(binder.id, 1, 1, a);
			await binders.placeCard(binder.id, 1, 2, b);

			return binder.id;
		}, [first.id, second.id]);

		await page.goto(url(`binders/${binderId}`));
		await page.waitForSelector('#binder-stats #binder-value');
		assert.ok(await page.evaluate(() => document.querySelector('.binder-head').nextElementSibling.id === 'binder-stats'), 'right under the binder\'s name');
		assert.equal(await page.locator('.price-stats').count(), 0, 'no inline statistics on the binder');
		await page.screenshot({fullPage: false, path: '/tmp/prices-app-binder.png'});
		await page.click('#binder-value');
		await page.waitForSelector('.value-sheet[open] .price-stats');
		assert.equal(await page.locator('.value-sheet .price-stats').getAttribute('aria-label'), 'Value of Vitrine');
		assert.equal(plain(await page.locator('.value-sheet .price-stats-total').textContent()), '~R$ 4.952,24');
		assert.match(plain(await page.locator('.value-sheet .price-stats-counts').textContent()), /1 copy by Liga.*1 copy by US estimate.*0 copies unknown/);
		await page.keyboard.press('Escape');
		await page.waitForSelector('.value-sheet', {state: 'detached'});
		await noSideways(page, 'the binder');

		assert.deepEqual(device.errors.map(String), []);
		assert.deepEqual(device.seen.liga, [], 'Liga Pokémon is never requested');
		assert.deepEqual(device.seen.supabase, [], 'Supabase is never contacted');
		await device.context.close();
	});

	// A monprice Holo the card does not list, and a Liga price kept on
	// another copy: the compact panel at both phone widths, in both schemes.
	for (const width of [360, 390]) {
		for (const colorScheme of ['light', 'dark']) {
			test(`card detail price panel at ${width} px, ${colorScheme}`, async () => {
				const device = await phone({colorScheme, viewport: {height: 800, width}});
				const {page} = device;

				await page.goto(url('cards'));
				await page.waitForSelector('#cards-empty');
				await addCard(page, {card_id: exeggcute.id, catalog: 'international', finish_raw: 'HOLOFOIL', language: 'en', language_source: 'manual'});
				await addCard(page, {
					card_id: exeggcute.id,
					catalog: 'international',
					language: 'pt',
					language_source: 'manual',
					price_manual: {avg: 15, currency: 'BRL', date: '2026-10-01', finish: 'Reverse holo', language: 'pt', low_nm: 12, source: 'Liga Pokémon'},
					variant_id: variant(exeggcute, 'Reverse holo'),
				});
				await page.goto(url(`cards/en/${exeggcute.id}`));
				await page.waitForSelector('#card-price .price-liga');
				await page.waitForFunction(() => document.querySelectorAll('#card-price .price-us-value, #card-price .price-eu-value').length === 2);

				const panel = page.locator('#card-price');

				// The owned Reverse holo is shown first: its own prices.
				assert.match(plain(await panel.locator('.price-finish[aria-pressed="true"]').textContent()), /^Reverse holo/);
				await panel.locator('.price-finish', {hasText: /^Normal/}).click();
				assert.equal(plain(await panel.locator('.price-us .price-for').textContent()), 'for Normal; your copy is Holo');
				assert.equal(plain(await panel.locator('.price-us .price-original').textContent()), 'US$ 0,05, TCGplayer market, 30 Sep');
				assert.equal(plain(await panel.locator('.price-rate').textContent()), 'US$ 1 = R$ 5,19 · € 1 = R$ 5,88, rates of 1 Oct.');
				// One line, small, with Remove beside it.
				assert.equal(plain(await panel.locator('.price-liga-text').textContent()), 'Liga, 1 Oct 2026: lowest NM R$ 12,00 · average R$ 15,00 (Reverse holo, Portuguese)');
				await noSideways(page, 'card detail', width);
				await panel.scrollIntoViewIfNeeded();
				await panel.screenshot({path: `${SHOTS}/prices-panel-${width}-${colorScheme}.png`});
				assert.deepEqual(device.errors.map(String), []);
				assert.deepEqual(device.seen.liga, [], 'Liga Pokémon is never requested');
				await device.context.close();
			});
		}
	}

	test('the CSV export writes the names the app shows, a Korean copy\'s own', async () => {
		const device = await phone();
		const {page} = device;

		await page.goto(url('cards'));
		await page.waitForSelector('#cards-empty');

		const rows = await page.evaluate(async () => {
			const {collectionCsv} = await import('/pokemon-card-tracker/js/cards-view.js');
			const at = '2026-09-01T00:00:00.000Z';
			const copy = (id, fields) => ({card_id: 'SV2a-001', catalog: 'ja', created_at: at, deleted_at: null, id, language_source: 'import', updated_at: at, ...fields});
			// A Japanese record, as the card index keeps it: no Korean names.
			const index = new Map([['ja|SV2a-001', {collector_number: '001', id: 'SV2a-001', localizations: {ja: {name: 'フシギダネ', set_name: 'ポケモンカード151'}}, set_id: 'SV2a'}]]);
			const text = collectionCsv([
				copy('k1', {language: 'ko', name_local: '이상해씨', set_name_local: '포켓몬 카드 151'}),
				copy('k2', {language: 'ko', name_local: '이상해씨'}),
				copy('j1', {language: 'ja'}),
			], index);

			return text.replace(/^\uFEFF/, '').trim().split('\r\n').map((line) => line.split(';'));
		});

		assert.equal(rows[0][4], 'set');
		assert.equal(rows[0][6], 'name');
		assert.ok(rows[0].every((column) => /^[a-z]+(_[a-z]+)*$/.test(column)), 'one header style');
		assert.equal(rows[0][16], 'currency');
		assert.deepEqual([rows[1][4], rows[1][6], rows[1][7]], ['포켓몬 카드 151', '"이상해씨"', 'KO']);
		assert.deepEqual([rows[2][4], rows[2][6]], ['ポケモンカード151', '"이상해씨"'], 'no set name from the source keeps the catalog\'s');
		assert.deepEqual([rows[3][4], rows[3][6]], ['ポケモンカード151', '"フシギダネ"'], 'a Japanese copy keeps the Japanese name');
		assert.deepEqual(device.errors, []);
		await device.context.close();
	});
});
