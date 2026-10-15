// What a scanned card is worth, for the valuable card highlight and the
// rising price mark (Eric, 2026-10-15, after DittoDex's chime for valuable
// cards): the price the card page leads with (js/price-view.js), for the
// tray card's finish and language, in reais, and Cardmarket's 30 day trend.
//
// - The value is js/prices.js copyValue for a copy of that card, finish, and
//   language: TCGplayer's market price converted with the dollar rate (or
//   another finish's price for a finish the card does not list, as the card
//   page does). With no US price or no dollar rate, Cardmarket's trend price
//   for the finish converted with the euro rate, as the card page shows it
//   second. Japanese, Korean, and Chinese prints have none (their records'
//   prices are not known to be for them, DESIGN.md section 10).
// - valuable: the value is at or above the threshold set in Scan.
// - rising: Cardmarket's 7 day average is up on its 30 day average by at
//   least the rise threshold (prices.js cardmarketTrend, rising).
//
// Never invents a price: no price leaves brl null, and a card with no price
// is never valuable.
//
// No DOM, so Node can test it (tests/scan-worth.test.mjs); the settings
// are kept in the storage passed (localStorage in the app).

import {isAsian} from '../languages.js';
import {cardmarketTrend, copyValue, eurToBrl, extractPrices, finishOf, RISE_DEFAULT, RISE_KEY, riseThreshold, risingBy} from '../prices.js';

// The settings' starting values: highlight cards worth R$ 50 or more, mark
// a price up 15 % or more, no chime.
export const WORTH_DEFAULTS = {chime: false, min: 50, rise: RISE_DEFAULT};

const MIN_KEY = 'card-tracker:scan-worth-min';
const CHIME_KEY = 'card-tracker:scan-chime';

function storage() {
	try {
		return globalThis.localStorage || null;
	}
	catch {
		return null;
	}
}

// The settings as kept on this phone: {min, rise, chime}, min and rise
// null when switched off. Storage out of reach gives the defaults.
export function worthSettings(store = storage()) {
	try {
		const min = store ? store.getItem(MIN_KEY) : null;
		const chime = store ? store.getItem(CHIME_KEY) : null;

		return {
			chime: chime === 'on',
			min: min === 'off' ? null : cleanThreshold(min) ?? WORTH_DEFAULTS.min,
			rise: riseThreshold(store),
		};
	}
	catch {
		return {...WORTH_DEFAULTS};
	}
}

// Keeps one setting: min or rise (a number, or null for off), or chime
// (true or false). Not kept when storage is out of reach.
export function saveWorthSetting(name, value, store = storage()) {
	const key = {chime: CHIME_KEY, min: MIN_KEY, rise: RISE_KEY}[name];

	try {
		if (store && key) {
			store.setItem(key, name === 'chime' ? (value ? 'on' : 'off') : value === null ? 'off' : String(value));
		}
	}
	catch {
		// Not kept; the next visit starts from what was kept before.
	}
}

// A threshold typed in Scan: a whole number of reais (or percent) from 1 to
// 100,000, or null when it is not one.
export function cleanThreshold(value, {max = 100000} = {}) {
	const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? '').replace(',', '.'));

	return Number.isFinite(n) && n >= 1 && n <= max ? Math.round(n) : null;
}

// The worth of a tray card ({card, language, variantId}) from its TCGdex
// record (with variants_detailed and their pricing) and the saved rates
// ({brlPerUsd}, {brlPerEur}). min: the value threshold in reais, or null
// when the highlight is off; rise: the rise threshold in percent, or null
// when the mark is off. Returns {brl, source, valuable, rising, change}:
// source is 'tcgplayer' or 'cardmarket' (null with no price), change the
// Cardmarket 7 against 30 day change as a share (0.18 for 18 %), or null.
export function scanWorth(item, record, {eurRates = null, min = WORTH_DEFAULTS.min, rates = null, rise = WORTH_DEFAULTS.rise} = {}) {
	const none = {brl: null, change: null, rising: false, source: null, valuable: false};

	if (!item || !item.card || !record || typeof record !== 'object') {
		return none;
	}

	const catalog = item.card.catalog || 'international';

	if (isAsian(catalog) || isAsian(item.language) || isAsian(item.card.lang)) {
		return none;
	}

	const entry = {card_id: item.card.id, catalog, language: item.language || null, variant_id: item.variantId || null};
	const value = copyValue(entry, record, {rates});
	const finish = finishOf(entry, extractPrices(record));
	const cardmarket = finish ? finish.cardmarket : null;
	let brl = value.kind === 'estimate' ? value.brl : null;
	let source = brl !== null ? 'tcgplayer' : null;

	if (brl === null && cardmarket && cardmarket.trend !== null) {
		brl = eurToBrl(cardmarket.trend, eurRates);
		source = brl !== null ? 'cardmarket' : null;
	}

	const trend = cardmarket ? cardmarketTrend(cardmarket, {rates: eurRates}) : null;
	const change = trend ? trend.change : null;

	return {
		brl: brl === null ? null : Math.round(brl * 100) / 100,
		change,
		rising: risingBy(trend, rise).rising,
		source,
		valuable: brl !== null && min !== null && brl >= min,
	};
}

// The rise as people read it: "18 %" -> 18.
export const risePercent = (change) => Math.round(change * 100);
