// Pokédex numbers for cards TCGdex gives none (js/names.js dexFromName,
// dexFromNames): Eric's Japanese Latias, SV7a-019 ラティアスex, and his
// hand-made Chinese Relicanth (2026-11-24) were left off his Hoenn list
// because a checklist counts a copy by its card's Pokédex numbers. The names
// below are PokeAPI's (checked 2026-11-24); every other number is blank.
//
// Run: node --test tests/dex-from-name.test.mjs
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {dexFromName, dexFromNames, resolvePokemon} from '../js/names.js';

const SPECIES = {
	25: {en: 'Pikachu', ja: 'ピカチュウ', 'zh-hans': '皮卡丘', 'zh-hant': '皮卡丘'},
	133: {en: 'Eevee', ja: 'イーブイ', 'zh-hans': '伊布', 'zh-hant': '伊布'},
	369: {en: 'Relicanth', ja: 'ジーランス', ko: '시라칸', 'zh-hans': '古空棘鱼', 'zh-hant': '古空棘魚'},
	445: {en: 'Garchomp', ja: 'ガブリアス', 'zh-hans': '烈咬陆鲨', 'zh-hant': '烈咬陸鯊'},
	380: {en: 'Latias', ja: 'ラティアス', ko: '라티아스', 'zh-hans': '拉帝亚斯', 'zh-hant': '拉帝亞斯'},
	470: {en: 'Leafeon', ja: 'リーフィア', 'zh-hans': '叶伊布', 'zh-hant': '葉伊布'},
	646: {en: 'Kyurem', ja: 'キュレム', 'zh-hans': '酋雷姆', 'zh-hant': '酋雷姆'},
	778: {en: 'Mimikyu', ja: 'ミミッキュ', 'zh-hans': '谜拟Ｑ', 'zh-hant': '謎擬Ｑ'},
	901: {en: 'Ursaluna', ja: 'ガチグマ', 'zh-hans': '月月熊', 'zh-hant': '月月熊'},
	939: {en: 'Bellibolt', ja: 'ハラバリー', 'zh-hans': '电肚蛙', 'zh-hant': '電肚蛙'},
};

function tables(species = SPECIES) {
	const out = {};

	for (const language of ['en', 'ja', 'ja-roma', 'ko', 'zh-hans', 'zh-hant']) {
		out[language] = Array(1026).fill(null);

		for (const [n, names] of Object.entries(species)) {
			out[language][Number(n)] = names[language] || null;
		}
	}

	return out;
}

const TABLES = tables();
const dex = (lang, name, category = 'Pokemon') => dexFromName({category, lang, name}, TABLES);

describe('dexFromName', () => {
	test('Eric\'s Latias, SV7a-019 ラティアスex, is #380, and so are SV7a-078 and -087', () => {
		assert.deepEqual(dex('ja', 'ラティアスex'), [380]);
	});

	test('Eric\'s Cynthia\'s Garchomp: SV9a-044 シロナのガブリアスex, and SV3a-006 ガブリアスex, S9a-054 ガブリアスV, are #445', () => {
		assert.deepEqual(dex('ja', 'シロナのガブリアスex'), [445]);
		assert.deepEqual(dex('ja', 'ガブリアスex'), [445]);
		assert.deepEqual(dex('ja', 'ガブリアスV'), [445]);
		assert.deepEqual(dex('zh-tw', '<竹蘭的>烈咬陸鯊ex'), [445], 'SV9a-044 in Chinese');
	});

	test('a Pokémon that is not Latias: a trainer\'s, a form, a Mimikyu after a Latin Q', () => {
		assert.deepEqual(dex('ja', 'ナンジャモのハラバリーex'), [939], 'Iono\'s Bellibolt ex');
		assert.deepEqual(dex('zh-tw', '奇樹的電肚蛙ex'), [939], 'the same card in Chinese');
		assert.deepEqual(dex('zh-tw', '<阿響的>電肚蛙ex'), [939], 'a trainer in brackets');
		assert.deepEqual(dex('ja', 'ガチグマ アカツキex'), [901], 'Bloodmoon Ursaluna ex');
		assert.deepEqual(dex('ja', 'ブラックキュレムex'), [646], 'Black Kyurem ex, SV7a-011');
		assert.deepEqual(dex('zh-tw', '闇黑酋雷姆ex'), [646]);
		assert.deepEqual(dex('zh-tw', '謎擬Ｑex'), [778]);
		assert.deepEqual(dex('ja', 'ラティアス（デルタ種）'), [380], 'a delta species');
	});

	test('Chinese: SC2a-043 古空棘魚 is #369; a zh-cn record in Traditional script is read too', () => {
		assert.deepEqual(dex('zh-tw', '古空棘魚'), [369]);
		assert.deepEqual(dex('zh-cn', '古空棘鱼'), [369]);
		assert.deepEqual(dex('zh-cn', '拉帝亞斯ex'), [380], 'TCGdex zh-cn SV7a-019');
		assert.deepEqual(dex('zh-cn', '葉伊布'), [470], 'Leafeon, never the Eevee its name ends with');
	});

	test('Korean', () => {
		assert.deepEqual(dex('ko', '라티아스 ex'), [380]);
	});

	test('nothing for a name that is no species, a Trainer, or a form before the species', () => {
		assert.deepEqual(dex('ja', '埋もれた化石'), [], 'Buried Fossil, E4-070');
		assert.deepEqual(dex('ja', 'ラティアス', 'Trainer'), []);
		assert.deepEqual(dex('zh-tw', '衝浪皮卡丘V'), [], 'Surfing Pikachu V: not read from its ending');
		assert.deepEqual(dex('ja', 'ラティアスex'.slice(1)), []);
		assert.deepEqual(dexFromName({lang: 'ja', name: 'ラティアスex'}, null), [], 'no tables yet');
	});

	test('never a guess between two species that share a name', () => {
		const shared = tables({...SPECIES, 381: {en: 'Latios', ja: 'ラティアス'}});

		assert.deepEqual(dexFromName({category: 'Pokemon', lang: 'ja', name: 'ラティアスex'}, shared), []);
	});

	test('resolvePokemon still gives the English name alone', () => {
		assert.deepEqual(resolvePokemon({lang: 'ja', name: 'ブラックキュレムex'}, TABLES), {english: 'Black Kyurem ex', prefixes: [], reading: null, suffix: 'ex'});
	});
});

describe('dexFromNames, for a hand-made card', () => {
	test('Eric\'s hand-made Relicanth: its Chinese or its English name', () => {
		assert.deepEqual(dexFromNames('古空棘鱼', ['zh-cn'], TABLES), [369]);
		assert.deepEqual(dexFromNames('Relicanth', ['zh-cn'], TABLES), [369]);
		assert.deepEqual(dexFromNames('Latias ex', ['pt'], TABLES), [380]);
		assert.deepEqual(dexFromNames('Cynthia\'s Garchomp ex', ['en'], TABLES), [445], 'a trainer\'s name is never read as the Pokémon');
	});

	test('nothing when no reading finds a species, or two readings disagree', () => {
		assert.deepEqual(dexFromNames('Gem Pack', ['zh-cn'], TABLES), []);

		const crossed = tables({...SPECIES, 381: {en: 'Latios', ja: 'Relicanth'}});

		assert.deepEqual(dexFromNames('Relicanth', ['ja'], crossed), []);
	});
});
