// Browser tests for the main image on every screen (js/photos/index.js
// tileSrc, withMainPhoto, mainArt; DESIGN.md section 5, "Image carousel per
// card"): a Japanese print the catalog has no image for, with a photo of
// your own, shows the photo in a binder pocket, in a placeholder for a card
// at zero copies, on the set's grid, on the wishlist, and in a set goal's
// cell; the photo pinned as the main image wins; a family member's Trade
// view shows the member's photo, not the viewer's; and the copy sheet
// counts photos from the card's record.
//
// Headless Chromium against tests/pages-server.mjs. Signed out, every
// outside service is faked: TCGdex answers with an invented Japanese set
// with no images, PokeAPI with tests/fake-pokeapi.mjs; Supabase must never
// be contacted, and ligapokemon.com.br is never requested. The family test
// signs in to tests/photos-fake-storage.mjs (the fake project with the
// card-photos bucket). Cards, accounts, and photos are invented.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/main-image-browser.test.mjs
// Screenshots: $SHOTS (default /tmp)/main-image-*.png

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {startPagesServer} from './pages-server.mjs';
import {FakeStorageSupabase} from './photos-fake-storage.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const WIDE = {height: 900, width: 1100};
const PHONE = {height: 844, width: 390};
const SHOTS = process.env.SHOTS || '/tmp';
const AT = '2026-09-01T00:00:00.000Z';

// A 1 x 1 PNG for the sprites and the bucket's photos.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAAABJRU5ErkJggg==', 'base64');

// An invented Japanese set: no card has an image, as for most Asian prints.
const SET = {cardCount: {official: 3, total: 3}, id: 'jpt1', logo: null, name: 'Test Japanese Set', releaseDate: '2026-02-01', serie: {id: 'jts', name: 'Test Japanese Series'}};
const NUMBERS = ['010', '011', '012'];
const NAMES = {'010': 'Tesuto', '011': 'Tesumon', '012': 'Tesuzaurusu'};
const gqlCard = (n) => ({id: `jpt1-${n}`, illustrator: 'Kenji Test', image: null, localId: n, name: NAMES[n], rarity: 'Common', variants: null, variants_detailed: [{size: 'standard', type: 'normal'}]});
const record = (n) => ({...gqlCard(n), category: 'Pokemon', set: {cardCount: SET.cardCount, id: 'jpt1', name: SET.name}, variants_detailed: [{size: 'standard', type: 'normal', variantId: `jpt1${n}-v0`}]});
const REST = {
	'ja/series': [{id: 'jts', name: 'Test Japanese Series'}],
	'ja/series/jts': {id: 'jts', name: 'Test Japanese Series', releaseDate: SET.releaseDate, sets: [{cardCount: SET.cardCount, id: 'jpt1', logo: null, name: SET.name}]},
	'ja/sets': [{cardCount: SET.cardCount, id: 'jpt1', logo: null, name: SET.name}],
	'ja/sets/jpt1': {...SET, cards: NUMBERS.map((n) => ({id: `jpt1-${n}`, image: null, localId: n, name: NAMES[n]}))},
	...Object.fromEntries(NUMBERS.map((n) => [`ja/cards/jpt1-${n}`, record(n)])),
};

let server;
let browser;

before(async () => {
	server = await startPagesServer();
	browser = await chromium.launch();
});

after(async () => {
	await browser?.close();
	await server?.close();
});

const url = (path = '') => `${server.origin}${BASE}${path}`;

const json = (body, status = 200) => ({body: JSON.stringify(body), contentType: 'application/json', headers: {'Access-Control-Allow-Origin': '*'}, status});

async function fakeTcgdex(context) {
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));
	await context.route('https://api.tcgdex.net/**', (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname.replace(/^\/v2\//, '');

		if (request.method() === 'OPTIONS') {
			return route.fulfill({headers: {'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Origin': '*'}, status: 204});
		}

		if (path === 'graphql') {
			const {query} = JSON.parse(request.postData() || '{}');

			return route.fulfill(json({data: {cards: String(query).includes('jpt1-') ? NUMBERS.map(gqlCard) : []}}));
		}

		const body = REST[decodeURIComponent(path)];

		return route.fulfill(body ? json(body) : json({}, 404));
	});
}

// A signed-out phone: nothing reaches Supabase or the Liga.
async function phone(viewport = WIDE) {
	const context = await browser.newContext({serviceWorkers: 'block', viewport});
	const seen = {liga: [], supabase: []};

	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await context.route(/ligapokemon\.com\.br/, (route) => {
		seen.liga.push(route.request().url());

		return route.abort('blockedbyclient');
	});
	await context.route(/supabase\.(co|in)/, (route) => {
		seen.supabase.push(route.request().url());

		return route.abort('blockedbyclient');
	});
	await context.route('https://api.frankfurter.dev/**', (route) => route.fulfill(json([])));
	await fakeTcgdex(context);
	await fakePokeApi(context);

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err));

	const done = async () => {
		assert.deepEqual(errors.map(String), []);
		assert.deepEqual(await page.locator('#errors .error').allTextContents(), []);
		assert.deepEqual(seen.liga, [], 'Liga Pokémon is never requested');
		assert.deepEqual(seen.supabase, [], 'Supabase is never contacted');
		await context.close();
	};

	await page.goto(url('cards'));
	await page.waitForSelector('#cards-empty');

	return {done, page};
}

const go = (page, route) => page.evaluate(async (path) => (await import('/pokemon-card-tracker/js/dom.js')).go(path), route);

// The photo's object URL, once the store has read it (js/photos/store.js).
const photoSrc = (page, id) => page.evaluate(async (photoId) => (await import('/pokemon-card-tracker/js/photos/store.js')).cachedPhotoUrl(photoId), id);

// Waits until the image in `selector` is the photo `id`, and returns it.
async function waitPhoto(page, selector, id) {
	await page.waitForFunction(async ({photoId, sel}) => {
		const {cachedPhotoUrl} = await import('/pokemon-card-tracker/js/photos/store.js');
		const img = document.querySelector(sel);

		return Boolean(img && cachedPhotoUrl(photoId) && img.getAttribute('src') === cachedPhotoUrl(photoId));
	}, {photoId: id, sel: selector}, {timeout: 15000});

	return page.locator(selector).getAttribute('src');
}

// The Japanese print jpt1-010 in two copies with two photos of the card,
// the second pinned as the main image; jpt1-011 at zero copies, with a
// photo on its record; jpt1-012 owned, with no photo at all. Photos are
// saved the way Add photo saves them (js/photos/index.js savePhoto), each
// a solid color.
const seed = (page) => page.evaluate(async () => {
	const collection = await import('/pokemon-card-tracker/js/collection.js');
	const {savePhoto} = await import('/pokemon-card-tracker/js/photos/index.js');
	const card = (n) => ({card_id: `jpt1-${n}`, catalog: 'ja', language: 'ja'});
	const blob = async (color) => {
		const canvas = new OffscreenCanvas(63, 88);
		const draw = canvas.getContext('2d');

		draw.fillStyle = color;
		draw.fillRect(0, 0, 63, 88);

		return canvas.convertToBlob({type: 'image/webp'});
	};
	const [first, second] = await collection.addCards([
		{...card('010'), language_source: 'manual'},
		{...card('010'), language_source: 'manual'},
	]);
	const loose = await collection.addCard({...card('012'), language_source: 'manual'});
	const photo1 = await savePhoto({blob: await blob('#c33'), entry: card('010'), type: 'image/webp'});
	const photo2 = await savePhoto({blob: await blob('#36c'), entry: card('010'), type: 'image/webp'});
	const zero = await savePhoto({blob: await blob('#3a7'), entry: card('011'), type: 'image/webp'});

	return {first: first.id, loose: loose.id, photo1: photo1.id, photo2: photo2.id, second: second.id, zero: zero.id};
});

const pin = (page, photoId) => page.evaluate(async (id) => {
	const collection = await import('/pokemon-card-tracker/js/collection.js');

	await collection.updateCardInfo([{card_id: 'jpt1-010', catalog: 'ja', language: 'ja'}], () => ({main_image: id}));
}, photoId);

describe('the main image on every screen', () => {
	test('an Asian print with no catalog image shows its photo in a binder, a placeholder, the set, the wishlist, and a goal; the pin wins', async () => {
		const {done, page} = await phone();
		const ids = await seed(page);

		// A binder: the copy in pocket 1, a placeholder of the card at zero
		// copies in pocket 2, and the copy with no photo in pocket 3.
		const binder = await page.evaluate(async ({first, loose}) => {
			const binders = await import('/pokemon-card-tracker/js/binders.js');
			const made = await binders.createBinder({cols: 3, cover_color: '#1d2e60', name: 'Japan', page_count: 2, rows: 3});

			await binders.placeCard(made.id, 1, 1, first);
			await binders.placePlaceholder(made.id, 1, 2, {card_id: 'jpt1-011', catalog: 'ja', name: 'Tesumon'});
			await binders.placeCard(made.id, 1, 3, loose);

			return made.id;
		}, ids);
		const pocket = (position) => `#binder-spread .pocket[data-page="1"][data-position="${position}"]`;

		await go(page, `binders/${binder}`);
		await page.waitForSelector(`${pocket(1)}[data-kind="card"]`);

		// No pin yet: the first photo, in carousel order.
		await waitPhoto(page, `${pocket(1)} .art img`, ids.photo1);
		await waitPhoto(page, `${pocket(2)} .art img`, ids.zero);
		assert.equal(await page.locator(`${pocket(2)}`).getAttribute('data-kind'), 'want');
		assert.equal(await page.locator(`${pocket(3)} .art img`).count(), 0, 'a card with no image and no photo shows its card back');
		assert.equal(await page.locator(`${pocket(3)} .card-back`).count(), 1);

		// Pinning the second photo (Use as main image) redraws the pocket.
		await pin(page, ids.photo2);
		await waitPhoto(page, `${pocket(1)} .art img`, ids.photo2);
		await page.screenshot({path: `${SHOTS}/main-image-binder.png`});

		// Not in a binder, where the other copy is: the pinned photo too.
		await go(page, 'binders/unplaced');
		await waitPhoto(page, `#unplaced-grid .tile[href$="jpt1-010"] .art img`, ids.photo2);

		// The set's grid: the owned card's pinned photo, and the card at zero
		// copies its record's photo; the card with neither, its card back.
		await go(page, 'sets/ja/jpt1');
		await page.waitForSelector('.card-grid .tile[href$="jpt1-012"]');
		await waitPhoto(page, '.card-grid .tile[href$="jpt1-010"] .art img', ids.photo2);
		await waitPhoto(page, '.card-grid .tile[href$="jpt1-011"] .art img', ids.zero);
		assert.equal(await page.locator('.card-grid .tile[href$="jpt1-012"] .card-back').count(), 1);
		await page.screenshot({path: `${SHOTS}/main-image-set.png`});

		// The pin moved back to the first photo while the set is open: its
		// tile follows without the screen being opened again.
		await pin(page, ids.photo1);
		await waitPhoto(page, '.card-grid .tile[href$="jpt1-010"] .art img', ids.photo1);

		// The wishlist: a wish for the card at zero copies, in Japanese.
		await page.evaluate(async () => {
			const {addToWishlist} = await import('/pokemon-card-tracker/js/wishlist.js');

			await addToWishlist('jpt1-011', {catalog: 'ja', language: 'ja'});
		});
		await go(page, 'wishlist');
		await waitPhoto(page, '#wishlist-items .wl-item .wl-art .art img', ids.zero);
		await page.screenshot({path: `${SHOTS}/main-image-wishlist.png`});

		// A set goal's cells: the owned card and the missing one.
		const goal = await page.evaluate(async (name) => (await (await import('/pokemon-card-tracker/js/goals.js')).createGoal({catalog: 'ja', kind: 'set', level: 'secrets', name, target: 'jpt1'})).id, SET.name);

		await go(page, `goals/${goal}`);
		await waitPhoto(page, '#goal-tile-ja-jpt1-010 .art img', ids.photo1);
		await waitPhoto(page, '#goal-tile-ja-jpt1-011 .art img', ids.zero);
		await page.screenshot({path: `${SHOTS}/main-image-goal.png`});

		// My Cards, the screen the others follow, agrees.
		await go(page, 'cards');
		await waitPhoto(page, '.card-grid .tile[href$="jpt1-010"] .art img', ids.photo1);
		assert.notEqual(await photoSrc(page, ids.photo1), await photoSrc(page, ids.photo2));
		await done();
	});

	test('the copy sheet counts the photos on the card\'s record', async () => {
		const {done, page} = await phone(PHONE);
		const ids = await seed(page);

		// Both copies of jpt1-010 in pockets, so a minus asks which goes.
		await page.evaluate(async ({first, second}) => {
			const binders = await import('/pokemon-card-tracker/js/binders.js');
			const made = await binders.createBinder({cols: 3, name: 'Vitrine', page_count: 2, rows: 3});

			await binders.placeCard(made.id, 1, 1, first);
			await binders.placeCard(made.id, 1, 2, second);
		}, ids);
		await go(page, 'cards/ja/jpt1-010');
		await page.waitForSelector('.copies .copy-stepper');
		await page.click('.copies .step-less');
		await page.waitForSelector('#copy-pick-sheet[open]');

		const options = await page.locator('#copy-pick-sheet .copy-pick-option').allTextContents();

		assert.deepEqual(options.sort(), ['Vitrine, page 1, pocket 1 · 2 photos', 'Vitrine, page 1, pocket 2 · 2 photos']);
		await page.screenshot({path: `${SHOTS}/main-image-copy-sheet.png`});
		await page.click('#copy-pick-close');
		await done();
	});
});

// ------------------------------------------------------------- the family

async function device(fake, name) {
	const context = await browser.newContext({hasTouch: true, serviceWorkers: 'block', viewport: PHONE});

	await fakePokeApi(context);
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await context.route(/ligapokemon\.com\.br/, (route) => {
		throw new Error(`Unexpected Liga request: ${route.request().url()}`);
	});
	await context.route('https://api.frankfurter.dev/**', (route) => route.fulfill(json([])));
	await context.route('https://raw.githubusercontent.com/**', (route) => route.fulfill({body: PNG, contentType: 'image/png', status: 200}));
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));
	await context.route('https://api.tcgdex.net/**', (route) => {
		const card = /\/v2\/\w+\/cards\/((tst\d+)-(\d+))$/.exec(new URL(route.request().url()).pathname);

		if (card) {
			return route.fulfill(json({id: card[1], image: null, localId: card[3], name: `Test card ${card[1]}`, rarity: 'Common', set: {cardCount: {official: 60, total: 60}, id: card[2], name: `Test set ${card[2]}`}, variants_detailed: []}));
		}

		return route.fulfill(json([]));
	});
	await fake.attach(context, name);

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

const entry = (id, fields) => ({catalog: 'international', created_at: AT, deleted_at: null, id, language: 'en', language_source: 'manual', updated_at: AT, ...fields});

const documentWith = (cards, extra = {}) => ({binders: [], card_info: [], cards, collections: [], goals: [], openings: [], updated_at: AT, version: 1, wishlist: [], ...extra});

const bucketPhoto = (owner, id) => ({created_at: AT, deleted_at: null, id, path: `${owner}/${id}/${id}.webp`, side: 'front'});

describe('a family member\'s cards', () => {
	test('their Trade view shows their photo and pin, never the viewer\'s', async () => {
		const fake = new FakeStorageSupabase();
		const viewer = fake.addUser('member-b@example.test');
		const member = fake.addUser('member-a@example.test');
		const theirs = bucketPhoto(member.id, 'a-photo-1');
		const theirPinned = bucketPhoto(member.id, 'a-photo-2');
		const mine = bucketPhoto(viewer.id, 'b-photo-1');

		// Member A: two copies of tst1-001 (one a spare), and two photos of
		// it on its record, the second pinned.
		fake.documents.set(member.id, {
			doc: documentWith([entry('m-1', {card_id: 'tst1-001'}), entry('m-2', {card_id: 'tst1-001'})], {
				card_info: [{card_id: 'tst1-001', catalog: 'international', created_at: AT, deleted_at: null, id: 'international~tst1-001~en', language: 'en', main_image: theirPinned.id, photos: [theirs, theirPinned], updated_at: AT}],
			}),
			updated_at: fake.now(),
			user_id: member.id,
		});
		fake.profiles.set(member.id, {display_name: 'Member A', user_id: member.id});
		fake.profiles.set(viewer.id, {display_name: 'Member B', user_id: viewer.id});

		for (const photo of [theirs, theirPinned]) {
			fake.objects.set(photo.path, {bytes: PNG, contentType: 'image/webp', owner: member.id});
		}

		fake.objects.set(mine.path, {bytes: PNG, contentType: 'image/webp', owner: viewer.id});

		const {context, errors, page} = await device(fake, 'viewer');

		await signIn(page, fake, viewer.email);
		await waitForSynced(page);
		fake.members.push({group_id: fake.groups[0].id, role: 'member', user_id: member.id});

		// Member B has the same card, with a photo of their own.
		await page.evaluate(async (photo) => {
			const collection = await import('/pokemon-card-tracker/js/collection.js');

			await collection.addCard({card_id: 'tst1-001', catalog: 'international', language: 'en', language_source: 'manual'});
			await collection.updateCardInfo([{card_id: 'tst1-001', catalog: 'international', language: 'en'}], () => ({main_image: photo.id, photos: [photo]}));
		}, mine);

		// B's own My Cards: B's photo.
		await go(page, 'cards');
		await waitPhoto(page, '.card-grid .tile[href$="tst1-001"] .art img', mine.id);

		// A's spares: A's pinned photo, from A's folder, never B's.
		await go(page, `family/${member.id}/trade`);
		await waitPhoto(page, '.card-grid .tile[href$="tst1-001"] .art img', theirPinned.id);
		assert.notEqual(await page.locator('.card-grid .tile[href$="tst1-001"] .art img').getAttribute('src'), await photoSrc(page, mine.id));
		assert.equal(await page.locator('.card-grid .tile[href$="tst1-001"] .ph-by').count(), 0, 'their own photo, not a shared one');
		assert.ok(fake.storageLog('download').some((item) => item.device === 'viewer' && item.path.endsWith(theirPinned.path)));
		await page.screenshot({path: `${SHOTS}/main-image-family-trade.png`});

		// A's whole collection reads the same records.
		await go(page, `family/${member.id}`);
		await waitPhoto(page, '.card-grid .tile[href$="tst1-001"] .art img', theirPinned.id);

		assert.deepEqual(errors, []);
		await context.close();
	});
});
