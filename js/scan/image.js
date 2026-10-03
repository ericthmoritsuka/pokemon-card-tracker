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

// The image in a Blob as ImageData, scaled down to at most maxSide pixels
// on its longer side.
export async function blobImage(blob, {maxSide = Infinity} = {}) {
	const bitmap = await createImageBitmap(blob);
	const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
	const canvas = document.createElement('canvas');

	canvas.width = Math.max(1, Math.round(bitmap.width * scale));
	canvas.height = Math.max(1, Math.round(bitmap.height * scale));

	const ctx = canvas.getContext('2d', {willReadFrequently: true});

	ctx.imageSmoothingQuality = 'high';
	ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	bitmap.close && bitmap.close();

	return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

// ------------------------------------------------------------ capture images

// The scan report's "Save capture image" (js/scan/sheets.js): two PNGs Eric
// can send for a capture that went wrong, drawn from the trace identify()
// returns (js/scan/identify.js) and nothing stored. The first is the
// straightened card at its working size with the edges found (solid), the
// edge worked out (dashed), the crop that won, and the regions read; the
// second is the whole capture with the box the edges made, the crop that
// won, and the guide.
const EDGE = '#22c55e';
const GUESS = '#f97316';
const WON = '#d946ef';
const READ = '#38bdf8';
const GUIDE = '#ffffff';
const CAPTION_LINE = 18;

// A capture time as a file name part: 20261003-142305.
export function captureStamp(at = new Date()) {
	const d = at instanceof Date ? at : new Date(at);
	const two = (n) => String(n).padStart(2, '0');

	return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

// The lines under the card image: which crop won, which edge was worked
// out, and how the picture matched.
export function captureCaption(trace) {
	const lines = [`Crop that won: ${(trace.won && trace.won.how) || 'the frame as it is'}`];

	lines.push(trace.guessed ? `Edge worked out (dashed): ${trace.guessed}` : trace.main ? 'Every edge found' : 'No card edges found');

	if (trace.picture) {
		lines.push(`Picture: distance ${trace.picture.distance}${trace.picture.gap === null || trace.picture.gap === undefined ? '' : `, lead ${trace.picture.gap}`}; read: ${trace.regions.join(', ') || 'nothing'}`);
	}
	else {
		lines.push(`Read: ${trace.regions.join(', ') || 'nothing'}`);
	}

	return lines;
}

function line(ctx, a, b, colour, dashed = false) {
	ctx.strokeStyle = colour;
	ctx.setLineDash(dashed ? [10, 7] : []);
	ctx.beginPath();
	ctx.moveTo(a.x, a.y);
	ctx.lineTo(b.x, b.y);
	ctx.stroke();
}

// The four sides of a quad (top, right, bottom, left), the guessed one
// dashed.
function quadSides(ctx, quad, colour, guessed = null, scale = 1) {
	const p = quad.map((point) => ({x: point.x * scale, y: point.y * scale}));
	const sides = {bottom: [p[2], p[3]], left: [p[3], p[0]], right: [p[1], p[2]], top: [p[0], p[1]]};

	for (const [name, [a, b]] of Object.entries(sides)) {
		line(ctx, a, b, name === guessed ? GUESS : colour, name === guessed);
	}
}

function caption(ctx, lines, y, width) {
	ctx.setLineDash([]);
	ctx.fillStyle = '#111827';
	ctx.fillRect(0, y, width, lines.length * CAPTION_LINE + 8);
	ctx.fillStyle = '#f9fafb';
	ctx.font = '13px system-ui, sans-serif';
	ctx.textBaseline = 'top';
	lines.forEach((text, i) => ctx.fillText(text, 6, y + 4 + i * CAPTION_LINE, width - 12));
}

// The straightened card with what was found and read drawn on. regions:
// read.js REGIONS (fractions of the card), passed in so this module stays
// light.
export function cardCanvas(trace, regions = {}) {
	const card = trace.card;
	const lines = captureCaption(trace);
	const canvas = toCanvas(card);
	const out = document.createElement('canvas');

	out.width = card.width;
	out.height = card.height + lines.length * CAPTION_LINE + 8;

	const ctx = out.getContext('2d');

	ctx.drawImage(canvas, 0, 0);
	ctx.lineWidth = Math.max(2, Math.round(card.width / 200));

	const box = [{x: 1, y: 1}, {x: card.width - 1, y: 1}, {x: card.width - 1, y: card.height - 1}, {x: 1, y: card.height - 1}];
	const fromEdges = !trace.won || trace.won.quad === trace.main;

	if (fromEdges && trace.main) {
		quadSides(ctx, box, EDGE, trace.guessed);

		// The top edge found but not used: where it was on this card.
		if (trace.guessed === 'top' && trace.foundTop !== null && trace.mainRect) {
			const y = ((trace.foundTop - trace.mainRect.y) * card.height) / trace.mainRect.h;

			if (y > 0 && y < card.height) {
				line(ctx, {x: 0, y}, {x: card.width, y}, EDGE, true);
			}
		}
	}
	else {
		quadSides(ctx, box, WON);
	}

	ctx.lineWidth = Math.max(1, Math.round(card.width / 400));

	for (const name of trace.regions || []) {
		const region = regions[name];

		if (!region) {
			continue;
		}

		ctx.setLineDash([]);
		ctx.strokeStyle = READ;
		ctx.strokeRect(region.x * card.width, region.y * card.height, region.w * card.width, region.h * card.height);
		ctx.fillStyle = READ;
		ctx.font = '11px system-ui, sans-serif';
		ctx.textBaseline = 'bottom';
		ctx.fillText(name, region.x * card.width + 2, region.y * card.height);
	}

	caption(ctx, lines, card.height, card.width);

	return out;
}

// The whole capture (at most maxSide pixels on its longer side) with the
// box the edges made, the edge worked out dashed, the crop that won, and
// the guide.
export function wholeCanvas(trace, {maxSide = 1600} = {}) {
	const image = trace.capture;
	const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
	const out = toCanvas(image, image.height * scale);
	const ctx = out.getContext('2d');

	ctx.lineWidth = Math.max(2, Math.round(out.width / 300));

	if (trace.guide) {
		ctx.strokeStyle = GUIDE;
		ctx.setLineDash([4, 6]);
		ctx.strokeRect(trace.guide.x * scale, trace.guide.y * scale, trace.guide.w * scale, trace.guide.h * scale);
	}

	if (trace.main) {
		quadSides(ctx, trace.main, EDGE, trace.guessed, scale);
	}

	if (trace.won && trace.won.quad && trace.won.quad !== trace.main) {
		quadSides(ctx, trace.won.quad, WON, null, scale);
	}

	return out;
}

const pngOf = (canvas) => new Promise((resolve, reject) => {
	canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The image could not be made.'))), 'image/png');
});

// Hands a Blob to the browser as a download (no network: works offline).
export function downloadBlob(blob, name) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');

	a.href = url;
	a.download = name;
	a.style.display = 'none';
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Both images as downloads: scan-capture-<time>.png (the card) and
// scan-capture-<time>-whole.png (the capture, when there was one). Returns
// the file names.
export async function saveCaptureImages(trace, {at = new Date(), regions = {}} = {}) {
	const stamp = captureStamp(at);
	const names = [];
	const card = await pngOf(cardCanvas(trace, regions));

	names.push(`scan-capture-${stamp}.png`);
	downloadBlob(card, names[0]);

	if (trace.capture) {
		const whole = await pngOf(wholeCanvas(trace));

		names.push(`scan-capture-${stamp}-whole.png`);
		downloadBlob(whole, names[1]);
	}

	return names;
}
