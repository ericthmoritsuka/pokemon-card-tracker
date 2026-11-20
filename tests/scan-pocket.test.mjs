// A binder pocket's card cut to its own edges for its number
// (js/scan/pocket.js), on synthetic pocket cuts: a dotted dark backing, the
// pocket's light welds round it, and a card with a light border lying off
// where the page put it. The real photos are measured by hand (Eric's
// binder pages are private and never enter the repo).
//
// Run: node --test tests/scan-pocket.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {cutCard, OWN_CUT_SLACK, pocketOutline, POCKET_CARD_MAX_HEIGHT, withPocketCard} from '../js/scan/pocket.js';

const CARD = 63 / 88;

// A pocket cut width x height: the card's expected place is the middle,
// inset by a twelfth (js/scan/page.js PAGE_PAD 0.1). card: {x, y, w, h,
// border} in pixels; welds: the light outline of the pocket, or null;
// ground and borderGrey the backing's and the border's grey.
function pocket({card, ground = 30, borderGrey = 200, height = 700, welds = true, width = 501}) {
	const data = new Uint8ClampedArray(width * height * 4);
	const inset = 0.1 / 1.2;
	const weld = {x0: width * inset * 0.5, x1: width * (1 - inset * 0.5), y0: height * inset * 0.5, y1: height * (1 - inset * 0.5)};

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			// The backing's dots step both ways, as a binder sheet's texture does.
			let v = ground + ((x % 6 < 2 && y % 6 < 2) ? 25 : 0);
			const onWeld = welds && ((Math.abs(x - weld.x0) < 3 || Math.abs(x - weld.x1) < 3) && y > weld.y0 && y < weld.y1 || (Math.abs(y - weld.y0) < 3 || Math.abs(y - weld.y1) < 3) && x > weld.x0 && x < weld.x1);

			if (onWeld) {
				v = 150;
			}

			const u = (x - card.x) / card.w;
			const w = (y - card.y) / card.h;

			if (u >= 0 && u < 1 && w >= 0 && w < 1) {
				const b = card.border;

				v = u < b || u > 1 - b || w < b * CARD || w > 1 - b * CARD ? borderGrey : 60 + ((Math.floor(u * 25) * 41 + Math.floor(w * 33) * 17) % 150);
			}

			const i = (y * width + x) * 4;

			data[i] = v;
			data[i + 1] = v;
			data[i + 2] = v;
			data[i + 3] = 255;
		}
	}

	const place = [[inset, inset], [1 - inset, inset], [1 - inset, 1 - inset], [inset, 1 - inset]].map(([a, b]) => ({x: a * width, y: b * height}));

	return {image: {data, height, width}, inner: place};
}

const near = (found, card, slack) => {
	const want = [{x: card.x, y: card.y}, {x: card.x + card.w, y: card.y}, {x: card.x + card.w, y: card.y + card.h}, {x: card.x, y: card.y + card.h}];

	want.forEach((p, k) => {
		assert.ok(Math.abs(found.corners[k].x - p.x) <= slack * card.w, `corner ${k} x ${found.corners[k].x.toFixed(1)} against ${p.x}`);
		assert.ok(Math.abs(found.corners[k].y - p.y) <= slack * card.h, `corner ${k} y ${found.corners[k].y.toFixed(1)} against ${p.y}`);
	});
};

describe('a pocket card\'s own outline', () => {
	test('is the card, not the pocket\'s welds round it, when the card sits off its place', () => {
		// About 0.93 of the expected place, and 9 % of its width to the right
		// (Eric's 1000182578, middle row).
		const card = {border: 0.05, h: 542, w: Math.round(542 * CARD), x: 93, y: 79};
		const {image, inner} = pocket({card});
		const found = pocketOutline(image, inner);

		assert.ok(found, 'an outline');
		near(found, card, 0.015);
	});

	test('is found with no welds, and on a light backing round a darker border', () => {
		const card = {border: 0.05, h: 560, w: Math.round(560 * CARD), x: 60, y: 70};

		near(pocketOutline(...Object.values(pocket({card, welds: false}))), card, 0.015);
		near(pocketOutline(...Object.values(pocket({borderGrey: 70, card, ground: 220, welds: false}))), card, 0.015);
	});

	test('is null when nothing in the cut has a card\'s shape and size', () => {
		const {image, inner} = pocket({card: {border: 0.05, h: 0, w: 0, x: 0, y: 0}, welds: false});

		assert.equal(pocketOutline(image, inner), null);
	});

	test('is cut straight, card-shaped, as tall as it lies but no taller than a capture\'s card', () => {
		const image = {data: new Uint8ClampedArray(4000 * 3000 * 4), height: 3000, width: 4000};
		const small = cutCard(image, [{x: 10, y: 10}, {x: 10 + 630, y: 10}, {x: 640, y: 890}, {x: 10, y: 890}]);
		const big = cutCard(image, [{x: 0, y: 0}, {x: 2000, y: 0}, {x: 2000, y: 2800}, {x: 0, y: 2800}]);

		assert.equal(small.height, 880);
		assert.equal(small.width, Math.round(880 * CARD));
		assert.equal(big.height, POCKET_CARD_MAX_HEIGHT);
	});
});

// A scanner review, 2026-11-19: Eric's Metapod (1000182577) was cut 9.5 %
// low by its own outline, which lost the picture to a looser crop, and its
// number and text were read off the cut all the same.
describe('a pocket\'s own cut for its number', () => {
	const own = {data: new Uint8ClampedArray(63 * 88 * 4), height: 88, width: 63};
	const crop = {data: new Uint8ClampedArray(40 * 56 * 4), height: 56, width: 40};
	const seen = (firstQuad, turn = 0) => ({card: crop, firstQuad, picture: {groups: [], turn}});

	test('replaces the crop that won when it found the picture as well', () => {
		assert.equal(withPocketCard(seen({best: 20, score: 20}), own).card, own);
		assert.equal(withPocketCard(seen({best: 20, score: 20 + OWN_CUT_SLACK}), own).card, own, 'a few points off is the same card');
		assert.equal(withPocketCard(seen(null), own).card, own, 'with no score for it, as before');
		assert.equal(withPocketCard(seen({best: 20, score: 20}, 2), own).card.height, 88, 'turned as the card lay');
	});

	test('is set aside when it lost the picture, so the crop that won is read', () => {
		const lost = withPocketCard(seen({best: 20, score: 41}), own);

		assert.equal(lost.card, crop);
		assert.equal(lost.ownCut, 'lost');
	});
});
