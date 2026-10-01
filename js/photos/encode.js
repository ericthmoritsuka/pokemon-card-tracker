// Reading a picked or captured photo into pixels, and encoding the
// straightened card for saving. Browser only (canvas).

import {PHOTO_HEIGHT, PHOTO_WIDTH, fitWithin, quadSize, scaleCorners, sourceScaleFor, warp} from './geometry.js';

// A phone photo is kept at most this many pixels on its long side while the
// corners are placed: enough for a sharp 600 x 840 crop of a card that fills
// a third of the frame, and about 17 MB of pixels rather than 50.
export const SOURCE_SIDE = 2400;

// About 80 KB per photo (DESIGN.md section 5): the free 1 GB holds over
// 10,000 of them.
export const TARGET_BYTES = 80 * 1024;

// The detail copy (DESIGN.md section 5, "Inspection viewer"): the same card
// at up to 1440 x 2016, 2.4 times the normal copy, for zooming in on print
// details. The bucket takes at most 512 KB per file (supabase/photos.sql),
// so it is encoded to at most DETAIL_MAX_BYTES, aiming near
// DETAIL_TARGET_BYTES.
export const DETAIL_WIDTH = 1440;
export const DETAIL_HEIGHT = 2016;
export const DETAIL_TARGET_BYTES = 450 * 1024;
export const DETAIL_MAX_BYTES = 500 * 1024;
export const BUCKET_LIMIT_BYTES = 512 * 1024;

// With detail copies on, a picked photo is kept at up to this many pixels
// on its long side (a 12 MP phone photo whole), so the card in it can hold
// more than the normal copy's 840 pixels.
export const DETAIL_SOURCE_SIDE = 4096;

// A detail copy is made only when the card in the photo is at least this
// many times the normal copy's height: below it, it would only enlarge the
// same pixels.
export const DETAIL_MIN_GAIN = 1.25;

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
// orientation), into a canvas of at most maxSide pixels.
export async function decodeImageFile(file, maxSide = SOURCE_SIDE) {
	if (typeof createImageBitmap === 'function') {
		try {
			const bitmap = await createImageBitmap(file, {imageOrientation: 'from-image'});
			const canvas = drawScaled(bitmap, bitmap.width, bitmap.height, maxSide);

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

		return drawScaled(img, img.naturalWidth, img.naturalHeight, maxSide);
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

// The detail copy's size for a card whose corners are `corners` in the
// source: as tall as the card is there, in the normal copy's 5:7 shape, at
// most DETAIL_WIDTH x DETAIL_HEIGHT. Null when the card is too small in the
// photo for a detail copy to show more than the normal one.
export function detailSize(corners) {
	const {height} = quadSize(corners);

	if (!(height >= PHOTO_HEIGHT * DETAIL_MIN_GAIN)) {
		return null;
	}

	const step = PHOTO_HEIGHT / 120;
	const h = Math.min(DETAIL_HEIGHT, Math.floor(height / step) * step);

	return {height: h, width: Math.round(h * PHOTO_WIDTH / PHOTO_HEIGHT)};
}

// Encodes at most `max` bytes: from `quality`, stepping down by `step` to
// `minQuality`, then shrinking the size by `shrink` and starting again, up
// to `shrinks` times. encode(quality, width, height) resolves with a Blob
// (or anything with a size). Resolves with {blob, height, quality, width},
// or throws when even the smallest try is too big. Kept apart from the
// canvas so Node tests the sizing (tests/photos-viewer.test.mjs).
export async function fitEncoding(encode, {
	height,
	max = DETAIL_MAX_BYTES,
	minQuality = 0.5,
	quality = 0.85,
	shrink = 0.85,
	shrinks = 3,
	step = 0.07,
	width,
}) {
	let w = width;
	let h = height;

	for (let round = 0; round <= shrinks; round++) {
		let q = quality;
		let blob = await encode(q, w, h);

		while (blob && blob.size > max && q - step >= minQuality - 1e-9) {
			q = Math.round((q - step) * 100) / 100;
			blob = await encode(q, w, h);
		}

		if (blob && blob.size <= max) {
			return {blob, height: h, quality: q, width: w};
		}

		w = Math.round(w * shrink);
		h = Math.round(h * shrink);
	}

	throw new Error('The detail copy could not be made small enough to upload.');
}

// Encodes a straightened detail canvas as WebP (JPEG where the browser
// cannot make WebP) of at most DETAIL_MAX_BYTES. Returns {blob, height,
// quality, type, width}.
export async function encodeDetail(canvas, {max = DETAIL_MAX_BYTES} = {}) {
	const probe = await toBlob(canvas, 'image/webp', 0.5);
	const type = probe && probe.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
	const sized = new Map([[`${canvas.width}x${canvas.height}`, canvas]]);

	const encode = (quality, width, height) => {
		const key = `${width}x${height}`;

		if (!sized.has(key)) {
			sized.set(key, drawScaled(canvas, canvas.width, canvas.height, Math.max(width, height)));
		}

		return toBlob(sized.get(key), type, quality);
	};

	const result = await fitEncoding(encode, {height: canvas.height, max, quality: type === 'image/webp' ? 0.85 : 0.88, width: canvas.width});

	return {...result, type};
}
