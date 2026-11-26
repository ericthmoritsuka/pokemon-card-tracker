// Browser tests for Consignment (js/shop-consignment.js, its hooks in
// js/shop-view.js and js/catalog-views.js, plans/hotaru-consignment-plan.md):
// the Shop's Consignment section with the shop's terms, a consignor's
// cards, balances, Pay and Mark paid, the statement copied for WhatsApp,
// and Return to owner; the Consign sheet on a card page, with its live
// split and the record it saves; an order naming whose card it holds; and
// the screen before supabase/store-consignment.sql has been run. Headless
// Chromium against tests/pages-server.mjs, signed in as the family's owner.
//
// Supabase is tests/fake-supabase.mjs; the consignment calls are answered
// here, following supabase/store-consignment.sql, whose rules are checked
// against Postgres by tests/store-consignment-sql-check.sh.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/shop-consignment-browser.test.mjs
// Screenshots: /tmp/shop-consignment-*.png, or under SHOTS when set.

import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {commission} from '../js/consignment.js';
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

const plain = (text) => String(text).replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim();

const ANA = '0a000000-0000-4000-8000-00000000000a';

// Ana with three cards: Charizard sold and delivered (R$ 85,00 due),
// Pikachu for sale, and Mew returned.
function startingData() {
	return {
		cards: [
			{card_id: 'tsa1-006', catalog: 'international', commission_pct: 15, condition: 'Near Mint', consignor_id: ANA, finish: 'Holo', id: 'cons-1', language: 'en', min_commission_brl: 5, name: 'Charizard ex', number: '006', payout_brl: 85, price_brl: 100, received_at: '2026-11-20T12:00:00Z', returned_at: null, set_name: 'Test Alpha', status: 'sold'},
			{card_id: 'tsb2-025', catalog: 'international', commission_pct: 15, condition: null, consignor_id: ANA, finish: null, id: 'cons-2', language: 'en', min_commission_brl: 5, name: 'Pikachu', number: '025', payout_brl: 15, price_brl: 20, received_at: '2026-11-21T12:00:00Z', returned_at: null, set_name: 'Test Alpha', status: 'available'},
			{card_id: 'tsa1-001', catalog: 'international', commission_pct: 15, condition: null, consignor_id: ANA, finish: null, id: 'cons-3', language: 'en', min_commission_brl: 5, name: 'Mew', number: '001', payout_brl: 25, price_brl: 30, received_at: '2026-11-19T12:00:00Z', returned_at: '2026-11-22T12:00:00Z', set_name: 'Test Alpha', status: 'withdrawn'},
		],
		consignors: [{active: true, commission_pct: null, due_brl: 85, for_sale: 1, id: ANA, min_commission_brl: null, name: 'Ana', note: null, paid_brl: 0, phone: '81 90000-0000', pix_key: 'ana@example.test', reserved: 0, returned: 1, sold: 1, waiting_brl: 0}],
		payouts: [{commission_brl: 15, consignor_id: ANA, created_at: '2026-11-25T12:00:00Z', delivered_at: '2026-11-25T18:00:00Z', id: 'p-1', listing_id: 'cons-1', name: 'Charizard ex', order_code: 'HTR-0012', paid_at: null, paid_note: null, payout_brl: 85, sale_brl: 100, state: 'due'}],
		settings: {commission_pct: 15, min_commission_brl: 5},
	};
}

// The consignment calls as supabase/store-consignment.sql answers them,
// over data kept here.
async function attachConsignment(page, {data = startingData(), orders = [], setUp = true} = {}) {
	const calls = [];
	const reply = (route, body, status = 200) => route.fulfill({body: JSON.stringify(body), contentType: 'application/json', status});

	await page.route('**/rest/v1/rpc/store_sync', (route) => reply(route, {}));
	await page.route('**/rest/v1/rpc/store_orders_open', (route) => reply(route, orders));
	await page.route('**/rest/v1/rpc/store_bundles_admin', (route) => reply(route, []));
	await page.route(/\/rest\/v1\/rpc\/(store_consignment_admin|save_consigned|save_consignor|save_store_settings|return_consigned|relist_consigned|mark_payouts_paid)$/, (route) => {
		const name = route.request().url().split('/rpc/')[1];
		const args = route.request().postDataJSON() || {};

		calls.push([name, args]);

		if (!setUp) {
			return reply(route, {code: 'PGRST202', details: null, hint: null, message: `Could not find the function public.${name} without parameters in the schema cache`}, 404);
		}

		if (name === 'store_consignment_admin') {
			return reply(route, data);
		}

		if (name === 'save_consignor') {
			const person = {active: true, commission_pct: null, due_brl: 0, for_sale: 0, min_commission_brl: null, paid_brl: 0, reserved: 0, returned: 0, sold: 0, waiting_brl: 0, ...args.consignor, id: args.consignor.id || randomUUID()};

			data.consignors.push(person);

			return reply(route, person);
		}

		if (name === 'save_consigned') {
			const card = args.card;
			const cut = commission(card.price_brl, card.commission_pct, card.min_commission_brl);
			const row = {...card, commission_brl: cut, id: card.id || `cons-${randomUUID()}`, payout_brl: card.price_brl - cut, returned_at: null, status: 'available'};

			data.cards.unshift(row);

			return reply(route, row);
		}

		if (name === 'save_store_settings') {
			data.settings = args.settings;

			return reply(route, data.settings);
		}

		if (name === 'return_consigned') {
			const card = data.cards.find((one) => one.id === args.listing_id);

			card.status = 'withdrawn';
			card.returned_at = new Date().toISOString();

			return reply(route, card);
		}

		if (name === 'mark_payouts_paid') {
			let marked = 0;

			for (const payout of data.payouts) {
				if (args.ids.includes(payout.id) && !payout.paid_at) {
					payout.paid_at = new Date().toISOString();
					payout.state = 'paid';
					marked += 1;
				}
			}

			data.consignors[0].paid_brl += data.consignors[0].due_brl;
			data.consignors[0].due_brl = 0;

			return reply(route, {marked});
		}

		return reply(route, null);
	});

	return {calls, data};
}

// A phone signed in as the family's owner.
async function ownerPhone(options) {
	const fake = new FakeSupabase();
	const user = fake.addUser('owner@example.test');
	const context = await browser.newContext({serviceWorkers: 'block', viewport: {height: 844, width: 390}});

	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
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

	const store = await attachConsignment(page, options);

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
	// Consignment is on the Orders tab (Prices | Kits | Orders, v118).
	await page.click('#shop-tab-orders');
	await page.locator('#shop-consign').waitFor(TIMEOUT);
}

const text = async (locator) => plain(await locator.textContent());

describe('Shop consignment', () => {
	test('the section shows a consignor\'s cards and balances, pays what is due, copies the statement, and returns a card', async () => {
		const {context, errors, page, store} = await ownerPhone();

		await openShop(page);
		assert.equal(await text(page.locator('#shop-consign-title')), 'Consignment');
		assert.equal(await text(page.locator('#shop-consign-terms')), 'Shop terms: 15%, at least R$ 5,00 a card sold. Change');

		const ana = page.locator(`#consignor-${ANA}`);

		assert.equal(await text(ana.locator('.shop-consignor-counts')), '1 for sale · 1 sold · 1 returned');
		assert.equal(await text(ana.locator('.shop-consignor-balances')), 'R$ 85,00 due');

		const lines = (await ana.locator('.shop-consigned-line').allTextContents()).map(plain);

		assert.deepEqual(lines, [
			'Charizard ex #006 · Test Alpha · Holo · Near Mint · R$ 100,00 · Ana gets R$ 85,00 · Due',
			'Pikachu #025 · Test Alpha · R$ 20,00 · Ana gets R$ 15,00 · For sale',
			'Mew #001 · Test Alpha · R$ 30,00 · Ana gets R$ 25,00 · Returned',
		]);
		await page.screenshot({fullPage: true, path: `${SHOTS}/shop-consignment-section.png`});

		// The statement, as it pastes in WhatsApp.
		await page.click(`#shop-consign-statement-${ANA}`);
		await page.waitForFunction(() => navigator.clipboard.readText().then((value) => value.startsWith('HOTARU · Extrato de Ana')), null, TIMEOUT);

		const statement = await page.evaluate(() => navigator.clipboard.readText());

		assert.match(statement, /^À venda \(1\): Pikachu #025 R\$ 20,00$/m);
		assert.match(statement, /^Vendidas \(1\): Charizard ex #006 R\$ 100,00, repasse R\$ 85,00 \(a pagar\)$/m);
		assert.match(statement, /^A receber: R\$ 85,00$/m);

		// Pay: the Pix key, then Mark paid for the due payouts.
		await page.click(`#shop-consign-pay-${ANA}`);
		assert.match(await text(ana.locator('.shop-kit-ask')), /^Send R\$ 85,00 to Ana by Pix, then mark it paid\.$/);
		assert.equal(await text(ana.locator('.shop-pix-key')), 'Email ana@example.test. Your bank app shows the key\'s holder: check it is Ana before paying.');

		// The QR, drawn by the vendored library, and the copia e cola code.
		await ana.locator('.shop-pix-qr svg').waitFor(TIMEOUT);
		await page.screenshot({fullPage: true, path: `${SHOTS}/shop-consignment-pay.png`});
		await ana.locator('.shop-pix-copy').click();
		await page.waitForFunction(() => navigator.clipboard.readText().then((value) => value.startsWith('000201')), null, TIMEOUT);

		const code = await page.evaluate(() => navigator.clipboard.readText());

		assert.ok(code.includes('0014br.gov.bcb.pix0116ana@example.test'), 'Ana\'s key');
		assert.ok(code.includes('540585.00'), 'R$ 85,00');
		assert.ok(code.includes('5903ANA'), 'Ana\'s name');
		assert.equal(code, await ana.locator('.shop-pix').getAttribute('data-code'));
		await page.click(`#shop-consign-paid-${ANA}`);
		await page.waitForFunction((id) => !document.getElementById(`shop-consign-pay-${id}`) && /R\$\s85,00 paid/.test(document.querySelector(`#consignor-${id} .shop-consignor-balances`).textContent), ANA, TIMEOUT);
		assert.deepEqual(store.calls.find(([name]) => name === 'mark_payouts_paid')[1], {ids: ['p-1'], note: null});

		// Return to owner asks first.
		await ana.locator('.shop-consigned[data-id="cons-2"] .shop-consigned-return').click();
		assert.match(await text(ana.locator('.shop-consigned[data-id="cons-2"] .shop-kit-ask')), /^Give Pikachu back to Ana\? It leaves HOTARU\.$/);
		await ana.locator('.shop-consigned[data-id="cons-2"] button:has-text("Return")').click();
		await page.waitForFunction(() => /Returned$/.test(document.querySelector('.shop-consigned[data-id="cons-2"] .shop-consigned-line').textContent.trim()), null, TIMEOUT);
		assert.deepEqual(store.calls.find(([name]) => name === 'return_consigned')[1], {listing_id: 'cons-2'});
		assert.equal(await ana.locator('.shop-consigned[data-id="cons-2"] .shop-consigned-relist').count(), 1, 'a returned card can go back on sale');

		// The shop's terms change; cards already consigned keep theirs.
		await page.click('#shop-consign-terms-edit');
		await page.fill('#shop-consign-pct', '20');
		await page.click('#shop-consign-terms-save');
		await page.waitForFunction(() => /20%/.test(document.getElementById('shop-consign-terms').textContent), null, TIMEOUT);
		assert.deepEqual(store.calls.find(([name]) => name === 'save_store_settings')[1], {settings: {commission_pct: 20, min_commission_brl: 5}});
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('Consign on a card page puts someone else\'s card on HOTARU with the split shown', async () => {
		const {context, errors, page, store} = await ownerPhone();

		// The Shop's answer tells the app this is the owner.
		await openShop(page);
		await page.goto(`${server.origin}${BASE}cards/en/tsa1-004`);
		await page.locator('#copy-consign').waitFor(TIMEOUT);
		await page.click('#copy-consign');
		await page.locator('#consign-sheet').waitFor(TIMEOUT);
		assert.equal(await text(page.locator('#consign-sheet-title')), 'Consign a card');
		assert.match(await text(page.locator('#consign-print')), /^Charmander/);
		assert.equal(await page.locator('#consign-consignor').inputValue(), ANA, 'Ana is picked');
		assert.equal(await page.locator('#consign-pct').inputValue(), '15');
		assert.equal(await page.locator('#consign-min').inputValue(), '5,00');

		await page.fill('#consign-price', '100');
		assert.equal(await text(page.locator('#consign-split')), 'Buyer pays R$ 100,00 · Ana gets R$ 85,00 · You keep R$ 15,00');
		await page.fill('#consign-price', '20');
		assert.equal(await text(page.locator('#consign-split')), 'Buyer pays R$ 20,00 · Ana gets R$ 15,00 · You keep R$ 5,00');
		await page.selectOption('#consign-condition', 'Near Mint');
		await page.screenshot({fullPage: true, path: `${SHOTS}/shop-consignment-sheet.png`});
		await page.click('#consign-save');
		await page.locator('#consign-sheet').waitFor({state: 'detached', timeout: 20000});

		const saved = store.calls.find(([name]) => name === 'save_consigned')[1].card;

		assert.equal(saved.card_id, 'tsa1-004');
		assert.equal(saved.catalog, 'international');
		assert.equal(saved.language, 'en');
		assert.equal(saved.name, 'Charmander');
		assert.equal(saved.condition, 'Near Mint');
		assert.equal(saved.consignor_id, ANA);
		assert.equal(saved.price_brl, 20);
		assert.equal(saved.commission_pct, 15);
		assert.equal(saved.min_commission_brl, 5);
		assert.equal('id' in saved, false, 'a new card');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a new consignor can be added in the Consign sheet', async () => {
		const data = {...startingData(), cards: [], consignors: [], payouts: []};
		const {context, errors, page, store} = await ownerPhone({data});

		await openShop(page);
		assert.match(await text(page.locator('#shop-consign-note')), /^Sell other people's cards for a commission/);
		await page.goto(`${server.origin}${BASE}cards/en/tsa1-004`);
		await page.click('#copy-consign');
		await page.locator('#consign-sheet').waitFor(TIMEOUT);
		assert.equal(await page.locator('#consign-consignor').inputValue(), '__new__');
		assert.equal(await page.locator('#consign-new').isVisible(), true);
		await page.fill('#consign-new-name', 'Bia');
		await page.fill('#consign-new-pix', 'bia@example.test');
		await page.fill('#consign-price', '50');
		assert.equal(await text(page.locator('#consign-split')), 'Buyer pays R$ 50,00 · Bia gets R$ 42,50 · You keep R$ 7,50');
		await page.click('#consign-save');
		await page.locator('#consign-sheet').waitFor({state: 'detached', timeout: 20000});

		const names = store.calls.map(([name]) => name);

		assert.ok(names.indexOf('save_consignor') < names.indexOf('save_consigned'), 'the consignor is saved first');
		assert.equal(store.calls.find(([name]) => name === 'save_consignor')[1].consignor.name, 'Bia');
		assert.equal(store.calls.find(([name]) => name === 'save_consigned')[1].card.consignor_id, data.consignors[0].id);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('an order names whose card it holds, and a Shop without the SQL says so', async () => {
		const items = [
			{bundle_id: null, bundle_name: null, card_id: 'tsa1-006', condition: 'Near Mint', finish: 'Holo', kind: 'consigned', language: 'en', listing_id: 'cons-1', name: 'Charizard ex', number: '006', price_brl: 100, set_name: 'Test Alpha'},
		];
		const orders = [{code: 'HTR-0012', created_at: new Date().toISOString(), id: '00000000-0000-4000-8000-000000000012', items, name: 'Buyer', note: null, paid_at: null, phone: '81 99999-0000', receipt_at: null, receipt_path: null, reserved_until: new Date(Date.now() + 40 * 3600e3).toISOString(), status: 'pending', total: 100}];

		{
			const {context, errors, page} = await ownerPhone({orders});

			await openShop(page);
			await page.locator('#order-HTR-0012').waitFor(TIMEOUT);
			assert.equal(plain((await page.locator('#order-HTR-0012 .shop-order-items > li').allTextContents())[0]), 'Charizard ex · #006 · Holo · Test Alpha · English · Near Mint · Consigned · Ana · R$ 100,00');
			assert.deepEqual(errors, []);
			await context.close();
		}

		{
			const {context, errors, page} = await ownerPhone({orders, setUp: false});

			await openShop(page);
			await page.locator('#shop-consign-problem').waitFor(TIMEOUT);
			assert.equal(await text(page.locator('#shop-consign-problem')), 'Consignment is not set up yet: run supabase/store-consignment.sql in the Supabase SQL Editor.');
			assert.equal(plain((await page.locator('#order-HTR-0012 .shop-order-items > li').allTextContents())[0]), 'Charizard ex · #006 · Holo · Test Alpha · English · Near Mint · Consigned · R$ 100,00');
			assert.deepEqual(errors, []);
			await context.close();
		}
	});
});
