// Photos, notes, and the main-image pin belong to the card, not the copy
// (js/card-info.js; DESIGN.md section 3). Pure functions, no browser:
// the move off the copies, merging the card_info list between phones, a
// document from a v47 phone arriving after the move, and which bucket
// deletes still go. tests/photos-browser.test.mjs plays the same in the app.
//
// Run: node --test tests/card-info.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import {holdsNote, joinNotes, mergeCardInfo, moveToCardInfo, recordsForCopies, shownRecords} from '../js/card-info.js';
import {mergeDocuments, stableJson} from '../js/merge.js';
import {bucketDeleteState, refreshPhotoIndex} from '../js/photos/model.js';

import * as v21 from './merge-v21.mjs';

const U = '11111111-1111-4111-8111-111111111111';
const at = (minute) => `2026-10-01T10:${String(minute).padStart(2, '0')}:00.000Z`;
const photo = (id, fields = {}) => ({created_at: at(1), deleted_at: null, id, path: `${U}/copy/${id}.webp`, side: 'front', ...fields});
const copy = (id, fields = {}) => ({card_id: 'tst1-001', catalog: 'international', condition: 'Near Mint', created_at: at(0), deleted_at: null, id, language: 'pt', updated_at: at(1), ...fields});
const doc = (cards, extra = {}) => ({binders: [], cards, collections: [], goals: [], openings: [], updated_at: at(0), wishlist: [], ...extra});
const KEY = 'international~tst1-001~pt';
const recordOf = (d, key = KEY) => (d.card_info || []).find((record) => record.id === key);
const liveIds = (photos) => (photos || []).filter((item) => !item.deleted_at).map((item) => item.id).sort();

test('the move: photos, notes from several copies, and the pin go to the card; the copies keep what is physical', () => {
	const d = doc([
		copy('c1', {is_favorite: true, main_image: 'p1', notes: 'Bought at the fair', photos: [photo('p1')], storage: 'Box 1', updated_at: at(2)}),
		copy('c2', {notes: 'Slight whitening', photos: [photo('p2', {side: 'back'})], updated_at: at(5)}),
		// The same note on another copy is kept once.
		copy('c3', {notes: 'Bought at the fair', updated_at: at(3)}),
		// A copy deleted before the move: its photo and note still move.
		copy('c4', {deleted_at: at(4), notes: 'Traded away', photos: [photo('p4')], updated_at: at(4)}),
		// A photo still waiting to upload on an older phone: on the card, and
		// still live on its copy until the path is known.
		copy('c5', {photos: [photo('p5', {path: null})], updated_at: at(1)}),
		// A photo removed before the move never reaches the card.
		copy('c6', {photos: [photo('gone', {deleted_at: at(1)})], updated_at: at(1)}),
		copy('e1', {language: 'en', notes: 'English copy'}),
	]);

	assert.equal(moveToCardInfo(d), true);

	const record = recordOf(d);

	assert.deepEqual(liveIds(record.photos), ['p1', 'p2', 'p4', 'p5']);
	assert.equal(record.photos.find((item) => item.id === 'p1').path, `${U}/copy/p1.webp`, 'the file stays where it is');
	assert.equal(record.notes, 'Slight whitening\n\nTraded away\n\nBought at the fair', 'every distinct note, newest first');
	assert.equal(record.main_image, 'p1');
	assert.equal(recordOf(d, 'international~tst1-001~en').notes, 'English copy', 'one record per language');

	const byId = Object.fromEntries(d.cards.map((card) => [card.id, card]));

	for (const id of ['c1', 'c2', 'c3', 'c4']) {
		assert.equal(byId[id].notes, null, `${id} note moved`);
	}

	assert.equal(byId.c1.main_image, null);
	assert.deepEqual(byId.c1.photos.map((item) => [item.id, Boolean(item.deleted_at), item.moved]), [['p1', true, true]], 'hidden from older apps, marked moved');
	assert.deepEqual(byId.c4.photos.map((item) => item.moved), [true]);
	assert.equal(byId.c5.photos[0].deleted_at, null, 'waits for its upload');
	assert.equal(byId.c6.photos[0].moved, undefined);
	assert.deepEqual([byId.c1.condition, byId.c1.storage, byId.c1.is_favorite], ['Near Mint', 'Box 1', true]);
	assert.equal(byId.c1.field_stamps.notes, byId.c1.updated_at, 'stamped, so the merge takes the cleared note');

	// Once the upload's path arrives, the waiting photo moves too.
	const again = structuredClone(d);

	again.card_info.find((item) => item.id === KEY).photos.find((item) => item.id === 'p5').path = `${U}/p5/p5.webp`;
	moveToCardInfo(again);
	assert.equal(again.cards.find((card) => card.id === 'c5').photos[0].moved, true);

	// Running it again changes nothing.
	const before = stableJson(again);

	assert.equal(moveToCardInfo(again), false);
	assert.equal(stableJson(again), before);
});

test('two phones that move the same copies get the same versions', () => {
	const make = () => doc([copy('c1', {notes: 'n', photos: [photo('p1')], updated_at: at(2)})]);
	const a = make();
	const b = make();

	moveToCardInfo(a);
	moveToCardInfo(b);
	assert.equal(stableJson(a), stableJson(b));
	assert.equal(stableJson(mergeDocuments(a, b)), stableJson(mergeDocuments(b, a)));
});

test('the card_info list from two phones: notes each phone moved both stay, photos join, a removal sticks', () => {
	// Phone A held one copy's note, phone B another's; each moved its own
	// before they synced.
	const phoneA = doc([copy('c1', {notes: 'From A', photos: [photo('pa')], updated_at: at(2)})]);
	const phoneB = doc([copy('c2', {notes: 'From B', photos: [photo('pb')], updated_at: at(3)})]);

	moveToCardInfo(phoneA);
	moveToCardInfo(phoneB);

	const one = mergeDocuments(phoneA, phoneB);
	const two = mergeDocuments(phoneB, phoneA);

	assert.equal(stableJson(recordOf(one)), stableJson(recordOf(two)), 'the same on both phones');
	assert.ok(holdsNote(recordOf(one).notes, 'From A') && holdsNote(recordOf(one).notes, 'From B'), recordOf(one).notes);
	assert.deepEqual(liveIds(recordOf(one).photos), ['pa', 'pb']);

	// A note typed on the card afterwards replaces them, as an edit does.
	const typed = structuredClone(one);
	const record = recordOf(typed);

	Object.assign(record, {field_stamps: {...record.field_stamps, at: at(30), notes: at(30), notes_source: at(30)}, notes: 'Typed', notes_source: null, updated_at: at(30)});
	assert.equal(recordOf(mergeDocuments(one, typed)).notes, 'Typed');

	// Removing a photo on one phone wins over the other's live version.
	const removed = structuredClone(one);

	recordOf(removed).photos.find((item) => item.id === 'pa').deleted_at = at(40);
	recordOf(removed).updated_at = at(40);
	recordOf(removed).field_stamps = {...recordOf(removed).field_stamps, at: at(40)};
	assert.deepEqual(liveIds(recordOf(mergeDocuments(one, removed)).photos), ['pb']);
	assert.deepEqual(liveIds(recordOf(mergeDocuments(removed, one)).photos), ['pb']);
});

test('mergeCardInfo joins notes only while both came from copies', () => {
	const base = {card_id: 'tst1-001', catalog: 'international', created_at: at(1), deleted_at: null, id: KEY, language: 'pt', photos: []};
	const a = {...base, notes: 'x', notes_source: 'copies', updated_at: at(2)};
	const b = {...base, notes: 'y', notes_source: 'copies', updated_at: at(3)};

	assert.equal(stableJson(mergeCardInfo(a, b)), stableJson(mergeCardInfo(b, a)));
	assert.equal(mergeCardInfo(a, b).notes, 'x\n\ny');
	assert.equal(mergeCardInfo({...a, notes_source: null}, b).notes, 'y', 'a typed note is an edit');
	assert.equal(joinNotes('one\n\ntwo', ['two', 'three', '']), 'three\n\none\n\ntwo');
});

test('a document from a v47 phone arriving after the move loses nothing and brings nothing back', () => {
	// What the server held before v48: two copies with photos and notes.
	const v47 = doc([
		copy('c1', {main_image: 'p1', notes: 'Old note', photos: [photo('p1'), photo('p2')], updated_at: at(2)}),
		copy('c2', {photos: [photo('p3')], updated_at: at(2)}),
	]);
	// A v48 phone moves them and syncs.
	const moved = structuredClone(v47);

	moveToCardInfo(moved);

	// Meanwhile the v47 phone, which never saw the move, edits its old
	// copies: a new photo and a new note on c1, p2 removed, c2 deleted (its
	// photo p3 went live with it, which v47 would queue for the bucket).
	const stale = structuredClone(v47);
	const c1 = stale.cards[0];

	c1.photos = [photo('p1'), photo('p2', {deleted_at: at(6)}), photo('p6', {created_at: at(6)})];
	c1.notes = 'New note from v47';
	c1.updated_at = at(6);
	c1.field_stamps = {at: at(6), notes: at(6), since: at(0)};
	stale.cards[1] = {...stale.cards[1], deleted_at: at(7), updated_at: at(7)};

	for (const merged of [mergeDocuments(moved, stale), mergeDocuments(stale, moved)]) {
		const record = recordOf(merged);

		assert.deepEqual(liveIds(record.photos), ['p1', 'p3', 'p6'], 'the new photo joins, the removal sticks, the deleted copy keeps its photo on the card');
		assert.equal(record.notes, 'New note from v47\n\nOld note');
		assert.equal(record.main_image, 'p1');

		// No copy shows a live photo any more, so a v47 phone neither shows
		// one nor queues its file when the copy goes.
		for (const card of merged.cards) {
			assert.deepEqual(liveIds(card.photos), [], `${card.id} holds no live photo`);
			assert.equal(card.notes ?? null, null);
		}

		// The v47 phone's own merge (photos joined by id, a tombstone wins)
		// keeps them hidden: the moved tombstones win over its live copies.
		const back = mergeDocuments(structuredClone(stale), merged);

		assert.deepEqual(liveIds(back.cards.find((card) => card.id === 'c1').photos), []);
	}

	// An older app keeps the card_info list it does not know, entry by
	// entry, and writes it back.
	const old = v21.mergeDocuments(structuredClone(stale), moved);

	assert.deepEqual(old.card_info, moved.card_info);
});

test('the photo index comes from the cards, so a card at zero copies stays in the family\'s view', () => {
	const d = doc([copy('c1', {photos: [photo('p1')]})]);

	moveToCardInfo(d);
	d.cards[0] = {...d.cards[0], deleted_at: at(9), updated_at: at(9)};
	refreshPhotoIndex(d, Date.parse(at(10)));
	assert.deepEqual(d.photo_index.map((item) => [item.id, item.photos.map((p) => p.id)]), [[KEY, ['p1']]]);
});

test('a deleted copy never deletes a file; removing the photo does', () => {
	const d = doc([copy('c1', {photos: [photo('p1')]})]);

	moveToCardInfo(d);
	d.cards[0] = {...d.cards[0], deleted_at: at(9), updated_at: at(9)};

	const holds = () => true;
	const now = Date.parse(at(9)) + 30 * 24 * 3600 * 1000;
	// The row a v47 phone's sweep queued for the deleted copy's photo.
	const legacy = {at: Date.parse(at(9)), entry_id: 'c1', list: 'cards', not_before: Date.parse(at(9)), op: 'delete', path: `${U}/copy/p1.webp`, paths: [`${U}/copy/p1.webp`], photo_id: 'p1'};

	assert.equal(bucketDeleteState(legacy, d, holds, now), 'cancel', 'the card still holds it');

	// The photo removed on the card: the delete goes once the server holds it.
	const record = recordOf(d);

	record.photos = record.photos.map((item) => ({...item, deleted_at: at(10)}));
	record.updated_at = at(10);

	const row = {...legacy, entry_id: KEY, list: 'card_info'};

	assert.equal(bucketDeleteState(row, d, holds, now), 'go');
	assert.equal(bucketDeleteState(row, d, (list, id) => !(list === 'card_info' && id === KEY), now), 'wait', 'waits for the server to hold the removal');
});

test('which records a card shows: its copies\' languages, another language\'s photo as a fallback, all at zero copies', () => {
	const records = [
		{card_id: 'tst1-001', catalog: 'international', deleted_at: null, id: KEY, language: 'pt', notes: 'pt note', photos: []},
		{card_id: 'tst1-001', catalog: 'international', deleted_at: null, id: 'international~tst1-001~en', language: 'en', photos: [photo('pe')]},
		{card_id: 'tst1-001', catalog: 'ja', deleted_at: null, id: 'ja~tst1-001~ja', language: 'ja', photos: [photo('pj')]},
	];
	const card = {card_id: 'tst1-001', catalog: 'international'};

	assert.deepEqual(shownRecords(records, card, ['pt']).map((record) => record.language), ['pt', 'en'], 'Portuguese has no photo: the English one shows');
	assert.deepEqual(shownRecords(records, card, ['en']).map((record) => record.language), ['en']);
	assert.deepEqual(shownRecords(records, card, []).map((record) => record.language), ['pt', 'en'], 'zero copies, no language: every record of the card');
	assert.deepEqual(recordsForCopies(records, [copy('c1', {deleted_at: at(5)})]), [], 'no live copy, no tile photo');
});
