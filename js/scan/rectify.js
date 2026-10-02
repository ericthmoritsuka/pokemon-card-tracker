// Finds the card inside a capture and cuts it out straight: lab/js/rectify.js
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

import {CARD_RATIO} from '../../lab/js/pipeline.js';

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

	for (let y = 0; y < height; y++) {
		const sy = Math.min(img.height - 1, Math.floor(y / scale));

		for (let x = 0; x < width; x++) {
			const sx = Math.min(img.width - 1, Math.floor(x / scale));
			const i = (sy * img.width + sx) * 4;

			grey[y * width + x] = (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3;
		}
	}

	return {grey, height, width};
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

function findEdges(work) {
	const {height, width} = work;
	const columns = profile(work, Math.round(height * 0.2), Math.round(height * 0.8));
	const rows = profile(work, Math.round(width * 0.2), Math.round(width * 0.8), true);

	return {
		bottom: outerEdge(rows, Math.round(height * 0.75), height, true),
		left: outerEdge(columns, 0, Math.round(width * 0.25), false),
		right: outerEdge(columns, Math.round(width * 0.75), width, true),
		top: outerEdge(rows, 0, Math.round(height * 0.25), false),
	};
}

// How much of a straight line at `index` (a column, or a row with
// `vertical`) is a sharp step, over the part of the other axis from..to: a
// card's edge steps all along it; text, buttons, and the screen around a
// card on a laptop do not. `slack`: how far off the line, either way, the
// step may be (a card turned a little leaves its edge a few pixels off a
// line straight across, towards its ends).
function continuity({grey, height, width}, index, from, to, vertical = false, slack = 1) {
	const length = vertical ? height : width;
	const d = 2;
	let on = 0;

	if (index - d - 1 < 0 || index + d + 1 >= length) {
		return 0;
	}

	for (let j = from; j < to; j++) {
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

		if (best > 18) {
			on++;
		}
	}

	return on / Math.max(1, to - from);
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
function edgeLine({grey, height, width}, index, vertical, reach) {
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

		return best > 12 ? at : null;
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
const coverage = (line, t0, t1) => line.ts.filter((t) => t >= t0 && t <= t1).length / Math.max(1, (t1 - t0) / 2);

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

		return Math.min(coverage(side, yBottom - h * 0.15, yBottom - h * 0.05), coverage(bottom, ...along));
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
				out.push(line);
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
		&& continuity(work, edges.bottom, Math.round(edges.left + w * 0.05), Math.round(edges.left + w * 0.15), true, slack) >= 0.5
		&& continuity(work, edges.bottom, Math.round(edges.right - w * 0.15), Math.round(edges.right - w * 0.05), true, slack) >= 0.5;
}

// The card's tilt in degrees, from where its left and right edges sit in the
// upper and the lower part of the image. Positive means turned clockwise.
function measureTilt(work) {
	const {height, width} = work;
	const upper = [Math.round(height * 0.15), Math.round(height * 0.45)];
	const lower = [Math.round(height * 0.55), Math.round(height * 0.85)];
	const rise = (lower[0] + lower[1] - upper[0] - upper[1]) / 2;
	const angles = [];

	for (const [start, end, fromEnd] of [[0, Math.round(width * 0.25), false], [Math.round(width * 0.75), width, true]]) {
		const top = outerEdge(profile(work, upper[0], upper[1]), start, end, fromEnd);
		const bottom = outerEdge(profile(work, lower[0], lower[1]), start, end, fromEnd);

		if (top !== null && bottom !== null) {
			angles.push((Math.atan2(top - bottom, rise) * 180) / Math.PI);
		}
	}

	if (!angles.length) {
		return 0;
	}

	// Two edges that disagree by more than a degree are not both the card's.
	if (angles.length === 2 && Math.abs(angles[0] - angles[1]) > 1) {
		return 0;
	}

	return angles.reduce((a, b) => a + b, 0) / angles.length;
}

// Turns a grey detection copy by `degrees`, like rotate below.
function rotateGrey(work, degrees) {
	const {grey, height, width} = work;
	const out = new Float32Array(width * height);
	const radians = (-degrees * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const cx = width / 2;
	const cy = height / 2;

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const dx = x - cx;
			const dy = y - cy;
			const sx = Math.min(width - 1, Math.max(0, Math.round(cx + dx * cos - dy * sin)));
			const sy = Math.min(height - 1, Math.max(0, Math.round(cy + dx * sin + dy * cos)));

			out[y * width + x] = grey[sy * width + sx];
		}
	}

	return {grey: out, height, width};
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

// Returns {card, angle, found, note, rect, corners}. `card` is the straightened crop
// when the edges were found and make a card-shaped box, otherwise the input
// (scaled to CARD_MAX_HEIGHT at most; found false, with the reason in
// `note`).
export function rectify(img, {maxHeight = CARD_MAX_HEIGHT} = {}) {
	const scale = Math.min(1, WORK_HEIGHT / img.height);
	let work = greyCopy(img, scale);
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
	// lean (a photo of a card on a screen, taken at a slant).
	if (!plausible(work, edges)) {
		const quad = findQuad(angle ? greyCopy(img, scale) : work);

		if (quad) {
			const top = quad.top || {p: quad.bottom.p - quad.w / CARD_RATIO, q: quad.bottom.q};

			const corners = [cross(quad.left, top), cross(quad.right, top), cross(quad.right, quad.bottom), cross(quad.left, quad.bottom)]
				.map((point) => ({x: point.x / scale, y: point.y / scale}));
			const across = Math.max(Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y), Math.hypot(corners[2].x - corners[3].x, corners[2].y - corners[3].y));
			const tall = Math.min(maxHeight, across / CARD_RATIO);

			return {
				angle: Math.round((Math.atan(quad.bottom.q) * 180 / Math.PI) * 10) / 10,
				card: warpQuad(img, corners, Math.round(tall * CARD_RATIO), Math.round(tall)),
				corners,
				found: true,
				note: quad.top ? 'Card edges found, at a slant.' : 'Card edges found, at a slant; top edge worked out from the width.',
				rect: null,
			};
		}
	}

	const asIs = (note) => ({angle: 0, card: img.height > maxHeight ? warpCrop(img, 0, {h: img.height, w: img.width, x: 0, y: 0}, maxHeight / img.height) : img, found: false, note, rect: null});

	if (edges.left === null || edges.right === null || edges.bottom === null) {
		return asIs('Card edges not found; read the frame as it is.');
	}

	const left = edges.left / scale;
	const right = edges.right / scale;
	const bottom = edges.bottom / scale;
	const width = right - left;
	let top = edges.top === null ? null : edges.top / scale;
	let note = 'Card edges found.';

	if (width < img.width * 0.45) {
		return asIs('The edges found are too close together to be the card; read the frame as it is.');
	}

	// A top edge that does not give a card-shaped box (the card's top is
	// often cut off or lost in glare) is replaced by one worked out from the
	// width, measured up from the bottom edge, which matters more here.
	const expected = width / CARD_RATIO;

	if (top === null || Math.abs((bottom - top) - expected) / expected > 0.06) {
		top = Math.max(0, bottom - expected);
		note = 'Card edges found; top edge worked out from the width.';
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

	return {angle: Math.round(angle * 10) / 10, card: warpCrop(img, -angle, rect, out), found: true, note, rect};
}
