// Browser tests for My Cards' View switch (js/card-view-mode.js,
// css/card-views.css): Large, Grid, Mini, and List, the columns each gives
// on a 384 px phone, a List row's content and link, the choice surviving a
// reload, and nothing wider than a 324 px phone in any view, at normal text
// and at 1.3x text. Headless Chromium against tests/pages-server.mjs,
// signed out, with every outside service faked (tests/my-cards-fixtures.mjs)
// and card images drawn as plain SVG cards.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/card-views-browser.test.mjs
// Screenshots: $SHOTS (default /tmp)/card-views-<view>-<width>[-text130].png

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {CARDS, COPIES, fakeServices, fullRecord, indexRecords, seed} from './my-cards-fixtures.mjs';
import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const SHOTS = process.env.SHOTS || '/tmp';
const PHONE = {height: 800, width: 384};
const NARROW = {height: 720, width: 324};
const VIEWS = ['large', 'grid', 'mini', 'list'];
const VIEW_KEY = 'cardTracker.cardsView';
const TIMEOUT = {timeout: 20000};

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

const plain = (text) => String(text).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

// A second English Pikachu, so a row and a tile show ×2.
const PIKACHU = COPIES.find((copy) => copy.id === 'c-07');
const COPIES_TWO = [...COPIES, {...PIKACHU, created_at: '2026-09-11T12:00:00.000Z', id: 'c-11', price_manual: undefined, updated_at: '2026-09-11T12:00:00.000Z'}];

// Every card has an image but the Korean one, which keeps its card back.
function indexWithImages() {
	const index = indexRecords();

	for (const record of Object.values(index)) {
		if (record.catalog === 'ko') {
			continue;
		}

		for (const localization of Object.values(record.localizations)) {
			localization.image = `https://assets.tcgdex.net/${localization.lang}/${record.set_id}/${record.collector_number}`;
		}
	}

	return index;
}

const HUES = [12, 48, 96, 160, 200, 230, 270, 310, 340];

// A plain card image: a coloured card with its number.
function cardSvg(path) {
	const number = path.split('/').slice(-2, -1)[0] || '?';
	const hue = HUES[Number.parseInt(number, 10) % HUES.length] || 0;

	return `<svg xmlns="http://www.w3.org/2000/svg" width="245" height="342" viewBox="0 0 245 342"><rect width="245" height="342" rx="12" fill="hsl(${hue} 60% 45%)"/><rect x="14" y="40" width="217" height="150" rx="6" fill="hsl(${hue} 70% 80%)"/><text x="122" y="290" font-size="40" font-family="sans-serif" text-anchor="middle" fill="#fff">${number}</text></svg>`;
}

async function phone(viewport = PHONE) {
	const context = await browser.newContext({serviceWorkers: 'block', viewport});

	await fakeServices(context);
	await fakePokeApi(context);
	// After fakeServices, so it answers before that route's 404.
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({body: cardSvg(new URL(route.request().url()).pathname), contentType: 'image/svg+xml'}));

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err.message));

	return {context, errors, page};
}

// The collection, with Pikachu's full record saved so its finish is known.
async function open(page, view = null, {copies = COPIES_TWO} = {}) {
	const pikachu = CARDS.find((card) => card.id === 'tsb2-025');

	await seed(page, server.origin, {
		copies,
		index: indexWithImages(),
		local: view ? {[VIEW_KEY]: view} : {},
		records: {[`card:en:${pikachu.id}`]: {at: Date.now(), data: fullRecord(pikachu)}},
	});
	await page.locator('.card-grid > .tile').first().waitFor(TIMEOUT);
}

async function choose(page, view) {
	await page.selectOption('#cards-view', view);
	await page.waitForFunction((value) => document.querySelector('.card-grid').dataset.view === value, view, TIMEOUT);
	await page.locator('.card-grid > .tile').first().waitFor(TIMEOUT);
}

// The tiles in the first row: those level with the first.
const columns = (page) => page.evaluate(() => {
	const tiles = [...document.querySelectorAll('.card-grid > .tile')];
	const top = tiles[0].getBoundingClientRect().top;

	return tiles.filter((tile) => Math.abs(tile.getBoundingClientRect().top - top) < 1).length;
});

// Every element of the Cards screen inside the viewport, and no sideways
// scroll.
async function fitsWidth(page, where) {
	const wide = await page.evaluate(() => {
		const width = document.documentElement.clientWidth;
		const out = [];

		for (const element of document.querySelectorAll('main, main *')) {
			const box = element.getBoundingClientRect();

			if (box.width && (box.right > width + 0.5 || box.left < -0.5)) {
				out.push(`${element.tagName.toLowerCase()}.${element.className} ${Math.round(box.left)}..${Math.round(box.right)}`);
			}
		}

		if (document.documentElement.scrollWidth > width) {
			out.push(`page scrolls sideways to ${document.documentElement.scrollWidth}`);
		}

		return out.slice(0, 10);
	});

	assert.deepEqual(wide, [], `nothing wider than the screen on ${where}`);
}

// Large text on a phone: every element's font size times factor, all read
// before any is set, so nested sizes are not scaled twice. The root's too,
// so rem minimums grow as they do with the phone's text size.
async function scaleText(page, factor) {
	await page.evaluate((by) => {
		const elements = [document.documentElement, ...document.querySelectorAll('body, body *')];
		const sizes = elements.map((element) => parseFloat(getComputedStyle(element).fontSize));

		elements.forEach((element, i) => element.style.setProperty('font-size', `${sizes[i] * by}px`, 'important'));
	}, factor);
	// The grid reflows, and images settle.
	await page.waitForTimeout(300);
}

async function shoot(page, name) {
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.screenshot({fullPage: true, path: `${SHOTS}/card-views-${name}.png`});
}

describe('the View switch', () => {
	test('switches between Large, Grid, Mini, and List, with each view\'s columns at 384 px', async () => {
		const {context, errors, page} = await phone();

		try {
			await open(page);

			assert.equal(await page.inputValue('#cards-view'), 'grid', 'Grid is the default');
			assert.equal(await page.getAttribute('#cards-view', 'aria-label'), 'View');
			assert.deepEqual(await page.locator('#cards-view option').allTextContents(), ['View: Large', 'View: Grid', 'View: Mini', 'View: List']);
			assert.equal(await page.locator('.fb-row #cards-view').count(), 1, 'in the row with Sort and Filters');
			assert.equal(await columns(page), 3, 'Grid: three a row');

			const total = await page.locator('.card-grid > .tile').count();

			await choose(page, 'large');
			assert.equal(await columns(page), 2, 'Large: two a row');
			assert.equal(await page.locator('.card-grid > .tile').count(), total, 'the same cards in every view');

			const pikachu = page.locator('.card-grid > .tile[href$="cards/en/tsb2-025"]');

			assert.equal(plain(await pikachu.locator('.tile-name').textContent()), 'Pikachu');
			assert.equal(plain(await pikachu.locator('.tile-meta').textContent()), '025 / 120', 'the number as printed');
			assert.equal(plain(await pikachu.locator('.tile-price').textContent()), 'R$ 80,00');
			assert.equal(await pikachu.locator('.badge-qty').textContent(), '×2');

			await choose(page, 'mini');

			const mini = await columns(page);

			assert.ok(mini === 5 || mini === 6, `Mini: five or six a row (${mini})`);
			assert.equal(await page.locator('.card-grid .tile-name:visible, .card-grid .tile-meta:visible, .card-grid .tile-price:visible').count(), 0, 'no caption');
			assert.equal(await pikachu.locator('.badge-qty').textContent(), '×2', 'the count stays');
			assert.equal(await pikachu.getAttribute('aria-label'), 'Pikachu, 025 of 120, Test Beta, English, 2 copies', 'named without its caption');

			// The Portuguese Test Ball, viewed in English.
			const ball = page.locator('.card-grid > .tile[href$="/tsa1-150"]');

			assert.equal(await ball.count(), 1);
			assert.ok(await ball.locator('.badge-lang').isVisible(), 'the language chip stays');

			await choose(page, 'list');
			assert.equal(await columns(page), 1, 'List: one a row');
			await choose(page, 'grid');
			assert.equal(await columns(page), 3);
			assert.deepEqual(errors, []);
		}
		finally {
			await context.close();
		}
	});

	test('a List row names the card, set, number, language, finish, copies, and value, and opens the card', async () => {
		const {context, errors, page} = await phone();

		try {
			await open(page, 'list');

			const row = page.locator('.card-grid > .card-row[href$="cards/en/tsb2-025"]');

			await row.waitFor(TIMEOUT);
			assert.equal(plain(await row.locator('.tile-name').textContent()), 'Pikachu');
			assert.equal(plain(await row.locator('.tile-price').textContent()), 'R$ 80,00');
			assert.equal(plain(await row.locator('.tile-meta').textContent()), 'Test Beta · 025 / 120');
			assert.deepEqual((await row.locator('.row-fact').allTextContents()).map(plain), ['EN', 'Normal', '×2']);
			assert.ok(await row.locator('.art-wrap img').count(), 'a thumbnail');
			assert.equal(plain(await row.getAttribute('aria-label')), 'Pikachu, 025 of 120, Test Beta, English, Normal, 2 copies, R$ 80,00');

			// A card with no price at all says so, and a single copy shows no ×1.
			const korean = page.locator('.card-grid > .card-row[href$="cards/ko/TSK1-001"]');

			assert.equal(plain(await korean.locator('.tile-price').textContent()), 'No price');
			assert.deepEqual((await korean.locator('.row-fact').allTextContents()).map(plain), ['KO']);
			assert.match(await korean.getAttribute('aria-label'), /^Bulbasaur, 001 of 100, .+, Korean, 1 copy, no price$/);

			// Rows are at least a touch target tall.
			const short = await page.evaluate(() => [...document.querySelectorAll('.card-row')].filter((one) => one.getBoundingClientRect().height < 48).length);

			assert.equal(short, 0);

			await row.click();
			await page.waitForURL(/\/cards\/en\/tsb2-025$/, TIMEOUT);
			assert.deepEqual(errors, []);
		}
		finally {
			await context.close();
		}
	});

	test('a copy with no language says "Language not set" in its List row, never "NULL", and in no view shows "NULL"', async () => {
		const {context, errors, page} = await phone();
		// Sprigatito saved with no language, as an old import can leave it.
		const copies = COPIES_TWO.map((copy) => (copy.id === 'c-08' ? {...copy, language: null} : copy));

		try {
			await open(page, 'list', {copies});

			const row = page.locator('.card-grid > .card-row[href$="cards/en/tsb2-090"]');

			await row.waitFor(TIMEOUT);
			assert.deepEqual((await row.locator('.row-fact').allTextContents()).map(plain), ['Language not set']);
			assert.equal(await row.locator('.flags').count(), 0, 'no empty flag group');
			assert.match(await row.getAttribute('aria-label'), /^Sprigatito, 090 of 120, Test Beta, Language not set, 1 copy/);

			for (const view of VIEWS) {
				await choose(page, view);

				const tile = page.locator('.card-grid > .tile[href$="cards/en/tsb2-090"]');

				assert.doesNotMatch(await tile.evaluate((element) => `${element.textContent} ${element.getAttribute('aria-label') || ''}`), /null/i, `no "NULL" in ${view}`);
			}

			assert.deepEqual(errors, []);
		}
		finally {
			await context.close();
		}
	});

	test('a List row keeps its element and the focus when its price arrives', async () => {
		const {context, errors, page} = await phone();
		// Charizard's price waits until released, after the row is drawn
		// and focused. Routed after phone()'s, so it answers first.
		let release;
		let asked;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		const requested = new Promise((resolve) => {
			asked = resolve;
		});

		await context.route('https://api.tcgdex.net/**', async (route) => {
			if (/\/cards\/tsa1-006$/.test(new URL(route.request().url()).pathname)) {
				asked();
				await gate;
			}

			return route.fallback();
		});

		try {
			await open(page, 'list');
			await requested;

			const row = page.locator('.card-grid > .card-row[href$="cards/en/tsa1-006"]');

			await row.waitFor(TIMEOUT);

			const element = await row.elementHandle();

			await element.focus();
			assert.equal(await row.locator('.tile-price').count(), 0, 'no price yet');
			assert.deepEqual((await row.locator('.row-fact').allTextContents()).map(plain), ['EN']);
			assert.doesNotMatch(await row.getAttribute('aria-label'), /estimate/);

			release();
			await row.locator('.tile-price').waitFor(TIMEOUT);

			assert.ok(await element.evaluate((one) => one.isConnected), 'the same row, not one drawn again');
			assert.ok(await element.evaluate((one) => document.activeElement === one), 'the focus stays on it');
			assert.match(plain(await row.locator('.row-head .tile-price').textContent()), /^~R\$ 150/);
			assert.deepEqual((await row.locator('.row-fact').allTextContents()).map(plain), ['EN', 'Normal'], 'the finish its record names');
			assert.match(await row.getAttribute('aria-label'), /^Charizard ex, 006 of 160, .+, English, Normal, 1 copy, about .+, US market estimate$/);
			assert.deepEqual(errors, []);
		}
		finally {
			release();
			await context.close();
		}
	});

	test('the choice survives a reload', async () => {
		const {context, errors, page} = await phone();

		try {
			await open(page);
			await choose(page, 'list');
			assert.equal(await page.evaluate((key) => localStorage.getItem(key), VIEW_KEY), 'list');

			await page.reload();
			await page.locator('.card-grid > .card-row').first().waitFor(TIMEOUT);
			assert.equal(await page.inputValue('#cards-view'), 'list');
			assert.equal(await page.locator('.card-grid').getAttribute('data-view'), 'list');

			await choose(page, 'mini');
			await page.reload();
			await page.locator('.card-grid > .tile').first().waitFor(TIMEOUT);
			assert.equal(await page.inputValue('#cards-view'), 'mini');
			assert.equal(await page.locator('.card-grid').getAttribute('data-view'), 'mini');
			assert.deepEqual(errors, []);
		}
		finally {
			await context.close();
		}
	});

	test('a stored value that is not a view shows the Grid', async () => {
		const {context, errors, page} = await phone();

		try {
			await open(page, 'poster');
			assert.equal(await page.inputValue('#cards-view'), 'grid');
			assert.equal(await page.locator('.card-grid').getAttribute('data-view'), 'grid');
			assert.deepEqual(errors, []);
		}
		finally {
			await context.close();
		}
	});
});

describe('every view fits a narrow phone', () => {
	test('at 384 x 800, nothing is wider than the screen in any view', async () => {
		const {context, errors, page} = await phone(PHONE);

		try {
			await open(page);

			for (const view of VIEWS) {
				await choose(page, view);
				await page.waitForTimeout(300);
				await fitsWidth(page, `${view} at 384 px`);
				await shoot(page, `${view}-384`);
			}

			assert.deepEqual(errors, []);
		}
		finally {
			await context.close();
		}
	});

	test('at 324 x 720, nothing is wider than the screen in any view, at normal and 1.3x text', async () => {
		const {context, errors, page} = await phone(NARROW);

		try {
			await open(page);

			for (const view of VIEWS) {
				await choose(page, view);
				await page.waitForTimeout(300);
				await fitsWidth(page, `${view} at 324 px`);
				await shoot(page, `${view}-324`);
			}

			// Large text, as on Eric's Realme: each view opened afresh, then
			// scaled once.
			for (const view of VIEWS) {
				await page.evaluate(({key, value}) => localStorage.setItem(key, value), {key: VIEW_KEY, value: view});
				await page.reload();
				await page.locator('.card-grid > .tile').first().waitFor(TIMEOUT);
				await page.waitForTimeout(300);
				await scaleText(page, 1.3);
				await fitsWidth(page, `${view} at 324 px with 1.3x text`);
				await shoot(page, `${view}-324-text130`);
			}

			assert.deepEqual(errors, []);
		}
		finally {
			await context.close();
		}
	});
});
