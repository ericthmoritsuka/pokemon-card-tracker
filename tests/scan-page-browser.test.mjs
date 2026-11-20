// Browser tests for the scanner's Binder page (js/scan/page.js,
// js/scan/view.js readPage): a whole 3 x 3 binder page from one still
// photo. Page, in the How row at the head of the tray (Eric, 2026-11-19),
// opens the Binder page sheet; a photo chosen there is found and cut into
// pockets off the main thread, and each pocket
// with a card joins the tray as a capture does, sure or asking for a look,
// while empty pockets are skipped. Each pocket's own card is cut to its
// edges from a larger copy of the photo, for its number. A photo with no
// page in it says so and adds nothing.
//
// Headless Chromium at 360 x 740 against tests/scan-harness.mjs, with no
// camera (the scanner opens with the camera off). The page is drawn here
// from the TCGdex scans the other scan tests use (Bulbasaur me01-001,
// Pikachu sv03.5-025, swsh3-102), seven cards and two empty pockets on a
// dark sheet over a table, turned a little; and a spread of two such pages
// side by side, taken with the phone turned as Eric takes his binder (the
// photo standing, the cards' tops to its right). TCGdex answers are replayed from
// the harness cache; Supabase and ligapokemon.com.br are refused and must
// never be asked.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/scan-page-browser.test.mjs

import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {after, before, describe, test} from 'node:test';

import {fakeRates} from './fake-rates.mjs';
import {cardImage, routeTcgdex, startScanHarness} from './scan-harness.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const VIEWPORT = {height: 740, width: 360};
const SHOTS = process.env.SHOTS || '/tmp';
const PHOTOS = '/tmp/scan-page-photos';

const CARDS = {a: 'me01-001', b: 'sv03.5-025', c: 'swsh3-102'};
// The page, row by row: a card's key, or null for an empty pocket.
const LAYOUT = ['a', 'b', 'c', 'b', null, 'a', 'c', 'a', null];
// The spread's right page; its left page is LAYOUT.
const RIGHT = ['c', 'a', 'b', null, 'c', 'b', 'b', 'c', 'a'];

let harness;
let browser;
let pagePhoto;
let spreadPhoto;
let tablePhoto;

const url = (path = '') => `${harness.origin}${BASE}${path}`;

async function until(check, timeout = 30000, what = 'a condition') {
	const end = Date.now() + timeout;

	while (!(await check())) {
		if (Date.now() > end) {
			throw new Error(`Timed out waiting for ${what}.`);
		}

		await new Promise((resolve) => setTimeout(resolve, 150));
	}
}

// The binder page as a JPEG: cards 440 pixels wide in a 3 x 3 grid on a
// dark sheet, each a little off in its pocket, the sheet over a wood table
// and turned 1.5 degrees. With `empty`, the table alone.
async function makePhoto(page, {empty = false} = {}) {
	const images = {};

	for (const [key, id] of Object.entries(CARDS)) {
		images[key] = (await readFile(await cardImage(id))).toString('base64');
	}

	const jpeg = await page.evaluate(async ({empty, images, layout}) => {
		const decoded = {};

		for (const [key, data] of Object.entries(images)) {
			const img = new Image();

			img.src = `data:image/webp;base64,${data}`;
			await img.decode();
			decoded[key] = img;
		}

		const cw = 440;
		const ch = (cw * 88) / 63;
		const gap = cw * 0.05;
		const margin = 30;
		const pw = cw * 3 + gap * 2 + margin * 2;
		const ph = ch * 3 + gap * 2 + margin * 2;
		const canvas = document.createElement('canvas');

		canvas.width = 1700;
		canvas.height = 2300;

		const ctx = canvas.getContext('2d');

		ctx.fillStyle = '#7a6250';
		ctx.fillRect(0, 0, canvas.width, canvas.height);

		// A little grain on the table.
		for (let i = 0; i < 4000; i++) {
			ctx.fillStyle = i % 2 ? 'rgba(0, 0, 0, 0.06)' : 'rgba(255, 255, 255, 0.05)';
			ctx.fillRect((i * 7919) % canvas.width, (i * 104729) % canvas.height, 40, 2);
		}

		if (!empty) {
			ctx.translate(canvas.width / 2, canvas.height / 2);
			ctx.rotate((1.5 * Math.PI) / 180);
			ctx.fillStyle = '#141416';
			ctx.fillRect(-pw / 2, -ph / 2, pw, ph);

			layout.forEach((key, i) => {
				const row = Math.floor(i / 3);
				const col = i % 3;
				const x = -pw / 2 + margin + col * (cw + gap) + ((i * 37) % 7) - 3;
				const y = -ph / 2 + margin + row * (ch + gap) + ((i * 53) % 7) - 3;

				// The pocket's sleeve, a shade lighter than the sheet.
				ctx.fillStyle = '#1d1d21';
				ctx.fillRect(x - 6, y - 6, cw + 12, ch + 12);

				if (key) {
					ctx.drawImage(decoded[key], x, y, cw, ch);
				}
			});
		}

		return canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
	}, {empty, images, layout: LAYOUT});
	const file = join(PHOTOS, `${empty ? 'table' : 'page'}-${randomUUID()}.jpg`);

	await mkdir(PHOTOS, {recursive: true});
	await writeFile(file, Buffer.from(jpeg, 'base64'));

	return file;
}

// A binder lying open as a JPEG: LAYOUT's page on the left and RIGHT's on
// the right, cards 300 pixels wide, the pages 70 pixels apart over the
// binder's dark cover, on a wood table; the whole taken with the phone
// turned, so the photo stands and the cards' tops point to its right.
async function makeSpread(page) {
	const images = {};

	for (const [key, id] of Object.entries(CARDS)) {
		images[key] = (await readFile(await cardImage(id))).toString('base64');
	}

	const jpeg = await page.evaluate(async ({images, layouts}) => {
		const decoded = {};

		for (const [key, data] of Object.entries(images)) {
			const img = new Image();

			img.src = `data:image/webp;base64,${data}`;
			await img.decode();
			decoded[key] = img;
		}

		const cw = 300;
		const ch = (cw * 88) / 63;
		const gap = cw * 0.05;
		const margin = 24;
		const pw = cw * 3 + gap * 2 + margin * 2;
		const ph = ch * 3 + gap * 2 + margin * 2;
		const spine = 70;
		// The spread as it lies, before the phone's turn.
		const wide = document.createElement('canvas');

		wide.width = 2400;
		wide.height = 1700;

		const ctx = wide.getContext('2d');

		ctx.fillStyle = '#7a6250';
		ctx.fillRect(0, 0, wide.width, wide.height);

		for (let i = 0; i < 4000; i++) {
			ctx.fillStyle = i % 2 ? 'rgba(0, 0, 0, 0.06)' : 'rgba(255, 255, 255, 0.05)';
			ctx.fillRect((i * 7919) % wide.width, (i * 104729) % wide.height, 40, 2);
		}

		ctx.translate(wide.width / 2, wide.height / 2);
		ctx.rotate((1 * Math.PI) / 180);
		// The binder's cover, round both pages.
		ctx.fillStyle = '#0b0b0d';
		ctx.fillRect(-pw - spine / 2 - 20, -ph / 2 - 20, pw * 2 + spine + 40, ph + 40);

		layouts.forEach((layout, side) => {
			const left = side ? spine / 2 : -spine / 2 - pw;

			ctx.fillStyle = '#141416';
			ctx.fillRect(left, -ph / 2, pw, ph);

			layout.forEach((key, i) => {
				const row = Math.floor(i / 3);
				const col = i % 3;
				const x = left + margin + col * (cw + gap) + ((i * 37 + side * 11) % 5) - 2;
				const y = -ph / 2 + margin + row * (ch + gap) + ((i * 53 + side * 7) % 5) - 2;

				ctx.fillStyle = '#1d1d21';
				ctx.fillRect(x - 5, y - 5, cw + 10, ch + 10);

				if (key) {
					ctx.drawImage(decoded[key], x, y, cw, ch);
				}
			});
		});

		// Turned a quarter clockwise: the spread's top to the photo's right.
		const photo = document.createElement('canvas');

		photo.width = wide.height;
		photo.height = wide.width;

		const turn = photo.getContext('2d');

		turn.translate(photo.width, 0);
		turn.rotate(Math.PI / 2);
		turn.drawImage(wide, 0, 0);

		return photo.toDataURL('image/jpeg', 0.9).split(',')[1];
	}, {images, layouts: [LAYOUT, RIGHT]});
	const file = join(PHOTOS, `spread-${randomUUID()}.jpg`);

	await mkdir(PHOTOS, {recursive: true});
	await writeFile(file, Buffer.from(jpeg, 'base64'));

	return file;
}

async function open() {
	const context = await browser.newContext({viewport: VIEWPORT});
	const refused = [];

	await fakeRates(context);
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await context.route('https://*.supabase.co/**', (route) => {
		refused.push(route.request().url());

		return route.abort();
	});
	await context.route(/ligapokemon\.com\.br/, (route) => {
		refused.push(route.request().url());

		return route.abort();
	});
	await routeTcgdex(context);

	const page = await context.newPage();
	const errors = [];
	const workers = [];

	page.on('pageerror', (err) => errors.push(err));
	page.on('worker', (worker) => workers.push(worker.url()));

	return {context, errors, page, refused, workers};
}

async function close({context, errors, refused}) {
	await context.close();
	assert.deepEqual(errors.map(String), [], 'no script errors');
	assert.deepEqual(refused, [], 'neither Supabase nor ligapokemon.com.br was asked');
}

const text = (page, selector) => page.locator(selector).textContent();

const trayItems = (page) => page.evaluate(async () => {
	const session = await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession();

	return (session ? session.items : []).map((item) => ({
		candidates: (item.candidates || []).map((card) => card.id),
		card: item.card ? item.card.id : null,
		page: item.page ?? null,
		source: item.report ? item.report.source : null,
		status: item.status,
		sure: Boolean(item.sure && item.card),
	}));
});

// Chooses `file` through Page's Choose a photo, as a tap does.
async function choose(page, file) {
	await page.click('#scan-page-open');
	await page.waitForSelector('#scan-page');

	const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#scan-page-pick')]);

	await chooser.setFiles(file);
}

describe('a binder page from one photo', () => {
	before(async () => {
		harness = await startScanHarness();
		browser = await chromium.launch();

		const scratch = await browser.newPage();

		await fakeRates(scratch.context());
		pagePhoto = await makePhoto(scratch);
		spreadPhoto = await makeSpread(scratch);
		tablePhoto = await makePhoto(scratch, {empty: true});
		await scratch.close();
	});

	after(async () => {
		await browser.close();
		await harness.close();
	});

	test('Page beside the shutter opens Binder page: how to take the photo, and the camera or the gallery', async () => {
		const app = await open();
		const {page} = app;

		await page.goto(url('scan'));
		await page.waitForSelector('#scan-camera-off:not([hidden])');
		assert.equal(await text(page, '#scan-photo-open'), 'Photo', 'the single-card photo is the shutter row\'s Photo');
		assert.equal(await text(page, '#scan-page-open'), 'Page');
		assert.equal(await page.getAttribute('#scan-page-open', 'aria-label'), 'Page: a whole binder page from a photo');
		assert.equal(await page.getAttribute('#scan-page-open', 'aria-haspopup'), 'dialog');
		assert.equal(await page.getAttribute('#scan-page-open', 'aria-pressed'), null, 'an action, never pressed');
		assert.equal(await page.locator('.scan-tray-head #scan-page-take, .scan-tray-head #scan-page-pick').count(), 0, 'its two choices are on its sheet, not in the tray row');

		// No longer in the scanner's settings.
		await page.click('#scan-settings-open');
		await page.waitForSelector('#scan-settings');
		assert.equal(await page.locator('#scan-settings #scan-page, #scan-settings #scan-page-pick').count(), 0, 'not in the settings any more');
		await page.click('#scan-sheet-close');
		await page.waitForSelector('#scan-settings', {state: 'detached'});

		await page.click('#scan-page-open');
		await page.waitForSelector('#scan-page');
		assert.equal(await page.getAttribute('#scan-page', 'role'), 'dialog');
		assert.equal(await text(page, '#scan-page-label'), 'Binder page');
		assert.equal(await text(page, '#scan-page-help'), 'Add a whole page of cards from one photo, or two pages side by side, filling the photo. Set the camera to 3:4, hold the phone flat over it, no zoom, a lamp to the side.');
		assert.equal(await text(page, '#scan-page-take'), 'Take a photo');
		assert.equal(await text(page, '#scan-page-pick'), 'Choose a photo');
		assert.equal(await page.getAttribute('#scan-page-camera', 'capture'), 'environment', 'Take a photo opens the camera');
		assert.equal(await page.getAttribute('#scan-page-gallery', 'capture'), null, 'Choose a photo opens the gallery');
		await page.screenshot({path: `${SHOTS}/scan-page-sheet.png`});

		await page.click('#scan-sheet-close');
		await page.waitForSelector('#scan-page', {state: 'detached'});

		await close(app);
	});

	// The page as the photo has it (Eric, 2026-11-19: "maybe i could see the
	// cards in a binder page? and then tap them to select the language").
	test('the page opens as a grid, its cards in their pockets; one tap sets the language of those not read; a card goes back to the page', async () => {
		const app = await open();
		const {page} = app;

		await page.goto(url('scan'));
		await page.waitForSelector('#scan-camera-off:not([hidden])');
		await choose(page, pagePhoto);
		await page.waitForSelector('#scan-pagegrid', {timeout: 300000});
		await until(async () => /^Page read/.test(await text(page, '#scan-note')), 300000, 'the page read');

		const cells = await page.$$eval('#scan-page-grid-1 > li', (nodes) => nodes.map((node) => (node.classList.contains('scan-page-empty') ? `empty:${node.textContent}` : node.querySelector('[data-item]').dataset.item)));
		const pageOf = new Map(await page.evaluate(async () => (await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession()).items.map((item) => [item.id, item.page])));

		assert.equal(cells.length, 9, 'nine pockets');
		assert.deepEqual(cells.map((cell, i) => (cell.startsWith('empty:') ? cell : pageOf.get(cell) === i + 1 ? 'in its pocket' : `pocket ${pageOf.get(cell)} in cell ${i + 1}`)),
			LAYOUT.map((key) => (key ? 'in its pocket' : 'empty:Empty')));
		// Once the pockets' languages are read behind the read.
		await until(async () => /Tap a card/.test(await text(page, '#scan-pagegrid-line')), 120000, 'the languages read');
		assert.match(await text(page, '#scan-pagegrid-line'), /^7 cards(, \d to check)?\. Tap a card to check it or change it\.$/);
		await page.waitForTimeout(400);
		await page.screenshot({path: `${SHOTS}/scan-page-grid.png`});

		// The grid leads, and its actions stay at the sheet's foot (design
		// review, 2026-11-19): at 360 x 740 the first row of pockets is in
		// sight over the foot, which is on the screen whole.
		const boxes = await page.evaluate(() => {
			const box = (selector) => document.querySelector(selector).getBoundingClientRect();
			const first = box('#scan-page-grid-1 > li');

			return {firstBottom: first.bottom, firstTop: first.top, foot: box('#scan-pagegrid-foot').top, footBottom: box('#scan-pagegrid-foot').bottom, line: box('#scan-pagegrid-line').top, mode: box('#scan-page-mine').top};
		});

		assert.ok(boxes.line < boxes.firstTop, 'the line over the grid');
		assert.ok(boxes.firstBottom <= boxes.foot, `the first row of pockets whole over the foot (${JSON.stringify(boxes)})`);
		assert.ok(boxes.footBottom <= VIEWPORT.height + 0.5, `the foot on the screen (${JSON.stringify(boxes)})`);
		assert.ok(boxes.mode >= boxes.foot, 'New to my cards and Already mine at the foot');
		assert.equal(await page.locator('#scan-pagegrid-foot #scan-pagegrid-lang-en').count(), 1, 'the language row at the foot');

		// Label checks still running in the background may settle a card's
		// language meanwhile, so the end state is what is checked: the cards
		// the row set are English and as many as it says, and none whose
		// language was a default is left in another one.
		await page.click('#scan-pagegrid-lang-en');
		await page.waitForSelector('#scan-pagegrid-told');
		assert.equal(await page.getAttribute('#scan-pagegrid-lang-en', 'aria-pressed'), 'true');

		const told = await text(page, '#scan-pagegrid-told');
		const after = await page.evaluate(async () => (await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession()).items.map((item) => ({by: item.languageBy || null, language: item.language || null})));
		const set = after.filter((item) => item.by === 'all');

		assert.ok(set.every((item) => item.language === 'en'), JSON.stringify(after));
		assert.ok(!after.some((item) => item.by === 'default' && item.language !== 'en'), JSON.stringify(after));
		assert.equal(told, set.length ? `${set.length} card${set.length === 1 ? '' : 's'} set to English.` : 'No card changed: every one is English already.');
		assert.ok(after.filter((item) => item.by === 'read').every((item) => item.language === 'en'), 'read languages stay (the synthetic cards are English)');

		const first = cells.find((cell) => !cell.startsWith('empty:'));

		await page.click(`#scan-page-grid-1 [data-item="${first}"]`);
		await page.waitForSelector('#scan-confirm #scan-page-back');
		await page.click('#scan-page-back');
		await page.waitForSelector('#scan-pagegrid');
		assert.deepEqual(app.errors, []);
		await close(app);
	});

	// "I already have these cards" (Eric, 2026-11-19): the page's cards leave
	// the tray, each pocket takes one of his copies (one copy never twice; a
	// copy filed elsewhere moves), and the page is placed in a new binder.
	test('Already mine matches the pockets to his copies and places the page in a new binder; New to my cards puts them back', async () => {
		const app = await open();
		const {page} = app;

		await page.goto(url('scan'));
		await page.waitForSelector('#scan-camera-off:not([hidden])');

		const seeded = await page.evaluate(async (cards) => {
			const collection = await import('/pokemon-card-tracker/js/collection.js');
			const binders = await import('/pokemon-card-tracker/js/binders.js');
			const copy = (id) => ({card_id: id, catalog: 'international', language: 'en', language_source: 'manual'});
			const [a1, a2, b1, other] = await collection.addCards([copy(cards.a), copy(cards.a), copy(cards.b), copy('base1-58')]);
			const old = await binders.createBinder({cols: 3, name: 'Binder A', page_count: 1, rows: 3});

			await binders.placeCard(old.id, 1, 5, b1.id);
			// A card not on the scanned page, in the pocket the page's first
			// card would take: placing on page 1 must say it comes out.
			await binders.placeCard(old.id, 1, 1, other.id);

			return {a1: a1.id, a2: a2.id, b1: b1.id, old: old.id, other: other.id};
		}, CARDS);

		await choose(page, pagePhoto);
		await page.waitForSelector('#scan-pagegrid', {timeout: 300000});
		await until(async () => /^Page read/.test(await text(page, '#scan-note')), 300000, 'the page read');
		await page.waitForSelector('#scan-page-mine:not([disabled])', {timeout: 120000});
		await page.click('#scan-page-mine');
		await until(async () => !/Finding/.test(await text(page, '#scan-place-line')), 30000, 'his copies read');

		const tray = await page.evaluate(async () => (await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession()).items.length);

		assert.equal(tray, 0, 'the page\'s cards left the tray, so Done cannot add them');
		assert.equal(await page.getAttribute('#scan-page-mine', 'aria-pressed'), 'true');
		assert.equal(await text(page, '#scan-place-line'), '3 cards from your cards, 1 of them taken from the pocket it is in now; 4 placeholders for cards you have none left of. Tap a card to pick another copy.');

		const wheres = await page.$$eval('#scan-page-grid-1 > li', (nodes) => nodes.map((node) => (node.classList.contains('scan-page-empty') ? 'empty' : node.querySelector('.scan-page-where').textContent)));

		assert.deepEqual(wheres, ['Loose', 'Binder A, p. 1', 'No copy left: placeholder', 'No copy left: placeholder', 'empty', 'Loose', 'No copy left: placeholder', 'No copy left: placeholder', 'empty']);
		await page.waitForTimeout(400);
		await page.screenshot({path: `${SHOTS}/scan-page-mine.png`});

		// New to my cards and back: the cards return to the tray, then leave it again.
		await page.click('#scan-page-new');
		assert.equal(await page.evaluate(async () => (await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession()).items.length), 7);
		await page.click('#scan-page-mine');
		await until(async () => !/Finding/.test(await text(page, '#scan-place-line')), 30000, 'his copies read again');

		await page.selectOption('#scan-place-binder', 'new');
		await page.click('#scan-place-go');
		assert.equal(await text(page, '#scan-pagegrid [role="alert"]'), 'Give the new binder a name.');
		await page.fill('#scan-place-name', 'Kanto page');
		await page.click('#scan-place-go');
		await page.waitForSelector('#scan-place-done');
		assert.equal(await text(page, '#scan-place-done'), 'Placed on page 1 of Kanto page: 3 cards and 4 placeholders.');

		const after = await page.evaluate(async (ids) => {
			const binders = await import('/pokemon-card-tracker/js/binders.js');
			const all = await binders.listBinders();
			const made = all.find((one) => one.name === 'Kanto page');
			const old = all.find((one) => one.id === ids.old);

			return {
				made: made.slots.filter((slot) => !slot.cleared).map((slot) => [slot.position, slot.entry_id ? (slot.entry_id === ids.a1 ? 'a1' : slot.entry_id === ids.a2 ? 'a2' : slot.entry_id === ids.b1 ? 'b1' : '?') : `want ${slot.want.card_id}`]),
				oldHolds: old.slots.filter((slot) => slot.entry_id === ids.b1).length,
			};
		}, seeded);

		assert.deepEqual(after.made, [[1, 'a1'], [2, 'b1'], [3, `want ${CARDS.c}`], [4, `want ${CARDS.b}`], [6, 'a2'], [7, `want ${CARDS.c}`], [8, `want ${CARDS.a}`]]);
		assert.equal(after.oldHolds, 0, 'the copy left Binder A');

		// Undo: the new binder goes, the copy goes back to Binder A, and the
		// page is back to place again.
		const pocketsOf = (ids) => page.evaluate(async (ids) => {
			const binders = await import('/pokemon-card-tracker/js/binders.js');
			const all = await binders.listBinders();
			const name = (id) => Object.keys(ids).find((key) => ids[key] === id) || id;

			return {
				kanto: all.filter((one) => one.name === 'Kanto page').length,
				old: all.find((one) => one.id === ids.old).slots.filter((slot) => !slot.cleared).map((slot) => [slot.page, slot.position, slot.entry_id ? name(slot.entry_id) : `want ${slot.want.card_id}`]),
			};
		}, ids);

		await page.click('#scan-place-undo');
		await page.waitForSelector('#scan-page-mine[aria-pressed="true"]');
		await until(async () => !/Finding/.test(await text(page, '#scan-place-line')), 30000, 'his copies read after Undo');
		assert.deepEqual(await pocketsOf(seeded), {kanto: 0, old: [[1, 1, 'other'], [1, 5, 'b1']]});

		// Binder A: a free page is offered first; page 1 holds a card the
		// page does not, so it warns and the button says Replace.
		await page.selectOption('#scan-place-binder', seeded.old);
		assert.equal(await page.$eval('#scan-place-page', (select) => select.selectedOptions[0].textContent), 'A new page at the end (page 2)');
		assert.equal(await page.$eval('#scan-place-page option[value="1"]', (option) => option.textContent), 'Page 1, 2 in use');
		await page.selectOption('#scan-place-page', '1');
		assert.equal(await text(page, '#scan-place-warning'), '1 card on that page will come out of its pocket and be loose. Undo puts it back.');
		assert.equal(await text(page, '#scan-place-go'), 'Replace 1 card on page 1');
		await page.click('#scan-place-go');
		await page.waitForSelector('#scan-place-done');
		assert.equal(await text(page, '#scan-place-done'), 'Placed on page 1 of Binder A: 3 cards and 4 placeholders. 1 card that was there is loose now.');
		await page.click('#scan-place-undo');
		await page.waitForSelector('#scan-page-mine[aria-pressed="true"]');
		assert.deepEqual((await pocketsOf(seeded)).old, [[1, 1, 'other'], [1, 5, 'b1']], 'Undo put Binder A back');
		assert.deepEqual(app.errors, []);
		await close(app);
	});

	// A review, 2026-11-20: Already mine was offered as soon as the pockets'
	// pictures were read, while their attack text and stage labels were still
	// read behind them; tapped then, it took the pockets out of the tray and
	// those reads (their language, and the print matched again in it) found
	// nothing to act on. DESIGN.md promises no card is matched while it is
	// still being read.
	test('Already mine waits until the pockets\' languages are read, and the line says so', async () => {
		const app = await open();
		const {page} = app;

		await page.goto(url('scan'));
		await page.waitForSelector('#scan-camera-off:not([hidden])');
		await choose(page, pagePhoto);

		// The moment the read ends, looked at in the very frame.
		const atEnd = await (await page.waitForFunction(() => {
			if (!/^Page read/.test(document.getElementById('scan-note')?.textContent || '')) {
				return false;
			}

			const mine = document.querySelector('#scan-page-mine');
			const line = document.querySelector('#scan-pagegrid-line');

			return {disabled: mine ? mine.disabled : null, line: line ? line.textContent : null};
		}, null, {polling: 'raf', timeout: 300000})).jsonValue();

		assert.equal(atEnd.disabled, true, `Already mine waits as the read ends (${JSON.stringify(atEnd)})`);
		assert.match(atEnd.line, /^7 cards(, \d to check)?\. Still reading their languages, so Already mine waits\.$/);

		// Then it is offered, and the line says what to do.
		await page.waitForSelector('#scan-page-mine:not([disabled])', {timeout: 120000});
		assert.match(await text(page, '#scan-pagegrid-line'), /^7 cards(, \d to check)?\. Tap a card to check it or change it\.$/);

		await page.click('#scan-page-mine');
		await page.waitForSelector('#scan-page-mine[aria-pressed="true"]');
		await close(app);
	});

	// A review, 2026-11-20: while a second page was found, the sheet's New to
	// my cards acted on the page before, putting its cards, Already mine,
	// back in the tray, for Done to add again; and a page read over a page
	// Already mine and not placed dropped that page's cards from the scan.
	test('while a page is found its mode chips wait, and a page Already mine is placed before another is read', async () => {
		const app = await open();
		const {page} = app;
		const runOf = () => page.evaluate(async () => {
			const session = await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession();
			const run = session && session.pageRun;

			return {held: run && run.held ? run.held.length : 0, id: run ? run.id : null, mine: Boolean(run && run.mine), tray: session ? session.items.map((item) => item.pageRun || null) : []};
		});

		await page.goto(url('scan'));
		await page.waitForSelector('#scan-camera-off:not([hidden])');
		await choose(page, pagePhoto);
		await until(async () => /^Page read/.test(await text(page, '#scan-note')), 300000, 'the first page read');
		await page.waitForSelector('#scan-pagegrid');

		const first = await runOf();

		assert.equal(first.tray.filter((run) => run === first.id).length, 7);
		await page.click('#scan-pagegrid-done');
		await page.waitForSelector('#scan-pagegrid', {state: 'detached'});

		// The second page, while it is found: neither chip can be used, and
		// a tap that gets through changes nothing.
		await choose(page, pagePhoto);
		await page.waitForSelector('#scan-pagegrid .scan-page-grid.is-waiting', {timeout: 30000});

		const chips = await page.evaluate(() => {
			const states = ['#scan-page-new', '#scan-page-mine'].map((selector) => document.querySelector(selector).disabled);

			// Already mine, had it been offered, would have taken the page
			// before's cards out of the tray just before the new page took
			// its place.
			const mine = document.querySelector('#scan-page-mine');

			mine.disabled = false;
			mine.click();

			return states;
		});

		assert.deepEqual(chips, [true, true], 'New to my cards and Already mine both wait while the page is found');

		const during = await runOf();

		assert.equal(during.mine, false, 'the page before did not turn to Already mine');
		assert.equal(during.tray.filter((run) => run === first.id).length, 7, 'the page before\'s cards stayed in the tray');
		await until(async () => /^Page read/.test(await text(page, '#scan-note')), 300000, 'the second page read');
		await page.waitForSelector('#scan-pagegrid');

		const second = await runOf();

		assert.notEqual(second.id, first.id);
		assert.equal(second.tray.length, 14, 'both pages\' cards in the tray, once each');

		// The second page is his already, and not placed: Page says so, and
		// reads no other page until it is placed or turned back.
		await page.waitForSelector('#scan-page-mine:not([disabled])', {timeout: 120000});
		await page.click('#scan-page-mine');
		await until(async () => (await runOf()).held === 7, 10000, 'the page held');
		await page.click('#scan-sheet-close');
		await page.waitForSelector('#scan-pagegrid', {state: 'detached'});
		await page.click('#scan-page-open');
		await page.waitForSelector('#scan-page-unplaced');
		assert.equal(await text(page, '#scan-page-unplaced'), 'The page before is Already mine and not placed yet: its 7 cards are not in the tray. Place it, or turn it to New to my cards, then read the next page.');
		assert.equal(await page.locator('#scan-page-pick, #scan-page-take').count(), 0, 'no photo can be taken or chosen meanwhile');
		await page.click('#scan-page-unplaced-open');
		await page.waitForSelector('#scan-pagegrid #scan-page-mine[aria-pressed="true"]');

		const after = await runOf();

		assert.deepEqual([after.id, after.mine, after.held, after.tray.length], [second.id, true, 7, 7], 'the page Already mine kept its cards, and the page before\'s stayed in the tray');
		await close(app);
	});

	// A review of v85, 2026-11-20: the scanner is made again on every visit
	// to Scan, and his copies are read per scanner, so a page Already mine
	// and not placed, opened after the scanner reopened, said Finding your
	// copies with no way to place it; and its cards, out of the tray, lost
	// their photos to the startup's clean-up.
	test('a page Already mine and not placed can be placed after the scanner reopens, its photos kept', async () => {
		const app = await open();
		const {page} = app;
		const heldIds = () => page.evaluate(async () => {
			const session = await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession();

			return (session.pageRun && session.pageRun.held ? session.pageRun.held : []).map((item) => item.id);
		});
		const photos = () => page.$$eval('#scan-page-grid-1 [data-mine-item] img', (imgs) => imgs.map((img) => (img.src.startsWith('blob:') ? 'photo' : img.src)));

		await page.goto(url('scan'));
		await page.waitForSelector('#scan-camera-off:not([hidden])');
		await choose(page, pagePhoto);
		await page.waitForSelector('#scan-pagegrid', {timeout: 300000});
		await until(async () => /^Page read/.test(await text(page, '#scan-note')), 300000, 'the page read');
		await page.waitForSelector('#scan-page-mine:not([disabled])', {timeout: 120000});
		await page.click('#scan-page-mine');
		await until(async () => !/Finding/.test(await text(page, '#scan-place-line')), 30000, 'his copies read');

		const held = await heldIds();

		assert.equal(held.length, 7, 'the page\'s cards held');
		assert.deepEqual(await photos(), Array(7).fill('photo'), 'each pocket shows its own photo');

		// Away from Scan and back: a new scanner.
		await page.click('#scan-sheet-close');
		await page.waitForSelector('#scan-pagegrid', {state: 'detached'});
		await page.click('#scan-close');
		await page.waitForSelector('#scan', {state: 'detached'});
		await page.click('a[data-tab="scan"]');
		await page.waitForSelector('#scan-camera-off:not([hidden])');
		await page.click('#scan-page-open');
		await page.waitForSelector('#scan-page-unplaced');
		await page.click('#scan-page-unplaced-open');
		await page.waitForSelector('#scan-pagegrid #scan-page-mine[aria-pressed="true"]');
		await until(async () => !/Finding/.test(await text(page, '#scan-place-line')), 20000, 'his copies read in the new scanner');
		assert.match(await text(page, '#scan-place-line'), /^\d cards? from your cards.*Tap a card to pick another copy\.$/);
		assert.equal(await page.locator('#scan-place-go').count(), 1, 'the page can be placed');
		assert.deepEqual(await heldIds(), held, 'the same cards held');
		assert.deepEqual(await photos(), Array(7).fill('photo'), 'each pocket still shows its own photo');

		const kept = await page.evaluate(async (ids) => {
			const draft = await import('/pokemon-card-tracker/js/scan/draft.js');

			return Promise.all(ids.map(async (id) => (await draft.loadPhoto(id)) instanceof Blob));
		}, held);

		assert.deepEqual(kept, Array(7).fill(true), 'the draft kept the held cards\' photos');
		await close(app);
	});

	test('each pocket with a card joins the tray, sure or asking for a look, and empty pockets are skipped', async () => {
		const app = await open();
		const {page} = app;
		const notes = new Set();
		// The page sheet while the page is read (design review, 2026-11-19:
		// it opens at once and its pockets fill as they are read), and the
		// panel over the camera (Eric, 2026-11-19: no sign of anything
		// working), which shows when the sheet is closed meanwhile.
		const sheets = new Set();
		const panels = new Set();
		let closed = false;

		await page.goto(url('scan'));
		await page.waitForSelector('#scan-camera-off:not([hidden])');
		assert.ok(await page.$eval('#scan-page-busy', (panel) => panel.hidden), 'no panel before a page');
		await choose(page, pagePhoto);
		await page.waitForSelector('#scan-pagegrid', {timeout: 10000});
		await page.screenshot({path: `${SHOTS}/scan-page-finding.png`});

		await until(async () => {
			const note = await text(page, '#scan-note');
			const sheet = await page.evaluate(() => {
				const grid = document.getElementById('scan-pagegrid');

				if (!grid) {
					return 'closed';
				}

				const line = grid.querySelector('#scan-pagegrid-line');
				const pockets = grid.querySelectorAll('.scan-page-grid > li').length;
				const tiles = grid.querySelectorAll('#scan-page-grid-1 [data-item]').length;
				const mine = grid.querySelector('#scan-page-mine');

				return `${line ? line.textContent : ''} | ${pockets} pockets, ${tiles ? 'tiles' : 'no tiles'}, mine ${mine && mine.disabled ? 'waits' : 'open'}`;
			});
			const panel = await page.$eval('#scan-page-busy', (node) => (node.hidden ? 'hidden' : `${node.classList.contains('is-finding') ? 'finding' : 'pockets'}: ${node.querySelector('#scan-page-step').textContent}`));

			notes.add(note);
			sheets.add(sheet);
			panels.add(`${sheet === 'closed' ? 'closed' : 'open'} ${panel}`);

			// Once the grid has its first tiles, the sheet is closed: the
			// panel over the camera takes over, and the sheet comes back at
			// the end.
			if (!closed && /tiles/.test(sheet) && !/no tiles/.test(sheet) && /^Reading pocket [2-8] of 9\.$/.test(note)) {
				closed = true;
				await page.screenshot({path: `${SHOTS}/scan-page-reading.png`});
				await page.click('#scan-sheet-close');
			}

			return /^Page read/.test(note);
		}, 300000, 'the page read');

		assert.ok([...notes].some((note) => /^Reading pocket [1-9] of 9\.$/.test(note)), `progress shown (${[...notes].join(' | ')})`);
		assert.ok(sheets.has('Finding the page and its pockets. A large photo can take about a minute. | 9 pockets, no tiles, mine waits'), `the sheet while the page is found: nine pockets waiting (${[...sheets].join(' || ')})`);
		assert.ok([...sheets].some((sheet) => /^Reading pocket [1-9] of 9\. \| 9 pockets, tiles, mine waits$/.test(sheet)), `the grid fills while the pockets are read, and Already mine waits (${[...sheets].join(' || ')})`);
		assert.ok(![...panels].some((panel) => panel.startsWith('open') && !panel.endsWith('hidden')), `no panel over the camera while the sheet shows the read (${[...panels].join(' | ')})`);
		assert.ok(closed, 'the sheet was closed while the page was read');
		assert.ok([...panels].some((panel) => /^closed pockets: Reading pocket [1-9] of 9\.$/.test(panel)), `the panel counts pockets once the sheet is closed (${[...panels].join(' | ')})`);
		await page.waitForSelector('#scan-pagegrid', {timeout: 10000});
		assert.ok(await page.$eval('#scan-page-busy', (panel) => panel.hidden), 'the panel goes once the page is read');
		assert.equal(await page.$eval('#scan-page-busy', (panel) => panel.getAttribute('aria-hidden')), 'true', '#scan-note speaks for it');
		assert.match(await text(page, '#scan-note'), /^Page read: 7 cards added(, \d to check)?\. 2 empty pockets skipped\.$/);
		assert.ok(app.workers.some((worker) => worker.endsWith('/js/scan/page-worker.js')), 'the page was read in its worker');

		const items = await trayItems(page);
		const want = LAYOUT.map((key, i) => (key ? {id: CARDS[key], page: i + 1} : null)).filter(Boolean);

		assert.equal(items.length, 7, 'seven cards in the tray');
		assert.equal(await page.locator('#scan-tray li').count(), 7, 'seven tiles');
		assert.deepEqual(items.map((item) => item.page), want.map((one) => one.page), 'in reading order, the empty pockets skipped');

		for (const [i, item] of items.entries()) {
			assert.equal(item.status, 'ready', `pocket ${item.page} read`);
			assert.equal(item.source, 'page', `pocket ${item.page} reported as from a page`);

			if (item.sure) {
				assert.equal(item.card, want[i].id, `pocket ${item.page} is sure only of the right card`);
			}
			else {
				// Not sure: shown for a look, its card among the ones offered.
				assert.ok(item.card === want[i].id || item.candidates.includes(want[i].id), `pocket ${item.page} offers ${want[i].id} (${item.card}; ${item.candidates.join(' ')})`);
			}
		}

		assert.ok(items.filter((item) => item.sure).length >= 3, `most clean cards are sure (${items.filter((item) => item.sure).length})`);
		await page.screenshot({path: `${SHOTS}/scan-page-tray.png`});

		// The tray is the session's: Done offers to save the page's cards
		// once those to check are checked, as for any scan.
		const unsure = items.filter((item) => !item.sure).length;

		assert.equal(await page.locator('#scan-tray .scan-tile[data-status="unsure"]').count(), unsure, 'the unsure pockets ask for a look');

		await close(app);
	});

	test('two pages side by side, taken with the phone turned, are both read, the left page first', async () => {
		const app = await open();
		const {page} = app;
		const notes = new Set();

		await page.goto(url('scan'));
		await page.waitForSelector('#scan-camera-off:not([hidden])');
		await choose(page, spreadPhoto);

		await until(async () => {
			const note = await text(page, '#scan-note');

			notes.add(note);

			return /^(Both pages read|One page read|Page read|The page could not|That looks)/.test(note);
		}, 300000, 'the spread read');

		assert.ok([...notes].some((note) => /^Reading pocket \d+ of 18\.$/.test(note)), `progress counts both pages' pockets (${[...notes].join(' | ')})`);
		assert.match(await text(page, '#scan-note'), /^Both pages read: 15 cards added(, \d+ to check)?\. 3 empty pockets skipped\.$/);

		const items = await trayItems(page);
		const want = [...LAYOUT, ...RIGHT].map((key, i) => (key ? {id: CARDS[key], page: i + 1} : null)).filter(Boolean);

		assert.deepEqual(items.map((item) => item.page), want.map((one) => one.page), 'in reading order, the left page first, the empty pockets skipped');

		for (const [i, item] of items.entries()) {
			if (item.sure) {
				assert.equal(item.card, want[i].id, `pocket ${item.page} is sure only of the right card`);
			}
			else {
				assert.ok(item.card === want[i].id || item.candidates.includes(want[i].id), `pocket ${item.page} offers ${want[i].id} (${item.card}; ${item.candidates.join(' ')})`);
			}
		}

		assert.ok(items.filter((item) => item.sure).length >= 6, `most clean cards are sure (${items.filter((item) => item.sure).length})`);
		await page.screenshot({path: `${SHOTS}/scan-page-spread.png`});

		await close(app);
	});

	test('each pocket\'s own card is cut to its edges from a larger copy of the photo, for its number', async () => {
		const app = await open();
		const {page} = app;
		const photo = (await readFile(pagePhoto)).toString('base64');

		await page.goto(url('scan'));
		await page.waitForSelector('#scan-camera-off:not([hidden])');

		// The page read at 1200 pixels, its pockets' cards cut from the
		// photo as taken (2300 tall), as a 12000 x 5400 still is read at 3840
		// and cut from 7680.
		const pockets = await page.evaluate(async (data) => {
			const {readPagePhoto} = await import('/pokemon-card-tracker/js/scan/page.js');
			const blob = await (await fetch(`data:image/jpeg;base64,${data}`)).blob();
			const found = await readPagePhoto(blob, {fineSide: 4000, maxSide: 1200});

			return found.pockets.filter((pocket) => !pocket.empty).map((pocket) => ({
				card: pocket.card ? {height: pocket.card.height, width: pocket.card.width} : null,
				cut: pocket.image.height,
				first: pocket.quads[0].corners.map((p) => [Math.round(p.x), Math.round(p.y)]),
				quads: pocket.quads.length,
			}));
		}, photo);

		assert.equal(pockets.length, 7, 'seven cards');

		for (const pocket of pockets) {
			assert.ok(pocket.card, 'its own card cut');
			// The cards are 615 pixels tall in the photo, about 330 in the
			// page's copy.
			assert.ok(pocket.card.height > pocket.cut * 1.5, `cut from the larger copy (${pocket.card.height} against a ${pocket.cut} pocket)`);
			assert.ok(Math.abs(pocket.card.width / pocket.card.height - 63 / 88) < 0.01, 'card-shaped');
			assert.ok(pocket.quads >= 2, 'its own outline offered to the picture before the others');
		}

		await close(app);
	});

	// A scanner review, 2026-11-19: decoding a 65 MP photo holds all its
	// pixels for a moment, and the page's copy and the larger one were each
	// decoded from the file. Now the file is decoded once, and the page's
	// copy drawn from the larger one (js/scan/page.js photoBitmaps).
	test('the photo file is decoded once, and the page\'s copy drawn from its larger copy', async () => {
		const app = await open();
		const {page} = app;
		const photo = (await readFile(pagePhoto)).toString('base64');

		await page.goto(url('scan'));
		await page.waitForSelector('#scan-camera-off:not([hidden])');

		const decoded = await page.evaluate(async (data) => {
			const {readPagePhoto} = await import('/pokemon-card-tracker/js/scan/page.js');
			const blob = await (await fetch(`data:image/jpeg;base64,${data}`)).blob();
			const made = [];
			const make = window.createImageBitmap;

			window.createImageBitmap = (source, ...rest) => {
				made.push(source instanceof Blob ? 'file' : 'bitmap');

				return make(source, ...rest);
			};

			try {
				const found = await readPagePhoto(blob, {fineSide: 4000, maxSide: 1200, worker: false});

				return {made, pockets: found.pockets.filter((pocket) => !pocket.empty).length, size: found.size};
			}
			finally {
				window.createImageBitmap = make;
			}
		}, photo);

		assert.deepEqual(decoded.made, ['file', 'bitmap'], 'the file once, then the page\'s copy from that');
		assert.equal(decoded.pockets, 7, 'and the page read as before');
		assert.match(decoded.size, /^\d+ x 1200$|^1200 x \d+$/, `the page's copy within its limits (${decoded.size})`);

		await close(app);
	});

	// A pocket's language read off its text keeps only the prints that exist
	// in it (js/scan/picture.js pictureMatch heldIn): whether TCGdex lists a
	// set in Portuguese is asked once and known from then on, with no signal
	// too (js/catalog.js setHeldIn).
	test('whether a set exists in Portuguese is asked once and known with no signal', async () => {
		const app = await open();
		const {context, page} = app;
		const held = (sets) => page.evaluate(async (ids) => {
			const {setHeldIn} = await import('/pokemon-card-tracker/js/catalog.js');

			return Promise.all(ids.map((id) => setHeldIn('pt', id)));
		}, sets);

		await page.goto(url('scan'));
		await page.waitForSelector('#scan-camera-off:not([hidden])');
		assert.deepEqual(await held(['base2', 'base4', 'lc']), [true, false, false], 'Jungle is listed in Portuguese; Base Set 2 and Legendary Collection are not');

		// No signal: a request that goes out fails (the replayed TCGdex
		// answers would still be served).
		await context.setOffline(true);
		await context.route(/api\.tcgdex\.net/, (route) => route.abort('internetdisconnected'));
		assert.deepEqual(await held(['base2', 'base4', 'neo1']), [true, false, null], 'offline: what was asked is known, a set never asked is not');
		await context.setOffline(false);

		await close(app);
	});

	test('a photo with no page in it says so, asks for another, and adds nothing', async () => {
		const app = await open();
		const {page} = app;

		await page.goto(url('scan'));
		await page.waitForSelector('#scan-camera-off:not([hidden])');
		await choose(page, tablePhoto);

		await until(async () => /could not be found/.test(await text(page, '#scan-note')), 120000, 'the page not found');
		assert.equal(await text(page, '#scan-note'), 'The page could not be found in that photo. Take it again with the page filling the photo.');
		assert.deepEqual(await trayItems(page), [], 'nothing added');
		await page.click('#scan-page-open');
		assert.equal(await page.getAttribute('#scan-page-pick', 'disabled'), null, 'Binder page can be tried again');

		await close(app);
	});
});
