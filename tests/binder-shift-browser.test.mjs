// Browser tests for Remove from this binder and Move to... (Eric,
// 2026-11-06: "I'm going through the Unova binder made based on the Unova
// region and it starts with Victini, not with the starters... I should be
// able to do it and move the Victini to the back of the binder"): the first
// Pokémon of a binder from a list moved to the end and left out, with Undo,
// an older phone's save left alone on opening, and Put back; a hand-made
// binder's card removed with the rest shifting back, Undo, and moved to the
// end; at 360 px in portrait and held sideways.
// Headless Chromium against tests/pages-server.mjs, signed out. TCGdex is
// faked (GraphQL answers the Pokédex numbers of the invented cards, the
// rest 404), PokeAPI by tests/fake-pokeapi.mjs; Supabase and
// ligapokemon.com.br are never contacted. Cards and binders are invented.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/binder-shift-browser.test.mjs
// Screenshots: $SHOTS, else /tmp/binder-shift

import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {startPagesServer} from './pages-server.mjs';
import {untilInPage} from './poll.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const SHOTS = process.env.SHOTS || '/tmp/binder-shift';
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

const SIDEWAYS = {height: 360, width: 740};

const waitOpen = (page) => page.waitForFunction(() => {
	const node = document.getElementById('pocket-viewer');

	return Boolean(node) && node.dataset.state === 'open';
});

const zoomed = (n) => `#bs-zoom-sheet .pocket[data-position="${n}"]`;

async function openPage(page, pg) {
	await page.click(`.bs-open[data-open="${pg}"]`);
	await page.waitForFunction((wanted) => {
		const root = document.getElementById('binder-spread');

		return Boolean(root) && root.dataset.zoom === wanted;
	}, String(pg));
}

// The pockets' keys of a binder from a list, as the page draws them.
const shownKeys = (page, scope) => page.locator(`${scope} .pocket`).evaluateAll((nodes) => nodes.map((node) => node.dataset.key || ''));

// ------------------------------------------------- a binder from a list

// Test starters, from a checklist of 1, 4, 7, and 152, 2 x 2, one page.
// Pokémon 1 stands for Victini: first on the list, and moved to the end.
const CHECKLIST = {created_at: AT, deleted_at: null, dex_list: [1, 4, 7, 152], hand_ticks: {}, id: 'list-1', kind: 'custom_pokemon', name: 'Test starters', target: null, updated_at: AT};
const RULE = {order: 'dex', source: {id: 'list-1', kind: 'checklist'}};
const LIST_KEYS = ['dex:1', 'dex:4', 'dex:7', 'dex:152'];
const LISTED = {art: [], cols: 2, cover_color: '#1d2e60', created_at: AT, deleted_at: null, id: 'gen', name: 'Test region', notes: '', page_count: 1, rows: 2, rule: RULE, slots: [], snapshot: {at: AT, keys: LIST_KEYS, rule_key: 'checklist:list-1|dex', shown: {'dex:1': 'c1', 'dex:4': 'c4'}}, updated_at: AT};
const LIST_DOC = documentWith({binders: [LISTED], cards: [card('c1', 'tst1-001'), card('c4', 'tst1-004')], goals: [CHECKLIST]});

describe('a binder from a list', () => {
	test('the first Pokémon to the end and Undo, then left out with the rest shifting back, an older phone\'s save left alone, and Put back', async () => {
		const {done, page} = await open(PHONE);

		await seed(page, LIST_DOC);
		await page.goto(url('binders/gen'));
		await page.waitForSelector('#binder-spread .bs-page');
		await page.waitForTimeout(500);
		await openPage(page, 1);
		await page.click(zoomed(1));
		await waitOpen(page);
		assert.deepEqual(await page.locator('#pv-actions > *').evaluateAll((nodes) => nodes.map((node) => [node.id, node.textContent])), [
			['pv-details', 'Edit pocket'],
			['pv-move', 'Move to…'],
			['pv-remove', 'Remove from this binder'],
			['pv-card-page', 'Card page'],
		]);

		// Move to..., End of the binder.
		await page.click('#pv-move');
		await page.waitForSelector('#pocket-sheet[open] #move-panel #move-end');
		await page.waitForTimeout(400);
		await page.screenshot({path: `${SHOTS}/list-move-to-360.png`});
		await page.click('#move-end');
		await undoOn(page, 'Bulbasaur goes to the end of this binder, page 1, pocket 4.').waitFor();

		let doc = await localDoc(page);

		assert.deepEqual(doc.binders[0].list_edits.map((edit) => [edit.key, edit.kind]), [['dex:1', 'end']]);
		assert.deepEqual(doc.binders[0].snapshot.keys, ['dex:4', 'dex:7', 'dex:152', 'dex:1']);
		await untilInPage(page, 'Pokémon 4 in pocket 1', () => document.querySelector('#bs-zoom-sheet .pocket[data-position="1"]')?.dataset.key === 'dex:4');

		// Undo puts it back in its list place.
		await undoOn(page, 'Bulbasaur goes to the end').click();
		await untilInPage(page, 'Pokémon 1 back in pocket 1', () => document.querySelector('#bs-zoom-sheet .pocket[data-position="1"]')?.dataset.key === 'dex:1');
		doc = await localDoc(page);
		assert.deepEqual(doc.binders[0].list_edits.map((edit) => [edit.key, edit.kind]), [['dex:1', 'none']], 'Undo takes the exception away');
		assert.deepEqual(doc.binders[0].snapshot.keys, LIST_KEYS);

		// Remove from this binder, Shift the rest back.
		await page.click(zoomed(1));
		await waitOpen(page);
		await page.click('#pv-remove');
		await page.waitForSelector('#pocket-sheet[open] #remove-panel #remove-shift');
		await page.waitForTimeout(400);
		await page.screenshot({path: `${SHOTS}/list-remove-360.png`});
		await page.click('#remove-shift');
		await undoOn(page, 'Bulbasaur is left out of this binder; the pockets after it moved back one.').waitFor();
		await untilInPage(page, 'the rest shifted back', () => document.querySelector('#bs-zoom-sheet .pocket[data-position="1"]')?.dataset.key === 'dex:4');
		assert.deepEqual(await shownKeys(page, '#bs-zoom-sheet'), ['dex:4', 'dex:7', 'dex:152', '']);
		assert.equal(await page.locator('#binder-left-out').textContent(), 'Left out of this binder: Bulbasaur. Put back');
		doc = await localDoc(page);
		assert.deepEqual(doc.binders[0].snapshot.keys, ['dex:4', 'dex:7', 'dex:152']);

		// An older phone opens it and saves the list's own order, keeping the
		// field it does not know. Opening it here shows Bulbasaur left out and
		// saves nothing.
		await page.goto(url('binders'));
		await page.evaluate(async (snapshot) => {
			const {saveRefresh} = await import('/pokemon-card-tracker/js/binders.js');

			await saveRefresh('gen', {page_count: 1, snapshot});
		}, {at: AT, keys: LIST_KEYS, rule_key: 'checklist:list-1|dex', shown: {'dex:1': 'c1', 'dex:4': 'c4'}});
		doc = await localDoc(page);
		assert.deepEqual(doc.binders[0].list_edits.map((edit) => edit.kind), ['out']);

		const stamp = doc.binders[0].updated_at;

		await page.goto(url('binders/gen'));
		await page.waitForSelector('#binder-spread .bs-page');
		await openPage(page, 1);
		await untilInPage(page, 'the layout without Pokémon 1', () => document.querySelector('#bs-zoom-sheet .pocket[data-position="1"]')?.dataset.key === 'dex:4');
		await page.waitForTimeout(800);
		doc = await localDoc(page);
		assert.equal(doc.binders[0].updated_at, stamp, 'opening saves nothing');
		assert.deepEqual(doc.binders[0].snapshot.keys, LIST_KEYS);

		// Put back.
		await page.click('#bs-zoom-close').catch(() => {});
		await page.click('#list-put-back');
		await page.locator('#toasts .toast', {hasText: '1 card is back in their list places.'}).waitFor();
		doc = await localDoc(page);
		assert.deepEqual(doc.binders[0].list_edits.map((edit) => [edit.key, edit.kind]), [['dex:1', 'none']]);
		assert.deepEqual(doc.binders[0].snapshot.keys, LIST_KEYS);
		await done();
	});

	test('held sideways: Leave the pocket empty keeps a gap where it was', async () => {
		const {done, page} = await open(SIDEWAYS);

		await seed(page, LIST_DOC);
		await page.goto(url('binders/gen'));
		await page.waitForSelector('#binder-spread .bs-page');
		await page.waitForTimeout(500);

		const pocket = '#binder-spread .pocket[data-page="1"][data-position="1"]';

		await page.click(pocket);
		await waitOpen(page);
		await page.click('#pv-remove');
		await page.waitForSelector('#pocket-sheet[open] #remove-panel #remove-empty');
		await page.waitForTimeout(400);
		await page.screenshot({path: `${SHOTS}/list-remove-sideways.png`});
		await page.click('#remove-empty');
		await undoOn(page, 'Bulbasaur is left out of this binder; its pocket stays empty.').waitFor();
		await untilInPage(page, 'an empty pocket 1', () => document.querySelector('#binder-spread .pocket[data-page="1"][data-position="1"]')?.dataset.kind === 'open');

		const doc = await localDoc(page);

		assert.deepEqual(doc.binders[0].snapshot.keys, ['', 'dex:4', 'dex:7', 'dex:152']);
		await done();
	});
});

// ---------------------------------------------------- a hand-made binder

// Test region, 2 x 2, 2 pages: page 1 holds c1, c4, c7, and a placeholder;
// page 2 holds c152 in pocket 1.
const HAND = hand('hand', 'Test region', [
	{entry_id: 'c1', page: 1, placed_at: AT, position: 1},
	{entry_id: 'c4', page: 1, placed_at: AT, position: 2},
	{entry_id: 'c7', page: 1, placed_at: AT, position: 3},
	{page: 1, placed_at: AT, position: 4, want: {card_id: 'tst3-155', catalog: 'international', image: null, name: 'Test Flame', variant_id: null}},
	{entry_id: 'c152', page: 2, placed_at: AT, position: 1},
], {cols: 2, rows: 2});

const HAND_DOC = documentWith({binders: [HAND], cards: [card('c1', 'tst1-001'), card('c4', 'tst1-004'), card('c7', 'tst1-007'), card('c152', 'tst3-152')]});

const handPockets = (doc) => doc.binders[0].slots
	.filter((slot) => !slot.cleared)
	.map((slot) => [slot.page, slot.position, slot.entry_id || (slot.want ? slot.want.card_id : '?')]);

const START = [[1, 1, 'c1'], [1, 2, 'c4'], [1, 3, 'c7'], [1, 4, 'tst3-155'], [2, 1, 'c152']];

describe('a hand-made binder', () => {
	test('Remove from this binder with Shift the rest back across pages, Undo, then Move to the end', async () => {
		const {done, page} = await open(PHONE);

		await seed(page, HAND_DOC);
		await page.goto(url('binders/hand'));
		await page.waitForSelector('#binder-spread .bs-page');
		await openPage(page, 1);
		await page.click(zoomed(1));
		await waitOpen(page);
		assert.deepEqual(await page.locator('#pv-actions > *').evaluateAll((nodes) => nodes.map((node) => node.textContent)), ['Edit pocket', 'To the tray', 'Move to…', 'Remove from this binder', 'Card page']);
		await page.click('#pv-remove');
		await page.waitForSelector('#pocket-sheet[open] #remove-panel:not([hidden]) #remove-shift');
		assert.equal(await page.locator('#remove-note').textContent(), 'The card leaves this binder and goes to Not in a binder. To keep it for this binder, use To the tray.');
		await page.waitForTimeout(400);
		await page.screenshot({path: `${SHOTS}/hand-remove-360.png`});
		await page.click('#remove-shift');
		await undoOn(page, 'the pockets after it moved back one.').waitFor();

		let doc = await localDoc(page);

		assert.deepEqual(handPockets(doc), [[1, 1, 'c4'], [1, 2, 'c7'], [1, 3, 'tst3-155'], [1, 4, 'c152']]);
		assert.deepEqual(doc.binders[0].staged || [], [], 'the card goes to no tray');

		await undoOn(page, 'the pockets after it moved back one.').click();
		await untilInPage(page, 'the card back in pocket 1', async () => {
			const {loadDocument} = await import('/pokemon-card-tracker/js/collection.js');
			const binder = (await loadDocument()).binders[0];

			return binder.slots.some((slot) => slot.entry_id === 'c1' && slot.page === 1 && slot.position === 1 && !slot.cleared);
		});
		doc = await localDoc(page);
		assert.deepEqual(handPockets(doc), START);

		// Move to..., End of the binder: c4 is pocket 1 now.
		await page.waitForTimeout(300);
		await page.click(zoomed(1));
		await waitOpen(page);
		await page.click('#pv-move');
		await page.waitForSelector('#pocket-sheet[open] #move-panel:not([hidden]) #move-end');
		await page.selectOption('#move-page', '1');
		await page.selectOption('#move-pocket', '3');
		assert.equal(await page.locator('#move-shift').isVisible(), true, 'a pocket holding a card offers the shift');
		await page.waitForTimeout(300);
		await page.screenshot({path: `${SHOTS}/hand-move-to-360.png`});
		await page.click('#move-end');
		await undoOn(page, 'to the end of the binder, page 2, pocket 1.').waitFor();
		doc = await localDoc(page);
		assert.deepEqual(handPockets(doc), [[1, 1, 'c4'], [1, 2, 'c7'], [1, 3, 'tst3-155'], [1, 4, 'c152'], [2, 1, 'c1']]);
		await done();
	});
});
