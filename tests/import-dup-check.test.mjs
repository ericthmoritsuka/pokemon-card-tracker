// The Monprice import check (js/import-dup-check.js): the groups of imported
// copies where one card, language, and finish has more than one copy, and
// the Checked mark that hides a group until its copies change. No browser:
// tests/copy-cleanup-browser.test.mjs plays the screen.
//
// Run: node --test tests/import-dup-check.test.mjs

import assert from 'node:assert/strict';
import {afterEach, describe, test} from 'node:test';

import {addedText, checkedSignature, importDuplicates, isChecked, isImported, keepChecked, markedChecked, toCheck} from '../js/import-dup-check.js';
import {forgetOnePrintings} from '../js/wishlist.js';

afterEach(() => forgetOnePrintings());

const IMPORT_AT = '2026-10-31T10:22:00.000Z';

// An imported copy of an invented card: the import key names the monprice
// card, language, finish, and the copy's number.
const imported = (id, fields = {}) => ({
	card_id: 'tsa1-004',
	catalog: 'international',
	created_at: IMPORT_AT,
	deleted_at: null,
	finish_raw: null,
	id,
	import_key: `monprice|m-1|en|NORMAL|${id}`,
	language: 'en',
	variant_id: 'tsa1-004-normal',
	...fields,
});

const added = (id, fields = {}) => imported(id, {import_key: undefined, ...fields});

describe('importDuplicates', () => {
	test('two imported copies of one card, language, and finish are a group', () => {
		const groups = importDuplicates([imported('a'), imported('b')]);

		assert.equal(groups.length, 1);
		assert.equal(groups[0].copies, 2);
		assert.equal(groups[0].card_id, 'tsa1-004');
		assert.equal(groups[0].language, 'en');
		assert.deepEqual(groups[0].rows.map((entry) => entry.id), ['a', 'b']);
		assert.equal(groups[0].first, IMPORT_AT);
	});

	test('one copy in a finish is not a group, nor is a card in two finishes', () => {
		const cards = [
			imported('a'),
			imported('b', {variant_id: 'tsa1-004-reverse'}),
			imported('c', {card_id: 'tsa1-006', variant_id: 'tsa1-006-normal'}),
		];

		assert.deepEqual(importDuplicates(cards), []);
	});

	test('language and catalog part the groups', () => {
		const cards = [
			imported('a'),
			imported('b', {language: 'pt'}),
			imported('c', {card_id: 'TSJ1-025', catalog: 'ja', language: 'ja'}),
			imported('d', {card_id: 'TSJ1-025', catalog: 'ja', language: 'ja'}),
		];
		const groups = importDuplicates(cards);

		assert.deepEqual(groups.map((group) => [group.card_id, group.language, group.copies]), [['TSJ1-025', 'ja', 2]]);
	});

	test('a copy added by hand is not the import\'s, and a removed copy does not count', () => {
		assert.deepEqual(importDuplicates([imported('a'), added('b')]), [], 'one imported and one by hand');
		assert.deepEqual(importDuplicates([imported('a'), imported('b', {deleted_at: '2026-11-01T00:00:00.000Z'})]), []);
		assert.equal(isImported(added('x')), false);
		assert.equal(isImported(imported('x')), true);
		assert.equal(isImported(null), false);
	});

	test('copies with no finish group together, and apart from a finish', () => {
		const none = {finish_raw: null, variant_id: null};
		const groups = importDuplicates([imported('a', none), imported('b', none), imported('c')]);

		assert.equal(groups.length, 1);
		assert.equal(groups[0].finish, '');
		assert.equal(groups[0].copies, 2);
	});

	test('a monprice word the catalog never matched groups by the word', () => {
		const raw = (id, word) => imported(id, {finish_raw: word, variant_id: null});
		const groups = importDuplicates([raw('a', 'HOLOFOIL'), raw('b', 'HOLOFOIL'), raw('c', 'NORMAL')]);

		assert.deepEqual(groups.map((group) => [group.finish, group.copies]), [['raw:HOLOFOIL', 2]]);
	});

	test('the finish is told apart by the key given', () => {
		const same = () => 'any';

		assert.equal(importDuplicates([imported('a'), imported('b', {variant_id: 'tsa1-004-reverse'})], {finishKey: same}).length, 1);
	});

	test('most copies first, then the earliest added', () => {
		const cards = [
			imported('a', {card_id: 'tsa1-001', created_at: '2026-10-31T10:30:00.000Z'}),
			imported('b', {card_id: 'tsa1-001', created_at: '2026-10-31T10:30:00.000Z'}),
			imported('c', {card_id: 'tsa1-006'}),
			imported('d', {card_id: 'tsa1-006'}),
			imported('e', {card_id: 'tsb2-025'}),
			imported('f', {card_id: 'tsb2-025'}),
			imported('g', {card_id: 'tsb2-025'}),
		];

		assert.deepEqual(importDuplicates(cards).map((group) => [group.card_id, group.copies]), [['tsb2-025', 3], ['tsa1-006', 2], ['tsa1-001', 2]]);
	});

	test('first and last are the earliest and latest time added', () => {
		const [group] = importDuplicates([imported('a', {created_at: '2026-11-02T09:00:00.000Z'}), imported('b'), imported('c')]);

		assert.equal(group.first, IMPORT_AT);
		assert.equal(group.last, '2026-11-02T09:00:00.000Z');
	});
});

describe('Checked', () => {
	const groupOf = (cards) => importDuplicates(cards)[0];

	test('a mark hides its group, and a different group stays', () => {
		const a = groupOf([imported('a'), imported('b')]);
		const other = groupOf([imported('c', {card_id: 'tsa1-006'}), imported('d', {card_id: 'tsa1-006'})]);
		const marks = {[a.key]: checkedSignature(a)};

		assert.equal(isChecked(a, marks), true);
		assert.equal(isChecked(other, marks), false);
		assert.deepEqual(toCheck([a, other], marks), [other]);
		assert.deepEqual(markedChecked([a, other], marks), [a]);
		assert.equal(isChecked(a, null), false);
	});

	test('the mark is forgotten when the group\'s count changes', () => {
		const two = groupOf([imported('a'), imported('b')]);
		const marks = {[two.key]: checkedSignature(two)};
		const three = groupOf([imported('a'), imported('b'), imported('c')]);

		assert.equal(three.key, two.key);
		assert.equal(isChecked(three, marks), false, 'a copy came in');
		assert.deepEqual(keepChecked([three], marks), {});
	});

	test('the mark stays when the same copies are still there, in any order', () => {
		const first = groupOf([imported('a'), imported('b')]);
		const again = groupOf([imported('b'), imported('a')]);

		assert.equal(isChecked(again, {[first.key]: checkedSignature(first)}), true);
	});

	test('a swapped copy resets the mark too', () => {
		const first = groupOf([imported('a'), imported('b')]);
		const swapped = groupOf([imported('a'), imported('z')]);

		assert.equal(isChecked(swapped, {[first.key]: checkedSignature(first)}), false);
	});

	test('keepChecked drops the marks of groups that are gone and keeps the rest', () => {
		const a = groupOf([imported('a'), imported('b')]);
		const marks = {[a.key]: checkedSignature(a), gone: '["x"]'};

		assert.deepEqual(keepChecked([a], marks), {[a.key]: checkedSignature(a)});
		assert.deepEqual(keepChecked([a], null), {});
	});
});

describe('addedText', () => {
	// Each time read in UTC, so the test does not depend on the zone.
	const utc = (iso) => (iso ? {day: iso.slice(0, 10), time: iso.slice(11, 16)} : null);
	const group = (first, last = first) => ({first, last});

	test('one minute, one day, and several days', () => {
		assert.equal(addedText(group(IMPORT_AT), utc), 'Added 2026-10-31 at 10:22');
		assert.equal(addedText(group(IMPORT_AT, '2026-10-31T10:25:00.000Z'), utc), 'Added 2026-10-31 at 10:22 to 10:25');
		assert.equal(addedText(group(IMPORT_AT, '2026-11-02T09:00:00.000Z'), utc), 'Added 2026-10-31 at 10:22 to 2026-11-02 at 09:00');
	});

	test('a copy with no time says so', () => {
		assert.equal(addedText(group(null), utc), 'Added at an unknown time');
	});
});
