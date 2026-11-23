// The trades and sales log (DESIGN.md section 11, "Trades and Sales"; Eric,
// 2026-10-31 and 2026-11-04): each sale, purchase, trade, or gift is one
// entry in the document's `moves` list, merged entry by entry like the other
// lists (js/merge.js mergeDocuments merges every top-level list, so phones
// from v21 on keep the list and its entries whole):
//
//   {id, kind, date, who, price, currency, money, note, out, past, in,
//    in_prices, undo, after_run, created_at, updated_at, deleted_at}
//
//   kind      sold, bought, traded, or gift (given, received, or both)
//   date      the day it happened, YYYY-MM-DD
//   who       who with, free text, or null; for a purchase, where it came
//             from (a store, site, event, or person; Eric, 2026-11-19)
//   price     one amount for the whole move, or null; currency BRL, USD, or
//             EUR. No profit (Eric, 2026-10-31). A purchase priced card by
//             card saves the sum of its card prices here.
//   money     which way the price went, 'in' or 'out': a sale's comes in, a
//             purchase's goes out, a trade names it (cash added), a gift has
//             none
//   out       the copies that left (entry ids); each tombstone carries
//             left_via: <move id>
//   past      the part of out that was removed by hand before the move was
//             logged (Log a past sale): linked, never deleted by the move
//   in        the copies that came (entry ids), each carrying came_via
//   in_prices a purchase's own price for each copy that came, {entry id:
//             amount}, in the move's currency, present only when he priced
//             the cards one by one (Eric, 2026-11-19, which reverses "no
//             cost per copy" for purchases only). A card with no price of
//             its own has no key. They count only while they add up to
//             price (ownPrices): an older phone's Edit changes price alone
//             and keeps them as they were, and then they no longer tell
//   undo     what Undo needs from the save (js/start-over.js planSwap), so
//             any phone can undo the move later: the in copies' hashes,
//             pockets, trays, picks, collections, fills, and wishes
//   after_run the id of the document's latest Start over mark when the move
//             was logged (js/start-over.js latestRun), or null: Undo of the
//             move is refused once the latest mark is another one (a later
//             run, or Start over's Undo), whatever the phones' clocks say
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
// It is refused while a later live move names one of its in copies (sold
// on, say): that move is undone first, or the copy would come back with
// nothing that brought it. A copy two live moves both take out, logged on
// two phones offline (QA, 2026-11-20), is marked on both in History
// (twiceOut), and Undo of either leaves it out, handed to the other.
// Edit (Eric, 2026-11-05) changes a logged move's date, who, price, and
// note, stamped field by field (the price, currency, money, and a
// purchase's card prices as one unit; Eric, 2026-11-19), and never its
// cards, undo, or after_run, so Undo works the same
// after it; an undone move cannot be edited. The form sends only what was
// changed in it, so it never puts back what another phone changed.
// Photos and notes live on the card records (card_info), which a move never
// touches, so they show again when a copy of the card comes back.
//
// Older phones (v54 and before) know nothing of moves: they merge the list
// entry by entry, carry left_via and came_via on copies (a merge copies
// every field, and an edit changes a copy in place), and show the copies as
// any other. Phones from before in_prices keep it the same way: their merge
// takes every field of a move, by its stamp or with the newer version
// whole, and their Edit and Undo copy the move with every field it has.
//
// The plans are pure, so Node tests them (tests/moves.test.mjs).

import {stagedOf} from './binders.js';
import {isLive, loadDocument, newCopies, newId, saveCopy} from './collection.js';
import {nextStamp, stableJson, stampEntry} from './merge.js';
import {autoFillOn, keptStartOver} from './placeholder-fill.js';
import {formatMoney, shortDate} from './prices.js';
import {copyHash, latestRun, planSwap, removedByStartOver, undoSwap} from './start-over.js';
import {stampMs} from './stamp.js';

export const KINDS = ['sold', 'bought', 'traded', 'gift'];

export const CURRENCIES = ['BRL', 'USD', 'EUR'];

// How far back Log a past sale offers removed copies.
export const PAST_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

const list = (doc) => (doc && Array.isArray(doc.moves) ? doc.moves : []);

export const liveMoves = (doc) => list(doc).filter((move) => move && move.id && isLive(move));

const moveById = (doc, id) => list(doc).find((move) => move && move.id === id) || null;

export const PRICE_FORM_TEXT = 'Type the price as 30,50 or 1.500,00, or leave it empty.';

// A typed price, the Brazilian way or the English way (Eric, 2026-11-04):
// {value, error}. With a comma, the dots group thousands and the comma is
// the decimal point ("1.500,00" is 1500, "30,50" is 30.5); without one, a
// dot followed by exactly three digits groups thousands ("1.500" is 1500,
// "1.500.000" is 1500000), and any other dot is the decimal point ("30.5").
// Spaces are ignored. Empty is no price, {value: null, error: null};
// anything else, and zero, is refused with PRICE_FORM_TEXT.
export function parsePrice(text) {
	const typed = String(text ?? '').replace(/\s/g, '');

	if (!typed) {
		return {error: null, value: null};
	}

	let plain = null;

	if (/^(\d{1,3}(\.\d{3})+|\d+),\d{1,2}$/.test(typed)) {
		plain = typed.replace(/\./g, '').replace(',', '.');
	}
	else if (/^\d{1,3}(\.\d{3})+$/.test(typed)) {
		plain = typed.replace(/\./g, '');
	}
	else if (/^\d+(\.\d{1,2})?$/.test(typed)) {
		plain = typed;
	}

	const number = plain === null ? NaN : Number(plain);

	return Number.isFinite(number) && number > 0 ? {error: null, value: Math.round(number * 100) / 100} : {error: PRICE_FORM_TEXT, value: null};
}

// The price as a number to the cent, or null: a positive amount only. A
// string is read by parsePrice.
export function cleanPrice(value) {
	if (typeof value !== 'number') {
		return parsePrice(value).value;
	}

	return Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : null;
}

// A purchase's card prices as a move keeps them (Eric, 2026-11-19): {entry
// id: amount}, a positive amount to the cent for each copy that has one,
// typed (parsePrice) or a number; a blank or unreadable one is left out, as
// a card with no price of its own. ids, when given, are the copies that may
// carry one (the move's in). null when none is left.
export function cleanInPrices(value, ids = null) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return null;
	}

	const allowed = ids ? new Set(ids) : null;
	const out = {};

	for (const [id, amount] of Object.entries(value)) {
		const clean = cleanPrice(amount);

		if (clean && (!allowed || allowed.has(id))) {
			out[id] = clean;
		}
	}

	return Object.keys(out).length ? out : null;
}

// Amounts added to the cent, in whole cents, so 0.1 and 0.2 make 0.3 and
// the sum reads back as the same number cleanPrice gives. A blank counts 0.
export const sumPrices = (amounts) => Math.round((amounts || []).reduce((sum, amount) => sum + Math.round((cleanPrice(amount) || 0) * 100), 0)) / 100;

// A purchase's own card prices while they still tell, or null: only on a
// purchase, and only while they add up to its price. Every save and Edit of
// this app keeps the two together; an older phone's Edit changes the price
// alone, and from then on the card prices are kept but not shown or
// counted, and the price stands for the whole purchase as it did before
// (DESIGN.md, "Trades and Sales").
export function ownPrices(move) {
	if (!move || move.kind !== 'bought') {
		return null;
	}

	const prices = cleanInPrices(move.in_prices, Array.isArray(move.in) ? move.in : []);

	return prices && sumPrices(Object.values(prices)) === cleanPrice(move.price) ? prices : null;
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

// A copy logged out twice (QA, 2026-11-20): each phone refuses a copy a
// live move already names, but two phones offline can each log the same
// copy leaving, a sale on one and a trade on the other, and the merge keeps
// both moves, as it keeps every entry. Neither is dropped, since either may
// be what happened: the log says so on both, and Undo of the one that did
// not happen ends it. For each live move whose cards out (past included)
// another live move also takes out: Map move id -> [{move, ids}], the
// other moves newest first, each with the copies the two share. Read from
// the moves alone, so every phone with the same moves shows the same.
export function twiceOut(moves) {
	const live = (moves || []).filter((move) => move && move.id && isLive(move)).sort(newestFirst);
	const byCopy = new Map();

	for (const move of live) {
		for (const id of new Set(Array.isArray(move.out) ? move.out : [])) {
			byCopy.set(id, [...(byCopy.get(id) || []), move]);
		}
	}

	const found = new Map();

	for (const move of live) {
		const others = [];

		for (const other of live) {
			const ids = other === move ? [] : [...new Set(Array.isArray(move.out) ? move.out : [])].filter((id) => byCopy.get(id).includes(other)).sort();

			if (ids.length) {
				others.push({ids, move: other});
			}
		}

		if (others.length) {
			found.set(move.id, others);
		}
	}

	return found;
}

// What a row of History and a move's sheet say about a copy logged out
// twice: "Dipplin also left in "Traded with Lucas" on 20 Nov. Undo the one
// that did not happen." names: the card names of copy ids, or null for
// "This copy".
export function twiceOutText(others, {names = null, now = new Date()} = {}) {
	const lines = (others || []).map(({ids, move}) => {
		const named = names ? [...new Set(names(ids))] : [];
		const who = named.length ? named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}` : ids.length === 1 ? 'This copy' : 'These copies';
		const date = shortDate(move.date, {now});

		return `${who} also left in "${moveTitle(move)}"${date ? ` on ${date}` : ''}.`;
	});

	return lines.length ? `${lines.join(' ')} Undo the ${lines.length === 1 ? 'one' : 'ones'} that did not happen.` : '';
}

export const TWICE_MONEY_TEXT = 'Includes a copy logged out twice.';

// The live moves by month, newest first: [{month: 'YYYY-MM', moves, in, out,
// twice}], where in and out map each currency to the money that came in and
// went out that month, to the cent, and twice is true when that money
// counts a move whose copy another live move also took out (twiceOut): the
// totals count every live move as logged, and the month says so until one
// of the two is undone.
export function monthTotals(moves) {
	const months = new Map();
	const twice = twiceOut(moves);

	for (const move of (moves || []).filter((item) => item && item.id && isLive(item)).sort(newestFirst)) {
		const month = /^\d{4}-\d{2}/.test(String(move.date || '')) ? move.date.slice(0, 7) : '';
		const row = months.get(month) || {in: {}, month, moves: [], out: {}, twice: false};
		const money = moneyOf(move);

		row.moves.push(move);

		if (money) {
			row[money.way][money.currency] = Math.round(((row[money.way][money.currency] || 0) + money.amount) * 100) / 100;
			row.twice = row.twice || twice.has(move.id);
		}

		months.set(month, row);
	}

	return [...months.values()];
}

// Copies Start over or its Undo removed before removed_by existed (v51 to
// v55 before this fix), Set of ids, from the evidence older data holds:
//
// - the kept Start over undo on this phone (kept; js/placeholder-fill.js
//   keptStartOver): a copy its removed list names, still removed at the
//   stamp it records (the copies its pockets name are among them); and the
//   copies its added list names once the run was undone somewhere (a copy
//   it removed is live again), since those removals were the Undo's, not
//   his: while the run stands, an added copy removed is a removal by hand;
// - a placeholder a pocket became (js/start-over.js planSwap, from v51 on),
//   which other phones see too: a removed copy of its card whose
//   deleted_at is the placeholder's placed_at, as both are stamped with the
//   run's time (js/placeholder-fill.js pocketLanguages reads it the same
//   way). A placeholder filled since no longer tells.
function unmarkedRemovals(doc, kept) {
	const cards = (doc && doc.cards) || [];
	const byId = new Map(cards.filter((entry) => entry && entry.id).map((entry) => [entry.id, entry]));
	const out = new Set();

	if (kept) {
		const removed = Array.isArray(kept.removed) ? kept.removed.filter((item) => item && item.id) : [];

		for (const item of removed) {
			if ((byId.get(item.id) || {}).deleted_at === item.deleted_at) {
				out.add(item.id);
			}
		}

		if (removed.some((item) => isLive(byId.get(item.id) || {deleted_at: 'gone'}))) {
			for (const id of Array.isArray(kept.added) ? kept.added : []) {
				out.add(id);
			}
		}
	}

	const waiting = new Map();

	for (const binder of (doc && doc.binders) || []) {
		if (!binder || !isLive(binder)) {
			continue;
		}

		for (const slot of Array.isArray(binder.slots) ? binder.slots : []) {
			if (slot && !slot.cleared && !slot.entry_id && slot.want && slot.want.card_id && slot.placed_at) {
				const key = `${slot.want.catalog || 'international'}|${slot.want.card_id}|${slot.placed_at}`;

				waiting.set(key, true);
			}
		}
	}

	for (const entry of cards) {
		if (entry && entry.deleted_at && waiting.has(`${entry.catalog || 'international'}|${entry.card_id}|${entry.deleted_at}`)) {
			out.add(entry.id);
		}
	}

	return out;
}

// The last fallback, only for a removal with no removed_by that nothing in
// unmarkedRemovals names, and only while the document's latest Start over
// mark is from before removed_by: a tombstone stamped within a minute after
// that mark. It misses an earlier run, a copy whose stamp was ahead of the
// run, and hides a removal by hand right after one, which is why every
// removal Start over and its Undo write now carries removed_by. A run that
// marks its removals leaves a copy marked with its id; an Undo's mark
// (undoes) is never from before removed_by.
// Returns the test, (entry) => boolean.
function nearLatestRun(doc) {
	const latest = latestRun(doc);
	const run = latest && stampMs(latest.at, null);

	if (run === null || run === undefined || latest.undoes || ((doc && doc.cards) || []).some((item) => item && item.removed_by && item.removed_by.run === latest.id)) {
		return () => false;
	}

	return (entry) => {
		const gone = stampMs(entry.deleted_at, null);

		return gone !== null && gone >= run && gone - run < 60 * 1000;
	};
}

// Log a past sale (Eric, 2026-11-04): the copies removed by hand in the last
// PAST_DAYS days that a move can still claim, newest removal first. Left
// out: copies the duplicate repair folded into another (merged_into), copies
// a live move already names, copies Start over or its Undo removed (Start
// over added them again; js/start-over.js removedByStartOver, and for older
// removals unmarkedRemovals, then nearLatestRun), and copies an undone move
// had added (they never were his). kept: the kept Start over undo
// (js/placeholder-fill.js keptStartOver), or null.
export function pastCandidates(doc, {kept = null, now = Date.now()} = {}) {
	const moves = new Map(list(doc).filter((move) => move && move.id).map((move) => [move.id, move]));
	const claimed = (id) => Boolean(id) && moves.has(id) && isLive(moves.get(id));
	const unmarked = unmarkedRemovals(doc, kept);
	const near = nearLatestRun(doc);

	return ((doc && doc.cards) || [])
		.filter((entry) => {
			if (!entry || !entry.id || !entry.deleted_at || entry.merged_into || claimed(entry.left_via)) {
				return false;
			}

			const gone = stampMs(entry.deleted_at, null);

			if (gone === null || now - gone > PAST_DAYS * DAY_MS) {
				return false;
			}

			// A mark that no longer stands (the copy came back on an older
			// phone and was removed again later) means a later removal: the
			// evidence for older removals no longer applies to it.
			if (entry.removed_by ? removedByStartOver(entry) : unmarked.has(entry.id) || near(entry)) {
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

// Where earlier purchases came from, for the From field's suggestions
// (Eric, 2026-11-19): the who of each live purchase, newest first, each
// place once whatever its capitals, as it was typed last. An undone
// purchase suggests nothing.
export function purchaseSources(doc) {
	const seen = new Set();
	const out = [];

	for (const move of liveMoves(doc).filter((item) => item.kind === 'bought').sort(newestFirst)) {
		const name = text(move.who);
		const key = name && name.toLocaleLowerCase();

		if (name && !seen.has(key)) {
			seen.add(key);
			out.push(name);
		}
	}

	return out;
}

// What a move does to `doc`. fields: {kind, date, who, price, currency,
// money, note, out: [live copy ids], past: [ids from pastCandidates], in:
// [copy fields, as addCards takes], in_prices}. in_prices, for a purchase
// priced card by card (Eric, 2026-11-19): one price per copy in `in`, in
// the same order, typed or a number, blank for a card with no price of its
// own; given, the move's price is their sum and fields.price is not read,
// so the total saved is always what the card prices add up to, and each
// new copy's id keys its price on the move. Returns {counts, doc, move}; `doc`
// itself is not changed. fill: whether the in copies fill placeholders (the
// Profile setting); fillUndo: the kept Start over undo (placeholder
// languages). Throws when the move would move no card.
export function planMove(doc, fields, {fill = false, fillUndo = null, id = newId(), now = Date.now()} = {}) {
	if (!KINDS.includes(fields.kind)) {
		throw new Error(`Unknown kind of move: ${fields.kind}.`);
	}

	// A form kept for a reload saves under the id it was given, so saving it
	// again (a reload while it saved, a copied tab) finds the move there,
	// undone or not, and logs nothing (QA, 2026-11-20).
	if (moveById(doc, id)) {
		throw Object.assign(new Error(LOGGED_TEXT), {logged: true});
	}

	const next = structuredClone(doc);
	const outIds = new Set(fields.out || []);
	const pastIds = new Set(pastCandidates(doc, {kept: fillUndo, now}).map((entry) => entry.id).filter((entryId) => (fields.past || []).includes(entryId)));
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
	const each = fields.kind === 'bought' && Array.isArray(fields.in_prices) ? fields.in_prices : null;
	const inPrices = each ? cleanInPrices(Object.fromEntries(added.map((entry, i) => [entry.id, each[i]]))) : null;
	const price = each ? cleanPrice(sumPrices(Object.values(inPrices || {}))) : cleanPrice(fields.price);
	const run = latestRun(doc);
	const move = {
		after_run: run && run.id ? run.id : null,
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

	// Only when a card has a price of its own, so a purchase with one total
	// is saved exactly as before.
	if (inPrices) {
		move.in_prices = inPrices;
	}

	next.moves = [...list(next), move];

	return {
		counts: {filled: swap.after.placed.length, got: swap.after.got.length, in: added.length, out: removed.size, past: past.length, pockets: swap.pockets},
		doc: next,
		move,
	};
}

export const STALE_MOVE_TEXT = 'You started over after this trade or sale, so undoing it would put old copies back beside the new ones. Nothing was changed.';

export const UNDID_START_OVER_MOVE_TEXT = 'You undid Start over after this trade or sale, so undoing it could bring copies back twice. Nothing was changed.';

export const GONE_MOVE_TEXT = 'This trade or sale was already undone, on this phone or another. Nothing was changed.';

// Why Undo of a move was refused, for its message.
export function staleMoveText({later = null, reason = 'gone'} = {}, {now = new Date()} = {}) {
	if (reason === 'later' && later) {
		const date = shortDate(later.date, {now});

		return `A later trade or sale, "${moveTitle(later)}"${date ? ` on ${date}` : ''}, counts a card this one brought in. Undo that one first. Nothing was changed.`;
	}

	return reason === 'run' ? STALE_MOVE_TEXT : reason === 'undo' ? UNDID_START_OVER_MOVE_TEXT : GONE_MOVE_TEXT;
}

// Why Start over's Undo was refused (js/start-over.js movesAfterRun),
// naming the newest move in the way.
export function startOverBlockedText(move, {now = new Date()} = {}) {
	const date = shortDate(move.date, {now});

	return `"${moveTitle(move)}"${date ? ` on ${date}` : ''} in Trades and sales counts a copy that Undo Start over would change. Undo it first, then Undo Start over. Nothing was changed.`;
}

// True when the document's latest Start over mark is not the one the move
// was logged after (after_run): a run, or Start over's Undo, came since.
// A move from before after_run existed compares the stamps instead.
function runSince(doc, move) {
	const latest = latestRun(doc);

	if (Object.prototype.hasOwnProperty.call(move, 'after_run')) {
		return ((latest && latest.id) || null) !== (move.after_run || null);
	}

	return Boolean(latest) && stampMs(latest.at) > stampMs(move.created_at);
}

// Undo of a move, and deleting it from History: the out copies come back
// (without left_via), the in copies unchanged since go (js/start-over.js
// undoSwap: a copy changed since stays, and so do its pockets), the copies
// a past sale linked lose the link and stay removed, and the move becomes a
// tombstone. Returns {counts, doc, stale, reason, later}: counts {restored,
// added, kept, unlinked}; stale is true, and nothing changes, when the move
// is gone or already undone (reason 'gone'), a Start over ran after it
// ('run'), Start over's Undo ran after it ('undo'), or a later live move
// names one of its in copies in its out list ('later', that move in later).
export function planUndoMove(doc, moveId, {now = Date.now()} = {}) {
	const move = moveById(doc, moveId);
	const counts = {added: 0, held: 0, kept: 0, restored: 0, unlinked: 0};
	const refuse = (reason, later = null) => ({counts, doc: structuredClone(doc), later, reason, stale: true});

	if (!move || !isLive(move)) {
		return refuse('gone');
	}

	if (runSince(doc, move)) {
		return refuse(latestRun(doc).undoes ? 'undo' : 'run');
	}

	const brought = new Set(Array.isArray(move.in) ? move.in : []);
	const later = liveMoves(doc).filter((item) => item.id !== move.id && Array.isArray(item.out) && item.out.some((id) => brought.has(id))).sort(newestFirst);

	if (later.length) {
		return refuse('later', later[0]);
	}

	// A copy another live move also takes out (logged out twice on two
	// phones, twiceOut) stays out: that move still says it left, so Undo of
	// this one neither brings it back nor puts it back in a pocket, a tray,
	// a collection, or a pick. The copy is handed to the move that keeps it
	// (the newest, when several do): its left_via names that move and, when
	// the merge kept this move's removal, its deleted_at becomes the one
	// that move recorded, so Undo of that move later brings the copy back
	// (undoSwap restores only a removal it recorded). Which phone's removal
	// the merge kept does not matter.
	const held = new Map();

	for (const {ids, move: other} of twiceOut(liveMoves(doc)).get(move.id) || []) {
		for (const id of ids) {
			if (!held.has(id)) {
				const theirs = ((other.undo && other.undo.removed) || []).find((item) => item && item.id === id);

				held.set(id, {at: theirs ? theirs.deleted_at : null, id: other.id});
			}
		}
	}

	const free = (id) => !held.has(id);
	const kept = move.undo || {};
	const undo = {
		added: Array.isArray(move.in) ? move.in : [],
		binders: (kept.binders || []).map((item) => ({
			...item,
			pockets: (item.pockets || []).filter((pocket) => free(pocket.entry_id)),
			staged: item.staged ? {...item.staged, before: (item.staged.before || []).filter(free)} : item.staged,
		})),
		collections: (kept.collections || []).map((item) => {
			const keep = (item.ids || []).map((id, i) => [id, (item.written || [])[i]]).filter(([id]) => free(id));

			return {...item, ids: keep.map(([id]) => id), written: keep.map(([, written]) => written)};
		}),
		fills: kept.fills || [],
		hashes: kept.hashes || {},
		picks: (kept.picks || []).filter((pick) => free(pick.entry_id)),
		removed: (kept.removed || []).filter((item) => free(item.id)),
		wishes: kept.wishes || [],
	};
	const done = undoSwap(doc, undo, {drop: ['left_via'], now});
	const next = done.doc;
	const past = new Set(Array.isArray(move.past) ? move.past : []);
	const out = new Set(Array.isArray(move.out) ? move.out : []);

	next.cards = next.cards.map((entry) => {
		if (!entry || !entry.deleted_at || !out.has(entry.id)) {
			return entry;
		}

		if (held.has(entry.id)) {
			counts.held++;

			if (entry.left_via !== move.id) {
				return entry;
			}

			const keeper = held.get(entry.id);

			return stampEntry(entry, {...entry, deleted_at: keeper.at || entry.deleted_at, left_via: keeper.id, updated_at: nextStamp(entry.updated_at, now)});
		}

		if (!past.has(entry.id) || entry.left_via !== move.id) {
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

	return {counts: {...counts, ...done.counts}, doc: next, later: null, reason: null, stale: false};
}

// Both moves undone on two phones offline (QA, 2026-11-20): two phones each
// log the same copy out, the merge keeps both moves (twiceOut), and then
// each phone undoes one of them while the other is still live there, so
// each Undo keeps the copy out for the other (planUndoMove). Once the merge
// brings the two Undos together, no move says the copy left, yet it is still
// removed. After every sync merge (js/sync.js) such a copy comes back the way
// Undo of its move brings a copy back: into its pocket while the pocket still
// holds the placeholder a move left there, else into its tray, and back in its
// hand-picked collections and a list binder's hand pick, wherever they
// still hold what a move wrote (js/start-over.js undoSwap). It comes back
// only when all of these hold:
//   - it is removed, not folded into another copy (merged_into), and its
//     left_via names a move that is undone;
//   - no live move takes it out;
//   - no move, live or undone, names it in past: a past sale links a removal
//     made by hand, which no Undo reverses;
//   - its deleted_at is a removal an undone move recorded (undo.removed), so
//     a removal by hand that the merge kept instead keeps it removed;
//   - no Start over, or its Undo, came after any undone move that names it,
//     since Undo of that move would be refused too (runSince).
// Returns {count, doc}: count is the copies brought back, and doc is the
// document passed in, unchanged, when there are none.
export function planStrandedOuts(doc, {now = Date.now()} = {}) {
	const moves = list(doc).filter((move) => move && move.id);
	const undone = moves.filter((move) => !isLive(move) && Array.isArray(move.out));

	if (!undone.length) {
		return {count: 0, doc};
	}

	const byId = new Map(moves.map((move) => [move.id, move]));
	const stillOut = new Set(liveMoves(doc).flatMap((move) => (Array.isArray(move.out) ? move.out : [])));
	const byHand = new Set(moves.flatMap((move) => (Array.isArray(move.past) ? move.past : [])));
	const stranded = new Map();

	for (const entry of (doc && doc.cards) || []) {
		if (!entry || !entry.id || !entry.deleted_at || entry.merged_into || !entry.left_via) {
			continue;
		}

		const via = byId.get(entry.left_via);

		if (!via || isLive(via) || stillOut.has(entry.id) || byHand.has(entry.id)) {
			continue;
		}

		const naming = undone.filter((move) => move.out.includes(entry.id));
		const recorded = naming.some((move) => ((move.undo && move.undo.removed) || []).some((item) => item && item.id === entry.id && item.deleted_at === entry.deleted_at));

		if (recorded && !naming.some((move) => runSince(doc, move))) {
			stranded.set(entry.id, {deleted_at: entry.deleted_at, naming});
		}
	}

	if (!stranded.size) {
		return {count: 0, doc};
	}

	// The undo record for these copies alone, gathered from every undone
	// move that names them. Where two moves recorded the same collection or
	// pick, the one that matches what the document holds now is used, as
	// undoSwap puts back only what still holds what was written.
	const binders = new Map();
	const collections = new Map();
	const picks = new Map();
	const binderOf = (id) => binders.get(id) || binders.set(id, {id, pockets: [], staged: null}).get(id);
	const liveBinder = new Map(((doc && doc.binders) || []).filter((binder) => binder && binder.id && isLive(binder)).map((binder) => [binder.id, binder]));
	const trays = new Map();

	for (const [entryId, {naming}] of stranded) {
		let pocketed = false;
		let tray = null;

		for (const move of naming) {
			const kept = move.undo || {};

			for (const item of kept.binders || []) {
				const pockets = (item.pockets || []).filter((pocket) => pocket && pocket.entry_id === entryId);

				if (pockets.length) {
					pocketed = true;
					binderOf(item.id).pockets.push(...pockets);
				}

				const before = item.staged && Array.isArray(item.staged.before) ? item.staged.before : [];

				if (!tray && before.includes(entryId)) {
					tray = {binderId: item.id, index: before.indexOf(entryId)};
				}
			}

			for (const item of kept.collections || []) {
				const current = ((doc.collections || []).find((collection) => collection && collection.id === item.id) || {}).removed_ids || {};

				(item.ids || []).forEach((id, i) => {
					if (id === entryId && current[id] === (item.written || [])[i]) {
						const into = collections.get(item.id) || collections.set(item.id, {id: item.id, ids: [], written: []}).get(item.id);

						if (!into.ids.includes(id)) {
							into.ids.push(id);
							into.written.push(item.written[i]);
						}
					}
				});
			}

			for (const pick of kept.picks || []) {
				const current = (Array.isArray(doc.binder_picks) ? doc.binder_picks : []).find((item) => item && item.id === pick.id);

				if (pick && pick.entry_id === entryId && current && current.updated_at === pick.written) {
					picks.set(pick.id, pick);
				}
			}
		}

		// A copy that was in a pocket goes back there or nowhere; one that was
		// in a tray goes back to it, at its old place, while the binder is
		// still there and holds it nowhere else.
		if (!pocketed && tray && liveBinder.has(tray.binderId)) {
			const order = trays.get(tray.binderId) || [...stagedOf(liveBinder.get(tray.binderId))];

			if (!order.includes(entryId)) {
				order.splice(Math.min(tray.index, order.length), 0, entryId);
				trays.set(tray.binderId, order);
			}
		}
	}

	for (const [binderId, before] of trays) {
		binderOf(binderId).staged = {after: stagedOf(liveBinder.get(binderId)), before};
	}

	const done = undoSwap(doc, {
		added: [],
		binders: [...binders.values()],
		collections: [...collections.values()],
		fills: [],
		hashes: {},
		picks: [...picks.values()],
		removed: [...stranded].map(([id, {deleted_at: deletedAt}]) => ({deleted_at: deletedAt, id})),
		wishes: [],
	}, {drop: ['left_via'], now});

	return {count: done.counts.restored, doc: done.doc};
}

// Edit a logged move (Eric, 2026-11-05): the fields a move can change after
// it is logged. The cards are not among them: changing which cards went out
// or came in is Undo this move and logging it again. A purchase's card
// prices are (Eric, 2026-11-19): they price the cards, they do not change
// which cards came.
export const EDIT_FIELDS = ['date', 'who', 'price', 'currency', 'money', 'in_prices', 'note'];

export const UNDONE_EDIT_TEXT = 'This trade or sale was undone, on this phone or another, so it cannot be edited. Nothing was changed.';

// The price, its currency, which way the money went, and a purchase's card
// prices, as a move keeps them: all null without a price or for a gift; a
// sale's money comes in, a purchase's goes out, and a trade's goes the way
// given, if any. price is a number already read (cleanPrice); inPrices, a
// purchase's card prices already read (cleanInPrices) or null for one total.
// With card prices, the price is their sum, whatever price says, so the two
// never disagree.
function moneyFields(kind, price, currency, way, inPrices = null) {
	const each = kind === 'bought' && inPrices ? inPrices : null;
	const amount = each ? cleanPrice(sumPrices(Object.values(each))) : price;

	if (kind === 'gift' || !amount) {
		return {currency: null, in_prices: null, money: null, price: null};
	}

	return {
		currency: CURRENCIES.includes(currency) ? currency : 'BRL',
		in_prices: each,
		money: kind === 'sold' ? 'in' : kind === 'bought' ? 'out' : way === 'in' || way === 'out' ? way : null,
		price: amount,
	};
}

// The money unit: what Edit saves together, with one stamp.
const MONEY_FIELDS = ['price', 'currency', 'money', 'in_prices'];

// Only a purchase has card prices, so only a purchase stamps them: a sale's
// edit leaves its stamps as they were before card prices existed.
const unitOf = (kind) => (kind === 'bought' ? MONEY_FIELDS : MONEY_FIELDS.filter((key) => key !== 'in_prices'));

const same = (a, b) => stableJson(a ?? null) === stableJson(b ?? null);

// The card prices an edit means: those given (an object, every card blank
// being {}, which is no price at all); one total when given as null, or
// when a price is given without them; else the move's own, while they
// still tell (ownPrices).
function editedPrices(has, fields, move) {
	if (has('in_prices')) {
		const given = fields.in_prices;

		return given && typeof given === 'object' ? cleanInPrices(given, Array.isArray(move.in) ? move.in : []) || {} : null;
	}

	return has('price') ? null : ownPrices(move);
}

// The fields of an Edit form that differ from what the form opened with
// (base, the move it was filled from): a field left as it was is not sent,
// so a change another phone made to it while the form was open stays. The
// price, currency, money, and card prices count as one: when any of them
// differs, all of them go as the form shows them, so a price is never saved
// with a currency the person did not see beside it, nor a card price with
// a total it does not add up to.
function editedSince(kind, fields, base) {
	const has = (key) => Object.prototype.hasOwnProperty.call(fields, key);
	const out = {};

	if (has('date') && fields.date !== base.date) {
		out.date = fields.date;
	}

	for (const key of ['who', 'note']) {
		if (has(key) && text(fields[key]) !== text(base[key])) {
			out[key] = fields[key];
		}
	}

	if (MONEY_FIELDS.some(has)) {
		const opened = moneyFields(kind, cleanPrice(base.price), base.currency, base.money, ownPrices({...base, kind}));
		const shown = moneyFields(kind, has('price') ? cleanPrice(fields.price) : opened.price, has('currency') ? fields.currency : base.currency, has('money') ? fields.money : base.money, editedPrices(has, fields, {...base, kind}));

		if (MONEY_FIELDS.some((key) => !same(shown[key], opened[key]))) {
			Object.assign(out, shown);
		}
	}

	return out;
}

// What an edit does to `doc`: the move's date, who, price (with its currency
// and which way the money went, and a purchase's card prices), and note,
// from the fields given (a field left out stays as it is), read as planMove
// reads them. Nothing else on the move changes (kind, out, in, past, undo,
// after_run, created_at), and no copy is touched, so Undo of the move works
// as before.
//
// in_prices, on a purchase (Eric, 2026-11-19): {entry id: typed or number}
// for each card's own price, the price then being their sum, or null for
// one total. A price given without in_prices is one total, so the card
// prices go; left out with the price too, the card prices stay.
//
// base: the move as the Edit form opened with it. Given, only the fields
// whose value differs from base are applied (editedSince), so the form,
// which sends every field, never puts back a value another phone changed
// while it was open.
//
// The move is stamped field by field (js/merge.js stampEntry), only where a
// value changed, so two phones editing different fields both keep their
// change. The price, currency, money, and card prices are one unit: when
// any of them changes, all of them take the same stamp, so the merge takes
// all of them from the same phone (a price cleared on one phone and changed
// on another never comes out as a price with no currency or way, and card
// prices from one phone never sit under a total from another).
//
// Returns {changed: [field, ...], doc, move, stale}; `doc` itself is not
// changed. stale is true, and nothing changes, when the move is gone or
// undone (a tombstone cannot be edited). A price or card price neither
// form reads is refused with PRICE_FORM_TEXT.
export function planEditMove(doc, moveId, fields = {}, {base = null, now = Date.now()} = {}) {
	const move = moveById(doc, moveId);

	if (!move || !isLive(move)) {
		return {changed: [], doc: structuredClone(doc), move: null, stale: true};
	}

	const unreadable = (value) => typeof value !== 'number' && Boolean(parsePrice(value).error);

	if (Object.prototype.hasOwnProperty.call(fields, 'price') && unreadable(fields.price)) {
		throw new Error(PRICE_FORM_TEXT);
	}

	if (fields.in_prices && typeof fields.in_prices === 'object' && Object.values(fields.in_prices).some(unreadable)) {
		throw new Error(PRICE_FORM_TEXT);
	}

	const wanted = base ? editedSince(move.kind, fields, base) : fields;
	const has = (key) => Object.prototype.hasOwnProperty.call(wanted, key);
	const next = {...move};

	if (has('date') && /^\d{4}-\d{2}-\d{2}$/.test(String(wanted.date || ''))) {
		next.date = wanted.date;
	}

	if (has('who')) {
		next.who = text(wanted.who);
	}

	if (has('note')) {
		next.note = text(wanted.note);
	}

	if (move.kind === 'gift' || MONEY_FIELDS.some(has)) {
		const price = has('price') ? cleanPrice(wanted.price) : cleanPrice(move.price);

		Object.assign(next, moneyFields(move.kind, price, has('currency') ? wanted.currency : move.currency, has('money') ? wanted.money : move.money, editedPrices(has, wanted, move)));

		// Absent rather than null, as planMove leaves a move with one total.
		if (!next.in_prices) {
			delete next.in_prices;
		}
	}

	const changed = EDIT_FIELDS.filter((key) => !same(next[key], move[key]));

	if (!changed.length) {
		return {changed, doc: structuredClone(doc), move, stale: false};
	}

	const at = nextStamp(move.updated_at, now);
	const edited = stampEntry(move, {...next, updated_at: at});
	const unit = unitOf(move.kind);

	if (unit.some((key) => changed.includes(key))) {
		for (const key of unit) {
			edited.field_stamps[key] = at;
		}
	}

	const out = structuredClone(doc);

	out.moves = list(out).map((item) => (item && item.id === move.id ? edited : item));

	return {changed, doc: out, move: edited, stale: false};
}

// The price as the Edit form shows it, the Brazilian way: 1500 is
// "1.500,00", which parsePrice reads back as 1500. Built by hand rather
// than with toLocaleString('pt-BR'), which a phone without that locale's
// data answers as "1,500.00", a form parsePrice refuses. '' for no price.
export function priceForInput(value) {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		return '';
	}

	const [whole, cents] = (Math.round(value * 100) / 100).toFixed(2).split('.');

	return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${cents}`;
}

// How each copy of a card came and went, for its page: [{side: 'in' |
// 'out', move, entries, price}], one row per move and side, newest move
// first. side 'in' is a live copy that came with a live move; 'out' a copy
// that left with one (a removed copy). On a purchase priced card by card,
// copies that came are one row per price of their own (Eric, 2026-11-19),
// price being that amount, or null for a copy with none; price is
// undefined on every other row.
export function cardHistory(doc, {card_id: cardId, catalog = 'international'}) {
	const moves = new Map(liveMoves(doc).map((move) => [move.id, move]));
	const own = new Map();
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

		if (!own.has(move.id)) {
			own.set(move.id, ownPrices(move));
		}

		const prices = side === 'in' ? own.get(move.id) : null;
		const price = prices ? prices[entry.id] || null : undefined;
		const key = `${move.id}|${side}|${price ?? ''}`;
		const row = rows.get(key) || {entries: [], move, price, side};

		row.entries.push(entry);
		rows.set(key, row);
	}

	return [...rows.values()].sort((a, b) => newestFirst(a.move, b.move) || a.side.localeCompare(b.side) || (a.price || 0) - (b.price || 0));
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

// What one copy of a purchase priced card by card cost, in words: "bought
// from Liga for R$ 12,00", "for R$ 12,00 each" when the row stands for
// several copies, and no price for a copy with none of its own (the total
// is for the other cards; Eric, 2026-11-19).
function ownPriceWords(row) {
	const who = text(row.move.who);
	const money = moneyOf(row.move);
	const price = row.price && money ? formatMoney(row.price, money.currency) : null;

	return `bought${who ? ` from ${who}` : ''}${price ? ` for ${price}${row.entries.length > 1 ? ' each' : ''}` : ''}`;
}

// A sale's or purchase's total, on a card page row that is only part of it
// (QA, 2026-11-20: "bought for R$ 100,00" on each of three cards read as
// each one's price): "1 of 3 cards bought for R$ 100,00 from Liga", "2 of
// 3 cards sold for R$ 120,00 to Ana", "all 3 bought for R$ 100,00" when
// the row holds every card on its side. Null when the move has no total, or
// only one card on that side, which reads as before.
function partOfTotalWords(row) {
	const {move, side} = row;
	const bought = move.kind === 'bought' && side === 'in';
	const price = priceText(move);

	if (!price || !(bought || (move.kind === 'sold' && side === 'out'))) {
		return null;
	}

	const total = (bought ? move.in : move.out) || [];
	const n = Array.isArray(total) ? total.length : 0;
	const k = Array.isArray(row.entries) ? row.entries.length : 1;

	if (n < 2) {
		return null;
	}

	const who = text(move.who);

	return `${k >= n ? `all ${n}` : `${k} of ${n} cards`} ${bought ? 'bought' : 'sold'} for ${price}${who ? ` ${bought ? 'from' : 'to'} ${who}` : ''}`;
}

// A card page's line for one row of cardHistory: "Left: sold for R$ 30,50
// to Ana, 3 Nov"; "Came in: traded with Bruno, 4 Nov"; "Came in: bought
// from Liga for R$ 12,00, 12 Nov" for a copy with its own price; "Came in:
// 1 of 3 cards bought for R$ 100,00 from Liga, 12 Nov" for a copy of a
// purchase with one total (partOfTotalWords).
export function historyLine(row, {now = new Date()} = {}) {
	const date = shortDate(row.move.date, {now});
	const words = row.price !== undefined ? ownPriceWords(row) : partOfTotalWords(row) || moveWords(row.move, row.side);

	return `${row.side === 'in' ? 'Came in' : 'Left'}: ${words}${date ? `, ${date}` : ''}`;
}

// A purchase's cards with their own prices, for History's sheet (Eric,
// 2026-11-19): [{entries, price}] in the order they came, copies with the
// same card, language, and price as one row; price null for a copy with
// none. cards: the document's copies, removed ones included, since a copy
// that left since still cost what it cost. prices: the card prices to
// group by, by default the move's own while they tell (ownPrices); Edit
// passes the ones kept on the move even when an older phone's Edit of the
// total left them behind. Null when there are none.
export function pricedCards(move, cards, prices = ownPrices(move)) {
	if (!prices) {
		return null;
	}

	const byId = new Map((cards || []).filter((entry) => entry && entry.id).map((entry) => [entry.id, entry]));
	const rows = new Map();

	for (const id of move.in) {
		const entry = byId.get(id);

		if (!entry) {
			continue;
		}

		const price = prices[id] || null;
		const key = `${entry.catalog || 'international'}|${entry.card_id}|${entry.language || ''}|${price ?? ''}`;
		const row = rows.get(key) || {entries: [], price};

		row.entries.push(entry);
		rows.set(key, row);
	}

	return [...rows.values()];
}

// ------------------------------------------------------------- saved

// Saved: logs a move in one save. Resolves {counts, move}; on a failed
// write it rejects and the document on the phone is as it was. id, when
// given, is the move's: a move with it already logged is refused with an
// error whose logged is true (planMove).
export async function applyMove(fields, {id = null} = {}) {
	const current = await loadDocument();
	const {counts, doc, move} = planMove(current, fields, {fill: autoFillOn(current), fillUndo: await keptStartOver(current), ...(id ? {id} : {})});

	await saveCopy(doc);

	return {counts, move};
}

// Saved: undoes a move (Undo on the toast, or Undo this move in History).
// Resolves its counts; rejects with an error whose stale is true, and whose
// message says why (staleMoveText), when it was refused.
export async function undoMove(moveId) {
	const result = planUndoMove(await loadDocument(), moveId);
	const {counts, doc, stale} = result;

	if (stale) {
		throw Object.assign(new Error(staleMoveText(result)), {reason: result.reason, stale: true});
	}

	await saveCopy(doc);

	return counts;
}

// Saved: edits a move's date, who, price, and note (Edit in History). base:
// the move as the form opened with it (planEditMove). Resolves {changed,
// move}; saves nothing when nothing changed. Rejects with an error whose
// stale is true when the move was undone, and with PRICE_FORM_TEXT for a
// price it cannot read.
export async function editMove(moveId, fields, {base = null} = {}) {
	const {changed, doc, move, stale} = planEditMove(await loadDocument(), moveId, fields, {base});

	if (stale) {
		throw Object.assign(new Error(UNDONE_EDIT_TEXT), {reason: 'gone', stale: true});
	}

	if (changed.length) {
		await saveCopy(doc);
	}

	return {changed, move};
}

export const LOGGED_TEXT = 'This trade or sale is saved already.';

// The copies a move form opens with, handed over by Trade or sale (a copy
// sheet, a card's page) or the scanner when it opens the form: {out: [ids],
// card: {card_id, catalog} | null}, and the scanner's cards coming in. Data
// only, so the form can keep it for a reload and Back and Forward
// (js/moves-view.js). Taken once.
let pending = null;

export function setPendingMove(value) {
	pending = value || null;
}

export function takePendingMove() {
	const value = pending;

	pending = null;

	return value;
}
