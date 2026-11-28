// Saving one finish's sale price, the Shop's way, for a screen other than
// the Shop (Eric, 2026-11-27: Check spares prices a spare in its row). The
// same parsing and R$ 99.999,99 cap (js/moves.js parseSalePrice), the same
// patches on every copy of the finish (js/shop.js pricePatches) and their
// Undo, and the same suggestion words as the Shop's rows
// (js/shop-view.js suggestionNode), so a price typed here and one typed in
// the Shop can never differ. Worked out without the page, so node can test
// it (tests/price-save.test.mjs).

import {parseSalePrice} from './moves.js';
import {formatBrl} from './prices.js';
import {pricePatches, undoPricePatches} from './shop.js';

// group: a js/shop.js shopGroups row; text: as typed, "" clearing the
// price. {error} when the text cannot be read, else {error: null, value,
// patches, undo}, patches empty when every copy already holds the price.
export function priceSave(group, text) {
	const typed = parseSalePrice(text);

	if (typed.error) {
		return {error: typed.error, patches: [], undo: [], value: null};
	}

	const patches = pricePatches([group], typed.value);

	return {error: null, patches, undo: undoPricePatches([group], patches), value: typed.value};
}

// "TCGplayer ≈ R$ 2,10 · Cardmarket ≈ R$ 1,80" from js/shop.js suggestion,
// or '' when neither market has a price.
export function suggestionWords(found) {
	return [
		found && found.tcgplayer !== null && found.tcgplayer !== undefined ? `TCGplayer ≈ ${formatBrl(found.tcgplayer)}` : null,
		found && found.cardmarket !== null && found.cardmarket !== undefined ? `Cardmarket ≈ ${formatBrl(found.cardmarket)}` : null,
	].filter(Boolean).join(' · ');
}
