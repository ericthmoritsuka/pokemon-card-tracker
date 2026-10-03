// Builds the fingerprint index from TCGdex images.
//
// node lab/fingerprints/build-index.mjs [--catalogs en,pt,ja] [--out <file>]
//   [--concurrency 4] [--describe-only]
//
// FP_CACHE=<dir> is where TCGdex answers, images, and descriptors are kept
// (default ~/.cache/pokemon-card-tracker-fingerprints); it must be outside
// the repo. PLAYWRIGHT=<path to the playwright package> if it is not found
// by name.
//
// Steps:
// 1. The card lists and full-art rarities from the TCGdex API, and every
//    card's low.webp (catalog.mjs), a few at a time, cached.
// 2. Descriptors for every image, computed in headless Chromium by
//    fingerprint.js (harness.js): the browser's own decoder and the
//    browser's own code. Kept in the cache, so a rebuild only describes new
//    images.
// 3. Artwork groups: cards whose art box is the same picture.
// 4. The packed index (pack.js), by default js/vision/index.bin.

import {mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join, relative, resolve} from 'node:path';
import {gzipSync} from 'node:zlib';

import {catalogCards, downloadImages, imageFile} from './catalog.mjs';
import {colorDistance, popcount32} from '../../js/vision/fingerprint.js';
import {packIndex} from '../../js/vision/pack.js';
import {openPage, REPO, startServer} from './serve.mjs';

const args = Object.fromEntries(process.argv.slice(2)
	.map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : null))
	.filter(Boolean));

export const CACHE = resolve(process.env.FP_CACHE || join(homedir(), '.cache/pokemon-card-tracker-fingerprints'));
export const RECORD = 64;

// Offsets of each descriptor in a harness.js record.
export const LAYOUT = {art128: [8, 16], art64: [0, 8], card128: [32, 16], card64: [24, 8], color: [48, 16]};

// What the index keeps, and the matcher's weights, as measured
// (RESULTS.md): the 128-bit art-box hash, the 128-bit whole-card hash, and
// the colour layout. Full-art cards lean on the whole card.
export const FIELDS = {art: {bytes: 16, from: 'art128', type: 'u32'}, card: {bytes: 16, from: 'card128', type: 'u32'}, color: {bytes: 16, from: 'color', type: 'i8'}};
export const WEIGHTS = {framed: {art: 1, card: 0.5, color: 0.1}, full: {art: 0.6, card: 1, color: 0.1}};

// Two cards share artwork when their art-box hashes are this close (of 128
// bits) and their colour layouts agree (RESULTS.md, "Artwork groups").
export const GROUP_ART128 = 18;
export const GROUP_COLOR = 60;

if (!relative(REPO, CACHE).startsWith('..')) {
	throw new Error('FP_CACHE must be outside the repo: it holds card images.');
}

export const field = (records, i, name) => {
	const [o, len] = LAYOUT[name];

	return records.subarray(i * RECORD + o, i * RECORD + o + len);
};

export const words = (bytes) => new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
export const signed = (bytes) => new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length);

const exists = (path) => stat(path).then(() => true, () => false);

// Descriptors for every card, from the cache where kept, the rest computed
// in Chromium. Returns {cards, records} with the cards that have one.
export async function describeAll(cards, {log = console.log} = {}) {
	const file = join(CACHE, 'descriptors.bin');
	const listFile = join(CACHE, 'descriptors.json');
	const known = new Map();

	if (await exists(file) && await exists(listFile)) {
		const old = new Uint8Array(await readFile(file));
		const keys = JSON.parse(await readFile(listFile, 'utf8'));

		keys.forEach((key, i) => known.set(key, old.subarray(i * RECORD, (i + 1) * RECORD)));
	}

	const key = (c) => `${c.catalog}:${c.id}:${c.image}`;
	const todo = [];

	for (const c of cards) {
		if (!known.has(key(c)) && await exists(imageFile(CACHE, c))) {
			todo.push(c);
		}
	}

	log(`describing ${todo.length} images (${known.size} kept)`);

	if (todo.length) {
		const server = await startServer({cache: CACHE});
		const {browser, page} = await openPage(server, '/pokemon-card-tracker/lab/fingerprints/harness.html');
		const t0 = Date.now();

		for (let k = 0; k < todo.length; k += 64) {
			const batch = todo.slice(k, k + 64);
			const srcs = batch.map((c) => `/cache/${relative(CACHE, imageFile(CACHE, c))}`);
			const {data, ok} = await page.evaluate((s) => window.fp.describe(s), srcs);
			const bytes = Buffer.from(data, 'base64');

			for (const i of ok) {
				known.set(key(batch[i]), new Uint8Array(bytes.subarray(i * RECORD, (i + 1) * RECORD)));
			}

			if ((k / 64) % 50 === 0) {
				log(`  ${k + batch.length} of ${todo.length} (${Math.round((Date.now() - t0) / 1000)} s)`);
			}
		}

		log(`described in ${Math.round((Date.now() - t0) / 1000)} s`);
		await browser.close();
		await server.close();

		const keys = [...known.keys()];
		const all = new Uint8Array(keys.length * RECORD);

		keys.forEach((k, i) => all.set(known.get(k), i * RECORD));
		await writeFile(file, all);
		await writeFile(listFile, JSON.stringify(keys));
	}

	const have = cards.filter((c) => known.has(key(c)));
	const records = new Uint8Array(have.length * RECORD);

	have.forEach((c, i) => records.set(known.get(key(c)), i * RECORD));

	return {cards: have, records};
}

// Artwork groups by union-find: cards joined when their 128-bit art-box
// hashes are within GROUP_ART128 bits and their colour layouts within
// GROUP_COLOR. Returns, per card, the index of its group's first card.
export function artGroups(records, n, {art = GROUP_ART128, color = GROUP_COLOR} = {}) {
	const parent = Int32Array.from({length: n}, (_, i) => i);
	const find = (i) => {
		while (parent[i] !== i) {
			parent[i] = parent[parent[i]];
			i = parent[i];
		}

		return i;
	};
	const hashes = new Uint32Array(n * 4);
	const colors = [];

	for (let i = 0; i < n; i++) {
		hashes.set(words(field(records, i, 'art128')), i * 4);
		colors.push(signed(field(records, i, 'color')));
	}

	for (let i = 0; i < n; i++) {
		const a0 = hashes[i * 4];
		const a1 = hashes[i * 4 + 1];
		const a2 = hashes[i * 4 + 2];
		const a3 = hashes[i * 4 + 3];

		for (let j = i + 1; j < n; j++) {
			const d = popcount32(a0 ^ hashes[j * 4]) + popcount32(a1 ^ hashes[j * 4 + 1]) + popcount32(a2 ^ hashes[j * 4 + 2]) + popcount32(a3 ^ hashes[j * 4 + 3]);

			if (d <= art && colorDistance(colors[i], colors[j]) <= color) {
				parent[find(j)] = find(i);
			}
		}
	}

	const first = new Map();
	const out = new Uint32Array(n);

	for (let i = 0; i < n; i++) {
		const root = find(i);

		if (!first.has(root)) {
			first.set(root, i);
		}

		out[i] = first.get(root);
	}

	return out;
}

export function buildIndex(cards, records, groups, {built = new Date().toISOString()} = {}) {
	const catalogs = ['en', 'pt', 'ja'];
	const sets = [...new Set(cards.map((c) => c.set))];
	const series = sets.map((s) => cards.find((c) => c.set === s).series);
	const setIndex = new Map(sets.map((s, i) => [s, i]));
	const localIds = [];
	const oddIds = {};
	const packed = cards.map((c, i) => {
		const localId = c.id.startsWith(`${c.set}-`) ? c.id.slice(c.set.length + 1) : '';

		if (!localId) {
			oddIds[i] = c.id;
		}

		localIds.push(localId);

		const entry = {catalog: catalogs.indexOf(c.catalog), flags: c.full ? 1 : 0, group: groups[i], set: setIndex.get(c.set)};

		for (const [name, f] of Object.entries(FIELDS)) {
			entry[name] = f.type === 'i8' ? signed(field(records, i, f.from)) : words(field(records, i, f.from));
		}

		return entry;
	});
	const fields = Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, {bytes: f.bytes, type: f.type}]));

	return packIndex({cards: packed, fields, header: {built, catalogs, fields, localIds: localIds.join('|'), oddIds, series, sets, source: 'TCGdex low.webp images (assets.tcgdex.net)', version: 1, weights: WEIGHTS}});
}

// Cards in index order: catalog, then set, then number.
export const indexOrder = (a, b) => (a.catalog === b.catalog ? 0 : ['en', 'pt', 'ja'].indexOf(a.catalog) - ['en', 'pt', 'ja'].indexOf(b.catalog))
	|| a.set.localeCompare(b.set) || a.id.localeCompare(b.id, 'en', {numeric: true});

async function main() {
	const t0 = Date.now();
	const catalogs = args.catalogs ? String(args.catalogs).split(',') : ['en', 'pt', 'ja'];
	const listed = (await catalogCards(CACHE, catalogs)).sort(indexOrder);

	console.log(`${listed.length} cards with images: ${catalogs.map((c) => `${c} ${listed.filter((x) => x.catalog === c).length}`).join(', ')}; ${listed.filter((c) => c.full).length} full art`);

	const dl = await downloadImages(CACHE, listed, {concurrency: Number(args.concurrency || 4), log: console.log});

	console.log(`images: ${dl.fetched} fetched (${(dl.bytes / 1e6).toFixed(0)} MB) in ${dl.seconds} s, ${dl.kept} already kept, ${dl.missing} missing on TCGdex`);

	const t1 = Date.now();
	const {cards, records} = await describeAll(listed);
	const t2 = Date.now();

	if (args['describe-only']) {
		return;
	}

	const groups = artGroups(records, cards.length);
	const t3 = Date.now();
	const index = buildIndex(cards, records, groups);
	const out = resolve(String(args.out || join(REPO, 'js/vision/index.bin')));

	await mkdir(join(out, '..'), {recursive: true});
	await writeFile(out, index);

	const shared = new Map();

	for (const g of groups) {
		shared.set(g, (shared.get(g) || 0) + 1);
	}

	console.log(`groups: ${shared.size} artwork groups for ${cards.length} cards; ${[...shared.values()].filter((v) => v > 1).length} hold more than one card (${groups.filter((g) => shared.get(g) > 1).length} cards)`);
	console.log(`index: ${out} ${(index.length / 1024).toFixed(0)} KB, gzipped ${(gzipSync(index).length / 1024).toFixed(0)} KB`);
	console.log(`time: download ${Math.round((t1 - t0) / 1000)} s, describe ${Math.round((t2 - t1) / 1000)} s, groups ${Math.round((t3 - t2) / 1000)} s, total ${Math.round((Date.now() - t0) / 1000)} s`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	await main();
}
