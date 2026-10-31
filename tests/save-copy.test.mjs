// Unit test for js/collection.js saveCopy, the save Start over uses
// (js/start-over.js), over an in-memory IndexedDB that fires oncomplete in
// a later task than the last onsuccess, as a real browser does: an edit
// made in that gap (a tap, a sync merge, a photo upload writing its path)
// must stay on screen. Plain Node; invented data only, and nothing is
// requested.
//
// Run: node --test tests/save-copy.test.mjs

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {fakeIndexedDb} from './fake-indexeddb.mjs';

// js/collection.js reaches window when it loads.
globalThis.window = globalThis.window || globalThis;
globalThis.addEventListener = globalThis.addEventListener || (() => {});

// Runs once, right after the next document write is stored and before its
// transaction completes.
let onWrite = null;

globalThis.indexedDB = fakeIndexedDb({
	onPut: (value) => {
		if (onWrite && value && Array.isArray(value.cards)) {
			const run = onWrite;

			onWrite = null;
			queueMicrotask(run);
		}
	},
	realOrder: true,
});
globalThis.BroadcastChannel = undefined;
globalThis.fetch = async (url) => {
	throw new Error(`No requests in this test (${url}).`);
};

const collection = await import('../js/collection.js');

test('an edit made while saveCopy commits stays, with the copy\'s change', async () => {
	const first = await collection.addCard({card_id: 'tst1-001', catalog: 'international', language: 'pt'});
	const doc = await collection.loadDocument();
	const draft = structuredClone(doc);

	draft.cards = draft.cards.map((entry) => (entry.id === first.id ? {...entry, deleted_at: '2099-01-01T00:00:00.000Z', updated_at: '2099-01-01T00:00:00.000Z'} : entry));

	let edit = null;

	onWrite = () => {
		edit = collection.addCard({card_id: 'tst1-002', catalog: 'international', language: 'pt', storage: 'added during the save'});
	};

	await collection.saveCopy(draft);

	const added = await edit;

	assert.equal(await collection.loadDocument(), doc, 'the same object on screen');
	assert.ok(doc.cards.some((entry) => entry.id === added.id && !entry.deleted_at), 'the edit made during the save is kept');
	assert.ok(doc.cards.find((entry) => entry.id === first.id).deleted_at, 'and the copy\'s change is in');
});
