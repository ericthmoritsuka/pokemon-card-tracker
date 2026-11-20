// Unit tests for the trades and sales log (js/moves.js; DESIGN.md section
// 11, "Trades and Sales", Eric 2026-10-31, 2026-11-04, and 2026-11-05): what
// a move removes and adds, binder pockets, Log a past sale, Undo and
// deleting a move (after another phone edited an incoming copy, and after a
// sync), Edit of a logged move (its fields, two phones' edits, Undo after
// it, and an undone move), the money per month, two phones logging moves,
// older phones that do not know `moves`, `left_via`, or `came_via`, and a
// purchase priced card by card (Eric, 2026-11-19: `in_prices`, its Edit
// unit, its merge, and older phones). Plain Node over an in-memory
// IndexedDB; invented data only, and nothing is requested.
//
// Run: node --test tests/moves.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {fakeIndexedDb} from './fake-indexeddb.mjs';

// js/collection.js reaches window when it loads.
globalThis.window = globalThis.window || globalThis;
globalThis.addEventListener = globalThis.addEventListener || (() => {});

// The in-memory database, with a switch that makes every write fail.
const fake = fakeIndexedDb();
let failWrites = false;

globalThis.indexedDB = {
	open(name) {
		const req = fake.open(name);
		let onsuccess = null;

		Object.defineProperty(req, 'onsuccess', {
			get: () => (onsuccess ? () => {
				const db = req.result;
				const transaction = db.transaction;

				db.transaction = (stores) => {
					const tx = transaction(stores);

					if (!failWrites) {
						return tx;
					}

					const objectStore = tx.objectStore;
					let complete = null;

					tx.objectStore = (store) => ({...objectStore(store), put: (value, key) => objectStore(store).get(key)});
					Object.defineProperty(tx, 'oncomplete', {
						get: () => (complete ? () => tx.onabort && tx.onabort() : null),
						set: (fn) => {
							complete = fn;
						},
					});

					return tx;
				};
				onsuccess();
			} : null),
			set: (fn) => {
				onsuccess = fn;
			},
		});

		return req;
	},
};
globalThis.BroadcastChannel = undefined;
globalThis.fetch = async (url) => {
	throw new Error(`No requests in this test (${url}).`);
};

const collection = await import('../js/collection.js');
const {mergeDocuments, stableJson, stampEntry} = await import('../js/merge.js');
const v47 = await import('./v47/merge.js');
const v21 = await import('./merge-v21.mjs');
const {applyMove, cardHistory, cleanPrice, editMove, historyLine, moneyOf, monthTotals, moveTitle, ownPrices, parsePrice, pastCandidates, planEditMove, planMove, planUndoMove, priceForInput, pricedCards, purchaseSources, startOverBlockedText, sumPrices, twiceOut, twiceOutText, undoMove} = await import('../js/moves.js');
const {importEntries} = await import('../js/monprice.js');
const {planStartOver, planUndo, startOverIds} = await import('../js/start-over.js');

const at = (day, hour = 10) => `2026-10-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const NOW = Date.parse('2026-11-04T12:00:00.000Z');
const LATER = Date.parse('2026-11-05T12:00:00.000Z');

const card = (id, fields = {}) => ({card_id: 'tst1-001', catalog: 'international', created_at: at(1), deleted_at: null, id, language: 'pt', updated_at: at(1), variant_id: 'normal', ...fields});

// a1 and a2 are two copies of card 1, a1 in binder b1's pocket 1 and in a
// hand-picked collection; a3 of card 2 sits in the tray. r1 was removed by
// hand two days ago, r2 forty days ago, r3 was folded into a1 by the
// duplicate repair. A wish for card 3 in English waits, and binder b1 holds
// a placeholder for card 3.
function startDoc() {
	return {
		binders: [{
			cols: 3, created_at: at(1), deleted_at: null, id: 'b1', name: 'Binder', page_count: 1, rows: 3,
			slots: [
				{entry_id: 'a1', page: 1, placed_at: at(2), position: 1},
				{page: 1, placed_at: at(2), position: 5, want: {card_id: 'tst1-003', catalog: 'international', image: null, language: 'en', name: 'Card 3', variant_id: null}},
			],
			staged: ['a3'],
			updated_at: at(2),
		}],
		card_info: [{card_id: 'tst1-001', catalog: 'international', created_at: at(1), deleted_at: null, id: 'international~tst1-001~pt', language: 'pt', notes: ['From a fair'], photos: [{id: 'p1', path: 'u/p1/p1.webp'}], updated_at: at(3)}],
		cards: [
			card('a1'),
			card('a2', {created_at: at(2), updated_at: at(2)}),
			card('a3', {card_id: 'tst1-002'}),
			card('r1', {card_id: 'tst1-004', deleted_at: '2026-11-02T09:00:00.000Z', updated_at: '2026-11-02T09:00:00.000Z'}),
			card('r2', {card_id: 'tst1-005', deleted_at: '2026-09-25T09:00:00.000Z', updated_at: '2026-09-25T09:00:00.000Z'}),
			card('r3', {deleted_at: '2026-11-03T09:00:00.000Z', merged_into: 'a1', updated_at: '2026-11-03T09:00:00.000Z'}),
		],
		collections: [{created_at: at(1), deleted_at: null, entry_ids: {a1: at(4)}, id: 'c1', kind: 'hand', name: 'Best', rule: null, updated_at: at(4)}],
		goals: [], openings: [],
		wishlist: [{card_id: 'tst1-003', catalog: 'international', created_at: at(1), deleted_at: null, id: 'w1', language: 'en', updated_at: at(1)}],
	};
}

const byId = (doc, id) => doc.cards.find((entry) => entry && entry.id === id);
const slotAt = (doc, position) => doc.binders[0].slots.find((slot) => slot.page === 1 && slot.position === position && !slot.cleared) || null;
const IN_CARD = {card_id: 'tst1-003', catalog: 'international', condition: 'Near Mint', language: 'en', language_source: 'manual', variant_id: 'normal'};

const sale = (doc = startDoc(), extra = {}) => planMove(doc, {currency: 'BRL', date: '2026-11-03', kind: 'sold', out: ['a1'], price: '30,50', who: 'Ana', ...extra}, {fill: true, id: 'm1', now: NOW});
const trade = (doc = startDoc()) => planMove(doc, {date: '2026-11-04', in: [IN_CARD], kind: 'traded', money: 'out', out: ['a1'], price: 5, who: 'Bruno'}, {fill: true, id: 'm2', now: NOW});

describe('planMove', () => {
	test('a move id already logged, live or undone, is refused, so a form kept for a reload never logs its move twice (QA, 2026-11-20)', () => {
		const {doc} = sale();

		assert.throws(() => planMove(doc, {kind: 'sold', out: ['a2'], price: '1'}, {id: 'm1', now: NOW}), (err) => err.logged === true && err.message === 'This trade or sale is saved already.');

		const undone = planUndoMove(doc, 'm1', {now: LATER}).doc;

		assert.throws(() => planMove(undone, {kind: 'sold', out: ['a1'], price: '1'}, {id: 'm1', now: LATER + 1000}), (err) => err.logged === true);
		assert.equal(planMove(undone, {kind: 'sold', out: ['a1'], price: '1'}, {id: 'm9', now: LATER + 1000}).move.id, 'm9', 'another id saves');
	});

	test('a sale tombstones the copy with left_via, its pocket becomes the card\'s placeholder, and the move is logged', () => {
		const before = startDoc();
		const {counts, doc, move} = sale(before);
		const gone = byId(doc, 'a1');

		assert.ok(gone.deleted_at, 'the copy is removed, as deleteCards removes it');
		assert.equal(gone.left_via, 'm1');
		assert.equal(gone.updated_at, gone.deleted_at);
		assert.equal(gone.field_stamps.at, gone.updated_at, 'stamped, so the merge takes the removal and the link');
		assert.deepEqual(slotAt(doc, 1).want, {card_id: 'tst1-001', catalog: 'international', image: null, language: 'pt', name: null, variant_id: 'normal'});
		assert.equal(slotAt(doc, 1).entry_id, undefined);
		assert.ok(!doc.collections[0].entry_ids.a1 || doc.collections[0].removed_ids.a1, 'the hand-picked collection drops it');
		assert.deepEqual(doc.card_info, before.card_info, 'photos and notes on the card record are untouched');
		assert.equal(stableJson(before), stableJson(startDoc()), 'the document passed in is not changed');
		assert.deepEqual(counts, {filled: 0, got: 0, in: 0, out: 1, past: 0, pockets: 1});
		assert.deepEqual({...move, undo: undefined}, {
			after_run: null, created_at: new Date(NOW).toISOString(), currency: 'BRL', date: '2026-11-03', deleted_at: null, id: 'm1', in: [], kind: 'sold', money: 'in', note: null,
			out: ['a1'], past: [], price: 30.5, undo: undefined, updated_at: new Date(NOW).toISOString(), who: 'Ana',
		});
		assert.deepEqual(doc.moves, [move]);
	});

	test('a trade adds the incoming copy with came_via through the add helper: it fills the waiting placeholder and moves the wish to Got it', () => {
		const {counts, doc, move} = trade();
		const added = byId(doc, move.in[0]);

		assert.equal(added.came_via, 'm2');
		assert.equal(added.condition, 'Near Mint');
		assert.ok(!added.deleted_at);
		assert.equal(added.created_at, new Date(NOW).toISOString());
		assert.equal(slotAt(doc, 5).entry_id, added.id, 'the placeholder for card 3 holds the new copy');
		assert.ok(doc.wishlist[0].got_at, 'the wish moved to Got it');
		assert.equal(doc.wishlist[0].got_entry_id, added.id);
		assert.deepEqual(counts, {filled: 1, got: 1, in: 1, out: 1, past: 0, pockets: 1});
		assert.equal(move.money, 'out');
		assert.equal(moneyOf(move).way, 'out');
	});

	test('with the placeholder setting off, the incoming copy fills nothing, and the wish still moves', () => {
		const doc = startDoc();
		const {counts} = planMove(doc, {in: [IN_CARD], kind: 'bought', price: 20}, {fill: false, id: 'm3', now: NOW});

		assert.equal(counts.filled, 0);
		assert.equal(counts.got, 1);
	});

	test('a move with no card is refused, and a gift keeps no price', () => {
		assert.throws(() => planMove(startDoc(), {kind: 'sold', out: []}, {now: NOW}), /at least one card/);
		assert.throws(() => planMove(startDoc(), {kind: 'swapped', out: ['a1']}, {now: NOW}), /Unknown kind/);

		const {move} = planMove(startDoc(), {currency: 'USD', kind: 'gift', money: 'in', out: ['a2'], price: 9}, {now: NOW});

		assert.deepEqual([move.price, move.currency, move.money], [null, null, null]);
	});

	test('a tray holding the copy drops it, and a copy already gone is not moved', () => {
		const {doc} = planMove(startDoc(), {kind: 'traded', out: ['a3', 'r1x']}, {id: 'm4', now: NOW});

		assert.deepEqual(doc.binders[0].staged, []);
		assert.deepEqual(doc.moves[0].out, ['a3']);
	});
});

describe('Log a past sale', () => {
	test('offers copies removed in the last 30 days, newest first, and leaves out folded, old, and Start over copies', () => {
		const doc = startDoc();

		doc.cards.push(card('r4', {deleted_at: '2026-10-30T08:00:00.000Z', updated_at: '2026-10-30T08:00:00.000Z'}));
		doc.cards.push(card('r5', {deleted_at: '2026-10-20T15:00:00.000Z', updated_at: '2026-10-20T15:00:00.000Z'}));
		doc.start_over = {at: '2026-10-20T15:00:00.000Z', id: 'run1'};

		assert.deepEqual(pastCandidates(doc, {now: NOW}).map((entry) => entry.id), ['r1', 'r4']);
	});

	test('picking one links it with left_via and leaves its deletion as it was', () => {
		const before = startDoc();
		const {counts, doc, move} = planMove(before, {kind: 'sold', past: ['r1', 'r2', 'r3'], price: 12}, {id: 'm5', now: NOW});
		const linked = byId(doc, 'r1');

		assert.equal(linked.left_via, 'm5');
		assert.equal(linked.deleted_at, byId(before, 'r1').deleted_at, 'still removed when it was');
		assert.ok(linked.updated_at > byId(before, 'r1').updated_at, 'a newer version, so the link syncs');
		assert.equal(byId(doc, 'r2').left_via, undefined, 'older than 30 days: not linked');
		assert.equal(byId(doc, 'r3').left_via, undefined, 'folded into another copy: not linked');
		assert.deepEqual([move.out, move.past], [['r1'], ['r1']]);
		assert.equal(counts.past, 1);
		assert.deepEqual(pastCandidates(doc, {now: NOW}).map((entry) => entry.id), [], 'a copy a move names is no longer offered');
		assert.deepEqual(cardHistory(doc, {card_id: 'tst1-004'}).map((row) => [row.side, row.move.id, row.entries.map((entry) => entry.id)]), [['out', 'm5', ['r1']]]);
	});

	test('undoing it unlinks the copy and leaves it removed, so it is offered again', () => {
		const {doc} = planMove(startDoc(), {kind: 'sold', past: ['r1']}, {id: 'm5', now: NOW});
		const undone = planUndoMove(doc, 'm5', {now: LATER});

		assert.equal(undone.stale, false);
		assert.equal(undone.counts.unlinked, 1);
		assert.equal(undone.counts.restored, 0);
		assert.equal(byId(undone.doc, 'r1').left_via, undefined);
		assert.equal(byId(undone.doc, 'r1').deleted_at, '2026-11-02T09:00:00.000Z');
		assert.ok(byId(undone.doc, 'r1').field_stamps.left_via, 'the unlink is stamped, so a merge does not bring the link back');
		assert.deepEqual(pastCandidates(undone.doc, {now: LATER}).map((entry) => entry.id), ['r1']);
	});
});

describe('Undo and deleting a move', () => {
	test('Undo brings the copy back with its pocket and collection, removes the incoming copy and its fill, and puts the wish back', () => {
		const {doc} = trade();
		const added = doc.moves[0].in[0];
		const {counts, doc: back, stale} = planUndoMove(doc, 'm2', {now: LATER});

		assert.equal(stale, false);
		assert.deepEqual(counts, {added: 1, held: 0, kept: 0, restored: 1, unlinked: 0});
		assert.ok(!byId(back, 'a1').deleted_at);
		assert.equal(byId(back, 'a1').left_via, undefined, 'a copy that comes back is no longer marked as gone');
		assert.ok(byId(back, 'a1').field_stamps.left_via, 'and that is stamped, so the tombstone cannot give it back');
		assert.ok(byId(back, added).deleted_at, 'the incoming copy goes');
		assert.equal(slotAt(back, 1).entry_id, 'a1');
		assert.ok(slotAt(back, 5).want, 'the placeholder it filled is a placeholder again');
		assert.ok(!back.wishlist[0].got_at, 'the wish is wanted again');
		assert.ok(back.collections[0].entry_ids.a1 > (back.collections[0].removed_ids || {}).a1 || !(back.collections[0].removed_ids || {}).a1);
		assert.ok(back.moves[0].deleted_at, 'the move is deleted');
		assert.deepEqual(cardHistory(back, {card_id: 'tst1-001'}), []);
		assert.deepEqual(monthTotals(back.moves), []);
		assert.equal(planUndoMove(back, 'm2', {now: LATER}).stale, true, 'a second Undo finds nothing to undo');
	});

	test('an incoming copy another phone changed since is kept, with its pocket, and the outgoing copy still comes back', () => {
		const {doc} = trade();
		const id = doc.moves[0].in[0];
		const other = structuredClone(doc);
		const copy = byId(other, id);

		other.cards[other.cards.indexOf(copy)] = stampEntry(copy, {...copy, is_favorite: true, updated_at: '2026-11-04T18:00:00.000Z'});

		const synced = mergeDocuments(doc, other);
		const {counts, doc: back} = planUndoMove(synced, 'm2', {now: LATER});

		assert.deepEqual(counts, {added: 0, held: 0, kept: 1, restored: 1, unlinked: 0});
		assert.ok(!byId(back, id).deleted_at);
		assert.equal(slotAt(back, 5).entry_id, id);
		assert.ok(back.wishlist[0].got_at, 'its wish stays Got it');
	});

	test('after a sync round trip, which drops empty fields, the unchanged incoming copy still counts as unchanged', () => {
		const {doc} = trade();
		const server = JSON.parse(JSON.stringify(mergeDocuments({}, doc)));
		const phone = mergeDocuments(startDoc(), server);
		const {counts, doc: back} = planUndoMove(phone, 'm2', {now: LATER});

		assert.deepEqual(counts, {added: 1, held: 0, kept: 0, restored: 1, unlinked: 0});
		assert.ok(!byId(back, 'a1').deleted_at);

		// And the Undo, synced to the phone that logged the move, sticks.
		const there = mergeDocuments(doc, back);

		assert.ok(!byId(there, 'a1').deleted_at);
		assert.equal(byId(there, 'a1').left_via, undefined);
		assert.ok(byId(there, doc.moves[0].in[0]).deleted_at);
		assert.ok(there.moves.find((move) => move.id === 'm2').deleted_at);
	});

	test('a pocket filled by hand since keeps what it holds', () => {
		const {doc} = sale();

		doc.binders[0].slots = doc.binders[0].slots.map((slot) => (slot.position === 1 ? {entry_id: 'a2', page: 1, placed_at: '2026-11-04T20:00:00.000Z', position: 1} : slot));

		const {doc: back} = planUndoMove(doc, 'm1', {now: LATER});

		assert.equal(slotAt(back, 1).entry_id, 'a2');
		assert.ok(!byId(back, 'a1').deleted_at, 'the copy comes back all the same');
	});

	test('after a Start over, Undo changes nothing', () => {
		const {doc} = sale();

		doc.start_over = {at: '2026-11-04T20:00:00.000Z', id: 'run2'};

		const undone = planUndoMove(doc, 'm1', {now: LATER});

		assert.equal(undone.stale, true);
		assert.equal(stableJson(undone.doc), stableJson(doc));
	});
});

describe('money per month', () => {
	test('sales come in, purchases go out, a trade names its way, a gift has none, per currency, newest month first', () => {
		const moves = [
			{date: '2026-11-03', id: 'x1', kind: 'sold', price: 30.5, currency: 'BRL', money: 'in'},
			{date: '2026-11-01', id: 'x2', kind: 'bought', price: 20, currency: 'BRL', money: 'out'},
			{date: '2026-11-02', id: 'x3', kind: 'traded', price: 5, currency: 'BRL', money: 'in'},
			{date: '2026-11-02', id: 'x4', kind: 'traded', price: 5, currency: 'BRL', money: null},
			{date: '2026-11-02', id: 'x5', kind: 'gift', price: null},
			{date: '2026-10-20', id: 'x6', kind: 'sold', price: 10, currency: 'USD', money: 'in'},
			{date: '2026-10-21', id: 'x7', kind: 'sold', price: 0.1, currency: 'BRL', money: 'in'},
			{date: '2026-10-21', id: 'x8', kind: 'sold', price: 0.2, currency: 'BRL', money: 'in'},
			{date: '2026-10-22', deleted_at: '2026-10-23T00:00:00.000Z', id: 'x9', kind: 'sold', price: 99, currency: 'BRL', money: 'in'},
		];
		const months = monthTotals(moves);

		assert.deepEqual(months.map((row) => [row.month, row.in, row.out, row.moves.map((move) => move.id)]), [
			['2026-11', {BRL: 35.5}, {BRL: 20}, ['x1', 'x3', 'x4', 'x5', 'x2']],
			['2026-10', {BRL: 0.3, USD: 10}, {}, ['x7', 'x8', 'x6']],
		]);
		assert.equal(cleanPrice('-3'), null);
		assert.equal(cleanPrice(''), null);
	});

	test('prices typed the Brazilian or the English way: a dot before exactly three digits groups thousands, anything else is refused', () => {
		const typed = {
			'1.500': 1500, '1.500,00': 1500, '2.000': 2000, '30,50': 30.5, '30,5': 30.5, '30.5': 30.5, '30.50': 30.5, '12': 12,
			'1.234': 1234, '1.500.000': 1500000, '1.500.000,99': 1500000.99, ' 1 500,00 ': 1500, '0,99': 0.99, '1234.5': 1234.5,
		};

		for (const [text, value] of Object.entries(typed)) {
			assert.deepEqual(parsePrice(text), {error: null, value}, text);
			assert.equal(cleanPrice(text), value, text);
		}

		for (const text of ['1,500.00', '1.50,00', '1,2,3', '1.2345', '30,505', 'abc', '0', '0,00', '-3', '1.500,', ',50', '12.34.56']) {
			assert.equal(parsePrice(text).value, null, text);
			assert.match(parsePrice(text).error, /30,50 or 1\.500,00/, text);
			assert.equal(cleanPrice(text), null, text);
		}

		assert.deepEqual(parsePrice('  '), {error: null, value: null}, 'empty is no price');
		assert.equal(cleanPrice(12.345), 12.35, 'a number is kept, to the cent');
		assert.equal(planMove(startDoc(), {kind: 'sold', out: ['a1'], price: '1.500'}, {id: 'm1', now: NOW}).move.price, 1500);
	});
});

describe('words', () => {
	test('a card page says how each copy came and went, and History titles each move', () => {
		const now = new Date('2026-11-04T12:00:00');
		const sold = {currency: 'BRL', date: '2026-11-03', kind: 'sold', money: 'in', price: 30.5, who: 'Ana'};

		assert.equal(historyLine({move: sold, side: 'out'}, {now}), 'Left: sold for R$\u00a030,50 to Ana, 3 Nov');
		assert.equal(historyLine({move: {date: '2025-12-12', kind: 'traded', money: 'out', price: 5, who: 'Bruno'}, side: 'in'}, {now}), 'Came in: traded with Bruno, R$\u00a05,00 paid, 12 Dec 2025');
		assert.equal(historyLine({move: {date: '2026-11-01', kind: 'gift', who: 'Ana'}, side: 'in'}, {now}), 'Came in: a gift from Ana, 1 Nov');
		assert.equal(moveTitle({in: [], kind: 'gift', out: ['a1'], who: 'Ana'}), 'Given to Ana');
		assert.equal(moveTitle({in: ['b1'], kind: 'bought', out: [], price: 20, who: null}), 'Bought for R$\u00a020,00');
	});
});

describe('two phones and older versions', () => {
	test('moves logged on two phones offline both survive the merge, either way round', () => {
		const one = sale().doc;
		const two = planMove(startDoc(), {in: [IN_CARD], kind: 'bought', price: 20}, {id: 'm9', now: NOW + 1000}).doc;
		const a = mergeDocuments(one, two);
		const b = mergeDocuments(two, one);

		for (const merged of [a, b]) {
			assert.deepEqual(merged.moves.map((move) => move.id).sort(), ['m1', 'm9']);
			assert.equal(byId(merged, 'a1').left_via, 'm1');
			assert.equal(byId(merged, two.moves[0].in[0]).came_via, 'm9');
		}

		assert.equal(stableJson(a.moves.slice().sort((x, y) => x.id.localeCompare(y.id))), stableJson(b.moves.slice().sort((x, y) => x.id.localeCompare(y.id))));
	});

	// QA, 2026-11-20: both phones offline, a sale of copy a1 to Ana on one
	// and a trade of the same copy to Lucas on the other. The merge keeps
	// both, as it keeps every entry; the log marks each with the other, the
	// same whichever way round the merge ran, and Undo of either one ends it
	// with the copy still out, named by the move that stays.
	test('the same copy logged out on two phones offline: both moves stay, each is marked with the other, and Undo of either ends it with the copy still out', () => {
		const phone = planMove(startDoc(), {currency: 'BRL', date: '2026-11-03', kind: 'sold', out: ['a1'], price: '10', who: 'Ana'}, {fill: true, id: 'm1', now: NOW}).doc;
		const laptop = planMove(startDoc(), {date: '2026-11-04', in: [IN_CARD], kind: 'traded', out: ['a1'], who: 'Lucas'}, {fill: true, id: 'm2', now: NOW + 5000}).doc;
		const merged = [mergeDocuments(phone, laptop), mergeDocuments(laptop, phone)];
		const now = new Date('2026-11-05T12:00:00');
		const marks = merged.map((doc) => [...twiceOut(doc.moves)].map(([id, others]) => [id, others.map((other) => [other.move.id, other.ids])]).sort());

		assert.deepEqual(marks[0], [['m1', [['m2', ['a1']]]], ['m2', [['m1', ['a1']]]]]);
		assert.deepEqual(marks[1], marks[0], 'the same marks whichever way round the merge ran');

		for (const doc of merged) {
			const twice = twiceOut(doc.moves);

			assert.equal(twiceOutText(twice.get('m1'), {names: () => ['Dipplin'], now}), 'Dipplin also left in "Traded with Lucas" on 4 Nov. Undo the one that did not happen.');
			assert.equal(twiceOutText(twice.get('m2'), {now}), 'This copy also left in "Sold for R$\u00a010,00 to Ana" on 3 Nov. Undo the one that did not happen.');
			assert.deepEqual(monthTotals(doc.moves).map((month) => [month.month, month.in, month.twice]), [['2026-11', {BRL: 10}, true]], 'the sale\'s money is counted, and the month says so');
			assert.ok(byId(doc, 'a1').deleted_at);

			for (const [undone, stays] of [['m1', 'm2'], ['m2', 'm1']]) {
				const {counts, doc: back, stale} = planUndoMove(doc, undone, {now: LATER});

				assert.equal(stale, false);
				assert.equal(counts.held, 1, `Undo of ${undone} keeps the copy out`);
				assert.equal(counts.restored, 0);
				assert.ok(byId(back, 'a1').deleted_at, `the copy stays out after Undo of ${undone}, whichever phone's removal the merge kept`);
				assert.equal(byId(back, 'a1').left_via, stays, 'and names the move that stays');
				assert.ok(slotAt(back, 1).want, 'its pocket stays a placeholder');
				assert.ok(!back.collections[0].entry_ids.a1 || back.collections[0].removed_ids.a1 >= back.collections[0].entry_ids.a1, 'and it does not go back in its collection');
				assert.deepEqual([...twiceOut(back.moves)], [], 'the mark is gone');
				assert.equal(monthTotals(back.moves)[0].twice, false);
				assert.equal(cardHistory(back, {card_id: 'tst1-001'}).length, 1);

				// Undo of the one left now brings the copy back.
				const last = planUndoMove(back, stays, {now: LATER + 60000});

				assert.equal(last.counts.held, 0);
				assert.ok(!byId(last.doc, 'a1').deleted_at, 'Undo of the move that stays brings the copy back');
			}
		}

		// The two phones' Undo and the merge agree as well.
		const undoneA = planUndoMove(merged[0], 'm1', {now: LATER}).doc;
		const undoneB = planUndoMove(merged[1], 'm1', {now: LATER}).doc;

		assert.equal(stableJson(byId(mergeDocuments(undoneA, undoneB), 'a1')), stableJson(byId(mergeDocuments(undoneB, undoneA), 'a1')));
	});

	test('an Undo on one phone and an edit to the move\'s note on another: the delete sticks', () => {
		const {doc} = sale();
		const undone = planUndoMove(doc, 'm1', {now: LATER}).doc;
		const edited = structuredClone(doc);

		edited.moves[0] = stampEntry(doc.moves[0], {...doc.moves[0], note: 'Paid in cash', updated_at: '2026-11-06T00:00:00.000Z'});

		assert.ok(mergeDocuments(edited, undone).moves[0].deleted_at);
		assert.ok(mergeDocuments(undone, edited).moves[0].deleted_at);
	});

	// js/merge.js is unchanged in v55, so mergeDocuments here is what v48 to
	// v54 run. tests/v47/merge.js and tests/merge-v21.mjs are frozen copies of
	// the older rules.
	for (const [name, old] of [['v47', v47], ['v21', v21]]) {
		test(`a ${name} phone that never heard of moves keeps them, and the stamps on copies, when it merges, edits, and saves`, () => {
			const server = trade().doc;
			const id = server.moves[0].in[0];
			// The old phone's own document, from before the move.
			const mine = startDoc();
			let merged = old.mergeDocuments(mine, server);

			assert.deepEqual(merged.moves, server.moves, 'the list it does not know is merged entry by entry and kept');
			assert.equal(byId(merged, 'a1').left_via, 'm2');
			assert.equal(byId(merged, id).came_via, 'm2');

			// It edits the incoming copy in place, the way its updateCard does,
			// and its merge with the server's next version keeps both stamps.
			const copy = byId(merged, id);

			Object.assign(copy, {condition: 'Played', updated_at: '2026-11-04T19:00:00.000Z'});
			merged = old.mergeDocuments(merged, server);
			assert.equal(byId(merged, id).came_via, 'm2');
			assert.equal(byId(merged, id).condition, 'Played');

			// What it saves, merged by a v55 phone, still has the move, and an
			// Undo there keeps the copy the old phone changed.
			const back = mergeDocuments(server, JSON.parse(JSON.stringify(merged)));

			assert.deepEqual(back.moves.map((move) => move.id), ['m2']);
			assert.equal(byId(back, id).condition, 'Played');
			assert.equal(planUndoMove(back, 'm2', {now: LATER}).counts.kept, 1);
		});
	}
});

// Start over (js/start-over.js) and the log, on one document: a001 was
// imported from row 001 and sits in binder b1's pocket 1, a002 was added in
// the app, and the file holds rows 001 and 002.
const row = (number) => ({
	cardId: `tst1-${number}`,
	catalog: 'international',
	row: {count: 1, finish: 'NORMAL', language: 'pt', monpriceId: `tst1_int_${number}`, name: `Test card ${number}`, setName: 'Test set'},
	status: 'matched',
	variantId: 'normal',
});
const ROWS = importEntries([row('001'), row('002')]);
const DAY = 24 * 60 * 60 * 1000;
const RUN_AT = Date.parse('2026-10-31T12:00:00.000Z');

function runDoc() {
	return {
		binders: [{cols: 3, created_at: at(1), deleted_at: null, id: 'b1', name: 'Binder', page_count: 1, rows: 3, slots: [{entry_id: 'a001', page: 1, placed_at: at(2), position: 1}], updated_at: at(2)}],
		card_info: [],
		cards: [card('a001', {import_key: 'monprice|tst1_int_001|pt|NORMAL|0', language_source: 'import'}), card('a002', {card_id: 'tst1-002'})],
		collections: [], goals: [], openings: [], wishlist: [],
	};
}

const startOver = async (doc = runDoc(), now = RUN_AT, run = 'run1', fill = true) => planStartOver(doc, ROWS, {fill, ids: await startOverIds(doc.cards, ROWS), now, run});
const liveIds = (doc) => doc.cards.filter((entry) => entry && !entry.deleted_at).map((entry) => entry.id).sort();
const pastIds = (doc, options) => pastCandidates(doc, options).map((entry) => entry.id).sort();

// A copy removed by hand, the way Delete removes it (js/collection.js
// deleteCards).
function removeByHand(doc, id, when) {
	const next = structuredClone(doc);
	const i = next.cards.findIndex((entry) => entry.id === id);
	const at = new Date(when).toISOString();

	next.cards[i] = stampEntry(next.cards[i], {...next.cards[i], deleted_at: at, updated_at: at});

	return next;
}

// What a phone before this fix wrote: no removed_by mark on the copies.
function unmarked(doc) {
	const next = structuredClone(doc);

	for (const entry of next.cards) {
		delete entry.removed_by;

		if (entry.field_stamps) {
			delete entry.field_stamps.removed_by;
		}
	}

	return next;
}

describe('Log a past sale leaves out what Start over and its Undo removed', () => {
	test('two Start overs days apart: neither run\'s removals are offered, and a copy removed by hand is', async () => {
		const first = await startOver();
		const second = await startOver(first.doc, RUN_AT + 5 * DAY, 'run2');
		const later = removeByHand(second.doc, second.undo.added[0], RUN_AT + 6 * DAY);

		assert.deepEqual(pastIds(second.doc, {now: RUN_AT + 6 * DAY}), []);
		assert.deepEqual(pastIds(later, {now: RUN_AT + 7 * DAY}), [second.undo.added[0]]);
		assert.ok(first.doc.cards.filter((entry) => entry.deleted_at).every((entry) => entry.removed_by && entry.removed_by.run === 'run1' && entry.removed_by.at === entry.deleted_at), 'each removal names its run');
	});

	test('Start over then its Undo: the copies the Undo removed are not offered', async () => {
		const {doc, undo} = await startOver();
		const undone = planUndo(doc, undo, {now: RUN_AT + 2 * DAY});

		assert.equal(undone.stale, false);
		assert.deepEqual(liveIds(undone.doc), ['a001', 'a002']);
		assert.deepEqual(pastIds(undone.doc, {now: RUN_AT + 3 * DAY}), []);
		assert.ok(undone.doc.cards.filter((entry) => !entry.deleted_at).every((entry) => !entry.removed_by), 'a copy that comes back loses the mark');
	});

	test('a copy last edited on a phone whose clock ran ahead is not offered, and a copy removed by hand 30 seconds after a run is', async () => {
		const ahead = runDoc();

		ahead.cards[1] = {...ahead.cards[1], updated_at: new Date(RUN_AT + 3 * 60000).toISOString()};

		const {doc} = await startOver(ahead);

		assert.deepEqual(pastIds(doc, {now: RUN_AT + DAY}), []);

		const sold = removeByHand(doc, doc.cards.find((entry) => !entry.deleted_at).id, RUN_AT + 30000);

		assert.equal(pastCandidates(sold, {now: RUN_AT + DAY}).length, 1);
	});

	test('a copy an older phone\'s Undo brought back, then removed by hand, is offered', async () => {
		const {doc} = await startOver();
		const back = structuredClone(doc);
		const i = back.cards.findIndex((entry) => entry.id === 'a002');

		// v51 to v54 restore with restoreEntry, which keeps every other field.
		back.cards[i] = v47.restoreEntry(back.cards[i], RUN_AT + DAY);
		assert.equal(back.cards[i].removed_by.run, 'run1', 'the old phone kept the mark');

		const removed = removeByHand(back, 'a002', RUN_AT + 2 * DAY);

		assert.deepEqual(pastIds(removed, {now: RUN_AT + 3 * DAY}), ['a002']);
	});

	for (const [name, old] of [['v47', v47], ['v21', v21]]) {
		test(`a ${name} phone keeps removed_by through its merges and edits`, async () => {
			const {doc} = await startOver();
			let merged = old.mergeDocuments(runDoc(), JSON.parse(JSON.stringify(doc)));

			assert.deepEqual(byId(merged, 'a002').removed_by, byId(doc, 'a002').removed_by);
			Object.assign(byId(merged, 'a002'), {condition: 'Played', updated_at: new Date(RUN_AT + 60000).toISOString()});
			merged = old.mergeDocuments(merged, doc);
			assert.deepEqual(byId(merged, 'a002').removed_by, byId(doc, 'a002').removed_by);
			assert.deepEqual(pastIds(mergeDocuments(doc, JSON.parse(JSON.stringify(merged))), {now: RUN_AT + DAY}), []);
		});
	}

	test('before this fix: unmarked removals are left out by the kept undo\'s lists, then by the placeholder their pocket became, and only then by the 60-second rule', async () => {
		// The automatic fill off, so pocket 1 keeps the placeholder.
		const {doc, undo} = await startOver(runDoc(), RUN_AT, 'run1', false);
		const old = unmarked(doc);
		const now = RUN_AT + DAY;

		assert.deepEqual(pastIds(old, {now}), [], 'the 60-second rule, as a last resort');

		// A later mark of another kind (an Undo's, or a run on a phone this
		// one has not heard from) leaves the 60-second rule nothing to go on.
		old.start_over = {at: new Date(RUN_AT + 12 * 3600000).toISOString(), id: 'other'};
		assert.deepEqual(pastIds(old, {kept: undo, now}), [], 'the kept undo names both removals');
		assert.deepEqual(pastIds(old, {now}), ['a002'], 'without it, the placeholder in pocket 1 still names a001');

		// Another phone undid the run before this fix: its removals of the
		// added copies are left out while the kept undo names them; an added
		// copy removed by hand while the run stands is offered.
		const undone = unmarked(planUndo(doc, undo, {now: RUN_AT + 3600000}).doc);

		undone.start_over = {at: new Date(RUN_AT + 12 * 3600000).toISOString(), id: 'other'};
		assert.deepEqual(pastIds(undone, {kept: undo, now}), []);

		const sold = removeByHand(old, undo.added[1], RUN_AT + 3600000);

		assert.deepEqual(pastIds(sold, {kept: undo, now}), [undo.added[1]]);
	});
});

describe('Start over and moves', () => {
	test('Start over\'s Undo is refused, naming the move, while a later move sold a copy it added; undoing the move first, then the run, leaves one copy', async () => {
		const run = await startOver();
		const added = run.undo.added.find((id) => byId(run.doc, id).card_id === 'tst1-001');
		const sold = planMove(run.doc, {currency: 'BRL', date: '2026-11-01', kind: 'sold', out: [added], price: '50', who: 'Ana'}, {fill: true, id: 'm1', now: RUN_AT + DAY});
		const refused = planUndo(sold.doc, run.undo, {now: RUN_AT + 2 * DAY});

		assert.equal(refused.stale, false);
		assert.deepEqual(refused.blocked.map((move) => move.id), ['m1']);
		assert.equal(stableJson(refused.doc), stableJson(sold.doc), 'nothing changed');
		assert.match(startOverBlockedText(refused.blocked[0], {now: new Date(RUN_AT + 2 * DAY)}), /^"Sold for R\$ 50,00 to Ana" on 1 Nov in Trades and sales counts a copy that Undo Start over would change\. Undo it first, then Undo Start over\. Nothing was changed\.$/);

		const moveBack = planUndoMove(sold.doc, 'm1', {now: RUN_AT + 3 * DAY});

		assert.equal(moveBack.stale, false);

		const runBack = planUndo(moveBack.doc, run.undo, {now: RUN_AT + 4 * DAY});

		assert.ok(!runBack.blocked && !runBack.stale);
		assert.deepEqual(liveIds(runBack.doc), ['a001', 'a002'], 'one copy of each card');
		assert.equal(slotAt(runBack.doc, 1).entry_id, 'a001');
	});

	test('a later move whose past list names a copy the run removed also refuses it', async () => {
		const run = await startOver();
		const doc = structuredClone(run.doc);

		doc.moves = [{created_at: new Date(RUN_AT + DAY).toISOString(), date: '2026-11-01', deleted_at: null, id: 'm7', in: [], kind: 'sold', out: ['a002'], past: ['a002'], updated_at: new Date(RUN_AT + DAY).toISOString()}];
		assert.deepEqual(planUndo(doc, run.undo, {now: RUN_AT + 2 * DAY}).blocked.map((move) => move.id), ['m7']);
		doc.moves[0].deleted_at = new Date(RUN_AT + DAY + 1000).toISOString();
		assert.equal(planUndo(doc, run.undo, {now: RUN_AT + 2 * DAY}).blocked, undefined, 'an undone move refuses nothing');
	});

	test('a move that names none of the run\'s copies lets Start over\'s Undo run, and is refused its own Undo after it', async () => {
		const run = await startOver();
		const bought = planMove(run.doc, {in: [IN_CARD], kind: 'bought', price: 20}, {id: 'm8', now: RUN_AT + DAY});
		const runBack = planUndo(bought.doc, run.undo, {now: RUN_AT + 2 * DAY});

		assert.ok(!runBack.blocked && !runBack.stale);
		assert.equal(runBack.doc.start_over.undoes, 'run1', 'the document records the Undo');

		const refused = planUndoMove(runBack.doc, 'm8', {now: RUN_AT + 3 * DAY});

		assert.deepEqual([refused.stale, refused.reason], [true, 'undo']);
		assert.equal(stableJson(refused.doc), stableJson(runBack.doc));
		assert.equal(planUndo(runBack.doc, run.undo, {now: RUN_AT + 3 * DAY}).stale, true, 'the same run cannot be undone twice');
	});

	test('a move records the run it was logged after, and only another run makes it stale, whatever the clocks say', async () => {
		const run = await startOver();
		// The run's stamp is ahead of the wall clock the move is logged at.
		const doc = structuredClone(run.doc);

		doc.start_over = {...doc.start_over, at: new Date(RUN_AT + 2 * DAY).toISOString()};

		const sold = planMove(doc, {kind: 'sold', out: [run.undo.added[1]], price: 5}, {id: 'm9', now: RUN_AT + DAY});

		assert.equal(sold.move.after_run, 'run1');
		assert.equal(planUndoMove(sold.doc, 'm9', {now: RUN_AT + DAY + 1000}).stale, false, 'logged after this run');

		// A phone whose clock is behind starts over later: its stamp is older
		// than the move's created_at.
		const behind = structuredClone(sold.doc);

		behind.start_over = {at: new Date(RUN_AT).toISOString(), id: 'run2'};

		const refused = planUndoMove(behind, 'm9', {now: RUN_AT + DAY + 2000});

		assert.deepEqual([refused.stale, refused.reason], [true, 'run']);
		assert.equal(planMove(startDoc(), {kind: 'sold', out: ['a1']}, {id: 'm0', now: NOW}).move.after_run, null, 'no run yet');
	});

	test('a copy that came in and was later sold: undoing the sale, then the trade, leaves the copy that went out', () => {
		const {doc, move} = trade();
		const sold = planMove(doc, {kind: 'sold', out: [move.in[0]], price: 10}, {id: 'm3', now: NOW + 1000});
		const one = planUndoMove(sold.doc, 'm3', {now: LATER});

		assert.equal(one.stale, false);
		assert.ok(!byId(one.doc, move.in[0]).deleted_at, 'the sold copy is back');

		const two = planUndoMove(one.doc, 'm2', {now: LATER + 1000});

		assert.equal(two.stale, false);
		assert.deepEqual(two.counts, {added: 1, held: 0, kept: 0, restored: 1, unlinked: 0});
		assert.deepEqual(liveIds(two.doc), ['a1', 'a2', 'a3']);
	});

	test('the other way round, the trade\'s Undo is refused, naming the sale, until the sale is undone', () => {
		const {doc, move} = trade();
		const sold = planMove(doc, {kind: 'sold', out: [move.in[0]], price: 10, who: 'Ana'}, {id: 'm3', now: NOW + 1000});
		const refused = planUndoMove(sold.doc, 'm2', {now: LATER});

		assert.deepEqual([refused.stale, refused.reason, refused.later && refused.later.id], [true, 'later', 'm3']);
		assert.equal(stableJson(refused.doc), stableJson(sold.doc));

		const one = planUndoMove(sold.doc, 'm3', {now: LATER});
		const two = planUndoMove(one.doc, 'm2', {now: LATER + 1000});

		assert.equal(two.stale, false);
		assert.deepEqual(liveIds(two.doc), ['a1', 'a2', 'a3'], 'no copy of the traded-in card is left');
	});
});

describe('Edit a logged move', () => {
	// What an edit must leave alone: everything Undo reads, and the copies.
	const kept = (move) => ({after_run: move.after_run, created_at: move.created_at, deleted_at: move.deleted_at, id: move.id, in: move.in, kind: move.kind, out: move.out, past: move.past, undo: move.undo});

	test('changes the date, who, price with its currency, and note, and nothing else: the cards and what Undo needs stay as they were', () => {
		const {doc} = sale();
		const before = structuredClone(doc);
		const {changed, doc: edited, move, stale} = planEditMove(doc, 'm1', {currency: 'USD', date: '2026-10-28', note: '  paid  in cash ', price: '1.500,00', who: 'Ana Lima'}, {now: LATER});

		assert.equal(stale, false);
		assert.deepEqual(changed.sort(), ['currency', 'date', 'note', 'price', 'who']);
		assert.deepEqual({currency: move.currency, date: move.date, money: move.money, note: move.note, price: move.price, who: move.who}, {currency: 'USD', date: '2026-10-28', money: 'in', note: 'paid in cash', price: 1500, who: 'Ana Lima'});
		assert.deepEqual(kept(move), kept(before.moves[0]));
		assert.equal(stableJson(edited.cards), stableJson(before.cards), 'no copy is touched');
		assert.equal(stableJson(edited.binders), stableJson(before.binders));
		assert.equal(stableJson(doc), stableJson(before), 'the document passed in is not changed');
		assert.equal(move.updated_at, new Date(LATER).toISOString());
		assert.equal(move.field_stamps.at, move.updated_at, 'stamped, so the merge takes the edit');
		assert.deepEqual(Object.keys(move.field_stamps).filter((key) => key !== 'at' && key !== 'since').sort(), ['currency', 'date', 'money', 'note', 'price', 'who'], 'only the changed fields are stamped, the price, currency, and money together');

		// History's month and money, and the card page's line, follow.
		assert.deepEqual(monthTotals(edited.moves).map((month) => [month.month, month.in]), [['2026-10', {USD: 1500}]]);
		assert.equal(historyLine(cardHistory(edited, {card_id: 'tst1-001'})[0], {now: new Date('2026-11-05T12:00:00')}), 'Left: sold for US$\u00a01.500,00 to Ana Lima, 28 Oct');
		assert.equal(moveTitle(move), 'Sold for US$\u00a01.500,00 to Ana Lima');
	});

	test('reads the price as the log form does, keeps the money\'s way by kind, and a gift keeps no price', () => {
		const {doc} = trade();

		assert.throws(() => planEditMove(doc, 'm2', {price: '1,2,3'}, {now: LATER}), /Type the price as 30,50 or 1\.500,00/);

		const paid = planEditMove(doc, 'm2', {money: 'in', price: '7'}, {now: LATER}).move;

		assert.deepEqual([paid.price, paid.currency, paid.money], [7, 'BRL', 'in'], 'a trade says which way the cash went');

		const none = planEditMove(doc, 'm2', {price: ''}, {now: LATER}).move;

		assert.deepEqual([none.price, none.currency, none.money], [null, null, null], 'an empty price takes it away');

		const sold = planEditMove(sale().doc, 'm1', {money: 'out', price: '12'}, {now: LATER}).move;

		assert.equal(sold.money, 'in', 'a sale\'s money always comes in');

		const gift = planMove(startDoc(), {kind: 'gift', out: ['a2'], who: 'Ana'}, {id: 'g1', now: NOW}).doc;
		const given = planEditMove(gift, 'g1', {currency: 'USD', price: '30', who: 'Bia'}, {now: LATER});

		assert.deepEqual(given.changed, ['who']);
		assert.deepEqual([given.move.price, given.move.currency, given.move.money], [null, null, null]);

		const same = planEditMove(doc, 'm2', {date: '2026-11-04', who: 'Bruno'}, {now: LATER});

		assert.deepEqual(same.changed, [], 'nothing changed');
		assert.equal(stableJson(same.doc), stableJson(doc));
	});

	test('two phones editing different fields both keep their change, either way round', () => {
		const {doc} = sale();
		const one = planEditMove(doc, 'm1', {currency: 'BRL', date: '2026-11-03', note: '', price: '30,50', who: 'Ana Lima'}, {now: LATER}).doc;
		const two = planEditMove(doc, 'm1', {currency: 'BRL', date: '2026-11-03', note: '', price: '45', who: 'Ana'}, {now: LATER + 60000}).doc;
		const a = mergeDocuments(one, two);
		const b = mergeDocuments(two, one);

		for (const merged of [a, b]) {
			assert.equal(merged.moves[0].who, 'Ana Lima', 'the first phone\'s who');
			assert.equal(merged.moves[0].price, 45, 'the second phone\'s price');
			assert.deepEqual(kept(merged.moves[0]), kept(doc.moves[0]));
		}

		assert.equal(stableJson(a.moves), stableJson(b.moves));
	});

	test('a form saves only what was changed in it: a field another phone changed while it was open keeps that change', () => {
		const {doc} = sale(startDoc(), {currency: 'USD', price: '30'});
		// What phone A's Edit form was filled from.
		const opened = structuredClone(doc.moves[0]);
		// Phone B changes who, and it reaches phone A while the form is open.
		const b = planEditMove(doc, 'm1', {who: 'Bia'}, {now: LATER}).doc;
		const aSees = mergeDocuments(doc, b);
		// Phone A's form sends every field, as filled; only the note was changed.
		const form = {currency: opened.currency, date: opened.date, note: 'cash', price: priceForInput(opened.price), who: opened.who};
		const a = planEditMove(aSees, 'm1', form, {base: opened, now: LATER + 60000});

		assert.deepEqual(a.changed, ['note']);
		assert.equal(a.move.who, 'Bia', 'B\'s who stays on A');
		assert.deepEqual([a.move.price, a.move.currency, a.move.money], [30, 'USD', 'in']);
		assert.deepEqual(Object.keys(a.move.field_stamps).filter((key) => key !== 'at' && key !== 'since' && key !== 'who').sort(), ['note'], 'the untouched price is not stamped');

		for (const merged of [mergeDocuments(a.doc, b), mergeDocuments(b, a.doc)]) {
			assert.deepEqual([merged.moves[0].who, merged.moves[0].note], ['Bia', 'cash']);
		}

		// The price typed on A goes with the currency A's form showed, not
		// one another phone set meanwhile: the three are one change.
		const euro = planEditMove(doc, 'm1', {currency: 'EUR'}, {now: LATER}).doc;
		const typed = planEditMove(mergeDocuments(doc, euro), 'm1', {...form, note: opened.note, price: '35'}, {base: opened, now: LATER + 60000});

		assert.deepEqual(typed.changed.sort(), ['currency', 'price']);
		assert.deepEqual([typed.move.price, typed.move.currency, typed.move.money], [35, 'USD', 'in']);

		// A form that changed nothing saves nothing, whatever changed meanwhile.
		assert.deepEqual(planEditMove(aSees, 'm1', {...form, note: opened.note}, {base: opened, now: LATER + 60000}).changed, []);
	});

	test('the price, its currency, and which way the money went merge as one: never a price from one phone with another\'s currency', () => {
		const {doc} = sale(startDoc(), {currency: 'USD', price: '30'});
		// Phone A takes the price away; phone B, a minute later, makes it 40.
		const cleared = planEditMove(doc, 'm1', {price: ''}, {now: LATER}).doc;
		const forty = planEditMove(doc, 'm1', {price: '40'}, {now: LATER + 60000}).doc;

		for (const merged of [mergeDocuments(cleared, forty), mergeDocuments(forty, cleared)]) {
			const move = merged.moves[0];

			assert.deepEqual([move.price, move.currency, move.money], [40, 'USD', 'in'], 'B\'s price, whole');
			assert.deepEqual(moneyOf(move), {amount: 40, currency: 'USD', way: 'in'});
			assert.deepEqual(monthTotals(merged.moves)[0].in, {USD: 40});
		}

		// The other way round in time: the later clear wins, whole.
		const fortyFirst = planEditMove(doc, 'm1', {price: '40'}, {now: LATER}).doc;
		const clearedLater = planEditMove(doc, 'm1', {price: ''}, {now: LATER + 60000}).doc;

		for (const merged of [mergeDocuments(fortyFirst, clearedLater), mergeDocuments(clearedLater, fortyFirst)]) {
			assert.deepEqual([merged.moves[0].price, merged.moves[0].currency, merged.moves[0].money], [null, null, null]);
			assert.equal(moneyOf(merged.moves[0]), null);
		}

		// A trade: phone A clears the cash, phone B changes the amount; then
		// phone A turns the cash round while phone B changed the amount earlier.
		const {doc: traded} = trade();
		const noCash = planEditMove(traded, 'm2', {price: ''}, {now: LATER}).doc;
		const eight = planEditMove(traded, 'm2', {price: '8'}, {now: LATER + 60000}).doc;

		for (const merged of [mergeDocuments(noCash, eight), mergeDocuments(eight, noCash)]) {
			assert.deepEqual([merged.moves[0].price, merged.moves[0].currency, merged.moves[0].money], [8, 'BRL', 'out'], 'the cash keeps its way');
			assert.deepEqual(moneyOf(merged.moves[0]), {amount: 8, currency: 'BRL', way: 'out'});
		}

		const opened = structuredClone(traded.moves[0]);
		const eightFirst = planEditMove(traded, 'm2', {price: '8'}, {now: LATER}).doc;
		const turned = planEditMove(traded, 'm2', {currency: 'BRL', money: 'in', price: priceForInput(opened.price)}, {base: opened, now: LATER + 60000}).doc;

		for (const merged of [mergeDocuments(eightFirst, turned), mergeDocuments(turned, eightFirst)]) {
			assert.deepEqual([merged.moves[0].price, merged.moves[0].currency, merged.moves[0].money], [5, 'BRL', 'in'], 'the later change, whole');
		}
	});

	test('the price shows in the form the Brazilian way without the phone\'s pt-BR number data, and reads back the same', () => {
		const values = [0.01, 0.5, 30.5, 999.99, 1000, 1500, 1234567.89];
		const expected = ['0,01', '0,50', '30,50', '999,99', '1.000,00', '1.500,00', '1.234.567,89'];
		const own = Number.prototype.toLocaleString;
		const OwnFormat = Intl.NumberFormat;

		// A phone without pt-BR data formats as en-US.
		Number.prototype.toLocaleString = function (_locale, options) {
			return own.call(this, 'en-US', options);
		};
		Intl.NumberFormat = function (_locale, options) {
			return new OwnFormat('en-US', options);
		};

		try {
			assert.deepEqual(values.map(priceForInput), expected);
			assert.deepEqual(expected.map((typed) => parsePrice(typed).value), values);
		}
		finally {
			Number.prototype.toLocaleString = own;
			Intl.NumberFormat = OwnFormat;
		}

		assert.deepEqual([null, 0, -3, NaN, '30'].map(priceForInput), ['', '', '', '', '']);
	});

	test('Undo after an edit works as before: the copy comes back, the incoming copy goes, and the move is a tombstone', () => {
		const {doc} = trade();
		const plain = planUndoMove(doc, 'm2', {now: LATER + 1000});
		const edited = planEditMove(doc, 'm2', {money: 'in', note: 'Fair', price: '10', who: 'Bruno S.'}, {now: LATER}).doc;
		const undone = planUndoMove(edited, 'm2', {now: LATER + 1000});

		assert.equal(undone.stale, false);
		assert.deepEqual(undone.counts, plain.counts);
		assert.equal(stableJson(undone.doc.cards), stableJson(plain.doc.cards));
		assert.equal(stableJson(undone.doc.binders), stableJson(plain.doc.binders));
		assert.ok(undone.doc.moves[0].deleted_at);
		assert.deepEqual(monthTotals(undone.doc.moves), []);
	});

	test('an undone move cannot be edited, and an edit on another phone does not bring it back', async () => {
		const {doc} = sale();
		const undone = planUndoMove(doc, 'm1', {now: LATER}).doc;
		const refused = planEditMove(undone, 'm1', {who: 'Bia'}, {now: LATER + 1000});

		assert.equal(refused.stale, true);
		assert.equal(stableJson(refused.doc), stableJson(undone));
		assert.equal(planEditMove(doc, 'nope', {who: 'Bia'}).stale, true);

		// The other phone edited before it heard of the Undo.
		const edited = planEditMove(doc, 'm1', {who: 'Bia'}, {now: LATER + 5000}).doc;

		for (const merged of [mergeDocuments(edited, undone), mergeDocuments(undone, edited)]) {
			assert.ok(merged.moves[0].deleted_at, 'the delete sticks');
			assert.ok(!byId(merged, 'a1').deleted_at, 'and the copy stays back');
		}
	});
});

// A purchase priced card by card (Eric, 2026-11-19): Pikachu at R$ 12,00,
// two Eevees at R$ 5,50 each (Copies 2 stands for two copies), and a
// Bulbasaur with no price of its own, from Liga.
const PIKACHU = {...IN_CARD, card_id: 'tst1-006', condition: undefined};
const EEVEE = {...IN_CARD, card_id: 'tst1-007', condition: undefined};
const BULBASAUR = {...IN_CARD, card_id: 'tst1-008', condition: undefined};
const purchase = (doc = startDoc(), extra = {}) => planMove(doc, {
	currency: 'BRL', date: '2026-11-12', in: [PIKACHU, EEVEE, EEVEE, BULBASAUR], in_prices: ['12', '5,50', '5,50', ''], kind: 'bought', price: '999', who: 'Liga', ...extra,
}, {id: 'p1', now: NOW});
const AFTER = new Date('2026-11-19T12:00:00');

// What a phone from before card prices does in Edit: the price, currency,
// and money, stamped as one, and every other field copied as it was.
function olderEdit(doc, id, price, when) {
	const next = structuredClone(doc);
	const i = next.moves.findIndex((move) => move.id === id);
	const at = new Date(when).toISOString();
	const edited = stampEntry(next.moves[i], {...next.moves[i], price, updated_at: at});

	for (const key of ['price', 'currency', 'money']) {
		edited.field_stamps[key] = at;
	}

	next.moves[i] = edited;

	return next;
}

describe('a purchase priced card by card', () => {
	test('each copy\'s price is kept by its entry id, Copies 2 gives both copies the price, a blank one has none, and the price saved is their sum', () => {
		const {doc, move} = purchase();
		const [pikachu, eevee1, eevee2, bulbasaur] = move.in;

		assert.deepEqual(move.in_prices, {[eevee1]: 5.5, [eevee2]: 5.5, [pikachu]: 12});
		assert.equal(move.in_prices[bulbasaur], undefined, 'a card with no price of its own has no key');
		assert.deepEqual([move.price, move.currency, move.money], [23, 'BRL', 'out'], 'the typed total is not read: the card prices make it');
		assert.deepEqual(move.in.map((id) => byId(doc, id).card_id), ['tst1-006', 'tst1-007', 'tst1-007', 'tst1-008']);
		assert.deepEqual(ownPrices(move), move.in_prices);
		assert.deepEqual(monthTotals(doc.moves)[0].out, {BRL: 23});
		assert.equal(moveTitle(move), 'Bought for R$ 23,00 from Liga');

		// Cents add up exactly.
		assert.equal(purchase(startDoc(), {in: [PIKACHU, EEVEE], in_prices: ['0,10', '0.2']}).move.price, 0.3);
		assert.equal(sumPrices(['0,10', '0.2', '', null]), 0.3);

		// Every card blank: no price at all, as with an empty Paid.
		const blank = purchase(startDoc(), {in_prices: ['', '', '', '']}).move;

		assert.deepEqual([blank.price, blank.currency, blank.money, 'in_prices' in blank], [null, null, null, false]);

		// One total, the way it always was: no in_prices key at all.
		const total = planMove(startDoc(), {in: [PIKACHU], kind: 'bought', price: '20', who: 'Liga'}, {id: 'p2', now: NOW}).move;

		assert.deepEqual([total.price, 'in_prices' in total, ownPrices(total)], [20, false, null]);

		// Only a purchase prices its cards.
		const traded = planMove(startDoc(), {in: [PIKACHU], in_prices: ['12'], kind: 'traded', money: 'out', out: ['a1'], price: '3'}, {id: 't1', now: NOW}).move;

		assert.deepEqual([traded.price, 'in_prices' in traded], [3, false]);
	});

	test('the card page says what each copy cost, "each" for several, and nothing for a copy with no price of its own; History lists the cards with their prices', () => {
		const {doc, move} = purchase();
		const line = (cardId) => cardHistory(doc, {card_id: cardId}).map((row) => historyLine(row, {now: AFTER}));

		assert.deepEqual(line('tst1-006'), ['Came in: bought from Liga for R$ 12,00, 12 Nov']);
		assert.deepEqual(line('tst1-007'), ['Came in: bought from Liga for R$ 5,50 each, 12 Nov']);
		assert.deepEqual(line('tst1-008'), ['Came in: bought from Liga, 12 Nov']);
		assert.deepEqual(cardHistory(doc, {card_id: 'tst1-007'})[0].entries.length, 2);

		// The same card at two prices: one line each.
		const two = purchase(startDoc(), {in: [EEVEE, EEVEE], in_prices: ['5', '7']});

		assert.deepEqual(cardHistory(two.doc, {card_id: 'tst1-007'}).map((row) => historyLine(row, {now: AFTER})), ['Came in: bought from Liga for R$ 5,00, 12 Nov', 'Came in: bought from Liga for R$ 7,00, 12 Nov']);

		const rows = pricedCards(move, doc.cards);

		assert.deepEqual(rows.map((row) => [row.entries.map((entry) => entry.card_id), row.price]), [[['tst1-006'], 12], [['tst1-007', 'tst1-007'], 5.5], [['tst1-008'], null]]);
		assert.equal(pricedCards(trade().move, trade().doc.cards), null, 'a move with no card prices lists none');

		// A purchase with one total reads as before.
		const total = planMove(startDoc(), {date: '2026-11-12', in: [PIKACHU], kind: 'bought', price: '20', who: 'Liga'}, {id: 'p2', now: NOW});

		assert.deepEqual(cardHistory(total.doc, {card_id: 'tst1-006'}).map((row) => historyLine(row, {now: AFTER})), ['Came in: bought for R$ 20,00 from Liga, 12 Nov']);
	});

	test('a purchase\'s or sale\'s one total, on a card page row that is only part of it, says so; a move of one card reads as before (QA, 2026-11-20)', () => {
		const line = (doc, cardId) => cardHistory(doc, {card_id: cardId}).map((row) => historyLine(row, {now: AFTER}));

		// Bought three cards for R$ 57,50 with no card prices: each card's
		// page names the total as the three cards', not as its own price.
		const three = planMove(startDoc(), {date: '2026-11-12', in: [PIKACHU, EEVEE, BULBASAUR], kind: 'bought', price: '57,50', who: 'Liga Pokémon'}, {id: 'p3', now: NOW});

		assert.deepEqual(line(three.doc, 'tst1-006'), ['Came in: 1 of 3 cards bought for R$\u00a057,50 from Liga Pokémon, 12 Nov']);
		assert.deepEqual(line(three.doc, 'tst1-008'), ['Came in: 1 of 3 cards bought for R$\u00a057,50 from Liga Pokémon, 12 Nov']);

		// Two copies of one card among three, and a purchase of nothing but
		// copies of the one card.
		const two = planMove(startDoc(), {date: '2026-11-12', in: [EEVEE, EEVEE, PIKACHU], kind: 'bought', price: '100', who: 'Liga'}, {id: 'p4', now: NOW});

		assert.deepEqual(line(two.doc, 'tst1-007'), ['Came in: 2 of 3 cards bought for R$\u00a0100,00 from Liga, 12 Nov']);

		const same = planMove(startDoc(), {date: '2026-11-12', in: [EEVEE, EEVEE, EEVEE], kind: 'bought', price: '30'}, {id: 'p5', now: NOW});

		assert.deepEqual(line(same.doc, 'tst1-007'), ['Came in: all 3 bought for R$\u00a030,00, 12 Nov']);

		// A sale of two copies for one price.
		const sold = planMove(startDoc(), {currency: 'BRL', date: '2026-11-12', kind: 'sold', out: ['a1', 'a3'], price: '120', who: 'Ana'}, {id: 's2', now: NOW});

		assert.deepEqual(line(sold.doc, 'tst1-001'), ['Left: 1 of 2 cards sold for R$\u00a0120,00 to Ana, 12 Nov']);

		// One card, no price, and a trade's cash read as before.
		const one = planMove(startDoc(), {date: '2026-11-12', in: [PIKACHU], kind: 'bought', price: '100', who: 'Liga'}, {id: 'p6', now: NOW});
		const free = planMove(startDoc(), {date: '2026-11-12', in: [PIKACHU, EEVEE], kind: 'bought', who: 'Liga'}, {id: 'p7', now: NOW});

		assert.deepEqual(line(one.doc, 'tst1-006'), ['Came in: bought for R$\u00a0100,00 from Liga, 12 Nov']);
		assert.deepEqual(line(free.doc, 'tst1-006'), ['Came in: bought from Liga, 12 Nov']);
		assert.deepEqual(line(sale().doc, 'tst1-001'), ['Left: sold for R$\u00a030,50 to Ana, 3 Nov']);
		assert.match(line(trade().doc, 'tst1-003')[0], /^Came in: traded with Bruno, R\$\u00a05,00 paid, /);
	});

	test('From suggests where earlier purchases came from: newest first, each place once, live purchases only', () => {
		let doc = startDoc();
		const add = (fields, id, now) => {
			doc = planMove(doc, {in: [PIKACHU], kind: 'bought', ...fields}, {id, now}).doc;
		};

		add({date: '2026-11-01', who: 'Liga'}, 'b1', NOW);
		add({date: '2026-11-03', who: '  Feira   de domingo '}, 'b2', NOW + 1);
		add({date: '2026-11-02', who: 'liga'}, 'b3', NOW + 2);
		add({date: '2026-11-04', who: ''}, 'b4', NOW + 3);
		add({date: '2026-11-05', who: 'Old shop'}, 'b5', NOW + 4);
		doc = planMove(doc, {date: '2026-11-06', kind: 'sold', out: ['a1'], who: 'Ana'}, {id: 's1', now: NOW + 5}).doc;
		doc = planUndoMove(doc, 'b5', {now: NOW + 6}).doc;

		assert.deepEqual(purchaseSources(doc), ['Feira de domingo', 'liga'], 'the newest spelling of Liga, no sale, and not the undone purchase');
		assert.deepEqual(purchaseSources({}), []);
	});

	test('Edit changes the card prices and the total follows; a price typed without them is one total; all of it is one unit with one stamp', () => {
		const {doc, move} = purchase();
		const [pikachu, eevee1, eevee2, bulbasaur] = move.in;
		const priced = planEditMove(doc, 'p1', {in_prices: {[bulbasaur]: '3', [eevee1]: '5,50', [eevee2]: '6', [pikachu]: '12'}, price: '23,00'}, {now: LATER});

		assert.deepEqual(priced.changed.sort(), ['in_prices', 'price']);
		assert.deepEqual(priced.move.in_prices, {[bulbasaur]: 3, [eevee1]: 5.5, [eevee2]: 6, [pikachu]: 12});
		assert.equal(priced.move.price, 26.5, 'the total is the new sum, not the total the form sent');
		assert.deepEqual(['price', 'currency', 'money', 'in_prices'].map((key) => priced.move.field_stamps[key]), Array(4).fill(new Date(LATER).toISOString()), 'the four take one stamp');
		assert.deepEqual([priced.move.in, priced.move.out, priced.move.undo], [move.in, move.out, move.undo], 'the cards and what Undo needs stay');
		assert.throws(() => planEditMove(doc, 'p1', {in_prices: {[pikachu]: '1,2,3'}}, {now: LATER}), /Type the price as 30,50/);

		// A card price for a copy the purchase did not bring is not kept.
		assert.deepEqual(planEditMove(doc, 'p1', {in_prices: {a1: '50', [pikachu]: '10'}}, {now: LATER}).move.in_prices, {[pikachu]: 10});

		// Price each card turned off: one total, and the card prices go.
		const total = planEditMove(doc, 'p1', {in_prices: null, price: '30'}, {now: LATER}).move;

		assert.deepEqual([total.price, 'in_prices' in total, total.field_stamps.in_prices], [30, false, new Date(LATER).toISOString()]);
		assert.deepEqual(planEditMove(doc, 'p1', {price: '30'}, {now: LATER}).move.in_prices, undefined, 'a price given alone is one total too');

		// The currency alone: the card prices stay, now in that currency.
		const euro = planEditMove(doc, 'p1', {currency: 'EUR'}, {now: LATER}).move;

		assert.deepEqual([euro.price, euro.currency, euro.in_prices], [23, 'EUR', move.in_prices]);
		assert.deepEqual(cardHistory({...doc, moves: [euro]}, {card_id: 'tst1-006'}).map((row) => historyLine(row, {now: AFTER})), ['Came in: bought from Liga for € 12,00, 12 Nov']);

		// Every card cleared: no price at all.
		const none = planEditMove(doc, 'p1', {in_prices: {}}, {now: LATER}).move;

		assert.deepEqual([none.price, none.currency, none.money, 'in_prices' in none], [null, null, null, false]);

		// A form that changed only the note leaves the unit unstamped.
		const opened = structuredClone(move);
		const form = {currency: 'BRL', date: move.date, in_prices: {[eevee1]: '5,50', [eevee2]: '5,50', [pikachu]: '12,00'}, note: 'Paid by card', price: '23,00', who: 'Liga'};
		const noted = planEditMove(doc, 'p1', form, {base: opened, now: LATER});

		assert.deepEqual(noted.changed, ['note']);
		assert.deepEqual(Object.keys(noted.move.field_stamps).filter((key) => key !== 'at' && key !== 'since'), ['note']);
	});

	test('two phones editing the money: the later phone\'s whole unit wins, never card prices under another phone\'s total', () => {
		const {doc, move} = purchase();
		const [pikachu] = move.in;
		const repriced = (when) => planEditMove(doc, 'p1', {in_prices: {...move.in_prices, [pikachu]: '20'}}, {now: when}).doc;
		const total = (when) => planEditMove(doc, 'p1', {in_prices: null, price: '40'}, {now: when}).doc;

		for (const [a, b, expected] of [[repriced(LATER), total(LATER + 60000), 'total'], [total(LATER), repriced(LATER + 60000), 'each']]) {
			for (const merged of [mergeDocuments(a, b), mergeDocuments(b, a)]) {
				const one = merged.moves[0];

				if (expected === 'total') {
					assert.deepEqual([one.price, 'in_prices' in one, ownPrices(one)], [40, false, null]);
				}
				else {
					assert.deepEqual([one.price, one.in_prices[pikachu], ownPrices(one)[pikachu]], [31, 20, 20]);
				}
			}
		}

		// A note on one phone and card prices on another both stay.
		const noted = planEditMove(doc, 'p1', {note: 'Fair'}, {now: LATER}).doc;
		const priced = repriced(LATER + 60000);

		for (const merged of [mergeDocuments(noted, priced), mergeDocuments(priced, noted)]) {
			assert.deepEqual([merged.moves[0].note, merged.moves[0].price, merged.moves[0].in_prices[pikachu]], ['Fair', 31, 20]);
		}
	});

	// The phones from before card prices: v84 and older run js/merge.js's
	// rules as they were (in_prices is a field like any other to them), and
	// tests/v47/merge.js and tests/merge-v21.mjs are frozen older rules.
	for (const [name, old] of [['v47', v47], ['v21', v21], ['current', {mergeDocuments}]]) {
		test(`a ${name} phone keeps the card prices when it merges, and its Edit of the total makes this app stop showing them`, () => {
			const server = purchase().doc;
			const merged = old.mergeDocuments(startDoc(), JSON.parse(JSON.stringify(server)));

			assert.deepEqual(merged.moves[0].in_prices, server.moves[0].in_prices, 'a field it does not know is kept');

			// Its Edit changes the total alone; the card prices stay on the
			// move, and no longer add up, so they are not shown or counted.
			const edited = olderEdit(merged, 'p1', 50, LATER);
			const back = mergeDocuments(server, JSON.parse(JSON.stringify(edited)));
			const move = back.moves[0];

			assert.deepEqual([move.price, move.in_prices], [50, server.moves[0].in_prices]);
			assert.equal(ownPrices(move), null);
			assert.equal(pricedCards(move, back.cards), null);
			assert.deepEqual(cardHistory(back, {card_id: 'tst1-006'}).map((row) => historyLine(row, {now: AFTER})), ['Came in: 1 of 4 cards bought for R$ 50,00 from Liga, 12 Nov'], 'the total, as before card prices, named as the four cards\' total');

			// An Edit here of the note only leaves them be; turning Price
			// each card on again saves them with a total that adds up.
			assert.deepEqual(planEditMove(back, 'p1', {note: 'x'}, {base: structuredClone(move), now: LATER + 1000}).changed, ['note']);
			assert.equal(planEditMove(back, 'p1', {in_prices: move.in_prices}, {base: structuredClone(move), now: LATER + 1000}).move.price, 23);
		});
	}

	test('Undo of a purchase priced card by card removes the copies as any other', () => {
		const {doc} = purchase();
		const undone = planUndoMove(doc, 'p1', {now: LATER});

		assert.equal(undone.stale, false);
		assert.equal(undone.counts.added, 4);
		assert.ok(undone.doc.moves[0].deleted_at);
		assert.deepEqual(purchaseSources(undone.doc), []);
	});
});

describe('saved', () => {
	test('applyMove and undoMove save once each, and a failed save leaves the document on screen unchanged', async () => {
		const doc = await collection.loadDocument();

		Object.assign(doc, startDoc());

		const {counts, move} = await applyMove({kind: 'sold', out: ['a2'], price: 8});
		const saved = await collection.loadDocument();

		assert.equal(counts.out, 1);
		assert.ok(byId(saved, 'a2').deleted_at);
		assert.equal(saved.moves.length, 1);

		const before = stableJson(saved);

		failWrites = true;
		await assert.rejects(undoMove(move.id));
		await assert.rejects(applyMove({kind: 'sold', out: ['a3']}));
		failWrites = false;
		assert.equal(stableJson(await collection.loadDocument()), before);

		// Edit saves once, and saves nothing when nothing changed.
		const {changed} = await editMove(move.id, {price: '9', who: 'Ana'});

		assert.deepEqual(changed.sort(), ['price', 'who']);
		assert.equal((await collection.loadDocument()).moves[0].price, 9);

		const edited = stableJson(await collection.loadDocument());

		assert.deepEqual((await editMove(move.id, {price: '9'})).changed, []);
		assert.equal(stableJson(await collection.loadDocument()), edited);

		const back = await undoMove(move.id);

		assert.deepEqual(back, {added: 0, held: 0, kept: 0, restored: 1, unlinked: 0});
		assert.ok(!byId(await collection.loadDocument(), 'a2').deleted_at);
		await assert.rejects(undoMove(move.id), (err) => err.stale === true);
		await assert.rejects(editMove(move.id, {who: 'Bia'}), (err) => err.stale === true && /cannot be edited/.test(err.message));
	});
});
