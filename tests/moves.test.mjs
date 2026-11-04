// Unit tests for the trades and sales log (js/moves.js; DESIGN.md section
// 11, "Trades and Sales", Eric 2026-10-31 and 2026-11-04): what a move
// removes and adds, binder pockets, Log a past sale, Undo and deleting a
// move (after another phone edited an incoming copy, and after a sync), the
// money per month, two phones logging moves, and older phones that do not
// know `moves`, `left_via`, or `came_via`. Plain Node over an in-memory
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
const {applyMove, cardHistory, cleanPrice, historyLine, moneyOf, monthTotals, moveTitle, pastCandidates, planMove, planUndoMove, undoMove} = await import('../js/moves.js');

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
			created_at: new Date(NOW).toISOString(), currency: 'BRL', date: '2026-11-03', deleted_at: null, id: 'm1', in: [], kind: 'sold', money: 'in', note: null,
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
		assert.deepEqual(counts, {added: 1, kept: 0, restored: 1, unlinked: 0});
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

		assert.deepEqual(counts, {added: 0, kept: 1, restored: 1, unlinked: 0});
		assert.ok(!byId(back, id).deleted_at);
		assert.equal(slotAt(back, 5).entry_id, id);
		assert.ok(back.wishlist[0].got_at, 'its wish stays Got it');
	});

	test('after a sync round trip, which drops empty fields, the unchanged incoming copy still counts as unchanged', () => {
		const {doc} = trade();
		const server = JSON.parse(JSON.stringify(mergeDocuments({}, doc)));
		const phone = mergeDocuments(startDoc(), server);
		const {counts, doc: back} = planUndoMove(phone, 'm2', {now: LATER});

		assert.deepEqual(counts, {added: 1, kept: 0, restored: 1, unlinked: 0});
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
		assert.equal(cleanPrice('1.234'), 1.23);
		assert.equal(cleanPrice('-3'), null);
		assert.equal(cleanPrice(''), null);
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

		const back = await undoMove(move.id);

		assert.deepEqual(back, {added: 0, kept: 0, restored: 1, unlinked: 0});
		assert.ok(!byId(await collection.loadDocument(), 'a2').deleted_at);
		await assert.rejects(undoMove(move.id), (err) => err.stale === true);
	});
});
