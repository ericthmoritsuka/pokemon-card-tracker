// Browser tests for the Shop's Kits (js/shop-kits.js and its hooks in
// js/shop-view.js, plans/hotaru-bundles-plan.md): ticking cards and making a
// kit at a percent off or a typed price, with the live preview; the Kits
// section with its state, Turn off, and Delete; the refill after Publish,
// when a kit's copy is no longer for sale; an order's cards grouped under
// their kit; and the screen before supabase/store-bundles.sql has been run.
// Headless Chromium against tests/pages-server.mjs, signed in as the
// family's owner.
//
// Supabase is tests/fake-supabase.mjs; store_sync, the order calls, and the
// kit calls are answered here, following supabase/store-bundles.sql, whose
// rules are checked against Postgres by tests/store-bundles-sql-check.sh.
// The copies are tests/trade-harness.mjs's invented ones, priced here.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/shop-kits-browser.test.mjs
// Screenshots: /tmp/shop-kits-*.png, or under SHOTS when set.

import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
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

// Charmander EN (c-02 marked For sale, c-04 a spare), Charizard ex, and
// Pikachu, each at R$ 5,00.
const PRICED = new Set(['c-02', 'c-04', 'c-07', 'c-08', 'c-09', 'c-10']);
const COPIES = SPARE_COPIES.map((entry) => (PRICED.has(entry.id) ? {...entry, sale_price: 5, ...(entry.id === 'c-02' ? {for_sale: true} : {})} : entry));

// What the server knows of each listing, as store_listings holds it.
const LISTINGS = {
	'c-02': {card_id: 'tsa1-004', condition: 'Near Mint', language: 'en', name: 'Charmander', number: '004'},
	'c-04': {card_id: 'tsa1-004', condition: 'Near Mint', language: 'en', name: 'Charmander', number: '004'},
	'c-07': {card_id: 'tsa1-006', condition: null, language: 'en', name: 'Charizard ex', number: '006'},
	'c-08': {card_id: 'tsa1-006', condition: null, language: 'en', name: 'Charizard ex', number: '006'},
	'c-09': {card_id: 'tsb2-025', condition: null, language: 'en', name: 'Pikachu', number: '025'},
	'c-10': {card_id: 'tsb2-025', condition: null, language: 'en', name: 'Pikachu', number: '025'},
};

const cents = (brl) => Math.round(brl * 100);

// The kit calls as supabase/store-bundles.sql answers them, over an
// in-memory table; statuses are the listings' ({<id>: 'sold'}).
async function attachStore(page, {kits = [], orders = [], setUp = true, statuses = {}} = {}) {
	const calls = [];
	const row = (kit) => {
		const items = kit.items.map((id) => ({...LISTINGS[id], finish: null, image_path: null, listing_id: id, price_brl: 5, set_name: 'Test Alpha', status: statuses[id] || 'available'}));
		const sum = items.length * 5;
		const price = kit.price_mode === 'fixed' ? kit.price_brl : Math.floor(cents(sum) * (1000 - kit.discount_pct * 10) / 1000) / 100;

		return {...kit, available: kit.active && items.every((item) => item.status === 'available'), created_at: '2026-11-25T00:00:00Z', items, price, sum};
	};
	const reply = (route, body, status = 200) => route.fulfill({body: JSON.stringify(body), contentType: 'application/json', status});

	await page.route('**/rest/v1/rpc/store_sync', (route) => reply(route, {}));
	await page.route('**/rest/v1/rpc/store_orders_open', (route) => reply(route, orders));
	await page.route(/\/rest\/v1\/rpc\/(store_bundles_admin|save_bundle|delete_bundle)$/, (route) => {
		const name = route.request().url().split('/rpc/')[1];
		const args = route.request().postDataJSON() || {};

		calls.push([name, args]);

		if (!setUp) {
			return reply(route, {code: 'PGRST202', details: null, hint: null, message: `Could not find the function public.${name} without parameters in the schema cache`}, 404);
		}

		if (name === 'store_bundles_admin') {
			return reply(route, kits.map(row));
		}

		if (name === 'save_bundle') {
			const kit = {...args.kit, id: args.kit.id || randomUUID()};
			const at = kits.findIndex((one) => one.id === kit.id);

			if (at < 0) {
				kits.unshift(kit);
			}
			else {
				kits[at] = kit;
			}

			return reply(route, row(kit));
		}

		const at = kits.findIndex((one) => one.id === args.kit_id);

		if (at >= 0) {
			kits.splice(at, 1);
		}

		return reply(route, at >= 0);
	});

	return {calls, kits};
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
		doc: {...documentWith(COPIES), person: undefined, user_id: undefined},
		updated_at: fake.now(),
		user_id: user.id,
	});

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err.message));

	const store = await attachStore(page, options);

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
	await page.locator('#shop-kits').waitFor(TIMEOUT);
}

const text = async (locator) => plain(await locator.textContent());

const tick = (page, cardId) => page.check(`#shop-international-${cardId}-en-pick`);

// The ticked cards' bar slides in; it is measured once it has settled.
const settled = (page) => page.waitForFunction(() => {
	const bar = document.getElementById('shop-selbar');

	return bar && !bar.hidden && bar.getAnimations().length === 0;
}, null, TIMEOUT);

describe('Shop kits', () => {
	test('ticked cards become a kit at a percent off, and the section shows it on HOTARU', async () => {
		const {context, errors, page, store} = await ownerPhone();

		await openShop(page);
		assert.equal(await text(page.locator('#shop-kits-title')), 'Kits');
		assert.match(await text(page.locator('#shop-kits-note')), /^Tick 2 or more priced cards below/);
		assert.equal(await page.locator('#shop-kit-make').isVisible(), false, 'no kit button before two ticks');

		await tick(page, 'tsa1-004');
		assert.equal(await page.locator('#shop-kit-make').isVisible(), false, 'one tick is not a kit');
		await tick(page, 'tsa1-006');
		await tick(page, 'tsb2-025');
		assert.equal(await text(page.locator('#shop-kit-make')), 'Kit 3 selected');

		// Kit sits beside Fill and matches it: one line, a 44 px tap height
		// (Eric, 2026-11-25: squeezed among the text links, it wrapped).
		const [fill, kitBox] = await Promise.all([page.locator('#shop-bulk-set').boundingBox(), page.locator('#shop-kit-make').boundingBox()]);

		assert.equal(kitBox.height, fill.height);
		assert.ok(kitBox.height >= 44 && kitBox.height < 60, `Kit is ${kitBox.height} px tall`);
		assert.equal(await page.locator('#shop-bulk > #shop-kit-make').count(), 1, 'in the price row, not the text links');
		await page.click('#shop-kit-make');
		await page.locator('#shop-kit-sheet').waitFor(TIMEOUT);

		assert.equal(await page.locator('#shop-kit-cards li').count(), 3);
		assert.equal(await page.getAttribute('#shop-kit-name', 'placeholder'), 'Charmander + Charizard ex + Pikachu');
		assert.equal(await text(page.locator('#shop-kit-preview')), '3 cards, R$ 15,00 apart.');
		await page.fill('#shop-kit-amount', '5');
		assert.equal(await text(page.locator('#shop-kit-preview')), '3 cards, R$ 15,00 apart. Kit: R$ 14,25, 5% off.');
		await page.fill('#shop-kit-amount', '95');
		await page.click('#shop-kit-save');
		assert.match(await text(page.locator('#shop-kit-error')), /^Type a discount from 1% to 90%/);
		await page.fill('#shop-kit-amount', '5');
		await page.fill('#shop-kit-name', 'Trio');
		await page.screenshot({path: `${SHOTS}/shop-kits-sheet.png`});
		await page.click('#shop-kit-save');
		await page.locator('#shop-kit-sheet').waitFor({state: 'detached', ...TIMEOUT});

		const saved = store.calls.find(([name]) => name === 'save_bundle')[1].kit;

		assert.equal(saved.name, 'Trio');
		assert.equal(saved.price_mode, 'percent');
		assert.equal(saved.discount_pct, 5);
		assert.equal(saved.price_brl, null);
		assert.equal(saved.items.length, 3);
		assert.equal(new Set(saved.items.map((id) => LISTINGS[id].card_id)).size, 3, 'one copy of each card');

		const kit = page.locator('.shop-kit').first();

		await kit.waitFor(TIMEOUT);
		assert.equal(await text(page.locator('#shop-kits-title')), 'Kits (1)');
		assert.equal(await text(kit.locator('.shop-kit-price')), 'R$ 14,25 · 5% off · R$ 15,00 apart');
		assert.equal(await text(kit.locator('.shop-kit-state')), 'On HOTARU.');
		assert.equal(await page.locator('.shop-picked').count(), 0, 'the ticks clear once saved');
		await page.screenshot({fullPage: true, path: `${SHOTS}/shop-kits-section.png`});
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a bar at the bottom carries the ticked cards\' actions while anything is ticked', async () => {
		const {context, errors, page} = await ownerPhone();

		await openShop(page);
		assert.equal(await page.locator('#shop-selbar').isHidden(), true, 'nothing ticked, no bar');

		await tick(page, 'tsb2-025');
		await page.locator('#shop-selbar').waitFor(TIMEOUT);
		assert.equal(await text(page.locator('#shop-selbar-count')), '1 selected');
		assert.equal(await page.getAttribute('#shop-selbar-count', 'aria-live'), 'polite');
		assert.equal(await page.isDisabled('#shop-selbar-kit'), true, 'a kit needs two');
		assert.equal(await page.getAttribute('#shop-selbar-kit', 'aria-label'), 'Kit: tick 2 or more cards');

		// Reachable where the thumb is: inside the viewport, 44 px tall.
		await settled(page);

		const bar = await page.locator('#shop-selbar').boundingBox();
		const fill = await page.locator('#shop-selbar-fill').boundingBox();

		assert.ok(bar.y + bar.height <= 844, 'the bar is on screen');
		assert.ok(fill.height >= 44);

		await tick(page, 'tsa1-006');
		assert.equal(await text(page.locator('#shop-selbar-count')), '2 selected');
		assert.equal(await page.isDisabled('#shop-selbar-kit'), false);
		await page.click('#shop-selbar-kit');
		await page.locator('#shop-kit-sheet').waitFor(TIMEOUT);
		assert.equal(await page.locator('#shop-kit-cards li').count(), 2);
		await page.click('#shop-kit-close');
		await page.locator('#shop-kit-sheet').waitFor({state: 'detached', ...TIMEOUT});

		// Fill from the bar types the price as a draft and clears the ticks;
		// the bar leaves and the Save bar shows.
		await page.fill('#shop-selbar-price', '7');
		await page.click('#shop-selbar-fill');
		await page.locator('#shop-selbar').waitFor({state: 'hidden', ...TIMEOUT});
		await page.locator('#shop-savebar').waitFor(TIMEOUT);
		assert.equal(await page.inputValue('#shop-international-tsb2-025-en .shop-price-input'), '7,00');

		// Ticked again with the Save bar showing: the bar rides above it.
		await tick(page, 'tsa1-004');
		await settled(page);

		const [above, save] = await Promise.all([page.locator('#shop-selbar').boundingBox(), page.locator('#shop-savebar').boundingBox()]);

		assert.ok(above.y + above.height <= save.y + 1, 'the ticked cards\' bar sits above the Save bar');
		await page.click('#shop-selbar-clear');
		await page.locator('#shop-selbar').waitFor({state: 'hidden', ...TIMEOUT});
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a typed price shows the percent it works out to, and warns when it is no discount', async () => {
		const {context, errors, page, store} = await ownerPhone({kits: [{active: true, description: null, discount_pct: 5, id: 'k1', items: ['c-04', 'c-08'], name: 'Duo', price_brl: null, price_mode: 'percent'}]});

		await openShop(page);
		await page.locator('#kit-k1').waitFor(TIMEOUT);
		await page.locator('#kit-k1 button:has-text("Edit")').click();
		await page.locator('#shop-kit-sheet').waitFor(TIMEOUT);
		assert.equal(await page.inputValue('#shop-kit-amount'), '5');
		await page.click('#shop-kit-mode input[value="fixed"] + span');
		await page.fill('#shop-kit-amount', '9');
		assert.equal(await text(page.locator('#shop-kit-preview')), '2 cards, R$ 10,00 apart. Kit: R$ 9,00, 10% off.');
		await page.fill('#shop-kit-amount', '10');
		assert.equal(await text(page.locator('#shop-kit-preview')), '2 cards, R$ 10,00 apart. Kit: R$ 10,00. No discount: the cards cost R$ 10,00 apart.');
		await page.fill('#shop-kit-amount', '9');
		await page.click('#shop-kit-save');
		await page.locator('#shop-kit-sheet').waitFor({state: 'detached', ...TIMEOUT});

		const saved = store.calls.filter(([name]) => name === 'save_bundle').pop()[1].kit;

		assert.deepEqual([saved.id, saved.price_mode, saved.price_brl, saved.discount_pct, saved.items], ['k1', 'fixed', 9, null, ['c-04', 'c-08']]);
		await page.waitForFunction(() => document.querySelector('#kit-k1 .shop-kit-price').textContent.replace(/\s/g, ' ').startsWith('R$ 9,00'), null, TIMEOUT);
		assert.equal(await text(page.locator('#kit-k1 .shop-kit-price')), 'R$ 9,00 · 10% off · R$ 10,00 apart');

		// Turn off, then Delete with its question.
		await page.locator('#kit-k1 button:has-text("Turn off")').click();
		await page.waitForFunction(() => document.querySelector('#kit-k1 .shop-kit-state').textContent === 'Off: not on HOTARU.', null, TIMEOUT);
		await page.locator('#kit-k1 button:has-text("Delete")').click();
		assert.equal(await text(page.locator('#kit-k1 .shop-kit-ask')), 'Delete Duo? Its cards stay for sale one by one.');
		await page.locator('#kit-k1 button:has-text("Delete kit")').click();
		await page.locator('#kit-k1').waitFor({state: 'detached', ...TIMEOUT});
		assert.equal(store.calls.filter(([name]) => name === 'delete_bundle').length, 1);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('after Publish, a kit whose copy is gone takes another listed copy of the same card', async () => {
		const kits = [{active: true, description: null, discount_pct: 5, id: 'k2', items: ['c-04', 'c-08'], name: 'Duo', price_brl: null, price_mode: 'percent'}];
		const {context, errors, page, store} = await ownerPhone({kits, statuses: {'c-04': 'reserved'}});

		await openShop(page);
		await page.locator('#kit-k2').waitFor(TIMEOUT);

		// The refill runs after the Shop's first Publish.
		for (let waited = 0; !store.calls.some(([name]) => name === 'save_bundle') && waited < 20000; waited += 200) {
			await page.waitForTimeout(200);
		}

		const saves = store.calls.filter(([name]) => name === 'save_bundle');

		assert.equal(saves.length, 1, 'one refill');
		assert.deepEqual(saves[0][1].kit.items, ['c-02', 'c-08'], 'Charmander c-04 is held by an order, so c-02 takes its place');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('an order lists a kit\'s cards under the kit, and a Shop without the kits SQL says so', async () => {
		const items = [
			{bundle_id: null, bundle_name: null, card_id: 'tsb2-025', condition: null, kind: 'single', language: 'en', listing_id: 'c-10', name: 'Pikachu', number: '025', price_brl: 5, set_name: 'Test Alpha'},
			{bundle_id: 'k3', bundle_name: 'Duo', card_id: 'tsa1-004', condition: 'Near Mint', kind: 'single', language: 'en', listing_id: 'c-04', name: 'Charmander', number: '004', price_brl: 4.75, set_name: 'Test Alpha'},
			{bundle_id: 'k3', bundle_name: 'Duo', card_id: 'tsa1-006', condition: null, kind: 'single', language: 'en', listing_id: 'c-08', name: 'Charizard ex', number: '006', price_brl: 4.75, set_name: 'Test Alpha'},
		];
		const orders = [{code: 'HTR-0009', created_at: new Date().toISOString(), id: '00000000-0000-4000-8000-000000000009', items, name: 'Ana', note: null, paid_at: null, phone: '81 99999-0000', receipt_at: null, receipt_path: null, reserved_until: new Date(Date.now() + 40 * 3600e3).toISOString(), status: 'pending', total: 14.5}];
		const {context, errors, page} = await ownerPhone({orders, setUp: false});

		await openShop(page);
		await page.locator('#order-HTR-0009').waitFor(TIMEOUT);

		const lines = await page.locator('#order-HTR-0009 .shop-order-items > li').allTextContents();

		assert.equal(lines.length, 2);
		assert.equal(plain(lines[0]), 'Pikachu · #025 · Test Alpha · English · R$ 5,00');
		assert.equal(await text(page.locator('#order-HTR-0009 .shop-order-kit-name')), 'Kit Duo · R$ 9,50');
		assert.equal(await page.locator('#order-HTR-0009 .shop-order-kit li').count(), 2);
		assert.equal(await text(page.locator('#shop-kits-problem')), 'Kits are not set up yet: run supabase/store-bundles.sql in the Supabase SQL Editor.');
		await page.screenshot({fullPage: true, path: `${SHOTS}/shop-kits-order.png`});
		assert.deepEqual(errors, []);
		await context.close();
	});
});
