// Tests for international twins (js/twins.js): the matcher ported from the
// research (/tmp/twins/match2.py) on its key cases, and the data layer over
// a fake TCGdex and an in-memory store. Node only, no browser and no network.
//
// The real-data run is tests/twins-live.mjs; the confirmation component's
// browser check is tests/twins-browser.test.mjs.
//
// Run: node --test tests/twins.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {
	LABEL,
	RARITY_MAP,
	RECHECK_MS,
	createTwins,
	englishIndex,
	illustratorScore,
	limiter,
	matchCard,
	memoryStore,
	resultOf,
	sequenceRatio,
	twinKey,
} from '../js/twins.js';

import {CASES, ENGLISH} from './twins-fixtures.mjs';
import {checkIntegration} from './twins-harness.mjs';

const INDEX = englishIndex(ENGLISH);

const run = (id, index = INDEX) => {
	const {aligned, record, setDate} = CASES[id];

	return matchCard(record, setDate, index, {aligned, rarityMap: RARITY_MAP});
};

const DAY = 24 * 60 * 60 * 1000;

describe('the matcher, on the research cases', () => {
	test('a Pokémon matches its English print (M4-001 Weedle)', () => {
		const match = run('M4-001');

		assert.equal(match.verdict, CASES['M4-001'].research.verdict);
		assert.equal(match.top.card.id, 'me04-001');
		assert.deepEqual(resultOf(match), {
			candidates: [resultOf(match).candidates[0]],
			status: 'confident',
		});
		assert.equal(resultOf(match).candidates[0].name, 'Weedle');
	});

	test('a Trainer is told apart from its set mates by the keyword pairs (M4-107)', () => {
		const match = run('M4-107');
		const [top, rival] = match.ranked;

		assert.equal(match.verdict, 'one');
		assert.equal(top.card.id, 'me04-115');
		assert.deepEqual(match.ranked.map((row) => row.card.id), CASES['M4-107'].research.ranked);

		// Illustrator, type, numbers, symbols, rarity, set, and numbering all
		// agree for the runner-up; only the keywords separate them, and
		// without them the lead would be under the margin of 1.
		for (const part of ['ill', 'tt', 'dig', 'sym', 'rar', 'set', 'sec']) {
			assert.equal(top.parts[part], rival.parts[part], part);
		}

		assert.ok(top.parts.con > rival.parts.con);
		assert.ok(top.score - rival.score >= 1);
		assert.ok((top.score - top.parts.con) - (rival.score - rival.parts.con) < 1);
	});

	test('a Basic Energy reprinted with the same art collapses to the earliest print', () => {
		// No Basic Energy is among the measured cards, so this one is made up
		// in their shape: no illustrator on either side, as TCGdex has them,
		// and two English printings in two aligned sets (S11 aligned with two).
		const energy = (id, setId, setDate) => ({
			attacks: [],
			category: 'Energy',
			id,
			localId: id.split('-')[1],
			name: 'Fire Energy',
			official: 200,
			rarity: 'Common',
			setDate,
			setId,
		});
		// Listed newest first, so the order comes from the dates.
		const index = englishIndex([energy('swsh12-190', 'swsh12', '2022-11-11'), energy('swsh11-185', 'swsh11', '2022-09-09')]);
		const record = {attacks: [], category: 'Energy', id: 'S11-200', localId: '090', name: '基本炎エネルギー', rarity: 'Common', set: {cardCount: {official: 100}, id: 'S11'}};
		const match = matchCard(record, '2022-07-15', index, {aligned: ['swsh11', 'swsh12'], rarityMap: RARITY_MAP});

		assert.equal(match.ranked.length, 2);
		assert.equal(match.ranked[0].score, match.ranked[1].score);
		assert.equal(match.verdict, 'one');
		assert.equal(match.top.card.id, 'swsh11-185');
		assert.equal(resultOf(match).status, 'confident');

		// Without the expected English set, an Energy with no illustrator is
		// not trusted.
		assert.equal(matchCard(record, '2022-07-15', index, {aligned: [], rarityMap: RARITY_MAP}).verdict, 'weak');
	});

	test('a secret rare finds the secret print, the main-set card the main-set print (S11 Aerodactyl VSTAR)', () => {
		const main = run('S11-057');
		const secret = run('S11-118');

		assert.equal(main.verdict, 'one');
		assert.equal(main.top.card.id, 'swsh11-093');
		assert.equal(secret.verdict, 'one');
		assert.equal(secret.top.card.id, 'swsh11-199');

		// The same two candidates, ranked the other way by numbering and rarity.
		assert.deepEqual(main.ranked.map((row) => row.card.id), ['swsh11-093', 'swsh11-199']);
		assert.deepEqual(secret.ranked.map((row) => row.card.id), ['swsh11-199', 'swsh11-093']);
		assert.equal(main.ranked[0].parts.sec, 1.5);
		assert.equal(main.ranked[1].parts.sec, 0);
	});

	test('an M6 card with no English set yet has no twin', () => {
		const match = run('M6-001');

		// Nine English Heracross prints exist, all outside the window or with
		// other stats.
		assert.equal(CASES['M6-001'].research.verdict, 'none');
		assert.equal(match.verdict, 'none');
		assert.deepEqual(resultOf(match), {candidates: [], status: 'none'});
	});

	test('illustrator names compare the way the research compared them', () => {
		// Python difflib ratios, computed 2026-10-01.
		const python = [
			['5bangraphics', '5bangraphic', 0.9565217391304348],
			['kagemaruhimeno', 'kagemaruhimen0', 0.9285714285714286],
			['akira', 'akita', 0.8],
			['teeziro', 'teejiro', 0.8571428571428571],
			['mitsuhirosarai', 'mitsuhiroarita', 0.8571428571428571],
		];

		for (const [a, b, ratio] of python) {
			assert.ok(Math.abs(sequenceRatio(a, b) - ratio) < 1e-12, `${a} ${b}`);
		}

		assert.equal(illustratorScore('Kagemaru Himeno', 'kagemaru himeno'), 3);
		assert.equal(illustratorScore('5ban Graphics', '5ban Graphic'), 2);
		assert.equal(illustratorScore('Akira', 'Akita'), 0);
		assert.equal(illustratorScore('', ''), 0);
		assert.equal(illustratorScore('ひらかわ', 'ひらかわ'), 0);
	});

	test('an ambiguous result lists up to three distinct artworks', () => {
		const card = (id, setId, illustrator, day) => ({card: {id, illustrator, name: 'Boss', rarity: 'Rare', setId}, score: 10, day});
		const rows = [
			card('a-1', 'a', 'X', 1),
			card('b-1', 'b', 'X', 2),
			card('c-1', 'c', 'Y', 3),
			card('d-1', 'd', 'Z', 4),
			card('e-1', 'e', 'W', 5),
		];
		const result = resultOf({ranked: rows, top: rows[0], verdict: 'several'});

		assert.equal(result.status, 'ambiguous');
		// b-1 is a reprint of a-1's artwork, so it is left out.
		assert.deepEqual(result.candidates.map((c) => c.id), ['a-1', 'c-1', 'd-1']);
	});
});

// ------------------------------------------------------- the data layer

// A fake TCGdex GraphQL endpoint over a list of English sets
// ({id, name, releaseDate, serie, official, cards}). failures: how many
// answers to send as 503 first.
function fakeTcgdex(sets, {failures = 0} = {}) {
	const calls = [];
	let left = failures;

	const fetch = async (url, {body}) => {
		const {query} = JSON.parse(body);

		calls.push(query);

		if (left > 0) {
			left--;

			return {json: async () => ({}), ok: false, status: 503};
		}

		let data;

		if (query.startsWith('{ sets ')) {
			data = {sets: fake.sets.map((set) => ({
				cardCount: {official: set.official, total: set.cards.length},
				id: set.id,
				name: set.name,
				releaseDate: set.releaseDate,
				serie: {id: set.serie},
			}))};
		}
		else {
			data = {};

			for (const [, alias, prefix] of query.matchAll(/(s\d+): cards\(filters: \{id: "([^"]+)"\}/g)) {
				data[alias] = fake.sets.flatMap((set) => set.cards).filter((card) => card.id.includes(prefix));
			}
		}

		return {json: async () => ({data}), ok: true, status: 200};
	};

	const fake = {calls, fetch, sets};

	return fake;
}

const strip = ({id, localId, name, category, effect, dexId, illustrator, hp, rarity, trainerType, image, attacks}) =>
	({attacks, category, dexId, effect, hp, id, illustrator, image, localId, name, rarity, trainerType});

// The English sets near M4 in the fixtures, as the API lists them, plus a
// TCG Pocket set carrying a perfect copy of Weedle.
function nearM4() {
	const bySet = (setId) => ENGLISH.filter((card) => card.setId === setId).map(strip);
	const pocketWeedle = {...strip(ENGLISH.find((card) => card.id === 'me04-001')), id: 'A1-001'};

	return [
		{cards: bySet('me02.5'), id: 'me02.5', name: 'Ascended Heroes', official: 217, releaseDate: '2026-01-30', serie: 'me'},
		{cards: bySet('me03'), id: 'me03', name: 'Perfect Order', official: 88, releaseDate: '2026-03-27', serie: 'me'},
		{cards: bySet('me04'), id: 'me04', name: 'Chaos Rising', official: 86, releaseDate: '2026-05-22', serie: 'me'},
		{cards: bySet('me05'), id: 'me05', name: 'Pitch Black', official: 84, releaseDate: '2026-07-17', serie: 'me'},
		{cards: [pocketWeedle], id: 'A1', name: 'Genetic Apex', official: 226, releaseDate: '2026-04-01', serie: 'tcgp'},
	];
}

function fakeJapanese(cases) {
	const records = new Map(cases.map((id) => [id, CASES[id].record]));
	const calls = [];

	return {
		calls,
		ja: {
			cardDetail: async (id) => {
				calls.push(`card ${id}`);

				return records.get(id) || null;
			},
			setDetail: async (id) => {
				calls.push(`set ${id}`);

				const ids = cases.filter((card) => card.startsWith(`${id}-`));

				return {cards: ids.map((card) => ({id: card})), id, releaseDate: CASES[ids[0]].setDate};
			},
		},
	};
}

function instance({cases = ['M4-001', 'M4-107'], failures = 0, fetch = null, online = () => true, sets = nearM4(), start = Date.parse('2026-10-01T12:00:00Z')} = {}) {
	const tcgdex = fakeTcgdex(sets, {failures});
	const japanese = fakeJapanese(cases);
	const clock = {now: start};
	const waits = [];
	const store = memoryStore();
	const twins = createTwins({
		fetch: fetch || tcgdex.fetch,
		ja: japanese.ja,
		now: () => clock.now,
		online,
		store,
		wait: async (ms) => {
			waits.push(ms);
		},
	});

	return {clock, japanese, store, tcgdex, twins, waits};
}

describe('the data layer', () => {
	test('finds the twin over the network, retrying a 503, and never asks for TCG Pocket', async () => {
		const {tcgdex, twins, waits} = instance({failures: 2});
		const result = await twins.findTwin(CASES['M4-001'].record);

		assert.equal(result.status, 'confident');
		assert.equal(result.candidates[0].id, 'me04-001');
		assert.deepEqual(waits, [1000, 3000]);

		// One set list and one request for the cards of every set in the window.
		const queries = tcgdex.calls.slice(2);

		assert.equal(queries.length, 2);
		assert.ok(queries.every((query) => !query.includes('"A1-"')));
		assert.ok(queries[1].includes('"me04-"') && queries[1].includes('"me05-"'));
	});

	test('a Pocket copy with every field the same is still no candidate', async () => {
		const {twins} = instance();

		for (const id of ['M4-001', 'M4-107']) {
			const result = await twins.findTwin(CASES[id].record);

			assert.ok(result.candidates.every((c) => !c.id.startsWith('A1-')), id);
		}
	});

	test('a second card of the same set sends no more requests', async () => {
		const {tcgdex, twins} = instance();

		await twins.findTwin(CASES['M4-001'].record);

		const before = tcgdex.calls.length;
		const trainer = await twins.findTwin(CASES['M4-107'].record);

		assert.equal(tcgdex.calls.length, before);
		assert.equal(trainer.status, 'confident');
		assert.equal(trainer.candidates[0].id, 'me04-115');
	});

	test('a card with no twin is checked again after a week, and fills in once its English set appears', async () => {
		const sets = [{cards: ENGLISH.filter((card) => card.setId === 'me05').map(strip), id: 'me05', name: 'Pitch Black', official: 84, releaseDate: '2026-07-17', serie: 'me'}];
		const {clock, tcgdex, twins} = instance({cases: ['M6-001'], sets});
		const heracross = CASES['M6-001'].record;

		assert.equal((await twins.ensureTwin(heracross)).status, 'none');

		const calls = tcgdex.calls.length;

		clock.now += 6 * DAY;
		assert.equal((await twins.ensureTwin(heracross)).status, 'none');
		assert.equal(tcgdex.calls.length, calls, 'no request inside the week');

		// The English counterpart comes out.
		sets.push({
			cards: [{
				attacks: [{cost: ['Grass'], damage: '20'}, {cost: ['Grass', 'Colorless', 'Grass'], damage: '130'}],
				category: 'Pokemon',
				dexId: [214],
				hp: 130,
				id: 'me06-001',
				illustrator: 'Satoshi Ito',
				image: 'https://assets.tcgdex.net/en/me/me06/001',
				localId: '001',
				name: 'Heracross',
				rarity: 'Common',
			}],
			id: 'me06',
			name: 'Next Set',
			official: 80,
			releaseDate: '2026-09-25',
			serie: 'me',
		});
		clock.now += 2 * DAY;

		const state = await twins.ensureTwin(heracross);

		assert.equal(state.status, 'confident');
		assert.equal(state.twin.id, 'me06-001');
		assert.equal(twins.twinImage({card_id: 'M6-001', catalog: 'ja'}), 'https://assets.tcgdex.net/en/me/me06/001/high.webp');

		// A confident result stays: no more checks.
		const settled = tcgdex.calls.length;

		clock.now += 30 * DAY;
		await twins.ensureTwin(heracross);
		assert.equal(tcgdex.calls.length, settled);
	});

	test('refreshTwins checks the due Japanese cards among entries and index records', async () => {
		const {japanese, twins} = instance();
		const checked = await twins.refreshTwins([
			{card_id: 'M4-001', catalog: 'ja', id: 'entry-1'},
			{catalog: 'ja', id: 'M4-107'},
			{card_id: 'me01-001', catalog: 'international', id: 'entry-2'},
			{card_id: 'SV5K-001', catalog: 'ko', id: 'entry-3'},
		]);

		assert.equal(checked, 2);
		assert.ok(japanese.calls.includes('card M4-001') && japanese.calls.includes('card M4-107'));
		assert.equal(await twins.refreshTwins([{card_id: 'M4-001', catalog: 'ja'}]), 0);
	});

	test('refreshTwins calls run one after another, so a card is checked once', async () => {
		const items = [{card_id: 'M4-001', catalog: 'ja'}, {card_id: 'M4-107', catalog: 'ja'}];
		const once = instance();

		await once.twins.refreshTwins(items);

		const {japanese, tcgdex, twins} = instance();
		const counts = await Promise.all([twins.refreshTwins(items), twins.refreshTwins(items)]);

		assert.deepEqual(counts, [2, 0]);
		assert.deepEqual(japanese.calls, once.japanese.calls);
		assert.equal(tcgdex.calls.length, once.tcgdex.calls.length);
	});

	test('ensureTwin asked again while it works a card out sends no more requests', async () => {
		const once = instance();

		await once.twins.ensureTwin(CASES['M4-001'].record);

		const {tcgdex, twins} = instance();
		const states = await Promise.all([twins.ensureTwin(CASES['M4-001'].record), twins.ensureTwin(CASES['M4-001'].record)]);

		assert.equal(tcgdex.calls.length, once.tcgdex.calls.length);
		assert.ok(states.every((state) => state.twin && state.twin.id === 'me04-001'));
	});

	test('refreshTwins stops offline, and when TCGdex cannot be reached', async () => {
		const items = [{card_id: 'M4-001', catalog: 'ja'}, {card_id: 'M4-107', catalog: 'ja'}];
		const offline = instance({online: () => false});

		assert.equal(await offline.twins.refreshTwins(items), 0);
		assert.deepEqual(offline.japanese.calls, []);

		// The connection drops: the retries run out on the first card, and the
		// second is left for the next refresh.
		let fetches = 0;
		const dropped = instance({fetch: async () => {
			fetches++;

			throw new TypeError('Failed to fetch');
		}});

		assert.equal(await dropped.twins.refreshTwins(items), 0);
		assert.equal(fetches, 5);
		assert.deepEqual(dropped.waits, [1000, 3000, 8000, 16000]);
		assert.ok(!dropped.japanese.calls.includes('card M4-107'));
		assert.equal(dropped.twins.twinState({card_id: 'M4-001', catalog: 'ja'}).status, null, 'nothing saved, so it stays due');
	});

	test('the helpers lend only a confident or confirmed twin, and the English name only for Trainers and Energy', async () => {
		const {twins} = instance();

		await twins.findTwin(CASES['M4-001'].record);
		await twins.findTwin(CASES['M4-107'].record);

		const weedle = {card_id: 'M4-001', catalog: 'ja'};
		const scrapper = {catalog: 'ja', id: 'M4-107'};

		assert.equal(twins.twinImage(weedle, {size: 'low'}), 'https://assets.tcgdex.net/en/me/me04/001/low.webp');
		assert.deepEqual(twins.twinSlides(CASES['M4-001'].record, {catalog: 'ja'}), [{label: LABEL, src: 'https://assets.tcgdex.net/en/me/me04/001/high.webp'}]);
		assert.equal(twins.twinName(weedle), null, 'Pokémon names come from js/names.js');
		assert.equal(twins.twinName(scrapper), 'Tool Scrapper');

		// Unknown, other catalogs, and records with no catalog lend nothing.
		assert.equal(twins.twinImage({card_id: 'M4-002', catalog: 'ja'}), null);
		assert.equal(twins.twinImage({card_id: 'M4-001', catalog: 'ko'}), null);
		assert.equal(twins.twinImage(CASES['M4-001'].record), null);

		// "None of these" on a confident twin takes it away.
		await twins.setDecision(weedle, {choice: 'rejected'});
		assert.equal(twins.twinImage(weedle), null);
		assert.deepEqual(twins.twinSlides(weedle), []);
	});

	test('an ambiguous card asks, and the answer is kept, exported, and imported', async () => {
		const {twins, store} = instance();
		const key = {card_id: 'M3-068', catalog: 'ja'};

		// An ambiguous result as findTwin saves it (M3-068's research
		// candidates).
		await twins.loadTwins();
		await store.put('results', 'ja|M3-068', {
			candidates: [
				{category: 'Trainer', id: 'me03-068', image: 'https://assets.tcgdex.net/en/me/me03/068', name: 'Sample A', setId: 'me03'},
				{category: 'Trainer', id: 'me03-069', image: 'https://assets.tcgdex.net/en/me/me03/069', name: 'Sample B', setId: 'me03'},
				{category: 'Trainer', id: 'me05-072', image: null, name: 'Sample C', setId: 'me05'},
			],
			category: 'Trainer',
			checked_at: Date.now(),
			status: 'ambiguous',
			version: 1,
		});

		const reloaded = createTwins({fetch: null, ja: null, store});

		await reloaded.loadTwins();

		let state = reloaded.twinState(key);

		assert.equal(state.ask, true);
		assert.equal(state.candidates.length, 3);
		assert.equal(reloaded.twinImage(key), null, 'nothing shows before the person picks');

		await reloaded.setDecision(key, {choice: 'rejected', rejected: ['me03-068', 'me03-069']});
		state = reloaded.twinState(key);
		assert.equal(state.ask, true, 'a candidate not turned down is still offered');
		assert.deepEqual(state.candidates.map((c) => c.id), ['me05-072']);

		await reloaded.setDecision(key, {choice: 'confirmed', twin: state.candidates[0]});
		state = reloaded.twinState(key);
		assert.equal(state.ask, false);
		assert.equal(state.twin.id, 'me05-072');
		assert.equal(reloaded.twinImage(key), null, 'no image on the twin, so none to lend');
		assert.equal(reloaded.twinName(key), 'Sample C');

		const rows = await reloaded.exportDecisions();

		assert.equal(rows.length, 1);
		assert.equal(rows[0].catalog, 'ja');
		assert.equal(rows[0].card_id, 'M3-068');
		assert.equal(rows[0].choice, 'confirmed');
		assert.equal(rows[0].twin.id, 'me05-072');

		// Another device: the newer answer wins, an older one is ignored.
		const other = createTwins({fetch: null, ja: null, store: memoryStore()});

		assert.equal(await other.importDecisions(rows), 1);
		assert.equal(other.twinState(key).twin.id, 'me05-072');
		assert.equal(await other.importDecisions([{...rows[0], choice: 'none', decided_at: '2000-01-01T00:00:00.000Z'}]), 0);
		assert.equal(await other.importDecisions([{...rows[0], choice: 'none', decided_at: '2999-01-01T00:00:00.000Z', twin: null}]), 1);
		assert.equal(other.twinState(key).twin, null);
		assert.equal(other.twinState(key).ask, false);
	});

	test('a "none" decision stops the weekly checks', async () => {
		const {clock, tcgdex, twins} = instance({cases: ['M6-001'], sets: []});
		const heracross = CASES['M6-001'].record;

		await twins.ensureTwin(heracross);
		await twins.setDecision({card_id: 'M6-001', catalog: 'ja'}, {choice: 'none'});

		const calls = tcgdex.calls.length;

		clock.now += 2 * RECHECK_MS;
		await twins.ensureTwin(heracross);
		assert.equal(await twins.refreshTwins([{card_id: 'M6-001', catalog: 'ja'}]), 0);
		assert.equal(tcgdex.calls.length, calls);
	});

	test('only Japanese prints are matched', async () => {
		const {tcgdex, twins} = instance();

		assert.deepEqual(await twins.findTwin(CASES['M4-001'].record, {catalog: 'ko'}), {candidates: [], status: 'none'});
		assert.equal(tcgdex.calls.length, 0);
	});

	test('twinKey reads entries, index records, and TCGdex records', () => {
		assert.equal(twinKey({card_id: 'M4-001', catalog: 'ja', id: 'entry'}), 'ja|M4-001');
		assert.equal(twinKey({catalog: 'ja', id: 'M4-001'}), 'ja|M4-001');
		assert.equal(twinKey({id: 'M4-001', set: {id: 'M4'}}, 'ja'), 'ja|M4-001');
		assert.equal(twinKey({id: 'M4-001', set: {id: 'M4'}}), null);
		assert.equal(twinKey('M4-001', 'ja'), 'ja|M4-001');
	});

	test('the limiter keeps four requests in flight at most', async () => {
		const limit = limiter(4);
		let active = 0;
		let peak = 0;

		await Promise.all(Array.from({length: 12}, () => limit(async () => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active--;
		})));

		assert.equal(peak, 4);
	});
});

describe('the integration', () => {
	test('card detail, My Cards, the stylesheet, and the shell carry the twins lines', async () => {
		await checkIntegration();
	});
});
