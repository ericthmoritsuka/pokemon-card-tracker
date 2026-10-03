// Browser tests for copies by hand on card detail (js/copy-sheet.js placed
// by js/catalog-views.js): the edit sheet (language, finish, condition,
// notes), Remove copy with Undo and the binder it leaves, Add a copy, Add to
// wishlist, the order of card detail at 360 x 740 and 390 x 844, a card
// that opens while TCGdex answers 500, finish names on Portuguese records,
// no Ver na Liga for a Korean copy on a Japanese record, and family view
// keeping all of it read only. Headless Chromium against
// tests/pages-server.mjs, signed out.
//
// Every outside service is faked: TCGdex answers with the records saved in
// tests/prices-fixtures and a few invented ones, frankfurter.dev with a
// fixed rate, PokeAPI with tests/fake-pokeapi.mjs. Supabase must never be
// contacted, and ligapokemon.com.br is never requested.
//
// Until index.html links css/copies.css, the page is served with the link
// added, so the test sees the layout the app will have.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/copies-browser.test.mjs
// Screenshots: /tmp/copies-*.png

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const PHONE = {height: 740, width: 360};
const RATE = [{base: 'USD', date: '2026-10-01', quote: 'BRL', rate: 5.1877}];
const EURO_RATE = [{base: 'EUR', date: '2026-10-01', quote: 'BRL', rate: 5.8814}];
const STYLESHEET = `<link rel="stylesheet" href="${BASE}css/copies.css">`;

const fixture = async (name) => JSON.parse(await readFile(new URL(`./prices-fixtures/${name}.json`, import.meta.url), 'utf8'));

// Invented records. A Portuguese record whose variants TCGdex labels in
// Portuguese, as it does for sv03.5-001 (checked 2026-10-02).
const SET = {cardCount: {official: 147, total: 170}, id: 'tst1', name: 'Test set tst1'};
const LABELED = {
	id: 'tst1-007',
	localId: '007',
	name: 'Carta de teste',
	set: {...SET, name: 'Conjunto de teste'},
	variants_detailed: [
		{size: 'Padrão', type: 'Normal', variantId: 'v-normal'},
		{size: 'Padrão', type: 'Reverse', variantId: 'v-reverse'},
		{size: 'Padrão', stamp: ['Logo da coleção'], type: 'Normal', variantId: 'v-logo'},
		{foil: 'Poké Bola', size: 'Padrão', type: 'Reverse', variantId: 'v-ball'},
		{foil: 'Cosmos', size: 'Jumbo', type: 'Holo', variantId: 'v-jumbo'},
	],
};
const JAPANESE = {category: 'Pokemon', dexId: [6], id: 'tst1-020', localId: '020', name: 'リザードンGX', set: {...SET, name: 'テストセット'}, variants_detailed: []};

let server;
let browser;
let pt;
let en;

before(async () => {
	server = await startPagesServer();
	browser = await chromium.launch();
	[pt, en] = await Promise.all([fixture('pt-sv08.5-001'), fixture('en-sv08.5-001')]);
});

after(async () => {
	await browser.close();
	await server.close();
});

const url = (path = '') => `${server.origin}${BASE}${path}`;

// tcgdex.status, when set, answers every TCGdex request with it.
async function phone({viewport = PHONE} = {}) {
	const context = await browser.newContext({serviceWorkers: 'block', viewport});
	const seen = {liga: [], supabase: []};
	const tcgdex = {status: null};
	const records = {
		'en/cards/sv08.5-001': en,
		'ja/cards/tst1-020': JAPANESE,
		'pt/cards/sv08.5-001': pt,
		'pt/cards/tst1-007': LABELED,
	};

	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await context.route(/ligapokemon\.com\.br/, (route) => {
		seen.liga.push(route.request().url());

		return route.abort('blockedbyclient');
	});
	await context.route('https://*.supabase.co/**', (route) => {
		seen.supabase.push(route.request().url());

		return route.abort('blockedbyclient');
	});
	await context.route('https://api.frankfurter.dev/**', (route) => route.fulfill({
		body: JSON.stringify(/base=EUR/.test(route.request().url()) ? EURO_RATE : RATE),
		contentType: 'application/json',
		headers: {'Access-Control-Allow-Origin': '*'},
		status: 200,
	}));
	await context.route('https://api.tcgdex.net/**', (route) => {
		if (tcgdex.status) {
			return route.fulfill({body: '{"error":"down"}', contentType: 'application/json', headers: {'Access-Control-Allow-Origin': '*'}, status: tcgdex.status});
		}

		const record = records[new URL(route.request().url()).pathname.replace(/^\/v2\//, '')];

		return route.fulfill(record
			? {body: JSON.stringify(record), contentType: 'application/json', status: 200}
			: {body: '{}', contentType: 'application/json', status: 404});
	});
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));
	// The app page, with css/copies.css linked if index.html does not yet.
	await context.route((target) => target.pathname === BASE, async (route) => {
		const response = await route.fetch();
		const body = await response.text();

		return route.fulfill({
			body: body.includes('css/copies.css') ? body : body.replace('</head>', `\t${STYLESHEET}\n</head>`),
			contentType: 'text/html; charset=utf-8',
			status: response.status(),
		});
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

	return {context, done, page, tcgdex};
}

const addCard = (page, fields) => page.evaluate(async (card) => (await import('/pokemon-card-tracker/js/collection.js')).addCard(card), fields);

const entries = (page) => page.evaluate(async () => (await import('/pokemon-card-tracker/js/collection.js')).loadDocument().then((doc) => doc.cards));

const variantOf = (record, type, foil = undefined) => record.variants_detailed.find((variant) => variant.type === type && variant.foil === foil).variantId;

const rowTexts = (page) => page.locator('.copies .copy-text').allTextContents();

// Each row's language (its flag's tooltip) and its stepper's count.
const rowLanguages = (page) => page.locator('.copies li .flags').evaluateAll((flags) => flags.map((flag) => flag.getAttribute('title')));

const rowCounts = (page) => page.locator('.copies .step-count').evaluateAll((inputs) => inputs.map((input) => input.value));

// True when the element is wholly on screen and above the tab bar.
const onFirstScreen = (page, selector) => page.evaluate((target) => {
	const el = document.querySelector(target);
	const tabs = document.querySelector('.tabs');

	if (!el) {
		return false;
	}

	const rect = el.getBoundingClientRect();
	const floor = tabs ? tabs.getBoundingClientRect().top : window.innerHeight;

	return rect.height > 0 && rect.top >= 0 && rect.bottom <= floor;
}, selector);

describe('copies on card detail', () => {
	test('a copy\'s language, finish, condition, and notes are edited in its sheet', async () => {
		const {done, page} = await phone();

		await addCard(page, {card_id: pt.id, catalog: 'international', language: 'pt', language_source: 'scan', variant_id: variantOf(pt, 'Normal')});
		await page.goto(url(`cards/pt/${pt.id}`));
		await page.waitForSelector('.copies .copy-row');
		assert.deepEqual(await rowTexts(page), ['Normal']);
		assert.deepEqual(await rowLanguages(page), ['Portuguese']);
		assert.equal(await page.locator('.copies-head h3').textContent(), 'Your copies (1)');

		await page.click('.copies .copy-row');
		await page.waitForSelector('#copy-sheet[open]');
		assert.equal(await page.locator('#copy-sheet-title').textContent(), 'Edit copy');
		assert.equal(await page.locator('#copy-language').inputValue(), 'pt');
		assert.deepEqual(await page.locator('#copy-language option').allTextContents(), ['Portuguese', 'English', 'French', 'German', 'Italian', 'Spanish']);
		// Finish names as on English pages: no "Padrão", no Portuguese foils.
		assert.deepEqual(await page.locator('#copy-finish option').allTextContents(), ['Not set', 'Normal', 'Reverse holo', 'Reverse holo, Poké Ball pattern', 'Reverse holo, Master Ball pattern']);
		assert.equal(await page.locator('#copy-remove').textContent(), 'Remove copy');
		assert.ok(await page.locator('#copy-leaves').isHidden(), 'no binder to leave');
		await page.screenshot({path: '/tmp/copies-edit-sheet.png'});

		await page.selectOption('#copy-language', 'en');
		await page.selectOption('#copy-finish', variantOf(pt, 'Reverse', 'Poké Bola'));
		await page.selectOption('#copy-condition', 'Lightly Played');
		await page.fill('#copy-notes', 'From the league night');
		await page.click('#copy-save');
		await page.waitForSelector('#copy-sheet', {state: 'hidden'});
		await page.waitForSelector('.copies li .flags[title="English"]');
		assert.deepEqual(await rowTexts(page), ['Reverse holo, Poké Ball pattern · Lightly Played']);
		assert.equal(await page.locator('.copies .copy-note').textContent(), 'From the league night');

		const [entry] = await entries(page);

		assert.equal(entry.language, 'en');
		assert.equal(entry.language_source, 'manual');
		assert.equal(entry.variant_id, variantOf(pt, 'Reverse', 'Poké Bola'));
		assert.equal(entry.condition, 'Lightly Played');
		assert.equal(entry.notes, 'From the league night');
		assert.equal(entry.fallback, undefined, 'an English copy on an international record is no fallback');

		// Opening and saving with nothing changed writes nothing.
		const stamp = entry.updated_at;

		await page.click('.copies .copy-row');
		await page.click('#copy-save');
		await page.waitForSelector('#copy-sheet', {state: 'hidden'});
		assert.equal((await entries(page))[0].updated_at, stamp);
		await done();
	});

	test('Remove copy says which binder it leaves, and Undo restores the same copy', async () => {
		const {done, page} = await phone();
		const kept = await addCard(page, {card_id: pt.id, catalog: 'international', language: 'pt', language_source: 'scan', variant_id: variantOf(pt, 'Normal')});
		const gone = await addCard(page, {card_id: pt.id, catalog: 'international', language: 'pt', language_source: 'scan', variant_id: variantOf(pt, 'Reverse')});

		await page.evaluate(async (entryId) => {
			const binders = await import('/pokemon-card-tracker/js/binders.js');
			const binder = await binders.createBinder({cols: 3, name: 'Vitrine', page_count: 4, rows: 3});

			await binders.placeCard(binder.id, 3, 5, entryId);
		}, gone.id);
		await page.goto(url(`cards/pt/${pt.id}`));
		await page.waitForSelector('.copies .copy-place');
		assert.equal(await page.locator('.copies .copy-place').textContent(), 'Vitrine, page 3, pocket 5');

		await page.click('.copies li:has(.copy-place) .copy-row');
		await page.waitForSelector('#copy-sheet[open]');
		assert.equal(await page.locator('#copy-leaves').textContent(), 'It leaves Vitrine, page 3 when removed.');
		await page.click('#copy-remove');
		await page.waitForSelector('#copy-sheet', {state: 'hidden'});

		// Written at once: the copy is a tombstone while Undo is on offer.
		await page.waitForFunction(() => document.querySelectorAll('.copies .copy-row').length === 1);
		assert.equal(await page.locator('.copies-head h3').textContent(), 'Your copies (1)');

		const toast = page.locator('.toast', {hasText: 'copy removed'});

		assert.equal(await toast.locator('.toast-text').textContent(), 'Portuguese copy removed. It leaves Vitrine, page 3.');

		let after = await entries(page);

		assert.ok(after.find((entry) => entry.id === gone.id).deleted_at, 'the removed copy is deleted');
		assert.equal(after.find((entry) => entry.id === kept.id).deleted_at, null);
		await page.screenshot({path: '/tmp/copies-removed-toast.png'});

		// Undo brings the same entry back, in its pocket, past the tombstone.
		await toast.locator('button', {hasText: 'Undo'}).click();
		await page.waitForFunction(() => document.querySelectorAll('.copies .copy-row').length === 2);
		assert.equal(await page.locator('.copies .copy-place').textContent(), 'Vitrine, page 3, pocket 5', 'back in its pocket');
		after = await entries(page);

		const restored = after.find((entry) => entry.id === gone.id);

		assert.equal(restored.deleted_at, null);
		assert.ok(restored.restored_at, 'restored on purpose, so the merge keeps it');
		assert.equal(after.length, 2, 'no new entry');

		// The last copies: the card is no longer in your cards, and Add stays.
		await page.click('.copies li:has(.copy-place) .copy-row');
		await page.click('#copy-remove');
		await page.waitForFunction(() => document.querySelectorAll('.copies .copy-row').length === 1);
		assert.deepEqual(await rowTexts(page), ['Normal']);
		await page.click('.copies .copy-row');
		await page.click('#copy-remove');
		await page.waitForSelector('.copies-head h3:has-text("Not in your cards")');
		assert.ok((await entries(page)).every((entry) => entry.deleted_at));
		assert.equal(await page.locator('#copy-add').count(), 1);
		await done();
	});

	test('a row of alike copies edits or removes one of them, or all', async () => {
		const {done, page} = await phone();

		for (let i = 0; i < 3; i++) {
			await addCard(page, {card_id: pt.id, catalog: 'international', language: 'pt', language_source: 'scan', variant_id: variantOf(pt, 'Normal')});
		}

		await page.goto(url(`cards/pt/${pt.id}`));
		await page.waitForSelector('.copies .copy-row');
		assert.deepEqual(await rowTexts(page), ['Normal']);
		assert.deepEqual(await rowCounts(page), ['3']);
		await page.click('.copies .copy-row');
		assert.equal(await page.locator('#copy-sheet-title').textContent(), 'Edit copies (3 alike)');
		await page.selectOption('#copy-condition', 'Near Mint');
		await page.click('#copy-save');
		await page.waitForSelector('.copies .copy-text:has-text("Near Mint")');
		assert.deepEqual(await rowTexts(page), ['Normal', 'Normal · Near Mint']);
		assert.deepEqual(await rowCounts(page), ['2', '1']);

		await page.click('.copies li:first-child .copy-row');
		await page.click('#copy-sheet .copy-scope label:has-text("All 2")');
		assert.equal(await page.locator('#copy-remove').textContent(), 'Remove 2 copies');
		await page.click('#copy-remove');
		await page.waitForFunction(() => document.querySelectorAll('.copies .copy-row').length === 1);
		assert.equal(await page.locator('.toast-text', {hasText: 'removed'}).textContent(), '2 copies removed.');
		assert.equal((await entries(page)).filter((entry) => !entry.deleted_at).length, 1);
		await done();
	});

	test('Add a copy on an unowned card: language, finish, condition, and how many', async () => {
		const {done, page} = await phone();

		await page.goto(url(`cards/pt/${pt.id}`));
		await page.waitForSelector('.copies-head h3:has-text("Not in your cards")');
		await page.click('#copy-add');
		await page.waitForSelector('#copy-sheet[open]');
		assert.equal(await page.locator('#copy-sheet-title').textContent(), 'Add a copy');
		assert.equal(await page.locator('#copy-language').inputValue(), 'pt', 'the language the card is viewed in');
		assert.equal(await page.locator('#copy-finish').inputValue(), variantOf(pt, 'Normal'), 'the plain print first');
		assert.equal(await page.locator('#copy-condition').inputValue(), '');
		await page.screenshot({path: '/tmp/copies-add-sheet.png'});

		await page.fill('#copy-count', '25');
		await page.click('#copy-add-save');
		assert.equal(await page.locator('#copy-error').textContent(), 'Choose from 1 to 20 copies.');
		assert.equal((await entries(page)).length, 0);

		await page.selectOption('#copy-finish', variantOf(pt, 'Reverse'));
		await page.selectOption('#copy-condition', 'Near Mint');
		await page.fill('#copy-count', '3');
		assert.equal(await page.locator('#copy-add-save').textContent(), 'Add 3 copies');
		await page.click('#copy-add-save');
		await page.waitForSelector('.copies-head h3:has-text("Your copies (3)")');
		assert.deepEqual(await rowTexts(page), ['Reverse holo · Near Mint']);
		assert.deepEqual(await rowCounts(page), ['3']);
		assert.equal(await page.locator('.toast-text', {hasText: 'Added'}).textContent(), 'Added 3 Portuguese copies.');

		const saved = await entries(page);

		assert.equal(saved.length, 3);

		for (const entry of saved) {
			assert.equal(entry.card_id, pt.id);
			assert.equal(entry.catalog, 'international');
			assert.equal(entry.language, 'pt');
			assert.equal(entry.language_source, 'manual');
			assert.equal(entry.variant_id, variantOf(pt, 'Reverse'));
			assert.equal(entry.condition, 'Near Mint');
		}

		// Owned, Add stays in the heading for one more.
		await page.click('#copy-add');
		await page.selectOption('#copy-language', 'en');
		await page.click('#copy-add-save');
		await page.waitForSelector('.copies-head h3:has-text("Your copies (4)")');

		// Undo on the toast takes back what was just added.
		await page.locator('.toast', {hasText: 'Added 1 English copy.'}).locator('button', {hasText: 'Undo'}).click();
		await page.waitForSelector('.copies-head h3:has-text("Your copies (3)")');
		await done();
	});

	test('Add to wishlist, and the state once the card is wished', async () => {
		const {done, page} = await phone();

		await page.goto(url(`cards/pt/${pt.id}`));
		await page.waitForSelector('#card-wish');
		assert.equal(await page.locator('#card-wish').textContent(), 'Add to wishlist');
		await page.click('#card-wish');
		await page.waitForSelector('#card-wished');
		assert.equal(await page.locator('#card-wished').textContent(), '✓ On your wishlist');
		assert.equal(await page.locator('#card-wished').getAttribute('aria-label'), 'On your wishlist in Portuguese. Open the wishlist');
		assert.equal(await page.locator('.toast-text', {hasText: 'wishlist'}).textContent(), 'Added to your wishlist (Portuguese).');
		assert.equal(await page.locator('#card-wished').getAttribute('href'), `${BASE}wishlist`);

		const wishlist = await page.evaluate(async () => (await import('/pokemon-card-tracker/js/wishlist.js')).listWishlist());

		assert.equal(wishlist.length, 1);
		assert.equal(wishlist[0].card_id, pt.id);
		assert.equal(wishlist[0].catalog, 'international');
		assert.equal(wishlist[0].language, 'pt');

		// Wished in any language, the card says so after a reload too.
		await page.goto(url(`cards/en/${pt.id}`));
		await page.waitForSelector('#card-wished');
		await done();
	});
});

describe('card detail layout', () => {
	for (const viewport of [PHONE, {height: 844, width: 390}]) {
		test(`art, facts, Your copies with Add, and Ver na Liga on the first screen at ${viewport.width} x ${viewport.height}`, async () => {
			const {done, page} = await phone({viewport});

			await addCard(page, {card_id: pt.id, catalog: 'international', language: 'pt', language_source: 'scan', variant_id: variantOf(pt, 'Normal')});
			await addCard(page, {card_id: pt.id, catalog: 'international', condition: 'Near Mint', language: 'pt', language_source: 'scan', variant_id: variantOf(pt, 'Reverse')});
			await page.goto(url(`cards/pt/${pt.id}`));
			await page.waitForSelector('#card-liga-link');
			await page.waitForSelector('#card-price .price');

			// In this order: hero, copies, Ver na Liga, then the price panel.
			const order = await page.evaluate(() => [...document.querySelector('.card-detail').children]
				.filter((el) => !el.hidden)
				.map((el) => el.id || el.className));

			assert.deepEqual(order.slice(0, 4), ['card-hero', 'copies', 'card-liga', 'card-price']);

			for (const selector of ['.hero-art', '.hero-facts h2', '.copies-head h3', '#copy-add', '.copies li:last-child', '#card-liga-link', '#card-wish']) {
				assert.ok(await onFirstScreen(page, selector), `${selector} on the first screen`);
			}

			// One visible Ver na Liga; the price panel's own is hidden.
			assert.equal(await page.locator('.card-detail a:visible:has-text("Ver na Liga")').count(), 1);
			assert.equal(await page.locator('#card-liga-link').getAttribute('href'), 'https://www.ligapokemon.com.br/?view=cards/search&card=Exeggcute%20(001%2F131)');
			assert.ok(await page.locator('#card-price .price-liga-link').isHidden());
			// The Liga form and the other markets come after.
			assert.ok(!(await onFirstScreen(page, '#card-price .price-others')), 'the US and EU markets are further down');
			assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll');
			await page.screenshot({path: `/tmp/copies-first-screen-${viewport.width}.png`});
			await done();
		});
	}

	test('Portuguese variants are named as on English pages', async () => {
		const {done, page} = await phone();

		await page.goto(url('cards/pt/tst1-007'));
		await page.waitForSelector('.variants-section li');
		assert.deepEqual(await page.locator('.variants-section li').allTextContents(), [
			'Normal',
			'Reverse holo',
			'Normal, Set logo stamp',
			'Reverse holo, Poké Ball pattern',
			'Holo, Cosmos foil, Jumbo',
		]);
		await done();
	});

	test('a Korean copy on a Japanese record gets no Ver na Liga, a Japanese copy does', async () => {
		const {done, page} = await phone();

		// As the scanner saves it: no Korean name from monprice.
		const korean = await addCard(page, {card_id: 'tst1-020', catalog: 'ja', fallback: true, language: 'ko', language_source: 'scan'});

		await page.goto(url('cards/ja/tst1-020'));
		await page.waitForSelector('#card-liga-none');
		await page.waitForTimeout(300);
		assert.equal(await page.locator('#card-liga-none').textContent(), 'No Liga link for Korean prints.');
		assert.equal(await page.locator('.card-detail a:visible:has-text("Ver na Liga")').count(), 0);

		// A Japanese copy of the same record has its Liga page.
		await page.evaluate(async (id) => (await import('/pokemon-card-tracker/js/collection.js')).updateCard(id, {fallback: false, language: 'ja'}), korean.id);
		await page.waitForSelector('#card-liga-link');
		assert.equal(new URL(await page.locator('#card-liga-link').getAttribute('href')).searchParams.get('card'), 'Charizard-GX (020/147)');

		// The edit sheet offers Japanese and Korean on a Japanese record.
		await page.click('.copies .copy-row');
		assert.deepEqual(await page.locator('#copy-language option').allTextContents(), ['Japanese', 'Korean']);
		await page.selectOption('#copy-language', 'ko');
		await page.click('#copy-save');
		await page.waitForSelector('#card-liga-none');

		const [entry] = await entries(page);

		assert.equal(entry.language, 'ko');
		assert.equal(entry.fallback, true, 'a Korean copy on a Japanese record is a fallback match');
		await done();
	});
});

describe('when TCGdex fails, and in family view', () => {
	test('an owned card opens with its copies and what the phone knows while TCGdex answers 500', async () => {
		const {done, page, tcgdex} = await phone();

		await addCard(page, {card_id: pt.id, catalog: 'international', language: 'pt', language_source: 'scan', variant_id: variantOf(pt, 'Normal')});
		await page.evaluate(async () => (await import('/pokemon-card-tracker/js/catalog.js')).saveToCardIndex([{
			catalog: 'international',
			collector_number: '001',
			id: 'sv08.5-001',
			localizations: {pt: {image: null, lang: 'pt', name: 'Exeggcute', set_name: 'Evoluções Prismáticas'}},
			set_id: 'sv08.5',
		}]));
		tcgdex.status = 500;
		await page.goto(url(`cards/pt/${pt.id}`));
		await page.waitForSelector('#card-unreachable', {timeout: 20000});
		assert.equal(await page.locator('#card-unreachable p').first().textContent(), 'The card catalog is not answering. This is what the phone has saved.');
		assert.match(await page.locator('#card-unreachable .card-unreachable-why').textContent(), /^TCGdex answered 500/);
		assert.equal(await page.locator('.card-detail h2').textContent(), 'Exeggcute');
		assert.match(await page.locator('.facts').textContent(), /SetEvoluções Prismáticas/);
		await page.waitForSelector('.copies .copy-row');
		assert.deepEqual(await rowTexts(page), ['Finish (catalog offline)']);
		assert.equal(await page.locator('#copy-add').count(), 1);
		await page.screenshot({path: '/tmp/copies-tcgdex-500.png'});
		assert.ok(await onFirstScreen(page, '.copies .copy-row'), 'the copies on the first screen');

		// Try again, with TCGdex back: the full record, and the note goes.
		tcgdex.status = null;
		await page.click('#card-retry');
		await page.waitForSelector('#card-unreachable', {state: 'detached'});
		await page.waitForSelector('.copies .copy-text:text-is("Normal")');
		await done();
	});

	test('a card the phone knows nothing about still says TCGdex failed', async () => {
		const {done, page, tcgdex} = await phone();

		tcgdex.status = 500;
		await page.goto(url(`cards/pt/${pt.id}`));
		await page.waitForSelector('.notice[role="alert"]', {timeout: 20000});
		assert.match(await page.locator('.notice[role="alert"] p').textContent(), /Could not load this card\. TCGdex answered 500/);
		await done();
	});

	test('family view shows no edit sheet, no Add, and no wishlist button', async () => {
		const {done, page} = await phone();

		await addCard(page, {card_id: pt.id, catalog: 'international', language: 'pt', language_source: 'scan', variant_id: variantOf(pt, 'Normal')});
		// A member's lens, then their card opened inside the app.
		await page.goto(url('family/member-a'));
		await page.waitForSelector('#family-strip');
		await page.evaluate(async (route) => (await import('/pokemon-card-tracker/js/dom.js')).go(route), `cards/pt/${pt.id}`);
		await page.waitForSelector('.card-detail h2');
		await page.waitForSelector('#card-liga-link');
		assert.equal(await page.locator('#family-strip').count(), 1, 'still in family view');
		await page.waitForSelector('.copies li');
		assert.equal(await page.locator('.copies .copy-row').count(), 0, 'rows open nothing');
		assert.equal(await page.locator('.copies .copy-stepper').count(), 0, 'no stepper');
		assert.equal(await page.locator('.copies li').textContent(), 'Portuguese · Normal', 'the language in words, read only');
		assert.equal(await page.locator('#copy-add').count(), 0);
		assert.equal(await page.locator('#card-wish, #card-wished').count(), 0);
		await page.click('.copies li');
		assert.equal(await page.locator('#copy-sheet[open]').count(), 0);

		// An unowned card in family view shows no Add either.
		await page.evaluate(async (route) => (await import('/pokemon-card-tracker/js/dom.js')).go(route), 'cards/pt/tst1-007');
		await page.waitForSelector('.variants-section');
		await page.waitForSelector('#card-liga');
		assert.ok(await page.locator('.copies').isHidden());
		assert.equal(await page.locator('#copy-add').count(), 0);
		await done();
	});
});
