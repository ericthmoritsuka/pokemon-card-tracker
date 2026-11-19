// Value over time (Eric, 2026-11-18; DESIGN.md section 10, "Value over
// time"): what the whole collection was worth on each day My Cards worked it
// out with fresh prices, and, for each card, the prices its full TCGdex
// record carried each week it was read.
//
// Both live on this phone only, in IndexedDB, not in the synced document.
// The document's lists merge as a union by id (js/merge.js mergeEntries), so
// a snapshot one phone thins away comes back from any other phone or the
// server unless it is kept as a tombstone, and tombstones are never dropped;
// each snapshot would also count as a change waiting to sync, and thinning
// would remove entries the server holds, which turns the small patch save
// into a whole-document upload (syncDelta). The values are worked out from
// each phone's own saved records and exchange rates anyway, so two phones
// would write different values for the same day. A new phone starts its
// history afresh.
//
// The pure helpers come first, so Node can test them
// (tests/value-history.test.mjs); the storage after them touches IndexedDB
// only when called.

import {database} from './idb.js';
import {eurToBrl, extractPrices, roundCents, savedEuroRates, savedRates, usdToBrl} from './prices.js';

// ------------------------------------------------------------ dates

const DAY_MS = 24 * 60 * 60 * 1000;

const isDay = (date) => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date);

const pad = (n) => String(n).padStart(2, '0');

// The phone's own calendar day, YYYY-MM-DD: a snapshot taken at 11 pm in
// Recife belongs to that evening, not to the next day in UTC.
export const dayKey = (now = new Date()) => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

// A YYYY-MM-DD as days since 1970, read as UTC so a time zone never moves it.
const dayNumber = (date) => Math.round(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / DAY_MS);

const dayText = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);

// The Monday that starts the week of a YYYY-MM-DD.
export function weekOf(date) {
	const n = dayNumber(date);
	// 1 Jan 1970 was a Thursday, so day 0 is 3 days after a Monday.
	const sinceMonday = (n + 3) % 7;

	return dayText(n - sinceMonday);
}

// ------------------------------------------- the collection's snapshots

// At most this many snapshots: the last DAILY_DAYS days keep one a day and
// older days one a week, so 400 covers about six years and stays a few tens
// of kilobytes.
export const SNAPSHOT_MAX = 400;
export const DAILY_DAYS = 90;

const validSnapshot = (item) => Boolean(item) && isDay(item.date) && typeof item.brl === 'number' && Number.isFinite(item.brl) && item.brl >= 0;

// The snapshots oldest first, one a day, the days older than dailyDays
// before the newest snapshot thinned to the last of each week, then the
// oldest dropped past max. Measured from the newest snapshot, not from
// today, so the same list always thins the same way.
export function thinSnapshots(list, {dailyDays = DAILY_DAYS, max = SNAPSHOT_MAX} = {}) {
	const byDay = new Map();

	for (const item of Array.isArray(list) ? list : []) {
		if (validSnapshot(item)) {
			byDay.set(item.date, item);
		}
	}

	const sorted = [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1));

	if (!sorted.length) {
		return [];
	}

	const cutoff = dayNumber(sorted[sorted.length - 1].date) - dailyDays;
	const lastOfWeek = new Map();

	for (const item of sorted) {
		if (dayNumber(item.date) < cutoff) {
			lastOfWeek.set(weekOf(item.date), item);
		}
	}

	const kept = sorted.filter((item) => dayNumber(item.date) >= cutoff || lastOfWeek.get(weekOf(item.date)) === item);

	return kept.slice(Math.max(0, kept.length - max));
}

// The list with snapshot in place of any other of its day: a later reading
// on the same day has the fresher prices.
export function addSnapshot(list, snapshot, options = {}) {
	if (!validSnapshot(snapshot)) {
		return thinSnapshots(list, options);
	}

	return thinSnapshots([...(Array.isArray(list) ? list : []).filter((item) => item && item.date !== snapshot.date), snapshot], options);
}

// A snapshot from listStats over the whole collection (js/prices.js):
// {date, brl, copies, priced}, or null when no copy has a price, since a
// day with nothing priced says nothing about the value.
export function snapshotOf(stats, date = dayKey()) {
	if (!stats || !stats.priced || stats.total === null) {
		return null;
	}

	return {brl: stats.total, copies: stats.count, date, priced: stats.priced};
}

// The change from the first snapshot to the latest:
//   {first, latest, brl, percent}
// brl is the difference in reais, percent the change as a percentage of the
// first value (null when the first was zero). Null with fewer than two.
export function valueChange(list) {
	const items = (Array.isArray(list) ? list : []).filter(validSnapshot);

	if (items.length < 2) {
		return null;
	}

	const first = items[0];
	const latest = items[items.length - 1];
	const percent = first.brl > 0 ? Math.round((latest.brl / first.brl - 1) * 1000) / 10 : null;

	return {brl: roundCents(latest.brl - first.brl), first, latest, percent};
}

// ------------------------------------------------ a card's weekly prices

// At most this many points a card: two years of weeks. A point is a few
// numbers a finish, so even a whole collection's stays small.
export const CARD_POINTS_MAX = 104;

const amount = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);

// One point for a card's full TCGdex record:
//   {date, rates: [brlPerUsd, brlPerEur], prices: {<finish label>: [usd, eur]}}
// usd is TCGplayer's market price and eur Cardmarket's trend, each null when
// missing; rates are the ones saved when the point was taken (null when
// none), so a point converts at its own day's rate. date is the day TCGdex
// says the prices are from, so reading the same record twice gives the same
// point. Null when the record has no price at all.
export function cardPoint(record, {euroRates = null, rates = null} = {}) {
	const prices = {};
	let date = null;

	for (const finish of extractPrices(record)) {
		const usd = finish.tcgplayer ? amount(finish.tcgplayer.marketPrice) : null;
		const eur = finish.cardmarket ? amount(finish.cardmarket.trend) : null;

		if (usd === null && eur === null) {
			continue;
		}

		prices[finish.label] = [usd, eur];

		for (const day of [usd !== null && finish.tcgplayer.date, eur !== null && finish.cardmarket.date]) {
			if (isDay(day) && (!date || day > date)) {
				date = day;
			}
		}
	}

	if (!date || !Object.keys(prices).length) {
		return null;
	}

	return {date, prices, rates: [amount(rates && rates.brlPerUsd), amount(euroRates && euroRates.brlPerEur)]};
}

const validPoint = (point) => Boolean(point) && isDay(point.date) && point.prices && typeof point.prices === 'object';

// The points with point added, one a week (a later date in the same week
// takes its place, an earlier one is dropped), oldest first, at most max.
export function addCardPoint(points, point, max = CARD_POINTS_MAX) {
	const byWeek = new Map();

	for (const item of [...(Array.isArray(points) ? points : []), point]) {
		if (!validPoint(item)) {
			continue;
		}

		const week = weekOf(item.date);
		const held = byWeek.get(week);

		if (!held || item.date >= held.date) {
			byWeek.set(week, item);
		}
	}

	const sorted = [...byWeek.values()].sort((a, b) => (a.date < b.date ? -1 : 1));

	return sorted.slice(Math.max(0, sorted.length - max));
}

// The reais of one market's price at a point: its own day's rate, else the
// rate saved now.
function pointBrl(point, label, market, {euroRates, rates}) {
	const pair = point.prices[label];
	const value = Array.isArray(pair) ? amount(pair[market === 'tcgplayer' ? 0 : 1]) : null;
	const own = Array.isArray(point.rates) ? amount(point.rates[market === 'tcgplayer' ? 0 : 1]) : null;

	if (value === null) {
		return null;
	}

	return market === 'tcgplayer'
		? usdToBrl(value, {brlPerUsd: own || (rates && rates.brlPerUsd)})
		: eurToBrl(value, {brlPerEur: own || (euroRates && euroRates.brlPerEur)});
}

// The line a card page draws for one finish: TCGplayer's market price, the
// one totals use, when at least two points have it; else Cardmarket's trend.
// usLabel and euLabel name the finish each market row shows (it may be
// another finish's price, js/price-view.js). Returns {market, label, points:
// [{date, brl}]}, or null when neither market has two points.
export function cardSeries(points, {euLabel = null, euroRates = null, rates = null, usLabel = null} = {}) {
	const valid = (Array.isArray(points) ? points : []).filter(validPoint);

	for (const [market, label] of [['tcgplayer', usLabel], ['cardmarket', euLabel]]) {
		if (!label) {
			continue;
		}

		const line = valid
			.map((point) => ({brl: pointBrl(point, label, market, {euroRates, rates}), date: point.date}))
			.filter((item) => item.brl !== null)
			.map((item) => ({brl: roundCents(item.brl), date: item.date}));

		if (line.length >= 2) {
			return {label, market, points: line};
		}
	}

	return null;
}

// ------------------------------------------------------------ storage

// Its own database, so the catalog's and the collection's stay as they are.
//   collection  "<person>" -> snapshots, oldest first
//   cards       "<card id>" -> points, oldest first (an international card's
//               prices are the same in every language)
const historyDb = database('card-tracker-history', ['collection', 'cards']);

// Reads key, hands what is there to change, and writes what it returns, in
// one transaction, so two writes at once never lose one. change returning
// the value it was given writes nothing.
async function update(store, key, change) {
	const db = await historyDb.open();

	return new Promise((resolve, reject) => {
		const tx = db.transaction(store, 'readwrite');
		const objects = tx.objectStore(store);
		const request = objects.get(key);
		let out = null;

		request.onsuccess = () => {
			const before = request.result || [];

			out = change(before);

			if (out !== before) {
				objects.put(out, key);
			}
		};
		tx.oncomplete = () => resolve(out);
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

async function read(store, key) {
	try {
		const value = await historyDb.run(store, 'readonly', (objects) => objects.get(key));

		return Array.isArray(value) ? value : [];
	}
	catch {
		return [];
	}
}

const same = (a, b) => Boolean(a) && Boolean(b) && a.date === b.date && a.brl === b.brl && a.copies === b.copies && a.priced === b.priced;

// The collection's snapshots for person (the signed-in account's id, or
// "local"), oldest first; [] when none or the phone cannot read them.
export const readValueHistory = (person) => read('collection', String(person || 'local'));

// Records today's snapshot for person, at most one a day (a later one the
// same day replaces it). Resolves to the snapshots, or null when nothing
// could be kept; never throws, since a lost snapshot only leaves a gap.
export async function recordValue(person, snapshot) {
	if (!validSnapshot(snapshot)) {
		return null;
	}

	try {
		return await update('collection', String(person || 'local'), (before) => {
			const held = before.find((item) => item && item.date === snapshot.date);

			return same(held, snapshot) ? before : addSnapshot(before, snapshot);
		});
	}
	catch {
		return null;
	}
}

// A card's weekly points, oldest first.
export const readCardHistory = (cardId) => read('cards', String(cardId));

// Records a point for a card's full record as it arrives from TCGdex, with
// the exchange rates saved now. Resolves to the points, or null; never
// throws.
export async function recordCardPrices(cardId, record, {euroRates = savedEuroRates(), rates = savedRates()} = {}) {
	const point = cardId ? cardPoint(record, {euroRates, rates}) : null;

	if (!point) {
		return null;
	}

	try {
		return await update('cards', String(cardId), (before) => {
			const held = before.find((item) => item && item.date === point.date);

			return held && JSON.stringify(held.prices) === JSON.stringify(point.prices) ? before : addCardPoint(before, point);
		});
	}
	catch {
		return null;
	}
}
