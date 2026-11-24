// Browser tests for who sees the Shop (js/shop-owner.js, js/shell.js, and
// js/shop-view.js shopScreen; Eric, 2026-11-24: the Shop is its own entry,
// in the header, and only his, since it makes no sense to the rest of the
// family). The family's owner sees Shop in the header on every screen,
// marked while the Shop is open, and still sees it on the next visit when
// the server cannot say; a member sees no Shop and gets a short notice at the shop
// address; Spares no longer carries a Shop button. Headless Chromium at
// 390 x 844 against tests/pages-server.mjs, Supabase faked by
// tests/fake-supabase.mjs, the copies tests/trade-harness.mjs's.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/shop-owner-browser.test.mjs
// Screenshots: /tmp/shop-owner-*.png, or under SHOTS when set.

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

const url = (path = '') => `${server.origin}${BASE}${path}`;

// The owner's family group, made as the owner's first sign-in makes it,
// with a member in it. Both have the spare copies on the server.
function family() {
	const fake = new FakeSupabase();
	const owner = fake.addUser('owner@example.test');
	const member = fake.addUser('member@example.test');
	const group = {id: randomUUID(), name: 'Family', owner_id: owner.id};

	fake.groups.push(group);
	fake.members.push({group_id: group.id, role: 'owner', user_id: owner.id}, {group_id: group.id, role: 'member', user_id: member.id});

	for (const user of [owner, member]) {
		fake.documents.set(user.id, {
			doc: {...documentWith(SPARE_COPIES), person: undefined, user_id: undefined},
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
	// The Shop publishes when it opens; the server's answer is not what
	// these tests are about.
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

describe('who sees the Shop', () => {
	test('the owner sees Shop in the header on every screen, it opens the Shop, and it stays when the server cannot say', async () => {
		const {fake, owner} = family();
		const {context, errors, page} = await phone(fake, owner);

		await page.locator('#shop-link:not([hidden])').waitFor(TIMEOUT);
		await page.screenshot({path: `${SHOTS}/shop-owner-header.png`});

		// Next to the avatar, on the five tabs' screens and beyond them.
		for (const path of ['sets', 'binders', 'lists', 'profile', 'trade']) {
			await page.goto(url(path));
			await page.locator('#shop-link:not([hidden])').waitFor(TIMEOUT);
		}

		// Spares has no Shop of its own any more.
		await page.locator('#view .view-head h2').filter({hasText: 'Spares'}).waitFor(TIMEOUT);
		assert.equal(await page.locator('#trade-shop').count(), 0);

		await page.click('#shop-link');
		await page.waitForFunction(() => location.pathname.endsWith('/shop'));
		await page.locator('.shop-row').first().waitFor(TIMEOUT);
		assert.equal(await page.getAttribute('#shop-link', 'aria-current'), 'page');
		assert.equal(await page.locator('.tabs a[aria-current="page"]').count(), 0, 'no tab is marked on the Shop');
		assert.equal(await page.locator('#shop-back').count(), 0);
		await page.screenshot({path: `${SHOTS}/shop-owner-open.png`});

		// The next visit, with the server not answering who owns the family,
		// shows it at once from what the phone kept.
		await page.route('**/rest/v1/rpc/group_overview', (route) => route.abort());
		await page.goto(url('cards'));
		await page.locator('#shop-link:not([hidden])').waitFor(TIMEOUT);

		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a member sees no Shop, and the shop address says whose it is', async () => {
		const {fake, member} = family();
		const {context, errors, page} = await phone(fake, member);

		// The answer is in once the phone has kept it.
		await page.waitForFunction(() => {
			try {
				return Object.values(JSON.parse(localStorage.getItem('cardTracker.shopOwner')) || {}).includes(false);
			}
			catch {
				return false;
			}
		}, null, TIMEOUT);
		assert.ok(await page.locator('#shop-link').isHidden());

		await page.goto(url('trade'));
		await page.locator('#view .view-head h2').filter({hasText: 'Spares'}).waitFor(TIMEOUT);
		assert.equal(await page.locator('#trade-shop').count(), 0);
		assert.ok(await page.locator('#shop-link').isHidden());

		await page.goto(url('shop'));
		await page.locator('#shop-not-owner').waitFor(TIMEOUT);
		assert.equal(await page.locator('.shop-row').count(), 0);
		assert.match(await page.locator('#shop-not-owner').textContent(), /The Shop is for the family's owner/);
		await page.screenshot({path: `${SHOTS}/shop-owner-member.png`});

		await page.click('#shop-not-owner a');
		await page.waitForFunction(() => location.pathname.endsWith('/trade'));

		assert.deepEqual(errors, []);
		await context.close();
	});

	test('signed out, no Shop shows in the header', async () => {
		const context = await browser.newContext({serviceWorkers: 'block', viewport: {height: 844, width: 390}});

		await fakeServices(context);
		await fakePokeApi(context);

		const page = await context.newPage();

		await seed(page, server.origin, {binders: [], copies: SPARE_COPIES});
		await page.goto(url('cards'));
		await page.locator('#account').filter({hasText: 'Sign in'}).waitFor(TIMEOUT);
		assert.ok(await page.locator('#shop-link').isHidden());
		await context.close();
	});
});
