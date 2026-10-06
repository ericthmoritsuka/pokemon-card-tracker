// The read pipeline: card geometry, region crops, image preparation, and
// parsing of the OCR text. Shared by the lab page and the offline
// benchmark, so the benchmark measures exactly this code, and by the app's
// scanner (js/scan/read.js, js/scan/camera.js).
//
// Everything here works on ImageData-shaped objects ({data, height, width},
// RGBA bytes) and plain strings. Nothing touches the DOM or the network;
// the OCR engine is passed in as a function.

export const CARD_RATIO = 63 / 88;

// Regions as fractions of the card's width and height. Measured on TCGdex
// high.webp scans (600 x 825) of Scarlet & Violet, Sword & Shield, Mega
// Evolution, Japanese SV, and WotC-era cards, with a little padding. They
// assume the image is the card edge to edge, which rectify.js makes it.
//
// - label: the weakness, resistance, and retreat row. Modern cards print it
//   at about 87 % of the height, WotC-era cards at about 84 %; one band
//   covers both, and findTextLines picks the line inside it.
// - numberLeft: the collector number on Sun & Moon and later cards, with the
//   regulation mark and, from Scarlet & Violet on, the set code and a
//   language code (`G SVI EN 063/198`).
// - numberRight: the collector number on cards through XY, WotC-era
//   included (`4/102`).
//
// `text` is the height of a capital letter or digit in that region, as a
// fraction of the card's height: 11 px of 825 for a modern collector number,
// 8 px for a WotC-era one, 9 px for the labels.
export const REGIONS = {
	label: {h: 0.1, text: 0.011, w: 0.96, x: 0.02, y: 0.805},
	numberLeft: {h: 0.075, text: 0.0133, w: 0.5, x: 0.02, y: 0.92},
	numberRight: {h: 0.055, text: 0.0097, w: 0.3, x: 0.695, y: 0.935},
};

// Every crop is scaled so its text reaches the OCR engine this many pixels
// tall, whatever the source: a 600 x 825 scan and a 4K phone frame are read
// alike.
export const TEXT_PX = 32;

// Tesseract settings. Every region is first cut into lines (findTextLines)
// and each line read in page segmentation mode 7, one line of text. Mode 11,
// sparse text over the whole region, is only the fallback when no line gave
// a result: on whole regions it missed the label row on most modern cards
// (the rules above and below the row) and most WotC-era numbers.
//
// No character whitelist. Measured on the benchmark, a whitelist made the
// LSTM model drop whole words it otherwise read ("weakness" disappeared from
// a clean Scarlet & Violet scan) and pushed word confidence to zero, so the
// parsers below clean the text instead.
export const OCR_SETTINGS = {
	label: {psm: '7', whitelist: ''},
	numberLine: {psm: '7', whitelist: ''},
	setCode: {psm: '7', whitelist: ''},
	sparse: {psm: '11', whitelist: ''},
};

export const scaleFor = (card, region, textPx = TEXT_PX) => textPx / (region.text * card.height);

// ------------------------------------------------------------ geometry

// The largest 63:88 rectangle that fits in `fill` of a width x height frame,
// centred. The lab draws its guide frame from this, and crops to it.
export function guideRect(width, height, fill = 0.86) {
	let h = height * fill;
	let w = h * CARD_RATIO;

	if (w > width * fill) {
		w = width * fill;
		h = w / CARD_RATIO;
	}

	return {
		h: Math.round(h),
		w: Math.round(w),
		x: Math.round((width - w) / 2),
		y: Math.round((height - h) / 2),
	};
}

export function regionRect(card, region) {
	const x = Math.max(0, Math.round(region.x * card.width));
	const y = Math.max(0, Math.round(region.y * card.height));

	return {
		h: Math.min(card.height - y, Math.round(region.h * card.height)),
		w: Math.min(card.width - x, Math.round(region.w * card.width)),
		x,
		y,
	};
}

// ------------------------------------------------------------ image preparation

// Crops `rect` out of `img`, scales it by `scale` (bilinear), and turns it
// into a contrast-stretched grey image.
//
// Grey is the brightest of the three channels, not luminance: card text is
// near black, and the backgrounds behind it are saturated colours (yellow,
// green, orange) that luminance turns mid-grey. The brightest channel keeps
// any saturated colour light, so the text stands out against all of them.
// With `invert`, light and dark swap, so the white-on-black set code box of
// Scarlet & Violet and later prints reads like ordinary dark text. With
// `threshold`, the result is pure black and white (Otsu's threshold). With
// `unbox` as well, dark runs longer than a letter (the outline of the set
// code box) are painted white. `pad` adds a white margin of that many pixels.
//
// `sharpen` applies an unsharp mask of that strength (0 is none) before the
// contrast stretch.
export function prepareCrop(img, rect, scale, {invert = false, pad = 0, sharpen = 0, threshold = false, unbox = false} = {}) {
	const width = Math.max(1, Math.round(rect.w * scale));
	const height = Math.max(1, Math.round(rect.h * scale));
	const src = img.data;
	const stride = img.width * 4;
	const grey = new Uint8ClampedArray(width * height);

	const sample = (sx, sy) => {
		const i = sy * stride + sx * 4;

		return Math.max(src[i], src[i + 1], src[i + 2]);
	};

	for (let y = 0; y < height; y++) {
		const fy = Math.min(rect.h - 1, Math.max(0, (y + 0.5) / scale - 0.5));
		const y0 = Math.floor(fy);
		const y1 = Math.min(rect.h - 1, y0 + 1);
		const dy = fy - y0;

		for (let x = 0; x < width; x++) {
			const fx = Math.min(rect.w - 1, Math.max(0, (x + 0.5) / scale - 0.5));
			const x0 = Math.floor(fx);
			const x1 = Math.min(rect.w - 1, x0 + 1);
			const dx = fx - x0;
			const top = sample(rect.x + x0, rect.y + y0) * (1 - dx) + sample(rect.x + x1, rect.y + y0) * dx;
			const bottom = sample(rect.x + x0, rect.y + y1) * (1 - dx) + sample(rect.x + x1, rect.y + y1) * dx;

			grey[y * width + x] = top * (1 - dy) + bottom * dy;
		}
	}

	if (sharpen) {
		unsharp(grey, width, height, sharpen, Math.max(1, Math.round(scale)));
	}

	stretch(grey);

	if (threshold) {
		const cut = otsu(grey);

		for (let i = 0; i < grey.length; i++) {
			grey[i] = grey[i] > cut ? 255 : 0;
		}
	}

	if (invert) {
		for (let i = 0; i < grey.length; i++) {
			grey[i] = 255 - grey[i];
		}
	}

	if (threshold && unbox) {
		removeLongRuns(grey, width, height);
	}

	const outWidth = width + pad * 2;
	const outHeight = height + pad * 2;
	const data = new Uint8ClampedArray(outWidth * outHeight * 4).fill(255);

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const value = grey[y * width + x];
			const o = ((y + pad) * outWidth + x + pad) * 4;

			data[o] = value;
			data[o + 1] = value;
			data[o + 2] = value;
		}
	}

	return {data, height: outHeight, width: outWidth};
}

// grey += amount * (grey - box blur of radius r).
function unsharp(grey, width, height, amount, r) {
	const blurred = new Float32Array(grey.length);
	const temp = new Float32Array(grey.length);

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let sum = 0;
			let n = 0;

			for (let i = Math.max(0, x - r); i <= Math.min(width - 1, x + r); i++) {
				sum += grey[y * width + i];
				n++;
			}

			temp[y * width + x] = sum / n;
		}
	}

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			let sum = 0;
			let n = 0;

			for (let i = Math.max(0, y - r); i <= Math.min(height - 1, y + r); i++) {
				sum += temp[i * width + x];
				n++;
			}

			blurred[y * width + x] = sum / n;
		}
	}

	for (let i = 0; i < grey.length; i++) {
		grey[i] = grey[i] + amount * (grey[i] - blurred[i]);
	}
}

// Whitens vertical dark runs taller than 55 % of the crop and horizontal
// ones wider than 40 % of it: box edges, which letters never are.
function removeLongRuns(grey, width, height) {
	const clear = [];

	for (let x = 0; x < width; x++) {
		let start = -1;

		for (let y = 0; y <= height; y++) {
			const dark = y < height && grey[y * width + x] === 0;

			if (dark && start < 0) {
				start = y;
			}
			else if (!dark && start >= 0) {
				if (y - start > height * 0.55) {
					for (let i = start; i < y; i++) {
						clear.push(i * width + x);
					}
				}

				start = -1;
			}
		}
	}

	for (let y = 0; y < height; y++) {
		let start = -1;

		for (let x = 0; x <= width; x++) {
			const dark = x < width && grey[y * width + x] === 0;

			if (dark && start < 0) {
				start = x;
			}
			else if (!dark && start >= 0) {
				if (x - start > width * 0.4) {
					for (let i = start; i < x; i++) {
						clear.push(y * width + i);
					}
				}

				start = -1;
			}
		}
	}

	for (const i of clear) {
		grey[i] = 255;
	}
}

function otsu(grey) {
	const histogram = new Float64Array(256);

	for (const value of grey) {
		histogram[value]++;
	}

	let sum = 0;

	for (let v = 0; v < 256; v++) {
		sum += v * histogram[v];
	}

	let background = 0;
	let backgroundSum = 0;
	let best = 0;
	let cut = 127;

	for (let v = 0; v < 256; v++) {
		background += histogram[v];

		if (!background || background === grey.length) {
			continue;
		}

		backgroundSum += v * histogram[v];

		const foreground = grey.length - background;
		const between = background * foreground * ((backgroundSum / background) - ((sum - backgroundSum) / foreground)) ** 2;

		if (between > best) {
			best = between;
			cut = v;
		}
	}

	return cut;
}

// The `count` most text-like horizontal strips of a prepared crop, best
// first, as {y0, y1}. A row of pixels through text crosses between dark and
// light far more often than one through a rule, a bar, or plain background,
// so rows are scored by their sharp steps in brightness, runs of high-scoring
// rows become lines, and the lines are ranked by their total score.
export function findTextLines(crop, textPx, count = 2) {
	const {data, height, width} = crop;
	const rows = new Float64Array(height);

	// A transition is a step in brightness of more than a sixth of the range. A global threshold (Otsu) failed here: on WotC-era cards
	// the bright card border beside the number took the threshold, and the
	// whole grey strip, text included, fell on one side of it.
	// The step is measured across a tenth of a text height, because the crop
	// has been scaled up and its edges are soft.
	const step = Math.max(1, Math.round(textPx / 10));

	for (let y = 0; y < height; y++) {
		const row = y * width * 4;

		for (let x = step; x < width; x++) {
			if (Math.abs(data[row + x * 4] - data[row + (x - step) * 4]) > 42) {
				rows[y]++;
			}
		}
	}

	const peak = Math.max(...rows);

	if (!peak) {
		return [];
	}

	const runs = [];
	let start = -1;

	for (let y = 0; y <= height; y++) {
		const on = y < height && rows[y] >= peak * 0.2;

		if (on && start < 0) {
			start = y;
		}
		else if (!on && start >= 0) {
			const last = runs[runs.length - 1];

			// A gap thinner than a stroke is the same line (between the dot
			// and the stem of an i, say).
			if (last && start - last.y1 < textPx * 0.15) {
				last.y1 = y;
			}
			else {
				runs.push({y0: start, y1: y});
			}

			start = -1;
		}
	}

	const pad = Math.round(textPx * 0.35);

	return runs
		.filter((run) => run.y1 - run.y0 >= textPx * 0.4)
		.map((run) => {
			let score = 0;

			for (let y = run.y0; y < run.y1; y++) {
				score += rows[y];
			}

			return {score, y0: Math.max(0, run.y0 - pad), y1: Math.min(height, run.y1 + pad)};
		})
		.sort((a, b) => b.score - a.score)
		.slice(0, count)
		.map(({y0, y1}) => ({y0, y1}));
}

export function cropRows(crop, {y0, y1}) {
	const rowBytes = crop.width * 4;

	return {
		data: crop.data.slice(y0 * rowBytes, y1 * rowBytes),
		height: y1 - y0,
		width: crop.width,
	};
}

// Maps the 2nd to 98th percentile of the grey values onto 0 to 255.
function stretch(grey) {
	const histogram = new Uint32Array(256);

	for (const value of grey) {
		histogram[value]++;
	}

	const percentile = (fraction) => {
		const target = grey.length * fraction;
		let seen = 0;

		for (let v = 0; v < 256; v++) {
			seen += histogram[v];

			if (seen >= target) {
				return v;
			}
		}

		return 255;
	};

	const low = percentile(0.02);
	const high = percentile(0.98);

	if (high - low < 16) {
		return;
	}

	for (let i = 0; i < grey.length; i++) {
		grey[i] = ((grey[i] - low) * 255) / (high - low);
	}
}

// ------------------------------------------------------------ collector number

const LANGUAGE_CODES = {DE: 'de', EN: 'en', ES: 'es', FR: 'fr', IT: 'it', PT: 'pt'};

// Regulation marks printed so far run from A to I; J leaves room for the next.
const REGULATION = /^[A-J]$/;

// Reads `063/198`, `4/102`, and subset numbers such as `TG05/TG30` out of the
// OCR text of a number strip, plus what sits before the number on the same
// line: the regulation mark, the set code, and the language code that Scarlet
// & Violet and later prints carry (`G SVI EN 063/198`, often read as one
// token, `SVIEN`).
//
// Returns null when no number and total can be found.
export function parseNumber(text) {
	const lines = String(text || '').toUpperCase().split(/\n+/);

	for (const line of lines) {
		// Inside a token with a slash, letters the OCR puts in place of
		// digits (`0S3/195` for `053/195`) become those digits; elsewhere, O
		// next to a digit becomes 0 and I or L between digits becomes 1. Spaces
		// around the slash go.
		const clean = line
			.replace(/\s*\/\s*/g, '/')
			.replace(/[0-9OSILBZ]{1,3}\/[0-9OSILBZ]{1,3}/g, (token) => (/\d/.test(token) ? token.replace(/[OSILBZ]/g, (ch) => DIGIT_LOOKALIKES[ch]) : token))
			.replace(/(?<=\d)O|O(?=\d)/g, '0')
			.replace(/(?<=\d)[IL](?=\d)/g, '1');

		const found = [];

		for (const match of clean.matchAll(/(?:^|[^A-Z0-9])([A-Z]{1,2})(\d{1,3})\/\1(\d{1,3})(?![0-9])/g)) {
			found.push({index: match.index + (/^[^A-Z0-9]/.test(match[0]) ? 1 : 0), number: match[2], prefix: match[1], total: match[3]});
		}

		if (!found.length) {
			for (const match of clean.matchAll(/(\d{1,3})\/(\d{1,3})(?![0-9])/g)) {
				found.push({index: match.index, number: match[1], prefix: '', total: match[2]});
			}
		}

		// Several on one line (the regulation mark and set code box can read
		// as `6/81`): the one with the most digits, the full number usually.
		const valid = found
			.filter(({number, total}) => Number(number) > 0 && Number(total) > 0 && Number(total) <= 400 && Number(number) <= 500)
			.sort((a, b) => (b.number.length + b.total.length) - (a.number.length + a.total.length));

		if (!valid.length) {
			continue;
		}

		const {index, number, prefix, total} = valid[0];
		const before = clean.slice(0, index).split(/[^A-Z0-9]+/).filter(Boolean);

		return {
			number: prefix + String(Number(number)).padStart(prefix ? 2 : 1, '0'),
			numberPrinted: prefix + number,
			total: String(Number(total)),
			totalPrinted: prefix + total,
			...parseMarks(before),
		};
	}

	return null;
}

const DIGIT_LOOKALIKES = {B: '8', I: '1', L: '1', O: '0', S: '5', Z: '2'};

// The tokens before the number, right to left: an optional language code,
// the set code, and the regulation mark.
function parseMarks(tokens) {
	const result = {langCode: null, regulationMark: null, setCode: null};
	const rest = [...tokens];

	while (rest.length) {
		const token = rest.pop();

		if (!result.langCode && !result.setCode && LANGUAGE_CODES[token]) {
			result.langCode = LANGUAGE_CODES[token];

			continue;
		}

		if (!result.setCode && /^[A-Z][A-Z0-9]{1,5}$/.test(token)) {
			const glued = token.length >= 5 ? LANGUAGE_CODES[token.slice(-2)] : null;

			if (glued && !result.langCode) {
				result.langCode = glued;
				result.setCode = token.slice(0, -2);
			}
			else {
				result.setCode = token;
			}

			continue;
		}

		if (!result.regulationMark && REGULATION.test(token)) {
			result.regulationMark = token;

			break;
		}
	}

	return result;
}

// ------------------------------------------------------------ language label

// The three labels of the weakness row in each Latin-script language TCGdex
// carries. Matched without accents, so "résistance" and "resistance" are the
// same word, and the language is decided by the other two.
export const LABELS = {
	de: ['schwache', 'resistenz', 'ruckzug'],
	en: ['weakness', 'resistance', 'retreat'],
	es: ['debilidad', 'resistencia', 'retirada'],
	fr: ['faiblesse', 'resistance', 'retraite'],
	it: ['debolezza', 'resistenza', 'ritirata'],
	pt: ['fraqueza', 'resistencia', 'recuo'],
};

export const LANGUAGE_NAMES = {
	de: 'German',
	en: 'English',
	es: 'Spanish',
	fr: 'French',
	it: 'Italian',
	ja: 'Japanese',
	'non-latin': 'Not Latin script',
	pt: 'Portuguese',
};

const fold = (text) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function editDistance(a, b) {
	const row = Array.from({length: b.length + 1}, (_, i) => i);

	for (let i = 1; i <= a.length; i++) {
		let diagonal = row[0];

		row[0] = i;

		for (let j = 1; j <= b.length; j++) {
			const above = row[j];

			row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
			diagonal = above;
		}
	}

	return row[b.length];
}

const similarity = (a, b) => 1 - editDistance(a, b) / Math.max(a.length, b.length);

// A word counts as a label when it is at least this similar to it, so
// "weaknass" and "Fraqucza" still count and short noise does not.
const MATCH = 0.7;

// Scores each language by how well the words of the label row match its
// three labels. A label whose spelling another language shares (résistance in
// English and French) adds to both, so it never decides alone.
//
// Returns {code, confidence, scores, words}; code is null when nothing
// matched.
export function parseLabel(text) {
	const words = fold(String(text || '')).split(/[^a-z]+/).filter((word) => word.length >= 4);
	const scores = {};

	for (const [code, labels] of Object.entries(LABELS)) {
		scores[code] = 0;

		for (const label of labels) {
			let best = 0;

			for (const word of words) {
				best = Math.max(best, similarity(word, label));
			}

			if (best >= MATCH) {
				scores[code] += best;
			}
		}
	}

	const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
	const [[code, top], [, second]] = ranked;

	if (!top) {
		return {code: null, confidence: 0, scores, words};
	}

	// Full marks need all three labels read and a lead of at least one and a
	// half labels over the runner-up (a shared spelling gives the runner-up
	// one).
	const confidence = Math.min(1, top / 3) * Math.min(1, (top - second) / 1.5);

	return {code, confidence: round(confidence), scores, words};
}

// ------------------------------------------------------------ the whole read

const round = (value) => Math.round(value * 100) / 100;

const linesOf = (result) => (result.lines && result.lines.length
	? result.lines
	: String(result.text || '').split(/\n+/).map((text) => ({text, words: []})));

// The first line of an OCR result that holds a collector number, with the
// confidence and box of the words that make up the number.
function findNumber(side, result) {
	for (const line of linesOf(result)) {
		const parsed = parseNumber(line.text);

		if (!parsed) {
			continue;
		}

		const digits = (text) => text.toUpperCase().replace(/[^0-9]/g, '');
		const target = digits(parsed.numberPrinted) + digits(parsed.totalPrinted);
		// The number is normally one word; a stray digit read off the set code
		// box beside it must not widen its box.
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

		return {
			...parsed,
			box,
			confidence: round((confidence / 100) * (plausible ? 1 : 0.5)),
			// Set codes come from their own pass (setCodeRect); what this pass
			// reads there is mostly noise, the box being white on black.
			langCode: null,
			setCode: null,
			side,
		};
	}

	return null;
}

// Where the set code box sits, in card pixels: just left of the collector
// number, on its line. `box` is the number's box in the prepared crop of
// `regionRect`, which was scaled by `scale`.
export function setCodeRect(card, regionRect, box, scale) {
	const height = (box.y1 - box.y0) / scale;
	const numberLeft = regionRect.x + box.x0 / scale;
	const x = Math.max(0, Math.round(numberLeft - height * 4.6));
	const y = Math.max(0, Math.round(regionRect.y + box.y0 / scale - height * 0.8));

	return {
		h: Math.min(card.height - y, Math.round(height * 2.5)),
		w: Math.max(1, Math.round(numberLeft - x - height * 0.15)),
		x,
		y,
	};
}

// The set code box reads as one run of letters: `SSPEN` for `SSP EN`, often
// with the box outline or the regulation mark's box around it (`JSSPEN`).
// International prints end in a language code after a three-letter set code;
// Japanese prints have no language code and set codes of two to four
// characters (`SV1S`, `SV2a`). `run` keeps every letter and digit, because
// the matcher looks for each candidate set's code inside it rather than
// trusting where this guess cuts.
export function parseSetCode(text) {
	const run = String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
	const tail = run.slice(-2);

	if (run.length >= 5 && LANGUAGE_CODES[tail]) {
		return {langCode: LANGUAGE_CODES[tail], run, setCode: run.slice(-5, -2), text};
	}

	return {langCode: null, run, setCode: run.length >= 2 ? run.slice(-4) : null, text};
}

// The latest copyright year printed in the number strips: `©2023 Pokémon` on
// modern cards, `©1999 Wizards` beside the number on WotC-era ones. It dates
// the print, which separates sets that share a card count.
export function copyrightYear(...texts) {
	const thisYear = new Date().getFullYear();
	const years = texts
		.join(' ')
		.match(/(?:19[89]\d|20[0-4]\d)/g) || [];
	const plausible = years.map(Number).filter((year) => year >= 1996 && year <= thisYear);

	return plausible.length ? Math.max(...plausible) : null;
}

// True when a number strip names Wizards of the Coast (`©1999 Wizards`),
// which only WotC-era prints do. Matched loosely: `Wards`, `Wmrds`, and
// `Wirards` are what the OCR made of it on clean scans.
export function mentionsWizards(...texts) {
	const words = fold(texts.join(' ')).split(/[^a-z]+/).filter((word) => word.length >= 4);

	return words.some((word) => similarity(word, 'wizards') >= 0.55 || /^w[a-z]{1,5}ds$/.test(word));
}

// How the set code box is prepared for OCR; see prepareCrop. Chosen on the
// benchmark over the same without unbox, and with a white margin, none of
// which read the box better than about one time in three on 600 x 825 scans.
export const SET_CODE_PREP = {invert: true, threshold: true, unbox: true};

// Unsharp mask strength for the label and number crops. On the benchmark's
// blurred captures 0.8 read 7 more numbers of 84 than none, and changed
// nothing on clean scans; 1.5 cost clean scans 4.
export const SHARPEN = 0.8;

// Reads one card image (already cropped to the card) with `ocr`, an async
// function (image, {psm, whitelist}) => {confidence, lines, text}.
//
// Returns the prepared crops, the raw OCR results, the parsed number, label,
// set code, and copyright year, the language decision, and the time each OCR
// call took.
export async function readCard(card, ocr, {now = () => performance.now(), setCodePrep = SET_CODE_PREP, settings = OCR_SETTINGS, sharpen = SHARPEN, textPx = TEXT_PX} = {}) {
	const crops = {};
	const raw = {};
	const timings = {};

	const recognise = async (key, crop, ocrSettings) => {
		const started = now();

		raw[key] = await ocr(crop, ocrSettings);
		timings[key] = Math.round(now() - started);
	};

	const prepare = (key, rect, scale, options = {sharpen}) => {
		crops[key] = prepareCrop(card, rect, scale, options);

		return crops[key];
	};

	// The label row: the two most text-like lines of the band, each read as
	// one line. Two, because on WotC-era cards the band also catches the first
	// line of the flavour text.
	const labelBand = prepare('label', regionRect(card, REGIONS.label), scaleFor(card, REGIONS.label, textPx));
	const labelLines = findTextLines(labelBand, textPx, 2);
	const labelTexts = [];
	let labelConfidence = 0;

	for (const [index, line] of labelLines.entries()) {
		const key = `labelLine${index + 1}`;

		crops[key] = cropRows(labelBand, line);
		await recognise(key, crops[key], settings.label);
		labelTexts.push(raw[key].text);
		labelConfidence = Math.max(labelConfidence, raw[key].confidence);
	}

	raw.label = {confidence: labelConfidence, lines: [], text: labelTexts.join('\n')};

	// No label in the lines: read the whole band as sparse text as well.
	// Japanese cards always pay for this pass, Latin ones only on a miss.
	if (!parseLabel(raw.label.text).code) {
		await recognise('labelSparse', labelBand, settings.sparse);
		raw.label = {
			confidence: Math.max(labelConfidence, raw.labelSparse.confidence),
			lines: [],
			text: [raw.label.text, raw.labelSparse.text].filter(Boolean).join('\n'),
		};
		delete raw.labelSparse;
	}

	// The number strips: the most text-like lines of each, read one line at a
	// time (three on the left, where the illustrator and copyright lines sit
	// above and below the number), then the whole strip as sparse text only
	// if no line held a number. Reading whole strips alone missed most
	// WotC-era numbers: Tesseract dropped `3/111` as line art.
	for (const [key, count] of [['numberLeft', 3], ['numberRight', 2]]) {
		const strip = prepare(key, regionRect(card, REGIONS[key]), scaleFor(card, REGIONS[key], textPx));
		const lines = [];
		let ms = 0;

		for (const [index, line] of findTextLines(strip, textPx, count).entries()) {
			const lineKey = `${key}Line${index + 1}`;

			crops[lineKey] = cropRows(strip, line);
			await recognise(lineKey, crops[lineKey], settings.numberLine);
			ms += timings[lineKey];
			delete timings[lineKey];

			// Word boxes back in strip coordinates, for setCodeRect.
			for (const read of linesOf(raw[lineKey])) {
				lines.push({
					text: read.text,
					words: read.words.map((word) => ({...word, bbox: {...word.bbox, y0: word.bbox.y0 + line.y0, y1: word.bbox.y1 + line.y0}})),
				});
			}

			delete raw[lineKey];
		}

		raw[key] = {
			confidence: 0,
			lines,
			text: lines.map((line) => line.text).join('\n'),
		};
		timings[key] = ms;

		if (!findNumber(key === 'numberLeft' ? 'left' : 'right', raw[key])) {
			const fallbackKey = `${key}Sparse`;

			await recognise(fallbackKey, strip, settings.sparse);
			timings[key] += timings[fallbackKey];
			delete timings[fallbackKey];

			const sparse = raw[fallbackKey];

			delete raw[fallbackKey];
			raw[key] = {...sparse, lines: [...lines, ...linesOf(sparse)], text: raw[key].text + '\n' + sparse.text};
		}
	}

	const left = findNumber('left', raw.numberLeft);
	const right = findNumber('right', raw.numberRight);
	let number = left || right;

	if (left && right) {
		number = right.confidence > left.confidence ? right : left;
	}

	// A number on the left means a Sun & Moon or later print; from Scarlet &
	// Violet on, those carry the set code box, so read it.
	let setCodeBox = {langCode: null, run: '', setCode: null, text: ''};

	if (number && number.side === 'left' && number.box) {
		const rect = setCodeRect(card, regionRect(card, REGIONS.numberLeft), number.box, scaleFor(card, REGIONS.numberLeft, textPx));

		// Scaled so the box is about 72 px tall, more than the rest: its
		// letters are condensed and the language code is half height.
		await recognise('setCode', prepare('setCode', rect, 72 / rect.h, setCodePrep), settings.setCode);
		setCodeBox = parseSetCode(raw.setCode.text);
		number = {...number, langCode: setCodeBox.langCode, setCode: setCodeBox.setCode, setCodeRun: setCodeBox.run};
	}

	timings.ocr = Object.values(timings).reduce((sum, ms) => sum + ms, 0);
	timings.label = labelLines.reduce((sum, line, index) => sum + timings[`labelLine${index + 1}`], 0) + (timings.labelSparse || 0);

	const label = parseLabel(raw.label.text);
	const year = copyrightYear(raw.numberLeft.text, raw.numberRight.text);
	const wizards = mentionsWizards(raw.numberLeft.text, raw.numberRight.text);

	return {
		copyrightYear: year,
		crops,
		label,
		language: decideLanguage(number, label),
		number,
		raw,
		setCodeBox,
		timings,
		wizards,
	};
}

// The set code's language code, when the card prints one, outranks the label
// row: it is a fixed two-letter code in a box rather than a word in a small
// font. With neither, the card is reported as not Latin script, which is
// what a Japanese, Korean, or Chinese card looks like to the English model.
export function decideLanguage(number, label) {
	if (number && number.langCode) {
		const agrees = label.code === number.langCode;

		return {
			code: number.langCode,
			confidence: round(agrees ? Math.max(0.9, number.confidence) : Math.max(0.5, number.confidence * 0.8)),
			source: agrees ? 'set code and label' : 'set code',
		};
	}

	if (label.code) {
		return {code: label.code, confidence: label.confidence, source: 'label'};
	}

	return {code: 'non-latin', confidence: number ? 0.5 : 0.2, source: 'no Latin label read'};
}
