// How small an embedding index can get: one scorer's vectors stored as
// float32, int8, PCA to k dimensions (float or int8), or PCA then one bit
// per dimension (sign, compared by Hamming distance), each scored as
// measure.mjs scores the full vectors.
//
// node lab/embedding/compress.mjs <rows.json> --scorer <model/pool/region>
//   [--without pt] [--forms float32,int8]
//
// --without leaves one catalog's reference images out (pt: the Portuguese
// images, so a Portuguese card is found through its English image only, as
// the fingerprint index does). --forms limits the storage forms tried.
//
// <rows.json> is measure.mjs's --out, run with that model, which also
// wrote the query embeddings beside it (<rows.json>.<model>-art.bin). PCA
// is fitted on the reference vectors only.

import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import {args as parseArgs, outside} from '../holder/lib.mjs';
import {MODELS, readEmbeddings, refKey} from './lib.mjs';

const opts = parseArgs();
const rowsFile = opts._[0];
const [model, ...rest] = String(opts.scorer).split('/');
const region = rest.pop();
const pool = rest[0] || '';
const cache = outside(process.env.EMB_CACHE || '/tmp/emb/tcgdex');
const {rows} = JSON.parse(readFileSync(rowsFile, 'utf8'));
const refs = JSON.parse(readFileSync(join(cache, 'refs.json'), 'utf8'));
const refGroup = new Map(refs.map((r) => [refKey(r), r.group]));
const keys = JSON.parse(readFileSync(join(cache, 'emb', `${model}.json`), 'utf8'));
const keep = keys.map((k) => !opts.without || !k.startsWith(`${opts.without}:`));
const groups = keys.map((k) => refGroup.get(k)).filter((_, i) => keep[i]);
const regions = region === 'art+card' ? ['art', 'card'] : [region];

// One vector per row: the chosen pool's slice of each region, each at unit
// length, concatenated and scaled so a dot product is the mean cosine.
function features(tables) {
	const {dim, n} = tables[0];
	const half = MODELS[model].pool === 'both' ? dim / 2 : 0;
	const [from, to] = !half ? [0, dim] : pool === 'cls' ? [0, half] : pool === 'mean' ? [half, dim] : [0, dim];
	const width = to - from;
	const D = width * tables.length;
	const out = new Float32Array(n * D);

	for (let i = 0; i < n; i++) {
		tables.forEach((t, r) => {
			let s = 0;

			for (let d = from; d < to; d++) {
				s += t.data[i * dim + d] ** 2;
			}

			s = Math.sqrt(s * tables.length) || 1;

			for (let d = from; d < to; d++) {
				out[i * D + r * width + d - from] = t.data[i * dim + d] / s;
			}
		});
	}

	return {D, data: out, n};
}

// The reference tables, minus the rows --without leaves out.
function kept(t) {
	const rows = keep.map((k, i) => (k ? i : -1)).filter((i) => i >= 0);
	const data = new Float32Array(rows.length * t.dim);

	rows.forEach((i, j) => data.set(t.data.subarray(i * t.dim, (i + 1) * t.dim), j * t.dim));

	return {data, dim: t.dim, n: rows.length};
}

const R = features(regions.map((r) => kept(readEmbeddings(join(cache, 'emb', `${model}-${r}.bin`)))));
const Q = features(regions.map((r) => readEmbeddings(`${rowsFile}.${model}-${r}.bin`)));

// ------------------------------------------------------------ PCA

function pca(X, k) {
	const {D, data, n} = X;
	const mean = new Float64Array(D);

	for (let i = 0; i < n; i++) {
		for (let d = 0; d < D; d++) {
			mean[d] += data[i * D + d] / n;
		}
	}

	const C = new Float64Array(D * D);
	const row = new Float64Array(D);

	for (let i = 0; i < n; i++) {
		for (let d = 0; d < D; d++) {
			row[d] = data[i * D + d] - mean[d];
		}

		for (let a = 0; a < D; a++) {
			const ra = row[a];
			const o = a * D;

			for (let b = a; b < D; b++) {
				C[o + b] += ra * row[b];
			}
		}
	}

	for (let a = 0; a < D; a++) {
		for (let b = 0; b < a; b++) {
			C[a * D + b] = C[b * D + a];
		}
	}

	// Subspace iteration for the top k eigenvectors.
	let V = Array.from({length: k}, (_, j) => Float64Array.from({length: D}, (_, d) => Math.sin((j + 1) * (d + 1) * 0.7) + (d === j ? 1 : 0)));

	for (let it = 0; it < 30; it++) {
		V = V.map((v) => {
			const w = new Float64Array(D);

			for (let a = 0; a < D; a++) {
				let s = 0;
				const o = a * D;

				for (let b = 0; b < D; b++) {
					s += C[o + b] * v[b];
				}

				w[a] = s;
			}

			return w;
		});

		for (let j = 0; j < k; j++) {
			for (let p = 0; p < j; p++) {
				let dot = 0;

				for (let d = 0; d < D; d++) {
					dot += V[j][d] * V[p][d];
				}

				for (let d = 0; d < D; d++) {
					V[j][d] -= dot * V[p][d];
				}
			}

			let s = 0;

			for (let d = 0; d < D; d++) {
				s += V[j][d] ** 2;
			}

			s = Math.sqrt(s) || 1;

			for (let d = 0; d < D; d++) {
				V[j][d] /= s;
			}
		}
	}

	return {
		project(Y, kk = k) {
			const out = new Float32Array(Y.n * kk);

			for (let i = 0; i < Y.n; i++) {
				for (let j = 0; j < kk; j++) {
					let s = 0;

					for (let d = 0; d < D; d++) {
						s += (Y.data[i * D + d] - mean[d]) * V[j][d];
					}

					out[i * kk + j] = s;
				}
			}

			return {D: kk, data: out, n: Y.n};
		},
	};
}

// ------------------------------------------------------------ storage forms

const unit = (X) => {
	const out = new Float32Array(X.data.length);

	for (let i = 0; i < X.n; i++) {
		let s = 0;

		for (let d = 0; d < X.D; d++) {
			s += X.data[i * X.D + d] ** 2;
		}

		s = Math.sqrt(s) || 1;

		for (let d = 0; d < X.D; d++) {
			out[i * X.D + d] = X.data[i * X.D + d] / s;
		}
	}

	return {...X, data: out};
};

// Symmetric int8 with one scale for the whole table (what a phone would
// store); the query stays float.
function int8(X) {
	let max = 0;

	for (const v of X.data) {
		max = Math.max(max, Math.abs(v));
	}

	const scale = 127 / (max || 1);

	return {...X, data: Float32Array.from(X.data, (v) => Math.round(v * scale) / scale)};
}

const sign = (X) => ({...X, data: Float32Array.from(X.data, (v) => (v >= 0 ? 1 : -1))});

function evaluate(refs, queries) {
	const {D} = refs;
	const res = {};

	for (let qi = 0; qi < queries.n; qi++) {
		const best = new Map();

		for (let i = 0; i < refs.n; i++) {
			let s = 0;

			for (let d = 0; d < D; d++) {
				s += refs.data[i * D + d] * queries.data[qi * D + d];
			}

			const g = groups[i];

			if (!best.has(g) || s > best.get(g)) {
				best.set(g, s);
			}
		}

		const row = rows[qi];
		const truth = best.get(row.truthGroup) ?? -Infinity;
		let rank = 0;

		for (const s of best.values()) {
			if (s > truth) {
				rank++;
			}
		}

		const set = row.set === 'video' ? 'video drops' : row.variant === 'as kept' ? 'as kept' : 're-crops';

		// The hash's top 50 re-ranked by this score, only when the app's
		// verdict was not sure (the "unsure only" of summarize.mjs).
		let first = row.hash.inUniverse[0] ? row.hash.inUniverse[0][0] : null;

		if (!row.hash.sure) {
			let top = -Infinity;

			for (const [g] of row.hash.inUniverse) {
				if ((best.get(g) ?? -Infinity) > top) {
					top = best.get(g);
					first = g;
				}
			}
		}

		const hashRight = row.hash.inUniverse[0] && row.hash.inUniverse[0][0] === row.truthGroup;

		res[set] ||= {alone: 0, n: 0, reranked: 0, right: 0};
		res[set].alone += (row.hash.sure ? hashRight : rank === 0) ? 1 : 0;
		res[set].n++;
		res[set].right += rank === 0 ? 1 : 0;
		res[set].reranked += first === row.truthGroup ? 1 : 0;
	}

	return res;
}

const forms = [['float32', R.D * 4, () => [R, Q]], ['int8', R.D, () => [int8(R), Q]]];

for (const k of [64, 128, 256]) {
	if (k < R.D) {
		forms.push([`PCA ${k} float32`, k * 4, (p) => [unit(p.project(R, k)), unit(p.project(Q, k))]]);
		forms.push([`PCA ${k} int8`, k, (p) => [int8(unit(p.project(R, k))), unit(p.project(Q, k))]]);
		forms.push([`PCA ${k} binary`, k / 8, (p) => [sign(p.project(R, k)), sign(p.project(Q, k))]]);
	}
}

// One fit of the largest k; the smaller ones are its first components.
const K = Math.max(...[64, 128, 256].filter((k) => k < R.D));

const only = opts.forms ? String(opts.forms).split(',') : null;
const fitted = !only || only.some((f) => f.startsWith('PCA')) ? pca(R, K) : null;

console.log(`\n${opts.scorer}: ${R.D} dimensions, ${R.n} reference cards${opts.without ? ` (without ${opts.without} images)` : ''}\n`);
console.log('| Stored as | Bytes per card | Index for 25,767 cards | Alone: as kept | Alone: re-crops | Alone: video | Unsure only: as kept | Unsure only: re-crops | Unsure only: video | Unsure, embedding alone: as kept | re-crops | video |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');

for (const [name, bytes, make] of forms.filter(([name]) => !only || only.includes(name))) {
	const [r, q] = make(fitted);
	const res = evaluate(r, q);
	const cell = (s, k = 'right') => (res[s] ? `${res[s][k]}/${res[s].n}` : '-');

	console.log(`| ${name} | ${bytes} | ${((bytes * 25767) / 1e6).toFixed(1)} MB | ${cell('as kept')} | ${cell('re-crops')} | ${cell('video drops')} | ${cell('as kept', 'reranked')} | ${cell('re-crops', 'reranked')} | ${cell('video drops', 'reranked')} | ${cell('as kept', 'alone')} | ${cell('re-crops', 'alone')} | ${cell('video drops', 'alone')} |`);
}
