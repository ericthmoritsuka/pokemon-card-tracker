// Browser tests for the Shop audit screen (js/shop-audit-view.js): the
// owner opens it from the Shop's link, sees each live listing that breaks
// the listing invariant with its reason, or "Every live listing passes.";
// a member gets the owner's notice. Headless Chromium at 390 x 844 against
// tests/pages-server.mjs, Supabase faked by tests/fake-supabase.mjs (its
// store_catalog), the copies tests/fixtures/collection-shape.mjs's.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/shop-audit-browser.test.mjs
// Screenshots: /tmp/shop-audit-*.png, or under SHOTS when set.

import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {FakeSupabase} from './fake-supabase.mjs';
import {collectionShape} from './fixtures/collection-shape.mjs';
import {BASE, documentWith, fakeServices, indexRecords, seed} from './my-cards-fixtures.mjs';
import {startPagesServer} from './pages-server.mjs';

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

const url = (path = '') => `${server.origin}${BASE}${path}`;
const plain = (text) => String(text).replace(/\s+/g, ' ').trim();

const listing = (id, cardId, fields = {}) => ({card_id: cardId, catalog: 'international', condition: 'Near Mint', description: null, finish: '', id, image_path: null, kind: 'single', language: 'pt', name: `Invented ${id}`, number: cardId.slice(-3), price_brl: 2, published_at: '2026-11-20T10:00:00.000Z', rarity: null, set_name: 'Invented Set', ...fields});

function family(catalog) {
	const fake = new FakeSupabase();
	const owner = fake.addUser('owner@example.test');
	const member = fake.addUser('member@example.test');
	const group = {id: randomUUID(), name: 'Family', owner_id: owner.id};
	const shape = collectionShape();

	fake.groups.push(group);
	fake.members.push({group_id: group.id, role: 'owner', user_id: owner.id}, {group_id: group.id, role: 'member', user_id: member.id});
	fake.storeCatalog = catalog;

	for (const user of [owner, member]) {
		fake.documents.set(user.id, {
			doc: {...documentWith(shape.cards, shape.binders), binder_picks: shape.binder_picks, person: undefined, user_id: undefined},
			updated_at: fake.now(),
			user_id: user.id,
		});
	}

	return {fake, member, owner};
}

async function phone(fake, user) {
	const context = await browser.newContext({serviceWorkers: 'block', viewport: {height: 844, width: 390}});

	await fakeServices(context);
	await fakePokeApi(context);
	await fake.attach(context, user.email);

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err.message));
	await page.route('**/rest/v1/rpc/store_sync', (route) => route.fulfill({body: '{}', contentType: 'application/json', status: 200}));
	await page.route(/\/rest\/v1\/rpc\/store_orders_open$/, (route) => route.fulfill({body: '[]', contentType: 'application/json', status: 200}));
	await seed(page, server.origin, {binders: [], copies: [], index: indexRecords()});
	await page.goto(url('signin'));
	await page.fill('#signin-email', user.email);
	await page.click('button:has-text("Send link")');
	await page.waitForSelector('#check-email');
	await page.goto(`${url()}?code=${fake.issueCode(user.email)}`);
	await page.waitForSelector('#account.avatar');
	await page.waitForFunction(() => {
		const line = document.getElementById('sync-status');

		return line && !line.hidden && line.textContent === 'Synced';
	}, null, TIMEOUT);

	return {context, errors, page};
}

describe('Shop audit', () => {
	test('the owner opens it from the Shop and sees each listing that breaks the rule, with its reason', async () => {
		const {fake, owner} = family([
			listing('m2', 'zz1-001'),
			listing('m4', 'zz1-001', {finish: 'Reverse Holofoil'}),
			listing('t1', 'zz1-004'),
			listing('gone', 'zz1-005'),
			listing('kit-1', 'zz1-001', {kind: 'sealed'}),
		]);
		const {context, errors, page} = await phone(fake, owner);

		await page.goto(url('shop'));
		await page.locator('#shop-audit-link:not([hidden])').waitFor(TIMEOUT);
		await page.locator('#shop-sealed-admin:not([hidden]) #shop-audit-link').waitFor(TIMEOUT);
		await page.click('#shop-audit-link');
		await page.waitForFunction(() => location.pathname.endsWith('/shop/audit'));
		await page.waitForFunction(() => /break/.test(document.getElementById('shop-audit-status').textContent), null, TIMEOUT);
		assert.equal(plain(await page.locator('#shop-audit-status').textContent()), '3 cards break the rule, out of 4 live listings.');
		// The next step (design review F7), and the count per finish (v128
		// review M3).
		assert.equal(await page.locator('#shop-audit-next').isVisible(), true);
		assert.equal(plain(await page.locator('#shop-audit-back').textContent()), 'Open the Shop to withdraw them');
		assert.match(plain(await page.locator('.shop-audit-row[data-id="m4"] .shop-audit-count').textContent()), /^1 of 1 copy is out\.$/);
		assert.deepEqual(await page.locator('.shop-audit-row').evaluateAll((rows) => rows.map((row) => row.dataset.id)), ['gone', 't1', 'm4']);
		assert.equal(plain(await page.locator('.shop-audit-row[data-id="gone"] .shop-audit-reason').textContent()), 'Not in your cards: the copy was deleted, sold, or traded away.');
		assert.equal(plain(await page.locator('.shop-audit-row[data-id="t1"] .shop-audit-reason').textContent()), 'In a binder pocket, so it should stay home.');
		assert.match(plain(await page.locator('.shop-audit-row[data-id="m4"] .shop-meta').textContent()), /Invented Set · #001 · .+ · Reverse Holofoil$/);
		assert.equal(await page.locator('.shop-audit-row .shop-art').count(), 3, 'a picture, or its empty frame, on each row');
		await page.screenshot({fullPage: true, path: `${SHOTS}/shop-audit-rows.png`});
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('nothing wrong: Every live listing passes.', async () => {
		const {fake, owner} = family([listing('m2', 'zz1-001'), listing('s1', 'zz1-009')]);
		const {context, errors, page} = await phone(fake, owner);

		await page.goto(url('shop/audit'));
		await page.waitForFunction(() => document.getElementById('shop-audit-status').textContent === 'Every live listing passes.', null, TIMEOUT);
		assert.equal(await page.locator('.shop-audit-row').count(), 0);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a member gets the owner\'s notice', async () => {
		const {fake, member} = family([listing('gone', 'zz1-005')]);
		const {context, errors, page} = await phone(fake, member);

		await page.goto(url('shop/audit'));
		await page.locator('#shop-audit-not-owner').waitFor(TIMEOUT);
		assert.equal(await page.locator('.shop-audit-row').count(), 0);
		assert.deepEqual(errors, []);
		await context.close();
	});
});
