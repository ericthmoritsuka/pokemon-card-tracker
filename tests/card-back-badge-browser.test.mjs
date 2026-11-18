// Browser test for a card page picture with no image (css/photos.css,
// ".ph-slide .card-back"): the card back's text keeps clear of the source
// label ("Official") at the bottom of the slide, on a 324 px phone with
// larger system text, and a long name never squeezes another line away
// (v74; it ran under the label before). Headless Chromium against
// tests/pages-server.mjs, with the app's stylesheets, js/tile.js cardArt,
// and the carousel's own classes on an empty page.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/card-back-badge-browser.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
// Every stylesheet the app loads, in its order.
const STYLES = [...fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8').matchAll(/href="\/pokemon-card-tracker\/([^"]+\.css)"/g)].map((match) => match[1]);

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

describe('a card page picture with no image', () => {
	for (const [width, scale] of [[324, 1], [324, 1.2], [360, 1.2]]) {
		test(`at ${width} px and text x${scale}, the card back's name, number, and status show whole and clear of the Official label`, async () => {
			const context = await browser.newContext({viewport: {height: 740, width}});

			await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
			await context.route(`${server.origin}${BASE}card-back-test.html`, (route) => route.fulfill({
				body: `<!doctype html><html style="font-size: ${scale * 100}%"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">${STYLES.map((href) => `<link rel="stylesheet" href="${href}">`).join('')}</head><body><main></main></body></html>`,
				contentType: 'text/html',
			}));

			const page = await context.newPage();
			const errors = [];

			page.on('pageerror', (err) => errors.push(err));
			await page.goto(`${server.origin}${BASE}card-back-test.html`);

			const results = await page.evaluate(async () => {
				const {h} = await import('/pokemon-card-tracker/js/dom.js');
				const {cardArt} = await import('/pokemon-card-tracker/js/tile.js');
				const infos = [
					{name: 'Test card', number: '025', setName: 'Test set with a long name'},
					{name: 'A card name long enough to wrap onto four lines here', number: '159', setName: 'Test set'},
				];

				return infos.map((info) => {
					const slide = h('div', {class: 'ph-slide'}, h('div', {class: 'ph-art'}, cardArt(info, null)), h('span', {class: 'ph-source'}, 'Official'));

					document.querySelector('main').append(h('div', {class: 'card-detail'}, h('div', {class: 'card-hero'},
						h('div', {class: 'hero-art'}, h('div', {class: 'ph-carousel'}, h('div', {class: 'ph-viewport'}, h('div', {class: 'ph-track'}, slide)))),
						h('div', {class: 'hero-facts'}, h('h2', null, info.name))
					)));

					const back = slide.querySelector('.card-back').getBoundingClientRect();
					const label = slide.querySelector('.ph-source').getBoundingClientRect();
					const shown = [...slide.querySelectorAll('.card-back > *')].filter((line) => getComputedStyle(line).display !== 'none');

					return {
						lines: shown.map((line) => {
							const box = line.getBoundingClientRect();

							return {
								clearOfLabel: box.bottom <= label.top,
								inside: box.top >= back.top && box.bottom <= back.bottom,
								// A clamped name shows at least one whole line.
								tallEnough: box.height >= parseFloat(getComputedStyle(line).lineHeight) - 1,
								text: line.textContent,
							};
						}),
						shownText: shown.map((line) => line.textContent),
					};
				});
			});

			for (const {lines, shownText} of results) {
				assert.equal(shownText.at(-1), 'No image in the catalog', 'the status line is shown');
				assert.ok(shownText.some((text) => text.startsWith('#')), 'the number is shown');
				assert.ok(!shownText.includes('Test set with a long name') && !shownText.includes('Test set'), 'the set is in the facts beside the art, not here');

				for (const line of lines) {
					assert.ok(line.clearOfLabel, `"${line.text}" ends above the Official label`);
					assert.ok(line.inside, `"${line.text}" stays inside the card back`);
					assert.ok(line.tallEnough, `"${line.text}" is not squeezed`);
				}
			}

			await page.screenshot({path: `/tmp/card-back-badge-${width}-${scale}.png`});
			assert.deepEqual(errors, []);
			await context.close();
		});
	}
});
