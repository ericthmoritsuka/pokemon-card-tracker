// Reading a straightened card: every clue at once. The lab pipeline
// (lab/js/pipeline.js, measured on the lab benchmark) read the label row,
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
} from '../../lab/js/pipeline.js';
import {parseHp, parseName, parsePartialNumber} from './evidence.js';

// Regions as fractions of the straightened card, as in lab/js/pipeline.js.
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

// prepareCrop (lab/js/pipeline.js), with a crop to be shrunk averaged down
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

// The first line of an OCR result that holds a collector number read above
// NUMBER_FLOOR, with the confidence and box of the words that make up the
// number. As in lab/js/pipeline.js, which does not export it.
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
	const nameCrop = numberOnly ? null : prepare('name', 'name', {blur: blurName});
	const name = numberOnly ? Promise.resolve(null) : readLines('name', nameCrop, 2, OCR_SETTINGS.name).then(async (lines) => {
		let parsed = parseName(inkHeights(nameCrop, lines));

		raw.name = asResult(lines);

		// A poor read may be the wrong polarity (a name bar half light, half
		// dark): the other one is read too, and the likelier name kept.
		if (!parsed.text || parsed.confidence < 0.45) {
			const other = invertCrop(nameCrop);
			const again = await readLines('name', other, 2, OCR_SETTINGS.name);
			const second = parseName(inkHeights(other, again));

			raw.name = {...raw.name, text: `${raw.name.text}\n${again.map((line) => line.text).join('\n')}`};

			if (second.text && second.confidence > parsed.confidence) {
				parsed = second;
			}
		}

		if (!parsed.text) {
			const sparse = await recognise('name', nameCrop, OCR_SETTINGS.sparse);

			raw.name = {...sparse, text: raw.name.text + '\n' + sparse.text};
			parsed = parseName(inkHeights(nameCrop, [...lines, ...linesOf(sparse)]));
		}

		return parsed;
	});
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
		name: nameRead,
		number,
		partial,
		raw,
		setCodeBox,
		timings,
		wizards: mentionsWizards(raw.numberLeft.text, raw.numberRight.text),
	};
}
