// Browser tests for themes and the favorite Pokémon: switching, the theme
// painted before any script runs, persistence across reloads and devices,
// the favorite in the header and the browser tab, and the one-tap theme
// suggestion. Headless Chromium at 360 x 740 against tests/pages-server.mjs.
//
// Supabase is answered by tests/fake-supabase.mjs and never reached. PokeAPI
// and its sprites are faked; TCGdex is real only for the Sets screen check.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/themes-app.test.mjs
// Screenshots: /tmp/themes-*.png

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {palette, themeById} from '../js/themes.js';
import {fakePokeApi as fakeSpeciesNames} from './fake-pokeapi.mjs';
import {FakeSupabase} from './fake-supabase.mjs';
import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const VIEWPORT = {height: 740, width: 360};

const NAMES = {6: 'Charizard', 25: 'Pikachu', 94: 'Gengar', 133: 'Eevee', 669: 'Flabébé'};
const PRIMARY_TYPES = {6: 'fire', 25: 'electric', 94: 'ghost', 133: 'normal', 669: 'fairy'};

let server;
let browser;
let spritePng;

before(async () => {
	server = await startPagesServer();
	browser = await chromium.launch();
	spritePng = await readFile(new URL('../icons/icon-192.png', import.meta.url));
});

after(async () => {
	await browser.close();
	await server.close();
});

const url = (path = '') => `${server.origin}${BASE}${path}`;

// "rgb(r, g, b)" for a hex color, the way getComputedStyle prints it.
function rgbOf(hex) {
	const n = parseInt(hex.slice(1), 16);

	return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
}

// Species names come from tests/fake-pokeapi.mjs, in the six-language shape
// js/checklists.js asks for, with NAMES as the English ones. The primary
// type query (js/settings.js) is answered here, on top of it.
async function fakePokeApi(context, log) {
	await fakeSpeciesNames(context, {english: NAMES});
	await context.route('https://graphql.pokeapi.co/**', (route) => {
		const query = JSON.parse(route.request().postData() || '{}').query || '';

		log.push(query);

		if (!query.includes('pokemontype')) {
			return route.fallback();
		}

		const n = Number((/_eq: (\d+)/.exec(query) || [])[1]);

		return route.fulfill({body: JSON.stringify({data: {pokemontype: PRIMARY_TYPES[n] ? [{type: {name: PRIMARY_TYPES[n]}}] : []}}), contentType: 'application/json'});
	});
	await context.route('https://raw.githubusercontent.com/PokeAPI/**', (route) => route.fulfill({body: spritePng, contentType: 'image/png'}));
}

async function device(fake, name, {colorScheme = 'light', tcgdex = 'fake'} = {}) {
	const context = await browser.newContext({colorScheme, serviceWorkers: 'block', viewport: VIEWPORT});
	const pokeapi = [];

	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());

	if (fake) {
		await fake.attach(context, name);
	}
	else {
		await context.route('https://*.supabase.co/**', (route) => {
			throw new Error(`Unexpected Supabase request: ${route.request().url()}`);
		});
	}

	if (tcgdex === 'fake') {
		await context.route('https://api.tcgdex.net/**', (route) => route.fulfill({body: '{}', contentType: 'application/json', status: 404}));
		await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));
	}

	await fakePokeApi(context, pokeapi);

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err));

	return {context, errors, page, pokeapi};
}

async function signIn(page, fake, email) {
	await page.goto(url('signin'));
	await page.fill('#signin-email', email);
	await page.click('button:has-text("Send link")');
	await page.waitForSelector('#check-email');
	await page.goto(`${url()}?code=${fake.issueCode(email)}`);
	await page.waitForSelector('#account.avatar');
}

async function waitForSynced(page) {
	await page.waitForFunction(() => {
		const line = document.getElementById('sync-status');

		return line && !line.hidden && line.textContent === 'Synced';
	}, null, {timeout: 15000});
}

const headerBg = (page) => page.evaluate(() => getComputedStyle(document.querySelector('.top')).backgroundColor);

const themeAttr = (page) => page.evaluate(() => document.documentElement.dataset.theme || null);

async function chooseTheme(page, id) {
	await page.click(`.theme-option[data-theme-id="${id}"] .swatch`);
	await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, id);
}

describe('themes signed out', () => {
	test('the picker switches the theme, keeps it on the phone, and paints it before any script runs', async () => {
		const {context, errors, page} = await device(null, 'phone');

		await page.goto(url('cards'));
		assert.equal(await themeAttr(page), 'default');
		assert.equal(await headerBg(page), rgbOf('#1d2e60'), 'the default header is navy');
		assert.ok(await page.locator('#brand-mark').isHidden(), 'signed out, the title keeps the room');

		// Menu, Theme: Profile signed out, with the picker.
		await page.click('#account');
		await page.waitForSelector('#theme-grid');
		assert.equal(await page.locator('.theme-option').count(), 19, 'default plus 18 types');
		assert.equal(await page.locator('#favorite-card').count(), 0, 'the favorite needs an account');
		assert.ok(await page.locator('.theme-option[data-theme-id="default"] input').isChecked());

		await chooseTheme(page, 'fire');

		const fire = palette(themeById('fire'), 'light');

		assert.equal(await headerBg(page), rgbOf(fire['--header-bg']));
		assert.match(await page.locator('#theme-status').textContent(), /saved on this phone/);
		assert.equal(await page.evaluate(() => localStorage.getItem('card-tracker-theme')), 'fire');
		assert.equal(await page.evaluate(() => document.querySelector('meta[name="theme-color"]').content), fire['--header-bg']);

		// Panels carry the tint and the frame.
		const panel = await page.evaluate(() => {
			const style = getComputedStyle(document.getElementById('theme-card'));

			return {background: style.backgroundColor, border: style.borderTopColor};
		});

		assert.equal(panel.background, rgbOf(fire['--panel']));

		// Destructive red does not follow the theme.
		await page.screenshot({fullPage: false, path: '/tmp/themes-fire.png'});

		// Reload with app.js blocked: the <head> script alone puts the theme on.
		await page.route('**/pokemon-card-tracker/app.js', (route) => route.abort());
		await page.reload();
		assert.equal(await themeAttr(page), 'fire');
		assert.equal(await headerBg(page), rgbOf(fire['--header-bg']), 'themed before any module runs');
		await page.unroute('**/pokemon-card-tracker/app.js');

		// And a normal reload keeps it, with the picker in step.
		await page.reload();
		await page.waitForSelector('#theme-grid');
		assert.ok(await page.locator('.theme-option[data-theme-id="fire"] input').isChecked());

		// A bright type turns the text on the accent dark.
		await chooseTheme(page, 'electric');

		const onAccent = await page.evaluate(() => getComputedStyle(document.querySelector('.top')).color);

		assert.equal(onAccent, rgbOf('#1b1b1f'));
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('the preview shows a theme under the pointer without changing the page', async () => {
		const {context, errors, page} = await device(null, 'phone');

		await page.goto(url('profile'));
		await page.waitForSelector('#theme-grid');
		await page.hover('.theme-option[data-theme-id="water"] .swatch');
		assert.equal(await page.locator('#theme-preview').getAttribute('data-theme'), 'water');
		assert.equal(await themeAttr(page), 'default', 'hovering does not apply it');

		const bar = await page.evaluate(() => getComputedStyle(document.querySelector('.preview-bar')).backgroundColor);

		assert.equal(bar, rgbOf(palette(themeById('water'), 'light')['--header-bg']));
		await page.mouse.move(5, 5);
		assert.equal(await page.locator('#theme-preview').getAttribute('data-theme'), 'default');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('dark mode: a theme switches to its dark palette', async () => {
		const {context, errors, page} = await device(null, 'phone', {colorScheme: 'dark'});

		await page.goto(url('profile'));
		await page.waitForSelector('#theme-grid');
		await chooseTheme(page, 'grass');

		const grass = palette(themeById('grass'), 'dark');

		assert.equal(await headerBg(page), rgbOf(grass['--header-bg']));
		assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('theme-card')).backgroundColor), rgbOf(grass['--panel']));
		await page.screenshot({path: '/tmp/themes-grass-dark.png'});
		assert.deepEqual(errors, []);
		await context.close();
	});
});

describe('themes and the favorite signed in', () => {
	test('favorite in the header and tab, the one-tap suggestion, and both follow the person to another device', async () => {
		const fake = new FakeSupabase();
		const owner = fake.addUser('owner@example.test');
		const phone = await device(fake, 'phone');
		const {page} = phone;

		await signIn(page, fake, owner.email);
		await waitForSynced(page);
		assert.equal(await page.locator('#brand-mark').getAttribute('src'), `${BASE}icons/icon-192.png`, 'no favorite yet: the app icon');
		await page.waitForSelector('#brand-mark:not([hidden])');

		await page.goto(url('profile'));
		await page.waitForSelector('#favorite-card');
		await page.waitForSelector('#theme-card');

		// Search by name, then by number.
		await page.fill('#favorite-search', 'pika');
		await page.waitForSelector('#favorite-results .picker-item:has-text("Pikachu")');
		await page.fill('#favorite-search', '#94');
		await page.waitForSelector('#favorite-results .picker-item:has-text("Gengar")');
		await page.fill('#favorite-search', 'flabebe');
		await page.waitForSelector('#favorite-results .picker-item:has-text("Flabébé")');
		await page.fill('#favorite-search', 'Pikachu');
		await page.click('#favorite-results .picker-item:has-text("Pikachu")');
		await page.waitForSelector('#favorite-name:has-text("Pikachu")');

		// The header and the tab icon show the sprite.
		const sprite = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/25.png';

		await page.waitForFunction((src) => document.getElementById('brand-mark').src === src, sprite);
		assert.equal(await page.evaluate(() => document.querySelector('link[rel="icon"]').href), sprite);

		// The suggestion offers Electric and applies nothing by itself.
		await page.waitForSelector('#suggestion-apply:has-text("Use the Electric theme")');
		assert.match(await page.locator('#theme-suggestion').textContent(), /Pikachu is an Electric type/);
		assert.equal(await themeAttr(page), 'default', 'never applied automatically');
		await page.screenshot({fullPage: false, path: '/tmp/themes-default-suggestion.png'});

		await page.click('#suggestion-apply');
		await page.waitForFunction(() => document.documentElement.dataset.theme === 'electric');
		await page.waitForFunction(() => !document.querySelector('#suggestion-apply'));
		assert.ok(await page.locator('.theme-option[data-theme-id="electric"] input').isChecked());

		// The settings reach the server.
		await page.waitForFunction(() => document.getElementById('sync-status').textContent === 'Synced', null, {timeout: 15000});

		let settings = null;

		for (let i = 0; i < 50; i++) {
			settings = fake.documents.get(owner.id) && fake.documents.get(owner.id).doc.settings;

			if (settings && settings.theme === 'electric' && settings.favorite_pokemon === 25) {
				break;
			}

			await page.waitForTimeout(200);
		}

		assert.equal(settings.theme, 'electric');
		assert.equal(settings.favorite_pokemon, 25);
		assert.ok(settings.updated_at, 'settings carry updated_at for the merge');

		await page.goto(url('cards'));
		await page.waitForSelector('#cards-summary, .empty-state');
		await page.screenshot({fullPage: false, path: '/tmp/themes-electric.png'});

		// Reload: still electric, still Pikachu.
		await page.reload();
		await page.waitForSelector('#account.avatar');
		assert.equal(await themeAttr(page), 'electric');
		await page.waitForFunction((src) => document.getElementById('brand-mark').src === src, sprite);

		// Another device: the theme and the favorite arrive with the first sync.
		const tablet = await device(fake, 'tablet');

		await signIn(tablet.page, fake, owner.email);
		await waitForSynced(tablet.page);
		await tablet.page.waitForFunction(() => document.documentElement.dataset.theme === 'electric', null, {timeout: 15000});
		await tablet.page.waitForFunction((src) => document.getElementById('brand-mark').src === src, sprite);

		// Changing it there comes back to the phone on its next sync.
		await tablet.page.goto(url('profile'));
		await tablet.page.waitForSelector('#theme-grid');
		await chooseTheme(tablet.page, 'water');
		await tablet.page.waitForFunction(() => document.getElementById('sync-status').textContent === 'Synced', null, {timeout: 15000});
		await tablet.page.waitForTimeout(2500);
		await tablet.page.waitForFunction(() => document.getElementById('sync-status').textContent === 'Synced', null, {timeout: 15000});
		await page.evaluate(async () => (await import('/pokemon-card-tracker/js/sync.js')).syncNow());
		await page.waitForFunction(() => document.documentElement.dataset.theme === 'water', null, {timeout: 15000});
		assert.equal(await page.evaluate(() => localStorage.getItem('card-tracker-theme')), 'water');

		// Profile, My Cards, and Sets all still render under a theme.
		await page.goto(url('profile'));
		await page.waitForSelector('#profile-email');
		await page.waitForSelector('#favorite-name:has-text("Pikachu")');
		await page.screenshot({fullPage: false, path: '/tmp/themes-water.png'});

		// Signing out puts the app icon back and keeps the theme on the phone.
		await page.click('#sign-out');
		await page.waitForSelector('#account:not(.avatar)');
		await page.waitForFunction(() => document.getElementById('brand-mark').getAttribute('src').endsWith('icons/icon-192.png'));
		assert.ok(await page.locator('#brand-mark').isHidden());
		assert.ok((await page.evaluate(() => document.querySelector('link[rel="icon"]').href)).endsWith('icons/icon-192.png'));
		assert.equal(await themeAttr(page), 'water');

		assert.deepEqual(phone.errors, []);
		assert.deepEqual(tablet.errors, []);
		await phone.context.close();
		await tablet.context.close();
	});

	test('My Cards, Sets, and Profile render under a type theme', async () => {
		const {context, errors, page} = await device(null, 'phone', {tcgdex: 'real'});

		await page.goto(url('cards'));
		await page.evaluate(() => localStorage.setItem('card-tracker-theme', 'dragon'));
		await page.reload();
		await page.waitForSelector('main h2');
		assert.equal(await themeAttr(page), 'dragon');

		await page.click('.tabs a[data-tab="sets"]');
		await page.waitForSelector('.set-tile:not(.skeleton)', {timeout: 30000});
		await page.screenshot({fullPage: false, path: '/tmp/themes-dragon.png'});

		await page.goto(url('profile'));
		await page.waitForSelector('#theme-grid');
		assert.ok(await page.locator('.theme-option[data-theme-id="dragon"] input').isChecked());
		assert.deepEqual(errors, []);
		await context.close();
	});
});
