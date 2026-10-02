// Browser tests for binder spreads and the page turn (js/binder-spread.js),
// cover images (js/binder-cover.js), and presets (js/binder-presets.js), in
// headless Chromium against tests/binder-spread-harness.mjs: a 9-pocket zip
// binder with cards, a placeholder, and a pocket left empty on purpose.
//
// Phones are 360 x 740 portrait and 740 x 360 landscape, with touch. Swipes
// are real touch sequences sent through the DevTools protocol. Supabase is
// tests/photos-fake-storage.mjs (the fake project plus the card-photos
// bucket with supabase/photos.sql's rules), never the real one; card images
// are a few real TCGdex scans fetched once by Node, or drawn stand-ins.
//
// Screenshots go to /tmp/spread-*.png (SHOTS to change the folder).
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/binder-spread-browser.test.mjs

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {HARNESS_PATH, routeHarness, startHarness} from './binder-spread-harness.mjs';
import {FakeStorageSupabase} from './photos-fake-storage.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const PORTRAIT = {height: 740, width: 360};
const LANDSCAPE = {height: 360, width: 740};
const SHOTS = process.env.SHOTS || '/tmp';

let harness;
let browser;
const images = new Map();

before(async () => {
	harness = await startHarness();
	browser = await chromium.launch();

	for (let n = 1; n <= 16; n++) {
		try {
			const response = await fetch(`https://assets.tcgdex.net/en/base/base1/${n}/low.webp`);

			if (response.ok) {
				images.set(String(n), Buffer.from(await response.arrayBuffer()));
			}
		}
		catch {
			// A drawn stand-in instead.
		}
	}

	if (!images.size) {
		console.log('# TCGdex was not reachable: pockets show drawn stand-in cards.');
	}
});

after(async () => {
	await browser.close();
	await harness.close();
});

const standIn = (n) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="245" height="342"><rect width="245" height="342" rx="12" fill="hsl(${n * 37} 55% 55%)"/><rect x="16" y="40" width="213" height="140" fill="#ffffff55"/><text x="20" y="30" font-size="20" font-family="sans-serif">Card ${n}</text></svg>`);

async function device(fake, {reducedMotion = 'no-preference', user = null, viewport = PORTRAIT} = {}) {
	const context = await browser.newContext({deviceScaleFactor: 2, hasTouch: true, isMobile: true, reducedMotion, viewport});
	const errors = [];

	await fake.attach(context, 'phone');

	// Any other Supabase host would be the real service: never reached.
	await context.route(/supabase\.(co|in)/, (route) => (route.request().url().startsWith('https://ehdkbxrjxsypegbtrxbw.supabase.co') ? route.fallback() : route.abort()));
	await routeHarness(context, harness.origin);
	await context.route('https://assets.tcgdex.net/**', (route) => {
		const n = /base1\/(\d+)\//.exec(route.request().url());
		const bytes = n && images.get(n[1]);

		return bytes
			? route.fulfill({body: bytes, contentType: 'image/webp', headers: {'access-control-allow-origin': '*'}})
			: route.fulfill({body: standIn(n ? Number(n[1]) : 0), contentType: 'image/svg+xml'});
	});

	if (user) {
		await context.addInitScript((value) => {
			if (!localStorage.getItem('card-tracker-auth')) {
				localStorage.setItem('card-tracker-auth', value);
			}
		}, JSON.stringify(fake.session(user)));
	}

	const page = await context.newPage();

	page.on('pageerror', (err) => errors.push(String(err)));
	page.on('console', (message) => {
		if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) {
			errors.push(message.text());
		}
	});

	return {context, errors, page};
}

async function open(page, query = '') {
	await page.goto(`${harness.origin}${HARNESS_PATH}${query}`);
	await page.waitForFunction(() => document.body.dataset.ready);

	const [ready, error] = await page.evaluate(() => [document.body.dataset.ready, document.body.dataset.error]);

	assert.equal(ready, 'true', error);
	await settle(page);
}

// Images decoded and no turn running.
async function settle(page) {
	await page.waitForFunction(() => !document.querySelector('#binder-spread[data-turning]'));
	await page.evaluate(() => Promise.all([...document.querySelectorAll('#binder-spread img')].map((img) => (img.complete ? null : new Promise((done) => {
		img.addEventListener('load', done, {once: true});
		img.addEventListener('error', done, {once: true});
		setTimeout(done, 1500);
	})))));
}

const shot = (page, name) => page.screenshot({path: `${SHOTS}/spread-${name}.png`});

const state = (page) => page.evaluate(() => {
	const root = document.getElementById('binder-spread');
	const params = new URLSearchParams(window.location.search);

	return {
		label: document.getElementById(root.dataset.zoom ? 'bs-zoom-label' : 'bs-label').textContent,
		left: (root.querySelector('.bs-side-left > .bs-page') || {}).dataset?.page || null,
		mode: root.dataset.mode,
		page: params.get('page'),
		right: (root.querySelector('.bs-side-right > .bs-page') || {}).dataset?.page || null,
		spread: root.dataset.spread,
		urlSpread: params.get('spread'),
		view: root.dataset.view,
		zoom: root.dataset.zoom,
	};
});

// A real touch swipe across the stage, through the DevTools protocol, so the
// browser makes the pointer events itself.
async function swipe(page, dx, {y = null} = {}) {
	const box = await page.locator('#bs-stage').boundingBox();
	const startX = dx < 0 ? box.x + box.width * 0.8 : box.x + box.width * 0.2;
	const startY = y ?? box.y + box.height * 0.5;
	const cdp = await page.context().newCDPSession(page);

	await cdp.send('Input.dispatchTouchEvent', {touchPoints: [{x: startX, y: startY}], type: 'touchStart'});

	for (let i = 1; i <= 8; i++) {
		await cdp.send('Input.dispatchTouchEvent', {touchPoints: [{x: startX + (dx * i) / 8, y: startY + i}], type: 'touchMove'});
	}

	await cdp.send('Input.dispatchTouchEvent', {touchPoints: [], type: 'touchEnd'});
	await cdp.detach();
}

async function noRings(page) {
	const found = await page.evaluate(() => window.H.ringLike());

	assert.deepEqual(found, [], `ring-like elements: ${found.join(', ')}`);
}

describe('spreads on a phone held upright', () => {
	const fake = new FakeStorageSupabase();
	let phone;

	before(async () => {
		phone = await device(fake);
		await open(phone.page);
	});

	after(() => phone.context.close());

	test('opens on the inside cover and page 1, as an overview', async () => {
		const {page} = phone;
		const s = await state(page);

		assert.equal(s.spread, '1');
		assert.equal(s.left, null);
		assert.equal(s.right, '1');
		assert.equal(s.mode, 'overview');
		assert.equal(s.label, 'Page 1 of 40');
		assert.equal(await page.locator('.bs-side-left .bs-inside').count(), 1);
		assert.equal(await page.locator('#binder-spread[data-swipe-own]').count(), 1);
		// The overview's pockets do not take taps: the page opens instead.
		assert.equal(await page.locator('.bs-side-right .bs-grid[inert]').count(), 1);
		assert.equal(await page.locator('.bs-side-right .bs-open').count(), 1);
		assert.equal(await page.locator('.bs-side-right .bs-pocket').count(), 9);
		assert.equal(await page.locator('.bs-side-right .bs-pocket .pocket-card').count(), 8);
		assert.ok(await page.locator('#bs-hint').isVisible(), 'the sideways hint shows');
		await noRings(page);
		await shot(page, 'portrait-cover');
	});

	test('swipes and edge arrows turn the page, forward and back, with the URL', async () => {
		const {page} = phone;

		await swipe(page, -160);
		await page.waitForFunction(() => document.getElementById('binder-spread').dataset.turning === 'forward');
		await page.waitForTimeout(110);
		await shot(page, 'turn-mid');

		const midLeaf = await page.evaluate(() => {
			const leaf = document.querySelector('.bs-leaf');

			return leaf ? {front: leaf.querySelector('.bs-face-front .bs-page').dataset.page, back: leaf.querySelector('.bs-face-back .bs-page').dataset.page, transform: getComputedStyle(leaf).transform} : null;
		});

		assert.ok(midLeaf, 'a leaf turns');
		assert.equal(midLeaf.front, '1', 'the leaf\'s front is the page being turned');
		assert.equal(midLeaf.back, '2', 'its back is the next left page');
		assert.match(midLeaf.transform, /^matrix3d/, 'the leaf turns in 3D');

		await settle(page);
		let s = await state(page);

		assert.deepEqual([s.spread, s.left, s.right, s.urlSpread, s.label], ['2', '2', '3', '2', 'Pages 2 and 3 of 40']);
		assert.equal(await page.locator('.bs-leaf').count(), 0, 'the leaf is gone once it lands');
		await shot(page, 'portrait-spread-2');

		await page.click('#bs-next');
		await settle(page);
		s = await state(page);
		assert.deepEqual([s.spread, s.left, s.right, s.urlSpread], ['3', '4', '5', '3']);

		await page.click('#bs-prev');
		await settle(page);
		s = await state(page);
		assert.deepEqual([s.spread, s.left, s.right], ['2', '2', '3']);

		await swipe(page, 160);
		await settle(page);
		s = await state(page);
		assert.deepEqual([s.spread, s.urlSpread], ['1', null]);
		assert.equal(await page.locator('#bs-prev').isDisabled(), true);

		// A vertical drag is a scroll, not a turn.
		const cdp = await page.context().newCDPSession(page);
		const box = await page.locator('#bs-stage').boundingBox();

		await cdp.send('Input.dispatchTouchEvent', {touchPoints: [{x: box.x + 100, y: box.y + 150}], type: 'touchStart'});
		await cdp.send('Input.dispatchTouchEvent', {touchPoints: [{x: box.x + 120, y: box.y + 20}], type: 'touchMove'});
		await cdp.send('Input.dispatchTouchEvent', {touchPoints: [], type: 'touchEnd'});
		await cdp.detach();
		await settle(page);
		assert.equal((await state(page)).spread, '1');
	});

	test('a reload keeps the spread', async () => {
		const {page} = phone;

		await page.click('#bs-next');
		await settle(page);
		await page.click('#bs-next');
		await settle(page);
		await page.reload();
		await page.waitForFunction(() => document.body.dataset.ready);
		await settle(page);

		const s = await state(page);

		assert.deepEqual([s.spread, s.left, s.right], ['3', '4', '5']);
		// Pages 4 and 5 are empty but for nothing: all nine open pockets each.
		assert.equal(await page.locator('.bs-side-left .pocket-open').count(), 9);
		await page.selectOption('#bs-jump', '1');
		await settle(page);
	});

	test('quick turns queue up and land one after another', async () => {
		const {page} = phone;

		await page.evaluate(() => {
			const spread = window.H.spread();

			spread.turn(1);
			spread.turn(1);
		});
		await page.waitForFunction(() => document.getElementById('binder-spread').dataset.spread === '3' && !document.querySelector('.bs-leaf'));
		assert.equal((await state(page)).spread, '3');
		await page.selectOption('#bs-jump', '1');
	});

	test('a page turn runs near 60 fps (frame times reported)', async () => {
		const {page} = phone;
		const cdp = await page.context().newCDPSession(page);
		const measure = async (label) => {
			const gaps = await page.evaluate(async () => {
				const spread = window.H.spread();
				const all = [];

				for (const dir of [1, 1, -1, -1]) {
					all.push(...await window.H.frames(() => spread.turn(dir)));
				}

				return all;
			});
			// Frames while the leaf moves; the frames before it, while the
			// new pages are built, are reported apart.
			const moving = gaps.filter((row) => row.moving).map((row) => row.gap);
			const setup = gaps.filter((row) => !row.moving).map((row) => row.gap);
			const sorted = [...moving].sort((a, b) => a - b);
			const mean = moving.reduce((sum, gap) => sum + gap, 0) / moving.length;
			const p95 = sorted[Math.floor(sorted.length * 0.95)];
			const over = moving.filter((gap) => gap > 25).length;

			console.log(`# turn frame times, ${label}: ${moving.length} frames while the leaf moves over 4 turns, mean ${mean.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${sorted.at(-1).toFixed(1)} ms, ${over} over 25 ms; before it moves, the longest frame (building the new pages) ${Math.max(...setup).toFixed(1)} ms`);

			return {mean, p95};
		};

		const plain = await measure('unthrottled');

		await cdp.send('Emulation.setCPUThrottlingRate', {rate: 4});

		const slow = await measure('CPU throttled 4x (a mid-range phone)');

		await cdp.send('Emulation.setCPUThrottlingRate', {rate: 1});
		await cdp.detach();
		assert.ok(plain.mean < 20, `mean frame ${plain.mean.toFixed(1)} ms`);
		assert.ok(slow.mean < 25, `mean throttled frame ${slow.mean.toFixed(1)} ms`);
	});

	test('tapping a page zooms it; a pocket tap places a card through the handler; Back returns', async () => {
		const {page} = phone;

		await page.click('#bs-next');
		await settle(page);
		await page.click('.bs-side-left .bs-open');
		await settle(page);

		let s = await state(page);

		assert.deepEqual([s.view, s.zoom, s.page, s.urlSpread, s.label], ['page', '2', '2', '2', 'Page 2 of 40']);
		assert.equal(await page.locator('#bs-zoom-sheet .bs-grid[inert]').count(), 0, 'the zoomed page takes taps');
		assert.equal(await page.locator('#bs-zoom-sheet .bs-page[data-side="left"]').count(), 1);

		const width = await page.locator('#bs-zoom-sheet .bs-pocket').first().evaluate((node) => node.getBoundingClientRect().width);

		assert.ok(width >= 80, `a zoomed pocket is ${width} px wide`);

		const before = await page.evaluate(() => window.H.taps.length);

		await page.locator('#bs-zoom-sheet .bs-pocket[data-position="4"] button').tap();
		await page.waitForFunction(() => document.querySelector('#bs-zoom-sheet .bs-pocket[data-position="4"] .pocket-card'));
		await settle(page);

		const taps = await page.evaluate(() => window.H.taps);

		assert.equal(taps.length, before + 1);
		assert.deepEqual(taps.at(-1), {page: 2, position: 4});
		await noRings(page);
		await shot(page, 'zoom-placed');

		// The next page from the zoomed view, then Back to the spread.
		await page.click('#bs-zoom-next');
		await settle(page);
		s = await state(page);
		assert.deepEqual([s.zoom, s.urlSpread], ['3', '2']);
		await page.goBack();
		await settle(page);
		s = await state(page);
		assert.deepEqual([s.view, s.zoom, s.page, s.spread], ['spread', '', null, '2']);
		assert.equal(await page.locator('.bs-side-left .bs-pocket[data-position="4"] .pocket-card').count(), 1, 'the placed card shows in the spread');

		// The in-page Back button does the same.
		await page.click('.bs-side-right .bs-open');
		await page.click('#bs-zoom-back');
		await settle(page);
		assert.equal((await state(page)).view, 'spread');

		// Stepping past the spread's pages and going Back lands on the spread
		// holding the page last shown, not the one the zoom started from.
		await page.click('.bs-side-right .bs-open');
		await settle(page);
		await page.click('#bs-zoom-next');
		await settle(page);
		s = await state(page);
		assert.deepEqual([s.zoom, s.urlSpread], ['4', '3']);
		await page.goBack();
		await settle(page);
		s = await state(page);
		assert.deepEqual([s.view, s.spread, s.urlSpread, s.left, s.right], ['spread', '3', '3', '4', '5']);
		await page.selectOption('#bs-jump', '1');
		await settle(page);
	});

	test('the sideways hint shows a few times, then never; Got it ends it', async () => {
		const context = await browser.newContext({hasTouch: true, isMobile: true, viewport: PORTRAIT});

		await fake.attach(context, 'hint');
		await routeHarness(context, harness.origin);
		await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));

		const page = await context.newPage();
		const seen = [];

		for (let i = 0; i < 4; i++) {
			await open(page);
			seen.push(await page.locator('#bs-hint').isVisible());
		}

		assert.deepEqual(seen, [true, true, true, false]);

		await page.evaluate(() => localStorage.removeItem('card-tracker-sideways-hint'));
		await open(page);
		await shot(page, 'hint');
		await page.click('#bs-hint-close');
		assert.equal(await page.locator('#bs-hint').isVisible(), false);
		await open(page);
		assert.equal(await page.locator('#bs-hint').isVisible(), false, 'gone after Got it');
		assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('card-tracker-sideways-hint'))), {done: true, shown: 1});

		// Storage that throws: the hint still works, it just may come back.
		await page.addInitScript(() => {
			Object.defineProperty(window, 'localStorage', {get() {
				throw new Error('blocked');
			}});
		});
		await open(page);
		assert.equal(await page.locator('#bs-hint').isVisible(), true);
		await context.close();
	});

	test('reduced motion crossfades instead of flipping', async () => {
		const quiet = await device(fake, {reducedMotion: 'reduce'});
		const {page} = quiet;

		await open(page);
		await page.evaluate(() => {
			window.leafSeen = false;
			new MutationObserver(() => {
				if (document.querySelector('.bs-leaf')) {
					window.leafSeen = true;
				}
			}).observe(document.getElementById('bs-book'), {childList: true, subtree: true});
		});
		await page.click('#bs-next');
		await page.waitForFunction(() => document.getElementById('binder-spread').dataset.turning === 'fade');
		await page.waitForTimeout(90);
		await shot(page, 'reduced-motion-mid');
		await settle(page);

		const s = await state(page);

		assert.deepEqual([s.spread, s.left, s.right], ['2', '2', '3']);
		assert.equal(await page.evaluate(() => window.leafSeen), false, 'no 3D leaf under reduced motion');
		assert.equal(await page.locator('.bs-xfade').count(), 0);
		assert.deepEqual(quiet.errors, []);
		await quiet.context.close();
	});

	test('no page errors', () => {
		assert.deepEqual(phone.errors, []);
	});
});

describe('spreads on a phone held sideways', () => {
	const fake = new FakeStorageSupabase();
	let phone;

	before(async () => {
		phone = await device(fake, {viewport: LANDSCAPE});
		await open(phone.page, '?spread=2');
	});

	after(() => phone.context.close());

	test('the full spread is large enough to edit directly', async () => {
		const {page} = phone;
		const s = await state(page);

		assert.deepEqual([s.mode, s.view, s.left, s.right], ['direct', 'spread', '2', '3']);
		assert.equal(await page.locator('#bs-hint').isVisible(), false, 'no sideways hint when sideways');
		assert.equal(await page.locator('.bs-open').count(), 0);
		assert.equal(await page.locator('.bs-grid[inert]').count(), 0);

		const box = await page.locator('.bs-side-right .bs-pocket').first().boundingBox();
		const stage = await page.locator('#bs-stage').boundingBox();

		assert.ok(box.width >= 44 && box.height >= 60, `pocket ${box.width} x ${box.height}`);
		assert.ok(stage.height <= LANDSCAPE.height, `the spread fits the screen's height (${stage.height})`);

		// Pockets' slits are on the outer edges.
		const slits = await page.evaluate(() => ['left', 'right'].map((side) => {
			const pocket = document.querySelector(`.bs-side-${side} .bs-pocket`).getBoundingClientRect();
			const slit = document.querySelector(`.bs-side-${side} .bs-slit`).getBoundingClientRect();

			return side === 'left' ? slit.left - pocket.left : pocket.right - slit.right;
		}));

		assert.ok(slits.every((gap) => gap >= 0 && gap < 3), `slits at the outer edges: ${slits}`);
		await noRings(page);
		await shot(page, 'landscape');

		await page.locator('.bs-side-right .bs-pocket[data-position="2"] button').tap();
		await page.waitForFunction(() => document.querySelector('.bs-side-right .bs-pocket[data-position="2"] .pocket-card'));
		assert.deepEqual(await page.evaluate(() => window.H.taps.at(-1)), {page: 3, position: 2});
	});

	test('the arrow keys and the edge arrows turn pages', async () => {
		const {page} = phone;

		await page.keyboard.press('ArrowRight');
		await settle(page);
		assert.equal((await state(page)).spread, '3');
		await page.keyboard.press('ArrowLeft');
		await settle(page);
		await page.click('#bs-prev');
		await settle(page);
		assert.equal((await state(page)).spread, '1');
		await shot(page, 'landscape-cover');
	});

	test('turning upright switches to the overview at once', async () => {
		const {page} = phone;

		await page.setViewportSize(PORTRAIT);
		await page.waitForFunction(() => document.getElementById('binder-spread').dataset.mode === 'overview');
		assert.equal(await page.locator('.bs-open').count(), 1);
		await page.click('.bs-open');
		assert.equal((await state(page)).view, 'page');
		await page.setViewportSize(LANDSCAPE);
		await page.waitForFunction(() => document.getElementById('binder-spread').dataset.mode === 'direct');
		assert.equal((await state(page)).view, 'spread', 'sideways shows the spread again');
		assert.deepEqual(phone.errors, []);
	});
});

describe('the cover image', () => {
	const fake = new FakeStorageSupabase();
	const owner = fake.addUser('owner@example.test');
	let phone;

	before(async () => {
		phone = await device(fake, {user: owner, viewport: LANDSCAPE});
		await open(phone.page);
	});

	after(() => phone.context.close());

	test('a picture is fitted to the cover, saved, uploaded, and shown on the list and the spread', async () => {
		const {page} = phone;
		const photo = await page.evaluate(() => window.H.makeCoverPhoto());

		await page.click('#h-cover');
		await page.waitForSelector('#bc-sheet #bc-pick');
		await page.setInputFiles('#bc-file', {buffer: Buffer.from(photo, 'base64'), mimeType: 'image/jpeg', name: 'binder.jpg'});
		await page.waitForSelector('#bc-stage');
		await page.waitForFunction(() => Number(document.getElementById('bc-preview').dataset.version) >= 1);

		// Nudge one corner with the keyboard, as the card photo editor allows.
		await page.focus('.bc-handle[data-corner="0"]');
		await page.keyboard.press('Shift+ArrowRight');
		await shot(page, 'cover-fit');
		await page.click('#bc-save');
		await page.waitForSelector('#bc-sheet', {state: 'detached'});
		await page.waitForFunction(() => document.getElementById('binder-spread').dataset.coverImage === 'true');
		await page.waitForFunction(() => document.getElementById('h-list-cover').dataset.coverImage === 'true');

		const image = await page.evaluate(() => window.H.binder().cover_image);

		assert.match(image.id, /^[0-9a-f-]{36}$/);
		assert.equal(image.type, 'image/webp');

		const blob = await page.evaluate(async () => {
			const b = await window.H.localCover(window.H.binder().cover_image.id);
			const bitmap = await createImageBitmap(b);

			return {bytes: b.size, height: bitmap.height, width: bitmap.width};
		});

		assert.equal(blob.width, 600);
		assert.ok(blob.height > 700 && blob.height < 900, `cover ${blob.width} x ${blob.height}`);
		assert.ok(blob.bytes < 512 * 1024);

		// Up in the bucket, at a path the card-photos rules accept.
		await page.waitForFunction(() => window.H.binder().cover_image.path);

		const path = await page.evaluate(() => window.H.binder().cover_image.path);
		const binderId = await page.evaluate(() => window.H.binder().id);

		assert.equal(path, `${owner.id}/binder-${binderId}/${image.id}.webp`);
		assert.ok(fake.objects.has(path), 'the fake bucket holds the cover');
		await noRings(page);
		await shot(page, 'cover');
	});

	test('a reload shows the cover from the phone, with no download', async () => {
		const {page} = phone;
		const downloads = fake.storageLog('download').length;

		await page.reload();
		await page.waitForFunction(() => document.body.dataset.ready);
		await page.waitForFunction(() => document.getElementById('binder-spread').dataset.coverImage === 'true');
		assert.equal(fake.storageLog('download').length, downloads);
	});

	test('another phone of the same person downloads it once from the bucket', async () => {
		const other = await device(fake, {user: owner, viewport: PORTRAIT});
		const path = await phone.page.evaluate(() => window.H.binder().cover_image.path);

		// The second phone gets the binder through the seeded document: copy
		// the first phone's binder entry into it.
		const entry = await phone.page.evaluate(() => window.H.binder());

		await open(other.page);
		await other.page.evaluate(async (binder) => {
			const {mergeIntoLocal} = await import('/pokemon-card-tracker/js/collection.js');
			const own = window.H.binder();

			await mergeIntoLocal({binders: [{...own, cover_image: binder.cover_image, updated_at: new Date().toISOString()}]});
			await window.H.reload();
		}, entry);
		await other.page.waitForFunction(() => document.getElementById('h-list-cover').dataset.coverImage === 'true');
		assert.ok(fake.storageLog('download').some((row) => row.path.endsWith(path)), 'downloaded from the bucket');
		await shot(other.page, 'cover-list-portrait');
		await other.context.close();
	});

	test('the bucket refuses a deeper path, which is why covers use binder-<id>', async () => {
		const {page} = phone;
		const status = await page.evaluate(async (userId) => {
			const {getClient} = await import('/pokemon-card-tracker/js/auth.js');
			const client = await getClient();
			const {error} = await client.storage.from('card-photos').upload(`${userId}/binders/x/cover.webp`, new Blob([new Uint8Array(10)], {type: 'image/webp'}), {contentType: 'image/webp', upsert: true});

			return error ? Number(error.statusCode || error.status || 0) : 200;
		}, owner.id);

		assert.notEqual(status, 200);
	});

	test('taking the image away shows the color and queues the old file\'s delete', async () => {
		const {page} = phone;
		const {id, path} = await page.evaluate(() => window.H.binder().cover_image);

		await page.click('#h-cover');
		await page.click('#bc-remove');
		await page.waitForFunction(() => !document.getElementById('binder-spread').dataset.coverImage && !window.H.binder().cover_image);
		await page.waitForFunction(() => !document.getElementById('h-list-cover').dataset.coverImage);

		// The phone's copy goes at once; the bucket's waits for the 14-day
		// grace period (js/photos/model.js bucketDeleteState), for phones that
		// may still show it.
		const state = await page.evaluate(async (imageId) => {
			const {localCover} = await import('/pokemon-card-tracker/js/binder-cover.js');
			const queue = await new Promise((resolve, reject) => {
				const open = indexedDB.open('card-tracker-binder-covers', 1);

				open.onsuccess = () => {
					const request = open.result.transaction('queue', 'readonly').objectStore('queue').getAll();

					request.onsuccess = () => {
						open.result.close();
						resolve(request.result);
					};
					request.onerror = () => reject(request.error);
				};
				open.onerror = () => reject(open.error);
			});

			return {local: Boolean(await localCover(imageId)), queue};
		}, id);
		const row = state.queue.find((item) => item.op === 'delete' && item.path === path);

		assert.equal(state.local, false, 'the phone\'s copy is gone');
		assert.ok(row, 'the bucket delete is queued');
		assert.equal((row.not_before - row.at) / (24 * 60 * 60 * 1000), 14);
		assert.ok(fake.objects.has(path), 'the bucket keeps it during the grace period');
		assert.deepEqual(phone.errors, []);
	});
});

describe('presets', () => {
	test('the quick picks fill the fields', async () => {
		const fake = new FakeStorageSupabase();
		const {context, errors, page} = await device(fake);

		await open(page);
		await page.click('.binder-preset[data-preset="12-pocket"]');
		assert.deepEqual(await page.evaluate(() => window.H.picked), {cols: 4, page_count: 40, preset: '12-pocket', rows: 3});
		assert.equal(await page.getAttribute('.binder-preset[data-preset="12-pocket"]', 'aria-pressed'), 'true');
		await page.click('.binder-preset[data-preset="custom"]');
		assert.deepEqual(await page.evaluate(() => window.H.picked), {preset: 'custom'});
		await page.locator('#presets').screenshot({path: `${SHOTS}/spread-presets.png`});
		assert.deepEqual(errors, []);
		await context.close();
	});
});
