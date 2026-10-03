// Finds a straightened card in the packed fingerprint index (pack.js):
// fingerprint the crop a few times (fingerprint.js QUERY_SHIFTS, for edges
// found slightly off), then a linear scan of every card.
//
// The score of a card is a weighted sum of three distances, each the best
// over the query's shifts: the art-box hash's Hamming distance, the whole
// card's Hamming distance, and the colour layout's distance. Full-art cards
// use their own weights (header.weights.full), which lean on the whole
// card. The scan runs in two steps: the two hashes for every card (a few
// popcounts each), then the colour layout for the best few hundred only.
//
// Results come back as artwork groups: cards whose art box is the same
// picture (reprints, the Japanese print of an international card, a
// Portuguese card and its English image) cannot be told apart by picture,
// so the group is the answer and its members are what text, or the person,
// chooses between.

import {COLOR_BYTES, colorDistance, popcount32, queryFingerprints} from './fingerprint.js';
import {unpackIndex} from './pack.js';

export async function loadIndex(url, {fetchImpl = fetch} = {}) {
	const response = await fetchImpl(url);

	if (!response.ok) {
		throw new Error(`Fingerprint index ${response.status}`);
	}

	return unpackIndex(new Uint8Array(await response.arrayBuffer()));
}

// Minimum Hamming distance from each of the index's `words`-word hashes in
// `table` to any of the query hashes, into `out` (Uint16Array).
function hammingAll(table, words, queries, out) {
	const n = out.length;
	const q = queries.length;

	if (words === 2) {
		const qa = Uint32Array.from(queries, (h) => h[0]);
		const qb = Uint32Array.from(queries, (h) => h[1]);

		for (let i = 0; i < n; i++) {
			const a = table[i * 2];
			const b = table[i * 2 + 1];
			let best = 64;

			for (let s = 0; s < q; s++) {
				const d = popcount32(a ^ qa[s]) + popcount32(b ^ qb[s]);

				if (d < best) {
					best = d;
				}
			}

			out[i] = best;
		}

		return out;
	}

	for (let i = 0; i < n; i++) {
		let best = 1 << 15;

		for (let s = 0; s < q; s++) {
			let d = 0;

			for (let w = 0; w < words; w++) {
				d += popcount32(table[i * words + w] ^ queries[s][w]);
			}

			if (d < best) {
				best = d;
			}
		}

		out[i] = best;
	}

	return out;
}

const scratch = new Map();

function buffers(n) {
	if (!scratch.has(n)) {
		scratch.set(n, {art: new Uint16Array(n), card: new Uint16Array(n), coarse: new Float32Array(n)});
	}

	return scratch.get(n);
}

// Match query fingerprints (from queryFingerprints) against the index.
// Returns {groups, timings}: up to `top` artwork groups, best first, each
// {score, cards: [{id, catalog, set, full, score, art, card, color}]}.
export function matchFingerprints(index, queries, {prefilter = 400, top = 5} = {}) {
	const t0 = performance.now();
	const n = index.count;
	const {fields, flags, header} = index;
	const W = header.weights;
	const buf = buffers(n);
	const hasCard = Boolean(fields.card);

	hammingAll(fields.art, header.fields.art.bytes / 4, queries.map((f) => f.art), buf.art);

	if (hasCard) {
		hammingAll(fields.card, header.fields.card.bytes / 4, queries.map((f) => f.card), buf.card);
	}

	// Coarse score from the hashes alone, then the best `prefilter` cards.
	const coarse = buf.coarse;

	for (let i = 0; i < n; i++) {
		const w = flags[i] & 1 ? W.full : W.framed;

		coarse[i] = w.art * buf.art[i] + (hasCard ? w.card * buf.card[i] : 0);
	}

	const pool = selectSmallest(coarse, prefilter);
	const scored = [];
	const color = fields.color;

	for (const i of pool) {
		const w = flags[i] & 1 ? W.full : W.framed;
		let c = Infinity;

		if (color && w.color) {
			const entry = color.subarray(i * COLOR_BYTES, (i + 1) * COLOR_BYTES);

			for (const q of queries) {
				c = Math.min(c, colorDistance(entry, q.color));
			}
		}
		else {
			c = 0;
		}

		scored.push({art: buf.art[i], card: hasCard ? buf.card[i] : null, color: Math.round(c), i, score: coarse[i] + (w.color || 0) * c});
	}

	scored.sort((a, b) => a.score - b.score);

	const groups = new Map();

	for (const s of scored) {
		const g = index.group[s.i];

		if (!groups.has(g)) {
			if (groups.size >= top) {
				continue;
			}

			groups.set(g, {cards: [], group: g, score: s.score});
		}

		groups.get(g).cards.push({...index.card(s.i), art: s.art, card: s.card, color: s.color, score: Math.round(s.score * 10) / 10});
	}

	return {groups: [...groups.values()], timings: {match: performance.now() - t0}};
}

// Indexes of the k smallest values (unordered), by a threshold found on a
// histogram: one pass to count, one to collect.
function selectSmallest(values, k) {
	const n = values.length;

	if (n <= k) {
		return Array.from({length: n}, (_, i) => i);
	}

	let max = 0;

	for (let i = 0; i < n; i++) {
		if (values[i] > max) {
			max = values[i];
		}
	}

	const bins = 1024;
	const hist = new Uint32Array(bins + 1);
	const scale = bins / (max || 1);

	for (let i = 0; i < n; i++) {
		hist[Math.floor(values[i] * scale)]++;
	}

	let cut = 0;
	let count = 0;

	while (cut <= bins && count + hist[cut] < k) {
		count += hist[cut];
		cut++;
	}

	const out = [];

	for (let i = 0; i < n; i++) {
		if (Math.floor(values[i] * scale) <= cut) {
			out.push(i);
		}
	}

	return out;
}

// A straightened card (ImageData-shaped) against the index.
export function match(index, img, options = {}) {
	const t0 = performance.now();
	const bits = {artBits: index.header.fields.art.bytes * 8, cardBits: index.header.fields.card ? index.header.fields.card.bytes * 8 : 64};
	const queries = queryFingerprints(img, bits);
	const t1 = performance.now();
	const result = matchFingerprints(index, queries, options);

	result.timings.fingerprint = t1 - t0;

	return result;
}

// How sure the first group is: the gap between its score and the second's,
// and whether its cards could still differ by text (more than one card).
export function verdict(result, {autoGap = 6} = {}) {
	const [a, b] = result.groups;

	if (!a) {
		return {sure: false, why: 'Nothing matched.'};
	}

	const gap = b ? b.score - a.score : Infinity;

	return {gap, needsText: a.cards.length > 1, sure: gap >= autoGap};
}
