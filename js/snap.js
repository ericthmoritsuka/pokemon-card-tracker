// Snap points for the corner editor (js/corners.js): the places a dragged
// corner handle jumps to when it comes near, worked out once when the
// editor opens. Pure functions over a grey copy of the picture, so Node
// tests them (tests/snap.test.mjs).
//
// A snap point is a corner of a card-shaped 63:88 box the scanner's finder
// sees (findCard, js/scan/steady.js), or a strong edge meeting: two straight
// edges crossing near square, each drawn clearly along a short arm from the
// crossing (a card's or a cover's corner). The caller adds its own detected
// corners.

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
const ARM_STEP = 14;

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
// x cos theta + y sin theta = rho). Returns [{x, y, strength}].
function meetings(grey, width, height, lines) {
	const short = Math.min(width, height);
	const length = Math.max(4, Math.round(short * ARM));
	const found = [];

	for (let i = 0; i < lines.length; i++) {
		for (let j = i + 1; j < lines.length; j++) {
			const a = lines[i];
			const b = lines[j];
			let gap = Math.abs(a.theta - b.theta) % 180;

			gap = gap > 90 ? 180 - gap : gap;

			if (Math.abs(gap - 90) > 12) {
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

			// Each line's direction is along it: (-ny, nx). Its stronger arm.
			const armA = Math.max(armStep(grey, width, height, p, ax, ay, -ay, ax, length), armStep(grey, width, height, p, ax, ay, ay, -ax, length));
			const armB = Math.max(armStep(grey, width, height, p, bx, by, -by, bx, length), armStep(grey, width, height, p, bx, by, by, -bx, length));
			const strength = Math.min(armA, armB);

			if (strength >= ARM_STEP) {
				found.push({strength, x: p.x, y: p.y});
			}
		}
	}

	return found.sort((p, q) => q.strength - p.strength);
}

// The snap points of a grey copy (width x height pixels), in the copy's
// pixels: the corners of every card-shaped box findCard considered, then
// strong edge meetings, nearer than 2 percent of the short side to none
// before them. `extra` points come first.
export function snapPoints(grey, width, height, {extra = []} = {}) {
	const debug = {};

	try {
		findCard(grey, width, height, {debug});
	}
	catch {
		debug.boxes = [];
		debug.lines = [];
	}

	const boxCorners = (debug.boxes || []).flatMap((box) => box.corners);
	const all = [...extra, ...boxCorners, ...meetings(grey, width, height, debug.lines || [])];
	const near = Math.min(width, height) * 0.02;
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
