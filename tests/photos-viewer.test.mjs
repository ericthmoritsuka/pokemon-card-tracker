// Unit tests for the inspection viewer's math (js/photos/zoom.js), Compare's
// default pair (js/photos/model.js comparePair), and the detail copy: its
// path, its record, its size, and its encoding budget (js/photos/encode.js)
// against the bucket's limit and path rule in supabase/photos.sql.
//
// Run: node --test tests/photos-viewer.test.mjs

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {describe, test} from 'node:test';

import {
	BUCKET_LIMIT_BYTES,
	DETAIL_HEIGHT,
	DETAIL_MAX_BYTES,
	DETAIL_TARGET_BYTES,
	DETAIL_WIDTH,
	detailSize,
	fitEncoding,
} from '../js/photos/encode.js';
import {PHOTO_HEIGHT, PHOTO_WIDTH} from '../js/photos/geometry.js';
import {comparePair, detailPath, gallerySlides, newPhoto, photoPath} from '../js/photos/model.js';
import {
	DOUBLE_TAP_ZOOM,
	MAX_ZOOM_CAP,
	MIN_MAX_ZOOM,
	bounds,
	cardFocus,
	clampView,
	doubleTapView,
	fitSize,
	fromCard,
	isDoubleTap,
	maxZoom,
	momentumAt,
	needsDetail,
	pinchView,
	restView,
	rubber,
	rubberView,
	settleView,
	toCard,
	velocityOf,
	viewForFocus,
	zoomAbout,
	zoomStep,
} from '../js/photos/zoom.js';

const near = (actual, expected, tolerance, message) => {
	assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} is not within ${tolerance} of ${expected}`);
};

// A phone's single view: 344 x 556 CSS px of stage, a 600 x 840 photo.
const STAGE = {height: 556, width: 344};
const PHOTO = {height: 840, width: 600};
const BASE = fitSize(STAGE, PHOTO.width / PHOTO.height);

const inside = (view, stage, base) => {
	const b = bounds(stage, base, view.s);

	return view.tx >= b.minX - 1e-9 && view.tx <= b.maxX + 1e-9 && view.ty >= b.minY - 1e-9 && view.ty <= b.maxY + 1e-9;
};

describe('fitting and bounds', () => {
	test('the image fits the stage at zoom 1, centered', () => {
		near(BASE.width, 344, 1e-9, 'a tall stage is filled across');
		near(BASE.height, 344 * 840 / 600, 1e-9, 'in the photo\'s shape');

		const rest = restView(STAGE, BASE);

		assert.equal(rest.s, 1);
		near(rest.tx, 0, 1e-9, 'flush left and right');
		near(rest.ty, (556 - BASE.height) / 2, 1e-9, 'centered up and down');

		// A wide stage (a phone on its side) is filled top to bottom.
		const wide = fitSize({height: 240, width: 700}, 600 / 825);

		near(wide.height, 240, 1e-9, 'height-limited');
		near(wide.width, 240 * 600 / 825, 1e-9, 'in the official image\'s shape');
	});

	test('zoomed in, the image moves until its edges meet the stage edges and no further', () => {
		const s = 3;
		const b = bounds(STAGE, BASE, s);

		near(b.minX, 344 - 344 * 3, 1e-9, 'right edge at the stage\'s right');
		near(b.maxX, 0, 1e-9, 'left edge at the stage\'s left');
		near(b.minY, 556 - BASE.height * 3, 1e-9, 'bottom edge');
		near(b.maxY, 0, 1e-9, 'top edge');

		const clamped = clampView({s, tx: 500, ty: -99999}, STAGE, BASE, 4);

		assert.equal(clamped.tx, 0);
		near(clamped.ty, b.minY, 1e-9, 'clamped to the bottom edge');

		// An axis still smaller than the stage stays centered.
		const short = bounds({height: 2000, width: 344}, BASE, 1.5);

		assert.equal(short.minY, short.maxY);
		near(short.minY, (2000 - BASE.height * 1.5) / 2, 1e-9, 'centered');
	});

	test('the scale is clamped to [1, max]', () => {
		assert.equal(clampView({s: 0.4, tx: 0, ty: 0}, STAGE, BASE, 4).s, 1);
		assert.equal(clampView({s: 9, tx: 0, ty: 0}, STAGE, BASE, 4).s, 4);
		assert.deepEqual(clampView({s: 0.4, tx: 77, ty: 3}, STAGE, BASE, 4), restView(STAGE, BASE), 'below 1 is the whole card, centered');
	});

	test('max zoom is the native resolution, never below the floor nor above the cap', () => {
		// 600 px on 344 px of screen is 1.7 x native: the floor applies.
		assert.equal(maxZoom(BASE, PHOTO), MIN_MAX_ZOOM);
		// A 1440 x 2016 detail copy on 200 px (a landscape Compare side).
		near(maxZoom({height: 280, width: 200}, {height: 2016, width: 1440}), 7.2, 1e-9, 'native resolution');
		assert.equal(maxZoom({height: 28, width: 20}, {height: 2016, width: 1440}), MAX_ZOOM_CAP);
		assert.equal(maxZoom(BASE, null), MIN_MAX_ZOOM, 'unknown size: the floor');
	});

	test('a drag past an edge stretches less and less, never past the stage size', () => {
		assert.equal(rubber(0, 300), 0);
		assert.ok(rubber(30, 300) > 0 && rubber(30, 300) < 30, 'some give');
		assert.ok(rubber(-30, 300) < 0, 'both ways');
		assert.ok(rubber(600, 300) - rubber(300, 300) < rubber(300, 300), 'stiffer the further it goes');
		assert.ok(rubber(1e9, 300) < 300, 'bounded');

		const b = bounds(STAGE, BASE, 2);
		const pulled = rubberView({s: 2, tx: 100, ty: b.minY - 100}, STAGE, BASE);

		assert.ok(pulled.tx > 0 && pulled.tx < 100, `past the left edge by less than dragged: ${pulled.tx}`);
		assert.ok(pulled.ty < b.minY && pulled.ty > b.minY - 100, 'past the bottom edge by less than dragged');
		assert.deepEqual(rubberView({s: 2, tx: -50, ty: -50}, STAGE, BASE), {s: 2, tx: -50, ty: -50}, 'inside the bounds, one to one');
	});
});

describe('zooming', () => {
	test('zooming about a point keeps that card spot under it', () => {
		const rest = restView(STAGE, BASE);
		const point = {x: 50, y: 120};
		const before = toCard(rest, BASE, point.x, point.y);
		const zoomed = zoomAbout(rest, 3.2, point.x, point.y);
		const after = toCard(zoomed, BASE, point.x, point.y);

		near(after.u, before.u, 1e-12, 'u');
		near(after.v, before.v, 1e-12, 'v');

		const back = fromCard(zoomed, BASE, before.u, before.v);

		near(back.x, point.x, 1e-9, 'fromCard inverts toCard (x)');
		near(back.y, point.y, 1e-9, 'fromCard inverts toCard (y)');
	});

	test('a double tap at zoom 1 zooms into the tapped point; a second one goes back', () => {
		const rest = restView(STAGE, BASE);
		// The middle of the card: no edge is in the way.
		const tap = {x: 172, y: 278};
		const spot = toCard(rest, BASE, tap.x, tap.y);
		const zoomed = doubleTapView(rest, tap, STAGE, BASE, 4);

		assert.equal(zoomed.s, DOUBLE_TAP_ZOOM);

		const under = toCard(zoomed, BASE, tap.x, tap.y);

		near(under.u, spot.u, 1e-9, 'the tapped spot stays under the finger (u)');
		near(under.v, spot.v, 1e-9, 'the tapped spot stays under the finger (v)');
		assert.deepEqual(doubleTapView(zoomed, tap, STAGE, BASE, 4), rest, 'zoomed in, back to the whole card');
	});

	test('a double tap near a corner zooms into that corner but never shows past the card edge', () => {
		const rest = restView(STAGE, BASE);
		// 10 px into the card's top-left corner. Across, the card fills the
		// stage, so the spot can stay under the finger; down, the card sits
		// 37 px below the stage top at zoom 1, and keeping the spot there
		// would show black above the card, so the card's top edge meets the
		// stage top instead.
		const tap = {x: rest.tx + 10, y: rest.ty + 10};
		const spot = toCard(rest, BASE, tap.x, tap.y);
		const zoomed = doubleTapView(rest, tap, STAGE, BASE, 4);
		const now = fromCard(zoomed, BASE, spot.u, spot.v);

		assert.ok(inside(zoomed, STAGE, BASE), 'inside the bounds');
		near(now.x, tap.x, 1e-9, 'still under the finger across');
		assert.equal(zoomed.ty, 0, 'the card\'s top edge at the stage\'s top');
		assert.ok(now.y >= 0 && now.y < tap.y, `moved up to stay in view: ${now.y}`);

		const corner = toCard(zoomed, BASE, 0, 0);

		assert.ok(corner.u >= 0 && corner.u < 0.02, `the top-left corner shows: u ${corner.u}`);
		near(corner.v, 0, 1e-9, 'the top edge shows');
	});

	test('a double tap respects a max below the double-tap zoom', () => {
		assert.equal(doubleTapView(restView(STAGE, BASE), {x: 172, y: 278}, STAGE, BASE, 1.8).s, 1.8);
	});

	test('two taps are a double tap only when close in time and place', () => {
		const first = {t: 1000, x: 100, y: 100};

		assert.equal(isDoubleTap(null, first), false);
		assert.equal(isDoubleTap(first, {t: 1200, x: 110, y: 104}), true);
		assert.equal(isDoubleTap(first, {t: 1400, x: 100, y: 100}), false, 'too slow');
		assert.equal(isDoubleTap(first, {t: 1100, x: 180, y: 100}), false, 'too far apart');
	});

	test('a pinch scales by the fingers\' spread and pans with their midpoint', () => {
		const start = restView(STAGE, BASE);
		const startMid = {x: 172, y: 278};
		const spot = toCard(start, BASE, startMid.x, startMid.y);
		const mid = {x: 150, y: 300};
		const view = pinchView(start, startMid, 100, mid, 250, 4);

		near(view.s, 2.5, 1e-9, 'spread 2.5 times');

		const under = toCard(view, BASE, mid.x, mid.y);

		near(under.u, spot.u, 1e-9, 'the pinched spot follows the fingers (u)');
		near(under.v, spot.v, 1e-9, 'the pinched spot follows the fingers (v)');
	});

	test('a pinch past the max resists, and settles back to the max about the fingers', () => {
		const start = {s: 3, tx: -300, ty: -400};
		const view = pinchView(start, {x: 100, y: 100}, 100, {x: 100, y: 100}, 300, 4);

		assert.ok(view.s > 4 && view.s < 9, `past the max but slowed: ${view.s}`);

		const settled = settleView(view, STAGE, BASE, 4, 100, 100);

		assert.equal(settled.s, 4);
		assert.ok(inside(settled, STAGE, BASE));

		const shrunk = pinchView(restView(STAGE, BASE), {x: 172, y: 278}, 200, {x: 172, y: 278}, 100, 4);

		assert.ok(shrunk.s < 1 && shrunk.s > 0.5, `below 1 but slowed: ${shrunk.s}`);
		assert.deepEqual(settleView(shrunk, STAGE, BASE, 4), restView(STAGE, BASE), 'back to the whole card');
	});

	test('an animated zoom keeps its fixed point still all the way', () => {
		const a = restView(STAGE, BASE);
		const b = zoomAbout(a, 3, 80, 90);

		for (const t of [0, 0.25, 0.5, 0.75, 1]) {
			const view = zoomStep(a, b, t);
			const spot = toCard(view, BASE, 80, 90);
			const target = toCard(a, BASE, 80, 90);

			near(spot.u, target.u, 1e-9, `u at t=${t}`);
			near(spot.v, target.v, 1e-9, `v at t=${t}`);
		}

		near(zoomStep(a, b, 1).s, 3, 1e-9, 'ends at the target');
		assert.deepEqual(zoomStep({s: 2, tx: 0, ty: 0}, {s: 2, tx: -100, ty: -40}, 0.5), {s: 2, tx: -50, ty: -20}, 'a pan alone mixes linearly');
	});
});

describe('panning with momentum', () => {
	test('the release speed comes from the last 100 ms, and a finger that stopped throws nothing', () => {
		const samples = [{t: 0, x: 0, y: 0}, {t: 150, x: 10, y: 0}, {t: 200, x: 40, y: 10}, {t: 250, x: 70, y: 20}];
		const v = velocityOf(samples, 250);

		near(v.x, 60 / 100, 1e-9, 'x speed');
		near(v.y, 20 / 100, 1e-9, 'y speed');
		assert.deepEqual(velocityOf(samples, 400), {x: 0, y: 0}, 'held still before lifting');
		assert.deepEqual(velocityOf([{t: 0, x: 0, y: 0}], 0), {x: 0, y: 0});
	});

	test('a flick glides, slows down, and stops', () => {
		const start = {s: 3, tx: -400, ty: -600};
		const velocity = {x: -0.5, y: 0};
		const early = momentumAt(start, velocity, 50, STAGE, BASE);
		const later = momentumAt(start, velocity, 400, STAGE, BASE);
		const end = momentumAt(start, velocity, 5000, STAGE, BASE);

		assert.ok(early.view.tx < start.tx && later.view.tx < early.view.tx, 'it keeps going the way it was thrown');
		assert.ok(early.view.tx - later.view.tx < (start.tx - early.view.tx) * 7, 'slower later than at first');
		assert.equal(early.done, false);
		assert.equal(end.done, true, 'stops by itself');
		near(end.view.tx, Math.max(bounds(STAGE, BASE, 3).minX, start.tx - 0.5 * 325), 1, 'travels speed x tau in all');
	});

	test('a flick stops at the edge instead of throwing the image off screen', () => {
		const start = {s: 2, tx: -10, ty: -100};
		const result = momentumAt(start, {x: 3, y: 0}, 300, STAGE, BASE);

		assert.equal(result.view.tx, 0, 'held at the left edge');
		assert.equal(result.done, true, 'nothing left to move');
		assert.ok(inside(result.view, STAGE, BASE));
	});
});

describe('Compare: synchronized coordinates', () => {
	// Portrait Compare on a 360 x 740 phone: two stages of 344 x 274 (stacked).
	// The official image is 600 x 825, the photo 600 x 840 (or its detail
	// copy, 1440 x 2016): different pixel sizes and slightly different shapes.
	const stage = {height: 274, width: 344};
	const official = fitSize(stage, 600 / 825);
	const photo = fitSize(stage, 600 / 840);
	const detail = fitSize(stage, 1440 / 2016);

	test('zooming into a corner of one shows the same card spot on the other', () => {
		// Zoom 5 x into the bottom-right corner of the official image (the
		// energy symbol's corner, 12 percent in from each edge).
		const rest = restView(stage, official);
		const corner = {x: rest.tx + official.width * 0.88, y: rest.ty + official.height * 0.88};
		const lead = clampView(zoomAbout(rest, 5, corner.x, corner.y), stage, official, 6);
		const focus = cardFocus(lead, stage, official);
		const follow = viewForFocus(focus, stage, photo, 6);
		const there = cardFocus(follow, stage, photo);

		assert.equal(follow.s, 5, 'the same zoom');
		near(there.u, focus.u, 1e-9, 'the same card spot across (u)');
		near(there.v, focus.v, 1e-9, 'the same card spot down (v)');

		// Away from the middle the two agree to within the shapes' difference
		// (the official scan is 2 percent wider than the 5:7 photo): under a
		// third of a percent of the card across, exactly down.
		for (const [x, y] of [[0, 0], [stage.width, stage.height], [100, 37]]) {
			const a = toCard(lead, official, x, y);
			const b = toCard(follow, photo, x, y);

			near(a.u, b.u, 0.005, `u at (${x}, ${y})`);
			near(a.v, b.v, 1e-9, `v at (${x}, ${y})`);
		}
	});

	test('the pixel size of the image does not matter, only the card coordinates', () => {
		const lead = clampView(zoomAbout(restView(stage, photo), 3, 60, 40), stage, photo, 6);
		const onDetail = viewForFocus(cardFocus(lead, stage, photo), stage, detail, 6);

		for (const key of ['s', 'tx', 'ty']) {
			near(onDetail[key], lead[key], 1e-9, `the 1440 x 2016 copy takes the 600 x 840 copy's ${key}`);
		}
	});

	test('at the very edge, each side stops at its own edge and shows the same corner', () => {
		const lead = clampView({s: 5, tx: -1e6, ty: -1e6}, stage, official, 6);
		const follow = viewForFocus(cardFocus(lead, stage, official), stage, photo, 6);
		const leadCorner = toCard(lead, official, stage.width, stage.height);
		const followCorner = toCard(follow, photo, stage.width, stage.height);

		assert.ok(inside(follow, stage, photo));
		near(leadCorner.u, 1, 1e-9, 'the official image\'s bottom-right corner at the stage corner');
		near(followCorner.u, 1, 1e-9, 'and the photo\'s');
		near(followCorner.v, 1, 1e-9, 'and the photo\'s');
	});

	test('the follower stays inside its own bounds', () => {
		// The landscape halves differ: 362 x 240. Focus the very top-left on
		// the photo; the official image, a little wider, still clamps.
		const wide = {height: 240, width: 362};
		const a = fitSize(wide, 600 / 840);
		const b = fitSize(wide, 600 / 825);
		const lead = clampView({s: 4, tx: 0, ty: 0}, wide, a, 6);
		const follow = viewForFocus(cardFocus(lead, wide, a), wide, b, 6);

		assert.ok(inside(follow, wide, b));
		near(cardFocus(follow, wide, b).u, cardFocus(lead, wide, a).u, 0.01, 'within one percent of the card across');
	});

	test('at zoom 1 both show the whole card', () => {
		const follow = viewForFocus(cardFocus(restView(stage, official), stage, official), stage, photo, 6);

		assert.deepEqual(follow, restView(stage, photo));
	});
});

describe('Compare: the default pair', () => {
	const official = 'https://img/official.webp';
	const photo = (id, side = 'front') => newPhoto({created_at: '2026-10-01T00:00:00.000Z', id, path: `u/e/${id}.webp`, side});
	const entry = (photos) => ({deleted_at: null, id: 'e', photos});

	test('the official image beside the photo, whichever was showing', () => {
		const slides = gallerySlides({entries: [entry([photo('p1'), photo('p2')])], official});

		assert.deepEqual(comparePair(slides, 0), [0, 1], 'from the official image: the first photo');
		assert.deepEqual(comparePair(slides, 2), [0, 2], 'from a photo: that photo');
	});

	test('the international print stands in for a missing official image', () => {
		const slides = gallerySlides({entries: [entry([photo('p1')])], twins: [{src: 'https://img/twin.webp'}]});

		assert.deepEqual(comparePair(slides, 1), [0, 1]);
		assert.equal(slides[0].kind, 'twin');
	});

	test('two photos and no print: the current one and its neighbor', () => {
		const slides = gallerySlides({entries: [entry([photo('f'), photo('b', 'back')])]});

		assert.deepEqual(comparePair(slides, 0), [0, 1]);
		assert.deepEqual(comparePair(slides, 1), [0, 1]);
		assert.equal(comparePair(slides.slice(0, 1), 0), null, 'one image: nothing to compare');
	});
});

describe('the detail copy', () => {
	test('lives beside the normal copy, inside the path rule of supabase/photos.sql', async () => {
		const sql = await readFile(new URL('../supabase/photos.sql', import.meta.url), 'utf8');
		const rule = /select object_name ~ '([^']+)';/.exec(sql);

		assert.ok(rule, 'photos.sql has the is_photo_path regular expression');

		const allowed = new RegExp(rule[1]);
		const user = '0f8fad5b-d9cb-469f-a165-70867728950e';
		const entryId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
		const photoId = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
		const normal = photoPath(user, entryId, photoId, 'image/webp');

		assert.equal(detailPath(normal, 'image/webp'), `${user}/${entryId}/${photoId}-detail.webp`);
		assert.equal(detailPath(photoPath(user, entryId, photoId, 'image/jpeg'), 'image/jpeg'), `${user}/${entryId}/${photoId}-detail.jpg`);
		assert.equal(detailPath(null), null, 'no path yet, no detail path');
		assert.ok(allowed.test(normal), 'the normal path is allowed');
		assert.ok(allowed.test(detailPath(normal, 'image/webp')), 'so is the -detail path, with no SQL change');
		assert.ok(allowed.test(detailPath(normal, 'image/jpeg')), 'and its JPEG form');

		const limit = /file_size_limit[^\n]*\n\s*values \([^)]*?, (\d+), array/.exec(sql);

		assert.ok(limit, 'photos.sql sets the bucket\'s file size limit');
		assert.equal(Number(limit[1]), BUCKET_LIMIT_BYTES);
		assert.ok(DETAIL_MAX_BYTES < BUCKET_LIMIT_BYTES, 'a detail copy always fits the bucket');
	});

	test('is recorded on the photo with its size and type, and only when given', () => {
		const at = '2026-10-01T00:00:00.000Z';

		assert.deepEqual(newPhoto({created_at: at, detail: {height: 2016, type: 'image/webp', width: 1440}, id: 'p'}).detail, {height: 2016, type: 'image/webp', width: 1440});
		assert.equal('detail' in newPhoto({created_at: at, id: 'p'}), false);
		assert.equal('detail' in newPhoto({created_at: at, detail: {height: 0, width: 0}, id: 'p'}), false);
	});

	test('is as tall as the card in the photo, up to 1440 x 2016, in the normal copy\'s shape', () => {
		const rect = (w, h) => [{x: 0, y: 0}, {x: w, y: 0}, {x: w, y: h}, {x: 0, y: h}];

		assert.deepEqual(detailSize(rect(2200, 3080)), {height: DETAIL_HEIGHT, width: DETAIL_WIDTH}, 'a big card: the full size');
		assert.deepEqual(detailSize(rect(1000, 1400)), {height: 1400, width: 1000});
		assert.equal(detailSize(rect(700, 1000)), null, 'barely bigger than the normal copy: none');

		for (const height of [1050, 1234, 1777, 2016]) {
			const size = detailSize(rect(height * 5 / 7, height));

			near(size.width / size.height, PHOTO_WIDTH / PHOTO_HEIGHT, 0.001, `the 5:7 shape at ${height}`);
		}
	});

	// A stand-in encoder: bytes grow with the pixels and the quality, about
	// as WebP does on a busy card photo (0.85 at 1440 x 2016 is about 700 KB).
	const fakeEncoder = (bytesPerPixelAtFull) => {
		const calls = [];
		const encode = async (quality, width, height) => {
			calls.push({height, quality, width});

			return {size: Math.round(width * height * bytesPerPixelAtFull * quality ** 2)};
		};

		return {calls, encode};
	};

	test('is encoded under 500 KB, stepping the quality down first', async () => {
		const {calls, encode} = fakeEncoder(0.33);
		const result = await fitEncoding(encode, {height: DETAIL_HEIGHT, width: DETAIL_WIDTH});

		assert.ok(result.blob.size <= DETAIL_MAX_BYTES, `${result.blob.size} bytes`);
		assert.ok(result.blob.size >= 300 * 1024, `not needlessly small: ${result.blob.size}`);
		assert.ok(result.quality < 0.85 && result.quality >= 0.5, `quality stepped down to ${result.quality}`);
		assert.equal(result.width, DETAIL_WIDTH, 'at full size');
		assert.ok(calls.every((call, i) => i === 0 || call.quality < calls[i - 1].quality), 'one step down at a time');
	});

	test('a photo too busy for 500 KB at the lowest quality is made smaller instead', async () => {
		const {calls, encode} = fakeEncoder(1.2);
		const result = await fitEncoding(encode, {height: DETAIL_HEIGHT, width: DETAIL_WIDTH});

		assert.ok(result.blob.size <= DETAIL_MAX_BYTES);
		assert.ok(result.width < DETAIL_WIDTH && result.height < DETAIL_HEIGHT, `shrunk to ${result.width} x ${result.height}`);
		assert.ok(calls.some((call) => call.quality === 0.5), 'the lowest quality was tried first');
	});

	test('a simple photo keeps the first quality', async () => {
		const {calls, encode} = fakeEncoder(0.1);
		const result = await fitEncoding(encode, {height: DETAIL_HEIGHT, width: DETAIL_WIDTH});

		assert.equal(calls.length, 1);
		assert.equal(result.quality, 0.85);
		assert.ok(result.blob.size < DETAIL_TARGET_BYTES);
	});

	test('gives up with a message when nothing fits', async () => {
		await assert.rejects(fitEncoding(async () => ({size: 10 * 1024 * 1024}), {height: 100, width: 100}), /small enough/);
	});
});

describe('when the detail copy is fetched', () => {
	test('only once the zoom spreads one pixel of the normal copy over more than one device pixel', () => {
		// 600 px wide photo on 344 CSS px.
		assert.equal(needsDetail(1, 344, 600, 1), false, 'never at zoom 1');
		assert.equal(needsDetail(1.6, 344, 600, 1), false, '550 px of screen for 600 px of image');
		assert.equal(needsDetail(1.8, 344, 600, 1), true, '619 px of screen for 600 px of image');
		assert.equal(needsDetail(1.2, 344, 600, 2), true, 'a 2x screen needs it sooner');
		assert.equal(needsDetail(1.2, 344, 600, 3), true, 'a 3x screen counts as 2x');
		assert.equal(needsDetail(1.04, 344, 600, 3), false, 'a hair over 1 is still the whole card');
		assert.equal(needsDetail(3, 344, 0, 1), false, 'no image yet');
	});
});
