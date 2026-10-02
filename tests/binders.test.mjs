// Tests for binders (js/binders.js and js/binders-view.js).
//
// The first part is plain Node: the one-pocket rule, moves, page math, and
// what survives a merge. The second drives headless Chromium at 360 x 740
// against tests/pages-server.mjs, with every outside service faked: TCGdex,
// and Supabase through tests/fake-supabase.mjs (signed out, any Supabase
// request fails the test).
//
// The browser tests run against the real app.js, index.html, and sw.js,
// served untouched. INTEGRATION below holds the binder lines those files
// carry, and a test asserts that each one is there.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/binders.test.mjs

import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {
	binderStats,
	cellOf,
	clampPage,
	cleanFields,
	coverTextColor,
	locate,
	nextStamp,
	pageOfPocket,
	pageSlots,
	placeholdersFor,
	placements,
	positionOf,
	setPocket,
	slotsOf,
	slotsOutside,
	totalPockets,
	unplaced,
	validGrid,
} from '../js/binders.js';
import {mergeDocuments} from '../js/merge.js';

const at = (minute) => `2026-10-01T10:${String(minute).padStart(2, '0')}:00.000Z`;

const binderOf = (id, fields = {}) => ({
	art: [],
	cols: 3,
	cover_color: '#1b1b1f',
	created_at: at(0),
	deleted_at: null,
	id,
	name: `Binder ${id}`,
	notes: '',
	page_count: 4,
	rows: 3,
	slots: [],
	updated_at: at(0),
	...fields,
});

const card = (id, fields = {}) => ({card_id: `tst1-${id}`, catalog: 'international', created_at: at(0), deleted_at: null, id, language: 'pt', updated_at: at(0), ...fields});

// Applies changed binders the way mergeIntoLocal does.
const apply = (binders, changed) => mergeDocuments({binders}, {binders: changed}).binders;

const where = (binders, entryId) => {
	const found = locate(binders, entryId);

	return found && `${found.binder_id}:${found.page}:${found.position}`;
};

const count = (binders, entryId) => binders.flatMap((binder) => binder.slots).filter((slot) => slot.entry_id === entryId).length;

// ------------------------------------------------------------ unit tests

describe('grid and page math', () => {
	test('grids run from 1 x 1 to 5 x 4 either way up, never 5 x 5', () => {
		assert.ok(validGrid(1, 1));
		assert.ok(validGrid(3, 3));
		assert.ok(validGrid(5, 4));
		assert.ok(validGrid(4, 5));
		assert.ok(!validGrid(5, 5));
		assert.ok(!validGrid(0, 3));
		assert.ok(!validGrid(6, 1));
		assert.ok(!validGrid(2.5, 2));
	});

	test('positions run across each row, then down', () => {
		const binder = binderOf('a', {cols: 4, rows: 3});

		assert.deepEqual(cellOf(binder, 1), {col: 1, row: 1});
		assert.deepEqual(cellOf(binder, 4), {col: 4, row: 1});
		assert.deepEqual(cellOf(binder, 5), {col: 1, row: 2});
		assert.deepEqual(cellOf(binder, 12), {col: 4, row: 3});
		assert.equal(positionOf(binder, 2, 3), 7);
		assert.equal(totalPockets(binder), 48);
	});

	test('a pocket number across the binder maps to its page and position', () => {
		const binder = binderOf('a');

		assert.deepEqual(pageOfPocket(binder, 1), {page: 1, position: 1});
		assert.deepEqual(pageOfPocket(binder, 9), {page: 1, position: 9});
		assert.deepEqual(pageOfPocket(binder, 10), {page: 2, position: 1});
		assert.deepEqual(pageOfPocket(binder, 36), {page: 4, position: 9});
	});

	test('page numbers are clamped to the binder', () => {
		const binder = binderOf('a');

		assert.equal(clampPage(binder, 0), 1);
		assert.equal(clampPage(binder, '3'), 3);
		assert.equal(clampPage(binder, 99), 4);
		assert.equal(clampPage(binder, 'x'), 1);
	});

	test('fields are checked and tidied', () => {
		assert.deepEqual(cleanFields({cols: '4', cover_color: '#ABCDEF', name: '  Mega  ', notes: ' hi ', page_count: '20', rows: '5'}),
			{cols: 4, cover_color: '#abcdef', name: 'Mega', notes: 'hi', page_count: 20, rows: 5});
		assert.equal(cleanFields({cols: 3, cover_color: 'red', name: 'x', page_count: 1, rows: 3}).cover_color, '#1d2e60');
		assert.throws(() => cleanFields({cols: 3, name: ' ', page_count: 1, rows: 3}), /needs a name/);
		assert.throws(() => cleanFields({cols: 5, name: 'x', page_count: 1, rows: 5}), /5 x 4/);
		assert.throws(() => cleanFields({cols: 3, name: 'x', page_count: 0, rows: 3}), /Pages run/);
		assert.throws(() => cleanFields({cols: 3, name: 'x', page_count: 201, rows: 3}), /Pages run/);
	});

	test('cover text is white on dark covers and dark on light ones', () => {
		assert.equal(coverTextColor('#1b1b1f'), '#ffffff');
		assert.equal(coverTextColor('#1d2e60'), '#ffffff');
		assert.equal(coverTextColor('#ffcb05'), '#1b1b1f');
		assert.equal(coverTextColor('#f4f4f6'), '#1b1b1f');
	});

	test('a new stamp is always newer than the last one', () => {
		const now = Date.parse(at(5));

		assert.equal(nextStamp(at(1), now), at(5));
		assert.equal(nextStamp(at(5), now), '2026-10-01T10:05:00.001Z');
		assert.equal(nextStamp(at(9), now), '2026-10-01T10:09:00.001Z');
		assert.equal(nextStamp(null, now), at(5));
	});
});

describe('the one-pocket rule', () => {
	test('placing a copy fills the pocket and bumps the binder', () => {
		let binders = [binderOf('a')];
		const changed = setPocket(binders, {at: at(1), binderId: 'a', content: {entry_id: 'c1'}, page: 1, position: 1});

		assert.equal(changed.length, 1);
		assert.equal(changed[0].updated_at, at(1));
		assert.equal(binders[0].slots.length, 0, 'the input is not changed');
		binders = apply(binders, changed);
		assert.equal(where(binders, 'c1'), 'a:1:1');
	});

	test('placing a copy that is in another binder moves it, and both binders change', () => {
		let binders = [binderOf('a'), binderOf('b')];

		binders = apply(binders, setPocket(binders, {at: at(1), binderId: 'a', content: {entry_id: 'c1'}, page: 2, position: 5}));

		const changed = setPocket(binders, {at: at(2), binderId: 'b', content: {entry_id: 'c1'}, page: 1, position: 3});

		assert.deepEqual(changed.map((binder) => binder.id).sort(), ['a', 'b']);
		binders = apply(binders, changed);
		assert.equal(where(binders, 'c1'), 'b:1:3');
		assert.equal(count(binders, 'c1'), 1, 'the copy sits in one pocket');
		assert.equal(binders.find((binder) => binder.id === 'a').slots.length, 0, 'the old pocket is empty');
	});

	test('a move inside one binder leaves the old pocket empty', () => {
		let binders = [binderOf('a')];

		binders = apply(binders, setPocket(binders, {at: at(1), binderId: 'a', content: {entry_id: 'c1'}, page: 1, position: 1}));
		binders = apply(binders, setPocket(binders, {at: at(2), binderId: 'a', content: {entry_id: 'c1'}, page: 3, position: 9}));
		assert.equal(where(binders, 'c1'), 'a:3:9');
		assert.equal(count(binders, 'c1'), 1);
	});

	test('a pocket holds one thing: a new card replaces what was there', () => {
		let binders = [binderOf('a')];

		binders = apply(binders, setPocket(binders, {at: at(1), binderId: 'a', content: {entry_id: 'c1'}, page: 1, position: 1}));
		binders = apply(binders, setPocket(binders, {at: at(2), binderId: 'a', content: {entry_id: 'c2'}, page: 1, position: 1}));
		assert.equal(where(binders, 'c2'), 'a:1:1');
		assert.equal(where(binders, 'c1'), null, 'the replaced copy is unplaced');
		assert.equal(binders[0].slots.length, 1);
	});

	test('placeholders, empty on purpose, and taking out', () => {
		let binders = [binderOf('a')];
		const want = {card_id: 'tst1-025', catalog: 'international', image: null, name: 'Pikachu', variant_id: null};

		binders = apply(binders, setPocket(binders, {at: at(1), binderId: 'a', content: {want}, page: 1, position: 2}));
		binders = apply(binders, setPocket(binders, {at: at(2), binderId: 'a', content: {empty: true}, page: 1, position: 3}));
		binders = apply(binders, setPocket(binders, {at: at(3), binderId: 'a', content: {entry_id: 'c1'}, page: 1, position: 4}));

		const slots = pageSlots(binders[0], 1, placements(binders));

		assert.equal(slots.get(2).want.name, 'Pikachu');
		assert.equal(slots.get(3).empty, true);
		assert.equal(slots.get(4).entry_id, 'c1');
		assert.deepEqual(placeholdersFor(binders, 'international', 'tst1-025'), [{binder_id: 'a', binder_name: 'Binder a', page: 1, position: 2}]);
		assert.deepEqual(placeholdersFor(binders, 'ja', 'tst1-025'), [], 'a placeholder is for one catalog');

		binders = apply(binders, setPocket(binders, {at: at(4), binderId: 'a', content: null, page: 1, position: 4}));
		assert.equal(where(binders, 'c1'), null, 'taking a card out leaves the pocket empty');
		assert.equal(pageSlots(binders[0], 1, placements(binders)).has(4), false);
	});

	test('pockets outside the grid are refused', () => {
		const binders = [binderOf('a')];

		assert.throws(() => setPocket(binders, {binderId: 'a', content: {empty: true}, page: 5, position: 1}), /not in this binder/);
		assert.throws(() => setPocket(binders, {binderId: 'a', content: {empty: true}, page: 1, position: 10}), /not in this binder/);
		assert.throws(() => setPocket(binders, {binderId: 'zz', content: {empty: true}, page: 1, position: 1}), /not on this phone/);
	});

	test('unplaced and stats count live copies only', () => {
		let binders = [binderOf('a'), binderOf('b', {deleted_at: at(1), updated_at: at(1)})];
		const cards = [card('c1'), card('c2'), card('c3'), card('c4', {deleted_at: at(1)})];

		// A copy in a deleted binder is unplaced.
		binders[1].slots = [{entry_id: 'c3', page: 1, placed_at: at(0), position: 1}];
		binders = apply(binders, setPocket(binders, {at: at(2), binderId: 'a', content: {entry_id: 'c1'}, page: 1, position: 1}));
		binders = apply(binders, setPocket(binders, {at: at(3), binderId: 'a', content: {entry_id: 'c4'}, page: 1, position: 2}));
		binders = apply(binders, setPocket(binders, {at: at(4), binderId: 'a', content: {want: {card_id: 'x'}}, page: 1, position: 3}));

		assert.deepEqual(unplaced(cards, binders).map((entry) => entry.id), ['c2', 'c3']);

		const live = new Set(cards.filter((entry) => !entry.deleted_at).map((entry) => entry.id));

		assert.deepEqual(binderStats(binders[0], placements(binders), live), {filled: 1, total: 36, wanted: 1}, 'a deleted copy does not count as filled');
	});

	test('a smaller grid or fewer pages names the pockets that fall off', () => {
		const binder = binderOf('a', {
			art: [{first_position: 1, id: 'art1', page: 1}],
			slots: [
				{entry_id: 'c1', page: 1, placed_at: at(0), position: 9},
				{entry_id: 'c2', page: 4, placed_at: at(0), position: 1},
				{entry_id: 'c3', page: 1, placed_at: at(0), position: 1},
				{art: {art_id: 'art1', tile: 0}, page: 2, position: 1},
			],
		});

		assert.deepEqual(slotsOutside(binder, {cols: 3, page_count: 3, rows: 3}).map((slot) => slot.entry_id), ['c2']);
		assert.deepEqual(slotsOutside(binder, {cols: 2, page_count: 4, rows: 2}).map((slot) => slot.entry_id || 'art').sort(), ['art', 'c1']);
		assert.deepEqual(slotsOutside(binder, {cols: 4, page_count: 4, rows: 3}).map((slot) => slot.entry_id || 'art'), ['art'], 'art goes when the shape changes');
	});
});

describe('surviving a merge', () => {
	test('a binder made on one phone survives a merge with the other', () => {
		const phone = mergeDocuments({binders: [binderOf('a')]}, {binders: [binderOf('b')]});

		assert.deepEqual(phone.binders.map((binder) => binder.id).sort(), ['a', 'b']);
	});

	test('a deleted binder stays deleted when an older copy comes back', () => {
		const deleted = binderOf('a', {deleted_at: at(5), updated_at: at(5)});
		const older = binderOf('a', {name: 'edited offline', updated_at: at(3)});

		for (const merged of [mergeDocuments({binders: [deleted]}, {binders: [older]}), mergeDocuments({binders: [older]}, {binders: [deleted]})]) {
			assert.equal(merged.binders.length, 1);
			assert.equal(merged.binders[0].deleted_at, at(5));
		}
	});

	test('the newer edit of a binder wins, pockets and all', () => {
		let base = [binderOf('a')];

		base = apply(base, setPocket(base, {at: at(1), binderId: 'a', content: {entry_id: 'c1'}, page: 1, position: 1}));

		const phoneA = apply(base, setPocket(base, {at: at(2), binderId: 'a', content: {entry_id: 'c2'}, page: 1, position: 2}));
		const phoneB = apply(base, setPocket(base, {at: at(3), binderId: 'a', content: {entry_id: 'c3'}, page: 1, position: 3}));
		const merged = mergeDocuments({binders: phoneA}, {binders: phoneB}).binders;

		assert.equal(where(merged, 'c1'), 'a:1:1');
		assert.equal(where(merged, 'c3'), 'a:1:3');
		assert.equal(where(merged, 'c2'), null, 'the older edit of the same binder is lost, as with any entry');
	});

	test('a move on one phone and an edit of the old binder on the other still leave the copy in one pocket', () => {
		let base = [binderOf('a'), binderOf('b')];

		base = apply(base, setPocket(base, {at: at(1), binderId: 'a', content: {entry_id: 'c1'}, page: 1, position: 1}));

		// Phone A moves c1 from binder a to binder b at minute 2. Phone B,
		// offline, places c2 in binder a at minute 3, so its binder a (still
		// holding c1) is the newer one and wins the merge.
		const phoneA = apply(base, setPocket(base, {at: at(2), binderId: 'b', content: {entry_id: 'c1'}, page: 1, position: 5}));
		const phoneB = apply(base, setPocket(base, {at: at(3), binderId: 'a', content: {entry_id: 'c2'}, page: 1, position: 2}));

		for (const merged of [mergeDocuments({binders: phoneA}, {binders: phoneB}).binders, mergeDocuments({binders: phoneB}, {binders: phoneA}).binders]) {
			assert.equal(count(merged, 'c1'), 2, 'both binders still hold it in storage');
			assert.equal(where(merged, 'c1'), 'b:1:5', 'the pocket placed last is the real one');
			assert.equal(where(merged, 'c2'), 'a:1:2');

			const a = merged.find((binder) => binder.id === 'a');

			assert.equal(pageSlots(a, 1, placements(merged)).has(1), false, 'the stale pocket reads as empty');
			assert.deepEqual(unplaced([card('c1'), card('c2'), card('c3')], merged).map((entry) => entry.id), ['c3']);

			// The next save of binder a drops the stale slot.
			const cleaned = apply(merged, setPocket(merged, {at: at(4), binderId: 'a', content: {empty: true}, page: 1, position: 9}));

			assert.equal(count(cleaned, 'c1'), 1);
			assert.equal(where(cleaned, 'c1'), 'b:1:5');
		}
	});

	test('two copies in one pocket after a merge show the one placed last', () => {
		const binder = binderOf('a', {slots: [
			{entry_id: 'c1', page: 1, placed_at: at(1), position: 1},
			{entry_id: 'c2', page: 1, placed_at: at(2), position: 1},
		]});

		assert.deepEqual(slotsOf(binder).map((slot) => slot.entry_id), ['c2']);
	});
});

// ---------------------------------------------------- the integration

// The binder lines in app.js, index.html, and sw.js. Each must be in the
// real file, so a change to those files that drops one fails here first.
export const INTEGRATION = {
	'app.js': [
		/^import \{binderAccountViews, binderRoutes\} from '\.\/js\/binders-view\.js';$/m,
		/const ROUTES = \[\n(?:(?!\n\];)[\s\S])*?\n\t\.\.\.binderRoutes,\n/,
		/const ACCOUNT_ROUTES = new Set\(\[[^\]]*?, \.\.\.binderAccountViews[,\]]/,
	],
	'index.html': [
		/<link rel="stylesheet" href="\/pokemon-card-tracker\/style\.css">\n\t<link rel="stylesheet" href="\/pokemon-card-tracker\/css\/binders\.css">\n/,
		/<nav class="tabs"[^>]*>\n(?:(?!<\/nav>)[\s\S])*?\t<a href="\/pokemon-card-tracker\/binders" data-link="binders" data-tab="binders">\n(?:(?!<\/a>)[\s\S])*?<span class="tab-label">Binders<\/span>\n\t*<\/a>\n[\s\S]*?<\/nav>/,
	],
	'sw.js': [
		/^\t'js\/binders-view\.js',$/m,
		/^\t'js\/binders\.js',$/m,
		/^\t'css\/binders\.css',$/m,
	],
};

describe('the integration', () => {
	test('app.js, index.html, and sw.js carry the binder lines', async () => {
		for (const [file, patterns] of Object.entries(INTEGRATION)) {
			const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');

			for (const pattern of patterns) {
				assert.match(text, pattern, `${file} carries ${pattern}`);
			}
		}
	});

	test('sw.js lists every module in js/', async () => {
		const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
		const unlisted = (await readdir(new URL('../js/', import.meta.url))).filter((name) => name.endsWith('.js') && !sw.includes(`\t'js/${name}',\n`));

		assert.deepEqual(unlisted, []);
	});
});

// ------------------------------------------------------ browser tests

let chromium = null;

try {
	({chromium} = createRequire(import.meta.url)(process.env.PLAYWRIGHT || 'playwright'));
}
catch {
	// No Playwright: the browser tests are skipped below.
}

const BASE = '/pokemon-card-tracker/';
const VIEWPORT = {height: 740, width: 360};

const AT = '2026-09-01T00:00:00.000Z';

const entry = (id, fields) => ({created_at: AT, deleted_at: null, id, language: 'pt', language_source: 'import', updated_at: AT, ...fields});

// Made-up cards: three live copies and one deleted.
const CARDS = [
	entry('c1', {card_id: 'tst1-001', catalog: 'international'}),
	entry('c2', {card_id: 'tst1-004', catalog: 'international', language: 'en'}),
	entry('c3', {card_id: 'tst1-007', catalog: 'international'}),
	entry('c4', {card_id: 'tst1-150', catalog: 'international', deleted_at: AT}),
];

const record = (id, number, name) => ({
	catalog: 'international',
	collector_number: number,
	id,
	localizations: {en: {image: null, lang: 'en', name, set_name: 'Test set one'}},
	set_id: 'tst1',
});

// The card index for the first two; the third is read from TCGdex.
const RECORDS = [record('tst1-001', '001', 'Test Bulbasaur'), record('tst1-004', '004', 'Test Charmander')];

const SINGLE_CARDS = {
	'en/cards/tst1-001': {id: 'tst1-001', image: null, localId: '001', name: 'Test Bulbasaur', set: {id: 'tst1', name: 'Test set one'}},
	'en/cards/tst1-004': {id: 'tst1-004', image: null, localId: '004', name: 'Test Charmander', set: {id: 'tst1', name: 'Test set one'}},
	'en/cards/tst1-007': {id: 'tst1-007', image: null, localId: '007', name: 'Test Squirtle', set: {id: 'tst1', name: 'Test set one'}},
	'en/cards/tst2-025': {id: 'tst2-025', image: null, localId: '025', name: 'Test Pikachu', set: {id: 'tst2', name: 'Test set two'}},
};

const SEARCH = [
	{id: 'tst2-025', localId: '025', name: 'Test Pikachu'},
	{id: 'tst3-026', localId: '026', name: 'Test Pikachu ex'},
];

function documentWith(cards, binders = []) {
	return {binders, cards, collections: [], goals: [], openings: [], person: 'local', updated_at: AT, user_id: null, version: 1, wishlist: []};
}

async function fakeServices(context, counts, net) {
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());

	await context.route('https://api.tcgdex.net/**', (route) => {
		if (net.offline) {
			return route.abort('internetdisconnected');
		}

		const url = new URL(route.request().url());
		const path = url.pathname.replace('/v2/', '');

		if (path === 'en/cards' && url.searchParams.has('name')) {
			counts.search++;

			const query = url.searchParams.get('name').toLowerCase();

			return route.fulfill({body: JSON.stringify(SEARCH.filter((item) => item.name.toLowerCase().includes(query))), contentType: 'application/json', status: 200});
		}

		if (SINGLE_CARDS[path]) {
			counts.single++;

			return route.fulfill({body: JSON.stringify(SINGLE_CARDS[path]), contentType: 'application/json', status: 200});
		}

		return route.fulfill({body: '{}', contentType: 'application/json', status: 404});
	});

	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));
	await context.route(/pokeapi|githubusercontent/, (route) => route.abort());
}

async function device(fake, name, {serviceWorkers = 'block'} = {}) {
	const context = await browser.newContext({serviceWorkers, viewport: VIEWPORT});
	const counts = {search: 0, single: 0};
	const net = {offline: false};

	await fakeServices(context, counts, net);

	if (fake) {
		await fake.attach(context, name);
	}
	else {
		await context.route('https://*.supabase.co/**', (route) => {
			throw new Error(`Unexpected Supabase request: ${route.request().url()}`);
		});
	}

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err));

	return {context, counts, errors, net, page};
}

let pages;
let origin;
let browser;

const url = (path = '') => `${origin}${BASE}${path}`;

async function seedLocal(page, doc, records = []) {
	await page.goto(url('cards'));
	await page.evaluate(async ({stored, cards}) => {
		await new Promise((resolve, reject) => {
			const open = indexedDB.open('card-tracker-collection', 1);

			open.onupgradeneeded = () => open.result.createObjectStore('documents');
			open.onsuccess = () => {
				const tx = open.result.transaction('documents', 'readwrite');

				tx.objectStore('documents').put(stored, 'local');
				tx.oncomplete = () => {
					open.result.close();
					resolve();
				};
				tx.onerror = () => reject(tx.error);
			};
			open.onerror = () => reject(open.error);
		});
		await (await import('/pokemon-card-tracker/js/catalog.js')).saveToCardIndex(cards);
	}, {cards: records, stored: doc});
	await page.reload();
}

const localDoc = (page) => page.evaluate(async () => (await import('/pokemon-card-tracker/js/collection.js')).loadDocument());

const shownErrors = (page) => page.locator('#errors .error').allTextContents();

// A pocket: on the page zoomed open (a phone held upright places cards
// there), or with pg, on that page of the spread.
const pocketAt = (n, pg = null) => (pg
	? `#bs-spread .bs-page[data-page="${pg}"] .pocket[data-position="${n}"]`
	: `#bs-zoom-sheet .pocket[data-position="${n}"]`);

const pocket = (page, n, pg = null) => page.locator(pocketAt(n, pg));

async function kindOf(page, n, pg = null) {
	return pocket(page, n, pg).getAttribute('data-kind');
}

async function waitForKind(page, n, kind, pg = null) {
	await page.waitForFunction(({selector, wanted}) => {
		const el = document.querySelector(selector);

		return el && el.dataset.kind === wanted;
	}, {selector: pocketAt(n, pg), wanted: kind}, {timeout: 10000});
}

// The spread at rest on spread k, no page turning.
async function waitForSpread(page, k) {
	await page.waitForFunction((wanted) => {
		const root = document.getElementById('binder-spread');

		return root && root.dataset.view === 'spread' && root.dataset.spread === wanted && !root.dataset.turning;
	}, String(k), {timeout: 10000});
}

async function waitForZoom(page, pg) {
	await page.waitForFunction((wanted) => {
		const root = document.getElementById('binder-spread');

		return root && root.dataset.zoom === wanted && root.querySelector(`#bs-zoom-sheet .bs-page[data-page="${wanted}"]`);
	}, String(pg), {timeout: 10000});
}

// Opens page pg of the spread at full size, as a tap on it does.
async function openPage(page, pg) {
	await page.click(`.bs-open[data-open="${pg}"]`);
	await waitForZoom(page, pg);
}

async function signIn(page, fake, email) {
	await page.goto(url('signin'));
	await page.fill('#signin-email', email);
	await page.click('button:has-text("Send link")');
	await page.waitForSelector('#check-email');

	const code = fake.issueCode(email);

	await page.goto(`${url()}?code=${code}`);
	await page.waitForSelector('#account.avatar');
}

async function waitForStatus(page, text) {
	await page.waitForFunction((expected) => {
		const line = document.getElementById('sync-status');

		return line && !line.hidden && line.textContent === expected;
	}, text, {timeout: 15000});
}

async function until(check, timeout = 15000) {
	const end = Date.now() + timeout;

	while (!check()) {
		if (Date.now() > end) {
			throw new Error('Timed out waiting.');
		}

		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

describe('binders in the browser', {skip: chromium ? false : 'Playwright is not installed; set PLAYWRIGHT'}, () => {
	before(async () => {
		const {startPagesServer} = await import('./pages-server.mjs');

		pages = await startPagesServer();
		origin = pages.origin;
		browser = await chromium.launch();
	});

	after(async () => {
		await browser?.close();
		await pages?.close();
	});

	test('make a binder, place cards once each, add a placeholder, page through, reload, and reopen offline', async () => {
		const {context, counts, errors, net, page} = await device(null, 'phone', {serviceWorkers: 'allow'});

		await seedLocal(page, documentWith(CARDS), RECORDS);

		// The tab and the empty state.
		await page.click('.tabs a[data-tab="binders"]');
		await page.waitForSelector('#new-binder');
		assert.equal(new URL(page.url()).pathname, `${BASE}binders`);
		assert.equal(await page.locator('.tabs a[data-tab="binders"]').getAttribute('aria-current'), 'page');
		assert.match(await page.locator('.empty-state').textContent(), /No binders yet/);
		assert.equal(await page.locator('#unplaced-link').textContent(), '3 owned cards not in any binder');
		await page.screenshot({path: '/tmp/binders-empty.png'});

		// Create "Generations 1 and 2" with a black cover, 3 x 3, 3 pages.
		await page.click('#new-binder');
		await page.fill('#binder-name', 'Generations 1 and 2');
		await page.fill('#binder-notes', 'Kanto and Johto in Dex order');
		await page.click('.cover-swatch[title="Black"]');
		await page.click('.grid-pick[data-grid="3x4"]');
		assert.equal(await page.locator('#binder-grid-note').textContent(), '12 pockets a page.');
		await page.selectOption('#binder-rows', '5');
		await page.selectOption('#binder-cols', '5');
		assert.equal(await page.locator('#binder-grid-note').textContent(), 'Grids run up to 5 × 4 or 4 × 5.');
		await page.selectOption('#binder-cols', '4');
		assert.equal(await page.locator('#binder-grid-note').textContent(), '20 pockets a page.');
		await page.click('.grid-pick[data-grid="3x3"]');
		await page.fill('#binder-pages', '3');
		await page.screenshot({path: '/tmp/binders-form.png', fullPage: true});
		await page.click('#binder-save');
		await page.waitForURL(/\/binders\/[0-9a-f-]+$/);
		await page.waitForSelector('#binder-spread .bs-page');

		const binderId = new URL(page.url()).pathname.split('/').pop();

		// It opens like a real binder: page 1 alone on the right, the inside
		// cover on the left.
		assert.equal(await page.locator('#binder-title').textContent(), 'Generations 1 and 2');
		assert.equal(await page.locator('#binder-meta').textContent(), '3 × 3 · 3 pages');
		assert.equal(await page.locator('#bs-spread .bs-side-right .bs-page[data-page="1"] .pocket').count(), 9);
		assert.equal(await page.locator('#bs-spread .bs-side-left .bs-inside').count(), 1);
		assert.equal(await page.locator('#bs-jump').inputValue(), '1');
		assert.ok(await page.locator('#bs-prev').isDisabled());

		let doc = await localDoc(page);
		let binder = doc.binders[0];

		assert.equal(doc.binders.length, 1);
		assert.deepEqual({cols: binder.cols, cover: binder.cover_color, name: binder.name, notes: binder.notes, pages: binder.page_count, rows: binder.rows},
			{cols: 3, cover: '#1b1b1f', name: 'Generations 1 and 2', notes: 'Kanto and Johto in Dex order', pages: 3, rows: 3});
		assert.ok(binder.id && binder.updated_at && binder.deleted_at === null);

		// A phone held upright shows the spread as an overview: tap page 1 to
		// open it, then place an owned card. The picker opens on "Not in a
		// binder yet".
		await openPage(page, 1);
		await pocket(page, 1).click();
		await page.waitForSelector('#pocket-sheet[open]');
		assert.equal(await page.locator('#sheet-title').textContent(), 'Page 1, pocket 1');
		assert.ok(await page.locator('#owned-filter input[value="unplaced"]').isChecked());
		assert.equal(await page.locator('#owned-count').textContent(), '3 cards not in a binder yet.');
		// The third card's name is read from TCGdex for the picker.
		await page.waitForSelector('#owned-results .pick:has-text("Test Squirtle")');
		await page.screenshot({path: '/tmp/binders-picker.png'});
		await page.fill('#owned-search', 'bulba');
		assert.equal(await page.locator('#owned-results .pick').count(), 1);
		await page.click('#owned-results .pick[data-entry="c1"]');
		await page.waitForSelector('#pocket-sheet:not([open])', {state: 'attached'});
		await waitForKind(page, 1, 'card');
		assert.match(await pocket(page, 1).getAttribute('aria-label'), /^Page 1, pocket 1: Test Bulbasaur, Portuguese/);
		assert.equal(await pocket(page, 1).locator('.badge-lang').getAttribute('aria-label'), 'Printed in Portuguese');

		// Try to place it twice: it is not offered as unplaced, and picking it
		// from all cards asks to move it.
		await pocket(page, 2).click();
		await page.waitForSelector('#pocket-sheet[open]');
		assert.equal(await page.locator('#owned-results .pick[data-entry="c1"]').count(), 0, 'a placed copy is not offered as unplaced');
		await page.click('#owned-filter label:has-text("All my cards")');
		assert.match(await page.locator('#owned-results .pick[data-entry="c1"] .pick-where').textContent(), /In Generations 1 and 2, p1/);
		await page.click('#owned-results .pick[data-entry="c1"]');
		await page.waitForSelector('#move-confirm:not([hidden])');
		assert.equal(await page.locator('#move-text').textContent(), 'This copy is in Generations 1 and 2, page 1, pocket 1. Move it here?');
		await page.screenshot({path: '/tmp/binders-move.png'});
		await page.click('#move-no');
		assert.ok(await page.locator('#move-confirm').isHidden());
		await page.click('#sheet-close');
		await page.waitForSelector('#pocket-sheet:not([open])', {state: 'attached'});
		assert.equal(await kindOf(page, 1), 'card');
		assert.equal(await kindOf(page, 2), 'open');

		// Now say yes: it moves, and the old pocket is empty.
		await pocket(page, 2).click();
		await page.click('#owned-filter label:has-text("All my cards")');
		await page.click('#owned-results .pick[data-entry="c1"]');
		await page.click('#move-yes');
		await waitForKind(page, 2, 'card');
		assert.equal(await kindOf(page, 1), 'open');
		doc = await localDoc(page);
		assert.deepEqual(doc.binders[0].slots.filter((slot) => slot.entry_id === 'c1').map((slot) => [slot.page, slot.position]), [[1, 2]]);

		// A placeholder for a card not owned, found in the catalog by name.
		await pocket(page, 3).click();
		await page.click('label:has-text("Placeholder")');
		await page.fill('#want-search', 'pika');
		await page.click('#want-go');
		await page.waitForSelector('#want-results .pick');
		assert.equal(await page.locator('#want-results .pick').count(), 2);
		assert.equal(counts.search, 1);
		await page.screenshot({path: '/tmp/binders-placeholder-search.png'});
		await page.click('#want-results .pick[data-card="tst2-025"]');
		await waitForKind(page, 3, 'want');
		assert.equal(await pocket(page, 3).locator('.pocket-tag').textContent(), 'Want');
		assert.match(await pocket(page, 3).getAttribute('aria-label'), /Test Pikachu, placeholder/);

		// Empty on purpose.
		await pocket(page, 4).click();
		await page.click('#pocket-leave-empty');
		await waitForKind(page, 4, 'empty');
		assert.match(await page.locator('#binder-summary').textContent(), /^Page 1 of 3: 1 of 9 pockets filled\. 1 of 27 in the binder, 1 placeholder\.$/);
		await page.screenshot({path: '/tmp/binders-page-1.png'});

		// A filled pocket offers Change and Take out.
		await pocket(page, 2).click();
		await page.waitForSelector('#pocket-clear');
		assert.match(await page.locator('#sheet-current-label').textContent(), /Test Bulbasaur/);
		await page.click('#sheet-close');

		// Page through: the open page steps to page 2, and the URL keeps it.
		await page.click('#bs-zoom-next');
		await waitForZoom(page, 2);
		assert.equal(new URL(page.url()).pathname, `${BASE}binders/${binderId}`);
		assert.equal(new URL(page.url()).search, '?spread=2&page=2');
		assert.equal(await page.locator('#bs-zoom-sheet .pocket[data-kind="open"]').count(), 9);
		await pocket(page, 5).click();
		await page.click('#owned-results .pick[data-entry="c2"]');
		await waitForKind(page, 5, 'card');
		await page.click('#bs-zoom-next');
		await waitForZoom(page, 3);
		assert.ok(await page.locator('#bs-zoom-next').isDisabled());

		// Back to both pages: the spread holding page 3 (pages 2 and 3, the
		// last in a 3-page binder), not the one the zoom started from.
		await page.click('#bs-zoom-back');
		await waitForSpread(page, 2);
		assert.equal(new URL(page.url()).search, '?spread=2');
		assert.ok(await page.locator('#bs-next').isDisabled());
		await page.selectOption('#bs-jump', '1');
		await waitForSpread(page, 1);
		await page.click('#bs-next');
		await waitForSpread(page, 2);

		// Reload: the spread and every pocket come back from the phone.
		await page.reload();
		await page.waitForSelector('#binder-spread .bs-page');
		assert.equal(await page.locator('#bs-jump').inputValue(), '2');
		await waitForKind(page, 5, 'card', 2);
		assert.match(await pocket(page, 5, 2).getAttribute('aria-label'), /^Page 2, pocket 5: Test Charmander/);
		assert.match(await page.locator('#binder-summary').textContent(), /^Pages 2 and 3 of 3: 1 of 18 pockets filled\. 2 of 27 in the binder, 1 placeholder\.$/);
		await page.click('#bs-prev');
		await waitForSpread(page, 1);
		assert.equal(await kindOf(page, 1, 1), 'open');
		assert.equal(await kindOf(page, 2, 1), 'card');
		assert.equal(await kindOf(page, 3, 1), 'want');
		assert.equal(await kindOf(page, 4, 1), 'empty');
		assert.equal(new URL(page.url()).pathname, `${BASE}binders/${binderId}`);
		assert.equal(new URL(page.url()).search, '');

		// Where is this card?
		const location = await page.evaluate(async () => (await import('/pokemon-card-tracker/js/binders.js')).binderLocation('c1'));

		assert.deepEqual(location, {binder_id: binderId, binder_name: 'Generations 1 and 2', col: 2, page: 1, position: 2, row: 1});
		assert.equal(await page.evaluate(async () => (await import('/pokemon-card-tracker/js/binders.js')).binderLocation('c3')), null);

		// The binder list: a black cover with white text, and the counts.
		await page.click('.back');
		await page.waitForSelector('.binder-cover');

		const coverEl = page.locator(`.binder-cover[data-binder="${binderId}"]`);
		const colors = await coverEl.evaluate((el) => ({background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color}));

		assert.deepEqual(colors, {background: 'rgb(27, 27, 31)', color: 'rgb(255, 255, 255)'});
		assert.equal(await coverEl.locator('.binder-name').textContent(), 'Generations 1 and 2');
		assert.equal(await coverEl.locator('.binder-notes').textContent(), 'Kanto and Johto in Dex order');
		assert.equal(await coverEl.locator('.binder-fill').textContent(), '2 / 27');
		assert.match(await coverEl.textContent(), /3 × 3 · 3 pages/);
		assert.equal(await page.locator('#unplaced-link').textContent(), '1 owned card not in any binder');
		await page.screenshot({path: '/tmp/binders-list.png'});

		// Owned cards in no binder.
		await page.click('#unplaced-link');
		await page.waitForSelector('#unplaced-grid .tile');
		assert.equal(new URL(page.url()).pathname, `${BASE}binders/unplaced`);
		assert.equal(await page.locator('#unplaced-summary').textContent(), '1 copy not in any binder, in 1 tile.');
		assert.match(await page.locator('#unplaced-grid .tile').textContent(), /Test Squirtle/);
		await page.screenshot({path: '/tmp/binders-unplaced.png'});

		// Editing to a smaller grid warns which pockets fall off; Cancel keeps it.
		await page.goto(url(`binders/${binderId}`));
		await page.waitForSelector('#edit-binder');
		await page.click('#edit-binder');
		assert.equal(await page.locator('#binder-resize-warning').textContent(), '');
		await page.click('.grid-pick[data-grid="2x2"]');
		assert.equal(await page.locator('#binder-resize-warning').textContent(), '1 filled pocket falls outside the new size, and 1 card comes out of the binder.');
		await page.selectOption('#binder-rows', '1');
		await page.selectOption('#binder-cols', '2');
		assert.equal(await page.locator('#binder-resize-warning').textContent(), '3 filled pockets fall outside the new size, and 1 card comes out of the binder.');
		await page.selectOption('#binder-rows', '3');
		await page.selectOption('#binder-cols', '3');
		await page.fill('#binder-pages', '2');
		assert.equal(await page.locator('#binder-resize-warning').textContent(), '');
		await page.fill('#binder-pages', '1');
		assert.equal(await page.locator('#binder-resize-warning').textContent(), '1 filled pocket falls outside the new size, and 1 card comes out of the binder.');
		await page.click('#binder-cancel');
		assert.equal(await page.locator('#binder-form').count(), 0);

		// A rename and a cover change save.
		await page.click('#edit-binder');
		await page.fill('#binder-name', 'Gens 1 and 2');
		await page.click('.cover-swatch[title="Black"]');
		await page.click('#binder-save');
		await page.waitForFunction(() => document.getElementById('binder-title').textContent === 'Gens 1 and 2');
		binder = (await localDoc(page)).binders[0];
		assert.equal(binder.name, 'Gens 1 and 2');
		assert.equal(binder.slots.length, 4, 'the pockets are untouched');

		// Offline: the shell and the binder open from the phone.
		await page.evaluate(() => navigator.serviceWorker.ready);
		await page.waitForFunction(async () => {
			for (const key of (await caches.keys()).filter((name) => name.startsWith('card-tracker-shell-'))) {
				const paths = (await (await caches.open(key)).keys()).map((request) => new URL(request.url).pathname);

				if (['js/binders.js', 'js/binders-view.js', 'css/binders.css'].every((file) => paths.includes(`/pokemon-card-tracker/${file}`))) {
					return true;
				}
			}

			return false;
		}, null, {timeout: 15000});

		const before = {...counts};

		net.offline = true;
		await context.setOffline(true);
		await page.goto(url(`binders/${binderId}`));
		await page.waitForSelector('#binder-spread .bs-page');
		await waitForKind(page, 2, 'card', 1);
		assert.equal(await kindOf(page, 3, 1), 'want');
		assert.match(await pocket(page, 3, 1).getAttribute('aria-label'), /Test Pikachu/);
		assert.equal(await page.locator('.binder-head').evaluate((el) => getComputedStyle(el).borderLeftColor), 'rgb(27, 27, 31)', 'the binder stylesheet is cached');

		// Placing works offline; the catalog search says it needs a connection.
		await openPage(page, 1);
		await pocket(page, 6).click();
		await page.click('#owned-results .pick[data-entry="c3"]');
		await waitForKind(page, 6, 'card');
		await pocket(page, 7).click();
		await page.click('label:has-text("Placeholder")');
		await page.fill('#want-search', 'pika');
		await page.click('#want-go');
		assert.match(await page.locator('#want-status').textContent(), /needs a connection/);
		await page.click('#sheet-close');
		await page.screenshot({path: '/tmp/binders-offline.png'});
		assert.deepEqual(counts, before, 'nothing was fetched offline');
		assert.deepEqual(await shownErrors(page), []);

		net.offline = false;
		await context.setOffline(false);

		// Delete: a tombstone stays, and every copy is unplaced again.
		page.once('dialog', (dialog) => dialog.accept());
		await page.click('#delete-binder');
		await page.waitForURL(/\/binders$/);
		await page.waitForSelector('.empty-state');
		assert.equal(await page.locator('#unplaced-link').textContent(), '3 owned cards not in any binder');
		doc = await localDoc(page);
		assert.equal(doc.binders.length, 1);
		assert.ok(doc.binders[0].deleted_at, 'deleted softly');

		// The other screens still open.
		await page.click('.tabs a[data-tab="cards"]');
		await page.waitForSelector('#cards-summary');
		await page.click('.tabs a[data-tab="lists"]');
		await page.waitForSelector('h2');
		assert.deepEqual(await shownErrors(page), []);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a binder made signed in syncs, and a family member sees it read only', async () => {
		const {FakeSupabase} = await import('./fake-supabase.mjs');
		const fake = new FakeSupabase();
		const owner = fake.addUser('owner@example.test');
		const kid = fake.addUser('kid@example.test');
		const ownerDevice = await device(fake, 'owner');

		await seedLocal(ownerDevice.page, documentWith(CARDS), RECORDS);
		await signIn(ownerDevice.page, fake, owner.email);
		await waitForStatus(ownerDevice.page, 'Synced');

		// The owner makes a binder and places a card; both reach the server.
		await ownerDevice.page.goto(url('binders'));
		await ownerDevice.page.click('#new-binder');
		await ownerDevice.page.fill('#binder-name', 'Trade binder');
		await ownerDevice.page.click('.grid-pick[data-grid="2x2"]');
		await ownerDevice.page.fill('#binder-pages', '2');
		await ownerDevice.page.click('#binder-save');
		await ownerDevice.page.waitForSelector('#binder-spread .bs-page');
		await openPage(ownerDevice.page, 1);
		await pocket(ownerDevice.page, 1).click();
		await ownerDevice.page.click('#owned-results .pick[data-entry="c2"]');
		await waitForKind(ownerDevice.page, 1, 'card');

		const pushed = () => ((fake.documents.get(owner.id) || {}).doc || {}).binders || [];

		await until(() => pushed().length === 1 && pushed()[0].slots.some((slot) => slot.entry_id === 'c2'));
		assert.equal(pushed()[0].name, 'Trade binder');

		// A colour in a member's document that is not a hex colour never
		// reaches a style: the default cover shows, and nothing is fetched.
		fake.documents.get(owner.id).doc.binders[0].cover_color = '#123456; background-image: url(https://tracker.invalid/a.png); outline: 9px solid lime';

		// The kid sees it read only.
		fake.members.push({group_id: fake.groups[0].id, role: 'member', user_id: kid.id});
		fake.profiles.set(owner.id, {display_name: 'Eric', user_id: owner.id});

		const {context, errors, page} = await device(fake, 'kid');
		const injected = [];

		await context.route('https://tracker.invalid/**', (route) => {
			injected.push(route.request().url());

			return route.abort();
		});
		await signIn(page, fake, kid.email);
		await waitForStatus(page, 'Synced');
		await page.goto(url('binders'));
		await page.waitForSelector('#owner-switch:not([hidden])');
		await page.click('#owner-switch');
		await page.click(`#owner-sheet .owner-option[data-member="${owner.id}"]`);
		await page.waitForSelector('.view-only');
		assert.equal(new URL(page.url()).pathname, `${BASE}family/${owner.id}/binders`);
		assert.match(await page.locator('.view-only').textContent(), /Eric's binders, view only/);
		assert.equal(await page.locator('#new-binder').count(), 0, 'no New binder in the view');
		await page.waitForSelector('.binder-cover');
		assert.equal(await page.locator('.binder-fill').textContent(), '1 / 8');
		assert.doesNotMatch(await page.locator('.binder-cover').getAttribute('style'), /url|outline/);
		assert.equal(await page.locator('.binder-cover').evaluate((el) => el.style.getPropertyValue('--cover').trim()), '#1d2e60');

		await page.click('.binder-cover');
		await page.waitForSelector('#binder-spread .bs-page');
		assert.ok(new URL(page.url()).pathname.startsWith(`${BASE}family/${owner.id}/binders/`));
		await waitForKind(page, 1, 'card', 1);
		assert.equal(await page.locator('#binder-body').evaluate((el) => el.style.getPropertyValue('--cover').trim()), '#1d2e60');
		assert.equal(await page.locator('#binder-spread').evaluate((el) => el.style.getPropertyValue('--cover').trim()), '#1d2e60');
		assert.equal(await page.locator('#binder-spread .bs-pocket button').count(), 0, 'no pocket can be tapped to edit');
		assert.equal(await page.locator('#bs-spread a.pocket').count(), 1, 'the owned card opens its card page');
		assert.equal(await page.locator('#edit-binder, #binder-cover-image, #delete-binder, #pocket-sheet').count(), 0);
		assert.match(await pocket(page, 1, 1).getAttribute('aria-label'), /^Page 1, pocket 1: Test Charmander/);

		// Opened at full size it is still read only, and the card links on.
		await openPage(page, 1);
		assert.equal(await page.locator('#bs-zoom-sheet .bs-pocket button').count(), 0);
		assert.equal(await page.locator('#bs-zoom-sheet a.pocket').count(), 1);
		await page.click('#bs-zoom-back');
		await waitForSpread(page, 1);

		// Turning the page works for a viewer too: page 2 alone, the last.
		await page.click('#bs-next');
		await waitForSpread(page, 2);
		assert.equal(await page.locator('#bs-jump').inputValue(), '2');
		assert.equal(new URL(page.url()).search, '?spread=2');
		assert.ok(new URL(page.url()).pathname.startsWith(`${BASE}family/${owner.id}/binders/`));
		await page.screenshot({path: '/tmp/binders-family.png'});

		// Viewing changed nothing for either person.
		assert.equal((await localDoc(page)).binders.length, 0);
		assert.equal(pushed().length, 1);
		assert.deepEqual(injected, [], 'nothing fetched from a crafted colour');
		assert.deepEqual(errors, []);
		assert.deepEqual(ownerDevice.errors, []);
		await context.close();
		await ownerDevice.context.close();
	});

	test('deleting a binder deletes its cover image from the bucket, and offline it waits for signal', async () => {
		const {FakeStorageSupabase} = await import('./photos-fake-storage.mjs');
		const fake = new FakeStorageSupabase();
		const owner = fake.addUser('owner@example.test');
		const binder = binderOf('b-cover', {created_at: AT, name: 'Covered binder', page_count: 2, updated_at: AT});
		const {context, errors, page} = await device(fake, 'owner');

		await seedLocal(page, documentWith(CARDS, [binder]), RECORDS);
		await signIn(page, fake, owner.email);
		await waitForStatus(page, 'Synced');

		// A cover image, saved the way the Cover image sheet saves one, goes up.
		const image = await page.evaluate(async (binderId) => {
			const canvas = document.createElement('canvas');

			canvas.width = 60;
			canvas.height = 80;
			canvas.getContext('2d').fillStyle = '#3366cc';
			canvas.getContext('2d').fillRect(0, 0, 60, 80);

			const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp'));
			const {saveCoverImage} = await import('/pokemon-card-tracker/js/binder-cover.js');

			return (await saveCoverImage(binderId, blob, 'image/webp')).cover_image;
		}, binder.id);

		assert.equal(image.path, `${owner.id}/binder-${binder.id}/${image.id}.webp`);
		await until(() => fake.objects.has(image.path));

		// The spread shows it; then the binder is deleted with no signal.
		await page.goto(url(`binders/${binder.id}`));
		await page.waitForFunction(() => document.getElementById('binder-spread')?.dataset.coverImage === 'true');
		await context.setOffline(true);
		page.once('dialog', (dialog) => dialog.accept());
		await page.click('#delete-binder');
		await page.waitForURL(/\/binders$/);
		await page.waitForSelector('.empty-state');
		assert.ok((await localDoc(page)).binders.find((item) => item.id === binder.id).deleted_at, 'the binder is deleted at once');

		const localCover = () => page.evaluate(async (id) => Boolean(await (await import('/pokemon-card-tracker/js/binder-cover.js')).localCover(id)), image.id);
		const end = Date.now() + 5000;

		while (await localCover() && Date.now() < end) {
			await page.waitForTimeout(100);
		}

		assert.equal(await localCover(), false, 'the phone\'s copy is gone');
		assert.ok(fake.objects.has(image.path), 'offline, the file waits in the bucket');
		assert.equal(fake.storageLog('remove').length, 0);

		// Back online, the queued delete goes.
		await context.setOffline(false);
		await until(() => !fake.objects.has(image.path));
		assert.equal(fake.storageLog('remove').length, 1);
		assert.deepEqual(await shownErrors(page), []);
		assert.deepEqual(errors, []);
		await context.close();
	});
});
