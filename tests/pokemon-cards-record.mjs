// Records the real TCGdex responses the Pokémon cards tests replay
// (tests/pokemon-cards-fixtures.mjs), for Jigglypuff (dex 39). Run it again
// to refresh them: node tests/pokemon-cards-record.mjs
//
// What it keeps, trimmed so the fixture stays small (every value kept is as
// TCGdex sent it; only whole entries and unused fields are dropped):
//   the GraphQL bulk list ({cards {id dexId}}): every card whose dexId
//     includes 39, plus the first 400 others, as a stand-in for the 23,736;
//   the GraphQL set list: the sets those cards are in;
//   the GraphQL cards of dex 39 (names and images);
//   the Japanese, Korean, and both Chinese REST lists for ?dexId=eq:39;
//   each Japanese set those cards are in, with its cards cut to the
//     Jigglypuff ones;
//   each card's REST record (international in English, and Japanese), with
//     pricing and product IDs dropped from variants_detailed.

import {writeFile} from 'node:fs/promises';

const API = 'https://api.tcgdex.net/v2/';
const DEX = 39;
const OTHERS = 400;

async function json(path, init) {
	for (let attempt = 1; ; attempt++) {
		const response = await fetch(API + path, init);

		if (response.ok) {
			return response.json();
		}

		if (attempt >= 4) {
			throw new Error(`${path}: ${response.status}`);
		}

		await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
	}
}

const graphql = (query) => json('graphql', {body: JSON.stringify({query}), headers: {'content-type': 'application/json'}, method: 'POST'});

const lean = (card) => ({
	...card,
	pricing: undefined,
	variants_detailed: Array.isArray(card.variants_detailed)
		? card.variants_detailed.map(({pricing, thirdParty, ...rest}) => rest)
		: card.variants_detailed,
});

const setOf = (id) => id.slice(0, id.lastIndexOf('-'));

const bulk = (await graphql('{ cards { id dexId } }')).data.cards;
const mine = bulk.filter((card) => Array.isArray(card.dexId) && card.dexId.includes(DEX));
const others = bulk.filter((card) => !mine.includes(card)).slice(0, OTHERS);
const allSets = (await graphql('{ sets { id name releaseDate serie { id } } }')).data.sets;
const used = new Set(mine.map((card) => card.id).map((id) => allSets.map((set) => set.id).filter((setId) => id.startsWith(`${setId}-`)).sort((a, b) => b.length - a.length)[0] || setOf(id)));
const sets = allSets.filter((set) => used.has(set.id));
const dexCards = (await graphql(`{ cards(filters: {dexId: ${DEX}}) { id localId name image rarity } }`)).data.cards;

const asian = {};

for (const lang of ['ja', 'ko', 'zh-cn', 'zh-tw']) {
	asian[lang] = await json(`${lang}/cards?dexId=eq:${DEX}`);
}

const jaSets = {};

for (const setId of new Set(asian.ja.map((card) => setOf(card.id)))) {
	const set = await json(`ja/sets/${encodeURIComponent(setId)}`);
	const ids = new Set(asian.ja.map((card) => card.id));

	jaSets[setId] = {...set, cards: (set.cards || []).filter((card) => ids.has(card.id))};
}

const cards = {};

for (const card of mine) {
	cards[`en/cards/${card.id}`] = lean(await json(`en/cards/${encodeURIComponent(card.id)}`));
}

for (const card of asian.ja) {
	cards[`ja/cards/${card.id}`] = lean(await json(`ja/cards/${encodeURIComponent(card.id)}`));
}

const fixtures = {
	asian,
	bulk: [...mine, ...others],
	cards,
	dexCards,
	jaSets,
	recordedAt: new Date().toISOString(),
	sets,
};

const text = `// Real TCGdex responses for Jigglypuff (dex 39), recorded by
// tests/pokemon-cards-record.mjs on ${fixtures.recordedAt.slice(0, 10)}. Trimmed as that file
// describes; do not edit by hand.

export const FIXTURES = ${JSON.stringify(fixtures, null, '\t')};
`;

await writeFile(new URL('./pokemon-cards-fixtures.mjs', import.meta.url), text);
console.log(`Recorded ${mine.length} international and ${asian.ja.length} Japanese cards of #${DEX}, ${sets.length} sets.`);
