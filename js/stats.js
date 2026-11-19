// The Stats screen's numbers (DESIGN.md section 11, "Stats"): what a
// collection holds, counted once per visit from what the phone already has.
// Nothing here touches the DOM or the network, so Node can test it
// (tests/stats.test.mjs); the screen is js/stats-view.js.
//
// A copy's value is the Value sheet's own (js/prices.js copyValue, the sum
// listStats makes): its kept Liga price, else the US estimate from its full
// TCGdex record at the saved dollar rate. Japanese, Korean, and Chinese
// prints, and copies whose record is not on the phone yet, have none.

import {ASIAN_LANGUAGES, languageLabel} from './languages.js';
import {copyValue, extractPrices, finishFits, finishOf, roundCents} from './prices.js';

const ASIAN = new Set(ASIAN_LANGUAGES);

// The breakdowns' fixed orders and words. Conditions are the copy sheet's
// (js/scan/session.js CONDITIONS), repeated here because that module reads
// the camera and cannot load in Node.
export const CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];
export const NOT_SET = 'Not set';
export const NOT_KNOWN = 'Not known yet';
export const TOP_SETS = 10;
export const TOP_VALUABLE = 10;
export const MONTHS = 12;

const FINISH_ORDER = ['Normal', 'Holo', 'Reverse holo', '1st Edition', 'Poké Ball pattern', 'Master Ball pattern'];

// monprice's words (finish_raw) and the tile codes (entry.finish) to the
// finish families the breakdown counts.
const RAW_FAMILY = {
	FIRST_EDITION: '1st Edition',
	HOLOFOIL: 'Holo',
	NORMAL: 'Normal',
	REVERSE_HOLOFOIL: 'Reverse holo',
	UNLIMITED: 'Normal',
	UNLIMITED_HOLOFOIL: 'Holo',
};
const CODE_FAMILY = {first: '1st Edition', masterball: 'Master Ball pattern', pokeball: 'Poké Ball pattern', reverse: 'Reverse holo'};

const keyOf = (entry) => `${entry.catalog || 'international'}|${entry.card_id}`;

// The family of a printing's English name (js/prices.js finishName, such as
// "Reverse holo, Poké Ball pattern" or "Holo, 1st Edition stamp"): the
// pattern or the stamp that sets it apart, else its type, the first part.
export function finishFamily(label) {
	const text = String(label || '');

	if (!text) {
		return NOT_KNOWN;
	}

	if (/1st Edition/i.test(text)) {
		return '1st Edition';
	}

	if (/Master Ball pattern/.test(text)) {
		return 'Master Ball pattern';
	}

	if (/Poké Ball pattern/.test(text)) {
		return 'Poké Ball pattern';
	}

	return text.split(',')[0].trim();
}

// One copy's finish family: the printing its full record lists for it, as
// a List row names it (js/cards-view.js finishText), else the finish it was
// saved or imported with, else not known. finishes is the record's
// printings (extractPrices), [] without a full record.
export function copyFinish(entry, finishes = []) {
	const matched = finishOf(entry, finishes);

	if (matched && finishFits(entry, matched)) {
		return finishFamily(matched.label);
	}

	if (entry.finish && CODE_FAMILY[entry.finish]) {
		return CODE_FAMILY[entry.finish];
	}

	if (entry.finish_raw) {
		return RAW_FAMILY[entry.finish_raw] || entry.finish_raw;
	}

	return NOT_KNOWN;
}

// Why a copy has no price, as the Value sheet says it (js/value-sheet.js
// priceState, which needs the DOM): an Asian print, a full record still to
// download, a US price with no rate saved yet, or TCGdex having none.
function unpricedReason(entry, saved, value) {
	if (ASIAN.has(entry.catalog)) {
		return 'asian';
	}

	if (!saved) {
		return 'waiting';
	}

	return value.usd === null || value.usd === undefined ? 'none' : 'norate';
}

// "2026-11" for a created_at, in the phone's own calendar; null when it
// cannot be read.
export function monthKey(value) {
	const date = new Date(value);

	if (!value || Number.isNaN(date.getTime())) {
		return null;
	}

	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

// The last n months up to now's, oldest first: ["2025-12", ..., "2026-11"].
export function lastMonths(now = new Date(), n = MONTHS) {
	const out = [];

	for (let i = n - 1; i >= 0; i--) {
		out.push(monthKey(new Date(now.getFullYear(), now.getMonth() - i, 1)));
	}

	return out;
}

// [{label, count}] from a Map of label to count, most first, ties by label;
// keep, when given, puts its labels first in its order instead.
function rows(counts, {last = [], order = null} = {}) {
	const list = [...counts].map(([label, count]) => ({count, label}));
	const rank = (label) => (order ? (order.includes(label) ? order.indexOf(label) : order.length) : 0);
	const tail = (label) => (last.includes(label) ? 1 : 0);

	return list.sort((a, b) => tail(a.label) - tail(b.label) || rank(a.label) - rank(b.label) || b.count - a.count || a.label.localeCompare(b.label));
}

const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);

// The default describe: what a copy can say of itself, with no card index.
const plainDescribe = (entry) => ({
	name: entry.name_local || entry.card_id || 'Unknown card',
	route: null,
	setKey: entry.set_code || (String(entry.card_id || '').includes('-') ? String(entry.card_id).split('-')[0] : null),
	setName: entry.set_name_local || null,
});

// The whole Stats screen's numbers for some live copies:
//
//   records   Map "<catalog>|<card id>" to the card record: the card index
//             records with the full saved records over them, as the Value
//             sheet takes them (rarity, types, and category come from the
//             index once My Cards' background pass has read them)
//   saved     the full records alone, which carry the prices; records when
//             left out
//   rates     the saved dollar rate (js/prices.js savedRates), or null
//   describe  entry => {name, route, setKey, setName} for the copy's card,
//             in the viewing language; called once per card and language
//   now       today, for the months
//
// Returns {totals: {copies, cards, sets, languages}, language, sets: {top,
// more, moreCopies}, rarity, type, typeShared, finish, condition, valuable,
// unpriced: {count, asian, waiting, none, norate}, months: [{month, count}],
// before}, every breakdown a list of {label, count}. A copy of two types
// counts under each (typeShared says some did). valuable is the top ten
// alike copies by value, [{brl, kind, count, entry, name, route, setName}],
// copies of one card, language, and value counted as one row.
export function collectionStats(entries, {describe = plainDescribe, now = new Date(), rates = null, records = new Map(), saved = records} = {}) {
	const live = (entries || []).filter((entry) => entry && !entry.deleted_at);
	const described = new Map();
	const finishesOf = new Map();
	const cards = new Set();
	const sets = new Map();
	const setNames = new Map();
	const languages = new Map();
	const rarity = new Map();
	const type = new Map();
	const finish = new Map();
	const condition = new Map();
	const valued = new Map();
	const unpriced = {asian: 0, count: 0, none: 0, norate: 0, waiting: 0};
	const span = lastMonths(now);
	const months = new Map(span.map((month) => [month, 0]));
	let before = 0;
	let typeShared = false;

	for (const entry of live) {
		const key = keyOf(entry);
		const tile = `${key}|${entry.language || ''}`;
		const record = records.get(key) || null;

		if (!described.has(tile)) {
			described.set(tile, describe(entry, record) || plainDescribe(entry));
		}

		if (!finishesOf.has(key)) {
			let list = [];

			try {
				list = extractPrices(record);
			}
			catch {
				// A record that cannot be read names no printing.
			}

			finishesOf.set(key, list);
		}

		const info = described.get(tile);

		cards.add(key);
		bump(languages, entry.language || '');

		const setKey = info.setKey || NOT_KNOWN;

		bump(sets, setKey);

		if (info.setName && !setNames.has(setKey)) {
			setNames.set(setKey, info.setName);
		}

		bump(rarity, (record && record.rarity) || NOT_KNOWN);

		const types = record && Array.isArray(record.types) ? record.types.filter(Boolean) : [];

		if (types.length) {
			typeShared = typeShared || types.length > 1;
			types.forEach((one) => bump(type, one));
		}
		else {
			// Trainers and Energy have no type: their category stands in.
			bump(type, (record && record.category && record.category !== 'Pokemon' ? record.category : null) || NOT_KNOWN);
		}

		bump(finish, copyFinish(entry, finishesOf.get(key)));
		bump(condition, CONDITIONS.includes(entry.condition) ? entry.condition : NOT_SET);

		const month = monthKey(entry.created_at);

		if (month && months.has(month)) {
			bump(months, month);
		}
		else if (month && month < span[0]) {
			before++;
		}

		const value = copyValue(entry, record, {rates});

		if (value.kind === 'unknown') {
			unpriced.count++;
			unpriced[unpricedReason(entry, saved.get(key), value)]++;

			continue;
		}

		const alike = `${tile}|${value.kind}|${value.brl}`;
		const row = valued.get(alike);

		if (row) {
			row.count++;
		}
		else {
			valued.set(alike, {brl: value.brl, count: 1, entry, kind: value.kind, name: info.name, route: info.route, setName: info.setName});
		}
	}

	const setRows = rows(sets, {last: [NOT_KNOWN]}).map((row) => ({...row, label: setNames.get(row.label) || row.label}));
	const top = setRows.slice(0, TOP_SETS);
	const rest = setRows.slice(TOP_SETS);
	const languageRows = rows(languages).map((row) => ({...row, label: languageLabel(row.label)}));

	return {
		before,
		condition: rows(condition, {order: [...CONDITIONS, NOT_SET]}),
		finish: rows(finish, {last: [NOT_KNOWN], order: FINISH_ORDER}),
		language: languageRows,
		months: [...months].map(([month, count]) => ({count, month})),
		rarity: rows(rarity, {last: [NOT_KNOWN]}),
		sets: {more: rest.length, moreCopies: rest.reduce((sum, row) => sum + row.count, 0), top},
		totals: {
			cards: cards.size,
			copies: live.length,
			languages: [...languages.keys()].filter(Boolean).length,
			sets: [...sets.keys()].filter((key) => key !== NOT_KNOWN).length,
		},
		type: rows(type, {last: [NOT_KNOWN]}),
		typeShared,
		unpriced,
		valuable: [...valued.values()]
			.sort((a, b) => b.brl - a.brl || a.name.localeCompare(b.name))
			.slice(0, TOP_VALUABLE)
			.map((row) => ({...row, brl: roundCents(row.brl)})),
	};
}

// A share of a whole as a short percent for a bar's text: "16%", "less
// than 1%" for a sliver, so a row never reads 0% beside a count.
export function sharePercent(count, total) {
	if (!total || !count) {
		return '0%';
	}

	const percent = (count / total) * 100;

	return percent < 1 ? 'less than 1%' : `${Math.round(percent)}%`;
}
