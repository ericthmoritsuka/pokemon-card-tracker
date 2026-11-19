// The binder page read off the main thread (js/scan/page.js readPagePhoto):
// one photo per worker, which page.js lets go once it answers.
//
// In: {bitmap, fine, maxSide}, the photo decoded and turned upright, and
// fine, a larger copy each pocket's own card is cut from, or null. Out:
// {result}, readPagePixels' answer, each pocket's pixels transferred, not
// copied; or {error}.

import {photoPixels, readPagePixels} from './page.js';

self.addEventListener('message', async ({data}) => {
	try {
		const pixels = photoPixels(data.bitmap, data.maxSide);

		data.bitmap.close();

		const result = await readPagePixels(pixels, {fine: data.fine || null});

		if (data.fine) {
			data.fine.close();
		}

		self.postMessage({result}, result.pockets.flatMap((pocket) => [pocket.image, pocket.card]).filter(Boolean).map((image) => image.data.buffer));
	}
	catch (err) {
		self.postMessage({error: String(err && err.message ? err.message : err)});
	}
});
