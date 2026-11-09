// Set, artist, and Pokémon goals (DESIGN.md section 11, "Goals"): a goal
// over the cards of one set, at one of three levels, over every card by one
// illustrator, or over every print of one Pokémon, counted from the owned
// cards.
//
// A goal is an entry in the person's goals list, beside the checklists
// (js/checklists.js), saved and merged the same way (field by field, with
// stampEntry):
//   {id, kind: 'set', catalog, target: <set id>, level, name, languages?}
//   {id, kind: 'artist', target: <illustrator>, name, languages?}
//   {id, kind: 'pokemon', target: <National Dex number, as text>, name,
//    languages?}
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
// A Pokémon goal (Eric, 2026-11-09) is made from the Pokémon screen
// (js/pokemon-cards-view.js) in the languages he picks, and holds the prints
// that screen shows: every print whose dexId includes the number, TAG TEAM
// cards included, from the catalogs of its languages only (Korean also
// reads the Japanese one, where its copies are saved: js/pokemon-cards.js
// catalogsFor). Its languages are kept exactly as ticked, every one of them
// too (js/languages.js listLanguagesToSave exact); Any language, no field,
// reads the international catalog alone, as an artist goal, so it is named
// for what it holds: the Western prints, a copy in any language counting
// (ANY_POKEMON_LANGUAGE). A copy counts in one of its languages, or with no
// language recorded, as on the screen's flags (js/pokemon-cards.js
// flagLanguages).
//
// Older phones (v70 and before) know only the set and artist kinds: isGoal
// there is false for a Pokémon goal, so every goal screen, the Lists tab,
// Edit order, and the binder form pass it over, and the merge, which is by
// id and field and never by kind, keeps it whole (tests/
// pokemon-goal-v70-browser.test.mjs).
//
// Where the cards come from: a set goal reads the set the Sets tab reads
// (setDetail, for its name, counts, and card list) and the set's cards with
// their finishes through one GraphQL request (js/catalog.js setCards); an
// artist goal reads every card by the illustrator through GraphQL
// (illustratorCards), dated with the set index js/pokemon-cards.js keeps; a
// Pokémon goal reads what the Pokémon screen reads (js/pokemon-cards.js
// loadInternational and loadAsian), one catalog per language picked.
// Each is kept on the phone, so a goal's missing list opens offline.
//
// The pure parts take plain data, so Node can test them (tests/goals.test.mjs).

import {artistKey, catalogLanguage, compareNumbers, illustratorCards, savedCardRecords, setCards, setDetail} from './catalog.js';
import {changeGoal, dexLabel, getGoalEntry, listLanguages, namesLanguages, renameChecklist, saveNewGoal, validDex} from './checklists.js';
import {byCreated, sortByOrder} from './reorder.js';
import {isLive, loadDocument, newId, nowIso} from './collection.js';
import {cleanListLanguages, languageChip, languageLabel, listLanguagesToSave} from './languages.js';
import {catalogsFor, copiesByPrint, internationalSets, isPocket, loadAsian, loadInternational, newestFirst, printKey} from './pokemon-cards.js';

export {artistKey};

// A new kind is added at the end: an older phone's isGoal is false for it
// (above).
export const GOAL_KINDS = ['set', 'artist', 'pokemon'];

export const SET_LEVELS = [
	{hint: 'Every card up to the set\'s number', label: 'Numbered', value: 'numbered'},
	{hint: 'Every card, secret rares included', label: 'With secrets', value: 'secrets'},
	{hint: 'Every card in every finish', label: 'Master set', value: 'master'},
];

export const isGoal = (goal) => Boolean(goal) && GOAL_KINDS.includes(goal.kind);

export const isPokemonGoal = (goal) => Boolean(goal) && goal.kind === 'pokemon';

// A Pokémon goal's National Dex number, or null.
export function goalDex(goal) {
	const n = Number(goal && goal.target);

	return isPokemonGoal(goal) && validDex(n) ? n : null;
}

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

const sameTarget = (goal, kind, target, catalog) => {
	if (kind === 'artist') {
		return artistKey(goal.target) === artistKey(target);
	}

	if (kind === 'pokemon') {
		return Number(goal.target) === Number(target);
	}

	return goal.target === target && (goal.catalog || 'international') === catalog;
};

// The live goal of this kind over the same set, illustrator, or Pokémon, or
// null.
export function findGoal(goals, {catalog = 'international', kind, target}) {
	return (goals || []).find((goal) => isLive(goal) && goal.kind === kind && sameTarget(goal, kind, target, catalog)) || null;
}

// A Pokémon goal's Any language, said for what it holds: the international
// prints, which every Western language shares, with a copy in any language
// counting (German, Italian, and Spanish too). It reads no Japanese, Korean,
// or Chinese catalog, so "Every card, any language" would promise prints it
// leaves out.
export const ANY_POKEMON_LANGUAGE = 'Western prints, any language';

// What the goal is, for its tile and its screen: "Master set", "Every card
// by this artist", or "Every card in PT, JA". A Pokémon goal's name is the
// Pokémon's, so its languages are said here, from the field, and stay true
// when they are changed on its screen.
export function describeGoal(goal) {
	if (!goal) {
		return '';
	}

	if (goal.kind === 'pokemon') {
		return namesLanguages(goal) ? `Every card in ${listLanguages(goal).map(languageChip).join(', ')}` : ANY_POKEMON_LANGUAGE;
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

// Every print of a Pokémon in a goal's catalogs. results: [{catalog,
// prints}] from js/pokemon-cards.js loadInternational and loadAsian (TCG
// Pocket already left out there). Newest first, as the Pokémon screen lists
// them. dexIds: the print's Pokédex numbers from the bulk map, else [n]
// (an Asian print, whose card list names none), so a binder in Pokédex
// order places a print the same owned or not.
export function pokemonGoalCards(results = [], n = null) {
	const prints = (results || []).flatMap((result) => (result && result.prints) || []);

	return newestFirst(prints).map((print) => ({
		cardId: print.cardId,
		catalog: print.catalog,
		...(Array.isArray(print.dexIds) && print.dexIds.length ? {dexIds: print.dexIds} : validDex(Number(n)) ? {dexIds: [Number(n)]} : {}),
		finishes: null,
		image: print.image || null,
		localId: print.localId || null,
		name: print.name || null,
		rarity: print.rarity || null,
		releaseDate: print.releaseDate || null,
		setId: print.setId || null,
		setName: print.setName || null,
	}));
}

// ------------------------------------------------------------- counting

// The copies a goal counts, by printKey: those in its languages, or every
// copy when it names none. A Pokémon goal also counts a copy with no
// language recorded, as the Pokémon screen counts it on every flag of its
// catalog (Eric, 2026-11-09).
export function goalCopies(goal, entries) {
	if (!namesLanguages(goal)) {
		return copiesByPrint(entries, null);
	}

	return copiesByPrint(entries, isPokemonGoal(goal) ? [...listLanguages(goal), null] : listLanguages(goal));
}

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

// The goals in the order the person set (js/reorder.js), the ones with no
// order last, oldest first.
export const sortGoals = (goals) => sortByOrder(goals, byCreated);

export async function listGoals() {
	const doc = await loadDocument();

	return sortGoals(doc.goals.filter((goal) => isLive(goal) && isGoal(goal)));
}

export async function getGoal(id) {
	const goal = await getGoalEntry(id);

	return isGoal(goal) ? goal : null;
}

// {kind: 'set', catalog, target, level, name}, {kind: 'artist', target,
// name}, or {kind: 'pokemon', target: <dex>, name, languages}. A goal
// already kept for the same set, illustrator, or Pokémon is returned as it
// is (its level and languages change on its own screen). A Pokémon goal's
// languages: the codes picked, every one of them too, or null for Any
// language (ANY_POKEMON_LANGUAGE).
export async function createGoal({catalog = 'international', kind, languages = null, level = null, name = '', target}) {
	if (!GOAL_KINDS.includes(kind)) {
		throw new Error(`Unknown goal kind ${kind}.`);
	}

	const clean = kind === 'pokemon' && validDex(Number(target)) ? String(Number(target)) : String(kind === 'pokemon' ? '' : target || '').trim();

	if (!clean) {
		throw new Error({artist: 'Type an illustrator\'s name.', pokemon: 'Pick a Pokémon.'}[kind] || 'Pick a set.');
	}

	if (kind === 'set' && !isLevel(level)) {
		throw new Error(`Unknown level ${level}.`);
	}

	if (kind === 'pokemon' && languages !== null && !cleanListLanguages(languages).length) {
		throw new Error('Pick at least one language.');
	}

	const existing = findGoal(await listGoals(), {catalog, kind, target: clean});

	if (existing) {
		return existing;
	}

	const at = nowIso();
	const saved = kind === 'pokemon' ? listLanguagesToSave(languages, {exact: true}) : null;

	return saveNewGoal({
		catalog: kind === 'set' ? catalog : null,
		created_at: at,
		deleted_at: null,
		id: newId(),
		kind,
		...(saved ? {languages: saved} : {}),
		level: kind === 'set' ? level : null,
		name: String(name || '').trim() || (kind === 'pokemon' ? numberName(Number(clean)) : clean),
		target: clean,
		updated_at: at,
	}, isGoal);
}

// The name a Pokémon goal gets when the species' name is not on the phone
// (made offline before the names were ever read), as js/checklists.js
// nameOf names a Pokémon then.
export const numberName = (n) => `Pokémon ${dexLabel(n)}`;

// The species' name for a Pokémon goal still named by its number, once
// names (speciesNames().en) has it; else null. A name the person typed is
// never replaced.
export function speciesRename(goal, names) {
	const n = goalDex(goal);

	return n && goal.name === numberName(n) && names && names[n] ? names[n] : null;
}

// Renames such a goal, and resolves the goal as saved, or null when it
// keeps its name.
export async function nameFromSpecies(goal, names) {
	const name = speciesRename(goal, names);

	return name ? renameChecklist(goal.id, name) : null;
}

export const setGoalLevel = (id, level) => changeGoal(id, (goal) => {
	if (goal.kind !== 'set' || !isLevel(level)) {
		throw new Error(`Unknown level ${level}.`);
	}

	goal.level = level;
});

// ------------------------------------------------------------- loading

// What a goal could not read, as gaps: {kind: 'list', catalog} for a
// catalog whose card list is not on the phone (offline before its first
// visit, or its download failed), {kind: 'sets', catalog, count, setIds}
// for sets whose details could not be read, and {kind: 'index', catalog:
// 'international'} for the set index. With a gap the cards are not all
// there or not all dated, so a binder keeps its pages as they were
// (js/binder-sources.js loadRuleItems incomplete), unless it keeps its
// pockets in place and only undated cards already in it are concerned
// (js/binder-rules.js layoutWaits), and the goal's screen says which
// (gapText).
const printsName = (catalog) => (catalog === 'international' ? 'international prints' : `${languageLabel(catalog)} prints`);

// The gaps in words: "The Japanese prints are not on this phone yet."
// online: whether the phone is online, which turns "not on this phone yet"
// into "did not load".
export function gapText(gaps, {online = true} = {}) {
	return (gaps || []).map((gap) => {
		const name = printsName(gap.catalog);

		if (gap.kind === 'sets') {
			return `${gap.count === 1 ? '1 set' : `${gap.count} sets`} of ${name} could not be read, so their cards have no set name or date yet.`;
		}

		if (gap.kind === 'index') {
			return `The list of sets is not on this phone yet, so the ${name} have no set name or date yet.`;
		}

		return online ? `The ${name} did not load.` : `The ${name} are not on this phone yet.`;
	}).join(' ');
}

// A Pokémon goal's cards: each catalog its languages need, as the Pokémon
// screen loads it (cache first, kept on the phone). missingList when no
// catalog's card list is on the phone; incomplete, with its gaps, when any
// catalog's list, set, or the set index is not.
async function loadPokemonGoalCards(goal) {
	const n = goalDex(goal);

	if (!n) {
		return {cards: [], error: new Error('This goal names no Pokémon.'), gaps: [], incomplete: true, missingList: true, set: null};
	}

	const results = await Promise.all(goalCatalogs(goal).map((catalog) => (catalog === 'international' ? loadInternational(n) : loadAsian(catalog, n)).then(
		(result) => ({...result, catalog}),
		(error) => ({catalog, error, missingList: true, prints: []})
	)));
	const error = (results.find((result) => result.error) || {}).error || null;
	const read = results.filter((result) => !result.missingList);
	const gaps = results.flatMap((result) => {
		if (result.missingList) {
			return [{catalog: result.catalog, kind: 'list'}];
		}

		return [
			...(result.unreadSets ? [{catalog: result.catalog, count: result.unreadSets, kind: 'sets', setIds: result.unreadSetIds || []}] : []),
			...(result.setIndexMissing ? [{catalog: result.catalog, kind: 'index'}] : []),
		];
	});

	if (!read.length) {
		return {cards: [], error, gaps, incomplete: true, missingList: true, set: null};
	}

	return {cards: pokemonGoalCards(read, n), error, gaps, incomplete: gaps.length > 0, missingList: false, set: null};
}

// A goal's cards: {cards, set, error, missingList, incomplete, gaps}.
// missingList when nothing about the set, the illustrator, or the Pokémon is
// on the phone (offline before the first visit, or TCGdex failing); error is
// the first failure. incomplete, with gaps (gapText), when an artist or
// Pokémon goal could read some of its catalogs and not others, or could not
// date its cards: its cards are not the whole list yet.
export async function loadGoalCards(goal) {
	if (goal.kind === 'pokemon') {
		return loadPokemonGoalCards(goal);
	}

	if (goal.kind === 'set') {
		const catalog = goal.catalog || 'international';
		const [set, details] = await Promise.all([
			setDetail(catalogLanguage(catalog), goal.target).then((hit) => ({data: hit.data, error: null}), (error) => ({data: null, error})),
			setCards(catalog, goal.target).then((hit) => ({data: hit.data, error: null}), (error) => ({data: null, error})),
		]);
		const error = set.error || details.error;

		if (!set.data && !details.data) {
			return {cards: [], error, gaps: [], incomplete: true, missingList: true, set: null};
		}

		return {
			cards: setLevelCards({catalog, details: details.data, level: goal.level, set: set.data, setId: goal.target}),
			error,
			gaps: [],
			incomplete: false,
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
	const gaps = [
		...lists.filter((list) => !list.cards).map((list) => ({catalog: list.catalog, kind: 'list'})),
		...(read.some((list) => list.catalog === 'international') && !(sets && sets.data) ? [{catalog: 'international', kind: 'index'}] : []),
	];

	if (!read.length) {
		return {cards: [], error, gaps, incomplete: true, missingList: true, set: null};
	}

	return {cards: artistGoalCards({lists: read, sets: (sets && sets.data) || {}}), error, gaps, incomplete: gaps.length > 0, missingList: false, set: null};
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
