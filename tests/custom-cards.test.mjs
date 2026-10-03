// Unit tests for hand-made cards (js/custom-card.js): the entries a new
// card makes, the record that stands in for a catalog record, editing the
// card on every copy, and linking it to a catalog card that appears later.
// Plain Node, invented cards only.
//
// Run: node --test tests/custom-cards.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {
	CUSTOM,
	cardFields,
	customCard,
	customEntries,
	customRecord,
	editPatches,
	findCatalogCard,
	findSet,
	isCustom,
	isCustomId,
	linkCatalogs,
	linkPatches,
	newCustomCardId,
	sameNumber,
} from '../js/custom-card.js';
import {planOwnImport} from '../js/collection.js';
import {parseOwnCsv} from '../js/monprice.js';

const FORM = {language: 'ko', name: '테스트 에너지', number: '012', setCode: 'M6', setName: '테스트 세트'};

const live = (entries, extra = {}) => entries.map((fields, i) => ({
	...fields,
	created_at: '2026-10-03T10:00:00.000Z',
	deleted_at: null,
	id: `0000000${i}-0000-4000-8000-000000000000`,
	updated_at: '2026-10-03T10:00:00.000Z',
	...extra,
}));

describe('a new hand-made card', () => {
	test('its id is hand_ and 32 hex digits, with no hyphen, so no set id is read from it', () => {
		const id = newCustomCardId();

		assert.ok(isCustomId(id), id);
		assert.ok(!id.includes('-'));
		assert.notEqual(newCustomCardId(), id);
		assert.ok(!isCustomId('me04-001'));
	});

	test('count copies of one card, alike, on the custom catalog', () => {
		const entries = customEntries({...FORM, cardId: 'hand_' + 'a'.repeat(32), condition: 'Near Mint', count: 3, finish: 'HOLOFOIL'});

		assert.equal(entries.length, 3);
		assert.deepEqual(entries[0], {
			card_id: 'hand_' + 'a'.repeat(32),
			catalog: CUSTOM,
			condition: 'Near Mint',
			finish_raw: 'HOLOFOIL',
			language: 'ko',
			language_source: 'manual',
			name_local: '테스트 에너지',
			number_local: '012',
			set_code: 'M6',
			set_name_local: '테스트 세트',
			variant_id: null,
		});
		assert.ok(entries.every((entry) => entry.card_id === entries[0].card_id));
		assert.notEqual(entries[0], entries[1], 'each copy is its own object');
		assert.ok(isCustom(entries[0]));
	});

	test('a name and a language are needed; set and number may be empty', () => {
		assert.throws(() => customEntries({...FORM, name: '   '}), /Give the card a name/);
		assert.throws(() => customEntries({...FORM, language: ''}), /Pick the language/);
		assert.throws(() => customEntries({...FORM, count: 0}), /at least one copy/);

		const [energy] = customEntries({language: 'pt', name: ' Energia  de Fogo ', number: '', setName: ''});

		assert.equal(energy.name_local, 'Energia de Fogo', 'spaces folded');
		assert.equal(energy.number_local, null);
		assert.equal(energy.set_name_local, null);
		assert.equal(energy.finish_raw, undefined);
		assert.equal(energy.condition, undefined);
	});

	test('a number with letters stays as typed', () => {
		assert.equal(cardFields({name: 'Energy', number: 'R'}).fields.number_local, 'R');
	});
});

describe('the record a hand-made card stands for', () => {
	test('its name, set, and number in the copy\'s language, with no image and no details to read', () => {
		const [entry] = live(customEntries({...FORM, cardId: 'hand_' + 'b'.repeat(32)}));
		const record = customRecord(entry);

		assert.equal(record.catalog, CUSTOM);
		assert.equal(record.id, entry.card_id);
		assert.equal(record.collector_number, '012');
		assert.equal(record.set_id, 'M6');
		assert.deepEqual(record.localizations, {ko: {image: null, lang: 'ko', name: '테스트 에너지', set_name: '테스트 세트'}});
		assert.equal(typeof record.category, 'string', 'the background pass skips it');
		assert.equal(customRecord({card_id: 'me04-001', catalog: 'international'}), null);
	});

	test('the card from its live copies, the newest edit winning', () => {
		const cardId = 'hand_' + 'c'.repeat(32);
		const entries = live(customEntries({...FORM, cardId, count: 2}));

		entries[1] = {...entries[1], name_local: 'Renamed', updated_at: '2026-10-03T11:00:00.000Z'};
		entries.push({...entries[0], deleted_at: '2026-10-03T12:00:00.000Z', id: 'gone', name_local: 'Deleted'});

		const card = customCard(entries, cardId);

		assert.equal(card.entries.length, 2);
		assert.equal(card.name, 'Renamed');
		assert.equal(card.setCode, 'M6');
		assert.equal(customCard(entries, 'hand_' + 'd'.repeat(32)), null);
	});
});

describe('editing a hand-made card', () => {
	test('only the copies and fields that differ are patched', () => {
		const entries = live(customEntries({...FORM, count: 2}));

		entries[1] = {...entries[1], number_local: '013'};

		const patches = editPatches(entries, {name: FORM.name, number: '013', setCode: 'M6', setName: FORM.setName});

		assert.deepEqual(patches, [{id: entries[0].id, patch: {number_local: '013'}}]);
		assert.deepEqual(editPatches(entries, {name: FORM.name, number: '013', setCode: 'M6', setName: FORM.setName}).length, 1);
		assert.throws(() => editPatches(entries, {name: ''}), /Give the card a name/);
	});
});

describe('linking to a catalog card that appears later', () => {
	test('numbers compare without leading zeros, case, or a printed total', () => {
		assert.ok(sameNumber('012', '12'));
		assert.ok(sameNumber('012/098', '12'));
		assert.ok(sameNumber('tg02', 'TG2'));
		assert.ok(!sameNumber('12', '13'));
		assert.ok(!sameNumber('', ''));
	});

	test('the set by TCGdex id, printed code, or name; Korean looks in the Japanese catalog too', () => {
		const sets = [{code: 'MEE', id: 'mee', name: 'Mega Evolution Energy'}, {code: null, id: 'M6', name: 'Storm Emerald'}];

		assert.equal(findSet(sets, {setCode: 'MEE'}).id, 'mee');
		assert.equal(findSet(sets, {setCode: 'm6'}).id, 'M6');
		assert.equal(findSet(sets, {setName: 'storm emerald'}).id, 'M6');
		assert.equal(findSet(sets, {setCode: 'XYZ', setName: 'Nothing'}), null);
		assert.deepEqual(linkCatalogs('ko'), ['ko', 'ja']);
		assert.deepEqual(linkCatalogs('pt'), ['international']);
		assert.deepEqual(linkCatalogs('zh-cn'), ['zh-cn']);
	});

	test('the card with the same number, or none', () => {
		const set = {cards: [{id: 'mee-008', localId: '008'}, {id: 'mee-009', localId: '009'}]};

		assert.equal(findCatalogCard(set, '9').id, 'mee-009');
		assert.equal(findCatalogCard(set, '10'), null);
		assert.equal(findCatalogCard(set, null), null);
		assert.equal(findCatalogCard(null, '9'), null);
	});

	test('linking keeps every copy and its names, and a Korean copy on a Japanese card is a fallback', () => {
		const entries = live(customEntries({...FORM, count: 2}));
		const patches = linkPatches(entries, {cardId: 'M6-012', catalog: 'ja'});

		assert.deepEqual(patches.map((item) => item.id), entries.map((entry) => entry.id));
		assert.deepEqual(patches[0].patch, {card_id: 'M6-012', catalog: 'ja', fallback: true, number_local: null, set_code: null, variant_id: null});
		assert.equal('name_local' in patches[0].patch, false, 'the names stay as the source gave them');

		const [pt] = live(customEntries({language: 'pt', name: 'Energia', number: '9', setCode: 'MEE'}));

		assert.equal(linkPatches([pt], {cardId: 'mee-009', catalog: 'international'})[0].patch.fallback, false);
	});
});

describe('hand-made cards in the own CSV', () => {
	test('a hand-made copy comes back from its row with its name, set, and number', () => {
		const header = 'entry_id;card_id;catalog;set_id;set;number;name;language;variant_id;finish;finish_matched;language_source;created_at;updated_at';
		const id = '11111111-2222-4333-8444-555555555555';
		const line = `${id};hand_${'e'.repeat(32)};custom;M6;Test set;"=""012""";"Test energy";KO;;Holo;No;manual;2026-10-03T10:00:00.000Z;2026-10-03T10:00:00.000Z`;
		const {errors, rows} = parseOwnCsv(`﻿${header}\r\n${line}\r\n`);

		assert.deepEqual(errors, []);
		assert.equal(rows[0].name_local, 'Test energy');
		assert.equal(rows[0].set_name_local, 'Test set');
		assert.equal(rows[0].number_local, '012');
		assert.equal(rows[0].set_code, 'M6');
		assert.equal(rows[0].finish_raw, 'HOLOFOIL', 'the label back to monprice\'s word');
		assert.equal(rows[0].language, 'ko');

		const {cards, counts} = planOwnImport([], rows, {now: Date.parse('2026-10-03T12:00:00.000Z')});

		assert.deepEqual(counts.added, 1);
		assert.equal(cards[0].id, id);
		assert.equal(cards[0].catalog, CUSTOM);
		assert.equal(cards[0].created_at, '2026-10-03T10:00:00.000Z');
	});
});
