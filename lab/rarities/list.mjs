// Lists every rarity value TCGdex gives its cards, in English and in
// Portuguese, with how many cards and sets carry each, and marks the ones the
// Star rule covers (js/collections.js STAR_RARITIES), so whether the rule
// misses an era's own name for an illustration rare can be decided from the
// data (DESIGN.md section 13, "Verify Before Building"). A developer tool:
// nothing in the app loads it, and it changes nothing.
//
// node lab/rarities/list.mjs --cache <dir> [--out <file.md>]
//
// Two requests in all, one per language: TCGdex's GraphQL endpoint gives
// every card's id, rarity, and set in one answer (`@locale` for Portuguese,
// as lab/names/build.mjs reads names). --cache keeps the answers in a folder
// outside the repo, so a rerun sends none.
//
// Rules match the English value (DESIGN.md section 3: the card index reads
// rarity from the English GraphQL answer, and a Portuguese record translates
// it), so the English table is the one that decides; the Portuguese one
// shows which English value each Portuguese word stands for, joined by card
// id.

import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = Object.fromEntries(process.argv.slice(2)
	.map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : null))
	.filter(Boolean));
const cache = args.cache ? resolve(String(args.cache)) : null;
const out = args.out ? resolve(String(args.out)) : null;

if (cache && (cache === ROOT || cache.startsWith(ROOT + '/'))) {
	throw new Error('--cache must be outside the repo.');
}

const GRAPHQL = 'https://api.tcgdex.net/v2/graphql';

// The Star rule's values, read from js/collections.js's source: the module
// itself reads IndexedDB and cannot load in Node.
const source = await readFile(join(ROOT, 'js/collections.js'), 'utf8');
const STAR_RARITIES = JSON.parse((/export const STAR_RARITIES = (\[[^\]]*\]);/.exec(source) || [])[1].replace(/'/g, '"'));
const LANGUAGES = ['en', 'pt'];

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

async function post(query) {
	const response = await fetch(GRAPHQL, {body: JSON.stringify({query}), headers: {'content-type': 'application/json'}, method: 'POST'});

	if (!response.ok) {
		throw new Error(`${GRAPHQL} answered ${response.status}`);
	}

	const json = await response.json();

	if (json.errors) {
		throw new Error(`${GRAPHQL}: ${json.errors[0].message}`);
	}

	return json.data;
}

// Every card in one language. TCGdex's id filter matches a substring, and
// every card id holds a dash.
const cardsIn = (lang) => cached(`tcgdex-rarity-${lang}.json`, async () => (await post(
	`{ cards(filters: {id: "-"}, pagination: {page: 1, itemsPerPage: 50000})${lang === 'en' ? '' : ` @locale(lang: "${lang}")`} { id rarity set { id name } } }`
)).cards);

const NONE = '(none)';
const star = new Set(STAR_RARITIES);
const cards = {};

for (const lang of LANGUAGES) {
	cards[lang] = await cardsIn(lang);
}

// The app drops TCGdex's "None" as it reads a record (js/catalog.js), so it
// is counted with the cards that have no rarity at all.
const rarityOf = (card) => (typeof card.rarity === 'string' && card.rarity && card.rarity !== 'None' ? card.rarity : NONE);

function tally(list) {
	const byRarity = new Map();

	for (const card of list) {
		const rarity = rarityOf(card);
		const row = byRarity.get(rarity) || {cards: 0, rarity, sets: new Map()};
		const set = card.set || {};

		row.cards++;
		row.sets.set(set.id || card.id.slice(0, card.id.lastIndexOf('-')), set.name || null);
		byRarity.set(rarity, row);
	}

	return [...byRarity.values()].sort((a, b) => b.cards - a.cards || a.rarity.localeCompare(b.rarity));
}

// A few of the sets that carry a value, so its era shows.
const sample = (sets, n = 4) => {
	const ids = [...sets.keys()];

	return ids.slice(0, n).join(', ') + (ids.length > n ? `, and ${ids.length - n} more` : '');
};

const lines = [];
const english = tally(cards.en);
const englishOf = new Map(cards.en.map((card) => [card.id, rarityOf(card)]));

lines.push(`# TCGdex rarity values (${new Date().toISOString().slice(0, 10)})`, '');
lines.push(`English: ${cards.en.length} cards, ${english.length} values. Portuguese: ${cards.pt.length} cards.`, '');
lines.push('## English, which rules match', '');
lines.push('| Rarity | Cards | Sets | Star | Some sets |', '| --- | ---: | ---: | --- | --- |');

for (const row of english) {
	lines.push(`| ${row.rarity} | ${row.cards} | ${row.sets.size} | ${star.has(row.rarity) ? 'yes' : ''} | ${sample(row.sets)} |`);
}

lines.push('', '## Portuguese, and the English value of the same card', '');
lines.push('| Rarity (pt) | Cards | English values |', '| --- | ---: | --- |');

for (const row of tally(cards.pt)) {
	const matched = new Map();

	for (const card of cards.pt) {
		if (rarityOf(card) === row.rarity) {
			const en = englishOf.get(card.id) || '(no English record)';

			matched.set(en, (matched.get(en) || 0) + 1);
		}
	}

	lines.push(`| ${row.rarity} | ${row.cards} | ${[...matched].sort((a, b) => b[1] - a[1]).map(([value, n]) => `${value}${star.has(value) ? ' (Star)' : ''} ${n}`).join('; ')} |`);
}

const text = lines.join('\n') + '\n';

if (out) {
	await writeFile(out, text);
}

process.stdout.write(text);
