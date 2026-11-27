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
import {copy, SPARE_COPIES} from './trade-harness.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const SHOTS = process.env.SHOTS || '/tmp';
const TIMEOUT = {timeout: 20000};
const CHARMANDER_EN = '#shop-international-tsa1-004-en';
const CHARMANDER_EN_REVERSE = '#shop-international-tsa1-004-en-raw-Reverse-Holofoil';
const CHARIZARD = '#shop-international-tsa1-006-en';
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
	// Copy ids the server's listing invariant refuses (supabase/
	// store-hardening.sql), each with its reason.
	const refuse = new Map();
	// Open orders (store_orders_open), and whether reading them or the
	// catalog fails; the relist flag of each store_sync call.
	const orders = [];
	const fail = {catalog: false, orders: false};
	const relists = [];

	return {
		calls: () => calls,
		fail,
		listings,
		orders,
		refuse,
		relayed,
		relists,
		sync(all, relist = false) {
			calls++;
			relists.push(relist);

			const skipped = all.filter((row) => refuse.has(row.id)).map((row) => ({id: row.id, reason: refuse.get(row.id)}));
			const rows = all.filter((row) => !refuse.has(row.id));

			const ids = new Set(rows.map((row) => row.id));

			for (const row of rows) {
				const old = listings.get(row.id);

				if (old && !(old.status === 'available' || (old.status === 'withdrawn' && relist))) {
					continue;
				}

				listings.set(row.id, {...row, image_path: row.image_path ?? (old ? old.image_path : null), status: 'available'});
			}

			for (const [id, row] of listings) {
				if (row.status === 'available' && !ids.has(id)) {
					row.status = 'withdrawn';
				}
			}

			const answer = Object.fromEntries([...ids].map((id) => [id, {image_path: listings.get(id).image_path, status: listings.get(id).status}]));

			return skipped.length ? {...answer, _skipped: skipped} : answer;
		},
		uploads,
	};
}

async function attachStore(page, store, {owner = true} = {}) {
	await page.route('**/rest/v1/rpc/store_sync', async (route) => {
		const {listings, relist} = route.request().postDataJSON();

		if (!owner) {
			return route.fulfill({body: JSON.stringify({code: '42501', details: null, hint: null, message: 'Only the shop owner can publish.'}), contentType: 'application/json', status: 403});
		}

		return route.fulfill({body: JSON.stringify(store.sync(listings, relist)), contentType: 'application/json', status: 200});
	});
	// store_orders_open and store_catalog (the live singles), which every
	// publish reads (v128 review H1 and M1).
	await page.route(/\/rest\/v1\/rpc\/store_orders_open$/, (route) => (store.fail.orders
		? route.fulfill({body: JSON.stringify({code: '57014', details: null, hint: null, message: 'timeout'}), contentType: 'application/json', status: 500})
		: route.fulfill({body: JSON.stringify(store.orders), contentType: 'application/json', status: 200})));
	await page.route(/\/rest\/v1\/rpc\/store_catalog$/, (route) => (store.fail.catalog
		? route.fulfill({body: JSON.stringify({code: '57014', details: null, hint: null, message: 'timeout'}), contentType: 'application/json', status: 500})
		: route.fulfill({body: JSON.stringify([...store.listings.values()].filter((row) => row.status === 'available').map((row) => ({kind: 'single', ...row}))), contentType: 'application/json', status: 200})));
	// listing_status (supabase/store-orders.sql): what the Shop reads to tell
	// a live copy from a new one.
	await page.route('**/rest/v1/rpc/listing_status', async (route) => {
		const {ids} = route.request().postDataJSON();
		const status = (id) => {
			const row = store.listings.get(id);

			return row && ['available', 'reserved'].includes(row.status) ? row.status : 'gone';
		};

		return route.fulfill({body: JSON.stringify(Object.fromEntries(ids.map((id) => [id, status(id)]))), contentType: 'application/json', status: 200});
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
async function ownerPhone({binders = [], copies = SPARE_COPIES, index = indexWithPicture(), owner = true} = {}) {
	const fake = new FakeSupabase();
	const user = fake.addUser('owner@example.test');
	const context = await browser.newContext({serviceWorkers: 'block', viewport: {height: 844, width: 390}});

	await fakeServices(context);
	await fakePokeApi(context);
	await fake.attach(context, 'owner');
	fake.documents.set(user.id, {
		doc: {...documentWith(copies, binders), person: undefined, user_id: undefined},
		updated_at: fake.now(),
		user_id: user.id,
	});

	const page = await context.newPage();
	const errors = [];
	const store = fakeStore();

	page.on('pageerror', (err) => errors.push(err.message));
	await attachStore(page, store, {owner});
	await seed(page, server.origin, {binders: [], copies: [], index});
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

// Publish changes, the only way a new copy goes on HOTARU (Eric,
// 2026-11-26).
async function publishNew(page) {
	await page.locator('#shop-publish-changes:not([hidden])').waitFor(TIMEOUT);
	await page.click('#shop-publish-changes');
}

const publishLine = async (page) => plain(await page.locator('#shop-publish').textContent());

const waitLine = (page, pattern) => page.waitForFunction((source) => new RegExp(source).test(document.querySelector('#shop-publish').textContent.replace(/\s+/g, ' ')), pattern.source, TIMEOUT);

describe('Shop publishing', () => {
	test('a card saved before TCGdex had its picture gets it on the next visit, and the listing with it', async () => {
		// The index holds Charmander with no picture, as a record saved while
		// a new set had none; TCGdex's set list has it now.
		const {context, errors, page, store} = await ownerPhone({index: indexRecords()});

		await page.route('**/v2/en/sets/tsa1', (route) => route.fulfill({
			body: JSON.stringify({cards: [{id: 'tsa1-004', image: PICTURE, localId: '004', name: 'Charmander'}], id: 'tsa1', name: 'Test Set A'}),
			contentType: 'application/json',
			status: 200,
		}));
		await openShop(page);
		await page.fill(`${CHARMANDER_EN} .shop-price-input`, '2,30');
		await page.click('#shop-save-all');
		await publishNew(page);
		await waitLine(page, /^On HOTARU: 1 card, 1 copy\.$/);
		assert.deepEqual([...store.listings.values()].map((row) => [row.id, row.image_path]), [['c-04', 'tcgdex/en/tsa/tsa1/004.webp']]);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a copy the server refuses (the listing invariant) is not listed and is named on the publish line', async () => {
		const copies = [...SPARE_COPIES, copy('c-16', 'tsa1-004', {condition: 'Near Mint'})];
		const {context, errors, page, store} = await ownerPhone({copies});

		store.refuse.set('c-16', 'held');
		await openShop(page);
		await page.fill(`${CHARMANDER_EN} .shop-price-input`, '2,30');
		await page.click('#shop-save-all');
		await publishNew(page);
		await waitLine(page, /Staying home \(1\): Charmander[^:]*: in a binder pocket\.$/);
		assert.equal(store.listings.has('c-16'), false);
		assert.equal(store.listings.get('c-04').status, 'available');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a copy listed after its card already has a picture on HOTARU gets the same picture, with no upload (v111 live bug)', async () => {
		// c-04 went out pictured before; c-16, a second Normal spare of the
		// same card, is new and must not go out bare.
		const copies = [...SPARE_COPIES, copy('c-16', 'tsa1-004', {condition: 'Near Mint'})];
		const {context, errors, page, store} = await ownerPhone({copies});

		store.listings.set('c-04', {id: 'c-04', image_path: 'tcgdex/en/tsa/tsa1/004.webp', price_brl: 2.3, status: 'available'});
		await openShop(page);
		await page.fill(`${CHARMANDER_EN} .shop-price-input`, '2,30');
		await page.click('#shop-save-all');
		await publishNew(page);
		await waitLine(page, /^On HOTARU: 1 card, 2 copies\.$/);
		assert.equal(store.listings.get('c-16').image_path, 'tcgdex/en/tsa/tsa1/004.webp');
		assert.equal(store.listings.get('c-04').image_path, 'tcgdex/en/tsa/tsa1/004.webp');
		assert.deepEqual(store.uploads, [], 'the picture is already in the bucket');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a price saved before the picture refresh lands still publishes the picture once it does', async () => {
		const {context, errors, page, store} = await ownerPhone({index: indexRecords()});
		let release;
		const held = new Promise((resolve) => {
			release = resolve;
		});

		await page.route('**/v2/en/sets/tsa1', async (route) => {
			await held;
			await route.fulfill({
				body: JSON.stringify({cards: [{id: 'tsa1-004', image: PICTURE, localId: '004', name: 'Charmander'}], id: 'tsa1', name: 'Test Set A'}),
				contentType: 'application/json',
				status: 200,
			});
		});
		await openShop(page);
		await page.fill(`${CHARMANDER_EN} .shop-price-input`, '2,30');
		await page.click('#shop-save-all');
		await publishNew(page);
		await page.waitForFunction(() => /no picture yet|On HOTARU/.test(document.querySelector('#shop-publish').textContent), null, TIMEOUT);
		release();
		await page.waitForFunction(() => /^On HOTARU: 1 card, 1 copy\.$/.test(document.querySelector('#shop-publish').textContent.replace(/\s+/g, ' ').trim()), null, TIMEOUT);
		assert.equal(store.listings.get('c-04').image_path, 'tcgdex/en/tsa/tsa1/004.webp');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a price typed while the Shop redraws its list as it opens is kept, keys and all', async () => {
		// The set list is held until typing has begun, so the picture
		// refresh, its reload, and the list drawn again land mid-typing, as
		// when Eric types the moment the Shop opens.
		const {context, errors, page} = await ownerPhone({index: indexRecords()});
		let release;
		const held = new Promise((resolve) => {
			release = resolve;
		});
		let asked = false;

		await page.route('**/v2/en/sets/tsa1', async (route) => {
			asked = true;
			await held;
			await route.fulfill({
				body: JSON.stringify({cards: [{id: 'tsa1-004', image: PICTURE, localId: '004', name: 'Charmander'}], id: 'tsa1', name: 'Test Set A'}),
				contentType: 'application/json',
				status: 200,
			});
		});
		await openShop(page);

		const field = `${CHARMANDER_EN} .shop-price-input`;

		await page.click(field);
		await page.keyboard.type('2');
		await page.waitForFunction(() => document.querySelector('#shop-save-all').textContent === 'Save 1 price');
		assert.ok(asked, 'the refresh is under way');
		release();
		// The row drawn again shows the picture; the field keeps the focus.
		await page.locator(`${CHARMANDER_EN} img.shop-art[src*="tsa1/004"]`).waitFor(TIMEOUT);
		assert.equal(await page.evaluate(() => document.activeElement.closest('.shop-row') && document.activeElement.closest('.shop-row').id), 'shop-international-tsa1-004-en');
		await page.keyboard.type(',30');
		assert.equal(await page.locator(field).inputValue(), '2,30');
		assert.equal(plain(await page.locator('#shop-save-all').textContent()), 'Save 1 price');
		await page.click('#shop-save-all');
		await page.locator('#shop-savebar').waitFor({state: 'hidden', ...TIMEOUT});
		assert.match(plain(await page.locator(`${CHARMANDER_EN} .shop-state`).textContent()), /^For sale at R\$ 2,30 each$/);
		assert.deepEqual(errors, []);
		await context.close();
	});

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

	test('each finish publishes its spares at its own price, with the picture copied once, and a cleared one withdraws them but keeps a reserved copy', async () => {
		const {context, errors, page, store} = await ownerPhone();

		await openShop(page);
		await waitLine(page, /^Nothing on HOTARU yet/);
		assert.equal(store.listings.size, 0);

		// Charmander EN has three copies; the first added is kept. Of its two
		// spares, c-03 is a Reverse holo and c-04 has no finish set, so each
		// is a row with its own price (Eric, 2026-11-24).
		assert.equal(plain(await page.locator(`${CHARMANDER_EN_REVERSE} .shop-finish`).textContent()), 'Reverse Holofoil');
		await page.fill(`${CHARMANDER_EN} .shop-price-input`, '2,30');
		await page.fill(`${CHARMANDER_EN_REVERSE} .shop-price-input`, '6');
		await page.click('#shop-save-all');
		await publishNew(page);
		await waitLine(page, /^On HOTARU: 2 cards, 2 copies\.$/);

		const rows = [...store.listings.values()].sort((a, b) => a.id.localeCompare(b.id));

		assert.deepEqual(rows.map((row) => [row.id, row.status, row.price_brl, row.language, row.name, row.finish]), [
			['c-03', 'available', 6, 'en', 'Charmander', 'Reverse Holofoil'],
			['c-04', 'available', 2.3, 'en', 'Charmander', 'Normal'],
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
		await page.locator(`${CHARMANDER_EN_REVERSE} .shop-mark`).waitFor(TIMEOUT);
		assert.equal(plain(await page.locator(`${CHARMANDER_EN_REVERSE} .shop-mark`).textContent()), 'Reserved by an order');
		assert.equal(plain(await page.locator(`${CHARMANDER_EN} .shop-mark`).textContent()), 'On HOTARU', 'the other finish is not held');
		assert.equal(store.uploads.length, 1);

		// Clearing the reverse's price withdraws nothing of the other finish,
		// and keeps the reserved copy; clearing the other withdraws it.
		await page.click(`${CHARMANDER_EN_REVERSE} .shop-clear`);
		await page.click('#shop-save-all');
		await waitLine(page, /^On HOTARU: 1 card, 1 copy\.$/);
		assert.equal(store.listings.get('c-03').status, 'reserved');
		assert.equal(store.listings.get('c-04').status, 'available');
		await page.click(`${CHARMANDER_EN} .shop-clear`);
		await page.click('#shop-save-all');
		await waitLine(page, /^Nothing on HOTARU yet/);
		assert.equal(store.listings.get('c-03').status, 'reserved');
		assert.equal(store.listings.get('c-04').status, 'withdrawn');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('For sale on the card page lists a last copy, tags its tile, and taking it off withdraws it at once (plans/hotaru-for-sale-plan.md)', async () => {
		const {context, errors, page, store} = await ownerPhone();
		const asked = [];
		const BULBASAUR = '#shop-international-tsa1-001-en';
		const toastWith = (text) => page.waitForFunction((want) => [...document.querySelectorAll('.toast-text')].some((node) => node.textContent.includes(want)), text, TIMEOUT);

		await page.route('**/rest/v1/rpc/store_withdraw', async (route) => {
			const {ids} = route.request().postDataJSON();
			const gone = ids.filter((id) => store.listings.has(id) && store.listings.get(id).status === 'available').sort();

			asked.push([...ids].sort());

			for (const id of gone) {
				store.listings.get(id).status = 'withdrawn';
			}

			return route.fulfill({body: JSON.stringify(gone), contentType: 'application/json', status: 200});
		});
		// The owner is known before the card page draws its copies.
		await page.locator('#shop-link:not([hidden])').waitFor(TIMEOUT);

		// Bulbasaur is one copy, never a spare: For sale puts it in the Shop.
		await page.goto(`${server.origin}${BASE}cards/en/tsa1-001`);
		await page.locator('.copy-row').first().click();
		await page.locator('#copy-for-sale').waitFor(TIMEOUT);
		assert.equal(await page.isChecked('#copy-for-sale'), false);
		await page.check('#copy-for-sale');
		assert.equal(plain(await page.locator('#copy-for-sale-hint').textContent()), 'Not on HOTARU until this finish has a price in the Shop.');
		await page.screenshot({path: `${SHOTS}/shop-for-sale-sheet.png`});
		await page.click('#copy-save');
		await toastWith('It goes on HOTARU when you tap Publish changes in the Shop.');

		await openShop(page);
		await page.locator(BULBASAUR).waitFor(TIMEOUT);
		assert.match(plain(await page.locator(`${BULBASAUR} .shop-meta`).textContent()), /1 copy for sale$/);
		await page.fill(`${BULBASAUR} .shop-price-input`, '4');
		await page.click('#shop-save-all');
		await publishNew(page);
		// Bulbasaur has no picture in this index, which the line says too.
		await waitLine(page, /^On HOTARU: 1 card, 1 copy\./);
		assert.equal(store.listings.get('c-01').status, 'available');

		// My Cards tags the copy on HOTARU, and only it.
		await page.goto(`${server.origin}${BASE}cards`);
		await page.locator('a.tile[href$="/tsa1-001"] .tile-for-sale').waitFor(TIMEOUT);
		assert.match(plain(await page.locator('a.tile[href$="/tsa1-001"] .tile-for-sale').textContent()), /^R\$ [0-9,]+ on sale$/, 'the pill names the shop price (design review F9)');
		assert.equal(await page.locator('a.tile[href$="/tsa1-004"] .tile-for-sale').count(), 0, 'Charmander has no price');
		await page.screenshot({path: `${SHOTS}/shop-for-sale-tile.png`});

		// Taking it off keeps it, and it leaves HOTARU at once, with the kit
		// that holds it (v114: the hint names the kit).
		await page.route('**/rest/v1/rpc/store_bundles_admin', (route) => route.fulfill({body: JSON.stringify([
			{active: true, items: [{listing_id: 'c-01'}, {listing_id: 'c-07'}], name: 'Duo'},
			{active: false, items: [{listing_id: 'c-01'}], name: 'Off kit'},
		]), contentType: 'application/json', status: 200}));
		await page.goto(`${server.origin}${BASE}cards/en/tsa1-001`);
		await page.locator('.copy-row').first().click();
		await page.locator('#copy-for-sale').waitFor(TIMEOUT);
		assert.equal(await page.isChecked('#copy-for-sale'), true);
		await page.waitForFunction(() => /In kit Duo/.test(document.getElementById('copy-for-sale-hint').textContent), null, TIMEOUT);
		assert.match(plain(await page.locator('#copy-for-sale-hint').textContent()), /^On HOTARU at R\$ 4,00\. .*In kit Duo: it sells alone or in the kit\.$/);
		await page.uncheck('#copy-for-sale');
		assert.equal(plain(await page.locator('#copy-for-sale-hint').textContent()), 'Kept: it comes off HOTARU when you close this, and kit Duo with it.');
		await page.click('#copy-save');
		await toastWith('Taken off HOTARU (1 copy).');
		assert.deepEqual(asked, [['c-01']]);
		assert.equal(store.listings.get('c-01').status, 'withdrawn');

		await openShop(page);
		await waitLine(page, /^Nothing on HOTARU yet/);
		assert.equal(await page.locator(BULBASAUR).count(), 0, 'kept, and not a spare: no row');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a binder pocket holding a copy on HOTARU carries a For sale badge clear of its corner badges (plans/hotaru-for-sale-plan.md, section 3)', async () => {
		const AT = '2026-11-25T00:00:00.000Z';
		const copies = [...SPARE_COPIES, copy('c-17', 'tsa1-001', {finish: 'reverse', for_sale: true, language: 'pt', sale_price: 4})];
		const binders = [{cols: 3, cover_color: '#1d2e60', created_at: AT, deleted_at: null, id: 'sale-binder', name: 'For sale', notes: '', page_count: 1, rows: 3, slots: [
			{entry_id: 'c-17', page: 1, placed_at: AT, position: 1},
			{entry_id: 'c-02', page: 1, placed_at: AT, position: 2},
		], updated_at: AT}];
		const {context, errors, page} = await ownerPhone({binders, copies});

		await page.setViewportSize({height: 800, width: 360});
		await page.locator('#shop-link:not([hidden])').waitFor(TIMEOUT);

		for (const scheme of ['light', 'dark']) {
			await page.emulateMedia({colorScheme: scheme});
			await page.goto(`${server.origin}${BASE}binders/sale-binder`);

			const pocket = page.locator('.pocket[data-position="1"]').first();
			const badge = pocket.locator('.pocket-for-sale');

			await badge.waitFor(TIMEOUT);
			assert.equal(await badge.getAttribute('aria-label'), 'For sale on HOTARU');
			assert.equal(await badge.getAttribute('title'), 'For sale on HOTARU');
			assert.equal(await badge.getAttribute('role'), 'img');
			assert.match(await pocket.getAttribute('aria-label'), /, for sale on HOTARU$/);
			assert.equal(await page.locator('.pocket[data-position="2"] .pocket-for-sale').count(), 0, 'a kept copy is not for sale');

			const boxes = await pocket.evaluate((node) => {
				const box = (el) => {
					const r = el.getBoundingClientRect();

					return {bottom: r.bottom, left: r.left, name: el.className.baseVal ?? el.className, right: r.right, top: r.top};
				};

				return {
					others: [...node.querySelectorAll('.badge, .badge-corner, .card-back-status')].filter((el) => el.getBoundingClientRect().width > 0).map(box),
					pocket: box(node),
					sale: box(node.querySelector('.pocket-for-sale')),
				};
			});

			assert.ok(boxes.others.some((one) => /badge-finish/.test(one.name)), 'the REV badge shows');
			assert.ok(boxes.others.some((one) => /badge-lang/.test(one.name)), 'the flag shows');

			for (const other of boxes.others) {
				const overlap = boxes.sale.left < other.right && other.left < boxes.sale.right && boxes.sale.top < other.bottom && other.top < boxes.sale.bottom;

				assert.ok(!overlap, `For sale overlaps ${other.name}`);
			}

			assert.ok(boxes.sale.left >= boxes.pocket.left && boxes.sale.right <= boxes.pocket.right && boxes.sale.top >= boxes.pocket.top, 'inside the pocket');
			await page.screenshot({path: `${SHOTS}/shop-for-sale-pocket-${scheme}.png`});
		}

		assert.deepEqual(errors, []);
		await context.close();
	});

	test('the Edit copy sheet shows and sets the finish\'s Shop price, which the Shop row and the listing share (plans/hotaru-for-sale-plan.md, section 3)', async () => {
		const {context, errors, page, store} = await ownerPhone();
		const toastWith = (text) => page.waitForFunction((want) => [...document.querySelectorAll('.toast-text')].some((node) => node.textContent.includes(want)), text, TIMEOUT);

		await page.locator('#shop-link:not([hidden])').waitFor(TIMEOUT);

		// Charizard EN: two plain copies, one kept, one spare, no price yet.
		await page.goto(`${server.origin}${BASE}cards/en/tsa1-006`);
		await page.locator('.copy-row').first().click();
		await page.locator('#copy-sale-price').waitFor(TIMEOUT);
		assert.equal(await page.inputValue('#copy-sale-price'), '');
		await page.fill('#copy-sale-price', '5');
		await page.click('#copy-save');
		await toastWith('saved');

		await openShop(page);
		assert.equal(await page.inputValue(`${CHARIZARD} .shop-price-input`), '5,00');
		await publishNew(page);
		await waitLine(page, /^On HOTARU: 1 card, 1 copy\./);

		const listed = [...store.listings.values()].filter((row) => row.card_id === 'tsa1-006' && row.status === 'available');

		assert.deepEqual(listed.map((row) => row.price_brl), [5], 'listingRows sends the sheet\'s price');

		// A price changed in the Shop is the one the sheet shows next.
		await page.fill(`${CHARIZARD} .shop-price-input`, '7,50');
		await page.click('#shop-save-all');
		await page.locator('#shop-savebar').waitFor({state: 'hidden', ...TIMEOUT});
		await page.goto(`${server.origin}${BASE}cards/en/tsa1-006`);
		await page.locator('.copy-row').first().click();
		await page.locator('#copy-sale-price').waitFor(TIMEOUT);
		assert.equal(await page.inputValue('#copy-sale-price'), '7,50');
		// The row holds the kept copy too, so it is ticked to offer them.
		await page.check('#copy-for-sale');
		assert.match(plain(await page.locator('#copy-for-sale-hint').textContent()), /On HOTARU at R\$ 7,50\./);

		// Emptied, the finish has no price, and the line says so.
		await page.fill('#copy-sale-price', '');
		assert.match(plain(await page.locator('#copy-for-sale-hint').textContent()), /^Not on HOTARU until this finish has a price in the Shop\./);
		await page.screenshot({path: `${SHOTS}/shop-sheet-price.png`});
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('Sell a card I own marks a copy that is not a spare, and its price puts it on HOTARU', async () => {
		const {context, errors, page, store} = await ownerPhone();
		const BULBASAUR = '#shop-international-tsa1-001-en';

		await openShop(page);
		await page.locator('#shop-sell-more:not([hidden])').waitFor(TIMEOUT);
		assert.equal(await page.locator(BULBASAUR).count(), 0, 'one copy, so not in the Shop yet');
		await page.click('#shop-sell-own');
		await page.locator('#shop-sell-sheet[open]').waitFor(TIMEOUT);
		await page.fill('#shop-sell-search', 'Bulbasaur');
		await page.waitForFunction(() => document.querySelectorAll('#shop-sell-list .shop-sell-choice').length === 1, null, TIMEOUT);
		await page.waitForTimeout(400);
		await page.screenshot({path: `${SHOTS}/shop-sell-own.png`});
		await page.click('#shop-sell-list .shop-sell-choice');
		await page.locator('#shop-sell-sheet').waitFor({state: 'detached', ...TIMEOUT});
		await page.locator(BULBASAUR).waitFor(TIMEOUT);
		assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), `${BULBASAUR.slice(1)}-price`, 'its price field, ready to type');
		await page.keyboard.type('4');
		await page.click('#shop-save-all');
		await publishNew(page);
		await waitLine(page, /^On HOTARU: 1 card, 1 copy\./);
		assert.equal(store.listings.get('c-01').status, 'available');
		assert.equal(store.listings.get('c-01').price_brl, 4);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('Add and sell ticks For sale in the next Add a copy sheet, with its price, and the copy goes on HOTARU', async () => {
		const {context, errors, page, store} = await ownerPhone();

		await openShop(page);
		await page.locator('#shop-sell-more:not([hidden])').waitFor(TIMEOUT);
		await page.click('#shop-add-sell');
		await page.waitForFunction(() => location.pathname.endsWith('/sets'), null, TIMEOUT);
		await page.waitForFunction(() => [...document.querySelectorAll('.toast-text')].some((node) => node.textContent.startsWith('Add and sell:')), null, TIMEOUT);

		// He finds the card and adds a copy.
		await page.goto(`${server.origin}${BASE}cards/en/tsa1-001`);
		await page.click('#copy-add');
		await page.locator('#copy-add-for-sale').waitFor(TIMEOUT);
		assert.equal(await page.isChecked('#copy-add-for-sale'), true);
		await page.fill('#copy-add-sale-price', '7,50');
		await page.locator('#copy-add-sale-price').scrollIntoViewIfNeeded();
		await page.waitForTimeout(400);
		await page.screenshot({path: `${SHOTS}/shop-add-and-sell.png`});
		await page.click('#copy-add-save');
		await page.waitForFunction(() => [...document.querySelectorAll('.toast-text')].some((node) => node.textContent.includes('For sale: it goes on HOTARU')), null, TIMEOUT);
		assert.equal(await page.evaluate(() => sessionStorage.getItem('cardTracker.addAndSell')), null, 'one Add and sell, one sheet');

		// The next sheet is plain again.
		await page.click('#copy-add');
		await page.locator('#copy-add-for-sale').waitFor(TIMEOUT);
		assert.equal(await page.isChecked('#copy-add-for-sale'), false);
		// Closing a sheet steps back in history (js/sheet.js): let it land
		// before leaving the page.
		await page.click('#copy-sheet .sheet-head button');
		await page.locator('#copy-sheet').waitFor({state: 'hidden', ...TIMEOUT});
		await page.waitForTimeout(300);

		await openShop(page);
		await publishNew(page);
		await waitLine(page, /^On HOTARU: 1 card, 1 copy\./);

		const rows = [...store.listings.values()].filter((row) => row.card_id === 'tsa1-001' && row.status === 'available');

		assert.equal(rows.length, 1);
		assert.notEqual(rows[0].id, 'c-01', 'the copy added, not the one he kept');
		assert.equal(rows[0].price_brl, 7.5);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('starring a card takes its listings off HOTARU at once, and says so before store-withdraw.sql is run (Eric, 2026-11-24)', async () => {
		const {context, errors, page, store} = await ownerPhone();
		const asked = [];
		let missing = false;

		// store_withdraw as supabase/store-withdraw.sql answers it: the
		// available singles among ids are withdrawn and named.
		await page.route('**/rest/v1/rpc/store_withdraw', async (route) => {
			const {ids} = route.request().postDataJSON();

			asked.push([...ids].sort());

			if (missing) {
				return route.fulfill({body: JSON.stringify({code: 'PGRST202', details: null, hint: null, message: 'Could not find the function public.store_withdraw(ids) in the schema cache'}), contentType: 'application/json', status: 404});
			}

			const gone = ids.filter((id) => store.listings.has(id) && store.listings.get(id).status === 'available').sort();

			for (const id of gone) {
				store.listings.get(id).status = 'withdrawn';
			}

			return route.fulfill({body: JSON.stringify(gone), contentType: 'application/json', status: 200});
		});

		// Its two spares are in two finishes since v109, each priced on its
		// own and counted as a card.
		await openShop(page);
		await page.fill(`${CHARMANDER_EN} .shop-price-input`, '2,30');
		await page.fill(`${CHARMANDER_EN_REVERSE} .shop-price-input`, '6');
		await page.click('#shop-save-all');
		await publishNew(page);
		await waitLine(page, /^On HOTARU: 2 cards, 2 copies\.$/);

		// The star: the priced copies are asked for, the two listed ones go,
		// and the toast names the kit one of them was in (v114).
		await page.route('**/rest/v1/rpc/store_bundles_admin', (route) => route.fulfill({body: JSON.stringify([{active: true, items: [{listing_id: 'c-03'}, {listing_id: 'c-10'}], name: 'Trio'}]), contentType: 'application/json', status: 200}));
		await page.goto(`${server.origin}${BASE}cards/en/tsa1-004`);
		await page.locator('#favorite-toggle[aria-pressed="false"]').waitFor(TIMEOUT);
		await page.click('#favorite-toggle');
		await page.waitForFunction(() => [...document.querySelectorAll('.toast-text')].some((node) => /taken off HOTARU/.test(node.textContent)), null, TIMEOUT);
		assert.equal(plain(await page.locator('.toast-text', {hasText: 'HOTARU'}).last().textContent()), 'Starred and taken off HOTARU (2 copies). Kit Trio left HOTARU too.');
		assert.deepEqual(asked, [['c-02', 'c-03', 'c-04', 'c-20']], 'the Charmander EN copies, which carry the sale price (c-20 is the reverse holo kept); PT has none');
		assert.deepEqual([...store.listings.values()].map((row) => row.status), ['withdrawn', 'withdrawn']);

		// Before the SQL is run: the Shop's next publish is the safety net.
		missing = true;
		await page.click('#favorite-toggle');
		await page.locator('#favorite-toggle[aria-pressed="false"]').waitFor(TIMEOUT);
		await page.click('#favorite-toggle');
		await page.waitForFunction(() => [...document.querySelectorAll('.toast-text')].some((node) => /next time you open the Shop/.test(node.textContent)), null, TIMEOUT);
		assert.equal(plain(await page.locator('.toast-text', {hasText: 'next time'}).last().textContent()), 'Starred. It leaves HOTARU the next time you open the Shop online.');
		assert.equal(asked.length, 2, 'taking the star off asks nothing');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a card the catalog has no picture for is listed with the owner\'s own photo', async () => {
		// No picture in the index, and TCGdex's set list has none either.
		const {context, errors, page, store} = await ownerPhone({index: indexRecords()});

		await page.route('**/v2/en/sets/tsa1', (route) => route.fulfill({
			body: JSON.stringify({cards: [{id: 'tsa1-006', localId: '006', name: 'Charizard ex'}], id: 'tsa1', name: 'Test Set A'}),
			contentType: 'application/json',
			status: 200,
		}));

		// Eric's photo of Charizard EN, saved as Add photo saves it.
		const photoId = await page.evaluate(async () => {
			const {savePhoto} = await import('/pokemon-card-tracker/js/photos/index.js');
			const canvas = new OffscreenCanvas(63, 88);
			const draw = canvas.getContext('2d');

			draw.fillStyle = '#c33';
			draw.fillRect(0, 0, 63, 88);

			const photo = await savePhoto({blob: await canvas.convertToBlob({type: 'image/webp'}), entry: {card_id: 'tsa1-006', catalog: 'international', language: 'en'}, type: 'image/webp'});

			return photo.id;
		});

		await openShop(page);
		await page.fill(`${CHARIZARD} .shop-price-input`, '150');
		await page.click('#shop-save-all');
		await publishNew(page);
		await waitLine(page, /^On HOTARU: 1 card, 1 copy\.$/);

		const path = `own/${photoId}.webp`;

		assert.deepEqual(store.uploads, [path], 'the photo is copied once, under its own id');
		assert.deepEqual([...store.listings.values()].map((row) => [row.id, row.image_path]), [['c-08', path]]);
		assert.equal(store.relayed.length, 0, 'no catalog picture is asked for');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('an own photo that cannot be read, or reads empty, is not sent to the bucket', async () => {
		const {context, errors, page, store} = await ownerPhone();

		await page.route('**/own-photo-missing.webp', (route) => route.fulfill({body: 'Not found', contentType: 'text/plain', status: 404}));
		await page.route('**/own-photo-empty.webp', (route) => route.fulfill({body: '', contentType: 'image/webp', status: 200}));
		await page.route('**/own-photo-good.webp', (route) => route.fulfill({body: Buffer.from('RIFF0000WEBPVP8 '), contentType: 'image/webp', status: 200}));

		const sent = await page.evaluate(async (origin) => {
			const {uploadOwnPicture} = await import('/pokemon-card-tracker/js/store-publish.js');
			const at = (name) => ({url: async () => `${origin}/${name}`});
			const photo = {id: 'p1', path: 'p1.webp'};

			return {
				empty: await uploadOwnPicture(photo, 'own/p1.webp', at('own-photo-empty.webp')),
				good: await uploadOwnPicture(photo, 'own/p1.webp', at('own-photo-good.webp')),
				missing: await uploadOwnPicture(photo, 'own/p1.webp', at('own-photo-missing.webp')),
			};
		}, server.origin);

		assert.deepEqual(sent, {empty: false, good: true, missing: false});
		assert.deepEqual(store.uploads, ['own/p1.webp'], 'only the photo that was read is sent');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('opening the Shop lists no new copy: withdrawn ones stay off, live ones keep their prices, and gone ones are withdrawn (Eric, 2026-11-26)', async () => {
		// Charizard EN's spare c-08 and Charmander EN's c-04 are priced, as
		// after a run of Check spares; c-08 was withdrawn before, as the 56
		// cards re-listed at 20:08 were, and c-04 is live at an old price.
		// c-99 is live but no longer in the cards.
		const copies = SPARE_COPIES.map((one) => (['c-02', 'c-04'].includes(one.id) ? {...one, sale_price: 3} : ['c-07', 'c-08'].includes(one.id) ? {...one, sale_price: 9} : one));
		const {context, errors, page, store} = await ownerPhone({copies});

		store.listings.set('c-04', {id: 'c-04', image_path: 'tcgdex/en/tsa/tsa1/004.webp', price_brl: 2, status: 'available'});
		store.listings.set('c-08', {id: 'c-08', image_path: null, price_brl: 9, status: 'withdrawn'});
		store.listings.set('c-99', {id: 'c-99', image_path: null, price_brl: 1, status: 'available'});
		await openShop(page);
		await waitLine(page, /^On HOTARU: 1 card, 1 copy\. 1 new copy to publish\. Withdrew 1 copy that should not be listed\.$/);
		assert.equal(store.listings.get('c-04').status, 'available');
		assert.equal(store.listings.get('c-04').price_brl, 3, 'a live copy\'s price syncs by itself');
		assert.equal(store.listings.get('c-08').status, 'withdrawn', 'opening the Shop re-lists nothing');
		assert.equal(store.listings.get('c-99').status, 'withdrawn', 'a copy no longer in the cards leaves');
		assert.equal(plain(await page.locator('#shop-publish-changes').textContent()), 'Publish changes: 1 new copy');
		await page.screenshot({path: `${SHOTS}/shop-publish-pending.png`});

		await page.click('#shop-publish-changes');
		await waitLine(page, /^On HOTARU: 2 cards, 2 copies\./);
		assert.equal(store.listings.get('c-08').status, 'available');
		await page.locator('#shop-publish-changes').waitFor({state: 'hidden', ...TIMEOUT});
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a publish of more than 10 new copies shows them and asks first', async () => {
		// Charizard EN with 12 more copies: 13 spares, all priced.
		const extra = Array.from({length: 12}, (_, i) => copy(`c-${30 + i}`, 'tsa1-006', {sale_price: 5}));
		const copies = [...SPARE_COPIES.map((one) => (['c-07', 'c-08'].includes(one.id) ? {...one, sale_price: 5} : one)), ...extra];
		const {context, errors, page, store} = await ownerPhone({copies});

		await openShop(page);
		await waitLine(page, /13 new copies to publish\.$/);
		await page.click('#shop-publish-changes');
		await page.locator('#shop-guard[open]').waitFor(TIMEOUT);
		assert.equal(plain(await page.locator('#shop-guard-title').textContent()), 'List 13 new copies on HOTARU?');
		// One line per card, finish, and price, with a count and a total
		// (design review F6); no stray "null", the question in view, and Not
		// now focused (design review B1).
		assert.ok(await page.locator('#shop-guard-list li').count() < 13);
		assert.match(plain(await page.locator('#shop-guard-list').textContent()), /×\d+/);
		assert.match(plain(await page.locator('#shop-guard-total').textContent()), /^13 copies · R\$/);
		assert.doesNotMatch(await page.locator('#shop-guard').textContent(), /null/);
		assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), 'shop-guard-cancel');
		assert.equal(await page.evaluate(() => document.getElementById('shop-guard').scrollTop), 0);
		await page.screenshot({path: `${SHOTS}/shop-publish-guard.png`});

		// Not now sends nothing new.
		await page.click('#shop-guard-cancel');
		await page.locator('#shop-guard').waitFor({state: 'detached', ...TIMEOUT});
		assert.equal([...store.listings.values()].filter((row) => row.status === 'available').length, 0);

		await page.click('#shop-publish-changes');
		await page.locator('#shop-guard[open]').waitFor(TIMEOUT);
		await page.click('#shop-guard-publish');
		await waitLine(page, /^On HOTARU: 1 card, 13 copies\./);
		assert.equal([...store.listings.values()].filter((row) => row.status === 'available').length, 13);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('Publish changes refuses when the open orders cannot be read, and the automatic path never revives (v128 review H1, H2)', async () => {
		const copies = SPARE_COPIES.map((one) => (['c-07', 'c-08'].includes(one.id) ? {...one, sale_price: 9} : one));
		const {context, errors, page, store} = await ownerPhone({copies});

		store.listings.set('c-08', {id: 'c-08', image_path: null, price_brl: 9, status: 'withdrawn'});
		store.fail.orders = true;
		await openShop(page);
		await waitLine(page, /^Could not read HOTARU's open orders, so nothing changed there\.$/);
		await page.click('#shop-publish-changes');
		await waitLine(page, /^Could not read HOTARU's open orders, so nothing was published\./);
		assert.equal(store.listings.get('c-08').status, 'withdrawn');
		assert.equal(store.calls(), 0, 'nothing was sent');

		store.fail.orders = false;
		await page.click('#shop-publish-changes');
		await waitLine(page, /^On HOTARU: 1 card, 1 copy\./);
		assert.equal(store.listings.get('c-08').status, 'available');
		assert.equal(store.relists.at(-1), true, 'Publish changes asks to relist');
		assert.ok(store.relists.slice(0, -1).every((one) => one === false) || store.relists.length === 1);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a copy in an open order is never kept home in its place (v128 review H1)', async () => {
		// Charizard EN c-07 and c-08 both priced; c-07, the older, is in an
		// open order, so it is not the copy kept: c-08 stays home.
		const copies = SPARE_COPIES.map((one) => (['c-07', 'c-08'].includes(one.id) ? {...one, sale_price: 9} : one));
		const {context, errors, page, store} = await ownerPhone({copies});

		store.orders.push({code: 'HTR-0001', items: [{kind: 'single', listing_id: 'c-07'}]});
		store.listings.set('c-07', {id: 'c-07', image_path: null, price_brl: 9, status: 'reserved'});
		await openShop(page);
		await page.click('#shop-publish-changes').catch(() => {});
		await page.waitForTimeout(1500);
		assert.notEqual((store.listings.get('c-08') || {}).status, 'available', 'the last loose copy stays home');
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
