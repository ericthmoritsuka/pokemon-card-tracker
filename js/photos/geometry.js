// Corner math and the perspective warp for the owner's card photos
// (DESIGN.md section 5, "Own photos, cropped to the card").
//
// Pure functions over plain {x, y} points and ImageData-shaped objects
// ({data, width, height}), with no DOM, so Node tests them
// (tests/photos.test.mjs). A quad is always four corners in the order
// top-left, top-right, bottom-right, bottom-left of the card as it will be
// shown, in the photo's pixel coordinates.

// The saved photo: 63:88 card shape, about 600 x 840 (DESIGN.md section 5).
export const PHOTO_WIDTH = 600;
export const PHOTO_HEIGHT = 840;
export const CARD_ASPECT = 63 / 88;

const point = (x, y) => ({x, y});

export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Solves the 3 x 3 homography H (H[8] = 1) that maps each from[i] onto
// to[i]. Returns null when the points are degenerate (three in a line).
export function solveHomography(from, to) {
	const rows = [];

	for (let i = 0; i < 4; i++) {
		const {x, y} = from[i];
		const {x: u, y: v} = to[i];

		rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
		rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
	}

	// Gaussian elimination with partial pivoting on the 8 x 9 system.
	for (let col = 0; col < 8; col++) {
		let pivot = col;

		for (let row = col + 1; row < 8; row++) {
			if (Math.abs(rows[row][col]) > Math.abs(rows[pivot][col])) {
				pivot = row;
			}
		}

		if (Math.abs(rows[pivot][col]) < 1e-12) {
			return null;
		}

		[rows[col], rows[pivot]] = [rows[pivot], rows[col]];

		for (let row = 0; row < 8; row++) {
			if (row === col) {
				continue;
			}

			const factor = rows[row][col] / rows[col][col];

			if (factor !== 0) {
				for (let k = col; k < 9; k++) {
					rows[row][k] -= factor * rows[col][k];
				}
			}
		}
	}

	const h = new Float64Array(9);

	for (let i = 0; i < 8; i++) {
		h[i] = rows[i][8] / rows[i][i];
	}

	h[8] = 1;

	return h;
}

export function applyHomography(h, x, y) {
	const w = h[6] * x + h[7] * y + h[8];

	return point((h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w);
}

// Signed area by the shoelace formula; positive when the corners run
// clockwise on screen (y grows downward).
export function signedArea(quad) {
	let sum = 0;

	for (let i = 0; i < quad.length; i++) {
		const a = quad[i];
		const b = quad[(i + 1) % quad.length];

		sum += a.x * b.y - b.x * a.y;
	}

	return sum / 2;
}

export const quadArea = (quad) => Math.abs(signedArea(quad));

// True when the four corners make a convex quad running clockwise, which is
// what a card seen through a camera always is.
export function isConvexQuad(quad) {
	if (!quad || quad.length !== 4) {
		return false;
	}

	for (let i = 0; i < 4; i++) {
		const a = quad[i];
		const b = quad[(i + 1) % 4];
		const c = quad[(i + 2) % 4];
		const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);

		if (cross <= 0) {
			return false;
		}
	}

	return true;
}

// Any four points as top-left, top-right, bottom-right, bottom-left: the
// corner nearest each direction of the two diagonals. Null when two
// directions pick the same point.
export function orderCorners(points) {
	const by = (score) => points.reduce((best, p) => (score(p) < score(best) ? p : best));
	const quad = [
		by((p) => p.x + p.y),
		by((p) => -(p.x - p.y)),
		by((p) => -(p.x + p.y)),
		by((p) => p.x - p.y),
	];

	return new Set(quad).size === 4 ? quad.map((p) => point(p.x, p.y)) : null;
}

// The card's width and height as seen: the mean of opposite sides.
export function quadSize([tl, tr, br, bl]) {
	return {
		height: (distance(tl, bl) + distance(tr, br)) / 2,
		width: (distance(tl, tr) + distance(bl, br)) / 2,
	};
}

// Turns which corner counts as top-left by a quarter turn per step, so the
// saved image turns 90 degrees clockwise per step (a card photographed lying
// sideways).
export function rotateCorners(quad, steps = 1) {
	const n = ((steps % 4) + 4) % 4;

	return quad.map((_, i) => ({...quad[(i - n + 4) % 4]}));
}

// A card lying sideways in the photo gives a landscape quad. Reorders it so
// the long sides are left and right; of the two portrait orders, the one
// whose top edge sits higher in the photo.
export function portraitCorners(quad) {
	const {height, width} = quadSize(quad);

	if (width <= height) {
		return quad.map((p) => ({...p}));
	}

	const cw = rotateCorners(quad, 1);
	const ccw = rotateCorners(quad, 3);
	const topY = (q) => (q[0].y + q[1].y) / 2;

	return topY(cw) <= topY(ccw) ? cw : ccw;
}

export const scaleCorners = (quad, scale) => quad.map((p) => point(p.x * scale, p.y * scale));

export const clampPoint = (p, width, height) => point(
	Math.min(width, Math.max(0, p.x)),
	Math.min(height, Math.max(0, p.y))
);

export const clampCorners = (quad, width, height) => quad.map((p) => clampPoint(p, width, height));

// Where to put the handles when no card was found: a card-shaped box, 80
// percent of the largest that fits, in the middle of the photo.
export function defaultCorners(width, height) {
	let h = height * 0.8;
	let w = h * CARD_ASPECT;

	if (w > width * 0.8) {
		w = width * 0.8;
		h = w / CARD_ASPECT;
	}

	const x = (width - w) / 2;
	const y = (height - h) / 2;

	return [point(x, y), point(x + w, y), point(x + w, y + h), point(x, y + h)];
}

// lab/js/rectify.js finds the card by turning the photo back by `angle`
// degrees about its centre and cropping to `rect` in the turned image. This
// gives the four corners of that crop in the photo as taken. rectify turns
// the photo with rotate(img, -angle), whose output pixel p reads the source
// at c + R(angle)(p - c).
export function cornersFromRect(rect, angle, width, height) {
	const radians = ((angle || 0) * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const cx = width / 2;
	const cy = height / 2;
	const back = ({x, y}) => point(cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos);

	return [
		point(rect.x, rect.y),
		point(rect.x + rect.w, rect.y),
		point(rect.x + rect.w, rect.y + rect.h),
		point(rect.x, rect.y + rect.h),
	].map(back);
}

// The homography from the output rectangle (width x height) onto the quad in
// the source, so each output pixel knows where to read.
export function outputToSource(quad, width, height) {
	return solveHomography(
		[point(0, 0), point(width, 0), point(width, height), point(0, height)],
		quad
	);
}

// Straightens the card inside `quad` into a width x height image, reading
// the source bilinearly at each output pixel's centre. Pixels that map
// outside the source take the nearest edge pixel. Returns an
// ImageData-shaped object; `out` (a Uint8ClampedArray of the right length)
// is reused when given, so a live preview allocates nothing per frame.
export function warp(src, quad, width = PHOTO_WIDTH, height = PHOTO_HEIGHT, out = null) {
	const h = outputToSource(quad, width, height);
	const data = out && out.length === width * height * 4 ? out : new Uint8ClampedArray(width * height * 4);

	if (!h) {
		return {data, height, width};
	}

	const sw = src.width;
	const sh = src.height;
	const sd = src.data;
	const maxX = sw - 1;
	const maxY = sh - 1;

	for (let y = 0; y < height; y++) {
		const v = y + 0.5;

		for (let x = 0; x < width; x++) {
			const u = x + 0.5;
			const w = h[6] * u + h[7] * v + h[8];
			let sx = (h[0] * u + h[1] * v + h[2]) / w - 0.5;
			let sy = (h[3] * u + h[4] * v + h[5]) / w - 0.5;

			sx = sx < 0 ? 0 : sx > maxX ? maxX : sx;
			sy = sy < 0 ? 0 : sy > maxY ? maxY : sy;

			const x0 = sx | 0;
			const y0 = sy | 0;
			const x1 = x0 < maxX ? x0 + 1 : x0;
			const y1 = y0 < maxY ? y0 + 1 : y0;
			const fx = sx - x0;
			const fy = sy - y0;
			const i00 = (y0 * sw + x0) * 4;
			const i10 = (y0 * sw + x1) * 4;
			const i01 = (y1 * sw + x0) * 4;
			const i11 = (y1 * sw + x1) * 4;
			const o = (y * width + x) * 4;

			for (let c = 0; c < 3; c++) {
				const top = sd[i00 + c] + (sd[i10 + c] - sd[i00 + c]) * fx;
				const bottom = sd[i01 + c] + (sd[i11 + c] - sd[i01 + c]) * fx;

				data[o + c] = top + (bottom - top) * fy;
			}

			data[o + 3] = 255;
		}
	}

	return {data, height, width};
}

// How much to shrink the source before warping so the card in it is no more
// than `margin` times the output's height: bilinear sampling from a much
// larger card skips pixels and shimmers.
export function sourceScaleFor(quad, outHeight = PHOTO_HEIGHT, margin = 1.25) {
	const {height} = quadSize(quad);

	return height > outHeight * margin ? (outHeight * margin) / height : 1;
}

// The size of an image scaled to fit inside max x max, never enlarged.
export function fitWithin(width, height, max) {
	const scale = Math.min(1, max / Math.max(width, height));

	return {height: Math.max(1, Math.round(height * scale)), scale, width: Math.max(1, Math.round(width * scale))};
}
