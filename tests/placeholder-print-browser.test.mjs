// Browser tests for printing placeholders (js/placeholder-print-view.js,
// js/placeholder-print.js, css/placeholder-print.css; from a survey of
// other binder apps, 2026-11-19): a seeded hand-made binder, Print
// placeholders, the choices (page on screen or all pages, filled pockets
// or not) with the number of cards and sheets, Print waiting for every
// picture before window.print() (stubbed), and in print media each card at
// 63 x 88 mm with only the sheets showing. Then Back closes it, and on a
// 360 px phone the preview fits the width. Headless Chromium against
// tests/pages-server.mjs, signed out.
//
// Every outside service is faked: TCGdex answers 404 except one card's
// large image, PokeAPI's names come from tests/fake-pokeapi.mjs, and its
// sprite repository answers a tiny PNG for Pikachu's artwork (late, to
// prove Print waits) and Charizard's sprite (its artwork 404, to prove the
// fallback), 404 for the rest. Supabase and ligapokemon.com.br are never
// contacted. Cards and binders are invented.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/placeholder-print-browser.test.mjs
// Screenshots: /tmp/placeholder-print-*.png

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {fakeRates} from './fake-rates.mjs';
import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const WIDE = {height: 900, width: 1100};
const PHONE = {height: 740, width: 360};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const MM = 96 / 25.4;

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

async function open(viewport = WIDE) {
	const context = await browser.newContext({serviceWorkers: 'block', viewport});
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
	await fakeRates(context);
	await context.route('https://api.tcgdex.net/**', (route) => route.fulfill({body: '{}', contentType: 'application/json', status: 404}));
	await context.route('https://assets.tcgdex.net/**', (route) => (route.request().url().endsWith('/tst9-002/high.webp')
		? route.fulfill({body: PNG, contentType: 'image/png', status: 200})
		: route.fulfill({status: 404})));
	await context.route('https://raw.githubusercontent.com/**', async (route) => {
		const path = new URL(route.request().url()).pathname;

		if (path.endsWith('/official-artwork/25.png')) {
			await new Promise((resolve) => setTimeout(resolve, 600));

			return route.fulfill({body: PNG, contentType: 'image/png', status: 200});
		}

		if (path === '/PokeAPI/sprites/master/sprites/pokemon/6.png') {
			return route.fulfill({body: PNG, contentType: 'image/png', status: 200});
		}

		return route.fulfill({status: 404});
	});
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

// Album, 3 x 3, 2 pages. Page 1: a card placeholder with no picture
// anywhere (1), Pikachu (2), Charizard (3), a card placeholder with its
// image (4), a copy owned (5), a pocket left empty on purpose (6). Page 2:
// nine Pokémon placeholders, #010 to #018, none with a picture.
const seed = (page) => page.evaluate(async () => {
	const collection = await import('/pokemon-card-tracker/js/collection.js');
	const binders = await import('/pokemon-card-tracker/js/binders.js');
	const owned = (await collection.addCard({card_id: 'tst9-003', catalog: 'international', language: 'en', language_source: 'manual'})).id;
	const album = await binders.createBinder({cols: 3, cover_color: '#1d2e60', name: 'Album', page_count: 2, rows: 3});
	const pokemon = (dex, name) => ({card_id: null, catalog: null, dex, image: null, name, variant_id: null});
	const pockets = [
		{page: 1, position: 2, want: pokemon(25, 'Pikachu')},
		{page: 1, position: 3, want: pokemon(6, 'Charizard')},
		...Array.from({length: 9}, (_, i) => ({page: 2, position: i + 1, want: pokemon(10 + i, `Testmon ${10 + i}`)})),
	];

	await binders.placePlaceholder(album.id, 1, 1, {card_id: 'tst9-001', catalog: 'international', name: 'Inventmon'});
	await binders.changeBinders((doc) => binders.layOutWants(doc.binders, {binderId: album.id, pockets}));
	await binders.placePlaceholder(album.id, 1, 4, {card_id: 'tst9-002', catalog: 'international', image: 'https://assets.tcgdex.net/en/tst9/tst9-002', name: 'Fakeachu'});
	await binders.placeCard(album.id, 1, 5, owned);
	await binders.leaveEmpty(album.id, 1, 6);

	return album.id;
});

const counts = (page) => page.evaluate(() => ({
	cards: document.querySelectorAll('#pp-sheets .pp-card').length,
	sheets: document.querySelectorAll('#pp-sheets .pp-sheet').length,
	summary: document.querySelector('#pp-summary').textContent,
}));

const waitCards = (page, n) => page.waitForFunction((want) => document.querySelectorAll('#pp-sheets .pp-card').length === want, n);

describe('Print placeholders', () => {
	test('the choices, Print after the pictures load, and real card size on paper', async () => {
		const {done, page} = await open();
		const id = await seed(page);

		await page.goto(url(`binders/${id}`));
		await page.waitForSelector('#binder-spread button.pocket[data-page="1"][data-position="4"][data-kind="want"]');
		await page.click('#binder-print');
		await page.waitForSelector('#pp-view');

		// The page on screen (page 1 alone), filled pockets skipped: four
		// cards, in pocket order, on one sheet.
		assert.equal(await page.locator('#pp-view .pp-choice label').first().textContent(), 'Page 1');
		assert.deepEqual(await counts(page), {cards: 4, sheets: 1, summary: '4 cards on 1 sheet.'});
		assert.deepEqual(await page.locator('#pp-sheets .pp-card').evaluateAll((cards) => cards.map((card) => [
			card.dataset.position,
			card.querySelector('.pp-dex').textContent,
			card.querySelector('.pp-name').textContent,
			card.querySelector('.pp-where').textContent,
			card.querySelector('.pp-binder').textContent,
		])), [
			['1', '', 'Inventmon', 'Page 1, pocket 1', 'Album'],
			['2', '#025', 'Pikachu', 'Page 1, pocket 2', 'Album'],
			['3', '#006', 'Charizard', 'Page 1, pocket 3', 'Album'],
			['4', '', 'Fakeachu', 'Page 1, pocket 4', 'Album'],
		]);

		// The copy owned too.
		await page.check('#pp-filled');
		await waitCards(page, 5);
		assert.deepEqual(await counts(page), {cards: 5, sheets: 1, summary: '5 cards on 1 sheet.'});
		assert.equal(await page.locator('#pp-sheets .pp-card').nth(4).getAttribute('data-position'), '5');
		await page.uncheck('#pp-filled');

		// Every page: nine and four on two sheets.
		await page.check('#pp-view input[name="pp-pages"][value="all"]');
		await waitCards(page, 13);
		assert.deepEqual(await counts(page), {cards: 13, sheets: 2, summary: '13 cards on 2 sheets.'});
		assert.deepEqual(await page.locator('#pp-sheets .pp-sheet').evaluateAll((sheets) => sheets.map((sheet) => sheet.querySelectorAll('.pp-card').length)), [9, 4]);
		assert.equal(await page.locator('#pp-sheets .pp-card').last().locator('.pp-where').textContent(), 'Page 2, pocket 9');

		// Print waits for Pikachu's late artwork, then prints once.
		await page.evaluate(() => {
			window.printedWith = [];
			window.print = () => window.printedWith.push([...document.querySelectorAll('#pp-sheets img')].map((img) => img.complete && img.naturalWidth > 0));
		});
		await page.click('#pp-print');
		await page.waitForFunction(() => window.printedWith.length === 1);
		assert.deepEqual(await page.evaluate(() => window.printedWith), [[true, true, true]], 'three pictures, every one loaded when the printer is asked');

		// The pictures: the card's large image, the official artwork, the
		// sprite when the artwork is missing, and plain text with no picture.
		const art = (position, pg = 1) => page.locator(`#pp-sheets .pp-card[data-page="${pg}"][data-position="${position}"] .pp-art`);

		assert.equal(await art(1).locator('img').count(), 0);
		assert.equal(await art(1).textContent(), '?');
		assert.match(await art(2).locator('img').getAttribute('src'), /\/official-artwork\/25\.png$/);
		assert.match(await art(3).locator('img').getAttribute('src'), /\/sprites\/pokemon\/6\.png$/);
		assert.match(await art(4).locator('img').getAttribute('src'), /\/tst9-002\/high\.webp$/);
		assert.equal(await art(1, 2).textContent(), '#010');
		await page.screenshot({fullPage: true, path: '/tmp/placeholder-print-screen.png'});

		// On paper: only the sheets, each card 63 x 88 mm, a sheet 189 mm
		// wide, a page break after each sheet but the last.
		await page.emulateMedia({media: 'print'});

		const paper = await page.evaluate(() => {
			const box = (el) => el.getBoundingClientRect();
			const cards = [...document.querySelectorAll('#pp-sheets .pp-card')].map((card) => [box(card).width, box(card).height]);
			const sheets = [...document.querySelectorAll('#pp-sheets .pp-sheet')];

			return {
				bar: getComputedStyle(document.querySelector('.pp-bar')).display,
				breaks: sheets.map((sheet) => getComputedStyle(sheet).breakAfter),
				cards,
				main: getComputedStyle(document.querySelector('main')).display,
				sheet: box(sheets[0]).width,
				tabs: getComputedStyle(document.querySelector('nav.tabs')).display,
			};
		});

		assert.equal(paper.cards.length, 13);

		for (const [width, height] of paper.cards) {
			assert.ok(Math.abs(width - (63 * MM)) < 0.5, `card width ${width / MM} mm`);
			assert.ok(Math.abs(height - (88 * MM)) < 0.5, `card height ${height / MM} mm`);
		}

		assert.ok(Math.abs(paper.sheet - (189 * MM)) < 0.5, `sheet width ${paper.sheet / MM} mm`);
		assert.deepEqual(paper.breaks, ['page', 'auto']);
		assert.deepEqual([paper.bar, paper.main, paper.tabs], ['none', 'none', 'none']);
		await page.screenshot({fullPage: true, path: '/tmp/placeholder-print-paper.png'});
		await page.emulateMedia({media: 'screen'});

		// Back closes it and leaves the binder as it was.
		await page.goBack();
		await page.waitForSelector('#pp-view', {state: 'detached'});
		assert.equal(await page.locator('#binder-title').textContent(), 'Album');
		assert.equal(await page.evaluate(() => document.body.classList.contains('pp-open')), false);

		await done();
	});

	test('on a 360 px phone the preview fits the width, and Close closes it', async () => {
		const {done, page} = await open(PHONE);
		const id = await seed(page);

		await page.goto(url(`binders/${id}`));
		await page.waitForSelector('#binder-print');
		await page.click('#binder-print');
		await page.waitForSelector('#pp-view');
		await waitCards(page, 4);

		const fit = await page.evaluate(() => {
			const view = document.querySelector('#pp-view');
			const sheet = document.querySelector('.pp-sheet').getBoundingClientRect();
			const close = document.querySelector('#pp-close').getBoundingClientRect();

			return {close: close.height, overflow: view.scrollWidth - view.clientWidth, right: sheet.right, width: window.innerWidth};
		});

		assert.ok(fit.overflow <= 0, `no sideways scroll (${fit.overflow} px over)`);
		assert.ok(fit.right <= fit.width, `the sheet ends at ${fit.right} of ${fit.width} px`);
		assert.ok(fit.close >= 44, 'Close is a full touch target');
		await page.screenshot({fullPage: false, path: '/tmp/placeholder-print-phone.png'});

		await page.click('#pp-close');
		await page.waitForSelector('#pp-view', {state: 'detached'});
		await done();
	});
});
