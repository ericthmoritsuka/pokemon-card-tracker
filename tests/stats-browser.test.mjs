// Browser tests for the Stats screen (js/stats-view.js, Eric, 2026-11-19):
// opened from Stats in the My Cards heading, its totals, bars, most valuable
// cards, copies with no price, copies added per month, and your lists'
// progress as the Lists tab last counted it, at 360 px wide in light and
// dark. Headless Chromium against tests/pages-server.mjs, signed
// out.
//
// Every outside service is faked: TCGdex answers with the records saved in
// tests/prices-fixtures, frankfurter.dev with tests/fake-rates.mjs, and
// PokeAPI with tests/fake-pokeapi.mjs. Supabase and ligapokemon.com.br are
// never contacted (any attempt is counted and fails the test). The copies
// and the Liga price are invented.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/stats-browser.test.mjs
// Screenshots: /tmp/stats-*.png, or under SHOTS when set.

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {extractPrices, formatBrl, formatBrlCompact, roundCents} from '../js/prices.js';
import {fakePokeApi} from './fake-pokeapi.mjs';
import {FAKE_RATE, fakeRates} from './fake-rates.mjs';
import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const SHOTS = process.env.SHOTS || '/tmp';
const VIEWPORT = {height: 740, width: 360};
const HAND_ID = `hand_${'a1'.repeat(16)}`;

const fixture = async (name) => JSON.parse(await readFile(new URL(`./prices-fixtures/${name}.json`, import.meta.url), 'utf8'));

let server;
let browser;
let charizard;
let exeggcute;

before(async () => {
	server = await startPagesServer();
	browser = await chromium.launch();
	charizard = await fixture('en-base1-4');
	exeggcute = await fixture('en-sv08.5-001');
});

after(async () => {
	await browser.close();
	await server.close();
});

const url = (path = '') => `${server.origin}${BASE}${path}`;

// Intl writes a no-break space after the currency symbol.
const plain = (text) => String(text).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

const variant = (card, label) => extractPrices(card).find((finish) => finish.label === label).variantId;

// "2026-11" for the phone's month n months from now, and its name on screen.
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthAgo(n) {
	const now = new Date();
	const date = new Date(now.getFullYear(), now.getMonth() - n, 15, 12);

	return {iso: date.toISOString(), name: `${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}`};
}

// TCGdex's bulk card list, id and dexId (js/checklists.js
// fetchInternationalDexMap), answered only on a phone that asks for it: the
// other GraphQL queries keep failing, as in the tests above.
const DEX_QUERY = '{ cards { id dexId } }';

async function phone({colorScheme = 'light', dexMap = null} = {}) {
	const context = await browser.newContext({colorScheme, serviceWorkers: 'block', viewport: VIEWPORT});
	const seen = {liga: [], supabase: [], tcgdex: []};
	const answers = {[`en/cards/${charizard.id}`]: charizard, [`en/cards/${exeggcute.id}`]: exeggcute};

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

		seen.tcgdex.push(key);

		if (dexMap && key === 'graphql' && JSON.parse(route.request().postData() || '{}').query === DEX_QUERY) {
			return route.fulfill({body: JSON.stringify({data: {cards: dexMap}}), contentType: 'application/json', status: 200});
		}

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

async function done(device) {
	assert.deepEqual(device.errors.map(String), [], 'no page errors');
	assert.deepEqual(device.seen.liga, [], 'Liga Pokémon is never requested');
	assert.deepEqual(device.seen.supabase, [], 'Supabase is never contacted');
	await device.context.close();
}

async function noSideways(page, where) {
	const width = await page.evaluate(() => document.documentElement.scrollWidth);

	assert.ok(width <= VIEWPORT.width, `no sideways scroll on ${where} (${width})`);
}

// Every element of the screen inside the 360 px viewport.
async function fitsWidth(page, where) {
	const over = await page.evaluate((width) => [...document.querySelectorAll('#view *')]
		.filter((el) => el.getClientRects().length && el.getBoundingClientRect().right > width + 0.5)
		.map((el) => `${el.tagName.toLowerCase()}.${el.className}`), VIEWPORT.width);

	assert.deepEqual(over, [], `everything fits at 360 px on ${where}`);
}

// A bar list as [label, value text] pairs.
const barRows = (page, id) => page.locator(`#${id} .stats-bar-row`).evaluateAll((rows) => rows.map((row) => [
	row.querySelector('.stats-bar-label').textContent,
	row.querySelector('.stats-bar-value').textContent,
]));

// Four copies: two Charizard (English and Portuguese), an Exeggcute two
// months back, and a hand-made card with a Liga price.
async function seed(page) {
	const old = monthAgo(2);

	await addCard(page, {card_id: charizard.id, catalog: 'international', condition: 'Near Mint', language: 'en', language_source: 'manual', variant_id: variant(charizard, 'Holo, Unlimited')});
	await addCard(page, {card_id: charizard.id, catalog: 'international', language: 'pt', language_source: 'manual', variant_id: variant(charizard, 'Holo, Unlimited')});
	await addCard(page, {card_id: exeggcute.id, catalog: 'international', condition: 'Lightly Played', created_at: old.iso, language: 'en', language_source: 'manual', variant_id: variant(exeggcute, 'Normal')});
	await addCard(page, {card_id: HAND_ID, catalog: 'custom', finish_raw: 'HOLOFOIL', language: 'pt', language_source: 'manual', name_local: 'Pikachu da feira', number_local: '7', price_manual: {avg: 80, currency: 'BRL', date: '2026-11-01', source: 'Liga Pokémon'}, set_code: 'FEIRA', set_name_local: 'Feira'});

	return old;
}

describe('Stats', () => {
	test('My Cards opens Stats, whose numbers match the copies and fit at 360 px', async () => {
		for (const colorScheme of ['light', 'dark']) {
			const device = await phone({colorScheme});
			const {page} = device;

			await page.goto(url('cards'));
			await page.waitForSelector('#cards-empty');

			const old = await seed(page);

			// My Cards reads the full records (the prices) from TCGdex.
			await page.goto(url('cards'));
			await page.waitForSelector('.tile:has-text("Charizard") .tile-price');
			await page.waitForSelector('.tile:has-text("Exeggcute") .tile-price');
			await noSideways(page, `My Cards with Stats beside Value, ${colorScheme}`);
			await fitsWidth(page, `My Cards' bar, ${colorScheme}`);

			const link = page.locator('#cards-stats-link');

			assert.equal(await link.textContent(), 'Stats');
			assert.ok((await link.boundingBox()).height >= 44, 'the Stats link is a whole touch target');

			if (colorScheme === 'light') {
				await page.screenshot({path: `${SHOTS}/stats-cards-bar.png`});
			}

			const requests = device.seen.tcgdex.length;

			await link.click();
			await page.waitForSelector('#stats-totals');
			assert.equal(new URL(page.url()).pathname, `${BASE}stats`);
			assert.equal(await page.title(), 'Stats | Card Tracker');
			assert.doesNotMatch(await page.locator('#view').textContent(), /\bnull\b|\bundefined\b|NaN/, 'no null, undefined, or NaN printed');

			const totals = await page.locator('#stats-totals .stats-total').evaluateAll((items) => items.map((item) => [item.querySelector('dt').textContent, item.querySelector('dd').textContent]));

			// The value takes the Languages tile, which By language says in
			// full (design review 2, 2026-11-20); its sum is checked below.
			assert.deepEqual(totals.map(([label]) => label), ['Copies', 'Cards', 'Sets', 'Value']);
			assert.deepEqual(totals.slice(0, 3), [['Copies', '4'], ['Cards', '3'], ['Sets', '3']]);

			// The summary, Lists (not counted yet here), Most valuable, By
			// language, and By set lead; the rest follow.
			const sections = await page.locator('#stats-body > .stats-section > h3').allTextContents();

			assert.deepEqual(sections.slice(0, 3), ['Most valuable', 'By language', 'By set']);
			assert.equal(await page.locator('#stats-body > :first-child').getAttribute('id'), 'stats-totals');
			assert.deepEqual(await barRows(page, 'stats-language'), [['English', '2 · 50%'], ['Portuguese', '2 · 50%']]);
			assert.deepEqual(await barRows(page, 'stats-set'), [['Base Set', '2 · 50%'], ['Feira', '1 · 25%'], ['Prismatic Evolutions', '1 · 25%']]);
			assert.deepEqual(await barRows(page, 'stats-finish'), [['Normal', '1 · 25%'], ['Holo', '3 · 75%']]);
			assert.deepEqual(await barRows(page, 'stats-condition'), [['Near Mint', '1 · 25%'], ['Lightly Played', '1 · 25%'], ['Not set', '2 · 50%']]);
			assert.equal(await page.locator('#stats-set-more').count(), 0, 'three sets need no "and more"');
			assert.equal(await page.locator('#stats-lists').count(), 0, 'no Lists part before Lists has counted any');

			// The bars are for the eye; the numbers are text.
			assert.equal(await page.locator('.stats-bar-track[aria-hidden="true"]').count(), await page.locator('.stats-bar-track').count());

			// Most valuable, by the Value sheet's value: the US estimate in
			// reais at the saved rate ("~"), and the kept Liga price.
			const usd = extractPrices(charizard).find((finish) => finish.label === 'Holo, Unlimited').tcgplayer.marketPrice;
			const normal = extractPrices(exeggcute).find((finish) => finish.label === 'Normal').tcgplayer.marketPrice;
			const rows = await page.locator('#stats-valuable li').evaluateAll((items) => items.map((item) => [
				item.querySelector('.stats-valuable-name').textContent,
				item.querySelector('.stats-valuable-price').textContent,
				item.querySelector('a') ? item.querySelector('a').getAttribute('data-link') : null,
			]));

			assert.deepEqual(rows.map(([name, price, route]) => [name, plain(price), route]), [
				['Charizard', `~${plain(formatBrl(roundCents(usd * FAKE_RATE.rate)))}`, `cards/en/${charizard.id}`],
				['Charizard', `~${plain(formatBrl(roundCents(usd * FAKE_RATE.rate)))}`, `cards/en/${charizard.id}`],
				['Pikachu da feira', plain(formatBrl(80)), `cards/pt/${HAND_ID}`],
				['Exeggcute', `~${plain(formatBrl(roundCents(normal * FAKE_RATE.rate)))}`, `cards/en/${exeggcute.id}`],
			]);
			assert.equal(await page.locator('#stats-unpriced').textContent(), 'Every copy has a price.');
			// The summary's value is the Value sheet's sum of the same copies,
			// in whole reais, "~" as part of it is a US estimate.
			assert.equal(plain(totals[3][1]), `~${plain(formatBrlCompact(2 * usd * FAKE_RATE.rate + 80 + normal * FAKE_RATE.rate))}`);

			// Added per month: twelve months, the oldest first.
			const months = await barRows(page, 'stats-months');

			assert.equal(months.length, 12);
			assert.deepEqual(months[11], [monthAgo(0).name, '3']);
			assert.deepEqual(months[9], [old.name, '1']);
			assert.equal(months.reduce((sum, [, count]) => sum + Number(count), 0), 4);

			// Worked out from what the phone has: nothing more is asked of
			// TCGdex.
			assert.equal(device.seen.tcgdex.length, requests, 'Stats sends no request');

			// Each valuable row is a whole touch target, and the bars are in
			// the theme's link color.
			const heights = await page.locator('.stats-valuable-row').evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));

			assert.ok(heights.every((height) => height >= 44), `rows are touch targets (${heights})`);

			const colors = await page.evaluate(() => ({
				fill: getComputedStyle(document.querySelector('.stats-bar-fill')).backgroundColor,
				link: getComputedStyle(document.querySelector('.stats-valuable-name')).color,
			}));

			assert.equal(colors.fill, colors.link);
			await noSideways(page, `Stats, ${colorScheme}`);
			await fitsWidth(page, `Stats, ${colorScheme}`);
			await page.screenshot({fullPage: true, path: `${SHOTS}/stats-${colorScheme}.png`});

			// A valuable row opens the card's page.
			await page.locator('#stats-valuable a').first().click();
			await page.waitForURL(`**${BASE}cards/en/${charizard.id}`);
			await done(device);
		}
	});

	test('your lists show as Lists last counted them, and say when the cards changed since', async () => {
		const device = await phone({dexMap: [{dexId: [6], id: charizard.id}, {dexId: [102], id: exeggcute.id}]});
		const {page} = device;
		const evaluate = (fn, arg) => page.evaluate(fn, arg);

		await page.goto(url('cards'));
		await page.waitForSelector('#cards-empty');
		await addCard(page, {card_id: charizard.id, catalog: 'international', language: 'pt', language_source: 'manual', variant_id: variant(charizard, 'Holo, Unlimited')});
		await addCard(page, {card_id: exeggcute.id, catalog: 'international', language: 'en', language_source: 'manual', variant_id: variant(exeggcute, 'Normal')});

		const kanto = await evaluate(async () => (await import('/pokemon-card-tracker/js/checklists.js')).createChecklist({kind: 'region', name: 'Kanto', target: 'kanto'}));
		const johto = await evaluate(async () => (await import('/pokemon-card-tracker/js/checklists.js')).createChecklist({kind: 'region', name: 'Johto', target: 'johto'}));
		const goal = await evaluate(async () => (await import('/pokemon-card-tracker/js/goals.js')).createGoal({kind: 'set', level: 'master', name: 'Base Set', target: 'base1'}));

		// A master set goal's count, as its ring on Lists would leave it.
		await evaluate(async (id) => (await import('/pokemon-card-tracker/js/list-progress.js')).recordListProgress([{id, owned: 3, total: 10, unit: 'finishes'}], {stamp: '2000-01-01T00:00:00.000Z'}), goal.id);
		// The goal alone was counted, before the copies were added.
		await page.goto(url('stats'));
		await page.waitForSelector('#stats-lists');
		assert.deepEqual(await barRows(page, 'stats-lists'), [['Base Set', '3 of 10 finishes · 30%']]);
		assert.equal(await page.locator('#stats-lists-changed').count(), 1, 'the copies were added after that count');

		// Lists counts the checklists from your Portuguese copies (a new
		// list's languages): Charizard, #6. Stats then shows them, first.
		await page.click('#stats-lists-open');
		await page.waitForSelector(`.list-tile[href$="${kanto.id}"] .owned-count`);
		await page.goto(url('stats'));
		await page.waitForSelector('#stats-lists');

		const requests = device.seen.tcgdex.length;

		await page.waitForSelector('#stats-totals');
		assert.deepEqual(await barRows(page, 'stats-lists'), [['Kanto', '1 of 151 · less than 1%'], ['Johto', '0 of 100 · 0%'], ['Base Set', '3 of 10 finishes · 30%']]);
		assert.equal(await page.locator('#stats-body > :nth-child(2) #stats-lists').count(), 1, 'Lists right after the summary');

		const links = await page.locator('#stats-lists a.stats-bar-label').evaluateAll((items) => items.map((item) => item.getAttribute('data-link')));

		assert.deepEqual(links, [`lists/${kanto.id}`, `lists/${johto.id}`, `goals/${goal.id}`]);

		const day = await evaluate(() => new Date().toLocaleDateString('en-US', {day: 'numeric', month: 'short'}));

		assert.equal(await page.locator('#stats-lists-when').textContent(), `As counted on Lists on ${day}.`);
		assert.equal(await page.locator('#stats-lists-changed').count(), 1, 'the goal\'s count is still older than the copies');

		const heights = await page.locator('#stats-lists a.stats-bar-label').evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));

		assert.ok(heights.every((height) => height >= 44), `list names are touch targets (${heights})`);
		await noSideways(page, 'Stats with lists');
		await fitsWidth(page, 'Stats with lists');
		await page.locator('#stats-lists').scrollIntoViewIfNeeded();
		await page.screenshot({path: `${SHOTS}/stats-lists.png`});

		// A Portuguese Exeggcute (#102) after the count: Stats says the cards
		// changed and keeps the old count, and counts nothing itself.
		await addCard(page, {card_id: exeggcute.id, catalog: 'international', language: 'pt', language_source: 'manual', variant_id: variant(exeggcute, 'Normal')});
		await evaluate(async (id) => (await import('/pokemon-card-tracker/js/list-progress.js')).recordListProgress([{id, owned: 3, total: 10, unit: 'finishes'}], {stamp: '2100-01-01T00:00:00.000Z'}), goal.id);
		await page.goto(url('stats'));
		await page.waitForSelector('#stats-lists');
		assert.deepEqual((await barRows(page, 'stats-lists'))[0], ['Kanto', '1 of 151 · less than 1%']);
		assert.equal(await page.locator('#stats-lists-changed').textContent(), 'Your cards have changed since. Open Lists to count again.');
		assert.equal(device.seen.tcgdex.length, requests, 'Stats sends no request');

		// Counted again on Lists: up to date, with no note.
		await page.click('#stats-lists-open');
		await page.waitForSelector(`.list-tile[href$="${kanto.id}"] .owned-count:has-text("2 / 151")`);
		await page.goto(url('stats'));
		await page.waitForSelector('#stats-lists');
		assert.deepEqual((await barRows(page, 'stats-lists'))[0], ['Kanto', '2 of 151 · 1%']);
		assert.equal(await page.locator('#stats-lists-changed').count(), 0);

		// A deleted list leaves Stats.
		await evaluate(async (id) => (await import('/pokemon-card-tracker/js/checklists.js')).deleteChecklist(id), johto.id);
		await page.goto(url('stats'));
		await page.waitForSelector('#stats-lists');
		assert.deepEqual((await barRows(page, 'stats-lists')).map(([label]) => label), ['Kanto', 'Base Set']);
		await done(device);
	});

	test('with no cards, Stats says so', async () => {
		const device = await phone();
		const {page} = device;

		await page.goto(url('stats'));
		await page.waitForSelector('#stats-empty');
		assert.match(await page.locator('#stats-empty').textContent(), /No cards yet/);
		await page.click('#stats-back');
		await page.waitForSelector('#cards-empty');
		await done(device);
	});

	test('a copy whose price has not downloaded is counted as waiting', async () => {
		const device = await phone();
		const {page} = device;

		await page.goto(url('cards'));
		await page.waitForSelector('#cards-empty');
		// Stats straight away: My Cards never read the record.
		await addCard(page, {card_id: charizard.id, catalog: 'international', language: 'en', language_source: 'manual', variant_id: variant(charizard, 'Holo, Unlimited')});
		await page.goto(url('stats'));
		await page.waitForSelector('#stats-totals');
		assert.equal(await page.locator('#stats-unpriced').textContent(), '1 copy of 1 has no price.');
		assert.match(await page.locator('.stats-reasons').textContent(), /^1 copy still waits for a price; prices download while My Cards is open\.$/);
		assert.match(await page.locator('#stats-valuable-none').textContent(), /^No copy has a price yet/);
		assert.deepEqual(await barRows(page, 'stats-rarity'), [['Not known yet', '1 · 100%']]);
		await done(device);
	});
});
