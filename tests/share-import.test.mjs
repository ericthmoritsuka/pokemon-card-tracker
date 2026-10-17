// Browser tests for importing from Android's share sheet: the manifest's
// share_target POSTs a file to /share-import, sw.js keeps it and redirects
// to Import, and Import shows the usual report with its Save button (never
// saving on its own), then deletes the kept file. A share with no file, or
// a file that is not CSV or JSON, says so on Import.
// Headless Chromium at 360 x 740 against tests/pages-server.mjs, with the
// service worker allowed. Supabase is faked; TCGdex answers empty. Invented
// rows only.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/share-import.test.mjs

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {FakeSupabase} from './fake-supabase.mjs';
import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const VIEWPORT = {height: 740, width: 360};
const CSV = 'Name;Set;Number;Language;Finish Type;Count;ID;Release Date\nInventmon;Test Set;001/100;EN;NORMAL;2;tst9_int_1;2026-01-01\nFakeachu;Test Set;002/100;EN;HOLOFOIL;1;tst9_int_2;2026-01-01\n';

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

const url = (path = '') => `${server.origin}${BASE}${path}`;

// A phone with the worker installed and in control of the page.
async function installed() {
	const context = await browser.newContext({serviceWorkers: 'allow', viewport: VIEWPORT});

	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await context.route('https://api.tcgdex.net/**', (route) => route.fulfill({body: '[]', contentType: 'application/json', status: 200}));
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));
	await context.route('https://raw.githubusercontent.com/**', (route) => route.fulfill({status: 404}));
	await new FakeSupabase().attach(context, 'phone');

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err));
	await page.goto(url('cards'));
	await page.evaluate(() => navigator.serviceWorker.ready);
	await page.reload();
	await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, {timeout: 30000});

	return {context, errors, page};
}

// What Android's share sheet sends: a multipart POST navigation to the
// share action, with the file in the "file" field (or no file at all).
async function share(page, file) {
	await Promise.all([
		page.waitForURL((address) => address.pathname === `${BASE}import`, {timeout: 15000}),
		page.evaluate(({action, file}) => {
			const form = document.createElement('form');
			const input = document.createElement('input');

			form.method = 'POST';
			form.enctype = 'multipart/form-data';
			form.action = action;
			input.type = 'file';
			input.name = 'file';

			if (file) {
				const transfer = new DataTransfer();

				transfer.items.add(new File([file.body], file.name, {type: file.type}));
				input.files = transfer.files;
			}

			form.append(input);
			document.body.append(form);
			form.submit();
		}, {action: `${BASE}share-import`, file}),
	]);
}

const keptFiles = (page) => page.evaluate(async () => (await (await caches.open('card-tracker-share')).keys()).length);

describe('the manifest', () => {
	test('names a POST multipart share target for CSV and JSON files, handled by sw.js', async () => {
		const manifest = JSON.parse(await readFile(new URL('../manifest.webmanifest', import.meta.url), 'utf8'));
		const target = manifest.share_target;

		assert.equal(target.action, `${BASE}share-import`);
		assert.equal(target.method, 'POST');
		assert.equal(target.enctype, 'multipart/form-data');
		assert.equal(target.params.files[0].name, 'file');

		for (const type of ['.csv', 'text/csv', 'text/comma-separated-values', 'application/json', '.json', 'text/plain']) {
			assert.ok(target.params.files[0].accept.includes(type), type);
		}

		const sw = await readFile(new URL('../sw.js', import.meta.url), 'utf8');

		assert.ok(sw.includes('const SHARE_ACTION = \'share-import\';'));
	});
});

describe('sharing a file to the installed app', () => {
	test('a monprice CSV opens Import with its report, saves nothing on its own, and is deleted once read', async () => {
		const {context, errors, page} = await installed();

		try {
			await share(page, {body: CSV, name: 'monprice-export.csv', type: 'text/plain'});
			await page.locator('h3', {hasText: 'Match report'}).waitFor({timeout: 30000});

			assert.match(await page.locator('.card', {hasText: 'Match report'}).innerText(), /monprice-export\.csv: 2 rows, 3 copies/);
			assert.equal(await page.locator('button', {hasText: /^Save /}).count(), 1, 'the usual Save button');
			assert.match(await page.locator('#app, main, body').first().innerText(), /Nothing is saved until you tap Save/);
			assert.equal(new URL(page.url()).search, '', 'the flag is taken off the address');
			assert.equal(await keptFiles(page), 0, 'the kept file is deleted');

			// A reload does not look for the file again.
			await page.reload();
			await page.locator('h2', {hasText: 'Import a collection'}).waitFor();
			assert.equal(await page.locator('#import-share-problem').count(), 0);
			assert.equal(await page.locator('h3', {hasText: 'Match report'}).count(), 0);
			assert.deepEqual(errors, []);
		}
		finally {
			await context.close();
		}
	});

	test('a share with no file, and a file that is not CSV or JSON, say so', async () => {
		const {context, errors, page} = await installed();

		try {
			await share(page, null);
			await page.locator('#import-share-problem').waitFor({timeout: 15000});
			assert.match(await page.locator('#import-share-problem').innerText(), /No file came with the share/);

			await share(page, {body: 'not a picture', name: 'photo.png', type: 'image/png'});
			await page.locator('#import-share-problem', {hasText: 'photo.png'}).waitFor({timeout: 15000});
			assert.match(await page.locator('#import-share-problem').innerText(), /photo\.png is not a CSV or JSON file, so it was not read/);
			assert.equal(await keptFiles(page), 0);
			assert.equal(await page.locator('h3', {hasText: 'Match report'}).count(), 0);
			assert.deepEqual(errors, []);
		}
		finally {
			await context.close();
		}
	});
});
