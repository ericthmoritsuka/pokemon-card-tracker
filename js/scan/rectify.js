// Finds the card inside a capture and cuts it out straight: js/vision/rectify.js
// (measured on the lab benchmark), with one change for speed. The lab turns
// the whole full-resolution capture, then crops it; here the tilt is undone
// on the small detection copy, and the card is cut from the capture in one
// pass that turns, crops, and scales it at once, to at most CARD_MAX_HEIGHT
// pixels tall. A 4K phone frame no longer pays for turning pixels outside
// the card, nor for keeping more pixels than the reader uses.
//
// The lab crops a little more than its guide frame, so the whole card is in
// the image even when it is held a bit large, small, or off centre. This
// module finds the card's four edges, measures how far the card is turned,
// turns it back, and crops to the edges. The benchmark showed why: with the
// card 6 % smaller than the frame and 2 % off centre, the fixed regions in
// pipeline.js missed the collector number on most cards.
//
// Pure functions over ImageData-shaped objects, like pipeline.js.

import {CARD_RATIO} from '../vision/pipeline.js';

// Detection runs on a copy at most this many pixels tall; the crop and the
// rotation use the full image.
const WORK_HEIGHT = 700;

// The straightened card is at most this tall. The collector number is about
// 1 % of the card's height, so it is 14 px tall here; the reader scales every
// crop so its text is 32 px tall anyway, and the lab read 600 x 825 scans
// (8 px numbers) well.
export const CARD_MAX_HEIGHT = 1400;

function greyCopy(img, scale) {
	const width = Math.max(1, Math.round(img.width * scale));
	const height = Math.max(1, Math.round(img.height * scale));
	const grey = new Float32Array(width * height);

	// Each pixel of the copy averages the block of source pixels it covers
	// (up to 4 x 4). Taking a single source pixel, as before, skipped a
	// card's thin outline at two pixels in three on a 4K capture, when that
	// outline is all that tells a silver border from a light table.
	const reach = Math.min(3, Math.max(0, Math.ceil(1 / scale - 0.01) - 1));

	for (let y = 0; y < height; y++) {
		const sy = Math.min(img.height - 1 - reach, Math.floor((y + 0.5) / scale - reach / 2));

		for (let x = 0; x < width; x++) {
			const sx = Math.min(img.width - 1 - reach, Math.floor((x + 0.5) / scale - reach / 2));
			let sum = 0;

			for (let dy = 0; dy <= reach; dy++) {
				const row = (sy + dy) * img.width;

				for (let dx = 0; dx <= reach; dx++) {
					const i = (row + sx + dx) * 4;

					sum += img.data[i] + img.data[i + 1] + img.data[i + 2];
				}
			}

			grey[y * width + x] = sum / (3 * (reach + 1) * (reach + 1));
		}
	}

	return {grey, height, width};
}

// How sharp a brightness step must be to count as part of an edge, on the
// detection copy: 18 levels, or less on a quiet table. A silver or white
// border on a light table steps only 10 to 20 levels at the card's outline
// (synthetic captures at the version 25 geometry, 2026-10-03), so half its
// length fell short of 18, the box was judged not card-shaped, and the
// fallback took the art box's inner line for the card. The table's own
// noise is measured in the capture's outer band (it is table around the
// guide), and a step must stand four times clear of it, never under 9.
const STEP = 18;

function stepFor({grey, height, width}) {
	const band = Math.max(4, Math.round(Math.min(width, height) * 0.03));
	const values = [];
	const sample = (x, y) => {
		if (x >= 2 && x < width - 2) {
			values.push(Math.abs(grey[y * width + x - 2] - grey[y * width + x + 2]));
		}
	};

	for (let y = 0; y < height; y += 3) {
		for (let x = 2; x < band; x += 2) {
			sample(x, y);
			sample(width - 1 - x, y);
		}
	}

	if (values.length < 50) {
		return STEP;
	}

	values.sort((a, b) => a - b);

	return Math.max(9, Math.min(STEP, values[Math.floor(values.length * 0.75)] * 4));
}

// Sum of horizontal brightness steps per column, over rows y0..y1 (or of
// vertical steps per row, over columns, with `vertical`).
function profile({grey, height, width}, from, to, vertical = false) {
	const length = vertical ? height : width;
	const out = new Float64Array(length);
	const d = 2;

	for (let i = d; i < length - d; i++) {
		let sum = 0;

		for (let j = from; j < to; j++) {
			const a = vertical ? grey[(i - d) * width + j] : grey[j * width + i - d];
			const b = vertical ? grey[(i + d) * width + j] : grey[j * width + i + d];

			sum += Math.abs(a - b);
		}

		out[i] = sum / Math.max(1, to - from);
	}

	return out;
}

// The outermost strong edge in out[start..end): the first (or, with
// `fromEnd`, last) local peak at least half the window's strongest. Inner
// frames of the card (the art box, the text box) make strong edges too, and
// the card's own edge is the outermost of them.
function outerEdge(values, start, end, fromEnd) {
	let max = 0;

	for (let i = start; i < end; i++) {
		max = Math.max(max, values[i]);
	}

	if (max < 8) {
		return null;
	}

	const isPeak = (i) => values[i] >= max * 0.5 && values[i] >= values[i - 1] && values[i] >= values[i + 1];

	if (fromEnd) {
		for (let i = end - 2; i > start; i--) {
			if (isPeak(i)) {
				return i;
			}
		}
	}
	else {
		for (let i = start + 1; i < end - 1; i++) {
			if (isPeak(i)) {
				return i;
			}
		}
	}

	return null;
}

// The outermost edge in out[start..end) that runs straight along the side:
// a peak of at least a fifth of the window's strongest whose step is sharp
// along most of the line (continuity), taken from the outside in. A silver
// or white border on a light table steps far less than the border's inner
// line (the art or the text box), so the half-strength rule of outerEdge
// took that inner line for the card's edge, a card about 7 % too narrow
// (synthetic captures at the version 25 geometry, 2026-10-03: widths 98 to
// 162 px short of 1400, and the picture match lost). The table's grain, a
// glare's soft rim, and a shadow do not run straight along the side, so
// they fail the continuity test. Falls back to outerEdge.
function straightEdge(work, values, start, end, fromEnd, vertical, span) {
	const fallback = outerEdge(values, start, end, fromEnd);
	const list = peaks(values, start, end, 0.2, Infinity).sort((a, b) => (fromEnd ? b - a : a - b));

	for (const index of list) {
		if (fallback !== null && (fromEnd ? index <= fallback : index >= fallback)) {
			break;
		}

		if (continuity(work, index, span[0], span[1], vertical, 1) >= 0.45) {
			return index;
		}
	}

	return fallback;
}

function findEdges(work) {
	const {height, width} = work;
	const columns = profile(work, Math.round(height * 0.2), Math.round(height * 0.8));
	const rows = profile(work, Math.round(width * 0.2), Math.round(width * 0.8), true);
	const down = [Math.round(height * 0.2), Math.round(height * 0.8)];
	const across = [Math.round(width * 0.2), Math.round(width * 0.8)];

	return {
		bottom: straightEdge(work, rows, Math.round(height * 0.75), height, true, true, across),
		left: straightEdge(work, columns, 0, Math.round(width * 0.25), false, false, down),
		right: straightEdge(work, columns, Math.round(width * 0.75), width, true, false, down),
		top: straightEdge(work, rows, 0, Math.round(height * 0.25), false, true, across),
	};
}

// How much of a straight line at `index` (a column, or a row with
// `vertical`) is a sharp step, over the part of the other axis from..to: a
// card's edge steps all along it; text, buttons, and the screen around a
// card on a laptop do not. `slack`: how far off the line, either way, the
// step may be (a card turned a little leaves its edge a few pixels off a
// line straight across, towards its ends).
//
// On a copy turned to undo the tilt (rotateGrey), the corners of the copy
// came from outside the capture, and a card turned in the hand often runs
// out of the capture there. Only the part of the line inside the capture is
// judged; `unseen` is what a line mostly outside it scores (0: cannot count
// as an edge; 1: a corner that cannot be checked is not held against the
// card).
function continuity({grey, height, outside = null, step = STEP, width}, index, from, to, vertical = false, slack = 1, unseen = 0) {
	const length = vertical ? height : width;
	const d = 2;
	let on = 0;
	let seen = 0;

	if (index - d - 1 < 0 || index + d + 1 >= length) {
		return 0;
	}

	for (let j = from; j < to; j++) {
		if (outside && outside[vertical ? index * width + j : j * width + index]) {
			continue;
		}

		seen++;

		let best = 0;

		for (let k = -slack; k <= slack; k++) {
			const i = index + k;

			if (i - d < 0 || i + d >= length) {
				continue;
			}

			const a = vertical ? grey[(i - d) * width + j] : grey[j * width + i - d];
			const b = vertical ? grey[(i + d) * width + j] : grey[j * width + i + d];

			best = Math.max(best, Math.abs(a - b));
		}

		if (best > step) {
			on++;
		}
	}

	if (seen < (to - from) / 3) {
		return unseen;
	}

	return on / Math.max(1, seen);
}

// The local peaks of out[start..end) at least `share` of its strongest, the
// strongest first, at most `count`.
function peaks(values, start, end, share = 0.25, count = 6) {
	let max = 0;

	for (let i = start; i < end; i++) {
		max = Math.max(max, values[i]);
	}

	if (max < 8) {
		return [];
	}

	const found = [];

	for (let i = Math.max(1, start); i < Math.min(values.length - 1, end); i++) {
		if (values[i] >= max * share && values[i] >= values[i - 1] && values[i] > values[i + 1]) {
			found.push(i);
		}
	}

	return found.sort((a, b) => values[b] - values[a]).slice(0, count);
}

// A straight edge near `index` (a column, or a row with `vertical`), which
// may lean: along the other axis, the strongest step within `reach` of
// index, sampled every 2 pixels, then the line most of those points lie on
// (pairs of points tried as lines, the one with the most points within 2
// pixels kept, then fitted to its points). Points off the card (the screen
// around it) fall off the line.
//
// A side that leans (a card seen at a slant, wider at the top) leaves the
// first search's reach towards its ends, so the line is then followed: the
// strongest step close to where the line runs, along its whole length, and
// fitted again, for as long as that finds more of it.
//
// Returns {p, q, ts}: position = p + q * t, and ts the samples on the line,
// so how much of any stretch the edge runs along can be counted.
function edgeLine({grey, height, step: sharp = STEP, width}, index, vertical, reach) {
	const length = vertical ? height : width;
	const along = vertical ? width : height;
	const d = 2;

	// The strongest step at t within from..to, or null.
	const stepAt = (t, from, to) => {
		let best = 0;
		let at = -1;

		for (let i = Math.max(d, from); i <= Math.min(length - d - 1, to); i++) {
			const a = vertical ? grey[(i - d) * width + t] : grey[t * width + i - d];
			const b = vertical ? grey[(i + d) * width + t] : grey[t * width + i + d];
			const value = Math.abs(a - b);

			if (value > best) {
				best = value;
				at = i;
			}
		}

		return best > sharp * (2 / 3) ? at : null;
	};

	const fit = (on) => {
		let st = 0;
		let si = 0;
		let stt = 0;
		let sti = 0;

		for (const [t, i] of on) {
			st += t;
			si += i;
			stt += t * t;
			sti += t * i;
		}

		const den = on.length * stt - st * st;
		const q = den ? (on.length * sti - st * si) / den : 0;

		return {p: (si - q * st) / on.length, q};
	};

	const points = [];

	for (let t = 2; t < along - 2; t += 2) {
		const at = stepAt(t, index - reach, index + reach);

		if (at !== null) {
			points.push([t, at]);
		}
	}

	if (points.length < 8) {
		return null;
	}

	// The points on the line most of `list` lies on: pairs of points tried
	// as lines, the one with the most points within 2 pixels kept.
	const mostOn = (list) => {
		const near = (p, q) => list.filter(([t, i]) => Math.abs(p + q * t - i) <= 2);
		const step = Math.max(1, Math.floor(list.length / 12));
		let on = [];

		for (let m = 0; m < list.length; m += step) {
			for (let n = m + Math.max(4, Math.floor(list.length / 4)); n < list.length; n += step * 2) {
				const [t1, i1] = list[m];
				const [t2, i2] = list[n];
				const q = (i2 - i1) / (t2 - t1);

				if (Math.abs(q) > 0.12) {
					continue;
				}

				const found = near(i1 - q * t1, q);

				if (found.length > on.length) {
					on = found;
				}
			}
		}

		return on;
	};

	let best = mostOn(points);

	if (best.length < 8) {
		return null;
	}

	let line = fit(best);
	const follow = Math.max(3, Math.round(length * 0.012));

	for (let pass = 0; pass < 2; pass++) {
		const tracked = [];

		for (let t = 2; t < along - 2; t += 2) {
			const at = stepAt(t, Math.round(line.p + line.q * t) - follow, Math.round(line.p + line.q * t) + follow);

			if (at !== null) {
				tracked.push([t, at]);
			}
		}

		const on = tracked.length >= 8 ? mostOn(tracked) : [];

		if (on.length <= best.length) {
			break;
		}

		best = on;
		line = fit(on);
	}

	return {...line, ts: best.map(([t]) => t)};
}

// The share of t0..t1 a line runs along, its samples being 2 pixels apart.
// On a copy turned straight (rotateGrey), only the stretch inside the
// capture counts: a card turned in the hand runs out of the capture at its
// corners, and the part of its edge out there cannot be seen. A stretch
// mostly out of it scores `unseen` (0: a side cannot count as found
// there; 1: a corner that cannot be seen is not held against the box).
function coverage(line, t0, t1, unseen = 0) {
	const on = line.ts.filter((t) => t >= t0 && t <= t1).length;
	const work = line.work;

	if (!work || !work.outside) {
		return on / Math.max(1, (t1 - t0) / 2);
	}

	let all = 0;
	let seen = 0;

	for (let t = Math.ceil(t0); t <= t1; t += 2) {
		const at = Math.round(line.p + line.q * t);
		const x = line.vertical ? t : at;
		const y = line.vertical ? at : t;

		all++;

		if (x >= 0 && y >= 0 && x < work.width && y < work.height && !work.outside[y * work.width + x]) {
			seen++;
		}
	}

	return seen < all / 3 ? unseen : Math.min(1, on / Math.max(1, seen));
}

// How well a box's bottom corners are made, 0 to 1: at each, both lines
// that meet there must run along the stretch next to it (5 to 15 % of the
// side's length in, past the card's rounded corner). A card's border is
// closed; a box that borrows a side from something else (the edge of the
// screen the card is shown on, a panel beside it) has a corner where one of
// its lines stops short. The bottom corners are the ones checked: the
// bottom edge is always in a capture the reader can use (the number strip
// sits on it), while the top is often cut off, lost in glare, or bowed by
// the lens, so a side line may fit only its lower part.
function cornerSupport({bottom, left, right}, yTop, yBottom, w) {
	const h = yBottom - yTop;
	const corner = (side, inward) => {
		const x = side.p + side.q * yBottom;
		const along = inward > 0 ? [x + w * 0.05, x + w * 0.15] : [x - w * 0.15, x - w * 0.05];

		return Math.min(coverage(side, yBottom - h * 0.15, yBottom - h * 0.05, 1), coverage(bottom, ...along, 1));
	};

	return Math.min(corner(left, 1), corner(right, -1));
}

// The card as the best card-shaped four-sided box of straight edges, for a
// capture the outermost edges mislead: a photo of the card on a screen, with
// the app's own text and buttons around it, taken at a slant so the card's
// sides lean opposite ways. Every strong column and row near each side is
// followed as a line; a box must have about the card's 63:88 shape, or,
// with its top lost, take its top from its width. Of the boxes whose sides
// run along at least 45 % of their length, the one with the best corners
// wins (cornerSupport: a box with a side borrowed from the screen around the
// card is wider than the card, and its top, worked out from that width,
// takes in the heading above it), then the widest (the card's own edge is
// outside its inner border), helped a little by straighter sides.
// Returns {left, right, top, bottom} as lines, top null when worked out.
function findQuad(work) {
	const {height, width} = work;
	const columns = profile(work, Math.round(height * 0.2), Math.round(height * 0.8));
	const rows = profile(work, Math.round(width * 0.2), Math.round(width * 0.8), true);
	const ratio = 1 / CARD_RATIO;
	const lines = (list, vertical) => {
		const out = [];

		for (const index of list) {
			const line = edgeLine(work, index, vertical, Math.round((vertical ? height : width) * 0.03));

			if (line && !out.some((other) => Math.abs(other.p - line.p) < 3 && Math.abs(other.q - line.q) < 0.02)) {
				out.push({...line, vertical, work});
			}
		}

		return out;
	};
	const lefts = lines(peaks(columns, 0, Math.round(width * 0.4), 0.2, 8), false);
	const rights = lines(peaks(columns, Math.round(width * 0.6), width, 0.2, 8), false);
	const tops = lines(peaks(rows, 0, Math.round(height * 0.4), 0.2, 8), true);
	const bottoms = lines(peaks(rows, Math.round(height * 0.6), height, 0.2, 8), true);
	let best = null;

	for (const left of lefts) {
		for (const right of rights) {
			for (const bottom of bottoms) {
				for (const top of [...tops, null]) {
					// Corners, with a lost top taken from the width.
					const xMid = (left.p + right.p) / 2;
					const yBottom = bottom.p + bottom.q * xMid;
					let w = right.p + right.q * yBottom - (left.p + left.q * yBottom);
					const yTop = top ? top.p + top.q * xMid : yBottom - w * ratio;
					const yMid = (yTop + yBottom) / 2;

					w = (right.p + right.q * yMid) - (left.p + left.q * yMid);

					if (w < width * 0.45 || (top && Math.abs((yBottom - yTop) / w - ratio) / ratio > 0.06) || (!top && yTop < -height * 0.08)) {
						continue;
					}

					const xLeft = left.p + left.q * yMid;
					const xRight = right.p + right.q * yMid;
					const t0 = Math.max(0, yTop) + (yBottom - Math.max(0, yTop)) * 0.08;
					const t1 = yBottom - (yBottom - Math.max(0, yTop)) * 0.08;
					const s0 = xLeft + w * 0.08;
					const s1 = xRight - w * 0.08;
					const sides = [coverage(left, t0, t1), coverage(right, t0, t1), coverage(bottom, s0, s1), ...(top ? [coverage(top, s0, s1)] : [])];
					const corners = cornerSupport({bottom, left, right}, yTop, yBottom, w);
					const score = w / width + Math.min(...sides) * 0.3 + corners * 0.5 - (top ? 0 : 0.05);

					if (Math.min(...sides) >= 0.45 && (!best || score > best.score)) {
						best = {bottom, left, right, score, top, w};
					}
				}
			}
		}
	}

	return best;
}

// Where two edge lines cross: `side` is x = p + q * y, `across` y = p + q * x.
function cross(side, across) {
	const x = (side.p + side.q * across.p) / (1 - side.q * across.q);

	return {x, y: across.p + across.q * x};
}

// Cuts the quadrilateral tl, tr, br, bl out of `img` as a width x height
// rectangle, in one bilinear pass (a projective map from the square to the
// quad, after Heckbert).
export function warpQuad(img, [tl, tr, br, bl], width, height) {
	const dx1 = tr.x - br.x;
	const dx2 = bl.x - br.x;
	const dx3 = tl.x - tr.x + br.x - bl.x;
	const dy1 = tr.y - br.y;
	const dy2 = bl.y - br.y;
	const dy3 = tl.y - tr.y + br.y - bl.y;
	const den = dx1 * dy2 - dx2 * dy1;
	const g = den ? (dx3 * dy2 - dx2 * dy3) / den : 0;
	const hh = den ? (dx1 * dy3 - dx3 * dy1) / den : 0;
	const a = tr.x - tl.x + g * tr.x;
	const b = bl.x - tl.x + hh * bl.x;
	const d = tr.y - tl.y + g * tr.y;
	const e = bl.y - tl.y + hh * bl.y;
	const out = new Uint8ClampedArray(width * height * 4);
	const src = img.data;
	const stride = img.width * 4;

	for (let y = 0; y < height; y++) {
		const v = (y + 0.5) / height;

		for (let x = 0; x < width; x++) {
			const u = (x + 0.5) / width;
			const w = g * u + hh * v + 1;
			const sx = Math.min(img.width - 1.001, Math.max(0, (a * u + b * v + tl.x) / w));
			const sy = Math.min(img.height - 1.001, Math.max(0, (d * u + e * v + tl.y) / w));
			const x0 = Math.floor(sx);
			const y0 = Math.floor(sy);
			const fx = sx - x0;
			const fy = sy - y0;
			const i00 = y0 * stride + x0 * 4;
			const i10 = i00 + 4;
			const i01 = i00 + stride;
			const i11 = i01 + 4;
			const o = (y * width + x) * 4;

			for (let c = 0; c < 3; c++) {
				out[o + c] = (src[i00 + c] * (1 - fx) + src[i10 + c] * fx) * (1 - fy)
					+ (src[i01 + c] * (1 - fx) + src[i11 + c] * fx) * fy;
			}

			out[o + 3] = 255;
		}
	}

	return {data: out, height, width};
}

function plausible(work, edges) {
	if (edges.left === null || edges.right === null || edges.bottom === null) {
		return false;
	}

	const w = edges.right - edges.left;
	const top = edges.top === null || Math.abs((edges.bottom - edges.top) * CARD_RATIO - w) / w > 0.06 ? Math.max(0, edges.bottom - w / CARD_RATIO) : edges.top;
	const span = [Math.round(top + (edges.bottom - top) * 0.1), Math.round(top + (edges.bottom - top) * 0.9)];

	// The bottom corners closed, as in cornerSupport: the bottom edge runs
	// out to both sides, so a side borrowed from the screen around the card
	// (past where the card's bottom stops) is not taken for the card's. Near
	// the corners a card turned a little (less than measureTilt turns back)
	// has its edge a few pixels off the row through its middle. Whether the
	// sides run down to the bottom is not asked here: the dark lower corner
	// of a full-art card can barely stand out from a dark table.
	const slack = Math.max(2, Math.round(w * 0.02));

	return w >= work.width * 0.6
		&& continuity(work, edges.left, span[0], span[1]) >= 0.5
		&& continuity(work, edges.right, span[0], span[1]) >= 0.5
		&& continuity(work, edges.bottom, Math.round(edges.left + w * 0.1), Math.round(edges.right - w * 0.1), true) >= 0.5
		&& continuity(work, edges.bottom, Math.round(edges.left + w * 0.05), Math.round(edges.left + w * 0.15), true, slack, 1) >= 0.5
		&& continuity(work, edges.bottom, Math.round(edges.right - w * 0.15), Math.round(edges.right - w * 0.05), true, slack, 1) >= 0.5;
}

// The most a card held by hand is taken to be turned in the plane, either
// way, in degrees. A card turned further is read as it is.
export const TILT_MAX = 22;

// The card's tilt in degrees (positive: turned clockwise), as the angle at
// which the image's strong edges line up best. Every edge on a card runs
// parallel to one of its sides (its border, the art box, the text lines),
// so the pixels where the brightness steps sharply, projected across lines
// at the right angle, pile up in a few narrow bins; at a wrong angle they
// spread out. The angle whose bins are most piled up (the largest sum of
// squared counts) wins: every second degree up to TILT_MAX either way, then
// half degrees and tenths around the best. Near-vertical steps are projected along lines
// leaning by the angle, near-horizontal ones along lines rising by it.
//
// It replaces the lab's reading of the tilt from where the left and right
// edges sit high and low in the frame, which smeared out past about 5
// degrees (a turned edge spreads over many columns) and gave 0, so a card
// held at a 12 degree slant was read crooked (Q-16 in plans/audit-qa.md). A
// card seen at a slant from below or above (wider at the top) leans its two
// sides opposite ways and keeps its rows level, so it comes out near 0, and
// findQuad takes the lean.
function measureTilt({grey, height, width}) {
	const step = 2;
	const across = [];
	const down = [];

	for (let y = step; y < height - step; y += step) {
		for (let x = step; x < width - step; x += step) {
			const gx = Math.abs(grey[y * width + x + step] - grey[y * width + x - step]);
			const gy = Math.abs(grey[(y + step) * width + x] - grey[(y - step) * width + x]);

			// A step across the row is part of a near-vertical edge, a step
			// down the column of a near-horizontal one; corners and diagonal
			// strokes, neither.
			if (gx >= 40 && gx > gy * 2) {
				across.push(x, y);
			}
			else if (gy >= 40 && gy > gx * 2) {
				down.push(x, y);
			}
		}
	}

	if (across.length + down.length < 200) {
		return 0;
	}

	// Bins two pixels wide, each half with room for any line at up to
	// TILT_MAX.
	const size = width + height + 8;
	const bins = new Int32Array(size * 2);
	const offset = Math.ceil((width + height) / 2) + 4;
	const score = (degrees) => {
		const t = Math.tan((degrees * Math.PI) / 180);
		let sum = 0;

		bins.fill(0);

		// A vertical edge turned clockwise runs to the left as it goes down:
		// x + t y is the same all along it. A horizontal one runs down as it
		// goes right: y - t x is.
		for (let i = 0; i < across.length; i += 2) {
			bins[Math.round((across[i] + t * across[i + 1]) / 2) + offset]++;
		}

		for (let i = 0; i < down.length; i += 2) {
			bins[size + Math.round((down[i + 1] - t * down[i]) / 2) + offset]++;
		}

		for (let i = 0; i < bins.length; i++) {
			sum += bins[i] * bins[i];
		}

		return sum;
	};
	let best = 0;
	let bestScore = score(0);

	// Every second degree, then half degrees, then tenths around the best.
	for (const [spread, by] of [[TILT_MAX, 2], [1.5, 0.5], [0.4, 0.1]]) {
		const around = best;

		for (let k = -Math.round(spread / by); k <= Math.round(spread / by); k++) {
			const degrees = Math.round((around + k * by) * 10) / 10;

			if (Math.abs(degrees) > TILT_MAX || degrees === around) {
				continue;
			}

			const value = score(degrees);

			if (value > bestScore) {
				best = degrees;
				bestScore = value;
			}
		}
	}

	return best;
}

// Turns a grey detection copy by `degrees` about its centre, like warpCrop.
// `outside` marks the pixels that came from beyond the copy's edges (more
// than a pixel out), which continuity leaves out.
function rotateGrey(work, degrees) {
	const {grey, height, width} = work;
	const out = new Float32Array(width * height);
	const outside = new Uint8Array(width * height);
	const radians = (-degrees * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const cx = width / 2;
	const cy = height / 2;

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const dx = x - cx;
			const dy = y - cy;
			const fx = Math.round(cx + dx * cos - dy * sin);
			const fy = Math.round(cy + dx * sin + dy * cos);
			const sx = Math.min(width - 1, Math.max(0, fx));
			const sy = Math.min(height - 1, Math.max(0, fy));

			out[y * width + x] = grey[sy * width + sx];

			if (Math.abs(fx - sx) > 1 || Math.abs(fy - sy) > 1) {
				outside[y * width + x] = 1;
			}
		}
	}

	return {grey: out, height, outside, step: work.step, width};
}

// Where a point of a copy turned by rotateGrey(copy, -degrees) lies on the
// copy as it was.
function unturn({x, y}, degrees, {height, width}) {
	const radians = (degrees * Math.PI) / 180;
	const dx = x - width / 2;
	const dy = y - height / 2;

	return {
		x: width / 2 + dx * Math.cos(radians) - dy * Math.sin(radians),
		y: height / 2 + dx * Math.sin(radians) + dy * Math.cos(radians),
	};
}

// The four corners (top left, top right, bottom right, bottom left) in
// `img`'s own coordinates of the box warpCrop(img, -angle, rect) cuts: for
// drawing the box on the capture (the scan report's capture image).
export function rectQuad(img, rect, angle = 0) {
	const radians = (angle * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const cx = img.width / 2;
	const cy = img.height / 2;
	const at = (x, y) => ({x: cx + (x - cx) * cos - (y - cy) * sin, y: cy + (x - cx) * sin + (y - cy) * cos});

	return [at(rect.x, rect.y), at(rect.x + rect.w, rect.y), at(rect.x + rect.w, rect.y + rect.h), at(rect.x, rect.y + rect.h)];
}

// Cuts `rect` (in the coordinates of `img` turned by `degrees` about its
// centre) out of `img`, scaled by `scale`, in one bilinear pass.
export function warpCrop(img, degrees, rect, scale = 1) {
	const width = Math.max(1, Math.round(rect.w * scale));
	const height = Math.max(1, Math.round(rect.h * scale));
	const out = new Uint8ClampedArray(width * height * 4);
	const radians = (-degrees * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const cx = img.width / 2;
	const cy = img.height / 2;
	const src = img.data;
	const stride = img.width * 4;

	for (let y = 0; y < height; y++) {
		const ty = rect.y + (y + 0.5) / scale - 0.5 - cy;

		for (let x = 0; x < width; x++) {
			const tx = rect.x + (x + 0.5) / scale - 0.5 - cx;
			const sx = Math.min(img.width - 1.001, Math.max(0, cx + tx * cos - ty * sin));
			const sy = Math.min(img.height - 1.001, Math.max(0, cy + tx * sin + ty * cos));
			const x0 = Math.floor(sx);
			const y0 = Math.floor(sy);
			const fx = sx - x0;
			const fy = sy - y0;
			const i00 = y0 * stride + x0 * 4;
			const i10 = i00 + 4;
			const i01 = i00 + stride;
			const i11 = i01 + 4;
			const o = (y * width + x) * 4;

			for (let c = 0; c < 3; c++) {
				out[o + c] = (src[i00 + c] * (1 - fx) + src[i10 + c] * fx) * (1 - fy)
					+ (src[i01 + c] * (1 - fx) + src[i11 + c] * fx) * fy;
			}

			out[o + 3] = 255;
		}
	}

	return {data: out, height, width};
}

export function cropImage(img, {h, w, x, y}) {
	const data = new Uint8ClampedArray(w * h * 4);

	for (let row = 0; row < h; row++) {
		const from = ((y + row) * img.width + x) * 4;

		data.set(img.data.subarray(from, from + w * 4), row * w * 4);
	}

	return {data, height: h, width: w};
}

// The crops tried when the picture match of the box found is weak
// (js/scan/identify.js `variants`): the box moved up and down by a share
// of its height, and made a little smaller or larger. Eric's phone,
// 2026-10-03 (version 25): with the top edge worked out, the right card
// was 46 and 76 away while a clean image of the same card matched at a 65
// lead, and moving the box 3 and 6 % did not reach it. A top worked out
// from a wrong bottom is off by up to about a tenth of the card, and a side
// taken at the border's inner line (a silver border on a light table)
// makes the box about 7 % too small, which no move mends.
const shiftName = (share) => `moved ${share < 0 ? 'up' : 'down'} ${Math.round(Math.abs(share) * 100)} %`;
const SHIFTS = [-0.12, -0.09, -0.06, -0.03, 0.03, 0.06, 0.09, 0.12];
const ZOOMS = [[1.08, 0.5], [1.08, 1], [1.04, 1], [0.93, 0.5]];

// The moves as {how, share, zoom, anchor}: anchor is where along the box's
// height the resizing is held still (0.5 its middle, 1 its bottom edge).
const MOVES = [
	...SHIFTS.map((share) => ({anchor: 0.5, how: shiftName(share), share, zoom: 1})),
	...ZOOMS.map(([zoom, anchor]) => ({anchor, how: `${zoom > 1 ? 'larger' : 'smaller'} by ${Math.round(Math.abs(zoom - 1) * 100)} %${anchor === 1 ? ', from the bottom edge' : ''}`, share: 0, zoom})),
];

// A crop may run past the capture by this share of its height (the card's
// own margin), the cut repeating the capture's edge there.
const OVERRUN = 0.03;

// Returns {card, angle, found, note, rect, corners, ratio, others, cut,
// guessed, variants, variant}. `card` is the straightened crop when the
// edges were found and make a card-shaped box, otherwise the input (scaled
// to CARD_MAX_HEIGHT at most; found false, with the reason in `note`).
//
// guessed: 'top' when the top edge was worked out from the width (not
// found, or not where a card's shape puts it), 'bottom' when the box was
// too tall and snapped up from its bottom (the bottom may be the wrong
// edge), else null. variants: other crops worth fingerprinting when the
// picture match of `card` is weak (MOVES), each {how}; variant(v, height)
// cuts one. They are only cut when asked for (js/scan/identify.js), so a
// good capture pays nothing for them. others: boxes always fingerprinted
// beside `card`, each {how, rect} (rect.angle: its own turn, when it has
// one); cut(rect, height) cuts one.
export function rectify(img, {maxHeight = CARD_MAX_HEIGHT} = {}) {
	const scale = Math.min(1, WORK_HEIGHT / img.height);
	const level = greyCopy(img, scale);

	level.step = stepFor(level);
	let work = level;
	let angle = measureTilt(work);

	if (Math.abs(angle) >= 0.3) {
		work = rotateGrey(work, -angle);
	}
	else {
		angle = 0;
	}

	const edges = findEdges(work);

	// The lab's outermost edges, kept when they make a card whose sides run
	// straight; otherwise the best card-shaped four-sided box, which may
	// lean (a photo of a card on a screen, taken at a slant). findQuad takes
	// a lean of up to about 7 degrees itself, so a small tilt is looked for
	// on the copy as it is first, as before; a larger one on the copy turned
	// straight, its corners then turned back onto the capture.
	if (!plausible(work, edges)) {
		const tries = !angle ? [[work, 0]] : Math.abs(angle) < 4 ? [[level, 0], [work, angle]] : [[work, angle], [level, 0]];

		for (const [grid, turned] of tries) {
			const quad = findQuad(grid);

			if (!quad) {
				continue;
			}

			const top = quad.top || {p: quad.bottom.p - quad.w / CARD_RATIO, q: quad.bottom.q};
			const corners = [cross(quad.left, top), cross(quad.right, top), cross(quad.right, quad.bottom), cross(quad.left, quad.bottom)]
				.map((point) => unturn(point, turned, grid))
				.map((point) => ({x: point.x / scale, y: point.y / scale}));
			const across = Math.max(Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y), Math.hypot(corners[2].x - corners[3].x, corners[2].y - corners[3].y));
			const tall = Math.min(maxHeight, across / CARD_RATIO);
			const down = Math.max(Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y), Math.hypot(corners[2].x - corners[1].x, corners[2].y - corners[1].y));

			// Moving the box along the card's own sides by a share of its
			// height, and resizing it about a point on its middle line.
			const downX = (corners[3].x - corners[0].x + corners[2].x - corners[1].x) / 2;
			const downY = (corners[3].y - corners[0].y + corners[2].y - corners[1].y) / 2;
			const moved = ({anchor, share, zoom}) => {
				const cx = (corners[0].x + corners[1].x) / 2 + downX * anchor;
				const cy = (corners[0].y + corners[1].y) / 2 + downY * anchor;

				return corners.map((point) => ({x: cx + (point.x - cx) * zoom + downX * share, y: cy + (point.y - cy) * zoom + downY * share}));
			};
			const slack = down * OVERRUN;
			const inside = (points) => points.every((point) => point.x >= -slack && point.y >= -slack && point.x <= img.width + slack && point.y <= img.height + slack);
			const variants = MOVES.map((move) => ({corners: moved(move), how: move.how})).filter((v) => inside(v.corners));

			// The box of the outermost edges, when they were found but judged not
			// card-shaped: a silver border on a light table steps so little that
			// a sound box can fail the test, and the fingerprint then chooses.
			const others = [];

			if (edges.left !== null && edges.right !== null && edges.bottom !== null && edges.right - edges.left >= work.width * 0.45) {
				const w = (edges.right - edges.left) / scale;
				const h = w / CARD_RATIO;

				others.push({how: 'the outermost edges', rect: {angle, h: Math.round(h), w: Math.round(w), x: Math.round(edges.left / scale), y: Math.round(edges.bottom / scale - h)}});
			}

			return {
				angle: Math.round((turned + Math.atan(quad.bottom.q) * 180 / Math.PI) * 10) / 10,
				card: warpQuad(img, corners, Math.round(tall * CARD_RATIO), Math.round(tall)),
				corners,
				found: true,
				guessed: quad.top ? null : 'top',
				note: quad.top ? 'Card edges found, at a slant.' : 'Card edges found, at a slant; top edge worked out from the width.',
				others,
				ratio: Math.round((across / down) * 1000) / 1000,
				rect: null,
				cut: (r, height = Math.min(maxHeight, r.h)) => warpCrop(img, -(r.angle || 0), r, height / r.h),
				variant: (v, height = Math.round(tall)) => warpQuad(img, v.corners, Math.round(height * CARD_RATIO), Math.round(height)),
				variants,
			};
		}
	}

	const asIs = (note) => ({angle: 0, card: img.height > maxHeight ? warpCrop(img, 0, {h: img.height, w: img.width, x: 0, y: 0}, maxHeight / img.height) : img, found: false, guessed: null, note, rect: null, variants: []});

	if (edges.left === null || edges.right === null || edges.bottom === null) {
		return asIs('Card edges not found; read the frame as it is.');
	}

	const left = edges.left / scale;
	const right = edges.right / scale;
	const bottom = edges.bottom / scale;
	const width = right - left;
	let top = edges.top === null ? null : edges.top / scale;
	let note = 'Card edges found.';
	let guessed = null;
	const foundTop = top;

	if (width < img.width * 0.45) {
		return asIs('The edges found are too close together to be the card; read the frame as it is.');
	}

	// A top edge that does not give a card-shaped box (the card's top is
	// often cut off or lost in glare) is replaced by one worked out from the
	// width, measured up from the bottom edge, which matters more here.
	const expected = width / CARD_RATIO;
	let ratio = CARD_RATIO;
	const others = [];

	if (top === null || Math.abs((bottom - top) - expected) / expected > 0.06) {
		top = Math.max(0, bottom - expected);
		note = 'Card edges found; top edge worked out from the width.';
		guessed = 'top';
	}
	else {
		// The four edges found make a box within 6 % of a card's shape, but
		// a real card is exactly 63 by 88. A box a few percent too wide (on
		// Eric's phone 0.733 to 0.740 against 0.716) has either its top found
		// too low or a strip beside the card taken for part of it, and the
		// text boxes and the art box miss either way. The crop is snapped to
		// the card's shape keeping the width (the sides are the edges found
		// most surely), and when the box was too wide, the crops that keep
		// its height instead and trim the extra from the left, the right, or
		// both are kept as `others`, for the fingerprint to choose between
		// (js/scan/identify.js).
		ratio = width / (bottom - top);

		if (ratio > CARD_RATIO * 1.01) {
			const extra = width - (bottom - top) * CARD_RATIO;

			others.push({how: 'trim left', x: left + extra}, {how: 'trim right', x: left}, {how: 'trim both', x: left + extra / 2});
			others.forEach((other) => {
				other.rect = {h: Math.round(bottom - top), w: Math.round(width - extra), x: Math.round(other.x), y: Math.round(top)};
			});
		}

		if (Math.abs(ratio / CARD_RATIO - 1) > 0.01) {
			top = Math.max(0, bottom - expected);
			note = 'Card edges found; snapped to a card\'s shape.';

			// Too tall: snapping up from the bottom trusts the bottom edge,
			// which may be a line inside the card or the capture's own edge.
			if (ratio < CARD_RATIO) {
				guessed = 'bottom';
			}
		}
	}

	const rect = {
		h: Math.round(Math.min(img.height, bottom) - top),
		w: Math.round(width),
		x: Math.round(left),
		y: Math.round(top),
	};

	rect.w = Math.min(rect.w, img.width - rect.x);
	rect.h = Math.min(rect.h, img.height - rect.y);

	const out = Math.min(1, maxHeight / rect.h);

	// The crops to try when the picture match is weak (MOVES), and, when a
	// top edge was found but not used, the box hung from that top instead of
	// the bottom.
	const variants = [];
	const fits = (r) => r.y >= -r.h * OVERRUN && r.y + r.h <= img.height + r.h * OVERRUN && r.x >= -r.h * OVERRUN && r.x + r.w <= img.width + r.h * OVERRUN;

	if (guessed && foundTop !== null && Math.abs(foundTop - top) > rect.h * 0.015) {
		variants.push({how: 'hung from the top edge found', rect: {...rect, y: Math.round(foundTop)}});
	}

	for (const {anchor, how, share, zoom} of MOVES) {
		const w = rect.w * zoom;
		const h = rect.h * zoom;

		variants.push({how, rect: {h: Math.round(h), w: Math.round(w), x: Math.round(rect.x + (rect.w - w) / 2), y: Math.round(rect.y + (rect.h - h) * anchor + share * rect.h)}});
	}

	variants.splice(0, variants.length, ...variants.filter((v) => fits(v.rect)));

	return {
		angle: Math.round(angle * 10) / 10,
		card: warpCrop(img, -angle, rect, out),
		found: true,
		foundTop: foundTop === null ? null : Math.round(foundTop),
		guessed,
		note,
		// The width over the height of the box the edges made, before the
		// snap (a card is 0.716), for the scan report.
		ratio: Math.round(ratio * 1000) / 1000,
		rect,
		others: others.map(({how, rect: r}) => ({how, rect: r})),
		// Straightens another rect of the same capture (one of `others`), at
		// `height` pixels high.
		cut: (r, height = Math.min(maxHeight, r.h)) => warpCrop(img, -(r.angle ?? angle), r, height / r.h),
		variant: (v, height = Math.min(maxHeight, v.rect.h)) => warpCrop(img, -angle, v.rect, height / v.rect.h),
		variants,
	};
}

