// Browser tests for Lay out from a list (js/binder-layout.js; Eric,
// 2026-11-06): a checklist's Pokémon as placeholders in a hand-made
// binder's empty pockets, with the preview, pages added for what does not
// fit, owned copies filled in, Undo, and a copy added later filling a
// Pokémon's placeholder by itself.
// Headless Chromium against tests/pages-server.mjs, signed out. TCGdex is
// faked (GraphQL answers the Pokédex numbers of the invented cards, the
// rest 404), PokeAPI by tests/fake-pokeapi.mjs; Supabase and
// ligapokemon.com.br are never contacted. Cards and binders are invented.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/binder-layout-browser.test.mjs
// Screenshots: $SHOTS, else /tmp/binder-layout

import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const SHOTS = process.env.SHOTS || '/tmp/binder-layout';
const PHONE = {height: 740, width: 360};
const AT = '2026-11-01T00:00:00.000Z';

const card = (id, cardId, fields = {}) => ({card_id: cardId, catalog: 'international', created_at: AT, deleted_at: null, id, language: 'en', language_source: 'manual', updated_at: AT, ...fields});

const record = (id, name, dex) => ({
	catalog: 'international',
	category: 'Pokemon',
	collector_number: id.split('-')[1],
	dex_ids: dex,
	id,
	illustrator: null,
	localizations: {en: {image: null, lang: 'en', name, set_name: 'Test set'}},
	rarity: 'Common',
	release_date: '2024-01-01',
	set_id: id.split('-')[0],
	types: ['Grass'],
});

const RECORDS = [
	record('tst1-001', 'Test Sprout', [1]),
	record('tst1-004', 'Test Ember', [4]),
	record('tst1-007', 'Test Splash', [7]),
	record('tst3-152', 'Test Leaf', [152]),
	record('tst3-155', 'Test Flame', [155]),
];

// What TCGdex's GraphQL answers for every card's Pokédex numbers.
const DEX = RECORDS.map((item) => ({dexId: item.dex_ids, id: item.id}));

const hand = (id, name, slots, fields = {}) => ({art: [], cols: 3, cover_color: '#1d2e60', created_at: AT, deleted_at: null, id, name, notes: '', page_count: 2, rows: 3, slots, updated_at: AT, ...fields});

const documentWith = (extra = {}) => ({
	binders: [],
	cards: [],
	collections: [],
	goals: [],
	openings: [],
	person: 'local',
	updated_at: AT,
	user_id: null,
	version: 1,
	wishlist: [],
	...extra,
});

let server;
let browser;

before(async () => {
	await mkdir(SHOTS, {recursive: true});
	server = await startPagesServer();
	browser = await chromium.launch();
});

after(async () => {
	await browser?.close();
	await server?.close();
});

const url = (path = '') => `${server.origin}${BASE}${path}`;

async function open(viewport) {
	const context = await browser.newContext({serviceWorkers: 'block', viewport});
	const seen = {liga: [], supabase: []};

	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await context.route(/ligapokemon\.com\.br/, (route) => {
		seen.liga.push(route.request().url());

		return route.abort('blockedbyclient');
	});
	await context.route('https://*.supabase.co/**', (route) => {
		seen.supabase.push(route.request().url());

		return route.abort('blockedbyclient');
	});
	await context.route('https://api.frankfurter.dev/**', (route) => route.abort('blockedbyclient'));
	await context.route('https://api.tcgdex.net/**', (route) => {
		const request = route.request();

		if (new URL(request.url()).pathname.endsWith('/graphql')) {
			const {query} = JSON.parse(request.postData() || '{}');

			if (/cards\s*\{\s*id\s+dexId/.test(query)) {
				return route.fulfill({body: JSON.stringify({data: {cards: DEX}}), contentType: 'application/json', status: 200});
			}

			return route.fulfill({body: JSON.stringify({data: {cards: []}}), contentType: 'application/json', status: 200});
		}

		return route.fulfill({body: '{}', contentType: 'application/json', status: 404});
	});
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));
	await context.route(/githubusercontent/, (route) => route.abort());
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

	return {done, page};
}

// The document straight into the phone's store, and the card records into
// its card index, as tests/binder-rules.test.mjs seeds them.
async function seed(page, doc) {
	await page.goto(url('cards'));
	await page.waitForSelector('#cards-empty');
	await page.evaluate(async ({records, stored}) => {
		await new Promise((resolve, reject) => {
			const request = indexedDB.open('card-tracker-collection', 1);

			request.onupgradeneeded = () => request.result.createObjectStore('documents');
			request.onsuccess = () => {
				const tx = request.result.transaction('documents', 'readwrite');

				tx.objectStore('documents').put(stored, 'local');
				tx.oncomplete = () => {
					request.result.close();
					resolve();
				};
				tx.onerror = () => reject(tx.error);
			};
			request.onerror = () => reject(request.error);
		});
		await (await import('/pokemon-card-tracker/js/catalog.js')).saveToCardIndex(records);
	}, {records: RECORDS, stored: doc});
	await page.reload();
}

const localDoc = (page) => page.evaluate(async () => (await import('/pokemon-card-tracker/js/collection.js')).loadDocument());

const undoOn = (page, text) => page.locator('#toasts .toast', {hasText: text}).locator('button', {hasText: 'Undo'});

// ------------------------------------------------- lay out from a list

// Johto, 2 x 2, 2 pages: page 1 holds c4 (Pokémon 4) in pocket 1, a pocket
// left empty on purpose in 2, nothing in 3, and a placeholder for a card
// of Pokémon 7 in 4. The checklist has 1, 4, 7, 25, 152, 155, and 158;
// c1 (Pokémon 1) and c152 are in no binder, so their placeholders fill.
const JOHTO = hand('johto', 'Johto', [
	{entry_id: 'c4', page: 1, placed_at: AT, position: 1},
	{empty: true, page: 1, placed_at: AT, position: 2},
	{page: 1, placed_at: AT, position: 4, want: {card_id: 'tst1-007', catalog: 'international', image: null, name: 'Test Splash', variant_id: null}},
], {cols: 2, rows: 2});

const CHECKLIST = {created_at: AT, deleted_at: null, dex_list: [1, 4, 7, 25, 152, 155, 158], hand_ticks: {}, id: 'list-1', kind: 'custom_pokemon', name: 'Test starters', target: null, updated_at: AT};

const JOHTO_DOC = documentWith({
	binders: [JOHTO],
	cards: [card('c1', 'tst1-001'), card('c4', 'tst1-004'), card('c152', 'tst3-152')],
	goals: [CHECKLIST],
});

const pocketsOf = (doc) => doc.binders[0].slots
	.filter((slot) => !slot.cleared)
	.map((slot) => [slot.page, slot.position, slot.entry_id || (slot.want ? (slot.want.card_id || `dex:${slot.want.dex}`) : slot.empty ? 'empty' : '?')]);

describe('lay out from a list', () => {
	test('the preview, pages for what does not fit, the fill of copies you own, Undo, and a copy added later', async () => {
		const {done, page} = await open(PHONE);

		await seed(page, JOHTO_DOC);
		await page.goto(url('binders/johto'));
		await page.waitForSelector('#binder-layout-list:not([hidden])');
		await page.click('#binder-layout-list');
		await page.waitForSelector('#layout-sheet[open]');
		await page.waitForFunction(() => /placeholders on/.test(document.getElementById('layout-preview').textContent));

		const lines = () => page.locator('#layout-preview p').allTextContents();

		assert.deepEqual(await lines(), [
			'4 placeholders on page 2, 2 filled with cards you own.',
			'Starting at page 2, pocket 1, the first empty pocket after the last one in use.',
			'2 Pokémon on the list are in this binder already and are skipped.',
			'1 Pokémon does not fit in the empty pockets.',
		]);
		assert.equal(await page.locator('#layout-add-text').textContent(), 'Add 1 page so they fit (2 to 3 pages)');
		await page.screenshot({path: `${SHOTS}/layout-preview-360.png`});

		// From page 1, the empty pocket 3 is used too, and all five fit.
		await page.check('#layout-from-start');
		await page.waitForFunction(() => /^5 placeholders on pages 1 to 2/.test(document.querySelector('#layout-preview p').textContent));
		assert.equal(await page.locator('#layout-add').isHidden(), true);

		// After the last pocket in use, with a page added.
		await page.check('#layout-from-after');
		await page.waitForFunction(() => !document.getElementById('layout-add').hidden);
		await page.check('#layout-add-pages');
		await page.waitForFunction(() => /^5 placeholders on pages 2 to 3/.test(document.querySelector('#layout-preview p').textContent));
		assert.deepEqual(await lines(), [
			'5 placeholders on pages 2 to 3, 2 filled with cards you own.',
			'Starting at page 2, pocket 1, the first empty pocket after the last one in use.',
			'2 Pokémon on the list are in this binder already and are skipped.',
			'1 page added at the end: 2 to 3.',
		]);
		await page.screenshot({path: `${SHOTS}/layout-preview-pages-360.png`});

		await page.click('#layout-go');
		await undoOn(page, 'Laid out 5 placeholders from Test starters; 2 filled with cards you own.').waitFor();

		let doc = await localDoc(page);

		assert.equal(doc.binders[0].page_count, 3);
		assert.deepEqual(pocketsOf(doc), [
			[1, 1, 'c4'],
			[1, 2, 'empty'],
			[1, 4, 'tst1-007'],
			[2, 1, 'c1'],
			[2, 2, 'dex:25'],
			[2, 3, 'c152'],
			[2, 4, 'dex:155'],
			[3, 1, 'dex:158'],
		]);
		assert.deepEqual(doc.binders[0].slots.find((slot) => slot.page === 2 && slot.position === 2).want, {card_id: null, catalog: null, dex: 25, image: null, name: 'Pikachu', variant_id: null});
		await page.waitForSelector('#binder-spread .pocket[data-page="1"][data-position="3"]');
		assert.equal(await page.getAttribute('#binder-spread .pocket[data-page="1"][data-position="3"]', 'data-kind'), 'open', 'the empty pocket before the last one in use stays empty');

		// Undo takes back every pocket; the page it added stays, empty.
		await undoOn(page, 'Laid out 5 placeholders').click();
		await page.locator('#toasts .toast', {hasText: 'Taken back. The page it added stays, empty; remove it in Edit binder.'}).waitFor();
		doc = await localDoc(page);
		assert.equal(doc.binders[0].page_count, 3);
		assert.deepEqual(pocketsOf(doc), [[1, 1, 'c4'], [1, 2, 'empty'], [1, 4, 'tst1-007']]);

		// Again, then a copy of a card showing Pokémon 155 added later fills
		// its placeholder by itself.
		await page.click('#binder-layout-list');
		await page.waitForFunction(() => /placeholders on/.test(document.getElementById('layout-preview').textContent));
		await page.click('#layout-go');
		await undoOn(page, 'Laid out 5 placeholders from Test starters; 2 filled with cards you own.').waitFor();

		const added = await page.evaluate(async () => (await import('/pokemon-card-tracker/js/placeholder-fill.js')).addCopies([{card_id: 'tst3-155', catalog: 'international', language: 'en', language_source: 'manual'}]));

		assert.equal(added.placed.length, 1);
		doc = await localDoc(page);
		assert.equal(doc.binders[0].slots.find((slot) => slot.page === 2 && slot.position === 4 && !slot.cleared).entry_id, added.added[0].id);
		await done();
	});

	test('a binder from a list has no Lay out from a list, and no checklist says so', async () => {
		const {done, page} = await open(PHONE);

		await seed(page, documentWith({binders: [hand('plain', 'Plain', [])]}));
		await page.goto(url('binders/plain'));
		await page.waitForSelector('#binder-layout-list:not([hidden])');
		await page.click('#binder-layout-list');
		await page.waitForSelector('#layout-sheet[open] #layout-none');
		assert.equal(await page.locator('#layout-go').count(), 0);
		await page.click('#layout-cancel');
		await page.waitForFunction(() => !document.getElementById('layout-sheet'));

		const made = await page.evaluate(async () => {
			const binders = await import('/pokemon-card-tracker/js/binders.js');
			const binder = await binders.createGeneratedBinder({cols: 3, cover_color: '#1d2e60', name: 'From a list', page_count: 1, rows: 3}, {order: 'dex', source: {id: 'gone', kind: 'checklist'}}, {at: '2026-11-01T00:00:00.000Z', keys: [], rule_key: 'checklist:gone|dex', shown: {}});

			return binder.id;
		});

		await page.goto(url(`binders/${made}`));
		await page.waitForSelector('#edit-binder');
		assert.equal(await page.locator('#binder-layout-list').isHidden(), true);
		await done();
	});
});
