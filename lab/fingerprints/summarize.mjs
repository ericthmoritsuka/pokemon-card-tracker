// Tables for RESULTS.md from measure.mjs's rows.
//
// node lab/fingerprints/summarize.mjs <rows.json> [--formula <name>]

import {readFileSync} from 'node:fs';

import {report} from './measure.mjs';

const file = process.argv[2];
const fi = process.argv.indexOf('--formula');
const F = fi > 0 ? process.argv[fi + 1] : 'art + card + colour, full-art weights';
const rows = JSON.parse(readFileSync(file, 'utf8'));
const pct = (k, n) => (n ? `${Math.round((100 * k) / n)} % (${k}/${n})` : '-');

report(rows);

function table(title, list, key) {
	console.log(`\n## ${title} (${F})\n`);
	console.log('| Slice | n | Exact card first | Art group first | Art group top 5 | Wrong first but same art (text breaks the tie) | Real misses |');
	console.log('| --- | --- | --- | --- | --- | --- | --- |');

	const keys = [...new Set(list.map(key))].concat('all');

	for (const k of keys) {
		const l = k === 'all' ? list : list.filter((r) => key(r) === k);
		const exact = l.filter((r) => r[F].strict === 1).length;
		const g1 = l.filter((r) => r[F].group === 1).length;
		const g5 = l.filter((r) => r[F].group <= 5).length;
		const sameArt = l.filter((r) => r[F].strict !== 1 && r[F].group === 1).length;

		console.log(`| ${k} | ${l.length} | ${pct(exact, l.length)} | ${pct(g1, l.length)} | ${pct(g5, l.length)} | ${pct(sameArt, l.length - exact)} of errors | ${l.length - g1} |`);
	}
}

const deg = rows.filter((r) => !['bench', 'photo'].includes(r.set));

table('Degraded TCGdex images, by query set', deg, (r) => r.set);
table('Degraded TCGdex images, by degradation', deg, (r) => r.pass);
table('Full art, by rarity', deg.filter((r) => r.set === 'fullart'), (r) => r.tag);
table('Scan benchmark captures through rectify.js, by capture', rows.filter((r) => r.set === 'bench'), (r) => r.pass);
table('Scan benchmark captures, by card group', rows.filter((r) => r.set === 'bench'), (r) => r.group);

// The gap between the first two groups when the first is right or wrong.
const gaps = (l, right) => l.filter((r) => (r[F].group === 1) === right).map((r) => r[F].gap).sort((a, b) => a - b);
const all = rows.filter((r) => r.set !== 'photo');

for (const t of [4, 6, 8, 10, 12]) {
	const auto = all.filter((r) => r[F].gap >= t);

	console.log(`gap >= ${t}: auto-select ${pct(auto.length, all.length)}, of which right art ${pct(auto.filter((r) => r[F].group === 1).length, auto.length)}`);
}

console.log(`median gap when right ${gaps(all, true)[Math.floor(gaps(all, true).length / 2)]}, when wrong ${gaps(all, false)[Math.floor(gaps(all, false).length / 2)]}`);

for (const r of rows.filter((x) => ['photo', 'ampharos'].includes(x.set))) {
	console.log(`${r.set} ${r.pass}: exact rank ${r[F].strict}, group rank ${r[F].group}, first ${r[F].first}, gap ${r[F].gap.toFixed(1)}`);
}

const benchMiss = rows.filter((r) => r.set === 'bench' && r[F].group !== 1).map((r) => `${r.pass} ${r.id} -> ${r[F].first}`);

console.log(`\nbench misses: ${benchMiss.join('; ')}`);
