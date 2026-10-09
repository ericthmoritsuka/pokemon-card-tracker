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
import {compactPicture, loadFingerprints, matchCrops, needsText, SURE_DISTANCE} from './picture.js';
import {CARD_MAX_HEIGHT, cropImage, rectify, rectQuad, warpCrop, warpQuad} from './rectify.js';
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
export function identify(image, {guide = null, photo = false, quads = [], straight = false, readOptions = {}, pictureFirst = true} = {}) {
	const run = queue.then(async () => {
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
							const again = matchCrops(index, [warpCrop(refined, 0, {h: refined.height, w: refined.width, x: 0, y: 0}, OTHER_CROP_HEIGHT / refined.height)]);

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
					const shifted = rectified.variants.map((v) => rectified.variant(v, OTHER_CROP_HEIGHT));
					const again = matchCrops(index, shifted);
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

				picture = compactPicture(chosen, {how: chosenHow, variants: variantsTried, before: chosen === matched ? null : best});
			}
			catch {
				// No index on this phone yet: the card is read in full.
				picture = null;
			}
		}

		let read = null;
		let workers = null;
		let ocrMs = null;
		let artwork = null;
		let artworkMs = null;

		if (!picture || needsText(picture)) {
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
				// With a picture match, only what chooses between its cards: the
				// number, from the strip the candidates' era prints it on (read.js
				// readNumber); the label row is read behind the tray.
				read = picture
					? await readNumberOnly(card, engine.ocr, {...readOptions, prefer: numberSide(picture), setCode: Boolean(picture.groups[0] && picture.groups[0].cards.length > 1)})
					: await readCard(card, engine.ocr, readOptions);
				read.script = null;
				workers = engine.size;
				ocrMs = read.timings.ocr;

				const artAt = performance.now();

				artwork = artVector(card);
				artworkMs = Math.round(performance.now() - artAt);
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
			regions: read ? Object.keys(read.raw || {}) : picture ? ['label'] : [],
			won,
		};

		return {
			angle: rectified.angle ?? 0,
			artwork,
			card,
			found: rectified.found,
			trace,
			guessed: rectified.guessed || null,
			note: rectified.note || null,
			ocr: Boolean(read),
			picture,
			ratio: rectified.ratio ?? null,
			read,
			timings: {artwork: artworkMs, fingerprint: fingerprintMs, match: matchMs, ocr: ocrMs, rectify: rectifyMs, total: Math.round(performance.now() - started), workers},
		};
	});

	queue = run.catch(() => {});

	return run;
}

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

// Which number strip to read first for a picture match's top cards: 'right'
// when most of them are from XY or before, else 'left'.
export function numberSide(picture) {
	const cards = ((picture && picture.groups) || []).slice(0, 5).flatMap((group) => group.cards.slice(0, 2));
	const right = cards.filter((card) => RIGHT_SIDE_SETS.test(card.id)).length;

	return right * 2 > cards.length ? 'right' : 'left';
}
