// The scan benchmark page, driven by run.mjs. Each run makes a simulated
// capture (a TCGdex card scan laid on a table colour, turned, scaled,
// blurred, and JPEG-compressed, as the camera's capture area would hold it)
// and runs the scanner's own code on it: js/scan/rectify.js, read.js with
// the ocr.js pool, artwork.js, and match.js, the way js/scan/identify.js
// and view.js do. It also matches without the artwork and with the number
// alone, so a change can be traced to the route that gained or lost.
//
// Photo mode builds the capture from one photo instead: the card's box in
// the photo is fitted to the scanner's guide by its width or its height,
// turned in the plane by a few degrees, or made small, and drawn on a
// camera frame as Chrome's fake camera would show it.

import {captureRect} from '/pokemon-card-tracker/lab/js/camera.js';
import {artVector} from '/pokemon-card-tracker/js/scan/artwork.js';
import {DEFAULT_API, findCandidates} from '/pokemon-card-tracker/js/scan/match.js';
import {createPool} from '/pokemon-card-tracker/js/scan/ocr.js';
import {readCard} from '/pokemon-card-tracker/js/scan/read.js';
import {rectify} from '/pokemon-card-tracker/js/scan/rectify.js';
import {judgeMatch, summariseRead} from '/pokemon-card-tracker/js/scan/session.js';

let pool = null;

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

const bitmaps = new Map();

async function bitmapOf(src) {
	if (!bitmaps.has(src)) {
		bitmaps.set(src, fetch(src).then((response) => response.blob()).then((blob) => createImageBitmap(blob)));
	}

	return bitmaps.get(src);
}

// The degradations. Every capture is the card over a table colour with a
// 12 % margin, turned and scaled a little, as the capture area crops it.
// The seed is the card and the pass, so every run sees the same captures.
export const PASSES = {
	blur: {angle: 1.5, blur: 1.6, quality: 0.8},
	clean: {angle: 1, blur: 0.3, quality: 0.9},
	glare: {angle: 1.5, blur: 0.5, glare: true, quality: 0.8},
	jpeg: {angle: 1.5, blur: 0.6, quality: 0.3},
	// The number strip blurred out, so only the top of the card reads.
	nonumber: {angle: 1, blur: 0.4, hideNumber: true, quality: 0.8},
	tilt: {angle: 4.5, blur: 0.6, quality: 0.8},
};

async function capture(bitmap, id, passName) {
	const k = PASSES[passName];
	const rand = seeded(id + passName);
	const w = bitmap.width;
	const h = bitmap.height;
	const W = Math.round(w * 1.12);
	const H = Math.round(h * 1.12);
	const angle = (rand() * 2 - 1) * k.angle;
	const scale = 0.95 + rand() * 0.06;
	const dx = (rand() * 2 - 1) * 0.02 * w;
	const dy = (rand() * 2 - 1) * 0.02 * h;
	const brightness = 0.92 + rand() * 0.16;
	const card = new OffscreenCanvas(w, h);
	const cctx = card.getContext('2d');

	cctx.drawImage(bitmap, 0, 0);

	if (k.hideNumber) {
		// Blur the bottom 12 % hard, as a finger, a sleeve edge, or a label would.
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

	const jpeg = await canvas.convertToBlob({quality: k.quality, type: 'image/jpeg'});
	const back = await createImageBitmap(jpeg);
	const out = new OffscreenCanvas(W, H);

	out.getContext('2d').drawImage(back, 0, 0);

	return out.getContext('2d').getImageData(0, 0, W, H);
}

// A camera frame (width x height) showing the photo with the card's box
// (x, y, w, h in the photo's pixels) fitted to the guide: fit 'width'
// makes the box as wide as the guide, 'height' as tall (a card seen at a
// slant, wider at the top, then runs past the guide's sides); `size`
// shrinks it (0.45: held far away); `angle` turns it in the plane, in
// degrees, clockwise. The rest of the frame is the photo itself around the
// card, on a near-black ground where the photo ends.
export async function photoFrame(src, {angle = 0, box, fit = 'width', height = 1920, size = 1, width = 1080} = {}) {
	const bitmap = await bitmapOf(src);
	const guide = captureRect(width, height).guide;
	const scale = (fit === 'height' ? guide.h / box.h : guide.w / box.w) * size;
	const canvas = new OffscreenCanvas(width, height);
	const ctx = canvas.getContext('2d');

	ctx.fillStyle = '#0c0c0f';
	ctx.fillRect(0, 0, width, height);
	ctx.translate(guide.x + guide.w / 2, guide.y + guide.h / 2);
	ctx.rotate((angle * Math.PI) / 180);
	ctx.scale(scale, scale);
	ctx.drawImage(bitmap, -(box.x + box.w / 2), -(box.y + box.h / 2));

	return ctx.getImageData(0, 0, width, height);
}

function cropRect(img, {h, w, x, y}) {
	const c = new OffscreenCanvas(img.width, img.height);

	c.getContext('2d').putImageData(img, 0, 0);

	return c.getContext('2d').getImageData(x, y, w, h);
}

async function imageUrl(img) {
	const c = new OffscreenCanvas(img.width, img.height);

	c.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);

	const blob = await c.convertToBlob({type: 'image/png'});

	return new Promise((resolve) => {
		const reader = new FileReader();

		reader.onload = () => resolve(reader.result);
		reader.readAsDataURL(blob);
	});
}

const langOf = (read) => (read.language && read.language.code) || null;
const small = (cands) => cands.map((c) => ({conf: c.confidence ?? null, id: c.id, reasons: c.reasons, score: c.score}));

async function measure(image, {crops = false, options = {}} = {}) {
	const t0 = performance.now();
	const r = rectify(image);
	const t1 = performance.now();
	const read = await readCard(r.card, pool.ocr, options);
	const t2 = performance.now();
	const artwork = artVector(r.card);
	const lang = langOf(read);
	const full = await findCandidates(read, lang, {artwork}).catch((e) => ({candidates: [], error: e.name, names: []}));
	const t3 = performance.now();
	const noArt = await findCandidates(read, lang, {artwork: null}).catch((e) => ({candidates: [], error: e.name}));
	const numberOnly = await findCandidates(read, lang, {api: {...DEFAULT_API, artworkSims: null, species: null}}).catch((e) => ({candidates: [], error: e.name}));
	const judged = judgeMatch(summariseRead(read), full.candidates || [], Boolean(full.partial), full.names || []);
	const out = {
		angle: r.angle,
		attack: read.attackText ? read.attackText.slice(0, 120) : '',
		candidates: small(full.candidates),
		cardSize: `${r.card.width}x${r.card.height}`,
		found: r.found,
		hp: read.hp,
		label: read.label.code,
		language: read.language,
		name: read.name,
		names: full.names,
		noArt: small(noArt.candidates),
		note: r.note,
		number: read.number && `${read.number.number}/${read.number.total}`,
		numberOnly: small(numberOnly.candidates),
		partial: read.partial,
		raw: Object.fromEntries(Object.entries(read.raw).map(([k, v]) => [k, v.text])),
		routes: full.routes,
		sure: judged.sure,
		timings: {match: Math.round(t3 - t2), ocr: Math.round(t2 - t1), perRegion: read.timings, rectify: Math.round(t1 - t0), total: Math.round(t3 - t0)},
		why: judged.why,
		year: read.copyrightYear,
	};

	if (crops) {
		out.crops = {card: await imageUrl(r.card)};

		for (const [k, v] of Object.entries(read.crops)) {
			out.crops[k] = await imageUrl(v);
		}
	}

	return out;
}

window.bench = {
	async init({workers = 2} = {}) {
		if (pool) {
			await pool.terminate();
		}

		pool = await createPool({size: workers});

		// Wait for the second worker.
		const end = performance.now() + 20000;

		while (pool.size < workers && performance.now() < end) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		return {pool: pool.loadMs, size: pool.size};
	},
	// One card from the dataset through one pass.
	async run(item, {crops = false, options = {}, pass = 'clean'} = {}) {
		const image = await capture(await bitmapOf(item.file), item.id, pass);

		return {id: item.id, new: await measure(image, {crops, options}), pass};
	},
	// One framing of the photo: the capture area of the camera frame.
	async photo(src, frame, {crops = false, options = {}} = {}) {
		const full = await photoFrame(src, frame);

		return {id: null, new: await measure(cropRect(full, captureRect(full.width, full.height)), {crops, options}), pass: frame.name};
	},
	// The same framing as a whole camera frame, as RGBA bytes in base64, for
	// a fake camera still (run.mjs --stills).
	async photoFrameBytes(src, frame) {
		const full = await photoFrame(src, frame);
		let binary = '';

		for (let i = 0; i < full.data.length; i += 0x8000) {
			binary += String.fromCharCode.apply(null, full.data.subarray(i, i + 0x8000));
		}

		return {data: btoa(binary), height: full.height, width: full.width};
	},
};

window.benchReady = true;
