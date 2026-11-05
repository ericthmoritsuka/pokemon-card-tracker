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
// The test runs in the page each poll and must not be async: waitForFunction
// takes the promise an async one returns as an answer at once.
async function waitPhoto(page, selector, id) {
	await page.evaluate(async () => {
		window.photoUrlForTests = (await import('/pokemon-card-tracker/js/photos/store.js')).cachedPhotoUrl;
	});
	await page.waitForFunction(({photoId, sel}) => {
		const img = document.querySelector(sel);
		const src = window.photoUrlForTests(photoId);

		return Boolean(img && src && img.getAttribute('src') === src);
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

// Fifty twin answers at once, as My Cards' twin lookups give while another
// screen is open (js/twins.js changed): onScreen are the cards on screen,
// the rest are cards that are not. Waits two frames for the redraws.
const twinBurst = (page, onScreen = []) => page.evaluate(async (cards) => {
	const twins = await import('/pokemon-card-tracker/js/twins.js');
	const items = [...Array.from({length: 50 - cards.length}, (_, i) => ({card_id: `zzt9-${i}`, catalog: 'ja'})), ...cards];

	await twins.loadTwins();
	await Promise.all(items.map((item) => twins.setDecision(item, {choice: 'none'})));
	await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
	await new Promise((resolve) => setTimeout(resolve, 300));
}, onScreen);

// Counts the elements matching `selector` added under `container` from now
// until added() is called: a screen drawing a row or a tile again.
async function countAdded(page, container, selector) {
	await page.evaluate(({box, match}) => {
		window.addedCount = 0;
		window.addedWatch = new MutationObserver((records) => {
			for (const record of records) {
				for (const node of record.addedNodes) {
					if (node.nodeType === 1 && node.matches(match)) {
						window.addedCount++;
					}
				}
			}
		});
		window.addedWatch.observe(document.querySelector(box), {childList: true, subtree: true});
	}, {box: container, match: selector});

	return () => page.evaluate(() => {
		window.addedWatch.disconnect();

		return window.addedCount;
	});
}

// The requests a page makes until the returned function is called.
function countRequests(page) {
	const seen = [];
	const listen = (request) => seen.push(request.url());

	page.on('request', listen);

	return () => {
		page.off('request', listen);

		return seen;
	};
}

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

	test('the page slider\'s preview shows a pocket\'s photo once it is read, not an empty pocket', async () => {
		const {done, page} = await phone();
		const ids = await seed(page);
		// A placeholder for the card at zero copies, on page 4: no other
		// screen of the binder draws its photo.
		const binder = await page.evaluate(async () => {
			const binders = await import('/pokemon-card-tracker/js/binders.js');
			const made = await binders.createBinder({cols: 3, name: 'Long', page_count: 6, rows: 3});

			await binders.placePlaceholder(made.id, 4, 1, {card_id: 'jpt1-011', catalog: 'ja', name: 'Tesumon'});

			return made.id;
		});

		// A new session, so no photo is in memory yet: the preview of pages 4
		// and 5 draws the pocket while its photo is still being read.
		await page.goto(url(`binders/${binder}`));
		await page.waitForSelector('#bs-spread #bs-slider');
		await page.locator('#bs-spread #bs-slider').evaluate((node) => {
			node.value = '3';
			node.dispatchEvent(new Event('input', {bubbles: true}));
		});
		assert.equal(await page.locator('#bs-bubble .bs-bubble-label').textContent(), 'Pages 4 and 5');
		await waitPhoto(page, '#bs-bubble .bs-mini[data-page="4"] > :first-child', ids.zero);
		assert.equal(await page.locator('#bs-bubble .bs-mini[data-page="4"]').evaluate((node) => node.children.length), 9);
		await page.screenshot({path: `${SHOTS}/main-image-slider-preview.png`});
		await done();
	});

	test('a burst of twin answers redraws only the tiles of cards on screen, once a frame, and reads nothing', async () => {
		const {done, page} = await phone();
		const ids = await seed(page);
		const goal = await page.evaluate(async (name) => {
			const {addToWishlist} = await import('/pokemon-card-tracker/js/wishlist.js');

			for (const n of ['010', '011', '012']) {
				await addToWishlist(`jpt1-${n}`, {catalog: 'ja', language: 'ja'});
			}

			return (await (await import('/pokemon-card-tracker/js/goals.js')).createGoal({catalog: 'ja', kind: 'set', level: 'secrets', name, target: 'jpt1'})).id;
		}, SET.name);
		const onScreen = [{card_id: 'jpt1-010', catalog: 'ja'}];

		// The wishlist: three rows, one of them the card a twin answer is for.
		await go(page, 'wishlist');
		await waitPhoto(page, '#wishlist-items .wl-art[href$="jpt1-011"] .art img', ids.zero);
		await page.waitForFunction(() => document.querySelectorAll('#wishlist-items .wl-item:not(.wl-loading)').length === 3);

		let added = await countAdded(page, '#wishlist-items', '.wl-item, .wl-art');
		let requests = countRequests(page);

		await twinBurst(page, onScreen);
		assert.ok(await added() <= 2, 'the wishlist draws the one row\'s art again, not every row');
		assert.deepEqual(requests(), []);
		assert.equal(await page.locator('#wishlist-items .wl-item').count(), 3);

		// A goal's cells.
		await go(page, `goals/${goal}`);
		await waitPhoto(page, '#goal-tile-ja-jpt1-010 .art img', ids.photo1);
		added = await countAdded(page, '#goal-grid', '.pc-cell, .tile');
		requests = countRequests(page);
		await twinBurst(page, onScreen);
		assert.ok(await added() <= 2, 'the goal draws the one cell again, not every cell');
		assert.deepEqual(requests(), []);
		await waitPhoto(page, '#goal-tile-ja-jpt1-010 .art img', ids.photo1);

		// Not in a binder.
		await go(page, 'binders/unplaced');
		await waitPhoto(page, '#unplaced-grid .tile[href$="jpt1-010"] .art img', ids.photo1);
		added = await countAdded(page, '#unplaced-grid', '.tile');
		requests = countRequests(page);
		await twinBurst(page, onScreen);
		assert.ok(await added() <= 2, 'Not in a binder draws the one tile again, not every tile');
		assert.deepEqual(requests(), []);

		// Answers only for cards that are not on screen draw nothing.
		added = await countAdded(page, '#unplaced-grid', '.tile');
		await twinBurst(page);
		assert.equal(await added(), 0);
		await done();
	});

	test('a twin answer before the wishlist is read never shows it empty', async () => {
		const {done, page} = await phone();

		await page.evaluate(async () => {
			const {addToWishlist} = await import('/pokemon-card-tracker/js/wishlist.js');

			await addToWishlist('jpt1-011', {catalog: 'ja', language: 'ja'});
		});

		// The next load holds every read of the collection until released, so
		// the twins answer while the wishlist is still being read.
		await page.context().addInitScript(() => {
			window.holdCollection = new Promise((resolve) => {
				window.releaseCollection = resolve;
			});

			const complete = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');

			Object.defineProperty(IDBTransaction.prototype, 'oncomplete', {
				configurable: true,
				get() {
					return complete.get.call(this);
				},
				set(fn) {
					const held = typeof fn === 'function' && this.db && this.db.name === 'card-tracker-collection';

					complete.set.call(this, held ? (event) => window.holdCollection.then(() => fn.call(this, event)) : fn);
				},
			});
		});
		await page.goto(url('wishlist'));
		await page.waitForSelector('#wishlist-title');
		await twinBurst(page, [{card_id: 'jpt1-011', catalog: 'ja'}]);
		assert.equal(await page.locator('#wishlist-empty').isHidden(), true, 'not "Your wishlist is empty." while it is being read');
		await page.evaluate(() => window.releaseCollection());
		await page.waitForSelector('#wishlist-items .wl-item:not(.wl-loading)');
		assert.equal(await page.locator('#wishlist-empty').isHidden(), true);
		await done();
	});

	test('a pin moved in another tab is followed on the set\'s grid and in a binder pocket', async () => {
		const {done, page} = await phone();
		const ids = await seed(page);
		const binder = await page.evaluate(async ({first}) => {
			const binders = await import('/pokemon-card-tracker/js/binders.js');
			const made = await binders.createBinder({cols: 3, name: 'Japan', page_count: 2, rows: 3});

			await binders.placeCard(made.id, 1, 1, first);

			return made.id;
		}, ids);
		const other = await page.context().newPage();

		await other.goto(url('wishlist'));
		await other.waitForSelector('#wishlist-title');

		await go(page, 'sets/ja/jpt1');
		await waitPhoto(page, '.card-grid .tile[href$="jpt1-010"] .art img', ids.photo1);
		await pin(other, ids.photo2);
		await waitPhoto(page, '.card-grid .tile[href$="jpt1-010"] .art img', ids.photo2);

		const pocket = '#binder-spread .pocket[data-page="1"][data-position="1"] .art img';

		await go(page, `binders/${binder}`);
		await waitPhoto(page, pocket, ids.photo2);
		await pin(other, ids.photo1);
		await waitPhoto(page, pocket, ids.photo1);
		await other.close();
		await done();
	});
});

// --------------------------------------------- the English stand-in

// A Portuguese image that does not load shows the same card's English image
// marked "English image" in a line under the tile's meta (js/tile.js). A
// photo of your own or a family member's always wins over it, and the line
// never describes a photo.
describe('the English stand-in under a photo', () => {
	const PT_IMAGE = 'https://assets.tcgdex.net/pt/tst/tst1/010/low.webp';
	const INFO = {name: 'Tesuto', number: '010', setName: 'Test Japanese Set'};

	// The Portuguese image fails (404), its English one loads.
	const englishLoads = (page) => page.context().route('https://assets.tcgdex.net/en/**', (route) => route.fulfill({body: PNG, contentType: 'image/png', status: 200}));

	test('a photo that arrives after the English stand-in replaces it, line and all', async () => {
		const {done, page} = await phone();

		await englishLoads(page);

		const ids = await seed(page);

		// The photo pinned as the main image wins over the catalog image.
		await pin(page, ids.photo1);
		// A page with no tiles, so the photo's address is not ready when the
		// tile is drawn: withMainPhoto puts it in after the catalog art.
		await page.goto(url('check'));

		const result = await page.evaluate(async ({info, photoId, src}) => {
			const {cardArt, cardTile} = await import('/pokemon-card-tracker/js/tile.js');
			const {withMainPhoto} = await import('/pokemon-card-tracker/js/photos/index.js');
			const {cachedPhotoUrl} = await import('/pokemon-card-tracker/js/photos/store.js');
			const {cardInfoList} = await import('/pokemon-card-tracker/js/collection.js');
			const until = async (ok) => {
				for (let i = 0; i < 150 && !ok(); i++) {
					await new Promise((resolve) => setTimeout(resolve, 100));
				}

				return Boolean(ok());
			};

			await until(() => cardInfoList().some((record) => record.main_image === photoId));

			const tile = cardTile({art: {eager: true, info, src}, meta: '#010 · Test Japanese Set', names: info.name});
			const lines = () => [...tile.querySelectorAll('.tile-meta')].map((line) => line.textContent);

			document.body.append(tile);

			const standIn = await until(() => tile.querySelector('.art-by'));
			const before = lines();
			const ready = Boolean(cachedPhotoUrl(photoId));

			withMainPhoto(tile, {card_id: 'jpt1-010', catalog: 'ja', language: 'ja'}, src, (photo) => cardArt(info, photo, {decorative: true}));

			const photo = await until(() => {
				const img = tile.querySelector('.art[data-photo="photo"] img');

				return img && img.naturalWidth > 0;
			});

			// Time for a late load event of the art it replaced.
			await new Promise((resolve) => setTimeout(resolve, 300));

			return {after: lines(), before, photo, ready, standIn};
		}, {info: INFO, photoId: ids.photo1, src: PT_IMAGE});

		assert.equal(result.ready, false, 'the photo was not ready when the tile was drawn');
		assert.equal(result.standIn, true);
		assert.deepEqual(result.before, ['#010 · Test Japanese Set', 'English image']);
		assert.equal(result.photo, true, 'the photo shows');
		assert.deepEqual(result.after, ['#010 · Test Japanese Set'], 'no "English image" under a photo');
		await done();
	});

	test('a tile with a family member\'s "Photo by" line never says "English image"', async () => {
		const {done, page} = await phone();

		await englishLoads(page);

		const result = await page.evaluate(async ({info, src}) => {
			const {cardTile} = await import('/pokemon-card-tracker/js/tile.js');
			const tile = cardTile({art: {eager: true, info, src}, meta: '#010 · Test Japanese Set', names: info.name});
			const by = document.createElement('span');

			// As withMainPhoto puts it, before the art has loaded.
			by.className = 'tile-meta ph-by';
			by.textContent = 'Photo by Ana';
			tile.querySelector('.tile-meta').after(by);
			document.body.append(tile);

			for (let i = 0; i < 150 && !tile.querySelector('.art[data-fallback="en"]:not(.loading)'); i++) {
				await new Promise((resolve) => setTimeout(resolve, 100));
			}

			return {english: Boolean(tile.querySelector('.art[data-fallback="en"]:not(.loading)')), lines: [...tile.querySelectorAll('.tile-meta')].map((line) => line.textContent)};
		}, {info: INFO, src: PT_IMAGE});

		assert.equal(result.english, true, 'the English image loaded');
		assert.deepEqual(result.lines, ['#010 · Test Japanese Set', 'Photo by Ana']);
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

	test('their wishlist shows their photos, even when another member\'s fill the family\'s four; twin answers and the family\'s photo lists redraw art, never read again', async () => {
		const fake = new FakeStorageSupabase();
		const viewer = fake.addUser('member-b@example.test');
		const crowd = fake.addUser('member-c@example.test');
		const member = fake.addUser('member-a@example.test');
		const indexEntry = (owner, ids) => ({card_id: 'tst1-001', catalog: 'international', deleted_at: null, id: 'international~tst1-001~en', language: 'en', photos: ids.map((id) => ({id, path: `${owner}/${id}/${id}.webp`})), updated_at: AT});
		const wish = (n) => ({card_id: `tst1-${String(n).padStart(3, '0')}`, catalog: 'international', created_at: AT, deleted_at: null, id: `w-${n}`, language: 'en', priority: 'normal', updated_at: AT});

		// Member A wishes for 30 cards and has two photos of the first; member
		// C, listed before A, has four of the same card, the most the
		// family's list of one card holds.
		fake.documents.set(member.id, {doc: documentWith([], {photo_index_v2: [indexEntry(member.id, ['a-1', 'a-2'])], wishlist: Array.from({length: 30}, (_, i) => wish(i + 1))}), updated_at: fake.now(), user_id: member.id});
		fake.documents.set(crowd.id, {doc: documentWith([], {photo_index_v2: [indexEntry(crowd.id, ['c-1', 'c-2', 'c-3', 'c-4'])]}), updated_at: fake.now(), user_id: crowd.id});

		for (const [owner, id] of [[member.id, 'a-1'], [member.id, 'a-2'], [crowd.id, 'c-1'], [crowd.id, 'c-2'], [crowd.id, 'c-3'], [crowd.id, 'c-4']]) {
			fake.objects.set(`${owner}/${id}/${id}.webp`, {bytes: PNG, contentType: 'image/webp', owner});
		}

		fake.profiles.set(viewer.id, {display_name: 'Member B', user_id: viewer.id});
		fake.profiles.set(crowd.id, {display_name: 'Member C', user_id: crowd.id});
		fake.profiles.set(member.id, {display_name: 'Member A', user_id: member.id});

		const {context, errors, page} = await device(fake, 'viewer');

		await signIn(page, fake, viewer.email);
		await waitForSynced(page);
		fake.members.push({group_id: fake.groups[0].id, role: 'member', user_id: crowd.id});
		fake.members.push({group_id: fake.groups[0].id, role: 'member', user_id: member.id});
		await page.evaluate(async () => (await import('/pokemon-card-tracker/js/photos/shared.js')).refreshSharedPhotos());

		const art = '#wishlist-items .wl-item[data-id="w-1"] .wl-art .art img';

		await go(page, `wishlist/${member.id}`);
		await waitPhoto(page, art, 'a-1');
		await page.waitForFunction(() => document.querySelectorAll('#wishlist-items .wl-item:not(.wl-loading)').length === 30);
		assert.equal(await page.locator('#wishlist-items .wl-item[data-id="w-1"] .ph-by').count(), 0, 'their own photo, not a shared one');
		await page.screenshot({path: `${SHOTS}/main-image-family-wishlist.png`});

		// Scrolled down the list, fifty twin answers, one for the card with
		// the photo: its art is drawn again, nothing is read, nothing moves.
		await page.evaluate(() => window.scrollTo(0, 900));

		const scrolled = await page.evaluate(() => window.scrollY);
		let mark = fake.log.length;
		let added = await countAdded(page, '#wishlist-items', '.wl-item, .wl-art');

		await twinBurst(page, [{card_id: 'tst1-001', catalog: 'international'}]);
		assert.ok(await added() <= 2, 'the one row\'s art, not every row');
		assert.deepEqual(fake.log.slice(mark).filter((item) => item.device === 'viewer').map((item) => `${item.method} ${item.path}`), [], 'no wishlist, family, or photo read');
		assert.equal(await page.evaluate(() => window.scrollY), scrolled);
		await waitPhoto(page, art, 'a-1');

		// The family's photo lists read again: the rows' art follows them, and
		// their wishlist is not read again.
		mark = fake.log.length;
		added = await countAdded(page, '#wishlist-items', '.wl-item');
		await page.evaluate(async () => (await import('/pokemon-card-tracker/js/photos/shared.js')).refreshSharedPhotos());
		await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
		assert.equal(await added(), 0, 'no row drawn again');
		assert.deepEqual(fake.log.slice(mark).filter((item) => item.device === 'viewer' && /wishlist|group_overview/.test(`${item.path}${decodeURIComponent(item.search || '')}`)), [], 'their wishlist is not read again');
		assert.equal(await page.evaluate(() => window.scrollY), scrolled);
		await waitPhoto(page, art, 'a-1');

		assert.deepEqual(errors, []);
		await context.close();
	});

	test('their binder pockets and goal cells show their photos and pin, never the viewer\'s', async () => {
		const fake = new FakeStorageSupabase();
		const viewer = fake.addUser('member-b@example.test');
		const member = fake.addUser('member-a@example.test');
		const theirs = bucketPhoto(member.id, 'a-photo-1');
		const theirPinned = bucketPhoto(member.id, 'a-photo-2');
		const mine = bucketPhoto(viewer.id, 'b-photo-1');
		const mineToo = bucketPhoto(viewer.id, 'b-photo-2');
		const card = (n, fields = {}) => entry(`m-${n}`, {card_id: `jpt1-${n}`, catalog: 'ja', language: 'ja', ...fields});

		// Member A: jpt1-010 in a binder's first pocket with two photos on its
		// record, the second pinned, and a set goal for the Japanese set.
		fake.documents.set(member.id, {
			doc: documentWith([card('010')], {
				binders: [{cols: 3, cover_color: '#1d2e60', created_at: AT, deleted_at: null, id: 'their-binder', name: 'Theirs', notes: '', page_count: 2, rows: 3, slots: [{entry_id: 'm-010', page: 1, placed_at: AT, position: 1}], updated_at: AT}],
				card_info: [{card_id: 'jpt1-010', catalog: 'ja', created_at: AT, deleted_at: null, id: 'ja~jpt1-010~ja', language: 'ja', main_image: theirPinned.id, photos: [theirs, theirPinned], updated_at: AT}],
				goals: [{catalog: 'ja', created_at: AT, deleted_at: null, id: 'their-goal', kind: 'set', level: 'secrets', name: SET.name, target: 'jpt1', updated_at: AT}],
			}),
			updated_at: fake.now(),
			user_id: member.id,
		});
		fake.profiles.set(member.id, {display_name: 'Member A', user_id: member.id});
		fake.profiles.set(viewer.id, {display_name: 'Member B', user_id: viewer.id});

		for (const photo of [theirs, theirPinned]) {
			fake.objects.set(photo.path, {bytes: PNG, contentType: 'image/webp', owner: member.id});
		}

		for (const photo of [mine, mineToo]) {
			fake.objects.set(photo.path, {bytes: PNG, contentType: 'image/webp', owner: viewer.id});
		}

		const {context, errors, page} = await device(fake, 'viewer');

		// The Japanese set from the invented catalog, which has no images.
		await fakeTcgdex(context);
		await signIn(page, fake, viewer.email);
		await waitForSynced(page);
		fake.members.push({group_id: fake.groups[0].id, role: 'member', user_id: member.id});

		// Member B has photos of their own of both cards.
		await page.evaluate(async ([one, two]) => {
			const collection = await import('/pokemon-card-tracker/js/collection.js');

			await collection.updateCardInfo([{card_id: 'jpt1-010', catalog: 'ja', language: 'ja'}], () => ({main_image: one.id, photos: [one]}));
			await collection.updateCardInfo([{card_id: 'jpt1-011', catalog: 'ja', language: 'ja'}], () => ({photos: [two]}));
		}, [mine, mineToo]);

		// Their binder: their pinned photo in the pocket.
		await go(page, `family/${member.id}/binders/their-binder`);

		const pocket = '#binder-spread .pocket[data-page="1"][data-position="1"]';

		await waitPhoto(page, `${pocket} .art img`, theirPinned.id);
		assert.notEqual(await page.locator(`${pocket} .art img`).getAttribute('src'), await photoSrc(page, mine.id));
		await page.screenshot({path: `${SHOTS}/main-image-family-binder.png`});

		// Their goal: their pinned photo on the card they own, and the card
		// back on the one they have no photo of, never the viewer's photo.
		await go(page, `family/${member.id}/goals/their-goal`);
		await waitPhoto(page, '#goal-tile-ja-jpt1-010 .art img', theirPinned.id);
		await page.waitForSelector('#goal-tile-ja-jpt1-011 .card-back');
		assert.equal(await page.locator('#goal-tile-ja-jpt1-011 .art img').count(), 0, 'not the viewer\'s photo');
		await page.screenshot({path: `${SHOTS}/main-image-family-goal.png`});

		assert.deepEqual(errors, []);
		await context.close();
	});
});
