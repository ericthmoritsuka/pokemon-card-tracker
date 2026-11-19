// Typo forgiving search (DESIGN.md section 11, "Forgiving search"; a
// competitor survey, 2026-11-19): "charzard" finds Charizard when nothing
// matches as typed. Shared by My Cards (js/filter-bar.js) and the offline
// card search (js/card-search.js). No DOM, so Node tests it
// (tests/search-match.test.mjs).
//
// The rule, kept simple so results are predictable: a search first matches
// exactly (folded substrings, so prefixes and whole words count). Only when
// that finds nothing does it try again with typos forgiven, one edit for a
// word of 4 to 7 letters and two for 8 or more. A word under 4 letters, a
// word with a digit (a collector number such as "025" or "25/102"), and
// Japanese or Korean text are never forgiven: they match as typed. Of the
// forgiven matches, only the closest spellings show: "charzard" is one edit
// from Charizard and two from Charmander, so it shows Charizard alone.

import {searchKey} from './names.js';

// Case, accents, and spaces folded: "Pokémon" and "pokemon" are one.
export const fold = searchKey;

// A query's words, each folded; "eevee 133" is two words.
export const splitTerms = (text) => String(text || '').split(/\s+/).map(fold).filter(Boolean);

// The edits a word may have and still match: 0 when it is never forgiven.
export function maxEdits(word) {
	if (!/^[a-z]+$/.test(word)) {
		return 0;
	}

	return word.length >= 8 ? 2 : word.length >= 4 ? 1 : 0;
}

// The edits between two words (Levenshtein, with adjacent swaps counted as
// one), or Infinity past `limit`, stopping as soon as a row passes it.
export function editsWithin(a, b, limit) {
	if (Math.abs(a.length - b.length) > limit) {
		return Infinity;
	}

	let before = null;
	let previous = Array.from({length: b.length + 1}, (_, j) => j);

	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		let best = i;

		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			let value = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + cost);

			if (before && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				value = Math.min(value, before[j - 2] + 1);
			}

			row.push(value);
			best = Math.min(best, value);
		}

		if (best > limit) {
			return Infinity;
		}

		before = previous;
		previous = row;
	}

	return previous[b.length] <= limit ? previous[b.length] : Infinity;
}

export const withinEdits = (a, b, limit) => editsWithin(a, b, limit) <= limit;

// The edits that make a word a token, or its start (so "charz" finds
// "charizard" the way "chari" does); Infinity when it is no typo of it.
// One pass gives both: the table's last row holds the edits to every start
// of the token, and only the cells within `limit` of the diagonal are
// worked out, which keeps 30,000 names to a few milliseconds.
let rows = [0, 1, 2].map(() => new Int32Array(32));

export function wordEdits(word, token) {
	const limit = maxEdits(word);
	const n = word.length;

	if (!limit || token.length < n - limit || !/^[a-z]+$/.test(token)) {
		return Infinity;
	}

	const m = Math.min(token.length, n + limit);
	const far = limit + 1;

	if (rows[0].length <= m) {
		rows = [0, 1, 2].map(() => new Int32Array(m * 2 + 2));
	}

	let [before, previous, row] = rows;

	before.fill(far);

	for (let j = 0; j <= m; j++) {
		previous[j] = j <= limit ? j : far;
	}

	for (let i = 1; i <= n; i++) {
		let best = far;

		row.fill(far);
		row[0] = i <= limit ? i : far;

		for (let j = Math.max(1, i - limit); j <= Math.min(m, i + limit); j++) {
			const cost = word.charCodeAt(i - 1) === token.charCodeAt(j - 1) ? 0 : 1;
			let value = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + cost);

			if (i > 1 && j > 1 && word.charCodeAt(i - 1) === token.charCodeAt(j - 2) && word.charCodeAt(i - 2) === token.charCodeAt(j - 1)) {
				value = Math.min(value, before[j - 2] + 1);
			}

			row[j] = Math.min(value, far);
			best = Math.min(best, row[j]);
		}

		if (best > limit) {
			return Infinity;
		}

		[before, previous, row] = [previous, row, before];
	}

	let best = token.length <= m ? previous[token.length] : far;

	for (let j = Math.max(4, n - limit); j <= Math.min(m, token.length - 1); j++) {
		best = Math.min(best, previous[j]);
	}

	return best <= limit ? best : Infinity;
}

export const fuzzyWord = (word, token) => wordEdits(word, token) !== Infinity;

// A matcher for a query's words. Its fuzzy answer for each distinct token
// is remembered, so a list of thousands of cards that share names checks
// each name once per query rather than once per card.
export function makeMatcher(words) {
	const forgiving = words.map((word) => (maxEdits(word) ? new Map() : null));

	const tokenEdits = (index, token) => {
		const memo = forgiving[index];

		if (!memo) {
			return Infinity;
		}

		if (!memo.has(token)) {
			memo.set(token, wordEdits(words[index], token));
		}

		return memo.get(token);
	};

	// A text's edits: 0 for each word found as typed, else its closest token.
	const edits = (folded, tokens) => {
		let total = 0;

		for (let index = 0; index < words.length && total !== Infinity; index++) {
			if (!folded.includes(words[index])) {
				let least = Infinity;

				for (const token of tokens) {
					least = Math.min(least, tokenEdits(index, token));
				}

				total += least;
			}
		}

		return total;
	};

	return {
		// Every word found as typed in the folded text.
		exact: (folded) => words.every((word) => folded.includes(word)),
		// The edits that make the text match, Infinity when no typo does.
		edits,
		// Whether any word may be forgiven at all; when none can, a second
		// pass would find nothing new.
		forgiving: forgiving.some(Boolean),
	};
}

// The tokens a list of texts can be forgiven against: each text and each
// of its words, folded, letters only.
export const tokensOf = (texts) => [...new Set(texts.filter(Boolean).flatMap((text) => [text, ...String(text).split(/\s+/)]).map(fold))]
	.filter((token) => /^[a-z]+$/.test(token));

// Of the items, those whose edits are the fewest (none when every one is
// Infinity): the closest spellings, in the list's own order.
export function closest(items, editsOf) {
	const scored = items.map((item) => [item, editsOf(item)]);
	const best = scored.reduce((low, [, edits]) => Math.min(low, edits), Infinity);

	return best === Infinity ? [] : scored.filter(([, edits]) => edits === best).map(([item]) => item);
}
