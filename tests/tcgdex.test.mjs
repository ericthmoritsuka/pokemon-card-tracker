// Unit tests for the shared TCGdex layer (js/tcgdex.js): the one retry
// policy, the set index, and twins reading the shared index instead of
// fetching its own (E-29). No network: fetch is faked.
//
// Run: node --test tests/tcgdex.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {API, GRAPHQL, SET_INDEX_QUERY, fetchJson, graphql, loadSetIndex, setIndexFrom} from '../js/tcgdex.js';
import {createTwins, memoryStore} from '../js/twins.js';

// A fetch answering each call from `answers` in turn: a status with a
// body, or an Error to throw.
function fakeFetch(answers) {
	const calls = [];

	const fetch = async (url, init) => {
		calls.push({init, url});

		const answer = answers.shift();

		if (answer instanceof Error) {
			throw answer;
		}

		return {json: async () => answer.body, ok: answer.status >= 200 && answer.status < 300, status: answer.status};
	};

	return {calls, fetch};
}

const SETS = [
	{cardCount: {official: 86, total: 120}, id: 'me04', name: 'Chaos Rising', releaseDate: '2026-05-22', serie: {id: 'me'}},
	{cardCount: {official: 226, total: 286}, id: 'A1', name: 'Genetic Apex', releaseDate: '2024-10-30', serie: {id: 'tcgp'}},
	{id: 'base1', name: 'Base Set', releaseDate: '1999-01-09', serie: {id: 'base'}},
];

describe('fetchJson', () => {
	test('a path is read from the API, and a 503 or a 429 is retried on the backoff', async () => {
		const {calls, fetch} = fakeFetch([{status: 503}, {status: 429}, {body: {id: 'base1'}, status: 200}]);
		const waits = [];
		const body = await fetchJson('en/sets/base1', {attempts: 4, fetch, wait: async (ms) => waits.push(ms)});

		assert.deepEqual(body, {id: 'base1'});
		assert.deepEqual(calls.map((call) => call.url), Array(3).fill(`${API}en/sets/base1`));
		assert.deepEqual(waits, [1000, 3000]);
	});

	test('views try twice; the last failure says who answered what, and whether to try later', async () => {
		const failing = fakeFetch([{status: 503}, {status: 503}, {status: 503}]);

		await assert.rejects(fetchJson('en/series', {fetch: failing.fetch, wait: async () => {}}), (err) => {
			assert.equal(err.message, 'TCGdex answered 503 for en/series.');
			assert.equal(err.status, 503);
			assert.equal(err.network, true);

			return true;
		});
		assert.equal(failing.calls.length, 2);

		const missing = fakeFetch([{status: 404}]);

		await assert.rejects(fetchJson('https://pokeapi.co/api/v2/x', {attempts: 4, fetch: missing.fetch}), (err) => {
			assert.equal(err.message, 'pokeapi.co answered 404 for https://pokeapi.co/api/v2/x.');
			assert.equal(err.network, false);

			return true;
		});
		assert.equal(missing.calls.length, 1, 'a 404 is not retried');
	});

	test('a dropped connection is retried only while the device is online', async () => {
		const online = fakeFetch([new TypeError('Failed to fetch'), {body: [], status: 200}]);

		assert.deepEqual(await fetchJson('en/series', {fetch: online.fetch, online: () => true, wait: async () => {}}), []);

		const offline = fakeFetch([new TypeError('Failed to fetch')]);

		await assert.rejects(fetchJson('en/series', {attempts: 4, fetch: offline.fetch, online: () => false}), (err) => err.network === true);
		assert.equal(offline.calls.length, 1);
	});

	test('graphql posts the query and returns its data, or throws without data', async () => {
		const {calls, fetch} = fakeFetch([{body: {data: {sets: SETS}}, status: 200}, {body: {errors: [{message: 'bad field'}]}, status: 200}]);

		assert.deepEqual(await loadSetIndex({fetch}), setIndexFrom({sets: SETS}));
		assert.equal(calls[0].url, GRAPHQL);
		assert.equal(calls[0].init.method, 'POST');
		assert.equal(JSON.parse(calls[0].init.body).query, SET_INDEX_QUERY);
		await assert.rejects(graphql('{ nope }', {fetch}), /TCGdex GraphQL: bad field/);
	});
});

describe('the set index', () => {
	test('keeps each set\'s name, date, series, and counts, in the API\'s order', () => {
		const index = setIndexFrom({sets: SETS});

		assert.deepEqual(Object.keys(index), ['me04', 'A1', 'base1']);
		assert.deepEqual(index.me04, {id: 'me04', name: 'Chaos Rising', official: 86, releaseDate: '2026-05-22', serie: 'me', total: 120});
		assert.deepEqual(index.base1, {id: 'base1', name: 'Base Set', official: 0, releaseDate: '1999-01-09', serie: 'base', total: 0});
		assert.throws(() => setIndexFrom({}), /no set list/);
	});

	test('twins reads the shared index, filtered to its series, and sends no request of its own', async () => {
		const asked = [];
		const twins = createTwins({
			fetch: async () => assert.fail('twins fetched its own set list'),
			ja: null,
			sets: async (options) => {
				asked.push(options);

				return {at: Date.now(), data: setIndexFrom({sets: SETS}), error: null};
			},
			store: memoryStore(),
		});

		assert.deepEqual(await twins.englishSets(), [{id: 'me04', name: 'Chaos Rising', official: 86, releaseDate: '2026-05-22', serie: 'me', total: 120}]);
		await twins.englishSets();
		assert.equal(asked.length, 1, 'kept in memory for the week');
		assert.equal(asked[0].maxAge, 7 * 24 * 60 * 60 * 1000);
	});

	test('twins with no shared index on the phone uses its own earlier copy, or stops as offline', async () => {
		const store = memoryStore();
		const none = async () => ({at: null, data: null, error: null});
		const empty = createTwins({fetch: null, ja: null, sets: none, store});

		await assert.rejects(empty.englishSets(), (err) => err.network === true);

		await store.put('english', 'sets', {at: Date.now(), sets: [{id: 'sv01', name: 'Scarlet & Violet', official: 198, releaseDate: '2023-03-31', serie: 'sv', total: 258}]});

		const earlier = createTwins({fetch: null, ja: null, sets: none, store});

		assert.deepEqual((await earlier.englishSets()).map((set) => set.id), ['sv01']);
	});
});
