// Browser tests for value over time (js/value-history.js and
// js/value-history-view.js, Eric, 2026-11-18): the collection's daily value
// in the Value sheet on My Cards, and a card's Last 30 days line and weekly
// prices on its price panel. Headless Chromium at 360 x 740 against
// tests/pages-server.mjs, signed out.
//
// Every outside service is faked: TCGdex answers with the records saved in
// tests/prices-fixtures, frankfurter.dev with tests/fake-rates.mjs, and
// PokeAPI with tests/fake-pokeapi.mjs. Supabase and ligapokemon.com.br are
// never contacted (any attempt is counted and fails the test). The past
// values seeded into the phone are invented.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/value-history-browser.test.mjs
// Screenshots: /tmp/value-history-*.png, or under SHOTS when set.

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {extractPrices, formatBrl, roundCents, shortDate} from '../js/prices.js';
import {fakePokeApi} from './fake-pokeapi.mjs';
import {FAKE_EURO_RATE, FAKE_RATE, fakeRates} from './fake-rates.mjs';
import {startPagesServer} from './pages-server.mjs';
import {untilInPage} from './poll.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const SHOTS = process.env.SHOTS || '/tmp';
const VIEWPORT = {height: 740, width: 360};

const fixture = async (name) => JSON.parse(await readFile(new URL(`./prices-fixtures/${name}.json`, import.meta.url), 'utf8'));

let server;
let browser;
let charizard;

before(async () => {
	server = await startPagesServer();
	browser = await chromium.launch();
	charizard = await fixture('en-base1-4');
});

after(async () => {
	await browser.close();
	await server.close();
});

const url = (path = '') => `${server.origin}${BASE}${path}`;

// Intl writes a no-break space after the currency symbol.
const plain = (text) => String(text).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

const variant = (card, label) => extractPrices(card).find((finish) => finish.label === label).variantId;

// The phone's calendar day n days from today, as js/value-history.js dayKey.
function localDay(offset = 0) {
	const date = new Date();

	date.setDate(date.getDate() + offset);

	const pad = (n) => String(n).padStart(2, '0');

	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// The copy's US estimate, as listStats sums it: TCGplayer market times the
// fake dollar rate.
const unlimitedUsd = () => extractPrices(charizard).find((finish) => finish.label === 'Holo, Unlimited').tcgplayer.marketPrice;

async function phone({colorScheme = 'light', records = {}} = {}) {
	const context = await browser.newContext({colorScheme, serviceWorkers: 'block', viewport: VIEWPORT});
	const seen = {liga: [], supabase: []};
	const answers = {[`en/cards/${charizard.id}`]: charizard, ...records};

	await fakeRates(context);
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await context.route(/ligapokemon\.com\.br/, (route) => {
		seen.liga.push(route.request().url());

		return route.abort('blockedbyclient');
	});
	await context.route('https://*.supabase.co/**', (route) => {
		seen.supabase.push(route.request().url());

		return route.abort('blockedbyclient');
	});
	await context.route('https://api.tcgdex.net/**', (route) => {
		const key = new URL(route.request().url()).pathname.replace(/^\/v2\//, '');
		const record = answers[key];

		return route.fulfill(record
			? {body: JSON.stringify(record), contentType: 'application/json', status: 200}
			: {body: '{}', contentType: 'application/json', status: 404});
	});
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));
	await fakePokeApi(context);

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err));

	return {context, errors, page, seen};
}

const addCard = (page, fields) => page.evaluate(async (card) => (await import('/pokemon-card-tracker/js/collection.js')).addCard(card), fields);

const history = (page) => page.evaluate(async () => (await import('/pokemon-card-tracker/js/value-history.js')).readValueHistory('local'));

// Every element's text made factor times larger, as a phone's larger text
// setting does (tests/copies-browser.test.mjs): computed sizes read first,
// so none compounds.
const scaleText = (page, factor) => page.evaluate((by) => {
	const read = [document.documentElement, ...document.querySelectorAll('body, body *')].map((el) => {
		const style = getComputedStyle(el);

		return [el, parseFloat(style.fontSize), style.lineHeight.endsWith('px') ? parseFloat(style.lineHeight) : null];
	});

	for (const [el, size, line] of read) {
		el.style.setProperty('font-size', `${size * by}px`, 'important');

		if (line !== null) {
			el.style.setProperty('line-height', `${line * by}px`, 'important');
		}
	}
}, factor);

async function noSideways(page, where) {
	const width = await page.evaluate(() => document.documentElement.scrollWidth);

	assert.ok(width <= VIEWPORT.width, `no sideways scroll on ${where} (${width})`);
}

async function done(device) {
	assert.deepEqual(device.errors.map(String), [], 'no page errors');
	assert.deepEqual(device.seen.liga, [], 'Liga Pokémon is never requested');
	assert.deepEqual(device.seen.supabase, [], 'Supabase is never contacted');
	await device.context.close();
}

async function openCards(page) {
	await page.goto(url('cards'));
	await page.waitForSelector('.tile:has-text("Charizard") .tile-price');
}

async function openSheet(page) {
	await page.click('#cards-value');
	await page.waitForSelector('.value-sheet[open] .vh-collection');
	await page.waitForFunction(() => !document.querySelector('.value-sheet .vh-reading'));
	assert.doesNotMatch(await page.locator('.value-sheet').textContent(), /\bnull\b|\bundefined\b|NaN/, 'no null, undefined, or NaN printed');
}

describe('value over time', () => {
	test('My Cards keeps one value a day and the sheet says the chart fills in', async () => {
		const device = await phone();
		const {page} = device;

		await page.goto(url('cards'));
		await page.waitForSelector('#cards-empty');
		await addCard(page, {card_id: charizard.id, catalog: 'international', language: 'en', language_source: 'manual', variant_id: variant(charizard, 'Holo, Unlimited')});
		await openCards(page);

		// The background pass ends and keeps today's value.
		const expected = roundCents(unlimitedUsd() * FAKE_RATE.rate);
		const kept = await untilInPage(page, 'today\'s snapshot', async () => {
			const list = await (await import('/pokemon-card-tracker/js/value-history.js')).readValueHistory('local');

			return list.length ? list : null;
		});

		assert.deepEqual(kept, [{brl: expected, copies: 1, date: localDay(), priced: 1}]);

		await openSheet(page);
		assert.equal(await page.locator('.value-sheet .vh-collection h3').textContent(), 'Over time');
		assert.equal(await page.locator('.value-sheet .vh-svg').count(), 0, 'no chart from one day');
		assert.equal(plain(await page.locator('.value-sheet .vh-today').textContent()), `${shortDate(localDay())}: ${plain(formatBrl(expected))} for 1 priced copy.`);
		assert.match(await page.locator('.value-sheet .vh-empty').textContent(), /^The chart fills in as days pass\./);
		await noSideways(page, 'the Value sheet');
		await page.screenshot({path: `${SHOTS}/value-history-first-day.png`});
		await page.keyboard.press('Escape');
		await page.waitForSelector('.value-sheet', {state: 'detached'});

		// Opening My Cards again the same day keeps one snapshot, not two.
		await openCards(page);
		await openSheet(page);
		assert.equal((await history(page)).length, 1);
		await done(device);
	});

	test('with earlier days, the sheet draws the line with the change in reais and percent', async () => {
		for (const colorScheme of ['light', 'dark']) {
			const device = await phone({colorScheme});
			const {page} = device;

			await page.goto(url('cards'));
			await page.waitForSelector('#cards-empty');
			await addCard(page, {card_id: charizard.id, catalog: 'international', language: 'en', language_source: 'manual', variant_id: variant(charizard, 'Holo, Unlimited')});

			// Invented values from earlier days, as a phone would have kept them.
			const past = [
				{brl: 4000, copies: 1, date: localDay(-30), priced: 1},
				{brl: 4321.5, copies: 1, date: localDay(-12), priced: 1},
				{brl: 3900, copies: 1, date: localDay(-3), priced: 1},
			];

			await page.evaluate(async (list) => {
				const {recordValue} = await import('/pokemon-card-tracker/js/value-history.js');

				for (const item of list) {
					await recordValue('local', item);
				}
			}, past);

			await openCards(page);
			await untilInPage(page, 'today\'s snapshot', async (today) => (await (await import('/pokemon-card-tracker/js/value-history.js')).readValueHistory('local')).some((item) => item.date === today), {arg: localDay()});
			await openSheet(page);

			const latest = roundCents(unlimitedUsd() * FAKE_RATE.rate);
			const change = roundCents(latest - 4000);
			const percent = Math.round((latest / 4000 - 1) * 100);
			const svg = page.locator('.value-sheet .vh-svg');

			assert.equal(await svg.count(), 1, 'one chart');
			assert.equal(await svg.getAttribute('role'), 'img');
			assert.equal(plain(await page.locator('.value-sheet .vh-collection-change').textContent()), `↑ Up ${plain(formatBrl(change))} (${percent}%) since ${shortDate(localDay(-30))}`);
			assert.equal(await page.locator('.value-sheet .vh-collection-change').getAttribute('data-direction'), 'up');
			assert.equal(await page.locator('.value-sheet .vh-change-shape').getAttribute('aria-hidden'), 'true', 'the arrow is not read out');

			const label = plain(await svg.getAttribute('aria-label'));

			assert.match(label, /^Line chart of your collection's value, 4 readings from /);
			assert.ok(label.includes(`${plain(formatBrl(4000))} to ${plain(formatBrl(latest))}, up ${plain(formatBrl(change))} (${percent}%)`), label);
			assert.ok(label.includes(`lowest ${plain(formatBrl(3900))}`), label);
			assert.equal(plain(await page.locator('.value-sheet .vh-first').textContent()), `${shortDate(localDay(-30))}${plain(formatBrl(4000))}`);
			assert.equal(plain(await page.locator('.value-sheet .vh-latest').textContent()), `${shortDate(localDay())}${plain(formatBrl(latest))}`);
			assert.equal(await page.locator('.value-sheet .vh-coverage').count(), 0, 'the same copies throughout');
			assert.match(await page.locator('.value-sheet .vh-note').textContent(), /^One value a day/);

			// Drawn in the theme's link color, 2 px, as a line rather than a fill.
			const line = await page.locator('.value-sheet .vh-line').evaluate((path) => {
				const style = getComputedStyle(path);

				return {fill: style.fill, width: style.strokeWidth};
			});

			assert.equal(line.fill, 'none');

			const dots = await page.locator('.value-sheet .vh-dot').evaluateAll((paths) => paths.map((path) => Number(path.getAttribute('d').split(' ')[0].slice(1))));

			assert.ok(dots.every((at) => at > 0 && at < 300), `the end dots sit inside the drawing (${dots})`);
			assert.equal(line.width, '2px');
			await noSideways(page, `the Value sheet, ${colorScheme}`);
			await page.locator('.value-sheet .vh-collection').scrollIntoViewIfNeeded();
			await page.screenshot({path: `${SHOTS}/value-history-sheet-${colorScheme}.png`});

			if (colorScheme === 'light') {
				// Larger system text: the numbers wrap, nothing runs off.
				await scaleText(page, 1.3);
				await noSideways(page, 'the Value sheet with larger text');

				const fits = await page.locator('.value-sheet .vh-collection').evaluate((part) => [...part.querySelectorAll('*')].every((el) => el.getBoundingClientRect().right <= part.getBoundingClientRect().right + 1));

				assert.ok(fits, 'every line stays inside the sheet with larger text');
				await page.screenshot({path: `${SHOTS}/value-history-sheet-text-1.3.png`});
			}

			await done(device);
		}
	});

	test('copies added since the first day are said beside the line', async () => {
		const device = await phone();
		const {page} = device;

		await page.goto(url('cards'));
		await page.waitForSelector('#cards-empty');
		await addCard(page, {card_id: charizard.id, catalog: 'international', language: 'en', language_source: 'manual', variant_id: variant(charizard, 'Holo, Unlimited')});
		await addCard(page, {card_id: 'zz-404', catalog: 'international', language: 'en', language_source: 'manual'});
		await page.evaluate(async (item) => (await import('/pokemon-card-tracker/js/value-history.js')).recordValue('local', item), {brl: 10, copies: 1, date: localDay(-7), priced: 1});
		await openCards(page);
		await untilInPage(page, 'today\'s snapshot', async () => (await (await import('/pokemon-card-tracker/js/value-history.js')).readValueHistory('local')).length === 2);
		await openSheet(page);
		assert.equal(plain(await page.locator('.value-sheet .vh-coverage').textContent()), `1 of 2 copies priced now, 1 of 1 copy on ${shortDate(localDay(-7))}, so cards added or newly priced move the line too.`);
		await done(device);
	});

	test('the Trade spares keep no value and show no line', async () => {
		const device = await phone();
		const {page} = device;

		await page.goto(url('cards'));
		await page.waitForSelector('#cards-empty');

		for (let i = 0; i < 2; i++) {
			await addCard(page, {card_id: charizard.id, catalog: 'international', language: 'en', language_source: 'manual', variant_id: variant(charizard, 'Holo, Unlimited')});
		}

		await page.goto(url('trade'));
		await page.waitForSelector('.tile:has-text("Charizard") .tile-price');
		await page.click('#cards-value');
		await page.waitForSelector('.value-sheet[open] .price-stats');
		assert.equal(await page.locator('.value-sheet .vh-collection').count(), 0, 'no Over time on the spares');
		assert.deepEqual(await history(page), [], 'nothing kept from the spares');
		await done(device);
	});

	test('the card page shows the Last 30 days averages and, from two weeks, its saved prices', async () => {
		const device = await phone();
		const {page} = device;

		await page.goto(url('cards'));
		await page.waitForSelector('#cards-empty');
		await addCard(page, {card_id: charizard.id, catalog: 'international', language: 'en', language_source: 'manual', variant_id: variant(charizard, 'Holo, Unlimited')});
		await page.goto(url(`cards/en/${charizard.id}`));
		await page.waitForSelector('#card-price .price-eu-value');

		// Cardmarket's 30, 7, and 1 day averages, in reais at the euro rate.
		const cm = extractPrices(charizard).find((finish) => finish.label === 'Holo, Unlimited').cardmarket;
		const reais = (eur) => plain(formatBrl(eur * FAKE_EURO_RATE.rate));

		assert.equal(
			plain(await page.locator('#card-price .price-averages').textContent()),
			`Last 30 days, average sale: ≈ About ${reais(cm.avg30)} over 30 days · ≈ About ${reais(cm.avg7)} over 7 days · ≈ About ${reais(cm.avg1)} over 1 day`
		);
		assert.equal(await page.locator('#card-price .price-averages [aria-hidden="true"]').first().textContent(), '≈ ', 'the sign is not read out; "About" is');

		// The record the page fetched left one weekly point: no chart yet.
		const first = await untilInPage(page, 'the card\'s first point', async (id) => {
			const points = await (await import('/pokemon-card-tracker/js/value-history.js')).readCardHistory(id);

			return points.length ? points : null;
		}, {arg: charizard.id});

		assert.equal(first.length, 1);
		assert.equal(first[0].date, '2026-09-30', 'dated by TCGdex, not by the phone');
		assert.deepEqual(first[0].prices['Holo, Unlimited'], [unlimitedUsd(), cm.trend]);
		assert.equal(await page.locator('#card-price .vh-card').count(), 0);

		// The record as TCGdex gave it the week before, priced lower.
		const earlier = structuredClone(charizard);

		for (const item of earlier.variants_detailed) {
			const pricing = item.pricing || {};

			if (pricing.tcgplayer) {
				pricing.tcgplayer.updated = '2026-09-22T20:00:00.000Z';

				if (pricing.tcgplayer.holofoil || pricing.tcgplayer['unlimited-holofoil']) {
					(pricing.tcgplayer['unlimited-holofoil'] || pricing.tcgplayer.holofoil).marketPrice = 900;
				}
			}

			if (pricing.cardmarket) {
				pricing.cardmarket.updated = '2026-09-22T20:00:00.000Z';
			}
		}

		await page.evaluate(async ([id, record]) => (await import('/pokemon-card-tracker/js/value-history.js')).recordCardPrices(id, record), [charizard.id, earlier]);
		await page.reload();
		await page.waitForSelector('#card-price .vh-card .vh-svg');
		assert.doesNotMatch(await page.locator('#card-price').textContent(), /\bnull\b|\bundefined\b|NaN/, 'no null, undefined, or NaN printed');

		const before = roundCents(900 * FAKE_RATE.rate);
		const now = roundCents(unlimitedUsd() * FAKE_RATE.rate);
		const percent = Math.round((now / before - 1) * 100);

		assert.equal(await page.locator('#card-price .vh-card-title').textContent(), 'Saved on this phone');
		assert.equal(plain(await page.locator('#card-price .vh-card-what').textContent()), 'TCGplayer market for Holo, Unlimited, one price a week, in reais at each week\'s rate.');
		assert.equal(plain(await page.locator('#card-price .vh-card-change').textContent()), `↑ Up ${plain(formatBrl(now - before))} (${percent}%) since ${shortDate('2026-09-22')}`);
		assert.match(plain(await page.locator('#card-price .vh-svg').getAttribute('aria-label')), /^Line chart of the TCGplayer market price for Holo, Unlimited, 2 readings from 22 Sep 2026 to 30 Sep 2026:/);
		await noSideways(page, 'card detail');
		await page.locator('#card-price .vh-card').scrollIntoViewIfNeeded();
		await page.screenshot({path: `${SHOTS}/value-history-card.png`});

		// Shadowless has no TCGplayer price, so its row shows Unlimited's and
		// says so; the line follows the row.
		await page.click('#card-price .price-finish:has-text("Holo, Shadowless")');
		await page.waitForSelector('#card-price .price-us .price-for');
		assert.match(plain(await page.locator('#card-price .price-us .price-for').textContent()), /^for Holo, Unlimited/);
		assert.match(plain(await page.locator('#card-price .vh-card-what').textContent()), /^TCGplayer market for Holo, Unlimited,/);
		await done(device);
	});
});
