// Unit tests for js/prices.js. Run: node --test tests/prices.test.mjs
//
// The card records in tests/prices-fixtures are real TCGdex responses saved
// on 2026-10-01: en/cards/sv08.5-001 (Exeggcute, with its Poké Ball and
// Master Ball reverses), en/cards/base1-4 (Base Set Charizard),
// pt/cards/sv08.5-001 and pt/cards/me01-001 (Portuguese records), and
// en/cards/neo1-9 (Lugia, 1st Edition and Unlimited).

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {describe, test} from 'node:test';

import {
	ageText,
	cardmarketTrend,
	cleanManualPrice,
	copyValue,
	EURO_RATES_URL,
	EURO_RATES_URL_V1,
	euroRates,
	eurToBrl,
	exchangeRates,
	extractPrices,
	finishOf,
	formatBrl,
	formatBrlCompact,
	listStats,
	manualPrice,
	MANUAL_MAX_BRL,
	parseBrl,
	parseEuroRates,
	parseRates,
	RATES_URL,
	RATES_URL_V1,
	roundCents,
	savedEuroRates,
	savedRates,
	tileValue,
	TREND_MIN_BRL,
	usdToBrl,
	usStyleAmount,
	valueOf,
} from '../js/prices.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./prices-fixtures/${name}.json`, import.meta.url), 'utf8'));

const EXEGGCUTE = fixture('en-sv08.5-001');
const EXEGGCUTE_PT = fixture('pt-sv08.5-001');
const CHARIZARD = fixture('en-base1-4');
const BULBASAUR_PT = fixture('pt-me01-001');
const LUGIA = fixture('en-neo1-9');

const V = {
	masterball: '2asus05yghmpd1ud1sdmlq3as4e',
	normal: 'endfynwn4n10gzq',
	pokeball: '3739bbtj3i910y5ynn9xc6ryf',
	reverse: 'cm4kqul3x1bwlz1f',
};

const RATES = {brlPerUsd: 5.1877, date: '2026-10-01', fetchedAt: 0, fresh: true};
const EURO = {brlPerEur: 5.8814, date: '2026-10-01', fetchedAt: 0, fresh: true};

// Intl writes a no-break space after the currency symbol.
const plain = (text) => String(text).replace(/ /g, ' ');

const entry = (fields) => ({card_id: 'sv08.5-001', catalog: 'international', deleted_at: null, id: fields.id || 'e', language: 'en', variant_id: null, ...fields});

function memoryStorage(initial = {}) {
	const data = new Map(Object.entries(initial));

	return {
		data,
		getItem: (key) => (data.has(key) ? data.get(key) : null),
		setItem: (key, value) => data.set(key, String(value)),
	};
}

const answer = (body, ok = true) => async () => ({json: async () => body, ok, status: ok ? 200 : 503});

describe('extractPrices', () => {
	test('gives each finish of sv08.5-001 its own TCGplayer block', () => {
		const finishes = extractPrices(EXEGGCUTE);
		const byId = new Map(finishes.map((finish) => [finish.variantId, finish]));

		assert.deepEqual(finishes.map((finish) => finish.label), [
			'Normal',
			'Reverse holo',
			'Reverse holo, Poké Ball pattern',
			'Reverse holo, Master Ball pattern',
		]);

		// Normal and reverse share product 610356 and are told apart by the
		// finish word.
		assert.equal(byId.get(V.normal).tcgplayer.key, 'normal');
		assert.equal(byId.get(V.normal).tcgplayer.marketPrice, 0.05);
		assert.equal(byId.get(V.reverse).tcgplayer.key, 'reverse-holofoil');
		assert.equal(byId.get(V.reverse).tcgplayer.marketPrice, 0.22);

		// The ball reverses are their own products with only a holofoil block.
		assert.equal(byId.get(V.pokeball).tcgplayer.key, 'holofoil');
		assert.equal(byId.get(V.pokeball).tcgplayer.productId, 610536);
		assert.equal(byId.get(V.pokeball).tcgplayer.marketPrice, 0.3);
		assert.equal(byId.get(V.masterball).tcgplayer.productId, 610637);
		assert.equal(byId.get(V.masterball).tcgplayer.marketPrice, 1.3);

		for (const finish of finishes) {
			assert.equal(finish.tcgplayer.date, '2026-09-30');
			assert.equal(finish.tcgplayer.unit, 'USD');
			assert.deepEqual(finish.shared, []);
		}
	});

	test('reads Cardmarket reverse prices from the -holo fields, and 0 as missing', () => {
		const byId = new Map(extractPrices(EXEGGCUTE).map((finish) => [finish.variantId, finish]));

		assert.equal(byId.get(V.normal).cardmarket.trend, 0.03);
		assert.equal(byId.get(V.reverse).cardmarket.trend, 0.11);
		// Master Ball: trend 0 and avg7 null on the plain fields; 2.06 on -holo.
		assert.equal(byId.get(V.masterball).cardmarket.trend, 2.06);
		assert.equal(byId.get(V.masterball).cardmarket.avg, 1.96);
	});

	test('keeps base1-4 printings without a TCGplayer price missing', () => {
		const finishes = extractPrices(CHARIZARD);

		assert.deepEqual(finishes.map((finish) => [finish.label, finish.tcgplayer && finish.tcgplayer.marketPrice]), [
			['Holo, Unlimited', 944.53],
			['Holo, Shadowless, 1st Edition stamp', null],
			['Holo, Shadowless', null],
			['Holo, 1999-2000 copyright', null],
		]);
		// The 1999-2000 copyright printing has no pricing at all.
		assert.equal(finishes[3].cardmarket, null);
		// Holo, not reverse: the plain Cardmarket fields.
		assert.equal(finishes[0].cardmarket.trend, 596.13);
	});

	test('separates 1st Edition and Unlimited on neo1-9 by finish word', () => {
		const [unlimited, first] = extractPrices(LUGIA);

		assert.equal(unlimited.tcgplayer.key, 'unlimited-holofoil');
		assert.equal(unlimited.tcgplayer.marketPrice, 531.39);
		assert.equal(first.tcgplayer.key, '1st-edition-holofoil');
		assert.equal(first.tcgplayer.marketPrice, 1134.85);
	});

	test('reads a Portuguese record, whose variant words are localized', () => {
		const english = extractPrices(EXEGGCUTE);
		const portuguese = extractPrices(EXEGGCUTE_PT);

		assert.deepEqual(portuguese.map((finish) => finish.label), english.map((finish) => finish.label));
		assert.deepEqual(portuguese.map((finish) => finish.tcgplayer.marketPrice), [0.05, 0.22, 0.3, 1.3]);

		const bulbasaur = extractPrices(BULBASAUR_PT);

		assert.equal(bulbasaur[0].tcgplayer.marketPrice, 0.24);
		assert.equal(bulbasaur[1].tcgplayer.marketPrice, 0.36);
		// The league-stamped reverse has no TCGplayer price and stays missing.
		assert.equal(bulbasaur[2].label, 'Reverse holo, League foil, 30th pokeday stamp');
		assert.equal(bulbasaur[2].tcgplayer, null);
	});

	test('falls back to the card-level pricing without variants_detailed', () => {
		const {variants_detailed: _omit, ...bare} = EXEGGCUTE;
		const finishes = extractPrices(bare);

		assert.deepEqual(finishes.map((finish) => [finish.variantId, finish.label, finish.tcgplayer.marketPrice]), [
			[null, 'Normal', 0.05],
			[null, 'Reverse holo', 0.22],
		]);
		assert.equal(finishes[1].cardmarket.trend, 0.11);
	});

	test('marks finishes that share one TCGplayer block', () => {
		const block = {marketPrice: 10, productId: 1};
		const card = {
			variants_detailed: [
				{pricing: {tcgplayer: {holofoil: block, unit: 'USD'}}, type: 'holo', variantId: 'a'},
				{pricing: {tcgplayer: {holofoil: block, unit: 'USD'}}, subtype: 'shadowless', type: 'holo', variantId: 'b'},
			],
		};

		assert.deepEqual(extractPrices(card).map((finish) => finish.shared), [['Holo, Shadowless'], ['Holo']]);
	});

	test('gives nothing for a card with no pricing', () => {
		assert.deepEqual(extractPrices(null), []);
		assert.deepEqual(extractPrices({id: 'x'}), []);
		assert.deepEqual(extractPrices({pricing: {tcgplayer: null}}), []);
	});
});

describe('Cardmarket per finish', () => {
	const pick = (card, label) => extractPrices(card).find((finish) => finish.label === label).cardmarket;

	test('a holo card reads the plain fields', () => {
		const unlimited = pick(CHARIZARD, 'Holo, Unlimited');

		assert.deepEqual(
			[unlimited.trend, unlimited.avg1, unlimited.avg7, unlimited.avg30, unlimited.fields, unlimited.date, unlimited.unit],
			[596.13, 180, 1693.86, 815, 'plain', '2026-09-30', 'EUR']
		);
		assert.equal(pick(LUGIA, 'Holo').trend, 676.98);
		assert.equal(pick(LUGIA, 'Holo, 1st Edition stamp').trend, 676.98);
	});

	test('a normal card reads the plain fields and a reverse the -holo ones', () => {
		const normal = pick(EXEGGCUTE, 'Normal');
		const reverse = pick(EXEGGCUTE, 'Reverse holo');
		const pokeball = pick(EXEGGCUTE, 'Reverse holo, Poké Ball pattern');
		const masterball = pick(EXEGGCUTE, 'Reverse holo, Master Ball pattern');

		assert.deepEqual([normal.trend, normal.avg7, normal.avg30, normal.fields], [0.03, 0.02, 0.03, 'plain']);
		assert.deepEqual([reverse.trend, reverse.avg7, reverse.avg30, reverse.fields], [0.11, 0.06, 0.06, 'holo']);
		assert.deepEqual([pokeball.trend, pokeball.avg7, pokeball.avg30, pokeball.productId], [0.28, 0.35, 0.35, 806408]);
		assert.deepEqual([masterball.trend, masterball.avg1, masterball.avg7, masterball.avg30, masterball.productId], [2.06, 1.5, 1.93, 1.86, 806409]);

		// The same on the Portuguese record, whose variant words are localized.
		assert.deepEqual(extractPrices(EXEGGCUTE_PT).map((finish) => finish.cardmarket.trend), [0.03, 0.11, 0.28, 2.06]);
		assert.equal(pick(BULBASAUR_PT, 'Reverse holo, League foil, 30th pokeday stamp').trend, 8.09);
	});

	test('marks finishes that share one Cardmarket price', () => {
		// Base Set Shadowless and 1st Edition Shadowless are one product, 660224.
		assert.deepEqual(pick(CHARIZARD, 'Holo, Shadowless').shared, ['Holo, Shadowless, 1st Edition stamp']);
		assert.deepEqual(pick(CHARIZARD, 'Holo, Unlimited').shared, []);
		assert.deepEqual(pick(LUGIA, 'Holo').shared, ['Holo, 1st Edition stamp']);
		// Normal and reverse share product 805390 but not their fields.
		assert.deepEqual(extractPrices(EXEGGCUTE).map((finish) => finish.cardmarket.shared), [[], [], [], []]);
	});

	test('missing fields stay missing, and 0 is not a price', () => {
		// The Master Ball reverse's plain fields, read as if it were a normal
		// print: avg and the three averages are null and trend is 0.
		const masterball = EXEGGCUTE.variants_detailed.find((variant) => variant.variantId === V.masterball);
		const [asNormal] = extractPrices({variants_detailed: [{...masterball, foil: undefined, type: 'normal'}]});

		assert.deepEqual(
			[asNormal.cardmarket.avg, asNormal.cardmarket.low, asNormal.cardmarket.trend, asNormal.cardmarket.avg1, asNormal.cardmarket.avg7, asNormal.cardmarket.avg30],
			[null, 0.7, null, null, null, null]
		);
		assert.equal(cardmarketTrend(asNormal.cardmarket), null);
		assert.equal(eurToBrl(asNormal.cardmarket.trend, EURO), null);

		// No Cardmarket block at all: no price.
		assert.equal(pick(CHARIZARD, 'Holo, 1999-2000 copyright'), null);
	});

	test('converts euros with the euro rate', () => {
		assert.equal(plain(formatBrl(eurToBrl(596.13, EURO))), 'R$ 3.506,08');
		assert.equal(eurToBrl(596.13, RATES), null, 'a dollar rate does not convert euros');
		assert.equal(eurToBrl(null, EURO), null);
		assert.equal(eurToBrl(0, EURO), null);
		assert.equal(eurToBrl(1, null), null);
	});

	test('never counts toward a value or a total', () => {
		// Shadowless has a Cardmarket price and no TCGplayer one.
		const shadowless = extractPrices(CHARIZARD)[2].variantId;
		const copy = entry({card_id: 'base1-4', variant_id: shadowless});

		assert.deepEqual(copyValue(copy, CHARIZARD, {rates: {...RATES, ...EURO}}), {kind: 'unknown', usd: null});
		assert.equal(listStats([copy], new Map([['international|base1-4', CHARIZARD]]), {rates: {...RATES, ...EURO}}).total, null);
	});
});

describe('cardmarketTrend', () => {
	const trend = (fields) => cardmarketTrend({avg1: null, avg30: null, avg7: null, ...fields});

	test('rises or falls at 5% from the 30 day average, else is steady', () => {
		assert.equal(trend({avg30: 2, avg7: 2.1}).direction, 'rising');
		assert.equal(trend({avg30: 2, avg7: 2.09}).direction, 'steady');
		assert.equal(trend({avg30: 2, avg7: 1.9}).direction, 'falling');
		assert.equal(trend({avg30: 2, avg7: 1.91}).direction, 'steady');
		assert.equal(trend({avg30: 2, avg7: 2}).direction, 'steady');
		assert.deepEqual(trend({avg30: 2, avg7: 2.1}), {avg30: 2, change: 0.05, direction: 'rising', recent: 2.1, recentField: 'avg7'});
	});

	test('reads the real records', () => {
		const pick = (card, label) => cardmarketTrend(extractPrices(card).find((finish) => finish.label === label).cardmarket);

		// 1693.86 against 815.
		assert.equal(pick(CHARIZARD, 'Holo, Unlimited').direction, 'rising');
		// 1821.30 against 2478.82.
		assert.equal(pick(CHARIZARD, 'Holo, Shadowless').direction, 'falling');
		// 0.21 against 0.22 is 4.55% down: steady.
		assert.deepEqual([pick(BULBASAUR_PT, 'Reverse holo').direction, pick(BULBASAUR_PT, 'Reverse holo').change], ['steady', -0.0455]);
		// 1.93 against 1.86 is 3.76% up: steady.
		assert.equal(pick(EXEGGCUTE, 'Reverse holo, Master Ball pattern').direction, 'steady');
	});

	test('needs about R$ 0,50 of difference besides the 5%, so bulk cards read steady', () => {
		const rates = {brlPerEur: 6.25, date: '2026-09-30'};
		const withRate = (fields) => cardmarketTrend({avg1: null, avg30: null, avg7: null, ...fields}, {rates});

		// 0,10 to 0,12 euro is 20% up but R$ 0,13: steady.
		assert.equal(withRate({avg30: 0.1, avg7: 0.12}).direction, 'steady');
		assert.equal(withRate({avg30: 0.1, avg7: 0.12}).change, 0.2, 'the change is still reported');
		assert.equal(withRate({avg30: 0.5, avg7: 0.3}).direction, 'falling', '0,20 euro is R$ 1,25');
		// 0,08 euro is R$ 0,50 at this rate: counts. 0,07 is R$ 0,44: does not.
		assert.equal(withRate({avg30: 1, avg7: 1.08}).direction, 'rising');
		assert.equal(withRate({avg30: 1, avg7: 1.07}).direction, 'steady');
		// Large amounts still need the 5%.
		assert.equal(withRate({avg30: 100, avg7: 104}).direction, 'steady');
		// With no euro rate saved, 0,08 euro stands in for R$ 0,50.
		assert.equal(trend({avg30: 0.1, avg7: 0.15}).direction, 'steady');
		assert.equal(trend({avg30: 1, avg7: 1.08}).direction, 'rising');
		assert.equal(TREND_MIN_BRL, 0.5);
	});

	test('takes the 7 day average, and the 1 day one only without it', () => {
		assert.equal(trend({avg1: 1, avg30: 2, avg7: 2}).recentField, 'avg7');
		assert.deepEqual(trend({avg1: 3, avg30: 2}), {avg30: 2, change: 0.5, direction: 'rising', recent: 3, recentField: 'avg1'});
	});

	test('gives no trend without the averages it needs', () => {
		assert.equal(trend({avg1: 3, avg7: 2}), null);
		assert.equal(trend({avg30: 2}), null);
		assert.equal(trend({avg30: 0, avg7: 2}), null);
		assert.equal(cardmarketTrend(null), null);
	});
});

describe('finishOf', () => {
	const finishes = extractPrices(EXEGGCUTE);

	test('matches by variant ID', () => {
		assert.equal(finishOf(entry({variant_id: V.pokeball}), finishes).variantId, V.pokeball);
	});

	test('matches a monprice finish word only when one finish fits', () => {
		assert.equal(finishOf(entry({finish_raw: 'NORMAL'}), finishes).variantId, V.normal);
		// The plain reverse, not a ball pattern.
		assert.equal(finishOf(entry({finish_raw: 'REVERSE_HOLOFOIL'}), finishes).variantId, V.reverse);
		assert.equal(finishOf(entry({}), finishes), null);
		assert.equal(finishOf(entry({variant_id: 'no-such-variant'}), finishes), null);
	});
});

describe('numbers and money', () => {
	test('rounds to the cent, half away from zero', () => {
		assert.equal(roundCents(1.005), 1.01);
		assert.equal(roundCents(0.3 * 5.1877), 1.56);
		assert.equal(roundCents(-1.005), -1.01);
		assert.equal(roundCents(NaN), null);
		assert.equal(roundCents('1'), null);
	});

	test('converts US dollars with the rate, unrounded until shown', () => {
		assert.equal(usdToBrl(944.53, RATES), 944.53 * 5.1877);
		assert.equal(plain(formatBrl(usdToBrl(944.53, RATES))), 'R$ 4.899,94');
		assert.equal(plain(formatBrl(usdToBrl(0.05, RATES))), 'R$ 0,26');
		assert.equal(usdToBrl(null, RATES), null);
		assert.equal(usdToBrl(1, null), null);
		assert.equal(usdToBrl(0, RATES), null);
	});

	test('formats compactly for tiles', () => {
		assert.equal(plain(formatBrlCompact(45.9)), 'R$ 45,90');
		assert.equal(plain(formatBrlCompact(4899.94)), 'R$ 4.900');
		assert.equal(formatBrlCompact(null), null);
	});

	test('parses amounts typed with a comma or a dot', () => {
		assert.equal(parseBrl('45,90'), 45.9);
		assert.equal(parseBrl('45,9'), 45.9);
		assert.equal(parseBrl('45.90'), 45.9);
		assert.equal(parseBrl('R$ 1.234,56'), 1234.56);
		assert.equal(parseBrl('1.234'), 1234);
		assert.equal(parseBrl('1234'), 1234);
		assert.equal(parseBrl(' 0,5 '), 0.5);
		assert.equal(parseBrl(''), null);
		assert.equal(parseBrl('   '), null);
		assert.ok(Number.isNaN(parseBrl('abc')));
		assert.ok(Number.isNaN(parseBrl('1,2,3')));
		assert.ok(Number.isNaN(parseBrl('0')));
		assert.ok(Number.isNaN(parseBrl('-5')));
	});

	test('refuses a US-style amount instead of reading it a thousand times too small', () => {
		assert.ok(Number.isNaN(parseBrl('1,234.56')), 'not 1.23');
		assert.ok(Number.isNaN(parseBrl('R$ 12,345.00')));
		assert.ok(Number.isNaN(parseBrl('1,234')), 'three digits after the comma are thousands, not cents');
		assert.ok(usStyleAmount('1,234.56'));
		assert.ok(usStyleAmount('1,234'));
		assert.ok(!usStyleAmount('1.234,56'));
		assert.ok(!usStyleAmount('45,90'));
		assert.ok(!usStyleAmount('45.90'));
		assert.equal(parseBrl('1.234,56'), 1234.56, 'the Brazilian way still reads');
	});

	test('says how old a date is', () => {
		const now = new Date(2026, 9, 1, 15, 0);

		assert.equal(ageText('2026-10-01', now), 'today');
		assert.equal(ageText('2026-09-30', now), 'yesterday');
		assert.equal(ageText('2026-09-19', now), '12 days ago');
		assert.equal(ageText('2026-06-01', now), '4 months ago');
		assert.equal(ageText('2024-01-01', now), '2 years ago');
		assert.equal(ageText('2026-10-05', now), null);
		assert.equal(ageText('soon', now), null);
	});
});

describe('manual Liga prices', () => {
	const now = new Date(2026, 9, 1, 12, 0);

	test('cleans what the editor holds', () => {
		assert.deepEqual(cleanManualPrice({avg: '52,3', low_nm: '45,90'}, now), {
			avg: 52.3,
			currency: 'BRL',
			date: '2026-10-01',
			low_nm: 45.9,
			source: 'Liga Pokémon',
		});
		assert.deepEqual(cleanManualPrice({date: '2026-09-19', low_nm: 12, source: '  Feira  '}, now), {
			avg: null,
			currency: 'BRL',
			date: '2026-09-19',
			low_nm: 12,
			source: 'Feira',
		});
		assert.equal(cleanManualPrice({avg: '', low_nm: ''}, now), null);
		assert.throws(() => cleanManualPrice({low_nm: 'abc'}, now), /Lowest NM price/);
		assert.throws(() => cleanManualPrice({avg: '5', date: '01/10/2026'}, now), /date/);
	});

	test('refuses an amount that is a typing slip, and a lowest above the average', () => {
		const field = (fields) => {
			try {
				cleanManualPrice(fields, now);
			}
			catch (err) {
				return [err.field, err.message];
			}

			return null;
		};

		assert.equal(MANUAL_MAX_BRL, 1000000);
		assert.deepEqual(field({avg: '1', low_nm: '99999999999'}), ['low_nm', 'Lowest NM price must be under R$\u00a01.000.000,00. Check for an extra zero.']);
		assert.equal(field({avg: '1.000.000,00'})[0], 'avg', 'the cap itself is refused');
		assert.equal(cleanManualPrice({avg: '999.999,99'}, now).avg, 999999.99);
		assert.deepEqual(field({avg: '40', low_nm: '45,90'}), ['low_nm', 'The lowest NM price cannot be above the average price.']);
		assert.equal(cleanManualPrice({avg: '45,90', low_nm: '45,90'}, now).low_nm, 45.9, 'equal is fine');
		assert.deepEqual(field({low_nm: '1,234.56'}), ['low_nm', 'Lowest NM price: use a comma for cents and dots for thousands, such as 1.234,56.']);
	});

	test('ignores a manual price that is not in reais or holds no amount', () => {
		assert.equal(manualPrice(entry({price_manual: {amount: 5, currency: 'USD'}})), null);
		assert.equal(manualPrice(entry({price_manual: {avg: null, currency: 'BRL', low_nm: null}})), null);
		assert.equal(manualPrice(entry({price_manual: null})), null);
	});

	test('is preferred over the US market price for that copy', () => {
		const copy = entry({price_manual: {avg: 52.3, currency: 'BRL', date: '2026-09-19', low_nm: 45.9, source: 'Liga Pokémon'}, variant_id: V.masterball});

		assert.deepEqual(copyValue(copy, EXEGGCUTE, {rates: RATES}), {brl: 52.3, date: '2026-09-19', field: 'avg', kind: 'liga', source: 'Liga Pokémon'});
		assert.equal(copyValue(copy, EXEGGCUTE, {basis: 'low_nm', rates: RATES}).brl, 45.9);
	});

	test('uses the other Liga field when only one was typed', () => {
		const copy = entry({price_manual: {avg: null, currency: 'BRL', date: '2026-09-19', low_nm: 45.9, source: 'Liga Pokémon'}});

		assert.deepEqual([copyValue(copy, null).kind, copyValue(copy, null).brl, copyValue(copy, null).field], ['liga', 45.9, 'low_nm']);
	});
});

describe('copyValue without a Liga price', () => {
	test('estimates from the TCGplayer market price of the copy\'s finish', () => {
		const value = copyValue(entry({variant_id: V.masterball}), EXEGGCUTE, {rates: RATES});

		assert.equal(value.kind, 'estimate');
		assert.equal(value.usd, 1.3);
		assert.equal(roundCents(value.brl), 6.74);
		assert.equal(value.date, '2026-09-30');
		assert.equal(value.rateDate, '2026-10-01');
	});

	test('stays unknown with no price, never zero', () => {
		const shadowless = extractPrices(CHARIZARD)[1].variantId;

		assert.deepEqual(copyValue(entry({card_id: 'base1-4', variant_id: shadowless}), CHARIZARD, {rates: RATES}), {kind: 'unknown', usd: null});
		assert.deepEqual(copyValue(entry({}), EXEGGCUTE, {rates: RATES}), {kind: 'unknown', usd: null});
		assert.deepEqual(copyValue(entry({variant_id: V.normal}), null, {rates: RATES}), {kind: 'unknown', usd: null});
	});

	test('stays unknown in reais with a US price and no rate', () => {
		assert.deepEqual(copyValue(entry({variant_id: V.normal}), EXEGGCUTE, {rates: null}), {kind: 'unknown', usd: 0.05});
	});
});

describe('exchange rates', () => {
	const DAY = 24 * 60 * 60 * 1000;

	test('reads the v2 and the v1 answers', () => {
		// Shapes as frankfurter answered on 2026-10-01.
		assert.deepEqual(parseRates([{base: 'USD', date: '2026-10-01', quote: 'BRL', rate: 5.1877}]), {brlPerUsd: 5.1877, date: '2026-10-01'});
		assert.deepEqual(parseRates({amount: 1, base: 'USD', date: '2026-10-01', rates: {BRL: 5.1885, EUR: 0.88511}}), {brlPerUsd: 5.1885, date: '2026-10-01'});
		assert.equal(parseRates({message: 'unknown parameter: symbols', status: 422}), null);
		assert.equal(parseRates([]), null);
	});

	test('asks v2 once, then keeps the rate for a day', async () => {
		const storage = memoryStorage();
		const asked = [];
		const fetchFn = async (url) => {
			asked.push(url);

			return answer([{base: 'USD', date: '2026-10-01', quote: 'BRL', rate: 5.1877}])();
		};
		const now = Date.UTC(2026, 9, 1, 12);

		assert.deepEqual(await exchangeRates({fetchFn, now, storage}), {brlPerUsd: 5.1877, date: '2026-10-01', fetchedAt: now, fresh: true});
		assert.deepEqual(asked, [RATES_URL]);
		assert.equal(RATES_URL, 'https://api.frankfurter.dev/v2/rates?base=USD&quotes=BRL');

		await exchangeRates({fetchFn, now: now + DAY - 1, storage});
		assert.equal(asked.length, 1);

		await exchangeRates({fetchFn, now: now + DAY + 1, storage});
		assert.equal(asked.length, 2);
	});

	test('falls back to v1 when v2 fails', async () => {
		const storage = memoryStorage();
		const asked = [];
		const fetchFn = async (url) => {
			asked.push(url);

			return url === RATES_URL ? answer({status: 503}, false)() : answer({base: 'USD', date: '2026-10-01', rates: {BRL: 5.1885}})();
		};
		const rates = await exchangeRates({fetchFn, now: 1, storage});

		assert.deepEqual(asked, [RATES_URL, RATES_URL_V1]);
		assert.equal(rates.brlPerUsd, 5.1885);
	});

	test('works offline with the last rate and its date', async () => {
		const storage = memoryStorage({'cardTracker.rates': JSON.stringify({brlPerUsd: 5.21, date: '2026-09-28', fetchedAt: 0})});
		const offline = async () => {
			throw new TypeError('Failed to fetch');
		};
		const rates = await exchangeRates({fetchFn: offline, now: Date.UTC(2026, 9, 1), storage});

		assert.deepEqual(rates, {brlPerUsd: 5.21, date: '2026-09-28', fetchedAt: 0, fresh: false});
		assert.deepEqual(savedRates(storage), {brlPerUsd: 5.21, date: '2026-09-28', fetchedAt: 0});
	});

	test('gives null offline with nothing saved, and survives broken storage', async () => {
		const offline = async () => {
			throw new TypeError('Failed to fetch');
		};
		const broken = {
			getItem: () => {
				throw new Error('SecurityError');
			},
			setItem: () => {
				throw new Error('QuotaExceededError');
			},
		};

		assert.equal(await exchangeRates({fetchFn: offline, now: 1, storage: memoryStorage()}), null);
		assert.equal(await exchangeRates({fetchFn: offline, now: 1, storage: broken}), null);
		assert.equal(savedRates(broken), null);
		assert.equal(savedRates(memoryStorage({'cardTracker.rates': 'not json'})), null);

		const rates = await exchangeRates({fetchFn: answer([{base: 'USD', date: '2026-10-01', quote: 'BRL', rate: 5.1877}]), now: 1, storage: broken});

		assert.equal(rates.brlPerUsd, 5.1877);
	});
});

describe('euro exchange rate', () => {
	const DAY = 24 * 60 * 60 * 1000;
	const V2 = [{base: 'EUR', date: '2026-10-01', quote: 'BRL', rate: 5.8814}];

	test('reads the v2 and the v1 answers', () => {
		// Shapes as frankfurter answered base=EUR on 2026-10-01.
		assert.deepEqual(parseEuroRates(V2), {brlPerEur: 5.8814, date: '2026-10-01'});
		assert.deepEqual(parseEuroRates({amount: 1, base: 'EUR', date: '2026-10-01', rates: {BRL: 5.862}}), {brlPerEur: 5.862, date: '2026-10-01'});
		// A dollar answer is not a euro rate, and the reverse.
		assert.equal(parseEuroRates([{base: 'USD', date: '2026-10-01', quote: 'BRL', rate: 5.1877}]), null);
		assert.equal(parseRates(V2), null);
		assert.equal(parseEuroRates([]), null);
	});

	test('asks v2 once a day and saves beside the dollar rate', async () => {
		const storage = memoryStorage({'cardTracker.rates': JSON.stringify({brlPerUsd: 5.1877, date: '2026-10-01', fetchedAt: 0})});
		const asked = [];
		const fetchFn = async (url) => {
			asked.push(url);

			return answer(V2)();
		};
		const now = Date.UTC(2026, 9, 1, 12);

		assert.equal(EURO_RATES_URL, 'https://api.frankfurter.dev/v2/rates?base=EUR&quotes=BRL');
		assert.deepEqual(await euroRates({fetchFn, now, storage}), {brlPerEur: 5.8814, date: '2026-10-01', fetchedAt: now, fresh: true});
		assert.deepEqual(asked, [EURO_RATES_URL]);
		assert.deepEqual(savedEuroRates(storage), {brlPerEur: 5.8814, date: '2026-10-01', fetchedAt: now});
		// The dollar rate is untouched.
		assert.deepEqual(savedRates(storage), {brlPerUsd: 5.1877, date: '2026-10-01', fetchedAt: 0});

		await euroRates({fetchFn, now: now + DAY - 1, storage});
		assert.equal(asked.length, 1);

		await euroRates({fetchFn, now: now + DAY + 1, storage});
		assert.equal(asked.length, 2);
	});

	test('falls back to v1 when v2 fails', async () => {
		const asked = [];
		const fetchFn = async (url) => {
			asked.push(url);

			return url === EURO_RATES_URL ? answer({status: 503}, false)() : answer({base: 'EUR', date: '2026-10-01', rates: {BRL: 5.862}})();
		};
		const rates = await euroRates({fetchFn, now: 1, storage: memoryStorage()});

		assert.deepEqual(asked, [EURO_RATES_URL, EURO_RATES_URL_V1]);
		assert.equal(rates.brlPerEur, 5.862);
	});

	test('works offline with the last euro rate and its date', async () => {
		const storage = memoryStorage({'cardTracker.rates.eur': JSON.stringify({brlPerEur: 5.9, date: '2026-09-28', fetchedAt: 0})});
		const offline = async () => {
			throw new TypeError('Failed to fetch');
		};

		assert.deepEqual(await euroRates({fetchFn: offline, now: Date.UTC(2026, 9, 1), storage}), {brlPerEur: 5.9, date: '2026-09-28', fetchedAt: 0, fresh: false});
		// No dollar rate was ever saved, so there is none, not the euro one.
		assert.equal(await exchangeRates({fetchFn: offline, now: Date.UTC(2026, 9, 1), storage}), null);
		assert.equal(await euroRates({fetchFn: offline, now: 1, storage: memoryStorage()}), null);
	});

	test('a failed euro request leaves the dollar rate fresh', async () => {
		const storage = memoryStorage();
		const fetchFn = async (url) => {
			if (url.includes('base=EUR')) {
				throw new TypeError('Failed to fetch');
			}

			return answer([{base: 'USD', date: '2026-10-01', quote: 'BRL', rate: 5.1877}])();
		};
		const [usd, eur] = await Promise.all([exchangeRates({fetchFn, now: 1, storage}), euroRates({fetchFn, now: 1, storage})]);

		assert.equal(usd.brlPerUsd, 5.1877);
		assert.equal(usd.fresh, true);
		assert.equal(eur, null);
	});
});

describe('listStats', () => {
	const liga = (id, avg, low) => entry({id, price_manual: {avg, currency: 'BRL', date: '2026-09-19', low_nm: low, source: 'Liga Pokémon'}, variant_id: V.normal});
	const cards = new Map([
		['international|sv08.5-001', EXEGGCUTE],
		['international|base1-4', CHARIZARD],
	]);
	const shadowless = extractPrices(CHARIZARD)[2].variantId;
	const unlimited = extractPrices(CHARIZARD)[0].variantId;
	const copies = [
		liga('a', 50, 40),
		liga('b', 10, 8),
		entry({id: 'c', variant_id: V.masterball}),
		entry({card_id: 'base1-4', id: 'd', variant_id: unlimited}),
		entry({card_id: 'base1-4', id: 'e', variant_id: shadowless}),
		entry({card_id: 'missing-1', id: 'f'}),
		entry({deleted_at: '2026-09-01T00:00:00Z', id: 'g', variant_id: V.masterball}),
	];

	test('totals Liga prices and US estimates, leaving unknowns out', () => {
		const stats = listStats(copies, cards, {rates: RATES});
		const masterball = 1.3 * 5.1877;
		const charizard = 944.53 * 5.1877;

		assert.equal(stats.count, 6);
		assert.equal(stats.priced, 4);
		assert.deepEqual(stats.liga, {count: 2, total: 60});
		assert.deepEqual(stats.estimate, {count: 2, total: roundCents(masterball + charizard)});
		assert.deepEqual(stats.unknown, {count: 2, noRate: 0});
		assert.equal(stats.total, roundCents(60 + masterball + charizard));
		// Four priced copies, not six: unknowns are not zeros.
		assert.equal(stats.average, roundCents((60 + masterball + charizard) / 4));
		assert.equal(stats.highest.name, 'Charizard');
		assert.equal(stats.highest.kind, 'estimate');
		assert.equal(stats.lowest.name, 'Exeggcute');
		assert.equal(stats.lowest.kind, 'estimate');
		assert.equal(roundCents(stats.lowest.brl), 6.74);
		assert.equal(stats.rateDate, '2026-10-01');
	});

	test('switches the Liga basis to the lowest NM price', () => {
		const stats = listStats(copies.slice(0, 2), cards, {basis: 'low_nm', rates: RATES});

		assert.equal(stats.basis, 'low_nm');
		assert.equal(stats.total, 48);
		assert.equal(stats.average, 24);
	});

	test('counts US prices without a rate as unknown, and says so', () => {
		const stats = listStats(copies, cards, {rates: null});

		assert.deepEqual(stats.unknown, {count: 4, noRate: 2});
		assert.equal(stats.total, 60);
	});

	test('gives no total or average when nothing is priced', () => {
		const stats = listStats([entry({id: 'x'})], cards, {rates: RATES});

		assert.equal(stats.total, null);
		assert.equal(stats.average, null);
		assert.equal(stats.highest, null);
		assert.deepEqual(listStats([], cards).count, 0);
	});

	test('takes card index records and names from their localizations', () => {
		const index = {'international|sv08.5-001': {id: 'sv08.5-001', localizations: {en: {name: 'Exeggcute'}, pt: {name: 'Exeggcute (PT)'}}}};
		const stats = listStats([liga('a', 50, 40), entry({id: 'b', variant_id: V.normal})], index, {rates: RATES});

		assert.equal(stats.highest.name, 'Exeggcute');
		// An index record has no pricing, so the copy without a Liga price is unknown.
		assert.equal(stats.unknown.count, 1);

		const portuguese = listStats([{...liga('a', 50, 40), language: 'pt'}], index, {rates: RATES});

		assert.equal(portuguese.highest.name, 'Exeggcute (PT)');
	});

	test('valueOf gives the honest breakdown', () => {
		const value = valueOf(copies, cards, {rates: RATES});

		assert.equal(value.total, listStats(copies, cards, {rates: RATES}).total);
		assert.deepEqual(value.liga, {count: 2, total: 60});
		assert.equal(value.estimated.count, 2);
		assert.deepEqual(value.unknown, {count: 2});
	});
});

describe('tileValue', () => {
	test('prefers the newest Liga price among the copies', () => {
		const older = entry({id: 'a', price_manual: {avg: 10, currency: 'BRL', date: '2026-09-01', low_nm: null, source: 'Liga Pokémon'}});
		const newer = entry({id: 'b', price_manual: {avg: 12, currency: 'BRL', date: '2026-09-20', low_nm: null, source: 'Liga Pokémon'}});
		const value = tileValue([older, newer, entry({id: 'c', variant_id: V.masterball})], EXEGGCUTE, {rates: RATES});

		assert.deepEqual([value.kind, value.brl], ['liga', 12]);
	});

	test('falls back to the US estimate, then to nothing', () => {
		assert.equal(tileValue([entry({variant_id: V.reverse})], EXEGGCUTE, {rates: RATES}).kind, 'estimate');
		assert.equal(tileValue([entry({})], EXEGGCUTE, {rates: RATES}), null);
		assert.equal(tileValue([entry({variant_id: V.reverse})], EXEGGCUTE, {rates: null}), null);
		assert.equal(tileValue([], EXEGGCUTE, {rates: RATES}), null);
	});
});
