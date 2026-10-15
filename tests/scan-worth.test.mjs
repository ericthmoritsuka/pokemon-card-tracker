// What a scanned card is worth (js/scan/worth.js): the valuable card
// highlight and the rising price mark, on made-up records and rates (no
// TCGdex, no frankfurter).
// Run: node --test tests/scan-worth.test.mjs

import assert from 'node:assert/strict';
import test, {describe} from 'node:test';

import {riseThreshold, risingBy} from '../js/prices.js';
import {cleanThreshold, risePercent, saveWorthSetting, scanWorth, WORTH_DEFAULTS, worthSettings} from '../js/scan/worth.js';

const RATES = {brlPerUsd: 5, date: '2026-10-15'};
const EUR = {brlPerEur: 6, date: '2026-10-15'};

// A card with a normal print at US$ 4 and a reverse holo at US$ 12, and
// Cardmarket's normal trend at 3 euros rising (7 day 3.6 against 30 day
// 3.0) and reverse trend at 9 euros steady.
const record = (fields = {}) => ({
	id: 'sv08.5-001',
	variants_detailed: [
		{pricing: {
			cardmarket: {avg30: 3, avg7: 3.6, 'avg30-holo': 9, 'avg7-holo': 9.1, idProduct: 1, trend: 3, 'trend-holo': 9, unit: 'EUR', updated: '2026-10-14'},
			tcgplayer: {normal: {marketPrice: 4, productId: 7}, 'reverse-holofoil': {marketPrice: 12, productId: 7}, unit: 'USD', updated: '2026-10-14'},
		}, size: 'standard', type: 'normal', variantId: 'n1'},
		{pricing: {
			cardmarket: {avg30: 3, avg7: 3.6, 'avg30-holo': 9, 'avg7-holo': 9.1, idProduct: 1, trend: 3, 'trend-holo': 9, unit: 'EUR', updated: '2026-10-14'},
			tcgplayer: {normal: {marketPrice: 4, productId: 7}, 'reverse-holofoil': {marketPrice: 12, productId: 7}, unit: 'USD', updated: '2026-10-14'},
		}, size: 'standard', type: 'reverse', variantId: 'r1'},
	],
	...fields,
});

const item = (variantId, fields = {}) => ({card: {catalog: 'international', id: 'sv08.5-001', lang: 'en'}, language: 'pt', variantId, ...fields});

describe('a scanned card\'s worth', () => {
	test('the US price for its finish in reais, against the threshold', () => {
		assert.deepEqual(scanWorth(item('r1'), record(), {eurRates: EUR, min: 50, rates: RATES}), {brl: 60, change: 0.0111, rising: false, source: 'tcgplayer', valuable: true});
		assert.equal(scanWorth(item('n1'), record(), {min: 50, rates: RATES}).brl, 20);
		assert.equal(scanWorth(item('n1'), record(), {min: 50, rates: RATES}).valuable, false);
		assert.equal(scanWorth(item('n1'), record(), {min: 20, rates: RATES}).valuable, true, 'at the threshold counts');
		assert.equal(scanWorth(item('r1'), record(), {min: null, rates: RATES}).valuable, false, 'the highlight off');
	});

	test('Cardmarket\'s trend price when there is no US price or dollar rate', () => {
		const worth = scanWorth(item('n1'), record(), {eurRates: EUR, min: 15});

		assert.equal(worth.source, 'cardmarket');
		assert.equal(worth.brl, 18);
		assert.equal(worth.valuable, true);
	});

	test('no price is never valuable, and Asian prints have none', () => {
		assert.deepEqual(scanWorth(item('n1'), record(), {min: 1}), {brl: null, change: 0.2, rising: true, source: null, valuable: false});
		assert.equal(scanWorth(item('r1', {language: 'ja'}), record(), {min: 1, rates: RATES}).brl, null);
		assert.equal(scanWorth(item('r1', {card: {catalog: 'ko', id: 'x', lang: 'ko'}}), record(), {min: 1, rates: RATES}).brl, null);
		assert.equal(scanWorth(item('r1'), null, {min: 1, rates: RATES}).brl, null);
		assert.equal(scanWorth({card: null}, record(), {min: 1, rates: RATES}).brl, null);
	});

	test('rising: the 7 day average up on the 30 day one by the rise threshold', () => {
		const worth = scanWorth(item('n1'), record(), {eurRates: EUR, rates: RATES, rise: 15});

		assert.equal(worth.change, 0.2);
		assert.equal(worth.rising, true);
		assert.equal(risePercent(worth.change), 20);
		assert.equal(scanWorth(item('n1'), record(), {eurRates: EUR, rates: RATES, rise: 25}).rising, false);
		assert.equal(scanWorth(item('n1'), record(), {eurRates: EUR, rates: RATES, rise: null}).rising, false, 'the mark off');
		assert.equal(scanWorth(item('r1'), record(), {eurRates: EUR, rates: RATES, rise: 15}).rising, false, 'the reverse holo is steady');
	});

	test('a threshold typed in Scan', () => {
		assert.deepEqual(WORTH_DEFAULTS, {chime: false, min: 50, rise: 15});
		assert.equal(cleanThreshold('50'), 50);
		assert.equal(cleanThreshold('12,6'), 13);
		assert.equal(cleanThreshold(''), null);
		assert.equal(cleanThreshold('0'), null);
		assert.equal(cleanThreshold('abc'), null);
		assert.equal(cleanThreshold(500, {max: 100}), null);
	});

	test('the settings kept on the phone', () => {
		const kept = new Map();
		const store = {getItem: (key) => (kept.has(key) ? kept.get(key) : null), setItem: (key, value) => kept.set(key, String(value))};

		assert.deepEqual(worthSettings(store), {chime: false, min: 50, rise: 15}, 'the defaults');
		saveWorthSetting('min', 120, store);
		saveWorthSetting('rise', null, store);
		saveWorthSetting('chime', true, store);
		assert.deepEqual(worthSettings(store), {chime: true, min: 120, rise: null});
		assert.equal(riseThreshold(store), null);
		saveWorthSetting('min', null, store);
		saveWorthSetting('rise', 30, store);
		assert.deepEqual(worthSettings(store), {chime: true, min: null, rise: 30});
		assert.deepEqual(worthSettings({getItem: () => {
			throw new Error('blocked');
		}}), {chime: false, min: 50, rise: 15}, 'storage out of reach');
	});

	test('a trend up by the threshold', () => {
		assert.deepEqual(risingBy({change: 0.18, direction: 'rising'}, 15), {percent: 18, rising: true});
		assert.deepEqual(risingBy({change: 0.12, direction: 'rising'}, 15), {percent: 12, rising: false});
		assert.deepEqual(risingBy({change: -0.3, direction: 'falling'}, 15), {percent: null, rising: false});
		assert.deepEqual(risingBy({change: 0.5, direction: 'rising'}, null), {percent: null, rising: false});
	});
});
