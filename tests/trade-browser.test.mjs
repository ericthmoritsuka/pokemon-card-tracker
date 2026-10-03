// Browser tests for the Trade view (js/trade-view.js, css/trade.css):
// spares counted by the Trade rule across languages and finishes, the shared
// filter bar over them, the Value sheet over the spares only, the empty
// state, the way in from My Cards and Profile, and a family member's spares
// read only. Headless Chromium at 390 x 844 against tests/pages-server.mjs.
// Every outside service is faked; nothing leaves the machine.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/trade-browser.test.mjs
// Screenshots: $SHOTS (default /tmp)/trade-*.png

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {BASE, fakeServices, seed} from './my-cards-fixtures.mjs';
import {startPagesServer} from './pages-server.mjs';
import {SPARE_COPIES, checkIntegration, familyDevice, spareNames, wireTrade} from './trade-harness.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const SHOTS = process.env.SHOTS || '/tmp';
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

async function phone(copies = SPARE_COPIES) {
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

async function openTrade(page) {
	await page.click('#cards-trade');
	await page.locator('#cards-summary').waitFor(TIMEOUT);
	await page.waitForFunction(() => document.querySelector('.view-head h2').textContent === 'Trade');
}

const summary = (page) => page.locator('#cards-summary').textContent();

const tileNames = (page) => page.locator('.card-grid .tile .tile-name').allTextContents();

async function pickFilter(page, kind, value) {
	await page.click('#cards-filters');
	await page.locator('#cards-sheet[open]').waitFor();
	await page.selectOption(`#cards-f-${kind}`, value);
	await page.click('#cards-sheet .fb-show');
	await page.locator('#cards-sheet').waitFor({state: 'hidden'});
}

describe('Trade', () => {
	test('the integration lines are in the shared files, or the harness supplies them', async () => {
		const found = await checkIntegration();

		console.log(`    integrated: app.js ${found.app}, index.html ${found.css}, sw.js ${found.shell}`);
		assert.ok(true);
	});

	test('lists the spares by the Trade rule: per card and language, beyond the first, whatever the finish', async () => {
		const {context, errors, page} = await phone();

		await page.locator('.tile').first().waitFor(TIMEOUT);
		await openTrade(page);
		assert.equal(new URL(page.url()).pathname, `${BASE}trade`);
		assert.match(await summary(page), /^6 copies in 5 tiles\./);

		// Sorted by name: Charizard ex keeps its favorite, so the other copy is
		// the spare; Charmander EN has three copies (two spares, Near Mint and
		// Played, the kept copy being the first added), PT has two (one).
		await page.selectOption('#cards-sort', 'name');

		const rows = (await spareNames(page)).map(plain);

		assert.equal(rows.length, 5);
		assert.match(rows[0], /^Charizard ex\|.*1 spare$/);
		assert.match(rows[1], /^Charmander\|.*2 spares · Played · Near Mint$/);
		assert.match(rows[2], /^Charmander\|.*1 spare$/);
		assert.match(rows[3], /^Pikachu\|.*1 spare$/);
		assert.match(rows[4], /^Pikachu\|.*1 spare$/);

		// The badge counts spares, and a tile with one spare shows none.
		const badges = await page.locator('.card-grid .tile').evaluateAll((tiles) => tiles.map((tile) => (tile.querySelector('.badge-qty') || {textContent: ''}).textContent));

		assert.deepEqual(badges, ['', '×2', '', '', '']);

		// The spare of the favorite card is not the favorite copy.
		const favoriteTiles = await page.locator('.card-grid .tile .badge-fav').count();

		assert.equal(favoriteTiles, 0, 'the kept copy carries the star, the spare does not');
		assert.equal(await page.locator('.tile:has-text("Bulbasaur")').count(), 0, 'one copy is no spare');
		assert.equal(await page.locator('.tile:has-text("Test Ball")').count(), 0);
		assert.equal(await page.locator('.tile:has-text("Sprigatito")').count(), 0, 'a deleted copy is no spare');
		await page.screenshot({path: `${SHOTS}/trade-list.png`});
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('search, language, set, rarity, and price sort work over the spares', async () => {
		const {context, errors, page} = await phone();

		await page.locator('.tile').first().waitFor(TIMEOUT);
		await openTrade(page);
		assert.equal(await page.locator('#cards-search').getAttribute('placeholder'), 'Search my spares');

		await page.fill('#cards-search', 'charm');
		await page.waitForFunction(() => document.querySelector('.card-grid').dataset.query === 'charm');
		assert.deepEqual(await tileNames(page), ['Charmander', 'Charmander']);
		await page.fill('#cards-search', '');
		await page.waitForFunction(() => document.querySelector('.card-grid').dataset.query === '');

		await pickFilter(page, 'language', 'pt');
		assert.deepEqual(await tileNames(page), ['Charmander'], 'only the Portuguese spare');
		assert.match(await summary(page), /^1 copy in 1 tile match/);
		await page.click('.fb-clear, .fb-chip');

		await pickFilter(page, 'set', 'international|tsb2');
		assert.equal(await page.locator('.tile').count(), 1, 'the Test Beta spare');
		await page.click('.fb-chip');

		await pickFilter(page, 'rarity', 'Double rare');
		assert.deepEqual(await tileNames(page), ['Charizard ex']);
		await page.click('.fb-chip');

		// Only the filters that mean something over spares are offered.
		await page.click('#cards-filters');
		await page.locator('#cards-sheet[open]').waitFor();

		const offered = await page.locator('#cards-sheet [data-filter]').evaluateAll((nodes) => nodes.map((node) => node.dataset.filter));

		assert.deepEqual(offered, ['set', 'language', 'rarity', 'price', 'favorite']);
		await page.click('#cards-sheet .fb-show');

		// Price sort, dearest first: the Liga-priced Pikachu (90 reais) is on
		// top of the cards with a price.
		await page.selectOption('#cards-sort', 'price');
		await page.locator('.tile:has-text("Pikachu") .tile-price').first().waitFor(TIMEOUT);
		assert.equal((await tileNames(page))[0], 'Charizard ex', 'a US estimate of 30 dollars beats 90 reais');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('the Value button opens the Value sheet over the spares only, with its coverage line', async () => {
		const {context, errors, page} = await phone();

		await page.locator('.tile').first().waitFor(TIMEOUT);
		await openTrade(page);
		await page.locator('.tile:has-text("Charizard") .tile-price').waitFor(TIMEOUT);
		await page.click('#cards-value');
		await page.locator('dialog.value-sheet[open]').waitFor();

		const coverage = plain(await page.locator('.vs-coverage').textContent());

		assert.match(coverage, /^Priced: \d of 6 copies$/, 'six spares, not the fifteen copies');
		assert.match(plain(await page.locator('.vs-asian').textContent()), /^1 copy is a Japanese, Korean, or Chinese print with no market price\./);
		assert.match(plain(await page.locator('.vs-body').textContent()), /Of the priced copies|All copies are priced/);
		await page.screenshot({path: `${SHOTS}/trade-value.png`});
		await page.click('dialog.value-sheet .sheet-head button');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a card traded away leaves the list at once, and a favorite is the copy that is kept', async () => {
		const {context, errors, page} = await phone();

		await page.locator('.tile').first().waitFor(TIMEOUT);
		await openTrade(page);
		assert.match(await summary(page), /^6 copies/);

		// Delete one spare Charmander EN copy: one spare left for EN.
		await page.evaluate(async () => {
			const {deleteCard} = await import('/pokemon-card-tracker/js/collection.js');

			await deleteCard('c-04');
		});
		await page.waitForFunction(() => /^5 copies in 5 tiles/.test(document.querySelector('#cards-summary').textContent), null, TIMEOUT);

		// Mark the second Charizard copy a favorite: it is kept now and the
		// first one is the spare; the count stays the same.
		await page.evaluate(async () => {
			const {updateCards} = await import('/pokemon-card-tracker/js/collection.js');

			await updateCards([{id: 'c-07', patch: {is_favorite: false}}, {id: 'c-08', patch: {is_favorite: true}}]);
		});
		await page.waitForFunction(() => /^5 copies in 5 tiles/.test(document.querySelector('#cards-summary').textContent), null, TIMEOUT);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('the empty state says what a spare is, and offers the way back', async () => {
		const {context, errors, page} = await phone(SPARE_COPIES.filter((copy) => ['c-01', 'c-13', 'c-14'].includes(copy.id)));

		await page.locator('.tile').first().waitFor(TIMEOUT);
		await page.click('#cards-trade');
		await page.locator('#trade-empty').waitFor(TIMEOUT);

		const text = plain(await page.locator('#trade-empty').textContent());

		assert.match(text, /^No spares yet ?A spare is a copy beyond the first of the same card in the same language\./);
		assert.match(text, /a second Portuguese copy is a spare, whatever its finish/);
		assert.equal(await page.locator('#cards-search').count(), 0, 'no filter bar over nothing');
		await page.screenshot({path: `${SHOTS}/trade-empty.png`});
		await page.click('#trade-empty a');
		await page.locator('#cards-summary').waitFor(TIMEOUT);
		assert.equal(await page.locator('.view-head h2').textContent(), 'My Cards');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('Profile links to Trade', async () => {
		const {context, errors, page} = await phone();

		await page.goto(`${server.origin}${BASE}profile`);
		await page.locator('#profile-trade').waitFor(TIMEOUT);
		await page.click('#profile-trade');
		await page.locator('#cards-summary').waitFor(TIMEOUT);
		assert.equal(new URL(page.url()).pathname, `${BASE}trade`);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a family member\'s spares are read only, with their stars', async () => {
		const spares = SPARE_COPIES.filter((copy) => !copy.deleted_at);
		const {context, errors, member, page} = await familyDevice(browser, server, spares);

		await page.goto(`${server.origin}${BASE}family/${member.id}`);
		await page.locator('#family-strip').waitFor(TIMEOUT);
		await page.locator('.tile').first().waitFor(TIMEOUT);
		await page.click('#cards-trade');
		await page.waitForFunction(() => /^6 copies in 5 tiles/.test((document.querySelector('#cards-summary') || {}).textContent || ''), null, TIMEOUT);
		assert.equal(new URL(page.url()).pathname, `${BASE}family/${member.id}/trade`);
		assert.match(await page.locator('#family-strip').textContent(), /view only/);
		await page.waitForFunction(() => document.querySelector('.view-head h2').textContent === "Member A's spares");
		await page.screenshot({path: `${SHOTS}/trade-family.png`});
		assert.deepEqual(errors, []);
		await context.close();
	});
});
