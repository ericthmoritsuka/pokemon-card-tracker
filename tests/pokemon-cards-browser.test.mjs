// Browser tests for every card of a Pokémon (js/pokemon-cards-view.js),
// opened from a checklist row. Headless Chromium at 360 x 740 against
// tests/pokemon-cards-harness.mjs, which checks that the real app.js,
// index.html, sw.js, and js/checklists-view.js carry the screen's
// integration lines, then serves the real app.
//
// TCGdex answers with the real responses for Jigglypuff (dex 39) recorded in
// tests/pokemon-cards-fixtures.mjs; PokeAPI, the sprite and image hosts, and
// Supabase (tests/fake-supabase.mjs, or a route that fails the test signed
// out) are faked. The collection is made up.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/pokemon-cards-browser.test.mjs

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {speciesRows} from './fake-pokeapi.mjs';
import {FakeSupabase} from './fake-supabase.mjs';
import {FIXTURES} from './pokemon-cards-fixtures.mjs';
import {startHarness} from './pokemon-cards-harness.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const VIEWPORT = {height: 740, width: 360};
const TEST_TIMEOUT = 240000;
const SHOTS = '/tmp/pokemon-cards';

let harness;
let browser;

before(async () => {
	harness = await startHarness();
	browser = await chromium.launch();
});

after(async () => {
	await browser?.close();
	await harness?.close();
});

const url = (path = '') => `${harness.origin}${BASE}${path}`;

// ----------------------------------------------------------- test data

const AT = '2026-09-01T00:00:00.000Z';
const LIST = 'list-pink';

const variantOf = (path, test) => FIXTURES.cards[path].variants_detailed.find(test).variantId;

const REVERSE_151 = variantOf('en/cards/sv03.5-039', (variant) => variant.type === 'reverse');
const NORMAL_151 = variantOf('en/cards/sv03.5-039', (variant) => variant.type === 'normal');
const MASTER_BALL_JA = variantOf('ja/cards/SV2a-039', (variant) => variant.foil === 'masterball');

const entry = (id, fields) => ({created_at: AT, deleted_at: null, id, language: 'pt', language_source: 'manual', updated_at: AT, ...fields});

// Owned in Portuguese: 151 (reverse), the TAG TEAM Cosmic Eclipse card, and
// Jungle. In English only: Darkness Ablaze, and 151 again (normal). A
// deleted Portuguese XY copy never counts. A Japanese 151 Master Ball.
const CARDS = [
	entry('c1', {card_id: 'sv03.5-039', catalog: 'international', variant_id: REVERSE_151}),
	entry('c2', {card_id: 'sv03.5-039', catalog: 'international', language: 'en', variant_id: NORMAL_151}),
	entry('c3', {card_id: 'sm12-165', catalog: 'international'}),
	entry('c4', {card_id: 'base2-54', catalog: 'international'}),
	entry('c5', {card_id: 'swsh3-67', catalog: 'international', language: 'en'}),
	entry('c6', {card_id: 'xy1-87', catalog: 'international', deleted_at: AT}),
	entry('c7', {card_id: 'SV2a-039', catalog: 'ja', language: 'ja', variant_id: MASTER_BALL_JA}),
];

// A list that names Portuguese as its one language (a list that names none
// counts every language: tests/checklists.test.mjs).
const GOAL = {created_at: AT, deleted_at: null, dex_list: [35, 39], hand_ticks: {}, id: LIST, kind: 'custom_pokemon', languages: ['pt'], level: null, name: 'Pink ones', target: null, updated_at: AT};

function documentWith(cards, goals = [GOAL]) {
	return {binders: [], cards, collections: [], goals, openings: [], person: 'local', updated_at: AT, user_id: null, version: 1, wishlist: []};
}

// The real names of the species these cards show (PokeAPI, 2026-10-01).
const SPECIES = {
	35: {en: 'Clefairy', ja: 'ピッピ', 'ja-roma': 'Pippi', ko: '삐삐', 'zh-hans': '皮皮', 'zh-hant': '皮皮'},
	39: {en: 'Jigglypuff', ja: 'プリン', 'ja-roma': 'Purin', ko: '푸린', 'zh-hans': '胖丁', 'zh-hant': '胖丁'},
	428: {en: 'Lopunny', ja: 'ミミロップ', 'ja-roma': 'Mimirop', ko: '이어롭', 'zh-hans': '长耳兔', 'zh-hant': '長耳兔'},
};

const LANGUAGE_IDS = {9: 'en', 11: 'ja', 2: 'ja-roma', 3: 'ko', 12: 'zh-hans', 4: 'zh-hant'};

function speciesBody() {
	const rows = speciesRows({}).map((row) => {
		const real = SPECIES[row.pokemon_species_id];

		return real ? {...row, name: real[LANGUAGE_IDS[row.language_id]]} : row;
	});

	return JSON.stringify({data: {pokemonspeciesname: rows}});
}

// A 1 x 1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const PHYSICAL = FIXTURES.bulk.filter((card) => (card.dexId || []).includes(39)).filter((card) => !['A1-193', 'A2b-060', 'A3-228', 'P-A-022'].includes(card.id));

// What Count every finish should total, worked out here from the recorded
// variants: a standard-size variant with no stamp but 1st Edition, by its
// ball pattern, 1st Edition, reverse, or else the plain print.
function finishesOf(detail) {
	const codes = new Set();

	for (const variant of detail.variants_detailed || []) {
		if ((variant.size && variant.size !== 'standard') || (variant.stamp || []).some((stamp) => stamp !== '1st-edition')) {
			continue;
		}

		codes.add(['pokeball', 'masterball'].includes(variant.foil) ? variant.foil : (variant.stamp || []).includes('1st-edition') ? 'first' : variant.type === 'reverse' ? 'reverse' : 'normal');
	}

	return codes.size || 1;
}

const INTERNATIONAL_FINISHES = PHYSICAL.reduce((sum, card) => sum + finishesOf(FIXTURES.cards[`en/cards/${card.id}`]), 0);

async function fakeServices(context, counts, net) {
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());

	await context.route('https://api.tcgdex.net/**', (route) => {
		if (net.offline) {
			return route.abort('internetdisconnected');
		}

		const request = route.request();
		const target = new URL(request.url());
		const path = target.pathname.replace(/^\/v2\//, '');
		const reply = (data) => route.fulfill({body: JSON.stringify(data), contentType: 'application/json', status: 200});

		if (path === 'graphql') {
			const {query} = JSON.parse(request.postData() || '{}');

			if (/cards\(filters: \{dexId: 39\}\)/.test(query)) {
				counts.dexCards++;

				return reply({data: {cards: FIXTURES.dexCards}});
			}

			if (/^\{ sets /.test(query)) {
				counts.sets++;

				return reply({data: {sets: FIXTURES.sets}});
			}

			if (query === '{ cards { id dexId } }') {
				counts.bulk++;

				return reply({data: {cards: FIXTURES.bulk}});
			}

			return route.fulfill({body: '{"errors":[{"message":"not recorded"}]}', contentType: 'application/json', status: 400});
		}

		const list = /^([a-z-]+)\/cards$/.exec(path);

		if (list && target.searchParams.get('dexId') === 'eq:39') {
			counts.asian[list[1]] = (counts.asian[list[1]] || 0) + 1;

			return reply(FIXTURES.asian[list[1]] || []);
		}

		const jaSet = /^ja\/sets\/(.+)$/.exec(path);

		if (jaSet && FIXTURES.jaSets[decodeURIComponent(jaSet[1])]) {
			counts.jaSets++;

			return reply(FIXTURES.jaSets[decodeURIComponent(jaSet[1])]);
		}

		const card = FIXTURES.cards[decodeURIComponent(path)];

		if (card) {
			counts.cards++;
			counts.cardsIn[path.split('/')[0]] = (counts.cardsIn[path.split('/')[0]] || 0) + 1;

			return reply(card);
		}

		counts.other.push(path);

		return route.fulfill({body: '{}', contentType: 'application/json', status: 404});
	});

	const names = speciesBody();

	await context.route('https://graphql.pokeapi.co/**', (route) => (net.offline ? route.abort('internetdisconnected') : route.fulfill({body: names, contentType: 'application/json', status: 200})));
	await context.route('https://pokeapi.co/**', (route) => route.abort());
	await context.route('https://raw.githubusercontent.com/**', (route) => (net.offline ? route.abort('internetdisconnected') : route.fulfill({body: PNG, contentType: 'image/png', status: 200})));
	await context.route('https://assets.tcgdex.net/**', (route) => (net.offline ? route.abort('internetdisconnected') : route.fulfill({body: PNG, contentType: 'image/png', status: 200})));
}

async function device(fake, name, {serviceWorkers = 'block'} = {}) {
	const context = await browser.newContext({hasTouch: true, serviceWorkers, viewport: VIEWPORT});
	const counts = {asian: {}, bulk: 0, cards: 0, cardsIn: {}, dexCards: 0, jaSets: 0, other: [], sets: 0};
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

const titleText = (page) => page.locator('#pc-title').textContent();

async function waitForTitle(page, text, timeout = 20000) {
	await page.waitForFunction((expected) => (document.getElementById('pc-title') || {}).textContent === expected, text, {timeout}).catch(async (err) => {
		throw new Error(`Title is "${await titleText(page)}", not "${text}". Status: "${await page.locator('#pc-status').textContent()}". ${err.message}`);
	});
}

// A card with one finish counts the same read or not, so the title can
// reach its final text before the last records are in.
async function finishesRead(page) {
	await page.waitForFunction(() => !/Reading finishes/.test(document.getElementById('pc-status').textContent), null, {timeout: 40000});
}

const cellIds = (page, catalog = 'international') => page.locator(`.pc-section[data-catalog="${catalog}"] .pc-cell`).evaluateAll((cells) => cells.map((cell) => cell.dataset.card));

const flagsOf = (page, cardId) => page.locator(`.pc-cell[data-card="${cardId}"] .badge-lang img.flag`).evaluateAll((flags) => flags.map((flag) => flag.dataset.lang));

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

async function serviceWorkerReady(page, timeout = 30000) {
	const state = await page.evaluate(async (ms) => {
		const late = new Promise((resolve) => setTimeout(resolve, ms, 'late'));

		if (await Promise.race([navigator.serviceWorker.ready.then(() => 'ready'), late]) === 'ready') {
			return 'ready';
		}

		const registration = await navigator.serviceWorker.getRegistration();

		return registration ? `installing ${registration.installing?.state}, waiting ${registration.waiting?.state}, active ${registration.active?.state}` : 'no service worker';
	}, timeout);

	assert.equal(state, 'ready');
}

// A horizontal swipe from right to left across the card page.
async function swipeLeft(page) {
	await page.evaluate(() => {
		const target = document.querySelector('#view .card-detail') || document.getElementById('view');
		const touch = (x, y) => new Touch({clientX: x, clientY: y, identifier: 1, target});

		target.dispatchEvent(new TouchEvent('touchstart', {bubbles: true, changedTouches: [touch(300, 420)], touches: [touch(300, 420)]}));
		target.dispatchEvent(new TouchEvent('touchend', {bubbles: true, changedTouches: [touch(140, 428)], touches: []}));
	});
}

// ----------------------------------------------------------------- tests

describe('every card of a Pokémon', () => {
	test('Jigglypuff: count, marks and flags, languages, wishlist, every finish, swipe, and offline', {timeout: TEST_TIMEOUT}, async () => {
		const {context, counts, errors, net, page} = await device(null, 'phone', {serviceWorkers: 'allow'});

		await seedLocal(page, documentWith(CARDS));

		// The checklist shows the list's languages, and the row opens the
		// Pokémon's cards.
		await page.goto(url(`lists/${LIST}`));
		await page.waitForSelector('.dex-row[data-dex="39"] a.dex-link');
		assert.deepEqual(await page.locator('#list-languages img.flag').evaluateAll((flags) => flags.map((flag) => flag.dataset.lang)), ['pt']);
		await page.click('.dex-row[data-dex="39"] a.dex-link');
		assert.equal(new URL(page.url()).pathname, `${BASE}lists/${LIST}/pokemon/39`);

		// Portuguese only: 41 cards list Jigglypuff, four are TCG
		// Pocket, and three are owned in Portuguese (the TAG TEAM card among
		// them). An English copy does not count.
		await waitForTitle(page, 'Jigglypuff, 3 of 37 cards');
		assert.equal(PHYSICAL.length, 37);
		assert.equal(await page.locator('#pc-back').textContent(), '‹ Pink ones');

		const ids = await cellIds(page);

		assert.equal(ids.length, 37);
		assert.ok(['A1-193', 'A2b-060', 'A3-228', 'P-A-022'].every((id) => !ids.includes(id)), 'no TCG Pocket card');
		assert.deepEqual(ids.slice(0, 3), ['me02-076', '2024sv-4', 'sv04.5-198'], 'newest first');
		assert.ok(ids.includes('sm12-165'), 'the TAG TEAM card');
		assert.equal(await page.locator('.pc-heading').count(), 0, 'one catalog needs no heading');

		for (const id of ['sv03.5-039', 'sm12-165', 'base2-54']) {
			assert.equal(await page.locator(`.pc-cell[data-card="${id}"] .badge-owned`).count(), 1, `${id} is owned`);
			assert.deepEqual(await flagsOf(page, id), ['pt'], `${id} carries Brazil only`);
			assert.equal(await page.locator(`.pc-cell[data-card="${id}"] .pc-wish`).count(), 0);
		}

		for (const id of ['swsh3-67', 'xy1-87', 'me02-076']) {
			assert.equal(await page.locator(`.pc-cell[data-card="${id}"] .tile.unowned`).count(), 1, `${id} is dimmed`);
			assert.deepEqual(await flagsOf(page, id), [], `${id} has no flag`);
			assert.equal(await page.locator(`.pc-cell[data-card="${id}"] .pc-wish`).textContent(), 'Add to wishlist');
		}

		assert.equal(await page.locator('.pc-cell[data-card="sm12-165"] .tile-name').textContent(), 'Mega Lopunny & Jigglypuff GX');
		assert.equal(counts.bulk, 1, 'the bulk list, once');
		assert.equal(counts.sets, 1);
		assert.equal(counts.dexCards, 1);
		// The checklist read the Japanese copy's record to find its Pokémon;
		// this screen reads none until Count every finish.
		assert.equal(counts.cardsIn.en || 0, 0, 'no card records until Count every finish');
		await page.screenshot({fullPage: false, path: `${SHOTS}-pt.png`});

		// One tap puts a missing card on the wishlist, in the list's one
		// language.
		await page.click('.pc-cell[data-card="xy1-87"] .pc-wish');
		await page.waitForSelector('.pc-cell[data-card="xy1-87"] .pc-wished');
		assert.equal(await page.locator('.pc-cell[data-card="xy1-87"] .badge-wanted').count(), 1);

		const wishes = (await localDoc(page)).wishlist.filter((item) => !item.deleted_at);

		assert.equal(wishes.length, 1);
		assert.deepEqual({card: wishes[0].card_id, catalog: wishes[0].catalog, language: wishes[0].language, variant: wishes[0].variant_id}, {card: 'xy1-87', catalog: 'international', language: 'pt', variant: null});

		// All, Owned, Missing, in that order, remembered.
		assert.deepEqual(await page.locator('#pc-filter label').allTextContents(), ['All', 'Owned', 'Missing']);
		await page.click('#pc-filter label:has-text("Missing")');
		assert.equal((await cellIds(page)).length, 34);
		await page.reload();
		await waitForTitle(page, 'Jigglypuff, 3 of 37 cards');
		assert.ok(await page.locator('#pc-filter input[value="missing"]').isChecked());
		assert.equal((await cellIds(page)).length, 34);
		await page.click('#pc-filter label:has-text("Owned")');
		assert.deepEqual((await cellIds(page)).sort(), ['base2-54', 'sm12-165', 'sv03.5-039']);
		await page.click('#pc-filter label:has-text("All")');

		// Count every finish: each card's record is read once, and kept.
		await page.click('label[for="pc-finishes"]');
		await waitForTitle(page, `Jigglypuff, 3 of ${INTERNATIONAL_FINISHES} finishes`, 40000);
		await finishesRead(page);
		assert.ok(INTERNATIONAL_FINISHES > 37, `${INTERNATIONAL_FINISHES} finishes`);
		assert.equal(counts.cardsIn.en, 37);
		assert.match(await page.locator('.pc-cell[data-card="sv03.5-039"] .tile-meta').textContent(), /1 of 2 finishes/);
		assert.match(await page.locator('.pc-cell[data-card="base2-54"] .tile-meta').textContent(), /1 of 2 finishes/);
		await page.reload();
		await waitForTitle(page, `Jigglypuff, 3 of ${INTERNATIONAL_FINISHES} finishes`, 40000);
		await finishesRead(page);
		assert.ok(await page.locator('#pc-finishes').isChecked(), 'the switch is remembered');
		assert.equal(counts.cardsIn.en, 37, 'the records came from the phone');
		await page.click('label[for="pc-finishes"]');
		await waitForTitle(page, 'Jigglypuff, 3 of 37 cards');

		// Portuguese and English: the English copies count, and 151 shows
		// both flags.
		await page.click('#list-languages-edit');
		await page.check('#list-languages-editor input[value="en"]');
		await page.click('#list-languages-save');
		await waitForTitle(page, 'Jigglypuff, 4 of 37 cards');
		assert.deepEqual(await flagsOf(page, 'sv03.5-039'), ['pt', 'en']);
		assert.deepEqual(await flagsOf(page, 'swsh3-67'), ['en']);
		assert.equal(await page.locator('.pc-cell[data-card="me02-076"] .pc-wish').getAttribute('aria-label'), 'Add Jigglypuff #076 to your wishlist');
		assert.deepEqual((await localDoc(page)).goals.find((goal) => goal.id === LIST).languages, ['pt', 'en']);
		await page.screenshot({path: `${SHOTS}-pt-en.png`});

		// Portuguese and Japanese: a second section, from the Japanese
		// catalog, one request for the cards and one per set.
		await page.click('#list-languages-edit');
		await page.uncheck('#list-languages-editor input[value="en"]');
		await page.check('#list-languages-editor input[value="ja"]');
		await page.click('#list-languages-save');
		await waitForTitle(page, 'Jigglypuff, 4 of 54 cards');
		assert.deepEqual(await page.locator('.pc-heading').allTextContents(), ['International prints', 'Japanese prints']);
		assert.equal((await cellIds(page, 'ja')).length, 17);
		assert.equal(counts.asian.ja, 1);
		assert.equal(counts.jaSets, Object.keys(FIXTURES.jaSets).length);
		assert.deepEqual(await flagsOf(page, 'SV2a-039'), ['ja']);
		assert.equal(await page.locator('.pc-section[data-catalog="ja"] .pc-cell[data-card="SV2a-039"] .tile-name').textContent(), 'Jigglypuff');
		assert.equal(await page.locator('.pc-section[data-catalog="ja"] .pc-cell[data-card="SV2a-039"] .tile-original').textContent(), 'プリン (Purin)');
		assert.deepEqual(await page.locator('.pc-original').allTextContents(), ['プリン (Purin)']);
		assert.match(await page.locator('.pc-section[data-catalog="ja"] .pc-cell[data-card="SV4a-306"] .pc-wish').getAttribute('aria-label'), /in Japanese$/);
		await page.screenshot({fullPage: true, path: `${SHOTS}-pt-ja.png`});

		// A tile opens the card page with this grid as its swipe context.
		const order = [...await cellIds(page), ...await cellIds(page, 'ja')];

		await page.click('.pc-cell[data-card="me02-076"] a.tile');
		await page.waitForURL(`**${BASE}cards/en/me02-076`);
		await page.waitForSelector('#card-position');
		assert.equal(await page.locator('#card-position').textContent(), '1 of 54');
		await page.waitForSelector('.card-detail h2');
		await swipeLeft(page);
		await page.waitForURL(`**${BASE}cards/en/${order[1]}`);
		assert.equal(await page.locator('#card-position').textContent(), '2 of 54');
		await page.keyboard.press('ArrowRight');
		await page.waitForURL(`**${BASE}cards/en/${order[2]}`);
		await page.goBack();
		await page.waitForURL(`**${BASE}lists/${LIST}/pokemon/39`);
		await waitForTitle(page, 'Jigglypuff, 4 of 54 cards');

		// Offline: the app, the prints, the sets, and the finishes already
		// read all come from the phone; Japanese finishes were never read.
		await serviceWorkerReady(page);
		await page.waitForFunction(async () => {
			for (const key of (await caches.keys()).filter((name) => name.startsWith('card-tracker-shell-'))) {
				const paths = (await (await caches.open(key)).keys()).map((request) => new URL(request.url).pathname);

				if (paths.includes('/pokemon-card-tracker/js/pokemon-cards-view.js') && paths.includes('/pokemon-card-tracker/css/pokemon-cards.css')) {
					return true;
				}
			}

			return false;
		}, null, {timeout: 30000});

		const before = JSON.stringify(counts);

		net.offline = true;
		await context.setOffline(true);
		await page.goto(url(`lists/${LIST}/pokemon/39`));
		await page.waitForSelector('#pc-title', {timeout: 15000}).catch(async (err) => {
			await page.screenshot({path: `${SHOTS}-offline-fail.png`});
			throw new Error(`${err.message}\n${page.url()}\n${await page.locator('body').innerText().catch(() => '')}`);
		});
		await waitForTitle(page, 'Jigglypuff, 4 of 54 cards');
		assert.equal((await cellIds(page)).length, 37);
		assert.equal((await cellIds(page, 'ja')).length, 17);
		await page.click('label[for="pc-finishes"]');
		// The checklist read the record of the Japanese 151 copy, so its three
		// finishes count (normal, Poké Ball, Master Ball, the copy's); the
		// other 16 Japanese cards count once each.
		await page.waitForFunction(() => /16 cards' finishes are not on this phone yet, so they count once\./.test(document.getElementById('pc-status').textContent), null, {timeout: 20000}).catch(async (err) => {
			throw new Error(`${err.message}\nStatus: ${await page.locator('#pc-status').textContent()}`);
		});
		assert.equal(await titleText(page), `Jigglypuff, 4 of ${INTERNATIONAL_FINISHES + 16 + 3} finishes`);
		assert.match(await page.locator('.pc-section[data-catalog="ja"] .pc-cell[data-card="SV2a-039"] .tile-meta').textContent(), /1 of 3 finishes/);
		assert.equal(JSON.stringify(counts), before, 'nothing was fetched offline');
		await page.screenshot({path: `${SHOTS}-offline.png`});

		net.offline = false;
		await context.setOffline(false);
		assert.deepEqual(counts.other, []);
		assert.deepEqual(await shownErrors(page), []);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a family member\'s list is read only', {timeout: TEST_TIMEOUT}, async () => {
		const fake = new FakeSupabase();
		const owner = fake.addUser('owner@example.test');
		const kid = fake.addUser('kid@example.test');
		const group = {id: 'group-1', name: 'Family', owner_id: owner.id};

		fake.groups.push(group);
		fake.members.push({group_id: group.id, role: 'owner', user_id: owner.id}, {group_id: group.id, role: 'member', user_id: kid.id});
		fake.profiles.set(owner.id, {display_name: 'Eric', user_id: owner.id});
		fake.documents.set(owner.id, {doc: documentWith(CARDS, [{...GOAL, languages: ['pt', 'en']}]), updated_at: fake.now(), user_id: owner.id});

		const {context, counts, errors, page} = await device(fake, 'kid');

		await signIn(page, fake, kid.email);
		await waitForStatus(page, 'Synced');
		// In the app, as the Mine switcher opens it, so the session is in
		// place when the screen draws.
		await page.evaluate((route) => import('/pokemon-card-tracker/js/dom.js').then(({go}) => go(route)), `family/${owner.id}/lists/${LIST}`);
		await page.waitForSelector('.dex-row[data-dex="39"] a.dex-link', {timeout: 15000}).catch(async (err) => {
			await page.screenshot({path: `${SHOTS}-family-fail.png`});
			throw new Error(`${err.message}\n${await page.locator('#view').innerText()}\n${(await shownErrors(page)).join('\n')}`);
		});
		assert.equal(await page.locator('#list-languages-edit').count(), 0, 'no Edit in the view');
		assert.equal(await page.locator('.dex-row button').count(), 0, 'no hand ticks in the view');
		await page.click('.dex-row[data-dex="39"] a.dex-link');
		assert.equal(new URL(page.url()).pathname, `${BASE}family/${owner.id}/lists/${LIST}/pokemon/39`);

		// The owner's list counts Portuguese and English.
		await waitForTitle(page, 'Jigglypuff, 4 of 37 cards');
		await page.waitForSelector('.view-only');
		assert.match(await page.locator('.view-only').textContent(), /Eric's lists, view only/);
		assert.deepEqual(await flagsOf(page, 'sv03.5-039'), ['pt', 'en']);
		assert.equal(await page.locator('.pc-wish').count(), 0, 'no wishlist buttons');
		assert.equal(await page.locator('#list-languages-edit').count(), 0);
		assert.equal(await page.locator('.pc-cell[data-card="me02-076"] .tile.unowned').count(), 1);
		await page.screenshot({path: `${SHOTS}-family.png`});

		// A card opened here keeps the lens and the grid.
		await page.click('.pc-cell[data-card="sv03.5-039"] a.tile');
		await page.waitForSelector('#card-position');
		assert.match(await page.locator('#card-position').textContent(), /of 37$/);
		assert.equal(await page.locator('.view-only').count(), 1);

		// Viewing changed nothing on this phone.
		const doc = await localDoc(page);

		assert.equal(doc.goals.length, 0);
		assert.equal(doc.wishlist.length, 0);
		assert.equal(counts.bulk, 1);
		assert.deepEqual(errors, []);
		await context.close();
	});
});
