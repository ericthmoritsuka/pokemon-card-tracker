// The picture half of a read (identify.js identifyPicture: straighten the
// card, fingerprint its crops, match them against the index) in a worker
// (Eric, 2026-10-09, version 36), so the scanner's frame loop keeps running
// while a card is matched: on his phone a match took 0.3 to 1.5 s of the
// main thread, long enough to miss the next card dropped under a holder.
// identify.js identifyPictureAway talks to it, and does the work on the
// main thread instead when a worker cannot start.
//
// Messages in: {warm: true} loads the index; {id, image, options} matches
// a capture, image being ImageData-shaped pixels or {bitmap, crop, width,
// height}, a capture the page took without reading its pixels (camera.js
// grabBitmap: the camera's VideoFrame and the area to cut from it, or an
// ImageBitmap of the area; on Eric's phone reading them took 380 to 550 ms
// of the main thread), drawn here on an OffscreenCanvas. Out: {warm: true, ok} once
// the index is in; for a bitmap, {id, decoded: true} once its pixels are
// read (the page then lets go of its spare copy); with full set, {id, full} with the capture
// as a JPEG (quality 0.92, null when it could not be made), for the draft
// tray; {id, result} with identifyPicture's answer, its trace's capture
// left out when it is the image sent (the page has it); or {id, error}. A
// bitmap's pixels go back with the answer or the error as capture,
// transferred, not copied, as does the straightened card's.

import {identifyPicture} from './identify.js';
import {loadFingerprints} from './picture.js';

self.addEventListener('message', async ({data}) => {
	if (data && data.warm) {
		try {
			await loadFingerprints();
			self.postMessage({ok: true, warm: true});
		}
		catch {
			self.postMessage({ok: false, warm: true});
		}

		return;
	}

	const {full = false, id, options} = data || {};
	let image = data ? data.image : null;
	let decoded = false;

	try {
		if (image && image.bitmap) {
			const canvas = new OffscreenCanvas(image.width, image.height);
			const ctx = canvas.getContext('2d', {willReadFrequently: true});

			const {bitmap, crop} = image;

			if (crop) {
				ctx.drawImage(bitmap, crop.x, crop.y, crop.w, crop.h, 0, 0, image.width, image.height);
			}
			else {
				ctx.drawImage(bitmap, 0, 0);
			}

			bitmap.close();
			image = ctx.getImageData(0, 0, image.width, image.height);
			decoded = true;
			// The page keeps a spare of the bitmap until this, in case the
			// worker dies first (identify.js fallback).
			self.postMessage({decoded: true, id});

			if (full) {
				canvas.convertToBlob({quality: 0.92, type: 'image/jpeg'})
					.then((blob) => self.postMessage({full: blob, id}), () => self.postMessage({full: null, id}));
			}
		}

		const result = await identifyPicture(image, options);
		const sameCapture = result.trace && result.trace.capture === image;
		const trace = result.trace ? {...result.trace, capture: sameCapture ? null : result.trace.capture, card: null} : null;
		const moved = [];

		if (decoded) {
			moved.push(image.data.buffer);
		}

		if (result.card && result.card !== image && result.card.data && result.card.data.buffer !== image.data.buffer && result.card.data.byteOffset === 0) {
			moved.push(result.card.data.buffer);
		}

		self.postMessage({capture: decoded ? image : undefined, id, result: {...result, trace}, sameCapture}, moved);
	}
	catch (err) {
		self.postMessage({capture: decoded ? image : undefined, error: String(err && err.message ? err.message : err), id}, decoded ? [image.data.buffer] : []);
	}
});
