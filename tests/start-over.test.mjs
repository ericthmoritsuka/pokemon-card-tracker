// Unit tests for "Start over with this file" on the monprice import
// (js/start-over.js; DESIGN.md section 7, Eric, 2026-10-30): what the plan
// removes and adds, what it leaves alone (hand-made cards, card records),
// binders, list picks, and collections, the preview counts, Undo, and a
// failed save. Plain Node over an in-memory IndexedDB; invented data only,
// and nothing is requested.
//
// Run: node --test tests/start-over.test.mjs

import assert from 'node:assert/strict';
import {beforeEach, describe, test} from 'node:test';

import {fakeIndexedDb} from './fake-indexeddb.mjs';

// js/collection.js reaches window when it loads.
globalThis.window = globalThis.window || globalThis;
globalThis.addEventListener = globalThis.addEventListener || (() => {});

// The in-memory database, with a switch that makes every write fail: the
// put is never stored and the transaction aborts.
const fake = fakeIndexedDb();
let failWrites = false;

globalThis.indexedDB = {
	open(name) {
		const req = fake.open(name);
		const done = () => {
			const db = req.result;
			const transaction = db.transaction;

			db.transaction = (stores) => {
				const tx = transaction(stores);

				if (!failWrites) {
					return tx;
				}

				const objectStore = tx.objectStore;
				let complete = null;

				tx.objectStore = (store) => ({...objectStore(store), put: (value, key) => objectStore(store).get(key)});
				Object.defineProperty(tx, 'oncomplete', {
					get: () => (complete ? () => tx.onabort && tx.onabort() : null),
					set: (fn) => {
						complete = fn;
					},
				});

				return tx;
			};
		};

		let onsuccess = null;

		Object.defineProperty(req, 'onsuccess', {
			get: () => (onsuccess ? () => {
				done();
				onsuccess();
			} : null),
			set: (fn) => {
				onsuccess = fn;
			},
		});

		return req;
	},
};
globalThis.BroadcastChannel = undefined;
globalThis.fetch = async (url) => {
	throw new Error(`No requests in this test (${url}).`);
};

const collection = await import('../js/collection.js');
const {importEntries} = await import('../js/monprice.js');
const {isMember} = await import('../js/collections.js');
const {mergeDocuments, stableJson} = await import('../js/merge.js');
const {UNDO_DAYS, applyStartOver, planStartOver, planUndo, previewStartOver, savedUndo, startOverIds, undoStartOver} = await import('../js/start-over.js');

const at = (minute) => `2026-10-01T10:${String(minute).padStart(2, '0')}:00.000Z`;
const NOW = Date.parse('2026-10-30T12:00:00.000Z');
const HAND = `hand_${'b'.repeat(32)}`;

const card = (id, fields = {}) => ({card_id: `tst1-${id.slice(1)}`, catalog: 'international', created_at: at(0), deleted_at: null, id, language: 'pt', updated_at: at(0), ...fields});

const row = (number, count = 1) => ({
	cardId: `tst1-${number}`,
	catalog: 'international',
	row: {count, finish: 'NORMAL', language: 'pt', monpriceId: `tst1_int_${number}`, name: `Test card ${number}`, setName: 'Test set'},
	status: 'matched',
	variantId: 'normal',
});

const KEY = (number, copy = 0) => `monprice|tst1_int_${number}|pt|NORMAL|${copy}`;

// a001 is an earlier import of row 001, a002 a copy added in the app, a003
// a copy in the tray, the hand-made card stays, and row 003 was imported
// and deleted before (its tombstone holds the id the import would give).
async function startDoc() {
	const tombstoneId = await collection.importEntryId(KEY('003'));

	return {
		binder_picks: [{binder_id: 'g1', created_at: at(1), deleted_at: null, entry_id: 'a002', id: 'g1|tst1-002', key: 'tst1-002', updated_at: at(1)}],
		binders: [{
			art: [], cols: 3, cover_color: '#1b1b1f', created_at: at(0), deleted_at: null, id: 'b1', name: 'Binder', notes: '', page_count: 2, rows: 3,
			slots: [
				{entry_id: 'a001', page: 1, placed_at: at(2), position: 1},
				{entry_id: 'a002', page: 1, placed_at: at(2), position: 2},
				{entry_id: HAND, page: 1, placed_at: at(2), position: 3},
			],
			staged: ['a003'],
			updated_at: at(2),
		}],
		card_info: [{
			card_id: 'tst1-001', catalog: 'international', created_at: at(0), deleted_at: null, id: 'international~tst1-001~pt', language: 'pt',
			main_image: 'p1', notes: ['Bought at a fair'], photos: [{id: 'p1', path: 'u/p1/p1.webp'}], updated_at: at(3),
		}],
		cards: [
			card('a001', {import_key: KEY('001'), language_source: 'import'}),
			card('a002', {condition: 'Near Mint'}),
			card('a003'),
			{card_id: HAND, catalog: 'custom', created_at: at(0), deleted_at: null, id: HAND, language: 'pt', name_local: 'Hand card', updated_at: at(0)},
			card('a999', {card_id: 'tst1-003', deleted_at: at(1), id: tombstoneId, import_key: KEY('003'), updated_at: at(1)}),
		],
		collections: [{created_at: at(0), deleted_at: null, entry_ids: {a001: at(4), [HAND]: at(4)}, id: 'c1', kind: 'hand', name: 'Favorites', rule: null, updated_at: at(4)}],
		goals: [], openings: [], wishlist: [],
	};
}

const ENTRIES = importEntries([row('001'), row('003', 2)]);

async function started(doc = null) {
	const before = doc || await startDoc();
	const ids = await startOverIds(before.cards, ENTRIES);

	return {before, ids, plan: planStartOver(before, ENTRIES, {ids, now: NOW})};
}

const live = (doc) => doc.cards.filter((entry) => !entry.deleted_at);
const slotAt = (doc, position) => doc.binders[0].slots.find((slot) => slot.page === 1 && slot.position === position && !slot.cleared) || null;

describe('planStartOver', () => {
	test('every live copy goes except the hand-made card, and every matched row is added, a key with a tombstone included', async () => {
		const {before, plan} = await started();
		const {doc} = plan;
		const byId = new Map(doc.cards.map((entry) => [entry.id, entry]));

		for (const id of ['a001', 'a002', 'a003']) {
			assert.ok(byId.get(id).deleted_at, `${id} is removed`);
			assert.equal(byId.get(id).updated_at, byId.get(id).deleted_at, `${id} is a newer version, as deleteCards writes it, so the removal syncs`);
			assert.equal(byId.get(id).field_stamps.at, byId.get(id).updated_at);
		}

		assert.deepEqual(byId.get(HAND), before.cards[3], 'the hand-made card is untouched');
		assert.deepEqual(live(doc).filter((entry) => entry.id !== HAND).map((entry) => entry.import_key).sort(), [KEY('001'), KEY('003', 0), KEY('003', 1)]);

		const added = live(doc).filter((entry) => entry.import_key);

		const again = await startOverIds(before.cards, ENTRIES);

		assert.notEqual(added.find((entry) => entry.import_key === KEY('001')).id, await collection.importEntryId(KEY('001')), 'not the import id: another phone must not compute the same one');
		assert.ok(added.every((entry) => entry.id !== again.get(entry.import_key)), 'each Start over takes new random ids');
		assert.equal(new Set(doc.cards.map((entry) => entry.id)).size, doc.cards.length, 'no id is used twice');
		assert.ok(added.every((entry) => entry.language_source === 'import' && entry.variant_id === 'normal' && entry.name_local), 'added the way the import builds entries');
		assert.equal(stableJson(before), stableJson(await startDoc()), 'the document passed in is not changed');
	});

	test('unmatched rows are not added: only the entries of matched rows are', async () => {
		const results = [row('001'), {...row('005'), cardId: null, status: 'unmatched'}];
		const saved = results.filter((result) => result.status === 'matched' || result.status === 'fallback');
		const doc = await startDoc();
		const entries = importEntries(saved);
		const {counts} = planStartOver(doc, entries, {ids: await startOverIds(doc.cards, entries), now: NOW});

		assert.equal(counts.added, 1);
	});

	test('card records are untouched, so photos and notes show on the re-added cards', async () => {
		const {before, plan} = await started();

		assert.deepEqual(plan.doc.card_info, before.card_info);
		assert.equal(plan.counts.photos, 1);
	});

	test('the preview counts the removed copies whose own details are not copied over', async () => {
		const doc = await startDoc();
		const details = {
			a001: {grader: 'PSA', grade: '10', cert_number: '12345678'},
			a003: {is_favorite: true, price_manual: {avg: 600, currency: 'BRL', low_nm: 500}, storage: 'Slab box'},
		};

		doc.cards = doc.cards.map((entry) => ({...entry, ...details[entry.id]}));
		doc.cards.push(card('a004', {opening_id: 'o1'}), card('a005', {purchase_price: 350}), card('a006', {is_favorite: false, storage: null}));

		const {counts, doc: next} = planStartOver(doc, ENTRIES, {ids: await startOverIds(doc.cards, ENTRIES), now: NOW});

		assert.equal(counts.details, 5, 'a001 grade, a002 condition, a003 favorite, a004 opening, a005 price; a006 has none');
		assert.ok(live(next).every((entry) => !entry.grade && !entry.condition && !entry.is_favorite && !entry.storage), 'and nothing is carried to the added copies');
	});

	test('the preview lists the cards left with no copy, and the photos and notes their records keep', async () => {
		const rec = (catalog, cardId, language, n, notes = 'note') => ({
			card_id: cardId, catalog, created_at: at(0), deleted_at: null, id: `${catalog}~${cardId}~${language}`, language, main_image: `p${n}`, notes,
			photos: [{id: `p${n}`, path: `u/p${n}/p${n}.webp`}, {deleted_at: at(2), id: `x${n}`, path: `u/x${n}/x${n}.webp`}], updated_at: at(1),
		});
		const doc = {
			binders: [], card_info: [rec('international', 'tst1-001', 'ja', 1), rec('international', 'tst1-777', 'pt', 2), rec('international', 'tst1-003', 'en', 3, ''), rec('international', 'tst1-004', 'pt', 4), rec('international', 'tst1-002', 'pt', 5)],
			cards: [
				card('a1', {card_id: 'tst1-001', fallback: true, language: 'ja', name_local: 'Old fallback'}),
				card('a2', {card_id: 'tst1-777', language_source: 'manual'}),
				card('a3', {card_id: 'tst1-003', language: 'en', language_source: 'manual'}),
				card('a4', {card_id: 'tst1-004'}),
				card('a5', {card_id: 'tst1-004'}),
				card('a6', {card_id: 'tst1-002'}),
			],
			collections: [], goals: [], openings: [], wishlist: [],
		};
		const entries = importEntries([{...row('001'), catalog: 'jp', row: {...row('001').row, language: 'ja'}}, row('002'), row('003')]);
		const {counts} = planStartOver(doc, entries, {ids: await startOverIds(doc.cards, entries), now: NOW});

		assert.deepEqual(counts.gone, [
			{card_id: 'tst1-001', catalog: 'international', copies: 1, language: 'ja', name: 'Old fallback'},
			{card_id: 'tst1-003', catalog: 'international', copies: 1, language: 'en', name: null},
			{card_id: 'tst1-004', catalog: 'international', copies: 2, language: 'pt', name: null},
			{card_id: 'tst1-777', catalog: 'international', copies: 1, language: 'pt', name: null},
		], 'tst1-002 comes back; the fallback, the hand-corrected card and language, and the card not in the file do not');
		assert.equal(counts.hiddenPhotos, 4, 'live photos only, on the four records no copy shows');
		assert.equal(counts.hiddenNotes, 3, 'the records with a note');
		assert.equal(counts.photos, 1, 'photos kept counts only the records a copy shows');
	});

	test('pockets become placeholders, the tray drops removed copies, picks go back to the default, collections drop them', async () => {
		const {plan} = await started();
		const {doc} = plan;

		assert.deepEqual(slotAt(doc, 1).want, {card_id: 'tst1-001', catalog: 'international', image: null, name: null, variant_id: null});
		assert.equal(slotAt(doc, 2).want.card_id, 'tst1-002');
		assert.equal(slotAt(doc, 3).entry_id, HAND, 'the hand-made card stays in its pocket');
		assert.deepEqual(doc.binders[0].staged, []);
		assert.ok(doc.binders[0].updated_at > at(2));
		assert.equal(doc.binder_picks[0].entry_id, null);
		assert.ok(!isMember(doc.collections[0], 'a001'));
		assert.ok(isMember(doc.collections[0], HAND));
	});

	test('the preview counts are what the plan writes', async () => {
		const {before, plan} = await started();
		const {counts, doc} = plan;
		const wasLive = new Set(live(before).map((entry) => entry.id));
		const removed = doc.cards.filter((entry) => entry.deleted_at && wasLive.has(entry.id)).length;
		const added = live(doc).filter((entry) => !before.cards.some((old) => old.id === entry.id)).length;
		const pockets = doc.binders[0].slots.filter((slot) => slot.want).length;

		assert.deepEqual({...counts, details: 0, gone: [], hiddenNotes: 0, hiddenPhotos: 0}, {added, details: 0, gone: [], hiddenNotes: 0, hiddenPhotos: 0, photos: 1, pockets, removed});
		assert.deepEqual(counts, {added: 3, details: 1, gone: [{card_id: 'tst1-002', catalog: 'international', copies: 1, language: 'pt', name: null}], hiddenNotes: 0, hiddenPhotos: 0, photos: 1, pockets: 2, removed: 3});
	});
});

describe('planUndo', () => {
	test('puts back exactly what Start over changed', async () => {
		const {before, plan} = await started();
		const {doc} = planUndo(plan.doc, plan.undo, {now: NOW + 1000});
		const byId = new Map(doc.cards.map((entry) => [entry.id, entry]));

		assert.deepEqual(live(doc).map((entry) => entry.id).sort(), live(before).map((entry) => entry.id).sort());
		assert.equal(byId.get('a002').condition, 'Near Mint');
		assert.ok(byId.get('a001').restored_at, 'restored on purpose, so the merge keeps it over the tombstone');
		assert.ok(plan.undo.added.every((id) => byId.get(id).deleted_at), 'the added copies are removed');
		assert.deepEqual(doc.binders[0].slots.filter((slot) => !slot.cleared).map((slot) => [slot.position, slot.entry_id]), [[1, 'a001'], [2, 'a002'], [3, HAND]]);
		assert.deepEqual(doc.binders[0].staged, ['a003']);
		assert.equal(doc.binder_picks[0].entry_id, 'a002');
		assert.ok(isMember(doc.collections[0], 'a001'));
		assert.deepEqual(doc.card_info, before.card_info);
	});

	test('leaves what another phone changed since, and empties a pocket holding an added copy', async () => {
		const {plan} = await started();
		const doc = structuredClone(plan.doc);
		const addedId = plan.undo.added[0];
		const later = '2026-10-30T13:00:00.000Z';
		const binder = doc.binders[0];

		// Another phone: pocket 2 left empty on purpose, an added copy placed
		// in pocket 4, a new pick, and a003 put in the collection by hand.
		binder.slots = binder.slots.filter((slot) => slot.position !== 2);
		binder.slots.push({empty: true, page: 1, placed_at: later, position: 2}, {entry_id: addedId, page: 1, placed_at: later, position: 4});
		doc.binder_picks[0] = {...doc.binder_picks[0], entry_id: addedId, updated_at: later};
		doc.cards = doc.cards.map((entry) => (entry.id === 'a002' ? {...entry, deleted_at: later, updated_at: later} : entry));

		const undone = planUndo(doc, plan.undo, {now: NOW + 1000}).doc;
		const byId = new Map(undone.cards.map((entry) => [entry.id, entry]));

		assert.equal(slotAt(undone, 1).entry_id, 'a001');
		assert.ok(slotAt(undone, 2).empty, 'the pocket another phone changed stays as it is');
		assert.equal(slotAt(undone, 4), null, 'the pocket holding an added copy is emptied');
		assert.equal(undone.binder_picks[0].entry_id, addedId, 'the pick another phone made stays');
		assert.ok(byId.get('a002').deleted_at, 'a copy deleted again since is not brought back');
	});
});

// Two phones of one person: tests the merge with random ids for the added
// copies (js/merge.js collapseImportDuplicates folds two runs by import_key).
describe('two phones', () => {
	const two = () => ({
		binders: [], card_info: [],
		cards: [card('a1', {card_id: 'tst1-001'}), card('a2', {card_id: 'tst1-002'})],
		collections: [], goals: [], openings: [], wishlist: [],
	});
	const rows = importEntries([row('001'), row('002')]);
	const run = async (doc, now) => planStartOver(doc, rows, {ids: await startOverIds(doc.cards, rows), now});
	const liveIds = (doc) => live(doc).map((entry) => entry.id).sort();
	const liveKeys = (doc) => live(doc).map((entry) => entry.import_key).sort();

	test('(a) both start over from the same document: one copy per row after the merge, either way round', async () => {
		const a = await run(two(), NOW);
		const b = await run(two(), NOW + 60000);

		for (const merged of [mergeDocuments(a.doc, b.doc), mergeDocuments(b.doc, a.doc)]) {
			assert.deepEqual(liveKeys(merged), [KEY('001'), KEY('002')]);
		}

		assert.deepEqual(liveIds(mergeDocuments(a.doc, b.doc)), liveIds(mergeDocuments(b.doc, a.doc)), 'both phones agree');
	});

	test('(b) A starts over and undoes, B, not synced yet, starts over: B\'s copies stay', async () => {
		const a = await run(two(), NOW);
		const undone = planUndo(a.doc, a.undo, {now: NOW + 1000}).doc;
		const b = await run(two(), NOW + 3600000);

		assert.deepEqual(liveIds(undone), ['a1', 'a2']);

		for (const merged of [mergeDocuments(undone, b.doc), mergeDocuments(b.doc, undone)]) {
			assert.deepEqual(liveIds(merged), liveIds(b.doc));
			assert.deepEqual(liveKeys(merged), [KEY('001'), KEY('002')]);
		}
	});

	test('(c) A starts over, B still holds the old copy and edits it later: the removal wins', async () => {
		const a = await run(two(), NOW);
		const stale = two();

		stale.cards[0] = {...stale.cards[0], condition: 'Played', updated_at: new Date(NOW + 7200000).toISOString()};

		assert.deepEqual(liveIds(mergeDocuments(stale, a.doc)), liveIds(a.doc));
	});

	test('Undo after both runs merged keeps the copy the other run was folded into', async () => {
		const a = await run(two(), NOW);
		const b = await run(two(), NOW + 60000);
		const merged = mergeDocuments(a.doc, b.doc);
		const {doc} = planUndo(merged, a.undo, {now: NOW + 120000});

		assert.equal(live(doc).length, 2, 'never zero copies');
	});
});

describe('saving', () => {
	beforeEach(async () => {
		failWrites = false;

		const doc = await collection.loadDocument();

		for (const key of Object.keys(doc)) {
			if (Array.isArray(doc[key])) {
				doc[key].length = 0;
			}
		}

		Object.assign(doc, structuredClone(await startDoc()));
	});

	test('the preview, the apply, and Undo go through the document on screen', async () => {
		const doc = await collection.loadDocument();
		const preview = await previewStartOver(ENTRIES);
		const {counts, undo} = await applyStartOver(ENTRIES);

		assert.deepEqual(preview, counts);
		assert.equal(await collection.loadDocument(), doc, 'the same object, with the new content');
		assert.equal(doc.cards.filter((entry) => !entry.deleted_at).length, 4);
		assert.equal(doc.card_info.length, 1);
		assert.deepEqual(doc.card_info[0].photos.map((photo) => photo.id), ['p1']);

		const kept = await savedUndo();

		assert.deepEqual(kept.undo, undo, 'the undo is kept beside the document, so leaving the screen does not lose it');
		assert.deepEqual(kept.counts, counts);
		assert.equal(await savedUndo({now: Date.parse(kept.at) + (UNDO_DAYS * 24 + 1) * 3600000}), null, `offered for ${UNDO_DAYS} days`);

		const back = await undoStartOver(undo);

		assert.deepEqual(back, {added: 3, restored: 3});
		assert.equal(await savedUndo(), null, 'used once');
		assert.deepEqual(live(doc).map((entry) => entry.id).sort(), ['a001', 'a002', 'a003', HAND].sort());
	});

	test('a kept undo is offered only to the account that started over, and a second Start over replaces it', async () => {
		const doc = await collection.loadDocument();

		doc.user_id = 'u1';

		const first = await applyStartOver(ENTRIES);
		const second = await applyStartOver(ENTRIES);

		assert.deepEqual((await savedUndo()).undo, second.undo);
		assert.notDeepEqual(first.undo.added, second.undo.added);
		doc.user_id = 'u2';
		assert.equal(await savedUndo(), null);
		doc.user_id = 'u1';
		await undoStartOver(second.undo);
		delete doc.user_id;
	});

	test('a failed save leaves the document on screen unchanged', async () => {
		const doc = await collection.loadDocument();
		const before = stableJson(doc);

		failWrites = true;
		await assert.rejects(applyStartOver(ENTRIES));
		failWrites = false;
		assert.equal(stableJson(await collection.loadDocument()), before);
		assert.equal(await collection.loadDocument(), doc);
	});
});
