// Browser test for Phone check's "A set on this phone" (js/set-check.js):
// one set as this phone holds it, read only and with no request: copies,
// distinct cards, by language, the card index records and the sets they
// name, the Pokémon with no Pokédex number, the Sets ring in the viewing
// language and with Any language, the saved set lists, and Copy as plain
// text. Seeded with a record that names the wrong set and a copy with no
// record, the faults a phone that miscounts a set would hold. Headless
// Chromium at 360 x 740 against tests/pages-server.mjs; invented data only.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/set-check-browser.test.mjs
// Screenshot: $SHOTS (default /tmp)/set-check-360.png

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakeRates} from './fake-rates.mjs';
import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const SHOTS = process.env.SHOTS || '/tmp';
const TIMEOUT = {timeout: 15000};
const DAY = 24 * 60 * 60 * 1000;

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

const at = '2026-11-01T12:00:00.000Z';
let copyNumber = 0;
const copy = (card_id, language, extra = {}) => ({
	card_id, catalog: 'international', created_at: at, deleted_at: null, id: `c-${++copyNumber}`, language, language_source: 'manual', updated_at: at, variant_id: null, ...extra,
});

// Test Celebration (tsc1): eight live copies of five cards, and one deleted.
const COPIES = [
	copy('tsc1-001', 'en'), copy('tsc1-001', 'en'), copy('tsc1-001', 'pt'),
	copy('tsc1-002', 'en'),
	copy('tsc1-003', 'pt'),
	copy('tsc1-004', 'en'),
	copy('tsc1-005', 'pt'), copy('tsc1-005', 'pt'),
	copy('tsc1-006', 'en', {deleted_at: at}),
	copy('tsb2-025', 'en'),
];

const record = (id, setId, details = {}) => ({
	catalog: 'international',
	collector_number: id.slice(id.lastIndexOf('-') + 1),
	id,
	localizations: {en: {image: null, lang: 'en', name: `Card ${id}`, set_name: setId === 'tsb2' ? 'Test Beta' : 'Test Celebration'}},
	set_id: setId,
	...details,
});

// tsc1-002's record names tsz9, a set it is not in; tsc1-003 has none;
// tsc1-004 is a Pokémon saved with no Pokédex number.
const INDEX = Object.fromEntries([
	record('tsc1-001', 'tsc1', {category: 'Pokemon', dex_ids: [1]}),
	record('tsc1-002', 'tsz9', {category: 'Pokemon', dex_ids: [4]}),
	record('tsc1-004', 'tsc1', {category: 'Pokemon', dex_ids: []}),
	record('tsc1-005', 'tsc1', {category: 'Trainer', dex_ids: []}),
	record('tsb2-025', 'tsb2', {category: 'Pokemon', dex_ids: [25]}),
].map((item) => [`international|${item.id}`, item]));

const SET_LIST = [{id: 'tst', name: 'Test Series', releaseDate: '2026-11-01', sets: [
	{cardCount: {official: 10, total: 10}, code: 'TSC', id: 'tsc1', logo: null, name: 'Test Celebration', releaseRank: 0},
	{cardCount: {official: 120, total: 120}, code: 'TSB', id: 'tsb2', logo: null, name: 'Test Beta', releaseRank: 1},
]}];

// The English set list saved three days ago, before TCGdex listed tsc1-005.
const savedAt = Date.now() - 3 * DAY - 60000;
const SET_RECORD = {cardCount: {official: 10, total: 10}, cards: ['001', '002', '003', '004'].map((n) => ({id: `tsc1-${n}`, localId: n, name: `Card tsc1-${n}`})), id: 'tsc1', name: 'Test Celebration'};

async function phone() {
	const context = await browser.newContext({serviceWorkers: 'block', viewport: {height: 740, width: 360}});
	const tcgdex = [];

	await fakeRates(context);
	await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin: server.origin});
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await context.route('https://*.supabase.co/**', (route) => route.abort('blockedbyclient'));
	await context.route(/ligapokemon\.com\.br|raw\.githubusercontent\.com|assets\.tcgdex\.net/, (route) => route.fulfill({status: 404}));
	await context.route('https://api.tcgdex.net/**', (route) => {
		tcgdex.push(route.request().url());

		return route.fulfill({body: '{}', contentType: 'application/json', status: 503});
	});

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err.message));
	await page.goto(`${server.origin}${BASE}check`);
	await page.evaluate(async ({copies, index, records}) => {
		const put = (name, store, entries) => new Promise((resolve, reject) => {
			const open = indexedDB.open(name, 1);

			open.onupgradeneeded = () => open.result.createObjectStore(store);
			open.onsuccess = () => {
				const tx = open.result.transaction(store, 'readwrite');

				for (const [key, value] of entries) {
					tx.objectStore(store).put(value, key);
				}

				tx.oncomplete = () => {
					open.result.close();
					resolve();
				};
				tx.onerror = () => reject(tx.error);
			};
			open.onerror = () => reject(open.error);
		});

		await put('card-tracker-collection', 'documents', [['local', {binders: [], cards: copies, collections: [], goals: [], openings: [], person: 'local', updated_at: '2026-11-01T12:00:00.000Z', user_id: null, version: 1, wishlist: []}]]);
		await put('card-tracker-catalog', 'responses', [['index:cards', {at: Date.now(), data: index}], ...Object.entries(records)]);
	}, {copies: COPIES, index: INDEX, records: {'set:en:tsc1': {at: savedAt, data: SET_RECORD}, 'setlist4:en': {at: Date.now(), data: SET_LIST}}});
	await page.reload();

	return {context, errors, page, tcgdex};
}

describe('Phone check: a set on this phone', () => {
	test('shows the set as this phone holds it, the faults included, and copies it as text', async () => {
		const {context, errors, page, tcgdex} = await phone();

		await page.waitForFunction(() => {
			const select = document.getElementById('set-check-set');

			return select && !select.disabled;
		}, null, TIMEOUT);

		// The sets owned, by name: each under the set its ID begins with and
		// the set its record names, so the wrong tsz9 shows as its own set.
		assert.deepEqual(await page.locator('#set-check-set option').allTextContents(), [
			'Pick a set',
			'Test Beta (tsb2) · 1 copy',
			'Test Celebration (tsc1) · 8 copies',
			'Test Celebration (tsz9) · 1 copy',
		]);

		const asked = tcgdex.length;

		await page.selectOption('#set-check-set', 'international|tsc1');
		await page.waitForFunction(() => !document.getElementById('set-check-copy').disabled, null, TIMEOUT);

		const rows = await page.locator('#set-check-table tr').evaluateAll((trs) => trs.map((tr) => [tr.querySelector('th').textContent, tr.querySelector('td').textContent]));
		const shown = Object.fromEntries(rows);

		assert.match(shown['Report time'], /\d/);
		assert.deepEqual(rows.map(([label]) => label), [
			'Report time',
			'Set',
			'Copies',
			'Distinct cards',
			'In Portuguese',
			'In English',
			'Cards with an index record',
			'Cards with no index record',
			'Set the records name',
			'Records naming another set',
			'Pokémon with no Pokédex number',
			'Counted in this set by the Sets tab',
			'Sets ring in English',
			'Sets ring with Any language',
			'Sets tab Owned switch',
			'Saved set list in Portuguese',
			'Saved set list in English',
		]);
		assert.equal(shown.Set, 'Test Celebration (tsc1)');
		assert.equal(shown.Copies, '8', 'the deleted copy and the other set are left out');
		assert.equal(shown['Distinct cards'], '5');
		assert.equal(shown['In Portuguese'], '4 copies, 3 cards');
		assert.equal(shown['In English'], '4 copies, 3 cards');
		assert.equal(shown['Cards with an index record'], '4');
		assert.equal(shown['Cards with no index record'], '1: tsc1-003');
		assert.equal(shown['Set the records name'], 'tsc1 (3), tsz9 (1)');
		assert.equal(shown['Records naming another set'], '1: tsc1-002 (tsz9)');
		assert.equal(shown['Pokémon with no Pokédex number'], '1: tsc1-004');
		// The Sets tab counts tsc1-002 under tsz9, its record's set, and the
		// recordless tsc1-003 under tsc1, its ID's.
		assert.equal(shown['Counted in this set by the Sets tab'], '4 cards, 7 copies');
		assert.equal(shown['Sets ring in English'], '2 / 10', 'tsc1-001 and tsc1-004 have an English copy');
		assert.equal(shown['Sets ring with Any language'], '4 / 10');
		assert.equal(shown['Sets tab Owned switch'], 'In the viewing language (English)');
		assert.equal(shown['Saved set list in Portuguese'], 'Not saved on this phone');
		assert.match(shown['Saved set list in English'], /^Saved .+, 3 days ago; lists 4 cards; 1 owned not listed: tsc1-005$/);

		// Copy: the same rows as plain text.
		await page.click('#set-check-copy');
		await page.waitForFunction(() => /^Copied/.test(document.getElementById('set-check-status').textContent), null, TIMEOUT);

		const text = await page.evaluate(() => navigator.clipboard.readText());

		assert.equal(text, ['Card Tracker set check', ...rows.map(([label, value]) => `${label}: ${value}`)].join('\n'));
		assert.match(text, /\nRecords naming another set: 1: tsc1-002 \(tsz9\)\n/);
		assert.match(text, /\nSets ring in English: 2 \/ 10\n/);
		assert.equal(tcgdex.length, asked, 'nothing asked of TCGdex');

		// The ring follows the Sets tab's Owned switch rule, not a copy of it.
		await page.evaluate(() => localStorage.setItem('cardTracker.setsOwnedIn', 'any'));
		await page.selectOption('#set-check-set', '');
		await page.selectOption('#set-check-set', 'international|tsc1');
		await page.waitForFunction(() => /Any language/.test([...document.querySelectorAll('#set-check-table td')].map((td) => td.textContent).join('|')), null, TIMEOUT);

		// Fits 360 px: no sideways scroll, text 14 px or more, targets 44 px or more.
		const layout = await page.evaluate(() => ({
			copy: document.getElementById('set-check-copy').getBoundingClientRect().height,
			fonts: [...document.querySelectorAll('#set-check th, #set-check td, #set-check select, #set-check button, #set-check label, #set-check p')].map((node) => parseFloat(getComputedStyle(node).fontSize)),
			select: document.getElementById('set-check-set').getBoundingClientRect(),
			wide: document.documentElement.scrollWidth,
		}));

		assert.ok(layout.wide <= 360, `no sideways scroll (${layout.wide} px)`);
		assert.ok(layout.fonts.every((size) => size >= 14), `text 14 px or more (${Math.min(...layout.fonts)} px)`);
		assert.ok(layout.copy >= 44 && layout.select.height >= 44, 'targets 44 px or more');
		assert.ok(layout.select.right <= 360, 'the select fits');
		await page.evaluate(() => window.scrollTo(0, document.getElementById('set-check').getBoundingClientRect().top + window.scrollY - 64));
		await page.screenshot({path: `${SHOTS}/set-check-360.png`});
		assert.deepEqual(errors, []);
		await context.close();
	});
});
