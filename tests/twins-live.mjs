// A run of js/twins.js against real TCGdex data: the six Japanese sets the
// research measured (M3, M4, M5, S11, SV10, SV6a) plus M6, which has no
// English counterpart yet. It reports coverage per set and category and,
// given the research matcher's results, how often the two agree.
//
// English cards come through the module's own GraphQL path. Japanese card
// and set records are TCGdex REST responses, kept in TWINS_CACHE (default
// /tmp/twins-live) so a rerun sends no requests for them; a file named
// ja_<card id>.json already there (the research's cache) is used as is.
// Nothing is written inside the repo.
//
// TWINS_BASELINE is a JSON file of the research results, {<card id>:
// {status, top}}, status being match2.py's verdict ("one", "one-lowconf",
// "several", "weak", "none"). Without it, only coverage is reported.
//
// Run: TWINS_BASELINE=/tmp/twins_baseline.json node tests/twins-live.mjs

import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {createTwins, limiter, memoryStore} from '../js/twins.js';

const CACHE = process.env.TWINS_CACHE || '/tmp/twins-live';
const SETS = (process.env.TWINS_SETS || 'M3,M4,M5,S11,SV10,SV6a,M6').split(',');
const MEASURED = new Set(['M3', 'M4', 'M5', 'S11', 'SV10', 'SV6a']);
const API = 'https://api.tcgdex.net/v2/ja/';
const STATUS = {none: 'none', one: 'confident', 'one-lowconf': 'ambiguous', several: 'ambiguous', weak: 'weak'};

await mkdir(CACHE, {recursive: true});

const restLimit = limiter(4);
let requests = 0;

async function rest(path, file) {
	try {
		return JSON.parse(await readFile(join(CACHE, file), 'utf8'));
	}
	catch {
		// Not cached yet.
	}

	const data = await restLimit(async () => {
		for (let attempt = 0; attempt < 5; attempt++) {
			requests++;

			const response = await fetch(API + path).catch(() => null);

			if (response && response.ok) {
				return response.json();
			}

			if (response && ![429, 502, 503, 504].includes(response.status)) {
				throw new Error(`${response.status} for ${path}`);
			}

			await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
		}

		throw new Error(`No answer for ${path}`);
	});

	delete data.pricing;
	delete data.variants_detailed;
	await writeFile(join(CACHE, file), JSON.stringify(data));

	return data;
}

const ja = {
	cardDetail: (id) => rest(`cards/${encodeURIComponent(id)}`, `ja_${id}.json`),
	setDetail: (id) => rest(`sets/${encodeURIComponent(id)}`, `jaset_${id}.json`),
};

let graphqlRequests = 0;
const twins = createTwins({
	fetch: (...args) => {
		graphqlRequests++;

		return fetch(...args);
	},
	ja,
	store: memoryStore(),
});

const baseline = process.env.TWINS_BASELINE ? JSON.parse(await readFile(process.env.TWINS_BASELINE, 'utf8')) : null;
const started = Date.now();
const totals = {};
const disagreements = [];
let agree = 0;
let compared = 0;

for (const setId of SETS) {
	const set = await ja.setDetail(setId);
	const records = await Promise.all(set.cards.map((card) => ja.cardDetail(card.id)));
	const counts = {};

	for (const record of records) {
		const result = await twins.findTwin(record);
		const top = result.candidates[0] ? result.candidates[0].id : null;
		const group = MEASURED.has(setId) ? 'measured' : setId;

		counts[result.status] = (counts[result.status] || 0) + 1;
		totals[group] = totals[group] || {};
		totals[group][`${record.category}:${result.status}`] = (totals[group][`${record.category}:${result.status}`] || 0) + 1;

		if (baseline && baseline[record.id]) {
			const expected = baseline[record.id];
			const same = STATUS[expected.status] === result.status && (expected.top || null) === top;

			compared++;

			if (same) {
				agree++;
			}
			else {
				disagreements.push(`${record.id} research ${expected.status} ${expected.top}, module ${result.status} ${top}`);
			}
		}
	}

	console.log(setId, records.length, JSON.stringify(counts));
}

for (const [group, counts] of Object.entries(totals)) {
	const by = {};

	for (const [key, n] of Object.entries(counts)) {
		const [category, status] = key.split(':');

		by[category] = by[category] || {all: 0};
		by[category].all += n;
		by[category][status] = (by[category][status] || 0) + n;
	}

	const all = Object.values(by).reduce((sum, row) => sum + row.all, 0);
	const confident = Object.values(by).reduce((sum, row) => sum + (row.confident || 0), 0);

	console.log(`${group}: ${confident}/${all} confident (${(100 * confident / all).toFixed(1)}%)`);

	for (const [category, row] of Object.entries(by)) {
		console.log(`  ${category}: ${JSON.stringify(row)} (${(100 * (row.confident || 0) / row.all).toFixed(1)}% confident)`);
	}
}

if (baseline) {
	console.log(`agreement with the research: ${agree}/${compared}`);

	for (const line of disagreements) {
		console.log(`  ${line}`);
	}
}

console.log(`requests: ${graphqlRequests} GraphQL, ${requests} REST; ${((Date.now() - started) / 1000).toFixed(1)} s`);
