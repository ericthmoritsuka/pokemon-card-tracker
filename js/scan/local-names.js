// Pokémon and Trainer names as Western cards print them, for the name
// route (js/scan/match.js): a Portuguese "Presa Grande ex", a French
// "Bulbizarre", or a German "Forschung des Professors" read off a card's
// name strip leads to the card, whose international record is English
// ("Great Tusk ex", "Bulbasaur", "Professor's Research").
//
// The table (js/scan/local-names.json, about 80 KB, 36 KB gzipped) is built
// by lab/names/build.mjs from PokeAPI species names (BSD-3-Clause) and
// TCGdex card names (MIT): every species in English, French, and German,
// the other spellings prints carry (the Portuguese Paradox Pokémon, older
// French and German ones), and the Trainers from Sun & Moon on under their
// Portuguese, French, and German names. It is fetched the first time a
// name is looked up, kept in memory, and precached by the service worker,
// so it works offline.
//
// Pure apart from loadLocalNames: Node tests the rest (tests/scan.test.mjs).

import {nameKey} from './evidence.js';

export const LOCAL_NAMES_URL = new URL('./local-names.json', import.meta.url).href;

// The table as entries for evidence.js matchNames: [{dex, name, english,
// lang, key}]. dex is the National Dex number (null for a Trainer); english
// the English name the catalog's international records use, left out when
// name is that name; lang the language a spelling comes from ('en', 'fr',
// 'de', or 'print' for a print's own spelling, 'trainer' for a Trainer's
// other name).
export function localNameEntries(table) {
	const entries = [];
	const add = (dex, name, english, lang) => {
		const key = nameKey(name);

		if (name && key.length >= 3) {
			entries.push({dex, key, lang, name, ...(english && english !== name ? {english} : {})});
		}
	};
	const split = (text) => String(text || '').split('|');
	const species = (table && table.species) || {};
	const en = split(species.en);

	en.forEach((name, i) => add(i + 1, name, null, 'en'));

	for (const lang of Object.keys(species).filter((code) => code !== 'en')) {
		split(species[lang]).forEach((name, i) => {
			if (name && en[i]) {
				add(i + 1, name, en[i], lang);
			}
		});
	}

	for (const [dex, ...names] of (table && table.prints) || []) {
		for (const name of names) {
			if (en[dex - 1]) {
				add(dex, name, en[dex - 1], 'print');
			}
		}
	}

	for (const [english, ...names] of (table && table.trainers) || []) {
		add(null, english, null, 'en');

		for (const name of names) {
			add(null, name, english, 'trainer');
		}
	}

	return entries;
}

let loading = null;

// The table's entries, fetched once. A failed fetch (offline before the
// service worker kept it) resolves to no entries and is tried again next
// time.
export function loadLocalNames({fetchImpl = (...args) => fetch(...args), url = LOCAL_NAMES_URL} = {}) {
	if (!loading) {
		loading = Promise.resolve()
			.then(() => fetchImpl(url))
			.then((response) => {
				if (!response.ok) {
					throw new Error(`The name table answered ${response.status}.`);
				}

				return response.json();
			})
			.then(localNameEntries)
			.catch(() => {
				loading = null;

				return [];
			});
	}

	return loading;
}
