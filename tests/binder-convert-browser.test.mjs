// Browser tests for "Make a list binder from this" (js/binder-convert.js;
// Eric, 2026-11-18): a hand-made binder with a few copies placed becomes a
// NEW binder from a checklist, the From a list form prefilled (the
// checklist that matches its Pokémon, its grid, its name marked), whose
// pockets show the exact copies the hand-made binder holds as hand picks;
// tapping a pocket lists every other copy of that Pokémon; and the
// hand-made binder stays as it was.
// Headless Chromium at phone width against tests/pages-server.mjs, signed
// out. TCGdex is faked (GraphQL answers the Pokédex numbers of the invented
// cards, the rest 404), PokeAPI by tests/fake-pokeapi.mjs, exchange rates by
// tests/fake-rates.mjs; Supabase and ligapokemon.com.br are never
// contacted. Cards and binders are invented.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/binder-convert-browser.test.mjs
// Screenshots: $SHOTS, else /tmp/binder-convert

import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {fakeRates} from './fake-rates.mjs';
import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const SHOTS = process.env.SHOTS || '/tmp/binder-convert';
const PHONE = {height: 740, width: 360};
const AT = '2026-11-18T00:00:00.000Z';

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
	record('tst2-001', 'Test Sprout Alt', [1]),
	record('tst1-004', 'Test Ember', [4]),
	record('tst1-007', 'Test Splash', [7]),
	record('tst3-152', 'Test Leaf', [152]),
];

// What TCGdex's GraphQL answers for every card's Pokédex numbers.
const DEX = RECORDS.map((item) => ({dexId: item.dex_ids, id: item.id}));

// Kanto, hand-made, 2 x 2, 2 pages. Page 1: c1-alt (Pokémon 1, not the
// copy the list would show by default: c1-priced has a Liga price), c4,
// c1-priced again for Pokémon 1 (so it is not used as a pick), and a
// placeholder for Pikachu. Page 2: c152 (Johto, not on the list) and c7.
// c1-loose and c7-loose are in no binder.
const KANTO = {
	art: [],
	cols: 2,
	cover_color: '#1d2e60',
	created_at: AT,
	deleted_at: null,
	id: 'kanto',
	name: 'Kanto',
	notes: 'Generation 1',
	page_count: 2,
	rows: 2,
	slots: [
		{entry_id: 'c1-alt', page: 1, placed_at: AT, position: 1},
		{entry_id: 'c4', page: 1, placed_at: AT, position: 2},
		{entry_id: 'c1-priced', page: 1, placed_at: AT, position: 3},
		{page: 1, placed_at: AT, position: 4, want: {card_id: null, catalog: null, dex: 25, image: null, name: 'Pikachu', variant_id: null}},
		{entry_id: 'c152', page: 2, placed_at: AT, position: 1},
		{entry_id: 'c7', page: 2, placed_at: AT, position: 2},
	],
	updated_at: AT,
};

const checklist = (id, name, dexList) => ({created_at: AT, deleted_at: null, dex_list: dexList, hand_ticks: {}, id, kind: 'custom_pokemon', name, target: null, updated_at: AT});

const DOC = {
	binders: [KANTO],
	cards: [
		card('c1-priced', 'tst1-001', {price_manual: {avg: 30, currency: 'BRL', date: '2026-11-01', low_nm: 30, source: 'liga'}}),
		card('c1-alt', 'tst2-001'),
		card('c1-loose', 'tst1-001', {created_at: '2026-10-01T00:00:00.000Z'}),
		card('c4', 'tst1-004'),
		card('c7', 'tst1-007'),
		card('c7-loose', 'tst1-007', {created_at: '2026-10-01T00:00:00.000Z'}),
		card('c152', 'tst3-152'),
	],
	collections: [],
	// Johto first in the person's order: the form still starts on the list
	// that matches Kanto's Pokémon.
	goals: [checklist('list-johto', 'Johto test', [152, 155, 158]), checklist('list-kanto', 'Kanto test', [1, 4, 7, 25])],
	openings: [],
	person: 'local',
	updated_at: AT,
	user_id: null,
	version: 1,
	wishlist: [],
};

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

	await fakeRates(context);
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await context.route(/ligapokemon\.com\.br/, (route) => {
		seen.liga.push(route.request().url());

		return route.abort('blockedbyclient');
	});
	await context.route('https://*.supabase.co/**', (route) => {
		seen.supabase.push(route.request().url());

		return route.abort('blockedbyclient');
	});
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
// its card index, as tests/binder-layout-browser.test.mjs seeds them.
async function seed(page, doc) {
	await page.goto(url('cards'));
	await page.waitForSelector('#cards-empty, #cards-grid, .tile');
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

const zoomPocket = (n) => `#bs-zoom-sheet .pocket[data-position="${n}"]`;

async function waitForPocket(page, selector, check) {
	await page.waitForFunction(({selector: sel, check: wanted}) => {
		const el = document.querySelector(sel);

		return Boolean(el) && Object.entries(wanted).every(([key, value]) => (key === 'label' ? new RegExp(value).test(el.getAttribute('aria-label')) : el.dataset[key] === value));
	}, {check, selector}, {timeout: 15000});
}

async function openPage(page, pg) {
	await page.click(`.bs-open[data-open="${pg}"]`);
	await page.waitForFunction((wanted) => {
		const root = document.getElementById('binder-spread');

		return root && root.dataset.zoom === wanted;
	}, String(pg), {timeout: 10000});
}

describe('make a list binder from this', () => {
	test('a hand-made binder becomes a checklist binder showing its exact copies, a pocket lists the other copies, and the hand-made binder is unchanged', async () => {
		const {done, page} = await open(PHONE);

		await seed(page, DOC);
		await page.goto(url('binders/kanto'));
		await page.waitForSelector('#binder-convert:not([hidden])');

		const handBefore = (await localDoc(page)).binders.find((binder) => binder.id === 'kanto');

		// The button sits with the binder's other actions, 44 px or taller.
		assert.ok((await page.locator('#binder-convert').boundingBox()).height >= 44);
		await page.locator('#binder-convert').scrollIntoViewIfNeeded();
		await page.screenshot({path: `${SHOTS}/actions-360.png`});

		await page.click('#binder-convert');
		await page.waitForSelector('#binder-form #rule-section');

		// Prefilled: the name marked, the notes and cover kept, the checklist
		// that matches Kanto's Pokémon, Pokédex order, and Kanto's own grid.
		assert.equal(await page.textContent('#binder-form h3'), 'Make a list binder from Kanto');
		assert.equal(await page.inputValue('#binder-name'), 'Kanto (list)');
		assert.equal(await page.inputValue('#binder-notes'), 'Generation 1');
		assert.equal(await page.isChecked('#rule-kind input[value="checklist"]'), true);
		assert.equal(await page.inputValue('#rule-list'), 'list-kanto');
		assert.equal(await page.inputValue('#rule-order'), 'dex');
		assert.equal(await page.inputValue('#binder-rows'), '2');
		assert.equal(await page.inputValue('#binder-cols'), '2');
		await page.waitForFunction(() => /4 pockets \(3 with a card you own\): 1 page of 2 × 2\./.test((document.getElementById('rule-count') || {}).textContent), null, {timeout: 15000});
		await page.waitForFunction(() => /pockets show/.test((document.getElementById('convert-preview') || {}).textContent), null, {timeout: 15000});
		assert.equal(await page.textContent('#convert-preview'), '3 pockets show the card you chose in Kanto. 1 card shares a pocket with an earlier card and is not used. 1 card is not on this list.');
		await page.locator('#binder-form').screenshot({path: `${SHOTS}/form-360.png`});

		// Another list: the preview follows it.
		await page.selectOption('#rule-list', 'list-johto');
		await page.waitForFunction(() => /^1 pocket shows/.test((document.getElementById('convert-preview') || {}).textContent), null, {timeout: 15000});
		assert.equal(await page.textContent('#convert-preview'), '1 pocket shows the card you chose in Kanto. 4 cards are not on this list.');
		await page.selectOption('#rule-list', 'list-kanto');
		await page.waitForFunction(() => /^3 pockets show/.test((document.getElementById('convert-preview') || {}).textContent), null, {timeout: 15000});

		await page.click('#binder-save');
		await page.waitForFunction(() => document.getElementById('binder-title')?.textContent === 'Kanto (list)', null, {timeout: 15000});
		await page.locator('#toasts .toast', {hasText: 'Made Kanto (list): 3 pockets keep the card you chose (1 more card shared a pocket and was not used). Kanto is unchanged; delete it when you are happy with the new one.'}).waitFor();

		let doc = await localDoc(page);
		const made = doc.binders.find((binder) => binder.id !== 'kanto');

		assert.match(page.url(), new RegExp(`/binders/${made.id}`));
		assert.deepEqual(made.rule, {order: 'dex', source: {id: 'list-kanto', kind: 'checklist'}});
		assert.deepEqual(made.snapshot.keys, ['dex:1', 'dex:4', 'dex:7', 'dex:25']);
		assert.deepEqual([made.rows, made.cols, made.page_count, made.cover_color, made.notes], [2, 2, 1, '#1d2e60', 'Generation 1']);
		assert.deepEqual(made.slots, []);
		assert.deepEqual(doc.binder_picks.map((pick) => [pick.id, pick.entry_id]).sort(), [[`${made.id}|dex:1`, 'c1-alt'], [`${made.id}|dex:4`, 'c4'], [`${made.id}|dex:7`, 'c7']]);

		// The hand-made binder is as it was, and the new one has no Make a
		// list binder from this.
		assert.deepEqual(doc.binders.find((binder) => binder.id === 'kanto'), handBefore);
		assert.equal(await page.locator('#binder-convert').isHidden(), true);

		// Each pocket shows the copy from the hand-made binder, picked by
		// hand: Test Sprout Alt, though the priced Test Sprout is the default.
		await openPage(page, 1);
		await waitForPocket(page, zoomPocket(1), {kind: 'card', label: 'Bulbasaur: Test Sprout Alt, .*3 copies fit, picked by hand', picked: 'true'});
		await waitForPocket(page, zoomPocket(2), {kind: 'card', label: 'Test Ember.*picked by hand', picked: 'true'});
		await waitForPocket(page, zoomPocket(3), {kind: 'card', label: 'Squirtle: Test Splash, .*2 copies fit, picked by hand', picked: 'true'});
		await waitForPocket(page, zoomPocket(4), {item: 'pokemon', kind: 'want', label: '#025 Pikachu, not owned yet'});
		await page.screenshot({path: `${SHOTS}/list-binder-360.png`});

		// Tapping the first pocket lifts the card out; Edit pocket lists
		// every copy of Bulbasaur, the hand pick pressed.
		await page.click(zoomPocket(1));
		await page.waitForFunction(() => document.getElementById('pocket-viewer')?.dataset.state === 'open');
		await page.click('#pv-details');
		await page.waitForSelector('#list-copies .list-copy[data-entry="c1-loose"]');
		assert.deepEqual((await page.locator('#list-copies .list-copy').evaluateAll((nodes) => nodes.map((node) => node.dataset.entry))).sort(), ['c1-alt', 'c1-loose', 'c1-priced']);
		assert.equal(await page.locator('#list-copies .list-copy[aria-pressed="true"]').getAttribute('data-entry'), 'c1-alt');
		await page.screenshot({path: `${SHOTS}/copies-360.png`});

		// Opening the new binder again refreshes it without dropping a pick,
		// and the hand-made binder is still unchanged.
		await page.goto(url(`binders/${made.id}`));
		await page.waitForSelector('#binder-spread .bs-page');
		await page.waitForTimeout(500);
		doc = await localDoc(page);
		assert.deepEqual(doc.binder_picks.filter((pick) => pick.entry_id).map((pick) => [pick.key, pick.entry_id]).sort(), [['dex:1', 'c1-alt'], ['dex:4', 'c4'], ['dex:7', 'c7']]);
		assert.deepEqual(doc.binders.find((binder) => binder.id === 'kanto'), handBefore);
		await done();
	});

	test('a pocket of several cards swipes through them and puts the one in view on top', async () => {
		const {done, page} = await open(PHONE);

		await seed(page, DOC);
		await page.goto(url('binders/kanto'));
		await page.waitForSelector('#binder-convert:not([hidden])');
		await page.click('#binder-convert');
		await page.waitForFunction(() => /^3 pockets show/.test((document.getElementById('convert-preview') || {}).textContent), null, {timeout: 15000});
		await page.click('#binder-save');
		await page.waitForFunction(() => document.getElementById('binder-title')?.textContent === 'Kanto (list)', null, {timeout: 15000});

		const made = (await localDoc(page)).binders.find((binder) => binder.id !== 'kanto');

		await openPage(page, 1);
		await waitForPocket(page, zoomPocket(1), {label: 'Test Sprout Alt, .*3 copies fit'});

		// Bulbasaur's pocket holds three copies: the one on top first, then
		// the rest newest first (Eric, 2026-11-18).
		await page.click(zoomPocket(1));
		await page.waitForFunction(() => document.getElementById('pocket-viewer')?.dataset.state === 'open');
		assert.equal(await page.textContent('#pv-count'), '1 of 3 in this pocket');
		assert.equal(await page.textContent('#pv-name'), 'Test Sprout Alt');
		assert.equal(await page.isDisabled('#pv-prev'), true);
		assert.equal(await page.isDisabled('#pv-pick'), true, 'the card on top already shows here');
		assert.equal(await page.textContent('#pv-pick'), 'Shown here');
		assert.equal(await page.locator('#pv-details').isVisible(), true, 'Edit pocket is still offered');

		await page.click('#pv-next');
		assert.equal(await page.textContent('#pv-count'), '2 of 3 in this pocket');
		assert.equal(await page.textContent('#pv-name'), 'Test Sprout');
		assert.equal(await page.isDisabled('#pv-pick'), false);
		assert.equal(await page.textContent('#pv-pick'), 'Show this one here');

		// The arrow keys move too, and stop at the last card.
		await page.keyboard.press('ArrowRight');
		assert.equal(await page.textContent('#pv-count'), '3 of 3 in this pocket');
		assert.equal(await page.isDisabled('#pv-next'), true);
		await page.keyboard.press('ArrowRight');
		assert.equal(await page.textContent('#pv-count'), '3 of 3 in this pocket');

		// A sideways swipe at zoom 1 goes back one.
		const box = await page.locator('#pv-lift').boundingBox();
		const y = box.y + box.height / 2;

		await page.mouse.move(box.x + box.width * 0.25, y);
		await page.mouse.down();

		for (let i = 1; i <= 8; i++) {
			await page.mouse.move(box.x + box.width * 0.25 + i * 20, y);
		}

		await page.mouse.up();
		await page.waitForFunction(() => document.getElementById('pv-count')?.textContent === '2 of 3 in this pocket');
		await page.screenshot({path: `${SHOTS}/stack-viewer-360.png`});

		// The card and every action fit on a 360 x 740 screen.
		const lift = await page.locator('#pv-lift').boundingBox();
		const last = await page.locator('#pv-actions > :last-child').boundingBox();

		assert.ok(lift.y >= 0, `the card starts on screen: ${lift.y}`);
		assert.ok(last.y + last.height <= PHONE.height, `the last action ends on screen: ${last.y + last.height}`);

		// Show this one here: the viewer closes and the pocket shows it.
		await page.click('#pv-pick');
		await page.waitForSelector('#pocket-viewer', {state: 'detached'});
		const pickOf = async () => ((await localDoc(page)).binder_picks || []).find((one) => one.id === `${made.id}|dex:1`);

		for (let tries = 0; tries < 50 && (await pickOf())?.entry_id !== 'c1-priced'; tries++) {
			await page.waitForTimeout(200);
		}

		assert.equal((await pickOf())?.entry_id, 'c1-priced', 'the pick is saved');
		await waitForPocket(page, zoomPocket(1), {label: 'Bulbasaur: Test Sprout, .*3 copies fit, picked by hand', picked: 'true'});
		await done();
	});
});
