// Finds catalog cards for a read: TCGdex sets whose official card count
// equals the printed total, then the card in each set whose number matches.
// The set code, the side the number was printed on, and the copyright year,
// when read, rank them.

const API = 'https://api.tcgdex.net/v2/';

// Sun & Moon (February 2017) moved the collector number from the bottom right
// to the bottom left. Checked on TCGdex scans of xy1 (right) and sm1 (left).
export const LEFT_NUMBER_FROM = '2017-02-01';

const cache = new Map();

export function getJson(path) {
	if (!cache.has(path)) {
		const promise = fetch(API + path).then((response) => {
			if (!response.ok) {
				throw new Error(`TCGdex answered ${response.status} for ${path}`);
			}

			return response.json();
		});

		promise.catch(() => cache.delete(path));
		cache.set(path, promise);
	}

	return cache.get(path);
}

// The catalogs to search, in order. A Latin-script language falls back to
// English (vintage Portuguese sets list no cards, for one). A card that is
// not Latin script is looked up in Japanese first: Korean prints use the
// Japanese set codes and numbering (DESIGN.md section 5).
export function searchLanguages(code) {
	if (code === 'non-latin') {
		return ['ja', 'en'];
	}

	if (!code || code === 'en') {
		return ['en'];
	}

	return [code, 'en'];
}

// "063" and "63" are the same number; "TG05" and "TG5" too.
export function sameNumber(a, b) {
	const split = (value) => {
		const match = String(value).toUpperCase().match(/^([A-Z]*)0*(\d+)([A-Z]*)$/);

		return match ? `${match[1]}|${match[2]}|${match[3]}` : String(value).toUpperCase();
	};

	return split(a) === split(b);
}

// Letters and digits OCR confuses in the set code box: SV1S read as SVIS,
// SV5K as SVSK, OBF as 0BF.
const foldCode = (code) => String(code || '')
	.toUpperCase()
	.replace(/[^A-Z0-9]/g, '')
	.replace(/I/g, '1')
	.replace(/O/g, '0')
	.replace(/S/g, '5')
	.replace(/Z/g, '2')
	.replace(/B/g, '8');

// The set code box was introduced with Scarlet & Violet (Japanese sv1S,
// January 2023). Older sets have codes in TCGdex too, but none printed, and
// a two-letter code would match noise.
export const SET_CODE_FROM = '2023-01-01';

// True when the set's printed code appears in the letters read off the box.
// International sets carry it as abbreviation.official; Japanese sets are
// coded by their ID.
export function setCodeMatches(run, set, lang) {
	if (!run || !set.releaseDate || set.releaseDate < SET_CODE_FROM) {
		return false;
	}

	const code = (set.abbreviation && set.abbreviation.official) || (lang === 'ja' ? set.id : null);

	return Boolean(code) && code.length >= 2 && foldCode(run).includes(foldCode(code));
}

// Digits the OCR confuses on these fonts, seen in the benchmark: 8 read as
// 5 (198 as 195), 1 as 7 (165 as 765), 0 as 8, and so on.
const CONFUSIONS = {
	0: '689',
	1: '7',
	3: '8',
	5: '68',
	6: '58',
	7: '1',
	8: '0356',
	9: '0',
};

// Every value one confused digit away from `digits`, plus the values with a
// 1 dropped or added: WotC-era 1s are plain bars, and `3/111` read as
// `3/11`, `1/82` as `1/182`.
export function confusedVariants(digits) {
	const out = [];

	for (let i = 0; i < digits.length; i++) {
		for (const other of CONFUSIONS[digits[i]] || '') {
			out.push(digits.slice(0, i) + other + digits.slice(i + 1));
		}

		if (digits[i] === '1') {
			out.push(digits.slice(0, i) + digits.slice(i + 1));
		}
	}

	for (let i = 0; i <= digits.length; i++) {
		out.push(digits.slice(0, i) + '1' + digits.slice(i));
	}

	const original = String(Number(digits));

	return [...new Set(out.filter((value) => /[1-9]/.test(value)).map((value) => String(Number(value))))]
		.filter((value) => value !== original);
}

// WotC printed Pokémon cards until 2003; their copyright line names Wizards.
export const WIZARDS_UNTIL = '2004-01-01';

// Returns {candidates, searched, ms}. Each candidate is
// {id, image, lang, localId, name, official, reasons, releaseDate, score,
// setCode, setId, setName}, best first. `limit` caps the list.
//
// Sets come from each catalog's full set list, filtered here rather than with
// the API's `cardCount.official=eq:` filter (which works), so that totals one
// confused digit away can be searched too. Those, and numbers one confused
// digit away, rank below an exact read with the same evidence.
export async function findCandidates(read, {limit = 6, now = () => performance.now()} = {}) {
	const started = now();
	const number = read.number;
	const searched = [];

	if (!number) {
		return {candidates: [], ms: 0, searched};
	}

	const languages = searchLanguages(read.language && read.language.code);
	const byId = new Map();
	const prefix = number.number.replace(/\d+$/, '');
	const numberDigits = number.number.slice(prefix.length);

	for (const [index, lang] of languages.entries()) {
		searched.push(lang);

		let list;

		try {
			list = await getJson(`${lang}/sets`);
		}
		catch {
			continue;
		}

		const exactTotal = new Set([number.total]);
		const nearTotals = new Set(confusedVariants(number.total));
		const sets = list.filter((set) => set.cardCount && set.cardCount.official > 0 && (exactTotal.has(String(set.cardCount.official)) || nearTotals.has(String(set.cardCount.official))));
		const details = await Promise.all(
			sets.map((set) => getJson(`${lang}/sets/${encodeURIComponent(set.id)}`).catch(() => null))
		);

		for (const set of details) {
			if (!set || !Array.isArray(set.cards)) {
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

				// A set released early in a year can still carry the year before.
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

	// Equal scores: newest set first, the likelier card for a collector of
	// current sets. This is a guess, and the benchmark shows what it costs.
	const candidates = [...byId.values()]
		.sort((a, b) => b.score - a.score || b.releaseDate.localeCompare(a.releaseDate))
		.slice(0, limit);

	return {candidates, ms: Math.round(now() - started), searched};
}
