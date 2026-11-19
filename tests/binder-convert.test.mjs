// Unit tests for "Make a list binder from this" (js/binder-convert.js;
// Eric, 2026-11-18): which hand pick each pocket of the new binder gets from
// the hand-made binder's pockets (the same Pokémon, two copies for one
// pocket, a card not on the list, empty pockets, placeholders, art, a Gone
// copy, a TAG TEAM card), the checklist guessed for the form, the name, the
// words, and the picks merged with phones still on older apps (the frozen
// v21 and v47 merges). Plain Node, invented data, and nothing is requested.
//
// Run: node --test tests/binder-convert.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {convertDoneText, convertPreview, guessChecklist, handDex, handPicks, listBinderName} from '../js/binder-convert.js';
import {pickEntry, picksOf, shownCopy} from '../js/binder-rules.js';
import {mergeDocuments} from '../js/merge.js';
import {mergeDocuments as mergeV21} from './merge-v21.mjs';
import {mergeDocuments as mergeV47} from './v47/merge.js';

const at = (minute) => `2026-11-18T10:${String(minute).padStart(2, '0')}:00.000Z`;

const copy = (id, cardId = `tst1-${id}`) => ({card_id: cardId, catalog: 'international', created_at: at(0), deleted_at: null, id, language: 'en', updated_at: at(0)});

const holding = (page, position, entryId) => ({entry_id: entryId, page, placed_at: at(1), position});

const pokemon = (dex, copies = []) => ({copies, dex, key: `dex:${dex}`, kind: 'pokemon'});

// A checklist of 1, 4, 7, and 25: c1a and c1b show Pokémon 1, c4 shows 4,
// c7 shows 7, and nobody owns a 25. cX is a Trainer, on no list.
const ITEMS = [
	pokemon(1, [copy('c1a'), copy('c1b')]),
	pokemon(4, [copy('c4')]),
	pokemon(7, [copy('c7')]),
	pokemon(25),
];

describe('the picks from a hand-made binder', () => {
	test('each pocket the hand-made binder holds a copy for picks that exact copy', () => {
		// c1b sits in the hand-made binder, though c1a is the default (the
		// list orders copies its own way): the pick is c1b.
		const slots = [holding(1, 1, 'c1b'), holding(1, 2, 'c4'), holding(2, 1, 'c7')];
		const result = handPicks(slots, ITEMS);

		assert.deepEqual(result, {
			outside: 0,
			picks: [
				{entryId: 'c1b', key: 'dex:1', page: 1, position: 1},
				{entryId: 'c4', key: 'dex:4', page: 1, position: 2},
				{entryId: 'c7', key: 'dex:7', page: 2, position: 1},
			],
			unused: 0,
		});

		// And the pocket shows it over the default.
		const shown = shownCopy(ITEMS[0], {pick: 'c1b', rankOf: (entry) => ({value: entry.id === 'c1a' ? 10 : null})});

		assert.deepEqual([shown.entry.id, shown.picked], ['c1b', true]);
	});

	test('two copies for one pocket: the first in pocket order is picked, the other counted as not used', () => {
		const slots = [holding(2, 3, 'c1a'), holding(1, 4, 'c1b'), holding(1, 1, 'c4')];
		const result = handPicks(slots, ITEMS);

		assert.deepEqual(result.picks.map((pick) => [pick.key, pick.entryId]), [['dex:4', 'c4'], ['dex:1', 'c1b']]);
		assert.equal(result.unused, 1);
		assert.equal(result.outside, 0);
	});

	test('a card not on the list, or in a language the list does not count, fits no pocket', () => {
		// cX is a Trainer; c7-ja shows Pokémon 7 but the list counts only
		// English, so the list's items do not hold it.
		const slots = [holding(1, 1, 'cX'), holding(1, 2, 'c7-ja'), holding(1, 3, 'c7')];
		const result = handPicks(slots, ITEMS);

		assert.deepEqual(result.picks.map((pick) => pick.entryId), ['c7']);
		assert.equal(result.outside, 2);
		assert.equal(result.unused, 0);
	});

	test('empty pockets, placeholders, art, a pocket left empty on purpose, and a Gone copy give no pick and count nowhere', () => {
		const slots = [
			{empty: true, page: 1, placed_at: at(1), position: 1},
			{page: 1, placed_at: at(1), position: 2, want: {card_id: null, catalog: null, dex: 25, image: null, name: 'Pikachu', variant_id: null}},
			{page: 1, placed_at: at(1), position: 3, want: {card_id: 'tst1-c4', catalog: 'international', image: null, name: 'Test Ember', variant_id: null}},
			{art: {id: 'art-1', tile: 0}, page: 1, position: 4},
			// The copy in this pocket was deleted, so it is Gone, not off the list.
			holding(2, 1, 'c-gone'),
			holding(2, 2, 'c4'),
		];
		const result = handPicks(slots, ITEMS, {liveIds: new Set(['c1a', 'c1b', 'c4', 'c7'])});

		assert.deepEqual(result, {outside: 0, picks: [{entryId: 'c4', key: 'dex:4', page: 2, position: 2}], unused: 0});
	});

	test('an empty hand-made binder gives no picks', () => {
		assert.deepEqual(handPicks([], ITEMS), {outside: 0, picks: [], unused: 0});
	});

	test('only the new binder\'s pockets take a pick', () => {
		const result = handPicks([holding(1, 1, 'c1a'), holding(1, 2, 'c4')], ITEMS, {keys: ['dex:1', 'dex:7', 'dex:25']});

		assert.deepEqual(result.picks.map((pick) => pick.key), ['dex:1']);
		assert.equal(result.outside, 1);
	});

	test('a TAG TEAM card takes the first of its Pokémon still free, after the cards that show one', () => {
		// cTT shows 1 and 4 and comes first in the binder; c4 shows 4 alone.
		const items = [pokemon(1, [copy('cTT')]), pokemon(4, [copy('cTT'), copy('c4')])];
		const result = handPicks([holding(1, 1, 'cTT'), holding(1, 2, 'c4')], items);

		assert.deepEqual(result.picks.map((pick) => [pick.key, pick.entryId]), [['dex:1', 'cTT'], ['dex:4', 'c4']]);
		assert.equal(result.unused, 0);

		// With Pokémon 1 taken already, it has nowhere to go.
		const crowded = [pokemon(1, [copy('cTT'), copy('c1a')]), pokemon(4, [copy('cTT'), copy('c4')])];
		const second = handPicks([holding(1, 1, 'cTT'), holding(1, 2, 'c4'), holding(1, 3, 'c1a')], crowded);

		assert.deepEqual(second.picks.map((pick) => [pick.key, pick.entryId]), [['dex:4', 'c4'], ['dex:1', 'c1a']]);
		assert.equal(second.unused, 1);
	});

	test('a copy read in two pockets (two phones disagreeing) counts once', () => {
		const result = handPicks([holding(1, 1, 'c4'), holding(1, 2, 'c4')], ITEMS);

		assert.deepEqual(result, {outside: 0, picks: [{entryId: 'c4', key: 'dex:4', page: 1, position: 1}], unused: 0});
	});

	test('a list of cards (a collection or a goal) picks by card key the same way', () => {
		const items = [
			{copies: [copy('a1', 'sv1-001'), copy('a2', 'sv1-001')], key: 'international|sv1-001', kind: 'card'},
			{copies: [], key: 'international|sv1-002', kind: 'card'},
		];
		const result = handPicks([holding(1, 1, 'a2'), holding(1, 2, 'a1')], items);

		assert.deepEqual(result, {outside: 0, picks: [{entryId: 'a2', key: 'international|sv1-001', page: 1, position: 1}], unused: 1});
	});
});

describe('the form\'s defaults', () => {
	test('the Pokédex numbers a hand-made binder shows', () => {
		const dex = handDex([
			holding(1, 1, 'c4'),
			{page: 1, placed_at: at(1), position: 2, want: {card_id: null, catalog: null, dex: 152, image: null, name: 'Chikorita', variant_id: null}},
			{page: 1, placed_at: at(1), position: 3, want: {card_id: 'tst1-007', catalog: 'international', image: null, name: 'Test Splash', variant_id: null}},
			{empty: true, page: 1, placed_at: at(1), position: 4},
		], {cardDex: (catalog, cardId) => (cardId === 'tst1-007' ? [7] : []), copyDex: (id) => (id === 'c4' ? [4] : [])});

		assert.deepEqual([...dex].sort((a, b) => a - b), [4, 7, 152]);
	});

	test('the checklist guessed: the best match of its Pokémon, then the smaller list, then the person\'s order', () => {
		const kanto = {dex: Array.from({length: 151}, (_, i) => i + 1), id: 'kanto'};
		const every = {dex: Array.from({length: 1025}, (_, i) => i + 1), id: 'every'};
		const johto = {dex: Array.from({length: 100}, (_, i) => i + 152), id: 'johto'};

		assert.equal(guessChecklist([every, kanto, johto], new Set([1, 4, 7, 25])), 'kanto');
		assert.equal(guessChecklist([every, kanto, johto], new Set([1, 152, 155, 158])), 'johto');
		// Mostly Kanto with a Johto card: Kanto, though every Pokémon holds both.
		assert.equal(guessChecklist([every, kanto, johto], new Set([1, 4, 7, 25, 152])), 'kanto');
		// Pokémon from every region: the list of every Pokémon.
		assert.equal(guessChecklist([every, kanto, johto], new Set(every.dex.slice(0, 600))), 'every');
		// A short list that holds a few of a big binder's Pokémon loses.
		assert.equal(guessChecklist([{dex: [1, 4, 7], id: 'starters'}, kanto], new Set(kanto.dex.slice(0, 100))), 'kanto');
		assert.equal(guessChecklist([{dex: [1, 2], id: 'a'}, {dex: [1, 3], id: 'b'}], new Set([1])), 'a');
		assert.equal(guessChecklist([kanto], new Set()), null);
		assert.equal(guessChecklist([], new Set([1])), null);
	});

	test('the name: the hand-made binder\'s, marked, within 80 characters', () => {
		assert.equal(listBinderName('Kanto'), 'Kanto (list)');
		assert.equal(listBinderName('  Johto  '), 'Johto (list)');
		assert.equal(listBinderName('x'.repeat(80)).length, 80);
		assert.ok(listBinderName('x'.repeat(80)).endsWith(' (list)'));
	});

	test('the words before and after', () => {
		assert.equal(convertPreview({outside: 0, picks: [{}, {}], unused: 0}, 'Kanto'), '2 pockets show the card you chose in Kanto.');
		assert.equal(convertPreview({outside: 2, picks: [{}], unused: 1}, 'Kanto'), '1 pocket shows the card you chose in Kanto. 1 card shares a pocket with an earlier card and is not used. 2 cards are not on this list.');
		assert.equal(convertPreview({outside: 3, picks: [], unused: 0}, 'Kanto'), 'None of the cards in Kanto fit this list, so every pocket shows its default copy.');
		assert.equal(convertDoneText({name: 'Kanto (list)', picks: [{}, {}, {}], unused: 0}, 'Kanto'), 'Made Kanto (list): 3 pockets keep the card you chose. Kanto is unchanged; delete it when you are happy with the new one.');
		assert.equal(convertDoneText({name: 'Kanto (list)', picks: [{}], unused: 2}, 'Kanto'), 'Made Kanto (list): 1 pocket keeps the card you chose (2 more cards shared a pocket and were not used). Kanto is unchanged; delete it when you are happy with the new one.');
		assert.equal(convertDoneText({name: 'Kanto (list)', picks: [], unused: 0}, 'Kanto'), 'Made Kanto (list): no pocket kept a card you chose. Kanto is unchanged; delete it when you are happy with the new one.');
	});
});

describe('the picks and older phones', () => {
	// The picks a conversion saves, as js/binders.js createGeneratedBinder
	// writes them.
	const picks = handPicks([holding(1, 1, 'c1b'), holding(1, 2, 'c4')], ITEMS).picks
		.map((pick) => pickEntry({at: at(5), binderId: 'g1', entryId: pick.entryId, key: pick.key}));
	const generated = {art: [], cols: 3, cover_color: '#1d2e60', created_at: at(5), deleted_at: null, id: 'g1', name: 'Kanto (list)', notes: '', page_count: 1, rows: 3, rule: {order: 'dex', source: {id: 'kanto', kind: 'checklist'}}, slots: [], snapshot: {at: at(5), keys: ['dex:1', 'dex:4', 'dex:7', 'dex:25'], rule_key: 'checklist:kanto|dex', shown: {'dex:1': 'c1a', 'dex:4': 'c4', 'dex:7': 'c7'}}, updated_at: at(5)};
	const mine = {binder_picks: picks, binders: [generated], cards: []};
	// A phone that has not seen the conversion yet, with an edit of its own.
	const theirs = {binders: [{...generated, id: 'other', rule: undefined, snapshot: undefined}], cards: []};

	for (const [label, merge] of [['this version', mergeDocuments], ['v47', mergeV47], ['v21, before binder_picks existed', mergeV21]]) {
		test(`a merge on ${label} keeps every pick, whichever side it starts from`, () => {
			for (const merged of [merge(mine, theirs), merge(theirs, mine)]) {
				assert.deepEqual(Object.fromEntries(picksOf(merged.binder_picks, 'g1')), {'dex:1': 'c1b', 'dex:4': 'c4'});
			}
		});
	}
});
