// Browser tests for the scanner (js/scan/*), in headless Chromium at
// 360 x 740, against tests/scan-harness.mjs: the Pages imitation serving the
// app with the scanner's integration lines added to its copies of app.js,
// index.html, and sw.js.
//
// The camera is Chrome's fake capture device, fed a still of a TCGdex
// English high.webp scan inside the guide frame (the harness builds it).
// Chrome can only show one file per launch, so each card is a relaunch of
// the same browser profile, which is also what closing and reopening the app
// on a phone does to the draft tray. Supabase is tests/fake-supabase.mjs,
// never the real project; TCGdex answers are fetched once and replayed from
// /tmp.
//
// These are not accuracy tests. A flat scan on a fake camera says nothing
// about real glare, focus, foil, or sleeves; the owner tests that on the
// phone.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/scan-browser.test.mjs

import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {after, before, describe, test} from 'node:test';

import {FakeSupabase} from './fake-supabase.mjs';
import {cardImage, cardVideo, fakeCameraArgs, routeTcgdex, startScanHarness} from './scan-harness.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const VIEWPORT = {height: 740, width: 360};
const SHOTS = process.env.SHOTS || '/tmp';
const PROFILES = '/tmp/scan-browser-profiles';

// Three English cards: Pikachu (151, read sure), Bulbasaur (Mega Evolution,
// read sure, with a reverse holo printing), and Spinarak (Darkness Ablaze,
// 102/189, which Astral Radiance's 102/189 ties on the number alone; the name
// read off the card settles it).
const PIKACHU = 'sv03.5-025';
const BULBASAUR = 'me01-001';
const SPINARAK = 'swsh3-102';
const REVERSE = 'cm4kqul3x1bwlz1f';

// Bulbasaur again, with its collector number blurred out: only the name,
// the HP, and the attack read.
const HIDDEN = 'me01-001-nonumber';
const NORMAL = 'endfynwn4n10gzq';

// Bulbasaur again, as a photo of it shown in an app on a laptop screen,
// taken at a slant so the card is wider at the top (tests/scan-harness.mjs
// cardVideo, screen): the app's heading, its set's name, just above the
// card, the app's text beside it, and the screen's edge in the margin. Held
// two ways: its widest row filling the guide's width (so it is shorter than
// the guide, with the heading inside the capture), and its height filling
// the guide's height (so its top runs into the margin).
const SCREEN_WIDTH = 'me01-001-screen-width';
const SCREEN_HEIGHT = 'me01-001-screen-height';

const AT = '2026-09-01T00:00:00.000Z';

let harness;
let videos;
const timings = [];

async function startAll() {
	harness = await startScanHarness();

	const maker = await chromium.launch();

	videos = {};

	for (const card of [PIKACHU, BULBASAUR, SPINARAK]) {
		videos[card] = await cardVideo(maker, card);
	}

	videos[HIDDEN] = await cardVideo(maker, BULBASAUR, {hideNumber: true});
	videos[SCREEN_WIDTH] = await cardVideo(maker, BULBASAUR, {angle: 0, screen: {fit: 'width', heading: 'Mega Evolution', keystone: 1.3}});
	videos[SCREEN_HEIGHT] = await cardVideo(maker, BULBASAUR, {angle: 0, screen: {fit: 'height', heading: 'Mega Evolution', keystone: 1.3}});

	await maker.close();
}

async function stopAll() {
	await harness.close();
}

// The reads' timings so far, printed once the last test has run.
function printTimings() {
	const sorted = (key) => timings.map((t) => t[key]).filter((v) => typeof v === 'number').sort((a, b) => a - b);
	const median = (list) => list[Math.floor(list.length / 2)];
	const ocr = sorted('ocr');
	const total = sorted('total');
	const match = sorted('match');

	if (ocr.length) {
		console.log(`# OCR timing over ${ocr.length} reads (headless Chromium on this machine, not a phone): OCR median ${median(ocr)} ms, fastest ${ocr[0]} ms, slowest ${ocr[ocr.length - 1]} ms; straighten plus OCR median ${median(total)} ms; catalog match median ${median(match)} ms.`);
	}
}

const url = (path = '') => `${harness.origin}${BASE}${path}`;

const documentWith = (cards, wishlist = []) => ({binders: [], cards, collections: [], goals: [], openings: [], person: 'local', updated_at: AT, user_id: null, version: 1, wishlist});

const ownedPikachu = {card_id: PIKACHU, catalog: 'international', created_at: AT, deleted_at: null, id: 'owned-pikachu', language: 'en', language_source: 'import', updated_at: AT, variant_id: NORMAL};

const wish = (id, cardId, fields = {}) => ({card_id: cardId, catalog: 'international', created_at: AT, deleted_at: null, id, language: null, note: '', priority: 'normal', updated_at: AT, variant_id: null, ...fields});

// One app launch with the fake camera showing `card`. The profile folder
// keeps IndexedDB, the service worker, and the sign-in between launches.
async function launch(profile, card, {fake = null, serviceWorkers = 'block', net = {offline: false}} = {}) {
	const context = await chromium.launchPersistentContext(`${PROFILES}/${profile}`, {
		args: fakeCameraArgs(videos[card]),
		serviceWorkers,
		viewport: VIEWPORT,
	});

	await context.grantPermissions(['camera'], {origin: harness.origin});
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await routeTcgdex(context, net);

	if (fake) {
		await fake.attach(context, profile);
	}

	const page = context.pages()[0] || await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err));

	return {context, errors, page};
}

async function closeApp({context, errors, page}) {
	await collectTimings(page);
	await context.close();
	assert.deepEqual(errors.map(String), [], 'no script errors');
}

async function collectTimings(page) {
	const reads = await page.evaluate(async () => {
		try {
			return (await import('/pokemon-card-tracker/js/scan/view.js')).scanStats.reads.splice(0);
		}
		catch {
			return [];
		}
	}).catch(() => []);

	timings.push(...reads);
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

async function signIn(page, fake, email) {
	await page.goto(url('signin'));
	await page.fill('#signin-email', email);
	await page.click('button:has-text("Send link")');
	await page.waitForSelector('#check-email');
	await page.goto(`${url()}?code=${fake.issueCode(email)}`);
	await until(() => page.evaluate(async () => Boolean((await import('/pokemon-card-tracker/js/auth.js')).currentUser())));
}

async function until(check, timeout = 30000, what = 'a condition') {
	const end = Date.now() + timeout;

	while (!(await check())) {
		if (Date.now() > end) {
			throw new Error(`Timed out waiting for ${what}.`);
		}

		await new Promise((resolve) => setTimeout(resolve, 150));
	}
}

const liveCards = (page) => page.evaluate(async () => (await (await import('/pokemon-card-tracker/js/collection.js')).listCards()));

const allCards = (page) => page.evaluate(async () => (await (await import('/pokemon-card-tracker/js/collection.js')).loadDocument()).cards);

const tiles = (page) => page.$$eval('#scan-tray .scan-tile', (list) => list.map((tile) => ({
	finish: (tile.querySelector('.scan-finish') || {}).textContent || null,
	flag: (tile.querySelector('.scan-badge-tl') || {}).title || null,
	id: tile.dataset.item,
	label: tile.getAttribute('aria-label'),
	qty: (tile.querySelector('.scan-qty') || {}).textContent || null,
	status: tile.dataset.status,
	wish: (tile.querySelector('.scan-tile-wish') || {}).textContent || null,
})));

const SETTLED = new Set(['ready', 'unsure', 'unmatched', 'language', 'waiting']);

async function waitForTray(page, count, what = `${count} settled tray cards`) {
	await until(async () => {
		const list = await tiles(page);

		return list.length === count && list.every((tile) => SETTLED.has(tile.status));
	}, 60000, what);

	return tiles(page);
}

const captures = (page) => page.evaluate(async () => (await import('/pokemon-card-tracker/js/scan/view.js')).scanStats.captures);

const text = (page, selector) => page.locator(selector).textContent();

async function openTile(page, index) {
	await page.click(`#scan-tray li:nth-child(${index + 1}) .scan-tile`);
	await page.waitForSelector('#scan-confirm');
}

// ----------------------------------------------------------------- tests

describe('scanner', () => {
	before(startAll);
	after(stopAll);

	test('three cards, a duplicate, a finish, Set for all, Done, Undo, a check-only Discard, and a restored draft', async () => {
		const profile = `main-${randomUUID()}`;
		const fake = new FakeSupabase();
		const eric = fake.addUser('eric@example.test');
		const ana = fake.addUser('ana@example.test');
		const group = {id: randomUUID(), name: 'Family', owner_id: eric.id};

		// Member A is in Eric's family and wants Bulbasaur, in any language.
		fake.groups.push(group);
		fake.members.push({group_id: group.id, role: 'owner', user_id: eric.id}, {group_id: group.id, role: 'member', user_id: ana.id});
		fake.profiles.set(eric.id, {display_name: 'Eric', user_id: eric.id});
		fake.profiles.set(ana.id, {display_name: 'Member A', user_id: ana.id});
		fake.documents.set(ana.id, {doc: documentWith([], [wish('ana-1', BULBASAUR)]), updated_at: fake.now(), user_id: ana.id});

		await rm(`${PROFILES}/${profile}`, {force: true, recursive: true});

		// ---------------------------------------------------- launch 1: Pikachu
		let app = await launch(profile, PIKACHU, {fake});
		let {page} = app;

		await seedLocal(page, documentWith([ownedPikachu]));
		await signIn(page, fake, eric.email);
		await page.goto(url('scan'));
		await page.waitForSelector('#scan');
		assert.equal(await page.title(), 'Scan | Card Tracker');

		// Every control sits in the bottom 40 % of the screen.
		for (const id of ['#scan-close', '#scan-shutter', '#scan-done-open']) {
			const box = await page.locator(id).boundingBox();

			assert.ok(box.y >= VIEWPORT.height * 0.6, `${id} is in the bottom 40 % (top at ${box.y})`);
		}

		assert.ok(await page.locator('#scan-torch').isHidden(), 'the fake camera has no torch, so the toggle hides');

		// The still card is captured on its own, and the first scan opens its
		// sheet: a check-only scan that shows the copy already owned.
		await page.waitForSelector('#scan-confirm #scan-sure', {timeout: 60000});
		assert.equal(await text(page, '#scan-card-name'), 'Pikachu');
		assert.equal(await text(page, '#scan-language-source'), 'read from the card');
		assert.equal(await page.getAttribute('#scan-lang-en', 'aria-pressed'), 'true');
		assert.match(await text(page, '#scan-owned-line'), /^You have 1 English Normal\. This adds a 2nd in English\.$/);
		assert.equal(await page.getAttribute(`#scan-finish-${NORMAL}`, 'aria-pressed'), 'true', 'the finish starts on the plain print');
		await page.waitForTimeout(400);
		await page.screenshot({path: `${SHOTS}/scan-confirm-owned.png`});

		await page.click('#scan-discard');
		await page.waitForSelector('#scan-undo-discard');
		assert.equal((await tiles(page)).length, 0);
		assert.equal((await liveCards(page)).length, 1, 'Discard saves nothing');

		// The same still card is not captured again on its own.
		await page.waitForTimeout(2500);
		assert.equal(await captures(page), 1);

		// The shutter takes it again: a new session, so its sheet opens.
		await page.click('#scan-shutter');
		await page.waitForSelector('#scan-confirm #scan-sure', {timeout: 60000});
		await page.click('#scan-next');

		let list = await waitForTray(page, 1);

		assert.equal(list[0].qty, '×2', 'owned once plus this one');
		assert.equal(list[0].flag, 'English');
		await page.screenshot({path: `${SHOTS}/scan-tray-one.png`});
		await closeApp(app);

		// ---------------------------------------------------- launch 2: Bulbasaur
		app = await launch(profile, BULBASAUR, {fake});
		({page} = app);
		await page.goto(url('scan'));

		list = await waitForTray(page, 2, 'the restored Pikachu and a new Bulbasaur');
		assert.equal(await page.locator('#scan-confirm').count(), 0, 'later scans go straight to the tray');

		const bulbasaur = list[0];

		assert.match(bulbasaur.label, /^Bulbasaur, /);
		await until(async () => (await tiles(page))[0].wish === 'Member A wants this', 20000, 'Member A\'s wishlist mark');

		await openTile(page, 0);
		assert.match(await text(page, '#scan-wish-line'), /Member A wants this card\./);
		assert.equal(await page.getAttribute(`#scan-finish-${NORMAL}`, 'aria-pressed'), 'true');
		await page.click(`#scan-finish-${REVERSE}`);
		assert.equal(await page.getAttribute(`#scan-finish-${REVERSE}`, 'aria-pressed'), 'true');

		// Bulbasaur is French by hand, to see Set for all keep it.
		await page.click('#scan-lang-more');
		await page.click('#scan-lang-fr');
		assert.equal(await text(page, '#scan-language-source'), 'picked by you');
		await page.screenshot({path: `${SHOTS}/scan-confirm-wish.png`});
		await page.click('#scan-sheet-close');
		assert.equal((await tiles(page))[0].finish, 'REV');
		await closeApp(app);

		// ---------------------------------------------------- launch 3: Spinarak, twice
		// Astral Radiance also has a 102/189; the number alone ties them, and
		// the name read off the top of the card settles it.
		app = await launch(profile, SPINARAK, {fake});
		({page} = app);
		await page.goto(url('scan'));
		list = await waitForTray(page, 3, 'the auto capture of Spinarak');

		// Settled, so no tap on the card. Its picture settles it with no text
		// read, so it starts in the language last picked (French, from
		// Bulbasaur), and its label row, read behind it, makes it English
		// when it reads clearly; on this flat still it sometimes reads too
		// faintly, which leaves French. (With the text route, a faint label
		// asks for the language instead.)
		assert.ok(['ready', 'language'].includes(list[0].status), `the name settles the 102/189 tie (${list[0].status})`);
		// Shown in its language's print: Mimigal while French, Spinarak in English.
		assert.match(list[0].label, /^(Spinarak|Mimigal), /);

		await page.click('#scan-shutter');
		list = await waitForTray(page, 4, 'the shutter capture of Spinarak');

		// The Spinaraks whose language is picked here count as set by hand
		// below, and Set for all keeps them English.
		const spinarakLanguage = ['pt', 'pt'];

		for (const [index, tile] of list.slice(0, 2).entries()) {
			assert.ok(['ready', 'language'].includes(tile.status), `Spinarak ${index + 1} is settled (${tile.status})`);

			if (tile.status === 'language') {
				spinarakLanguage[index] = 'en';

				await openTile(page, index);

				if (!(await page.locator('#scan-lang-en').count())) {
					await page.click('#scan-lang-more');
				}

				await page.click('#scan-lang-en');
				await page.click('#scan-sheet-close');
			}
		}

		await until(async () => (await tiles(page)).slice(0, 2).every((tile) => tile.status === 'ready'), 30000, 'both Spinaraks ready');

		// The new card's finish starts on the plain print, not Bulbasaur's
		// reverse holo.
		await openTile(page, 0);
		assert.equal(await text(page, '#scan-sure'), 'Sure match');
		assert.equal(await page.getAttribute(`#scan-finish-${NORMAL}`, 'aria-pressed'), 'true');
		await page.click('#scan-sheet-close');

		// Close the app and open it again: the draft tray is back.
		await collectTimings(page);
		await page.reload();
		list = await waitForTray(page, 4, 'the restored draft');
		assert.match(await text(page, '#scan-done-open'), /^Done 4$/);
		await page.screenshot({path: `${SHOTS}/scan-tray-four.png`});

		await page.click('#scan-done-open');
		await page.waitForSelector('#scan-done');

		// Pikachu read English off its label; Bulbasaur French by hand; each
		// Spinarak English by its label or by a tap, or French by the last pick.
		const held = await page.evaluate(async () => (await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession()).items.map((item) => [item.card.id, item.language]));
		const counted = new Map();

		for (const [, code] of held) {
			counted.set(code, (counted.get(code) || 0) + 1);
		}

		assert.deepEqual(held.filter(([id]) => id !== SPINARAK).map(([id, code]) => `${id} ${code}`).sort(), [`${BULBASAUR} fr`, `${PIKACHU} en`]);
		assert.ok(held.filter(([id]) => id === SPINARAK).every(([, code]) => ['en', 'fr'].includes(code)), held.join('; '));
		assert.equal(await text(page, '#scan-done-count'), `4 cards · ${[...counted].sort((a, b) => b[1] - a[1]).map(([code, n]) => `${code.toUpperCase()} ${n}`).join(' · ')}`);

		list = await tiles(page);
		assert.deepEqual(list.slice(0, 2).map((tile) => tile.qty), ['×2', '×2'], 'scanned twice');

		// Set for all: Portuguese, keeping the ones set by hand.
		await page.click('#scan-all-language');
		await page.waitForSelector('#scan-setall');
		await page.click('#scan-setall-pt');
		const byHand = 1 + spinarakLanguage.filter((code) => code === 'en').length;

		assert.equal(await text(page, '#scan-setall-preview'), `Changes 4 cards. Keep the ${byHand} you set by hand?`);
		await page.screenshot({path: `${SHOTS}/scan-setall.png`});
		await page.click('#scan-setall-keep');
		await page.waitForSelector('#scan-done');
		await until(async () => (await tiles(page)).every((tile) => tile.status === 'ready'), 30000, 'every card ready');
		const flagName = {en: 'English', pt: 'Portuguese'};

		assert.deepEqual((await tiles(page)).map((tile) => tile.flag), [...spinarakLanguage.map((code) => flagName[code]), 'French', 'Portuguese']);

		// Done: four entries, one per physical card.
		assert.equal(await text(page, '#scan-save-session'), 'Save 4 cards');
		await page.click('#scan-save-session');
		await page.waitForSelector('#scan-undo-session');
		assert.equal(await text(page, '#scan-saved-line'), 'Saved 4 cards');
		assert.equal((await tiles(page)).length, 0);

		const saved = (await liveCards(page)).filter((entry) => entry.language_source === 'scan');

		assert.equal(saved.length, 4);
		assert.deepEqual(saved.map((entry) => [entry.card_id, entry.language, entry.variant_id]).sort(), [
			[BULBASAUR, 'fr', REVERSE],
			[PIKACHU, 'pt', NORMAL],
			...spinarakLanguage.map((code) => [SPINARAK, code, NORMAL]),
		].sort());
		assert.ok(saved.every((entry) => entry.catalog === 'international' && !entry.condition));
		await page.screenshot({path: `${SHOTS}/scan-saved.png`});

		// Undo session removes exactly those four.
		await page.click('#scan-undo-session');
		await until(async () => (await liveCards(page)).length === 1, 10000, 'the undo');
		assert.equal((await liveCards(page))[0].id, 'owned-pikachu');

		const tombstones = (await allCards(page)).filter((entry) => entry.deleted_at);

		assert.deepEqual(tombstones.map((entry) => entry.id).sort(), saved.map((entry) => entry.id).sort());

		// Close goes back where the person came from (here, opened directly:
		// My Cards).
		await page.click('#scan-close');
		await until(async () => new URL(page.url()).pathname === `${BASE}cards`, 10000, 'My Cards');
		await closeApp(app);
		await rm(`${PROFILES}/${profile}`, {force: true, recursive: true});
	});

	test('a card whose number does not read is found by its name, or by a search already filled in', async () => {
		const profile = `noname-${randomUUID()}`;

		await rm(`${PROFILES}/${profile}`, {force: true, recursive: true});

		const app = await launch(profile, HIDDEN);
		const {page} = app;

		// The text route, as before the picture-first switch (view.js
		// textFirst): this card is found by its picture otherwise.
		await app.context.addInitScript(() => localStorage.setItem('card-tracker:scan-text-first', 'on'));

		await page.goto(url('scan'));
		await page.waitForSelector('#scan-confirm #scan-card-lines, #scan-confirm .scan-card-lines', {timeout: 60000});
		await until(async () => {
			const list = await tiles(page);

			return list.length === 1 && SETTLED.has(list[0].status);
		}, 60000, 'the card read and looked up');
		await page.waitForTimeout(500);
		await page.screenshot({path: `${SHOTS}/scan-name-route.png`});

		const read = await page.evaluate(async () => {
			const draft = await import('/pokemon-card-tracker/js/scan/draft.js');
			const session = await draft.loadSession();

			return session.items[0];
		});

		assert.equal(read.read.number, null, 'the number did not read');
		assert.match(read.read.name.text, /Bulbasaur/i, 'the name did');

		const chosen = await page.getAttribute(`#scan-confirm .scan-candidate[data-card="${BULBASAUR}"]`, 'aria-pressed').catch(() => null);

		if (chosen === 'true') {
			// Found by its name: one tap if it is not sure.
			if (await page.locator('#scan-this-card').count()) {
				assert.match(await text(page, '#scan-read'), /^Name: Bulbasaur.*number: unreadable$/);
				await page.click('#scan-this-card');
			}
		}
		else {
			// Not found first: the search is open, filled with the name, and
			// lists the card.
			assert.match(await text(page, '#scan-read'), /number: unreadable/);
			assert.equal(await page.inputValue('#scan-search'), 'Bulbasaur');
			await page.waitForSelector(`#scan-search-results .scan-result[data-card="${BULBASAUR}"]`, {timeout: 30000});
			await page.click(`#scan-search-results .scan-result[data-card="${BULBASAUR}"]`);
		}

		await page.waitForSelector('#scan-confirm #scan-sure');

		if (await page.isDisabled('#scan-save')) {
			await page.click('#scan-lang-en');
		}

		await page.waitForSelector('#scan-save:not([disabled])', {timeout: 30000});
		await page.click('#scan-save');
		await page.waitForSelector('#scan-undo-session');

		const saved = await liveCards(page);

		assert.deepEqual(saved.map((entry) => [entry.card_id, entry.language_source]), [[BULBASAUR, 'scan']]);
		await closeApp(app);
		await rm(`${PROFILES}/${profile}`, {force: true, recursive: true});
	});

	test('a card on a laptop screen, at a slant: captured on its own whichever way it fills the guide, read without the heading, and found', async () => {
		for (const frame of [SCREEN_WIDTH, SCREEN_HEIGHT]) {
			const profile = `screen-${randomUUID()}`;

			await rm(`${PROFILES}/${profile}`, {force: true, recursive: true});

			const app = await launch(profile, frame);
			const {page} = app;

			// The text route, as before the picture-first switch (view.js
			// textFirst): this card is found by its picture otherwise.
			await app.context.addInitScript(() => localStorage.setItem('card-tracker:scan-text-first', 'on'));

			// No shutter: the sheet opens only if the still card was taken on
			// its own.
			await page.goto(url('scan'));
			await page.waitForSelector('#scan-confirm .scan-card-lines', {timeout: 60000});
			await until(async () => {
				const list = await tiles(page);

				return list.length === 1 && SETTLED.has(list[0].status);
			}, 60000, `${frame} read and looked up`);
			assert.equal(await captures(page), 1, `${frame}: one capture, taken on its own`);

			const item = await page.evaluate(async () => (await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession()).items[0]);

			assert.doesNotMatch(item.read.name.text, /Mega|Evolution/i, `${frame}: the heading above the card is not read as its name`);
			assert.equal(item.names[0] && item.names[0].name, 'Bulbasaur', `${frame}: the name read off the card ("${item.read.name.text}") is Bulbasaur's`);
			assert.equal(item.readSetName, null);

			// Found first. Seen at this slant, the bottom of the card is small
			// and its number may misread as another card of the set (001 as
			// 007): then nothing is chosen for the person, and the search is
			// open, filled in with the name.
			const candidates = item.candidates.map((c) => c.id).join(', ');

			assert.equal(item.candidates[0].id, BULBASAUR, `${frame}: Bulbasaur first (${candidates})`);
			assert.ok(!item.card || item.card.id === BULBASAUR, `${frame}: no other card chosen (${item.card && item.card.id})`);

			if (!item.card) {
				assert.equal(item.sure, false);
				await page.waitForSelector('#scan-search-panel:not([hidden])');
				assert.equal(await page.inputValue('#scan-search'), 'Bulbasaur');
			}

			await closeApp(app);
			await rm(`${PROFILES}/${profile}`, {force: true, recursive: true});
		}
	});

	test('camera off: offers the search and the phone check, and a searched card saves', async () => {
		const context = await (await chromium.launch()).newContext({viewport: VIEWPORT});

		await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
		await routeTcgdex(context);

		const page = await context.newPage();
		const errors = [];

		page.on('pageerror', (err) => errors.push(err));
		await page.goto(url('scan'));
		await page.waitForSelector('#scan-camera-off:not([hidden])');
		assert.equal(await text(page, '#scan-camera-off-title'), 'Camera is off');
		assert.equal(await page.getAttribute('#scan-phone-check', 'data-link'), 'check');
		await page.screenshot({path: `${SHOTS}/scan-camera-off.png`});

		await page.click('#scan-search-instead');
		await page.waitForSelector('#scan-search-panel:not([hidden])');
		await page.fill('#scan-search', 'Pikachu 025');
		await page.click('#scan-search-go');
		await page.waitForSelector(`#scan-search-results .scan-result[data-card="${PIKACHU}"]`, {timeout: 30000});
		await page.click(`#scan-search-results .scan-result[data-card="${PIKACHU}"]`);
		await page.waitForSelector('#scan-card-name');
		assert.equal(await text(page, '#scan-card-name'), 'Pikachu');
		assert.equal(await text(page, '#scan-language-source'), 'not sure, pick one');
		assert.ok(await page.isDisabled('#scan-save'), 'no language yet');
		assert.equal(await text(page, '#scan-save-why'), 'Pick the language before saving.');
		await page.click('#scan-lang-pt');
		await page.waitForSelector('#scan-save:not([disabled])');
		await page.click('#scan-save');
		await page.waitForSelector('#scan-undo-session');

		const saved = await liveCards(page);

		assert.deepEqual(saved.map((entry) => [entry.card_id, entry.language, entry.language_source, entry.variant_id]), [[PIKACHU, 'pt', 'scan', NORMAL]]);
		await context.browser().close();
		assert.deepEqual(errors.map(String), []);
	});

	test('a photo picked from the gallery is read like a capture, and its scan report copies as text', async () => {
		const browser = await chromium.launch();
		const context = await browser.newContext({viewport: VIEWPORT});

		await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
		await routeTcgdex(context);

		const page = await context.newPage();
		const errors = [];

		page.on('pageerror', (err) => errors.push(err));

		// The photo: Bulbasaur's TCGdex scan on a table, turned 8 degrees,
		// as a JPEG, the way a phone's gallery holds one.
		const webp = (await readFile(await cardImage(BULBASAUR))).toString('base64');
		const jpeg = await page.evaluate(async (data) => {
			const img = new Image();

			img.src = `data:image/webp;base64,${data}`;
			await img.decode();

			const canvas = document.createElement('canvas');

			canvas.width = Math.round(img.naturalWidth * 1.3);
			canvas.height = Math.round(img.naturalHeight * 1.3);

			const ctx = canvas.getContext('2d');

			ctx.fillStyle = '#6b5442';
			ctx.fillRect(0, 0, canvas.width, canvas.height);
			ctx.translate(canvas.width / 2, canvas.height / 2);
			ctx.rotate((8 * Math.PI) / 180);
			ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);

			return canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
		}, webp);
		const photo = join(PROFILES, `photo-${randomUUID()}.jpg`);

		await mkdir(PROFILES, {recursive: true});
		await writeFile(photo, Buffer.from(jpeg, 'base64'));

		await page.goto(url('scan'));
		await page.waitForSelector('#scan-camera-off:not([hidden])');
		assert.equal(await text(page, '#scan-photo-instead'), 'Pick a photo', 'offered with the camera off too');
		await page.setInputFiles('#scan-photo-input', photo);

		// Its sheet opens once it is looked up, like a first capture.
		await page.waitForSelector('#scan-confirm #scan-card-name', {timeout: 60000});
		assert.equal(await text(page, '#scan-card-name'), 'Bulbasaur');

		await page.click('#scan-report-open');
		await page.waitForSelector('#scan-report-text');

		const report = await page.inputValue('#scan-report-text');

		// Found by its picture, so no text was read: the report lists the
		// five best artworks with their distances, the lead, and the crop.
		for (const expected of ['Card Tracker scan report', 'Browser: ', 'Source: a photo picked from the gallery', 'card edges found', 'Crop shape: the edges made a box ', 'Picture match: ', `1. ${BULBASAUR}: distance `, 'OCR: not run (the picture was enough)', 'Catalog lookup: ', 'Candidates (', `(${BULBASAUR}, en)`]) {
			assert.ok(report.includes(expected), `the report has "${expected}":\n${report}`);
		}

		assert.match(report, /lead over the second \d+(\.\d)?/);
		assert.doesNotMatch(report, /data:image/, 'text only');

		await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin: harness.origin});
		await page.click('#scan-report-copy');
		await until(async () => /Copied|select the text/.test(await text(page, '#scan-report-status')), 5000, 'the copy');

		// Save capture image downloads the straightened card and the whole
		// capture as PNGs, drawn in memory (Eric, version 26).
		const downloads = [];

		page.on('download', (download) => downloads.push(download));
		await page.click('#scan-report-capture');
		await until(async () => downloads.length === 2, 10000, 'two capture images');

		const names = downloads.map((download) => download.suggestedFilename());

		assert.match(names[0], /^scan-capture-\d{8}-\d{6}\.png$/);
		assert.match(names[1], /^scan-capture-\d{8}-\d{6}-whole\.png$/);

		for (const download of downloads) {
			const bytes = await readFile(await download.path());

			assert.equal(bytes.subarray(1, 4).toString(), 'PNG', `${download.suggestedFilename()} is a PNG`);
			await writeFile(`${SHOTS}/scan-capture${download.suggestedFilename().endsWith('-whole.png') ? '-whole' : ''}.png`, bytes);
		}

		assert.match(await text(page, '#scan-report-status'), /Saved scan-capture-.* and scan-capture-.*-whole\.png/);

		// Switched on, the report shows in the card's sheet itself, and the
		// switch is remembered.
		await page.check('#scan-report-always');
		await page.click('#scan-report-back');
		await page.waitForSelector('#scan-confirm #scan-report-inline');
		assert.equal(await page.evaluate(() => localStorage.getItem('card-tracker:scan-report')), 'on');
		await page.screenshot({path: `${SHOTS}/scan-report.png`});

		// Clear, beside Pick a photo, empties the tray in one tap, and Undo
		// brings the card back (Eric, 2026-10-03).
		await page.mouse.click(180, 8);
		await page.waitForSelector('#scan-sheet-layer', {state: 'hidden'});
		assert.equal(await text(page, '#scan-clear'), 'Clear');
		await page.screenshot({path: `${SHOTS}/scan-clear.png`});
		await page.click('#scan-clear');
		await page.waitForSelector('#scan-undo-discard');
		assert.equal((await tiles(page)).length, 0);
		assert.ok(await page.locator('#scan-clear').isHidden(), 'nothing left to clear');
		await page.click('#scan-undo-discard');
		await until(async () => (await tiles(page)).length === 1, 5000, 'the card back');
		assert.ok(await page.locator('#scan-clear').isVisible());

		await browser.close();
		await rm(photo, {force: true});
		assert.deepEqual(errors.map(String), []);
	});

	test('offline: reads and matches from the phone, waits for signal, and resolves online', async () => {
		const profile = `offline-${randomUUID()}`;
		const net = {offline: false};

		await rm(`${PROFILES}/${profile}`, {force: true, recursive: true});

		// Online once: the service worker installs, the scanner starts its
		// engine (kept by the service worker), and Pikachu's sets are saved.
		let app = await launch(profile, PIKACHU, {net, serviceWorkers: 'allow'});
		let {context, page} = app;

		await page.goto(url('cards'));
		await page.evaluate(() => navigator.serviceWorker.ready);
		await page.reload();
		await until(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), 20000, 'the service worker');
		await page.goto(url('scan'));
		await page.waitForSelector('#scan-confirm #scan-sure', {timeout: 60000});
		await page.click('#scan-discard');

		const cached = await page.evaluate(async () => (await caches.open('card-tracker-ocr-tesseract-7.0.0').then((cache) => cache.keys())).map((request) => new URL(request.url).pathname.split('/').pop()));

		assert.ok(cached.includes('eng.traineddata.gz'), `the English model is kept (${cached.join(', ')})`);
		assert.ok(cached.some((name) => /^tesseract-core-.*\.wasm\.js$/.test(name)), 'one WebAssembly core is kept');
		assert.ok(cached.includes('worker.min.js'));

		// Offline, after closing the app: it opens, reads, and matches.
		await closeApp(app);
		net.offline = true;
		app = await launch(profile, PIKACHU, {net, serviceWorkers: 'allow'});
		({context, page} = app);
		await context.setOffline(true);
		await page.goto(url('scan'));
		await page.waitForSelector('#scan-top-status:not([hidden])');
		assert.match(await text(page, '#scan-top-status'), /^Offline · reads still work$/);
		await page.waitForSelector('#scan-confirm #scan-sure', {timeout: 60000});
		assert.equal(await text(page, '#scan-card-name'), 'Pikachu');
		await page.click('#scan-next');
		await closeApp(app);

		// A card whose sets were never on this phone waits for signal.
		app = await launch(profile, BULBASAUR, {net, serviceWorkers: 'allow'});
		({context, page} = app);
		await context.setOffline(true);
		await page.goto(url('scan'));

		let list = await waitForTray(page, 2, 'Bulbasaur, read offline');

		assert.equal(list[0].status, 'waiting');
		assert.match(list[0].label, /Waiting for signal/);
		assert.equal(list[1].status, 'ready');
		await page.screenshot({path: `${SHOTS}/scan-offline-waiting.png`});

		// Done can save the ready card, and says the other one stays.
		await page.click('#scan-done-open');
		assert.match(await text(page, '#scan-done-waiting'), /^1 card waiting for signal stays in the tray/);
		await page.click('#scan-sheet-close');

		// Signal comes back: it resolves on its own.
		net.offline = false;
		await context.setOffline(false);
		// Found by its picture, no text read, so its language may still be
		// asked for ('language' rather than 'ready').
		await until(async () => ['ready', 'language'].includes((await tiles(page))[0].status), 60000, 'Bulbasaur matched online');
		list = await tiles(page);
		assert.match(list[0].label, /^Bulbasaur, /);
		await closeApp(app);
		await rm(`${PROFILES}/${profile}`, {force: true, recursive: true});
		printTimings();
	});
});
