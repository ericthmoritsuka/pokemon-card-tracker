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
	cleanManualPrice,
	copyValue,
	exchangeRates,
	extractPrices,
	finishOf,
	formatBrl,
	formatBrlCompact,
	listStats,
	manualPrice,
	parseBrl,
	parseRates,
	RATES_URL,
	RATES_URL_V1,
	roundCents,
	savedRates,
	tileValue,
	usdToBrl,
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
