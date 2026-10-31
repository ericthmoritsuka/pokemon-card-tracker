// Browser test for Import "Match this file" (js/match-file.js,
// js/import-view.js): a monprice file picked, Match this file offered beside
// Save, its preview, Cancel, Apply (copies added and removed, details
// carried over, a pocket turned placeholder), and Undo back to the cards
// and binders as they were. Headless Chromium against tests/pages-server.mjs,
// signed out, at 390 x 844.
//
// Every outside service is faked: TCGdex answers with one invented set,
// PokeAPI with tests/fake-pokeapi.mjs. Supabase must never be contacted,
// and ligapokemon.com.br is never requested.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/match-file-browser.test.mjs
// Screenshots: $SHOTS (default /tmp)/match-file-*.png

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const PHONE = {height: 844, width: 390};
const SHOTS = process.env.SHOTS || '/tmp';

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

const url = (path = '') => `${server.origin}${BASE}${path}`;

async function phone() {
	const context = await browser.newContext({serviceWorkers: 'block', viewport: PHONE});
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
	await context.route('https://api.frankfurter.dev/**', (route) => route.fulfill({body: '[]', contentType: 'application/json', headers: {'Access-Control-Allow-Origin': '*'}, status: 200}));
	// TCGdex as the matcher asks it (js/monprice.js matchRows): the set by
	// its printed abbreviation, the set's card list, and each card's printings.
	await context.route('https://api.tcgdex.net/**', (route) => {
		const {pathname, search} = new URL(route.request().url());
		const json = (body, status = 200) => route.fulfill({body: JSON.stringify(body), contentType: 'application/json', headers: {'Access-Control-Allow-Origin': '*'}, status});

		if (/\/v2\/en\/sets$/.test(pathname)) {
			return json(/abbreviation\.official=eq:tst1/.test(decodeURIComponent(search)) ? [{id: 'tst1', name: 'Test set tst1'}] : []);
		}

		if (/\/v2\/\w+\/sets\/tst1$/.test(pathname)) {
			return json({
				cardCount: {official: 9, total: 9},
				cards: Array.from({length: 9}, (_, i) => ({id: `tst1-00${i + 1}`, image: null, localId: `00${i + 1}`, name: `Test card ${i + 1}`})),
				id: 'tst1',
				name: 'Test set tst1',
				releaseDate: '2026-01-01',
			});
		}

		const card = /\/v2\/\w+\/cards\/(tst1-00\d)$/.exec(pathname);

		if (card) {
			return json({id: card[1], image: null, localId: card[1].slice(-3), name: `Test card ${card[1]}`, rarity: 'Common', set: {id: 'tst1', name: 'Test set tst1'}, variants_detailed: [{type: 'normal', variantId: 'normal'}]});
		}

		return json({}, 404);
	});
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));
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

	await page.goto(url('cards'));
	await page.waitForSelector('#cards-empty');

	return {done, page};
}

const call = (page, file, name, ...args) => page.evaluate(async ([path, fn, list]) => (await import(path))[fn](...list), [`${BASE}js/${file}`, name, args]);

// The cards and pockets as a person sees them: live copies (card, details),
// and each pocket's copy or placeholder.
async function state(page) {
	return page.evaluate(async (base) => {
		const {loadDocument} = await import(`${base}js/collection.js`);
		const {placements, slotsOf} = await import(`${base}js/binders.js`);
		const doc = await loadDocument();
		const binders = (doc.binders || []).filter((binder) => !binder.deleted_at);
		const placed = placements(binders);

		return {
			cards: doc.cards.filter((card) => !card.deleted_at)
				.map((card) => [card.id, card.card_id, card.condition || null, card.storage || null])
				.sort((a, b) => a[0].localeCompare(b[0])),
			// The card records (js/card-info.js), which matching never touches,
			// and whether an older app's photo_index was written.
			info: (doc.card_info || []).map((record) => [record.id, record.notes || null, record.updated_at, Boolean(record.deleted_at)]),
			legacyIndex: Object.hasOwn(doc, 'photo_index'),
			pockets: binders.flatMap((binder) => slotsOf(binder, placed).map((slot) => [slot.page, slot.position, slot.entry_id || null, slot.want ? slot.want.card_id : null])),
		};
	}, BASE);
}

const CSV = [
	'Name;Set;Number;Language;Finish Type;Count;ID;Release Date',
	'Test card 1;Test set;001/009;PT;NORMAL;1;tst1_int_1;2026-01-01',
	'Test card 3;Test set;003/009;PT;NORMAL;2;tst1_int_3;2026-01-01',
].join('\r\n');

describe('Match this file', () => {
	test('preview, Cancel, Apply, and Undo', async () => {
		const {done, page} = await phone();
		const base = {catalog: 'international', language: 'pt', language_source: 'scan', variant_id: 'normal'};
		const oldest = await call(page, 'collection.js', 'addCard', {...base, card_id: 'tst1-001', created_at: '2026-09-01T10:00:00.000Z'});
		const extra = await call(page, 'collection.js', 'addCard', {...base, card_id: 'tst1-001', created_at: '2026-09-02T10:00:00.000Z', storage: 'Box A'});
		const placedCopy = await call(page, 'collection.js', 'addCard', {...base, card_id: 'tst1-002', created_at: '2026-09-03T10:00:00.000Z'});
		const binder = await call(page, 'binders.js', 'createBinder', {cols: 3, cover_color: '#1d2e60', name: 'Invented binder', page_count: 2, rows: 3});

		await call(page, 'binders.js', 'placeCard', binder.id, 1, 1, placedCopy.id);
		await call(page, 'collection.js', 'setCardNotes', {card_id: 'tst1-002', catalog: 'international', language: 'pt'}, 'Invented note');

		const before = await state(page);

		assert.equal(before.cards.length, 3);
		assert.deepEqual(before.pockets, [[1, 1, placedCopy.id, null]]);
		assert.deepEqual(before.info.map(([id, notes]) => [id, notes]), [['international~tst1-002~pt', 'Invented note']]);
		assert.equal(before.legacyIndex, false);

		await page.goto(url('import'));
		await page.setInputFiles('#monprice-file', {buffer: Buffer.from(CSV), mimeType: 'text/csv', name: 'invented.csv'});
		await page.waitForSelector('#import-match');
		assert.equal(await page.locator('button.primary.wide').textContent(), 'Save 3 copies', 'the normal import is still offered');

		// Cancel changes nothing and offers both again.
		await page.click('#import-match');
		await page.waitForSelector('#import-match-preview');
		assert.equal(await page.locator('#import-match-summary').textContent(), '+2 copies, -2 copies, 1 copy updated, 1 pocket became a placeholder');
		assert.equal(await page.locator('button.primary.wide').count(), 0, 'Apply and Cancel take the place of Save while the preview is open');
		await page.screenshot({fullPage: true, path: `${SHOTS}/match-file-preview.png`});
		await page.click('#import-match-cancel');
		assert.equal(await page.locator('#import-match-preview').count(), 0);
		assert.ok(await page.locator('#import-match').isEnabled());
		assert.equal(await page.locator('button.primary.wide').textContent(), 'Save 3 copies');
		assert.deepEqual(await state(page), before);

		await page.click('#import-match');
		await page.click('#import-match-apply');
		await page.waitForSelector('#import-match-undo');
		assert.equal(await page.locator('#import-match-done').textContent(), 'Matched. +2 copies, -2 copies, 1 copy updated, 1 pocket became a placeholder.');
		assert.equal(await page.locator('button.primary.wide').count(), 0, 'Save is gone once the file is matched');
		await page.screenshot({fullPage: true, path: `${SHOTS}/match-file-applied.png`});

		const applied = await state(page);
		const ids = applied.cards.map(([id]) => id);

		assert.equal(applied.cards.length, 3);
		assert.ok(ids.includes(extra.id) && !ids.includes(oldest.id) && !ids.includes(placedCopy.id), 'the copy holding a place is kept, the blank one and the unnamed card removed');
		assert.deepEqual(applied.cards.find(([id]) => id === extra.id).slice(1), ['tst1-001', null, 'Box A'], 'Stored in stays on the copy kept');
		assert.equal(applied.cards.filter(([, cardId]) => cardId === 'tst1-003').length, 2);
		assert.deepEqual(applied.pockets, [[1, 1, null, 'tst1-002']], 'the pocket became the card\'s placeholder');
		assert.deepEqual(applied.info, before.info, 'the removed card keeps its notes, untouched');
		assert.equal(applied.legacyIndex, false, 'no photo_index is written');

		await page.click('#import-match-undo');
		await page.waitForSelector('text=Undone. Your cards and binders are as they were.');
		assert.deepEqual(await state(page), before);
		await page.screenshot({fullPage: true, path: `${SHOTS}/match-file-undone.png`});

		await done();
	});
});
