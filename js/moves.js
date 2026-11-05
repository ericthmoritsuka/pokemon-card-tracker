// The trades and sales log (DESIGN.md section 11, "Trades and Sales"; Eric,
// 2026-10-31 and 2026-11-04): each sale, purchase, trade, or gift is one
// entry in the document's `moves` list, merged entry by entry like the other
// lists (js/merge.js mergeDocuments merges every top-level list, so phones
// from v21 on keep the list and its entries whole):
//
//   {id, kind, date, who, price, currency, money, note, out, past, in, undo,
//    after_run, created_at, updated_at, deleted_at}
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
// nothing that brought it.
// Edit (Eric, 2026-11-05) changes a logged move's date, who, price, and
// note, stamped field by field (the price, currency, and money as one
// unit), and never its cards, undo, or after_run, so Undo works the same
// after it; an undone move cannot be edited. The form sends only what was
// changed in it, so it never puts back what another phone changed.
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
	const price = cleanPrice(fields.price);
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

	next.moves = [...list(next), move];

	return {
		counts: {filled: swap.after.placed.length, got: swap.after.got.length, in: added.length, out: removed.size, past: past.length, pockets: swap.pockets},
		doc: next,
		move,
	};
}

export const STALE_MOVE_TEXT = 'You started over after this move, so undoing it would put old copies back beside the new ones. Nothing was changed.';

export const UNDID_START_OVER_MOVE_TEXT = 'You undid Start over after this move, so undoing it could bring copies back twice. Nothing was changed.';

export const GONE_MOVE_TEXT = 'This move was already undone, on this phone or another. Nothing was changed.';

// Why Undo of a move was refused, for its message.
export function staleMoveText({later = null, reason = 'gone'} = {}, {now = new Date()} = {}) {
	if (reason === 'later' && later) {
		const date = shortDate(later.date, {now});

		return `A later move, "${moveTitle(later)}"${date ? ` on ${date}` : ''}, counts a card this move brought in. Undo that move first. Nothing was changed.`;
	}

	return reason === 'run' ? STALE_MOVE_TEXT : reason === 'undo' ? UNDID_START_OVER_MOVE_TEXT : GONE_MOVE_TEXT;
}

// Why Start over's Undo was refused (js/start-over.js movesAfterRun),
// naming the newest move in the way.
export function startOverBlockedText(move, {now = new Date()} = {}) {
	const date = shortDate(move.date, {now});

	return `"${moveTitle(move)}"${date ? ` on ${date}` : ''} in Trades and sales counts a copy that Undo Start over would change. Undo that move first, then Undo Start over. Nothing was changed.`;
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
	const counts = {added: 0, kept: 0, restored: 0, unlinked: 0};
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

	return {counts: {...counts, ...done.counts}, doc: next, later: null, reason: null, stale: false};
}

// Edit a logged move (Eric, 2026-11-05): the fields a move can change after
// it is logged. The cards are not among them: changing which cards went out
// or came in is Undo this move and logging it again.
export const EDIT_FIELDS = ['date', 'who', 'price', 'currency', 'money', 'note'];

export const UNDONE_EDIT_TEXT = 'This move was undone, on this phone or another, so it cannot be edited. Nothing was changed.';

// The price, its currency, and which way the money went, as a move keeps
// them: all null without a price or for a gift; a sale's money comes in, a
// purchase's goes out, and a trade's goes the way given, if any. price is a
// number already read (cleanPrice).
function moneyFields(kind, price, currency, way) {
	if (kind === 'gift' || !price) {
		return {currency: null, money: null, price: null};
	}

	return {
		currency: CURRENCIES.includes(currency) ? currency : 'BRL',
		money: kind === 'sold' ? 'in' : kind === 'bought' ? 'out' : way === 'in' || way === 'out' ? way : null,
		price,
	};
}

const MONEY_FIELDS = ['price', 'currency', 'money'];

// The fields of an Edit form that differ from what the form opened with
// (base, the move it was filled from): a field left as it was is not sent,
// so a change another phone made to it while the form was open stays. The
// price, currency, and money count as one: when any of them differs, all
// three go as the form shows them, so a price is never saved with a
// currency the person did not see beside it.
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
		const opened = moneyFields(kind, cleanPrice(base.price), base.currency, base.money);
		const shown = moneyFields(kind, has('price') ? cleanPrice(fields.price) : opened.price, has('currency') ? fields.currency : base.currency, has('money') ? fields.money : base.money);

		if (MONEY_FIELDS.some((key) => shown[key] !== opened[key])) {
			Object.assign(out, shown);
		}
	}

	return out;
}

// What an edit does to `doc`: the move's date, who, price (with its currency
// and which way the money went), and note, from the fields given (a field
// left out stays as it is), read as planMove reads them. Nothing else on
// the move changes (kind, out, in, past, undo, after_run, created_at), and
// no copy is touched, so Undo of the move works as before.
//
// base: the move as the Edit form opened with it. Given, only the fields
// whose value differs from base are applied (editedSince), so the form,
// which sends every field, never puts back a value another phone changed
// while it was open.
//
// The move is stamped field by field (js/merge.js stampEntry), only where a
// value changed, so two phones editing different fields both keep their
// change. The price, currency, and money are one unit: when any of them
// changes, all three take the same stamp, so the merge takes all three from
// the same phone (a price cleared on one phone and changed on another never
// comes out as a price with no currency or way).
//
// Returns {changed: [field, ...], doc, move, stale}; `doc` itself is not
// changed. stale is true, and nothing changes, when the move is gone or
// undone (a tombstone cannot be edited). A price neither form reads is
// refused with PRICE_FORM_TEXT.
export function planEditMove(doc, moveId, fields = {}, {base = null, now = Date.now()} = {}) {
	const move = moveById(doc, moveId);

	if (!move || !isLive(move)) {
		return {changed: [], doc: structuredClone(doc), move: null, stale: true};
	}

	if (Object.prototype.hasOwnProperty.call(fields, 'price') && typeof fields.price !== 'number' && parsePrice(fields.price).error) {
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

		Object.assign(next, moneyFields(move.kind, price, has('currency') ? wanted.currency : move.currency, has('money') ? wanted.money : move.money));
	}

	const changed = EDIT_FIELDS.filter((key) => (next[key] ?? null) !== (move[key] ?? null));

	if (!changed.length) {
		return {changed, doc: structuredClone(doc), move, stale: false};
	}

	const at = nextStamp(move.updated_at, now);
	const edited = stampEntry(move, {...next, updated_at: at});

	if (MONEY_FIELDS.some((key) => changed.includes(key))) {
		for (const key of MONEY_FIELDS) {
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
