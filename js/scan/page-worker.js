// The binder page read off the main thread (js/scan/page.js readPagePhoto):
// one photo per worker, which page.js lets go once it answers.
//
// In: {bitmap, maxSide}, the photo decoded and turned upright. Out:
// {result}, readPagePixels' answer, each pocket's pixels transferred, not
// copied; or {error}.

import {photoPixels, readPagePixels} from './page.js';

self.addEventListener('message', async ({data}) => {
	try {
		const pixels = photoPixels(data.bitmap, data.maxSide);

		data.bitmap.close();

		const result = await readPagePixels(pixels);

		self.postMessage({result}, result.pockets.filter((pocket) => pocket.image).map((pocket) => pocket.image.data.buffer));
	}
	catch (err) {
		self.postMessage({error: String(err && err.message ? err.message : err)});
	}
});
