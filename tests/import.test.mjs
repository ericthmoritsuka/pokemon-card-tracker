// Unit tests for importing a monprice export: the parser (js/monprice.js
// parseCsv, parseJson, parseExport) and the import step that decides what
// is added, updated, or left alone (js/collection.js planImport,
// importEntryId). Plain Node, invented rows only.
//
// Run: node --test tests/import.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {importEntryId, planImport} from '../js/collection.js';

const NOW = Date.parse('2026-10-02T12:00:00.000Z');

// An entry as js/monprice.js importEntries makes it.
const row = (n, fields = {}) => ({
	card_id: `tst1-${String(n).padStart(3, '0')}`,
	catalog: 'international',
	finish_raw: undefined,
	import_key: `monprice|tst1_int_${n}|pt|NORMAL|0`,
	language: 'pt',
	language_source: 'import',
	name_local: `Test card ${n}`,
	set_name_local: 'Test set',
	variant_id: 'normal',
	...fields,
});

async function idsFor(entries) {
	const ids = new Map();

	for (const entry of entries) {
		ids.set(entry.import_key, await importEntryId(entry.import_key));
	}

	return ids;
}

describe('planImport', () => {
	test('importing the same rows twice adds nothing', async () => {
		const rows = [row(1), row(2), row(3)];
		const first = planImport([], rows, {ids: await idsFor(rows), now: NOW});

		assert.deepEqual(first.counts, {added: 3, skippedDeleted: 0, unchanged: 0, updated: 0});

		const second = planImport(first.cards, rows, {ids: await idsFor(rows), now: NOW + 60000});

		assert.deepEqual(second.counts, {added: 0, skippedDeleted: 0, unchanged: 3, updated: 0});
		assert.equal(second.cards.length, 3);
		assert.deepEqual(second.cards, first.cards);
	});

	test('a deleted row is not brought back', async () => {
		const rows = [row(1), row(2)];
		const {cards} = planImport([], rows, {ids: await idsFor(rows), now: NOW});
		const deleted = cards.map((card) => (card.import_key === rows[0].import_key ? {...card, deleted_at: '2026-10-02T13:00:00.000Z', updated_at: '2026-10-02T13:00:00.000Z'} : card));
		const again = planImport(deleted, rows, {ids: await idsFor(rows), now: NOW + 3600000});

		assert.deepEqual(again.counts, {added: 0, skippedDeleted: 1, unchanged: 1, updated: 0});
		assert.equal(again.cards.filter((card) => !card.deleted_at).length, 1);
	});

	test('a live copy wins over a folded-away duplicate with the same key', async () => {
		const live = {...row(1), created_at: '2026-09-01T00:00:00.000Z', deleted_at: null, id: 'live', updated_at: '2026-09-01T00:00:00.000Z'};
		const folded = {...row(1), created_at: '2026-09-02T00:00:00.000Z', deleted_at: '2026-09-03T00:00:00.000Z', id: 'folded', merged_into: 'live', updated_at: '2026-09-03T00:00:00.000Z'};

		for (const cards of [[live, folded], [folded, live]]) {
			const {counts} = planImport(cards, [row(1)], {now: NOW});

			assert.deepEqual(counts, {added: 0, skippedDeleted: 0, unchanged: 1, updated: 0});
		}
	});

	test('a changed match updates in place, with a newer stamp and the dropped fields gone', async () => {
		const rows = [row(1, {fallback: true, variant_id: null, finish_raw: 'HOLOFOIL'}), row(2)];
		const {cards} = planImport([], rows, {ids: await idsFor(rows), now: NOW});
		const before = cards[0];
		const fixed = [row(1, {variant_id: 'holo'}), row(2)];
		const after = planImport(cards, fixed, {now: NOW - 3600000});

		assert.deepEqual(after.counts, {added: 0, skippedDeleted: 0, unchanged: 1, updated: 1});
		assert.equal(after.cards.length, 2);
		assert.equal(after.cards[0].id, before.id, 'the same entry, in the same place');
		assert.equal(after.cards[0].variant_id, 'holo');
		assert.equal('fallback' in after.cards[0], false);
		assert.equal('finish_raw' in after.cards[0], false);
		assert.ok(after.cards[0].updated_at > before.updated_at, 'stamped later even with a clock behind');
		assert.equal(cards[0], before, 'the list passed in is left alone');
		assert.equal(cards[0].variant_id, null);
	});

	test('new rows keep the export order, one millisecond apart', async () => {
		const rows = [row(3), row(1), row(2)];
		const {cards} = planImport([], rows, {ids: await idsFor(rows), now: NOW});

		assert.deepEqual(cards.map((card) => card.card_id), ['tst1-003', 'tst1-001', 'tst1-002']);
		assert.deepEqual(cards.map((card) => card.created_at), ['2026-10-02T12:00:00.000Z', '2026-10-02T12:00:00.001Z', '2026-10-02T12:00:00.002Z']);
		assert.ok(cards.every((card) => card.updated_at === card.created_at && card.deleted_at === null));
	});

	test('two phones importing the same rows give the same ids', async () => {
		const rows = [row(1), row(2)];
		const phoneA = planImport([], rows, {ids: await idsFor(rows), now: NOW});
		const phoneB = planImport([], rows, {ids: await idsFor(rows), now: NOW + 86400000});

		assert.deepEqual(phoneA.cards.map((card) => card.id), phoneB.cards.map((card) => card.id));
	});
});

describe('importEntryId', () => {
	test('an imported row\'s id is the UUID version 5 of its key, and fits a photo path', async () => {
		const id = await importEntryId('monprice|sv1_int_001|pt|NORMAL|0');

		// The same value Python's uuid.uuid5 gives for this namespace and key.
		assert.equal(id, '60c76a9c-102c-514a-a731-02d884a2d679');
		assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'version nibble 5, RFC 4122 variant');
		assert.match(id, /^[A-Za-z0-9_-]{1,64}$/, 'the entry folder segment supabase/photos.sql accepts');
		assert.match(`${id}-detail`, /^[A-Za-z0-9_-]{1,64}$/);
		assert.equal(await importEntryId('monprice|sv1_int_001|pt|NORMAL|0'), id, 'stable');
		assert.notEqual(await importEntryId('monprice|sv1_int_001|pt|NORMAL|1'), id, 'the next copy gets its own id');
	});
});
