// A whole binder page from one still photo (js/scan/page.js): where the page
// lies in a grey copy of the photo, on synthetic copies like
// tests/scan-multi.test.mjs draws; how it is cut into pockets; which pocket
// is empty; and the lines Eric reads.
//
// Run: node --test tests/scan-page.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {isEmptyPocket, locatePage, ownFits, pageSummary, pageTrouble, pocketPlan, pocketProgress, pocketQuads} from '../js/scan/page.js';
import {COLOURLESS} from '../js/scan/steady.js';

const W = 202;
const H = 360;

// A grey view of `cards` ({cx, cy, size (height in pixels), angle, seed})
// over a ground of `ground` grey, as tests/scan-multi.test.mjs draws it.
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

// A 3 x 3 page of cards `size` pixels tall, centred at (cx, cy), the cards a
// twentieth of a card's width apart; `skip` the pockets left empty.
function page({cx = W / 2, cy = H / 2, size = 80, skip = []} = {}) {
	const cw = (size * 63) / 88;
	const gap = cw * 0.05;
	const cards = [];

	for (let row = 0; row < 3; row++) {
		for (let col = 0; col < 3; col++) {
			if (!skip.includes(row * 3 + col)) {
				cards.push({cx: cx + (col - 1) * (cw + gap), cy: cy + (row - 1) * (size + gap), index: row * 3 + col, seed: row * 3 + col + 1, size});
			}
		}
	}

	return cards;
}

const middle = (corners) => ({x: corners.reduce((sum, c) => sum + c.x, 0) / 4, y: corners.reduce((sum, c) => sum + c.y, 0) / 4});

describe('where the page lies (locatePage)', () => {
	test('a page of nine cards is found, set right by its cards, and its pockets fall on them', () => {
		const cards = page();
		const found = locatePage(view(cards), W, H);

		assert.equal(found.status, 'page');
		assert.ok(found.fitted >= 3, `fitted to ${found.fitted} cards`);

		const plan = pocketPlan(found.corners, 1);

		assert.equal(plan.length, 9);
		plan.forEach((pocket, i) => {
			// The card's place is the cut less its pad: its middle is the cut's.
			const at = middle(pocket.cut);

			assert.ok(Math.hypot(at.x - cards[i].cx, at.y - cards[i].cy) < cards[i].size * 0.06, `pocket ${i + 1} at ${at.x.toFixed(1)}, ${at.y.toFixed(1)}`);
		});
	});

	test('a page with two empty pockets is still found', () => {
		assert.equal(locatePage(view(page({skip: [2, 4]})), W, H).status, 'page');
	});

	test('a table with no page says none, with no corners', () => {
		const found = locatePage(view([]), W, H);

		assert.equal(found.status, 'none');
		assert.equal(found.corners, null);
	});

	test('a single card filling the photo is not taken for a page', () => {
		for (const size of [150, 200, 250, 300]) {
			assert.equal(locatePage(view([{cx: 101, cy: 180, seed: 3, size}]), W, H).status, 'none', `a card ${size} pixels tall`);
		}
	});

	test('a spread taken with the phone turned, two lying pages, is refused as a spread', () => {
		const size = 60;
		const down = (size * 63) / 88;
		const gap = down * 0.05;
		const cards = [];

		for (const [p, cy] of [H / 2 - (down * 3 + gap * 2) / 2 - 12, H / 2 + (down * 3 + gap * 2) / 2 + 12].entries()) {
			for (let row = 0; row < 3; row++) {
				for (let col = 0; col < 3; col++) {
					cards.push({angle: 90, cx: W / 2 + (col - 1) * (size + gap), cy: cy + (row - 1) * (down + gap), seed: p * 9 + row * 3 + col + 1, size});
				}
			}
		}

		assert.equal(locatePage(view(cards), W, H).status, 'spread');
	});
});

describe('the pockets (pocketPlan, ownFits, isEmptyPocket, pocketQuads)', () => {
	// A page 300 x 420 on the copy, at half the photo's size.
	const corners = [{x: 10, y: 20}, {x: 310, y: 20}, {x: 310, y: 440}, {x: 10, y: 440}];

	test('nine pockets row by row, card-shaped, cut in the photo\'s pixels with a pad round the card', () => {
		const plan = pocketPlan(corners, 0.5);

		assert.deepEqual(plan.map((pocket) => [pocket.index, pocket.row, pocket.col]), [[0, 0, 0], [1, 0, 1], [2, 0, 2], [3, 1, 0], [4, 1, 1], [5, 1, 2], [6, 2, 0], [7, 2, 1], [8, 2, 2]]);

		for (const pocket of plan) {
			assert.ok(Math.abs(pocket.width / pocket.height - 63 / 88) < 0.01, `pocket ${pocket.index} is card-shaped`);
			// The photo is twice the copy: a pocket's card is about 2 x 420 / 3.1
			// tall there, and its cut 1.2 times that.
			assert.ok(Math.abs(pocket.height - (2 * 420 / (3 + 2 * 0.05 * 63 / 88)) * 1.2) < 3, `pocket ${pocket.index} height ${pocket.height}`);
			// The card's place inside the cut is the cut less its pad.
			assert.ok(Math.abs(pocket.inner[0].x - pocket.width * 0.1 / 1.2) < 0.01);
			assert.ok(Math.abs(pocket.inner[2].y - pocket.height * (1 - 0.1 / 1.2)) < 0.01);
		}

		assert.ok(plan[0].cut[0].x < 20 && plan[0].cut[0].y < 40, 'the first cut starts at the page\'s corner, less its pad');
	});

	test('a pocket is never cut taller than 1400 pixels', () => {
		assert.ok(pocketPlan(corners, 0.05).every((pocket) => pocket.height === 1400 && pocket.width === Math.round(1400 * 63 / 88)));
	});

	test('a card\'s own outline counts when it stands and is about the pocket\'s card in size', () => {
		const inner = [{x: 10, y: 10}, {x: 110, y: 10}, {x: 110, y: 150}, {x: 10, y: 150}];
		const scaled = (k) => inner.map((p) => ({x: 60 + (p.x - 60) * k, y: 80 + (p.y - 80) * k}));

		assert.equal(ownFits({corners: inner, upright: true}, inner), true);
		assert.equal(ownFits({corners: scaled(0.7), upright: true}, inner), false, 'a half-size box is an art box');
		assert.equal(ownFits({corners: scaled(1.1), upright: false}, inner), false, 'a lying box is not the card');
		assert.equal(ownFits(null, inner), false);
	});

	test('a pocket is empty only with no outline and no colour', () => {
		assert.equal(isEmptyPocket({colour: 0.5, own: null}), true);
		assert.equal(isEmptyPocket({colour: COLOURLESS + 1, own: null}), false, 'a colourful pocket holds a card its outline was not found for');
		assert.equal(isEmptyPocket({colour: 0.5, own: {corners: []}}), false, 'a grey card with its outline found');
	});

	test('a card is cut by its own outline first, then by its pocket\'s place', () => {
		const inner = [{x: 1, y: 1}, {x: 2, y: 1}, {x: 2, y: 2}, {x: 1, y: 2}];
		const own = {corners: [{x: 0, y: 0}, {x: 3, y: 0}, {x: 3, y: 3}, {x: 0, y: 3}], ratio: 0.71};

		assert.deepEqual(pocketQuads(own, inner), [{corners: own.corners, ratio: 0.71, upright: true}, {corners: inner, ratio: 63 / 88, upright: true}]);
		assert.deepEqual(pocketQuads(null, inner), [{corners: inner, ratio: 63 / 88, upright: true}]);
	});
});

describe('what Eric reads (pocketProgress, pageSummary, pageTrouble)', () => {
	test('progress names the pocket', () => {
		assert.equal(pocketProgress(4, 9), 'Reading pocket 4 of 9.');
	});

	test('the summary counts the cards added, those to check, and the empty pockets', () => {
		assert.equal(pageSummary({added: 9, empty: 0, look: 0}), 'Page read: 9 cards added.');
		assert.equal(pageSummary({added: 7, empty: 2, look: 3}), 'Page read: 7 cards added, 3 to check. 2 empty pockets skipped.');
		assert.equal(pageSummary({added: 1, empty: 1, look: 1}), 'Page read: 1 card added, 1 to check. 1 empty pocket skipped.');
		assert.equal(pageSummary({added: 8, empty: 1, look: 8, rough: true}), 'Page read: 8 cards added, 8 to check. 1 empty pocket skipped. The page edges were unclear, so check each card.');
		assert.equal(pageSummary({added: 0, empty: 9, look: 0}), 'Every pocket on that page looked empty.');
	});

	test('a page not read says why and asks for the photo again', () => {
		assert.match(pageTrouble('none'), /^The page could not be found in that photo\. Take it again/);
		assert.match(pageTrouble('spread'), /two pages\. Take one page at a time/);
		assert.match(pageTrouble('unreadable'), /could not be opened/);

		for (const status of ['none', 'spread', 'unreadable']) {
			assert.ok(!/\u2014/.test(pageTrouble(status)), 'no em dash');
		}
	});
});
