// Browser tests for the All, Owned, and Missing control with its counts
// (js/dom.js segmentCounts, style.css segments-stacked): where a segment's
// label and number do not fit side by side, every segment puts its number
// under its label instead of one segment wrapping alone or the control
// running off its edge (v74; "Missing 33" wrapped at 324 px). Headless
// Chromium against tests/pages-server.mjs, with the app's own stylesheet
// and module on an empty page.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/segments-browser.test.mjs

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';

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

// A page with the app's stylesheet and one control per counts given, at
// this width and text size (1.2 as a phone's larger system text).
async function controls(width, counts, {scale = 1} = {}) {
	const context = await browser.newContext({viewport: {height: 700, width}});

	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await context.route(`${server.origin}${BASE}segments-test.html`, (route) => route.fulfill({
		body: `<!doctype html><html style="font-size: ${scale * 100}%"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="style.css"></head><body><div id="errors"></div><main></main></body></html>`,
		contentType: 'text/html',
	}));

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(err));
	await page.goto(`${server.origin}${BASE}segments-test.html`);
	await page.evaluate(async (all) => {
		const {h, segmentCounts} = await import('/pokemon-card-tracker/js/dom.js');

		all.forEach((each, i) => {
			const control = h('div', {class: 'segmented', id: `seg-${i}`, role: 'radiogroup'}, ['all', 'owned', 'missing'].map((value) => h('label', null,
				h('input', {checked: value === 'all', name: `seg-${i}`, type: 'radio', value}),
				h('span', {'data-label': value[0].toUpperCase() + value.slice(1)}, value)
			)));

			document.querySelector('main').append(control);
			segmentCounts(control, each);
		});
	}, counts);

	return {context, errors, page};
}

// Per control: stacked or not, its segments' text, and whether anything
// runs past its edge.
const read = (page) => page.$$eval('.segmented', (all) => all.map((control) => {
	const spans = [...control.querySelectorAll('span[data-label]')];

	return {
		overflows: control.scrollWidth > control.clientWidth || spans.some((span) => span.scrollWidth > span.clientWidth),
		stacked: control.classList.contains('segments-stacked'),
		text: spans.map((span) => span.textContent),
		// Each number sits below its label (stacked).
		under: spans.every((span) => {
			const count = span.querySelector('.segment-count');
			const label = document.createRange();

			label.selectNodeContents(span.firstChild);

			return Boolean(count) && count.getBoundingClientRect().top > label.getBoundingClientRect().top + 8;
		}),
	};
}));

describe('All, Owned, and Missing with their counts', () => {
	test('on a 324 px phone with larger text, every segment puts its number under its label and nothing runs off', async () => {
		const {context, errors, page} = await controls(324, [{all: 1025, missing: 613, owned: 412}], {scale: 1.2});
		const [control] = await read(page);

		assert.deepEqual(control.text, ['All 1,025', 'Owned 412', 'Missing 613'], 'the text a screen reader and the other tests read is unchanged');
		assert.equal(control.stacked, true);
		assert.equal(control.under, true);
		assert.equal(control.overflows, false);
		assert.ok(await page.$eval('#seg-0 .segment-count', (count) => getComputedStyle(count).minHeight === '0px' && getComputedStyle(count).backgroundColor === 'rgba(0, 0, 0, 0)'), 'the number is not drawn as a segment of its own');
		await page.screenshot({path: '/tmp/segments-stacked.png'});
		assert.deepEqual(errors, []);
		assert.equal(await page.locator('#errors').textContent(), '', 'no error shown');
		await context.close();
	});

	test('where there is room the numbers stay beside their labels, and turning the phone wider unstacks them', async () => {
		const {context, errors, page} = await controls(324, [{all: 37, missing: 33, owned: 4}, {all: 1025, missing: 613, owned: 412}], {scale: 1.2});

		assert.equal((await read(page))[1].stacked, true);
		await page.setViewportSize({height: 700, width: 640});
		await page.waitForFunction(() => !document.getElementById('seg-1').classList.contains('segments-stacked'));

		for (const control of await read(page)) {
			assert.equal(control.stacked, false);
			assert.equal(control.overflows, false);
		}

		// Back narrow, and a few more turns: no "ResizeObserver loop" error.
		await page.setViewportSize({height: 700, width: 324});
		await page.waitForFunction(() => document.getElementById('seg-1').classList.contains('segments-stacked'));
		await page.setViewportSize({height: 700, width: 500});
		await page.setViewportSize({height: 700, width: 330});
		await page.waitForTimeout(300);
		assert.equal(await page.locator('#errors').textContent(), '', 'no error shown');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('counts not known yet show the labels alone, and a redraw never stacks a second number', async () => {
		const {context, errors, page} = await controls(412, [null]);

		assert.deepEqual((await read(page))[0].text, ['All', 'Owned', 'Missing']);
		await page.evaluate(async () => {
			const {segmentCounts} = await import('/pokemon-card-tracker/js/dom.js');
			const control = document.getElementById('seg-0');

			segmentCounts(control, {all: 9, missing: 2, owned: 7});
			segmentCounts(control, {all: 10, missing: 2, owned: 8});
		});
		assert.deepEqual((await read(page))[0].text, ['All 10', 'Owned 8', 'Missing 2']);
		assert.equal(await page.locator('#seg-0 .segment-count').count(), 3);
		assert.deepEqual(errors, []);
		await context.close();
	});
});
