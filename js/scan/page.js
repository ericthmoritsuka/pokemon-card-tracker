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
// Two pages taken as one (a spread, the phone turned) are not read: lab/multi
// found them too often cut wrong. The photo is asked for again instead.
//
// No DOM at import, so js/scan/page-worker.js runs it off the main thread;
// readPagePixels draws on an OffscreenCanvas, or a canvas element where
// there is none. The helpers above it are pure, for Node's tests.

import {fitPage, pageCells, pageShape, quadPoint, splitSpread} from './multi.js';
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
export function locatePage(grey, width, height, {cols = PAGE_COLS, rows = PAGE_ROWS} = {}) {
	const cards = findCards(grey, width, height);
	const areas = cards.map((card) => area(card.corners)).sort((a, b) => a - b);
	const cardArea = areas.length >= 3 ? areas[Math.floor(areas.length / 2)] : null;
	const pages = findPages(grey, width, height, {cardArea, max: 2, pockets: rows * cols, shape: pageShape(rows, cols)});
	const [page] = pages;

	if (!page) {
		return {cards: cards.length, corners: null, fitted: 0, status: 'none'};
	}

	// Two pages found apart, or one standing outline whose cards lie across
	// it (the whole spread's outline, which for 3 x 3 pages has a page's
	// shape too). A lone page taken sideways lies with its cards, and is
	// read.
	if (pages.length > 1 || (page.upright !== false && splitSpread(page.corners, cards))) {
		return {cards: cards.length, corners: page.corners, fitted: 0, status: 'spread'};
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
			return {cards: cards.length, corners: null, fitted: 0, status: 'none'};
		}
	}

	return {cards: cards.length, corners: fitted ? fitted.corners : page.corners, fitted: fitted ? fitted.cards : 0, status: 'page'};
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

// ------------------------------------------------------------ what Eric reads

// The progress line while pocket `n` (1 to `of`) is read.
export const pocketProgress = (n, of) => `Reading pocket ${n} of ${of}.`;

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The line once a page is read: how many cards joined the tray, how many
// of those need a look, and how many pockets were empty. rough: the page's
// outline was not set right by its cards, so the pockets may be off.
export function pageSummary({added, empty, look, rough = false}) {
	if (!added) {
		return empty ? 'Every pocket on that page looked empty.' : 'No cards were found on that page.';
	}

	const parts = [`Page read: ${count(added, 'card', 'cards')} added`];

	if (look) {
		parts.push(`${look} to check`);
	}

	let text = `${parts.join(', ')}.`;

	if (empty) {
		text += ` ${count(empty, 'empty pocket', 'empty pockets')} skipped.`;
	}

	if (rough) {
		text += ' The page edges were unclear, so check each card.';
	}

	return text;
}

// Why a page was not read, as plain advice to take it again.
export function pageTrouble(status) {
	if (status === 'spread') {
		return 'That looks like two pages. Take one page at a time, upright.';
	}

	if (status === 'unreadable') {
		return 'That photo could not be opened. Try another one.';
	}

	return 'The page could not be found in that photo. Take it again: one page, upright, filling the photo.';
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

// The page in a photo's pixels (ImageData), cut into its pockets. Returns
// {status, fitted, cards, findMs, ms, size, pockets}: status as locatePage's;
// pockets, for a page, row by row, each {index, row, col, empty} and, for a
// pocket that is not empty, image (its cut, card-shaped ImageData), quads
// (in the cut's pixels: the card's own outline found by js/scan/pocket.js
// first, when found, then pocketQuads), and card, that outline cut
// straight out of `fine` (a larger copy of the photo, a bitmap) or the
// photo itself, for the number (ownCard). Pauses between pockets, so on
// the main thread the page keeps answering.
export async function readPagePixels(image, {cols = PAGE_COLS, fine = null, rows = PAGE_ROWS, side = PAGE_SIDE} = {}) {
	const started = performance.now();
	const scale = Math.min(1, side / Math.max(image.width, image.height));
	const w = Math.max(1, Math.round(image.width * scale));
	const h = Math.max(1, Math.round(image.height * scale));
	const small = shrink(canvasHolding(image), w, h, 'medium');
	const where = locatePage(toGrey(small.data, w, h), w, h, {cols, rows});
	const findMs = Math.round(performance.now() - started);
	const out = {cards: where.cards, findMs, fitted: where.fitted, ms: 0, pockets: [], size: `${image.width} x ${image.height}`, status: where.status};

	if (where.status !== 'page') {
		out.ms = Math.round(performance.now() - started);

		return out;
	}

	// The copy's scale against the photo, from the sizes as drawn.
	const copyScale = w / image.width;

	for (const plan of pocketPlan(where.corners, copyScale, {cols, rows})) {
		await pause();

		const raw = warpQuad(image, plan.cut, plan.width, plan.height);
		const cut = new ImageData(raw.data, plan.width, plan.height);
		const own = ownOutline(cut, plan.inner);
		const empty = isEmptyPocket({colour: colourOf(cut), own});
		const pocket = {col: plan.col, empty, index: plan.index, row: plan.row};

		if (!empty) {
			pocket.image = cut;
			pocket.quads = pocketQuads(own, plan.inner);

			// The card's own four edges (2026-11-19): offered to the picture
			// first, and cut from the larger copy for the number, which the
			// outlines above, found on small copies, put on the sleeve.
			const tight = pocketOutline(cut, plan.inner);

			if (tight) {
				pocket.quads = [{corners: tight.corners, ratio: tight.ratio, upright: true}, ...pocket.quads];
				pocket.card = ownCard(fine || image, tight.corners.map((p) => quadPoint(plan.cut, p.x / plan.width, p.y / plan.height)), fine ? fine.width / image.width : 1);
			}
		}

		out.pockets.push(pocket);
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

	const pixels = photoPixels(bitmap, maxSide);

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
