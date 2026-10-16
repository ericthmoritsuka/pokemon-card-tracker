// Automatic corners for a new card photo (js/photos/detect.js) on made-up
// photos: a card with a clear edge, a tilted card, and the hard case, a
// silver-bordered card on a silver table whose outer edge barely shows.
// Every image is drawn here; no personal photos.
//
// Before this finder (v40, the outline and rectify finders alone), measured
// with the same images: clear edge 0.5 px off at worst, tilted card 0.4 px,
// silver on silver 152.6 px (no card found: the centred default box). Now:
// clear edge 1.6 px, tilted 1.0 px, silver on silver 1.2 px (tolerance 18.5).
//
// Run: node --test tests/photo-corners.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {detectCorners, shrink} from '../js/photos/detect.js';
import {applyHomography, distance, solveHomography} from '../js/photos/geometry.js';
import {toGrey} from '../js/scan/steady.js';
import {nearestSnap, snapPoints} from '../js/snap.js';

// A made-up card face: a border of `border` colour, an art box with dark
// shapes, and a light text box below it.
export function cardFace({border = [238, 200, 52], height = 440, inner = [214, 208, 196], width = 315} = {}) {
	const data = new Uint8ClampedArray(width * height * 4);
	const edge = Math.round(width * 0.045);

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let rgb;

			if (x < edge || y < edge || x >= width - edge || y >= height - edge) {
				rgb = border;
			}
			else if (y > height * 0.1 && y < height * 0.48 && x > width * 0.08 && x < width * 0.92) {
				const dark = ((x >> 4) + (y >> 4)) % 3 === 0;

				rgb = dark ? [40, 60, 90] : [120 + (x % 60), 170, 200 - (y % 50)];
			}
			else {
				rgb = inner;
			}

			data.set([...rgb, 255], (y * width + x) * 4);
		}
	}

	return {data, height, width};
}

// Draws `face` so its corners land on `quad`, on a noisy grey background of
// `background` level that brightens by `slope` from top to bottom.
export function photoOf(face, quad, width, height, {background = 24, slope = 10} = {}) {
	const data = new Uint8ClampedArray(width * height * 4);
	const h = solveHomography(quad, [{x: 0, y: 0}, {x: face.width, y: 0}, {x: face.width, y: face.height}, {x: 0, y: face.height}]);
	let seed = 11;
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
				const n = noise() * 0.5;

				data.set([face.data[i] + n, face.data[i + 1] + n, face.data[i + 2] + n, 255], o);
			}
			else {
				const value = background + noise() + (y / height) * slope;

				data.set([value, value, value + 3, 255], o);
			}
		}
	}

	return {data, height, width};
}

const worst = (found, quad) => Math.max(...found.corners.map((p, i) => distance(p, quad[i])));

export const CASES = {
	clear: {
		face: () => cardFace(),
		options: {},
		quad: [{x: 180, y: 160}, {x: 600, y: 160}, {x: 600, y: 747}, {x: 180, y: 747}],
	},
	silver: {
		face: () => cardFace({border: [196, 196, 200], inner: [228, 224, 216]}),
		options: {background: 182, slope: 8},
		quad: [{x: 190, y: 170}, {x: 590, y: 182}, {x: 576, y: 740}, {x: 176, y: 728}],
	},
	tilted: {
		face: () => cardFace(),
		options: {background: 60},
		quad: [{x: 260, y: 150}, {x: 640, y: 260}, {x: 500, y: 790}, {x: 120, y: 680}],
	},
};

const SIZE = {height: 960, width: 780};
// 1.5 percent of the photo's diagonal, as the older detection tests allow.
const TOLERANCE = Math.hypot(SIZE.width, SIZE.height) * 0.015;

describe('automatic corners for a card photo', () => {
	for (const [name, {face, options, quad}] of Object.entries(CASES)) {
		test(`finds the ${name} card's corners within 1.5 percent`, () => {
			const photo = photoOf(face(), quad, SIZE.width, SIZE.height, options);
			const found = detectCorners(photo);
			const off = worst(found, quad);

			console.log(`# ${name}: ${found.method}, worst corner ${off.toFixed(1)} px, unsure ${found.unsure}`);
			assert.equal(found.found, true, found.note);
			assert.ok(off <= TOLERANCE, `${name}: worst corner ${off.toFixed(1)} px off (${found.method})`);
		});
	}

	test('a clear edge is sure, and the silver card on silver asks for a contrasting surface', () => {
		const clear = detectCorners(photoOf(CASES.clear.face(), CASES.clear.quad, SIZE.width, SIZE.height));
		const silver = detectCorners(photoOf(CASES.silver.face(), CASES.silver.quad, SIZE.width, SIZE.height, CASES.silver.options));

		assert.equal(clear.unsure, false);
		assert.equal(silver.unsure, true);
	});

	test('of two cards, the whole one is chosen, not the pair', () => {
		const width = 900;
		const height = 900;
		const left = [{x: 80, y: 180}, {x: 400, y: 180}, {x: 400, y: 627}, {x: 80, y: 627}];
		const right = [{x: 500, y: 200}, {x: 820, y: 200}, {x: 820, y: 647}, {x: 500, y: 647}];
		const one = photoOf(cardFace(), left, width, height);
		const two = photoOf(cardFace(), right, width, height);

		// Both cards on one background: the right card copied over the left photo.
		for (let i = 0; i < one.data.length; i += 4) {
			if (two.data[i] > 80) {
				one.data.set(two.data.subarray(i, i + 4), i);
			}
		}

		const found = detectCorners(one);
		const off = Math.min(worst(found, left), worst(found, right));

		assert.equal(found.found, true);
		assert.ok(off <= TOLERANCE, `worst corner ${off.toFixed(1)} px from either card`);
	});
});

// ----------------------------------------------------------- snap points

describe('snap points for the corner editor', () => {
	test('the card\'s four corners are among the snap points; a plain picture has none', () => {
		const {face, options, quad} = CASES.tilted;
		const half = quad.map((p) => ({x: p.x / 2, y: p.y / 2}));
		// As the editor reads it: a smoothed copy 360 pixels on its long side.
		const {image, scale} = shrink(photoOf(face(), half, 390, 480, options), 360);
		const points = snapPoints(toGrey(image.data, image.width, image.height), image.width, image.height).map((p) => ({x: p.x / scale, y: p.y / scale}));

		half.forEach((corner, i) => {
			const nearest = Math.min(...points.map((p) => distance(p, corner)));

			assert.ok(nearest <= 5, `corner ${i}: nearest snap point ${nearest.toFixed(1)} px away`);
		});

		assert.deepEqual(snapPoints(new Uint8Array(390 * 480).fill(90), 390, 480), []);
	});

	test('the nearest point within the radius wins, and none beyond it', () => {
		const points = [{x: 10, y: 10}, {x: 14, y: 10}];

		assert.equal(nearestSnap({x: 13, y: 10}, points, 5), points[1]);
		assert.equal(nearestSnap({x: 30, y: 10}, points, 5), null);
	});

	// A grey 360 x 450 picture: a 63:88 card, a square tile, and a 2:1 strip
	// on a dark table; none of the last two is card-shaped.
	function decoys() {
		const width = 360;
		const height = 450;
		const grey = new Uint8Array(width * height).fill(40);
		const fill = (x0, y0, w, hgt, value) => {
			for (let y = y0; y < y0 + hgt; y++) {
				grey.fill(value, y * width + x0, y * width + x0 + w);
			}
		};

		fill(40, 40, 126, 176, 220);
		fill(70, 70, 66, 60, 120);
		fill(220, 60, 100, 100, 200);
		fill(200, 300, 140, 70, 190);

		return {grey, height, width};
	}

	test('only card-like corners snap: a square tile and a 2:1 strip give none', () => {
		const {grey, height, width} = decoys();
		const points = snapPoints(grey, width, height);
		const near = (x, y) => Math.min(Infinity, ...points.map((p) => Math.hypot(p.x - x, p.y - y)));

		for (const [x, y] of [[40, 40], [166, 40], [166, 216], [40, 216]]) {
			assert.ok(near(x, y) <= 4, `card corner (${x}, ${y}): nearest ${near(x, y).toFixed(1)}`);
		}

		for (const [x, y] of [[220, 60], [320, 60], [320, 160], [220, 160], [200, 300], [340, 300], [340, 370], [200, 370], [70, 70], [136, 130]]) {
			assert.ok(near(x, y) > 6, `no snap at decoy corner (${x}, ${y}): nearest ${near(x, y).toFixed(1)}`);
		}
	});
});
