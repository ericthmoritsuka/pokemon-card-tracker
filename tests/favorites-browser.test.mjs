// Browser tests for favorites: the star on a card page that marks your
// copies of the card (is_favorite on every copy, in every language), the star
// on favorite tiles, the Favorites filter, and a family member's stars shown
// read only. Headless Chromium at 390 x 844 against tests/pages-server.mjs.
// Every outside service is faked; nothing leaves the machine.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/favorites-browser.test.mjs
// Screenshots: $SHOTS (default /tmp)/favorites-*.png

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {BASE, fakeServices, seed} from './my-cards-fixtures.mjs';
import {startPagesServer} from './pages-server.mjs';
import {SPARE_COPIES, familyDevice, wireTrade} from './trade-harness.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const SHOTS = process.env.SHOTS || '/tmp';
const TIMEOUT = {timeout: 20000};
// No favorites to start with.
const COPIES = SPARE_COPIES.map(({is_favorite, ...copy}) => copy);

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

async function phone(copies = COPIES) {
	const context = await browser.newContext({serviceWorkers: 'block', viewport: {height: 844, width: 390}});

	await fakeServices(context);
	await fakePokeApi(context);
	await wireTrade(context);

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err.message));
	await seed(page, server.origin, {binders: [], copies});

	return {context, errors, page};
}

// The is_favorite flag of each live copy, by ID, read from the document.
const flags = (page) => page.evaluate(async () => {
	const {listCards} = await import('/pokemon-card-tracker/js/collection.js');

	return Object.fromEntries((await listCards()).map((entry) => [entry.id, entry.is_favorite === true]));
});

const starred = (page) => page.locator('.card-grid .tile:has(.badge-fav) .tile-name').allTextContents();

describe('favorites', () => {
	test('the star on a card page marks every copy of the card, and the tiles show it', async () => {
		const {context, errors, page} = await phone();

		await page.goto(`${server.origin}${BASE}cards/en/tsa1-004`);
		await page.locator('#favorite-toggle').waitFor(TIMEOUT);
		assert.equal(await page.locator('#favorite-toggle').getAttribute('aria-pressed'), 'false');
		await page.screenshot({path: `${SHOTS}/favorites-card-off.png`});
		await page.click('#favorite-toggle');
		await page.waitForFunction(() => document.getElementById('favorite-toggle').getAttribute('aria-pressed') === 'true', null, TIMEOUT);

		const marked = await flags(page);

		// All five Charmander copies, English and Portuguese; nothing else.
		assert.deepEqual(Object.keys(marked).filter((id) => marked[id]).sort(), ['c-02', 'c-03', 'c-04', 'c-05', 'c-06']);
		assert.equal(await page.locator('#favorite-toggle').textContent(), '★');
		await page.screenshot({path: `${SHOTS}/favorites-card-on.png`});

		// My Cards: the two Charmander tiles carry the star, no other tile.
		await page.goto(`${server.origin}${BASE}cards`);
		await page.locator('.card-grid .tile').first().waitFor(TIMEOUT);
		assert.deepEqual(await starred(page), ['Charmander', 'Charmander']);
		assert.equal(await page.locator('.badge-fav').first().getAttribute('aria-label'), 'Favorite');
		await page.screenshot({path: `${SHOTS}/favorites-tiles.png`});

		// Tapping again removes the star from every copy.
		await page.goto(`${server.origin}${BASE}cards/en/tsa1-004`);
		await page.locator('#favorite-toggle[aria-pressed="true"]').waitFor(TIMEOUT);
		await page.click('#favorite-toggle');
		await page.waitForFunction(() => document.getElementById('favorite-toggle').getAttribute('aria-pressed') === 'false', null, TIMEOUT);
		assert.equal(Object.values(await flags(page)).filter(Boolean).length, 0);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('the Favorites filter keeps only starred tiles, shows a chip, and is remembered', async () => {
		const copies = COPIES.map((copy) => (['c-07', 'c-09'].includes(copy.id) ? {...copy, is_favorite: true} : copy));
		const {context, errors, page} = await phone(copies);

		await page.locator('.card-grid .tile').first().waitFor(TIMEOUT);
		await page.click('#cards-filters');
		await page.locator('#cards-sheet[open]').waitFor();
		assert.match(await page.locator('#cards-sheet [data-filter="favorite"] label').textContent(), /^Favorites only \(2\)$/);
		await page.check('#cards-f-favorite');
		await page.click('#cards-sheet .fb-show');
		await page.locator('#cards-sheet').waitFor({state: 'hidden'});
		await page.waitForFunction(() => document.querySelectorAll('.card-grid .tile').length === 2, null, TIMEOUT);
		assert.deepEqual((await page.locator('.card-grid .tile .tile-name').allTextContents()).sort(), ['Charizard ex', 'Pikachu']);
		assert.equal((await page.locator('.fb-chip').textContent()).replace(/×/, ''), 'Favorites');
		assert.match(await page.locator('#cards-filters').getAttribute('aria-label'), /1 active/);

		// Remembered on this device, like the other filters.
		await page.reload();
		await page.waitForFunction(() => document.querySelectorAll('.card-grid .tile').length === 2, null, TIMEOUT);

		// The chip clears it.
		await page.click('.fb-chip');
		await page.waitForFunction(() => document.querySelectorAll('.card-grid .tile').length > 2, null, TIMEOUT);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('the Trade view takes the Favorites filter and keeps a favorite copy', async () => {
		const copies = COPIES.map((copy) => (['c-07', 'c-08'].includes(copy.id) ? {...copy, is_favorite: true} : copy));
		const {context, errors, page} = await phone(copies);

		await page.locator('.card-grid .tile').first().waitFor(TIMEOUT);
		await page.click('#cards-trade');
		await page.waitForFunction(() => /^6 copies in 5 tiles/.test((document.querySelector('#cards-summary') || {}).textContent || ''), null, TIMEOUT);
		await page.click('#cards-filters');
		await page.locator('#cards-sheet[open]').waitFor();
		await page.check('#cards-f-favorite');
		await page.click('#cards-sheet .fb-show');
		await page.waitForFunction(() => document.querySelectorAll('.card-grid .tile').length === 1, null, TIMEOUT);
		assert.deepEqual(await page.locator('.card-grid .tile .tile-name').allTextContents(), ['Charizard ex']);
		assert.deepEqual(await starred(page), ['Charizard ex'], 'the spare of a favorite card is starred too');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a family member\'s stars show, with nothing to press', async () => {
		const memberCards = SPARE_COPIES.filter((copy) => !copy.deleted_at).map((copy) => (copy.card_id === 'tsb2-025' ? {...copy, is_favorite: true} : {...copy, is_favorite: false}));
		const {context, errors, member, page} = await familyDevice(browser, server, memberCards);

		await page.goto(`${server.origin}${BASE}family/${member.id}`);
		await page.locator('#family-strip').waitFor(TIMEOUT);
		await page.locator('.card-grid .tile').first().waitFor(TIMEOUT);
		assert.deepEqual(await starred(page), ['Pikachu'], 'the Pikachu tile carries their star');

		// The filter works on their cards.
		await page.click('#cards-filters');
		await page.locator('#cards-sheet[open]').waitFor();
		await page.check('#cards-f-favorite');
		await page.click('#cards-sheet .fb-show');
		await page.waitForFunction(() => document.querySelectorAll('.card-grid .tile').length === 1, null, TIMEOUT);

		// Their card page shows the star as text, not a button.
		await page.goto(`${server.origin}${BASE}family/${member.id}`);
		await page.locator('.card-grid .tile').first().waitFor(TIMEOUT);
		await page.click('.card-grid .tile');
		await page.locator('#copies-title').waitFor(TIMEOUT);
		await page.locator('#favorite-mark').waitFor(TIMEOUT);
		assert.equal(await page.locator('#favorite-toggle').count(), 0, 'no toggle on their card');
		await page.screenshot({path: `${SHOTS}/favorites-family.png`});
		assert.deepEqual(errors, []);
		await context.close();
	});
});
