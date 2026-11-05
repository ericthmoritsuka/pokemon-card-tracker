// A Korean card in the scanner (Eric, 2026-11-04): Korean copies sit on
// Japanese catalog records that mostly have no image, so neither the
// picture nor, when it does not read, the number can find them; the name
// strip read with the Korean model (js/scan/cjk.js, read.js readName) can.
// Here a tray card whose read found only a Korean name, as the OCR would
// give it, is left in the draft before Scan opens; the scanner looks it up
// (js/scan/match.js findCandidates, the Korean name against
// js/scan/asian-names.json) and offers the Japanese record, never sure on a
// name alone.
//
// Headless Chromium against tests/scan-harness.mjs, with the canvas camera of
// tests/scan-scene.mjs showing an empty table. TCGdex is answered by the
// invented records below, every other outside request is refused, and
// Supabase is never reached.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/scan-cjk-browser.test.mjs

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {startScanHarness} from './scan-harness.mjs';
import {sceneCamera} from './scan-scene.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';

let harness;
let browser;

before(async () => {
	harness = await startScanHarness();
	browser = await chromium.launch();
});

after(async () => {
	await browser.close();
	await harness.close();
});

// The Japanese catalog's M6, invented down to two cards with no images (as
// TCGdex lists M6), and no Korean prints of Heracross.
const M6 = {
	cardCount: {firstEd: 0, holo: 0, normal: 2, official: 76, reverse: 0, total: 113},
	cards: [{id: 'M6-001', localId: '001', name: 'ヘラクロス'}, {id: 'M6-002', localId: '002', name: 'アメタマ'}],
	id: 'M6',
	name: 'ストームエメラルダ',
	releaseDate: '2026-09-26',
	serie: {id: 'M', name: 'MEGA'},
};
const ANSWERS = [
	[/\/v2\/ja\/series$/, [{id: 'M', name: 'MEGA'}]],
	[/\/v2\/ja\/series\/M$/, {id: 'M', name: 'MEGA', sets: [{cardCount: {official: 76, total: 113}, id: 'M6', name: 'ストームエメラルダ'}]}],
	[/\/v2\/ja\/sets\?/, [{id: 'M6', name: 'ストームエメラルダ'}]],
	[/\/v2\/ja\/sets\/M6$/, M6],
	[/\/v2\/ja\/cards\?dexId=eq:214$/, [{id: 'M6-001', localId: '001', name: 'ヘラクロス'}]],
	[/\/v2\/ja\/cards\/M6-001$/, {category: 'Pokemon', dexId: [214], hp: 130, id: 'M6-001', localId: '001', name: 'ヘラクロス', set: {id: 'M6', name: 'ストームエメラルダ'}, variants: {firstEdition: false, holo: false, normal: true, reverse: false}}],
	[/\/v2\/ko\/series$/, []],
	[/\/v2\/ko\/sets\?/, []],
	[/\/v2\/ko\/cards\?dexId=eq:214$/, []],
];

async function open() {
	const context = await browser.newContext({deviceScaleFactor: 2.8125, viewport: {height: 780, width: 384}});
	const asked = [];
	const refused = [];

	await context.grantPermissions(['camera'], {origin: harness.origin});
	await context.route((url) => url.origin !== harness.origin, async (route) => {
		const url = route.request().url();
		const answer = /^https:\/\/api\.tcgdex\.net\//.test(url) ? ANSWERS.find(([pattern]) => pattern.test(url)) : null;

		if (answer) {
			asked.push(url);

			return route.fulfill({body: JSON.stringify(answer[1]), contentType: 'application/json', headers: {'access-control-allow-origin': '*'}, status: 200});
		}

		refused.push(url);

		return route.abort('internetdisconnected');
	});
	await context.addInitScript(sceneCamera, {height: 3840, width: 2160});
	await context.addInitScript(() => localStorage.setItem('card-tracker:scan-holder', 'off'));

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(String(err)));

	// The tray card, written before Scan opens: its read found a Korean name
	// and no number (summariseRead's shape), and it waits to be looked up.
	await page.goto(`${harness.origin}${BASE}cards`);
	await page.evaluate(async () => {
		const draft = await import('/pokemon-card-tracker/js/scan/draft.js');
		const S = await import('/pokemon-card-tracker/js/scan/session.js');
		const session = S.newSession();
		const item = S.addCapture(session, {id: 'korean-1'});

		item.read = S.summariseRead({
			language: {code: 'non-latin', confidence: 0.2, source: 'no Latin label read'},
			name: {confidence: 0.86, lang: 'ko', script: 'ko', suffix: null, text: '헤라크로스'},
			number: null,
		});
		item.status = 'matching';
		await draft.saveSession(session);
	});
	await page.goto(`${harness.origin}${BASE}scan`);
	await page.waitForSelector('#scan-shutter:not([disabled])', {timeout: 30000});

	return {asked, context, errors, page, refused};
}

describe('a Korean name read finds the Japanese record a Korean copy sits on', () => {
	test('the card is offered, its name read shown, and it needs a look', async () => {
		const {asked, context, errors, page, refused} = await open();

		// The tray card once it has been looked up, as the draft keeps it
		// (polled in the page: waitForFunction takes an async function's
		// promise for a true answer).
		const item = await page.evaluate(async () => {
			const draft = await import('/pokemon-card-tracker/js/scan/draft.js');
			const end = Date.now() + 30000;

			while (Date.now() < end) {
				const session = await draft.loadSession();
				const found = session && session.items.find((one) => one.id === 'korean-1');

				if (found && found.status === 'ready' && found.candidates && found.candidates.length) {
					return found;
				}

				await new Promise((resolve) => setTimeout(resolve, 250));
			}

			return null;
		});

		assert.ok(item, 'the tray card was looked up within 30 s');
		// One clue (the name) offers the record to tap; it is not shown as the
		// card before a tap (session.js isLead) and never sure.
		assert.deepEqual(item.candidates.map((c) => c.id), ['M6-001'], JSON.stringify({asked, refused}));
		assert.equal(item.candidates[0].lang, 'ja');
		assert.equal(item.candidates[0].id, 'M6-001');
		assert.ok(item.candidates[0].reasons.includes('name'));
		assert.equal(item.sure, false, 'a name alone never makes a card sure');
		assert.equal(item.names[0].name, 'Heracross');
		assert.equal(item.names[0].spelling, '헤라크로스');
		assert.ok(asked.some((url) => /\/ko\/cards\?dexId=eq:214$/.test(url)), 'the Korean catalog is asked first');
		assert.ok(asked.some((url) => /\/ja\/cards\?dexId=eq:214$/.test(url)));
		assert.ok(!asked.concat(refused).some((url) => /traineddata/.test(url)), 'no model is loaded for a card whose name was already read');
		assert.ok(!refused.some((url) => /supabase/.test(url)), 'Supabase is never asked');

		// The tray tile needs a look, and its sheet shows the name as read.
		const tile = page.locator('#scan-tray [data-item="korean-1"]');

		await tile.waitFor();
		assert.match(await tile.getAttribute('class'), /is-look/);
		await tile.click();
		await page.waitForSelector('#scan-confirm');
		assert.equal(await page.locator('#scan-confirm .scan-candidate[data-card="M6-001"]').count(), 1);
		assert.match(await page.locator('#scan-confirm').textContent(), /헤라크로스/);
		await page.screenshot({path: '/tmp/scan-cjk-korean.png'});
		assert.deepEqual(errors, []);
		await context.close();
	});
});
