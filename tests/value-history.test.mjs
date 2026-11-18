// Unit tests for the pure parts of value over time: js/value-history.js
// (snapshot thinning, the change, a card's weekly points) and
// js/prices.js cardmarketAverages. Run: node --test tests/value-history.test.mjs
//
// Collection values are invented. Card prices come from the TCGdex records
// saved in tests/prices-fixtures (en/cards/base1-4, Base Set Charizard).

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {describe, test} from 'node:test';

import {cardmarketAverages, extractPrices} from '../js/prices.js';
import {
	addCardPoint,
	addSnapshot,
	CARD_POINTS_MAX,
	cardPoint,
	cardSeries,
	dayKey,
	snapshotOf,
	thinSnapshots,
	valueChange,
	weekOf,
} from '../js/value-history.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./prices-fixtures/${name}.json`, import.meta.url), 'utf8'));
const charizard = fixture('en-base1-4');

// YYYY-MM-DD n days after 2026-01-01.
const day = (n) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10);
const snap = (n, brl = 100 + n) => ({brl, copies: 10, date: day(n), priced: 8});

describe('dates', () => {
	test('weekOf gives the Monday of the week', () => {
		assert.equal(weekOf('2026-11-18'), '2026-11-16');
		assert.equal(weekOf('2026-11-16'), '2026-11-16');
		assert.equal(weekOf('2026-11-22'), '2026-11-16');
		assert.equal(weekOf('2026-11-23'), '2026-11-23');
		// Across a year's end.
		assert.equal(weekOf('2026-01-01'), '2025-12-29');
	});

	test('dayKey is the local calendar day', () => {
		assert.equal(dayKey(new Date(2026, 10, 18, 23, 30)), '2026-11-18');
		assert.equal(dayKey(new Date(2026, 0, 5, 0, 5)), '2026-01-05');
	});
});

describe('thinSnapshots', () => {
	test('keeps every day of the last 90 and one a week before them', () => {
		const list = Array.from({length: 200}, (_, n) => snap(n));
		const thin = thinSnapshots(list);
		const newest = 199;
		const recent = thin.filter((item) => item.date >= day(newest - 90));
		const older = thin.filter((item) => item.date < day(newest - 90));

		assert.equal(recent.length, 91, 'every day from 90 days before the newest');
		assert.equal(new Set(older.map((item) => weekOf(item.date))).size, older.length, 'one a week before them');
		assert.ok(older.length >= 15 && older.length <= 17, `about 109 days in weeks (${older.length})`);
		assert.deepEqual(thin.map((item) => item.date), [...thin.map((item) => item.date)].sort(), 'oldest first');
		assert.equal(thin[thin.length - 1].date, day(newest));
	});

	test('the week keeps its last snapshot', () => {
		// 2026-01-05 is a Monday; the newest is far enough on to thin it.
		const list = [snap(4, 1), snap(5, 2), snap(6, 3), snap(200, 9)];

		assert.deepEqual(thinSnapshots(list).map((item) => item.brl), [3, 9]);
	});

	test('caps the list, dropping the oldest', () => {
		const list = Array.from({length: 50}, (_, n) => snap(n));
		const thin = thinSnapshots(list, {max: 10});

		assert.equal(thin.length, 10);
		assert.equal(thin[0].date, day(40));
	});

	test('the same list always thins the same way, in any order', () => {
		const list = Array.from({length: 150}, (_, n) => snap(n * 2));

		assert.deepEqual(thinSnapshots([...list].reverse()), thinSnapshots(list));
		assert.deepEqual(thinSnapshots(thinSnapshots(list)), thinSnapshots(list));
	});

	test('drops what is not a snapshot', () => {
		assert.deepEqual(thinSnapshots([null, {date: 'soon', brl: 1}, {date: '2026-01-01', brl: Number.NaN}, {date: '2026-01-01', brl: -1}]), []);
		assert.deepEqual(thinSnapshots(undefined), []);
	});

	test('stays under 400 after years of daily snapshots', () => {
		let list = [];

		for (let n = 0; n < 365 * 8; n++) {
			list = addSnapshot(list, snap(n));
		}

		assert.ok(list.length <= 400, `${list.length}`);
		assert.equal(list[list.length - 1].date, day(365 * 8 - 1));
	});
});

describe('addSnapshot', () => {
	test('a later reading the same day takes the earlier one\'s place', () => {
		const list = addSnapshot(addSnapshot([], snap(1, 50)), snap(1, 70));

		assert.deepEqual(list, [snap(1, 70)]);
	});

	test('an invalid snapshot changes nothing', () => {
		assert.deepEqual(addSnapshot([snap(1)], {brl: null, date: day(2)}), [snap(1)]);
	});
});

describe('snapshotOf', () => {
	test('takes the total and counts from listStats', () => {
		assert.deepEqual(snapshotOf({count: 12, priced: 9, total: 1234.5}, '2026-11-18'), {brl: 1234.5, copies: 12, date: '2026-11-18', priced: 9});
	});

	test('nothing priced is no snapshot', () => {
		assert.equal(snapshotOf({count: 3, priced: 0, total: null}, '2026-11-18'), null);
		assert.equal(snapshotOf(null), null);
	});
});

describe('valueChange', () => {
	test('first against latest, in reais and percent', () => {
		const change = valueChange([snap(1, 1500), snap(2, 1400), snap(3, 1620)]);

		assert.equal(change.brl, 120);
		assert.equal(change.percent, 8);
		assert.equal(change.first.brl, 1500);
		assert.equal(change.latest.brl, 1620);
	});

	test('a fall is negative, rounded to the cent and a tenth of a percent', () => {
		const change = valueChange([snap(1, 300), snap(2, 299.66)]);

		assert.equal(change.brl, -0.34);
		assert.equal(change.percent, -0.1);
	});

	test('no percent from zero, nothing from one snapshot', () => {
		assert.equal(valueChange([snap(1, 0), snap(2, 10)]).percent, null);
		assert.equal(valueChange([snap(1)]), null);
		assert.equal(valueChange([]), null);
	});
});

describe('cardmarketAverages', () => {
	const unlimited = extractPrices(charizard).find((finish) => finish.label === 'Holo, Unlimited').cardmarket;

	test('30, 7, and 1 day averages, in reais with a euro rate', () => {
		const averages = cardmarketAverages(unlimited, {rates: {brlPerEur: 6}});

		assert.deepEqual(averages.map(({days, eur}) => [days, eur]), [[30, 815], [7, 1693.86], [1, 180]]);
		assert.ok(Math.abs(averages[0].brl - 4890) < 1e-9);
		assert.ok(Math.abs(averages[2].brl - 1080) < 1e-9);
	});

	test('euros alone without a rate, and a missing average left out', () => {
		const averages = cardmarketAverages({avg1: 0, avg30: 2.5, avg7: null});

		assert.deepEqual(averages, [{brl: null, days: 30, eur: 2.5}]);
		assert.deepEqual(cardmarketAverages(null), []);
	});
});

describe('a card\'s weekly points', () => {
	const rates = {brlPerUsd: 5};
	const euroRates = {brlPerEur: 6};

	test('cardPoint keeps each finish\'s US market and EU trend, dated by TCGdex', () => {
		const point = cardPoint(charizard, {euroRates, rates});

		assert.equal(point.date, '2026-09-30');
		assert.deepEqual(point.rates, [5, 6]);
		assert.deepEqual(point.prices['Holo, Unlimited'], [944.53, 596.13]);
		assert.deepEqual(point.prices['Holo, Shadowless'], [null, 3330.71]);
		assert.equal(point.prices['Holo, 1999-2000 copyright'], undefined, 'a finish with no price is left out');
	});

	test('a record with no price gives no point', () => {
		assert.equal(cardPoint({id: 'zz-1', variants_detailed: [{type: 'normal', variantId: 'zz'}]}), null);
		assert.equal(cardPoint(null), null);
	});

	test('one point a week, the later one winning', () => {
		const at = (date, usd) => ({date, prices: {Normal: [usd, null]}, rates: [5, null]});
		let points = addCardPoint([], at('2026-11-16', 1));

		points = addCardPoint(points, at('2026-11-18', 2));
		points = addCardPoint(points, at('2026-11-17', 3));
		points = addCardPoint(points, at('2026-11-24', 4));

		assert.deepEqual(points.map((point) => [point.date, point.prices.Normal[0]]), [['2026-11-18', 2], ['2026-11-24', 4]]);
	});

	test('at most CARD_POINTS_MAX points, the oldest dropped', () => {
		let points = [];

		for (let week = 0; week < CARD_POINTS_MAX + 10; week++) {
			points = addCardPoint(points, {date: day(week * 7), prices: {Normal: [1, null]}, rates: [null, null]});
		}

		assert.equal(points.length, CARD_POINTS_MAX);
		assert.equal(points[0].date, day(70));
	});

	test('cardSeries takes TCGplayer in reais at each point\'s own rate', () => {
		const points = [
			{date: '2026-11-02', prices: {Holo: [10, 8]}, rates: [5, 6]},
			{date: '2026-11-09', prices: {Holo: [12, 9]}, rates: [null, null]},
		];
		const series = cardSeries(points, {euLabel: 'Holo', euroRates: {brlPerEur: 7}, rates: {brlPerUsd: 4}, usLabel: 'Holo'});

		assert.equal(series.market, 'tcgplayer');
		assert.equal(series.label, 'Holo');
		// The second point had no rate of its own, so today's stands in.
		assert.deepEqual(series.points, [{brl: 50, date: '2026-11-02'}, {brl: 48, date: '2026-11-09'}]);
	});

	test('cardSeries falls back to Cardmarket, and needs two points', () => {
		const points = [
			{date: '2026-11-02', prices: {Holo: [null, 8]}, rates: [5, 6]},
			{date: '2026-11-09', prices: {Holo: [12, 9]}, rates: [5, 6]},
		];

		assert.deepEqual(cardSeries(points, {euLabel: 'Holo', usLabel: 'Holo'}).points, [{brl: 48, date: '2026-11-02'}, {brl: 54, date: '2026-11-09'}]);
		assert.equal(cardSeries(points.slice(1), {euLabel: 'Holo', usLabel: 'Holo'}), null);
		assert.equal(cardSeries(points, {euLabel: 'Normal', usLabel: 'Normal'}), null, 'another finish has none');
	});
});
