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

import {captureRect} from '/pokemon-card-tracker/js/vision/camera.js';
import {artVector} from '/pokemon-card-tracker/js/scan/artwork.js';
import {DEFAULT_API, findCandidates} from '/pokemon-card-tracker/js/scan/match.js';
import {createPool} from '/pokemon-card-tracker/js/scan/ocr.js';
import {readCard, readNumber} from '/pokemon-card-tracker/js/scan/read.js';
import {rectify} from '/pokemon-card-tracker/js/scan/rectify.js';
import {judgeMatch, summariseRead} from '/pokemon-card-tracker/js/scan/session.js';
import {identify} from '/pokemon-card-tracker/js/scan/identify.js';
import {pictureMatch} from '/pokemon-card-tracker/js/scan/picture.js';
import {rectQuad} from '/pokemon-card-tracker/js/scan/rectify.js';

// The whole-frame path (--frame): the camera's guide laid out on a phone
// screen, and the card found anywhere in the frame (js/scan/steady.js
// findCard, version 34), as js/scan/view.js does at the moment of capture.
// A tree from before it (REPO=) has no frame mode.
const whole = await Promise.all([import('/pokemon-card-tracker/js/scan/camera.js'), import('/pokemon-card-tracker/js/scan/steady.js')])
	.then(([camera, steady]) => ({...camera, ...steady}))
	.catch(() => null);

let pool = null;

// The Japanese and Korean name reading's options as the app passes them
// (js/scan/view.js cjkOptions, with no language picked yet: Korean is tried
// first), when the tree being measured has them. An older tree has no
// local-names.js asianNameScore, and its reader ignores the options.
const names = await import('/pokemon-card-tracker/js/scan/local-names.js').catch(() => ({}));
const APP_OPTIONS = names.asianNameScore ? {cjk: {guess: 'ko', language: null, lean: false}, scoreLatin: (text) => names.latinNameScore(text), scoreName: (text) => names.asianNameScore(text)} : {};

// The reader's model state and background loading, as js/scan/identify.js
// passes them, when the pool has them (a card whose language is not known
// reads only with a model already loaded, and prepares one for the next).
const poolOptions = () => (pool && pool.asianState ? {modelState: pool.asianState, prepareModel: pool.prepare} : {});

// Every OCR call of one card, counted here so an older tree's reads are
// counted the same way.
let calls = 0;
const counted = (image, settings) => {
	calls++;

	return pool.ocr(image, settings);
};

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
	// Held at a slant in the hand: turned 10 to 20 degrees either way, so
	// the card's corners run out of the capture. Not in the default run,
	// which stays comparable with the 240 reads measured before it.
	slant: {angle: 20, blur: 0.6, minAngle: 10, quality: 0.8},
	// The same, the card a little taller than the guide (106 to 112 % of
	// it: the whole capture's height), so more of it runs out (the roadmap's
	// strong-slant cut, 2026-11-04).
	slantfull: {angle: 20, blur: 0.6, minAngle: 10, quality: 0.8, scale: [1.06, 0.06]},
	tilt: {angle: 4.5, blur: 0.6, quality: 0.8},
	// Held low: the card as tall as the capture (108 to 112 % of the guide)
	// and 7 % of its height below the middle, turned up to 4 degrees, so
	// its foot runs 5 to 9 % out of the capture while its top is in it
	// (2026-11-05: slantfull centres the card, so only its corners run
	// out, and never cuts the foot this way).
	low: {angle: 4, blur: 0.6, down: 0.07, quality: 0.8, scale: [1.08, 0.04]},
	// The same, the card as tall as the guide and turned 6 to 16 degrees.
	lowslant: {angle: 16, blur: 0.6, down: 0.07, minAngle: 6, quality: 0.8, scale: [1, 0.04]},
};

// A Korean copy of a Japanese card, for the benchmark only: TCGdex has no
// Korean images for the sets Korean copies are kept on, so the Japanese
// scan's name is painted over and the Korean name drawn in its place, in a
// bold Korean gothic as tall as the Japanese name. Measured on modern
// Japanese scans (600 x 825): the name runs from about 19 % to at most 70 %
// of the width, 3 to 8 % down, after the stage label and before the HP. Each
// column of that box is filled with the colour just above it (the stage
// label's shadow lies just left of it, the art's frame just below).
// Synthetic: real Korean prints use their own typeface.
export async function koreanCard(bitmap, korean) {
	const w = bitmap.width;
	const h = bitmap.height;
	const canvas = new OffscreenCanvas(w, h);
	const ctx = canvas.getContext('2d');

	ctx.drawImage(bitmap, 0, 0);

	const image = ctx.getImageData(0, 0, w, h);
	const x0 = Math.round(w * 0.185);
	const x1 = Math.round(w * 0.715);
	const y0 = Math.round(h * 0.03);
	const y1 = Math.round(h * 0.08);
	const colourAt = (x, y) => {
		const sum = [0, 0, 0];

		for (let dx = -1; dx <= 1; dx++) {
			const i = (y * w + Math.min(w - 1, Math.max(0, x + dx))) * 4;

			for (let c = 0; c < 3; c++) {
				sum[c] += image.data[i + c] / 3;
			}
		}

		return sum;
	};

	for (let x = x0; x <= x1; x++) {
		const above = colourAt(x, y0 - 2);

		for (let y = y0; y <= y1; y++) {
			const o = (y * w + x) * 4;

			for (let c = 0; c < 3; c++) {
				image.data[o + c] = above[c];
			}
		}
	}

	ctx.putImageData(image, 0, 0);

	let size = Math.round(h * 0.04);

	ctx.font = `700 ${size}px "Noto Sans CJK KR", sans-serif`;

	const width = ctx.measureText(korean).width;

	if (width > w * 0.5) {
		size = Math.floor((size * w * 0.5) / width);
		ctx.font = `700 ${size}px "Noto Sans CJK KR", sans-serif`;
	}

	ctx.fillStyle = '#1d1d1f';
	ctx.textBaseline = 'alphabetic';
	ctx.fillText(korean, Math.round(w * 0.195), Math.round(h * 0.073));

	return createImageBitmap(canvas);
}

// The four corners (top left, top right, bottom right, bottom left) of a
// w x h card centred on (cx, cy) and turned `angle` degrees clockwise: where
// the card really is in a capture, for --geometry.
function cardCorners(cx, cy, w, h, angle) {
	const radians = (angle * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);

	return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([x, y]) => ({x: cx + x * cos - y * sin, y: cy + x * sin + y * cos}));
}

// The camera frame and the screen the frame mode lays the guide out on: a
// portrait 1080 x 1920 frame shown in a 384 x 600 CSS px video area (Eric's
// phone is 384 px wide; the tray takes the foot of the screen).
const FRAME = {height: 1920, width: 1080};
const STAGE = {height: 600, width: 384};

// The card under the guide of a whole camera frame, with the same turn,
// size, offset, light, blur, and JPEG as the guide's capture (all scaled
// from the card scan's pixels to the guide's), then found in the frame as
// js/scan/view.js finds it at the moment of capture (the shutter: a small
// card is taken too) and cut out round it (camera.js boxAround); with no
// card found, the guide's capture area. The ImageData carries `truth` (the
// card's corners in its pixels), `frameFound`, and `quads` (the outlines
// found, in its pixels, as identify.js takes them).
async function frameCapture(card, k, {angle, brightness, dx, dy, scale}) {
	const area = whole.layoutGuide(FRAME, STAGE);
	const f = area.guide.h / card.height;
	const canvas = new OffscreenCanvas(FRAME.width, FRAME.height);
	const ctx = canvas.getContext('2d');
	const cx = area.guide.x + area.guide.w / 2 + dx * f;
	const cy = area.guide.y + area.guide.h / 2 + dy * f;

	ctx.fillStyle = '#5a4a3c';
	ctx.fillRect(0, 0, FRAME.width, FRAME.height);
	ctx.filter = `blur(${(k.blur * f).toFixed(2)}px) brightness(${brightness.toFixed(2)})`;
	ctx.translate(cx, cy);
	ctx.rotate((angle * Math.PI) / 180);
	ctx.scale(scale * f, scale * f);
	ctx.drawImage(card, -card.width / 2, -card.height / 2);

	const back = await createImageBitmap(await canvas.convertToBlob({quality: k.quality, type: 'image/jpeg'}));
	// A canvas standing in for the video: camera.js reads videoWidth and
	// videoHeight and draws it.
	const video = document.createElement('canvas');

	video.width = FRAME.width;
	video.height = FRAME.height;
	video.getContext('2d').drawImage(back, 0, 0);
	Object.defineProperties(video, {videoHeight: {value: FRAME.height}, videoWidth: {value: FRAME.width}});

	const view = whole.viewFrame(video, document.createElement('canvas'), area.view, whole.FIND_SIDE_CAPTURE);
	const found = whole.findCard(view.grey, view.width, view.height);
	const toFrame = (p) => ({x: view.rect.x + p.x / view.scale, y: view.rect.y + p.y / view.scale});
	let region = area.capture;
	let quads = [];

	if (found.quad) {
		const all = [{angle: found.angle, corners: found.quad, ratio: found.ratio, upright: found.upright}, ...found.others]
			.map((one) => ({...one, box: whole.boxAround(FRAME, one.corners.map(toFrame)), corners: one.corners.map(toFrame)}));
		const [chosen] = all;
		const shot = whole.thumbnailFrame(video, document.createElement('canvas'), chosen.box);
		const upright = chosen.upright && Math.abs(chosen.angle) <= 20;
		const present = upright ? whole.presence(shot.grey, whole.THUMB_W, whole.THUMB_H, {colour: shot.colour}).present : shot.colour >= whole.COLOURLESS;

		if (present) {
			const box = chosen.box;
			const inBox = (c) => c.x >= box.x && c.y >= box.y && c.x <= box.x + box.w && c.y <= box.y + box.h;
			const others = all.filter((one) => one !== chosen && one.corners.every(inBox));

			region = whole.boxAround(FRAME, [...chosen.corners, ...others.flatMap((other) => other.corners)]);
			quads = [chosen, ...others].map((one) => ({corners: one.corners.map((c) => ({x: c.x - region.x, y: c.y - region.y})), ratio: one.ratio, upright: one.upright}));
		}
	}

	const image = video.getContext('2d').getImageData(region.x, region.y, region.w, region.h);

	image.truth = cardCorners(cx - region.x, cy - region.y, card.width * scale * f, card.height * scale * f, angle);
	image.frameFound = quads.length > 0;
	image.quads = quads;

	return image;
}

async function capture(bitmap, id, passName, {frame = false} = {}) {
	const k = PASSES[passName];
	const rand = seeded(id + passName);
	const w = bitmap.width;
	const h = bitmap.height;
	const W = Math.round(w * 1.12);
	const H = Math.round(h * 1.12);
	const turn = rand() * 2 - 1;
	const angle = k.minAngle ? Math.sign(turn) * (k.minAngle + Math.abs(turn) * (k.angle - k.minAngle)) : turn * k.angle;
	const [scaleFrom, scaleSpread] = k.scale || [0.95, 0.06];
	const scale = scaleFrom + rand() * scaleSpread;
	const dx = (rand() * 2 - 1) * 0.02 * w;
	const dy = (rand() * 2 - 1) * 0.02 * h + (k.down || 0) * h;
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

	if (frame) {
		if (!whole) {
			throw new Error('This tree has no whole-frame search (steady.js findCard).');
		}

		return frameCapture(card, k, {angle, brightness, dx, dy, scale});
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

	const image = out.getContext('2d').getImageData(0, 0, W, H);

	image.truth = cardCorners(W / 2 + dx, H / 2 + dy, w * scale, h * scale, angle);

	return image;
}

// How far the box rectify cut lies from the card (--geometry), as shares
// of the card's height: error, the farthest corner; top and bottom, how far
// the box's top and bottom edges sit inside the card along its own sides
// (negative: outside it), so a crop that stops short of the card's bottom
// shows as a positive bottom.
function boxError(r, image) {
	const truth = image.truth;
	const quad = r.corners || (r.rect ? rectQuad(image, r.rect, r.angle || 0) : null);

	if (!r.found || !quad) {
		return null;
	}

	const tall = (Math.hypot(truth[3].x - truth[0].x, truth[3].y - truth[0].y) + Math.hypot(truth[2].x - truth[1].x, truth[2].y - truth[1].y)) / 2;
	const down = {x: (truth[3].x - truth[0].x + truth[2].x - truth[1].x) / (2 * tall), y: (truth[3].y - truth[0].y + truth[2].y - truth[1].y) / (2 * tall)};
	const along = (p) => (p.x - truth[0].x) * down.x + (p.y - truth[0].y) * down.y;
	const share = (value) => Math.round((value / tall) * 1000) / 1000;

	return {
		bottom: share(tall - (along(quad[2]) + along(quad[3])) / 2),
		error: share(Math.max(...quad.map((p, i) => Math.hypot(p.x - truth[i].x, p.y - truth[i].y)))),
		top: share((along(quad[0]) + along(quad[1])) / 2),
	};
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

// An ImageData's pixels as RGBA bytes in base64, with its size.
function rgbaBase64(image) {
	let binary = '';

	for (let i = 0; i < image.data.length; i += 0x8000) {
		binary += String.fromCharCode.apply(null, image.data.subarray(i, i + 0x8000));
	}

	return {data: btoa(binary), height: image.height, width: image.width};
}

const langOf = (read) => (read.language && read.language.code) || null;
const small = (cands) => cands.map((c) => ({conf: c.confidence ?? null, id: c.id, reasons: c.reasons, score: c.score}));

// The app's own route since the switch to picture first (run.mjs
// --picture): js/scan/identify.js (rectify, fingerprint and match, a
// number-only read when the picture needs one), then js/scan/picture.js
// pictureMatch, with the text route behind it, as js/scan/view.js does.
async function measurePicture(image, {crops = false} = {}) {
	const t0 = performance.now();
	// The outlines found in the whole frame (--frame), as view.js passes them.
	const result = await identify(image, {quads: image.quads || []});
	const read = result.read ? summariseRead(result.read) : null;
	const lang = read && read.language.code ? read.language.code : null;
	const t1 = performance.now();
	const found = await pictureMatch(result.picture, read, lang, {textRoute: (r, l) => findCandidates(r, l, {artwork: result.artwork})});
	const t2 = performance.now();
	const list = found.card ? [found.card, ...found.candidates.filter((c) => c !== found.card)] : found.candidates;
	const candidates = small(list);
	const out = {
		angle: result.angle,
		candidates,
		cardSize: `${result.card.width}x${result.card.height}`,
		found: result.found,
		hp: null,
		language: read ? read.language : null,
		name: null,
		names: [],
		noArt: candidates,
		note: result.note,
		number: read && read.number ? `${read.number.number}/${read.number.total}` : null,
		numberOnly: candidates,
		ocr: result.ocr,
		picture: result.picture ? {gap: result.picture.gap, how: result.picture.how, top: result.picture.groups.map((g) => `${g.cards.map((c) => c.id).join('+')} ${g.score}`)} : null,
		ratio: result.ratio,
		sure: found.sure,
		timings: {fingerprint: result.timings.fingerprint, match: Math.round(t2 - t1) + (result.timings.match || 0), ocr: result.timings.ocr || 0, rectify: result.timings.rectify, total: Math.round(t2 - t0)},
		why: found.why,
	};

	if (crops) {
		out.crops = {card: await imageUrl(result.card)};
	}

	return out;
}

async function measure(image, {crops = false, options = {}} = {}) {
	if (options.pictureFirst) {
		return measurePicture(image, {crops});
	}

	const t0 = performance.now();
	const r = rectify(image);
	const t1 = performance.now();

	calls = 0;

	const read = await readCard(r.card, counted, {...APP_OPTIONS, ...poolOptions(), ...options});
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
		calls,
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

	if (image.truth) {
		out.box = boxError(r, image);
		out.frameFound = image.frameFound ?? null;
	}

	if (crops) {
		out.crops = {card: await imageUrl(r.card)};

		for (const [k, v] of Object.entries(read.crops)) {
			out.crops[k] = await imageUrl(v);
		}
	}

	return out;
}

// The collector number alone (run.mjs --numbers): the capture straightened
// and read as js/scan/identify.js reads a card the picture narrowed
// (read.js readNumber), with `options` (fullArt, prefer) passed through.
async function measureNumber(image, {crops = false, options = {}} = {}) {
	const t0 = performance.now();
	const r = rectify(image);
	const read = await readNumber(r.card, pool.ocr, {prefer: 'left', ...options});
	const out = {
		calls: read.timings.calls,
		found: r.found,
		number: read.number ? {confidence: read.number.confidence, number: read.number.number, total: read.number.total, ringed: Boolean(read.number.ringed)} : null,
		raw: Object.fromEntries(Object.entries(read.raw).map(([k, v]) => [k, v.text])),
		timings: {ocr: read.timings.ocr, total: Math.round(performance.now() - t0)},
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
	// The Japanese and Korean models' first loads in this page (ocr.js
	// createAsianReader), for the report.
	asianLoads: () => (pool && pool.asianLoads) || [],
	// One card from the dataset through one pass; a card with `korean` is
	// first given that Korean name (koreanCard).
	async run(item, {crops = false, frame = false, options = {}, pass = 'clean'} = {}) {
		const bitmap = await bitmapOf(item.file);
		const image = await capture(item.korean ? await koreanCard(bitmap, item.korean) : bitmap, item.id, pass, {frame});

		return {id: item.id, new: await measure(image, {crops, options}), pass};
	},
	// One card through one pass, straightened only (run.mjs --geometry):
	// where the box rectify cut lies against the card (boxError), with no
	// text read.
	async geometry(item, {crops = false, frame = false, pass = 'clean'} = {}) {
		const bitmap = await bitmapOf(item.file);
		const image = await capture(item.korean ? await koreanCard(bitmap, item.korean) : bitmap, item.id, pass, {frame});
		const t0 = performance.now();
		const r = rectify(image);
		const out = {box: boxError(r, image), found: r.found, frameFound: image.frameFound ?? null, guessed: r.guessed, note: r.note, timings: {rectify: Math.round(performance.now() - t0)}};

		if (crops) {
			out.crops = {card: await imageUrl(r.card)};
		}

		return {id: item.id, new: out, pass};
	},
	// One card's collector number alone, through one pass.
	async number(item, {crops = false, options = {}, pass = 'clean'} = {}) {
		const image = await capture(await bitmapOf(item.file), item.id, pass);

		return {id: item.id, new: await measureNumber(image, {crops, options}), pass};
	},
	// One framing of the photo: the capture area of the camera frame.
	async photo(src, frame, {crops = false, options = {}} = {}) {
		const full = await photoFrame(src, frame);

		return {id: null, new: await measure(cropRect(full, captureRect(full.width, full.height)), {crops, options}), pass: frame.name};
	},
	// One card's capture through one pass, as RGBA bytes in base64 with the
	// card's corners in it, for working on the straightening outside the
	// page (Node runs js/scan/rectify.js on it as it is).
	async captureBytes(item, {frame = false, pass = 'clean'} = {}) {
		const bitmap = await bitmapOf(item.file);
		const image = await capture(item.korean ? await koreanCard(bitmap, item.korean) : bitmap, item.id, pass, {frame});

		return {...rgbaBase64(image), truth: image.truth};
	},
	// The same framing as a whole camera frame, as RGBA bytes in base64, for
	// a fake camera still (run.mjs --stills).
	async photoFrameBytes(src, frame) {
		return rgbaBase64(await photoFrame(src, frame));
	},
};

window.benchReady = true;
