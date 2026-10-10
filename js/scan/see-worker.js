// The picture half of a read (identify.js identifyPicture: straighten the
// card, fingerprint its crops, match them against the index) in a worker
// (Eric, 2026-10-09, version 36), so the scanner's frame loop keeps running
// while a card is matched: on his phone a match took 0.3 to 1.5 s of the
// main thread, long enough to miss the next card dropped under a holder.
// identify.js identifyPictureAway talks to it, and does the work on the
// main thread instead when a worker cannot start.
//
// Messages in: {warm: true} loads the index; {id, image, options} matches
// a capture. Out: {warm: true, ok} once the index is in; {id, result} with
// identifyPicture's answer, its trace's capture left out when it is the
// image sent (the page has it); or {id, error}.

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

	const {id, image, options} = data || {};

	try {
		const result = await identifyPicture(image, options);
		const sameCapture = result.trace && result.trace.capture === image;
		const trace = result.trace ? {...result.trace, capture: sameCapture ? null : result.trace.capture, card: null} : null;

		self.postMessage({id, result: {...result, trace}, sameCapture});
	}
	catch (err) {
		self.postMessage({error: String(err && err.message ? err.message : err), id});
	}
});
