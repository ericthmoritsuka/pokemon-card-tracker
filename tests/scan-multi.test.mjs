// Several cards in one frame (js/scan/steady.js findCards and findPage,
// js/scan/multi.js pageShape and pageCells; lab/multi), on synthetic grey
// copies of the frame like tests/scan-find.test.mjs draws: cards with a
// border, a busy art box, and lines of text, laid in a binder page's 3 x 3
// grid on a dark backing or apart on a table. The app does not call these
// yet; lab/multi measures them on real card images.
//
// Run: node --test tests/scan-multi.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {pageCells, pageShape, quadPoint} from '../js/scan/multi.js';
import {findCard, findCards, findPage} from '../js/scan/steady.js';

const W = 202;
const H = 360;

// A grey view of `cards` ({cx, cy, size (height in pixels), angle, seed})
// over a ground of `ground` grey, each pixel averaging 3 x 3 samples, as a
// camera's does, with a little fixed noise.
function view(cards, ground = 40) {
	const grey = new Uint8Array(W * H);
	const sample = (x, y) => {
		let v = ground;

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
				v = 210;
			}
			else if (u > 0.08 && u < 0.92 && w > 0.1 && w < 0.48) {
				v = 60 + ((Math.floor(u * 30) * 37 * seed + Math.floor(w * 40) * 23) % 140);
			}
			else if (w > 0.55 && w < 0.9 && Math.floor(w * 50) % 4 === 0 && u > 0.1 && u < 0.8 && Math.floor(u * 40) % 5 < 3) {
				v = 60;
			}
			else {
				v = 185;
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

const middle = (corners) => ({x: corners.reduce((sum, c) => sum + c.x, 0) / 4, y: corners.reduce((sum, c) => sum + c.y, 0) / 4});

// A 3 x 3 page of cards `size` pixels tall, centred, the cards a twentieth
// of a card's width apart; `skip` the pockets left empty.
function page(size = 80, skip = []) {
	const cw = (size * 63) / 88;
	const gap = cw * 0.05;
	const cards = [];

	for (let row = 0; row < 3; row++) {
		for (let col = 0; col < 3; col++) {
			if (!skip.includes(row * 3 + col)) {
				cards.push({cx: W / 2 + (col - 1) * (cw + gap), cy: H / 2 + (row - 1) * (size + gap), seed: row * 3 + col + 1, size});
			}
		}
	}

	return {cards, gap, height: size * 3 + gap * 2, width: cw * 3 + gap * 2};
}

describe('several cards apart on a table (findCards)', () => {
	test('three cards, turned a little, are each found once, by their own outline', () => {
		const cards = [{angle: 6, cx: 58, cy: 80, seed: 2, size: 100}, {angle: -5, cx: 150, cy: 115, seed: 3, size: 100}, {angle: 3, cx: 100, cy: 265, seed: 4, size: 100}];
		const found = findCards(view(cards), W, H);

		assert.equal(found.length, 3, `found ${found.length}`);

		for (const card of cards) {
			const hits = found.filter((one) => Math.hypot(middle(one.corners).x - card.cx, middle(one.corners).y - card.cy) < card.size * 0.1);

			assert.equal(hits.length, 1, `card at ${card.cx}, ${card.cy}`);
			assert.ok(Math.abs(hits[0].ratio - 63 / 88) < 0.05, `shape ${hits[0].ratio}`);
		}
	});

	test('a single card is one card, found by its own corners', () => {
		const card = {cx: 101, cy: 180, size: 200};
		const found = findCards(view([card]), W, H);
		const truth = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => ({x: card.cx + (u * card.size * 63) / 88 / 2, y: card.cy + (v * card.size) / 2}));

		assert.equal(found.length, 1);
		found[0].corners.forEach((c, k) => assert.ok(Math.hypot(c.x - truth[k].x, c.y - truth[k].y) < card.size * 0.04, `corner ${k}`));
	});

	test('an empty table has no cards', () => {
		assert.deepEqual(findCards(view([]), W, H), []);
	});
});

describe('a binder page (findPage, findCards, pageCells)', () => {
	test('the page is found by its outer cards\' edges, and its pockets fall on its cards', () => {
		const {cards, height, width} = page();
		const found = findPage(view(cards), W, H, {shape: pageShape(3, 3)});

		assert.ok(found, 'page found');

		const box = {h: Math.max(...found.corners.map((c) => c.y)) - Math.min(...found.corners.map((c) => c.y)), w: Math.max(...found.corners.map((c) => c.x)) - Math.min(...found.corners.map((c) => c.x))};

		assert.ok(Math.abs(box.w / width - 1) < 0.06, `width ${box.w.toFixed(1)} against ${width.toFixed(1)}`);
		assert.ok(Math.abs(box.h / height - 1) < 0.06, `height ${box.h.toFixed(1)} against ${height.toFixed(1)}`);

		const cells = pageCells(found.corners, 3, 3);

		assert.equal(cells.length, 9);
		cells.forEach((cell, i) => {
			const at = middle(cell.card);

			assert.ok(Math.hypot(at.x - cards[i].cx, at.y - cards[i].cy) < cards[i].size * 0.06, `pocket ${i}`);
		});
	});

	test('the free search takes a page apart into its cards, not the page as one card', () => {
		// The cards' sides run on into their neighbours' (they lie in rows),
		// which findCard would leave out; at this size a card's art box foot
		// can still make a half card win over the card (lab/multi measures
		// it on real images), so eight of nine is the floor here.
		const {cards} = page();
		const found = findCards(view(cards), W, H);
		const hit = new Set();

		assert.ok(found.length >= 8, `found ${found.length}`);

		for (const one of found) {
			const at = middle(one.corners);
			const index = cards.findIndex((card) => Math.abs(at.x - card.cx) < (card.size * 63) / 88 / 2 && Math.abs(at.y - card.cy) < card.size / 2);

			assert.ok(index >= 0 && !hit.has(index), `one box per card (${at.x.toFixed(0)}, ${at.y.toFixed(0)})`);
			hit.add(index);
		}
	});

	test('two cards side by side stay one box: the case the lab counts as a failure', () => {
		const cards = [{cx: 65, cy: 120, seed: 2, size: 100}, {cx: 65 + (100 * 63) / 88 + 0.5, cy: 120, seed: 3, size: 100}];
		const found = findCards(view(cards), W, H);

		assert.equal(found.length, 1);
		assert.equal(found[0].upright, false);
	});

	test('a page with an empty middle pocket is still found', () => {
		const {cards} = page(80, [4]);

		assert.ok(findPage(view(cards), W, H, {shape: pageShape(3, 3)}));
	});
});

describe('the page\'s grid (pageShape, quadPoint, pageCells)', () => {
	test('a 3 x 3 page has nearly a card\'s shape, and a 3 x 4 page a narrower one', () => {
		assert.ok(Math.abs(pageShape(3, 3) / (63 / 88) - 1) < 0.02);
		assert.ok(pageShape(4, 3) < 0.6);
	});

	test('a square page\'s corners map to themselves, and its middle to its middle', () => {
		const square = [{x: 0, y: 0}, {x: 10, y: 0}, {x: 10, y: 10}, {x: 0, y: 10}];

		assert.deepEqual(quadPoint(square, 1, 1), {x: 10, y: 10});
		assert.deepEqual(quadPoint(square, 0.5, 0.5), {x: 5, y: 5});
	});

	test('a page seen at a slant is divided as it lies: the far row is shorter', () => {
		const slanted = [{x: 20, y: 0}, {x: 80, y: 0}, {x: 100, y: 100}, {x: 0, y: 100}];
		const cells = pageCells(slanted, 3, 3);
		const tall = (cell) => cell.card[3].y - cell.card[0].y;

		assert.ok(tall(cells[0]) < tall(cells[6]), `${tall(cells[0]).toFixed(1)} against ${tall(cells[6]).toFixed(1)}`);
		assert.ok(cells[4].cut[0].x < cells[4].card[0].x && cells[4].cut[2].y > cells[4].card[2].y, 'the cut is larger than the card');
	});
});
