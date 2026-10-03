// Tests for the Ver na Liga link (js/liga.js) and its button on card detail.
//
// The query builder is tested in Node. The browser checks run when
// Playwright loads, against tests/pages-server.mjs with TCGdex faked and
// Supabase blocked. Liga Pokémon is never contacted: any request to it fails
// the test, and the button is checked by its href, never clicked.
//
// Run: node tests/liga.test.mjs
// (set PLAYWRIGHT=/path/to/node_modules/playwright for the browser checks)

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {isPromoSet, ligaName, ligaQuery, ligaUrl} from '../js/liga.js';

const SEARCH = 'https://www.ligapokemon.com.br/?view=cards/search&card=';

// The text Liga receives, read back the way its server would.
const cardParam = (href) => new URL(href).searchParams.get('card');

// ------------------------------------------------------- query builder

describe('ligaQuery', () => {
	// Checked by hand in a browser on 2026-10-01 (DESIGN.md section 10).
	const CHECKED = [
		[{localId: '019', name: 'Rattata', official: 165}, 'Rattata (019/165)'],
		[{localId: '4', name: 'Charizard', official: 102}, 'Charizard (4/102)'],
		[{localId: '006', name: 'Charizard ex', official: 165}, 'Charizard ex (006/165)'],
		[{localId: '105', name: 'Charizard ex', official: 112}, 'Charizard ex (105/112)'],
		[{localId: '11', name: 'Charizard EX', official: 106}, 'Charizard-EX (11/106)'],
		[{localId: '20', name: 'Charizard GX', official: 147}, 'Charizard-GX (20/147)'],
		[{localId: '20', name: 'Charizard VMAX', official: 189}, 'Charizard-VMAX (20/189)'],
	];

	for (const [card, expected] of CHECKED) {
		test(`builds ${expected}`, () => {
			assert.equal(ligaQuery(card), expected);
			assert.equal(ligaUrl(card), SEARCH + encodeURIComponent(expected));
			assert.equal(cardParam(ligaUrl(card)), expected);
		});
	}

	test('keeps localId exactly as given, never re-padded', () => {
		assert.equal(ligaQuery({localId: '4', name: 'Charizard', official: 102}), 'Charizard (4/102)');
		assert.equal(ligaQuery({localId: '004', name: 'Charizard', official: 102}), 'Charizard (004/102)');
	});

	test('returns null when a part is missing, so no wrong query is built', () => {
		assert.equal(ligaQuery({localId: '4', name: 'Charizard'}), null);
		assert.equal(ligaQuery({localId: '4', name: 'Charizard', official: 0}), null);
		assert.equal(ligaQuery({localId: '4', name: 'Charizard', official: '102'}), null);
		assert.equal(ligaQuery({localId: '', name: 'Charizard', official: 102}), null);
		assert.equal(ligaQuery({name: 'Charizard', official: 102}), null);
		assert.equal(ligaQuery({localId: '4', name: '', official: 102}), null);
		assert.equal(ligaQuery({localId: '4', official: 102}), null);
		assert.equal(ligaQuery(), null);
		assert.equal(ligaUrl({localId: '4', name: 'Charizard', official: null}), null);
	});
});

describe('ligaName', () => {
	test('hyphenates each uppercase suffix at the end of the name', () => {
		assert.equal(ligaName('Charizard EX'), 'Charizard-EX');
		assert.equal(ligaName('Charizard GX'), 'Charizard-GX');
		assert.equal(ligaName('Charizard V'), 'Charizard-V');
		assert.equal(ligaName('Charizard VMAX'), 'Charizard-VMAX');
		assert.equal(ligaName('Charizard VSTAR'), 'Charizard-VSTAR');
		assert.equal(ligaName('Pikachu V-UNION'), 'Pikachu-V-UNION');
	});

	test('changes only the last space, in multiword names', () => {
		assert.equal(ligaName('M Charizard EX'), 'M Charizard-EX');
		assert.equal(ligaName('Reshiram & Charizard GX'), 'Reshiram & Charizard-GX');
	});

	test('leaves lowercase ex and mixed case alone', () => {
		assert.equal(ligaName('Charizard ex'), 'Charizard ex');
		assert.equal(ligaName('Charizard Ex'), 'Charizard Ex');
		assert.equal(ligaName('Charizard gx'), 'Charizard gx');
		assert.equal(ligaName('Charizard vmax'), 'Charizard vmax');
	});

	test('V only at the end and as a whole word, never inside a word', () => {
		assert.equal(ligaName('Vileplume'), 'Vileplume');
		assert.equal(ligaName('Venusaur'), 'Venusaur');
		assert.equal(ligaName('Victini V'), 'Victini-V');
		assert.equal(ligaName('Pikachu V Box'), 'Pikachu V Box');
		assert.equal(ligaName('Mew VX'), 'Mew VX');
		assert.equal(ligaName('CharizardV'), 'CharizardV');
		assert.equal(ligaName('Charizard EXV'), 'Charizard EXV');
		assert.equal(ligaName('V'), 'V');
	});

	test('a name Liga already hyphenates stays as it is', () => {
		assert.equal(ligaName('Charizard-EX'), 'Charizard-EX');
		assert.equal(ligaName('Charizard'), 'Charizard');
	});
});

// Rules checked by hand in a browser later on 2026-10-01.
describe('more checked rules', () => {
	test('V and VSTAR hyphenate', () => {
		assert.equal(ligaName('Charizard V'), 'Charizard-V');
		assert.equal(ligaName('Mewtwo VSTAR'), 'Mewtwo-VSTAR');
		assert.equal(ligaQuery({localId: '019', name: 'Charizard VSTAR', official: 159, setId: 'swsh12.5', setName: 'Crown Zenith'}), 'Charizard-VSTAR (019/159)');
	});

	test('Mega and Radiant names are unchanged', () => {
		assert.equal(ligaQuery({localId: '013', name: 'Mega Charizard X ex', official: 94, setId: 'me02', setName: 'Phantasmal Flames'}), 'Mega Charizard X ex (013/094)');
		assert.equal(ligaQuery({localId: '001', name: 'Radiant Charizard', official: 44}), 'Radiant Charizard (001/044)');
		assert.equal(ligaName('Mega Charizard Y ex'), 'Mega Charizard Y ex');
	});

	test('gender symbols are removed, with any space before them', () => {
		assert.equal(ligaName('Nidoran♀'), 'Nidoran');
		assert.equal(ligaName('Nidoran♂'), 'Nidoran');
		assert.equal(ligaName('Nidoran ♀'), 'Nidoran');
		assert.equal(ligaQuery({localId: '029', name: 'Nidoran♀', official: 151}), 'Nidoran (029/151)');
		assert.equal(ligaQuery({localId: '032', name: 'Nidoran♂', official: 151}), 'Nidoran (032/151)');
		assert.equal(ligaQuery({localId: '029', name: 'Nidoran♀', official: 165, setId: 'sv03.5', setName: '151'}), 'Nidoran (029/165)');
	});

	test('apostrophes and trainer names stay in English as given', () => {
		assert.equal(ligaQuery({localId: '083', name: 'Farfetch\'d', official: 165}), 'Farfetch\'d (083/165)');
		assert.equal(ligaQuery({localId: '132', name: 'Boss\'s Orders', official: 172, setId: 'swsh9', setName: 'Brilliant Stars'}), 'Boss\'s Orders (132/172)');
	});

	test('a lettered number puts its letters on the total', () => {
		assert.equal(ligaQuery({localId: 'GG44', name: 'Pikachu', official: 70, setId: 'swsh12.5gg', setName: 'Crown Zenith Galarian Gallery'}), 'Pikachu (GG44/GG70)');
		assert.equal(ligaQuery({localId: 'TG03', name: 'Charizard', official: 30}), 'Charizard (TG03/TG30)');
		assert.equal(ligaQuery({localId: 'SV49', name: 'Charizard-GX', official: 94, setId: 'sma', setName: 'Hidden Fates Shiny Vault'}), 'Charizard-GX (SV49/SV94)');
	});

	test('a zero-padded number pads the total to the same width; vintage stays unpadded', () => {
		assert.equal(ligaQuery({localId: '006', name: 'Charizard ex', official: 25}), 'Charizard ex (006/025)');
		assert.equal(ligaQuery({localId: '4', name: 'Charizard', official: 102}), 'Charizard (4/102)');
		assert.equal(ligaQuery({localId: '100', name: 'Charizard', official: 94}), 'Charizard (100/094)');
	});

	test('a promo uses its number alone, with or without an official count', () => {
		for (const setId of ['swshp', 'svp', 'smp', 'xyp', 'bwp', 'mep']) {
			assert.equal(ligaQuery({localId: 'SWSH050', name: 'Charizard V', setId}), 'Charizard-V (SWSH050)', setId);
		}

		assert.equal(ligaQuery({localId: 'SWSH050', name: 'Charizard V', official: 307, setId: 'swshp', setName: 'SWSH Black Star Promos'}), 'Charizard-V (SWSH050)');
		assert.equal(ligaQuery({localId: '023', name: 'Mega Charizard X ex', official: 0, setId: 'mep', setName: 'MEP Black Star Promos'}), 'Mega Charizard X ex (023)');
		assert.equal(ligaQuery({localId: '5', name: 'Pikachu', setId: 'P-A', setName: 'Promos-A'}), 'Pikachu (5)', 'a set named Promo');
		assert.equal(isPromoSet('swsh9', 'Brilliant Stars'), false);
		assert.equal(isPromoSet('sv03.5', '151'), false);
		assert.equal(isPromoSet(undefined, undefined), false);
	});
});

describe('Japanese promos', () => {
	test('SM1p to SM5p are regular sets with a total; SV-P and M-P are promos', () => {
		assert.equal(ligaQuery({catalog: 'ja', localId: '025', name: 'Pikachu', official: 51, setId: 'SM1p', setName: 'Sun & Moon'}), 'Pikachu (025/051)');
		assert.equal(ligaQuery({catalog: 'ja', localId: '12', name: 'Pikachu', official: 114, setId: 'SM4p', setName: 'Test set'}), 'Pikachu (12/114)');
		assert.equal(ligaQuery({catalog: 'ja', localId: '001', name: 'Pikachu', official: 0, setId: 'SV-P', setName: 'Scarlet & Violet Promotional Cards'}), 'Pikachu (001)');
		assert.equal(ligaQuery({catalog: 'ja', localId: '001', name: 'Pikachu', official: 0, setId: 'M-P', setName: 'Promos'}), 'Pikachu (001)');
		assert.equal(isPromoSet('SM1p', 'Test', 'ja'), false);
		assert.equal(isPromoSet('SV-P', 'Test', 'ja'), true);
		assert.equal(isPromoSet('SV1S', 'スカーレットex', 'ja'), false);
		assert.equal(isPromoSet('svp', 'Test'), true, 'the English rule is unchanged');
	});
});

describe('ligaUrl encoding', () => {
	const cases = [
		[{localId: '20', name: 'Reshiram & Charizard GX', official: 214}, 'Reshiram & Charizard-GX (20/214)', 'Reshiram%20%26%20Charizard-GX%20(20%2F214)'],
		[{localId: '83', name: 'Farfetch\'d', official: 102}, 'Farfetch\'d (83/102)', 'Farfetch\'d%20(83%2F102)'],
		[{localId: '064', name: 'Flabébé', official: 122}, 'Flabébé (064/122)', 'Flab%C3%A9b%C3%A9%20(064%2F122)'],
		[{localId: '5', name: 'Mr. Mime ☆', official: 64}, 'Mr. Mime ☆ (5/64)', 'Mr.%20Mime%20%E2%98%86%20(5%2F64)'],
		[{localId: '132', name: 'Boss\'s Orders', official: 172}, 'Boss\'s Orders (132/172)', 'Boss\'s%20Orders%20(132%2F172)'],
		[{localId: 'GG44', name: 'Pokémon Center Lady', official: 70}, 'Pokémon Center Lady (GG44/GG70)', 'Pok%C3%A9mon%20Center%20Lady%20(GG44%2FGG70)'],
		[{localId: 'SWSH050', name: 'Charizard V', setId: 'swshp'}, 'Charizard-V (SWSH050)', 'Charizard-V%20(SWSH050)'],
		[{localId: '1', name: 'A+B #?=', official: 9}, 'A+B #?= (1/9)', 'A%2BB%20%23%3F%3D%20(1%2F9)'],
	];

	for (const [card, text, encoded] of cases) {
		test(`encodes ${text}`, () => {
			const href = ligaUrl(card);

			assert.equal(href, SEARCH + encoded);
			assert.equal(cardParam(href), text, 'Liga reads back exactly the text');
			assert.equal(new URL(href).searchParams.get('view'), 'cards/search', 'the card text cannot break out of its parameter');
		});
	}
});

// ------------------------------------------------------ browser checks

const require = createRequire(import.meta.url);
let playwright = null;

try {
	playwright = require(process.env.PLAYWRIGHT || 'playwright');
}
catch {
	// Browser checks are skipped below.
}

describe('Ver na Liga on card detail', {skip: playwright ? false : 'Playwright not found (set PLAYWRIGHT)'}, () => {
	const BASE = '/pokemon-card-tracker/';
	let server;
	let browser;

	let fakePokeApi;

	before(async () => {
		const {startPagesServer} = await import('./pages-server.mjs');

		({fakePokeApi} = await import('./fake-pokeapi.mjs'));

		server = await startPagesServer();
		browser = await playwright.chromium.launch();
	});

	after(async () => {
		await browser?.close();
		await server?.close();
	});

	const url = (path) => `${server.origin}${BASE}${path}`;

	const SET = {cardCount: {official: 147, total: 170}, id: 'tst1', name: 'Test set tst1'};

	// Card records by "<lang>/<id>". Anything else is a 404.
	const RECORDS = {
		'en/tst1-020': {id: 'tst1-020', illustrator: 'Someone', localId: '020', name: 'Charizard GX', rarity: 'Rare', set: SET, variants_detailed: []},
		'ja/tst1-020': {category: 'Pokemon', dexId: [6], id: 'tst1-020', localId: '020', name: 'リザードンGX', set: {...SET, name: 'テストセット'}, variants_detailed: []},
		// A Japanese Trainer: no English name is guessed, so no button.
		'ja/tst1-021': {category: 'Trainer', id: 'tst1-021', localId: '021', name: 'テストのくすり', set: {...SET, name: 'テストセット'}, variants_detailed: []},
		// A Japanese Pokémon whose name is not a species name.
		'ja/tst1-022': {category: 'Pokemon', id: 'tst1-022', localId: '022', name: 'Nのナゾモン', set: {...SET, name: 'テストセット'}, variants_detailed: []},
		'ko/tst1-020': {category: 'Pokemon', dexId: [6], id: 'tst1-020', localId: '020', name: '리자몽GX', set: {...SET, name: '테스트 세트'}, variants_detailed: []},
		'zh-tw/tst1-020': {category: 'Pokemon', dexId: [6], id: 'tst1-020', localId: '020', name: '噴火龍GX', set: {...SET, name: '測試'}, variants_detailed: []},
		'pt/tst1-020': {id: 'tst1-020', localId: '020', name: 'Charizard GX (pt)', set: {...SET, name: 'Conjunto de teste'}, variants_detailed: []},
		// No English record for this one, and none for an official count.
		'pt/tst1-030': {id: 'tst1-030', localId: '030', name: 'Só em português', set: SET, variants_detailed: []},
		'en/tst1-040': {id: 'tst1-040', localId: '040', name: 'No count', set: {id: 'tst1', name: 'Test set tst1'}, variants_detailed: []},
		'en/swshp-SWSH050': {id: 'swshp-SWSH050', localId: 'SWSH050', name: 'Charizard V', set: {cardCount: {official: 307, total: 307}, id: 'swshp', name: 'SWSH Black Star Promos'}, variants_detailed: []},
	};

	async function open(path) {
		const context = await browser.newContext({serviceWorkers: 'block', viewport: {height: 740, width: 360}});
		const liga = [];

		await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
		await context.route('https://*.supabase.co/**', (route) => route.abort());
		await fakePokeApi(context);
		await context.route(/ligapokemon\.com\.br/, (route) => {
			liga.push(route.request().url());

			return route.abort();
		});
		await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));
		await context.route('https://api.tcgdex.net/**', (route) => {
			const key = new URL(route.request().url()).pathname.replace(/^\/v2\//, '').replace('/cards/', '/');
			const record = RECORDS[key];

			return route.fulfill(record
				? {body: JSON.stringify(record), contentType: 'application/json', status: 200}
				: {body: '{}', contentType: 'application/json', status: 404});
		});

		const page = await context.newPage();
		const errors = [];

		page.on('pageerror', (err) => errors.push(err));
		await page.goto(url(path));
		await page.waitForSelector('.card-detail h2');

		const done = async () => {
			assert.deepEqual(errors, []);
			assert.deepEqual(await page.locator('#errors .error').allTextContents(), []);
			assert.deepEqual(liga, [], 'Liga Pokémon is never contacted');
			await context.close();
		};

		return {done, page};
	}

	// The one Ver na Liga, right under Your copies (Q-04). The price panel
	// draws its own too, which css/copies.css hides on card detail.
	const linkSelector = '#card-liga a:has-text("Ver na Liga")';

	test('an English card links to Liga\'s search for it', async () => {
		const {done, page} = await open('cards/en/tst1-020');
		const link = page.locator(linkSelector);

		await link.waitFor({state: 'visible'});
		assert.equal(await link.getAttribute('href'), `${SEARCH}Charizard-GX%20(020%2F147)`);
		assert.equal(await link.getAttribute('target'), '_blank');
		assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
		assert.equal(await page.locator('#card-liga .liga-link .copies-sr').textContent(), ' (opens Liga Pokémon)');
		assert.equal(await page.locator(linkSelector).count(), 1, 'one Ver na Liga, under Your copies');
		assert.equal(await page.locator('.hero-facts a:not(.illustrator-goal)').count(), 0, 'none in the hero facts but the artist goal link');

		// The rest of card detail is still there.
		assert.equal(await page.locator('.card-detail h2').textContent(), 'Charizard GX');
		assert.match(await page.locator('.facts').textContent(), /Number020 \/ 147/);
		assert.match(await page.locator('.facts').textContent(), /RarityRare/);
		await done();
	});

	test('a Portuguese view of the card uses the English name', async () => {
		const {done, page} = await open('cards/pt/tst1-020');
		const link = page.locator(linkSelector);

		await link.waitFor({state: 'visible'});
		assert.equal(await page.locator('.card-detail h2').textContent(), 'Charizard GX (pt)');
		assert.equal(cardParam(await link.getAttribute('href')), 'Charizard-GX (020/147)');
		await done();
	});

	test('a promo links by its number alone', async () => {
		const {done, page} = await open('cards/en/swshp-SWSH050');
		const link = page.locator(linkSelector);

		await link.waitFor({state: 'visible'});
		assert.equal(await link.getAttribute('href'), `${SEARCH}Charizard-V%20(SWSH050)`);
		await done();
	});

	test('a Japanese Pokémon links by its English name and the Japanese set\'s number', async () => {
		const {done, page} = await open('cards/ja/tst1-020');
		const link = page.locator(linkSelector);

		await link.waitFor({state: 'visible'});
		assert.equal(cardParam(await link.getAttribute('href')), 'Charizard-GX (020/147)');
		assert.equal(await page.locator('.card-detail h2').textContent(), 'Charizard GX');
		assert.equal(await page.locator('.card-detail .name-original').textContent(), 'リザードンGX (Lizardon GX)');
		await done();
	});

	test('a Japanese card with no English name, and Korean and Chinese cards, get no button', async () => {
		for (const path of ['cards/ja/tst1-021', 'cards/ja/tst1-022', 'cards/ko/tst1-020', 'cards/zh-tw/tst1-020']) {
			const {done, page} = await open(path);

			await page.waitForSelector('.facts');
			// Let the names load and any lookup the view might start settle.
			await page.waitForTimeout(500);
			assert.equal(await page.locator(linkSelector).count(), 0, path);
			await page.waitForSelector('#card-liga-none');

			const none = await page.locator('#card-liga-none').textContent();

			assert.equal(none, path.includes('/ko/') ? 'No Liga link for Korean prints.' : path.includes('/zh-tw/') ? 'No Liga link for Chinese (Traditional) prints.' : 'No Liga link for this card.', path);
			await done();
		}
	});

	test('Korean and Chinese cards still show their English name', async () => {
		const korean = await open('cards/ko/tst1-020');

		await korean.page.waitForSelector('.card-detail h2:has-text("Charizard GX")');
		assert.equal(await korean.page.locator('.card-detail .name-original').textContent(), '리자몽GX (Rijamong GX)');
		await korean.done();

		const chinese = await open('cards/zh-tw/tst1-020');

		await chinese.page.waitForSelector('.card-detail h2:has-text("Charizard GX")');
		// No reading for Chinese yet.
		assert.equal(await chinese.page.locator('.card-detail .name-original').textContent(), '噴火龍GX');
		await chinese.done();

		const trainer = await open('cards/ja/tst1-021');

		await trainer.page.waitForSelector('.card-detail .name-original');
		assert.equal(await trainer.page.locator('.card-detail h2').textContent(), 'テストのくすり');
		assert.equal(await trainer.page.locator('.card-detail .name-original').textContent(), '(Tesutonokusuri)');
		await trainer.done();
	});

	test('no English record, or no official count, hides the button', async () => {
		for (const path of ['cards/pt/tst1-030', 'cards/en/tst1-040']) {
			const {done, page} = await open(path);

			await page.waitForSelector('.facts');
			await page.waitForTimeout(500);
			assert.equal(await page.locator(linkSelector).count(), 0, path);
			await page.waitForSelector('#card-liga-none');
			assert.equal(await page.locator('#card-liga-none').textContent(), 'No Liga link for this card.', path);
			await done();
		}
	});
});
