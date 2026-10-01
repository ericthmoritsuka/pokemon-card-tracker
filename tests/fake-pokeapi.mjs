// A stand-in for PokeAPI's species names, for the browser tests.
//
// A few species carry their real names (PokeAPI, checked 2026-10-01); every
// other number gets a made-up name in each language, so all 1,025 are
// present the way the real endpoint answers.

const MAX_DEX = 1025;

// PokeAPI language IDs.
const LANGUAGE_IDS = {en: 9, ja: 11, 'ja-roma': 2, ko: 3, 'zh-hans': 12, 'zh-hant': 4};

export const REAL = {
	1: {en: 'Bulbasaur', ja: 'フシギダネ', 'ja-roma': 'Fushigidane', ko: '이상해씨', 'zh-hans': '妙蛙种子', 'zh-hant': '妙蛙種子'},
	6: {en: 'Charizard', ja: 'リザードン', 'ja-roma': 'Lizardon', ko: '리자몽', 'zh-hans': '喷火龙', 'zh-hant': '噴火龍'},
	7: {en: 'Squirtle', ja: 'ゼニガメ', 'ja-roma': 'Zenigame', ko: '꼬부기', 'zh-hans': '杰尼龟', 'zh-hant': '傑尼龜'},
	25: {en: 'Pikachu', ja: 'ピカチュウ', 'ja-roma': 'Pikachu', ko: '피카츄', 'zh-hans': '皮卡丘', 'zh-hant': '皮卡丘'},
	142: {en: 'Aerodactyl', ja: 'プテラ', 'ja-roma': 'Ptera', ko: '프테라', 'zh-hans': '化石翼龙', 'zh-hant': '化石翼龍'},
};

// English names some tests rely on, with made-up names elsewhere.
export function speciesRows(english = {}) {
	const rows = [];

	for (let n = 1; n <= MAX_DEX; n++) {
		const names = {
			en: english[n] || `Testmon ${n}`,
			ja: `テストモン${n}`,
			'ja-roma': `Tesutomon${n}`,
			ko: `테스트몬${n}`,
			'zh-hans': `测试兽${n}`,
			'zh-hant': `測試獸${n}`,
			...REAL[n],
		};

		if (english[n]) {
			names.en = english[n];
		}

		for (const [language, id] of Object.entries(LANGUAGE_IDS)) {
			rows.push({language_id: id, name: names[language], pokemon_species_id: n});
		}
	}

	return rows;
}

// Answers PokeAPI's GraphQL endpoint and blocks its REST API. counts.names
// counts the GraphQL requests.
export async function fakePokeApi(context, {counts = null, english = {}, offline = () => false} = {}) {
	const body = JSON.stringify({data: {pokemonspeciesname: speciesRows(english)}});

	await context.route('https://graphql.pokeapi.co/**', (route) => {
		if (offline()) {
			return route.abort('internetdisconnected');
		}

		if (counts) {
			counts.names++;
		}

		return route.fulfill({body, contentType: 'application/json', status: 200});
	});

	await context.route('https://pokeapi.co/**', (route) => route.abort());
}
