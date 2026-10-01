// Browser tests for the wishlist (js/wishlist.js, js/wishlist-view.js).
// Headless Chromium at 360 x 740, against tests/wishlist-harness.mjs: the
// Pages imitation serving the real app.js, index.html, and sw.js, which
// carry the wishlist's integration lines. A first test asserts that they do.
//
// Every outside service is faked: TCGdex (search, set list, sets, cards,
// images) and Supabase (tests/fake-supabase.mjs). The cards are made up.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/wishlist-browser.test.mjs

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {FakeSupabase, SUPABASE_ORIGIN} from './fake-supabase.mjs';
import {checkIntegration, startHarness} from './wishlist-harness.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const VIEWPORT = {height: 740, width: 360};
const SHOTS = process.env.SHOTS || '/tmp';

let harness;
let browser;

before(async () => {
	harness = await startHarness();
	browser = await chromium.launch();
});

after(async () => {
	await browser.close();
	await harness.close();
});

const url = (path = '') => `${harness.origin}${BASE}${path}`;

// ----------------------------------------------------------- test data

const AT = '2026-09-01T00:00:00.000Z';

const VARIANTS = (n) => [
	{size: 'standard', type: 'normal', variantId: `v-normal-${n}`},
	{size: 'standard', type: 'reverse', variantId: `v-reverse-${n}`},
	{foil: 'pokeball', size: 'standard', type: 'reverse', variantId: `v-pokeball-${n}`},
];

const SET = {cardCount: {official: 3, total: 3}, id: 'tst1', name: 'Test set one'};

const NAMES = {en: ['Test Bulbasaur', 'Test Ivysaur', 'Test Venusaur'], pt: ['Bulbasaur Teste', 'Ivysaur Teste', 'Venusaur Teste']};

const image = (lang, n) => `https://assets.tcgdex.net/${lang}/tst/tst1/00${n}`;

const card = (lang, n) => ({
	id: `tst1-00${n}`,
	image: image(lang, n),
	localId: `00${n}`,
	name: NAMES[lang][n - 1],
	set: SET,
	variants_detailed: VARIANTS(n),
});

const brief = (lang, n) => ({id: `tst1-00${n}`, image: image(lang, n), localId: `00${n}`, name: NAMES[lang][n - 1]});

// A TCG Pocket card, which the search leaves out.
const POCKET = {id: 'A1-001', image: 'https://assets.tcgdex.net/en/tcgp/A1/001', localId: '001', name: 'Test Bulbasaur'};

const entry = (id, fields) => ({catalog: 'international', created_at: AT, deleted_at: null, id, language: 'pt', language_source: 'import', updated_at: AT, variant_id: null, ...fields});

// The viewer's cards: two Portuguese Ivysaur (one spare) and one Venusaur.
const CARDS = [
	entry('c1', {card_id: 'tst1-002'}),
	entry('c2', {card_id: 'tst1-002', variant_id: 'v-reverse-2'}),
	entry('c3', {card_id: 'tst1-003'}),
];

const documentWith = (cards, wishlist = []) => ({binders: [], cards, collections: [], goals: [], openings: [], person: 'local', updated_at: AT, user_id: null, version: 1, wishlist});

const wish = (id, cardId, fields = {}) => ({card_id: cardId, catalog: 'international', created_at: AT, deleted_at: null, id, language: null, note: '', priority: 'normal', updated_at: AT, variant_id: null, ...fields});

// Member B's wishlist: Ivysaur in PT (the viewer has a spare), Venusaur in any
// language (the viewer has one copy, no spare), and a removed item.
const BIA_WISHLIST = [
	wish('b1', 'tst1-002', {language: 'pt', note: 'For my binder', priority: 'high'}),
	wish('b2', 'tst1-003'),
	wish('b3', 'tst1-001', {deleted_at: AT}),
];

// A 1 x 1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

function tcgdex(pathname, search) {
	const [lang, ...rest] = pathname.replace('/v2/', '').split('/');
	const path = rest.join('/');

	if (path === 'series') {
		return [{id: 'tst', name: 'Test series'}];
	}

	if (path === 'series/tst') {
		return {id: 'tst', name: 'Test series', releaseDate: '2026-01-01', sets: [SET]};
	}

	if (path === 'sets') {
		return [{id: 'tst1'}];
	}

	if (path === 'sets/tst1') {
		return {...SET, cards: [1, 2, 3].map((n) => brief(lang, n))};
	}

	if (path === 'cards' && NAMES[lang]) {
		const name = (search.get('name') || '').toLowerCase();
		const localId = search.get('localId');
		const found = [1, 2, 3].map((n) => brief(lang, n)).filter((item) => item.name.toLowerCase().includes(name) && (!localId || item.localId.includes(localId)));

		return lang === 'en' && 'test bulbasaur'.includes(name) ? [...found, POCKET] : found;
	}

	const single = /^cards\/tst1-00([123])$/.exec(path);

	if (single && NAMES[lang]) {
		return card(lang, Number(single[1]));
	}

	return null;
}

async function device(fake, name) {
	const context = await browser.newContext({serviceWorkers: 'allow', viewport: VIEWPORT});
	const counts = {cards: 0, search: 0};
	const net = {offline: false};

	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());

	await context.route('https://api.tcgdex.net/**', (route) => {
		const {pathname, searchParams} = new URL(route.request().url());

		if (pathname.endsWith('/cards')) {
			counts.search++;
		}
		else if (pathname.includes('/cards/')) {
			counts.cards++;
		}

		if (net.offline) {
			return route.abort('internetdisconnected');
		}

		const data = tcgdex(pathname, searchParams);

		return data
			? route.fulfill({body: JSON.stringify(data), contentType: 'application/json', status: 200})
			: route.fulfill({body: '{}', contentType: 'application/json', status: 404});
	});

	await context.route('https://assets.tcgdex.net/**', (route) => (net.offline
		? route.abort('internetdisconnected')
		: route.fulfill({body: PNG, contentType: 'image/png', status: 200})));

	await fake.attach(context, name);

	// Offline, the fake project is out of reach too.
	await context.route(`${SUPABASE_ORIGIN}/**`, (route) => (net.offline ? route.abort('internetdisconnected') : route.fallback()));

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err));

	return {context, counts, errors, net, page};
}

async function seedLocal(page, doc) {
	await page.goto(url('cards'));
	await page.evaluate(async (stored) => {
		await new Promise((resolve, reject) => {
			const open = indexedDB.open('card-tracker-collection', 1);

			open.onupgradeneeded = () => open.result.createObjectStore('documents');
			open.onsuccess = () => {
				const tx = open.result.transaction('documents', 'readwrite');

				tx.objectStore('documents').put(stored, 'local');
				tx.oncomplete = () => {
					open.result.close();
					resolve();
				};
				tx.onerror = () => reject(tx.error);
			};
			open.onerror = () => reject(open.error);
		});
	}, doc);
	await page.reload();
}

const localDoc = (page) => page.evaluate(async () => (await import('/pokemon-card-tracker/js/collection.js')).loadDocument());

const liveWishes = async (page) => (await localDoc(page)).wishlist.filter((item) => !item.deleted_at);

const shownErrors = (page) => page.locator('#errors .error').allTextContents();

async function signIn(page, fake, email) {
	await page.goto(url('signin'));
	await page.fill('#signin-email', email);
	await page.click('button:has-text("Send link")');
	await page.waitForSelector('#check-email');

	const code = fake.issueCode(email);

	await page.goto(`${url()}?code=${code}`);
	await page.waitForSelector('#account.avatar');
}

async function waitForStatus(page, text) {
	await page.waitForFunction((expected) => {
		const line = document.getElementById('sync-status');

		return line && !line.hidden && line.textContent === expected;
	}, text, {timeout: 15000});
}

async function until(check, timeout = 15000) {
	const end = Date.now() + timeout;

	while (!(await check())) {
		if (Date.now() > end) {
			throw new Error('Timed out waiting.');
		}

		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}

const summary = (page) => page.locator('#wishlist-summary').textContent();

async function waitForSummary(page, text) {
	try {
		await page.waitForFunction((expected) => {
			const line = document.getElementById('wishlist-summary');

			return line && !line.hidden && line.textContent === expected && !document.querySelector('.wl-item.wl-loading');
		}, text, {timeout: 15000});
	}
	catch (err) {
		const shown = await page.evaluate(() => ({
			errors: document.getElementById('errors').textContent,
			loading: document.querySelectorAll('.wl-item.wl-loading').length,
			summary: (document.getElementById('wishlist-summary') || {}).textContent,
			view: document.getElementById('view').textContent.slice(0, 300),
		})).catch(() => null);

		err.message += ` Expected "${text}", shown ${JSON.stringify(shown)}`;

		throw err;
	}
}

const item = (page, name) => page.locator('.wl-item', {has: page.locator('.wl-name', {hasText: name})});

async function search(page, text, lang = 'en') {
	await page.selectOption('#wishlist-search-lang', lang);
	await page.fill('#wishlist-search', text);
	await page.click('#wishlist-search-go');
	await page.waitForFunction(() => {
		const status = document.getElementById('wishlist-search-status');

		return status && status.textContent && status.textContent !== 'Searching.';
	});
}

async function addFromResults(page, cardId, {finish = null, language = null, note = null, priority = null} = {}) {
	await page.click(`.wl-result[data-card="${cardId}"]`);
	await page.waitForSelector('#wishlist-editor');

	if (language) {
		await page.selectOption('#wish-language', language);
	}

	if (finish) {
		await page.selectOption('#wish-finish', {label: finish});
	}

	if (priority) {
		await page.click(`#wish-priority label:has-text("${priority}")`);
	}

	if (note) {
		await page.fill('#wish-note', note);
	}

	await page.click('#wish-save');
	await page.waitForSelector('#wishlist-editor', {state: 'detached'});
}

// ----------------------------------------------------------------- tests

describe('wishlist', () => {
	test('app.js, index.html, and sw.js carry the wishlist\'s integration lines', async () => {
		await checkIntegration();
	});

	test('add, edit, own, view a family member\'s with a spare, reload, and reopen offline', async () => {
		const fake = new FakeSupabase();
		const eric = fake.addUser('eric@example.test');
		const bia = fake.addUser('bia@example.test');
		const {context, counts, errors, net, page} = await device(fake, 'eric');

		await seedLocal(page, documentWith(CARDS));
		await signIn(page, fake, eric.email);
		await waitForStatus(page, 'Synced');

		// Member B is in Eric's family, with a wishlist on the server.
		fake.members.push({group_id: fake.groups[0].id, role: 'member', user_id: bia.id});
		fake.profiles.set(bia.id, {display_name: 'Member B', user_id: bia.id});
		fake.documents.set(bia.id, {doc: documentWith([], BIA_WISHLIST), updated_at: fake.now(), user_id: bia.id});

		// The menu entry opens the empty wishlist.
		await page.click('#menu summary');
		await page.click('#menu a[data-link="wishlist"]');
		await page.waitForSelector('#wishlist-empty:not([hidden])');
		assert.equal(new URL(page.url()).pathname, `${BASE}wishlist`);
		assert.equal(await page.title(), 'Wishlist | Card Tracker');
		assert.match(await page.locator('#wishlist-empty').textContent(), /Your wishlist is empty/);
		await page.screenshot({path: `${SHOTS}/wishlist-empty.png`});

		// Search by name: three cards, the TCG Pocket card left out, set names
		// from the set list.
		await page.click('#wishlist-add');
		await search(page, 'test');
		assert.equal(await page.locator('.wl-result').count(), 3);
		assert.equal(await page.locator('.wl-result[data-card="A1-001"]').count(), 0, 'no TCG Pocket cards');
		assert.match(await page.locator('#wishlist-search-status').textContent(), /^3 cards\. Tap one to add it\.$/);
		await page.waitForFunction(() => /Test set one/.test(document.querySelector('.wl-result .tile-meta').textContent));
		await page.screenshot({path: `${SHOTS}/wishlist-search.png`});

		// A number alone asks for more.
		await search(page, '3');
		assert.match(await page.locator('#wishlist-search-status').textContent(), /Add the name or the set total/);

		// One: Bulbasaur, English, reverse holo, high, with a note. The finish
		// list is the card's own finishes.
		await search(page, 'bulba');
		await page.click('.wl-result[data-card="tst1-001"]');
		await page.waitForSelector('#wishlist-editor');
		assert.deepEqual(await page.locator('#wish-finish option').allTextContents(), ['Any finish', 'Normal', 'Reverse holo', 'Reverse holo, Poké Ball pattern']);
		assert.deepEqual(await page.locator('#wish-language option').allTextContents(), ['Any language', 'English', 'Portuguese', 'French']);
		await page.screenshot({path: `${SHOTS}/wishlist-editor.png`});
		await page.click('#wish-cancel');
		await addFromResults(page, 'tst1-001', {finish: 'Reverse holo', language: 'en', note: 'For the binder', priority: 'High'});
		assert.match(await page.locator('#wishlist-flash').textContent(), /Added Test Bulbasaur/);

		// Two: Ivysaur, any language and finish.
		await search(page, 'ivy');
		await addFromResults(page, 'tst1-002');

		// Three: Venusaur by number and set total, in Portuguese.
		await search(page, '3/3', 'pt');
		assert.deepEqual(await page.locator('.wl-result').evaluateAll((tiles) => tiles.map((tile) => tile.dataset.card)), ['tst1-003']);
		await addFromResults(page, 'tst1-003', {language: 'pt'});

		// Already wanted cards are marked in the results.
		await search(page, 'test');
		assert.equal(await page.locator('.wl-result.wl-on').count(), 3);
		await page.click('#wishlist-add');

		await waitForSummary(page, '3 cards wanted. You have 2 of them now.');
		// An item with no language shows in the viewing language (English).
		assert.deepEqual(await page.locator('.wl-name').allTextContents(), ['Test Bulbasaur', 'Venusaur Teste', 'Test Ivysaur'], 'high first, then newest');
		assert.match(await item(page, 'Test Bulbasaur').textContent(), /High priority.*EN.*Reverse holo.*For the binder/);
		assert.match(await item(page, 'Test Bulbasaur').locator('.wl-meta').textContent(), /#001 \/ 3 · Test set one/);
		await item(page, 'Test Bulbasaur').locator('img').waitFor();

		let wishes = await liveWishes(page);

		assert.equal(wishes.length, 3);

		const bulba = wishes.find((wanted) => wanted.card_id === 'tst1-001');

		assert.deepEqual({language: bulba.language, note: bulba.note, priority: bulba.priority, variant: bulba.variant_id}, {language: 'en', note: 'For the binder', priority: 'high', variant: 'v-reverse-1'});
		assert.ok(bulba.id && bulba.updated_at && bulba.deleted_at === null && bulba.catalog === 'international');
		assert.equal(wishes.find((wanted) => wanted.card_id === 'tst1-003').language, 'pt');

		// Owned already: Ivysaur (any) and Venusaur (PT), from the seeded cards.
		assert.match(await item(page, 'Test Ivysaur').locator('.wl-owned').textContent(), /You have this now \(2 copies\)/);
		assert.match(await item(page, 'Venusaur Teste').locator('.wl-owned').textContent(), /You have this now/);
		assert.equal(await item(page, 'Test Bulbasaur').locator('.wl-owned').count(), 0);
		await page.screenshot({fullPage: true, path: `${SHOTS}/wishlist-three.png`});

		// Edit Ivysaur: low priority and a note.
		await item(page, 'Test Ivysaur').locator('.wl-edit').click();
		await page.waitForSelector('#wishlist-editor');
		assert.ok(await page.locator('#wish-priority input[value="normal"]').isChecked());
		await page.click('#wish-priority label:has-text("Low")');
		await page.fill('#wish-note', 'Only if cheap');
		await page.click('#wish-save');
		await page.waitForSelector('#wishlist-editor', {state: 'detached'});
		await page.waitForFunction(() => /Only if cheap/.test(document.getElementById('wishlist-items').textContent));
		assert.deepEqual(await page.locator('.wl-name').allTextContents(), ['Test Bulbasaur', 'Venusaur Teste', 'Test Ivysaur'], 'low stays last');
		assert.match(await item(page, 'Test Ivysaur').textContent(), /Low priority/);
		wishes = await liveWishes(page);

		const ivy = wishes.find((wanted) => wanted.card_id === 'tst1-002');

		assert.equal(ivy.priority, 'low');
		assert.equal(ivy.note, 'Only if cheap');
		assert.ok(ivy.updated_at > ivy.created_at, 'a newer stamp');

		// Mark Bulbasaur owned: a PT copy does not count (the item asks for
		// English), an English reverse holo does.
		const addCopy = (fields) => page.evaluate(async (copy) => {
			const collection = await import('/pokemon-card-tracker/js/collection.js');

			await collection.addCard(copy);
		}, fields);

		await addCopy({card_id: 'tst1-001', catalog: 'international', language: 'pt', variant_id: 'v-reverse-1'});
		await waitForSummary(page, '3 cards wanted. You have 2 of them now.');
		assert.equal(await item(page, 'Test Bulbasaur').locator('.wl-owned').count(), 0, 'wrong language');
		await addCopy({card_id: 'tst1-001', catalog: 'international', language: 'en', variant_id: 'v-reverse-1'});
		await waitForSummary(page, '3 cards wanted. You have 3 of them now.');
		assert.match(await item(page, 'Test Bulbasaur').locator('.wl-owned').textContent(), /You have this now/);
		await page.screenshot({path: `${SHOTS}/wishlist-owned.png`});

		// One tap removes it, softly.
		await item(page, 'Test Bulbasaur').locator('.wl-owned-remove').click();
		await waitForSummary(page, '2 cards wanted. You have 2 of them now.');
		assert.match(await page.locator('#wishlist-flash').textContent(), /Removed Test Bulbasaur/);

		const all = (await localDoc(page)).wishlist;

		assert.equal(all.length, 3, 'the removed item stays as a tombstone');
		assert.ok(all.find((wanted) => wanted.card_id === 'tst1-001').deleted_at);

		// Everything reached the server.
		await waitForStatus(page, 'Synced');

		const pushed = () => ((fake.documents.get(eric.id) || {}).doc || {}).wishlist || [];

		await until(() => pushed().length === 3 && pushed().some((wanted) => wanted.deleted_at) && pushed().some((wanted) => wanted.note === 'Only if cheap'));

		// Reload: the same list, from the phone.
		await page.reload();
		await waitForSummary(page, '2 cards wanted. You have 2 of them now.');
		assert.deepEqual(await page.locator('.wl-name').allTextContents(), ['Venusaur Teste', 'Test Ivysaur']);

		// Member B's wishlist, from the switcher: read only, with Eric's spares.
		await page.waitForSelector('#wishlist-family-switcher');
		await page.selectOption('#wishlist-family-switcher', bia.id);
		await page.waitForSelector('.view-only');
		assert.equal(new URL(page.url()).pathname, `${BASE}wishlist/${bia.id}`);
		await waitForSummary(page, '2 cards wanted. You have spares of 1.');
		assert.match(await page.locator('.view-only').textContent(), /Member B's wishlist, view only/);
		assert.equal(await page.locator('#wishlist-title').textContent(), 'Member B\'s wishlist');
		assert.equal(await page.title(), 'Member B\'s wishlist | Card Tracker');
		assert.deepEqual(await page.locator('.wl-name').allTextContents(), ['Ivysaur Teste', 'Test Venusaur'], 'the removed item is not shown');
		assert.equal(await item(page, 'Ivysaur Teste').locator('.wl-spare').textContent(), 'You have 1 spare');
		assert.equal(await item(page, 'Test Venusaur').locator('.wl-spare').count(), 0, 'one copy is a keeper');
		assert.match(await item(page, 'Ivysaur Teste').textContent(), /High priority.*PT.*For my binder/);
		assert.equal(await page.locator('#wishlist-add, .wl-edit, .wl-owned-remove').count(), 0, 'nothing to edit');
		assert.equal(await page.locator('#wishlist-saved-note').isHidden(), true, 'read from the server');
		await page.screenshot({fullPage: true, path: `${SHOTS}/wishlist-family.png`});

		// Viewing changed nothing for Member B.
		assert.equal(fake.documents.get(bia.id).doc.wishlist.length, 3);

		// Reload the family view.
		await page.reload();
		await waitForSummary(page, '2 cards wanted. You have spares of 1.');

		// The scanner's matching, against the family wishlists on the phone.
		const matches = (cardId, scan) => page.evaluate(async ([id, options]) => {
			const wishlist = await import('/pokemon-card-tracker/js/wishlist.js');

			return wishlist.wishedBy(id, options, await wishlist.familyWishlists()).map((row) => `${row.name}:${row.item.id}:${row.unconfirmed.join('+')}`);
		}, [cardId, scan]);

		assert.deepEqual(await matches('tst1-002', {language: 'pt'}), ['Member B:b1:']);
		assert.deepEqual(await matches('tst1-002', {language: 'en'}), []);
		assert.deepEqual(await matches('tst1-002', {}), ['Member B:b1:language']);
		assert.deepEqual(await matches('tst1-001', {language: 'en'}), [], 'a removed item');

		// Offline: the app opens from the service worker, and both lists come
		// from the phone.
		await page.waitForFunction(async () => {
			for (const key of (await caches.keys()).filter((name) => name.startsWith('card-tracker-shell-'))) {
				const paths = (await (await caches.open(key)).keys()).map((request) => new URL(request.url).pathname);

				if (['js/wishlist-view.js', 'js/wishlist.js', 'css/wishlist.css'].every((file) => paths.includes(`/pokemon-card-tracker/${file}`))) {
					return true;
				}
			}

			return false;
		}, null, {timeout: 15000});

		const familyUrl = page.url();
		const before = {...counts};

		net.offline = true;
		await context.setOffline(true);
		await page.goto(url('wishlist'));
		await waitForSummary(page, '2 cards wanted. You have 2 of them now.');
		assert.deepEqual(await page.locator('.wl-name').allTextContents(), ['Venusaur Teste', 'Test Ivysaur']);
		assert.match(await item(page, 'Test Ivysaur').textContent(), /Only if cheap/);
		await page.screenshot({fullPage: true, path: `${SHOTS}/wishlist-offline.png`});

		await page.goto(familyUrl);
		await waitForSummary(page, '2 cards wanted. You have spares of 1.');
		assert.equal(await item(page, 'Ivysaur Teste').locator('.wl-spare').textContent(), 'You have 1 spare');
		assert.match(await page.locator('#wishlist-saved-note').textContent(), /^Saved on this phone .+\. Connect to see changes since\.$/);
		assert.match(await page.locator('.view-only').textContent(), /Member B's wishlist, view only/);
		await page.waitForSelector('#wishlist-family-switcher');
		assert.equal(await page.locator('#wishlist-family-switcher').inputValue(), bia.id, 'the switcher works offline');
		await page.screenshot({fullPage: true, path: `${SHOTS}/wishlist-family-offline.png`});
		assert.deepEqual(await matches('tst1-002', {language: 'pt'}), ['Member B:b1:'], 'matching works offline');

		// An edit offline is kept on the phone.
		await page.goto(url('wishlist'));
		await waitForSummary(page, '2 cards wanted. You have 2 of them now.');
		await item(page, 'Venusaur Teste').locator('.wl-edit').click();
		await page.click('#wish-priority label:has-text("High")');
		await page.click('#wish-save');
		await page.waitForSelector('#wishlist-editor', {state: 'detached'});
		await page.waitForFunction(() => /High priority/.test(document.getElementById('wishlist-items').textContent));
		assert.deepEqual(counts, before, 'nothing reached TCGdex offline');

		// Back online, the offline edit is pushed.
		net.offline = false;
		await context.setOffline(false);
		await page.evaluate(async () => (await import('/pokemon-card-tracker/js/sync.js')).syncNow());
		await until(() => pushed().some((wanted) => wanted.card_id === 'tst1-003' && wanted.priority === 'high'));

		// Existing views still open.
		await page.click('.tabs a[data-tab="cards"]');
		await page.waitForSelector('#cards-summary');
		await page.click('.tabs a[data-tab="lists"]');
		await page.waitForSelector('#add-list');

		assert.deepEqual(await shownErrors(page), []);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('signed out, a wishlist works on the phone and a family wishlist asks for sign-in', async () => {
		const fake = new FakeSupabase();
		const {context, errors, page} = await device(fake, 'phone');

		await seedLocal(page, documentWith([], [wish('w1', 'tst1-001', {priority: 'low'})]));
		await page.goto(url('wishlist'));
		await waitForSummary(page, '1 card wanted.');
		assert.equal(await page.locator('#wishlist-family-switcher').count(), 0);
		await page.goto(url('wishlist/someone'));
		await page.waitForSelector('.notice');
		assert.match(await page.locator('.notice').textContent(), /Sign in to see your family's wishlists/);
		assert.deepEqual(errors, []);
		assert.equal(fake.log.filter((request) => request.path.startsWith('/rest/')).length, 0, 'no data requests signed out');
		await context.close();
	});
});
