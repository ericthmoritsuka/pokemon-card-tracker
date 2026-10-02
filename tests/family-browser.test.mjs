// Browser tests for the family view and the account (plans/audit.md block
// F): the "Whose cards" sheet with each person's favorite Pokémon and the
// Back button, a family member's Sets rings and card page, and a session
// the server stops accepting. Headless Chromium at 390 x 844 against
// tests/pages-server.mjs. Supabase, TCGdex, and the sprites are faked; no
// request leaves the machine.
//
// Screenshots: /tmp/family-*.png.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/family-browser.test.mjs

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {FakeSupabase} from './fake-supabase.mjs';
import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const VIEWPORT = {height: 844, width: 390};
const AT = '2026-09-01T00:00:00.000Z';

// A 1 x 1 PNG for sprites.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

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

// ----------------------------------------------------------- test data

const entry = (id, fields) => ({catalog: 'international', created_at: AT, deleted_at: null, id, language: 'en', language_source: 'manual', updated_at: AT, ...fields});

function documentWith(cards, extra = {}) {
	return {binders: [], cards, collections: [], goals: [], openings: [], person: 'local', updated_at: AT, user_id: null, version: 1, wishlist: [], ...extra};
}

const cardName = (id) => `Test card ${id}`;

// Three sets of 60 cards. Sprites answer from `sprites` (dex -> true), or
// 404 for any other number, so a test can make one fail.
async function fakeNetwork(context, {sprites = null} = {}) {
	await context.route('https://api.tcgdex.net/**', (route) => {
		const {pathname} = new URL(route.request().url());
		const list = /\/v2\/(\w+)\/sets$/.exec(pathname);
		const set = /\/v2\/(\w+)\/sets\/(tst\d+)$/.exec(pathname);
		const card = /\/v2\/(\w+)\/cards\/((tst\d+)-(\d+))$/.exec(pathname);
		const setBrief = (setId) => ({cardCount: {official: 60, total: 60}, id: setId, logo: null, name: `Test set ${setId}`, releaseDate: '2026-01-01', serie: {id: 'tst', name: 'Test series'}});

		if (list) {
			return route.fulfill({body: JSON.stringify(['tst1', 'tst2', 'tst3'].map(setBrief)), contentType: 'application/json', status: 200});
		}

		if (set) {
			return route.fulfill({
				body: JSON.stringify({
					...setBrief(set[2]),
					cards: Array.from({length: 60}, (_, i) => {
						const localId = String(i + 1).padStart(3, '0');

						return {id: `${set[2]}-${localId}`, image: null, localId, name: cardName(`${set[2]}-${localId}`)};
					}),
				}),
				contentType: 'application/json',
				status: 200,
			});
		}

		if (card) {
			return route.fulfill({
				body: JSON.stringify({
					id: card[2],
					illustrator: 'Test Artist',
					image: null,
					localId: card[4],
					name: cardName(card[2]),
					rarity: 'Common',
					set: {cardCount: {official: 60, total: 60}, id: card[3], name: `Test set ${card[3]}`},
					variants_detailed: [],
				}),
				contentType: 'application/json',
				status: 200,
			});
		}

		return route.fulfill({body: '[]', contentType: 'application/json', status: 200});
	});
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));
	await context.route('https://raw.githubusercontent.com/**', (route) => {
		const dex = /\/pokemon\/(\d+)\.png$/.exec(route.request().url());

		if (sprites && !(dex && sprites[dex[1]])) {
			return route.fulfill({status: 404});
		}

		return route.fulfill({body: PNG, contentType: 'image/png', status: 200});
	});
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => {
		throw new Error(`Unexpected Google Fonts request: ${route.request().url()}`);
	});
	await context.route(/ligapokemon\.com\.br/, (route) => {
		throw new Error(`Unexpected Liga request: ${route.request().url()}`);
	});
}

async function device(fake, name, options = {}) {
	const context = await browser.newContext({hasTouch: true, serviceWorkers: 'block', viewport: VIEWPORT});

	await fakePokeApi(context);
	await fakeNetwork(context, options);
	await fake.attach(context, name);

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err));

	return {context, errors, page};
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

async function signIn(page, fake, email) {
	await page.goto(url('signin'));
	await page.fill('#signin-email', email);
	await page.click('button:has-text("Send link")');
	await page.waitForSelector('#check-email');

	const code = fake.issueCode(email);

	await page.goto(`${url()}?code=${code}`);
	await page.waitForSelector('#account.avatar');
}

async function waitForSynced(page) {
	await page.waitForFunction(() => {
		const line = document.getElementById('sync-status');

		return line && !line.hidden && line.textContent === 'Synced';
	}, null, {timeout: 15000});
}

const shownErrors = (page) => page.locator('#errors .error').allTextContents();

const path = (page) => new URL(page.url()).pathname;

// The owner signs in first, which makes the family group; Member A joins
// it with a document of their own already on the server.
function family(fake, {memberCards = [], memberFavorite = null} = {}) {
	const owner = fake.addUser('owner@example.test');
	const member = fake.addUser('member-a@example.test');

	fake.documents.set(member.id, {
		doc: documentWith(memberCards, {
			person: undefined,
			settings: memberFavorite ? {favorite_pokemon: memberFavorite, updated_at: AT} : undefined,
			user_id: undefined,
		}),
		updated_at: fake.now(),
		user_id: member.id,
	});
	fake.profiles.set(member.id, {display_name: 'Member A', user_id: member.id});

	return {
		join() {
			fake.members.push({group_id: fake.groups[0].id, role: 'member', user_id: member.id});
		},
		member,
		owner,
	};
}

// ----------------------------------------------------------------- tests

describe('the "Whose cards" sheet', () => {
	test('Back closes the sheet and stays on the screen; picking Member A opens their cards, and one Back returns', async () => {
		const fake = new FakeSupabase();
		const people = family(fake, {memberCards: [entry('m-1', {card_id: 'tst2-001'})]});
		const {context, errors, page} = await device(fake, 'owner');

		await seedLocal(page, documentWith([entry('o-1', {card_id: 'tst1-001'})]));
		await signIn(page, fake, people.owner.email);
		await waitForSynced(page);
		people.join();
		await page.goto(url('cards'));
		await page.waitForSelector('#owner-switch:not([hidden])');

		// A marker on the screen shows whether Back drew it again.
		const mark = () => page.evaluate(() => {
			document.getElementById('view').dataset.mark = 'kept';
		});
		const marked = () => page.evaluate(() => document.getElementById('view').dataset.mark || null);
		const length = () => page.evaluate(() => history.length);

		await mark();

		const before = await length();

		await page.click('#owner-switch');
		await page.waitForSelector('#owner-sheet[open]');
		await page.goBack({waitUntil: 'commit'}).catch(() => {});
		await page.waitForSelector('#owner-sheet', {state: 'hidden'});
		await page.waitForTimeout(300);
		assert.equal(path(page), `${BASE}cards`, 'Back stayed on My Cards');
		assert.equal(await marked(), 'kept', 'the screen under the sheet was not drawn again');
		assert.equal(await page.evaluate(async () => (await import('/pokemon-card-tracker/js/sheet.js')).openSheetCount()), 0);

		// Close by its own button: the next Back leaves the screen as usual,
		// so nothing of the sheet stays in the history.
		await page.click('#owner-switch');
		await page.waitForSelector('#owner-sheet[open]');
		await page.click('#owner-sheet-close');
		await page.waitForSelector('#owner-sheet', {state: 'hidden'});
		await page.waitForTimeout(300);
		assert.equal(await length(), before + 1, 'the sheet\'s entry stays only as the forward step');

		// Pick Member A: their cards open, view only.
		await page.click('#owner-switch');
		await page.waitForSelector('#owner-sheet[open]');
		await page.click(`#owner-sheet .owner-option[data-member="${people.member.id}"]`);
		await page.waitForSelector('#family-strip');
		await page.waitForSelector('#owner-sheet', {state: 'hidden'});
		await page.waitForTimeout(400);
		assert.equal(path(page), `${BASE}family/${people.member.id}`);
		assert.match(await page.locator('#family-strip').textContent(), /^Member A's cards, view only/);
		assert.equal(await page.evaluate(async () => (await import('/pokemon-card-tracker/js/sheet.js')).openSheetCount()), 0);

		// One Back returns to My Cards, with the lens off.
		await page.goBack({waitUntil: 'commit'}).catch(() => {});
		await page.waitForFunction(() => window.location.pathname.endsWith('/cards'));
		await page.waitForTimeout(300);
		assert.equal(await page.locator('#family-strip').count(), 0);
		assert.equal(await page.locator('#owner-switch').textContent(), 'Mine');
		assert.equal(await page.locator('#owner-sheet[open]').count(), 0);

		// Mine from the member's view goes back to your own cards in one tap,
		// and Back from there returns to the member's view.
		await page.goForward({waitUntil: 'commit'}).catch(() => {});
		await page.waitForSelector('#family-strip');
		await page.click('#owner-switch');
		await page.waitForSelector('#owner-sheet[open]');
		await page.click('#owner-sheet .owner-option[data-member=""]');
		await page.waitForFunction(() => window.location.pathname.endsWith('/cards'));
		await page.waitForSelector('#owner-sheet', {state: 'hidden'});
		await page.waitForTimeout(300);
		assert.equal(await page.locator('#family-strip').count(), 0);
		await page.goBack({waitUntil: 'commit'}).catch(() => {});
		await page.waitForSelector('#family-strip');
		assert.equal(path(page), `${BASE}family/${people.member.id}`);

		assert.deepEqual(await shownErrors(page), []);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('each person shows their favorite Pokémon, read from one field of the member\'s document, with the letter as the fallback', async () => {
		const fake = new FakeSupabase();
		const people = family(fake, {memberCards: [entry('m-1', {card_id: 'tst2-001'})], memberFavorite: 133});
		const {context, errors, page} = await device(fake, 'owner');

		await signIn(page, fake, people.owner.email);
		await waitForSynced(page);
		await page.evaluate(async () => (await import('/pokemon-card-tracker/js/settings.js')).setFavoritePokemon(25));
		people.join();

		const logStart = fake.log.length;

		await page.goto(url('cards'));
		await page.waitForSelector('#owner-switch:not([hidden])');
		// The header chip carries your sprite beside "Mine".
		await page.waitForSelector('#owner-switch img.owner-switch-sprite[data-dex="25"]');
		assert.equal(await page.locator('#owner-switch').textContent(), 'Mine');

		await page.click('#owner-switch');
		await page.waitForSelector('#owner-sheet[open]');
		await page.waitForSelector(`#owner-sheet .owner-option[data-member="${people.member.id}"] img.owner-sprite`);

		const marks = await page.locator('#owner-sheet .owner-option').evaluateAll((buttons) => buttons.map((button) => {
			const img = button.querySelector('img');

			return img ? img.getAttribute('src').split('/').pop() : button.querySelector('.owner-initial').textContent;
		}));

		assert.deepEqual(marks, ['25.png', '133.png']);
		await page.screenshot({path: '/tmp/family-owner-sheet.png'});

		// Only the favorite was read for the switcher: one request selecting
		// that field and the row's owner, nothing else of the document.
		const reads = fake.log.slice(logStart).filter((item) => item.path === '/rest/v1/documents' && item.method === 'GET');
		const favoriteReads = reads.filter((item) => decodeURIComponent(item.search).includes('favorite_pokemon'));

		assert.equal(favoriteReads.length, 1, 'one read of the favorites');

		const query = new URLSearchParams(favoriteReads[0].search);

		assert.equal(query.get('select'), 'user_id,favorite:doc->settings->favorite_pokemon');
		assert.equal(query.get('user_id'), `in.(${people.member.id})`);

		// Picking them puts their sprite on the chip.
		await page.click(`#owner-sheet .owner-option[data-member="${people.member.id}"]`);
		await page.waitForSelector('#owner-switch img.owner-switch-sprite[data-dex="133"]');
		assert.equal(await page.locator('#owner-switch').textContent(), 'Member A\'s');
		await page.screenshot({clip: {height: 120, width: VIEWPORT.width, x: 0, y: 0}, path: '/tmp/family-chip.png'});

		// Kept on the phone: a reload draws them before any read, and opening
		// the sheet again this visit asks nothing.
		const again = fake.log.length;

		await page.click('#owner-switch');
		await page.waitForSelector('#owner-sheet[open]');
		await page.waitForTimeout(300);
		assert.equal(fake.log.slice(again).filter((item) => decodeURIComponent(item.search).includes('favorite_pokemon')).length, 0, 'read once a visit');
		assert.equal(await page.evaluate((id) => JSON.parse(localStorage.getItem('card-tracker-member-favorites'))[id], people.member.id), 133);

		assert.deepEqual(errors, []);
		await context.close();
	});

	test('no favorite, or a sprite that does not load, shows the first letter', async () => {
		const fake = new FakeSupabase();
		const people = family(fake, {memberFavorite: 150});
		// Only Pikachu's sprite loads: Member A's 150 fails, as offline.
		const {context, errors, page} = await device(fake, 'owner', {sprites: {25: true}});

		await signIn(page, fake, people.owner.email);
		await waitForSynced(page);
		people.join();
		await page.goto(url('cards'));
		await page.waitForSelector('#owner-switch:not([hidden])');
		await page.click('#owner-switch');
		await page.waitForSelector('#owner-sheet[open]');
		await page.waitForFunction((id) => {
			const option = document.querySelector(`#owner-sheet .owner-option[data-member="${id}"] .owner-initial`);

			return option && option.textContent === 'M' && !option.querySelector('img');
		}, people.member.id);
		assert.equal(await page.locator('#owner-sheet .owner-option[data-member=""] .owner-initial').textContent(), 'O', 'you have no favorite: your initial');
		assert.deepEqual(errors, []);
		await context.close();
	});
});
