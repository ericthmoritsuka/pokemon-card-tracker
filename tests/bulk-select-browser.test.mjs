// Browser tests for bulk select on My Cards (js/bulk-select.js, the plans in
// js/bulk-edit.js): Select ticks tiles instead of opening them, and each
// action saves every copy of the ticked tiles at once with Undo. Stored in
// on two tiles and its Undo, Remove copies with its Undo bringing the copies
// back into their pocket, Finish skipping a card that does not come in it,
// and Select all shown ticking only what a filter shows. Headless Chromium
// at 360 x 740 against tests/pages-server.mjs, signed out.
//
// Every outside service is faked (tests/my-cards-fixtures.mjs and
// tests/fake-rates.mjs): TCGdex answers invented cards, frankfurter.dev a
// fixed rate, PokeAPI tests/fake-pokeapi.mjs. Supabase and
// ligapokemon.com.br are never requested.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/bulk-select-browser.test.mjs
// Screenshots: $SHOTS (default /tmp)/bulk-select-*.png

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {fakeRates} from './fake-rates.mjs';
import {BASE, CARDS, fakeServices, fullRecord, linkNewStyles, seed} from './my-cards-fixtures.mjs';
import {startPagesServer} from './pages-server.mjs';
import {untilInPage} from './poll.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const VIEWPORT = {height: 740, width: 360};
const SHOTS = process.env.SHOTS || '/tmp';
const TIMEOUT = {timeout: 20000};

// Tile keys, "<catalog>|<card id>|<language>", of the fixtures' copies.
const BULBASAUR = 'international|tsa1-001|en';
const CHARMANDER = 'international|tsa1-004|en';
const CHARMANDER_PT = 'international|tsa1-004|pt';
const CHARIZARD = 'international|tsa1-006|en';
const TEST_BALL_PT = 'international|tsa1-150|pt';

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

async function phone() {
	const context = await browser.newContext({serviceWorkers: 'block', viewport: VIEWPORT});

	// First, so the fixtures' own rate route answers instead.
	await fakeRates(context);

	const log = await fakeServices(context);

	await fakePokeApi(context);
	await linkNewStyles(context);

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err.message));

	const done = async () => {
		assert.deepEqual(errors, []);
		assert.deepEqual(log.other.filter((url) => /supabase|ligapokemon/.test(url)), [], 'Supabase and Liga are never requested');
		await context.close();
	};

	return {done, page};
}

const tile = (page, key) => page.locator(`.card-grid [data-bulk-key="${key}"]`);

const checked = (page) => page.locator('.card-grid [aria-checked="true"]').evaluateAll((tiles) => tiles.map((item) => item.dataset.bulkKey).sort());

const count = (page) => page.locator('#bulk-count').textContent();

const cards = (page) => page.evaluate(async () => (await import('/pokemon-card-tracker/js/collection.js')).loadDocument().then((doc) => doc.cards));

const byId = async (page) => new Map((await cards(page)).map((entry) => [entry.id, entry]));

async function open(page, options = {}) {
	await seed(page, server.origin, options);
	await page.locator('.card-grid .tile').first().waitFor(TIMEOUT);
}

async function selecting(page) {
	await page.click('#cards-select');
	await page.locator('#bulk-bar').waitFor({state: 'visible'});
}

async function action(page, id) {
	await page.click('#bulk-actions');
	await page.locator('#bulk-sheet[open]').waitFor();
	await page.click(`#${id}`);
}

async function noSideways(page, where) {
	const width = await page.evaluate(() => document.documentElement.scrollWidth);

	assert.ok(width <= page.viewportSize().width, `no sideways scroll on ${where} (${width})`);
}

describe('bulk select on My Cards', () => {
	test('two tiles ticked get a Stored in place in one save, and Undo takes it off again', async () => {
		const {done, page} = await phone();

		await open(page);
		assert.equal(await page.locator('#bulk-bar').isVisible(), false, 'no bar before Select');
		await selecting(page);
		assert.equal(await count(page), 'Tap cards to select them');
		assert.equal(await page.locator('#bulk-actions').isDisabled(), true);
		assert.equal(await tile(page, BULBASAUR).getAttribute('role'), 'checkbox');
		assert.equal(await tile(page, BULBASAUR).getAttribute('aria-checked'), 'false');

		// A tap ticks the tile instead of opening the card; Space ticks one too.
		await tile(page, BULBASAUR).click();
		await tile(page, CHARIZARD).focus();
		await page.keyboard.press(' ');
		assert.equal(new URL(page.url()).pathname, `${BASE}cards`, 'still on My Cards');
		assert.deepEqual(await checked(page), [BULBASAUR, CHARIZARD]);
		assert.equal(await count(page), '2 selected');
		assert.equal(await tile(page, BULBASAUR).locator('.bulk-check').textContent(), '✓', 'a tick, not only a colour');

		for (const id of ['cards-select', 'bulk-clear', 'bulk-done', 'bulk-all', 'bulk-actions']) {
			const box = await page.locator(`#${id}`).boundingBox().catch(() => null);

			if (box) {
				assert.ok(box.height >= 44, `#${id} is a 44 px target (${box.height})`);
			}
		}

		await noSideways(page, 'the selection bar');
		await page.screenshot({path: `${SHOTS}/bulk-select-ticked.png`});

		const docBefore = await cards(page);

		await action(page, 'bulk-store');
		await page.locator('#store-sheet[open]').waitFor();
		assert.equal(await page.locator('#store-sub').textContent(), '2 copies: every copy of the 2 selected cards. Not set clears their place.');
		await page.fill('#store-place', 'Box A');
		await page.click('#store-save');

		const toast = page.locator('.toast', {hasText: 'stored in Box A'});

		await toast.waitFor(TIMEOUT);
		assert.equal(await toast.locator('.toast-text').textContent(), '2 copies stored in Box A.');

		let after = await byId(page);

		assert.equal(after.get('c-01').storage, 'Box A');
		assert.equal(after.get('c-04').storage, 'Box A');
		assert.deepEqual([...after.values()].filter((entry) => entry.storage).map((entry) => entry.id).sort(), ['c-01', 'c-04'], 'no other copy changed');

		// The redraw after the save keeps the selection.
		assert.equal(await count(page), '2 selected');
		assert.deepEqual(await checked(page), [BULBASAUR, CHARIZARD]);

		await toast.locator('button', {hasText: 'Undo'}).click();
		await untilInPage(page, 'Undo to take the place off', async () => {
			const cardsNow = await (await import('/pokemon-card-tracker/js/collection.js')).loadDocument().then((doc) => doc.cards);

			return cardsNow.every((entry) => !entry.storage);
		});
		after = await byId(page);

		for (const entry of docBefore) {
			assert.equal(Object.hasOwn(after.get(entry.id), 'storage'), Object.hasOwn(entry, 'storage'), `${entry.id} has no storage field again`);
		}

		// Done ends it: the tiles are links again.
		await page.click('#bulk-done');
		assert.equal(await page.locator('#bulk-bar').isVisible(), false);
		assert.equal(await tile(page, BULBASAUR).getAttribute('role'), null);
		assert.equal(await page.locator('.bulk-check').count(), 0);
		await done();
	});

	test('Remove copies asks first, naming the copies and the pocket, and Undo brings them back into it', async () => {
		const {done, page} = await phone();

		await open(page);
		await selecting(page);
		await tile(page, BULBASAUR).click();
		await tile(page, CHARMANDER).click();
		await action(page, 'bulk-remove');
		await page.locator('#bulk-remove-confirm').waitFor();
		assert.equal(await page.locator('#bulk-remove-text').textContent(), 'This removes 2 copies: every copy of the 2 selected cards.');
		assert.equal(await page.locator('#bulk-remove-leaves').textContent(), 'It leaves Test binder, page 1.');
		assert.equal(await page.locator('#bulk-remove-confirm').textContent(), 'Remove 2 copies');
		await page.screenshot({path: `${SHOTS}/bulk-select-remove.png`});

		// Cancel removes nothing.
		await page.click('#bulk-remove-cancel');
		await page.locator('#bulk-sheet').waitFor({state: 'hidden'});
		assert.ok((await cards(page)).every((entry) => !entry.deleted_at));

		await action(page, 'bulk-remove');
		await page.click('#bulk-remove-confirm');

		const toast = page.locator('.toast', {hasText: 'copies removed'});

		await toast.waitFor(TIMEOUT);
		assert.equal(await toast.locator('.toast-text').textContent(), '2 copies removed. It leaves Test binder, page 1.');
		await tile(page, BULBASAUR).waitFor({state: 'detached'});

		let after = await byId(page);

		assert.ok(after.get('c-01').deleted_at && after.get('c-02').deleted_at, 'both removed');
		assert.equal(after.get('c-03').deleted_at, null, 'the Portuguese Charmander, another tile, stays');
		assert.equal(await count(page), 'Tap cards to select them', 'the removed tiles leave the selection');

		await toast.locator('button', {hasText: 'Undo'}).click();
		await tile(page, BULBASAUR).waitFor(TIMEOUT);
		await tile(page, CHARMANDER).waitFor(TIMEOUT);
		after = await byId(page);
		assert.equal(after.get('c-01').deleted_at, null);
		assert.equal(after.get('c-02').deleted_at, null);
		assert.ok(after.get('c-01').restored_at, 'restored on purpose, so the merge keeps it');
		assert.equal(after.size, 10, 'no new entry');

		const slots = await page.evaluate(async () => (await import('/pokemon-card-tracker/js/collection.js')).loadDocument().then((doc) => doc.binders[0].slots.map((slot) => slot.entry_id)));

		assert.deepEqual(slots, ['c-01'], 'Bulbasaur is back in its pocket');
		await done();
	});

	test('Finish is set only on the cards that come in it, and says how many were left as they were', async () => {
		const {done, page} = await phone();
		const card = (id) => CARDS.find((item) => item.id === id);
		const now = Date.now();
		const records = {
			'card:en:tsa1-001': {at: now, data: {...fullRecord(card('tsa1-001')), variants_detailed: [{type: 'normal', variantId: 'v1-normal'}, {type: 'reverse', variantId: 'v1-reverse'}]}},
			'card:en:tsa1-006': {at: now, data: {...fullRecord(card('tsa1-006')), variants_detailed: [{type: 'holo', variantId: 'v6-holo'}]}},
		};

		await open(page, {records});
		await selecting(page);
		await tile(page, BULBASAUR).click();
		await tile(page, CHARIZARD).click();
		await action(page, 'bulk-finish');
		await page.locator('#bulk-finish-select').waitFor(TIMEOUT);
		assert.deepEqual(await page.locator('#bulk-finish-select option').allTextContents(), ['Normal (1 of 2)', 'Reverse holo (1 of 2)', 'Holo (1 of 2)']);
		await page.selectOption('#bulk-finish-select', 'Reverse holo');
		await page.click('#bulk-save');

		const toast = page.locator('.toast', {hasText: 'Reverse holo set'});

		await toast.waitFor(TIMEOUT);
		assert.equal(await toast.locator('.toast-text').textContent(), 'Reverse holo set on 1 copy. 1 card was left as it was: it does not come in Reverse holo.');

		let after = await byId(page);

		assert.equal(after.get('c-01').variant_id, 'v1-reverse');
		assert.equal(after.get('c-04').variant_id, null, 'Charizard ex has no reverse holo');

		await toast.locator('button', {hasText: 'Undo'}).click();
		await untilInPage(page, 'Undo to put the finish back', async () => {
			const doc = await (await import('/pokemon-card-tracker/js/collection.js')).loadDocument();

			return doc.cards.find((entry) => entry.id === 'c-01').variant_id === null;
		});
		after = await byId(page);
		assert.equal(after.get('c-01').variant_id, null, 'Undo puts the finish back');
		await done();
	});

	test('Select all shown ticks only the tiles a filter shows, and they stay ticked when it is cleared', async () => {
		const {done, page} = await phone();

		await open(page, {local: {'cardTracker.cardsChoice': JSON.stringify({filters: {language: 'pt'}, sort: 'newest'})}});
		await page.waitForFunction(() => document.querySelectorAll('.card-grid .tile').length === 2);
		await selecting(page);
		assert.equal(await page.locator('#bulk-all').textContent(), 'Select all shown (2)');
		await page.click('#bulk-all');
		assert.equal(await count(page), '2 selected');
		assert.deepEqual(await checked(page), [CHARMANDER_PT, TEST_BALL_PT]);

		await page.click('.fb-clear');
		await page.waitForFunction(() => document.querySelectorAll('.card-grid .tile').length === 10);
		assert.deepEqual(await checked(page), [CHARMANDER_PT, TEST_BALL_PT], 'the English Charmander is not ticked');
		assert.equal(await count(page), '2 selected');
		assert.equal(await page.locator('#bulk-all').textContent(), 'Select all shown (10)');

		// An action applies to just those two.
		await action(page, 'bulk-fav-on');

		const toast = page.locator('.toast', {hasText: 'marked as favorites'});

		await toast.waitFor(TIMEOUT);
		assert.equal(await toast.locator('.toast-text').textContent(), '2 copies marked as favorites.');
		assert.deepEqual((await cards(page)).filter((entry) => entry.is_favorite).map((entry) => entry.id).sort(), ['c-03', 'c-05']);
		await toast.locator('button', {hasText: 'Undo'}).click();
		await untilInPage(page, 'Undo to take the stars off', async () => {
			const doc = await (await import('/pokemon-card-tracker/js/collection.js')).loadDocument();

			return doc.cards.every((entry) => !entry.is_favorite);
		});
		await done();
	});

	test('a family member\'s cards and the Trade view offer no Select', async () => {
		const {done, page} = await phone();

		await open(page);
		assert.equal(await page.locator('#cards-select').count(), 1);
		await page.goto(`${server.origin}${BASE}trade`);
		await page.locator('.view-head h2').waitFor(TIMEOUT);
		assert.equal(await page.locator('#cards-select').count(), 0, 'Trade has no Select');
		await page.goto(`${server.origin}${BASE}family/member-a`);
		await page.locator('.view-head h2').waitFor(TIMEOUT);
		assert.equal(await page.locator('#cards-select').count(), 0, 'a family member\'s cards have no Select');
		await done();
	});
});
