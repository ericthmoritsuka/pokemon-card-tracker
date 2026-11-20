// A whole binder page from one still photo (js/scan/page.js): where the page
// lies in a grey copy of the photo, on synthetic copies like
// tests/scan-multi.test.mjs draws; how it is cut into pockets; which pocket
// is empty; the lines Eric reads; and a pocket's sure answer that its label
// cannot back (js/scan/session.js doubtPocket). The pixels and the tray are
// covered by tests/scan-page-browser.test.mjs.
//
// Run: node --test tests/scan-page.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {decodeSize, edgeBalance, halfRound, isEmptyPocket, locatePage, mergeCards, ownFits, PAGE_MAX_PIXELS, pageSummary, pageTrouble, POCKET_MAX_PIXELS, pocketPlan, pocketProgress, pocketQuads, TALL_TIP, tallPhoto, turnCard, turnPoint, unturnPoint, upsideDown} from '../js/scan/page.js';
import {addCapture, applyLabel, applyPicture, applyRead, defaultLanguage, doubtPocket, newSession, POCKET_ASIAN_WHY} from '../js/scan/session.js';
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

	test('a spread taken with the phone turned, two lying pages, is not taken for one page', () => {
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

	test('an upright page\'s cards stand', () => {
		assert.equal(locatePage(view(page()), W, H).lie, false);
	});
});

describe('two pages, and which way up (turnPoint, turnCard, halfRound, mergeCards, edgeBalance, upsideDown)', () => {
	test('a point turned a quarter counterclockwise comes back where it was', () => {
		// A frame 300 wide: its top right comes to the top left.
		assert.deepEqual(turnPoint({x: 300, y: 0}, 300), {x: 0, y: 0});
		assert.deepEqual(turnPoint({x: 0, y: 0}, 300), {x: 0, y: 300});

		const p = {x: 37, y: 112};

		assert.deepEqual(unturnPoint(turnPoint(p, 300), 300), p);
	});

	test('a lying card stands once its frame is turned, its width kept', () => {
		const lying = {corners: [{x: 10, y: 60}, {x: 10, y: 10}, {x: 98, y: 10}, {x: 98, y: 60}], upright: false};
		const turned = turnCard(lying, 300);
		const xs = turned.corners.map((p) => p.x);
		const ys = turned.corners.map((p) => p.y);

		assert.equal(turned.upright, true);
		assert.equal(Math.max(...xs) - Math.min(...xs), 50, 'as wide as the card was tall on its side');
		assert.equal(Math.max(...ys) - Math.min(...ys), 88);
	});

	test('a page turned half round starts at its bottom right', () => {
		const [tl, tr, br, bl] = [{x: 0, y: 0}, {x: 1, y: 0}, {x: 1, y: 1}, {x: 0, y: 1}];

		assert.deepEqual(halfRound([tl, tr, br, bl]), [br, bl, tl, tr]);
	});

	test('cards found at two sides are one list, scaled back, each card once', () => {
		const card = (x, y, k) => ({corners: [{x: x * k, y: y * k}, {x: (x + 63) * k, y: y * k}, {x: (x + 63) * k, y: (y + 88) * k}, {x: x * k, y: (y + 88) * k}], upright: true});
		const merged = mergeCards([{cards: [card(0, 0, 0.5), card(70, 0, 0.5)], scale: 0.5}, {cards: [card(2, 3, 0.75), card(0, 95, 0.75)], scale: 0.75}]);

		assert.equal(merged.length, 3, 'the card found at both sides is kept once');
		assert.deepEqual(merged[0].corners[2], {x: 63, y: 88}, 'in the source\'s pixels');
	});

	test('a card\'s artwork half is busier than its text half', () => {
		// A 64 x 88 card: a checkered art box above, plain lines of text below.
		const rgba = new Uint8ClampedArray(64 * 88 * 4).fill(255);

		for (let y = 0; y < 88; y++) {
			for (let x = 0; x < 64; x++) {
				const p = (y * 64 + x) * 4;
				const v = y < 40 ? ((x >> 1) + (y >> 1)) % 2 ? 40 : 220 : y > 50 && y % 6 === 0 && x > 10 && x < 50 ? 60 : 230;

				rgba[p] = rgba[p + 1] = rgba[p + 2] = v;
			}
		}

		const upside = new Uint8ClampedArray(rgba.length);

		for (let i = 0; i < 64 * 88; i++) {
			upside.set(rgba.subarray(i * 4, i * 4 + 4), (64 * 88 - 1 - i) * 4);
		}

		assert.ok(edgeBalance(rgba) > 0, 'standing');
		assert.ok(edgeBalance(upside) < 0, 'upside down');
	});

	test('the most cards say which way up a turned photo stands; one taken upright needs three in four', () => {
		assert.equal(upsideDown([5, 3, -1, 4, -2]), false);
		assert.equal(upsideDown([-5, -3, 1, -4, 2]), true);
		assert.equal(upsideDown([-5, -3, 1, -4, 2], {turned: false}), false, 'three in five is not enough to turn an upright photo round');
		assert.equal(upsideDown([-5, -3, -1, -4, 2, -6, -2, -3, -1], {turned: false}), true);
		assert.equal(upsideDown([], {turned: true}), false);
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

	test('two pages read together say so, and a page of a spread not found asks for it on its own', () => {
		assert.equal(pageSummary({added: 17, empty: 1, look: 9, pages: 2}), 'Both pages read: 17 cards added, 9 to check. 1 empty pocket skipped.');
		assert.equal(pageSummary({added: 9, empty: 0, look: 4, missed: 1, pages: 1}), 'One page read: 9 cards added, 4 to check. The other page could not be found, so take it on its own.');
		assert.equal(pageSummary({added: 0, empty: 18, look: 0, pages: 2}), 'Every pocket on those pages looked empty.');
	});

	// A scanner review, 2026-11-19: the reading expects a 3:4 photo of the
	// page; Eric's phone takes 20:9, where the page fills less of it.
	test('a photo taller than 3:4 ends the summary with a tip to set the camera to 3:4', () => {
		assert.equal(pageSummary({added: 9, empty: 0, look: 2, tall: true}), `Page read: 9 cards added, 2 to check. ${TALL_TIP}`);
		assert.match(TALL_TIP, /3:4/);
		assert.equal(tallPhoto({height: 12000, width: 5400}), true, '20:9 standing');
		assert.equal(tallPhoto({height: 5400, width: 12000}), true, 'and lying');
		assert.equal(tallPhoto({height: 1920, width: 1080}), true, '9:16');
		assert.equal(tallPhoto({height: 4000, width: 3000}), false, '3:4');
		assert.equal(tallPhoto({height: 3000, width: 4000}), false, '4:3');
		assert.equal(tallPhoto(null), false);
	});

	test('a page not read says why and asks for the photo again', () => {
		assert.match(pageTrouble('none'), /^The page could not be found in that photo\. Take it again/);
		assert.match(pageTrouble('spread'), /two pages, but their pockets could not be found\. Take it again/);
		assert.match(pageTrouble('unreadable'), /could not be opened/);

		for (const status of ['none', 'spread', 'unreadable']) {
			assert.ok(!/\u2014/.test(pageTrouble(status)), 'no em dash');
		}
	});
});

describe('a pocket\'s sure answer its label cannot back (doubtPocket)', () => {
	const japanese = {catalog: 'ja', id: 'SV2a-018', lang: 'ja', localId: '018', name: 'ピジョット', official: '165', setId: 'SV2a'};
	const english = {catalog: 'international', id: 'sv03.5-018', lang: 'en', localId: '018', name: 'Pidgeot', official: '165', setId: 'sv03.5'};

	function pocket(card, {page = 9, read = null} = {}) {
		const session = newSession();
		const item = addCapture(session);

		item.page = page;
		item.read = read;
		applyPicture(session, item.id, {candidates: [card], card, sure: true});

		return {item, session};
	}

	test('a Japanese print made sure by its number alone, its label reading no Latin text, asks for a look', () => {
		const {item, session} = pocket(japanese, {read: {language: {code: 'non-latin', confidence: 0.5}, number: {number: '18', total: '165'}}});

		assert.equal(doubtPocket(session, item.id), true);
		assert.equal(item.sure, false);
		assert.equal(item.why, POCKET_ASIAN_WHY);
	});

	test('a Japanese print whose Japanese text was read stays sure', () => {
		const {item, session} = pocket(japanese, {read: {language: {code: 'non-latin'}, name: {script: 'ja', text: 'ピジョット'}, script: 'ja'}});

		assert.equal(doubtPocket(session, item.id), false);
		assert.equal(item.sure, true);
	});

	test('a Western print, or a card not from a page, is left alone', () => {
		const western = pocket(english, {read: {language: {code: 'non-latin'}}});

		assert.equal(doubtPocket(western.session, western.item.id), false);
		assert.equal(western.item.sure, true);

		const single = pocket(japanese, {page: undefined});

		delete single.item.page;
		assert.equal(doubtPocket(single.session, single.item.id), false);
		assert.equal(single.item.sure, true, 'a single scan keeps its own rules');
	});
});

// A pocket's label row reads no Latin text whatever the card (Eric's page
// photos, 2026-11-19: all of a Portuguese page, and a Portuguese Charizard ex
// left with no language), so on a page that reading is no evidence.
describe('a pocket\'s label row that reads no Latin text', () => {
	const japanese = {catalog: 'ja', id: 'SV3-109', lang: 'ja', localId: '109', name: 'リザードンex', official: '108', setId: 'SV3'};
	const english = {catalog: 'international', id: 'sv03-125', lang: 'en', localId: '125', name: 'Charizard ex', official: '197', setId: 'sv03'};

	function capture({page = 6} = {}) {
		const session = newSession();
		const item = addCapture(session);

		if (page) {
			item.page = page;
		}

		return {item, session};
	}

	test('gives a pocket no "non-latin" hint, so it never orders the Japanese print first; a single scan keeps it', () => {
		const pocket = capture();

		applyRead(pocket.session, pocket.item.id, {language: {code: 'non-latin', confidence: 0.5}});
		assert.equal(pocket.item.languageHint, null);
		assert.equal(pocket.item.language, null);

		const single = capture({page: null});

		applyRead(single.session, single.item.id, {language: {code: 'non-latin', confidence: 0.5}});
		assert.equal(single.item.languageHint, 'non-latin');
	});

	test('leaves a language a pocket read clearly as it was', () => {
		const pocket = capture();

		applyRead(pocket.session, pocket.item.id, {language: {code: 'en', confidence: 1}});
		assert.equal(pocket.item.language, 'en');
		assert.equal(pocket.item.languageBy, 'read');
	});

	test('the label check keeps a pocket\'s Western pick, and gives one to a pocket with none', () => {
		const kept = capture();

		applyPicture(kept.session, kept.item.id, {candidates: [english, japanese], card: english, groupLangs: ['en', 'ja'], sure: true});
		assert.equal(defaultLanguage(kept.session, kept.item.id, 'pt'), true);
		applyLabel(kept.session, kept.item.id, {code: 'non-latin', confidence: 0.5}, undefined, {asian: 'ko', western: 'pt'});
		assert.equal(kept.item.language, 'pt');
		assert.equal(kept.item.languageBy, 'default');
		assert.ok(kept.item.labelIgnored, 'says why the label was not taken');

		const none = capture();

		applyPicture(none.session, none.item.id, {candidates: [english, japanese], card: english, groupLangs: ['en', 'ja'], sure: true});
		assert.equal(applyLabel(none.session, none.item.id, {code: 'non-latin', confidence: 0.5}, undefined, {asian: 'ko', western: 'pt'}), true);
		assert.equal(none.item.language, 'pt', 'never left with no language');
	});

	test('a single scan still takes a label with no Latin text as a sign of an Asian print', () => {
		const single = capture({page: null});

		applyPicture(single.session, single.item.id, {candidates: [english, japanese], card: english, groupLangs: ['en', 'ja'], sure: true});
		defaultLanguage(single.session, single.item.id, 'pt');
		applyLabel(single.session, single.item.id, {code: 'non-latin', confidence: 0.5}, undefined, {asian: 'ko', western: 'pt'});
		assert.notEqual(single.item.language, 'pt');
		assert.equal(single.item.languageHint, 'non-latin');
	});
});

// The photo decoded by its pixels, not its longer side (a scanner review,
// 2026-11-19): a 20:9 still and a 3:4 one cost the same.
describe('how large a page photo is decoded (decodeSize)', () => {
	test('a photo is decoded at most so many pixels, whatever its shape', () => {
		const tall = decodeSize(5400, 12000, {maxPixels: POCKET_MAX_PIXELS});
		const square = decodeSize(6120, 8160, {maxPixels: POCKET_MAX_PIXELS});

		assert.deepEqual([tall.width, tall.height], [3456, 7680], 'Eric\'s 12000 x 5400 photo, as before');
		assert.ok(Math.abs(square.width * square.height - POCKET_MAX_PIXELS) / POCKET_MAX_PIXELS < 0.001, `a 50 MP 3:4 photo at 26.5 MP, not 44 (${square.width} x ${square.height})`);
		assert.ok(Math.abs(square.width / square.height - 6120 / 8160) < 0.001, 'its shape kept');

		const page = decodeSize(5400, 12000, {maxPixels: PAGE_MAX_PIXELS});

		assert.deepEqual([page.width, page.height], [1728, 3840], 'the page\'s copy of Eric\'s photo as before');
	});

	test('a small photo is never enlarged, and a longer side caps it too', () => {
		assert.deepEqual(decodeSize(1000, 1500, {maxPixels: PAGE_MAX_PIXELS}), {height: 1500, scale: 1, width: 1000});
		assert.deepEqual(decodeSize(5400, 12000, {maxPixels: PAGE_MAX_PIXELS, maxSide: 1200}), {height: 1200, scale: 0.1, width: 540});
	});
});
