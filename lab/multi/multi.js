// The multi-card lab page, driven by lab/multi/run.mjs: synthetic camera
// frames holding several cards, made from the scan benchmark's TCGdex card
// images, and the two ways of finding the cards in them, each card then
// matched by the app's own picture route (js/scan/identify.js
// identifyPicture: straighten, fingerprint, match), as the single-card
// scanner matches one.
//
// - page: a binder page, 3 x 3 pockets in sleeves, seen from above at a
//   slight slant: sleeve glare bands, pocket welds, a few empty pockets.
// - loose: 2 to 5 cards lying apart on a textured table, turned a little,
//   now and then two of them touching.
//
// The two paths:
//
// - page (js/scan/steady.js findPages, js/scan/multi.js pageCells): find the
//   page's outline (or a spread's two), cut it into rows x cols pockets,
//   and match each pocket as one capture.
// - free (js/scan/steady.js findCards): find every card-shaped outline in
//   the frame, clear of each other, and match each as the scanner matches
//   the card it finds in the frame (a box round it, its outline passed on).
//
// Every scene is made from a seed, so every run sees the same frames.

import {boxAround, viewFrame} from '../../js/scan/camera.js';
import {identifyPicture, identifyText} from '../../js/scan/identify.js';
import {findCandidates} from '../../js/scan/match.js';
import {fitPage, pageCells, pageShape, quadPoint, splitSpread} from '../../js/scan/multi.js';
import {loadFingerprints, NOT_CARD_DISTANCE, pictureMatch, pictureVerdict} from '../../js/scan/picture.js';
import {warpQuad} from '../../js/scan/rectify.js';
import {summariseRead} from '../../js/scan/session.js';
import {colourfulness, COLOURLESS, FIND_SIDE_CAPTURE, findCard, findCards, findPages, toGrey} from '../../js/scan/steady.js';

// The camera frame, as the scan benchmark's frame mode makes it: portrait
// 1080 x 1920.
const FRAME = {height: 1920, width: 1080};
const CARD = 63 / 88;

function seeded(text) {
	let h = 2166136261;

	for (const ch of text) {
		h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
	}

	return () => {
		h = Math.imul(h ^ (h >>> 15), 2246822507);
		h = Math.imul(h ^ (h >>> 13), 3266489909);
		h ^= h >>> 16;

		return (h >>> 0) / 4294967296;
	};
}

const between = (rand, lo, hi) => lo + rand() * (hi - lo);

const bitmaps = new Map();

function bitmapOf(src) {
	if (!bitmaps.has(src)) {
		bitmaps.set(src, fetch(src).then((response) => response.blob()).then((blob) => createImageBitmap(blob)));
	}

	return bitmaps.get(src);
}

// ------------------------------------------------------------ geometry

// The 3 x 3 projective map taking the four points `from` to `to`.
function homography(from, to) {
	const a = [];

	for (let i = 0; i < 4; i++) {
		const {x, y} = from[i];
		const {x: u, y: v} = to[i];

		a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
		a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
	}

	// Gaussian elimination with partial pivoting on the 8 x 9 system.
	for (let c = 0; c < 8; c++) {
		let pivot = c;

		for (let r = c + 1; r < 8; r++) {
			if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) {
				pivot = r;
			}
		}

		[a[c], a[pivot]] = [a[pivot], a[c]];

		for (let r = 0; r < 8; r++) {
			if (r !== c) {
				const f = a[r][c] / a[c][c];

				for (let k = c; k < 9; k++) {
					a[r][k] -= f * a[c][k];
				}
			}
		}
	}

	return [...a.map((row, i) => row[8] / row[i]), 1];
}

function invert(m) {
	const [a, b, c, d, e, f, g, h, i] = m;
	const A = e * i - f * h;
	const B = -(d * i - f * g);
	const C = d * h - e * g;
	const det = a * A + b * B + c * C;

	return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det);
}

const project = (m, {x, y}) => {
	const w = m[6] * x + m[7] * y + m[8];

	return {x: (m[0] * x + m[1] * y + m[2]) / w, y: (m[3] * x + m[4] * y + m[5]) / w};
};

// Draws `src` (ImageData) into `dst` (ImageData) through the map `m` (src to
// dst), bilinear, over the box round `quad` (src's corners in dst).
function warpInto(dst, src, m, quad) {
	const back = invert(m);
	const x0 = Math.max(0, Math.floor(Math.min(...quad.map((p) => p.x))));
	const x1 = Math.min(dst.width - 1, Math.ceil(Math.max(...quad.map((p) => p.x))));
	const y0 = Math.max(0, Math.floor(Math.min(...quad.map((p) => p.y))));
	const y1 = Math.min(dst.height - 1, Math.ceil(Math.max(...quad.map((p) => p.y))));
	const s = src.data;
	const d = dst.data;
	const sw = src.width;

	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) {
			const w = back[6] * (x + 0.5) + back[7] * (y + 0.5) + back[8];
			const sx = (back[0] * (x + 0.5) + back[1] * (y + 0.5) + back[2]) / w - 0.5;
			const sy = (back[3] * (x + 0.5) + back[4] * (y + 0.5) + back[5]) / w - 0.5;

			if (sx < 0 || sy < 0 || sx >= src.width - 1 || sy >= src.height - 1) {
				continue;
			}

			const ix = Math.floor(sx);
			const iy = Math.floor(sy);
			const fx = sx - ix;
			const fy = sy - iy;
			const i00 = (iy * sw + ix) * 4;
			const i10 = i00 + 4;
			const i01 = i00 + sw * 4;
			const i11 = i01 + 4;
			const o = (y * dst.width + x) * 4;

			for (let c = 0; c < 3; c++) {
				d[o + c] = (s[i00 + c] * (1 - fx) + s[i10 + c] * fx) * (1 - fy) + (s[i01 + c] * (1 - fx) + s[i11 + c] * fx) * fy;
			}

			d[o + 3] = 255;
		}
	}
}

// The corners (top left first, clockwise) of a w x h box centred on (cx,
// cy), turned `angle` degrees clockwise.
function boxCorners(cx, cy, w, h, angle) {
	const r = (angle * Math.PI) / 180;
	const cos = Math.cos(r);
	const sin = Math.sin(r);

	return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => ({x: cx + x * cos - y * sin, y: cy + x * sin + y * cos}));
}

function pointIn(p, corners) {
	let sign = 0;

	for (let i = 0; i < 4; i++) {
		const a = corners[i];
		const b = corners[(i + 1) % 4];
		const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);

		if (sign && Math.sign(cross) !== sign) {
			return false;
		}

		sign = Math.sign(cross) || sign;
	}

	return true;
}

// Whether two convex quads overlap (separating axis test).
function overlaps(a, b) {
	for (const poly of [a, b]) {
		for (let i = 0; i < 4; i++) {
			const p = poly[i];
			const q = poly[(i + 1) % 4];
			const n = {x: q.y - p.y, y: p.x - q.x};
			const span = (list) => list.map((c) => c.x * n.x + c.y * n.y);
			const sa = span(a);
			const sb = span(b);

			if (Math.max(...sa) < Math.min(...sb) || Math.max(...sb) < Math.min(...sa)) {
				return false;
			}
		}
	}

	return true;
}

const centre = (corners) => ({x: corners.reduce((sum, c) => sum + c.x, 0) / 4, y: corners.reduce((sum, c) => sum + c.y, 0) / 4});

// ------------------------------------------------------------ textures

// A table, `kind` one of TABLES, as an ImageData of w x h.
const TABLES = ['dark wood', 'light wood', 'grey cloth', 'white desk'];

function table(kind, w, h, rand) {
	const image = new ImageData(w, h);
	const d = image.data;
	const base = {'dark wood': [92, 62, 40], 'grey cloth': [118, 120, 124], 'light wood': [196, 160, 118], 'white desk': [222, 222, 218]}[kind];
	const phase = rand() * 100;
	const noise = new Float32Array(w * h);

	for (let i = 0; i < noise.length; i++) {
		noise[i] = rand() - 0.5;
	}

	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			let v = 0;

			if (kind.endsWith('wood')) {
				// Grain: long streaks along x, wavering.
				v = Math.sin((y + 14 * Math.sin(x / 140 + phase)) / 9 + phase) * 9 + Math.sin(y / 2.7 + x / 400) * 3 + noise[y * w + x] * 10;
			}
			else if (kind === 'grey cloth') {
				// A weave: a fine check and noise.
				v = ((x >> 1) + (y >> 1)) % 2 ? 5 : -5;
				v += noise[y * w + x] * 22;
			}
			else {
				v = noise[y * w + x] * 6 + (x / w - 0.5) * 12;
			}

			const o = (y * w + x) * 4;

			d[o] = base[0] + v;
			d[o + 1] = base[1] + v;
			d[o + 2] = base[2] + v * 0.9;
			d[o + 3] = 255;
		}
	}

	return image;
}

// A camera's blur, light, and JPEG over a finished frame; returns the frame
// as a canvas standing in for the video (camera.js reads videoWidth and
// videoHeight) and its ImageData.
async function camera(image, rand) {
	const flat = new OffscreenCanvas(image.width, image.height);

	flat.getContext('2d').putImageData(image, 0, 0);

	const soft = new OffscreenCanvas(image.width, image.height);
	const sctx = soft.getContext('2d');

	sctx.filter = `blur(${between(rand, 0.5, 1.2).toFixed(2)}px) brightness(${between(rand, 0.9, 1.08).toFixed(2)})`;
	sctx.drawImage(flat, 0, 0);

	const back = await createImageBitmap(await soft.convertToBlob({quality: 0.82, type: 'image/jpeg'}));
	const video = document.createElement('canvas');

	video.width = image.width;
	video.height = image.height;

	const vctx = video.getContext('2d', {willReadFrequently: true});

	vctx.drawImage(back, 0, 0);
	back.close();
	Object.defineProperties(video, {videoHeight: {value: image.height}, videoWidth: {value: image.width}});

	return {image: vctx.getImageData(0, 0, image.width, image.height), video};
}

// A glare band across a canvas: a long strip at `angle` degrees through
// (cx, cy), `width` wide, white at `peak` alpha along its middle.
function glareBand(ctx, {angle, cx, cy, peak, width}) {
	ctx.save();
	ctx.translate(cx, cy);
	ctx.rotate((angle * Math.PI) / 180);

	const grad = ctx.createLinearGradient(-width / 2, 0, width / 2, 0);

	grad.addColorStop(0, 'rgba(255,255,255,0)');
	grad.addColorStop(0.35, `rgba(255,255,255,${(peak * 0.75).toFixed(2)})`);
	grad.addColorStop(0.5, `rgba(255,255,255,${peak.toFixed(2)})`);
	grad.addColorStop(0.65, `rgba(255,255,255,${(peak * 0.75).toFixed(2)})`);
	grad.addColorStop(1, 'rgba(255,255,255,0)');
	ctx.fillStyle = grad;
	ctx.fillRect(-width / 2, -5000, width, 10000);
	ctx.restore();
}

// ------------------------------------------------------------ scenes

// A binder page: rows x cols pockets, `cards` (one image path or null, an
// empty pocket, per pocket, row by row). The page is drawn flat at S pixels
// a millimetre (a card 63 x 88 mm, the welds between pockets GAP mm, the
// sheet's plastic MARGIN mm past the outer pockets, on a black backing),
// then laid in the frame over a table, filling `fill` of its width, turned
// and seen at a slant. Returns the frame and, per pocket, the card's
// corners in it.
const S = 5;
const GAP = 3;
const MARGIN = 9;

async function pageScene({cards, cols = 3, glare = 2, rows = 3, seed}) {
	const rand = seeded(seed);
	const gridW = cols * 63 + (cols - 1) * GAP;
	const gridH = rows * 88 + (rows - 1) * GAP;
	const pw = Math.round((gridW + MARGIN * 2) * S);
	const ph = Math.round((gridH + MARGIN * 2) * S);
	const page = new OffscreenCanvas(pw, ph);
	const ctx = page.getContext('2d');

	ctx.imageSmoothingQuality = 'high';
	ctx.fillStyle = '#17171b';
	ctx.fillRect(0, 0, pw, ph);

	// The sheet's plastic edge, a little lighter than the backing.
	ctx.strokeStyle = 'rgba(255,255,255,0.10)';
	ctx.lineWidth = S * 0.8;
	ctx.strokeRect(S * 3, S * 3, pw - S * 6, ph - S * 6);

	const truth = [];
	const pocketAt = (row, col) => ({x: (MARGIN + col * (63 + GAP)) * S, y: (MARGIN + row * (88 + GAP)) * S});

	for (let row = 0; row < rows; row++) {
		for (let col = 0; col < cols; col++) {
			const src = cards[row * cols + col];
			const at = pocketAt(row, col);

			if (!src) {
				truth.push(null);
				continue;
			}

			const bitmap = await bitmapOf(src);
			const cx = at.x + 31.5 * S + between(rand, -1.2, 1.2) * S;
			const cy = at.y + 44 * S + between(rand, -1.2, 1.2) * S;
			const angle = between(rand, -1.2, 1.2);

			ctx.save();
			ctx.translate(cx, cy);
			ctx.rotate((angle * Math.PI) / 180);
			ctx.drawImage(bitmap, -31.5 * S, -44 * S, 63 * S, 88 * S);
			ctx.restore();
			truth.push({corners: boxCorners(cx, cy, 63 * S, 88 * S, angle), src});
		}
	}

	// Each pocket's sleeve: a faint haze, and the bright lip of its opening
	// near the top.
	for (let row = 0; row < rows; row++) {
		for (let col = 0; col < cols; col++) {
			const at = pocketAt(row, col);

			ctx.fillStyle = `rgba(255,255,255,${between(rand, 0.03, 0.08).toFixed(3)})`;
			ctx.fillRect(at.x - S, at.y - S, 65 * S, 90 * S);
			ctx.fillStyle = 'rgba(255,255,255,0.22)';
			ctx.fillRect(at.x, at.y + S * 3, 63 * S, S * 0.5);
		}
	}

	// The welds between pockets: lighter seams through the gaps.
	ctx.fillStyle = 'rgba(200,200,210,0.16)';

	for (let col = 1; col < cols; col++) {
		ctx.fillRect((MARGIN + col * (63 + GAP) - GAP / 2 - 0.4) * S, MARGIN * S * 0.6, S * 0.8, ph - MARGIN * S * 1.2);
	}

	for (let row = 1; row < rows; row++) {
		ctx.fillRect(MARGIN * S * 0.6, (MARGIN + row * (88 + GAP) - GAP / 2 - 0.4) * S, pw - MARGIN * S * 1.2, S * 0.8);
	}

	for (let k = 0; k < glare; k++) {
		glareBand(ctx, {angle: (rand() < 0.5 ? -1 : 1) * between(rand, 20, 65), cx: between(rand, 0.15, 0.85) * pw, cy: between(rand, 0.15, 0.85) * ph, peak: between(rand, 0.45, 0.9), width: between(rand, 18, 50) * S});
	}

	// Laid in the frame: the grid `fill` of the frame's width, turned up to
	// 3 degrees, each corner moved up to 2.5 % of the width for the slant.
	const fill = between(rand, 0.82, 0.93);
	const scale = (FRAME.width * fill) / (gridW * S);
	const cx = FRAME.width / 2 + between(rand, -0.02, 0.02) * FRAME.width;
	const cy = FRAME.height / 2 + between(rand, -0.04, 0.04) * FRAME.height;
	const turn = between(rand, -3, 3);
	const flat = [{x: 0, y: 0}, {x: pw, y: 0}, {x: pw, y: ph}, {x: 0, y: ph}];
	const placed = boxCorners(cx, cy, pw * scale, ph * scale, turn).map((p) => ({x: p.x + between(rand, -0.025, 0.025) * FRAME.width, y: p.y + between(rand, -0.025, 0.025) * FRAME.width}));
	const m = homography(flat, placed);
	const frame = table(TABLES[Math.floor(rand() * 2)], FRAME.width, FRAME.height, rand);

	warpInto(frame, ctx.getImageData(0, 0, pw, ph), m, placed);

	const shot = await camera(frame, rand);

	return {...shot, kind: 'page', truth: truth.map((t) => (t ? {corners: t.corners.map((p) => project(m, p)), src: t.src} : null))};
}

// Loose cards on a table: each card `size` of the frame's height (smaller
// the more there are), turned up to 12 degrees, placed apart at random;
// with `touch`, the second laid against the first's side. A third of the
// scenes have a glare spot on one card. The whole table is seen at a
// slight slant (each corner moved up to 3 % of the width).
async function looseScene({cards, seed, touch = false}) {
	const rand = seeded(seed);
	const w = FRAME.width;
	const h = FRAME.height;
	const kind = TABLES[Math.floor(rand() * TABLES.length)];
	const base = table(kind, w, h, rand);
	const flat = new OffscreenCanvas(w, h);
	const ctx = flat.getContext('2d');
	const size = {2: 0.34, 3: 0.3, 4: 0.27, 5: 0.25}[cards.length] || 0.25;
	const placed = [];

	ctx.putImageData(base, 0, 0);
	ctx.imageSmoothingQuality = 'high';

	for (let attempt = 0; placed.length < cards.length && attempt < 4000; attempt++) {
		// Start again, smaller, every 400 tries.
		const shrink = 1 - Math.floor(attempt / 400) * 0.04;

		if (attempt % 400 === 0) {
			placed.length = 0;
		}

		const ch = h * size * shrink * between(rand, 0.94, 1.04);
		const cw = ch * CARD;
		const angle = between(rand, -12, 12);
		let cx;
		let cy;
		let ang = angle;

		if (touch && placed.length === 1) {
			// Against the first card's right side (or its left, when there is
			// no room), turned with it, a hair apart.
			const first = placed[0];
			const side = first.cx < w / 2 ? 1 : -1;
			const r = (first.angle * Math.PI) / 180;
			const step = (first.cw + cw) / 2 + first.cw * 0.004;

			ang = first.angle;
			cx = first.cx + side * step * Math.cos(r);
			cy = first.cy + side * step * Math.sin(r) + (ch - first.ch) / 2;
		}
		else {
			cx = between(rand, cw * 0.6, w - cw * 0.6);
			cy = between(rand, ch * 0.6, h - ch * 0.6);
		}

		const corners = boxCorners(cx, cy, cw, ch, ang);
		const margin = cw * 0.04;
		const grown = boxCorners(cx, cy, cw + margin * 2, ch + margin * 2, ang);

		if (corners.some((p) => p.x < w * 0.03 || p.y < h * 0.03 || p.x > w * 0.97 || p.y > h * 0.97)) {
			continue;
		}

		if (placed.some((other, i) => overlaps(touch && placed.length === 1 && i === 0 ? corners : grown, other.corners))) {
			if (!(touch && placed.length === 1)) {
				continue;
			}

			// The touching card may meet the first, never cross it.
			const inner = boxCorners(cx, cy, cw * 0.98, ch * 0.98, ang);

			if (placed.some((other) => overlaps(inner, other.corners))) {
				continue;
			}
		}

		placed.push({angle: ang, ch, corners, cw, cx, cy, src: cards[placed.length]});
	}

	for (const card of placed) {
		const bitmap = await bitmapOf(card.src);

		ctx.save();
		ctx.translate(card.cx, card.cy);
		ctx.rotate((card.angle * Math.PI) / 180);
		ctx.shadowColor = 'rgba(0,0,0,0.35)';
		ctx.shadowBlur = card.cw * 0.03;
		ctx.shadowOffsetY = card.cw * 0.01;
		ctx.drawImage(bitmap, -card.cw / 2, -card.ch / 2, card.cw, card.ch);
		ctx.restore();
	}

	if (placed.length && rand() < 0.34) {
		const card = placed[Math.floor(rand() * placed.length)];
		const r = card.cw * between(rand, 0.25, 0.45);
		const grad = ctx.createRadialGradient(card.cx, card.cy, 0, card.cx, card.cy, r);

		grad.addColorStop(0, 'rgba(255,255,255,0.75)');
		grad.addColorStop(1, 'rgba(255,255,255,0)');
		ctx.fillStyle = grad;
		ctx.fillRect(card.cx - r, card.cy - r, r * 2, r * 2);
	}

	const from = [{x: 0, y: 0}, {x: w, y: 0}, {x: w, y: h}, {x: 0, y: h}];
	const to = [{x: -1, y: -1}, {x: 1, y: -1}, {x: 1, y: 1}, {x: -1, y: 1}].map(({x, y}, i) => ({x: from[i].x + x * between(rand, 0, 0.03) * w, y: from[i].y + y * between(rand, 0, 0.03) * w}));
	const m = homography(from, to);
	const frame = new ImageData(w, h);

	warpInto(frame, ctx.getImageData(0, 0, w, h), m, to);

	const shot = await camera(frame, rand);

	return {...shot, kind: 'loose', touch: touch && placed.length > 1, truth: placed.map((card) => ({corners: card.corners.map((p) => project(m, p)), src: card.src}))};
}

// One card as the single-card scanner's guide capture holds it (the scan
// benchmark's clean pass: up to 1 degree turned, a 12 % margin of table,
// light blur, JPEG 0.9), for the per-card comparison.
async function singleScene({seed, src}) {
	const rand = seeded(seed);
	const bitmap = await bitmapOf(src);
	const w = bitmap.width;
	const h = bitmap.height;
	const canvas = new OffscreenCanvas(Math.round(w * 1.12), Math.round(h * 1.12));
	const ctx = canvas.getContext('2d');

	ctx.fillStyle = '#5a4a3c';
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.filter = 'blur(0.3px)';
	ctx.translate(canvas.width / 2, canvas.height / 2);
	ctx.rotate((between(rand, -1, 1) * Math.PI) / 180);
	ctx.scale(0.97, 0.97);
	ctx.drawImage(bitmap, -w / 2, -h / 2);

	const back = await createImageBitmap(await canvas.convertToBlob({quality: 0.9, type: 'image/jpeg'}));
	const out = new OffscreenCanvas(canvas.width, canvas.height);

	out.getContext('2d').drawImage(back, 0, 0);

	return {image: out.getContext('2d').getImageData(0, 0, canvas.width, canvas.height), kind: 'single', truth: [{corners: null, src}]};
}

// ------------------------------------------------------------ the paths

// A part of the frame's ImageData.
function cropOf(image, {h, w, x, y}) {
	const out = new ImageData(w, h);

	for (let row = 0; row < h; row++) {
		out.data.set(image.data.subarray(((y + row) * image.width + x) * 4, ((y + row) * image.width + x + w) * 4), row * w * 4);
	}

	return out;
}

// The distance the picture's lead lies at (after the wider search, which
// brings a crop a few percent off back to its card: on these frames a
// pocket cut well often lies past 65 before it and near 20 after). An item
// whose lead lies past NOT_CARD_DISTANCE is taken for no card: an empty
// pocket, or an outline that is not a card.
function distanceOf(picture) {
	const lead = picture && picture.groups && picture.groups[0];

	return lead ? lead.score : Infinity;
}

// With `keep` (multi.crops), each capture and the crop the picture route
// kept for it, for looking at what a path matched.
let keep = false;
const kept = [];

// One capture through the app's picture route, and with `text` its number
// read and the match settled as js/scan/view.js settles it (pictureMatch,
// the text route behind it). Returns what the tables count.
async function matchOne(image, quads, {text = false} = {}) {
	const t0 = performance.now();
	let seen = await identifyPicture(image, {quads});

	if (keep) {
		kept.push({card: seen.card, cut: image, how: seen.picture && seen.picture.how});
	}

	const verdict = pictureVerdict(seen.picture);
	const lead = seen.picture && seen.picture.groups[0];
	let first = lead ? lead.cards[0].id : null;
	let sure = verdict.sure;
	let read = false;

	if (text && seen.needsText) {
		seen = await identifyText(seen);
		read = seen.ocr;

		const summary = seen.read ? summariseRead(seen.read) : null;
		const lang = summary && summary.language.code ? summary.language.code : null;
		const found = await pictureMatch(seen.picture, summary, lang, {textRoute: (r, l) => findCandidates(r, l, {artwork: seen.artwork})});

		first = found.card ? found.card.id : (found.candidates[0] || {}).id || first;
		sure = found.sure;
	}

	return {
		distance: Math.round(distanceOf(seen.picture) * 10) / 10,
		plain: seen.picture && typeof seen.picture.plain === 'number' ? seen.picture.plain : null,
		first,
		gap: seen.picture ? seen.picture.gap : null,
		group: lead ? lead.cards.map((c) => c.id) : [],
		ms: Math.round(performance.now() - t0),
		read,
		sure,
	};
}

// A point of a cut (width x height, cut straight from the quad `cut` of the
// frame) back in the frame.
const cutToFrame = (cut, p, width, height) => quadPoint(cut, p.x / width, p.y / height);

// The card's outline in a pocket's cut (findCard on a copy at most 200
// pixels tall), in the cut's pixels, when its area is 55 to 115 % of the
// card's expected place (`inner`); else null.
function ownOutline(image, inner) {
	const scale = Math.min(1, 200 / image.height);
	const w = Math.max(1, Math.round(image.width * scale));
	const h = Math.max(1, Math.round(image.height * scale));
	const small = new OffscreenCanvas(w, h);
	const full = new OffscreenCanvas(image.width, image.height);

	full.getContext('2d').putImageData(image, 0, 0);

	const ctx = small.getContext('2d', {willReadFrequently: true});

	ctx.imageSmoothingQuality = 'medium';
	ctx.drawImage(full, 0, 0, w, h);

	const found = findCard(toGrey(ctx.getImageData(0, 0, w, h).data, w, h), w, h);

	if (!found.quad || !found.upright) {
		return null;
	}

	const corners = found.quad.map((p) => ({x: p.x / scale, y: p.y / scale}));
	const area = (q) => Math.abs(q.reduce((sum, p, i) => sum + p.x * q[(i + 1) % 4].y - q[(i + 1) % 4].x * p.y, 0)) / 2;
	const share = area(corners) / area(inner);

	return share >= 0.55 && share <= 1.15 ? {corners, ratio: found.ratio, upright: true} : null;
}

// How much colour the middle of a pocket's cut has (steady.js
// colourfulness on a 64 x 88 copy).
function colourOf(image) {
	const full = new OffscreenCanvas(image.width, image.height);
	const small = new OffscreenCanvas(64, 88);
	const ctx = small.getContext('2d', {willReadFrequently: true});

	full.getContext('2d').putImageData(image, 0, 0);
	ctx.drawImage(full, 0, 0, 64, 88);

	return colourfulness(ctx.getImageData(0, 0, 64, 88).data, 64, 88);
}

// The page path: the pages' outlines on the grey copy of the frame (one
// page, or the two of a spread), their pockets, and each pocket matched as
// a capture cut straight round it with `pad` to spare (its card's place
// passed as an outline). A lying page's corners start where its top left
// comes once it is turned a quarter clockwise, so its pockets are cut
// standing; a card the other way up is turned by the picture match
// (picture.js matchCrops turns).
async function pagePath(scene, {cols = 3, fit = true, pad = 0.1, pages = 2, refine = true, rows = 3, side = FIND_SIDE_CAPTURE, text = false} = {}) {
	const t0 = performance.now();
	const view = viewFrame(scene.video, document.createElement('canvas'), null, side);
	// With `fit`, the cards found in the frame (findCards) set the pages
	// right: their size says how large a page is (findPages cardArea), a
	// spread taken for one page, its cards lying across it, is cut in two
	// (splitSpread), and each page's map is fitted to its cards' corners
	// (fitPage), where the outline found was the sheet's edge or the
	// binder's rather than the cards'.
	const cards = fit ? findCards(view.grey, view.width, view.height) : [];
	const areas = cards.map((card) => {
		const q = card.corners;

		return Math.abs(q.reduce((sum, p, i) => sum + p.x * q[(i + 1) % 4].y - q[(i + 1) % 4].x * p.y, 0)) / 2;
	}).sort((a, b) => a - b);
	const cardArea = areas.length >= 3 ? areas[Math.floor(areas.length / 2)] : null;
	const found = findPages(view.grey, view.width, view.height, {cardArea, max: pages, pockets: rows * cols, shape: pageShape(rows, cols)});
	const split = found.flatMap((page) => splitSpread(page.corners, cards) || [page.corners]).slice(0, pages);
	const fitted = split.map((corners) => (fit ? fitPage(corners, cards, rows, cols) : null));
	const findMs = Math.round(performance.now() - t0);
	const outlines = split.map((corners, i) => (fitted[i] ? fitted[i].corners : corners).map((p) => ({x: p.x / view.scale, y: p.y / view.scale})));
	const items = [];

	for (const [index, corners] of outlines.entries()) {
		for (const cell of pageCells(corners, rows, cols, {pad})) {
			const t1 = performance.now();
			const tall = Math.hypot(cell.cut[3].x - cell.cut[0].x, cell.cut[3].y - cell.cut[0].y);
			const height = Math.min(1400, Math.round(tall));
			const width = Math.round(height * CARD);
			const raw = warpQuad(scene.image, cell.cut, width, height);
			const image = new ImageData(raw.data, width, height);
			const inset = pad / (1 + 2 * pad);
			const inner = [[inset, inset], [1 - inset, inset], [1 - inset, 1 - inset], [inset, 1 - inset]].map(([u, v]) => ({x: u * width, y: v * height}));
			// The card's own outline in the pocket (findCard, the single-card
			// finder, on a small copy of the cut), when one of about a card's
			// size is found: an even division of the page is a few percent off
			// wherever the outline found is the sheet's edge rather than the
			// cards', or the pockets are not quite even.
			const own = refine ? ownOutline(image, inner) : null;
			// An empty pocket: no card's outline in it, and no colour in its
			// middle (steady.js colourfulness, as the scanner tells a card from
			// a blank sheet): the wide search brings the dark backing within
			// 53 to 72 of some card, as near as a card with glare on it.
			const empty = !own && colourOf(image) < COLOURLESS;
			const quads = own ? [own, {corners: inner, ratio: CARD, upright: true}] : [{corners: inner, ratio: CARD, upright: true}];
			const cutMs = performance.now() - t1;
			const result = await matchOne(image, quads, {text});

			items.push({...result, card: (own ? own.corners : inner).map((p) => cutToFrame(cell.cut, p, width, height)), cell: index * rows * cols + cell.row * cols + cell.col, empty, ms: Math.round(result.ms + cutMs), own: Boolean(own), page: index, pocket: cell.row * cols + cell.col});
		}
	}

	return {findMs, fitted: fitted.map((one) => (one ? one.cards : 0)), items, page: outlines[0] || null, pages: outlines, split: split.length > found.length, totalMs: Math.round(performance.now() - t0)};
}

// The free path: every card-shaped outline on the grey copy of the frame
// (findCards), each matched as the scanner matches the card it finds in
// the frame: a box round it (camera.js boxAround), its outline passed on.
async function freePath(scene, {side = FIND_SIDE_CAPTURE, text = false} = {}) {
	const t0 = performance.now();
	const view = viewFrame(scene.video, document.createElement('canvas'), null, side);
	const found = findCards(view.grey, view.width, view.height);
	const findMs = Math.round(performance.now() - t0);
	const items = [];

	for (const one of found) {
		const t1 = performance.now();
		const corners = one.corners.map((p) => ({x: p.x / view.scale, y: p.y / view.scale}));
		const region = boxAround({height: scene.image.height, width: scene.image.width}, corners);
		const image = cropOf(scene.image, region);
		const quads = [{corners: corners.map((c) => ({x: c.x - region.x, y: c.y - region.y})), ratio: one.ratio, upright: one.upright}];
		const cutMs = performance.now() - t1;
		const result = await matchOne(image, quads, {text});

		items.push({...result, card: corners, ms: Math.round(result.ms + cutMs)});
	}

	return {findMs, items, totalMs: Math.round(performance.now() - t0)};
}

// ------------------------------------------------------------ scoring

// Pairs a path's items with the scene's cards and scores them. An item is
// taken as a card when its picture lies within NOT_CARD_DISTANCE (else it
// is an empty pocket, or not a card); the page path pairs by pocket, the
// free path by the true card whose outline holds the item's middle.
function score(scene, result, ids) {
	const cards = scene.truth.map((t, i) => (t ? {id: ids[t.src], index: i} : null));
	const isCard = (item) => item.distance <= NOT_CARD_DISTANCE && !item.empty;
	const perCard = [];
	let falseCards = 0;
	let emptyRight = 0;
	let duplicates = 0;
	const taken = new Set();

	for (const item of result.items) {
		let index = -1;

		if (scene.kind === 'page' && typeof item.cell === 'number') {
			index = item.cell;
		}
		else {
			const middle = centre(item.card);

			index = scene.truth.findIndex((t) => t && pointIn(middle, t.corners));
		}

		const truth = index >= 0 ? cards[index] : null;

		if (!truth) {
			if (isCard(item)) {
				falseCards++;
			}
			else if (scene.kind === 'page') {
				emptyRight++;
			}

			continue;
		}

		if (taken.has(index)) {
			duplicates++;
			continue;
		}

		taken.add(index);
		item.truth = truth.id;
		item.found = isCard(item);
	}

	for (const card of cards) {
		if (!card) {
			continue;
		}

		const item = result.items.find((one) => one.truth === card.id);
		const found = Boolean(item && item.found);

		perCard.push({
			distance: item ? item.distance : null,
			found,
			id: card.id,
			inGroup: found && item.group.includes(card.id),
			ms: item ? item.ms : null,
			outlined: Boolean(item),
			read: Boolean(item && item.read),
			right: found && item.first === card.id,
			sure: found && item.sure,
			wrongSure: found && item.sure && item.first !== card.id,
		});
	}

	return {
		cards: perCard,
		duplicates,
		empties: scene.truth.filter((t) => !t).length,
		emptyRight,
		falseCards,
		findMs: result.findMs,
		page: scene.kind === 'page' && result.pages ? Boolean(result.page) : null,
		totalMs: result.totalMs,
	};
}

// ------------------------------------------------------------ the page API

let current = null;
let ids = {};

// A frame with the found outlines drawn on it (truth green, found red), as
// a JPEG data URL, for looking at what a path did.
async function shotOf(scene, results) {
	const canvas = new OffscreenCanvas(scene.image.width, scene.image.height);
	const ctx = canvas.getContext('2d');
	const path = (corners, colour, width) => {
		ctx.strokeStyle = colour;
		ctx.lineWidth = width;
		ctx.beginPath();
		corners.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
		ctx.closePath();
		ctx.stroke();
	};

	ctx.putImageData(scene.image, 0, 0);

	for (const t of scene.truth) {
		if (t && t.corners) {
			path(t.corners, '#2ecc40', 4);
		}
	}

	for (const [name, result] of Object.entries(results)) {
		const colour = name === 'page' ? '#ff4136' : '#0074d9';

		for (const outline of result.pages || []) {
			path(outline, '#ffdc00', 5);
		}

		for (const item of result.items) {
			path(item.card, colour, item.distance <= NOT_CARD_DISTANCE ? 3 : 1);
		}
	}

	const blob = await canvas.convertToBlob({quality: 0.7, type: 'image/jpeg'});
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let binary = '';

	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
	}

	return btoa(binary);
}

// Every index card's names (js/vision/index-names.json), by id, for
// naming a photo's matches: {id: 'Name (en) / Nome (pt)'}.
let names = null;

async function namesOf() {
	if (!names) {
		const table = await (await fetch(new URL('../../js/vision/index-names.json', import.meta.url))).json();
		const all = new Map();

		for (const [key, cards] of Object.entries(table.cards)) {
			const set = table.sets[key];

			for (const [id, name] of Object.entries(cards)) {
				all.set(id, [...(all.get(id) || []), `${name} (${key.split('|')[0]}${set ? `, ${set[0]}` : ''})`]);
			}
		}

		names = all;
	}

	return names;
}

window.multi = {
	// Loads the picture index, and with `text` the reading engine; `cards`
	// maps each image path to its card id.
	async init({cards}) {
		ids = cards;

		const t0 = performance.now();

		await loadFingerprints();

		return {indexMs: Math.round(performance.now() - t0)};
	},
	// Makes one scene (kept for the next detect): {kind: 'page', cards:
	// [path or null x 9], seed} or {kind: 'loose', cards: [paths], seed,
	// touch} or {kind: 'single', src, seed}.
	async compose(spec) {
		const t0 = performance.now();

		current = spec.kind === 'page' ? await pageScene(spec) : spec.kind === 'loose' ? await looseScene(spec) : await singleScene(spec);

		return {cards: current.truth.filter(Boolean).length, ms: Math.round(performance.now() - t0), touch: Boolean(current.touch)};
	},
	// Runs one path ('page', 'free', or for a single scene 'single') on the
	// scene made last, and scores it.
	async detect(path, options = {}) {
		if (path === 'single') {
			const t0 = performance.now();
			const result = await matchOne(current.image, [], options);
			const item = {...result, card: null};
			const id = ids[current.truth[0].src];

			return {cards: [{distance: item.distance, found: item.distance <= NOT_CARD_DISTANCE, id, inGroup: item.group.includes(id), ms: item.ms, outlined: true, read: item.read, right: item.first === id, sure: item.sure, wrongSure: item.sure && item.first !== id}], duplicates: 0, empties: 0, emptyRight: 0, falseCards: 0, findMs: 0, page: null, totalMs: Math.round(performance.now() - t0)};
		}

		const result = path === 'page' ? await pagePath(current, options) : await freePath(current, options);
		const scored = score(current, result, ids);

		current.results = {...(current.results || {}), [path]: result};
		scored.items = result.items.map((item) => ({distance: item.distance, first: item.first, ms: item.ms, sure: item.sure, truth: item.truth || null}));

		return scored;
	},
	// A photo (a real binder page or spread) through `paths`, as one frame:
	// what each path found, with each match's names. No truth: the photo is
	// judged by eye.
	async photo(src, {paths = ['page', 'free'], ...options} = {}) {
		const bitmap = await bitmapOf(src);
		const video = document.createElement('canvas');

		video.width = bitmap.width;
		video.height = bitmap.height;

		const ctx = video.getContext('2d', {willReadFrequently: true});

		ctx.drawImage(bitmap, 0, 0);
		Object.defineProperties(video, {videoHeight: {value: bitmap.height}, videoWidth: {value: bitmap.width}});
		current = {image: ctx.getImageData(0, 0, bitmap.width, bitmap.height), kind: 'photo', truth: [], video};

		const table = await namesOf();
		const out = {height: bitmap.height, width: bitmap.width};

		for (const path of paths) {
			const result = path === 'page' ? await pagePath(current, options) : await freePath(current, options);

			current.results = {...(current.results || {}), [path]: result};
			out[path] = {
				findMs: result.findMs,
				items: result.items.map((item) => ({card: item.distance <= NOT_CARD_DISTANCE && !item.empty, distance: item.distance, first: item.first, gap: item.gap, group: item.group.slice(0, 4), middle: centre(item.card), ms: item.ms, name: item.first ? (table.get(item.first) || ['?']).join(' / ') : null, page: item.page ?? null, pocket: item.pocket ?? null, sure: item.sure})),
				fitted: result.fitted || null,
				pages: result.pages ? result.pages.length : null,
				split: result.split || false,
				totalMs: result.totalMs,
			};
		}

		return out;
	},
	// Keep every capture and crop matched from now on (true), or hand back
	// the ones kept as PNG data URLs and forget them.
	async crops(on) {
		keep = on;

		const out = [];

		for (const one of kept.splice(0)) {
			const urls = {};

			for (const key of ['cut', 'card']) {
				const image = one[key];
				const canvas = new OffscreenCanvas(image.width, image.height);

				canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);

				const blob = await canvas.convertToBlob({type: 'image/png'});

				urls[key] = await new Promise((resolve) => {
					const reader = new FileReader();

					reader.onload = () => resolve(reader.result);
					reader.readAsDataURL(blob);
				});
			}

			out.push({...urls, how: one.how});
		}

		return out;
	},
	// The scene made last, with every path's outlines drawn, as base64 JPEG.
	shot: () => shotOf(current, current.results || {}),
};

window.multiReady = true;
