// The Ver na Liga link: Liga Pokémon's own search for one card.
//
// The app only builds a link. It never fetches from Liga or reads its pages
// (DESIGN.md section 10, "Liga Pokémon: a link, not a scraper"). No DOM here,
// so Node can test it directly (tests/liga.test.mjs).

const SEARCH = 'https://www.ligapokemon.com.br/?view=cards/search&card=';

// Liga hyphenates the uppercase mechanic suffixes that TCGdex writes after a
// space, and a query with the space finds nothing (DESIGN.md section 10,
// "Liga's name rules"). Uppercase, whole word, at the end of the name only:
// lowercase "ex", Mega and Radiant names, and every other name stay as they
// are.
const SUFFIX = / (EX|GX|V|VMAX|VSTAR|V-UNION)$/;

// Liga lists Nidoran♀ and Nidoran♂ both as "Nidoran", told apart by number.
// The symbol goes, and so does any space left before it.
const GENDER = /\s*[♀♂]/g;

export const ligaName = (name) => String(name).replace(GENDER, '').replace(SUFFIX, '-$1');

// A promo set. An English set's TCGdex ID ends in "p" (swshp, svp, smp) or
// its name says Promo. A Japanese set ID ends in "-P" (SV-P, M-P, SM-P); the
// lowercase "p" there marks a regular expansion (SM1p to SM5p). Liga finds a
// promo by its number alone, with no total (svp aside, see ligaQuery). `catalog` is the catalog's
// language ("ja" for the Japanese one), and anything else reads as English.
export const isPromoSet = (setId, setName, catalog) => {
	if (catalog === 'ja') {
		return (typeof setId === 'string' && /-P$/.test(setId)) || (typeof setName === 'string' && /promo|プロモ/i.test(setName));
	}

	// Trainer kits (tk-ex-p, tk-xy-p) end in "p" for Plusle and Pikachu, not
	// promo, and keep their total.
	return (typeof setId === 'string' && /p$/.test(setId) && !setId.startsWith('tk-')) || (typeof setName === 'string' && /promo/i.test(setName));
};

// The total is written the way the card prints it. A lettered subset number
// (GG44, TG03) puts the same letters on the total, "GG44/GG70", because
// "GG44/70" finds nothing. A zero-padded number pads the total to the same
// width, "013/094" and "039/091", while vintage "4/102" stays as it is.
const NUMBER = /^([A-Za-z]*)(\d+)/;

function printedTotal(localId, official) {
	const match = NUMBER.exec(localId);

	return match ? match[1] + String(official).padStart(match[2].length, '0') : String(official);
}

// Generations' Radiant Collection (TCGdex set g1, RC1 to RC32) prints the
// main set's total with no letters: "Swirlix (RC19/83)", never "RC19/RC32".
const isRadiantCollection = (setId, localId) => setId === 'g1' && /^RC\d/.test(localId);

// McDonald's Collection 2023 (TCGdex set 2023sv) pads both sides to three
// digits, "Cetitan (005/015)", though TCGdex gives localId 5 and an official
// count of 15.
const isMcDonalds2023 = (setId, setName) => setId === '2023sv' || (typeof setName === 'string' && /McDonald/i.test(setName) && /2023/.test(setName));

const pad3 = (text) => (/^\d+$/.test(text) ? text.padStart(3, '0') : text);

// "Charizard-GX (20/147)": the English name, then TCGdex's localId over the
// set's cardCount.official, written the way the card prints it. Promos take
// the number alone, "Charizard-V (SWSH050)" and "Celebi (XY111)", except
// Scarlet & Violet promos (svp), which Liga writes over an infinity sign:
// "Dondozo (012/∞)". Null when any part is missing, so no wrong query is
// ever built.
export function ligaQuery({catalog, localId, name, official, setId, setName} = {}) {
	if (typeof name !== 'string' || !name.trim()) {
		return null;
	}

	if (typeof localId !== 'string' || !localId.trim()) {
		return null;
	}

	const liga = ligaName(name);

	if (catalog !== 'ja' && setId === 'svp') {
		return `${liga} (${pad3(localId)}/∞)`;
	}

	if (isPromoSet(setId, setName, catalog)) {
		return `${liga} (${localId})`;
	}

	if (!Number.isInteger(official) || official <= 0) {
		return null;
	}

	if (isRadiantCollection(setId, localId)) {
		return `${liga} (${localId}/${official})`;
	}

	if (catalog !== 'ja' && isMcDonalds2023(setId, setName)) {
		return `${liga} (${pad3(localId)}/${pad3(String(official))})`;
	}

	return `${liga} (${localId}/${printedTotal(localId, official)})`;
}

export function ligaUrl(card) {
	const text = ligaQuery(card);

	return text ? SEARCH + encodeURIComponent(text) : null;
}
