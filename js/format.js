// Counts in text, shared by the screens (plans/audit-engineering.md E-34).
// Money lives in js/prices.js (formatMoney, formatBrl).

// 1234 as "1,234".
export const formatCount = (n) => Number(n).toLocaleString('en-US');

// "1 card", "1,234 cards". many defaults to one with an s.
export const plural = (n, one, many = `${one}s`) => `${formatCount(n)} ${n === 1 ? one : many}`;

// How many copies, and how many of them are free to trade or sell (Eric,
// 2026-11-25; js/shop.js freeCopyIds): "3 copies, 1 free", "3 copies, none
// free", and for one copy "1 copy, free" or "1 copy, not free". The tile's
// split badge is named with it (js/tile.js), and Check spares heads each
// card with it (js/spare-check-view.js).
export function freeText(copies, free) {
	if (copies === 1) {
		return free ? '1 copy, free' : '1 copy, not free';
	}

	return `${plural(copies, 'copy', 'copies')}, ${free ? `${formatCount(free)} free` : 'none free'}`;
}
