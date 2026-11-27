// Unit tests for the listing invariant, client half (js/listing-invariant.js,
// plans/roadmap.md "Backlog: preventing wrong listings"): a copy that is not
// an owned, live copy is 'missing', one a binder holds is 'held', and the
// only copy of its card, language, and finish is 'last'; an unset finish
// never pairs with Normal; a copy marked For sale is exempt from 'held' and
// 'last', as js/shop.js shopGroups already lists it. Invented cards; no
// browser, nothing leaves the machine.
//
// Run: node --test tests/listing-invariant.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {listingProblems} from '../js/listing-invariant.js';
import {listingRows, shopGroups} from '../js/shop.js';
import {heldCopies} from '../js/binders.js';

const copy = (id, fields = {}) => ({card_id: 'sv10-001', catalog: 'international', created_at: `2026-11-0${id.length}T00:00:00Z`, deleted_at: null, id, language: 'pt', ...fields});
const asObject = (map) => Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b)));

// Two list binders that both stored copy 'a' (tests/shop.test.mjs).
const KEY = 'international|sv10-001';
const list = (id, created, key, shown) => ({cols: 3, created_at: created, deleted_at: null, id, name: id, page_count: 1, rows: 3, rule: {order: 'dex', source: {id, kind: 'checklist'}}, slots: [], snapshot: {at: created, keys: [key], rule_key: 'x', shown: {[key]: shown}}, updated_at: created});
const BINDERS = [list('Hoenn', '2026-10-01T00:00:00Z', 'dex:906', 'a'), list('30 anos', '2026-10-05T00:00:00Z', KEY, 'a')];

describe('listingProblems', () => {
	test('a spare beside a kept copy keeps the invariant', () => {
		const doc = {binder_picks: [], binders: [], cards: [copy('a'), copy('bb')]};

		assert.deepEqual(asObject(listingProblems(doc, ['bb'])), {});
	});

	test('an id with no live copy is missing', () => {
		const doc = {binder_picks: [], binders: [], cards: [copy('a'), copy('bb', {deleted_at: '2026-11-20T00:00:00Z'})]};

		assert.deepEqual(asObject(listingProblems(doc, ['bb', 'zz'])), {bb: 'missing', zz: 'missing'});
	});

	test('the only copy of a finish is last: a lone reverse holo beside normals', () => {
		const doc = {binder_picks: [], binders: [], cards: [copy('a'), copy('bb'), copy('ccc', {finish_raw: 'Reverse Holofoil'})]};

		assert.deepEqual(asObject(listingProblems(doc, ['bb', 'ccc'])), {ccc: 'last'});
	});

	test('an unset finish never pairs with Normal', () => {
		const doc = {binder_picks: [], binders: [], cards: [copy('a'), copy('bb', {finish_raw: 'Normal'})]};

		assert.deepEqual(asObject(listingProblems(doc, ['a', 'bb'])), {a: 'last', bb: 'last'});
	});

	test('another language is another card', () => {
		const doc = {binder_picks: [], binders: [], cards: [copy('a'), copy('bb', {language: 'en'})]};

		assert.deepEqual(asObject(listingProblems(doc, ['bb'])), {bb: 'last'});
	});

	test('copies two list binders hold are held, the free third one is not', () => {
		const cards = [copy('a'), copy('bb'), copy('ccc')];
		const doc = {binder_picks: [], binders: BINDERS, cards};

		assert.deepEqual([...heldCopies(doc)].sort(), ['a', 'ccc']);
		assert.deepEqual(asObject(listingProblems(doc, ['a', 'bb', 'ccc'])), {a: 'held', ccc: 'held'});
	});

	test('a copy marked For sale is exempt from held and last, as the Shop already lists it, but not from missing', () => {
		const cards = [copy('a', {for_sale: true}), copy('bb', {language: 'en', for_sale: true})];
		const doc = {binder_picks: [], binders: BINDERS, cards};

		assert.deepEqual(asObject(listingProblems(doc, ['a', 'bb', 'gone'])), {gone: 'missing'});
		// The Shop's own groups list both marked copies, so the exemption
		// matches what was already listed.
		const rows = listingRows(shopGroups(cards.map((one) => ({...one, sale_price: 3})), {held: heldCopies(doc)}));

		assert.deepEqual(rows.map((row) => row.id).sort(), ['a', 'bb']);
	});

	test('every row the Shop would list for unmarked spares keeps the invariant', () => {
		const cards = [copy('a', {sale_price: 2}), copy('bb', {sale_price: 2}), copy('ccc', {sale_price: 2}), copy('dddd', {finish_raw: 'Reverse Holofoil', sale_price: 2})];
		const doc = {binder_picks: [], binders: [], cards};
		const ids = listingRows(shopGroups(cards, {held: heldCopies(doc)})).map((row) => row.id);

		assert.equal(ids.length, 2);
		assert.deepEqual(asObject(listingProblems(doc, ids)), {});
	});

	test('a batch never takes every copy of a finish: one of two loose copies stays home', () => {
		const doc = {binder_picks: [], binders: [], cards: [copy('a'), copy('bb')]};

		assert.deepEqual(asObject(listingProblems(doc, ['a', 'bb'])), {bb: 'last'});
	});

	test('a copy marked For sale leaves first, so the other copy of its finish stays home', () => {
		const doc = {binder_picks: [], binders: [], cards: [copy('a'), copy('bb', {for_sale: true})]};

		assert.deepEqual(asObject(listingProblems(doc, ['a', 'bb'])), {a: 'last'});
	});

	test('pure: no ids, an empty document, or no document give no problems or only missing', () => {
		assert.deepEqual(asObject(listingProblems({cards: []}, [])), {});
		assert.deepEqual(asObject(listingProblems(null, ['x'])), {x: 'missing'});
	});
});
