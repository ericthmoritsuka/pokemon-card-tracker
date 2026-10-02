// Unit tests for js/merge.js. Run: node --test tests/merge.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import {countChanged, mergeDocuments, mergeEntries, mergeEntry, nextStamp, restoreEntry, sameContent, stableJson, stamps} from '../js/merge.js';

import * as v21 from './merge-v21.mjs';

const at = (minute) => `2026-10-01T10:${String(minute).padStart(2, '0')}:00.000Z`;

const card = (id, minute, fields = {}) => ({card_id: 'me01-001', deleted_at: null, id, updated_at: at(minute), ...fields});

const doc = (cards, extra = {}) => ({binders: [], cards, collections: [], goals: [], openings: [], updated_at: at(0), wishlist: [], ...extra});

const byId = (list) => Object.fromEntries(list.map((entry) => [entry.id, entry]));

test('the newer updated_at wins, from either side', () => {
	const older = card('a', 1, {condition: 'Near Mint'});
	const newer = card('a', 2, {condition: 'Damaged'});

	assert.equal(mergeEntries([older], [newer])[0].condition, 'Damaged');
	assert.equal(mergeEntries([newer], [older])[0].condition, 'Damaged');
});

test('a tombstone wins over an older edit, and an older copy cannot bring it back', () => {
	const edit = card('a', 3, {notes: 'edited offline'});
	const tombstone = card('a', 5, {deleted_at: at(5)});

	for (const merged of [mergeEntries([edit], [tombstone]), mergeEntries([tombstone], [edit])]) {
		assert.equal(merged.length, 1);
		assert.equal(merged[0].deleted_at, at(5));
	}
});

test('at the same updated_at a tombstone wins', () => {
	const edit = card('a', 4, {notes: 'same minute'});
	const tombstone = card('a', 4, {deleted_at: at(4)});

	assert.equal(mergeEntries([edit], [tombstone])[0].deleted_at, at(4));
	assert.equal(mergeEntries([tombstone], [edit])[0].deleted_at, at(4));
});

test('a tie with different content picks the same winner on both sides', () => {
	const a = card('a', 4, {notes: 'phone'});
	const b = card('a', 4, {notes: 'laptop'});

	assert.deepEqual(mergeEntries([a], [b]), mergeEntries([b], [a]));
});

test('no entry is lost when both sides changed different entries', () => {
	const base = [card('a', 1), card('b', 1), card('c', 1)];
	const phone = [card('a', 2, {notes: 'phone'}), base[1], base[2], card('p', 2)];
	const laptop = [base[0], card('b', 3, {notes: 'laptop'}), card('c', 3, {deleted_at: at(3)}), card('l', 3)];

	const merged = byId(mergeDocuments(doc(phone), doc(laptop)).cards);

	assert.deepEqual(Object.keys(merged).sort(), ['a', 'b', 'c', 'l', 'p']);
	assert.equal(merged.a.notes, 'phone');
	assert.equal(merged.b.notes, 'laptop');
	assert.equal(merged.c.deleted_at, at(3));

	// The other direction holds the same entries at the same versions.
	assert.ok(sameContent(mergeDocuments(doc(phone), doc(laptop)), mergeDocuments(doc(laptop), doc(phone))));
});

test('two phones that each add the same card keep both entries', () => {
	const merged = mergeDocuments(doc([card('x1', 2)]), doc([card('x2', 2)]));

	assert.equal(merged.cards.length, 2);
});

test('running the merge twice changes nothing', () => {
	const local = doc([card('a', 2, {notes: 'phone'}), card('b', 1), card('d', 6, {deleted_at: at(6)})], {settings: {theme: 'fire', updated_at: at(2)}});
	const remote = doc([card('a', 1), card('b', 3), card('c', 4)], {settings: {theme: 'water', updated_at: at(1)}, updated_at: at(9)});

	const once = mergeDocuments(local, remote);
	const twice = mergeDocuments(once, remote);
	const back = mergeDocuments(once, once);

	assert.equal(stableJson(twice), stableJson(once));
	assert.equal(stableJson(back), stableJson(once));
	assert.equal(stableJson(mergeDocuments(remote, once)), stableJson(mergeDocuments(remote, twice)));
	assert.equal(once.settings.theme, 'fire');
	assert.equal(once.updated_at, at(9));
});

test('the merge leaves both inputs untouched', () => {
	const local = doc([card('a', 2)]);
	const remote = doc([card('a', 1), card('b', 1)]);
	const before = stableJson([local, remote]);

	mergeDocuments(local, remote);
	assert.equal(stableJson([local, remote]), before);
});

test('every list merges, including ones added later', () => {
	const merged = mergeDocuments(
		{binders: [{id: 'b1', updated_at: at(1)}], future: [{id: 'f1', updated_at: at(1)}]},
		{binders: [{id: 'b2', updated_at: at(1)}], future: [{id: 'f2', updated_at: at(1)}]}
	);

	assert.deepEqual(merged.binders.map((entry) => entry.id), ['b1', 'b2']);
	assert.deepEqual(merged.future.map((entry) => entry.id), ['f1', 'f2']);
	assert.deepEqual(merged.cards, []);
});

test('countChanged counts entries that differ from what the server holds', () => {
	const server = doc([card('a', 1), card('b', 1)]);
	const local = doc([card('a', 1), card('b', 2), card('c', 2)]);

	assert.equal(countChanged(local, stamps(server)), 2);
	assert.equal(countChanged(server, stamps(server)), 0);
	assert.equal(countChanged(local, null), 3);
});

test('nextStamp is later than the previous stamp even with a slow clock', () => {
	// The phone's clock says 09:58, but the version it edits says 10:05: the
	// edit is stamped just after 10:05, so it beats the version it replaced.
	const slow = Date.parse('2026-10-01T09:58:00.000Z');

	assert.equal(nextStamp(at(5), slow), '2026-10-01T10:05:00.001Z');
	assert.equal(nextStamp(at(5), Date.parse(at(9))), at(9), 'a clock that is ahead is used as it is');
	assert.equal(nextStamp(null, Date.parse(at(1))), at(1));
	assert.equal(nextStamp('not a date', Date.parse(at(1))), at(1));

	const edited = card('a', 0, {notes: 'from the slow phone', updated_at: nextStamp(at(5), slow)});

	assert.equal(mergeEntries([card('a', 5)], [edited])[0].notes, 'from the slow phone');
});

// ------------------------------------------------------- sticky deletes

test('a delete stays deleted when an offline phone edits the card later', () => {
	const tombstone = card('a', 5, {deleted_at: at(5)});
	const edit = card('a', 6, {notes: 'edited offline'});

	for (const [merged] of [mergeEntries([tombstone], [edit]), mergeEntries([edit], [tombstone])]) {
		assert.equal(merged.deleted_at, at(5));
		assert.ok(merged.updated_at > at(6), 'stamped later than the edit, so it is pushed and every phone takes it');
		assert.equal(merged.updated_at, '2026-10-01T10:06:00.001Z');
	}

	assert.deepEqual(mergeEntries([tombstone], [edit]), mergeEntries([edit], [tombstone]), 'both phones end up the same');
});

test('a restore on purpose brings an entry back; one older than the delete does not', () => {
	const tombstone = card('a', 5, {deleted_at: at(5)});
	const restored = restoreEntry(tombstone, Date.parse(at(7)));

	assert.equal(restored.deleted_at, null);
	assert.equal(restored.restored_at, at(7));
	assert.equal(restored.updated_at, at(7));

	for (const [merged] of [mergeEntries([tombstone], [restored]), mergeEntries([restored], [tombstone])]) {
		assert.equal(merged.deleted_at, null);
	}

	// Restored at minute 4, then deleted again at minute 5: the delete wins.
	const early = card('a', 4, {restored_at: at(4)});

	assert.equal(mergeEntries([early], [tombstone])[0].deleted_at, at(5));

	// A restore made on a phone with a slow clock still comes after the
	// delete it undoes.
	assert.ok(restoreEntry(tombstone, Date.parse(at(1))).restored_at > at(5));
	assert.equal(restoreEntry(card('b', 1)).id, 'b', 'a live entry is returned as it is');
	assert.equal('merged_into' in restoreEntry(card('c', 2, {deleted_at: at(2), merged_into: 'x'})), false);
});

test('the sticky result wins on a v21 phone too', () => {
	const tombstone = card('a', 5, {deleted_at: at(5)});
	const edit = card('a', 6, {notes: 'edited offline'});
	const [merged] = mergeEntries([tombstone], [edit]);

	// The v21 phone holds the edit and receives the result.
	for (const [old] of [v21.mergeEntries([edit], [merged]), v21.mergeEntries([merged], [edit])]) {
		assert.equal(old.deleted_at, at(5));
		assert.equal(old, merged);
	}
});

test('a result that differs from both sides gets a stamp newer than both; equal content returns the same object', () => {
	const tombstone = card('a', 5, {deleted_at: at(5)});
	const edit = card('a', 6, {notes: 'edited offline'});
	const [merged] = mergeEntries([edit], [tombstone]);

	assert.notEqual(merged, tombstone);
	assert.ok(merged.updated_at > edit.updated_at && merged.updated_at > tombstone.updated_at);

	// Once merged, merging again with either side changes nothing.
	assert.equal(mergeEntries([merged], [edit])[0], merged);
	assert.equal(mergeEntries([tombstone], [merged])[0], merged);

	const same = card('b', 3, {notes: 'x'});

	assert.equal(mergeEntries([same], [{...same}])[0], same);
	assert.equal(mergeEntry(same, same), same);

	// Stamps see the change, so the merged document is pushed.
	const local = doc([tombstone]);
	const remote = doc([edit]);
	const both = mergeDocuments(local, remote);

	assert.equal(sameContent(both, local), false);
	assert.equal(sameContent(both, remote), false);
});

test('two tombstones: the later one wins', () => {
	const first = card('a', 5, {deleted_at: at(5)});
	const second = card('a', 7, {deleted_at: at(7)});

	assert.equal(mergeEntries([first], [second])[0], second);
	assert.equal(mergeEntries([second], [first])[0], second);
});

test('deletes stick in every list: binders, lists, wishes, and lists added later', () => {
	const dead = {deleted_at: at(5), id: 'x', name: 'gone', updated_at: at(5)};
	const live = {deleted_at: null, id: 'x', name: 'renamed offline', updated_at: at(8)};

	for (const list of ['binders', 'goals', 'wishlist', 'collections', 'openings', 'future']) {
		const merged = mergeDocuments({[list]: [live]}, {[list]: [dead]});

		assert.equal(merged[list][0].deleted_at, at(5), list);
	}
});
