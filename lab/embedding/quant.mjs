// How far a quantised model's vectors are from its float32 original: the
// cosine between the two on the same images (reference cards, both
// regions), and whether the nearest neighbour among those images stays the
// same. A cheap check that a smaller download is the same model in effect.
//
// node lab/embedding/quant.mjs <float model> <quantised model>... [--n 150]

import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {imageFile} from '../fingerprints/catalog.mjs';
import {args as parseArgs, median, outside} from '../holder/lib.mjs';
import {decodeFile, loadModel} from './lib.mjs';

const opts = parseArgs();
const [base, ...others] = opts._;
const n = Number(opts.n || 150);
const cache = outside(process.env.EMB_CACHE || '/tmp/emb/tcgdex');
const refs = JSON.parse(readFileSync(join(cache, 'refs.json'), 'utf8'));
const step = Math.floor(refs.length / n);
const sample = Array.from({length: n}, (_, i) => refs[i * step]);
const images = [];

for (const card of sample) {
	images.push(await decodeFile(imageFile(cache, card)));
}

async function vectors(name) {
	const model = await loadModel(name);
	const out = [];

	for (const img of images) {
		const e = await model.embed(img);

		out.push([...e.art, ...e.card]);
	}

	return out;
}

const raw = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const dot = (a, b) => raw(a, b) / Math.sqrt(raw(a, a) * raw(b, b));
const nearest = (vs, i) => vs.reduce((best, v, j) => (j !== i && dot(vs[i], v) > dot(vs[i], vs[best] || vs[(i + 1) % vs.length]) ? j : best), (i + 1) % vs.length);
const ref = await vectors(base);

for (const name of others) {
	const q = await vectors(name);
	const cos = q.map((v, i) => dot(v, ref[i]));
	const same = q.filter((_, i) => nearest(q, i) === nearest(ref, i)).length;

	console.log(`${name} against ${base}: cosine median ${median(cos).toFixed(4)}, min ${Math.min(...cos).toFixed(4)}; same nearest neighbour ${same}/${n}`);
}
