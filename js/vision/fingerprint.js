// Image fingerprints of a straightened card, for recognising it by its
// picture rather than its text. The same code runs in the browser on the
// scanner's crop (js/scan/rectify.js) and in the index builder on every
// TCGdex image (build-index.mjs drives it in headless Chromium), so the two
// sides can only differ by what the camera did to the card.
//
// Input: an ImageData-shaped object ({data, width, height}, RGBA), the card
// edge to edge at any size. Three descriptors:
//
// - art: a DCT perceptual hash (pHash) of the artwork window, the
//   illustration box that sits at the same place on every framed card
//   (8 to 92 % across, 11 to 52 % down, as js/scan/artwork.js uses). The
//   window is averaged down to 32 x 32 grey, the 2-D DCT is taken, and the
//   lowest frequencies (DC left out) become bits: 1 where a coefficient is
//   above their median. Blur, JPEG, brightness, and a colour cast barely
//   move low frequencies, so few bits flip.
// - card: the same hash over the whole card face, minus a thin margin for
//   the border and a sleeve's edge. On full-art cards (special
//   illustration rares, illustration rares, full-art trainers, gold) the
//   picture covers the card, and this carries what the art box misses.
// - color: a colour layout (in the spirit of MPEG-7's): the art window as
//   an 8 x 8 grid of mean colours in YCbCr, each channel's 2-D DCT, and its
//   lowest coefficients as signed bytes. Brightness is dropped (Y's DC) and
//   Y's shape is scaled to unit length, so exposure and contrast do not
//   count; chroma keeps its DC at a coarse step, so a red card and a blue
//   card stay apart while a mild cast costs little.
//
// Everything is plain arithmetic over typed arrays, from one thumbnail of
// the crop (thumbnail()), so the cost hardly depends on the crop's size.

export const ART = {h: 0.41, w: 0.84, x: 0.08, y: 0.11};
export const FACE = {h: 0.93, w: 0.91, x: 0.045, y: 0.035};

export const HASH_GRID = 32;
export const COLOR_GRID = 8;
export const COLOR_BYTES = 16;

// Every descriptor is taken from one small thumbnail of the card, THUMB_W x
// THUMB_H mean colours, so the crop is read once, row by row, whatever its
// size, and the query's shifted crops cost almost nothing. Each thumbnail
// cell averages at most THUMB_SAMPLES x THUMB_SAMPLES pixels of the crop.
export const THUMB_W = 96;
export const THUMB_H = 134;
const THUMB_SAMPLES = 3;

// The thumbnail of an ImageData-shaped card: {rgb, w, h}.
export function thumbnail(img) {
	if (img.rgb) {
		return img;
	}

	const W = img.width;
	const H = img.height;
	const tw = THUMB_W;
	const th = THUMB_H;
	const cw = W / tw;
	const ch = H / th;
	const sx = Math.max(1, Math.min(THUMB_SAMPLES, Math.round(cw)));
	const sy = Math.max(1, Math.min(THUMB_SAMPLES, Math.round(ch)));
	const xs = new Int32Array(tw * sx);

	for (let u = 0; u < tw; u++) {
		for (let k = 0; k < sx; k++) {
			xs[u * sx + k] = Math.min(W - 1, Math.floor((u + (k + 0.5) / sx) * cw)) * 4;
		}
	}

	const rgb = new Float32Array(tw * th * 3);
	const data = img.data;
	const scale = 1 / (sx * sy);

	for (let v = 0; v < th; v++) {
		const o = v * tw * 3;

		for (let j = 0; j < sy; j++) {
			const row = Math.min(H - 1, Math.floor((v + (j + 0.5) / sy) * ch)) * W * 4;

			for (let u = 0; u < tw; u++) {
				let r = 0;
				let g = 0;
				let b = 0;

				for (let k = 0; k < sx; k++) {
					const i = row + xs[u * sx + k];

					r += data[i];
					g += data[i + 1];
					b += data[i + 2];
				}

				rgb[o + u * 3] += r * scale;
				rgb[o + u * 3 + 1] += g * scale;
				rgb[o + u * 3 + 2] += b * scale;
			}
		}
	}

	return {h: th, rgb, w: tw};
}

// The mean RGB of each cell of a gw x gh grid laid over `rect` (fractions of
// the card), with the rect moved by (dx, dy) and scaled by `zoom` around its
// centre (fractions of the card), read from the thumbnail with 2 x 2
// bilinear samples per cell. The query side tries a few such crops when the
// card's edges were found slightly off. win: where the card itself sits in
// the crop ({x, y, w, h}, fractions of the crop), when the crop holds more
// or less than the card (a strip of the card underneath, an edge cut
// short); every region moves and scales with it.
export function sampleGrid(thumb, inRect, gw, gh, {dx = 0, dy = 0, win = null, zoom = 1} = {}) {
	const {h, rgb, w} = thumb;
	const rect = win ? {h: inRect.h * win.h, w: inRect.w * win.w, x: win.x + inRect.x * win.w, y: win.y + inRect.y * win.h} : inRect;
	const rw = rect.w * zoom;
	const rh = rect.h * zoom;
	const x0 = (rect.x + rect.w / 2 + dx - rw / 2) * w - 0.5;
	const y0 = (rect.y + rect.h / 2 + dy - rh / 2) * h - 0.5;
	const cw = (rw * w) / gw;
	const ch = (rh * h) / gh;
	const out = new Float32Array(gw * gh * 3);
	const S = 2;
	const xi = new Int32Array(gw * S);
	const xf = new Float32Array(gw * S);

	for (let u = 0; u < gw; u++) {
		for (let k = 0; k < S; k++) {
			const x = Math.min(w - 1.001, Math.max(0, x0 + (u + (k + 0.5) / S) * cw));

			xi[u * S + k] = Math.floor(x);
			xf[u * S + k] = x - Math.floor(x);
		}
	}

	for (let v = 0; v < gh; v++) {
		for (let j = 0; j < S; j++) {
			const y = Math.min(h - 1.001, Math.max(0, y0 + (v + (j + 0.5) / S) * ch));
			const y1 = Math.floor(y);
			const fy = y - y1;
			const r0 = y1 * w * 3;
			const r1 = r0 + w * 3;

			for (let u = 0; u < gw; u++) {
				const o = (v * gw + u) * 3;

				for (let k = 0; k < S; k++) {
					const a = r0 + xi[u * S + k] * 3;
					const b = r1 + xi[u * S + k] * 3;
					const fx = xf[u * S + k];

					for (let c = 0; c < 3; c++) {
						const top = rgb[a + c] + (rgb[a + 3 + c] - rgb[a + c]) * fx;
						const bottom = rgb[b + c] + (rgb[b + 3 + c] - rgb[b + c]) * fx;

						out[o + c] += top + (bottom - top) * fy;
					}
				}
			}
		}
	}

	for (let i = 0; i < out.length; i++) {
		out[i] /= S * S;
	}

	return out;
}

const cosTables = new Map();

// cos((2x + 1) u pi / 2n) for x < n, u < m.
function cosTable(n, m) {
	const key = `${n}:${m}`;

	if (!cosTables.has(key)) {
		const t = new Float32Array(n * m);

		for (let u = 0; u < m; u++) {
			for (let x = 0; x < n; x++) {
				t[u * n + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * n));
			}
		}

		cosTables.set(key, t);
	}

	return cosTables.get(key);
}

// The m x m lowest-frequency 2-D DCT-II coefficients of an n x n plane
// (row-major, unnormalised: only their order and signs matter here).
export function dctLow(plane, n, m) {
	const t = cosTable(n, m);
	const rows = new Float32Array(n * m);

	for (let y = 0; y < n; y++) {
		for (let u = 0; u < m; u++) {
			let s = 0;

			for (let x = 0; x < n; x++) {
				s += plane[y * n + x] * t[u * n + x];
			}

			rows[y * m + u] = s;
		}
	}

	const out = new Float32Array(m * m);

	for (let v = 0; v < m; v++) {
		for (let u = 0; u < m; u++) {
			let s = 0;

			for (let y = 0; y < n; y++) {
				s += rows[y * m + u] * t[v * n + y];
			}

			out[v * m + u] = s;
		}
	}

	return out;
}

const orders = new Map();

// The first `bits` (u, v) frequencies by u + v, then by max(u, v), DC left
// out, as indexes into an m x m block.
function frequencyOrder(bits) {
	if (!orders.has(bits)) {
		const m = Math.ceil(Math.sqrt(bits * 2)) + 1;
		const all = [];

		for (let v = 0; v < m; v++) {
			for (let u = 0; u < m; u++) {
				if (u || v) {
					all.push({i: v * m + u, key: (u + v) * 100 + Math.max(u, v) * 10 + v});
				}
			}
		}

		all.sort((a, b) => a.key - b.key);
		orders.set(bits, {m, order: Int32Array.from(all.slice(0, bits), (f) => f.i)});
	}

	return orders.get(bits);
}

const grey = (rgb, n) => {
	const out = new Float32Array(n);

	for (let i = 0; i < n; i++) {
		out[i] = rgb[i * 3] * 0.299 + rgb[i * 3 + 1] * 0.587 + rgb[i * 3 + 2] * 0.114;
	}

	return out;
};

// A `bits`-bit pHash (bits a multiple of 32) of `rect`, as a Uint32Array.
export function phash(img, rect, bits = 64, shift = {}) {
	const n = HASH_GRID;
	const {m, order} = frequencyOrder(bits);
	const coefs = dctLow(grey(sampleGrid(thumbnail(img), rect, n, n, shift), n * n), n, m);
	const picked = Float32Array.from(order, (i) => coefs[i]);
	const sorted = Float32Array.from(picked).sort();
	const median = (sorted[(bits >> 1) - 1] + sorted[bits >> 1]) / 2;
	const out = new Uint32Array(bits / 32);

	for (let k = 0; k < bits; k++) {
		if (picked[k] > median) {
			out[k >> 5] |= 1 << (k & 31);
		}
	}

	return out;
}

// Zig-zag order of an 8 x 8 block, first entries.
const ZIGZAG = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5];

// The colour layout of `rect` as COLOR_BYTES signed bytes: Y's AC
// coefficients 1 to 9 scaled to unit length (x 127), then Cb and Cr's first
// three coefficients (DC included) at a fixed step.
export function colorLayout(img, rect, shift = {}) {
	const g = COLOR_GRID;
	const rgb = sampleGrid(thumbnail(img), rect, g, g, shift);
	const planes = [new Float32Array(g * g), new Float32Array(g * g), new Float32Array(g * g)];

	for (let i = 0; i < g * g; i++) {
		const r = rgb[i * 3];
		const gg = rgb[i * 3 + 1];
		const b = rgb[i * 3 + 2];

		planes[0][i] = 0.299 * r + 0.587 * gg + 0.114 * b;
		planes[1][i] = -0.168736 * r - 0.331264 * gg + 0.5 * b;
		planes[2][i] = 0.5 * r - 0.418688 * gg - 0.081312 * b;
	}

	const [y, cb, cr] = planes.map((p) => dctLow(p, g, g));
	const out = new Int8Array(COLOR_BYTES);
	let len = 0;

	for (let k = 1; k <= 9; k++) {
		len += y[ZIGZAG[k]] ** 2;
	}

	len = Math.sqrt(len) || 1;

	const clamp = (v) => Math.max(-127, Math.min(127, Math.round(v)));

	for (let k = 1; k <= 9; k++) {
		out[k - 1] = clamp((y[ZIGZAG[k]] / len) * 127);
	}

	// Chroma: the DCT over 64 cells sums 64 values; DC / 64 is the mean.
	// The mean chroma runs about -60 to 60 on saturated art: step 1 per
	// byte. AC coefficients are smaller: the same step.
	for (let k = 0; k < 3; k++) {
		out[9 + k] = clamp(cb[ZIGZAG[k]] / (k ? 24 : 32));
		out[12 + k] = clamp(cr[ZIGZAG[k]] / (k ? 24 : 32));
	}

	return out;
}

// The fingerprint the index stores: {art, card, color}.
export function fingerprint(img, {artBits = 64, cardBits = 64, shift = {}} = {}) {
	img = thumbnail(img);

	return {
		art: phash(img, ART, artBits, shift),
		card: phash(img, FACE, cardBits, shift),
		color: colorLayout(img, ART, shift),
	};
}

// A few slightly moved crops of the query: the card's edges found a little
// off move every region with them. Matching takes the best of these.
export const QUERY_SHIFTS = [
	{},
	{dx: -0.025},
	{dx: 0.025},
	{dy: -0.02},
	{dy: 0.02},
	{zoom: 0.95},
	{zoom: 1.05},
];

// The wider search, added to QUERY_SHIFTS when a crop is not sure without
// it (js/scan/picture.js matchCrops, where it is measured): moves of up to
// 7.5 % either way in steps of 2.5 %, a smaller and a larger crop, and the
// card squeezed into part of the crop (a strip of the card underneath taken
// with it at the bottom or the top, or a side cut short).
const STEPS = [-0.075, -0.05, -0.025, 0, 0.025, 0.05, 0.075];

export const WIDE_SHIFTS = [
	...STEPS.flatMap((dx) => STEPS.map((dy) => ({dx, dy}))).filter(({dx, dy}) => Math.abs(dx) + Math.abs(dy) > 0.025),
	{zoom: 0.92},
	{zoom: 1.08},
	{zoom: 0.86},
	{win: {h: 0.88, w: 1, x: 0, y: 0}},
	{win: {h: 0.8, w: 1, x: 0, y: 0}},
	{win: {h: 0.88, w: 1, x: 0, y: 0.12}},
	{win: {h: 1, w: 0.9, x: 0, y: 0}},
	{win: {h: 1, w: 0.9, x: 0.1, y: 0}},
];

export function queryFingerprints(img, options = {}, shifts = QUERY_SHIFTS) {
	img = thumbnail(img);

	return shifts.map((shift) => fingerprint(img, {...options, shift}));
}

export function popcount32(x) {
	x -= (x >>> 1) & 0x55555555;
	x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
	x = (x + (x >>> 4)) & 0x0f0f0f0f;

	return Math.imul(x, 0x01010101) >>> 24;
}

export function hamming(a, b) {
	let d = 0;

	for (let i = 0; i < a.length; i++) {
		d += popcount32(a[i] ^ b[i]);
	}

	return d;
}

export function colorDistance(a, b) {
	let s = 0;

	for (let i = 0; i < a.length; i++) {
		const d = a[i] - b[i];

		s += d * d;
	}

	return Math.sqrt(s);
}
