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
const RATE = [{base: 'USD', date: '2026-10-01', quote: 'BRL', rate: 5.1877}];

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
// saved: a rate already in localStorage.
async function phone({colorScheme = 'light', rates = 'online', saved = null} = {}) {
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
				? route.fulfill({body: JSON.stringify(RATE), contentType: 'application/json', headers: {'Access-Control-Allow-Origin': '*'}, status: 200})
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

const storedCards = (page) => page.evaluate(async () => (await import('/pokemon-card-tracker/js/collection.js')).listCards());

describe('price section', () => {
	test('English card: the US reference converted, with its date and no language note', async () => {
		const device = await phone();
		const {page} = device;

		await open(device, 'english');

		const section = page.locator('section.price');

		await page.waitForFunction(() => /~/.test(document.querySelector('.price-us-value')?.textContent || ''));
		assert.equal(await text(section.locator('.price-market').first()), 'Brazil (Liga Pokémon)');
		assert.equal(await text(section.locator('.price-us .price-market')), 'US market reference (TCGplayer)');
		assert.equal(await text(section.locator('.price-us-value')), '~About R$ 4.899,94 estimate');
		assert.equal(await text(section.locator('.price-us-usd')), 'US$ 944,53 market price, updated 2026-09-30');
		assert.equal(await text(section.locator('.price-rate')), 'At R$ 5,19 per US$ 1, rate of 2026-10-01.');
		assert.equal(await section.locator('.price-language').count(), 0);
		// No Cardmarket price anywhere.
		assert.doesNotMatch(await section.textContent(), /Cardmarket|€|EUR/);

		// Ver na Liga is the main action, with Liga's own search for the card.
		const liga = section.locator('a.price-liga-link');

		assert.equal(await liga.getAttribute('href'), 'https://www.ligapokemon.com.br/?view=cards/search&card=Charizard%20(4%2F102)');
		assert.equal(await liga.getAttribute('target'), '_blank');
		assert.match(await liga.getAttribute('class'), /primary/);

		// No Liga price yet, so the two fields are open and ready.
		assert.equal(await text(section.locator('.price-none').first()), 'No Liga price saved for this finish yet.');
		assert.equal(await section.locator('input.price-amount').count(), 2);
		assert.equal(await section.locator('#price-1-low_nm').getAttribute('inputmode'), 'decimal');

		// Four printings, the owned Unlimited chosen; the others have no US price.
		const chips = section.locator('.price-finish');

		assert.equal(await chips.count(), 4);
		assert.equal(await text(section.locator('.price-finish[aria-pressed="true"]')), 'Holo, Unlimited (1 owned)');
		await chips.nth(1).click();
		assert.equal(await text(section.locator('.price-us .price-none')), 'No US market price for this finish.');
		assert.equal(device.seen.frankfurter.length, 1);
		assert.match(device.seen.frankfurter[0], /\/v2\/rates\?base=USD&quotes=BRL$/);

		await finish(device, 'english');
	});

	test('Portuguese copy: notes that the US price is not for that printing', async () => {
		const device = await phone();
		const {page} = device;

		await open(device, 'portuguese');

		const section = page.locator('section.price');

		await page.waitForFunction(() => /~/.test(document.querySelector('.price-us-value')?.textContent || ''));
		assert.equal(await text(section.locator('.price-finish[aria-pressed="true"]')), 'Reverse holo (1 owned)');
		assert.equal(await text(section.locator('.price-us-value')), '~About R$ 1,14 estimate');
		assert.equal(await text(section.locator('.price-language')), 'This is the US price for English cards, not for this Portuguese printing.');
		assert.equal(await section.locator('a.price-liga-link').getAttribute('href'), 'https://www.ligapokemon.com.br/?view=cards/search&card=Exeggcute%20(001%2F131)');

		await finish(device, 'portuguese');
	});

	test('several finishes: the switcher moves between their prices', async () => {
		const device = await phone();
		const {page} = device;

		await open(device, 'finishes');

		const section = page.locator('section.price');
		const chips = section.locator('.price-finish');

		await page.waitForFunction(() => /~/.test(document.querySelector('.price-us-value')?.textContent || ''));
		assert.deepEqual((await chips.allTextContents()).map(plain), [
			'Normal (1 owned)',
			'Reverse holo',
			'Reverse holo, Poké Ball pattern',
			'Reverse holo, Master Ball pattern (1 owned)',
		]);
		assert.equal(await text(section.locator('.price-us-usd')), 'US$ 0,05 market price, updated 2026-09-30');

		await chips.nth(3).click();
		assert.equal(await chips.nth(3).getAttribute('aria-pressed'), 'true');
		assert.equal(await chips.nth(0).getAttribute('aria-pressed'), 'false');
		assert.equal(await text(section.locator('.price-us-value')), '~About R$ 6,74 estimate');
		assert.equal(await text(section.locator('.price-us-usd')), 'US$ 1,30 market price, updated 2026-09-30');

		await chips.nth(2).click();
		assert.equal(await text(section.locator('.price-us-usd')), 'US$ 0,30 market price, updated 2026-09-30');
		// Not owned: no copy to save a Liga price on, but Ver na Liga stays.
		assert.equal(await text(section.locator('.price-none').first()), 'You have no copy of this finish to save a Liga price on.');
		assert.equal(await section.locator('a.price-liga-link').count(), 1);

		await finish(device, 'finishes');
	});

	test('manual Liga price: typed with a comma, one tap saves both copies, shown first', async () => {
		const device = await phone();
		const {page} = device;

		await open(device, 'manual');

		const section = page.locator('section.price');

		await page.waitForFunction(() => /~/.test(document.querySelector('#harness-tile')?.textContent || ''));
		assert.equal(await text(page.locator('#harness-tile')), 'Tile: ~R$ 1,14US');

		// A bad amount is refused and nothing is saved.
		await page.fill('#price-1-low_nm', 'abc');
		await section.locator('button[type="submit"]').click();
		assert.equal(await text(section.locator('.price-form-status')), 'Lowest NM price must be an amount in reais, such as 45,90.');
		assert.equal(await section.locator('#price-1-low_nm').getAttribute('aria-invalid'), 'true');
		assert.ok((await storedCards(page)).every((entry) => !entry.price_manual));

		await page.fill('#price-1-low_nm', '45,90');
		await page.fill('#price-1-avg', '52,3');
		assert.equal(await text(section.locator('button[type="submit"]')), 'Save to 2 copies');
		await section.locator('button[type="submit"]').click();
		await section.locator('.price-liga-values').waitFor();

		const today = localToday();

		assert.deepEqual((await section.locator('.price-liga-values > div').allTextContents()).map(plain), ['Lowest NM priceR$ 45,90', 'Average priceR$ 52,30']);
		assert.equal(await text(section.locator('.price-liga-date')), `Liga Pokémon · ${today} · today`);
		assert.equal(await section.locator('form.price-form').count(), 0);

		const stored = await storedCards(page);

		assert.equal(stored.length, 2);

		for (const entry of stored) {
			assert.deepEqual(entry.price_manual, {avg: 52.3, currency: 'BRL', date: today, low_nm: 45.9, source: 'Liga Pokémon'});
		}

		// The Liga price wins over the US estimate on the tile and in the stats.
		await page.waitForFunction(() => !/~/.test(document.querySelector('#harness-tile').textContent));
		assert.equal(await text(page.locator('#harness-tile')), 'Tile: R$ 52,30');
		assert.equal(await text(page.locator('.price-stats-total')), 'R$ 104,60');
		assert.equal(await text(page.locator('.price-count-liga')), '2 cards by Liga');
		assert.equal(await text(page.locator('.price-count-estimate')), '0 cards by US estimate (~)');

		await page.screenshot({fullPage: true, path: `${SHOTS}/prices-manual-saved.png`});

		// Update opens the fields with the saved amounts; source and date are
		// behind the disclosure with their defaults.
		await section.locator('button.price-edit').click();
		assert.equal(await page.inputValue('#price-1-low_nm'), '45,90');
		assert.equal(await page.inputValue('#price-1-source'), 'Liga Pokémon');
		assert.equal(await page.inputValue('#price-1-date'), today);
		await page.fill('#price-1-avg', '');
		await section.locator('button[type="submit"]').click();
		await page.waitForFunction(() => document.querySelectorAll('.price-liga-values > div').length === 1);
		assert.equal((await storedCards(page))[0].price_manual.avg, null);

		await finish(device, 'manual');
	});

	test('offline: the last saved rate, with its date', async () => {
		const device = await phone({rates: 'offline', saved: {brlPerUsd: 5.21, date: '2026-09-28', fetchedAt: Date.now() - 2 * 24 * 60 * 60 * 1000}});
		const {page} = device;

		await open(device, 'offline');

		const section = page.locator('section.price');

		await page.waitForFunction(() => /last rate saved/.test(document.querySelector('.price-rate')?.textContent || ''));
		assert.equal(await text(section.locator('.price-us-value')), '~About R$ 1,56 estimate');
		assert.equal(await text(section.locator('.price-rate')), 'At R$ 5,21 per US$ 1, rate of 2026-09-28, the last rate saved on this phone.');
		assert.equal(await text(page.locator('#harness-tile')), 'Tile: ~R$ 1,56US');
		assert.equal(await text(page.locator('.price-count-estimate')), '1 card by US estimate (~)');
		assert.ok(device.seen.frankfurter.length >= 1, 'it tried for a fresh rate');

		await finish(device, 'offline');
	});

	test('offline with no rate ever saved: US dollars only, nothing invented', async () => {
		const device = await phone({rates: 'offline'});
		const {page} = device;

		await open(device, 'norate');

		const section = page.locator('section.price');

		await page.waitForFunction(() => document.querySelector('.price-rate'));
		assert.equal(await section.locator('.price-us-value').count(), 0);

		// The owned Poké Ball chip is scrolled into the row's view.
		const visible = await page.evaluate(() => {
			const row = document.querySelector('.price-finishes').getBoundingClientRect();
			const chip = document.querySelector('.price-finish[aria-pressed="true"]').getBoundingClientRect();

			return chip.left >= row.left && chip.right <= row.right;
		});

		assert.ok(visible, 'the chosen finish is in view');
		assert.equal(await text(section.locator('.price-us-usd')), 'US$ 0,30 market price, updated 2026-09-30');
		assert.equal(await text(section.locator('.price-rate')), 'No exchange rate is saved on this phone yet, so the reais value is not shown.');
		assert.equal(await text(page.locator('#harness-tile')), 'Tile: no price');
		assert.equal(await text(page.locator('.price-stats-none')), 'No prices known for this card yet.');
		assert.equal(await text(page.locator('.price-count-unknown')), '1 card unknown');
		assert.match(await text(page.locator('.price-stats-notes')), /1 card has a US price but no exchange rate is saved/);

		await finish(device, 'norate');
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
		assert.equal(await text(bar.locator('.price-count-liga')), '1 card by Liga');
		assert.equal(await text(bar.locator('.price-count-estimate')), '2 cards by US estimate (~)');
		assert.equal(await text(bar.locator('.price-count-unknown')), '2 cards unknown');
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

		await open(device, 'manual');
		await device.page.waitForFunction(() => /~/.test(document.querySelector('#harness-tile')?.textContent || ''));
		await finish(device, 'manual-dark');
	});
});
