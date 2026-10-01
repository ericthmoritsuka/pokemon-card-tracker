// Browser tests for the name-and-password sign-in, meant for a family member
// with no email, and for Change password in Profile. Headless Chromium at
// 360 x 740 against tests/pages-server.mjs.
//
// Supabase is never reached: every request to the project is answered by
// tests/fake-supabase.mjs. The accounts and passwords are made up.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/account-password.test.mjs

import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {FakeSupabase} from './fake-supabase.mjs';
import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const VIEWPORT = {height: 740, width: 360};

// Invented, for the fake only.
const FIRST_PASSWORD = 'first-test-pass';
const NEW_PASSWORD = 'second-test-pass';

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

async function device(fake, name) {
	const context = await browser.newContext({serviceWorkers: 'block', viewport: VIEWPORT});

	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await context.route('https://api.tcgdex.net/**', (route) => route.fulfill({body: '{}', contentType: 'application/json', status: 404}));
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));
	await fakePokeApi(context);
	await fake.attach(context, name);

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err));

	return {context, errors, page};
}

// A family group owned by an email account, so the member's first sign-in
// does not make a group of its own.
function familyOf(fake, owner, ...members) {
	const group = {id: randomUUID(), name: 'Family', owner_id: owner.id};

	fake.groups.push(group);
	fake.members.push({group_id: group.id, role: 'owner', user_id: owner.id});

	for (const member of members) {
		fake.members.push({group_id: group.id, role: 'member', user_id: member.id});
	}

	return group;
}

const passwordSignIns = (fake) => fake.log.filter((entry) => entry.path === '/auth/v1/token' && entry.search === '?grant_type=password');

async function openPasswordForm(page) {
	await page.goto(url('signin'));
	await page.click('#signin-use-password');
	await page.waitForSelector('#signin-password-form');
}

async function signInWithName(page, name, password) {
	await openPasswordForm(page);
	await page.fill('#signin-name', name);
	await page.fill('#signin-password', password);
	await page.click('#signin-password-form button[type="submit"]');
	await page.waitForSelector('#account.avatar');
}

describe('name and password', () => {
	test('a bare name gets the placeholder domain, and a wrong name or password reads the same', async () => {
		const fake = new FakeSupabase();
		const owner = fake.addUser('owner@example.test');
		const member = fake.addUser('member.a@family.invalid', {password: FIRST_PASSWORD});

		familyOf(fake, owner, member);

		const {context, errors, page} = await device(fake, 'phone');

		await openPasswordForm(page);
		assert.equal(await page.locator('#signin-name').getAttribute('autocomplete'), 'username');
		assert.equal(await page.locator('#signin-password').getAttribute('type'), 'password');

		// Trimmed and lowercased, then the domain added.
		await page.fill('#signin-name', '  Member.A ');
		await page.fill('#signin-password', 'not-the-password');
		await page.click('#signin-password-form button[type="submit"]');

		const mismatch = 'That name and password do not match. Ask the family owner if you forgot it.';

		await page.waitForSelector(`#signin-password-form .form-error:has-text("${mismatch}")`);
		assert.equal(passwordSignIns(fake).at(-1).body.email, 'member.a@family.invalid');

		// No account by that name: the same words, so a name cannot be probed.
		await page.fill('#signin-name', 'member.b');
		await page.click('#signin-password-form button[type="submit"]');
		await page.waitForFunction(() => document.querySelector('#signin-password-form button[type="submit"]').textContent === 'Sign in');
		assert.equal(await page.locator('#signin-password-form .form-error').textContent(), mismatch);
		assert.equal(passwordSignIns(fake).at(-1).body.email, 'member.b@family.invalid');

		await page.fill('#signin-name', 'Member.A');
		await page.fill('#signin-password', FIRST_PASSWORD);
		await page.click('#signin-password-form button[type="submit"]');
		await page.waitForSelector('#account.avatar');
		await page.waitForSelector('text=You are signed in as member.a.');
		assert.ok(!(await page.locator('main').textContent()).includes('family.invalid'), 'the placeholder domain is not shown');

		// Back to the email form from the password one.
		const fresh = await device(fake, 'other');

		await openPasswordForm(fresh.page);
		await fresh.page.click('button:has-text("Use an email link instead")');
		await fresh.page.waitForSelector('#signin-email');
		await fresh.context.close();

		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a name with "@" is used as typed, so an email and a password work too', async () => {
		const fake = new FakeSupabase();

		fake.addUser('owner@example.test', {password: FIRST_PASSWORD});

		const {context, errors, page} = await device(fake, 'phone');

		await signInWithName(page, ' Owner@Example.test', FIRST_PASSWORD);
		assert.equal(passwordSignIns(fake).at(-1).body.email, 'owner@example.test');

		// An email account has no Change password.
		await page.click('#account');
		await page.waitForSelector('#profile-email');
		assert.equal(await page.locator('#profile-email').textContent(), 'owner@example.test');
		assert.equal(await page.locator('#password-card').count(), 0);
		assert.ok(!/null/.test(await page.locator('main').textContent()), 'no stray text where the card would be');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('Profile for a name account: the name, not the placeholder, and Change password', async () => {
		const fake = new FakeSupabase();
		const owner = fake.addUser('owner@example.test');
		const member = fake.addUser('member.a@family.invalid', {password: FIRST_PASSWORD});

		familyOf(fake, owner, member);

		const {context, errors, page} = await device(fake, 'phone');

		await signInWithName(page, 'member.a', FIRST_PASSWORD);
		await page.click('#account');
		await page.waitForSelector('#password-card');
		assert.equal(await page.locator('#profile-email').textContent(), 'member.a');
		await page.waitForSelector('.member:has-text("owner@example.test")');
		assert.match(await page.locator('.member', {hasText: '(you)'}).textContent(), /^member\.a \(you\)Member · member\.a$/);
		assert.ok(!(await page.locator('main').textContent()).includes('family.invalid'), 'the placeholder domain is not shown');
		assert.ok(!(await page.locator('#family').textContent()).includes('null'), 'no stray text under a member\'s family list');

		const status = page.locator('#password-status');
		const submit = () => page.click('#password-card button[type="submit"]');
		const changes = () => fake.log.filter((entry) => entry.path === '/auth/v1/user' && entry.method === 'PUT');

		await page.fill('#new-password', 'short');
		await page.fill('#repeat-password', 'short');
		await submit();
		assert.equal(await status.textContent(), 'Use at least 8 characters.');

		await page.fill('#new-password', NEW_PASSWORD);
		await page.fill('#repeat-password', `${NEW_PASSWORD}x`);
		await submit();
		assert.match(await status.textContent(), /do not match/);
		assert.equal(changes().length, 0, 'nothing sent before the checks pass');

		await page.fill('#repeat-password', NEW_PASSWORD);
		await submit();
		await page.waitForSelector('#password-status:has-text("Password changed")');
		assert.equal(changes().at(-1).body.password, NEW_PASSWORD);
		assert.equal(fake.passwords.get(member.id), NEW_PASSWORD);
		assert.equal(await page.locator('#new-password').inputValue(), '');

		// The server refuses the same password again, in plain words.
		await page.fill('#new-password', NEW_PASSWORD);
		await page.fill('#repeat-password', NEW_PASSWORD);
		await submit();
		await page.waitForSelector('#password-status:has-text("the password you have now")');
		await page.screenshot({fullPage: true, path: '/tmp/card-tracker-profile-password.png'});

		// The new password signs in on another phone; the first one no longer does.
		const other = await device(fake, 'other');

		await openPasswordForm(other.page);
		await other.page.fill('#signin-name', 'member.a');
		await other.page.fill('#signin-password', FIRST_PASSWORD);
		await other.page.click('#signin-password-form button[type="submit"]');
		await other.page.waitForSelector('#signin-password-form .form-error:has-text("do not match")');
		await other.page.fill('#signin-password', NEW_PASSWORD);
		await other.page.click('#signin-password-form button[type="submit"]');
		await other.page.waitForSelector('#account.avatar');
		assert.deepEqual(other.errors, []);
		await other.context.close();

		assert.deepEqual(errors, []);
		await context.close();
	});

	test('an email-link account sees no Change password, and the owner sees the member by name', async () => {
		const fake = new FakeSupabase();
		const owner = fake.addUser('owner@example.test');
		const member = fake.addUser('member.a@family.invalid', {password: FIRST_PASSWORD});

		familyOf(fake, owner, member);

		const {context, errors, page} = await device(fake, 'phone');
		const session = fake.session(owner);

		// Signed in the way a dashboard invitation link does it.
		await page.goto(`${url()}#access_token=${session.access_token}&expires_in=3600&refresh_token=${session.refresh_token}&token_type=bearer&type=invite`);
		await page.waitForSelector('#account.avatar');
		await page.click('#account');
		await page.waitForSelector('.member:has-text("member.a")');
		assert.equal(await page.locator('#password-card').count(), 0);
		assert.equal(await page.locator('.member', {hasText: 'member.a'}).locator('.muted').textContent(), 'Member · member.a');
		assert.ok(!(await page.locator('.members').textContent()).includes('family.invalid'), 'the placeholder domain is not shown');

		// Add member tells the owner which address such an account uses.
		assert.match(await page.locator('#add-member').textContent(), /name@family\.invalid/);
		assert.deepEqual(errors, []);
		await context.close();
	});
});
