// Unit tests for js/collections.js and the merge of the collections list
// (js/merge.js). Invented data. Run: node --test tests/collections.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import {mergeDocuments, mergeEntries, restoreEntry, validVersion} from '../js/merge.js';

// js/dom.js (reached through the filter bar) listens for errors on window.
globalThis.window = globalThis.window || {addEventListener() {}};

const {
	cleanRule,
	collectionEntries,
	deletedCollection,
	editedCollection,
	isMember,
	itemFor,
	memberIds,
	newCollection,
	ruleMatches,
	ruleText,
	sortCollections,
	withMembers,
	withoutMembers,
} = await import('../js/collections.js');

const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-03T10:00:00.000Z');
const at = (minute) => new Date(T0 + (minute * MIN)).toISOString();

const hand = (name = 'Favorites', minute = 0) => newCollection({kind: 'hand', name}, at(minute), 'col-1');

const doc = (collections, extra = {}) => ({binders: [], cards: [], collections, goals: [], openings: [], updated_at: at(0), wishlist: [], ...extra});

const copy = (id, cardId, fields = {}) => ({card_id: cardId, catalog: 'international', created_at: at(0), deleted_at: null, id, language: 'en', updated_at: at(0), ...fields});

const INDEX = new Map([
	['international|tsa1-001', {category: 'Pokemon', dex_ids: [1], rarity: 'Common', set_id: 'tsa1', types: ['Grass']}],
	['international|tsa1-006', {category: 'Pokemon', dex_ids: [6], rarity: 'Special illustration rare', set_id: 'tsa1', types: ['Fire']}],
	['international|tsb2-025', {category: 'Pokemon', dex_ids: [25], rarity: 'Illustration rare', set_id: 'tsb2', types: ['Lightning']}],
	['international|tsb2-090', {category: 'Pokemon', dex_ids: [906], rarity: 'Rare', set_id: 'tsb2', types: ['Grass']}],
]);

const CARDS = [
	copy('c-1', 'tsa1-001'),
	copy('c-2', 'tsa1-006', {is_favorite: true}),
	copy('c-3', 'tsb2-025', {language: 'pt'}),
	copy('c-4', 'tsb2-090'),
	copy('c-5', 'tsb2-025', {deleted_at: at(1)}),
];

test('a new collection needs a name and a known kind, and a rule needs a condition', () => {
	assert.throws(() => newCollection({kind: 'hand', name: '  '}), /needs a name/);
	assert.throws(() => newCollection({kind: 'pile', name: 'X'}), /Unknown collection kind/);
	assert.throws(() => newCollection({kind: 'rule', name: 'X', rule: {}}), /at least one condition/);

	const made = newCollection({kind: 'rule', name: ' Star  cards ', rule: {rarity: 'Illustration rare'}});

	assert.equal(made.name, 'Star cards');
	assert.deepEqual(made.rule, {rarity: ['Illustration rare']});
	assert.equal(newCollection({name: 'Plain'}).rule, null);
	assert.ok(validVersion(made));
});

test('a rule keeps only what it names, with values as lists', () => {
	assert.deepEqual(cleanRule({favorite: true, language: ['pt', 'pt', ' '], rarity: ['A', 'B'], set: '', unknown: 1, dex: '0-0'}), {favorite: true, language: ['pt'], rarity: ['A', 'B']});
});

test('a rule matches by any value of a field, and every field named', () => {
	const star = {rarity: ['Illustration rare', 'Special illustration rare']};
	const live = CARDS.filter((entry) => !entry.deleted_at);
	const match = (rule) => live.filter((entry) => ruleMatches(rule, itemFor(entry, INDEX.get(`international|${entry.card_id}`)))).map((entry) => entry.id);

	assert.deepEqual(match(star), ['c-2', 'c-3']);
	assert.deepEqual(match({...star, language: ['pt']}), ['c-3']);
	assert.deepEqual(match({...star, favorite: true}), ['c-2']);
	assert.deepEqual(match({set: ['international|tsb2'], type: ['Grass']}), ['c-4']);
	assert.deepEqual(match({region: ['kanto']}), ['c-1', 'c-2', 'c-3']);
	assert.deepEqual(match({dex: '25-25'}), ['c-3']);
	assert.deepEqual(match({rarity: ['Mythic']}), []);
});

test('a rule collection fills itself from live copies, a hand-picked one from its members', () => {
	const star = newCollection({kind: 'rule', name: 'Star', rule: {rarity: STAR}}, at(0), 'col-star');
	const picked = withMembers(hand(), ['c-1', 'c-4', 'c-5', 'gone'], T0 + (2 * MIN));

	assert.deepEqual(collectionEntries(star, CARDS, INDEX).map((entry) => entry.id), ['c-2', 'c-3']);
	assert.deepEqual(collectionEntries(picked, CARDS, INDEX).map((entry) => entry.id), ['c-1', 'c-4']);
	assert.deepEqual(collectionEntries(star, CARDS, new Map()).map((entry) => entry.id), [], 'no details yet, no match');
});

const STAR = ['Illustration rare', 'Special illustration rare'];

test('a member folded into another copy by the merge is followed there', () => {
	const cards = [copy('old', 'tsa1-001', {deleted_at: at(3), merged_into: 'new'}), copy('new', 'tsa1-001')];
	const picked = withMembers(hand(), ['old'], T0 + (4 * MIN));

	assert.deepEqual(collectionEntries(picked, cards, INDEX).map((entry) => entry.id), ['new']);
});

test('adding and removing members stamps each change after the last', () => {
	const base = hand();
	const one = withMembers(base, ['c-1'], T0);

	assert.ok(isMember(one, 'c-1'));
	assert.equal(withMembers(one, ['c-1'], T0 + MIN), one, 'already in: nothing changes');
	assert.ok(Date.parse(one.updated_at) > Date.parse(base.updated_at));

	const out = withoutMembers(one, ['c-1', 'c-9'], T0);

	assert.ok(!isMember(out, 'c-1'));
	assert.deepEqual(memberIds(out), []);
	assert.equal(withoutMembers(out, ['c-1'], T0), out);

	const back = withMembers(out, ['c-1'], T0);

	assert.ok(isMember(back, 'c-1'), 'added again on a clock that has not moved');
	assert.ok(validVersion(back));
});

test('two phones adding different cards to one collection both keep theirs', () => {
	const base = withMembers(hand(), ['c-1'], T0 + MIN);
	const phoneA = withMembers(base, ['c-2'], T0 + (2 * MIN));
	const phoneB = withMembers(base, ['c-3', 'c-4'], T0 + (3 * MIN));

	for (const merged of [mergeEntries([phoneA], [phoneB]), mergeEntries([phoneB], [phoneA])]) {
		assert.equal(merged.length, 1);
		assert.deepEqual(memberIds(merged[0]).sort(), ['c-1', 'c-2', 'c-3', 'c-4']);
	}

	const both = mergeDocuments(doc([phoneA]), doc([phoneB]));

	assert.deepEqual(memberIds(both.collections[0]).sort(), ['c-1', 'c-2', 'c-3', 'c-4']);
	assert.deepEqual(mergeDocuments(doc([phoneB]), doc([phoneA])).collections, mergeDocuments(doc([phoneA]), doc([phoneB])).collections);
});

test('cards added to a collection are not lost to a rename on the other phone', () => {
	const base = hand();
	const adds = withMembers(base, ['c-1'], T0 + MIN);
	const renames = editedCollection(base, {name: 'Keepers'}, T0 + (2 * MIN));
	const merged = mergeEntries([adds], [renames])[0];

	assert.equal(merged.name, 'Keepers');
	assert.deepEqual(memberIds(merged), ['c-1']);
});

test('a removal on one phone sticks over an older add, and a later add brings the card back', () => {
	const base = withMembers(hand(), ['c-1', 'c-2'], T0 + MIN);
	const removed = withoutMembers(base, ['c-1'], T0 + (2 * MIN));
	const stale = withMembers(base, ['c-3'], T0 + (3 * MIN));

	let merged = mergeEntries([stale], [removed])[0];

	assert.deepEqual(memberIds(merged).sort(), ['c-2', 'c-3'], 'c-1 stays out; the other phone still added c-3');
	merged = mergeEntries([removed], [stale])[0];
	assert.deepEqual(memberIds(merged).sort(), ['c-2', 'c-3']);

	const again = withMembers(removed, ['c-1'], T0 + (4 * MIN));

	assert.deepEqual(memberIds(mergeEntries([again], [stale])[0]).sort(), ['c-1', 'c-2', 'c-3']);
});

test('a removal wins a tie with an add', () => {
	const base = hand();
	const a = {...base, entry_ids: {x: at(5)}, updated_at: at(5)};
	const b = {...base, removed_ids: {x: at(5)}, updated_at: at(5)};

	assert.deepEqual(memberIds(mergeEntries([a], [b])[0]), []);
	assert.deepEqual(memberIds(mergeEntries([b], [a])[0]), []);
});

test('a deleted collection stays deleted on every phone, and Undo brings it back', () => {
	const base = withMembers(hand(), ['c-1'], T0 + MIN);
	const deleted = deletedCollection(base, T0 + (2 * MIN));
	const edited = withMembers(base, ['c-2'], T0 + (5 * MIN));

	for (const merged of [mergeEntries([edited], [deleted]), mergeEntries([deleted], [edited])]) {
		assert.equal(merged.length, 1);
		assert.ok(merged[0].deleted_at);
		assert.deepEqual(sortCollections(merged), []);
	}

	const restored = restoreEntry(deleted, T0 + (6 * MIN));

	assert.equal(restored.deleted_at, null);
	assert.equal(sortCollections(mergeEntries([deleted], [restored])).length, 1);
	assert.equal(sortCollections(mergeEntries([edited], [restored])).length, 1);
});

test('a rule and a name edited on two phones both survive', () => {
	const base = newCollection({kind: 'rule', name: 'Star', rule: {rarity: STAR}}, at(0), 'col-r');
	const renamed = editedCollection(base, {name: 'Stars'}, T0 + MIN);
	const reruled = editedCollection(base, {rule: {rarity: STAR, language: ['pt']}}, T0 + (2 * MIN));
	const merged = mergeEntries([renamed], [reruled])[0];

	assert.equal(merged.name, 'Stars');
	assert.deepEqual(merged.rule, {language: ['pt'], rarity: STAR});
	assert.equal(merged.kind, 'rule');
});

test('a hand-picked collection takes no rule, and a rule edit leaves a hand collection alone', () => {
	const picked = hand();

	assert.equal(editedCollection(picked, {rule: {rarity: ['X']}}, T0).rule, null);
});

test('collections sort by name, deleted ones left out', () => {
	const list = [newCollection({name: 'beta'}, at(0), 'b'), newCollection({name: 'Alpha'}, at(1), 'a'), deletedCollection(newCollection({name: 'Gone'}, at(2), 'g'), T0 + (3 * MIN))];

	assert.deepEqual(sortCollections(list).map((item) => item.id), ['a', 'b']);
});

test('a rule reads as words, with readable names for sets', () => {
	assert.equal(ruleText({favorite: true, rarity: STAR, set: ['international|tsa1']}, {set: {'international|tsa1': 'Test Alpha'}}),
		'Rarity: Illustration rare, Special illustration rare. Set: Test Alpha. Favorites only');
});

test('mergeDocuments merges the collections list like the others', () => {
	const a = hand('One', 0);
	const b = {...hand('Two', 1), id: 'col-2'};
	const merged = mergeDocuments(doc([a]), doc([b]));

	assert.deepEqual(merged.collections.map((item) => item.id).sort(), ['col-1', 'col-2']);
});
