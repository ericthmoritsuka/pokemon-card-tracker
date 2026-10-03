// Browser tests for Collections (js/collections.js, js/collections-view.js,
// css/collections.css): the third part of the Lists tab, a hand-picked
// collection made from card detail (one card in two collections), a
// collection that fills itself from a rule (Star), the shared filter bar and
// Value sheet on a collection, edit, delete with Undo, the scanner's "Add all
// to a collection", and a family member's collections read only.
// Headless Chromium at 390 x 844 against tests/pages-server.mjs. Every outside
// service is faked; nothing leaves the machine.
//
// Until the integrator adds the lines listed in the report to app.js,
// index.html, and sw.js, wireCollections() serves app.js with them and links
// the stylesheet; once they are there it changes nothing.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/collections-browser.test.mjs
// Screenshots: $SHOTS (default /tmp)/collections-*.png

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {fakePokeApi} from './fake-pokeapi.mjs';
import {FakeSupabase} from './fake-supabase.mjs';
import {BASE, CARDS, COPIES, documentWith, fakeServices, indexRecords, seed} from './my-cards-fixtures.mjs';
import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const SHOTS = process.env.SHOTS || '/tmp';
const TIMEOUT = {timeout: 20000};
const ROOT = new URL('../', import.meta.url);
const IMPORT = 'import {COLLECTIONS_ACCOUNT_VIEWS, COLLECTIONS_ROUTES} from \'./js/collections-view.js\';';

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

// ------------------------------------------------------------ wiring

async function appWithCollections() {
	const app = await readFile(new URL('app.js', ROOT), 'utf8');

	if (app.includes(IMPORT)) {
		return app;
	}

	return `${IMPORT}\n${app}`
		.replace('\n\t...WISHLIST_ROUTES,\n', '\n\t...WISHLIST_ROUTES,\n\t...COLLECTIONS_ROUTES,\n')
		.replace('...WISHLIST_ACCOUNT_VIEWS,', '...WISHLIST_ACCOUNT_VIEWS, ...COLLECTIONS_ACCOUNT_VIEWS,');
}

async function wireCollections(context) {
	const patched = await appWithCollections();

	await context.route(/\/app\.js(\?.*)?$/, (route) => route.fulfill({body: patched, contentType: 'text/javascript; charset=utf-8'}));
	await context.addInitScript((base) => {
		document.addEventListener('DOMContentLoaded', () => {
			for (const name of ['filter-bar', 'value-sheet', 'copies', 'collections']) {
				const href = `${base}css/${name}.css`;

				if (!document.querySelector(`link[href="${href}"]`)) {
					document.head.append(Object.assign(document.createElement('link'), {href, rel: 'stylesheet'}));
				}
			}
		});
	}, BASE);
}

// ------------------------------------------------------------ the data

const at = (day) => `2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`;

// The fixture cards, plus a Special illustration rare Charizard and an
// Illustration rare Pikachu, so a Star rule has something to collect.
const STAR_CARDS = [
	...CARDS,
	{catalog: 'international', category: 'Pokemon', dexId: [6], id: 'tsa1-199', market: 90, names: {en: 'Charizard SIR'}, rarity: 'Special illustration rare', set: CARDS[0].set, types: ['Fire']},
	{catalog: 'international', category: 'Pokemon', dexId: [25], id: 'tsb2-120', market: 12, names: {en: 'Pikachu IR', pt: 'Pikachu IR'}, rarity: 'Illustration rare', set: CARDS[5].set, types: ['Lightning']},
];

const star = (id, cardId, fields = {}) => ({card_id: cardId, catalog: 'international', created_at: at(Number(id.slice(2))), deleted_at: null, id, language: 'en', language_source: 'manual', updated_at: at(Number(id.slice(2))), variant_id: null, ...fields});

const COPIES_PLUS = [
	...COPIES,
	star('c-11', 'tsa1-199', {is_favorite: true}),
	star('c-12', 'tsb2-120', {language: 'pt'}),
];

async function phone({cards = STAR_CARDS, copies = COPIES_PLUS, local = {}} = {}) {
	const context = await browser.newContext({serviceWorkers: 'block', viewport: {height: 844, width: 390}});

	await fakeServices(context, {cards});
	await fakePokeApi(context);
	await wireCollections(context);

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err.message));
	await seed(page, server.origin, {binders: [], copies, index: indexRecords(cards), local});

	return {context, errors, page};
}

const url = (path = '') => `${server.origin}${BASE}${path}`;

const rows = (page) => page.locator('.col-row').evaluateAll((items) => items.map((item) => item.textContent.replace(/\s+/g, ' ').trim()));

const tileNames = (page) => page.locator('.card-grid .tile .tile-name').allTextContents();

async function openCollections(page) {
	await page.goto(url('collections'));
	await page.locator('#collections-title').waitFor(TIMEOUT);
}

// The collections in the phone's document, as the app saved them.
const savedCollections = (page) => page.evaluate(async () => {
	const {loadDocument} = await import(`${location.origin}/pokemon-card-tracker/js/collection.js`);

	return (await loadDocument()).collections;
});

describe('Collections', () => {
	test('the integration lines are in the shared files, or the harness supplies them', async () => {
		const [app, html, sw] = await Promise.all(['app.js', 'index.html', 'sw.js'].map((name) => readFile(new URL(name, ROOT), 'utf8')));

		console.log(`    integrated: app.js ${app.includes(IMPORT)}, index.html ${html.includes('css/collections.css')}, sw.js ${sw.includes('\'js/collections-view.js\'') && sw.includes('\'css/collections.css\'')}`);
		assert.ok(true);
	});

	test('Collections is the third part of the Lists tab, empty at first', async () => {
		const {context, errors, page} = await phone();

		await page.goto(url('lists'));
		await page.locator('#lists-switch-collections').waitFor(TIMEOUT);
		assert.equal(await page.locator('.lists-switch-item').count(), 3);
		assert.deepEqual(await page.locator('.lists-switch-item').allTextContents(), ['Checklists', 'Wishlist', 'Collections']);
		await page.click('#lists-switch-collections');
		await page.locator('#collections-empty').waitFor({state: 'visible', ...TIMEOUT});
		assert.equal(await page.locator('#lists-switch-collections').getAttribute('aria-current'), 'page');
		assert.equal(await page.locator('.col-row').count(), 0);
		await page.screenshot({path: `${SHOTS}/collections-empty.png`});
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a hand-picked collection starts empty and a card can sit in two of them', async () => {
		const {context, errors, page} = await phone();

		await openCollections(page);
		await page.click('#collections-new');
		await page.locator('#collection-editor[open]').waitFor(TIMEOUT);
		assert.equal(await page.locator('#col-rule').isHidden(), true, 'hand-picked is the default kind');
		await page.fill('#col-name', 'Fire keepers');
		await page.click('#col-save');
		await page.locator('#collection-empty').waitFor(TIMEOUT);
		assert.equal(await page.locator('.view-head h2').textContent(), 'Fire keepers');
		assert.match(await page.locator('#collection-about').textContent(), /Hand-picked/);
		assert.equal(await page.locator('#cards-add-hand').isHidden(), true);

		// Card detail: Charmander (EN and PT copies) into two collections.
		await page.goto(url('cards/en/tsa1-004'));
		await page.locator('#copies-collect').waitFor(TIMEOUT);
		await page.screenshot({path: `${SHOTS}/collections-detail.png`});
		await page.click('#copies-collect');
		await page.locator('#collections-sheet[open]').waitFor(TIMEOUT);
		assert.equal(await page.locator('#collections-sheet-list input[type=checkbox]').count(), 1);
		await page.locator('#collections-sheet-list input[type=checkbox]').check();
		await page.fill('#collections-sheet-name', 'Binder one');
		await page.click('#collections-sheet-create');
		await page.waitForFunction(() => document.querySelectorAll('#collections-sheet-list input[type=checkbox]').length === 2);
		assert.equal(await page.locator('#collections-sheet-list input:checked').count(), 2);
		await page.screenshot({path: `${SHOTS}/collections-sheet.png`});
		await page.click('#collections-sheet .sheet-head button');
		await page.locator('#collections-sheet').waitFor({state: 'detached'});

		await openCollections(page);
		await page.locator('.col-row').first().waitFor(TIMEOUT);
		const listed = await rows(page);

		assert.equal(listed.length, 2);
		assert.match(listed[0], /^Binder one.*Hand-picked.*2 cards/);
		assert.match(listed[1], /^Fire keepers.*Hand-picked.*2 cards/);
		await page.waitForFunction(() => [...document.querySelectorAll('.col-value')].every((node) => !/loading/.test(node.textContent)), null, TIMEOUT);
		await page.screenshot({path: `${SHOTS}/collections-list.png`});

		const saved = await savedCollections(page);

		assert.equal(saved.length, 2);
		assert.ok(saved.every((item) => Object.keys(item.entry_ids).length === 2));
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a collection shows its cards with the filter bar and the Value sheet', async () => {
		const {context, errors, page} = await phone();

		await page.goto(url('cards/en/tsa1-004'));
		await page.click('#copies-collect');
		await page.fill('#collections-sheet-name', 'Fire keepers');
		await page.click('#collections-sheet-create');
		await page.locator('#collections-sheet-list input:checked').waitFor(TIMEOUT);
		await page.click('#collections-sheet .sheet-head button');
		await openCollections(page);
		await page.click('.col-row');
		await page.locator('.card-grid .tile').first().waitFor(TIMEOUT);

		assert.equal((await tileNames(page)).length, 2);
		assert.ok(await page.locator('#cards-filters').isVisible());
		assert.ok(await page.locator('#cards-search').isVisible());
		await page.click('#cards-value');
		await page.locator('.value-sheet[open]').waitFor(TIMEOUT);
		assert.match(await page.locator('.vs-coverage').textContent(), /of 2 copies/);
		await page.screenshot({path: `${SHOTS}/collections-value.png`});
		await page.click('.value-sheet .sheet-head button');
		await page.fill('#cards-search', 'nothing like this');
		await page.locator('.cards-none').waitFor(TIMEOUT);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a collection that fills itself from a rule collects every card that fits, and stays up to date', async () => {
		const {context, errors, page} = await phone();

		await openCollections(page);
		await page.click('#collections-new');
		await page.locator('#collection-editor[open]').waitFor(TIMEOUT);
		await page.fill('#col-name', 'Star');
		await page.check('#col-kind-rule');
		await page.locator('#col-rule').waitFor({state: 'visible'});
		assert.match(await page.locator('#col-preview').textContent(), /at least one condition/);
		await page.click('#col-star');
		await page.waitForFunction(() => /2 cards match now/.test(document.getElementById('col-preview').textContent), null, TIMEOUT);
		assert.match(await page.locator('#col-preview').textContent(), /Rarity: Illustration rare, Special illustration rare/);
		await page.screenshot({path: `${SHOTS}/collections-editor-rule.png`});

		// Favorites only narrows it to the favorite Charizard.
		await page.check('#col-favorite');
		await page.waitForFunction(() => /1 card matches now/.test(document.getElementById('col-preview').textContent), null, TIMEOUT);
		await page.uncheck('#col-favorite');
		await page.click('#col-save');
		await page.locator('.card-grid .tile').first().waitFor(TIMEOUT);
		assert.deepEqual((await tileNames(page)).sort(), ['Charizard SIR', 'Pikachu IR']);
		assert.match(await page.locator('#collection-about').textContent(), /Fills itself\. Rarity: Illustration rare, Special illustration rare/);

		// A new card that fits joins on its own.
		await page.evaluate(async () => {
			const {addCard} = await import(`${location.origin}/pokemon-card-tracker/js/collection.js`);

			await addCard({card_id: 'tsa1-199', catalog: 'international', language: 'pt', language_source: 'manual'});
		});
		await page.waitForFunction(() => document.querySelectorAll('.card-grid .tile').length === 3, null, TIMEOUT);
		await page.screenshot({path: `${SHOTS}/collections-rule.png`});

		await openCollections(page);
		await page.locator('.col-row').waitFor(TIMEOUT);
		assert.match((await rows(page))[0], /^Star.*Fills itself.*3 cards/);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a rule collection takes no cards by hand: the card sheet lists it as read only', async () => {
		const {context, errors, page} = await phone();

		await openCollections(page);
		await page.click('#collections-new');
		await page.fill('#col-name', 'Star');
		await page.check('#col-kind-rule');
		await page.click('#col-star');
		await page.click('#col-save');
		await page.locator('.card-grid .tile').first().waitFor(TIMEOUT);
		await page.goto(url('cards/en/tsa1-199'));
		await page.click('#copies-collect');
		await page.locator('#collections-sheet-rules').waitFor(TIMEOUT);
		assert.match(await page.locator('#collections-sheet-rules').textContent(), /Also in, by rule: Star/);
		assert.equal(await page.locator('#collections-sheet-list input[type=checkbox]').count(), 0);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('editing renames and changes a rule; deleting asks no questions and Undo brings it back', async () => {
		const {context, errors, page} = await phone();

		await openCollections(page);
		await page.click('#collections-new');
		await page.fill('#col-name', 'Star');
		await page.check('#col-kind-rule');
		await page.click('#col-star');
		await page.click('#col-save');
		await page.locator('.card-grid .tile').first().waitFor(TIMEOUT);

		await page.click('#collection-edit');
		await page.locator('#collection-editor[open]').waitFor(TIMEOUT);
		assert.equal(await page.locator('#col-kind-hand').count(), 0, 'the kind is fixed once made');
		await page.fill('#col-name', 'Stars');
		await page.click('#col-group-language summary');
		await page.check('#col-language-0');
		await page.click('#col-save');
		await page.waitForFunction(() => document.querySelector('.view-head h2').textContent === 'Stars', null, TIMEOUT);
		assert.match(await page.locator('#collection-about').textContent(), /Language: /);

		await page.click('#collection-edit');
		await page.locator('#collection-editor[open]').waitFor(TIMEOUT);
		await page.click('#col-delete');
		await page.locator('#collections-empty').waitFor({state: 'visible', ...TIMEOUT});
		assert.equal(await page.locator('.col-row').count(), 0);
		await page.locator('.toast:has-text("Deleted Stars") button:has-text("Undo")').click();
		await page.locator('.col-row').waitFor(TIMEOUT);
		assert.match((await rows(page))[0], /^Stars/);
		assert.equal((await savedCollections(page)).filter((item) => !item.deleted_at).length, 1);

		// A collection that is gone says so.
		await page.goto(url('collections/nothing-here'));
		await page.locator('#collection-missing').waitFor(TIMEOUT);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a name is needed, and a rule needs a condition', async () => {
		const {context, page} = await phone();

		await openCollections(page);
		await page.click('#collections-new');
		await page.click('#col-save');
		assert.match(await page.locator('#col-error').textContent(), /needs a name/);
		await page.fill('#col-name', 'Empty rule');
		await page.check('#col-kind-rule');
		await page.click('#col-save');
		assert.match(await page.locator('#col-error').textContent(), /at least one condition/);
		assert.equal((await savedCollections(page)).length, 0);
		await context.close();
	});

	test('the scanner\'s Done sheet adds the whole session to a collection', async () => {
		const {context, errors, page} = await phone();

		const before = await page.evaluate(async () => {
			const {listCards} = await import(`${location.origin}/pokemon-card-tracker/js/collection.js`);

			return (await listCards()).length;
		});

		// The Done sheet with a session of two savable cards and a save that
		// writes them as the scanner does.
		await page.evaluate(async () => {
			const root = `${location.origin}/pokemon-card-tracker/js`;
			const {doneSheet} = await import(`${root}/scan/sheets.js`);
			const {addCard} = await import(`${root}/collection.js`);
			const item = (id, cardId) => ({card: {catalog: 'international', id: cardId}, id, language: 'en', sure: true, variants: [], status: 'done'});
			const session = {items: [item('i1', 'tsa1-001'), item('i2', 'tsb2-090')]};
			const ctx = {
				closeSheet() {},
				openItem() {},
				openSetAll() {},
				owned: new Map(),
				save: async () => {
					for (const one of session.items) {
						await addCard({card_id: one.card.id, catalog: 'international', language: 'en', language_source: 'scan'});
					}
				},
				session,
			};

			document.body.append(doneSheet(ctx).el);
		});
		await page.locator('#scan-all-collection').waitFor(TIMEOUT);
		assert.equal(await page.locator('#scan-all-collection').textContent(), 'Add all to a collection');
		await page.click('#scan-all-collection');
		await page.fill('#scan-collection-name', 'Pull box');
		await page.click('#scan-collection-create');
		await page.waitForFunction(() => document.getElementById('scan-all-collection').textContent === 'In Pull box', null, {polling: 100, ...TIMEOUT});
		await page.screenshot({path: `${SHOTS}/collections-scan-done.png`});
		await page.click('#scan-save-session');
		await page.waitForFunction(() => document.querySelector('.toast') && /2 cards added to Pull box/.test(document.querySelector('.toast').textContent), null, {polling: 100, ...TIMEOUT});

		const [saved] = await savedCollections(page);

		assert.equal(saved.name, 'Pull box');
		assert.equal(Object.keys(saved.entry_ids).length, 2);

		const after = await page.evaluate(async () => {
			const {listCards} = await import(`${location.origin}/pokemon-card-tracker/js/collection.js`);

			return (await listCards()).length;
		});

		assert.equal(after, before + 2);
		assert.deepEqual(errors, []);
		await context.close();
	});
});

// ----------------------------------------------------------- family

async function familyDevice(memberDoc) {
	const fake = new FakeSupabase();
	const owner = fake.addUser('owner@example.test');
	const member = fake.addUser('member-a@example.test');
	const context = await browser.newContext({hasTouch: true, serviceWorkers: 'block', viewport: {height: 844, width: 390}});

	await fakeServices(context, {cards: STAR_CARDS});
	await fakePokeApi(context);
	await fake.attach(context, 'owner');
	await wireCollections(context);
	fake.documents.set(member.id, {doc: {...memberDoc, person: undefined, user_id: undefined}, updated_at: fake.now(), user_id: member.id});
	fake.profiles.set(member.id, {display_name: 'Member A', user_id: member.id});

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err.message));
	await seed(page, server.origin, {binders: [], copies: [], index: indexRecords(STAR_CARDS)});
	await page.goto(url('signin'));
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

describe('A family member\'s collections', () => {
	test('read only: the list, a hand-picked one, and no way to change them', async () => {
		const cards = [star('m-01', 'tsa1-004'), star('m-02', 'tsa1-006'), star('m-03', 'tsb2-025')];
		const picked = {created_at: at(1), deleted_at: null, entry_ids: {'m-01': at(2), 'm-02': at(2)}, id: 'mc-1', kind: 'hand', name: 'Member A favorites', rule: null, updated_at: at(2)};
		const gone = {...picked, deleted_at: at(3), id: 'mc-2', name: 'Deleted one'};
		const {context, errors, member, page} = await familyDevice({...documentWith(cards), collections: [picked, gone]});

		await page.goto(url(`family/${member.id}/collections`));
		await page.locator('.col-row').waitFor(TIMEOUT);
		assert.equal(await page.locator('#collections-new').count(), 0);
		assert.doesNotMatch(await page.locator('main').textContent(), /null/);
		assert.equal(await page.locator('#collections-title').textContent(), 'Member A\'s collections');
		assert.deepEqual((await rows(page)).length, 1);
		assert.match((await rows(page))[0], /^Member A favorites.*Hand-picked.*2 cards/);
		assert.equal(await page.locator('.lists-switch-item.on').textContent(), 'Collections');
		await page.screenshot({path: `${SHOTS}/collections-family.png`});
		await page.click('.col-row');
		await page.locator('.card-grid .tile').first().waitFor(TIMEOUT);
		assert.deepEqual((await tileNames(page)).sort(), ['Charizard ex', 'Charmander']);
		assert.equal(await page.locator('#collection-edit').count(), 0);
		assert.equal(await page.locator('#cards-add-hand').count(), 0);
		await page.locator('#family-strip').waitFor(TIMEOUT);
		assert.deepEqual(errors, []);
		await context.close();
	});
});
