// Reading a straightened card: every clue at once. The lab pipeline
// (js/vision/pipeline.js, measured on the lab benchmark) read the label row,
// then the left number strip, then the right one, one OCR call after the
// other, and only the bottom of the card. This reader cuts all its regions
// first and hands them to the OCR pool together (js/scan/ocr.js, one or two
// workers), so the name strip and the HP are read alongside the number,
// total, label, and copyright line, and a second worker halves the wait.
//
// The crops, line finding, and parsers are the lab's. What is new here:
//
// - the name strip (top left) and the HP (top right) regions;
// - a crop shrunk to its OCR size is averaged down (box filter) rather than
//   point-sampled, which is what turns a photo of a screen into moire;
// - an optional mild blur before the name strip is read, for the same
//   reason, and an optional flat-field pass that divides out a glare patch;
// - the attack box, read only when the number did not read, so the name
//   route has one more clue to check its candidates with;
// - follow-up reads (the set code box, the sparse passes) start the moment
//   the read they depend on is done, not after everything else.
//
// Pure apart from the `ocr` function passed in: no DOM, no network.

import {
	copyrightYear,
	cropRows,
	decideLanguage,
	findTextLines,
	REGIONS as LAB_REGIONS,
	mentionsWizards,
	parseLabel,
	parseNumber,
	parseSetCode,
	prepareCrop,
	regionRect,
	scaleFor,
	SET_CODE_PREP,
	setCodeRect,
	SHARPEN,
	TEXT_PX,
} from '../vision/pipeline.js';
import {misreadNumbers, parseHp, parseName, parsePartialNumber} from './evidence.js';

// Regions as fractions of the straightened card, as in js/vision/pipeline.js.
// Measured on TCGdex high.webp scans (600 x 825) of Scarlet & Violet, Sword
// & Shield, Mega Evolution, WotC-era, and Portuguese cards:
//
// - name: the name strip. Modern cards print the stage label and then the
//   name from about 3 % down (the name's capitals are about 2.7 % of the
//   card's height); WotC-era cards print "Evolves from" above it, so the
//   band runs to 13.5 %, and starts at 1.5 % to allow for a top edge found
//   a little low. It stops short of the HP on modern cards; on old ones the
//   HP may fall inside, and the parser drops digits.
// - hp: "HP 70" on modern cards, "80 HP" on WotC-era ones, "PS 160" on
//   Portuguese prints; the digits are about 3.4 % of the height.
// - attacks: the attack and ability names, middle of the card. Read only
//   when the number did not read (see readCard).
export const REGIONS = {
	...LAB_REGIONS,
	attacks: {h: 0.32, text: 0.02, w: 0.9, x: 0.05, y: 0.5},
	hp: {h: 0.095, text: 0.034, w: 0.35, x: 0.58, y: 0.015},
	name: {h: 0.12, text: 0.027, w: 0.66, x: 0.03, y: 0.015},
};

export const OCR_SETTINGS = {
	attacks: {psm: '11', whitelist: ''},
	hp: {psm: '7', whitelist: '0123456789HPSVK '},
	label: {psm: '7', whitelist: ''},
	name: {psm: '7', whitelist: ''},
	numberLine: {psm: '7', whitelist: ''},
	setCode: {psm: '7', whitelist: ''},
	sparse: {psm: '11', whitelist: ''},
};

// ------------------------------------------------------------ image preparation

// Averages `rect` of `img` down by `scale` (< 1): each output pixel is the
// mean of the source pixels it covers. Returns RGBA, ImageData-shaped.
function shrink(img, rect, scale, luma = false) {
	const width = Math.max(1, Math.round(rect.w * scale));
	const height = Math.max(1, Math.round(rect.h * scale));
	const out = new Uint8ClampedArray(width * height * 4);
	const sums = new Float64Array(width * 3);
	const counts = new Uint32Array(width);
	const src = img.data;
	const stride = img.width * 4;

	for (let y = 0; y < height; y++) {
		const y0 = rect.y + Math.floor(y / scale);
		const y1 = Math.min(rect.y + rect.h, Math.max(y0 + 1, rect.y + Math.floor((y + 1) / scale)));

		sums.fill(0);
		counts.fill(0);

		for (let sy = y0; sy < y1; sy++) {
			for (let sx = rect.x; sx < rect.x + rect.w; sx++) {
				const x = Math.min(width - 1, Math.floor((sx - rect.x) * scale));
				const i = sy * stride + sx * 4;

				sums[x * 3] += src[i];
				sums[x * 3 + 1] += src[i + 1];
				sums[x * 3 + 2] += src[i + 2];
				counts[x]++;
			}
		}

		for (let x = 0; x < width; x++) {
			const o = (y * width + x) * 4;
			const n = counts[x] || 1;

			if (luma) {
				out[o] = (sums[x * 3] * 0.299 + sums[x * 3 + 1] * 0.587 + sums[x * 3 + 2] * 0.114) / n;
				out[o + 1] = out[o];
				out[o + 2] = out[o];
			}
			else {
				out[o] = sums[x * 3] / n;
				out[o + 1] = sums[x * 3 + 1] / n;
				out[o + 2] = sums[x * 3 + 2] / n;
			}

			out[o + 3] = 255;
		}
	}

	return {data: out, height, width};
}

// A 3 x 3 box blur of an RGBA image, in place of a copy.
function blur3(img) {
	const {data, height, width} = img;
	const out = new Uint8ClampedArray(data.length);

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			for (let c = 0; c < 3; c++) {
				let sum = 0;
				let n = 0;

				for (let dy = -1; dy <= 1; dy++) {
					const yy = y + dy;

					if (yy < 0 || yy >= height) {
						continue;
					}

					for (let dx = -1; dx <= 1; dx++) {
						const xx = x + dx;

						if (xx >= 0 && xx < width) {
							sum += data[(yy * width + xx) * 4 + c];
							n++;
						}
					}
				}

				out[(y * width + x) * 4 + c] = sum / n;
			}

			out[(y * width + x) * 4 + 3] = 255;
		}
	}

	return {data: out, height, width};
}

// Divides a grey crop by its own blurred background (a box of `radius`) and
// stretches the result, so a bright glare patch and the dark text inside it
// end up like the rest of the strip.
function flatten(crop, radius) {
	const {data, height, width} = crop;
	const grey = new Float32Array(width * height);
	const temp = new Float32Array(width * height);

	for (let i = 0; i < grey.length; i++) {
		grey[i] = data[i * 4];
	}

	// Separable running-sum box blur.
	const box = (from, to, length, count, step, lineStep) => {
		for (let line = 0; line < count; line++) {
			let sum = 0;
			let n = 0;
			const base = line * lineStep;

			for (let i = 0; i < Math.min(radius, length); i++) {
				sum += from[base + i * step];
				n++;
			}

			for (let i = 0; i < length; i++) {
				if (i + radius < length) {
					sum += from[base + (i + radius) * step];
					n++;
				}

				if (i - radius - 1 >= 0) {
					sum -= from[base + (i - radius - 1) * step];
					n--;
				}

				to[base + i * step] = sum / n;
			}
		}
	};

	box(grey, temp, width, height, 1, width);

	const background = new Float32Array(width * height);

	box(temp, background, height, width, width, 1);

	let low = 255;
	let high = 0;
	const ratio = new Float32Array(width * height);

	for (let i = 0; i < grey.length; i++) {
		ratio[i] = Math.min(1.2, grey[i] / Math.max(8, background[i]));
	}

	const sorted = Float32Array.from(ratio).sort();

	low = sorted[Math.floor(sorted.length * 0.02)];
	high = sorted[Math.floor(sorted.length * 0.98)];

	const out = new Uint8ClampedArray(data.length);

	for (let i = 0; i < grey.length; i++) {
		const value = high > low ? ((ratio[i] - low) * 255) / (high - low) : grey[i];

		out[i * 4] = value;
		out[i * 4 + 1] = value;
		out[i * 4 + 2] = value;
		out[i * 4 + 3] = 255;
	}

	return {data: out, height, width};
}

// Light print on a dark ground (the name and number of a full-art card) is
// turned dark on light, the way the OCR reads best: the ground is most of a
// strip, so a strip whose median grey is dark is inverted. Tesseract's own
// second, inverted read of unsure lines is off (js/scan/ocr.js), because it
// doubled the time of every poor capture.
function darkOnLight(crop) {
	const histogram = new Uint32Array(256);
	const pixels = crop.width * crop.height;

	for (let i = 0; i < pixels; i++) {
		histogram[crop.data[i * 4]]++;
	}

	let seen = 0;
	let median = 255;

	for (let v = 0; v < 256; v++) {
		seen += histogram[v];

		if (seen >= pixels / 2) {
			median = v;
			break;
		}
	}

	return median >= 100 ? crop : invertCrop(crop);
}

function invertCrop(crop) {
	const data = new Uint8ClampedArray(crop.data.length);

	for (let i = 0; i < crop.data.length; i += 4) {
		data[i] = 255 - crop.data[i];
		data[i + 1] = data[i];
		data[i + 2] = data[i];
		data[i + 3] = 255;
	}

	return {data, height: crop.height, width: crop.width};
}

// ------------------------------------------------------------ full-art number strips

// A full-art card (special illustration rares, gold and full-art ultra
// rares: the picture index flags them) prints its collector number in dark
// italic digits inside a thick white ring, over the art. Read as a strip,
// the ring, the art around it, and the lines above and below drown the
// digits, and the OCR makes nothing of it (the Portuguese Ampharos,
// me04-090, version 37). So the digits are cut out by their ring instead
// (ringedNumbers):
//
// 1. The strip's whitest channel (the least of red, green, and blue), so
//    coloured art, which the brightest channel makes light, stays dark and
//    only white is white.
// 2. Its whitest 12 % (RING_SHARE) is the ring's candidates; joined
//    pixels make shapes, and the shapes about a text line tall, side by
//    side, make runs at least two text heights long: a number's ring, or
//    the digits' rings one by one.
// 3. In each run, what the ring encloses (the dark not reachable from the
//    run's edge without crossing white) is the digits: dark on white, cut
//    out with a white margin.
//
// Each run is read as one line; the first that gives a number with
// FULL_ART_SURE confidence settles it. Measured on 49 full-art TCGdex scans
// through five simulated captures (lab/bench/fullart.json, run.mjs
// --numbers; DESIGN.md section 6).
export const RING_SHARE = 0.12;

// At most this many runs are read: the number's ring, the illustrator's
// name, the copyright line, and the odd bright shape.
const RING_RUNS = 4;

// The whitest channel of `rect` of a card, scaled and stretched as
// prepareCrop makes the brightest one: prepareCrop of the colours turned
// over, turned back.
function whitestCrop(card, rect, scale) {
	const region = new Uint8ClampedArray(rect.w * rect.h * 4);

	for (let y = 0; y < rect.h; y++) {
		for (let x = 0; x < rect.w; x++) {
			const i = ((rect.y + y) * card.width + rect.x + x) * 4;
			const o = (y * rect.w + x) * 4;

			region[o] = 255 - card.data[i];
			region[o + 1] = 255 - card.data[i + 1];
			region[o + 2] = 255 - card.data[i + 2];
			region[o + 3] = 255;
		}
	}

	return invertCrop(prepareCrop({data: region, height: rect.h, width: rect.w}, {h: rect.h, w: rect.w, x: 0, y: 0}, scale, {sharpen: SHARPEN}));
}

// Labels the joined (8-way) pixels of `mask` (width x height, 1 for set):
// returns {labels (Int32Array, -1 for unset), boxes: [{x0, y0, x1, y1}]}.
function shapesOf(mask, width, height) {
	const labels = new Int32Array(mask.length).fill(-1);
	const boxes = [];
	const stack = [];

	for (let start = 0; start < mask.length; start++) {
		if (!mask[start] || labels[start] >= 0) {
			continue;
		}

		const box = {x0: width, x1: 0, y0: height, y1: 0};

		labels[start] = boxes.length;
		stack.push(start);

		while (stack.length) {
			const i = stack.pop();
			const x = i % width;
			const y = (i - x) / width;

			box.x0 = Math.min(box.x0, x);
			box.x1 = Math.max(box.x1, x + 1);
			box.y0 = Math.min(box.y0, y);
			box.y1 = Math.max(box.y1, y + 1);

			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const xx = x + dx;
					const yy = y + dy;
					const j = yy * width + xx;

					if (xx >= 0 && xx < width && yy >= 0 && yy < height && mask[j] && labels[j] < 0) {
						labels[j] = boxes.length;
						stack.push(j);
					}
				}
			}
		}

		boxes.push(box);
	}

	return {boxes, labels};
}

// The digits of each ringed run of a prepared whitest-channel strip, as
// crops (dark on white, with a margin), at most RING_RUNS, left to right
// within each row of the strip.
export function ringedNumbers(strip, textPx = TEXT_PX) {
	const {height, width} = strip;
	const grey = greyOf(strip);
	const sorted = Uint8ClampedArray.from(grey).sort();
	const cut = sorted[Math.floor(sorted.length * (1 - RING_SHARE))];
	const mask = new Uint8Array(grey.length);

	for (let i = 0; i < grey.length; i++) {
		mask[i] = grey[i] >= cut && grey[i] > 0 ? 1 : 0;
	}

	const {boxes, labels} = shapesOf(mask, width, height);
	const tall = boxes
		.map((box, id) => ({...box, id}))
		.filter((box) => box.y1 - box.y0 >= textPx * 0.7 && box.y1 - box.y0 <= textPx * 1.9 && box.x1 - box.x0 >= textPx * 0.25)
		.sort((a, b) => a.x0 - b.x0);
	const runs = [];
	const used = new Set();

	tall.forEach((box, i) => {
		if (used.has(i)) {
			return;
		}

		const run = {ids: new Set([box.id]), x0: box.x0, x1: box.x1, y0: box.y0, y1: box.y1};
		const middle = (box.y0 + box.y1) / 2;

		for (let j = i + 1; j < tall.length; j++) {
			const next = tall[j];

			if (!used.has(j) && next.x0 - run.x1 < textPx * 0.5 && Math.abs((next.y0 + next.y1) / 2 - middle) < textPx * 0.4) {
				used.add(j);
				run.ids.add(next.id);
				run.x1 = Math.max(run.x1, next.x1);
				run.y0 = Math.min(run.y0, next.y0);
				run.y1 = Math.max(run.y1, next.y1);
			}
		}

		if (run.x1 - run.x0 >= textPx * 2) {
			runs.push(run);
		}
	});

	return runs.slice(0, RING_RUNS).map((run) => ringHoles(labels, width, run));
}

const RING_MARGIN = 12;

// What a run's ring encloses: the pixels of its box that are not the ring
// and cannot reach the box's edge without crossing it (4-way), black on
// white, with a white margin of RING_MARGIN.
function ringHoles(labels, width, {ids, x0, x1, y0, y1}) {
	const w = x1 - x0;
	const h = y1 - y0;
	const ring = new Uint8Array(w * h);
	const outside = new Uint8Array(w * h);
	const stack = [];

	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			ring[y * w + x] = ids.has(labels[(y0 + y) * width + x0 + x]) ? 1 : 0;
		}
	}

	const seed = (i) => {
		if (!ring[i] && !outside[i]) {
			outside[i] = 1;
			stack.push(i);
		}
	};

	for (let x = 0; x < w; x++) {
		seed(x);
		seed((h - 1) * w + x);
	}

	for (let y = 0; y < h; y++) {
		seed(y * w);
		seed(y * w + w - 1);
	}

	while (stack.length) {
		const i = stack.pop();
		const x = i % w;

		if (x > 0) {
			seed(i - 1);
		}

		if (x < w - 1) {
			seed(i + 1);
		}

		if (i >= w) {
			seed(i - w);
		}

		if (i < w * (h - 1)) {
			seed(i + w);
		}
	}

	const outWidth = w + RING_MARGIN * 2;
	const out = new Uint8ClampedArray(outWidth * (h + RING_MARGIN * 2)).fill(255);

	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			if (!ring[y * w + x] && !outside[y * w + x]) {
				out[(y + RING_MARGIN) * outWidth + x + RING_MARGIN] = 0;
			}
		}
	}

	return cropOfGrey(out, outWidth, h + RING_MARGIN * 2);
}

const greyOf = (crop) => {
	const grey = new Uint8ClampedArray(crop.width * crop.height);

	for (let i = 0; i < grey.length; i++) {
		grey[i] = crop.data[i * 4];
	}

	return grey;
};

const cropOfGrey = (grey, width, height) => {
	const data = new Uint8ClampedArray(width * height * 4);

	for (let i = 0; i < grey.length; i++) {
		data[i * 4] = grey[i];
		data[i * 4 + 1] = grey[i];
		data[i * 4 + 2] = grey[i];
		data[i * 4 + 3] = 255;
	}

	return {data, height, width};
};

// prepareCrop (js/vision/pipeline.js), with a crop to be shrunk averaged down
// first, an optional blur, and an optional flat field. With `luma`, grey is
// luminance rather than the brightest channel: the brightest channel turns
// red print (the HP on WotC-era cards) as light as its background.
export function prepareRegion(card, rect, scale, {blur = false, flat = false, luma = false, ...options} = {}) {
	let source = card;
	let area = rect;
	let factor = scale;

	if (scale < 0.85 || blur || luma) {
		source = shrink(card, rect, scale < 0.85 ? scale : 1, luma);
		area = {h: source.height, w: source.width, x: 0, y: 0};
		factor = scale < 0.85 ? 1 : scale;

		if (blur) {
			source = blur3(source);
		}
	}

	const crop = prepareCrop(source, area, factor, options);
	const even = flat ? flatten(crop, Math.max(8, Math.round(TEXT_PX * 1.5))) : crop;

	return options.invert ? even : darkOnLight(even);
}

// ------------------------------------------------------------ parsing

const round = (value) => Math.round(value * 100) / 100;

const linesOf = (result) => (result.lines && result.lines.length
	? result.lines
	: String(result.text || '').split(/\n+/).map((text) => ({text, words: []})));

// A number whose words read with less confidence than this is not a number
// read at all: the OCR made digits out of what covers the strip (a label
// over a card shown on a screen, a thumb, moire), "01/08" at 0.03. Taken as
// a number, it kept the attack box from being read and pulled every card
// numbered 1 level with the right one; left out, the card is read as one
// whose number did not read. On the 240-capture benchmark it changed no
// capture's first card.
export const NUMBER_FLOOR = 0.15;

// The confidence of a number whose slash was misread: enough to look the
// card up by, never enough to make it sure alone.
export const MISREAD_CONFIDENCE = 0.3;

// A full-art strip is read no further ways once a number reads this well
// (session.js NUMBER_SURE, the confidence a number needs to settle a card).
export const FULL_ART_SURE = 0.6;

// The first line of an OCR result that holds a collector number read above
// NUMBER_FLOOR, with the confidence and box of the words that make up the
// number. As in js/vision/pipeline.js, which does not export it.
function findNumber(side, result) {
	for (const line of linesOf(result)) {
		const parsed = parseNumber(line.text);

		if (!parsed) {
			continue;
		}

		const digits = (text) => text.toUpperCase().replace(/[^0-9]/g, '');
		const target = digits(parsed.numberPrinted) + digits(parsed.totalPrinted);
		const slashed = line.words.filter((word) => word.text.includes('/'));
		const words = slashed.length
			? slashed
			: line.words.filter((word) => digits(word.text).length >= 2 && target.includes(digits(word.text)));
		const used = words.length ? words : line.words;
		const confidence = used.length ? Math.min(...used.map((word) => word.confidence)) : result.confidence;
		const box = used.length
			? {
				x0: Math.min(...used.map((word) => word.bbox.x0)),
				x1: Math.max(...used.map((word) => word.bbox.x1)),
				y0: Math.min(...used.map((word) => word.bbox.y0)),
				y1: Math.max(...used.map((word) => word.bbox.y1)),
			}
			: null;
		const plausible = Number(parsed.number.replace(/\D/g, '')) <= Number(parsed.total) * 2;

		if (used.length && confidence / 100 < NUMBER_FLOOR) {
			continue;
		}

		return {
			...parsed,
			box,
			confidence: round((confidence / 100) * (plausible ? 1 : 0.5)),
			langCode: null,
			setCode: null,
			side,
		};
	}

	return null;
}

// Tesseract's word boxes on a one-line read often span the whole line, so
// how tall a word's print is (the name strip's name against its "Evolves
// from" line) is measured from the pixels: the rows inside the word's box
// that hold a dark pixel.
function inkHeights(crop, lines) {
	const {data, height, width} = crop;

	for (const line of lines) {
		for (const word of line.words) {
			const x0 = Math.max(0, Math.round(word.bbox.x0));
			const x1 = Math.min(width, Math.round(word.bbox.x1));
			const y0 = Math.max(0, Math.round(word.bbox.y0));
			const y1 = Math.min(height, Math.round(word.bbox.y1));
			let rows = 0;

			for (let y = y0; y < y1; y++) {
				for (let x = x0; x < x1; x++) {
					if (data[(y * width + x) * 4] < 110) {
						rows++;
						break;
					}
				}
			}

			word.ink = rows;
		}
	}

	return lines;
}

// Line results back in strip coordinates.
const shiftLines = (result, y0) => linesOf(result).map((read) => ({
	text: read.text,
	words: read.words.map((word) => ({...word, bbox: {...word.bbox, y0: word.bbox.y0 + y0, y1: word.bbox.y1 + y0}})),
}));

// ------------------------------------------------------------ the name strip

// Reads the name strip: its two most text-like lines, each as one line;
// again inverted when the read is poor (a name bar half light, half dark),
// keeping the likelier name; then the whole strip sparse when nothing
// name-like came. recognise(key, crop, settings) runs one OCR call; crops
// and raw are filled in under `name`. Returns parseName's {text, suffix,
// confidence}.
async function readName(card, recognise, {blur = true, crops, flat = false, raw, textPx = TEXT_PX}) {
	const crop = prepareRegion(card, regionRect(card, REGIONS.name), scaleFor(card, REGIONS.name, textPx), {blur, flat, sharpen: SHARPEN});
	const readLines = async (image) => {
		const found = findTextLines(image, textPx, 2);
		const results = await Promise.all(found.map((line, index) => {
			crops[`nameLine${index + 1}`] = cropRows(image, line);

			return recognise('name', crops[`nameLine${index + 1}`], OCR_SETTINGS.name).then((result) => shiftLines(result, line.y0));
		}));

		return results.flat();
	};

	crops.name = crop;

	const lines = await readLines(crop);
	let parsed = parseName(inkHeights(crop, lines));

	raw.name = {confidence: 0, lines, text: lines.map((line) => line.text).join('\n')};

	if (!parsed.text || parsed.confidence < 0.45) {
		const other = invertCrop(crop);
		const again = await readLines(other);
		const second = parseName(inkHeights(other, again));

		raw.name = {...raw.name, text: `${raw.name.text}\n${again.map((line) => line.text).join('\n')}`};

		if (second.text && second.confidence > parsed.confidence) {
			parsed = second;
		}
	}

	if (!parsed.text) {
		const sparse = await recognise('name', crop, OCR_SETTINGS.sparse);

		raw.name = {...sparse, text: raw.name.text + '\n' + sparse.text};
		parsed = parseName(inkHeights(crop, [...lines, ...linesOf(sparse)]));
	}

	return parsed;
}

// ------------------------------------------------------------ the label alone

// Reads only the label row (Weakness, Resistance, Retreat, in the card's
// language) of a straightened card, as readCard reads it: its two most
// text-like lines, then the whole band sparse when they name no language.
// For a card the picture settled with no text read, whose language was set
// from the person's last pick: a few small OCR calls, in the background,
// can still correct it (js/scan/view.js). Returns parseLabel's {code,
// confidence, ...} and the text read.
export async function readLabel(card, ocr, {textPx = TEXT_PX} = {}) {
	const rect = regionRect(card, REGIONS.label);
	const band = prepareRegion(card, rect, scaleFor(card, REGIONS.label, textPx), {sharpen: SHARPEN});
	const lines = await Promise.all(findTextLines(band, textPx, 2).map((line) => ocr(cropRows(band, line), OCR_SETTINGS.label)));
	let text = lines.map((result) => result.text || '').join('\n');
	let label = parseLabel(text);

	if (!label.code) {
		const sparse = await ocr(band, OCR_SETTINGS.sparse);

		text = [text, sparse.text].filter(Boolean).join('\n');
		label = parseLabel(text);
	}

	return {...label, text: text.trim().slice(0, 200)};
}

// ------------------------------------------------------------ the whole read

// Reads one straightened card with `ocr`, an async function (image, {psm,
// whitelist}) => {confidence, lines, text}, which may run several calls at
// once.
//
// options: attacks (read the attack box when the number did not read;
// default true), blurName (blur the name strip first, for photos of
// screens), flat (flat-field the strips, for glare), onProgress(fraction)
// as reads come back, textPx, now.
//
// Returns {copyrightYear, crops, hp, label, language, name, number,
// partial, attackText, raw, setCodeBox, timings, wizards}. timings.ocr is
// the time from the first OCR call to the last answer, not their sum.
// numberOnly: read the collector number, total, set code box, and
// language label only (no name, HP, or attacks), for a card the picture
// already narrowed to a few (js/scan/picture.js).
export async function readCard(card, ocr, {attacks = true, blurName = true, flat = false, now = () => performance.now(), numberOnly = false, onProgress = null, textPx = TEXT_PX} = {}) {
	if (numberOnly) {
		attacks = false;
	}

	const crops = {};
	const raw = {};
	const timings = {};
	const started = now();

	let queued = 0;
	let done = 0;

	const recognise = async (key, crop, settings) => {
		const at = now();

		queued++;

		const result = await ocr(crop, settings);

		timings[key] = (timings[key] || 0) + Math.round(now() - at);
		done++;

		if (onProgress) {
			// The first pass is about ten reads; follow-ups add a few more.
			onProgress(Math.min(0.95, done / Math.max(queued, 10)));
		}

		return result;
	};

	const prepare = (key, region, options = {}) => {
		const rect = regionRect(card, REGIONS[region]);
		const scale = scaleFor(card, REGIONS[region], textPx);

		crops[key] = prepareRegion(card, rect, scale, {flat, sharpen: SHARPEN, ...options});

		return crops[key];
	};

	// Reads the `count` most text-like lines of a prepared crop, each as one
	// line, all queued at once. Resolves to the lines in crop coordinates.
	const readLines = async (key, crop, count, settings) => {
		const found = findTextLines(crop, textPx, count);
		const results = await Promise.all(found.map((line, index) => {
			crops[`${key}Line${index + 1}`] = cropRows(crop, line);

			return recognise(key, crops[`${key}Line${index + 1}`], settings).then((result) => shiftLines(result, line.y0));
		}));

		return results.flat();
	};

	const asResult = (lines, confidence = 0) => ({confidence, lines, text: lines.map((line) => line.text).join('\n')});

	// ---- every region at once, the number strips first

	const strips = {
		numberLeft: prepare('numberLeft', 'numberLeft'),
		numberRight: prepare('numberRight', 'numberRight'),
	};

	// The attack box is read as soon as the line reads of both strips have
	// found no number, alongside their sparse second passes rather than
	// after them.
	let attackRead = null;
	let linesMissed = 0;

	const missedNumber = () => {
		linesMissed++;

		if (linesMissed === 2 && attacks) {
			crops.attacks = prepare('attacks', 'attacks', {blur: blurName});
			attackRead = recognise('attacks', crops.attacks, OCR_SETTINGS.attacks).then((result) => {
				raw.attacks = result;

				return result.text;
			});
		}
	};

	const numberTask = (key, count) => readLines(key, strips[key], count, OCR_SETTINGS.numberLine).then(async (lines) => {
		raw[key] = asResult(lines);

		if (!findNumber(key === 'numberLeft' ? 'left' : 'right', raw[key])) {
			missedNumber();

			const sparse = await recognise(key, strips[key], OCR_SETTINGS.sparse);

			raw[key] = {...sparse, lines: [...lines, ...linesOf(sparse)], text: raw[key].text + '\n' + sparse.text};
		}
	});

	const left = numberTask('numberLeft', 3);
	const name = numberOnly ? Promise.resolve(null) : readName(card, recognise, {blur: blurName, crops, flat, raw, textPx});
	const right = numberTask('numberRight', 2);
	// HP: dark digits on most cards, light ones on the dark name bar of V,
	// VMAX, and many ex cards, so a miss is read again inverted.
	const hpCrop = numberOnly ? null : prepare('hp', 'hp', {blur: blurName, luma: true, pad: 8});
	const hpOf = (lines) => {
		const text = lines.map((line) => line.text).join(' ');
		const clean = /^\s*(?:HP|PS|PV|KP)?\s*\d{2,3}\s*(?:HP)?\s*$/i.test(text);

		return parseHp(text, clean ? 0.8 : 0.5);
	};
	const hp = numberOnly ? Promise.resolve(null) : readLines('hp', hpCrop, 1, OCR_SETTINGS.hp).then(async (lines) => {
		raw.hp = asResult(lines);

		let parsed = hpOf(lines);

		if (!parsed) {
			crops.hpInverted = prepare('hpInverted', 'hp', {blur: blurName, invert: true, luma: true, pad: 8});

			const again = await readLines('hp', crops.hpInverted, 1, OCR_SETTINGS.hp);

			raw.hp = {...raw.hp, text: `${raw.hp.text}\n${again.map((line) => line.text).join(' ')}`};
			parsed = hpOf(again);
		}

		return parsed;
	});
	const labelBand = prepare('label', 'label');
	const label = readLines('label', labelBand, 2, OCR_SETTINGS.label).then(async (lines) => {
		raw.label = asResult(lines);

		if (!parseLabel(raw.label.text).code) {
			const sparse = await recognise('label', labelBand, OCR_SETTINGS.sparse);

			raw.label = {...sparse, text: [raw.label.text, sparse.text].filter(Boolean).join('\n')};
		}

		return parseLabel(raw.label.text);
	});

	// ---- what depends on the number strips

	await Promise.all([left, right]);

	const leftNumber = findNumber('left', raw.numberLeft);
	const rightNumber = findNumber('right', raw.numberRight);
	let number = leftNumber || rightNumber;

	if (leftNumber && rightNumber) {
		number = rightNumber.confidence > leftNumber.confidence ? rightNumber : leftNumber;
	}

	// No number read: one whose slash read as another character ("10227084"
	// for 022/084), taken weakly (below what makes a card sure on its own);
	// the picture match picks among the splits (js/scan/picture.js).
	let misreads = [];

	if (!number) {
		for (const side of ['left', 'right']) {
			const list = misreadNumbers(raw[side === 'left' ? 'numberLeft' : 'numberRight'].text);

			if (list.length) {
				misreads = list;
				number = {...list[0], box: null, confidence: MISREAD_CONFIDENCE, langCode: null, regulationMark: null, setCode: null, side};
				break;
			}
		}
	}

	let setCodeBox = {langCode: null, run: '', setCode: null, text: ''};
	const follow = [];

	// A number on the left means a Sun & Moon or later print; from Scarlet &
	// Violet on, those carry the set code box, so read it.
	if (number && number.side === 'left' && number.box) {
		const rect = setCodeRect(card, regionRect(card, REGIONS.numberLeft), number.box, scaleFor(card, REGIONS.numberLeft, textPx));

		crops.setCode = prepareCrop(card, rect, 72 / rect.h, SET_CODE_PREP);
		follow.push(recognise('setCode', crops.setCode, OCR_SETTINGS.setCode).then((result) => {
			raw.setCode = result;
			setCodeBox = parseSetCode(result.text);
			number = {...number, langCode: setCodeBox.langCode, setCode: setCodeBox.setCode, setCodeRun: setCodeBox.run};
		}));
	}

	// No number: the attack names give the name route one more clue.
	let attackText = '';

	if (attackRead) {
		follow.push(attackRead.then((text) => {
			attackText = number ? '' : text;
		}));
	}

	const [nameRead, hpRead, labelRead] = await Promise.all([name, hp, label, ...follow]);

	timings.ocr = Math.round(now() - started);

	const partial = number ? {number: null, total: null} : parsePartialNumber(`${raw.numberLeft.text}\n${raw.numberRight.text}`);

	return {
		attackText,
		copyrightYear: copyrightYear(raw.numberLeft.text, raw.numberRight.text),
		crops,
		hp: hpRead,
		label: labelRead,
		language: decideLanguage(number, labelRead),
		misreads,
		name: nameRead,
		number,
		partial,
		raw,
		setCodeBox,
		timings,
		wizards: mentionsWizards(raw.numberLeft.text, raw.numberRight.text),
	};
}

// ------------------------------------------------------------ the number alone, quickly

// Reading only what chooses between the pictures' top cards (Eric,
// 2026-10-09): a card the picture could not settle took 7 to 14 s on his
// phone, nearly all of it OCR (numberOnly still read both number strips,
// each with a sparse second pass, the label row, and the set code box, about
// ten calls). Here the strip the candidates' era prints its number on is
// read first, and the reading stops as soon as it gives a number: the other
// strip and the sparse passes are read only when it gives none. The label
// row and the set code box are read only when the picture's first group
// holds several cards (reprints, a Japanese print and its English twin),
// where they can choose; otherwise the label is left to the background read
// a card the picture settled gets (js/scan/view.js checkLabelLater).
//
// prefer: 'left' (Sun & Moon and later: the number at the bottom left) or
// 'right' (XY and older); setCode and label: whether to read the set code
// box and the label row (beside the number). Returns readCard's shape, with
// name and hp null, label null when it was not read, and the language from
// the set code box and the label ({code: null} when neither was read).
//
// fullArt: the picture's cards are full art, so the likelier strip's ringed
// digits are read first (ringedNumbers), and its lines only when they give
// no sure number. name: read the name strip when no
// number reads (the picture was not clear either, js/scan/identify.js), for
// the name route (js/scan/picture.js pictureMatch); otherwise name is null.
export async function readNumber(card, ocr, {fullArt = false, label: withLabel = false, name: withName = false, now = () => performance.now(), onProgress = null, prefer = 'left', setCode = false, textPx = TEXT_PX} = {}) {
	const crops = {};
	const raw = {numberLeft: {confidence: 0, lines: [], text: ''}, numberRight: {confidence: 0, lines: [], text: ''}};
	const timings = {};
	const started = now();
	let calls = 0;

	const recognise = async (key, crop, settings) => {
		const at = now();
		const result = await ocr(crop, settings);

		timings[key] = (timings[key] || 0) + Math.round(now() - at);
		calls++;

		if (onProgress) {
			onProgress(Math.min(0.95, calls / 4));
		}

		return result;
	};

	const prepare = (key) => {
		crops[key] = prepareRegion(card, regionRect(card, REGIONS[key]), scaleFor(card, REGIONS[key], textPx), {sharpen: SHARPEN});

		return crops[key];
	};

	const sideOf = (key) => (key === 'numberLeft' ? 'left' : 'right');

	// The `count` most text-like lines of a strip, read side by side.
	const readLines = async (key, count) => {
		const strip = crops[key] || prepare(key);
		const found = findTextLines(strip, textPx, count);
		const results = await Promise.all(found.map((line, index) => {
			crops[`${key}Line${index + 1}`] = cropRows(strip, line);

			return recognise(key, crops[`${key}Line${index + 1}`], OCR_SETTINGS.numberLine).then((result) => shiftLines(result, line.y0));
		}));
		const lines = results.flat();
		const read = {confidence: 0, lines, text: lines.map((line) => line.text).join('\n')};

		raw[key] = {confidence: 0, lines: [...raw[key].lines, ...lines], text: [raw[key].text, read.text].filter(Boolean).join('\n')};

		return findNumber(sideOf(key), read);
	};

	// A full-art strip's ringed digits (ringedNumbers), each run read as one
	// line, side by side. Returns the surest number read (ringed: true, no
	// box: the set code box is not looked for from it), or null; what was
	// read joins the strip's text, for the misread and partial numbers.
	const ringedRead = async (key) => {
		const runs = ringedNumbers(whitestCrop(card, regionRect(card, REGIONS[key]), scaleFor(card, REGIONS[key], textPx)), textPx);
		const results = await Promise.all(runs.map((run, index) => {
			crops[`${key}Ring${index + 1}`] = run;

			return recognise(key, run, OCR_SETTINGS.numberLine);
		}));
		let best = null;

		for (const result of results) {
			const found = findNumber(sideOf(key), result);

			if (found && (!best || found.confidence > best.confidence)) {
				best = {...found, box: null, ringed: true};
			}
		}

		const lines = results.flatMap(linesOf);

		raw[key] = {confidence: 0, lines: [...raw[key].lines, ...lines], text: [raw[key].text, ...lines.map((line) => line.text)].filter(Boolean).join('\n')};

		return best;
	};

	const sparse = async (key) => {
		const result = await recognise(key, crops[key] || prepare(key), OCR_SETTINGS.sparse);

		raw[key] = {...result, lines: [...raw[key].lines, ...linesOf(result)], text: `${raw[key].text}\n${result.text}`};

		return findNumber(sideOf(key), raw[key]);
	};

	// The label row, beside the number strip, when asked for.
	const labelRead = !withLabel ? Promise.resolve(null) : (async () => {
		const band = prepareRegion(card, regionRect(card, REGIONS.label), scaleFor(card, REGIONS.label, textPx), {sharpen: SHARPEN});
		const found = findTextLines(band, textPx, 2);
		const results = await Promise.all(found.map((line) => recognise('label', cropRows(band, line), OCR_SETTINGS.label)));

		crops.label = band;
		raw.label = {confidence: 0, lines: results.flatMap((result) => linesOf(result)), text: results.map((result) => result.text || '').join('\n')};

		if (!parseLabel(raw.label.text).code) {
			const sparse = await recognise('label', band, OCR_SETTINGS.sparse);

			raw.label = {...sparse, text: [raw.label.text, sparse.text].filter(Boolean).join('\n')};
		}

		return parseLabel(raw.label.text);
	})();

	const first = prefer === 'right' ? 'numberRight' : 'numberLeft';
	const second = first === 'numberLeft' ? 'numberRight' : 'numberLeft';
	const lineCount = (key) => (key === 'numberLeft' ? 3 : 2);
	// A full-art card: its ringed digits first, and the strip's lines only
	// when they give no sure number.
	let number = fullArt ? await ringedRead(first) : null;

	if (!(number && number.confidence >= FULL_ART_SURE)) {
		const plain = await readLines(first, lineCount(first));

		if (plain && (!number || plain.confidence > number.confidence)) {
			number = plain;
		}
	}

	// No number on the likelier strip: its sparse pass and the other strip's
	// lines side by side, then the other strip's sparse pass.
	if (!number) {
		const [again, other] = await Promise.all([sparse(first), readLines(second, lineCount(second))]);

		number = again || other;

		if (!number) {
			number = await sparse(second);
		}
	}

	// No number read: one whose slash read as another character.
	let misreads = [];

	if (!number) {
		for (const key of [first, second]) {
			const list = misreadNumbers(raw[key].text);

			if (list.length) {
				misreads = list;
				number = {...list[0], box: null, confidence: MISREAD_CONFIDENCE, langCode: null, regulationMark: null, setCode: null, side: sideOf(key)};
				break;
			}
		}
	}

	let setCodeBox = {langCode: null, run: '', setCode: null, text: ''};

	if (setCode && number && number.side === 'left' && number.box) {
		const rect = setCodeRect(card, regionRect(card, REGIONS.numberLeft), number.box, scaleFor(card, REGIONS.numberLeft, textPx));

		crops.setCode = prepareCrop(card, rect, 72 / rect.h, SET_CODE_PREP);
		raw.setCode = await recognise('setCode', crops.setCode, OCR_SETTINGS.setCode);
		setCodeBox = parseSetCode(raw.setCode.text);
		number = {...number, langCode: setCodeBox.langCode, setCode: setCodeBox.setCode, setCodeRun: setCodeBox.run};
	}

	const label = await labelRead;

	// No number (or only one whose slash was misread): the name, for the name
	// route, when asked for.
	const name = withName && (!number || number.misread) ? await readName(card, recognise, {crops, raw, textPx}) : null;

	timings.ocr = Math.round(now() - started);
	timings.calls = calls;

	const partial = number ? {number: null, total: null} : parsePartialNumber(`${raw.numberLeft.text}\n${raw.numberRight.text}`);

	return {
		attackText: '',
		copyrightYear: copyrightYear(raw.numberLeft.text, raw.numberRight.text),
		crops,
		hp: null,
		label,
		language: label ? decideLanguage(number, label) : number && number.langCode ? {code: number.langCode, confidence: Math.max(0.5, number.confidence * 0.8), source: 'set code'} : {code: null, confidence: 0, source: 'not read'},
		misreads,
		name,
		number,
		partial,
		raw,
		setCodeBox,
		timings,
		wizards: mentionsWizards(raw.numberLeft.text, raw.numberRight.text),
	};
}
