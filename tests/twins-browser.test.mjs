// Browser test for the international twin picker (js/twins-view.js) in
// headless Chromium at 360 x 740, against tests/twins-harness.mjs served by
// tests/pages-server.mjs. Nothing leaves localhost: card images are real
// TCGdex English low.webp files fetched once by Node and served from memory
// (a drawn stand-in when there is no network), and any other outside request
// fails the test. No Supabase is involved.
//
// The last tests open the real app, with invented Japanese cards and their
// twins saved on the device, to check that My Cards and card detail show
// them: TCGdex and PokeAPI are faked, and Supabase is never asked.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/twins-browser.test.mjs

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {startPagesServer} from './pages-server.mjs';
import {CANDIDATES, HARNESS_PATH, routeHarness} from './twins-harness.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const VIEWPORT = {height: 740, width: 360};
const SHOTS = process.env.SHOTS || '/tmp';

let server;
let browser;
const images = {};

before(async () => {
	server = await startPagesServer();
	browser = await chromium.launch();

	for (const {image} of CANDIDATES) {
		try {
			const response = await fetch(`${image}/low.webp`);

			if (response.ok) {
				images[image] = {body: Buffer.from(await response.arrayBuffer()), type: 'image/webp'};
			}
		}
		catch {
			// The stand-in is used.
		}
	}

	if (Object.keys(images).length < CANDIDATES.length) {
		console.log('# Some TCGdex images were not reachable: drawn stand-ins are used.');
	}
});

after(async () => {
	await browser.close();
	await server.close();
});

async function open(context, card) {
	const page = await context.newPage();
	const outside = await routeHarness(page, {images});
	const errors = [];

	page.on('pageerror', (err) => errors.push(err.message));
	await page.goto(`${server.origin}${HARNESS_PATH}?card=${card}`);
	await page.waitForFunction(() => window.harnessReady);

	return {errors, outside, page};
}

describe('the twin picker', () => {
	test('shows the candidates side by side, saves "This one", and stays answered', async () => {
		const context = await browser.newContext({viewport: VIEWPORT});
		const {errors, outside, page} = await open(context, 'M3-068');
		const picker = page.locator('.tw-confirm');

		await picker.waitFor();
		assert.equal(await page.locator('.tw-title').textContent(), 'Which is the international print?');

		const options = page.locator('.tw-option');

		assert.equal(await options.count(), 3);
		assert.deepEqual(await page.locator('.tw-name').allTextContents(), CANDIDATES.map((c) => c.name));
		assert.equal(await page.getByRole('button', {name: /^This one/}).count(), 3);
		assert.equal(await page.getByRole('button', {name: 'None of these'}).count(), 1);

		// Every image drawn, side by side on one row, the buttons at least
		// 44 px tall, and no sideways scroll at 360 px.
		await page.waitForFunction(() => [...document.querySelectorAll('img.tw-image')].every((img) => img.complete && img.naturalWidth > 0));

		const boxes = await options.evaluateAll((items) => items.map((item) => item.getBoundingClientRect().toJSON()));

		assert.ok(boxes.every((box) => Math.abs(box.top - boxes[0].top) < 1), 'one row');
		assert.ok(boxes[0].right <= boxes[1].left && boxes[1].right <= boxes[2].left, 'side by side');

		for (const box of await page.locator('.tw-pick').evaluateAll((buttons) => buttons.map((b) => b.getBoundingClientRect().height))) {
			assert.ok(box >= 44, `button height ${box}`);
		}

		assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll');
		assert.equal(await page.evaluate(() => window.harness.image()), null, 'no twin before the pick');

		await page.screenshot({fullPage: true, path: `${SHOTS}/twins-picker.png`});

		await page.getByRole('button', {name: 'This one: Antique Jaw Fossil, Perfect Order 068'}).click();
		await page.locator('.tw-confirm').waitFor({state: 'detached'});
		assert.equal(await page.getByRole('status').textContent(), 'Saved: Antique Jaw Fossil is the international print.');
		assert.equal(await page.evaluate(() => window.harness.image()), 'https://assets.tcgdex.net/en/me/me03/068/high.webp');
		assert.equal(await page.evaluate(() => window.harness.name()), 'Antique Jaw Fossil');

		const [decision] = await page.evaluate(() => window.harness.decisions());

		assert.equal(decision.card_id, 'M3-068');
		assert.equal(decision.choice, 'confirmed');
		assert.equal(decision.twin.id, 'me03-068');

		// Opened again, the card asks nothing.
		await page.reload();
		await page.waitForFunction(() => window.harnessReady);
		await page.waitForTimeout(300);
		assert.equal(await page.locator('.tw-confirm').count(), 0);
		assert.equal(await page.locator('.tw-block').isHidden(), true);

		assert.deepEqual(errors, []);
		assert.deepEqual(outside, [], 'no request left localhost');
		await context.close();
	});

	test('"None of these" saves a rejection and shows no twin, in the dark scheme too', async () => {
		const context = await browser.newContext({colorScheme: 'dark', viewport: VIEWPORT});
		const {errors, outside, page} = await open(context, 'M3-069');

		await page.locator('.tw-confirm').waitFor();
		await page.screenshot({fullPage: true, path: `${SHOTS}/twins-picker-dark.png`});

		const colors = await page.locator('.tw-confirm').evaluate((el) => {
			const style = getComputedStyle(el);

			return {background: style.backgroundColor, text: getComputedStyle(el.querySelector('.tw-title')).color};
		});

		assert.notEqual(colors.background, 'rgb(255, 255, 255)', 'the panel follows the dark scheme');

		await page.getByRole('button', {name: 'None of these'}).click();
		await page.locator('.tw-confirm').waitFor({state: 'detached'});
		assert.equal(await page.getByRole('status').textContent(), 'Saved: no international print for now.');
		assert.equal(await page.evaluate(() => window.harness.image()), null);

		const [decision] = await page.evaluate(() => window.harness.decisions());

		assert.equal(decision.choice, 'rejected');
		assert.deepEqual(decision.rejected_ids, CANDIDATES.map((c) => c.id));

		assert.deepEqual(errors, []);
		assert.deepEqual(outside, []);
		await context.close();
	});
});

// ------------------------------------------------------------- in the app

const APP = '/pokemon-card-tracker/';
const AT = '2026-09-01T00:00:00.000Z';

// An invented Japanese set: a Trainer and a Pokémon with a confident twin,
// and a Trainer the matcher was unsure about. The catalog has no images for
// them, as for many Japanese sets.
const JA_SET = {
	cardCount: {official: 80, total: 80},
	cards: [
		{id: 'tstj1-001', image: null, localId: '001', name: '試験の道具'},
		{id: 'tstj1-002', image: null, localId: '002', name: 'テストモン7'},
		{id: 'tstj1-003', image: null, localId: '003', name: '試験の化石'},
	],
	id: 'tstj1',
	name: 'テストセット',
	releaseDate: '2026-01-01',
};

const twin = (id, name, category) => ({category, id, image: `https://assets.tcgdex.net/en/tst/tst9/${id.slice(-3)}`, localId: id.slice(-3), name, setId: 'tst9', setName: 'Test Set Nine'});

const RESULTS = {
	'ja|tstj1-001': {candidates: [twin('tst9-050', 'Test Gadget', 'Trainer')], category: 'Trainer', status: 'confident'},
	'ja|tstj1-002': {candidates: [twin('tst9-007', 'Testmon 7', 'Pokemon')], category: 'Pokemon', status: 'confident'},
	'ja|tstj1-003': {candidates: [twin('tst9-061', 'Test Fossil A', 'Trainer'), twin('tst9-062', 'Test Fossil B', 'Trainer')], category: 'Trainer', status: 'ambiguous'},
};

const copy = (id, fields) => ({catalog: 'ja', created_at: AT, deleted_at: null, id, language_source: 'import', updated_at: AT, ...fields});

const COPIES = [
	copy('j1', {card_id: 'tstj1-001', language: 'ja'}),
	copy('j2', {card_id: 'tstj1-002', language: 'ja'}),
	copy('j3', {card_id: 'tstj1-003', language: 'ja'}),
	// A Korean copy on the Japanese record, with the names the source gave it.
	copy('k1', {card_id: 'tstj1-001', fallback: true, import_key: 'monprice|t_kr_001|ko|NORMAL|0', language: 'ko', name_local: '시험 도구', set_name_local: '시험 세트'}),
];

const STAND_IN_CARD = '<svg xmlns="http://www.w3.org/2000/svg" width="245" height="342"><rect width="245" height="342" fill="#1d2e60"/></svg>';

// Fakes TCGdex and PokeAPI for the app. Counts GraphQL requests to TCGdex
// (none should go: every seeded result is settled) and anything else that
// leaves localhost apart from the exchange rates, which is refused.
async function appContext() {
	const context = await browser.newContext({serviceWorkers: 'block', viewport: VIEWPORT});
	const seen = {graphql: 0, outside: []};

	await context.route('**/*', (route) => {
		const url = new URL(route.request().url());

		if (url.hostname === 'localhost' || url.hostname === 'graphql.pokeapi.co') {
			return route.fallback();
		}

		if (url.hostname === 'assets.tcgdex.net') {
			return route.fulfill({body: STAND_IN_CARD, contentType: 'image/svg+xml'});
		}

		// The exchange rates My Cards' prices ask for are refused quietly:
		// the tiles show no converted price without them.
		if (url.hostname === 'api.frankfurter.dev') {
			return route.abort();
		}

		if (url.hostname !== 'api.tcgdex.net') {
			seen.outside.push(url.href);

			return route.abort();
		}

		if (url.pathname === '/v2/graphql') {
			// My Cards' card details (js/catalog.js setDetails) are not the
			// twins' business: answered empty and not counted.
			if (/dexId types category rarity/.test(route.request().postData() || '')) {
				return route.fulfill({body: JSON.stringify({data: {cards: []}}), contentType: 'application/json'});
			}

			seen.graphql++;

			return route.fulfill({body: '{}', contentType: 'application/json', status: 404});
		}

		if (url.pathname === '/v2/ja/sets/tstj1') {
			return route.fulfill({body: JSON.stringify(JA_SET), contentType: 'application/json'});
		}

		const card = /^\/v2\/ja\/cards\/(tstj1-\d+)$/.exec(url.pathname);
		const listed = card && JA_SET.cards.find((item) => item.id === card[1]);

		if (!listed) {
			return route.fulfill({body: '{}', contentType: 'application/json', status: 404});
		}

		const set = {cardCount: JA_SET.cardCount, id: JA_SET.id, name: JA_SET.name, releaseDate: JA_SET.releaseDate};

		return route.fulfill({body: JSON.stringify({...listed, category: RESULTS[`ja|${listed.id}`].category, set, variants_detailed: []}), contentType: 'application/json'});
	});
	await fakePokeApi(context);

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err.message));

	return {context, errors, page, seen};
}

// The collection and the twin results, put on the device the way the app
// and js/twins.js save them, then the app opened again on My Cards.
async function seedApp(page) {
	await page.goto(`${server.origin}${APP}cards`);
	await page.evaluate(async ({copies, results}) => {
		await new Promise((resolve, reject) => {
			const open = indexedDB.open('card-tracker-collection', 1);

			open.onupgradeneeded = () => open.result.createObjectStore('documents');
			open.onsuccess = () => {
				const tx = open.result.transaction('documents', 'readwrite');

				tx.objectStore('documents').put({binders: [], cards: copies, collections: [], goals: [], openings: [], person: 'local', updated_at: '2026-09-01T00:00:00.000Z', user_id: null, version: 1, wishlist: []}, 'local');
				tx.oncomplete = () => {
					open.result.close();
					resolve();
				};
				tx.onerror = () => reject(tx.error);
			};
			open.onerror = () => reject(open.error);
		});

		const {MATCHER_VERSION, idbStore} = await import('/pokemon-card-tracker/js/twins.js');
		const store = idbStore();

		for (const [key, result] of Object.entries(results)) {
			await store.put('results', key, {...result, checked_at: Date.now(), version: MATCHER_VERSION});
		}
	}, {copies: COPIES, results: RESULTS});
	await page.reload();
}

describe('twins in the app', () => {
	test('My Cards shows a twin\'s image and a Trainer\'s English name, for Korean copies too', async () => {
		const {context, errors, page, seen} = await appContext();

		await seedApp(page);

		const trainer = page.locator('.tile', {has: page.locator('.tile-original', {hasText: '試験の道具'})});

		await trainer.waitFor();
		assert.equal(await trainer.locator('.tile-name').textContent(), 'Test Gadget');
		assert.equal(await trainer.locator('.tile-name').getAttribute('lang'), null, 'the English name is not marked Japanese');
		assert.match(await trainer.locator('img[src*="tcgdex"]').getAttribute('src'), /\/en\/tst\/tst9\/050\/low\.webp$/);

		const korean = page.locator('.tile', {has: page.locator('.tile-original', {hasText: '시험 도구'})});

		await korean.waitFor();
		assert.equal(await korean.locator('.tile-name').textContent(), 'Test Gadget');

		// A Pokémon lends its image; its name comes from js/names.js.
		await page.locator('.tile img[src$="/en/tst/tst9/007/low.webp"]').waitFor();

		// The unsure one lends nothing until it is answered.
		const unsure = page.locator('.tile', {has: page.locator('.tile-name', {hasText: '試験の化石'})});

		await unsure.waitFor();
		assert.equal(await unsure.locator('img[src*="tst9"]').count(), 0);
		await page.screenshot({fullPage: true, path: `${SHOTS}/twins-my-cards.png`});

		// Answered while My Cards is open (as a background check finding a
		// twin would be): that tile alone is drawn again, a moment later.
		const untouched = await trainer.elementHandle();

		await page.evaluate(async () => {
			const {setDecision, twinState} = await import('/pokemon-card-tracker/js/twins.js');
			const item = {card_id: 'tstj1-003', catalog: 'ja'};

			await setDecision(item, {choice: 'confirmed', twin: twinState(item).candidates[0]});
		});
		await page.locator('.tile img[src$="/en/tst/tst9/061/low.webp"]').waitFor();
		assert.equal(await page.locator('.tile', {has: page.locator('.tile-original', {hasText: '試験の化石'})}).locator('.tile-name').textContent(), 'Test Fossil A');
		assert.ok(await untouched.evaluate((element) => element.isConnected), 'the other tiles stay as they were');

		// Sorted by name, the English names sort with the rest.
		await page.selectOption('#cards-sort', 'name');
		assert.deepEqual((await page.locator('.tile-name').allTextContents()).slice(0, 2), ['Test Fossil A', 'Test Gadget']);
		await page.waitForTimeout(500);
		assert.equal(seen.graphql, 0, 'settled results send no request');
		assert.deepEqual(seen.outside, []);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('set detail tiles with no image of their own show the twin\'s, and a Trainer its English name', async () => {
		const {context, errors, page, seen} = await appContext();

		await seedApp(page);
		await page.goto(`${server.origin}${APP}sets/ja/tstj1`);

		const tileFor = (number) => page.locator('.card-grid .tile', {has: page.locator('.tile-meta', {hasText: `#${number}`})});

		await page.locator('.card-grid .tile img[src$="/en/tst/tst9/050/low.webp"]').waitFor();
		assert.equal(await tileFor('001').locator('.tile-name').textContent(), 'Test Gadget');
		assert.equal(await tileFor('001').locator('.tile-original').textContent(), '試験の道具');
		assert.match(await tileFor('002').locator('img').getAttribute('src'), /\/en\/tst\/tst9\/007\/low\.webp$/);

		// The unsure one lends nothing until it is answered, then its tile
		// takes the twin chosen.
		assert.equal(await tileFor('003').locator('img').count(), 0, 'the card back');
		await page.screenshot({path: `${SHOTS}/twins-set-detail.png`});
		await page.evaluate(async () => {
			const {setDecision, twinState} = await import('/pokemon-card-tracker/js/twins.js');
			const item = {card_id: 'tstj1-003', catalog: 'ja'};

			await setDecision(item, {choice: 'confirmed', twin: twinState(item).candidates[1]});
		});
		await page.locator('.card-grid .tile img[src$="/en/tst/tst9/062/low.webp"]').waitFor();
		assert.equal(await tileFor('003').locator('.tile-name').textContent(), 'Test Fossil B');
		assert.equal(seen.graphql, 0);
		assert.deepEqual(seen.outside, []);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('card detail shows the International print slide, the English name, and the picker after the hero', async () => {
		const {context, errors, page, seen} = await appContext();

		await seedApp(page);
		await page.goto(`${server.origin}${APP}cards/ja/tstj1-001`);

		await page.locator('.card-detail h2', {hasText: 'Test Gadget'}).waitFor();
		assert.match(await page.locator('.card-detail .name-original').textContent(), /試験の道具/);

		const slide = page.locator('.ph-slide[data-slide="twin"]');

		await slide.waitFor({state: 'attached'});
		assert.equal(await slide.locator('.ph-source').textContent(), 'International print');
		assert.match(await slide.locator('img').getAttribute('src'), /\/en\/tst\/tst9\/050\/high\.webp$/);
		assert.equal(await page.locator('.tw-block').isHidden(), true, 'nothing to ask for a confident twin');

		await page.goto(`${server.origin}${APP}cards/ja/tstj1-003`);
		await page.locator('.tw-confirm').waitFor();
		assert.equal(await page.locator('.tw-option').count(), 2);
		assert.ok(await page.locator('.card-hero').evaluate((hero) => Boolean(hero.nextElementSibling && hero.nextElementSibling.classList.contains('tw-block'))), 'the picker sits right after the hero');
		assert.equal(await page.locator('.ph-slide[data-slide="twin"]').count(), 0);

		// Picking one lends its image and name at once.
		await page.getByRole('button', {name: /^This one: Test Fossil B/}).click();
		await page.locator('.card-detail h2', {hasText: 'Test Fossil B'}).waitFor();
		await page.locator('.ph-slide[data-slide="twin"]').waitFor({state: 'attached'});
		await page.screenshot({fullPage: true, path: `${SHOTS}/twins-card-detail.png`});

		assert.equal(seen.graphql, 0);
		assert.deepEqual(seen.outside, []);
		assert.deepEqual(errors, []);
		await context.close();
	});
});
