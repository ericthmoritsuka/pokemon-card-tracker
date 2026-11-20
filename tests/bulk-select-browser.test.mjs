// Browser tests for bulk select on My Cards (js/bulk-select.js, the plans in
// js/bulk-edit.js): Select ticks tiles instead of opening them, and each
// action saves every copy of the ticked tiles at once with Undo. Stored in
// on two tiles and its Undo, Remove copies with its Undo bringing the copies
// back into their pocket, Finish skipping a card that does not come in it,
// Language moving the ticked tiles to their new keys and Undo ticking them
// again, Condition leaving a copy that already has it, Add to binder leaving
// a copy already in a pocket or a tray, and Select all shown ticking only
// what a filter shows. Headless Chromium
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
import {BASE, BINDERS, CARDS, COPIES, fakeServices, fullRecord, linkNewStyles, seed} from './my-cards-fixtures.mjs';
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

// The binders as saved: each one's pockets and tray, as id lists.
const binders = (page) => page.evaluate(async () => {
	const doc = await (await import('/pokemon-card-tracker/js/collection.js')).loadDocument();

	return doc.binders.map((binder) => ({id: binder.id, slots: binder.slots.map((slot) => slot.entry_id), staged: binder.staged || []}));
});

// Every copy's fields a bulk action may change, a field a copy never had read
// as null: the shape Undo writes back, so before and after compare equal.
const FIELDS = ['condition', 'fallback', 'language', 'language_source', 'storage'];

const fieldsOf = async (page) => Object.fromEntries((await cards(page)).map((entry) => [entry.id, Object.fromEntries(FIELDS.map((key) => [key, key === 'fallback' ? Boolean(entry[key]) : entry[key] ?? null]))]));

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

	test('Language sets a language on the cards that can be in it, leaves the rest, and Undo puts every copy back', async () => {
		const {done, page} = await phone();
		const PIKACHU_JA = 'ja|TSJ1-025|ja';

		await open(page);

		const before = await fieldsOf(page);

		await selecting(page);
		await tile(page, BULBASAUR).click();
		await tile(page, CHARIZARD).click();
		await tile(page, PIKACHU_JA).click();
		await action(page, 'bulk-language');
		await page.locator('#bulk-language-select').waitFor();
		assert.equal(await page.locator('#bulk-note').textContent(), 'A language with a count fits only some of the cards: the others stay as they are.');
		assert.ok((await page.locator('#bulk-language-select option').allTextContents()).includes('Portuguese (2 of 3)'));
		await page.selectOption('#bulk-language-select', 'pt');
		await page.click('#bulk-save');

		const toast = page.locator('.toast', {hasText: 'Portuguese set'});

		await toast.waitFor(TIMEOUT);
		assert.equal(await toast.locator('.toast-text').textContent(), 'Portuguese set on 2 copies. 1 card was left as it was: it cannot be in Portuguese.');

		let after = await fieldsOf(page);

		for (const id of ['c-01', 'c-04']) {
			assert.equal(after[id].language, 'pt', `${id} is Portuguese`);
			assert.equal(after[id].language_source, 'manual');
			assert.equal(after[id].fallback, false, 'Portuguese belongs to the international catalog');
		}

		assert.deepEqual(after['c-09'], before['c-09'], 'the Japanese card cannot be in Portuguese and is left as it was');
		assert.deepEqual(Object.keys(after).filter((id) => after[id].language !== before[id].language).sort(), ['c-01', 'c-04'], 'no other copy changed');

		// The tiles took new keys, and the selection followed them.
		const moved = ['international|tsa1-001|pt', 'international|tsa1-006|pt', PIKACHU_JA].sort();

		await tile(page, 'international|tsa1-001|pt').waitFor(TIMEOUT);
		assert.deepEqual(await checked(page), moved);
		assert.equal(await count(page), '3 selected');

		await toast.locator('button', {hasText: 'Undo'}).click();
		await untilInPage(page, 'Undo to put the language back', async () => {
			const doc = await (await import('/pokemon-card-tracker/js/collection.js')).loadDocument();

			return doc.cards.find((entry) => entry.id === 'c-01').language === 'en' && doc.cards.find((entry) => entry.id === 'c-04').language === 'en';
		});
		await tile(page, BULBASAUR).waitFor(TIMEOUT);
		after = await fieldsOf(page);
		assert.deepEqual(after, before, 'every copy is back as it was');
		assert.deepEqual(await checked(page), [BULBASAUR, CHARIZARD, PIKACHU_JA].sort(), 'the tiles are ticked again under their old keys');
		await done();
	});

	// Eric never ticked the Portuguese Charmander: after Undo it is not
	// left ticked although the English one merged into it (2026-11-19).
	test('a Language change that merges two tiles leaves after Undo exactly the ticks from before', async () => {
		const {done, page} = await phone();

		await open(page);
		await selecting(page);
		await tile(page, CHARMANDER).click();
		await tile(page, BULBASAUR).click();
		assert.deepEqual(await checked(page), [BULBASAUR, CHARMANDER].sort());
		await action(page, 'bulk-language');
		await page.locator('#bulk-language-select').waitFor();
		await page.selectOption('#bulk-language-select', 'pt');
		await page.click('#bulk-save');

		const toast = page.locator('.toast', {hasText: 'Portuguese set'});

		await toast.waitFor(TIMEOUT);
		await tile(page, 'international|tsa1-001|pt').waitFor(TIMEOUT);
		assert.equal(await tile(page, CHARMANDER).count(), 0, 'the English Charmander merged into the Portuguese one');
		assert.deepEqual(await checked(page), ['international|tsa1-001|pt', CHARMANDER_PT].sort());

		await toast.locator('button', {hasText: 'Undo'}).click();
		await untilInPage(page, 'Undo to put the language back', async () => {
			const doc = await (await import('/pokemon-card-tracker/js/collection.js')).loadDocument();

			return doc.cards.find((entry) => entry.id === 'c-02').language === 'en';
		});
		await tile(page, CHARMANDER).waitFor(TIMEOUT);
		await tile(page, BULBASAUR).waitFor(TIMEOUT);
		assert.deepEqual(await checked(page), [BULBASAUR, CHARMANDER].sort(), 'the Portuguese Charmander is not ticked');
		assert.equal(await count(page), '2 selected');
		await done();
	});

	test('Condition is set on the copies that differ, and Undo puts back each copy\'s own condition', async () => {
		const {done, page} = await phone();
		const copies = COPIES.map((copy) => {
			if (copy.id === 'c-02') {
				return {...copy, condition: 'Lightly Played'};
			}

			return copy.id === 'c-05' ? {...copy, condition: 'Near Mint'} : copy;
		});

		await open(page, {copies});

		const before = await fieldsOf(page);

		assert.equal(before['c-01'].condition, null);
		await selecting(page);
		await tile(page, BULBASAUR).click();
		await tile(page, CHARMANDER).click();
		await tile(page, TEST_BALL_PT).click();
		await action(page, 'bulk-condition');
		await page.locator('#bulk-condition-select').waitFor();
		await page.selectOption('#bulk-condition-select', 'Near Mint');
		await page.click('#bulk-save');

		const toast = page.locator('.toast', {hasText: 'Condition set'});

		await toast.waitFor(TIMEOUT);
		assert.equal(await toast.locator('.toast-text').textContent(), 'Condition set to Near Mint on 2 copies.', 'the Test Ball is Near Mint already');

		let after = await fieldsOf(page);

		assert.equal(after['c-01'].condition, 'Near Mint');
		assert.equal(after['c-02'].condition, 'Near Mint');
		assert.deepEqual(Object.keys(after).filter((id) => after[id].condition !== before[id].condition).sort(), ['c-01', 'c-02'], 'no other copy changed');
		assert.equal(await count(page), '3 selected');

		await toast.locator('button', {hasText: 'Undo'}).click();
		await untilInPage(page, 'Undo to put the conditions back', async () => {
			const doc = await (await import('/pokemon-card-tracker/js/collection.js')).loadDocument();

			return doc.cards.find((entry) => entry.id === 'c-02').condition === 'Lightly Played';
		});
		after = await fieldsOf(page);
		assert.deepEqual(after, before, 'every copy is back as it was');
		await done();
	});

	test('Add to binder puts the loose copies in the tray, leaves copies already in a pocket or tray, and Undo takes them out', async () => {
		const {done, page} = await phone();
		// Bulbasaur (c-01) sits in Test binder's pocket, and Charizard ex (c-04)
		// in the tray of Other binder.
		const other = {...BINDERS[0], id: 'b-2', name: 'Other binder', slots: [], staged: ['c-04']};

		await open(page, {binders: [BINDERS[0], other]});

		const before = await binders(page);
		const cardsBefore = await fieldsOf(page);

		await selecting(page);
		await tile(page, BULBASAUR).click();
		await tile(page, CHARMANDER).click();
		await tile(page, CHARIZARD).click();
		await tile(page, TEST_BALL_PT).click();
		await action(page, 'bulk-binder');
		await page.locator('#bulk-binder-list').waitFor();
		assert.equal(await page.locator('#bulk-binder-intro').textContent(), 'Choose a binder for 2 copies. They wait in its tray until you place them. Binders made from a list are not shown.');
		assert.equal(await page.locator('#bulk-binder-kept').textContent(), '2 copies already in a pocket or a tray stay where they are.');
		await page.click('#bulk-binder-list [data-binder="b-1"]');

		const toast = page.locator('.toast', {hasText: 'added to the tray'});

		await toast.waitFor(TIMEOUT);
		assert.equal(await toast.locator('.toast-text').textContent(), '2 copies added to the tray of Test binder.');

		let after = await binders(page);
		const binder = (list, id) => list.find((item) => item.id === id);

		assert.deepEqual(binder(after, 'b-1').staged.slice().sort(), ['c-02', 'c-05'], 'the two loose copies are in the tray');
		assert.deepEqual(binder(after, 'b-1').slots, ['c-01'], 'Bulbasaur stays in its pocket');
		assert.deepEqual(binder(after, 'b-2').staged, ['c-04'], 'Charizard ex stays in the other binder\'s tray');
		assert.deepEqual(binder(after, 'b-2').slots, []);
		assert.deepEqual(await fieldsOf(page), cardsBefore, 'no copy itself changed');

		await toast.locator('button', {hasText: 'Undo'}).click();
		await untilInPage(page, 'Undo to take the copies out of the tray', async () => {
			const doc = await (await import('/pokemon-card-tracker/js/collection.js')).loadDocument();

			return !(doc.binders.find((item) => item.id === 'b-1').staged || []).length;
		});
		after = await binders(page);
		assert.deepEqual(after, before, 'every binder is back as it was');
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

		await page.click('#cards-clear-all');
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
