// Browser tests for the inspection viewer and the detail copy
// (js/photos/viewer.js, zoom.js, store.js). Headless Chromium with touch, at
// 360 x 740 (portrait) and 740 x 360 (landscape), against
// tests/photos-harness.mjs: the real modules on the harness page.
//
// Supabase is tests/photos-fake-storage.mjs, never the real project. Touch
// gestures go through the DevTools protocol's Input.dispatchTouchEvent, so
// two fingers really pinch and the page sees the pointer events a phone
// sends; Ctrl and the wheel stand in for a trackpad pinch.
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/photos-viewer-browser.test.mjs

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {FakeStorageSupabase} from './photos-fake-storage.mjs';
import {HARNESS_PATH, pendingIntegration, routeHarness, startHarness} from './photos-harness.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const SHOTS = process.env.SHOTS || '/tmp';
const IMAGE = 'https://assets.tcgdex.net/en/me/me01/001';
const BUCKET_LIMIT = 524288;

let harness;
let browser;
const images = {};

before(async () => {
	harness = await startHarness();
	browser = await chromium.launch();

	for (const size of ['high', 'low']) {
		try {
			const response = await fetch(`${IMAGE}/${size}.webp`);

			images[size] = response.ok ? Buffer.from(await response.arrayBuffer()) : null;
		}
		catch {
			images[size] = null;
		}
	}

	if (!images.high) {
		console.log('# TCGdex was not reachable: the official slide shows the card back and the test photo a drawn stand-in.');
	}

	for (const line of await pendingIntegration()) {
		console.log(`# integration pending: ${line}`);
	}
});

after(async () => {
	await browser.close();
	await harness.close();
});

// A phone photo big enough for a detail copy: 2400 x 3200, the card about
// 2100 px tall in it, tilted.
const BIG = {height: 3200, width: 2400};
const BIG_QUAD = [{x: 640, y: 480}, {x: 1830, y: 580}, {x: 1990, y: 2620}, {x: 420, y: 2510}];

async function device(fake, user, viewport) {
	const context = await browser.newContext({hasTouch: true, viewport});
	const errors = [];

	await fake.attach(context, 'phone');
	await routeHarness(context, harness.origin);
	await context.route('https://assets.tcgdex.net/**', (route) => {
		const size = route.request().url().endsWith('/low.webp') ? 'low' : 'high';

		return images[size]
			? route.fulfill({body: images[size], contentType: 'image/webp', headers: {'access-control-allow-origin': '*'}})
			: route.fulfill({status: 404});
	});

	const session = fake.session(user);

	await context.addInitScript((value) => {
		if (!localStorage.getItem('card-tracker-auth')) {
			localStorage.setItem('card-tracker-auth', value);
		}
	}, JSON.stringify(session));

	const page = await context.newPage();
	const cdp = await context.newCDPSession(page);

	page.on('pageerror', (err) => errors.push(String(err)));
	page.on('console', (message) => {
		if (message.type() === 'error' && !/Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(message.text())) {
			errors.push(message.text());
		}
	});

	return {cdp, context, errors, page};
}

async function open(page) {
	await page.goto(`${harness.origin}${HARNESS_PATH}`);
	await page.waitForFunction(() => document.body.dataset.ready);

	const state = await page.evaluate(() => [document.body.dataset.ready, document.body.dataset.error]);

	assert.equal(state[0], 'true', state[1]);
}

async function shot(page, name) {
	await page.waitForTimeout(250);
	await page.screenshot({path: `${SHOTS}/viewer-${name}.png`});
}

async function until(page, check, arg = null, timeout = 10000) {
	const end = Date.now() + timeout;

	while (Date.now() < end) {
		if (await page.evaluate(check, arg)) {
			return;
		}

		await page.waitForTimeout(50);
	}

	throw new Error(`Timed out after ${timeout} ms waiting for ${check}`);
}

// ----------------------------------------------------------- touch

const point = (p, id) => ({force: 1, id, radiusX: 2, radiusY: 2, x: p.x, y: p.y});

async function touch(cdp, type, points = []) {
	await cdp.send('Input.dispatchTouchEvent', {touchPoints: points.map((p, i) => point(p, p.id ?? i)), type});
}

// Two fingers about `center`, spread from `from` to `to` px apart.
async function pinch(cdp, center, from, to, steps = 10) {
	const at = (gap) => [{id: 0, x: center.x - gap / 2, y: center.y - gap / 4}, {id: 1, x: center.x + gap / 2, y: center.y + gap / 4}];

	await touch(cdp, 'touchStart', at(from));

	for (let i = 1; i <= steps; i++) {
		await touch(cdp, 'touchMove', at(from + (to - from) * (i / steps)));
	}

	await touch(cdp, 'touchEnd');
}

// One finger from a to b in `steps` moves, `ms` apart.
async function drag(cdp, a, b, {ms = 8, steps = 8} = {}) {
	await touch(cdp, 'touchStart', [{id: 0, ...a}]);

	for (let i = 1; i <= steps; i++) {
		await touch(cdp, 'touchMove', [{id: 0, x: a.x + (b.x - a.x) * (i / steps), y: a.y + (b.y - a.y) * (i / steps)}]);

		if (ms) {
			await new Promise((resolve) => setTimeout(resolve, ms));
		}
	}

	await touch(cdp, 'touchEnd');
}

async function doubleTap(cdp, p) {
	for (let i = 0; i < 2; i++) {
		await touch(cdp, 'touchStart', [{id: 0, ...p}]);
		await touch(cdp, 'touchEnd');
		await new Promise((resolve) => setTimeout(resolve, 60));
	}
}

// Ctrl and the wheel at a point: a trackpad pinch.
async function ctrlWheel(page, p, deltaY, times = 1) {
	await page.mouse.move(p.x, p.y);
	await page.keyboard.down('Control');

	for (let i = 0; i < times; i++) {
		await page.mouse.wheel(0, deltaY);
	}

	await page.keyboard.up('Control');
}

// ----------------------------------------------------------- reading a pane

// A pane's view: {s, tx, ty, u, v, base: {width, height}, box}, after it has
// stopped moving.
async function paneState(page, i) {
	let last = null;

	for (let tries = 0; tries < 60; tries++) {
		const state = await page.evaluate((n) => {
			const pane = document.querySelectorAll('.ph-full .ph-pane')[n];
			const art = pane.querySelector('.ph-pane-art');
			const box = pane.getBoundingClientRect();

			return {
				base: {height: parseFloat(art.style.height), width: parseFloat(art.style.width)},
				box: {height: box.height, width: box.width, x: box.x, y: box.y},
				detail: pane.dataset.detail || null,
				natural: pane.dataset.natural || null,
				s: Number(pane.dataset.s),
				slide: pane.dataset.slide,
				tx: Number(pane.dataset.tx),
				ty: Number(pane.dataset.ty),
				u: Number(pane.dataset.u),
				v: Number(pane.dataset.v),
			};
		}, i);

		if (last && last.s === state.s && last.tx === state.tx && last.ty === state.ty) {
			return state;
		}

		last = state;
		await page.waitForTimeout(60);
	}

	return last;
}

// The card point (u, v) under a page point, in a pane state.
const cardAt = (state, p) => ({
	u: (p.x - state.box.x - state.tx) / (state.s * state.base.width),
	v: (p.y - state.box.y - state.ty) / (state.s * state.base.height),
});

const center = (state) => ({x: state.box.x + state.box.width / 2, y: state.box.y + state.box.height / 2});

const near = (actual, expected, tolerance, message) => {
	assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} is not within ${tolerance} of ${expected}`);
};

// ----------------------------------------------------------- the suites

for (const [name, viewport] of [['portrait', {height: 740, width: 360}], ['landscape', {height: 360, width: 740}]]) {
	describe(`the inspection viewer, ${name} ${viewport.width} x ${viewport.height}`, () => {
		const fake = new FakeStorageSupabase();
		const owner = fake.addUser(`${name}@example.test`);
		let phone;
		let photo;

		before(async () => {
			phone = await device(fake, owner, viewport);
		});

		after(async () => {
			await phone.context.close();
		});

		test('the detail-copy setting is off by default and says what it costs', async () => {
			const {page} = phone;

			await open(page);

			const box = page.locator('#ph-detail-setting');

			assert.equal(await box.isChecked(), false);
			assert.equal(await page.locator('.ph-detail-label').textContent(), 'Keep a detail copy of new photos');

			const help = await page.locator('#ph-detail-help').textContent();

			assert.match(help, /up to 500 KB/);
			assert.match(help, /about 1,800 photos with detail copies/);
			assert.match(help, /over 13,000 without/);
			assert.match(help, /downloaded only when you zoom in/);
			assert.doesNotMatch(help, /\u2014/, 'no em dash');

			await box.check();
			assert.equal(await page.evaluate(() => localStorage.getItem('card-tracker-photo-detail')), 'on', 'kept on this phone');
			await page.locator('#photo-settings').scrollIntoViewIfNeeded();
			await shot(page, `${name}-1-setting`);
		});

		test('with it on, saving a photo also saves a detail copy under 500 KB, uploaded beside the photo', async () => {
			const {page} = phone;

			await page.evaluate(() => window.H.openDetail('e1'));
			await page.waitForSelector('.ph-carousel .ph-slide img');

			const base64 = await page.evaluate(({q, size}) => window.H.makeTestPhoto({...size, quad: q}), {q: BIG_QUAD, size: BIG});

			await page.click('.ph-add');

			const chooser = page.waitForEvent('filechooser');

			await page.click('.ph-pick');
			await (await chooser).setFiles({buffer: Buffer.from(base64, 'base64'), mimeType: 'image/jpeg', name: 'card.jpg'});
			await page.waitForSelector('.ph-stage .ph-handle');
			await page.click('.ph-save');
			await page.waitForSelector('.ph-sheet', {state: 'detached', timeout: 20000});

			const entry = await page.evaluate(async () => (await window.H.listCards()).find((card) => card.id === window.H.ids().e1));

			photo = entry.photos[0];
			assert.ok(photo.detail, 'the photo records its detail copy');
			assert.equal(photo.detail.type, 'image/webp');
			assert.ok(photo.detail.height >= 1400 && photo.detail.height <= 2016, `about 2000 px tall: ${photo.detail.height}`);
			near(photo.detail.width / photo.detail.height, 600 / 840, 0.002, 'in the normal copy\'s shape');

			const info = await page.evaluate(async (id) => {
				const blob = await window.H.store.localPhoto(window.H.store.detailKey(id));
				const bitmap = await createImageBitmap(blob);

				return {bytes: blob.size, height: bitmap.height, type: blob.type, width: bitmap.width};
			}, photo.id);

			console.log(`# ${name}: detail copy ${info.width} x ${info.height} ${info.type}, ${(info.bytes / 1024).toFixed(1)} KB`);
			assert.equal(info.width, photo.detail.width);
			assert.equal(info.height, photo.detail.height);
			assert.ok(info.bytes <= 500 * 1024, `under 500 KB: ${info.bytes}`);
			assert.ok(info.bytes > 60 * 1024, `a real image: ${info.bytes}`);

			const normal = await page.evaluate((id) => window.H.photoInfo(id), photo.id);

			assert.equal(normal.width, 600, 'the normal copy is unchanged');
			assert.equal(normal.height, 840);

			await until(page, async () => (await window.H.store.queuedItems()).length === 0, null, 15000);

			const detailPath = photo.path.replace(/\.webp$/, '-detail.webp');
			const object = fake.objects.get(detailPath);

			assert.equal(photo.path, `${owner.id}/${entry.id}/${photo.id}.webp`);
			assert.ok(fake.objects.has(photo.path), 'the normal copy went up');
			assert.ok(object, `the detail copy went up at ${detailPath}`);
			assert.equal(object.bytes.length, info.bytes);
			assert.ok(object.bytes.length < BUCKET_LIMIT, 'inside the bucket\'s 512 KB limit');
		});

		test('tapping the card image opens the viewer with a hint the first time; the detail copy waits', async () => {
			const {page} = phone;

			// Off this phone, so the zoom must fetch it.
			await page.evaluate((id) => window.H.store.forgetLocalDetail(id), photo.id);
			await page.waitForFunction(() => document.querySelectorAll('.ph-carousel .ph-slide img').length === 2);
			assert.equal(await page.locator('.ph-carousel').getAttribute('data-index'), '1', 'on the new photo');
			await page.locator('.ph-viewport').click();
			await page.waitForSelector('.ph-full .ph-pane[data-ready="true"]');

			assert.equal(await page.locator('.ph-full-label').textContent(), '2 of 2 · Your photo');
			assert.equal(await page.locator('.ph-full-hint').isVisible(), true, 'the hint shows');
			assert.match(await page.locator('.ph-full-hint').textContent(), /Pinch or double-tap to zoom/);
			assert.equal(await page.locator('.ph-full-compare').isVisible(), true);
			assert.equal(await page.locator('.ph-full-link').isVisible(), false, 'no link outside Compare');
			assert.equal(await page.locator('.ph-full .ph-pane').first().evaluate((el) => getComputedStyle(el).touchAction), 'none');
			await shot(page, `${name}-2-viewer-hint`);

			const state = await paneState(page, 0);

			assert.equal(state.s, 1);
			assert.equal(state.natural, '600x840', 'the normal copy');
			assert.equal(fake.storageLog('download').filter((entry) => entry.path.includes('-detail')).length, 0, 'no detail download at zoom 1');
		});

		test('a two-finger pinch zooms about the fingers, and past the normal copy fetches the detail copy once', async () => {
			const {cdp, page} = phone;
			const start = await paneState(page, 0);
			const mid = center(start);
			const spot = cardAt(start, mid);

			await pinch(cdp, mid, 60, 200);

			const zoomed = await paneState(page, 0);

			assert.ok(zoomed.s > 2.5 && zoomed.s < 3.9, `pinched in: ${zoomed.s}`);

			const under = cardAt(zoomed, mid);

			near(under.u, spot.u, 0.02, 'the pinched spot stays between the fingers (u)');
			near(under.v, spot.v, 0.02, 'the pinched spot stays between the fingers (v)');
			assert.equal(await page.locator('.ph-full-hint').isVisible(), false, 'the hint goes at the first touch');

			// The detail copy is wanted once 600 px of photo cover more screen
			// than that (a 1x screen here). In landscape the card is small, so
			// this pinch is not yet there: nothing is fetched until it is.
			if (zoomed.s * zoomed.base.width <= 600) {
				await page.waitForTimeout(300);
				assert.equal(fake.storageLog('download').filter((entry) => entry.path.includes('-detail')).length, 0, `not needed yet at ${zoomed.s.toFixed(2)} x`);
				await pinch(cdp, mid, 60, 120);

				const further = await paneState(page, 0);

				assert.ok(further.s * further.base.width > 600, `now past the normal copy: ${further.s.toFixed(2)} x`);
			}

			await page.waitForSelector('.ph-full .ph-pane[data-detail="shown"]', {timeout: 10000});

			const shown = await paneState(page, 0);

			assert.equal(shown.natural, `${photo.detail.width}x${photo.detail.height}`, 'the pane now draws the detail copy');
			assert.equal(await page.locator('.ph-full .ph-pane img').evaluate((img) => img.naturalWidth), photo.detail.width);
			assert.equal(fake.storageLog('download').filter((entry) => entry.path.includes('-detail')).length, 1, 'downloaded once, on demand');
			assert.ok(await page.evaluate((id) => window.H.store.localPhoto(window.H.store.detailKey(id)).then(Boolean), photo.id), 'then kept on the phone');
			assert.match(await page.locator('.ph-full-zoom').textContent(), /^\d+(\.\d)?×$/);
			await shot(page, `${name}-3-pinched-detail`);

			// Pinching far past the max springs back to it: native resolution of
			// the detail copy, or the floor of 4.
			await pinch(cdp, mid, 40, 400);

			const capped = await paneState(page, 0);
			const max = Math.max(4, photo.detail.width / capped.base.width);

			near(capped.s, Math.min(12, max), 0.02, 'settled at the max');
		});

		test('double-tap resets, then zooms into the tapped point', async () => {
			const {cdp, page} = phone;
			const zoomed = await paneState(page, 0);

			await doubleTap(cdp, center(zoomed));

			const rest = await paneState(page, 0);

			assert.equal(rest.s, 1, 'back to the whole card');

			const tap = {x: rest.box.x + rest.box.width * 0.5, y: rest.box.y + rest.box.height * 0.4};
			const spot = cardAt(rest, tap);

			await doubleTap(cdp, tap);

			const again = await paneState(page, 0);

			near(again.s, 2.5, 0.001, 'the double-tap zoom');

			const under = cardAt(again, tap);

			near(under.u, spot.u, 0.01, 'the tapped spot stays under the finger (u)');
			near(under.v, spot.v, 0.01, 'the tapped spot stays under the finger (v)');
			await shot(page, `${name}-4-double-tap`);
		});

		test('a flick pans on with momentum, and a pan stops at the card edge', async () => {
			const {cdp, page} = phone;

			// Zoomed far enough in that the card overflows the stage both ways.
			await ctrlWheel(page, center(await paneState(page, 0)), -100, 6);

			const before = await paneState(page, 0);
			const from = center(before);

			assert.ok(before.s * before.base.width > before.box.width * 1.5, 'wider than the stage');

			// A quick flick left, released while moving.
			await drag(cdp, from, {x: from.x - 80, y: from.y}, {ms: 6, steps: 6});

			const released = await page.evaluate(() => Number(document.querySelector('.ph-full .ph-pane').dataset.tx));
			const settled = await paneState(page, 0);

			assert.ok(released < before.tx, 'it followed the finger');
			assert.ok(settled.tx < released - 5, `it glided on after the finger lifted: ${released} to ${settled.tx}`);

			// A long drag right and down goes no further than the top-left
			// corner, then springs back to it.
			await drag(cdp, from, {x: from.x + 1200, y: from.y + 1200}, {ms: 0, steps: 12});

			const edge = await paneState(page, 0);

			near(edge.tx, 0, 0.5, 'the card\'s left edge at the stage\'s left');
			near(edge.ty, 0, 0.5, 'the card\'s top edge at the stage\'s top');
			await shot(page, `${name}-5-edge`);
		});

		test('at zoom 1 a swipe moves to the next image, and only then', async () => {
			const {cdp, page} = phone;
			const zoomed = await paneState(page, 0);
			const from = center(zoomed);

			// Zoomed in, a sideways drag pans: still the photo.
			await drag(cdp, {x: from.x - 100, y: from.y}, {x: from.x + 100, y: from.y});
			assert.equal(await page.locator('.ph-full').getAttribute('data-index'), '1');

			await doubleTap(cdp, from);
			assert.equal((await paneState(page, 0)).s, 1);
			await drag(cdp, {x: from.x - 120, y: from.y}, {x: from.x + 120, y: from.y});
			await page.waitForFunction(() => document.querySelector('.ph-full').dataset.index === '0');
			assert.equal(await page.locator('.ph-full-label').textContent(), '1 of 2 · Official');

			const counts = await page.evaluate(() => ({...window.H.counts}));

			assert.equal(counts.pageSwipes, 0, 'the page behind never saw a swipe');

			await page.keyboard.press('ArrowRight');
			await page.waitForFunction(() => document.querySelector('.ph-full').dataset.index === '1');
		});

		test('Escape closes it, and the hint does not come back', async () => {
			const {page} = phone;

			await page.keyboard.press('Escape');
			await page.waitForSelector('.ph-full', {state: 'detached'});
			await page.locator('.ph-viewport').click();
			await page.waitForSelector('.ph-full .ph-pane[data-ready="true"]');
			assert.equal(await page.locator('.ph-full-hint').isVisible(), false);
		});

		test('Compare puts the official image and the photo side by side, with zoom linked in card coordinates', async () => {
			const {page} = phone;

			await page.click('.ph-full-compare');
			await page.waitForFunction(() => document.querySelectorAll('.ph-full .ph-pane[data-ready="true"]').length === 2);
			assert.equal(await page.locator('.ph-full').getAttribute('data-mode'), 'compare');
			assert.deepEqual(await page.locator('.ph-side-pick').evaluateAll((selects) => selects.map((select) => select.value)), ['0', '1'], 'official, then the photo');
			assert.equal(await page.locator('.ph-full-link').getAttribute('aria-pressed'), 'true', 'linked by default');
			assert.match(await page.locator('.ph-full-hint').textContent(), /the other shows the same spot/);

			const a = await paneState(page, 0);
			const b = await paneState(page, 1);

			assert.equal(a.slide, 'official');
			assert.equal(b.slide, photo.id);

			if (viewport.width > viewport.height) {
				assert.ok(b.box.x >= a.box.x + a.box.width - 1, 'side by side in landscape');
				near(b.box.y, a.box.y, 1, 'level');
			}
			else {
				assert.ok(b.box.y >= a.box.y + a.box.height - 1, 'stacked in portrait');
				near(b.box.x, a.box.x, 1, 'aligned');
			}

			await shot(page, `${name}-6-compare`);

			// Ctrl and the wheel into the official image's bottom-right corner.
			const restA = await paneState(page, 0);
			const corner = {
				x: restA.box.x + restA.tx + restA.base.width * 0.85,
				y: restA.box.y + restA.ty + restA.base.height * 0.85,
			};

			await ctrlWheel(page, corner, -100, 4);

			const leadA = await paneState(page, 0);
			const followB = await paneState(page, 1);

			assert.ok(leadA.s > 3, `zoomed in: ${leadA.s}`);
			near(followB.s, leadA.s, 0.001, 'the photo zoomed as much');
			near(followB.u, leadA.u, 0.005, 'the same card spot across');
			near(followB.v, leadA.v, 0.005, 'the same card spot down');
			assert.ok(leadA.u > 0.6 && leadA.v > 0.6, `toward the bottom-right corner: ${leadA.u}, ${leadA.v}`);
			await shot(page, `${name}-7-compare-synced`);

			// A drag on the photo pans the official image along.
			const {cdp} = phone;
			const mid = center(followB);

			await drag(cdp, mid, {x: mid.x + 40, y: mid.y + 30}, {ms: 0, steps: 6});

			const pannedB = await paneState(page, 1);
			const pannedA = await paneState(page, 0);

			assert.ok(pannedB.u < followB.u, 'the photo panned');
			near(pannedA.u, pannedB.u, 0.005, 'and the official image followed across');
			near(pannedA.v, pannedB.v, 0.005, 'and down');
		});

		test('unlinked, each side zooms on its own; linked again, they line up', async () => {
			const {page} = phone;

			await page.click('.ph-full-link');
			assert.equal(await page.locator('.ph-full-link').getAttribute('aria-pressed'), 'false');
			assert.equal(await page.locator('.ph-full-link').textContent(), 'Unlinked');

			const a = await paneState(page, 0);
			const b = await paneState(page, 1);

			await ctrlWheel(page, center(b), 100, 3);

			const b2 = await paneState(page, 1);
			const a2 = await paneState(page, 0);

			assert.ok(b2.s < b.s, `the photo zoomed out: ${b.s} to ${b2.s}`);
			assert.equal(a2.s, a.s, 'the official image stayed');
			assert.equal(a2.tx, a.tx);
			await shot(page, `${name}-8-unlinked`);

			await page.click('.ph-full-link');

			const a3 = await paneState(page, 0);

			near(a3.s, b2.s, 0.001, 'relinked: the official image takes the photo\'s zoom');
			near(a3.u, b2.u, 0.005, 'and its card spot');
		});

		test('either side can switch to another image, which takes up the linked view', async () => {
			const {page} = phone;
			const b = await paneState(page, 1);

			await page.locator('.ph-side-pick').first().selectOption('1');
			await page.waitForFunction((id) => {
				const pane = document.querySelectorAll('.ph-full .ph-pane')[0];

				return pane.dataset.slide === id && pane.dataset.ready === 'true';
			}, photo.id);

			const a = await paneState(page, 0);

			near(a.s, b.s, 0.001, 'the same zoom');
			near(a.u, b.u, 0.005, 'the same spot');

			// Escape leaves Compare first, then the viewer.
			await page.keyboard.press('Escape');
			assert.equal(await page.locator('.ph-full').getAttribute('data-mode'), 'single');
			await page.keyboard.press('Escape');
			await page.waitForSelector('.ph-full', {state: 'detached'});
		});

		test('with reduced motion, zooms jump instead of animating', async () => {
			const {cdp, page} = phone;

			await page.emulateMedia({reducedMotion: 'reduce'});
			await page.locator('.ph-viewport').click();
			await page.waitForSelector('.ph-full .ph-pane[data-ready="true"]');

			const rest = await paneState(page, 0);

			await doubleTap(cdp, center(rest));

			// One frame later it is already there.
			await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
			assert.equal(Number(await page.locator('.ph-full .ph-pane').first().getAttribute('data-s')), 2.5);
			await page.keyboard.press('Escape');
			await page.emulateMedia({reducedMotion: 'no-preference'});
		});

		test('removing the photo deletes its detail copy too, from the bucket and the phone', async () => {
			const {page} = phone;
			const detailPath = photo.path.replace(/\.webp$/, '-detail.webp');

			assert.ok(fake.objects.has(detailPath));
			await page.locator('.ph-dot').nth(1).click();
			await page.locator('.ph-viewport').click();
			await page.waitForSelector('.ph-full-remove');
			page.once('dialog', (dialog) => dialog.accept());
			await page.click('.ph-full-remove');
			await page.waitForFunction(() => document.querySelectorAll('.ph-carousel .ph-slide').length === 1);
			await until(page, async () => (await window.H.store.queuedItems()).length === 0);
			assert.equal(fake.objects.has(photo.path), false, 'the photo is gone from the bucket');
			assert.equal(fake.objects.has(detailPath), false, 'and so is its detail copy');
			assert.equal(await page.evaluate((id) => window.H.store.localPhoto(window.H.store.detailKey(id)).then(Boolean), photo.id), false, 'and from the phone');
		});

				test('nothing on the page logged an error', () => {
			assert.deepEqual(phone.errors, []);
		});
	});
}
