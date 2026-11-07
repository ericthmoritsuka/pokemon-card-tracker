// Browser test for the scanner's Trade or sale mode (js/scan/trade.js and
// js/scan/trade-sheets.js; Eric, 2026-11-06; DESIGN.md section 11, "Scan a
// trade or a sale"), in headless Chromium at 360 px against
// tests/scan-harness.mjs (Supabase is never reached; TCGdex answers are
// replayed from the harness cache), with the canvas camera of
// tests/scan-scene.mjs:
//
// - switch to Trade or sale, scan two cards going out and one coming in
//   (hand-held, Eric's pile method), the one spare of the first taken by
//   itself and the second's copy picked from the copies that fit (they
//   differ in condition) with the tray's Pick a copy; Log cards opens the
//   trades log's form filled in (Traded, the copies out, the card in,
//   today), Save logs the move: the copies left, the card arrived, the
//   trade tray is empty, and Undo puts the collection back;
// - three cards going out whose copies must be picked: Log cards opens one
//   sheet with all three (and the card not owned, under Not logged), they
//   are picked in any order, and the last pick opens the form filled in
//   with all three, with no second Log cards;
// - switching to Add with cards in the trade tray asks first, Keep them
//   keeps them, the Add tray waits untouched meanwhile, Close asks too, and
//   Add scans and saves as before.
//
// Invented collections only: the cards owned are copies of the harness's
// three test cards, added in the test.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/scan-trade-browser.test.mjs
// Screenshots: $SHOTS (default /tmp)/scan-trade-*.png

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {untilInPage} from './poll.mjs';
import {cardImage, routeTcgdex, startScanHarness} from './scan-harness.mjs';
import {sceneCamera} from './scan-scene.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const CARDS = {a: 'me01-001', b: 'sv03.5-025', c: 'swsh3-102'};
const FRAME = {height: 3840, width: 2160};
const SHOTS = process.env.SHOTS || '/tmp';

let harness;
let browser;

before(async () => {
	harness = await startScanHarness();
	browser = await chromium.launch();
});

after(async () => {
	await browser.close();
	await harness.close();
});

// A phone at 360 px, hand-held, English as the last language picked (the
// test cards are English), with `owned` copies added (a card ID, Near Mint,
// or {card, condition}) and `drafts` written before Scan opens. via
// 'trades': Scan is opened from Trades and sales' Scan the cards rather than
// by its address. viewport: another screen size, such as a phone held
// sideways.
async function open({drafts = null, owned = [], via = null, viewport = {height: 800, width: 360}} = {}) {
	const context = await browser.newContext({deviceScaleFactor: 3, viewport});

	await context.grantPermissions(['camera'], {origin: harness.origin});
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await routeTcgdex(context);

	for (const [key, id] of Object.entries(CARDS)) {
		await context.route(`**/__test-card${key === 'a' ? '' : `-${key}`}.webp`, async (route) => route.fulfill({contentType: 'image/webp', path: await cardImage(id)}));
	}

	await context.addInitScript(() => {
		if (sessionStorage.getItem('test-scene') === null) {
			sessionStorage.setItem('test-scene', JSON.stringify({kind: 'table'}));
		}
	});
	await context.addInitScript(sceneCamera, FRAME);
	await context.addInitScript(() => {
		localStorage.setItem('card-tracker:scan-holder', 'off');
		localStorage.setItem('card-tracker:scan-language', 'en');
		localStorage.setItem('card-tracker:scan-language-last', 'en');
	});

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(String(err)));
	await page.goto(`${harness.origin}${BASE}cards`);

	const ids = await page.evaluate(async ({drafts: trays, owned: list}) => {
		const collection = await import('/pokemon-card-tracker/js/collection.js');
		const draft = await import('/pokemon-card-tracker/js/scan/draft.js');
		const added = await collection.addCards(list.map((one) => ({card_id: one.card || one, catalog: 'international', condition: one.condition || 'Near Mint', language: 'en', language_source: 'manual', variant_id: null})));

		for (const tray of trays || []) {
			await draft.saveSession(tray);
		}

		return added.map((entry) => entry.id);
	}, {drafts, owned});

	if (via === 'trades') {
		await page.goto(`${harness.origin}${BASE}trades`);
		await page.waitForSelector('#moves-scan');
		assert.equal(await page.textContent('#moves-scan'), 'Scan a trade or sale');
		await page.screenshot({path: `${SHOTS}/scan-trade-from-trades.png`});
		await page.click('#moves-scan');
	}
	else {
		await page.goto(`${harness.origin}${BASE}scan`);
	}

	await page.waitForSelector('#scan-guide:not([hidden])', {timeout: 30000});
	await page.waitForFunction(() => document.getElementById('scan-video').videoWidth > 0);
	await page.waitForSelector('#scan-shutter:not([disabled])');

	return {context, errors, ids, page};
}

const setScene = (page, scene) => page.evaluate((next) => {
	window.scene = next;
}, scene);

async function repaint(page) {
	await page.waitForTimeout(250);
	await page.evaluate(() => {
		window.scene = {...window.scene};
	});
}

// The scanning mode the switch shows: 'add' or 'trade'.
const modeOf = (page) => page.getAttribute('#scan-mode', 'data-mode');
// Presses the segment of the mode not in use, as a thumb on the switch does.
const switchMode = async (page) => page.click((await modeOf(page)) === 'trade' ? '#scan-mode-add' : '#scan-mode-trade');

const captures = (page) => page.evaluate(async () => (await import('/pokemon-card-tracker/js/scan/view.js')).scanStats.captures);

// The trays as kept in the draft.
const trays = (page) => page.evaluate(async () => {
	const draft = await import('/pokemon-card-tracker/js/scan/draft.js');
	const shape = (session) => (session ? session.items.map((item) => ({card: item.card && item.card.id, language: item.language, side: item.side || null, status: item.status})) : []);

	return {add: shape(await draft.loadSession('add')), trade: shape(await draft.loadSession('trade'))};
});

async function until(check, what, timeout = 30000) {
	const end = Date.now() + timeout;

	while (!(await check())) {
		assert.ok(Date.now() < end, what);
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
}

async function readAll(page, mode, count) {
	await until(async () => {
		const list = (await trays(page))[mode];

		return list.length === count && list.every((item) => item.status !== 'reading' && item.status !== 'matching');
	}, `${count} cards read`, 60000);
}

// A hand passes over the camera and leaves `next` in view, as when the top
// card of a pile is taken off (tests/scan-newcard-browser.test.mjs).
async function handTo(page, before, next) {
	for (const [k, dx] of [0.5, 0.25, 0, -0.25, -0.5].entries()) {
		await setScene(page, {cards: k < 2 ? before : next, hand: {dx, dy: 0.1, r: 0.35}});
		await page.waitForTimeout(110);
	}

	await setScene(page, {cards: next});
	await repaint(page);
}

// Until no card in the tray is still read, looked up, or loading its
// finishes.
async function calm(page, rows) {
	await until(() => page.$$eval(rows, (list) => list.length > 0 && list.every((row) => !['finishes', 'matching', 'reading', 'rematch', 'waiting', 'busy'].includes(row.dataset.status))), 'every card settled', 30000);
}

// Any card the scanner is unsure of is settled as its sheet asks: the test
// card among the candidates, and English.
async function settle(page, tiles) {
	for (let guard = 0; guard < 6 && await page.locator(tiles).count(); guard++) {
		await page.locator(tiles).first().click();
		await page.waitForSelector('#scan-confirm');

		const candidate = page.locator(Object.values(CARDS).map((id) => `#scan-confirm .scan-candidate[data-card="${id}"]`).join(', ')).first();

		if (await candidate.count()) {
			await candidate.click();
		}

		if (!await page.locator('#scan-lang-en').count() && await page.locator('#scan-lang-more').count()) {
			await page.click('#scan-lang-more');
		}

		const english = page.locator('#scan-lang-en[aria-pressed="false"]');

		if (await english.count()) {
			await english.click();
		}

		if (await page.locator('#scan-confirm').count()) {
			await page.locator('#scan-sheet-close').click();
		}

		await page.waitForTimeout(300);
	}
}

const collectionState = (page) => page.evaluate(async () => {
	const {loadDocument} = await import('/pokemon-card-tracker/js/collection.js');
	const doc = await loadDocument();

	return {
		cards: doc.cards.map((entry) => ({came_via: entry.came_via || null, card_id: entry.card_id, deleted: Boolean(entry.deleted_at), id: entry.id, language: entry.language, language_source: entry.language_source, left_via: entry.left_via || null})),
		moves: (doc.moves || []).map((move) => ({deleted: Boolean(move.deleted_at), in: move.in, kind: move.kind, out: move.out, who: move.who})),
	};
});

describe('Trade or sale', () => {
	test('scan two cards out and one in, Log cards fills the trades log, Save logs the move, and Undo puts it back', async () => {
		// me01-001: k-a kept, s-a its one spare, alike, so the spare goes by
		// itself. sv03.5-025: three copies, one Played, so its copy is asked
		// for.
		const {context, errors, ids, page} = await open({owned: [CARDS.a, CARDS.a, {card: CARDS.b, condition: 'Played'}, CARDS.b, CARDS.b]});
		const [, spareA, ...copiesB] = ids;

		assert.equal(await modeOf(page), 'add', 'Add is the default');
		assert.equal(await page.textContent('#scan-mode [aria-pressed="true"]'), 'Add');
		await switchMode(page);
		assert.equal(await modeOf(page), 'trade');
		assert.equal(await page.textContent('#scan-mode [aria-pressed="true"]'), 'Trade or sale');
		assert.equal(await page.evaluate(() => localStorage.getItem('card-tracker:scan-mode')), 'trade', 'the mode is kept on the phone');
		assert.ok(await page.locator('#scan.is-trade').count(), 'the screen shows the mode');
		assert.equal(await page.textContent('#scan-done-open'), 'Log cards', 'the button counts the tray, as Done does');
		assert.equal(await page.getAttribute('#scan-side-out', 'aria-pressed'), 'true', 'scans start on Going out');
		// The next scans' column has a filled head; the other says to tap it,
		// and each empty column says what it is for.
		assert.equal(await page.locator('#scan-side-out .scan-trade-next').count(), 0);
		assert.equal(await page.textContent('#scan-side-in .scan-trade-next'), 'Tap to scan here');
		assert.deepEqual(await page.locator('#scan-tray .scan-trade-empty').allTextContents(), ['Cards you give', 'Cards you get']);
		assert.ok((await page.locator('#scan-side-out').boundingBox()).height >= 48, 'the heads are 48 px tall');
		await page.screenshot({path: `${SHOTS}/scan-trade-mode.png`});

		// Two cards going out.
		const first = [{card: 'a', size: 0.95}];
		const second = [{angle: 0.6, card: 'b', size: 0.95}];

		await setScene(page, {cards: first});
		await until(async () => (await captures(page)) === 1, 'the first card taken', 15000);
		await readAll(page, 'trade', 1);
		assert.equal(await page.textContent('#scan-done-open'), 'Log 1 card');
		await handTo(page, first, second);
		await until(async () => (await captures(page)) === 2, 'the second card taken', 15000);
		await readAll(page, 'trade', 2);

		// One coming in.
		await page.click('#scan-side-in');
		assert.equal(await page.getAttribute('#scan-side-in', 'aria-pressed'), 'true');

		const third = [{angle: -0.5, card: 'c', size: 0.95}];

		await handTo(page, second, third);
		await until(async () => (await captures(page)) === 3, 'the third card taken', 15000);
		await readAll(page, 'trade', 3);

		const scanned = (await trays(page)).trade;

		assert.equal(await page.textContent('#scan-done-open'), 'Log 3 cards');
		assert.equal(await page.textContent('#scan-side-out .scan-trade-next'), 'Tap to scan here', 'the head of the column not scanning into says to tap it');

		assert.deepEqual(scanned.map((item) => [item.card, item.side]), [[CARDS.a, 'out'], [CARDS.b, 'out'], [CARDS.c, 'in']]);
		assert.deepEqual((await trays(page)).add, [], 'nothing went to the Add tray');

		await calm(page, '#scan-tray [data-row]');
		await settle(page, '#scan-tray .scan-trade-row.is-look .scan-trade-open');
		await calm(page, '#scan-tray [data-row]');

		// The first card's one spare went by itself; the second asks.
		await page.waitForSelector('#scan-trade-out [data-row] .scan-trade-pick[data-pick]');
		assert.equal(await page.locator('#scan-trade-out .scan-trade-row.is-ask').count(), 1);
		await page.waitForTimeout(400);
		await page.screenshot({path: `${SHOTS}/scan-trade-tray.png`});

		// The row's Pick a copy opens the picker for that card.
		await page.click('#scan-trade-out .scan-trade-pick[data-pick]');
		await page.waitForSelector('#scan-copy-sheet');
		assert.equal(await page.locator('#scan-copy-grid .scan-copy').count(), 3, 'every copy of the second card that fits');
		await page.waitForTimeout(400);
		await page.screenshot({path: `${SHOTS}/scan-trade-picker.png`});

		const picked = copiesB[2];

		await page.click(`#scan-copy-grid [data-entry="${picked}"]`);
		await page.waitForSelector('#scan-copy-sheet', {state: 'detached'});
		assert.equal(await page.locator('#scan-trade-out .scan-trade-row.is-ask').count(), 0);
		assert.match(await page.locator('#scan-trade-out .scan-trade-line').first().textContent(), /^Your pick · English/);

		// Nothing in the collection has changed yet.
		const before = await collectionState(page);

		assert.equal(before.cards.filter((entry) => entry.deleted).length, 0);
		assert.deepEqual(before.moves, []);

		// Log cards: the trades log's form, filled in.
		await page.click('#scan-done-open');
		await page.waitForSelector('#move-form');
		assert.equal(new URL(page.url()).pathname, `${BASE}trades/new`);
		assert.ok(await page.isChecked('#move-kind-traded'), 'both sides: Traded');
		await page.waitForSelector(`#move-out-list [data-entry="${spareA}"]`);
		assert.deepEqual(await page.$$eval('#move-out-list [data-entry]', (cells) => cells.map((cell) => cell.dataset.entry)), [spareA, picked]);
		assert.deepEqual(await page.$$eval('#move-in-list [data-card]', (cells) => cells.map((cell) => cell.dataset.card)), [CARDS.c]);
		assert.equal(await page.locator('#move-out-list .move-row, #move-in-list .move-row').count(), 3, 'the scanned cards as compact rows');
		assert.deepEqual(await page.$$eval('.move-side h3', (heads) => heads.map((head) => head.textContent)), ['Going out', 'Coming in']);
		assert.match(await page.textContent('#move-scanned'), /^Scanned 2 going out, 1 coming in\. Add who and the price, then Save\.$/);

		const today = await page.evaluate(() => {
			const now = new Date();

			return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
		});

		assert.equal(await page.inputValue('#move-date'), today);
		await page.fill('#move-who', 'Member A');
		await page.fill('#move-price', '10');
		await page.screenshot({fullPage: true, path: `${SHOTS}/scan-trade-form.png`});
		await page.click('#move-save');

		await page.waitForSelector('.moves-row');
		assert.match(await page.locator('.toast-text').first().textContent(), /^Saved: 2 cards out, 1 card in\./);

		const after = await collectionState(page);
		const [move] = after.moves;

		assert.equal(move.kind, 'traded');
		assert.equal(move.who, 'Member A');
		assert.deepEqual(after.cards.filter((entry) => entry.left_via).map((entry) => [entry.id, entry.deleted]), [[spareA, true], [picked, true]]);
		assert.deepEqual(after.cards.filter((entry) => entry.came_via).map((entry) => [entry.card_id, entry.language, entry.language_source, entry.deleted]), [[CARDS.c, 'en', 'scan', false]]);
		await untilInPage(page, 'the trade tray emptied', async () => {
			const session = await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession('trade');

			return Boolean(session && session.items.length === 0);
		});

		// Undo, on the toast.
		await page.locator('.toast button', {hasText: 'Undo'}).first().click();
		await untilInPage(page, 'the move undone', async () => {
			const {loadDocument} = await import('/pokemon-card-tracker/js/collection.js');
			const doc = await loadDocument();

			return doc.moves.every((one) => one.deleted_at);
		});

		const undone = await collectionState(page);

		assert.deepEqual(undone.cards.filter((entry) => entry.deleted).map((entry) => entry.card_id), [CARDS.c], 'the copies are back and the card in is gone');
		assert.equal(undone.cards.filter((entry) => !entry.deleted).length, 5);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('Scan a trade on Trades and sales opens Scan in Trade or sale, with the trade tray as it was', async () => {
		const at = '2026-11-06T10:00:00.000Z';
		const card = {catalog: 'international', id: CARDS.c, image: null, lang: 'en', localId: '102', name: 'Waiting card', official: '189', setId: 'swsh3', setName: 'Darkness Ablaze'};
		const item = (id, extra = {}) => ({candidates: [], captured_at: at, card, condition: null, confirmed: true, finishBy: 'plain', id, language: 'en', languageBy: 'hand', names: [], read: null, status: 'ready', sure: true, timings: {}, variantId: null, variants: [], why: null, ...extra});
		const addTray = {created_at: at, id: 'add-1', items: [item('a1')], lastSave: null, sheetShown: false, updated_at: at};
		const tradeTray = {created_at: at, id: 'trade-1', items: [item('t1', {side: 'out'})], lastSave: null, mode: 'trade', sheetShown: false, side: 'out', updated_at: at};
		// Add was the mode last used on this phone.
		const {context, errors, page} = await open({drafts: [addTray, tradeTray], via: 'trades'});

		assert.equal(new URL(page.url()).pathname, `${BASE}scan`);
		assert.equal(await modeOf(page), 'trade', 'opened in Trade or sale');
		assert.equal(await page.textContent('#scan-mode [aria-pressed="true"]'), 'Trade or sale');
		assert.equal(await page.evaluate(() => localStorage.getItem('card-tracker:scan-mode')), 'trade', 'the mode is kept, as the switch keeps it');
		await page.waitForSelector('#scan-trade-out [data-row="t1"]');
		assert.deepEqual((await trays(page)).trade.map((one) => one.card), [CARDS.c], 'the trade tray kept its card');
		assert.deepEqual((await trays(page)).add.map((one) => one.card), [CARDS.c], 'the Add tray is left as it was');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('three cards whose copies must be picked: Log cards shows them all on one sheet, and the last pick opens the form with all three', async () => {
		const at = '2026-11-06T10:00:00.000Z';
		const card = (id, name) => ({catalog: 'international', id, image: null, lang: 'en', localId: '1', name, official: '99', setId: id.split('-')[0], setName: 'Test'});
		const item = (id, cardId, name) => ({candidates: [], captured_at: at, card: card(cardId, name), condition: null, confirmed: true, finishBy: 'plain', id, language: 'en', languageBy: 'hand', names: [], read: null, side: 'out', status: 'ready', sure: true, timings: {}, variantId: null, variants: [], why: null});
		const tray = {created_at: at, id: 'trade-4', items: [item('t1', CARDS.a, 'First card'), item('t2', CARDS.b, 'Second card'), item('t3', CARDS.c, 'Third card'), item('t4', 'zzz9-999', 'Not owned card')], lastSave: null, mode: 'trade', sheetShown: false, side: 'out', updated_at: at};
		// Two copies of each card, one Near Mint and one Played: each asks.
		const owned = [CARDS.a, CARDS.b, CARDS.c].flatMap((id) => [id, {card: id, condition: 'Played'}]);
		const {context, errors, ids, page} = await open({drafts: [tray], owned});
		const [, playedA, nearB, , , playedC] = ids;

		await switchMode(page);
		await page.waitForSelector('#scan-trade-out [data-row="t3"][data-status="ask"]');
		assert.equal(await page.locator('#scan-trade-out .scan-trade-row.is-ask').count(), 3);

		await page.click('#scan-done-open');
		await page.waitForSelector('#scan-picks-sheet');
		assert.deepEqual(await page.$$eval('#scan-picks-sheet .scan-picks-card', (cards) => cards.map((one) => [one.dataset.pickItem, one.dataset.status])), [['t1', 'ask'], ['t2', 'ask'], ['t3', 'ask'], ['t4', 'none']], 'all three at once, and the card not owned under them');
		assert.equal(await page.locator('#scan-picks-sheet [data-pick-item="t1"] .scan-copy').count(), 2);
		assert.match(await page.textContent('#scan-picks-sheet [data-pick-item="t1"] .scan-copy'), /Loose/);
		assert.equal(await page.textContent('#scan-picks-sheet [data-pick-item="t4"] .scan-picks-line'), 'Not in your cards, so it cannot go out. Not logged.');
		assert.ok(await page.locator('#scan-picks-go').isDisabled(), 'Log 4 cards waits for every pick');
		assert.equal(await page.textContent('#scan-picks-go'), 'Log 4 cards (3 to pick)');
		await page.waitForTimeout(400);
		await page.screenshot({path: `${SHOTS}/scan-trade-picks.png`});

		// Any order: the third, then the first; the sheet stays, each pick
		// shown.
		await page.click(`#scan-picks-sheet [data-pick-item="t3"] [data-entry="${playedC}"]`);
		await page.waitForSelector(`#scan-picks-sheet [data-pick-item="t3"][data-status="chosen"] [data-entry="${playedC}"][aria-pressed="true"]`);
		await page.click(`#scan-picks-sheet [data-pick-item="t1"] [data-entry="${playedA}"]`);
		await page.waitForSelector('#scan-picks-sheet [data-pick-item="t1"][data-status="chosen"]');
		assert.equal(await page.locator('#scan-picks-sheet').count(), 1);
		assert.ok(await page.locator('#scan-picks-go').isDisabled());
		assert.equal(new URL(page.url()).pathname, `${BASE}scan`);

		// The last pick opens the form, filled in with all three.
		await page.click(`#scan-picks-sheet [data-pick-item="t2"] [data-entry="${nearB}"]`);
		await page.waitForSelector('#move-form');
		assert.equal(new URL(page.url()).pathname, `${BASE}trades/new`);
		assert.ok(await page.isChecked('#move-kind-sold'), 'cards only going out: Sold');
		await page.waitForSelector(`#move-out-list [data-entry="${playedC}"]`);
		assert.deepEqual(await page.$$eval('#move-out-list [data-entry]', (cells) => cells.map((cell) => cell.dataset.entry)), [playedA, nearB, playedC]);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a card going out that is not owned says so and is not logged; only cards out log a sale', async () => {
		const at = '2026-11-06T10:00:00.000Z';
		const card = (id, name) => ({catalog: 'international', id, image: null, lang: 'en', localId: '1', name, official: '99', setId: id.split('-')[0], setName: 'Test'});
		const item = (id, cardId, name, side) => ({candidates: [], captured_at: at, card: card(cardId, name), condition: null, confirmed: true, finishBy: 'plain', id, language: 'en', languageBy: 'hand', names: [], read: null, side, status: 'ready', sure: true, timings: {}, variantId: null, variants: [], why: null});
		const tray = {created_at: at, id: 'trade-1', items: [item('t1', CARDS.a, 'Owned card', 'out'), item('t2', 'zzz9-999', 'Not owned card', 'out')], lastSave: null, mode: 'trade', sheetShown: false, side: 'out', updated_at: at};
		const {context, errors, ids, page} = await open({drafts: [tray], owned: [CARDS.a]});

		await switchMode(page);
		await page.waitForSelector('#scan-trade-out [data-row="t2"]');
		assert.equal(await page.textContent('#scan-trade-out [data-row="t2"] .scan-trade-line'), 'Not in your cards, so it cannot go out. Not logged.');
		assert.equal(await page.getAttribute('#scan-trade-out [data-row="t2"]', 'data-status'), 'none');

		await page.click('#scan-done-open');
		await page.waitForSelector('#move-form');
		assert.ok(await page.isChecked('#move-kind-sold'), 'cards only going out: Sold');
		await page.waitForSelector(`#move-out-list [data-entry="${ids[0]}"]`);
		assert.match(await page.textContent('#move-scanned'), /Pick Gift if you gave them away\./);
		assert.equal(await page.locator('#move-out-list [data-entry]').count(), 1, 'the card not owned is left out');
		assert.ok(await page.locator('#move-in-section').isHidden(), 'a sale has no cards in');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('leaving Trade or sale with cards asks first, the Add tray waits meanwhile, and Add scans and saves as before', async () => {
		const at = '2026-11-06T10:00:00.000Z';
		const card = {catalog: 'international', id: CARDS.c, image: null, lang: 'en', localId: '102', name: 'Waiting card', official: '189', setId: 'swsh3', setName: 'Darkness Ablaze'};
		const item = (id, extra = {}) => ({candidates: [], captured_at: at, card, condition: null, confirmed: true, finishBy: 'plain', id, language: 'en', languageBy: 'hand', names: [], read: null, status: 'ready', sure: true, timings: {}, variantId: null, variants: [], why: null, ...extra});
		const addTray = {created_at: at, id: 'add-1', items: [item('a1')], lastSave: null, sheetShown: false, updated_at: at};
		const tradeTray = {created_at: at, id: 'trade-1', items: [item('t1', {side: 'in'})], lastSave: null, mode: 'trade', sheetShown: false, side: 'out', updated_at: at};
		const {context, errors, page} = await open({drafts: [addTray, tradeTray]});

		// Add first: its tray, as before.
		await page.waitForSelector('#scan-tray [data-item="a1"].scan-tile');
		assert.equal(await page.textContent('#scan-done-open'), 'Done 1');

		await switchMode(page);
		await page.waitForSelector('#scan-trade-in [data-row="t1"]');
		assert.equal(await page.locator('#scan-tray [data-item="a1"]').count(), 0, 'the Add tray waits');

		// Back to Add with a card in the trade tray: asked.
		await switchMode(page);
		await page.waitForSelector('#scan-leave-sheet');
		assert.match(await page.textContent('#scan-leave-text'), /^The trade tray holds 1 card not logged yet\. Nothing in your cards has changed\./);
		await page.click('#scan-leave-keep');
		await page.waitForSelector('#scan-leave-sheet', {state: 'detached'});
		assert.equal(await modeOf(page), 'trade', 'Keep them stays in Trade or sale');
		assert.equal((await trays(page)).trade.length, 1);

		// Close asks too.
		await page.click('#scan-close');
		await page.waitForSelector('#scan-leave-sheet');
		await page.click('#scan-leave-keep');

		await switchMode(page);
		await page.waitForSelector('#scan-leave-sheet');
		await page.click('#scan-leave-go');
		await page.waitForSelector('#scan-tray [data-item="a1"].scan-tile');
		assert.equal(await modeOf(page), 'add');
		assert.equal(await page.evaluate(() => localStorage.getItem('card-tracker:scan-mode')), 'add');
		await untilInPage(page, 'the trade tray emptied', async () => {
			const session = await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession('trade');

			return Boolean(session && session.items.length === 0);
		});

		// Add scans and saves as before: a capture joins the Add tray with no
		// side, and Done saves both cards.
		await setScene(page, {cards: [{card: 'a', size: 0.95}]});
		await until(async () => (await captures(page)) === 1, 'the card taken', 15000);
		await readAll(page, 'add', 2);

		const list = (await trays(page)).add;

		assert.deepEqual(list.map((one) => one.side), [null, null]);

		await calm(page, '#scan-tray [data-item]');
		await settle(page, '#scan-tray .scan-tile.is-look');
		await calm(page, '#scan-tray [data-item]');

		await page.click('#scan-done-open');
		await page.waitForSelector('#scan-save-session:not([disabled])');
		await page.click('#scan-save-session');
		await page.waitForSelector('#scan-saved-line');

		const saved = await collectionState(page);

		assert.deepEqual(saved.cards.map((entry) => entry.card_id).sort(), [CARDS.a, CARDS.c]);
		assert.deepEqual(saved.moves, []);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('Close with cards in the trade tray asks, and Discard and close leaves with the tray empty and nothing changed', async () => {
		const at = '2026-11-06T10:00:00.000Z';
		const card = {catalog: 'international', id: CARDS.a, image: null, lang: 'en', localId: '1', name: 'Owned card', official: '132', setId: 'me01', setName: 'Test'};
		const tray = {created_at: at, id: 'trade-2', items: [{candidates: [], captured_at: at, card, condition: null, confirmed: true, finishBy: 'plain', id: 't1', language: 'en', languageBy: 'hand', names: [], read: null, side: 'out', status: 'ready', sure: true, timings: {}, variantId: null, variants: [], why: null}], lastSave: null, mode: 'trade', sheetShown: false, side: 'out', updated_at: at};
		const {context, errors, page} = await open({drafts: [tray], owned: [CARDS.a]});

		await switchMode(page);
		await page.waitForSelector('#scan-trade-out [data-row="t1"]');
		await page.click('#scan-close');
		await page.waitForSelector('#scan-leave-sheet');
		await page.click('#scan-leave-go');
		await page.waitForSelector('#scan', {state: 'detached'});
		await untilInPage(page, 'the trade tray emptied', async () => {
			const session = await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession('trade');

			return Boolean(session && session.items.length === 0);
		});
		assert.notEqual(new URL(page.url()).pathname, `${BASE}scan`);

		const kept = await collectionState(page);

		assert.equal(kept.cards.filter((entry) => !entry.deleted).length, 1, 'nothing in the collection changed');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('switching mode is refused while a card is being taken, and the card lands in the tray it was taken for', async () => {
		const {context, errors, page} = await open();

		await page.click('#scan-shutter');
		await switchMode(page);
		assert.equal(await modeOf(page), 'add', 'still Add');
		assert.match(await page.textContent('#scan-note'), /A card is still being taken or read\. Switch once it is in the tray\./);
		await until(async () => (await captures(page)) === 1, 'the shutter capture taken', 15000);
		await until(async () => (await trays(page)).add.length === 1, 'the capture in the Add tray', 15000);
		assert.deepEqual((await trays(page)).trade, [], 'nothing went to the trade tray');
		assert.equal((await trays(page)).add[0].side, null);
		assert.deepEqual(errors, []);
		await context.close();
	});

	// Review of 2026-11-06: the save took a whole side out of the tray, so a
	// card that joined it after Log cards (a holder capture still being taken)
	// was deleted though it was never in the form.
	test('saving the move takes out only the cards Log cards handed over; a card added to the tray after it stays', async () => {
		const at = '2026-11-06T10:00:00.000Z';
		const card = (id, name) => ({catalog: 'international', id, image: null, lang: 'en', localId: '1', name, official: '99', setId: id.split('-')[0], setName: 'Test'});
		const item = (id, cardId, name, side) => ({candidates: [], captured_at: at, card: card(cardId, name), condition: null, confirmed: true, finishBy: 'plain', id, language: 'en', languageBy: 'hand', names: [], read: null, side, status: 'ready', sure: true, timings: {}, variantId: null, variants: [], why: null});
		const tray = {created_at: at, id: 'trade-4', items: [item('t1', CARDS.a, 'Owned card', 'out')], lastSave: null, mode: 'trade', sheetShown: false, side: 'out', updated_at: at};
		const {context, errors, ids, page} = await open({drafts: [tray], owned: [CARDS.a]});

		await switchMode(page);
		await page.waitForSelector('#scan-trade-out [data-row="t1"][data-status="chosen"]');
		await page.click('#scan-done-open');
		await page.waitForSelector(`#move-out-list [data-entry="${ids[0]}"]`);

		// A card going out joins the trade tray after the form opened.
		await page.evaluate(async (late) => {
			const draft = await import('/pokemon-card-tracker/js/scan/draft.js');
			const session = await draft.loadSession('trade');

			await draft.saveSession({...session, items: [...session.items, late]});
		}, item('t2', CARDS.c, 'Late card', 'out'));
		await page.click('#move-save');
		await page.waitForSelector('.moves-row');
		await untilInPage(page, 'the card handed over left the tray, the late one stayed', async () => {
			const session = await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession('trade');

			return Boolean(session && session.items.length === 1 && session.items[0].id === 't2');
		});
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a kind that leaves a side out says so, saves the other side, and the side left out stays in the trade tray', async () => {
		const at = '2026-11-06T10:00:00.000Z';
		const card = (id, name) => ({catalog: 'international', id, image: null, lang: 'en', localId: '1', name, official: '99', setId: id.split('-')[0], setName: 'Test'});
		const item = (id, cardId, name, side) => ({candidates: [], captured_at: at, card: card(cardId, name), condition: null, confirmed: true, finishBy: 'plain', id, language: 'en', languageBy: 'hand', names: [], read: null, side, status: 'ready', sure: true, timings: {}, variantId: null, variants: [], why: null});
		const tray = {created_at: at, id: 'trade-3', items: [item('t1', CARDS.a, 'Owned card', 'out'), item('t2', CARDS.c, 'Card in', 'in')], lastSave: null, mode: 'trade', sheetShown: false, side: 'out', updated_at: at};
		const {context, errors, ids, page} = await open({drafts: [tray], owned: [CARDS.a]});

		await switchMode(page);
		await page.waitForSelector('#scan-trade-out [data-row="t1"][data-status="chosen"]');
		await page.click('#scan-done-open');
		await page.waitForSelector(`#move-out-list [data-entry="${ids[0]}"]`);
		assert.ok(await page.isChecked('#move-kind-traded'));
		assert.ok(await page.locator('#move-left-out').isHidden(), 'a trade leaves nothing out');

		await page.locator('label:has(#move-kind-sold)').click();
		assert.equal(await page.textContent('#move-left-out'), 'The 1 card coming in is not part of a sale; it stays in the scanner\'s trade tray.');
		await page.click('#move-save');
		await page.waitForSelector('.moves-row');

		const after = await collectionState(page);

		assert.deepEqual(after.moves.map((move) => [move.kind, move.out.length, move.in.length]), [['sold', 1, 0]]);
		assert.deepEqual(after.cards.filter((entry) => entry.came_via).length, 0, 'the card left out is not added');
		await untilInPage(page, 'only the side saved left the trade tray', async () => {
			const session = await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession('trade');

			return Boolean(session && session.items.length === 1 && session.items[0].id === 't2');
		});

		// Copies handed over that are no longer in his cards (the one just
		// sold, and one removed elsewhere) are left out, and the line counts
		// only the copies still there and says so.
		await page.evaluate(async ({live}) => {
			const {setPendingMove} = await import('/pokemon-card-tracker/js/moves.js');
			const {go} = await import('/pokemon-card-tracker/js/dom.js');

			setPendingMove({alternatives: ['gift'], from: 'scan', in: [], kind: 'sold', out: [live, 'no-longer-here']});
			go('trades/new');
		}, {live: ids[0]});
		await page.waitForSelector('#move-form');
		await page.waitForFunction(() => document.getElementById('move-scanned').textContent.length > 0);
		assert.equal(await page.locator('#move-out-list [data-entry]').count(), 0);
		assert.equal(await page.textContent('#move-scanned'), 'Scanned 2 going out. 2 copies you scanned going out are no longer in your cards, so they are left out. Pick Gift if you gave them away. Add who and the price, then Save.');
		assert.deepEqual(errors, []);
		await context.close();
	});

	// Design polish, 2026-11-06: at 780 x 360 the controls fell below the
	// screen and the trade tray cut Pick a copy. Held sideways the controls
	// are a column beside the camera, all on screen, in both modes.
	test('held sideways, the mode switch, the tray, Pick a copy, Close, the shutter, and Log or Done are all on screen beside the camera', async () => {
		const sideways = {height: 360, width: 780};
		const at = '2026-11-06T10:00:00.000Z';
		const card = (id, name) => ({catalog: 'international', id, image: null, lang: 'en', localId: '1', name, official: '99', setId: id.split('-')[0], setName: 'Test'});
		const item = (id, cardId, name, side) => ({candidates: [], captured_at: at, card: card(cardId, name), condition: null, confirmed: true, finishBy: 'plain', id, language: 'en', languageBy: 'hand', names: [], read: null, side, status: 'ready', sure: true, timings: {}, variantId: null, variants: [], why: null});
		const tray = {created_at: at, id: 'trade-side', items: [item('t1', CARDS.a, 'First card', 'out'), item('t2', CARDS.b, 'Second card', 'out'), item('t3', CARDS.c, 'Third card', 'in')], lastSave: null, mode: 'trade', sheetShown: false, side: 'out', updated_at: at};
		// Two copies of each card going out, one Played: each asks.
		const owned = [CARDS.a, CARDS.b].flatMap((id) => [id, {card: id, condition: 'Played'}]);
		const onScreen = async (page, selector) => {
			const box = await page.locator(selector).first().boundingBox();

			assert.ok(box, `${selector} is drawn`);
			assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= sideways.width + 0.5 && box.y + box.height <= sideways.height + 0.5, `${selector} is on screen: ${JSON.stringify(box)}`);

			return box;
		};

		const {context, errors, page} = await open({drafts: [tray], owned, viewport: sideways});

		await switchMode(page);
		await page.waitForSelector('#scan-trade-out [data-row="t2"][data-status="ask"]');

		const stage = await onScreen(page, '#scan-stage');

		for (const selector of ['#scan-mode', '#scan-side-out', '#scan-side-in', '#scan-close', '#scan-shutter', '#scan-done-open']) {
			const box = await onScreen(page, selector);

			assert.ok(box.x >= stage.x + stage.width, `${selector} is beside the camera`);
		}

		assert.equal(await page.textContent('#scan-done-open'), 'Log 3 cards');
		await onScreen(page, '#scan-trade-out .scan-trade-pick');
		await page.waitForTimeout(400);
		await page.screenshot({path: `${SHOTS}/scan-trade-sideways-780x360.png`});
		assert.deepEqual(errors, []);
		await context.close();

		// Add, with two cards in its tray.
		const addTray = {created_at: at, id: 'add-side', items: [item('a1', CARDS.a, 'First card', null), item('a2', CARDS.c, 'Third card', null)], lastSave: null, sheetShown: true, updated_at: at};
		const add = await open({drafts: [addTray], viewport: sideways});

		await add.page.waitForSelector('#scan-tray .scan-tray-item:nth-child(2)');
		assert.equal(await add.page.textContent('#scan-done-open'), 'Done 2');

		for (const selector of ['#scan-mode', '#scan-tray .scan-tray-item', '#scan-close', '#scan-shutter', '#scan-done-open']) {
			await onScreen(add.page, selector);
		}

		await add.page.waitForTimeout(400);
		await add.page.screenshot({path: `${SHOTS}/scan-add-sideways-780x360.png`});
		assert.deepEqual(add.errors, []);
		await add.context.close();
	});
});
