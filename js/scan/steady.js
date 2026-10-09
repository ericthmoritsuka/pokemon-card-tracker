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

// ------------------------------------------------------------ the card anywhere in the frame

// Finding the card anywhere in the camera's picture (Eric, 2026-10-09). Up
// to version 33 the scanner looked only inside the guide plus its margin
// (camera.js CAPTURE_PAD), so a card that had grown past the guide (a pile
// rising under a phone in a holder) or lay off its middle had its outline
// cut, and the straightening worked an edge out from a wrong line: crops
// 54 to 69 away, "needs a look", and the shutter pressed instead. Now the
// whole visible frame is searched, on a small copy (FIND_SIDE pixels on its
// longer side), for the straight edges a card makes, and the card is then
// cut from the full-resolution frame by its own corners.
//
// How: the sharp brightness steps of the copy vote for the straight lines
// they lie on (a Hough transform, each step voting only for lines across
// its own direction), the strongest lines are kept, and every two pairs of
// near-parallel lines that cross about square make a four-sided box. A box
// is a card when:
//
// - its sides have a card's 63:88 shape (within FIND_RATIO, which leaves
//   room for a slight slant);
// - each of its four sides runs along most of its length (FIND_SIDE_MIN,
//   past the rounded corners): an edge it borrowed from something else
//   stops short;
// - all four corners are inside the frame, clear of its edge: a box wall
//   or a screen's edge running off the frame is never a card, and a card
//   cut by the frame is reported as `touching` instead (in holder mode,
//   "Pile too high").
//
// Of the boxes that pass, two nested ones are a card's outer edge and its
// inner border when they are close in size (the outer one is the card), or
// a card inside something card-shaped (a box floor, a screen) when they are
// not (the inner one is the card). The rest are ranked by how fully their
// sides are drawn, how close their shape is to a card's, how near the
// middle they are, and how large.
//
// A pile of cards: the card on top is the only one whose four sides are
// whole; the outline of two stacked cards (the top strip of the card below
// showing past the new one) is too tall for a card's shape, so the top card
// is cut, not the two together.

// A card's width over its height.
const CARD_SHAPE = 63 / 88;

// The copy's longer side, in pixels, for the frame-by-frame search, and for
// the search at the moment of capture (a finer copy, for the corners).
export const FIND_SIDE = 200;
export const FIND_SIDE_CAPTURE = 360;

// How far a box's shape may be from a card's 63:88 (as a share), how much
// of each side must be drawn, and of the four together.
export const FIND_RATIO = 0.11;
export const FIND_SIDE_MIN = 0.75;
const FIND_MEAN_MIN = 0.75;

// How much of each side of a card the frame cuts must be drawn, inside the
// frame, for it to count as a card running off the frame.
const TOUCH_SIDE_MIN = 0.85;

// A card's border, between its edge and the inner line round its picture
// and text, is at most this share of its width on any side.
const BORDER_GAP = 0.075;

// Degrees two lines may differ by to be a box's opposite sides, and how far
// from square two sides may meet.
const PARALLEL_DEG = 7;
const SQUARE_DEG = 12;

const DEG = Math.PI / 180;

// Brightness steps on the copy: Sobel gradients and their strength.
function gradients(grey, width, height) {
	const mag = new Float32Array(width * height);
	const gxs = new Float32Array(width * height);
	const gys = new Float32Array(width * height);

	for (let y = 1; y < height - 1; y++) {
		for (let x = 1; x < width - 1; x++) {
			const i = y * width + x;
			const gx = grey[i - width + 1] + 2 * grey[i + 1] + grey[i + width + 1] - grey[i - width - 1] - 2 * grey[i - 1] - grey[i + width - 1];
			const gy = grey[i + width - 1] + 2 * grey[i + width] + grey[i + width + 1] - grey[i - width - 1] - 2 * grey[i - width] - grey[i - width + 1];

			gxs[i] = gx;
			gys[i] = gy;
			mag[i] = Math.sqrt(gx * gx + gy * gy) / 4;
		}
	}

	return {gxs, gys, mag};
}

// The direction across each edge pixel (degrees 0 to 180), for the pixels
// stepping at least `least`; -1 elsewhere.
function directions({gxs, gys, mag}, least) {
	const dir = new Float32Array(mag.length).fill(-1);

	for (let i = 0; i < mag.length; i++) {
		if (mag[i] >= least) {
			let angle = Math.atan2(gys[i], gxs[i]) / DEG;

			if (angle < 0) {
				angle += 180;
			}

			dir[i] = angle >= 180 ? angle - 180 : angle;
		}
	}

	return dir;
}

// The step strength that counts as an edge: four times the frame's typical
// step (its median), between 6 and 24 levels per pixel, so a silver border
// on a white box (a step of 10 to 20 levels) still counts on a quiet floor.
function edgeFloor(mag) {
	const histogram = new Uint32Array(256);

	for (const value of mag) {
		histogram[Math.min(255, Math.round(value))]++;
	}

	let seen = 0;
	let median = 0;

	for (let v = 0; v < 256; v++) {
		seen += histogram[v];

		if (seen >= mag.length / 2) {
			median = v;
			break;
		}
	}

	return Math.max(6, Math.min(14, median * 3));
}

const angleGap = (a, b) => {
	const d = Math.abs(a - b) % 180;

	return d > 90 ? 180 - d : d;
};

// The strongest straight lines (x cos theta + y sin theta = rho): each edge
// pixel that is a peak of its step across the edge votes for the lines
// through it within 3 degrees of its own direction. Returns [{theta
// (degrees, 0 to 180), rho, votes}], strongest first.
function houghLines(mag, dir, floor, width, height, {count = 40, minVotes}) {
	const diagonal = Math.ceil(Math.hypot(width, height));
	const rhos = diagonal * 2 + 1;
	const votes = new Int32Array(180 * rhos);
	const cos = new Float32Array(180);
	const sin = new Float32Array(180);

	for (let t = 0; t < 180; t++) {
		cos[t] = Math.cos(t * DEG);
		sin[t] = Math.sin(t * DEG);
	}

	for (let y = 2; y < height - 2; y++) {
		for (let x = 2; x < width - 2; x++) {
			const i = y * width + x;
			const m = mag[i];

			if (m < floor) {
				continue;
			}

			// A peak across the edge: a blurred edge votes once, not three times.
			const d = dir[i];
			const dx = Math.round(Math.cos(d * DEG));
			const dy = Math.round(Math.sin(d * DEG));

			if (m < mag[i + dy * width + dx] || m < mag[i - dy * width - dx]) {
				continue;
			}

			const centre = Math.round(d);

			for (let k = -3; k <= 3; k++) {
				const t = (centre + k + 180) % 180;

				votes[t * rhos + Math.round(x * cos[t] + y * sin[t]) + diagonal]++;
			}
		}
	}

	const peaks = [];

	for (let t = 0; t < 180; t++) {
		for (let r = 1; r < rhos - 1; r++) {
			const v = votes[t * rhos + r];

			if (v < minVotes) {
				continue;
			}

			let peak = true;

			for (let dt = -2; dt <= 2 && peak; dt++) {
				let tt = t + dt;
				let rr = r;

				// Past 0 or 180 degrees the same line has the opposite rho.
				if (tt < 0 || tt >= 180) {
					tt = (tt + 180) % 180;
					rr = rhos - 1 - r;
				}

				for (let dr = -2; dr <= 2; dr++) {
					const other = rr + dr;

					if ((dt || dr) && other >= 0 && other < rhos) {
						const w = votes[tt * rhos + other];

						if (w > v || (w === v && (dt < 0 || (dt === 0 && dr < 0)))) {
							peak = false;
							break;
						}
					}
				}
			}

			if (peak) {
				peaks.push({rho: r - diagonal, theta: t, votes: v});
			}
		}
	}

	peaks.sort((a, b) => b.votes - a.votes);

	return peaks.slice(0, count);
}

// A line, with how much of it is drawn: whether an edge pixel facing the
// line's way lies on it (within a pixel and a half) at each step t along
// it, and whether that point is inside the frame, as prefix sums, so the
// share of any stretch is one lookup.
function traceLine({rho, theta, votes}, mag, dir, floor, width, height) {
	const nx = Math.cos(theta * DEG);
	const ny = Math.sin(theta * DEG);
	const reach = Math.ceil(Math.hypot(width, height));
	const length = reach * 2 + 1;
	const on = new Int32Array(length + 1);
	const seen = new Int32Array(length + 1);

	for (let k = 0; k < length; k++) {
		const t = k - reach;
		const px = nx * rho - ny * t;
		const py = ny * rho + nx * t;
		let hit = 0;
		let inside = 0;

		if (px >= 1 && py >= 1 && px < width - 1 && py < height - 1) {
			inside = 1;

			for (let s = -1.5; s <= 1.5 && !hit; s += 0.75) {
				const x = Math.round(px + nx * s);
				const y = Math.round(py + ny * s);

				if (x >= 1 && y >= 1 && x < width - 1 && y < height - 1) {
					const i = y * width + x;

					if (mag[i] >= floor * 0.7 && angleGap(dir[i], theta) <= 22) {
						hit = 1;
					}
				}
			}
		}

		on[k + 1] = on[k] + hit;
		seen[k + 1] = seen[k] + inside;
	}

	return {nx, ny, on, reach, rho, seen, theta, votes};
}

// Where along `line` the point (x, y) falls.
const along = (line, x, y) => -line.ny * x + line.nx * y;

// The share of the stretch t0..t1 of `line` that is drawn, counting only
// the part inside the frame, and the share of the stretch inside it.
function drawn(line, t0, t1) {
	const lo = Math.max(0, Math.min(line.on.length - 1, Math.round(Math.min(t0, t1)) + line.reach));
	const hi = Math.max(0, Math.min(line.on.length - 1, Math.round(Math.max(t0, t1)) + line.reach));
	const span = Math.max(1, hi - lo);
	const seen = line.seen[hi] - line.seen[lo];

	return {inside: seen / span, share: seen ? (line.on[hi] - line.on[lo]) / seen : 0};
}

// Where two lines cross, or null when they are near parallel.
function meet(a, b) {
	const det = a.nx * b.ny - a.ny * b.nx;

	if (Math.abs(det) < 1e-6) {
		return null;
	}

	return {x: (a.rho * b.ny - b.rho * a.ny) / det, y: (a.nx * b.rho - b.nx * a.rho) / det};
}

const distance = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

// The corners of a box in order around it (clockwise on the screen),
// starting at the card's top left: for a card standing up (its long sides
// nearer upright than flat), the left end of its upper short side; for a
// card lying on its side, the lower end of its left short side, which is
// the top left of the card turned a quarter clockwise to stand up.
function orderCorners(points) {
	const cx = points.reduce((sum, p) => sum + p.x, 0) / 4;
	const cy = points.reduce((sum, p) => sum + p.y, 0) / 4;
	const ring = [...points].sort((p, q) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx));
	const side = (i) => distance(ring[i], ring[(i + 1) % 4]);
	// The short sides are ring 0 -> 1 and 2 -> 3, or 1 -> 2 and 3 -> 0.
	const shortFirst = side(0) + side(2) < side(1) + side(3);
	const [a, b] = shortFirst ? [ring[1], ring[2]] : [ring[0], ring[1]];
	const upright = Math.abs(b.y - a.y) >= Math.abs(b.x - a.x);
	let start = 0;
	let best = Infinity;

	for (let i = shortFirst ? 0 : 1; i < 4; i += 2) {
		const next = ring[(i + 1) % 4];
		const key = upright ? (ring[i].y + next.y) / 2 : (ring[i].x + next.x) / 2;

		if (key < best) {
			best = key;
			start = i;
		}
	}

	return {corners: [0, 1, 2, 3].map((k) => ring[(start + k) % 4]), upright};
}

// The box the corners make: its width and height (the short side over the
// long one, as `ratio`), how far from a rectangle its opposite sides are,
// and whether it sits inside the frame clear of its edge.
function boxShape(corners, width, height, margin) {
	const [tl, tr, br, bl] = corners;
	const top = distance(tl, tr);
	const bottom = distance(bl, br);
	const left = distance(tl, bl);
	const right = distance(tr, br);
	const across = (top + bottom) / 2;
	const down = (left + right) / 2;

	return {
		across,
		down,
		inside: corners.every((p) => p.x >= margin && p.y >= margin && p.x <= width - 1 - margin && p.y <= height - 1 - margin),
		ratio: across / down,
		skew: (Math.min(top, bottom) / Math.max(top, bottom, 1e-6)) * (Math.min(left, right) / Math.max(left, right, 1e-6)),
	};
}

function pointIn(p, corners) {
	let sign = 0;

	for (let i = 0; i < 4; i++) {
		const a = corners[i];
		const b = corners[(i + 1) % 4];
		const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);

		if (Math.abs(cross) < 1e-9) {
			continue;
		}

		if (sign && Math.sign(cross) !== sign) {
			return false;
		}

		sign = Math.sign(cross);
	}

	return true;
}

// Whether box `inner` lies inside box `outer` (a pixel of slack).
function contains(outer, inner) {
	const cx = outer.corners.reduce((sum, c) => sum + c.x, 0) / 4;
	const cy = outer.corners.reduce((sum, c) => sum + c.y, 0) / 4;
	const grown = outer.corners.map((c) => {
		const d = Math.max(1e-6, Math.hypot(c.x - cx, c.y - cy));

		return {x: c.x + ((c.x - cx) / d) * 1.5, y: c.y + ((c.y - cy) / d) * 1.5};
	});

	return inner.corners.every((p) => pointIn(p, grown));
}

// The gaps between box `inner`, inside box `outer`, and each of the outer
// box's sides (left, right, top, bottom), as shares of its width.
function gapsOf(outer, inner) {
	const [tl, tr, , bl] = outer.corners;
	const across = distance(tl, tr);
	const down = distance(tl, bl);
	const ux = {x: (tr.x - tl.x) / across, y: (tr.y - tl.y) / across};
	const uy = {x: (bl.x - tl.x) / down, y: (bl.y - tl.y) / down};
	const us = inner.corners.map((p) => (p.x - tl.x) * ux.x + (p.y - tl.y) * ux.y);
	const vs = inner.corners.map((p) => (p.x - tl.x) * uy.x + (p.y - tl.y) * uy.y);

	return [Math.min(...us), across - Math.max(...us), Math.min(...vs), down - Math.max(...vs)].map((gap) => gap / across);
}

// Whether box `inner` sits in box `outer` the way a card's inner border
// sits in its edge: every gap at most BORDER_GAP of the outer box's width.
const borderGaps = (outer, inner) => gapsOf(outer, inner).every((gap) => gap >= 0.01 && gap <= BORDER_GAP);

// How much of each side between its corners is drawn, leaving out the 8 %
// at each end (a card's corners are rounded).
function sideShares(lines, corners) {
	return lines.map((line, i) => {
		const a = corners[i];
		const b = corners[(i + 1) % 4];
		const t0 = along(line, a.x, a.y);
		const t1 = along(line, b.x, b.y);
		const trim = (t1 - t0) * 0.08;

		return drawn(line, t0 + trim, t1 - trim);
	});
}

// How far the sides' lines run on past the box's corners: for each end of
// each side, the share drawn of the stretch from 4 to 14 % of the side's
// length beyond the corner, averaged. A card's outline stops at its corners
// (only a card beneath, lined up with it, carries a side on); a box made of
// a card's side and a line inside it (the art box, a text line), or of a
// wall's long seam, has lines running on through its corners.
function overshoot(lines, corners) {
	let sum = 0;

	lines.forEach((line, i) => {
		const a = corners[i];
		const b = corners[(i + 1) % 4];
		const t0 = along(line, a.x, a.y);
		const t1 = along(line, b.x, b.y);
		const d = t1 - t0;
		const before = drawn(line, t0 - d * 0.14, t0 - d * 0.04);
		const after = drawn(line, t1 + d * 0.04, t1 + d * 0.14);

		sum += (before.inside > 0.5 ? before.share : 0) + (after.inside > 0.5 ? after.share : 0);
	});

	return sum / 8;
}

// Whether the box is part of something larger: at some side, both lines
// that meet it run on past it, drawn along most of the next 4 to 30 % of
// their length. That is a card's two sides running on past a line inside
// the card (the art box's edge, the line over the attacks), which with them
// makes a card-shaped box. A card on a pile whose sides line up with the
// card beneath runs on only by the strip of that card that shows.
function runsOn(lines, corners) {
	const run = (line, from, to) => {
		const t0 = along(line, from.x, from.y);
		const t1 = along(line, to.x, to.y);
		const d = t1 - t0;
		const past = drawn(line, t1 + d * 0.04, t1 + d * 0.3);

		return past.inside > 0.5 && past.share >= 0.6;
	};

	for (let i = 0; i < 4; i++) {
		// Side i runs from corner i to corner i + 1; the sides before and
		// after it end at those corners.
		const before = (i + 3) % 4;
		const after = (i + 1) % 4;

		if (run(lines[before], corners[before], corners[i]) && run(lines[after], corners[(after + 1) % 4], corners[after])) {
			return true;
		}
	}

	return false;
}

// How much the grey varies inside the box (its middle, 20 % in from each
// side): a card's picture and text vary; a box's empty floor, a wall, or a
// blank sheet does not.
function interiorDetail(grey, width, height, corners) {
	const [tl, tr, br, bl] = corners;
	let n = 0;
	let sum = 0;
	let squares = 0;

	for (let j = 0; j < 9; j++) {
		for (let i = 0; i < 9; i++) {
			const u = 0.2 + (0.6 * i) / 8;
			const v = 0.2 + (0.6 * j) / 8;
			const x = Math.round((1 - v) * ((1 - u) * tl.x + u * tr.x) + v * ((1 - u) * bl.x + u * br.x));
			const y = Math.round((1 - v) * ((1 - u) * tl.y + u * tr.y) + v * ((1 - u) * bl.y + u * br.y));

			if (x >= 0 && y >= 0 && x < width && y < height) {
				const value = grey[y * width + x];

				n++;
				sum += value;
				squares += value * value;
			}
		}
	}

	return n < 20 ? 0 : Math.sqrt(Math.max(0, squares / n - (sum / n) ** 2));
}

// The least variation (interiorDetail) a card's middle shows.
const CARD_DETAIL = 10;

// How much the grey varies between two nested boxes (the outer one's
// ring round the inner one): past RING_BUSY it is print (a card's name,
// text, and attacks round its art box); under it, plain ground (a box's
// floor round a card lying on it).
const RING_BUSY = 12;

function ringDetail(grey, width, height, outer, inner) {
	const [tl, tr, br, bl] = outer.corners;
	let n = 0;
	let sum = 0;
	let squares = 0;

	for (let j = 0; j < 16; j++) {
		for (let i = 0; i < 12; i++) {
			const u = 0.04 + (0.92 * i) / 11;
			const v = 0.04 + (0.92 * j) / 15;
			const p = {x: (1 - v) * ((1 - u) * tl.x + u * tr.x) + v * ((1 - u) * bl.x + u * br.x), y: (1 - v) * ((1 - u) * tl.y + u * tr.y) + v * ((1 - u) * bl.y + u * br.y)};
			const x = Math.round(p.x);
			const y = Math.round(p.y);

			if (x >= 0 && y >= 0 && x < width && y < height && !pointIn(p, inner.corners)) {
				const value = grey[y * width + x];

				n++;
				sum += value;
				squares += value * value;
			}
		}
	}

	return n < 12 ? 0 : Math.sqrt(Math.max(0, squares / n - (sum / n) ** 2));
}

// The line of `lines` that runs closest through the middle of the side from
// a to b.
function lineFor(lines, a, b) {
	const mx = (a.x + b.x) / 2;
	const my = (a.y + b.y) / 2;
	const off = (line) => Math.abs(line.nx * mx + line.ny * my - line.rho);

	return lines.reduce((best, line) => (off(line) < off(best) ? line : best));
}

// Two near-parallel lines' gap, measured on the same side of the origin.
function gapOf(a, b) {
	const flip = Math.abs(a.theta - b.theta) > 90 ? -1 : 1;

	return Math.abs(a.rho - flip * b.rho);
}

// Finds the card in a grey copy of the whole frame (width x height pixels,
// any typed array). Returns {quad, ratio, angle, upright, sides, score,
// touching, lines}: quad the card's corners on the copy, its top left first,
// clockwise (null when no card was found); ratio its width over its height
// (a card is 0.716); angle how far its sides lean from upright, in degrees
// (positive: turned clockwise); upright false for a card lying on its side
// (its quad then starts at the corner that is the top left once it is
// turned a quarter clockwise); sides how much of each side is drawn;
// touching whether, with no whole card found, a card-shaped outline runs
// off the frame's edge (a card too close, or a pile too high); lines how
// many straight lines were looked at.
export function findCard(grey, width, height, {debug = null} = {}) {
	const steps = gradients(grey, width, height);
	const {mag} = steps;
	const floor = edgeFloor(mag);
	const dir = directions(steps, floor * 0.7);
	const short = Math.min(width, height);
	const minSide = short * 0.18;
	const margin = Math.max(2, short * 0.015);
	const peaks = houghLines(mag, dir, floor, width, height, {minVotes: Math.max(8, Math.round(minSide * 0.45))});
	const lines = peaks.map((peak) => traceLine(peak, mag, dir, floor, width, height));
	const none = {angle: 0, lines: lines.length, others: [], quad: null, ratio: null, score: 0, sides: null, touching: false, upright: true};
	const offShape = (ratio) => Math.abs(ratio / CARD_SHAPE - 1);

	// Near-parallel pairs, far enough apart to be a card's opposite sides.
	const pairs = [];

	for (let i = 0; i < lines.length; i++) {
		for (let j = i + 1; j < lines.length; j++) {
			if (angleGap(lines[i].theta, lines[j].theta) <= PARALLEL_DEG) {
				const gap = gapOf(lines[i], lines[j]);

				if (gap >= minSide) {
					pairs.push({a: lines[i], b: lines[j], gap, theta: lines[i].theta});
				}
			}
		}
	}

	const boxes = [];
	let touching = false;

	for (let p = 0; p < pairs.length; p++) {
		for (let q = p + 1; q < pairs.length; q++) {
			const one = pairs[p];
			const two = pairs[q];

			if (Math.abs(angleGap(one.theta, two.theta) - 90) > SQUARE_DEG) {
				continue;
			}

			// The shape first: it is cheap, and rules most pairs out.
			if (offShape(Math.min(one.gap, two.gap) / Math.max(one.gap, two.gap)) > FIND_RATIO * 1.4) {
				continue;
			}

			const ring = [meet(one.a, two.a), meet(two.a, one.b), meet(one.b, two.b), meet(two.b, one.a)];

			if (ring.some((point) => !point)) {
				continue;
			}

			const four = [one.a, one.b, two.a, two.b];
			const {corners, upright} = orderCorners(ring);
			const box = boxShape(corners, width, height, margin);
			const off = offShape(box.ratio);

			if (off > FIND_RATIO || box.skew < 0.8 || box.across < minSide) {
				continue;
			}

			const own = corners.map((c, i) => lineFor(four, c, corners[(i + 1) % 4]));
			const sides = sideShares(own, corners);
			const shares = sides.map((s) => s.share);

			if (!box.inside) {
				// A card-shaped outline running off the frame: the sides inside
				// the frame are drawn, and some of it is outside.
				const visible = sides.filter((s) => s.inside > 0.3);

				if (visible.length >= 3 && visible.every((s) => s.share >= TOUCH_SIDE_MIN) && sides.some((s) => s.inside < 0.97) && interiorDetail(grey, width, height, corners) >= CARD_DETAIL) {
					touching = true;
				}

				continue;
			}

			const least = Math.min(...shares);
			const mean = shares.reduce((sum, s) => sum + s, 0) / 4;

			if (least < FIND_SIDE_MIN || mean < FIND_MEAN_MIN || runsOn(own, corners) || interiorDetail(grey, width, height, corners) < CARD_DETAIL) {
				continue;
			}

			const cx = corners.reduce((sum, c) => sum + c.x, 0) / 4;
			const cy = corners.reduce((sum, c) => sum + c.y, 0) / 4;
			const centre = Math.hypot((cx - width / 2) / width, (cy - height / 2) / height);
			const size = Math.sqrt((box.across * box.down) / (width * height));
			const quality = mean + least * 0.5 - off * 3 - overshoot(own, corners);
			const [tl, , , bl] = corners;

			boxes.push({
				angle: -Math.atan2(bl.x - tl.x, bl.y - tl.y) / DEG,
				area: box.across * box.down,
				corners,
				ratio: Math.round(box.ratio * 1000) / 1000,
				quality,
				score: quality - centre * 0.6 + size * 0.6,
				sides: shares.map((s) => Math.round(s * 100) / 100),
				upright,
			});
		}
	}

	// Duplicates (the same box from lines a pixel apart), then nested boxes:
	// the card's own edge round its inner border, and a card inside
	// something card-shaped.
	boxes.sort((a, b) => b.score - a.score);

	const kept = [];
	const near = short * 0.02;

	for (const box of boxes) {
		if (kept.length >= 40) {
			break;
		}

		if (!kept.some((other) => box.corners.every((c, k) => Math.abs(c.x - other.corners[k].x) < near && Math.abs(c.y - other.corners[k].y) < near))) {
			kept.push(box);
		}
	}
	let best = kept[0] || null;
	let within = null;

	// The card round a box inside it: a larger box, drawn about as well,
	// whose ring round the smaller one is a card border's (a few percent of
	// its width on every side: the card's edge round its inner border) or
	// busy with print (the card round its art box, which on Sword & Shield
	// cards has a lying card's shape). The largest such.
	const grow = () => {
		for (let round = 0; best && round < 3; round++) {
			const current = best;
			const outer = kept.filter((box) => box !== current && box !== within && (!within || contains(within, box)) && box.quality >= current.quality - 0.3 && contains(box, current) && (borderGaps(box, current) || ringDetail(grey, width, height, box, current) >= RING_BUSY))
				.sort((a, b) => b.area - a.area)[0];

			if (!outer) {
				break;
			}

			best = outer;
		}
	};

	grow();

	// A card lying in something card-shaped (a box's floor, a screen): a
	// smaller box well inside, drawn as fully, with plain ground round it.
	// That something then bounds the search for the card's own edge.
	const content = best && kept.find((box) => box !== best && box.quality >= best.quality - 0.15 && box.area >= best.area * 0.08 && contains(best, box) && gapsOf(best, box).every((gap) => gap > 0.015) && ringDetail(grey, width, height, best, box) < RING_BUSY);

	if (content) {
		within = best;
		best = content;
		grow();
	}

	if (debug) {
		debug.boxes = kept.map((box) => ({...box, dropped: box !== best}));
		debug.lines = lines.map(({rho, theta, votes}) => ({rho, theta, votes}));
	}

	if (!best) {
		return {...none, touching: touching || threeSided(grey, lines, width, height, margin, minSide)};
	}

	// Up to three other boxes, each clearly apart from the ones before it:
	// where two cards and their borders cross, the right box is not always
	// the best scored, and the picture match chooses among them
	// (js/scan/identify.js).
	const others = [];
	const apart = short * 0.04;

	for (const box of kept) {
		if (others.length >= 3) {
			break;
		}

		if (box !== best && box.score >= best.score - 0.35 && [best, ...others].every((other) => box.corners.some((c, k) => distance(c, other.corners[k]) >= apart))) {
			others.push(box);
		}
	}

	return {
		angle: Math.round(best.angle * 10) / 10,
		lines: lines.length,
		others: others.map((box) => ({angle: Math.round(box.angle * 10) / 10, corners: box.corners, ratio: box.ratio, upright: box.upright})),
		quad: best.corners,
		ratio: best.ratio,
		score: Math.round(best.score * 100) / 100,
		sides: best.sides,
		touching: false,
		upright: best.upright,
	};
}

// A card cut by the frame's edge shows three of its sides at most: two
// opposite ones, drawn from a third to the frame's edge, where a card's
// shape puts its fourth side past the edge.
function threeSided(grey, lines, width, height, margin, minSide) {
	const inFrame = (p) => p && p.x >= margin && p.y >= margin && p.x <= width - 1 - margin && p.y <= height - 1 - margin;

	for (let i = 0; i < lines.length; i++) {
		for (let j = i + 1; j < lines.length; j++) {
			const a = lines[i];
			const b = lines[j];
			const gap = gapOf(a, b);

			if (angleGap(a.theta, b.theta) > PARALLEL_DEG || gap < minSide) {
				continue;
			}

			for (const c of lines) {
				if (c === a || c === b || Math.abs(angleGap(c.theta, a.theta) - 90) > SQUARE_DEG) {
					continue;
				}

				const ca = meet(c, a);
				const cb = meet(c, b);

				if (!inFrame(ca) || !inFrame(cb) || drawn(c, along(c, ca.x, ca.y), along(c, cb.x, cb.y)).share < 0.6) {
					continue;
				}

				// The two sides drawn from c towards the frame's edge, as long as
				// a card's long side or its short one.
				for (const length of [gap / CARD_SHAPE, gap * CARD_SHAPE]) {
					for (const sign of [1, -1]) {
						const ta = along(a, ca.x, ca.y);
						const tb = along(b, cb.x, cb.y);
						const sa = drawn(a, ta, ta + sign * length);
						const sb = drawn(b, tb, tb + sign * length);

						// Each drawn right up to the frame's edge: the floor's seams of
						// a box stop at its corners, short of the edge.
						const tail = (line, t, inside) => drawn(line, t + sign * length * inside * 0.85, t + sign * length * inside).share >= 0.7;

						if (sa.inside < 0.97 && sb.inside < 0.97 && sa.inside > 0.3 && sb.inside > 0.3 && sa.share >= TOUCH_SIDE_MIN && sb.share >= TOUCH_SIDE_MIN && tail(a, ta, sa.inside) && tail(b, tb, sb.inside)) {
							// The card's far corners, past the frame, for its middle.
							const far = (line, t) => ({x: line.nx * line.rho - line.ny * t, y: line.ny * line.rho + line.nx * t});
							const corners = [ca, cb, far(b, tb + sign * length), far(a, ta + sign * length)];

							if (interiorDetail(grey, width, height, corners) >= CARD_DETAIL) {
								return true;
							}
						}
					}
				}
			}
		}
	}

	return false;
}

// ------------------------------------------------------------ holder mode

// Holder mode (Eric, 2026-10-09): the phone is held still in a stand over
// an open box, and cards are dropped in one by one, so they pile up. With
// the camera never moving, what moves is the card falling: auto capture
// waits for that motion to stop and the picture to stay still for
// HOLDER_SETTLE_MS, needs a whole card found in the frame (findCard, all
// four corners inside), and then takes it once. The next card landing on
// the pile moves the picture again, which arms the next capture. A card
// still sliding is never taken: every frame of the settle must be still.
//
// Motion is measured on the coarse copy of the whole view (findCard's
// copy, averaged over COARSE blocks), with the frames' average brightness
// taken out first: the camera adjusting its exposure to a card that just
// landed brightens or darkens the whole picture a little for a moment, which
// is not motion.

// How long the picture must stay still after the last motion, in
// milliseconds. On Eric's log (version 32) cards landed every 5 to 6 s,
// and a capture 2.6 s after the last one could still be the same drop
// settling; a card stops within a few frames of landing.
export const HOLDER_SETTLE_MS = 400;

// The mean difference between two coarse views (0 to 255, brightness
// change taken out) above which the picture moved. A camera's noise on a
// still scene is under 1; a card falling into a quarter of the view moves
// it by 10 or more.
export const HOLDER_MOTION = 2.5;

// The mean difference, brightness change taken out, between two coarse
// copies of the same size.
export function motion(a, b) {
	if (!a || !b || a.length !== b.length) {
		return 255;
	}

	let shift = 0;

	for (let i = 0; i < a.length; i++) {
		shift += a[i] - b[i];
	}

	shift /= a.length;

	let sum = 0;

	for (let i = 0; i < a.length; i++) {
		sum += Math.abs(a[i] - b[i] - shift);
	}

	return sum / a.length;
}

// The detector. push(view, width, height, {card, touching}, at) takes the
// grey copy of the whole view, whether a whole card was found in it
// (card) or only a card-shaped outline running off the frame (touching),
// and the time in milliseconds; it returns {capture, settleMs, pile}:
// capture true when it is time to take the picture, settleMs how long the
// picture had been still by then (from the last motion, or from the start),
// pile whether the picture has settled on a card running off the frame (a
// pile too high: "Pile too high: empty the box"). captured() records a
// capture (auto or shutter): nothing fires again until the picture moves
// and settles. pause() and resume() hold it while a sheet covers the
// viewfinder.
export function createHolderCapture({moving = HOLDER_MOTION, settleMs = HOLDER_SETTLE_MS} = {}) {
	let previous = null;
	let still = null;
	let paused = false;
	let state = 'armed';

	return {
		captured() {
			state = 'cooldown';
		},
		pause() {
			paused = true;
		},
		push(view, width, height, {card = false, touching = false} = {}, at = 0) {
			const thumbnail = coarse(view, width, height);
			const moved = motion(thumbnail, previous) > moving;

			previous = thumbnail;

			if (moved) {
				still = null;

				// The picture changed: a card dropped (or the pile taken away).
				if (state === 'cooldown') {
					state = 'armed';
				}

				return {capture: false, pile: false, settleMs: 0};
			}

			if (still === null) {
				still = at;
			}

			const settled = at - still >= settleMs;
			const result = {capture: false, pile: settled && !card && touching, settleMs: Math.round(at - still)};

			if (!paused && state === 'armed' && settled && card) {
				result.capture = true;
			}

			return result;
		},
		reframe() {
			previous = null;
			still = null;
		},
		resume() {
			paused = false;
			still = null;
		},
		get state() {
			return paused ? 'paused' : state;
		},
	};
}
