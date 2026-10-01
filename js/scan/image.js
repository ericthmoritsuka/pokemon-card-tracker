// Turning ImageData into stored photos and back.

function toCanvas(image, maxHeight = Infinity) {
	const scale = Math.min(1, maxHeight / image.height);
	const source = document.createElement('canvas');

	source.width = image.width;
	source.height = image.height;
	source.getContext('2d').putImageData(new ImageData(image.data, image.width, image.height), 0, 0);

	if (scale === 1) {
		return source;
	}

	const canvas = document.createElement('canvas');

	canvas.width = Math.max(1, Math.round(image.width * scale));
	canvas.height = Math.max(1, Math.round(image.height * scale));

	const ctx = canvas.getContext('2d');

	ctx.imageSmoothingQuality = 'high';
	ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

	return canvas;
}

// A JPEG of the image, at most maxHeight pixels tall.
export function imageBlob(image, {maxHeight = Infinity, quality = 0.85} = {}) {
	const canvas = toCanvas(image, maxHeight);

	return new Promise((resolve, reject) => {
		canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The photo could not be saved.'))), 'image/jpeg', quality);
	});
}

export async function blobImage(blob) {
	const bitmap = await createImageBitmap(blob);
	const canvas = document.createElement('canvas');

	canvas.width = bitmap.width;
	canvas.height = bitmap.height;

	const ctx = canvas.getContext('2d', {willReadFrequently: true});

	ctx.drawImage(bitmap, 0, 0);
	bitmap.close && bitmap.close();

	return ctx.getImageData(0, 0, canvas.width, canvas.height);
}
