// monprice export: parsing, and matching rows to TCGdex card records.
//
// Nothing here touches the DOM or IndexedDB. The matcher reaches TCGdex
// through an injected `api`, so the same code runs in the app and in a test
// harness. DESIGN.md sections 5 and 7 hold the rules applied here.

// ---------------------------------------------------------------- parsing

// monprice language codes to the codes the app stores on a copy.
const LANGUAGE_CODES = {
	chs: 'zh-cn',
	cht: 'zh-tw',
	de: 'de',
	en: 'en',
	es: 'es',
	fr: 'fr',
	it: 'it',
	ja: 'ja',
	jp: 'ja',
	ko: 'ko',
	kr: 'ko',
	pt: 'pt',
};

// The middle part of a monprice ID names the catalog the card belongs to.
// Western-language prints share one international record (DESIGN.md
// section 3); Asian prints have their own catalogs.
const REGIONS = {
	chs: {catalog: 'zh-cn', lang: 'zh-cn'},
	cht: {catalog: 'zh-tw', lang: 'zh-tw'},
	int: {catalog: 'international', lang: 'en'},
	jp: {catalog: 'ja', lang: 'ja'},
	// Korean has no Mega-era sets; Korean sets reuse the Japanese set codes,
	// so a Korean row falls back to the Japanese record (DESIGN.md section 5).
	kr: {catalog: 'ko', fallback: {catalog: 'ja', lang: 'ja'}, lang: 'ko'},
};

export const FINISHES = {
	FIRST_EDITION: '1st Edition',
	HOLOFOIL: 'Holo',
	NORMAL: 'Normal',
	REVERSE_HOLOFOIL: 'Reverse holo',
	UNLIMITED: 'Unlimited',
	UNLIMITED_HOLOFOIL: 'Unlimited holo',
};

export const finishLabel = (finish) => FINISHES[finish] || finish || 'Unknown finish';

// Semicolon CSV with optional quotes ("" escapes a quote), CRLF or LF.
function parseDelimited(text, delimiter) {
	const records = [];
	let field = '';
	let record = [];
	let quoted = false;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];

		if (quoted) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				}
				else {
					quoted = false;
				}
			}
			else {
				field += ch;
			}
		}
		else if (ch === '"' && field === '') {
			quoted = true;
		}
		else if (ch === delimiter) {
			record.push(field);
			field = '';
		}
		else if (ch === '\n' || ch === '\r') {
			if (ch === '\r' && text[i + 1] === '\n') {
				i++;
			}

			record.push(field);
			records.push(record);
			record = [];
			field = '';
		}
		else {
			field += ch;
		}
	}

	if (field !== '' || record.length) {
		record.push(field);
		records.push(record);
	}

	return records.filter((fields) => fields.some((value) => value.trim() !== ''));
}

const CSV_COLUMNS = {
	count: 'Count',
	finish: 'Finish Type',
	id: 'ID',
	language: 'Language',
	name: 'Name',
	number: 'Number',
	releaseDate: 'Release Date',
	setName: 'Set',
};

// A cell as a spreadsheet-safe export writes it, ="001", reads as 001. The
// app's own CSV export wraps numbers that way so Excel keeps them as text
// (js/cards-view.js), and a file saved back from a spreadsheet may too.
const unwrap = (value) => {
	const match = /^="(.*)"$/s.exec(value);

	return match ? match[1] : value;
};

export function parseCsv(text) {
	text = text.replace(/^\uFEFF/, '');

	const firstLine = text.slice(0, text.search(/\r?\n|$/));
	const delimiter = firstLine.split(';').length >= firstLine.split(',').length ? ';' : ',';
	const [header, ...records] = parseDelimited(text, delimiter);
	const index = {};

	for (const [key, column] of Object.entries(CSV_COLUMNS)) {
		index[key] = header.findIndex((name) => unwrap(name.trim()) === column);
	}

	const missing = ['id', 'number', 'language'].filter((key) => index[key] < 0).map((key) => CSV_COLUMNS[key]);

	if (missing.length) {
		throw new Error(`This CSV has no ${missing.join(', ')} column, so it is not a monprice export.`);
	}

	return records.map((fields, i) => {
		const get = (key) => (index[key] < 0 ? '' : unwrap((fields[index[key]] || '').trim()).trim());

		return {
			count: get('count'),
			finish: get('finish'),
			id: get('id'),
			language: get('language'),
			// Line 1 is the header.
			line: i + 2,
			name: get('name'),
			number: get('number'),
			releaseDate: get('releaseDate'),
			setName: get('setName'),
		};
	});
}

export function parseJson(text) {
	const data = JSON.parse(text);
	const list = Array.isArray(data) ? data : data && data.pokemon;

	if (!Array.isArray(list)) {
		throw new Error('This JSON has no "pokemon" list, so it is not a monprice export.');
	}

	return list.map((item, i) => ({
		// The JSON leaves out count when it is 1, and finishType when it is
		// NORMAL.
		count: item.count === undefined ? '1' : String(item.count),
		finish: item.finishType || 'NORMAL',
		id: String(item.id || ''),
		language: String(item.lang || ''),
		line: i + 1,
		name: String(item.name || ''),
		number: String(item.number || ''),
		releaseDate: String(item.releaseDate || ''),
		setName: String(item.set || ''),
	}));
}

// ------------------------------------------------------ the app's own CSV

// The app's own export (js/cards-view.js collectionCsv) is told apart by its
// snake_case header: it names entry_id, card_id, and catalog, which no
// monprice file does.
export function isOwnCsv(text) {
	const clean = String(text).replace(/^﻿/, '');
	const firstLine = clean.slice(0, clean.search(/\r?\n|$/));
	const names = firstLine.split(/[;,]/).map((name) => unwrap(name.trim().replace(/^"|"$/g, '')));

	return ['entry_id', 'card_id', 'catalog'].every((name) => names.includes(name));
}

export const OWN_CATALOGS = ['international', 'ja', 'ko', 'zh-cn', 'zh-tw', 'custom'];

const ENTRY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The finish labels the export writes, back to monprice's words.
const FINISH_BY_LABEL = new Map(Object.entries(FINISHES).map(([key, label]) => [label.toLowerCase(), key]));

// 45,90 or 45.90 as a number; null when empty or not a price.
function readPrice(text) {
	if (!text) {
		return null;
	}

	const value = Number(String(text).replace(/\s/g, '').replace(',', '.'));

	return Number.isFinite(value) && value >= 0 ? value : null;
}

const isoOrNull = (text) => (text && !Number.isNaN(Date.parse(text)) ? text : null);

// The rows of the app's own CSV, one per copy: {line, id, created_at,
// ...entry fields} for js/collection.js planOwnImport, and the rows it
// cannot use, with their reason. A field whose column the file lacks (an
// export from before the column was added) is left undefined, so a
// re-import leaves that field alone. Returns {format: 'own', rows, errors}.
export function parseOwnCsv(text) {
	const clean = String(text).replace(/^﻿/, '');
	const firstLine = clean.slice(0, clean.search(/\r?\n|$/));
	const delimiter = firstLine.split(';').length >= firstLine.split(',').length ? ';' : ',';
	const [header, ...records] = parseDelimited(clean, delimiter);
	const names = header.map((name) => unwrap(name.trim()));
	const has = (name) => names.includes(name);
	const rows = [];
	const errors = [];
	const seen = new Set();

	records.forEach((fields, i) => {
		const cell = (name) => {
			const at = names.indexOf(name);

			return at < 0 ? '' : unwrap((fields[at] || '').trim()).trim();
		};
		// undefined when the file has no such column, null when it is empty.
		const optional = (name) => (has(name) ? cell(name) || null : undefined);
		const id = cell('entry_id').toLowerCase();
		const catalog = cell('catalog');
		const languageRaw = cell('language');
		const language = LANGUAGE_CODES[languageRaw.toLowerCase()];
		const problems = [];

		if (!ENTRY_ID.test(id)) {
			problems.push(`entry_id "${cell('entry_id')}" is not an entry id`);
		}
		else if (seen.has(id)) {
			problems.push(`entry_id ${id} is on an earlier line too`);
		}

		if (!cell('card_id')) {
			problems.push('the card_id is empty');
		}

		if (!OWN_CATALOGS.includes(catalog)) {
			problems.push(`catalog "${catalog}" is not one the app knows`);
		}

		if (!language) {
			problems.push(`language "${languageRaw}" is not one the app knows`);
		}

		const custom = catalog === 'custom';
		// A hand-made card's names: their own columns, else what the export
		// shows for it (name, set, number, set_id).
		const own = (name, shown) => {
			if (cell(name)) {
				return cell(name);
			}

			if (custom && cell(shown)) {
				return cell(shown);
			}

			return has(name) || custom ? null : undefined;
		};
		const nameLocal = own('name_local', 'name');
		const setNameLocal = own('set_name_local', 'set');
		const numberLocal = own('number_local', 'number');
		const setCode = own('set_code', 'set_id');

		if (custom && !nameLocal) {
			problems.push('a hand-made card needs a name');
		}

		const variantId = cell('variant_id') || null;
		// The raw finish: its own column, else the label the export wrote for
		// a copy with no matched finish.
		let finishRaw = optional('finish_raw');

		if (finishRaw === undefined && !variantId && cell('finish')) {
			finishRaw = FINISH_BY_LABEL.get(cell('finish').toLowerCase()) || cell('finish');
		}

		const lowNm = readPrice(cell('liga_low_nm'));
		const avg = readPrice(cell('liga_avg'));
		const priced = lowNm !== null || avg !== null;
		const row = {
			card_id: cell('card_id'),
			catalog,
			condition: optional('condition'),
			created_at: isoOrNull(cell('created_at')),
			fallback: has('fallback') ? (/^(yes|true|1)$/i.test(cell('fallback')) ? true : null) : undefined,
			finish_raw: finishRaw,
			id,
			import_key: optional('import_key'),
			language,
			language_source: cell('language_source') || 'import',
			// Line 1 is the header.
			line: i + 2,
			name_local: nameLocal,
			notes: optional('notes'),
			number_local: numberLocal,
			price_manual: has('liga_low_nm') || has('liga_avg')
				? (priced ? {avg, currency: cell('currency') || 'BRL', date: cell('price_date') || null, low_nm: lowNm, source: cell('price_source') || null} : null)
				: undefined,
			set_code: setCode,
			set_name_local: setNameLocal,
			variant_id: variantId,
		};

		if (problems.length) {
			errors.push({...row, languageRaw, name: cell('name'), number: cell('number'), reason: problems.join('; '), setName: cell('set')});
		}
		else {
			seen.add(id);
			rows.push(row);
		}
	});

	return {errors, format: 'own', rows};
}

// Counts a real collection never holds for one card in one language and
// finish: a row above LARGE_COUNT is flagged in the import report and saved
// only when the person ticks it; a row above MAX_COUNT is refused. One row
// with a Count of 99999 once saved a 36 MB document (plans/audit-qa.md Q-08).
export const LARGE_COUNT = 50;
export const MAX_COUNT = 999;

// Returns {format, rows, errors}. A row with an error is reported and
// never imported. A row whose count is above LARGE_COUNT carries large:
// true. The app's own CSV comes back as parseOwnCsv reads it, with format
// 'own'.
export function parseExport(text, fileName = '') {
	const clean = text.replace(/^﻿/, '');

	if (!/\.json$/i.test(fileName) && isOwnCsv(clean)) {
		return parseOwnCsv(clean);
	}

	const isJson = /\.json$/i.test(fileName) || /^\s*[[{]/.test(clean);
	const raw = isJson ? parseJson(clean) : parseCsv(clean);
	const rows = [];
	const errors = [];

	for (const item of raw) {
		const idMatch = /^(.+)_(int|kr|jp|chs|cht)_(.+)$/i.exec(item.id);
		const language = LANGUAGE_CODES[item.language.toLowerCase()];
		const count = Number.parseInt(item.count, 10);
		const problems = [];

		if (!idMatch) {
			problems.push(`ID "${item.id}" is not in the <set>_<region>_<number> shape`);
		}

		if (!language) {
			problems.push(`language "${item.language}" is not one the app knows`);
		}

		if (!Number.isInteger(count) || count < 1) {
			problems.push(`count "${item.count}" is not a whole number of 1 or more`);
		}
		else if (count > MAX_COUNT) {
			problems.push(`count ${count.toLocaleString('en-US')} is more than ${MAX_COUNT} copies of one card, which looks like a typo; fix the Count in the file and import it again`);
		}

		if (!item.number) {
			problems.push('the number is empty');
		}

		const row = {
			count: Number.isInteger(count) && count > 0 && count <= MAX_COUNT ? count : 0,
			finish: (item.finish || 'NORMAL').toUpperCase(),
			language,
			languageRaw: item.language,
			line: item.line,
			monpriceId: item.id,
			name: item.name,
			number: item.number,
			region: idMatch ? idMatch[2].toLowerCase() : null,
			releaseDate: item.releaseDate,
			setCode: idMatch ? idMatch[1] : null,
			setName: item.setName,
		};

		if (problems.length) {
			errors.push({...row, reason: problems.join('; ')});
		}
		else {
			rows.push(row.count > LARGE_COUNT ? {...row, large: true} : row);
		}
	}

	return {errors, format: isJson ? 'JSON' : 'CSV', rows};
}

// --------------------------------------------------------------- matching

// "001/191" is local ID "001"; older sets use "4", so numbers are compared
// with leading zeros removed from every run of digits ("TG02" is "TG2").
export const localPart = (number) => String(number).split('/')[0].trim();

const normalizeNumber = (value) => String(value).trim().toUpperCase().replace(/\d+/g, (digits) => String(Number(digits)));

const printedTotal = (number) => {
	const total = Number.parseInt(String(number).split('/')[1], 10);

	return Number.isInteger(total) ? total : null;
};

async function pool(items, limit, worker) {
	let next = 0;

	const run = async () => {
		while (next < items.length) {
			const item = items[next++];

			await worker(item);
		}
	};

	await Promise.all(Array.from({length: Math.min(limit, items.length)}, run));
}

const MAX_DATE_GAP_MS = 365 * 24 * 60 * 60 * 1000;

const dayString = (ms) => new Date(ms).toISOString().slice(0, 10);

// The UTC day of the release instant and the days either side of it,
// because monprice writes "2026-09-14T23:00:00Z" for a set TCGdex dates
// 2026-09-15 or 16.
function releaseDays(releaseDate) {
	const ms = Date.parse(releaseDate);

	if (Number.isNaN(ms)) {
		return [];
	}

	const day = 24 * 60 * 60 * 1000;

	return [...new Set([dayString(ms), dayString(ms + day), dayString(ms - day)])];
}

// Finds the TCGdex sets behind one monprice set code for international
// prints. TCGdex set details carry the printed set abbreviation
// (abbreviation.official, "CRI" for me04), and the set list can be filtered
// on it, so that is tried first. When no set carries the abbreviation, the
// set name in the row's language, then in English, and then the release
// date are tried.
async function internationalSets(group, api) {
	const sample = group.rows[0];
	const rowMs = Date.parse(sample.releaseDate);

	// An abbreviation or a name can be reused years later ("TR" is both Team
	// Rocket and Team Rocket Returns in TCGdex), so a candidate must also have
	// been released within a year of the row's release date.
	const nearDate = async (sets) => {
		if (Number.isNaN(rowMs)) {
			return sets;
		}

		const kept = [];

		for (const set of sets) {
			const detail = await api.setDetail('en', set.id);
			const setMs = detail && Date.parse(detail.releaseDate);

			if (!detail || Number.isNaN(setMs) || Math.abs(setMs - rowMs) <= MAX_DATE_GAP_MS) {
				kept.push(set);
			}
		}

		return kept;
	};

	const byAbbreviation = await nearDate(await api.findSets('en', 'abbreviation.official', group.setCode));

	if (byAbbreviation.length) {
		return {method: 'abbreviation', sets: byAbbreviation};
	}

	for (const lang of [...new Set([sample.language, 'en'])]) {
		if (!sample.setName) {
			break;
		}

		const byName = await nearDate(await api.findSets(lang, 'name', sample.setName));

		if (byName.length) {
			return {method: 'name and release date', sets: byName};
		}
	}

	for (const day of releaseDays(sample.releaseDate)) {
		const byDate = await api.findSets('en', 'releaseDate', day);

		if (byDate.length === 1) {
			return {method: 'release date', sets: byDate};
		}
	}

	return {method: 'none', sets: []};
}

function cardMap(set) {
	const map = new Map();

	for (const card of (set && set.cards) || []) {
		map.set(normalizeNumber(card.localId), card);
	}

	return map;
}

// Some cards list their printings with variantId "generated", a placeholder
// TCGdex fills in from the variant flags (seen on 30th, g1, xy10, and other
// sets on 2026-10-01). It names no printing, so it is never stored.
const hasRealId = (variant) => Boolean(variant && variant.variantId && variant.variantId !== 'generated');

// Picks the finish's variant from a card's variants_detailed. Returns
// {variantId, how} or null. monprice has no ball-pattern finish, so a reverse
// holo is the plain reverse (DESIGN.md section 7).
export function resolveFinish(finish, variants) {
	const list = (Array.isArray(variants) ? variants : []).filter(hasRealId);

	if (!list.length) {
		return null;
	}

	const type = (variant) => String(variant.type || '').toLowerCase();
	const subtype = (variant) => (variant.subtype ? String(variant.subtype).toLowerCase() : null);
	const firstEdition = (variant) => (variant.stamp || []).includes('1st-edition');
	const plain = (variant) => !variant.foil && !(variant.stamp || []).length;
	const standard = (variant) => !variant.size || String(variant.size).toLowerCase() === 'standard';

	// Each rule is a filter, then subtype preferences in order.
	const rules = {
		FIRST_EDITION: [(variant) => firstEdition(variant) && type(variant) === 'normal', (variant) => firstEdition(variant)],
		HOLOFOIL: [(variant) => type(variant) === 'holo' && plain(variant)],
		NORMAL: [(variant) => type(variant) === 'normal' && plain(variant)],
		REVERSE_HOLOFOIL: [(variant) => type(variant) === 'reverse' && plain(variant)],
		UNLIMITED: [(variant) => type(variant) === 'normal' && plain(variant)],
		UNLIMITED_HOLOFOIL: [(variant) => type(variant) === 'holo' && plain(variant)],
	};
	const subtypeOrder = [null, 'unlimited'];

	for (const filter of rules[finish] || []) {
		const found = list.filter((variant) => filter(variant) && standard(variant));

		for (const wanted of subtypeOrder) {
			const hit = found.find((variant) => subtype(variant) === wanted);

			if (hit) {
				return {how: 'finish', variantId: hit.variantId};
			}
		}

		if (found.length === 1 && subtype(found[0]) !== 'shadowless') {
			return {how: 'finish', variantId: found[0].variantId};
		}
	}

	// A card printed one way only: the plain finishes can only be that one.
	// A reverse or a 1st Edition that the card does not have stays
	// unresolved, so it is checked by hand.
	if (list.length === 1 && ['HOLOFOIL', 'NORMAL', 'UNLIMITED', 'UNLIMITED_HOLOFOIL'].includes(finish)) {
		return {how: 'only printing', variantId: list[0].variantId};
	}

	return null;
}

function localization(set, card, lang) {
	return {image: card.image || null, lang, name: card.name, set_name: set.name || null};
}

// Matches parsed rows to card records. `api` provides:
//   findSets(lang, field, value)  -> [{id, name}]   (exact match)
//   setDetail(lang, setId)        -> set or null when TCGdex has no such set
//   cardDetail(lang, cardId)      -> card or null
// onProgress({stage, done, total}) is called as work completes.
//
// Returns one result per row:
//   {row, status: 'matched' | 'fallback' | 'unmatched', reason, catalog,
//    cardId, setId, localId, variantId, finishHow, setMethod}
// and `cards`, a catalog index record per matched card (DESIGN.md
// section 4, the catalog card): {id, catalog, set_id, collector_number,
// official, release_date, localizations: {lang: {name, set_name, image}}}.
export async function matchRows(rows, api, onProgress = () => {}, {concurrency = 4} = {}) {
	const groups = new Map();

	for (const row of rows) {
		const key = `${row.region}|${row.setCode}`;

		if (!groups.has(key)) {
			groups.set(key, {region: row.region, rows: [], setCode: row.setCode});
		}

		groups.get(key).rows.push(row);
	}

	const groupList = [...groups.values()];

	// 1. Sets.
	let done = 0;

	onProgress({done, stage: 'sets', total: groupList.length});

	await pool(groupList, concurrency, async (group) => {
		const region = REGIONS[group.region];

		if (group.region === 'int') {
			const {method, sets} = await internationalSets(group, api);

			group.method = method;
			group.candidates = sets.map((set) => set.id);
		}
		else {
			group.method = 'set code';
			group.candidates = [group.setCode];
		}

		group.region = region;
		onProgress({done: ++done, stage: 'sets', total: groupList.length});
	});

	// 2. Set card lists, in every language a row needs.
	const lists = new Map();
	const listKeys = new Set();

	for (const group of groupList) {
		const langs = new Set();

		if (group.region.catalog === 'international') {
			langs.add('en');
			group.rows.forEach((row) => langs.add(row.language));
		}
		else {
			langs.add(group.region.lang);

			if (group.region.fallback) {
				langs.add(group.region.fallback.lang);
			}
		}

		for (const setId of group.candidates) {
			for (const lang of langs) {
				listKeys.add(`${lang}|${setId}`);
			}
		}
	}

	done = 0;
	onProgress({done, stage: 'lists', total: listKeys.size});

	await pool([...listKeys], concurrency, async (key) => {
		const [lang, setId] = key.split('|');
		let set = null;

		try {
			set = await api.setDetail(lang, setId);
		}
		catch (err) {
			set = {error: err};
		}

		lists.set(key, set ? {cards: cardMap(set), set} : null);
		onProgress({done: ++done, stage: 'lists', total: listKeys.size});
	});

	const list = (lang, setId) => lists.get(`${lang}|${setId}`) || null;
	const hasCards = (entry) => Boolean(entry && entry.cards.size);

	// 3. Cards, by set and collector number.
	const results = [];
	const cards = new Map();

	const addIndex = (catalog, lang, setId, card) => {
		const key = `${catalog}|${card.id}`;
		const entry = list(lang, setId);

		if (!cards.has(key)) {
			const set = entry.set;

			cards.set(key, {
				catalog,
				collector_number: card.localId,
				id: card.id,
				localizations: {},
				official: (set.cardCount && set.cardCount.official) || null,
				release_date: set.releaseDate || null,
				set_id: setId,
			});
		}

		cards.get(key).localizations[lang] = localization(entry.set, card, lang);
	};

	for (const group of groupList) {
		const {catalog} = group.region;

		for (const row of group.rows) {
			const number = normalizeNumber(localPart(row.number));
			const result = {catalog, row, setMethod: group.method, status: 'unmatched'};

			results.push(result);

			if (!group.candidates.length) {
				result.reason = `No TCGdex set found for monprice set ${row.setCode}`;

				continue;
			}

			// Candidate sets holding this number. Two TCGdex sets can share an
			// abbreviation (30C is 30th and 30th-c), so the one whose size is
			// closest to the printed total ("/191") wins.
			const langs = catalog === 'international'
				? [...new Set([row.language, 'en'])]
				: [group.region.lang, group.region.fallback && group.region.fallback.lang].filter(Boolean);
			const holding = group.candidates.filter((id) => langs.some((lang) => list(lang, id) && list(lang, id).cards.has(number)));
			const total = printedTotal(row.number);
			const size = (id) => {
				const entry = langs.map((lang) => list(lang, id)).find(hasCards);
				const count = entry && entry.set.cardCount;

				return count ? count.total || count.official || 0 : 0;
			};

			if (total !== null) {
				holding.sort((a, b) => Math.abs(size(a) - total) - Math.abs(size(b) - total));
			}

			const setId = holding[0];

			if (!setId) {
				const known = group.candidates.flatMap((id) => langs.map((lang) => list(lang, id))).filter((entry) => entry && !entry.set.error);
				const names = group.candidates.join(' or ');

				const failed = group.candidates.some((id) => langs.some((lang) => list(lang, id) && list(lang, id).set.error));

				if (failed && !known.some(hasCards)) {
					result.reason = `TCGdex did not answer for set ${names}. Run the import again to retry`;
				}
				else if (!known.length) {
					result.reason = `TCGdex has no set ${names} in this catalog`;
				}
				else if (!known.some(hasCards)) {
					result.reason = `TCGdex lists set ${names} with no cards`;
				}
				else {
					const listed = Math.max(...known.map((entry) => entry.cards.size));

					result.reason = `No card numbered ${localPart(row.number)} in set ${names}, which TCGdex lists with ${listed} cards`;
				}

				continue;
			}

			result.setId = setId;

			if (catalog === 'international') {
				const own = list(row.language, setId);
				const ownCard = own && own.cards.get(number);
				const enCard = list('en', setId) && list('en', setId).cards.get(number);

				if (ownCard) {
					result.status = 'matched';
					result.cardId = ownCard.id;
					addIndex(catalog, row.language, setId, ownCard);

					if (enCard && row.language !== 'en') {
						addIndex(catalog, 'en', setId, enCard);
					}
				}
				else {
					result.status = 'fallback';
					result.cardId = enCard.id;
					result.reason = hasCards(own)
						? `The ${row.language.toUpperCase()} list of this set has no card ${localPart(row.number)}; uses the English record`
						: `TCGdex lists no ${row.language.toUpperCase()} cards for this set; uses the English record`;
					addIndex(catalog, 'en', setId, enCard);
				}

				result.localId = (ownCard || enCard).localId;
				result.variantLang = 'en';
			}
			else {
				const ownEntry = list(group.region.lang, setId);
				const ownCard = ownEntry && ownEntry.cards.get(number);

				if (ownCard) {
					result.status = 'matched';
					result.cardId = ownCard.id;
					result.localId = ownCard.localId;
					result.variantLang = group.region.lang;
					addIndex(catalog, group.region.lang, setId, ownCard);
				}
				else {
					const fallback = group.region.fallback;
					const card = list(fallback.lang, setId).cards.get(number);

					result.status = 'fallback';
					result.catalog = fallback.catalog;
					result.cardId = card.id;
					result.localId = card.localId;
					result.variantLang = fallback.lang;
					result.reason = hasCards(ownEntry)
						? `The Korean list of this set has no card ${localPart(row.number)}; uses the Japanese record`
						: 'TCGdex has no Korean list for this set; uses the Japanese record';
					addIndex(fallback.catalog, fallback.lang, setId, card);
				}
			}
		}
	}

	// 4. Finishes, from each matched card's variants_detailed, set by set.
	const wanted = new Map();

	for (const result of results) {
		if (result.cardId) {
			wanted.set(`${result.variantLang}|${result.cardId}`, null);
		}
	}

	const cardKeys = [...wanted.keys()];

	done = 0;
	onProgress({done, stage: 'finishes', total: cardKeys.length});

	await pool(cardKeys, concurrency, async (key) => {
		const [lang, cardId] = key.split('|');

		try {
			wanted.set(key, await api.cardDetail(lang, cardId));
		}
		catch {
			wanted.set(key, null);
		}

		onProgress({done: ++done, stage: 'finishes', total: cardKeys.length});
	});

	for (const result of results) {
		if (!result.cardId) {
			continue;
		}

		const card = wanted.get(`${result.variantLang}|${result.cardId}`);
		const resolved = card ? resolveFinish(result.row.finish, card.variants_detailed) : null;

		result.variantId = resolved ? resolved.variantId : null;
		result.finishHow = resolved ? resolved.how : null;

		if (!resolved) {
			const variants = (card && card.variants_detailed) || [];

			if (!card) {
				result.finishReason = 'The card record could not be loaded';
			}
			else if (!variants.length) {
				result.finishReason = 'TCGdex lists no printings for this card';
			}
			else if (!variants.some(hasRealId)) {
				result.finishReason = 'TCGdex lists this card\'s printings without variant IDs yet';
			}
			else {
				result.finishReason = `The card has no ${finishLabel(result.row.finish).toLowerCase()} printing listed`;
			}
		}
	}

	return {cards: [...cards.values()], results};
}

// Import key for one copy: stable across reruns of the same export, so a
// rerun updates entries instead of adding them again.
export const importKey = (row, copyIndex) => ['monprice', row.monpriceId, row.language, row.finish, copyIndex].join('|');

const sourceText = (value) => String(value || '').trim() || null;

// The entries to save for matched and fallback results: one per copy. Each
// keeps the name and set name the export gave, which the app shows when the
// catalog record has no localization in the copy's language (DESIGN.md
// section 5).
export function importEntries(results) {
	const entries = [];

	for (const result of results) {
		for (let i = 0; i < result.row.count; i++) {
			entries.push({
				card_id: result.cardId,
				catalog: result.catalog,
				fallback: result.status === 'fallback' ? true : undefined,
				finish_raw: result.variantId ? undefined : result.row.finish,
				import_key: importKey(result.row, i),
				language: result.row.language,
				language_source: 'import',
				name_local: sourceText(result.row.name),
				set_name_local: sourceText(result.row.setName),
				variant_id: result.variantId || null,
			});
		}
	}

	return entries;
}
