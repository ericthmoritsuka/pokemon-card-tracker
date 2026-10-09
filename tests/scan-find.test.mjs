// Finding the card anywhere in the frame, and holder mode's auto capture
// (js/scan/steady.js findCard and createHolderCapture, Eric, 2026-10-09),
// on synthetic grey copies of the whole view: a white box seen from above
// (its floor, and walls running out to the frame's edges), cards with a
// border, a busy art box, and lines of text, at any place, size, and turn,
// and piled one on another.
//
// Run: node --test tests/scan-find.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {numberSide} from '../js/scan/identify.js';
import {createHolderCapture, findCard, HOLDER_SETTLE_MS, motion} from '../js/scan/steady.js';

const W = 150;
const H = 200;

// A grey view of `cards` ({cx, cy, size (height in pixels), angle, border,
// seed}, later ones on top), over a white box (walls: true) or a plain
// light floor. Each pixel averages 3 x 3 samples, as a camera's does, with
// a little fixed noise.
function view({cards = [], walls = true} = {}) {
	const grey = new Uint8Array(W * H);
	const sample = (x, y) => {
		let v = 235;

		if (walls) {
			const fx = W * 0.1;
			const fy = H * 0.17;

			if (x < fx || x > W - fx || y < fy || y > H - fy) {
				v = x < fx || x > W - fx ? 214 : 226;
			}
		}

		for (const c of cards) {
			const ch = c.size;
			const cw = (ch * 63) / 88;
			const a = ((c.angle || 0) * Math.PI) / 180;
			const dx = x - c.cx;
			const dy = y - c.cy;
			const u = (dx * Math.cos(a) + dy * Math.sin(a)) / cw + 0.5;
			const w = (-dx * Math.sin(a) + dy * Math.cos(a)) / ch + 0.5;

			if (u < 0 || u >= 1 || w < 0 || w >= 1) {
				continue;
			}

			const seed = c.seed || 1;

			if (u < 0.045 || u > 0.955 || w < 0.035 || w > 0.965) {
				v = c.border ?? 200;
			}
			else if (u > 0.08 && u < 0.92 && w > 0.1 && w < 0.48) {
				v = 60 + ((Math.floor(u * 30) * 37 * seed + Math.floor(w * 40) * 23) % 140);
			}
			else if (w > 0.55 && w < 0.9 && Math.floor(w * 50) % 4 === 0 && u > 0.1 && u < 0.8 && Math.floor(u * 40) % 5 < 3) {
				v = 60;
			}
			else {
				v = 225;
			}
		}

		return v;
	};

	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			let sum = 0;

			for (let sy = 0; sy < 3; sy++) {
				for (let sx = 0; sx < 3; sx++) {
					sum += sample(x + (sx + 0.5) / 3, y + (sy + 0.5) / 3);
				}
			}

			grey[y * W + x] = Math.max(0, Math.min(255, Math.round(sum / 9 + (((x * 7919 + y * 104729) % 97) / 97 - 0.5) * 4)));
		}
	}

	return grey;
}

// The corners a card drawn by view() has (top left first, clockwise).
function corners({angle = 0, cx, cy, size}) {
	const a = (angle * Math.PI) / 180;
	const hw = (size * 63) / 88 / 2;
	const hh = size / 2;

	return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([u, v]) => ({x: cx + u * Math.cos(a) - v * Math.sin(a), y: cy + u * Math.sin(a) + v * Math.cos(a)}));
}

// The farthest any corner found is from the card's, in pixels.
const cornerError = (quad, card) => Math.max(...corners(card).map((c, k) => Math.hypot(c.x - quad[k].x, c.y - quad[k].y)));

const find = (cards, options) => findCard(view({cards, ...options}), W, H);

describe('the card anywhere in the frame (findCard)', () => {
	test('a card filling the frame, small, beside the middle, or turned is found by its own corners', () => {
		const cases = [
			{cx: 75, cy: 100, size: 150},
			{cx: 75, cy: 100, size: 80},
			{cx: 50, cy: 70, size: 90},
			{angle: 15, cx: 75, cy: 100, size: 130},
			{angle: -9, cx: 85, cy: 110, size: 110},
		];

		for (const card of cases) {
			const found = find([card]);

			assert.ok(found.quad, `found: ${JSON.stringify(card)}`);
			// The card's edge, or its inner border a few pixels in: the picture
			// match chooses (identify.js), and the straightening refines it.
			assert.ok(cornerError(found.quad, card) <= card.size * 0.07, `${JSON.stringify(card)}: corners within 7 % (${cornerError(found.quad, card).toFixed(1)} px)`);
			assert.ok(Math.abs(found.ratio - 63 / 88) < 0.04, `${JSON.stringify(card)}: shape ${found.ratio}`);
			assert.equal(found.touching, false);
		}
	});

	test('a card turned 40 degrees or lying on its side is found, and says which way it lies', () => {
		const turned = find([{angle: 40, cx: 75, cy: 100, size: 110}]);

		assert.ok(turned.quad);
		assert.ok(Math.abs(turned.angle - 40) <= 3, `angle ${turned.angle}`);

		const lying = find([{angle: 90, cx: 75, cy: 100, size: 120}]);

		assert.ok(lying.quad);
		assert.equal(lying.upright, false);
	});

	test('an empty box, its walls running off the frame, is no card and no pile', () => {
		const found = find([]);

		assert.equal(found.quad, null);
		assert.equal(found.touching, false);
	});

	test('a card running off the frame (a pile too high) is no card, but touching', () => {
		const found = find([{cx: 75, cy: 120, size: 190}]);

		assert.equal(found.quad, null, 'never a whole card');
		assert.equal(found.touching, true);
	});

	test('on a pile, the card on top is found, not the outline of two cards together', () => {
		const below = {angle: -4, cx: 70, cy: 92, seed: 2, size: 150};
		const top = {angle: 3, cx: 78, cy: 108, seed: 3, size: 150};
		const found = find([below, top]);

		assert.ok(found.quad);

		// The two cards' union is far from a card's shape; what is found has
		// one, and among its outlines (the picture chooses) one is the top card.
		const outlines = [found.quad, ...found.others.map((other) => other.corners)];
		const best = Math.min(...outlines.map((quad) => cornerError(quad, top)));

		assert.ok(Math.abs(found.ratio - 63 / 88) < 0.05, `shape ${found.ratio}`);
		assert.ok(best <= top.size * 0.08, `the top card among the outlines (${best.toFixed(1)} px off)`);
	});

	test('a silver border on the white floor is found', () => {
		const card = {border: 222, cx: 75, cy: 100, size: 120};
		const found = find([card]);

		assert.ok(found.quad);
		assert.ok(cornerError(found.quad, card) <= card.size * 0.07);
	});
});

describe('holder mode\'s auto capture (createHolderCapture)', () => {
	// A run of views, one every 125 ms (the scanner's frame loop): each
	// [view, {card, touching}].
	function run(detector, frames, start = 0) {
		const out = [];

		frames.forEach(([grey, seen], i) => {
			out.push(detector.push(grey, W, H, seen, start + i * 125));
		});

		return out;
	}

	const empty = view();
	const landed = (cy) => view({cards: [{cx: 75, cy, size: 140}]});

	test('a card falling in is taken once, after it settles, never mid-motion', () => {
		const detector = createHolderCapture();
		// Empty box, then the card falling (moving down 12 px a frame, no
		// whole card yet), then lying still.
		const frames = [
			...Array.from({length: 6}, () => [empty, {card: false}]),
			...[30, 42, 54, 66, 78].map((cy) => [landed(cy), {card: false}]),
			...Array.from({length: 12}, () => [landed(90), {card: true}]),
		];
		const steps = run(detector, frames);
		const fired = steps.map((step, i) => (step.capture ? i : -1)).filter((i) => i >= 0);

		assert.ok(fired.length >= 1);
		assert.ok(fired[0] >= 11 + Math.ceil(HOLDER_SETTLE_MS / 125), `not before the settle: frame ${fired[0]}`);
		assert.ok(steps[fired[0]].settleMs >= HOLDER_SETTLE_MS);

		detector.captured();

		const after = run(detector, Array.from({length: 12}, () => [landed(90), {card: true}]), 5000);

		assert.equal(after.filter((step) => step.capture).length, 0, 'taken once');
	});

	test('the next card landing on the pile arms the next capture', () => {
		const detector = createHolderCapture();
		const one = landed(90);
		const two = view({cards: [{cx: 75, cy: 90, size: 140}, {angle: 4, cx: 80, cy: 98, seed: 3, size: 140}]});

		run(detector, Array.from({length: 8}, () => [one, {card: true}]));
		detector.captured();

		const steps = run(detector, [[one, {card: true}], [two, {card: false}], ...Array.from({length: 8}, () => [two, {card: true}])], 3000);

		assert.equal(steps.filter((step) => step.capture).length >= 1, true);
	});

	test('a card that settled running off the frame says the pile is too high, and is not taken', () => {
		const detector = createHolderCapture();
		const high = view({cards: [{cx: 75, cy: 120, size: 190}]});
		const steps = run(detector, Array.from({length: 10}, () => [high, {card: false, touching: true}]));

		assert.equal(steps.some((step) => step.capture), false);
		assert.equal(steps[steps.length - 1].pile, true);
	});

	test('the camera brightening the whole picture a little is not motion', () => {
		const brighter = empty.map((value) => Math.min(255, value + 6));

		assert.ok(motion(empty, brighter) < 1, 'a uniform change');
		assert.ok(motion(empty, landed(90)) > 5, 'a card landing');
	});
});

describe('which number strip to read first (identify.js numberSide)', () => {
	const picture = (ids) => ({groups: ids.map((id) => ({cards: [{catalog: 'international', id}], score: 50}))});

	test('Scarlet & Violet and Mega Evolution cards print it at the bottom left; XY and older at the right', () => {
		assert.equal(numberSide(picture(['me03-067', 'sv06-066', 'SV6-039'])), 'left');
		assert.equal(numberSide(picture(['xy7-48', 'base1-4', 'neo1-3'])), 'right');
		assert.equal(numberSide(null), 'left');
	});
});
