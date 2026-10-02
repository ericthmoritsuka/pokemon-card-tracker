// International twins for Asian prints: the English print with the same
// artwork as a Japanese card (DESIGN.md section 5, "International twins for
// Asian prints: measured 2026-10-01").
//
// A confident twin lends its image, labelled "International print", and for
// Trainers and Energy its English name. An ambiguous result offers two or
// three candidates to pick from on card detail (js/twins-view.js). A weak
// result shows nothing. A card with no twin, or only a weak one, is checked
// again at most once a week, so a Japanese set that has no English
// counterpart yet (M6, 2026-10-01) fills in once one appears.
//
// The rule is a port of the research matcher (/tmp/twins/match2.py, run on
// 2026-10-01): Pokémon must agree on dexId, HP, the number of attacks and
// each attack's energy cost and damage, inside a release window of 60 days
// before to 450 days after the Japanese set. Illustrator, Trainer type,
// effect-text numbers, energy symbols and keywords, rarity, the expected
// English set, and main-set versus secret-rare numbering then score the
// candidates. English candidates come only from the swsh, sv, and me series,
// since TCG Pocket sets share names and illustrators.
//
// Only Japanese prints are matched: the keyword pairs are Japanese, and the
// measurement covered Japanese sets alone. Korean and Chinese records return
// "none" until they are measured.
//
// No DOM here, so Node tests the matcher (tests/twins.test.mjs). The data
// layer keeps everything on the device in its own IndexedDB database, apart
// from js/catalog.js's: the English card data per set, each card's result,
// and each person's decisions, which exportDecisions() hands out so a later
// change can sync them.

import {cardImage, importApi} from './catalog.js';

export const SERIES = ['swsh', 'sv', 'me'];

// Days from the Japanese set's release to the English set's.
export const WINDOW = {after: 450, before: 60};

export const RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

export const LABEL = 'International print';

// A result saved by another version of the rule is computed again.
export const MATCHER_VERSION = 1;

const GRAPHQL = 'https://api.tcgdex.net/v2/graphql';

// ------------------------------------------------------------ the rule

// Japanese rarity to the English rarities its confident twins carried,
// learned by the research from the confident Pokémon matches whose
// illustrators agreed exactly, across seven Japanese sets (rarmap.json).
// The first entry with the highest count is the expected English rarity.
export const RARITY_MAP = {
	Common: {Common: 216, Uncommon: 12},
	'Double rare': {'Double rare': 38, 'Holo Rare V': 2},
	Uncommon: {Uncommon: 138, Rare: 22, Common: 1},
	Rare: {Rare: 32, 'Holo Rare': 10},
	'Illustration rare': {'Illustration rare': 55},
	'Ultra Rare': {'Ultra Rare': 81},
	'Special illustration rare': {'Special illustration rare': 28},
	'Mega Hyper Rare': {'Mega Hyper Rare': 3, 'Secret Rare': 3, 'Hyper rare': 2},
	'Triple Rare': {'Holo Rare VMAX': 1, 'Holo Rare VSTAR': 3},
	'Holo Rare': {'Secret Rare': 8},
	'ACE SPEC Rare': {'ACE SPEC Rare': 3},
};

// Python's \b is Unicode aware; JavaScript's sees only ASCII letters, so
// "Pokémon V\b" would differ after an accented letter. This is Python's.
const WORD = '[\\p{L}\\p{N}_]';
const BOUNDARY = `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;
const english = (source) => new RegExp(source.replaceAll('\\b', BOUNDARY), 'u');

// Keyword pairs: a Japanese term and the English words for the same idea in
// effect text. The research's list, in its order.
const CONCEPTS = [
	['ポケモンex', 'Pokémon ex'],
	['たね', '\\bBasic Pokémon'],
	['進化', '[Ee]volv|Evolution'],
	['サポート', 'Supporter'],
	['グッズ', '\\bItem'],
	['スタジアム', 'Stadium'],
	['どうぐ', 'Pokémon Tool'],
	['山札', '\\bdeck'],
	['手札', '\\bhand'],
	['トラッシュ', 'discard'],
	['ベンチ', 'Bench'],
	['バトルポケモン|バトル場', 'Active'],
	['サイド', 'Prize'],
	['コイン', 'coin'],
	['回復', '\\bheal'],
	['ダメカン', 'damage counter'],
	['特殊状態', 'Special Condition'],
	['エネルギー', 'Energy'],
	['入れ替', 'switch'],
	['引く', '\\bdraw'],
	['ロストゾーン', 'Lost Zone'],
	['にげる', '[Rr]etreat'],
	['HP', '\\bHP\\b'],
	['ダメージ', 'damage'],
	['相手', 'opponent'],
	['見せ', 'reveal'],
	['切る', 'shuffle'],
	['2進化', 'Stage 2'],
	['1進化', 'Stage 1'],
	['ワザ', 'attack'],
	['特性', 'Abilit'],
	['きぜつ', 'Knocked Out'],
	['どく', 'Poison'],
	['マヒ', 'Paralyz'],
	['ねむり', 'Asleep'],
	['やけど', 'Burn'],
	['こんらん', 'Confus'],
	['ロケット団', 'Team Rocket'],
	['テラスタル', 'Tera'],
	['VSTAR', 'VSTAR'],
	['ポケモンV', 'Pokémon V\\b'],
	['ACE SPEC', 'ACE SPEC'],
	['メガシンカ', 'Mega Evolution'],
].map(([ja, en]) => ({en: english(en), ja: new RegExp(ja, 'u')}));

// Illustrator names compared without accents, case, spaces, or punctuation.
// A name in kana or kanji becomes empty, and an empty name never matches.
export function normIllustrator(name) {
	return String(name || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Python's difflib.SequenceMatcher(None, a, b).ratio(), for strings shorter
// than 200 characters (where its automatic junk rule does not apply).
export function sequenceRatio(a, b) {
	const total = a.length + b.length;

	if (!total) {
		return 1;
	}

	const b2j = new Map();

	[...b].forEach((char, j) => {
		if (!b2j.has(char)) {
			b2j.set(char, []);
		}

		b2j.get(char).push(j);
	});

	const longest = (alo, ahi, blo, bhi) => {
		let besti = alo;
		let bestj = blo;
		let bestSize = 0;
		let j2len = new Map();

		for (let i = alo; i < ahi; i++) {
			const next = new Map();

			for (const j of b2j.get(a[i]) || []) {
				if (j < blo) {
					continue;
				}

				if (j >= bhi) {
					break;
				}

				const k = (j2len.get(j - 1) || 0) + 1;

				next.set(j, k);

				if (k > bestSize) {
					besti = i - k + 1;
					bestj = j - k + 1;
					bestSize = k;
				}
			}

			j2len = next;
		}

		return [besti, bestj, bestSize];
	};

	let matches = 0;
	const queue = [[0, a.length, 0, b.length]];

	while (queue.length) {
		const [alo, ahi, blo, bhi] = queue.pop();
		const [i, j, k] = longest(alo, ahi, blo, bhi);

		if (k) {
			matches += k;

			if (alo < i && blo < j) {
				queue.push([alo, i, blo, j]);
			}

			if (i + k < ahi && j + k < bhi) {
				queue.push([i + k, ahi, j + k, bhi]);
			}
		}
	}

	return (2 * matches) / total;
}

export function illustratorScore(a, b) {
	const x = normIllustrator(a);
	const y = normIllustrator(b);

	if (!x || !y) {
		return 0;
	}

	if (x === y) {
		return 3;
	}

	return sequenceRatio(x, y) >= 0.85 ? 2 : 0;
}

const damageKey = (value) => (value === null || value === undefined || value === ''
	? ''
	: String(value).normalize('NFKC').replaceAll('×', 'x').replaceAll(' ', '').toLowerCase());

const costKey = (attack) => [...((attack && attack.cost) || [])].sort().join('\u0000');

// Same number of attacks, the same energy cost for each, and the same damage
// where both print one.
export function attacksAgree(asian, candidate) {
	const a = asian.attacks || [];
	const b = candidate.attacks || [];

	if (a.length !== b.length) {
		return false;
	}

	return a.every((attack, i) => {
		if (costKey(attack) !== costKey(b[i])) {
			return false;
		}

		const x = damageKey(attack.damage);
		const y = damageKey(b[i].damage);

		return !x || !y || x === y;
	});
}

// The numbers in an effect text, leaving out 1 ("1 card" reads differently
// in each language).
export function effectDigits(text) {
	return new Set((String(text || '').normalize('NFKC').match(/\p{Nd}+/gu) || []).filter((digits) => digits !== '1'));
}

// Energy symbols: Japanese text writes [G], English text {G}.
export function effectSymbols(text, lang) {
	const pattern = lang === 'ja' ? /\[([A-Z])\]/g : /\{([A-Z])\}/g;

	return new Set([...String(text || '').matchAll(pattern)].map((found) => found[1]));
}

export function effectConcepts(text, lang) {
	const value = String(text || '');
	const out = new Set();

	CONCEPTS.forEach((concept, i) => {
		if ((lang === 'ja' ? concept.ja : concept.en).test(value)) {
			out.add(i);
		}
	});

	return out;
}

const sameSet = (a, b) => a.size === b.size && [...a].every((item) => b.has(item));

// 3 times the Jaccard index, rounded to two places half to even, as
// Python's round(3 * jacc, 2) does for these exact fractions.
function conceptScore(a, b) {
	const union = new Set([...a, ...b]).size;

	if (!union) {
		return 3;
	}

	const shared = [...a].filter((item) => b.has(item)).length;
	const numerator = 300 * shared;
	let hundredths = Math.floor(numerator / union);
	const rest = numerator - hundredths * union;

	if (2 * rest > union || (2 * rest === union && hundredths % 2 === 1)) {
		hundredths++;
	}

	return hundredths / 100;
}

// Days since 1970 for an ISO date, or null.
const dayNumber = (value) => {
	const found = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));

	return found ? Date.UTC(Number(found[1]), Number(found[2]) - 1, Number(found[3])) / 86400000 : null;
};

const plainNumber = (localId) => (/^\d+$/.test(String(localId || '')) ? Number(localId) : null);

// A number past the set's official count, or none at all, is a secret rare
// or a promo. English sets with no official count (promos) count as secret.
function englishSecret(card) {
	const n = plainNumber(card.localId);

	return n === null || !card.official || n > card.official;
}

function asianSecret(card) {
	const n = plainNumber(card.localId);
	const official = (card.set && card.set.cardCount && card.set.cardCount.official) || 0;

	return n === null || n > official;
}

const sortedDex = (card) => [...(card.dexId || [])].sort((a, b) => a - b);

const nullable = (value) => (value === undefined ? null : value);

// English cards as the matcher reads them: each carries setId, setDate,
// official (its set's official count), and the fields of ENGLISH_FIELDS.
// Returns an index of them by dex number and by category, in list order.
export function englishIndex(cards) {
	const byDex = new Map();
	const byCategory = new Map();

	for (const card of cards) {
		const prepared = {
			...card,
			_concepts: effectConcepts(card.effect, 'en'),
			_day: dayNumber(card.setDate),
			_digits: effectDigits(card.effect),
			_symbols: effectSymbols(card.effect, 'en'),
		};

		if (card.category === 'Pokemon') {
			for (const n of card.dexId || []) {
				if (!byDex.has(n)) {
					byDex.set(n, []);
				}

				byDex.get(n).push(prepared);
			}
		}
		else {
			if (!byCategory.has(card.category)) {
				byCategory.set(card.category, []);
			}

			byCategory.get(card.category).push(prepared);
		}
	}

	return {byCategory, byDex};
}

function inWindow(card, day) {
	if (card._day === null) {
		return false;
	}

	const gap = card._day - day;

	return gap >= -WINDOW.before && gap <= WINDOW.after;
}

function pool(asian, day, index) {
	if (asian.category === 'Pokemon') {
		const dex = sortedDex(asian);
		const seen = new Set();
		const out = [];

		for (const n of dex) {
			for (const card of index.byDex.get(n) || []) {
				if (!seen.has(card)) {
					seen.add(card);
					out.push(card);
				}
			}
		}

		const dexKey = dex.join(',');

		return out.filter((card) => sortedDex(card).join(',') === dexKey
			&& inWindow(card, day)
			&& nullable(card.hp) === nullable(asian.hp)
			&& attacksAgree(asian, card));
	}

	return (index.byCategory.get(asian.category) || []).filter((card) => inWindow(card, day));
}

function rarityScore(asian, candidate, rarityMap) {
	const counts = Object.hasOwn(rarityMap, asian.rarity) ? rarityMap[asian.rarity] : {};
	const known = Object.keys(counts);

	if (known.length) {
		const expected = known.reduce((best, key) => (counts[key] > counts[best] ? key : best), known[0]);

		if (nullable(candidate.rarity) === expected) {
			return 1.5;
		}
	}
	else if (nullable(candidate.rarity) === nullable(asian.rarity)) {
		return 1.5;
	}

	return Object.hasOwn(counts, candidate.rarity) && counts[candidate.rarity] ? 0.5 : 0;
}

// The research's score parts, in its order (the sum is taken in this order).
export function scoreParts(asian, candidate, context = {}) {
	const parts = {ill: illustratorScore(asian.illustrator, candidate.illustrator)};

	if (asian.category !== 'Pokemon') {
		parts.tt = asian.category === 'Energy' || nullable(asian.trainerType) === nullable(candidate.trainerType) ? 2 : 0;
		parts.dig = sameSet(effectDigits(asian.effect), candidate._digits) ? 2 : 0;
		parts.sym = sameSet(effectSymbols(asian.effect, 'ja'), candidate._symbols) ? 1 : 0;
		parts.con = conceptScore(effectConcepts(asian.effect, 'ja'), candidate._concepts);
	}

	parts.rar = rarityScore(asian, candidate, context.rarityMap || {});
	parts.set = (context.aligned || []).includes(candidate.setId) ? 1 : 0;
	parts.sec = asianSecret(asian) === englishSecret(candidate) ? 1.5 : 0;

	return parts;
}

// Two English prints of one artwork: a reprint in another set with the same
// illustrator, name, and rarity.
export const sameArt = (a, b) => a.setId !== b.setId
	&& normIllustrator(a.illustrator) === normIllustrator(b.illustrator)
	&& a.name === b.name
	&& nullable(a.rarity) === nullable(b.rarity);

// The research's verdict for one Japanese card: {verdict, top, ranked},
// verdict one of "one", "one-lowconf", "several", "weak", "none"; ranked is
// [{score, parts, card}], best first, earliest set first among equals.
// day is the Japanese set's release as dayNumber(), or an ISO date.
export function matchCard(asian, day, index, context = {}) {
	const jd = typeof day === 'number' ? day : dayNumber(day);

	if (jd === null) {
		return {ranked: [], top: null, verdict: 'none'};
	}

	const ranked = pool(asian, jd, index).map((card) => {
		const parts = scoreParts(asian, card, context);

		return {card, parts, score: Object.values(parts).reduce((sum, value) => sum + value, 0)};
	});

	ranked.sort((a, b) => b.score - a.score || a.card._day - b.card._day);

	if (!ranked.length) {
		return {ranked, top: null, verdict: 'none'};
	}

	const [top] = ranked;
	const tied = ranked.filter((row) => Math.abs(row.score - top.score) < 1e-9);

	if (tied.length > 1 && !tied.every((row) => row === top || sameArt(top.card, row.card))) {
		return {ranked, top, verdict: 'several'};
	}

	const parts = top.parts;
	const rival = ranked.find((row) => row !== top && !sameArt(top.card, row.card));
	const margin = top.score - (rival ? rival.score : -99);
	let ok;

	if (asian.category === 'Pokemon') {
		ok = parts.ill >= 2;
	}
	else if (asian.category === 'Energy' && !normIllustrator(asian.illustrator) && !normIllustrator(top.card.illustrator)) {
		ok = parts.sym > 0 && parts.dig > 0 && parts.con >= 2 && parts.set > 0;
	}
	else {
		ok = parts.ill >= 2 && parts.tt > 0 && parts.dig > 0 && parts.con >= 1.5;
	}

	if (ok && margin >= 1) {
		return {ranked, top, verdict: 'one'};
	}

	if (parts.ill === 0 && asian.category === 'Pokemon' && margin >= 1 && parts.sec > 0 && parts.rar >= 1.5) {
		return {ranked, top, verdict: 'one-lowconf'};
	}

	return {ranked, top, verdict: 'weak'};
}

// The English sets a Japanese set's cards land in: each set that holds at
// least 15 percent of the confident Pokémon matches among sample, matched
// with no context. The research used the whole set; a sample of a dozen
// Pokémon gave the same results on all six measured sets.
export function alignedSets(sample, day, index) {
	const counts = new Map();

	for (const asian of sample) {
		if (asian.category !== 'Pokemon') {
			continue;
		}

		const {top, verdict} = matchCard(asian, day, index, {});

		if (verdict === 'one') {
			counts.set(top.card.setId, (counts.get(top.card.setId) || 0) + 1);
		}
	}

	const total = [...counts.values()].reduce((sum, n) => sum + n, 0);

	return [...counts].filter(([, n]) => total && n / total >= 0.15).map(([id]) => id).sort();
}

// What the app shows for each verdict. A pick whose illustrator did not
// match ("one-lowconf") goes to the person to confirm rather than showing.
const STATUS = {none: 'none', one: 'confident', 'one-lowconf': 'ambiguous', several: 'ambiguous', weak: 'weak'};

const candidateOf = ({card, score}) => ({
	category: card.category,
	id: card.id,
	illustrator: nullable(card.illustrator),
	image: nullable(card.image),
	localId: card.localId,
	name: card.name,
	rarity: nullable(card.rarity),
	score: Math.round(score * 100) / 100,
	setId: card.setId,
	setName: nullable(card.setName),
});

// {status, candidates} from a verdict. Confident: the twin alone. Ambiguous:
// up to three distinct artworks, best first (a reprint of an artwork already
// listed is left out). Weak: the best guess, for the record; callers show
// nothing. None: no candidates.
export function resultOf({ranked, verdict}) {
	const status = STATUS[verdict];

	if (status === 'none') {
		return {candidates: [], status};
	}

	if (status !== 'ambiguous') {
		return {candidates: [candidateOf(ranked[0])], status};
	}

	const picked = [];

	for (const row of ranked) {
		if (picked.length === 3) {
			break;
		}

		if (!picked.some((other) => other === row || sameArt(other.card, row.card))) {
			picked.push(row);
		}
	}

	return {candidates: picked.map(candidateOf), status};
}

// ------------------------------------------------------------- storage

const DB_NAME = 'card-tracker-twins';
const STORES = ['english', 'results', 'decisions'];

// The device's IndexedDB: english (the set list, each set's cards, and each
// Japanese set's aligned English sets), results (one per Asian card), and
// decisions (one per Asian card the person answered).
export function idbStore() {
	let dbPromise = null;

	const open = () => {
		if (!dbPromise) {
			dbPromise = new Promise((resolve, reject) => {
				const request = indexedDB.open(DB_NAME, 1);

				request.onupgradeneeded = () => {
					for (const name of STORES) {
						if (!request.result.objectStoreNames.contains(name)) {
							request.result.createObjectStore(name);
						}
					}
				};
				request.onsuccess = () => resolve(request.result);
				request.onerror = () => reject(request.error);
			}).catch((err) => {
				dbPromise = null;

				throw err;
			});
		}

		return dbPromise;
	};

	const run = async (name, mode, op) => {
		const db = await open();

		return new Promise((resolve, reject) => {
			const tx = db.transaction(name, mode);
			const request = op(tx.objectStore(name));

			tx.oncomplete = () => resolve(request && request.result);
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error);
		});
	};

	return {
		async all(name) {
			try {
				const db = await open();

				return await new Promise((resolve, reject) => {
					const out = [];
					const tx = db.transaction(name, 'readonly');
					const request = tx.objectStore(name).openCursor();

					request.onsuccess = () => {
						const cursor = request.result;

						if (cursor) {
							out.push([cursor.key, cursor.value]);
							cursor.continue();
						}
					};
					tx.oncomplete = () => resolve(out);
					tx.onerror = () => reject(tx.error);
				});
			}
			catch {
				return [];
			}
		},
		async get(name, key) {
			try {
				return await run(name, 'readonly', (store) => store.get(key));
			}
			catch {
				return undefined;
			}
		},
		async put(name, key, value) {
			try {
				await run(name, 'readwrite', (store) => store.put(value, key));
			}
			catch {
				// Not kept; the next check works it out again.
			}
		},
	};
}

// The same interface in memory, for tests and for a browser without
// IndexedDB.
export function memoryStore() {
	const stores = new Map(STORES.map((name) => [name, new Map()]));
	const copy = (value) => (value === undefined ? undefined : structuredClone(value));

	return {
		all: async (name) => [...stores.get(name)].map(([key, value]) => [key, copy(value)]),
		get: async (name, key) => copy(stores.get(name).get(key)),
		put: async (name, key, value) => {
			stores.get(name).set(key, copy(value));
		},
	};
}

// --------------------------------------------------------------- fetching

// The English card fields the matcher and the caller read.
export const ENGLISH_FIELDS = 'id localId name category effect dexId illustrator hp rarity trainerType image attacks { cost damage }';

// English sets per GraphQL request: each is one aliased cards() query.
const SETS_PER_REQUEST = 6;

// Retries a 503 (and 429, 502, 504) or a dropped connection after 1, 3, 8,
// then 16 seconds: TCGdex answered 503 now and then on 2026-10-01.
const BACKOFF_MS = [1000, 3000, 8000, 16000];
const RETRY = new Set([429, 502, 503, 504]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// At most `size` calls of run() in flight at once.
export function limiter(size) {
	let active = 0;
	const waiting = [];

	const next = () => {
		if (active >= size || !waiting.length) {
			return;
		}

		active++;

		const {resolve, reject, task} = waiting.shift();

		Promise.resolve().then(task).then(resolve, reject).finally(() => {
			active--;
			next();
		});
	};

	return (task) => new Promise((resolve, reject) => {
		waiting.push({reject, resolve, task});
		next();
	});
}

const keyOf = (catalog, cardId) => `${catalog}|${cardId}`;

// "<catalog>|<card id>" for a card entry ({catalog, card_id}), a card index
// record ({catalog, id}), a TCGdex record (which carries no catalog, so pass
// it: catalogFor(lang)), or a card ID with the catalog passed.
export function twinKey(item, catalog = null) {
	if (!item) {
		return null;
	}

	if (typeof item === 'string') {
		return item.includes('|') ? item : catalog ? keyOf(catalog, item) : null;
	}

	const cardId = item.card_id || item.id;
	const from = item.catalog || catalog;

	return cardId && from ? keyOf(from, cardId) : null;
}

// One twins instance: the data layer over a store, with the network calls
// injectable for tests. The module's own functions below use a default
// instance over IndexedDB and fetch.
//
//   fetch     window.fetch
//   ja        {setDetail(id), cardDetail(id)}: Japanese TCGdex records
//             (js/catalog.js importApi, cache first, by default)
//   store     idbStore() or memoryStore()
//   now, wait the clock and the retry delay
//   online    whether the device has a connection (navigator.onLine)
export function createTwins({
	concurrency = 4,
	fetch: fetchFn = (...args) => globalThis.fetch(...args),
	ja = {cardDetail: (id) => importApi.cardDetail('ja', id), setDetail: (id) => importApi.setDetail('ja', id)},
	now = () => Date.now(),
	online = () => !globalThis.navigator || globalThis.navigator.onLine !== false,
	store = idbStore(),
	wait = sleep,
} = {}) {
	const limit = limiter(concurrency);
	const listeners = new Set();
	const memory = {decisions: new Map(), loaded: null, results: new Map()};
	const setCards = new Map();
	let setList = null;
	let indexCache = null;
	let refreshing = Promise.resolve();

	const changed = (key) => {
		for (const listener of listeners) {
			try {
				listener(key);
			}
			catch {
				// One listener's error does not stop the others.
			}
		}
	};

	async function graphql(query) {
		return limit(async () => {
			for (let attempt = 0; ; attempt++) {
				let response;

				try {
					response = await fetchFn(GRAPHQL, {
						body: JSON.stringify({query}),
						headers: {'Content-Type': 'application/json'},
						method: 'POST',
					});
				}
				catch (err) {
					if (attempt < BACKOFF_MS.length) {
						await wait(BACKOFF_MS[attempt]);

						continue;
					}

					// No connection: refreshTwins stops there rather than
					// waiting out the retries again for every card.
					err.network = true;

					throw err;
				}

				if (RETRY.has(response.status) && attempt < BACKOFF_MS.length) {
					await wait(BACKOFF_MS[attempt]);

					continue;
				}

				if (!response.ok) {
					const err = new Error(`TCGdex answered ${response.status} for a GraphQL query.`);

					err.status = response.status;
					err.network = RETRY.has(response.status);

					throw err;
				}

				const body = await response.json();

				if (body.errors && body.errors.length && !body.data) {
					throw new Error(`TCGdex GraphQL: ${body.errors[0].message}`);
				}

				return body.data || {};
			}
		});
	}

	// Every English set in SERIES with its release date and counts, in the
	// API's order: one request, kept a week.
	async function englishSets({fresh = false} = {}) {
		if (setList && !fresh && now() - setList.at < RECHECK_MS) {
			return setList.sets;
		}

		const saved = await store.get('english', 'sets');

		if (saved && !fresh && now() - saved.at < RECHECK_MS) {
			setList = saved;

			return saved.sets;
		}

		try {
			const data = await graphql('{ sets { id name releaseDate serie { id } cardCount { official total } } }');
			const sets = (data.sets || [])
				.filter((set) => set && set.serie && SERIES.includes(set.serie.id))
				.map((set) => ({
					id: set.id,
					name: set.name,
					official: (set.cardCount && set.cardCount.official) || 0,
					releaseDate: set.releaseDate || null,
					serie: set.serie.id,
					total: (set.cardCount && set.cardCount.total) || 0,
				}));

			setList = {at: now(), sets};
			await store.put('english', 'sets', setList);
			indexCache = null;

			return sets;
		}
		catch (err) {
			if (saved) {
				setList = saved;

				return saved.sets;
			}

			throw err;
		}
	}

	// A set's saved cards are current while their count matches the set
	// list's total, and are used anyway for a week after they were fetched
	// (TCGdex fills in a new set over a few weeks).
	const usable = (saved, set) => saved && (saved.count === set.total || now() - saved.at < RECHECK_MS);

	// The cards of these English sets, from the device when usable, otherwise
	// fetched, six sets to a request.
	async function loadSets(sets) {
		const missing = [];

		for (const set of sets) {
			if (usable(setCards.get(set.id), set)) {
				continue;
			}

			const saved = await store.get('english', `cards:${set.id}`);

			if (usable(saved, set)) {
				setCards.set(set.id, saved);
			}
			else {
				missing.push(set);
			}
		}

		if (!missing.length) {
			return;
		}

		const chunks = [];

		for (let i = 0; i < missing.length; i += SETS_PER_REQUEST) {
			chunks.push(missing.slice(i, i + SETS_PER_REQUEST));
		}

		await Promise.all(chunks.map(async (chunk) => {
			const query = `{ ${chunk.map((set, i) => `s${i}: cards(filters: {id: ${JSON.stringify(`${set.id}-`)}}, pagination: {page: 1, itemsPerPage: 1000}) { ${ENGLISH_FIELDS} }`).join(' ')} }`;
			const data = await graphql(query);

			await Promise.all(chunk.map(async (set, i) => {
				// The id filter matches a substring: "30th-" also finds 30th-c.
				const cards = (data[`s${i}`] || []).filter((card) => card && card.id.slice(0, card.id.lastIndexOf('-')) === set.id);
				const saved = {at: now(), cards, count: cards.length};

				setCards.set(set.id, saved);
				await store.put('english', `cards:${set.id}`, saved);
			}));
		}));

		indexCache = null;
	}

	// The matcher's index over the English sets inside a Japanese set's window.
	async function indexFor(day) {
		const sets = (await englishSets()).filter((set) => {
			const d = dayNumber(set.releaseDate);

			return d !== null && d - day >= -WINDOW.before && d - day <= WINDOW.after;
		});

		await loadSets(sets);

		const ids = sets.map((set) => set.id).join(',');

		if (indexCache && indexCache.ids === ids) {
			return indexCache.index;
		}

		const cards = [];

		for (const set of sets) {
			for (const card of (setCards.get(set.id) || {cards: []}).cards) {
				cards.push({...card, official: set.official, setDate: set.releaseDate, setId: set.id, setName: set.name});
			}
		}

		indexCache = {ids, index: englishIndex(cards)};

		return indexCache.index;
	}

	async function releaseDay(record, given) {
		const date = given || (record.set && record.set.releaseDate);

		if (date) {
			return dayNumber(date);
		}

		const set = record.set && record.set.id ? await ja.setDetail(record.set.id) : null;

		return set ? dayNumber(set.releaseDate) : null;
	}

	// The aligned English sets for a Japanese set, from its first 16 cards,
	// kept a week (an empty answer is how a set with no English counterpart
	// yet looks).
	async function alignedFor(setId, day, index) {
		const key = `aligned:ja:${setId}`;
		const saved = await store.get('english', key);

		if (saved && now() - saved.at < RECHECK_MS) {
			return saved.sets;
		}

		const set = await ja.setDetail(setId);
		const ids = ((set && set.cards) || []).slice(0, 16).map((card) => card.id);
		const sample = (await Promise.all(ids.map((id) => limit(() => ja.cardDetail(id)).catch(() => null)))).filter(Boolean);
		const sets = alignedSets(sample, day, index);

		await store.put('english', key, {at: now(), sets});

		return sets;
	}

	async function loaded() {
		if (!memory.loaded) {
			memory.loaded = (async () => {
				for (const [key, value] of await store.all('results')) {
					memory.results.set(key, value);
				}

				for (const [key, value] of await store.all('decisions')) {
					memory.decisions.set(key, value);
				}
			})();
		}

		return memory.loaded;
	}

	// {status, candidates} for one Japanese TCGdex card record (card detail's
	// record: category, dexId, hp, attacks, illustrator, effect, trainerType,
	// rarity, localId, set). Saved on the device as the card's result.
	// options: catalog (default "ja"), setDate (the Japanese set's release,
	// looked up when the record does not carry it), aligned (skip the
	// sample), save (default true).
	async function findTwin(record, {aligned = null, catalog = 'ja', save = true, setDate = null} = {}) {
		if (!record || catalog !== 'ja') {
			return {candidates: [], status: 'none'};
		}

		const day = await releaseDay(record, setDate);

		if (day === null) {
			return {candidates: [], status: 'none'};
		}

		const index = await indexFor(day);
		const context = {
			aligned: aligned || (record.set && record.set.id ? await alignedFor(record.set.id, day, index) : []),
			rarityMap: RARITY_MAP,
		};
		const result = resultOf(matchCard(record, day, index, context));

		if (save) {
			await saveResult(keyOf(catalog, record.id), record, result);
		}

		return result;
	}

	async function saveResult(key, record, result) {
		await loaded();

		const saved = {
			candidates: result.candidates,
			category: record.category || null,
			checked_at: now(),
			status: result.status,
			version: MATCHER_VERSION,
		};

		memory.results.set(key, saved);
		await store.put('results', key, saved);
		changed(key);
	}

	// Whether a saved result should be worked out again: never checked, an
	// older rule, or none or weak and a week old. A confident or ambiguous
	// result stays.
	const due = (saved) => !saved
		|| saved.version !== MATCHER_VERSION
		|| ((saved.status === 'none' || saved.status === 'weak') && now() - saved.checked_at >= RECHECK_MS);

	// The saved result, worked out first when due. A person's "none" decision
	// stops the checks. A card already being worked out is not started
	// again: card detail asks on every redraw.
	const working = new Map();

	async function ensureTwin(record, {catalog = 'ja', force = false, setDate = null} = {}) {
		await loaded();

		const key = keyOf(catalog, record.id);
		const decision = memory.decisions.get(key);
		const saved = memory.results.get(key);

		const settled = (decision && decision.choice === 'none') || !due(saved);

		if (settled && !force) {
			return twinState(key);
		}

		if (!working.has(key)) {
			working.set(key, findTwin(record, {catalog, setDate}).finally(() => working.delete(key)));
		}

		await working.get(key);

		return twinState(key);
	}

	// Brings every due Japanese card among items (entries or index records)
	// up to date in the background, loading each record cache first.
	// Returns how many were checked. Calls run one after another, so a view
	// opened twice never checks the same card twice, and a run stops when
	// the device is offline or TCGdex cannot be reached: the next call
	// carries on from there.
	function refreshTwins(items) {
		const run = refreshing.then(() => refreshDue(items));

		refreshing = run.catch(() => 0);

		return run;
	}

	async function refreshDue(items) {
		await loaded();

		const keys = [...new Set(items.map((item) => twinKey(item)).filter((key) => key && key.startsWith('ja|')))];
		const todo = keys.filter((key) => {
			const decision = memory.decisions.get(key);

			return !(decision && decision.choice === 'none') && due(memory.results.get(key));
		});
		let checked = 0;

		// One card at a time: the requests inside are already four wide, and
		// the cards of one set share their English data.
		for (const key of todo) {
			if (!online()) {
				break;
			}

			try {
				const record = await ja.cardDetail(key.slice(3));

				if (record) {
					await findTwin(record);
					checked++;
				}
			}
			catch (err) {
				// A TCGdex error for this card: the next refresh tries it
				// again. Unreachable: stop until the next refresh.
				if (err && err.network) {
					break;
				}
			}
		}

		return checked;
	}

	// The person's answer for one card:
	//   {choice: "confirmed", twin}   this candidate is the international print
	//   {choice: "rejected"}          none of the candidates shown; a later
	//                                 check may still offer new ones
	//   {choice: "none"}              this card has no international print;
	//                                 stop looking
	async function setDecision(item, {choice, twin = null, rejected = null}) {
		await loaded();

		const key = twinKey(item, 'ja');

		if (!key || !['confirmed', 'rejected', 'none'].includes(choice)) {
			throw new Error('A twin decision needs a card and a choice of confirmed, rejected, or none.');
		}

		const saved = memory.results.get(key);
		const decision = {
			choice,
			decided_at: new Date(now()).toISOString(),
			rejected_ids: choice === 'rejected' ? (rejected || (saved ? saved.candidates.map((c) => c.id) : [])) : [],
			twin: choice === 'confirmed' && twin ? candidateFields(twin) : null,
		};

		memory.decisions.set(key, decision);
		await store.put('decisions', key, decision);
		changed(key);

		return decision;
	}

	const candidateFields = (twin) => ({
		category: twin.category || null,
		id: twin.id,
		image: twin.image || null,
		localId: twin.localId || null,
		name: twin.name || null,
		setId: twin.setId || null,
		setName: twin.setName || null,
	});

	// Everything known for one card: {status, candidates, decision, twin,
	// ask}. twin is the confident or confirmed twin, or null. ask is true when
	// card detail should offer the picker: an ambiguous result with candidates
	// the person has not turned down, and no decision that settles it.
	function twinState(item, catalog = null) {
		const key = twinKey(item, catalog);
		const saved = key ? memory.results.get(key) : null;
		const decision = key ? memory.decisions.get(key) || null : null;
		const rejected = new Set(decision && decision.choice === 'rejected' ? decision.rejected_ids : []);
		const candidates = saved ? saved.candidates.filter((c) => !rejected.has(c.id)) : [];
		const status = saved ? saved.status : null;
		let twin = null;

		if (decision && decision.choice === 'confirmed') {
			twin = decision.twin;
		}
		else if ((!decision || decision.choice === 'rejected') && status === 'confident' && candidates.length) {
			twin = candidates[0];
		}

		const ask = !twin
			&& status === 'ambiguous'
			&& candidates.length > 0
			&& !(decision && (decision.choice === 'none' || decision.choice === 'confirmed'));

		return {ask, candidates, category: saved ? saved.category : null, decision, status, twin};
	}

	// The decisions as rows a later change can sync, newest last.
	async function exportDecisions() {
		await loaded();

		return [...memory.decisions].map(([key, decision]) => {
			const [catalog, cardId] = key.split('|');

			return {card_id: cardId, catalog, ...decision};
		}).sort((a, b) => a.decided_at.localeCompare(b.decided_at));
	}

	// Takes rows from exportDecisions() (another device's), keeping the newer
	// decision for each card. Returns how many changed.
	async function importDecisions(rows) {
		await loaded();

		let count = 0;

		for (const row of rows || []) {
			if (!row || !row.catalog || !row.card_id || !['confirmed', 'rejected', 'none'].includes(row.choice)) {
				continue;
			}

			const key = keyOf(row.catalog, row.card_id);
			const old = memory.decisions.get(key);

			if (old && String(old.decided_at) >= String(row.decided_at)) {
				continue;
			}

			const decision = {
				choice: row.choice,
				decided_at: row.decided_at,
				rejected_ids: row.rejected_ids || [],
				twin: row.twin || null,
			};

			memory.decisions.set(key, decision);
			await store.put('decisions', key, decision);
			changed(key);
			count++;
		}

		return count;
	}

	// The twin's image URL in a size ("high" for card detail, "low" for
	// tiles), or null: only a confident or confirmed twin with an image.
	// Synchronous, from what loadTwins() read; null until then.
	function twinImage(item, {catalog = null, size = 'high'} = {}) {
		const {twin} = twinState(item, catalog);

		return twin && twin.image ? cardImage(twin.image, size) : null;
	}

	// The photos carousel's twin list (js/photos/index.js): [] or one
	// {src, label}.
	function twinSlides(item, options = {}) {
		const src = twinImage(item, options);

		return src ? [{label: LABEL, src}] : [];
	}

	// The twin's English name for a Trainer or Energy card, or null (Pokémon
	// names come from js/names.js).
	function twinName(item, {catalog = null} = {}) {
		const state = twinState(item, catalog);
		const category = state.category || (item && item.category) || (state.twin && state.twin.category);

		return state.twin && state.twin.name && (category === 'Trainer' || category === 'Energy') ? state.twin.name : null;
	}

	return {
		englishSets,
		ensureTwin,
		exportDecisions,
		findTwin,
		importDecisions,
		loadTwins: loaded,
		onTwinsChange(listener) {
			listeners.add(listener);

			return () => listeners.delete(listener);
		},
		refreshTwins,
		setDecision,
		twinImage,
		twinName,
		twinSlides,
		twinState,
	};
}

// ------------------------------------------------------ default instance

let instance = null;

const twins = () => {
	if (!instance) {
		instance = createTwins();
	}

	return instance;
};

export const findTwin = (record, options) => twins().findTwin(record, options);
export const ensureTwin = (record, options) => twins().ensureTwin(record, options);
export const refreshTwins = (items) => twins().refreshTwins(items);
export const loadTwins = () => twins().loadTwins();
export const onTwinsChange = (listener) => twins().onTwinsChange(listener);
export const setDecision = (item, decision) => twins().setDecision(item, decision);
export const twinState = (item, catalog) => twins().twinState(item, catalog);
export const twinImage = (item, options) => twins().twinImage(item, options);
export const twinSlides = (item, options) => twins().twinSlides(item, options);
export const twinName = (item, options) => twins().twinName(item, options);
export const exportDecisions = () => twins().exportDecisions();
export const importDecisions = (rows) => twins().importDecisions(rows);
