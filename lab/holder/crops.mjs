// Identification benchmark from scan-log crops (lab/holder/README.md).
//
// node lab/holder/crops.mjs <scan-log.json>... [--repo <checkout>] [--variants]
//   [--out <results.json>] [--only <regexp on the truth id>] [--verbose]
//
// Each log entry's straightened card (the JPEG the scanner kept, 420 px
// tall) goes through the app's picture match (js/scan/picture.js matchCrops,
// pictureVerdict) and is scored against the card Eric saved for it: right
// group first, sure, unsure, and wrong but sure (the failure that matters).
// --variants also re-crops every card the ways a bad crop goes wrong
// (moved, zoomed, a strip of the card underneath, turned, blurred) and
// scores each variant the same way. --repo runs another checkout's matcher
// on the same crops, for a before and after.

import {writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

import {VARIANTS} from './recrop.mjs';
import {args as parseArgs, dataUrlBytes, decodeImage, loadFingerprintIndex, median, outside, pct, readLogs, REPO} from './lib.mjs';

const opts = parseArgs();
const repo = resolve(opts.repo || REPO);
const picture = await import(pathToFileURL(join(repo, 'js/scan/picture.js')).href);
const index = loadFingerprintIndex(join(repo, 'js/vision/index.bin'));
const only = opts.only ? new RegExp(opts.only) : null;
const entries = readLogs(opts._).filter((e) => e.picture && e.truth && (!only || only.test(e.truth)));

if (!entries.length) {
	console.error('No log entries with a picture and a saved card.');
	process.exit(1);
}

// ------------------------------------------------------------ scoring

function score(entry, img) {
	const started = performance.now();
	const matched = picture.matchCrops(index, [img]);
	const ms = performance.now() - started;
	const compact = picture.compactPicture(matched);
	const verdict = picture.pictureVerdict(compact);
	const groups = matched.groups;
	const rank = groups.findIndex((g) => g.cards.some((c) => c.id === entry.truth));
	const right = rank === 0;
	const sure = verdict.sure;
	// "Several": a clear lead whose group holds more than one print; the
	// number read settles it, so it counts as right-and-clear here.
	const clear = verdict.clear;

	return {
		clear,
		distance: groups[0] ? Math.round(groups[0].score * 10) / 10 : null,
		gap: Number.isFinite(matched.gap) ? Math.round(matched.gap * 10) / 10 : null,
		ms: Math.round(ms),
		rank,
		right,
		sure,
		top: groups[0] ? groups[0].cards[0].id : null,
		wrongSure: sure && !right,
		wrongClear: clear && !right,
	};
}

const variants = opts.variants ? VARIANTS : VARIANTS.slice(0, 1);
const decoded = entries.map((entry) => decodeImage(dataUrlBytes(entry.picture)));
const rows = [];

entries.forEach((entry, i) => {
	const img = decoded[i];
	const other = decoded[(i + 7) % decoded.length];

	for (const variant of variants) {
		const r = score(entry, variant.make(img, other));

		rows.push({app: entry.app, id: entry.id, truth: entry.truth, variant: variant.name, ...r});

		if (opts.verbose && variant === variants[0]) {
			console.log(`${String(i).padStart(3)} ${entry.app} ${entry.truth.padEnd(12)} ${r.right ? 'right' : `WRONG(${r.top}, rank ${r.rank})`} d=${r.distance} gap=${r.gap} ${r.sure ? 'sure' : r.clear ? 'clear' : 'unsure'}${r.wrongSure ? ' WRONG-SURE' : ''}`);
		}
	}
});

function summary(list) {
	const n = list.length;

	return {
		clear: list.filter((r) => r.clear && r.right).length,
		medianDistance: median(list.filter((r) => r.right).map((r) => r.distance)),
		medianMs: median(list.map((r) => r.ms)),
		n,
		right: list.filter((r) => r.right).length,
		sure: list.filter((r) => r.sure).length,
		sureRight: list.filter((r) => r.sure && r.right).length,
		top5: list.filter((r) => r.rank >= 0).length,
		unsure: list.filter((r) => !r.sure).length,
		wrongClear: list.filter((r) => r.wrongClear).length,
		wrongSure: list.filter((r) => r.wrongSure).length,
	};
}

console.log(`\n${entries.length} crops from ${opts._.length} log(s), matcher from ${repo === REPO ? 'this checkout' : repo}\n`);
console.log('| Crop | n | Right first | Top 5 | Sure (right) | Unsure | Wrong but sure | Median distance (right) |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');

const table = {};

for (const variant of variants) {
	const s = summary(rows.filter((r) => r.variant === variant.name));

	table[variant.name] = s;
	console.log(`| ${variant.name} | ${s.n} | ${s.right} (${pct(s.right, s.n)}) | ${s.top5} | ${s.sure} (${s.sureRight}) | ${s.unsure} (${pct(s.unsure, s.n)}) | ${s.wrongSure} | ${s.medianDistance} |`);
}

if (variants.length > 1) {
	const s = summary(rows.filter((r) => r.variant !== variants[0].name));

	table['all re-crops'] = s;
	console.log(`| all re-crops | ${s.n} | ${s.right} (${pct(s.right, s.n)}) | ${s.top5} | ${s.sure} (${s.sureRight}) | ${s.unsure} (${pct(s.unsure, s.n)}) | ${s.wrongSure} | ${s.medianDistance} |`);
}

for (const app of [...new Set(entries.map((e) => e.app))]) {
	const s = summary(rows.filter((r) => r.app === app && r.variant === variants[0].name));

	console.log(`\n${app}: ${s.right}/${s.n} right first, ${s.sure} sure, ${s.unsure} unsure (${pct(s.unsure, s.n)}), ${s.wrongSure} wrong but sure`);
}

console.log(`\nMedian match time per crop: ${table[variants[0].name].medianMs} ms (this machine)`);

if (opts.out) {
	writeFileSync(outside(opts.out), JSON.stringify({rows, table}, null, 1));
}
