// Browser tests for shared family photos (js/photos/shared.js, model.js
// "Shared family photos"): a card with no official image, no twin, and no
// photo of your own shows a family member's photo of it, on the My Cards
// tile and the card page, with "Photo by <name>". Your own photo wins; an
// account outside the group sees nothing; phones read only the members'
// photo_index. Headless Chromium at 390 x 844 against tests/pages-server.mjs;
// Supabase (with Storage), TCGdex, and the sprites are faked, with invented
// accounts. No request leaves the machine.
//
// Screenshots: /tmp/family-photos-*.png.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/family-photos-browser.test.mjs

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {refreshPhotoIndex} from '../js/photos/model.js';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {FakeStorageSupabase} from './photos-fake-storage.mjs';
import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const VIEWPORT = {height: 844, width: 390};
const AT = '2026-09-01T00:00:00.000Z';

// A 1 x 1 PNG for the sprites and the photos (the browser reads the bytes,
// whatever type the bucket names).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

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

const entry = (id, fields) => ({catalog: 'international', created_at: AT, deleted_at: null, id, language: 'en', language_source: 'manual', updated_at: AT, ...fields});

function documentWith(cards, extra = {}) {
	return {binders: [], cards, collections: [], goals: [], openings: [], person: 'local', updated_at: AT, user_id: null, version: 1, wishlist: [], ...extra};
}

const cardName = (id) => `Test card ${id}`;

// Three sets of 60 cards. Sprites answer from `sprites` (dex -> true), or
// 404 for any other number, so a test can make one fail.
async function fakeNetwork(context, {sprites = null} = {}) {
	await context.route('https://api.tcgdex.net/**', (route) => {
		const {pathname} = new URL(route.request().url());
		const list = /\/v2\/(\w+)\/sets$/.exec(pathname);
		const set = /\/v2\/(\w+)\/sets\/(tst\d+)$/.exec(pathname);
		const card = /\/v2\/(\w+)\/cards\/((tst\d+)-(\d+))$/.exec(pathname);
		const setBrief = (setId) => ({cardCount: {official: 60, total: 60}, id: setId, logo: null, name: `Test set ${setId}`, releaseDate: '2026-01-01', serie: {id: 'tst', name: 'Test series'}});
		const series = /\/v2\/(\w+)\/series(\/tst)?$/.exec(pathname);

		if (series) {
			const serie = {id: 'tst', name: 'Test series', releaseDate: '2026-01-01'};

			return route.fulfill({
				body: JSON.stringify(series[2] ? {...serie, sets: ['tst1', 'tst2', 'tst3'].map(setBrief)} : [serie]),
				contentType: 'application/json',
				status: 200,
			});
		}

		if (list) {
			return route.fulfill({body: JSON.stringify(['tst1', 'tst2', 'tst3'].map(setBrief)), contentType: 'application/json', status: 200});
		}

		if (set) {
			return route.fulfill({
				body: JSON.stringify({
					...setBrief(set[2]),
					cards: Array.from({length: 60}, (_, i) => {
						const localId = String(i + 1).padStart(3, '0');

						return {id: `${set[2]}-${localId}`, image: null, localId, name: cardName(`${set[2]}-${localId}`)};
					}),
				}),
				contentType: 'application/json',
				status: 200,
			});
		}

		if (card) {
			return route.fulfill({
				body: JSON.stringify({
					id: card[2],
					illustrator: 'Test Artist',
					image: null,
					localId: card[4],
					name: cardName(card[2]),
					rarity: 'Common',
					set: {cardCount: {official: 60, total: 60}, id: card[3], name: `Test set ${card[3]}`},
					variants_detailed: [],
				}),
				contentType: 'application/json',
				status: 200,
			});
		}

		return route.fulfill({body: '[]', contentType: 'application/json', status: 200});
	});
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));
	await context.route('https://raw.githubusercontent.com/**', (route) => {
		const dex = /\/pokemon\/(\d+)\.png$/.exec(route.request().url());

		if (sprites && !(dex && sprites[dex[1]])) {
			return route.fulfill({status: 404});
		}

		return route.fulfill({body: PNG, contentType: 'image/png', status: 200});
	});
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => {
		throw new Error(`Unexpected Google Fonts request: ${route.request().url()}`);
	});
	await context.route(/ligapokemon\.com\.br/, (route) => {
		throw new Error(`Unexpected Liga request: ${route.request().url()}`);
	});
}

async function device(fake, name, options = {}) {
	const context = await browser.newContext({hasTouch: true, serviceWorkers: 'block', viewport: VIEWPORT});

	await fakePokeApi(context);
	await fakeNetwork(context, options);
	await fake.attach(context, name);

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

	const code = fake.issueCode(email);

	await page.goto(`${url()}?code=${code}`);
	await page.waitForSelector('#account.avatar');
}

async function waitForSynced(page) {
	await page.waitForFunction(() => {
		const line = document.getElementById('sync-status');

		return line && !line.hidden && line.textContent === 'Synced';
	}, null, {timeout: 15000});
}


const photo = (owner, entryId, id) => ({created_at: AT, deleted_at: null, id, path: `${owner}/${entryId}/${id}.webp`, side: 'front'});

// Member B signs in first, which makes the family group; Member A has a
// photo of tst1-001, a card with no catalog image, on the server, with the
// photo_index the app keeps beside it. The outsider shares no group.
function family(fake) {
	const owner = fake.addUser('member-b@example.test');
	const member = fake.addUser('member-a@example.test');
	const outsider = fake.addUser('outsider@example.test');
	const shared = photo(member.id, 'm-1', 'a-photo-1');
	const doc = documentWith([
		entry('m-1', {card_id: 'tst1-001', photos: [shared]}),
		// Many other cards, so reading the whole document would show.
		...Array.from({length: 40}, (_, i) => entry(`m-x${i}`, {card_id: `tst2-${String(i + 1).padStart(3, '0')}`, notes: 'A note that only the whole document carries.'})),
	], {person: undefined, user_id: undefined});

	refreshPhotoIndex(doc, Date.parse(AT));
	fake.documents.set(member.id, {doc, updated_at: fake.now(), user_id: member.id});
	fake.profiles.set(member.id, {display_name: 'Member A', user_id: member.id});
	fake.profiles.set(owner.id, {display_name: 'Member B', user_id: owner.id});
	fake.objects.set(shared.path, {bytes: PNG, contentType: 'image/webp', owner: member.id});

	return {
		doc,
		join() {
			fake.members.push({group_id: fake.groups[0].id, role: 'member', user_id: member.id});
		},
		member,
		outsider,
		owner,
		shared,
	};
}

const tileOf = (page, cardId) => page.locator(`.card-grid .tile[href$="${cardId}"]`).first();

describe('shared family photos', () => {
	test('Member B sees Member A\'s photo on the tile and the card page until B has a photo of their own', async () => {
		const fake = new FakeStorageSupabase();
		const people = family(fake);
		const {context, errors, page} = await device(fake, 'owner');

		await seedLocal(page, documentWith([entry('o-1', {card_id: 'tst1-001'}), entry('o-2', {card_id: 'tst1-002'})]));
		await signIn(page, fake, people.owner.email);
		await waitForSynced(page);
		people.join();
		await page.goto(url('cards'));

		// The tile: A's photo, from the bucket, with the line under it.
		const tile = tileOf(page, 'tst1-001');

		await tile.locator('.ph-by').waitFor({timeout: 15000});
		assert.equal(await tile.locator('.ph-by').textContent(), 'Photo by Member A');
		await tile.locator('.art img[src^="blob:"]').waitFor();
		assert.equal(await tileOf(page, 'tst1-002').locator('.ph-by').count(), 0, 'a card nobody photographed shows no photo');
		await page.screenshot({path: '/tmp/family-photos-tile.png'});

		// Only the members' photo_index was read, in one request for all of
		// them, never A's whole document.
		const reads = fake.log.filter((item) => item.device === 'owner' && item.method === 'GET' && item.path === '/rest/v1/documents');
		const indexReads = reads.filter((item) => (new URLSearchParams(item.search).get('select') || '').includes('photo_index'));

		assert.ok(indexReads.length >= 1);

		for (const item of indexReads) {
			const params = new URLSearchParams(item.search);

			assert.equal(params.get('select'), 'user_id,photo_index:doc->photo_index');
			assert.ok(params.get('user_id').startsWith('in.(') && params.get('user_id').includes(people.member.id));
			assert.ok(item.answered < JSON.stringify(people.doc).length / 4, `the answer (${item.answered} bytes) is the index alone`);
		}

		for (const item of reads) {
			const params = new URLSearchParams(item.search);

			if ((params.get('user_id') || '').includes(people.member.id)) {
				assert.ok((params.get('select') || '*').split(',').every((column) => column.trim() === 'user_id' || column.includes('->')), `no whole document read: ${params.get('select')}`);
			}
		}

		// The card page: the carousel shows it, labelled, with no Use as main.
		await tile.click();
		await page.locator('.ph-card .ph-source').first().waitFor({timeout: 15000});
		assert.equal(await page.locator('.ph-card .ph-source').first().textContent(), 'Photo by Member A');
		await page.locator('.ph-card img[src^="blob:"]').first().waitFor();
		await page.screenshot({path: '/tmp/family-photos-card.png'});

		// B adds a photo of their own: it wins on the tile, with no line.
		await page.goto(url('cards'));
		await tileOf(page, 'tst1-001').locator('.ph-by').waitFor();

		const own = photo(people.owner.id, 'o-1', 'b-photo-1');

		fake.objects.set(own.path, {bytes: PNG, contentType: 'image/webp', owner: people.owner.id});
		await page.evaluate(async (fields) => {
			const {updateCards} = await import('/pokemon-card-tracker/js/collection.js');

			await updateCards([{id: 'o-1', patch: {photos: [fields]}}]);
		}, own);
		await page.waitForFunction(() => {
			const found = document.querySelector('.card-grid .tile[href$="tst1-001"]');

			return found && !found.querySelector('.ph-by') && found.querySelector('.art img[src^="blob:"]');
		}, null, {timeout: 15000});
		assert.ok(fake.storageLog('download').some((item) => item.device === 'owner' && item.path.endsWith(own.path)), 'B\'s own photo came from B\'s folder');

		// B's document now says which cards B has photos of, for the family.
		await waitForSynced(page);
		await page.waitForTimeout(500);

		const index = fake.documents.get(people.owner.id).doc.photo_index;

		assert.deepEqual(index.filter((item) => !item.deleted_at).map((item) => [item.id, item.photos]), [['international~tst1-001~en', [{id: own.id, path: own.path}]]]);

		assert.deepEqual(errors, []);
		await context.close();
	});

	test('an account outside the group sees no family photo, and the index and photo are refused', async () => {
		const fake = new FakeStorageSupabase();
		const people = family(fake);
		const first = await device(fake, 'owner');

		// Member B signs in first, so the group exists with Member A in it.
		await signIn(first.page, fake, people.owner.email);
		await waitForSynced(first.page);
		people.join();
		await first.context.close();

		const {context, errors, page} = await device(fake, 'outsider');

		await seedLocal(page, documentWith([entry('x-1', {card_id: 'tst1-001'})]));
		await signIn(page, fake, people.outsider.email);
		await waitForSynced(page);
		await page.goto(url('cards'));
		await tileOf(page, 'tst1-001').waitFor();
		await page.waitForTimeout(1500);
		assert.equal(await tileOf(page, 'tst1-001').locator('.ph-by').count(), 0);
		assert.equal(await tileOf(page, 'tst1-001').locator('.art img').count(), 0);

		// Asking anyway returns nothing: row-level security hides A's row,
		// and the bucket refuses A's photo.
		const asked = await page.evaluate(async ({id, path}) => {
			const sync = await import('/pokemon-card-tracker/js/sync.js');
			const {getClient} = await import('/pokemon-card-tracker/js/auth.js');
			const client = await getClient();
			const {data} = await client.storage.from('card-photos').download(path);

			return {got: Boolean(data), members: [...(await sync.memberPhotoIndexes([id])).keys()]};
		}, {id: people.member.id, path: people.shared.path});

		assert.deepEqual(asked, {got: false, members: []});

		assert.deepEqual(errors, []);
		await context.close();
	});
});
