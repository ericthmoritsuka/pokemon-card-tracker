// Browser tests for a card out of its pocket (js/pocket-viewer.js; Eric,
// 2026-11-06): a tap on a filled pocket opens the card large with
// Edit pocket, To the tray, Move, and Card page; it zooms; Escape, Back, a tap
// outside, and a swipe down put it back; a tap that places a tray card
// never opens it, and empty pockets and placeholders still open the sheet.
// Headless Chromium against tests/pages-server.mjs, signed out. TCGdex is
// faked (GraphQL answers the Pokédex numbers of the invented cards, the
// rest 404), PokeAPI by tests/fake-pokeapi.mjs; Supabase and
// ligapokemon.com.br are never contacted. Cards and binders are invented.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/binder-view-browser.test.mjs
// Screenshots: $SHOTS, else /tmp/binder-view

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
const SHOTS = process.env.SHOTS || '/tmp/binder-view';
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

async function open(viewport, {reducedMotion = 'no-preference'} = {}) {
	const context = await browser.newContext({reducedMotion, serviceWorkers: 'block', viewport});
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

const viewerState = (page) => page.evaluate(() => {
	const node = document.getElementById('pocket-viewer');

	return node ? node.dataset.state : null;
});

const waitOpen = (page) => page.waitForFunction(() => {
	const node = document.getElementById('pocket-viewer');

	return Boolean(node) && node.dataset.state === 'open';
});

const waitGone = (page) => page.waitForFunction(() => !document.getElementById('pocket-viewer'));

// ----------------------------------------------------- the pocket viewer

// Album, 3 x 3, 2 pages: page 1 holds c1 in pocket 1 and c2 in pocket 2, a
// placeholder in pocket 4, and pocket 3 is empty; c3 waits in the tray.
const ALBUM = hand('album', 'Album', [
	{entry_id: 'c1', page: 1, placed_at: AT, position: 1},
	{entry_id: 'c2', page: 1, placed_at: AT, position: 2},
	{page: 1, placed_at: AT, position: 4, want: {card_id: 'tst1-007', catalog: 'international', image: null, name: 'Test Splash', variant_id: null}},
], {staged: ['c3']});

const ALBUM_DOC = documentWith({
	binders: [ALBUM],
	cards: [card('c1', 'tst1-001'), card('c2', 'tst1-004', {language: 'pt'}), card('c3', 'tst3-152')],
});

const zoomed = (n) => `#bs-zoom-sheet .pocket[data-position="${n}"]`;

async function openPage(page, pg) {
	await page.click(`.bs-open[data-open="${pg}"]`);
	await page.waitForFunction((wanted) => {
		const root = document.getElementById('binder-spread');

		return Boolean(root) && root.dataset.zoom === wanted;
	}, String(pg));
}

describe('a card out of its pocket', () => {
	test('a tap on a card opens it large with the pocket\'s actions; Escape puts it back and focus returns', async () => {
		const {done, page} = await open(PHONE);

		await seed(page, ALBUM_DOC);
		await page.goto(url('binders/album'));
		await page.waitForSelector('#binder-spread .bs-page');
		await openPage(page, 1);
		await page.click(zoomed(1));
		await waitOpen(page);

		assert.equal(await page.locator('#pv-name').textContent(), 'Test Sprout');
		assert.equal(await page.locator('#pv-meta').textContent(), 'English · Page 1, pocket 1');
		assert.deepEqual(await page.locator('#pv-actions > *').evaluateAll((nodes) => nodes.map((node) => [node.id, node.textContent])), [
			['pv-details', 'Edit pocket'],
			['pv-to-tray', 'To the tray'],
			['pv-move', 'Move to…'],
			['pv-remove', 'Remove from this binder'],
			['pv-card-page', 'Card page'],
		]);
		assert.equal(await page.getAttribute('#pv-card-page', 'href'), `${BASE}cards/en/tst1-001`);
		assert.equal(await page.getAttribute('#pocket-viewer', 'role'), 'dialog');
		assert.equal(await page.getAttribute('#pocket-viewer', 'aria-modal'), 'true');
		assert.equal(await page.evaluate(() => document.activeElement.id), 'pv-details', 'focus moves into the dialog');
		assert.equal(await page.locator(`${zoomed(1)}.pv-out`).count(), 1, 'the pocket shows empty while its card is out');

		// Large: most of the phone's width.
		const box = await page.locator('#pv-lift').boundingBox();

		assert.ok(box.width >= 300, `the card is ${box.width} px wide`);
		await page.screenshot({path: `${SHOTS}/viewer-360.png`});

		// Tab stays inside.
		for (let i = 0; i < 5; i++) {
			await page.keyboard.press('Tab');
		}

		assert.ok(await page.evaluate(() => document.getElementById('pocket-viewer').contains(document.activeElement)), 'Tab stays in the viewer');

		await page.keyboard.press('Escape');
		await waitGone(page);
		assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.dataset.position), '1', 'focus goes back to the pocket');
		assert.equal(await page.locator(`${zoomed(1)}.pv-out`).count(), 0);
		await done();
	});

	test('it zooms with a double tap, and a swipe down, a tap outside, Back, and Close put it back', async () => {
		const {done, page} = await open(PHONE);

		await seed(page, ALBUM_DOC);
		await page.goto(url('binders/album'));
		await page.waitForSelector('#binder-spread .bs-page');
		await openPage(page, 1);

		// Double tap zooms in.
		await page.click(zoomed(1));
		await waitOpen(page);
		await page.waitForSelector('#pv-lift .ph-pane[data-ready="true"]');

		const pane = await page.locator('#pv-lift .ph-pane').boundingBox();
		const middle = {x: pane.x + (pane.width / 2), y: pane.y + (pane.height / 2)};

		await page.mouse.click(middle.x, middle.y);
		await page.mouse.click(middle.x, middle.y);
		await page.waitForFunction(() => Number(document.querySelector('#pv-lift .ph-pane').dataset.s) > 1.5);

		// Zoomed in, a drag pans the card rather than closing it.
		await page.mouse.move(middle.x, middle.y);
		await page.mouse.down();
		await page.mouse.move(middle.x, middle.y + 160, {steps: 8});
		await page.mouse.up();
		assert.ok(await viewerState(page), 'still open after a drag on a zoomed card');
		await page.keyboard.press('0');
		await page.waitForFunction(() => Number(document.querySelector('#pv-lift .ph-pane').dataset.s) < 1.01);

		// At zoom 1, a swipe down puts it back.
		await page.mouse.move(middle.x, middle.y);
		await page.mouse.down();
		await page.mouse.move(middle.x, middle.y + 200, {steps: 10});
		await page.mouse.up();
		await waitGone(page);

		// A tap outside the card.
		await page.click(zoomed(2));
		await waitOpen(page);
		assert.equal(await page.locator('#pv-meta').textContent(), 'Portuguese · Page 1, pocket 2');
		await page.mouse.click(6, 120);
		await waitGone(page);

		// Back closes it and stays on the binder.
		const address = page.url();

		await page.click(zoomed(1));
		await waitOpen(page);
		await page.goBack();
		await waitGone(page);
		assert.equal(page.url(), address);
		assert.equal(await page.locator('#binder-title').textContent(), 'Album');

		// Close.
		await page.click(zoomed(1));
		await waitOpen(page);
		await page.click('#pv-close');
		await waitGone(page);
		await done();
	});

	test('Edit pocket opens the pocket sheet, Move opens it on Move to pocket, To the tray takes the card out, Card page opens the card', async () => {
		const {done, page} = await open(PHONE);

		await seed(page, ALBUM_DOC);
		await page.goto(url('binders/album'));
		await page.waitForSelector('#binder-spread .bs-page');
		await openPage(page, 1);

		await page.click(zoomed(1));
		await waitOpen(page);
		await page.click('#pv-details');
		await page.waitForSelector('#pocket-sheet[open] #sheet-current-label');
		assert.equal(await page.locator('#sheet-current-label').textContent(), 'Test Sprout, English');
		await waitGone(page);
		await page.click('#sheet-close');
		await page.waitForFunction(() => !document.querySelector('#pocket-sheet[open]'));
		await page.waitForTimeout(300);

		await page.click(zoomed(1));
		await waitOpen(page);
		await page.click('#pv-move');
		await page.waitForSelector('#pocket-sheet[open] #move-panel:not([hidden])');
		assert.equal(await page.evaluate(() => document.activeElement.id), 'move-page');
		await page.click('#sheet-close');
		await page.waitForFunction(() => !document.querySelector('#pocket-sheet[open]'));
		await page.waitForTimeout(300);

		await page.click(zoomed(2));
		await waitOpen(page);
		await page.click('#pv-to-tray');
		await page.waitForFunction(() => document.querySelector('#bs-zoom-sheet .pocket[data-position="2"]')?.dataset.kind === 'open');

		let doc = await localDoc(page);

		assert.deepEqual(doc.binders[0].staged, ['c3', 'c2'], 'the card waits in the tray');

		await page.click(zoomed(1));
		await waitOpen(page);
		await page.click('#pv-card-page');
		await page.waitForURL(/cards\/en\/tst1-001/);
		await waitGone(page);
		doc = await localDoc(page);
		assert.equal(doc.binders[0].slots.find((slot) => slot.position === 1).entry_id, 'c1');
		await done();
	});

	test('To the tray moves only the card shown: when a sync changed the pocket meanwhile, nothing moves', async () => {
		const {done, page} = await open(PHONE);

		await seed(page, ALBUM_DOC);
		await page.goto(url('binders/album'));
		await page.waitForSelector('#binder-spread .bs-page');
		await openPage(page, 1);
		await page.click(zoomed(2));
		await waitOpen(page);

		// Another phone put c3 in pocket 2 while c2 was out.
		await page.evaluate(async () => (await import('/pokemon-card-tracker/js/binders.js')).placeCard('album', 1, 2, 'c3'));
		await page.click('#pv-to-tray');
		await page.locator('#toasts .toast', {hasText: 'That pocket holds another card now, so nothing moved.'}).waitFor();

		const doc = await localDoc(page);

		assert.equal(doc.binders[0].slots.find((slot) => slot.page === 1 && slot.position === 2 && !slot.cleared).entry_id, 'c3');
		assert.deepEqual(doc.binders[0].staged || [], [], 'c3 left the tray for the pocket, and nothing went back to it');
		await done();
	});

	test('placing from the tray still places, and empty pockets and placeholders still open the sheet', async () => {
		const {done, page} = await open(PHONE);

		await seed(page, ALBUM_DOC);
		await page.goto(url('binders/album'));
		await page.waitForSelector('#binder-spread .bs-page');
		await openPage(page, 1);

		// The placeholder.
		await page.click(zoomed(4));
		await page.waitForSelector('#pocket-sheet[open]');
		assert.equal(await page.locator('#pocket-viewer').count(), 0);
		await page.click('#sheet-close');
		await page.waitForFunction(() => !document.querySelector('#pocket-sheet[open]'));
		await page.waitForTimeout(300);

		// The empty pocket.
		await page.click(zoomed(3));
		await page.waitForSelector('#pocket-sheet[open] #owned-search');
		assert.equal(await page.locator('#pocket-viewer').count(), 0);
		await page.click('#sheet-close');
		await page.waitForFunction(() => !document.querySelector('#pocket-sheet[open]'));
		await page.waitForTimeout(300);

		// A tray card picked, then a filled pocket: they swap.
		await page.click('#bt-strip .bt-card[data-entry="c3"]');
		await page.waitForSelector('#bt-strip .bt-card[data-entry="c3"][aria-pressed="true"]');
		await page.click(zoomed(1));
		await untilInPage(page, 'c3 in pocket 1', async () => {
			const doc = await (await import('/pokemon-card-tracker/js/collection.js')).loadDocument();
			const slot = doc.binders[0].slots.find((item) => item.page === 1 && item.position === 1 && !item.cleared);

			return Boolean(slot) && slot.entry_id === 'c3';
		});
		assert.equal(await viewerState(page), null, 'placing never opens the card');
		await done();
	});

	test('with reduced motion it opens and closes without moving', async () => {
		const {done, page} = await open(PHONE, {reducedMotion: 'reduce'});

		await seed(page, ALBUM_DOC);
		await page.goto(url('binders/album'));
		await page.waitForSelector('#binder-spread .bs-page');
		await openPage(page, 1);
		await page.click(zoomed(1));
		assert.equal(await page.evaluate(() => document.getAnimations().filter((animation) => animation.effect && animation.effect.target && animation.effect.target.closest && animation.effect.target.closest('#pocket-viewer')).length), 0);
		await waitOpen(page);
		await page.keyboard.press('Escape');
		assert.equal(await page.locator('#pocket-viewer').count(), 0, 'gone at once');
		await done();
	});

	test('sideways, the card and its actions sit side by side', async () => {
		const {done, page} = await open({height: 360, width: 740});

		await seed(page, ALBUM_DOC);
		await page.goto(url('binders/album'));
		await page.waitForSelector('#binder-spread .bs-page');
		await page.click('#binder-spread .pocket[data-page="1"][data-position="1"]');
		await waitOpen(page);

		const card = await page.locator('#pv-lift').boundingBox();
		const actions = await page.locator('#pv-actions').boundingBox();

		assert.ok(card.y >= 0 && card.y + card.height <= 360, 'the card fits the height');
		assert.ok(actions.x >= card.x + card.width, 'the actions are beside the card');
		// Dark enough that the binder beside the card does not read through.
		assert.ok(await page.$eval('.pv-shade', (node) => Number(getComputedStyle(node).backgroundColor.match(/[\d.]+(?=\)$)/)[0]) >= 0.9));
		await page.screenshot({path: `${SHOTS}/viewer-sideways.png`});
		await page.keyboard.press('Escape');
		await waitGone(page);
		await done();
	});
});
