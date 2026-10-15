// The embedding experiment's measurement (lab/embedding/RESULTS.md).
//
// node lab/embedding/measure.mjs <scan-log.json>... --models a,b
//   [--video <labels.json>] [--variants] [--out <rows.json>]
//
// Queries: every log crop with a saved card (as lab/holder/crops.mjs reads
// them), with --variants its eleven re-crops (lab/holder/recrop.mjs, the
// same "other card" for the pile strips as crops.mjs uses), and with
// --video the capture crops of a video replay, labelled by hand
// ([{file, truth}], truth the card id).
//
// For each query it records, as artwork groups of the fingerprint index
// (so a reprint or a Japanese twin of the right card counts as right, the
// way crops.mjs scores the hash):
//
// - hash: the app's picture match over the whole index (hash.mjs, top 50
//   groups), and its verdict (sure or not);
// - for each model and scorer: the best 50 groups by cosine similarity
//   over the reference set (refs.mjs), a group's score being its best card.
//
// Scorers: `art` (art box), `card` (whole card), `art+card` (the mean of
// the two cosines); for DINOv2 each of those with the class token (`cls`),
// the mean patch token (`mean`), or both (`both`).
//
// summarize.mjs turns the rows into tables, including the fusions.

import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {VARIANTS} from '../holder/recrop.mjs';
import {args as parseArgs, dataUrlBytes, decodeImage, loadFingerprintIndex, outside, readLogs} from '../holder/lib.mjs';
import {hashMatch} from './hash.mjs';
import {loadModel, readEmbeddings, refKey, writeEmbeddingsBuffer} from './lib.mjs';

const opts = parseArgs();
const cache = outside(process.env.EMB_CACHE || '/tmp/emb/tcgdex');
const names = String(opts.models || '').split(',').filter(Boolean);
const TOP = 50;

const index = loadFingerprintIndex();
const groupOfKey = new Map();

for (let i = 0; i < index.count; i++) {
	groupOfKey.set(refKey(index.card(i)), index.group[i]);
}

const truthGroup = (id) => groupOfKey.get(`en:${id}`) ?? groupOfKey.get(`ja:${id}`) ?? `own:en:${id}`;

// ------------------------------------------------------------ queries

const queries = [];
const entries = readLogs(opts._).filter((e) => e.picture && e.truth);
const decoded = entries.map((e) => decodeImage(dataUrlBytes(e.picture)));
const variants = opts.variants ? VARIANTS : VARIANTS.slice(0, 1);

entries.forEach((entry, i) => {
	for (const variant of variants) {
		queries.push({id: entry.id, make: () => variant.make(decoded[i], decoded[(i + 7) % decoded.length]), set: 'log', truth: entry.truth, variant: variant.name});
	}
});

if (opts.video) {
	for (const item of JSON.parse(readFileSync(opts.video, 'utf8'))) {
		if (item.truth) {
			queries.push({id: item.file, make: () => decodeImage(item.file), set: 'video', truth: item.truth, variant: 'video drop'});
		}
	}
}

console.error(`${queries.length} queries`);

// ------------------------------------------------------------ references

const refs = JSON.parse(readFileSync(join(cache, 'refs.json'), 'utf8'));
const refGroup = new Map(refs.map((r) => [refKey(r), r.group]));
const universe = new Set(refs.map((r) => r.group));

function loadTables(name) {
	const keys = JSON.parse(readFileSync(join(cache, 'emb', `${name}.json`), 'utf8'));

	return {
		art: readEmbeddings(join(cache, 'emb', `${name}-art.bin`)),
		card: readEmbeddings(join(cache, 'emb', `${name}-card.bin`)),
		groups: keys.map((k) => refGroup.get(k)),
		keys,
	};
}

// Cosine of the query against every row, over dims [from, to).
function cosines(table, q, from, to) {
	const {data, dim, n} = table;
	const out = new Float32Array(n);

	for (let i = 0; i < n; i++) {
		let s = 0;
		const o = i * dim;

		for (let d = from; d < to; d++) {
			s += data[o + d] * q[d];
		}

		out[i] = s;
	}

	return out;
}

// The best TOP groups, and the score of each of the hash's groups (for the
// re-rank of the hash's top 50), each group scored by its best card.
function topGroups(scores, groups, hashGroups) {
	const best = new Map();

	for (let i = 0; i < scores.length; i++) {
		const g = groups[i];

		if (!best.has(g) || scores[i] > best.get(g)) {
			best.set(g, scores[i]);
		}
	}

	const round = (s) => Math.round(s * 10000) / 10000;

	return {
		hash: hashGroups.map(([g]) => round(best.get(g) ?? -1)),
		top: [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP).map(([g, s]) => [g, round(s)]),
	};
}

// ------------------------------------------------------------ run

const hashFile = join(cache, `hash-${opts.variants ? 'variants' : 'kept'}.json`);
const hashCache = existsSync(hashFile) ? JSON.parse(readFileSync(hashFile, 'utf8')) : {};
const rows = queries.map((q) => ({id: q.id, set: q.set, truth: q.truth, truthGroup: truthGroup(q.truth), variant: q.variant, emb: {}}));
const images = new Map();
const imageOf = (i) => {
	if (!images.has(i)) {
		images.set(i, queries[i].make());
	}

	return images.get(i);
};

queries.forEach((q, i) => {
	const key = `${q.id}|${q.variant}`;

	if (!hashCache[key]) {
		const r = hashMatch(index, imageOf(i), {top: TOP});

		hashCache[key] = {gap: r.gap, groups: r.groups.map((g) => [g.group, Math.round(g.score * 10) / 10, g.cards.map((c) => refKey(c))]), sure: r.verdict.sure};
	}

	const h = hashCache[key];

	rows[i].hash = {gap: h.gap, groups: h.groups.map(([g, s]) => [g, s]), inUniverse: h.groups.filter(([g]) => universe.has(g)).map(([g, s]) => [g, s]), sure: h.sure};
});

writeFileSync(hashFile, JSON.stringify(hashCache));

for (const name of names) {
	const model = await loadModel(name, {threads: Number(opts.threads || 1)});
	const tables = loadTables(name);
	const half = model.spec.pool === 'both' ? tables.art.dim / 2 : 0;
	const pools = half ? {cls: [0, half], mean: [half, 2 * half], both: [0, 2 * half]} : {'': [0, tables.art.dim]};
	const started = performance.now();
	const saved = {art: [], card: []};

	for (let i = 0; i < queries.length; i++) {
		const e = await model.embed(imageOf(i));

		saved.art.push(e.art);
		saved.card.push(e.card);

		for (const [pool, [from, to]] of Object.entries(pools)) {
			const art = cosines(tables.art, e.art, from, to);
			const card = cosines(tables.card, e.card, from, to);
			const scale = half && pool === 'both' ? 0.5 : 1;
			const both = new Float32Array(art.length);

			for (let k = 0; k < art.length; k++) {
				art[k] *= scale;
				card[k] *= scale;
				both[k] = (art[k] + card[k]) / 2;
			}

			const tag = pool ? `${name}/${pool}` : name;

			const hashGroups = rows[i].hash.inUniverse;

			rows[i].emb[`${tag}/art`] = topGroups(art, tables.groups, hashGroups);
			rows[i].emb[`${tag}/card`] = topGroups(card, tables.groups, hashGroups);
			rows[i].emb[`${tag}/art+card`] = topGroups(both, tables.groups, hashGroups);
		}

		if (i === 0 || (i + 1) % 200 === 0) {
			console.error(`${name}: ${i + 1}/${queries.length} (${Math.round((performance.now() - started) / (i + 1))} ms per query)`);
		}

		if (images.size > 64) {
			images.delete(images.keys().next().value);
		}
	}

	// The query embeddings, for compress.mjs (PCA, int8, binary).
	if (opts.out) {
		for (const region of ['art', 'card']) {
			writeFileSync(outside(`${opts.out}.${name}-${region}.bin`), writeEmbeddingsBuffer(saved[region], saved[region][0].length));
		}
	}
}

const out = {refs: refs.length, rows, universe: universe.size};

if (opts.out) {
	writeFileSync(outside(opts.out), JSON.stringify(out));
}

console.error('done');
