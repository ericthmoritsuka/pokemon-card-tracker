// Counts in text, shared by the screens (plans/audit-engineering.md E-34).
// Money lives in js/prices.js (formatMoney, formatBrl).

// 1234 as "1,234".
export const formatCount = (n) => Number(n).toLocaleString('en-US');

// "1 card", "1,234 cards".
export const plural = (n, one, many) => `${formatCount(n)} ${n === 1 ? one : many}`;
