// Card search for the Sets tab (DESIGN.md section 3, "Card search in the
// Sets tab"): the Sets search box also finds cards across the catalog, by
// name in English or Portuguese (Asian prints through the English name,
// js/names.js), by number ("025", "025/165"), by set code and number
// ("MEW 025"), and by kind (ex, GX, V, VMAX, VSTAR, promo, SIR, full art).
//
// No DOM and no storage here, so Node tests it (tests/card-search.test.mjs).
// Online it asks TCGdex's GraphQL card search; offline it searches the set
// records already saved on the phone (js/catalog.js savedCatalog).

import {catalogFor} from './languages.js';
import {NAME_LANGUAGE, cardNames, cardSearchTerms, searchKey, stripSuffix} from './names.js';

// The most tiles one search shows; a wider search says to narrow it.
export const MAX_RESULTS = 60;

// The TCG Pocket series is digital only and hidden from Sets (DESIGN.md
// section 3), so its cards are left out of the results too.
const POCKET_SERIE = 'tcgp';

// Rarities TCGdex gives full-art cards, in English (GraphQL answers rarities
// in English for every catalog).
const FULL_ART = /ultra|full art|illustration|hyper|secret|rainbow/i;

// Each kind, and what a card needs to be one: a name suffix (js/names.js
// stripSuffix), a rarity, or a promo set.
const KINDS = {
	ex: {suffix: 'ex'},
	gx: {suffix: 'gx'},
	promo: {promo: true},
	sir: {rarity: /^special illustration rare$/i},
	v: {suffix: 'v'},
	vmax: {suffix: 'vmax'},
	vstar: {suffix: 'vstar'},
};

// A collector number as printed: digits, or TG and GG gallery numbers.
const NUMBER = /^((?:tg|gg)?\d+)(?:\/((?:tg|gg)?\d+))?$/;

// "025" is "25", and "TG05" is "tg5".
const numberKey = (value) => {
	const match = /^(\D*)0*(\d+)$/.exec(String(value || '').trim().toLowerCase());

	return match ? `${match[1]}${match[2]}` : String(value || '').trim().toLowerCase();
};

// The parsed query, or null when the text asks for no cards (empty, or a
// name of one letter):
//   {kinds, name, number, setCatalog, setId, total}
// sets: [{catalog, code, id}] from the set list on screen, so a set code
// followed by a number ("MEW 025") names that set.
export function parseCardQuery(text, sets = []) {
	let rest = ` ${String(text || '').toLowerCase().replace(/\s+/g, ' ').trim()} `;
	const kinds = [];

	if (/ full ?art /.test(rest)) {
		kinds.push('full art');
		rest = rest.replace(/ full ?art /, ' ');
	}

	const words = [];
	let number = null;
	let total = null;

	for (const token of rest.trim().split(' ').filter(Boolean)) {
		const numbered = NUMBER.exec(token);

		if (Object.hasOwn(KINDS, token)) {
			kinds.push(token);
		}
		else if (numbered && number === null) {
			number = numbered[1];
			total = numbered[2] || null;
		}
		else {
			words.push(token);
		}
	}

	let setId = null;
	let setCatalog = null;

	if (number !== null && words.length) {
		const at = words.findIndex((word) => sets.some((set) => [set.code, set.id].some((value) => value && String(value).toLowerCase() === word)));

		if (at >= 0) {
			const set = sets.find((row) => [row.code, row.id].some((value) => value && String(value).toLowerCase() === words[at]));

			setId = set.id;
			setCatalog = set.catalog || 'international';
			words.splice(at, 1);
		}
	}

	const name = words.join(' ');

	if (!number && !kinds.length && searchKey(name).length < 2) {
		return null;
	}

	return {kinds, name, number, setCatalog, setId, total};
}

const isPromo = (card) => /promo|プロモ|프로모/i.test(card.setName || '') || /p$/i.test(card.setId || '');

// Whether a card answers the query. card: {catalog, lang, localId, name,
// official, rarity, serie, setId, setName}. tables: the species names
// (js/checklists.js speciesNames) or null, for the English name of an Asian
// print. A rarity kind on a card whose rarity is not known does not match.
export function cardMatches(card, query, tables = null) {
	if (card.serie === POCKET_SERIE) {
		return false;
	}

	if (query.number !== null && numberKey(card.localId) !== numberKey(query.number)) {
		return false;
	}

	if (query.total && card.official && numberKey(card.official) !== numberKey(query.total)) {
		return false;
	}

	if (query.setId && String(card.setId).toLowerCase() !== query.setId.toLowerCase()) {
		return false;
	}

	if (query.name) {
		const wanted = searchKey(query.name);
		const terms = cardSearchTerms(cardNames({lang: card.lang, name: card.name}, tables));

		if (!terms.some((term) => term.includes(wanted))) {
			return false;
		}
	}

	return query.kinds.every((kind) => {
		const rule = KINDS[kind] || {rarity: FULL_ART};

		if (rule.suffix) {
			return String(stripSuffix(card.name).suffix || '').toLowerCase() === rule.suffix;
		}

		if (rule.promo) {
			return isPromo(card);
		}

		return Boolean(card.rarity) && rule.rarity.test(card.rarity);
	});
}

// Matching cards grouped by print, one per "<catalog>|<card id>": an
// international card found in English and Portuguese is one result, named
// and opened in the viewing language when it was found in it, else English.
// Each result: {catalog, id, image, lang, localId, name, rarity, setId,
// setName}. More than MAX_RESULTS keeps the first and sets `more`.
export function collectResults(cards, viewing) {
	const prints = new Map();

	for (const card of cards) {
		const key = `${card.catalog}|${card.id}`;
		const held = prints.get(key);
		const better = !held || (card.lang === viewing && held.lang !== viewing) || (held.lang !== viewing && held.lang !== 'en' && card.lang === 'en');

		if (better) {
			prints.set(key, {...card, image: card.image || (held && held.image) || null, rarity: card.rarity || (held && held.rarity) || null});
		}
		else if (!held.rarity && card.rarity) {
			held.rarity = card.rarity;
		}
	}

	const all = [...prints.values()];

	return {more: all.length > MAX_RESULTS, results: all.slice(0, MAX_RESULTS)};
}

// --------------------------------------------------------------- offline

// The query over what the phone holds. saved: {sets: [{lang, set}], cards:
// [{lang, card}]}, the set records and full card records js/catalog.js
// keeps; a set record's cards carry no rarity, so a saved card record's
// rarity is used where there is one.
export function searchSaved(query, saved, {tables = null, viewing = 'en'} = {}) {
	const rarities = new Map();

	for (const {card, lang} of saved.cards || []) {
		if (card && card.rarity) {
			rarities.set(`${catalogFor(lang)}|${card.id}`, card.rarity);
		}
	}

	const found = [];

	for (const {lang, set} of saved.sets || []) {
		const catalog = catalogFor(lang);

		for (const card of (set && set.cards) || []) {
			const candidate = {
				catalog,
				id: card.id,
				image: card.image || null,
				lang,
				localId: card.localId,
				name: card.name,
				official: set.cardCount && set.cardCount.official,
				rarity: rarities.get(`${catalog}|${card.id}`) || null,
				serie: set.serie && set.serie.id,
				setId: set.id,
				setName: set.name,
			};

			if (cardMatches(candidate, query, tables)) {
				found.push(candidate);
			}
		}
	}

	return collectResults(found, viewing);
}

// ---------------------------------------------------------------- online

const CARD_FIELDS = 'id localId name image rarity set { id name serie { id } cardCount { official } }';

// The species index whose English name is the query's name, or null.
function speciesOf(name, tables) {
	const english = tables && tables.en;
	const wanted = searchKey(name);

	if (!english || !wanted) {
		return null;
	}

	for (const [n, value] of Object.entries(english)) {
		if (value && searchKey(value) === wanted) {
			return n;
		}
	}

	return null;
}

// The GraphQL requests a query needs, as [{catalog, lang, text}]: English,
// Portuguese for a name, and each Asian catalog whose species name for an
// English Pokémon name is known, plus the viewing catalog when it is Asian
// and the query has no name. Empty when TCGdex cannot narrow the query
// (promo or full art alone).
export function cardRequests(query, {tables = null, viewing = 'en'} = {}) {
	const filters = {};

	if (query.number !== null) {
		filters.localId = numberKey(query.number);
	}

	if (query.setId) {
		filters.id = `${query.setId}-`;
	}

	if (query.name) {
		filters.name = query.name;
	}
	else if (query.number === null) {
		const kind = query.kinds.find((name) => KINDS[name] && (KINDS[name].suffix || KINDS[name].rarity));

		if (!kind) {
			return [];
		}

		if (KINDS[kind].suffix) {
			filters.name = KINDS[kind].suffix;
		}
		else {
			filters.rarity = 'Special illustration rare';
		}
	}

	const request = (catalog, lang, extra = {}) => {
		const all = {...filters, ...extra};
		const list = Object.entries(all).map(([key, value]) => `${key}: ${JSON.stringify(String(value))}`).join(', ');
		const locale = lang === 'en' ? '' : ` @locale(lang: ${JSON.stringify(lang)})`;

		return {catalog, lang, text: `{ cards(filters: {${list}}, pagination: {page: 1, itemsPerPage: 100})${locale} { ${CARD_FIELDS} } }`};
	};

	if (query.setId) {
		const lang = query.setCatalog === 'international' ? 'en' : query.setCatalog;

		return [request(query.setCatalog, lang)];
	}

	const requests = [request('international', 'en')];

	if (query.name) {
		requests.push(request('international', 'pt'));

		const n = speciesOf(query.name, tables);

		for (const [lang, table] of Object.entries(NAME_LANGUAGE)) {
			const local = n && tables[table] && tables[table][n];

			if (local) {
				requests.push(request(lang, lang, {name: local}));
			}
		}
	}
	else if (catalogFor(viewing) !== 'international') {
		requests.push(request(viewing, viewing));
	}

	return requests;
}

// The query over TCGdex. graphql: js/tcgdex.js graphql. Rejects only when
// every request failed, with the first failure. A query TCGdex cannot
// narrow sends nothing and comes back with `narrow` set.
export async function searchOnline(query, {graphql, tables = null, viewing = 'en'}) {
	const requests = cardRequests(query, {tables, viewing});

	if (!requests.length) {
		return {more: false, narrow: true, results: []};
	}
	const answers = await Promise.allSettled(requests.map((request) => graphql(request.text)));

	if (answers.every((answer) => answer.status === 'rejected')) {
		throw answers[0].reason;
	}

	const found = [];

	answers.forEach((answer, i) => {
		if (answer.status !== 'fulfilled') {
			return;
		}

		const {catalog, lang} = requests[i];
		// A name searched in its own language (Portuguese, or an Asian
		// species name) is checked by TCGdex; the rest is checked here.
		const check = {...query, name: lang === 'en' ? query.name : ''};

		for (const card of (answer.value && answer.value.cards) || []) {
			const set = card.set || {};
			const candidate = {
				catalog,
				id: card.id,
				image: card.image || null,
				lang: catalog === 'international' ? lang : catalog,
				localId: card.localId,
				name: card.name,
				official: set.cardCount && set.cardCount.official,
				rarity: typeof card.rarity === 'string' && card.rarity !== 'None' ? card.rarity : null,
				serie: set.serie && set.serie.id,
				setId: set.id,
				setName: set.name,
			};

			if (card.id && cardMatches(candidate, check, tables)) {
				found.push(candidate);
			}
		}
	});

	return collectResults(found, viewing);
}
