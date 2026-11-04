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

import {asianNameEntries, matchCjkNames} from './cjk.js';
import {matchNames, nameKey} from './evidence.js';

export const LOCAL_NAMES_URL = new URL('./local-names.json', import.meta.url).href;

// The Japanese and Korean names (js/scan/asian-names.json, about 43 KB, 17 KB
// gzipped, built by the same lab/names/build.mjs), fetched only the first
// time a Japanese or Korean name is read (js/scan/cjk.js), and precached by
// the service worker like the Western table.
export const ASIAN_NAMES_URL = new URL('./asian-names.json', import.meta.url).href;

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

let asianLoading = null;

// The Asian table's entries (js/scan/cjk.js asianNameEntries), each species
// with its English name from the Western table, fetched once. A failed fetch
// resolves to no entries and is tried again next time.
export function loadAsianNames({fetchImpl = (...args) => fetch(...args), local = () => loadLocalNames(), url = ASIAN_NAMES_URL} = {}) {
	if (!asianLoading) {
		asianLoading = Promise.all([
			Promise.resolve().then(() => fetchImpl(url)).then((response) => {
				if (!response.ok) {
					throw new Error(`The Asian name table answered ${response.status}.`);
				}

				return response.json();
			}),
			Promise.resolve().then(local).catch(() => []),
		])
			.then(([table, western]) => {
				const english = [];

				for (const entry of western || []) {
					if (entry.dex && entry.lang === 'en') {
						english[entry.dex - 1] = entry.name;
					}
				}

				return asianNameEntries(table, english);
			})
			.catch(() => {
				asianLoading = null;

				return [];
			});
	}

	return asianLoading;
}

// The best table score (0 to 1) of a Japanese or Korean name read, for
// read.js, which tries the other model when the first reads no name.
export async function asianNameScore(text, {load = loadAsianNames} = {}) {
	const [best] = matchCjkNames(text, await load(), {limit: 1, min: 0});

	return best ? best.score : 0;
}

// The best score (0 to 1) of a Latin name read against the Western names
// (every species in English, French, and German, and the Trainers), for
// read.js: an English read of the name strip that names nothing may be a
// Japanese or Korean name the English model cannot read. null when the
// table could not be loaded (offline before the service worker kept it):
// with no names to ask, a score of 0 would call every Latin card's name
// unknown, and read.js takes null as "do not load a model".
export async function latinNameScore(text, {load = loadLocalNames} = {}) {
	const entries = await load();

	if (!entries || !entries.length) {
		return null;
	}

	const [best] = matchNames(text, entries, {limit: 1, min: 0.5});

	return best ? best.score : 0;
}
