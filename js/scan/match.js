// Finds catalog cards for a read: the sets whose official card count equals
// the printed total (or one confused digit away), then the card in each set
// whose number matches, ranked by the set code, the side the number was
// printed on, the copyright year, and a Wizards copyright.
//
// The ranking is lab/js/match.js, measured on the lab benchmark
// (lab/README.md). What changes here is where the data comes from: the lab
// keeps TCGdex answers in memory, while the scanner reads them through
// js/catalog.js, which keeps every set list and set in IndexedDB. So a set
// looked at once (in Sets, the import, or an earlier scan) matches again with
// no signal, and a card whose sets are not on the phone is reported as
// waiting rather than as "no match".

import {importApi, setList} from '../catalog.js';
import {confusedVariants, LEFT_NUMBER_FROM, sameNumber, setCodeMatches, WIZARDS_UNTIL} from '../../lab/js/match.js';
import {searchOrder} from './session.js';

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
// [{id, cardCount}].
async function allSets(lang) {
	const {data} = await setList(lang);
	const sets = [];

	for (const serie of data || []) {
		for (const set of serie.sets || []) {
			sets.push(set);
		}
	}

	return sets;
}

// Returns {candidates, partial, searched, ms}. Each candidate is
// {id, image, lang, localId, name, official, reasons, releaseDate, score,
// setCode, setId, setName}, best first.
//
// partial is true when some set that could hold the card was out of reach,
// so the list may be missing the right card. Throws WaitingForSignal when no
// catalog could be searched at all, or when every candidate set was out of
// reach and nothing was found.
//
// language: the language to search for, or null for a card whose language
// is not known (Japanese first, then English).
export async function findCandidates(read, language, {limit = 6, now = () => performance.now(), api = {allSets, setDetail: importApi.setDetail}} = {}) {
	const started = now();
	const number = read && read.number;
	const searched = [];

	if (!number) {
		return {candidates: [], ms: 0, partial: false, searched};
	}

	const byId = new Map();
	const prefix = number.number.replace(/\d+$/, '');
	const numberDigits = number.number.slice(prefix.length);
	let reached = 0;
	let unreachable = 0;
	let lastError = null;

	for (const [index, lang] of searchOrder(language).entries()) {
		let list;

		try {
			list = await api.allSets(lang);
			reached++;
		}
		catch (err) {
			lastError = err;
			unreachable++;
			continue;
		}

		searched.push(lang);

		const exactTotal = number.total;
		const nearTotals = new Set(confusedVariants(number.total));
		const sets = list.filter((set) => set.cardCount && set.cardCount.official > 0
			&& (String(set.cardCount.official) === exactTotal || nearTotals.has(String(set.cardCount.official))));
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
			let numberExact = true;

			if (!card && totalExact) {
				const near = confusedVariants(numberDigits).map((digits) => prefix + digits);

				card = set.cards.find((c) => near.some((value) => sameNumber(c.localId, value)));
				numberExact = false;
			}

			if (!card) {
				continue;
			}

			const existing = byId.get(card.id);

			if (existing) {
				// The same card in the fallback catalog: borrow its image if the
				// first catalog had none.
				existing.image = existing.image || card.image || null;

				continue;
			}

			const setCode = (set.abbreviation && set.abbreviation.official) || (lang === 'ja' ? set.id : null);
			const reasons = [];
			let score = 1;

			if (totalExact && numberExact) {
				reasons.push('number and total');
			}
			else {
				score -= 2;
				reasons.push(totalExact ? 'number one digit off' : 'total one digit off');
			}

			if (setCodeMatches(number.setCodeRun, set, lang)) {
				score += 4;
				reasons.push('set code');
			}

			if (set.releaseDate) {
				const modern = set.releaseDate >= LEFT_NUMBER_FROM;

				if ((number.side === 'left') === modern) {
					score += 2;
					reasons.push(`number on the ${number.side}`);
				}

				const releaseYear = Number(set.releaseDate.slice(0, 4));

				if (read.copyrightYear && (read.copyrightYear === releaseYear || read.copyrightYear === releaseYear - 1)) {
					score += 2;
					reasons.push(`copyright ${read.copyrightYear}`);
				}

				if (read.wizards && set.releaseDate < WIZARDS_UNTIL) {
					score += 2;
					reasons.push('Wizards copyright');
				}
			}

			if (index === 0) {
				score += 1;
				reasons.push(`${lang} catalog`);
			}

			byId.set(card.id, {
				id: card.id,
				image: card.image || null,
				lang,
				localId: card.localId,
				name: card.name,
				official: String(set.cardCount.official),
				reasons,
				releaseDate: set.releaseDate || '',
				score,
				setCode: setCode || null,
				setId: set.id,
				setName: set.name,
			});
		}
	}

	const candidates = [...byId.values()]
		.sort((a, b) => b.score - a.score || b.releaseDate.localeCompare(a.releaseDate))
		.slice(0, limit);

	if (!reached || (!candidates.length && unreachable)) {
		throw new WaitingForSignal(lastError);
	}

	return {candidates, ms: Math.round(now() - started), partial: unreachable > 0, searched};
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
