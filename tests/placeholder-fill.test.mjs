// Unit tests for filling binder placeholders (js/placeholder-fill.js, with
// the batched pockets in js/binders.js) and the wishlist's Got it
// (js/wishlist.js): which copy goes where and in what order of preference,
// copies already in a pocket or a tray never moving, one copy per pocket,
// binders made from a list left alone, Undo after another phone's edit,
// the automatic fill after adding copies and the setting that turns it
// off, every path that adds copies going through the same helper, and a
// wish got, cleared, put back, and undone. Plain Node over an in-memory
// IndexedDB; invented data only, and nothing is requested.
//
// Run: node --test tests/placeholder-fill.test.mjs

import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {beforeEach, describe, test} from 'node:test';

import {fakeIndexedDb} from './fake-indexeddb.mjs';

// js/collection.js reaches window when it loads.
globalThis.window = globalThis.window || globalThis;
globalThis.addEventListener = globalThis.addEventListener || (() => {});
globalThis.indexedDB = fakeIndexedDb();
globalThis.BroadcastChannel = undefined;
globalThis.fetch = async (url) => {
	throw new Error(`No requests in this test (${url}).`);
};

const collection = await import('../js/collection.js');
const binders = await import('../js/binders.js');
const wishlist = await import('../js/wishlist.js');
const fill = await import('../js/placeholder-fill.js');
const {mergeDocuments} = await import('../js/merge.js');

const at = (minute) => `2026-10-31T10:${String(minute).padStart(2, '0')}:00.000Z`;

const copy = (id, fields = {}) => ({card_id: 'tst1-001', catalog: 'international', created_at: at(0), deleted_at: null, id, language: 'pt', updated_at: at(0), variant_id: 'normal', ...fields});

const want = (fields = {}) => ({card_id: 'tst1-001', catalog: 'international', image: null, name: null, variant_id: null, ...fields});

const hand = (id, slots = [], fields = {}) => ({art: [], cols: 3, cover_color: '#1b1b1f', created_at: at(0), deleted_at: null, id, name: `Binder ${id}`, notes: '', page_count: 2, rows: 3, slots, updated_at: at(0), ...fields});

const spot = (position, wanted = want(), page = 1) => ({page, placed_at: at(1), position, want: wanted});

const apply = (list, changed) => mergeDocuments({binders: list}, {binders: changed}).binders;

const holds = (list, binderId, position, page = 1) => {
	const slot = binders.pageSlots(list.find((binder) => binder.id === binderId), page, binders.placements(list)).get(position);

	return slot ? slot.entry_id || `want:${slot.want ? slot.want.card_id : '?'}` : null;
};

describe('fillPlan', () => {
	test('placeholders naming a finish and a language choose first, then a finish, then a language, then the rest, each the oldest copy', () => {
		const cards = [
			copy('c-normal-pt', {created_at: at(1)}),
			copy('c-reverse-pt', {created_at: at(2), variant_id: 'reverse'}),
			copy('c-reverse-en', {created_at: at(3), language: 'en', variant_id: 'reverse'}),
			copy('c-normal-en', {created_at: at(4), language: 'en'}),
			copy('c-normal-pt-2', {created_at: at(5)}),
		];
		// In page order: one asking for nothing, one for English, one for a
		// reverse holo, one for an English reverse holo.
		const list = [hand('b', [spot(1), spot(2, want({language: 'en'})), spot(3, want({variant_id: 'reverse'})), spot(4, want({language: 'en', variant_id: 'reverse'}))])];
		const plan = fill.fillPlan({binders: list, cards});

		assert.deepEqual(plan.rows.map((row) => [row.position, row.entryId]), [
			[1, 'c-normal-pt'],
			[2, 'c-normal-en'],
			[3, 'c-reverse-pt'],
			[4, 'c-reverse-en'],
		]);
		assert.equal(plan.waiting, 0);
		assert.equal(plan.binders, 1);
	});

	test('a placeholder whose finish no copy has takes another copy of the card, and the binder order decides who goes first', () => {
		const cards = [copy('c1', {created_at: at(2)}), copy('c2', {created_at: at(1)})];
		// Binder b was made first, so it comes first in the binder list.
		const list = [hand('a', [spot(1, want({variant_id: 'holo'}))], {created_at: at(2)}), hand('b', [spot(5)], {created_at: at(1)})];
		const plan = fill.fillPlan({binders: list, cards});

		assert.deepEqual(plan.rows.map((row) => [row.binderId, row.entryId]), [['b', 'c2'], ['a', 'c1']]);
	});

	test('the same card id in another catalog does not fit, and a placeholder with no catalog takes any', () => {
		const cards = [copy('c-ja', {catalog: 'ja', language: 'ja'}), copy('c-int')];
		const list = [hand('b', [spot(1, want({catalog: 'ja'})), spot(2, want({catalog: 'ko'})), spot(3, want({catalog: undefined}))])];
		const plan = fill.fillPlan({binders: list, cards});

		assert.deepEqual(plan.rows.map((row) => [row.position, row.entryId]), [[1, 'c-ja'], [3, 'c-int']]);
		assert.equal(plan.waiting, 1);
	});

	test('copies in a pocket or a tray never move; deleted copies and other cards are not offered', () => {
		const cards = [copy('c-placed'), copy('c-trayed'), copy('c-gone', {deleted_at: at(3)}), copy('c-other', {card_id: 'tst1-002'}), copy('c-free', {created_at: at(9)})];
		const list = [
			hand('b', [{entry_id: 'c-placed', page: 1, placed_at: at(1), position: 9}, spot(1), spot(2), spot(3)]),
			hand('t', [], {staged: ['c-trayed']}),
		];
		const plan = fill.fillPlan({binders: list, cards});

		assert.deepEqual(plan.rows.map((row) => row.entryId), ['c-free']);
		assert.equal(plan.waiting, 2, 'one copy per pocket: the other two wait');
	});

	test('a binder made from a list is a view: its pockets are never filled, and a copy it shows still counts as in no pocket', () => {
		const cards = [copy('c1')];
		const rule = {order: 'dex', source: {id: 'list-1', kind: 'checklist'}};
		const list = [
			hand('g', [spot(1)], {rule, snapshot: {at: at(0), keys: ['card:international|tst1-001'], rule_key: 'x', shown: {}}}),
			hand('h', [spot(2)]),
		];
		const plan = fill.fillPlan({binder_picks: [{binder_id: 'g', entry_id: 'c1', id: 'g|card:international|tst1-001', key: 'card:international|tst1-001'}], binders: list, cards});

		assert.deepEqual(plan.rows.map((row) => [row.binderId, row.entryId]), [['h', 'c1']]);

		const done = binders.fillPlaceholders(list, [{binderId: 'g', cardId: 'tst1-001', entryId: 'c1', page: 1, position: 1}], {at: at(5)});

		assert.deepEqual(done.changed, [], 'not even when asked directly');
	});

	test('only the copies just added, and only one binder, when asked', () => {
		const cards = [copy('old', {created_at: at(1)}), copy('new', {created_at: at(5)})];
		const list = [hand('a', [spot(1)]), hand('b', [spot(1)])];

		assert.deepEqual(fill.fillPlan({binders: list, cards}, {only: new Set(['new'])}).rows.map((row) => [row.binderId, row.entryId]), [['a', 'new']]);
		assert.deepEqual(fill.fillPlan({binders: list, cards}, {binderId: 'b'}).rows.map((row) => [row.binderId, row.entryId]), [['b', 'old']]);
	});
});

describe('filling and Undo', () => {
	test('thousands of pockets: one changed binder each, quickly, and every placeholder filled', () => {
		const pockets = 3000;
		const slots = Array.from({length: pockets}, (_, i) => spot((i % 9) + 1, want({card_id: `tst1-${String(i).padStart(4, '0')}`}), Math.floor(i / 9) + 1));
		const list = [hand('big', slots, {page_count: Math.ceil(pockets / 9)}), hand('small', [spot(1, want({card_id: 'tst1-0000'}))])];
		const cards = Array.from({length: pockets}, (_, i) => copy(`c${i}`, {card_id: `tst1-${String(i).padStart(4, '0')}`}));
		const started = performance.now();
		const plan = fill.fillPlan({binders: list, cards});
		const result = binders.fillPlaceholders(list, plan.rows, {at: at(5)});
		const ms = performance.now() - started;

		assert.equal(result.done.length, pockets);
		assert.equal(result.changed.length, 1, 'one copy of the big binder; the small one waits, its card went first');
		assert.ok(ms < 3000, `took ${Math.round(ms)} ms`);

		const after = apply(list, result.changed);

		assert.equal(binders.placements(after).size, pockets);
		assert.equal(holds(after, 'small', 1), 'want:tst1-0000');
	});

	test('Undo puts back only the pockets that still hold what the fill wrote, after another phone\'s edit synced', () => {
		let list = [hand('b', [spot(1), spot(2), spot(3)])];
		const cards = [copy('c1', {created_at: at(1)}), copy('c2', {created_at: at(2)}), copy('c3', {created_at: at(3)})];
		const filled = binders.fillPlaceholders(list, fill.fillPlan({binders: list, cards}).rows, {at: at(5)});

		list = apply(list, filled.changed);
		assert.deepEqual([1, 2, 3].map((n) => holds(list, 'b', n)), ['c1', 'c2', 'c3']);

		// Another phone, synced since: pocket 2 emptied, and c3 moved to
		// pocket 7.
		const other = binders.setPocket(list, {at: at(6), binderId: 'b', content: null, page: 1, position: 2});
		const moved = binders.setPocket(apply(list, other), {at: at(7), binderId: 'b', content: {entry_id: 'c3'}, page: 1, position: 7});

		list = apply(apply(list, other), moved);

		const back = binders.restorePlaceholders(list, filled.done, {at: at(8)});

		assert.deepEqual(back.done.map((row) => row.entryId), ['c1']);
		assert.deepEqual(back.passed.map((row) => row.entryId), ['c2', 'c3']);
		list = apply(list, back.changed);
		assert.deepEqual([1, 2, 3, 7].map((n) => holds(list, 'b', n)), ['want:tst1-001', null, null, 'c3']);
	});

	test('a copy placed or put in a tray between the plan and the save is passed over', () => {
		const list = [hand('b', [spot(1), spot(2)], {staged: ['c2']})];
		const rows = [
			{binderId: 'b', cardId: 'tst1-001', entryId: 'c2', page: 1, position: 1},
			{binderId: 'b', cardId: 'tst1-001', entryId: 'c1', page: 1, position: 2},
			{binderId: 'b', cardId: 'tst1-001', entryId: 'c1', page: 1, position: 1},
		];
		const result = binders.fillPlaceholders(list, rows, {at: at(5)});

		assert.deepEqual(result.done.map((row) => [row.position, row.entryId]), [[2, 'c1']]);
		assert.equal(result.passed.length, 2, 'the tray copy, and c1 a second time');
	});
});

// ---------------------------------------------------------------- saved

async function reset(settings = {}) {
	const doc = await collection.loadDocument();

	for (const key of Object.keys(doc)) {
		if (Array.isArray(doc[key])) {
			doc[key].length = 0;
		}
	}

	doc.settings = settings;
}

async function binderWithPlaceholders(n = 2, wanted = want()) {
	const binder = await binders.createBinder({cols: 3, cover_color: '#1b1b1f', name: 'Album', page_count: 2, rows: 3});

	for (let i = 1; i <= n; i++) {
		await binders.placePlaceholder(binder.id, 1, i, wanted);
	}

	return binder.id;
}

const pocketsOf = async (binderId) => {
	const list = (await collection.loadDocument()).binders;

	return [1, 2, 3].map((n) => holds(list, binderId, n));
};

describe('after adding copies', () => {
	beforeEach(() => reset());

	test('addCopies fills the waiting placeholders, and undoAdding puts them back', async () => {
		const binderId = await binderWithPlaceholders(2);
		const result = await fill.addCopies([{card_id: 'tst1-001', catalog: 'international', language: 'pt'}, {card_id: 'tst1-001', catalog: 'international', language: 'pt'}, {card_id: 'tst1-002', catalog: 'international', language: 'pt'}]);
		const ids = result.added.map((entry) => entry.id);

		assert.deepEqual(await pocketsOf(binderId), [ids[0], ids[1], null]);
		assert.equal(fill.afterText(result), '2 cards went into binders.');

		await fill.undoAdding(result);
		assert.deepEqual(await pocketsOf(binderId), ['want:tst1-001', 'want:tst1-001', null]);
	});

	test('a copy added while another is already in a pocket takes the next placeholder, never the placed copy\'s pocket', async () => {
		const binderId = await binderWithPlaceholders(2);
		const first = await fill.addCopies([{card_id: 'tst1-001', catalog: 'international', language: 'pt'}]);
		const second = await fill.addCopies([{card_id: 'tst1-001', catalog: 'international', language: 'pt'}]);

		assert.deepEqual(await pocketsOf(binderId), [first.added[0].id, second.added[0].id, null]);
	});

	test('the setting off: nothing is placed, Fill placeholders still works', async () => {
		await reset({fill_placeholders: false});

		const binderId = await binderWithPlaceholders(1);
		const result = await fill.addCopies([{card_id: 'tst1-001', catalog: 'international', language: 'pt'}]);

		assert.deepEqual(result.placed, []);
		assert.deepEqual(await pocketsOf(binderId), ['want:tst1-001', null, null]);

		const preview = await fill.previewFill({binderId});

		assert.equal(preview.rows.length, 1);

		const done = await fill.fillNow({binderId});

		assert.deepEqual(await pocketsOf(binderId), [result.added[0].id, null, null]);
		assert.equal(await fill.undoFill(done.done), 1);
		assert.deepEqual(await pocketsOf(binderId), ['want:tst1-001', null, null]);
	});

	test('fill: false and place: rows override the setting, as the scanner passes its own pockets', async () => {
		const binderId = await binderWithPlaceholders(2);
		const [entry] = await collection.addCards([{card_id: 'tst1-001', catalog: 'international', language: 'pt'}]);

		assert.deepEqual((await fill.afterAdding([entry], {fill: false})).placed, []);

		const chosen = await fill.afterAdding([entry], {place: [{binderId, cardId: 'tst1-001', entryId: entry.id, page: 1, position: 2}]});

		assert.deepEqual(chosen.placed.map((row) => row.position), [2]);
		assert.deepEqual(await pocketsOf(binderId), ['want:tst1-001', entry.id, null]);
	});

	test('Add cards to the tray: a card the binder has a placeholder for goes into it, the rest into the tray, and Undo takes both back', async () => {
		const binderId = await binderWithPlaceholders(1);
		const added = await collection.addCards([{card_id: 'tst1-001', catalog: 'international', language: 'pt'}, {card_id: 'tst1-002', catalog: 'international', language: 'pt'}]);
		const ids = added.map((entry) => entry.id);
		const result = await fill.addToBinder(binderId, ids, {fill: true});

		assert.deepEqual(result.placed.map((row) => row.entryId), [ids[0]]);
		assert.deepEqual(result.staged, [ids[1]]);
		assert.deepEqual(binders.stagedOf(await binders.getBinder(binderId)), [ids[1]]);

		await fill.undoAddToBinder(binderId, result);
		assert.deepEqual(await pocketsOf(binderId), ['want:tst1-001', null, null]);
		assert.deepEqual(binders.stagedOf(await binders.getBinder(binderId)), []);
	});

	test('the monprice import and the own CSV restore return the copies they added, for afterAdding', async () => {
		const counts = await collection.applyImport([{card_id: 'tst1-001', catalog: 'international', import_key: 'monprice|tst1_int_001|pt|NORMAL|0', language: 'pt', variant_id: 'normal'}]);

		assert.equal(counts.added, 1);
		assert.deepEqual(counts.entries.map((entry) => entry.import_key), ['monprice|tst1_int_001|pt|NORMAL|0']);

		const again = await collection.applyImport([{card_id: 'tst1-001', catalog: 'international', import_key: 'monprice|tst1_int_001|pt|NORMAL|0', language: 'pt', variant_id: 'normal'}]);

		assert.deepEqual(again.entries, [], 'a rerun adds nothing');
	});
});

describe('every path that adds copies goes through the helper', () => {
	// Each module that adds copies (addCard, addCards, applyImport,
	// applyOwnImport, or a Start over plan) must also call the helper, so a
	// future path cannot skip it silently: name the call that reaches it.
	const HELPER = /\b(addCopies|afterAdding|planAfterAdding|placeAdded|addToBinder)\(/;
	const ADDS = /\b(addCard|addCards|applyImport|applyOwnImport|planImport)\(/;
	// Where the add functions are defined or only re-exported, and the
	// helper itself.
	const DEFINES = new Set(['js/collection.js', 'js/placeholder-fill.js']);

	test('every caller of an add function in js/ calls the helper too', async () => {
		const files = [];

		async function walk(dir) {
			for (const item of await readdir(new URL(`../${dir}`, import.meta.url), {withFileTypes: true})) {
				if (item.isDirectory()) {
					await walk(`${dir}/${item.name}`);
				}
				else if (item.name.endsWith('.js')) {
					files.push(`${dir}/${item.name}`);
				}
			}
		}

		await walk('js');

		const callers = [];

		for (const file of files) {
			if (DEFINES.has(file)) {
				continue;
			}

			const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
			const code = text.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');

			if (ADDS.test(code)) {
				callers.push(file);
				assert.ok(HELPER.test(code), `${file} adds copies without the placeholder helper`);
			}
		}

		assert.deepEqual(callers.sort(), ['js/import-view.js', 'js/scan/view.js', 'js/start-over.js']);
	});

	test('the paths named by Eric each call it', async () => {
		const source = async (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
		const importView = await source('js/import-view.js');

		assert.match(importView, /applyImport\(saving\);\s*\/\/[^\n]*\n\s*placeAdded\(counts\.entries\)/, 'the monprice import, and a shared file through the same Save');
		assert.match(importView, /applyOwnImport\(parsed\.rows, \{revive\}\);\s*placeAdded\(counts\.entries\)/, 'the own CSV restore');
		assert.match(await source('js/start-over.js'), /planAfterAdding\(next, added/, 'Start over');
		assert.match(await source('js/copy-sheet.js'), /result = await addCopies\(/, 'Add a copy on the card page');
		assert.match(await source('js/copy-sheet.js'), /return addCopies\(Array\.from/, 'the copy steppers (addAlike)');
		assert.match(await source('js/custom-card-view.js'), /await addCopies\(customEntries/, 'hand-made cards');
		assert.match(await source('js/scan/view.js'), /afterAdding\(addedEntries, \{place: toPlace\}\)/, 'the scanner');
		assert.match(await source('js/binders-view.js'), /await addToBinder\(target\.id, ids\)/, 'Add cards to the tray');
	});
});

// ------------------------------------------------------------ wishlist

const wish = (id, fields = {}) => ({card_id: 'tst1-001', catalog: 'international', created_at: at(1), deleted_at: null, id, language: null, note: '', priority: 'normal', updated_at: at(1), variant_id: null, ...fields});

describe('wishlist Got it', () => {
	beforeEach(() => reset());

	test('a copy fits a wish by card and catalog, and by the language and finish the wish names', () => {
		const items = [
			wish('w-any'),
			wish('w-en', {language: 'en'}),
			wish('w-holo', {variant_id: 'holo'}),
			wish('w-ja', {catalog: 'ja'}),
			wish('w-got', {got_at: at(2), got_entry_id: 'x'}),
		];
		const {changed, marks} = wishlist.planGot(items, [copy('c1')], {now: Date.parse(at(5))});

		assert.deepEqual(changed.map((item) => item.id), ['w-any']);
		assert.equal(changed[0].got_entry_id, 'c1');
		assert.ok(changed[0].got_at >= at(5));
		assert.ok(changed[0].field_stamps.got_at, 'stamped, so the merge keeps it field by field');
		assert.deepEqual(marks, [{entry_id: 'c1', got_at: changed[0].got_at, id: 'w-any'}]);
	});

	test('got items leave the wanted list, the scanner\'s wants-this-card, and come back with Want again', () => {
		const items = [wish('w1', {got_at: at(2), got_entry_id: 'c1'}), wish('w2', {card_id: 'tst1-002'})];

		assert.deepEqual(wishlist.sortWishes(items).map((item) => item.id), ['w2']);
		assert.deepEqual(wishlist.sortGot(items).map((item) => item.id), ['w1']);
		assert.deepEqual(wishlist.wishedBy('tst1-001', {}, [{name: 'Member A', wishlist: items}]), []);

		const back = wishlist.wantedAgain(items[0], Date.parse(at(9)));

		assert.equal(back.got_at, null);
		assert.deepEqual(wishlist.sortWishes([back, items[1]]).map((item) => item.id).sort(), ['w1', 'w2']);
	});

	test('saved: adding a copy marks it got, Undo clears it only while the same copy still marks it', async () => {
		const item = await wishlist.addToWishlist('tst1-001', {catalog: 'international', language: 'pt'});
		const result = await fill.addCopies([{card_id: 'tst1-001', catalog: 'international', language: 'pt'}]);

		assert.equal(result.got.length, 1);
		assert.equal(fill.afterText(result), '1 wish moved to Got it.');
		assert.deepEqual((await wishlist.listWishlist()).map((one) => one.id), []);
		assert.deepEqual((await wishlist.listGotWishes()).map((one) => one.id), [item.id]);

		await fill.undoAdding(result);
		assert.deepEqual((await wishlist.listWishlist()).map((one) => one.id), [item.id]);
		assert.deepEqual(await wishlist.listGotWishes(), []);
	});

	test('Undo leaves a wish got again by another copy since', async () => {
		const item = await wishlist.addToWishlist('tst1-001');
		const first = await fill.addCopies([{card_id: 'tst1-001', catalog: 'international', language: 'en'}]);

		await wishlist.wantAgain(item.id);

		const second = await fill.addCopies([{card_id: 'tst1-001', catalog: 'international', language: 'pt'}]);

		await fill.undoAdding(first);
		assert.equal((await wishlist.getWish(item.id)).got_entry_id, second.added[0].id);
	});

	test('Clear removes a got item; Want again and Add to wishlist put it back to wanted', async () => {
		const item = await wishlist.addToWishlist('tst1-001');

		await fill.addCopies([{card_id: 'tst1-001', catalog: 'international', language: 'pt'}]);
		assert.ok((await wishlist.getWish(item.id)).got_at);

		await wishlist.wantAgain(item.id);
		assert.ok(!(await wishlist.getWish(item.id)).got_at);

		await fill.addCopies([{card_id: 'tst1-001', catalog: 'international', language: 'pt'}]);

		const again = await wishlist.addToWishlist('tst1-001');

		assert.equal(again.id, item.id, 'the same item, not a second one');
		assert.ok(!again.got_at, 'wanted again, as the family Want marks expect');

		await fill.addCopies([{card_id: 'tst1-001', catalog: 'international', language: 'pt'}]);
		await wishlist.removeWish(item.id);
		assert.equal(await wishlist.getWish(item.id), null);
		assert.deepEqual(await wishlist.listGotWishes(), []);
	});

	test('got_at merges like other fields: a got item and a priority edited on another phone both stay', () => {
		const base = wish('w1');
		const got = wishlist.gotWish(base, 'c1', Date.parse(at(5)));
		const edited = wishlist.editedWish(base, {priority: 'high'}, Date.parse(at(6)));
		const merged = mergeDocuments({wishlist: [got]}, {wishlist: [edited]}).wishlist[0];

		assert.equal(merged.got_entry_id, 'c1');
		assert.equal(merged.priority, 'high');
	});
});
