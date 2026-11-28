// One source of truth for held and free (plans/roadmap.md, "Backlog:
// preventing wrong listings"): Trade, Check spares, the tile's ×N | M
// badge, the binders, and the Shop agree, card by card, language by
// language, finish by finish, on the invented collection of
// tests/fixtures/collection-shape.mjs. No browser.
//
// Run: node --test tests/held-free.test.mjs

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {describe, test} from 'node:test';

import {heldCopies} from '../js/binders.js';
import {printedCode} from '../js/catalog.js';
import {copyState, freeEntries} from '../js/held-free.js';
import {freeCopyIds, listedOf, shopGroups} from '../js/shop.js';
import {placesOf, spareCheck} from '../js/spare-check.js';
import {copyFinishKey} from '../js/wishlist.js';
import {EXPECTED, collectionShape} from './fixtures/collection-shape.mjs';

const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const groupKey = (entry) => `${entry.card_id}|${entry.language}|${copyFinishKey(entry)}`;

// {held, free} Sets of ids -> card|language|finish -> {held, free}.
function counts(doc, {free, held}) {
	const out = {};

	for (const entry of doc.cards.filter((one) => !one.deleted_at)) {
		const row = out[groupKey(entry)] ||= {free: 0, held: 0};

		row.free += free.has(entry.id) ? 1 : 0;
		row.held += held.has(entry.id) ? 1 : 0;
	}

	return out;
}

// What each consumer reads, through the call it makes.
function consumers(doc) {
	const live = doc.cards.filter((entry) => !entry.deleted_at);
	// The Shop (js/shop-view.js): shopGroups over its cards with heldCopies.
	const shop = shopGroups(live, {codeOf: printedCode, held: heldCopies(doc)});
	// Check spares (js/spare-check.js): each row's free, and its pockets.
	const rows = spareCheck(doc, {codeOf: printedCode}).flatMap((group) => group.rows);
	const checked = new Set(rows.map((row) => row.entry.id));
	// The binders: the pockets placesOf finds, by binder.
	const pockets = new Set([...placesOf(doc)].filter(([, places]) => places.some((place) => place.kind === 'pocket')).map(([id]) => id));
	const state = copyState(doc);

	return {
		badge: {free: state.free, held: state.held},
		binders: {free: new Set(state.groups.flatMap(listedOf).map((entry) => entry.id)), held: pockets},
		check: {
			// A card with one copy in a language has no Check spares group,
			// so its copy counts as the group would: free only if marked.
			free: new Set([...rows.filter((row) => row.free).map((row) => row.entry.id), ...live.filter((entry) => !checked.has(entry.id) && state.free.has(entry.id)).map((entry) => entry.id)]),
			held: new Set([...rows.filter((row) => row.places.some((place) => place.kind === 'pocket')).map((row) => row.entry.id), ...live.filter((entry) => !checked.has(entry.id) && state.held.has(entry.id)).map((entry) => entry.id)]),
		},
		shop: {free: freeCopyIds(null, {groups: shop}), held: heldCopies(doc)},
		trade: {free: new Set(freeEntries(doc).map((entry) => entry.id)), held: heldCopies(doc)},
	};
}

describe('held and free on the collection shape', () => {
	test('the five consumers agree with each other and with the expected counts', () => {
		const doc = collectionShape();
		const all = consumers(doc);

		for (const [name, sets] of Object.entries(all)) {
			assert.deepEqual(counts(doc, sets), EXPECTED, `${name} disagrees`);
		}
	});

	test('the shapes that listed cards on 2026-11-26 stay home', () => {
		const {free, held} = copyState(collectionShape());

		assert.ok(!free.has('m4'), 'a lone reverse holo beside three normals is kept');
		assert.ok(held.has('t1') && held.has('t2') && !free.has('t1') && !free.has('t2'), 'a card two list binders show is held twice, never free');
		assert.ok(!free.has('u1') && !free.has('u2'), 'a copy with no finish set never pairs with Normal');
		assert.ok(!free.has('o2'), 'a spare taken off sale stays home');
		assert.ok(!free.has('f1') && !free.has('f2'), 'a favorite keeps every copy');
		assert.ok(free.has('s1'), 'a copy marked For sale is offered');
		assert.ok(free.has('r2') && !held.has('r1'), 'a tray is not a pocket');
		assert.ok(!held.has('k1') && !held.has('k2'), 'Keep the placeholder holds nothing');
	});

	// Keep this one too on Check spares (Eric, 2026-11-27) is the copy's
	// off-sale mark, so every consumer drops it from free at once.
	test('a spare kept too on Check spares leaves free on every consumer', () => {
		const doc = collectionShape();
		const before = copyState(doc).free;
		const id = [...before].find((one) => {
			const entry = doc.cards.find((card) => card.id === one);

			return entry && entry.for_sale !== true;
		});

		doc.cards.find((card) => card.id === id).for_sale = false;

		for (const [name, sets] of Object.entries(consumers(doc))) {
			assert.ok(!sets.free.has(id), `${name} still counts it free`);
			assert.equal(sets.free.size, before.size - 1, `${name} lost or gained another copy`);
		}
	});

	test('every screen reads held and free through js/held-free.js', () => {
		assert.match(source('js/trade-view.js'), /const docSpares = \(doc\) => freeEntries\(doc\);/);
		assert.match(source('js/cards-view.js'), /import \{copyState as heldAndFree\} from '\.\/held-free\.js';/);
		assert.match(source('js/cards-view.js'), /= heldAndFree\(doc\);/);
		assert.match(source('js/binders-view.js'), /copyState\(data\.doc, \{cards: data\.cards\}\)/);
		assert.match(source('js/spare-check.js'), /copyState\(doc/);
	});
});
