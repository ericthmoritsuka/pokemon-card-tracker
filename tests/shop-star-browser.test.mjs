// Browser tests for the favorite star on each Shop Prices row (Eric,
// 2026-11-27: pull a card from sale where he prices it; js/shop-view.js
// starNode, the control and helper of js/favorite-star.js that Check spares
// uses too). Starring a row stars the card, the row's copies stop being
// offered, the listing guard withdraws the live listing at once
// (js/listing-guard.js, store_withdraw), and Undo on the toast restores the
// row. The star is on Prices rows only: Kits, Orders, and Consign have none.
// Headless Chromium at 390 x 844 against tests/pages-server.mjs, signed in as
// the family's owner on tests/fake-supabase.mjs, the copies tests/
// trade-harness.mjs's, every outside service faked.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/shop-star-browser.test.mjs
// Screenshots: /tmp/shop-star-*.png, or under SHOTS when set.

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
const CHARMANDER_EN_REVERSE = '#shop-international-tsa1-004-en-raw-Reverse-Holofoil';
const CHARIZARD = '#shop-international-tsa1-006-en';

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

// Charmander EN's Normal copies carry a price, as if saved in the Shop, so
// c-04, its spare, is free to sell and listed.
const PRICED = SPARE_COPIES.map((entry) => (['c-02', 'c-04'].includes(entry.id) ? {...entry, sale_price: 2.3} : entry));

// A phone signed in as the family's owner, with c-04 live on HOTARU. The
// store answers what the Shop and the guard read; store_withdraw takes the
// available singles it is given down, as supabase/store-withdraw.sql does.
async function ownerPhone({copies = PRICED, viewport = {height: 844, width: 390}, colorScheme = 'light'} = {}) {
	const fake = new FakeSupabase();
	const user = fake.addUser('owner@example.test');
	const context = await browser.newContext({colorScheme, serviceWorkers: 'block', viewport});

	await fakeServices(context);
	await fakePokeApi(context);
	await fake.attach(context, 'owner');
	fake.documents.set(user.id, {
		doc: {...documentWith(copies), person: undefined, user_id: undefined},
		updated_at: fake.now(),
		user_id: user.id,
	});

	const page = await context.newPage();
	const errors = [];
	const listings = new Map([['c-04', {id: 'c-04', image_path: null, price_brl: 2.3, status: 'available'}]]);
	const asked = [];
	const json = (body, status = 200) => ({body: JSON.stringify(body), contentType: 'application/json', status});

	page.on('pageerror', (err) => errors.push(err.message));
	await page.route('**/rest/v1/rpc/store_sync', (route) => {
		const {listings: sent} = route.request().postDataJSON();
		const ids = new Set(sent.map((row) => row.id));

		for (const [id, row] of listings) {
			if (row.status === 'available' && !ids.has(id)) {
				row.status = 'withdrawn';
			}
		}

		return route.fulfill(json(Object.fromEntries([...ids].map((id) => [id, {image_path: null, status: (listings.get(id) || {status: 'available'}).status}]))));
	});
	await page.route(/\/rest\/v1\/rpc\/store_orders_open$/, (route) => route.fulfill(json([])));
	await page.route(/\/rest\/v1\/rpc\/store_catalog$/, (route) => route.fulfill(json([...listings.values()].filter((row) => row.status === 'available').map((row) => ({kind: 'single', ...row})))));
	await page.route('**/rest/v1/rpc/listing_status', (route) => {
		const {ids} = route.request().postDataJSON();

		return route.fulfill(json(Object.fromEntries(ids.map((id) => [id, listings.has(id) && listings.get(id).status === 'available' ? 'available' : 'gone']))));
	});
	await page.route('**/rest/v1/rpc/store_withdraw', (route) => {
		const {ids} = route.request().postDataJSON();
		const gone = ids.filter((id) => listings.has(id) && listings.get(id).status === 'available').sort();

		asked.push([...ids].sort());

		for (const id of gone) {
			listings.get(id).status = 'withdrawn';
		}

		return route.fulfill(json(gone));
	});
	await seed(page, server.origin, {binders: [], copies: [], index: indexRecords()});
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
	// The guard reads the owner and the first document before it can tell a
	// copy leaving sale.
	await page.locator('#shop-link:not([hidden])').waitFor(TIMEOUT);

	return {asked, context, errors, listings, page};
}

async function openShop(page) {
	await page.goto(`${server.origin}${BASE}shop`);
	await page.locator('.shop-row').first().waitFor(TIMEOUT);
	await page.click('#shop-filter input[value="all"] + span');
}

// The is_favorite flag of each live copy, by ID, read from the document.
const flags = (page) => page.evaluate(async () => {
	const {listCards} = await import('/pokemon-card-tracker/js/collection.js');

	return Object.fromEntries((await listCards()).map((entry) => [entry.id, entry.is_favorite === true]));
});

const toastWith = (page, text) => page.locator('.toast', {hasText: text});

describe('Shop: the favorite star on a Prices row', () => {
	test('star a row: the card leaves the spares, the live listing is withdrawn, Undo restores it', async () => {
		const {asked, context, errors, listings, page} = await ownerPhone();

		await openShop(page);

		// The control: named for the card, 44 px at least, on every row.
		const star = page.locator(`${CHARMANDER_EN} .shop-star`);

		assert.equal(await star.getAttribute('aria-label'), 'Mark Charmander as a favorite');
		assert.equal(await star.getAttribute('aria-pressed'), 'false');
		assert.equal(await page.getByRole('button', {name: 'Mark Charmander as a favorite'}).count(), 3, 'one on each Charmander row: English Normal and Reverse holo, Portuguese Holo');
		assert.equal(await page.locator('.shop-row').count(), await page.locator('.shop-row .shop-star').count());

		const box = await star.boundingBox();

		assert.ok(box.width >= 44 && box.height >= 44, `star is ${box.width} x ${box.height}`);
		await page.screenshot({fullPage: true, path: `${SHOTS}/shop-star-row.png`});

		// Starring: every copy of the card, every language and finish.
		await star.click();
		await toastWith(page, 'Charmander is a favorite').waitFor(TIMEOUT);
		await page.locator(CHARMANDER_EN).waitFor({state: 'detached', ...TIMEOUT});
		assert.equal(await page.locator(CHARMANDER_EN_REVERSE).count(), 0, 'its other finish is no longer a spare either');
		assert.equal(await page.locator('.shop-row:has-text("Charmander")').count(), 0, 'nor is any language');
		assert.equal(await page.locator(CHARIZARD).count(), 1, 'other cards stay');
		assert.deepEqual(Object.entries(await flags(page)).filter(([, on]) => on).map(([id]) => id), ['c-02', 'c-03', 'c-04', 'c-05', 'c-06', 'c-20', 'c-21']);
		await page.screenshot({fullPage: true, path: `${SHOTS}/shop-star-starred.png`});

		// The listing guard withdraws the live copy at once.
		const start = Date.now();

		while (!asked.length && Date.now() - start < TIMEOUT.timeout) {
			await page.waitForTimeout(100);
		}

		assert.deepEqual(asked.flat(), ['c-04'], 'store_withdraw named the live copy');
		assert.equal(listings.get('c-04').status, 'withdrawn');

		// Undo puts every flag and the rows back.
		await toastWith(page, 'Charmander is a favorite').locator('button', {hasText: 'Undo'}).click();
		await page.locator(CHARMANDER_EN).waitFor(TIMEOUT);
		await page.locator(CHARMANDER_EN_REVERSE).waitFor(TIMEOUT);
		assert.equal(Object.values(await flags(page)).filter(Boolean).length, 0);
		assert.equal(await page.locator(`${CHARMANDER_EN} .shop-star`).getAttribute('aria-pressed'), 'false');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a copy marked For sale beats the star: the row stays and says so', async () => {
		const copies = PRICED.map((entry) => (entry.id === 'c-04' ? {...entry, for_sale: true} : entry));
		const {context, errors, page} = await ownerPhone({copies});

		await openShop(page);
		await page.locator(`${CHARMANDER_EN} .shop-star`).click();
		await toastWith(page, 'Copies marked For sale stay on sale').waitFor(TIMEOUT);
		await page.locator(`${CHARMANDER_EN} .shop-star[aria-pressed="true"]`).waitFor(TIMEOUT);
		assert.equal(plain(await page.locator(`${CHARMANDER_EN} .shop-state`).textContent()), 'For sale at R$ 2,30 each');
		assert.equal(await page.locator(CHARMANDER_EN_REVERSE).count(), 0, 'its unmarked finish left the spares');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('Kits, Orders, and Consign carry no star', async () => {
		const {context, errors, page} = await ownerPhone();

		await openShop(page);

		for (const tab of ['kits', 'orders', 'consign']) {
			await page.click(`#shop-tab-${tab}`);
			await page.locator(`#shop-panel-${tab}:not([hidden])`).waitFor(TIMEOUT);
			assert.equal(await page.locator(`#shop-panel-${tab} .shop-star, #shop-panel-${tab} .favorite-toggle`).count(), 0, `${tab} has no star`);
		}

		assert.deepEqual(errors, []);
		await context.close();
	});

	for (const [name, viewport] of [['phone', {height: 740, width: 360}], ['desktop', {height: 800, width: 1280}]]) {
		for (const colorScheme of ['light', 'dark']) {
			test(`the row fits at ${viewport.width} x ${viewport.height}, ${colorScheme}`, async () => {
				const {context, errors, page} = await ownerPhone({colorScheme, viewport});

				await openShop(page);
				assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');

				const row = page.locator(CHARMANDER_EN);
				const box = await row.boundingBox();
				const star = await row.locator('.shop-star').boundingBox();

				assert.ok(star.x >= box.x && star.x + star.width <= box.x + box.width, 'the star is inside its row');
				assert.ok(star.width >= 44 && star.height >= 44);
				await row.scrollIntoViewIfNeeded();
				await page.screenshot({fullPage: false, path: `${SHOTS}/shop-star-${name}-${colorScheme}.png`});
				assert.deepEqual(errors, []);
				await context.close();
			});
		}
	}
});
