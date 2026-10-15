// Builds js/scan/local-names.json, the scanner's table of Pokémon and
// Trainer names in the languages printed on Western cards, so a name read
// off a Portuguese, French, or German card leads to the card
// (js/scan/local-names.js, js/scan/match.js). A developer tool: nothing in
// the app loads it.
//
// node lab/names/build.mjs [--out js/scan/local-names.json] [--cache <dir>]
//
// Sources, both free, read once here and never by the app:
//
// - PokeAPI species names (https://pokeapi.co, BSD-3-Clause): every
//   species' name in English, French, and German, through its GraphQL API.
//   PokeAPI has no Portuguese names: Portuguese cards print the English
//   names, except the Paradox Pokémon (and Type: Null), which the TCGdex
//   prints give.
// - TCGdex card lists (https://tcgdex.dev, the cards database is MIT
//   licensed): every card's name in English, Portuguese, French, and
//   German. A Pokémon print whose name is neither its species' English nor
//   its local name gives one more spelling (the Portuguese Paradox Pokémon,
//   older French and German spellings); a Trainer printed under another name
//   gives that name, joined to its English one by the card's id (Trainers
//   from Sun & Moon on only, to keep the table small).
//
// --cache keeps the answers in a folder outside the repo, so a rebuild needs
// no network.

import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = Object.fromEntries(process.argv.slice(2)
	.map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : null))
	.filter(Boolean));
const out = resolve(String(args.out || join(ROOT, 'js/scan/local-names.json')));
const cache = args.cache ? resolve(String(args.cache)) : null;

if (cache && cache.startsWith(ROOT + '/')) {
	throw new Error('--cache must be outside the repo.');
}

const MAX_DEX = 1025;
const POKEAPI_LANGUAGES = {5: 'fr', 6: 'de', 9: 'en'};
const CARD_LANGUAGES = ['pt', 'fr', 'de'];

async function cached(name, load) {
	if (cache) {
		try {
			return JSON.parse(await readFile(join(cache, name), 'utf8'));
		}
		catch {
			// Not kept yet.
		}
	}

	const data = await load();

	if (cache) {
		await mkdir(cache, {recursive: true});
		await writeFile(join(cache, name), JSON.stringify(data));
	}

	return data;
}

async function post(url, query) {
	const response = await fetch(url, {body: JSON.stringify({query}), headers: {'content-type': 'application/json'}, method: 'POST'});

	if (!response.ok) {
		throw new Error(`${url} answered ${response.status}`);
	}

	const json = await response.json();

	if (json.errors) {
		throw new Error(`${url}: ${json.errors[0].message}`);
	}

	return json.data;
}

const species = await cached('pokeapi-species.json', () => post('https://graphql.pokeapi.co/v1beta2',
	`{ pokemonspeciesname(where: {language_id: {_in: [${Object.keys(POKEAPI_LANGUAGES).join(', ')}]}, pokemon_species_id: {_lte: ${MAX_DEX}}}) { language_id name pokemon_species_id } }`));

// Every card, in one language. TCGdex's id filter matches a substring, and
// every card id holds a dash.
const cardsIn = (lang) => cached(`tcgdex-${lang}.json`, async () => (await post('https://api.tcgdex.net/v2/graphql',
	`{ cards(filters: {id: "-"}, pagination: {page: 1, itemsPerPage: 50000})${lang === 'en' ? '' : ` @locale(lang: "${lang}")`} { id name category dexId } }`)).cards);

const fold = (text) => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

const names = {de: [], en: [], fr: []};

for (const row of species.pokemonspeciesname) {
	const lang = POKEAPI_LANGUAGES[row.language_id];

	if (lang && row.pokemon_species_id >= 1 && row.pokemon_species_id <= MAX_DEX) {
		names[lang][row.pokemon_species_id - 1] = row.name;
	}
}

for (let dex = 1; dex <= MAX_DEX; dex++) {
	if (!names.en[dex - 1]) {
		throw new Error(`PokeAPI gave no English name for #${dex}.`);
	}
}

// The words a print adds to its species' name: mechanic suffixes and marks
// ("Raio Fúria ex", "Stollos-ex", "Knackrak C", "Frosdeje GL", "Skorgo 4"),
// and the owner of a Pokémon ("Carchacrock-ex de Cynthia").
const MARKS = /(?:[\s-]+(?:ex|EX|GX|V|VMAX|VSTAR|V-UNION|BREAK|LV\.X|GL|FB|C|G|4|δ|◇|☆|Prism Star))+$/u;

function baseName(name) {
	return String(name || '').replace(/\s+de\s+\S+$/u, '').replace(MARKS, '').trim();
}

const english = new Map((await cardsIn('en')).map((card) => [card.id, card]));
const prints = new Map();
const trainers = new Map();
// Trainers from Sun & Moon on (TCGdex set ids sm, swsh, sv, me, and their
// promos): the era the family's Portuguese cards come from. Every era's
// Trainers would take 34 KB gzipped rather than 22 KB.
const TRAINER_SETS = /^(sm|swsh|sv|me)/;
const trainerName = (name) => String(name || '').replace(/\s*\([^)]*\)\s*$/u, '').replace(/\s*[\u2013\u2014]\s*/gu, ' - ').trim();
const isTrainer = (card) => ['Trainer', 'Treinador', 'Dresseur', 'Trainer', 'Allenatore', 'Entrenador'].includes(card.category);

for (const lang of CARD_LANGUAGES) {
	for (const card of await cardsIn(lang)) {
		if (!card || !card.name) {
			continue;
		}

		const en = english.get(card.id);

		if (isTrainer(card)) {
			// The name strip prints the name without the subtitle TCGdex adds
			// in brackets ("Professor's Research (Professor Magnolia)"), and
			// a dash the way the OCR reads one.
			const local = trainerName(card.name);
			const name = en && trainerName(en.name);

			if (TRAINER_SETS.test(card.id) && name && fold(name) !== fold(local) && fold(local).length >= 3) {
				if (!trainers.has(name)) {
					trainers.set(name, new Set());
				}

				trainers.get(name).add(local);
			}

			continue;
		}

		const dex = Array.isArray(card.dexId) && card.dexId.length === 1 ? card.dexId[0] : null;

		if (!dex || dex > MAX_DEX) {
			continue;
		}

		const base = baseName(card.name);
		const key = fold(base);
		const known = [names.en[dex - 1], names.fr[dex - 1], names.de[dex - 1]].filter(Boolean).map(fold);

		if (key.length < 3 || /\d/.test(base) || known.some((name) => key.includes(name))) {
			continue;
		}

		if (!prints.has(dex)) {
			prints.set(dex, new Set());
		}

		prints.get(dex).add(base);
	}
}

// Trainer spellings that differ only in accents, case, or punctuation from
// another kept one are kept once.
const distinct = (list) => {
	const seen = new Set();

	return list.filter((name) => {
		const key = fold(name);

		if (seen.has(key)) {
			return false;
		}

		seen.add(key);

		return true;
	});
};

const table = {
	about: 'Pokémon and Trainer names printed on Western cards, for the scanner\'s name route (js/scan/local-names.js). Built by lab/names/build.mjs from PokeAPI species names (BSD-3-Clause) and TCGdex card names (MIT). species: names by National Dex number less one, a language\'s left empty where it folds to the English. prints: other spellings TCGdex prints carry, as [dex, ...names]. trainers: [English, ...other names].',
	built: new Date().toISOString().slice(0, 10),
	species: {
		de: names.de.map((name, i) => (name && fold(name) !== fold(names.en[i]) ? name : '')).join('|'),
		en: names.en.join('|'),
		fr: names.fr.map((name, i) => (name && fold(name) !== fold(names.en[i]) ? name : '')).join('|'),
	},
	prints: [...prints].sort((a, b) => a[0] - b[0]).map(([dex, set]) => [dex, ...distinct([...set].sort())]),
	trainers: [...trainers].sort((a, b) => a[0].localeCompare(b[0])).map(([name, set]) => [name, ...distinct([...set].sort())]),
};

const text = JSON.stringify(table);

await writeFile(out, text + '\n');
console.log(`${out}: ${text.length} bytes; ${table.prints.length} species with other print spellings, ${table.trainers.length} Trainers (${table.trainers.reduce((sum, row) => sum + row.length - 1, 0)} other names)`);
