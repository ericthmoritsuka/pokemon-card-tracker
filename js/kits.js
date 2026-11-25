// Kits on HOTARU (plans/hotaru-bundles-plan.md, Eric 2026-11-25): several
// listed cards sold together at a price Eric types, or at a percent off the
// sum of their prices. The numbers and choices behind the Shop's Kits
// (js/shop-kits.js), kept free of the page so tests/kits.test.mjs reads
// them directly. supabase/store-bundles.sql holds the same price rule, and
// the server's is the one a buyer pays.

import {listedOf} from './shop.js';

// Best first, as js/scan/session.js CONDITIONS lists them; repeated here
// because that module reads the catalog.
const CONDITION_ORDER = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];

export const KIT_MIN = 2;
export const KIT_MAX = 20;
export const PERCENT_MIN = 1;
export const PERCENT_MAX = 90;
export const PERCENT_FORM_TEXT = `Type a discount from ${PERCENT_MIN}% to ${PERCENT_MAX}%, such as 5 or 7,5.`;

const cents = (brl) => Math.round(Number(brl) * 100);

// The sum of the cards' prices, in reais.
export const kitSum = (prices) => prices.reduce((sum, price) => sum + cents(price), 0) / 100;

// A kit's price from its rule and the sum of its cards: the typed price, or
// the sum minus the percent rounded down to the centavo (Eric's choice:
// R$ 15,00 at 5% is R$ 14,25), never below one centavo. Integer centavos,
// so 7,5% of R$ 10,00 is exactly R$ 9,25.
export function kitPrice({discount_pct: percent, price_brl: fixed, price_mode: mode}, sum) {
	if (mode === 'fixed') {
		return fixed === null || fixed === undefined ? null : cents(fixed) / 100;
	}

	if (percent === null || percent === undefined) {
		return null;
	}

	const tenths = Math.round(Number(percent) * 10);

	return Math.max(Math.floor(cents(sum) * (1000 - tenths) / 1000), 1) / 100;
}

// The percent a price works out to off a sum, rounded down to a whole
// percent: what HOTARU's badge says for a kit with a typed price. Null when
// the price is not below the sum.
export function percentOff(price, sum) {
	if (!(sum > 0) || !(price < sum)) {
		return null;
	}

	// Whole centavos, so R$ 9,00 off R$ 10,00 is 10%, not 9,999…%.
	return Math.floor((cents(sum) - cents(price)) * 100 / cents(sum));
}

// "5", "5%", "7,5", or "7.5" as a percent with one decimal, or the reason it
// is not one.
export function parsePercent(text) {
	const typed = String(text ?? '').replace(/\s|%/g, '').replace(',', '.');

	if (!typed) {
		return {error: null, value: null};
	}

	const value = /^\d+(\.\d)?$/.test(typed) ? Number(typed) : NaN;

	return value >= PERCENT_MIN && value <= PERCENT_MAX ? {error: null, value} : {error: PERCENT_FORM_TEXT, value: null};
}

const conditionRank = (entry) => {
	const at = CONDITION_ORDER.indexOf(entry && entry.condition);

	return at < 0 ? CONDITION_ORDER.length : at;
};

// Whether a listed copy can be sold now, from store_sync's last answer
// ({<id>: {status}}). A copy the answer does not name yet (published since)
// is taken to be.
const sellable = (entry, states) => {
	const state = states && states[entry.id];

	return !state || !state.status || state.status === 'available';
};

// The copy a group gives a kit: one listed and for sale, not in skip (the
// copies other kits or this one already hold), the best condition first,
// then the one added first, so the newest copies stay for single sales.
// prefer is a condition to keep when refilling. Null when none qualifies.
export function pickCopy(group, {prefer = null, skip = new Set(), states = null} = {}) {
	const free = listedOf(group).filter((entry) => !skip.has(entry.id) && sellable(entry, states));

	free.sort((a, b) => Number(b.condition === prefer && prefer !== null) - Number(a.condition === prefer && prefer !== null)
		|| conditionRank(a) - conditionRank(b)
		|| String(a.created_at || '').localeCompare(String(b.created_at || '')));

	return free[0] || null;
}

// The group a kit's card belongs to: the one listing that copy, else the
// one for the same card, language, and finish (the copy sold, so no group
// lists it any more). finishText(group) is the finish the listing was
// published with (js/shop-view.js finishName).
export function groupOfItem(item, groups, finishText) {
	const holding = groups.find((group) => listedOf(group).some((entry) => entry.id === item.listing_id));

	if (holding) {
		return holding;
	}

	return groups.find((group) => group.card_id === item.card_id
		&& (group.language || null) === (item.language || null)
		&& (finishText(group) || null) === (item.finish || null)) || null;
}

// What Publish does to a kit (plans/hotaru-bundles-plan.md section 4): each
// card whose copy is not available takes another listed copy of the same
// card, language, and finish, the same condition first. Returns {items, changed,
// missing}: the listing IDs in order, whether any changed, and the names of
// the cards no copy could fill (the kit keeps their old copy, and stays off
// HOTARU until one is back). skip holds the copies every other kit uses.
export function refillKit(kit, groups, {finishText = () => null, skip = new Set(), states = null} = {}) {
	const items = [];
	const missing = [];
	const used = new Set(skip);
	let changed = false;

	for (const item of kit.items || []) {
		used.add(item.listing_id);
	}

	for (const item of kit.items || []) {
		if (item.status === 'available') {
			items.push(item.listing_id);
			continue;
		}

		const group = groupOfItem(item, groups, finishText);
		const copy = group && group.price !== null ? pickCopy(group, {prefer: item.condition || null, skip: used, states}) : null;

		if (copy) {
			used.add(copy.id);
			items.push(copy.id);
			changed = true;
		}
		else {
			items.push(item.listing_id);
			missing.push(item.name);
		}
	}

	return {changed, items, missing};
}

// The copies every kit holds, but the one named, so a refill or a new kit
// does not take a copy another kit is counting on.
export function copiesInKits(kits, {except = null} = {}) {
	return new Set((kits || []).filter((kit) => kit.id !== except).flatMap((kit) => (kit.items || []).map((item) => item.listing_id)));
}

// What the kit's rule saves as, for save_bundle.
export function kitRecord({active = true, description = '', discount = null, id = null, items, mode, name, price = null}) {
	return {
		active,
		description: String(description || '').trim() || null,
		discount_pct: mode === 'percent' ? discount : null,
		id,
		items,
		name: String(name || '').trim(),
		price_brl: mode === 'fixed' ? price : null,
		price_mode: mode,
	};
}

// A kit's name when Eric has typed none: its cards' names, joined.
export function kitDefaultName(names) {
	const joined = names.join(' + ');

	return joined.length <= 80 ? joined : `${joined.slice(0, 79)}…`;
}

// An order's cards as the Shop lists them: singles as they come, and each
// kit's cards together under its name, with the kit's price (the sum of the
// shares the server split it into).
export function orderGroups(items) {
	const out = [];
	const kits = new Map();

	for (const item of items || []) {
		if (!item.bundle_name && !item.bundle_id) {
			out.push({item, kind: 'single'});
			continue;
		}

		const key = item.bundle_id || item.bundle_name;

		if (!kits.has(key)) {
			const kit = {items: [], kind: 'kit', name: item.bundle_name || 'Kit', price: 0};

			kits.set(key, kit);
			out.push(kit);
		}

		const kit = kits.get(key);

		kit.items.push(item);
		kit.price = (cents(kit.price) + cents(item.price_brl)) / 100;
	}

	return out;
}
