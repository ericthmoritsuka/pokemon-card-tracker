// The reference set of the embedding experiment, and its images.
//
// node lab/embedding/refs.mjs <scan-log.json>... [--extra <crops.json>]
//
// A first answer does not need all 25,767 catalog images, so the set is:
//
// 1. Every English card of the Scarlet & Violet (`sv`) and Mega Evolution
//    (`me`) series with an image.
// 2. Every Portuguese card of those series with its own image (the app's
//    index uses the English image instead; here both are kept, both count
//    as the right card, and whether the Portuguese image helps is measured).
// 3. Every card in the same artwork group of the fingerprint index as a
//    card saved in the logs: the Japanese twins, and older reprints.
// 4. Every card of the fingerprint's top 50 groups for each log crop as
//    kept, so the cards the hash finds hardest to tell apart are in, and a
//    re-rank of the hash's top 50 is mostly inside the set.
// 5. --extra: a JSON list of card ids or {catalog, id} to add (the cards
//    seen in the video crops).
//
// Writes $EMB_CACHE/refs.json ([{catalog, id, image, set, group}]: group is
// the fingerprint index's artwork group, so every method is scored by group
// as lab/holder/crops.mjs scores the hash) and downloads each card's
// low.webp into $EMB_CACHE/images, four at a time, cached, 404s remembered
// (lab/fingerprints/catalog.mjs). Never inside the repo.

import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {cachedJson, downloadImages, imageParts} from '../fingerprints/catalog.mjs';
import {args as parseArgs, dataUrlBytes, decodeImage, loadFingerprintIndex, outside, readLogs} from '../holder/lib.mjs';
import {hashMatch} from './hash.mjs';
import {refKey} from './lib.mjs';

const opts = parseArgs();
const cache = outside(process.env.EMB_CACHE || '/tmp/emb/tcgdex');

mkdirSync(cache, {recursive: true});

const index = loadFingerprintIndex();
const byKey = new Map();

for (let i = 0; i < index.count; i++) {
	const card = index.card(i);

	byKey.set(refKey(card), {...card, group: index.group[i]});
}

// A Portuguese card shares its English record's group (same id, same art).
const groupOf = (catalog, id) => {
	const own = byKey.get(`${catalog}:${id}`) || (catalog === 'pt' ? byKey.get(`en:${id}`) : null);

	return own ? own.group : `own:${catalog}:${id}`;
};

const refs = new Map();
const why = {};

function add(card, reason) {
	const key = refKey(card);

	if (refs.has(key) || !card.image) {
		return;
	}

	refs.set(key, {catalog: card.catalog, group: groupOf(card.catalog, card.id), id: card.id, image: card.image, set: card.set});
	why[reason] = (why[reason] || 0) + 1;
}

for (const lang of ['en', 'pt']) {
	const list = await cachedJson(cache, `${lang}/cards`, `cards-${lang}.json`);

	for (const card of list) {
		if (!card.image) {
			continue;
		}

		const parts = imageParts(card.image);

		if (parts.series === 'sv' || parts.series === 'me') {
			add({catalog: lang, id: card.id, image: card.image, set: parts.set}, `${lang} sv and me`);
		}
	}
}

const entries = readLogs(opts._).filter((e) => e.picture && e.truth);
const truthGroups = new Set(entries.map((e) => groupOf('en', e.truth)));

for (const card of byKey.values()) {
	if (truthGroups.has(card.group)) {
		add(card, 'artwork twins of saved cards');
	}
}

for (const entry of entries) {
	const {groups} = hashMatch(index, decodeImage(dataUrlBytes(entry.picture)), {top: 50});

	for (const g of groups) {
		for (const c of g.cards) {
			add(byKey.get(refKey(c)), 'hash top 50 of log crops');
		}
	}
}

if (opts.extra) {
	for (const item of JSON.parse(readFileSync(opts.extra, 'utf8'))) {
		const ref = typeof item === 'string' ? {catalog: 'en', id: item} : item;
		const known = byKey.get(refKey(ref));

		if (known) {
			add(known, 'extra');

			for (const card of byKey.values()) {
				if (card.group === known.group) {
					add(card, 'extra');
				}
			}
		}
	}
}

const list = [...refs.values()];

writeFileSync(join(cache, 'refs.json'), JSON.stringify(list));
console.log(`${list.length} reference cards:`, why);

const result = await downloadImages(cache, list, {concurrency: 4, log: console.log});

console.log('download', result);
