// Browser tests for What's new (js/whats-new.js): the version line that ends
// Profile, the sheet of releases, "vN ready" with Reload while a newer
// worker waits, and the sheet shown once after Reload brings a new version.
// Headless Chromium at 360 x 740 against tests/pages-server.mjs. Supabase is
// faked (tests/fake-supabase.mjs); TCGdex answers empty.
//
// app.js and sw.js are integrator files, so the worker tests serve them with
// the integration lines this module needs (integrate() below), the same
// lines the integrator adds.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/whats-new.test.mjs

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {FakeSupabase} from './fake-supabase.mjs';
import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const VIEWPORT = {height: 740, width: 360};

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

async function device({serviceWorkers = 'block'} = {}) {
	const context = await browser.newContext({serviceWorkers, viewport: VIEWPORT});

	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await context.route('https://api.tcgdex.net/**', (route) => route.fulfill({body: '[]', contentType: 'application/json', status: 200}));
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));
	await context.route('https://raw.githubusercontent.com/**', (route) => route.fulfill({status: 404}));
	await new FakeSupabase().attach(context, 'phone');

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err));

	return {context, errors, page};
}

// app.js and sw.js as shipped, with sw.js set to `version`. The wiring What's
// new needs is checked here, so a later edit that drops it fails this suite.
async function integrate(version) {
	const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
	let sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');

	for (const line of [
		'import {applyUpdate, showWhatsNewOnce, updateApplying} from \'./js/whats-new.js\';',
		'if (updateApplying()) {',
		'action: () => applyUpdate(worker),',
		'showWhatsNewOnce({controlled: hadController}).catch(() => {});',
	]) {
		assert.ok(app.includes(line), `app.js has: ${line}`);
	}

	assert.ok(!app.includes('let reloading'), 'app.js no longer keeps its own reloading flag');

	for (const line of ['\t\'js/whats-new.js\',\n', '\t\'css/whats-new.css\',\n', '// The version, for Profile\'s line (js/whats-new.js).']) {
		assert.ok(sw.includes(line), `sw.js has: ${line}`);
	}

	sw = sw.replace(/const VERSION = '[^']+';/, `const VERSION = '${version}';`);

	return {app, sw};
}

// Serves app.js and sw.js as the integrator ships them, for `version`.
async function serve(version, {answers = true} = {}) {
	const {app, sw} = await integrate(version);
	const worker = answers ? sw : sw.replace(/\n\t\/\/ The version, for Profile's line[^\n]*\n[^\n]*\n[^\n]*\n\t}\n/, '\n');

	assert.ok(answers || !worker.includes('type === \'version\''), 'the old worker does not answer');
	server.setOverride((pathname) => (pathname === `${BASE}app.js` ? app : pathname === `${BASE}sw.js` ? worker : null));
}

const lineText = (page) => page.locator('#profile-version').evaluate((node) => node.textContent.replace(/\s+/g, ' ').trim());

describe('the releases', () => {
	test('newest first, versions and dates well formed, plain words with no em dash', async () => {
		const {context, errors, page} = await device();

		await page.goto(url('cards'));

		const releases = await page.evaluate(async () => (await import('/pokemon-card-tracker/js/whats-new.js')).RELEASES);

		assert.ok(releases.length >= 2);
		assert.deepEqual(releases.slice(0, 2).map((release) => release.version), ['v37', 'v36']);

		for (const [i, release] of releases.entries()) {
			assert.match(release.version, /^v\d+$/);
			assert.match(release.date, /^\d{4}-\d{2}-\d{2}$/);
			assert.ok(release.items.length >= 2 && release.items.length <= 6, release.version);

			if (i) {
				assert.ok(Number(release.version.slice(1)) < Number(releases[i - 1].version.slice(1)), 'newest first');
			}

			for (const item of release.items) {
				assert.ok(!/[\u2014\u2013]/.test(item), `no em or en dash: ${item}`);
			}
		}

		assert.deepEqual(errors, []);
		await context.close();
	});

	test('the version is read from a shell cache name', async () => {
		const {context, page} = await device();

		await page.goto(url('cards'));

		const read = await page.evaluate(async () => {
			const {versionOfCache} = await import('/pokemon-card-tracker/js/whats-new.js');

			return [versionOfCache('card-tracker-shell-v31'), versionOfCache('card-tracker-images'), versionOfCache('card-tracker-shell-'), versionOfCache(null)];
		});

		assert.deepEqual(read, ['v31', null, null, null]);
		await context.close();
	});
});

describe('Profile without a worker', () => {
	test('ends with "Card Tracker · What\'s new", which opens every release', async () => {
		const {context, errors, page} = await device();

		await page.goto(url('profile'));
		await page.waitForSelector('#profile-version #profile-whats-new');
		assert.equal(await lineText(page), 'Card Tracker · What\'s new');

		// The last thing on Profile.
		assert.equal(await page.evaluate(() => document.querySelector('#profile-version').nextElementSibling), null);

		await page.click('#profile-whats-new');
		await page.waitForSelector('#whats-new-sheet[open]');
		assert.equal(await page.locator('#whats-new-sheet-title').textContent(), 'What\'s new');
		assert.deepEqual(await page.locator('#whats-new-sheet .whats-new-release').evaluateAll((nodes) => nodes.map((node) => node.dataset.version)).then((list) => list.slice(0, 2)), ['v37', 'v36']);
		assert.ok((await page.locator('#whats-new-sheet [data-version="v30"]').textContent()).includes('A small Value button on sets, checklists, and binders.'));
		await page.screenshot({path: '/tmp/whats-new-sheet.png'});

		// Back closes the sheet and stays on Profile.
		await page.goBack();
		await page.waitForSelector('#whats-new-sheet', {state: 'detached'});
		assert.equal(new URL(page.url()).pathname, `${BASE}profile`);

		await page.click('#profile-whats-new');
		await page.click('#whats-new-sheet-close');
		await page.waitForSelector('#whats-new-sheet', {state: 'detached'});
		assert.deepEqual(errors, []);
		await context.close();
	});
});

describe('with the service worker', () => {
	test('first install records the version quietly; Reload to a new one shows its What\'s new once', async () => {
		const {context, errors, page} = await device({serviceWorkers: 'allow'});

		try {
			// First install of v30, a worker from before What's new answered.
			await serve('v30', {answers: false});
			await page.goto(url('cards'));
			await page.evaluate(() => navigator.serviceWorker.ready);
			await page.waitForFunction(() => localStorage.getItem('cardTracker.whatsNewSeen') === 'v30', null, {timeout: 15000});
			assert.equal(await page.locator('#whats-new-sheet').count(), 0, 'nothing shows on the first install');

			await page.reload();
			await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
			await page.goto(url('profile'));
			await page.waitForFunction(() => /Card Tracker v30/.test(document.getElementById('profile-version')?.textContent || ''), null, {timeout: 15000});
			assert.equal(await lineText(page), 'Card Tracker v30 · What\'s new');
			assert.equal(await page.locator('#whats-new-sheet').count(), 0);

			// v31 is released and waits.
			await serve('v31');
			await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
			await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting), null, {timeout: 30000});
			await page.waitForSelector('#profile-version-reload', {timeout: 15000});
			assert.equal(await lineText(page), 'Card Tracker v30 · v31 ready Reload · What\'s new');
			await page.screenshot({path: '/tmp/whats-new-ready.png'});

			// Reload from Profile does what the toast's Reload does.
			await page.click('#profile-version-reload');
			await page.waitForSelector('#whats-new-sheet[open]', {timeout: 30000});
			assert.equal(await page.locator('#whats-new-sheet-title').textContent(), 'What\'s new in v31');
			assert.ok((await page.locator('#whats-new-sheet .whats-new-items').textContent()).includes('and this list after each update.'));
			assert.equal(await page.evaluate(() => localStorage.getItem('cardTracker.whatsNewSeen')), 'v31');
			await page.screenshot({path: '/tmp/whats-new-after-reload.png'});
			await page.click('#whats-new-sheet-close');

			// Once: the next load shows nothing, and Profile says v31.
			await page.goto(url('profile'));
			await page.waitForFunction(() => /Card Tracker v31/.test(document.getElementById('profile-version')?.textContent || ''), null, {timeout: 15000});
			await page.waitForTimeout(1000);
			assert.equal(await page.locator('#whats-new-sheet').count(), 0);
			assert.deepEqual(errors, []);
		}
		finally {
			server.setOverride(null);
			await context.close();
		}
	});

	test('a reload before the new worker answers is still a first install', async () => {
		const {context, errors, page} = await device({serviceWorkers: 'allow'});

		try {
			await serve('v30', {answers: false});
			await page.goto(url('cards'));
			await page.evaluate(() => navigator.serviceWorker.ready);
			await page.reload();
			await page.waitForFunction(() => localStorage.getItem('cardTracker.whatsNewSeen') === 'v30', null, {timeout: 15000});
			await page.waitForTimeout(500);
			assert.equal(await page.locator('#whats-new-sheet').count(), 0);
			assert.deepEqual(errors, []);
		}
		finally {
			server.setOverride(null);
			await context.close();
		}
	});

	test('a page from a version before What\'s new shows it after the update', async () => {
		const {context, errors, page} = await device({serviceWorkers: 'allow'});

		try {
			await serve('v30', {answers: false});
			await page.goto(url('cards'));
			await page.evaluate(() => navigator.serviceWorker.ready);
			await page.waitForFunction(() => localStorage.getItem('cardTracker.whatsNewSeen') === 'v30', null, {timeout: 15000});
			await page.reload();
			await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));

			// As v30 left it: nothing recorded, once this load has looked.
			await page.waitForTimeout(1500);
			assert.equal(await page.locator('#whats-new-sheet').count(), 0);
			await page.evaluate(() => localStorage.removeItem('cardTracker.whatsNewSeen'));
			await serve('v31');
			await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
			await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.getRegistration()).waiting), null, {timeout: 30000});

			// The toast's Reload.
			await page.getByRole('button', {name: 'Reload'}).first().click();
			await page.waitForSelector('#whats-new-sheet[open]', {timeout: 30000});
			assert.equal(await page.locator('#whats-new-sheet-title').textContent(), 'What\'s new in v31');
			assert.deepEqual(errors, []);
		}
		finally {
			server.setOverride(null);
			await context.close();
		}
	});
});
