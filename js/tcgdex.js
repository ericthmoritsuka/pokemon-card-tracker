// The TCGdex network layer every module shares (E-29): one fetch helper
// with one retry policy, GraphQL on top of it, and the one GraphQL set
// list. No DOM and no storage here, so Node tests it and each caller keeps
// its answers where it already did.
//
// The catalog browser's per-language series list (js/catalog.js setList)
// is not this list: GraphQL answers in English only, and the browser needs
// each language's series, logos, and printed codes, read over REST.

export const API = 'https://api.tcgdex.net/v2/';
export const GRAPHQL = `${API}graphql`;

// Retries a server error, a 429, or a dropped connection after 1, 3, 8, then
// 16 seconds: TCGdex answered 503 now and then on 2026-10-01 (DESIGN.md
// section 5), and the catalog set list needs up to 22 requests to all
// succeed. Each caller picks how many attempts: views use two, so a screen
// is not kept waiting; the import, the checklists, and twins more, so a
// long run rides out a short outage.
export const BACKOFF_MS = [1000, 3000, 8000, 16000];

export const retryable = (status) => status >= 500 || status === 429;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;

const hostLabel = (url) => {
	const {hostname} = new URL(url);

	return hostname === 'api.tcgdex.net' ? 'TCGdex' : hostname;
};

// GETs (or, with init, POSTs) url and returns its JSON. A path with no
// scheme is read from the TCGdex API. A failure carries status (when the
// server answered) and network (true when trying later may work: no
// connection, a server error, or a 429).
//
//   attempts  how many tries in all (2)
//   init      fetch's second argument
//   fetch, wait, online  injectable for tests
export async function fetchJson(url, {
	attempts = 2,
	fetch: fetchFn = (...args) => globalThis.fetch(...args),
	init = undefined,
	online = isOnline,
	wait = sleep,
} = {}) {
	const target = /^https?:/.test(url) ? url : API + url;

	for (let attempt = 1; ; attempt++) {
		let response;

		try {
			response = await fetchFn(target, init);
		}
		catch (err) {
			if (attempt < attempts && online()) {
				await wait(BACKOFF_MS[attempt - 1] || BACKOFF_MS.at(-1));

				continue;
			}

			err.network = true;

			throw err;
		}

		if (retryable(response.status) && attempt < attempts) {
			await wait(BACKOFF_MS[attempt - 1] || BACKOFF_MS.at(-1));

			continue;
		}

		if (!response.ok) {
			const err = new Error(`${hostLabel(target)} answered ${response.status} for ${target.startsWith(API) ? target.slice(API.length) : target}.`);

			err.status = response.status;
			err.network = retryable(response.status);

			throw err;
		}

		return response.json();
	}
}

// A TCGdex GraphQL query's data. Takes fetchJson's options.
export async function graphql(query, options = {}) {
	const body = await fetchJson(GRAPHQL, {
		...options,
		init: {
			body: JSON.stringify({query}),
			headers: {'content-type': 'application/json'},
			method: 'POST',
		},
	});

	if (!body || !body.data) {
		throw new Error(`TCGdex GraphQL: ${(body && body.errors && body.errors[0] && body.errors[0].message) || 'no data'}`);
	}

	return body.data;
}

// ------------------------------------------------------------ set index

// Every international set, in one request: the
// Pokémon screen reads names, dates, and the series that marks TCG Pocket;
// twins filters it by series and reads the dates and card counts.
export const SET_INDEX_QUERY = '{ sets { id name releaseDate serie { id } cardCount { official total } } }';

// GraphQL data ({sets}) -> {setId: {id, name, releaseDate, serie, official,
// total}}, in the API's order.
export function setIndexFrom(data) {
	const sets = (data && data.sets) || null;

	if (!Array.isArray(sets)) {
		throw new Error('TCGdex sent no set list.');
	}

	const index = {};

	for (const set of sets) {
		if (set && set.id) {
			index[set.id] = {
				id: set.id,
				name: set.name || set.id,
				official: (set.cardCount && set.cardCount.official) || 0,
				releaseDate: set.releaseDate || null,
				serie: (set.serie && set.serie.id) || null,
				total: (set.cardCount && set.cardCount.total) || 0,
			};
		}
	}

	return index;
}

// The set index, fetched. Takes fetchJson's options.
export const loadSetIndex = async (options) => setIndexFrom(await graphql(SET_INDEX_QUERY, options));
