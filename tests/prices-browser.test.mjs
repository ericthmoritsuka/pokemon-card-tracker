// Browser tests for the price components (js/price-view.js, js/prices.js).
// Headless Chromium at 360 x 740, against tests/prices-harness.html served by
// tests/pages-server.mjs, with the real TCGdex records saved in
// tests/prices-fixtures.
//
// Every outside service is faked or blocked: frankfurter.dev is answered
// here, Supabase goes to tests/fake-supabase.mjs, ligapokemon.com.br is never
// requested (any attempt is counted and fails the test), and every other
// outside request is refused.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/prices-browser.test.mjs

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {FakeSupabase} from './fake-supabase.mjs';
import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const VIEWPORT = {height: 740, width: 360};
const SHOTS = process.env.SHOTS || '/tmp';
// As frankfurter answered on 2026-10-01.
const RATE = [{base: 'USD', date: '2026-10-01', quote: 'BRL', rate: 5.1877}];
const EURO_RATE = [{base: 'EUR', date: '2026-10-01', quote: 'BRL', rate: 5.8814}];

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

// Intl writes a no-break space after the currency symbol.
const plain = (text) => String(text).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

const localToday = () => {
	const now = new Date();
	const pad = (n) => String(n).padStart(2, '0');

	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

// One phone. rates: 'online' answers frankfurter, 'offline' refuses it.
// saved and savedEur: a dollar or euro rate already in localStorage.
async function phone({colorScheme = 'light', rates = 'online', saved = null, savedEur = null} = {}) {
	const context = await browser.newContext({colorScheme, viewport: VIEWPORT});
	const seen = {frankfurter: [], liga: [], other: []};

	await context.route(/^https?:\/\/(?!localhost[:/])/, (route) => {
		const url = route.request().url();

		if (/ligapokemon\.com\.br/.test(url)) {
			seen.liga.push(url);

			return route.abort('blockedbyclient');
		}

		if (url.startsWith('https://api.frankfurter.dev/')) {
			seen.frankfurter.push(url);

			return rates === 'online'
				? route.fulfill({body: JSON.stringify(/base=EUR/.test(url) ? EURO_RATE : RATE), contentType: 'application/json', headers: {'Access-Control-Allow-Origin': '*'}, status: 200})
				: route.abort('internetdisconnected');
		}

		if (url.includes('.supabase.co')) {
			return route.fallback();
		}

		seen.other.push(url);

		return route.abort('blockedbyclient');
	});
	await new FakeSupabase().attach(context, 'phone');

	if (saved) {
		await context.addInitScript((value) => localStorage.setItem('cardTracker.rates', JSON.stringify(value)), saved);
	}

	if (savedEur) {
		await context.addInitScript((value) => localStorage.setItem('cardTracker.rates.eur', JSON.stringify(value)), savedEur);
	}

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err));

	return {context, errors, page, seen};
}

async function open(device, scene) {
	await device.page.goto(`${server.origin}/pokemon-card-tracker/tests/prices-harness.html?scene=${scene}`);
	await device.page.waitForFunction(() => window.harnessReady === true);
}

async function finish(device, name) {
	const {page} = device;
	const width = await page.evaluate(() => document.documentElement.scrollWidth);

	await page.screenshot({fullPage: true, path: `${SHOTS}/prices-${name}.png`});
	assert.ok(width <= VIEWPORT.width, `no sideways scroll at 360 px (${width})`);
	assert.doesNotMatch(await page.locator('main').textContent(), /\bnull\b|\bundefined\b|NaN/, 'no null, undefined, or NaN printed');
	assert.deepEqual(device.errors.map(String), [], 'no page errors');
	assert.deepEqual(await page.locator('#errors .error').allTextContents(), [], 'no errors shown');
	assert.deepEqual(device.seen.liga, [], 'Liga Pokémon is never requested');
	assert.deepEqual(device.seen.other, [], 'no other outside request');
	await device.context.close();
}

const text = async (locator) => plain(await locator.textContent());

// Waits until both converted references have their rates.
const ratesShown = (page) => page.waitForFunction(() => [...document.querySelectorAll('.price-us-value, .price-eu-value')].length >= 2);

// WCAG contrast of an element's text against the page behind it.
const contrast = (locator) => locator.evaluate((el) => {
	const rgb = (color) => color.match(/[\d.]+/g).slice(0, 3).map(Number);
	const luminance = (color) => {
		const [r, g, b] = rgb(color).map((v) => {
			const c = v / 255;

			return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
		});

		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	};
	const fore = luminance(getComputedStyle(el).color);
	// The first background behind it that is not transparent.
	let under = el;

	while (under.parentElement && /rgba\(0, 0, 0, 0\)|transparent/.test(getComputedStyle(under).backgroundColor)) {
		under = under.parentElement;
	}

	const back = luminance(getComputedStyle(under).backgroundColor);

	return (Math.max(fore, back) + 0.05) / (Math.min(fore, back) + 0.05);
});

const storedCards = (page) => page.evaluate(async () => (await import('/pokemon-card-tracker/js/collection.js')).listCards());

describe('price section', () => {
	test('English card: TCGplayer and Cardmarket in reais, the originals small, one rate line', async () => {
		const device = await phone();
		const {page} = device;

		await open(device, 'english');

		const section = page.locator('section.price');

		await ratesShown(page);
		assert.deepEqual((await section.locator('.price-source').allTextContents()).map(plain), ['TCGplayer', 'Cardmarket']);
		assert.equal(await text(section.locator('.price-us .price-value')), '≈ About R$ 4.899,94');
		assert.equal(await text(section.locator('.price-us .price-original')), 'US$ 944,53, TCGplayer market, 30 Sep');
		assert.equal(await text(section.locator('.price-eu .price-original')), '€ 596,13, Cardmarket trend, 30 Sep');
		assert.equal(await text(section.locator('.price-rate')), 'US$ 1 = R$ 5,19 · € 1 = R$ 5,88, rates of 1 Oct.');
		assert.equal(await section.locator('.price-language').count(), 0);
		assert.equal(await section.locator('.price-for').count(), 0, 'the owned finish\'s own price needs no note');

		// No Liga editor: no form, no field, no Save.
		assert.equal(await section.locator('form, input, .price-liga').count(), 0);
		assert.doesNotMatch(await text(section), /Lowest NM|Save|Brazil/);

		// No box: the panel has no background or border of its own.
		assert.deepEqual(await section.evaluate((el) => [getComputedStyle(el).borderTopStyle, getComputedStyle(el).backgroundColor]), ['none', 'rgba(0, 0, 0, 0)']);

		// Ver na Liga, unchanged: Liga's own search for the card, in a new tab.
		const liga = section.locator('a.price-liga-link');

		assert.equal(await liga.getAttribute('href'), 'https://www.ligapokemon.com.br/?view=cards/search&card=Charizard%20(4%2F102)');
		assert.equal(await liga.getAttribute('target'), '_blank');
		assert.match(await liga.getAttribute('class'), /primary/);

		// Four printings, the owned Unlimited chosen. The 1st Edition has no
		// US price, so the Unlimited's stands in, and says so.
		const chips = section.locator('.price-finish');

		assert.equal(await chips.count(), 4);
		assert.equal(await text(section.locator('.price-finish[aria-pressed="true"]')), 'Holo, Unlimited (1 owned)');
		await chips.nth(1).click();
		assert.equal(await text(section.locator('.price-us .price-value')), '≈ About R$ 4.899,94');
		assert.equal(await text(section.locator('.price-us .price-for')), 'for Holo, Unlimited; none listed for Holo, Shadowless, 1st Edition stamp');
		assert.deepEqual(device.seen.frankfurter.map((url) => url.replace(/^.*\/v2\//, '')).sort(), ['rates?base=EUR&quotes=BRL', 'rates?base=USD&quotes=BRL']);

		await finish(device, 'english');
	});

	test('Portuguese copy: notes that the market prices are not for that printing', async () => {
		const device = await phone();
		const {page} = device;

		await open(device, 'portuguese');

		const section = page.locator('section.price');

		await ratesShown(page);
		assert.equal(await text(section.locator('.price-finish[aria-pressed="true"]')), 'Reverse holo (1 owned)');
		assert.equal(await text(section.locator('.price-us .price-value')), '≈ About R$ 1,14');
		assert.equal(await text(section.locator('.price-language')), 'Market prices for English cards, not for Portuguese prints.');
		assert.equal(await section.locator('a.price-liga-link').getAttribute('href'), 'https://www.ligapokemon.com.br/?view=cards/search&card=Exeggcute%20(001%2F131)');

		await finish(device, 'portuguese');
	});

	test('several finishes: the switcher moves between their prices', async () => {
		const device = await phone();
		const {page} = device;

		await open(device, 'finishes');

		const section = page.locator('section.price');
		const chips = section.locator('.price-finish');

		await ratesShown(page);
		assert.deepEqual((await chips.allTextContents()).map(plain), [
			'Normal (1 owned)',
			'Reverse holo',
			'Reverse holo, Poké Ball pattern',
			'Reverse holo, Master Ball pattern (1 owned)',
		]);
		assert.equal(await text(section.locator('.price-us .price-original')), 'US$ 0,05, TCGplayer market, 30 Sep');

		await chips.nth(3).click();
		assert.equal(await chips.nth(3).getAttribute('aria-pressed'), 'true');
		assert.equal(await chips.nth(0).getAttribute('aria-pressed'), 'false');
		assert.equal(await text(section.locator('.price-us .price-value')), '≈ About R$ 6,74');
		assert.equal(await text(section.locator('.price-us .price-original')), 'US$ 1,30, TCGplayer market, 30 Sep');
		await chips.nth(3).focus();

		await chips.nth(2).click();
		assert.equal(await text(section.locator('.price-us .price-original')), 'US$ 0,30, TCGplayer market, 30 Sep');
		assert.equal(await section.locator('a.price-liga-link').count(), 1);

		await finish(device, 'finishes');
	});

	test('a Liga price kept from before: one read-only line, Remove, and Undo', async () => {
		const device = await phone();
		const {page} = device;

		await open(device, 'liga');

		const section = page.locator('section.price');

		await ratesShown(page);
		// Two copies hold the same price: one line.
		assert.deepEqual((await section.locator('.price-liga-text').allTextContents()).map(plain), ['Liga, 1 Oct 2026: lowest NM R$ 12,00 · average R$ 15,00 (Reverse holo, Portuguese)']);
		assert.equal(await section.locator('form, input').count(), 0, 'nothing to type into');
		// The automatic prices still lead; the Liga line comes after them.
		assert.ok(await page.evaluate(() => document.querySelector('.price-markets').compareDocumentPosition(document.querySelector('.price-liga')) & Node.DOCUMENT_POSITION_FOLLOWING));

		// Value totals and tiles keep taking it.
		assert.equal(await text(page.locator('#harness-tile')), 'Tile: R$ 15,00');
		assert.equal(await text(page.locator('.price-count-liga')), '2 copies by Liga');

		const remove = section.locator('button.price-remove');

		assert.equal(plain(await remove.getAttribute('aria-label')), 'Remove Liga, 1 Oct 2026: lowest NM R$ 12,00 · average R$ 15,00 (Reverse holo, Portuguese)');
		await remove.click();
		await section.locator('.price-liga').waitFor({state: 'detached'});
		assert.ok((await storedCards(page)).every((entry) => !entry.price_manual), 'removed from both copies');
		assert.equal(await text(page.locator('#toasts .toast')), 'Liga price removed from 2 copies.Undo');
		assert.equal(await page.evaluate(() => document.activeElement.id), 'price-1-title', 'the focus stays in the panel');
		await page.waitForFunction(() => /~/.test(document.querySelector('#harness-tile').textContent));
		assert.equal(await page.locator('.price-count-liga').count(), 0, 'no Liga count with no Liga price');
		assert.equal(await page.locator('.price-basis').count(), 0, 'no Liga basis switch either');

		// Undo puts it back on both, as it was.
		await page.locator('#toasts button:has-text("Undo")').click();
		await section.locator('.price-liga').waitFor();

		const back = (await storedCards(page)).filter((entry) => entry.price_manual);

		assert.equal(back.length, 2);

		for (const entry of back) {
			assert.deepEqual(entry.price_manual, {avg: 15, currency: 'BRL', date: '2026-10-01', finish: 'Reverse holo', language: 'pt', low_nm: 12, source: 'Liga Pokémon'});
		}

		await page.waitForFunction(() => document.querySelector('#harness-tile').textContent.includes('15,00'));
		await finish(device, 'liga');
	});

	test('a Liga price saved before finish and language: the line without them', async () => {
		const device = await phone();
		const {page} = device;

		await open(device, 'legacy');
		await page.locator('.price-liga').waitFor();
		assert.equal(await text(page.locator('.price-liga-text')), 'Liga, 19 Sep 2026: lowest NM R$ 45,90 · average R$ 52,30');

		const line = await page.evaluate(async () => {
			const {copyPriceText} = await import('/pokemon-card-tracker/js/price-view.js');
			const {listCards} = await import('/pokemon-card-tracker/js/collection.js');

			return copyPriceText((await listCards())[0]);
		});

		assert.equal(plain(line), 'Liga, 19 Sep 2026: lowest NM R$ 45,90 · average R$ 52,30', '"Your copies" rows say it the same way');

		await finish(device, 'legacy');
	});

	test('a finish TCGdex does not list: the price of one it does, and whose', async () => {
		const device = await phone();
		const {page} = device;

		await open(device, 'mismatch');
		await page.waitForFunction(() => document.querySelectorAll('.price-eu-value').length === 2);

		const [exeggcute, testmon, nothing] = [0, 1, 2].map((n) => page.locator('section.price').nth(n));

		// A monprice Holo on a card listed as Normal and reverses: Normal's.
		assert.equal(await text(exeggcute.locator('.price-finish[aria-pressed="true"]')), 'Normal');
		assert.equal(await text(exeggcute.locator('.price-us .price-value')), '≈ About R$ 0,26');
		assert.equal(await text(exeggcute.locator('.price-us .price-for')), 'for Normal; your copy is Holo');
		assert.equal(await text(exeggcute.locator('.price-eu .price-for')), 'for Normal; your copy is Holo');

		// A Holo on a card listed only as Normal whose only US price is holo:
		// the holo price; Cardmarket's is the Normal's.
		assert.equal(await text(testmon.locator('.price-us .price-value')), '≈ About R$ 21,37');
		assert.equal(await text(testmon.locator('.price-us .price-original')), 'US$ 4,12, TCGplayer market, 8 Oct');
		assert.equal(await text(testmon.locator('.price-eu .price-for')), 'for Normal; your copy is Holo');
		assert.equal(await text(testmon.locator('.price-eu .price-value')), '≈ About R$ 20,00 →Trend steady, 30-day average about R$ 19,41');

		// No price for any finish: then, and only then, "No price".
		assert.deepEqual((await nothing.locator('.price-value').allTextContents()).map(plain), ['No price', 'No price']);
		assert.equal(await nothing.locator('.price-rate').count(), 0);

		// Tiles and the statistics take the same prices, and say so.
		assert.equal(await text(page.locator('#harness-tile')), 'Tiles: ~R$ 0,26US | ~R$ 21,37US | no price');
		assert.equal(plain(await page.locator('#harness-tile .price-tile').first().getAttribute('aria-label')), 'About R$ 0,26, US market estimate, price for Normal');
		assert.match(await text(page.locator('.price-stats-notes')), /2 copies take the price of another finish of the card, as TCGplayer lists none for theirs\./);
		assert.equal(await text(page.locator('.price-count-estimate')), '2 copies by US estimate (~)');
		assert.equal(await text(page.locator('.price-count-unknown')), '1 copy unknown');

		await finish(device, 'mismatch');
	});

	test('a Korean copy on a Japanese record: no Ver na Liga, and no borrowed price (Q-30)', async () => {
		const device = await phone();
		const {page} = device;

		await open(device, 'korean');

		const section = page.locator('section.price');

		await section.locator('.price-liga-none').waitFor();
		assert.equal(await text(section.locator('.price-liga-none')), 'No Liga link for Korean prints.');
		assert.equal(await section.locator('a.price-liga-link').count(), 0);
		assert.equal(await section.locator('.price-for').count(), 0, 'never another finish\'s price');

		await finish(device, 'korean');
	});

	test('offline: the last saved rates, with their dates', async () => {
		const old = Date.now() - 2 * 24 * 60 * 60 * 1000;
		const device = await phone({rates: 'offline', saved: {brlPerUsd: 5.21, date: '2026-09-28', fetchedAt: old}, savedEur: {brlPerEur: 5.9, date: '2026-09-27', fetchedAt: old}});
		const {page} = device;

		await open(device, 'offline');

		const section = page.locator('section.price');

		await page.waitForFunction(() => /last saved/.test(document.querySelector('.price-rate')?.textContent || ''));
		// Each currency keeps its own saved rate and date.
		assert.equal(await text(section.locator('.price-eu .price-value')), '≈ About R$ 1,65 →Trend steady, 30-day average about R$ 2,07');
		assert.equal(await text(section.locator('.price-us .price-value')), '≈ About R$ 1,56');
		assert.equal(await text(section.locator('.price-rate')), 'US$ 1 = R$ 5,21 (28 Sep) · € 1 = R$ 5,90 (27 Sep), last saved on this phone.');
		assert.equal(await text(page.locator('#harness-tile')), 'Tile: ~R$ 1,56US');
		assert.equal(await text(page.locator('.price-count-estimate')), '1 copy by US estimate (~)');
		assert.ok(device.seen.frankfurter.length >= 1, 'it tried for a fresh rate');

		await finish(device, 'offline');
	});

	test('offline with no rate ever saved: the original amounts only, nothing invented', async () => {
		const device = await phone({rates: 'offline'});
		const {page} = device;

		await open(device, 'norate');

		const section = page.locator('section.price');

		await page.waitForFunction(() => /No exchange rate/.test(document.querySelector('.price-rate')?.textContent || ''));
		assert.equal(await section.locator('.price-us-value, .price-eu-value').count(), 0);

		// The owned Poké Ball chip is scrolled into the row's view.
		const visible = await page.evaluate(() => {
			const row = document.querySelector('.price-finishes').getBoundingClientRect();
			const chip = document.querySelector('.price-finish[aria-pressed="true"]').getBoundingClientRect();

			return chip.left >= row.left && chip.right <= row.right;
		});

		assert.ok(visible, 'the chosen finish is in view');
		assert.equal(await text(section.locator('.price-us .price-value')), 'US$ 0,30');
		assert.equal(await text(section.locator('.price-us .price-original')), 'TCGplayer market, 30 Sep');
		assert.equal(await text(section.locator('.price-eu .price-value')), '€ 0,28 →Trend steady, 30-day average € 0,35');
		assert.equal(await text(section.locator('.price-rate')), 'No exchange rate saved on this phone yet, so no reais.');
		assert.equal(await text(page.locator('#harness-tile')), 'Tile: no price');
		assert.equal(await text(page.locator('.price-stats-none')), 'No prices known for this card yet.');
		assert.equal(await text(page.locator('.price-count-unknown')), '1 copy unknown');
		assert.match(await text(page.locator('.price-stats-notes')), /1 copy has a US price but no exchange rate is saved/);

		await finish(device, 'norate');
	});
});

describe('the two markets', () => {
	test('English card with both markets, then finishes and a card with only Cardmarket', async () => {
		const device = await phone();
		const {page} = device;

		await open(device, 'markets');

		const [charizard, bulbasaur] = [page.locator('section.price').nth(0), page.locator('section.price').nth(1)];

		await page.waitForFunction(() => document.querySelectorAll('.price-eu-value').length === 2 && document.querySelectorAll('.price-us-value').length === 2);

		// Holo Unlimited: the plain trend, 596.13 at 5.8814; 1693.86 over 7 days
		// against 815 over 30 is rising.
		const eu = charizard.locator('.price-eu');

		assert.equal(await text(eu.locator('.price-value')), '≈ About R$ 3.506,08 ↑Trend rising, 30-day average about R$ 4.793,34');
		assert.equal(await eu.locator('.price-trend').getAttribute('data-trend'), 'rising');
		assert.equal(plain(await eu.locator('.price-trend').getAttribute('title')), '30-day average about R$ 4.793,34');
		assert.equal(await eu.locator('.price-trend-shape').getAttribute('aria-hidden'), 'true');
		assert.equal(await eu.locator('.price-shared').count(), 0);

		// Shadowless: Cardmarket's own, shared with the 1st Edition, falling;
		// no US price of its own, so the Unlimited's, labeled.
		await charizard.locator('.price-finish').nth(2).click();
		assert.equal(await text(charizard.locator('.price-us .price-for')), 'for Holo, Unlimited; none listed for Holo, Shadowless');
		assert.match(await text(eu.locator('.price-value')), /^≈ About R\$ 19\.589,24 ↓Trend falling/);
		assert.equal(await eu.locator('.price-for').count(), 0);
		assert.equal(await text(eu.locator('.price-shared')), 'Cardmarket prices this together with Holo, Shadowless, 1st Edition stamp.');

		// 1999-2000 copyright: neither market of its own; the Unlimited's
		// prices stand in, each labeled.
		await charizard.locator('.price-finish').nth(3).click();
		assert.equal(await text(eu.locator('.price-for')), 'for Holo, Unlimited; none listed for Holo, 1999-2000 copyright');
		assert.equal(await charizard.locator('.price-none').count(), 0);

		// The Portuguese league reverse: Cardmarket's -holo fields, and the
		// Normal's US price, labeled, with the note on the language.
		assert.equal(await text(bulbasaur.locator('.price-eu-value')), '≈ About R$ 47,58');
		assert.equal(await text(bulbasaur.locator('.price-eu .price-original')), '€ 8,09, Cardmarket trend, 30 Sep');
		assert.equal(await text(bulbasaur.locator('.price-language')), 'Market prices for English cards, not for Portuguese prints.');

		// Totals never take Cardmarket.
		const tiles = await page.evaluate(async () => {
			const {listCards} = await import('/pokemon-card-tracker/js/collection.js');
			const {tileValue} = await import('/pokemon-card-tracker/js/prices.js');
			const fixture = async (name) => (await fetch(`/pokemon-card-tracker/tests/prices-fixtures/${name}.json`)).json();
			const entries = await listCards();
			const bulbasaurPt = await fixture('pt-me01-001');
			const value = tileValue(entries.filter((entry) => entry.card_id === bulbasaurPt.id), bulbasaurPt, {rates: {brlPerUsd: 5, date: '2026-10-01'}});

			return value && value.kind;
		});

		assert.ok(tiles === null || tiles === 'estimate', `never a Cardmarket value (${tiles})`);

		await charizard.locator('.price-finish').nth(0).click();
		await finish(device, 'markets');
	});

	test('dark mode: the trend and the rows stay readable', async () => {
		const device = await phone({colorScheme: 'dark'});
		const {page} = device;

		await open(device, 'markets');
		await page.waitForFunction(() => document.querySelectorAll('.price-eu-value').length === 2);

		for (const selector of ['.price-source', '.price-eu-value', '.price-trend', '.price-original', '.price-rate', '.price-language']) {
			const ratio = await contrast(page.locator(selector).last());

			assert.ok(ratio >= 4.5, `${selector} contrast ${ratio.toFixed(2)} is at least 4.5`);
		}

		await finish(device, 'markets-dark');
	});
});

describe('statistics bar', () => {
	test('total, average, highest, lowest, and the honest counts', async () => {
		const device = await phone({saved: {brlPerUsd: 5.1877, date: '2026-10-01', fetchedAt: Date.now()}});
		const {page} = device;

		await open(device, 'stats');

		const bar = page.locator('section.price-stats');

		assert.equal(await bar.getAttribute('aria-label'), 'Value of this binder');
		// 52.30 Liga + 1.30 and 944.53 US$ at 5.1877, over three priced copies.
		assert.equal(await text(bar.locator('.price-stats-total')), '~R$ 4.958,98');
		assert.equal(await text(bar.locator('.price-stats-average')), '~R$ 1.652,99');
		assert.equal(await text(bar.locator('.price-stats-highest')), 'Highest ~R$ 4.899,94, Charizard');
		assert.equal(await text(bar.locator('.price-stats-lowest')), 'Lowest ~R$ 6,74, Exeggcute');
		assert.equal(await text(bar.locator('.price-count-liga')), '1 copy by Liga');
		assert.equal(await text(bar.locator('.price-count-estimate')), '2 copies by US estimate (~)');
		assert.equal(await text(bar.locator('.price-count-unknown')), '2 copies unknown');
		assert.equal(await text(bar.locator('.price-stats-notes')), 'R$ 4.906,68 of the total is estimated from the US market at the rate of 2026-10-01. Unknown prices are left out of the total and the average, not counted as zero.');

		await page.screenshot({fullPage: true, path: `${SHOTS}/prices-stats.png`});

		// The lowest NM basis.
		await bar.locator('text=Liga lowest NM').click();
		assert.equal(await text(page.locator('.price-stats-total')), '~R$ 4.952,58');
		assert.ok(await page.locator('input[value="low_nm"]').isChecked());
		assert.equal(device.seen.frankfurter.length, 0, 'a rate saved today is not asked for again');

		await finish(device, 'stats-low-nm');
	});

	test('dark mode', async () => {
		const device = await phone({colorScheme: 'dark'});

		await open(device, 'liga');
		await device.page.waitForFunction(() => document.querySelectorAll('.price-us-value, .price-eu-value').length >= 2);

		const ratio = await contrast(device.page.locator('.price-liga-text'));

		assert.ok(ratio >= 4.5, `the Liga line's contrast ${ratio.toFixed(2)} is at least 4.5`);
		await finish(device, 'liga-dark');
	});
});
