// A Pokémon goal (v71) on a phone still running v70, which knows only set
// and artist goals: the family shares one document, and an older phone may
// sync it for a while. The v70 phone runs the app exactly as v70 shipped it
// (commit a1cfeca), served file by file from git, beside a phone running
// this checkout; both sync through tests/fake-supabase.mjs.
//
// The v71 phone makes a Pokémon goal, a set goal, and a binder from the
// Pokémon goal, and syncs. The v70 phone then syncs, opens Lists, the
// Pokémon goal's address, and the binder, and changes the goals it does
// know: renames the set goal, makes a new one, moves them in Edit order,
// deletes one and brings it back. Through all of it the v70 phone shows
// nothing broken (no page error, no "Every card by this artist" on a
// Pokémon), and the Pokémon goal and its binder reach the server exactly as
// the v71 phone wrote them, and show again on the v71 phone.
//
// Headless Chromium, signed in to the fake. TCGdex, PokeAPI, and the image
// hosts answer nothing: the proof is about the document, not the cards.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/pokemon-goal-v70-browser.test.mjs

import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {extname} from 'node:path';
import {after, before, describe, test} from 'node:test';
import {fileURLToPath} from 'node:url';

import {FakeSupabase} from './fake-supabase.mjs';
import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const VIEWPORT = {height: 740, width: 360};
const TEST_TIMEOUT = 240000;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
// v70 as it went live (CHANGELOG.md, "v70").
const V70 = 'a1cfeca';

const TYPES = {
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.webmanifest': 'application/manifest+json',
	'.woff2': 'font/woff2',
};

// A file as v70 shipped it, or null when v70 had none.
const shipped = new Map();

function v70File(path) {
	if (!shipped.has(path)) {
		try {
			shipped.set(path, execFileSync('git', ['-C', ROOT, 'show', `${V70}:${path}`], {maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore']}));
		}
		catch {
			shipped.set(path, null);
		}
	}

	return shipped.get(path);
}

const hasV70 = Boolean(v70File('sw.js'));

let server;
let browser;

before(async () => {
	server = await startPagesServer();
	browser = await chromium.launch();
});

after(async () => {
	await browser?.close();
	await server?.close();
});

const url = (path = '') => `${server.origin}${BASE}${path}`;

async function quietServices(context) {
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await context.route('https://api.tcgdex.net/**', (route) => route.fulfill({body: '{}', contentType: 'application/json', status: 404}));
	await context.route('https://graphql.pokeapi.co/**', (route) => route.abort('internetdisconnected'));
	await context.route('https://pokeapi.co/**', (route) => route.abort());
	await context.route('https://raw.githubusercontent.com/**', (route) => route.abort());
	await context.route('https://assets.tcgdex.net/**', (route) => route.abort());
	await context.route('https://api.frankfurter.dev/**', (route) => route.fulfill({body: '[]', contentType: 'application/json', status: 200}));
}

// A phone. v70: every file of the app as v70 shipped it, a folder its
// index.html, and a path v70 had no file for its 404.html, as Pages serves.
async function phone(fake, name, {v70 = false} = {}) {
	const context = await browser.newContext({hasTouch: true, serviceWorkers: 'block', viewport: VIEWPORT});

	await quietServices(context);
	await fake.attach(context, name);

	if (v70) {
		await context.route((target) => target.origin === server.origin && target.pathname.startsWith(BASE), (route) => {
			const relative = decodeURIComponent(new URL(route.request().url()).pathname.slice(BASE.length));
			const path = !relative || relative.endsWith('/') ? `${relative}index.html` : relative;
			const body = v70File(path) || v70File(`${path}/index.html`);
			const file = body ? (v70File(path) ? path : `${path}/index.html`) : '404.html';

			return route.fulfill({body: body || v70File('404.html'), contentType: TYPES[extname(file)] || 'application/octet-stream', headers: {'Cache-Control': 'no-cache'}, status: body ? 200 : 404});
		});
	}

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err));

	return {context, errors, page};
}

async function signIn(page, fake, email) {
	await page.goto(url('signin'));
	await page.fill('#signin-email', email);
	await page.click('button:has-text("Send link")');
	await page.waitForSelector('#check-email');

	const code = fake.issueCode(email);

	await page.goto(`${url()}?code=${code}`);
	await page.waitForSelector('#account.avatar');
}

async function waitForSynced(page) {
	await page.waitForFunction(() => {
		const line = document.getElementById('sync-status');

		return line && !line.hidden && line.textContent === 'Synced';
	}, null, {timeout: 20000});
}

// Runs one of the app's own modules on the page: v70's on the v70 phone.
const inApp = (page, fn, arg) => page.evaluate(fn, arg);

const serverDoc = (fake, user) => structuredClone(fake.documents.get(user.id).doc);

const byId = (list, id) => (list || []).find((item) => item && item.id === id) || null;

const shownErrors = (page) => page.locator('#errors .error').allTextContents();

describe('a Pokémon goal on a phone still running v70', {skip: hasV70 ? false : `commit ${V70} (v70) is not in this clone`}, () => {
	test('the v70 phone shows nothing broken, and never deletes or rewrites the goal or its binder', {timeout: TEST_TIMEOUT}, async () => {
		assert.match(String(v70File('sw.js')), /const VERSION = 'v70';/, `${V70} is v70`);
		assert.doesNotMatch(String(v70File('js/goals.js')), /'pokemon'/, 'v70 knows no Pokémon goal');

		const fake = new FakeSupabase();
		const eric = fake.addUser('eric@example.test');

		// ------------------------------------------------ the v71 phone

		const v71 = await phone(fake, 'v71');

		await signIn(v71.page, fake, eric.email);
		await waitForSynced(v71.page);

		const made = await inApp(v71.page, async () => {
			const goals = await import('/pokemon-card-tracker/js/goals.js');
			const {createGeneratedBinder} = await import('/pokemon-card-tracker/js/binders.js');
			const pokemon = await goals.createGoal({kind: 'pokemon', languages: ['pt', 'ja'], name: 'Jigglypuff', target: 39});
			const set = await goals.createGoal({catalog: 'international', kind: 'set', level: 'numbered', name: '151', target: 'sv03.5'});
			const keys = ['ja|PMCG2-035', 'international|base2-54', 'international|sv03.5-039', 'ja|SV2a-039'];
			const binder = await createGeneratedBinder({cols: 2, name: 'Jigglypuff', rows: 2}, {order: 'set', source: {id: pokemon.id, kind: 'goal'}}, {keys, rule_key: `goal:${pokemon.id}|set`, shown: {}});

			return {binder: binder.id, pokemon: pokemon.id, set: set.id};
		});

		await v71.page.waitForFunction(() => document.getElementById('sync-status')?.textContent === 'Synced', null, {timeout: 20000});
		await v71.page.waitForTimeout(2500);
		await v71.page.reload();
		await waitForSynced(v71.page);

		const written = serverDoc(fake, eric);
		const goalAsWritten = byId(written.goals, made.pokemon);
		const binderAsWritten = byId(written.binders, made.binder);

		assert.equal(goalAsWritten && goalAsWritten.kind, 'pokemon', 'the v71 phone pushed the goal');
		assert.equal(binderAsWritten && binderAsWritten.rule.source.id, made.pokemon, 'and the binder from it');
		await v71.context.close();

		// ------------------------------------------------ the v70 phone

		const v70 = await phone(fake, 'v70', {v70: true});

		await signIn(v70.page, fake, eric.email);
		await waitForSynced(v70.page);
		assert.equal(await inApp(v70.page, async () => (await import('/pokemon-card-tracker/js/goals.js')).GOAL_KINDS.join()), 'set,artist', 'the page runs v70');

		// Lists: the set goal, and no trace of the Pokémon one.
		await v70.page.goto(url('lists'));
		await v70.page.waitForSelector(`.goal-tile[data-goal="${made.set}"]`, {timeout: 20000});
		assert.equal(await v70.page.locator(`[data-goal="${made.pokemon}"]`).count(), 0);
		assert.doesNotMatch(await v70.page.locator('#view').innerText(), /Jigglypuff|by this artist/);

		// The Pokémon goal's own address says it is not here, as for a
		// goal deleted elsewhere.
		await v70.page.goto(url(`goals/${made.pokemon}`));
		await v70.page.waitForFunction(() => /This goal is not here\./.test(document.getElementById('goal-notice')?.textContent || ''), null, {timeout: 15000});

		// The binder: its pages stay as they were, with a line to choose
		// another list, and nothing is saved.
		await v70.page.goto(url(`binders/${made.binder}`));
		await v70.page.waitForFunction(() => /was deleted\. Its pages stay as they were/.test(document.getElementById('binder-list-note')?.textContent || ''), null, {timeout: 20000});
		assert.equal(await v70.page.locator('#bs-spread .pocket').count() > 0, true, 'its pocket shows');

		// The binder form lists only the goals v70 knows.
		await v70.page.goto(url('binders'));
		await v70.page.click('#new-binder');
		await v70.page.check('#new-binder-list');
		await v70.page.waitForSelector('#rule-section');
		await v70.page.check('#rule-kind input[value="goal"]');
		assert.deepEqual(await v70.page.locator('#rule-list option').evaluateAll((options) => options.map((option) => option.value)), [made.set]);

		// Edits to the goals it knows: rename, a new one, Edit order, a
		// delete and Undo.
		const second = await inApp(v70.page, async ({set}) => {
			const goals = await import('/pokemon-card-tracker/js/goals.js');
			const lists = await import('/pokemon-card-tracker/js/checklists.js');

			await lists.renameChecklist(set, '151 numbered');

			const artist = await goals.createGoal({kind: 'artist', target: 'Test Artist'});

			await lists.reorderGoals([{id: artist.id, order: 1}, {id: set, order: 2}]);
			await lists.deleteChecklist(set);
			await lists.restoreGoal(set);

			return artist.id;
		}, {set: made.set});

		await v70.page.waitForTimeout(2500);
		await v70.page.reload();
		await waitForSynced(v70.page);
		await v70.page.goto(url('lists'));
		await v70.page.waitForSelector(`.goal-tile[data-goal="${second}"]`, {timeout: 20000});

		const after70 = serverDoc(fake, eric);

		assert.equal(byId(after70.goals, made.set).name, '151 numbered', 'the v70 phone\'s edits reached the server');
		assert.ok(byId(after70.goals, second));
		assert.deepEqual(byId(after70.goals, made.pokemon), goalAsWritten, 'the Pokémon goal is exactly as the v71 phone wrote it');
		assert.deepEqual(byId(after70.binders, made.binder), binderAsWritten, 'and so is its binder');
		assert.deepEqual(await shownErrors(v70.page), []);
		assert.deepEqual(v70.errors, []);
		await v70.context.close();

		// ------------------------------------- the v71 phone, once more

		const back = await phone(fake, 'v71-again');

		await signIn(back.page, fake, eric.email);
		await waitForSynced(back.page);
		await back.page.goto(url('lists'));
		await back.page.waitForSelector(`.goal-tile[data-goal="${made.pokemon}"]`, {timeout: 20000});
		assert.equal(await back.page.locator(`.goal-tile[data-goal="${made.pokemon}"] .set-meta`).textContent(), 'Every card in PT, JA');
		assert.deepEqual(back.errors, []);
		await back.context.close();
	});
});
