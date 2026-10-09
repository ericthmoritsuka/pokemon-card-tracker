// Browser tests for where each copy is stored ("Stored in", DESIGN.md
// section 4): the field and its place chips in the copy sheets
// (js/copy-sheet.js), the Places sheet's rename and remove with Undo, the
// Stored in filter and "Set storage for these N copies" on My Cards
// (js/cards-view.js, js/filter-bar.js), the CSV column and its restore, and
// a family member's card page showing their places read only. Headless
// Chromium at 360 x 740 (the family test at 390 x 844) against
// tests/pages-server.mjs.
//
// Supabase is tests/fake-supabase.mjs, TCGdex and the sprites are faked
// with invented cards, and ligapokemon.com.br is never requested.
//
// Until js/catalog-views.js draws a row's Stored in line, the page is
// served with the two lines the integrator adds (CATALOG_PATCH), so the
// test sees what the app will show.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/storage-browser.test.mjs
// Screenshots: $SHOTS (default /tmp)/storage-*.png

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {FakeSupabase} from './fake-supabase.mjs';
import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const PHONE = {height: 740, width: 360};
const WIDE_PHONE = {height: 844, width: 390};
const SHOTS = process.env.SHOTS || '/tmp';
const AT = '2026-09-01T00:00:00.000Z';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

// The integration change to js/catalog-views.js, as plain replacements.
const CATALOG_PATCH = [
	[
		'import {alikeKey, closeCopySheet, copyPlaces, copyStepper, languageName, openAddSheet, openEditSheet, placeText} from \'./copy-sheet.js\';',
		'import {alikeKey, closeCopySheet, copyPlaces, copyStepper, languageName, openAddSheet, openEditSheet, placeText, storedLine} from \'./copy-sheet.js\';',
	],
	[
		'\t\t\t...group.entries.filter((entry) => placed.has(entry.id)).map((entry) => h(\'span\', {class: \'copy-place\'}, placeText(placed.get(entry.id)))),\n',
		'\t\t\t...group.entries.filter((entry) => placed.has(entry.id)).map((entry) => h(\'span\', {class: \'copy-place\'}, placeText(placed.get(entry.id)))),\n\t\t\tstoredLine(group.entries),\n',
	],
];

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

const entry = (id, fields) => ({catalog: 'international', created_at: AT, deleted_at: null, id, language: 'en', language_source: 'manual', updated_at: AT, ...fields});

function documentWith(cards, extra = {}) {
	return {binders: [], cards, collections: [], goals: [], openings: [], person: 'local', updated_at: AT, user_id: null, version: 1, wishlist: [], ...extra};
}

const place = (id, name) => ({created_at: AT, deleted_at: null, id, name, updated_at: AT});

// One invented set of 20 cards.
async function fakeNetwork(context, seen) {
	await context.route('https://api.tcgdex.net/**', (route) => {
		const {pathname} = new URL(route.request().url());
		const set = /\/v2\/(\w+)\/sets\/(tst\d+)$/.exec(pathname);
		const card = /\/v2\/(\w+)\/cards\/((tst\d+)-(\d+))$/.exec(pathname);
		const brief = (setId) => ({cardCount: {official: 20, total: 20}, id: setId, logo: null, name: `Test set ${setId}`, releaseDate: '2026-01-01', serie: {id: 'tst', name: 'Test series'}});
		const json = (body) => route.fulfill({body: JSON.stringify(body), contentType: 'application/json', headers: {'Access-Control-Allow-Origin': '*'}, status: 200});

		if (/\/v2\/\w+\/sets$/.test(pathname)) {
			return json([brief('tst1')]);
		}

		if (set) {
			return json({...brief(set[2]), cards: Array.from({length: 20}, (_, i) => {
				const localId = String(i + 1).padStart(3, '0');

				return {id: `${set[2]}-${localId}`, image: null, localId, name: `Test card ${localId}`};
			})});
		}

		if (card) {
			return json({
				category: 'Pokemon', dexId: [25], id: card[2], illustrator: 'Test Artist', image: null, localId: card[4], name: `Test card ${card[4]}`, rarity: 'Common',
				set: {cardCount: {official: 20, total: 20}, id: card[3], name: `Test set ${card[3]}`}, variants_detailed: [],
			});
		}

		return json([]);
	});
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));
	await context.route('https://raw.githubusercontent.com/**', (route) => route.fulfill({body: PNG, contentType: 'image/png', status: 200}));
	await context.route('https://api.frankfurter.dev/**', (route) => route.fulfill({
		body: JSON.stringify([{base: 'USD', date: '2026-10-01', quote: 'BRL', rate: 5}]),
		contentType: 'application/json',
		headers: {'Access-Control-Allow-Origin': '*'},
		status: 200,
	}));
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await context.route(/ligapokemon\.com\.br/, (route) => {
		seen.liga.push(route.request().url());

		return route.abort('blockedbyclient');
	});
	await context.route((target) => target.pathname === `${BASE}js/catalog-views.js`, async (route) => {
		const response = await route.fetch();
		let body = await response.text();

		if (!body.includes('storedLine')) {
			for (const [from, to] of CATALOG_PATCH) {
				assert.ok(body.includes(from), `js/catalog-views.js still has: ${from.trim().slice(0, 60)}`);
				body = body.replace(from, to);
			}
		}

		return route.fulfill({body, contentType: 'text/javascript; charset=utf-8', status: 200});
	});
	await fakePokeApi(context);
}

// A phone, signed out unless a fake Supabase is attached.
async function phone({fake = null, name = 'owner', viewport = PHONE} = {}) {
	const context = await browser.newContext({hasTouch: true, serviceWorkers: 'block', viewport});
	const seen = {liga: [], supabase: []};

	await fakeNetwork(context, seen);

	if (fake) {
		await fake.attach(context, name);
	}
	else {
		await context.route('https://*.supabase.co/**', (route) => {
			seen.supabase.push(route.request().url());

			return route.abort('blockedbyclient');
		});
	}

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(String(err)));

	const done = async () => {
		assert.deepEqual(errors, []);
		assert.deepEqual(await page.locator('#errors .error').allTextContents(), []);
		assert.deepEqual(seen.liga, [], 'Liga Pokémon is never requested');
		assert.deepEqual(seen.supabase, [], 'signed out, Supabase is never contacted');
		await context.close();
	};

	return {context, done, page};
}

async function seedLocal(page, doc) {
	await page.goto(url('cards'));
	await page.evaluate(async (stored) => {
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
	}, doc);
	await page.reload();
}

const stored = (page) => page.evaluate(async () => {
	const doc = await (await import('/pokemon-card-tracker/js/collection.js')).loadDocument();

	return Object.fromEntries(doc.cards.filter((card) => !card.deleted_at).map((card) => [card.id, card.storage ?? null]));
});

const savedNames = (page) => page.evaluate(async () => (await (await import('/pokemon-card-tracker/js/collection.js')).listPlaces()).map((one) => `${one.name} ${one.count}`));

const chips = (page, id = 'copy-storage') => page.locator(`#${id}-chips .place-chip`).allTextContents();

const pressed = (page, id = 'copy-storage') => page.locator(`#${id}-chips .place-chip[aria-pressed="true"]`).textContent();

async function noSideways(page, where) {
	const width = await page.evaluate(() => document.documentElement.scrollWidth);

	assert.ok(width <= page.viewportSize().width, `no sideways scroll on ${where} (${width})`);
}

async function openCard(page, id) {
	await page.evaluate(async (path) => (await import('/pokemon-card-tracker/js/dom.js')).go(path), `cards/en/${id}`);
	await page.waitForSelector('.copies .copy-row');
}

async function editRow(page, n = 0) {
	await page.locator('.copies .copy-row').nth(n).click();
	await page.waitForSelector('#copy-sheet[open]');
}

async function saveSheet(page) {
	await page.click('#copy-save');
	await page.locator('#copy-sheet').waitFor({state: 'hidden'});
}

describe('Stored in on a copy', () => {
	test('a place typed on one copy is a chip on the next, shows on the row, stays when no copy is left in it, and + keeps it', async () => {
		const {done, page} = await phone();

		await seedLocal(page, documentWith([entry('c-1', {card_id: 'tst1-001'}), entry('c-2', {card_id: 'tst1-002'})]));

		await openCard(page, 'tst1-001');
		await editRow(page);
		assert.deepEqual(await chips(page), ['Not set'], 'no places yet');
		assert.equal(await pressed(page), 'Not set');
		assert.equal(await page.locator('label[for="copy-storage"]').textContent(), 'Stored in');
		assert.equal(await page.locator('#copy-storage').getAttribute('maxlength'), '40');
		await page.fill('#copy-storage', '  Bulk   box A ');
		await page.screenshot({path: `${SHOTS}/storage-sheet-typed.png`});
		await saveSheet(page);
		await page.waitForSelector('.copies .copy-stored');
		assert.equal(await page.locator('.copies .copy-stored').textContent(), 'Stored in Bulk box A');
		assert.deepEqual(await savedNames(page), ['Bulk box A 1']);
		await noSideways(page, 'the card page');
		await page.screenshot({path: `${SHOTS}/storage-card-row.png`});

		// The next copy: one tap on the chip.
		await openCard(page, 'tst1-002');
		await editRow(page);
		assert.deepEqual(await chips(page), ['Not set', 'Bulk box A']);
		await page.click('#copy-storage-chips [data-place="Bulk box A"]');
		assert.equal(await page.locator('#copy-storage').inputValue(), 'Bulk box A');
		assert.equal(await pressed(page), 'Bulk box A');
		await page.screenshot({path: `${SHOTS}/storage-sheet-chips.png`});
		await saveSheet(page);
		await page.waitForSelector('.copies .copy-stored');
		assert.deepEqual(await stored(page), {'c-1': 'Bulk box A', 'c-2': 'Bulk box A'});

		// Not set takes the copy out; the place stays on offer.
		await editRow(page);
		await page.click('#copy-storage-chips [data-place=""]');
		await saveSheet(page);
		await page.locator('.copies .copy-stored').waitFor({state: 'detached'});
		await openCard(page, 'tst1-001');
		await editRow(page);
		await page.click('#copy-storage-chips [data-place=""]');
		await saveSheet(page);
		await page.locator('.copies .copy-stored').waitFor({state: 'detached'});
		assert.deepEqual(await savedNames(page), ['Bulk box A 0'], 'no copy is stored there, and it is still saved');
		await editRow(page);
		assert.deepEqual(await chips(page), ['Not set', 'Bulk box A']);
		await page.click('#copy-storage-chips [data-place="Bulk box A"]');
		await saveSheet(page);
		await page.waitForSelector('.copies .copy-stored');

		// + adds a copy alike, in the same place; a copy elsewhere is its own row.
		await page.click('.copies .step-more');
		await page.waitForFunction(() => document.querySelector('.copies .step-count').value === '2');
		assert.deepEqual(Object.values(await stored(page)).sort(), ['Bulk box A', 'Bulk box A', null]);
		await page.click('#copy-add');
		await page.waitForSelector('#copy-sheet[open]');
		assert.deepEqual(await chips(page), ['Not set', 'Bulk box A'], 'the Add sheet offers the places too');
		await page.fill('#copy-storage', 'Deck box');
		await page.click('#copy-add-save');
		await page.waitForFunction(() => document.querySelectorAll('.copies .copy-row').length === 2);
		assert.deepEqual(await page.locator('.copies .copy-stored').allTextContents(), ['Stored in Bulk box A', 'Stored in Deck box']);
		await page.locator('.copies').screenshot({path: `${SHOTS}/storage-card-two-places.png`});
		await done();
	});

	test('Manage places renames a place on every copy, and removes one after asking, each with Undo', async () => {
		const {done, page} = await phone();

		await seedLocal(page, documentWith([
			entry('c-1', {card_id: 'tst1-001', storage: 'Box A'}),
			entry('c-2', {card_id: 'tst1-002', storage: 'Box A'}),
			entry('c-3', {card_id: 'tst1-003', storage: 'Drawer'}),
		], {storage_places: [place('p-a', 'Box A'), place('p-d', 'Drawer'), place('p-e', 'Empty tin')]}));

		await openCard(page, 'tst1-001');
		await editRow(page);
		assert.equal(await page.locator('#copy-storage').inputValue(), 'Box A');
		assert.deepEqual(await chips(page), ['Not set', 'Box A', 'Drawer', 'Empty tin'], 'most used first');
		await page.click('#copy-storage-manage');
		await page.waitForSelector('#places-sheet[open] .place-row');
		assert.deepEqual(await page.locator('#places-list .place-text').allTextContents(), ['Box A2 copies', 'Drawer1 copy', 'Empty tinNo copies']);
		await noSideways(page, 'the Places sheet');
		await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running'));
		await page.screenshot({path: `${SHOTS}/storage-places.png`});

		// Rename: every copy follows, and Undo in the sheet puts it back.
		await page.click('#places-list [aria-label="Rename Box A"]');
		await page.fill('#places-list .place-rename input', 'Shelf 1');
		await page.screenshot({path: `${SHOTS}/storage-places-rename.png`});
		await page.click('#places-list .place-rename button[type="submit"]');
		await page.waitForFunction(() => /^Renamed to Shelf 1, 2 copies updated\./.test(document.getElementById('places-status').textContent));
		assert.deepEqual(await stored(page), {'c-1': 'Shelf 1', 'c-2': 'Shelf 1', 'c-3': 'Drawer'});
		await page.click('#places-undo');
		await page.waitForFunction(() => document.getElementById('places-status').textContent === 'Undone.');
		assert.deepEqual(await stored(page), {'c-1': 'Box A', 'c-2': 'Box A', 'c-3': 'Drawer'});
		await page.waitForFunction(() => [...document.querySelectorAll('#places-list .place-name')].some((name) => name.textContent === 'Box A'));

		// Rename again and keep it: the sheet under it follows.
		await page.click('#places-list [aria-label="Rename Box A"]');
		await page.fill('#places-list .place-rename input', 'Shelf 1');
		await page.click('#places-list .place-rename button[type="submit"]');
		await page.waitForFunction(() => /^Renamed to Shelf 1/.test(document.getElementById('places-status').textContent));

		// Remove a place with copies: asked first, in the row.
		await page.click('#places-list [aria-label="Remove Drawer"]');
		assert.equal(await page.locator('#places-list .place-ask').textContent(), '1 copy is stored here; it will show Not set.');
		await page.screenshot({path: `${SHOTS}/storage-places-remove-ask.png`});
		await page.click('#places-list .place-remove-yes');
		await page.waitForFunction(() => /^Drawer removed, 1 copy now Not set\./.test(document.getElementById('places-status').textContent));
		assert.deepEqual(await stored(page), {'c-1': 'Shelf 1', 'c-2': 'Shelf 1', 'c-3': null});
		await page.click('#places-undo');
		await page.waitForFunction(() => document.getElementById('places-status').textContent === 'Undone.');
		assert.deepEqual(await stored(page), {'c-1': 'Shelf 1', 'c-2': 'Shelf 1', 'c-3': 'Drawer'});

		// A place with no copies goes at once.
		await page.click('#places-list [aria-label="Remove Empty tin"]');
		await page.waitForFunction(() => /^Empty tin removed\./.test(document.getElementById('places-status').textContent));
		assert.deepEqual(await savedNames(page), ['Shelf 1 2', 'Drawer 1']);

		await page.click('#places-close');
		await page.locator('#places-sheet').waitFor({state: 'hidden'});
		assert.equal(await page.locator('#copy-storage').inputValue(), 'Shelf 1', 'the copy sheet shows the new name');
		assert.deepEqual(await chips(page), ['Not set', 'Shelf 1', 'Drawer']);
		await saveSheet(page);
		await page.waitForFunction(() => (document.querySelector('.copies .copy-stored') || {}).textContent === 'Stored in Shelf 1');
		await done();
	});
});

describe('Stored in on My Cards', () => {
	test('the filter lists saved places with their copies and Not set; the narrowed copies are stored at once, with Undo', async () => {
		const {done, page} = await phone();

		await seedLocal(page, documentWith([
			entry('c-1', {card_id: 'tst1-001', created_at: '2026-09-01T00:00:01.000Z', storage: 'Box A'}),
			entry('c-2', {card_id: 'tst1-001', created_at: '2026-09-01T00:00:02.000Z', storage: 'Box A'}),
			entry('c-3', {card_id: 'tst1-002', created_at: '2026-09-01T00:00:03.000Z'}),
			entry('c-4', {card_id: 'tst1-003', created_at: '2026-09-01T00:00:04.000Z'}),
		], {storage_places: [place('p-a', 'Box A'), place('p-s', 'Shoebox')]}));
		await page.waitForSelector('.card-grid .tile');
		assert.ok(await page.locator('#cards-store').isHidden(), 'nothing narrowed: no bulk button');

		await page.click('#cards-filters');
		await page.waitForSelector('#cards-sheet[open] #cards-f-storage');
		assert.equal(await page.locator('label[for="cards-f-storage"]').textContent(), 'Stored in (copies)');
		assert.deepEqual(await page.locator('#cards-f-storage option').allTextContents(), ['Anywhere', 'Box A (2)', 'Shoebox (0)', 'Not set (2)']);
		await page.selectOption('#cards-f-storage', 'none');
		await page.screenshot({path: `${SHOTS}/storage-filter.png`});
		await page.click('#cards-sheet .fb-show');
		await page.locator('#cards-sheet').waitFor({state: 'hidden'});
		assert.equal(await page.locator('.fb-chip[data-filter="storage"]').textContent(), 'Stored in: not set×');
		assert.match(await page.locator('#cards-summary').textContent(), /^2 copies in 2 tiles match/);
		assert.equal(await page.locator('#cards-store').textContent(), 'Set storage for these 2 copies');
		await noSideways(page, 'My Cards with the bulk button');
		await page.screenshot({path: `${SHOTS}/storage-my-cards.png`});

		await page.click('#cards-store');
		await page.waitForSelector('#store-sheet[open]');
		assert.deepEqual(await chips(page, 'store-place'), ['Not set', 'Box A', 'Shoebox']);
		assert.equal(await page.locator('#store-save').textContent(), 'Save for 2 copies');
		await page.click('#store-place-chips [data-place="Shoebox"]');
		await page.screenshot({path: `${SHOTS}/storage-bulk-sheet.png`});
		await page.click('#store-save');
		await page.waitForSelector('.toast:has-text("2 copies stored in Shoebox.")');
		assert.deepEqual(await stored(page), {'c-1': 'Box A', 'c-2': 'Box A', 'c-3': 'Shoebox', 'c-4': 'Shoebox'});
		await page.waitForSelector('#cards-none');

		await page.click('.toast:has-text("2 copies stored in Shoebox.") button:has-text("Undo")');
		await page.waitForFunction(() => /^2 copies in 2 tiles match/.test(document.getElementById('cards-summary').textContent));
		assert.deepEqual(await stored(page), {'c-1': 'Box A', 'c-2': 'Box A', 'c-3': null, 'c-4': null});

		// A place filter counts only the copies stored there.
		await page.click('#cards-filters');
		await page.selectOption('#cards-f-storage', 'place:Box A');
		await page.click('#cards-sheet .fb-show');
		await page.waitForFunction(() => /^2 copies in 1 tile match/.test(document.getElementById('cards-summary').textContent));
		await done();
	});

	test('the CSV export carries Stored in, and a re-import on a wiped phone gives it back', async () => {
		const {done, page} = await phone();

		await seedLocal(page, documentWith([
			entry('aaaaaaaa-bbbb-4ccc-8ddd-000000000001', {card_id: 'tst1-001', storage: 'Box A; top shelf'}),
			entry('aaaaaaaa-bbbb-4ccc-8ddd-000000000002', {card_id: 'tst1-002'}),
		]));
		await page.waitForSelector('.card-grid .tile');

		const result = await page.evaluate(async () => {
			const [{collectionCsv}, collection, {cardIndex}, {parseOwnCsv}] = await Promise.all([
				import('/pokemon-card-tracker/js/cards-view.js'),
				import('/pokemon-card-tracker/js/collection.js'),
				import('/pokemon-card-tracker/js/catalog.js'),
				import('/pokemon-card-tracker/js/monprice.js'),
			]);
			const text = collectionCsv(await collection.listCards(), await cardIndex());
			const doc = await collection.loadDocument();

			// The phone wiped: no copies and no places.
			doc.cards.length = 0;
			delete doc.storage_places;
			await collection.applyOwnImport(parseOwnCsv(text).rows);

			return {
				header: text.split('\r\n')[0].split(';').pop(),
				places: (await collection.listPlaces()).map((one) => one.name),
				storage: (await collection.listCards()).map((card) => card.storage ?? null),
			};
		});

		assert.equal(result.header, 'storage');
		assert.deepEqual(result.storage, ['Box A; top shelf', null]);
		assert.deepEqual(result.places, ['Box A; top shelf'], 'the re-import saves the place too');
		await done();
	});
});

describe('Stored in in family view', () => {
	test('a member\'s card shows where their copies are stored, read only, and their My Cards filters by it', async () => {
		const fake = new FakeSupabase();
		const owner = fake.addUser('owner@example.test');
		const member = fake.addUser('member-a@example.test');

		fake.documents.set(member.id, {
			doc: {...documentWith([entry('m-1', {card_id: 'tst1-001', storage: 'Box M'}), entry('m-2', {card_id: 'tst1-002'})], {storage_places: [place('p-m', 'Box M')]}), person: undefined, user_id: undefined},
			updated_at: fake.now(),
			user_id: member.id,
		});
		fake.profiles.set(member.id, {display_name: 'Member A', user_id: member.id});

		const {context, page} = await phone({fake, viewport: WIDE_PHONE});
		const errors = [];

		page.on('pageerror', (err) => errors.push(String(err)));
		await seedLocal(page, documentWith([entry('o-1', {card_id: 'tst1-001', storage: 'My box'})]));
		await page.goto(url('signin'));
		await page.fill('#signin-email', owner.email);
		await page.click('button:has-text("Send link")');
		await page.waitForSelector('#check-email');
		await page.goto(`${url()}?code=${fake.issueCode(owner.email)}`);
		await page.waitForSelector('#account.avatar');
		await page.waitForFunction(() => (document.getElementById('sync-status') || {}).textContent === 'Synced', null, {timeout: 15000});
		fake.members.push({group_id: fake.groups[0].id, role: 'member', user_id: member.id});

		await page.goto(url(`family/${member.id}`));
		await page.waitForSelector('#family-strip');
		await page.waitForSelector('.card-grid .tile');
		await page.click('#cards-filters');
		await page.waitForSelector('#cards-sheet[open] #cards-f-storage');
		assert.deepEqual(await page.locator('#cards-f-storage option').allTextContents(), ['Anywhere', 'Box M (1)', 'Not set (1)'], 'their places, not yours');
		await page.click('#cards-sheet .fb-show');
		assert.equal(await page.locator('#cards-store').count(), 0, 'no bulk storage on their cards');

		await page.evaluate(async () => (await import('/pokemon-card-tracker/js/dom.js')).go('cards/en/tst1-001'));
		await page.waitForFunction(() => (document.getElementById('copies-title') || {}).textContent === 'Member A\'s copies (1)');
		assert.equal(await page.locator('.copies .copy-stored').textContent(), 'Stored in Box M');
		assert.equal(await page.locator('button.copy-row').count(), 0, 'no edit sheet');
		assert.equal(await page.locator('.place-manage').count(), 0, 'no Manage places');
		await page.screenshot({path: `${SHOTS}/storage-family-card.png`});

		assert.deepEqual(errors, []);
		await context.close();
	});
});
