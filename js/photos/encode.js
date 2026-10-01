// Reading a picked or captured photo into pixels, and encoding the
// straightened card for saving. Browser only (canvas).

import {PHOTO_HEIGHT, PHOTO_WIDTH, fitWithin, scaleCorners, sourceScaleFor, warp} from './geometry.js';

// A phone photo is kept at most this many pixels on its long side while the
// corners are placed: enough for a sharp 600 x 840 crop of a card that fills
// a third of the frame, and about 17 MB of pixels rather than 50.
export const SOURCE_SIDE = 2400;

// About 80 KB per photo (DESIGN.md section 5): the free 1 GB holds over
// 10,000 of them.
export const TARGET_BYTES = 80 * 1024;

export function canvasOf(width, height) {
	const canvas = document.createElement('canvas');

	canvas.width = width;
	canvas.height = height;

	return canvas;
}

const context = (canvas) => canvas.getContext('2d', {willReadFrequently: true});

// Draws a decoded image (bitmap, img, video, canvas) of width x height into
// a canvas of at most maxSide on its long side.
export function drawScaled(source, width, height, maxSide = SOURCE_SIDE) {
	const size = fitWithin(width, height, maxSide);
	const canvas = canvasOf(size.width, size.height);
	const ctx = context(canvas);

	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = 'high';
	ctx.drawImage(source, 0, 0, size.width, size.height);

	return canvas;
}

// Decodes a File or Blob, turned the way the camera held it (EXIF
// orientation), into a canvas of at most SOURCE_SIDE pixels.
export async function decodeImageFile(file) {
	if (typeof createImageBitmap === 'function') {
		try {
			const bitmap = await createImageBitmap(file, {imageOrientation: 'from-image'});
			const canvas = drawScaled(bitmap, bitmap.width, bitmap.height);

			bitmap.close();

			return canvas;
		}
		catch {
			// Older browsers reject the options bag; the img path below decodes.
		}
	}

	const url = URL.createObjectURL(file);

	try {
		const img = new Image();

		img.decoding = 'async';
		img.src = url;
		await img.decode();

		return drawScaled(img, img.naturalWidth, img.naturalHeight);
	}
	catch {
		throw new Error('That file could not be opened as an image. Try a JPEG, PNG, or WebP photo.');
	}
	finally {
		URL.revokeObjectURL(url);
	}
}

export const pixelsOf = (canvas) => context(canvas).getImageData(0, 0, canvas.width, canvas.height);

export function putPixels(canvas, image) {
	if (canvas.width !== image.width || canvas.height !== image.height) {
		canvas.width = image.width;
		canvas.height = image.height;
	}

	const data = image instanceof ImageData ? image : new ImageData(image.data, image.width, image.height);

	context(canvas).putImageData(data, 0, 0);
}

// The straightened card at full size from the source canvas and its
// corners. The source is first shrunk with the browser's own filtering so the
// card in it is about the output's size: bilinear reads from a card four
// times larger would skip pixels.
export function straighten(sourceCanvas, corners, width = PHOTO_WIDTH, height = PHOTO_HEIGHT) {
	const scale = sourceScaleFor(corners, height);
	let canvas = sourceCanvas;

	if (scale < 1) {
		canvas = drawScaled(sourceCanvas, sourceCanvas.width, sourceCanvas.height, Math.max(sourceCanvas.width, sourceCanvas.height) * scale);
	}

	const actual = canvas.width / sourceCanvas.width;
	const out = canvasOf(width, height);

	putPixels(out, warp(pixelsOf(canvas), scaleCorners(corners, actual), width, height));

	return out;
}

const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

// Encodes the card as WebP around TARGET_BYTES, stepping the quality down
// while it is well over. A browser that cannot encode WebP (it hands back a
// PNG instead) gets JPEG. Returns {blob, quality, type}.
export async function encodePhoto(canvas, {target = TARGET_BYTES} = {}) {
	let type = 'image/webp';
	let quality = 0.8;
	let blob = await toBlob(canvas, type, quality);

	if (!blob || blob.type !== 'image/webp') {
		type = 'image/jpeg';
		quality = 0.82;
		blob = await toBlob(canvas, type, quality);
	}

	while (blob && blob.size > target * 1.3 && quality > 0.5) {
		quality = Math.round((quality - 0.08) * 100) / 100;
		blob = await toBlob(canvas, type, quality);
	}

	if (!blob) {
		throw new Error('This browser could not encode the photo.');
	}

	return {blob, quality, type};
}
