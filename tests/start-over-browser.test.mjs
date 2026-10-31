// Browser test for "Start over with this file" on the import screen
// (js/start-over.js; DESIGN.md section 7, Eric, 2026-10-30): a monprice
// file is matched, the preview counts what changes, Cancel changes nothing,
// Start over asks to confirm and saves, a binder pocket becomes a
// placeholder, the card's note stays, and Undo puts every copy and the
// pocket back. Headless Chromium against tests/pages-server.mjs, signed
// out, at 390 x 844.
//
// Every outside service is faked: TCGdex answers with an invented set as
// the matcher asks it (as in tests/app.test.mjs), PokeAPI with
// tests/fake-pokeapi.mjs. Supabase must never be contacted, and
// ligapokemon.com.br is never requested.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/start-over-browser.test.mjs
// Screenshots: $SHOTS (default /tmp)/start-over-*.png

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, test} from 'node:test';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const PHONE = {height: 844, width: 390};
const SHOTS = process.env.SHOTS || '/tmp';

// Row 1 was imported before; row 9 matches nothing.
const CSV = [
	'Name;Set;Number;Language;Finish Type;Count;ID;Release Date',
	'Test card 1;Test set;001/009;PT;NORMAL;2;tst1_int_1;2026-01-01',
	'Test card 3;Test set;003/009;PT;NORMAL;1;tst1_int_3;2026-01-01',
	'Invented card;Invented set;001/001;PT;NORMAL;1;zzz_int_1;2026-01-01',
].join('\r\n');

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
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));
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
	await fakePokeApi(context);

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err));

	const done = async () => {
		assert.deepEqual(errors.map(String), []);
		assert.deepEqual(seen.liga, [], 'Liga Pokémon is never requested');
		assert.deepEqual(seen.supabase, [], 'Supabase is never contacted');
		await context.close();
	};

	await page.goto(url('cards'));
	await page.waitForSelector('#cards-empty');

	return {done, page};
}

// Two copies of card 1 from an earlier import, one of card 2 added in the
// app with a note on its card, a hand-made card, and a binder holding card
// 2's copy in pocket 1.
async function seed(page) {
	return page.evaluate(async () => {
		const collection = await import('/pokemon-card-tracker/js/collection.js');
		const binders = await import('/pokemon-card-tracker/js/binders.js');
		const copy = (fields) => ({catalog: 'international', created_at: '2026-09-01T10:00:00.000Z', language: 'pt', variant_id: 'normal', ...fields});
		const [one, two, own] = await collection.addCards([
			copy({card_id: 'tst1-001', import_key: 'monprice|tst1_int_1|pt|NORMAL|0', language_source: 'import'}),
			copy({card_id: 'tst1-002', condition: 'Near Mint', language_source: 'manual'}),
			{card_id: `hand_${'c'.repeat(32)}`, catalog: 'custom', language: 'pt', language_source: 'manual', name_local: 'Hand card', variant_id: null},
		]);

		await collection.setCardNotes({card_id: 'tst1-002', catalog: 'international', language: 'pt'}, 'Traded at school');

		const binder = await binders.createBinder({cols: 3, name: 'Test binder', page_count: 1, rows: 3});

		await binders.placeCard(binder.id, 1, 1, two.id);

		return {binderId: binder.id, ids: [one.id, two.id, own.id]};
	});
}

const state = (page, binderId) => page.evaluate(async (id) => {
	const {loadDocument} = await import('/pokemon-card-tracker/js/collection.js');
	const doc = await loadDocument();
	const binder = doc.binders.find((item) => item.id === id);
	const pocket = binder.slots.find((slot) => slot.page === 1 && slot.position === 1 && !slot.cleared);

	return {
		live: doc.cards.filter((entry) => !entry.deleted_at).map((entry) => ({card_id: entry.card_id, id: entry.id})),
		notes: (doc.card_info || []).filter((record) => !record.deleted_at && record.notes).map((record) => [record.id, record.notes]),
		pocket: pocket ? (pocket.entry_id || `want:${pocket.want && pocket.want.card_id}`) : null,
	};
}, binderId);

test('preview, Cancel, confirm, Start over, and Undo', async () => {
	const {done, page} = await phone();
	const {binderId, ids} = await seed(page);
	const before = await state(page, binderId);

	await page.goto(url('import'));
	await page.setInputFiles('#monprice-file', {buffer: Buffer.from(CSV), mimeType: 'text/csv', name: 'rescan.csv'});
	await page.waitForSelector('#start-over');
	assert.match(await page.locator('details.report-line', {hasText: 'Not matched'}).textContent(), /Not matched: 1 row/, 'unmatched rows are still listed');
	assert.equal(await page.locator('.report-hand').count(), 1, 'and can still be added by hand');

	await page.click('#start-over');
	await page.waitForSelector('#start-over-preview');
	assert.equal(await page.locator('#start-over-preview').textContent(), 'Remove 2 copies, add 3 copies, 0 photos kept, 1 pocket becomes a placeholder.');
	await page.screenshot({fullPage: true, path: `${SHOTS}/start-over-preview.png`});

	await page.click('#start-over-cancel');
	assert.equal(await page.locator('#start-over-preview').count(), 0);
	assert.deepEqual(await state(page, binderId), before, 'Cancel changes nothing');

	// Declining the confirmation changes nothing either.
	await page.click('#start-over');
	await page.waitForSelector('#start-over-go');
	page.once('dialog', (dialog) => dialog.dismiss());
	await page.click('#start-over-go');
	assert.deepEqual(await state(page, binderId), before);

	page.once('dialog', (dialog) => {
		assert.match(dialog.message(), /Remove 2 copies and add 3 copies/);
		dialog.accept();
	});
	await page.click('#start-over-go');
	await page.waitForSelector('#start-over-done');
	assert.equal(await page.locator('#start-over-done').textContent(), 'Started over. 2 removed, 3 added.');
	await page.screenshot({fullPage: true, path: `${SHOTS}/start-over-done.png`});

	const after = await state(page, binderId);

	assert.deepEqual(after.live.map((entry) => entry.card_id).sort(), ['tst1-001', 'tst1-001', 'tst1-003', `hand_${'c'.repeat(32)}`].sort());
	assert.ok(after.live.some((entry) => entry.id === ids[2]), 'the hand-made card stays');
	assert.ok(!after.live.some((entry) => entry.id === ids[0] || entry.id === ids[1]), 'the earlier copies are gone');
	assert.equal(after.pocket, 'want:tst1-002', 'the pocket is the card\'s placeholder now');
	assert.deepEqual(after.notes, before.notes, 'the card\'s note stays');

	await page.click('#start-over-undo');
	await page.waitForSelector('#start-over-undone');
	assert.equal(await page.locator('#start-over-undone').textContent(), 'Undone. 2 copies are back, and 3 added copies were removed.');
	assert.deepEqual(await state(page, binderId), before, 'Undo puts every copy and the pocket back');
	await done();
});
