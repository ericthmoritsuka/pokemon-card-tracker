// Browser test for the scanner's controls, the For row at the head of its
// tray and Close, Photo, and Page in the shutter's row, and its Buy mode
// (js/scan/modes.js, js/scan/view.js logPurchase; Eric, 2026-11-19; design
// review, 2026-11-19; DESIGN.md section 11, "How and For" and "Scan a
// purchase"),
// in headless Chromium against tests/scan-harness.mjs (Supabase is never
// reached; TCGdex answers are replayed from the harness cache), with the
// canvas camera of tests/scan-scene.mjs showing an empty table:
//
// - the controls: For (Add pressed by default, a group with a label) and
//   Close, Photo, and Page beside the shutter, each an icon and a word, 44
//   px tall, on one line each at 360 and 412 px with no sideways scroll, and
//   the camera as tall as it was before them; pressing Buy presses it,
//   makes Done "Log 2 ›", renames the running count, and is remembered on
//   the phone; Page opens the binder page choice;
// - in Buy, Log hands the tray to the trades log's form as a
//   purchase (Bought, today, every tray card coming in with its copies),
//   nothing is added before the form's Save, and the save adds the copies
//   and takes the cards handed over out of the tray, keeping one scanned
//   after;
// - in Buy, a card that needs a look opens Review instead of the form;
// - in Add, the Done sheet's Log as a purchase does the same with the tray
//   as it stands, and leaving the form without saving keeps the tray.
//
// Invented trays only, of the harness's three test cards.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/scan-buy-browser.test.mjs
// Screenshots: $SHOTS (default /tmp)/scan-rows-*.png, scan-buy-*.png

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakeRates} from './fake-rates.mjs';
import {untilInPage} from './poll.mjs';
import {routeTcgdex, startScanHarness} from './scan-harness.mjs';
import {sceneCamera} from './scan-scene.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const CARDS = {a: 'me01-001', b: 'sv03.5-025', c: 'swsh3-102'};
const FRAME = {height: 3840, width: 2160};
const SHOTS = process.env.SHOTS || '/tmp';
const AT = '2026-11-19T10:00:00.000Z';

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

const card = (id, name) => ({catalog: 'international', id, image: null, lang: 'en', localId: '1', name, official: '99', setId: id.split('-')[0], setName: 'Test'});

// A tray card read and settled, or with `extra` changed.
const item = (id, cardId, name, extra = {}) => ({candidates: [], captured_at: AT, card: card(cardId, name), condition: null, confirmed: true, finishBy: 'plain', id, language: 'en', languageBy: 'hand', names: [], read: null, status: 'ready', sure: true, timings: {}, variantId: null, variants: [], why: null, ...extra});

const addTray = (items) => ({created_at: AT, id: 'add-buy', items, lastSave: null, sheetShown: true, updated_at: AT});

// A phone hand-held, English the last language, the Add tray `tray` written
// before Scan opens, and `mode` the mode kept on the phone (none: never
// chosen).
async function open({mode = null, tray = null, viewport = {height: 740, width: 360}} = {}) {
	const context = await browser.newContext({deviceScaleFactor: 2, viewport});

	await fakeRates(context);
	await context.grantPermissions(['camera'], {origin: harness.origin});
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await routeTcgdex(context);
	await context.addInitScript(() => {
		if (sessionStorage.getItem('test-scene') === null) {
			sessionStorage.setItem('test-scene', JSON.stringify({kind: 'table'}));
		}
	});
	await context.addInitScript(sceneCamera, FRAME);
	await context.addInitScript((kept) => {
		localStorage.setItem('card-tracker:scan-holder', 'off');
		localStorage.setItem('card-tracker:scan-language', 'en');
		localStorage.setItem('card-tracker:scan-language-last', 'en');

		// Only before the first load: the test then sees what the app keeps.
		if (kept && !sessionStorage.getItem('test-mode-set')) {
			sessionStorage.setItem('test-mode-set', '1');
			localStorage.setItem('card-tracker:scan-mode', kept);
		}
	}, mode);

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(String(err)));
	await page.goto(`${harness.origin}${BASE}cards`);

	if (tray) {
		await page.evaluate(async (session) => {
			await (await import('/pokemon-card-tracker/js/scan/draft.js')).saveSession(session);
		}, tray);
	}

	await page.goto(`${harness.origin}${BASE}scan`);
	await scanReady(page);

	return {context, errors, page};
}

async function scanReady(page) {
	await page.waitForSelector('#scan-guide:not([hidden])', {timeout: 30000});
	await page.waitForFunction(() => document.getElementById('scan-video').videoWidth > 0);
}

const text = (page, selector) => page.locator(selector).textContent();
const pressed = (page, selector) => page.getAttribute(selector, 'aria-pressed');

const addTrayNow = (page) => page.evaluate(async () => {
	const session = await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession('add');

	return session ? session.items.map((one) => one.id) : null;
});

const liveCards = (page) => page.evaluate(async () => {
	const {loadDocument} = await import('/pokemon-card-tracker/js/collection.js');
	const doc = await loadDocument();

	return {
		cards: doc.cards.filter((entry) => !entry.deleted_at).map((entry) => ({came_via: entry.came_via || null, card_id: entry.card_id, language: entry.language, language_source: entry.language_source})),
		moves: (doc.moves || []).filter((move) => !move.deleted_at).map((move) => ({in: move.in.length, kind: move.kind, out: move.out.length, who: move.who})),
	};
});

const today = (page) => page.evaluate(() => {
	const now = new Date();

	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
});

describe('the controls, and For', () => {
	for (const viewport of [{height: 740, width: 360}, {height: 915, width: 412}]) {
		test(`at ${viewport.width} px: For, and Close, Photo, Page by the shutter, the camera at full height, Buy remembered, and Page opens the binder page choice`, async () => {
			const {context, errors, page} = await open({tray: addTray([item('a1', CARDS.a, 'First card'), item('a2', CARDS.b, 'Second card')]), viewport});

			await page.waitForSelector('#scan-tray .scan-tray-item:nth-child(2)');

			// The For row's group and names, and Close, Photo, and Page in the
			// shutter's row; no How row (design review, 2026-11-19).
			assert.equal(await page.locator('#scan-how').count(), 0);
			assert.equal(await page.getAttribute('#scan-mode', 'role'), 'group');
			assert.equal(await page.getAttribute('#scan-mode', 'aria-label'), 'What the cards are for');
			assert.deepEqual(await page.$$eval('#scan-mode button, .scan-controls .scan-icon-control', (buttons) => buttons.map((button) => [button.id, button.textContent, button.getAttribute('aria-label')])), [
				['scan-mode-add', 'Add', null],
				['scan-mode-buy', 'Buy', null],
				['scan-mode-trade', 'Trade or sale', null],
				['scan-close', 'Close', null],
				['scan-photo-open', 'Photo', 'Photo: pick a photo of one card'],
				['scan-page-open', 'Page', 'Page: a whole binder page from a photo'],
			]);
			// Each an icon, hidden from a screen reader, and its word.
			assert.equal(await page.locator('#scan-mode button > svg[aria-hidden="true"], .scan-controls .scan-icon-control > svg[aria-hidden="true"]').count(), 6);

			// Photo and Page open a picker and are never pressed. Add is the
			// default mode.
			assert.equal(await pressed(page, '#scan-photo-open'), null);
			assert.equal(await pressed(page, '#scan-page-open'), null);
			assert.deepEqual(await page.$$eval('#scan-mode button', (buttons) => buttons.map((button) => button.getAttribute('aria-pressed'))), ['true', 'false', 'false']);
			assert.equal(await text(page, '#scan-done-open'), 'Done 2');

			await page.screenshot({path: `${SHOTS}/scan-rows-add-${viewport.width}x${viewport.height}.png`});

			// 44 px tall, inside the gutter, each row on one line, no sideways
			// scroll.
			const boxes = await page.$$eval('#scan-mode button, .scan-controls > button:not([hidden]), #scan-tray-menu', (buttons) => buttons.map((button) => {
				const box = button.getBoundingClientRect();

				return {height: box.height, id: button.id, middle: box.top + (box.height / 2), right: box.right, width: box.width};
			}));

			for (const box of boxes) {
				assert.ok(box.height >= 44, `${box.id} is at least 44 px tall: ${box.height}`);
				assert.ok(box.right <= viewport.width - 16 + 0.5, `${box.id} is inside the gutter: ${box.right}`);
			}

			const oneLine = (ids) => {
				const middles = boxes.filter((box) => ids.includes(box.id)).map((box) => box.middle);

				return Math.max(...middles) - Math.min(...middles) < 4;
			};

			assert.ok(oneLine(['scan-mode-add', 'scan-mode-buy', 'scan-mode-trade', 'scan-tray-menu']), 'For and the tray menu on one line');

			// The tray's menu and each tile's Remove are 44 px each way. A
			// Remove reaches past its tile into the gap, covering no more of
			// its tile than the 28 px it did at 32 px wide, and none of the
			// next one (accessibility audit, 2026-11-20).
			assert.ok(boxes.find((box) => box.id === 'scan-tray-menu').width >= 44, 'the tray menu is 44 px wide');

			const removes = await page.$$eval('#scan-tray .scan-tray-item', (items) => items.map((item) => {
				const remove = item.querySelector('.scan-tile-remove').getBoundingClientRect();
				const tile = item.querySelector('.scan-tile').getBoundingClientRect();
				const next = item.nextElementSibling && item.nextElementSibling.querySelector('.scan-tile');

				return {intoNext: next ? Math.max(0, remove.right - next.getBoundingClientRect().left) : 0, overTile: Math.round(Math.min(remove.right, tile.right) - Math.max(remove.left, tile.left)), tall: remove.height, wide: remove.width};
			}));

			assert.equal(removes.length, 2);

			for (const remove of removes) {
				assert.deepEqual(remove, {intoNext: 0, overTile: 28, tall: 44, wide: 44}, 'Remove is 44 px, over 28 px of its tile');
			}
			assert.ok(oneLine(['scan-close', 'scan-photo-open', 'scan-page-open', 'scan-shutter', 'scan-done-open']), 'the shutter\'s row on one line');
			assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), viewport.width, 'no sideways scroll');
			assert.equal(await page.$eval('#scan-mode-trade', (button) => button.scrollWidth <= button.clientWidth), true, 'Trade or sale whole');

			// The camera as tall as before the controls (476 px at 360 x 740
			// and 651 at 412 x 915 on v84): a second row of icons cost it 44.
			const stage = await page.locator('#scan-stage').boundingBox();

			assert.ok(stage.height >= (viewport.width === 360 ? 470 : 645), `the camera keeps its height: ${stage.height}`);
			assert.ok((await page.locator('#scan-mode').boundingBox()).y >= stage.y + stage.height - 0.5, 'For is under the camera');

			// The settings gear over the camera's foot, on the left, its name
			// saying what it holds.
			const gear = await page.locator('#scan-settings-open').boundingBox();

			assert.match(await page.getAttribute('#scan-settings-open', 'aria-label'), /^Scanner settings: default finish /);
			assert.ok(gear.width >= 44 && gear.height >= 44, 'the gear is 44 px');
			assert.ok(gear.x < stage.x + 24 && gear.y + gear.height > stage.y + stage.height - 60, 'the gear is at the camera\'s foot on the left');
			// Buy: pressed, Done and the running count say so, and the tray is
			// the same.
			await page.click('#scan-mode-buy');
			assert.deepEqual(await page.$$eval('#scan-mode button', (buttons) => buttons.map((button) => button.getAttribute('aria-pressed'))), ['false', 'true', 'false']);
			assert.equal(await page.getAttribute('#scan-mode', 'data-mode'), 'buy');
			assert.equal(await text(page, '#scan-done-open'), 'Log 2 ›');
			assert.equal(await page.getAttribute('#scan-done-open', 'aria-label'), 'Log 2 cards as a purchase');
			assert.ok(await page.locator('#scan-done-open.is-log').count(), 'filled, the main action');
			assert.match(await text(page, '#scan-run-count'), /^Buy · 2 cards/);
			// Said to a screen reader a moment after (view.js announce).
			await untilInPage(page, 'Buy announced', () => /^Buy\. Log opens Trades and sales/.test(document.getElementById('scan-live').textContent));
			assert.equal(await page.locator('#scan-tray .scan-tray-item').count(), 2, 'Buy scans into the Add tray');
			assert.equal(await page.evaluate(() => localStorage.getItem('card-tracker:scan-mode')), 'buy', 'the mode is kept on the phone');
			await page.screenshot({path: `${SHOTS}/scan-rows-buy-${viewport.width}x${viewport.height}.png`});

			// Trade or sale: teal, its own tray.
			await page.click('#scan-mode-trade');
			assert.equal(await pressed(page, '#scan-mode-trade'), 'true');
			assert.ok(await page.locator('#scan.is-trade').count());
			await page.waitForSelector('#scan-side-out');
			await page.screenshot({path: `${SHOTS}/scan-rows-trade-${viewport.width}x${viewport.height}.png`});

			// Back to Buy, and Scan opens in Buy next time.
			await page.click('#scan-mode-buy');
			await page.reload();
			await scanReady(page);
			assert.equal(await pressed(page, '#scan-mode-buy'), 'true', 'Buy remembered');
			assert.equal(await text(page, '#scan-done-open'), 'Log 2 ›');

			// Page: the binder page choice, its tip, and the camera or the
			// gallery.
			await page.click('#scan-page-open');
			await page.waitForSelector('#scan-page');
			assert.equal(await text(page, '#scan-page-label'), 'Binder page');
			assert.match(await text(page, '#scan-page-help'), /^Add a whole page of cards from one photo/);
			assert.deepEqual(await page.$$eval('#scan-page button[id^="scan-page-"]', (buttons) => buttons.map((button) => button.textContent)), ['Take a photo', 'Choose a photo']);
			await page.waitForTimeout(400);
			await page.screenshot({path: `${SHOTS}/scan-rows-page-${viewport.width}x${viewport.height}.png`});

			const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#scan-page-pick')]);

			assert.equal(chooser.isMultiple(), false);
			await page.waitForSelector('#scan-page', {state: 'detached'});

			// Photo opens the gallery for one card.
			const [photo] = await Promise.all([page.waitForEvent('filechooser'), page.click('#scan-photo-open')]);

			assert.equal(photo.isMultiple(), false);
			assert.deepEqual(errors, []);
			await context.close();
		});
	}
});

describe('Buy', () => {
	test('Log purchase hands the tray to the trades log as a purchase, nothing is added before Save, and Save empties the tray of the cards handed over', async () => {
		const {context, errors, page} = await open({mode: 'buy', tray: addTray([item('a1', CARDS.a, 'First card', {copies: 2}), item('a2', CARDS.c, 'Third card', {condition: 'Played'})])});

		await page.waitForSelector('#scan-tray .scan-tray-item:nth-child(2)');
		assert.equal(await text(page, '#scan-done-open'), 'Log 2 ›', 'counting the tray as Done does');
		await page.screenshot({path: `${SHOTS}/scan-buy-tray.png`});

		const before = await liveCards(page);

		await page.click('#scan-done-open');
		await page.waitForSelector('#move-form');
		assert.equal(new URL(page.url()).pathname, `${BASE}trades/new`);
		assert.ok(await page.isChecked('#move-kind-bought'), 'a purchase');
		assert.equal(await page.inputValue('#move-date'), await today(page));
		assert.deepEqual(await page.$$eval('#move-in-list [data-card]', (rows) => rows.map((row) => row.dataset.card)), [CARDS.a, CARDS.c]);
		assert.match(await text(page, '#move-in-list [data-card]:first-child'), /2 copies/);
		assert.equal(await page.locator('#move-out-list [data-entry]').count(), 0, 'nothing going out');
		assert.equal(await text(page, '#move-scanned'), 'Scanned 3 coming in. Pick Gift if they were a gift to you. Add who and the price, then Save.');
		assert.deepEqual(await liveCards(page), before, 'nothing added before Save');
		assert.deepEqual(await addTrayNow(page), ['a1', 'a2'], 'the tray waits until Save');
		await page.screenshot({fullPage: true, path: `${SHOTS}/scan-buy-form.png`});

		// A card scanned after the hand over stays in the tray after Save.
		await page.evaluate(async (late) => {
			const draft = await import('/pokemon-card-tracker/js/scan/draft.js');
			const session = await draft.loadSession('add');

			await draft.saveSession({...session, items: [...session.items, late]});
		}, item('a3', CARDS.b, 'Late card'));

		await page.fill('#move-who', 'Shop');
		await page.click('#move-save');
		await page.waitForSelector('.moves-row');
		// The purchase's own toast: the first install's "opens offline" note
		// can be on screen beside it.
		await page.locator('.toast-text', {hasText: /^Saved: 3 cards in\./}).first().waitFor({timeout: 10000});

		const saved = await liveCards(page);

		assert.deepEqual(saved.moves, [{in: 3, kind: 'bought', out: 0, who: 'Shop'}]);
		assert.deepEqual(saved.cards.filter((entry) => entry.came_via).map((entry) => [entry.card_id, entry.language, entry.language_source]), [[CARDS.a, 'en', 'scan'], [CARDS.a, 'en', 'scan'], [CARDS.c, 'en', 'scan']]);
		await untilInPage(page, 'the cards handed over left the tray', async () => {
			const session = await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession('add');

			return Boolean(session && session.items.length === 1 && session.items[0].id === 'a3');
		});

		// Scan again: still Buy, the late card alone in the tray.
		await page.goto(`${harness.origin}${BASE}scan`);
		await scanReady(page);
		assert.equal(await pressed(page, '#scan-mode-buy'), 'true');
		await page.waitForSelector('#scan-tray .scan-tray-item');
		assert.equal(await page.locator('#scan-tray .scan-tray-item').count(), 1);
		assert.equal(await text(page, '#scan-done-open'), 'Log 1 ›');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a card that needs a look opens Review instead of the form', async () => {
		const unsure = item('a2', CARDS.b, 'Unsure card', {candidates: [card(CARDS.b, 'Unsure card'), card(CARDS.c, 'Other card')], confirmed: false, status: 'unsure', sure: false});
		const {context, errors, page} = await open({mode: 'buy', tray: addTray([item('a1', CARDS.a, 'First card'), unsure])});

		await page.waitForSelector('#scan-tray .scan-tray-item:nth-child(2)');
		await page.click('#scan-done-open');
		await page.waitForSelector('#scan-confirm');
		assert.equal(new URL(page.url()).pathname, `${BASE}scan`, 'the form waits');
		assert.equal(await page.locator('#scan-save, #scan-review-done').count(), 0, 'no Save in Buy');
		assert.equal(await text(page, '#scan-log-purchase'), 'Log purchase 2', 'the sheet hands over too');
		assert.deepEqual(await addTrayNow(page), ['a1', 'a2']);
		assert.deepEqual(errors, []);
		await context.close();
	});
});

describe('Log as a purchase', () => {
	test('in Add, the Done sheet logs the tray as a purchase, and leaving the form without saving keeps the tray', async () => {
		const {context, errors, page} = await open({tray: addTray([item('a1', CARDS.a, 'First card'), item('a2', CARDS.b, 'Second card')])});

		await page.waitForSelector('#scan-tray .scan-tray-item:nth-child(2)');
		assert.equal(await pressed(page, '#scan-mode-add'), 'true');
		await page.click('#scan-done-open');
		await page.waitForSelector('#scan-done');
		assert.equal(await text(page, '#scan-log-as-purchase'), 'Log as a purchase');
		assert.equal(await page.getAttribute('#scan-log-as-purchase', 'disabled'), null);
		assert.equal(await text(page, '#scan-log-as-purchase-help'), 'Opens Trades and sales with these cards coming in. They are added when you save it there.');
		await page.waitForTimeout(400);
		await page.screenshot({path: `${SHOTS}/scan-buy-done-sheet.png`});

		const before = await liveCards(page);

		await page.click('#scan-log-as-purchase');
		await page.waitForSelector('#move-form');
		assert.equal(new URL(page.url()).pathname, `${BASE}trades/new`);
		assert.ok(await page.isChecked('#move-kind-bought'));
		assert.deepEqual(await page.$$eval('#move-in-list [data-card]', (rows) => rows.map((row) => row.dataset.card)), [CARDS.a, CARDS.b]);
		assert.deepEqual(await liveCards(page), before, 'nothing added');

		// Back to Scan without saving: the tray as it was, still Add.
		await page.goBack();
		await scanReady(page);
		await page.waitForSelector('#scan-tray .scan-tray-item:nth-child(2)');
		assert.equal(await pressed(page, '#scan-mode-add'), 'true');
		assert.equal(await text(page, '#scan-done-open'), 'Done 2');
		assert.deepEqual(await addTrayNow(page), ['a1', 'a2']);

		// Log it again and save: the tray empties.
		await page.click('#scan-done-open');
		await page.waitForSelector('#scan-done');
		await page.click('#scan-log-as-purchase');
		await page.waitForSelector('#move-form');
		await page.click('#move-save');
		await page.waitForSelector('.moves-row');
		assert.deepEqual((await liveCards(page)).moves, [{in: 2, kind: 'bought', out: 0, who: null}]);
		await untilInPage(page, 'the tray emptied', async () => {
			const session = await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession('add');

			return Boolean(session && session.items.length === 0);
		});
		assert.deepEqual(errors, []);
		await context.close();
	});
});
