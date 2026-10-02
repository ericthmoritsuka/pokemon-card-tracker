// Browser tests for Pokémon checklists (js/checklists.js and
// js/checklists-view.js). Headless Chromium at 360 x 740 against
// tests/pages-server.mjs.
//
// Every outside service is faked: TCGdex (the GraphQL card list, set list,
// and one Pokémon's cards, and single cards), PokeAPI (names), the sprite repository, and Supabase
// (tests/fake-supabase.mjs, or a route that fails the test signed out). The
// collection is made up.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/checklists.test.mjs

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {FakeSupabase} from './fake-supabase.mjs';
import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const VIEWPORT = {height: 740, width: 360};
// Files the offline test needs from the service worker's shell list.
const NEW_FILES = ['js/checklists.js', 'js/checklists-view.js', 'js/flags.js', 'js/names.js', 'js/pokemon-cards.js', 'js/pokemon-cards-view.js'];

let pages;
let origin;
let browser;

// Every browser test gets this long before it fails, and every wait inside
// one is bounded too, so a broken service worker or a missing element fails
// the run with a message instead of hanging it.
const TEST_TIMEOUT = 180000;

before(async () => {
	// The real sw.js is served. It must precache the checklist files, or the
	// offline test cannot pass.
	const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');

	assert.ok(NEW_FILES.every((file) => sw.includes(`'${file}'`)), `sw.js precaches ${NEW_FILES.filter((file) => !sw.includes(`'${file}'`)).join(', ') || 'the checklist files'}`);

	pages = await startPagesServer();
	origin = pages.origin;
	browser = await chromium.launch();
});

after(async () => {
	await browser?.close();
	await pages?.close();
});

const url = (path = '') => `${origin}${BASE}${path}`;

// ----------------------------------------------------------- test data

const AT = '2026-09-01T00:00:00.000Z';

const entry = (id, fields) => ({created_at: AT, deleted_at: null, id, language: 'pt', language_source: 'import', updated_at: AT, ...fields});

// Made-up cards. Owned in Kanto: 1 (two copies), 4, 7 (a Japanese card), 25.
// A deleted copy of 150 and a Trainer with no dex number do not count.
const CARDS = [
	entry('c1', {card_id: 'tst1-001', catalog: 'international'}),
	entry('c2', {card_id: 'tst1-001', catalog: 'international', language: 'en'}),
	entry('c3', {card_id: 'tst1-004', catalog: 'international'}),
	entry('c4', {card_id: 'tst1-025', catalog: 'international'}),
	entry('c5', {card_id: 'tstj-007', catalog: 'ja', language: 'ja'}),
	entry('c6', {card_id: 'tst1-150', catalog: 'international', deleted_at: AT}),
	entry('c7', {card_id: 'tst1-200', catalog: 'international'}),
];

const GRAPHQL_CARDS = [
	{dexId: [1], id: 'tst1-001'},
	{dexId: [4], id: 'tst1-004'},
	{dexId: [25], id: 'tst1-025'},
	{dexId: [150], id: 'tst1-150'},
	{dexId: null, id: 'tst1-200'},
	{dexId: [133], id: 'tst1-133'},
];

// The set list, and each Pokémon's cards, for every card of a Pokémon
// (js/pokemon-cards.js).
const GRAPHQL_SETS = [{id: 'tst1', name: 'Test set one', releaseDate: '2026-01-01', serie: {id: 'tst'}}];

// An Asian catalog's cards of one Pokémon, by "<lang>/<dex>" (none
// elsewhere), and the details of their sets.
const ASIAN_LISTS = {'ja/7': [{id: 'tstj-007', image: null, localId: '007', name: 'ゼニガメ'}]};

const SET_DETAILS = {'ja/sets/tstj': {id: 'tstj', name: 'Test set JA', releaseDate: '2026-02-01', serie: {id: 'tst'}}};

const SINGLE_CARDS = {
	'en/cards/tst1-001': {dexId: [1], id: 'tst1-001', image: null, localId: '001', name: 'Test Bulbasaur', set: {id: 'tst1', name: 'Test set one'}},
	'ja/cards/tstj-007': {dexId: [7], id: 'tstj-007', image: null, localId: '007', name: 'ゼニガメ', set: {id: 'tstj', name: 'Test set JA'}},
};

const NAMES = {1: 'Bulbasaur', 2: 'Ivysaur', 3: 'Venusaur', 4: 'Charmander', 5: 'Charmeleon', 6: 'Charizard', 7: 'Squirtle', 25: 'Pikachu', 133: 'Eevee'};

// A 1 x 1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

function documentWith(cards, goals = []) {
	return {binders: [], cards, collections: [], goals, openings: [], person: 'local', updated_at: AT, user_id: null, version: 1, wishlist: []};
}

async function fakeServices(context, counts, net) {
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());

	await context.route('https://api.tcgdex.net/**', (route) => {
		if (net.offline) {
			return route.abort('internetdisconnected');
		}

		const {pathname} = new URL(route.request().url());

		if (pathname === '/v2/graphql') {
			const {query} = JSON.parse(route.request().postData() || '{}');
			const reply = (data) => route.fulfill({body: JSON.stringify({data}), contentType: 'application/json', status: 200});
			const dex = /cards\(filters: \{dexId: (\d+)\}\)/.exec(query);

			if (/^\{ sets /.test(query)) {
				counts.sets++;

				return reply({sets: GRAPHQL_SETS});
			}

			if (dex) {
				counts.dexCards++;

				return reply({cards: GRAPHQL_CARDS.filter((card) => (card.dexId || []).includes(Number(dex[1]))).map((card) => ({id: card.id, image: null, localId: card.id.split('-').pop(), name: `Test ${NAMES[card.dexId[0]]}`, rarity: null}))});
			}

			counts.graphql++;

			return reply({cards: GRAPHQL_CARDS});
		}

		const asian = /^\/v2\/([a-z-]+)\/cards$/.exec(pathname);

		if (asian) {
			counts.asian++;

			const dex = (new URL(route.request().url()).searchParams.get('dexId') || '').replace(/^eq:/, '');

			return route.fulfill({body: JSON.stringify(ASIAN_LISTS[`${asian[1]}/${dex}`] || []), contentType: 'application/json', status: 200});
		}

		const set = SET_DETAILS[pathname.replace('/v2/', '')];

		if (set) {
			return route.fulfill({body: JSON.stringify(set), contentType: 'application/json', status: 200});
		}

		const single = SINGLE_CARDS[pathname.replace('/v2/', '')];

		if (single) {
			// My Cards reads cards it has no record for too, so only the
			// Japanese card's reads are counted for the checklist.
			if (pathname.includes('/ja/')) {
				counts.single++;
			}

			return route.fulfill({body: JSON.stringify(single), contentType: 'application/json', status: 200});
		}

		return route.fulfill({body: '{}', contentType: 'application/json', status: 404});
	});

	await fakePokeApi(context, {counts, english: NAMES, offline: () => net.offline});

	// Sprites: #3 fails, to show the fallback.
	await context.route('https://raw.githubusercontent.com/**', (route) => {
		if (net.offline || route.request().url().endsWith('/3.png')) {
			return route.fulfill({status: 404});
		}

		return route.fulfill({body: PNG, contentType: 'image/png', status: 200});
	});

	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));
}

async function device(fake, name, {serviceWorkers = 'block'} = {}) {
	const context = await browser.newContext({serviceWorkers, viewport: VIEWPORT});
	const counts = {asian: 0, dexCards: 0, graphql: 0, names: 0, sets: 0, single: 0};
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

const localDoc = (page) => page.evaluate(async () => (await import('/pokemon-card-tracker/js/collection.js')).loadDocument());

const shownErrors = (page) => page.locator('#errors .error').allTextContents();

async function waitForSummary(page, text) {
	await page.waitForFunction((expected) => (document.getElementById('checklist-summary') || {}).textContent === expected, text, {timeout: 15000});
}

// The title of a Pokémon's cards screen (js/pokemon-cards-view.js).
async function waitForPokemonTitle(page, text) {
	await page.waitForFunction((expected) => (document.getElementById('pc-title') || {}).textContent === expected, text, {timeout: 15000}).catch(async (err) => {
		throw new Error(`Title is "${await page.locator('#pc-title').textContent()}", not "${text}". Status: "${await page.locator('#pc-status').textContent()}". ${err.message}`);
	});
}

const flagsIn = (page, selector) => page.locator(`${selector} img.flag`).evaluateAll((flags) => flags.map((flag) => flag.dataset.lang));

async function signIn(page, fake, email) {
	await page.goto(url('signin'));
	await page.fill('#signin-email', email);
	await page.click('button:has-text("Send link")');
	await page.waitForSelector('#check-email');

	const code = fake.issueCode(email);

	await page.goto(`${url()}?code=${code}`);
	await page.waitForSelector('#account.avatar');
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

async function waitForStatus(page, text) {
	await page.waitForFunction((expected) => {
		const line = document.getElementById('sync-status');

		return line && !line.hidden && line.textContent === expected;
	}, text, {timeout: 15000});
}

// navigator.serviceWorker.ready never settles when the worker fails to
// install (a shell file that will not cache, a duplicate in the shell list),
// and page.evaluate has no timeout of its own, so the wait is bounded here
// and the worker's state is reported.
async function serviceWorkerReady(page, timeout = 30000) {
	const state = await page.evaluate(async (ms) => {
		const late = new Promise((resolve) => setTimeout(resolve, ms, 'late'));

		if (await Promise.race([navigator.serviceWorker.ready.then(() => 'ready'), late]) === 'ready') {
			return 'ready';
		}

		const registration = await navigator.serviceWorker.getRegistration();

		if (!registration) {
			return `no service worker registered after ${ms} ms`;
		}

		const {active, installing, waiting} = registration;

		return `service worker not ready after ${ms} ms: installing ${installing?.state}, waiting ${waiting?.state}, active ${active?.state}`;
	}, timeout);

	assert.equal(state, 'ready');
}

// ----------------------------------------------------------------- tests

describe('checklists', () => {
	test('a Kanto list ticks itself, takes hand ticks, filters, survives offline, and a custom list comes and goes', {timeout: TEST_TIMEOUT}, async () => {
		const {context, counts, errors, net, page} = await device(null, 'phone', {serviceWorkers: 'allow'});

		await seedLocal(page, documentWith(CARDS));

		// The tab and the empty state.
		await page.click('.tabs a[data-tab="lists"]');
		await page.waitForSelector('#add-list');
		assert.equal(new URL(page.url()).pathname, `${BASE}lists`);
		assert.equal(await page.locator('.tabs a[data-tab="lists"]').getAttribute('aria-current'), 'page');
		assert.match(await page.locator('.empty-state').textContent(), /No lists yet/);
		await page.screenshot({path: '/tmp/checklists-empty.png'});

		// Add Kanto.
		await page.selectOption('#add-region', 'kanto');
		await page.click('#add-region-button');
		await page.waitForURL(/\/lists\/[0-9a-f-]+$/);
		await waitForSummary(page, '4 owned, 147 missing.');
		assert.equal(await page.locator('#checklist-title').textContent(), 'Kanto');
		assert.match(await page.locator('#checklist-meta').textContent(), /4 \/ 151/);
		assert.equal(await page.locator('.dex-row').count(), 151);
		assert.equal(counts.graphql, 1, 'one request for the international card list');
		assert.equal(counts.single, 1, 'the Japanese card is read on its own');

		// Auto ticks, with the copy count.
		const row = (n) => page.locator(`.dex-row[data-dex="${n}"]`);

		assert.match(await row(1).getAttribute('class'), /\bowned\b/);
		assert.equal(await row(1).locator('.dex-mark-text').textContent(), '2 cards');
		assert.equal(await row(4).locator('.dex-mark-text').textContent(), '1 card');
		assert.match(await row(7).getAttribute('class'), /\bowned\b/, 'a Japanese card counts');
		assert.match(await row(25).getAttribute('class'), /\bowned\b/);
		assert.match(await row(150).getAttribute('class'), /\bmissing\b/, 'a deleted copy does not count');
		assert.equal(await row(1).locator('.dex-name').textContent(), 'Bulbasaur');
		assert.equal(await row(1).locator('.dex-num').textContent(), '#001');
		await row(1).locator('img.sprite').waitFor();
		await row(3).locator('.sprite-fallback').waitFor();
		await page.screenshot({path: '/tmp/checklists-kanto.png'});

		// Hand ticks: a different mark, saved in the document, and two quick
		// taps both kept.
		await row(2).locator('button').click();
		await waitForSummary(page, '4 owned, 1 marked by hand, 146 missing.');
		assert.match(await row(2).getAttribute('class'), /\bhand\b/);
		assert.equal(await row(2).locator('.dex-mark-text').textContent(), 'marked by hand');
		assert.equal(await row(2).locator('.tick-hand').count(), 1);
		assert.equal(await row(1).locator('.tick-owned').count(), 1);
		assert.equal(await row(2).locator('button').getAttribute('aria-pressed'), 'true');

		await row(5).locator('button').click();
		await row(6).locator('button').click();
		await waitForSummary(page, '4 owned, 3 marked by hand, 144 missing.');
		await page.waitForFunction(async () => {
			const doc = await (await import('/pokemon-card-tracker/js/collection.js')).loadDocument();
			const goal = doc.goals.find((item) => item.kind === 'region');

			return goal && ['2', '5', '6'].every((n) => goal.hand_ticks[n]);
		});

		// Untick one.
		await row(6).locator('button').click();
		await waitForSummary(page, '4 owned, 2 marked by hand, 145 missing.');

		let goal = (await localDoc(page)).goals.find((item) => item.kind === 'region');

		assert.deepEqual(Object.keys(goal.hand_ticks).sort(), ['2', '5']);
		assert.equal(goal.target, 'kanto');
		assert.ok(goal.id && goal.updated_at && goal.deleted_at === null);

		// Hand ticks never count as owned anywhere else: the cards are untouched.
		assert.equal((await localDoc(page)).cards.length, CARDS.length);

		// An owned row carries its mark with nothing to tap, and the entry
		// opens every card of the Pokémon (js/pokemon-cards-view.js). A list
		// that names no languages counts a copy in any language, as its ticks
		// do, and says so, with no flags; the Pokémon's screen agrees.
		const listPath = new URL(page.url()).pathname;

		assert.equal(await row(1).locator('button').count(), 0, 'no hand tick on an owned row');
		assert.equal(await row(1).locator('a.dex-link').getAttribute('href'), `${listPath}/pokemon/1`);
		assert.equal(await page.locator('#list-languages-all').textContent(), 'All');
		assert.equal(await page.locator('#list-languages .pc-languages-names').textContent(), 'Counts copies in any language');
		assert.equal(await page.locator('#list-languages img.flag').count(), 0);
		assert.equal(await page.locator('#list-languages-edit').getAttribute('aria-label'), 'Change the list\'s languages (any language)');
		await row(1).locator('a.dex-link').click();
		await page.waitForURL(`**${listPath}/pokemon/1`);
		// Both copies count, the Portuguese and the English one, and every
		// catalog is shown.
		await waitForPokemonTitle(page, 'Bulbasaur, 1 of 1 card');
		assert.equal(await page.locator('#pc-back').textContent(), '‹ Kanto');
		assert.equal(await page.locator('#list-languages-all').textContent(), 'All');
		assert.deepEqual(await page.locator('.pc-section').evaluateAll((sections) => sections.map((section) => section.dataset.catalog)), ['international', 'ja', 'ko', 'zh-cn', 'zh-tw']);
		assert.deepEqual(await flagsIn(page, '.pc-cell[data-card="tst1-001"] .badge-lang'), ['pt', 'en']);
		assert.match(await page.locator('.pc-cell[data-card="tst1-001"] .tile-name').textContent(), /Test Bulbasaur/);
		assert.equal(counts.sets, 1);
		assert.equal(counts.dexCards, 1);
		assert.equal(counts.asian, 4, 'one list from each Asian catalog');
		await page.screenshot({path: '/tmp/checklists-pokemon-cards.png'});
		await page.click('#pc-back');
		await waitForSummary(page, '4 owned, 2 marked by hand, 145 missing.');
		assert.equal(new URL(page.url()).pathname, listPath);

		// A Japanese print with no English name shows the English one, with
		// the original and PokeAPI's romaji under it.
		await row(7).locator('a.dex-link').click();
		await waitForPokemonTitle(page, 'Squirtle, 1 of 1 card');

		const squirtle = page.locator('.pc-section[data-catalog="ja"] .pc-cell[data-card="tstj-007"]');

		assert.equal(await squirtle.locator('.tile-name').textContent(), 'Squirtle');
		assert.equal(await squirtle.locator('.tile-original').textContent(), 'ゼニガメ (Zenigame)');
		assert.deepEqual(await flagsIn(page, '.pc-cell[data-card="tstj-007"] .badge-lang'), ['ja']);
		await page.click('#pc-back');
		await waitForSummary(page, '4 owned, 2 marked by hand, 145 missing.');

		// Missing only, remembered across a reload.
		await page.click('#checklist-filter label:has-text("Missing")');
		assert.equal(await page.locator('.dex-row').count(), 145);
		assert.equal(await page.locator('.dex-row.owned, .dex-row.hand').count(), 0);
		await page.reload();
		await waitForSummary(page, '4 owned, 2 marked by hand, 145 missing.');
		assert.ok(await page.locator('#checklist-filter input[value="missing"]').isChecked());
		assert.equal(await page.locator('.dex-row').count(), 145);
		await page.screenshot({path: '/tmp/checklists-missing.png'});

		// #8 is near the top of the Missing list, so its sprite loads now and
		// the service worker keeps it for offline use.
		await page.waitForFunction(() => {
			const img = document.querySelector('.dex-row[data-dex="8"] img.sprite');

			return img && img.complete && img.naturalWidth > 0;
		}, null, {timeout: 15000});

		await page.click('#checklist-filter label:has-text("Owned")');
		assert.equal(await page.locator('.dex-row').count(), 6);

		// Offline: the app opens from the service worker, and the list,
		// names, ownership, and the Missing filter all come from the phone.
		await serviceWorkerReady(page);
		await page.waitForFunction(async () => {
			const keys = await caches.keys();

			for (const key of keys.filter((name) => name.startsWith('card-tracker-shell-'))) {
				const cache = await caches.open(key);
				const paths = (await cache.keys()).map((request) => new URL(request.url).pathname);

				if (paths.includes('/pokemon-card-tracker/js/checklists-view.js')) {
					const sprites = await caches.open('card-tracker-images');

					return (await sprites.keys()).some((request) => request.url.endsWith('/8.png'));
				}
			}

			return false;
		}, null, {timeout: 30000});

		const listUrl = page.url();
		const before = {...counts};

		net.offline = true;
		await context.setOffline(true);
		await page.goto(listUrl);
		await waitForSummary(page, '4 owned, 2 marked by hand, 145 missing.');
		await page.click('#checklist-filter label:has-text("Missing")');
		assert.equal(await page.locator('.dex-row').count(), 145);
		assert.equal(await page.locator('.dex-row[data-dex="3"] .dex-name').textContent(), 'Venusaur');
		// A sprite seen online comes from the service worker's image cache.
		// #3 failed online, so it was never kept, and #151 was never in view,
		// so both show the number instead.
		await page.waitForFunction(() => {
			const img = document.querySelector('.dex-row[data-dex="8"] img.sprite');

			return img && img.complete && img.naturalWidth > 0;
		}, null, {timeout: 15000});
		await page.locator('.dex-row[data-dex="3"] .sprite-fallback').waitFor();
		await page.locator('.dex-row[data-dex="151"]').scrollIntoViewIfNeeded();
		await page.locator('.dex-row[data-dex="151"] .sprite-fallback').waitFor();
		assert.deepEqual(counts, before, 'nothing was fetched offline');
		assert.deepEqual(await shownErrors(page), []);
		await page.screenshot({path: '/tmp/checklists-offline.png'});

		// A hand tick offline is saved on the phone.
		await page.locator('.dex-row[data-dex="9"] button').click();
		await waitForSummary(page, '4 owned, 3 marked by hand, 144 missing.');

		await page.click('.back');
		await page.waitForSelector('.list-tile .owned-count');
		assert.match(await page.locator('.list-tile').textContent(), /Kanto.*7 \/ 151/);

		net.offline = false;
		await context.setOffline(false);

		// A custom list, picked by name and by number.
		await page.click('#build-own');
		await page.fill('#custom-name', 'Fire and friends');
		await page.fill('#picker-search', 'char');
		await page.click('.picker-item:has-text("Charmander")');
		await page.fill('#picker-search', '25');
		await page.click('.picker-item:has-text("Pikachu")');
		await page.fill('#picker-search', 'eev');
		await page.click('.picker-item:has-text("Eevee")');
		assert.equal(await page.locator('#picker-count').textContent(), '3 Pokémon chosen.');

		// Japanese and Korean names and their readings find a Pokémon too.
		for (const query of ['Ptera', 'プテラ', '프테라', 'peutera']) {
			await page.fill('#picker-search', query);
			assert.deepEqual(await page.locator('.picker-item .dex-name').allTextContents(), ['Aerodactyl'], query);
		}

		await page.fill('#picker-search', '');
		await page.screenshot({path: '/tmp/checklists-custom-builder.png'});
		await page.click('#create-custom');
		await page.waitForURL(/\/lists\/[0-9a-f-]+$/);
		await waitForSummary(page, '2 owned, 1 missing.');
		assert.equal(await page.locator('#checklist-title').textContent(), 'Fire and friends');
		// The filter is remembered from the last list (Missing): one row.
		assert.equal(await page.locator('.dex-row').count(), 1);
		await page.click('#checklist-filter label:has-text("All")');
		assert.deepEqual(await page.locator('.dex-row .dex-num').allTextContents(), ['#004', '#025', '#133']);

		const customId = new URL(page.url()).pathname.split('/').pop();

		goal = (await localDoc(page)).goals.find((item) => item.id === customId);
		assert.equal(goal.kind, 'custom_pokemon');
		assert.deepEqual(goal.dex_list, [4, 25, 133]);

		// Delete it: a tombstone stays in the document.
		page.once('dialog', (dialog) => dialog.accept());
		await page.click('#delete-list');
		await page.waitForURL(/\/lists$/);
		await page.waitForSelector('.list-tile');
		assert.equal(await page.locator('.list-tile').count(), 1);
		goal = (await localDoc(page)).goals.find((item) => item.id === customId);
		assert.ok(goal.deleted_at, 'deleted softly');

		// Rename Kanto.
		await page.click('.list-tile');
		await waitForSummary(page, '4 owned, 3 marked by hand, 144 missing.');
		page.once('dialog', (dialog) => dialog.accept('Gen 1'));
		await page.click('#rename-list');
		await page.waitForFunction(() => document.getElementById('checklist-title').textContent === 'Gen 1');
		assert.equal((await localDoc(page)).goals.find((item) => item.kind === 'region').name, 'Gen 1');

		// The card list was downloaded once in all.
		assert.equal(counts.graphql, 1);
		assert.equal(counts.names, 1);

		// Existing views still open.
		await page.click('.tabs a[data-tab="cards"]');
		await page.waitForSelector('#cards-summary');
		assert.match(await page.locator('#cards-summary').textContent(), /^6 copies/);
		await page.goto(url('import'));
		await page.waitForSelector('label[for="monprice-file"]');
		await page.goto(url('check'));
		await page.waitForSelector('h2');
		assert.deepEqual(await shownErrors(page), []);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a list made signed in syncs, and a family member sees it read only', {timeout: TEST_TIMEOUT}, async () => {
		const fake = new FakeSupabase();
		const owner = fake.addUser('owner@example.test');
		const kid = fake.addUser('kid@example.test');
		const ownerDevice = await device(fake, 'owner');

		await seedLocal(ownerDevice.page, documentWith(CARDS));
		await signIn(ownerDevice.page, fake, owner.email);
		await waitForStatus(ownerDevice.page, 'Synced');

		// The owner makes a Kanto list and ticks #2 by hand; both reach the server.
		await ownerDevice.page.goto(url('lists'));
		await ownerDevice.page.selectOption('#add-region', 'kanto');
		await ownerDevice.page.click('#add-region-button');
		await waitForSummary(ownerDevice.page, '4 owned, 147 missing.');
		await ownerDevice.page.locator('.dex-row[data-dex="2"] button').click();
		await waitForSummary(ownerDevice.page, '4 owned, 1 marked by hand, 146 missing.');
		await waitForStatus(ownerDevice.page, 'Synced');

		const pushed = () => ((fake.documents.get(owner.id) || {}).doc || {}).goals || [];

		await until(() => pushed().length === 1 && pushed()[0].hand_ticks['2']);
		assert.equal(pushed().length, 1, 'the goal is on the server');
		assert.equal(pushed()[0].target, 'kanto');
		assert.ok(pushed()[0].hand_ticks['2'], 'the hand tick is on the server');

		// The kid, in the same family, sees the owner's lists read only.
		fake.members.push({group_id: fake.groups[0].id, role: 'member', user_id: kid.id});
		fake.profiles.set(owner.id, {display_name: 'Eric', user_id: owner.id});

		const {context, errors, page} = await device(fake, 'kid');

		await signIn(page, fake, kid.email);
		await waitForStatus(page, 'Synced');
		await page.goto(url('lists'));
		// The header's Mine switcher opens the owner's lists.
		await page.waitForSelector('#owner-switch:not([hidden])');
		await page.click('#owner-switch');
		await page.click(`#owner-sheet .owner-option[data-member="${owner.id}"]`);
		await page.waitForSelector('.view-only');
		assert.equal(new URL(page.url()).pathname, `${BASE}family/${owner.id}/lists`);
		assert.match(await page.locator('.view-only').textContent(), /Eric's lists, view only/);
		assert.equal(await page.locator('#add-list').count(), 0, 'no Add in the view');
		await page.waitForSelector('.list-tile .owned-count');
		assert.match(await page.locator('.list-tile').textContent(), /Kanto.*5 \/ 151/);

		await page.click('.list-tile');
		await waitForSummary(page, '4 owned, 1 marked by hand, 146 missing.');
		assert.equal(new URL(page.url()).pathname.startsWith(`${BASE}family/${owner.id}/lists/`), true);
		assert.equal(await page.locator('.dex-row button').count(), 0, 'no hand ticks in the view');
		assert.equal(await page.locator('#list-languages-edit').count(), 0, 'no languages Edit in the view');
		assert.equal(await page.locator('.dex-row[data-dex="3"] a.dex-link').getAttribute('href'), `${new URL(page.url()).pathname}/pokemon/3`);
		assert.equal(await page.locator('.actions').count(), 0, 'no Rename or Delete in the view');
		await page.screenshot({path: '/tmp/checklists-family.png'});

		// Viewing changed nothing for either person.
		assert.equal((await localDoc(page)).goals.length, 0);
		assert.equal(pushed().length, 1);
		assert.deepEqual(errors, []);
		assert.deepEqual(ownerDevice.errors, []);
		await context.close();
		await ownerDevice.context.close();
	});
});
