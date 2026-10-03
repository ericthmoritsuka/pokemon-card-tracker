// The TCGdex side of the fingerprint index: which cards go in, and their
// low.webp images, downloaded gently into a cache folder outside the repo.
//
// What goes in:
// - English (`en`): every card with an image, except TCG Pocket (`tcgp`),
//   which is a phone game, not a printed card.
// - Portuguese (`pt`): only the cards whose English record has no image
//   (85 on 2026-10-03, the whole of `sm3.5`). Every other Portuguese card
//   has the same id and the same artwork as its English record, so the
//   English image stands in for it.
// - Japanese (`ja`): every card with an image (3,882 on 2026-10-03, the S
//   and SV eras). Korean prints are matched to these by their art.
//
// Every TCGdex answer and image is kept in the cache folder, so a rebuild
// only fetches what is new. Requests go out a few at a time, and a 404 is
// remembered so it is not asked again.

import {mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const API = 'https://api.tcgdex.net/v2';

// Rarities whose cards print the illustration across the whole card,
// without the framed artwork window. On these the art box is part of a
// larger picture, so the whole card's fingerprint carries more weight.
export const FULL_ART_RARITIES = [
	'Black White Rare',
	'Character Rare',
	'Character Super Rare',
	'Full Art Trainer',
	'Hyper rare',
	'Illustration rare',
	'Mega Hyper Rare',
	'Secret Rare',
	'Shiny Ultra Rare',
	'Special illustration rare',
	'Ultra Rare',
];

const exists = (path) => stat(path).then(() => true, () => false);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchRetry(url, {tries = 4} = {}) {
	for (let attempt = 1; ; attempt++) {
		let response;

		try {
			response = await fetch(url, {headers: {'user-agent': 'pokemon-card-tracker fingerprint index (personal, cached)'}});
		}
		catch (err) {
			if (attempt >= tries) {
				throw err;
			}

			await sleep(1000 * attempt * attempt);
			continue;
		}

		if ((response.status === 429 || response.status >= 500) && attempt < tries) {
			await sleep(2000 * attempt * attempt);
			continue;
		}

		return response;
	}
}

// A JSON answer from the TCGdex API, kept in the cache.
export async function cachedJson(cache, path, name) {
	const file = join(cache, 'api', name);

	if (await exists(file)) {
		return JSON.parse(await readFile(file, 'utf8'));
	}

	const response = await fetchRetry(`${API}/${path}`);

	if (!response.ok) {
		throw new Error(`TCGdex ${path}: ${response.status}`);
	}

	const data = await response.json();

	await mkdir(join(cache, 'api'), {recursive: true});
	await writeFile(file, JSON.stringify(data));

	return data;
}

// The image base URL's parts: https://assets.tcgdex.net/<lang>/<series>/<set>/<localId>.
export function imageParts(image) {
	const [lang, series, set, localId] = new URL(image).pathname.slice(1).split('/');

	return {lang, localId, series, set};
}

// The cards the index holds, as {catalog, id, set, series, image, full}.
export async function catalogCards(cache, catalogs = ['en', 'pt', 'ja']) {
	const lists = {};

	for (const lang of new Set([...catalogs, 'en'])) {
		lists[lang] = await cachedJson(cache, `${lang}/cards`, `cards-${lang}.json`);
	}

	const full = new Set();

	for (const lang of catalogs) {
		for (const rarity of FULL_ART_RARITIES) {
			const list = await cachedJson(cache, `${lang}/cards?rarity=${encodeURIComponent(rarity)}`, `rarity-${lang}-${rarity.replace(/\W+/g, '_')}.json`).catch(() => []);

			for (const card of list) {
				full.add(`${lang === 'pt' ? 'en' : lang}:${card.id}`);
			}
		}
	}

	// A Portuguese full art is the English one too.
	for (const key of [...full]) {
		if (key.startsWith('pt:')) {
			full.add(`en:${key.slice(3)}`);
		}
	}

	const enImage = new Map(lists.en.filter((c) => c.image).map((c) => [c.id, c.image]));
	const out = [];

	for (const lang of catalogs) {
		for (const card of lists[lang]) {
			if (!card.image) {
				continue;
			}

			const parts = imageParts(card.image);

			if (parts.series === 'tcgp') {
				continue;
			}

			if (lang === 'pt' && enImage.has(card.id)) {
				continue;
			}

			out.push({
				catalog: lang,
				full: full.has(`${lang === 'pt' ? 'en' : lang}:${card.id}`),
				id: card.id,
				image: card.image,
				series: parts.series,
				set: parts.set,
			});
		}
	}

	return out;
}

export const imageFile = (cache, card) => join(cache, 'images', card.catalog, card.set, `${card.id.replace(/[^\w.-]/g, '_')}.webp`);

// Downloads every card's low.webp into the cache, `concurrency` at a time.
// Returns {fetched, kept, missing}.
export async function downloadImages(cache, cards, {concurrency = 4, log = () => {}} = {}) {
	const missFile = join(cache, 'missing.json');
	const missing = new Set(await exists(missFile) ? JSON.parse(await readFile(missFile, 'utf8')) : []);
	let fetched = 0;
	let kept = 0;
	let next = 0;
	let bytes = 0;
	const started = Date.now();

	async function worker() {
		while (next < cards.length) {
			const card = cards[next++];
			const file = imageFile(cache, card);

			if (missing.has(card.image) || await exists(file)) {
				kept++;
				continue;
			}

			const response = await fetchRetry(`${card.image}/low.webp`).catch(() => null);

			if (!response || !response.ok) {
				if (response && response.status === 404) {
					missing.add(card.image);
				}

				continue;
			}

			const data = Buffer.from(await response.arrayBuffer());

			await mkdir(join(file, '..'), {recursive: true});
			await writeFile(file, data);
			fetched++;
			bytes += data.length;

			if (fetched % 500 === 0) {
				log(`  ${fetched} images fetched (${(bytes / 1e6).toFixed(0)} MB, ${Math.round((Date.now() - started) / 1000)} s), ${kept} already kept`);
				await writeFile(missFile, JSON.stringify([...missing]));
			}
		}
	}

	await Promise.all(Array.from({length: concurrency}, worker));
	await writeFile(missFile, JSON.stringify([...missing]));

	return {bytes, fetched, kept, missing: missing.size, seconds: Math.round((Date.now() - started) / 1000)};
}
