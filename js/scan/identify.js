// Reading a capture: straighten the card (js/scan/rectify.js), read every
// clue on it at once (js/scan/read.js: name, HP, collector number, total,
// set code, language label, copyright line) with the on-device OCR pool
// (js/scan/ocr.js, Tesseract.js from lab/vendor/tesseract, never a CDN),
// and take the artwork's fingerprint for the tiebreak (js/scan/artwork.js).
//
// The engine is started as soon as the Scan screen opens and kept while the
// scanner is open; it is let go a minute after the scanner closes, because
// each Tesseract worker holds tens of megabytes a phone may want back.
//
// Script detection: the English model reads no Japanese, Korean, or Chinese,
// and no light method that tells kana from Hangul ships with the app (no
// jpn or kor model is vendored), so a card whose Latin label row reads
// nothing is reported as "non-latin" and its sheet asks for the language
// with nothing preselected. The read never borrows the last card's
// language.

import {artVector} from './artwork.js';
import {createPool} from './ocr.js';
import {readCard} from './read.js';
import {rectify} from './rectify.js';

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
		enginePromise = createPool({
			logger: (message) => {
				if (progressListener && message && message.status && typeof message.progress === 'number' && message.progress < 1) {
					progressListener(`${message.status}, ${Math.round(message.progress * 100)}%`);
				}
			},
		}).catch((err) => {
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
// straightened card when `straight` is true). Returns {artwork, card, found,
// read, timings: {rectify, ocr, total}}. card is the straightened card
// image; artwork its artwork vector.
export function identify(image, {straight = false, readOptions = {}} = {}) {
	const run = queue.then(async () => {
		const engine = await warmEngine();
		const started = performance.now();
		const rectified = straight ? {card: image, found: true} : rectify(image);
		const rectifyMs = Math.round(performance.now() - started);
		const read = await readCard(rectified.card, engine.ocr, readOptions);

		read.script = null;

		return {
			artwork: artVector(rectified.card),
			card: rectified.card,
			found: rectified.found,
			read,
			timings: {ocr: read.timings.ocr, rectify: rectifyMs, total: Math.round(performance.now() - started), workers: engine.size},
		};
	});

	queue = run.catch(() => {});

	return run;
}
