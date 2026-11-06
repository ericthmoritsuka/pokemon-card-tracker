// Unit tests for "Lay out from a list" (js/binder-layout.js, with the
// pocket writes in js/binders.js and the fill in js/placeholder-fill.js;
// Eric, 2026-11-06): which empty pockets take the list's Pokémon and in
// what order, Pokémon already in the binder skipped, what does not fit and
// the pages offered for it, copies owned filling their placeholders in the
// same change (in the list's languages), Undo, and a Pokémon's placeholder
// merged with a phone still on an older app (the frozen v47 merge in
// tests/v47/merge.js) and with this one. Plain Node, invented data, and
// nothing is requested.
//
// Run: node --test tests/binder-layout.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {fakeIndexedDb} from './fake-indexeddb.mjs';

// js/collection.js reaches window when it loads.
globalThis.window = globalThis.window || globalThis;
globalThis.addEventListener = globalThis.addEventListener || (() => {});
globalThis.indexedDB = fakeIndexedDb();
globalThis.BroadcastChannel = undefined;
globalThis.fetch = async (url) => {
	throw new Error(`No requests in this test (${url}).`);
};

const binders = await import('../js/binders.js');
const fill = await import('../js/placeholder-fill.js');
const layout = await import('../js/binder-layout.js');
const {mergeDocuments} = await import('../js/merge.js');
const v47 = await import('./v47/merge.js');

const at = (minute) => `2026-11-06T10:${String(minute).padStart(2, '0')}:00.000Z`;

const copy = (id, cardId, fields = {}) => ({card_id: cardId, catalog: 'international', created_at: at(0), deleted_at: null, id, language: 'en', updated_at: at(0), ...fields});

const hand = (id, slots = [], fields = {}) => ({art: [], cols: 2, cover_color: '#1b1b1f', created_at: at(0), deleted_at: null, id, name: `Binder ${id}`, notes: '', page_count: 2, rows: 2, slots, updated_at: at(0), ...fields});

const holding = (page, position, entryId) => ({entry_id: entryId, page, placed_at: at(1), position});

const cardWant = (page, position, cardId) => ({page, placed_at: at(1), position, want: {card_id: cardId, catalog: 'international', image: null, name: null, variant_id: null}});

const item = (dex, copies = []) => ({copies, dex, name: `Mon ${dex}`});

// A list read: items with the copies in its languages, anyItems with every
// language's, and the card index's records for card placeholders.
const loadedOf = (items, {anyItems = null, index = new Map(), languages} = {}) => ({anyItems, index, items, languages, partial: false});

const pocketsOf = (binder) => binders.slotsOf(binder).map((slot) => [slot.page, slot.position, slot.entry_id || (slot.want ? slot.want.card_id || `dex:${slot.want.dex}` : slot.empty ? 'empty' : '?')]);

describe('where the list goes', () => {
	test('after the last pocket in use, in reading order and Pokédex order; filled and empty-on-purpose pockets never change', () => {
		// Page 1: a card, nothing, empty on purpose, nothing. Page 2: nothing.
		const binder = hand('b', [holding(1, 1, 'c9'), {empty: true, page: 1, placed_at: at(1), position: 3}]);
		const plan = layout.planListLayout(binder, [item(1), item(4), item(7), item(25)], {});

		assert.deepEqual(plan.pockets.map((pocket) => [pocket.page, pocket.position, pocket.want.dex]), [
			[1, 4, 1],
			[2, 1, 4],
			[2, 2, 7],
			[2, 3, 25],
		]);
		assert.deepEqual(plan.start, {page: 1, position: 4});
		assert.equal(plan.overflow, 0);
		assert.equal(plan.open, 5, 'pocket 2 of page 1 is before the last pocket in use');
	});

	test('from page 1, every empty pocket in reading order', () => {
		const binder = hand('b', [holding(1, 1, 'c9'), {empty: true, page: 1, placed_at: at(1), position: 3}]);
		const plan = layout.planListLayout(binder, [item(1), item(4), item(7)], {from: 'start'});

		assert.deepEqual(plan.pockets.map((pocket) => [pocket.page, pocket.position]), [[1, 2], [1, 4], [2, 1]]);
	});

	test('an empty binder starts at page 1, pocket 1', () => {
		const plan = layout.planListLayout(hand('b'), [item(152), item(155)], {});

		assert.deepEqual(plan.start, {page: 1, position: 1});
		assert.equal(plan.pockets.length, 2);
	});

	test('the placeholder is a Pokémon\'s: no card, the Pokédex number and name, and the list\'s languages when it names some', () => {
		const [pocket] = layout.planListLayout(hand('b'), [item(152)], {languages: ['en', 'pt']}).pockets;

		assert.deepEqual(pocket.want, {card_id: null, catalog: null, dex: 152, image: null, languages: ['en', 'pt'], name: 'Mon 152', variant_id: null});
		assert.equal(binders.isPokemonWant(pocket.want), true);
		assert.deepEqual(layout.planListLayout(hand('b'), [item(152)], {}).pockets[0].want, {card_id: null, catalog: null, dex: 152, image: null, name: 'Mon 152', variant_id: null});
	});
});

describe('Pokémon already in the binder are skipped', () => {
	test('a copy in a pocket (in any language), a Pokémon\'s placeholder, and a card placeholder whose card shows it', () => {
		const japanese = copy('c-ja', 'tst1-004', {language: 'ja'});
		const binder = hand('b', [
			holding(1, 1, 'c-ja'),
			{page: 1, placed_at: at(1), position: 2, want: layout.pokemonWant(item(7))},
			cardWant(1, 3, 'tst1-025'),
		]);
		// The list counts English only, so the Japanese copy is only in
		// anyItems.
		const items = [item(1), item(4), item(7), item(25), item(152)];
		const owned = [item(1), item(4, [japanese]), item(7), item(25), item(152)];
		const plan = layout.planListLayout(binder, items, {cardDex: (catalog, cardId) => (cardId === 'tst1-025' ? [25] : []), owned});

		assert.deepEqual(plan.pockets.map((pocket) => pocket.want.dex), [1, 152]);
		assert.equal(plan.present, 3);
		assert.equal(plan.missing, 2);
	});

	test('a copy of the Pokémon in another binder does not count', () => {
		const binder = hand('b');
		const plan = layout.planListLayout(binder, [item(1, [copy('c1', 'tst1-001')])], {placed: binders.placements([binder, hand('other', [holding(1, 1, 'c1')])])});

		assert.deepEqual(plan.pockets.map((pocket) => pocket.want.dex), [1]);
	});
});

describe('more Pokémon than empty pockets', () => {
	test('says how many did not fit and how many pages would make room, and adds them when asked', () => {
		// 2 x 2, 2 pages: 8 pockets, 1 in use.
		const binder = hand('b', [holding(1, 1, 'c9')]);
		const items = Array.from({length: 13}, (_, i) => item(i + 1));
		const plan = layout.planListLayout(binder, items, {});

		assert.equal(plan.pockets.length, 7);
		assert.equal(plan.overflow, 6);
		assert.equal(plan.morePages, 2);
		assert.equal(plan.pageCount, 2);
		assert.equal(layout.addPagesText(plan, 4), 'Add 2 pages so they fit (2 to 4 pages)');

		const more = layout.planListLayout(binder, items, {addPages: true});

		assert.equal(more.pockets.length, 13);
		assert.equal(more.overflow, 0);
		assert.equal(more.pageCount, 4);
		assert.deepEqual(more.pockets.slice(-2).map((pocket) => [pocket.page, pocket.position]), [[4, 1], [4, 2]]);
		assert.equal(layout.addPagesText(more, 4), '', 'nothing more to offer');
	});

	test('pages stop at the 200 a binder can have, and the rest is said', () => {
		// One pocket a page, 198 pages, the last one in use.
		const binder = hand('b', [holding(198, 1, 'c9')], {cols: 1, page_count: 198, rows: 1});
		const items = Array.from({length: 5}, (_, i) => item(i + 1));

		assert.equal(layout.addPagesText(layout.planListLayout(binder, items, {}), 1), 'Add 2 pages up to the 200 a binder can have (198 to 200 pages)');

		const plan = layout.planListLayout(binder, items, {addPages: true});

		assert.equal(plan.pageCount, binders.MAX_PAGES);
		assert.deepEqual(plan.pockets.map((pocket) => pocket.page), [199, 200]);
		assert.equal(plan.overflow, 3);
		assert.deepEqual(layout.previewLines({fill: true, fills: 0, plan}).slice(-2), [
			'2 pages added at the end: 198 to 200.',
			'3 Pokémon still do not fit: a binder has at most 200 pages.',
		]);

		const tight = layout.planListLayout(hand('t', [holding(200, 1, 'c9')], {cols: 1, page_count: 200, rows: 1}), items, {addPages: true});

		assert.equal(tight.pockets.length, 0);
		assert.equal(tight.overflow, 5);
		assert.equal(tight.morePages, 0);
		assert.deepEqual(layout.previewLines({fill: true, fills: 0, plan: tight}), ['5 Pokémon still do not fit: a binder has at most 200 pages.']);
	});
});

describe('the layout as one change, and the fill', () => {
	const cards = [
		copy('c1', 'tst1-001', {created_at: at(2)}),
		copy('c1-old', 'tst1-001', {created_at: at(1)}),
		copy('c152-pt', 'tst3-152', {language: 'pt'}),
		copy('c-placed', 'tst1-004'),
		copy('c-tray', 'tst3-155'),
	];
	const doc = () => ({
		binders: [
			hand('b', [holding(1, 1, 'c-placed')]),
			hand('t', [], {staged: ['c-tray']}),
		],
		cards,
		settings: {},
	});
	// English and Portuguese counted; the list's copies by Pokémon.
	const loaded = loadedOf([
		item(1, [cards[0], cards[1]]),
		item(4, [cards[3]]),
		item(152, [cards[2]]),
		item(155, [cards[4]]),
	], {languages: 'en,pt'});

	test('copies in no pocket and no tray go into their placeholders, the oldest first; one in a tray stays there', () => {
		const result = layout.layoutDraft(doc(), 'b', loaded, {at: at(10)});
		const [binder] = result.changed;

		assert.deepEqual(pocketsOf(binder), [
			[1, 1, 'c-placed'],
			[1, 2, 'c1-old'],
			[1, 3, 'c152-pt'],
			[1, 4, 'dex:155'],
		]);
		assert.equal(result.fills, 2);
		assert.deepEqual(result.done.wants.map((row) => [row.page, row.position, row.dex]), [[1, 2, 1], [1, 3, 152], [1, 4, 155]]);
		assert.deepEqual(result.done.fills.map((row) => [row.position, row.entryId]), [[2, 'c1-old'], [3, 'c152-pt']]);
		assert.deepEqual(layout.previewLines({fill: true, fills: result.fills, plan: result.plan}), [
			'3 placeholders on page 1, 2 filled with cards you own.',
			'Starting at page 1, pocket 2, the first empty pocket after the last one in use.',
			'1 Pokémon on the list is in this binder already and is skipped.',
		]);
	});

	test('with "Fill binder placeholders automatically" off, nothing fills', () => {
		const result = layout.layoutDraft({...doc(), settings: {fill_placeholders: false}}, 'b', loaded, {at: at(10)});

		assert.equal(result.fills, 0);
		assert.deepEqual(pocketsOf(result.changed[0]).map((row) => row[2]), ['c-placed', 'dex:1', 'dex:152', 'dex:155']);
		assert.match(layout.previewLines({fill: false, fills: 0, plan: result.plan}).join(' '), /is off in Profile/);
	});

	test('a binder from a list cannot be laid out', () => {
		const generated = {...hand('g'), rule: {order: 'dex', source: {id: 'x', kind: 'checklist'}}, snapshot: {at: at(0), keys: [], rule_key: 'checklist:x|dex', shown: {}}};

		assert.throws(() => layout.layoutDraft({binders: [generated], cards: []}, 'g', loaded), /made from a list/);
	});
});

describe('filling a Pokémon\'s placeholder later', () => {
	const spot = (position, want) => ({page: 1, placed_at: at(1), position, want});

	test('fillPlan fills it with a copy whose card shows the Pokémon, in the list\'s languages, and only with dexOf', () => {
		const list = [hand('b', [spot(1, layout.pokemonWant(item(25), ['en'])), spot(2, layout.pokemonWant(item(25)))])];
		const cards = [copy('c-pt', 'tst1-025', {created_at: at(1), language: 'pt'}), copy('c-en', 'tst2-025', {created_at: at(2)})];
		const dexOf = new Map([['c-pt', [25]], ['c-en', [25]]]);

		assert.deepEqual(fill.fillPlan({binders: list, cards}).rows, [], 'without the Pokédex numbers they wait');
		assert.equal(fill.fillPlan({binders: list, cards}).waiting, 2);

		const plan = fill.fillPlan({binders: list, cards}, {dexOf});

		assert.deepEqual(plan.rows.map((row) => [row.position, row.entryId, row.dex]), [[1, 'c-en', 25], [2, 'c-pt', 25]]);

		// fillPlaceholders writes them, checking the row's Pokémon.
		const result = binders.fillPlaceholders(list, plan.rows, {at: at(5)});

		assert.deepEqual(pocketsOf(result.changed[0]), [[1, 1, 'c-en'], [1, 2, 'c-pt']]);

		const wrong = binders.fillPlaceholders(list, [{...plan.rows[0], dex: 26}], {at: at(5)});

		assert.equal(wrong.done.length, 0, 'a row for another Pokémon is passed over');
	});

	test('a card\'s own placeholder chooses before a Pokémon\'s, in one binder and across binders; a second copy fills the Pokémon\'s', () => {
		const dexOf = new Map([['c1', [25]], ['c2', [25]]]);
		const mon = spot(1, layout.pokemonWant(item(25)));
		const card = {...cardWant(1, 2, 'sv1-25')};
		const one = [copy('c1', 'sv1-25')];

		assert.deepEqual(fill.fillPlan({binders: [hand('b', [mon, card])], cards: one}, {dexOf}).rows.map((row) => [row.position, row.entryId]), [[2, 'c1']]);

		// Binder a (the Pokémon's) comes first in the binder list.
		const across = [hand('a', [mon], {created_at: at(0)}), hand('b', [{...card, position: 1}], {created_at: at(1)})];

		assert.deepEqual(fill.fillPlan({binders: across, cards: one}, {dexOf}).rows.map((row) => [row.binderId, row.entryId]), [['b', 'c1']]);

		const two = [copy('c1', 'sv1-25'), copy('c2', 'sv1-25', {created_at: at(1)})];

		assert.deepEqual(fill.fillPlan({binders: [hand('b', [mon, card])], cards: two}, {dexOf}).rows.map((row) => [row.position, row.entryId, row.dex || null]), [[1, 'c2', 25], [2, 'c1', null]]);
	});

	test('hasPokemonWants tells whether the Pokédex numbers are needed at all', () => {
		assert.equal(fill.hasPokemonWants([hand('b', [cardWant(1, 1, 'tst1-001')])]), false);
		assert.equal(fill.hasPokemonWants([hand('b', [spot(1, layout.pokemonWant(item(1)))])]), true);
	});
});

describe('Undo', () => {
	const cards = [copy('c1', 'tst1-001')];
	const start = () => [hand('b', [holding(1, 1, 'c9')])];
	// Eight Pokémon for seven empty pockets: one goes on a page added.
	const loaded = loadedOf([item(1, [cards[0]]), item(4), item(7), item(25), item(152), item(155), item(158), item(161)]);

	// The layout saved: a page added, c1 in its placeholder.
	function laidOut() {
		const before = start();
		const result = layout.layoutDraft({binders: before, cards, settings: {}}, 'b', loaded, {addPages: true, at: at(10)});

		return {after: mergeDocuments({binders: before}, {binders: result.changed}).binders, result};
	}

	test('takes back every placeholder and copy it put in; the page it added stays, empty', () => {
		const {after, result} = laidOut();

		assert.equal(after[0].page_count, 3);
		assert.deepEqual(pocketsOf(after[0]).map((row) => row[2]), ['c9', 'c1', 'dex:4', 'dex:7', 'dex:25', 'dex:152', 'dex:155', 'dex:158', 'dex:161']);

		const undo = binders.undoLayOut(after, {...result.done, at: at(20)});
		const back = mergeDocuments({binders: after}, {binders: undo.changed}).binders;

		assert.equal(undo.back, 8);
		assert.equal(undo.kept, 0);
		assert.equal(back[0].page_count, 3, 'another phone may have placed a card on it that has not synced');
		assert.deepEqual(pocketsOf(back[0]), [[1, 1, 'c9']]);
		assert.deepEqual(binders.placements(back).has('c1'), false, 'c1 is in no pocket again');
		assert.equal(result.done.pagesAdded, 1);
		assert.equal(layout.undoText(undo, result.done), 'Taken back. The page it added stays, empty; remove it in Edit binder.');
		assert.equal(layout.undoText({kept: 2}, {pagesAdded: 0}), 'Taken back, but 2 pockets have changed since, so they stay as they are.');
		assert.equal(layout.undoText({kept: 0}, {pagesAdded: 0}), 'The binder is as it was.');
	});

	test('an earlier layout\'s Undo leaves the same Pokémon laid out again by a later one', () => {
		const one = loadedOf([item(25)]);
		const before = [hand('b')];
		const first = layout.layoutDraft({binders: before, cards: [], settings: {}}, 'b', one, {at: at(10)});
		const afterFirst = mergeDocuments({binders: before}, {binders: first.changed}).binders;

		// Taken out by hand, then laid out again later in the same pocket.
		const cleared = binders.setPocket(afterFirst, {at: at(12), binderId: 'b', content: null, page: 1, position: 1});
		const empty = mergeDocuments({binders: afterFirst}, {binders: cleared}).binders;
		const second = layout.layoutDraft({binders: empty, cards: [], settings: {}}, 'b', one, {at: at(14)});
		const afterSecond = mergeDocuments({binders: empty}, {binders: second.changed}).binders;

		assert.deepEqual(pocketsOf(afterSecond[0]), [[1, 1, 'dex:25']]);
		assert.notEqual(first.done.wants[0].placedAt, second.done.wants[0].placedAt);

		const stale = binders.undoLayOut(afterSecond, {...first.done, at: at(20)});

		assert.equal(stale.back, 0);
		assert.equal(stale.kept, 1);
		assert.deepEqual(stale.changed, []);

		const fresh = binders.undoLayOut(afterSecond, {...second.done, at: at(21)});

		assert.equal(fresh.back, 1);
	});

	test('a pocket changed since stays, and so does the page it is on', () => {
		const {after, result} = laidOut();
		// On another phone: the placeholder on page 3 became a card.
		const page3 = after[0].slots.find((slot) => slot.page === 3 && !slot.cleared);
		const edited = binders.setPocket(after, {at: at(15), binderId: 'b', content: {entry_id: 'c-other'}, page: page3.page, position: page3.position});
		const now = mergeDocuments({binders: after}, {binders: edited}).binders;
		const undo = binders.undoLayOut(now, {...result.done, at: at(20)});
		const back = mergeDocuments({binders: now}, {binders: undo.changed}).binders;

		assert.equal(undo.kept, 1);
		assert.equal(back[0].page_count, 3);
		assert.deepEqual(pocketsOf(back[0]), [[1, 1, 'c9'], [3, 1, 'c-other']]);
	});
});

describe('a Pokémon\'s placeholder and older phones', () => {
	// An older app (v47 to v61) places a card the way every app since v26
	// does: it edits a clone of the entry it has, which keeps any field and
	// slot it does not know, and stamps it (its own js/merge.js stampEntry,
	// frozen in tests/v47).
	function olderPlaces(list, entryId, page, position, minute) {
		const next = structuredClone(list[0]);

		next.slots.push({entry_id: entryId, page, placed_at: at(minute), position});
		next.updated_at = at(minute);

		return [v47.stampEntry(list[0], next)];
	}

	// The binder as this phone saves it after a layout, and as an older
	// phone saves it after placing a card in another pocket of the version
	// it had before the layout reached it.
	function bothSides() {
		const before = [hand('b', [holding(1, 1, 'c9')])];
		const laid = layout.layoutDraft({binders: before, cards: [], settings: {}}, 'b', loadedOf([item(25), item(152)]), {at: at(10)}).changed;
		const mine = mergeDocuments({binders: before}, {binders: laid}).binders;

		return {before, mine, older: olderPlaces(before, 'c-old', 2, 4, 12)};
	}

	const wants = (binder) => binder.slots.filter((slot) => slot.want && !slot.cleared).map((slot) => [slot.page, slot.position, slot.want]);

	test('an older phone\'s merge keeps it whole, beside its own new card', () => {
		const {mine, older} = bothSides();

		for (const [left, right] of [[mine, older], [older, mine]]) {
			const [binder] = v47.mergeDocuments({binders: left}, {binders: right}).binders;

			assert.deepEqual(wants(binder), [
				[1, 2, {card_id: null, catalog: null, dex: 25, image: null, name: 'Mon 25', variant_id: null}],
				[1, 3, {card_id: null, catalog: null, dex: 152, image: null, name: 'Mon 152', variant_id: null}],
			]);
			assert.ok(binder.slots.some((slot) => slot.entry_id === 'c-old'), 'the older phone\'s card stays');
		}
	});

	test('an older phone that has the layout keeps it when it places a card, on both merges', () => {
		const {mine} = bothSides();
		const older = olderPlaces(mine, 'c-later', 2, 3, 14);

		for (const merge of [v47.mergeDocuments, mergeDocuments]) {
			const [binder] = merge({binders: mine}, {binders: older}).binders;

			assert.deepEqual(wants(binder).map((row) => [row[0], row[1], row[2].dex]), [[1, 2, 25], [1, 3, 152]]);
			assert.ok(binder.slots.some((slot) => slot.entry_id === 'c-later'));
		}
	});

	test('this app\'s merge does the same', () => {
		const {mine, older} = bothSides();
		const [binder] = mergeDocuments({binders: mine}, {binders: older}).binders;

		assert.deepEqual(wants(binder).map((row) => [row[0], row[1], row[2].dex]), [[1, 2, 25], [1, 3, 152]]);
		assert.ok(binders.slotsOf(binder).some((slot) => slot.entry_id === 'c-old'));
	});

	test('an older app\'s fill and scanner never take it: it names no card', () => {
		const {mine} = bothSides();

		// What v47 to v61 read for the scanner's "Goes in" and their fill:
		// placeholders with a card id.
		assert.deepEqual(binders.placeholderList(mine), []);
		assert.deepEqual(binders.placeholdersFor(mine, 'international', null), []);
	});
});
