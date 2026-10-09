// Unit tests for js/reorder.js: the order of checklists, goals, collections,
// and binders, and how two phones' orders merge (js/merge.js). Invented data.
// Run: node --test tests/reorder.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import {mergeDocuments, mergeEntries, restoreEntry, stampEntry, validVersion} from '../js/merge.js';
import {byCreated, orderForNew, orderMoves, sortByOrder, undoMoves, withOrders} from '../js/reorder.js';

const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-06T10:00:00.000Z');
const at = (minute) => new Date(T0 + (minute * MIN)).toISOString();

const list = (id, minute, fields = {}) => ({created_at: at(minute), deleted_at: null, id, kind: 'region', name: `List ${id}`, updated_at: at(minute), ...fields});

const ids = (entries) => entries.map((entry) => entry.id);

// Applies changes to a section as a phone would, at a minute.
const applied = (section, changes, minute) => {
	const saved = new Map(withOrders(section, changes, T0 + (minute * MIN)).map((entry) => [entry.id, entry]));

	return section.map((entry) => saved.get(entry.id) || entry);
};

const KANTO = [list('a', 0), list('b', 1), list('c', 2), list('d', 3)];

test('with no order anywhere, the old order stands', () => {
	assert.deepEqual(ids(sortByOrder([list('c', 2), list('a', 0), list('b', 1)], byCreated)), ['a', 'b', 'c']);
	assert.equal(orderForNew(KANTO), null, 'a new list takes no order yet, so it lands at the end as before');
});

test('the first move numbers the whole section, so nothing else shifts', () => {
	const changes = orderMoves(KANTO, 'd', 0);

	assert.deepEqual(changes, [
		{before: null, id: 'd', order: 1},
		{before: null, id: 'a', order: 2},
		{before: null, id: 'b', order: 3},
		{before: null, id: 'c', order: 4},
	]);

	const moved = applied(KANTO, changes, 10);

	assert.deepEqual(ids(sortByOrder(moved, byCreated)), ['d', 'a', 'b', 'c']);
	assert.ok(moved.every(validVersion), 'each one stamped field by field');
	assert.equal(orderForNew(moved), 5);
});

test('later moves write the moved entry only, between its new neighbours', () => {
	const numbered = applied(KANTO, orderMoves(KANTO, 'b', 0), 10);
	const sorted = sortByOrder(numbered, byCreated);

	assert.deepEqual(ids(sorted), ['b', 'a', 'c', 'd']);

	const down = orderMoves(sorted, 'b', 2);

	assert.deepEqual(down, [{before: 1, id: 'b', order: 3.5}]);
	assert.deepEqual(ids(sortByOrder(applied(numbered, down, 11), byCreated)), ['a', 'c', 'b', 'd']);
	assert.deepEqual(orderMoves(sorted, 'd', 0), [{before: 4, id: 'd', order: 0}], 'to the top: one less than the first');
	assert.deepEqual(orderMoves(sorted, 'b', 9), [{before: 1, id: 'b', order: 5}], 'past the end: one more than the last');
	assert.deepEqual(orderMoves(sorted, 'b', 0), [], 'no move, no change');
	assert.deepEqual(orderMoves(sorted, 'zz', 1), [], 'an unknown id moves nothing');
});

test('a gap too small to halve numbers the section again', () => {
	const tight = [list('a', 0, {order: 1}), list('b', 1, {order: 1 + Number.EPSILON}), list('c', 2, {order: 2})];
	const changes = orderMoves(tight, 'c', 1);

	assert.deepEqual(ids(sortByOrder(applied(tight, changes, 5), byCreated)), ['a', 'c', 'b']);
	// Numbered 1, 2, 3 again: a and c hold theirs already, so b alone moves.
	assert.deepEqual(changes, [{before: 1 + Number.EPSILON, id: 'b', order: 3}]);
});

test('Undo writes each order back, and takes away one that was not there', () => {
	const changes = orderMoves(KANTO, 'c', 0);
	const moved = applied(KANTO, changes, 10);
	const undone = applied(moved, undoMoves(changes), 11);

	assert.deepEqual(ids(sortByOrder(undone, byCreated)), ['a', 'b', 'c', 'd']);
	assert.ok(undone.every((entry) => !('order' in entry)));
	assert.ok(undone.every(validVersion));
});

test('two phones moving different lists both keep their moves', () => {
	const base = applied(KANTO, orderMoves(KANTO, 'b', 0), 10);
	const sorted = sortByOrder(base, byCreated);
	// Phone A moves d to the top; phone B moves a to the bottom.
	const phoneA = applied(base, orderMoves(sorted, 'd', 0), 20);
	const phoneB = applied(base, orderMoves(sorted, 'a', 3), 21);

	for (const merged of [mergeEntries(phoneA, phoneB), mergeEntries(phoneB, phoneA)]) {
		assert.deepEqual(ids(sortByOrder(merged, byCreated)), ['d', 'b', 'c', 'a']);
	}
});

test('two phones moving the same list: the later move stands', () => {
	const base = applied(KANTO, orderMoves(KANTO, 'a', 1), 10);
	const sorted = sortByOrder(base, byCreated);
	const phoneA = applied(base, orderMoves(sorted, 'c', 0), 20);
	const phoneB = applied(base, orderMoves(sorted, 'c', 3), 21);

	for (const merged of [mergeEntries(phoneA, phoneB), mergeEntries(phoneB, phoneA)]) {
		assert.deepEqual(ids(sortByOrder(merged, byCreated)), ['b', 'a', 'd', 'c']);
	}
});

test('a move and a rename on two phones both survive', () => {
	const base = applied(KANTO, orderMoves(KANTO, 'a', 1), 10);
	const moved = applied(base, orderMoves(sortByOrder(base, byCreated), 'c', 0), 20);
	const c = base.find((entry) => entry.id === 'c');
	const renamed = stampEntry(c, {...c, name: 'Johto', updated_at: at(25)});
	const merged = mergeEntries(moved, [renamed]).find((entry) => entry.id === 'c');

	assert.equal(merged.name, 'Johto');
	assert.equal(merged.order, 0);
});

test('an older app carries the order along, and a list it makes goes to the end', () => {
	const base = applied(KANTO, orderMoves(KANTO, 'd', 0), 10);
	// An older app renames b by spreading the entry, with no new field stamps.
	const b = base.find((entry) => entry.id === 'b');
	const {field_stamps: _stamps, ...older} = {...b, name: 'Renamed', updated_at: at(30)};
	const made = list('e', 31);
	const merged = mergeDocuments({goals: base}, {goals: [older, made]}).goals;

	assert.equal(merged.find((entry) => entry.id === 'b').order, 3);
	assert.deepEqual(ids(sortByOrder(merged, byCreated)), ['d', 'a', 'b', 'c', 'e']);
});

test('a new list takes one more than the highest order of its section', () => {
	const base = applied(KANTO, orderMoves(KANTO, 'd', 0), 10);

	assert.equal(orderForNew(base), 5);
	assert.equal(orderForNew([...base, list('x', 5, {order: 7.5})]), 8);
	assert.equal(orderForNew([]), null);
});

test('a deleted list brought back by Undo keeps its place', () => {
	const base = applied(KANTO, orderMoves(KANTO, 'c', 0), 10);
	const c = base.find((entry) => entry.id === 'c');
	const deleted = stampEntry(c, {...c, deleted_at: at(20), updated_at: at(20)});
	const restored = restoreEntry(deleted, T0 + (21 * MIN));
	const merged = mergeEntries(base.map((entry) => (entry.id === 'c' ? deleted : entry)), [restored]);

	assert.deepEqual(ids(sortByOrder(merged.filter((entry) => !entry.deleted_at), byCreated)), ['c', 'a', 'b', 'd']);
});

test('withOrders leaves out deleted and unknown entries', () => {
	const gone = list('g', 0, {deleted_at: at(1)});

	assert.deepEqual(withOrders([gone, list('a', 0)], [{id: 'g', order: 1}, {id: 'zz', order: 2}, {id: 'a', order: 3}], T0).map((entry) => [entry.id, entry.order]), [['a', 3]]);
});
