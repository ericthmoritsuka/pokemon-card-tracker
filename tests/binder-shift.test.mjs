// Unit tests for Remove from this binder and Move to... (Eric, 2026-11-06:
// "I should be able to remove cards in binders (even automatic ones) and
// the app should give me the choice to keep it as it is or shift the
// cards"): in a hand-made binder, the pockets shifting back across pages,
// a pocket left empty, a move to the end and to a pocket both ways, Undo,
// nothing lost at the last page, and a shift merged pocket by pocket with
// another phone's edit; in a binder from a list, the exceptions stored on
// the binder (list_edits), applied after the list's order with a new
// Pokémon joining, kept by an older phone's save (the frozen v47 merge and
// a v63-shaped save), and no save back and forth. Plain Node, invented data,
// and nothing is requested.
//
// Run: node --test tests/binder-shift.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {fakeIndexedDb} from './fake-indexeddb.mjs';

// js/collection.js reaches window when it loads.
globalThis.window = globalThis.window || globalThis;
globalThis.addEventListener = globalThis.addEventListener || (() => {});
globalThis.indexedDB = fakeIndexedDb();
globalThis.BroadcastChannel = undefined;
globalThis.fetch = async (url) => {
	throw new Error(`No requests in this test (${url}).`);
};

const binders = await import('../js/binders.js');
const rules = await import('../js/binder-rules.js');
const {mergeDocuments, stampEntry} = await import('../js/merge.js');
const v47 = await import('./v47/merge.js');

const at = (minute) => `2026-11-06T10:${String(minute).padStart(2, '0')}:00.000Z`;

// 2 x 2 pages, 3 pages: 12 pockets.
const hand = (id, slots = [], fields = {}) => ({art: [], cols: 2, cover_color: '#1b1b1f', created_at: at(0), deleted_at: null, id, name: `Binder ${id}`, notes: '', page_count: 3, rows: 2, slots, updated_at: at(0), ...fields});

const holding = (page, position, entryId) => ({entry_id: entryId, page, placed_at: at(1), position});

const wanting = (page, position, cardId) => ({page, placed_at: at(1), position, want: {card_id: cardId, catalog: 'international', image: null, name: null, variant_id: null}});

const emptyOn = (page, position) => ({empty: true, page, placed_at: at(1), position});

const artOn = (page, position) => ({art: {id: 'a1', tile: 0}, page, position});

// Each pocket in use as [pocket number across the binder, what it holds].
const pocketsOf = (binder) => binders.slotsOf(binder).map((slot) => [((slot.page - 1) * 4) + slot.position, slot.entry_id || (slot.want ? slot.want.card_id : slot.empty ? 'empty' : slot.art ? 'art' : '?')]);

const merged = (list, changed) => mergeDocuments({binders: list}, {binders: changed}).binders;

// Page 1: c1, c2, a placeholder, nothing. Page 2: empty on purpose, c3,
// art, c4. Page 3: c5, nothing, nothing, nothing.
const UNOVA = () => [hand('b', [
	holding(1, 1, 'c1'), holding(1, 2, 'c2'), wanting(1, 3, 'w1'),
	emptyOn(2, 1), holding(2, 2, 'c3'), artOn(2, 3), holding(2, 4, 'c4'),
	holding(3, 1, 'c5'),
]), hand('other', [holding(1, 1, 'c9')])];

const copiesIn = (list) => list.flatMap((binder) => binders.slotsOf(binder)).filter((slot) => slot.entry_id).map((slot) => slot.entry_id).sort();

describe('a hand-made binder: remove', () => {
	test('Shift the rest back: every later pocket moves back one, across pages, with placeholders, empty markers, and art', () => {
		const before = UNOVA();
		const result = binders.removePocket(before, {at: at(10), binderId: 'b', page: 1, position: 2, shift: true});
		const after = merged(before, result.changed);

		assert.deepEqual(result.changed.map((binder) => binder.id), ['b'], 'nothing outside this binder changes');
		assert.deepEqual(pocketsOf(after[0]), [[1, 'c1'], [2, 'w1'], [4, 'empty'], [5, 'c3'], [6, 'art'], [7, 'c4'], [8, 'c5']]);
		assert.deepEqual(binders.unplaced([{id: 'c2'}].map((entry) => ({...entry, deleted_at: null})), after).map((entry) => entry.id), ['c2'], 'the copy is out of every binder, in no tray');
		assert.deepEqual(after[0].staged, undefined);
		assert.deepEqual(after[1], before[1]);
	});

	test('Leave the pocket empty: only that pocket changes', () => {
		const before = UNOVA();
		const result = binders.removePocket(before, {at: at(10), binderId: 'b', page: 1, position: 2, shift: false});
		const after = merged(before, result.changed);

		assert.deepEqual(pocketsOf(after[0]), [[1, 'c1'], [3, 'w1'], [5, 'empty'], [6, 'c3'], [7, 'art'], [8, 'c4'], [9, 'c5']]);
		assert.deepEqual(result.done.pockets.map((pocket) => [pocket.page, pocket.position]), [[1, 2]]);
	});

	test('a pocket another phone changed since is left alone', () => {
		assert.throws(() => binders.removePocket(UNOVA(), {at: at(10), binderId: 'b', expect: binders.contentKey(holding(1, 2, 'c-other')), page: 1, position: 2, shift: true}), /changed on another phone/);
	});

	test('Undo puts every pocket back, only while each holds what the shift put there', () => {
		const before = UNOVA();
		const result = binders.removePocket(before, {at: at(10), binderId: 'b', page: 1, position: 2, shift: true});
		const after = merged(before, result.changed);
		const undo = binders.undoShift(after, {at: at(11), done: result.done});
		const back = merged(after, undo.changed);

		assert.equal(undo.back, true);
		assert.deepEqual(pocketsOf(back[0]), pocketsOf(before[0]));

		// Another phone put a card in a pocket the shift wrote: nothing moves.
		const edited = merged(after, binders.setPocket(after, {at: at(12), binderId: 'b', content: {entry_id: 'c7'}, page: 2, position: 1}));
		const refused = binders.undoShift(edited, {at: at(13), done: result.done});

		assert.equal(refused.back, false);
		assert.deepEqual(refused.changed, []);

		// The removed copy went into another binder since: nothing moves.
		const moved = merged(after, binders.setPocket(after, {at: at(12), binderId: 'other', content: {entry_id: 'c2'}, page: 1, position: 2}));

		assert.equal(binders.undoShift(moved, {at: at(13), done: result.done}).back, false);
	});
});

describe('a hand-made binder: Move to...', () => {
	// The Unova binder: Victini first, then the starters.
	const unova = () => [hand('u', [holding(1, 1, 'victini'), holding(1, 2, 'snivy'), holding(1, 3, 'tepig'), holding(1, 4, 'oshawott'), holding(2, 1, 'patrat')])];

	test('End of the binder: Victini goes last and Snivy is pocket 1', () => {
		const before = unova();
		const result = binders.shiftMove(before, {at: at(10), binderId: 'u', from: {page: 1, position: 1}, to: 'end'});
		const after = merged(before, result.changed);

		assert.deepEqual(pocketsOf(after[0]), [[1, 'snivy'], [2, 'tepig'], [3, 'oshawott'], [4, 'patrat'], [5, 'victini']]);
		assert.deepEqual(result.to, {page: 2, position: 1});
		assert.deepEqual(binders.shiftMove(after, {at: at(11), binderId: 'u', from: {page: 2, position: 1}, to: 'end'}).changed, [], 'the last card is at the end already');
	});

	test('to a later pocket the cards between move back; to an earlier one they move forward', () => {
		const before = unova();
		const later = merged(before, binders.shiftMove(before, {at: at(10), binderId: 'u', from: {page: 1, position: 1}, to: {page: 1, position: 3}}).changed);

		assert.deepEqual(pocketsOf(later[0]), [[1, 'snivy'], [2, 'tepig'], [3, 'victini'], [4, 'oshawott'], [5, 'patrat']]);

		const earlier = merged(before, binders.shiftMove(before, {at: at(10), binderId: 'u', from: {page: 2, position: 1}, to: {page: 1, position: 2}}).changed);

		assert.deepEqual(pocketsOf(earlier[0]), [[1, 'victini'], [2, 'patrat'], [3, 'snivy'], [4, 'tepig'], [5, 'oshawott']]);
	});

	test('Undo of a move', () => {
		const before = unova();
		const result = binders.shiftMove(before, {at: at(10), binderId: 'u', from: {page: 1, position: 1}, to: 'end'});
		const after = merged(before, result.changed);
		const back = merged(after, binders.undoShift(after, {at: at(11), done: result.done}).changed);

		assert.deepEqual(pocketsOf(back[0]), pocketsOf(before[0]));
	});
});

describe('a copy is never lost', () => {
	// Every pocket of the binder is full, the last page too.
	const full = () => [hand('f', Array.from({length: 12}, (_, i) => holding(Math.floor(i / 4) + 1, (i % 4) + 1, `c${i + 1}`)))];

	test('at the last page: remove and shift, a move to the end, and the last pocket moved to the first', () => {
		for (const change of [
			(list) => binders.shiftMove(list, {at: at(10), binderId: 'f', from: {page: 1, position: 1}, to: 'end'}),
			(list) => binders.shiftMove(list, {at: at(10), binderId: 'f', from: {page: 3, position: 4}, to: {page: 1, position: 1}}),
			(list) => binders.shiftMove(list, {at: at(10), binderId: 'f', from: {page: 2, position: 2}, to: {page: 3, position: 4}}),
			(list) => binders.removePocket(list, {at: at(10), binderId: 'f', page: 3, position: 4, shift: true}),
		]) {
			const before = full();
			const after = merged(before, change(before).changed);

			assert.equal(after[0].page_count, 3);
			assert.ok(copiesIn(after).length >= 11);
			assert.ok(binders.slotsOf(after[0]).every((slot) => slot.page <= 3));
		}

		const before = full();
		const moved = merged(before, binders.shiftMove(before, {at: at(10), binderId: 'f', from: {page: 3, position: 4}, to: {page: 1, position: 1}}).changed);

		assert.deepEqual(copiesIn(moved), copiesIn(before), 'every copy stays in the binder');
		assert.deepEqual(pocketsOf(moved[0]).slice(0, 2), [[1, 'c12'], [2, 'c1']]);
	});

	// Another phone moved a shifted copy to another binder, or took it out,
	// before or after the shift: the shift never brings it back.
	test('a shift never undoes another phone\'s move or removal of a card it shifts, in either merge order', () => {
		const before = [hand('b', [holding(1, 1, 'c1'), holding(1, 2, 'c2'), holding(1, 3, 'c3')]), hand('o', [])];
		const shift = binders.removePocket(before, {at: at(11), binderId: 'b', page: 1, position: 1, shift: true}).changed;
		const where = (list, id) => {
			const found = binders.placements(list).get(id);

			return found ? `${found.binder.id}:${found.slot.page}/${found.slot.position}` : 'loose';
		};

		for (const minute of [10, 12]) {
			const moved = binders.setPocket(before, {at: at(minute), binderId: 'o', content: {entry_id: 'c3'}, page: 1, position: 1});
			const removed = binders.removePocket(before, {at: at(minute), binderId: 'b', page: 1, position: 3}).changed;

			for (const [left, right] of [[moved, shift], [shift, moved]]) {
				const after = merged(merged(before, left), right);

				assert.equal(where(after, 'c3'), 'o:1/1', `moved at ${minute}: only in the other binder`);
				assert.deepEqual(pocketsOf(after[0]), [[1, 'c2']]);
			}

			for (const [left, right] of [[removed, shift], [shift, removed]]) {
				const after = merged(merged(before, left), right);

				assert.equal(where(after, 'c3'), 'loose', `removed at ${minute}: stays out`);
				assert.deepEqual(pocketsOf(after[0]), [[1, 'c2']]);
				assert.deepEqual(after[0].staged || [], []);
			}
		}

		// The shift's own phone merging its result again changes nothing.
		const mine = merged(before, shift);

		assert.deepEqual(pocketsOf(merged(mine, shift)[0]), [[1, 'c2'], [2, 'c3']]);
	});

	test('art a shift moved keeps its place when another phone edits another pocket', () => {
		const before = [hand('b', [holding(2, 1, 'c3'), artOn(2, 2), holding(2, 3, 'c4')])];
		const shift = binders.removePocket(before, {at: at(10), binderId: 'b', page: 2, position: 1, shift: true}).changed;
		const other = binders.setPocket(before, {at: at(11), binderId: 'b', content: {entry_id: 'c8'}, page: 3, position: 4});

		for (const [left, right] of [[shift, other], [other, shift]]) {
			assert.deepEqual(pocketsOf(merged(merged(before, left), right)[0]), [[5, 'art'], [6, 'c4'], [12, 'c8']]);
		}
	});

	test('a shift merged with another phone\'s edit to another pocket keeps both, either way round', () => {
		const before = [hand('b', [holding(1, 1, 'c1'), holding(1, 2, 'c2'), holding(1, 3, 'c3')])];
		const shift = binders.removePocket(before, {at: at(10), binderId: 'b', page: 1, position: 1, shift: true}).changed;
		const other = binders.setPocket(before, {at: at(11), binderId: 'b', content: {entry_id: 'c8'}, page: 3, position: 1});

		for (const [left, right] of [[shift, other], [other, shift]]) {
			const both = mergeDocuments({binders: mergeDocuments({binders: before}, {binders: left}).binders}, {binders: right}).binders;

			assert.deepEqual(pocketsOf(both[0]), [[1, 'c2'], [2, 'c3'], [9, 'c8']]);
		}
	});

	test('a shift and another phone writing a pocket it shifts into: the copy that loses the pocket goes to the tray', () => {
		// The shift moves c3 into pocket 2; the other phone, a moment later,
		// puts c8 there (c8 comes out of the tray), so c3 loses pocket 2.
		const before = [hand('b', [holding(1, 1, 'c1'), holding(1, 2, 'c2'), holding(1, 3, 'c3')], {staged: ['c8']})];
		const shift = binders.removePocket(before, {at: at(10), binderId: 'b', page: 1, position: 2, shift: true}).changed;
		const other = binders.setPocket(before, {at: at(11), binderId: 'b', content: {entry_id: 'c8'}, page: 1, position: 2});

		for (const [left, right] of [[shift, other], [other, shift]]) {
			const [binder] = mergeDocuments({binders: mergeDocuments({binders: before}, {binders: left}).binders}, {binders: right}).binders;
			const inPockets = binders.slotsOf(binder).filter((slot) => slot.entry_id).map((slot) => slot.entry_id);

			assert.deepEqual(pocketsOf(binder), [[1, 'c1'], [2, 'c8']]);
			assert.deepEqual(binder.staged, ['c3'], 'the shifted copy waits in the tray');
			assert.ok(!inPockets.includes('c2'), 'the copy removed on purpose stays out');
			assert.ok(!binder.staged.includes('c2'));
		}

		// Merged again with either side, it stays put.
		const once = mergeDocuments({binders: mergeDocuments({binders: before}, {binders: shift}).binders}, {binders: other}).binders;

		assert.deepEqual(mergeDocuments({binders: once}, {binders: shift}).binders[0].staged, ['c3']);
		assert.deepEqual(mergeDocuments({binders: once}, {binders: other}).binders[0].staged, ['c3']);
	});
});

// ------------------------------------------------------ a binder from a list

const item = (dex, copies = []) => ({copies, dex, key: `dex:${dex}`, name: `Mon ${dex}`});

const generated = (fields = {}) => ({
	art: [],
	cols: 2,
	cover_color: '#1d2e60',
	created_at: at(0),
	deleted_at: null,
	id: 'g',
	name: 'Unova',
	notes: '',
	page_count: 2,
	rows: 2,
	rule: {order: 'dex', source: {id: 'unova', kind: 'checklist'}},
	slots: [],
	snapshot: {at: at(0), keys: ['dex:494', 'dex:495', 'dex:498', 'dex:501', 'dex:504'], rule_key: 'checklist:unova|dex', shown: {}},
	updated_at: at(0),
	...fields,
});

const UNOVA_LIST = [item(494), item(495), item(498), item(501), item(504)];

const keysOf = (plan) => plan.snapshot.keys;

describe('a binder from a list: exceptions', () => {
	test('left out, a gap, the end, and before a key, applied after the list\'s order on every refresh', () => {
		const keys = UNOVA_LIST.map((entry) => entry.key);

		assert.deepEqual(rules.applyListEdits(keys, [{at: at(1), key: 'dex:494', kind: 'out'}]), ['dex:495', 'dex:498', 'dex:501', 'dex:504']);
		assert.deepEqual(rules.applyListEdits(keys, [{at: at(1), key: 'dex:494', kind: 'gap'}]), ['', 'dex:495', 'dex:498', 'dex:501', 'dex:504']);
		assert.deepEqual(rules.applyListEdits(keys, [{at: at(1), key: 'dex:494', kind: 'end'}]), ['dex:495', 'dex:498', 'dex:501', 'dex:504', 'dex:494']);
		assert.deepEqual(rules.applyListEdits(keys, [{at: at(1), before: 'dex:504', key: 'dex:494', kind: 'before'}]), ['dex:495', 'dex:498', 'dex:501', 'dex:494', 'dex:504']);
		assert.deepEqual(rules.applyListEdits(keys, [{at: at(1), before: 'dex:999', key: 'dex:494', kind: 'before'}]), keys, 'a key no longer on the list: its list place');

		// Move to... from what is shown: the end, and a pocket both ways.
		assert.deepEqual(rules.moveEdit(keys, 0, 'end', at(2)), {at: at(2), key: 'dex:494', kind: 'end'});
		assert.deepEqual(rules.moveEdit(keys, 0, 2, at(2)), {at: at(2), before: 'dex:501', key: 'dex:494', kind: 'before'});
		assert.deepEqual(rules.moveEdit(keys, 4, 0, at(2)), {at: at(2), before: 'dex:494', key: 'dex:504', kind: 'before'});
		assert.deepEqual(rules.moveEdit(keys, 4, 'end', at(2)), null, 'the last is at the end already');
		assert.deepEqual(rules.moveEdit(keys, 1, 1, at(2)), null);

		// One edit per key, the latest; taking it away (none) leaves nothing
		// to apply but stays saved.
		const edits = rules.withListEdit([{at: at(1), key: 'dex:494', kind: 'end'}], {at: at(3), key: 'dex:494', kind: 'out'});

		assert.deepEqual(rules.listEditsOf({list_edits: edits}), [{at: at(3), key: 'dex:494', kind: 'out'}]);

		const none = rules.withListEdit(edits, {at: at(4), key: 'dex:494', kind: 'none'});

		assert.deepEqual(rules.listEditsOf({list_edits: none}), []);
		assert.deepEqual(rules.listEditEntries({list_edits: none}), [{at: at(4), key: 'dex:494', kind: 'none'}]);
		assert.deepEqual(rules.listEditsOf({list_edits: [{at: at(1), key: 'dex:1', kind: 'sideways'}, {at: at(1), before: 'dex:1', key: 'dex:1', kind: 'before'}, null]}), []);
	});

	test('two exceptions saved at the same moment apply in key order (no crash)', () => {
		const same = [{at: at(1), key: 'dex:498', kind: 'end'}, {at: at(1), key: 'dex:494', kind: 'out'}];

		assert.deepEqual(rules.listEditsOf({list_edits: same}).map((edit) => edit.key), ['dex:494', 'dex:498']);
		assert.deepEqual(keysOf(rules.planRefresh(generated({list_edits: same}), UNOVA_LIST, {at: at(10), rankOf: () => ({})})), ['dex:495', 'dex:501', 'dex:504', 'dex:498']);
	});

	test('two phones\' exceptions merge key by key, and taking one away wins over it', () => {
		const base = generated();
		const edited = (list, minute) => stampEntry(base, {...structuredClone(base), list_edits: list, updated_at: at(minute)});
		const victini = edited([{at: at(5), key: 'dex:494', kind: 'end'}], 5);
		const snivy = edited([{at: at(6), key: 'dex:495', kind: 'out'}], 6);

		for (const [left, right] of [[victini, snivy], [snivy, victini]]) {
			const [binder] = mergeDocuments({binders: [left]}, {binders: [right]}).binders;

			assert.deepEqual(rules.listEditsOf(binder).map((edit) => [edit.key, edit.kind]), [['dex:494', 'end'], ['dex:495', 'out']]);
		}

		// Undo of Victini's move on one phone, an older save of it on the other.
		const undone = stampEntry(victini, {...structuredClone(victini), list_edits: [{at: at(7), key: 'dex:494', kind: 'none'}], updated_at: at(7)});
		const stale = stampEntry(victini, {...structuredClone(victini), name: 'Unova 2', updated_at: at(8)});

		for (const merge of [mergeDocuments, v47.mergeDocuments]) {
			for (const [left, right] of [[undone, stale], [stale, undone]]) {
				const [binder] = merge({binders: [left]}, {binders: [right]}).binders;

				if (merge === mergeDocuments) {
					assert.deepEqual(rules.listEditsOf(binder), [], 'taking it away wins');
				}
				else {
					assert.ok(Array.isArray(binder.list_edits), 'an older merge keeps the field');
				}
			}
		}
	});

	test('Victini to the end on refresh, with a new Pokémon joining at its list place', () => {
		const binder = generated({list_edits: [{at: at(5), key: 'dex:494', kind: 'end'}]});
		const plan = rules.planRefresh(binder, UNOVA_LIST, {at: at(10), rankOf: () => ({})});

		assert.deepEqual(keysOf(plan), ['dex:495', 'dex:498', 'dex:501', 'dex:504', 'dex:494']);

		// 496 joins the list later: it takes its list place, Victini stays last.
		const joined = rules.planRefresh({...binder, page_count: plan.page_count, snapshot: plan.snapshot}, [...UNOVA_LIST.slice(0, 2), item(496), ...UNOVA_LIST.slice(2)], {at: at(11), rankOf: () => ({})});

		assert.deepEqual(keysOf(joined), ['dex:495', 'dex:496', 'dex:498', 'dex:501', 'dex:504', 'dex:494']);
		assert.deepEqual(joined.added, ['dex:496']);
		assert.equal(joined.page_count, 2);
	});

	test('left out with Shift the rest back, and with Leave the pocket empty', () => {
		const out = rules.planRefresh(generated({list_edits: [{at: at(5), key: 'dex:494', kind: 'out'}]}), [item(494, [{created_at: at(0), id: 'v1'}]), ...UNOVA_LIST.slice(1)], {at: at(10), rankOf: () => ({})});

		assert.deepEqual(keysOf(out), ['dex:495', 'dex:498', 'dex:501', 'dex:504']);
		assert.deepEqual(out.snapshot.shown, {}, 'the copy left out is not shown');
		assert.equal(out.page_count, 1);

		const gap = rules.planRefresh(generated({list_edits: [{at: at(5), key: 'dex:494', kind: 'gap'}]}), UNOVA_LIST, {at: at(10), rankOf: () => ({})});

		assert.deepEqual(keysOf(gap), ['', 'dex:495', 'dex:498', 'dex:501', 'dex:504']);
		assert.deepEqual(gap.added, [], 'a gap is not a pocket added');
	});
});

describe('a binder from a list and older phones', () => {
	const edits = [{at: at(5), key: 'dex:494', kind: 'end'}];
	const opened = (binder) => rules.planRefresh(binder, UNOVA_LIST, {at: at(10), rankOf: () => ({})});
	// An older phone knows no list_edits: it lays out the list's own order.
	const older = (binder) => rules.planRefresh(binder, UNOVA_LIST, {at: at(10), edits: [], rankOf: () => ({})});

	test('a layout that differs only by the exceptions is not saved on opening', () => {
		const binder = generated({list_edits: edits});
		const plan = opened(binder);

		assert.equal(plan.changed, true);
		assert.equal(plan.editsOnly, true, 'the stored layout is the list\'s own order, as an older phone saves it');

		// Something an older phone would save too (a new Pokémon) is saved.
		const more = rules.planRefresh(binder, [...UNOVA_LIST, item(506)], {at: at(10), rankOf: () => ({})});

		assert.equal(more.changed, true);
		assert.equal(more.editsOnly, false);
	});

	test('two phones opening the binder in turn stop saving after one round', () => {
		// This phone saves its layout once, when the edit is made.
		let binder = generated({list_edits: edits});

		binder = {...binder, snapshot: opened(binder).snapshot};

		const saves = [];

		for (const who of ['v64', 'v65', 'v64', 'v65', 'v64', 'v65']) {
			const plan = who === 'v65' ? opened(binder) : older(binder);
			const save = plan.changed && !(who === 'v65' && (plan.editsOnly || plan.languageOnly));

			saves.push(`${who}:${save}`);

			if (save) {
				// Every app saves a clone of the entry with the new layout.
				binder = {...structuredClone(binder), page_count: plan.page_count, snapshot: plan.snapshot};
			}
		}

		assert.deepEqual(saves, ['v64:true', 'v65:false', 'v64:false', 'v65:false', 'v64:false', 'v65:false']);
		assert.deepEqual(binder.list_edits, edits, 'the older phone keeps the field it does not know');
	});

	// The older phone's save, as v56 to v64 make it: a clone of the entry
	// with its own snapshot, stamped (js/binders.js saveRefresh). v47's
	// stampEntry for a v47-shaped document, this app's for a v63-shaped one
	// (js/merge.js is unchanged from v63 apart from the tray rescue).
	function olderSaves(mine, stamp, minute) {
		const next = structuredClone(mine);

		next.snapshot = {...older(mine).snapshot, at: at(minute)};
		next.updated_at = at(minute);

		return stamp(mine, next);
	}

	test('an older phone\'s save keeps the exceptions, on its merge and on this one', () => {
		const base = generated();
		const mine = stampEntry(base, {...structuredClone(base), list_edits: edits, snapshot: {...opened({...base, list_edits: edits}).snapshot, at: at(6)}, updated_at: at(6)});

		for (const [label, stamp] of [['v47', v47.stampEntry], ['v63', stampEntry]]) {
			const theirs = olderSaves(mine, stamp, 8);

			for (const merge of [v47.mergeDocuments, mergeDocuments]) {
				for (const [left, right] of [[[mine], [theirs]], [[theirs], [mine]]]) {
					const [binder] = merge({binders: left}, {binders: right}).binders;

					assert.deepEqual(binder.list_edits, edits, `${label} save, merged either way`);
					assert.deepEqual(binder.snapshot.keys, UNOVA_LIST.map((entry) => entry.key), 'the older phone\'s layout is the later one');
					assert.equal(opened(binder).editsOnly, true, 'and this phone does not save it back on opening');
				}
			}
		}
	});
});
