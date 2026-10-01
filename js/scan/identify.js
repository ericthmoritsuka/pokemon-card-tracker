// Reading a capture: straighten the card (lab/js/rectify.js), read the
// collector number, total, language label, and copyright line
// (lab/js/pipeline.js) with the on-device OCR engine (lab/js/ocr.js,
// Tesseract.js from lab/vendor/tesseract, never a CDN).
//
// The engine is started once and kept while the scanner is open; it is let
// go a minute after the scanner closes, because a Tesseract worker holds
// tens of megabytes a phone may want back.
//
// Script detection: the English model reads no Japanese, Korean, or Chinese,
// and no light method that tells kana from Hangul ships with the app (no
// jpn or kor model is vendored), so a card whose Latin label row reads
// nothing is reported as "non-latin" and its sheet asks for the language
// with nothing preselected. The read never borrows the last card's
// language.

import {createEngine} from '../../lab/js/ocr.js';
import {readCard} from '../../lab/js/pipeline.js';
import {rectify} from '../../lab/js/rectify.js';

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
		enginePromise = createEngine({
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

// One read at a time: the engine is one worker, and a phone has the memory
// for one full-resolution card at a time.
let queue = Promise.resolve();

// Reads an ImageData-shaped capture (the guide frame plus its margin, or a
// straightened card when `straight` is true). Returns {card, read, timings:
// {rectify, ocr, total}, found}. card is the straightened card image.
export function identify(image, {straight = false} = {}) {
	const run = queue.then(async () => {
		const engine = await warmEngine();
		const started = performance.now();
		const rectified = straight ? {card: image, found: true} : rectify(image);
		const rectifyMs = Math.round(performance.now() - started);
		const read = await readCard(rectified.card, engine.ocr);

		read.script = null;

		return {
			card: rectified.card,
			found: rectified.found,
			read,
			timings: {ocr: read.timings.ocr, rectify: rectifyMs, total: Math.round(performance.now() - started)},
		};
	});

	queue = run.catch(() => {});

	return run;
}
