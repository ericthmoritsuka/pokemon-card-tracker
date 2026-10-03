// Shared by the Trade and favorites browser tests: invented copies, and the
// wiring of the Trade screen into the app until the integrator adds these
// lines to the shared files (app.js, index.html, sw.js):
//
//   app.js      import {tradeAccountViews, tradeRoutes} from './js/trade-view.js';
//               ...tradeRoutes,            (last in ROUTES)
//               ...tradeAccountViews       (in ACCOUNT_ROUTES)
//   index.html  <link rel="stylesheet" href="/pokemon-card-tracker/css/trade.css">
//   sw.js SHELL 'js/trade-view.js' and 'css/trade.css'
//
// wireTrade() serves app.js with the first two lines added when the real one
// does not have them yet, and links the stylesheet; once the integrator has
// added them it changes nothing. checkIntegration() says which are still
// missing.

import {readFile} from 'node:fs/promises';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {FakeSupabase} from './fake-supabase.mjs';
import {BASE, documentWith, fakeServices, indexRecords, seed} from './my-cards-fixtures.mjs';

const ROOT = new URL('../', import.meta.url);

const IMPORT = 'import {tradeAccountViews, tradeRoutes} from \'./js/trade-view.js\';';

export async function checkIntegration() {
	const [app, html, sw] = await Promise.all(['app.js', 'index.html', 'sw.js'].map((name) => readFile(new URL(name, ROOT), 'utf8')));

	return {
		app: app.includes(IMPORT) && app.includes('...tradeRoutes,') && app.includes('...tradeAccountViews'),
		css: html.includes('css/trade.css'),
		shell: sw.includes('\'js/trade-view.js\'') && sw.includes('\'css/trade.css\''),
	};
}

// A patched copy of app.js, for a real one that lacks the Trade wiring.
export async function appWithTrade() {
	const app = await readFile(new URL('app.js', ROOT), 'utf8');

	if (app.includes(IMPORT)) {
		return app;
	}

	return `${IMPORT}\n${app}`
		.replace('\n\t...WISHLIST_ROUTES,\n', '\n\t...WISHLIST_ROUTES,\n\t...tradeRoutes,\n')
		.replace('...pokemonCardsAccountViews]);', '...pokemonCardsAccountViews, ...tradeAccountViews]);');
}

export async function wireTrade(context) {
	const patched = await appWithTrade();

	await context.route(/\/app\.js(\?.*)?$/, (route) => route.fulfill({body: patched, contentType: 'text/javascript; charset=utf-8'}));
	await context.addInitScript((base) => {
		document.addEventListener('DOMContentLoaded', () => {
			for (const name of ['filter-bar', 'value-sheet', 'trade']) {
				const href = `${base}css/${name}.css`;

				if (!document.querySelector(`link[href="${href}"]`)) {
					document.head.append(Object.assign(document.createElement('link'), {href, rel: 'stylesheet'}));
				}
			}
		});
	}, BASE);
}

const at = (day) => `2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`;

const copy = (id, cardId, fields = {}) => ({
	card_id: cardId,
	catalog: fields.catalog || 'international',
	created_at: at(Number(id.slice(2))),
	deleted_at: null,
	id,
	language: 'en',
	language_source: 'manual',
	updated_at: at(Number(id.slice(2))),
	variant_id: null,
	...fields,
});

// Spares: Charmander EN 2 (three copies) and PT 1 (two copies), Charizard
// ex EN 1 (two copies, the favorite is the one kept), Pikachu EN 1 (two
// copies), Pikachu JA 1 (two copies). Nothing from Bulbasaur (one copy),
// Test Ball (one PT copy), or Sprigatito (two copies, one deleted).
// 15 copies, 6 spares in 5 tiles.
export const SPARE_COPIES = [
	copy('c-01', 'tsa1-001'),
	copy('c-02', 'tsa1-004', {condition: 'Near Mint'}),
	copy('c-03', 'tsa1-004', {condition: 'Played', finish_raw: 'Reverse Holofoil'}),
	copy('c-04', 'tsa1-004', {condition: 'Near Mint'}),
	copy('c-05', 'tsa1-004', {language: 'pt'}),
	copy('c-06', 'tsa1-004', {language: 'pt', finish_raw: 'Holofoil'}),
	copy('c-07', 'tsa1-006', {is_favorite: true}),
	copy('c-08', 'tsa1-006'),
	copy('c-09', 'tsb2-025', {price_manual: {avg: 80, currency: 'BRL', date: '2026-09-20', low_nm: 70, source: 'Liga Pokémon'}}),
	copy('c-10', 'tsb2-025', {price_manual: {avg: 90, currency: 'BRL', date: '2026-09-20', low_nm: 70, source: 'Liga Pokémon'}}),
	copy('c-11', 'TSJ1-025', {catalog: 'ja', language: 'ja'}),
	copy('c-12', 'TSJ1-025', {catalog: 'ja', language: 'ja'}),
	copy('c-13', 'tsa1-150', {language: 'pt'}),
	copy('c-14', 'tsb2-090'),
	copy('c-15', 'tsb2-090', {deleted_at: at(16)}),
];

// A signed-in owner with an empty collection, in a family with Member A,
// whose document on the fake server holds memberCards. Supabase is the fake;
// TCGdex and the rest answer from tests/my-cards-fixtures.mjs. Returns
// {context, errors, member, page}.
export async function familyDevice(browser, server, memberCards) {
	const fake = new FakeSupabase();
	const owner = fake.addUser('owner@example.test');
	const member = fake.addUser('member-a@example.test');
	const context = await browser.newContext({hasTouch: true, serviceWorkers: 'block', viewport: {height: 844, width: 390}});

	await fakeServices(context);
	await fakePokeApi(context);
	await fake.attach(context, 'owner');
	await wireTrade(context);
	fake.documents.set(member.id, {
		doc: {...documentWith(memberCards), person: undefined, user_id: undefined},
		updated_at: fake.now(),
		user_id: member.id,
	});
	fake.profiles.set(member.id, {display_name: 'Member A', user_id: member.id});

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err.message));
	await seed(page, server.origin, {binders: [], copies: [], index: indexRecords()});
	await page.goto(`${server.origin}${BASE}signin`);
	await page.fill('#signin-email', owner.email);
	await page.click('button:has-text("Send link")');
	await page.waitForSelector('#check-email');
	await page.goto(`${server.origin}${BASE}?code=${fake.issueCode(owner.email)}`);
	await page.waitForSelector('#account.avatar');
	await page.waitForFunction(() => {
		const line = document.getElementById('sync-status');

		return line && !line.hidden && line.textContent === 'Synced';
	}, null, {timeout: 15000});
	fake.members.push({group_id: fake.groups[0].id, role: 'member', user_id: member.id});

	return {context, errors, member, page};
}

// Each tile's name and meta line, in order.
export const spareNames = (page) => page.locator('.card-grid .tile').evaluateAll((tiles) => tiles.map((tile) => `${tile.querySelector('.tile-name').textContent}|${tile.querySelector('.tile-meta').textContent}`));
