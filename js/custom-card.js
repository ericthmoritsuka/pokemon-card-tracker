// Hand-made cards: cards the catalog does not have (an Asian set TCGdex
// lists with no cards, a promo numbered past the set's list, an energy with
// a letter for a number), added by hand (DESIGN.md section 4, "Hand-made
// cards", 2026-10-03).
//
// A hand-made card is no new kind of record. Each copy is an ordinary entry
// of the document, so it syncs, merges, exports, and sits in binders like
// any other, on the catalog "custom" with a card id made up once,
// "hand_<32 hex>". The card's own facts ride on every copy: the name and
// set name in name_local and set_name_local (the fields the import already
// uses for names the catalog lacks), the printed number in number_local,
// and the set code in set_code. Editing the card changes them on every
// copy.
//
// Nothing here touches the DOM, so Node tests it (tests/custom-cards.test.mjs);
// js/custom-card-view.js draws the sheet and the card page.

import {catalogFor, catalogLanguage, isLanguage} from './catalog.js';
import {newId} from './collection.js';

export const CUSTOM = 'custom';

export const isCustomId = (id) => /^hand_[0-9a-f]{32}$/.test(String(id || ''));

export const isCustom = (entry) => Boolean(entry) && entry.catalog === CUSTOM;

export const newCustomCardId = () => `hand_${newId().replace(/-/g, '').toLowerCase()}`;

// A hand-made card's page: cards/<language>/<card id>, the route of every
// card page (app.js accepts only the app's languages there, so a German,
// Italian, or Spanish copy uses English). Card detail tells it by its id.
export const customRoute = (cardId, language = 'en') => `cards/${isLanguage(language) ? language : 'en'}/${encodeURIComponent(cardId)}`;

export const NAME_MAX = 80;

export const SET_MAX = 80;

export const NUMBER_MAX = 20;

const text = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// The card-level fields from a form ({name, setName, setCode, number}),
// cleaned, with the problems found. A name is required; set and number are
// optional, since a card can have neither printed (a basic energy).
export function cardFields({name, number, setCode, setName}) {
	const fields = {
		name_local: text(name, NAME_MAX) || null,
		number_local: text(number, NUMBER_MAX) || null,
		set_code: text(setCode, 20) || null,
		set_name_local: text(setName, SET_MAX) || null,
	};
	const problems = [];

	if (!fields.name_local) {
		problems.push('Give the card a name.');
	}

	return {fields, problems};
}

// The entries for a new hand-made card: count copies of one card id, alike
// in language, finish, and condition. Throws with the problems when the
// form is not complete.
export function customEntries({cardId = newCustomCardId(), condition = null, count = 1, finish = null, language, name, number, setCode, setName}) {
	const {fields, problems} = cardFields({name, number, setCode, setName});

	if (!language) {
		problems.push('Pick the language the card is printed in.');
	}

	if (!Number.isInteger(count) || count < 1) {
		problems.push('Add at least one copy.');
	}

	if (problems.length) {
		throw new Error(problems.join(' '));
	}

	const entry = {
		...fields,
		card_id: cardId,
		catalog: CUSTOM,
		language,
		language_source: 'manual',
		variant_id: null,
	};

	if (finish) {
		entry.finish_raw = finish;
	}

	if (condition) {
		entry.condition = condition;
	}

	return Array.from({length: count}, () => ({...entry}));
}

// The record a hand-made card stands for, shaped like a card index record
// (js/catalog.js), so My Cards, the export, and the filters read it as they
// read a catalog card. Null for a catalog copy. category is a string, so the
// background pass never asks TCGdex for its details.
export function customRecord(entry) {
	if (!isCustom(entry)) {
		return null;
	}

	return {
		catalog: CUSTOM,
		category: '',
		collector_number: entry.number_local || null,
		custom: true,
		dex_ids: [],
		id: entry.card_id,
		localizations: {
			[entry.language]: {image: null, lang: entry.language, name: entry.name_local || 'Hand-made card', set_name: entry.set_name_local || null},
		},
		official: null,
		rarity: null,
		release_date: '',
		set_id: entry.set_code || null,
		types: [],
	};
}

// One hand-made card from its live copies: {cardId, name, setName, setCode,
// number, entries}, the newest copy's facts winning when two phones edited
// apart. Null when there are no copies.
export function customCard(cards, cardId) {
	const entries = (cards || []).filter((entry) => entry && !entry.deleted_at && entry.catalog === CUSTOM && entry.card_id === cardId);

	if (!entries.length) {
		return null;
	}

	const newest = [...entries].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))[0];

	return {
		cardId,
		entries,
		name: newest.name_local || 'Hand-made card',
		number: newest.number_local || null,
		setCode: newest.set_code || null,
		setName: newest.set_name_local || null,
	};
}

// The patches that put new card-level fields on every copy: only the copies
// and fields that differ, so an untouched copy is never stamped.
export function editPatches(entries, next) {
	const {fields, problems} = cardFields(next);

	if (problems.length) {
		throw new Error(problems.join(' '));
	}

	return entries
		.map((entry) => {
			const patch = {};

			for (const [key, value] of Object.entries(fields)) {
				if ((entry[key] ?? null) !== value) {
					patch[key] = value;
				}
			}

			return {id: entry.id, patch};
		})
		.filter((item) => Object.keys(item.patch).length);
}

// ------------------------------------------------- a catalog card later

// "001", "1", and "TG02" against "TG2": digits compared without leading
// zeros, case ignored, anything after a slash dropped.
export const sameNumber = (a, b) => {
	const clean = (value) => String(value ?? '').split('/')[0].trim().toUpperCase().replace(/\d+/g, (digits) => String(Number(digits)));

	return Boolean(clean(a)) && clean(a) === clean(b);
};

// The catalogs to look for a hand-made card in: the one its language is
// saved in, and for Korean the Japanese one, whose set codes Korean sets
// reuse (DESIGN.md section 5).
export const linkCatalogs = (language) => (language === 'ko' ? ['ko', 'ja'] : [catalogFor(language)]);

// Where to read those catalogs' set lists: [{catalog, lang}]. International
// sets are read in the copy's language when the app has it (a Portuguese
// set name), then in English; the others in their own language.
export const linkLookups = (language) => linkCatalogs(language).flatMap((catalog) => (catalog === 'international'
	? [...new Set([isLanguage(language) ? language : 'en', 'en'])].map((lang) => ({catalog, lang}))
	: [{catalog, lang: catalogLanguage(catalog)}]));

// The set in a set list ([{id, name, code}]) a hand-made card names: its set
// code against TCGdex's set id or the printed code (MEE, M6), case ignored,
// then its set name. Null when none fits.
export function findSet(sets, {setCode, setName}) {
	const list = Array.isArray(sets) ? sets : [];
	const code = String(setCode || '').trim().toLowerCase();
	const name = String(setName || '').trim().toLowerCase();

	return (code && list.find((set) => String(set.id).toLowerCase() === code))
		|| (code && list.find((set) => String(set.code || '').toLowerCase() === code))
		|| (name && list.find((set) => String(set.name || '').trim().toLowerCase() === name))
		|| null;
}

// The card of a set ({cards: [{id, localId, name, image}]}) with the hand-made
// card's number, or null. A card with no number never matches.
export function findCatalogCard(set, number) {
	if (!set || !Array.isArray(set.cards) || !number) {
		return null;
	}

	return set.cards.find((card) => sameNumber(card.localId, number)) || null;
}

// The patches that turn a hand-made card's copies into copies of a catalog
// card: same entries (so their photos, notes, prices, and binder pockets
// stay), the catalog card's id, the hand-made facts cleared except the names,
// which stay as the names the source gave (js/collection.js sourceNames).
// A copy whose language belongs to another catalog becomes a fallback copy,
// as a Korean copy on a Japanese record is.
export function linkPatches(entries, {catalog, cardId}) {
	return entries.map((entry) => ({
		id: entry.id,
		patch: {
			card_id: cardId,
			catalog,
			fallback: catalogFor(entry.language) !== catalog,
			number_local: null,
			set_code: null,
			variant_id: null,
		},
	}));
}
