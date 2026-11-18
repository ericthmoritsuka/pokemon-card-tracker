// Builds the names table beside the fingerprint index, so the scanner can
// name a picture match's cards without asking TCGdex for their sets.
//
// node lab/fingerprints/build-names.mjs [--index <file>] [--out <file>]
//
// Reads the packed index (js/vision/index.bin by default), asks TCGdex once
// for every set it holds (one request per catalog and set, kept in the cache
// below, so a rebuild needs no network), and writes js/vision/index-names.json:
//
//   {built, index, count, sets: {"<catalog>|<set>": [name, official, releaseDate]},
//    cards: {"<catalog>|<set>": {"<card id>": name}}}
//
// `index` is the index's own `built` stamp: js/scan/picture.js uses the
// table only for an index built at that time, so a rebuilt index never
// meets a table written for an older one. A card the set's record does not
// list is left out, and the scanner asks TCGdex for its set, as before.
//
// FP_CACHE=<dir> is where the answers are kept (default
// ~/.cache/pokemon-card-tracker-fingerprints, the index builder's cache);
// it must be outside the repo.

import {readFile, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join, relative, resolve} from 'node:path';

import {cachedJson} from './catalog.mjs';
import {REPO} from './serve.mjs';
import {unpackIndex} from '../../js/vision/pack.js';

const args = Object.fromEntries(process.argv.slice(2)
	.map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : null))
	.filter(Boolean));

const CACHE = resolve(process.env.FP_CACHE || join(homedir(), '.cache/pokemon-card-tracker-fingerprints'));

if (!relative(REPO, CACHE).startsWith('..')) {
	throw new Error('FP_CACHE must be outside the repo.');
}

const indexFile = resolve(String(args.index || join(REPO, 'js/vision/index.bin')));
const out = resolve(String(args.out || join(REPO, 'js/vision/index-names.json')));
const bytes = await readFile(indexFile);
const index = unpackIndex(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
const pairs = new Map();

for (let i = 0; i < index.count; i++) {
	const card = index.card(i);
	const key = `${card.catalog}|${card.set}`;

	if (!pairs.has(key)) {
		pairs.set(key, []);
	}

	pairs.get(key).push(card.id);
}

const keys = [...pairs.keys()].sort();
const sets = {};
const cards = {};
const missing = [];
let next = 0;
let done = 0;

async function worker() {
	while (next < keys.length) {
		const key = keys[next++];
		const [catalog, setId] = key.split('|');
		let set = null;

		try {
			set = await cachedJson(CACHE, `${catalog}/sets/${encodeURIComponent(setId)}`, `names-set-${catalog}-${setId.replace(/[^\w.-]/g, '_')}.json`);
		}
		catch (err) {
			console.warn(`${key}: ${err.message}`);
		}

		const byId = new Map(((set && set.cards) || []).map((card) => [card.id, card.name]));
		const names = {};

		for (const id of pairs.get(key)) {
			if (byId.get(id)) {
				names[id] = byId.get(id);
			}
			else {
				missing.push(`${catalog}|${id}`);
			}
		}

		if (set) {
			sets[key] = [set.name || setId, (set.cardCount && set.cardCount.official) || null, set.releaseDate || ''];
		}

		cards[key] = names;
		done++;

		if (done % 25 === 0) {
			console.log(`${done} of ${keys.length} sets`);
		}
	}
}

await Promise.all(Array.from({length: 4}, worker));

const sorted = (object) => Object.fromEntries(Object.keys(object).sort().map((key) => [key, object[key]]));
const table = {
	built: new Date().toISOString(),
	cards: Object.fromEntries(Object.keys(cards).sort().map((key) => [key, sorted(cards[key])])),
	count: index.count - missing.length,
	index: index.header.built,
	sets: sorted(sets),
};

await writeFile(out, `${JSON.stringify(table)}\n`);
console.log(`${relative(REPO, out)}: ${table.count} of ${index.count} cards named, ${Object.keys(sets).length} of ${keys.length} sets; ${missing.length} cards left to TCGdex`);

if (missing.length) {
	console.log(`Left out, first 20: ${missing.slice(0, 20).join(', ')}`);
}
