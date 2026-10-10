// Browser tests for My Cards' search, filter and sort bar (js/filter-bar.js),
// background card details and prices (js/catalog.js, js/cards-view.js), the
// "No price" line (js/tile.js), and the Value sheet (js/value-sheet.js).
// Headless Chromium at 360 x 740 against tests/pages-server.mjs, signed out.
//
// Every outside service is faked (tests/my-cards-fixtures.mjs): TCGdex
// answers invented cards and counts each request, frankfurter.dev a fixed
// rate, PokeAPI tests/fake-pokeapi.mjs. Supabase and ligapokemon.com.br are
// never requested.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/my-cards-browser.test.mjs
// Screenshots: $SHOTS (default /tmp)/my-cards-*.png

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {BASE, CARDS, COPIES, documentWith, fakeServices, fullRecord, indexRecords, linkNewStyles, seed} from './my-cards-fixtures.mjs';
import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const VIEWPORT = {height: 740, width: 360};
const SHOTS = process.env.SHOTS || '/tmp';
const DAY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT = {timeout: 20000};

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

async function phone({cards = CARDS, delayMs = 0, viewport = VIEWPORT} = {}) {
	const context = await browser.newContext({serviceWorkers: 'block', viewport});
	const log = await fakeServices(context, {cards, delayMs});

	await fakePokeApi(context);
	await linkNewStyles(context);

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err.message));

	return {context, errors, log, page};
}

const names = (page) => page.locator('.card-grid .tile .tile-name').allTextContents();

const summary = (page) => page.locator('#cards-summary').textContent();

async function search(page, text) {
	await page.fill('#cards-search', text);
	await page.waitForFunction((value) => {
		const grid = document.querySelector('.card-grid');

		return grid && grid.dataset.query === value;
	}, text, TIMEOUT);
}

// Waits for the background pass to bring every card's details into the
// index (the Fire filter then finds the three Fire cards). Polled from
// here: waitForFunction takes the promise an async check returns as true at
// once, so it would not wait.
async function detailsIn(page) {
	const start = Date.now();
	const done = () => page.evaluate(async () => {
		const {cardIndex} = await import('/pokemon-card-tracker/js/catalog.js');
		const index = await cardIndex();

		return index.size > 0 && [...index.values()].every((record) => typeof record.category === 'string');
	});

	while (!await done()) {
		assert.ok(Date.now() - start < TIMEOUT.timeout, 'every card\'s details reach the index');
		await page.waitForTimeout(100);
	}
}

async function pricesIn(page, log, count = 7) {
	const start = Date.now();

	while (log.cards.filter((path) => path.startsWith('en/')).length < count && Date.now() - start < 20000) {
		await page.waitForTimeout(100);
	}

	// The tiles are patched a moment after the last price.
	await page.locator('.tile:has-text("Test Ball") .price-none').waitFor(TIMEOUT);
}

async function openFilters(page) {
	await page.click('#cards-filters');
	await page.locator('#cards-sheet[open]').waitFor();
}

async function closeFilters(page) {
	await page.click('#cards-sheet .fb-show');
	await page.locator('#cards-sheet').waitFor({state: 'hidden'});
}

async function noSideways(page, where) {
	const width = await page.evaluate(() => document.documentElement.scrollWidth);

	assert.ok(width <= page.viewportSize().width, `no sideways scroll on ${where} (${width})`);
}

// Every select on screen is wide enough for its longest option, in its own
// font, so no choice is ever cut off.
async function selectsFit(page, where) {
	const cut = await page.evaluate(() => {
		const canvas = document.createElement('canvas').getContext('2d');
		const out = [];

		for (const select of document.querySelectorAll('select')) {
			if (!select.offsetParent) {
				continue;
			}

			const style = getComputedStyle(select);
			const room = select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);

			canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;

			for (const option of select.options) {
				const width = canvas.measureText(option.textContent).width;

				if (width > room) {
					out.push(`${select.id}: "${option.textContent}" needs ${Math.ceil(width)} of ${Math.floor(room)}`);
				}
			}
		}

		return out;
	});

	assert.deepEqual(cut, [], `no select is cut off on ${where}`);
}

// Every tile's meta line takes two lines at most, however long a Japanese
// or Korean set name is, and the whole text stays in the page for screen
// readers and in the title for a long press.
async function metaFits(page, where) {
	const tall = await page.evaluate(() => [...document.querySelectorAll('.tile .tile-meta')]
		.filter((meta) => {
			const style = getComputedStyle(meta);
			const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.25;

			return meta.getBoundingClientRect().height > line * 2 + 1 || meta.title !== meta.textContent;
		})
		.map((meta) => `${meta.textContent} (${Math.round(meta.getBoundingClientRect().height)} px, title "${meta.title}")`));

	assert.deepEqual(tall, [], `no meta line runs past two lines on ${where}`);
}

describe('search', () => {
	test('finds names in every language the phone has, readings, set names, numbers, Pokédex numbers, and IDs, offline too', async () => {
		const {context, errors, log, page} = await phone();

		await seed(page, server.origin);
		await page.locator('.tile').first().waitFor();
		assert.match(await summary(page), /^10 copies in 10 tiles/);
		await detailsIn(page);

		// The search sits first, over the owned cards.
		const order = await page.evaluate(() => [...document.querySelector('.fb').children].map((element) => element.className));

		assert.match(order[0], /fb-search/);

		await context.setOffline(true);

		await search(page, 'pikachu');
		assert.deepEqual((await names(page)).sort(), ['Pikachu', 'Pikachu'], 'the English name of a Japanese print too');
		assert.match(await summary(page), /^2 copies in 2 tiles match/);

		await search(page, 'ピカチュウ');
		assert.deepEqual(await page.locator('.tile .tile-original').allTextContents(), ['ピカチュウ (Pikachu)']);

		await search(page, 'bola');
		assert.deepEqual(await names(page), ['Test Ball'], 'a Portuguese name while viewing English');

		await search(page, '이상해씨');
		assert.equal(await page.locator('.tile').count(), 1);

		await search(page, 'Isanghae');
		assert.equal(await page.locator('.tile').count(), 1, 'the Korean reading');

		await search(page, '004');
		assert.deepEqual(await names(page), ['Charmander', 'Charmander'], 'a collector number');

		await search(page, '090');
		assert.deepEqual(await names(page), ['Sprigatito'], 'a plain number is the collector number, not the Pokédex');

		await search(page, '#90');
		assert.equal(await page.locator('.tile').count(), 0, 'no Pokémon #90 here');

		await search(page, '#906');
		assert.deepEqual(await names(page), ['Sprigatito'], 'with "#" it is the Pokédex number');

		await search(page, '#25');
		assert.deepEqual((await names(page)).sort(), ['Pikachu', 'Pikachu'], 'every print of #25, the Japanese one too');

		await search(page, '#025');
		assert.equal(await page.locator('.tile').count(), 2);

		await search(page, '#1-6');
		assert.deepEqual((await names(page)).sort(), ['Bulbasaur', 'Bulbasaur', 'Charizard ex', 'Charmander', 'Charmander'], 'a range');

		await search(page, '#1-1025');
		assert.equal(await page.locator('.tile').count(), 8, 'Trainers and Energy have no Pokédex number');

		await search(page, 'char #1-5');
		assert.deepEqual(await names(page), ['Charmander', 'Charmander'], 'words and a range together');

		await search(page, '4/160');
		assert.deepEqual(await names(page), ['Charmander', 'Charmander'], 'the number as printed');

		await search(page, 'tsa1-150');
		assert.deepEqual(await names(page), ['Test Ball']);

		await search(page, 'test beta');
		assert.deepEqual((await names(page)).sort(), ['Pikachu', 'Sprigatito'], 'set names, several words');

		await search(page, 'charizard alpha');
		assert.deepEqual(await names(page), ['Charizard ex']);

		await search(page, 'nothing like this');
		assert.match(await page.locator('#cards-none').textContent(), /No cards match "nothing like this"/);
		assert.equal(await page.locator('#cards-none a', {hasText: 'Search the catalog'}).count(), 1);

		await search(page, '');
		assert.equal(await page.locator('.tile').count(), 10);
		await context.setOffline(false);
		// js/twins.js reads the Japanese set for its own check; nothing else.
		assert.deepEqual(log.other.filter((path) => path !== 'ja/sets/TSJ1'), []);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a search over 1,600 copies is instant and resets the paging to the matching tiles', async () => {
		const {context, errors, page} = await phone();
		const cards = Array.from({length: 1600}, (_, i) => ({
			catalog: 'international',
			category: 'Pokemon',
			dexId: [(i % 1025) + 1],
			id: `tsz${Math.floor(i / 160) + 1}-${String((i % 160) + 1).padStart(3, '0')}`,
			market: null,
			names: {en: `Invented ${i + 1}`},
			rarity: 'Common',
			set: {id: `tsz${Math.floor(i / 160) + 1}`, name: `Zeta ${Math.floor(i / 160) + 1}`, official: 160, releaseDate: '2024-01-01'},
			types: ['Water'],
		}));
		const copies = cards.map((card, i) => ({
			card_id: card.id, catalog: 'international', created_at: new Date(Date.parse('2026-09-01T00:00:00Z') + (i * 1000)).toISOString(),
			deleted_at: null, id: `z-${i}`, language: 'en', language_source: 'manual', updated_at: '2026-09-01T00:00:00Z', variant_id: null,
		}));

		await seed(page, server.origin, {binders: [], copies, index: indexRecords(cards)});
		await page.locator('.tile').first().waitFor();
		assert.equal(await page.locator('.tile').count(), 120);
		await page.click('.card-grid + button');
		await page.waitForFunction(() => document.querySelectorAll('.tile').length === 240);

		const took = await page.evaluate(() => new Promise((resolve) => {
			const input = document.getElementById('cards-search');
			const start = performance.now();

			new MutationObserver((list, observer) => {
				if (/match/.test(document.getElementById('cards-summary').textContent)) {
					observer.disconnect();
					resolve(performance.now() - start);
				}
			}).observe(document.getElementById('cards-summary'), {characterData: true, childList: true, subtree: true});
			input.value = 'tsz3-';
			input.dispatchEvent(new Event('input'));
		}));

		console.log(`    search over 1,600 copies: ${Math.round(took)} ms, the 120 ms typing pause included`);
		assert.ok(took < 1500, `the search answers at once (${Math.round(took)} ms)`);
		// The 160 cards of the third set, the first 120 of them drawn.
		assert.match(await summary(page), /^160 copies in 160 tiles match/);
		assert.equal(await page.locator('.tile').count(), 120, 'back to the first page of the matches');
		assert.equal(await page.locator('.card-grid + button').textContent(), 'Show more (40 left)');

		await search(page, 'invented 1234');
		assert.deepEqual(await names(page), ['Invented 1234']);
		assert.ok(await page.locator('.card-grid + button').isHidden(), 'no Show more for one tile');

		await search(page, '');
		assert.equal(await page.locator('.tile').count(), 120, 'clearing it starts at the first page again');
		assert.deepEqual(errors, []);
		await context.close();
	});
});

describe('filters and sorts', () => {
	test('each filter and sort, after the background pass fills the card details', async () => {
		const {context, errors, log, page} = await phone();

		await seed(page, server.origin);
		await page.locator('.tile').first().waitFor();
		await detailsIn(page);

		const pick = async (kind, value) => {
			await openFilters(page);

			if (kind === 'type' || kind === 'category') {
				await page.click(`#cards-sheet [data-filter="${kind}"] [data-value="${value}"]`);
			}
			else if (kind === 'unplaced') {
				await page.check('#cards-f-unplaced');
			}
			else {
				await page.selectOption(`#cards-f-${kind}`, value);
			}

			await closeFilters(page);
		};
		const clear = async () => {
			await openFilters(page);
			await page.click('#cards-clear');
			await closeFilters(page);
		};
		const sortBy = (value) => page.selectOption('#cards-sort', value);

		await sortBy('name');
		assert.deepEqual(await names(page), ['Basic Fire Energy', 'Bulbasaur', 'Bulbasaur', 'Charizard ex', 'Charmander', 'Charmander', 'Pikachu', 'Pikachu', 'Sprigatito', 'Test Ball']);

		await pick('region', 'kanto');
		assert.equal(await page.locator('.tile').count(), 7, 'Kanto: Dex 1 to 151, Asian prints included');
		assert.match(await page.locator('#cards-filters').getAttribute('aria-label'), /1 active/);
		assert.equal(plain(await page.locator('.fb-chip').textContent()), 'Kanto (Gen 1)×');
		await clear();
		await pick('region', 'paldea');
		assert.deepEqual(await names(page), ['Sprigatito']);
		await clear();

		// The Pokédex range: 1 to 151, then one number, then reversed.
		const dex = async (from, to) => {
			await openFilters(page);
			await page.fill('#cards-f-dex-from', from);
			await page.fill('#cards-f-dex-to', to);
			await page.locator('#cards-f-dex-to').press('Enter');
			await page.locator('#cards-f-dex-from').blur();
			await closeFilters(page);
		};

		await dex('1', '151');
		assert.equal(await page.locator('.tile').count(), 7);
		assert.equal(plain(await page.locator('.fb-chip').textContent()), 'Pokédex #1 to #151×');
		await clear();
		await dex('25', '');
		assert.deepEqual(await names(page), ['Pikachu', 'Pikachu'], 'one number alone');
		assert.equal(plain(await page.locator('.fb-chip').textContent()), 'Pokédex #25×');
		await clear();
		await dex('906', '800');
		assert.deepEqual(await names(page), ['Sprigatito'], 'a reversed range is turned round');
		await clear();
		await dex('1', '1025');
		assert.equal(await page.locator('.tile').count(), 8, 'no Trainer or Energy in a Pokédex range');
		await clear();

		await pick('type', 'Fire');
		assert.deepEqual(await names(page), ['Charizard ex', 'Charmander', 'Charmander']);
		await clear();
		await pick('type', 'Lightning');
		assert.deepEqual(await names(page), ['Pikachu', 'Pikachu']);

		// Two at once: Lightning and Japanese.
		await pick('language', 'ja');
		assert.equal(await page.locator('.tile').count(), 1);
		assert.match(await page.locator('#cards-filters').getAttribute('aria-label'), /2 active/);
		await page.click('.fb-chips .fb-clear');
		assert.equal(await page.locator('.tile').count(), 10);

		await pick('category', 'Trainer');
		assert.deepEqual(await names(page), ['Test Ball']);
		await clear();
		await pick('category', 'Energy');
		assert.deepEqual(await names(page), ['Basic Fire Energy']);
		await clear();

		await pick('set', 'international|tsb2');
		assert.deepEqual(await names(page), ['Pikachu', 'Sprigatito']);
		await clear();

		await pick('rarity', 'Double rare');
		assert.deepEqual(await names(page), ['Charizard ex']);
		await clear();

		await pick('unplaced', true);
		assert.equal(await page.locator('.tile').count(), 9, 'all but the Bulbasaur in the binder');
		assert.equal(await page.locator('.tile:has-text("Bulbasaur") .badge-lang').count(), 1, 'the Korean Bulbasaur stays');
		await clear();

		// The sorts.
		await sortBy('dex');
		assert.deepEqual((await names(page)).slice(0, 4), ['Bulbasaur', 'Bulbasaur', 'Charmander', 'Charmander']);
		assert.deepEqual((await names(page)).slice(-3), ['Sprigatito', 'Basic Fire Energy', 'Test Ball'], 'Trainers and Energy after the Pokémon');

		await sortBy('set');
		assert.deepEqual((await page.locator('.tile .tile-meta').allTextContents()).slice(0, 2), ['#001 · Test Alpha', '#004 · Test Alpha']);
		assert.match((await page.locator('.tile .tile-meta').allTextContents()).at(-1), /Test Beta/, 'the oldest set last');

		await sortBy('newest');
		assert.deepEqual((await names(page)).slice(0, 2), ['Bulbasaur', 'Pikachu'], 'the Korean copy came last');
		await sortBy('oldest');
		assert.deepEqual((await names(page)).slice(0, 2), ['Bulbasaur', 'Charmander']);

		await pricesIn(page, log);
		await sortBy('price');
		assert.deepEqual((await names(page)).slice(0, 7), ['Charizard ex', 'Pikachu', 'Sprigatito', 'Charmander', 'Charmander', 'Bulbasaur', 'Basic Fire Energy'], 'R$ 150, Liga R$ 80, R$ 10, R$ 6, R$ 2,50, R$ 0,50');
		assert.deepEqual((await names(page)).slice(-3).sort(), ['Bulbasaur', 'Pikachu', 'Test Ball'], 'unknown prices last');

		await pick('price', 'unpriced');
		assert.deepEqual((await names(page)).sort(), ['Bulbasaur', 'Pikachu', 'Test Ball']);
		await page.screenshot({path: `${SHOTS}/my-cards-unpriced.png`});
		assert.deepEqual(log.other.filter((path) => path !== 'ja/sets/TSJ1'), []);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('the last choice is remembered for the screen, and the old sort carries over once', async () => {
		const {context, errors, page} = await phone();

		await seed(page, server.origin, {local: {'cardTracker.cardsLanguage': 'pt', 'cardTracker.cardsSort': 'name'}});
		await page.locator('.tile').first().waitFor();
		assert.equal(await page.locator('#cards-sort').inputValue(), 'name', 'the old sort');
		assert.deepEqual(await names(page), ['Charmander', 'Test Ball'], 'the old language filter');
		await page.click('.fb-chip');
		await detailsIn(page);
		await page.selectOption('#cards-sort', 'dex');
		await openFilters(page);
		await page.click('#cards-sheet [data-filter="type"] [data-value="Fire"]');
		await closeFilters(page);
		await page.fill('#cards-search', 'charm');
		await page.waitForFunction(() => document.querySelectorAll('.tile').length === 2);

		await page.reload();
		await page.locator('.tile').first().waitFor();
		assert.equal(await page.locator('#cards-sort').inputValue(), 'dex');
		assert.deepEqual(await names(page), ['Charmander', 'Charmander', 'Charizard ex'], 'Fire, Dex order; the search is not kept');
		assert.equal(await page.locator('#cards-search').inputValue(), '');

		const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('cardTracker.cardsChoice')));

		assert.deepEqual({sort: saved.sort, type: saved.filters.type}, {sort: 'dex', type: 'Fire'});

		// A broken saved choice falls back to the defaults.
		await page.evaluate(() => localStorage.setItem('cardTracker.cardsChoice', '{not json'));
		await page.reload();
		await page.locator('.tile').first().waitFor();
		assert.equal(await page.locator('#cards-sort').inputValue(), 'name', 'the old key, then the default');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('swiping on a card page follows the filtered and sorted list', async () => {
		const {context, errors, page} = await phone();

		await seed(page, server.origin);
		await page.locator('.tile').first().waitFor();
		await detailsIn(page);
		await page.selectOption('#cards-sort', 'name');
		await openFilters(page);
		await page.click('#cards-sheet [data-filter="type"] [data-value="Fire"]');
		await closeFilters(page);

		const routes = await page.locator('.card-grid .tile').evaluateAll((tiles) => tiles.map((tile) => tile.dataset.link));

		assert.equal(routes.length, 3);
		await page.locator('.card-grid .tile').first().click();
		await page.waitForURL(new RegExp(`${routes[0]}$`));
		await page.locator('#card-position').waitFor();
		assert.equal(await page.locator('#card-position').textContent(), '1 of 3');
		await page.click('#card-next');
		await page.waitForURL(new RegExp(`${routes[1]}$`));
		assert.equal(await page.locator('#card-position').textContent(), '2 of 3');

		// Back on My Cards the filter and the sort are as they were.
		await page.goBack();
		await page.locator('.tile').first().waitFor();
		assert.equal(await page.locator('.tile').count(), 3);
		assert.deepEqual(errors, []);
		await context.close();
	});
});

describe('background details and prices', () => {
	test('one request per owned set for the details, one per international card for the prices, none the second time', async () => {
		const {context, errors, log, page} = await phone();

		await seed(page, server.origin);
		await page.locator('.tile').first().waitFor();
		await detailsIn(page);
		assert.deepEqual([...log.graphql].sort(), ['TSJ1', 'TSK1', 'tsa1', 'tsb2'], 'one GraphQL request per set, the Asian catalogs too');

		const index = await page.evaluate(async () => Object.fromEntries(await (await import('/pokemon-card-tracker/js/catalog.js')).cardIndex()));

		assert.deepEqual(
			{category: index['international|tsa1-006'].category, dex_ids: index['international|tsa1-006'].dex_ids, rarity: index['international|tsa1-006'].rarity, types: index['international|tsa1-006'].types},
			{category: 'Pokemon', dex_ids: [6], rarity: 'Double rare', types: ['Fire']}
		);
		assert.deepEqual(index['ja|TSJ1-025'].dex_ids, [25]);
		assert.deepEqual(index['international|tsa1-150'].dex_ids, [], 'a Trainer has no Dex number');
		assert.equal(index['international|tsa1-150'].localizations.pt.name, 'Bola de Teste', 'the names stay');

		await pricesIn(page, log);

		const asked = log.cards.filter((path) => /^\w+\/ts[ab]/.test(path));

		assert.deepEqual([...asked].sort(), CARDS.filter((card) => card.catalog === 'international').map((card) => `en/${card.id}`).sort(), 'each international card once, in English; no Asian print');

		// Saved the way card detail saves them, so its US price shows.
		assert.equal(plain(await page.locator('.tile:has-text("Charizard ex") .tile-price').textContent()), '~R$ 150US');
		assert.equal(plain(await page.locator('.tile:has-text("Test Ball") .tile-price').textContent()), 'No price', 'no market price on TCGdex');

		const saved = await page.evaluate(async () => {
			const {cardDetail} = await import('/pokemon-card-tracker/js/catalog.js');

			return (await cardDetail('en', 'tsa1-006')).data.pricing.tcgplayer.normal.marketPrice;
		});

		assert.equal(saved, 30);

		const before = {cards: log.cards.length, graphql: log.graphql.length};

		await page.reload();
		await page.locator('.tile:has-text("Charizard ex") .tile-price').waitFor();
		await page.waitForTimeout(2500);
		assert.equal(log.graphql.length, before.graphql, 'no details asked again');
		assert.equal(log.cards.filter((path) => /^\w+\/ts[ab]/.test(path)).length, asked.length, 'no price asked again within the week');
		assert.deepEqual(log.other.filter((path) => !/sets\/TSJ1$/.test(path)), []);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a record older than a week is read again, a newer one is not', async () => {
		const {context, errors, log, page} = await phone();
		const now = Date.now();
		const records = {};

		for (const card of CARDS.filter((one) => one.catalog === 'international')) {
			records[`card:en:${card.id}`] = {at: now - (card.id === 'tsa1-006' ? 8 : 6) * DAY_MS, data: fullRecord(card)};
		}

		await seed(page, server.origin, {records});
		await page.locator('.tile:has-text("Charizard ex") .tile-price').waitFor();
		await detailsIn(page);

		const start = Date.now();

		while (!log.cards.includes('en/tsa1-006') && Date.now() - start < 15000) {
			await page.waitForTimeout(100);
		}

		await page.waitForTimeout(1500);
		assert.deepEqual(log.cards.filter((path) => path.startsWith('en/')), ['en/tsa1-006'], 'only the stale record');

		const at = await page.evaluate(async () => new Promise((resolve) => {
			const open = indexedDB.open('card-tracker-catalog', 1);

			open.onsuccess = () => {
				const request = open.result.transaction('responses').objectStore('responses').get('card:en:tsa1-006');

				request.onsuccess = () => resolve(request.result.at);
			};
		}));

		assert.ok(Date.now() - at < 60000, 'saved again with a new date');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('tiles show "No price" for Asian prints at once and nothing while a price downloads', async () => {
		const {context, errors, page} = await phone({delayMs: 1500});

		await seed(page, server.origin);
		await page.locator('.tile').first().waitFor();

		const ja = page.locator('.tile', {has: page.locator('.tile-original', {hasText: 'ピカチュウ'})});
		const ko = page.locator('.tile', {has: page.locator('.tile-original', {hasText: '이상해씨'})});

		assert.equal(plain(await ja.locator('.tile-price').textContent()), 'No price');
		assert.equal(plain(await ko.locator('.tile-price').textContent()), 'No price');
		assert.equal(await page.locator('.tile:has-text("Charizard ex") .tile-price').count(), 0, 'waiting: nothing yet');
		assert.equal(plain(await page.locator('.tile:has-text("Pikachu"):not(:has(.tile-original)) .tile-price').textContent()), 'R$ 80,00', 'a Liga price at once');

		// The Value sheet counts what still waits.
		await page.click('#cards-value');
		await page.locator('.value-sheet[open]').waitFor();
		assert.equal(plain(await page.locator('.vs-coverage').textContent()), 'Priced: 1 of 10 copies');
		assert.match(plain(await page.locator('.vs-waiting').textContent()), /^7 copies still wait for a price; prices download while My Cards is open\.$/);
		await page.screenshot({path: `${SHOTS}/my-cards-value-waiting.png`});
		await page.keyboard.press('Escape');
		await page.locator('.value-sheet').waitFor({state: 'detached'});

		await page.locator('.tile:has-text("Charizard ex") .tile-price').waitFor({timeout: 30000});
		assert.deepEqual(errors, []);
		await context.close();
	});
});

describe('the Value sheet', () => {
	test('leads with coverage, labels the totals, and filters to the unpriced copies', async () => {
		const {context, errors, log, page} = await phone();

		await seed(page, server.origin);
		await page.locator('.tile').first().waitFor();
		await pricesIn(page, log);

		// No Stats toggle and no panel any more: a small Value button.
		assert.equal(await page.locator('#cards-stats-toggle, #cards-stats').count(), 0);
		assert.equal(await page.locator('.price-stats').count(), 0, 'no headline total');
		await page.click('#cards-value');
		await page.locator('.value-sheet[open]').waitFor();
		assert.equal(plain(await page.locator('.vs-coverage').textContent()), 'Priced: 7 of 10 copies');
		assert.equal(plain(await page.locator('.vs-asian').textContent()), '2 copies are Japanese, Korean, or Chinese prints with no market price.');
		assert.equal(plain(await page.locator('.vs-none').textContent()), '1 copy has no market price on TCGdex.');
		assert.equal(await page.locator('.vs-waiting').count(), 0);
		assert.equal(await page.locator('.vs-of').textContent(), 'Of the priced copies');
		assert.equal(await page.locator('.value-sheet .price-stats').getAttribute('aria-label'), 'Value of your collection');
		// 0.5 + 1.2 + 1.2 + 30 + 0.1 + 2 at R$ 5, and Pikachu's R$ 80 Liga.
		assert.equal(plain(await page.locator('.value-sheet .price-stats-total').textContent()), '~R$ 255,00');
		await noSideways(page, 'the Value sheet');
		await page.screenshot({path: `${SHOTS}/my-cards-value.png`});

		await page.click('.vs-unpriced');
		await page.locator('.value-sheet').waitFor({state: 'detached'});
		assert.equal(plain(await page.locator('.fb-chip').textContent()), 'No price×');
		assert.deepEqual((await names(page)).sort(), ['Bulbasaur', 'Pikachu', 'Test Ball']);
		assert.match(await summary(page), /^3 copies in 3 tiles match/);
		assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'cards-value', 'focus goes back to the button');
		assert.deepEqual(errors, []);
		await context.close();
	});
});

describe('layout', () => {
	for (const viewport of [{height: 740, width: 360}, {height: 844, width: 390}]) {
		for (const colorScheme of ['light', 'dark']) {
			test(`nothing is cut off at ${viewport.width} px, ${colorScheme}`, async () => {
				const {context, errors, log, page} = await phone({viewport});

				await page.emulateMedia({colorScheme});
				await seed(page, server.origin);
				await page.locator('.tile').first().waitFor();
				await detailsIn(page);
				await noSideways(page, 'My Cards');

				for (const sort of ['newest', 'oldest', 'name', 'dex', 'set', 'price']) {
					await page.selectOption('#cards-sort', sort);
				}

				await selectsFit(page, 'the bar');
				await metaFits(page, 'My Cards');

				const row = await page.evaluate(() => [...document.querySelector('.fb-row').children].map((element) => Math.round(element.getBoundingClientRect().top)));

				assert.equal(new Set(row).size, 1, `sort, Filters, and Value share one line (${row})`);

				await openFilters(page);
				await page.selectOption('#cards-f-set', 'international|tsa1');
				await page.click('#cards-sheet [data-filter="type"] [data-value="Fire"]');
				await selectsFit(page, 'the filters sheet');
				await noSideways(page, 'the filters sheet');
				await page.screenshot({path: `${SHOTS}/my-cards-filters-${viewport.width}-${colorScheme}.png`});
				await closeFilters(page);
				await pricesIn(page, log).catch(() => {});
				await page.screenshot({path: `${SHOTS}/my-cards-${viewport.width}-${colorScheme}.png`});
				assert.deepEqual(errors, []);
				await context.close();
			});
		}
	}
});

describe('a family member\'s cards', () => {
	test('read only, with the same bar', async () => {
		const {context, errors, page} = await phone();

		// The family view needs a signed-in session and the server; its
		// screen is the same one, so this checks the module still loads it.
		await page.goto(`${server.origin}${BASE}check`);

		const loaded = await page.evaluate(async () => {
			const module = await import('/pokemon-card-tracker/js/cards-view.js');

			return typeof module.familyCardsView === 'function' && typeof module.myCardsView === 'function';
		});

		assert.ok(loaded);
		assert.ok(documentWith(COPIES).cards.length);
		assert.deepEqual(errors, []);
		await context.close();
	});
});

describe('saves patch the screen', () => {
	test('an added, edited, or removed copy redraws the grid once, and a save that changes no copy draws nothing', async () => {
		const {context, errors, page} = await phone();

		await seed(page, server.origin);
		await page.locator('.tile').first().waitFor();
		await detailsIn(page);
		await page.waitForTimeout(2000);

		const before = summary(page);

		assert.match(await before, /^10 copies in 10 tiles/);

		// Counts the grid's redraws from here on.
		await page.evaluate(() => {
			const grid = document.querySelector('.card-grid');

			window.gridDraws = 0;
			new MutationObserver((changes) => {
				if (changes.some((change) => change.target === grid && change.addedNodes.length > 1)) {
					window.gridDraws++;
				}
			}).observe(grid, {childList: true});
		});

		const quiet = async (expected, what) => {
			await page.waitForTimeout(1500);
			assert.equal(await page.evaluate(() => window.gridDraws), expected, what);
		};
		const run = (work) => page.evaluate(work);

		// A wish touches no copy: nothing redraws.
		await run(async () => {
			const {addToWishlist} = await import('/pokemon-card-tracker/js/wishlist.js');

			await addToWishlist('tsa1-001', {catalog: 'international'});
		});
		await quiet(0, 'a wish draws nothing');

		// A new copy of a card already shown.
		await run(async () => {
			const {addCard} = await import('/pokemon-card-tracker/js/collection.js');

			await addCard({card_id: 'tsa1-006', catalog: 'international', language: 'en', language_source: 'manual'});
		});
		await page.waitForFunction(() => /^11 copies in 10 tiles/.test(document.getElementById('cards-summary').textContent), null, TIMEOUT);
		await quiet(1, 'an added copy redraws once');
		assert.equal(await page.locator('.tile:has-text("Charizard ex") .badge-qty').textContent(), '×2');

		// An edit: the Liga price of the Pikachu changes its tile's price.
		await run(async () => {
			const {listCards, updateCard} = await import('/pokemon-card-tracker/js/collection.js');
			const pikachu = (await listCards()).find((entry) => entry.id === 'c-07');

			await updateCard(pikachu.id, {price_manual: {...pikachu.price_manual, avg: 120, low_nm: 110}});
		});
		await quiet(2, 'an edited copy redraws once');
		assert.match(plain(await page.locator('.tile:has-text("Test Beta"):has-text("Pikachu") .tile-price').textContent()), /R\$ 120/);

		// A removed copy.
		await run(async () => {
			const {deleteCard} = await import('/pokemon-card-tracker/js/collection.js');

			await deleteCard('c-10');
		});
		await page.waitForFunction(() => /^10 copies in 9 tiles/.test(document.getElementById('cards-summary').textContent), null, TIMEOUT);
		await quiet(3, 'a removed copy redraws once');
		assert.equal(await page.locator('.tile:has-text("이상해씨")').count(), 0);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('the card index is read from the phone once per page', async () => {
		const {context, errors, page} = await phone();

		await seed(page, server.origin);
		await page.locator('.tile').first().waitFor();
		await detailsIn(page);

		const result = await page.evaluate(async () => {
			const {cardIndex, saveToCardIndex} = await import('/pokemon-card-tracker/js/catalog.js');
			const first = await cardIndex();

			// A caller's copy cannot change the kept one.
			first.clear();

			const second = await cardIndex();

			await saveToCardIndex([{catalog: 'international', id: 'tsa1-999', localizations: {en: {image: null, lang: 'en', name: 'Test Added', set_name: 'Test Alpha'}}, set_id: 'tsa1'}]);

			const third = await cardIndex();

			return {added: third.get('international|tsa1-999').localizations.en.name, second: second.size, third: third.size};
		});

		assert.equal(result.second, 9);
		assert.equal(result.third, 10);
		assert.equal(result.added, 'Test Added');
		assert.deepEqual(errors, []);
		await context.close();
	});
});

describe('card images', () => {
	const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
	const IMAGE = 'https://assets.tcgdex.net/{lang}/tst/tsa1/004/low.webp';

	// Draws one card art with the app's tile.js and waits for it to settle:
	// the image shown, or the card back.
	const art = (page, src) => page.evaluate(async (url) => {
		const {cardArt} = await import('/pokemon-card-tracker/js/tile.js');
		const frame = cardArt({name: 'Test Charmander', number: '004', setName: 'Test Alpha'}, url, {eager: true});

		document.body.append(frame);

		for (let i = 0; i < 100 && frame.classList.contains('loading'); i++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		const img = frame.querySelector('img');

		return {back: Boolean(frame.querySelector('.card-back')), fallback: frame.dataset.fallback || null, shown: img && img.naturalWidth > 0 ? img.currentSrc : null};
	}, src);

	test('the English image stands in for a Portuguese one that is not on the phone, offline', async () => {
		const context = await browser.newContext({serviceWorkers: 'allow', viewport: VIEWPORT});
		const net = {offline: false};

		await fakeServices(context, {cards: CARDS});
		await fakePokeApi(context);
		// English images send their CORS header once, Portuguese ones twice
		// (which a browser rejects in cors mode, as TCGdex does today).
		await context.route('https://assets.tcgdex.net/**', (route) => {
			const request = route.request();

			// A route still answers while the context is offline, so it
			// fails the request itself, as the network would.
			if (net.offline) {
				return route.abort('internetdisconnected');
			}

			if (request.url().includes('/en/')) {
				return route.fulfill({body: PNG, contentType: 'image/webp', headers: {'access-control-allow-origin': '*'}, status: 200});
			}

			return route.fulfill({status: 404});
		});

		const page = await context.newPage();
		const errors = [];

		page.on('pageerror', (err) => errors.push(err.message));
		await page.goto(`${server.origin}${BASE}check`);
		await page.evaluate(() => navigator.serviceWorker.ready);
		await page.reload();
		await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, TIMEOUT);

		// Online, the English image is seen once and kept by the worker.
		assert.deepEqual(await art(page, IMAGE.replace('{lang}', 'en')), {back: false, fallback: null, shown: IMAGE.replace('{lang}', 'en')});

		// Offline, the Portuguese image was never kept: the English art shows.
		await context.setOffline(true);
		net.offline = true;
		assert.deepEqual(await art(page, IMAGE.replace('{lang}', 'pt')), {back: false, fallback: 'en', shown: IMAGE.replace('{lang}', 'en')});

		// A French card the phone has neither image of shows the card back.
		assert.deepEqual(await art(page, IMAGE.replace('{lang}', 'fr').replace('004', '006')), {back: true, fallback: 'en', shown: null});

		// A Japanese image has no English stand-in.
		assert.deepEqual(await art(page, 'https://assets.tcgdex.net/ja/tst/TSJ1/025/low.webp'), {back: true, fallback: null, shown: null});
		net.offline = false;
		await context.setOffline(false);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('online, the English image stands in for a Portuguese one that fails', async () => {
		const {context, errors, page} = await phone();

		await context.route('https://assets.tcgdex.net/**', (route) => (route.request().url().includes('/en/')
			? route.fulfill({body: PNG, contentType: 'image/webp', status: 200})
			: route.fulfill({status: 404})));
		await page.goto(`${server.origin}${BASE}check`);
		assert.deepEqual(await art(page, IMAGE.replace('{lang}', 'pt')), {back: false, fallback: 'en', shown: IMAGE.replace('{lang}', 'en')});
		assert.deepEqual(errors, []);
		await context.close();
	});
});
