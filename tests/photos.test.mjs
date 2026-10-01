// Unit tests for the owner's card photos: corner math and the warp
// (js/photos/geometry.js), corner detection (js/photos/detect.js), and the
// carousel and tile rules plus photo-list merging (js/photos/model.js).
//
// Run: node --test tests/photos.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {detectCorners, otsu, refineCorners, shrink} from '../js/photos/detect.js';
import {
	PHOTO_HEIGHT,
	PHOTO_WIDTH,
	applyHomography,
	cornersFromRect,
	defaultCorners,
	distance,
	fitWithin,
	isConvexQuad,
	orderCorners,
	portraitCorners,
	quadSize,
	rotateCorners,
	solveHomography,
	sourceScaleFor,
	warp,
} from '../js/photos/geometry.js';
import {
	gallerySlides,
	livePhotos,
	mainImage,
	mergePhotoLists,
	newPhoto,
	patchedPhotos,
	pathOwner,
	photoPath,
	photoType,
	restoredPhotos,
} from '../js/photos/model.js';
import {mergeEntries} from '../js/merge.js';

const near = (actual, expected, tolerance, message) => {
	assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} is not within ${tolerance} of ${expected}`);
};

const nearPoint = (actual, expected, tolerance, message) => {
	assert.ok(distance(actual, expected) <= tolerance, `${message}: (${actual.x.toFixed(1)}, ${actual.y.toFixed(1)}) is ${distance(actual, expected).toFixed(1)} px from (${expected.x}, ${expected.y})`);
};

// ----------------------------------------------------------- test images

// A made-up card face, 315 x 440: a yellow border, a light art box with dark
// shapes, and a text box, like a real card's frames.
function cardFace(width = 315, height = 440) {
	const data = new Uint8ClampedArray(width * height * 4);
	const border = Math.round(width * 0.045);

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const o = (y * width + x) * 4;
			let rgb;

			if (x < border || y < border || x >= width - border || y >= height - border) {
				rgb = [238, 200, 52];
			}
			else if (y > height * 0.1 && y < height * 0.48 && x > width * 0.08 && x < width * 0.92) {
				const dark = ((x >> 4) + (y >> 4)) % 3 === 0;

				rgb = dark ? [40, 60, 90] : [120 + (x % 60), 170, 200 - (y % 50)];
			}
			else {
				rgb = [214, 208, 196];
			}

			data.set([...rgb, 255], o);
		}
	}

	return {data, height, width};
}

// Draws `face` onto a dark, noisy width x height background so its corners
// land on `quad`, by inverse mapping each background pixel into the face.
function photoOf(face, quad, width, height, background = 24) {
	const data = new Uint8ClampedArray(width * height * 4);
	const h = solveHomography(quad, [{x: 0, y: 0}, {x: face.width, y: 0}, {x: face.width, y: face.height}, {x: 0, y: face.height}]);
	let seed = 7;
	const noise = () => {
		seed = (seed * 1103515245 + 12345) % 2147483648;

		return (seed / 2147483648) * 12 - 6;
	};

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const o = (y * width + x) * 4;
			const p = applyHomography(h, x + 0.5, y + 0.5);

			if (p.x >= 0 && p.y >= 0 && p.x < face.width && p.y < face.height) {
				const i = (Math.floor(p.y) * face.width + Math.floor(p.x)) * 4;

				data.set([face.data[i], face.data[i + 1], face.data[i + 2], 255], o);
			}
			else {
				const value = background + noise() + (y / height) * 10;

				data.set([value, value, value + 4, 255], o);
			}
		}
	}

	return {data, height, width};
}

const pixel = (img, x, y) => {
	const o = (y * img.width + x) * 4;

	return [img.data[o], img.data[o + 1], img.data[o + 2]];
};

// ----------------------------------------------------------- geometry

describe('corner math', () => {
	test('a homography maps each corner onto its target', () => {
		const from = [{x: 0, y: 0}, {x: 600, y: 0}, {x: 600, y: 840}, {x: 0, y: 840}];
		const to = [{x: 112, y: 95}, {x: 690, y: 140}, {x: 742, y: 1010}, {x: 60, y: 980}];
		const h = solveHomography(from, to);

		from.forEach((p, i) => nearPoint(applyHomography(h, p.x, p.y), to[i], 1e-6, `corner ${i}`));
	});

	test('three corners in a line have no homography', () => {
		const line = [{x: 0, y: 0}, {x: 1, y: 1}, {x: 2, y: 2}, {x: 0, y: 5}];

		assert.equal(solveHomography(line, line.map((p) => ({x: p.x * 2, y: p.y * 2}))), null);
	});

	test('corners in any order come back top-left first, clockwise', () => {
		const quad = [{x: 700, y: 980}, {x: 100, y: 100}, {x: 60, y: 990}, {x: 680, y: 120}];
		const ordered = orderCorners(quad);

		assert.deepEqual(ordered, [{x: 100, y: 100}, {x: 680, y: 120}, {x: 700, y: 980}, {x: 60, y: 990}]);
		assert.ok(isConvexQuad(ordered));
		assert.ok(!isConvexQuad([ordered[0], ordered[2], ordered[1], ordered[3]]), 'a crossed quad is not convex');
	});

	test('a sideways card is turned to portrait, and Rotate turns a quarter at a time', () => {
		const landscape = [{x: 100, y: 100}, {x: 980, y: 100}, {x: 980, y: 730}, {x: 100, y: 730}];
		const portrait = portraitCorners(landscape);
		const size = quadSize(portrait);

		assert.ok(size.height > size.width, 'portrait after reordering');
		assert.deepEqual(rotateCorners(landscape, 4), landscape);
		assert.deepEqual(rotateCorners(landscape, 1)[0], landscape[3], 'one step makes the old bottom-left the top-left');
	});

	test('rectify\'s turned crop maps back onto the card\'s corners in the photo', () => {
		// rectify turns the photo back by `angle` and crops `rect` in the turned
		// image. A crop centred on the image turns about the same centre.
		const width = 800;
		const height = 1000;
		const rect = {h: 560, w: 400, x: 200, y: 220};
		const corners = cornersFromRect(rect, 10, width, height);
		const unrotated = cornersFromRect(rect, 0, width, height);

		assert.deepEqual(unrotated.map((p) => [Math.round(p.x), Math.round(p.y)]), [[200, 220], [600, 220], [600, 780], [200, 780]]);

		// Turning keeps the side lengths and the centre.
		near(distance(corners[0], corners[1]), 400, 1e-6, 'top side');
		near(distance(corners[1], corners[2]), 560, 1e-6, 'right side');
		near((corners[0].x + corners[2].x) / 2, 400, 1e-6, 'centre x');
		near((corners[0].y + corners[2].y) / 2, 500, 1e-6, 'centre y');

		// Positive angle is clockwise: the top-left corner moves right and up.
		assert.ok(corners[0].x > 200 && corners[0].y < 220 + 60, 'clockwise turn');
	});

	test('the default handles are a centred card-shaped box', () => {
		const quad = defaultCorners(1000, 1000);
		const {height, width} = quadSize(quad);

		near(width / height, 63 / 88, 1e-9, 'aspect');
		near(height, 800, 1e-9, 'height');
		near(quad[0].x + quad[2].x, 1000, 1e-9, 'centred');
	});

	test('fitWithin and sourceScaleFor never enlarge', () => {
		assert.deepEqual(fitWithin(4000, 3000, 2000), {height: 1500, scale: 0.5, width: 2000});
		assert.equal(fitWithin(300, 200, 2000).scale, 1);
		assert.equal(sourceScaleFor([{x: 0, y: 0}, {x: 100, y: 0}, {x: 100, y: 140}, {x: 0, y: 140}]), 1);
		near(sourceScaleFor([{x: 0, y: 0}, {x: 2000, y: 0}, {x: 2000, y: 2800}, {x: 0, y: 2800}]), 1050 / 2800, 1e-9, 'scale');
	});
});

describe('warp', () => {
	test('the saved photo is 600 x 840, opaque, with the card straightened', () => {
		const face = cardFace();
		const quad = [{x: 140, y: 120}, {x: 640, y: 170}, {x: 690, y: 880}, {x: 90, y: 860}];
		const photo = photoOf(face, quad, 800, 1000);
		const out = warp(photo, quad);

		assert.equal(PHOTO_WIDTH, 600);
		assert.equal(PHOTO_HEIGHT, 840);
		assert.equal(out.width, 600);
		assert.equal(out.height, 840);
		assert.equal(out.data.length, 600 * 840 * 4);
		assert.ok(out.data.every((value, i) => i % 4 !== 3 || value === 255), 'every pixel opaque');

		// Every corner region of the result is the yellow border, never the
		// dark background, and the middle of the text box is the light grey.
		for (const [x, y] of [[8, 8], [591, 8], [591, 831], [8, 831], [300, 4], [4, 420]]) {
			const [r, g, b] = pixel(out, x, y);

			assert.ok(r > 200 && g > 160 && b < 110, `border at ${x},${y} is yellow, got ${r},${g},${b}`);
		}

		const [r, g, b] = pixel(out, 300, 700);

		assert.ok(r > 190 && g > 190 && b > 170, `text box is light grey, got ${r},${g},${b}`);
	});

	test('a reused buffer is filled in place at any preview size', () => {
		const face = cardFace();
		const buffer = new Uint8ClampedArray(200 * 280 * 4);
		const out = warp(face, [{x: 0, y: 0}, {x: 315, y: 0}, {x: 315, y: 440}, {x: 0, y: 440}], 200, 280, buffer);

		assert.equal(out.data, buffer);
		assert.equal(out.width, 200);
		assert.equal(out.height, 280);
	});
});

// ----------------------------------------------------------- detection

describe('corner detection', () => {
	test('finds a tilted card on a dark background within 1.5 percent', () => {
		const face = cardFace();
		const quad = [{x: 210, y: 180}, {x: 760, y: 240}, {x: 800, y: 1010}, {x: 150, y: 990}];
		const photo = photoOf(face, quad, 960, 1280);
		const found = detectCorners(photo);
		const tolerance = Math.hypot(960, 1280) * 0.015;

		assert.equal(found.found, true, found.note);
		found.corners.forEach((p, i) => nearPoint(p, quad[i], tolerance, `corner ${i} (${found.method})`));
	});

	test('finds a turned card that fills the frame, as the scanner captures it', () => {
		const face = cardFace(630, 880);
		const angle = (6 * Math.PI) / 180;
		const cx = 380;
		const cy = 510;
		const corners = [[-280, -390], [280, -390], [280, 390], [-280, 390]].map(([x, y]) => ({
			x: cx + x * Math.cos(angle) - y * Math.sin(angle),
			y: cy + x * Math.sin(angle) + y * Math.cos(angle),
		}));
		const photo = photoOf(face, corners, 760, 1020, 40);
		const found = detectCorners(photo);

		assert.equal(found.found, true, found.note);
		found.corners.forEach((p, i) => nearPoint(p, corners[i], 18, `corner ${i} (${found.method})`));
	});

	test('a photo with no card gives the centred default handles, not a guess', () => {
		const width = 600;
		const height = 800;
		const data = new Uint8ClampedArray(width * height * 4).fill(60);
		const found = detectCorners({data, height, width});

		assert.equal(found.found, false);
		assert.equal(found.method, 'none');
		assert.deepEqual(found.corners, defaultCorners(width, height));
	});

	test('the corners come back in the full photo\'s pixels after the shrink', () => {
		const face = cardFace();
		const quad = [{x: 420, y: 360}, {x: 1520, y: 480}, {x: 1600, y: 2020}, {x: 300, y: 1980}];
		const photo = photoOf(face, quad, 1920, 2560);
		const {scale} = shrink(photo);
		const found = detectCorners(photo);

		assert.ok(scale < 0.5, 'the photo was shrunk for detection');
		found.corners.forEach((p, i) => nearPoint(p, quad[i], Math.hypot(1920, 2560) * 0.015, `corner ${i}`));
	});

	test('refining leaves rough corners alone when the sides have no points', () => {
		const rough = [{x: 0, y: 0}, {x: 10, y: 0}, {x: 10, y: 14}, {x: 0, y: 14}];

		assert.deepEqual(refineCorners(rough, []), rough);
	});

	test('Otsu splits a two-tone image between its tones', () => {
		const grey = new Float32Array(1000).map((_, i) => (i < 600 ? 30 : 210));
		const t = otsu(grey);

		assert.ok(t >= 30 && t < 210, `threshold ${t}`);
	});
});

// ----------------------------------------------------------- model

const AT = '2026-09-01T00:00:00.000Z';
const LATER = '2026-09-02T00:00:00.000Z';

const photo = (id, fields = {}) => ({...newPhoto({created_at: AT, id, path: `u1/e1/${id}.webp`}), ...fields});

const entry = (id, fields = {}) => ({card_id: 'me01-001', catalog: 'international', created_at: AT, deleted_at: null, id, language: 'en', updated_at: AT, ...fields});

describe('main image', () => {
	test('with no pin, the official image comes first', () => {
		const e = entry('e1', {photos: [photo('p1')]});

		assert.deepEqual(mainImage(e, 'https://img/official'), {kind: 'official', label: 'Official', src: 'https://img/official'});
	});

	test('a card with no official image shows the owner\'s photo (Korean Storm Emerald)', () => {
		const e = entry('k1', {catalog: 'ja', language: 'ko', photos: [photo('p1')]});
		const choice = mainImage(e, null);

		assert.equal(choice.kind, 'photo');
		assert.equal(choice.photo.id, 'p1');
		assert.equal(choice.entry, e);
		assert.equal(choice.src, null);
	});

	test('no image at all is "none", and a twin fills in before photos', () => {
		assert.deepEqual(mainImage(entry('e1'), null), {kind: 'none', label: null, src: null});
		assert.equal(mainImage(entry('e1', {photos: [photo('p1')]}), null, {twins: [{src: 'https://img/twin'}]}).kind, 'twin');
	});

	test('a pin wins, and falls back when its image is gone', () => {
		const pinned = entry('e1', {main_image: 'p1', photos: [photo('p1')]});

		assert.equal(mainImage(pinned, 'https://img/official').kind, 'photo');

		const removed = entry('e1', {main_image: 'p1', photos: [photo('p1', {deleted_at: LATER})]});

		assert.equal(mainImage(removed, 'https://img/official').kind, 'official');

		const twinPin = entry('e1', {main_image: 'twin'});

		assert.equal(mainImage(twinPin, 'https://img/official').kind, 'official', 'no twin provided');
		assert.equal(mainImage(twinPin, 'https://img/official', {twins: [{src: 'https://img/twin'}]}).kind, 'twin');
	});

	test('a tile of several copies uses every copy\'s photos and the newest pin', () => {
		const a = entry('a', {main_image: 'official', photos: [photo('pa')], updated_at: AT});
		const b = entry('b', {main_image: 'pa', updated_at: LATER});
		const gone = entry('c', {deleted_at: LATER, main_image: 'official', updated_at: '2026-09-03T00:00:00.000Z'});
		const choice = mainImage([a, b, gone], 'https://img/official');

		assert.equal(choice.kind, 'photo');
		assert.equal(choice.photo.id, 'pa');
		assert.equal(choice.entry, a, 'the photo\'s own entry');
	});

	test('the carousel order is official, twin, fronts, then backs, oldest first', () => {
		const e = entry('e1', {photos: [
			photo('back1', {side: 'back'}),
			photo('front2', {created_at: LATER}),
			photo('front1'),
			photo('gone', {deleted_at: LATER}),
		]});
		const slides = gallerySlides({entries: [e], official: 'o', twins: [null, {src: 't'}]});

		assert.deepEqual(slides.map((slide) => slide.id), ['official', 'twin', 'front1', 'front2', 'back1']);
		assert.deepEqual(slides.map((slide) => slide.label), ['Official', 'International print', 'Your photo', 'Your photo', 'Your photo, back']);
		assert.deepEqual(livePhotos(entry('d', {deleted_at: LATER, photos: [photo('x')]})), [], 'a removed entry has no photos');
	});
});

describe('photo paths', () => {
	test('a path is <user_id>/<entry_id>/<photo_id>.webp, or .jpg for the JPEG fallback', () => {
		assert.equal(photoPath('u1', 'e1', 'p1'), 'u1/e1/p1.webp');
		assert.equal(photoPath('u1', 'e1', 'p1', 'image/jpeg'), 'u1/e1/p1.jpg');
		assert.equal(photoType('u1/e1/p1.jpg'), 'image/jpeg');
		assert.equal(photoType('u1/e1/p1.webp'), 'image/webp');
		assert.equal(pathOwner('u1/e1/p1.webp'), 'u1');
		assert.equal(pathOwner(null), null);
	});

	test('a new photo is a front unless it says back', () => {
		assert.equal(newPhoto({created_at: AT, id: 'p', side: 'sideways'}).side, 'front');
		assert.deepEqual(newPhoto({created_at: AT, id: 'p', side: 'back'}), {created_at: AT, deleted_at: null, id: 'p', path: null, side: 'back'});
	});
});

describe('entry field merging', () => {
	test('photo lists merge by id: a removal and a known path are never lost', () => {
		const local = [photo('p1', {path: null}), photo('p2')];
		const remote = [photo('p1'), photo('p2', {deleted_at: LATER}), photo('p3')];
		const merged = mergePhotoLists(local, remote);

		assert.deepEqual(merged.map((item) => item.id), ['p1', 'p2', 'p3']);
		assert.equal(merged[0].path, 'u1/e1/p1.webp', 'the uploaded path wins');
		assert.equal(merged[1].deleted_at, LATER, 'the tombstone wins');
	});

	test('the document merge keeps the newer entry whole, photos and main_image included', () => {
		const mine = entry('e1', {main_image: 'p1', photos: [photo('p1')], updated_at: LATER});
		const theirs = entry('e1', {condition: 'Near Mint', updated_at: AT});
		const [merged] = mergeEntries([theirs], [mine]);

		assert.equal(merged, mine);
		assert.equal(merged.main_image, 'p1');
	});

	test('photos this phone made come back after a newer edit from another phone drops them', () => {
		const made = [photo('p1')];
		const fromOtherPhone = entry('e1', {condition: 'Near Mint', updated_at: LATER});

		assert.deepEqual(restoredPhotos(fromOtherPhone, made).map((item) => item.id), ['p1']);
		assert.equal(restoredPhotos(entry('e1', {photos: [photo('p1', {deleted_at: LATER})]}), made), null, 'a removal elsewhere stays');
		assert.equal(restoredPhotos(entry('e1', {deleted_at: LATER}), made), null, 'a removed card stays removed');
		assert.equal(restoredPhotos(entry('e1', {photos: [photo('p1')]}), made), null, 'nothing missing');
	});

	test('one photo can be patched in place', () => {
		const e = entry('e1', {photos: [photo('p1', {path: null}), photo('p2')]});
		const patched = patchedPhotos(e, 'p1', {path: 'u1/e1/p1.webp'});

		assert.equal(patched[0].path, 'u1/e1/p1.webp');
		assert.equal(patched[1], e.photos[1]);
		assert.equal(patchedPhotos(e, 'missing', {}), null);
	});
});
