// Browser test for "Start over with this file" on the import screen
// (js/start-over.js; DESIGN.md section 7, Eric, 2026-10-30): a monprice
// file is matched, the preview counts what changes, Cancel changes nothing,
// Start over asks to confirm and saves, a binder pocket becomes a
// placeholder, the card's note stays, and Undo, offered again after a
// reload, puts every copy and the pocket back. The preview says what the new
// copies do not get and which cards are left with no copy; Start over is
// off when no row matched, and lists rows left out above the large-count
// limit. Headless Chromium against tests/pages-server.mjs, signed
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
	assert.equal(await page.locator('#start-over-details').textContent(), '1 copy has a grade, price, favorite, condition, Stored in, or pack opening; these stay with the old copies and are not copied over.');
	assert.equal(await page.locator('#start-over-gone summary').textContent(), '1 card has no copy after Start over');
	assert.match(await page.locator('#start-over-gone li').textContent(), /tst1-002.*1 copy/, 'card 2 is not in the file');
	assert.equal(await page.locator('#start-over-hidden').textContent(), 'Their card records keep 0 photos and 1 note, which show again only when the card is added again.');
	assert.equal(await page.locator('#start-over-left-out').count(), 0);
	assert.equal(await page.locator('#start-over-export').count(), 1, 'Export CSV is offered before anything goes');
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

	assert.equal(await page.locator('#start-over-undo').count(), 1, 'Undo right after');

	// Leaving the screen does not lose Undo: the import screen offers it.
	await page.goto(url('import'));
	await page.waitForSelector('#start-over-kept-undo');
	assert.match(await page.locator('#start-over-kept').textContent(), /2 removed, 3 added/);
	await page.click('#start-over-kept-undo');
	await page.waitForSelector('#start-over-undone');
	assert.equal(await page.locator('#start-over-undone').textContent(), 'Undone. 2 copies are back, and 3 added copies were removed.');
	assert.deepEqual(await state(page, binderId), before, 'Undo puts every copy and the pocket back');

	await page.goto(url('import'));
	await page.waitForSelector('#monprice-file');
	assert.equal(await page.locator('#start-over-kept-undo').count(), 0, 'Undo is offered once');
	await done();
});

test('off when no row matched; rows above the large-count limit left unticked are listed', async () => {
	const {done, page} = await phone();

	await page.goto(url('import'));
	await page.setInputFiles('#monprice-file', {buffer: Buffer.from([CSV.split('\r\n')[0], CSV.split('\r\n')[3]].join('\r\n')), mimeType: 'text/csv', name: 'none.csv'});
	await page.waitForSelector('#start-over');
	assert.ok(await page.locator('#start-over').isDisabled());
	assert.ok(await page.locator('#start-over-empty').isVisible());

	const large = [CSV.split('\r\n')[0], 'Test card 1;Test set;001/009;PT;NORMAL;1;tst1_int_1;2026-01-01', 'Test card 3;Test set;003/009;PT;NORMAL;60;tst1_int_3;2026-01-01'].join('\r\n');

	await page.setInputFiles('#monprice-file', {buffer: Buffer.from(large), mimeType: 'text/csv', name: 'large.csv'});
	await page.waitForSelector('#import-large');
	assert.ok(await page.locator('#start-over').isEnabled());
	assert.ok(!await page.locator('#start-over-empty').isVisible());
	await page.click('#start-over');
	await page.waitForSelector('#start-over-preview');
	assert.equal(await page.locator('#start-over-preview').textContent(), 'Remove 0 copies, add 1 copy, 0 photos kept, 0 pockets become placeholders.');
	assert.match(await page.locator('#start-over-left-out summary').textContent(), /^1 row is left out: more than 50 copies and not ticked above$/);
	await done();
});
