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

const text = async (locator) => plain(await locator.textContent());

describe('Shop orders', () => {
	test('lists the open orders with their time left, receipts, and what each needs', async () => {
		const {context, errors, page} = await ownerPhone();

		await openShop(page);
		await order(page, 'HTR-0007').waitFor(TIMEOUT);
		assert.equal(await text(page.locator('#shop-orders-title')), 'Orders (3)');
		assert.equal(await text(page.locator('#shop-orders > p').first()), '2 orders waiting for payment, 1 paid, ready to hand over.');
		assert.equal(await text(page.locator('#shop-tab-orders')), 'Orders (3)');
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

	test('the checklist ticks each card off, counts the ticks, keeps them, and forgets a delivered order', async () => {
		const {context, errors, page} = await ownerPhone();
		const boxes = (code) => order(page, code).locator('.shop-order-items input[type="checkbox"]');
		const progress = (code) => text(order(page, code).locator('.shop-order-progress'));
		const kept = () => page.evaluate(() => JSON.parse(localStorage.getItem('cardTracker.orderChecks') || '{}'));

		await openShop(page);
		await order(page, 'HTR-0007').waitFor(TIMEOUT);
		assert.equal(await boxes('HTR-0007').count(), 2);
		assert.equal(await progress('HTR-0007'), 'Checked 0 of 2');

		// The whole line is the target: a tap on the card's words ticks it.
		await order(page, 'HTR-0007').locator('.shop-order-check span').first().click();
		assert.equal(await progress('HTR-0007'), 'Checked 1 of 2');
		assert.equal(await order(page, 'HTR-0007').locator('.shop-order-checked').count(), 1);
		await boxes('HTR-0007').nth(1).check();
		assert.equal(await progress('HTR-0007'), 'All 2 checked');
		assert.equal(await order(page, 'HTR-0007').locator('.shop-order-progress-done').count(), 1);
		await boxes('HTR-0006').first().check();
		assert.equal(await progress('HTR-0006'), 'Checked');
		await page.screenshot({fullPage: true, path: `${SHOTS}/shop-orders-checklist.png`});

		// Unticking counts down; the ticks survive a reload, which opens
		// on the Orders tab again.
		await boxes('HTR-0007').first().uncheck();
		assert.equal(await progress('HTR-0007'), 'Checked 1 of 2');
		await page.reload();
		await order(page, 'HTR-0007').waitFor(TIMEOUT);
		assert.deepEqual(await boxes('HTR-0007').evaluateAll((all) => all.map((box) => box.checked)), [false, true]);
		assert.equal(await progress('HTR-0007'), 'Checked 1 of 2');
		assert.deepEqual(await kept(), {'HTR-0006': ['c-10'], 'HTR-0007': ['c-04']});

		// A delivered order's ticks are forgotten with it.
		await order(page, 'HTR-0006').locator('button:has-text("Delivered")').click();
		await order(page, 'HTR-0006').waitFor({state: 'detached', ...TIMEOUT});
		await page.waitForFunction(() => !('HTR-0006' in JSON.parse(localStorage.getItem('cardTracker.orderChecks') || '{}')), null, TIMEOUT);
		assert.deepEqual(await kept(), {'HTR-0007': ['c-04']});
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

	test('an order of sealed products alone can be paid, and logs no sale in Trades', async () => {
		const orders = [{code: 'HTR-0010', created_at: hours(-1), id: '00000000-0000-4000-8000-000000000010', items: [{card_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', condition: null, finish: null, kind: 'sealed', language: 'pt', listing_id: 'sealed-1', name: 'Booster Box Destinos de Paldea', number: null, price_brl: 900, set_name: 'Booster box'}], name: 'Rui', note: null, paid_at: null, phone: '1', receipt_at: null, receipt_path: null, reserved_until: hours(40), status: 'pending', total: 900}];
		const {context, errors, page, store} = await ownerPhone({orders});

		await openShop(page);
		await order(page, 'HTR-0010').waitFor(TIMEOUT);
		assert.equal(await page.locator('#order-HTR-0010 .shop-order-missing').count(), 0, 'a sealed product is never missing');
		assert.match(await text(order(page, 'HTR-0010').locator('.shop-order-items li')), /^Booster Box Destinos de Paldea · Booster box · Portuguese · Sealed · R\$ 900,00$/);
		await order(page, 'HTR-0010').locator('button:has-text("Payment received")').click();
		await order(page, 'HTR-0010').locator('button:has-text("Yes, received")').click();
		await page.waitForFunction(() => document.querySelector('#order-HTR-0010 .shop-order-state') && document.querySelector('#order-HTR-0010 .shop-order-state').textContent === 'Paid · to hand over', null, TIMEOUT);
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
		assert.equal(await page.getAttribute('#shop-tab-prices', 'aria-selected'), 'true');
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

	test('the orders filter tells the unpaid ones from the paid ones ready to hand over', async () => {
		const {context, errors, page} = await ownerPhone();

		await openShop(page);
		await order(page, 'HTR-0007').waitFor(TIMEOUT);

		const labels = async () => (await page.locator('#shop-order-filter span[data-label]').allTextContents()).map(plain);

		assert.deepEqual(await labels(), ['All 3', 'Unpaid 2', 'Ready 1']);
		await page.click('#shop-order-filter input[value="pending"] + span');
		assert.deepEqual(await page.locator('.shop-order').evaluateAll((all) => all.map((one) => one.dataset.code)), ['HTR-0007', 'HTR-0008']);
		await page.click('#shop-order-filter input[value="paid"] + span');
		assert.deepEqual(await page.locator('.shop-order').evaluateAll((all) => all.map((one) => one.dataset.code)), ['HTR-0006']);
		await page.screenshot({fullPage: true, path: `${SHOTS}/shop-orders-to-hand-over.png`});

		// Kept through a reload; once delivered, the paid filter says so.
		await page.reload();
		await order(page, 'HTR-0006').waitFor(TIMEOUT);
		assert.ok(await page.isChecked('#shop-order-filter input[value="paid"]'));
		await order(page, 'HTR-0006').locator('button:has-text("Log the sale")').click();
		await order(page, 'HTR-0006').locator('button:has-text("Delivered")').click();
		await order(page, 'HTR-0006').waitFor({state: 'detached', ...TIMEOUT});
		assert.equal(await text(page.locator('#shop-orders-none')), 'Nothing ready: no paid order is waiting to be handed over.');
		assert.deepEqual(await labels(), ['All 2', 'Unpaid 2', 'Ready 0']);
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
