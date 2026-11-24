// Browser tests for HOTARU's orders on the Shop screen (js/shop-view.js and
// js/store-orders.js, plans/hotaru-catalog-plan.md step 5): the open orders
// with their time left and receipts; Payment received, which marks the
// order paid and logs the sale, so the copies leave the spares; Delivered;
// Cancel; Log the sale for a paid order whose sale is missing, never twice;
// an order whose copy is gone from the collection; the receipt link; and
// the screen before supabase/store-orders.sql has been run. Headless
// Chromium against tests/pages-server.mjs, signed in as the family's owner.
//
// Supabase is tests/fake-supabase.mjs; the order functions, store_sync, and
// the receipt link are answered here, following supabase/store-orders.sql,
// whose rules are tested against Postgres by hand (see the plan). The copies
// are tests/trade-harness.mjs's invented ones.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/shop-orders-browser.test.mjs
// Screenshots: /tmp/shop-orders-*.png, or under SHOTS when set.

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

const hours = (n) => new Date(Date.now() + n * 3600e3).toISOString();

const item = (id, name, price) => ({condition: 'Near Mint', finish: null, language: 'en', listing_id: id, name, number: '004', price_brl: price, set_name: 'Test Alpha'});

// Three open orders: HTR-0007 waits for payment for both Charmander EN
// spares, HTR-0008 waits with a receipt for the Charizard ex spare, and
// HTR-0006 is paid, its sale (a Pikachu spare) not logged yet.
function openOrders() {
	return [
		{code: 'HTR-0006', created_at: hours(-30), id: '00000000-0000-4000-8000-000000000006', items: [item('c-10', 'Pikachu', 9)], name: 'Caio', note: null, paid_at: hours(-2), phone: '81 97777-0000', receipt_at: null, receipt_path: null, reserved_until: hours(18), status: 'paid', total: 9},
		{code: 'HTR-0007', created_at: hours(-1), id: '00000000-0000-4000-8000-000000000007', items: [item('c-03', 'Charmander', 2.5), item('c-04', 'Charmander', 2.5)], name: 'Ana', note: 'Ramal 123', paid_at: null, phone: '81 99999-0000', receipt_at: null, receipt_path: null, reserved_until: hours(47), status: 'pending', total: 5},
		{code: 'HTR-0008', created_at: hours(-0.5), id: '00000000-0000-4000-8000-000000000008', items: [item('c-08', 'Charizard ex', 150)], name: 'Bia', note: null, paid_at: null, phone: '81 98888-0000', receipt_at: hours(-0.2), receipt_path: '0c1d2e3f-4a5b-4c6d-8e7f-901234567890/abc.png', reserved_until: hours(0.5), status: 'pending', total: 150},
	];
}

// The order functions as supabase/store-orders.sql answers them.
async function attachOrders(page, {orders = openOrders(), setUp = true, owner = true} = {}) {
	const calls = [];
	const fail = (route, status, code, message) => route.fulfill({body: JSON.stringify({code, details: null, hint: null, message}), contentType: 'application/json', status});

	await page.route('**/rest/v1/rpc/store_sync', (route) => route.fulfill({body: '{}', contentType: 'application/json', status: 200}));
	await page.route(/\/rest\/v1\/rpc\/(store_orders_open|mark_paid|mark_delivered|cancel_order)$/, (route) => {
		const name = route.request().url().split('/rpc/')[1];
		const args = route.request().postDataJSON() || {};

		calls.push([name, args.order_code || null]);

		if (!setUp) {
			return fail(route, 404, 'PGRST202', `Could not find the function public.${name} without parameters in the schema cache`);
		}

		if (!owner) {
			return fail(route, 403, '42501', 'Only the shop owner can do this.');
		}

		const order = orders.find((one) => one.code === args.order_code);

		if (name === 'store_orders_open') {
			return route.fulfill({body: JSON.stringify(orders), contentType: 'application/json', status: 200});
		}

		if (name === 'mark_paid') {
			if (!order || order.status !== 'pending') {
				return fail(route, 400, '22023', `Order ${args.order_code} is expired, not waiting for payment.`);
			}

			order.status = 'paid';
		}
		else if (name === 'cancel_order' || name === 'mark_delivered') {
			orders.splice(orders.indexOf(order), 1);
		}

		return route.fulfill({body: JSON.stringify({code: args.order_code}), contentType: 'application/json', status: 200});
	});
	await page.route('**/storage/v1/object/sign/store-receipts/**', (route) => route.fulfill({body: JSON.stringify({signedURL: '/object/sign/store-receipts/receipt.png?token=t'}), contentType: 'application/json', status: 200}));

	return {calls, orders};
}

// A phone signed in as the family's owner, whose copies are on the server.
async function ownerPhone(options) {
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

	page.on('pageerror', (err) => errors.push(err.message));

	const store = await attachOrders(page, options);

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

	return {context, errors, page, store};
}

async function openShop(page) {
	await page.goto(`${server.origin}${BASE}shop`);
	await page.locator('.shop-row').first().waitFor(TIMEOUT);
	await page.click('#shop-filter input[value="all"] + span');
}

const order = (page, code) => page.locator(`#order-${code}`);

const text = async (locator) => plain(await locator.textContent());

describe('Shop orders', () => {
	test('lists the open orders with their time left, receipts, and what each needs', async () => {
		const {context, errors, page} = await ownerPhone();

		await openShop(page);
		await order(page, 'HTR-0007').waitFor(TIMEOUT);
		assert.equal(await text(page.locator('#shop-orders-title')), 'Orders (3)');
		assert.equal(await text(page.locator('#shop-orders > p').first()), '2 orders waiting for payment.');
		assert.equal(await text(order(page, 'HTR-0007').locator('.shop-order-head')), 'HTR-0007 · Ana');
		assert.match(await text(order(page, 'HTR-0007').locator('.shop-order-state')), /^Waiting for payment · 4[67] h left$/);
		assert.equal(await text(order(page, 'HTR-0007').locator('.shop-order-receipt')), 'No receipt yet');
		assert.equal(await order(page, 'HTR-0007').locator('.shop-order-who a').getAttribute('href'), 'tel:8199999-0000'.replace('-', ''));
		assert.match(await text(order(page, 'HTR-0008').locator('.shop-order-state')), /^Waiting for payment · (29|30) min left$/);
		assert.equal(await text(order(page, 'HTR-0006').locator('.shop-order-state')), 'Paid · to hand over');
		assert.equal(await order(page, 'HTR-0006').locator('button:has-text("Log the sale")').count(), 1);
		assert.equal(await text(order(page, 'HTR-0007').locator('.shop-order-total')), 'Total R$ 5,00');
		await page.screenshot({fullPage: true, path: `${SHOTS}/shop-orders-list.png`});

		// The receipt opens in a new tab through a signed link.
		const [tab] = await Promise.all([context.waitForEvent('page'), order(page, 'HTR-0008').locator('.shop-order-receipt button').click()]);

		await tab.waitForURL(/store-receipts\/receipt\.png\?token=t/, TIMEOUT);
		await tab.close();
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('Payment received marks the order paid, logs the sale, takes the copies out of the spares, and Delivered closes it', async () => {
		const {context, errors, page, store} = await ownerPhone();

		await openShop(page);
		await order(page, 'HTR-0007').waitFor(TIMEOUT);
		assert.equal(await page.locator('#shop-international-tsa1-004-en').count(), 1, 'Charmander EN has spares');

		await order(page, 'HTR-0007').locator('button:has-text("Payment received")').click();
		assert.equal(await text(order(page, 'HTR-0007').locator('.shop-order-ask')), 'R$ 5,00 from Ana is in your account?');
		await order(page, 'HTR-0007').locator('button:has-text("Yes, received")').click();
		await page.waitForFunction(() => document.querySelector('#order-HTR-0007 .shop-order-state') && document.querySelector('#order-HTR-0007 .shop-order-state').textContent === 'Paid · to hand over', null, TIMEOUT);
		assert.deepEqual(store.calls.filter(([name]) => name === 'mark_paid'), [['mark_paid', 'HTR-0007']]);
		await page.locator('#shop-international-tsa1-004-en').waitFor({state: 'detached', ...TIMEOUT});
		assert.equal(await order(page, 'HTR-0007').locator('button:has-text("Log the sale")').count(), 0, 'the sale is logged');

		// The sale is in Trades, with the buyer and the order's code.
		const sale = await page.evaluate(async () => {
			const {loadDocument} = await import('/pokemon-card-tracker/js/collection.js');
			const doc = await loadDocument();

			return doc.moves.find((move) => move.id === '00000000-0000-4000-8000-000000000007');
		});

		assert.deepEqual([sale.kind, sale.who, sale.price, sale.note, [...sale.out].sort().join()], ['sold', 'Ana', 5, 'HOTARU HTR-0007', 'c-03,c-04']);

		await order(page, 'HTR-0007').locator('button:has-text("Delivered")').click();
		await order(page, 'HTR-0007').waitFor({state: 'detached', ...TIMEOUT});
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('Cancel asks first, then gives the cards back; Log the sale logs a missing sale once', async () => {
		const {context, errors, page, store} = await ownerPhone();

		await openShop(page);
		await order(page, 'HTR-0008').waitFor(TIMEOUT);
		await order(page, 'HTR-0008').locator('button:has-text("Cancel order")').click();
		assert.equal(await text(order(page, 'HTR-0008').locator('.shop-order-ask')), 'Cancel HTR-0008? Its cards go back on HOTARU.');
		await order(page, 'HTR-0008').locator('button:has-text("Back")').click();
		assert.equal(store.calls.filter(([name]) => name === 'cancel_order').length, 0, 'Back cancels nothing');
		await order(page, 'HTR-0008').locator('button:has-text("Cancel order")').click();
		await order(page, 'HTR-0008').locator('.shop-order-actions button:has-text("Cancel order")').click();
		await order(page, 'HTR-0008').waitFor({state: 'detached', ...TIMEOUT});
		assert.deepEqual(store.calls.filter(([name]) => name === 'cancel_order'), [['cancel_order', 'HTR-0008']]);

		// HTR-0006 is paid; its sale goes in once, and mark_paid is not asked.
		await order(page, 'HTR-0006').locator('button:has-text("Log the sale")').click();
		await page.waitForFunction(() => !document.querySelector('#order-HTR-0006 .shop-order-actions button.primary') || document.querySelector('#order-HTR-0006 .shop-order-actions').textContent.indexOf('Log the sale') < 0, null, TIMEOUT);

		const sales = await page.evaluate(async () => {
			const {applyMove} = await import('/pokemon-card-tracker/js/moves.js');
			const {loadDocument} = await import('/pokemon-card-tracker/js/collection.js');
			let again = 'logged again';

			try {
				await applyMove({kind: 'sold', out: ['c-10'], price: 9, who: 'Caio'}, {id: '00000000-0000-4000-8000-000000000006'});
			}
			catch (err) {
				again = err.logged ? 'refused' : err.message;
			}

			const doc = await loadDocument();

			return {again, count: doc.moves.filter((move) => move.id === '00000000-0000-4000-8000-000000000006').length};
		});

		assert.deepEqual(sales, {again: 'refused', count: 1});
		assert.equal(store.calls.filter(([name]) => name === 'mark_paid').length, 0);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('an order whose copy left the collection cannot be marked paid, and says why', async () => {
		const orders = openOrders();

		orders[1].items.push(item('gone-copy', 'Bulbasaur', 1));

		const {context, errors, page} = await ownerPhone({orders});

		await openShop(page);
		await order(page, 'HTR-0007').waitFor(TIMEOUT);
		assert.ok(await order(page, 'HTR-0007').locator('button:has-text("Payment received")').isDisabled());
		assert.equal(await text(order(page, 'HTR-0007').locator('.shop-order-missing')), '1 copy of this order is no longer in your cards. Cancel the order, or add it back.');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('before store-orders.sql is run the Shop says so, and a member who is not the owner sees no orders', async () => {
		let {context, errors, page} = await ownerPhone({setUp: false});

		await openShop(page);
		await page.locator('#shop-orders:not([hidden]) p[role="status"]').waitFor(TIMEOUT);
		assert.equal(await text(page.locator('#shop-orders p[role="status"]')), 'Orders are not set up yet: run supabase/store-orders.sql in the Supabase SQL Editor.');
		assert.deepEqual(errors, []);
		await context.close();

		({context, errors, page} = await ownerPhone({owner: false}));
		await openShop(page);
		await page.waitForTimeout(1500);
		assert.ok(await page.locator('#shop-orders').isHidden());
		assert.deepEqual(errors, []);
		await context.close();
	});
});
