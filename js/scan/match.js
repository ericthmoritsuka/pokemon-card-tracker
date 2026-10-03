// Finds catalog cards for a read, by every route the read allows, and ranks
// them by how many clues agree (js/scan/evidence.js).
//
// - The number route (lab/js/match.js, measured on the lab benchmark): the
//   sets whose official card count equals the printed total (or one
//   confused digit away), then the card in each whose number matches.
// - The name route: the read name against every species name
//   (js/checklists.js speciesNames, kept on the phone), then that species'
//   international prints (js/pokemon-cards.js loadInternational, built on
//   the bulk card list js/checklists.js keeps), each with its set's card
//   count from the set list. It needs no number at all, so a card whose
//   number is hidden, blurred, or cropped is still found.
//
// The name route runs when the number route found no card with the exact
// number and total read. Both feed one list, scored by the same rules: number and total,
// name, HP, set code, side, copyright, attack names. When the read has an
// HP or attack names and the head of the list is close, the full records
// of the leading cards are read (cache first) to check them. When cards
// are still level, the captured artwork orders them (js/scan/artwork.js).
//
// Data comes through js/catalog.js, which keeps every set list and set in
// IndexedDB, so a set looked at once matches again with no signal, and a
// card whose sets are not on the phone is reported as waiting rather than
// as "no match".

import {importApi, setList} from '../catalog.js';
import {speciesNames} from '../checklists.js';
import {loadInternational} from '../pokemon-cards.js';
import {confusedVariants, sameNumber} from '../../lab/js/match.js';
import {artworkSims} from './artwork.js';
import {cluesOf, matchSpecies, orderByArtwork, rankCards, setNameRead, TIE_POINTS} from './evidence.js';
import {ASIAN_LANGUAGES, searchOrder} from './session.js';

// The catalog could not be reached for something the match needs.
export class WaitingForSignal extends Error {
	constructor(cause) {
		super('The catalog is not on this phone yet and there is no signal.');
		this.name = 'WaitingForSignal';
		this.cause = cause;
	}
}

const online = () => typeof navigator === 'undefined' || navigator.onLine !== false;

// Every set of a catalog language, flattened from js/catalog.js setList:
// [{id, cardCount, name, serie}].
async function allSets(lang) {
	const {data} = await setList(lang);
	const sets = [];

	for (const serie of data || []) {
		for (const set of serie.sets || []) {
			sets.push({...set, serie: serie.id});
		}
	}

	return sets;
}

// Resolves with `promise`, or with `fallback` after ms.
const within = (promise, ms, fallback) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms))]);

// The species names and the prints of a species, waiting at most a few
// seconds each: a first scan with no list on the phone yet must not hang.
async function englishSpecies() {
	const tables = await within(speciesNames(), 4000, null);

	return (tables && tables.en) || [];
}

async function speciesPrints(dex) {
	const result = await within(loadInternational(dex), 4000, {prints: []});

	return result.prints || [];
}

export const DEFAULT_API = {
	allSets,
	artworkSims,
	cardDetail: importApi.cardDetail,
	setDetail: importApi.setDetail,
	species: englishSpecies,
	speciesPrints,
};

// Starts the name route's lists downloading (each is one request, kept on
// the phone), so the first scan with signal does not wait for them.
export function warmNameRoute() {
	speciesNames().catch(() => {});
	loadInternational(25).catch(() => {});
}

// Species matches below this are not used to look cards up (they still
// score a card the number found).
const NAME_LOOKUP = 0.75;

// The full record is read for at most this many leading cards (more when
// no number read, since a name alone leaves many prints level), within this
// long, to check HP and attacks. Each record is kept once read.
const DETAIL_CARDS = 6;
const DETAIL_CARDS_NAME_ONLY = 12;
const DETAIL_MS = 1500;

// The artwork is compared for at most this many level cards: a name alone
// (Pikachu, say) can leave dozens of prints level, and each comparison is
// one small image (about 15 KB), kept once fetched.
const ARTWORK_CARDS = 16;

// A candidate as the tray keeps it: no set record, no attack lists.
const kept = ({abilities, agree, attacks, conflicts, dexIds, first, hp, set, ...rest}) => ({...rest, agree, conflicts, hp: hp || null});

// Returns {candidates, names, partial, searched, ms, routes, setName}. Each
// candidate is {id, image, lang, localId, name, official, reasons,
// releaseDate, score, confidence, agree, conflicts, setCode, setId,
// setName, artwork}, best first. names are the species the read name
// matched: [{dex, name, score}]. setName is the set the read name turned
// out to be (so it was not used as a name), or null.
//
// partial is true when some set that could hold the card was out of reach,
// so the list may be missing the right card. Throws WaitingForSignal when
// no catalog could be searched at all, or when every candidate set was out
// of reach and nothing was found.
//
// language: the language to search for, or null for a card whose language
// is not known (Japanese first, then English). artwork: the captured card's
// artwork vector (js/scan/artwork.js artVector), or null.
export async function findCandidates(read, language, {artwork = null, limit = 6, now = () => performance.now(), api = DEFAULT_API} = {}) {
	const started = now();
	const clues = cluesOf(read);
	const searched = [];
	const routes = [];
	const byId = new Map();
	const order = searchOrder(language);
	let reached = 0;
	let unreachable = 0;
	let lastError = null;
	const setLists = new Map();

	const listFor = async (lang) => {
		if (!setLists.has(lang)) {
			setLists.set(lang, api.allSets(lang).then((list) => {
				reached++;

				return list;
			}, (err) => {
				lastError = err;
				unreachable++;

				return null;
			}));
		}

		return setLists.get(lang);
	};

	const add = (card) => {
		const existing = byId.get(card.id);

		if (existing && !existing.set && card.set) {
			// The number route's record carries the set (its code, its date):
			// it replaces the name route's, keeping the species.
			byId.set(card.id, {...card, dexIds: existing.dexIds || card.dexIds || null});

			return;
		}

		if (existing) {
			// The same card in the fallback catalog or by the other route:
			// keep what the first one lacked.
			existing.image = existing.image || card.image || null;
			existing.dexIds = existing.dexIds || card.dexIds || null;
			existing.official = existing.official || card.official || null;

			return;
		}

		byId.set(card.id, card);
	};

	// ---- the name, against the species list

	// A name that is exactly a set's name is the heading of the page the
	// card was photographed on, not the card's name (evidence.js
	// setNameRead): it neither finds cards nor counts for or against them.
	// The English set list is the one the name route reads anyway.
	const latin = !ASIAN_LANGUAGES.includes(language);
	const named = Boolean(clues.name && clues.name.text && latin && api.species);
	const [species, englishSets] = named ? await Promise.all([api.species().catch(() => []), listFor('en')]) : [[], null];
	const setName = named ? setNameRead(clues.name.text, englishSets, species) : null;

	if (setName) {
		clues.name = null;
	}

	const names = species.length && clues.name ? matchSpecies(clues.name.text, species) : [];

	clues.names = names;

	// ---- the number route

	const numberRoute = async () => {
		const number = read && read.number;

		if (!number) {
			return;
		}

		routes.push('number');

		const prefix = number.number.replace(/\d+$/, '');
		const numberDigits = number.number.slice(prefix.length);

		for (const [index, lang] of order.entries()) {
			const list = await listFor(lang);

			if (!list) {
				continue;
			}

			searched.push(lang);

			const nearTotals = new Set(confusedVariants(number.total));
			const sets = list.filter((set) => set.cardCount && set.cardCount.official > 0
				&& (String(set.cardCount.official) === number.total || nearTotals.has(String(set.cardCount.official))));
			const details = await Promise.all(sets.map(async (set) => {
				try {
					return await api.setDetail(lang, set.id);
				}
				catch (err) {
					lastError = err;
					unreachable++;

					return null;
				}
			}));

			for (const set of details) {
				if (!set || !Array.isArray(set.cards) || !set.cardCount) {
					continue;
				}

				const totalExact = String(set.cardCount.official) === number.total;
				let card = set.cards.find((c) => sameNumber(c.localId, number.number));

				if (!card && totalExact) {
					const near = confusedVariants(numberDigits).map((digits) => prefix + digits);

					card = set.cards.find((c) => near.some((value) => sameNumber(c.localId, value)));
				}

				if (!card) {
					continue;
				}

				add({
					first: index === 0,
					id: card.id,
					image: card.image || null,
					lang,
					localId: card.localId,
					name: card.name,
					official: String(set.cardCount.official),
					releaseDate: set.releaseDate || '',
					set,
					setCode: (set.abbreviation && set.abbreviation.official) || (lang === 'ja' ? set.id : null),
					setId: set.id,
					setName: set.name,
				});
			}
		}
	};

	// ---- the name route

	const nameRoute = async () => {
		const lookups = names.filter((match) => match.score >= NAME_LOOKUP && match.score >= names[0].score - 0.1).slice(0, 2);

		if (!lookups.length || !api.speciesPrints) {
			return;
		}

		routes.push('name');

		// International prints are listed in English; the set list gives
		// each set's card count.
		const list = await listFor('en');
		const counts = new Map((list || []).map((set) => [set.id, set.cardCount && set.cardCount.official ? String(set.cardCount.official) : null]));
		const lang = order.find((code) => !ASIAN_LANGUAGES.includes(code)) || 'en';

		if (!searched.includes('en')) {
			searched.push('en');
		}

		for (const match of lookups) {
			const prints = await api.speciesPrints(match.dex).catch(() => []);

			for (const print of prints) {
				add({
					dexIds: [match.dex],
					first: lang === 'en' && order[0] === 'en',
					id: print.cardId,
					image: print.image || null,
					lang: 'en',
					localId: print.localId,
					name: print.name || match.name,
					official: counts.get(print.setId) || null,
					releaseDate: print.releaseDate || '',
					setCode: null,
					setId: print.setId,
					setName: print.setName || print.setId,
				});
			}
		}
	};

	// The name route runs when the number did not settle it: no number read,
	// or no card with that exact number and total. A clean number read never
	// waits for a species list to download.
	//
	// A number can also be misread into another card of the same set (001
	// as 007, both out of 132): when the name read clearly names a species
	// that no card with the exact number is, the name route runs as well, so
	// the card the name names is there to weigh against it.
	await numberRoute();

	const exactCards = read && read.number ? [...byId.values()].filter((card) => sameNumber(card.localId, read.number.number) && String(card.official) === String(read.number.total)) : [];
	const nameElsewhere = exactCards.length > 0 && names.length > 0 && names[0].score >= NAME_LOOKUP && !rankCards(clues, exactCards).some((card) => card.agree.includes('name'));

	if (!exactCards.length || nameElsewhere) {
		await nameRoute();
	}


	let ranked = rankCards(clues, [...byId.values()]);

	// ---- HP and attacks, from the leading cards' full records

	const close = ranked.filter((card) => card.score >= (ranked[0] ? ranked[0].score : 0) - 4).slice(0, read && read.number ? DETAIL_CARDS : DETAIL_CARDS_NAME_ONLY);
	const uncertain = ranked.length > 1 && (nameElsewhere || !ranked[0].agree.includes('number') || !ranked[0].agree.includes('total') || ranked[1].score >= ranked[0].score - TIE_POINTS);

	if (api.cardDetail && (clues.hp || clues.attackText) && uncertain && close.length) {
		const details = new Map();

		await within(Promise.all(close.map(async (card) => {
			try {
				const detail = await api.cardDetail(card.lang, card.id);

				if (detail) {
					details.set(card.id, detail);
				}
			}
			catch {
				// Checked without it.
			}
		})), DETAIL_MS, null);

		if (details.size) {
			ranked = rankCards(clues, ranked.map((card) => {
				const detail = details.get(card.id);

				return detail
					? {
						...card,
						abilities: (detail.abilities || []).map((ability) => ability.name),
						attacks: (detail.attacks || []).map((attack) => attack.name),
						dexIds: card.dexIds || detail.dexId || null,
						hp: detail.hp || null,
					}
					: card;
			}));
		}
	}

	// ---- the artwork, for cards still level

	if (artwork && api.artworkSims && ranked.length > 1 && ranked[1].score >= ranked[0].score - TIE_POINTS) {
		const head = ranked.filter((card) => card.score >= ranked[0].score - TIE_POINTS).slice(0, ARTWORK_CARDS);
		const sims = await api.artworkSims(artwork, head).catch(() => new Map());

		ranked = orderByArtwork(ranked, sims);
	}

	const candidates = ranked.slice(0, limit).map(kept);

	if (!reached || (!candidates.length && unreachable)) {
		if (read && (read.number || names.length)) {
			throw new WaitingForSignal(lastError);
		}
	}

	return {candidates, ms: Math.round(now() - started), names, partial: unreachable > 0, routes, searched, setName};
}

// The card's full TCGdex record (for variants_detailed), cache first. Throws
// WaitingForSignal when it is not on the phone and there is no signal.
export async function cardVariants(card, {api = importApi} = {}) {
	try {
		const detail = await api.cardDetail(card.lang, card.id);

		return detail && Array.isArray(detail.variants_detailed) ? detail.variants_detailed : [];
	}
	catch (err) {
		if (!online() || (err && (err.name === 'TypeError' || err.name === 'NotOnPhoneError'))) {
			throw new WaitingForSignal(err);
		}

		throw err;
	}
}

// The card's category from its record ("Pokemon", "Trainer", "Energy", as
// TCGdex writes them), or null when the record is out of reach within ms.
// The label row read uses it: a Trainer or Energy has no weakness row, so a
// row that read nothing says nothing about its language.
export async function cardCategory(card, {api = importApi, ms = 1500} = {}) {
	if (!card || !card.lang || !card.id) {
		return null;
	}

	const detail = await Promise.race([
		Promise.resolve().then(() => api.cardDetail(card.lang, card.id)).catch(() => null),
		new Promise((resolve) => setTimeout(() => resolve(null), ms)),
	]);

	return (detail && typeof detail.category === 'string' && detail.category) || null;
}
