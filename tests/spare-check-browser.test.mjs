// Browser tests for the free count and Check spares (Eric, 2026-11-25): the
// tile's "×3 | 1" badge on My Cards, in light and dark, clear of the other
// corners; Check spares from the Spares screen and from a card page; and
// "I don't have this one", which logs a gift in the trades log, and its
// Undo. Headless Chromium at 390 x 844 against tests/pages-server.mjs, every
// outside service faked.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/spare-check-browser.test.mjs
// Screenshots: $SHOTS (default /tmp)/spare-check-*.png

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {BASE, fakeServices, seed} from './my-cards-fixtures.mjs';
import {startPagesServer} from './pages-server.mjs';
import {copy, wireTrade} from './trade-harness.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const SHOTS = process.env.SHOTS || '/tmp';
const TIMEOUT = {timeout: 20000};

const at = (day) => `2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`;

// Charmander EN: three copies, one in Region, one in 30 anos, one loose, so
// one free (Eric's Scraggy). Charizard ex EN: two copies, the spare taken
// off sale, so none free. Pikachu PT: two loose copies, one free, so its
// tile has the language flag in the corner too.
const COPIES = [
	copy('c-02', 'tsa1-004', {condition: 'Near Mint'}),
	copy('c-03', 'tsa1-004', {condition: 'Played', finish_raw: 'Reverse Holofoil'}),
	copy('c-04', 'tsa1-004', {condition: 'Near Mint'}),
	copy('c-07', 'tsa1-006'),
	copy('c-08', 'tsa1-006', {for_sale: false}),
	copy('c-09', 'tsb2-025', {language: 'pt'}),
	copy('c-10', 'tsb2-025', {language: 'pt'}),
];

const binder = (id, name, entryId) => ({
	cols: 3,
	cover_color: '#1b1b1f',
	created_at: at(1),
	deleted_at: null,
	id,
	name,
	notes: '',
	page_count: 10,
	rows: 3,
	slots: [{entry_id: entryId, page: 1, placed_at: at(1), position: 1}],
	updated_at: at(1),
});

const BINDERS = [binder('b-1', 'Region', 'c-02'), binder('b-2', '30 anos', 'c-03')];

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

async function phone({colorScheme = 'light', copies = COPIES} = {}) {
	const context = await browser.newContext({colorScheme, serviceWorkers: 'block', viewport: {height: 844, width: 390}});

	await fakeServices(context);
	await fakePokeApi(context);
	await wireTrade(context);

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err.message));
	await seed(page, server.origin, {binders: BINDERS, copies});
	await page.locator('.card-grid .tile').first().waitFor(TIMEOUT);

	return {context, errors, page};
}

// The document on the phone.
const saved = (page) => page.evaluate(() => new Promise((resolve, reject) => {
	const open = indexedDB.open('card-tracker-collection', 1);

	open.onsuccess = () => {
		const read = open.result.transaction('documents').objectStore('documents').get('local');

		read.onsuccess = () => {
			open.result.close();
			resolve(read.result);
		};
		read.onerror = () => reject(read.error);
	};
	open.onerror = () => reject(open.error);
}));

// Each tile's name and its quantity badge: [name, aria-label, text].
const badges = (page) => page.locator('.card-grid .tile').evaluateAll((tiles) => tiles.map((tile) => {
	const badge = tile.querySelector('.badge-qty');

	return [tile.querySelector('.tile-name').textContent, badge && badge.getAttribute('aria-label'), badge && badge.textContent];
}));

const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe('the free count on My Cards', () => {
	for (const colorScheme of ['light', 'dark']) {
		test(`×3 | 1 on Charmander, ×2 alone on Charizard ex, clear of the other corners (${colorScheme})`, async () => {
			const {context, errors, page} = await phone({colorScheme});
			const rows = Object.fromEntries((await badges(page)).map(([name, label, text]) => [name, [label, text]]));

			assert.deepEqual(rows.Charmander, ['3 copies, 1 free', '×31']);
			assert.deepEqual(rows['Charizard ex'], ['2 copies, none free', '×2']);
			assert.deepEqual(rows.Pikachu, ['2 copies, 1 free', '×21']);

			const tile = page.locator('.card-grid .tile', {hasText: 'Pikachu'}).first();
			const qty = await tile.locator('.badge-qty').boundingBox();
			const art = await tile.locator('.art-wrap').boundingBox();

			assert.ok(qty.x + qty.width <= art.x + art.width + 0.5 && qty.x >= art.x, 'inside the art');

			const others = await tile.locator('.badge-corner, .badge-status, .badge-fav, .tile-badge').evaluateAll((nodes) => nodes.map((node) => {
				const box = node.getBoundingClientRect();

				return {className: node.className, height: box.height, width: box.width, x: box.x, y: box.y};
			}));

			assert.ok(others.length, 'the flag corner is drawn');

			for (const box of others) {
				assert.ok(!overlaps(qty, box), `clear of ${box.className}`);
			}

			// The green half reads white on green: the same colors in both
			// themes, since it sits on the card art.
			const colors = await tile.locator('.qty-free').evaluate((node) => [getComputedStyle(node).backgroundColor, getComputedStyle(node).color]);

			assert.deepEqual(colors, ['rgb(27, 122, 62)', 'rgb(255, 255, 255)']);
			await page.screenshot({path: `${SHOTS}/spare-check-cards-${colorScheme}.png`});
			assert.deepEqual(errors, []);
			await context.close();
		});
	}

	test('qtyBadge: a pocket\'s own label wins, and no free count draws the badge as before', async () => {
		const {context, errors, page} = await phone();
		const rows = await page.evaluate(async (base) => {
			const {qtyBadge} = await import(`${base}js/tile.js`);
			const read = (node) => [node.getAttribute('aria-label'), node.className, node.textContent];

			return [
				read(qtyBadge(5, {free: 2, label: '2 cards fit, 5 copies'})),
				read(qtyBadge(3)),
				read(qtyBadge(3, {free: 0})),
				read(qtyBadge(3, {free: 7})),
			];
		}, BASE);

		assert.deepEqual(rows, [
			['2 cards fit, 5 copies', 'badge badge-qty badge-qty-split', '×52'],
			['3 copies', 'badge badge-qty', '×3'],
			['3 copies, none free', 'badge badge-qty', '×3'],
			['3 copies, 3 free', 'badge badge-qty badge-qty-split', '×33'],
		]);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('the List view says how many are free', async () => {
		const {context, errors, page} = await phone();

		await page.evaluate(() => localStorage.setItem('cardTracker.cardsView', 'list'));
		await page.reload();

		await page.locator('.row-qty').first().waitFor(TIMEOUT);
		assert.deepEqual((await page.locator('.row-qty').allTextContents()).sort(), ['×2', '×2, 1 free', '×3, 1 free']);

		assert.deepEqual(errors, []);
		await context.close();
	});
});

describe('Check spares', () => {
	test('from Spares: every card with more than one copy, where each is and why', async () => {
		const {context, errors, page} = await phone();

		await page.click('#cards-trade');
		await page.locator('#cards-check').waitFor(TIMEOUT);
		await page.click('#cards-check');
		await page.waitForFunction(() => /cards with more than one copy/.test(document.getElementById('check-summary').textContent));

		assert.equal(await page.locator('#check-summary').textContent(), '3 cards with more than one copy: 7 copies, 2 free.');

		const charmander = page.locator('.check-group', {hasText: 'Charmander'});

		assert.equal(await charmander.locator('.check-count').textContent(), '3 copies, 1 free');
		assert.deepEqual(await charmander.locator('.check-copy-where').allTextContents(), ['Loose', 'Region, page 1, pocket 1', '30 anos, page 1, pocket 1']);
		assert.deepEqual(await charmander.locator('.check-tag').allTextContents(), ['Spare', 'In a pocket', 'In a pocket']);
		assert.deepEqual(await page.locator('.check-group', {hasText: 'Charizard ex'}).locator('.check-tag').allTextContents(), ['Not for sale', 'Kept']);
		assert.doesNotMatch(await page.locator('#check-list').textContent(), /null/);
		await page.screenshot({fullPage: true, path: `${SHOTS}/spare-check-screen.png`});

		// The loose Charmander is gone: logged as a gift, and Undo brings it back.
		await charmander.locator('.check-copy').first().locator('.check-gone').click();
		await page.locator('.toast', {hasText: 'logged as given away'}).waitFor(TIMEOUT);
		await page.waitForFunction(() => {
			const group = [...document.querySelectorAll('.check-group')].find((node) => node.textContent.includes('Charmander'));

			return group && group.querySelector('.check-count').textContent === '2 copies, none free';
		}, null, TIMEOUT);

		let doc = await saved(page);
		const gift = doc.moves.find((move) => move.kind === 'gift');

		assert.deepEqual([gift.out, gift.money, gift.price, gift.note], [['c-04'], null, null, 'Not found in Check spares']);
		assert.ok(doc.cards.find((entry) => entry.id === 'c-04').deleted_at, 'the copy is gone');
		assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.textContent), 'Charmander', 'the focus stays at the card');

		await page.locator('.toast', {hasText: 'logged as given away'}).locator('button', {hasText: 'Undo'}).click();
		await page.locator('.toast', {hasText: 'Undone'}).waitFor(TIMEOUT);
		await page.waitForFunction(() => [...document.querySelectorAll('.check-count')].some((node) => node.textContent === '3 copies, 1 free'), null, TIMEOUT);
		doc = await saved(page);
		assert.equal(doc.cards.find((entry) => entry.id === 'c-04').deleted_at, null);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('from a card page: that card only, and the way back', async () => {
		const {context, errors, page} = await phone();

		await page.setViewportSize({height: 740, width: 360});
		await page.goto(`${server.origin}${BASE}cards/en/tsa1-004`);
		await page.locator('#copies-check').waitFor(TIMEOUT);

		await page.screenshot({path: `${SHOTS}/spare-check-card-page.png`});

		// Check sits under Your copies, inside the head row, which it does
		// not make taller than Add a copy.
		const [row, link, add] = await Promise.all(['.copies-head', '#copies-check', '#copy-add'].map((selector) => page.locator(selector).boundingBox()));

		assert.ok(link.y + link.height <= row.y + row.height + 0.5, 'inside the head row');
		assert.ok(row.height <= add.height + 0.5, `the head row is ${row.height} px, Add a copy ${add.height} px`);
		assert.equal(await page.locator('#copies-check').getAttribute('aria-label'), 'Check where each copy is');
		await page.click('#copies-check');
		await page.waitForFunction(() => document.getElementById('check-summary').textContent === '3 copies, 1 free', null, TIMEOUT);
		assert.equal(await page.locator('.check-group').count(), 1);
		assert.equal(await page.locator('#check-back').getAttribute('href'), `${BASE}cards/en/tsa1-004`);

		// One copy only: no Check on the card page.
		await page.goto(`${server.origin}${BASE}cards/en/tsa1-006`);
		await page.locator('#copies-title').waitFor(TIMEOUT);
		assert.equal(await page.locator('#copies-check').count(), 1, 'Charizard ex has two copies');
		assert.deepEqual(errors, []);
		await context.close();
	});
});

// Eric, 2026-11-26: narrow the list to the pile in hand and walk it in his
// order; favorites with more than one copy are in the list too. Bulbasaur
// is starred, two copies; Sprigatito has two loose copies, one free.
describe('Check spares: search, sort, Where, and Show', () => {
	const MORE = [
		...COPIES,
		copy('c-11', 'tsa1-001', {is_favorite: true}),
		copy('c-12', 'tsa1-001'),
		copy('c-13', 'tsb2-090'),
		copy('c-14', 'tsb2-090'),
	];
	const names = (page) => page.locator('.check-group .check-name').allTextContents();

	// Check spares downloads no card details itself: it reads the ones My
	// Cards' background pass saved, so a test of Region waits for them.
	const detailsIn = async (page, cardIds) => {
		const start = Date.now();

		while (!(await page.evaluate(async ({base, keys}) => {
			const {cardIndex} = await import(`${base}js/catalog.js`);
			const index = await cardIndex();

			return keys.every((key) => index.has(key) && Array.isArray(index.get(key).dex_ids));
		}, {base: BASE, keys: cardIds.map((id) => `international|${id}`)}))) {
			assert.ok(Date.now() - start < TIMEOUT.timeout, 'the details reach the index');
			await page.waitForTimeout(100);
		}
	};
	const KNOWN = ['tsa1-001', 'tsa1-004', 'tsa1-006', 'tsb2-025', 'tsb2-090'];
	const summaryIs = (page, text) => page.waitForFunction((want) => document.getElementById('check-summary').textContent === want, text, TIMEOUT);

	test('a favorite pair is listed; Show, Where, the sort, the search, and Clear all narrow and order it', async () => {
		const {context, errors, page} = await phone({copies: MORE});

		await page.setViewportSize({height: 740, width: 360});
		await page.goto(`${server.origin}${BASE}trade/check`);
		await summaryIs(page, '5 cards with more than one copy: 11 copies, 3 free.');

		const bulbasaur = page.locator('.check-group', {hasText: 'Bulbasaur'});

		assert.equal(await bulbasaur.locator('.check-count').textContent(), '2 copies, none free');
		assert.deepEqual(await bulbasaur.locator('.check-tag').allTextContents(), ['Favorite', 'Favorite']);

		// The bar fits a 360 px phone with no sideways scroll.
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');

		for (const selector of ['#check-search', '#check-sort', '#check-filters', '#check-where', '#check-show']) {
			const box = await page.locator(selector).boundingBox();

			assert.ok(box && box.x >= 0 && box.x + box.width <= 360.5, `${selector} inside the screen`);
		}

		await page.screenshot({path: `${SHOTS}/spare-check-bar.png`});

		// Show: Favorites.
		await page.selectOption('#check-show', 'favorite');
		await summaryIs(page, '1 of 5 cards with more than one copy: 2 copies, 0 free.');
		assert.deepEqual(await names(page), ['Bulbasaur']);

		// Where: the Region binder's pockets, with every Show.
		await page.selectOption('#check-show', 'all');
		assert.deepEqual(await page.locator('#check-where option').allTextContents(), ['Anywhere', '30 anos · 1 copy', 'Region · 1 copy', 'Loose · 9 copies']);
		await page.selectOption('#check-where', {label: 'Region · 1 copy'});
		await summaryIs(page, '1 of 5 cards with more than one copy: 3 copies, 1 free.');
		assert.deepEqual(await names(page), ['Charmander']);

		// The pile checked: the place stays picked, by name, at 0. Undo.
		await page.locator('.check-copy', {hasText: 'Region, page 1'}).locator('.check-gone').click();
		await summaryIs(page, 'No card matches. Clear all shows every card again.');
		assert.equal(await page.locator('#check-where option:checked').textContent(), 'Region · 0 copies');
		await page.locator('.toast', {hasText: 'logged as given away'}).locator('button', {hasText: 'Undo'}).click();
		await summaryIs(page, '1 of 5 cards with more than one copy: 3 copies, 1 free.');

		// The oldest set first, then the number: Test Beta, then Test Alpha.
		await page.selectOption('#check-where', 'any');
		await page.selectOption('#check-sort', 'setOld');
		await page.waitForFunction(() => document.querySelectorAll('.check-group').length === 5, null, TIMEOUT);
		assert.deepEqual(await names(page), ['Pikachu', 'Sprigatito', 'Bulbasaur', 'Charmander', 'Charizard ex']);

		// The search, then Clear all, which clears Show and Where too.
		await page.selectOption('#check-show', 'free');
		await page.fill('#check-search', 'pika');
		await summaryIs(page, '1 of 5 cards with more than one copy: 2 copies, 1 free.');
		assert.deepEqual(await names(page), ['Pikachu']);
		await page.locator('.fb-clear').click();
		await summaryIs(page, '5 cards with more than one copy: 11 copies, 3 free.');
		assert.equal(await page.locator('#check-show').inputValue(), 'all');
		assert.equal(await page.locator('#check-search').inputValue(), '');

		// The sort is kept on this phone.
		await page.reload();
		await summaryIs(page, '5 cards with more than one copy: 11 copies, 3 free.');
		assert.equal(await page.locator('#check-sort').inputValue(), 'setOld');
		assert.deepEqual(await names(page), ['Pikachu', 'Sprigatito', 'Bulbasaur', 'Charmander', 'Charizard ex']);
		assert.deepEqual(errors, []);
		await context.close();
	});

	// Eric checks a card bag of several similar sets at once, and his Kanto
	// box by region (2026-11-26): the Filters sheet takes several sets, and
	// a region, here as on My Cards.
	test('Filters: several sets at once, a region, and both together', async () => {
		const copies = [...MORE, copy('c-15', 'TSJ1-025', {catalog: 'ja', language: 'ja'}), copy('c-16', 'TSJ1-025', {catalog: 'ja', language: 'ja'})];
		const {context, errors, page} = await phone({copies});
		// The names shown, in any order, once they settle.
		const namesAre = async (want) => {
			try {
				await page.waitForFunction((list) => {
					const shown = [...document.querySelectorAll('.check-group .check-name')].map((node) => node.textContent).sort();

					return JSON.stringify(shown) === JSON.stringify(list);
				}, [...want].sort(), TIMEOUT);
			}
			catch {
				assert.deepEqual((await names(page)).sort(), [...want].sort());
			}
		};
		const filters = async (pick) => {
			await page.click('#check-filters');
			await page.waitForSelector('#check-sheet[open]');
			await pick();
			await page.click('#check-sheet .fb-show');
			await page.locator('#check-sheet').waitFor({state: 'hidden'});
		};

		// The card details My Cards' background pass keeps on the phone,
		// which give each owned card its Pokédex number and so its region.
		const owned = ['international|tsa1-001', 'international|tsa1-004', 'international|tsa1-006', 'international|tsb2-025', 'international|tsb2-090', 'ja|TSJ1-025'];
		const start = Date.now();

		while (!await page.evaluate(async (keys) => {
			const {cardIndex} = await import('/pokemon-card-tracker/js/catalog.js');
			const index = await cardIndex();

			return keys.every((key) => index.has(key) && Array.isArray(index.get(key).dex_ids));
		}, owned)) {
			assert.ok(Date.now() - start < TIMEOUT.timeout, 'every owned card\'s details reach the index');
			await page.waitForTimeout(100);
		}

		await page.goto(`${server.origin}${BASE}trade/check`);
		await namesAre(['Bulbasaur', 'Charizard ex', 'Charmander', 'Pikachu', 'Sprigatito', 'ピカチュウ']);

		await filters(async () => {
			await page.selectOption('#check-f-set', 'international|tsb2');
			await page.selectOption('#check-f-set', 'ja|TSJ1');
		});
		await namesAre(['Pikachu', 'Sprigatito', 'ピカチュウ']);
		assert.equal(await page.locator('.fb-chip[data-filter="set"]').count(), 2, 'a chip a set');
		await page.screenshot({path: `${SHOTS}/spare-check-two-sets.png`});
		await page.click('.fb-chip[data-value="international|tsb2"]');
		await namesAre(['ピカチュウ']);
		await page.locator('.fb-clear').click();

		// Kanto: the Pokédex numbers 1 to 151, so Sprigatito goes.
		await filters(() => page.selectOption('#check-f-region', 'kanto'));
		await namesAre(['Bulbasaur', 'Charizard ex', 'Charmander', 'Pikachu', 'ピカチュウ']);
		await filters(() => page.selectOption('#check-f-set', 'international|tsa1'));
		await namesAre(['Bulbasaur', 'Charizard ex', 'Charmander']);
		assert.deepEqual(errors, []);
		await context.close();
	});

	// Eric's piles (2026-11-26): small bags of similar sets, a box of Kanto
	// Pokémon only, and spares kept set by set. Test Beta (2025) holds
	// Pikachu and Sprigatito; Test Alpha (2026) Bulbasaur, Charmander, and
	// Charizard ex; Sprigatito is the one Paldea Pokémon.
	test('several sets at once in the oldest set\'s order, the Kanto region, and the choice kept on the phone', async () => {
		const {context, errors, page} = await phone({copies: MORE});

		await detailsIn(page, KNOWN);
		await page.goto(`${server.origin}${BASE}trade/check`);
		await summaryIs(page, '5 cards with more than one copy: 11 copies, 3 free.');
		await page.selectOption('#check-sort', 'setOld');
		await page.selectOption('#check-show', 'free');

		// A bag of similar sets: one set, then another, the sheet's count
		// being what the list shows, Show included.
		await page.click('#check-filters');
		await page.locator('#check-sheet').waitFor(TIMEOUT);
		await page.selectOption('#check-f-set', 'international|tsa1');
		await page.waitForFunction(() => document.querySelector('#check-sheet .fb-show').textContent === 'Show 1 card', null, TIMEOUT);
		await page.selectOption('#check-f-set', 'international|tsb2');
		await page.waitForFunction(() => document.querySelector('#check-sheet .fb-show').textContent === 'Show 3 cards', null, TIMEOUT);
		await page.click('#check-sheet-close');
		await summaryIs(page, '3 of 5 cards with more than one copy: 7 copies, 3 free.');
		assert.deepEqual(await names(page), ['Pikachu', 'Sprigatito', 'Charmander']);
		assert.equal(await page.locator('.fb-chips .fb-chip').count(), 2);

		// Kept on the phone: the sets, the sort, and Show.
		await page.reload();
		await summaryIs(page, '3 of 5 cards with more than one copy: 7 copies, 3 free.');
		assert.deepEqual(await names(page), ['Pikachu', 'Sprigatito', 'Charmander']);
		assert.deepEqual([await page.locator('#check-sort').inputValue(), await page.locator('#check-show').inputValue()], ['setOld', 'free']);

		// The Kanto box.
		await page.locator('.fb-clear').click();
		await summaryIs(page, '5 cards with more than one copy: 11 copies, 3 free.');
		await page.click('#check-filters');
		await page.locator('#check-f-region option[value="kanto"]').waitFor({state: 'attached', timeout: 20000});
		assert.equal(await page.locator('#check-sheet .fb-note').count(), 0, 'no note: every card has its details');
		await page.selectOption('#check-f-region', 'kanto');
		await page.click('#check-sheet-close');
		await summaryIs(page, '4 of 5 cards with more than one copy: 9 copies, 2 free.');
		assert.deepEqual(await names(page), ['Pikachu', 'Bulbasaur', 'Charmander', 'Charizard ex']);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('the Filters sheet says details are still to come while a card lacks them', async () => {
		// tsa1-099 is not in the catalog, so its details never come.
		const {context, errors, page} = await phone({copies: [...MORE, copy('c-15', 'tsa1-099'), copy('c-16', 'tsa1-099')]});

		await detailsIn(page, KNOWN);
		await page.goto(`${server.origin}${BASE}trade/check`);
		await summaryIs(page, '6 cards with more than one copy: 13 copies, 4 free.');
		await page.click('#check-filters');
		await page.locator('#check-sheet .fb-note').waitFor(TIMEOUT);
		assert.match(await page.locator('#check-sheet .fb-note').textContent(), /fill in as card details download/);
		await page.locator('#check-f-region option[value="kanto"]').waitFor({state: 'attached', timeout: 20000});
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('one card\'s check has no bar', async () => {
		const {context, errors, page} = await phone({copies: MORE});

		await page.goto(`${server.origin}${BASE}trade/check/en/tsa1-001`);
		await summaryIs(page, '2 copies, none free');
		assert.equal(await page.locator('#check-search').count(), 0);
		assert.equal(await page.locator('#check-where').count(), 0);
		assert.deepEqual(errors, []);
		await context.close();
	});
});
