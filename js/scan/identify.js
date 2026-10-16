// Reading a capture, picture first (DESIGN.md section 6, Eric,
// 2026-10-03): straighten the card (js/scan/rectify.js), fingerprint it and
// match it against the index of every catalog image (js/scan/picture.js),
// and read text only when the picture cannot settle it: the collector
// number, total, set code box, and language label (js/scan/read.js
// numberOnly) when the first artwork group holds several cards or leads by
// little. A card the index is not on this phone for (its file not loaded)
// is read in full, as before.
//
// The OCR engine (Tesseract.js from lab/vendor/tesseract, never a CDN,
// js/scan/ocr.js) is imported and started only when a card needs text, so
// the Scan screen opens without its 7 MB; it is let go a minute after the
// scanner closes, because each worker holds tens of megabytes a phone may
// want back.
//
// Script detection: the English model reads no Japanese, Korean, or Chinese,
// and no light method that tells kana from Hangul ships with the app (no
// jpn or kor model is vendored), so a card whose Latin label row reads
// nothing is reported as "non-latin" and its sheet asks for the language
// with nothing preselected. The read never borrows the last card's
// language.

import {artVector} from './artwork.js';
import {defaultCapture} from './camera.js';
import {blobImage, imageBlob} from './image.js';
import {compactPicture, loadFingerprints, matchCrops, needsText, pictureVerdict, SURE_DISTANCE} from './picture.js';
import {CARD_MAX_HEIGHT, cropImage, rectify, rectQuad, warpCrop, warpQuad} from './rectify.js';
import {turnImage} from '../vision/fingerprint.js';
import {CARD_RATIO} from '../vision/pipeline.js';

// The height the other crops of a card (rectify.js `others`) are cut at for
// fingerprinting: three times the fingerprint's thumbnail.
const OTHER_CROP_HEIGHT = 402;

export class EngineUnavailable extends Error {
	constructor(cause) {
		super('The reading engine is not on this phone yet. It downloads the first time the scanner opens with a connection.');
		this.name = 'EngineUnavailable';
		this.cause = cause;
	}
}

const RELEASE_AFTER_MS = 60 * 1000;

let enginePromise = null;
let releaseTimer = null;
let progressListener = null;

// Starts the engine, or returns the one starting. onProgress(text) hears
// the download and start-up steps.
export function warmEngine(onProgress) {
	clearTimeout(releaseTimer);
	progressListener = onProgress || progressListener;

	if (!enginePromise) {
		enginePromise = import('./ocr.js').then(({createPool}) => createPool({
			logger: (message) => {
				if (progressListener && message && message.status && typeof message.progress === 'number' && message.progress < 1) {
					progressListener(`${message.status}, ${Math.round(message.progress * 100)}%`);
				}
			},
		})).catch((err) => {
			enginePromise = null;

			throw new EngineUnavailable(err);
		});
	}

	return enginePromise;
}

export const engineStarted = () => Boolean(enginePromise);

// Let the engine go a little after the scanner closes.
export function releaseEngineSoon() {
	progressListener = null;
	clearTimeout(releaseTimer);
	releaseTimer = setTimeout(async () => {
		const pending = enginePromise;

		enginePromise = null;

		if (pending) {
			try {
				(await pending).terminate();
			}
			catch {
				// Never started; nothing to stop.
			}
		}
	}, RELEASE_AFTER_MS);
}

// One card at a time: a phone has the memory for one full-resolution card,
// and the pool's workers are already shared among that card's regions.
let queue = Promise.resolve();

// Reads an ImageData-shaped capture (the guide frame plus its margin, or a
// straightened card when `straight` is true). Returns {angle, artwork, card,
// found, note, ratio, picture, ocr, read, timings: {artwork, fingerprint,
// match, rectify, ocr, total, workers}}. card is the straightened card
// image; picture the fingerprint match (picture.js compactPicture, or null
// when the index could not load); ocr whether text was read; read the read
// (null when the picture settled it); artwork the artwork vector the text
// route's tiebreak uses (null when no text was read); angle, note, and
// ratio what the straightening found (js/scan/rectify.js), for the scan
// report.
//
// photo: a photo picked from the gallery rather than the camera's capture
// area. Its card may sit anywhere in a larger picture, so when the whole
// photo shows no card edges, the part a camera's guide would hold (the
// middle, card-shaped) is tried too.
//
// guide: where the scanner's guide sits in the capture ({x, y, w, h} in its
// pixels). The person lines the card up to it, so the guide itself is
// fingerprinted as one more crop, whatever edges were found (Eric's phone,
// 2026-10-03: twice the top edge was worked out from a wrong side, and the
// crop as found lost to a clean image of the same card by a mile).
//
// quads: the card as found in the whole frame (js/scan/steady.js findCard,
// Eric, 2026-10-09), each {corners, upright} in the capture's pixels, the
// best first: each is cut by its own corners and fingerprinted as one more
// crop (where two cards of a pile and their borders cross, the picture
// chooses), and when the edges here find no card, the first is the card. A
// card lying on its side is cut turned both ways.
//
// pictureFirst false reads the card in full, as before the switch (the
// benchmark's comparison).
export function identify(image, options = {}) {
	const run = queue.then(async () => readText(await seePicture(image, options), options));

	queue = run.catch(() => {});

	return run;
}

// The two halves of identify, each in its own queue, so the scanner never
// holds the next card's picture behind a card whose text is being read
// (Eric's holder log, 2026-10-09: one card needing its number read held the
// next card's picture match 3 to 14 s). identifyPicture straightens and
// matches the picture only, and answers like identify with no text read
// (read null) and `needsText` saying whether text is wanted; identifyText
// reads it for such an answer (it answers at once when none is wanted).
let pictureQueue = Promise.resolve();
let textQueue = Promise.resolve();

export function identifyPicture(image, options = {}) {
	const run = pictureQueue.then(() => seePicture(image, options));

	pictureQueue = run.catch(() => {});

	return run;
}

// identifyPicture in a worker (see-worker.js), so the frame loop is not held
// up by it; on the main thread when a worker cannot start or fails. Answers
// as identifyPicture does, plus `where`, 'worker' or 'main', and `fallback`,
// why a picture meant for the worker was matched here ('no worker', 'worker
// error', 'timeout'), for the scan log. A straightened card
// (options.straight) is matched here: it is small and its image is the
// answer's card.
let worker = null;
let workerFailed = typeof Worker === 'undefined';
let workerWarm = null;
// The warm-up waiting on the worker, told to load here instead if the
// worker fails before it answers.
let warmFallback = null;
let jobSeq = 0;
const jobs = new Map();
// The jobs still owed their full capture's JPEG: id -> onFull.
const fulls = new Map();

// A worker that stops answering would hold its picture, and the card, at
// "Reading" for good. It is let go once it has said nothing for `job` ms
// while pictures wait on it, or `load` ms while it is still loading the
// index (a first visit downloads 1.2 MB); every picture it held is matched
// here, and so is every picture after it, this visit. The worker answers a
// picture in 0.1 to 2.4 s on Eric's phone (version 38 log), one at a time,
// so `job` is several of the slowest. Tests shorten both.
export const WORKER_LIMITS = {job: 10000, load: 30000};

// When the worker was last heard from, when it was given work with none
// waiting, and whether its index is in.
let heardAt = 0;
let busySince = 0;
let workerReady = false;
let watchTimer = null;

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function watchWorker() {
	clearTimeout(watchTimer);
	watchTimer = null;

	if (!worker || (!jobs.size && !warmFallback)) {
		return;
	}

	const limit = workerReady ? WORKER_LIMITS.job : WORKER_LIMITS.load;
	const left = Math.max(heardAt, busySince) + limit - clock();

	if (left <= 0) {
		dropWorker('timeout');

		return;
	}

	watchTimer = setTimeout(watchWorker, Math.min(left + 5, 1000));
}

// The worker given up (it errored, or said nothing for too long): every
// picture it held is matched here, the warm-up loads the index here, and
// no worker is started again this visit.
function dropWorker(why) {
	const gone = worker;
	const held = [...jobs.values()];

	workerFailed = true;
	worker = null;
	clearTimeout(watchTimer);
	watchTimer = null;

	if (gone) {
		gone.terminate();
	}

	jobs.clear();
	fulls.clear();

	for (const job of held) {
		job.resolve(fallback(job, why));
	}

	if (warmFallback) {
		warmFallback();
	}
}

function startWorker() {
	const next = new Worker(new URL('./see-worker.js', import.meta.url), {type: 'module'});

	heardAt = clock();
	workerReady = false;
	next.addEventListener('message', ({data}) => {
		if (worker !== next) {
			return;
		}

		heardAt = clock();

		if (data.warm) {
			workerReady = workerReady || Boolean(data.ok);

			return;
		}

		// The worker has read a bitmap's pixels: the spare kept for a
		// fallback is let go, so the camera's frames are not held.
		if (data.decoded) {
			const job = jobs.get(data.id);

			if (job && job.spare) {
				closeBitmap(job.spare);
				job.spare = null;
			}

			return;
		}

		// The full capture as a JPEG, encoded in the worker: it may come
		// before the answer or after it. Kept on the job too, for a fallback
		// once the bitmap is gone.
		if (data.full !== undefined) {
			const onFull = fulls.get(data.id);
			const job = jobs.get(data.id);

			fulls.delete(data.id);

			if (job) {
				job.full = data.full;
				job.fullSent = true;
			}

			if (onFull) {
				onFull(data.full);
			}

			return;
		}

		const job = jobs.get(data.id);

		if (!job) {
			return;
		}

		jobs.delete(data.id);
		workerReady = true;
		watchWorker();

		if (job.spare) {
			closeBitmap(job.spare);
			job.spare = null;
		}

		// A capture sent as a bitmap comes back as pixels: the page keeps it
		// for the scan report's capture image, and reads it here if the
		// worker could not.
		const image = data.capture || job.image;

		if (data.error) {
			job.resolve(fallback({...job, image}, 'worker error'));

			return;
		}

		const {result} = data;
		const trace = result.trace ? {...result.trace, capture: data.sameCapture ? image : result.trace.capture, card: result.card} : null;

		job.resolve({...result, capture: data.capture ? image : undefined, fallback: null, trace, where: 'worker'});
	});
	next.addEventListener('error', () => {
		if (worker === next) {
			dropWorker('worker error');
		}
	});

	return next;
}

function pictureWorker() {
	if (!worker && !workerFailed) {
		try {
			worker = startWorker();
		}
		catch {
			workerFailed = true;
		}
	}

	return worker;
}

function closeBitmap(bitmap) {
	try {
		bitmap.close();
	}
	catch {
		// Already closed.
	}
}

// A copy of a capture's bitmap kept until the worker has read it (a
// VideoFrame's clone shares its picture; an ImageBitmap is copied), so a
// worker that dies first does not take the capture with it. null when no
// copy can be made.
async function spareOf(bitmap) {
	try {
		if (typeof bitmap.clone === 'function') {
			return bitmap.clone();
		}

		return typeof createImageBitmap === 'function' ? await createImageBitmap(bitmap) : null;
	}
	catch {
		return null;
	}
}

// A job the worker could not do, done here: from the image itself when the
// page still has it (pixels are copied to the worker, not moved), else from
// the spare copy of a bitmap, else from the full capture's JPEG the worker
// made. A capture with none of these left (the worker died between reading
// the bitmap and making the JPEG) fails, and the card waits as a read cut
// short does. The full capture's JPEG, when the worker had not sent it, is
// made here.
async function fallback({full = null, fullSent = false, image, options, spare = null}, why) {
	let pixels = image && !image.bitmap ? image : null;

	if (!pixels && spare) {
		pixels = bitmapPixels({...image, bitmap: spare});
	}

	if (!pixels && full && typeof createImageBitmap === 'function') {
		pixels = await blobImage(full).catch(() => null);
	}

	if (image && image.bitmap && options.onFull && !fullSent) {
		if (pixels) {
			imageBlob(pixels, {quality: 0.92}).then(options.onFull, () => options.onFull(null));
		}
		else {
			options.onFull(null);
		}
	}

	if (!pixels) {
		throw new Error('The capture was lost with the picture worker.');
	}

	const result = await identifyPicture(pixels, options);

	return {...result, capture: options.wantCapture || (image && image.bitmap) ? pixels : undefined, fallback: why, where: 'main'};
}

// Whether a capture can be taken as a bitmap and read in the worker
// (camera.js grabBitmap): the worker is running or can start, and it can
// draw a bitmap (OffscreenCanvas). Otherwise the page reads the pixels.
export function canReadAway() {
	return typeof createImageBitmap === 'function' && typeof OffscreenCanvas !== 'undefined' && Boolean(pictureWorker());
}

// image: ImageData, or a capture taken as a bitmap ({bitmap, crop, width,
// height}, camera.js grabBitmap), which the worker turns into pixels, off
// the main thread (Eric's phone: 380 to 550 ms for the full grab). For a
// bitmap, options.onFull(blob) receives the full capture as a JPEG (quality
// 0.92) encoded in the worker, or null, and the answer's `capture` is the
// capture's pixels. Without a worker, a bitmap is read here.
export async function identifyPictureAway(image, options = {}) {
	const away = options.straight ? null : pictureWorker();
	const why = options.straight ? null : 'no worker';

	if (image && image.bitmap && (!away || typeof OffscreenCanvas === 'undefined')) {
		const pixels = bitmapPixels(image);

		if (options.onFull) {
			imageBlob(pixels, {quality: 0.92}).then(options.onFull, () => options.onFull(null));
		}

		const result = await identifyPicture(pixels, options);

		return {...result, capture: pixels, fallback: why, where: 'main'};
	}

	if (!away) {
		return {...(await identifyPicture(image, options)), fallback: why, where: 'main'};
	}

	const spare = image.bitmap ? await spareOf(image.bitmap) : null;

	// The worker was given up while the spare was made.
	if (worker !== away) {
		return fallback({image, options, spare}, 'worker error');
	}

	// Only what the picture half reads goes to the worker (readOptions
	// carries a callback, which cannot be sent).
	const {guide = null, photo = false, pictureFirst = true, quads = []} = options;

	return new Promise((resolve, reject) => {
		const id = ++jobSeq;

		if (!jobs.size) {
			busySince = clock();
		}

		jobs.set(id, {id, image, options, resolve: (answer) => Promise.resolve(answer).then(resolve, reject), spare});

		if (image.bitmap && options.onFull) {
			fulls.set(id, options.onFull);
		}

		try {
			if (image.bitmap) {
				away.postMessage({full: Boolean(options.onFull), id, image: {bitmap: image.bitmap, crop: image.crop || null, height: image.height, width: image.width}, options: {guide, photo, pictureFirst, quads}}, [image.bitmap]);
			}
			else {
				away.postMessage({id, image: {data: image.data, height: image.height, width: image.width}, options: {guide, photo, pictureFirst, quads}});
			}
		}
		catch {
			const job = jobs.get(id);

			jobs.delete(id);
			fulls.delete(id);
			fallback(job, 'worker error').then(resolve, reject);

			return;
		}

		watchWorker();
	});
}

// A bitmap's pixels (camera.js grabBitmap), on this thread.
function bitmapPixels({bitmap, crop = null, height, width}) {
	const canvas = document.createElement('canvas');

	canvas.width = width;
	canvas.height = height;

	const ctx = canvas.getContext('2d', {willReadFrequently: true});

	if (crop) {
		ctx.drawImage(bitmap, crop.x, crop.y, crop.w, crop.h, 0, 0, width, height);
	}
	else {
		ctx.drawImage(bitmap, 0, 0);
	}

	bitmap.close();

	return ctx.getImageData(0, 0, width, height);
}

// Loads the picture index where the pictures are matched (the worker, or
// this thread). Resolves once it is in; rejects when it cannot load.
export function warmPicture() {
	const away = pictureWorker();

	if (!away) {
		return loadFingerprints();
	}

	if (!workerWarm) {
		workerWarm = new Promise((resolve, reject) => {
			warmFallback = () => {
				warmFallback = null;
				workerWarm = null;
				loadFingerprints().then(resolve, reject);
			};

			const heard = ({data}) => {
				if (data && data.warm) {
					away.removeEventListener('message', heard);
					warmFallback = null;

					if (data.ok) {
						resolve();
					}
					else {
						workerWarm = null;
						reject(new Error('The picture index could not load.'));
					}
				}
			};

			away.addEventListener('message', heard);
			away.postMessage({warm: true});
			watchWorker();
		});
	}

	return workerWarm;
}

export function identifyText(seen, options = {}) {
	const run = textQueue.then(() => readText(seen, options));

	textQueue = run.catch(() => {});

	return run;
}

async function seePicture(image, {guide = null, photo = false, quads = [], straight = false, pictureFirst = true} = {}) {
	const started = performance.now();
	let rectified = straight ? {card: image, found: true, others: []} : rectify(image);
	const found = straight ? [] : quadCrops(quads);

	if (!straight && !rectified.found && found.length) {
		const [first] = found;

		rectified = {
			angle: 0,
			card: cutQuad(image, first.corners),
			corners: first.corners,
			found: true,
			guessed: null,
			note: 'Card found in the frame; cut by its corners.',
			others: [],
			ratio: first.ratio ?? null,
			rect: null,
			variants: [],
		};
		found.shift();
	}

	if (photo && !rectified.found) {
		const area = cropImage(image, defaultCapture(image.width, image.height));
		const middle = rectify(area);

		if (middle.found) {
			rectified = {...middle, note: `${middle.note} (in the middle of the photo)`, source: area};
		}
	}

	const rectifyMs = Math.round(performance.now() - started);
	let card = rectified.card;
	let picture = null;
	let fingerprintMs = null;
	let matchMs = null;
	let variantsTried = [];
	// The box the edges made, on the capture, and the crop that won.
	const source = rectified.source || image;
	const mainQuad = straight || !rectified.found ? null : rectified.corners || (rectified.rect ? rectQuad(source, rectified.rect, rectified.angle || 0) : null);
	let won = {how: mainQuad ? 'the edges found' : 'the frame as it is', quad: mainQuad};
	let guideRect = null;

	if (pictureFirst) {
		try {
			const index = await loadFingerprints();
			const others = [...(rectified.others || []), ...found];
			const guideCrop = !straight && guide && guide.w > 0 && guide.h > 0 ? {how: 'the guide', rect: guide} : null;
			const cutOther = (other, height) => (other.corners ? cutQuad(image, other.corners, height) : other === guideCrop || !rectified.cut ? warpCrop(image, 0, other.rect, Math.min(1, height / other.rect.h)) : rectified.cut(other.rect, height));

			if (guideCrop) {
				others.push(guideCrop);
				guideRect = guide;
			}

			const quadOf = (other) => other.corners || rectQuad(other === guideCrop ? image : source, other.rect, other === guideCrop ? 0 : other.rect.angle ?? (rectified.corners ? 0 : rectified.angle || 0));

			const crops = [card, ...others.map((other) => cutOther(other, OTHER_CROP_HEIGHT))];
			const matched = matchCrops(index, crops);
			const how = matched.crop > 0 ? others[matched.crop - 1].how : null;
			// The card upside down or on its side (matchCrops turn): every crop
			// kept from here is turned upright, for the number and the photo.
			const turn = matched.turn || 0;

			fingerprintMs = matched.timings.fingerprint;
			matchMs = matched.timings.match;

			if (how) {
				const other = others[matched.crop - 1];

				card = cutOther(other, other.corners ? undefined : Math.min(CARD_MAX_HEIGHT, other.rect.h));
				won = {how, quad: quadOf(other)};

				// An outline found on the small copy of the frame is a few
				// pixels off at full resolution, which the picture forgives
				// and the number strip's read does not: its edges are found
				// again on the card cut with a margin, and that crop is kept
				// when it matches as well.
				if (other.corners) {
					const refined = refineQuad(image, other.corners);

					if (refined) {
						const again = matchCrops(index, [turnImage(warpCrop(refined, 0, {h: refined.height, w: refined.width, x: 0, y: 0}, OTHER_CROP_HEIGHT / refined.height), turn)], {turns: false});

						fingerprintMs += again.timings.fingerprint;
						matchMs += again.timings.match;

						if (again.groups[0] && again.groups[0].score <= matched.groups[0].score + 3) {
							card = refined;
							won = {how: `${how}, its edges found again`, quad: won.quad};
						}
					}
				}
			}

			// A weak match: the crop is likely off (an edge worked out from
			// a wrong side, or a side taken at the border's inner line), so
			// the box moved up and down and resized (rectify.js variants) is
			// fingerprinted too, and the closest kept.
			const best = matched.groups[0] ? matched.groups[0].score : Infinity;
			let chosen = matched;
			let chosenHow = how;

			if ((rectified.variants || []).length && best > SURE_DISTANCE) {
				const shifted = rectified.variants.map((v) => turnImage(rectified.variant(v, OTHER_CROP_HEIGHT), turn));
				const again = matchCrops(index, shifted, {turns: false});
				const score = again.groups[0] ? again.groups[0].score : Infinity;

				variantsTried = rectified.variants.map((v) => v.how);
				fingerprintMs += again.timings.fingerprint;
				matchMs += again.timings.match;

				if (score < best) {
					chosen = again;
					chosenHow = rectified.variants[again.crop].how;
					card = rectified.variant(rectified.variants[again.crop]);

					const variant = rectified.variants[again.crop];

					won = {how: chosenHow, quad: variant.corners || rectQuad(source, variant.rect, rectified.angle || 0)};
				}
			}

			if (turn) {
				card = turnImage(card, turn);
				won = {how: `${won.how}, ${TURN_WORDS[turn]}`, quad: won.quad ? won.quad.map((_, i) => won.quad[(i + turn) % 4]) : null};
				chosenHow = chosenHow ? `${chosenHow}, ${TURN_WORDS[turn]}` : TURN_WORDS[turn];
			}

			picture = compactPicture(chosen, {how: chosenHow, turn, variants: variantsTried, before: chosen === matched ? null : best});
		}
		catch {
			// No index on this phone yet: the card is read in full.
			picture = null;
		}
	}

	// What the scan report's capture images draw (js/scan/image.js
	// captureImages): the capture, the box the edges made with the edge
	// worked out, the crop that won, the guide, and the regions read. Kept
	// in memory only, for the last few scans (js/scan/view.js).
	const trace = {
		capture: straight ? null : source,
		card,
		foundTop: rectified.foundTop ?? null,
		guessed: rectified.guessed || null,
		guide: guideRect,
		main: mainQuad,
		mainRect: rectified.rect || null,
		picture: picture && picture.groups && picture.groups[0] ? {distance: picture.groups[0].score, gap: picture.gap ?? null} : null,
		regions: picture ? ['label'] : [],
		won,
	};

	return {
		angle: rectified.angle ?? 0,
		artwork: null,
		card,
		found: rectified.found,
		trace,
		guessed: rectified.guessed || null,
		needsText: !picture || needsText(picture),
		note: rectified.note || null,
		ocr: false,
		picture,
		ratio: rectified.ratio ?? null,
		read: null,
		timings: {artwork: null, fingerprint: fingerprintMs, match: matchMs, ocr: null, rectify: rectifyMs, total: Math.round(performance.now() - started), workers: null},
	};
}

// The text half: the number (and what else chooses inside the picture's
// group) for an answer whose picture could not settle the card, or the whole
// card read for one with no picture match. readOptions go to read.js.
async function readText(seen, {readOptions = {}} = {}) {
	if (!seen.needsText) {
		return seen;
	}

	const started = performance.now();
	const {card, picture} = seen;
	let read = null;
	let workers = null;
	let ocrMs = null;
	let artwork = null;
	let artworkMs = null;

	let engine = null;

	try {
		engine = await warmEngine();
	}
	catch (err) {
		// Without the reader, a picture match still stands on its own.
		if (!picture) {
			throw err;
		}
	}

	if (engine) {
		// The first group holds several prints (reprints, a Japanese print
		// and its English twin): the set code box and the label row can
		// choose between them, so they are read beside the number.
		const several = Boolean(picture && picture.groups[0] && picture.groups[0].cards.length > 1);

		// With a picture match, only what chooses between its cards: the
		// number, from the strip the candidates' era prints it on (read.js
		// readNumber); otherwise the label row is read behind the tray.
		// A full-art card's number is cut out by the white ring round its
		// digits and read first (read.js ringedNumbers); a picture that is not
		// clear has its name strip read too when no number reads, for the
		// name route.
		read = picture
			? await readNumberOnly(card, engine.ocr, {...readOptions, fullArt: fullArtPicture(picture), label: several, name: !pictureVerdict(picture).clear, prefer: numberSide(picture), setCode: several})
			: await readCard(card, engine.ocr, readOptions);
		read.script = null;
		workers = engine.size;
		ocrMs = read.timings.ocr;

		const artAt = performance.now();

		artwork = artVector(card);
		artworkMs = Math.round(performance.now() - artAt);
	}

	return {
		...seen,
		artwork,
		needsText: false,
		ocr: Boolean(read),
		read,
		trace: {...seen.trace, regions: read ? Object.keys(read.raw || {}) : seen.trace.regions},
		timings: {...seen.timings, artwork: artworkMs, ocr: ocrMs, total: seen.timings.total + Math.round(performance.now() - started), workers},
	};
}

// How a card lay when matchCrops turned it upright, for the scan report.
const TURN_WORDS = {1: 'turned upright from its side (top at the right)', 2: 'turned upright from upside down', 3: 'turned upright from its side (top at the left)'};

// The crops for the cards found in the whole frame (identify's `quads`):
// each as found, and a card lying on its side turned the other way too.
function quadCrops(quads) {
	const out = [];

	(quads || []).forEach((quad, index) => {
		const name = index ? `another outline found in the frame (${index + 1})` : 'the card found in the frame';

		out.push({corners: quad.corners, how: name, ratio: quad.ratio ?? null});

		if (quad.upright === false) {
			const [a, b, c, d] = quad.corners;

			out.push({corners: [c, d, a, b], how: `${name}, turned over`, ratio: quad.ratio ?? null});
		}
	});

	return out;
}

// The card in a quad of the capture, its edges found again (rectify.js) on
// the quad cut with a margin of 8 % round it; null when they are not found
// or make no card's shape.
function refineQuad(image, corners) {
	const cx = corners.reduce((sum, c) => sum + c.x, 0) / 4;
	const cy = corners.reduce((sum, c) => sum + c.y, 0) / 4;
	const wide = corners.map((c) => ({x: cx + (c.x - cx) * 1.08, y: cy + (c.y - cy) * 1.08}));
	const margin = cutQuad(image, wide, Math.min(CARD_MAX_HEIGHT, Math.hypot(wide[3].x - wide[0].x, wide[3].y - wide[0].y)) * 1.08);
	const again = rectify(margin);

	return again.found && typeof again.ratio === 'number' && Math.abs(again.ratio / CARD_RATIO - 1) < 0.05 ? again.card : null;
}

// A quad of the capture cut out straight, card-shaped, `height` pixels
// tall (by default its own height, at most CARD_MAX_HEIGHT).
function cutQuad(image, corners, height) {
	const [tl, tr, br, bl] = corners;
	const own = Math.max(Math.hypot(bl.x - tl.x, bl.y - tl.y), Math.hypot(br.x - tr.x, br.y - tr.y));
	const tall = Math.max(8, Math.round(height || Math.min(CARD_MAX_HEIGHT, own)));

	return warpQuad(image, corners, Math.round(tall * CARD_RATIO), tall);
}

// The label row alone (read.js readLabel) of a straightened card, for the
// language of a card the picture settled with no text read. Starts the
// engine if it is not running; runs outside the one-card-at-a-time queue
// (a few small reads that share the pool's workers), so the next capture is
// never held up by it. Returns {code, confidence, text, ms}.
export async function readLanguageLabel(card) {
	const engine = await warmEngine();
	const started = performance.now();
	const {readLabel} = await import('./read.js');
	const label = await readLabel(card, engine.ocr);

	return {...label, ms: Math.round(performance.now() - started)};
}

// read.js, imported with the engine: it is only needed when text is read.
async function readCard(card, ocr, options) {
	const {readCard: read} = await import('./read.js');

	return read(card, ocr, options);
}

async function readNumberOnly(card, ocr, options) {
	const {readNumber} = await import('./read.js');

	return readNumber(card, ocr, options);
}

// Sets whose cards print the collector number at the bottom right: XY and
// everything before it (TCGdex ids: xy, g1, bw, dp, pl, hgss, col, the ex
// series, e-Card, Neo, Gym, base, and their promos). Sun & Moon and later
// print it at the bottom left.
const RIGHT_SIDE_SETS = /^(xy|g1|bw|dp|pl|hgss|col|ex|ecard|neo|gym|base|lc|si|pop|np|ru|wp|basep|bwp|dpp|hgssp|xyp|XY|BW|DP|PCG|ADV|L\d|LL|LP)/;

// Whether a picture match's card is full art (the index flags it,
// js/vision/pack.js): the first group's first card is, or at least half of
// the top five groups' first cards are.
export function fullArtPicture(picture) {
	const firsts = ((picture && picture.groups) || []).slice(0, 5).map((group) => group.cards[0]).filter(Boolean);

	return Boolean(firsts.length && (firsts[0].full || firsts.filter((card) => card.full).length * 2 >= firsts.length));
}

// Which number strip to read first for a picture match's top cards: 'right'
// when most of them are from XY or before, else 'left'.
export function numberSide(picture) {
	const cards = ((picture && picture.groups) || []).slice(0, 5).flatMap((group) => group.cards.slice(0, 2));
	const right = cards.filter((card) => RIGHT_SIDE_SETS.test(card.id)).length;

	return right * 2 > cards.length ? 'right' : 'left';
}
