// Card prices: what a card is worth, and how sure the app is of it.
//
// Brazil first (DESIGN.md section 10). The Brazilian price is Liga Pokémon's,
// typed in by the owner from Liga's own page: the app opens Liga with the Ver
// na Liga link and never fetches from it. It is kept on each copy as
//
//   price_manual: {low_nm, avg, currency: 'BRL', source, date}
//
// low_nm is Liga's "Lowest NM price" and avg its "Average price", both in
// reais; date is the day the owner read them (YYYY-MM-DD).
//
// The US market price (TCGplayer, in US dollars) comes with each TCGdex card
// record and is shown only as a reference, converted to reais with a daily
// rate from frankfurter.dev. Anything worked out from it is an estimate and
// says so. TCGdex also embeds Cardmarket (EUR), shown beside it as the EU
// market comparison, converted the same way with its own daily rate, with a
// rising, falling, or steady trend from its 7 and 30 day averages. Totals
// never use Cardmarket: they take the Liga price, else the US estimate, so
// one number never mixes two markets.
//
// Never invent a price: a missing price stays missing, and an unknown value
// is never counted as zero.
//
// No DOM here, so Node can test it directly (tests/prices.test.mjs).

// ------------------------------------------------------------ numbers

// To the cent, half away from zero. EPSILON keeps 1.005 from rounding down.
export function roundCents(value) {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return null;
	}

	const sign = value < 0 ? -1 : 1;

	return (sign * Math.round((Math.abs(value) + Number.EPSILON) * 100)) / 100;
}

// A price from TCGdex: a positive finite number, or null. TCGdex writes 0
// where it has no price (the Master Ball reverse's Cardmarket trend), and 0
// is not a price.
const price = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);

const MONEY = {
	BRL: new Intl.NumberFormat('pt-BR', {currency: 'BRL', style: 'currency'}),
	EUR: new Intl.NumberFormat('pt-BR', {currency: 'EUR', style: 'currency'}),
	USD: new Intl.NumberFormat('pt-BR', {currency: 'USD', style: 'currency'}),
};

// Intl puts a no-break space after the symbol. Kept, so "R$" never wraps
// away from its number.
export function formatMoney(value, currency = 'BRL') {
	const rounded = roundCents(value);

	return rounded === null || !MONEY[currency] ? null : MONEY[currency].format(rounded);
}

export const formatBrl = (value) => formatMoney(value, 'BRL');

// For a tile: whole reais from R$ 100 up, cents below.
const COMPACT = new Intl.NumberFormat('pt-BR', {currency: 'BRL', maximumFractionDigits: 0, minimumFractionDigits: 0, style: 'currency'});

export function formatBrlCompact(value) {
	const rounded = roundCents(value);

	if (rounded === null) {
		return null;
	}

	return rounded >= 100 ? COMPACT.format(rounded) : MONEY.BRL.format(rounded);
}

// What someone types for an amount in reais: "45,90", "45.90", "R$ 1.234,56",
// "1234". A comma is the decimal mark and dots group thousands; with no comma,
// a single dot followed by one or two digits is the decimal mark. Returns the
// amount to the cent, null for an empty field, or NaN for anything that is
// not an amount above zero.
export function parseBrl(text) {
	let value = String(text ?? '').replace(/R\$|\s/gi, '');

	if (!value) {
		return null;
	}

	if (value.includes(',')) {
		if ((value.match(/,/g) || []).length > 1) {
			return NaN;
		}

		value = value.replace(/\./g, '').replace(',', '.');
	}
	else if (!/^\d+\.\d{1,2}$/.test(value)) {
		value = value.replace(/\./g, '');
	}

	if (!/^\d+(\.\d+)?$/.test(value)) {
		return NaN;
	}

	const amount = roundCents(Number(value));

	return amount > 0 ? amount : NaN;
}

// ---------------------------------------------------------------- dates

// The phone's own calendar day, YYYY-MM-DD.
export function today(now = new Date()) {
	const pad = (n) => String(n).padStart(2, '0');

	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Whole days from one YYYY-MM-DD to another, or null.
function daysBetween(from, to) {
	const a = Date.parse(`${from}T00:00:00Z`);
	const b = Date.parse(`${to}T00:00:00Z`);

	return Number.isNaN(a) || Number.isNaN(b) ? null : Math.round((b - a) / DAY_MS);
}

// "today", "yesterday", "12 days ago", "3 months ago", "2 years ago". Null for
// a date that cannot be read or lies ahead of today.
export function ageText(date, now = new Date()) {
	const days = daysBetween(String(date || '').slice(0, 10), today(now));

	if (days === null || days < 0) {
		return null;
	}

	if (days === 0) {
		return 'today';
	}

	if (days === 1) {
		return 'yesterday';
	}

	if (days < 60) {
		return `${days} days ago`;
	}

	if (days < 730) {
		return `${Math.floor(days / 30)} months ago`;
	}

	return `${Math.floor(days / 365)} years ago`;
}

// The calendar day of a TCGdex timestamp, "2026-09-30T22:55:09.938Z".
const dayOf = (stamp) => (typeof stamp === 'string' && /^\d{4}-\d{2}-\d{2}/.test(stamp) ? stamp.slice(0, 10) : null);

// ------------------------------------------------------- manual prices

export const LIGA_SOURCE = 'Liga Pokémon';

export const MANUAL_FIELDS = {avg: 'Average price', low_nm: 'Lowest NM price'};

// A clean price_manual from what the editor holds, or null when neither
// amount is given. low_nm and avg are numbers in reais or null. Throws on an
// amount that is not above zero or a date that is not YYYY-MM-DD.
export function cleanManualPrice({avg = null, date, low_nm: lowNm = null, source} = {}, now = new Date()) {
	const amount = (value, label) => {
		if (value === null || value === undefined || value === '') {
			return null;
		}

		const parsed = typeof value === 'number' ? roundCents(value) : parseBrl(value);

		if (parsed === null) {
			return null;
		}

		if (!(parsed > 0)) {
			throw new Error(`${label} must be an amount in reais above zero, such as 45,90.`);
		}

		return parsed;
	};
	const low = amount(lowNm, MANUAL_FIELDS.low_nm);
	const average = amount(avg, MANUAL_FIELDS.avg);

	if (low === null && average === null) {
		return null;
	}

	const day = date ? String(date) : today(now);

	if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
		throw new Error('The date must be a day such as 2026-10-01.');
	}

	return {
		avg: average,
		currency: 'BRL',
		date: day,
		low_nm: low,
		source: String(source ?? '').trim() || LIGA_SOURCE,
	};
}

// The copy's Liga price when it holds a usable one, else null.
export function manualPrice(entry) {
	const manual = entry && entry.price_manual;

	if (!manual || typeof manual !== 'object' || manual.currency !== 'BRL') {
		return null;
	}

	const lowNm = price(manual.low_nm);
	const avg = price(manual.avg);

	if (lowNm === null && avg === null) {
		return null;
	}

	return {avg, currency: 'BRL', date: dayOf(manual.date), low_nm: lowNm, source: manual.source || LIGA_SOURCE};
}

// The newest Liga price among several copies, or null.
export function newestManual(entries) {
	let best = null;

	for (const entry of entries || []) {
		const manual = manualPrice(entry);

		if (manual && (!best || String(manual.date || '') > String(best.date || ''))) {
			best = manual;
		}
	}

	return best;
}

// The reais a Liga price stands for: the basis field ('avg' or 'low_nm')
// when given, else the other one. Returns {brl, field} or null.
function ligaAmount(manual, basis) {
	const other = basis === 'low_nm' ? 'avg' : 'low_nm';
	const first = basis === 'low_nm' ? 'low_nm' : 'avg';

	if (manual[first] !== null) {
		return {brl: manual[first], field: first};
	}

	return manual[other] !== null ? {brl: manual[other], field: other} : null;
}

// --------------------------------------------------- finishes and markets

// Some cards list their printings with variantId "generated", a placeholder
// that names no printing (js/monprice.js).
const hasRealId = (variant) => Boolean(variant && variant.variantId && variant.variantId !== 'generated');

// TCGdex localizes the variant words on a Portuguese record ("Reverse",
// "Poké Bola"), so they are folded before they are compared.
const fold = (text) => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[\s_-]+/g, '');

const finishType = (variant) => {
	const type = fold(variant.type);

	return type === 'holo' || type === 'holofoil' ? 'holo' : type === 'reverse' || type === 'reverseholo' ? 'reverse' : type === 'normal' ? 'normal' : type;
};

const ballOf = (variant) => {
	const foil = fold(variant.foil);

	return foil === 'pokeball' || foil === 'pokebola' ? 'pokeball' : foil === 'masterball' || foil === 'masterbola' ? 'masterball' : null;
};

const firstEdition = (variant) => (variant.stamp || []).some((stamp) => fold(stamp) === '1stedition');

const TYPE_LABELS = {holo: 'Holo', normal: 'Normal', reverse: 'Reverse holo'};
const BALL_LABELS = {masterball: 'Master Ball pattern', pokeball: 'Poké Ball pattern'};

const sentence = (text) => {
	const words = String(text).replace(/_+/g, ' ').replace(/-(?=\D)|(?<=\D)-/g, ' ');

	return words.charAt(0).toUpperCase() + words.slice(1);
};

// A finish's name in English, read the same way on an English or a
// Portuguese record: "Reverse holo, Poké Ball pattern".
export function finishName(variant) {
	if (!variant) {
		return 'Unknown finish';
	}

	const type = finishType(variant);
	const parts = [TYPE_LABELS[type] || sentence(variant.type || 'Unknown')];

	if (variant.subtype) {
		parts.push(sentence(variant.subtype));
	}

	const ball = ballOf(variant);

	if (ball) {
		parts.push(BALL_LABELS[ball]);
	}
	else if (variant.foil) {
		parts.push(`${sentence(variant.foil)} foil`);
	}

	for (const stamp of variant.stamp || []) {
		parts.push(fold(stamp) === '1stedition' ? '1st Edition stamp' : `${sentence(stamp)} stamp`);
	}

	return parts.join(', ');
}

// TCGplayer's finish words, as TCGdex keys them, in the order to look for
// them. Seen on 2026-10-01: normal, holofoil, reverse-holofoil (sv08.5-001,
// base1-4, me01-001) and 1st-edition-holofoil, unlimited-holofoil (neo1-9).
function tcgplayerKeys(type, isFirst) {
	const word = type === 'holo' ? 'holofoil' : type === 'reverse' ? 'reverse-holofoil' : 'normal';

	if (isFirst) {
		return type === 'normal' ? ['1st-edition', '1st-edition-normal'] : [`1st-edition-${word}`];
	}

	return type === 'normal' ? ['normal', 'unlimited', 'unlimited-normal'] : [word, `unlimited-${word}`];
}

const TCGPLAYER_FIELDS = ['lowPrice', 'midPrice', 'highPrice', 'marketPrice', 'directLowPrice'];

function tcgplayerPrice(block, key, unit, updated) {
	const prices = {};

	for (const field of TCGPLAYER_FIELDS) {
		prices[field] = price(block[field]);
	}

	if (TCGPLAYER_FIELDS.every((field) => prices[field] === null)) {
		return null;
	}

	return {...prices, date: dayOf(updated), key, productId: block.productId ?? null, unit: unit || 'USD'};
}

// The TCGplayer price block for one finish. Each variant's pricing carries
// the whole product's finishes (a normal print's pricing lists normal and
// reverse-holofoil), so the finish word picks one. A Poké Ball or Master Ball
// reverse is its own product whose only block is "holofoil"; that block is
// taken when its product is the variant's own and no other printing of the
// card shares it.
function pickTcgplayer(tcgplayer, variant, siblings) {
	if (!tcgplayer || typeof tcgplayer !== 'object') {
		return null;
	}

	const type = finishType(variant);
	const blocks = Object.entries(tcgplayer).filter(([, value]) => value && typeof value === 'object');

	for (const key of tcgplayerKeys(type, firstEdition(variant))) {
		const block = tcgplayer[key];

		if (block && typeof block === 'object') {
			return tcgplayerPrice(block, key, tcgplayer.unit, tcgplayer.updated);
		}
	}

	const own = variant.thirdParty && variant.thirdParty.tcgplayer;
	const shared = siblings.some((other) => other !== variant && other.thirdParty && other.thirdParty.tcgplayer === own);

	if (own && !shared && blocks.length === 1 && blocks[0][1].productId === own) {
		return tcgplayerPrice(blocks[0][1], blocks[0][0], tcgplayer.unit, tcgplayer.updated);
	}

	return null;
}

// Cardmarket's guide gives each product plain fields and "-holo" ones; the
// -holo fields are the reverse holo's (on the Master Ball reverse the plain
// trend is 0 and trend-holo 2.06). A holo card takes the plain fields: Base
// Set Charizard's plain trend is 596.13 against a trend-holo of 123.63, and
// Neo Genesis Lugia's 676.98 against 48.89, so the -holo fields there are
// not the holo card's price. fields says which set was read.
function pickCardmarket(cardmarket, variant) {
	if (!cardmarket || typeof cardmarket !== 'object') {
		return null;
	}

	const suffix = finishType(variant) === 'reverse' ? '-holo' : '';
	const out = {};

	for (const field of ['avg', 'low', 'trend', 'avg1', 'avg7', 'avg30']) {
		out[field] = price(cardmarket[field + suffix]);
	}

	if (Object.values(out).every((value) => value === null)) {
		return null;
	}

	return {...out, date: dayOf(cardmarket.updated), fields: suffix ? 'holo' : 'plain', productId: cardmarket.idProduct ?? null, shared: [], unit: cardmarket.unit || 'EUR'};
}

// How far the recent Cardmarket average must sit from the 30 day average,
// as a share of the 30 day average, before the trend is called rising or
// falling rather than steady. Both are averages of sold prices, so a few
// percent comes and goes with one sale's condition or seller; 5% is past
// that noise, and still catches a move worth a collector's notice.
export const TREND_THRESHOLD = 0.05;

// The move must also be worth about R$ 0,50, converted, before it counts: a
// bulk card going from 0,10 to 0,12 euro is 20% up and still steady to
// anyone holding it. With no euro rate saved yet, TREND_MIN_EUR stands in
// (R$ 0,50 at about R$ 6,25 per euro).
export const TREND_MIN_BRL = 0.5;
export const TREND_MIN_EUR = 0.08;

// The Cardmarket trend for one finish's prices (extractPrices' cardmarket):
//   {direction: 'rising' | 'falling' | 'steady', recent, recentField, avg30, change}
// recent is the 7 day average, or the 1 day average when TCGdex gives no 7
// day one (recentField says which); change is recent against avg30 as a
// fraction, to four places. Rising or falling needs both the 5% share and
// the R$ 0,50 difference, converted with rates (a euro rate, {brlPerEur}).
// Null when avg30 or both recent averages are missing: no trend is guessed.
export function cardmarketTrend(cardmarket, {rates = null} = {}) {
	if (!cardmarket || typeof cardmarket !== 'object') {
		return null;
	}

	const avg30 = price(cardmarket.avg30);
	const recentField = price(cardmarket.avg7) !== null ? 'avg7' : price(cardmarket.avg1) !== null ? 'avg1' : null;

	if (avg30 === null || !recentField) {
		return null;
	}

	const recent = cardmarket[recentField];

	// Rounded so 2.1 against 2 is exactly 5%, not a hair under.
	const change = Math.round((recent / avg30 - 1) * 10000) / 10000;
	const gap = Math.abs(recent - avg30);
	const gapBrl = eurToBrl(gap, rates);
	const large = gapBrl !== null ? roundCents(gapBrl) >= TREND_MIN_BRL : Math.round(gap * 10000) / 10000 >= TREND_MIN_EUR;
	const direction = !large ? 'steady' : change >= TREND_THRESHOLD ? 'rising' : change <= -TREND_THRESHOLD ? 'falling' : 'steady';

	return {avg30, change, direction, recent, recentField};
}

// The card-level finish words, for a record with no variants_detailed.
const KEY_FINISHES = {
	'1st-edition': {stamp: ['1st-edition'], type: 'normal'},
	'1st-edition-holofoil': {stamp: ['1st-edition'], type: 'holo'},
	holofoil: {type: 'holo'},
	normal: {type: 'normal'},
	'reverse-holofoil': {type: 'reverse'},
	'unlimited-holofoil': {subtype: 'unlimited', type: 'holo'},
};

// Every finish of a card with its prices:
//   [{variantId, label, variant, tcgplayer, cardmarket, shared}]
// tcgplayer is {marketPrice, lowPrice, midPrice, highPrice, directLowPrice,
// date, key, productId, unit} or null. cardmarket is {avg, low, trend, avg1,
// avg7, avg30, date, fields, productId, shared, unit} or null, each price
// null when missing. shared names the other finishes whose TCGplayer price is
// the very same block (same product, same finish word), and cardmarket.shared
// those whose Cardmarket price is (same product, same fields), so the price
// may not tell them apart.
//
// Prices come from each variants_detailed entry's own pricing. A record with
// no variants_detailed falls back to the card-level pricing, one finish per
// TCGplayer finish word, with variantId null.
export function extractPrices(card) {
	if (!card || typeof card !== 'object') {
		return [];
	}

	const variants = (Array.isArray(card.variants_detailed) ? card.variants_detailed : []).filter(hasRealId);
	let finishes;

	if (variants.length) {
		finishes = variants.map((variant) => {
			const pricing = variant.pricing || {};

			return {
				cardmarket: pickCardmarket(pricing.cardmarket, variant),
				label: finishName(variant),
				shared: [],
				tcgplayer: pickTcgplayer(pricing.tcgplayer, variant, variants),
				variant,
				variantId: variant.variantId,
			};
		});
	}
	else {
		const pricing = card.pricing || {};
		const tcgplayer = pricing.tcgplayer && typeof pricing.tcgplayer === 'object' ? pricing.tcgplayer : {};
		const keys = Object.keys(tcgplayer).filter((key) => KEY_FINISHES[key] && tcgplayer[key] && typeof tcgplayer[key] === 'object');

		finishes = keys.map((key) => {
			const variant = {...KEY_FINISHES[key]};

			return {
				cardmarket: pickCardmarket(pricing.cardmarket, variant),
				label: finishName(variant),
				shared: [],
				tcgplayer: tcgplayerPrice(tcgplayer[key], key, tcgplayer.unit, tcgplayer.updated),
				variant,
				variantId: null,
			};
		});
	}

	for (const finish of finishes) {
		if (finish.tcgplayer) {
			finish.shared = finishes
				.filter((other) => other !== finish && other.tcgplayer && other.tcgplayer.key === finish.tcgplayer.key && other.tcgplayer.productId === finish.tcgplayer.productId)
				.map((other) => other.label);
		}

		const cardmarket = finish.cardmarket;

		if (cardmarket && cardmarket.productId !== null) {
			cardmarket.shared = finishes
				.filter((other) => other !== finish && other.cardmarket && other.cardmarket.productId === cardmarket.productId && other.cardmarket.fields === cardmarket.fields)
				.map((other) => other.label);
		}
	}

	return finishes;
}

// monprice's finish words, for a copy whose finish was never matched to a
// variant (finish_raw), to the finish types above.
const RAW_FINISHES = {
	FIRST_EDITION: (finish) => firstEdition(finish.variant),
	HOLOFOIL: (finish) => finishType(finish.variant) === 'holo' && !firstEdition(finish.variant) && !ballOf(finish.variant),
	NORMAL: (finish) => finishType(finish.variant) === 'normal' && !firstEdition(finish.variant),
	REVERSE_HOLOFOIL: (finish) => finishType(finish.variant) === 'reverse' && !ballOf(finish.variant) && !(finish.variant.stamp || []).length,
	UNLIMITED: (finish) => finishType(finish.variant) === 'normal' && !firstEdition(finish.variant),
	UNLIMITED_HOLOFOIL: (finish) => finishType(finish.variant) === 'holo' && !firstEdition(finish.variant) && !ballOf(finish.variant),
};

// The finish a copy is, among a card's finishes: by its variant ID; else, for
// a copy with no variant, the card's only finish or the one finish its
// monprice word fits. Null when that cannot be told.
export function finishOf(entry, finishes) {
	if (!entry || !finishes || !finishes.length) {
		return null;
	}

	if (entry.variant_id) {
		const hit = finishes.find((finish) => finish.variantId === entry.variant_id);

		if (hit) {
			return hit;
		}
	}

	if (entry.variant_id && finishes.some((finish) => finish.variantId)) {
		return null;
	}

	if (finishes.length === 1) {
		return finishes[0];
	}

	const fits = RAW_FINISHES[entry.finish_raw];
	const found = fits ? finishes.filter(fits) : [];

	return found.length === 1 ? found[0] : null;
}

// --------------------------------------------------------- exchange rate

// frankfurter.dev, free and without a key (checked 2026-10-01). v2 answers
// [{date, base, quote, rate}]; v1 answers {base, date, rates: {BRL}} and
// carries a Deprecation header naming v2 as its successor, so it is only the
// fallback. Both answer the same shapes for base=EUR (checked 2026-10-01:
// v2 [{"date":"2026-10-01","base":"EUR","quote":"BRL","rate":5.8814}]).
export const RATES_URL = 'https://api.frankfurter.dev/v2/rates?base=USD&quotes=BRL';
export const RATES_URL_V1 = 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=BRL';
export const EURO_RATES_URL = 'https://api.frankfurter.dev/v2/rates?base=EUR&quotes=BRL';
export const EURO_RATES_URL_V1 = 'https://api.frankfurter.dev/v1/latest?base=EUR&symbols=BRL';

const RATES_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Each currency's rate is asked for, saved, and stood in for on its own, so
// a euro request that fails never costs the dollar rate, or the reverse.
// The dollar rate keeps the key it has always had.
const CURRENCIES = {
	EUR: {field: 'brlPerEur', key: 'cardTracker.rates.eur', urls: [EURO_RATES_URL, EURO_RATES_URL_V1]},
	USD: {field: 'brlPerUsd', key: 'cardTracker.rates', urls: [RATES_URL, RATES_URL_V1]},
};

// {<field>: rate, date} for one base currency from either version's answer,
// or null.
function parseRate(json, base) {
	const {field} = CURRENCIES[base];

	if (Array.isArray(json)) {
		const row = json.find((item) => item && item.base === base && item.quote === 'BRL');

		return row && price(row.rate) && dayOf(row.date) ? {[field]: row.rate, date: dayOf(row.date)} : null;
	}

	if (json && typeof json === 'object' && json.base === base && json.rates && price(json.rates.BRL) && dayOf(json.date)) {
		return {[field]: json.rates.BRL, date: dayOf(json.date)};
	}

	return null;
}

// {brlPerUsd, date} from either version's answer, or null.
export const parseRates = (json) => parseRate(json, 'USD');

// {brlPerEur, date} from either version's answer, or null.
export const parseEuroRates = (json) => parseRate(json, 'EUR');

function defaultStorage() {
	try {
		return globalThis.localStorage || null;
	}
	catch {
		return null;
	}
}

function savedRate(storage, base) {
	const {field, key} = CURRENCIES[base];

	try {
		const saved = JSON.parse(storage.getItem(key));

		return saved && price(saved[field]) && dayOf(saved.date) ? {[field]: saved[field], date: saved.date, fetchedAt: Number(saved.fetchedAt) || 0} : null;
	}
	catch {
		return null;
	}
}

// The dollar rate saved on this phone: {brlPerUsd, date, fetchedAt}, or null.
export const savedRates = (storage = defaultStorage()) => savedRate(storage, 'USD');

// The euro rate saved on this phone: {brlPerEur, date, fetchedAt}, or null.
export const savedEuroRates = (storage = defaultStorage()) => savedRate(storage, 'EUR');

function saveRate(storage, base, rates) {
	try {
		storage.setItem(CURRENCIES[base].key, JSON.stringify(rates));
	}
	catch {
		// Not saved; the next visit asks again.
	}
}

const pending = {};

// One currency's rate, asking frankfurter at most once a day.
async function rateFor(base, {fetchFn, now, storage}) {
	const saved = savedRate(storage, base);

	if (saved && now - saved.fetchedAt < RATES_MAX_AGE_MS) {
		return {...saved, fresh: true};
	}

	if (!pending[base]) {
		pending[base] = (async () => {
			for (const url of CURRENCIES[base].urls) {
				try {
					const response = await fetchFn(url);

					if (response.ok) {
						const parsed = parseRate(await response.json(), base);

						if (parsed) {
							return parsed;
						}
					}
				}
				catch {
					// Offline or refused; try the next, then the saved rate.
				}
			}

			return null;
		})().finally(() => {
			pending[base] = null;
		});
	}

	const fetched = await pending[base];

	if (fetched) {
		const rates = {...fetched, fetchedAt: now};

		saveRate(storage, base, rates);

		return {...rates, fresh: true};
	}

	return saved ? {...saved, fresh: false} : null;
}

// The dollar rate to use, asking frankfurter at most once a day. Returns
// {brlPerUsd, date, fetchedAt, fresh}, where fresh is false when the saved
// rate stood in for a request that failed (offline); or null when there is
// no rate at all yet.
export function exchangeRates({fetchFn = globalThis.fetch, now = Date.now(), storage = defaultStorage()} = {}) {
	return rateFor('USD', {fetchFn, now, storage});
}

// The euro rate, the same way: {brlPerEur, date, fetchedAt, fresh} or null.
export function euroRates({fetchFn = globalThis.fetch, now = Date.now(), storage = defaultStorage()} = {}) {
	return rateFor('EUR', {fetchFn, now, storage});
}

// US dollars to reais, unrounded so a sum rounds once; null when either is
// missing.
export function usdToBrl(usd, rates) {
	return price(usd) !== null && rates && price(rates.brlPerUsd) ? usd * rates.brlPerUsd : null;
}

// Euros to reais, the same way, with a euro rate.
export function eurToBrl(eur, rates) {
	return price(eur) !== null && rates && price(rates.brlPerEur) ? eur * rates.brlPerEur : null;
}

// ------------------------------------------------------------ values

// One copy's value in reais:
//   {kind: 'liga', brl, field, date, source}  the owner's Liga price
//   {kind: 'estimate', brl, usd, date, rateDate}  TCGplayer market, converted
//   {kind: 'unknown', usd}  no price, or a US price with no rate to convert
// basis picks the Liga field: 'avg' (the default) or 'low_nm', falling back
// to the other when only one was typed.
export function copyValue(entry, card, {basis = 'avg', rates = null} = {}) {
	const manual = manualPrice(entry);

	if (manual) {
		const amount = ligaAmount(manual, basis);

		return {brl: amount.brl, date: manual.date, field: amount.field, kind: 'liga', source: manual.source};
	}

	const finish = finishOf(entry, extractPrices(card));
	const usd = finish && finish.tcgplayer ? finish.tcgplayer.marketPrice : null;
	const brl = usdToBrl(usd, rates);

	if (brl === null) {
		return {kind: 'unknown', usd};
	}

	return {brl, date: finish.tcgplayer.date, kind: 'estimate', rateDate: rates.date, usd};
}

// The card record for a copy, from a Map or an object keyed by
// "<catalog>|<card id>" (js/catalog.js indexKey) or by card ID alone.
function recordFor(cardsById, entry) {
	if (!cardsById || !entry) {
		return null;
	}

	const keys = [`${entry.catalog || 'international'}|${entry.card_id}`, entry.card_id];
	const get = (key) => (cardsById instanceof Map ? cardsById.get(key) : cardsById[key]);

	for (const key of keys) {
		const record = get(key);

		if (record) {
			return record;
		}
	}

	return null;
}

// A name for a card in the stats: the record's own, a card index
// localization, or the copy's source name.
function cardName(entry, record) {
	if (record && typeof record.name === 'string' && record.name) {
		return record.name;
	}

	const localizations = (record && record.localizations) || {};
	const localized = localizations[entry.language] || localizations.en || Object.values(localizations)[0];

	return (localized && localized.name) || entry.name_local || entry.card_id || 'Unknown card';
}

// Statistics for any set of copies the caller passes (a binder, a list, a
// set, the Trade spares, the whole collection). cardsById holds the TCGdex
// card records; a record without pricing (a card index record) leaves every
// copy without a Liga price unknown. Returns
//   {count, priced, total, average, highest, lowest, liga, estimate, unknown,
//    basis, rateDate}
// where total and average are in reais over priced copies only (null when
// none is priced), highest and lowest are {brl, kind, name, entry}, liga and
// estimate are {count, total}, and unknown is {count, noRate} (noRate counts
// copies with a US price but no exchange rate). An unknown never counts as
// zero.
export function listStats(entries, cardsById, {basis = 'avg', rates = null} = {}) {
	const stats = {
		average: null,
		basis: basis === 'low_nm' ? 'low_nm' : 'avg',
		count: 0,
		estimate: {count: 0, total: 0},
		highest: null,
		liga: {count: 0, total: 0},
		lowest: null,
		priced: 0,
		rateDate: null,
		total: null,
		unknown: {count: 0, noRate: 0},
	};
	let sum = 0;

	for (const entry of entries || []) {
		if (!entry || entry.deleted_at) {
			continue;
		}

		stats.count++;

		const record = recordFor(cardsById, entry);
		const value = copyValue(entry, record, {basis: stats.basis, rates});

		if (value.kind === 'unknown') {
			stats.unknown.count++;

			if (value.usd !== null && value.usd !== undefined) {
				stats.unknown.noRate++;
			}

			continue;
		}

		const bucket = value.kind === 'liga' ? stats.liga : stats.estimate;

		bucket.count++;
		bucket.total += value.brl;
		sum += value.brl;
		stats.priced++;

		if (value.kind === 'estimate') {
			stats.rateDate = value.rateDate;
		}

		const item = {brl: value.brl, entry, kind: value.kind, name: cardName(entry, record)};

		if (!stats.highest || value.brl > stats.highest.brl) {
			stats.highest = item;
		}

		if (!stats.lowest || value.brl < stats.lowest.brl) {
			stats.lowest = item;
		}
	}

	if (stats.priced) {
		stats.total = roundCents(sum);
		stats.average = roundCents(sum / stats.priced);
	}

	stats.liga.total = roundCents(stats.liga.total);
	stats.estimate.total = roundCents(stats.estimate.total);

	return stats;
}

// The total and how much of it is Liga, estimated, or unknown, for an
// opening's summary or a card's detail:
//   {total, liga: {count, total}, estimated: {count, total}, unknown: {count}}
export function valueOf(entries, cardsById, options = {}) {
	const stats = listStats(entries, cardsById, options);

	return {
		estimated: stats.estimate,
		liga: stats.liga,
		total: stats.total,
		unknown: {count: stats.unknown.count},
	};
}

// The value a tile shows for its copies (one card, possibly several
// copies): the newest Liga price among them, else the US estimate of the
// first copy that has one. Returns copyValue's shape or null when unknown.
export function tileValue(entries, card, {basis = 'avg', rates = null} = {}) {
	const live = (entries || []).filter((entry) => entry && !entry.deleted_at);
	let liga = null;

	for (const entry of live) {
		const manual = manualPrice(entry);

		if (manual && (!liga || String(manual.date || '') > String(liga.manual.date || ''))) {
			liga = {entry, manual};
		}
	}

	if (liga) {
		return copyValue(liga.entry, card, {basis, rates});
	}

	for (const entry of live) {
		const value = copyValue(entry, card, {basis, rates});

		if (value.kind === 'estimate') {
			return value;
		}
	}

	return null;
}
