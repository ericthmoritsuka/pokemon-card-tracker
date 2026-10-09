// Holder mode and the card found anywhere in the frame (Eric, 2026-10-09),
// in headless Chromium, against tests/scan-harness.mjs (Supabase is never
// reached; TCGdex answers are replayed from the harness cache).
//
// The camera is tests/scan-scene.mjs's canvas: the phone held still over an
// open white box, cards falling in one after another and piling up, each
// landing a little off the last so the top strip of the card beneath
// shows, a card larger than the guide, one off to the side, and a pile so
// high the card on top runs off the frame.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/scan-holder-browser.test.mjs

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {cardImage, routeTcgdex, startScanHarness} from './scan-harness.mjs';
import {sceneCamera} from './scan-scene.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const CARDS = {a: 'me01-001', b: 'sv03.5-025', c: 'swsh3-102'};
const FRAME = {height: 3840, width: 2160};

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

// A taller screen than the other suites', so the camera shows more than the
// guide above and below it: room for a card larger than the guide.
async function open({holder = true, record = true, viewport = {height: 900, width: 384}} = {}) {
	const context = await browser.newContext({deviceScaleFactor: 2.8125, viewport});

	await context.grantPermissions(['camera'], {origin: harness.origin});
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await routeTcgdex(context);

	for (const [key, id] of Object.entries(CARDS)) {
		await context.route(`**/__test-card${key === 'a' ? '' : `-${key}`}.webp`, async (route) => route.fulfill({contentType: 'image/webp', path: await cardImage(id)}));
	}

	await context.addInitScript(sceneCamera, FRAME);
	// Set once: a reload keeps what the switch made it.
	await context.addInitScript(({holder: on, record: log}) => {
		if (localStorage.getItem('card-tracker:scan-holder') === null) {
			localStorage.setItem('card-tracker:scan-holder', on ? 'on' : 'off');
		}

		if (log) {
			localStorage.setItem('card-tracker:scan-log', 'on');
		}
	}, {holder, record});

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(String(err)));
	await page.goto(`${harness.origin}${BASE}scan`);
	await page.waitForSelector('#scan-guide:not([hidden])', {timeout: 30000});
	await page.waitForFunction(() => document.getElementById('scan-video').videoWidth > 0);
	await page.waitForSelector('#scan-shutter:not([disabled])');

	return {context, errors, page};
}

const setScene = (page, scene) => page.evaluate((next) => {
	window.scene = next;
}, scene);

const captures = (page) => page.evaluate(async () => (await import('/pokemon-card-tracker/js/scan/view.js')).scanStats.captures);

const items = (page) => page.evaluate(async () => {
	const session = await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession();

	return session ? session.items.map((item) => ({card: item.card && item.card.id, geometry: item.report && item.report.geometry, id: item.id, rectify: item.report && item.report.rectify, picture: item.report && item.report.picture && {how: item.report.picture.how, top: item.report.picture.groups.slice(0, 2)}, status: item.status, sure: item.sure, why: item.why})) : [];
});

async function until(check, what, timeout = 30000) {
	const end = Date.now() + timeout;

	while (!(await check())) {
		assert.ok(Date.now() < end, what);
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
}

// Drops `card` onto the pile: it falls from above the frame to its place
// in seven steps a frame of the camera apart (60 ms, the page's own timer,
// so the test's round trips cannot hold it mid-air), turning as it goes,
// and lies still. Resolves with the captures counted at each step.
function drop(page, pile, card) {
	return page.evaluate(async ({below, falling}) => {
		const view = await import('/pokemon-card-tracker/js/scan/view.js');
		const counts = [];

		for (let step = 6; step >= 0; step--) {
			window.scene = {background: 'box', cards: [...below, {...falling, angle: (falling.angle || 0) + step * 4, dy: (falling.dy || 0) - step * 0.16}]};
			await new Promise((resolve) => setTimeout(resolve, 60));
			counts.push(view.scanStats.captures);
		}

		return counts;
	}, {below: pile, falling: card});
}

describe('holder mode: cards dropped into a box under a phone held still', () => {
	test('each card dropped is taken once, after it settles, the top card of the pile is cut, and a card larger than the guide or beside it is found', async () => {
		const {context, errors, page} = await open();

		assert.equal(await page.getAttribute('#scan-holder', 'aria-checked'), 'true', 'holder mode remembered');
		assert.equal(await page.getAttribute('#scan-holder', 'role'), 'switch');

		// The empty box: its walls run off the frame, and nothing is taken.
		await setScene(page, {background: 'box', cards: []});
		await page.waitForTimeout(1500);
		assert.equal(await captures(page), 0, 'the empty box is never taken');

		// Each card a little larger as the pile rises, landing a little off
		// the one beneath (its top strip shows), the third larger than the
		// guide; then the box is emptied, and a smaller card lands off to the
		// side of the floor.
		const drops = [
			{card: 'a', size: 0.86},
			{angle: 2, card: 'b', dx: 0.02, dy: 0.06, size: 0.9},
			{angle: -3, card: 'c', dy: 0.08, size: 1.06},
			{angle: 4, card: 'a', dx: 0.15, dy: -0.12, empty: true, size: 0.55},
		];
		let pile = [];

		for (const [index, {empty, ...card}] of drops.entries()) {
			if (empty) {
				pile = [];
				await setScene(page, {background: 'box', cards: []});
				await page.waitForTimeout(1500);
				assert.equal(await captures(page), index, 'the emptied box is not taken');
			}

			const counts = await drop(page, pile, card);

			assert.ok(counts.every((count) => count === index), `drop ${index + 1}: nothing taken while it fell (${counts.join(', ')})`);
			await until(async () => (await captures(page)) === index + 1, `drop ${index + 1} taken after it settled`, 8000);
			pile.push(card);
			await until(async () => {
				const list = await items(page);

				return list.length === index + 1 && list[index].status !== 'reading' && list[index].status !== 'matching';
			}, `drop ${index + 1} read`, 60000);
			await page.waitForTimeout(1200);
			assert.equal(await captures(page), index + 1, `drop ${index + 1}: taken once`);
		}

		const list = await items(page);

		assert.deepEqual(list.map((item) => item.card), drops.map((card) => CARDS[card.card]), `each card on top of the pile was matched: ${JSON.stringify(list.map(({card, picture, rectify, status, why}) => ({card, picture, rectify, status, why})))}`);

		for (const [index, item] of list.entries()) {
			assert.ok(item.geometry.card, `drop ${index + 1}: the card was found in the frame`);
			assert.equal(item.geometry.holder, true);
			assert.ok(item.geometry.settleMs >= 300, `drop ${index + 1}: still for ${item.geometry.settleMs} ms`);
			assert.ok(item.rectify.found, `drop ${index + 1}: edges found`);
			assert.ok(Math.abs(item.rectify.ratio - 0.716) < 0.03, `drop ${index + 1}: the crop is one card, ${item.rectify.ratio} wide for its height`);
		}

		// The third card larger than the guide, the fourth off to the side.
		const [frameW, frameH] = list[2].geometry.frame.split(' x ').map(Number);
		const guideH = Number(list[2].geometry.guide.split(' x ')[1].split(' ')[0]);

		assert.ok(list[2].geometry.card.h * frameH > guideH, `the third card is larger than the guide (${Math.round(list[2].geometry.card.h * frameH)} px against ${guideH})`);
		assert.ok((list[3].geometry.card.x + list[3].geometry.card.w / 2) * frameW > frameW * 0.55, 'the fourth card is off to the right');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a pile so high the card on top runs off the frame says so and is not taken; the empty box is not taken either', async () => {
		const {context, errors, page} = await open({record: false});

		await setScene(page, {background: 'box', cards: [{card: 'a', dy: 0.25, size: 1.3}]});
		await page.waitForFunction(() => document.getElementById('scan-hint').textContent === 'Pile too high: empty the box.', null, {polling: 100, timeout: 8000});
		await page.waitForTimeout(1500);
		assert.equal(await captures(page), 0, 'not taken');
		assert.match(await page.locator('#scan-live').textContent(), /Pile too high/);

		await setScene(page, {background: 'box', cards: []});
		await page.waitForTimeout(1500);
		assert.equal(await captures(page), 0);
		assert.notEqual(await page.locator('#scan-hint').textContent(), 'Pile too high: empty the box.');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('the switch turns holder mode off and on, and is remembered', async () => {
		const {context, errors, page} = await open({holder: false, record: false});

		assert.equal(await page.getAttribute('#scan-holder', 'aria-checked'), 'false');
		assert.ok((await page.locator('#scan-holder').boundingBox()).height >= 44, 'at least 44 px tall');
		await page.click('#scan-holder');
		assert.equal(await page.getAttribute('#scan-holder', 'aria-checked'), 'true');
		assert.equal(await page.evaluate(() => localStorage.getItem('card-tracker:scan-holder')), 'on');
		await page.reload();
		await page.waitForSelector('#scan-holder');
		assert.equal(await page.getAttribute('#scan-holder', 'aria-checked'), 'true');
		assert.deepEqual(errors, []);
		await context.close();
	});
});

describe('the shutter waits a moment for a whole card (Eric\'s log, version 32)', () => {
	test('a card that appears 400 ms after the press is the one taken; with no card at all, the picture is taken anyway after about a second', async () => {
		const {context, errors, page} = await open({holder: false});

		await setScene(page, {kind: 'table'});
		await page.waitForTimeout(800);
		// The card comes into view 400 ms after the press, timed in the page.
		await page.evaluate(() => {
			document.getElementById('scan-shutter').addEventListener('click', () => setTimeout(() => {
				window.scene = {cards: [{card: 'b', size: 0.9}]};
			}, 400), {once: true});
		});
		await page.click('#scan-shutter');
		await until(async () => (await captures(page)) === 1, 'the shutter took a picture', 5000);
		await until(async () => {
			const list = await items(page);

			return list.length === 1 && list[0].status === 'ready';
		}, 'the card read', 60000);

		let list = await items(page);

		assert.equal(list[0].card, CARDS.b, 'the card that appeared');
		assert.equal(list[0].geometry.shutterFound, true);
		assert.ok(list[0].geometry.shutterWaitMs >= 300 && list[0].geometry.shutterWaitMs < 2000, `waited ${list[0].geometry.shutterWaitMs} ms`);

		// No card at all: the shutter still takes the picture, after the wait.
		await setScene(page, {kind: 'table'});
		await page.waitForTimeout(800);

		const pressed = Date.now();

		await page.click('#scan-shutter');
		await until(async () => (await captures(page)) === 2, 'the shutter always takes a picture', 5000);
		assert.ok(Date.now() - pressed >= 900, 'after the wait');
		await page.waitForFunction(() => /did not look like a card/.test(document.getElementById('scan-note').textContent), null, {polling: 200, timeout: 60000});

		const entries = await page.evaluate(async () => (await import('/pokemon-card-tracker/js/scan/log.js')).listEntries());
		const last = entries[entries.length - 1];

		assert.equal(last.report.geometry.shutterFound, false);
		assert.ok(last.report.geometry.shutterWaitMs >= 900);
		list = await items(page);
		assert.equal(list.length, 1, 'a frame with no card does not join the tray');
		assert.deepEqual(errors, []);
		await context.close();
	});
});
