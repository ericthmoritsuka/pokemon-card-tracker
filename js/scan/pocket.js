// A binder pocket's card cut to its own four edges, for its number (Eric,
// 2026-11-19: on his page photos 97 pockets asked for the number and one
// came back, while single scans read numbers well).
//
// A pocket's cut (js/scan/page.js) holds its card with a margin of sleeve,
// pocket welds, and the binder's dark backing round it, and the outlines
// the picture is matched by are found on small copies: the crop that wins
// the picture was often 3 to 8 % off the card on a side. The picture
// forgives that; the number strips, cut at fixed fractions of the card
// (js/vision/pipeline.js REGIONS), land on the sleeve instead. Measured on
// Eric's three upright page photos, no strip read a number.
//
// The card cut to its own edges is offered to the picture first, and its
// number read from a larger copy of the photo (page.js ownCard). On those
// three photos (27 pockets) the sure cards went from 9 to 18, the right
// prints from 13 to 19, and the numbers read from none of 18 that asked to
// 5 of 13, with no sure card of the wrong name. What still does not read is
// the photo itself: the phone's processing leaves the digits soft and
// haloed, and Tesseract reads them as noise at any scale or threshold.
//
// Here each side is the straight line, near where the page puts the card,
// that steps most steadily across its whole run (a printed edge, not the
// backing's dots, which step both ways), and the four together are the box
// of a card's shape and about its size whose border is lighter than what
// lies just outside it on every side: a card's yellow, silver, or white
// border against the backing. The pocket's welds make a box of a card's
// shape and size too, but a thin light line with dark inside it, so its
// sides fail that test. A darker border on a light backing is taken when no
// lighter one fits.
//
// Pure functions over ImageData-shaped objects; no DOM.

import {turnImage} from '../vision/fingerprint.js';
import {warpQuad} from './rectify.js';

const CARD = 63 / 88;

// The cut is searched on a grey copy at most this many pixels tall: a
// pixel there is about a quarter of a percent of the card's height, inside
// what the number strips allow for.
const WORK_HEIGHT = 500;

// How far from where the page puts it a side is looked for, as a share of
// the card's width or height. The page's outline is set by the cards found
// on a small copy and can sit off by more than a tenth of a card (Eric's
// 1000182578: 15 % on the middle row).
const REACH = 0.2;

// The steps a side may lean by, in pixels across per pixel along (about
// 1.7 degrees at most): a card lies straight in its sleeve, and the page's
// own slant is already undone by the cut.
const TILTS = [-0.03, -0.02, -0.01, 0, 0.01, 0.02, 0.03];

// A grey step this large between two pixels' pairs counts toward a side's
// steadiness.
const STEP = 12;

// How many likely lines each side keeps before the four are fitted.
const LINES = 6;

// How far a box's shape may be from a card's, and its size from the card's
// expected place. The page's places run a little large (the cards measured
// 0.88 to 0.97 of theirs); below 0.88 a card's own inner border wins.
const SHAPE_SLACK = 0.04;
const SIZE_MIN = 0.88;
const SIZE_MAX = 1.1;

// The least a side's border band may differ from what lies outside it, in
// grey levels: a box drawn by the backing's texture alone differs by about
// nothing.
const BORDER_MIN = 12;

// The tallest a pocket's card is cut (js/scan/rectify.js CARD_MAX_HEIGHT).
export const POCKET_CARD_MAX_HEIGHT = 1400;

// A grey copy (luma, box-averaged) of `img` at `scale` <= 1.
function greyOf(img, scale) {
	const w = Math.max(1, Math.round(img.width * scale));
	const h = Math.max(1, Math.round(img.height * scale));
	const g = new Float32Array(w * h);
	const {data, width} = img;

	for (let y = 0; y < h; y++) {
		const y0 = Math.min(img.height - 1, Math.floor(y / scale));
		const y1 = Math.max(y0 + 1, Math.min(img.height, Math.floor((y + 1) / scale)));

		for (let x = 0; x < w; x++) {
			const x0 = Math.min(width - 1, Math.floor(x / scale));
			const x1 = Math.max(x0 + 1, Math.min(width, Math.floor((x + 1) / scale)));
			let sum = 0;

			for (let yy = y0; yy < y1; yy++) {
				for (let xx = x0; xx < x1; xx++) {
					const i = (yy * width + xx) * 4;

					sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
				}
			}

			g[y * w + x] = sum / ((y1 - y0) * (x1 - x0));
		}
	}

	return {g, h, w};
}

// The grey at position `at` across a side and `s` along it.
const greyAt = ({g, w}, vertical, at, s) => (vertical ? g[s * w + at] : g[at * w + s]);

// Every line across [from, to) (columns when `vertical`, else rows), each
// at its best lean, run along [s0, s1): {at, lean, score}, score the mean
// signed step across it times the share of the run stepping that way.
function lines(grey, vertical, from, to, s0, s1) {
	const limit = vertical ? grey.w : grey.h;
	const mid = (s0 + s1) / 2;
	const out = [];

	for (let at = from; at < to; at++) {
		let best = {at, lean: 0, score: 0};

		for (const lean of TILTS) {
			let sum = 0;
			let up = 0;
			let down = 0;
			let n = 0;

			for (let s = s0; s < s1; s++) {
				const c = Math.round(at + lean * (s - mid));

				if (c < 2 || c > limit - 3) {
					continue;
				}

				const d = greyAt(grey, vertical, c + 1, s) + greyAt(grey, vertical, c + 2, s) - greyAt(grey, vertical, c - 1, s) - greyAt(grey, vertical, c - 2, s);

				sum += d;
				up += d > STEP ? 1 : 0;
				down += d < -STEP ? 1 : 0;
				n++;
			}

			if (n) {
				const mean = sum / n;
				const score = (Math.abs(mean) * (mean >= 0 ? up : down)) / n;

				if (score > best.score) {
					best = {at, lean, score};
				}
			}
		}

		out.push(best);
	}

	return out;
}

// The `count` strongest lines at least `apart` from each other.
function strongest(found, count, apart) {
	const kept = [];

	for (const line of [...found].sort((a, b) => b.score - a.score)) {
		if (kept.length >= count || line.score <= 0) {
			break;
		}

		if (!kept.some((other) => Math.abs(other.at - line.at) < apart)) {
			kept.push(line);
		}
	}

	return kept;
}

// How much lighter a band `width` pixels wide just inside a side is than
// one just outside it (inward: the way into the card, +1 or -1).
function border(grey, vertical, line, inward, width, s0, s1) {
	const limit = vertical ? grey.w : grey.h;
	const mid = (s0 + s1) / 2;
	let inside = 0;
	let outside = 0;
	let n = 0;

	for (let s = s0; s < s1; s += 2) {
		const c = line.at + line.lean * (s - mid);

		for (let k = 2; k <= width + 1; k++) {
			const i = Math.round(c + inward * k);
			const o = Math.round(c - inward * k);

			if (i >= 0 && o >= 0 && i < limit && o < limit) {
				inside += greyAt(grey, vertical, i, s);
				outside += greyAt(grey, vertical, o, s);
				n++;
			}
		}
	}

	return n ? (inside - outside) / n : 0;
}

// The card's own outline in a pocket's cut (ImageData-shaped), near
// `inner`, its expected place in the cut's pixels (top left first,
// clockwise). Returns {corners, ratio, size} in the cut's pixels (size: the
// outline's against the expected place's), or null when no four sides make
// a card.
export function pocketOutline(cut, inner) {
	const scale = Math.min(1, WORK_HEIGHT / cut.height);
	const grey = greyOf(cut, scale);
	const {h, w} = grey;
	const x0 = Math.min(inner[0].x, inner[3].x) * scale;
	const x1 = Math.max(inner[1].x, inner[2].x) * scale;
	const y0 = Math.min(inner[0].y, inner[1].y) * scale;
	const y1 = Math.max(inner[2].y, inner[3].y) * scale;
	const cw = x1 - x0;
	const ch = y1 - y0;
	const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
	// Sides are measured along their middle three fifths, clear of the
	// corners and of a neighbour's edge running past them.
	const v0 = clamp(y0 + ch * 0.2, 0, h);
	const v1 = clamp(y1 - ch * 0.2, 0, h);
	const u0 = clamp(x0 + cw * 0.2, 0, w);
	const u1 = clamp(x1 - cw * 0.2, 0, w);
	const side = (vertical, at, span, s0, s1) => strongest(lines(grey, vertical, clamp(at - span * REACH, 2, vertical ? w - 2 : h - 2), clamp(at + span * REACH, 2, vertical ? w - 2 : h - 2), s0, s1), LINES, span * 0.015);
	const bandWidth = Math.max(2, Math.round(cw * 0.03));
	const left = side(true, x0, cw, v0, v1).map((line) => ({...line, light: border(grey, true, line, 1, bandWidth, v0, v1)}));
	const right = side(true, x1, cw, v0, v1).map((line) => ({...line, light: border(grey, true, line, -1, bandWidth, v0, v1)}));
	const top = side(false, y0, ch, u0, u1).map((line) => ({...line, light: border(grey, false, line, 1, bandWidth, u0, u1)}));
	const bottom = side(false, y1, ch, u0, u1).map((line) => ({...line, light: border(grey, false, line, -1, bandWidth, u0, u1)}));
	let best = null;

	for (const l of left) {
		for (const r of right) {
			for (const t of top) {
				for (const b of bottom) {
					const bw = r.at - l.at;
					const bh = b.at - t.at;

					if (bw <= 0 || bh <= 0) {
						continue;
					}

					const shape = bw / bh / CARD;
					const size = Math.sqrt((bw * bh) / (cw * ch));

					if (Math.abs(shape - 1) > SHAPE_SLACK || size < SIZE_MIN || size > SIZE_MAX) {
						continue;
					}

					const lights = [l.light, r.light, t.light, b.light];

					if (lights.some((v) => Math.abs(v) < BORDER_MIN)) {
						continue;
					}

					const lighter = lights.every((v) => v > 0);
					const darker = lights.every((v) => v < 0);
					const contrast = Math.min(...lights.map(Math.abs)) + lights.reduce((sum, v) => sum + Math.abs(v), 0) / 4;
					const score = (lighter ? 1 : darker ? 0.5 : 0.1) * contrast * (1 - Math.abs(shape - 1) * 4);

					if (!best || score > best.score) {
						best = {b, l, r, score, shape, size, t};
					}
				}
			}
		}
	}

	if (!best) {
		return null;
	}

	// Each side is at + lean * (along - its run's middle); a corner is where
	// a column line meets a row line.
	const my = (v0 + v1) / 2;
	const mx = (u0 + u1) / 2;
	const meet = (col, row) => {
		const x = (col.at + col.lean * (row.at - row.lean * mx - my)) / (1 - col.lean * row.lean);
		const y = row.at + row.lean * (x - mx);

		return {x: (x + 0.5) / scale, y: (y + 0.5) / scale};
	};

	return {corners: [meet(best.l, best.t), meet(best.r, best.t), meet(best.r, best.b), meet(best.l, best.b)], ratio: best.shape * CARD, size: best.size};
}

// The card cut straight out of `image` by `corners` (in its pixels), as
// tall as it lies there, at most POCKET_CARD_MAX_HEIGHT, card-shaped.
export function cutCard(image, corners) {
	const [tl, tr, br, bl] = corners;
	const tall = Math.max(8, Math.min(POCKET_CARD_MAX_HEIGHT, Math.round(Math.max(Math.hypot(bl.x - tl.x, bl.y - tl.y), Math.hypot(br.x - tr.x, br.y - tr.y)))));

	return warpQuad(image, corners, Math.round(tall * CARD), tall);
}

// A pocket's picture answer (js/scan/identify.js identifyPicture) with its
// card swapped for the pocket's own cut (cutCard), turned as the picture
// found the card lying, so the number is read from it and the tile's photo
// shows it. The crop that won the picture is kept for what it was matched
// by; the answer is unchanged when there is no own cut.
export function withPocketCard(seen, card) {
	if (!seen || !card || !card.width || !card.height) {
		return seen;
	}

	const turn = (seen.picture && seen.picture.turn) || 0;

	return {...seen, card: turn ? turnImage(card, turn) : card};
}
