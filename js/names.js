// English names for Japanese, Korean, and Chinese prints, and a reading of
// the original name (DESIGN.md section 5, "English names for Asian prints,
// original name underneath", "Romanization in parentheses", and "Where the
// names come from").
//
// No DOM and no network here, so Node can test it (tests/names.test.mjs).
// The species names come from PokeAPI through js/checklists.js
// (speciesNames), as tables indexed by National Dex number:
//   {en, ja, 'ja-roma', ko, 'zh-hans', 'zh-hant'}
//
// An English name is given only when it is found: a Pokémon whose name,
// once its mechanic suffix and any known prefix are taken off, is a species
// name in that language. Trainers and Energy get none (no guessing), and so
// does a Pokémon with a prefix this module does not know ("Nの").

// The PokeAPI language each catalog's names are written in.
export const NAME_LANGUAGE = {ja: 'ja', ko: 'ko', 'zh-cn': 'zh-hans', 'zh-tw': 'zh-hant'};

export const hasOwnNames = (lang) => Object.hasOwn(NAME_LANGUAGE, lang);

// ------------------------------------------------------------ suffixes

// Mechanic suffixes, longest first, as TCGdex writes them after the name:
// "プテラVSTAR", "히트로토무 ex", "MリザードンEX".
const SUFFIXES = ['V-UNION', 'VSTAR', 'VMAX', 'BREAK', 'GX', 'EX', 'Ex', 'ex', 'V'];

const LATIN = /[A-Za-z0-9]/;

// {base, suffix}: the suffix only when it stands apart from the name, after
// a space or right after a character that is not a Latin letter or digit, so
// "Vileplume" or a Latin name ending in V keeps its letters.
export function stripSuffix(name) {
	const text = String(name || '').trim();

	for (const suffix of SUFFIXES) {
		if (!text.endsWith(suffix)) {
			continue;
		}

		const rest = text.slice(0, -suffix.length);
		const before = rest.slice(-1);

		// A Mega's X or Y may sit right before it: "メガリザードンXex".
		const megaForm = /[^A-Za-z0-9\s][XY]$/.test(rest.normalize('NFKC'));

		if (!rest.trim() || (LATIN.test(before.normalize('NFKC')) && !megaForm)) {
			continue;
		}

		// TCGdex writes the EX era's lowercase "ex" as "Ex" on some Japanese
		// records; English cards write it "ex".
		return {base: rest.trim(), suffix: suffix === 'Ex' ? 'ex' : suffix};
	}

	return {base: text, suffix: null};
}

// ------------------------------------------------------------ prefixes

// Prefixes written before a species name, with or without a space, and
// their English form. Checked 2026-10-01 against TCGdex card names and
// PokeAPI form names, except where marked unconfirmed (no card or form name
// carried them; a wrong one only fails to match, it never names a card).
const PREFIXES = {
	ja: [
		['かがやく', 'Radiant'],
		['ロケット団の', 'Team Rocket\'s'],
		['アローラ', 'Alolan'],
		['ガラル', 'Galarian'],
		['ヒスイ', 'Hisuian'],
		['パルデア', 'Paldean'],
		['メガ', 'Mega'],
	],
	ko: [
		['빛나는', 'Radiant'], // unconfirmed
		['로켓단의', 'Team Rocket\'s'], // unconfirmed
		['알로라', 'Alolan'],
		['가라르', 'Galarian'],
		['히스이', 'Hisuian'], // unconfirmed
		['팔데아', 'Paldean'], // unconfirmed
		['메가', 'Mega'],
	],
	'zh-hans': [
		['光辉', 'Radiant'],
		['火箭队的', 'Team Rocket\'s'],
		['阿罗拉', 'Alolan'],
		['伽勒尔', 'Galarian'],
		['洗翠', 'Hisuian'],
		['帕底亚', 'Paldean'],
		['超级', 'Mega'],
	],
	'zh-hant': [
		['光輝', 'Radiant'],
		['火箭隊的', 'Team Rocket\'s'],
		['阿羅拉', 'Alolan'],
		['伽勒爾', 'Galarian'],
		['洗翠', 'Hisuian'],
		['帕底亞', 'Paldean'],
		['超級', 'Mega'],
	],
};

// Rotom's appliance forms are names of their own, not prefixes, so they are
// matched whole (PokeAPI form names, 2026-10-01).
const ROTOM = 479;

const FORMS = [
	{en: 'Heat Rotom', ja: 'ヒートロトム', ko: '히트로토무', 'zh-hans': '加热洛托姆', 'zh-hant': '加熱洛托姆'},
	{en: 'Wash Rotom', ja: 'ウォッシュロトム', ko: '워시로토무', 'zh-hans': '清洗洛托姆', 'zh-hant': '清洗洛托姆'},
	{en: 'Frost Rotom', ja: 'フロストロトム', ko: '프로스트로토무', 'zh-hans': '结冰洛托姆', 'zh-hant': '結冰洛托姆'},
	{en: 'Fan Rotom', ja: 'スピンロトム', ko: '스핀로토무', 'zh-hans': '旋转洛托姆', 'zh-hant': '旋轉洛托姆'},
	{en: 'Mow Rotom', ja: 'カットロトム', ko: '커트로토무', 'zh-hans': '切割洛托姆', 'zh-hant': '切割洛托姆'},
];

// ------------------------------------------------------- name lookup

// Compared without width, case, spaces, or middle dots: "メガリザードンＸ"
// and "메가 리자몽" match their plain forms.
const norm = (text) => String(text).normalize('NFKC').replace(/[\s・·]/g, '').toLowerCase();

const reverse = new WeakMap();

// Map normalized name -> dex number, for one language of the tables.
function byName(tables, language) {
	let maps = reverse.get(tables);

	if (!maps) {
		maps = {};
		reverse.set(tables, maps);
	}

	if (!maps[language]) {
		const map = new Map();
		const names = tables[language] || [];

		for (let n = 1; n < names.length; n++) {
			if (names[n] && !map.has(norm(names[n]))) {
				map.set(norm(names[n]), n);
			}
		}

		maps[language] = map;
	}

	return maps[language];
}

// PokeAPI writes Farfetch’d with a curly apostrophe; English cards (and Liga)
// use the straight one.
const englishSpecies = (tables, n) => (tables.en && tables.en[n] ? tables.en[n].replace(/’/g, '\'') : null);

// One Pokémon's name, with no suffix: {n, english, reading} or null.
// reading is the official ja-roma name, for Japanese only.
function resolveOne(text, language, tables, dexIds) {
	const key = norm(text);

	if (!key) {
		return null;
	}

	for (const form of FORMS) {
		if (form[language] && norm(form[language]) === key && (!dexIds.length || dexIds.includes(ROTOM))) {
			return {english: form.en, n: ROTOM, reading: null};
		}
	}

	const n = byName(tables, language).get(key);

	if (n && englishSpecies(tables, n) && (!dexIds.length || dexIds.includes(n))) {
		return {english: englishSpecies(tables, n), n, reading: (language === 'ja' && tables['ja-roma'] && tables['ja-roma'][n]) || null};
	}

	return null;
}

// A name with no suffix: tried whole first, so a species that starts like a
// prefix (メガニウム, Meganium) is found as itself, then with known prefixes
// taken off. A Mega's X or Y stays at the end ("メガリザードンX"). Returns
// {english, prefixes: [local, ...], reading} or null.
function resolveBase(base, language, tables, dexIds, depth = 0) {
	const whole = resolveOne(base, language, tables, dexIds);

	if (whole) {
		return {english: whole.english, prefixes: [], reading: whole.reading};
	}

	if (depth >= 2) {
		return null;
	}

	for (const [local, english] of PREFIXES[language] || []) {
		if (!base.startsWith(local)) {
			continue;
		}

		let rest = base.slice(local.length).trim();
		let form = null;

		if (english === 'Mega') {
			const xy = /^(.*?)\s*([XYＸＹ])$/.exec(rest);

			if (xy && !resolveOne(rest, language, tables, dexIds)) {
				rest = xy[1];
				form = xy[2].normalize('NFKC');
			}
		}

		const inner = resolveBase(rest, language, tables, dexIds, depth + 1);

		if (inner) {
			return {
				english: [english, inner.english, form].filter(Boolean).join(' '),
				prefixes: [local, ...inner.prefixes],
				reading: inner.reading === null ? null : [inner.reading, form].filter(Boolean).join(' '),
			};
		}
	}

	return null;
}

// The English name of a Japanese, Korean, or Chinese Pokémon card, or null.
//   name      the name as printed ("プテラVSTAR", "히트로토무 ex")
//   lang      the language it is written in: ja, ko, zh-cn, zh-tw
//   dexId     the card's National Dex numbers, when the record has them; a
//             name must then be one of those species
//   category  TCGdex's Pokemon, Trainer, or Energy, when known
// Returns {english, prefixes, reading, suffix} or null, where reading is the
// ja-roma name with its prefixes and suffix still to be added.
export function resolvePokemon({category = null, dexId = null, lang, name}, tables) {
	const language = NAME_LANGUAGE[lang];

	if (!language || !tables || !tables[language] || !name) {
		return null;
	}

	if (category && category !== 'Pokemon') {
		return null;
	}

	const dexIds = Array.isArray(dexId) ? dexId.filter(Number.isInteger) : [];
	const {base, suffix} = stripSuffix(name);

	// "XY-era Mega": "MリザードンEX" is "M Charizard EX" in English.
	if (lang === 'ja' && suffix === 'EX' && /^M[^A-Za-z]/.test(base)) {
		const inner = resolveBase(base.slice(1), language, tables, dexIds);

		if (inner) {
			return {english: `M ${inner.english} EX`, prefixes: ['M', ...inner.prefixes], reading: inner.reading, suffix};
		}
	}

	// TAG TEAM cards: "ピカチュウ&ゼクロムGX" is "Pikachu & Zekrom GX".
	const parts = base.split(/\s*[&＆]\s*/);
	const resolved = [];

	for (const part of parts) {
		const one = resolveBase(part, language, tables, dexIds);

		if (!one) {
			return null;
		}

		resolved.push(one);
	}

	const english = [resolved.map((one) => one.english).join(' & '), suffix].filter(Boolean).join(' ');

	if (resolved.length === 1) {
		return {english, prefixes: resolved[0].prefixes, reading: resolved[0].reading, suffix};
	}

	// A prefix inside a TAG TEAM name has no clear place in the reading.
	const plain = resolved.every((one) => one.reading !== null && !one.prefixes.length);

	return {english, prefixes: [], reading: plain ? resolved.map((one) => one.reading).join(' & ') : null, suffix};
}

// --------------------------------------------- Korean: Revised Romanization
//
// The Revised Romanization of Korea (Ministry of Culture and Tourism notice
// 2000-8), computed from the Hangul syllables: each syllable splits into its
// initial, medial, and final jamo (Unicode arithmetic), each is written from
// the standard tables, and the sound changes between syllables of one word
// that the system writes are applied: a final carried over to a following
// vowel, nasalization before ㄴ and ㅁ, ㄹ after ㄴ or ㄹ written ll, ㄹ
// read as ㄴ after other finals, ㅎ joining a following ㄱ, ㄷ, or ㅈ, and
// ㄷ or ㅌ before 이 read as ㅈ or ㅊ. Not applied: tensing (never written)
// and the added ㄴ of compounds (학여울), which needs a dictionary.

const SYLLABLE_FIRST = 0xac00;
const SYLLABLE_LAST = 0xd7a3;

const INITIALS = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
const MEDIALS = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];

// Finals by index (0 is none), as written at the end of a syllable.
const FINALS = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'l', 'l', 'l', 'p', 'l', 'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't'];

// Initial indices.
const I = {b: 7, ch: 14, d: 3, g: 0, h: 18, j: 12, k: 15, kk: 1, l: 5, m: 6, n: 2, none: 11, p: 17, s: 9, ss: 10, t: 16};

// Final indices.
const F = {b: 17, bs: 18, ch: 23, d: 7, g: 1, gg: 2, gs: 3, h: 27, j: 22, k: 24, l: 8, lb: 11, lg: 9, lh: 15, lm: 10, lp: 14, ls: 12, lt: 13, m: 16, n: 4, ng: 21, nh: 6, nj: 5, none: 0, p: 26, s: 19, ss: 20, t: 25};

// A final carried over to the next syllable's empty initial: [what stays,
// what moves]. ㅎ is silent before a vowel.
const CARRY = {
	[F.g]: [F.none, I.g], [F.gg]: [F.none, I.kk], [F.gs]: [F.g, I.s], [F.n]: [F.none, I.n], [F.nj]: [F.n, I.j],
	[F.nh]: [F.n, I.none], [F.d]: [F.none, I.d], [F.l]: [F.none, I.l], [F.lg]: [F.l, I.g], [F.lm]: [F.l, I.m],
	[F.lb]: [F.l, I.b], [F.ls]: [F.l, I.s], [F.lt]: [F.l, I.t], [F.lp]: [F.l, I.p], [F.lh]: [F.l, I.none],
	[F.m]: [F.none, I.m], [F.b]: [F.none, I.b], [F.bs]: [F.b, I.s], [F.s]: [F.none, I.s], [F.ss]: [F.none, I.ss],
	[F.j]: [F.none, I.j], [F.ch]: [F.none, I.ch], [F.k]: [F.none, I.k], [F.t]: [F.none, I.t], [F.p]: [F.none, I.p],
	[F.h]: [F.none, I.none],
};

const K_CLASS = new Set([F.g, F.gg, F.k, F.gs, F.lg]);
const T_CLASS = new Set([F.d, F.s, F.ss, F.j, F.ch, F.t, F.h]);
const P_CLASS = new Set([F.b, F.p, F.bs, F.lp]);

const MEDIAL_I = 20;

const isSyllable = (code) => code >= SYLLABLE_FIRST && code <= SYLLABLE_LAST;

function decompose(char) {
	const index = char.codePointAt(0) - SYLLABLE_FIRST;

	return {final: index % 28, initial: Math.floor(index / 588), medial: Math.floor((index % 588) / 28)};
}

// One run of Hangul syllables with no break between them.
function romanizeWord(syllables) {
	const s = syllables.map(decompose);
	// lAfterL[i]: syllable i's initial ㄹ follows a final ㄹ, so it is "l".
	const lAfterL = s.map(() => false);

	for (let i = 0; i < s.length - 1; i++) {
		const a = s[i];
		const b = s[i + 1];

		if (b.initial === I.none) {
			if (a.final !== F.none && a.final !== F.ng) {
				const [stay, move] = CARRY[a.final];

				a.final = stay;
				b.initial = move;

				// 같이 gachi, 해돋이 haedoji.
				if (b.medial === MEDIAL_I && move === I.d) {
					b.initial = I.j;
				}
				else if (b.medial === MEDIAL_I && move === I.t) {
					b.initial = I.ch;
				}
			}

			continue;
		}

		// 좋고 joko, 놓다 nota.
		if ([F.h, F.nh, F.lh].includes(a.final) && [I.g, I.d, I.j].includes(b.initial)) {
			b.initial = {[I.g]: I.k, [I.d]: I.t, [I.j]: I.ch}[b.initial];
			a.final = a.final === F.h ? F.none : a.final === F.nh ? F.n : F.l;

			continue;
		}

		if (b.initial === I.l) {
			if (a.final === F.n || a.final === F.l) {
				// 신라 Silla, 한라산 Hallasan.
				a.final = F.l;
				lAfterL[i + 1] = true;
			}
			else if (a.final === F.m || a.final === F.ng) {
				// 종로 Jongno, 심리 simni.
				b.initial = I.n;
			}
			else if (K_CLASS.has(a.final)) {
				// 백리 baengni.
				a.final = F.ng;
				b.initial = I.n;
			}
			else if (P_CLASS.has(a.final)) {
				// 협력 hyeomnyeok.
				a.final = F.m;
				b.initial = I.n;
			}

			continue;
		}

		if (b.initial === I.n && a.final === F.l) {
			// 별내 Byeollae.
			b.initial = I.l;
			lAfterL[i + 1] = true;

			continue;
		}

		if (b.initial === I.n || b.initial === I.m) {
			// 백마 Baengma, 신문로 Sinmunno, 합니다 hamnida.
			if (K_CLASS.has(a.final)) {
				a.final = F.ng;
			}
			else if (T_CLASS.has(a.final)) {
				a.final = F.n;
			}
			else if (P_CLASS.has(a.final)) {
				a.final = F.m;
			}
		}
	}

	return s.map((syllable, i) => {
		const initial = syllable.initial === I.l && lAfterL[i] ? 'l' : INITIALS[syllable.initial];

		return initial + MEDIALS[syllable.medial] + FINALS[syllable.final];
	}).join('');
}

// Characters a reading keeps as they are. Anything else (Hanja, kana, a
// lone jamo) means no reading at all, never a partial one.
const KEEP = /[A-Za-z0-9 &+\-.'!?♀♂():/,]/;

const capitalize = (word) => word.charAt(0).toUpperCase() + word.slice(1);

// Splits text into runs of one script, converts the runs `convert` handles,
// keeps the rest, and spaces a converted run from Latin letters next to it:
// "프테라VSTAR" reads "Peutera VSTAR".
function readRuns(text, isScript, convert) {
	const source = String(text || '').normalize('NFKC').replace(/・/g, ' ');

	if (!source.trim()) {
		return null;
	}

	const runs = [];

	for (const char of source) {
		const script = isScript(char);

		if (!script && !KEEP.test(char)) {
			return null;
		}

		const last = runs[runs.length - 1];

		if (last && last.script === script) {
			last.text += char;
		}
		else {
			runs.push({script, text: char});
		}
	}

	if (!runs.some((run) => run.script)) {
		return null;
	}

	let out = '';
	let previous = null;

	for (const run of runs) {
		if (run.script) {
			const converted = convert(run.text);

			if (converted === null) {
				return null;
			}

			out += (previous === 'latin' ? ' ' : '') + capitalize(converted);
			previous = 'script';
		}
		else {
			out += (previous === 'script' && /^[A-Za-z0-9]/.test(run.text) ? ' ' : '') + run.text;
			previous = /[A-Za-z0-9]$/.test(run.text) ? 'latin' : 'other';
		}
	}

	// "Pung&ranui" reads "Pung & Ranui".
	return out.replace(/\s*&\s*/g, ' & ').replace(/\s+/g, ' ').trim();
}

// "프테라" -> "Peutera", or null when any character cannot be read.
export const romanizeKorean = (text) => readRuns(text, (char) => isSyllable(char.codePointAt(0)), (run) => romanizeWord([...run]));

// ------------------------------------------------- Japanese: Hepburn kana
//
// Modified Hepburn for kana, on the device. A long-vowel mark lengthens the
// vowel before it with a macron (リザードン Rizādon), a small ッ doubles the
// next consonant, and ン is n (n' before a vowel or y). Hiragana is read as
// katakana. Any kanji means no reading.

const KANA = {
	ア: 'a', イ: 'i', ウ: 'u', エ: 'e', オ: 'o',
	カ: 'ka', キ: 'ki', ク: 'ku', ケ: 'ke', コ: 'ko',
	ガ: 'ga', ギ: 'gi', グ: 'gu', ゲ: 'ge', ゴ: 'go',
	サ: 'sa', シ: 'shi', ス: 'su', セ: 'se', ソ: 'so',
	ザ: 'za', ジ: 'ji', ズ: 'zu', ゼ: 'ze', ゾ: 'zo',
	タ: 'ta', チ: 'chi', ツ: 'tsu', テ: 'te', ト: 'to',
	ダ: 'da', ヂ: 'ji', ヅ: 'zu', デ: 'de', ド: 'do',
	ナ: 'na', ニ: 'ni', ヌ: 'nu', ネ: 'ne', ノ: 'no',
	ハ: 'ha', ヒ: 'hi', フ: 'fu', ヘ: 'he', ホ: 'ho',
	バ: 'ba', ビ: 'bi', ブ: 'bu', ベ: 'be', ボ: 'bo',
	パ: 'pa', ピ: 'pi', プ: 'pu', ペ: 'pe', ポ: 'po',
	マ: 'ma', ミ: 'mi', ム: 'mu', メ: 'me', モ: 'mo',
	ヤ: 'ya', ユ: 'yu', ヨ: 'yo',
	ラ: 'ra', リ: 'ri', ル: 'ru', レ: 're', ロ: 'ro',
	ワ: 'wa', ヰ: 'i', ヱ: 'e', ヲ: 'o', ヴ: 'vu',
	ァ: 'a', ィ: 'i', ゥ: 'u', ェ: 'e', ォ: 'o', ャ: 'ya', ュ: 'yu', ョ: 'yo', ヮ: 'wa', ヵ: 'ka', ヶ: 'ke',
};

const SMALL_Y = {ャ: 'a', ュ: 'u', ョ: 'o'};
const SMALL_VOWEL = {ァ: 'a', ィ: 'i', ゥ: 'u', ェ: 'e', ォ: 'o'};
const MACRON = {a: 'ā', e: 'ē', i: 'ī', o: 'ō', u: 'ū'};

// Hiragana to katakana: the two blocks are 0x60 apart.
const toKatakana = (char) => {
	const code = char.codePointAt(0);

	return code >= 0x3041 && code <= 0x3096 ? String.fromCodePoint(code + 0x60) : char;
};

const isKana = (char) => {
	const code = toKatakana(char).codePointAt(0);

	return (code >= 0x30a1 && code <= 0x30fa) || code === 0x30fc;
};

// Romaji for one kana with what follows it: [romaji, kana used].
function kanaUnit(chars, i) {
	const char = chars[i];
	const next = chars[i + 1];
	const base = KANA[char];

	if (!base) {
		return null;
	}

	if (next && SMALL_Y[next] && !SMALL_Y[char]) {
		// キャ kya, シャ sha, チュ chu, ジョ jo, テュ tyu, フュ fyu.
		const stem = /^(sh|ch|j)i$/.test(base) ? base.slice(0, -1) : `${base.slice(0, -1)}y`;

		return [stem + SMALL_Y[next], 2];
	}

	if (next && SMALL_VOWEL[next] && !SMALL_VOWEL[char] && !SMALL_Y[char]) {
		// ファ fa, ティ ti, シェ she, ウィ wi, イェ ye, ヴァ va, ツァ tsa.
		const vowel = SMALL_VOWEL[next];
		let stem;

		if (base === 'u') {
			stem = 'w';
		}
		else if (base === 'i') {
			stem = 'y';
		}
		else if (base === 'vu') {
			stem = 'v';
		}
		else if (/^(sh|ch|j)i$/.test(base)) {
			stem = base.slice(0, -1);
		}
		else if (base === 'tsu') {
			stem = 'ts';
		}
		else {
			stem = base.slice(0, -1);
		}

		return [stem + vowel, 2];
	}

	return [base, 1];
}

function hepburnRun(run) {
	const chars = [...run].map(toKatakana);
	let out = '';
	let double = false;

	for (let i = 0; i < chars.length;) {
		const char = chars[i];

		if (char === 'ッ') {
			double = true;
			i++;
			continue;
		}

		if (char === 'ー') {
			const last = out.slice(-1);

			if (!MACRON[last]) {
				return null;
			}

			out = out.slice(0, -1) + MACRON[last];
			i++;
			continue;
		}

		if (char === 'ン') {
			const unit = chars[i + 1] ? kanaUnit(chars, i + 1) : null;

			out += unit && /^[aeiouy]/.test(unit[0]) ? 'n\'' : 'n';
			i++;
			continue;
		}

		const unit = kanaUnit(chars, i);

		if (!unit) {
			return null;
		}

		let [romaji] = unit;

		if (double) {
			romaji = (romaji.startsWith('ch') ? 't' : /^[aeiou]/.test(romaji) ? '' : romaji.charAt(0)) + romaji;
			double = false;
		}

		out += romaji;
		i += unit[1];
	}

	return out;
}

// "プテラ" -> "Putera", or null when the name holds kanji or anything else
// that is not kana.
export const hepburn = (text) => readRuns(text, isKana, hepburnRun);

// ------------------------------------------------------------- together

const hasScript = (text) => /[^\x00-\x7f♀♂’]/.test(String(text || '').normalize('NFKC'));

// What a card shows: {english, original, reading}.
//   english   the English name, or null when none was found
//   original  the name as printed
//   reading   a romanization of the original, or null (always null for
//             Chinese for now: pinyin needs a vendored library, DESIGN.md
//             section 5)
// tables may be null while the species names are still loading; Korean
// readings need no tables, and Japanese ones wait for them, so a Pokémon
// never shows a kana reading that turns into PokeAPI's a moment later.
export function cardNames({category = null, dexId = null, lang, name}, tables) {
	const original = String(name || '');

	if (!hasOwnNames(lang) || !hasScript(original)) {
		return {english: null, original, reading: null};
	}

	const found = tables ? resolvePokemon({category, dexId, lang, name: original}, tables) : null;
	let reading = null;

	if (lang === 'ko') {
		reading = romanizeKorean(original);
	}
	else if (lang === 'ja') {
		if (found) {
			// PokeAPI's ja-roma name ("Ptera"), with any kana prefix read in
			// Hepburn ("Mega"); a prefix in kanji (ロケット団の) means none.
			const prefixes = found.prefixes.map((prefix) => (prefix === 'M' ? 'M' : hepburn(prefix)));

			reading = found.reading !== null && prefixes.every((prefix) => prefix !== null)
				? [...prefixes, found.reading, found.suffix].filter(Boolean).join(' ')
				: null;
		}
		else if ((tables && tables.ja) || (category && category !== 'Pokemon')) {
			reading = hepburn(original);
		}
	}

	return {english: found ? found.english : null, original, reading};
}

// --------------------------------------------------------------- search

// Lowercase, without accents or macrons, and without spaces, so "ryuu",
// "Rizadon", and "리자 몽" find what they mean.
export const searchKey = (text) => String(text || '')
	.normalize('NFKD')
	.replace(/[̀-ͯ]/g, '')
	.normalize('NFKC')
	.toLowerCase()
	.replace(/[\s・·]/g, '');

// Everything a species can be searched by: its English name and its names
// and readings in the other languages the tables hold.
export function speciesSearchTerms(tables, n) {
	if (!tables) {
		return [];
	}

	const terms = [];

	for (const language of ['en', 'ja', 'ja-roma', 'ko', 'zh-hans', 'zh-hant']) {
		const name = tables[language] && tables[language][n];

		if (name) {
			terms.push(name);
		}
	}

	const korean = tables.ko && tables.ko[n] ? romanizeKorean(tables.ko[n]) : null;

	if (korean) {
		terms.push(korean);
	}

	return [...new Set(terms.map(searchKey))];
}

// Every text a card can be found by: original, English, and reading.
export const cardSearchTerms = ({english, original, reading}) => [original, english, reading].filter(Boolean).map(searchKey);
