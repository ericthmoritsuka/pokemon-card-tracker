// Unit tests for js/merge.js. Run: node --test tests/merge.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import {countChanged, mergeDocuments, mergeEntries, sameContent, stableJson, stamps} from '../js/merge.js';

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
