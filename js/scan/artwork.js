// The artwork tiebreak: when text leaves two or more cards level, the
// captured card's artwork window is compared with each candidate's catalog
// image (low.webp, kept by the service worker's image cache).
//
// The method is the one the twins research measured on Japanese and
// English twin sets: the artwork window (8 to 92 % across, 11 to 52 % down)
// as a 32 x 20 grey image, its mean taken off and its length made 1, and
// the dot product of two such vectors as their similarity. The same art
// scored 0.98 to 0.998 against its twin; different art, -0.2 to 0.4. It is
// coarse on purpose: 32 x 20 averages away screen moire, focus blur, and
// JPEG blocks, and it is cheap enough to run over six candidates.
//
// It only orders cards the text left level (evidence.js orderByArtwork);
// it never decides a match alone.

export const ART = {h: 0.41, w: 0.84, x: 0.08, y: 0.11};
export const ART_W = 32;
export const ART_H = 20;

// The artwork vector of an ImageData-shaped card image (RGBA, the card
// edge to edge), by area averaging.
export function artVector(img) {
	const x0 = img.width * ART.x;
	const y0 = img.height * ART.y;
	const cw = (img.width * ART.w) / ART_W;
	const ch = (img.height * ART.h) / ART_H;
	const out = new Float32Array(ART_W * ART_H);

	for (let v = 0; v < ART_H; v++) {
		const ya = Math.floor(y0 + v * ch);
		const yb = Math.max(ya + 1, Math.floor(y0 + (v + 1) * ch));

		for (let u = 0; u < ART_W; u++) {
			const xa = Math.floor(x0 + u * cw);
			const xb = Math.max(xa + 1, Math.floor(x0 + (u + 1) * cw));
			let sum = 0;
			let n = 0;

			for (let y = ya; y < yb; y += 1) {
				for (let x = xa; x < xb; x += 1) {
					const i = (y * img.width + x) * 4;

					sum += img.data[i] * 0.299 + img.data[i + 1] * 0.587 + img.data[i + 2] * 0.114;
					n++;
				}
			}

			out[v * ART_W + u] = n ? sum / n : 0;
		}
	}

	return normalise(out);
}

function normalise(vector) {
	let mean = 0;

	for (const value of vector) {
		mean += value;
	}

	mean /= vector.length;

	let length = 0;

	for (let i = 0; i < vector.length; i++) {
		vector[i] -= mean;
		length += vector[i] * vector[i];
	}

	length = Math.sqrt(length);

	if (length) {
		for (let i = 0; i < vector.length; i++) {
			vector[i] /= length;
		}
	}

	return vector;
}

export function similarity(a, b) {
	let sum = 0;

	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		sum += a[i] * b[i];
	}

	return sum;
}

// English card images send the CORS header the canvas needs; most
// Portuguese and French ones send it twice, which fails (sw.js). The
// international cards share their artwork, so the English image stands in.
export const comparableImage = (image) => (image ? String(image).replace(/^(https:\/\/assets\.tcgdex\.net\/)(pt|fr|de|it|es)\//, '$1en/') : null);

const vectors = new Map();

// The artwork vector of a catalog image base URL, from its low.webp. Kept
// for the visit. Null when it cannot be read (offline and not kept, or no
// CORS).
export function imageVector(base, {fetchImpl = (url) => fetch(url, {credentials: 'omit', mode: 'cors'})} = {}) {
	const url = comparableImage(base);

	if (!url) {
		return Promise.resolve(null);
	}

	if (!vectors.has(url)) {
		vectors.set(url, (async () => {
			const response = await fetchImpl(`${url}/low.webp`);

			if (!response.ok) {
				throw new Error(`Image ${response.status}`);
			}

			const bitmap = await createImageBitmap(await response.blob());
			const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(bitmap.width, bitmap.height) : Object.assign(document.createElement('canvas'), {height: bitmap.height, width: bitmap.width});
			const ctx = canvas.getContext('2d', {willReadFrequently: true});

			ctx.drawImage(bitmap, 0, 0);
			bitmap.close && bitmap.close();

			return artVector(ctx.getImageData(0, 0, canvas.width, canvas.height));
		})().catch(() => {
			vectors.delete(url);

			return null;
		}));
	}

	return vectors.get(url);
}

// Map card id -> similarity for the candidates whose image could be read,
// waiting at most timeoutMs for the images.
export async function artworkSims(vector, cards, {timeoutMs = 1500} = {}) {
	const sims = new Map();

	if (!vector) {
		return sims;
	}

	const timeout = new Promise((resolve) => setTimeout(resolve, timeoutMs));

	await Promise.race([
		Promise.all(cards.map(async (card) => {
			const other = await imageVector(card.image);

			if (other) {
				sims.set(card.id, similarity(vector, other));
			}
		})),
		timeout,
	]);

	return sims;
}
