// Weighing what a read found: the card name, HP, collector number, set
// total, set code, copyright line, and attack names, each against each
// catalog card that could be the one scanned. Pure functions, no DOM and no
// network, so Node tests them (tests/scan.test.mjs).
//
// A clue that was read and agrees with a card counts for it; a clue read
// with confidence that disagrees counts against it; a clue that was not
// read says nothing. The confidence a candidate carries is how many
// independent identity clues agree with it (number, total, name, HP, set
// code, attack), less any that conflict, and less again when another card
// is as good.

import {confusedVariants, LEFT_NUMBER_FROM, sameNumber, setCodeMatches, WIZARDS_UNTIL} from '../../lab/js/match.js';

// ------------------------------------------------------------ text

export const fold = (text) => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Characters the English model mixes up on card fonts, folded to one form
// on both sides of a comparison: 0 and O, 1, l, I, and |, 5 and S, 8 and B,
// "rn" and "m", "vv" and "w".
const LOOKALIKE = {'!': 'l', '$': 's', '0': 'o', '1': 'l', '5': 's', '8': 'b', '|': 'l', i: 'l', j: 'l'};

export function nameKey(text) {
	return fold(text)
		.replace(/rn/g, 'm')
		.replace(/vv/g, 'w')
		.replace(/[!$0158|ij]/g, (ch) => LOOKALIKE[ch])
		.replace(/[^a-z0-9]/g, '');
}

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

// The edit distance from `needle` to the closest stretch of `hay`, so a
// name glued to the stage label ("BASICWeedle") or to a suffix still reads.
function closestStretch(needle, hay) {
	let row = new Array(hay.length + 1).fill(0);

	for (let i = 1; i <= needle.length; i++) {
		const next = [i];

		for (let j = 1; j <= hay.length; j++) {
			next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (needle[i - 1] === hay[j - 1] ? 0 : 1));
		}

		row = next;
	}

	return Math.min(...row);
}

// How alike two names read, 0 to 1, after folding accents and lookalikes.
export function nameSimilarity(a, b) {
	const x = nameKey(a);
	const y = nameKey(b);

	if (!x || !y) {
		return 0;
	}

	return 1 - editDistance(x, y) / Math.max(x.length, y.length);
}

// ------------------------------------------------------------ the name strip

// Words on the name strip that are never the name: the stage label, the
// "Evolves from" line, and the HP mark, in the languages TCGdex carries.
const NOT_NAME = new Set([
	'basic', 'basico', 'base', 'stage', 'stagel', 'stage1', 'stage2', 'estagio', 'estagiol', 'estagio1', 'estagio2', 'niveau', 'phase',
	'evolves', 'from', 'evolui', 'de', 'evolution', 'entwickelt', 'aus', 'evoluzione', 'evoluciona', 'put', 'on', 'the', 'pokemon',
	'hp', 'ps', 'pv', 'kp', 'restored', 'level', 'lv',
]);

// Mechanic suffixes, which say what kind of card it is, not which Pokémon.
export const SUFFIXES = ['ex', 'gx', 'v', 'vmax', 'vstar', 'vunion', 'break', 'lvx', 'prism', 'star'];

// The name from the OCR lines of the name strip: the words in the tallest
// print (the "Evolves from" line and the stage label are smaller), with the
// stage words, digits, and stray marks left out. Returns {text, suffix,
// confidence}; text is '' when nothing name-like was read.
export function parseName(lines) {
	const words = [];

	for (const [index, line] of (lines || []).entries()) {
		for (const word of line.words && line.words.length ? line.words : String(line.text || '').split(/\s+/).map((text) => ({confidence: 50, text}))) {
			const clean = String(word.text || '').replace(/^[^\p{L}\d]+|[^\p{L}\d'.♀♂]+$/gu, '');

			if (!clean) {
				continue;
			}

			const height = word.ink || (word.bbox ? word.bbox.y1 - word.bbox.y0 : 0);

			words.push({confidence: word.confidence || 0, height, line: index, text: clean});
		}
	}

	// "Evolves from Kakuna" and "Put Dugtrio on the Basic Pokémon" name other
	// Pokémon (or this one again): the word after "from", "de", "aus", or
	// "put" is dropped, the keywords matched loosely ("Evoves", "Pur").
	for (let i = 0; i < words.length - 1; i++) {
		const key = fold(words[i].text).replace(/[^a-z]/g, '');

		if (['from', 'frorn', 'de', 'aus', 'put', 'pur', 'coloque'].includes(key) || nameSimilarity(key, 'evolves') >= 0.7 || nameSimilarity(key, 'evolui') >= 0.8) {
			words[i + 1].drop = true;
		}
	}

	// The line in the largest print is the name: the median height of its
	// letter words, against the other lines'.
	const median = (list) => {
		const sorted = [...list].sort((a, b) => a - b);

		return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
	};
	const lineHeight = new Map();

	for (const word of words) {
		if (/\p{L}{2,}/u.test(word.text) && word.height) {
			lineHeight.set(word.line, [...(lineHeight.get(word.line) || []), word.height]);
		}
	}

	const tallestLine = Math.max(0, ...[...lineHeight.values()].map(median));
	const nameLines = new Set([...lineHeight.entries()].filter(([, heights]) => median(heights) >= tallestLine * 0.75).map(([line]) => line));

	const isSuffix = (word) => SUFFIXES.includes(fold(word.text).replace(/[^a-z]/g, ''));
	const letters = words.filter((word) => !word.drop && !(nameSimilarity(word.text, 'evolves') >= 0.7) && (/\p{L}{2,}/u.test(word.text) || isSuffix(word)) && !/\d{2,}/.test(word.text) && (!lineHeight.size || nameLines.has(word.line) || !word.height));
	const tallest = Math.max(0, ...letters.map((word) => word.height));
	const kept = letters.filter((word) => !tallest || word.height >= tallest * 0.62)
		.filter((word) => !NOT_NAME.has(fold(word.text).replace(/[^a-z0-9]/g, '')));
	let suffix = null;

	while (kept.length > 1 && isSuffix(kept[kept.length - 1])) {
		suffix = fold(kept.pop().text).replace(/[^a-z]/g, '');
	}

	const text = kept.map((word) => word.text).join(' ').trim();
	const confidence = kept.length ? Math.round(kept.reduce((sum, word) => sum + word.confidence, 0) / kept.length) / 100 : 0;

	return {confidence, suffix, text};
}

// The species names the read name is closest to, best first:
// [{dex, name, score}]. `species` is an array indexed by National Dex
// number (js/checklists.js speciesNames().en). A short name must read
// exactly: "Mew" inside "Mewtwo" is not Mew.
export function matchSpecies(text, species, {limit = 4, min = 0.7} = {}) {
	const read = nameKey(text);

	if (read.length < 3) {
		return [];
	}

	const tokens = fold(text).split(/[^a-z0-9'.♀♂]+/).map(nameKey).filter(Boolean);
	const spans = new Set([read]);

	for (let i = 0; i < tokens.length; i++) {
		for (let j = i + 1; j <= Math.min(tokens.length, i + 3); j++) {
			spans.add(tokens.slice(i, j).join(''));
		}
	}

	const out = [];

	for (let dex = 1; dex < (species || []).length; dex++) {
		const name = species[dex];

		if (!name) {
			continue;
		}

		const key = nameKey(name);

		if (key.length < 3) {
			continue;
		}

		let best = 0;

		for (const span of spans) {
			best = Math.max(best, 1 - editDistance(key, span) / Math.max(key.length, span.length));
		}

		// Glued words: the name inside a longer run, at a small discount.
		if (key.length >= 5 && read.length > key.length) {
			best = Math.max(best, (1 - closestStretch(key, read) / key.length) * 0.92);
		}

		if (key.length <= 4 && best < 1) {
			best *= 0.8;
		}

		if (best >= min) {
			out.push({dex, name, score: Math.round(best * 100) / 100});
		}
	}

	return out.sort((a, b) => b.score - a.score || b.name.length - a.name.length).slice(0, limit);
}

// The set whose name the read name is, when it is exactly one (after
// folding accents and lookalikes) and is not also exactly a species name:
// the heading of the app or page a card is shown on ("Chaos Rising" just
// above a card on a laptop screen), read where the name strip should be.
// A card's name strip never prints its set's name, so such a read is no
// name at all. `sets` is [{name}], `species` as for matchSpecies. Returns
// the set name, or null.
export function setNameRead(text, sets, species = []) {
	const read = nameKey(text);

	if (read.length < 4) {
		return null;
	}

	const set = (sets || []).find((entry) => entry && entry.name && nameKey(entry.name) === read);

	if (!set || (species || []).some((name) => name && nameKey(name) === read)) {
		return null;
	}

	return set.name;
}

// ------------------------------------------------------------ HP

// The HP printed top right: "HP 70" on modern cards, "80 HP" on older ones,
// "PS 160" in Portuguese, "PV" in French, "KP" in German. A Pokémon's HP is
// a multiple of 10 from 10 to 400. Returns {value, confidence} or null.
export function parseHp(text, confidence = 0.6) {
	const clean = String(text || '').toUpperCase()
		.replace(/(?<=\d)[OQD]|[OQD](?=\d)/g, '0')
		.replace(/(?<=\d)[IL]|[IL](?=\d)/g, '1')
		.replace(/(?<=\d)S(?=\d)/g, '5');
	const found = [];

	for (const match of clean.matchAll(/(HP|PS|PV|KP|P5|H)?\s*(\d{2,3})\s*(HP|PS|PV|KP)?/g)) {
		const value = Number(match[2]);

		if (value >= 30 && value <= 400 && value % 10 === 0) {
			found.push({after: !match[1] && Boolean(match[3]) && /HP/.test(match[3]), marked: Boolean(match[1] || match[3]), value});
		}
	}

	if (!found.length) {
		return null;
	}

	const best = found.find((item) => item.marked) || found[0];

	// A small "PS" or "HP" read as a digit turns 50 into 350: a three-digit
	// value led by a digit that mark is read as also stands for its last two.
	const values = [best.value];

	if (best.value >= 100 && /^[3589]/.test(String(best.value)) && best.value % 100 >= 30) {
		values.push(best.value % 100);
	}

	// "80 HP", the mark after the number, is how WotC-era cards print it;
	// later cards print "HP 80".
	return {after: best.after, confidence: Math.round((best.marked ? confidence : confidence * 0.7) * 100) / 100, value: best.value, values};
}

// ------------------------------------------------------------ partial numbers

// What a number strip holds when no full "number/total" read: a number
// before a slash ("001/", "001/0") or a total after one ("/086"). Either is
// a weaker clue than the pair. Returns {number, total} with either null.
export function parsePartialNumber(text) {
	const clean = String(text || '').toUpperCase().replace(/(?<=\d)O|O(?=\d)/g, '0');
	const number = /(?:^|[^0-9])(\d{3})\s*\/\s*(?:\d{0,1}(?!\d))/.exec(clean);
	const total = /\/\s*(\d{2,3})(?![0-9])/.exec(clean);

	return {
		number: number ? String(Number(number[1])) : null,
		total: total && Number(total[1]) > 0 && Number(total[1]) <= 400 ? String(Number(total[1])) : null,
	};
}

// A number whose slash read as one other character ("022/084" as
// "10227084" on a Portuguese Palafin, version 26, or "023 7086"): two
// 3-digit groups with one of 7, 1, l, I, |, 2, or / between them, the total
// ending the run of digits. Every such split, in the order found, those
// whose total is in `totals` (known set totals, as numbers or strings)
// first. Each is {number, numberPrinted, total, totalPrinted, misread:
// true}. Empty when none.
const MISREAD_SLASH = /(\d{3})\s?([71LI|2/])\s?(\d{3})(?!\d)/g;

export function misreadNumbers(text, totals = []) {
	const known = new Set([...totals].map((total) => String(Number(total))));
	const found = [];

	for (const line of String(text || '').toUpperCase().replace(/(?<=\d)O|O(?=\d)/g, '0').split(/\n+/)) {
		for (let from = 0; from < line.length; from++) {
			MISREAD_SLASH.lastIndex = from;

			const match = MISREAD_SLASH.exec(line);

			if (!match) {
				break;
			}

			from = match.index;

			const [, number, , total] = match;

			if (/^(19|20)\d\d$/.test(line.slice(Math.max(0, match.index - 1), match.index) + number)) {
				// A copyright year ("2024 2025"), not a number.
				continue;
			}

			const split = {misread: true, number: String(Number(number)), numberPrinted: number, total: String(Number(total)), totalPrinted: total};

			if (Number(number) > 0 && Number(total) > 0 && Number(total) <= 400 && !found.some((f) => f.number === split.number && f.total === split.total)) {
				found.push(split);
			}
		}
	}

	return [...found.filter((f) => known.has(f.total)), ...found.filter((f) => !known.has(f.total))];
}

// ------------------------------------------------------------ the evidence

// Points per clue. The set code, side, copyright, and catalog carry the
// weights the lab benchmark tuned (lab/js/match.js), and a number and total
// read together are worth the number and the total apart, so among cards
// the number found the order is the lab's; the name, HP, and attack are
// added on top.
export const WEIGHTS = {
	attack: 2,
	catalog: 1,
	copyright: 2,
	hp: 2,
	hpConflict: -2,
	name: 4,
	nameConflict: -2,
	near: -2,
	number: 3,
	numberConflict: -5,
	numberTotal: 5.5,
	setCode: 4,
	side: 2,
	total: 2.5,
	wizards: 2,
};

// Confidence by the number of identity clues that agree.
const BY_AGREEMENT = [0.1, 0.4, 0.7, 0.85, 0.93, 0.97];

// A read name counts against a card only when it was read this well.
export const NAME_SURE = 0.9;

// A number and total read together with less word confidence than this
// (session.js NUMBER_SURE) are a doubtful read. When they do not both match
// a card, the half that does (its number alone, or its total) counts for it
// only in proportion: a misread "01/006" is not much of a clue that a card
// is number 1, and must not outrank the cards the name found.
export const NUMBER_TRUST = 0.6;

const isModern = (date) => Boolean(date) && date >= LEFT_NUMBER_FROM;

// The clues of one read, flattened for scoring: {number, total, numberExact
// (the pair as read), side, setCodeRun, numberConfidence, names (species
// matches), nameText, hp, attacks (folded attack lines), copyrightYear,
// wizards, partial}.
export function cluesOf(read) {
	const number = read && read.number;
	const partial = (read && read.partial) || {number: null, total: null};

	return {
		attackText: (read && read.attackText) || '',
		copyrightYear: (read && read.copyrightYear) || null,
		hp: (read && read.hp) || null,
		name: (read && read.name) || null,
		names: (read && read.names) || [],
		number: number ? number.number : partial.number,
		numberConfidence: number ? number.confidence || 0 : 0.3,
		pair: Boolean(number),
		setCodeRun: (number && number.setCodeRun) || '',
		side: number ? number.side : null,
		total: number ? number.total : partial.total,
		wizards: Boolean(read && read.wizards),
	};
}

// True when `attackText` (the OCR text of the attack box) holds one of the
// card's attack or ability names, each at least 5 letters, read closely.
export function attackAgrees(attackText, card) {
	const names = [...(card.attacks || []), ...(card.abilities || [])].map((name) => nameKey(name)).filter((name) => name.length >= 5);
	const hay = nameKey(attackText);

	if (!names.length || hay.length < 5) {
		return false;
	}

	return names.some((name) => 1 - closestStretch(name, hay) / name.length >= 0.8);
}

// Scores one catalog card against the clues. `card` is {localId, official,
// dexIds, name, hp, releaseDate, setCode, attacks, abilities, set: {the set
// record, for setCodeMatches}, lang, first (the first catalog searched)}.
// Returns {score, reasons, agree, conflicts}; reasons are words a person
// can read ("number and total", "name", "HP 50").
export function scoreCard(clues, card) {
	const reasons = [];
	const agree = new Set();
	const conflicts = new Set();
	let score = 0;

	const numberExact = clues.number ? sameNumber(card.localId, clues.number) : false;
	const totalExact = clues.total ? String(card.official) === String(clues.total) : false;
	const prefix = clues.number ? clues.number.replace(/\d+$/, '') : '';
	const numberNear = clues.number && !numberExact
		? confusedVariants(clues.number.slice(prefix.length)).some((digits) => sameNumber(card.localId, prefix + digits))
		: false;
	const totalNear = clues.total && !totalExact ? confusedVariants(String(clues.total)).includes(String(card.official)) : false;

	if (clues.pair && numberExact && totalExact) {
		score += WEIGHTS.numberTotal;
		reasons.push('number and total');
		agree.add('number').add('total');
	}
	else if (clues.pair && ((numberExact && totalNear) || (numberNear && totalExact))) {
		score += WEIGHTS.numberTotal + WEIGHTS.near;
		reasons.push(totalExact ? 'number one digit off' : 'total one digit off');
		agree.add(totalExact ? 'total' : 'number');
	}
	else {
		// A partly read number ("001/") carries its own, fixed confidence; a
		// whole pair that does not fit this card counts as well as it read.
		const trust = clues.pair ? Math.min(1, clues.numberConfidence / NUMBER_TRUST) : 1;

		if (numberExact) {
			score += WEIGHTS.number * trust;
			reasons.push('number');
			agree.add('number');
		}
		else if (clues.number && !numberNear && clues.pair && clues.numberConfidence >= 0.6) {
			score += WEIGHTS.numberConflict;
			conflicts.add('number');
		}

		if (totalExact) {
			score += WEIGHTS.total * trust;
			reasons.push('total');
			agree.add('total');
		}
		else if (totalNear) {
			score += (WEIGHTS.total / 2) * trust;
			reasons.push('total one digit off');
		}
	}

	if (setCodeMatches(clues.setCodeRun, card.set || {releaseDate: card.releaseDate, abbreviation: {official: card.setCode}}, card.lang)) {
		score += WEIGHTS.setCode;
		reasons.push('set code');
		agree.add('setCode');
	}

	// The name: the card's species among the species read, or its own name
	// read closely (a Trainer, or a name the species list lacks).
	if (clues.name && clues.name.text) {
		const bySpecies = (clues.names || []).filter((match) => (card.dexIds || []).includes(match.dex));
		// A card found by its number carries its name, not its species: its
		// name is matched against the read the way a species name is.
		const own = card.name ? matchSpecies(clues.name.text, [null, stripSuffixText(card.name)], {limit: 1, min: 0})[0] : null;
		const best = Math.max(0, ...bySpecies.map((match) => match.score), own ? own.score : 0);

		if (best >= 0.7) {
			score += WEIGHTS.name * best;
			reasons.push('name');
			agree.add('name');
		}
		else if ((clues.names[0] && clues.names[0].score >= NAME_SURE) && (card.dexIds || card.name)) {
			score += WEIGHTS.nameConflict;
			conflicts.add('name');
		}
	}

	if (clues.hp && card.hp) {
		const values = clues.hp.values || [clues.hp.value];

		if (values.includes(Number(card.hp))) {
			score += WEIGHTS.hp;
			reasons.push(`HP ${card.hp}`);
			agree.add('hp');
		}
		else if (clues.hp.confidence >= 0.6) {
			score += WEIGHTS.hpConflict;
			conflicts.add('hp');
		}
	}

	if (clues.attackText && attackAgrees(clues.attackText, card)) {
		score += WEIGHTS.attack;
		reasons.push('attack');
		agree.add('attack');
	}

	if (card.releaseDate) {
		if (clues.side && (clues.side === 'left') === isModern(card.releaseDate)) {
			score += WEIGHTS.side;
			reasons.push(`number on the ${clues.side}`);
		}

		const releaseYear = Number(card.releaseDate.slice(0, 4));

		if (clues.copyrightYear && (clues.copyrightYear === releaseYear || clues.copyrightYear === releaseYear - 1)) {
			score += WEIGHTS.copyright;
			reasons.push(`copyright ${clues.copyrightYear}`);
		}

		if (clues.wizards && card.releaseDate < WIZARDS_UNTIL) {
			score += WEIGHTS.wizards;
			reasons.push('Wizards copyright');
		}
		else if (clues.hp && clues.hp.after && card.releaseDate < WIZARDS_UNTIL) {
			score += WEIGHTS.wizards;
			reasons.push('HP printed WotC style');
		}
	}

	if (card.first) {
		score += WEIGHTS.catalog;
		reasons.push(`${card.lang} catalog`);
	}

	return {agree: [...agree], conflicts: [...conflicts], reasons, score: Math.round(score * 100) / 100};
}

function stripSuffixText(name) {
	const words = String(name || '').split(/\s+/);

	while (words.length > 1 && SUFFIXES.includes(fold(words[words.length - 1]).replace(/[^a-z]/g, ''))) {
		words.pop();
	}

	return words.join(' ');
}

// Agreeing clues to a confidence: more agreeing clues, more sure; each
// conflicting clue, less; and a runner-up within a point halves the lead.
export function confidenceOf(scored, runnerUp = null) {
	const base = BY_AGREEMENT[Math.min(BY_AGREEMENT.length - 1, scored.agree.length)];
	let confidence = Math.max(0.05, base - 0.25 * scored.conflicts.length);

	if (runnerUp && runnerUp.score >= scored.score - 1) {
		confidence *= 0.6;
	}

	return Math.round(confidence * 100) / 100;
}

// Scores every card, best first, each with {score, reasons, agree,
// conflicts, confidence}. Equal scores: the newer set first, the likelier
// card for a collector of current sets.
export function rankCards(clues, cards) {
	const ranked = cards
		.map((card) => ({...card, ...scoreCard(clues, card)}))
		.sort((a, b) => b.score - a.score || String(b.releaseDate || '').localeCompare(String(a.releaseDate || '')));

	return ranked.map((card, index) => ({
		...card,
		confidence: confidenceOf(card, index === 0 ? ranked[1] : ranked[0]),
	}));
}

// How many identity clues a read holds at all, for the "what was read" line
// and for deciding whether a second look (the attack box) is worth it.
export const identityClues = (clues) => ['number', 'total', 'name', 'hp'].filter((key) => (key === 'name' ? clues.name && clues.name.text : clues[key]));

// ------------------------------------------------------------ the artwork tiebreak

// Candidates within this many points of the best are a tie the artwork may
// order. It never lifts a card from further down, and it never makes a
// match sure on its own (session.js judgeMatch reads the text scores).
export const TIE_POINTS = 1;

// Orders the tied head of `ranked` by artwork similarity (sims: Map id ->
// -1..1). A clear artwork lead (0.15 or more over the next) adds "artwork"
// to the reasons of the card it puts first.
export function orderByArtwork(ranked, sims) {
	if (ranked.length < 2 || !sims || !sims.size) {
		return ranked;
	}

	const top = ranked[0].score;
	const head = ranked.filter((card) => card.score >= top - TIE_POINTS);
	const rest = ranked.slice(head.length);

	if (head.length < 2) {
		return ranked;
	}

	const sim = (card) => (sims.has(card.id) ? sims.get(card.id) : -2);
	const ordered = [...head].sort((a, b) => sim(b) - sim(a) || b.score - a.score);
	const [first, second] = ordered;

	if (sims.has(first.id) && sim(first) - sim(second) >= 0.15) {
		ordered[0] = {...first, reasons: [...first.reasons, 'artwork']};
	}

	return [...ordered.map((card) => ({...card, artwork: sims.has(card.id) ? Math.round(sims.get(card.id) * 100) / 100 : null})), ...rest];
}
