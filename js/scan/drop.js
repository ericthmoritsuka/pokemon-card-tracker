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

// Pixels of the view per cell.
export const CELL = 4;

// Mean cell difference from one frame to the next (0 to 255, brightness
// change taken out) above which the picture is moving. A still scene under
// a lamp measures under 1 (WhatsApp-compressed video of Eric's box, 1.5 at
// most); a card falling in measures 6 to 30.
export const MOTION = 2.5;

// How long the picture must stay still before it is compared with the base.
// A card dropped into Eric's box falls for 0.3 to 0.5 s and lies still
// within a frame or two of landing (video, 2026-10-09).
export const SETTLE_MS = 300;

// How long the picture must stay still before the first base is kept, when
// the detector starts or is reframed (the zoom changed): the camera may
// still be finding its focus.
export const BASE_MS = 1000;

// A cell changed when it differs from the base, brightness matched, by more
// than this (0 to 255).
export const CHANGE = 16;

// The blob is a new card when it covers at least this share of the view's
// cells, and at most DROP_MAX: a card dropped into the box covers 8 to 25 %
// of the view at 1x and 1.4x zoom; the whole view changing is the light, or
// the phone moved.
export const DROP_MIN = 0.03;
export const DROP_MAX = 0.85;

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

// The cells of `now` that changed from `base`, with the base's brightness
// scaled to now's (the ratio of their medians, so the changed part does
// not skew it). Returns {mask (Uint8Array), share, gain}.
export function changeMask(now, base, change = CHANGE) {
	const n = now.data.length;
	const median = (data) => Float32Array.from(data).sort()[n >> 1] || 1;
	const gain = Math.min(2, Math.max(0.5, median(now.data) / median(base.data)));
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

// The box round some points: {x, y, w, h}.
export function boxOf(points) {
	const xs = points.map((p) => p.x);
	const ys = points.map((p) => p.y);
	const x = Math.min(...xs);
	const y = Math.min(...ys);

	return {h: Math.max(...ys) - y, w: Math.max(...xs) - x, x, y};
}

// What a still picture's change against the base says: {kind, share, ...}.
// kind 'drop' (a new card: rect, corners, others in view pixels, the blob's
// share of the view, its fill), 'none' (nothing changed to speak of: a
// hand passed and left nothing), 'small' (a change too small for a card),
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

	const rects = cardRects(rect);

	return {
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
export function createDropDetector({motion = MOTION, settleMs = SETTLE_MS, ...judge} = {}) {
	let previous = null;
	let base = null;
	let lastMotion = -Infinity;
	let paused = false;
	let burst = null;
	let startedAt = null;

	return {
		get base() {
			return base;
		},
		pause() {
			paused = true;
		},
		push(view, at) {
			const now = cells(view.grey, view.width, view.height, judge.cell || CELL);
			const moved = previous ? cellMotion(now, previous) : 0;

			previous = now;

			if (moved > motion) {
				lastMotion = at;
				burst = burst ? {...burst, peak: Math.max(burst.peak, moved)} : {peak: moved, start: at};

				return {drop: false, motion: moved, moving: true, still: 0};
			}

			const still = at - lastMotion;

			if (still < settleMs || paused) {
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

			return {burst: seen, change, drop: change.kind === 'drop', motion: moved, moving: false, still};
		},
		reframe() {
			previous = null;
			base = null;
			burst = null;
			lastMotion = -Infinity;
			startedAt = null;
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

// The last card taken, nudged or settling a little further: the change lies
// inside where it lay (MOVED_INSIDE of its box) and is much smaller than it
// (MOVED_PART of its area). A new card landing on it changes at least its
// picture, about a third of a card, and usually all of it.
export const MOVED_INSIDE = 0.8;
export const MOVED_PART = 0.25;

// A change whose box is this many times the largest card taken since the
// zoom last changed is no card (the caller forgets the last card then).
export const LIGHT_GROWTH = 2.2;

// The card to pass as `last` after a capture: its box, and the largest card
// area seen since the last was forgotten (a change that was only a card's
// picture gives a box smaller than the card).
export const takenCard = (last, card) => ({...card, area: Math.max(last && last.area ? last.area : 0, card.box.w * card.box.h)});

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
// Returns {skip: 'moved'} for the last card nudged, or {card, quads,
// region, sharpness, agree}: region the part of the frame to grab, quads
// the card's candidate outlines in its pixels for identify.js (the
// outlines findCard found over the change first, then the change's own
// rectangle snapped to a card, then that rectangle cut the other ways
// cardRects gives), card the change's card in frame pixels, sharpness that
// of the view where it changed, agree how many found outlines agreed.
export function dropCapture(change, view, fine, found, {frame, last = null} = {}) {
	const toFrame = (v) => (p) => ({x: v.rect.x + p.x / v.scale, y: v.rect.y + p.y / v.scale});
	const card = change.corners.map(toFrame(view));
	const cardBox = boxOf(card);
	const blobBox = boxOf(rectCorners(change.rect).map(toFrame(view)));

	if (last && inside(blobBox, last.box) >= MOVED_INSIDE && blobBox.w * blobBox.h < last.box.w * last.box.h * MOVED_PART) {
		return {skip: 'moved'};
	}

	// A change far larger than the last card is the light moved over the
	// box, not a card (Eric's video: the lamp moved from one side to the
	// other changed the whole floor round the card on top).
	if (last && blobBox.w * blobBox.h > (last.area || last.box.w * last.box.h) * LIGHT_GROWTH) {
		return {skip: 'light'};
	}

	// An outline agrees when it lies over the change's card, or holds the
	// whole blob and is not much larger than a card round it (the blob was
	// only the card's picture).
	const holds = (box) => inside(blobBox, box) >= 0.85 && box.w * box.h <= blobBox.w * blobBox.h * 4;
	const outlines = found && found.quad ? [{corners: found.quad, upright: found.upright}, ...(found.others || [])] : [];
	const agree = outlines
		.map((one) => ({corners: one.corners.map(toFrame(fine)), upright: one.upright !== false}))
		.filter((one) => overlap(boxOf(one.corners), cardBox) >= AGREE || holds(boxOf(one.corners)));
	const own = [card, ...(change.others || []).map((corners) => corners.map(toFrame(view)))].map((corners) => {
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
		card: {box: cardBox, corners: card},
		quads: quads.map((q) => ({corners: q.corners.map((c) => ({x: c.x - region.x, y: c.y - region.y})), upright: q.upright})),
		region,
		sharpness: Math.round(sharpness(view.grey, view.width, view.height, boxOf(change.corners))),
	};
}
