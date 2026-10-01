// Browser test for the international twin picker (js/twins-view.js) in
// headless Chromium at 360 x 740, against tests/twins-harness.mjs served by
// tests/pages-server.mjs. Nothing leaves localhost: card images are real
// TCGdex English low.webp files fetched once by Node and served from memory
// (a drawn stand-in when there is no network), and any other outside request
// fails the test. No Supabase is involved.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/twins-browser.test.mjs

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {startPagesServer} from './pages-server.mjs';
import {CANDIDATES, HARNESS_PATH, routeHarness} from './twins-harness.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const VIEWPORT = {height: 740, width: 360};
const SHOTS = process.env.SHOTS || '/tmp';

let server;
let browser;
const images = {};

before(async () => {
	server = await startPagesServer();
	browser = await chromium.launch();

	for (const {image} of CANDIDATES) {
		try {
			const response = await fetch(`${image}/low.webp`);

			if (response.ok) {
				images[image] = {body: Buffer.from(await response.arrayBuffer()), type: 'image/webp'};
			}
		}
		catch {
			// The stand-in is used.
		}
	}

	if (Object.keys(images).length < CANDIDATES.length) {
		console.log('# Some TCGdex images were not reachable: drawn stand-ins are used.');
	}
});

after(async () => {
	await browser.close();
	await server.close();
});

async function open(context, card) {
	const page = await context.newPage();
	const outside = await routeHarness(page, {images});
	const errors = [];

	page.on('pageerror', (err) => errors.push(err.message));
	await page.goto(`${server.origin}${HARNESS_PATH}?card=${card}`);
	await page.waitForFunction(() => window.harnessReady);

	return {errors, outside, page};
}

describe('the twin picker', () => {
	test('shows the candidates side by side, saves "This one", and stays answered', async () => {
		const context = await browser.newContext({viewport: VIEWPORT});
		const {errors, outside, page} = await open(context, 'M3-068');
		const picker = page.locator('.tw-confirm');

		await picker.waitFor();
		assert.equal(await page.locator('.tw-title').textContent(), 'Which is the international print?');

		const options = page.locator('.tw-option');

		assert.equal(await options.count(), 3);
		assert.deepEqual(await page.locator('.tw-name').allTextContents(), CANDIDATES.map((c) => c.name));
		assert.equal(await page.getByRole('button', {name: /^This one/}).count(), 3);
		assert.equal(await page.getByRole('button', {name: 'None of these'}).count(), 1);

		// Every image drawn, side by side on one row, the buttons at least
		// 44 px tall, and no sideways scroll at 360 px.
		await page.waitForFunction(() => [...document.querySelectorAll('img.tw-image')].every((img) => img.complete && img.naturalWidth > 0));

		const boxes = await options.evaluateAll((items) => items.map((item) => item.getBoundingClientRect().toJSON()));

		assert.ok(boxes.every((box) => Math.abs(box.top - boxes[0].top) < 1), 'one row');
		assert.ok(boxes[0].right <= boxes[1].left && boxes[1].right <= boxes[2].left, 'side by side');

		for (const box of await page.locator('.tw-pick').evaluateAll((buttons) => buttons.map((b) => b.getBoundingClientRect().height))) {
			assert.ok(box >= 44, `button height ${box}`);
		}

		assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll');
		assert.equal(await page.evaluate(() => window.harness.image()), null, 'no twin before the pick');

		await page.screenshot({fullPage: true, path: `${SHOTS}/twins-picker.png`});

		await page.getByRole('button', {name: 'This one: Antique Jaw Fossil, Perfect Order 068'}).click();
		await page.locator('.tw-confirm').waitFor({state: 'detached'});
		assert.equal(await page.getByRole('status').textContent(), 'Saved: Antique Jaw Fossil is the international print.');
		assert.equal(await page.evaluate(() => window.harness.image()), 'https://assets.tcgdex.net/en/me/me03/068/high.webp');
		assert.equal(await page.evaluate(() => window.harness.name()), 'Antique Jaw Fossil');

		const [decision] = await page.evaluate(() => window.harness.decisions());

		assert.equal(decision.card_id, 'M3-068');
		assert.equal(decision.choice, 'confirmed');
		assert.equal(decision.twin.id, 'me03-068');

		// Opened again, the card asks nothing.
		await page.reload();
		await page.waitForFunction(() => window.harnessReady);
		await page.waitForTimeout(300);
		assert.equal(await page.locator('.tw-confirm').count(), 0);
		assert.equal(await page.locator('.tw-block').isHidden(), true);

		assert.deepEqual(errors, []);
		assert.deepEqual(outside, [], 'no request left localhost');
		await context.close();
	});

	test('"None of these" saves a rejection and shows no twin, in the dark scheme too', async () => {
		const context = await browser.newContext({colorScheme: 'dark', viewport: VIEWPORT});
		const {errors, outside, page} = await open(context, 'M3-069');

		await page.locator('.tw-confirm').waitFor();
		await page.screenshot({fullPage: true, path: `${SHOTS}/twins-picker-dark.png`});

		const colors = await page.locator('.tw-confirm').evaluate((el) => {
			const style = getComputedStyle(el);

			return {background: style.backgroundColor, text: getComputedStyle(el.querySelector('.tw-title')).color};
		});

		assert.notEqual(colors.background, 'rgb(255, 255, 255)', 'the panel follows the dark scheme');

		await page.getByRole('button', {name: 'None of these'}).click();
		await page.locator('.tw-confirm').waitFor({state: 'detached'});
		assert.equal(await page.getByRole('status').textContent(), 'Saved: no international print for now.');
		assert.equal(await page.evaluate(() => window.harness.image()), null);

		const [decision] = await page.evaluate(() => window.harness.decisions());

		assert.equal(decision.choice, 'rejected');
		assert.deepEqual(decision.rejected_ids, CANDIDATES.map((c) => c.id));

		assert.deepEqual(errors, []);
		assert.deepEqual(outside, []);
		await context.close();
	});
});
