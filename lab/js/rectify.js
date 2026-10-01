// Finds the card inside a capture and cuts it out straight.
//
// The lab crops a little more than its guide frame, so the whole card is in
// the image even when it is held a bit large, small, or off centre. This
// module finds the card's four edges, measures how far the card is turned,
// turns it back, and crops to the edges. The benchmark showed why: with the
// card 6 % smaller than the frame and 2 % off centre, the fixed regions in
// pipeline.js missed the collector number on most cards.
//
// Pure functions over ImageData-shaped objects, like pipeline.js.

import {CARD_RATIO} from './pipeline.js';

// Detection runs on a copy at most this many pixels tall; the crop and the
// rotation use the full image.
const WORK_HEIGHT = 700;

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

// Turns the image by `degrees` (positive is clockwise) about its centre,
// bilinear, keeping its size. Uncovered corners take the nearest edge pixel.
export function rotate(img, degrees) {
	const {height, width} = img;
	const out = new Uint8ClampedArray(width * height * 4);
	const radians = (-degrees * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const cx = width / 2;
	const cy = height / 2;
	const src = img.data;

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const dx = x - cx;
			const dy = y - cy;
			const sx = Math.min(width - 1.001, Math.max(0, cx + dx * cos - dy * sin));
			const sy = Math.min(height - 1.001, Math.max(0, cy + dx * sin + dy * cos));
			const x0 = Math.floor(sx);
			const y0 = Math.floor(sy);
			const fx = sx - x0;
			const fy = sy - y0;
			const i00 = (y0 * width + x0) * 4;
			const i10 = i00 + 4;
			const i01 = i00 + width * 4;
			const i11 = i01 + 4;
			const o = (y * width + x) * 4;

			for (let c = 0; c < 4; c++) {
				out[o + c] = (src[i00 + c] * (1 - fx) + src[i10 + c] * fx) * (1 - fy)
					+ (src[i01 + c] * (1 - fx) + src[i11 + c] * fx) * fy;
			}
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

// Returns {card, angle, found, note, rect}. `card` is the straightened crop
// when the edges were found and make a card-shaped box, otherwise the input
// unchanged (found false, with the reason in `note`).
export function rectify(img) {
	const scale = Math.min(1, WORK_HEIGHT / img.height);
	let work = greyCopy(img, scale);
	const angle = measureTilt(work);
	let source = img;

	if (Math.abs(angle) >= 0.3) {
		source = rotate(img, -angle);
		work = greyCopy(source, scale);
	}

	const edges = findEdges(work);

	if (edges.left === null || edges.right === null || edges.bottom === null) {
		return {angle: 0, card: img, found: false, note: 'Card edges not found; read the frame as it is.', rect: null};
	}

	const left = edges.left / scale;
	const right = edges.right / scale;
	const bottom = edges.bottom / scale;
	const width = right - left;
	let top = edges.top === null ? null : edges.top / scale;
	let note = 'Card edges found.';

	if (width < img.width * 0.6) {
		return {angle: 0, card: img, found: false, note: 'The edges found are too close together to be the card; read the frame as it is.', rect: null};
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
		h: Math.round(Math.min(source.height, bottom) - top),
		w: Math.round(width),
		x: Math.round(left),
		y: Math.round(top),
	};

	rect.w = Math.min(rect.w, source.width - rect.x);
	rect.h = Math.min(rect.h, source.height - rect.y);

	return {angle: Math.round(angle * 10) / 10, card: cropImage(source, rect), found: true, note, rect};
}
