// Re-crops of a straightened card, the ways a bad crop goes wrong: moved,
// zoomed, a strip of the card underneath taken with it, turned, blurred.
// Used by crops.mjs to measure how much each costs the picture match.
// Images are ImageData-shaped ({data, width, height}, RGBA).

// The box's floor colour, round a crop moved past its edge.
const FILL = [214, 220, 232];

// out(x, y) -> source (x, y), bilinear, FILL outside.
export function resample(img, w, h, map) {
	const out = new Uint8ClampedArray(w * h * 4);
	const {data, height: H, width: W} = img;

	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const [sx, sy] = map(x + 0.5, y + 0.5);
			const o = (y * w + x) * 4;
			const fx = sx - 0.5;
			const fy = sy - 0.5;

			if (fx < 0 || fy < 0 || fx > W - 1 || fy > H - 1) {
				out[o] = FILL[0];
				out[o + 1] = FILL[1];
				out[o + 2] = FILL[2];
				out[o + 3] = 255;
				continue;
			}

			const x0 = Math.floor(fx);
			const y0 = Math.floor(fy);
			const x1 = Math.min(W - 1, x0 + 1);
			const y1 = Math.min(H - 1, y0 + 1);
			const ax = fx - x0;
			const ay = fy - y0;

			for (let c = 0; c < 3; c++) {
				const a = data[(y0 * W + x0) * 4 + c];
				const b = data[(y0 * W + x1) * 4 + c];
				const d = data[(y1 * W + x0) * 4 + c];
				const e = data[(y1 * W + x1) * 4 + c];

				out[o + c] = (a * (1 - ax) + b * ax) * (1 - ay) + (d * (1 - ax) + e * ax) * ay;
			}

			out[o + 3] = 255;
		}
	}

	return {data: out, height: h, width: w};
}

export const moved = (img, dx, dy) => resample(img, img.width, img.height, (x, y) => [x + dx * img.width, y + dy * img.height]);

export const zoomed = (img, z) => resample(img, img.width, img.height, (x, y) => [img.width / 2 + (x - img.width / 2) / z, img.height / 2 + (y - img.height / 2) / z]);

export function turned(img, degrees) {
	const a = (degrees * Math.PI) / 180;
	const cx = img.width / 2;
	const cy = img.height / 2;

	return resample(img, img.width, img.height, (x, y) => [cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a), cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a)]);
}

// The card pressed into the top of the crop and the top strip of another
// card filling the rest (`share` of the height): the outline of the new card
// and the card under it taken as one, then snapped to a card's shape.
export function composite(img, other, top, share) {
	const upper = resample(img, img.width, top, (x, y) => [x, (y / top) * img.height]);
	const lower = resample(other, img.width, img.height - top, (x, y) => [(x / img.width) * other.width, (y / (img.height - top)) * other.height * share]);
	const data = new Uint8ClampedArray(img.width * img.height * 4);

	data.set(upper.data, 0);
	data.set(lower.data, upper.data.length);

	return {data, height: img.height, width: img.width};
}

// A vertical motion blur `px` long.
export function smeared(img, px) {
	const {data, height: H, width: W} = img;
	const out = new Uint8ClampedArray(data.length);
	const r = Math.max(1, Math.round(px / 2));

	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			let s0 = 0;
			let s1 = 0;
			let s2 = 0;
			let n = 0;

			for (let k = -r; k <= r; k++) {
				const yy = Math.min(H - 1, Math.max(0, y + k));
				const i = (yy * W + x) * 4;

				s0 += data[i];
				s1 += data[i + 1];
				s2 += data[i + 2];
				n++;
			}

			const o = (y * W + x) * 4;

			out[o] = s0 / n;
			out[o + 1] = s1 / n;
			out[o + 2] = s2 / n;
			out[o + 3] = 255;
		}
	}

	return {data: out, height: H, width: W};
}

export const VARIANTS = [
	{make: (img) => img, name: 'as kept'},
	{make: (img) => moved(img, 0.06, 0), name: 'moved right 6%'},
	{make: (img) => moved(img, -0.06, 0), name: 'moved left 6%'},
	{make: (img) => moved(img, 0, 0.06), name: 'moved down 6%'},
	{make: (img) => moved(img, 0, -0.06), name: 'moved up 6%'},
	{make: (img) => moved(img, 0, 0.1), name: 'moved down 10%'},
	{make: (img) => zoomed(img, 0.9), name: 'smaller 10%'},
	{make: (img) => zoomed(img, 1.1), name: 'larger 10%'},
	{make: (img, other) => composite(img, other, Math.round(img.height * 0.88), 0.12), name: 'pile strip 12%'},
	{make: (img, other) => composite(img, other, Math.round(img.height * 0.8), 0.2), name: 'pile strip 20%'},
	{make: (img) => turned(img, 3), name: 'turned 3 deg'},
	{make: (img) => smeared(img, 9), name: 'motion blur 9 px'},
];
