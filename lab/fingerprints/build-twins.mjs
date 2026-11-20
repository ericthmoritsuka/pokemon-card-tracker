// Builds the list of index cards that share their artwork with a card the
// index cannot hold, so the scanner never takes one for sure on its picture
// alone (a scanner review, 2026-11-19: a Portuguese McDonald's Collection
// 2021 Charmander came out sure as Burning Shadows' sm3-18, whose artwork
// Kagemaru Himeno drew for both; TCGdex has no image of the McDonald's
// card, so the index cannot hold it).
//
// node lab/fingerprints/build-twins.mjs [--out <file>] [--report <file>]
//
// Writes js/vision/index-twins.json:
//
//   {built, count, pairs, candidates, rule, twins: {"<card id>": ["<twin id>", ...]}}
//
// --report writes every candidate pair with the step that decided it and
// the distances it was decided on (for checking a rebuild by eye).
//
// Candidates. A card with no image in English or Portuguese (so not in the
// index) and an index card with the same name and illustrator (TCGdex's
// GraphQL, once for each name an image-less card bears). TCG Pocket's
// digital cards are left out on both sides, as the index leaves them out.
// The same illustrator often means a different artwork (Mitsuhiro Arita
// drew many Charmanders): on 2026-11-20 there were 1,051 such pairs over 819
// index cards, and each made a card read its number for 4 to 7.5 s on
// Eric's phone, Mega Venusaur ex and 151's Pikachu among them. So a pair is
// kept only on evidence that the pictures are one artwork, in this order:
//
// 1. A holo H card of the index card's own set: Aquapolis and Skyridge's H
//    cards are each the same card as a numbered one.
// 2. A picture of the twin. TCGdex's other Western languages (LANGUAGES,
//    same card ids) and pokemontcg.io (PTCG_SETS, for sets TCGdex has no
//    picture of in any language) are fingerprinted as the scanner
//    fingerprints a photo (js/vision/fingerprint.js, every query shift) and
//    compared with the index card's art box (128 bits):
//    a. within SAME_ART bits of the index card: kept;
//    b. otherwise, when its nearest index card is within KNOWN_ART bits, the
//       picture is that card's: the pair is kept only when the index card
//       is in that card's artwork group or within NEAR_MARGIN bits of it (a
//       photo of the twin would lead with that card, not this one);
//    c. otherwise kept when within LIKELY_ART bits and no farther than the
//       twin's other candidates (most are recolours: Shiny Vault, gold
//       Trainer Gallery, rainbow and promo full arts of one drawing).
//    Measured on 2026-11-20 (DESIGN.md, "Image-less twins"): pairs at 0 to
//    24 were one artwork each time they were looked at; 26 to 56 held both,
//    since many of these pictures are scans of foil cards, so a distance
//    there decides little alone.
// 3. No picture that settles it: the twin's set. A classic reprint
//    collection (CLASSIC: the Classic Collections, Best of Game) reprints
//    old artwork, and the pair is kept. A product reprinting cards of its
//    own time (ERA_REPRINT: McDonald's Collections, trainer kits, My First
//    Battle) is kept when it came out within ERA_YEARS of the index card:
//    of 297 such pairs a picture settled, 209 of the 234 within -3 to +4
//    years were one artwork, and 53 of the 63 outside were not. Anything
//    else (Black Star promos, Trainer and Galarian Galleries, Shiny Vault,
//    expansions, POP) is dropped: of the promos the index holds, about 1 in
//    10 shares the artwork of a card with its name and illustrator.
// 4. A candidate whose own index picture is within SAME_ART of a kept
//    candidate's (a holo and a plain print) is kept with it.
//
// 2026-11-20: 1,051 pairs over 819 index cards before, 621 pairs over 495
// index cards after (the last line this prints; --report for each pair).
//
// FP_CACHE=<dir> is where the answers and pictures are kept (default
// ~/.cache/pokemon-card-tracker-fingerprints, the index builder's cache);
// it must be outside the repo. PLAYWRIGHT=<path to the playwright package>
// if it is not found by name (the pictures are fingerprinted in headless
// Chromium, as the index is).

import {mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join, relative, resolve} from 'node:path';

import {cachedJson, downloadImages, imageFile, imageParts} from './catalog.mjs';
import {openPage, REPO, startServer} from './serve.mjs';
import {hamming} from '../../js/vision/fingerprint.js';
import {unpackIndex} from '../../js/vision/pack.js';

const args = Object.fromEntries(process.argv.slice(2)
	.map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : null))
	.filter(Boolean));

const CACHE = resolve(process.env.FP_CACHE || join(homedir(), '.cache/pokemon-card-tracker-fingerprints'));

if (!relative(REPO, CACHE).startsWith('..')) {
	throw new Error('FP_CACHE must be outside the repo.');
}

const out = resolve(String(args.out || join(REPO, 'js/vision/index-twins.json')));
const GRAPHQL = 'https://api.tcgdex.net/v2/graphql';
const PTCG_API = 'https://api.pokemontcg.io/v2/cards';
const USER_AGENT = 'pokemon-card-tracker twins list (personal, cached)';

// The TCGdex languages whose cards keep the English card ids.
export const LANGUAGES = ['de', 'es', 'es-mx', 'fr', 'it', 'pt-br'];

// TCGdex set id -> pokemontcg.io set id, for the sets of image-less cards
// that pokemontcg.io has (checked 2026-11-20). It has no MEP promos,
// McDonald's 2023 or 2024, My First Battle, or the HS, DP, BW, SM, and XY
// trainer kits, and no pictures for McDonald's 2014, 2015, 2017, or 2018.
export const PTCG_SETS = {
	'2011bw': 'mcd11', '2012bw': 'mcd12', '2014xy': 'mcd14', '2015xy': 'mcd15', '2016xy': 'mcd16', '2017sm': 'mcd17', '2018sm': 'mcd18', '2019sm': 'mcd19',
	'2021swsh': 'mcd21', '2022swsh': 'mcd22', '30th-c': 'me55c', 'bog': 'bp', 'bwp': 'bwp', 'cel25cc': 'cel25c', 'ecard2': 'ecard2', 'ecard3': 'ecard3',
	'hgssp': 'hsp', 'pop6': 'pop6', 'sm7.5': 'sm75', 'smp': 'smp', 'svp': 'svp', 'swsh10tg': 'swsh10tg', 'swsh11tg': 'swsh11tg',
	'swsh12.5gg': 'swsh12pt5gg', 'swsh12tg': 'swsh12tg', 'swsh4.5sv': 'swsh45sv', 'swsh9tg': 'swsh9tg', 'swshp': 'swshp', 'tk-ex-latia': 'tk1a',
	'tk-ex-latio': 'tk1b', 'tk-ex-m': 'tk2b', 'tk-ex-p': 'tk2a', 'xyp': 'xyp',
};

export const SAME_ART = 24;
export const KNOWN_ART = 24;
export const NEAR_MARGIN = 8;
export const LIKELY_ART = 40;
export const CLASSIC = /Classic Collection|Best of game/i;
export const ERA_REPRINT = /McDonald's Collection|trainer Kit|My First Battle/i;
// The twin's release year minus the index card's.
export const ERA_YEARS = [-3, 4];

const exists = (path) => stat(path).then(() => true, () => false);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// A JSON answer kept in the cache, asked again a few times on a 429 or a
// server error (pokemontcg.io answers 502 often).
async function keptJson(name, ask) {
	const file = join(CACHE, 'api', name);

	if (await exists(file)) {
		return JSON.parse(await readFile(file, 'utf8'));
	}

	for (let attempt = 1; ; attempt++) {
		const response = await ask().catch(() => null);

		if (response && response.ok) {
			const data = await response.json();

			await mkdir(join(CACHE, 'api'), {recursive: true});
			await writeFile(file, JSON.stringify(data));

			return data;
		}

		if (attempt >= 6 || (response && response.status < 500 && response.status !== 429)) {
			throw new Error(`${name}: ${response ? response.status : 'no answer'}; run again (answers so far are kept)`);
		}

		await sleep(3000 * attempt);
	}
}

// Every international card named `name` (TCGdex matches a part of the
// name), with its illustrator and image.
async function named(name) {
	const query = `{ cards(filters: {name: ${JSON.stringify(name)}}, pagination: {page: 1, itemsPerPage: 1000}) { id name illustrator image } }`;
	const body = await keptJson(`twins-name-${encodeURIComponent(name)}.json`, () => fetch(GRAPHQL, {body: JSON.stringify({query}), headers: {'content-type': 'application/json', 'user-agent': USER_AGENT}, method: 'POST'}));

	// Kept as the card list alone (the cache written before 2026-11-20).
	const cards = Array.isArray(body) ? body : body && body.data && body.data.cards;

	if (!Array.isArray(cards)) {
		throw new Error(`TCGdex GraphQL ${name}: ${JSON.stringify(body && body.errors)}`);
	}

	return cards;
}

// A pokemontcg.io set's cards: [{id, name, number, images}].
async function ptcgSet(set) {
	const cards = [];

	for (let page = 1; ; page++) {
		const url = `${PTCG_API}?q=set.id:${set}&pageSize=250&page=${page}&select=id,name,number,images`;
		const body = await keptJson(`ptcg-set-${set}-${page}.json`, () => fetch(url, {headers: {'user-agent': USER_AGENT}}));

		cards.push(...body.data);

		if (cards.length >= body.totalCount || !body.data.length) {
			return cards;
		}
	}
}

// pokemontcg.io pictures into the cache, a few at a time; a 404 is
// remembered. Returns the cards whose picture is kept.
async function ptcgImages(cards) {
	const missFile = join(CACHE, 'ptcg-missing.json');
	const missing = new Set(await exists(missFile) ? JSON.parse(await readFile(missFile, 'utf8')) : []);
	const have = [];
	let next = 0;

	async function worker() {
		while (next < cards.length) {
			const card = cards[next++];

			if (missing.has(card.url)) {
				continue;
			}

			if (!await exists(card.file)) {
				const response = await fetch(card.url, {headers: {'user-agent': USER_AGENT}}).catch(() => null);

				if (!response || !response.ok) {
					if (response && response.status === 404) {
						missing.add(card.url);
					}

					continue;
				}

				await mkdir(join(card.file, '..'), {recursive: true});
				await writeFile(card.file, Buffer.from(await response.arrayBuffer()));
			}

			have.push(card);
		}
	}

	await Promise.all(Array.from({length: 3}, worker));
	await writeFile(missFile, JSON.stringify([...missing]));

	return have;
}

// The scanner's query fingerprints (every shift, art box at 128 bits) of
// each picture, by its path under the cache: [[{art, few}], ...], `few` for
// the first QUERY_SHIFTS.length.
async function fingerprints(files) {
	const server = await startServer({cache: CACHE});
	const {browser, page} = await openPage(server, '/pokemon-card-tracker/lab/fingerprints/harness.html');
	const result = [];

	for (let k = 0; k < files.length; k += 20) {
		const srcs = files.slice(k, k + 20).map((file) => `/cache/${relative(CACHE, file)}`);

		result.push(...await page.evaluate(async (list) => {
			const fp = await import('/pokemon-card-tracker/js/vision/fingerprint.js');
			const shifts = [...fp.QUERY_SHIFTS, ...fp.WIDE_SHIFTS];

			return Promise.all(list.map(async (src) => {
				try {
					const bitmap = await createImageBitmap(await (await fetch(src)).blob());
					const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
					const ctx = canvas.getContext('2d', {willReadFrequently: true});

					ctx.drawImage(bitmap, 0, 0);

					const queries = fp.queryFingerprints(ctx.getImageData(0, 0, bitmap.width, bitmap.height), {artBits: 128, cardBits: 128}, shifts);

					return {few: fp.QUERY_SHIFTS.length, art: queries.map((q) => [...q.art])};
				}
				catch {
					return null;
				}
			}));
		}, srcs));
	}

	await browser.close();
	await server.close();

	return result.map((r) => (r ? r.art.map((a, i) => ({art: Uint32Array.from(a), few: i < r.few})) : null));
}

const key = (text) => String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const loose = (text) => key(text).replace(/[^a-z0-9]+/g, ' ').trim();
const setOf = (id) => id.slice(0, id.lastIndexOf('-'));
const localOf = (id) => id.slice(id.lastIndexOf('-') + 1);
const number = (text) => String(text).toUpperCase().replace(/^([A-Z]*)0+(\d)/, '$1$2');
const year = (date) => (date ? Number(date.slice(0, 4)) + (Number(date.slice(5, 7)) - 1) / 12 : null);

// 1. Candidates.
const pocket = new Set(((await cachedJson(CACHE, 'en/series/tcgp', 'series-en-tcgp.json')).sets || []).map((set) => set.id));
const english = (await cachedJson(CACHE, 'en/cards', 'cards-en.json')).filter((card) => !pocket.has(setOf(card.id)));
const portuguese = new Set((await cachedJson(CACHE, 'pt/cards', 'cards-pt.json')).filter((card) => card.image).map((card) => card.id));
const inIndex = (card) => Boolean(card.image) || portuguese.has(card.id);
const listed = new Set(english.map((card) => card.id));
const names = [...new Set(english.filter((card) => !inIndex(card)).map((card) => card.name))].sort();
const pairs = [];
const twinCard = new Map();
let asked = 0;

for (const name of names) {
	const cards = (await named(name)).filter((card) => listed.has(card.id) && key(card.name) === key(name) && key(card.illustrator));

	asked++;

	if (asked % 100 === 0) {
		console.log(`${asked} of ${names.length} names`);
	}

	for (const lost of cards.filter((card) => !inIndex(card))) {
		twinCard.set(lost.id, lost);

		for (const kept of cards.filter((card) => inIndex(card) && key(card.illustrator) === key(lost.illustrator))) {
			pairs.push({key: kept.id, twin: lost.id});
		}
	}
}

const twinIds = [...new Set(pairs.map((p) => p.twin))].sort();
const twinSets = [...new Set(twinIds.map(setOf))].sort();

console.log(`${pairs.length} candidate pairs over ${new Set(pairs.map((p) => p.key)).size} index cards, ${twinIds.length} image-less cards in ${twinSets.length} sets`);

// 2. Pictures of the twins: TCGdex's other languages, then pokemontcg.io.
const pictures = [];
const wanted = new Set(twinIds);

for (const lang of LANGUAGES) {
	const list = await cachedJson(CACHE, `${lang}/cards`, `cards-${lang}.json`);
	const cards = list.filter((card) => wanted.has(card.id) && card.image).map((card) => {
		const parts = imageParts(card.image);

		return {catalog: lang, id: card.id, image: card.image, series: parts.series, set: parts.set};
	});

	await downloadImages(CACHE, cards, {concurrency: 3});

	for (const card of cards) {
		if (await exists(imageFile(CACHE, card))) {
			pictures.push({file: imageFile(CACHE, card), source: lang, twin: card.id});
		}
	}
}

const ptcgWanted = [];

for (const set of twinSets.filter((s) => PTCG_SETS[s])) {
	const cards = await ptcgSet(PTCG_SETS[set]);

	for (const id of twinIds.filter((t) => setOf(t) === set)) {
		const same = cards.filter((c) => loose(c.name) === loose(twinCard.get(id).name));
		const hit = same.find((c) => number(c.number) === number(localOf(id))) || (same.length === 1 ? same[0] : null);

		if (hit && hit.images && hit.images.small) {
			ptcgWanted.push({file: join(CACHE, 'images', 'ptcg', PTCG_SETS[set], `${hit.id.replace(/[^\w.-]/g, '_')}.png`), twin: id, url: hit.images.small});
		}
	}
}

for (const card of await ptcgImages(ptcgWanted)) {
	pictures.push({file: card.file, source: 'pokemontcg.io', twin: card.twin});
}

console.log(`${pictures.length} pictures of ${new Set(pictures.map((p) => p.twin)).size} image-less cards`);

const queries = await fingerprints(pictures.map((p) => p.file));
const index = unpackIndex(new Uint8Array(await readFile(join(REPO, 'js/vision/index.bin'))));
const position = new Map();

for (let i = 0; i < index.count; i++) {
	const card = index.card(i);

	if (card.catalog === 'en' || card.catalog === 'pt') {
		position.set(card.id, i);
	}
}

const artOf = (i) => index.fields.art.subarray(i * 4, i * 4 + 4);

// Each picture's nearest index card (en and pt, the first shifts), and its
// distance to each candidate index card (every shift).
pictures.forEach((picture, k) => {
	const q = queries[k];

	if (!q) {
		return;
	}

	const few = q.filter((f) => f.few).map((f) => f.art);
	let best = Infinity;
	let nearest = -1;

	for (let i = 0; i < index.count; i++) {
		if (index.catalog[i] > 1) {
			continue;
		}

		const a = artOf(i);

		for (const f of few) {
			const d = hamming(f, a);

			if (d < best) {
				best = d;
				nearest = i;
			}
		}
	}

	picture.near = {art: best, group: index.group[nearest], id: index.card(nearest).id};
	picture.to = (id) => Math.min(...q.map((f) => hamming(f.art, artOf(position.get(id)))));
});

// 3. The decision for each pair.
const namesTable = JSON.parse(await readFile(join(REPO, 'js/vision/index-names.json'), 'utf8'));
const keyDate = (id) => {
	const set = namesTable.sets[`en|${setOf(id)}`] || namesTable.sets[`pt|${setOf(id)}`];

	return set ? set[2] : null;
};
const twinSet = {};

for (const set of twinSets) {
	twinSet[set] = await cachedJson(CACHE, `en/sets/${set}`, `twins-set-${set}.json`);
}

const candidates = (twin) => pairs.filter((p) => p.twin === twin).map((p) => p.key);

function decide(pair) {
	if (setOf(pair.key) === setOf(pair.twin) && /^H\d+$/.test(localOf(pair.twin))) {
		return {keep: true, step: '1 holo H card of its set'};
	}

	const seen = pictures.filter((p) => p.twin === pair.twin && p.near).map((p) => ({art: p.to(pair.key), near: p.near, others: Math.min(...candidates(pair.twin).filter((id) => id !== pair.key).map(p.to)), source: p.source}));
	const close = seen.find((s) => s.art <= SAME_ART);

	if (close) {
		return {keep: true, step: '2a picture', ...close};
	}

	const known = seen.filter((s) => s.near.art <= KNOWN_ART);

	if (known.length) {
		const lead = known.find((s) => s.near.group === index.group[position.get(pair.key)] || s.art <= s.near.art + NEAR_MARGIN);

		return lead ? {keep: true, step: '2b picture leads here', ...lead} : {keep: false, step: '2b picture is another card\'s', ...known[0]};
	}

	const likely = seen.find((s) => s.art <= LIKELY_ART && s.art <= s.others);

	if (likely) {
		return {keep: true, step: '2c picture closest to this card', ...likely};
	}

	const set = twinSet[setOf(pair.twin)];
	const gap = year(set.releaseDate) - year(keyDate(pair.key));
	const unclear = seen.length ? ' (pictures settle nothing)' : '';
	const art = seen.length ? Math.min(...seen.map((x) => x.art)) : undefined;

	if (CLASSIC.test(set.name)) {
		return {art, keep: true, step: `3 classic reprint${unclear}`};
	}

	if (ERA_REPRINT.test(set.name)) {
		const within = Number.isFinite(gap) && gap >= ERA_YEARS[0] && gap <= ERA_YEARS[1];

		return {art, gap: Math.round(gap * 10) / 10, keep: within, step: `3 reprint of its time, ${within ? 'within' : 'outside'} ${ERA_YEARS.join(' to ')} years${unclear}`};
	}

	return {art, keep: false, step: `3 not a reprint set${unclear}`};
}

const twins = {};
const steps = {};
const report = [];

const verdicts = pairs.map(decide);
const artAt = (id) => artOf(position.get(id));

// 4. A candidate whose own picture in the index is within SAME_ART of a
// kept one's (a holo and a plain print, a recolour) is kept with it: a
// photo of the twin may lead with either.
pairs.forEach((pair, k) => {
	if (verdicts[k].keep) {
		return;
	}

	const by = pairs.find((other, j) => verdicts[j].keep && other.twin === pair.twin && verdicts[j].step[0] !== '4' && hamming(artAt(other.key), artAt(pair.key)) <= SAME_ART);

	if (by) {
		verdicts[k] = {keep: true, step: '4 same picture as a kept card', with: by.key};
	}
});

for (const [k, pair] of pairs.entries()) {
	const verdict = verdicts[k];
	const label = `${verdict.step}: ${verdict.keep ? 'kept' : 'dropped'}`;

	steps[label] = (steps[label] || 0) + 1;
	report.push({...pair, ...verdict, near: verdict.near ? `${verdict.near.id}@${verdict.near.art}` : undefined});

	if (verdict.keep) {
		twins[pair.key] = [...new Set([...(twins[pair.key] || []), pair.twin])].sort();
	}
}

const sorted = Object.fromEntries(Object.keys(twins).sort().map((id) => [id, twins[id]]));
const kept = Object.values(sorted).flat().length;
const table = {
	built: new Date().toISOString(),
	candidates: {cards: new Set(pairs.map((p) => p.key)).size, pairs: pairs.length},
	count: Object.keys(sorted).length,
	pairs: kept,
	rule: 'lab/fingerprints/build-twins.mjs: same name and illustrator, kept on a matching picture, else by the twin\'s set',
	twins: sorted,
};

await writeFile(out, `${JSON.stringify(table)}\n`);

if (args.report) {
	await writeFile(resolve(String(args.report)), JSON.stringify(report, null, 1));
}

for (const [label, n] of Object.entries(steps).sort()) {
	console.log(`  ${label}: ${n}`);
}

console.log(`${relative(REPO, out)}: ${table.count} index cards (${kept} pairs) with an image-less twin, of ${table.candidates.cards} (${pairs.length} pairs) sharing a name and illustrator`);
