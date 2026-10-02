// Browser tests for the app shell (plans/design-review.md block 1, and the
// card tile and design token foundations): the five tabs with Scan raised,
// the avatar that opens Profile, family view-only mode, the offline strip,
// swiping between cards in the list they were opened from, the shared
// tile's badge corners, and Poppins loading offline from the app itself.
// Headless Chromium at 360 x 740 against tests/pages-server.mjs. Supabase
// and TCGdex are faked; no request leaves the machine except none at all.
//
// Screenshots, light and dark: /tmp/shell-*.png.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/shell.test.mjs

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

const SETS = ['tst1', 'tst2', 'tst3'];

function syntheticEntries(count, prefix = 'e') {
	const start = Date.parse(AT);

	return Array.from({length: count}, (_, i) => {
		const set = SETS[i % SETS.length];
		const number = String(Math.floor(i / SETS.length) + 1).padStart(3, '0');
		const at = new Date(start + i).toISOString();

		return {
			card_id: `${set}-${number}`,
			catalog: 'international',
			created_at: at,
			deleted_at: null,
			id: `${prefix}-${String(i).padStart(5, '0')}`,
			language: 'en',
			language_source: 'manual',
			updated_at: at,
		};
	});
}

const entry = (id, fields) => ({catalog: 'international', created_at: AT, deleted_at: null, id, language: 'en', language_source: 'import', updated_at: AT, ...fields});

function documentWith(cards) {
	return {binders: [], cards, collections: [], goals: [], openings: [], person: 'local', updated_at: AT, user_id: null, version: 1, wishlist: []};
}

const cardName = (id) => `Test card ${id}`;

async function fakeTcgdex(context, net) {
	await context.route('https://api.tcgdex.net/**', (route) => {
		if (net.offline) {
			return route.abort('internetdisconnected');
		}

		const {pathname} = new URL(route.request().url());
		const set = /\/v2\/(\w+)\/sets\/(tst\d+)$/.exec(pathname);
		const card = /\/v2\/(\w+)\/cards\/((tst\d+)-(\d+))$/.exec(pathname);
		const setBody = (setId) => ({
			cardCount: {official: 60, total: 60},
			cards: Array.from({length: 60}, (_, i) => {
				const localId = String(i + 1).padStart(3, '0');

				return {id: `${setId}-${localId}`, image: null, localId, name: cardName(`${setId}-${localId}`)};
			}),
			id: setId,
			name: `Test set ${setId}`,
			releaseDate: '2026-01-01',
			serie: {id: 'tst', name: 'Test series'},
		});

		if (set) {
			return route.fulfill({body: JSON.stringify(setBody(set[2])), contentType: 'application/json', status: 200});
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
	await context.route('https://raw.githubusercontent.com/**', (route) => route.fulfill({body: PNG, contentType: 'image/png', status: 200}));
}

async function device(fake, name, {colorScheme = 'light', reducedMotion = 'no-preference', serviceWorkers = 'block', viewport = VIEWPORT} = {}) {
	const context = await browser.newContext({colorScheme, hasTouch: true, reducedMotion, serviceWorkers, viewport});
	const net = {offline: false};

	// Offline for the page and for the faked catalog alike.
	const setOffline = async (offline) => {
		net.offline = offline;
		await context.setOffline(offline);
	};

	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => {
		throw new Error(`Unexpected Google Fonts request: ${route.request().url()}`);
	});
	await fakePokeApi(context);
	await fakeTcgdex(context, net);

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

	return {context, errors, net, page, setOffline};
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

// A horizontal swipe, as touch events on the element under (x, y).
async function swipe(page, selector, dx) {
	await page.evaluate(({dx, selector}) => {
		const target = document.querySelector(selector);
		const box = target.getBoundingClientRect();
		const x = box.left + box.width / 2;
		const y = box.top + Math.min(box.height / 2, 80);
		const touch = (clientX) => new Touch({clientX, clientY: y, identifier: 1, target});

		target.dispatchEvent(new TouchEvent('touchstart', {bubbles: true, changedTouches: [touch(x)], touches: [touch(x)]}));
		target.dispatchEvent(new TouchEvent('touchend', {bubbles: true, changedTouches: [touch(x + dx)], touches: []}));
	}, {dx, selector});
}

// ----------------------------------------------------------------- tests

describe('the tabs', () => {
	test('five tabs, Scan raised in the center, labels on one line at 360 and 412 px, and no Menu or Phone check tab', async () => {
		for (const width of [360, 412]) {
			const {context, errors, page} = await device(null, 'phone', {viewport: {height: 740, width}});

			await page.goto(url('cards'));
			await page.waitForSelector('main h2');

			assert.deepEqual(await page.locator('.tabs a').evaluateAll((tabs) => tabs.map((tab) => [tab.dataset.tab, tab.textContent.trim()])), [
				['cards', 'Cards'],
				['sets', 'Sets'],
				['scan', 'Scan'],
				['binders', 'Binders'],
				['lists', 'Lists'],
			]);
			assert.equal(await page.locator('#menu, details.menu, .tabs a[data-tab="check"]').count(), 0, 'no Menu and no Phone check tab');

			// Every label on one line, never clipped.
			const labels = await page.locator('.tab-label').evaluateAll((spans) => spans.map((span) => ({
				clipped: span.scrollWidth > span.clientWidth + 1,
				height: span.getBoundingClientRect().height,
				text: span.textContent,
			})));

			for (const label of labels) {
				assert.ok(label.height <= 18, `${label.text} sits on one line at ${width} px (${label.height} px tall)`);
				assert.ok(!label.clipped, `${label.text} is not clipped at ${width} px`);
			}

			// Scan is the largest target and rises above the bar.
			const bar = await page.locator('.tabs').boundingBox();
			const disc = await page.locator('.tab-scan .scan-disc').boundingBox();
			const cards = await page.locator('.tabs a[data-tab="cards"]').boundingBox();

			assert.ok(disc.y < bar.y, 'the Scan disc rises above the tab bar');
			assert.ok(disc.width >= 64 && disc.height >= 64, 'the Scan disc is 64 px');
			assert.ok(Math.abs((disc.x + disc.width / 2) - width / 2) < 2, 'Scan sits in the center');
			assert.ok(cards.height >= 48, 'every tab is at least 48 px tall');

			const background = await page.locator('.scan-disc').evaluate((el) => getComputedStyle(el).backgroundColor);

			assert.equal(background, 'rgb(220, 10, 45)', 'Scan is the red mark in every theme');

			if (width === 360) {
				// One tap from anywhere: the Scan tab opens the scanner.
				await page.goto(url('sets'));
				await page.click('.tabs a[data-tab="scan"]');
				await page.waitForSelector('#scan');
				assert.equal(new URL(page.url()).pathname, `${BASE}scan`);
				assert.equal(await page.locator('#scan').getAttribute('aria-label'), 'Scan cards');
				assert.equal(await page.locator('.tabs a[data-tab="scan"]').getAttribute('aria-current'), 'page');
			}

			assert.deepEqual(await shownErrors(page), []);
			assert.deepEqual(errors, []);
			await context.close();
		}
	});

	test('the manifest offers an Android shortcut to Scan', async () => {
		const manifest = JSON.parse(await readFile(new URL('../manifest.webmanifest', import.meta.url), 'utf8'));

		assert.deepEqual(manifest.shortcuts.map((shortcut) => shortcut.url), [`${BASE}scan`]);
	});

	test('an empty My Cards and an empty binder offer Scan', async () => {
		const {context, errors, page} = await device(null, 'phone');

		await page.goto(url('cards'));
		await page.waitForSelector('#cards-empty');
		assert.match(await page.locator('#cards-empty').textContent(), /No cards yet/);
		assert.equal(await page.locator('#cards-empty-scan').getAttribute('href'), `${BASE}scan`);
		await page.click('#cards-empty-scan');
		await page.waitForSelector('#scan');

		// An empty binder: the hint under its pockets offers Scan too.
		const binder = await page.evaluate(async () => (await import('/pokemon-card-tracker/js/binders.js')).createBinder({cols: 3, name: 'Empty binder', page_count: 2, rows: 3}));

		await page.goto(url(`binders/${binder.id}`));
		await page.waitForSelector('#binder-empty:not([hidden])');
		assert.equal(await page.locator('#binder-empty-scan').getAttribute('href'), `${BASE}scan`);
		assert.deepEqual(errors, []);
		await context.close();
	});
});

describe('the header', () => {
	test('signed out, the avatar slot reads Sign in and opens Profile, which holds the theme, import and export, and Phone check', async () => {
		const fake = new FakeSupabase();
		const {context, errors, page} = await device(fake, 'phone');

		await page.goto(url('cards'));
		assert.equal(await page.locator('#account').textContent(), 'Sign in');
		assert.ok(await page.locator('#owner-switch').isHidden(), 'no Mine switcher signed out');
		await page.click('#account');
		await page.waitForSelector('#profile-signin #signin-email');
		assert.equal(new URL(page.url()).pathname, `${BASE}profile`);
		assert.equal(await page.locator('#theme-card').count(), 1);
		assert.equal(await page.locator('#profile-import').getAttribute('href'), `${BASE}import`);
		assert.equal(await page.locator('#profile-export').textContent(), 'Export CSV');
		assert.equal(await page.locator('#profile-phone-check').getAttribute('href'), `${BASE}check`);

		// Phone check and Import open from Profile, and tab none.
		await page.click('#profile-phone-check');
		await page.waitForSelector('main h2');
		assert.equal(new URL(page.url()).pathname, `${BASE}check`);
		assert.equal(await page.locator('.tabs a[aria-current="page"]').count(), 0);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('signed in, the avatar is the favorite Pokémon\'s sprite and opens Profile', async () => {
		const fake = new FakeSupabase();
		const owner = fake.addUser('owner@example.test');
		const {context, errors, page} = await device(fake, 'phone');

		await signIn(page, fake, owner.email);
		await waitForSynced(page);
		assert.equal(await page.locator('#account').textContent(), 'O', 'no favorite: the initial');

		await page.evaluate(async () => (await import('/pokemon-card-tracker/js/settings.js')).setFavoritePokemon(25));
		await page.waitForFunction(() => {
			const img = document.querySelector('#account img.avatar-img');

			return img && img.src.endsWith('/pokemon/25.png');
		});
		assert.match(await page.locator('#account').getAttribute('aria-label'), /Profile, signed in as owner@example\.test/);
		await page.click('#account');
		await page.waitForSelector('#profile-email');
		assert.equal(new URL(page.url()).pathname, `${BASE}profile`);
		assert.equal(await page.locator('#profile-phone-check').count(), 1);
		assert.equal(await page.locator('#profile-export').count(), 1);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('offline, a strip under the header counts the changes waiting', async () => {
		const fake = new FakeSupabase();
		const owner = fake.addUser('owner@example.test');
		const {context, errors, page} = await device(fake, 'phone');

		await page.goto(url('cards'));
		await context.setOffline(true);
		await page.waitForSelector('#offline-strip:not([hidden])');
		assert.equal(await page.locator('#offline-strip').textContent(), 'Offline · your cards are saved on this phone');
		await context.setOffline(false);
		await page.waitForSelector('#offline-strip', {state: 'hidden'});

		await signIn(page, fake, owner.email);
		await waitForSynced(page);

		const strip = await page.locator('#offline-strip').boundingBox();

		assert.equal(strip, null, 'no strip online');

		await context.setOffline(true);

		const add = (cardId) => page.evaluate(async (id) => (await import('/pokemon-card-tracker/js/collection.js')).addCard({card_id: id, catalog: 'international', language: 'en', language_source: 'manual'}), cardId);

		await add('tst1-005');
		await add('tst1-006');
		await page.waitForFunction(() => document.getElementById('offline-strip').textContent === 'Offline · 2 changes waiting', null, {timeout: 15000});

		// Under the header, slim, and spanning the width.
		const header = await page.locator('.top').boundingBox();
		const box = await page.locator('#offline-strip').boundingBox();

		assert.ok(Math.abs(box.y - (header.y + header.height)) < 1, 'the strip sits right under the header');
		assert.ok(box.height <= 32, 'the strip is slim');
		assert.equal(box.width, VIEWPORT.width);
		await page.screenshot({path: '/tmp/shell-offline-light.png'});

		await context.setOffline(false);
		await page.waitForSelector('#offline-strip', {state: 'hidden', timeout: 15000});
		assert.deepEqual(errors, []);
		await context.close();
	});
});

describe('family view-only mode', () => {
	test('the Mine switcher enters a member\'s view, the strip follows the tabs, and Done, Scan, and a cold start leave it', async () => {
		const fake = new FakeSupabase();
		const owner = fake.addUser('owner@example.test');
		const kid = fake.addUser('kid@example.test');
		const ownerDevice = await device(fake, 'owner');

		await seedLocal(ownerDevice.page, documentWith(syntheticEntries(6, 'o')));
		await signIn(ownerDevice.page, fake, owner.email);
		await waitForSynced(ownerDevice.page);
		fake.members.push({group_id: fake.groups[0].id, role: 'member', user_id: kid.id});
		fake.profiles.set(owner.id, {display_name: 'Eric', user_id: owner.id});

		const {context, errors, page} = await device(fake, 'kid');

		await signIn(page, fake, kid.email);
		await waitForSynced(page);

		// From Binders: the switcher lists the family, and picking one opens
		// their binders.
		await page.click('.tabs a[data-tab="binders"]');
		await page.waitForSelector('#owner-switch:not([hidden])');
		assert.equal(await page.locator('#owner-switch').textContent(), 'Mine');
		await page.click('#owner-switch');
		await page.waitForSelector('#owner-sheet[open]');
		await page.waitForTimeout(300);
		assert.deepEqual(await page.locator('#owner-sheet .owner-name').allTextContents(), ['Mine', 'Eric\'s']);
		await page.screenshot({path: '/tmp/shell-owner-sheet-light.png'});
		await page.click(`#owner-sheet .owner-option[data-member="${owner.id}"]`);
		await page.waitForSelector('#family-strip');
		assert.equal(new URL(page.url()).pathname, `${BASE}family/${owner.id}/binders`);
		assert.match(await page.locator('#family-strip').textContent(), /^Eric's binders, view only/);
		assert.equal(await page.locator('#owner-switch').textContent(), 'Eric\'s');
		assert.equal(await page.locator('#new-binder').count(), 0, 'edit controls are hidden');

		// The tabs follow the member, and the strip stays on every screen.
		assert.equal(await page.locator('.tabs a[data-tab="cards"]').getAttribute('href'), `${BASE}family/${owner.id}`);
		assert.equal(await page.locator('.tabs a[data-tab="lists"]').getAttribute('href'), `${BASE}family/${owner.id}/lists`);
		await page.click('.tabs a[data-tab="cards"]');
		await page.waitForFunction(() => /^6 copies/.test((document.getElementById('cards-summary') || {}).textContent || ''), null, {timeout: 15000});
		assert.match(await page.locator('#family-strip').textContent(), /^Eric's cards, view only/);
		await page.screenshot({path: '/tmp/shell-family-light.png'});
		await page.click('.tabs a[data-tab="sets"]');
		await page.waitForSelector('#family-strip');
		assert.match(await page.locator('#family-strip').textContent(), /^Eric's collection, view only/);

		// Scan always saves to you, so it leaves the mode.
		await page.click('.tabs a[data-tab="scan"]');
		await page.waitForSelector('#scan');
		assert.equal(await page.locator('#family-strip').count(), 0);
		assert.equal(await page.locator('.tabs a[data-tab="cards"]').getAttribute('href'), `${BASE}cards`);

		// Done goes back to your own screen of the same kind.
		await page.goto(url(`family/${owner.id}/lists`));
		await page.waitForSelector('#family-strip');
		assert.match(await page.locator('#family-strip').textContent(), /^Eric's lists, view only/);
		await page.click('#family-done');
		await page.waitForFunction(() => window.location.pathname.endsWith('/lists'));
		assert.equal(await page.locator('#family-strip').count(), 0);
		assert.equal(await page.locator('#owner-switch').textContent(), 'Mine');

		// A cold start opens your own cards: the mode is never remembered.
		await page.goto(url());
		await page.waitForSelector('#cards-empty, #cards-summary');
		assert.equal(new URL(page.url()).pathname, `${BASE}cards`);
		assert.equal(await page.locator('#family-strip').count(), 0);
		assert.equal(await page.evaluate(() => JSON.stringify({...localStorage}).includes('family')), false, 'nothing about the mode is stored');

		assert.deepEqual(await shownErrors(page), []);
		assert.deepEqual(errors, []);
		await context.close();
		await ownerDevice.context.close();
	});
});

describe('swiping between cards', () => {
	test('a card opened from My Cards keeps the list: position line, swipes, arrows, and Back to the same scroll position', async () => {
		const {context, errors, page} = await device(null, 'phone');

		await seedLocal(page, documentWith(syntheticEntries(30)));
		await page.waitForFunction(() => document.querySelectorAll('.card-grid .tile').length === 30);

		// The list in screen order, newest first.
		const routes = await page.locator('.card-grid .tile').evaluateAll((tiles) => tiles.map((tile) => tile.dataset.link));
		const pick = 13;

		await page.evaluate(() => window.scrollTo(0, 900));
		await page.waitForFunction(() => Math.abs(window.scrollY - 900) < 2);

		const scrolled = await page.evaluate(() => window.scrollY);
		const historyLength = await page.evaluate(() => history.length);

		await page.locator('.card-grid .tile').nth(pick).click();
		await page.waitForSelector('#card-position');
		assert.equal(new URL(page.url()).pathname, `${BASE}${routes[pick]}`);
		assert.equal(await page.locator('#card-position').textContent(), `${pick + 1} of 30`);
		assert.equal(await page.locator('#card-position').getAttribute('aria-label'), `Card ${pick + 1} of 30 in My Cards`);
		assert.equal(await page.locator('#view .back').textContent(), '‹ My Cards');
		assert.equal(await page.locator('.card-detail').evaluate((el) => el.textContent.includes('null')), false, 'no stray null');
		await page.waitForSelector('.card-detail h2');
		await page.screenshot({path: '/tmp/shell-card-light.png'});

		// Swipe left: the next card, in place of this one in the history.
		await swipe(page, '.card-detail', -120);
		await page.waitForFunction((route) => window.location.pathname.endsWith(route), routes[pick + 1]);
		assert.equal(await page.locator('#card-position').textContent(), `${pick + 2} of 30`);
		await page.waitForSelector(`.card-detail h2:has-text("${routes[pick + 1].split('/').pop()}")`);

		// Swipe right twice: back past the first card.
		await swipe(page, '.card-detail', 120);
		await page.waitForFunction((route) => window.location.pathname.endsWith(route), routes[pick]);
		await swipe(page, '.card-detail', 120);
		await page.waitForFunction((route) => window.location.pathname.endsWith(route), routes[pick - 1]);

		// A short or vertical drag does nothing, nor one inside an element
		// that keeps its own swipes (the image carousel).
		await swipe(page, '.card-detail', -30);
		await page.evaluate(() => {
			const own = document.createElement('div');

			own.dataset.swipeOwn = '';
			own.id = 'carousel-stand-in';
			own.style.height = '60px';
			document.querySelector('.card-detail').prepend(own);
		});
		await swipe(page, '#carousel-stand-in', -120);
		await page.waitForTimeout(300);
		assert.ok(page.url().endsWith(routes[pick - 1]), 'the page stays');

		// The arrows beside the position do the same, in the top row with
		// Back, so they never float over the page.
		assert.equal(await page.locator('.card-top #card-nav #card-prev').count(), 1);
		assert.equal(await page.locator('.card-top #card-nav #card-position').count(), 1);
		await page.click('#card-next');
		await page.waitForFunction((route) => window.location.pathname.endsWith(route), routes[pick]);
		await page.click('#card-prev');
		await page.waitForFunction((route) => window.location.pathname.endsWith(route), routes[pick - 1]);
		assert.equal(await page.evaluate(() => history.length), historyLength + 1, 'moving between cards adds no history');

		// Back returns to the list, scrolled where it was left.
		await page.goBack();
		await page.waitForFunction(() => window.location.pathname.endsWith('/cards'));
		await page.waitForFunction((y) => Math.abs(window.scrollY - y) < 2, scrolled, {timeout: 5000});

		// The first card has no previous one, and the list survives a reload.
		await page.evaluate(() => window.scrollTo(0, 0));
		await page.locator('.card-grid .tile').first().click();
		await page.waitForSelector('#card-position');
		assert.ok(await page.locator('#card-prev').isDisabled());
		await page.reload();
		await page.waitForSelector('#card-position');
		assert.equal(await page.locator('#card-position').textContent(), '1 of 30');
		assert.deepEqual(await shownErrors(page), []);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a set keeps its filter as the context, and reduced motion moves without sliding', async () => {
		const {context, errors, page} = await device(null, 'phone', {reducedMotion: 'reduce'});

		await seedLocal(page, documentWith([
			entry('a', {card_id: 'tst2-003'}),
			entry('b', {card_id: 'tst2-007'}),
			entry('c', {card_id: 'tst2-010'}),
		]));
		await page.evaluate(() => localStorage.setItem('cardTracker.setFilter', 'owned'));
		await page.goto(url('sets/en/tst2'));
		await page.waitForFunction(() => document.querySelectorAll('.card-grid .tile').length === 3);
		await page.click('.card-grid .tile >> nth=1');
		await page.waitForSelector('#card-position');
		assert.equal(await page.locator('#card-position').textContent(), '2 of 3');
		assert.equal(await page.locator('#view .back').textContent(), '‹ Test set tst2');
		await page.click('#card-next');
		await page.waitForFunction(() => window.location.pathname.endsWith('/cards/en/tst2-010'));
		assert.equal(await page.evaluate(() => document.getElementById('view').dataset.swipe || null), null, 'no slide with reduced motion');
		assert.ok(await page.locator('#card-next').isDisabled(), 'the last owned card');
		assert.deepEqual(errors, []);
		await context.close();
	});
});

describe('the card tile', () => {
	test('fixed corners: flag top-left, count top-right, finish bottom-left, owned bottom-right, and no flag in the viewing language', async () => {
		const {context, errors, page} = await device(null, 'phone');

		await seedLocal(page, documentWith([
			// Two Portuguese reverse holos of one card, and one English copy.
			entry('p1', {card_id: 'tst1-002', import_key: 'monprice|x|pt|REVERSE_HOLOFOIL|0', language: 'pt'}),
			entry('p2', {card_id: 'tst1-002', import_key: 'monprice|x|pt|REVERSE_HOLOFOIL|1', language: 'pt'}),
			entry('e1', {card_id: 'tst1-001', created_at: '2026-08-01T00:00:00.000Z', language: 'en'}),
		]));

		const pt = page.locator('.card-grid .tile', {hasText: 'tst1-002'});
		const en = page.locator('.card-grid .tile', {hasText: 'tst1-001'});

		// The names arrive from the catalog and redraw the grid; measure after.
		await page.waitForSelector('.tile-name:has-text("Test card tst1-002")');
		await page.waitForTimeout(300);

		const corners = await pt.evaluate((tile) => {
			const art = tile.querySelector('.art-wrap').getBoundingClientRect();
			const at = (selector) => {
				const box = tile.querySelector(selector).getBoundingClientRect();

				return {
					bottom: Math.round(art.bottom - box.bottom),
					left: Math.round(box.left - art.left),
					right: Math.round(art.right - box.right),
					top: Math.round(box.top - art.top),
				};
			};

			return {finish: at('.badge-finish'), lang: at('.badge-lang'), qty: at('.badge-qty')};
		});

		// Inset 4 px, give or take a subpixel of grid rounding.
		const inset = (values, where) => assert.ok(values.every((value) => Math.abs(value - 4) <= 1), `${where}: ${values.join(', ')}`);

		inset([corners.lang.left, corners.lang.top], 'the flag sits top-left');
		inset([corners.qty.right, corners.qty.top], 'the count sits top-right');
		inset([corners.finish.left, corners.finish.bottom], 'the finish sits bottom-left');
		assert.equal(await pt.locator('.badge-qty').textContent(), '×2');
		assert.equal(await pt.locator('.badge-lang').getAttribute('aria-label'), 'Printed in Portuguese');
		assert.equal(await pt.locator('.badge-finish').textContent(), 'REV');
		assert.equal(await pt.locator('.badge-finish').getAttribute('aria-label'), 'Reverse holo');

		// One English copy viewed in English: no count, no flag, no finish.
		assert.equal(await en.locator('.badge').count(), 0);

		// Viewed in Portuguese, the Portuguese copies lose their flag and the
		// English one gains one.
		await page.evaluate(() => localStorage.setItem('cardTracker.viewingLanguage', 'pt'));
		await page.reload();
		await en.waitFor();
		assert.equal(await pt.locator('.badge-lang').count(), 0);
		assert.equal(await en.locator('.badge-lang').getAttribute('aria-label'), 'Printed in English');
		await page.evaluate(() => localStorage.setItem('cardTracker.viewingLanguage', 'en'));

		// A set: owned is a check in a yellow disc at bottom-right, never the
		// danger red, and every other card is dimmed and says Missing.
		await page.goto(url('sets/en/tst1'));
		await page.evaluate(() => localStorage.setItem('cardTracker.setFilter', 'all'));
		await page.reload();

		const owned = page.locator('.card-grid .tile.owned', {hasText: 'tst1-002'});

		await owned.waitFor();

		const status = owned.locator('.badge-status');

		assert.equal(await status.getAttribute('aria-label'), 'Owned');
		assert.equal(await status.evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(255, 203, 5)');
		assert.ok(await status.locator('svg').count(), 'a check glyph, not color alone');

		const statusCorner = await owned.evaluate((tile) => {
			const art = tile.querySelector('.art-wrap').getBoundingClientRect();
			const box = tile.querySelector('.badge-status').getBoundingClientRect();

			return [Math.round(art.right - box.right), Math.round(art.bottom - box.bottom)];
		});

		assert.ok(statusCorner.every((value) => Math.abs(value - 4) <= 1), `the status sits bottom-right: ${statusCorner}`);
		assert.match(await owned.locator('.tile-meta').textContent(), /Owned in PT/);
		assert.equal(await page.locator('.ribbon').count(), 0, 'no red ribbon');

		const reds = await page.locator('.card-grid *').evaluateAll((els) => els.filter((el) => getComputedStyle(el).backgroundColor === 'rgb(220, 10, 45)').length);

		assert.equal(reds, 0, 'red marks nothing in a grid');
		assert.match(await page.locator('.card-grid .tile.unowned').first().locator('.tile-meta').textContent(), /Missing/);
		await page.screenshot({path: '/tmp/shell-set-light.png'});
		assert.deepEqual(await shownErrors(page), []);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('All, Owned, Missing read in the same order in a set and a checklist, and a set not on the phone says so across the whole grid', async () => {
		const {context, errors, page, setOffline} = await device(null, 'phone');

		await page.goto(url('sets/en/tst1'));
		await page.waitForSelector('.segmented');
		assert.deepEqual(await page.locator('.segmented span').allTextContents(), ['All', 'Owned', 'Missing']);

		const source = await readFile(new URL('../js/checklists-view.js', import.meta.url), 'utf8');
		const order = /const FILTERS = \[([\s\S]*?)\];/.exec(source)[1].match(/label: '(\w+)'/g).map((item) => item.slice(8, -1));

		assert.deepEqual(order, ['All', 'Owned', 'Missing']);

		// Offline, a set never opened: one full-width panel, not a notice in a
		// grid column.
		await setOffline(true);
		await page.evaluate(async () => (await import('/pokemon-card-tracker/js/dom.js')).go('sets/en/tst9'));
		await page.waitForSelector('.notice-wide');

		const notice = await page.locator('.notice-wide').boundingBox();
		const main = await page.locator('#view').boundingBox();

		assert.ok(notice.width >= main.width - 1, `the notice spans the view (${notice.width} of ${main.width})`);
		assert.match(await page.locator('.notice-wide').textContent(), /not on this phone yet/);
		assert.equal(await page.locator('.card-grid .notice').count(), 0);
		await page.screenshot({path: '/tmp/shell-offline-set-light.png'});
		assert.deepEqual(errors, []);
		await context.close();
	});
});

describe('the import report', () => {
	test('a report with no unreadable rows prints no stray "null"', async () => {
		const {context, errors, page} = await device(null, 'phone');
		const file = JSON.stringify({pokemon: [{id: 'zzz_int_001', lang: 'EN', name: 'Nobody', number: '1', set: 'Nowhere'}]});

		await page.goto(url('import'));
		await page.setInputFiles('#monprice-file', {buffer: Buffer.from(file), mimeType: 'application/json', name: 'export.json'});
		await page.waitForSelector('text=Match report', {timeout: 30000});
		await page.waitForSelector('.report-line');
		// The text runs together, so look for the letters, not a word.
		assert.equal((await page.locator('#view').textContent()).includes('null'), false);
		assert.deepEqual(errors, []);
		await context.close();
	});
});

describe('the self-hosted font', () => {
	test('Poppins comes from the app, is precached, and still draws offline', async () => {
		const index = await readFile(new URL('../index.html', import.meta.url), 'utf8');

		assert.ok(!/fonts\.googleapis|fonts\.gstatic/.test(index), 'no Google Fonts link');
		assert.match(index, /rel="preload" href="\/pokemon-card-tracker\/vendor\/fonts\/poppins-latin-600-normal\.woff2" as="font" type="font\/woff2" crossorigin/);

		const {context, errors, page} = await device(null, 'phone', {serviceWorkers: 'allow'});

		await page.goto(url('cards'));
		await page.evaluate(() => navigator.serviceWorker.ready);
		await page.reload();
		await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));

		await context.setOffline(true);
		await page.reload();
		await page.waitForSelector('main h2');

		const fonts = await page.evaluate(async () => {
			await document.fonts.ready;
			await Promise.all(['400', '600', '700'].map((weight) => document.fonts.load(`${weight} 16px Poppins`)));

			return {
				body: getComputedStyle(document.body).fontFamily,
				loaded: [...document.fonts].filter((face) => face.family.replace(/"/g, '') === 'Poppins' && face.status === 'loaded').map((face) => face.weight).sort(),
				ok: document.fonts.check('600 16px Poppins'),
			};
		});

		assert.match(fonts.body, /^Poppins/);
		assert.deepEqual(fonts.loaded, ['400', '600', '700']);
		assert.ok(fonts.ok, 'Poppins draws with no connection');
		await page.screenshot({path: '/tmp/shell-offline-font-light.png'});
		assert.deepEqual(errors, []);
		await context.close();
	});
});

describe('screenshots', () => {
	test('the main screens at 360 x 740, light and dark', async () => {
		for (const colorScheme of ['light', 'dark']) {
			// Profile's sign-in panel asks the project whether Google is on.
			const {context, errors, page} = await device(new FakeSupabase(), 'phone', {colorScheme});

			await seedLocal(page, documentWith([
				...syntheticEntries(17),
				entry('p1', {card_id: 'tst1-002', import_key: 'monprice|x|pt|REVERSE_HOLOFOIL|0', language: 'pt'}),
				entry('p2', {card_id: 'tst1-002', import_key: 'monprice|x|pt|REVERSE_HOLOFOIL|1', language: 'pt'}),
			]));
			await page.waitForSelector('.card-grid .tile');
			await page.screenshot({path: `/tmp/shell-cards-${colorScheme}.png`});

			await page.click('.card-grid .tile >> nth=2');
			await page.waitForSelector('.card-detail h2');
			await page.waitForSelector('#card-position');
			await page.screenshot({path: `/tmp/shell-card-${colorScheme}.png`});

			for (const [name, path, ready] of [
				['set', 'sets/en/tst1', '.card-grid .tile'],
				['scan', 'scan', '#scan'],
				['lists', 'lists', '.lists-switch'],
				['wishlist', 'wishlist', '.lists-switch'],
				['profile', 'profile', '#theme-card'],
			]) {
				await page.goto(url(path));
				await page.waitForSelector(ready);
				await page.waitForTimeout(150);
				await page.screenshot({path: `/tmp/shell-${name}-${colorScheme}.png`});
			}

			assert.deepEqual(await shownErrors(page), []);
			assert.deepEqual(errors, []);
			await context.close();
		}
	});
});
