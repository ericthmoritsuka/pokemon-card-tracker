// Finds the four corners of a card in a photo, on the phone, with no paid
// service (DESIGN.md section 5, "Own photos, cropped to the card").
//
// The scanner's card finder runs first (findCard, js/scan/steady.js): it
// looks for card-shaped 63:88 boxes of straight lines anywhere in the photo,
// at any tilt, and chooses the card among them (the card on top of a pile,
// the card's edge round its inner border, not the art box). When the box it
// returns is the card's inner border line (a silver card on a silver table,
// whose outer edge barely shows), the faint outer edge is looked for a
// border's width outside it, and the corners move out to it.
//
// When findCard finds nothing, two older finders run, and the
// better-supported answer wins:
//
//   outline  Separates the card from a plain, contrasting background
//            (Otsu's threshold), takes the largest blob that is not the
//            background, and fits a straight line to each of its four sides,
//            leaving out the rounded corners. The lines' crossings are the
//            corners, so a card seen at an angle keeps its true shape.
//   rectify  The scan lab's benchmarked edge finder (js/vision/rectify.js): it
//            measures the card's tilt, turns it straight, and crops to its
//            edges. Its crop is turned back into four corners. It expects the
//            card to fill most of the frame, as the scanner's guide does.
//
// Each answer is scored by how strongly the photo changes brightness across
// all four of its sides. Pure functions over ImageData-shaped objects, so
// Node tests them (tests/photos.test.mjs).

import {findCard} from '../scan/steady.js';
import {rectify} from '../vision/rectify.js';

import {
	CARD_ASPECT,
	cornersFromRect,
	defaultCorners,
	distance,
	isConvexQuad,
	orderCorners,
	portraitCorners,
	quadArea,
	quadSize,
	scaleCorners,
} from './geometry.js';

// Detection reads a copy at most this many pixels on its long side.
export const DETECT_SIDE = 640;

// Area-averaged downscale, so thin card borders survive the shrink.
export function shrink(img, maxSide = DETECT_SIDE) {
	const scale = Math.min(1, maxSide / Math.max(img.width, img.height));

	if (scale === 1) {
		return {image: img, scale: 1};
	}

	const width = Math.max(1, Math.round(img.width * scale));
	const height = Math.max(1, Math.round(img.height * scale));
	const data = new Uint8ClampedArray(width * height * 4);
	const step = 1 / scale;

	for (let y = 0; y < height; y++) {
		const y0 = Math.floor(y * step);
		const y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor((y + 1) * step)));

		for (let x = 0; x < width; x++) {
			const x0 = Math.floor(x * step);
			const x1 = Math.min(img.width, Math.max(x0 + 1, Math.floor((x + 1) * step)));
			let r = 0;
			let g = 0;
			let b = 0;
			let n = 0;

			// At most 3 x 3 samples per output pixel: enough to keep edges,
			// cheap on a 12-megapixel photo.
			const sy = Math.max(1, Math.floor((y1 - y0) / 3));
			const sx = Math.max(1, Math.floor((x1 - x0) / 3));

			for (let yy = y0; yy < y1; yy += sy) {
				for (let xx = x0; xx < x1; xx += sx) {
					const i = (yy * img.width + xx) * 4;

					r += img.data[i];
					g += img.data[i + 1];
					b += img.data[i + 2];
					n++;
				}
			}

			const o = (y * width + x) * 4;

			data[o] = r / n;
			data[o + 1] = g / n;
			data[o + 2] = b / n;
			data[o + 3] = 255;
		}
	}

	return {image: {data, height, width}, scale: width / img.width};
}

export function greyOf(img) {
	const grey = new Float32Array(img.width * img.height);

	for (let i = 0, j = 0; i < grey.length; i++, j += 4) {
		grey[i] = 0.299 * img.data[j] + 0.587 * img.data[j + 1] + 0.114 * img.data[j + 2];
	}

	return grey;
}

// Otsu's threshold over 256 grey levels.
export function otsu(grey) {
	const hist = new Float64Array(256);

	for (const value of grey) {
		hist[Math.min(255, Math.max(0, Math.round(value)))]++;
	}

	const total = grey.length;
	let sum = 0;

	for (let i = 0; i < 256; i++) {
		sum += i * hist[i];
	}

	let best = 0;
	let threshold = 127;
	let weightB = 0;
	let sumB = 0;

	for (let t = 0; t < 256; t++) {
		weightB += hist[t];

		if (!weightB) {
			continue;
		}

		const weightF = total - weightB;

		if (!weightF) {
			break;
		}

		sumB += t * hist[t];

		const meanB = sumB / weightB;
		const meanF = (sum - sumB) / weightF;
		const between = weightB * weightF * (meanB - meanF) ** 2;

		if (between > best) {
			best = between;
			threshold = t;
		}
	}

	return threshold;
}

// The largest 4-connected blob of `mask` that does not reach two opposite
// edges of the image (that is the background). Returns its label array and
// its id, or null.
function largestBlob(mask, width, height) {
	const labels = new Int32Array(width * height);
	const queue = new Int32Array(width * height);
	let next = 0;
	let best = null;

	for (let start = 0; start < mask.length; start++) {
		if (!mask[start] || labels[start]) {
			continue;
		}

		next++;

		let head = 0;
		let tail = 0;
		let area = 0;
		let minX = width;
		let maxX = 0;
		let minY = height;
		let maxY = 0;

		queue[tail++] = start;
		labels[start] = next;

		while (head < tail) {
			const i = queue[head++];
			const x = i % width;
			const y = (i - x) / width;

			area++;
			minX = Math.min(minX, x);
			maxX = Math.max(maxX, x);
			minY = Math.min(minY, y);
			maxY = Math.max(maxY, y);

			const near = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1];

			for (const j of near) {
				if (j >= 0 && mask[j] && !labels[j]) {
					labels[j] = next;
					queue[tail++] = j;
				}
			}
		}

		const spansX = minX === 0 && maxX === width - 1;
		const spansY = minY === 0 && maxY === height - 1;

		if (!spansX && !spansY && (!best || area > best.area)) {
			best = {area, id: next};
		}
	}

	return best ? {area: best.area, id: best.id, labels} : null;
}

// The blob's outline: the first and last blob pixel of every row and
// column.
function outline(labels, id, width, height) {
	const points = [];

	for (let y = 0; y < height; y++) {
		let first = -1;
		let last = -1;

		for (let x = 0; x < width; x++) {
			if (labels[y * width + x] === id) {
				if (first < 0) {
					first = x;
				}

				last = x;
			}
		}

		if (first >= 0) {
			points.push({x: first, y}, {x: last + 1, y});
		}
	}

	for (let x = 0; x < width; x++) {
		let first = -1;
		let last = -1;

		for (let y = 0; y < height; y++) {
			if (labels[y * width + x] === id) {
				if (first < 0) {
					first = y;
				}

				last = y;
			}
		}

		if (first >= 0) {
			points.push({x, y: first}, {x, y: last + 1});
		}
	}

	return points;
}

// Total least squares line through points: {point, direction}.
function fitLine(points) {
	let mx = 0;
	let my = 0;

	for (const p of points) {
		mx += p.x;
		my += p.y;
	}

	mx /= points.length;
	my /= points.length;

	let sxx = 0;
	let sxy = 0;
	let syy = 0;

	for (const p of points) {
		const dx = p.x - mx;
		const dy = p.y - my;

		sxx += dx * dx;
		sxy += dx * dy;
		syy += dy * dy;
	}

	const angle = Math.atan2(2 * sxy, sxx - syy) / 2;

	return {direction: {x: Math.cos(angle), y: Math.sin(angle)}, point: {x: mx, y: my}};
}

const residual = (line, p) => Math.abs((p.x - line.point.x) * line.direction.y - (p.y - line.point.y) * line.direction.x);

function intersect(a, b) {
	const det = a.direction.x * b.direction.y - a.direction.y * b.direction.x;

	if (Math.abs(det) < 1e-9) {
		return null;
	}

	const dx = b.point.x - a.point.x;
	const dy = b.point.y - a.point.y;
	const t = (dx * b.direction.y - dy * b.direction.x) / det;

	return {x: a.point.x + a.direction.x * t, y: a.point.y + a.direction.y * t};
}

// Where p falls along segment a-b (0 to 1) and how far it is from it.
function project(p, a, b) {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const length2 = dx * dx + dy * dy || 1;
	const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2;
	const cx = a.x + dx * t;
	const cy = a.y + dy * t;

	return {distance: Math.hypot(p.x - cx, p.y - cy), t};
}

// Moves rough corners onto the crossings of lines fitted to the outline's
// four sides. The middle 76 percent of each side is used, which leaves out
// the card's rounded corners. Returns the rough corners when a side has too
// few points or the result moves too far.
export function refineCorners(rough, points) {
	const diagonal = distance(rough[0], rough[2]);
	const sides = [[], [], [], []];

	for (const p of points) {
		let best = -1;
		let bestDistance = diagonal * 0.05;

		for (let s = 0; s < 4; s++) {
			const {distance: d, t} = project(p, rough[s], rough[(s + 1) % 4]);

			if (t > 0.12 && t < 0.88 && d < bestDistance) {
				best = s;
				bestDistance = d;
			}
		}

		if (best >= 0) {
			sides[best].push(p);
		}
	}

	const lines = [];

	for (const side of sides) {
		if (side.length < 8) {
			return rough;
		}

		let line = fitLine(side);
		const residuals = side.map((p) => residual(line, p)).sort((a, b) => a - b);
		const limit = Math.max(1.5, residuals[Math.floor(residuals.length / 2)] * 3);
		const kept = side.filter((p) => residual(line, p) <= limit);

		if (kept.length >= 8) {
			line = fitLine(kept);
		}

		lines.push(line);
	}

	const corners = [];

	for (let s = 0; s < 4; s++) {
		const corner = intersect(lines[(s + 3) % 4], lines[s]);

		if (!corner || distance(corner, rough[s]) > diagonal * 0.08) {
			return rough;
		}

		corners.push(corner);
	}

	return isConvexQuad(corners) ? corners : rough;
}

function outlineQuad(img, grey, bright) {
	const {height, width} = img;
	const threshold = otsu(grey);
	const mask = new Uint8Array(grey.length);

	for (let i = 0; i < grey.length; i++) {
		mask[i] = bright ? grey[i] > threshold : grey[i] <= threshold;
	}

	const blob = largestBlob(mask, width, height);

	if (!blob || blob.area < width * height * 0.04) {
		return null;
	}

	const points = outline(blob.labels, blob.id, width, height);
	const rough = orderCorners(points);

	if (!rough || !isConvexQuad(rough)) {
		return null;
	}

	return refineCorners(rough, points);
}

// Mean brightness change across the side a-b, sampled along its middle.
function sideContrast(grey, width, height, a, b) {
	const length = distance(a, b);
	const nx = -(b.y - a.y) / (length || 1);
	const ny = (b.x - a.x) / (length || 1);
	const at = (x, y) => grey[Math.min(height - 1, Math.max(0, Math.round(y))) * width + Math.min(width - 1, Math.max(0, Math.round(x)))];
	let sum = 0;
	let n = 0;

	for (let t = 0.1; t <= 0.9; t += 0.02) {
		const x = a.x + (b.x - a.x) * t;
		const y = a.y + (b.y - a.y) * t;

		sum += Math.abs(at(x + nx * 3, y + ny * 3) - at(x - nx * 3, y - ny * 3));
		n++;
	}

	return sum / n;
}

// How believable a quad is as the card: the weakest side's contrast, scaled
// down when the shape is far from a card's. Zero when it cannot be a card.
export function scoreQuad(grey, width, height, quad) {
	if (!quad || !isConvexQuad(quad)) {
		return 0;
	}

	const area = quadArea(quad);

	if (area < width * height * 0.04) {
		return 0;
	}

	const {height: h, width: w} = quadSize(quad);
	const aspect = w / h;

	if (aspect < 0.45 || aspect > 1.05) {
		return 0;
	}

	const sides = [0, 1, 2, 3].map((s) => sideContrast(grey, width, height, quad[s], quad[(s + 1) % 4]));
	const shape = Math.max(0.2, 1 - Math.abs(aspect - CARD_ASPECT) / CARD_ASPECT);

	return Math.min(...sides) * shape;
}

function rectifyQuad(img) {
	let result;

	try {
		result = rectify(img);
	}
	catch {
		return null;
	}

	if (!result.found || !result.rect) {
		return null;
	}

	return cornersFromRect(result.rect, result.angle, img.width, img.height);
}

// Below this score the photo has no clear card outline, and the handles
// start at a card-shaped box in the middle for the person to place.
const MIN_SCORE = 12;

// Below this score (the weakest side's contrast) a found card's outline is
// faint, and the editor suggests a contrasting surface.
const SURE_SCORE = 16;

// findCard reads a copy this many pixels on its long side, as the scanner
// does at the moment of capture (FIND_SIDE_CAPTURE).
const FIND_SIDE = 360;

// A card's border, between its edge and its inner line, as a share of its
// width: looked for between these, and the gaps found on different sides
// must agree within BORDER_SPREAD.
const BORDER_MIN = 0.012;
const BORDER_MAX = 0.1;
const BORDER_SPREAD = 0.035;

const sample = (grey, width, height, x, y) => {
	const xi = Math.min(width - 1, Math.max(0, Math.round(x)));
	const yi = Math.min(height - 1, Math.max(0, Math.round(y)));

	return grey[yi * width + xi];
};

// For the side a-b of a clockwise quad: the strongest straight brightness
// step parallel to it, between BORDER_MIN and BORDER_MAX of the card's width
// outside it. The step's sign must hold along the side (a real edge), so
// noise averages away. Returns {gap, strength, noise, plain}: plain is how
// much the band between the side and the step varies (a card's border is
// one colour).
function outerStep(grey, width, height, a, b, cardWidth) {
	const length = distance(a, b) || 1;
	const ux = (b.x - a.x) / length;
	const uy = (b.y - a.y) / length;
	// Outward, for a quad clockwise on the screen.
	const nx = uy;
	const ny = -ux;
	const from = Math.max(2, Math.round(cardWidth * BORDER_MIN));
	const to = Math.round(cardWidth * BORDER_MAX);
	const profile = [];

	for (let k = from; k <= to; k++) {
		let sum = 0;
		let n = 0;

		for (let t = 0.15; t <= 0.85; t += 0.01) {
			const x = a.x + (b.x - a.x) * t + nx * k;
			const y = a.y + (b.y - a.y) * t + ny * k;

			if (x < 1 || y < 1 || x > width - 2 || y > height - 2) {
				continue;
			}

			sum += sample(grey, width, height, x + nx, y + ny) - sample(grey, width, height, x - nx, y - ny);
			n++;
		}

		profile.push(n > 10 ? Math.abs(sum / n) : 0);
	}

	if (!profile.length) {
		return null;
	}

	let best = 0;

	profile.forEach((value, i) => {
		if (value > profile[best]) {
			best = i;
		}
	});

	const sorted = [...profile].sort((p, q) => p - q);
	const gap = from + best;
	let sum = 0;
	let squares = 0;
	let n = 0;

	for (let t = 0.15; t <= 0.85; t += 0.02) {
		for (const share of [0.3, 0.5, 0.7]) {
			const value = sample(grey, width, height, a.x + (b.x - a.x) * t + nx * gap * share, a.y + (b.y - a.y) * t + ny * gap * share);

			sum += value;
			squares += value * value;
			n++;
		}
	}

	return {
		gap,
		noise: sorted[Math.floor(sorted.length / 2)],
		plain: Math.sqrt(Math.max(0, squares / n - (sum / n) ** 2)),
		strength: profile[best],
	};
}

// Moves the corners of a card's inner border line out to its faint outer
// edge, when one shows a border's width outside at least three sides with
// agreeing gaps (the fourth side takes their mean). Returns {quad, sides}
// (sides: how many sides showed the edge), or null when the quad already
// is the card's edge.
export function outerEdge(grey, width, height, quad) {
	const cardWidth = quadSize(quad).width;
	const steps = [0, 1, 2, 3].map((s) => outerStep(grey, width, height, quad[s], quad[(s + 1) % 4], cardWidth));
	const shown = steps.map((step) => (step && step.strength >= Math.max(1.5, step.noise * 3) && step.plain < 12 ? step.gap : null));
	const gaps = shown.filter((gap) => gap !== null);

	if (gaps.length < 3 || Math.max(...gaps) - Math.min(...gaps) > cardWidth * BORDER_SPREAD) {
		return null;
	}

	const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
	const lines = quad.map((a, s) => {
		const b = quad[(s + 1) % 4];
		const length = distance(a, b) || 1;
		const direction = {x: (b.x - a.x) / length, y: (b.y - a.y) / length};
		const gap = shown[s] ?? mean;

		return {direction, point: {x: a.x + direction.y * gap, y: a.y - direction.x * gap}};
	});
	const corners = [];

	for (let s = 0; s < 4; s++) {
		const corner = intersect(lines[(s + 3) % 4], lines[s]);

		if (!corner) {
			return null;
		}

		corners.push(corner);
	}

	return isConvexQuad(corners) ? {quad: corners, sides: gaps.length} : null;
}

// Fits each side of a clockwise quad to the strongest brightness step
// within `reach` pixels across it, sampled along its middle 76 percent
// (a card's corners are rounded), and puts the corners where the fitted
// lines cross. A side with too few clear steps keeps its line; the quad is
// kept when the result is not convex or moves a corner further than reach
// twice over.
export function refineSides(grey, width, height, quad, reach) {
	const lines = quad.map((a, s) => {
		const b = quad[(s + 1) % 4];
		const length = distance(a, b) || 1;
		const ux = (b.x - a.x) / length;
		const uy = (b.y - a.y) / length;
		const points = [];

		for (let t = 0.12; t <= 0.88; t += 0.01) {
			const cx = a.x + (b.x - a.x) * t;
			const cy = a.y + (b.y - a.y) * t;
			let best = 0;
			let at = null;

			for (let k = -reach; k <= reach; k += 0.5) {
				const x = cx + uy * k;
				const y = cy - ux * k;
				const step = Math.abs(sample(grey, width, height, x + uy, y - ux) - sample(grey, width, height, x - uy, y + ux));

				if (step > best) {
					best = step;
					at = {x, y};
				}
			}

			if (at && best >= 6) {
				points.push(at);
			}
		}

		const own = {direction: {x: ux, y: uy}, point: a};

		if (points.length < 12) {
			return own;
		}

		let line = fitLine(points);
		const residuals = points.map((p) => residual(line, p)).sort((p, q) => p - q);
		const limit = Math.max(1, residuals[Math.floor(residuals.length / 2)] * 2.5);
		const kept = points.filter((p) => residual(line, p) <= limit);

		if (kept.length >= 12) {
			line = fitLine(kept);
		}

		return line;
	});
	const corners = [];

	for (let s = 0; s < 4; s++) {
		const corner = intersect(lines[(s + 3) % 4], lines[s]);

		if (!corner || distance(corner, quad[s]) > reach * 2) {
			return quad;
		}

		corners.push(corner);
	}

	return isConvexQuad(corners) ? corners : quad;
}

// Whether `inner` lies inside the clockwise box `outer` (give or take 1.5
// percent of its width: findCard's boxes can mix lines), with every side's
// gap at most a card border's width (BORDER_MAX, with some slack).
function borderAround(outer, inner) {
	const width = quadSize(outer).width;

	return outer.every((a, s) => {
		const b = outer[(s + 1) % 4];
		const length = distance(a, b) || 1;
		// Inward distance from the side a-b, for a box clockwise on the screen.
		const gaps = inner.map((p) => ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / length);
		const gap = Math.min(...gaps);

		return gap >= -width * 0.015 && gap <= width * BORDER_MAX * 1.3;
	});
}

// The scanner's finder on a FIND_SIDE copy, in `work`'s pixels, moved out
// to the card's outer edge when the box found is its inner border.
function cardQuad(work, grey) {
	const {image: small, scale} = shrink(work, FIND_SIDE);
	const debug = {};
	let found;

	try {
		found = findCard(small === work ? grey : greyOf(small), small.width, small.height, {debug});
	}
	catch {
		return null;
	}

	if (!found.quad) {
		return null;
	}

	// The scanner's guide frame keeps a card off a table's own edges, and
	// findCard takes a box with a plain ring round it for a card lying in a
	// tray. In a photo that ring is more often the card's own border, so
	// the largest card-shaped box round the found one, a border's width
	// out, is the card.
	const around = (debug.boxes || [])
		.filter((box) => borderAround(box.corners, found.quad))
		.sort((a, b) => quadArea(b.corners) - quadArea(a.corners))[0];

	// findCard's lines are whole degrees and pixels on a small copy; each
	// side is fitted again to the edge on the larger one, nearer each time.
	let quad = portraitCorners(scaleCorners(around ? around.corners : found.quad, 1 / scale));

	for (const reach of [0.05, 0.02, 0.008]) {
		quad = refineSides(grey, work.width, work.height, quad, quadSize(quad).width * reach);
	}

	const outer = outerEdge(grey, work.width, work.height, quad);

	return outer ? {method: 'card-edge', quad: outer.quad} : {method: 'card', quad};
}

// Finds the card's corners in `img` (any size; detection reads a copy of at
// most DETECT_SIDE pixels). Returns {corners, found, method, note, score,
// unsure}, with corners in `img`'s own pixels, top-left first, clockwise;
// unsure is true when the card's outline was faint or not found.
export function detectCorners(img) {
	const {image: work, scale} = shrink(img);
	const grey = greyOf(work);
	const card = cardQuad(work, grey);
	let best = card ? {...card, score: scoreQuad(grey, work.width, work.height, card.quad)} : null;

	if (!card) {
		const candidates = [
			{method: 'outline', quad: outlineQuad(work, grey, true)},
			{method: 'outline', quad: outlineQuad(work, grey, false)},
			{method: 'rectify', quad: rectifyQuad(work)},
		];

		for (const candidate of candidates) {
			if (!candidate.quad) {
				continue;
			}

			const quad = portraitCorners(candidate.quad);
			const score = scoreQuad(grey, work.width, work.height, quad);

			if (!best || score > best.score) {
				best = {...candidate, quad, score};
			}
		}
	}

	// findCard's box stands on its own: its sides were drawn and its shape
	// is a card's, even where the outline's contrast is faint.
	if (!best || (!card && best.score < MIN_SCORE)) {
		return {
			corners: defaultCorners(img.width, img.height),
			found: false,
			method: 'none',
			note: 'Could not find the card\'s edges. Drag each corner onto a corner of the card.',
			score: best ? best.score : 0,
			unsure: true,
		};
	}

	return {
		corners: scaleCorners(best.quad, 1 / scale),
		found: true,
		method: best.method,
		note: 'Card found. Drag a corner if it is off.',
		score: Math.round(best.score * 10) / 10,
		unsure: best.method === 'card-edge' || best.score < SURE_SCORE,
	};
}
