// Browser test for snapping in the corner editor (js/corners.js), shared by
// card photos and binder covers. Headless Chromium at 360 x 740 against a
// page made here: a drawn card on a dark canvas, and the real corner
// editor. No network, no Supabase.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/corner-snap-browser.test.mjs

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {startPagesServer} from './pages-server.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const PAGE = `${BASE}corner-snap-test.html`;

// An 800 x 1000 picture: the card's corners at (250, 290) to (550, 709), a
// caller's own snap point at (150, 850), and the handles starting off the
// card.
const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>
body { margin: 16px; }
.ph-stage { position: relative; }
.ph-photo, .ph-outline { left: 0; position: absolute; top: 0; }
.ph-handle { border: 0; height: 48px; left: -24px; padding: 0; position: absolute; top: -24px; touch-action: none; width: 48px; }
</style></head>
<body><main id="host"></main>
<script type="module">
window.buzz = [];
Object.defineProperty(navigator, 'vibrate', {configurable: true, value: (ms) => { window.buzz.push(ms); return true; }});

const {cornerEditor} = await import('${BASE}js/corners.js');
const source = document.createElement('canvas');
source.width = 800;
source.height = 1000;
const ctx = source.getContext('2d');
ctx.fillStyle = '#202428';
ctx.fillRect(0, 0, 800, 1000);
ctx.fillStyle = '#e8c840';
ctx.fillRect(250, 290, 300, 419);
for (let i = 0; i < 12; i++) {
	ctx.fillStyle = i % 2 ? '#3050a0' : '#d8d0c0';
	ctx.fillRect(272 + (i % 4) * 64, 330 + Math.floor(i / 4) * 110, 50, 90);
}
const editor = cornerEditor({
	corners: [{x: 200, y: 200}, {x: 600, y: 200}, {x: 600, y: 800}, {x: 200, y: 800}],
	marks: true,
	snapPoints: [{x: 150, y: 850}],
	source,
});
document.getElementById('host').append(editor.stage, editor.snapToggle);
editor.layout();
window.editor = editor;
window.ready = true;
</script></body></html>`;

let server;
let browser;
let page;

before(async () => {
	server = await startPagesServer();
	server.setOverride((pathname) => (pathname === PAGE ? HTML : null));
	browser = await chromium.launch();
	page = await browser.newPage({viewport: {height: 740, width: 360}});
	await page.goto(`${server.origin}${PAGE}`);
	await page.waitForFunction(() => window.ready === true);
});

after(async () => {
	await browser.close();
	await server.close();
});

const corner = (i) => page.$eval(`.ph-handle[data-corner="${i}"]`, (el) => ({snapped: el.dataset.snapped, x: Number(el.dataset.x), y: Number(el.dataset.y)}));
const scale = () => page.$eval('.ph-photo', (el) => el.getBoundingClientRect().width / 800);

// Presses on handle i and moves the finger by `path` (source pixels from
// where it started), one move per step; the caller releases.
async function dragBy(i, path) {
	const box = await page.locator(`.ph-handle[data-corner="${i}"]`).boundingBox();
	const x = box.x + box.width / 2;
	const y = box.y + box.height / 2;
	const s = await scale();

	await page.mouse.move(x, y);
	await page.mouse.down();

	for (const [dx, dy] of path) {
		await page.mouse.move(x + dx * s, y + dy * s, {steps: 3});
	}
}

describe('snapping in the corner editor', () => {
	test('the snap points hold the card\'s corners and the caller\'s own point', async () => {
		const points = await page.evaluate(() => window.editor.snapPoints);
		const near = (x, y) => Math.min(...points.map((p) => Math.hypot(p.x - x, p.y - y)));

		assert.ok(near(150, 850) < 0.5, 'the caller\'s point');

		for (const [x, y] of [[250, 290], [550, 290], [550, 709], [250, 709]]) {
			assert.ok(near(x, y) <= 8, `card corner (${x}, ${y}): nearest ${near(x, y).toFixed(1)}`);
		}
	});

	test('a corner dragged near a snap point jumps onto it with a buzz, and further on lets go', async () => {
		const points = await page.evaluate(() => window.editor.snapPoints);
		const target = points.reduce((best, p) => (Math.hypot(p.x - 550, p.y - 290) < Math.hypot(best.x - 550, best.y - 290) ? p : best));

		// From (600, 200) to about 12 px from the card's top-right corner.
		await dragBy(1, [[-30, 50], [-58, 98]]);

		let now = await corner(1);

		// The finger is at about (542, 298); the corner sits exactly on a
		// snap point at the card's corner, the one nearest the finger.
		const on = points.find((p) => Math.abs(now.x - p.x) < 0.1 && Math.abs(now.y - p.y) < 0.1);

		assert.equal(now.snapped, 'true');
		assert.ok(on, `on a snap point: (${now.x}, ${now.y})`);
		assert.ok(Math.hypot(on.x - 550, on.y - 290) <= 8, `at the card's corner: (${now.x}, ${now.y})`);
		// One buzz for each snap point it jumped onto on the way.
		const buzz = await page.evaluate(() => window.buzz);

		assert.ok(buzz.length >= 1 && buzz.every((ms) => ms === 10), JSON.stringify(buzz));

		// On to (660, 180), up and right off the card, 100 px from any snap point.
		await page.mouse.move(...await (async () => {
			const box = await page.locator('.ph-photo').boundingBox();
			const s = await scale();

			return [box.x + 660 * s, box.y + 180 * s];
		})(), {steps: 4});
		await page.mouse.up();
		now = await corner(1);

		assert.equal(now.snapped, 'false');
		assert.ok(Math.hypot(now.x - target.x, now.y - target.y) > 60, `let go: (${now.x}, ${now.y})`);
		assert.deepEqual(await page.evaluate(() => window.buzz), buzz, 'no buzz once let go');
	});

	test('a corner dragged far from every snap point moves with the finger', async () => {
		const start = await corner(3);

		await dragBy(3, [[20, -20], [40, -40]]);
		await page.mouse.up();

		const now = await corner(3);

		assert.equal(now.snapped, 'false');
		assert.ok(Math.abs(now.x - (start.x + 40)) < 1.5 && Math.abs(now.y - (start.y - 40)) < 1.5, `moved by the drag: (${now.x}, ${now.y})`);
	});

	test('arrow keys never snap, even onto a snap point', async () => {
		// Corner 0 is at (200, 200); the caller's point is at (150, 850), and
		// the card's top-left at (250, 290). Shift+ArrowRight and ArrowDown
		// walk it across the card's corner in 10 screen pixel steps.
		const s = await scale();
		const step = 10 / s;
		const start = await corner(0);
		const buzz = await page.evaluate(() => window.buzz.length);

		await page.focus('.ph-handle[data-corner="0"]');

		const steps = Math.round(90 / step);

		for (let k = 0; k < steps; k++) {
			await page.keyboard.press('Shift+ArrowDown');
			await page.keyboard.press('Shift+ArrowRight');
		}

		const now = await corner(0);

		assert.equal(now.snapped, 'false');
		assert.ok(Math.abs(now.x - (start.x + steps * step)) < 0.2 && Math.abs(now.y - (start.y + steps * step)) < 0.2, `moved by the keys alone: (${now.x}, ${now.y})`);
		assert.equal(await page.evaluate(() => window.buzz.length), buzz, 'no buzz from the keys');
	});

	test('the Snap button turns snapping off: a corner then moves with the finger, and the phone remembers', async () => {
		const toggle = page.locator('.ph-snap');

		assert.equal(await toggle.textContent(), 'Snap');
		assert.equal(await toggle.getAttribute('aria-pressed'), 'true', 'on by default');
		await toggle.click();
		assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
		assert.equal(await page.evaluate(() => localStorage.getItem('cardTracker.cornerSnap')), 'off');

		// Corner 2 from (600, 800) to about 10 px from the card's bottom-right
		// corner (550, 709): it lands where the finger is.
		const start = await corner(2);
		const buzz = await page.evaluate(() => window.buzz.length);

		await dragBy(2, [[-20, -40], [-42, -83]]);
		await page.mouse.up();

		const now = await corner(2);

		assert.equal(now.snapped, 'false');
		assert.ok(Math.abs(now.x - (start.x - 42)) < 1.5 && Math.abs(now.y - (start.y - 83)) < 1.5, `moved by the drag alone: (${now.x}, ${now.y})`);
		assert.equal(await page.evaluate(() => window.buzz.length), buzz, 'no buzz');

		// A new editor (another photo, a cover) starts with snapping off.
		await page.reload();
		await page.waitForFunction(() => window.ready === true);
		assert.equal(await toggle.getAttribute('aria-pressed'), 'false', 'remembered');
		await toggle.click();
		assert.equal(await page.evaluate(() => localStorage.getItem('cardTracker.cornerSnap')), 'on');
		await dragBy(2, [[-20, -40], [-42, -83]]);
		await page.mouse.up();
		assert.equal((await corner(2)).snapped, 'true', 'snaps again once turned back on');
	});

	test('a page that cannot keep the choice still opens, with snapping on', async () => {
		await page.addInitScript(() => {
			Object.defineProperty(window, 'localStorage', {get() {
				throw new Error('blocked');
			}});
		});
		await page.reload();
		await page.waitForFunction(() => window.ready === true);
		assert.equal(await page.locator('.ph-snap').getAttribute('aria-pressed'), 'true');
		await page.locator('.ph-snap').click();
		assert.equal(await page.locator('.ph-snap').getAttribute('aria-pressed'), 'false');
	});
});
