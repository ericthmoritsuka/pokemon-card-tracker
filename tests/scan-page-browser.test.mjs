// Browser tests for the scanner's Binder page (js/scan/page.js,
// js/scan/view.js readPage): a whole 3 x 3 binder page from one still
// photo. Binder page heads the scanner's settings sheet; a photo chosen
// there is found and cut into pockets off the main thread, and each pocket
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

// Chooses `file` through Binder page's Choose a photo, as a tap does.
async function choose(page, file) {
	await page.click('#scan-settings-open');
	await page.waitForSelector('#scan-settings #scan-page');

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

	test('Binder page heads the settings: how to take the photo, and the camera or the gallery', async () => {
		const app = await open();
		const {page} = app;

		await page.goto(url('scan'));
		await page.waitForSelector('#scan-camera-off:not([hidden])');
		assert.equal(await text(page, '#scan-photo-open'), 'Pick a photo', 'the single-card photo stays as it was');
		assert.equal(await page.locator('.scan-tray-head #scan-page-take, .scan-tray-head #scan-page-pick').count(), 0, 'nothing added to the tray row');

		await page.click('#scan-settings-open');
		await page.waitForSelector('#scan-settings #scan-page');
		assert.equal(await page.$eval('#scan-settings .scan-sheet-body > .scan-field', (field) => field.id), 'scan-page', 'first in the settings');
		assert.equal(await text(page, '#scan-page-label'), 'Binder page');
		assert.equal(await text(page, '#scan-page-help'), 'Add a whole page of cards from one photo, or two pages side by side, filling the photo. Hold the phone flat over it, no zoom, a lamp to the side.');
		assert.equal(await text(page, '#scan-page-take'), 'Take a photo');
		assert.equal(await text(page, '#scan-page-pick'), 'Choose a photo');
		assert.equal(await page.getAttribute('#scan-page-camera', 'capture'), 'environment', 'Take a photo opens the camera');
		assert.equal(await page.getAttribute('#scan-page-gallery', 'capture'), null, 'Choose a photo opens the gallery');
		await page.screenshot({path: `${SHOTS}/scan-page-sheet.png`});

		await page.click('#scan-sheet-close');
		await page.waitForSelector('#scan-settings', {state: 'detached'});

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
		assert.match(await text(page, '#scan-pagegrid-line'), /^7 cards(, \d to check)?\. Tap a card to check it or change it\.$/);
		await page.waitForTimeout(400);
		await page.screenshot({path: `${SHOTS}/scan-page-grid.png`});

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
			const [a1, a2, b1] = await collection.addCards([copy(cards.a), copy(cards.a), copy(cards.b)]);
			const old = await binders.createBinder({cols: 3, name: 'Binder A', page_count: 1, rows: 3});

			await binders.placeCard(old.id, 1, 5, b1.id);

			return {a1: a1.id, a2: a2.id, b1: b1.id, old: old.id};
		}, CARDS);

		await choose(page, pagePhoto);
		await page.waitForSelector('#scan-pagegrid', {timeout: 300000});
		await until(async () => /^Page read/.test(await text(page, '#scan-note')), 300000, 'the page read');
		await page.click('#scan-page-mine');
		await until(async () => !/Finding/.test(await text(page, '#scan-place-line')), 30000, 'his copies read');

		const tray = await page.evaluate(async () => (await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession()).items.length);

		assert.equal(tray, 0, 'the page\'s cards left the tray, so Done cannot add them');
		assert.equal(await page.getAttribute('#scan-page-mine', 'aria-pressed'), 'true');
		assert.equal(await text(page, '#scan-place-line'), '3 cards from your cards, 1 of them taken from the pocket it is in now; 4 placeholders for cards you have none left of. Tap a card to pick another copy.');

		const wheres = await page.$$eval('#scan-page-grid-1 > li', (nodes) => nodes.map((node) => (node.classList.contains('scan-page-empty') ? 'empty' : node.querySelector('.scan-page-where').textContent)));

		assert.deepEqual(wheres, ['Loose', 'Binder A, p. 1', 'Not yours: placeholder', 'Not yours: placeholder', 'empty', 'Loose', 'Not yours: placeholder', 'Not yours: placeholder', 'empty']);
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
		assert.deepEqual(app.errors, []);
		await close(app);
	});

	test('each pocket with a card joins the tray, sure or asking for a look, and empty pockets are skipped', async () => {
		const app = await open();
		const {page} = app;
		const notes = new Set();
		// The panel over the camera while the page is read (Eric,
		// 2026-11-19: no sign of anything working): what it said, and
		// whether its bar ran (finding) or filled (pockets).
		const panels = new Set();

		await page.goto(url('scan'));
		await page.waitForSelector('#scan-camera-off:not([hidden])');
		assert.ok(await page.$eval('#scan-page-busy', (panel) => panel.hidden), 'no panel before a page');
		await choose(page, pagePhoto);
		await page.waitForSelector('#scan-page-busy:not([hidden])', {timeout: 10000});
		await page.screenshot({path: `${SHOTS}/scan-page-busy.png`});

		await until(async () => {
			const note = await text(page, '#scan-note');
			const panel = await page.$eval('#scan-page-busy', (node) => (node.hidden ? 'hidden' : `${node.classList.contains('is-finding') ? 'finding' : 'pockets'}: ${node.querySelector('#scan-page-step').textContent}`));

			notes.add(note);
			panels.add(panel);

			return /^Page read/.test(note);
		}, 300000, 'the page read');

		assert.ok([...notes].some((note) => /^Reading pocket [1-9] of 9\.$/.test(note)), `progress shown (${[...notes].join(' | ')})`);
		assert.ok(panels.has('finding: Finding the page and its pockets. A large photo takes a few seconds.'), `the panel while the page is found (${[...panels].join(' | ')})`);
		assert.ok([...panels].some((panel) => /^pockets: Reading pocket [1-9] of 9\.$/.test(panel)), `the panel counts pockets (${[...panels].join(' | ')})`);
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

	test('a photo with no page in it says so, asks for another, and adds nothing', async () => {
		const app = await open();
		const {page} = app;

		await page.goto(url('scan'));
		await page.waitForSelector('#scan-camera-off:not([hidden])');
		await choose(page, tablePhoto);

		await until(async () => /could not be found/.test(await text(page, '#scan-note')), 120000, 'the page not found');
		assert.equal(await text(page, '#scan-note'), 'The page could not be found in that photo. Take it again with the page filling the photo.');
		assert.deepEqual(await trayItems(page), [], 'nothing added');
		await page.click('#scan-settings-open');
		assert.equal(await page.getAttribute('#scan-page-pick', 'disabled'), null, 'Binder page can be tried again');

		await close(app);
	});
});
