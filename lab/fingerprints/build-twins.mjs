// Builds the list of index cards that have an image-less twin, so the
// scanner never takes one for sure on its picture alone (a scanner review,
// 2026-11-19: a Portuguese McDonald's Collection 2021 Charmander came out
// sure as Burning Shadows' sm3-18, whose artwork Kagemaru Himeno drew for
// both; TCGdex has no image of the McDonald's card, so the index cannot hold
// it).
//
// node lab/fingerprints/build-twins.mjs [--out <file>]
//
// Reads the card lists the index builder keeps (catalog.mjs), then asks
// TCGdex's GraphQL once for each name an image-less card bears (every card
// of that name, with its illustrator; kept in the cache below, so a rebuild
// needs no network), and writes js/vision/index-twins.json:
//
//   {built, count, twins: {"<card id>": ["<twin id>", ...]}}
//
// A twin is a card with no image in English or Portuguese (so not in the
// index) whose name and illustrator are those of an index card. The same
// illustrator does not always mean the same artwork (Mitsuhiro Arita drew
// many Charmanders), so a twin only asks for the number to be read; it never
// changes which card the picture names. TCG Pocket's digital cards are left
// out on both sides, as the index leaves them out.
//
// FP_CACHE=<dir> is where the answers are kept (default
// ~/.cache/pokemon-card-tracker-fingerprints, the index builder's cache);
// it must be outside the repo.

import {mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join, relative, resolve} from 'node:path';

import {cachedJson} from './catalog.mjs';
import {REPO} from './serve.mjs';

const args = Object.fromEntries(process.argv.slice(2)
	.map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : null))
	.filter(Boolean));

const CACHE = resolve(process.env.FP_CACHE || join(homedir(), '.cache/pokemon-card-tracker-fingerprints'));

if (!relative(REPO, CACHE).startsWith('..')) {
	throw new Error('FP_CACHE must be outside the repo.');
}

const out = resolve(String(args.out || join(REPO, 'js/vision/index-twins.json')));
const GRAPHQL = 'https://api.tcgdex.net/v2/graphql';
const exists = (path) => stat(path).then(() => true, () => false);

// Every international card named `name` (TCGdex matches a part of the
// name), with its illustrator and image.
async function named(name) {
	const file = join(CACHE, 'api', `twins-name-${encodeURIComponent(name)}.json`);

	if (await exists(file)) {
		return JSON.parse(await readFile(file, 'utf8'));
	}

	const query = `{ cards(filters: {name: ${JSON.stringify(name)}}, pagination: {page: 1, itemsPerPage: 1000}) { id name illustrator image } }`;
	const response = await fetch(GRAPHQL, {body: JSON.stringify({query}), headers: {'content-type': 'application/json', 'user-agent': 'pokemon-card-tracker twins list (personal, cached)'}, method: 'POST'});
	const body = response.ok ? await response.json() : null;

	if (!body || !body.data || !Array.isArray(body.data.cards)) {
		throw new Error(`TCGdex GraphQL ${name}: ${response.status} ${JSON.stringify(body && body.errors)}`);
	}

	await mkdir(join(CACHE, 'api'), {recursive: true});
	await writeFile(file, JSON.stringify(body.data.cards));

	return body.data.cards;
}

const key = (text) => String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const pocket = new Set(((await cachedJson(CACHE, 'en/series/tcgp', 'series-en-tcgp.json')).sets || []).map((set) => set.id));
const setOf = (id) => id.slice(0, id.lastIndexOf('-'));
const english = (await cachedJson(CACHE, 'en/cards', 'cards-en.json')).filter((card) => !pocket.has(setOf(card.id)));
const portuguese = new Set((await cachedJson(CACHE, 'pt/cards', 'cards-pt.json')).filter((card) => card.image).map((card) => card.id));
const inIndex = (card) => Boolean(card.image) || portuguese.has(card.id);
const listed = new Set(english.map((card) => card.id));
const names = [...new Set(english.filter((card) => !inIndex(card)).map((card) => card.name))].sort();
const twins = {};
let asked = 0;

for (const name of names) {
	const cards = (await named(name)).filter((card) => listed.has(card.id) && key(card.name) === key(name) && key(card.illustrator));

	asked++;

	if (asked % 100 === 0) {
		console.log(`${asked} of ${names.length} names`);
	}

	for (const lost of cards.filter((card) => !inIndex(card))) {
		for (const kept of cards.filter((card) => inIndex(card) && key(card.illustrator) === key(lost.illustrator))) {
			twins[kept.id] = [...new Set([...(twins[kept.id] || []), lost.id])].sort();
		}
	}
}

const sorted = Object.fromEntries(Object.keys(twins).sort().map((id) => [id, twins[id]]));
const table = {built: new Date().toISOString(), count: Object.keys(sorted).length, twins: sorted};

await writeFile(out, `${JSON.stringify(table)}\n`);
console.log(`${relative(REPO, out)}: ${table.count} index cards with an image-less twin, from ${names.length} names an image-less card bears`);
