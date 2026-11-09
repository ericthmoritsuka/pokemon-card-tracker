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
import {untilInPage} from './poll.mjs';

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

// What the card page's links need beyond the recordings: the 151 set's
// record, cut to the one Jigglypuff card (made up from the card's own set
// fields), and a Trainer card from the same set, invented.
const SET_151 = {
	...FIXTURES.cards['en/cards/sv03.5-039'].set,
	cards: [{id: 'sv03.5-039', image: FIXTURES.cards['en/cards/sv03.5-039'].image, localId: '039', name: 'Jigglypuff'}],
	releaseDate: '2023-09-22',
	serie: {id: 'sv', name: 'Scarlet & Violet'},
};
const TRAINER = {category: 'Trainer', id: 'sv03.5-196', illustrator: 'Test Artist', image: null, localId: '196', name: 'Test Trainer', rarity: 'Uncommon', set: FIXTURES.cards['en/cards/sv03.5-039'].set, trainerType: 'Supporter', variants: {normal: true, reverse: true}};
const EXTRA = {'en/cards/sv03.5-196': TRAINER, 'en/sets/sv03.5': SET_151};

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

		const card = FIXTURES.cards[decodeURIComponent(path)] || EXTRA[decodeURIComponent(path)];

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

// Seeds the collection from a same-origin page that runs no app code (the
// manifest). Seeding from My Cards left it reading each owned set's record
// (en/sets/<id>, js/cards-view.js filling its card index) and checking the
// Japanese copy's twin in the background; under load those requests went
// out after the test had moved on, and landed in counts.other.
async function seedLocal(page, doc) {
	await page.goto(url('manifest.webmanifest'));
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
		// A list's screen keeps the list's languages control; the row of
		// flags is the screen without a list's alone.
		assert.equal(await page.locator('#pc-flags').count(), 0, 'no flag row on a checklist\'s screen');
		assert.deepEqual(await page.locator('#list-languages img.flag').evaluateAll((flags) => flags.map((flag) => flag.dataset.lang)), ['pt']);

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
		assert.deepEqual(await page.locator('#pc-filter span').evaluateAll((spans) => spans.map((span) => span.dataset.label)), ['All', 'Owned', 'Missing']);
		assert.match((await page.locator('#pc-filter label').allTextContents()).join('|'), /^All \d+\|Owned \d+\|Missing \d+$/);
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

		// Leaving the screen and coming back finds the records kept for the
		// session: no "Reading finishes", and a handful of draws rather than
		// one per record.
		await page.click('#pc-back');
		await page.waitForSelector('.dex-row[data-dex="39"] a.dex-link');
		await page.evaluate(() => {
			window.pcDraws = 0;
			window.pcStatuses = [];
			new MutationObserver((changes) => {
				for (const change of changes) {
					if (change.target.id === 'pc-sections' && change.addedNodes.length) {
						window.pcDraws++;
					}

					if (change.target.id === 'pc-status') {
						window.pcStatuses.push(change.target.textContent);
					}
				}
			}).observe(document.body, {childList: true, subtree: true});
		});
		await page.click('.dex-row[data-dex="39"] a.dex-link');
		await waitForTitle(page, `Jigglypuff, 3 of ${INTERNATIONAL_FINISHES} finishes`, 40000);
		await page.waitForTimeout(500);

		const revisit = await page.evaluate(() => ({draws: window.pcDraws, statuses: window.pcStatuses}));

		assert.ok(revisit.draws <= 8, `${revisit.draws} draws on a return visit`);
		assert.ok(!revisit.statuses.some((text) => /Reading finishes/.test(text)), revisit.statuses.join(' | '));
		assert.equal(counts.cardsIn.en, 37);
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
		await untilInPage(page, 'the shell cache to hold pokemon-cards-view.js and pokemon-cards.css', async () => {
			for (const key of (await caches.keys()).filter((name) => name.startsWith('card-tracker-shell-'))) {
				const paths = (await (await caches.open(key)).keys()).map((request) => new URL(request.url).pathname);

				if (paths.includes('/pokemon-card-tracker/js/pokemon-cards-view.js') && paths.includes('/pokemon-card-tracker/css/pokemon-cards.css')) {
					return true;
				}
			}

			return false;
		}, {timeout: 30000});

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

	test('Any language counts every copy, and a list can go back to it', {timeout: TEST_TIMEOUT}, async () => {
		const {context, errors, page} = await device(null, 'phone');
		// German, Spanish, and Italian copies, one with no language recorded,
		// and one Portuguese, on a list that names no languages.
		const cards = [
			entry('d1', {card_id: 'sv03.5-039', catalog: 'international', language: 'de'}),
			entry('d2', {card_id: 'sm12-165', catalog: 'international', language: 'es'}),
			entry('d3', {card_id: 'base2-54', catalog: 'international', language: 'it'}),
			entry('d4', {card_id: 'swsh3-67', catalog: 'international', language: null}),
			entry('d5', {card_id: 'xy1-87', catalog: 'international'}),
		];
		const anyGoal = {...GOAL};

		delete anyGoal.languages;
		await seedLocal(page, documentWith(cards, [anyGoal]));

		const owned = () => page.evaluate(() => Number((/, (\d+) of /.exec(document.getElementById('pc-title').textContent) || [])[1]));
		const waitOwned = (n) => page.waitForFunction((expected) => new RegExp(`^Jigglypuff, ${expected} of `).test(document.getElementById('pc-title').textContent), n, {timeout: 20000}).catch(async (err) => {
			throw new Error(`Title is "${await titleText(page)}", not ${n} owned. ${err.message}`);
		});
		const savedLanguages = async () => (await localDoc(page)).goals.find((goal) => goal.id === LIST).languages;

		await page.goto(url(`lists/${LIST}/pokemon/39`));
		await waitOwned(5);
		assert.equal(await page.locator('#list-languages-all').textContent(), 'All');

		// Edit opens on Any language, and Save keeps it.
		await page.click('#list-languages-edit');
		assert.ok(await page.locator('#list-languages-any').isChecked());
		assert.equal(await page.locator('#list-languages-editor input[value="pt"]:checked').count(), 0);
		await page.screenshot({path: `${SHOTS}-any-editor.png`});
		await page.click('#list-languages-save');
		await waitOwned(5);
		assert.equal(await savedLanguages(), undefined, 'still no languages field');

		// Portuguese alone counts the Portuguese copy only.
		await page.click('#list-languages-edit');
		await page.check('#list-languages-editor input[value="pt"]');
		assert.equal(await page.locator('#list-languages-any').isChecked(), false, 'a language unticks Any');
		await page.click('#list-languages-save');
		await waitOwned(1);
		assert.deepEqual(await savedLanguages(), ['pt']);

		// Back to Any language: the field goes, and every copy counts again.
		await page.click('#list-languages-edit');
		await page.check('#list-languages-any');
		assert.equal(await page.locator('#list-languages-editor input[value="pt"]').isChecked(), false);
		await page.click('#list-languages-save');
		await waitOwned(5);
		assert.equal(await savedLanguages(), undefined);
		await page.waitForSelector('#list-languages-all');

		// Nothing ticked is refused.
		await page.click('#list-languages-edit');
		await page.uncheck('#list-languages-any');
		await page.click('#list-languages-save');
		assert.equal(await page.locator('#list-languages-editor .form-error').textContent(), 'Pick at least one language, or Any language.');

		// Every box ticked is the same as Any language, so nothing is dropped.
		for (const box of await page.locator('#list-languages-editor input[name="list-language"]:not([value="any"])').all()) {
			await box.check();
		}

		await page.click('#list-languages-save');
		await page.waitForSelector('#list-languages-all');
		await waitOwned(5);
		assert.equal(await savedLanguages(), undefined);
		assert.equal(await owned(), 5);
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

		// Its set opens with the lens on, as Back would; every card of the
		// Pokémon shows your own cards, so the member's card page has no
		// link to it.
		await page.waitForSelector('#card-set-link');
		assert.equal(await page.locator('#card-set-link').getAttribute('href'), `${BASE}sets/en/sv03.5`);
		assert.equal(await page.locator('.card-hero a[id^="card-pokemon-"]').count(), 0);

		// Viewing changed nothing on this phone.
		const doc = await localDoc(page);

		assert.equal(doc.goals.length, 0);
		assert.equal(doc.wishlist.length, 0);
		assert.equal(counts.bulk, 1);
		assert.deepEqual(errors, []);
		await context.close();
	});
});

describe('every card of a Pokémon from the card page, without a list', () => {
	const FLAG_ORDER = ['pt', 'en', 'ja', 'ko', 'zh-cn', 'zh-tw', 'fr', 'de', 'it', 'es'];
	const WESTERN = ['pt', 'en', 'fr', 'de', 'it', 'es'];

	// Each flag: [language, pressed, its count's text, its name].
	const flagStates = (page) => page.locator('#pc-flags .pc-flag').evaluateAll((buttons) => buttons.map((button) => [
		button.dataset.lang,
		button.getAttribute('aria-pressed'),
		button.querySelector('.pc-flag-count').textContent,
		button.getAttribute('aria-label'),
	]));

	const flag = async (page, code) => (await flagStates(page)).find(([lang]) => lang === code);

	// What the screen has asked TCGdex for, to compare before and after.
	const requests = (counts) => JSON.stringify({asian: counts.asian, bulk: counts.bulk, cards: counts.cards, dexCards: counts.dexCards, jaSets: counts.jaSets, other: counts.other.length, sets: counts.sets});

	test('the Set and Pokémon links, and the screen on the card\'s language\'s flag', {timeout: TEST_TIMEOUT}, async () => {
		const {context, counts, errors, page} = await device(null, 'phone');

		await seedLocal(page, documentWith(CARDS, []));

		// The set's name opens the set's page, in the card's language.
		await page.goto(url('cards/en/sv03.5-039'));
		await page.waitForSelector('#card-set-link');
		assert.equal(await page.locator('#card-set-link').textContent(), '151');
		assert.equal(await page.locator('#card-set-link').getAttribute('href'), `${BASE}sets/en/sv03.5`);
		await page.waitForSelector('#card-pokemon-39');
		await page.waitForFunction(() => document.getElementById('card-pokemon-39').textContent === 'Every Jigglypuff card');
		assert.equal(await page.locator('#card-pokemon-39').getAttribute('href'), `${BASE}pokemon/39/en`, 'on the card\'s language');
		await page.screenshot({path: `${SHOTS}-card-links.png`});

		const setBox = await page.locator('#card-set-link').boundingBox();
		const pokemonBox = await page.locator('#card-pokemon-39').boundingBox();

		assert.ok(setBox.height >= 48 && pokemonBox.height >= 48, `targets ${setBox.height} and ${pokemonBox.height} px tall`);
		await page.click('#card-set-link');
		await page.waitForURL(`**${BASE}sets/en/sv03.5`);
		await page.waitForSelector('#view h2:has-text("151")');
		await page.waitForSelector('#view .card-grid a.tile');
		await page.goBack();
		await page.waitForURL(`**${BASE}cards/en/sv03.5-039`);

		// From an English card, the English flag: the international prints,
		// and only English copies count (the 151 one and the Darkness Ablaze
		// one). No Asian catalog is asked for.
		const asianBefore = JSON.stringify(counts.asian);

		await page.click('#card-pokemon-39');
		await page.waitForURL(`**${BASE}pokemon/39/en`);
		await waitForTitle(page, 'Jigglypuff, 2 of 37 cards');
		assert.equal(await page.locator('#pc-back').textContent(), '‹ Back');
		assert.equal(await page.locator('#pc-flags').getAttribute('role'), 'group');
		assert.equal(await page.locator('#pc-flags').getAttribute('aria-label'), 'Languages');
		assert.equal(await page.locator('#list-languages').count(), 0, 'the flags replace the languages control');

		const opened = await flagStates(page);

		assert.deepEqual(opened.map(([lang]) => lang), FLAG_ORDER, 'every language the app knows, in its order');
		assert.deepEqual(opened.filter(([, pressed]) => pressed === 'true').map(([lang]) => lang), ['en']);
		// The Western languages share the international prints, so they
		// loaded together; the others show no count until tapped.
		for (const [lang, , count, name] of opened) {
			if (WESTERN.includes(lang)) {
				assert.equal(count, '37', `${lang} counts its prints`);
				assert.match(name, /, 37 cards$/);
			}
			else {
				assert.equal(count, '', `${lang} shows no count`);
				assert.match(name, /, not loaded$/);
			}
		}

		assert.equal((await flag(page, 'en'))[3], 'English, 37 cards');
		assert.equal((await flag(page, 'ja'))[3], 'Japanese, not loaded');
		assert.equal(JSON.stringify(counts.asian), asianBefore, 'no Asian catalog requested');
		assert.equal(counts.jaSets, 0);
		assert.equal(await page.locator('.pc-heading').count(), 0);
		assert.equal((await cellIds(page)).length, 37);
		assert.deepEqual(await flagsOf(page, 'sv03.5-039'), ['en'], 'its English copy counts here, not the Portuguese one');
		assert.equal(await page.locator('.pc-cell[data-card="me02-076"] .tile.unowned').count(), 1);

		for (const box of await page.locator('#pc-flags .pc-flag').evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height))) {
			assert.ok(box >= 48, `a flag is ${box} px tall`);
		}

		assert.ok(await page.locator('#pc-flags').evaluate((row) => {
			const edge = row.getBoundingClientRect();

			return [...row.children].filter((button) => button.getBoundingClientRect().right <= edge.right).length >= 4;
		}), 'several flags in sight at once, each as wide as its flag and count');
		assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'the row scrolls, the page does not');
		assert.ok(await page.locator('#pc-flags').evaluate((row) => row.scrollWidth > row.clientWidth), 'ten flags overflow a 360 px row');
		await page.screenshot({path: `${SHOTS}-flags-en.png`});

		// Owned and Missing, within English.
		await page.click('#pc-filter label:has-text("Owned")');
		assert.deepEqual((await cellIds(page)).sort(), ['sv03.5-039', 'swsh3-67']);
		await page.click('#pc-filter label:has-text("Missing")');
		assert.equal((await cellIds(page)).length, 35);

		// One tap puts a missing card on the wishlist, in English.
		await page.click('.pc-cell[data-card="xy1-87"] .pc-wish');
		await page.waitForSelector('.pc-cell[data-card="xy1-87"] .pc-wished');
		assert.deepEqual((await localDoc(page)).wishlist.filter((item) => !item.deleted_at).map((item) => [item.card_id, item.language]), [['xy1-87', 'en']]);
		await page.click('#pc-filter label:has-text("All")');

		// Japanese: its catalog loads, and only it, the first time its flag
		// is tapped; the flag then counts its prints.
		await page.click('#pc-flag-ja');
		await waitForTitle(page, 'Jigglypuff, 1 of 17 cards');
		assert.equal(new URL(page.url()).pathname, `${BASE}pokemon/39/ja`);
		assert.deepEqual(await flag(page, 'ja'), ['ja', 'true', '17', 'Japanese, 17 cards']);
		assert.equal((await flag(page, 'en'))[1], 'false');
		assert.deepEqual(counts.asian, {ja: 1}, 'Japanese alone');
		assert.deepEqual(await page.locator('.pc-heading').allTextContents(), ['Japanese prints']);
		assert.equal((await cellIds(page, 'ja')).length, 17);
		assert.equal((await cellIds(page)).length, 0, 'one language at a time');

		for (const lang of ['ko', 'zh-cn', 'zh-tw']) {
			assert.equal((await flag(page, lang))[2], '', `${lang} still shows no count`);
		}

		await page.screenshot({path: `${SHOTS}-flags-ja.png`});

		// Back to English: no new request, and Japanese keeps its count.
		const loaded = requests(counts);

		await page.click('#pc-flag-en');
		await waitForTitle(page, 'Jigglypuff, 2 of 37 cards');
		assert.equal((await cellIds(page)).length, 37);
		await page.waitForTimeout(300);
		assert.equal(requests(counts), loaded, 'switching back asks for nothing');
		assert.equal((await flag(page, 'ja'))[2], '17');

		// Korean: the Korean catalog has no prints of Jigglypuff, and Korean
		// copies are saved on the Japanese prints Korea prints under, so its
		// flag shows those too, with a line saying why.
		await page.click('#pc-flag-ko');
		await page.waitForSelector('.pc-section[data-catalog="ko"] .pc-none');
		await waitForTitle(page, 'Jigglypuff, 0 of 17 cards');
		assert.deepEqual(await flag(page, 'ko'), ['ko', 'true', '17', 'Korean, 17 cards']);
		assert.equal(await page.locator('.pc-section[data-catalog="ko"] .pc-none').textContent(), 'The Korean catalog has no cards of Jigglypuff yet.');
		assert.equal((await cellIds(page, 'ja')).length, 17);
		assert.equal(await page.locator('.pc-section[data-catalog="ja"] .pc-fallback-note').textContent(), 'Korea prints many sets under the Japanese set codes, so a Korean copy is saved on its Japanese print.');
		assert.deepEqual(counts.asian, {ja: 1, ko: 1});

		// Portuguese: the same prints as English, with the Portuguese copies
		// counting, the TAG TEAM card among them.
		await page.click('#pc-flag-pt');
		await waitForTitle(page, 'Jigglypuff, 3 of 37 cards');
		assert.deepEqual(await flagsOf(page, 'sv03.5-039'), ['pt']);
		assert.equal(counts.asian['zh-cn'], undefined, 'never asked for behind the scenes');
		assert.equal(counts.asian['zh-tw'], undefined);

		// A tile opens the card page in the flag's language, with this grid as
		// its swipe context, and that page's Pokémon link comes back to this
		// flag. TCGdex has no Portuguese record of it here, so the page shows
		// the English one. Back returns to the screen on the flag left pressed.
		await page.click('.pc-cell[data-card="me02-076"] a.tile');
		await page.waitForURL(`**${BASE}cards/pt/me02-076`);
		await page.waitForSelector('#card-position');
		assert.equal(await page.locator('#card-position').textContent(), '1 of 37');
		await page.waitForSelector('#card-pokemon-39');
		assert.equal(await page.locator('#card-pokemon-39').getAttribute('href'), `${BASE}pokemon/39/pt`, 'back to the Portuguese flag');
		assert.equal(await page.locator('.card-detail .notice[role="alert"]').count(), 0, 'the English record, not a failure');
		await page.goBack();
		await page.waitForURL(`**${BASE}pokemon/39/pt`);
		await waitForTitle(page, 'Jigglypuff, 3 of 37 cards');
		assert.equal((await flag(page, 'pt'))[1], 'true');
		await page.reload();
		await waitForTitle(page, 'Jigglypuff, 3 of 37 cards');
		assert.equal((await flag(page, 'pt'))[1], 'true');

		// Count every finish, within the flag's language.
		await page.click('#pc-flag-ja');
		await waitForTitle(page, 'Jigglypuff, 1 of 17 cards');

		const englishRead = counts.cardsIn.en || 0;

		await page.click('label[for="pc-finishes"]');
		await finishesRead(page);
		assert.match(await titleText(page), /^Jigglypuff, \d+ of \d+ finishes$/);
		assert.equal(counts.cardsIn.en || 0, englishRead, 'only the Japanese prints\' finishes are read');
		await page.click('label[for="pc-finishes"]');

		// The screen's Back returns to the card page it was opened from.
		await page.goto(url('cards/en/sv03.5-039'));
		await page.click('#card-pokemon-39');
		await waitForTitle(page, 'Jigglypuff, 2 of 37 cards');
		await page.click('#pc-back');
		await page.waitForURL(`**${BASE}cards/en/sv03.5-039`);

		assert.deepEqual(await shownErrors(page), []);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a visit with no language opens on Portuguese, and a Japanese card on Japanese', {timeout: TEST_TIMEOUT}, async () => {
		const {context, counts, errors, page} = await device(null, 'phone');

		await seedLocal(page, documentWith(CARDS, []));

		// The flag lives in the route alone: one chosen on an earlier visit is
		// not where a visit with no language opens.
		await page.goto(url('pokemon/39/en'));
		await waitForTitle(page, 'Jigglypuff, 2 of 37 cards');

		for (const path of ['pokemon/39', 'pokemon/39/xx']) {
			await page.goto(url(path));
			await waitForTitle(page, 'Jigglypuff, 3 of 37 cards');
			assert.equal(new URL(page.url()).pathname, `${BASE}pokemon/39/pt`, `${path} says the flag it opened on`);
			assert.deepEqual((await flagStates(page)).filter(([, pressed]) => pressed === 'true').map(([lang]) => lang), ['pt']);
		}

		assert.deepEqual(counts.asian, {}, 'Portuguese needs no Asian catalog');

		// A Japanese card page links to the Japanese flag.
		await page.goto(url('cards/ja/SV2a-039'));
		await page.waitForSelector('#card-pokemon-39');
		assert.equal(await page.locator('#card-pokemon-39').getAttribute('href'), `${BASE}pokemon/39/ja`);
		await page.click('#card-pokemon-39');
		await waitForTitle(page, 'Jigglypuff, 1 of 17 cards');
		assert.deepEqual(await flag(page, 'ja'), ['ja', 'true', '17', 'Japanese, 17 cards']);
		assert.equal((await flag(page, 'pt'))[2], '', 'Portuguese not loaded on this visit');
		assert.equal(counts.asian['zh-tw'], undefined);

		// Spanish, at the far end of the row, is scrolled into sight.
		await page.goto(url('pokemon/39/es'));
		await waitForTitle(page, 'Jigglypuff, 0 of 37 cards');
		assert.ok(await page.locator('#pc-flag-es').evaluate((button) => {
			const row = button.parentElement.getBoundingClientRect();
			const box = button.getBoundingClientRect();

			return box.left >= row.left && box.right <= row.right;
		}), 'the pressed flag is in sight');
		// Spanish has no card pages of its own: a tile opens the English one.
		assert.equal(await page.locator('.pc-cell[data-card="me02-076"] a.tile').getAttribute('data-link'), 'cards/en/me02-076');

		assert.deepEqual(await shownErrors(page), []);
		assert.deepEqual(errors, []);
		await context.close();
	});

	// A copy saved with no language (an import, a scan) counts on every flag
	// of its catalog, with a "?" in the tile's corner (Eric, 2026-11-09).
	test('a copy with no language counts on every flag of its catalog', {timeout: TEST_TIMEOUT}, async () => {
		const {context, errors, page} = await device(null, 'phone');

		await seedLocal(page, documentWith([...CARDS, entry('c8', {card_id: 'xy1-87', catalog: 'international', language: null})], []));
		await page.goto(url('pokemon/39/de'));
		await waitForTitle(page, 'Jigglypuff, 1 of 37 cards');

		const cell = page.locator('.pc-cell[data-card="xy1-87"]');

		assert.equal(await cell.getAttribute('class'), 'pc-cell pc-owned');
		assert.equal(await cell.locator('.pc-wish').count(), 0, 'no Add to wishlist on an owned card');
		assert.equal(await cell.locator('.badge-lang .flag-unset').textContent(), '?');
		assert.equal(await cell.locator('.badge-lang').getAttribute('aria-label'), 'Owned in language not set');
		await page.screenshot({path: `${SHOTS}-no-language.png`});

		// English: its own two, and the one with no language beside them.
		await page.click('#pc-flag-en');
		await waitForTitle(page, 'Jigglypuff, 3 of 37 cards');
		assert.equal(await cell.getAttribute('class'), 'pc-cell pc-owned');

		// A copy on an international record is not a Japanese print's.
		await page.click('#pc-flag-ja');
		await waitForTitle(page, 'Jigglypuff, 1 of 17 cards');
		assert.deepEqual(await shownErrors(page), []);
		assert.deepEqual(errors, []);
		await context.close();
	});

	// Korean copies are saved on the Japanese records, so a Korean screen's
	// Japanese print goes on the wishlist in Korean, and the wishlist lists
	// it with the Japanese record's card and keeps Korean in its editor.
	test('Add to wishlist on a Japanese print under Korean wishes in Korean, and the wishlist lists it', {timeout: TEST_TIMEOUT}, async () => {
		const {context, counts, errors, page} = await device(null, 'phone');

		await seedLocal(page, documentWith(CARDS, []));
		await page.goto(url('pokemon/39/ko'));

		const button = page.locator('.pc-section[data-catalog="ja"] .pc-cell[data-card="SV2D-026"] .pc-wish');

		await button.waitFor({timeout: 30000});
		assert.match(await button.getAttribute('aria-label'), /in Korean$/);
		await button.click();
		await page.waitForSelector('.pc-section[data-catalog="ja"] .pc-cell[data-card="SV2D-026"] .pc-wished', {timeout: 10000}).catch(async (err) => {
			throw new Error(`Not on the wishlist. Toast: "${await page.locator('.toast').allTextContents()}". ${err.message}`);
		});
		assert.deepEqual((await localDoc(page)).wishlist.filter((item) => !item.deleted_at).map((item) => [item.card_id, item.catalog, item.language]), [['SV2D-026', 'ja', 'ko']]);

		await page.goto(url('wishlist'));

		await page.waitForFunction(() => document.querySelectorAll('#view .wl-item:not(.wl-loading) .wl-name').length === 1, null, {timeout: 20000});
		assert.equal(await page.locator('.wl-item .wl-name').textContent(), FIXTURES.cards['ja/cards/SV2D-026'].name, 'the Japanese record\'s card');
		assert.equal(await page.locator('.wl-item .wl-chip[aria-label="Printed in Korean"]').textContent(), 'KO');
		assert.equal(await page.locator('.wl-item a.wl-art').getAttribute('href'), `${BASE}cards/ja/SV2D-026`);
		assert.ok(!counts.other.some((path) => /^ko\/cards\/SV2D-026/.test(path)), `no Korean card that shares the ID was asked for: ${counts.other.join(', ')}`);

		// Its editor offers Japanese and Korean and keeps Korean.
		await page.click('.wl-item .wl-edit');
		await page.waitForSelector('#wishlist-editor');
		assert.deepEqual(await page.locator('#wish-language option').evaluateAll((options) => options.map((option) => option.value)), ['', 'ja', 'ko']);
		assert.equal(await page.inputValue('#wish-language'), 'ko');
		assert.deepEqual(await shownErrors(page), []);
		assert.deepEqual(errors, []);
		await context.close();
	});

	// Offline, a flag whose list was never downloaded says not loaded, offers
	// Try again, and loads by itself when the connection comes back; a tap
	// on a flag whose list failed loads it again.
	test('a flag whose first load fails loads later without leaving the screen', {timeout: TEST_TIMEOUT}, async () => {
		const {context, counts, errors, net, page} = await device(null, 'phone');

		await seedLocal(page, documentWith(CARDS, []));
		await page.goto(url('pokemon/39/pt'));
		await waitForTitle(page, 'Jigglypuff, 3 of 37 cards');

		net.offline = true;
		await context.setOffline(true);
		await page.click('#pc-flag-ja');
		await page.waitForSelector('.pc-section[data-catalog="ja"] .pc-none');
		assert.equal(await page.locator('.pc-section[data-catalog="ja"] .pc-none').textContent(), 'Not on this phone yet.');
		assert.deepEqual(await flag(page, 'ja'), ['ja', 'true', '', 'Japanese, not loaded']);
		assert.match(await page.locator('#pc-status').textContent(), /Japanese prints are not on this phone yet/);
		assert.equal(await page.locator('#pc-retry').count(), 1, 'Try again');
		assert.equal(await titleText(page), 'Jigglypuff', 'no count for a list not on the phone');
		await page.screenshot({path: `${SHOTS}-offline-flag.png`});
		assert.equal(counts.asian.ja, undefined);

		net.offline = false;
		await context.setOffline(false);
		await waitForTitle(page, 'Jigglypuff, 1 of 17 cards');
		assert.deepEqual(await flag(page, 'ja'), ['ja', 'true', '17', 'Japanese, 17 cards']);
		assert.equal(await page.locator('#pc-retry').count(), 0);
		assert.equal(new URL(page.url()).pathname, `${BASE}pokemon/39/ja`);
		await page.screenshot({path: `${SHOTS}-offline-flag-back.png`});

		// Online, Korean's request fails: Try again, and a tap on its flag,
		// pressed or not, asks again.
		let fail = true;

		await context.route((target) => /\/v2\/ko\/cards$/.test(target.pathname), (route) => (fail ? route.abort('failed') : route.fallback()));
		await page.click('#pc-flag-ko');
		await page.waitForSelector('#pc-retry', {timeout: 30000});
		assert.deepEqual(await flag(page, 'ko'), ['ko', 'true', '', 'Korean, not loaded']);
		assert.match(await page.locator('#pc-status').textContent(), /Korean prints did not load/);
		fail = false;
		await page.click('#pc-flag-pt');
		await waitForTitle(page, 'Jigglypuff, 3 of 37 cards');
		await page.click('#pc-flag-ko');
		await page.waitForFunction(() => /no cards of Jigglypuff/.test((document.querySelector('.pc-section[data-catalog="ko"] .pc-none') || {}).textContent || ''));
		assert.deepEqual(await flag(page, 'ko'), ['ko', 'true', '17', 'Korean, 17 cards'], 'the Japanese prints its copies sit on');
		assert.equal(await page.locator('#pc-retry').count(), 0);
		assert.deepEqual(await shownErrors(page), []);
		assert.deepEqual(errors, []);
		await context.close();
	});

	// The status line speaks for the flag pressed: the international list
	// downloading, or the finishes being read under Portuguese, are not
	// Japanese's or Korean's.
	test('the status line shows only the pressed flag\'s progress', {timeout: TEST_TIMEOUT}, async () => {
		const {context, errors, page} = await device(null, 'phone');
		const gates = {};
		const gate = (name) => {
			let open;

			gates[name] = {held: new Promise((resolve) => {
				open = resolve;
			})};
			gates[name].open = open;
		};

		gate('bulk');
		gate('records');
		gate('ko');
		await context.route('https://api.tcgdex.net/v2/graphql', async (route) => {
			if (JSON.parse(route.request().postData() || '{}').query === '{ cards { id dexId } }') {
				await gates.bulk.held;
			}

			await route.fallback();
		});
		await context.route((target) => /\/v2\/en\/cards\/./.test(target.pathname), async (route) => {
			await gates.records.held;
			await route.fallback();
		});
		await context.route((target) => /\/v2\/ko\/cards$/.test(target.pathname), async (route) => {
			await gates.ko.held;
			await route.fallback();
		});
		await seedLocal(page, documentWith(CARDS, []));
		await page.goto(url('pokemon/39/pt'));
		await page.waitForFunction(() => /Downloading the card list/.test(document.getElementById('pc-status').textContent));
		assert.equal((await flag(page, 'pt'))[3], 'Portuguese, loading');

		await page.click('#pc-flag-ja');
		await waitForTitle(page, 'Jigglypuff, 1 of 17 cards');
		await page.waitForTimeout(200);
		assert.doesNotMatch(await page.locator('#pc-status').textContent(), /Downloading/, 'the international download is not Japanese\'s');

		gates.bulk.open();
		await page.click('#pc-flag-pt');
		await waitForTitle(page, 'Jigglypuff, 3 of 37 cards');

		await page.click('label[for="pc-finishes"]');
		await page.waitForFunction(() => /Reading finishes: 0 of 37 cards/.test(document.getElementById('pc-status').textContent));
		await page.click('#pc-flag-ko');
		await page.waitForSelector('.pc-section[data-catalog="ko"]');
		await page.waitForTimeout(200);
		assert.doesNotMatch(await page.locator('#pc-status').textContent(), /of 37 cards/, 'Portuguese\'s finishes are not Korean\'s');
		gates.ko.open();
		await page.waitForSelector('.pc-section[data-catalog="ko"] .pc-none');
		assert.doesNotMatch(await page.locator('#pc-status').textContent(), /of 37 cards/);
		gates.records.open();
		await page.click('label[for="pc-finishes"]');
		assert.deepEqual(await shownErrors(page), []);
		assert.deepEqual(errors, []);
		await context.close();
	});

	// A Pokémon with no international prints: the empty line names the flag's
	// language, not English.
	test('the empty line names the pressed flag\'s language', {timeout: TEST_TIMEOUT}, async () => {
		const {context, errors, page} = await device(null, 'phone');
		const others = FIXTURES.bulk.filter((card) => !(card.dexId || []).includes(39));

		await context.route('https://api.tcgdex.net/v2/graphql', (route) => (JSON.parse(route.request().postData() || '{}').query === '{ cards { id dexId } }'
			? route.fulfill({body: JSON.stringify({data: {cards: others}}), contentType: 'application/json', status: 200})
			: route.fallback()));
		await seedLocal(page, documentWith([], []));

		for (const [code, name] of [['de', 'German'], ['pt', 'Portuguese']]) {
			await page.goto(url(`pokemon/39/${code}`));
			await page.waitForSelector('.pc-section[data-catalog="international"] .pc-none');
			assert.equal(await page.locator('.pc-none').textContent(), `The ${name} catalog has no cards of Jigglypuff yet.`);
		}

		assert.deepEqual(await shownErrors(page), []);
		assert.deepEqual(errors, []);
		await context.close();
	});

	// The flags draw before the person's cards are read: a flag tapped in
	// that moment shows pressed at once.
	test('a flag tapped before the cards are read shows pressed', {timeout: TEST_TIMEOUT}, async () => {
		const {context, errors, page} = await device(null, 'phone');

		await seedLocal(page, documentWith(CARDS, []));
		// The collection's listCards waits for the test.
		await context.route(`${harness.origin}${BASE}js/collection.js`, async (route) => {
			const response = await route.fetch();
			const body = (await response.text()).replace('export async function listCards() {', 'export async function listCards() {\n\tawait (globalThis.holdCards || null);');

			await route.fulfill({body, contentType: 'text/javascript', response});
		});
		await page.addInitScript(() => {
			globalThis.holdCards = new Promise((resolve) => {
				globalThis.releaseCards = resolve;
			});
		});
		await page.goto(url('pokemon/39/pt'));
		await page.waitForSelector('#pc-flag-ja');
		await page.click('#pc-flag-ja');
		assert.deepEqual((await flagStates(page)).filter(([, pressed]) => pressed === 'true').map(([lang]) => lang), ['ja']);
		await page.evaluate(() => globalThis.releaseCards());
		await waitForTitle(page, 'Jigglypuff, 1 of 17 cards');
		assert.deepEqual(await shownErrors(page), []);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a TAG TEAM card links each Pokémon, and a Trainer has no Pokémon row', {timeout: TEST_TIMEOUT}, async () => {
		const {context, errors, page} = await device(null, 'phone');

		await seedLocal(page, documentWith([], []));
		await page.goto(url('cards/en/sm12-165'));
		await page.waitForSelector('#card-pokemon-428');
		await page.waitForFunction(() => document.getElementById('card-pokemon-428').textContent === 'Every Lopunny card');
		assert.deepEqual(await page.locator('.card-hero a[id^="card-pokemon-"]').allTextContents(), ['Every Jigglypuff card', 'Every Lopunny card']);
		assert.equal(await page.locator('#card-pokemon-428').getAttribute('href'), `${BASE}pokemon/428/en`);
		await page.screenshot({path: `${SHOTS}-card-tag-team.png`});

		// Each link owns its 48 px band: a tap just inside its top or bottom
		// edge opens it, not the other Pokémon (a tap low on Jigglypuff
		// opened Lopunny when the second link's padding covered the first).
		await page.locator('#card-pokemon-39').evaluate((anchor) => anchor.scrollIntoView({block: 'center'}));

		const bands = await page.locator('.card-hero a[id^="card-pokemon-"]').evaluateAll((anchors) => anchors.map((anchor) => {
			const box = anchor.getBoundingClientRect();
			const x = box.left + Math.min(box.width / 2, 24);
			const hit = (y) => (document.elementFromPoint(x, y)?.closest('a') || {}).id || null;

			return {bottom: hit(box.bottom - 2), height: box.height, id: anchor.id, top: hit(box.top + 2)};
		}));

		for (const band of bands) {
			assert.ok(band.height >= 48, `${band.id} is ${band.height} px tall`);
			assert.equal(band.top, band.id, `a tap at the top of ${band.id}`);
			assert.equal(band.bottom, band.id, `a tap at the bottom of ${band.id}`);
		}

		await page.goto(url('cards/en/sv03.5-196'));
		await page.waitForSelector('.facts');
		await page.waitForSelector('#card-set-link');
		assert.deepEqual(await page.locator('.facts dt').allTextContents(), ['Set', 'Number', 'Rarity', 'Illustrator', 'Catalog']);
		assert.equal(await page.locator('.card-hero a[id^="card-pokemon-"]').count(), 0);
		assert.deepEqual(await shownErrors(page), []);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('the names arriving rename the link and leave the page as drawn', {timeout: TEST_TIMEOUT}, async () => {
		const {context, counts, errors, page} = await device(null, 'phone');
		let release;
		const held = new Promise((resolve) => {
			release = resolve;
		});

		// Routes run newest first: the species names wait for release().
		await context.route('https://graphql.pokeapi.co/**', async (route) => {
			await held;
			await route.fulfill({body: speciesBody(), contentType: 'application/json', status: 200});
		});
		await seedLocal(page, documentWith(CARDS, []));
		await page.goto(url('cards/en/sv03.5-039'));
		await page.waitForSelector('#card-set-link');
		await page.waitForSelector('.card-detail h2');

		// Worded as the Pokémon screen's title words it until the names come.
		assert.equal(await page.locator('#card-pokemon-39').textContent(), 'Every Pokémon #039 card');
		await page.waitForTimeout(500);
		await page.evaluate(() => {
			window.drawnHero = document.querySelector('.card-detail .card-hero');
			window.drawnLink = document.getElementById('card-pokemon-39');
		});

		const cardsRead = counts.cards;

		release();
		await page.waitForFunction(() => document.getElementById('card-pokemon-39').textContent === 'Every Jigglypuff card');
		await page.waitForTimeout(500);
		assert.deepEqual(await page.evaluate(() => [window.drawnHero.isConnected, window.drawnLink === document.getElementById('card-pokemon-39')]), [true, true], 'the page was not drawn again');
		assert.equal(counts.cards, cardsRead, 'no card read again');
		assert.deepEqual(await shownErrors(page), []);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('with no species names, the link names the Pokémon as the screen does', {timeout: TEST_TIMEOUT}, async () => {
		const {context, errors, page} = await device(null, 'phone');

		// PokeAPI never answers (pokeapi.co is already refused).
		await context.route('https://graphql.pokeapi.co/**', (route) => route.abort('internetdisconnected'));
		await seedLocal(page, documentWith(CARDS, []));
		await page.goto(url('cards/en/sv03.5-039'));
		await page.waitForSelector('#card-pokemon-39');
		assert.equal(await page.locator('#card-pokemon-39').textContent(), 'Every Pokémon #039 card');
		await page.click('#card-pokemon-39');
		await waitForTitle(page, 'Pokémon #039, 2 of 37 cards');
		await page.goBack();
		await page.waitForURL(`**${BASE}cards/en/sv03.5-039`);
		await page.waitForSelector('#card-pokemon-39');
		assert.equal(await page.locator('#card-pokemon-39').textContent(), 'Every Pokémon #039 card');
		assert.deepEqual(await shownErrors(page), []);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('Back to a card page brings back the list it was opened from', {timeout: TEST_TIMEOUT}, async () => {
		const {context, errors, page} = await device(null, 'phone');
		const context151 = async () => {
			await page.waitForSelector('#card-position');
			assert.equal(await page.locator('#view .back').textContent(), '‹ 151');
			assert.equal(await page.locator('#card-position').textContent(), '1 of 1');
		};

		await seedLocal(page, documentWith(CARDS, []));

		// Set 151, then its Jigglypuff: the set is the context.
		await page.goto(url('sets/en/sv03.5'));
		await page.waitForSelector('#view .card-grid a.tile');
		await page.click('#view .card-grid a.tile[data-link="cards/en/sv03.5-039"]');
		await page.waitForURL(`**${BASE}cards/en/sv03.5-039`);
		await context151();

		// Every Jigglypuff card, and another card from that grid: its context.
		await page.click('#card-pokemon-39');
		await page.waitForURL(`**${BASE}pokemon/39/en`);
		await waitForTitle(page, 'Jigglypuff, 2 of 37 cards');
		await page.click('.pc-cell[data-card="me02-076"] a.tile');
		await page.waitForURL(`**${BASE}cards/en/me02-076`);
		await page.waitForSelector('#card-position');
		assert.equal(await page.locator('#view .back').textContent(), '‹ Jigglypuff');

		// Back twice: the 151 card again, with the set as its context.
		await page.goBack();
		await page.waitForURL(`**${BASE}pokemon/39/en`);
		await waitForTitle(page, 'Jigglypuff, 2 of 37 cards');
		await page.goBack();
		await page.waitForURL(`**${BASE}cards/en/sv03.5-039`);
		await context151();

		// Forward twice: the other card keeps the Jigglypuff grid; back again,
		// and through a reload, the 151 card keeps the set.
		await page.goForward();
		await page.waitForURL(`**${BASE}pokemon/39/en`);
		await page.goForward();
		await page.waitForURL(`**${BASE}cards/en/me02-076`);
		await page.waitForSelector('#card-position');
		assert.equal(await page.locator('#view .back').textContent(), '‹ Jigglypuff');
		await page.goBack();
		await page.waitForURL(`**${BASE}pokemon/39/en`);
		await page.goBack();
		await page.waitForURL(`**${BASE}cards/en/sv03.5-039`);
		await context151();
		await page.reload();
		await context151();
		assert.deepEqual(await shownErrors(page), []);
		assert.deepEqual(errors, []);
		await context.close();
	});
});

// A Pokémon goal (Eric, 2026-11-09: every card of one Pokémon as a list, to
// turn into a binder later; js/goals.js, js/pokemon-cards-view.js
// goalControl): made from the screen without a list in the languages
// picked, shown in Lists like a set or artist goal, one tap to the
// wishlist, and a binder from it with a pocket per print.
describe('a Pokémon goal from the Pokémon screen', () => {
	const checkedLanguages = (page) => page.locator('#pc-goal-languages input:checked').evaluateAll((boxes) => boxes.map((box) => box.value));

	// Opens a binder page in the zoom sheet (tests/binder-rules.test.mjs).
	async function openBinderPage(page, pg) {
		await page.click(`.bs-open[data-open="${pg}"]`);
		await page.waitForFunction((wanted) => document.getElementById('binder-spread')?.dataset.zoom === wanted, String(pg), {timeout: 10000});
	}

	// Removes one cached answer from the phone's IndexedDB, as if it had
	// never been read: dex:ja:39 in the Pokémon screen's cache, or a set's
	// details in the catalog's.
	const forget = (page, name, store, key) => page.evaluate(({name: db, store: box, key: id}) => new Promise((resolve, reject) => {
		const open = indexedDB.open(db);

		open.onsuccess = () => {
			const tx = open.result.transaction(box, 'readwrite');

			tx.objectStore(box).delete(id);
			tx.oncomplete = () => {
				open.result.close();
				resolve();
			};
			tx.onerror = () => reject(tx.error);
		};
		open.onerror = () => reject(open.error);
	}), {key, name, store});

	// Moves in the app, as a tapped link does, with no page load (offline,
	// the page could not load).
	const goInApp = (page, route) => page.evaluate(async (target) => (await import('/pokemon-card-tracker/js/dom.js')).go(target), route);

	const binderOf = async (page, id) => (await localDoc(page)).binders.find((item) => item.id === id);

	const noteText = (page) => page.locator('#binder-list-note').textContent();
	// Plus a copy with no language recorded, which counts as on the flags.
	const OWNED = [...CARDS, entry('c8', {card_id: 'xy1-87', catalog: 'international', language: null})];

	test('Make this a goal with two languages, the goal in Lists, the wishlist, and a binder from it', {timeout: TEST_TIMEOUT}, async () => {
		const {context, counts, errors, page} = await device(null, 'phone');

		await seedLocal(page, documentWith(OWNED, []));
		await page.goto(url('pokemon/39/pt'));
		await waitForTitle(page, 'Jigglypuff, 4 of 37 cards');
		assert.equal(await page.locator('#pc-make-goal').textContent(), 'Make this a goal');

		// The sheet: the flag shown ticked; Japanese added.
		await page.click('#pc-make-goal');
		await page.waitForSelector('#pc-goal-sheet[open]');
		assert.equal(await page.locator('#pc-goal-sheet-title').textContent(), 'Make Jigglypuff a goal');
		assert.deepEqual(await checkedLanguages(page), ['pt']);
		await page.check('#pc-goal-languages input[value="ja"]');
		assert.deepEqual(await checkedLanguages(page), ['pt', 'ja']);
		assert.deepEqual(counts.asian, {}, 'nothing Japanese loaded before the goal is made');
		await page.click('#pc-goal-create');
		await page.waitForSelector('#pc-goal-sheet', {state: 'detached'});

		// Made, offered to open, and the control is now its link.
		await page.waitForSelector('#pc-goal-link');
		assert.equal(await page.locator('#pc-goal-link').textContent(), 'Your goal: Every card in PT, JA');
		assert.equal(await page.locator('#toasts .toast-text').last().textContent(), 'Jigglypuff is a goal in Lists.');

		let doc = await localDoc(page);
		const goal = doc.goals.find((item) => item.kind === 'pokemon');

		assert.equal(doc.goals.length, 1);
		assert.deepEqual({languages: goal.languages, name: goal.name, target: goal.target}, {languages: ['pt', 'ja'], name: 'Jigglypuff', target: '39'});

		await page.click('#toasts .toast button:has-text("Open")');
		await page.waitForURL(`**${BASE}goals/${goal.id}`);

		// The goal: the 37 international prints and the 17 Japanese ones;
		// owned in Portuguese (3), Japanese (1), or with no language (1).
		await page.waitForFunction(() => /^5 of 54 cards owned, 49 missing\.$/.test((document.getElementById('goal-summary') || {}).textContent), null, {timeout: 30000}).catch(async (err) => {
			throw new Error(`${await page.locator('#goal-summary').textContent()} / ${await page.locator('#goal-status').textContent()} ${err.message}`);
		});
		assert.equal(await page.locator('#goal-title').textContent(), 'Jigglypuff');
		assert.match(await page.locator('#goal-meta').textContent(), /^Every card in PT, JA/);
		assert.equal(counts.asian.ja, 1, 'the Japanese catalog, once');
		assert.deepEqual(Object.keys(counts.asian), ['ja'], 'no other Asian catalog');
		assert.deepEqual(await page.locator('#goal-filter label span').evaluateAll((spans) => spans.map((span) => span.textContent)), ['All 54', 'Owned 5', 'Missing 49']);
		await page.click('#goal-filter input[value="missing"]');
		assert.equal(await page.locator('#goal-grid .pc-cell').count(), 49);
		assert.equal(await page.locator('#goal-grid .pc-cell[data-card="swsh3-67"]').count(), 1, 'owned only in English: missing');
		await page.click('#goal-filter input[value="owned"]');
		assert.deepEqual((await page.locator('#goal-grid .pc-cell').evaluateAll((cells) => cells.map((cell) => cell.dataset.card))).sort(), ['SV2a-039', 'base2-54', 'sm12-165', 'sv03.5-039', 'xy1-87']);
		assert.equal(await page.locator('.pc-cell[data-card="xy1-87"] .badge-lang .flag-unset').textContent(), '?');
		await page.click('#goal-filter input[value="all"]');

		// One tap puts a missing card on the wishlist, in Portuguese, the
		// goal's one Western language.
		await page.click('.pc-cell[data-card="swsh3-67"] .pc-wish');
		await page.waitForSelector('.pc-cell[data-card="swsh3-67"] .pc-wished');
		doc = await localDoc(page);
		assert.deepEqual(doc.wishlist.map((wish) => [wish.card_id, wish.catalog, wish.language]), [['swsh3-67', 'international', 'pt']]);

		// Rarity: the Japanese card lists carry none, so their prints are
		// offered as their own choice rather than hidden by every rarity.
		await page.click('#goal-filters');
		await page.waitForSelector('#goal-sheet[open]');
		assert.ok((await page.locator('#goal-f-rarity option').allTextContents()).includes('Rarity not listed (17)'));
		await page.selectOption('#goal-f-rarity', 'Rarity not listed');
		await page.click('#goal-sheet .fb-show');
		await page.waitForFunction(() => document.querySelectorAll('#goal-grid .pc-cell').length === 17, null, {timeout: 10000});
		assert.ok((await page.locator('#goal-grid .pc-cell').evaluateAll((cells) => cells.map((cell) => cell.dataset.catalog))).every((catalog) => catalog === 'ja'));
		await page.click('.fb-chip');
		await page.waitForFunction(() => document.querySelectorAll('#goal-grid .pc-cell').length === 54, null, {timeout: 10000});

		// In Lists, with the set and artist goals' tile and ring.
		await page.goto(url('lists'));
		await page.waitForSelector(`.goal-tile[data-goal="${goal.id}"] .goal-ring`, {timeout: 20000});
		assert.equal(await page.locator(`.goal-tile[data-goal="${goal.id}"] .list-name`).textContent(), 'Jigglypuff');
		assert.equal(await page.locator(`.goal-tile[data-goal="${goal.id}"] .set-meta`).textContent(), 'Every card in PT, JA');
		assert.equal(await page.locator(`.goal-tile[data-goal="${goal.id}"] .goal-ring`).getAttribute('aria-label'), '5 of 54 cards owned');

		// New binder > From a list > the goal: oldest set first, a pocket per
		// print, the five owned filled and the rest placeholders.
		await page.goto(url('binders'));
		await page.click('#new-binder');
		await page.check('#new-binder-list');
		await page.waitForSelector('#rule-section');
		await page.check('#rule-kind input[value="goal"]');
		assert.equal(await page.locator('#rule-list option:checked').textContent(), 'Jigglypuff (Every card in PT, JA)');
		assert.equal(await page.locator('#rule-order').inputValue(), 'set', 'a Pokémon goal starts on set and number, oldest first');
		await page.waitForFunction(() => /^54 pockets \(5 with a card you own\): 6 pages of 3 × 3\.$/.test((document.getElementById('rule-count') || {}).textContent), null, {timeout: 20000});
		await page.click('#binder-save');
		await page.waitForSelector('#binder-spread .bs-page');
		assert.equal(await page.locator('#binder-title').textContent(), 'Jigglypuff');

		doc = await localDoc(page);

		const binder = doc.binders[0];

		assert.deepEqual(binder.rule, {order: 'set', source: {id: goal.id, kind: 'goal'}});
		assert.equal(binder.snapshot.keys.length, 54);
		assert.equal(binder.snapshot.keys[0], 'ja|PMCG2-035', 'the oldest print first');
		assert.deepEqual(Object.keys(binder.snapshot.shown).sort(), ['international|base2-54', 'international|sm12-165', 'international|sv03.5-039', 'international|xy1-87', 'ja|SV2a-039']);

		const pocket = (key) => `#bs-spread .pocket[data-position="${(binder.snapshot.keys.indexOf(key) % 9) + 1}"]`;

		// Page 1: Jungle's Jigglypuff (owned) and a placeholder beside it.
		assert.ok(binder.snapshot.keys.indexOf('international|base2-54') < 9, 'Jungle on page 1');
		await page.waitForFunction((sel) => document.querySelector(sel)?.dataset.kind === 'card', pocket('international|base2-54'), {timeout: 15000});
		await page.waitForFunction(() => document.querySelector('#bs-spread .bs-page[data-page="1"] .pocket[data-position="1"]')?.dataset.kind === 'want', null, {timeout: 15000});

		// A placeholder's Add to wishlist wishes in the goal's language for
		// the card's catalog, as the goal's screen does: Japanese for the
		// Japanese Jungle, Portuguese for an international print.
		const westernWant = binder.snapshot.keys.slice(0, 9).find((key) => key.startsWith('international|') && !binder.snapshot.shown[key]);

		await openBinderPage(page, 1);

		for (const key of ['ja|PMCG2-035', westernWant]) {
			await page.click(`#bs-zoom-sheet .pocket[data-position="${binder.snapshot.keys.indexOf(key) + 1}"]`);
			await page.click('#list-wish');
			await page.waitForFunction(() => (document.getElementById('list-wish') || {}).textContent === 'On your wishlist', null, {timeout: 10000});
			await page.click('#sheet-close');
			await page.waitForFunction(() => !document.querySelector('#pocket-sheet[open]'));
			await page.waitForTimeout(300);
		}

		doc = await localDoc(page);
		assert.deepEqual(doc.wishlist.filter((wish) => !wish.deleted_at).map((wish) => [`${wish.catalog}|${wish.card_id}`, wish.language]).sort(), [
			[`${westernWant}`, 'pt'],
			['international|swsh3-67', 'pt'],
			['ja|PMCG2-035', 'ja'],
		].sort());

		assert.deepEqual(await shownErrors(page), []);
		assert.deepEqual(errors, []);
		await context.close();
	});

	// One goal per Pokémon: once kept, the control opens it, from any flag
	// and after a reload, and never makes a second.
	test('a Pokémon with a goal already kept opens it', {timeout: TEST_TIMEOUT}, async () => {
		const {context, errors, page} = await device(null, 'phone');
		const kept = {catalog: null, created_at: AT, deleted_at: null, id: 'goal-39', kind: 'pokemon', languages: ['en'], level: null, name: 'Puff', target: '39', updated_at: AT};

		await seedLocal(page, documentWith(OWNED, [kept]));
		await page.goto(url('pokemon/39/ja'));
		await page.waitForSelector('#pc-goal-link');
		assert.equal(await page.locator('#pc-make-goal').count(), 0);
		assert.equal(await page.locator('#pc-goal-link').textContent(), 'Your goal: Every card in EN');
		await page.click('#pc-flag-pt');
		assert.equal(await page.locator('#pc-goal-link').getAttribute('href'), `${BASE}goals/goal-39`);
		await page.click('#pc-goal-link');
		await page.waitForURL(`**${BASE}goals/goal-39`);
		await page.waitForFunction(() => document.getElementById('goal-title')?.textContent === 'Puff');

		// Another Pokémon has no goal.
		await page.goto(url('pokemon/35/pt'));
		await page.waitForSelector('#pc-make-goal');

		// A German flag starts the sheet on Any language: German has no
		// catalog of its own, so a list cannot name it.
		await page.goto(url('pokemon/35/de'));
		await page.click('#pc-make-goal');
		await page.waitForSelector('#pc-goal-sheet[open]');
		assert.deepEqual(await checkedLanguages(page), ['any']);
		await page.uncheck('#pc-goal-any');
		await page.click('#pc-goal-create');
		assert.equal(await page.locator('#pc-goal-error').textContent(), 'Pick at least one language, or tick Western prints, any language.');
		await page.click('#pc-goal-sheet .button-row button:has-text("Cancel")');
		await page.waitForSelector('#pc-goal-sheet', {state: 'detached'});

		assert.equal((await localDoc(page)).goals.length, 1, 'nothing made');
		assert.deepEqual(await shownErrors(page), []);
		assert.deepEqual(errors, []);
		await context.close();
	});
	// Eric, 2026-11-09: "languages I pick". Every language ticked stays
	// ticked, with its catalogs; the sheet says what Any language holds, and
	// each box is named once for a screen reader.
	test('every language ticked is kept, and the sheet names Western prints, any language for what it holds', {timeout: TEST_TIMEOUT}, async () => {
		const {context, counts, errors, page} = await device(null, 'phone');
		const all = ['pt', 'en', 'ja', 'ko', 'zh-cn', 'zh-tw', 'fr'];

		await seedLocal(page, documentWith(OWNED, []));
		await page.goto(url('pokemon/39/pt'));
		await waitForTitle(page, 'Jigglypuff, 4 of 37 cards');
		await page.click('#pc-make-goal');
		await page.waitForSelector('#pc-goal-sheet[open]');
		assert.equal(await page.locator('label:has(#pc-goal-any)').textContent(), 'Western prints, any language');
		assert.equal(await page.locator('#pc-goal-any-hint').textContent(), 'The international prints; a copy in any language counts, German, Italian, and Spanish too.');

		for (const code of all) {
			const label = await page.locator(`#pc-goal-languages input[value="${code}"]`).evaluate((box) => box.closest('label').querySelector('span:last-child').textContent);

			assert.equal(await page.getByRole('checkbox', {exact: true, name: label}).count(), 1, `${label} is named once`);
			await page.check(`#pc-goal-languages input[value="${code}"]`);
		}

		assert.deepEqual(await checkedLanguages(page), all);
		await page.click('#pc-goal-create');
		await page.waitForSelector('#pc-goal-link');
		assert.equal(await page.locator('#pc-goal-link').textContent(), 'Your goal: Every card in PT, EN, JA, KO, CHS, CHT, FR');

		const goal = (await localDoc(page)).goals[0];

		assert.deepEqual(goal.languages, all, 'saved as ticked, not as Any language');

		// Its screen reads every catalog the languages name.
		await page.goto(url(`goals/${goal.id}`));
		await page.waitForFunction(() => /^\d+ of \d+ cards owned/.test((document.getElementById('goal-summary') || {}).textContent), null, {timeout: 30000});
		assert.deepEqual(Object.keys(counts.asian).sort(), ['ja', 'ko', 'zh-cn', 'zh-tw']);
		assert.equal(await page.locator('.pc-cell[data-catalog="ja"]').count(), 17);

		// Its languages editor names Any language for what it holds too, and
		// keeps all seven when they are saved again.
		await page.click('#list-languages-edit');
		assert.equal(await page.locator('label:has(#list-languages-any)').textContent(), 'Western prints, any language');
		assert.equal(await page.getByRole('checkbox', {exact: true, name: 'Portuguese'}).count(), 1);
		await page.click('#list-languages-save');
		await page.waitForSelector('#list-languages-edit');
		assert.deepEqual((await localDoc(page)).goals[0].languages, all);
		await page.click('#list-languages-edit');
		await page.check('#list-languages-any');
		await page.click('#list-languages-save');
		await page.waitForFunction(() => /^Western prints, any language/.test(document.getElementById('goal-meta')?.textContent || ''));
		assert.equal(await page.locator('#list-languages .pc-languages-names').textContent(), 'Western prints, any language');
		assert.equal(Object.hasOwn((await localDoc(page)).goals[0], 'languages'), false);
		assert.deepEqual(await shownErrors(page), []);
		assert.deepEqual(errors, []);
		await context.close();
	});

	// The reviewer's two cases (2026-11-09): a PT and JA goal's binder opened
	// with the Japanese list not on the phone, offline, removed 17 pockets
	// and moved the rest; with one Japanese set's details unreadable, the
	// undated prints moved 53 of 54 pockets. Now the pages stay as stored
	// and nothing is saved, on opening and on Refresh, and the goal's screen
	// says which part is missing.
	test('a binder keeps its pages, and saves nothing, while part of its goal cannot be read', {timeout: TEST_TIMEOUT}, async () => {
		const {context, errors, net, page} = await device(null, 'phone');
		const goal = {catalog: null, created_at: AT, deleted_at: null, id: 'goal-39', kind: 'pokemon', languages: ['pt', 'ja'], level: null, name: 'Jigglypuff', target: '39', updated_at: AT};

		await seedLocal(page, documentWith(OWNED, [goal]));

		// Online first: the goal's lists are read and kept, and a binder made.
		await page.goto(url(`goals/${goal.id}`));
		await page.waitForFunction(() => /^5 of 54 cards owned/.test((document.getElementById('goal-summary') || {}).textContent), null, {timeout: 30000});

		const made = await page.evaluate(async (goalId) => {
			const {loadRuleItems} = await import('/pokemon-card-tracker/js/binder-sources.js');
			const {planRefresh} = await import('/pokemon-card-tracker/js/binder-rules.js');
			const {createGeneratedBinder} = await import('/pokemon-card-tracker/js/binders.js');
			const {loadDocument} = await import('/pokemon-card-tracker/js/collection.js');
			const rule = {order: 'set', source: {id: goalId, kind: 'goal'}};
			const loaded = await loadRuleItems(rule, await loadDocument());
			const plan = planRefresh({cols: 3, rows: 3, rule}, loaded.items, {at: new Date().toISOString(), keepOrder: loaded.keepOrder, rankOf: () => ({})});

			return (await createGeneratedBinder({cols: 3, name: 'Jigglypuff', rows: 3}, rule, plan.snapshot)).id;
		}, goal.id);

		await goInApp(page, `binders/${made}`);
		await page.waitForSelector('#binder-refresh:not([hidden])');
		await page.click('#binder-refresh');
		await page.waitForFunction(() => /^(Up to date\.|.*another copy by default\.)$/.test(document.getElementById('binder-list-note')?.textContent || ''), null, {timeout: 20000});

		const stored = await binderOf(page, made);

		assert.equal(stored.snapshot.keys.length, 54);
		assert.equal(stored.page_count, 6);
		assert.ok(stored.snapshot.shown['ja|SV2a-039'], 'the Japanese 151 copy is shown');

		// Offline, with the Japanese list gone from the phone.
		await forget(page, 'card-tracker-pokemon-cards', 'cache', 'dex:ja:39');
		net.offline = true;
		await context.setOffline(true);
		await goInApp(page, 'binders');
		await page.waitForSelector('#new-binder');
		await goInApp(page, `binders/${made}`);
		await page.waitForFunction(() => /^The Japanese prints are not on this phone yet\. The pages stay as they were until the whole list can be read with a connection\.$/.test(document.getElementById('binder-list-note')?.textContent || ''), null, {timeout: 20000}).catch(async (err) => {
			throw new Error(`Note: "${await noteText(page)}". ${err.message}`);
		});
		await page.waitForTimeout(500);
		assert.deepEqual(await binderOf(page, made), stored, 'nothing saved on opening');
		await page.waitForFunction(() => document.querySelectorAll('#bs-spread .pocket').length > 0);
		await page.click('#binder-refresh');
		await page.waitForTimeout(800);
		assert.match(await noteText(page), /^The Japanese prints are not on this phone yet\./);
		assert.deepEqual(await binderOf(page, made), stored, 'nor on Refresh');

		// The stored Japanese pocket still shows its copy.
		const sv2a = stored.snapshot.keys.indexOf('ja|SV2a-039');

		const sv2aPage = Math.floor(sv2a / 9) + 1;

		await goInApp(page, `binders/${made}/${sv2aPage}`);
		await page.waitForSelector(`.bs-open[data-open="${sv2aPage}"]`, {timeout: 20000});
		await openBinderPage(page, sv2aPage);
		await page.waitForFunction((position) => document.querySelector(`#bs-zoom-sheet .pocket[data-position="${position}"]`)?.dataset.kind === 'card', (sv2a % 9) + 1, {timeout: 10000});
		assert.deepEqual(await binderOf(page, made), stored, 'nor on opening a page');

		// Lists shows no ring for it: a count of the cards read would hide
		// the Japanese prints.
		await goInApp(page, 'lists');
		await page.waitForSelector(`.goal-tile[data-goal="${goal.id}"]`, {timeout: 20000});
		await page.waitForTimeout(1500);
		assert.equal(await page.locator(`.goal-tile[data-goal="${goal.id}"] .goal-ring`).count(), 0);

		// New binder > From a list refuses to lay out the part read.
		await goInApp(page, 'binders');
		await page.click('#new-binder');
		await page.check('#new-binder-list');
		await page.waitForSelector('#rule-section');
		await page.check('#rule-kind input[value="goal"]');
		await page.waitForFunction(() => /^The Japanese prints are not on this phone yet\. Open the list with a connection, then make the binder\.$/.test(document.getElementById('rule-count')?.textContent || ''), null, {timeout: 20000});
		await page.click('#binder-save');
		await page.waitForFunction(() => /^Could not save the binder\. The Japanese prints are not on this phone yet\. The binder can be laid out once the whole list is read/.test(document.getElementById('binder-form-error')?.textContent || ''), null, {timeout: 20000});
		assert.equal((await localDoc(page)).binders.length, 1, 'no binder made');

		// The goal's screen says what is missing.
		await goInApp(page, `goals/${goal.id}`);
		await page.waitForFunction(() => /The Japanese prints are not on this phone yet\./.test(document.getElementById('goal-status')?.textContent || ''), null, {timeout: 20000});
		assert.equal(await page.locator('#goal-status').textContent(), 'The Japanese prints are not on this phone yet. The count is of the cards read so far; open this goal with a connection to read the rest.');
		assert.equal(await page.locator('#goal-summary').textContent(), '4 of 37 cards owned, 33 missing.');

		// Online, with one Japanese set's details refused.
		net.offline = false;
		await context.setOffline(false);
		await forget(page, 'card-tracker-catalog', 'responses', 'set:ja:SV2a');

		const refuse = (route) => route.fulfill({body: '{}', contentType: 'application/json', status: 403});
		// One function for route and unroute, which matches it by identity.
		const sv2aDetails = (target) => /\/v2\/ja\/sets\/SV2a$/.test(target.pathname);

		await context.route(sv2aDetails, refuse);
		await goInApp(page, `binders/${made}`);
		await page.waitForFunction(() => /^1 set of Japanese prints could not be read, so their cards have no set name or date yet\. The pages stay as they were until the whole list can be read\.$/.test(document.getElementById('binder-list-note')?.textContent || ''), null, {timeout: 20000}).catch(async (err) => {
			throw new Error(`Note: "${await noteText(page)}". ${err.message}`);
		});
		await page.waitForTimeout(500);
		assert.deepEqual(await binderOf(page, made), stored, 'nothing saved with a set unread');

		await goInApp(page, `goals/${goal.id}`);
		await page.waitForSelector('#goal-retry', {timeout: 20000});
		assert.match(await page.locator('#goal-status').textContent(), /^1 set of Japanese prints could not be read, so their cards have no set name or date yet\. The count is of the cards read so far \(.+\)\. Try again$/);

		// The set readable again: the whole list, the same pockets.
		await context.unroute(sv2aDetails, refuse);
		await goInApp(page, `binders/${made}`);
		await page.waitForSelector('#binder-refresh:not([hidden])');
		await page.click('#binder-refresh');
		await page.waitForFunction(() => document.getElementById('binder-list-note')?.textContent === 'Up to date.', null, {timeout: 20000}).catch(async (err) => {
			throw new Error(`Note: "${await noteText(page)}". ${err.message}`);
		});
		assert.deepEqual((await binderOf(page, made)).snapshot.keys, stored.snapshot.keys);
		assert.deepEqual(await shownErrors(page), []);
		assert.deepEqual(errors, []);
		await context.close();
	});

	// Made offline before the species' names were ever read, the goal is
	// named by its number, and takes the name once they load.
	test('a goal made before the names are on the phone takes the name once they load', {timeout: TEST_TIMEOUT}, async () => {
		const {context, errors, net, page} = await device(null, 'phone');

		await seedLocal(page, documentWith(OWNED, []));
		net.offline = true;
		await page.goto(url('pokemon/39/pt'));
		await page.waitForSelector('#pc-make-goal');
		await page.waitForFunction(() => /^Pokémon #039/.test(document.getElementById('pc-title')?.textContent || ''));
		await page.click('#pc-make-goal');
		await page.waitForSelector('#pc-goal-sheet[open]');
		await page.click('#pc-goal-create');
		await page.waitForSelector('#pc-goal-link');
		assert.equal((await localDoc(page)).goals[0].name, 'Pokémon #039');

		net.offline = false;
		await page.reload();
		await waitForTitle(page, 'Jigglypuff, 4 of 37 cards');
		await untilInPage(page, 'the goal named Jigglypuff', async () => (await (await import('/pokemon-card-tracker/js/collection.js')).loadDocument()).goals[0].name === 'Jigglypuff', {timeout: 20000});
		assert.equal(await page.locator('#pc-goal-link').textContent(), 'Your goal: Every card in PT');
		assert.deepEqual(await shownErrors(page), []);
		assert.deepEqual(errors, []);
		await context.close();
	});

	// A goal another phone made after the control was drawn: Make goal says
	// so and opens it, and saves nothing over it. Two phones offline can
	// each make one; both show, and the control opens the first.
	test('a goal made elsewhere meanwhile is said and opened, and two goals for one Pokémon both show', {timeout: TEST_TIMEOUT}, async () => {
		const {context, errors, page} = await device(null, 'phone');

		await seedLocal(page, documentWith(OWNED, []));
		await page.goto(url('pokemon/39/pt'));
		await waitForTitle(page, 'Jigglypuff, 4 of 37 cards');
		await page.click('#pc-make-goal');
		await page.waitForSelector('#pc-goal-sheet[open]');
		await page.check('#pc-goal-languages input[value="ja"]');

		// Meanwhile, saved as another phone's sync would save it.
		const elsewhere = await page.evaluate(async () => (await import('/pokemon-card-tracker/js/goals.js')).createGoal({kind: 'pokemon', languages: ['en'], name: 'Puff', target: 39}));

		await page.click('#pc-goal-create');
		await page.waitForSelector('#pc-goal-open');
		assert.equal(await page.locator('#pc-goal-error').textContent(), 'Puff is already a goal (Every card in EN), so nothing new was made. Change its languages on its screen.');
		assert.equal(await page.locator('#toasts .toast-text:has-text("is a goal in Lists")').count(), 0, 'no toast says it was made');

		const goals = (await localDoc(page)).goals;

		assert.equal(goals.length, 1);
		assert.deepEqual(goals[0].languages, ['en'], 'its languages as they were');
		await page.click('#pc-goal-open');
		await page.waitForURL(`**${BASE}goals/${elsewhere.id}`);

		// Two goals for Jigglypuff, as two phones offline would make them.
		const second = {...elsewhere, created_at: '2026-11-09T12:00:00.000Z', id: 'goal-39-b', languages: ['ja'], name: 'Purin', updated_at: '2026-11-09T12:00:00.000Z'};

		await seedLocal(page, documentWith(OWNED, [{...elsewhere, created_at: AT}, second]));
		await page.goto(url('lists'));
		await page.waitForSelector('.goal-tile[data-goal="goal-39-b"]', {timeout: 20000});
		assert.deepEqual(await page.locator('#goals-list .list-name').allTextContents(), ['Puff', 'Purin']);
		await page.goto(url('pokemon/39/pt'));
		await page.waitForSelector('#pc-goal-link');
		assert.equal(await page.locator('#pc-goal-link').getAttribute('href'), `${BASE}goals/${elsewhere.id}`, 'the first');
		await page.goto(url('goals/goal-39-b'));
		await page.waitForFunction(() => document.getElementById('goal-title')?.textContent === 'Purin');
		assert.deepEqual(await shownErrors(page), []);
		assert.deepEqual(errors, []);
		await context.close();
	});
});
