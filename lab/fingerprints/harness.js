// The page build-index.mjs and measure.mjs drive in headless Chromium. It
// decodes images the way a phone would (createImageBitmap and a canvas),
// makes the simulated captures, straightens them with the scanner's own
// js/scan/rectify.js, and fingerprints them with fingerprint.js: the code
// the browser runs, so the index and the queries come from one source.
//
// Descriptors travel back to Node as base64 records of RECORD bytes:
// art64 (8), art128 (16), card64 (8), card128 (16), color (16). The index
// keeps the subset the measurements chose (build-index.mjs).

import {rectify} from '/pokemon-card-tracker/js/scan/rectify.js';
import {ART, colorLayout, FACE, phash, QUERY_SHIFTS, thumbnail} from '/pokemon-card-tracker/js/vision/fingerprint.js';
import {loadIndex, match} from '/pokemon-card-tracker/js/vision/matcher.js';

export const RECORD = 64;

function record(img, shift = {}) {
	const out = new Uint8Array(RECORD);

	out.set(new Uint8Array(phash(img, ART, 64, shift).buffer), 0);
	out.set(new Uint8Array(phash(img, ART, 128, shift).buffer), 8);
	out.set(new Uint8Array(phash(img, FACE, 64, shift).buffer), 24);
	out.set(new Uint8Array(phash(img, FACE, 128, shift).buffer), 32);
	out.set(new Uint8Array(colorLayout(img, ART, shift).buffer), 48);

	return out;
}

function base64(bytes) {
	let s = '';

	for (let i = 0; i < bytes.length; i += 0x8000) {
		s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
	}

	return btoa(s);
}

async function bitmapOf(src) {
	const response = await fetch(src);

	if (!response.ok) {
		throw new Error(`${src}: ${response.status}`);
	}

	return createImageBitmap(await response.blob());
}

function pixels(source, w = source.width, h = source.height) {
	const c = new OffscreenCanvas(w, h);
	const ctx = c.getContext('2d', {willReadFrequently: true});

	ctx.drawImage(source, 0, 0, w, h);

	return ctx.getImageData(0, 0, w, h);
}

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

async function jpeg(canvas, quality) {
	const blob = await canvas.convertToBlob({quality, type: 'image/jpeg'});

	return pixels(await createImageBitmap(blob));
}

function glareSpot(ctx, rand, w, h, {alpha = 0.9, anywhere = true} = {}) {
	const gx = w * (0.15 + rand() * 0.7);
	const gy = anywhere ? h * (0.12 + rand() * 0.76) : h * (rand() < 0.5 ? 0.15 + rand() * 0.2 : 0.75 + rand() * 0.2);
	const r = w * (0.12 + rand() * 0.2);
	const grad = ctx.createRadialGradient(gx, gy, 0, gx, gy, r);

	grad.addColorStop(0, `rgba(255,255,255,${alpha})`);
	grad.addColorStop(0.35, `rgba(255,255,255,${alpha * 0.8})`);
	grad.addColorStop(1, 'rgba(255,255,255,0)');
	ctx.fillStyle = grad;
	ctx.fillRect(0, 0, w, h);
}

// A rainbow foil sheen: diagonal bands of shifting hue, mostly over the
// artwork window (a holo) or the whole card (a full art).
function foil(ctx, rand, w, h, whole) {
	const c = new OffscreenCanvas(w, h);
	const fctx = c.getContext('2d');
	const angle = rand() * Math.PI;
	const grad = fctx.createLinearGradient(w / 2 - Math.cos(angle) * w, h / 2 - Math.sin(angle) * h, w / 2 + Math.cos(angle) * w, h / 2 + Math.sin(angle) * h);
	const phase = rand() * 360;

	for (let k = 0; k <= 12; k++) {
		grad.addColorStop(k / 12, `hsla(${(phase + k * 75) % 360}, 90%, 65%, ${k % 2 ? 0.35 : 0.1})`);
	}

	fctx.fillStyle = grad;
	fctx.fillRect(0, 0, w, h);
	ctx.save();
	ctx.globalCompositeOperation = 'overlay';

	if (whole) {
		ctx.drawImage(c, 0, 0);
	}
	else {
		ctx.drawImage(c, w * ART.x, h * ART.y, w * ART.w, h * ART.h, w * ART.x, h * ART.y, w * ART.w, h * ART.h);
	}

	ctx.restore();
}

// Degradations applied to the straightened card itself: what is left after
// rectify.js has done its work. Each is seeded by the card and the pass.
export const DEGRADATIONS = {
	clean: {blur: 0.3, quality: 0.9},
	blur: {blur: 2.2, quality: 0.85},
	glare: {blur: 0.5, glare: 2, quality: 0.85},
	cast: {blur: 0.5, cast: true, quality: 0.85},
	jpeg40: {blur: 0.4, quality: 0.4},
	rotate: {blur: 0.5, quality: 0.85, rotate: [3, 5]},
	shift: {blur: 0.5, quality: 0.85, shift: 0.1},
	sleeve: {blur: 0.8, quality: 0.85, sleeve: true},
	foil: {blur: 0.5, foil: true, quality: 0.85},
	// All at once, milder: what a hand-held phone shot in room light tends
	// to give.
	phone: {blur: 1.2, cast: true, glare: 1, quality: 0.6, rotate: [1, 2.5], shift: 0.04, sleeve: true},
};

export async function degrade(bitmap, seed, k, {full = false} = {}) {
	const rand = seeded(seed);
	const w = bitmap.width;
	const h = bitmap.height;
	const card = new OffscreenCanvas(w, h);
	const cctx = card.getContext('2d');

	cctx.drawImage(bitmap, 0, 0);

	if (k.foil) {
		foil(cctx, rand, w, h, full);
	}

	if (k.sleeve) {
		// A penny sleeve: a little haze and a soft diagonal sheen.
		cctx.fillStyle = 'rgba(235,238,245,0.10)';
		cctx.fillRect(0, 0, w, h);

		const g = cctx.createLinearGradient(0, h * rand(), w, h * rand());

		g.addColorStop(0, 'rgba(255,255,255,0)');
		g.addColorStop(0.5, 'rgba(255,255,255,0.22)');
		g.addColorStop(0.6, 'rgba(255,255,255,0)');
		cctx.fillStyle = g;
		cctx.fillRect(0, 0, w, h);
	}

	for (let i = 0; i < (k.glare || 0); i++) {
		glareSpot(cctx, rand, w, h);
	}

	const out = new OffscreenCanvas(w, h);
	const ctx = out.getContext('2d');
	const brightness = 0.85 + rand() * 0.3;
	let filter = `blur(${k.blur}px) brightness(${brightness.toFixed(2)})`;

	if (k.cast) {
		// A warm or cool cast: a sepia or hue turn mixed in, and saturation off.
		const warm = rand() < 0.5;

		filter += warm ? ` sepia(${(0.25 + rand() * 0.2).toFixed(2)})` : ` hue-rotate(${Math.round(-12 - rand() * 12)}deg) saturate(0.85)`;
	}

	ctx.fillStyle = '#5a4a3c';
	ctx.fillRect(0, 0, w, h);
	ctx.filter = filter;
	ctx.translate(w / 2, h / 2);

	if (k.rotate) {
		const [lo, hi] = k.rotate;
		const a = (lo + rand() * (hi - lo)) * (rand() < 0.5 ? -1 : 1);

		ctx.rotate((a * Math.PI) / 180);
	}

	if (k.shift) {
		// The crop's edges off by up to `shift` of the card in a random
		// direction, some of it as a scale error.
		const t = rand() * Math.PI * 2;
		const m = k.shift * (0.6 + rand() * 0.4);
		const zoom = 1 + (rand() * 2 - 1) * m * 0.3;

		ctx.translate(Math.cos(t) * m * w * 0.7, Math.sin(t) * m * h * 0.7);
		ctx.scale(zoom, zoom);
	}

	ctx.drawImage(card, -w / 2, -h / 2);

	return jpeg(out, k.quality);
}

// The scan benchmark's capture (lab/bench/bench.js, capture()), copied so
// the fingerprint sees exactly the 240 images the OCR pipeline is scored on:
// the card on a table colour with a 12 % margin, turned and scaled at a
// seeded random, blurred, and JPEG-compressed.
export const BENCH_PASSES = {
	blur: {angle: 1.5, blur: 1.6, quality: 0.8},
	clean: {angle: 1, blur: 0.3, quality: 0.9},
	glare: {angle: 1.5, blur: 0.5, glare: true, quality: 0.8},
	jpeg: {angle: 1.5, blur: 0.6, quality: 0.3},
	nonumber: {angle: 1, blur: 0.4, hideNumber: true, quality: 0.8},
	tilt: {angle: 4.5, blur: 0.6, quality: 0.8},
};

export async function benchCapture(bitmap, id, passName) {
	const k = BENCH_PASSES[passName];
	const rand = seeded(id + passName);
	const w = bitmap.width;
	const h = bitmap.height;
	const W = Math.round(w * 1.12);
	const H = Math.round(h * 1.12);
	const turn = rand() * 2 - 1;
	const angle = turn * k.angle;
	const scale = 0.95 + rand() * 0.06;
	const dx = (rand() * 2 - 1) * 0.02 * w;
	const dy = (rand() * 2 - 1) * 0.02 * h;
	const brightness = 0.92 + rand() * 0.16;
	const card = new OffscreenCanvas(w, h);
	const cctx = card.getContext('2d');

	cctx.drawImage(bitmap, 0, 0);

	if (k.hideNumber) {
		const strip = new OffscreenCanvas(w, Math.round(h * 0.12));
		const sctx = strip.getContext('2d');

		sctx.filter = 'blur(6px)';
		sctx.drawImage(bitmap, 0, Math.round(h * 0.88), w, strip.height, 0, 0, w, strip.height);
		cctx.drawImage(strip, 0, Math.round(h * 0.88));
	}

	if (k.glare) {
		const gx = w * (0.15 + rand() * 0.7);
		const gy = h * (rand() < 0.5 ? 0.15 + rand() * 0.2 : 0.75 + rand() * 0.2);
		const r = w * (0.25 + rand() * 0.2);
		const grad = cctx.createRadialGradient(gx, gy, 0, gx, gy, r);

		grad.addColorStop(0, 'rgba(255,255,255,0.85)');
		grad.addColorStop(0.5, 'rgba(255,255,255,0.45)');
		grad.addColorStop(1, 'rgba(255,255,255,0)');
		cctx.fillStyle = grad;
		cctx.fillRect(0, 0, w, h);
	}

	const canvas = new OffscreenCanvas(W, H);
	const ctx = canvas.getContext('2d');

	ctx.fillStyle = '#5a4a3c';
	ctx.fillRect(0, 0, W, H);
	ctx.filter = `blur(${k.blur.toFixed(2)}px) brightness(${brightness.toFixed(2)})`;
	ctx.translate(W / 2 + dx, H / 2 + dy);
	ctx.rotate((angle * Math.PI) / 180);
	ctx.scale(scale, scale);
	ctx.drawImage(card, -w / 2, -h / 2);

	return jpeg(canvas, k.quality);
}

function queryRecords(img) {
	img = thumbnail(img);

	const out = new Uint8Array(RECORD * QUERY_SHIFTS.length);

	QUERY_SHIFTS.forEach((shift, i) => out.set(record(img, shift), i * RECORD));

	return out;
}

let index = null;

window.fp = {
	RECORD,
	shifts: QUERY_SHIFTS.length,
	// Index side: one record per image, decoded at its own size.
	async describe(srcs) {
		const out = new Uint8Array(RECORD * srcs.length);
		const ok = [];

		await Promise.all(srcs.map(async (src, i) => {
			try {
				const bitmap = await bitmapOf(src);

				out.set(record(thumbnail(pixels(bitmap))), i * RECORD);
				bitmap.close();
				ok.push(i);
			}
			catch {
				// Left as zeros; reported as failed.
			}
		}));

		return {data: base64(out), ok};
	},
	// Query side: each degradation of one card image, as a straightened crop
	// (no rectify), every query shift.
	async degraded(src, seed, passes, {full = false} = {}) {
		const bitmap = await bitmapOf(src);
		const out = {};

		for (const pass of passes) {
			out[pass] = base64(queryRecords(await degrade(bitmap, `${seed}:${pass}`, DEGRADATIONS[pass], {full})));
		}

		return out;
	},
	// Query side: the benchmark's captures through rectify.js.
	async bench(src, id, passes) {
		const bitmap = await bitmapOf(src);
		const out = {};

		for (const pass of passes) {
			const r = rectify(await benchCapture(bitmap, id, pass));

			out[pass] = {data: base64(queryRecords(r.card)), found: r.found};
		}

		return out;
	},
	// Query side: a region of a photo (x, y, w, h in its pixels, a generous
	// box around the card), straightened by rectify.js.
	async photo(src, box) {
		const bitmap = await bitmapOf(src);
		const c = new OffscreenCanvas(box.w, box.h);
		const ctx = c.getContext('2d', {willReadFrequently: true});

		ctx.drawImage(bitmap, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);

		const img = ctx.getImageData(0, 0, box.w, box.h);
		const r = rectify(img);

		return {card: `${r.card.width}x${r.card.height}`, data: base64(queryRecords(r.card)), found: r.found, note: r.note};
	},
	// Timing: load the packed index, then time rectify, fingerprint, and
	// match over `runs` captures of one image.
	async loadIndex(url) {
		const t0 = performance.now();

		index = await loadIndex(url);

		return {count: index.count, ms: Math.round(performance.now() - t0)};
	},
	async time(src, id, {runs = 10} = {}) {
		const bitmap = await bitmapOf(src);
		const times = [];
		let top = null;

		for (let i = 0; i < runs; i++) {
			const pass = Object.keys(BENCH_PASSES)[i % 6];
			const capture = await benchCapture(bitmap, id, pass);
			const t0 = performance.now();
			const r = rectify(capture);
			const t1 = performance.now();
			const result = match(index, r.card);

			times.push({fingerprint: result.timings.fingerprint, match: result.timings.match, rectify: t1 - t0, total: performance.now() - t0});
			top = result.groups[0] && result.groups[0].cards[0].id;
		}

		return {times, top};
	},
};

window.fpReady = true;
