// Browser tests for publishing the Shop to the HOTARU catalog (js/shop-view.js
// and js/store-publish.js, plans/hotaru-catalog-plan.md step 2): signed out
// nothing is sent; signed in as the family's owner, a price saved publishes
// the card's spares (never the copy kept), with the name in their language
// and the picture copied once; a cleared price withdraws them, but never a
// reserved one. Headless Chromium against tests/pages-server.mjs.
//
// Supabase is tests/fake-supabase.mjs; store_sync, the store bucket, and the
// tcgdex-image relay are answered here, following supabase/store.sql (whose
// rules are tested against Postgres by hand, see the plan). The copies are
// tests/trade-harness.mjs's invented ones, held on the fake server, so the
// phone also shows the wait for the first sync.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/shop-publish-browser.test.mjs
// Screenshots: /tmp/shop-publish-*.png, or under SHOTS when set.

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {FakeSupabase} from './fake-supabase.mjs';
import {BASE, documentWith, fakeServices, indexRecords, seed} from './my-cards-fixtures.mjs';
import {startPagesServer} from './pages-server.mjs';
import {SPARE_COPIES} from './trade-harness.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const SHOTS = process.env.SHOTS || '/tmp';
const TIMEOUT = {timeout: 20000};
const CHARMANDER_EN = '#shop-international-tsa1-004-en';
const PICTURE = 'https://assets.tcgdex.net/en/tsa/tsa1/004';

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

const plain = (text) => String(text).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

// The catalog as store_sync keeps it (supabase/store.sql), and what reached
// the bucket and the relay.
function fakeStore() {
	const listings = new Map();
	const uploads = [];
	const relayed = [];
	let calls = 0;

	return {
		calls: () => calls,
		listings,
		relayed,
		sync(rows) {
			calls++;

			const ids = new Set(rows.map((row) => row.id));

			for (const row of rows) {
				const old = listings.get(row.id);

				if (old && !['available', 'withdrawn'].includes(old.status)) {
					continue;
				}

				listings.set(row.id, {...row, image_path: row.image_path ?? (old ? old.image_path : null), status: 'available'});
			}

			for (const [id, row] of listings) {
				if (row.status === 'available' && !ids.has(id)) {
					row.status = 'withdrawn';
				}
			}

			return Object.fromEntries([...ids].map((id) => [id, {image_path: listings.get(id).image_path, status: listings.get(id).status}]));
		},
		uploads,
	};
}

async function attachStore(page, store, {owner = true} = {}) {
	await page.route('**/rest/v1/rpc/store_sync', async (route) => {
		const {listings} = route.request().postDataJSON();

		if (!owner) {
			return route.fulfill({body: JSON.stringify({code: '42501', details: null, hint: null, message: 'Only the shop owner can publish.'}), contentType: 'application/json', status: 403});
		}

		return route.fulfill({body: JSON.stringify(store.sync(listings)), contentType: 'application/json', status: 200});
	});
	await page.route('**/storage/v1/object/store/**', (route) => {
		store.uploads.push(decodeURIComponent(new URL(route.request().url()).pathname.split('/object/store/')[1]));

		return route.fulfill({body: JSON.stringify({Key: 'store/x'}), contentType: 'application/json', status: 200});
	});
	await page.route('**/functions/v1/tcgdex-image?**', (route) => {
		store.relayed.push(new URL(route.request().url()).searchParams.get('path'));

		return route.fulfill({body: Buffer.from('RIFF0000WEBPVP8 '), contentType: 'image/webp', status: 200});
	});
}

// The index, with a picture for Charmander only.
function indexWithPicture() {
	const index = indexRecords();
	const charmander = Object.values(index).find((record) => record.id === 'tsa1-004');

	charmander.localizations.en.image = PICTURE;

	return index;
}

// A phone signed in as the family's owner, whose copies are on the server.
async function ownerPhone({owner = true} = {}) {
	const fake = new FakeSupabase();
	const user = fake.addUser('owner@example.test');
	const context = await browser.newContext({serviceWorkers: 'block', viewport: {height: 844, width: 390}});

	await fakeServices(context);
	await fakePokeApi(context);
	await fake.attach(context, 'owner');
	fake.documents.set(user.id, {
		doc: {...documentWith(SPARE_COPIES), person: undefined, user_id: undefined},
		updated_at: fake.now(),
		user_id: user.id,
	});

	const page = await context.newPage();
	const errors = [];
	const store = fakeStore();

	page.on('pageerror', (err) => errors.push(err.message));
	await attachStore(page, store, {owner});
	await seed(page, server.origin, {binders: [], copies: [], index: indexWithPicture()});
	await page.goto(`${server.origin}${BASE}signin`);
	await page.fill('#signin-email', user.email);
	await page.click('button:has-text("Send link")');
	await page.waitForSelector('#check-email');
	await page.goto(`${server.origin}${BASE}?code=${fake.issueCode(user.email)}`);
	await page.waitForSelector('#account.avatar');
	await page.waitForFunction(() => {
		const line = document.getElementById('sync-status');

		return line && !line.hidden && line.textContent === 'Synced';
	}, null, TIMEOUT);

	return {context, errors, page, store};
}

async function openShop(page) {
	await page.goto(`${server.origin}${BASE}shop`);
	await page.locator('.shop-row').first().waitFor(TIMEOUT);
	await page.click('#shop-filter input[value="all"] + span');
}

const publishLine = async (page) => plain(await page.locator('#shop-publish').textContent());

const waitLine = (page, pattern) => page.waitForFunction((source) => new RegExp(source).test(document.querySelector('#shop-publish').textContent.replace(/\s+/g, ' ')), pattern.source, TIMEOUT);

describe('Shop publishing', () => {
	test('signed out, nothing is sent and the screen says why', async () => {
		const context = await browser.newContext({serviceWorkers: 'block', viewport: {height: 844, width: 390}});

		await fakeServices(context);
		await fakePokeApi(context);

		const page = await context.newPage();
		const store = fakeStore();

		await attachStore(page, store);
		await seed(page, server.origin, {binders: [], copies: SPARE_COPIES});
		await openShop(page);
		await waitLine(page, /^Sign in to publish/);
		assert.equal(store.calls(), 0);
		await context.close();
	});

	test('a saved price publishes the spares, with the picture copied once, and a cleared one withdraws them but keeps a reserved copy', async () => {
		const {context, errors, page, store} = await ownerPhone();

		await openShop(page);
		await waitLine(page, /^Nothing on HOTARU yet/);
		assert.equal(store.listings.size, 0);

		await page.fill(`${CHARMANDER_EN} .shop-price-input`, '2,30');
		await page.click(`${CHARMANDER_EN} .shop-save`);
		await waitLine(page, /^On HOTARU: 1 card, 2 spares\.$/);

		// Charmander EN has three copies; the first added is kept.
		const rows = [...store.listings.values()].sort((a, b) => a.id.localeCompare(b.id));

		assert.deepEqual(rows.map((row) => [row.id, row.status, row.price_brl, row.language, row.name]), [
			['c-03', 'available', 2.3, 'en', 'Charmander'],
			['c-04', 'available', 2.3, 'en', 'Charmander'],
		]);
		assert.deepEqual(rows.map((row) => row.condition), ['Played', 'Near Mint']);
		assert.deepEqual(rows.map((row) => row.image_path), ['tcgdex/en/tsa/tsa1/004.webp', 'tcgdex/en/tsa/tsa1/004.webp']);
		assert.deepEqual(store.uploads, ['tcgdex/en/tsa/tsa1/004.webp'], 'one picture per card');
		assert.deepEqual(store.relayed, ['en/tsa/tsa1/004/high.webp']);
		assert.equal(plain(await page.locator(`${CHARMANDER_EN} .shop-mark`).textContent()), 'On HOTARU');
		await page.screenshot({fullPage: true, path: `${SHOTS}/shop-publish-on.png`});

		// An order holds c-03 (step 5); the next visit shows it and sends no
		// new picture.
		store.listings.get('c-03').status = 'reserved';
		await openShop(page);
		await page.locator(`${CHARMANDER_EN} .shop-mark`).waitFor(TIMEOUT);
		assert.equal(plain(await page.locator(`${CHARMANDER_EN} .shop-mark`).textContent()), 'Reserved by an order');
		assert.equal(store.uploads.length, 1);

		// Clearing the price withdraws the free copy only.
		await page.click(`${CHARMANDER_EN} .shop-clear`);
		await waitLine(page, /^Nothing on HOTARU yet/);
		assert.equal(store.listings.get('c-03').status, 'reserved');
		assert.equal(store.listings.get('c-04').status, 'withdrawn');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a signed-in member who is not the shop owner is told so', async () => {
		const {context, errors, page, store} = await ownerPhone({owner: false});

		await openShop(page);
		await waitLine(page, /^Only the shop owner can publish to HOTARU\.$/);
		assert.equal(store.listings.size, 0);
		assert.deepEqual(errors, []);
		await context.close();
	});
});
