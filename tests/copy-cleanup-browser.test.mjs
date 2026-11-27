// Browser tests for the two cleanup screens beside Check spares (Eric,
// 2026-11-26): the Monprice import check (js/import-dup-view.js) and Copies
// with no finish (js/unset-finish-view.js), and the lines on Check spares
// that count them (js/copy-cleanup.js). The import check lists the groups of
// imported copies in one card, language, and finish, with Checked hiding a
// group until its copies change. Copies with no finish lists them by set,
// with Select all per set and a Set finish that reads every selected card's
// printings in batches of 60 and saves them with Undo. Headless Chromium at
// 360 x 740 against tests/pages-server.mjs, signed out, in UTC.
//
// Every outside service is faked (tests/my-cards-fixtures.mjs): TCGdex
// answers invented cards, frankfurter.dev a fixed rate, PokeAPI
// tests/fake-pokeapi.mjs. Supabase and ligapokemon.com.br are never
// requested.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/copy-cleanup-browser.test.mjs
// Screenshots: $SHOTS (default /tmp)/copy-cleanup-*.png

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {BASE, CARDS, fakeServices, fullRecord, indexRecords, seed} from './my-cards-fixtures.mjs';
import {startPagesServer} from './pages-server.mjs';
import {untilInPage} from './poll.mjs';
import {checkedSignature, importDuplicates} from '../js/import-dup-check.js';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const VIEWPORT = {height: 740, width: 360};
const SHOTS = process.env.SHOTS || '/tmp';
const TIMEOUT = {timeout: 20000};

const IMPORTED_AT = '2026-10-31T10:22:00.000Z';
const card = (id) => CARDS.find((item) => item.id === id);

// An invented copy; imported when it has an import key.
const copy = (id, cardId, fields = {}) => ({
	card_id: cardId,
	catalog: 'international',
	created_at: '2026-11-05T12:00:00.000Z',
	deleted_at: null,
	id,
	language: 'en',
	language_source: 'manual',
	updated_at: '2026-11-05T12:00:00.000Z',
	variant_id: null,
	...fields,
});

const imported = (id, cardId, fields = {}) => copy(id, cardId, {
	created_at: IMPORTED_AT,
	import_key: `monprice|m-${cardId}|en|NORMAL|${id}`,
	language_source: 'import',
	updated_at: IMPORTED_AT,
	...fields,
});

// Two Charmander in Normal and three Charizard ex in Holo, all added by the
// import at 10:22; a Pikachu in Normal and another in Reverse holo, which
// are two finishes, so no group; and copies with no finish: two Bulbasaur,
// a Portuguese Test Ball, a Sprigatito, and a Pikachu.
const COPIES = [
	imported('i-01', 'tsa1-004', {variant_id: 'v4-normal'}),
	imported('i-02', 'tsa1-004', {variant_id: 'v4-normal'}),
	imported('i-03', 'tsa1-006', {variant_id: 'v6-holo'}),
	imported('i-04', 'tsa1-006', {variant_id: 'v6-holo'}),
	imported('i-05', 'tsa1-006', {variant_id: 'v6-holo'}),
	imported('i-06', 'tsb2-025', {variant_id: 'v25-normal'}),
	imported('i-07', 'tsb2-025', {variant_id: 'v25-reverse'}),
	copy('u-01', 'tsa1-001'),
	copy('u-02', 'tsa1-001'),
	copy('u-03', 'tsa1-150', {language: 'pt'}),
	copy('u-04', 'tsb2-090'),
	copy('u-05', 'tsb2-025'),
];

// The printings the phone has saved: three cards, so their finishes are
// named and read with no request. Sprigatito's come from the fake TCGdex.
const withVariants = (cardId, variants) => ({at: Date.now(), data: {...fullRecord(card(cardId)), variants_detailed: variants}});
const savedRecords = () => ({
	'card:en:tsa1-001': withVariants('tsa1-001', [{type: 'normal', variantId: 'v1-normal'}, {type: 'reverse', variantId: 'v1-reverse'}]),
	'card:en:tsa1-004': withVariants('tsa1-004', [{type: 'normal', variantId: 'v4-normal'}]),
	'card:en:tsa1-006': withVariants('tsa1-006', [{type: 'holo', variantId: 'v6-holo'}]),
	'card:en:tsa1-150': withVariants('tsa1-150', [{type: 'normal', variantId: 'v150-normal'}]),
	'card:en:tsb2-025': withVariants('tsb2-025', [{type: 'normal', variantId: 'v25-normal'}, {type: 'reverse', variantId: 'v25-reverse'}]),
});

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

// TCGdex's card records with printings, for the cards whose records the
// phone has not saved: a normal and a holo, each with its own variant ID.
// gate: awaited by the request numbered `after` and every one past it, so a
// test can stop a read between two batches.
async function fakePrintings(context, {gate = null} = {}) {
	const seen = [];

	await context.route(/api\.tcgdex\.net\/v2\/en\/cards\//, async (route) => {
		const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop());
		const base = CARDS.find((item) => item.id === id) || CARDS[0];

		seen.push(id);

		if (gate && seen.length > gate.after) {
			await gate.open;
		}

		await route.fulfill({
			body: JSON.stringify({...fullRecord({...base, id}), variants_detailed: [{type: 'normal', variantId: `${id}-normal`}, {type: 'holo', variantId: `${id}-holo`}]}),
			contentType: 'application/json',
			headers: {'Access-Control-Allow-Origin': '*'},
		});
	});

	return seen;
}

async function phone({colorScheme = 'light', copies = COPIES, gate = null, index = indexRecords(), local = {}, records = savedRecords(), start = 'trade/check'} = {}) {
	const context = await browser.newContext({colorScheme, serviceWorkers: 'block', timezoneId: 'UTC', viewport: VIEWPORT});
	const log = await fakeServices(context);

	await fakePokeApi(context);

	const seen = await fakePrintings(context, {gate});
	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err.message));
	await seed(page, server.origin, {binders: [], copies, index, local, records});
	await page.goto(`${server.origin}${BASE}${start}`);

	const done = async () => {
		assert.deepEqual(errors, []);
		assert.deepEqual(log.other.filter((url) => /supabase|ligapokemon/.test(url)), [], 'Supabase and Liga are never requested');
		await context.close();
	};

	return {context, done, log, page, seen};
}

// The document on the phone.
const cardsOf = (page) => page.evaluate(async () => (await import('/pokemon-card-tracker/js/collection.js')).loadDocument().then((doc) => doc.cards));

const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

describe('the lines on Check spares', () => {
	test('each cleanup screen has a line under the heading with its count, and the line opens it', async () => {
		const {done, page} = await phone();

		await page.locator('#cleanup-import-count').waitFor(TIMEOUT);
		await page.waitForFunction(() => document.getElementById('cleanup-import-count').textContent !== 'Reading…');

		assert.equal(await page.locator('#cleanup-import-count').textContent(), '2 groups to check, 5 copies');
		assert.equal(await page.locator('#cleanup-finish-count').textContent(), '5 copies with no finish, 4 cards');
		assert.equal(await page.locator('#cleanup-links li').count(), 2);

		// Under the heading, above the intro.
		const [title, links, intro] = await Promise.all(['#check-title', '#cleanup-links', '.check-intro'].map((selector) => page.locator(selector).boundingBox()));

		assert.ok(title.y < links.y && links.y < intro.y, 'the lines sit between the heading and the intro');
		assert.ok(await noOverflow(page));
		await page.screenshot({path: `${SHOTS}/copy-cleanup-links.png`});

		await page.click('#cleanup-import');
		await page.locator('#import-title').waitFor(TIMEOUT);
		assert.equal(new URL(page.url()).pathname, `${BASE}trade/check/import`);
		assert.equal(await page.title(), 'Monprice import check | Card Tracker');
		await page.click('#import-back');
		await page.locator('#cleanup-finish').waitFor(TIMEOUT);
		await page.click('#cleanup-finish');
		await page.locator('#unset-title').waitFor(TIMEOUT);
		assert.equal(new URL(page.url()).pathname, `${BASE}trade/check/finish`);
		assert.equal(await page.title(), 'Copies with no finish | Card Tracker');
		await done();
	});

	test('with nothing to look at, the lines say so in plain words', async () => {
		const {done, page} = await phone({copies: [copy('x-01', 'tsa1-001', {variant_id: 'v1-normal'})]});

		await page.waitForFunction(() => document.getElementById('cleanup-import-count').textContent !== 'Reading…');
		assert.equal(await page.locator('#cleanup-import-count').textContent(), 'nothing to check');
		assert.equal(await page.locator('#cleanup-finish-count').textContent(), 'every copy has a finish');
		await done();
	});

	test('one card\'s check has no cleanup lines', async () => {
		const {done, page} = await phone({start: 'trade/check/en/tsa1-004'});

		await page.waitForFunction(() => document.getElementById('check-summary').textContent !== 'Reading your cards…', null, TIMEOUT);
		assert.equal(await page.locator('#cleanup-links').count(), 0);
		await done();
	});
});

describe('the Monprice import check', () => {
	test('lists each group with its picture, set, language, finish, count, and added time, biggest first', async () => {
		const {done, page} = await phone({start: 'trade/check/import'});

		await page.locator('.import-group').first().waitFor(TIMEOUT);
		assert.equal(await page.locator('#import-summary').textContent(), '2 groups to check, 5 copies in all.');
		assert.deepEqual(await page.locator('.import-group .check-name').allTextContents(), ['Charizard ex', 'Charmander']);

		const group = page.locator('.import-group', {hasText: 'Charizard ex'});

		assert.equal(await group.locator('.check-meta').first().textContent(), '#006 · Test Alpha · English');
		assert.equal(await group.locator('.import-finish').textContent(), 'Holo');
		assert.equal(await group.locator('.import-count').textContent(), '3 copies');
		assert.equal(await group.locator('.import-added').textContent(), 'Added 2026-10-31 at 10:22');
		assert.equal(await group.locator('.check-thumb .art-wrap').count(), 1, 'the picture');
		assert.equal(await group.locator('.import-open').getAttribute('href'), `${BASE}cards/en/tsa1-006`);
		assert.equal(await page.locator('.import-group', {hasText: 'Charmander'}).locator('.import-finish').textContent(), 'Normal');
		assert.doesNotMatch(await page.locator('#import-list').textContent(), /Pikachu/, 'two finishes are not a group');
		assert.ok(await noOverflow(page));
		await page.screenshot({fullPage: true, path: `${SHOTS}/copy-cleanup-import.png`});
		await done();
	});

	test('Open card goes to the card page, where the copies are', async () => {
		const {done, page} = await phone({start: 'trade/check/import'});

		await page.locator('.import-group', {hasText: 'Charmander'}).locator('.import-open').click();
		await page.locator('#copy-add').waitFor(TIMEOUT);
		assert.equal(new URL(page.url()).pathname, `${BASE}cards/en/tsa1-004`);
		await done();
	});

	test('Checked hides a group and stays hidden after a reload; Undo and Show checked bring it back', async () => {
		const {done, page} = await phone({start: 'trade/check/import'});
		const group = (name) => page.locator('.import-group', {hasText: name});

		await group('Charizard ex').waitFor(TIMEOUT);
		await group('Charizard ex').locator('.import-done').click();

		const toast = page.locator('.toast', {hasText: 'Charizard ex checked.'});

		await toast.waitFor(TIMEOUT);
		assert.equal(await group('Charizard ex').count(), 0);
		assert.equal(await page.locator('#import-summary').textContent(), '1 group to check, 2 copies in all. 1 checked.');
		assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Charmander', 'the next group takes the focus');

		// The copies are untouched.
		assert.equal((await cardsOf(page)).filter((entry) => entry.card_id === 'tsa1-006' && !entry.deleted_at).length, 3);

		await toast.locator('button', {hasText: 'Undo'}).click();
		await group('Charizard ex').waitFor(TIMEOUT);
		assert.equal(await page.locator('#import-show-checked').isHidden(), true, 'no checked group to list');

		await group('Charizard ex').locator('.import-done').click();
		await page.reload();
		await page.locator('.import-group').first().waitFor(TIMEOUT);
		assert.equal(await group('Charizard ex').count(), 0, 'the mark is kept on this phone');
		assert.equal(await page.locator('#import-show-checked').textContent(), 'Show checked (1)');

		await page.click('#import-show-checked');
		assert.deepEqual(await page.locator('.import-group .check-name').allTextContents(), ['Charizard ex']);
		assert.equal(await page.locator('#import-summary').textContent(), '1 group checked.');
		await page.screenshot({path: `${SHOTS}/copy-cleanup-import-checked.png`});
		await group('Charizard ex').locator('.import-done').click();
		await page.locator('.toast', {hasText: 'Charizard ex is back in the list.'}).waitFor(TIMEOUT);
		assert.deepEqual(await page.locator('.import-group .check-name').allTextContents(), ['Charizard ex', 'Charmander'], 'back in the list, and the list is shown again');
		await done();
	});

	test('a mark holds only while the group\'s copies are the same ones', async () => {
		const [two] = importDuplicates(COPIES).filter((group) => group.card_id === 'tsa1-004');
		const marks = JSON.stringify({[two.key]: checkedSignature(two)});

		// The same two copies: hidden.
		let {done, page} = await phone({local: {'cardTracker.importChecked': marks}, start: 'trade/check/import'});

		await page.locator('.import-group').first().waitFor(TIMEOUT);
		assert.deepEqual(await page.locator('.import-group .check-name').allTextContents(), ['Charizard ex']);
		await done();

		// A third copy came in: the group is back, and no group is checked.
		({done, page} = await phone({copies: [...COPIES, imported('i-08', 'tsa1-004', {variant_id: 'v4-normal'})], local: {'cardTracker.importChecked': marks}, start: 'trade/check/import'}));
		await page.locator('.import-group').first().waitFor(TIMEOUT);
		assert.deepEqual((await page.locator('.import-group .check-name').allTextContents()).sort(), ['Charizard ex', 'Charmander']);
		assert.equal(await page.locator('.import-group', {hasText: 'Charmander'}).locator('.import-count').textContent(), '3 copies');
		assert.equal(await page.locator('#import-show-checked').isHidden(), true);
		await done();
	});

	test('the empty states say what they mean', async () => {
		let {done, page} = await phone({copies: [imported('i-01', 'tsa1-004', {variant_id: 'v4-normal'})], start: 'trade/check/import'});

		await page.waitForFunction(() => /nothing to check/.test(document.getElementById('import-summary').textContent), null, TIMEOUT);
		assert.equal(await page.locator('#import-summary').textContent(), 'No imported card has more than one copy in the same language and finish, so there is nothing to check.');
		assert.equal(await page.locator('.import-group').count(), 0);
		await done();

		({done, page} = await phone({copies: COPIES.slice(0, 5), start: 'trade/check/import'}));
		await page.locator('.import-group').first().waitFor(TIMEOUT);
		await page.locator('.import-group').first().locator('.import-done').click();
		await page.locator('.import-group').first().locator('.import-done').click();
		await page.waitForFunction(() => /^Every group is checked/.test(document.getElementById('import-summary').textContent), null, TIMEOUT);
		assert.equal(await page.locator('#import-summary').textContent(), 'Every group is checked. Show checked lists them.');
		await done();
	});

	test('a hand-added second copy is not the import\'s, so it makes no group', async () => {
		const {done, page} = await phone({copies: [imported('i-01', 'tsa1-004', {variant_id: 'v4-normal'}), copy('h-01', 'tsa1-004', {variant_id: 'v4-normal'})], start: 'trade/check/import'});

		await page.waitForFunction(() => /nothing to check/.test(document.getElementById('import-summary').textContent), null, TIMEOUT);
		await done();
	});

	test('dark, at 360 px: nothing overflows and the buttons are 48 px tall', async () => {
		const {done, page} = await phone({colorScheme: 'dark', start: 'trade/check/import'});

		await page.locator('.import-group').first().waitFor(TIMEOUT);
		assert.ok(await noOverflow(page));

		for (const selector of ['.import-open', '.import-done']) {
			const box = await page.locator(selector).first().boundingBox();

			assert.ok(box.height >= 47.5, `${selector} is ${box.height} px tall`);
		}

		await page.screenshot({fullPage: true, path: `${SHOTS}/copy-cleanup-import-dark.png`});
		await done();
	});
});

describe('Copies with no finish', () => {
	const group = (page, name) => page.locator('.unset-set', {hasText: name});
	const row = (page, name) => page.locator('.unset-card', {hasText: name});

	test('lists the copies by set, with their counts, a card with one printing marked', async () => {
		const {done, page} = await phone({start: 'trade/check/finish'});

		await page.locator('.unset-set').first().waitFor(TIMEOUT);
		assert.equal(await page.locator('#unset-summary').textContent(), '5 copies with no finish set, 4 cards in 2 sets.');
		assert.deepEqual(await page.locator('.unset-set-name').allTextContents(), ['Test Alpha', 'Test Beta']);
		assert.deepEqual(await group(page, 'Test Alpha').locator('.unset-name').allTextContents(), ['Bulbasaur', 'Test Ball']);
		assert.deepEqual(await group(page, 'Test Beta').locator('.unset-name').allTextContents(), ['Pikachu', 'Sprigatito']);
		assert.equal(await group(page, 'Test Alpha').locator('.unset-set-head .check-meta').textContent(), '2 cards, 3 copies');
		assert.equal(await row(page, 'Bulbasaur').locator('.check-meta').first().textContent(), '#001 · English · 2 copies');
		assert.equal(await row(page, 'Test Ball').locator('.check-meta').first().textContent(), '#150 · Portuguese · 1 copy');
		assert.equal(await page.locator('#unset-bar').isHidden(), true, 'nothing ticked, no bar');
		assert.ok(await noOverflow(page));
		await page.screenshot({fullPage: true, path: `${SHOTS}/copy-cleanup-unset.png`});
		await done();
	});

	test('Select all ticks one set, and a second tap clears it', async () => {
		const {done, page} = await phone({start: 'trade/check/finish'});

		await page.locator('.unset-set').first().waitFor(TIMEOUT);

		const alpha = group(page, 'Test Alpha');

		await alpha.locator('.unset-all').click();
		assert.deepEqual(await page.locator('.unset-pick:checked').evaluateAll((boxes) => boxes.map((box) => box.getAttribute('aria-label'))), ['Bulbasaur, English, 2 copies', 'Test Ball, Portuguese, 1 copy']);
		assert.equal(await page.locator('#unset-count').textContent(), '2 cards selected, 3 copies');
		assert.equal(await alpha.locator('.unset-all').textContent(), 'Clear');
		assert.equal(await group(page, 'Test Beta').locator('.unset-all').textContent(), 'Select all');
		assert.equal(await page.locator('#unset-bar').isVisible(), true);

		await alpha.locator('.unset-all').click();
		assert.equal(await page.locator('.unset-pick:checked').count(), 0);
		assert.equal(await page.locator('#unset-bar').isHidden(), true);

		// One card ticked on its own, then Select all ticks the rest.
		await row(page, 'Bulbasaur').locator('.unset-pick').check();
		assert.equal(await page.locator('#unset-count').textContent(), '1 card selected, 2 copies');
		assert.equal(await alpha.locator('.unset-all').textContent(), 'Select all');
		await alpha.locator('.unset-all').click();
		assert.equal(await page.locator('.unset-pick:checked').count(), 2);

		await page.click('#unset-clear');
		assert.equal(await page.locator('.unset-pick:checked').count(), 0);
		await done();
	});

	test('Set finish offers a card\'s only printing first, sets it, and Undo puts the copies and ticks back', async () => {
		const {done, page} = await phone({start: 'trade/check/finish'});

		await page.locator('.unset-set').first().waitFor(TIMEOUT);
		await group(page, 'Test Alpha').locator('.unset-all').click();
		await page.click('#unset-finish');
		await page.locator('#unset-finish-select').waitFor(TIMEOUT);

		// Test Ball has one printing, Normal, so it leads; Reverse holo fits
		// Bulbasaur alone.
		assert.deepEqual(await page.locator('#unset-finish-select option').allTextContents(), ['Normal · only printing of 1 card', 'Reverse holo · 1 of 2']);
		assert.equal(await page.locator('#unset-finish-select').inputValue(), 'Normal');
		assert.match(await page.locator('#unset-note').textContent(), /A card with one printing has it offered first\./);
		await page.screenshot({path: `${SHOTS}/copy-cleanup-unset-sheet.png`});
		await page.click('#unset-save');

		const toast = page.locator('.toast', {hasText: 'Normal set on 3 copies.'});

		await toast.waitFor(TIMEOUT);
		assert.equal(await toast.locator('.toast-text').textContent(), 'Normal set on 3 copies.');

		let cards = new Map((await cardsOf(page)).map((entry) => [entry.id, entry]));

		assert.deepEqual(['u-01', 'u-02', 'u-03'].map((id) => cards.get(id).variant_id), ['v1-normal', 'v1-normal', 'v150-normal']);
		assert.equal(cards.get('u-04').variant_id, null, 'the other set is untouched');
		assert.equal(await group(page, 'Test Alpha').count(), 0, 'the set has no unset copy left');
		assert.equal(await page.locator('#unset-summary').textContent(), '2 copies with no finish set, 2 cards in 1 set.');

		await toast.locator('button', {hasText: 'Undo'}).click();
		await group(page, 'Test Alpha').waitFor(TIMEOUT);
		cards = new Map((await cardsOf(page)).map((entry) => [entry.id, entry]));
		assert.deepEqual(['u-01', 'u-02', 'u-03'].map((id) => cards.get(id).variant_id), [null, null, null]);
		assert.equal(await page.locator('.unset-pick:checked').count(), 2, 'the ticks are back');
		await done();
	});

	test('a finish only some of the cards come in leaves the others as they were, and says so', async () => {
		const {done, page} = await phone({start: 'trade/check/finish'});

		await page.locator('.unset-set').first().waitFor(TIMEOUT);
		await group(page, 'Test Alpha').locator('.unset-all').click();
		await page.click('#unset-finish');
		await page.locator('#unset-finish-select').waitFor(TIMEOUT);
		await page.selectOption('#unset-finish-select', 'Reverse holo');
		await page.click('#unset-save');

		const toast = page.locator('.toast', {hasText: 'Reverse holo set'});

		await toast.waitFor(TIMEOUT);
		assert.equal(await toast.locator('.toast-text').textContent(), 'Reverse holo set on 2 copies. 1 card was left as it was: it does not come in Reverse holo.');

		const cards = new Map((await cardsOf(page)).map((entry) => [entry.id, entry]));

		assert.deepEqual(['u-01', 'u-02', 'u-03'].map((id) => cards.get(id).variant_id), ['v1-reverse', 'v1-reverse', null]);
		assert.equal(await group(page, 'Test Alpha').locator('.unset-name').allTextContents().then((names) => names.join()), 'Test Ball', 'the card left as it was stays listed');
		assert.equal(await page.locator('.unset-pick:checked').count(), 1, 'and stays ticked');
		await done();
	});

	test('a card whose printings the phone has not saved is read from TCGdex, once, and set', async () => {
		const {done, page, seen} = await phone({start: 'trade/check/finish'});

		await page.locator('.unset-set').first().waitFor(TIMEOUT);
		await group(page, 'Test Beta').locator('.unset-all').click();
		await page.click('#unset-finish');
		await page.locator('#unset-finish-select').waitFor(TIMEOUT);

		// Pikachu's printings are saved; Sprigatito's are read.
		assert.deepEqual(seen, ['tsb2-090']);
		assert.deepEqual(await page.locator('#unset-finish-select option').allTextContents(), ['Normal', 'Holo · 1 of 2', 'Reverse holo · 1 of 2']);
		await page.click('#unset-save');
		await page.locator('.toast', {hasText: 'Normal set on 2 copies.'}).waitFor(TIMEOUT);

		const cards = new Map((await cardsOf(page)).map((entry) => [entry.id, entry]));

		assert.deepEqual(['u-04', 'u-05'].map((id) => cards.get(id).variant_id), ['tsb2-090-normal', 'v25-normal']);
		await done();
	});

	test('without a connection to TCGdex the cards not saved are left as they are, and the sheet says why', async () => {
		const {context, done, page} = await phone({start: 'trade/check/finish'});

		await context.route(/api\.tcgdex\.net\/v2\/en\/cards\/tsb2-090/, (route) => route.abort('internetdisconnected'));
		await page.locator('.unset-set').first().waitFor(TIMEOUT);
		await row(page, 'Sprigatito').locator('.unset-pick').check();
		await page.click('#unset-finish');
		await page.locator('#unset-none').waitFor(TIMEOUT);
		assert.equal(await page.locator('#unset-none').textContent(), 'The finishes of these cards could not be read. Go online and try again.');
		assert.equal((await cardsOf(page)).find((entry) => entry.id === 'u-04').variant_id, null);
		await done();
	});

	test('130 cards are read in batches of 60, with the progress said, and every one is set', async () => {
		// 130 cards of one set, one copy each, none with a saved record.
		const base = card('tsa1-001');
		const cards = Array.from({length: 130}, (_, i) => ({...base, id: `tsa1-${String(i + 1).padStart(3, '0')}`, names: {en: `Card ${i + 1}`}}));
		const copies = cards.map((item, i) => copy(`m-${i}`, item.id, {created_at: new Date(Date.UTC(2026, 8, 1) + i * 60000).toISOString()}));
		let open;
		const gate = {after: 60, open: new Promise((resolve) => {
			open = resolve;
		})};
		const {done, page, seen} = await phone({copies, gate, index: indexRecords(cards), records: {}, start: 'trade/check/finish'});

		await page.locator('.unset-set').first().waitFor(TIMEOUT);
		assert.equal(await page.locator('#unset-summary').textContent(), '130 copies with no finish set, 130 cards in 1 set.');
		await page.locator('.unset-all').click();
		assert.equal(await page.locator('#unset-count').textContent(), '130 cards selected, 130 copies');
		await page.click('#unset-finish');

		// The 61st request comes only after the first 60 are read: the
		// first batch is done, and the second is not read yet.
		const end = Date.now() + 20000;

		while (seen.length < 61 && Date.now() < end) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

		assert.ok(seen.length >= 61, `the second batch began (${seen.length} requests)`);
		assert.equal(await page.locator('#unset-progress').textContent(), 'Reading finishes: 60 of 130 cards.');
		assert.equal(await page.locator('#unset-meter').getAttribute('value'), '60');
		assert.equal(await page.locator('#unset-meter').getAttribute('max'), '130');
		assert.ok(seen.length <= 64, `at most four of the next batch were asked for while it waited (${seen.length})`);
		await page.screenshot({path: `${SHOTS}/copy-cleanup-unset-progress.png`});

		open();
		await page.locator('#unset-finish-select').waitFor(TIMEOUT);
		assert.equal(new Set(seen).size, 130, 'every card was read, once');
		assert.equal(seen.length, 130);
		assert.deepEqual(await page.locator('#unset-finish-select option').allTextContents(), ['Holo', 'Normal'], 'every card comes in both, so no count');
		await page.selectOption('#unset-finish-select', 'Holo');
		await page.click('#unset-save');
		await page.locator('.toast', {hasText: 'Holo set on 130 copies.'}).waitFor(TIMEOUT);

		const after = await cardsOf(page);

		assert.equal(after.filter((entry) => entry.variant_id && entry.variant_id.endsWith('-holo')).length, 130, 'none left unknown');
		assert.equal(await page.locator('#unset-summary').textContent(), 'Every copy has a finish set.');
		await done();
	});

	test('nothing unset says so', async () => {
		const {done, page} = await phone({copies: [copy('x-01', 'tsa1-001', {variant_id: 'v1-normal'})], start: 'trade/check/finish'});

		await page.waitForFunction(() => document.getElementById('unset-summary').textContent === 'Every copy has a finish set.', null, TIMEOUT);
		assert.equal(await page.locator('.unset-set').count(), 0);
		await done();
	});

	test('dark, at 360 px: nothing overflows, and the boxes and buttons are 48 px', async () => {
		const {done, page} = await phone({colorScheme: 'dark', start: 'trade/check/finish'});

		await page.locator('.unset-set').first().waitFor(TIMEOUT);
		await page.locator('.unset-all').first().click();
		assert.ok(await noOverflow(page));

		for (const selector of ['.unset-pick-wrap', '.unset-all', '#unset-finish']) {
			const box = await page.locator(selector).first().boundingBox();

			assert.ok(box.height >= 47.5 && box.width >= 43.5, `${selector} is ${box.width} x ${box.height}`);
		}

		await untilInPage(page, 'the bar above the tab bar', () => {
			const bar = document.getElementById('unset-bar').getBoundingClientRect();
			const tabs = document.querySelector('.tabs').getBoundingClientRect();

			return bar.bottom <= tabs.top + 40;
		});
		await page.screenshot({path: `${SHOTS}/copy-cleanup-unset-dark.png`});
		await done();
	});
});
