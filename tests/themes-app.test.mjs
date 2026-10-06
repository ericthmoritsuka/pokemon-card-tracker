// Browser tests for themes and the favorite Pokémon: switching, the theme
// painted before any script runs, persistence across reloads and devices,
// the favorite in the header and the browser tab, and the one-tap theme
// suggestion. Headless Chromium at 360 x 740 against tests/pages-server.mjs.
//
// Supabase is answered by tests/fake-supabase.mjs and never reached. PokeAPI
// and its sprites are faked; the Sets screen check replays real TCGdex
// answers recorded in tests/tcgdex-fixtures.json (tests/tcgdex-replay.mjs).
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
import {replayTcgdex} from './tcgdex-replay.mjs';

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

async function device(fake, name, {colorScheme = 'light', tcgdex = 'fake', viewport = VIEWPORT} = {}) {
	const context = await browser.newContext({colorScheme, serviceWorkers: 'block', viewport});
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
	else if (tcgdex === 'recorded') {
		await replayTcgdex(context);
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
		assert.equal(await page.locator('.theme-option').count(), 12, 'default plus the 11 energy types');
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
		await chooseTheme(page, 'lightning');

		const onAccent = await page.evaluate(() => getComputedStyle(document.querySelector('.top')).color);

		assert.equal(onAccent, rgbOf('#1b1b1f'));
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a theme saved under a game type id comes back as its energy', async () => {
		const {context, errors, page} = await device(null, 'phone');

		await page.addInitScript(() => {
			if (!sessionStorage.getItem('seeded')) {
				localStorage.setItem('card-tracker-theme', 'electric');
				sessionStorage.setItem('seeded', '1');
			}
		});
		await page.goto(url('profile'));
		await page.waitForSelector('#theme-grid');
		assert.equal(await themeAttr(page), 'lightning');
		assert.equal(await page.evaluate(() => localStorage.getItem('card-tracker-theme')), 'lightning', 'kept as the TCG id');
		assert.ok(await page.locator('.theme-option[data-theme-id="lightning"] input').isChecked(), 'the Lightning swatch is checked');
		assert.equal(await headerBg(page), rgbOf(palette(themeById('lightning'), 'light')['--header-bg']));
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('the suggestion follows the energy most of the Pokémon\'s cards carry, else its game type', async () => {
		const {context, errors, page} = await device(null, 'phone');
		const asked = [];

		// Gengar plays as Psychic by its game type; say its cards are mostly
		// Darkness. Pikachu's card query fails, so its game type decides.
		await context.route('https://api.tcgdex.net/v2/graphql', (route) => {
			const query = JSON.parse(route.request().postData() || '{}').query || '';
			const n = Number((/dexId: (\d+)/.exec(query) || [])[1]);

			asked.push(n);

			if (n !== 94) {
				return route.fulfill({body: 'down', status: 503});
			}

			return route.fulfill({body: JSON.stringify({data: {cards: [{types: ['Darkness']}, {types: ['Darkness']}, {types: ['Psychic']}, {types: null}]}}), contentType: 'application/json'});
		});
		await page.goto(url('profile'));
		await page.waitForSelector('#theme-grid');

		const suggest = (n) => page.evaluate(async (dex) => {
			const theme = await (await import('/pokemon-card-tracker/js/settings.js')).suggestedThemeFor(dex);

			return theme && theme.id;
		}, n);

		assert.equal(await suggest(94), 'darkness');
		assert.equal(await suggest(25), 'lightning');
		assert.equal(await suggest(94), 'darkness', 'kept on the phone');
		assert.deepEqual(asked, [94, 25], 'one card query per Pokémon, cached');
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

	// Q-38: the frames are 0 to 5 px wide, so a panel that grew or shrank
	// with its frame moved every swatch below it, and a quick second tap
	// landed on the wrong one.
	test('the swatches stay put while every theme is picked in turn', async () => {
		for (const width of [360, 390]) {
			for (const colorScheme of ['light', 'dark']) {
				const {context, errors, page} = await device(null, 'phone', {colorScheme, viewport: {height: 740, width}});

				await page.goto(url('profile'));
				await page.waitForSelector('#theme-grid');

				const ids = await page.locator('.theme-option').evaluateAll((options) => options.map((option) => option.dataset.themeId));
				const where = () => page.evaluate(() => {
					const swatch = document.querySelector('.theme-option .swatch').getBoundingClientRect();

					return Math.round(swatch.top + scrollY);
				});
				const start = await where();

				for (const id of [...ids.slice(1), ids[0]]) {
					await chooseTheme(page, id);
					await page.mouse.move(5, 5);
					assert.equal(await where(), start, `${width} px ${colorScheme}: the swatches stay put after picking ${id}`);
				}

				assert.deepEqual(errors, []);
				await context.close();
			}
		}
	});

	test('the Scan disc is the theme\'s Poké Ball, and the finish badge stays a red one', async () => {
		const {context, errors, page} = await device(null, 'phone');
		const disc = () => page.evaluate(() => {
			const style = getComputedStyle(document.querySelector('.scan-disc'));

			return {disc: style.backgroundColor, glyph: style.color, ring: style.borderTopColor};
		});
		const expected = (id, scheme) => {
			const vars = palette(themeById(id), scheme);

			return {disc: rgbOf(vars['--scan']), glyph: rgbOf(vars['--scan-glyph']), ring: rgbOf(vars['--scan-ring'])};
		};

		await page.goto(url('profile'));
		await page.waitForSelector('#theme-grid');
		assert.deepEqual(await disc(), {disc: 'rgb(220, 10, 45)', glyph: 'rgb(255, 255, 255)', ring: 'rgb(255, 255, 255)'}, 'the default is the red Poké Ball');

		// A tile's finish badge, as js/pokemon-cards-view.js draws it.
		await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<span class="ball" id="ball-probe"></span>'));

		const badge = () => page.evaluate(() => getComputedStyle(document.getElementById('ball-probe')).backgroundImage);

		assert.match(await badge(), /^linear-gradient\(rgb\(220, 10, 45\)/);

		for (const id of ['grass', 'darkness', 'colorless']) {
			await chooseTheme(page, id);
			assert.deepEqual(await disc(), expected(id, 'light'), `${id}'s ball`);
			assert.match(await badge(), /^linear-gradient\(rgb\(220, 10, 45\)/, `the finish badge is red under ${id}`);
		}

		// Dark mode: Dusk Ball turns inside out, black ring on green.
		await context.close();

		const night = await device(null, 'phone', {colorScheme: 'dark'});

		await night.page.goto(url('profile'));
		await night.page.waitForSelector('#theme-grid');
		await chooseTheme(night.page, 'darkness');
		assert.deepEqual(await night.page.evaluate(() => {
			const style = getComputedStyle(document.querySelector('.scan-disc'));

			return {disc: style.backgroundColor, glyph: style.color, ring: style.borderTopColor};
		}), expected('darkness', 'dark'));
		assert.deepEqual(errors, []);
		assert.deepEqual(night.errors, []);
		await night.context.close();
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

		// The suggestion offers Lightning and applies nothing by itself.
		await page.waitForSelector('#suggestion-apply:has-text("Use the Lightning theme")');
		assert.match(await page.locator('#theme-suggestion').textContent(), /Pikachu is a Lightning type/);
		assert.equal(await themeAttr(page), 'default', 'never applied automatically');
		await page.screenshot({fullPage: false, path: '/tmp/themes-default-suggestion.png'});

		await page.click('#suggestion-apply');
		await page.waitForFunction(() => document.documentElement.dataset.theme === 'lightning');
		await page.waitForFunction(() => !document.querySelector('#suggestion-apply'));
		assert.ok(await page.locator('.theme-option[data-theme-id="lightning"] input').isChecked());

		// The settings reach the server.
		await page.waitForFunction(() => document.getElementById('sync-status').textContent === 'Synced', null, {timeout: 15000});

		let settings = null;

		for (let i = 0; i < 50; i++) {
			settings = fake.documents.get(owner.id) && fake.documents.get(owner.id).doc.settings;

			if (settings && settings.theme === 'lightning' && settings.favorite_pokemon === 25) {
				break;
			}

			await page.waitForTimeout(200);
		}

		assert.equal(settings.theme, 'lightning');
		assert.equal(settings.favorite_pokemon, 25);
		assert.ok(settings.updated_at, 'settings carry updated_at for the merge');

		await page.goto(url('cards'));
		await page.waitForSelector('#cards-summary, .empty-state');
		await page.screenshot({fullPage: false, path: '/tmp/themes-lightning.png'});

		// Reload: still Lightning, still Pikachu.
		await page.reload();
		await page.waitForSelector('#account.avatar');
		assert.equal(await themeAttr(page), 'lightning');
		await page.waitForFunction((src) => document.getElementById('brand-mark').src === src, sprite);

		// Another device: the theme and the favorite arrive with the first sync.
		const tablet = await device(fake, 'tablet');

		await signIn(tablet.page, fake, owner.email);
		await waitForSynced(tablet.page);
		await tablet.page.waitForFunction(() => document.documentElement.dataset.theme === 'lightning', null, {timeout: 15000});
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
		const {context, errors, page} = await device(null, 'phone', {tcgdex: 'recorded'});

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
