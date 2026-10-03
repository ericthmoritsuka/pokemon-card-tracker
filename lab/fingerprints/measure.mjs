// Measures the fingerprint against the TCGdex catalogs (RESULTS.md).
//
// node lab/fingerprints/measure.mjs [--sets fullart,framed,ja,pt]
//   [--passes clean,blur,...] [--bench <dataset.json>] [--photo <file>
//   --box x,y,w,h --truth <id>] [--timing] [--throttle 4] [--out <file>]
//
// Needs the descriptors build-index.mjs keeps in FP_CACHE (run it first).
// Query images are each card's high.webp (600 x 825), a different rendering
// from the low.webp the index is built from, degraded in headless Chromium
// (harness.js DEGRADATIONS) or put through the scan benchmark's captures and
// js/scan/rectify.js (--bench, lab/bench/dataset.json). Scores are worked
// out here, over every card in the index, for each way of combining the
// descriptors, so one run compares them all.
//
// --timing loads the packed index (lab/fingerprints/index.bin) in the page
// and times rectify, fingerprint, and match per capture, at --throttle.

import {mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {join, relative, resolve} from 'node:path';

import {artGroups, CACHE, describeAll, field, indexOrder, RECORD, signed, words} from './build-index.mjs';
import {cachedJson, catalogCards} from './catalog.mjs';
import {colorDistance, popcount32} from './fingerprint.js';
import {openPage, REPO, startServer} from './serve.mjs';

const args = Object.fromEntries(process.argv.slice(2)
	.map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : null))
	.filter(Boolean));

const exists = (path) => stat(path).then(() => true, () => false);
const SHIFTS = 7;

function seeded(text) {
	let h = 2166136261;

	for (const ch of text) {
		h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
	}

	return () => {
		h = Math.imul(h ^ (h >>> 15), 2246822507);
		h = Math.imul(h ^ (h >>> 13), 3266489909);
		h ^= h >>> 16;

		return (h >>> 0) / 4294967296;
	};
}

function sample(list, n, seed) {
	const rand = seeded(seed);
	const copy = [...list];

	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));

		[copy[i], copy[j]] = [copy[j], copy[i]];
	}

	return copy.slice(0, n);
}

const recent = (id) => /^(sv|me)\d/.test(id);

// The query sets: {name, cards: [{id, catalog, image, full, truth}]}, where
// truth is the index key the right answer has ("en:me04-090").
async function querySets(indexCards) {
	const lists = {};

	for (const lang of ['en', 'pt', 'ja']) {
		lists[lang] = await cachedJson(CACHE, `${lang}/cards`, `cards-${lang}.json`);
	}

	const inIndex = new Map(indexCards.map((c) => [`${c.catalog}:${c.id}`, c]));
	const rarity = async (r) => (await cachedJson(CACHE, `en/cards?rarity=${encodeURIComponent(r)}`, `rarity-en-${r.replace(/\W+/g, '_')}.json`)).map((c) => c.id);
	const en = (ids, tag) => ids.filter((id) => inIndex.has(`en:${id}`)).map((id) => ({...inIndex.get(`en:${id}`), tag, truth: `en:${id}`}));
	const sir = (await rarity('Special illustration rare')).filter(recent);
	const ir = (await rarity('Illustration rare')).filter(recent);
	const gold = [...await rarity('Hyper rare'), ...await rarity('Mega Hyper Rare'), ...await rarity('Black White Rare'), ...await rarity('Shiny Ultra Rare')].filter(recent);
	const ultra = sample((await rarity('Ultra Rare')).filter(recent), 80, 'ultra');
	const framed = sample(indexCards.filter((c) => c.catalog === 'en' && !c.full), 300, 'framed');
	const ja = sample(indexCards.filter((c) => c.catalog === 'ja'), 120, 'ja');
	const ptCards = sample(lists.pt.filter((c) => c.image && /^(sv|me|swsh)\d/.test(c.id) && inIndex.has(`en:${c.id}`)), 60, 'pt')
		.map((c) => ({...inIndex.get(`en:${c.id}`), catalog: 'pt', image: c.image, tag: 'pt', truth: `en:${c.id}`}));

	return {
		fullart: [...en(sir, 'sir'), ...en(ir, 'ir'), ...en(gold, 'gold'), ...en(ultra, 'ultra')],
		framed: framed.map((c) => ({...c, tag: 'framed', truth: `en:${c.id}`})),
		ja: ja.map((c) => ({...c, tag: 'ja', truth: `ja:${c.id}`})),
		pt: ptCards,
		// The Portuguese Ampharos special illustration rare from Chaos Rising.
		ampharos: [{...inIndex.get('en:me04-090'), catalog: 'pt', image: 'https://assets.tcgdex.net/pt/me/me04/090', tag: 'ampharos', truth: 'en:me04-090'}],
	};
}

const highFile = (card) => join(CACHE, 'high', card.catalog, `${card.id.replace(/[^\w.-]/g, '_')}.webp`);

async function downloadHigh(cards) {
	let next = 0;
	let fetched = 0;

	async function worker() {
		while (next < cards.length) {
			const card = cards[next++];
			const file = highFile(card);

			if (await exists(file)) {
				continue;
			}

			const response = await fetch(`${card.image}/high.webp`).catch(() => null);

			if (response && response.ok) {
				await mkdir(join(file, '..'), {recursive: true});
				await writeFile(file, Buffer.from(await response.arrayBuffer()));
				fetched++;
			}
		}
	}

	await Promise.all(Array.from({length: 4}, worker));

	return fetched;
}

// Index side, as flat arrays for the scan.
function indexTables(records, n) {
	const t = {art128: new Uint32Array(n * 4), art64: new Uint32Array(n * 2), card128: new Uint32Array(n * 4), card64: new Uint32Array(n * 2), color: new Int8Array(n * 16)};

	for (let i = 0; i < n; i++) {
		t.art64.set(words(field(records, i, 'art64')), i * 2);
		t.art128.set(words(field(records, i, 'art128')), i * 4);
		t.card64.set(words(field(records, i, 'card64')), i * 2);
		t.card128.set(words(field(records, i, 'card128')), i * 4);
		t.color.set(signed(field(records, i, 'color')), i * 16);
	}

	return t;
}

// Per card, the best distance over the query's shifts for each descriptor.
function distances(t, n, query, shifts) {
	const q = Buffer.from(query, 'base64');
	const recs = shifts.map((s) => new Uint8Array(q.buffer, q.byteOffset + s * RECORD, RECORD));
	const get = (name) => recs.map((r) => words(field(r, 0, name)));
	const out = {};

	for (const [name, w] of [['art64', 2], ['card64', 2], ['art128', 4], ['card128', 4]]) {
		const qs = get(name);
		const d = new Uint16Array(n);
		const table = t[name];

		for (let i = 0; i < n; i++) {
			let best = 999;

			for (const h of qs) {
				let s = 0;

				for (let k = 0; k < w; k++) {
					s += popcount32(table[i * w + k] ^ h[k]);
				}

				if (s < best) {
					best = s;
				}
			}

			d[i] = best;
		}

		out[name] = d;
	}

	const qc = recs.map((r) => signed(field(r, 0, 'color')));
	const dc = new Float32Array(n);

	for (let i = 0; i < n; i++) {
		const e = t.color.subarray(i * 16, i * 16 + 16);
		let best = Infinity;

		for (const c of qc) {
			best = Math.min(best, colorDistance(e, c));
		}

		dc[i] = best;
	}

	out.color = dc;

	return out;
}

// Ways of combining the descriptors. Each gives a score per card (lower is
// better); `full` weights apply to full-art cards.
export const FORMULAS = {
	'art pHash 64': {framed: {art64: 1}},
	'art pHash 128': {framed: {art128: 1}},
	'card pHash 64': {framed: {card64: 1}},
	'colour layout': {framed: {color: 1}},
	'art 64 + colour': {framed: {art64: 1, color: 0.1}},
	'art 64 + card 64': {framed: {art64: 1, card64: 1}},
	'art + card + colour': {framed: {art64: 1, card64: 0.5, color: 0.1}},
	'art + card + colour, full-art weights': {framed: {art64: 1, card64: 0.5, color: 0.1}, full: {art64: 0.6, card64: 1, color: 0.1}},
	'128-bit art + card + colour, full-art weights': {framed: {art128: 1, card128: 0.5, color: 0.1}, full: {art128: 0.6, card128: 1, color: 0.1}},
};

function score(formula, d, flags, n) {
	const s = new Float32Array(n);
	const fw = formula.full || formula.framed;

	for (let i = 0; i < n; i++) {
		const w = flags[i] ? fw : formula.framed;
		let v = 0;

		for (const k in w) {
			v += w[k] * d[k][i];
		}

		s[i] = v;
	}

	return s;
}

// Rank facts for one score array: strict rank of the truth card, rank of
// its artwork group, the first card's key, and the gap between the first
// two groups.
function rankOf(s, truthIndex, groups, keys) {
	const n = s.length;
	const order = [];
	const truthScore = s[truthIndex];
	let strict = 1;

	for (let i = 0; i < n; i++) {
		if (s[i] < truthScore || (s[i] === truthScore && i < truthIndex)) {
			strict++;
		}
	}

	// The best 64 cards, sorted, for groups.
	let cut = Infinity;

	for (let i = 0; i < n; i++) {
		if (order.length < 64 || s[i] < cut) {
			order.push(i);

			if (order.length > 128) {
				order.sort((a, b) => s[a] - s[b]);
				order.length = 64;
				cut = s[order[63]];
			}
		}
	}

	order.sort((a, b) => s[a] - s[b]);

	const seen = [];
	const groupScore = [];

	for (const i of order) {
		if (!seen.includes(groups[i])) {
			seen.push(groups[i]);
			groupScore.push(s[i]);
		}
	}

	const g = seen.indexOf(groups[truthIndex]);

	return {first: keys[order[0]], gap: groupScore.length > 1 ? groupScore[1] - groupScore[0] : 99, group: g < 0 ? 99 : g + 1, sameArtAsFirst: groups[order[0]] === groups[truthIndex], strict};
}

const pct = (k, n) => (n ? `${Math.round((100 * k) / n)} % (${k})` : '-');

async function main() {
	const listed = (await catalogCards(CACHE)).sort(indexOrder);
	const {cards, records} = await describeAll(listed);
	const n = cards.length;
	const keys = cards.map((c) => `${c.catalog}:${c.id}`);
	const keyIndex = new Map(keys.map((k, i) => [k, i]));
	const flags = Uint8Array.from(cards, (c) => (c.full ? 1 : 0));
	const groupFile = join(CACHE, `groups-${n}.bin`);
	let groups;

	if (await exists(groupFile)) {
		groups = new Uint32Array(new Uint8Array(await readFile(groupFile)).buffer);
	}
	else {
		const t0 = Date.now();

		groups = artGroups(records, n);
		console.log(`groups in ${Math.round((Date.now() - t0) / 1000)} s`);
		await writeFile(groupFile, Buffer.from(groups.buffer));
	}

	const t = indexTables(records, n);
	const sets = await querySets(cards);
	const wanted = args.sets ? String(args.sets).split(',') : Object.keys(sets);
	const passes = args.passes ? String(args.passes).split(',') : ['clean', 'blur', 'glare', 'cast', 'jpeg40', 'rotate', 'shift', 'sleeve', 'foil', 'phone'];
	const server = await startServer({cache: CACHE, photo: args.photo ? resolve(String(args.photo)) : null});
	const {browser, context, page} = await openPage(server, '/pokemon-card-tracker/lab/fingerprints/harness.html');
	const rows = [];
	const all = Array.from({length: SHIFTS}, (_, i) => i);

	const evaluate = (query, truth, meta) => {
		const ti = keyIndex.get(truth);

		if (ti === undefined) {
			return;
		}

		const d = distances(t, n, query, all);
		const d0 = distances(t, n, query, [0]);
		const row = {...meta, truth};

		for (const [name, f] of Object.entries(FORMULAS)) {
			row[name] = rankOf(score(f, d, flags, n), ti, groups, keys);
		}

		row['no shifts'] = rankOf(score(FORMULAS['art + card + colour, full-art weights'], d0, flags, n), ti, groups, keys);
		rows.push(row);
	};

	for (const name of wanted.filter((w) => sets[w])) {
		const list = sets[name];

		console.log(`${name}: ${list.length} cards, ${await downloadHigh(list)} high images fetched`);

		for (const card of list) {
			if (!(await exists(highFile(card)))) {
				continue;
			}

			const src = `/cache/${relative(CACHE, highFile(card))}`;
			const out = await page.evaluate(([s, seed, p, full]) => window.fp.degraded(s, seed, p, {full}), [src, card.id, passes, card.full]);

			for (const pass of passes) {
				evaluate(out[pass], card.truth, {full: card.full, id: card.id, pass, set: name, tag: card.tag});
			}
		}
	}

	if (args.bench) {
		const dataset = JSON.parse(await readFile(resolve(String(args.bench)), 'utf8'));
		const lists = {en: await cachedJson(CACHE, 'en/cards', 'cards-en.json'), pt: await cachedJson(CACHE, 'pt/cards', 'cards-pt.json')};
		const items = dataset.map((d) => ({...d, catalog: d.lang, image: lists[d.lang].find((c) => c.id === d.id).image}));

		console.log(`bench: ${items.length} cards, ${await downloadHigh(items)} high images fetched`);

		for (const item of items) {
			const src = `/cache/${relative(CACHE, highFile(item))}`;
			const benchPasses = ['clean', 'blur', 'glare', 'tilt', 'jpeg', 'nonumber'];
			const out = await page.evaluate(([s, id, p]) => window.fp.bench(s, id, p), [src, item.id, benchPasses]);
			const truth = keyIndex.has(`${item.lang}:${item.id}`) ? `${item.lang}:${item.id}` : `en:${item.id}`;

			for (const pass of benchPasses) {
				evaluate(out[pass].data, truth, {found: out[pass].found, group: `${item.group}-${item.lang}`, id: item.id, pass, set: 'bench', tag: item.group});
			}
		}
	}

	if (args.photo) {
		const [x, y, w, h] = String(args.box).split(',').map(Number);
		const out = await page.evaluate((box) => window.fp.photo('/photo', box), {h, w, x, y});

		console.log(`photo: ${out.note} ${out.card}`);
		evaluate(out.data, `en:${args.truth}`, {id: args.truth, pass: 'photo', set: 'photo', tag: 'photo'});
	}

	if (args.timing) {
		const cdp = await context.newCDPSession(page);
		const loaded = await page.evaluate((u) => window.fp.loadIndex(u), '/pokemon-card-tracker/lab/fingerprints/index.bin');
		const sample = sets.framed.slice(0, 6).concat(sets.fullart.slice(0, 6));

		await downloadHigh(sample);
		console.log(`index: ${loaded.count} cards, loaded and unpacked in ${loaded.ms} ms`);

		for (const rate of [1, Number(args.throttle || 4)]) {
			await cdp.send('Emulation.setCPUThrottlingRate', {rate});

			const times = [];

			for (const card of sample) {
				const r = await page.evaluate(([s, id]) => window.fp.time(s, id, {runs: 6}), [`/cache/${relative(CACHE, highFile(card))}`, card.id]);

				times.push(...r.times.slice(1));
			}

			const med = (k) => {
				const v = times.map((x) => x[k]).sort((a, b) => a - b);

				return `median ${v[Math.floor(v.length / 2)].toFixed(1)} ms, p90 ${v[Math.ceil(v.length * 0.9) - 1].toFixed(1)} ms`;
			};

			console.log(`CPU x${rate}: rectify ${med('rectify')}; fingerprint ${med('fingerprint')}; match ${med('match')}; total ${med('total')}`);
		}

		await cdp.send('Emulation.setCPUThrottlingRate', {rate: 1});
	}

	await browser.close();
	await server.close();

	const out = resolve(String(args.out || join(CACHE, 'measure.json')));

	await writeFile(out, JSON.stringify(rows));
	report(rows);
	console.log(`\nRows: ${out}`);
}

export function report(rows, {formulas = [...Object.keys(FORMULAS), 'no shifts']} = {}) {
	const top = (r, f, k) => r[f].group <= k;

	console.log('\n## By descriptor, all degraded queries (art group first / top 5; exact card first)\n');
	console.log('| Descriptor | Framed | Full art | Japanese | Portuguese on English image | All: group first | All: top 5 | All: exact card first |');
	console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');

	const deg = rows.filter((r) => !['bench', 'photo'].includes(r.set));

	for (const f of formulas) {
		const cell = (list) => pct(list.filter((r) => top(r, f, 1)).length, list.length);

		console.log(`| ${f} | ${cell(deg.filter((r) => r.set === 'framed'))} | ${cell(deg.filter((r) => r.set === 'fullart'))} | ${cell(deg.filter((r) => r.set === 'ja'))} | ${cell(deg.filter((r) => r.set === 'pt'))} | ${cell(deg)} | ${pct(deg.filter((r) => top(r, f, 5)).length, deg.length)} | ${pct(deg.filter((r) => r[f].strict === 1).length, deg.length)} |`);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	await main();
}
