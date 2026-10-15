// Tables from measure.mjs rows (lab/embedding/RESULTS.md).
//
// node lab/embedding/summarize.mjs <rows.json>... [--best a/b/c,...]
//   [--ablation] [--variants] [--wrong]
//
// Several rows files from runs over the same queries (one per model, run
// in parallel) are merged. Every method is scored by artwork group:
//
// - hash (whole index): the app's answer, all 25,767 cards;
// - hash (reference set): the same groups, keeping only those with a card
//   in the reference set, so it meets the same rivals as the embedding;
// - <scorer>: the embedding alone over the reference set;
// - RRF: reciprocal rank fusion of the hash's and the embedding's top 50
//   (score 1/(60 + rank) from each, summed);
// - re-rank 50: the hash's top 50 groups in the order of the embedding's
//   score;
// - unsure only: the hash's answer when the app's verdict is sure, else
//   the re-rank (what the app could do without touching sure answers).
//
// --best: the scorers given the fusion rows (default: the best one per
// model on the re-crops). --ablation: every scorer. --variants: a table
// per re-crop. --wrong: the wrong first answers of the main methods.

import {readFileSync} from 'node:fs';

import {args as parseArgs, median} from '../holder/lib.mjs';

const opts = parseArgs();
const files = opts._.map((f) => JSON.parse(readFileSync(f, 'utf8')));
const rows = files[0].rows.map((row, i) => ({...row, emb: Object.assign({}, ...files.map((f) => f.rows[i].emb))}));
const scorers = Object.keys(rows[0].emb);
const K = 60;

const rankOf = (list, g) => list.findIndex(([x]) => x === g);

function rrf(a, b) {
	const score = new Map();

	for (const list of [a, b]) {
		list.forEach(([g], r) => score.set(g, (score.get(g) || 0) + 1 / (K + r + 1)));
	}

	return [...score.entries()].sort((x, y) => y[1] - x[1]);
}

function rerank(row, scorer) {
	const hash = row.hash.inUniverse;
	const scores = row.emb[scorer].hash;

	return hash.map(([g], i) => [g, scores[i]]).sort((x, y) => y[1] - x[1]);
}

// method name -> (row) -> ranked groups, plus the margin a sure policy would use.
function methods(best) {
	const m = {
		'hash (whole index)': (row) => row.hash.groups,
		'hash (reference set)': (row) => row.hash.inUniverse,
		// The ceiling of any re-rank of the hash's list: the right group
		// anywhere in it counts as first.
		'(ceiling: right card anywhere in the hash top 50)': (row) => (row.hash.inUniverse.some(([g]) => g === row.truthGroup) ? [[row.truthGroup, 0]] : row.hash.inUniverse),
	};

	for (const s of best) {
		m[s] = (row) => row.emb[s].top;
		m[`${s} RRF`] = (row) => rrf(row.hash.inUniverse, row.emb[s].top);
		m[`${s} re-rank 50`] = (row) => rerank(row, s);
		m[`${s} unsure only`] = (row) => (row.hash.sure ? row.hash.inUniverse : rerank(row, s));
		m[`${s} unsure: RRF`] = (row) => (row.hash.sure ? row.hash.inUniverse : rrf(row.hash.inUniverse, row.emb[s].top));
		m[`${s} unsure: embedding alone`] = (row) => (row.hash.sure ? row.hash.inUniverse : row.emb[s].top);
	}

	return m;
}

function score(list, row) {
	const rank = rankOf(list, row.truthGroup);

	return {rank, right: rank === 0, top5: rank >= 0 && rank < 5};
}

const pct = (n, d) => (d ? `${Math.round((1000 * n) / d) / 10}%` : 'n/a');
const sets = [
	['log crops as kept', (r) => r.set === 'log' && r.variant === 'as kept'],
	['log re-crops (11 kinds)', (r) => r.set === 'log' && r.variant !== 'as kept'],
	['video drops', (r) => r.set === 'video'],
].filter(([, f]) => rows.some(f));

function table(m, title) {
	console.log(`\n### ${title}\n`);
	console.log(`| Method | ${sets.map(([name]) => `${name}: first, top 5`).join(' | ')} |`);
	console.log(`| --- | ${sets.map(() => '---').join(' | ')} |`);

	for (const [name, fn] of Object.entries(m)) {
		const cells = sets.map(([, f]) => {
			const list = rows.filter(f);
			const s = list.map((r) => score(fn(r), r));

			return `${s.filter((x) => x.right).length}/${list.length} (${pct(s.filter((x) => x.right).length, list.length)}), ${pct(s.filter((x) => x.top5).length, list.length)}`;
		});

		console.log(`| ${name} | ${cells.join(' | ')} |`);
	}
}

const reCrops = rows.filter((r) => r.set === 'log' && r.variant !== 'as kept');
const rightOn = (s, list) => list.filter((r) => score(r.emb[s].top, r).right).length;
const byModel = {};

for (const s of scorers) {
	const model = s.split('/')[0];

	if (!byModel[model] || rightOn(s, reCrops) > rightOn(byModel[model], reCrops)) {
		byModel[model] = s;
	}
}

const best = opts.best ? String(opts.best).split(',') : Object.values(byModel);

console.log(`${rows.length} queries; reference set ${files[0].refs} cards in ${files[0].universe} artwork groups`);
table(methods(best), 'Right card first and in the top 5 (artwork group)');

if (opts.ablation) {
	const m = {};

	for (const s of scorers) {
		m[s] = (row) => row.emb[s].top;
	}

	table(m, 'Every scorer alone');
}

// Margins: the lead of the first group over the second. For the embedding
// a cosine difference; the hash's is its gap in distance points.
console.log('\n### Margins (first group\'s lead over the second)\n');
console.log('| Method | Median when right | Median when wrong | Largest when wrong | Right first with a lead above every wrong one |');
console.log('| --- | --- | --- | --- | --- |');

for (const [name, fn] of Object.entries({'hash (whole index)': (r) => r.hash.groups, ...Object.fromEntries(best.map((s) => [s, (r) => r.emb[s].top]))})) {
	const right = [];
	const wrong = [];
	const isHash = name.startsWith('hash');

	for (const r of rows) {
		const list = fn(r);
		const margin = list.length > 1 ? (isHash ? list[1][1] - list[0][1] : list[0][1] - list[1][1]) : Infinity;

		(score(list, r).right ? right : wrong).push(margin);
	}

	const worst = Math.max(...wrong.filter(Number.isFinite));
	const above = right.filter((x) => x > worst).length;
	const f = (x) => (x === null ? '-' : isHash ? x.toFixed(1) : x.toFixed(3));

	console.log(`| ${name} | ${f(median(right))} | ${f(median(wrong))} | ${wrong.length ? f(worst) : '-'} | ${above}/${rows.length} (${pct(above, rows.length)}) |`);
}

console.log('\nHash, app verdict "sure" on all queries:', `${rows.filter((r) => r.hash.sure).length}/${rows.length}, wrong but sure ${rows.filter((r) => r.hash.sure && !score(r.hash.groups, r).right).length}`);

if (opts.variants) {
	const m = methods(best);
	const vs = [...new Set(rows.map((r) => r.variant))];

	console.log('\n### Right card first by crop\n');
	console.log(`| Crop | n | ${Object.keys(m).join(' | ')} |`);
	console.log(`| --- | --- | ${Object.keys(m).map(() => '---').join(' | ')} |`);

	for (const v of vs) {
		const list = rows.filter((r) => r.variant === v);

		console.log(`| ${v} | ${list.length} | ${Object.values(m).map((fn) => list.filter((r) => score(fn(r), r).right).length).join(' | ')} |`);
	}
}

if (opts.wrong) {
	const m = methods(best);

	for (const name of ['hash (whole index)', ...best]) {
		const wrong = rows.filter((r) => !score(m[name](r), r).right);

		console.log(`\n${name}: ${wrong.length} wrong`);

		for (const r of wrong.slice(0, 40)) {
			const list = m[name](r);

			console.log(`  ${r.set} ${r.variant} ${r.truth} -> group ${list[0] ? list[0][0] : '-'} (rank of right ${rankOf(list, r.truthGroup)})`);
		}
	}
}
