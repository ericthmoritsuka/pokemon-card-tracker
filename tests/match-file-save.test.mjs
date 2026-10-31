// Saving Import "Match this file" (js/match-file.js applyMatch, through
// js/collection.js editDocument): the preview counts what Apply does, and a
// save that fails leaves the document in memory as it was, so nothing shows
// as matched and a second try does the whole match. Plain Node with an
// in-memory IndexedDB that can be told to fail; invented data only.
//
// Run: node --test tests/match-file-save.test.mjs

import assert from 'node:assert/strict';
import {beforeEach, describe, test} from 'node:test';

import {fakeIndexedDb} from './fake-indexeddb.mjs';

// js/collection.js reaches window when it loads.
globalThis.window = globalThis.window || globalThis;
globalThis.addEventListener = globalThis.addEventListener || (() => {});
// No other tabs here, and an open channel would keep Node running.
globalThis.BroadcastChannel = undefined;
globalThis.fetch = async (url) => {
	throw new Error(`No requests in this test (${url}).`);
};

// Every write transaction throws while failSaves is set, as a full disk or
// a closed database would.
const base = fakeIndexedDb();
let failSaves = false;

globalThis.indexedDB = {
	open(name, version) {
		const req = base.open(name, version);
		let handler = null;

		Object.defineProperty(req, 'onsuccess', {
			get: () => () => {
				const db = req.result;

				if (!db.failable) {
					const open = db.transaction;

					db.transaction = (stores, mode) => {
						if (failSaves && mode === 'readwrite') {
							throw new Error('Invented disk full.');
						}

						return open(stores, mode);
					};
					db.failable = true;
				}

				if (handler) {
					handler();
				}
			},
			set: (fn) => {
				handler = fn;
			},
		});

		return req;
	},
};

const collection = await import('../js/collection.js');
const {applyMatch, previewMatch, undoMatch} = await import('../js/match-file.js');
const {importEntries} = await import('../js/monprice.js');

const COPY = {card_id: 'tst1-001', catalog: 'international', language: 'pt', language_source: 'scan'};

const row = (monpriceId, cardId, count, {finish = 'NORMAL', variantId = 'normal'} = {}) => ({
	cardId,
	catalog: 'international',
	row: {count, finish, language: 'pt', monpriceId, name: `Invented ${cardId}`, number: cardId.split('-').pop(), setName: 'Invented set'},
	status: 'matched',
	variantId,
});

const ENTRIES = importEntries([row('tst1_int_1', 'tst1-001', 1, {finish: 'HOLOFOIL', variantId: 'holo'}), row('tst1_int_3', 'tst1-003', 2)]);

async function reset() {
	failSaves = false;

	const doc = await collection.loadDocument();

	doc.cards.length = 0;
	doc.binders = [];
}

beforeEach(reset);

describe('applyMatch', () => {
	test('the preview counts what Apply does', async () => {
		await collection.addCards([
			{...COPY, purchase_price: 30, variant_id: null},
			{...COPY, variant_id: 'reverse'},
			{...COPY, card_id: 'tst1-002', variant_id: 'normal'},
		]);

		const preview = await previewMatch(ENTRIES);
		const done = await applyMatch(ENTRIES);

		assert.deepEqual(done.counts, preview);
		assert.deepEqual([done.counts.added, done.counts.removed, done.counts.kept], [2, 2, 1]);

		const kept = (await collection.loadDocument()).cards.filter((card) => !card.deleted_at && card.card_id === 'tst1-001');

		assert.deepEqual(kept.map((card) => [card.variant_id, card.purchase_price]), [['holo', 30]], 'the copy holding a price is kept and takes the file\'s finish');
	});

	test('a failed save leaves the document as it was, and a second try does the whole match', async () => {
		await collection.addCards([{...COPY, variant_id: 'normal'}, {...COPY, variant_id: 'normal'}]);

		const before = structuredClone((await collection.loadDocument()).cards);

		failSaves = true;
		await assert.rejects(applyMatch(ENTRIES), /Invented disk full/);
		assert.deepEqual((await collection.loadDocument()).cards, before, 'nothing shows as applied in memory');
		await assert.rejects(undoMatch({added: [], cards: []}), /Invented disk full/);

		failSaves = false;

		const done = await applyMatch(ENTRIES);

		assert.deepEqual([done.counts.added, done.counts.removed, done.counts.kept], [2, 1, 1], 'the retry still sees every change');
	});
});
