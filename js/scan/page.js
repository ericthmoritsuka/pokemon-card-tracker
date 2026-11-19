// A whole binder page from one still photo (Eric, 2026-11-18): the page
// path lab/multi measured, for one upright page of 3 x 3 pockets. The cards
// are found first (js/scan/steady.js findCards), the page sized by them
// (findPages cardArea), its outline fitted to them (js/scan/multi.js
// fitPage), and the page cut into its pockets, each with its own card's
// outline where one is found (findCard) and an empty pocket told by no
// outline and no colour. Each pocket then joins the tray and is read as a
// single capture is (js/scan/view.js readPage), its number from its card
// cut to its own edges out of a larger copy of the photo (js/scan/pocket.js,
// ownCard).
//
// Two pages side by side (a spread, as Eric takes his binder: the phone
// turned, the photo standing, the pages one above the other) are read too
// (Eric, 2026-11-19): the photo is turned so the cards stand, split at the
// binder's spine (js/scan/multi.js spineAt), and each page fitted from its
// cards alone (fitGrid), its pockets numbered after the left page's. Which
// way up the cards stand is told by their faces (upsideDown): the artwork's
// half of a card is busier than its text's.
//
// No DOM at import, so js/scan/page-worker.js runs it off the main thread;
// readPagePixels draws on an OffscreenCanvas, or a canvas element where
// there is none. The helpers above it are pure, for Node's tests.

import {cardsLie, darkBand, fitGrid, fitPage, pageCells, pageShape, quadPoint, SPINE_BAND, spineAt, splitSpread, twoPages} from './multi.js';
import {cutCard, pocketOutline} from './pocket.js';
import {warpQuad} from './rectify.js';
import {colourfulness, COLOURLESS, FIND_SIDE_CAPTURE, findCard, findCards, findPages, toGrey} from './steady.js';

export const PAGE_ROWS = 3;
export const PAGE_COLS = 3;
// How much larger than its card each pocket is cut, so the card's own
// edges lie inside the cut (lab/multi --pad 0.1).
export const PAGE_PAD = 0.1;
// The longer side of the grey copy the outlines are found on (the
// scanner's FIND_SIDE_CAPTURE, as lab/multi ran).
export const PAGE_SIDE = FIND_SIDE_CAPTURE;
// The longer side the photo is read at. A 12 MP still of a page filling it
// gives cards about 900 pixels wide; at 3840 they are about 550, enough for
// the picture and the number strip, and a phone has the memory for it
// (about 27 MB of pixels).
export const PAGE_MAX_SIDE = 3840;
// The longer side the photo is decoded at a second time, for each
// pocket's own card (ownCard), which its number is read from (2026-11-19).
// At PAGE_MAX_SIDE a card is about 560 pixels tall and its number about 7:
// on Eric's three upright page photos (12000 x 5400) no number read even
// from a card cut to its edges, against 9 of 27 when cut from this copy,
// the same as from the whole photo (cards about 1400 tall) and 6 at 5760.
// The copy is held as a bitmap (about 106 MB for his photos), only each
// card's box drawn out of it; a phone that cannot decode it that large
// cuts the cards from the page's own copy.
export const POCKET_MAX_SIDE = 7680;
// The tallest a pocket is cut, in pixels (lab/multi).
const POCKET_MAX_HEIGHT = 1400;
const CARD = 63 / 88;

// A 3 x 3 page's pocket card covers about a tenth of the page's outline
// (js/scan/multi.js pageCells: a card's width over the page's, times its
// height over the page's). A card found within 0.6 to 1.4 times that is a
// pocket's (on Eric's page photos, 0.07 to 0.13); one filling more than
// ONE_CARD_SHARE of the outline is not.
const POCKET_SHARE = 0.105;
const ONE_CARD_SHARE = 0.3;

const area = (q) => Math.abs(q.reduce((sum, p, i) => sum + p.x * q[(i + 1) % 4].y - q[(i + 1) % 4].x * p.y, 0)) / 2;

// Whether point p lies inside the convex quad q.
function inside(q, p) {
	const sides = q.map((a, i) => {
		const b = q[(i + 1) % 4];

		return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
	});

	return sides.every((side) => side >= 0) || sides.every((side) => side <= 0);
}

const middleOf = (q) => ({x: q.reduce((sum, p) => sum + p.x, 0) / 4, y: q.reduce((sum, p) => sum + p.y, 0) / 4});

// Where the page lies in a grey copy of the photo (width x height): the
// cards found in it, a card's area from them (their median, once three are
// found), the page of about nine cards' size, and its outline fitted to the
// cards. Returns {status, corners, fitted, cards}:
//
// - 'none': no page outline was found, or the outline is one card's
//   (corners null);
// - 'spread': two pages were found, or the outline holds two pages lying
//   across it (a spread taken with the phone turned), which this does not
//   read;
// - 'page': corners the page's (top left first, clockwise, as it stands),
//   fitted how many cards set it right (0 when the fit failed and the
//   outline is as found: the sheet's edge or the binder's, often a little
//   off).
//
// lie: most of the cards found lie on their side (js/scan/multi.js
// cardsLie), so the photo was taken with the phone turned, and whatever
// the outline says, it is not one upright page.
export function locatePage(grey, width, height, {cols = PAGE_COLS, rows = PAGE_ROWS} = {}) {
	const cards = findCards(grey, width, height);
	const areas = cards.map((card) => area(card.corners)).sort((a, b) => a - b);
	const cardArea = areas.length >= 3 ? areas[Math.floor(areas.length / 2)] : null;
	const pages = findPages(grey, width, height, {cardArea, max: 2, pockets: rows * cols, shape: pageShape(rows, cols)});
	const [page] = pages;
	const lie = cardsLie(cards);

	if (!page) {
		return {cards: cards.length, corners: null, fitted: 0, lie, status: 'none'};
	}

	// Two pages found apart, or one standing outline whose cards lie across
	// it (the whole spread's outline, which for 3 x 3 pages has a page's
	// shape too). A lone page taken sideways lies with its cards, and is
	// read.
	if (pages.length > 1 || (page.upright !== false && splitSpread(page.corners, cards))) {
		return {cards: cards.length, corners: page.corners, fitted: 0, lie, status: 'spread'};
	}

	const fitted = fitPage(page.corners, cards, rows, cols);

	// An outline no cards set right stands only with a pocket's card found
	// in it and no card filling a good part of it: otherwise it is one card
	// (a single card photographed, which has nearly a 3 x 3 page's shape, or
	// its halves split at its art box), not a page of nine.
	if (!fitted) {
		const whole = area(page.corners);
		const within = cards.filter((card) => inside(page.corners, middleOf(card.corners))).map((card) => area(card.corners) / whole);

		if (within.some((share) => share > ONE_CARD_SHARE) || !within.some((share) => share >= POCKET_SHARE * 0.6 && share <= POCKET_SHARE * 1.4)) {
			return {cards: cards.length, corners: null, fitted: 0, lie, status: 'none'};
		}
	}

	return {cards: cards.length, corners: fitted ? fitted.corners : page.corners, fitted: fitted ? fitted.cards : 0, lie, status: 'page'};
}

// The pockets of a page whose corners were found on a copy `scale` times
// the photo's size, row by row: each {index, row, col, cut, width, height,
// inner}, cut the quad of the photo to cut straight (the card's place grown
// by `pad`), width x height the cut's size (as tall as the cut lies, at
// most POCKET_MAX_HEIGHT, card-shaped), and inner the card's expected place
// in the cut's pixels.
export function pocketPlan(corners, scale, {cols = PAGE_COLS, pad = PAGE_PAD, rows = PAGE_ROWS} = {}) {
	const full = corners.map((p) => ({x: p.x / scale, y: p.y / scale}));
	const inset = pad / (1 + 2 * pad);

	return pageCells(full, rows, cols, {pad}).map((cell) => {
		const tall = Math.hypot(cell.cut[3].x - cell.cut[0].x, cell.cut[3].y - cell.cut[0].y);
		const height = Math.max(1, Math.min(POCKET_MAX_HEIGHT, Math.round(tall)));
		const width = Math.max(1, Math.round(height * CARD));
		const inner = [[inset, inset], [1 - inset, inset], [1 - inset, 1 - inset], [inset, 1 - inset]].map(([u, v]) => ({x: u * width, y: v * height}));

		return {col: cell.col, cut: cell.cut, height, index: cell.row * cols + cell.col, inner, row: cell.row, width};
	});
}

// Whether a card's own outline found in a pocket's cut (findCard on a small
// copy, scaled back) is the pocket's card: standing, and 55 to 115 % of the
// card's expected place.
export function ownFits(found, inner) {
	if (!found || !found.corners || found.upright === false) {
		return false;
	}

	const share = area(found.corners) / area(inner);

	return share >= 0.55 && share <= 1.15;
}

// An empty pocket: no card outline in it and no colour in its middle
// (steady.js colourfulness, as the scanner tells a card from a blank
// sheet). The picture match alone cannot tell: its wide search brings a
// dark backing within reach of some card (lab/multi).
export const isEmptyPocket = ({colour, own}) => !own && colour < COLOURLESS;

// The outlines a pocket's card is cut by, the best first, as
// js/scan/identify.js takes them (quads): its own outline when found, then
// its expected place. own: {corners, ratio} or null.
export function pocketQuads(own, inner) {
	const place = {corners: inner, ratio: CARD, upright: true};

	return own ? [{corners: own.corners, ratio: own.ratio ?? CARD, upright: true}, place] : [place];
}

// ------------------------------------------------------------ two pages, and which way up

// The sides a page's grey copy is searched at for its cards, in turn, until
// most of its pockets are fitted (fitGrid): one side finds some cards and
// another others, as the lines run (on Eric's spreads, 360 alone fitted 3
// to 8 of a page's 9; with 420 and 480, 4 to 9).
export const GRID_SIDES = [360, 420, 480, 300];
// How many cards fitted are enough to stop looking at further sides.
const GRID_ENOUGH = 8;
// How far past the spine each page's half is cut, as a share of the
// spread's width, so the cards beside the spine lie clear of the cut's edge
// (findCards leaves out a box touching the frame's edge).
export const SPINE_PAD = 0.015;
// The longer side of the copy a spread is turned and split on.
const WORK_SIDE = 1280;
// The longer side of the copy the cards of a whole spread are found on.
const SPREAD_FIND_SIDE = 720;

// Cards found at several sides as one list: each card scaled back by its
// copy's `scale`, a card already found at another side (its middle within
// a third of its height) left out.
export function mergeCards(found) {
	const kept = [];

	for (const {cards, scale} of found) {
		for (const card of cards) {
			const corners = card.corners.map((p) => ({x: p.x / scale, y: p.y / scale}));
			const at = middleOf(corners);
			const tall = Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y);

			if (!kept.some((other) => {
				const there = middleOf(other.corners);

				return Math.hypot(at.x - there.x, at.y - there.y) < tall / 3;
			})) {
				kept.push({...card, corners});
			}
		}
	}

	return kept;
}

// A point of a frame width wide, turned a quarter counterclockwise (the
// frame's top right comes to its top left), and back.
export const turnPoint = (p, width) => ({x: p.y, y: width - p.x});
export const unturnPoint = (p, width) => ({x: width - p.y, y: p.x});

// A card found on a frame `width` wide, as it lies once the frame is turned
// (turnPoint): its middle and width kept, standing where it lay.
export const turnCard = (card, width) => ({...card, corners: card.corners.map((p) => turnPoint(p, width)), upright: card.upright === false});

// A page's corners for the page turned half round (its bottom right its
// top left).
export const halfRound = ([tl, tr, br, bl]) => [br, bl, tl, tr];

// Whether the cards stand upside down, from each card's balance: how much
// busier the upper half of its middle is than the lower (edgeBalance), the
// artwork's against the attacks' text. On Eric's photos 84 % of cards have
// the artwork busier, and every page and spread said which way it stood
// by 13 or more of 18. A photo turned here (turned) has no way up of its
// own, so the most cards decide; one that stood as taken is turned round
// only when three in four of its cards and three at least say so.
export function upsideDown(balances, {turned = true} = {}) {
	const down = balances.filter((b) => b < 0).length;
	const up = balances.filter((b) => b > 0).length;

	return turned ? down > up : down >= 3 && down >= (up + down) * 0.75;
}

// ------------------------------------------------------------ what Eric reads

// The progress line while pocket `n` (1 to `of`) is read.
export const pocketProgress = (n, of) => `Reading pocket ${n} of ${of}.`;

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The line once a page is read: how many cards joined the tray, how many
// of those need a look, and how many pockets were empty. rough: the page's
// outline was not set right by its cards, so the pockets may be off.
// pages: how many pages were read (2 for a spread), and missed how many of
// a spread's could not be found.
export function pageSummary({added, empty, look, missed = 0, pages = 1, rough = false}) {
	const which = pages > 1 ? 'Both pages' : missed ? 'One page' : 'Page';

	if (!added) {
		return empty ? `Every pocket on ${pages > 1 ? 'those pages' : 'that page'} looked empty.` : `No cards were found on ${pages > 1 ? 'those pages' : 'that page'}.`;
	}

	const parts = [`${which} read: ${count(added, 'card', 'cards')} added`];

	if (look) {
		parts.push(`${look} to check`);
	}

	let text = `${parts.join(', ')}.`;

	if (empty) {
		text += ` ${count(empty, 'empty pocket', 'empty pockets')} skipped.`;
	}

	if (missed) {
		text += ' The other page could not be found, so take it on its own.';
	}

	if (rough) {
		text += ' The page edges were unclear, so check each card.';
	}

	return text;
}

// Why a page was not read, as plain advice to take it again.
export function pageTrouble(status) {
	if (status === 'spread') {
		return 'That looks like two pages, but their pockets could not be found. Take it again with the binder filling the photo, or one page at a time.';
	}

	if (status === 'unreadable') {
		return 'That photo could not be opened. Try another one.';
	}

	return 'The page could not be found in that photo. Take it again with the page filling the photo.';
}

// ------------------------------------------------------------ the pixels

const pause = () => new Promise((resolve) => setTimeout(resolve, 0));

function canvasOf(width, height) {
	if (typeof OffscreenCanvas !== 'undefined') {
		return new OffscreenCanvas(width, height);
	}

	const canvas = document.createElement('canvas');

	canvas.width = width;
	canvas.height = height;

	return canvas;
}

// `source` (an ImageData's canvas, or a bitmap) drawn at width x height.
function shrink(source, width, height, quality = null) {
	const canvas = canvasOf(width, height);
	const ctx = canvas.getContext('2d', {willReadFrequently: true});

	if (quality) {
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = quality;
	}

	ctx.drawImage(source, 0, 0, width, height);

	return ctx.getImageData(0, 0, width, height);
}

function canvasHolding(image) {
	const canvas = canvasOf(image.width, image.height);

	canvas.getContext('2d').putImageData(image, 0, 0);

	return canvas;
}

// The card's own outline in a pocket's cut (findCard on a copy at most 200
// pixels tall), {corners, ratio} in the cut's pixels, when it fits
// (ownFits); else null.
function ownOutline(image, inner) {
	const scale = Math.min(1, 200 / image.height);
	const w = Math.max(1, Math.round(image.width * scale));
	const h = Math.max(1, Math.round(image.height * scale));
	const small = shrink(canvasHolding(image), w, h, 'medium');
	const found = findCard(toGrey(small.data, w, h), w, h);

	if (!found.quad) {
		return null;
	}

	const corners = found.quad.map((p) => ({x: p.x / scale, y: p.y / scale}));

	return ownFits({corners, upright: found.upright}, inner) ? {corners, ratio: found.ratio} : null;
}

// How much colour the middle of a pocket's cut has (colourfulness on a
// 64 x 88 copy).
function colourOf(image) {
	const small = shrink(canvasHolding(image), 64, 88);

	return colourfulness(small.data, 64, 88);
}

// A pocket's card cut to its own outline (js/scan/pocket.js), as
// ImageData: `corners` in the photo's pixels, cut from `source`, the photo
// itself (ImageData) or a larger copy of it `scale` times its size (a
// bitmap), of which only the card's box is drawn, so no larger copy's
// pixels are ever held whole.
function ownCard(source, corners, scale) {
	if (!source.data) {
		const big = corners.map((p) => ({x: p.x * scale, y: p.y * scale}));
		const x = Math.max(0, Math.floor(Math.min(...big.map((p) => p.x))) - 2);
		const y = Math.max(0, Math.floor(Math.min(...big.map((p) => p.y))) - 2);
		const w = Math.max(1, Math.min(source.width, Math.ceil(Math.max(...big.map((p) => p.x))) + 2) - x);
		const h = Math.max(1, Math.min(source.height, Math.ceil(Math.max(...big.map((p) => p.y))) + 2) - y);
		const canvas = canvasOf(w, h);
		const ctx = canvas.getContext('2d', {willReadFrequently: true});

		ctx.drawImage(source, x, y, w, h, 0, 0, w, h);

		const cut = cutCard(ctx.getImageData(0, 0, w, h), big.map((p) => ({x: p.x - x, y: p.y - y})));

		return new ImageData(cut.data, cut.width, cut.height);
	}

	const cut = cutCard(source, corners);

	return new ImageData(cut.data, cut.width, cut.height);
}

// A photo's pixels at most `maxSide` on its longer side, from a bitmap (or
// anything a canvas draws), as ImageData.
export function photoPixels(bitmap, maxSide = PAGE_MAX_SIDE) {
	const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
	const width = Math.max(1, Math.round(bitmap.width * scale));
	const height = Math.max(1, Math.round(bitmap.height * scale));

	return shrink(bitmap, width, height, 'high');
}

// `source` (a canvas) from (sx, sy), sw x sh of it, drawn at width x height.
function shrinkPart(source, sx, sy, sw, sh, width, height) {
	const canvas = canvasOf(width, height);
	const ctx = canvas.getContext('2d', {willReadFrequently: true});

	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = 'medium';
	ctx.drawImage(source, sx, sy, sw, sh, 0, 0, width, height);

	return ctx.getImageData(0, 0, width, height);
}

// An ImageData turned a quarter counterclockwise (turnPoint).
function turnImage(image) {
	const {height, width} = image;
	const from = new Uint32Array(image.data.buffer, image.data.byteOffset, width * height);
	const out = new ImageData(height, width);
	const to = new Uint32Array(out.data.buffer);

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			to[(width - 1 - x) * height + y] = from[y * width + x];
		}
	}

	return out;
}

// How much busier the upper half of a card's middle is than its lower half
// (the mean step between neighbouring pixels, rows 15 to 45 % against 55 to
// 85 %, the outer eighth of each side left out), on a 64 x 88 copy:
// positive for a card standing up, its artwork above its text.
export function edgeBalance(rgba, width = 64, height = 88) {
	const busy = (from, to) => {
		let sum = 0;
		let n = 0;

		for (let y = Math.round(height * from); y < Math.round(height * to); y++) {
			for (let x = Math.round(width * 0.12); x < Math.round(width * 0.88); x++) {
				const p = (y * width + x) * 4;

				sum += Math.abs(rgba[p + 4] - rgba[p]) + Math.abs(rgba[p + width * 4] - rgba[p]);
				n++;
			}
		}

		return sum / Math.max(1, n);
	};

	return busy(0.15, 0.45) - busy(0.55, 0.85);
}

// The page in the stretch x0..x1 of `source` (a canvas width x height
// pixels): its cards found at each of GRID_SIDES in turn (findCards on a
// grey copy that long), merged (mergeCards), and the page fitted from
// them (fitGrid), until GRID_ENOUGH are fitted. Returns {corners, cards}
// in the source's pixels, or null.
function gridIn(source, x0, x1, height, {cols, rows}) {
	const width = x1 - x0;
	const found = [];
	let grid = null;

	for (const side of GRID_SIDES) {
		const scale = Math.min(1, side / Math.max(width, height));
		const w = Math.max(1, Math.round(width * scale));
		const h = Math.max(1, Math.round(height * scale));
		const small = shrinkPart(source, x0, 0, width, height, w, h);

		found.push({cards: findCards(toGrey(small.data, w, h), w, h), scale: w / width});

		const fitted = fitGrid(mergeCards(found), rows, cols, {height, width});

		if (fitted && (!grid || fitted.cards > grid.cards)) {
			grid = fitted;
		}

		if (grid && grid.cards >= GRID_ENOUGH) {
			break;
		}
	}

	return grid && {cards: grid.cards, corners: grid.corners.map((p) => ({x: p.x + x0, y: p.y}))};
}

// A copy of the photo at most WORK_SIDE on its longer side, and the cards
// found on a grey copy of it SPREAD_FIND_SIDE long (findCards, up to 24:
// a spread's 18 and some false boxes). Returns {work, cards, grey, w, h,
// k}: k the grey copy's scale against the work copy.
function lookWhole(image) {
	const scale = Math.min(1, WORK_SIDE / Math.max(image.width, image.height));
	const work = shrink(canvasHolding(image), Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)), 'medium');
	const k = Math.min(1, SPREAD_FIND_SIDE / Math.max(work.width, work.height));
	const w = Math.max(1, Math.round(work.width * k));
	const h = Math.max(1, Math.round(work.height * k));
	const grey = toGrey(shrink(canvasHolding(work), w, h, 'medium').data, w, h);

	return {cards: findCards(grey, w, h, {max: 24}), grey, h, k: w / work.width, w, work};
}

// The pages in a photo that is not one upright page as taken (lookWhole's
// copy and cards): the copy turned a quarter when the cards lie (turned);
// two pages when they spread wider than one page's (twoPages), split at the
// spine (spineAt) a little past it each way; each page fitted from its
// cards (gridIn); a band across the middle (band), turned, is taken for
// the spine whatever the cards say. Returns {pages, spread, turned}: pages each {corners,
// fitted}, corners in the photo's pixels as the page stands (which way up
// not yet told), left page first.
function framePages(image, {cards, grey, h, k, w, work}, {band = false, cols, rows, turned}) {
	const frame = turned ? turnImage(work) : work;
	const seen = turned ? cards.map((card) => turnCard(card, w)) : cards;
	const spread = (turned && band) || twoPages(seen);
	const canvas = canvasHolding(frame);
	let halves = [[0, frame.width]];

	if (spread) {
		const [gw, gh] = turned ? [h, w] : [w, h];
		const g = turned ? toGrey(shrink(canvas, gw, gh, 'medium').data, gw, gh) : grey;
		const spine = spineAt(g, gw, gh, seen) / k;
		const pad = frame.width * SPINE_PAD;

		halves = [[0, Math.min(frame.width, Math.round(spine + pad))], [Math.max(0, Math.round(spine - pad)), frame.width]];
	}

	const kx = work.width / image.width;
	const ky = work.height / image.height;
	const pages = [];

	for (const [x0, x1] of halves) {
		const grid = gridIn(canvas, x0, x1, frame.height, {cols, rows});

		if (grid) {
			const back = turned ? grid.corners.map((p) => unturnPoint(p, work.width)) : grid.corners;

			pages.push({corners: back.map((p) => ({x: p.x / kx, y: p.y / ky})), fitted: grid.cards});
		}
	}

	return {pages, spread, turned};
}

// Each pocket's balance (edgeBalance) over the pages found, on a 64 x 88
// copy of its cut (cut at 128 x 176 and halved, so the steps are the
// card's, not the sampling's).
function balancesOf(image, pages, {cols, rows}) {
	const out = [];

	for (const {corners} of pages) {
		for (const plan of pocketPlan(corners, 1, {cols, rows})) {
			const raw = warpQuad(image, plan.cut, 128, 176);
			const half = new Uint8ClampedArray(64 * 88 * 4);

			for (let y = 0; y < 88; y++) {
				for (let x = 0; x < 64; x++) {
					for (let c = 0; c < 3; c++) {
						const p = (y * 2 * 128 + x * 2) * 4 + c;

						half[(y * 64 + x) * 4 + c] = (raw.data[p] + raw.data[p + 4] + raw.data[p + 512] + raw.data[p + 516]) / 4;
					}
				}
			}

			out.push(edgeBalance(half, 64, 88));
		}
	}

	return out;
}

// The page in a photo's pixels (ImageData), cut into its pockets. Returns
// {status, fitted, cards, findMs, ms, size, pages, missed, turned,
// flipped, pockets}: status as locatePage's ('page' whenever a page was
// read, one or both of a spread's); pages how many were read and missed
// how many of a spread's were not found; pockets, row by row, the left
// page's first, each {index, row, col, empty} and, for a pocket that is
// not empty, image (its cut, card-shaped ImageData), quads (in the cut's
// pixels: the card's own outline found by js/scan/pocket.js first, when
// found, then pocketQuads), and card, that outline cut straight out of
// `fine` (a larger copy of the photo, a bitmap) or the photo itself, for
// the number (ownCard). Pauses between pockets, so on the main thread the
// page keeps answering.
//
// One upright page whose outline the cards set right, its cards standing,
// is read as before. Anything else (an outline they did not set right,
// cards lying, two pages, no page found) is looked at whole (framePages):
// an upright page there is fitted from its cards alone, and a spread taken
// for one page (1000182575, read as nine wrong cards before) is told by its
// cards, found on a larger copy, lying or spreading over two pages. Which
// way up the cards stand is then told by their faces (upsideDown).
export async function readPagePixels(image, {cols = PAGE_COLS, fine = null, rows = PAGE_ROWS, side = PAGE_SIDE} = {}) {
	const started = performance.now();
	const scale = Math.min(1, side / Math.max(image.width, image.height));
	const w = Math.max(1, Math.round(image.width * scale));
	const h = Math.max(1, Math.round(image.height * scale));
	const small = shrink(canvasHolding(image), w, h, 'medium');
	const where = locatePage(toGrey(small.data, w, h), w, h, {cols, rows});
	// The copy's scale against the photo, from the sizes as drawn.
	const copyScale = w / image.width;
	// The cards on a larger copy say whether the phone was turned: on the
	// 360 copy two lying cards one above the other make a standing box
	// often enough that a spread's outline was fitted to them as one page
	// (1000182575), while on a 720 copy Eric's spreads showed 9 to 14 of 9
	// to 14 boxes lying and his single pages two at most of 7 to 9.
	// A dark band across the photo's middle (darkBand) is the spine of a
	// spread taken turned, where the cards found may not say so: a clean
	// print's art box splits a lying card into two standing boxes (the
	// synthetic spread in tests/scan-page-browser.test.mjs found 3 of 7
	// lying). Turned on the band alone and finding no page, the photo is
	// looked at as taken: an empty middle row of pockets makes a band too.
	const whole = lookWhole(image);
	const lie = where.lie || cardsLie(whole.cards, {share: 0.5});
	const band = darkBand(whole.grey, whole.w, whole.h) < SPINE_BAND;
	let pages = [];
	let found = {spread: false, turned: false};
	let flipped = false;

	if (where.status === 'page' && where.fitted && !lie && !band) {
		pages = [{corners: where.corners.map((p) => ({x: p.x / copyScale, y: p.y / copyScale})), fitted: where.fitted}];
	}
	else {
		found = framePages(image, whole, {band, cols, rows, turned: lie || band});

		if (!found.pages.length && band && !lie) {
			found = framePages(image, whole, {cols, rows, turned: false});
		}

		pages = found.pages;

		if (pages.length && upsideDown(balancesOf(image, pages, {cols, rows}), {turned: found.turned})) {
			flipped = true;
			pages = pages.map((page) => ({...page, corners: halfRound(page.corners)})).reverse();
		}
	}

	const findMs = Math.round(performance.now() - started);
	const status = pages.length ? 'page' : found.spread || where.status === 'spread' ? 'spread' : 'none';
	const out = {cards: where.cards, findMs, fitted: pages.length ? Math.min(...pages.map((page) => page.fitted)) : 0, flipped, missed: found.spread ? 2 - pages.length : 0, ms: 0, pages: pages.length, pockets: [], size: `${image.width} x ${image.height}`, status, turned: found.turned};

	if (status !== 'page') {
		out.ms = Math.round(performance.now() - started);

		return out;
	}

	for (const [p, page] of pages.entries()) {
		for (const plan of pocketPlan(page.corners, 1, {cols, rows})) {
			await pause();

			const raw = warpQuad(image, plan.cut, plan.width, plan.height);
			const cut = new ImageData(raw.data, plan.width, plan.height);
			const own = ownOutline(cut, plan.inner);
			const empty = isEmptyPocket({colour: colourOf(cut), own});
			const pocket = {col: plan.col, empty, index: p * rows * cols + plan.index, row: plan.row};

			if (!empty) {
				pocket.image = cut;
				pocket.quads = pocketQuads(own, plan.inner);

				// The card's own four edges (2026-11-19): offered to the
				// picture first, and cut from the larger copy for the number,
				// which the outlines above, found on small copies, put on the
				// sleeve.
				const tight = pocketOutline(cut, plan.inner);

				if (tight) {
					pocket.quads = [{corners: tight.corners, ratio: tight.ratio, upright: true}, ...pocket.quads];
					pocket.card = ownCard(fine || image, tight.corners.map((q) => quadPoint(plan.cut, q.x / plan.width, q.y / plan.height)), fine ? fine.width / image.width : 1);
				}
			}

			out.pockets.push(pocket);
		}
	}

	out.ms = Math.round(performance.now() - started);

	return out;
}

// ------------------------------------------------------------ off the main thread

// The photo file decoded at most `maxSide` on its longer side, as a bitmap
// turned as the camera held it (its EXIF orientation). The size is read
// first, so a large still (Eric's phone takes 12000 x 5400) is decoded
// small rather than whole.
async function photoBitmap(file, maxSide) {
	const size = typeof Image === 'undefined' ? null : await new Promise((resolve) => {
		const url = URL.createObjectURL(file);
		const img = new Image();

		img.onload = () => {
			URL.revokeObjectURL(url);
			resolve(img.naturalWidth && img.naturalHeight ? {height: img.naturalHeight, width: img.naturalWidth} : null);
		};
		img.onerror = () => {
			URL.revokeObjectURL(url);
			resolve(null);
		};
		img.src = url;
	});
	const scale = size ? Math.min(1, maxSide / Math.max(size.width, size.height)) : 1;

	if (scale < 1) {
		try {
			return await createImageBitmap(file, {resizeHeight: Math.round(size.height * scale), resizeQuality: 'high', resizeWidth: Math.round(size.width * scale)});
		}
		catch {
			// Decoded whole below.
		}
	}

	return createImageBitmap(file);
}

// The photo decoded at `side` for its pockets' own cards (ownCard), or
// null when that is no larger than `than` (the page's own copy, whose
// pixels stay as they were decoded before, so the page and its pictures
// are found as they were) or a phone cannot hold it that large.
async function fineBitmap(file, side, than) {
	try {
		const fine = await photoBitmap(file, side);

		if (fine.width > than.width) {
			return fine;
		}

		fine.close();
	}
	catch {
		// The pockets' cards are cut from the page's copy.
	}

	return null;
}

// How long the page worker may take before the page is read here instead.
export const PAGE_WORKER_MS = 60000;

// The page in a photo file (readPagePixels' answer, plus `where`, 'worker'
// or 'main'), read in js/scan/page-worker.js where a worker can start, else
// here, pausing between pockets. status 'unreadable' when the photo could
// not be opened. fineSide: the longer side each pocket's own card is cut
// at (POCKET_MAX_SIDE).
export async function readPagePhoto(file, {fineSide = POCKET_MAX_SIDE, maxSide = PAGE_MAX_SIDE, worker = true} = {}) {
	let bitmap;
	let fine;

	try {
		bitmap = await photoBitmap(file, maxSide);
	}
	catch {
		return {cards: 0, findMs: 0, fitted: 0, ms: 0, pockets: [], size: null, status: 'unreadable', where: 'main'};
	}

	fine = await fineBitmap(file, fineSide, bitmap);

	if (worker && typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
		const away = await readAway(bitmap, fine, maxSide);

		if (away) {
			return {...away, where: 'worker'};
		}

		// The bitmaps went to the worker: decoded again for this thread.
		bitmap = await photoBitmap(file, maxSide).catch(() => null);

		if (!bitmap) {
			return {cards: 0, findMs: 0, fitted: 0, ms: 0, pockets: [], size: null, status: 'unreadable', where: 'main'};
		}

		fine = await fineBitmap(file, fineSide, bitmap);
	}

	let pixels;

	try {
		pixels = photoPixels(bitmap, maxSide);
	}
	catch (err) {
		if (fine) {
			fine.close();
		}

		throw err;
	}

	if (bitmap.close) {
		bitmap.close();
	}

	await pause();

	try {
		return {...(await readPagePixels(pixels, {fine})), where: 'main'};
	}
	finally {
		if (fine) {
			fine.close();
		}
	}
}

// The page read in its own worker, which is let go after: the answer, or
// null when the worker failed or took longer than PAGE_WORKER_MS.
function readAway(bitmap, fine, maxSide) {
	return new Promise((resolve) => {
		let away;

		try {
			away = new Worker(new URL('./page-worker.js', import.meta.url), {type: 'module'});
		}
		catch {
			resolve(null);

			return;
		}

		const timer = setTimeout(() => finish(null), PAGE_WORKER_MS);

		function finish(answer) {
			clearTimeout(timer);
			away.terminate();
			resolve(answer);
		}

		away.addEventListener('message', ({data}) => finish(data && data.result ? data.result : null));
		away.addEventListener('error', () => finish(null));

		try {
			away.postMessage({bitmap, fine, maxSide}, fine ? [bitmap, fine] : [bitmap]);
		}
		catch {
			finish(null);
		}
	});
}
