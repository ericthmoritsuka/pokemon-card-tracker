// Check spares (js/spare-check.js) and the free count the tile badge shows
// (js/shop.js freeCopyIds): where each copy is, why it counts as free or
// not, and the trades log entry that says a copy is gone. No browser.
//
// Run: node --test tests/spare-check.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {freeCopyIds} from '../js/shop.js';
import {REASONS, freeText, goneFields, placeLabel, placesOf, spareCheck} from '../js/spare-check.js';

const at = (minute) => `2026-11-25T10:${String(minute).padStart(2, '0')}:00.000Z`;

const card = (id, fields = {}) => ({card_id: 'sv8pt5-130', catalog: 'international', created_at: at(Number(id.replace(/\D/g, '')) || 0), deleted_at: null, id, language: 'pt', updated_at: at(0), variant_id: null, ...fields});

const binderOf = (id, fields = {}) => ({
	art: [],
	cols: 3,
	cover_color: '#1b1b1f',
	created_at: at(0),
	deleted_at: null,
	id,
	name: id,
	notes: '',
	page_count: 4,
	rows: 3,
	slots: [],
	updated_at: at(0),
	...fields,
});

const pocket = (entryId, page, position) => ({entry_id: entryId, page, placed_at: at(1), position});

// Eric's Scraggy (2026-11-25): three copies, one in the region binder, one in
// the 30 anos binder, one loose.
const scraggy = () => ({
	binders: [
		binderOf('Unova', {slots: [pocket('c1', 2, 4)]}),
		binderOf('30 anos', {slots: [pocket('c2', 1, 1)]}),
	],
	cards: [card('c1'), card('c2'), card('c3')],
});

describe('spareCheck', () => {
	test('three copies, two in pockets: one free, the loose one', () => {
		const [group] = spareCheck(scraggy());

		assert.equal(group.copies, 3);
		assert.equal(group.free, 1);
		assert.deepEqual(group.rows.map((row) => [row.entry.id, row.reason, row.free]), [['c3', 'spare', true], ['c1', 'pocket', false], ['c2', 'pocket', false]]);
		assert.deepEqual(group.rows[1].places, [{binder_id: 'Unova', binder_name: 'Unova', kind: 'pocket', page: 2, position: 4}]);
		assert.deepEqual(group.rows[0].places, []);
	});

	test('a copy in a tray is loose, so it is free (Eric, 2026-11-24)', () => {
		const doc = scraggy();

		doc.binders[0].staged = ['c3'];

		const [group] = spareCheck(doc);

		assert.equal(group.free, 1);
		assert.equal(placeLabel(group.rows[0].places[0]), 'Tray of Unova');
	});

	test('none in a pocket: the oldest is kept and the rest are free', () => {
		const [group] = spareCheck({binders: [], cards: [card('c1'), card('c2'), card('c3')]});

		assert.deepEqual(group.rows.map((row) => [row.entry.id, row.reason]), [['c2', 'spare'], ['c3', 'spare'], ['c1', 'kept']]);
		assert.equal(group.free, 2);
	});

	test('a spare taken off sale is not free; a copy marked For sale is, even in a pocket', () => {
		const doc = scraggy();

		doc.cards[2].for_sale = false;
		doc.cards[0].for_sale = true;

		const [group] = spareCheck(doc);
		const reasons = Object.fromEntries(group.rows.map((row) => [row.entry.id, row.reason]));

		assert.deepEqual(reasons, {c1: 'forSale', c2: 'pocket', c3: 'offSale'});
		assert.equal(group.free, 1);
	});

	test('a favorite card has no free copy', () => {
		const doc = scraggy();

		doc.cards[1].is_favorite = true;

		const [group] = spareCheck(doc);

		assert.equal(group.free, 0);
		assert.equal(group.rows.find((row) => row.entry.id === 'c3').reason, 'favorite');
	});

	test('languages are separate groups; a card with one copy in a language is left out unless only names it', () => {
		const doc = {binders: [], cards: [card('c1'), card('c2'), card('e1', {language: 'en'}), card('x1', {card_id: 'other-1'}), card('x2', {card_id: 'other-1', deleted_at: at(9)})]};

		assert.deepEqual(spareCheck(doc).map((group) => group.key), ['international|sv8pt5-130|pt']);
		assert.deepEqual(spareCheck(doc, {only: {card_id: 'sv8pt5-130', catalog: 'international'}}).map((group) => [group.language, group.copies, group.free]), [['pt', 2, 1], ['en', 1, 0]]);
		assert.deepEqual(spareCheck(doc, {only: {card_id: 'other-1'}}).map((group) => group.copies), [1], 'a deleted copy is gone');
	});

	test('groups with free copies come first', () => {
		const doc = {binders: [binderOf('A', {slots: [pocket('a1', 1, 1), pocket('a2', 1, 2)]})], cards: [card('a1', {card_id: 'held-1'}), card('a2', {card_id: 'held-1'}), card('c1'), card('c2')]};

		assert.deepEqual(spareCheck(doc).map((group) => [group.card_id, group.free]), [['sv8pt5-130', 1], ['held-1', 0]]);
	});

	test('the free count is the Shop\'s listed copies', () => {
		const doc = scraggy();

		assert.deepEqual([...freeCopyIds(doc.cards, {held: new Set(['c1', 'c2'])})], ['c3']);
		assert.deepEqual([...freeCopyIds(doc.cards)].sort(), ['c2', 'c3'], 'with nothing held, the oldest is kept');
	});
});

describe('placesOf', () => {
	test('a copy on top of a list binder\'s pocket is there; one two binders claim lists both', () => {
		const list = binderOf('Hoenn', {
			rule: {order: 'dex', source: {id: 'hoenn', kind: 'checklist'}},
			snapshot: {at: at(0), keys: ['', '', '', '', '', '', '', '', '', 'dex:559'], rule_key: 'x', shown: {'dex:559': 'c1'}},
		});
		const doc = {binder_picks: [], binders: [list, binderOf('30 anos', {slots: [pocket('c1', 1, 1)]})], cards: [card('c1'), card('c2')]};
		const places = placesOf(doc).get('c1');

		assert.deepEqual(places.map(placeLabel), ['30 anos, page 1, pocket 1', 'Hoenn, page 2, pocket 1']);
	});

	test('a copy in a pocket and still listed in a tray is in the pocket only', () => {
		const doc = {binders: [binderOf('A', {slots: [pocket('c1', 1, 1)], staged: ['c1', 'c2']})], cards: [card('c1'), card('c2')]};

		assert.deepEqual(placesOf(doc).get('c1').map((place) => place.kind), ['pocket']);
		assert.deepEqual(placesOf(doc).get('c2').map((place) => place.kind), ['tray']);
	});
});

describe('words', () => {
	test('freeText', () => {
		assert.equal(freeText(3, 1), '3 copies, 1 free');
		assert.equal(freeText(3, 0), '3 copies, none free');
		assert.equal(freeText(1, 1), '1 copy, free');
		assert.equal(freeText(1, 0), '1 copy, not free');
	});

	test('placeLabel', () => {
		assert.equal(placeLabel(null), 'Loose');
		assert.equal(placeLabel({binder_name: 'Hoenn', kind: 'pocket', page: 3, position: 4}), 'Hoenn, page 3, pocket 4');
	});

	test('every reason says whether it is free', () => {
		assert.deepEqual(Object.entries(REASONS).filter(([, reason]) => reason.free).map(([key]) => key), ['spare', 'forSale']);
	});

	test('goneFields: a gift, no money, today', () => {
		assert.deepEqual(goneFields('c3', {date: '2026-11-25'}), {date: '2026-11-25', kind: 'gift', note: 'Not found in Check spares', out: ['c3'], who: null});
	});
});
