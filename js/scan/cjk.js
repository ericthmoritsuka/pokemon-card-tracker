// Japanese and Korean names on the name strip (Eric, 2026-11-04). Korean
// copies sit on Japanese catalog records, and most of those records have no
// image, so the picture route cannot match them; when the collector number
// does not read either, the name is all the scanner has, and the English
// model reads no Japanese or Korean. So:
//
// - wantsCjk decides when the Japanese or Korean OCR model is worth loading
//   for a card (js/scan/read.js readName): the card's language is known to
//   be Japanese or Korean (picked, Set for all, or a picture whose cards are
//   all Asian prints), or the English read of the name strip found no
//   plausible name and the strip looks like kana, kanji, or Hangul
//   (looksCjk, a cheap test of the line's shapes).
// - cjkKey folds a name read in either script the way nameKey
//   (js/scan/evidence.js) folds Latin names: full and half width, hiragana
//   and katakana, small kana, voicing marks, long vowel marks, the kanji the
//   Japanese model reads for katakana (口 for ロ, 力 for カ), and Hangul
//   composed or spelled out in jamo.
// - matchCjkNames scores a read against the Japanese and Korean names
//   (js/scan/asian-names.json, built by lab/names/build.mjs: PokeAPI species
//   names, BSD-3-Clause; TCGdex Japanese Trainer names, MIT), answering in
//   matchNames' shape, so the name route (js/scan/match.js) finds the
//   species' Japanese and Korean prints.
//
// Pure functions, no DOM and no network, so Node tests them
// (tests/scan-cjk.test.mjs).

// ------------------------------------------------------------ scripts

const HANGUL = /[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-힯ힰ-퟿]/gu;
const JAPANESE = /[぀-ヿㇰ-ㇿｦ-ﾟ㐀-䶿一-鿿]/gu;

const count = (text, pattern) => (String(text || '').match(pattern) || []).length;

// The script of a name read: 'ko' (Hangul), 'ja' (kana or kanji), or null
// (no CJK letters, or as many of each).
export function scriptOf(text) {
	const korean = count(text, HANGUL);
	const japanese = count(text, JAPANESE);

	if (korean > japanese) {
		return 'ko';
	}

	return japanese > korean ? 'ja' : null;
}

export const hasCjk = (text) => scriptOf(text) !== null;

// The OCR model for a language: Tesseract's names.
export const MODEL = {ja: 'jpn', ko: 'kor'};

export const ASIAN_NAME_LANGUAGES = ['ja', 'ko'];

// ------------------------------------------------------------ folding

// Small kana and their full-size forms; voicing marks are dropped (the OCR
// often loses or adds the two dots of ガ, and a name is still the same name).
const SMALL = {ァ: 'ア', ィ: 'イ', ゥ: 'ウ', ェ: 'エ', ォ: 'オ', ッ: 'ツ', ャ: 'ヤ', ュ: 'ユ', ョ: 'ヨ', ヮ: 'ワ', ヵ: 'カ', ヶ: 'ケ', ㇰ: 'ク', ㇱ: 'シ', ㇲ: 'ス', ㇳ: 'ト', ㇵ: 'ハ', ㇶ: 'ヒ', ㇷ: 'フ', ㇸ: 'ヘ', ㇹ: 'ホ', ㇻ: 'ラ', ㇼ: 'リ', ㇽ: 'ル', ㇾ: 'レ', ㇿ: 'ロ'};

// What the Japanese model reads in place of a katakana on card fonts, and
// the katakana pairs it mixes up, folded to one form on both sides: the
// kanji 口 for ロ, 力 for カ, 工 for エ, 二 for ニ, 卜 for ト, 夕 for タ,
// 八 for ハ, 匕 for ヒ, 才 for オ, 千 for チ, 三 for ミ; シ and ツ, ソ and
// ン; and every dash or the kanji 一 for the long vowel mark ー.
const LOOKALIKE = {
	'-': 'ー', '~': 'ー', '‐': 'ー', '‑': 'ー', '‒': 'ー', '\u2013': 'ー', '\u2014': 'ー', '\u2015': 'ー', '─': 'ー', '━': 'ー', '〜': 'ー', '～': 'ー', 'ｰ': 'ー', '一': 'ー',
	三: 'ミ', 二: 'ニ', 八: 'ハ', 力: 'カ', 千: 'チ', 卜: 'ト', 口: 'ロ', 夕: 'タ', 工: 'エ', 才: 'オ', 匕: 'ヒ',
	シ: 'ツ', ン: 'ソ',
};

const KEEP = /[ᄀ-ᇿꥠ-꥿ힰ-퟿ァ-ヺー㐀-䶿一-鿿]/u;

// The folded form of a name in either script, for comparing what the OCR
// read with a table name. Latin letters, digits, spaces, and marks are
// dropped (a suffix such as "ex" or "V" says what kind of card it is, not
// which Pokémon), Hangul is spelled out in jamo (so one misread stroke is
// one letter of about seven in a three-syllable name, not a whole
// syllable), and kana are folded as above.
//
// strict: true keeps what the folding drops between kana (voicing marks,
// small kana, and シ, ツ, ソ, ン apart), for names too short to fold
// (keySimilarity).
const KANA_PAIRS = new Set(['シ', 'ン']);

export function cjkKey(text, {strict = false} = {}) {
	const wide = String(text || '').normalize('NFKC');
	let out = '';

	for (const ch of wide.replace(/[ぁ-ゖ]/gu, (kana) => String.fromCharCode(kana.charCodeAt(0) + 0x60))) {
		const one = strict && KANA_PAIRS.has(ch) ? ch : LOOKALIKE[ch] || ch;

		for (const part of one.normalize('NFD')) {
			const plain = strict ? part : SMALL[part] || part;

			if (strict && (plain === '゙' || plain === '゚')) {
				out += plain;

				continue;
			}

			if (plain === '゙' || plain === '゚' || !KEEP.test(plain)) {
				continue;
			}

			out += strict && KANA_PAIRS.has(plain) ? plain : LOOKALIKE[plain] || plain;
		}
	}

	return strict ? out.normalize('NFC') : out;
}

// The names that must read exactly: a Korean one of one or two syllables
// (a key in jamo, counted by its leading consonants), a Japanese one under
// three kana. One misread stroke left a two-syllable Korean name at 0.8 or
// more against 1.9 % of random two-syllable reads (review of version 56's
// first draft, 2026-11-04). A kana key under three must read exactly before
// the folding as well (strict cjkKey): "パウ" is not the Trainer "ハウ".
// Kana keys of three and four lose a little more for each misread
// (SHORT_KANA): a four-kana name one kana off scored 0.75 against 1.7 % of
// random four-kana reads.
const isJamo = (key) => /[ᄀ-ᇿꥠ-꥿ힰ-퟿]/u.test(key);
const syllables = (key) => (key.match(/[ᄀ-ᅟꥠ-꥿]/gu) || []).length;
const exactOnly = (key) => (isJamo(key) ? syllables(key) < 3 : key.length < 3);
const SHORT_KANA = 5;

// The shortest key that may be found inside a longer read: 7 jamo for a
// Korean name, 4 kana for a Japanese one. A shorter Korean one is found
// inside random reads too often: with five-jamo names allowed, 4 to 7 % of
// random Hangul reads of two to five syllables named a Pokémon at 0.7 or
// more (review of version 56's first draft, 2026-11-04), "헬가" (Houndour)
// inside "젤갑돌" among them. Japanese names need it from four kana: the
// model reads the stage label glued to the name ("デスナヘビ" for スナヘビ,
// "閉ヤドラン" for ヤドラン), and on the lab benchmark 14 of the 119 names
// read right were lost at 7; random katakana still names a Pokémon under
// 1 % of the time.
export const SUBSTRING_SHORTEST = 7;
const SUBSTRING_SHORTEST_KANA = 4;

// ------------------------------------------------------------ comparing

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

// The edit distance from `needle` to the closest stretch of `hay`.
function closestStretch(needle, hay) {
	let row = new Array(hay.length + 1).fill(0);
	let next = new Array(hay.length + 1).fill(0);

	for (let i = 1; i <= needle.length; i++) {
		next[0] = i;

		for (let j = 1; j <= hay.length; j++) {
			next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (needle[i - 1] === hay[j - 1] ? 0 : 1));
		}

		[row, next] = [next, row];
	}

	return Math.min(...row);
}

// How alike a read is to a name's key, 0 to 1: the whole read, or a long
// name inside a longer read (the stage label "たね" or a prefix such as
// "メガ" glued to it) at a small discount. A short name must read exactly;
// a very short kana one must read exactly unfolded too (`strict`, the two
// texts' strict keys, compared only then).
function keySimilarity(key, read, strict = null) {
	if (!key || !read) {
		return 0;
	}

	let best = 1 - editDistance(key, read) / Math.max(key.length, read.length);

	if (key.length >= (isJamo(key) ? SUBSTRING_SHORTEST : SUBSTRING_SHORTEST_KANA) && read.length > key.length) {
		best = Math.max(best, (1 - closestStretch(key, read) / key.length) * 0.92);
	}

	if (best === 1 && !isJamo(key) && exactOnly(key) && strict) {
		const [name, text] = strict();

		best = name === text ? 1 : 1 - Math.min(1, editDistance(name, text) / Math.max(1, name.length));
	}

	if (best < 1 && exactOnly(key)) {
		best *= 0.8;
	}
	else if (best < 1 && !isJamo(key) && key.length < SHORT_KANA) {
		best *= 0.92;
	}

	return best;
}

// How alike two names in Japanese or Korean read, 0 to 1 (0 when either has
// no CJK letters).
export const cjkSimilarity = (a, b) => keySimilarity(cjkKey(a), cjkKey(b), () => [cjkKey(a, {strict: true}), cjkKey(b, {strict: true})]);

// ------------------------------------------------------------ the table

// js/scan/asian-names.json as entries for matchCjkNames: [{dex, name,
// english, lang, key}]. dex is the National Dex number (null for a
// Trainer); english the English name the species' international records
// use, from `english` (an array by dex less one, local-names.json's
// species.en), left out when not known.
export function asianNameEntries(table, english = []) {
	const entries = [];
	const species = (table && table.species) || {};

	for (const lang of ASIAN_NAME_LANGUAGES) {
		String(species[lang] || '').split('|').forEach((name, i) => {
			const key = cjkKey(name);

			if (name && key) {
				entries.push({dex: i + 1, key, lang, name, ...(english[i] ? {english: english[i]} : {})});
			}
		});
	}

	for (const [lang, names] of Object.entries((table && table.trainers) || {})) {
		for (const name of names || []) {
			const key = cjkKey(name);

			if (key.length >= 2) {
				entries.push({dex: null, key, lang, name, trainer: true});
			}
		}
	}

	return entries;
}

// The names a Japanese or Korean read is closest to, best first, in
// matchNames' shape: [{dex, name, score, spelling, lang}], name the English
// name when the table knows it (else the spelling), spelling the name as
// printed, lang 'ja' or 'ko'; a Trainer adds trainer: true. Only names in
// the read's script are compared. One answer per Pokémon (per name for a
// Trainer). Names the folding cannot tell apart (カラカラ and ガラガラ,
// ポリゴン, ポリゴン２, and ポリゴンＺ, ニドラン♀ and ニドラン♂) are ties:
// every name tied for the best score is returned, past `limit` if need be,
// never one of them alone.
export function matchCjkNames(text, entries, {limit = 4, min = 0.7} = {}) {
	const read = cjkKey(text);
	const script = scriptOf(text);

	if (!script || read.length < 2) {
		return [];
	}

	const found = new Map();

	for (const entry of entries || []) {
		if (entry.lang !== script) {
			continue;
		}

		const key = entry.key || cjkKey(entry.name);

		if (Math.abs(key.length - read.length) > read.length && read.length < key.length) {
			continue;
		}

		const score = Math.round(keySimilarity(key, read, () => [cjkKey(entry.name, {strict: true}), cjkKey(text, {strict: true})]) * 100) / 100;

		if (score < min) {
			continue;
		}

		const id = entry.dex ? `#${entry.dex}` : `=${key}`;
		const previous = found.get(id);

		if (!previous || score > previous.score) {
			found.set(id, {
				dex: entry.dex || null,
				lang: entry.lang,
				name: entry.english || entry.name,
				score,
				spelling: entry.name,
				...(entry.trainer ? {trainer: true} : {}),
			});
		}
	}

	const sorted = [...found.values()].sort((a, b) => b.score - a.score || b.spelling.length - a.spelling.length);
	const tied = sorted.filter((match) => match.score === sorted[0].score).length;

	return sorted.slice(0, Math.max(limit, tied));
}

// The species a printed Japanese or Korean card name is (a record the
// number route found carries its name, not its species): the species whose
// name it is as printed, else those whose folded name it is, else the one
// it holds that makes up most of it ("メガグソクムシャex", Mega Golisopod
// ex, is Golisopod). Returns the National Dex numbers, [] for none. A record
// name is printed text, not a read, so "カラカラ" is Cubone alone; a name the
// folding cannot tell apart from another's that is not printed as either
// gives both. A Trainer named after a Pokémon ("カビゴンドール", a Snorlax
// Doll) holds the species in too little of its name to count.
const printed = (text) => String(text || '').normalize('NFKC').replace(/\s+/gu, '');

export function dexesOfCjkName(name, entries) {
	const key = cjkKey(name);
	const script = scriptOf(name);

	if (!script || key.length < 2) {
		return [];
	}

	const exact = new Set();
	const folded = new Set();
	let best = null;

	for (const entry of entries || []) {
		if (!entry.dex || entry.lang !== script) {
			continue;
		}

		const own = entry.key || cjkKey(entry.name);

		if (printed(entry.name) === printed(name)) {
			exact.add(entry.dex);
		}

		if (own === key) {
			folded.add(entry.dex);
		}

		if (own.length >= 2 && key.includes(own) && own.length >= key.length * 0.6 && (!best || own.length > best.length)) {
			best = {dex: entry.dex, length: own.length};
		}
	}

	if (exact.size || folded.size) {
		return [...(exact.size ? exact : folded)];
	}

	return best ? [best.dex] : [];
}

// The one species a printed name is (dexesOfCjkName), or null when it is
// none or the folding leaves several.
export function dexOfCjkName(name, entries) {
	const dexes = dexesOfCjkName(name, entries);

	return dexes.length === 1 ? dexes[0] : null;
}

// ------------------------------------------------------------ the name strip

// The stage label and other words of the name strip that are never the name,
// as the Japanese and Korean models read them: たね (Basic), 1進化 and 2進化
// (Stage 1 and 2), 進化 alone, ポケモン, 復元 (Restored), and Korean 기본,
// 1진화, 2진화, 진화, 복원.
const NOT_NAME = new Set(['タネ', 'タネポケモソ', 'ポケモソ', '進化', '復元', '기본', '진화', '복원', '포켓몬'].map(cjkKey));

// Mechanic suffixes, as the name strip prints them after the name.
const SUFFIX = /^(?:ex|EX|GX|V|VMAX|VSTAR|VUNION|BREAK|LV\.?X|M)$/u;

// The name from the OCR lines of the name strip read with the Japanese or
// Korean model: the words in the tallest print (the stage label and the
// "evolves from" line are smaller), their CJK letters, with the stage words
// left out, and a mechanic suffix read in Latin letters kept apart. Returns
// {text, suffix, confidence, script}; text is '' when nothing name-like was
// read.
export function parseCjkName(lines) {
	const words = [];

	for (const [index, line] of (lines || []).entries()) {
		const list = line.words && line.words.length ? line.words : String(line.text || '').split(/\s+/).map((text) => ({confidence: 50, text}));

		for (const word of list) {
			const text = String(word.text || '').trim();

			if (!text) {
				continue;
			}

			const height = word.ink || (word.bbox ? word.bbox.y1 - word.bbox.y0 : 0);

			words.push({confidence: word.confidence || 0, height, line: index, text, x: word.bbox ? word.bbox.x0 : 0});
		}
	}

	const cjk = words.filter((word) => hasCjk(word.text));
	const tallest = Math.max(0, ...cjk.map((word) => word.height));
	const kept = cjk.filter((word) => !tallest || !word.height || word.height >= tallest * 0.62)
		.filter((word) => !NOT_NAME.has(cjkKey(word.text)));

	if (!kept.length) {
		return {confidence: 0, script: null, suffix: null, text: ''};
	}

	// The suffix: Latin letters right after the name, on its line.
	const nameLine = kept[0].line;
	const lastX = Math.max(...kept.map((word) => word.x));
	const after = words.filter((word) => word.line === nameLine && word.x > lastX && SUFFIX.test(word.text.replace(/[^A-Za-z.]/gu, '')));
	const glued = /([A-Za-z]{1,5})$/u.exec(kept[kept.length - 1].text);
	const suffixText = after.length ? after[0].text.replace(/[^A-Za-z.]/gu, '') : glued && SUFFIX.test(glued[1]) ? glued[1] : null;
	const text = kept.map((word) => word.text.replace(/[^\p{L}\p{N}ー・♀♂]/gu, '')).join('').replace(/[A-Za-z0-9]+$/u, '').replace(/^[A-Za-z0-9]+/u, '');
	const confidence = Math.round(kept.reduce((sum, word) => sum + word.confidence, 0) / kept.length) / 100;

	return {confidence, script: scriptOf(text), suffix: suffixText ? suffixText.toLowerCase().replace(/\./gu, '') : null, text};
}

// ------------------------------------------------------------ the strip's shapes

// Whether a line of the name strip looks like kana, kanji, or Hangul rather
// than Latin letters, from its shapes alone, before any model is loaded.
// `line` is a grey crop (R = G = B), dark print on light or light on dark,
// the way read.js prepares a strip and cuts its lines (findTextLines,
// cropRows), about TEXT_PX tall in print.
//
// The print is split into glyphs at the columns with no ink, and each
// glyph's ink measured. A Latin name is mostly lower-case letters, a little
// over half the height of its capitals and tall letters, and each fills
// much of its narrow box; a kana, kanji, or Hangul syllable fills the whole
// square with thin strokes and the space between them. So the line is CJK
// when its typical glyph is nearly as tall as its tall glyphs (`tall`, the
// median glyph height over the 85th percentile, CJK_TALL), not too narrow
// (`wide`, the median width over that height, CJK_WIDE: a Hangul syllable
// often splits in two at the gap between its consonant and its vowel), and
// its boxes are mostly ground (`fill`, the median share of ink in a glyph's
// box, at most CJK_FILL). Measured on the name lines of the lab benchmark's
// captures (lab/bench, 129 Japanese and Korean lines, 87 Latin ones, four
// captures each): 68 % of the Japanese and Korean lines pass, 10 % of the
// Latin ones. It is only asked once the English read named nothing (wantsCjk),
// which a Latin card's read seldom does. Returns {cjk, tall, wide, fill,
// holes, glyphs}; holes is closed loops per glyph (countHoles).
export const CJK_TALL = 0.75;
export const CJK_WIDE = 0.5;
export const CJK_FILL = 0.58;

export function looksCjk(line, {dark = 128} = {}) {
	const {data, height, width} = line || {};

	if (!width || !height) {
		return {cjk: false, fill: 0, glyphs: 0, holes: 0, tall: 0, wide: 0};
	}

	// Light print on a dark ground (a strip read.js could not turn dark on
	// light) is measured the other way round: ink is the minority side.
	const light = medianGrey(line) < dark;
	const inkAt = light ? (x, y) => data[(y * width + x) * 4] >= 255 - dark : (x, y) => data[(y * width + x) * 4] < dark;
	const columns = new Int32Array(width);

	for (let x = 0; x < width; x++) {
		for (let y = 0; y < height; y++) {
			if (inkAt(x, y)) {
				columns[x]++;
			}
		}
	}

	// A column counts as ink with at least two dark pixels, so a speck or a
	// stray line along the crop's edge does not join two glyphs.
	const glyphs = [];
	let start = -1;

	for (let x = 0; x <= width; x++) {
		const on = x < width && columns[x] >= 2;

		if (on && start < 0) {
			start = x;
		}
		else if (!on && start >= 0) {
			let top = height;
			let bottom = -1;

			for (let y = 0; y < height; y++) {
				for (let xx = start; xx < x; xx++) {
					if (inkAt(xx, y)) {
						top = Math.min(top, y);
						bottom = Math.max(bottom, y);
						break;
					}
				}
			}

			if (bottom >= top) {
				glyphs.push({h: bottom - top + 1, w: x - start, x0: start, x1: x, y0: top, y1: bottom});
			}

			start = -1;
		}
	}

	// Specks and the strokes of a glyph cut in two are left out by height;
	// a run as wide as several glyphs (letters touching, an underline) by
	// width.
	const heights = glyphs.map((glyph) => glyph.h).sort((a, b) => a - b);
	const top = heights.length ? heights[Math.min(heights.length - 1, Math.floor(heights.length * 0.85))] : 0;
	const real = glyphs.filter((glyph) => glyph.h >= top * 0.3 && glyph.w <= top * 2.2);

	if (real.length < 2 || top < 6) {
		return {cjk: false, fill: 0, glyphs: real.length, holes: 0, tall: 0, wide: 0};
	}

	const median = (list) => {
		const sorted = [...list].sort((a, b) => a - b);

		return sorted[Math.floor(sorted.length / 2)];
	};
	const tall = Math.round((median(real.map((glyph) => glyph.h)) / top) * 100) / 100;
	const wide = Math.round((median(real.map((glyph) => glyph.w)) / top) * 100) / 100;
	const fill = Math.round(median(real.map((glyph) => {
		let ink = 0;

		for (let y = glyph.y0; y <= glyph.y1; y++) {
			for (let x = glyph.x0; x < glyph.x1; x++) {
				ink += inkAt(x, y) ? 1 : 0;
			}
		}

		return ink / (glyph.w * glyph.h);
	})) * 100) / 100;
	const holes = Math.round((countHoles(inkAt, width, height, top) / real.length) * 100) / 100;

	return {cjk: tall >= CJK_TALL && wide >= CJK_WIDE && fill <= CJK_FILL, fill, glyphs: real.length, holes, tall, wide};
}

// The closed loops of the print: patches of ground that cannot reach the
// crop's edge without crossing ink (4-way), at least a hundredth of a glyph's
// square. Hangul is full of them (ㅇ, ㅁ, ㅂ, ㅍ, ㅎ: 이상해씨 has three in four
// syllables); katakana has almost none (ロ is the common one), so loops per
// glyph say which model to try first when nothing else does.
function countHoles(inkAt, width, height, glyph) {
	const seen = new Uint8Array(width * height);
	const stack = [];
	const min = Math.max(3, glyph * glyph * 0.01);
	let holes = 0;

	const fill = (start) => {
		let area = 0;
		let edge = false;

		seen[start] = 1;
		stack.push(start);

		while (stack.length) {
			const i = stack.pop();
			const x = i % width;
			const y = (i - x) / width;

			area++;

			if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
				edge = true;
			}

			for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1]) {
				if (j >= 0 && !seen[j] && !inkAt(j % width, (j - (j % width)) / width)) {
					seen[j] = 1;
					stack.push(j);
				}
			}
		}

		return {area, edge};
	};

	for (let i = 0; i < width * height; i++) {
		if (!seen[i] && !inkAt(i % width, (i - (i % width)) / width)) {
			const {area, edge} = fill(i);

			if (!edge && area >= min) {
				holes++;
			}
		}
	}

	return holes;
}

// Loops per glyph from which a strip is taken for Hangul rather than kana,
// when no language is known (wantsCjk).
export const HANGUL_HOLES = 0.3;

// The median grey of a grey crop (R = G = B).
export function medianGrey(crop) {
	const histogram = new Uint32Array(256);
	const pixels = crop.width * crop.height;

	for (let i = 0; i < pixels; i++) {
		histogram[crop.data[i * 4]]++;
	}

	let seen = 0;

	for (let v = 0; v < 256; v++) {
		seen += histogram[v];

		if (seen >= pixels / 2) {
			return v;
		}
	}

	return 255;
}

// ------------------------------------------------------------ when to load a model

// Whether to read the name strip with the Japanese or Korean model, and
// which first. `cjk` is the read's {language, guess, lean} (read.js
// options, from js/scan/view.js): language 'ja' or 'ko' when the card is
// known to be one (picked by hand, or Set for all), guess the language to
// try first otherwise (the last Asian language picked in Scan, Korean
// before any), lean true when the last language picked of all was Japanese
// or Korean, so a strip the English model reads no name off is read with
// that model without its shapes being asked. `latin` is the English read of
// the strip (evidence.js parseName), null when it was not read; `shapes`
// looksCjk's answer for the strip's tallest line, null when not measured.
//
// A label row with no Latin label is not a reason on its own: Energy and
// Trainer cards have no weakness row at all, so every one of them would
// load a model (review of version 56's first draft: a perfect "Fire
// Energy" read was read again in Korean and Japanese). A Latin label does
// still veto the models (read.js readName).
//
// `models`, when given, says which models the reader holds ({ja, ko}, each
// 'held', 'ready', or null; js/scan/ocr.js createAsianReader state): with
// no language known, a model that is not loaded is never waited for. It is
// left out of the plan and returned as `prepare`, to load behind the scan
// for the next card. When the shapes do not say which script it is, the
// model already held is tried first, then one loaded before, then the last
// Asian pick, so an unclear card does not switch the model twice.
//
// Returns {read: false} or {read: true, first, then, skipLatin}: first the
// model's language to read with, then the other one to try when the first
// reads no name (null when the language is known, or the other is not
// loaded), skipLatin when the English read is not worth making at all;
// and, with `models`, prepare: the language to load behind, when there is
// one.
//
// A Latin read is plausible when it names a known Pokémon or Trainer this
// well (`latinScore`, the best evidence.js matchNames score against the
// Western names, js/scan/local-names.js latinNameScore), or, with no table
// to ask, when it has three Latin letters in a row read with
// LATIN_PLAUSIBLE confidence; and always when it is an Energy's name. The
// Western table holds no Energy (lab/names/build.mjs keeps Pokémon and
// Trainers), so "Fire Energy" scored 0.66 there and "Darkness Energy" 0.74,
// under LATIN_NAMED: a word one letter or less from "Energy" (Energia,
// Énergie, Energie, Energía) in the read makes it plausible, a basic or a
// special Energy alike.
export const LATIN_NAMED = 0.75;
export const LATIN_PLAUSIBLE = 0.55;

const ENERGY_WORDS = ['energy', 'energia', 'energie'];

export function energyName(text) {
	const words = String(text || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[^a-z]+/u);

	return words.some((word) => word.length >= 5 && ENERGY_WORDS.some((energy) => editDistance(word, energy) <= 1));
}

export function plausibleLatin(latin, latinScore = null) {
	if (!(latin && latin.text && /\p{Script=Latin}{3,}/u.test(latin.text))) {
		return false;
	}

	if (energyName(latin.text)) {
		return true;
	}

	return typeof latinScore === 'number' ? latinScore >= LATIN_NAMED : latin.confidence >= LATIN_PLAUSIBLE;
}

const otherOf = (lang) => (lang === 'ja' ? 'ko' : 'ja');

export function wantsCjk(cjk, latin = null, shapes = null, latinScore = null, models = null) {
	const known = cjk && ASIAN_NAME_LANGUAGES.includes(cjk.language) ? cjk.language : null;

	if (known) {
		return {first: known, read: true, skipLatin: true, then: null};
	}

	if (!cjk || cjk.off) {
		return {read: false};
	}

	if (plausibleLatin(latin, latinScore) || !((shapes && shapes.cjk) || cjk.lean)) {
		return {read: false};
	}

	// The first model: the strip's loops when they say (Hangul is full of
	// them, katakana nearly bare), else the model held, else the last Asian
	// language picked.
	const byShape = shapes && shapes.glyphs >= 2 ? (shapes.holes >= HANGUL_HOLES ? 'ko' : shapes.holes <= 0.1 ? 'ja' : null) : null;
	const guess = ASIAN_NAME_LANGUAGES.includes(cjk.guess) ? cjk.guess : 'ko';
	const rank = (lang) => (models ? {held: 2, ready: 1}[models[lang]] || 0 : 0);
	const first = byShape || (rank(otherOf(guess)) > rank(guess) ? otherOf(guess) : guess);

	if (!models) {
		return {first, read: true, skipLatin: false, then: otherOf(first)};
	}

	const order = [first, otherOf(first)].filter((lang) => models[lang]);
	const prepare = models[first] ? null : first;

	if (!order.length) {
		return {prepare, read: false};
	}

	return {first: order[0], read: true, skipLatin: false, then: order[1] || null, ...(prepare ? {prepare} : {})};
}
