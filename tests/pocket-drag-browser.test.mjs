// Browser tests for moving a pocket to another one in a hand-made binder
// (js/pocket-drag.js, wired by js/binders-view.js): a long press then a drag
// to an empty pocket (moved) or a filled one (swapped), across the two pages
// of a spread, Undo, a quick swipe that still turns the page, and Move to
// pocket in the pocket sheet. Headless Chromium against tests/pages-server.mjs,
// signed out, on a wide touch screen where the pages take a tap directly.
//
// Every outside service is faked or blocked; Supabase must never be
// contacted. Binders and copies are invented.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/pocket-drag-browser.test.mjs
// Screenshots: /tmp/pocket-drag-*.png

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const WIDE = {height: 900, width: 1100};
const CARDS = ['tst9-001', 'tst9-002', 'tst9-003'].map((id, i) => ({category: 'Pokemon', id, localId: id.slice(-3), name: ['Inventamon', 'Fakeachu', 'Mockle'][i], set: {cardCount: {official: 90, total: 99}, id: 'tst9', name: 'Test set nine'}, variants_detailed: []}));

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

async function open() {
	const context = await browser.newContext({hasTouch: true, serviceWorkers: 'block', viewport: WIDE});
	const seen = {supabase: []};

	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await context.route(/ligapokemon\.com\.br/, (route) => route.abort('blockedbyclient'));
	await context.route('https://*.supabase.co/**', (route) => {
		seen.supabase.push(route.request().url());

		return route.abort('blockedbyclient');
	});
	await context.route('https://api.frankfurter.dev/**', (route) => route.fulfill({body: '[]', contentType: 'application/json', headers: {'Access-Control-Allow-Origin': '*'}}));
	await context.route('https://api.tcgdex.net/**', (route) => {
		const record = CARDS.find((card) => route.request().url().endsWith(`/cards/${card.id}`));

		return route.fulfill(record
			? {body: JSON.stringify(record), contentType: 'application/json', status: 200}
			: {body: '{}', contentType: 'application/json', status: 404});
	});
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));
	await fakePokeApi(context);

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err));

	const done = async () => {
		assert.deepEqual(errors.map(String), []);
		assert.deepEqual(await page.locator('#errors .error').allTextContents(), []);
		assert.deepEqual(seen.supabase, [], 'Supabase is never contacted');
		await context.close();
	};

	await page.goto(url('cards'));
	await page.waitForSelector('#cards-empty');

	return {done, page};
}

// A 3 x 3 binder of 4 pages: two cards on page 1, a placeholder on page 2,
// so the first spread past the cover shows pages 2 and 3.
const seed = (page) => page.evaluate(async (ids) => {
	const collection = await import('/pokemon-card-tracker/js/collection.js');
	const binders = await import('/pokemon-card-tracker/js/binders.js');
	const copies = [];

	for (const id of ids) {
		copies.push((await collection.addCard({card_id: id, catalog: 'international', language: 'en', language_source: 'manual'})).id);
	}

	const binder = await binders.createBinder({cols: 3, cover_color: '#1d2e60', name: 'Invented binder', page_count: 4, rows: 3});

	await binders.placeCard(binder.id, 2, 1, copies[0]);
	await binders.placeCard(binder.id, 2, 2, copies[1]);
	await binders.placePlaceholder(binder.id, 3, 5, {card_id: ids[2], catalog: 'international', name: 'Mockle'});

	return {binder: binder.id, copies};
}, CARDS.map((card) => card.id));

const pocketSel = (pg, position) => `#binder-spread button.pocket[data-page="${pg}"][data-position="${position}"]`;

const kindOf = (page, pg, position) => page.locator(pocketSel(pg, position)).first().getAttribute('data-kind');

const waitKind = (page, pg, position, kind) => page.waitForFunction(([selector, want]) => {
	const node = document.querySelector(selector);

	return node && node.dataset.kind === want;
}, [pocketSel(pg, position), kind]);

const where = (page, entryId) => page.evaluate(async (id) => (await import('/pokemon-card-tracker/js/binders.js')).binderLocation(id), entryId);

const undoOn = (page, text) => page.locator('#toasts .toast', {hasText: text}).locator('button', {hasText: 'Undo'});

async function centerOf(page, pg, position) {
	const box = await page.locator(pocketSel(pg, position)).first().boundingBox();

	return {x: box.x + (box.width / 2), y: box.y + (box.height / 2)};
}

// A real touch through the DevTools protocol, so the browser makes the
// pointer events itself: press, hold for holdMs, then move to the end point.
async function touchDrag(page, from, to, {holdMs = 600, steps = 10} = {}) {
	const cdp = await page.context().newCDPSession(page);

	await cdp.send('Input.dispatchTouchEvent', {touchPoints: [{x: from.x, y: from.y}], type: 'touchStart'});
	await page.waitForTimeout(holdMs);

	for (let i = 1; i <= steps; i++) {
		await cdp.send('Input.dispatchTouchEvent', {touchPoints: [{x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps}], type: 'touchMove'});
	}

	await cdp.send('Input.dispatchTouchEvent', {touchPoints: [], type: 'touchEnd'});
	await cdp.detach();
}

async function openBinder(page, binderId) {
	await page.goto(url(`binders/${binderId}?spread=2`));
	await page.waitForSelector(pocketSel(2, 1));
	await waitKind(page, 2, 1, 'card');
}

describe('moving pockets in a hand-made binder', () => {
	test('long press then drag: moved, swapped across the spread, Undo, and a swipe still turns the page', async () => {
		const {done, page} = await open();
		const {binder, copies} = await seed(page);

		await openBinder(page, binder);

		// To an empty pocket on the same page: moved.
		await touchDrag(page, await centerOf(page, 2, 1), await centerOf(page, 2, 9));
		await waitKind(page, 2, 9, 'card');
		assert.equal(await kindOf(page, 2, 1), 'open');
		assert.equal((await where(page, copies[0])).position, 9);
		assert.equal(await page.locator('.bt-ghost').count(), 0, 'the ghost is gone');
		await page.screenshot({path: '/tmp/pocket-drag-moved.png'});

		// Undo puts it back.
		await undoOn(page, 'Moved the card to page 2, pocket 9.').click();
		await waitKind(page, 2, 1, 'card');
		assert.equal(await kindOf(page, 2, 9), 'open');
		assert.equal((await where(page, copies[0])).position, 1);

		// Onto the placeholder on the other page of the spread: swapped.
		await touchDrag(page, await centerOf(page, 2, 2), await centerOf(page, 3, 5));
		await waitKind(page, 2, 2, 'want');
		assert.equal(await kindOf(page, 3, 5), 'card');
		const moved = await where(page, copies[1]);

		assert.equal(moved.page, 3);
		assert.equal(moved.position, 5);

		// Undo swaps both back.
		await undoOn(page, 'Swapped page 2, pocket 2 with page 3, pocket 5.').click();
		await waitKind(page, 2, 2, 'card');
		assert.equal(await kindOf(page, 3, 5), 'want');

		// A long press that lifts outside every pocket changes nothing.
		await touchDrag(page, await centerOf(page, 2, 1), {x: 5, y: 5});
		await page.waitForTimeout(300);
		assert.equal(await kindOf(page, 2, 1), 'card');
		assert.equal(await page.locator('#pocket-sheet[open]').count(), 0, 'the lift is not a tap');

		// A placeholder moves like a card.
		await touchDrag(page, await centerOf(page, 3, 5), await centerOf(page, 3, 1));
		await waitKind(page, 3, 1, 'want');
		assert.equal(await kindOf(page, 3, 5), 'open');

		// A quick swipe from a filled pocket turns the page and lifts nothing.
		const start = await centerOf(page, 2, 2);

		await touchDrag(page, start, {x: start.x - 300, y: start.y + 4}, {holdMs: 0, steps: 8});
		await page.waitForFunction(() => document.getElementById('binder-spread').dataset.spread === '3');
		assert.equal(await page.locator('.bt-ghost').count(), 0);
		assert.equal((await where(page, copies[1])).position, 2, 'nothing moved');
		await done();
	});

	test('Move to pocket in the sheet: a chosen pocket, and the next free one', async () => {
		const {done, page} = await open();
		const {binder, copies} = await seed(page);

		await openBinder(page, binder);
		await page.click(pocketSel(2, 1));
		await page.waitForSelector('#pocket-sheet[open]');
		await page.click('#pocket-move');
		assert.ok(await page.locator('#move-panel').isVisible());
		assert.equal(await page.evaluate(() => document.activeElement.id), 'move-page');

		// Page 3, pocket 5 holds the placeholder: they swap.
		await page.selectOption('#move-page', '3');
		await page.selectOption('#move-pocket', '5');
		assert.equal(await page.locator('#move-go').textContent(), 'Swap with this pocket');
		assert.match(await page.locator('#move-holds').textContent(), /Mockle/);
		await page.screenshot({path: '/tmp/pocket-drag-sheet.png'});
		await page.click('#move-go');
		await page.waitForSelector('#pocket-sheet[open]', {state: 'detached'});
		await waitKind(page, 2, 1, 'want');
		assert.equal((await where(page, copies[0])).page, 3);
		await undoOn(page, 'Swapped page 2, pocket 1 with page 3, pocket 5.').click();
		await waitKind(page, 2, 1, 'card');

		// The next free pocket, in reading order: page 1, pocket 1.
		await page.click(pocketSel(2, 2));
		await page.waitForSelector('#pocket-sheet[open]');
		await page.click('#pocket-move');
		assert.equal(await page.locator('#move-next-free').textContent(), 'Move to the next free pocket (page 1, pocket 1)');
		await page.click('#move-next-free');
		await page.waitForSelector('#pocket-sheet[open]', {state: 'detached'});
		await waitKind(page, 2, 2, 'open');
		const now = await where(page, copies[1]);

		assert.equal(now.page, 1);
		assert.equal(now.position, 1);
		await done();
	});
});
