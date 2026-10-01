// Browser tests for live sync (js/sync.js, the "live" section): a card saved
// on one device shows on another that has the app open, without a reload.
// Headless Chromium at 360 x 740 against tests/pages-server.mjs.
//
// Supabase is never reached. tests/fake-supabase.mjs answers every request
// and the Realtime WebSocket. The plain fake never sends a Realtime event,
// like a project whose documents table is not in the supabase_realtime
// publication, so those tests see the poll and the focus pull alone.
// LiveFake below sends one after every documents write, like a project that
// ran supabase/realtime.sql.
//
// Time: the poll waits a minute, so the poll tests install Playwright's fake
// clock and jump it forward. Visibility: headless Chromium is always visible,
// so the tests stand in for document.visibilityState.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/live-sync.test.mjs

import assert from 'node:assert/strict';
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

// A project with the documents table in the supabase_realtime publication:
// every write to a documents row reaches the subscribed channels.
class LiveFake extends FakeSupabase {
	delivered = new Map();

	wsSend(socket, message) {
		if (message[3] === 'postgres_changes' && !socket.closed) {
			this.delivered.set(socket.device, (this.delivered.get(socket.device) || 0) + 1);
		}

		super.wsSend(socket, message);
	}

	async rest(route, request, url, body) {
		const before = new Map([...this.documents].map(([id, row]) => [id, row.updated_at]));
		const result = await super.rest(route, request, url, body);

		for (const [id, row] of this.documents) {
			if (before.get(id) !== row.updated_at) {
				this.pushChange(row, before.has(id) ? 'UPDATE' : 'INSERT');
			}
		}

		return result;
	}
}

// ----------------------------------------------------------- helpers

function card(id, setNumber, at = '2026-09-01T00:00:00.000Z') {
	return {
		card_id: `tst1-${setNumber}`,
		catalog: 'international',
		created_at: at,
		deleted_at: null,
		id,
		language: 'en',
		language_source: 'manual',
		updated_at: at,
	};
}

function documentWith(cards) {
	return {binders: [], cards, collections: [], goals: [], openings: [], person: 'local', updated_at: '2026-09-01T00:00:00.000Z', user_id: null, version: 1, wishlist: []};
}

async function fakeTcgdex(context) {
	await context.route('https://api.tcgdex.net/**', (route) => {
		const match = /\/v2\/(\w+)\/sets\/(tst\d+)$/.exec(new URL(route.request().url()).pathname);

		if (!match) {
			return route.fulfill({body: '{}', contentType: 'application/json', status: 404});
		}

		const setId = match[2];

		return route.fulfill({
			body: JSON.stringify({
				cardCount: {official: 160, total: 160},
				cards: Array.from({length: 160}, (_, i) => {
					const localId = String(i + 1).padStart(3, '0');

					return {id: `${setId}-${localId}`, image: null, localId, name: `Test card ${setId} ${localId}`};
				}),
				id: setId,
				name: `Test set ${setId}`,
				releaseDate: '2026-01-01',
			}),
			contentType: 'application/json',
			status: 200,
		});
	});
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));
}

// window.__visibility stands in for the page's visibility; setVisible()
// changes it and fires visibilitychange, as switching tabs does.
function standInVisibility() {
	window.__visibility = 'visible';
	Object.defineProperty(Document.prototype, 'visibilityState', {configurable: true, get: () => window.__visibility});
	Object.defineProperty(Document.prototype, 'hidden', {configurable: true, get: () => window.__visibility === 'hidden'});
}

async function device(fake, name, {clock = false} = {}) {
	const context = await browser.newContext({serviceWorkers: 'block', viewport: VIEWPORT});

	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await fake.attach(context, name);
	await fakeTcgdex(context);
	await context.addInitScript(standInVisibility);

	if (clock) {
		await context.clock.install();
	}

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

async function signIn(page, fake, email) {
	await page.goto(url('signin'));
	await page.fill('#signin-email', email);
	await page.click('button:has-text("Send link")');
	await page.waitForSelector('#check-email');
	await page.goto(`${url()}?code=${fake.issueCode(email)}`);
	await page.waitForSelector('#account.avatar');
}

async function waitForStatus(page, text) {
	await page.waitForFunction((expected) => {
		const line = document.getElementById('sync-status');

		return line && !line.hidden && line.textContent === expected;
	}, text, {timeout: 15000});
}

// Signs in, opens My Cards, and marks the page, so a test can tell the page
// was never reloaded.
async function openCards(page, fake, email) {
	await signIn(page, fake, email);
	await waitForStatus(page, 'Synced');
	await page.click('a[data-tab="cards"]');
	await page.waitForSelector('#cards-summary');
	await page.evaluate(() => {
		window.__sameLoad = true;
	});
}

const copies = (page, count, timeout = 10000) =>
	page.waitForFunction((n) => new RegExp(`^${n} cop`).test((document.getElementById('cards-summary') || {}).textContent || ''), count, {timeout});

const sameLoad = (page) => page.evaluate(() => window.__sameLoad === true);

const localDoc = (page) => page.evaluate(async () => (await import('/pokemon-card-tracker/js/collection.js')).loadDocument());

const setVisible = (page, visible) => page.evaluate((state) => {
	window.__visibility = state;
	document.dispatchEvent(new Event('visibilitychange'));
}, visible ? 'visible' : 'hidden');

// This device's reads of the documents table since `from` in the log: heads
// read updated_at only, fulls download the row.
function reads(fake, name, from = 0) {
	const mine = fake.log.slice(from).filter((entry) => entry.device === name && entry.method === 'GET' && entry.path === '/rest/v1/documents');

	return {
		fulls: mine.filter((entry) => /select=doc/.test(entry.search)).length,
		heads: mine.filter((entry) => /select=updated_at/.test(entry.search)).length,
	};
}

// Another device's save, made straight on the server.
function otherDeviceSaves(fake, user, change) {
	const row = fake.documents.get(user.id);

	row.doc = change(structuredClone(row.doc));
	row.updated_at = fake.now();

	return row;
}

// Jumps the page's clock forward in steps, firing each due timer, and gives
// the page a moment of real time after each step to answer.
async function jump(page, ms, step = 61000) {
	for (let left = ms; left > 0; left -= step) {
		await page.clock.fastForward(Math.min(step, left));
		await page.waitForTimeout(300);
	}
}

// ----------------------------------------------------------------- tests

describe('live sync without Realtime events', () => {
	test('a card saved on another device appears within a minute by the poll, with no reload', async () => {
		const fake = new FakeSupabase();
		const owner = fake.addUser('owner@example.test');
		const laptop = await device(fake, 'laptop', {clock: true});

		await seedLocal(laptop.page, documentWith([card('a-1', '001'), card('a-2', '002')]));
		await openCards(laptop.page, fake, owner.email);
		await copies(laptop.page, 2);

		const mark = fake.log.length;

		otherDeviceSaves(fake, owner, (doc) => ({...doc, cards: [...doc.cards, card('phone-1', '003', '2026-10-01T12:30:00.000Z')]}));

		// Under 30 seconds, nothing has asked the server yet.
		await jump(laptop.page, 25000, 25000);
		assert.deepEqual(reads(fake, 'laptop', mark), {fulls: 0, heads: 0}, 'no poll before 30 seconds');

		await jump(laptop.page, 36000, 36000);
		await copies(laptop.page, 3);
		assert.ok(await sameLoad(laptop.page), 'the page was not reloaded');

		const after = reads(fake, 'laptop', mark);

		assert.equal(after.fulls, 1, 'the row was downloaded once, after its updated_at changed');

		// With nothing new on the server, a poll reads only updated_at.
		const quiet = fake.log.length;

		await jump(laptop.page, 61000);
		assert.deepEqual(reads(fake, 'laptop', quiet), {fulls: 0, heads: 1}, 'an idle poll is one updated_at read');
		assert.deepEqual(laptop.errors, []);
		await laptop.context.close();
	});

	test('a hidden tab does not poll and lets go of Realtime; coming back pulls at once', async () => {
		const fake = new FakeSupabase();
		const owner = fake.addUser('owner@example.test');
		const laptop = await device(fake, 'laptop', {clock: true});

		await seedLocal(laptop.page, documentWith([card('a-1', '001')]));
		await openCards(laptop.page, fake, owner.email);
		assert.ok(fake.openSockets('laptop').length >= 1, 'the Realtime socket is open while in front');

		await setVisible(laptop.page, false);

		const mark = fake.log.length;

		otherDeviceSaves(fake, owner, (doc) => ({...doc, cards: [...doc.cards, card('phone-1', '002', '2026-10-01T12:30:00.000Z')]}));
		await jump(laptop.page, 5 * 61000);
		assert.deepEqual(reads(fake, 'laptop', mark), {fulls: 0, heads: 0}, 'five minutes hidden, no request');
		assert.equal(fake.openSockets('laptop').length, 0, 'the Realtime socket is closed while hidden');
		await copies(laptop.page, 1);

		await setVisible(laptop.page, true);
		await copies(laptop.page, 2);
		assert.equal(reads(fake, 'laptop', mark).fulls, 1, 'becoming visible pulled the change');
		assert.ok(await sameLoad(laptop.page), 'the page was not reloaded');
		await laptop.page.waitForTimeout(500);
		assert.ok(fake.openSockets('laptop').length >= 1, 'the Realtime socket opens again in front');
		assert.deepEqual(laptop.errors, []);
		await laptop.context.close();
	});

	test('window focus pulls a change before the next poll', async () => {
		const fake = new FakeSupabase();
		const owner = fake.addUser('owner@example.test');
		const laptop = await device(fake, 'laptop', {clock: true});

		await seedLocal(laptop.page, documentWith([card('a-1', '001')]));
		await openCards(laptop.page, fake, owner.email);
		await jump(laptop.page, 10000, 10000);

		const mark = fake.log.length;

		otherDeviceSaves(fake, owner, (doc) => ({...doc, cards: [...doc.cards, card('phone-1', '002', '2026-10-01T12:30:00.000Z')]}));
		await laptop.page.evaluate(() => window.dispatchEvent(new Event('focus')));
		await copies(laptop.page, 2);
		assert.equal(reads(fake, 'laptop', mark).fulls, 1);

		// A second focus right after does not ask again.
		const again = fake.log.length;

		await laptop.page.evaluate(() => window.dispatchEvent(new Event('focus')));
		await laptop.page.waitForTimeout(500);
		assert.deepEqual(reads(fake, 'laptop', again), {fulls: 0, heads: 0});
		assert.ok(await sameLoad(laptop.page), 'the page was not reloaded');
		assert.deepEqual(laptop.errors, []);
		await laptop.context.close();
	});

	test('a local edit still waiting to be pushed survives a pull, and so does one made during it', async () => {
		const fake = new FakeSupabase();
		const owner = fake.addUser('owner@example.test');
		const laptop = await device(fake, 'laptop', {clock: true});

		await seedLocal(laptop.page, documentWith([card('a-1', '001'), card('a-2', '002')]));
		await openCards(laptop.page, fake, owner.email);
		await jump(laptop.page, 10000, 10000);

		// The other device adds a card; its copy of a-1 is the old one.
		otherDeviceSaves(fake, owner, (doc) => ({...doc, cards: [...doc.cards, card('phone-1', '003', '2026-10-01T12:30:00.000Z')]}));

		// The laptop edits a-1. The push waits three seconds, so the edit is
		// still waiting when focus pulls.
		await laptop.page.evaluate(async () => (await import('/pokemon-card-tracker/js/collection.js')).updateCard('a-1', {notes: 'edited on the laptop'}));

		const held = fake.gate((entry) => entry.device === 'laptop' && entry.method === 'GET' && /select=doc/.test(entry.search));

		await laptop.page.evaluate(() => window.dispatchEvent(new Event('focus')));
		await held.reached;

		// While the download is on the network, another edit.
		const during = await laptop.page.evaluate(async () => (await import('/pokemon-card-tracker/js/collection.js')).addCard({card_id: 'tst1-004', catalog: 'international', language: 'pt', language_source: 'manual'}));

		held.release();
		await copies(laptop.page, 4);

		const local = await localDoc(laptop.page);
		const byId = new Map(local.cards.map((entry) => [entry.id, entry]));

		assert.equal(byId.get('a-1').notes, 'edited on the laptop', 'the waiting edit was kept');
		assert.ok(byId.has('phone-1'), 'the other device\'s card arrived');
		assert.ok(byId.has(during.id), 'the edit made during the pull was kept');

		// Both of the laptop's edits reach the server, beside the other card.
		await jump(laptop.page, 4000, 4000);
		await waitForStatus(laptop.page, 'Synced');

		const serverCards = new Map(fake.documents.get(owner.id).doc.cards.map((entry) => [entry.id, entry]));

		assert.equal(serverCards.get('a-1').notes, 'edited on the laptop');
		assert.ok(serverCards.has('phone-1'));
		assert.ok(serverCards.has(during.id));
		assert.equal(serverCards.size, 4);
		assert.deepEqual(laptop.errors, []);
		await laptop.context.close();
	});
});

describe('live sync with Realtime', () => {
	test('a card added on the phone shows on the laptop within seconds, and a device ignores its own echo', async () => {
		const fake = new LiveFake();
		const owner = fake.addUser('owner@example.test');
		const phone = await device(fake, 'phone');
		const laptop = await device(fake, 'laptop');

		await seedLocal(phone.page, documentWith([card('a-1', '001')]));
		await signIn(phone.page, fake, owner.email);
		await waitForStatus(phone.page, 'Synced');
		await openCards(laptop.page, fake, owner.email);
		await copies(laptop.page, 1);

		// The laptop's channel listens to its own row only.

		const joins = fake.openSockets('laptop').flatMap((socket) => [...socket.joins.values()]);

		assert.ok(joins.some((join) => join.changes.some((change) => change.table === 'documents' && change.filter === `user_id=eq.${owner.id}`)), 'subscribed to the own documents row');

		const mark = fake.log.length;
		const started = Date.now();

		await phone.page.evaluate(async () => (await import('/pokemon-card-tracker/js/collection.js')).addCard({card_id: 'tst1-005', catalog: 'international', language: 'en', language_source: 'manual'}));
		await copies(laptop.page, 2, 15000);

		const seconds = (Date.now() - started) / 1000;

		assert.ok(seconds < 10, `shown in ${seconds.toFixed(1)} s, well before a poll`);
		assert.ok(await sameLoad(laptop.page), 'the page was not reloaded');
		assert.equal(reads(fake, 'laptop', mark).fulls, 1, 'the laptop downloaded the row once');

		// The phone hears its own write come back and does not download.
		await waitForStatus(phone.page, 'Synced');
		await phone.page.waitForTimeout(1500);
		assert.ok(fake.delivered.get('phone') >= 1, 'the phone was sent its own write back');
		// Its push read updated_at once; the echo adds no read at all.
		assert.deepEqual(reads(fake, 'phone', mark), {fulls: 0, heads: 1}, 'the phone ignored the echo of its own write');
		assert.deepEqual([...phone.errors, ...laptop.errors], []);
		await phone.context.close();
		await laptop.context.close();
	});
});
