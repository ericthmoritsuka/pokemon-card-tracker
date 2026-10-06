// Browser tests for the placeholder notice at scan (DESIGN.md section 3,
// "If a binder placeholder waits"): a tray card whose card has a
// placeholder in one of the person's binders says where it goes, and Place
// it there puts the saved copy in that pocket.
//
// Headless Chromium at 360 x 740 against tests/scan-harness.mjs, with no
// camera (so the scanner opens with the camera off) and the tray seeded as
// a draft, so no picture has to be read. TCGdex is offline and any Supabase
// request is refused: the binders and the cards are on the phone, signed
// out.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/scan-placeholder-browser.test.mjs

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {routeTcgdex, startScanHarness} from './scan-harness.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const VIEWPORT = {height: 740, width: 360};
const SHOTS = process.env.SHOTS || '/tmp';

const PIKACHU = 'sv03.5-025';
const NORMAL = 'endfynwn4n10gzq';
const AT = '2026-09-01T00:00:00.000Z';

let harness;
let browser;

const url = (path = '') => `${harness.origin}${BASE}${path}`;

const want = (cardId, name) => ({card_id: cardId, catalog: 'international', image: null, name, variant_id: null});

const binder = (id, name, created, slots) => ({
	art: [],
	cols: 3,
	cover_color: '#1b1b1f',
	created_at: created,
	deleted_at: null,
	id,
	name,
	notes: '',
	page_count: 8,
	rows: 3,
	slots,
	updated_at: created,
});

// Binder 2 was made first, so its placeholder is named first.
const BINDERS = [
	binder('b3', 'Binder 3', '2026-08-03T00:00:00.000Z', [{page: 1, placed_at: AT, position: 2, want: want(PIKACHU, 'Pikachu')}]),
	binder('b2', 'Binder 2', '2026-08-02T00:00:00.000Z', [{page: 7, placed_at: AT, position: 4, want: want(PIKACHU, 'Pikachu')}]),
];

const documentWith = (binders) => ({binders, cards: [], collections: [], goals: [], openings: [], person: 'local', updated_at: AT, user_id: null, version: 1, wishlist: []});

async function until(check, timeout = 30000, what = 'a condition') {
	const end = Date.now() + timeout;

	while (!(await check())) {
		if (Date.now() > end) {
			throw new Error(`Timed out waiting for ${what}.`);
		}

		await new Promise((resolve) => setTimeout(resolve, 150));
	}
}

// A fresh page with the binders on the phone and `copies` Pikachus in the
// scan tray, each ready to save.
async function openWith(binders, copies) {
	const context = await browser.newContext({viewport: VIEWPORT});
	const supabase = [];

	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await context.route('https://*.supabase.co/**', (route) => {
		supabase.push(route.request().url());

		return route.abort();
	});
	await routeTcgdex(context, {offline: true});

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err));
	await page.goto(url('cards'));
	await page.evaluate(async ({doc, copies: n, cardId, variantId, at}) => {
		await new Promise((resolve, reject) => {
			const open = indexedDB.open('card-tracker-collection', 1);

			open.onupgradeneeded = () => open.result.createObjectStore('documents');
			open.onsuccess = () => {
				const tx = open.result.transaction('documents', 'readwrite');

				tx.objectStore('documents').put(doc, 'local');
				tx.oncomplete = () => {
					open.result.close();
					resolve();
				};
				tx.onerror = () => reject(tx.error);
			};
			open.onerror = () => reject(open.error);
		});

		const S = await import('/pokemon-card-tracker/js/scan/session.js');
		const draft = await import('/pokemon-card-tracker/js/scan/draft.js');
		const session = S.newSession(at, 'placeholder-session');

		for (let i = 0; i < n; i++) {
			const item = S.addCapture(session, {at, id: `copy-${i + 1}`});

			Object.assign(item, {
				card: {catalog: 'international', id: cardId, image: null, lang: 'en', localId: '025', name: 'Pikachu', official: '165', setId: 'sv03.5', setName: '151'},
				language: 'en',
				languageBy: 'hand',
				status: 'ready',
				sure: true,
				variantId,
				variants: [{size: 'standard', type: 'normal', variantId}],
			});
		}

		await draft.saveSession(session);
	}, {at: AT, cardId: PIKACHU, copies, doc: documentWith(binders), variantId: NORMAL});
	await page.goto(url('scan'));
	await until(async () => (await page.$$('#scan-tray .scan-tile')).length === copies, 30000, 'the seeded tray');

	return {context, errors, page, supabase};
}

async function close({context, errors, supabase}) {
	await context.close();
	assert.deepEqual(errors.map(String), [], 'no script errors');
	assert.deepEqual(supabase, [], 'no Supabase request');
}

// The tile for copy-N (the tray shows the newest at the left).
async function openCopy(page, n) {
	await page.click(`#scan-tray .scan-tile[data-item="copy-${n}"]`);
	await page.waitForSelector('#scan-confirm');
}

const binders = (page) => page.evaluate(async () => {
	const doc = await (await import('/pokemon-card-tracker/js/collection.js')).loadDocument();

	return {cards: doc.cards.filter((entry) => !entry.deleted_at).map((entry) => entry.id), binders: doc.binders};
});

// What each pocket holds that the test cares about: "entry" for a copy,
// "want" for a placeholder.
function pocket(state, binderId, page, position) {
	const found = state.binders.find((item) => item.id === binderId);
	const slots = found.slots.filter((slot) => slot.page === page && slot.position === position && !slot.cleared);
	const slot = slots.sort((a, b) => String(b.placed_at).localeCompare(String(a.placed_at)))[0];

	return !slot ? null : slot.entry_id ? `entry:${slot.entry_id}` : slot.want ? `want:${slot.want.card_id}` : 'other';
}

describe('placeholder notice at scan', () => {
	before(async () => {
		harness = await startScanHarness();
		browser = await chromium.launch();
	});

	after(async () => {
		await browser.close();
		await harness.close();
	});

	test('a scanned card a placeholder waits for says where it goes, and saving places it there (offline)', async () => {
		const app = await openWith(BINDERS, 1);
		const {page} = app;

		await openCopy(page, 1);
		await page.waitForSelector('#scan-place');
		assert.equal(await page.textContent('#scan-place-line'), 'Goes in Binder 2, page 7, pocket 4 +1 more');
		assert.equal(await page.isChecked('#scan-place-it'), true, 'Place it there starts on');
		await page.locator('#scan-place').scrollIntoViewIfNeeded();
		await page.screenshot({path: `${SHOTS}/scan-placeholder.png`});

		await page.click('#scan-save');
		await page.waitForSelector('#scan-undo-session');
		assert.equal(await page.textContent('#scan-saved-line'), 'Saved 1 card, 1 placed in a binder');

		const state = await binders(page);

		assert.equal(state.cards.length, 1);
		assert.equal(pocket(state, 'b2', 7, 4), `entry:${state.cards[0]}`, 'the copy is in the placeholder\'s pocket');
		assert.equal(pocket(state, 'b3', 1, 2), `want:${PIKACHU}`, 'the other placeholder still waits');

		// Undo session takes the copy away and puts the placeholder back.
		await page.click('#scan-undo-session');
		await until(async () => (await binders(page)).cards.length === 0, 10000, 'the undo');
		await until(async () => pocket(await binders(page), 'b2', 7, 4) === `want:${PIKACHU}`, 10000, 'the placeholder back');
		await close(app);
	});

	test('Place it there switched off leaves the copy unplaced', async () => {
		const app = await openWith(BINDERS.slice(1), 1);
		const {page} = app;

		await openCopy(page, 1);
		await page.waitForSelector('#scan-place');
		assert.equal(await page.textContent('#scan-place-line'), 'Goes in Binder 2, page 7, pocket 4');
		await page.click('#scan-place-it');
		await until(async () => !(await page.isChecked('#scan-place-it')), 5000, 'the switch off');

		const held = await page.evaluate(async () => (await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession()).items[0].place);

		assert.equal(held, false, 'the draft keeps the switch');
		await page.click('#scan-save');
		await page.waitForSelector('#scan-undo-session');
		assert.equal(await page.textContent('#scan-saved-line'), 'Saved 1 card');

		const state = await binders(page);

		assert.equal(state.cards.length, 1);
		assert.equal(pocket(state, 'b2', 7, 4), `want:${PIKACHU}`, 'the placeholder still waits');
		await close(app);
	});

	test('two copies and one placeholder: only the first fills it', async () => {
		const app = await openWith(BINDERS.slice(1), 2);
		const {page} = app;

		await openCopy(page, 2);
		await page.waitForSelector('#scan-place');
		assert.equal(await page.textContent('#scan-place-line'), 'An earlier card in this session fills its binder placeholder.');
		assert.equal(await page.$('#scan-place-it'), null);
		await page.click('#scan-review-done');
		await page.waitForSelector('#scan-done');
		assert.equal(await page.textContent('#scan-done-place'), '1 card goes in a binder placeholder.');
		await page.click('#scan-save-session');
		await page.waitForSelector('#scan-undo-session');
		assert.equal(await page.textContent('#scan-saved-line'), 'Saved 2 cards, 1 placed in a binder');

		const state = await binders(page);
		const first = await page.evaluate(async () => {
			const doc = await (await import('/pokemon-card-tracker/js/collection.js')).loadDocument();

			return doc.cards.slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || 0)[0].id;
		});

		assert.equal(state.cards.length, 2);
		assert.equal(pocket(state, 'b2', 7, 4), `entry:${first}`, 'the first copy saved fills it');
		await close(app);
	});
});
