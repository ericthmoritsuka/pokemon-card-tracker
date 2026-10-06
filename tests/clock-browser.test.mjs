// Browser tests for the phone clock warning (js/sync.js, "the phone's
// clock"; plans/sync-merge-plan.md commit 12): after each write the offset
// is estimated from the server's updated_at, Phone check shows it, and a
// phone more than 2 minutes off gets one gentle toast. Warn only: no stamp
// is ever changed. Headless Chromium at 360 x 740 against
// tests/pages-server.mjs; Supabase is tests/fake-supabase.mjs, its clock set
// ahead or behind with skewMs.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/clock-browser.test.mjs

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {FakeSupabase} from './fake-supabase.mjs';
import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const VIEWPORT = {height: 740, width: 360};
const MINUTE = 60000;

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

async function device(fake) {
	const context = await browser.newContext({serviceWorkers: 'block', viewport: VIEWPORT});

	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await context.route('https://api.tcgdex.net/**', (route) => route.fulfill({body: '[]', contentType: 'application/json', status: 200}));
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));
	await context.route('https://raw.githubusercontent.com/**', (route) => route.fulfill({status: 404}));
	await fake.attach(context, 'phone');

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err));

	return {context, errors, page};
}

async function signIn(page, fake, email) {
	fake.addUser(email);
	await page.goto(url('signin'));
	await page.fill('#signin-email', email);
	await page.click('button:has-text("Send link")');
	await page.waitForSelector('#check-email');
	await page.goto(`${url()}?code=${fake.issueCode(email)}`);
	await page.waitForSelector('#account.avatar');
	await page.waitForFunction(() => document.getElementById('sync-status')?.textContent === 'Synced', null, {timeout: 15000});
}

// Adds a copy and syncs it: one write to the server.
const saveOne = (page, n) => page.evaluate(async (number) => {
	await (await import('/pokemon-card-tracker/js/collection.js')).addCard({card_id: `tst1-${number}`, catalog: 'international', language: 'en', language_source: 'manual'});
	await (await import('/pokemon-card-tracker/js/sync.js')).syncNow();
}, String(n).padStart(3, '0'));

const estimate = (page) => page.evaluate(async () => (await import('/pokemon-card-tracker/js/sync.js')).clockOffset());

const toasts = (page) => page.locator('#toasts .toast-text').allTextContents();

describe('the offset estimate', () => {
	test('server stamp minus the middle of the request; nothing from a slow round trip', async () => {
		const {context, page} = await device(new FakeSupabase());

		await page.goto(url('cards'));

		const results = await page.evaluate(async () => {
			const {clockGap, clockOffsetEstimate} = await import('/pokemon-card-tracker/js/sync.js');
			const sentAt = Date.parse('2026-10-06T12:00:00.000Z');

			return {
				ahead: clockOffsetEstimate({receivedAt: sentAt + 400, sentAt, stamp: '2026-10-06T11:55:00.200123+00:00'}),
				behind: clockOffsetEstimate({receivedAt: sentAt + 400, sentAt, stamp: '2026-10-06T12:03:00.200999+00:00'}),
				bad: clockOffsetEstimate({receivedAt: sentAt + 400, sentAt, stamp: null}),
				gaps: [clockGap(150000), clockGap(-10 * 60000), clockGap(5 * 3600000), clockGap(-3 * 86400000)],
				slow: clockOffsetEstimate({receivedAt: sentAt + 2000, sentAt, stamp: '2026-10-06T12:03:00.000000+00:00'}),
			};
		});

		assert.equal(results.ahead, -5 * MINUTE, 'the phone 5 minutes ahead');
		assert.equal(results.behind, 3 * MINUTE, 'the phone 3 minutes behind');
		assert.equal(results.bad, null);
		assert.equal(results.slow, null, 'a 2 s round trip says nothing');
		assert.deepEqual(results.gaps, ['3 minutes', '10 minutes', '5 hours', '3 days']);
		await context.close();
	});
});

describe('after a write', () => {
	test('a right clock: no toast, and Phone check says so', async () => {
		const fake = new FakeSupabase();
		const {context, errors, page} = await device(fake);

		await signIn(page, fake, 'right@example.com');
		await saveOne(page, 1);

		const measured = await estimate(page);

		assert.ok(measured, 'measured after the write');
		assert.ok(Math.abs(measured.offsetMs) < 2000, `about zero (${measured.offsetMs} ms)`);
		assert.ok(measured.roundTripMs < 2000);
		await page.waitForTimeout(300);
		assert.ok((await toasts(page)).every((text) => !/clock/.test(text)), 'no clock toast');

		// In the app, not a new load: the estimate lives in memory.
		await page.click('#account');
		await page.click('#profile-phone-check');
		await page.waitForFunction(() => /Phone clock: Right, within 2 minutes of the server/.test(document.querySelector('.report')?.textContent || ''));
		assert.equal(await page.locator('#phone-clock').isHidden(), true);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a phone 10 minutes behind: one gentle toast, Phone check shows it, and no stamp is changed', async () => {
		const fake = new FakeSupabase();
		const {context, errors, page} = await device(fake);

		await signIn(page, fake, 'behind@example.com');
		fake.skewMs = 10 * MINUTE;

		const before = Date.now();

		await saveOne(page, 2);

		const measured = await estimate(page);

		assert.ok(Math.abs(measured.offsetMs - 10 * MINUTE) < 2000, `about 10 minutes (${measured.offsetMs} ms)`);

		await page.waitForFunction(() => [...document.querySelectorAll('#toasts .toast-text')].some((node) => /clock/.test(node.textContent)));
		assert.deepEqual((await toasts(page)).filter((text) => /clock/.test(text)), ['Your phone\'s clock is 10 minutes off. Set it to automatic so edits sync in the right order.']);
		await page.screenshot({path: '/tmp/clock-toast.png'});

		// The copy keeps the phone's own time; the server's row has the
		// server's.
		const row = fake.documents.get(fake.userByEmail('behind@example.com').id);
		const copy = row.doc.cards.find((entry) => entry.card_id === 'tst1-002');

		assert.ok(Math.abs(Date.parse(copy.created_at) - before) < 5000, 'created_at is the phone\'s clock');
		assert.ok(Math.abs(Date.parse(copy.updated_at) - before) < 5000, 'updated_at is the phone\'s clock');

		// Once per app load: another write, no second toast.
		await page.evaluate(() => {
			for (const node of document.querySelectorAll('#toasts .toast')) {
				node.remove();
			}
		});
		await saveOne(page, 3);
		await page.waitForTimeout(500);
		assert.deepEqual((await toasts(page)).filter((text) => /clock/.test(text)), []);

		// Phone check: a card on top and a row in the report.
		await page.click('#account');
		await page.click('#profile-phone-check');
		await page.waitForSelector('#phone-clock:not([hidden])');
		assert.equal(await page.locator('#phone-clock-text').textContent(), 'This phone\'s clock is 10 minutes behind the server. Set the date and time to automatic in the phone\'s settings so edits sync in the right order. The app never changes the clock or your edits\' times.');
		await page.waitForFunction(() => /Phone clock: 10 minutes behind the server/.test(document.querySelector('.report')?.textContent || ''));
		await page.screenshot({fullPage: true, path: '/tmp/clock-phone-check.png'});

		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a phone 5 minutes ahead: the toast, and Phone check says ahead', async () => {
		const fake = new FakeSupabase();
		const {context, errors, page} = await device(fake);

		fake.skewMs = -5 * MINUTE;
		await signIn(page, fake, 'ahead@example.com');
		await saveOne(page, 5);
		await page.waitForFunction(() => [...document.querySelectorAll('#toasts .toast-text')].some((node) => /clock/.test(node.textContent)));
		assert.deepEqual((await toasts(page)).filter((text) => /clock/.test(text)), ['Your phone\'s clock is 5 minutes off. Set it to automatic so edits sync in the right order.']);

		await page.click('#account');
		await page.click('#profile-phone-check');
		await page.waitForFunction(() => /^This phone's clock is 5 minutes ahead of the server\./.test(document.getElementById('phone-clock-text')?.textContent || ''));
		assert.deepEqual(errors, []);
		await context.close();
	});
});
