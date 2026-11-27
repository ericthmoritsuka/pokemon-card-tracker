// The Stats screen's numbers (js/stats.js): totals, the breakdowns, the
// most valuable copies by the Value sheet's own value, the copies with no
// price, and the copies added per month. The card records are the saved
// TCGdex fixtures in tests/prices-fixtures; the copies are invented.
//
// Run: node --test tests/stats.test.mjs

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {describe, test} from 'node:test';

import {tileKey} from '../js/bulk-edit.js';
import {extractPrices, listStats, roundCents} from '../js/prices.js';
import {CONDITIONS, NOT_KNOWN, NOT_SET, collectionStats, copyFinish, finishFamily, lastMonths, listsProgress, monthKey, newestCardStamp, sharePercent} from '../js/stats.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./prices-fixtures/${name}.json`, import.meta.url), 'utf8'));

const charizard = fixture('en-base1-4');
const exeggcute = fixture('en-sv08.5-001');
const RATES = {brlPerUsd: 5, date: '2026-11-01'};
const NOW = new Date(2026, 10, 19, 12);

const variant = (card, label) => extractPrices(card).find((finish) => finish.label === label).variantId;

let ids = 0;

const copy = (fields) => ({
	card_id: 'base1-4',
	catalog: 'international',
	created_at: new Date(2026, 10, 2).toISOString(),
	id: `e${++ids}`,
	language: 'en',
	...fields,
});

// The index records (names, rarity, types) with the full records over
// them, as the screen merges them.
const INDEX = new Map([
	['international|base1-4', {catalog: 'international', category: 'Pokemon', id: 'base1-4', localizations: {en: {name: 'Charizard', set_name: 'Base Set'}}, rarity: 'Rare', set_id: 'base1', types: ['Fire']}],
	['international|sv08.5-001', {catalog: 'international', category: 'Pokemon', id: 'sv08.5-001', localizations: {en: {name: 'Exeggcute', set_name: 'Prismatic Evolutions'}}, rarity: 'Common', set_id: 'sv08.5', types: ['Grass']}],
	['international|base1-95', {catalog: 'international', category: 'Trainer', id: 'base1-95', localizations: {en: {name: 'Switch', set_name: 'Base Set'}}, rarity: 'Common', set_id: 'base1', types: []}],
	['ja|SV2a-151', {catalog: 'ja', category: 'Pokemon', id: 'SV2a-151', localizations: {ja: {name: 'ミュウ', set_name: 'ポケモンカード151'}}, rarity: 'Rare', set_id: 'SV2a', types: ['Psychic']}],
]);
const SAVED = new Map([
	['international|base1-4', {...charizard, rarity: 'Rare', types: ['Fire']}],
	['international|sv08.5-001', {...exeggcute, types: ['Grass']}],
]);
const RECORDS = new Map([...INDEX, ...SAVED]);

// As the screen's describer: names and sets from the card index, never
// from the full record over it.
const describeCopy = (entry) => {
	const record = INDEX.get(`${entry.catalog}|${entry.card_id}`) || null;
	const local = record && (record.localizations[entry.language] || Object.values(record.localizations)[0]);

	return {
		name: (local && local.name) || entry.card_id,
		route: `cards/${entry.language}/${entry.card_id}`,
		setKey: record ? `${entry.catalog}|${record.set_id}` : null,
		setName: (local && local.set_name) || null,
	};
};

const run = (entries, options = {}) => collectionStats(entries, {describe: describeCopy, now: NOW, rates: RATES, records: RECORDS, saved: SAVED, ...options});

function collection() {
	ids = 0;

	return [
		copy({condition: 'Near Mint', variant_id: variant(charizard, 'Holo, Unlimited')}),
		copy({condition: 'Lightly Played', language: 'pt', variant_id: variant(charizard, 'Holo, Unlimited')}),
		copy({card_id: 'sv08.5-001', variant_id: variant(exeggcute, 'Normal')}),
		copy({card_id: 'sv08.5-001', created_at: new Date(2026, 9, 5).toISOString(), variant_id: variant(exeggcute, 'Reverse holo, Master Ball pattern')}),
		copy({card_id: 'sv08.5-001', condition: 'Near Mint', created_at: new Date(2026, 9, 6).toISOString(), variant_id: variant(exeggcute, 'Reverse holo, Master Ball pattern')}),
		// A Trainer whose full record is not on the phone yet: no price.
		copy({card_id: 'base1-95', created_at: new Date(2024, 0, 1).toISOString(), finish_raw: 'NORMAL'}),
		// A Japanese print with a Liga price, and one without.
		copy({card_id: 'SV2a-151', catalog: 'ja', language: 'ja', price_manual: {avg: 80, currency: 'BRL', date: '2026-11-01'}}),
		copy({card_id: 'SV2a-151', catalog: 'ja', language: 'ja'}),
		// Removed: never counted.
		copy({deleted_at: '2026-11-10T00:00:00.000Z'}),
	];
}

describe('collectionStats', () => {
	test('totals count live copies, cards once per language, sets, and languages', () => {
		const stats = run(collection());

		// Charizard in English and in Portuguese is two cards, as My Cards
		// shows two tiles and counts two (QA 2, 2026-11-20).
		assert.deepEqual(stats.totals, {cards: 5, copies: 8, languages: 3, sets: 3});
	});

	test('Cards is My Cards\' count: one per tileKey, the key My Cards groups its tiles by', () => {
		const entries = collection();
		const tiles = new Set(entries.filter((entry) => !entry.deleted_at).map(tileKey));

		assert.equal(run(entries).totals.cards, tiles.size);
	});

	test('breakdowns count copies, most first, with Not set and Not known yet last', () => {
		const stats = run(collection());

		assert.deepEqual(stats.language, [{count: 5, label: 'English'}, {count: 2, label: 'Japanese'}, {count: 1, label: 'Portuguese'}]);
		assert.deepEqual(stats.sets.top, [{count: 3, label: 'Base Set'}, {count: 3, label: 'Prismatic Evolutions'}, {count: 2, label: 'ポケモンカード151'}]);
		assert.deepEqual(stats.sets, {more: 0, moreCopies: 0, top: stats.sets.top});
		assert.deepEqual(stats.rarity, [{count: 4, label: 'Common'}, {count: 4, label: 'Rare'}]);
		assert.deepEqual(stats.type, [{count: 3, label: 'Grass'}, {count: 2, label: 'Fire'}, {count: 2, label: 'Psychic'}, {count: 1, label: 'Trainer'}]);
		assert.equal(stats.typeShared, false);
		assert.deepEqual(stats.finish, [
			{count: 2, label: 'Normal'},
			{count: 2, label: 'Holo'},
			{count: 2, label: 'Master Ball pattern'},
			{count: 2, label: 'No finish set'},
		]);
		assert.deepEqual(stats.condition, [{count: 2, label: 'Near Mint'}, {count: 1, label: 'Lightly Played'}, {count: 5, label: NOT_SET}]);
	});

	test('the most valuable copies take the Value sheet\'s value, alike copies as one row', () => {
		const entries = collection();
		const stats = run(entries);
		const charizardBrl = roundCents(944.53 * 5);

		assert.deepEqual(stats.valuable.map((row) => [row.name, row.brl, row.kind, row.count, row.route]), [
			['Charizard', charizardBrl, 'estimate', 1, 'cards/en/base1-4'],
			['Charizard', charizardBrl, 'estimate', 1, 'cards/pt/base1-4'],
			['ミュウ', 80, 'liga', 1, 'cards/ja/SV2a-151'],
			['Exeggcute', roundCents(1.3 * 5), 'estimate', 2, 'cards/en/sv08.5-001'],
			['Exeggcute', roundCents(0.05 * 5), 'estimate', 1, 'cards/en/sv08.5-001'],
		]);

		// The same sum the Value sheet makes over the same copies.
		const sheet = listStats(entries, RECORDS, {rates: RATES});
		const summed = stats.valuable.reduce((sum, row) => sum + row.brl * row.count, 0);

		assert.equal(roundCents(summed), sheet.total);
		assert.equal(stats.unpriced.count, sheet.unknown.count);
	});

	test('copies with no price say why', () => {
		const stats = run(collection());

		assert.deepEqual(stats.unpriced, {asian: 1, count: 2, none: 0, norate: 0, waiting: 1});

		const noRate = run(collection(), {rates: null});

		assert.equal(noRate.unpriced.norate, 5, 'a US price with no rate');
		assert.equal(noRate.valuable.length, 1, 'only the Liga price is left');
	});

	test('only the top ten copies are listed, most valuable first', () => {
		const entries = Array.from({length: 14}, (_, i) => copy({card_id: `base1-${i + 10}`, price_manual: {avg: i + 1, currency: 'BRL', date: '2026-11-01'}}));
		const stats = run(entries);

		assert.equal(stats.valuable.length, 10);
		assert.deepEqual(stats.valuable.map((row) => row.brl), [14, 13, 12, 11, 10, 9, 8, 7, 6, 5]);
	});

	test('sets past the top ten are counted as more', () => {
		const entries = Array.from({length: 13}, (_, i) => Array.from({length: 13 - i}, () => copy({card_id: `set${i}-1`, set_name_local: `Set ${i}`}))).flat();
		const stats = collectionStats(entries, {now: NOW});

		assert.equal(stats.sets.top.length, 10);
		assert.deepEqual(stats.sets.top[0], {count: 13, label: 'Set 0'});
		assert.deepEqual(stats.sets.top[9], {count: 4, label: 'Set 9'});
		assert.equal(stats.sets.more, 3);
		assert.equal(stats.sets.moreCopies, 3 + 2 + 1);
		assert.equal(stats.totals.sets, 13);
	});

	test('a card of two types counts under each', () => {
		const records = new Map([['international|swsh1-1', {rarity: 'Rare', types: ['Fire', 'Water']}]]);
		const stats = collectionStats([copy({card_id: 'swsh1-1'})], {now: NOW, records});

		assert.deepEqual(stats.type, [{count: 1, label: 'Fire'}, {count: 1, label: 'Water'}]);
		assert.equal(stats.typeShared, true);
	});

	test('rarity and type wait for the card details', () => {
		const stats = collectionStats([copy({card_id: 'zzz-1'})], {now: NOW});

		assert.deepEqual(stats.rarity, [{count: 1, label: NOT_KNOWN}]);
		assert.deepEqual(stats.type, [{count: 1, label: NOT_KNOWN}]);
	});

	test('added per month covers the last twelve months, with older copies counted apart', () => {
		const stats = run(collection());

		assert.deepEqual(stats.months.map((row) => row.month), lastMonths(NOW));
		assert.equal(stats.months.length, 12);
		assert.deepEqual(stats.months.slice(-2), [{count: 2, month: '2026-10'}, {count: 5, month: '2026-11'}]);
		assert.equal(stats.months.reduce((sum, row) => sum + row.count, 0), 7);
		assert.equal(stats.before, 1);
	});

	test('no copies give zeros, never NaN', () => {
		const stats = collectionStats([], {now: NOW});

		assert.deepEqual(stats.totals, {cards: 0, copies: 0, languages: 0, sets: 0});
		assert.deepEqual(stats.valuable, []);
		assert.equal(stats.months.every((row) => row.count === 0), true);
	});

	test('about 2,500 copies are counted quickly', () => {
		const entries = Array.from({length: 2500}, (_, i) => copy({card_id: i % 2 ? 'base1-4' : 'sv08.5-001', condition: CONDITIONS[i % 5], language: ['en', 'pt', 'fr'][i % 3]}));
		const started = performance.now();
		const stats = run(entries);
		const took = performance.now() - started;

		assert.equal(stats.totals.copies, 2500);
		assert.ok(took < 1000, `took ${Math.round(took)} ms`);
	});
});

describe('finishes', () => {
	test('a printing\'s name gives its family', () => {
		assert.equal(finishFamily('Holo, Unlimited'), 'Holo');
		assert.equal(finishFamily('Holo, Shadowless, 1st Edition stamp'), '1st Edition');
		assert.equal(finishFamily('Reverse holo, Poké Ball pattern'), 'Poké Ball pattern');
		assert.equal(finishFamily('Reverse holo'), 'Reverse holo');
		assert.equal(finishFamily(''), NOT_KNOWN);
	});

	test('a copy is named by its matched printing, else by its own word', () => {
		const finishes = extractPrices(exeggcute);

		assert.equal(copyFinish({variant_id: variant(exeggcute, 'Reverse holo')}, finishes), 'Reverse holo');
		assert.equal(copyFinish({finish_raw: 'REVERSE_HOLOFOIL'}, []), 'Reverse holo');
		assert.equal(copyFinish({finish_raw: 'UNLIMITED_HOLOFOIL'}, []), 'Holo');
		assert.equal(copyFinish({finish: 'first'}, []), '1st Edition');
		assert.equal(copyFinish({}, []), 'No finish set');
		assert.equal(copyFinish({variant_id: 'x'}, []), NOT_KNOWN);
	});
});

describe('listsProgress', () => {
	const KANTO = {id: 'c1', kind: 'region', name: 'Kanto', target: 'kanto'};
	const JOHTO = {id: 'c2', kind: 'region', name: 'Johto', target: 'johto'};
	const BASE_SET = {id: 'g1', kind: 'set', level: 'master', name: 'Base Set', target: 'base1'};
	const SAVED = {
		c1: {at: '2026-11-18T10:00:00.000Z', owned: 120, stamp: '2026-11-18T09:00:00.000Z', total: 151, unit: null, unresolved: 2},
		g1: {at: '2026-11-17T10:00:00.000Z', owned: 12, stamp: '2026-11-17T09:00:00.000Z', total: 40, unit: 'finishes'},
		gone: {at: '2026-11-01T10:00:00.000Z', owned: 1, stamp: null, total: 2},
	};

	test('only lists with a count, checklists then goals, under their names now', () => {
		const lists = listsProgress({checklists: [{...KANTO, name: 'Kanto first'}, JOHTO], goals: [BASE_SET], saved: SAVED, stamp: '2026-11-17T09:00:00.000Z'});

		assert.deepEqual(lists.rows, [
			{id: 'c1', kind: 'checklist', name: 'Kanto first', owned: 120, total: 151, unit: null},
			{id: 'g1', kind: 'goal', name: 'Base Set', owned: 12, total: 40, unit: 'finishes'},
		]);
		assert.equal(lists.at, '2026-11-17T10:00:00.000Z', 'the oldest count');
		assert.equal(lists.unresolved, 2);
		assert.equal(lists.changed, false, 'no copy changed after either count began');
	});

	test('a copy changed after a count began says so', () => {
		assert.equal(listsProgress({checklists: [KANTO], saved: SAVED, stamp: '2026-11-18T09:30:00.000Z'}).changed, true);
		assert.equal(listsProgress({checklists: [KANTO], saved: SAVED, stamp: '2026-11-18T09:00:00.000Z'}).changed, false);
		assert.equal(listsProgress({checklists: [KANTO], saved: {c1: {...SAVED.c1, stamp: null}}, stamp: '2026-11-01T00:00:00.000Z'}).changed, true, 'counted with no copies, and there are some now');
	});

	test('nothing counted, or only deleted lists, leaves the part out', () => {
		assert.equal(listsProgress({checklists: [JOHTO], goals: [], saved: SAVED}), null);
		assert.equal(listsProgress({checklists: [], goals: [], saved: SAVED}), null);
		assert.equal(listsProgress({checklists: [KANTO], saved: {c1: {owned: 'x', total: 151}}}), null, 'an unreadable count');
		assert.equal(listsProgress(), null);
	});

	test('the newest change to a copy counts removals', () => {
		assert.equal(newestCardStamp([
			{created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-02T00:00:00.000Z'},
			{created_at: '2026-11-01T00:00:00.000Z', deleted_at: '2026-11-05T00:00:00.000Z', updated_at: '2026-11-03T00:00:00.000Z'},
		]), '2026-11-05T00:00:00.000Z');
		assert.equal(newestCardStamp([]), null);
	});
});

describe('helpers', () => {
	test('months in the phone\'s calendar', () => {
		assert.equal(monthKey(new Date(2026, 0, 31, 23).toISOString()), '2026-01');
		assert.equal(monthKey('not a date'), null);
		assert.equal(monthKey(null), null);
		assert.deepEqual(lastMonths(new Date(2026, 1, 15), 3), ['2025-12', '2026-01', '2026-02']);
	});

	test('a share never reads 0% beside a count', () => {
		assert.equal(sharePercent(1, 400), 'less than 1%');
		assert.equal(sharePercent(1, 4), '25%');
		assert.equal(sharePercent(0, 4), '0%');
		assert.equal(sharePercent(3, 0), '0%');
	});
});
