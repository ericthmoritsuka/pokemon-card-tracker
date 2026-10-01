// The finish picker's data: a card's own printings from TCGdex
// variants_detailed, which one is the plain print, and the short chip a tray
// tile shows (DESIGN.md section 3, "The finish is picked by hand ... never
// remembers the last pick").
//
// Pure: no DOM, no network, so Node can test it (tests/scan.test.mjs). The
// picker starts on plainVariantId(variants) for every card, every time.
// Nothing here knows which finish the previous card had.

import {variantLabel} from '../wishlist.js';

const TYPE_RANK = {normal: 0, holo: 1, reverse: 2};

// A variant the picker can offer: it needs a variantId, because the copy
// stores that ID (DESIGN.md section 3, "A copy's variant is a TCGdex variant
// ID, not a word").
const usable = (variant) => Boolean(variant && variant.variantId);

const stamps = (variant) => (Array.isArray(variant.stamp) ? variant.stamp : []);

const isStandard = (variant) => !variant.size || variant.size === 'standard';

// How plain a printing is: lower is plainer. Standard size, no foil pattern,
// no stamp, then normal before holo before reverse holo, then no subtype or
// "unlimited" before any other subtype (Base Set Charizard's plain print is
// the Unlimited holo, not the Shadowless or 1st Edition one).
function plainness(variant) {
	const type = String(variant.type || '').toLowerCase();
	const subtype = String(variant.subtype || '').toLowerCase();

	return [
		isStandard(variant) ? 0 : 1,
		variant.foil ? 1 : 0,
		stamps(variant).length ? 1 : 0,
		TYPE_RANK[type] ?? 3,
		!subtype || subtype === 'unlimited' ? 0 : 1,
	];
}

function comparePlainness(a, b) {
	const pa = plainness(a);
	const pb = plainness(b);

	for (let i = 0; i < pa.length; i++) {
		if (pa[i] !== pb[i]) {
			return pa[i] - pb[i];
		}
	}

	return 0;
}

// The plain print's variantId, or null when the card lists no printing with
// an ID. Ties keep TCGdex's order.
export function plainVariantId(variants) {
	const list = (variants || []).filter(usable);

	if (!list.length) {
		return null;
	}

	let best = list[0];

	for (const variant of list.slice(1)) {
		if (comparePlainness(variant, best) < 0) {
			best = variant;
		}
	}

	return best.variantId;
}

// A key that names the same finish on different cards, for Set for all:
// "reverse holo" on Pinsir and on Spinarak.
export function finishKey(variant) {
	if (!variant) {
		return null;
	}

	return [
		String(variant.type || '').toLowerCase(),
		variant.foil || '',
		stamps(variant).slice().sort().join('+'),
		String(variant.subtype || '').toLowerCase(),
		variant.size || 'standard',
	].join('|');
}

// The tile's bottom-left chip for a printing that is not the plain print:
// REV, PB (Poké Ball), MB (Master Ball), 1ST, HOLO. Null for the plain print.
export function finishChip(variant, plainId) {
	if (!variant || variant.variantId === plainId) {
		return null;
	}

	if (stamps(variant).includes('1st-edition')) {
		return '1ST';
	}

	if (variant.foil === 'pokeball') {
		return 'PB';
	}

	if (variant.foil === 'masterball') {
		return 'MB';
	}

	if (variant.foil) {
		return 'FOIL';
	}

	if (stamps(variant).length) {
		return 'STAMP';
	}

	const type = String(variant.type || '').toLowerCase();

	if (type === 'reverse') {
		return 'REV';
	}

	if (!isStandard(variant)) {
		return 'JUMBO';
	}

	if (type === 'holo') {
		return 'HOLO';
	}

	return variant.subtype ? String(variant.subtype).slice(0, 5).toUpperCase() : null;
}

// What the picker lists, plain print first, then TCGdex's order with
// standard sizes before jumbo ones: [{variantId, label, key, plain}].
export function finishOptions(variants) {
	const list = (variants || []).filter(usable);
	const plainId = plainVariantId(list);
	const ordered = [
		...list.filter((variant) => variant.variantId === plainId),
		...list.filter((variant) => variant.variantId !== plainId && isStandard(variant)),
		...list.filter((variant) => variant.variantId !== plainId && !isStandard(variant)),
	];

	return ordered.map((variant) => ({
		chip: finishChip(variant, plainId),
		key: finishKey(variant),
		label: variantLabel(variant),
		plain: variant.variantId === plainId,
		variantId: variant.variantId,
	}));
}

export const findVariant = (variants, variantId) => (variants || []).find((variant) => usable(variant) && variant.variantId === variantId) || null;
