// Invented cards, copies, and a fake TCGdex for the My Cards browser tests
// (tests/my-cards-browser.test.mjs): search, the filter and sort bar, the
// background card details and prices, and the Value sheet.
//
// Every card here is made up, in two invented international sets, one
// Japanese, and one Korean. The fake answers the REST set and card
// endpoints and the GraphQL details query, counts each request, and fails
// anything it does not know with a 404.

export const BASE = '/pokemon-card-tracker/';
export const RATE = {brlPerUsd: 5, date: '2026-10-01'};

const SET_ONE = {id: 'tsa1', name: 'Test Alpha', official: 160, releaseDate: '2026-03-01'};
const SET_TWO = {id: 'tsb2', name: 'Test Beta', official: 120, releaseDate: '2025-01-10'};
// The Asian set names are as long as real ones (強化拡張パック
// ポケモンカード151), so the layout test sees a meta line that would wrap.
const SET_JA = {id: 'TSJ1', name: 'テスト拡張パック カード151', official: 100, releaseDate: '2025-11-01'};
const SET_KO = {id: 'TSK1', name: '테스트 확장팩 세트카드 151', official: 100, releaseDate: '2025-12-01'};

// One row per card: names per language, the details GraphQL gives, and the
// US market price the full record carries (null: TCGdex has none).
export const CARDS = [
	{catalog: 'international', category: 'Pokemon', dexId: [1], id: 'tsa1-001', market: 0.5, names: {en: 'Bulbasaur', pt: 'Bulbasaur'}, rarity: 'Common', set: SET_ONE, types: ['Grass']},
	{catalog: 'international', category: 'Pokemon', dexId: [4], id: 'tsa1-004', market: 1.2, names: {en: 'Charmander', pt: 'Charmander'}, rarity: 'Common', set: SET_ONE, types: ['Fire']},
	{catalog: 'international', category: 'Pokemon', dexId: [6], id: 'tsa1-006', market: 30, names: {en: 'Charizard ex'}, rarity: 'Double rare', set: SET_ONE, types: ['Fire']},
	{catalog: 'international', category: 'Trainer', dexId: null, id: 'tsa1-150', market: null, names: {en: 'Test Ball', pt: 'Bola de Teste'}, rarity: 'Uncommon', set: SET_ONE, types: null},
	{catalog: 'international', category: 'Energy', dexId: null, id: 'tsa1-160', market: 0.1, names: {en: 'Basic Fire Energy'}, rarity: 'Common', set: SET_ONE, types: null},
	{catalog: 'international', category: 'Pokemon', dexId: [25], id: 'tsb2-025', market: 5, names: {en: 'Pikachu'}, rarity: 'Rare', set: SET_TWO, types: ['Lightning']},
	{catalog: 'international', category: 'Pokemon', dexId: [906], id: 'tsb2-090', market: 2, names: {en: 'Sprigatito'}, rarity: 'Rare', set: SET_TWO, types: ['Grass']},
	{catalog: 'ja', category: 'Pokemon', dexId: [25], id: 'TSJ1-025', market: null, names: {ja: 'ピカチュウ'}, rarity: 'Common', set: SET_JA, types: ['Lightning']},
	{catalog: 'ko', category: 'Pokemon', dexId: [1], id: 'TSK1-001', market: null, names: {ko: '이상해씨'}, rarity: 'Common', set: SET_KO, types: ['Grass']},
];

const localIdOf = (card) => card.id.slice(card.id.lastIndexOf('-') + 1);

const at = (day) => `2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`;

// The copies, one per card, added on different days so newest and oldest
// differ, plus a second Charmander in Portuguese and a Liga-priced Pikachu.
export const COPIES = [
	{card_id: 'tsa1-001', catalog: 'international', created_at: at(1), id: 'c-01', language: 'en'},
	{card_id: 'tsa1-004', catalog: 'international', created_at: at(2), id: 'c-02', language: 'en'},
	{card_id: 'tsa1-004', catalog: 'international', created_at: at(3), id: 'c-03', language: 'pt'},
	{card_id: 'tsa1-006', catalog: 'international', created_at: at(4), id: 'c-04', language: 'en'},
	{card_id: 'tsa1-150', catalog: 'international', created_at: at(5), id: 'c-05', language: 'pt'},
	{card_id: 'tsa1-160', catalog: 'international', created_at: at(6), id: 'c-06', language: 'en'},
	{card_id: 'tsb2-025', catalog: 'international', created_at: at(7), id: 'c-07', language: 'en', price_manual: {avg: 80, currency: 'BRL', date: '2026-09-20', low_nm: 70, source: 'Liga Pokémon'}},
	{card_id: 'tsb2-090', catalog: 'international', created_at: at(8), id: 'c-08', language: 'en'},
	{card_id: 'TSJ1-025', catalog: 'ja', created_at: at(9), id: 'c-09', language: 'ja'},
	{card_id: 'TSK1-001', catalog: 'ko', created_at: at(10), id: 'c-10', language: 'ko'},
].map((copy) => ({deleted_at: null, language_source: 'manual', updated_at: copy.created_at, variant_id: null, ...copy}));

// Bulbasaur sits in a binder; everything else is not in one yet.
export const BINDERS = [{
	cols: 3,
	created_at: at(1),
	deleted_at: null,
	id: 'b-1',
	name: 'Test binder',
	page_count: 10,
	rows: 3,
	slots: [{entry_id: 'c-01', page: 1, placed_at: at(1), position: 1}],
	updated_at: at(1),
}];

// The card index as the import leaves it: names and sets, no details.
export function indexRecords(cards = CARDS) {
	const out = {};

	for (const card of cards) {
		const localizations = {};

		for (const [lang, name] of Object.entries(card.names)) {
			localizations[lang] = {image: null, lang, name, set_name: card.set.name};
		}

		out[`${card.catalog}|${card.id}`] = {
			catalog: card.catalog,
			collector_number: localIdOf(card),
			id: card.id,
			localizations,
			official: card.set.official,
			release_date: card.set.releaseDate,
			set_id: card.set.id,
		};
	}

	return out;
}

export function documentWith(cards, binders = []) {
	return {binders, cards, collections: [], goals: [], openings: [], person: 'local', updated_at: at(1), user_id: null, version: 1, wishlist: []};
}

// The full record card detail would save: the set, and the US market price
// on the plain print when TCGdex has one.
export function fullRecord(card, lang = 'en') {
	const record = {
		category: card.category,
		dexId: card.dexId || undefined,
		id: card.id,
		image: null,
		localId: localIdOf(card),
		name: card.names[lang] || card.names.en,
		rarity: card.rarity,
		set: {cardCount: {official: card.set.official, total: card.set.official}, id: card.set.id, name: card.set.name},
		types: card.types || undefined,
	};

	if (card.market !== null) {
		record.pricing = {tcgplayer: {normal: {marketPrice: card.market, productId: 1000 + Number(localIdOf(card))}, unit: 'USD', updated: '2026-09-30T00:00:00.000Z'}};
	}

	return record;
}

// The GraphQL details query's answer for one set, from the id filter in
// the query and the @locale directive.
function detailsAnswer(query, cards) {
	const id = /id: "([^"]+)-"/.exec(query);
	const locale = /@locale\(lang: "([^"]+)"\)/.exec(query);
	const catalog = locale ? locale[1] : 'international';

	if (!id) {
		return null;
	}

	return {
		data: {
			cards: cards
				.filter((card) => card.catalog === catalog && card.set.id === id[1])
				.map((card) => ({category: card.category, dexId: card.dexId, id: card.id, rarity: card.rarity, types: card.types})),
		},
	};
}

// Routes TCGdex, its images, the exchange rates, fonts, and Supabase.
// Returns the request log: {graphql: [set ids], cards: [card ids], other: []}.
export async function fakeServices(context, {cards = CARDS, delayMs = 0, fail = () => false} = {}) {
	const log = {cards: [], graphql: [], other: []};
	const byId = new Map(cards.map((card) => [card.id, card]));

	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await context.route('https://*.supabase.co/**', (route) => {
		log.other.push(route.request().url());

		return route.abort('blockedbyclient');
	});
	await context.route(/ligapokemon\.com\.br/, (route) => {
		log.other.push(route.request().url());

		return route.abort('blockedbyclient');
	});
	await context.route('https://api.frankfurter.dev/**', (route) => route.fulfill({
		body: JSON.stringify([{base: 'USD', date: RATE.date, quote: 'BRL', rate: RATE.brlPerUsd}]),
		contentType: 'application/json',
		headers: {'Access-Control-Allow-Origin': '*'},
	}));
	await context.route('https://assets.tcgdex.net/**', (route) => route.fulfill({status: 404}));
	await context.route('https://api.tcgdex.net/**', async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname.replace(/^\/v2\//, '');
		const json = (body, status = 200) => route.fulfill({body: JSON.stringify(body), contentType: 'application/json', status});

		if (delayMs) {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}

		if (fail(path)) {
			return json({}, 503);
		}

		if (path === 'graphql') {
			const {query} = JSON.parse(request.postData() || '{}');
			const answer = detailsAnswer(String(query || ''), cards);
			const id = /id: "([^"]+)-"/.exec(String(query || ''));

			log.graphql.push(id ? id[1] : String(query));

			return answer ? json(answer) : json({}, 404);
		}

		const card = /^([a-z-]+)\/cards\/([^/]+)$/.exec(path);

		if (card) {
			const found = byId.get(decodeURIComponent(card[2]));

			log.cards.push(`${card[1]}/${decodeURIComponent(card[2])}`);

			return found ? json(fullRecord(found, card[1])) : json({}, 404);
		}

		log.other.push(path);

		return json({}, 404);
	});

	return log;
}

// The new stylesheets, until index.html links them (the integrator adds the
// lines); skipped once it does.
export async function linkNewStyles(context) {
	await context.addInitScript((base) => {
		document.addEventListener('DOMContentLoaded', () => {
			for (const name of ['filter-bar', 'value-sheet']) {
				const href = `${base}css/${name}.css`;

				if (!document.querySelector(`link[href="${href}"]`)) {
					document.head.append(Object.assign(document.createElement('link'), {href, rel: 'stylesheet'}));
				}
			}
		});
	}, BASE);
}

// Puts a collection, a card index, saved full records ({key: {at, data}}),
// and the exchange rate on the device, then opens My Cards again.
export async function seed(page, origin, {binders = BINDERS, copies = COPIES, index = indexRecords(), local = {}, records = {}} = {}) {
	await page.goto(`${origin}${BASE}check`);
	await page.evaluate(async ({doc, index, local, records}) => {
		const put = (name, store, entries) => new Promise((resolve, reject) => {
			const open = indexedDB.open(name, 1);

			open.onupgradeneeded = () => open.result.createObjectStore(store);
			open.onsuccess = () => {
				const tx = open.result.transaction(store, 'readwrite');

				for (const [key, value] of entries) {
					tx.objectStore(store).put(value, key);
				}

				tx.oncomplete = () => {
					open.result.close();
					resolve();
				};
				tx.onerror = () => reject(tx.error);
			};
			open.onerror = () => reject(open.error);
		});

		await put('card-tracker-collection', 'documents', [['local', doc]]);
		await put('card-tracker-catalog', 'responses', [['index:cards', {at: Date.now(), data: index}], ...Object.entries(records)]);

		for (const [key, value] of Object.entries(local)) {
			localStorage.setItem(key, value);
		}
	}, {doc: documentWith(copies, binders), index, local: {'cardTracker.rates': JSON.stringify({...RATE, fetchedAt: Date.now()}), ...local}, records});
	await page.goto(`${origin}${BASE}cards`);
}
