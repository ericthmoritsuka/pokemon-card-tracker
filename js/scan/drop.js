// Holder mode's drop detector (Eric, 2026-10-09, version 36): the phone sits
// still in a stand over a box and cards are dropped in one by one, so the
// picture only changes when a card lands. A new card is told by what
// changed against the picture the last time it was still, not by finding
// four clean edges: the card on top of a pile has the silver border of the
// card beneath right against its own, a strip of the card beneath showing,
// or an edge in shadow, and version 35, which waited for a whole outline in
// one frame, missed drops and took the shutter.
//
// Pure functions over the grey copy of the view the frame loop already
// makes (camera.js viewFrame, FIND_SIDE pixels on its longer side), so Node
// tests them (tests/scan.test.mjs) and the replay of a real video runs the
// same code (lab/holder/replay.mjs).
//
// Each frame:
//
// - the view is averaged into CELL x CELL cells, and its motion is the mean
//   cell difference from the frame before, with the change of overall
//   brightness taken out (the camera re-exposing, a lamp flickering);
// - once the picture has been still for SETTLE_MS, it is compared with the
//   base, the cells of the last still picture, brightness matched: the
//   cells that changed by more than CHANGE are the change mask. Its largest
//   blob, after closing small gaps, is the new card when it is card-sized
//   and card-shaped (`drop`); anything else (a hand that passed and left
//   nothing, a shadow, the lamp moved) takes nothing, and says why;
// - the still picture becomes the base, every still frame, so the next card
//   is compared with the pile as it now lies, light drift never adds up, and
//   a card that lands while the loop was held up (a sheet opening, a slow
//   read) is still seen on the first still frame after it.
//
// A card landing in the very same place as the last is still a change: its
// picture differs from the card it covers. The same card dropped twice in
// the same place changes nothing and is not seen; in holder mode that is
// the only blind spot, and the shutter takes it.

import {ART, FACE, hamming, phash, THUMB_H, THUMB_W} from '../vision/fingerprint.js';

// Pixels of the view per cell.
export const CELL = 4;

// Mean cell difference from one frame to the next (0 to 255, brightness
// change taken out) above which the picture is moving. A still scene under
// a lamp measures under 1 (WhatsApp-compressed video of Eric's box, 1.5 at
// most); a card falling in measures 6 to 30.
export const MOTION = 2.5;

// Or when more than MOVE_SHARE of the cells changed by more than MOVE_CHANGE: a
// card's corner coming into the view (tests/scan-holder-browser.test.mjs:
// a card falling in from the top was judged on the frame it first showed).
export const MOVE_SHARE = 0.01;
export const MOVE_CHANGE = 40;

// How long the picture must stay still before it is compared with the base.
// A card dropped into Eric's box falls for 0.3 to 0.5 s and lies still
// within a frame or two of landing (video, 2026-10-09).
export const SETTLE_MS = 300;

// And for at least this many frames in a row: a phone too busy to show a
// new frame between two looks (or a test's canvas camera) repeats a frame
// of a card still in the air, which is not still.
export const SETTLE_FRAMES = 2;

// How long the picture must stay still before the first base is kept, when
// the detector starts or is reframed (the zoom changed): the camera may
// still be finding its focus.
export const BASE_MS = 1000;

// A cell changed when it differs from the base, brightness matched, by more
// than this (0 to 255).
export const CHANGE = 16;

// The blob is a new card when it covers at least this share of the view's
// cells, and the whole change at most DROP_MAX: a card dropped into the box
// covers 8 to 25 % of the view at 1x and 1.4x zoom in Eric's videos, and a
// card larger than the guide on a pile up to 90 % of a test scene's; the
// whole view changing is the phone moved or covered. A change far larger
// than the last card is the light (dropCapture, LIGHT_GROWTH).
export const DROP_MIN = 0.03;
export const DROP_MAX = 0.96;

// A card taken away (the box emptied, the top card lifted off) changes the
// picture too, but leaves plainer ground where it lay: the changed part is
// a card only when its detail (the spread of its cells) is at least
// REMOVED_DETAIL of what was there before, or DETAIL_MIN in itself.
const REMOVED_DETAIL = 0.6;
const DETAIL_MIN = 14;

// A change over most of the view (LIGHT_BLOB) whose fine structure is this
// alike to what was there (drop.js structureAlike) is the light, not a card:
// on Eric's video every card dropped measured 0.18 or less, the lamp moved
// from one side of the box to the other 0.71 over 85 % of the view. A card
// landing on the very spot of one with the same layout (border, text box,
// attack lines) can measure past 0.5 too, but over a card's part of the
// view only.
export const LIGHT_ALIKE = 0.5;
const LIGHT_BLOB = 0.6;

// A card's rectangle (63:88); the blob's rectangle must hold at least FILL
// of changed cells and be no flatter than FLAT (its short side over its
// long side), so a ring of shadow or a strip along a wall is not a card.
export const CARD_RATIO = 63 / 88;
const FILL = 0.45;
const FLAT = 0.5;

// The view averaged into CELL x CELL cells: {data, cw, ch}.
export function cells(grey, width, height, cell = CELL) {
	const cw = Math.floor(width / cell);
	const ch = Math.floor(height / cell);
	const data = new Float32Array(cw * ch);
	const scale = 1 / (cell * cell);

	for (let cy = 0; cy < ch; cy++) {
		for (let y = cy * cell; y < (cy + 1) * cell; y++) {
			const row = y * width;

			for (let cx = 0; cx < cw; cx++) {
				let sum = 0;

				for (let x = cx * cell; x < (cx + 1) * cell; x++) {
					sum += grey[row + x];
				}

				data[cy * cw + cx] += sum * scale;
			}
		}
	}

	return {ch, cw, data};
}

// The mean difference between two cell grids, the mean shift taken out.
export function cellMotion(a, b) {
	if (!a || !b || a.data.length !== b.data.length) {
		return 255;
	}

	const n = a.data.length;
	let shift = 0;

	for (let i = 0; i < n; i++) {
		shift += a.data[i] - b.data[i];
	}

	shift /= n;

	let sum = 0;

	for (let i = 0; i < n; i++) {
		sum += Math.abs(a.data[i] - b.data[i] - shift);
	}

	return sum / n;
}

// The share of cells that changed by more than `change` from one frame to
// the next, the mean shift taken out: a card coming in at the edge of the
// view moves few cells a lot, which the mean alone can miss.
export function movedShare(a, b, change = CHANGE) {
	if (!a || !b || a.data.length !== b.data.length) {
		return 1;
	}

	const n = a.data.length;
	let shift = 0;

	for (let i = 0; i < n; i++) {
		shift += a.data[i] - b.data[i];
	}

	shift /= n;

	let count = 0;

	for (let i = 0; i < n; i++) {
		if (Math.abs(a.data[i] - b.data[i] - shift) > change) {
			count++;
		}
	}

	return count / n;
}

// The brightness change from `base` to `now`: the commonest ratio of a
// cell's value now to its value before (in steps of GAIN_STEP), so the part
// that changed, a card covering most of the view included, does not skew
// it: the cells it did not cover all share one ratio.
const GAIN_STEP = 0.02;

export function gainOf(now, base) {
	const bins = new Uint32Array(Math.round(1.5 / GAIN_STEP) + 1);

	for (let i = 0; i < now.data.length; i++) {
		const before = base.data[i];

		if (before < 24) {
			continue;
		}

		const ratio = now.data[i] / before;

		if (ratio >= 0.5 && ratio <= 2) {
			bins[Math.round((ratio - 0.5) / GAIN_STEP)]++;
		}
	}

	let best = -1;
	let at = -1;

	for (let k = 0; k < bins.length; k++) {
		const count = bins[k] + (bins[k - 1] || 0) + (bins[k + 1] || 0);

		if (count > best) {
			best = count;
			at = k;
		}
	}

	return best > 0 ? 0.5 + at * GAIN_STEP : 1;
}

// The cells of `now` that changed from `base`, with the base's brightness
// scaled to now's (gainOf). Returns {mask (Uint8Array), share, gain}.
export function changeMask(now, base, change = CHANGE) {
	const n = now.data.length;
	const gain = gainOf(now, base);
	const mask = new Uint8Array(n);
	let count = 0;

	for (let i = 0; i < n; i++) {
		if (Math.abs(now.data[i] - base.data[i] * gain) > change) {
			mask[i] = 1;
			count++;
		}
	}

	return {gain, mask, share: count / n};
}

// A 3 x 3 dilation (grow) or erosion (shrink) of a mask.
function morph(mask, cw, ch, grow) {
	const out = new Uint8Array(mask.length);

	for (let y = 0; y < ch; y++) {
		for (let x = 0; x < cw; x++) {
			let hit = grow ? 0 : 1;

			for (let dy = -1; dy <= 1 && hit === (grow ? 0 : 1); dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const xx = x + dx;
					const yy = y + dy;
					const v = xx >= 0 && yy >= 0 && xx < cw && yy < ch ? mask[yy * cw + xx] : 0;

					if (grow ? v : !v) {
						hit = grow ? 1 : 0;
						break;
					}
				}
			}

			out[y * cw + x] = hit;
		}
	}

	return out;
}

// The largest 4-connected blob of a mask, after closing gaps of a cell or
// two (a card's plain border, which changes little, between its art and
// its edge). Returns the list of its cell indexes.
export function largestBlob(mask, cw, ch) {
	const closed = morph(morph(mask, cw, ch, true), cw, ch, false);
	const seen = new Uint8Array(closed.length);
	let best = [];

	for (let start = 0; start < closed.length; start++) {
		if (!closed[start] || seen[start]) {
			continue;
		}

		const blob = [start];

		seen[start] = 1;

		for (let k = 0; k < blob.length; k++) {
			const i = blob[k];
			const x = i % cw;
			const next = [x > 0 ? i - 1 : -1, x < cw - 1 ? i + 1 : -1, i - cw, i + cw];

			for (const j of next) {
				if (j >= 0 && j < closed.length && closed[j] && !seen[j]) {
					seen[j] = 1;
					blob.push(j);
				}
			}
		}

		if (blob.length > best.length) {
			best = blob;
		}
	}

	return best;
}

const DEG = Math.PI / 180;

// The rectangle round a set of points with the least area over turns of up
// to `turn` degrees either way (a card dropped in lands nearly straight),
// its extents taken past the outermost `trim` of points on each side, so a
// stray cell does not stretch it. Returns {cx, cy, w, h, angle} (angle in
// degrees, w across and h down once turned back).
export function boundingRect(points, {trim = 0.01, turn = 30} = {}) {
	let best = null;

	for (let deg = -turn; deg <= turn; deg += 1) {
		const c = Math.cos(deg * DEG);
		const s = Math.sin(deg * DEG);
		const us = new Float32Array(points.length);
		const vs = new Float32Array(points.length);

		points.forEach(([x, y], i) => {
			us[i] = x * c + y * s;
			vs[i] = -x * s + y * c;
		});
		us.sort();
		vs.sort();

		const lo = Math.floor(points.length * trim);
		const hi = points.length - 1 - lo;
		const w = us[hi] - us[lo];
		const h = vs[hi] - vs[lo];

		if (!best || w * h < best.w * best.h - 1e-6) {
			const mu = (us[hi] + us[lo]) / 2;
			const mv = (vs[hi] + vs[lo]) / 2;

			best = {angle: deg, cx: mu * c - mv * s, cy: mu * s + mv * c, h, w};
		}
	}

	return best;
}

// The four corners (top left, top right, bottom right, bottom left) of a
// turned rectangle.
export function rectCorners({angle, cx, cy, h, w}) {
	const c = Math.cos(angle * DEG);
	const s = Math.sin(angle * DEG);
	const at = (u, v) => ({x: cx + u * c - v * s, y: cy + u * s + v * c});

	return [at(-w / 2, -h / 2), at(w / 2, -h / 2), at(w / 2, h / 2), at(-w / 2, h / 2)];
}

// The card's rectangles a blob's rectangle can stand for, snapped to 63:88,
// the likeliest first: a blob a card's shape grown to it; one too tall (a
// strip of the card beneath moved too, or its shadow) cut to a card from
// its top and from its bottom; one too wide cut from either side; and the
// blob grown on its short side, for a card whose plain border did not
// change (the same silver border on the card beneath).
export function cardRects(rect) {
	const {h, w} = rect;
	const upright = h >= w;
	const long = upright ? h : w;
	const short = upright ? w : h;
	const ratio = short / long;
	const out = [];
	const along = (shift) => {
		const c = Math.cos(rect.angle * DEG);
		const s = Math.sin(rect.angle * DEG);

		return upright ? {cx: rect.cx - shift * s, cy: rect.cy + shift * c} : {cx: rect.cx + shift * c, cy: rect.cy + shift * s};
	};
	const make = (l, sh, shift = 0) => ({...rect, ...along(shift), h: upright ? l : sh, w: upright ? sh : l});

	// A card standing up whose picture changed but whose text box did not (two
	// cards of one type share their colours and layout below the picture),
	// grown from the blob: the blob as the art box (ART, as fingerprint.js
	// has it), or as the card's top.
	const standing = () => {
		const c = Math.cos(rect.angle * DEG);
		const s = Math.sin(rect.angle * DEG);
		const down = (v, cw) => ({...rect, cx: rect.cx - v * s, cy: rect.cy + v * c, h: cw / CARD_RATIO, w: cw});
		const art = w / ART_W;

		return [down((0.5 - ART_TOP - ART_H / 2) * (art / CARD_RATIO), art), down((w / CARD_RATIO - h) / 2, w)];
	};

	if (!upright) {
		out.push(...standing());
	}

	if (ratio < CARD_RATIO) {
		// Too long for its width: the width is the card's, or the card's
		// border did not change on its long sides.
		const l = short / CARD_RATIO;

		if (long - l > long * 0.04) {
			out.push(make(l, short, -(long - l) / 2), make(l, short, (long - l) / 2));
		}

		out.push(make(long, long * CARD_RATIO));
	}
	else {
		// Too wide for its length: the length is the card's, or its ends did
		// not change.
		const sh = long * CARD_RATIO;

		out.push(make(long, sh), make(short / CARD_RATIO, short));
	}

	if (upright && ratio > 0.85) {
		out.push(...standing());
	}

	return out;
}

// The art box on a card, as shares of its width and height (fingerprint.js
// ART).
const ART_W = 0.84;
const ART_H = 0.41;
const ART_TOP = 0.11;

// Sharpness of a part of the grey view: the variance of its Laplacian (a
// relative measure: blur lowers it, so the frames of one card can be
// compared). box: {x, y, w, h} in view pixels.
export function sharpness(grey, width, height, box) {
	const x0 = Math.max(1, Math.floor(box.x));
	const y0 = Math.max(1, Math.floor(box.y));
	const x1 = Math.min(width - 1, Math.ceil(box.x + box.w));
	const y1 = Math.min(height - 1, Math.ceil(box.y + box.h));
	let sum = 0;
	let sq = 0;
	let n = 0;

	for (let y = y0; y < y1; y++) {
		for (let x = x0; x < x1; x++) {
			const i = y * width + x;
			const l = 4 * grey[i] - grey[i - 1] - grey[i + 1] - grey[i - width] - grey[i + width];

			sum += l;
			sq += l * l;
			n++;
		}
	}

	return n ? sq / n - (sum / n) ** 2 : 0;
}

// A still picture can still be soft (the camera refocusing on a pile grown
// taller): a drop whose card is less than SHARP_FLOOR as sharp as the
// median of the last few cards taken waits up to SHARP_WAIT_MS for a
// sharper frame, and is taken anyway after that. recent: those cards'
// sharpness; with fewer than three there is nothing to go by.
export const SHARP_FLOOR = 0.45;
export const SHARP_WAIT_MS = 400;

export function sharpEnough(value, recent, floor = SHARP_FLOOR) {
	if (!recent || recent.length < 3) {
		return true;
	}

	const sorted = [...recent].sort((a, b) => a - b);

	return value >= sorted[sorted.length >> 1] * floor;
}

// The box round some points: {x, y, w, h}.
export function boxOf(points) {
	const xs = points.map((p) => p.x);
	const ys = points.map((p) => p.y);
	const x = Math.min(...xs);
	const y = Math.min(...ys);

	return {h: Math.max(...ys) - y, w: Math.max(...xs) - x, x, y};
}

// How alike the fine structure of two cell grids is over some cells: the
// correlation of each cell less the mean of its 3 x 3 neighbours. A lamp
// moved over the box changes how bright everything is but leaves its edges
// where they were (near 1); a new card brings edges of its own (near 0).
export function structureAlike(now, base, ids) {
	const {ch, cw} = now;
	const detail = (data, i) => {
		const x = i % cw;
		const y = (i - x) / cw;
		let sum = 0;
		let n = 0;

		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				const xx = x + dx;
				const yy = y + dy;

				if (xx >= 0 && yy >= 0 && xx < cw && yy < ch) {
					sum += data[yy * cw + xx];
					n++;
				}
			}
		}

		return data[i] - sum / n;
	};
	let sa = 0;
	let sb = 0;
	let saa = 0;
	let sbb = 0;
	let sab = 0;

	for (const i of ids) {
		const a = detail(now.data, i);
		const b = detail(base.data, i);

		sa += a;
		sb += b;
		saa += a * a;
		sbb += b * b;
		sab += a * b;
	}

	const n = Math.max(1, ids.length);
	const cov = sab / n - (sa / n) * (sb / n);
	const va = saa / n - (sa / n) ** 2;
	const vb = sbb / n - (sb / n) ** 2;

	return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}

// The standard deviation of some cells' values.
function spread(data, ids) {
	let sum = 0;
	let sq = 0;

	for (const i of ids) {
		sum += data[i];
		sq += data[i] * data[i];
	}

	const mean = sum / Math.max(1, ids.length);

	return Math.sqrt(Math.max(0, sq / Math.max(1, ids.length) - mean * mean));
}

// What a still picture's change against the base says: {kind, share, ...}.
// kind 'drop' (a new card: rect, corners, others in view pixels, the blob's
// share of the view, its fill), 'none' (nothing changed to speak of: a
// hand passed and left nothing), 'small' (a change too small for a card),
// 'removed' (a card taken away: plainer ground where it lay), 'light' (the
// same edges, lit another way),
// 'large' (most of the view changed: the light, or the phone), or 'shape'
// (a change that is no card's shape: a shadow, a strip).
export function judgeChange(now, base, {cell = CELL, change = CHANGE, dropMax = DROP_MAX, dropMin = DROP_MIN} = {}) {
	const {gain, mask, share} = changeMask(now, base, change);
	const {ch, cw} = now;
	const total = cw * ch;

	if (share < dropMin * 0.5) {
		return {gain, kind: 'none', share};
	}

	if (share > dropMax) {
		return {gain, kind: 'large', share};
	}

	const blob = largestBlob(mask, cw, ch);
	const blobShare = blob.length / total;

	if (blobShare < dropMin) {
		return {blob: blobShare, gain, kind: 'small', share};
	}

	const points = blob.map((i) => [(i % cw + 0.5) * cell, (Math.floor(i / cw) + 0.5) * cell]);
	const rect = boundingRect(points);
	const fill = blob.length / Math.max(1, (rect.w / cell + 1) * (rect.h / cell + 1));
	const flat = Math.min(rect.w, rect.h) / Math.max(rect.w, rect.h, 1);

	if (fill < FILL || flat < FLAT) {
		return {blob: blobShare, fill, flat, gain, kind: 'shape', rect, share};
	}

	const alike = structureAlike(now, base, blob);
	if (alike > LIGHT_ALIKE && blobShare > LIGHT_BLOB) {
		return {alike, blob: blobShare, gain, kind: 'light', rect, share};
	}

	const detailNow = spread(now.data, blob);
	const detailBefore = spread(base.data, blob) * gain;

	if (detailNow < DETAIL_MIN && detailNow < detailBefore * REMOVED_DETAIL) {
		return {blob: blobShare, detail: Math.round(detailNow), gain, kind: 'removed', rect, share};
	}

	const rects = cardRects(rect);

	return {
		alike: Math.round(alike * 100) / 100,
		blob: blobShare,
		corners: rectCorners(rects[0]),
		// The share of the card's rectangle that changed: a card come down on
		// the last one covers most of it; the last card nudged changes only
		// strips along its edges.
		cover: Math.min(1, (blob.length * cell * cell) / Math.max(1, rects[0].w * rects[0].h)),
		fill,
		gain,
		kind: 'drop',
		others: rects.slice(1).map(rectCorners),
		rect,
		share,
	};
}

// The detector. push(view, at) takes the grey view ({grey, width, height})
// and the time in milliseconds, and returns {moving, still (ms since the
// picture last moved), change (judgeChange's answer, on a still frame that
// was compared), drop (true when that answer is a new card)}. reframe()
// forgets the base (the zoom changed, the camera restarted): the next still
// picture becomes the base and takes nothing. pause() and resume() hold
// it; a card that lands meanwhile is still told on the first still frame
// after resume, because the base is kept.
export function createDropDetector({motion = MOTION, moveShare = MOVE_SHARE, settleMs = SETTLE_MS, ...judge} = {}) {
	let previous = null;
	let base = null;
	let lastMotion = -Infinity;
	let paused = false;
	let burst = null;
	let startedAt = null;
	let stillFrames = 0;

	return {
		get base() {
			return base;
		},
		pause() {
			paused = true;
		},
		push(view, at) {
			const now = cells(view.grey, view.width, view.height, judge.cell || CELL);

			// The view changed size (the screen laid out again): start over.
			if (previous && (previous.cw !== now.cw || previous.ch !== now.ch)) {
				previous = null;
				base = null;
				startedAt = null;
			}

			const moved = previous ? cellMotion(now, previous) : 0;
			const spread = previous ? movedShare(now, previous, MOVE_CHANGE) : 0;

			previous = now;

			if (moved > motion || spread > moveShare) {
				lastMotion = at;
				stillFrames = 0;
				burst = burst ? {...burst, frames: burst.frames + 1, peak: Math.max(burst.peak, moved)} : {frames: 1, peak: moved, start: at};

				return {drop: false, motion: moved, moving: true, still: 0};
			}

			const still = at - lastMotion;

			stillFrames++;

			if (still < settleMs || stillFrames < SETTLE_FRAMES || paused) {
				return {drop: false, motion: moved, moving: false, still};
			}

			if (!base) {
				// After a reframe the camera may still be finding its focus and
				// exposure: the base waits for BASE_MS of stillness.
				if (startedAt === null) {
					startedAt = at;
				}

				if (at - Math.max(lastMotion, startedAt) >= Math.max(settleMs, BASE_MS)) {
					base = now;
					burst = null;
				}

				return {drop: false, motion: moved, moving: false, still};
			}

			const change = judgeChange(now, base, judge);
			const seen = burst;

			// Every still frame becomes the base: the next card is compared
			// with the pile as it lies now.
			base = now;
			burst = null;

			return {burst: seen, change, drop: change.kind === 'drop', motion: moved, moving: false, still, stillFrames};
		},
		reframe() {
			previous = null;
			base = null;
			burst = null;
			lastMotion = -Infinity;
			startedAt = null;
			stillFrames = 0;
		},
		resume() {
			paused = false;
		},
	};
}

// ------------------------------------------------------------ the capture

// How much two boxes overlap: their shared area over their joint area.
export function overlap(a, b) {
	if (!a || !b) {
		return 0;
	}

	const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
	const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

	return (w * h) / Math.max(1, a.w * a.h + b.w * b.h - w * h);
}

// The share of box a that lies inside box b.
export function inside(a, b) {
	const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
	const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

	return (w * h) / Math.max(1, a.w * a.h);
}

// A change whose box is this many times the largest card taken since the
// zoom last changed is no card (the caller forgets the last card then).
export const LIGHT_GROWTH = 2.2;

// A drop whose change was this alike to what was there, or this large a
// share of the view, was partly the light: its box is not the card's.
const TRUSTED_ALIKE = 0.3;
const TRUSTED_BLOB = 0.6;

// The card to pass as `last` after a capture: its box, and the largest card
// area seen since the last was forgotten (a change that was only a card's
// picture gives a box smaller than the card).
// A box more than twice the size before, or from a change that was partly
// the light (dropCapture's card.trusted false: a drop judged while the lamp
// was moving takes in the floor round the card), is not kept as where the
// card lies, and does not grow the size.
export function takenCard(last, card) {
	const area = card.box.w * card.box.h;
	const before = last && last.area ? last.area : 0;

	if (!card.trusted || (before && area > before * 2)) {
		return last ? {...last, box: null} : null;
	}

	return {...card, area: Math.max(before, area)};
}

// A card's rectangle reaching this share of the frame's shorter side past
// its edge, from a change touching the view's edge, runs off the frame.
const OFF_FRAME = 0.04;

// An outline found on the finer copy (steady.js findCard) is the new card
// when it lies over the change this much.
const AGREE = 0.5;

// The part of the frame cut round the card: its box plus this share of its
// size on every side (camera.js CAPTURE_PAD).
const PAD = 0.1;

// The capture for a drop (judgeChange kind 'drop'): view is the grey view
// it was judged on, fine the finer copy at the moment of capture, both
// camera.js viewFrame answers ({grey, width, height, rect, scale}); found
// what steady.js findCard found on fine (or null); frame the camera
// frame's {width, height}; last the card taken before ({box} in frame
// pixels), or null.
//
// Returns {skip: 'off the frame'} for a card running off the frame,
// {skip: 'light'} for a change far larger than the last card, or {card,
// quads, region, sharpness, agree}: region the part of the frame to grab, quads
// the card's candidate outlines in its pixels for identify.js (the
// outlines findCard found over the change first, then the change's own
// rectangle snapped to a card, then that rectangle cut the other ways
// cardRects gives), card the change's card in frame pixels, sharpness that
// of the view where it changed, agree how many found outlines agreed.
//
// Whether it is a new card is not told here (version 40): up to version 39
// a change inside the last card's box and smaller than a quarter of it was
// the last card nudged ('moved'), and on Eric's v38 log that skipped a real
// card that landed on the last one's spot with only its picture changed
// (20:17:21, a tenth of the view, 29 % of the card), leaving the scanner
// idle for 75 s. The card's picture tells it instead (contentCheck).
export function dropCapture(change, view, fine, found, {frame, last = null} = {}) {
	const toFrame = (v) => (p) => ({x: v.rect.x + p.x / v.scale, y: v.rect.y + p.y / v.scale});
	// A card running off the camera's frame (not only the part of it on the
	// screen, which is smaller): the pile has grown into the lens, or the
	// card landed half outside the box's floor. Nothing whole to take.
	const card = change.corners.map(toFrame(view));
	const cardBox = boxOf(card);
	const edge = CELL * 1.5;
	const touches = rectCorners(change.rect).some((p) => p.x < edge || p.y < edge || p.x > view.width - edge || p.y > view.height - edge);
	const tolerance = OFF_FRAME * Math.min(frame.width, frame.height);
	const outside = (p) => p.x < -tolerance || p.y < -tolerance || p.x > frame.width + tolerance || p.y > frame.height + tolerance;

	if (touches && [change.corners, ...(change.others || [])].every((corners) => corners.map(toFrame(view)).some(outside))) {
		return {skip: 'off the frame'};
	}

	const blobBox = boxOf(rectCorners(change.rect).map(toFrame(view)));

	// A change far larger than the last card is the light moved over the
	// box, not a card (Eric's video: the lamp moved from one side to the
	// other changed the whole floor round the card on top).
	if (last && last.area && blobBox.w * blobBox.h > last.area * LIGHT_GROWTH) {
		return {skip: 'light'};
	}

	return planCapture(card, (change.others || []).map((corners) => corners.map(toFrame(view))), view, fine, found, {
		blobBox,
		frame,
		sharpBox: boxOf(change.corners),
		trusted: (change.alike ?? 0) < TRUSTED_ALIKE && change.blob < TRUSTED_BLOB,
	});
}

// The capture round a card: card its corners in frame pixels, others the
// other rectangles it may be (frame pixels), view and fine the views (as
// dropCapture has them), found what steady.js findCard found on fine;
// blobBox the box of what changed (frame pixels), sharpBox where to measure
// the sharpness (view pixels), trusted whether the card's box is where the
// card lies (takenCard). Returns {agree, card, quads, region, sharpness}
// as dropCapture does, and blob, blobBox.
export function planCapture(card, others, view, fine, found, {blobBox = boxOf(card), frame, sharpBox, trusted = true}) {
	const toFrame = (v) => (p) => ({x: v.rect.x + p.x / v.scale, y: v.rect.y + p.y / v.scale});
	const cardBox = boxOf(card);
	// An outline agrees when it lies over the change's card, or holds the
	// whole blob and is not much larger than a card round it (the blob was
	// only the card's picture).
	const holds = (box) => inside(blobBox, box) >= 0.85 && box.w * box.h <= blobBox.w * blobBox.h * 4;
	const outlines = found && found.quad ? [{corners: found.quad, upright: found.upright}, ...(found.others || [])] : [];
	const agree = outlines
		.map((one) => ({corners: one.corners.map(toFrame(fine)), upright: one.upright !== false}))
		.filter((one) => overlap(boxOf(one.corners), cardBox) >= AGREE || holds(boxOf(one.corners)));
	const own = [card, ...others].map((corners) => {
		const box = boxOf(corners);

		// A rectangle lying on its side starts at the corner that is the top
		// left once turned a quarter clockwise, and is cut both ways.
		return box.w > box.h ? {corners: [corners[3], corners[0], corners[1], corners[2]], upright: false} : {corners, upright: true};
	});
	const quads = [...agree.slice(0, 3), ...own];
	const all = boxOf(quads.flatMap((q) => q.corners));
	const px = all.w * PAD;
	const py = all.h * PAD;
	const x = Math.max(0, Math.floor(all.x - px));
	const y = Math.max(0, Math.floor(all.y - py));
	const region = {h: Math.min(frame.height, Math.ceil(all.y + all.h + py)) - y, w: Math.min(frame.width, Math.ceil(all.x + all.w + px)) - x, x, y};

	return {
		agree: agree.length,
		blob: blobBox,
		card: {box: cardBox, corners: card, trusted},
		quads: quads.map((q) => ({corners: q.corners.map((c) => ({x: c.x - region.x, y: c.y - region.y})), upright: q.upright})),
		region,
		sharpness: Math.round(sharpness(view.grey, view.width, view.height, sharpBox)),
	};
}

// ------------------------------------------------------------ the content check

// A new card means a new picture (Eric, 2026-10-16): what changed in the
// grey view says where to look, but whether the card there is a new one is
// told by its picture, as the matcher hashes it (js/vision/fingerprint.js:
// the art box and the whole face, a DCT hash each, from the card
// straightened). Two different cards of one set share their layout and
// often their colours, so the coarse difference of the grey cells misses
// them (60 of 90 different consecutive cards in Eric's logs differ by 20
// or less there), and the last card nudged and a new card landing on its
// very spot can change the same few cells; their pictures never agree.

// The card in a quad of a grey view (corners top left, top right, bottom
// right, bottom left, in its pixels), straightened into the fingerprint's
// thumbnail (fingerprint.js THUMB_W x THUMB_H, its rgb grey in all three),
// each cell the mean of 2 x 2 bilinear samples. The quad is mapped
// bilinearly, which for a card seen from above is its perspective within
// a pixel.
export function cardThumb(grey, width, height, corners) {
	const [tl, tr, br, bl] = corners;
	const tw = THUMB_W;
	const th = THUMB_H;
	const rgb = new Float32Array(tw * th * 3);
	const S = 2;
	const at = (x, y) => {
		const cx = Math.min(width - 1.001, Math.max(0, x));
		const cy = Math.min(height - 1.001, Math.max(0, y));
		const x0 = Math.floor(cx);
		const y0 = Math.floor(cy);
		const fx = cx - x0;
		const fy = cy - y0;
		const i = y0 * width + x0;
		const top = grey[i] + (grey[i + 1] - grey[i]) * fx;
		const bottom = grey[i + width] + (grey[i + width + 1] - grey[i + width]) * fx;

		return top + (bottom - top) * fy;
	};

	for (let v = 0; v < th; v++) {
		for (let u = 0; u < tw; u++) {
			let sum = 0;

			for (let j = 0; j < S; j++) {
				const b = (v + (j + 0.5) / S) / th;

				for (let k = 0; k < S; k++) {
					const a = (u + (k + 0.5) / S) / tw;
					const x = (1 - b) * ((1 - a) * tl.x + a * tr.x) + b * ((1 - a) * bl.x + a * br.x);
					const y = (1 - b) * ((1 - a) * tl.y + a * tr.y) + b * ((1 - a) * bl.y + a * br.y);

					sum += at(x, y);
				}
			}

			const o = (v * tw + u) * 3;
			const value = sum / (S * S);

			rgb[o] = value;
			rgb[o + 1] = value;
			rgb[o + 2] = value;
		}
	}

	return {h: th, rgb, w: tw};
}

// A card's print: the 64-bit hashes of its art box and its face, as the
// index stores them (fingerprint.js ART, FACE), from a grey view.
export function printOf(grey, width, height, corners) {
	const thumb = cardThumb(grey, width, height, corners);

	return {art: phash(thumb, ART, 64), face: phash(thumb, FACE, 64)};
}

// How far apart two prints are: the bits that differ, art and face
// together (0 to 128; two unrelated pictures differ by about 64).
export function printDistance(a, b) {
	return a && b ? hamming(a.art, b.art) + hamming(a.face, b.face) : 128;
}

// Two prints this close or closer are the same card (the same print, or a
// second copy of it); this far apart or farther, two different cards.
// Between them nothing is told. Measured on Eric's v38 holder log and his
// two videos of 2026-10-09 (lab/holder/replay-log.mjs and replay.mjs, the
// views the scanner watches, 262 to 360 px): two different cards one on the
// other 36 to 62 apart in the log and 24 to 62 on the videos (24: a Litleo
// landing square on a Darmanitan, both orange Fire cards, art 14 and face
// 10), the same card settling after it was taken 12 (art 6, face 6), and on
// the browser tests' canvas a card nudged 12 and dropped again 10.
export const SAME_PRINT = 16;
export const NEW_PRINT = 24;

// The closest of some candidate quads' prints to `print`: {distance,
// index, print}.
export function closestPrint(grey, width, height, quads, print) {
	let best = {distance: 128, index: -1, print: null};

	quads.forEach((corners, index) => {
		const mine = printOf(grey, width, height, corners);
		const distance = printDistance(mine, print);

		if (distance < best.distance || best.index < 0) {
			best = {distance, index, print: mine};
		}
	});

	return best;
}

// How many of a capture's candidate quads (planCapture quads, the outlines
// found first) are printed for the check.
const CONTENT_QUADS = 4;

// The quads of a plan in the fine view's pixels.
export function planQuads(plan, fine, count = CONTENT_QUADS) {
	const toFine = (c) => ({x: (c.x + plan.region.x - fine.rect.x) * fine.scale, y: (c.y + plan.region.y - fine.rect.y) * fine.scale});

	return plan.quads.slice(0, count).map((q) => q.corners.map(toFine));
}

// Frame pixels to a view's, and back.
export const toView = (v) => (p) => ({x: (p.x - v.rect.x) * v.scale, y: (p.y - v.rect.y) * v.scale});
export const fromView = (v) => (p) => ({x: v.rect.x + p.x / v.scale, y: v.rect.y + p.y / v.scale});

// Whether the card a capture would take is a new one, by its picture:
// plan a planCapture answer, fine the finer view it was planned on, last
// the card taken before ({print, quad}, or null). The plan's candidate
// quads are printed on fine, and, when what changed lies inside where the
// last card lay (LAST_INSIDE of it), so is that place: a change that is
// only part of a card (the same card dropped again changes little but its
// edges, and no outline may be found round it) gives quads that are no
// card, whose prints match nothing (that place counts only as close as
// SAME_THERE). The closest to the last card's print decides: 'same' (SAME_PRINT or closer: the last card, nudged or dropped
// again), 'new' (NEW_PRINT or farther, or no card before), or 'unsure'.
// Returns {verdict, distance (null with no card before), print, quad,
// match, there}: print and quad (frame pixels) are the plan's first quad's,
// what the next check compares with when the card is new; match the
// closest candidate's ({print, quad}), where the last card now lies when it
// is the same; there the distance at the last card's place, or null.
const LAST_INSIDE = 0.8;

export function contentCheck(plan, fine, last) {
	const quads = planQuads(plan, fine);
	const print = printOf(fine.grey, fine.width, fine.height, quads[0]);
	const quad = plan.quads[0].corners.map((c) => ({x: c.x + plan.region.x, y: c.y + plan.region.y}));

	if (!last || !last.print) {
		return {distance: null, print, quad, verdict: 'new'};
	}

	const best = closestPrint(fine.grey, fine.width, fine.height, quads, last.print);
	const {distance} = best;
	const there = last.quad && plan.blob && inside(plan.blob, boxOf(last.quad)) >= LAST_INSIDE ? printDistance(printOf(fine.grey, fine.width, fine.height, last.quad.map(toView(fine))), last.print) : null;

	if (distance > SAME_PRINT && there !== null && there <= SAME_THERE) {
		return {distance: there, match: {print: last.print, quad: last.quad}, print, quad, there, verdict: 'same'};
	}

	// The candidate closest to the last card: where that card lies now, when
	// it is the same (nudged), for the next check.
	const match = {print: best.print, quad: plan.quads[best.index].corners.map((c) => ({x: c.x + plan.region.x, y: c.y + plan.region.y}))};

	return {distance, match, print, quad, there, verdict: distance <= SAME_PRINT ? 'same' : distance >= NEW_PRINT ? 'new' : 'unsure'};
}

// The last card's place counts as showing it still only this close: a new
// card covering part of it moves its print part of the way (Eric's first
// video, 2026-10-09: 24 for a card landing over the top half of the last).
export const SAME_THERE = 12;

// The same check where the last card lay (last.quad, frame pixels), for a
// still picture after a disturbance whose change was no card's (judgeChange
// none, small, or shape): a card landing on the very spot of the last with
// the same layout and colours changes too few cells to make a card's
// shape, but never the same picture. Returns {distance, verdict} as
// contentCheck does; null with no card before.
export function contentAt(last, fine) {
	if (!last || !last.print || !last.quad) {
		return null;
	}

	const distance = printDistance(printOf(fine.grey, fine.width, fine.height, last.quad.map(toView(fine))), last.print);

	return {distance, verdict: distance <= SAME_PRINT ? 'same' : distance >= NEW_PRINT ? 'new' : 'unsure'};
}

// A disturbance like a drop's: the picture moved for at least
// DISTURB_FRAMES looks of the frame loop, as much as DISTURB_PEAK at its
// most (a card falling into Eric's box moved 5.8 to 29 in his v38 log, for
// 0.3 to 0.5 s). The same card found after one is asked about (a second
// copy dropped in, view.js askRepeat); after a smaller one (the last card
// nudged, the box knocked) nothing is.
export const DISTURB_FRAMES = 2;
export const DISTURB_PEAK = 5;

export const disturbedBy = (burst) => Boolean(burst && burst.frames >= DISTURB_FRAMES && burst.peak >= DISTURB_PEAK);

// The repeat bar is for a disturbance that starts REPEAT_GAP_MS or more
// after the last card was taken (last.at, the same clock as the burst's):
// a card still settling after it was taken (Eric's first video: a bounce
// 0.3 s after the capture, the same picture, 4 looks moving at 8.2) asks
// nothing, and nobody drops a second copy that fast (his fastest rhythm
// was a card every 1.5 s).
export const REPEAT_GAP_MS = 800;

export const asksRepeat = (burst, last) => disturbedBy(burst) && !(last && typeof last.at === 'number' && burst.start - last.at < REPEAT_GAP_MS);
