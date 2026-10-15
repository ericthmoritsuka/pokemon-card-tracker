// Browser test for what one small edit costs on the network (E-18): one
// note changed on the phone, with 1,600 invented copies in the document, and
// the laptop open on the same account. It counts every byte the fake
// Supabase (tests/fake-supabase.mjs) receives from a device or sends to it,
// over REST and over the Realtime socket, and prints the totals.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/sync-bytes.test.mjs

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

// A project that sends a Realtime event after every documents write (it ran
// supabase/realtime.sql), and counts the bytes each device's socket is sent.
class CountingFake extends FakeSupabase {
	socketBytes = new Map();
	live = false;

	wsSend(socket, message) {
		if (!socket.closed) {
			this.socketBytes.set(socket.device, (this.socketBytes.get(socket.device) || 0) + JSON.stringify(message).length);
		}

		super.wsSend(socket, message);
	}

	async rest(route, request, url, body, entry) {
		const before = new Map([...this.documents].map(([id, row]) => [id, row.updated_at]));
		const result = await super.rest(route, request, url, body, entry);

		if (this.live) {
			for (const [id, row] of this.documents) {
				if (before.get(id) !== row.updated_at) {
					this.pushChange(row, before.has(id) ? 'UPDATE' : 'INSERT');
				}
			}
		}

		return result;
	}
}

// ----------------------------------------------------------- test data

const SETS = Array.from({length: 10}, (_, i) => `tst${i + 1}`);

// 1,600 made-up copies shaped like imported ones.
function syntheticEntries(count) {
	const start = Date.parse('2026-09-01T00:00:00.000Z');

	return Array.from({length: count}, (_, i) => {
		const at = new Date(start + i).toISOString();

		return {
			card_id: `${SETS[i % SETS.length]}-${String(Math.floor(i / SETS.length) + 1).padStart(3, '0')}`,
			catalog: 'international',
			created_at: at,
			deleted_at: null,
			id: `e-${String(i).padStart(5, '0')}`,
			import_key: `${100000 + i}|pt|REVERSE_HOLOFOIL|1`,
			language: i % 3 ? 'pt' : 'en',
			language_source: 'import',
			updated_at: at,
			variant_id: 'reverse',
		};
	});
}

function serverDocument() {
	return {binders: [], cards: syntheticEntries(1600), collections: [], goals: [], merge_version: 2, openings: [], updated_at: '2026-09-01T00:00:00.000Z', version: 1, wishlist: []};
}

async function fakeTcgdex(context) {
	await context.route('https://api.tcgdex.net/**', (route) => route.fulfill({body: '{}', contentType: 'application/json', status: 404}));
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));
}

async function device(fake, name) {
	const context = await browser.newContext({serviceWorkers: 'block', viewport: VIEWPORT});

	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await fake.attach(context, name);
	await fakeTcgdex(context);

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err));

	return {context, errors, page};
}

async function signIn(page, fake, email) {
	await page.goto(url('signin'));
	await page.fill('#signin-email', email);
	await page.click('button:has-text("Send link")');
	await page.waitForSelector('#check-email');
	await page.goto(`${url()}?code=${fake.issueCode(email)}`);
	await page.waitForSelector('#account.avatar');
	await page.waitForFunction(() => {
		const line = document.getElementById('sync-status');

		return line && !line.hidden && line.textContent === 'Synced';
	}, null, {timeout: 30000});
}

const noteOf = (page, id) => page.evaluate(async (entryId) => {
	const doc = await (await import('/pokemon-card-tracker/js/collection.js')).loadDocument();

	return (doc.cards.find((entry) => entry.id === entryId) || {}).notes || null;
}, id);

// What each device sent and was sent since `from` in the log, in bytes.
function traffic(fake, name, from, socketFrom) {
	const mine = fake.log.slice(from).filter((entry) => entry.device === name && entry.path.startsWith('/rest/v1/'));

	return {
		down: mine.reduce((sum, entry) => sum + (entry.answered || 0), 0),
		requests: mine.length,
		socket: (fake.socketBytes.get(name) || 0) - (socketFrom.get(name) || 0),
		up: mine.reduce((sum, entry) => sum + (entry.bytes || 0), 0),
	};
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

function report(label, phone, laptop) {
	console.log(`    ${label}:`);
	console.log(`      phone:  up ${kb(phone.up)}, REST down ${kb(phone.down)}, Realtime down ${kb(phone.socket)} (${phone.requests} requests)`);
	console.log(`      laptop: up ${kb(laptop.up)}, REST down ${kb(laptop.down)}, Realtime down ${kb(laptop.socket)} (${laptop.requests} requests)`);
	console.log(`      total:  ${kb(phone.up + phone.down + phone.socket + laptop.up + laptop.down + laptop.socket)}`);
}

// Signs both devices in on a server that already holds 1,600 copies, edits
// one note on the phone, and waits until the laptop holds it. `pull` makes
// the laptop look, when no Realtime event will.
async function oneSmallEdit(fake, {pull = null} = {}) {
	const owner = fake.addUser('owner@example.test');

	fake.documents.set(owner.id, {doc: serverDocument(), updated_at: fake.now(), user_id: owner.id});

	const phone = await device(fake, 'phone');
	const laptop = await device(fake, 'laptop');

	await signIn(phone.page, fake, owner.email);
	await signIn(laptop.page, fake, owner.email);
	await phone.page.waitForTimeout(1500);

	const mark = fake.log.length;
	const socketMark = new Map(fake.socketBytes);

	await phone.page.evaluate(async () => (await import('/pokemon-card-tracker/js/collection.js')).updateCard('e-00010', {notes: 'Sleeved, from the fair'}));

	const deadline = Date.now() + 20000;

	while (await noteOf(laptop.page, 'e-00010') !== 'Sleeved, from the fair') {
		assert.ok(Date.now() < deadline, 'the laptop got the note');

		if (pull) {
			await pull(laptop.page);
		}

		await laptop.page.waitForTimeout(500);
	}

	await phone.page.waitForTimeout(2000);
	assert.equal(fake.documents.get(owner.id).doc.cards.find((entry) => entry.id === 'e-00010').notes, 'Sleeved, from the fair');
	assert.equal(fake.documents.get(owner.id).doc.cards.length, 1600);

	const result = {laptop: traffic(fake, 'laptop', mark, socketMark), phone: traffic(fake, 'phone', mark, socketMark)};

	assert.deepEqual([...phone.errors, ...laptop.errors], []);
	await phone.context.close();
	await laptop.context.close();

	return result;
}

const total = (side) => side.up + side.down + side.socket;

// v37 moved 1,278 KB for this edit with supabase/realtime.sql run (the
// whole row up, then back to the phone and to the laptop over Realtime),
// and 851 KB without it (up, then down to the laptop).
describe('bytes per small edit, 1,600 copies', () => {
	test('without patch_document: the document goes up, and only the delta comes down', async () => {
		const fake = new CountingFake();

		// A project that also ran supabase/realtime.sql for older apps: its
		// row events reach nobody running this app.
		fake.live = true;
		fake.realtimeDocs = true;

		const {laptop, phone} = await oneSmallEdit(fake);

		report('one note, no patch_document', phone, laptop);
		assert.ok(phone.up > 400 * 1024, 'the whole document went up');
		assert.ok(phone.socket < 1024, 'the phone was not sent its own write back');
		assert.ok(laptop.down + laptop.socket < 4 * 1024, 'the laptop read the delta, not the row');
		assert.ok(total(phone) + total(laptop) < 440 * 1024);
	});

	test('with patch_document (supabase/patch-document.sql run): only the change goes up', async () => {
		const fake = new CountingFake();

		fake.live = true;
		fake.realtimeDocs = true;
		fake.patchDocument = true;

		const {laptop, phone} = await oneSmallEdit(fake);

		report('one note, patch_document', phone, laptop);
		assert.ok(phone.up < 4 * 1024, 'only the delta went up');
		assert.ok(total(phone) + total(laptop) < 12 * 1024);
	});
});
