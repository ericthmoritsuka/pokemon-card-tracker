// How fast the app starts and moves on a slow phone: headless Chromium at
// 360 x 740 with the CPU slowed six times (CDP Emulation.setCPUThrottlingRate),
// a signed-in account with 1,600 copies, binders, lists, moves, and the
// service worker installed. Every outside request is faked: Supabase by
// tests/fake-supabase.mjs, TCGdex by made-up sets plus the recorded answers
// in tests/tcgdex-fixtures.json, the rates and PokeAPI by their test fakes,
// and Chromium resolves no other host at all.
//
// Run:
//   PLAYWRIGHT=/path/to/node_modules/playwright node lab/perf/startup-bench.mjs \
//     --tree base=/path/to/old/checkout --tree branch=. [--runs 5] [--profile] [--out dir]
//
// Each tree is served from its own copy of tests/pages-server.mjs. A profile
// is made once per tree (seed, sign in, the first sync, the background pass
// that saves every card's record, the service worker installed); each run
// starts a fresh browser from a copy of it, so every run is a cold start of
// an installed app. Runs take the trees in turn, each run starting with the
// next, so a machine loaded by other work slows each alike. --profile adds
// one run per tree with the CDP sampling profiler and prints the functions
// that took the main thread; --trace adds one traced cold start per tree,
// its main thread's time to the first tile by kind of work.

import {cp, mkdtemp, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const HERE = new URL('../../', import.meta.url);
const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const {FakeSupabase} = await import(new URL('tests/fake-supabase.mjs', HERE));
const {fakeRates} = await import(new URL('tests/fake-rates.mjs', HERE));
const {fakePokeApi} = await import(new URL('tests/fake-pokeapi.mjs', HERE));
const FIXTURES = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('tests/tcgdex-fixtures.json', HERE), 'utf8'));

const BASE = '/pokemon-card-tracker/';
const VIEWPORT = {height: 740, width: 360};
const THROTTLE = 6;

// ------------------------------------------------------------- arguments

const args = process.argv.slice(2);
const trees = [];
let runs = 5;
let profile = false;
let trace = false;
let out = null;

for (let i = 0; i < args.length; i++) {
	if (args[i] === '--tree') {
		const [name, path] = args[++i].split('=');

		trees.push({name, root: resolve(path)});
	}
	else if (args[i] === '--runs') {
		runs = Number(args[++i]);
	}
	else if (args[i] === '--profile') {
		profile = true;
	}
	else if (args[i] === '--trace') {
		trace = true;
	}
	else if (args[i] === '--out') {
		out = resolve(args[++i]);
	}
}

if (!trees.length) {
	trees.push({name: 'here', root: resolve(new URL('.', HERE).pathname)});
}

// ------------------------------------------------------------- the data

const SETS = Array.from({length: 10}, (_, i) => `tst${i + 1}`);
const TILES = 1200;
const COPIES = 1600;
const START = Date.parse('2026-08-01T00:00:00.000Z');
const PLACES = ['Box A', 'Box B', 'Deck box'];
const FINISHES = ['normal', 'reverse', 'holo'];

const tileOf = (t) => ({card_id: `${SETS[t % SETS.length]}-${String(Math.floor(t / SETS.length) + 1).padStart(3, '0')}`, language: t % 4 === 0 ? 'pt' : 'en'});

// 1,600 copies on 1,200 tiles (card and language), some stored, some
// favorites, some with notes, plus tombstones of copies that left with a move.
function makeDocument() {
	const cards = [];

	for (let i = 0; i < COPIES; i++) {
		const t = i < TILES ? i : (i * 7) % TILES;
		const at = new Date(START + i * 3600000).toISOString();

		cards.push({
			...tileOf(t),
			catalog: 'international',
			created_at: at,
			deleted_at: null,
			id: `e-${String(i).padStart(5, '0')}`,
			import_key: `${100000 + i}|pt|${FINISHES[t % 3].toUpperCase()}|1`,
			is_favorite: i % 50 === 0 ? true : undefined,
			language_source: 'import',
			notes: i % 40 === 0 ? `A note on copy ${i}` : undefined,
			storage: i % 3 === 0 ? PLACES[i % PLACES.length] : undefined,
			updated_at: at,
			variant_id: FINISHES[t % 3],
		});
	}

	const moves = [];

	for (let m = 0; m < 20; m++) {
		const at = new Date(START + (COPIES + m) * 3600000).toISOString();
		const out = [`gone-${m}-a`, `gone-${m}-b`];

		for (const id of out) {
			cards.push({...tileOf(m * 13), catalog: 'international', created_at: at, deleted_at: at, id, language_source: 'manual', left_via: `move-${m}`, updated_at: at, variant_id: 'normal'});
		}

		moves.push({created_at: at, currency: 'BRL', date: at.slice(0, 10), deleted_at: null, id: `move-${m}`, in: [], kind: m % 2 ? 'sold' : 'traded', money: 'in', note: '', out, price: 10 + m, updated_at: at, who: m % 2 ? 'Ana' : 'Bruno'});
	}

	const at = new Date(START).toISOString();
	const binder = (id, name, rows, cols, pages, first, count) => ({
		cols,
		created_at: at,
		deleted_at: null,
		id,
		name,
		page_count: pages,
		rows,
		slots: Array.from({length: count}, (_, n) => ({
			entry_id: `e-${String(first + n).padStart(5, '0')}`,
			page: Math.floor(n / (rows * cols)) + 1,
			placed_at: at,
			position: (n % (rows * cols)) + 1,
		})),
		updated_at: at,
	});
	const list = (id, kind, name, target, extra = {}) => ({created_at: at, deleted_at: null, dex_list: null, hand_ticks: {}, id, kind, level: null, name, target, updated_at: at, ...extra});

	return {
		binders: [
			binder('binder-big', 'Big binder', 3, 3, 10, 0, 90),
			binder('binder-trade', 'Trade binder', 3, 4, 20, 200, 150),
			binder('binder-small', 'Small binder', 2, 2, 5, 500, 12),
		],
		cards,
		collections: [],
		goals: [
			list('list-kanto', 'region', 'Kanto', 'kanto'),
			list('list-johto', 'region', 'Johto', 'johto'),
			list('list-all', 'every_pokemon', 'Every Pokémon', null),
			{catalog: 'international', created_at: at, deleted_at: null, id: 'goal-set', kind: 'set', level: 'numbered', name: 'Test set tst1', target: 'tst1', updated_at: at},
		],
		moves,
		openings: [],
		person: 'local',
		storage_places: PLACES.map((name, i) => ({created_at: at, deleted_at: null, id: `place-${i}`, name, updated_at: at})),
		updated_at: at,
		user_id: null,
		version: 1,
		wishlist: Array.from({length: 10}, (_, i) => ({card_id: `tst${i + 1}-150`, created_at: at, deleted_at: null, id: `wish-${i}`, language: 'en', updated_at: at})),
	};
}

// ------------------------------------------------------------- the fakes

const TEMPLATE = FIXTURES['GET /v2/en/cards/base1-4'].body;
const TYPES = ['Fire', 'Water', 'Grass', 'Lightning', 'Psychic'];
const RARITIES = ['Common', 'Uncommon', 'Rare', 'Double rare'];
const json = (route, body, status = 200) => route.fulfill({body: JSON.stringify(body), contentType: 'application/json', status});

let tcgdexRequests = 0;

async function fakeTcgdex(context) {
	await context.route('https://api.tcgdex.net/**', async (route) => {
		const request = route.request();
		const {pathname, search} = new URL(request.url());

		tcgdexRequests++;

		let match = /^\/v2\/(\w+)\/sets\/(tst\d+)$/.exec(pathname);

		if (match) {
			const [, lang, setId] = match;

			return json(route, {
				cardCount: {official: 160, total: 160},
				cards: Array.from({length: 160}, (_, i) => {
					const localId = String(i + 1).padStart(3, '0');

					return {id: `${setId}-${localId}`, image: null, localId, name: `${lang === 'pt' ? 'Carta' : 'Test card'} ${setId} ${localId}`};
				}),
				id: setId,
				name: `Test set ${setId}`,
				releaseDate: `2026-0${(Number(setId.slice(3)) % 9) + 1}-01`,
			});
		}

		match = /^\/v2\/(\w+)\/cards\/(tst\d+)-(\d+)$/.exec(pathname);

		if (match) {
			const [, lang, setId, localId] = match;
			const n = Number(localId);

			return json(route, {
				...structuredClone(TEMPLATE),
				id: `${setId}-${localId}`,
				image: null,
				localId,
				name: `${lang === 'pt' ? 'Carta' : 'Test card'} ${setId} ${localId}`,
				rarity: RARITIES[n % RARITIES.length],
				set: {cardCount: {official: 160, total: 160}, id: setId, logo: null, name: `Test set ${setId}`},
			});
		}

		if (request.method() === 'POST' && pathname === '/v2/graphql') {
			const set = /id: \\?"(tst\d+)-/.exec(request.postData() || '');

			if (set) {
				return json(route, {data: {cards: Array.from({length: 160}, (_, i) => ({
					category: i % 10 === 9 ? 'Trainer' : 'Pokemon',
					dexId: i % 10 === 9 ? null : [((Number(set[1].slice(3)) * 160 + i) % 1025) + 1],
					id: `${set[1]}-${String(i + 1).padStart(3, '0')}`,
					illustrator: `Artist ${i % 12}`,
					rarity: RARITIES[i % RARITIES.length],
					types: i % 10 === 9 ? null : [TYPES[i % TYPES.length]],
				}))}});
			}
		}

		const key = `${request.method()} ${pathname}${search}${request.method() === 'POST' ? ` ${request.postData() || ''}` : ''}`;
		const hit = FIXTURES[key];

		return hit ? json(route, hit.body, hit.status) : json(route, {}, 404);
	});
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await context.route('https://raw.githubusercontent.com/**', (route) => route.fulfill({status: 404}));
}

// ------------------------------------------------------------- browser

const launch = (dir) => chromium.launchPersistentContext(dir, {
	// Nothing leaves the machine: a host the routes do not answer fails.
	args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'],
	serviceWorkers: 'allow',
	viewport: VIEWPORT,
});

async function attach(context, fake) {
	await fakeRates(context);
	await fakePokeApi(context);
	await fakeTcgdex(context);
	await fake.attach(context, 'phone');
}

// Long tasks and the first painted tile, from the first script on.
const OBSERVE = () => {
	window.__lt = [];

	try {
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				window.__lt.push([entry.startTime, entry.duration]);
			}
		}).observe({buffered: true, type: 'longtask'});
	}
	catch {
		// No long tasks then.
	}

	const seen = new MutationObserver(() => {
		if (window.__tileDom || !document.querySelector('.card-grid .tile')) {
			return;
		}

		window.__tileDom = performance.now();
		seen.disconnect();
		requestAnimationFrame(() => setTimeout(() => {
			window.__tilePaint = performance.now();
		}, 0));
	});

	document.addEventListener('DOMContentLoaded', () => seen.observe(document.body, {childList: true, subtree: true}));
};

// Long tasks between two page times: count, total, and the time over 50 ms
// (total blocking time).
async function tasksBetween(page, from, to = Infinity) {
	const list = await page.evaluate(() => window.__lt || []);
	const inside = list.filter(([start]) => start >= from && start < to);

	return {
		blocking: Math.round(inside.reduce((sum, [, d]) => sum + Math.max(0, d - 50), 0)),
		count: inside.length,
		longest: Math.round(Math.max(0, ...inside.map(([, d]) => d))),
		total: Math.round(inside.reduce((sum, [, d]) => sum + d, 0)),
	};
}

const now = (page) => page.evaluate(() => performance.now());

const domNodes = (page) => page.evaluate(() => document.getElementsByTagName('*').length);

// Clicks `click` inside the page and resolves with the ms until `ready`
// shows and the frame after it is painted.
function timeTo(page, click, ready, {timeout = 60000} = {}) {
	return page.evaluate(async ({click, ready, timeout}) => {
		const target = document.querySelector(click);

		if (!target) {
			throw new Error(`Nothing to click: ${click}`);
		}

		const start = performance.now();
		const painted = () => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 0)));

		target.click();

		await new Promise((done, fail) => {
			const check = () => {
				if (document.querySelector(ready)) {
					observer.disconnect();
					done();

					return true;
				}

				if (performance.now() - start > timeout) {
					observer.disconnect();
					fail(new Error(`Timed out waiting for ${ready}`));

					return true;
				}

				return false;
			};
			const observer = new MutationObserver(check);

			observer.observe(document.body, {attributes: true, childList: true, subtree: true});
			check();
			setTimeout(check, timeout + 10);
		});
		await painted();

		return {at: start, ms: performance.now() - start};
	}, {click, ready, timeout});
}

// Waits until the page has had no long task for `quiet` ms.
async function settle(page, quiet = 1500, limit = 30000) {
	await page.evaluate(async ({quiet, limit}) => {
		const start = performance.now();

		for (;;) {
			await new Promise((done) => setTimeout(done, 250));

			const last = (window.__lt || []).reduce((max, [s, d]) => Math.max(max, s + d), 0);

			if (performance.now() - Math.max(last, start) > quiet || performance.now() - start > limit) {
				return;
			}
		}
	}, {limit, quiet});
}

// ------------------------------------------------------------- setup

async function setUp(tree) {
	const {startPagesServer} = await import(pathToFileURL(join(tree.root, 'tests/pages-server.mjs')));
	const server = await startPagesServer();
	const fake = new FakeSupabase();
	const owner = fake.addUser('owner@example.test');
	const dir = await mkdtemp(join(tmpdir(), `perf-${tree.name}-`));
	const context = await launch(dir);
	const url = (path = '') => `${server.origin}${BASE}${path}`;

	await attach(context, fake);

	const page = context.pages()[0] || await context.newPage();

	await page.goto(url('cards'));
	await page.evaluate(async (stored) => {
		await new Promise((done, fail) => {
			const open = indexedDB.open('card-tracker-collection', 1);

			open.onupgradeneeded = () => open.result.createObjectStore('documents');
			open.onsuccess = () => {
				const tx = open.result.transaction('documents', 'readwrite');

				tx.objectStore('documents').put(stored, 'local');
				tx.oncomplete = () => {
					open.result.close();
					done();
				};
				tx.onerror = () => fail(tx.error);
			};
			open.onerror = () => fail(open.error);
		});
	}, makeDocument());
	await page.reload();
	await page.waitForSelector('.tile', {timeout: 120000});

	// Sign in by the email link.
	await page.goto(url('signin'));
	await page.fill('#signin-email', owner.email);
	await page.click('button:has-text("Send link")');
	await page.waitForSelector('#check-email');
	await page.goto(`${url()}?code=${fake.issueCode(owner.email)}`);
	await page.waitForSelector('#account.avatar');
	await page.waitForFunction(() => document.getElementById('sync-status').textContent === 'Synced', null, {timeout: 120000});

	// The background pass: every set's details and every card's record.
	for (let quiet = 0, last = -1; quiet < 4;) {
		await page.waitForTimeout(1500);
		quiet = tcgdexRequests === last ? quiet + 1 : 0;
		last = tcgdexRequests;
	}

	await page.evaluate(() => navigator.serviceWorker.ready);
	await page.reload();
	await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
	await page.waitForSelector('.tile');
	await page.waitForTimeout(3000);
	await context.close();

	return {dir, fake, owner, server, url};
}

// ------------------------------------------------------------- one run

async function measure(tree, setup, {profiled = false} = {}) {
	const dir = await mkdtemp(join(tmpdir(), `perf-run-${tree.name}-`));

	await cp(setup.dir, dir, {recursive: true});

	const row = structuredClone(setup.fake.documents.get(setup.owner.id));
	const context = await launch(dir);

	await attach(context, setup.fake);
	await context.addInitScript(OBSERVE);

	const page = context.pages()[0] || await context.newPage();
	const cdp = await context.newCDPSession(page);
	const profiles = {};
	const result = {};
	const errors = [];

	page.on('pageerror', (err) => errors.push(String(err)));
	await cdp.send('Emulation.setCPUThrottlingRate', {rate: THROTTLE});

	const startProfile = async () => {
		if (profiled) {
			await cdp.send('Profiler.enable');
			await cdp.send('Profiler.setSamplingInterval', {interval: 200});
			await cdp.send('Profiler.start');
		}
	};
	const stopProfile = async (name) => {
		if (profiled) {
			profiles[name] = (await cdp.send('Profiler.stop')).profile;
		}
	};

	try {
		// Cold start: a new browser opens the installed app on My Cards.
		await startProfile();
		await page.goto(setup.url('cards'));
		await page.waitForFunction(() => window.__tilePaint, null, {timeout: 120000});
		await page.waitForFunction(() => /copies/.test((document.getElementById('cards-summary') || {}).textContent || ''));
		await settle(page);
		await stopProfile('cold start');

		const tilePaint = await page.evaluate(() => window.__tilePaint);

		result.coldTile = tilePaint;
		result.coldTasks = await tasksBetween(page, 0);
		result.coldNodes = await domNodes(page);

		// Tabs: Cards, Sets, Binders, Lists, Cards.
		const tabs = [['sets', '.set-tile:not(.skeleton)'], ['binders', '.binder-cover'], ['lists', '.list-tile .owned-count'], ['cards', '.card-grid .tile']];

		await startProfile();
		result.tabs = {};

		for (const [tab, ready] of tabs) {
			const {at, ms} = await timeTo(page, `.tabs a[data-tab="${tab}"]`, ready);

			await settle(page, 800);
			result.tabs[tab] = {ms, nodes: await domNodes(page), tasks: await tasksBetween(page, at)};
		}

		await stopProfile('tabs');

		// A card page from My Cards, and back.
		await startProfile();

		const card = await timeTo(page, '.card-grid a.tile[data-link]', '.card-detail h2');

		await settle(page, 800);
		result.card = {ms: card.ms, tasks: await tasksBetween(page, card.at)};
		await stopProfile('card page');
		await page.goBack();
		await page.waitForSelector('.card-grid .tile');
		await settle(page, 800);

		// Scroll My Cards to the bottom, tapping Show more when it shows.
		await startProfile();

		const scroll = await page.evaluate(async () => {
			const frame = () => new Promise((done) => requestAnimationFrame(done));
			const start = performance.now();
			let last = start;
			let worst = 0;
			let janky = 0;
			let taps = 0;

			window.scrollTo(0, 0);

			for (let guard = 0; guard < 5000; guard++) {
				window.scrollBy(0, 400);
				await frame();

				const t = performance.now();

				worst = Math.max(worst, t - last);
				janky += t - last > 50 ? 1 : 0;
				last = t;

				if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2) {
					const more = [...document.querySelectorAll('#view button')].find((button) => !button.hidden && /^Show more/.test(button.textContent));

					if (!more) {
						break;
					}

					more.click();
					taps++;
					await frame();
					last = performance.now();
				}
			}

			return {at: start, janky, ms: performance.now() - start, taps, worst};
		});

		await settle(page, 800);
		result.scroll = {...scroll, nodes: await domNodes(page), tasks: await tasksBetween(page, scroll.at)};
		await stopProfile('scroll');

		// A 10-page binder.
		await page.click('.tabs a[data-tab="binders"]');
		await page.waitForSelector('.binder-cover');
		await settle(page, 800);
		await startProfile();

		const binder = await timeTo(page, 'a[data-link="binders/binder-big"]', '#binder-spread .bs-page .pocket[data-kind="card"]');

		await settle(page, 800);
		result.binder = {ms: binder.ms, nodes: await domNodes(page), tasks: await tasksBetween(page, binder.at)};
		await stopProfile('binder');

		// Another phone's save, read and merged while My Cards is open.
		await page.click('.tabs a[data-tab="cards"]');
		await page.waitForSelector('.card-grid .tile');
		await settle(page, 1000);

		const live = setup.fake.documents.get(setup.owner.id);
		const doc = structuredClone(live.doc);
		const stamp = new Date().toISOString();

		for (const entry of doc.cards.slice(0, 30)) {
			Object.assign(entry, {notes: `Edited on the other phone ${stamp}`, updated_at: stamp});
		}

		for (const entry of doc.cards.slice(100, 105)) {
			Object.assign(entry, {deleted_at: stamp, updated_at: stamp});
		}

		for (let i = 0; i < 20; i++) {
			doc.cards.push({...tileOf(TILES - 1 - i), catalog: 'international', created_at: stamp, deleted_at: null, id: `other-${i}`, language_source: 'manual', updated_at: stamp, variant_id: 'normal'});
		}

		live.doc = doc;
		live.updated_at = setup.fake.now();

		const expected = doc.cards.filter((entry) => !entry.deleted_at).length.toLocaleString('en');

		await startProfile();

		const merged = await page.evaluate(async (expected) => {
			const start = performance.now();
			const sync = await import('/pokemon-card-tracker/js/sync.js');

			await sync.syncNow();
			await new Promise((done) => {
				const check = () => {
					const status = document.getElementById('sync-status').textContent;
					const summary = (document.getElementById('cards-summary') || {}).textContent || '';

					if (status === 'Synced' && summary.startsWith(`${expected} copies`)) {
						done();
					}
					else {
						setTimeout(check, 16);
					}
				};

				check();
			});
			await new Promise((done) => requestAnimationFrame(() => setTimeout(done, 0)));

			return {at: start, ms: performance.now() - start};
		}, expected);

		await settle(page, 1000);
		result.merge = {ms: merged.ms, tasks: await tasksBetween(page, merged.at)};
		await stopProfile('merge');
		result.errors = errors;
	}
	finally {
		setup.fake.documents.set(setup.owner.id, row);
		await context.close();
		await rm(dir, {force: true, recursive: true});
	}

	return {profiles, result};
}

// ------------------------------------------------------------- trace

// One cold start under a Chromium trace: the main thread's time to the
// first painted tile, by kind of work (script compile and run, style,
// layout, parsing, IndexedDB callbacks), top-level events only.
async function traceColdStart(tree, setup) {
	const dir = await mkdtemp(join(tmpdir(), `perf-trace-${tree.name}-`));

	await cp(setup.dir, dir, {recursive: true});

	const context = await launch(dir);

	await attach(context, setup.fake);
	await context.addInitScript(OBSERVE);

	const page = context.pages()[0] || await context.newPage();
	const cdp = await context.newCDPSession(page);
	const events = [];

	cdp.on('Tracing.dataCollected', ({value}) => events.push(...value));
	await cdp.send('Emulation.setCPUThrottlingRate', {rate: THROTTLE});
	await cdp.send('Tracing.start', {traceConfig: {includedCategories: ['devtools.timeline', 'v8', 'v8.execute', 'blink', 'loading', 'disabled-by-default-devtools.timeline']}, transferMode: 'ReportEvents'});

	try {
		await page.goto(setup.url('cards'));
		await page.waitForFunction(() => window.__tilePaint, null, {timeout: 120000});

		const tile = await page.evaluate(() => [window.__tilePaint, performance.timeOrigin]);
		const done = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve));

		await cdp.send('Tracing.end');
		await done;

		const start = events.find((event) => event.name === 'navigationStart' || event.name === 'NavigationTiming') || null;
		const main = events.find((event) => event.name === 'thread_name' && event.args && event.args.name === 'CrRendererMain' && events.some((other) => other.pid === event.pid && other.name === 'ParseHTML'));
		const mine = events.filter((event) => main && event.pid === main.pid && event.tid === main.tid && event.ph === 'X' && typeof event.dur === 'number');
		const origin = Math.min(...mine.map((event) => event.ts));
		const until = origin + tile[0] * 1000;
		const byName = new Map();
		let covered = 0;
		let reach = 0;

		for (const event of mine.sort((a, b) => a.ts - b.ts)) {
			if (event.ts > until || event.ts + event.dur <= reach) {
				continue;
			}

			reach = event.ts + event.dur;
			covered += event.dur;

			const inner = mine.filter((other) => other !== event && other.ts >= event.ts && other.ts + other.dur <= reach);
			const parts = new Map();

			for (const other of inner) {
				if (/compile|Compile|Evaluate|v8\.run|ParseHTML|UpdateLayoutTree|^Layout$|IDB|ParseAuthorStyleSheet|RunMicrotasks|FunctionCall|EventDispatch|TimerFire|FireAnimationFrame|GC|Paint/.test(other.name)) {
					parts.set(other.name, (parts.get(other.name) || 0) + other.dur);
				}
			}

			const key = event.name;
			const old = byName.get(key) || {count: 0, dur: 0, parts: new Map()};

			old.count++;
			old.dur += event.dur;

			for (const [name, dur] of parts) {
				old.parts.set(name, (old.parts.get(name) || 0) + dur);
			}

			byName.set(key, old);
		}

		// Inside the tasks, by kind (a kind inside another counts in both).
		const kinds = new Map();

		for (const {parts} of byName.values()) {
			for (const [name, dur] of parts) {
				kinds.set(name, (kinds.get(name) || 0) + dur);
			}
		}

		console.log(`\n## ${tree.name}: cold start trace to the first tile (${Math.round(tile[0])} ms), main-thread tasks ${Math.round(covered / 1000)} ms${start ? '' : ''}`);
		console.log([...kinds].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name, dur]) => `${String(Math.round(dur / 1000)).padStart(6)} ms  ${name}`).join('\n'));

		if (out) {
			const {writeFile} = await import('node:fs/promises');

			await writeFile(join(out, `${tree.name}-cold-start.trace.json`), JSON.stringify({traceEvents: events}));
		}
	}
	finally {
		await context.close();
		await rm(dir, {force: true, recursive: true});
	}
}

// ------------------------------------------------------------- profiles

// Self time by function, the biggest first, from a CDP CPU profile.
function selfTimes(cpuProfile, top = 25) {
	const byId = new Map(cpuProfile.nodes.map((node) => [node.id, node]));
	const self = new Map();
	const {samples, timeDeltas} = cpuProfile;

	for (let i = 0; i < samples.length; i++) {
		const node = byId.get(samples[i]);
		const frame = node.callFrame;
		const file = frame.url ? frame.url.replace(/^.*\/pokemon-card-tracker\//, '') : '';
		const key = `${frame.functionName || '(anonymous)'} ${file}${file ? `:${frame.lineNumber + 1}` : ''}`;

		self.set(key, (self.get(key) || 0) + (timeDeltas[i + 1] || 0) / 1000);
	}

	const total = [...self.entries()].filter(([key]) => !/^\((idle|program)\)/.test(key)).reduce((sum, [, ms]) => sum + ms, 0);

	return {
		busy: Math.round(total),
		top: [...self.entries()].filter(([key]) => !/^\(idle\)/.test(key)).sort((a, b) => b[1] - a[1]).slice(0, top).map(([key, ms]) => `${String(Math.round(ms)).padStart(6)} ms  ${key}`),
	};
}

// ------------------------------------------------------------- report

const median = (values) => {
	const sorted = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);

	if (!sorted.length) {
		return null;
	}

	const mid = Math.floor(sorted.length / 2);

	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const METRICS = {
	'cold start: first tile painted (ms)': (r) => r.coldTile,
	'cold start: long tasks total (ms)': (r) => r.coldTasks.total,
	'cold start: blocking time (ms)': (r) => r.coldTasks.blocking,
	'cold start: longest task (ms)': (r) => r.coldTasks.longest,
	'cold start: DOM nodes': (r) => r.coldNodes,
	'tab Sets (ms)': (r) => r.tabs.sets.ms,
	'tab Binders (ms)': (r) => r.tabs.binders.ms,
	'tab Lists (ms)': (r) => r.tabs.lists.ms,
	'tab Cards (ms)': (r) => r.tabs.cards.ms,
	'tab Cards: long tasks total (ms)': (r) => r.tabs.cards.tasks.total,
	'tabs: long tasks total (ms)': (r) => Object.values(r.tabs).reduce((sum, tab) => sum + tab.tasks.total, 0),
	'card page from My Cards (ms)': (r) => r.card.ms,
	'scroll to the bottom (ms)': (r) => r.scroll.ms,
	'scroll: Show more taps': (r) => r.scroll.taps,
	'scroll: frames over 50 ms': (r) => r.scroll.janky,
	'scroll: worst frame (ms)': (r) => r.scroll.worst,
	'scroll: long tasks total (ms)': (r) => r.scroll.tasks.total,
	'scroll: DOM nodes at the bottom': (r) => r.scroll.nodes,
	'10-page binder (ms)': (r) => r.binder.ms,
	'10-page binder: DOM nodes': (r) => r.binder.nodes,
	'merge of a remote save (ms)': (r) => r.merge.ms,
	'merge: long tasks total (ms)': (r) => r.merge.tasks.total,
};

const loadAverage = async () => (await import('node:os')).loadavg().map((value) => value.toFixed(1)).join(' ');

// ------------------------------------------------------------- main

const browserCheck = await chromium.launch();

await browserCheck.close();

console.log(`load average at start: ${await loadAverage()}`);

const setups = new Map();

for (const tree of trees) {
	const started = Date.now();

	setups.set(tree.name, await setUp(tree));
	console.log(`set up ${tree.name} in ${Math.round((Date.now() - started) / 1000)} s`);
}

const results = new Map(trees.map((tree) => [tree.name, []]));
const loads = [];

for (let run = 0; run < runs; run++) {
	// Each run starts with the next tree, so a slow spell on the machine
	// falls on each tree in turn.
	const order = trees.map((_, i) => trees[(i + run) % trees.length]);

	for (const tree of order) {
		loads.push(await loadAverage());

		const {result} = await measure(tree, setups.get(tree.name));

		results.get(tree.name).push(result);
		console.log(`run ${run + 1} ${tree.name}: first tile ${Math.round(result.coldTile)} ms, tabs ${Object.values(result.tabs).map((tab) => Math.round(tab.ms)).join('/')} ms, card ${Math.round(result.card.ms)} ms, scroll ${Math.round(result.scroll.ms)} ms, binder ${Math.round(result.binder.ms)} ms, merge ${Math.round(result.merge.ms)} ms${result.errors.length ? `, errors: ${result.errors.join('; ')}` : ''}`);
	}
}

const rows = Object.entries(METRICS).map(([name, pick]) => [name, ...trees.map((tree) => {
	const value = median(results.get(tree.name).map((result) => {
		try {
			return pick(result);
		}
		catch {
			return null;
		}
	}));

	return value === null ? '-' : String(Math.round(value));
})]);

if (runs > 0) {
	console.log(`\nMedians of ${runs} runs, CPU throttled ${THROTTLE}x, 360 x 740. Load averages per run: ${loads.join(' | ')}`);
	console.log(`| Measure | ${trees.map((tree) => tree.name).join(' | ')} |`);
	console.log(`| --- | ${trees.map(() => '---:').join(' | ')} |`);

	for (const row of rows) {
		console.log(`| ${row.join(' | ')} |`);
	}
}

if (trace) {
	for (const tree of trees) {
		await traceColdStart(tree, setups.get(tree.name));
	}
}

if (profile) {
	for (const tree of trees) {
		const {profiles} = await measure(tree, setups.get(tree.name), {profiled: true});

		for (const [name, cpuProfile] of Object.entries(profiles)) {
			const {busy, top} = selfTimes(cpuProfile);

			console.log(`\n## ${tree.name}: ${name} (main thread busy ${busy} ms, self time)`);
			console.log(top.join('\n'));
		}

		if (out) {
			const {writeFile} = await import('node:fs/promises');

			for (const [name, cpuProfile] of Object.entries(profiles)) {
				await writeFile(join(out, `${tree.name}-${name.replace(/\W+/g, '-')}.cpuprofile`), JSON.stringify(cpuProfile));
			}
		}
	}
}

if (out) {
	const {writeFile} = await import('node:fs/promises');

	await writeFile(join(out, 'results.json'), JSON.stringify(Object.fromEntries(results), null, '\t'));
}

for (const {dir, server} of setups.values()) {
	await server.close();
	await rm(dir, {force: true, recursive: true});
}
