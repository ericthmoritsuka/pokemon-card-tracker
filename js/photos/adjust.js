// Adjusting a photo's light and colour (DESIGN.md section 5, "Adjust a
// photo"; Eric, 2026-10-31): Auto, a levels stretch for a dark or flat
// photo, and four sliders, Brightness, Contrast, Saturation, and Warmth.
// Pure functions over RGBA pixels ({data, width, height}, as ImageData), so
// Node tests them (tests/photo-adjust.test.mjs) and no browser filter is
// needed (ctx.filter is missing on some Safari versions).
//
// Settings: {auto, brightness, contrast, saturation, warmth}. Each slider
// runs from -100 to 100 and is the identity at 0. auto is null, or the
// levels Auto chose for one photo, {lo, hi, gamma}, so the same levels
// apply to its detail copy. Settings are applied to the pixels on Save and
// never kept.

export const SLIDERS = ['brightness', 'contrast', 'saturation', 'warmth'];

export const SLIDER_MIN = -100;
export const SLIDER_MAX = 100;

// Auto lets at most this share of each colour channel go to pure black, and
// at most this share go to pure white.
export const AUTO_CLIP = 0.005;

// Auto never multiplies the range by more than this, so a nearly flat photo
// is not stretched into noise.
const MAX_GAIN = 4;

// After the stretch, Auto lifts the midtones of a photo still darker than
// this median brightness (0 to 1) towards it, with a gamma of at least
// MIN_GAMMA. It never darkens.
const TARGET_MEDIAN = 0.45;
const MIN_GAMMA = 0.55;

// How far the sliders go at 100: brightness is a gamma of 2 to the power
// -1 to 1, contrast doubles (or halves at -100) the distance from mid grey,
// saturation doubles (or removes) colour, and warmth scales red and blue by
// up to 15 percent in opposite directions, like a white balance.
const WARMTH_GAIN = 0.15;

export const neutralSettings = () => ({auto: null, brightness: 0, contrast: 0, saturation: 0, warmth: 0});

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

const slider = (value) => {
	const n = Number(value);

	return Number.isFinite(n) ? Math.max(SLIDER_MIN, Math.min(SLIDER_MAX, n)) : 0;
};

// True when the settings change nothing.
export function isNeutral(settings) {
	return !settings || (!settings.auto && SLIDERS.every((key) => !slider(settings[key])));
}

// The levels for Auto from a photo's pixels, or null when the photo is
// flat (a single colour) and there is nothing to stretch.
//
// For each of red, green, and blue, the darkest and lightest values once
// `clip` of the pixels are set aside at each end; then one stretch for all
// three, from the darkest of the three to the lightest, so colours keep
// their hue and every channel clips at most `clip` at each end. The gamma
// lifts a photo that is still dark after the stretch.
export function autoLevels(image, {clip = AUTO_CLIP} = {}) {
	const {data} = image;
	const pixels = Math.floor(data.length / 4);

	if (!pixels) {
		return null;
	}

	const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];

	for (let i = 0; i < data.length; i += 4) {
		hist[0][data[i]]++;
		hist[1][data[i + 1]]++;
		hist[2][data[i + 2]]++;
	}

	const allowed = Math.max(0, clip) * pixels;
	let lo = 255;
	let hi = 0;

	for (const counts of hist) {
		// The lowest value with at most `allowed` pixels below it, and the
		// highest with at most `allowed` above it.
		let low = 0;
		let below = 0;

		while (low < 255 && below + counts[low] <= allowed) {
			below += counts[low];
			low++;
		}

		let high = 255;
		let above = 0;

		while (high > 0 && above + counts[high] <= allowed) {
			above += counts[high];
			high--;
		}

		lo = Math.min(lo, low);
		hi = Math.max(hi, high);
	}

	if (hi <= lo) {
		return null;
	}

	// Widen a narrow range around its middle, so the gain stays at most
	// MAX_GAIN. Widening only clips less.
	const minRange = Math.ceil(256 / MAX_GAIN);

	if (hi - lo + 1 < minRange) {
		const mid = (lo + hi) / 2;

		lo = Math.max(0, Math.round(mid - minRange / 2));
		hi = Math.min(255, lo + minRange - 1);
		lo = Math.max(0, hi - minRange + 1);
	}

	// The median brightness after the stretch.
	const luma = new Uint32Array(256);

	for (let i = 0; i < data.length; i += 4) {
		luma[(data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8]++;
	}

	let seen = 0;
	let median = 0;

	while (median < 255 && seen + luma[median] < pixels / 2) {
		seen += luma[median];
		median++;
	}

	const stretched = stretch(median, lo, hi);
	let gamma = 1;

	if (stretched > 0 && stretched < TARGET_MEDIAN) {
		gamma = Math.max(MIN_GAMMA, Math.min(1, Math.log(TARGET_MEDIAN) / Math.log(stretched)));
	}

	return {gamma: Math.round(gamma * 1000) / 1000, hi, lo};
}

// A value 0 to 255 through Auto's stretch, as 0 to 1. Values below lo go to
// 0 and above hi to 1; lo and hi themselves land one step inside, so only
// the pixels set aside clip.
function stretch(value, lo, hi) {
	return clamp01((value - lo + 1) / (hi - lo + 2));
}

// The three lookup tables (red, green, blue) for everything but saturation.
export function lookupTables(settings) {
	const s = settings || {};
	const auto = s.auto && s.auto.hi > s.auto.lo ? s.auto : null;
	const autoGamma = auto && auto.gamma > 0 ? auto.gamma : 1;
	const brightness = Math.pow(2, -slider(s.brightness) / 100);
	const c = slider(s.contrast);
	const contrast = c >= 0 ? 1 + c / 100 : 1 + c / 200;
	const warmth = slider(s.warmth) / 100 * WARMTH_GAIN;
	const gains = [1 + warmth, 1, 1 - warmth];
	const tables = gains.map(() => new Uint8ClampedArray(256));

	for (let v = 0; v < 256; v++) {
		let x = v / 255;

		if (auto) {
			x = Math.pow(stretch(v, auto.lo, auto.hi), autoGamma);
		}

		if (brightness !== 1) {
			x = Math.pow(x, brightness);
		}

		if (contrast !== 1) {
			x = clamp01((x - 0.5) * contrast + 0.5);
		}

		for (let channel = 0; channel < 3; channel++) {
			tables[channel][v] = Math.round(clamp01(x * gains[channel]) * 255);
		}
	}

	return tables;
}

// The adjusted pixels of `image`, as {data, width, height}, written into
// `out` (a Uint8ClampedArray of the same length) when given, so a preview
// redrawn on every drag frame allocates nothing. Alpha is kept.
export function applyAdjust(image, settings, out = null) {
	const {data, height, width} = image;
	const target = out && out.length === data.length ? out : new Uint8ClampedArray(data.length);
	const [red, green, blue] = lookupTables(settings);
	const saturation = 1 + slider(settings && settings.saturation) / 100;

	for (let i = 0; i < data.length; i += 4) {
		let r = red[data[i]];
		let g = green[data[i + 1]];
		let b = blue[data[i + 2]];

		if (saturation !== 1) {
			const l = (r * 77 + g * 150 + b * 29) / 256;

			r = l + (r - l) * saturation;
			g = l + (g - l) * saturation;
			b = l + (b - l) * saturation;
		}

		// A Uint8ClampedArray rounds and clamps.
		target[i] = r;
		target[i + 1] = g;
		target[i + 2] = b;
		target[i + 3] = data[i + 3];
	}

	return {data: target, height, width};
}
