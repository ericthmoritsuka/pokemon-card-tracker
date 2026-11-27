// Browser tests for HOTARU's orders on the Shop screen (js/shop-view.js and
// js/store-orders.js, plans/hotaru-catalog-plan.md step 5): the open orders
// with their time left and receipts; Payment received, which marks the
// order paid and logs the sale, so the copies leave the spares; Delivered;
// Cancel; Log the sale for a paid order whose sale is missing, never twice;
// an order whose copy is gone from the collection; the receipt link; the
// count of open orders on the header's Shop bag; and the screen before
// supabase/store-orders.sql has been run. Headless
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
import {BASE, CARDS, documentWith, fakeServices, fullRecord, indexRecords, seed} from './my-cards-fixtures.mjs';
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

// A card-shaped grey picture, 63 by 88 pixels.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAD8AAABYCAIAAADNzLhqAAAAXUlEQVR42u3OAQ0AAAwCIPsnM5YBnuAbJCD9LPb29vb29vb29vb29vb29vb29vb29vb29vb29vb29vb29vb29vb29vb29vb29vb29vb29vb29vb29vb29vb29vZnP4voxK/FWbkGAAAAAElFTkSuQmCC';

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

// The order functions as supabase/store-orders.sql answers them, and the
// ticks and delivered orders as supabase/store-order-stages.sql does (stages
// false: that script not run yet).
async function attachOrders(page, {orders = openOrders(), setUp = true, owner = true, stages = true, delivered = []} = {}) {
	const calls = [];
	const ticks = new Map();
	const isOpen = (one) => Boolean(one) && orders.includes(one);
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

			if (name === 'mark_delivered') {
				delivered.unshift({...order, delivered_at: new Date().toISOString()});
			}
		}

		return route.fulfill({body: JSON.stringify({code: args.order_code}), contentType: 'application/json', status: 200});
	});
	await page.route(/\/rest\/v1\/rpc\/(store_order_checks|set_order_check|store_orders_delivered)$/, (route) => {
		const name = route.request().url().split('/rpc/')[1];
		const args = route.request().postDataJSON() || {};

		calls.push([name, args.order_code || null]);

		if (!stages || !setUp) {
			return fail(route, 404, 'PGRST202', `Could not find the function public.${name} in the schema cache`);
		}

		if (!owner) {
			return fail(route, 403, '42501', 'Only the shop owner can do this.');
		}

		if (name === 'store_orders_delivered') {
			return route.fulfill({body: JSON.stringify(delivered), contentType: 'application/json', status: 200});
		}

		if (name === 'store_order_checks') {
			const open = Object.fromEntries([...ticks].filter(([code, set]) => set.size && isOpen(orders.find((one) => one.code === code))).map(([code, set]) => [code, [...set].sort()]));

			return route.fulfill({body: JSON.stringify(open), contentType: 'application/json', status: 200});
		}

		const order = orders.find((one) => one.code === args.order_code);

		if (!isOpen(order)) {
			return fail(route, 400, '22023', `Order ${args.order_code} is no longer open.`);
		}

		const set = ticks.get(order.code) || new Set();

		if (args.checked) {
			set.add(args.listing);
		}
		else {
			set.delete(args.listing);
		}

		ticks.set(order.code, set);

		return route.fulfill({body: JSON.stringify({checked: Boolean(args.checked), code: order.code, listing_id: args.listing}), contentType: 'application/json', status: 200});
	});
	await page.route('**/storage/v1/object/sign/store-receipts/**', (route) => route.fulfill({body: JSON.stringify({signedURL: '/object/sign/store-receipts/receipt.png?token=t'}), contentType: 'application/json', status: 200}));

	return {calls, delivered, orders, ticks};
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

	if (options && options.init) {
		await context.addInitScript(options.init);
	}

	const page = await context.newPage();
	const errors = [];

	if (options && options.clock) {
		await page.clock.install();
	}

	page.on('pageerror', (err) => errors.push(err.message));

	const store = await attachOrders(page, options);

	await seed(page, server.origin, {binders: [], copies: [], index: (options && options.index) || indexRecords()});
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

// The orders are on the Shop's Orders tab (Eric, 2026-11-26).
async function openShop(page, {tab = 'orders'} = {}) {
	await page.goto(`${server.origin}${BASE}shop`);
	await page.locator('.shop-row').first().waitFor(TIMEOUT);
	await page.click('#shop-filter input[value="all"] + span');

	if (tab) {
		await page.click(`#shop-tab-${tab}`);
	}
}

// What a notification and a chime would have done, recorded: the tests
// block the service worker, so js/order-alerts.js falls back to the page's
// own Notification, and the browser has no sound in a headless run.
function recordAlerts() {
	window.__notes = [];
	window.__tones = 0;
	window.Notification = class {
		constructor(title, options) {
			window.__notes.push({body: options.body, tag: options.tag, title});
		}

		static get permission() {
			return 'granted';
		}

		static requestPermission() {
			return Promise.resolve('granted');
		}
	};
	window.AudioContext = class {
		constructor() {
			this.currentTime = 0;
			this.destination = {};
			this.state = 'suspended';
		}

		resume() {
			this.state = 'running';

			return Promise.resolve();
		}

		createOscillator() {
			window.__tones += 1;

			return {connect: (node) => node, frequency: {}, start() {}, stop() {}};
		}

		createGain() {
			return {connect: (node) => node, gain: {exponentialRampToValueAtTime() {}, setValueAtTime() {}}};
		}
	};
}

// The app comes back to the front, which reads the orders again.
const backInFront = (page) => page.evaluate(() => {
	Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'visible'});
	document.dispatchEvent(new Event('visibilitychange'));
});

const toastText = (page) => page.locator('.toast[data-toast-key="new-order"] .toast-text');

const order = (page, code) => page.locator(`#order-${code}`);

// Shows one stage of the orders: pending (Unpaid), separating, ready, or
// delivered.
const showStage = (page, value) => page.click(`#shop-order-filter input[value="${value}"] + span`);

const shownCodes = (page) => page.locator('.shop-order').evaluateAll((all) => all.map((one) => one.dataset.code));

// What the server holds as ticked, by order.
const serverTicks = (store) => Object.fromEntries([...store.ticks].filter(([, set]) => set.size).map(([code, set]) => [code, [...set].sort()]));

const text = async (locator) => plain(await locator.textContent());

describe('Shop orders', () => {
	test('lists the open orders with their time left, receipts, and what each needs', async () => {
		const {context, errors, page} = await ownerPhone();

		await openShop(page);
		await order(page, 'HTR-0007').waitFor(TIMEOUT);
		assert.equal(await text(page.locator('#shop-orders-title')), 'Orders (3)');
		assert.equal(await text(page.locator('#shop-tab-orders')), 'Orders (3)');
		assert.deepEqual(await shownCodes(page), ['HTR-0008', 'HTR-0007'], 'the Shop opens on Unpaid, the one with a receipt first (design review F11)');
		assert.equal(await text(order(page, 'HTR-0007').locator('.shop-order-head')), 'HTR-0007 · Ana');
		assert.match(await text(order(page, 'HTR-0007').locator('.shop-order-state')), /^Waiting for payment · 4[67] h left$/);
		assert.equal(await text(order(page, 'HTR-0007').locator('.shop-order-receipt')), 'No receipt yet');
		assert.equal(await order(page, 'HTR-0007').locator('.shop-order-who a').getAttribute('href'), 'tel:8199999-0000'.replace('-', ''));
		assert.match(await text(order(page, 'HTR-0008').locator('.shop-order-state')), /^(29|30) min left · Receipt sent: check the Pix$/);
		assert.equal(await text(order(page, 'HTR-0007').locator('.shop-order-total')), 'Total R$ 5,00');

		// Each card names its finish: the listing's, or on a listing
		// published without one, the copy's (c-03 is a Reverse Holofoil;
		// c-04 has none set, so its line names none).
		assert.deepEqual((await order(page, 'HTR-0007').locator('.shop-order-items > li').allTextContents()).map(plain), [
			'Charmander · #004 · Reverse Holofoil · Test Alpha · English · Near Mint · R$ 2,50',
			'Charmander · #004 · Test Alpha · English · Near Mint · R$ 2,50',
		]);
		await page.screenshot({fullPage: true, path: `${SHOTS}/shop-orders-list.png`});

		// The receipt opens in a new tab through a signed link.
		const [tab] = await Promise.all([context.waitForEvent('page'), order(page, 'HTR-0008').locator('.shop-order-receipt button').click()]);

		await tab.waitForURL(/store-receipts\/receipt\.png\?token=t/, TIMEOUT);
		await tab.close();

		// The paid order, nothing ticked yet, is under Separating.
		await showStage(page, 'separating');
		assert.deepEqual(await shownCodes(page), ['HTR-0006']);
		assert.equal(await text(order(page, 'HTR-0006').locator('.shop-order-state')), 'Paid · separating');
		assert.equal(await order(page, 'HTR-0006').locator('button:has-text("Log the sale")').count(), 1);
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
		// Paid, it is Separating now, and stays in sight under Unpaid for
		// five seconds or until the filter changes.
		await page.waitForFunction(() => document.querySelector('#order-HTR-0007 .shop-order-state') && document.querySelector('#order-HTR-0007 .shop-order-state').textContent === 'Paid · separating', null, TIMEOUT);
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

		// Under Separating, where the paid order is however long the sale took.
		// Neither card is ticked, so Delivered asks first, as Cancel does
		// (Eric, 2026-11-26); Back keeps the order, Deliver anyway closes it.
		await showStage(page, 'separating');
		await order(page, 'HTR-0007').locator('button:has-text("Delivered")').click();
		assert.equal(await text(order(page, 'HTR-0007').locator('.shop-order-ask')), '2 cards are not separated yet. Deliver anyway?');
		assert.equal(store.calls.filter(([name]) => name === 'mark_delivered').length, 0, 'nothing is sent before the answer');
		await order(page, 'HTR-0007').locator('button:has-text("Back")').click();
		await order(page, 'HTR-0007').locator('button:has-text("Delivered")').click();
		await order(page, 'HTR-0007').locator('button:has-text("Deliver anyway")').click();
		await order(page, 'HTR-0007').waitFor({state: 'detached', ...TIMEOUT});

		// Delivered lists it, with the day, its cards, and nothing to do.
		await showStage(page, 'delivered');
		await order(page, 'HTR-0007').waitFor(TIMEOUT);
		assert.deepEqual(await shownCodes(page), ['HTR-0007']);
		assert.match(await text(order(page, 'HTR-0007').locator('.shop-order-state')), /^Delivered \d{1,2} [A-Z][a-z]{2}$/);
		assert.equal(await order(page, 'HTR-0007').locator('.shop-order-items li').count(), 2);
		assert.equal(await order(page, 'HTR-0007').locator('input[type="checkbox"], button').count(), 0);
		await page.screenshot({fullPage: true, path: `${SHOTS}/shop-orders-delivered.png`});
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('the checklist ticks each card off, counts the ticks, keeps them on the server, and moves a paid order from Separating to Ready', async () => {
		const {context, errors, page, store} = await ownerPhone();
		const boxes = (code) => order(page, code).locator('.shop-order-items input[type="checkbox"]');
		const progress = (code) => text(order(page, code).locator('.shop-order-progress'));
		const labels = async () => (await page.locator('#shop-order-filter span[data-label]').allTextContents()).map(plain);
		const queue = () => page.evaluate(() => JSON.parse(localStorage.getItem('cardTracker.orderChecksQueue') || '[]'));

		await openShop(page);
		await order(page, 'HTR-0007').waitFor(TIMEOUT);
		assert.equal(await boxes('HTR-0007').count(), 2);
		assert.equal(await progress('HTR-0007'), 'Separated 0 of 2');

		// The whole line is the target: a tap on the card's words ticks it.
		await order(page, 'HTR-0007').locator('.shop-order-check span').first().click();
		assert.equal(await progress('HTR-0007'), 'Separated 1 of 2');
		assert.equal(await order(page, 'HTR-0007').locator('.shop-order-checked').count(), 1);
		await boxes('HTR-0007').nth(1).check();
		assert.equal(await progress('HTR-0007'), 'All 2 separated');
		assert.equal(await order(page, 'HTR-0007').locator('.shop-order-progress-done').count(), 1);
		assert.equal(await text(order(page, 'HTR-0007').locator('.shop-order-state')).then((line) => line.startsWith('Waiting for payment')), true, 'an unpaid order stays Unpaid, ticked or not');
		await page.waitForFunction(() => JSON.parse(localStorage.getItem('cardTracker.orderChecksQueue') || '[]').length === 0, null, TIMEOUT);
		assert.deepEqual(serverTicks(store), {'HTR-0007': ['c-03', 'c-04']});

		// Ticking the paid order's only card makes it Ready: the counts
		// follow at once, and the order stays in sight for five seconds or
		// until the filter changes.
		await showStage(page, 'separating');
		assert.deepEqual(await labels(), ['Unpaid 2', 'Separating 1', 'Ready 0', 'Delivered 0']);
		await boxes('HTR-0006').first().check();
		assert.equal(await progress('HTR-0006'), 'Separated');
		assert.equal(await text(order(page, 'HTR-0006').locator('.shop-order-state')), 'Paid · ready to hand over');
		assert.deepEqual(await labels(), ['Unpaid 2', 'Separating 0', 'Ready 1', 'Delivered 0']);
		assert.deepEqual(await shownCodes(page), ['HTR-0006']);
		await page.screenshot({fullPage: true, path: `${SHOTS}/shop-orders-checklist.png`});
		await showStage(page, 'ready');
		assert.deepEqual(await shownCodes(page), ['HTR-0006']);
		await showStage(page, 'separating');
		assert.deepEqual(await shownCodes(page), []);
		assert.equal(await text(page.locator('#shop-orders-none')), 'Nothing to separate: every paid order has its cards separated.');

		// Unticking counts down; the ticks survive a reload.
		await showStage(page, 'pending');
		await boxes('HTR-0007').first().uncheck();
		assert.equal(await progress('HTR-0007'), 'Separated 1 of 2');
		await page.waitForFunction(() => JSON.parse(localStorage.getItem('cardTracker.orderChecksQueue') || '[]').length === 0, null, TIMEOUT);
		await page.reload();
		await order(page, 'HTR-0007').waitFor(TIMEOUT);
		assert.deepEqual(await boxes('HTR-0007').evaluateAll((all) => all.map((box) => box.checked)), [false, true]);
		assert.deepEqual(serverTicks(store), {'HTR-0006': ['c-10'], 'HTR-0007': ['c-04']});

		// Another device: nothing kept here, the server's ticks draw.
		await page.evaluate(() => localStorage.removeItem('cardTracker.orderChecks'));
		await page.reload();
		await order(page, 'HTR-0007').waitFor(TIMEOUT);
		await page.waitForFunction(() => document.querySelectorAll('#order-HTR-0007 input[type="checkbox"]:checked').length === 1, null, TIMEOUT);
		assert.deepEqual(await labels(), ['Unpaid 2', 'Separating 0', 'Ready 1', 'Delivered 0']);
		assert.deepEqual(await queue(), []);

		// A delivered order's ticks are forgotten with it.
		await showStage(page, 'ready');
		await order(page, 'HTR-0006').locator('button:has-text("Delivered")').click();
		await order(page, 'HTR-0006').waitFor({state: 'detached', ...TIMEOUT});
		await page.waitForFunction(() => !('HTR-0006' in JSON.parse(localStorage.getItem('cardTracker.orderChecks') || '{}')), null, TIMEOUT);
		assert.deepEqual(await labels(), ['Unpaid 2', 'Separating 0', 'Ready 0', 'Delivered 1']);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('ticks made before store-order-stages.sql or offline wait on the device, and v119\'s ticks reach the server once', async () => {
		// v119 left a tick on this phone; the server has none.
		const v119 = () => localStorage.setItem('cardTracker.orderChecks', JSON.stringify({'HTR-0007': ['c-03']}));
		let {context, errors, page, store} = await ownerPhone({init: v119, stages: false});
		const boxes = (code) => order(page, code).locator('.shop-order-items input[type="checkbox"]');
		const progress = (code) => text(order(page, code).locator('.shop-order-progress'));
		const queue = () => page.evaluate(() => JSON.parse(localStorage.getItem('cardTracker.orderChecksQueue') || '[]'));

		// Not set up: the ticks work on the phone and wait, and Delivered
		// says what to run.
		await openShop(page);
		await order(page, 'HTR-0007').waitFor(TIMEOUT);
		assert.deepEqual(await boxes('HTR-0007').evaluateAll((all) => all.map((box) => box.checked)), [true, false]);
		await boxes('HTR-0007').nth(1).check();
		await page.waitForTimeout(300);
		assert.deepEqual(await queue(), [{code: 'HTR-0007', listing_id: 'c-03', on: true}, {code: 'HTR-0007', listing_id: 'c-04', on: true}]);
		// The ticks the server could not take say so, since the other
		// devices do not see them.
		assert.equal(await progress('HTR-0007'), 'All 2 separated · 2 not saved yet');
		assert.equal(await order(page, 'HTR-0007').locator('.shop-order-progress-unsaved').count(), 1);
		await showStage(page, 'delivered');
		assert.equal(await text(page.locator('#shop-orders-none')), 'Delivered orders show once supabase/store-order-stages.sql is run in the Supabase SQL Editor.');
		assert.deepEqual(errors, []);
		await context.close();

		// Set up: the v119 tick reaches the server once, and the flag that
		// says so stops it being sent again.
		({context, errors, page, store} = await ownerPhone({init: v119}));
		await openShop(page);
		await order(page, 'HTR-0007').waitFor(TIMEOUT);
		await page.waitForFunction(() => localStorage.getItem('cardTracker.orderChecksMoved') === 'true' && JSON.parse(localStorage.getItem('cardTracker.orderChecksQueue') || '[]').length === 0, null, TIMEOUT);
		assert.deepEqual(serverTicks(store), {'HTR-0007': ['c-03']});

		// Offline, a tick waits; back online, the next read sends it.
		await context.setOffline(true);
		await boxes('HTR-0007').nth(1).check();
		await page.waitForTimeout(300);
		assert.deepEqual(await queue(), [{code: 'HTR-0007', listing_id: 'c-04', on: true}]);
		assert.equal(await progress('HTR-0007'), 'All 2 separated · 1 not saved yet');
		await context.setOffline(false);
		await backInFront(page);
		await page.waitForFunction(() => JSON.parse(localStorage.getItem('cardTracker.orderChecksQueue') || '[]').length === 0, null, TIMEOUT);
		assert.deepEqual(serverTicks(store), {'HTR-0007': ['c-03', 'c-04']});
		await page.waitForFunction(() => document.querySelector('#order-HTR-0007 .shop-order-progress').textContent === 'All 2 separated', null, TIMEOUT);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a tick the server refuses is undone and said, never dropped in silence', async () => {
		const {context, errors, page, store} = await ownerPhone();
		const boxes = (code) => order(page, code).locator('.shop-order-items input[type="checkbox"]');

		await openShop(page);
		await order(page, 'HTR-0007').waitFor(TIMEOUT);

		// The order expired on the server while this phone still shows it.
		store.orders.splice(store.orders.findIndex((one) => one.code === 'HTR-0007'), 1);
		await boxes('HTR-0007').first().check();
		await page.waitForFunction(() => {
			const line = document.querySelector('.toast[data-toast-key="shop"] .toast-text');

			return line && line.textContent.startsWith('A check in HTR-0007');
		}, null, TIMEOUT);
		assert.equal(await text(page.locator('.toast[data-toast-key="shop"] .toast-text')), 'A check in HTR-0007 was not saved and is undone. Order HTR-0007 is no longer open.');
		assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('cardTracker.orderChecks') || '{}')), {});
		assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('cardTracker.orderChecksQueue') || '[]')), []);
		assert.deepEqual(serverTicks(store), {});

		// The orders are read again, and the closed one leaves.
		await order(page, 'HTR-0007').waitFor({state: 'detached', ...TIMEOUT});
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('an order a tick or a payment moved leaves its filter on its own five seconds later, and an untick in that time keeps it', async () => {
		const {context, errors, page} = await ownerPhone({clock: true});
		const boxes = (code) => order(page, code).locator('.shop-order-items input[type="checkbox"]');

		await openShop(page);
		await order(page, 'HTR-0007').waitFor(TIMEOUT);
		await showStage(page, 'separating');
		await order(page, 'HTR-0006').waitFor(TIMEOUT);

		// The last card ticked: Ready, still in sight for now.
		await boxes('HTR-0006').first().check();
		await page.clock.runFor(3000);
		assert.deepEqual(await shownCodes(page), ['HTR-0006']);

		// Unticked by mistake inside the five seconds: Separating again, so
		// it stays.
		await boxes('HTR-0006').first().uncheck();
		await page.clock.runFor(6000);
		assert.deepEqual(await shownCodes(page), ['HTR-0006']);

		// Ticked again: the five seconds start over, then it moves to Ready.
		await boxes('HTR-0006').first().check();
		await page.clock.runFor(4900);
		assert.deepEqual(await shownCodes(page), ['HTR-0006']);
		await page.clock.runFor(200);
		await order(page, 'HTR-0006').waitFor({state: 'detached', ...TIMEOUT});
		assert.equal(await text(page.locator('#shop-orders-none')), 'Nothing to separate: every paid order has its cards separated.');
		await showStage(page, 'ready');
		assert.deepEqual(await shownCodes(page), ['HTR-0006']);

		// A payment moves an order from Unpaid to Separating the same way.
		await showStage(page, 'pending');
		await order(page, 'HTR-0007').locator('button:has-text("Payment received")').click();
		await order(page, 'HTR-0007').locator('button:has-text("Yes, received")').click();
		await page.waitForFunction(() => document.querySelector('#order-HTR-0007 .shop-order-state') && document.querySelector('#order-HTR-0007 .shop-order-state').textContent === 'Paid · separating', null, TIMEOUT);
		assert.ok((await shownCodes(page)).includes('HTR-0007'));
		await page.clock.runFor(5100);
		await order(page, 'HTR-0007').waitFor({state: 'detached', ...TIMEOUT});
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a card line shows the card\'s picture under the mouse and on a long press, and a long press ticks nothing', async () => {
		// Charmander has a catalog picture, served here; the fixtures' cards
		// have none.
		const index = indexRecords();
		const base = 'https://assets.tcgdex.net/en/sm/tsa1/004';

		for (const localization of Object.values(index['international|tsa1-004'].localizations)) {
			localization.image = base;
		}

		const {context, errors, page} = await ownerPhone({index});

		await page.route(`${base}/**`, (route) => route.fulfill({body: Buffer.from(PNG, 'base64'), contentType: 'image/png', status: 200}));
		const line = order(page, 'HTR-0007').locator('.shop-order-check').first();
		const peek = line.locator('.shop-order-peek');
		const box = line.locator('input[type="checkbox"]');

		await openShop(page);
		await order(page, 'HTR-0007').waitFor(TIMEOUT);
		assert.equal(await peek.isHidden(), true);

		// The mouse resting on the line shows the copy's picture.
		await line.hover();
		await peek.waitFor({state: 'visible', ...TIMEOUT});
		const src = await peek.getAttribute('src');

		assert.equal(src, `${base}/high.webp`, 'the large catalog picture');
		await page.screenshot({fullPage: true, path: `${SHOTS}/shop-orders-peek.png`});
		await page.mouse.move(0, 0);
		await peek.waitFor({state: 'hidden', ...TIMEOUT});
		assert.equal(await box.isChecked(), false, 'hovering ticks nothing');

		// A finger held on the line shows it; lifting hides it and the box
		// stays as it was.
		const touch = (type) => line.evaluate((node, kind) => {
			const rect = node.getBoundingClientRect();
			const at = {bubbles: true, clientX: rect.left + 40, clientY: rect.top + 8, pointerId: 7, pointerType: 'touch'};

			node.querySelector('span').dispatchEvent(new PointerEvent(kind, at));

			if (kind === 'pointerup') {
				node.querySelector('span').dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
			}
		}, type);

		await touch('pointerdown');
		await peek.waitFor({state: 'visible', ...TIMEOUT});
		await touch('pointerup');
		await peek.waitFor({state: 'hidden', ...TIMEOUT});
		assert.equal(await box.isChecked(), false, 'a long press ticks nothing');

		// A tap still ticks it.
		await line.locator('span').first().tap().catch(() => line.locator('span').first().click());
		assert.equal(await box.isChecked(), true);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a consigned card in an order shows its catalog picture on a long press, read from TCGdex when the phone lacks it', async () => {
		// Two consigned cards, never in the collection: Charmander, whose
		// record the phone keeps, and Charizard ex, whose record it must read
		// (js/shop-view.js readOrderPicture: card_id + catalogFor(language)).
		const index = indexRecords();
		const charmander = 'https://assets.tcgdex.net/en/sm/tsa1/004';
		const charizard = 'https://assets.tcgdex.net/en/sm/tsa1/006';

		for (const localization of Object.values(index['international|tsa1-004'].localizations)) {
			localization.image = charmander;
		}

		delete index['international|tsa1-006'];

		const consigned = (id, cardId, name, number) => ({...item(id, name, 20), card_id: cardId, kind: 'consigned', number});
		const orders = [{code: 'HTR-0020', created_at: hours(-1), id: '00000000-0000-4000-8000-000000000020', items: [consigned('cons-7', 'tsa1-004', 'Charmander', '004'), consigned('cons-8', 'tsa1-006', 'Charizard ex', '006')], name: 'Duda', note: null, paid_at: null, phone: '81 98888-0000', receipt_at: null, receipt_path: null, reserved_until: hours(47), status: 'pending', total: 40}];
		const {context, errors, page} = await ownerPhone({index, orders});
		const read = [];

		await page.route(/^https:\/\/assets\.tcgdex\.net\/en\/sm\/tsa1\/00[46]\//, (route) => route.fulfill({body: Buffer.from(PNG, 'base64'), contentType: 'image/png', status: 200}));
		await page.route('https://api.tcgdex.net/v2/en/cards/tsa1-006', (route) => {
			read.push('tsa1-006');

			return route.fulfill({body: JSON.stringify({...fullRecord(CARDS.find((card) => card.id === 'tsa1-006')), image: charizard}), contentType: 'application/json', status: 200});
		});

		await openShop(page);
		await order(page, 'HTR-0020').waitFor(TIMEOUT);

		const lines = order(page, 'HTR-0020').locator('.shop-order-check');

		assert.equal(await lines.count(), 2, 'each consigned card has its line');

		const press = (line, kind) => line.evaluate((node, type) => {
			const rect = node.getBoundingClientRect();

			node.querySelector('span').dispatchEvent(new PointerEvent(type, {bubbles: true, clientX: rect.left + 40, clientY: rect.top + 8, pointerId: 9, pointerType: 'touch'}));
		}, kind);

		for (const [i, base] of [[0, charmander], [1, charizard]]) {
			const line = lines.nth(i);
			const peek = line.locator('.shop-order-peek');

			await press(line, 'pointerdown');
			await peek.waitFor({state: 'visible', ...TIMEOUT});
			assert.equal(await peek.getAttribute('src'), `${base}/high.webp`, `the large catalog picture of line ${i + 1}`);

			if (i === 1) {
				await page.screenshot({fullPage: true, path: `${SHOTS}/shop-orders-peek-consigned.png`});
			}

			await press(line, 'pointerup');
			await peek.waitFor({state: 'hidden', ...TIMEOUT});
		}

		assert.deepEqual(read, ['tsa1-006'], 'only the card the phone lacked is read');
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
		await showStage(page, 'separating');
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

	test('an order of sealed products alone can be paid, and logs no sale in Trades', async () => {
		const orders = [{code: 'HTR-0010', created_at: hours(-1), id: '00000000-0000-4000-8000-000000000010', items: [{card_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', condition: null, finish: null, kind: 'sealed', language: 'pt', listing_id: 'sealed-1', name: 'Booster Box Destinos de Paldea', number: null, price_brl: 900, set_name: 'Booster box'}], name: 'Rui', note: null, paid_at: null, phone: '1', receipt_at: null, receipt_path: null, reserved_until: hours(40), status: 'pending', total: 900}];
		const {context, errors, page, store} = await ownerPhone({orders});

		await openShop(page);
		await order(page, 'HTR-0010').waitFor(TIMEOUT);
		assert.equal(await page.locator('#order-HTR-0010 .shop-order-missing').count(), 0, 'a sealed product is never missing');
		assert.match(await text(order(page, 'HTR-0010').locator('.shop-order-items li')), /^Booster Box Destinos de Paldea · Booster box · Portuguese · Sealed · R\$ 900,00$/);
		await order(page, 'HTR-0010').locator('button:has-text("Payment received")').click();
		await order(page, 'HTR-0010').locator('button:has-text("Yes, received")').click();
		await page.waitForFunction(() => document.querySelector('#order-HTR-0010 .shop-order-state') && document.querySelector('#order-HTR-0010 .shop-order-state').textContent === 'Paid · separating', null, TIMEOUT);
		assert.deepEqual(store.calls.filter(([name]) => name === 'mark_paid'), [['mark_paid', 'HTR-0010']]);
		assert.equal(await order(page, 'HTR-0010').locator('button:has-text("Log the sale")').count(), 0);

		const logged = await page.evaluate(async () => {
			const {loadDocument} = await import('/pokemon-card-tracker/js/collection.js');

			return ((await loadDocument()).moves || []).filter((move) => move.id === '00000000-0000-4000-8000-000000000010').length;
		});

		assert.equal(logged, 0);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('the header bag counts the open orders, follows a cancel at once, and reads them again when the app comes back', async () => {
		const {context, errors, page, store} = await ownerPhone();
		const badge = page.locator('#shop-link #shop-badge');

		await page.goto(`${server.origin}${BASE}cards`);
		await page.locator('#shop-badge:not([hidden])').waitFor(TIMEOUT);
		assert.equal(await text(badge), '3');
		assert.equal(await page.getAttribute('#shop-link', 'aria-label'), 'Shop, 3 open orders');
		await page.screenshot({clip: {height: 72, width: 390, x: 0, y: 0}, path: `${SHOTS}/shop-orders-badge.png`});

		// Cancelling in the Shop takes the count down without another read.
		await openShop(page);
		await order(page, 'HTR-0008').locator('button:has-text("Cancel order")').click();
		await order(page, 'HTR-0008').locator('.shop-order-actions button:has-text("Cancel order")').click();
		await order(page, 'HTR-0008').waitFor({state: 'detached', ...TIMEOUT});
		await page.waitForFunction(() => document.getElementById('shop-badge').textContent === '2', null, TIMEOUT);

		// A new order while the app was in the background shows when it is
		// back in front.
		store.orders.push({...store.orders[0], code: 'HTR-0011', id: '00000000-0000-4000-8000-000000000011', status: 'pending'});
		await page.evaluate(() => {
			Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'visible'});
			document.dispatchEvent(new Event('visibilitychange'));
		});
		await page.waitForFunction(() => document.getElementById('shop-badge').textContent === '3', null, TIMEOUT);
		assert.equal(await page.getAttribute('#shop-link', 'aria-label'), 'Shop, 3 open orders');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('no count on the bag when orders are not set up yet', async () => {
		const {context, errors, page} = await ownerPhone({setUp: false});

		await page.goto(`${server.origin}${BASE}cards`);
		await page.locator('#shop-link:not([hidden])').waitFor(TIMEOUT);
		await page.waitForTimeout(1500);
		assert.ok(await page.locator('#shop-badge').isHidden());
		assert.equal(await page.getAttribute('#shop-link', 'aria-label'), null);
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
		await openShop(page, {tab: null});
		await page.waitForTimeout(1500);
		assert.ok(await page.locator('#shop-orders').isHidden());
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('the Shop opens on Prices, keeps its tab, and opens on Orders from the bag or ?tab=orders', async () => {
		let {context, errors, page} = await ownerPhone({orders: []});

		await openShop(page, {tab: null});
		assert.deepEqual(await page.locator('#shop-tabs [role="tab"]').allTextContents(), ['Prices', 'Kits', 'Orders', 'Consign']);
		assert.equal(await page.getAttribute('#shop-tab-prices', 'aria-selected'), 'true');
		assert.ok(await page.locator('#shop-panel-orders').isHidden());
		assert.ok(await page.locator('#shop-panel-kits').isHidden());
		await page.screenshot({clip: {height: 260, width: 390, x: 0, y: 0}, path: `${SHOTS}/shop-tabs.png`});

		// The tab is kept through a reload on this browser tab.
		await page.click('#shop-tab-kits');
		await page.reload();
		await page.locator('#shop-tabs').waitFor(TIMEOUT);
		assert.equal(await page.getAttribute('#shop-tab-kits', 'aria-selected'), 'true');
		assert.ok(await page.locator('#shop-panel-prices').isHidden());

		// Arrow keys move along the tabs.
		await page.focus('#shop-tab-kits');
		await page.keyboard.press('ArrowRight');
		assert.equal(await page.getAttribute('#shop-tab-orders', 'aria-selected'), 'true');
		assert.equal(await page.evaluate(() => document.activeElement.id), 'shop-tab-orders');
		await page.keyboard.press('ArrowRight');
		assert.equal(await page.getAttribute('#shop-tab-consign', 'aria-selected'), 'true');
		await page.keyboard.press('ArrowRight');
		assert.equal(await page.getAttribute('#shop-tab-prices', 'aria-selected'), 'true', 'the last tab wraps to the first');
		assert.deepEqual(errors, []);
		await context.close();

		// With orders open, the header's bag opens the Orders tab.
		({context, errors, page} = await ownerPhone());
		await page.goto(`${server.origin}${BASE}cards`);
		await page.locator('#shop-badge:not([hidden])').waitFor(TIMEOUT);
		await page.click('#shop-link');
		await page.locator('#shop-panel-orders:not([hidden]) #order-HTR-0007').waitFor(TIMEOUT);
		assert.equal(await page.getAttribute('#shop-tab-orders', 'aria-selected'), 'true');

		// ?tab=orders, from a notification, opens Orders and leaves the address clean.
		await page.click('#shop-tab-prices');
		await page.goto(`${server.origin}${BASE}shop?tab=orders`);
		await page.locator('#shop-panel-orders:not([hidden]) #order-HTR-0007').waitFor(TIMEOUT);
		assert.ok(!page.url().includes('?tab='), page.url());
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('the orders filter shows the four stages with their counts, keeps its choice, and fits a phone', async () => {
		const delivered = [{...openOrders()[0], code: 'HTR-0003', delivered_at: hours(-26), id: '00000000-0000-4000-8000-000000000003', name: 'Lia'}];
		const {context, errors, page} = await ownerPhone({delivered});

		await openShop(page);
		await order(page, 'HTR-0007').waitFor(TIMEOUT);

		const labels = async () => (await page.locator('#shop-order-filter span[data-label]').allTextContents()).map(plain);

		assert.deepEqual(await labels(), ['Unpaid 2', 'Separating 1', 'Ready 0', 'Delivered 1']);
		assert.deepEqual(await shownCodes(page), ['HTR-0008', 'HTR-0007']);
		await showStage(page, 'separating');
		assert.deepEqual(await shownCodes(page), ['HTR-0006']);
		await showStage(page, 'ready');
		assert.equal(await text(page.locator('#shop-orders-none')), 'Nothing ready: no paid order has every card separated.');
		await showStage(page, 'delivered');
		assert.deepEqual(await shownCodes(page), ['HTR-0003']);

		// The four segments fit a phone 390 and 360 pixels wide, each label
		// whole.
		const fit = () => page.evaluate(() => {
			const row = document.getElementById('shop-order-filter').getBoundingClientRect();
			const spans = [...document.querySelectorAll('#shop-order-filter span[data-label]')];

			return {
				clipped: spans.filter((span) => span.scrollWidth > span.clientWidth + 1).map((span) => span.dataset.label),
				inside: row.left >= 0 && row.right <= document.documentElement.clientWidth,
				oneRow: new Set(spans.map((span) => Math.round(span.getBoundingClientRect().top))).size === 1,
			};
		});

		assert.deepEqual(await fit(), {clipped: [], inside: true, oneRow: true});
		await page.setViewportSize({height: 800, width: 360});
		await page.waitForTimeout(200);
		assert.deepEqual(await fit(), {clipped: [], inside: true, oneRow: true}, 'at 360 px');
		await page.locator('#shop-orders').screenshot({path: `${SHOTS}/shop-orders-filter-360.png`});
		await page.setViewportSize({height: 844, width: 390});
		await page.waitForTimeout(200);
		await page.locator('#shop-orders').screenshot({path: `${SHOTS}/shop-orders-filter.png`});

		// Kept through a reload; v118's Ready, kept by an open tab, becomes
		// Separating.
		await showStage(page, 'separating');
		await page.reload();
		await order(page, 'HTR-0006').waitFor(TIMEOUT);
		assert.ok(await page.isChecked('#shop-order-filter input[value="separating"]'));
		await page.evaluate(() => sessionStorage.setItem('cardTracker.shopOrderFilter', 'paid'));
		await page.reload();
		await order(page, 'HTR-0006').waitFor(TIMEOUT);
		assert.ok(await page.isChecked('#shop-order-filter input[value="separating"]'));
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a new order or receipt rings: a toast always, and with alerts on, a chime and a notification', async () => {
		const {context, errors, page, store} = await ownerPhone({init: recordAlerts});

		await openShop(page);
		await order(page, 'HTR-0007').waitFor(TIMEOUT);
		assert.match(await text(page.locator('#shop-alerts-note')), /^Turn on alerts to hear a chime/);
		assert.equal(await page.evaluate(() => document.getElementById('shop-panel-orders').firstElementChild.id), 'shop-alerts', 'off, the alerts lead the tab');
		await page.click('#shop-alerts-on');
		await page.locator('#shop-alerts-off').waitFor(TIMEOUT);
		assert.equal(await page.evaluate(() => document.getElementById('shop-panel-orders').lastElementChild.id), 'shop-alerts', 'on, they wait below the orders');
		assert.match(await text(page.locator('#shop-alerts-note')), /^On: a chime and a Chrome notification/);
		await page.waitForFunction(() => window.__tones === 2, null, TIMEOUT);
		await page.screenshot({fullPage: true, path: `${SHOTS}/shop-orders-alerts.png`});

		// The orders open when the alerts went on were only remembered.
		assert.deepEqual(await page.evaluate(() => window.__notes), []);
		assert.equal(await toastText(page).count(), 0);

		// A new order: the toast, the notification, the chime, and the list.
		store.orders.push({...store.orders[1], code: 'HTR-0011', id: '00000000-0000-4000-8000-000000000011', name: 'Caio', receipt_path: null});
		await backInFront(page);
		await toastText(page).waitFor(TIMEOUT);
		assert.equal(await text(toastText(page)), 'New order HTR-0011 from Caio: 2 items, R$ 5,00');
		await order(page, 'HTR-0011').waitFor(TIMEOUT);
		assert.deepEqual((await page.evaluate(() => window.__notes)).map((note) => ({...note, title: plain(note.title)})), [{body: '', tag: 'order-HTR-0011', title: 'New order HTR-0011 from Caio: 2 items, R$ 5,00'}]);
		assert.equal(await page.evaluate(() => window.__tones), 4);

		// A receipt sent for an order already seen.
		store.orders.find((one) => one.code === 'HTR-0007').receipt_path = '0c1d2e3f-4a5b-4c6d-8e7f-901234567890/new.png';
		await backInFront(page);
		await page.waitForFunction(() => window.__notes.length === 2, null, TIMEOUT);
		assert.equal((await page.evaluate(() => window.__notes))[1].title, 'Ana sent the receipt for HTR-0007');
		assert.equal(await text(toastText(page)), 'Ana sent the receipt for HTR-0007');
		await order(page, 'HTR-0007').locator('.shop-order-receipt button').waitFor(TIMEOUT);

		// Read again with nothing new: no second alert.
		await backInFront(page);
		await page.waitForTimeout(1000);
		assert.equal(await page.evaluate(() => window.__notes.length), 2);

		// Turned off, a new order still toasts, with no chime or notification.
		await page.click('#shop-alerts-off');
		store.orders.push({...store.orders[1], code: 'HTR-0012', id: '00000000-0000-4000-8000-000000000012', receipt_path: null});
		await backInFront(page);
		await page.waitForFunction(() => document.querySelector('.toast[data-toast-key="new-order"] .toast-text').textContent.includes('HTR-0012'), null, TIMEOUT);
		assert.equal(await page.evaluate(() => window.__notes.length), 2);
		assert.equal(await page.evaluate(() => window.__tones), 6, 'the chimes of the order and the receipt only');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('with alerts on, the minute\'s read goes on in a tab behind others', async () => {
		const {context, errors, page, store} = await ownerPhone({clock: true, init: recordAlerts});

		await page.goto(`${server.origin}${BASE}cards`);
		await page.locator('#shop-badge:not([hidden])').waitFor(TIMEOUT);
		await page.evaluate(async () => {
			const alerts = await import('/pokemon-card-tracker/js/order-alerts.js');

			await alerts.turnOn();
		});
		await page.evaluate(() => {
			Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'hidden'});
			document.dispatchEvent(new Event('visibilitychange'));
		});

		const reads = () => store.calls.filter(([name]) => name === 'store_orders_open').length;
		const before = reads();

		store.orders.push({...store.orders[1], code: 'HTR-0013', id: '00000000-0000-4000-8000-000000000013', receipt_path: null});
		await page.clock.runFor(61000);
		await page.waitForFunction(() => window.__notes.length === 1, null, TIMEOUT);
		assert.ok(reads() > before, 'read while hidden');
		assert.equal((await page.evaluate(() => window.__notes))[0].tag, 'order-HTR-0013');

		// Off, a hidden tab reads nothing.
		await page.evaluate(async () => (await import('/pokemon-card-tracker/js/order-alerts.js')).turnOff());

		const offBefore = reads();

		await page.clock.runFor(61000);
		await page.waitForTimeout(500);
		assert.equal(reads(), offBefore);
		assert.deepEqual(errors, []);
		await context.close();
	});
});
