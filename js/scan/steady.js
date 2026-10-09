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

// Mean absolute grey difference (0 to 255) between the coarse copies of two
// thumbnails (coarse: 4 x 4 blocks averaged) below which they count as the
// same, still frame. Measured on a card drawn on a table and moved between
// frames (2026-10-03): the full 64 x 88 thumbnails differ by 5.8 for a move
// of 0.6 % of the capture's width and 9.1 for 1 %, so the old rule (6 on the
// full thumbnail) took a hand steadier than most to hold still; the coarse
// copies differ by 2.8 and 4.4, and by 6.5 at 1.5 %. A different card in
// the same place differs by 15 or more either way.
export const STILL = 6;

// After a capture, a coarse difference above this from the captured frame
// means the card was moved or swapped. Shake of 2 % of the width is 8.5.
export const CHANGED = 20;

// After a capture, a coarse difference above this between one frame and
// the next is the view changing at once: a card swapped straight for
// another, with no empty frame between. Two cards in the same place can
// differ by less than CHANGED (a Bulbasaur and a Pikachu, 13.9, measured
// 2026-10-09, when card B swapped in for card A was never taken), while a
// card held by hand moves by a few pixels between frames (0.6 to 2.5 per
// frame); moved 3 % of the width at once it differs by 8 to 11. A jump that
// re-arms for the same card takes it again, and view.js asks "Same card as
// the last one." rather than adding it.
export const JUMP = 12;

// Frames in a row that must be still: at about eight a second, under half a
// second (three differences, so four frames).
export const STEADY_FRAMES = 3;

// The thumbnail averaged over COARSE x COARSE blocks, for the steadiness
// check: shake of a pixel or two moves fine detail (text, edges) a whole
// pixel but barely changes the blocks.
const COARSE = 4;

export function coarse(grey, width = THUMB_W, height = THUMB_H) {
	const w = Math.floor(width / COARSE);
	const h = Math.floor(height / COARSE);
	const out = new Uint8Array(w * h);

	for (let by = 0; by < h; by++) {
		for (let bx = 0; bx < w; bx++) {
			let sum = 0;

			for (let y = by * COARSE; y < (by + 1) * COARSE; y++) {
				for (let x = bx * COARSE; x < (bx + 1) * COARSE; x++) {
					sum += grey[y * width + x];
				}
			}

			out[by * w + bx] = Math.round(sum / (COARSE * COARSE));
		}
	}

	return out;
}

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

// The colour spread (colourfulness) below which the middle of the frame has
// no colour to speak of: a sheet of paper, a printed page, a grey wall.
// Every card has colour in its artwork; the greyest of the 40 benchmark
// cards (a full-art Froslass) measures 3.5, white paper with black text 0,
// and strongly tinted paper about 2.
export const COLOURLESS = 2.5;

// A turn in the hand smaller than this (degrees) is left to sideLine's lean.
const TURN_MIN = 4;

// The most a card held by hand is taken to be turned, either way, in
// degrees, as js/scan/rectify.js TILT_MAX.
const TURN_MAX = 22;

// The middle band's rows, as [y0, y1).
const band = (height) => [Math.round(height * 0.15), Math.round(height * 0.85)];

// A side of the card near columns from..to as a straight line, which may
// lean: in each row of the middle band, the strongest step within those
// columns, then the line (leaning up to 0.15 of a column per row) that most
// of those steps lie on, within a column. In a cluttered scene the
// strongest step of each row falls anywhere, so no line gathers them.
// Returns {lean, share, x}: the share of the rows on the line, how far it
// leans (columns per row), and where it crosses the middle row.
//
// outer: 'low' or 'high' takes, in each row, the strong step nearest
// column `from` (or `to`) instead of the strongest: from outside the card
// in, its edge is the first strong step met, where its text, inside, may
// step harder.
function sideLine(grey, width, height, from, to, outer = null) {
	const [y0, y1] = band(height);
	const points = [];

	for (let y = y0; y < y1; y++) {
		let best = 0;
		let at = -1;
		const lo = Math.max(1, from);
		const hi = Math.min(width - 1, to);

		for (let i = 0; i < hi - lo; i++) {
			const x = outer === 'high' ? hi - 1 - i : lo + i;
			const step = Math.abs(grey[y * width + x + 1] - grey[y * width + x - 1]);

			if (outer && step >= EDGE_STEP) {
				// The step's peak: the next column out may step harder still.
				const next = outer === 'high' ? x - 1 : x + 1;

				best = step;
				at = next >= lo && next < hi && Math.abs(grey[y * width + next + 1] - grey[y * width + next - 1]) > step ? next : x;
				break;
			}

			if (step > best) {
				best = step;
				at = x;
			}
		}

		if (best >= EDGE_STEP) {
			points.push([y - (y0 + y1) / 2, at]);
		}
	}

	let found = {count: 0, lean: 0, x: null};

	for (let lean = -15; lean <= 15; lean++) {
		const bins = new Map();

		for (const [y, x] of points) {
			const bin = Math.round(x - (lean / 100) * y);

			bins.set(bin, (bins.get(bin) || 0) + 1);
		}

		for (const [bin, n] of bins) {
			const count = n + (bins.get(bin - 1) || 0) + (bins.get(bin + 1) || 0);

			if (count > found.count) {
				found = {count, lean: lean / 100, x: bin};
			}
		}
	}

	return {lean: found.lean, share: found.count / Math.max(1, y1 - y0), x: found.x};
}

// How far the thumbnail's content is turned, in degrees (positive:
// clockwise), the way js/scan/rectify.js measures a capture's tilt: the
// angle at which its sharp steps line up best (every edge of a card runs
// parallel to one of its sides), over every whole degree up to TURN_MAX.
export function thumbTurn(grey, width, height) {
	const across = [];
	const down = [];

	for (let y = 1; y < height - 1; y++) {
		for (let x = 1; x < width - 1; x++) {
			const gx = Math.abs(grey[y * width + x + 1] - grey[y * width + x - 1]);
			const gy = Math.abs(grey[(y + 1) * width + x] - grey[(y - 1) * width + x]);

			if (gx >= EDGE_STEP && gx > gy * 2) {
				across.push(x, y);
			}
			else if (gy >= EDGE_STEP && gy > gx * 2) {
				down.push(x, y);
			}
		}
	}

	const size = width + height + 4;
	const bins = new Int32Array(size * 2);
	const offset = Math.ceil((width + height) / 2) + 2;
	let best = 0;
	let bestScore = -1;

	for (let degrees = -TURN_MAX; degrees <= TURN_MAX; degrees++) {
		const t = Math.tan((degrees * Math.PI) / 180);
		let score = 0;

		bins.fill(0);

		for (let i = 0; i < across.length; i += 2) {
			bins[Math.round(across[i] + t * across[i + 1]) + offset]++;
		}

		for (let i = 0; i < down.length; i += 2) {
			bins[size + Math.round(down[i + 1] - t * down[i]) + offset]++;
		}

		for (let i = 0; i < bins.length; i++) {
			score += bins[i] * bins[i];
		}

		// The straighter of two equal scores.
		if (score > bestScore || (score === bestScore && Math.abs(degrees) < Math.abs(best))) {
			best = degrees;
			bestScore = score;
		}
	}

	return best;
}

// The thumbnail turned by `degrees` about its centre (nearest pixel), so a
// card turned clockwise by that much stands straight. Where the turned
// picture reaches past the thumbnail's edges it repeats the nearest edge
// pixel, as flat as the table there.
export function turnThumb(grey, width, height, degrees) {
	const out = new Uint8Array(width * height);
	const radians = (degrees * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const cx = (width - 1) / 2;
	const cy = (height - 1) / 2;

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const dx = x - cx;
			const dy = y - cy;
			const sx = Math.min(width - 1, Math.max(0, Math.round(cx + dx * cos - dy * sin)));
			const sy = Math.min(height - 1, Math.max(0, Math.round(cy + dx * sin + dy * cos)));

			out[y * width + x] = grey[sy * width + sx];
		}
	}

	return out;
}

// How many straight lines, leaning by `lean`, run down most of the middle
// band (EDGE_ROWS of its rows step within a column of them) and cross the
// middle row between columns from and to. A card has its two sides (and
// the inner border just inside them); between them its art, text, and
// boxes make no line that long. Regular vertical stripes make one at every
// stripe.
function longLines(grey, width, height, lean, from, to) {
	const [y0, y1] = band(height);
	const middle = (y0 + y1) / 2;
	const pad = Math.ceil(0.15 * height) + 2;
	const hits = new Int32Array(width + pad * 2);

	for (let y = y0; y < y1; y++) {
		for (let x = 1; x < width - 1; x++) {
			if (Math.abs(grey[y * width + x + 1] - grey[y * width + x - 1]) >= EDGE_STEP) {
				hits[Math.round(x - lean * (y - middle)) + pad]++;
			}
		}
	}

	const need = EDGE_ROWS * (y1 - y0);
	let lines = 0;

	for (let x = Math.max(1, Math.ceil(from)); x <= Math.min(width - 2, Math.floor(to)); x++) {
		const i = x + pad;

		if (hits[i] >= need && hits[i] >= hits[i - 1] && hits[i] > hits[i + 1]) {
			lines++;
		}
	}

	return lines;
}

// The colour spread in the middle of a capture's thumbnail (RGBA bytes of
// width x height), where a card held in the guide shows its artwork: the
// spread of each pixel's chromaticity (its red against green, and its red
// and green against blue, over its brightness), so a uniform tint (paper
// under warm light) is no colour, and dark pixels count for little.
export function colourfulness(rgba, width, height) {
	let n = 0;
	let sa = 0;
	let sb = 0;
	let saa = 0;
	let sbb = 0;

	for (let y = Math.round(height * 0.18); y < Math.round(height * 0.46); y++) {
		for (let x = Math.round(width * 0.2); x < Math.round(width * 0.8); x++) {
			const p = (y * width + x) * 4;
			const r = rgba[p];
			const g = rgba[p + 1];
			const b = rgba[p + 2];
			const sum = r + g + b + 30;
			const a = (r - g) / sum;
			const c = (r + g - 2 * b) / sum / 2;

			n++;
			sa += a;
			sb += c;
			saa += a * a;
			sbb += c * c;
		}
	}

	if (!n) {
		return 0;
	}

	const va = Math.max(0, saa / n - (sa / n) ** 2);
	const vb = Math.max(0, sbb / n - (sb / n) ** 2);

	return Math.round(Math.sqrt(va + vb) * 1000) / 10;
}

// Whether a card seems to be in the frame, and whether glare is washing it
// out. A card held in the guide makes two strong vertical edges near the
// thumbnail's left and right sides (the capture keeps a 10 % margin around
// the guide, js/scan/camera.js CAPTURE_PAD, so they sit about 8 % in), and
// plenty of detail between them. Any rule below says the edges are the
// card's:
//
// - each stands out against a flat table beyond it (the outermost column);
// - or each is one straight line down most of the frame, the two far enough
//   apart to be the card filling the guide. This is the card held to fill
//   the guide's height: seen at a slant its top is wider than its bottom
//   and reaches the margin, and a card shown on a screen has the app's text
//   right beside it, so nothing beyond its edges is flat;
// - or all four edges are straight lines that make a card-shaped box inside
//   the frame (boxed): a card held smaller than the guide, or a little off
//   its middle (Eric, 2026-10-03: waiting for the card to fill the guide
//   exactly made auto capture slow, so he pressed the shutter).
//
// And nothing else may say it is not a card:
//
// - regular stripes make straight lines all across the frame, where a card
//   has none between its sides;
// - a frame with no colour in its middle (`colour`, from colourfulness,
//   when the caller has it) is paper or a wall, not a card's artwork.
//
// A cluttered scene has strong steps everywhere but no two long straight
// edges where a card's would be, and a card held so large that its edges
// leave the frame has neither.
// A card turned more than a few degrees is judged on the thumbnail turned
// straight (thumbTurn, turnThumb), where its sides stand upright again.
//
// Returns {present, glare, edges: {left, right}, detail, reason, small,
// turn}: reason says why a frame with detail is not a card ('stripes',
// 'colourless'), or null; small whether, with no card seen, one is held too
// far away (smallCard); turn is the degrees the card was turned when it was
// judged on the turned thumbnail, else 0.
export function presence(grey, width, height, {colour = null} = {}) {
	const level = judge(grey, width, height, colour);

	if (level.present || level.reason || level.detail < 14) {
		return {...level, turn: 0};
	}

	const turn = thumbTurn(grey, width, height);

	if (Math.abs(turn) < TURN_MIN) {
		return {...level, turn: 0};
	}

	const turned = judge(turnThumb(grey, width, height, turn), width, height, colour);

	return turned.present || turned.reason ? {...turned, detail: level.detail, glare: level.glare, turn} : {...level, turn: 0};
}

function judge(grey, width, height, colour) {
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
	let leftAt = 2;
	let rightAt = width - 3;

	for (let x = 2; x < side; x++) {
		if (columns[x] > left) {
			left = columns[x];
			leftAt = x;
		}
	}

	for (let x = width - side; x < width - 2; x++) {
		if (columns[x] > right) {
			right = columns[x];
			rightAt = x;
		}
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
	const box = againstTable || straight ? null : boxed(grey, width, height);

	// Lines between the sides, more than a fifth of the way in from each.
	let reason = null;

	if (againstTable || straight || box) {
		const lean = straight ? (leftLine.lean + rightLine.lean) / 2 : box ? box.lean : 0;
		const from = straight ? leftLine.x : box ? box.left : leftAt;
		const to = straight ? rightLine.x : box ? box.right : rightAt;
		const inset = (to - from) * 0.2;

		if (longLines(grey, width, height, lean, from + inset, to - inset) >= 3) {
			reason = 'stripes';
		}
		else if (colour !== null && colour < COLOURLESS) {
			reason = 'colourless';
		}
	}

	const present = (againstTable || straight || Boolean(box)) && detail >= 14 && !reason;

	return {
		detail: Math.round(detail),
		edges: {left: Math.round(left), right: Math.round(right)},
		glare: bright / grey.length > 0.03,
		present,
		reason,
		small: !present && !reason && !againstTable && !straight && !box && (colour === null || colour >= COLOURLESS) && smallCard(grey, width, height),
	};
}

// A card held too far away to read, in a thumbnail where nothing else was
// seen: the four straight edges of a card-shaped box (boxed) between
// SMALL.min and BOX_MIN of the thumbnail across, with no stripes inside.
// Its sides run along only part of the middle band, so fewer of its rows
// are asked of them. It only changes the hint to "Move closer" and keeps a
// shutter capture in the tray; it never takes the picture.
//
// Q-19 (2026-10-02): a card at 0.45 of the guide spans about 0.37 of the
// thumbnail, its sides about half the band's rows.
export function smallCard(grey, width = THUMB_W, height = THUMB_H) {
	const box = boxed(grey, width, height, SMALL);

	if (!box) {
		return false;
	}

	const inset = (box.right - box.left) * 0.2;

	return longLines(grey, width, height, box.lean, box.left + inset, box.right - inset) < 3;
}

// The thumbnail turned on its side (rows become columns), so sideLine can
// look for a card's top and bottom edges as it looks for its sides.
function transpose(grey, width, height) {
	const out = new Uint8Array(width * height);

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			out[x * height + y] = grey[y * width + x];
		}
	}

	return out;
}

// How far in from each side the edges of a card held smaller than the
// guide may be, as a share of the thumbnail, and how small it may be held:
// the guide is the middle 1 / 1.2 of the capture (camera.js CAPTURE_PAD),
// so a card at 0.6 of the guide's size spans half the capture.
const BOX_SIDE = 0.34;
const BOX_MIN = 0.5;
const BOX_ACROSS = 0.5;
const BOX_EDGE = 0.04;

// boxed's limits for a card held too far away (smallCard).
const SMALL = {across: 0.3, max: BOX_MIN, min: 0.25, rows: 0.3, side: 0.45};

// A card held smaller than the guide, or off its middle, but inside it:
// four straight edges (sideLine on the thumbnail, and on it turned on its
// side for the top and bottom), each running along most of its band, that
// make a box of a card's shape (63:88, within 12 %; the thumbnail has about
// the capture's shape) at least BOX_MIN of the thumbnail across. Two long
// edges alone, too close together for a card filling the guide, are not
// enough (a phone's screen beside the card makes those); the top and bottom
// must be there too, at the right distance. Returns {left, right, lean} or
// null.
//
// limits: SMALL looks for a card held too far away (smallCard).
function boxed(grey, width, height, {across: acrossShare = BOX_ACROSS, max = 1, min = BOX_MIN, rows = EDGE_ROWS, side: sideShare = BOX_SIDE} = {}) {
	const side = Math.round(width * sideShare);
	const left = sideLine(grey, width, height, 1, side, 'low');
	const right = sideLine(grey, width, height, width - side, width - 1, 'high');

	// Each edge clear of the thumbnail's own edge (a card inside the guide
	// has table around it): in a cluttered scene the first strong step of
	// every row is at the very edge, which makes a line there.
	const clear = (line, lo, hi, room) => line.x !== null && line.x >= lo + room && line.x <= hi - room;
	const room = Math.max(2, Math.round(width * BOX_EDGE));

	if (left.share < rows || right.share < rows || !clear(left, 1, width - 2, room) || !clear(right, 1, width - 2, room) || right.x - left.x < width * min || right.x - left.x >= width * max) {
		return null;
	}

	const turned = transpose(grey, width, height);
	const across = Math.round(height * sideShare);
	const top = sideLine(turned, height, width, 1, across, 'low');
	const bottom = sideLine(turned, height, width, height - across, height - 1, 'high');

	// The top and bottom are looked for across the middle band of columns,
	// which for a card held small reaches past its sides, and its text runs
	// across them: half the band is enough, with the shape check below.
	const roomDown = Math.max(2, Math.round(height * BOX_EDGE));

	if (top.share < acrossShare || bottom.share < acrossShare || !clear(top, 1, height - 2, roomDown) || !clear(bottom, 1, height - 2, roomDown)) {
		return null;
	}

	const shape = (right.x - left.x) / (bottom.x - top.x);

	if (Math.abs(shape / (63 / 88) - 1) > 0.12) {
		return null;
	}

	return {lean: (left.lean + right.lean) / 2, left: left.x, right: right.x};
}

// The detector. push(thumbnail, {present}) returns true when it is time to
// capture. captured(thumbnail) records a capture (auto or shutter), after
// which nothing fires until the frame changes. pause() and resume() hold it
// while a sheet covers the viewfinder. reframe() says the capture area
// moved (the guide laid out again as the tray or a note changed height), so
// the next frame is not compared with the last one as a jump.
export function createAutoCapture({changed = CHANGED, jump = JUMP, steadyFrames = STEADY_FRAMES, still = STILL} = {}) {
	let previous = null;
	let steady = 0;
	let last = null;
	let paused = false;
	let state = 'armed';

	return {
		captured(thumbnail) {
			last = thumbnail ? coarse(thumbnail) : null;
			state = 'cooldown';
			steady = 0;
		},
		pause() {
			paused = true;
		},
		reframe() {
			previous = null;
			steady = 0;
		},
		push(full, {present}) {
			const thumbnail = coarse(full);
			const moved = difference(thumbnail, previous);
			const previousMoved = previous ? moved : null;

			previous = thumbnail;
			steady = moved <= still ? steady + 1 : 0;

			if (state === 'cooldown') {
				// Re-armed when the frame no longer shows the captured card: it
				// moved away, a different card is held still, or the view
				// jumped at once (a card swapped straight for another).
				if (!present || difference(thumbnail, last) > changed || (previousMoved !== null && moved > jump)) {
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
