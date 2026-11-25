// Lists count every language unless Eric picks some (2026-11-24, after his
// Hoenn list binder refused a Japanese Latias): a new list stores no
// languages (js/languages.js NEW_LIST_LANGUAGES), and a checklist still
// carrying the old default, ['pt'] untouched since it was made, loses it on
// sync or at start (js/merge.js planDefaultListLanguages). A hand-made card
// can name its Pokémon (js/custom-card.js dex_number).
//
// Run: node --test tests/list-languages-default.test.mjs
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {cardFields, customCard, customRecord, editPatches} from '../js/custom-card.js';
import {countsOnList, NEW_LIST_LANGUAGES} from '../js/languages.js';
import {fieldStamp, mergeDocuments, mergeEntry, planDefaultListLanguages, stampEntry} from '../js/merge.js';

const MADE = '2026-11-01T10:00:00.000Z';
const list = (fields = {}) => ({created_at: MADE, deleted_at: null, hand_ticks: {}, id: 'list-hoenn', kind: 'region', languages: ['pt'], name: 'Hoenn', target: 'hoenn', updated_at: MADE, ...fields});

// Languages set by hand, the way js/checklists.js setListLanguages saves.
function setLanguages(goal, languages, at) {
	const after = {...goal, updated_at: at};

	if (languages) {
		after.languages = languages;
	}
	else {
		delete after.languages;
	}

	return stampEntry(goal, after);
}

const doc = (goals) => ({binders: [], cards: [], collections: [], goals, openings: [], wishlist: []});

describe('a new list', () => {
	test('names no languages, so a Japanese copy counts on it', () => {
		assert.equal(NEW_LIST_LANGUAGES, null);
		assert.equal(countsOnList({kind: 'region'}, {language: 'ja'}), true);
	});
});

describe('planDefaultListLanguages', () => {
	test('a checklist still on the old default counts every language, stamped as an edit', () => {
		const {count, doc: out} = planDefaultListLanguages(doc([list()]));
		const goal = out.goals[0];

		assert.equal(count, 1);
		assert.equal('languages' in goal, false);
		assert.ok(goal.updated_at > MADE);
		assert.equal(fieldStamp(goal, 'languages'), goal.updated_at);
		assert.equal(countsOnList(goal, {language: 'ja'}), true);
	});

	test('every other choice stays: Portuguese picked by hand, other languages, a Pokémon goal, a deleted list', () => {
		const picked = setLanguages(setLanguages(list(), ['pt', 'ja'], '2026-11-02T10:00:00.000Z'), ['pt'], '2026-11-03T10:00:00.000Z');
		const goals = [
			picked,
			list({id: 'list-two', languages: ['pt', 'ja']}),
			list({id: 'list-three', languages: ['ja']}),
			list({id: 'goal-latias', kind: 'pokemon', target: '380'}),
			list({deleted_at: MADE, id: 'list-gone'}),
			list({id: 'list-any', languages: undefined}),
		];
		const input = doc(goals);
		const {count, doc: out} = planDefaultListLanguages(input);

		assert.equal(count, 0);
		assert.equal(out, input, 'the same document when nothing changes');
	});

	test('runs once: a second pass changes nothing', () => {
		const first = planDefaultListLanguages(doc([list()])).doc;

		assert.equal(planDefaultListLanguages(first).count, 0);
	});

	test('merges with the version an older phone still holds, and keeps that phone\'s rename', () => {
		const migrated = planDefaultListLanguages(doc([list()])).doc.goals[0];

		assert.equal('languages' in mergeEntry(migrated, list()), false, 'the untouched version');

		// Another phone renamed the list before it saw the change.
		const renamed = stampEntry(list(), {...list(), name: 'Hoenn binder list', updated_at: '2026-11-25T09:00:00.000Z'});
		const merged = mergeDocuments(doc([migrated]), doc([renamed])).goals[0];

		assert.equal(merged.name, 'Hoenn binder list');
		assert.equal('languages' in merged, false);
		assert.equal(planDefaultListLanguages(doc([merged])).count, 0, 'no ping-pong');
	});
});

describe('a hand-made card\'s Pokémon', () => {
	const copy = (fields = {}) => ({card_id: 'hand_0123456789abcdef0123456789abcdef', catalog: 'custom', id: 'h1', language: 'zh-cn', name_local: '古空棘鱼', set_code: 'CBB4C', set_name_local: 'Gem Pack Vol.4', ...fields});

	test('the form stores the Pokémon picked, clears it with null, and leaves it alone when the form has no field', () => {
		assert.equal(cardFields({dex: 369, name: 'Relicanth'}).fields.dex_number, 369);
		assert.equal(cardFields({dex: null, name: 'Relicanth'}).fields.dex_number, null);
		assert.equal('dex_number' in cardFields({name: 'Relicanth'}).fields, false);
		assert.equal(cardFields({dex: 2000, name: 'Relicanth'}).fields.dex_number, null, 'no such Pokémon');
	});

	test('edit patches every copy, and the record and the card carry it', () => {
		const patches = editPatches([copy(), copy({id: 'h2'})], {dex: 369, name: '古空棘鱼', number: null, setCode: 'CBB4C', setName: 'Gem Pack Vol.4'});

		assert.deepEqual(patches.map((item) => item.patch.dex_number), [369, 369]);
		assert.deepEqual(customRecord(copy({dex_number: 369})).dex_ids, [369]);
		assert.deepEqual(customRecord(copy()).dex_ids, []);
		assert.equal(customCard([copy({dex_number: 369})], copy().card_id).dex, 369);
	});
});
