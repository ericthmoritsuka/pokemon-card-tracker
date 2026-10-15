// Embeds every reference card (refs.mjs) with one model, both regions.
//
// node lab/embedding/embed-refs.mjs <model> [--threads 1]
//
// Writes $EMB_CACHE/emb/<model>.json (the keys, in row order) and
// <model>-art.bin, <model>-card.bin. Rows already embedded are kept, so
// adding cards to refs.json only embeds the new ones. Reports the time
// the network took per image (both regions) on this machine.

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {imageFile} from '../fingerprints/catalog.mjs';
import {args as parseArgs, median, outside} from '../holder/lib.mjs';
import {decodeFile, loadModel, readEmbeddings, REGIONS, refKey, writeEmbeddingsBuffer} from './lib.mjs';

const opts = parseArgs();
const name = opts._[0];
const cache = outside(process.env.EMB_CACHE || '/tmp/emb/tcgdex');
const dir = join(cache, 'emb');

mkdirSync(dir, {recursive: true});

const refs = JSON.parse(readFileSync(join(cache, 'refs.json'), 'utf8')).filter((card) => existsSync(imageFile(cache, card)));
const model = await loadModel(name, {threads: Number(opts.threads || 1)});
const keysFile = join(dir, `${name}.json`);
const old = new Map();

if (existsSync(keysFile)) {
	const keys = JSON.parse(readFileSync(keysFile, 'utf8'));
	const tables = Object.fromEntries(Object.keys(REGIONS).map((r) => [r, readEmbeddings(join(dir, `${name}-${r}.bin`))]));

	keys.forEach((key, i) => old.set(key, Object.fromEntries(Object.entries(tables).map(([r, t]) => [r, t.data.slice(i * t.dim, (i + 1) * t.dim)]))));
}

const rows = [];
const times = [];
let done = 0;

for (const card of refs) {
	const key = refKey(card);

	if (old.has(key)) {
		rows.push(old.get(key));
		continue;
	}

	const before = model.netMs;

	rows.push(await model.embed(await decodeFile(imageFile(cache, card))));
	times.push(model.netMs - before);

	if (++done % 250 === 0) {
		console.log(`${name}: ${done} embedded, median ${median(times).toFixed(1)} ms per image (both regions)`);
	}
}

for (const region of Object.keys(REGIONS)) {
	writeFileSync(join(dir, `${name}-${region}.bin`), writeEmbeddingsBuffer(rows.map((r) => r[region]), rows[0][region].length));
}

writeFileSync(keysFile, JSON.stringify(refs.map(refKey)));
console.log(`${name}: ${refs.length} references (${done} new), median ${times.length ? median(times).toFixed(1) : '-'} ms per image (both regions), dim ${rows[0].art.length}`);
