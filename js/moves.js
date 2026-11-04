// The trades and sales log (DESIGN.md section 11, "Trades and Sales"; Eric,
// 2026-10-31 and 2026-11-04): each sale, purchase, trade, or gift is one
// entry in the document's `moves` list, merged entry by entry like the other
// lists (js/merge.js mergeDocuments merges every top-level list, so phones
// from v21 on keep the list and its entries whole):
//
//   {id, kind, date, who, price, currency, money, note, out, past, in, undo,
//    created_at, updated_at, deleted_at}
//
//   kind      sold, bought, traded, or gift (given, received, or both)
//   date      the day it happened, YYYY-MM-DD
//   who       who with, free text, or null
//   price     one amount for the whole move, or null; currency BRL, USD, or
//             EUR. Prices only: no cost per copy and no profit (Eric).
//   money     which way the price went, 'in' or 'out': a sale's comes in, a
//             purchase's goes out, a trade names it (cash added), a gift has
//             none
//   out       the copies that left (entry ids); each tombstone carries
//             left_via: <move id>
//   past      the part of out that was removed by hand before the move was
//             logged (Log a past sale): linked, never deleted by the move
//   in        the copies that came (entry ids), each carrying came_via
//   undo      what Undo needs from the save (js/start-over.js planSwap), so
//             any phone can undo the move later: the in copies' hashes,
//             pockets, trays, picks, collections, fills, and wishes
//
// Saving soft-deletes the out copies (as Delete does), stamped left_via; a
// copy that leaves keeps its binder pocket as its card's placeholder, as
// Start over does; the in copies are added (js/collection.js newCopies)
// stamped came_via, and fill the placeholders waiting for them and move the
// wishes they fit to Got it (js/placeholder-fill.js planAfterAdding), all in
// one save through saveCopy, which leaves the document as it was when the
// write fails. Undo, and deleting a move from History, is one step: the out
// copies come back and the in copies unchanged since go, by Start over's
// Undo rules (js/start-over.js undoSwap), and the move becomes a tombstone.
// Photos and notes live on the card records (card_info), which a move never
// touches, so they show again when a copy of the card comes back.
//
// Older phones (v54 and before) know nothing of moves: they merge the list
// entry by entry, carry left_via and came_via on copies (a merge copies
// every field, and an edit changes a copy in place), and show the copies as
// any other.
//
// The plans are pure, so Node tests them (tests/moves.test.mjs).

import {isLive, loadDocument, newCopies, newId, saveCopy} from './collection.js';
import {nextStamp, stampEntry} from './merge.js';
import {autoFillOn, keptStartOver} from './placeholder-fill.js';
import {formatMoney, shortDate} from './prices.js';
import {copyHash, planSwap, undoSwap} from './start-over.js';
import {stampMs} from './stamp.js';

export const KINDS = ['sold', 'bought', 'traded', 'gift'];

export const CURRENCIES = ['BRL', 'USD', 'EUR'];

// How far back Log a past sale offers removed copies.
export const PAST_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

const list = (doc) => (doc && Array.isArray(doc.moves) ? doc.moves : []);

export const liveMoves = (doc) => list(doc).filter((move) => move && move.id && isLive(move));

const moveById = (doc, id) => list(doc).find((move) => move && move.id === id) || null;

// The price as a number to the cent, or null: a positive amount only.
export function cleanPrice(value) {
	const number = typeof value === 'number' ? value : Number(String(value ?? '').trim().replace(/\s/g, '').replace(',', '.'));

	return Number.isFinite(number) && number > 0 ? Math.round(number * 100) / 100 : null;
}

// Which way a move's price went: {amount, currency, way: 'in' | 'out'}, or
// null when it has no price or no way (a gift, a trade that names none).
export function moneyOf(move) {
	const amount = cleanPrice(move && move.price);

	if (!amount) {
		return null;
	}

	const way = move.kind === 'sold' ? 'in' : move.kind === 'bought' ? 'out' : move.kind === 'traded' && (move.money === 'in' || move.money === 'out') ? move.money : null;

	return way ? {amount, currency: CURRENCIES.includes(move.currency) ? move.currency : 'BRL', way} : null;
}

// Newest first: by the day it happened, then when it was logged.
export const newestFirst = (a, b) => String(b.date || '').localeCompare(String(a.date || ''))
	|| String(b.created_at || '').localeCompare(String(a.created_at || ''))
	|| String(a.id).localeCompare(String(b.id));

// The live moves by month, newest first: [{month: 'YYYY-MM', moves, in, out}],
// where in and out map each currency to the money that came in and went
// out that month, to the cent.
export function monthTotals(moves) {
	const months = new Map();

	for (const move of (moves || []).filter((item) => item && item.id && isLive(item)).sort(newestFirst)) {
		const month = /^\d{4}-\d{2}/.test(String(move.date || '')) ? move.date.slice(0, 7) : '';
		const row = months.get(month) || {in: {}, month, moves: [], out: {}};
		const money = moneyOf(move);

		row.moves.push(move);

		if (money) {
			row[money.way][money.currency] = Math.round(((row[money.way][money.currency] || 0) + money.amount) * 100) / 100;
		}

		months.set(month, row);
	}

	return [...months.values()];
}

// True when a copy was removed by a Start over: its tombstone is stamped
// with the run's time (js/start-over.js planStartOver), or just after when
// the copy's own stamp was ahead.
function startedOver(doc, entry) {
	const run = doc && doc.start_over && stampMs(doc.start_over.at, null);
	const gone = stampMs(entry.deleted_at, null);

	return run !== null && gone !== null && gone >= run && gone - run < 60 * 1000;
}

// Log a past sale (Eric, 2026-11-04): the copies removed by hand in the last
// PAST_DAYS days that a move can still claim, newest removal first. Left
// out: copies the duplicate repair folded into another (merged_into), copies
// a live move already names, copies a Start over removed (it added them
// again), and copies an undone move had added (they never were his).
export function pastCandidates(doc, {now = Date.now()} = {}) {
	const moves = new Map(list(doc).filter((move) => move && move.id).map((move) => [move.id, move]));
	const claimed = (id) => Boolean(id) && moves.has(id) && isLive(moves.get(id));

	return ((doc && doc.cards) || [])
		.filter((entry) => {
			if (!entry || !entry.id || !entry.deleted_at || entry.merged_into || claimed(entry.left_via)) {
				return false;
			}

			const gone = stampMs(entry.deleted_at, null);

			if (gone === null || now - gone > PAST_DAYS * DAY_MS || startedOver(doc, entry)) {
				return false;
			}

			return !(entry.came_via && moves.has(entry.came_via) && !isLive(moves.get(entry.came_via)));
		})
		.sort((a, b) => stampMs(b.deleted_at) - stampMs(a.deleted_at) || String(a.id).localeCompare(String(b.id)));
}

const text = (value) => {
	const clean = String(value ?? '').replace(/\s+/g, ' ').trim();

	return clean || null;
};

// What a move does to `doc`. fields: {kind, date, who, price, currency,
// money, note, out: [live copy ids], past: [ids from pastCandidates], in:
// [copy fields, as addCards takes]}. Returns {counts, doc, move}; `doc`
// itself is not changed. fill: whether the in copies fill placeholders (the
// Profile setting); fillUndo: the kept Start over undo (placeholder
// languages). Throws when the move would move no card.
export function planMove(doc, fields, {fill = false, fillUndo = null, id = newId(), now = Date.now()} = {}) {
	if (!KINDS.includes(fields.kind)) {
		throw new Error(`Unknown kind of move: ${fields.kind}.`);
	}

	const next = structuredClone(doc);
	const outIds = new Set(fields.out || []);
	const pastIds = new Set(pastCandidates(doc, {now}).map((entry) => entry.id).filter((entryId) => (fields.past || []).includes(entryId)));
	const removed = new Map();
	const past = [];

	next.cards = (next.cards || []).map((entry) => {
		if (!entry) {
			return entry;
		}

		if (outIds.has(entry.id) && isLive(entry)) {
			const at = nextStamp(entry.updated_at, now);
			const gone = stampEntry(entry, {...entry, deleted_at: at, left_via: id, updated_at: at});

			removed.set(entry.id, gone);

			return gone;
		}

		if (pastIds.has(entry.id)) {
			past.push(entry.id);

			return stampEntry(entry, {...entry, left_via: id, updated_at: nextStamp(entry.updated_at, now)});
		}

		return entry;
	});

	const added = newCopies(next, (fields.in || []).map((copy) => ({...copy, created_at: undefined})), {now}).map((entry) => ({...entry, came_via: id}));

	if (!removed.size && !past.length && !added.length) {
		throw new Error('Choose at least one card that goes or comes.');
	}

	const swap = planSwap(doc, next, removed, added, {fill, fillUndo, now});
	const at = new Date(now).toISOString();
	const price = cleanPrice(fields.price);
	const move = {
		created_at: at,
		currency: price ? (CURRENCIES.includes(fields.currency) ? fields.currency : 'BRL') : null,
		date: /^\d{4}-\d{2}-\d{2}$/.test(String(fields.date || '')) ? fields.date : at.slice(0, 10),
		deleted_at: null,
		id,
		in: added.map((entry) => entry.id),
		kind: fields.kind,
		money: price ? (fields.kind === 'sold' ? 'in' : fields.kind === 'bought' ? 'out' : fields.kind === 'traded' && (fields.money === 'in' || fields.money === 'out') ? fields.money : null) : null,
		note: text(fields.note),
		out: [...removed.keys(), ...past],
		past,
		price: fields.kind === 'gift' ? null : price,
		undo: {...swap.undo, hashes: Object.fromEntries(added.map((entry) => [entry.id, copyHash(entry)]))},
		updated_at: at,
		who: text(fields.who),
	};

	if (move.kind === 'gift') {
		move.currency = null;
		move.money = null;
	}

	next.moves = [...list(next), move];

	return {
		counts: {filled: swap.after.placed.length, got: swap.after.got.length, in: added.length, out: removed.size, past: past.length, pockets: swap.pockets},
		doc: next,
		move,
	};
}

export const STALE_MOVE_TEXT = 'You started over after this move, so undoing it would put old copies back beside the new ones. Nothing was changed.';

// Undo of a move, and deleting it from History: the out copies come back
// (without left_via), the in copies unchanged since go (js/start-over.js
// undoSwap: a copy changed since stays, and so do its pockets), the copies
// a past sale linked lose the link and stay removed, and the move becomes a
// tombstone. Returns {counts, doc, stale}: counts {restored, added, kept,
// unlinked}; stale is true, and nothing changes, when the move is gone or
// already undone, or a Start over ran after it.
export function planUndoMove(doc, moveId, {now = Date.now()} = {}) {
	const move = moveById(doc, moveId);
	const counts = {added: 0, kept: 0, restored: 0, unlinked: 0};

	if (!move || !isLive(move) || (doc.start_over && stampMs(doc.start_over.at) > stampMs(move.created_at))) {
		return {counts, doc: structuredClone(doc), stale: true};
	}

	const kept = move.undo || {};
	const undo = {
		added: Array.isArray(move.in) ? move.in : [],
		binders: kept.binders || [],
		collections: kept.collections || [],
		fills: kept.fills || [],
		hashes: kept.hashes || {},
		picks: kept.picks || [],
		removed: kept.removed || [],
		wishes: kept.wishes || [],
	};
	const done = undoSwap(doc, undo, {drop: ['left_via'], now});
	const next = done.doc;
	const past = new Set(Array.isArray(move.past) ? move.past : []);

	next.cards = next.cards.map((entry) => {
		if (!entry || !past.has(entry.id) || !entry.deleted_at || entry.left_via !== move.id) {
			return entry;
		}

		const clean = {...entry, updated_at: nextStamp(entry.updated_at, now)};

		delete clean.left_via;
		counts.unlinked++;

		return stampEntry(entry, clean);
	});

	next.moves = list(next).map((item) => {
		if (!item || item.id !== move.id) {
			return item;
		}

		const at = nextStamp(item.updated_at, now);

		return stampEntry(item, {...item, deleted_at: at, updated_at: at});
	});

	return {counts: {...counts, ...done.counts}, doc: next, stale: false};
}

// How each copy of a card came and went, for its page: [{side: 'in' |
// 'out', move, entries}], one row per move and side, newest move first.
// side 'in' is a live copy that came with a live move; 'out' a copy that
// left with one (a removed copy).
export function cardHistory(doc, {card_id: cardId, catalog = 'international'}) {
	const moves = new Map(liveMoves(doc).map((move) => [move.id, move]));
	const rows = new Map();

	for (const entry of (doc && doc.cards) || []) {
		if (!entry || entry.card_id !== cardId || (entry.catalog || 'international') !== catalog) {
			continue;
		}

		const side = isLive(entry) && moves.has(entry.came_via) ? 'in' : !isLive(entry) && !entry.merged_into && moves.has(entry.left_via) ? 'out' : null;

		if (!side) {
			continue;
		}

		const move = moves.get(side === 'in' ? entry.came_via : entry.left_via);
		const key = `${move.id}|${side}`;
		const row = rows.get(key) || {entries: [], move, side};

		row.entries.push(entry);
		rows.set(key, row);
	}

	return [...rows.values()].sort((a, b) => newestFirst(a.move, b.move) || a.side.localeCompare(b.side));
}

// The price as text, "R$ 30,50", or null.
export function priceText(move) {
	const money = moneyOf(move);

	return money ? formatMoney(money.amount, money.currency) : null;
}

const goesOut = (move) => Array.isArray(move.out) && move.out.length > 0;
const comesIn = (move) => Array.isArray(move.in) && move.in.length > 0;

// What a move was, in words, for one side of it: "sold for R$ 30,50 to
// Ana", "bought from Bruno", "traded with Bruno, R$ 5,00 paid", "given to
// Ana", "a gift from Ana". side: 'out', 'in', or null for the whole move.
export function moveWords(move, side = null) {
	const who = text(move.who);
	const price = priceText(move);

	switch (move.kind) {
	case 'sold':
		return `sold${price ? ` for ${price}` : ''}${who ? ` to ${who}` : ''}`;
	case 'bought':
		return `bought${price ? ` for ${price}` : ''}${who ? ` from ${who}` : ''}`;
	case 'traded':
		return `traded${who ? ` with ${who}` : ''}${price ? `, ${price} ${moneyOf(move).way === 'in' ? 'received' : 'paid'}` : ''}`;
	default: {
		const given = side ? side === 'out' : goesOut(move) && !comesIn(move);
		const got = side ? side === 'in' : comesIn(move) && !goesOut(move);

		if (given) {
			return `given${who ? ` to ${who}` : ''}`;
		}

		return got ? `a gift${who ? ` from ${who}` : ''}` : `gifts${who ? ` with ${who}` : ''}`;
	}
	}
}

// A move's title in History: "Sold for R$ 30,50 to Ana".
export function moveTitle(move) {
	const words = moveWords(move);

	return words.charAt(0).toUpperCase() + words.slice(1);
}

// A card page's line for one row of cardHistory: "Left: sold for R$ 30,50
// to Ana, 3 Nov"; "Came in: traded with Bruno, 4 Nov".
export function historyLine(row, {now = new Date()} = {}) {
	const date = shortDate(row.move.date, {now});

	return `${row.side === 'in' ? 'Came in' : 'Left'}: ${moveWords(row.move, row.side)}${date ? `, ${date}` : ''}`;
}

// ------------------------------------------------------------- saved

// Saved: logs a move in one save. Resolves {counts, move}; on a failed
// write it rejects and the document on the phone is as it was.
export async function applyMove(fields) {
	const current = await loadDocument();
	const {counts, doc, move} = planMove(current, fields, {fill: autoFillOn(current), fillUndo: await keptStartOver(current)});

	await saveCopy(doc);

	return {counts, move};
}

// Saved: undoes a move (Undo on the toast, or Undo this move in History).
// Resolves its counts; rejects with an error whose stale is true when there
// was nothing to undo.
export async function undoMove(moveId) {
	const {counts, doc, stale} = planUndoMove(await loadDocument(), moveId);

	if (stale) {
		throw Object.assign(new Error(STALE_MOVE_TEXT), {stale: true});
	}

	await saveCopy(doc);

	return counts;
}

// The copies a move form opens with, handed over by Sell or trade (a copy
// sheet, a card's page) when it opens the form: {out: [ids], card:
// {card_id, catalog} | null}. Taken once.
let pending = null;

export function setPendingMove(value) {
	pending = value || null;
}

export function takePendingMove() {
	const value = pending;

	pending = null;

	return value;
}
