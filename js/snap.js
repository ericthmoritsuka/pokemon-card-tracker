// Snap points for the corner editor (js/corners.js): the places a dragged
// corner handle jumps to when it comes near, worked out once when the
// editor opens. Pure functions over a grey copy of the picture, so Node
// tests them (tests/snap.test.mjs).
//
// A snap point is a corner of a card-shaped 63:88 box the scanner's finder
// sees (findCard, js/scan/steady.js), drawn about as well as the best one,
// or a strong edge meeting that looks like a real card corner: two straight
// edges meeting near square, each drawn clearly along a short arm on one
// side of the meeting and not on the other (an L, not a crossing in the
// art), with two more points that make it three corners of a 63:88 box.
// The caller adds its own detected corners. Fewer points, fewer wrong snaps
// (Eric, 2026-10-16).

import {findCard} from './scan/steady.js';

// How far a dragged corner is pulled to a snap point, as a share of the
// picture's short side.
export const SNAP_RADIUS = 0.03;

// The copy's long side, in pixels.
export const SNAP_SIDE = 360;

// At most this many snap points, strongest first.
const MAX_POINTS = 24;

// An edge meeting's arms: as long as this share of the short side, with a
// mean brightness step across them of at least ARM_STEP levels.
const ARM = 0.04;
const ARM_STEP = 18;

// An edge meeting's two edges are this near square, in degrees.
const SQUARE_DEG = 6;

// Past the meeting, each edge's step is under this share of its arm's: the
// edge ends there.
const L_END = 0.5;

// Boxes drawn within this much of the best box's quality give corners; at
// most BOX_MAX of them.
const BOX_QUALITY = 0.3;
const BOX_MAX = 6;

// A card's short side over its long side, and how far a meeting's three
// corners may be from that shape, as a share of the short side.
const CARD_RATIO = 63 / 88;
const SHAPE_NEAR = 0.035;

const DEG = Math.PI / 180;

function at(grey, width, height, x, y) {
	const xi = Math.min(width - 1, Math.max(0, Math.round(x)));
	const yi = Math.min(height - 1, Math.max(0, Math.round(y)));

	return grey[yi * width + xi];
}

// The mean step across a line (unit normal nx, ny) along `length` pixels
// from p in the direction (dx, dy).
function armStep(grey, width, height, p, nx, ny, dx, dy, length) {
	let sum = 0;
	let n = 0;

	for (let s = 2; s <= length; s++) {
		const x = p.x + dx * s;
		const y = p.y + dy * s;

		if (x < 1 || y < 1 || x > width - 2 || y > height - 2) {
			return 0;
		}

		sum += Math.abs(at(grey, width, height, x + nx * 1.5, y + ny * 1.5) - at(grey, width, height, x - nx * 1.5, y - ny * 1.5));
		n++;
	}

	return n ? sum / n : 0;
}

// Strong edge meetings among findCard's lines ({rho, theta (degrees)}:
// x cos theta + y sin theta = rho), each an L: both edges drawn along an arm
// from the meeting and ending there. Returns [{x, y, strength, arms}], arms
// the two unit directions the edges run in from the meeting.
function meetings(grey, width, height, lines) {
	const short = Math.min(width, height);
	const length = Math.max(4, Math.round(short * ARM));
	const found = [];

	// The edge (unit normal nx, ny) at p: the direction its drawn arm runs
	// in, and how strongly, or null when it is not an edge ending at p.
	const edge = (p, nx, ny) => {
		const one = armStep(grey, width, height, p, nx, ny, -ny, nx, length);
		const two = armStep(grey, width, height, p, nx, ny, ny, -nx, length);
		const strong = Math.max(one, two);

		if (strong < ARM_STEP || Math.min(one, two) >= strong * L_END) {
			return null;
		}

		return one >= two ? {dx: -ny, dy: nx, step: one} : {dx: ny, dy: -nx, step: two};
	};

	for (let i = 0; i < lines.length; i++) {
		for (let j = i + 1; j < lines.length; j++) {
			const a = lines[i];
			const b = lines[j];
			let gap = Math.abs(a.theta - b.theta) % 180;

			gap = gap > 90 ? 180 - gap : gap;

			if (Math.abs(gap - 90) > SQUARE_DEG) {
				continue;
			}

			const ax = Math.cos(a.theta * DEG);
			const ay = Math.sin(a.theta * DEG);
			const bx = Math.cos(b.theta * DEG);
			const by = Math.sin(b.theta * DEG);
			const det = ax * by - ay * bx;

			if (Math.abs(det) < 1e-6) {
				continue;
			}

			const p = {x: (a.rho * by - b.rho * ay) / det, y: (ax * b.rho - bx * a.rho) / det};

			if (p.x < 0 || p.y < 0 || p.x > width - 1 || p.y > height - 1) {
				continue;
			}

			const armA = edge(p, ax, ay);
			const armB = armA && edge(p, bx, by);

			if (armB) {
				found.push({arms: [armA, armB], strength: Math.min(armA.step, armB.step), x: p.x, y: p.y});
			}
		}
	}

	return found.sort((p, q) => q.strength - p.strength);
}

// Whether meeting m and two of `pool`'s points make three corners of a
// 63:88 box: one point along an arm at distance d, and one along the other
// arm at d times 88:63 or 63:88.
function cardShaped(m, pool, short) {
	const near = short * SHAPE_NEAR;
	const has = (x, y) => pool.some((q) => Math.hypot(q.x - x, q.y - y) <= near);

	for (const [along, across] of [[m.arms[0], m.arms[1]], [m.arms[1], m.arms[0]]]) {
		for (const q of pool) {
			const dx = q.x - m.x;
			const dy = q.y - m.y;
			const d = dx * along.dx + dy * along.dy;

			// Along the arm, a sixth of the short side away or more.
			if (d < short / 6 || Math.abs(dx * along.dy - dy * along.dx) > near) {
				continue;
			}

			for (const k of [1 / CARD_RATIO, CARD_RATIO]) {
				if (has(m.x + across.dx * d * k, m.y + across.dy * d * k)) {
					return true;
				}
			}
		}
	}

	return false;
}

// The snap points of a grey copy (width x height pixels), in the copy's
// pixels: the corners of the card-shaped boxes findCard drew about as well
// as its best, then the edge meetings that look like card corners, nearer
// than 2 percent of the short side to none before them. `extra` points come
// first.
export function snapPoints(grey, width, height, {extra = []} = {}) {
	const debug = {};

	try {
		findCard(grey, width, height, {debug});
	}
	catch {
		debug.boxes = [];
		debug.lines = [];
	}

	const boxes = debug.boxes || [];
	const top = Math.max(-Infinity, ...boxes.map((box) => box.quality));
	const boxCorners = boxes.filter((box) => box.quality >= top - BOX_QUALITY).slice(0, BOX_MAX).flatMap((box) => box.corners);
	const short = Math.min(width, height);
	const candidates = meetings(grey, width, height, debug.lines || []).slice(0, 60);
	const pool = [...extra, ...boxCorners, ...candidates];
	const all = [...extra, ...boxCorners, ...candidates.filter((m) => cardShaped(m, pool, short))];
	const near = short * 0.02;
	const kept = [];

	for (const p of all) {
		if (kept.length >= MAX_POINTS + extra.length) {
			break;
		}

		if (!kept.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < near)) {
			kept.push({x: p.x, y: p.y});
		}
	}

	return kept;
}

// The snap point nearest p within `radius`, or null.
export function nearestSnap(p, points, radius) {
	let best = null;
	let bestDistance = radius;

	for (const q of points) {
		const d = Math.hypot(p.x - q.x, p.y - q.y);

		if (d <= bestDistance) {
			best = q;
			bestDistance = d;
		}
	}

	return best;
}
