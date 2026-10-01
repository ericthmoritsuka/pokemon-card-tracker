// Tests for English names and readings of Asian prints (js/names.js), the
// species names request (js/checklists.js), and the language flags
// (js/flags.js). Node only, no browser and no network.
//
// Run: node tests/names.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {speciesNamesQuery, speciesTablesFrom} from '../js/checklists.js';
import {FLAGS, MAX_FLAGS, flagPlan} from '../js/flags.js';
import {cardNames, cardSearchTerms, hepburn, resolvePokemon, romanizeKorean, searchKey, speciesSearchTerms, stripSuffix} from '../js/names.js';

// Species names as PokeAPI gives them (checked 2026-10-01), for the few
// species these tests use.
const SPECIES = {
	6: {en: 'Charizard', ja: 'リザードン', 'ja-roma': 'Lizardon', ko: '리자몽', 'zh-hans': '喷火龙', 'zh-hant': '噴火龍'},
	25: {en: 'Pikachu', ja: 'ピカチュウ', 'ja-roma': 'Pikachu', ko: '피카츄', 'zh-hans': '皮卡丘', 'zh-hant': '皮卡丘'},
	29: {en: 'Nidoran♀', ja: 'ニドラン♀', 'ja-roma': 'Nidoran♀', ko: '니드런♀', 'zh-hans': '尼多兰', 'zh-hant': '尼多蘭'},
	37: {en: 'Vulpix', ja: 'ロコン', 'ja-roma': 'Rokon', ko: '식스테일', 'zh-hans': '六尾', 'zh-hant': '六尾'},
	52: {en: 'Meowth', ja: 'ニャース', 'ja-roma': 'Nyarth', ko: '나옹', 'zh-hans': '喵喵', 'zh-hant': '喵喵'},
	53: {en: 'Persian', ja: 'ペルシアン', 'ja-roma': 'Persian', ko: '페르시온', 'zh-hans': '猫老大', 'zh-hant': '貓老大'},
	83: {en: 'Farfetch’d', ja: 'カモネギ', 'ja-roma': 'Kamonegi', ko: '파오리', 'zh-hans': '大葱鸭', 'zh-hant': '大蔥鴨'},
	142: {en: 'Aerodactyl', ja: 'プテラ', 'ja-roma': 'Ptera', ko: '프테라', 'zh-hans': '化石翼龙', 'zh-hant': '化石翼龍'},
	154: {en: 'Meganium', ja: 'メガニウム', 'ja-roma': 'Meganium', ko: '메가니움', 'zh-hans': '大竺葵', 'zh-hant': '大竺葵'},
	479: {en: 'Rotom', ja: 'ロトム', 'ja-roma': 'Rotom', ko: '로토무', 'zh-hans': '洛托姆', 'zh-hant': '洛托姆'},
	623: {en: 'Golurk', ja: 'ゴルーグ', 'ja-roma': 'Goloog', ko: '골루그', 'zh-hans': '泥偶巨人', 'zh-hant': '泥偶巨人'},
	644: {en: 'Zekrom', ja: 'ゼクロム', 'ja-roma': 'Zekrom', ko: '제크로무', 'zh-hans': '捷克罗姆', 'zh-hant': '捷克羅姆'},
};

function tables() {
	const out = {};

	for (const language of ['en', 'ja', 'ja-roma', 'ko', 'zh-hans', 'zh-hant']) {
		out[language] = Array(1026).fill(null);

		for (const [n, names] of Object.entries(SPECIES)) {
			out[language][n] = names[language];
		}
	}

	return out;
}

const TABLES = tables();

// --------------------------------------------- Revised Romanization

describe('romanizeKorean', () => {
	// The examples printed in the Revised Romanization of Korea itself, as
	// published by the National Institute of Korean Language
	// (korean.go.kr/front_eng/roman/roman_01.do, read 2026-10-01). Places are
	// capitalized there; every word is capitalized here, as in a card name.
	const OFFICIAL = {
		// ㄱ, ㄷ, ㅂ before a vowel and before a consonant or at the end.
		구미: 'Gumi', 영동: 'Yeongdong', 백암: 'Baegam', 옥천: 'Okcheon', 합덕: 'Hapdeok', 호법: 'Hobeop', 월곶: 'Wolgot', 벚꽃: 'Beotkkot', 한밭: 'Hanbat',
		// ㄹ as r and l, and ㄹㄹ as ll.
		구리: 'Guri', 설악: 'Seorak', 칠곡: 'Chilgok', 임실: 'Imsil', 울릉: 'Ulleung', 대관령: 'Daegwallyeong',
		// Assimilation of adjacent consonants.
		백마: 'Baengma', 종로: 'Jongno', 왕십리: 'Wangsimni', 별내: 'Byeollae', 신라: 'Silla',
		// Palatalization.
		해돋이: 'Haedoji', 같이: 'Gachi',
		// ㅎ next to ㄱ, ㄷ, ㅈ, and kept in nouns.
		좋고: 'Joko', 놓다: 'Nota', 낳지: 'Nachi', 묵호: 'Mukho', 집현전: 'Jiphyeonjeon',
		// Tense sounds are not written.
		압구정: 'Apgujeong', 낙동강: 'Nakdonggang', 죽변: 'Jukbyeon', 낙성대: 'Nakseongdae', 합정: 'Hapjeong', 팔당: 'Paldang', 샛별: 'Saetbyeol', 울산: 'Ulsan',
	};

	for (const [hangul, expected] of Object.entries(OFFICIAL)) {
		test(`${hangul} is ${expected}`, () => assert.equal(romanizeKorean(hangul), expected));
	}

	// The same tables, applied to Pokémon names. No official list romanizes
	// Pokémon names, so these follow from the tables above rather than from
	// a published example.
	test('Pokémon names', () => {
		assert.equal(romanizeKorean('프테라'), 'Peutera');
		assert.equal(romanizeKorean('피카츄'), 'Pikachyu');
		assert.equal(romanizeKorean('꼬부기'), 'Kkobugi');
		assert.equal(romanizeKorean('이상해씨'), 'Isanghaessi');
		assert.equal(romanizeKorean('리자몽'), 'Rijamong');
		assert.equal(romanizeKorean('골루그'), 'Gollugeu');
	});

	test('a suffix and other Latin text are kept and spaced', () => {
		assert.equal(romanizeKorean('프테라VSTAR'), 'Peutera VSTAR');
		assert.equal(romanizeKorean('히트로토무 ex'), 'Hiteurotomu ex');
		assert.equal(romanizeKorean('니드런♀'), 'Nideureon♀');
	});

	test('each word is read on its own, and & is spaced', () => {
		assert.equal(romanizeKorean('니트로 불꽃 에너지'), 'Niteuro Bulkkot Eneoji');
		assert.equal(romanizeKorean('맛있는 주먹밥'), 'Masinneun Jumeokbap');
		assert.equal(romanizeKorean('가&나'), 'Ga & Na');
	});

	test('a character that cannot be read gives no reading, never a partial one', () => {
		assert.equal(romanizeKorean('프테라化石'), null);
		assert.equal(romanizeKorean('ㄱ'), null);
		assert.equal(romanizeKorean('プテラ'), null);
		assert.equal(romanizeKorean(''), null);
		assert.equal(romanizeKorean('VSTAR'), null, 'no Hangul, nothing to read');
	});

	// Sound changes the official examples show that need a dictionary of
	// compounds or of verb endings, which this does not have.
	test.todo('신문로 is Sinmunno (written Sinmullo: the compound ㄴ before ㄹ)');
	test.todo('학여울 is Hangnyeoul and 알약 allyak (the added ㄴ and ㄹ)');
	test.todo('굳히다 is guchida and 잡혀 japyeo (verb endings; nouns keep the h)');
});

// ------------------------------------------------------------ Hepburn

describe('hepburn', () => {
	test('reads kana by the tables', () => {
		// The converter's own reading. A Pokémon's displayed reading is
		// PokeAPI's ja-roma name instead (Ptera), checked in cardNames below.
		assert.equal(hepburn('プテラ'), 'Putera');
		assert.equal(hepburn('ニャース'), 'Nyāsu');
		assert.equal(hepburn('シェイミ'), 'Sheimi');
		assert.equal(hepburn('ファイヤー'), 'Faiyā');
		assert.equal(hepburn('マッチ'), 'Matchi');
		assert.equal(hepburn('ティッシュ'), 'Tisshu');
		assert.equal(hepburn('ヴァイオレット'), 'Vaioretto');
		assert.equal(hepburn('ポケモンいれかえ'), 'Pokemon\'irekae', 'hiragana, and n\' before a vowel');
		assert.equal(hepburn('ジュナイパーVSTAR'), 'Junaipā VSTAR');
	});

	test('a name with kanji gets no reading', () => {
		assert.equal(hepburn('ボスの指令'), null);
		assert.equal(hepburn('ロケット団のペルシアンex'), null);
		assert.equal(hepburn('基本炎エネルギー'), null);
	});
});

// ------------------------------------------------------------ suffixes

describe('stripSuffix', () => {
	const CASES = [
		['プテラVSTAR', 'プテラ', 'VSTAR'],
		['リザードンex', 'リザードン', 'ex'],
		['リザードンGX', 'リザードン', 'GX'],
		['リザードンVMAX', 'リザードン', 'VMAX'],
		['リザードンV', 'リザードン', 'V'],
		['ピカチュウV-UNION', 'ピカチュウ', 'V-UNION'],
		['MリザードンEX', 'Mリザードン', 'EX'],
		['히트로토무 ex', '히트로토무', 'ex'],
		['メガリザードンXex', 'メガリザードンX', 'ex'],
		['ピカチュウ&ゼクロムGX', 'ピカチュウ&ゼクロム', 'GX'],
		['リザードン', 'リザードン', null],
	];

	for (const [name, base, suffix] of CASES) {
		test(`${name}`, () => assert.deepEqual(stripSuffix(name), {base, suffix}));
	}

	test('a Latin name keeps its letters', () => {
		assert.deepEqual(stripSuffix('Vileplume'), {base: 'Vileplume', suffix: null});
		assert.deepEqual(stripSuffix('CharizardV'), {base: 'CharizardV', suffix: null});
		assert.deepEqual(stripSuffix('V'), {base: 'V', suffix: null});
	});
});

// --------------------------------------------------- English name lookup

describe('English name lookup', () => {
	const english = (card) => (resolvePokemon(card, TABLES) || {}).english || null;

	test('by dexId', () => {
		assert.equal(english({dexId: [142], lang: 'ja', name: 'プテラVSTAR'}), 'Aerodactyl VSTAR');
		assert.equal(english({dexId: [142], lang: 'ko', name: '프테라VSTAR'}), 'Aerodactyl VSTAR');
		assert.equal(english({dexId: [6], lang: 'zh-tw', name: '噴火龍GX'}), 'Charizard GX');
	});

	test('a dexId that disagrees with the name gives none', () => {
		assert.equal(english({dexId: [25], lang: 'ja', name: 'プテラVSTAR'}), null);
	});

	test('by name, with no dexId', () => {
		assert.equal(english({lang: 'ja', name: 'プテラVSTAR'}), 'Aerodactyl VSTAR');
		assert.equal(english({lang: 'ko', name: '프테라VSTAR'}), 'Aerodactyl VSTAR');
		assert.equal(english({lang: 'zh-cn', name: '喷火龙ex'}), 'Charizard ex');
		assert.equal(english({lang: 'ko', name: '니드런♀'}), 'Nidoran♀');
		assert.equal(english({lang: 'ja', name: 'カモネギ'}), 'Farfetch\'d', 'a straight apostrophe, as cards print it');
	});

	test('prefixes and forms', () => {
		assert.equal(english({lang: 'ja', name: 'メガリザードンXex'}), 'Mega Charizard X ex');
		assert.equal(english({lang: 'ko', name: '메가골루그 ex'}), 'Mega Golurk ex');
		assert.equal(english({lang: 'ja', name: 'MリザードンEX'}), 'M Charizard EX');
		assert.equal(english({lang: 'ja', name: 'アローラ ロコンVSTAR'}), 'Alolan Vulpix VSTAR');
		assert.equal(english({lang: 'ja', name: 'アローラロコン'}), 'Alolan Vulpix');
		assert.equal(english({lang: 'zh-tw', name: '阿羅拉 六尾V'}), 'Alolan Vulpix V');
		assert.equal(english({lang: 'ja', name: 'かがやくリザードン'}), 'Radiant Charizard');
		assert.equal(english({lang: 'ja', name: 'ロケット団のペルシアンex'}), 'Team Rocket\'s Persian ex');
		assert.equal(english({lang: 'ko', name: '히트로토무 ex'}), 'Heat Rotom ex');
		assert.equal(english({dexId: [479], lang: 'ja', name: 'ヒートロトムex'}), 'Heat Rotom ex');
		assert.equal(english({lang: 'ja', name: 'ピカチュウ&ゼクロムGX'}), 'Pikachu & Zekrom GX');
	});

	test('a species that starts like a prefix is itself', () => {
		assert.equal(english({lang: 'ja', name: 'メガニウム'}), 'Meganium');
		assert.equal(english({lang: 'ko', name: '메가니움'}), 'Meganium');
	});

	test('Trainers, Energy, and unknown prefixes get none: nothing is guessed', () => {
		assert.equal(english({category: 'Trainer', lang: 'ja', name: 'プテラ'}), null);
		assert.equal(english({category: 'Energy', lang: 'ko', name: '니트로 불꽃 에너지'}), null);
		assert.equal(english({lang: 'ko', name: '맛있는 주먹밥'}), null);
		assert.equal(english({lang: 'ja', name: 'Nのゾロアーク'}), null);
		assert.equal(english({lang: 'ja', name: 'リザードンBREAKX'}), null);
		assert.equal(english({lang: 'en', name: 'Charizard'}), null, 'Western catalogs are not looked up');
		assert.equal(resolvePokemon({lang: 'ja', name: 'プテラ'}, null), null, 'no tables yet');
	});
});

describe('cardNames', () => {
	test('a Japanese Pokémon reads with PokeAPI\'s romaji, not the kana reading', () => {
		assert.deepEqual(cardNames({dexId: [142], lang: 'ja', name: 'プテラVSTAR'}, TABLES), {english: 'Aerodactyl VSTAR', original: 'プテラVSTAR', reading: 'Ptera VSTAR'});
		assert.equal(cardNames({lang: 'ja', name: 'メガリザードンXex'}, TABLES).reading, 'Mega Lizardon X ex');
		assert.equal(cardNames({lang: 'ja', name: 'ロケット団のペルシアンex'}, TABLES).reading, null, 'kanji in the prefix');
	});

	test('a Korean card reads by the Revised Romanization', () => {
		assert.deepEqual(cardNames({lang: 'ko', name: '프테라VSTAR'}, TABLES), {english: 'Aerodactyl VSTAR', original: '프테라VSTAR', reading: 'Peutera VSTAR'});
		assert.deepEqual(cardNames({lang: 'ko', name: '니트로 불꽃 에너지'}, TABLES), {english: null, original: '니트로 불꽃 에너지', reading: 'Niteuro Bulkkot Eneoji'});
		assert.equal(cardNames({lang: 'ko', name: '프테라'}, null).reading, 'Peutera', 'no tables needed');
	});

	test('a Japanese Trainer all in kana reads in Hepburn; with kanji, not at all', () => {
		assert.deepEqual(cardNames({category: 'Trainer', lang: 'ja', name: 'ポケモンいれかえ'}, TABLES), {english: null, original: 'ポケモンいれかえ', reading: 'Pokemon\'irekae'});
		assert.equal(cardNames({category: 'Trainer', lang: 'ja', name: 'ボスの指令'}, TABLES).reading, null);
	});

	test('a Japanese name waits for the tables before any reading', () => {
		assert.equal(cardNames({lang: 'ja', name: 'プテラVSTAR'}, null).reading, null);
	});

	test('Chinese has English names but no reading yet', () => {
		assert.deepEqual(cardNames({lang: 'zh-cn', name: '化石翼龙V'}, TABLES), {english: 'Aerodactyl V', original: '化石翼龙V', reading: null});
	});

	test('a Latin name on an Asian record, or a Western card, is left alone', () => {
		assert.deepEqual(cardNames({lang: 'ja', name: 'Magikarp'}, TABLES), {english: null, original: 'Magikarp', reading: null});
		assert.deepEqual(cardNames({lang: 'pt', name: 'Charizard'}, TABLES), {english: null, original: 'Charizard', reading: null});
	});
});

describe('search terms', () => {
	test('a species is found by its names and readings in every language', () => {
		const terms = speciesSearchTerms(TABLES, 142);

		for (const query of ['Aerodactyl', 'ptera', 'プテラ', '프테라', 'peutera', '化石翼龙']) {
			assert.ok(terms.some((term) => term.includes(searchKey(query))), query);
		}
	});

	test('a card is found by English, original, and reading, without macrons', () => {
		const terms = cardSearchTerms({english: null, original: 'ニャース', reading: 'Nyāsu'});

		assert.ok(terms.some((term) => term.includes(searchKey('nyasu'))));
		assert.ok(terms.some((term) => term.includes(searchKey('ニャース'))));
	});
});

// ----------------------------------------------------- species request

describe('species names request', () => {
	test('asks for every language in one query', () => {
		const query = speciesNamesQuery();

		assert.match(query, /language_id: \{_in: \[2, 3, 4, 9, 11, 12\]\}/);
		assert.match(query, /pokemon_species_id: \{_lte: 1025\}/);
	});

	test('sorts rows into tables by language', () => {
		const tablesFrom = speciesTablesFrom({data: {pokemonspeciesname: [
			{language_id: 9, name: 'Aerodactyl', pokemon_species_id: 142},
			{language_id: 11, name: 'プテラ', pokemon_species_id: 142},
			{language_id: 2, name: 'Ptera', pokemon_species_id: 142},
			{language_id: 3, name: '프테라', pokemon_species_id: 142},
			{language_id: 12, name: '化石翼龙', pokemon_species_id: 142},
			{language_id: 4, name: '化石翼龍', pokemon_species_id: 142},
			{language_id: 5, name: 'Ptéra', pokemon_species_id: 142},
			{language_id: 9, name: 'Too far', pokemon_species_id: 2000},
		]}});

		assert.equal(tablesFrom.en[142], 'Aerodactyl');
		assert.equal(tablesFrom.ja[142], 'プテラ');
		assert.equal(tablesFrom['ja-roma'][142], 'Ptera');
		assert.equal(tablesFrom.ko[142], '프테라');
		assert.equal(tablesFrom['zh-hans'][142], '化石翼龙');
		assert.equal(tablesFrom['zh-hant'][142], '化石翼龍');
		assert.equal(Object.keys(tablesFrom).length, 6, 'French is not kept');
		assert.equal(tablesFrom.en.length, 1026);
	});
});

// --------------------------------------------------------------- flags

describe('flagPlan', () => {
	const files = (plan) => plan.items.map((item) => (item.src ? item.src.split('/').pop() : item.text));

	test('each language maps to its country flag', () => {
		assert.deepEqual(FLAGS, {de: 'de', en: 'us', es: 'es', fr: 'fr', it: 'it', ja: 'jp', ko: 'kr', pt: 'br', 'zh-cn': 'cn', 'zh-tw': 'tw'});
		assert.deepEqual(files(flagPlan(['pt'])), ['br.svg']);
		assert.deepEqual(files(flagPlan(['zh-tw'])), ['tw.svg']);
		assert.match(flagPlan(['ko']).items[0].src, /\/vendor\/flags\/kr\.svg$/);
	});

	test('a language with no flag keeps its text code', () => {
		assert.deepEqual(flagPlan(['nl']).items, [{code: 'nl', src: null, text: 'NL'}]);
	});

	test('a fixed order: pt, en, ja, ko, zh-cn, zh-tw, then the rest', () => {
		assert.deepEqual(flagPlan(['ko', 'en', 'pt']).items.map((item) => item.code), ['pt', 'en', 'ko']);
		assert.deepEqual(flagPlan(['zh-tw', 'fr', 'zh-cn']).items.map((item) => item.code), ['zh-cn', 'zh-tw', 'fr']);
	});

	test(`at most ${MAX_FLAGS} flags, then +N, and the label names every language`, () => {
		const plan = flagPlan(['fr', 'ko', 'en', 'ja', 'pt']);

		assert.deepEqual(plan.items.map((item) => item.code), ['pt', 'en', 'ja']);
		assert.equal(plan.more, 2);
		assert.equal(plan.label, 'Portuguese, English, Japanese, Korean, French');
		assert.equal(flagPlan(['pt', 'en', 'ja']).more, 0);
		assert.equal(flagPlan(['pt', 'pt', 'en']).items.length, 2, 'a language counts once');
		assert.equal(flagPlan([]).label, '');
	});
});
