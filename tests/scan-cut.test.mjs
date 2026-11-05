// The strong-slant cut (DESIGN.md section 6, measured 2026-11-04, fixed
// 2026-11-05): a card held larger than the guide, or turned, runs out of the
// capture, and the straightening (js/scan/rectify.js outOfCapture) places
// the edge it cannot see from the edges it can, rather than stop at a line
// inside the card; and the whole-frame search (js/scan/steady.js findCard)
// takes no box inside a card running off the frame for a card. On
// synthetic captures: a table, a card with a border, a busy art box, lines
// of text, and a dark weakness row across it near its foot.
//
// Run: node --test tests/scan-cut.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {outOfCapture, rectify, rectQuad} from '../js/scan/rectify.js';
import {findCard} from '../js/scan/steady.js';

const RATIO = 63 / 88;

// Where a card of height `ch`, centred on (cx, cy) and turned `angle`
// degrees clockwise, has the point (u, v) of its face (0 to 1 across and
// down), and back.
function frameOf({angle = 0, ch, cx, cy}) {
	const a = (angle * Math.PI) / 180;
	const cw = ch * RATIO;

	return {
		corners: [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => {
			const x = (u - 0.5) * cw;
			const y = (v - 0.5) * ch;

			return {x: cx + x * Math.cos(a) - y * Math.sin(a), y: cy + x * Math.sin(a) + y * Math.cos(a)};
		}),
		face: (x, y) => {
			const dx = x - cx;
			const dy = y - cy;

			return {u: (dx * Math.cos(a) + dy * Math.sin(a)) / cw + 0.5, v: (-dx * Math.sin(a) + dy * Math.cos(a)) / ch + 0.5};
		},
	};
}

// A capture W x H of one card on a dark table: border 215, body 180, a
// busy art box, lines of text, and the weakness row, a dark bar across the
// card inside its border 86 to 88 % of the way down (the line the box
// stopped at before the fix).
function capture({W = 520, H = 726, ...card}) {
	const {corners, face} = frameOf(card);
	const data = new Uint8ClampedArray(W * H * 4);

	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const {u, v} = face(x, y);
			let value = 70;

			if (u >= 0 && u < 1 && v >= 0 && v < 1) {
				if (u < 0.04 || u > 0.96 || v < 0.03 || v > 0.97) {
					value = 215;
				}
				else if (u > 0.08 && u < 0.92 && v > 0.11 && v < 0.48) {
					value = 60 + ((Math.floor(u * 90) * 7 + Math.floor(v * 120) * 13) % 70);
				}
				else if (u > 0.06 && u < 0.94 && v > 0.86 && v < 0.88) {
					value = 40;
				}
				else if (u > 0.1 && u < 0.8 && v > 0.55 && v < 0.82 && Math.floor(v * 100) % 5 === 0) {
					value = 45;
				}
				else {
					value = 180;
				}
			}

			data.set([value, value, value, 255], (y * W + x) * 4);
		}
	}

	return {corners, image: {data, height: H, width: W}};
}

// How far the box cut lies from the card, as shares of the card's height:
// the farthest corner, and how far the box's bottom sits inside the card
// (positive: the crop stops short of it).
function boxError(straight, image, truth) {
	const quad = straight.corners || rectQuad(image, straight.rect, straight.angle || 0);
	const tall = Math.hypot(truth[3].x - truth[0].x, truth[3].y - truth[0].y);
	const down = {x: (truth[3].x - truth[0].x) / tall, y: (truth[3].y - truth[0].y) / tall};
	const along = (p) => (p.x - truth[0].x) * down.x + (p.y - truth[0].y) * down.y;

	return {
		bottom: (tall - (along(quad[2]) + along(quad[3])) / 2) / tall,
		error: Math.max(...quad.map((p, i) => Math.hypot(p.x - truth[i].x, p.y - truth[i].y))) / tall,
	};
}

// A capture 520 x 726 holds a card 605 px tall (the guide's 83 % of the
// capture) with table all round; these hold one 14 % larger, its foot
// 19 px past the capture's edge.
const CUT = {ch: 690, cx: 260, cy: 400};

describe('a card whose foot runs out of the capture (rectify.js outOfCapture)', () => {
	test('straight: the bottom is placed from the top and the width, past the capture, not at the weakness row', () => {
		const {corners, image} = capture(CUT);
		const straight = rectify(image);
		const box = boxError(straight, image, corners);

		assert.ok(straight.found, straight.note);
		assert.equal(straight.placed, true, straight.note);
		assert.equal(straight.guessed, 'bottom');
		assert.ok(box.error <= 0.03, `box within 3 % (${box.error.toFixed(3)}): ${straight.note}`);
		assert.ok(straight.rect.y + straight.rect.h > image.height, 'the crop runs past the capture');
		assert.ok(straight.others.some((other) => other.how === 'the bottom edge found'), 'the box hung from the bottom found is kept for the picture');
		assert.ok(Math.abs(straight.card.width / straight.card.height - RATIO) < 0.006, 'card-shaped');
	});

	test('turned 16 degrees either way, its foot out of the capture: the bottom is placed, and the crop reaches it', () => {
		// Before the fix these were cut at the weakness row, 12 % short.
		for (const angle of [-16, 16]) {
			const {corners, image} = capture({...CUT, angle, ch: 680});
			const straight = rectify(image);
			const box = boxError(straight, image, corners);

			assert.ok(straight.found, `${angle}: ${straight.note}`);
			assert.equal(straight.placed, true, `${angle}: ${straight.note}`);
			assert.equal(straight.guessed, 'bottom', `${angle}: ${straight.note}`);
			assert.ok(Math.abs(box.bottom) <= 0.03, `${angle} degrees: the bottom ${box.bottom.toFixed(3)} short (${straight.note})`);
			assert.ok(box.error <= 0.04, `${angle} degrees: box within 4 % (${box.error.toFixed(3)}): ${straight.note}`);
		}
	});

	test('held low, the weakness row on the capture\'s last rows: the bottom is placed, not the top worked out from that row', () => {
		// The card's foot 74 px past the capture, its weakness row 16 px
		// inside it: too near the edge to show the sides below it.
		for (const angle of [0, -3, 3]) {
			const {corners, image} = capture({angle, ch: 690, cx: 260, cy: 455});
			const straight = rectify(image);
			const box = boxError(straight, image, corners);

			assert.ok(straight.found, `${angle}: ${straight.note}`);
			assert.equal(straight.placed, true, `${angle}: ${straight.note}`);
			assert.equal(straight.guessed, 'bottom', `${angle}: ${straight.note}`);
			assert.ok(Math.abs(box.bottom) <= 0.02, `${angle} degrees: the bottom ${box.bottom.toFixed(3)} short (${straight.note})`);
			assert.ok(box.error <= 0.03, `${angle} degrees: box within 3 % (${box.error.toFixed(3)}): ${straight.note}`);
		}
	});

	test('a box a few percent short whose bottom is on the capture\'s last rows is snapped as before, not placed', () => {
		// The foot 12 px past the capture and the border's inner line found
		// for it: 3 % short, within half the shape's slack.
		const {corners, image} = capture({ch: 690, cx: 260, cy: 393});
		const straight = rectify(image);
		const box = boxError(straight, image, corners);

		assert.ok(straight.found, straight.note);
		assert.equal(straight.placed, false, straight.note);
		assert.ok(box.error <= 0.03, `box within 3 % (${box.error.toFixed(3)}): ${straight.note}`);
	});

	test('cut at the top: the top is worked out from the bottom, as before, and nothing is placed', () => {
		for (const angle of [0, -10, 10]) {
			const {corners, image} = capture({...CUT, angle, cy: 326});
			const straight = rectify(image);
			const box = boxError(straight, image, corners);

			assert.ok(straight.found, `${angle}: ${straight.note}`);
			assert.equal(straight.guessed, 'top', `${angle}: ${straight.note}`);
			assert.equal(straight.placed, false, `${angle}: ${straight.note}`);
			assert.ok(Math.abs(box.bottom) <= 0.02, `${angle} degrees: bottom ${box.bottom.toFixed(3)}`);
		}
	});

	test('a normal capture, the card inside it with table all round, is cut as before', () => {
		for (const [angle, ch] of [[0, 605], [-4, 605], [4, 605], [-12, 560], [12, 560], [18, 560]]) {
			const {corners, image} = capture({angle, ch, cx: 260, cy: 363});
			const straight = rectify(image);
			const box = boxError(straight, image, corners);

			assert.ok(straight.found, straight.note);
			assert.equal(straight.placed, false, `${angle}: ${straight.note}`);
			assert.equal(straight.guessed, null, `${angle}: ${straight.note}`);
			assert.ok(box.error <= 0.03, `${angle} degrees: box within 3 % (${box.error.toFixed(3)})`);
		}
	});
});

// The detection copy's grey, as rectify makes it (no turn): `capture`'s
// pixels averaged to one channel.
function work(image) {
	const grey = new Float32Array(image.width * image.height);

	for (let i = 0; i < grey.length; i++) {
		grey[i] = (image.data[i * 4] + image.data[i * 4 + 1] + image.data[i * 4 + 2]) / 3;
	}

	return {grey, height: image.height, step: 18, width: image.width};
}

describe('whether a bottom edge found is the card\'s (outOfCapture)', () => {
	// The card's own edges on the copy, and the weakness row's lower line.
	const edgesOf = ({ch, cx, cy}, bottom) => ({bottom, left: Math.round(cx - (ch * RATIO) / 2), right: Math.round(cx + (ch * RATIO) / 2), top: Math.round(cy - ch / 2)});

	test('a bottom at the weakness row, the sides running on past it out of the capture: out, placed at a card\'s shape', () => {
		const card = CUT;
		const copy = work(capture(card).image);
		const weakness = Math.round(card.cy - card.ch / 2 + card.ch * 0.88);
		const placed = outOfCapture(copy, edgesOf(card, weakness));

		assert.ok(placed, 'out of the capture');
		assert.equal(placed.out.bottom, true);
		assert.equal(placed.out.left || placed.out.right || placed.out.top, false);
		assert.ok(Math.abs(placed.edges.bottom - (card.cy + card.ch / 2)) <= card.ch * 0.02, `bottom at ${Math.round(placed.edges.bottom)}, the card's at ${card.cy + card.ch / 2}`);
	});

	test('the same line where the capture holds the card\'s foot: the sides stop at the foot, so nothing is out', () => {
		const card = {ch: 605, cx: 260, cy: 363};
		const copy = work(capture(card).image);

		assert.equal(outOfCapture(copy, edgesOf(card, Math.round(card.cy - card.ch / 2 + card.ch * 0.88))), null);
		assert.equal(outOfCapture(copy, edgesOf(card, Math.round(card.cy + card.ch / 2))), null);
	});

	test('a bottom placed where the capture would show it is not placed', () => {
		// The sides run on past the weakness row, but a card of that width
		// ends inside the capture, where its foot would have been found.
		const card = {ch: 605, cx: 260, cy: 363};
		const copy = work(capture(CUT).image);

		assert.equal(outOfCapture(copy, {...edgesOf(card, Math.round(card.cy + card.ch * 0.3)), top: 35}), null);
	});
});

// A grey copy of a whole frame (W x H) holding one card turned `angle`,
// `size` pixels tall, whose art box has a lying card's shape (as a Sword &
// Shield one does), on a plain table.
function frameView({angle, cx, cy, size, W = 200, H = 300}) {
	const {face} = frameOf({angle, ch: size, cx, cy});
	const grey = new Uint8Array(W * H);

	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			let sum = 0;

			for (let s = 0; s < 4; s++) {
				const {u, v} = face(x + (s % 2) * 0.5 + 0.25, y + Math.floor(s / 2) * 0.5 + 0.25);
				let value = 120;

				if (u >= 0 && u < 1 && v >= 0 && v < 1) {
					if (u < 0.045 || u > 0.955 || v < 0.035 || v > 0.965) {
						value = 215;
					}
					else if (u > 0.08 && u < 0.92 && v > 0.1 && v < 0.53) {
						value = 50 + ((Math.floor(u * 30) * 37 + Math.floor(v * 40) * 23) % 150);
					}
					else if (v > 0.6 && v < 0.9 && Math.floor(v * 50) % 4 === 0 && u > 0.1 && u < 0.8 && Math.floor(u * 40) % 5 < 3) {
						value = 50;
					}
					else {
						value = 228;
					}
				}

				sum += value;
			}

			grey[y * W + x] = Math.round(sum / 4 + (((x * 7919 + y * 104729) % 97) / 97 - 0.5) * 4);
		}
	}

	return {grey, H, W};
}

describe('a card running off the frame round its art box (steady.js findCard)', () => {
	test('turned and larger than the frame is wide, it is no card found, but a card running off the frame', () => {
		for (const angle of [-15, 15]) {
			const {grey, H, W} = frameView({angle, cx: 100, cy: 150, size: 280});
			const found = findCard(grey, W, H);

			assert.equal(found.quad, null, `${angle} degrees: the art box is not taken for a card (${JSON.stringify(found.quad)})`);
			assert.equal(found.touching, true, `${angle} degrees`);
		}
	});

	test('the same card inside the frame is found by its own corners', () => {
		const card = {angle: 15, cx: 100, cy: 150, size: 200};
		const {grey, H, W} = frameView(card);
		const found = findCard(grey, W, H);
		const truth = frameOf({...card, ch: card.size}).corners;

		assert.ok(found.quad, 'found');
		assert.ok(Math.max(...found.quad.map((p, i) => Math.hypot(p.x - truth[i].x, p.y - truth[i].y))) <= card.size * 0.07, JSON.stringify(found.quad));
	});
});
