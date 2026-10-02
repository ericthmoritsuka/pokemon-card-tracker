// Auto-capture: take the picture when a card is in the frame and the frame
// has held still, and take it once. Pure functions over small grey
// thumbnails of the capture area, so Node can test them (tests/scan.test.mjs);
// js/scan/view.js feeds it a thumbnail of the live video a few times a
// second.
//
// "Once" is the rule that matters (plans/design-review.md, block 2: "a still
// card is captured once"). After a capture the detector waits for the frame
// to change (the card taken away or swapped) before it can fire again. The
// shutter button always captures; it also counts as a capture here, so the
// same still card is not taken a second time on its own.

// Thumbnail size: the capture area (the guide frame plus its margin) shrunk
// to this many pixels.
export const THUMB_W = 64;
export const THUMB_H = 88;

// Mean absolute grey difference (0 to 255) below which two thumbnails count
// as the same, still frame. Sensor noise averages out at this size.
export const STILL = 6;

// After a capture, a difference above this from the captured frame means the
// card was moved or swapped.
export const CHANGED = 20;

// Frames in a row that must be still: at about eight a second, half a second.
export const STEADY_FRAMES = 4;

// Grey (luminance) thumbnail from RGBA bytes.
export function toGrey(rgba, width, height) {
	const grey = new Uint8Array(width * height);

	for (let i = 0, p = 0; i < grey.length; i++, p += 4) {
		grey[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
	}

	return grey;
}

export function difference(a, b) {
	if (!a || !b || a.length !== b.length) {
		return 255;
	}

	let sum = 0;

	for (let i = 0; i < a.length; i++) {
		sum += Math.abs(a[i] - b[i]);
	}

	return sum / a.length;
}

// A row's step at least this strong (0 to 255) can be a card's edge.
const EDGE_STEP = 24;

// Of the rows in the middle band, the share a side edge must run along.
const EDGE_ROWS = 0.65;

// A side of the card near columns from..to as a straight line, which may
// lean: in each row of the middle band, the strongest step within those
// columns, then the line (leaning up to 0.15 of a column per row) that most
// of those steps lie on, within a column. In a cluttered scene the
// strongest step of each row falls anywhere, so no line gathers them.
// Returns {share, x}: the share of the rows on the line, and where it
// crosses the middle row.
function sideLine(grey, width, height, from, to) {
	const y0 = Math.round(height * 0.15);
	const y1 = Math.round(height * 0.85);
	const points = [];

	for (let y = y0; y < y1; y++) {
		let best = 0;
		let at = -1;

		for (let x = Math.max(1, from); x < Math.min(width - 1, to); x++) {
			const step = Math.abs(grey[y * width + x + 1] - grey[y * width + x - 1]);

			if (step > best) {
				best = step;
				at = x;
			}
		}

		if (best >= EDGE_STEP) {
			points.push([y - (y0 + y1) / 2, at]);
		}
	}

	let found = {count: 0, x: null};

	for (let lean = -15; lean <= 15; lean++) {
		const bins = new Map();

		for (const [y, x] of points) {
			const bin = Math.round(x - (lean / 100) * y);

			bins.set(bin, (bins.get(bin) || 0) + 1);
		}

		for (const [bin, n] of bins) {
			const count = n + (bins.get(bin - 1) || 0) + (bins.get(bin + 1) || 0);

			if (count > found.count) {
				found = {count, x: bin};
			}
		}
	}

	return {share: found.count / Math.max(1, y1 - y0), x: found.x};
}

// Whether a card seems to be in the frame, and whether glare is washing it
// out. A card held in the guide makes two strong vertical edges near the
// thumbnail's left and right sides (the capture keeps a 6 % margin around
// the guide, so they sit about 5 % in), and plenty of detail between them.
// Either rule below says the edges are the card's:
//
// - each stands out against a flat table beyond it (the outermost column);
// - or each is one straight line down most of the frame, the two far enough
//   apart to be the card filling the guide. This is the card held to fill
//   the guide's height: seen at a slant its top is wider than its bottom
//   and reaches the margin, and a card shown on a screen has the app's text
//   right beside it, so nothing beyond its edges is flat.
//
// A cluttered scene has strong steps everywhere but no two long straight
// edges where a card's would be, and a card held so large that its edges
// leave the frame has neither.
// Returns {present, glare, edges: {left, right}, detail}.
export function presence(grey, width, height) {
	const columns = new Float64Array(width);
	const y0 = Math.round(height * 0.2);
	const y1 = Math.round(height * 0.8);

	for (let x = 1; x < width - 1; x++) {
		let sum = 0;

		for (let y = y0; y < y1; y++) {
			sum += Math.abs(grey[y * width + x + 1] - grey[y * width + x - 1]);
		}

		columns[x] = sum / (y1 - y0);
	}

	// The strongest column near each side, and how busy the outermost column
	// is: with the card inside the frame, the outermost column is the table
	// beyond its edge, flat next to the edge. A cluttered scene, or a card held
	// so large that its edges leave the frame, is busy there too.
	const side = Math.max(2, Math.round(width * 0.2));
	let left = 0;
	let right = 0;

	for (let x = 2; x < side; x++) {
		left = Math.max(left, columns[x]);
	}

	for (let x = width - side; x < width - 2; x++) {
		right = Math.max(right, columns[x]);
	}

	const outsideLeft = columns[1];
	const outsideRight = columns[width - 2];

	let bright = 0;
	let average = 0;

	for (const value of grey) {
		average += value;

		if (value >= 250) {
			bright++;
		}
	}

	average /= grey.length;

	let variance = 0;

	for (const value of grey) {
		variance += (value - average) ** 2;
	}

	const detail = Math.sqrt(variance / grey.length);
	const strong = (edge, outside) => edge >= 16 && outside <= Math.max(6, edge * 0.3);
	const againstTable = strong(left, outsideLeft) && strong(right, outsideRight);
	const leftLine = againstTable ? null : sideLine(grey, width, height, 1, side);
	const rightLine = againstTable ? null : sideLine(grey, width, height, width - side, width - 1);
	const straight = !againstTable && leftLine.share >= EDGE_ROWS && rightLine.share >= EDGE_ROWS && rightLine.x - leftLine.x >= width * 0.7;

	return {
		detail: Math.round(detail),
		edges: {left: Math.round(left), right: Math.round(right)},
		glare: bright / grey.length > 0.03,
		present: (againstTable || straight) && detail >= 14,
	};
}

// The detector. push(thumbnail, {present}) returns true when it is time to
// capture. captured(thumbnail) records a capture (auto or shutter), after
// which nothing fires until the frame changes. pause() and resume() hold it
// while a sheet covers the viewfinder.
export function createAutoCapture({changed = CHANGED, steadyFrames = STEADY_FRAMES, still = STILL} = {}) {
	let previous = null;
	let steady = 0;
	let last = null;
	let paused = false;
	let state = 'armed';

	return {
		captured(thumbnail) {
			last = thumbnail;
			state = 'cooldown';
			steady = 0;
		},
		pause() {
			paused = true;
		},
		push(thumbnail, {present}) {
			const moved = difference(thumbnail, previous);

			previous = thumbnail;
			steady = moved <= still ? steady + 1 : 0;

			if (state === 'cooldown') {
				// Re-armed when the frame no longer shows the captured card: it
				// moved away, or a different card is held still.
				if (!present || difference(thumbnail, last) > changed) {
					state = 'armed';
				}

				return false;
			}

			if (paused || !present || steady < steadyFrames) {
				return false;
			}

			return true;
		},
		resume() {
			paused = false;
			steady = 0;
		},
		get state() {
			return paused ? 'paused' : state;
		},
	};
}
