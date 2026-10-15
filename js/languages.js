// The one language table: every language a copy can be printed in, and
// everything the app knows about each one (DESIGN.md section 3, "Languages").
// Every other module reads languages from here, never from a list of its
// own, so German, Spanish, and Italian can no longer be known in one place
// and missing in another (plans/audit-engineering.md E-31).
//
// One row per code, in the app's order: Portuguese and English first, then
// Japanese, Korean, and Chinese, then French, German, Italian, and Spanish
// (the copy sheet's order before the table). Flags, pickers, and copy
// sheets all list languages in this order.
//
//   code      what a copy stores in `language`
//   label     the English UI name ("Chinese (Simplified)")
//   flag      the flag-icons file it is shown with (js/flags.js)
//   chip      the short text where no flag fits ("CHS")
//   html      the lang attribute for its text, so the browser picks the font
//   catalog   the TCGdex catalog its prints are records in: Western prints
//             share the international records, Asian prints have their own
//   browse    TCGdex has a catalog in this language that the app browses
//             (the Sets language picker, wishlist search, list languages)
//   fallback  another catalog its copies may sit on: Korea prints many sets
//             under the Japanese codes (DESIGN.md section 5)
//   names     the PokeAPI species-name table its card names are written in,
//             with that language's PokeAPI ID, for Asian prints whose names
//             get an English name above them (js/names.js); en is the
//             English table every list reads
//   monprice  the codes monprice writes in its Language column and, for a
//             catalog, the middle part of its card IDs (DESIGN.md section 7)
//   liga      Ver na Liga can exist for a print in this language (DESIGN.md
//             section 10, "Languages on Liga"): whether Liga lists Korean
//             and Chinese prints is unchecked, so they get none
//   market    TCGdex's US and European market prices are for this
//             language's prints (DESIGN.md section 10, "The language gap")
//
// Nothing here touches the DOM, so Node can test it (tests/names.test.mjs).

export const LANGUAGES = [
	{browse: true, catalog: 'international', chip: 'PT', code: 'pt', flag: 'br', html: 'pt', label: 'Portuguese', liga: true, monprice: {language: ['pt']}},
	{browse: true, catalog: 'international', chip: 'EN', code: 'en', flag: 'us', html: 'en', label: 'English', liga: true, market: true, monprice: {language: ['en'], region: 'int'}, names: {id: 9, table: 'en'}},
	{asian: true, browse: true, catalog: 'ja', chip: 'JA', code: 'ja', flag: 'jp', html: 'ja', label: 'Japanese', liga: true, monprice: {language: ['ja', 'jp'], region: 'jp'}, names: {id: 11, table: 'ja'}},
	{asian: true, browse: true, catalog: 'ko', chip: 'KO', code: 'ko', fallback: 'ja', flag: 'kr', html: 'ko', label: 'Korean', monprice: {language: ['ko', 'kr'], region: 'kr'}, names: {id: 3, table: 'ko'}},
	{asian: true, browse: true, catalog: 'zh-cn', chip: 'CHS', code: 'zh-cn', flag: 'cn', html: 'zh-Hans', label: 'Chinese (Simplified)', monprice: {language: ['chs'], region: 'chs'}, names: {id: 12, table: 'zh-hans'}},
	{asian: true, browse: true, catalog: 'zh-tw', chip: 'CHT', code: 'zh-tw', flag: 'tw', html: 'zh-Hant', label: 'Chinese (Traditional)', monprice: {language: ['cht'], region: 'cht'}, names: {id: 4, table: 'zh-hant'}},
	{browse: true, catalog: 'international', chip: 'FR', code: 'fr', flag: 'fr', html: 'fr', label: 'French', liga: true, monprice: {language: ['fr']}},
	{catalog: 'international', chip: 'DE', code: 'de', flag: 'de', html: 'de', label: 'German', liga: true, monprice: {language: ['de']}},
	{catalog: 'international', chip: 'IT', code: 'it', flag: 'it', html: 'it', label: 'Italian', liga: true, monprice: {language: ['it']}},
	{catalog: 'international', chip: 'ES', code: 'es', flag: 'es', html: 'es', label: 'Spanish', liga: true, monprice: {language: ['es']}},
];

const BY_CODE = new Map(LANGUAGES.map((row) => [row.code, row]));

export const languageRow = (code) => BY_CODE.get(code) || null;

export const LANGUAGE_CODES = LANGUAGES.map((row) => row.code);

// Whether a code is one of the table's (a copy in it is understood).
export const isKnownLanguage = (code) => BY_CODE.has(code);

// --------------------------------------------------------- display

// The English name. A code the table does not know shows as itself, and a
// copy with no language recorded says so, never "null".
export function languageLabel(code) {
	if (!code) {
		return 'Language not set';
	}

	const row = languageRow(code);

	return row ? row.label : String(code);
}

export const languageChip = (code) => {
	const row = languageRow(code);

	return row ? row.chip : String(code).toUpperCase();
};

export const languageFlag = (code) => {
	const row = languageRow(code);

	return row ? row.flag : null;
};

export const htmlLang = (code) => {
	const row = languageRow(code);

	return row ? row.html : code;
};

// The table's order for any codes: known ones by their row, the rest after
// them by code.
export function languageRank(code) {
	const i = LANGUAGE_CODES.indexOf(code);

	return i === -1 ? LANGUAGE_CODES.length : i;
}

export const compareLanguages = (a, b) => languageRank(a) - languageRank(b) || String(a).localeCompare(String(b));

export const sortLanguages = (codes) => [...codes].sort(compareLanguages);

// ---------------------------------------------------------- catalogs

// The languages TCGdex has a catalog in, as [{code, label}] in the table's
// order: the Sets picker, the wishlist search, and list languages.
export const CATALOG_LANGUAGES = LANGUAGES.filter((row) => row.browse).map(({code, label}) => ({code, label}));

export const isCatalogLanguage = (code) => Boolean(languageRow(code) && languageRow(code).browse);

export const ASIAN_LANGUAGES = LANGUAGES.filter((row) => row.asian).map((row) => row.code);

export const isAsian = (code) => Boolean(languageRow(code) && languageRow(code).asian);

// The catalog a language's prints are records in. Any code that is not an
// Asian language reads as Western: international.
export const catalogFor = (code) => (isAsian(code) ? code : 'international');

// The catalogs, international first, then the Asian ones in table order.
export const CATALOGS = ['international', ...ASIAN_LANGUAGES];

// The language a catalog's records are written in.
export const catalogLanguage = (catalog) => (catalog === 'international' ? 'en' : catalog);

// The catalogs a copy in this language can be saved on: its own, then the
// one it falls back to (a Korean copy on a Japanese record).
export function catalogsOf(code) {
	const row = languageRow(code);

	return row && row.fallback ? [catalogFor(code), row.fallback] : [catalogFor(code)];
}

// The languages a copy on a record in this catalog can be printed in, in
// the table's order: every Western language on an international record, and
// Korean beside Japanese on a Japanese one. A hand-made card ('custom') can
// be in any of them.
export function copyLanguageCodes(catalog) {
	if (catalog === 'custom') {
		return [...LANGUAGE_CODES];
	}

	return LANGUAGES.filter((row) => catalogsOf(row.code).includes(catalog)).map((row) => row.code);
}

// ------------------------------------------------------------- names

// Asian catalog language -> the PokeAPI table its names are written in.
export const NAME_TABLES = Object.fromEntries(LANGUAGES.filter((row) => row.asian && row.names).map((row) => [row.code, row.names.table]));

// PokeAPI language ID -> the species-name table read for it.
export const POKEAPI_NAME_TABLES = Object.fromEntries(LANGUAGES.filter((row) => row.names).map((row) => [row.names.id, row.names.table]));

// ----------------------------------------------------------- monprice

// A monprice Language value ("KR", "chs") -> the code a copy stores, or
// undefined for one the table does not know.
const MONPRICE_LANGUAGES = new Map(LANGUAGES.flatMap((row) => row.monprice.language.map((raw) => [raw, row.code])));

export const monpriceLanguage = (raw) => MONPRICE_LANGUAGES.get(String(raw || '').trim().toLowerCase());

// The middle part of a monprice ID -> {catalog, lang, fallback?}: the
// catalog the card is a record in and its language there.
export const MONPRICE_REGIONS = Object.fromEntries(LANGUAGES.filter((row) => row.monprice.region).map((row) => [row.monprice.region, {
	catalog: row.catalog,
	lang: catalogLanguage(row.catalog),
	...(row.fallback ? {fallback: {catalog: row.fallback, lang: catalogLanguage(row.fallback)}} : {}),
}]));

// ------------------------------------------------------------- prices

// Whether Ver na Liga can be offered for a print in this language. A copy
// with no language recorded, or one the table does not know, reads as one
// that can.
export const hasLiga = (code) => !languageRow(code) || Boolean(languageRow(code).liga);

// Whether TCGdex's market prices are for prints in this language.
export const hasMarketPrices = (code) => Boolean(languageRow(code) && languageRow(code).market);

// ----------------------------------------------------- list languages
//
// A list (a checklist or a goal) names the languages it counts in its
// `languages` field. A list with no field counts a copy in any language:
// those are the lists made before a list's languages decided its ticks
// (plans/roadmap.md, "Open Decisions for Eric", settled 2026-10-15). A new
// checklist starts with Portuguese.

// The languages a list can be set to: the catalog languages, since a list
// shows the prints of its languages' catalogs.
export const LIST_LANGUAGE_CODES = CATALOG_LANGUAGES.map((row) => row.code);

export const NEW_LIST_LANGUAGES = ['pt'];

// The list languages among codes, once each, in the table's order.
export const cleanListLanguages = (codes) => sortLanguages(new Set((Array.isArray(codes) ? codes : []).filter((code) => LIST_LANGUAGE_CODES.includes(code))));

// What a list stores for a choice of languages: null (no field, any
// language) when every one is chosen, since that must count German,
// Spanish, Italian, and copies with no language too, which no set of codes
// can say; else the chosen codes.
export function listLanguagesToSave(codes) {
	if (codes === null) {
		return null;
	}

	const list = cleanListLanguages(codes);

	return list.length === LIST_LANGUAGE_CODES.length ? null : list;
}

// Whether a list names its own languages (a list with none counts any).
export const namesListLanguages = (goal) => cleanListLanguages(goal && goal.languages).length > 0;

// Whether a copy counts on a list: any live copy on a list that names no
// languages, else only a copy in one of them.
export function countsOnList(goal, entry) {
	if (!namesListLanguages(goal)) {
		return true;
	}

	return cleanListLanguages(goal.languages).includes(entry && entry.language);
}
