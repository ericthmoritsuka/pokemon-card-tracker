// Browser tests for What's new (js/whats-new.js): the version line that ends
// Profile, the sheet of releases, "vN ready" with Reload while a newer
// worker waits, and the sheet shown once after Reload brings a new version.
// Also the switch to a waiting version by itself when the app comes back
// after a while away (js/auto-update.js), the moments it waits out, what it
// keeps across the reload, and the wait for the new worker to be activated.
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

import {fakeRates} from './fake-rates.mjs';
import {FakeSupabase} from './fake-supabase.mjs';
import {startPagesServer} from './pages-server.mjs';
import {untilInPage} from './poll.mjs';

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
	await fakeRates(context);

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

// The start of sw.js's activate step, where activateMs puts its wait.
const ACTIVATE_STEP = 'self.addEventListener(\'activate\', (event) => {\n\tevent.waitUntil(\n\t\t(async () => {\n';

// Serves app.js and sw.js as the integrator ships them, for `version`.
// activateMs: the worker's activate step takes that long, as one held up
// would.
async function serve(version, {activateMs = 0, answers = true} = {}) {
	const {app, sw} = await integrate(version);
	let worker = answers ? sw : sw.replace(/\n\t\/\/ The version, for Profile's line[^\n]*\n[^\n]*\n[^\n]*\n\t}\n/, '\n');

	assert.ok(answers || !worker.includes('type === \'version\''), 'the old worker does not answer');

	if (activateMs) {
		assert.ok(worker.includes(ACTIVATE_STEP), 'sw.js has its activate step');
		worker = worker.replace(ACTIVATE_STEP, `${ACTIVATE_STEP}\t\t\tawait new Promise((resolve) => setTimeout(resolve, ${activateMs}));\n`);
	}

	server.setOverride((pathname) => (pathname === `${BASE}app.js` ? app : pathname === `${BASE}sw.js` ? worker : null));
}

const lineText = (page) => page.locator('#profile-version').evaluate((node) => node.textContent.replace(/\s+/g, ' ').trim());

// Asks for the update until the new worker is installed and waiting. One
// update() call is not enough: a navigation makes Chromium check for an
// update itself about a second later, and an update() made while that check
// is running joins it, so it resolves with the script that check fetched,
// from before serve() changed it, and nothing installs. On a busy machine
// that check lands after serve(). A call while a worker installs waits.
const updateUntilWaiting = (page, version) => untilInPage(page, `the ${version} worker to be waiting`, async () => {
	const registration = await navigator.serviceWorker.getRegistration();

	if (registration.waiting) {
		return true;
	}

	if (!registration.installing) {
		await registration.update().catch(() => {});
	}

	return false;
}, {interval: 250, timeout: 30000});

// Headless Chromium is always visible, so the switch tests stand in for
// document.visibilityState: window.__visibility holds it, and setVisible()
// changes it and fires visibilitychange, as switching tabs or apps does.
// They stand in for time passing too: Date.now runs ahead by what
// sessionStorage holds, so a reload keeps the clock where it was. And each
// reload records, as it starts, the state of the worker controlling the
// page.
function standIns() {
	window.__visibility = 'visible';
	Object.defineProperty(Document.prototype, 'visibilityState', {configurable: true, get: () => window.__visibility});
	Object.defineProperty(Document.prototype, 'hidden', {configurable: true, get: () => window.__visibility === 'hidden'});

	const now = Date.now;
	let ahead = 0;

	try {
		ahead = Number(sessionStorage.getItem('__clockAhead')) || 0;
	}
	catch {
		// about:blank
	}

	Date.now = () => now.call(Date) + ahead;
	window.__clockAhead = () => ahead;
	window.__setClockAhead = (ms) => {
		ahead = ms;
		sessionStorage.setItem('__clockAhead', String(ms));
	};
	window.addEventListener('beforeunload', () => {
		const controller = navigator.serviceWorker && navigator.serviceWorker.controller;

		window.__leaving = true;
		sessionStorage.setItem('__unloadState', controller ? controller.state : 'none');
	});
}

const setVisible = (page, visible) => page.evaluate((state) => {
	window.__visibility = state;
	document.dispatchEvent(new Event('visibilitychange'));
}, visible ? 'visible' : 'hidden');

// js/auto-update.js AWAY_MS is five minutes: a minute under it, a minute
// over it.
const SHORT_AWAY = 4 * 60 * 1000;
const LONG_AWAY = 6 * 60 * 1000;

// Away for `ms` and back, as reopening the app or the browser tab does.
async function awayAndBack(page, ms) {
	await setVisible(page, false);
	await page.evaluate((add) => window.__setClockAhead(window.__clockAhead() + add), ms);
	await page.waitForTimeout(200);
	await setVisible(page, true);
}

// A tap as the person makes it, pointerdown first, on an element the update
// toast may cover at this size.
const tap = (page, selector) => page.locator(selector).first().evaluate((node) => {
	node.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));
	node.click();
});

// Marks this load, so a test can tell whether the page reloaded since.
const markLoad = (page) => page.evaluate(() => {
	window.__sameLoad = true;
});

const sameLoad = (page) => page.evaluate(() => window.__sameLoad === true);

// The state of the worker in control as the last reload started.
const unloadState = (page) => page.evaluate(() => sessionStorage.getItem('__unloadState'));

// v30 installed and in control of the page, its version recorded, so a
// later version shows its What's new.
async function onV30(page, path = 'cards') {
	await serve('v30');
	await page.goto(url(path));
	await page.evaluate(() => navigator.serviceWorker.ready);
	await page.waitForFunction(() => localStorage.getItem('cardTracker.whatsNewSeen') === 'v30', null, {timeout: 15000});
	await page.reload();
	await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
}

// The version the page runs under, as Profile's line reads it.
const runningVersion = (page) => page.evaluate(async () => (await (await import('/pokemon-card-tracker/js/whats-new.js')).appVersions()).current);

// Closing a sheet takes its history entry away with history.go(-1) on a
// timer (js/sheet.js goBack). A page.goto made before that traversal runs is
// cancelled by it (net::ERR_ABORTED), which a busy machine makes likely.
const sheetEntryGone = (page) => page.waitForFunction(() => !(history.state && history.state.sheet), null, {timeout: 15000});

describe('the releases', () => {
	test('newest first, versions and dates well formed, plain words with no em dash', async () => {
		const {context, errors, page} = await device();

		await page.goto(url('cards'));

		const releases = await page.evaluate(async () => (await import('/pokemon-card-tracker/js/whats-new.js')).RELEASES);

		assert.ok(releases.length >= 2);
		assert.deepEqual(releases.slice(0, 2).map((release) => release.version), ['v124', 'v123']);

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
		assert.deepEqual(await page.locator('#whats-new-sheet .whats-new-release').evaluateAll((nodes) => nodes.map((node) => node.dataset.version)).then((list) => list.slice(0, 2)), ['v124', 'v123']);
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
			await updateUntilWaiting(page, 'v31');
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
			await sheetEntryGone(page);

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
			await updateUntilWaiting(page, 'v31');

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

describe('switching to a waiting version by itself', () => {
	// Each test: v30 in control, v31 waiting, the stand-ins above, and the
	// page marked so a reload shows.
	async function waiting(path = 'cards', {activateMs = 0, context, page} = {}) {
		await onV30(page, path);

		if (path !== 'cards') {
			await page.goto(url(path));
			await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
		}

		await serve('v31', {activateMs});
		await updateUntilWaiting(page, 'v31');
		await page.getByRole('button', {name: 'Reload'}).first().waitFor({timeout: 15000});
		await markLoad(page);

		return {context, page};
	}

	async function switched(page) {
		await page.waitForFunction(() => document.getElementById('whats-new-sheet-title')?.textContent === 'What\'s new in v31', null, {timeout: 30000});
		assert.equal(await sameLoad(page), false, 'the page reloaded');
		assert.equal(await runningVersion(page), 'v31');
		assert.equal(await unloadState(page), 'activated', 'the reload waited for the new worker to be activated');
	}

	async function noSwitch(page, why) {
		await page.waitForTimeout(2500);
		assert.ok(await sameLoad(page), why);
	}

	test('nothing moves in view or after a short time away; a long time away switches, and the page works after', async () => {
		const {context, errors, page} = await device({serviceWorkers: 'allow'});

		await context.addInitScript(standIns);

		try {
			await waiting('cards', {context, page});
			await page.waitForTimeout(1500);
			assert.ok(await sameLoad(page), 'no switch while the page stays in view');

			await awayAndBack(page, SHORT_AWAY);
			await noSwitch(page, 'no switch after a short time away');

			await awayAndBack(page, LONG_AWAY);
			await switched(page);
			assert.equal(new URL(page.url()).pathname, `${BASE}cards`);
			assert.ok(await page.evaluate(() => Number(sessionStorage.getItem('cardTracker.autoUpdateAt')) > 0), 'the switch is stamped against a loop');

			// The page works: What's new closes, and the tabs and Profile
			// open, on v31.
			await page.click('#whats-new-sheet-close');
			await sheetEntryGone(page);
			await page.click('.tabs a[data-tab="sets"]');
			await page.waitForFunction(() => location.pathname.endsWith('/sets') && document.title.startsWith('Sets'), null, {timeout: 15000});
			await page.click('#account');
			await page.waitForFunction(() => /Card Tracker v31/.test(document.getElementById('profile-version')?.textContent || ''), null, {timeout: 15000});
			assert.deepEqual(errors, []);
		}
		finally {
			server.setOverride(null);
			await context.close();
		}
	});

	test('a version found on coming back after a long time away takes over once installed, before anything is touched', async () => {
		const {context, errors, page} = await device({serviceWorkers: 'allow'});

		await context.addInitScript(standIns);

		try {
			await onV30(page);
			await markLoad(page);
			await serve('v31');

			// Back after a long time: the page asks for the update itself.
			await awayAndBack(page, LONG_AWAY);
			await switched(page);
			assert.deepEqual(errors, []);
		}
		finally {
			server.setOverride(null);
			await context.close();
		}
	});

	test('a screen change never switches: not with a sheet just closed, not after a short time away', async () => {
		const {context, errors, page} = await device({serviceWorkers: 'allow'});

		await context.addInitScript(standIns);

		try {
			await waiting('profile', {context, page});

			// Every release's What's new, open as a sheet over Profile: a long
			// time away waits it out.
			await tap(page, '#profile-whats-new');
			await page.waitForSelector('#whats-new-sheet[open]');
			await awayAndBack(page, LONG_AWAY);
			await noSwitch(page, 'no switch while a sheet is open');
			assert.equal(await page.locator('#whats-new-sheet-title').textContent(), 'What\'s new');

			// Closed, then from screen to screen: never.
			await tap(page, '#whats-new-sheet-close');
			await sheetEntryGone(page);

			for (const tab of ['cards', 'sets', 'lists', 'cards']) {
				await tap(page, `.tabs a[data-tab="${tab}"]`);
				await page.waitForFunction((name) => location.pathname.endsWith(`/${name}`), tab, {timeout: 15000});
				await page.waitForTimeout(1000);
				assert.ok(await sameLoad(page), `no switch on moving to ${tab}`);
			}

			await awayAndBack(page, SHORT_AWAY);
			await noSwitch(page, 'no switch after a short time away');

			await awayAndBack(page, LONG_AWAY);
			await switched(page);
			assert.deepEqual(errors, []);
		}
		finally {
			server.setOverride(null);
			await context.close();
		}
	});

	test('Scan with a card in the tray waits, leaving Scan does not switch, and the tray is kept', async () => {
		const {context, errors, page} = await device({serviceWorkers: 'allow'});

		await context.addInitScript(standIns);

		try {
			await onV30(page);

			// One card in the scanner's tray, then Scan opens.
			await page.evaluate(async () => {
				const draft = await import('/pokemon-card-tracker/js/scan/draft.js');
				const S = await import('/pokemon-card-tracker/js/scan/session.js');
				const session = S.newSession();

				Object.assign(S.addCapture(session, {id: 'tray-1'}), {
					card: {catalog: 'international', id: 'me01-001', lang: 'en', localId: '1', name: 'Bulbasaur', official: '132', setId: 'me01', setName: 'Mega Evolution'},
					confirmed: true,
					language: 'en',
					languageBy: 'hand',
					status: 'ready',
					sure: true,
					variantId: null,
					variants: [],
				});
				await draft.saveSession(session);
			});
			await tap(page, '.tabs a[data-tab="scan"]');
			await page.waitForFunction(() => document.getElementById('scan-dot')?.textContent === '1', null, {timeout: 15000});
			assert.equal(new URL(page.url()).pathname, `${BASE}scan`);

			await serve('v31');
			await updateUntilWaiting(page, 'v31');
			await markLoad(page);

			// A long time away, back on Scan: no switch.
			await awayAndBack(page, LONG_AWAY);
			await noSwitch(page, 'no switch while Scan is open');
			assert.equal(await page.locator('#whats-new-sheet').count(), 0);

			// Leaving Scan (its Close goes back to My Cards) is no moment
			// either.
			await tap(page, '#scan-close');
			await page.waitForFunction(() => location.pathname.endsWith('/cards'), null, {timeout: 15000});
			await noSwitch(page, 'no switch on leaving Scan');

			await awayAndBack(page, LONG_AWAY);
			await switched(page);
			assert.equal(new URL(page.url()).pathname, `${BASE}cards`);

			const tray = await page.evaluate(async () => (await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession()).items.map((item) => item.id));

			assert.deepEqual(tray, ['tray-1'], 'the tray survives the switch');
			assert.deepEqual(errors, []);
		}
		finally {
			server.setOverride(null);
			await context.close();
		}
	});

	test('a choice made in a form, and a toast offering Undo, each wait, and leaving the screen does not switch', async () => {
		// 2026-11-20: an Edit binder form with a new colour and grid, nothing
		// typed, was thrown away by the switch (an inline form, not a sheet).
		const {context, errors, page} = await device({serviceWorkers: 'allow'});

		await context.addInitScript(standIns);

		try {
			await waiting('profile', {context, page});

			// A toast offering Undo waits.
			await page.evaluate(async () => {
				(await import('/pokemon-card-tracker/js/shell.js')).toast('Removed a copy.', {action: () => {}, actionLabel: 'Undo', timeout: 60000});
			});
			await page.waitForFunction(() => [...document.querySelectorAll('.toast button.small')].some((button) => button.textContent === 'Undo'), null, {timeout: 15000});
			await awayAndBack(page, LONG_AWAY);
			await noSwitch(page, 'no switch while Undo is offered');
			await page.evaluate(() => document.querySelectorAll('.toast').forEach((item) => item.remove()));

			// A select changed by a tap, as Edit binder's colour is, waits too.
			await page.evaluate(() => {
				const select = document.createElement('select');

				select.id = 'qa-grid';
				select.append(new Option('3 x 3', '3'), new Option('4 x 4', '4'));
				document.getElementById('view').append(select);
				select.value = '4';
				select.dispatchEvent(new Event('change', {bubbles: true}));
			});
			await awayAndBack(page, LONG_AWAY);
			await noSwitch(page, 'no switch after a choice in a form');

			// Leaving the screen is no moment.
			await tap(page, '.tabs a[data-tab="cards"]');
			await page.waitForFunction(() => location.pathname.endsWith('/cards'), null, {timeout: 15000});
			await noSwitch(page, 'no switch on leaving the screen');

			await awayAndBack(page, LONG_AWAY);
			await switched(page);
			assert.deepEqual(errors, []);
		}
		finally {
			server.setOverride(null);
			await context.close();
		}
	});

	test('a card in hand on a binder comes through the switch', async () => {
		// 2026-11-20: Add to binder's card in hand was dropped by the switch
		// the move to the binder itself set off.
		const {context, errors, page} = await device({serviceWorkers: 'allow'});
		const record = JSON.parse(await readFile(new URL('./prices-fixtures/en-sv08.5-001.json', import.meta.url), 'utf8'));

		await context.route('https://api.tcgdex.net/**', (route) => (new URL(route.request().url()).pathname === `/v2/en/cards/${record.id}`
			? route.fulfill({body: JSON.stringify(record), contentType: 'application/json', status: 200})
			: route.fulfill({body: '{}', contentType: 'application/json', status: 404})));
		await context.addInitScript(standIns);

		try {
			await onV30(page);

			const binderId = await page.evaluate(async (cardId) => {
				const collection = await import('/pokemon-card-tracker/js/collection.js');
				const binders = await import('/pokemon-card-tracker/js/binders.js');

				await collection.addCard({card_id: cardId, catalog: 'international', language: 'en', language_source: 'manual'});

				return (await binders.createBinder({cols: 3, cover_color: '#1d2e60', name: 'Vitrine', page_count: 2, rows: 3})).id;
			}, record.id);

			await waiting(`cards/en/${record.id}`, {context, page});
			await page.waitForSelector('#copies-binder');

			// Add to binder, Vitrine: the card is in hand on the binder.
			await tap(page, '#copies-binder');
			await page.waitForSelector('#add-binder-sheet[open]');
			await tap(page, '#add-binder-list .atb-binder');
			await page.waitForSelector('#binder-hand:not([hidden])');
			await page.waitForFunction(() => document.getElementById('bh-name')?.textContent === 'Exeggcute', null, {timeout: 15000});
			await page.waitForTimeout(1000);
			assert.ok(await sameLoad(page), 'no switch on moving to the binder');

			await awayAndBack(page, LONG_AWAY);
			await switched(page);
			assert.equal(new URL(page.url()).pathname, `${BASE}binders/${binderId}`);
			await page.click('#whats-new-sheet-close');
			await sheetEntryGone(page);
			await page.waitForSelector('#binder-hand:not([hidden])', {timeout: 15000});
			await page.waitForFunction(() => document.getElementById('bh-name')?.textContent === 'Exeggcute', null, {timeout: 15000});
			assert.equal(await page.locator('#bh-status').textContent(), 'Tap an empty pocket');

			// Kept for that one load: a reload by hand opens the binder
			// without it, as before.
			await page.reload();
			await page.waitForSelector('#binder-spread');
			await page.waitForTimeout(1000);
			assert.ok(await page.locator('#binder-hand').isHidden(), 'a later reload opens the binder without it');
			assert.deepEqual(errors, []);
		}
		finally {
			server.setOverride(null);
			await context.close();
		}
	});

	test('a family member\'s view-only lens comes through the switch', async () => {
		// 2026-11-20: a member's lens on Sets fell back to the person's own
		// cards after the switch.
		const {context, errors, page} = await device({serviceWorkers: 'allow'});

		await context.addInitScript(standIns);

		try {
			await waiting('cards', {context, page});
			await page.evaluate(async () => (await import('/pokemon-card-tracker/js/dom.js')).go('family/member-1'));
			await page.waitForSelector('#family-strip');
			await tap(page, '.tabs a[data-tab="sets"]');
			await page.waitForFunction(() => location.pathname.endsWith('/sets') && /collection, view only/.test(document.getElementById('family-strip')?.textContent || ''), null, {timeout: 15000});
			await page.waitForTimeout(1000);
			assert.ok(await sameLoad(page), 'no switch on moving to Sets');

			await awayAndBack(page, LONG_AWAY);
			await switched(page);
			assert.equal(new URL(page.url()).pathname, `${BASE}sets`);
			assert.match(await page.locator('#family-strip').textContent(), /collection, view only/);
			assert.equal(await page.evaluate(async () => (await import('/pokemon-card-tracker/js/shell.js')).lensMember()?.userId), 'member-1');

			// Kept for that one load: a reload by hand shows your own, as
			// before.
			await page.reload();
			await page.waitForFunction(() => document.title.startsWith('Sets'), null, {timeout: 15000});
			await page.waitForTimeout(1000);
			assert.equal(await page.locator('#family-strip').count(), 0, 'a later reload ends the lens');
			assert.deepEqual(errors, []);
		}
		finally {
			server.setOverride(null);
			await context.close();
		}
	});
});

describe('the wait for the new version to be activated', () => {
	// Until the v31 worker is activating, or the page has asked for a reload
	// (which the test then reports).
	const untilActivatingOrLeaving = (page) => untilInPage(page, 'the v31 worker to be activating', async () => window.__leaving === true || (await navigator.serviceWorker.getRegistration()).active?.state === 'activating', {interval: 100, timeout: 15000});

	test('the reload waits until the new worker is activated', async () => {
		const {context, errors, page} = await device({serviceWorkers: 'allow'});

		await context.addInitScript(standIns);

		try {
			await onV30(page);
			await serve('v31', {activateMs: 3000});
			await updateUntilWaiting(page, 'v31');
			await markLoad(page);
			await awayAndBack(page, LONG_AWAY);

			// Activating: the page is still the same load.
			await untilActivatingOrLeaving(page);
			assert.ok(await sameLoad(page), 'no reload while the worker activates');
			assert.equal(await page.evaluate(() => window.__leaving === true), false, 'no reload asked for while the worker activates');

			await page.waitForSelector('#whats-new-sheet[open]', {timeout: 30000});
			assert.equal(await sameLoad(page), false, 'the page reloaded');
			assert.equal(await unloadState(page), 'activated');
			assert.equal(await runningVersion(page), 'v31');
			assert.deepEqual(errors, []);
		}
		finally {
			server.setOverride(null);
			await context.close();
		}
	});

	test('a tap while the new worker activates stops the reload, and Reload stays offered', async () => {
		const {context, errors, page} = await device({serviceWorkers: 'allow'});

		await context.addInitScript(standIns);

		try {
			await onV30(page);
			await serve('v31', {activateMs: 3000});
			await updateUntilWaiting(page, 'v31');
			await markLoad(page);
			await awayAndBack(page, LONG_AWAY);
			await untilActivatingOrLeaving(page);
			assert.equal(await page.evaluate(() => window.__leaving === true), false, 'no reload asked for while the worker activates');

			// The person starts using the page before activation ends.
			await tap(page, '.tabs a[data-tab="lists"]');
			await untilInPage(page, 'the v31 worker to be activated', async () => (await navigator.serviceWorker.getRegistration()).active?.state === 'activated', {interval: 250, timeout: 30000});
			await page.waitForTimeout(1500);
			assert.ok(await sameLoad(page), 'no reload once the person used the page');
			assert.equal(await page.evaluate(() => window.__leaving === true), false);
			assert.equal(new URL(page.url()).pathname, `${BASE}lists`);
			await page.getByRole('button', {name: 'Reload'}).first().waitFor({timeout: 5000});
			assert.deepEqual(errors, []);
		}
		finally {
			server.setOverride(null);
			await context.close();
		}
	});

	test('a worker not activated in time leaves the page as it is, working, with Reload offered', async () => {
		const {context, errors, page} = await device({serviceWorkers: 'allow'});

		await context.addInitScript(standIns);

		try {
			await onV30(page);
			// Longer than js/whats-new.js ACTIVATE_MS, ten seconds.
			await serve('v31', {activateMs: 20000});
			await updateUntilWaiting(page, 'v31');
			await markLoad(page);
			await awayAndBack(page, LONG_AWAY);
			await untilActivatingOrLeaving(page);

			// Past the ten seconds: no reload asked for, and Reload offered.
			await page.waitForTimeout(12000);
			assert.ok(await sameLoad(page), 'the same page');
			assert.equal(await page.evaluate(() => window.__leaving === true), false, 'no reload asked for');
			await page.getByRole('button', {name: 'Reload'}).first().waitFor({timeout: 5000});

			// Still in use: a tab opens.
			await tap(page, '.tabs a[data-tab="lists"]');
			await page.waitForFunction(() => location.pathname.endsWith('/lists') && document.title.startsWith('Lists'), null, {timeout: 15000});

			// Activated later: nothing reloads by itself.
			await untilInPage(page, 'the v31 worker to be activated', async () => (await navigator.serviceWorker.getRegistration()).active?.state === 'activated', {interval: 250, timeout: 30000});
			await page.waitForTimeout(1500);
			assert.ok(await sameLoad(page), 'no reload when the worker activates late');
			assert.equal(await page.evaluate(() => window.__leaving === true), false);

			// Reload, tapped, loads v31.
			await page.getByRole('button', {name: 'Reload'}).first().click();
			await page.waitForSelector('#whats-new-sheet[open]', {timeout: 30000});
			assert.equal(await runningVersion(page), 'v31');
			assert.deepEqual(errors, []);
		}
		finally {
			server.setOverride(null);
			await context.close();
		}
	});
});
