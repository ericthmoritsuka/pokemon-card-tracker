// Browser tests for sheets, the system Back, and the camera (js/sheet.js;
// plans/audit.md block D): Back closes the Add photo sheet, the photo
// viewer, the Cover image sheet, and the scanner's sheet instead of leaving
// the screen, and closing one by its own button leaves no history entry
// behind. Every way a camera start can end (Back while it starts, a second
// Take photo, a failed play(), the page hidden while the scanner starts)
// ends its tracks. No sheet prints a stray "null", and a second save error
// replaces the first.
//
// Headless Chromium at 390 x 844 against the real app (tests/
// pages-server.mjs), with Chrome's fake camera. getUserMedia is wrapped so
// the test can slow a start down and see every track it handed out.
// Supabase is never reached (signed out); TCGdex and PokeAPI are faked.
//
// Screenshots: /tmp/sheets-*.png.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/sheets-browser.test.mjs

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const VIEWPORT = {height: 844, width: 390};
const AT = '2026-09-01T00:00:00.000Z';
const SHOTS = process.env.SHOTS || '/tmp';

// A 1 x 1 PNG, for sprites and the official card image.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const CARD = 'tst1-001';
const CARD_ROUTE = `cards/en/${CARD}`;
const BINDER = 'binder-test-a';

let server;
let browser;

before(async () => {
	server = await startPagesServer();
	browser = await chromium.launch({args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']});
});

after(async () => {
	await browser.close();
	await server.close();
});

const url = (path = '') => `${server.origin}${BASE}${path}`;

const entry = (id, fields) => ({catalog: 'international', created_at: AT, deleted_at: null, id, language: 'en', language_source: 'import', updated_at: AT, ...fields});

const binder = {
	art: [],
	cols: 3,
	cover_color: '#2f5d8a',
	created_at: AT,
	deleted_at: null,
	id: BINDER,
	name: 'Test binder',
	notes: '',
	page_count: 10,
	rows: 3,
	slots: [],
	updated_at: AT,
};

const documentWith = (cards, binders = []) => ({binders, cards, collections: [], goals: [], openings: [], person: 'local', updated_at: AT, user_id: null, version: 1, wishlist: []});

async function fakeTcgdex(context) {
	await context.route('https://api.tcgdex.net/**', (route) => {
		const {pathname} = new URL(route.request().url());
		const card = /\/v2\/(\w+)\/cards\/((tst\d+)-(\d+))$/.exec(pathname);
		const set = /\/v2\/(\w+)\/sets\/(tst\d+)$/.exec(pathname);

		if (card) {
			return route.fulfill({
				body: JSON.stringify({
					id: card[2],
					illustrator: 'Test Artist',
					image: `https://assets.tcgdex.net/en/tst/${card[3]}/${card[4]}`,
					localId: card[4],
					name: `Test card ${card[2]}`,
					rarity: 'Common',
					set: {cardCount: {official: 60, total: 60}, id: card[3], name: `Test set ${card[3]}`},
					variants_detailed: [],
				}),
				contentType: 'application/json',
				status: 200,
			});
		}

		if (set) {
			return route.fulfill({
				body: JSON.stringify({cardCount: {official: 1, total: 1}, cards: [{id: `${set[2]}-001`, image: null, localId: '001', name: `Test card ${set[2]}-001`}], id: set[2], name: `Test set ${set[2]}`, releaseDate: '2026-01-01', serie: {id: 'tst', name: 'Test series'}}),
				contentType: 'application/json',
				status: 200,
			});
		}

		return route.fulfill({body: route.request().method() === 'POST' ? '{"data":{}}' : '[]', contentType: 'application/json', status: 200});
	});
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({body: PNG, contentType: 'image/png', status: 200}));
	await context.route('https://raw.githubusercontent.com/**', (route) => route.fulfill({body: PNG, contentType: 'image/png', status: 200}));
}

// getUserMedia, wrapped: window.T.delay slows a start down (after the
// camera opened, as a slow phone camera does), window.T.failPlay makes
// video.play() reject, and window.T.tracks holds every track handed out.
function cameraProbe() {
	const T = {calls: 0, delay: 0, failPlay: false, tracks: []};
	const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
	const play = HTMLMediaElement.prototype.play;

	window.T = T;
	T.states = () => T.tracks.map((track) => track.readyState);
	T.live = () => T.tracks.filter((track) => track.readyState === 'live').length;
	navigator.mediaDevices.getUserMedia = async (constraints) => {
		T.calls++;

		const stream = await original(constraints);

		T.tracks.push(...stream.getTracks());

		if (T.delay) {
			await new Promise((resolve) => setTimeout(resolve, T.delay));
		}

		return stream;
	};
	HTMLMediaElement.prototype.play = function () {
		return T.failPlay ? Promise.reject(new DOMException('Playback was blocked.', 'NotAllowedError')) : play.call(this);
	};
}

async function device() {
	const context = await browser.newContext({hasTouch: true, serviceWorkers: 'block', viewport: VIEWPORT});

	await context.grantPermissions(['camera'], {origin: server.origin});
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await context.route('https://*.supabase.co/**', (route) => {
		throw new Error(`Unexpected Supabase request: ${route.request().url()}`);
	});
	await fakePokeApi(context);
	await fakeTcgdex(context);
	await context.addInitScript(cameraProbe);

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err));

	return {context, errors, page};
}

async function seedLocal(page, doc) {
	await page.goto(url('cards'));
	await page.evaluate(async (stored) => {
		await new Promise((resolve, reject) => {
			const open = indexedDB.open('card-tracker-collection', 1);

			open.onupgradeneeded = () => open.result.createObjectStore('documents');
			open.onsuccess = () => {
				const tx = open.result.transaction('documents', 'readwrite');

				tx.objectStore('documents').put(stored, 'local');
				tx.oncomplete = () => {
					open.result.close();
					resolve();
				};
				tx.onerror = () => reject(tx.error);
			};
			open.onerror = () => reject(open.error);
		});
	}, doc);
	await page.reload();
}

const path = (page) => new URL(page.url()).pathname;

const shownErrors = (page) => page.locator('#errors .error').allTextContents();

// Stray "null" or "undefined" words in an element's text.
const strayWords = (page, selector) => page.locator(selector).evaluate((el) => (el.textContent.match(/\b(null|undefined)\b/g) || []));

// Marks the screen's main element, so a test can tell whether Back drew the
// screen again (a new element) or only closed a sheet (the same one).
const markScreen = (page, selector) => page.locator(selector).evaluate((el) => {
	el.dataset.sheetTestMark = 'kept';
});
const screenKept = (page, selector) => page.locator(selector).evaluate((el) => el.dataset.sheetTestMark === 'kept');

// Opens My Cards, then the one card's detail by its tile, so Back has a
// screen to go back to.
async function openCard(page) {
	await page.goto(url('cards'));
	await page.waitForSelector('.card-grid .tile');
	await page.locator('.card-grid .tile').first().click();
	await page.waitForFunction((route) => window.location.pathname.endsWith(route), CARD_ROUTE);
	await page.waitForSelector('.card-detail .ph-add:not([hidden])');
}

// A dark table with a pale card on it, as a JPEG for "Choose from gallery".
const makePhoto = (page) => page.evaluate(() => {
	const canvas = document.createElement('canvas');

	canvas.width = 900;
	canvas.height = 1200;

	const ctx = canvas.getContext('2d');

	ctx.fillStyle = '#141418';
	ctx.fillRect(0, 0, 900, 1200);
	ctx.fillStyle = '#e8d27a';
	ctx.fillRect(170, 220, 560, 780);

	return canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
});

async function pickPhoto(page) {
	const base64 = await makePhoto(page);
	const chooser = page.waitForEvent('filechooser');

	await page.click('.ph-sheet .ph-pick');
	await (await chooser).setFiles({buffer: Buffer.from(base64, 'base64'), mimeType: 'image/jpeg', name: 'card.jpg'});
	await page.waitForSelector('.ph-stage .ph-handle');
}

// ------------------------------------------------------------------ tests

describe('Add photo', () => {
	let phone;

	before(async () => {
		phone = await device();
		await seedLocal(phone.page, documentWith([entry('copy-a', {card_id: CARD})]));
	});

	after(() => phone.context.close());

	test('Back closes the sheet and keeps the card; the next Back leaves the card', async () => {
		const {page} = phone;

		await openCard(page);
		await markScreen(page, '.card-detail');
		await page.click('.ph-add');
		await page.waitForSelector('.ph-sheet .ph-take');
		assert.deepEqual(await strayWords(page, '.ph-sheet'), [], 'no "null" under the title with one copy');
		assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden');
		await page.screenshot({path: `${SHOTS}/sheets-add-photo.png`});

		await page.goBack();
		await page.waitForSelector('.ph-sheet', {state: 'detached'});
		assert.ok(path(page).endsWith(CARD_ROUTE), 'still on the card');
		assert.equal(await screenKept(page, '.card-detail'), true, 'the card page was not drawn again');
		assert.equal(await page.evaluate(() => document.body.style.overflow), '', 'the page scrolls again');

		await page.goBack();
		await page.waitForFunction(() => window.location.pathname.endsWith('/cards'));
		assert.deepEqual(await shownErrors(page), []);
	});

	test('closing by its button, Cancel, or Escape leaves no entry behind: the next Back leaves the card', async () => {
		const {page} = phone;

		for (const how of ['button', 'cancel', 'escape']) {
			await openCard(page);
			await page.click('.ph-add');
			await page.waitForSelector('.ph-sheet .ph-take');

			if (how === 'button') {
				await page.click('.ph-sheet-close');
			}
			else if (how === 'cancel') {
				await page.click('.ph-sheet .ph-cancel');
			}
			else {
				await page.keyboard.press('Escape');
			}

			await page.waitForSelector('.ph-sheet', {state: 'detached'});
			// The sheet's entry goes away after the close.
			await page.waitForTimeout(200);
			assert.ok(path(page).endsWith(CARD_ROUTE), `${how}: still on the card`);
			await page.goBack();
			await page.waitForFunction(() => window.location.pathname.endsWith('/cards'), null, {timeout: 5000});
		}

		assert.deepEqual(await shownErrors(page), []);
	});

	test('focus stays inside the sheet and goes back to Add photo after it', async () => {
		const {page} = phone;

		await openCard(page);
		await page.focus('.ph-add');
		await page.keyboard.press('Enter');
		await page.waitForSelector('.ph-sheet .ph-take');

		for (let i = 0; i < 8; i++) {
			await page.keyboard.press('Tab');
			assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('.ph-sheet'))), true, `Tab ${i + 1} stays in the sheet`);
		}

		await page.keyboard.press('Shift+Tab');
		assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('.ph-sheet'))), true);
		await page.keyboard.press('Escape');
		await page.waitForSelector('.ph-sheet', {state: 'detached'});
		assert.equal(await page.evaluate(() => document.activeElement.classList.contains('ph-add')), true, 'focus returns to Add photo');
	});

	test('Back while the camera starts ends its tracks', async () => {
		const {page} = phone;

		await openCard(page);
		await page.evaluate(() => {
			window.T.tracks = [];
			window.T.calls = 0;
			window.T.delay = 1200;
		});
		await page.click('.ph-add');
		await page.click('.ph-take');
		await page.waitForFunction(() => window.T.calls === 1 && window.T.tracks.length > 0);
		await page.goBack();
		await page.waitForSelector('.ph-sheet', {state: 'detached'});
		assert.ok(path(page).endsWith(CARD_ROUTE));
		await page.waitForFunction(() => window.T.tracks.length && window.T.live() === 0, null, {timeout: 5000});
		await page.waitForTimeout(1500);
		assert.deepEqual(await page.evaluate(() => window.T.states()), ['ended']);
		await page.evaluate(() => {
			window.T.delay = 0;
		});
	});

	test('a second Take photo does not leak the first camera, and closing ends the second', async () => {
		const {page} = phone;

		await openCard(page);
		await page.evaluate(() => {
			window.T.tracks = [];
			window.T.calls = 0;
			window.T.delay = 1000;
		});
		await page.click('.ph-add');
		await page.click('.ph-take');
		await page.waitForFunction(() => window.T.calls === 1);
		// The sheet's own Back, while the first start is still going.
		await page.click('.ph-sheet .ph-cancel:has-text("Back")');
		await page.waitForSelector('.ph-sheet .ph-take');
		await page.evaluate(() => {
			window.T.delay = 0;
		});
		await page.click('.ph-take');
		await page.waitForSelector('.ph-shutter:not([disabled])');
		await page.waitForTimeout(1500);
		assert.deepEqual(await page.evaluate(() => window.T.states()), ['ended', 'live'], 'only the second camera runs');
		await page.click('.ph-sheet-close');
		await page.waitForSelector('.ph-sheet', {state: 'detached'});
		await page.waitForFunction(() => window.T.live() === 0, null, {timeout: 5000});
	});

	test('a route change from code closes the sheet and stops its camera', async () => {
		const {page} = phone;

		await openCard(page);
		await page.evaluate(() => {
			window.T.tracks = [];
		});
		await page.click('.ph-add');
		await page.click('.ph-take');
		await page.waitForSelector('.ph-shutter:not([disabled])');
		assert.equal(await page.evaluate(() => window.T.live()), 1);
		await page.evaluate(async (base) => (await import(`${base}js/dom.js`)).go('cards'), BASE);
		await page.waitForFunction(() => window.location.pathname.endsWith('/cards'));
		await page.waitForSelector('.ph-sheet', {state: 'detached'});
		await page.waitForFunction(() => window.T.live() === 0, null, {timeout: 5000});
		assert.equal(await page.evaluate(() => document.body.style.overflow), '');
		await page.waitForSelector('.card-grid .tile');
	});

	test('a camera whose picture never plays is stopped, and the gallery is offered', async () => {
		const {page} = phone;

		await openCard(page);
		await page.evaluate(() => {
			window.T.tracks = [];
			window.T.failPlay = true;
		});
		await page.click('.ph-add');
		await page.click('.ph-take');
		await page.waitForSelector('.ph-sheet .ph-message.error');
		assert.match(await page.locator('.ph-sheet .ph-message.error').textContent(), /The camera did not start/);
		await page.waitForFunction(() => window.T.tracks.length && window.T.live() === 0, null, {timeout: 5000});
		await page.evaluate(() => {
			window.T.failPlay = false;
		});
		await page.keyboard.press('Escape');
		await page.waitForSelector('.ph-sheet', {state: 'detached'});
		assert.deepEqual(await shownErrors(page), [], 'the cut-short play() is no red banner');
	});

	test('a second save error replaces the first one in place', async () => {
		const {page} = phone;

		await openCard(page);
		await page.click('.ph-add');
		await pickPhoto(page);
		await page.evaluate(() => {
			window.realToBlob = HTMLCanvasElement.prototype.toBlob;
			HTMLCanvasElement.prototype.toBlob = (done) => done(null);
		});
		await page.click('.ph-save');
		await page.waitForSelector('.ph-sheet .ph-message.error');
		assert.match(await page.locator('.ph-sheet .ph-message.error').textContent(), /could not encode/);
		await page.evaluate(() => {
			HTMLCanvasElement.prototype.toBlob = () => {
				throw new Error('Second failure for the test');
			};
		});
		await page.waitForSelector('.ph-save:not([disabled])');
		await page.click('.ph-save');
		await page.waitForFunction(() => /Second failure for the test/.test(document.querySelector('.ph-sheet .ph-message.error').textContent));
		assert.equal(await page.locator('.ph-sheet .ph-message').count(), 1, 'one message, rewritten');
		assert.equal(await page.locator('.ph-sheet .ph-message').getAttribute('role'), 'alert');
		await page.evaluate(() => {
			HTMLCanvasElement.prototype.toBlob = window.realToBlob;
		});

		// Back closes it with nothing saved on the copy.
		await page.goBack();
		await page.waitForSelector('.ph-sheet', {state: 'detached'});
		assert.ok(path(page).endsWith(CARD_ROUTE));
		assert.equal(await page.locator('.ph-carousel').getAttribute('data-count'), '1', 'only the official image');
		assert.deepEqual(phone.errors, []);
	});
});

describe('the photo viewer', () => {
	let phone;

	before(async () => {
		phone = await device();
		await seedLocal(phone.page, documentWith([entry('copy-a', {card_id: CARD})]));
	});

	after(() => phone.context.close());

	test('Back closes the viewer and keeps the card; closing it by its button leaves no entry behind', async () => {
		const {page} = phone;

		await openCard(page);
		await markScreen(page, '.card-detail');
		await page.waitForSelector('.ph-viewport .ph-slide[data-slide]');
		await page.click('.ph-viewport');
		await page.waitForSelector('.ph-full');
		await page.screenshot({path: `${SHOTS}/sheets-viewer.png`});
		await page.goBack();
		await page.waitForSelector('.ph-full', {state: 'detached'});
		assert.ok(path(page).endsWith(CARD_ROUTE), 'still on the card');
		assert.equal(await screenKept(page, '.card-detail'), true);
		assert.equal(await page.evaluate(() => document.body.style.overflow), '');

		await page.click('.ph-viewport');
		await page.waitForSelector('.ph-full');
		await page.click('.ph-full-close');
		await page.waitForSelector('.ph-full', {state: 'detached'});
		await page.waitForTimeout(200);
		assert.ok(path(page).endsWith(CARD_ROUTE));
		await page.goBack();
		await page.waitForFunction(() => window.location.pathname.endsWith('/cards'));
		assert.deepEqual(phone.errors, []);
		assert.deepEqual(await shownErrors(page), []);
	});

	test('Escape closes it, focus goes back to the carousel, and the next Back leaves the card', async () => {
		const {page} = phone;

		await openCard(page);
		await page.focus('.ph-viewport');
		await page.keyboard.press('Enter');
		await page.waitForSelector('.ph-full');

		for (let i = 0; i < 5; i++) {
			await page.keyboard.press('Tab');
			assert.equal(await page.evaluate(() => Boolean(document.activeElement.closest('.ph-full'))), true, `Tab ${i + 1} stays in the viewer`);
		}

		await page.keyboard.press('Escape');
		await page.waitForSelector('.ph-full', {state: 'detached'});
		assert.equal(await page.evaluate(() => document.activeElement.classList.contains('ph-viewport')), true);
		await page.waitForTimeout(200);
		await page.goBack();
		await page.waitForFunction(() => window.location.pathname.endsWith('/cards'));
	});
});

describe('the Cover image sheet', () => {
	let phone;

	before(async () => {
		phone = await device();
		await seedLocal(phone.page, documentWith([], [binder]));
	});

	after(() => phone.context.close());

	test('Back closes it and keeps the binder; the next Back leaves the binder', async () => {
		const {page} = phone;

		await page.goto(url('binders'));
		await page.locator(`[data-link^="binders/${BINDER}"]`).first().click();
		await page.waitForSelector('#binder-cover-image');
		await page.evaluate(() => {
			document.querySelector('#view').firstElementChild.dataset.sheetTestMark = 'kept';
		});

		const binderPath = path(page);

		await page.click('#binder-cover-image');
		await page.waitForSelector('#bc-sheet #bc-pick');
		assert.deepEqual(await strayWords(page, '#bc-sheet'), []);
		await page.goBack();
		await page.waitForSelector('#bc-sheet', {state: 'detached'});
		assert.equal(path(page), binderPath, 'still on the binder');
		assert.equal(await page.evaluate(() => document.querySelector('#view').firstElementChild.dataset.sheetTestMark), 'kept', 'the binder was not drawn again');
		assert.equal(await page.evaluate(() => document.body.style.overflow), '');

		await page.click('#binder-cover-image');
		await page.waitForSelector('#bc-sheet');
		await page.click('#bc-cancel');
		await page.waitForSelector('#bc-sheet', {state: 'detached'});
		await page.waitForTimeout(200);
		await page.goBack();
		await page.waitForFunction(() => window.location.pathname.endsWith('/binders'));
		assert.deepEqual(phone.errors, []);
		assert.deepEqual(await shownErrors(page), []);
	});
});

describe('the scanner', () => {
	let phone;

	before(async () => {
		phone = await device();
		await seedLocal(phone.page, documentWith([]));
	});

	after(() => phone.context.close());

	// My Cards, then the Scan tab. probe(T) sets up the camera wrapper on
	// the fresh page first.
	const openScan = async (page, probe = null) => {
		await page.goto(url('cards'));
		await page.waitForSelector('.tabs a[data-tab="scan"]');

		if (probe) {
			await page.evaluate(probe);
		}

		await page.click('.tabs a[data-tab="scan"]');
		await page.waitForFunction(() => window.location.pathname.endsWith('/scan'));
	};

	test('a card it cannot find prints no "null"; Back closes its sheet and keeps the scanner and its camera', async () => {
		const {page} = phone;

		await openScan(page);
		await page.waitForSelector('#scan-shutter:not([disabled])');
		await page.click('#scan-shutter');
		await page.waitForSelector('#scan-tray [data-item]');

		// The first scan opens its sheet by itself; close it, then open it
		// again from the tray, as a person checking a card would.
		await page.waitForSelector('#scan-confirm', {timeout: 60000});
		await page.waitForFunction(() => /No card found|Check this card/.test(document.querySelector('#scan-confirm').textContent));
		await page.click('#scan-sheet-close');
		await page.waitForSelector('#scan-confirm', {state: 'detached'});
		await page.waitForTimeout(200);
		await page.click('#scan-tray [data-item]');
		await page.waitForSelector('#scan-confirm');
		await page.waitForFunction(() => document.querySelector('#scan-confirm .scan-actions'));
		assert.deepEqual(await page.locator('.scan-sheet-body').evaluate((body) => [...body.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent)), [], 'no stray text in the sheet body');
		assert.deepEqual(await strayWords(page, '#scan-confirm'), []);
		// After the sheet's rise, then scrolled to its end, where the stray
		// words were.
		await page.waitForTimeout(400);
		await page.screenshot({path: `${SHOTS}/sheets-scan-sheet.png`});
		await page.evaluate(() => {
			for (const el of [document.querySelector('#scan-confirm'), document.querySelector('.scan-sheet-body')]) {
				el.scrollTop = el.scrollHeight;
			}
		});
		await page.screenshot({path: `${SHOTS}/sheets-scan-sheet-end.png`});

		await markScreen(page, '#scan');
		await page.goBack();
		await page.waitForSelector('#scan-confirm', {state: 'detached'});
		assert.ok(path(page).endsWith('/scan'), 'still on the scanner');
		assert.equal(await screenKept(page, '#scan'), true, 'the scanner was not drawn again');
		assert.equal(await page.evaluate(() => window.T.live()), 1, 'the camera still runs');

		await page.goBack();
		await page.waitForFunction(() => window.location.pathname.endsWith('/cards'));
		await page.waitForFunction(() => window.T.live() === 0);
		assert.deepEqual(await shownErrors(page), []);
	});

	test('hidden while the camera starts: the camera ends, and showing it again starts one camera', async () => {
		const {page} = phone;

		await openScan(page, () => {
			window.T.delay = 1200;
		});
		await page.waitForFunction(() => window.T.calls === 1 && window.T.tracks.length === 1);

		const setHidden = (hidden) => page.evaluate((value) => {
			Object.defineProperty(document, 'hidden', {configurable: true, get: () => value});
			Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => (value ? 'hidden' : 'visible')});
			document.dispatchEvent(new Event('visibilitychange'));
		}, hidden);

		await setHidden(true);
		assert.equal(await page.evaluate(() => document.getElementById('scan-shutter').disabled), true, 'hidden before the camera was ready');
		await page.waitForTimeout(2000);
		assert.equal(await page.evaluate(() => window.T.live()), 0, 'no camera while hidden');

		// Shown again, then hidden and shown again within one start: one
		// camera, not two.
		await setHidden(false);
		await page.waitForFunction(() => window.T.calls === 2);
		await setHidden(true);
		await setHidden(false);
		await page.evaluate(() => {
			window.T.delay = 0;
		});
		await page.waitForSelector('#scan-shutter:not([disabled])');
		await page.waitForTimeout(1500);
		assert.equal(await page.evaluate(() => window.T.live()), 1, 'exactly one camera runs');

		await page.goBack();
		await page.waitForFunction(() => window.location.pathname.endsWith('/cards'));
		await page.waitForFunction(() => window.T.live() === 0);
	});

	test('a camera whose picture never plays is stopped, and the camera-off panel shows', async () => {
		const {page} = phone;

		await openScan(page, () => {
			window.T.failPlay = true;
		});
		await page.waitForSelector('#scan-camera-off:not([hidden])');
		await page.waitForFunction(() => window.T.tracks.length && window.T.live() === 0, null, {timeout: 5000});
		await page.evaluate(() => {
			window.T.failPlay = false;
		});
		assert.deepEqual(await shownErrors(page), []);
		assert.deepEqual(phone.errors, []);
	});
});
