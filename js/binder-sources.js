// Where a binder made from a list gets its pockets (js/binder-rules.js): the
// checklist, collection, goal, or filter its rule names, read from the
// person's document, as items with the copies that fit each one.
//
//   checklist   one pocket per Pokédex entry; a copy fits when its card's
//               Pokédex numbers include the entry's, in any language, as the
//               checklist screen ticks it (js/checklists.js resolveOwned)
//   collection  one pocket per card the collection holds; its copies there
//   goal        one pocket per card of the set or artist goal, owned or not;
//               the copies the goal counts (js/goals.js computeGoal)
//   filter      one pocket per owned card that fits the filter (the rule
//               collections' matching, js/collections.js); the copies that
//               fit, so a language filter keeps only that language's copies
//
// An item: {key, kind: 'pokemon' | 'card', dex, dexIds, name, image,
// catalog, cardId, setId, setName, number, releaseDate, copies}.
//
// Only this module asks the network, and only what the source's own screen
// asks (and keeps): the Pokédex numbers of owned cards, Pokémon names, a
// goal's card list, and card details for a rule.

import {cardIndex, catalogLanguage, catalogFor, indexKey, priceRecords, setIdOfCard, viewingLanguage} from './catalog.js';
import {checklistDex, dexLabel, isChecklist, nameOf, pokemonNames, resolveOwned, sortChecklists, spriteUrl} from './checklists.js';
import {collectionEntries, fillDetails, itemFor, ruleMatches, sortCollections} from './collections.js';
import {isLive} from './collection.js';
import {customRecord} from './custom-card.js';
import {computeGoal, describeGoal, isGoal, sortGoals} from './goals.js';
import {copyValue, savedRates} from './prices.js';
import {FILTER_FIELDS, cardKey, cleanBinderRule, dexKey, parseKey, sortRuleItems} from './binder-rules.js';

const KIND_WORDS = {checklist: 'Checklist', collection: 'Collection', filter: 'Filter', goal: 'Goal'};

export const kindLabel = (kind) => KIND_WORDS[kind] || kind;

// ------------------------------------------------------------- choices

// The lists a binder can be made from, in the person's order:
// {checklist: [{id, name}], collection: [...], goal: [...]}.
export function sourceChoices(doc) {
	const goals = (doc.goals || []).filter((goal) => goal && isLive(goal));

	return {
		checklist: sortChecklists(goals.filter(isChecklist)).map((goal) => ({id: goal.id, name: goal.name})),
		collection: sortCollections(doc.collections).map((item) => ({id: item.id, name: item.name})),
		goal: sortGoals(goals.filter(isGoal)).map((goal) => ({id: goal.id, name: `${goal.name} (${describeGoal(goal)})`})),
	};
}

// The source entry a rule names, or null when it is gone.
export function sourceEntry(rule, doc) {
	const clean = cleanBinderRule(rule);

	if (!clean || clean.source.kind === 'filter') {
		return null;
	}

	const {id, kind} = clean.source;
	const list = kind === 'collection' ? doc.collections : doc.goals;
	const found = (list || []).find((item) => item && item.id === id && isLive(item)) || null;

	if (!found) {
		return null;
	}

	if (kind === 'checklist') {
		return isChecklist(found) ? found : null;
	}

	return kind === 'goal' ? (isGoal(found) ? found : null) : found;
}

// The rule in a few words, such as "Kanto (checklist)" or "Filter: Kanto,
// Fire". labels: {field: {value: text}} for the filter's stored values.
export function sourceText(rule, doc, labels = {}) {
	const clean = cleanBinderRule(rule);

	if (!clean) {
		return '';
	}

	if (clean.source.kind === 'filter') {
		const words = FILTER_FIELDS.flatMap((field) => (clean.source.filter[field] || []).map((value) => (labels[field] && labels[field][value]) || value));

		return `Filter: ${words.join(', ')}`;
	}

	const found = sourceEntry(clean, doc);

	return found ? `${found.name} (${clean.source.kind})` : `A deleted ${clean.source.kind}`;
}

// What the filter bar reads of each live copy, for the filter's options
// (js/filter-bar.js filterOptions): one item per copy.
export function filterItems(cards, index) {
	return (cards || []).filter((entry) => entry && isLive(entry)).map((entry) => {
		const key = indexKey(entry.catalog || 'international', entry.card_id);
		const record = index.get(key) || customRecord(entry);
		const local = display(record, entry);

		return {...itemFor(entry, record), key: entry.id, releaseDate: (record && record.release_date) || '', setName: (local && local.set_name) || null};
	});
}

// ------------------------------------------------------------- items

// The localization to show: the viewing language when the card's catalog
// has it, then the copy's own language, then the catalog's base language.
function display(record, entry = null) {
	const localizations = (record && record.localizations) || {};
	const viewing = viewingLanguage();
	const catalog = (record && record.catalog) || (entry && entry.catalog) || 'international';

	for (const lang of [catalogFor(viewing) === catalog ? viewing : null, entry && entry.language, catalogLanguage(catalog)]) {
		if (lang && localizations[lang]) {
			return localizations[lang];
		}
	}

	return Object.values(localizations)[0] || null;
}

// One item per card, from copies: the record's names, set, and numbers.
export function cardItems(copies, index) {
	const byCard = new Map();

	for (const entry of copies) {
		const key = cardKey(entry.catalog, entry.card_id);

		if (!byCard.has(key)) {
			byCard.set(key, []);
		}

		byCard.get(key).push(entry);
	}

	return [...byCard.entries()].map(([key, list]) => cardItem(key, index, {copies: list}));
}

// An item for one card key, from the card index, else the facts given (a
// goal's card), else the copy itself (a hand-made card).
export function cardItem(key, index, {copies = [], facts = null} = {}) {
	const parsed = parseKey(key) || {cardId: key, catalog: 'international'};
	const record = index.get(key) || (copies[0] ? customRecord(copies[0]) : null);
	const local = display(record, copies[0] || null);
	const dexIds = (record && Array.isArray(record.dex_ids) ? record.dex_ids : []);

	return {
		cardId: parsed.cardId,
		catalog: parsed.catalog,
		copies,
		dex: null,
		dexIds,
		image: (local && local.image) || (facts && facts.image) || null,
		key,
		kind: 'card',
		name: (local && local.name) || (facts && facts.name) || (copies[0] && copies[0].name_local) || parsed.cardId,
		number: (record && record.collector_number) || (facts && facts.localId) || (copies[0] && copies[0].number_local) || null,
		releaseDate: (record && record.release_date) || (facts && facts.releaseDate) || null,
		setId: (record && record.set_id) || (facts && facts.setId) || setIdOfCard(parsed.cardId),
		setName: (local && local.set_name) || (facts && facts.setName) || (copies[0] && copies[0].set_name_local) || null,
	};
}

// An item for one Pokémon.
export const pokemonItem = (n, names, copies = []) => ({
	copies,
	dex: n,
	dexIds: [n],
	image: spriteUrl(n),
	key: dexKey(n),
	kind: 'pokemon',
	name: nameOf(names, n),
	number: dexLabel(n),
	releaseDate: null,
	setId: null,
	setName: null,
});

// The source's items, in the rule's order: {items, error, partial, gone}.
// gone: the list was deleted. partial: some copies could not be told
// (Pokédex numbers still unknown, or a goal's card list not on the phone),
// so a refresh keeps what it cannot check. force asks again what a failed
// download put off (Refresh).
export async function loadRuleItems(rule, doc, {force = false, index = null, isAlive = () => true} = {}) {
	const clean = cleanBinderRule(rule);

	if (!clean) {
		return {error: null, gone: true, items: [], partial: false};
	}

	const cards = (doc.cards || []).filter((entry) => entry && isLive(entry));
	let known = index || await cardIndex();
	const {kind} = clean.source;
	let items = [];
	let partial = false;
	let error = null;

	if (kind === 'checklist') {
		const goal = sourceEntry(clean, doc);

		if (!goal) {
			return {error: null, gone: true, items: [], partial: false};
		}

		const [names, owned] = await Promise.all([pokemonNames().catch(() => []), resolveOwned(cards, {force, isAlive})]);

		error = owned.error || null;
		partial = owned.unresolved > 0 || Boolean(owned.error);
		items = checklistDex(goal).map((n) => pokemonItem(n, names, owned.byDex.get(n) || []));
	}
	else if (kind === 'collection') {
		const collection = sourceEntry(clean, doc);

		if (!collection) {
			return {error: null, gone: true, items: [], partial: false};
		}

		if (collection.kind === 'rule') {
			known = (await fillDetails(cards, known, isAlive).catch(() => null)) || known;
		}

		items = cardItems(collectionEntries(collection, doc.cards, known), known);
	}
	else if (kind === 'goal') {
		const goal = sourceEntry(clean, doc);

		if (!goal) {
			return {error: null, gone: true, items: [], partial: false};
		}

		const result = await computeGoal(goal, cards);

		error = result.error || null;
		partial = Boolean(result.missingList);
		items = result.states.map((state) => cardItem(cardKey(state.card.catalog, state.card.cardId), known, {copies: state.copies, facts: state.card}));
	}
	else {
		known = (await fillDetails(cards, known, isAlive).catch(() => null)) || known;

		const rule = clean.source.filter;
		const fits = cards.filter((entry) => ruleMatches(rule, itemFor(entry, known.get(indexKey(entry.catalog || 'international', entry.card_id)) || null)));

		items = cardItems(fits, known);
	}

	return {error, gone: false, index: known, items: sortRuleItems(items, clean.order), partial};
}

// ------------------------------------------------------- the default

// rankOf(entry) for defaultCopy: the copy's value in reais (a Liga price
// typed on it, else TCGplayer converted with the saved rate) and its
// rarity, from the full records saved on the phone and the card index.
export async function rankerFor(entries) {
	const records = await priceRecords(entries || []).catch(() => new Map());
	const rates = savedRates();

	return (entry) => {
		const record = records.get(indexKey(entry.catalog || 'international', entry.card_id)) || records.get(entry.card_id) || null;
		let value = null;

		try {
			const priced = copyValue(entry, record || {}, {rates});

			value = Number.isFinite(priced.brl) ? priced.brl : null;
		}
		catch {
			// No price: the rarity, then the date, decide.
		}

		return {rarity: (record && record.rarity) || null, value};
	};
}
