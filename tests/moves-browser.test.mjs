// Browser test for the trades and sales log (js/moves-view.js; DESIGN.md
// section 11, "Trades and Sales"): a sale of one copy logged from its card
// page, seen in History and on the card page, then undone; a trade with one
// card out and one in; Log a past sale, which links a copy removed by hand
// two days ago; and Edit of a logged move's price, seen in History and on
// the card page, with Undo working after it. Headless Chromium against tests/pages-server.mjs,
// signed out, at 390 x 844.
//
// Every outside service is faked: TCGdex and the exchange rates by
// tests/my-cards-fixtures.mjs, PokeAPI by tests/fake-pokeapi.mjs. Supabase
// must never be contacted, and ligapokemon.com.br is never requested.
// Invented cards only.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/moves-browser.test.mjs
// Screenshots: $SHOTS (default /tmp)/moves-*.png

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, test} from 'node:test';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {BASE, BINDERS, COPIES, fakeServices, seed} from './my-cards-fixtures.mjs';
import {startPagesServer} from './pages-server.mjs';
import {untilInPage} from './poll.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

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

// A phone with the fixture copies (Bulbasaur c-01 in the binder's pocket 1)
// and, when asked, a Pikachu copy removed by hand two days ago.
async function phone({removed = false} = {}) {
	const context = await browser.newContext({serviceWorkers: 'block', viewport: PHONE});
	const log = await fakeServices(context);

	await fakePokeApi(context);

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(String(err)));

	const gone = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
	const copies = removed
		? [...COPIES, {card_id: 'tsb2-025', catalog: 'international', created_at: '2026-09-15T12:00:00.000Z', deleted_at: gone, id: 'c-11', language: 'pt', language_source: 'manual', updated_at: gone, variant_id: null}]
		: COPIES;

	await seed(page, server.origin, {binders: BINDERS, copies});

	const done = async () => {
		assert.deepEqual(errors, []);
		assert.deepEqual(log.other.filter((item) => /supabase|ligapokemon/.test(item)), [], 'Supabase and Liga Pokémon are never requested');
		await context.close();
	};

	return {done, gone, page};
}

const state = (page) => page.evaluate(async () => {
	const {loadDocument} = await import('/pokemon-card-tracker/js/collection.js');
	const doc = await loadDocument();
	const pocket = doc.binders[0].slots.find((slot) => slot.page === 1 && slot.position === 1 && !slot.cleared);

	return {
		cards: Object.fromEntries(doc.cards.map((entry) => [entry.id, {came_via: entry.came_via || null, card_id: entry.card_id, deleted_at: entry.deleted_at || null, left_via: entry.left_via || null}])),
		moves: (doc.moves || []).map((move) => ({deleted: Boolean(move.deleted_at), id: move.id, in: move.in, kind: move.kind, out: move.out, past: move.past, price: move.price, who: move.who})),
		pocket: pocket ? (pocket.entry_id || `want:${pocket.want && pocket.want.card_id}`) : null,
	};
});

const pickKind = (page, kind) => page.locator(`label:has(#move-kind-${kind})`).click();

test('a sale of one copy from its card page shows in History and on the card page, and Undo puts it back', async () => {
	const {done, page} = await phone();

	// My Cards and Profile both reach the log.
	await page.waitForSelector('#cards-moves');
	await page.screenshot({path: `${SHOTS}/moves-my-cards.png`});
	assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Trades beside Spares fits at 390 px');
	await page.click('#cards-moves');
	await page.waitForSelector('#moves-empty');
	await page.goto(url('profile'));
	await page.waitForSelector('#profile-moves');

	await page.goto(url('cards/en/tsa1-001'));
	await page.waitForSelector('#card-move');
	assert.ok(await page.locator('#card-moves').isHidden(), 'no move yet');
	await page.click('#card-move');
	await page.waitForSelector('#move-form');
	await page.waitForSelector('#move-out-list [data-entry="c-01"]');
	assert.ok(await page.locator('#move-in-section').isHidden(), 'a sale has no cards in');
	await page.fill('#move-who', 'Ana');
	await page.fill('#move-price', '30,50');
	await page.screenshot({fullPage: true, path: `${SHOTS}/moves-sale-form.png`});
	await page.click('#move-save');

	await page.waitForSelector('.moves-row');
	assert.equal(new URL(page.url()).pathname, `${BASE}trades`);
	assert.match(await page.locator('.toast-text').first().textContent(), /^Saved: 1 card out\./);
	assert.equal(await page.locator('.moves-title').first().textContent(), 'Sold for R$ 30,50 to Ana');
	assert.match(await page.locator('.moves-cards').first().textContent(), /^Out: Bulbasaur$/);
	assert.match(await page.locator('.moves-money').first().textContent(), /^In R\$ 30,50$/);
	await page.screenshot({fullPage: true, path: `${SHOTS}/moves-history.png`});

	let now = await state(page);
	const [move] = now.moves;

	assert.equal(now.cards['c-01'].left_via, move.id);
	assert.ok(now.cards['c-01'].deleted_at, 'the copy left the collection');
	assert.equal(now.pocket, 'want:tsa1-001', 'its pocket is the card\'s placeholder');
	assert.deepEqual({...move, id: null}, {deleted: false, id: null, in: [], kind: 'sold', out: ['c-01'], past: [], price: 30.5, who: 'Ana'});

	await page.goto(url('cards/en/tsa1-001'));
	await page.waitForSelector('#card-moves .card-move-out');
	assert.match(await page.locator('#card-moves').textContent(), /^Left: sold for R\$ 30,50 to Ana, \d+ \w{3}( \d{4})? \(English\)$/);
	await page.screenshot({fullPage: true, path: `${SHOTS}/moves-card-page.png`});

	// Undo from History.
	await page.click('#card-moves .card-move-line');
	await page.waitForSelector('.moves-row');
	await page.click('.moves-row');
	await page.waitForSelector('#move-undo');
	await page.click('#move-undo');
	await page.click('#move-undo-go');
	await page.waitForSelector('#moves-empty');
	assert.match(await page.locator('.toast-text').last().textContent(), /^Undone\. 1 copy is back, and 0 cards in were removed\.$/);

	now = await state(page);
	assert.equal(now.cards['c-01'].deleted_at, null);
	assert.equal(now.cards['c-01'].left_via, null);
	assert.equal(now.pocket, 'c-01', 'the copy is back in its pocket');
	assert.equal(now.moves[0].deleted, true);
	await done();
});

test('a trade with one card out and one card in', async () => {
	const {done, page} = await phone();

	// Sell or trade on a copy's sheet starts a move with that copy; the
	// sheet closes with the route change.
	await page.goto(url('cards/en/tsa1-004'));
	await page.waitForSelector('.copy-row');
	await page.locator('.copy-row').first().click();
	await page.waitForSelector('#copy-move');
	await page.click('#copy-move');
	await page.waitForSelector('#move-out-list .pick-cell');
	assert.equal(await page.locator('#move-out-list .pick-cell').count(), 1);
	assert.equal(await page.locator('#copy-sheet[open]').count(), 0, 'the copy sheet is closed');
	await page.locator('#move-out-list .move-unpick').click();
	assert.equal(await page.locator('#move-out-list .pick-cell').count(), 0);

	await page.goto(url('trades/new'));
	await page.waitForSelector('#move-form');
	await pickKind(page, 'traded');
	assert.ok(await page.locator('#move-money').isVisible(), 'a trade says which way the cash went');
	await page.fill('#move-who', 'Bruno');

	await page.click('#move-add-out');
	await page.waitForSelector('#move-out-results [data-entry="c-02"]');
	await page.click('#move-out-results [data-entry="c-02"]');
	assert.equal(await page.locator('#move-out-results [data-entry="c-02"]').getAttribute('aria-pressed'), 'true');
	assert.equal(await page.locator('#move-out-done').textContent(), 'Done (1)');
	await page.click('#move-out-done');
	await page.waitForSelector('#move-out-list [data-entry="c-02"]');

	await page.click('#move-add-in');
	await page.fill('#move-in-search', 'tsb2-090');
	await page.click('#move-in-go');
	await page.waitForSelector('#move-in-results [data-card="tsb2-090"]');
	await page.click('#move-in-results [data-card="tsb2-090"]');
	await page.waitForSelector('#move-in-add');
	await page.selectOption('#move-in-condition', 'Near Mint');
	await page.click('#move-in-add');
	await page.waitForSelector('#move-in-list [data-card="tsb2-090"]');
	await page.screenshot({fullPage: true, path: `${SHOTS}/moves-trade-form.png`});
	await page.click('#move-save');

	await page.waitForSelector('.moves-row');
	assert.match(await page.locator('.toast-text').first().textContent(), /^Saved: 1 card out, 1 card in\./);
	assert.equal(await page.locator('.moves-title').first().textContent(), 'Traded with Bruno');
	assert.equal(await page.locator('.moves-cards').first().textContent(), 'Out: Charmander. In: Sprigatito');

	const now = await state(page);
	const [move] = now.moves;
	const added = move.in[0];

	assert.equal(move.kind, 'traded');
	assert.deepEqual(move.out, ['c-02']);
	assert.equal(now.cards['c-02'].left_via, move.id);
	assert.equal(now.cards[added].came_via, move.id);
	assert.equal(now.cards[added].card_id, 'tsb2-090');
	assert.equal(now.cards[added].deleted_at, null);

	// The incoming copy's page says how it came.
	await page.goto(url('cards/en/tsb2-090'));
	await page.waitForSelector('#card-moves .card-move-in');
	assert.match(await page.locator('#card-moves .card-move-in').textContent(), /^Came in: traded with Bruno, /);
	await done();
});

test('Log a past sale links a copy removed by hand, and it stays removed', async () => {
	const {done, gone, page} = await phone({removed: true});

	await page.goto(url('trades/new'));
	await page.waitForSelector('#move-form');
	await page.click('#move-add-out');
	await page.waitForSelector('#move-out-results .move-copy');
	await page.locator('label:has(#move-tab-past)').click();
	await page.waitForSelector('#move-out-results [data-entry="c-11"]');
	assert.equal(await page.locator('#move-out-results .move-copy').count(), 1, 'only the copy removed by hand in the last 30 days');
	assert.match(await page.locator('#move-out-results [data-entry="c-11"] .tile-meta').textContent(), /^Portuguese · Removed \d+ \w{3}/);
	await page.screenshot({fullPage: true, path: `${SHOTS}/moves-past.png`});
	await page.click('#move-out-results [data-entry="c-11"]');
	await page.click('#move-out-done');
	await page.waitForSelector('#move-out-list [data-entry="c-11"]');
	await page.fill('#move-price', '12');
	await page.click('#move-save');

	await page.waitForSelector('.moves-row');
	assert.equal(await page.locator('.moves-title').first().textContent(), 'Sold for R$ 12,00');

	const now = await state(page);
	const [move] = now.moves;

	assert.deepEqual([move.out, move.past], [['c-11'], ['c-11']]);
	assert.equal(now.cards['c-11'].left_via, move.id);
	assert.equal(now.cards['c-11'].deleted_at, gone, 'its removal is unchanged');

	// Its card page says where it went.
	await page.goto(url('cards/en/tsb2-025'));
	await page.waitForSelector('#card-moves .card-move-out');
	assert.match(await page.locator('#card-moves').textContent(), /^Left: sold for R\$ 12,00, /);
	await done();
});

test('the price reads back as it will be saved, "1.500" as R$ 1.500,00, and a form it cannot read is refused', async () => {
	const {done, page} = await phone();
	const read = () => page.locator('#move-price-read').textContent();

	await page.goto(url('cards/en/tsa1-001'));
	await page.waitForSelector('#card-move');
	await page.click('#card-move');
	await page.waitForSelector('#move-out-list [data-entry="c-01"]');

	await page.fill('#move-price', '1,2,3');
	assert.equal(await read(), 'Type the price as 30,50 or 1.500,00, or leave it empty.');
	await page.click('#move-save');
	assert.equal(await page.locator('#move-error').textContent(), 'Type the price as 30,50 or 1.500,00, or leave it empty.');
	assert.equal(new URL(page.url()).pathname, `${BASE}trades/new`, 'not saved');

	await page.fill('#move-price', '30,50');
	assert.match(await read(), /^Saved as R\$\s30,50$/);
	await page.fill('#move-price', '1.500');
	assert.match(await read(), /^Saved as R\$\s1\.500,00$/);
	await page.screenshot({fullPage: true, path: `${SHOTS}/moves-price-read.png`});
	await page.click('#move-save');
	await page.waitForSelector('.moves-row');
	assert.equal((await state(page)).moves[0].price, 1500);
	assert.match(await page.locator('.moves-title').first().textContent(), /^Sold for R\$\s1\.500,00$/);
	await done();
});

test('Undo Start over is refused, naming the move, while a later sale counts a copy it added, and works once that sale is undone', async () => {
	const {done, page} = await phone();

	// Start over with a file holding Bulbasaur, then sell the copy it added.
	await page.evaluate(async () => {
		const {applyStartOver} = await import('/pokemon-card-tracker/js/start-over.js');
		const {importEntries} = await import('/pokemon-card-tracker/js/monprice.js');
		const {applyMove} = await import('/pokemon-card-tracker/js/moves.js');
		const entries = importEntries([{cardId: 'tsa1-001', catalog: 'international', row: {count: 1, finish: 'NORMAL', language: 'en', monpriceId: 'tsa1_int_1', name: 'Bulbasaur', setName: 'Test set A'}, status: 'matched', variantId: 'normal'}]);
		const {undo} = await applyStartOver(entries);

		await applyMove({date: '2026-11-01', kind: 'sold', out: [undo.added[0]], price: '50', who: 'Ana'});
	});

	await page.goto(url('import'));
	await page.waitForSelector('#start-over-kept-undo');
	await page.click('#start-over-kept-undo');
	await page.waitForSelector('#start-over-undo-blocked');
	assert.match(await page.locator('#start-over-undo-blocked').textContent(), /^"Sold for R\$\s50,00 to Ana" on 1 Nov( 2026)? in Trades and sales counts a copy that Undo Start over would change\. Undo that move first, then Undo Start over\. Nothing was changed\. Open Trades and sales$/);
	assert.equal(await page.locator('#start-over-kept-undo').isEnabled(), true, 'Undo stays for after');
	await page.screenshot({fullPage: true, path: `${SHOTS}/moves-start-over-blocked.png`});

	let now = await state(page);

	assert.equal(Object.values(now.cards).filter((entry) => !entry.deleted_at).length, 0, 'nothing came back');

	// Undo the sale in History, then Undo Start over.
	await page.click('#start-over-undo-blocked a');
	await page.waitForSelector('.moves-row');
	await page.click('.moves-row');
	await page.click('#move-undo');
	await page.click('#move-undo-go');
	await page.waitForSelector('#moves-empty');
	await page.goto(url('import'));
	await page.waitForSelector('#start-over-kept-undo');
	await page.click('#start-over-kept-undo');
	await page.waitForSelector('#start-over-undone');

	now = await state(page);
	assert.deepEqual(Object.entries(now.cards).filter(([, entry]) => !entry.deleted_at).map(([id]) => id).sort(), ['c-01', 'c-02', 'c-03', 'c-04', 'c-05', 'c-06', 'c-07', 'c-08', 'c-09', 'c-10']);
	assert.equal(now.pocket, 'c-01', 'Bulbasaur is back in its pocket');
	await done();
});

test('Edit changes a logged sale\'s price and who: History and the card page follow, and Undo still puts the copy back', async () => {
	const {done, page} = await phone();

	await page.waitForSelector('#cards-moves');
	await page.evaluate(async () => {
		const {applyMove} = await import('/pokemon-card-tracker/js/moves.js');

		await applyMove({currency: 'BRL', date: '2026-11-03', kind: 'sold', out: ['c-01'], price: '30,50', who: 'Ana'});
	});

	await page.goto(url('trades'));
	await page.waitForSelector('.moves-row');
	assert.match(await page.locator('.moves-title').first().textContent(), /^Sold for R\$\s30,50 to Ana$/);
	await page.click('.moves-row');
	await page.waitForSelector('#move-edit');
	await page.click('#move-edit');
	await page.waitForSelector('#move-edit-form');
	assert.equal(await page.inputValue('#move-edit-price'), '30,50', 'the saved price, the Brazilian way');
	assert.equal(await page.inputValue('#move-edit-who'), 'Ana');
	assert.equal(await page.locator('#move-edit-money').count(), 0, 'a sale\'s money always comes in');

	await page.fill('#move-edit-price', '1,2,3');
	await page.click('#move-edit-save');
	assert.equal(await page.locator('#move-edit-error').textContent(), 'Type the price as 30,50 or 1.500,00, or leave it empty.');

	await page.fill('#move-edit-price', '1.500');
	assert.match(await page.locator('#move-edit-price-read').textContent(), /^Saved as R\$\s1\.500,00$/);
	await page.fill('#move-edit-who', 'Ana Lima');
	await page.screenshot({fullPage: true, path: `${SHOTS}/moves-edit.png`});
	await page.click('#move-edit-save');

	await page.waitForFunction(() => document.querySelector('.moves-title')?.textContent.includes('Ana Lima'));
	assert.match(await page.locator('.moves-title').first().textContent(), /^Sold for R\$\s1\.500,00 to Ana Lima$/);
	assert.match(await page.locator('.moves-money').first().textContent(), /^In R\$\s1\.500,00$/);
	assert.equal(await page.locator('#move-sheet[open]').count(), 0, 'the sheet closed');

	const saved = await untilInPage(page, 'the edited move', async () => {
		const {loadDocument} = await import('/pokemon-card-tracker/js/collection.js');
		const move = ((await loadDocument()).moves || [])[0];

		return move && move.price === 1500 ? move : null;
	});

	assert.deepEqual([saved.who, saved.out, saved.in, saved.kind], ['Ana Lima', ['c-01'], [], 'sold']);

	await page.goto(url('cards/en/tsa1-001'));
	await page.waitForSelector('#card-moves .card-move-out');
	assert.match(await page.locator('#card-moves').textContent(), /^Left: sold for R\$\s1\.500,00 to Ana Lima, 3 Nov( 2026)? \(English\)$/);

	// Undo after the edit puts the copy back in its pocket.
	await page.goto(url('trades'));
	await page.waitForSelector('.moves-row');
	await page.click('.moves-row');
	await page.click('#move-undo');
	await page.click('#move-undo-go');
	await page.waitForSelector('#moves-empty');

	const now = await state(page);

	assert.equal(now.cards['c-01'].deleted_at, null);
	assert.equal(now.pocket, 'c-01');
	assert.equal(now.moves[0].deleted, true);
	await done();
});

test('Edit saves only what was changed in the form: who changed on another phone while the form was open stays', async () => {
	const {done, page} = await phone();

	await page.waitForSelector('#cards-moves');
	await page.evaluate(async () => {
		const {applyMove} = await import('/pokemon-card-tracker/js/moves.js');

		await applyMove({currency: 'USD', date: '2026-11-03', kind: 'sold', out: ['c-01'], price: '1500', who: 'Ana'});
	});

	await page.goto(url('trades'));
	await page.waitForSelector('.moves-row');
	await page.click('.moves-row');
	await page.waitForSelector('#move-edit');
	await page.click('#move-edit');
	await page.waitForSelector('#move-edit-form');
	assert.equal(await page.inputValue('#move-edit-price'), '1.500,00');

	// Another phone's change to who reaches this phone while the form is open.
	await page.evaluate(async () => {
		const {editMove, liveMoves} = await import('/pokemon-card-tracker/js/moves.js');
		const {loadDocument} = await import('/pokemon-card-tracker/js/collection.js');

		await editMove(liveMoves(await loadDocument())[0].id, {who: 'Bia'});
	});
	await page.waitForFunction(() => document.querySelector('.moves-title')?.textContent.includes('Bia'));
	assert.equal(await page.inputValue('#move-edit-who'), 'Ana', 'the open form still shows what it opened with');

	await page.fill('#move-edit-note', 'Paid in cash');
	await page.click('#move-edit-save');

	const saved = await untilInPage(page, 'the note saved', async () => {
		const {loadDocument} = await import('/pokemon-card-tracker/js/collection.js');
		const move = ((await loadDocument()).moves || [])[0];

		return move && move.note === 'Paid in cash' ? move : null;
	});

	assert.deepEqual([saved.who, saved.price, saved.currency, saved.money], ['Bia', 1500, 'USD', 'in'], 'who stays as the other phone left it, and the price as it was');
	await done();
});
