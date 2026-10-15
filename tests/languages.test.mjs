// The one language table (js/languages.js) and the list-language rules
// built on it (js/checklists.js). Node only, no browser and no network.

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {
	ASIAN_LANGUAGES,
	CATALOGS,
	CATALOG_LANGUAGES,
	LANGUAGES,
	LANGUAGE_CODES,
	LIST_LANGUAGE_CODES,
	MONPRICE_REGIONS,
	NAME_TABLES,
	NEW_LIST_LANGUAGES,
	POKEAPI_NAME_TABLES,
	catalogFor,
	catalogLanguage,
	catalogsOf,
	copyLanguageCodes,
	countsOnList,
	hasLiga,
	hasMarketPrices,
	htmlLang,
	isAsian,
	isCatalogLanguage,
	languageChip,
	languageLabel,
	listLanguagesToSave,
	monpriceLanguage,
	namesListLanguages,
	sortLanguages,
} from '../js/languages.js';
import {listByDex, listLanguages} from '../js/checklists.js';
import {copiesByPrint} from '../js/pokemon-cards.js';

describe('the table', () => {
	test('one row per code, every row complete', () => {
		assert.equal(new Set(LANGUAGE_CODES).size, LANGUAGES.length);

		for (const row of LANGUAGES) {
			for (const field of ['code', 'label', 'flag', 'chip', 'html', 'catalog']) {
				assert.equal(typeof row[field], 'string', `${row.code} ${field}`);
			}

			assert.ok(Array.isArray(row.monprice.language) && row.monprice.language.length, `${row.code} monprice`);
			assert.ok(CATALOGS.includes(row.catalog), `${row.code} catalog`);
		}
	});

	test('Portuguese and English first, then the Asian languages, then French, German, Italian, and Spanish', () => {
		assert.deepEqual(LANGUAGE_CODES, ['pt', 'en', 'ja', 'ko', 'zh-cn', 'zh-tw', 'fr', 'de', 'it', 'es']);
		assert.deepEqual(sortLanguages(['nl', 'fr', 'ko', 'de', 'en', 'pt']), ['pt', 'en', 'ko', 'fr', 'de', 'nl']);
	});

	test('German, Spanish, and Italian are copies\' languages but not catalogs', () => {
		assert.deepEqual(CATALOG_LANGUAGES.map((row) => row.code), ['pt', 'en', 'ja', 'ko', 'zh-cn', 'zh-tw', 'fr']);

		for (const code of ['de', 'es', 'it']) {
			assert.equal(isCatalogLanguage(code), false, code);
			assert.equal(catalogFor(code), 'international', code);
		}
	});
});

describe('display', () => {
	test('every language has a name, and nothing shows a raw code or "null"', () => {
		assert.equal(languageLabel('de'), 'German');
		assert.equal(languageLabel('es'), 'Spanish');
		assert.equal(languageLabel('it'), 'Italian');
		assert.equal(languageLabel('zh-tw'), 'Chinese (Traditional)');
		assert.equal(languageLabel(null), 'Language not set');
		assert.equal(languageLabel(undefined), 'Language not set');
		assert.equal(languageLabel('nl'), 'nl', 'an unknown code stays as it is');
	});

	test('chips and lang attributes', () => {
		assert.equal(languageChip('zh-cn'), 'CHS');
		assert.equal(languageChip('zh-tw'), 'CHT');
		assert.equal(languageChip('pt'), 'PT');
		assert.equal(languageChip('nl'), 'NL');
		assert.equal(htmlLang('zh-cn'), 'zh-Hans');
		assert.equal(htmlLang('zh-tw'), 'zh-Hant');
		assert.equal(htmlLang('ja'), 'ja');
	});
});

describe('catalogs', () => {
	test('Western prints share the international records; Asian prints have their own', () => {
		assert.deepEqual(ASIAN_LANGUAGES, ['ja', 'ko', 'zh-cn', 'zh-tw']);
		assert.deepEqual(CATALOGS, ['international', 'ja', 'ko', 'zh-cn', 'zh-tw']);
		assert.equal(catalogFor('pt'), 'international');
		assert.equal(catalogFor('ko'), 'ko');
		assert.equal(catalogFor(null), 'international');
		assert.equal(catalogLanguage('international'), 'en');
		assert.equal(catalogLanguage('zh-cn'), 'zh-cn');
		assert.equal(isAsian('ja'), true);
		assert.equal(isAsian('fr'), false);
	});

	test('a Korean copy can sit on a Japanese record', () => {
		assert.deepEqual(catalogsOf('ko'), ['ko', 'ja']);
		assert.deepEqual(catalogsOf('pt'), ['international']);
		assert.deepEqual(copyLanguageCodes('ja'), ['ja', 'ko']);
		assert.deepEqual(copyLanguageCodes('ko'), ['ko']);
		assert.deepEqual(copyLanguageCodes('international'), ['pt', 'en', 'fr', 'de', 'it', 'es']);
		assert.deepEqual(copyLanguageCodes('custom'), LANGUAGE_CODES);
	});

	test('names: the PokeAPI tables the app reads', () => {
		assert.deepEqual(NAME_TABLES, {ja: 'ja', ko: 'ko', 'zh-cn': 'zh-hans', 'zh-tw': 'zh-hant'});
		assert.deepEqual(POKEAPI_NAME_TABLES, {3: 'ko', 4: 'zh-hant', 9: 'en', 11: 'ja', 12: 'zh-hans'});
	});
});

describe('monprice', () => {
	test('the Language column, in any case', () => {
		const expected = {chs: 'zh-cn', cht: 'zh-tw', de: 'de', en: 'en', es: 'es', fr: 'fr', it: 'it', ja: 'ja', jp: 'ja', ko: 'ko', kr: 'ko', pt: 'pt'};

		for (const [raw, code] of Object.entries(expected)) {
			assert.equal(monpriceLanguage(raw), code, raw);
			assert.equal(monpriceLanguage(raw.toUpperCase()), code, raw.toUpperCase());
		}

		assert.equal(monpriceLanguage('xx'), undefined);
		assert.equal(monpriceLanguage(''), undefined);
	});

	test('the region in a card ID names the catalog, Korean falling back to Japanese', () => {
		assert.deepEqual(MONPRICE_REGIONS, {
			chs: {catalog: 'zh-cn', lang: 'zh-cn'},
			cht: {catalog: 'zh-tw', lang: 'zh-tw'},
			int: {catalog: 'international', lang: 'en'},
			jp: {catalog: 'ja', lang: 'ja'},
			kr: {catalog: 'ko', fallback: {catalog: 'ja', lang: 'ja'}, lang: 'ko'},
		});
	});
});

describe('prices', () => {
	test('Ver na Liga: never for Korean or Chinese prints', () => {
		for (const code of ['ko', 'zh-cn', 'zh-tw']) {
			assert.equal(hasLiga(code), false, code);
		}

		for (const code of ['pt', 'en', 'ja', 'de', null, 'nl']) {
			assert.equal(hasLiga(code), true, String(code));
		}
	});

	test('market prices are for English prints', () => {
		assert.equal(hasMarketPrices('en'), true);
		assert.equal(hasMarketPrices('pt'), false);
		assert.equal(hasMarketPrices(null), false);
	});
});

describe('list languages', () => {
	const copy = (id, language, card = 'sv03.5-039') => ({card_id: card, catalog: 'international', deleted_at: null, id, language});

	test('ticking every language saves as Any language', () => {
		assert.equal(listLanguagesToSave(LIST_LANGUAGE_CODES), null);
		assert.equal(listLanguagesToSave([...LIST_LANGUAGE_CODES].reverse()), null);
		assert.equal(listLanguagesToSave(null), null);
		assert.deepEqual(listLanguagesToSave(['en', 'pt', 'pt', 'de']), ['pt', 'en'], 'once each, in order, list languages only');
		assert.deepEqual(listLanguagesToSave(LIST_LANGUAGE_CODES.slice(1)), LIST_LANGUAGE_CODES.slice(1));
	});

	test('a new list starts with Portuguese', () => {
		assert.deepEqual(NEW_LIST_LANGUAGES, ['pt']);
	});

	test('a list with no languages counts every copy: de, es, it, and no language too', () => {
		const old = {kind: 'region', target: 'kanto'};

		assert.equal(namesListLanguages(old), false);

		for (const language of ['pt', 'de', 'es', 'it', null, undefined]) {
			assert.equal(countsOnList(old, copy('a', language)), true, String(language));
		}
	});

	test('a list that names languages counts only copies in them', () => {
		const pt = {languages: ['pt']};

		assert.equal(countsOnList(pt, copy('a', 'pt')), true);
		assert.equal(countsOnList(pt, copy('b', 'en')), false);
		assert.equal(countsOnList(pt, copy('c', null)), false);
		assert.deepEqual(listLanguages(pt), ['pt']);
	});

	test('a list\'s ticks: listByDex keeps the copies in its languages', () => {
		const byDex = new Map([
			[39, [copy('a', 'pt'), copy('b', 'en')]],
			[25, [copy('c', 'de')]],
			[1, [copy('d', null)]],
		]);

		assert.equal(listByDex({}, byDex), byDex, 'a list with no languages ticks from every copy');
		assert.equal(listByDex({languages: []}, byDex), byDex);

		const pt = listByDex({languages: ['pt']}, byDex);

		assert.deepEqual([...pt.keys()], [39]);
		assert.deepEqual(pt.get(39).map((entry) => entry.id), ['a']);
		assert.equal(listByDex({languages: ['pt']}, byDex), pt, 'worked out once per languages');

		const ptEn = listByDex({languages: ['en', 'pt']}, byDex);

		assert.deepEqual(ptEn.get(39).map((entry) => entry.id), ['a', 'b']);
		assert.equal(listByDex({languages: ['pt']}, null), null);
	});

	test('the Pokémon screen counts the same copies as the ticks', () => {
		const entries = [copy('a', 'pt'), copy('b', 'de', 'swsh3-67'), copy('c', null, 'xy1-87')];

		assert.equal(copiesByPrint(entries, null).size, 3, 'a list with no languages counts de and no-language copies');
		assert.deepEqual([...copiesByPrint(entries, listLanguages({languages: ['pt']})).keys()], ['international|sv03.5-039']);
	});
});
