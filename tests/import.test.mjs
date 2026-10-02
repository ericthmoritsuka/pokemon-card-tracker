// Unit tests for importing a monprice export: the parser (js/monprice.js
// parseCsv, parseJson, parseExport) and the import step that decides what
// is added, updated, or left alone (js/collection.js planImport,
// importEntryId). Plain Node, invented rows only.
//
// Run: node --test tests/import.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {importEntryId, planImport} from '../js/collection.js';
import {LARGE_COUNT, MAX_COUNT, importEntries, parseCsv, parseExport, parseJson} from '../js/monprice.js';

const HEADER = 'Name;Set;Number;Language;Finish Type;Count;ID;Release Date';

describe('parseCsv', () => {
	test('semicolons, quotes with doubled quotes, and CRLF', () => {
		const text = `${HEADER}\r\n"Pikachu ""Promo"";Base";Test Set;025/165;PT;NORMAL;2;tst1_int_25;2026-01-01\r\n"Name; with semicolon";Test Set;"026/165";EN;HOLOFOIL;1;tst1_int_26;2026-01-01\r\n`;
		const rows = parseCsv(text);

		assert.equal(rows.length, 2);
		assert.equal(rows[0].name, 'Pikachu "Promo";Base');
		assert.equal(rows[0].number, '025/165');
		assert.equal(rows[0].count, '2');
		assert.equal(rows[0].line, 2);
		assert.equal(rows[1].name, 'Name; with semicolon');
		assert.equal(rows[1].finish, 'HOLOFOIL');
		assert.equal(rows[1].id, 'tst1_int_26');
	});

	test('commas when the header has more commas than semicolons, and LF only', () => {
		const rows = parseCsv('Name,Number,Language,ID,Count\nBulbasaur,001/100,EN,tst1_int_1,3\n');

		assert.deepEqual([rows[0].name, rows[0].number, rows[0].language, rows[0].id, rows[0].count], ['Bulbasaur', '001/100', 'EN', 'tst1_int_1', '3']);
	});

	test('the ="..." wrapper a spreadsheet-safe export writes is stripped', () => {
		// As the app's own export writes a number: csvField quotes ="001/165".
		const text = `${HEADER}\r\nCharmander;Test Set;"=""004/165""";PT;NORMAL;1;tst1_int_4;2026-01-01\r\nSquirtle;Test Set;="007";EN;NORMAL;="2";="tst1_int_7";\r\n`;
		const rows = parseCsv(text);

		assert.equal(rows[0].number, '004/165');
		assert.equal(rows[1].number, '007');
		assert.equal(rows[1].count, '2');
		assert.equal(rows[1].id, 'tst1_int_7');
		assert.equal(parseCsv('Name;Number;Language;ID\nX;="=";EN;tst1_int_1\n')[0].number, '=', 'the wrapper is stripped once');
	});

	test('a byte order mark and blank lines are ignored, and a file without the key columns is refused', () => {
		const rows = parseCsv(`﻿${HEADER}\n\nBulbasaur;Test Set;001/165;EN;NORMAL;1;tst1_int_1;\n\n`);

		assert.equal(rows.length, 1);
		assert.equal(rows[0].name, 'Bulbasaur');
		assert.throws(() => parseCsv('Name;Set\nBulbasaur;Test Set\n'), /no ID, Number, Language column/);
	});
});

describe('parseJson', () => {
	test('a monprice JSON export: count and finish left out mean 1 and NORMAL', () => {
		const rows = parseJson(JSON.stringify({pokemon: [
			{id: 'tst1_int_1', lang: 'pt', name: 'Bulbasaur', number: '001/165', set: 'Test Set'},
			{count: 3, finishType: 'REVERSE_HOLOFOIL', id: 'tst1_int_2', lang: 'en', name: 'Ivysaur', number: '002/165', releaseDate: '2026-01-01', set: 'Test Set'},
		]}));

		assert.deepEqual(rows.map((row) => [row.id, row.count, row.finish, row.language, row.line]), [
			['tst1_int_1', '1', 'NORMAL', 'pt', 1],
			['tst1_int_2', '3', 'REVERSE_HOLOFOIL', 'en', 2],
		]);
		assert.equal(parseJson('[{"id":"tst1_int_3","lang":"en","number":"3"}]')[0].id, 'tst1_int_3', 'a bare list works too');
		assert.throws(() => parseJson('{"cards": []}'), /no "pokemon" list/);
	});
});

describe('parseExport', () => {
	test('a BOM before JSON or CSV is ignored, and the format is detected', () => {
		const json = parseExport(`﻿${JSON.stringify({pokemon: [{id: 'tst1_int_1', lang: 'pt', number: '001/165'}]})}`, 'export.json');
		const csv = parseExport(`﻿${HEADER}\r\nBulbasaur;Test Set;001/165;PT;normal;1;tst1_int_1;\r\n`, 'export.csv');

		assert.equal(json.format, 'JSON');
		assert.equal(json.rows[0].language, 'pt');
		assert.equal(csv.format, 'CSV');
		assert.equal(csv.rows[0].finish, 'NORMAL');
		assert.equal(csv.rows[0].setCode, 'tst1');
		assert.equal(csv.rows[0].region, 'int');
	});

	test('rows with a bad id, language, count, or number are reported, not imported', () => {
		const {errors, rows} = parseExport(`${HEADER}\nA;S;001;PT;NORMAL;1;tst1_int_1;\nB;S;002;XX;NORMAL;1;tst1_int_2;\nC;S;003;PT;NORMAL;0;tst1_int_3;\nD;S;;PT;NORMAL;1;tst1_int_4;\nE;S;005;PT;NORMAL;1;nonsense;\n`);

		assert.equal(rows.length, 1);
		assert.deepEqual(errors.map((row) => row.line), [3, 4, 5, 6]);
		assert.match(errors[0].reason, /language "XX"/);
		assert.match(errors[1].reason, /count "0"/);
		assert.match(errors[2].reason, /number is empty/);
		assert.match(errors[3].reason, /ID "nonsense"/);
	});

	test(`a count above ${LARGE_COUNT} is flagged, and one above ${MAX_COUNT} is refused`, () => {
		const {errors, rows} = parseExport(`${HEADER}\nA;S;001;PT;NORMAL;${LARGE_COUNT};tst1_int_1;\nB;S;002;PT;NORMAL;${LARGE_COUNT + 1};tst1_int_2;\nC;S;003;PT;NORMAL;${MAX_COUNT};tst1_int_3;\nD;S;004;PT;NORMAL;99999;tst1_int_4;\n`);

		assert.deepEqual(rows.map((row) => [row.count, Boolean(row.large)]), [[LARGE_COUNT, false], [LARGE_COUNT + 1, true], [MAX_COUNT, true]]);
		assert.equal(errors.length, 1);
		assert.equal(errors[0].count, 0);
		assert.match(errors[0].reason, /count 99,999 is more than 999 copies of one card, which looks like a typo/);
	});

	test('a row becomes one entry per copy, each with its own import key', () => {
		const {rows} = parseExport(`${HEADER}\nBulbasaur;Test Set;001/165;PT;NORMAL;3;tst1_int_1;\n`);
		const entries = importEntries([{cardId: 'tst1-001', catalog: 'international', row: rows[0], status: 'matched', variantId: 'normal'}]);

		assert.deepEqual(entries.map((entry) => entry.import_key), [
			'monprice|tst1_int_1|pt|NORMAL|0',
			'monprice|tst1_int_1|pt|NORMAL|1',
			'monprice|tst1_int_1|pt|NORMAL|2',
		]);
		assert.equal(entries[0].name_local, 'Bulbasaur');
	});
});

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
