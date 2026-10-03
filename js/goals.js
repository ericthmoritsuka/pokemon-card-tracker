// Set and artist goals (DESIGN.md section 11, "Goals"): a goal over the
// cards of one set, at one of three levels, or over every card by one
// illustrator, counted from the owned cards.
//
// A goal is an entry in the person's goals list, beside the checklists
// (js/checklists.js), saved and merged the same way (field by field, with
// stampEntry):
//   {id, kind: 'set', catalog, target: <set id>, level, name, languages?}
//   {id, kind: 'artist', target: <illustrator>, name, languages?}
// level is numbered (every card up to cardCount.official), secrets (every
// card in the set, cardCount.total), or master (every card in every
// finish: normal, holo, reverse, the ball patterns, and stamps). Only the
// definition is stored; what is owned is computed.
//
// languages works as on a checklist: a goal that names none counts a copy
// in any language (the default); one that names some counts only copies in
// them. A set goal reads its own catalog. An artist goal reads the
// international catalog, plus the Japanese, Korean, or Chinese one when its
// languages name that language.
//
// Where the cards come from: a set goal reads the set the Sets tab reads
// (setDetail, for its name, counts, and card list) and the set's cards with
// their finishes through one GraphQL request (js/catalog.js setCards); an
// artist goal reads every card by the illustrator through GraphQL
// (illustratorCards), dated with the set index js/pokemon-cards.js keeps.
// Each is kept on the phone, so a goal's missing list opens offline.
//
// The pure parts take plain data, so Node can test them (tests/goals.test.mjs).

import {artistKey, catalogLanguage, compareNumbers, illustratorCards, savedCardRecords, setCards, setDetail} from './catalog.js';
import {changeGoal, getGoalEntry, listLanguages, namesLanguages, saveNewGoal} from './checklists.js';
import {isLive, loadDocument, newId, nowIso} from './collection.js';
import {catalogsFor, copiesByPrint, internationalSets, isPocket, printKey} from './pokemon-cards.js';

export {artistKey};

export const GOAL_KINDS = ['set', 'artist'];

export const SET_LEVELS = [
	{hint: 'Every card up to the set\'s number', label: 'Numbered', value: 'numbered'},
	{hint: 'Every card, secret rares included', label: 'With secrets', value: 'secrets'},
	{hint: 'Every card in every finish', label: 'Master set', value: 'master'},
];

export const isGoal = (goal) => Boolean(goal) && GOAL_KINDS.includes(goal.kind);

export const levelLabel = (level) => (SET_LEVELS.find((item) => item.value === level) || {label: 'Set'}).label;

const isLevel = (level) => SET_LEVELS.some((item) => item.value === level);

// The catalogs a goal reads.
export function goalCatalogs(goal) {
	if (!goal) {
		return [];
	}

	if (goal.kind === 'set') {
		return [goal.catalog || 'international'];
	}

	return namesLanguages(goal) ? catalogsFor(listLanguages(goal)) : ['international'];
}

// The live goal of this kind over the same set or illustrator, or null.
export function findGoal(goals, {catalog = 'international', kind, target}) {
	return (goals || []).find((goal) => isLive(goal) && goal.kind === kind && (kind === 'artist'
		? artistKey(goal.target) === artistKey(target)
		: goal.target === target && (goal.catalog || 'international') === catalog)) || null;
}

// What the goal is, for its tile and its screen: "Master set" or
// "Every card by this artist".
export function describeGoal(goal) {
	if (!goal) {
		return '';
	}

	return goal.kind === 'set' ? levelLabel(goal.level) : 'Every card by this artist';
}

// ------------------------------------------------------------ finishes
//
// GraphQL's finishes carry no variantId, so a finish is told by its type,
// subtype, foil, and stamps. Portuguese records write some of those in
// Portuguese (js/catalog-views.js); the ball patterns are read as English.

const FOIL_WORDS = {'master bola': 'masterball', 'poke bola': 'pokeball', 'poké bola': 'pokeball'};

const lower = (value) => String(value || '').trim().toLowerCase();

export function variantKey(variant) {
	const foil = lower(variant && variant.foil);
	const stamps = ((variant && variant.stamp) || []).map(lower).filter(Boolean).sort();

	return [lower((variant && variant.type) || 'normal'), lower(variant && variant.subtype), FOIL_WORDS[foil] || foil, stamps.join('+')].join('|');
}

const TYPE_LABELS = {holo: 'Holo', normal: 'Normal', reverse: 'Reverse holo'};
const FOIL_LABELS = {masterball: 'Master Ball pattern', pokeball: 'Poké Ball pattern'};
const STAMP_LABELS = {'1st-edition': '1st Edition'};

const sentence = (text) => {
	const words = String(text).replace(/[-_]+/g, ' ');

	return words.charAt(0).toUpperCase() + words.slice(1);
};

// "Reverse holo", "Poké Ball pattern", "Normal, 1st Edition".
export function variantLabel(variant) {
	const [type, subtype, foil, stamps] = variantKey(variant).split('|');
	const parts = [FOIL_LABELS[foil] || (foil ? `${sentence(foil)} foil` : TYPE_LABELS[type] || sentence(type))];

	if (subtype) {
		parts.push(sentence(subtype));
	}

	for (const stamp of stamps ? stamps.split('+') : []) {
		parts.push(STAMP_LABELS[stamp] || `${sentence(stamp)} stamp`);
	}

	return parts.join(', ');
}

// A variant that is a printing of the card itself: the standard size (a
// jumbo card is another product).
const standard = (variant) => Boolean(variant) && (!variant.size || ['standard', 'padrão', 'padrao'].includes(lower(variant.size)));

// The finishes a card is printed in, as [{key, label, foil, stamped,
// type}], from its variants_detailed, else its variants flags; null when
// neither is known (it then counts once, as on the lower levels).
export function cardVariants(card) {
	const detailed = card && Array.isArray(card.variants_detailed) ? card.variants_detailed.filter(standard) : [];
	let list = detailed;

	if (!list.length && card && card.variants && typeof card.variants === 'object') {
		const flags = card.variants;

		list = [
			flags.normal ? {type: 'normal'} : null,
			flags.holo ? {type: 'holo'} : null,
			flags.reverse ? {type: 'reverse'} : null,
			flags.firstEdition ? {stamp: ['1st-edition'], type: 'normal'} : null,
		].filter(Boolean);
	}

	if (!list.length) {
		return null;
	}

	const out = new Map();

	for (const variant of list) {
		const key = variantKey(variant);
		const [type, , foil, stamps] = key.split('|');

		if (!out.has(key)) {
			out.set(key, {foil, key, label: variantLabel(variant), stamped: Boolean(stamps), stamps, type});
		}
	}

	return [...out.values()];
}

// The finish one copy is, as a key of the card's finishes. record is the
// card's full TCGdex record when it is on the phone (its variantId tells a
// copy's finish exactly); code is the copy's finish code from js/tile.js
// entryFinish (pokeball, masterball, reverse, first, or null for the plain
// print). A copy whose finish cannot be placed counts as the plain print.
export function ownedVariantKey({code = null, entry, finishes, record = null}) {
	if (!finishes || !finishes.length) {
		return null;
	}

	const keys = new Set(finishes.map((finish) => finish.key));

	if (record && entry && entry.variant_id && Array.isArray(record.variants_detailed)) {
		const variant = record.variants_detailed.find((item) => item && item.variantId === entry.variant_id);

		if (variant && keys.has(variantKey(variant))) {
			return variantKey(variant);
		}
	}

	const plain = finishes.find((finish) => !finish.foil && !finish.stamped && finish.type !== 'reverse') || finishes[0];
	const pick = {
		first: () => finishes.find((finish) => finish.stamps.split('+').includes('1st-edition')),
		masterball: () => finishes.find((finish) => finish.foil === 'masterball'),
		pokeball: () => finishes.find((finish) => finish.foil === 'pokeball'),
		reverse: () => finishes.find((finish) => finish.type === 'reverse' && !finish.foil && !finish.stamped),
	}[code];

	return ((pick && pick()) || plain).key;
}

// ------------------------------------------------------------- the cards
//
// A goal card: {cardId, catalog, localId, name, image, rarity, setId,
// setName, releaseDate, finishes}.

const numbered = (localId, official) => /^\d+$/.test(String(localId || '')) && Number(localId) >= 1 && Number(localId) <= official;

// The cards of one level of a set. set is the set record (name, cardCount,
// cards: [{id, localId, name, image}]); details the set's GraphQL cards
// ({cardId: {...}}, with rarity and finishes), either may be missing.
// Numbered: the cards numbered 1 to cardCount.official; a set numbered
// another way ("SV001") takes its first official cards in number order.
export function setLevelCards({catalog = 'international', details = null, level, set = null, setId}) {
	const byId = new Map();

	for (const brief of (set && set.cards) || []) {
		if (brief && brief.id) {
			byId.set(brief.id, {...brief});
		}
	}

	for (const [id, detail] of Object.entries(details || {})) {
		byId.set(id, {...detail, ...(byId.get(id) || {}), rarity: detail.rarity || null, variants: detail.variants || null, variants_detailed: detail.variants_detailed || null});
	}

	let cards = [...byId.values()].sort((a, b) => compareNumbers(a.localId, b.localId));
	const official = set && set.cardCount && Number(set.cardCount.official);

	if (level === 'numbered' && official > 0) {
		const inRange = cards.filter((card) => numbered(card.localId, official));

		cards = inRange.length ? inRange : cards.slice(0, official);
	}

	return cards.map((card) => ({
		cardId: card.id,
		catalog,
		finishes: level === 'master' ? cardVariants(card) : null,
		image: card.image || null,
		localId: card.localId || null,
		name: card.name || null,
		rarity: card.rarity || null,
		releaseDate: (set && set.releaseDate) || null,
		setId: (set && set.id) || setId || null,
		setName: (set && set.name) || null,
	}));
}

const setIdOf = (cardId) => {
	const cut = String(cardId).lastIndexOf('-');

	return cut > 0 ? String(cardId).slice(0, cut) : String(cardId);
};

// Every card by an illustrator. lists: [{catalog, cards}] from
// illustratorCards; sets: the international set index ({setId: {name,
// releaseDate, serie}}). TCG Pocket is left out. Newest first.
export function artistGoalCards({lists = [], sets = {}}) {
	const out = [];

	for (const {catalog, cards} of lists) {
		for (const card of cards || []) {
			const setId = card.setId || setIdOf(card.id);
			const set = catalog === 'international' ? (sets || {})[setId] || null : null;

			if (isPocket(set, card.image)) {
				continue;
			}

			out.push({
				cardId: card.id,
				catalog,
				finishes: null,
				image: card.image || null,
				localId: card.localId || null,
				name: card.name || null,
				rarity: card.rarity || null,
				releaseDate: (set && set.releaseDate) || null,
				setId,
				setName: (set && set.name) || card.setName || null,
			});
		}
	}

	return out.sort((a, b) => {
		if (a.releaseDate !== b.releaseDate) {
			if (!a.releaseDate) {
				return 1;
			}

			if (!b.releaseDate) {
				return -1;
			}

			return a.releaseDate < b.releaseDate ? 1 : -1;
		}

		return compareNumbers(b.setId, a.setId) || compareNumbers(a.localId, b.localId);
	});
}

// ------------------------------------------------------------- counting

// The copies a goal counts, by printKey: those in its languages, or every
// copy when it names none.
export const goalCopies = (goal, entries) => copiesByPrint(entries, namesLanguages(goal) ? listLanguages(goal) : null);

// Each card's counts. master counts each finish; the other levels and
// artist goals count a card once, owned in any finish. recordFor(card)
// gives a card's full record when the phone has it; finishOf(entry) is
// js/tile.js entryFinish.
// A state: {card, copies, owned, total, missing, finishes: [{...finish,
// owned}] | null, unknown}; unknown when master's finishes are not known.
export function goalStates({cards, copies, finishOf = () => null, master = false, recordFor = () => null}) {
	return cards.map((card) => {
		const list = (copies && copies.get(printKey(card.catalog, card.cardId))) || [];

		if (!master || !card.finishes) {
			const has = list.length > 0;

			return {card, copies: list, finishes: null, missing: has ? 0 : 1, owned: has ? 1 : 0, total: 1, unknown: Boolean(master)};
		}

		const record = recordFor(card);
		const have = new Set(list.map((entry) => ownedVariantKey({code: finishOf(entry, record && record.variants_detailed), entry, finishes: card.finishes, record})));
		const finishes = card.finishes.map((finish) => ({...finish, owned: have.has(finish.key)}));
		const owned = finishes.filter((finish) => finish.owned).length;

		return {card, copies: list, finishes, missing: finishes.length - owned, owned, total: finishes.length, unknown: false};
	});
}

// The goal's "N of M": {owned, total, missing, unknown, cards, cardsOwned}.
export function goalTally(states) {
	const out = {cards: states.length, cardsOwned: 0, missing: 0, owned: 0, total: 0, unknown: 0};

	for (const state of states) {
		out.owned += state.owned;
		out.total += state.total;
		out.missing += state.missing;
		out.unknown += state.unknown ? 1 : 0;
		out.cardsOwned += state.copies.length ? 1 : 0;
	}

	return out;
}

// All, Owned, and Missing. On a master goal a card with some finishes owned
// shows under both.
export function passesGoalFilter(state, filter) {
	if (filter === 'owned') {
		return state.owned > 0;
	}

	if (filter === 'missing') {
		return state.missing > 0;
	}

	return true;
}

// The illustrators of the cards the person owns, for the artist field's
// suggestions: names from the full records on the phone, most owned first.
export function artistSuggestions(records) {
	const counts = new Map();

	for (const record of records instanceof Map ? records.values() : records || []) {
		const name = record && typeof record.illustrator === 'string' ? record.illustrator.trim() : '';

		if (name) {
			const key = artistKey(name);
			const old = counts.get(key);

			counts.set(key, {count: (old ? old.count : 0) + 1, name: old ? old.name : name});
		}
	}

	return [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).map((item) => item.name);
}

// ------------------------------------------------------------- storing

export async function listGoals() {
	const doc = await loadDocument();

	return doc.goals.filter((goal) => isLive(goal) && isGoal(goal));
}

export async function getGoal(id) {
	const goal = await getGoalEntry(id);

	return isGoal(goal) ? goal : null;
}

// {kind: 'set', catalog, target, level, name} or {kind: 'artist', target,
// name}. A goal already kept for the same set or illustrator is returned
// as it is (its level changes on its own screen).
export async function createGoal({catalog = 'international', kind, level = null, name = '', target}) {
	if (!GOAL_KINDS.includes(kind)) {
		throw new Error(`Unknown goal kind ${kind}.`);
	}

	const clean = String(target || '').trim();

	if (!clean) {
		throw new Error(kind === 'artist' ? 'Type an illustrator\'s name.' : 'Pick a set.');
	}

	if (kind === 'set' && !isLevel(level)) {
		throw new Error(`Unknown level ${level}.`);
	}

	const existing = findGoal(await listGoals(), {catalog, kind, target: clean});

	if (existing) {
		return existing;
	}

	const at = nowIso();

	return saveNewGoal({
		catalog: kind === 'set' ? catalog : null,
		created_at: at,
		deleted_at: null,
		id: newId(),
		kind,
		level: kind === 'set' ? level : null,
		name: String(name || '').trim() || clean,
		target: clean,
		updated_at: at,
	});
}

export const setGoalLevel = (id, level) => changeGoal(id, (goal) => {
	if (goal.kind !== 'set' || !isLevel(level)) {
		throw new Error(`Unknown level ${level}.`);
	}

	goal.level = level;
});

// ------------------------------------------------------------- loading

// A goal's cards: {cards, set, error, missingList}. missingList when
// nothing about the set or the illustrator is on the phone (offline before
// the first visit, or TCGdex failing); error is the first failure.
export async function loadGoalCards(goal) {
	if (goal.kind === 'set') {
		const catalog = goal.catalog || 'international';
		const [set, details] = await Promise.all([
			setDetail(catalogLanguage(catalog), goal.target).then((hit) => ({data: hit.data, error: null}), (error) => ({data: null, error})),
			setCards(catalog, goal.target).then((hit) => ({data: hit.data, error: null}), (error) => ({data: null, error})),
		]);
		const error = set.error || details.error;

		if (!set.data && !details.data) {
			return {cards: [], error, missingList: true, set: null};
		}

		return {
			cards: setLevelCards({catalog, details: details.data, level: goal.level, set: set.data, setId: goal.target}),
			error,
			missingList: false,
			set: set.data,
		};
	}

	const catalogs = goalCatalogs(goal);
	const [lists, sets] = await Promise.all([
		Promise.all(catalogs.map((catalog) => illustratorCards(catalog, goal.target).then(
			(hit) => ({cards: hit.data, catalog, error: null}),
			(error) => ({cards: null, catalog, error})
		))),
		internationalSets().catch((error) => ({data: null, error})),
	]);
	const error = (lists.find((list) => list.error) || {}).error || null;
	const read = lists.filter((list) => list.cards);

	if (!read.length) {
		return {cards: [], error, missingList: true, set: null};
	}

	return {cards: artistGoalCards({lists: read, sets: (sets && sets.data) || {}}), error, missingList: false, set: null};
}

// Everything a goal's screen and tile show: {cards, states, tally, set,
// error, missingList}.
export async function computeGoal(goal, entries) {
	const loaded = await loadGoalCards(goal);
	const copies = goalCopies(goal, entries);
	const master = goal.kind === 'set' && goal.level === 'master';
	let recordFor = () => null;
	let finishOf = () => null;

	if (master && loaded.cards.length) {
		const owned = loaded.cards.flatMap((card) => copies.get(printKey(card.catalog, card.cardId)) || []);
		const [records, tile] = await Promise.all([savedCardRecords(owned), import('./tile.js')]);

		recordFor = (card) => records.get(`${card.catalog}|${card.cardId}`) || null;
		finishOf = tile.entryFinish;
	}

	const states = goalStates({cards: loaded.cards, copies, finishOf, master, recordFor});

	return {...loaded, states, tally: goalTally(states)};
}
