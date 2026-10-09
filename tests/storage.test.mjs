// Unit tests for where each copy is stored (DESIGN.md section 4, "Stored
// in"): the saved places in js/collection.js (added on first use, kept when
// no copy is in them, renamed and removed with every copy following, Undo),
// how the place list merges between phones with the existing js/merge.js,
// what an older app's save does to it, and the alike key that gives each
// place its own row. Plain Node over an in-memory IndexedDB; every card and
// place is invented, and nothing is requested.
//
// Run: node --test tests/storage.test.mjs

import assert from 'node:assert/strict';
import {beforeEach, describe, test} from 'node:test';

import {fakeIndexedDb} from './fake-indexeddb.mjs';

// js/collection.js reaches window when it loads.
globalThis.window = globalThis.window || globalThis;
globalThis.addEventListener = globalThis.addEventListener || (() => {});
globalThis.indexedDB = fakeIndexedDb();
// No other tabs here, and an open channel would keep Node running.
globalThis.BroadcastChannel = undefined;
globalThis.fetch = async (url) => {
	throw new Error(`No requests in this test (${url}).`);
};

const collection = await import('../js/collection.js');
const {mergeDocuments} = await import('../js/merge.js');

const COPY = {card_id: 'tst1-001', catalog: 'international', language: 'pt', language_source: 'manual', variant_id: 'normal'};

// The module keeps the document in memory; each test starts by emptying
// it, and its next save writes the empty start.
async function reset() {
	const doc = await collection.loadDocument();

	doc.cards.length = 0;
	delete doc.storage_places;
}

beforeEach(reset);

const places = async () => (await collection.listPlaces()).map(({count, name, saved}) => [name, count, saved]);

const storageOf = async (ids) => {
	const doc = await collection.loadDocument();

	return ids.map((id) => doc.cards.find((card) => card.id === id).storage ?? null);
};

const savedPlaces = async () => (await collection.loadDocument()).storage_places || [];

describe('saved places', () => {
	test('a place typed on one copy is saved, and another copy picks it in any case', async () => {
		const a = await collection.addCard(COPY);
		const b = await collection.addCard(COPY);

		await collection.updateCard(a.id, {storage: '  Bulk   box A  '});
		await collection.updateCard(b.id, {storage: 'bulk box a'});

		assert.deepEqual(await storageOf([a.id, b.id]), ['Bulk box A', 'Bulk box A'], 'the saved spelling wins');
		assert.deepEqual(await places(), [['Bulk box A', 2, true]]);
		assert.equal((await savedPlaces()).length, 1);
	});

	test('a place stays after the last copy leaves it, and Not set clears a copy', async () => {
		const a = await collection.addCard({...COPY, storage: 'Deck box'});

		assert.deepEqual(await places(), [['Deck box', 1, true]], 'adding a copy with a place saves it too');

		await collection.updateCard(a.id, {storage: ''});

		assert.deepEqual(await storageOf([a.id]), [null]);
		assert.deepEqual(await places(), [['Deck box', 0, true]]);
	});

	test('a long place is cut to 40 characters; most used first, then by name', async () => {
		const long = 'x'.repeat(60);
		const ids = [];

		for (const place of ['Drawer', 'Binder shelf', 'Binder shelf', long]) {
			ids.push((await collection.addCard({...COPY, storage: place})).id);
		}

		assert.equal(collection.STORAGE_MAX, 40);
		assert.equal((await storageOf([ids[3]]))[0].length, 40);
		assert.deepEqual((await places()).map(([name, count]) => [name.slice(0, 6), count]), [['Binder', 2], ['Drawer', 1], ['xxxxxx', 1]]);
	});

	test('rename changes every copy stored there, and Undo puts the old name back', async () => {
		const a = await collection.addCard({...COPY, storage: 'Box A'});
		const b = await collection.addCard({...COPY, storage: 'box a'});
		const c = await collection.addCard({...COPY, storage: 'Drawer'});
		const done = await collection.renamePlace('Box A', 'Shelf 1');

		assert.equal(done.changed, 2);
		assert.equal(done.name, 'Shelf 1');
		assert.deepEqual(await storageOf([a.id, b.id, c.id]), ['Shelf 1', 'Shelf 1', 'Drawer']);
		assert.deepEqual(await places(), [['Shelf 1', 2, true], ['Drawer', 1, true]]);

		const renamed = (await collection.loadDocument()).cards.find((card) => card.id === a.id);

		assert.equal(renamed.field_stamps.storage, renamed.updated_at, 'stamped as an edit, so it merges per field');

		await collection.undoStorage(done.undo);

		assert.deepEqual(await storageOf([a.id, b.id, c.id]), ['Box A', 'Box A', 'Drawer'], 'each copy as it was');
		assert.deepEqual(await places(), [['Box A', 2, true], ['Drawer', 1, true]]);
	});

	test('renamed to another saved place, the two become one', async () => {
		const a = await collection.addCard({...COPY, storage: 'Box A'});
		const b = await collection.addCard({...COPY, storage: 'Box B'});
		const done = await collection.renamePlace('Box A', 'box b');

		assert.equal(done.name, 'Box B');
		assert.deepEqual(await storageOf([a.id, b.id]), ['Box B', 'Box B']);
		assert.deepEqual(await places(), [['Box B', 2, true]]);

		await collection.undoStorage(done.undo);
		assert.deepEqual(await places(), [['Box A', 1, true], ['Box B', 1, true]]);
		await assert.rejects(collection.renamePlace('Box A', '   '), /needs a name/);
	});

	test('remove clears every copy stored there, and Undo brings place and copies back', async () => {
		const a = await collection.addCard({...COPY, storage: 'Box A'});
		const b = await collection.addCard({...COPY});
		const done = await collection.removePlace('Box A');

		assert.equal(done.changed, 1);
		assert.deepEqual(await storageOf([a.id, b.id]), [null, null]);
		assert.deepEqual(await places(), []);
		assert.ok((await savedPlaces())[0].deleted_at, 'a tombstone, so the removal syncs');

		await collection.undoStorage(done.undo);

		assert.deepEqual(await storageOf([a.id, b.id]), ['Box A', null]);
		assert.deepEqual(await places(), [['Box A', 1, true]]);
		assert.ok((await savedPlaces())[0].restored_at, 'brought back on purpose, so it wins over the tombstone');
	});

	test('a removed place typed again comes back as the same place', async () => {
		const a = await collection.addCard({...COPY, storage: 'Box A'});

		await collection.removePlace('Box A');
		await collection.updateCard(a.id, {storage: 'BOX A'});

		const saved = await savedPlaces();

		assert.equal(saved.length, 1);
		assert.equal(saved[0].deleted_at, null);
		assert.equal(saved[0].name, 'BOX A');
	});

	test('storing many copies at once, with Undo removing a place it made', async () => {
		const a = await collection.addCard({...COPY, storage: 'Drawer'});
		const b = await collection.addCard(COPY);
		const c = await collection.addCard(COPY);
		const done = await collection.setStorage([a.id, b.id], 'Toploader case');

		assert.equal(done.changed, 2);
		assert.deepEqual(await storageOf([a.id, b.id, c.id]), ['Toploader case', 'Toploader case', null]);

		await collection.undoStorage(done.undo);

		assert.deepEqual(await storageOf([a.id, b.id, c.id]), ['Drawer', null, null]);
		assert.deepEqual(await places(), [['Drawer', 1, true]], 'the place the change made is gone again');

		const cleared = await collection.setStorage([a.id, c.id], '');

		assert.equal(cleared.changed, 1);
		assert.deepEqual(await storageOf([a.id]), [null]);
	});

	test('a place a copy names but the list lacks still shows, as not saved', () => {
		const list = collection.storedPlaces({cards: [{id: 'c1', storage: 'Shoebox'}, {deleted_at: '2026-10-01T00:00:00.000Z', id: 'c2', storage: 'Gone'}], storage_places: []});

		assert.deepEqual(list, [{count: 1, name: 'Shoebox', saved: false}]);
	});
});

describe('places across phones (js/merge.js as it is)', () => {
	const at = (minute) => `2026-10-09T10:${String(minute).padStart(2, '0')}:00.000Z`;
	const place = (id, name, minute, extra = {}) => ({created_at: at(minute), deleted_at: null, id, name, updated_at: at(minute), ...extra});

	test('a place added on each phone keeps both', () => {
		const merged = mergeDocuments({cards: [], storage_places: [place('p1', 'Box A', 1)]}, {cards: [], storage_places: [place('p2', 'Drawer', 2)]});

		assert.deepEqual(merged.storage_places.map((item) => item.name).sort(), ['Box A', 'Drawer']);
	});

	test('the same place typed on two phones is one entry, since its id comes from its name', async () => {
		await collection.addCard({...COPY, storage: 'Box A'});

		const [first] = await savedPlaces();

		// The other phone: the same document without it.
		await reset();
		await collection.addCard({...COPY, storage: 'box a'});

		const [second] = await savedPlaces();

		assert.equal(first.id, second.id);
		assert.equal(mergeDocuments({cards: [], storage_places: [first]}, {cards: [], storage_places: [second]}).storage_places.length, 1);
	});

	test('a removed place stays removed when the other phone still has it unchanged', () => {
		const live = place('p1', 'Box A', 1);
		const removed = {...live, deleted_at: at(5), updated_at: at(5)};

		assert.ok(mergeDocuments({cards: [], storage_places: [live]}, {cards: [], storage_places: [removed]}).storage_places[0].deleted_at);
		assert.ok(mergeDocuments({cards: [], storage_places: [removed]}, {cards: [], storage_places: [live]}).storage_places[0].deleted_at);
	});

	test('an older app that knows no places keeps them: its document merges with the list, never over it', () => {
		const newer = {cards: [{created_at: at(1), id: 'c1', storage: 'Box A', updated_at: at(3)}], storage_places: [place('p1', 'Box A', 3)], updated_at: at(3)};
		// An app from before Stored in: no storage_places key, and an edit to
		// the copy's condition that carries the storage it read along.
		const older = {cards: [{condition: 'Damaged', created_at: at(1), id: 'c1', storage: 'Box A', updated_at: at(4)}], updated_at: at(4)};
		const merged = mergeDocuments(older, newer);

		assert.deepEqual(merged.storage_places.map((item) => item.name), ['Box A']);
		assert.equal(merged.cards[0].storage, 'Box A');
		assert.equal(merged.cards[0].condition, 'Damaged');
	});
});

describe('rows by place', () => {
	test('copies alike but stored in two places are two rows; + carries the place', async () => {
		globalThis.document = undefined;

		const {alikeFields, alikeKey} = await import('../js/copy-sheet.js');

		assert.notEqual(alikeKey({...COPY, storage: 'Box A'}), alikeKey({...COPY, storage: 'Drawer'}));
		assert.equal(alikeKey({...COPY, storage: 'Box A'}), alikeKey({...COPY, storage: 'box a'}));
		assert.notEqual(alikeKey({...COPY, storage: 'Box A'}), alikeKey(COPY));
		assert.equal(alikeFields({...COPY, storage: 'Box A'}).storage, 'Box A');
		assert.equal('storage' in alikeFields(COPY), false);
	});
});
