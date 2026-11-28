// A binder from a list never lays itself out in Pokédex order from numbers
// the phone does not have yet (QA-3, 2026-11-27): it reads them first, and
// when it cannot, it says so and leaves the pockets where they are.
//
// The card index an import leaves has names and sets only; a card's Pokédex
// numbers come from TCGdex's details, one request per set. Before, a binder
// made in that moment sorted by collector number, and moved its pockets
// into Pokédex order when the details arrived.
//
// Run: PLAYWRIGHT=<path to playwright> node --test tests/binder-order-stable-browser.test.mjs

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';
import {fakeRates} from './fake-rates.mjs';

let chromium = null;

try {
	({chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT || 'playwright'));
}
catch {
	// No Playwright: the browser tests are skipped below.
}

const BASE = '/pokemon-card-tracker/';
const AT = '2026-09-01T00:00:00.000Z';

const card = (id, cardId) => ({card_id: cardId, catalog: 'international', created_at: AT, deleted_at: null, id, language: 'en', language_source: 'import', updated_at: AT});

// Four owned prints of one made-up set, whose collector numbers run in the
// opposite order to their Pokédex numbers: by number Spark, Sprout, Splash,
// Ember; by Pokédex number Sprout, Ember, Splash, Spark.
const CARDS = [card('c1', 'tst1-001'), card('c2', 'tst1-004'), card('c3', 'tst1-007'), card('c4', 'tst1-010')];

const SET_CARDS = [
	{id: 'tst1-001', localId: '001', name: 'Test Spark', rarity: 'Common'},
	{id: 'tst1-004', localId: '004', name: 'Test Sprout', rarity: 'Common'},
	{id: 'tst1-007', localId: '007', name: 'Test Splash', rarity: 'Common'},
	{id: 'tst1-010', localId: '010', name: 'Test Ember', rarity: 'Common'},
];

const DEX = [
	{category: 'Pokemon', dexId: [25], id: 'tst1-001', illustrator: 'Rina Testa', rarity: 'Common', types: ['Lightning']},
	{category: 'Pokemon', dexId: [1], id: 'tst1-004', illustrator: 'Rina Testa', rarity: 'Common', types: ['Grass']},
	{category: 'Pokemon', dexId: [7], id: 'tst1-007', illustrator: 'Rina Testa', rarity: 'Common', types: ['Water']},
	{category: 'Pokemon', dexId: [4], id: 'tst1-010', illustrator: 'Rina Testa', rarity: 'Common', types: ['Fire']},
];

// Cards that never have a number from TCGdex: a Pokémon with a null dexId,
// a Trainer, and a Korean print with a null dexId (its name, 리자몽, is
// Charizard, #6). A tenth-set card whose set TCGdex does not have (404).
DEX.push(
	{category: 'Pokemon', dexId: null, id: 'tst1-013', illustrator: 'Rina Testa', rarity: 'Common', types: ['Colorless']},
	{category: 'Trainer', dexId: null, id: 'tst1-090', illustrator: 'Rina Testa', rarity: 'Common', types: []}
);

const DETAILS_KO = [{category: 'Pokemon', dexId: null, id: 'm6-005', illustrator: null, rarity: 'Common', types: ['Water']}];

const BY_DEX = ['tst1-004', 'tst1-010', 'tst1-007', 'tst1-001'];
const BY_NUMBER = ['tst1-001', 'tst1-004', 'tst1-007', 'tst1-010'];

// The index as an import leaves it: names and sets, no details.
const RECORDS = SET_CARDS.map((item) => ({
	catalog: 'international',
	collector_number: item.localId,
	id: item.id,
	localizations: {en: {image: null, lang: 'en', name: item.name, set_name: 'Test set one'}},
	set_id: 'tst1',
}));

const MORE_RECORDS = [
	{catalog: 'international', collector_number: '013', id: 'tst1-013', localizations: {en: {image: null, lang: 'en', name: 'Test Mystery', set_name: 'Test set one'}}, set_id: 'tst1'},
	{catalog: 'international', collector_number: '090', id: 'tst1-090', localizations: {en: {image: null, lang: 'en', name: 'Test Potion', set_name: 'Test set one'}}, set_id: 'tst1'},
	{catalog: 'international', collector_number: '003', id: 'tst9-003', localizations: {en: {image: null, lang: 'en', name: 'Test Lost', set_name: 'Test set nine'}}, set_id: 'tst9'},
	{catalog: 'ko', collector_number: '005', id: 'm6-005', localizations: {ko: {image: null, lang: 'ko', name: '리자몽', set_name: '테스트 세트'}}, set_id: 'm6'},
];

const MIXED_CARDS = [
	...CARDS,
	{...card('c5', 'tst9-003')},
	{...card('c6', 'tst1-013')},
	{...card('c7', 'tst1-090')},
	{...card('c8', 'm6-005'), catalog: 'ko', language: 'ko'},
];

const MIXED = {created_at: AT, deleted_at: null, entry_ids: Object.fromEntries(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8'].map((id) => [id, AT])), id: 'col-1', kind: 'hand', name: 'Mixed picks', rule: null, updated_at: AT};

const SET_GOAL = {catalog: 'international', created_at: AT, deleted_at: null, id: 'goal-1', kind: 'set', level: 'secrets', name: 'Test set one', target: 'tst1', updated_at: AT};

const documentWith = (binders = [], {cards = CARDS, collections = []} = {}) => ({
	binders,
	cards,
	collections,
	goals: [SET_GOAL],
	openings: [],
	person: 'local',
	updated_at: AT,
	user_id: null,
	version: 1,
	wishlist: [],
});

let browser;
let pages;
let origin;

const url = (path = '') => `${origin}${BASE}${path}`;

// net.delay: how long TCGdex takes to answer the details; net.details:
// 'answer', 'fail' (an error at once), or 'hang' (no answer at all).
async function device(net) {
	const {fakePokeApi} = await import('./fake-pokeapi.mjs');
	const context = await browser.newContext({serviceWorkers: 'block', viewport: {height: 844, width: 390}});

	await fakeRates(context);
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await fakePokeApi(context, {offline: () => false});
	await context.route('https://api.tcgdex.net/**', async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname.replace('/v2/', '');
		const json = (body) => route.fulfill({body: JSON.stringify(body), contentType: 'application/json', status: 200});

		if (path === 'graphql') {
			const {query} = JSON.parse(request.postData() || '{}');

			if (/\bid dexId\b/.test(query)) {
				net.asked++;

				if (net.details === 'fail') {
					return route.abort('connectionrefused');
				}

				if (net.details === 'hang') {
					return new Promise(() => {});
				}

				await new Promise((resolve) => setTimeout(resolve, net.delay));

				const setId = /id: "([^"]+)-"/.exec(query)[1];

				// A set TCGdex does not have answers 404.
				if (setId === 'tst9') {
					return route.fulfill({body: '{}', contentType: 'application/json', status: 404});
				}

				return json({data: {cards: setId === 'm6' ? DETAILS_KO : DEX}});
			}

			if (query.includes('"tst1-"')) {
				return json({data: {cards: SET_CARDS}});
			}

			return json({data: {cards: []}});
		}

		if (path === 'en/sets/tst1') {
			return json({cardCount: {official: 4, total: 4}, cards: SET_CARDS, id: 'tst1', name: 'Test set one', releaseDate: '2024-01-01'});
		}

		return route.fulfill({body: '{}', contentType: 'application/json', status: 404});
	});
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));
	await context.route(/githubusercontent/, (route) => route.abort());
	await context.route('https://*.supabase.co/**', (route) => {
		throw new Error(`Unexpected Supabase request: ${route.request().url()}`);
	});

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err));

	return {context, errors, page};
}

async function seedLocal(page, doc, records = RECORDS) {
	await page.goto(url('cards'));
	await page.evaluate(async ({cards, stored}) => {
		await new Promise((resolve, reject) => {
			const open = indexedDB.open('card-tracker-collection', 1);

			open.onupgradeneeded = () => open.result.createObjectStore('documents');
			open.onsuccess = () => {
				const tx = open.result.transaction('documents', 'readwrite');

				tx.objectStore('documents').put(stored, 'local');
				tx.oncomplete = () => {
					open.result.close();
					resolve();
				};
				tx.onerror = () => reject(tx.error);
			};
			open.onerror = () => reject(open.error);
		});
		await (await import('/pokemon-card-tracker/js/catalog.js')).saveToCardIndex(cards);
	}, {cards: records, stored: doc});
	await page.reload();
}

const localDoc = (page) => page.evaluate(async () => (await import('/pokemon-card-tracker/js/collection.js')).loadDocument());

// The cards' ids in a binder's stored pocket order.
const storedOrder = (binder) => binder.snapshot.keys.map((key) => key.split('|').pop());

// The names the first page's pockets show, in pocket order.
const shownNames = (page) => page.locator('#bs-zoom-sheet .pocket, #bs-spread:not([hidden]) .bs-page[data-page="1"] .pocket').evaluateAll((nodes) => nodes
	.map((node) => node.getAttribute('aria-label') || '')
	.map((label) => label.replace(/^Page 1, pocket \d+: /, '').split(/[,:]/)[0])
	.filter((name) => name && name !== 'Empty'));

describe('a binder from a list keeps its order (QA-3, 2026-11-27)', {skip: chromium ? false : 'Playwright is not installed; set PLAYWRIGHT'}, () => {
	before(async () => {
		const {startPagesServer} = await import('./pages-server.mjs');

		pages = await startPagesServer();
		origin = pages.origin;
		browser = await chromium.launch();
	});

	after(async () => {
		await browser?.close();
		await pages?.close();
	});

	test('made while the details are slow, the binder is in Pokédex order from the first view, and stays there', async () => {
		const net = {asked: 0, delay: 1500, details: 'answer'};
		const {context, errors, page} = await device(net);

		await seedLocal(page, documentWith());
		await page.goto(url('binders/new/goal/goal-1'));
		await page.waitForSelector('#rule-section');
		assert.equal(await page.locator('#rule-order').inputValue(), 'dex', 'Pokédex number is the order the form starts on');

		// The wait is shown, then the count.
		await page.waitForFunction(() => (document.getElementById('rule-count') || {}).textContent === 'Reading Pokédex numbers…', null, {timeout: 10000});
		await page.waitForFunction(() => /^4 pockets \(4 with a card you own\)/.test((document.getElementById('rule-count') || {}).textContent), null, {timeout: 15000});
		await page.fill('#binder-name', 'Test set binder');
		await page.click('#binder-save');
		await page.waitForSelector('#binder-spread .bs-page');

		let doc = await localDoc(page);
		const [binder] = doc.binders;

		assert.deepEqual(storedOrder(binder), BY_DEX, 'saved in Pokédex order, not collector order');
		assert.deepEqual(await shownNames(page), ['Test Sprout', 'Test Ember', 'Test Splash', 'Test Spark']);

		// Open it again after the details have long arrived: nothing moves.
		await page.goto(url('cards'));
		await page.waitForTimeout(2500);
		await page.goto(url(`binders/${binder.id}`));
		await page.waitForSelector('#binder-spread .bs-page');
		await page.waitForTimeout(1500);
		doc = await localDoc(page);
		assert.deepEqual(storedOrder(doc.binders[0]), BY_DEX);
		assert.deepEqual(await shownNames(page), ['Test Sprout', 'Test Ember', 'Test Splash', 'Test Spark']);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('when the details cannot be read, no binder is made, and the form says why', async () => {
		const net = {asked: 0, delay: 0, details: 'fail'};
		const {context, errors, page} = await device(net);

		await seedLocal(page, documentWith());
		await page.goto(url('binders/new/goal/goal-1'));
		await page.waitForSelector('#rule-section');
		await page.waitForFunction(() => /Pokédex numbers/.test((document.getElementById('rule-count') || {}).textContent) && !/Reading/.test(document.getElementById('rule-count').textContent), null, {timeout: 15000});
		assert.match(await page.locator('#rule-count').textContent(), /Pokédex order/);
		await page.click('#binder-save');
		await page.waitForFunction(() => /Pokédex/.test((document.getElementById('binder-form-error') || {}).textContent), null, {timeout: 15000});
		assert.deepEqual((await localDoc(page)).binders, [], 'nothing was saved');

		// Set and number order does not need them.
		await page.selectOption('#rule-order', 'set');
		await page.waitForFunction(() => /^4 pockets \(4 with a card you own\)/.test((document.getElementById('rule-count') || {}).textContent), null, {timeout: 15000});
		await page.click('#binder-save');
		await page.waitForSelector('#binder-spread .bs-page');
		assert.deepEqual(storedOrder((await localDoc(page)).binders[0]), BY_NUMBER);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a binder in Pokédex order opened on a phone without the details keeps its pockets', async () => {
		const net = {asked: 0, delay: 0, details: 'fail'};
		const {context, errors, page} = await device(net);
		const stored = {
			at: AT,
			keys: BY_DEX.map((id) => `international|${id}`),
			rule_key: null,
			shown: {},
		};
		const binder = {
			art: [], cols: 2, cover_color: '#1b1b1f', created_at: AT, deleted_at: null, id: 'b-dex', name: 'Dex binder', notes: '',
			page_count: 1, rows: 2, rule: {order: 'dex', source: {id: 'goal-1', kind: 'goal'}}, slots: [], snapshot: stored, updated_at: AT,
		};

		// The rule key is the module's own, so ask it.
		await seedLocal(page, documentWith());
		stored.rule_key = await page.evaluate(async (rule) => (await import('/pokemon-card-tracker/js/binder-rules.js')).ruleKey(rule), binder.rule);
		await seedLocal(page, documentWith([binder]));
		await page.goto(url('binders/b-dex'));
		await page.waitForSelector('#binder-spread .bs-page');
		await page.waitForTimeout(2500);

		const doc = await localDoc(page);

		assert.deepEqual(storedOrder(doc.binders[0]), BY_DEX, 'not put in collector order');
		assert.deepEqual(await shownNames(page), ['Test Sprout', 'Test Ember', 'Test Splash', 'Test Spark']);
		assert.ok(net.asked > 0, 'the details were asked for');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a read that takes longer than the wait gives up and says the numbers are unread', async () => {
		const net = {asked: 0, delay: 0, details: 'hang'};
		const {context, errors, page} = await device(net);

		await seedLocal(page, documentWith());
		await page.goto(url('goals'));

		const result = await page.evaluate(async () => {
			const {loadDocument} = await import('/pokemon-card-tracker/js/collection.js');
			const {loadRuleItems} = await import('/pokemon-card-tracker/js/binder-sources.js');
			const started = Date.now();
			const loaded = await loadRuleItems({order: 'dex', source: {id: 'goal-1', kind: 'goal'}}, await loadDocument(), {dexWaitMs: 400, readDex: true});

			return {elapsed: Date.now() - started, gaps: loaded.gaps.map((gap) => gap.kind), incomplete: loaded.incomplete};
		});

		assert.equal(result.incomplete, true);
		assert.deepEqual(result.gaps, ['dex']);
		assert.ok(result.elapsed < 8000, `it did not wait for ever: ${result.elapsed} ms`);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a set TCGdex does not have, a null dexId, a Trainer, and a Korean print are never waited on: the names that can are read, the rest follow the numbered ones', async () => {
		const net = {asked: 0, delay: 0, details: 'answer'};
		const {context, errors, page} = await device(net);

		await seedLocal(page, documentWith([], {cards: MIXED_CARDS, collections: [MIXED]}), [...RECORDS, ...MORE_RECORDS]);
		await page.goto(url('binders/new/collection/col-1'));
		await page.waitForSelector('#rule-section');
		await page.selectOption('#rule-order', 'dex');
		await page.waitForFunction(() => /^8 pockets \(8 with a card you own\)/.test((document.getElementById('rule-count') || {}).textContent), null, {timeout: 15000});
		assert.doesNotMatch(await page.locator('#rule-count').textContent(), /could not be read/);
		await page.fill('#binder-name', 'Mixed binder');
		await page.click('#binder-save');
		await page.waitForSelector('#binder-spread .bs-page');

		const first = storedOrder((await localDoc(page)).binders[0]);

		// 1 Sprout, 4 Ember, the Korean 리자몽 (6, read from its name), 7 Splash,
		// 25 Spark; then no number.
		assert.deepEqual(first.slice(0, 5), ['tst1-004', 'tst1-010', 'm6-005', 'tst1-007', 'tst1-001']);
		assert.deepEqual(first.slice(5), ['tst1-013', 'tst1-090', 'tst9-003'], 'no number: after the numbered ones, in a stable order');

		// Opened again, and refreshed: the same, and nothing waits.
		await page.goto(url('binders/' + (await localDoc(page)).binders[0].id));
		await page.waitForSelector('#binder-spread .bs-page');
		await page.waitForTimeout(1500);
		assert.deepEqual(storedOrder((await localDoc(page)).binders[0]), first);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a failing set is waited for once, then left alone on later openings, and asked again by a form or Refresh', async () => {
		const net = {asked: 0, delay: 0, details: 'hang'};
		const {context, errors, page} = await device(net);

		await seedLocal(page, documentWith());
		await page.goto(url('goals'));

		const look = (options) => page.evaluate(async (opts) => {
			const {loadDocument} = await import('/pokemon-card-tracker/js/collection.js');
			const {loadRuleItems} = await import('/pokemon-card-tracker/js/binder-sources.js');
			const started = Date.now();
			const loaded = await loadRuleItems({order: 'dex', source: {id: 'goal-1', kind: 'goal'}}, await loadDocument(), {readDex: true, ...opts});

			return {elapsed: Date.now() - started, gaps: loaded.gaps.map((gap) => gap.kind), incomplete: loaded.incomplete};
		}, options);

		const one = await look({dexWaitMs: 500});

		assert.deepEqual(one.gaps, ['dex']);
		assert.ok(one.elapsed >= 450, `waited for the answer: ${one.elapsed} ms`);

		const asked = net.asked;
		const two = await look({dexWaitMs: 5000});

		assert.deepEqual(two.gaps, ['dex'], 'still held');
		assert.ok(two.elapsed < 2500, `not waited for again: ${two.elapsed} ms`);
		assert.equal(net.asked, asked, 'not asked again');

		const three = await look({dexWaitMs: 500, force: true});

		assert.deepEqual(three.gaps, ['dex']);
		assert.ok(three.elapsed >= 450, `Refresh asks again: ${three.elapsed} ms`);
		assert.ok(net.asked > asked, 'asked again');
		assert.deepEqual(errors, []);
		await context.close();
	});
});
