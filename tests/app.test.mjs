// Browser tests for sign-in, sync, Profile, the family view, and the views
// that existed before them. Headless Chromium at 360 x 740 against
// tests/pages-server.mjs, which behaves like GitHub Pages.
//
// Supabase is never reached: every request to the project is answered by
// tests/fake-supabase.mjs. TCGdex is faked too, except in the test of the
// existing catalog views, which reads the real public API.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/app.test.mjs
// (PLAYWRIGHT may be left out when playwright is installed where Node finds
// it.)

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {stamps} from '../js/merge.js';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {FakeSupabase} from './fake-supabase.mjs';
import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const VIEWPORT = {height: 740, width: 360};

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

// Made-up entries shaped like imported ones. Ten fake sets of 160 cards.
const SETS = Array.from({length: 10}, (_, i) => `tst${i + 1}`);

function syntheticEntries(count, prefix = 'e') {
	const start = Date.parse('2026-09-01T00:00:00.000Z');

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
			import_key: `${100000 + i}|pt|REVERSE_HOLOFOIL|1`,
			language: i % 3 ? 'pt' : 'en',
			language_source: 'import',
			updated_at: at,
			variant_id: 'reverse',
		};
	});
}

function documentWith(cards) {
	return {binders: [], cards, collections: [], goals: [], openings: [], person: 'local', updated_at: '2026-09-01T00:00:00.000Z', user_id: null, version: 1, wishlist: []};
}

async function fakeTcgdex(context) {
	await context.route('https://api.tcgdex.net/**', (route) => {
		const match = /\/v2\/(\w+)\/sets\/(tst\d+)$/.exec(new URL(route.request().url()).pathname);

		if (!match) {
			return route.fulfill({body: '{}', contentType: 'application/json', status: 404});
		}

		const setId = match[2];

		return route.fulfill({
			body: JSON.stringify({
				cardCount: {official: 160, total: 160},
				cards: Array.from({length: 160}, (_, i) => {
					const localId = String(i + 1).padStart(3, '0');

					return {id: `${setId}-${localId}`, image: null, localId, name: `Test card ${setId} ${localId}`};
				}),
				id: setId,
				name: `Test set ${setId}`,
				releaseDate: '2026-01-01',
			}),
			contentType: 'application/json',
			status: 200,
		});
	});
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));
}

async function blockFonts(context) {
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
}

async function device(fake, name, {serviceWorkers = 'block', tcgdex = 'fake'} = {}) {
	const context = await browser.newContext({serviceWorkers, viewport: VIEWPORT});

	await blockFonts(context);
	await fakePokeApi(context);

	if (fake) {
		await fake.attach(context, name);
	}
	else {
		// No Supabase at all: any request to it fails the test.
		await context.route('https://*.supabase.co/**', (route) => {
			throw new Error(`Unexpected Supabase request: ${route.request().url()}`);
		});
	}

	if (tcgdex === 'fake') {
		await fakeTcgdex(context);
	}

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

const localDoc = (page) => page.evaluate(async () => (await import('/pokemon-card-tracker/js/collection.js')).loadDocument());

const addCard = (page, fields) => page.evaluate(async (card) => (await import('/pokemon-card-tracker/js/collection.js')).addCard(card), fields);

const syncNow = (page) => page.evaluate(async () => (await import('/pokemon-card-tracker/js/sync.js')).syncNow());

const statusText = (page) => page.locator('#sync-status').textContent();

async function waitForStatus(page, text) {
	await page.waitForFunction((expected) => {
		const line = document.getElementById('sync-status');

		return line && !line.hidden && line.textContent === expected;
	}, text, {timeout: 15000});
}

async function signIn(page, fake, email) {
	await page.goto(url('signin'));
	await page.fill('#signin-email', email);
	await page.click('button:has-text("Send link")');
	await page.waitForSelector('#check-email');

	// The link in the email: the site's address with ?code=.
	const code = fake.issueCode(email);

	await page.goto(`${url()}?code=${code}`);
	await page.waitForSelector('#account.avatar');
}

const docRow = (fake, user) => fake.documents.get(user.id);

const liveCount = (doc) => doc.cards.filter((card) => !card.deleted_at).length;

// ----------------------------------------------------------------- tests

describe('signed out', () => {
	test('the app works with no account and never contacts Supabase', async () => {
		const {context, errors, page} = await device(null, 'phone');

		await seedLocal(page, documentWith(syntheticEntries(30)));
		await page.waitForSelector('.tile');

		assert.equal(await page.locator('#account').textContent(), 'Sign in');
		assert.ok(await page.locator('#sync-status').isHidden());
		assert.match(await page.locator('#cards-summary').textContent(), /^30 copies/);
		assert.equal(await page.locator('#family-switcher').count(), 0);

		const vendorLoaded = await page.evaluate(() => performance.getEntriesByType('resource').some((entry) => entry.name.includes('vendor/supabase-js.js')));

		assert.equal(vendorLoaded, false, 'the Supabase client is not loaded signed out');

		// An edit signed out stays local and shows no sync status.
		await addCard(page, {card_id: 'tst1-001', catalog: 'international', language: 'en', language_source: 'manual'});
		await page.waitForFunction(() => /^31 copies/.test(document.getElementById('cards-summary').textContent));
		assert.ok(await page.locator('#sync-status').isHidden());
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('two tabs signed out keep each other\'s edits, and each shows the other\'s', async () => {
		const {context, errors, page: tabA} = await device(null, 'phone');

		await seedLocal(tabA, documentWith(syntheticEntries(30)));
		await tabA.waitForSelector('.tile');

		const tabB = await context.newPage();
		const errorsB = [];

		tabB.on('pageerror', (err) => errorsB.push(err));
		await tabB.goto(url('cards'));
		await tabB.waitForFunction(() => /^30 copies/.test((document.getElementById('cards-summary') || {}).textContent || ''));

		// A adds a card, then B, which loaded before A's edit, adds another
		// and deletes one; A then edits a card B never touched.
		const cardA = await addCard(tabA, {card_id: 'tst1-001', catalog: 'international', language: 'en', language_source: 'manual'});

		await tabB.waitForFunction(() => /^31 copies/.test(document.getElementById('cards-summary').textContent), null, {timeout: 5000});

		const cardB = await addCard(tabB, {card_id: 'tst2-002', catalog: 'international', language: 'pt', language_source: 'manual'});

		await tabB.evaluate(async () => (await import('/pokemon-card-tracker/js/collection.js')).deleteCard('e-00004'));
		await tabA.evaluate(async () => (await import('/pokemon-card-tracker/js/collection.js')).updateCard('e-00005', {notes: 'from tab A'}));
		await tabA.waitForFunction(() => /^31 copies/.test(document.getElementById('cards-summary').textContent), null, {timeout: 5000});

		// What both tabs hold, and what is stored, after a reload.
		for (const tab of [tabA, tabB]) {
			const doc = await localDoc(tab);
			const byId = new Map(doc.cards.map((card) => [card.id, card]));

			assert.ok(byId.has(cardA.id) && byId.has(cardB.id), 'both new cards are held');
			assert.ok(byId.get('e-00004').deleted_at, 'the delete is held');
			assert.equal(byId.get('e-00005').notes, 'from tab A');
		}

		await tabA.reload();
		await tabA.waitForFunction(() => /^31 copies/.test((document.getElementById('cards-summary') || {}).textContent || ''));

		const stored = await localDoc(tabA);

		assert.equal(liveCount(stored), 31);
		assert.ok(stored.cards.some((card) => card.id === cardA.id));
		assert.ok(stored.cards.some((card) => card.id === cardB.id));
		assert.deepEqual([...errors, ...errorsB], []);
		await context.close();
	});
});

describe('source names', () => {
	test('a Korean copy on a Japanese record shows the names the source gave it', async () => {
		const {context, errors, page} = await device(null, 'phone');
		const at = '2026-09-01T00:00:00.000Z';
		const entry = (id, fields) => ({created_at: at, deleted_at: null, id, language_source: 'import', updated_at: at, ...fields});

		// The Japanese catalog's card record for the detail page.
		await context.route('https://api.tcgdex.net/v2/ja/cards/tst1-001', (route) => route.fulfill({
			body: JSON.stringify({id: 'tst1-001', localId: '001', name: 'Test card tst1 001', set: {cardCount: {official: 160}, id: 'tst1', name: 'Test set tst1'}, variants_detailed: []}),
			contentType: 'application/json',
			status: 200,
		}));

		await seedLocal(page, documentWith([
			entry('k1', {card_id: 'tst1-001', catalog: 'ja', fallback: true, import_key: 'monprice|t_kr_001|ko|NORMAL|0', language: 'ko', name_local: '시험 카드', set_name_local: '시험 세트'}),
			// A normal match keeps the catalog's names.
			entry('j1', {card_id: 'tst1-002', catalog: 'ja', import_key: 'monprice|t_jp_002|ja|NORMAL|0', language: 'ja', name_local: 'Source name only', set_name_local: 'Source set only'}),
			// A Korean Pokémon: its English name leads, the Korean name and its
			// reading under it.
			entry('k2', {card_id: 'tst1-004', catalog: 'ja', fallback: true, import_key: 'monprice|t_kr_004|ko|NORMAL|0', language: 'ko', name_local: '프테라VSTAR', set_name_local: '시험 세트'}),
		]));

		const korean = page.locator('.tile', {hasText: '시험 카드'});

		await korean.waitFor();
		assert.match(await korean.locator('.tile-meta').textContent(), /시험 세트/);
		// A Trainer-like name with no English name: the original, and its
		// reading underneath.
		assert.equal(await korean.locator('.tile-name').textContent(), '시험 카드');
		assert.equal(await korean.locator('.tile-original').textContent(), '(Siheom Kadeu)');

		// The language is a flag, named in its label and title.
		const flag = korean.locator('.badge-lang');

		assert.equal(await flag.getAttribute('aria-label'), 'Printed in Korean');
		assert.equal(await flag.getAttribute('title'), 'Korean');
		assert.match(await flag.locator('img.flag').getAttribute('src'), /\/vendor\/flags\/kr\.svg$/);
		assert.ok(await flag.locator('img.flag').evaluate((img) => img.complete && img.naturalWidth > 0), 'the flag image loads');

		const aerodactyl = page.locator('.tile', {hasText: 'Aerodactyl VSTAR'});

		await aerodactyl.waitFor();
		assert.equal(await aerodactyl.locator('.tile-name').textContent(), 'Aerodactyl VSTAR');
		assert.equal(await aerodactyl.locator('.tile-original').textContent(), '프테라VSTAR (Peutera VSTAR)');
		await page.waitForSelector('.tile-name:has-text("Test card tst1 002")');
		assert.equal(await page.locator('.tile-name:has-text("Source name only")').count(), 0);

		// Card detail: every copy is Korean, so the source's names lead.
		await page.goto(url('cards/ja/tst1-001'));
		await page.waitForSelector('.card-detail h2:has-text("시험 카드")');
		// The row's flag names the language; its stepper shows the count.
		await page.waitForSelector('.copies li .flags[title="Korean"]');
		assert.equal(await page.locator('.copies .copy-text').textContent(), 'Finish not set');
		assert.equal(await page.locator('.copies .step-count').inputValue(), '1');
		assert.equal(await page.locator('.card-detail .name-original').textContent(), '(Siheom Kadeu)');

		// With a Japanese copy too, the catalog name leads and the Korean copy
		// lists its own name.
		await addCard(page, {card_id: 'tst1-001', catalog: 'ja', language: 'ja', language_source: 'manual'});
		await page.reload();
		await page.waitForSelector('.card-detail h2:has-text("Test card tst1 001")');
		await page.waitForSelector('.copies li:has-text("시험 카드")');
		assert.equal(await page.locator('.copies li:has(.flags[title="Korean"]) .copy-text').textContent(), '시험 카드 · Finish not set');
		assert.deepEqual(errors, []);
		await context.close();
	});
});

describe('sign in', () => {
	test('the Sign in screen: email link, check-your-email state, no sign-up wording, Google hidden', async () => {
		const fake = new FakeSupabase({google: false});

		fake.addUser('owner@example.test');

		const {context, errors, page} = await device(fake, 'phone');

		// Signed out, the avatar slot reads Sign in and opens Profile, whose
		// first panel is the sign-in form.
		await page.goto(url('cards'));
		assert.equal(await page.locator('#account').textContent(), 'Sign in');
		await page.click('#account');
		await page.waitForSelector('#signin-email');
		assert.equal(new URL(page.url()).pathname, `${BASE}profile`);
		assert.equal(await page.locator('h2').textContent(), 'Profile');
		assert.equal(await page.locator('#profile-signin h3').textContent(), 'Sign in');

		// Profile asks the project about Google once the person starts to
		// sign in, not on opening.
		await page.waitForTimeout(200);
		assert.equal(fake.log.filter((entry) => entry.path === '/auth/v1/settings').length, 0, 'opening Profile contacts no one');
		await page.focus('#signin-email');

		// Google stays hidden: the settings say it is off.
		await page.waitForFunction(() => performance.getEntriesByType('resource').some((entry) => entry.name.endsWith('/auth/v1/settings')));
		await page.waitForTimeout(200);
		assert.ok(await page.locator('#signin-google').isHidden());

		const text = (await page.locator('main').textContent()).toLowerCase();

		assert.ok(!/sign.?up|create an account|register/.test(text), 'no sign-up wording');

		// An address that was never invited.
		await page.fill('#signin-email', 'stranger@example.test');
		await page.click('button:has-text("Send link")');
		await page.waitForSelector('.form-error:has-text("not been invited")');

		await page.fill('#signin-email', 'owner@example.test');
		await page.click('button:has-text("Send link")');
		await page.waitForSelector('#check-email');
		assert.match(await page.locator('#check-email').textContent(), /owner@example\.test/);
		assert.equal(fake.emails.at(-1).redirect, url(), 'the link returns to the site base URL');

		const otp = fake.log.find((entry) => entry.path === '/auth/v1/otp');

		assert.equal(otp.body.code_challenge_method, 's256', 'PKCE challenge sent');
		assert.equal(otp.body.create_user, false, 'a sign-in link never creates an account');
		await page.screenshot({path: '/tmp/card-tracker-signin.png'});
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('the ?code= return is exchanged, removed from the address bar, and the session survives a reload', async () => {
		const fake = new FakeSupabase();
		const owner = fake.addUser('owner@example.test');
		const {context, errors, page} = await device(fake, 'phone');

		await signIn(page, fake, owner.email);
		assert.ok(!page.url().includes('code='), `address still has the code: ${page.url()}`);
		assert.equal(new URL(page.url()).pathname, `${BASE}cards`);
		await waitForStatus(page, 'Synced');

		const exchange = fake.log.find((entry) => entry.search === '?grant_type=pkce');

		assert.ok(exchange, 'code exchanged with the PKCE grant');

		// A second visit: still signed in, and an unchanged row is not
		// downloaded again.
		const before = fake.log.length;

		await page.reload();
		await page.waitForSelector('#account.avatar');
		await waitForStatus(page, 'Synced');

		const reads = fake.log.slice(before).filter((entry) => entry.path === '/rest/v1/documents' && entry.method === 'GET');

		assert.ok(reads.length >= 1);
		assert.ok(reads.every((entry) => entry.search.includes('select=updated_at')), 'only updated_at was read');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('an expired link lands on Sign in with a clear message and a clean address', async () => {
		const fake = new FakeSupabase();
		const {context, page} = await device(fake, 'phone');

		await page.goto(`${url()}?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`);
		await page.waitForSelector('.notice:has-text("expired")');
		assert.equal(new URL(page.url()).pathname, `${BASE}signin`);
		assert.equal(new URL(page.url()).search, '');
		await context.close();
	});

	test('a dashboard invitation link signs the person in and its # fragment is removed', async () => {
		const fake = new FakeSupabase();
		const kid = fake.addUser('kid@example.test');
		const {context, errors, page} = await device(fake, 'phone');
		const session = fake.session(kid);

		await page.goto(`${url()}#access_token=${session.access_token}&expires_in=3600&refresh_token=${session.refresh_token}&token_type=bearer&type=invite`);
		await page.waitForSelector('#account.avatar');
		assert.equal(new URL(page.url()).hash, '');
		assert.equal(new URL(page.url()).pathname, `${BASE}cards`);
		await waitForStatus(page, 'Synced');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('Continue with Google shows when the project enables it and returns through the same ?code= path', async () => {
		const fake = new FakeSupabase({google: true});
		const owner = fake.addUser('owner@example.test');

		fake.googleUser = owner;

		const {context, errors, page} = await device(fake, 'phone');

		await page.goto(url('signin'));
		await page.waitForSelector('#signin-google:not([hidden])');
		await page.click('#signin-google');
		await page.waitForSelector('#account.avatar');
		assert.ok(!page.url().includes('code='));

		const authorize = fake.log.find((entry) => entry.path === '/auth/v1/authorize');
		const params = new URLSearchParams(authorize.search);

		assert.equal(params.get('provider'), 'google');
		assert.equal(params.get('redirect_to'), url());
		assert.ok(params.get('code_challenge'), 'PKCE challenge sent to Google sign-in');
		assert.deepEqual(errors, []);
		await context.close();
	});
});

describe('sync', () => {
	test('the first sign-in uploads the existing local collection of 1,600 entries', async () => {
		const fake = new FakeSupabase();
		const owner = fake.addUser('owner@example.test');
		const {context, errors, page} = await device(fake, 'phone');

		await seedLocal(page, documentWith(syntheticEntries(1600)));
		await page.waitForSelector('.tile');
		await signIn(page, fake, owner.email);
		await waitForStatus(page, 'Synced');

		const row = docRow(fake, owner);

		assert.equal(row.doc.cards.length, 1600);
		assert.equal(row.doc.user_id, undefined, 'phone-only fields stay on the phone');

		const insert = fake.log.find((entry) => entry.path === '/rest/v1/documents' && entry.method === 'POST');

		console.log(`    first upload: ${(insert.bytes / 1024).toFixed(0)} KB for 1,600 entries`);
		assert.ok(insert.bytes < 1024 * 1024, 'the first upload is under 1 MB');
		assert.equal(fake.log.filter((entry) => entry.path === '/rest/v1/rpc/claim_owner').length, 1);
		assert.equal(fake.groups[0].owner_id, owner.id, 'the first sign-in became the owner');
		assert.ok(fake.profiles.has(owner.id), 'profile row made');

		const local = await localDoc(page);

		assert.equal(local.user_id, owner.id);
		assert.match(await page.locator('#cards-summary').textContent(), /^1,600 copies/);

		// Cards this phone never imported get names from the catalog.
		await page.waitForSelector('.tile-name:has-text("Test card")');
		await page.screenshot({path: '/tmp/card-tracker-synced.png'});
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('two devices writing at once lose nothing', async () => {
		const fake = new FakeSupabase();
		const owner = fake.addUser('owner@example.test');
		const phone = await device(fake, 'phone');
		const laptop = await device(fake, 'laptop');

		await seedLocal(phone.page, documentWith(syntheticEntries(50, 'p')));
		await signIn(phone.page, fake, owner.email);
		await waitForStatus(phone.page, 'Synced');
		await signIn(laptop.page, fake, owner.email);
		await waitForStatus(laptop.page, 'Synced');
		assert.equal(liveCount(await localDoc(laptop.page)), 50, 'the laptop pulled the phone\'s cards');

		// The phone edits and starts to save; its write is held after its
		// read, while the laptop saves a different change.
		const held = fake.gate((entry) => entry.device === 'phone' && entry.method === 'PATCH');
		const phoneCard = await addCard(phone.page, {card_id: 'tst2-002', catalog: 'international', language: 'en', language_source: 'manual'});
		const phoneSync = syncNow(phone.page);

		await held.reached;

		const laptopCard = await addCard(laptop.page, {card_id: 'tst3-003', catalog: 'international', language: 'pt', language_source: 'manual'});
		const deleted = (await localDoc(laptop.page)).cards[0].id;

		await laptop.page.evaluate(async (id) => (await import('/pokemon-card-tracker/js/collection.js')).deleteCard(id), deleted);
		await syncNow(laptop.page);
		held.release();
		await phoneSync;
		await waitForStatus(phone.page, 'Synced');

		const phonePatches = fake.log.filter((entry) => entry.device === 'phone' && entry.method === 'PATCH');

		assert.ok(phonePatches.length >= 2, 'the phone\'s first write missed the guard and was retried');

		const server = docRow(fake, owner).doc;
		const ids = new Set(server.cards.map((card) => card.id));

		assert.ok(ids.has(phoneCard.id), 'the phone\'s card is on the server');
		assert.ok(ids.has(laptopCard.id), 'the laptop\'s card is on the server');
		assert.ok(server.cards.find((card) => card.id === deleted).deleted_at, 'the laptop\'s deletion is kept');
		assert.equal(server.cards.length, 52);

		// The laptop pulls the phone's card in.
		await syncNow(laptop.page);

		const laptopDoc = await localDoc(laptop.page);

		assert.ok(laptopDoc.cards.some((card) => card.id === phoneCard.id));
		assert.equal(liveCount(laptopDoc), 51);
		assert.deepEqual([...phone.errors, ...laptop.errors], []);
		await phone.context.close();
		await laptop.context.close();
	});

	test('offline changes wait on the phone and go up when the connection returns', async () => {
		const fake = new FakeSupabase();
		const owner = fake.addUser('owner@example.test');
		const {context, errors, page} = await device(fake, 'phone');

		await seedLocal(page, documentWith(syntheticEntries(10)));
		await signIn(page, fake, owner.email);
		await waitForStatus(page, 'Synced');

		const writesBefore = fake.log.filter((entry) => entry.method === 'PATCH').length;

		await context.setOffline(true);
		await waitForStatus(page, 'Offline');
		await addCard(page, {card_id: 'tst1-005', catalog: 'international', language: 'en', language_source: 'manual'});
		await addCard(page, {card_id: 'tst1-006', catalog: 'international', language: 'en', language_source: 'manual'});
		await waitForStatus(page, 'Offline, 2 changes waiting');
		await page.screenshot({path: '/tmp/card-tracker-offline.png'});
		await page.waitForTimeout(3500);
		assert.equal(fake.log.filter((entry) => entry.method === 'PATCH').length, writesBefore, 'nothing was sent offline');

		await context.setOffline(false);
		await waitForStatus(page, 'Synced');
		assert.equal(liveCount(docRow(fake, owner).doc), 12);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a debounced edit shows Saving, then Synced', async () => {
		const fake = new FakeSupabase();
		const owner = fake.addUser('owner@example.test');
		const {context, page} = await device(fake, 'phone');

		await signIn(page, fake, owner.email);
		await waitForStatus(page, 'Synced');
		await addCard(page, {card_id: 'tst1-007', catalog: 'international', language: 'en', language_source: 'manual'});
		assert.equal(await statusText(page), 'Saving');
		await waitForStatus(page, 'Synced');
		assert.equal(liveCount(docRow(fake, owner).doc), 1);
		await context.close();
	});

	test('signing out keeps the cards, and another person signing in on the phone gets only their own', async () => {
		const fake = new FakeSupabase();
		const owner = fake.addUser('owner@example.test');
		const kid = fake.addUser('kid@example.test');
		const {context, errors, page} = await device(fake, 'phone');

		await seedLocal(page, documentWith(syntheticEntries(20)));
		await signIn(page, fake, owner.email);
		await waitForStatus(page, 'Synced');
		await page.click('#account');
		await page.click('#sign-out');
		await page.waitForSelector('#account:has-text("Sign in")');
		assert.match(await page.locator('#cards-summary').textContent(), /^20 copies/, 'cards stay after sign-out');

		await signIn(page, fake, kid.email);
		await waitForStatus(page, 'Synced');
		assert.equal(liveCount(await localDoc(page)), 0, 'the kid does not get the owner\'s cards');
		assert.equal(liveCount(docRow(fake, kid).doc), 0, 'nothing of the owner\'s reached the kid\'s row');

		// The owner signs back in: their cards come back from the phone.
		await page.click('#account');
		await page.click('#sign-out');
		await page.waitForSelector('#account:has-text("Sign in")');
		await signIn(page, fake, owner.email);
		await waitForStatus(page, 'Synced');
		assert.equal(liveCount(await localDoc(page)), 20);
		assert.deepEqual(errors, []);
		await context.close();
	});
});

// ------------------------------------------- the same import on two phones

// Rows shaped as js/monprice.js importEntries makes them.
const importRows = (count) => Array.from({length: count}, (_, i) => ({
	card_id: `${SETS[i % SETS.length]}-${String(Math.floor(i / SETS.length) + 1).padStart(3, '0')}`,
	catalog: 'international',
	import_key: `monprice|row_int_${i}|pt|NORMAL|0`,
	language: 'pt',
	language_source: 'import',
	name_local: `Test card ${i}`,
	set_name_local: 'Test set',
	variant_id: 'normal',
}));

const applyImport = (page, rows) => page.evaluate(async (list) => (await import('/pokemon-card-tracker/js/collection.js')).applyImport(list), rows);

// Puts records straight into the collection database (as an older version
// of the app left them), then reloads.
async function seedStore(page, records) {
	await page.goto(url('cards'));
	await page.evaluate(async (pairs) => {
		await new Promise((resolve, reject) => {
			const open = indexedDB.open('card-tracker-collection', 1);

			open.onupgradeneeded = () => open.result.createObjectStore('documents');
			open.onsuccess = () => {
				const tx = open.result.transaction('documents', 'readwrite');

				for (const [key, value] of pairs) {
					tx.objectStore('documents').put(value, key);
				}

				tx.oncomplete = () => {
					open.result.close();
					resolve();
				};
				tx.onerror = () => reject(tx.error);
			};
			open.onerror = () => reject(open.error);
		});
	}, Object.entries(records));
	await page.reload();
}

// A document a v21 phone pair left doubled: every imported row twice, with
// random ids. The second copies were imported a day later; one of them sits
// in a binder pocket and holds a photo.
function doubledDocument(count, userId) {
	const rows = importRows(count);
	const first = Date.parse('2026-09-01T00:00:00.000Z');
	const second = Date.parse('2026-09-02T00:00:00.000Z');
	const entry = (fields, i, start, prefix) => {
		const at = new Date(start + i).toISOString();

		return {...fields, created_at: at, deleted_at: null, id: `${prefix}-${String(i).padStart(4, '0')}`, updated_at: at};
	};
	const cards = [...rows.map((fields, i) => entry(fields, i, first, 'a')), ...rows.map((fields, i) => entry(fields, i, second, 'b'))];
	const photoed = cards.find((card) => card.id === 'b-0001');

	photoed.photos = [{created_at: photoed.created_at, deleted_at: null, id: 'photo-1', path: `${userId}/b-0001/photo-1.webp`, side: 'front'}];
	photoed.main_image = 'photo-1';

	const binder = {
		art: [], cols: 3, cover_color: '#1b1b1f', created_at: '2026-09-03T00:00:00.000Z', deleted_at: null, id: 'binder-1',
		name: 'Main binder', notes: '', page_count: 4, rows: 3,
		slots: [{entry_id: 'b-0002', page: 1, placed_at: '2026-09-03T00:00:00.000Z', position: 1}],
		updated_at: '2026-09-03T00:00:00.000Z',
	};

	return {...documentWith(cards), binders: [binder], user_id: userId};
}

function checkRepaired(doc, count) {
	const live = doc.cards.filter((card) => !card.deleted_at);

	assert.equal(live.length, count, 'one live copy per row');
	assert.equal(new Set(live.map((card) => card.import_key)).size, count);
	assert.ok(live.every((card) => card.id.startsWith('a-')), 'the older copies survive');
	assert.equal(doc.cards.find((card) => card.id === 'b-0002').merged_into, 'a-0002');

	const kept = live.find((card) => card.id === 'a-0001');

	assert.deepEqual((kept.photos || []).map((item) => item.id), ['photo-1'], 'the photo moved to the survivor');
	assert.equal(kept.main_image, 'photo-1');
	assert.equal(doc.binders[0].slots[0].entry_id, 'a-0002', 'the pocket now holds the survivor');
}

describe('importing on two phones', () => {
	test('the same import on a second phone, signed out then signed in, keeps one copy per row; importing again reports unchanged', async () => {
		const fake = new FakeSupabase();
		const owner = fake.addUser('owner@example.test');
		const phone = await device(fake, 'phone');
		const laptop = await device(fake, 'laptop');
		const rows = importRows(50);

		await phone.page.goto(url('cards'));
		assert.equal((await applyImport(phone.page, rows)).added, 50);
		await signIn(phone.page, fake, owner.email);
		await waitForStatus(phone.page, 'Synced');
		assert.equal(liveCount(docRow(fake, owner).doc), 50);

		// The second phone imports the same file before ever signing in.
		await laptop.page.goto(url('cards'));
		assert.equal((await applyImport(laptop.page, rows)).added, 50);
		await signIn(laptop.page, fake, owner.email);
		await waitForStatus(laptop.page, 'Synced');
		await syncNow(phone.page);

		assert.equal(liveCount(docRow(fake, owner).doc), 50, 'the server holds one copy per row');
		assert.equal(liveCount(await localDoc(laptop.page)), 50);
		assert.equal(liveCount(await localDoc(phone.page)), 50);

		const again = await applyImport(laptop.page, rows);

		assert.deepEqual(again, {added: 0, skippedDeleted: 0, unchanged: 50, updated: 0});
		assert.deepEqual([...phone.errors, ...laptop.errors], []);
		await phone.context.close();
		await laptop.context.close();
	});

	test('a document already doubled by v21 is repaired at the first sync, pocket and photo kept', async () => {
		const fake = new FakeSupabase();
		const owner = fake.addUser('owner@example.test');
		const {context, errors, page} = await device(fake, 'phone');
		const doubled = doubledDocument(20, owner.id);

		fake.documents.set(owner.id, {doc: {...doubled, person: undefined, user_id: undefined}, updated_at: fake.now(), user_id: owner.id});
		await signIn(page, fake, owner.email);
		await waitForStatus(page, 'Synced');

		checkRepaired(docRow(fake, owner).doc, 20);
		checkRepaired(await localDoc(page), 20);
		assert.match(await page.locator('#cards-summary').textContent(), /^20 copies/);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a doubled document the server already holds is repaired at the next sync, with nothing new to download', async () => {
		const fake = new FakeSupabase();
		const owner = fake.addUser('owner@example.test');
		const {context, errors, page} = await device(fake, 'phone');
		const doubled = doubledDocument(10, owner.id);
		const serverDoc = structuredClone({...doubled, person: undefined, user_id: undefined});
		const stamp = fake.now();

		fake.documents.set(owner.id, {doc: serverDoc, updated_at: stamp, user_id: owner.id});

		// The phone last synced this very document, so the server has nothing
		// new for it.
		await seedStore(page, {
			local: doubled,
			[`meta:sync:${owner.id}`]: {base: [...stamps(serverDoc)], updated_at: stamp},
		});
		await signIn(page, fake, owner.email);
		await waitForStatus(page, 'Synced');

		const fullReads = fake.log.filter((entry) => entry.path === '/rest/v1/documents' && entry.method === 'GET' && /select=doc/.test(decodeURIComponent(entry.search)));

		assert.equal(fullReads.length, 0, 'the full document was not downloaded');
		checkRepaired(docRow(fake, owner).doc, 10);
		checkRepaired(await localDoc(page), 10);
		assert.deepEqual(errors, []);
		await context.close();
	});
});

describe('the import screen', () => {
	// TCGdex as the matcher asks it (js/monprice.js matchRows): the set by its
	// printed abbreviation, the set's card list, and each card's printings.
	async function fakeImportCatalog(context) {
		await context.route('https://api.tcgdex.net/**', (route) => {
			const {pathname, search} = new URL(route.request().url());
			const json = (body) => route.fulfill({body: JSON.stringify(body), contentType: 'application/json', status: 200});

			if (/\/v2\/en\/sets$/.test(pathname)) {
				return json(/abbreviation\.official=eq:tst1/.test(decodeURIComponent(search)) ? [{id: 'tst1', name: 'Test set tst1'}] : []);
			}

			if (/\/v2\/\w+\/sets\/tst1$/.test(pathname)) {
				return json({
					cards: Array.from({length: 9}, (_, i) => ({id: `tst1-00${i + 1}`, image: null, localId: `00${i + 1}`, name: `Test card ${i + 1}`})),
					cardCount: {official: 9, total: 9},
					id: 'tst1',
					name: 'Test set tst1',
					releaseDate: '2026-01-01',
				});
			}

			const card = /\/v2\/\w+\/cards\/(tst1-00\d)$/.exec(pathname);

			if (card) {
				return json({id: card[1], image: null, localId: card[1].slice(-3), name: `Test card ${card[1]}`, rarity: 'Common', set: {id: 'tst1', name: 'Test set tst1'}, variants_detailed: [{type: 'normal', variantId: 'normal'}]});
			}

			return route.fulfill({body: '{}', contentType: 'application/json', status: 404});
		});
	}

	const CSV = [
		'Name;Set;Number;Language;Finish Type;Count;ID;Release Date',
		'Test card 1;Test set;001/009;PT;NORMAL;1;tst1_int_1;2026-01-01',
		'Test card 2;Test set;="002/009";PT;NORMAL;60;tst1_int_2;2026-01-01',
		'Test card 3;Test set;003/009;PT;NORMAL;99999;tst1_int_3;2026-01-01',
	].join('\r\n');

	async function pickFile(page) {
		await page.goto(url('import'));
		await page.setInputFiles('#monprice-file', {buffer: Buffer.from(CSV), mimeType: 'text/csv', name: 'weird-rows.csv'});
		await page.waitForSelector('button.primary.wide');
	}

	test('a huge Count is refused, a large one is left out unless ticked, and the report says why', async () => {
		const {context, errors, page} = await device(null, 'phone');

		await fakeImportCatalog(context);
		await pickFile(page);

		const save = page.locator('button.primary.wide');

		assert.match(await page.locator('#import-large').textContent(), /One row asks for more than 50 copies of one card\. That is usually a typo in the Count column, so it is left out unless you tick it\./);
		assert.match(await page.locator('#import-large li').textContent(), /Save all 60 copies: Line 3/);
		assert.equal(await save.textContent(), 'Save 1 copy');

		await page.locator('#import-large input').check();
		assert.equal(await save.textContent(), 'Save 61 copies');
		await page.locator('#import-large input').uncheck();
		assert.equal(await save.textContent(), 'Save 1 copy');

		const refused = page.locator('details.report-line', {hasText: 'Rows the file could not describe: 1'});

		await refused.locator('summary').click();
		// The rows fill on the toggle event, just after the click.
		await refused.locator('li').first().waitFor();
		assert.match(await refused.textContent(), /count 99,999 is more than 999 copies of one card, which looks like a typo; fix the Count in the file and import it again/);

		await save.click();
		await page.waitForSelector('.status .big');
		assert.match(await page.locator('.status .big').textContent(), /^Saved\. 1 added/);
		assert.equal(liveCount(await localDoc(page)), 1);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('leaving the screen while it saves keeps the import', async () => {
		const {context, errors, page} = await device(null, 'phone');

		await fakeImportCatalog(context);
		await pickFile(page);
		await page.locator('#import-large input').check();

		// Save, then leave for My Cards straight away, before "Saved" shows.
		await page.locator('button.primary.wide').click();
		await page.evaluate(() => {
			const link = document.createElement('a');

			link.href = '/pokemon-card-tracker/cards';
			link.dataset.link = 'cards';
			document.body.append(link);
			link.click();
		});
		await page.waitForFunction(() => /^61 copies/.test((document.getElementById('cards-summary') || {}).textContent || ''), null, {timeout: 15000});
		await page.reload();
		await page.waitForFunction(() => /^61 copies/.test((document.getElementById('cards-summary') || {}).textContent || ''));
		assert.deepEqual(errors, []);
		await context.close();
	});
});

describe('deletes stick', () => {
	test('a card deleted on one phone stays deleted after an offline phone edits it', async () => {
		const fake = new FakeSupabase();
		const owner = fake.addUser('owner@example.test');
		const phone = await device(fake, 'phone');
		const laptop = await device(fake, 'laptop');

		await seedLocal(phone.page, documentWith(syntheticEntries(10, 'p')));
		await signIn(phone.page, fake, owner.email);
		await waitForStatus(phone.page, 'Synced');
		await signIn(laptop.page, fake, owner.email);
		await waitForStatus(laptop.page, 'Synced');

		const target = 'p-00003';

		await laptop.context.setOffline(true);
		await waitForStatus(laptop.page, 'Offline');
		await phone.page.evaluate(async (id) => (await import('/pokemon-card-tracker/js/collection.js')).deleteCard(id), target);
		await syncNow(phone.page);
		await waitForStatus(phone.page, 'Synced');

		// Later, the offline laptop gives the same card a note.
		await laptop.page.waitForTimeout(20);
		await laptop.page.evaluate(async (id) => (await import('/pokemon-card-tracker/js/collection.js')).updateCard(id, {notes: 'edited offline'}), target);
		await laptop.context.setOffline(false);
		await waitForStatus(laptop.page, 'Synced');
		await syncNow(phone.page);

		for (const doc of [docRow(fake, owner).doc, await localDoc(laptop.page), await localDoc(phone.page)]) {
			assert.ok(doc.cards.find((card) => card.id === target).deleted_at, 'still deleted');
			assert.equal(liveCount(doc), 9);
		}

		assert.deepEqual([...phone.errors, ...laptop.errors], []);
		await phone.context.close();
		await laptop.context.close();
	});
});

describe('profile and family', () => {
	async function familySetup() {
		const fake = new FakeSupabase();
		const owner = fake.addUser('owner@example.test');
		const kid = fake.addUser('kid@example.test');
		const ownerDevice = await device(fake, 'owner');

		await seedLocal(ownerDevice.page, documentWith(syntheticEntries(25)));
		await signIn(ownerDevice.page, fake, owner.email);
		await waitForStatus(ownerDevice.page, 'Synced');

		return {fake, kid, owner, ownerDevice};
	}

	test('Profile as owner: email, name, group, Add member, Remove', async () => {
		const {fake, ownerDevice: {context, errors, page}} = await familySetup();

		await page.click('#account');
		await page.waitForSelector('#profile-email');
		assert.equal(await page.locator('#profile-email').textContent(), 'owner@example.test');

		await page.fill('#profile-name', 'Eric');
		await page.click('button:has-text("Save name")');
		await page.waitForSelector('text=Saved. Your family sees this name.');
		assert.equal(fake.profiles.get(fake.userByEmail('owner@example.test').id).display_name, 'Eric');

		await page.waitForSelector('#add-member');
		await page.fill('#add-member-email', 'nobody@example.test');
		await page.click('button:has-text("Add member")');
		await page.waitForSelector('#add-member :text("Invite them first")');

		await page.fill('#add-member-email', 'kid@example.test');
		await page.click('button:has-text("Add member")');
		await page.waitForSelector('.member:has-text("kid@example.test")');
		await page.screenshot({fullPage: true, path: '/tmp/card-tracker-profile-owner.png'});

		page.once('dialog', (dialog) => dialog.accept());
		await page.click('.member:has-text("kid@example.test") button:has-text("Remove")');
		await page.waitForSelector('.member:has-text("kid@example.test")', {state: 'detached'});
		assert.equal(fake.members.length, 1);
		assert.equal(await page.locator('.member:has-text("owner@example.test") button').count(), 0, 'no Remove on the owner');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('Profile as member: the group shows, without Add member or Remove', async () => {
		const {fake, kid, owner, ownerDevice} = await familySetup();

		fake.members.push({group_id: fake.groups[0].id, role: 'member', user_id: kid.id});

		const {context, errors, page} = await device(fake, 'kid');

		await signIn(page, fake, kid.email);
		await waitForStatus(page, 'Synced');
		assert.equal(fake.groups.length, 1, 'the member did not make a group');
		assert.equal(fake.groups[0].owner_id, owner.id);
		await page.click('#account');
		await page.waitForSelector('.member:has-text("owner@example.test")');
		assert.equal(await page.locator('#add-member').count(), 0);
		assert.equal(await page.locator('.member button:has-text("Remove")').count(), 0);
		assert.match(await page.locator('.member:has-text("owner@example.test")').textContent(), /Owner/);
		await page.screenshot({fullPage: true, path: '/tmp/card-tracker-profile-member.png'});
		assert.deepEqual(errors, []);
		await context.close();
		await ownerDevice.context.close();
	});

	test('a member views the owner\'s cards read only, and their own stay theirs', async () => {
		const {fake, kid, owner, ownerDevice} = await familySetup();

		fake.members.push({group_id: fake.groups[0].id, role: 'member', user_id: kid.id});
		fake.profiles.set(owner.id, {display_name: 'Eric', user_id: owner.id});

		const {context, errors, page} = await device(fake, 'kid');

		await seedLocal(page, documentWith(syntheticEntries(3, 'k')));
		await signIn(page, fake, kid.email);
		await waitForStatus(page, 'Synced');
		// The header's Mine switcher lists the family; picking one opens
		// their cards view only.
		await page.waitForSelector('#owner-switch:not([hidden])');
		assert.equal(await page.locator('#owner-switch').textContent(), 'Mine');
		await page.click('#owner-switch');
		await page.click(`#owner-sheet .owner-option[data-member="${owner.id}"]`);
		await page.waitForSelector('.view-only');
		assert.equal(new URL(page.url()).pathname, `${BASE}family/${owner.id}`);
		assert.match(await page.locator('.view-only').textContent(), /Eric's cards, view only/);
		assert.equal(await page.locator('.view-head h2').textContent(), 'Eric\'s cards');
		await page.waitForFunction(() => /^25 copies/.test((document.getElementById('cards-summary') || {}).textContent || ''));
		assert.equal(await page.locator('.actions').count(), 0, 'no Import or Export in the view');
		await page.screenshot({path: '/tmp/card-tracker-family-view.png'});

		// The kid's own document is untouched by viewing.
		assert.equal(liveCount(await localDoc(page)), 3);

		assert.equal(await page.locator('#owner-switch').textContent(), 'Eric\'s');
		await page.click('#family-done');
		await page.waitForFunction(() => /^3 copies/.test((document.getElementById('cards-summary') || {}).textContent || ''));
		assert.equal(await page.locator('.view-only').count(), 0);
		assert.equal(liveCount(docRow(fake, owner).doc), 25, 'the owner\'s row is unchanged');
		assert.deepEqual(errors, []);
		await context.close();
		await ownerDevice.context.close();
	});
});

describe('the app shell', () => {
	test('existing views still open: My Cards, Sets, a set, a card, Import, Phone check', async () => {
		// The real TCGdex API, and no Supabase at all.
		const {context, errors, page} = await device(null, 'phone', {tcgdex: 'real'});
		const noScriptErrors = async (where) => {
			const shown = await page.locator('#errors .error').allTextContents();

			assert.deepEqual(shown, [], `errors on ${where}`);
		};

		await seedLocal(page, documentWith([{card_id: 'base1-4', catalog: 'international', created_at: '2026-09-01T00:00:00.000Z', deleted_at: null, id: 'x1', language: 'en', language_source: 'manual', updated_at: '2026-09-01T00:00:00.000Z'}]));
		await page.waitForSelector('.tile');
		await noScriptErrors('My Cards');

		await page.click('.tabs a[data-tab="sets"]');
		await page.waitForSelector('.set-tile:not(.skeleton)', {timeout: 30000});
		await noScriptErrors('Sets');

		await page.goto(url('sets/en/base1'));
		await page.waitForSelector('.card-grid .tile', {timeout: 30000});
		await noScriptErrors('set detail');

		await page.goto(url('cards/en/base1-4'));
		await page.waitForSelector('.card-detail h2', {timeout: 30000});
		await noScriptErrors('card detail');

		await page.goto(url('import'));
		await page.waitForSelector('label[for="monprice-file"]');
		await noScriptErrors('Import');

		await page.goto(url('check'));
		await page.waitForSelector('h2');
		await noScriptErrors('Phone check');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a deep link goes through 404.html, and the service worker precaches the new files', async () => {
		// Profile signed out shows the sign-in panel, which asks the project
		// whether Google sign-in is on, so the fake answers.
		const {context, errors, page} = await device(new FakeSupabase(), 'phone', {serviceWorkers: 'allow'});
		const first = await page.goto(url('profile'));

		assert.equal(first.status(), 404, 'GitHub Pages answers an app path with 404.html');
		await page.waitForSelector('h2:has-text("Profile")');
		assert.equal(new URL(page.url()).pathname, `${BASE}profile`);
		assert.equal(new URL(page.url()).search, '');

		await page.evaluate(() => navigator.serviceWorker.ready);

		// The cache is named after sw.js's VERSION, so a version bump needs no
		// change here.
		const version = /const VERSION = '([^']+)';/.exec(await readFile(new URL('../sw.js', import.meta.url), 'utf8'))[1];
		const cached = await page.evaluate(async (name) => {
			const cache = await caches.open(name);

			return (await cache.keys()).map((request) => new URL(request.url).pathname);
		}, `card-tracker-shell-${version}`);

		for (const file of ['vendor/supabase-js.js', 'js/sync.js', 'js/auth.js', 'js/merge.js', 'js/account-views.js', 'js/shell.js', 'js/tile.js', 'js/card-swipe.js', 'js/scan/routes.js', 'js/scan/view.js', 'lab/vendor/tesseract/tesseract.esm.min.js', 'js/photos/index.js', 'css/scan.css', 'css/photos.css', 'vendor/fonts/poppins-latin-400-normal.woff2']) {
			assert.ok(cached.includes(`${BASE}${file}`), `${file} is precached`);
		}

		assert.deepEqual(errors, []);
		await context.close();
	});
});
