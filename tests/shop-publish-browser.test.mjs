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
async function ownerPhone({index = indexWithPicture(), owner = true} = {}) {
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
		await waitLine(page, /^On HOTARU: 1 card, 1 copy\.$/);
		assert.deepEqual([...store.listings.values()].map((row) => [row.id, row.image_path]), [['c-04', 'tcgdex/en/tsa/tsa1/004.webp']]);
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
		await waitLine(page, /^On HOTARU: 2 cards, 2 copies\.$/);

		// The star: the priced copies are asked for, the two listed ones go.
		await page.goto(`${server.origin}${BASE}cards/en/tsa1-004`);
		await page.locator('#favorite-toggle[aria-pressed="false"]').waitFor(TIMEOUT);
		await page.click('#favorite-toggle');
		await page.waitForFunction(() => [...document.querySelectorAll('.toast-text')].some((node) => /taken off HOTARU/.test(node.textContent)), null, TIMEOUT);
		assert.equal(plain(await page.locator('.toast-text', {hasText: 'HOTARU'}).last().textContent()), 'Starred and taken off HOTARU (2 copies).');
		assert.deepEqual(asked, [['c-02', 'c-03', 'c-04']], 'the Charmander EN copies, which carry the sale price; PT has none');
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

	test('a signed-in member who is not the shop owner is told so', async () => {
		const {context, errors, page, store} = await ownerPhone({owner: false});

		await openShop(page);
		await waitLine(page, /^Only the shop owner can publish to HOTARU\.$/);
		assert.equal(store.listings.size, 0);
		assert.deepEqual(errors, []);
		await context.close();
	});
});
