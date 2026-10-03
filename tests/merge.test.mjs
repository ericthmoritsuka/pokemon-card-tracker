// Unit tests for js/merge.js. Run: node --test tests/merge.test.mjs

import assert from 'node:assert/strict';
import test from 'node:test';

import {collapseImportDuplicates, countChanged, mergeDocuments, mergeEntries, mergeEntry, nextStamp, restoreEntry, sameContent, stableJson, stampEntry, stamps, validVersion} from '../js/merge.js';

import * as v21 from './merge-v21.mjs';

const at = (minute) => `2026-10-01T10:${String(minute).padStart(2, '0')}:00.000Z`;

const card = (id, minute, fields = {}) => ({card_id: 'me01-001', deleted_at: null, id, updated_at: at(minute), ...fields});

const doc = (cards, extra = {}) => ({binders: [], cards, collections: [], goals: [], openings: [], updated_at: at(0), wishlist: [], ...extra});

const byId = (list) => Object.fromEntries(list.map((entry) => [entry.id, entry]));

test('the newer updated_at wins, from either side', () => {
	const older = card('a', 1, {condition: 'Near Mint'});
	const newer = card('a', 2, {condition: 'Damaged'});

	assert.equal(mergeEntries([older], [newer])[0].condition, 'Damaged');
	assert.equal(mergeEntries([newer], [older])[0].condition, 'Damaged');
});

test('a tombstone wins over an older edit, and an older copy cannot bring it back', () => {
	const edit = card('a', 3, {notes: 'edited offline'});
	const tombstone = card('a', 5, {deleted_at: at(5)});

	for (const merged of [mergeEntries([edit], [tombstone]), mergeEntries([tombstone], [edit])]) {
		assert.equal(merged.length, 1);
		assert.equal(merged[0].deleted_at, at(5));
	}
});

test('at the same updated_at a tombstone wins', () => {
	const edit = card('a', 4, {notes: 'same minute'});
	const tombstone = card('a', 4, {deleted_at: at(4)});

	assert.equal(mergeEntries([edit], [tombstone])[0].deleted_at, at(4));
	assert.equal(mergeEntries([tombstone], [edit])[0].deleted_at, at(4));
});

test('a tie with different content picks the same winner on both sides', () => {
	const a = card('a', 4, {notes: 'phone'});
	const b = card('a', 4, {notes: 'laptop'});

	assert.deepEqual(mergeEntries([a], [b]), mergeEntries([b], [a]));
});

test('no entry is lost when both sides changed different entries', () => {
	const base = [card('a', 1), card('b', 1), card('c', 1)];
	const phone = [card('a', 2, {notes: 'phone'}), base[1], base[2], card('p', 2)];
	const laptop = [base[0], card('b', 3, {notes: 'laptop'}), card('c', 3, {deleted_at: at(3)}), card('l', 3)];

	const merged = byId(mergeDocuments(doc(phone), doc(laptop)).cards);

	assert.deepEqual(Object.keys(merged).sort(), ['a', 'b', 'c', 'l', 'p']);
	assert.equal(merged.a.notes, 'phone');
	assert.equal(merged.b.notes, 'laptop');
	assert.equal(merged.c.deleted_at, at(3));

	// The other direction holds the same entries at the same versions.
	assert.ok(sameContent(mergeDocuments(doc(phone), doc(laptop)), mergeDocuments(doc(laptop), doc(phone))));
});

test('two phones that each add the same card keep both entries', () => {
	const merged = mergeDocuments(doc([card('x1', 2)]), doc([card('x2', 2)]));

	assert.equal(merged.cards.length, 2);
});

test('running the merge twice changes nothing', () => {
	const local = doc([card('a', 2, {notes: 'phone'}), card('b', 1), card('d', 6, {deleted_at: at(6)})], {settings: {theme: 'fire', updated_at: at(2)}});
	const remote = doc([card('a', 1), card('b', 3), card('c', 4)], {settings: {theme: 'water', updated_at: at(1)}, updated_at: at(9)});

	const once = mergeDocuments(local, remote);
	const twice = mergeDocuments(once, remote);
	const back = mergeDocuments(once, once);

	assert.equal(stableJson(twice), stableJson(once));
	assert.equal(stableJson(back), stableJson(once));
	assert.equal(stableJson(mergeDocuments(remote, once)), stableJson(mergeDocuments(remote, twice)));
	assert.equal(once.settings.theme, 'fire');
	assert.equal(once.updated_at, at(9));
});

test('the merge leaves both inputs untouched', () => {
	const local = doc([card('a', 2)]);
	const remote = doc([card('a', 1), card('b', 1)]);
	const before = stableJson([local, remote]);

	mergeDocuments(local, remote);
	assert.equal(stableJson([local, remote]), before);
});

test('every list merges, including ones added later', () => {
	const merged = mergeDocuments(
		{binders: [{id: 'b1', updated_at: at(1)}], future: [{id: 'f1', updated_at: at(1)}]},
		{binders: [{id: 'b2', updated_at: at(1)}], future: [{id: 'f2', updated_at: at(1)}]}
	);

	assert.deepEqual(merged.binders.map((entry) => entry.id), ['b1', 'b2']);
	assert.deepEqual(merged.future.map((entry) => entry.id), ['f1', 'f2']);
	assert.deepEqual(merged.cards, []);
});

test('countChanged counts entries that differ from what the server holds', () => {
	const server = doc([card('a', 1), card('b', 1)]);
	const local = doc([card('a', 1), card('b', 2), card('c', 2)]);

	assert.equal(countChanged(local, stamps(server)), 2);
	assert.equal(countChanged(server, stamps(server)), 0);
	assert.equal(countChanged(local, null), 3);
});

test('nextStamp is later than the previous stamp even with a slow clock', () => {
	// The phone's clock says 09:58, but the version it edits says 10:05: the
	// edit is stamped just after 10:05, so it beats the version it replaced.
	const slow = Date.parse('2026-10-01T09:58:00.000Z');

	assert.equal(nextStamp(at(5), slow), '2026-10-01T10:05:00.001Z');
	assert.equal(nextStamp(at(5), Date.parse(at(9))), at(9), 'a clock that is ahead is used as it is');
	assert.equal(nextStamp(null, Date.parse(at(1))), at(1));
	assert.equal(nextStamp('not a date', Date.parse(at(1))), at(1));

	const edited = card('a', 0, {notes: 'from the slow phone', updated_at: nextStamp(at(5), slow)});

	assert.equal(mergeEntries([card('a', 5)], [edited])[0].notes, 'from the slow phone');
});

// ------------------------------------------------------- sticky deletes

test('a delete stays deleted when an offline phone edits the card later', () => {
	const tombstone = card('a', 5, {deleted_at: at(5)});
	const edit = card('a', 6, {notes: 'edited offline'});

	for (const [merged] of [mergeEntries([tombstone], [edit]), mergeEntries([edit], [tombstone])]) {
		assert.equal(merged.deleted_at, at(5));
		assert.ok(merged.updated_at > at(6), 'stamped later than the edit, so it is pushed and every phone takes it');
		assert.equal(merged.updated_at, '2026-10-01T10:06:00.001Z');
	}

	assert.deepEqual(mergeEntries([tombstone], [edit]), mergeEntries([edit], [tombstone]), 'both phones end up the same');
});

test('a restore on purpose brings an entry back; one older than the delete does not', () => {
	const tombstone = card('a', 5, {deleted_at: at(5)});
	const restored = restoreEntry(tombstone, Date.parse(at(7)));

	assert.equal(restored.deleted_at, null);
	assert.equal(restored.restored_at, at(7));
	assert.equal(restored.updated_at, at(7));

	for (const [merged] of [mergeEntries([tombstone], [restored]), mergeEntries([restored], [tombstone])]) {
		assert.equal(merged.deleted_at, null);
	}

	// Restored at minute 4, then deleted again at minute 5: the delete wins.
	const early = card('a', 4, {restored_at: at(4)});

	assert.equal(mergeEntries([early], [tombstone])[0].deleted_at, at(5));

	// A restore made on a phone with a slow clock still comes after the
	// delete it undoes.
	assert.ok(restoreEntry(tombstone, Date.parse(at(1))).restored_at > at(5));
	assert.equal(restoreEntry(card('b', 1)).id, 'b', 'a live entry is returned as it is');
	assert.equal('merged_into' in restoreEntry(card('c', 2, {deleted_at: at(2), merged_into: 'x'})), false);
});

test('the sticky result wins on a v21 phone too', () => {
	const tombstone = card('a', 5, {deleted_at: at(5)});
	const edit = card('a', 6, {notes: 'edited offline'});
	const [merged] = mergeEntries([tombstone], [edit]);

	// The v21 phone holds the edit and receives the result.
	for (const [old] of [v21.mergeEntries([edit], [merged]), v21.mergeEntries([merged], [edit])]) {
		assert.equal(old.deleted_at, at(5));
		assert.equal(old, merged);
	}
});

test('a result that differs from both sides gets a stamp newer than both; equal content returns the same object', () => {
	const tombstone = card('a', 5, {deleted_at: at(5)});
	const edit = card('a', 6, {notes: 'edited offline'});
	const [merged] = mergeEntries([edit], [tombstone]);

	assert.notEqual(merged, tombstone);
	assert.ok(merged.updated_at > edit.updated_at && merged.updated_at > tombstone.updated_at);

	// Once merged, merging again with either side changes nothing.
	assert.equal(mergeEntries([merged], [edit])[0], merged);
	assert.equal(mergeEntries([tombstone], [merged])[0], merged);

	const same = card('b', 3, {notes: 'x'});

	assert.equal(mergeEntries([same], [{...same}])[0], same);
	assert.equal(mergeEntry(same, same), same);

	// Stamps see the change, so the merged document is pushed.
	const local = doc([tombstone]);
	const remote = doc([edit]);
	const both = mergeDocuments(local, remote);

	assert.equal(sameContent(both, local), false);
	assert.equal(sameContent(both, remote), false);
});

test('two tombstones: the later one wins', () => {
	const first = card('a', 5, {deleted_at: at(5)});
	const second = card('a', 7, {deleted_at: at(7)});

	assert.equal(mergeEntries([first], [second])[0], second);
	assert.equal(mergeEntries([second], [first])[0], second);
});

test('deletes stick in every list: binders, lists, wishes, and lists added later', () => {
	const dead = {deleted_at: at(5), id: 'x', name: 'gone', updated_at: at(5)};
	const live = {deleted_at: null, id: 'x', name: 'renamed offline', updated_at: at(8)};

	for (const list of ['binders', 'goals', 'wishlist', 'collections', 'openings', 'future']) {
		const merged = mergeDocuments({[list]: [live]}, {[list]: [dead]});

		assert.equal(merged[list][0].deleted_at, at(5), list);
	}
});

// ------------------------------------------------------- duplicate copies

// The same imported row on two phones before v22: two random ids, one key.
const KEY = 'monprice|tst1_int_7|pt|NORMAL|0';

const imported = (id, minute, fields = {}) => card(id, minute, {created_at: at(minute), import_key: KEY, language: 'pt', variant_id: 'normal', ...fields});

const photo = (id, fields = {}) => ({created_at: at(1), deleted_at: null, id, path: `u1/e/${id}.webp`, side: 'front', ...fields});

const binder = (slots, minute = 1) => ({created_at: at(0), deleted_at: null, id: 'b1', name: 'Binder', slots, updated_at: at(minute)});

const live = (list) => list.filter((entry) => !entry.deleted_at);

test('duplicates by import key collapse into the oldest copy, keeping photos, Liga price, notes, and the binder pocket', () => {
	// Phone 1 imported first and used its copy: a photo, a Liga price, a
	// pocket. Phone 2 imported the same row later and added a note.
	const price = {avg: 12, currency: 'BRL', date: '2026-10-01', low_nm: 10, source: 'liga'};
	const first = imported('one', 1, {main_image: 'p1', photos: [photo('p1')], price_manual: price, updated_at: at(3)});
	const second = imported('two', 2, {notes: 'from phone 2', photos: [photo('p2')], updated_at: at(4)});
	const phone1 = doc([first], {binders: [binder([{entry_id: 'one', page: 1, placed_at: at(3), position: 1}])]});
	const phone2 = doc([second], {binders: []});
	const merged = mergeDocuments(phone1, phone2);
	const [kept] = live(merged.cards);

	assert.equal(live(merged.cards).length, 1);
	assert.equal(kept.id, 'one', 'the oldest copy survives');
	assert.deepEqual(kept.photos.map((item) => item.id), ['p1', 'p2']);
	assert.equal(kept.main_image, 'p1');
	assert.deepEqual(kept.price_manual, price);
	assert.equal(kept.notes, 'from phone 2');
	assert.equal(kept.created_at, at(1));
	assert.equal(kept.updated_at, '2026-10-01T10:04:00.001Z', 'stamped after the newest copy');

	const gone = merged.cards.find((entry) => entry.id === 'two');

	assert.equal(gone.merged_into, 'one');
	assert.equal(gone.deleted_at, kept.updated_at);
	assert.equal(merged.binders[0].slots[0].entry_id, 'one');
});

test('the survivor takes the newest pin that still shows an image, and the newest non-empty fields', () => {
	const first = imported('one', 1, {condition: 'Near Mint', main_image: 'gone', photos: [photo('gone', {deleted_at: at(2)})], updated_at: at(2)});
	const second = imported('two', 3, {condition: '', is_favorite: true, main_image: 'p2', notes: '', photos: [photo('p2')], updated_at: at(5)});
	const third = imported('three', 4, {notes: 'older note', updated_at: at(4)});
	const [kept] = live(mergeDocuments(doc([first, third]), doc([second])).cards);

	assert.equal(kept.id, 'one');
	assert.equal(kept.main_image, 'p2', 'the survivor\'s own pin points at a removed photo');
	assert.equal(kept.condition, 'Near Mint', 'an empty value never wins');
	assert.equal(kept.notes, 'older note');
	assert.equal(kept.is_favorite, true);
});

test('collapse is the same on every phone, and running it twice changes nothing', () => {
	const a = imported('a', 1, {photos: [photo('pa')], updated_at: at(2)});
	const b = imported('b', 2, {notes: 'b', updated_at: at(3)});
	const c = imported('c', 2, {notes: 'c', updated_at: at(3)});
	const one = mergeDocuments(doc([a, b]), doc([c]));
	const two = mergeDocuments(doc([c]), doc([b, a]));

	assert.ok(sameContent(one, two));
	assert.equal(stableJson(byId(one.cards)), stableJson(byId(two.cards)));
	assert.equal(live(one.cards)[0].id, 'a');

	const again = mergeDocuments(one, two);

	assert.equal(stableJson(byId(again.cards)), stableJson(byId(one.cards)));
	assert.equal(collapseImportDuplicates(one.cards), one.cards, 'nothing left to fold returns the same list');
});

test('a tie on created_at goes to the lowest id', () => {
	const merged = mergeDocuments(doc([imported('zz', 1)]), doc([imported('aa', 1)]));

	assert.equal(live(merged.cards)[0].id, 'aa');
});

test('a binder pocket pointing at an older merged id is redirected after any merge', () => {
	const folded = doc([imported('one', 1, {updated_at: at(5)}), imported('two', 2, {deleted_at: at(5), merged_into: 'one', updated_at: at(5)})]);
	// A phone that never repaired sends a binder holding the dropped copy.
	const stale = {binders: [binder([{entry_id: 'two', page: 1, placed_at: at(6), position: 4}], 6)]};
	const merged = mergeDocuments(folded, stale);

	assert.equal(merged.binders[0].slots[0].entry_id, 'one');
	assert.equal(merged.binders[0].slots[0].placed_at, at(6), 'placed_at is kept');
	assert.equal(merged.binders[0].updated_at, '2026-10-01T10:06:00.001Z');

	// Chains are followed, and a binder with nothing to redirect is untouched.
	const chain = mergeDocuments(doc([
		imported('x', 1, {import_key: 'k1'}),
		card('y', 3, {deleted_at: at(3), merged_into: 'x'}),
		card('z', 4, {deleted_at: at(4), merged_into: 'y'}),
	], {binders: [binder([{entry_id: 'z', page: 1, placed_at: at(1), position: 1}]), {...binder([{entry_id: 'x', page: 1, placed_at: at(1), position: 2}]), id: 'b2'}]}), {});

	assert.equal(chain.binders[0].slots[0].entry_id, 'x');
	assert.equal(chain.binders[1].updated_at, at(1));
});

test('deleted copies and copies with no import key are never collapsed', () => {
	const deleted = imported('one', 1, {deleted_at: at(2), updated_at: at(2)});
	const keep = imported('two', 3);
	const scanned1 = card('s1', 1, {created_at: at(1)});
	const scanned2 = card('s2', 1, {created_at: at(1)});
	const merged = mergeDocuments(doc([deleted, scanned1]), doc([keep, scanned2]));

	assert.deepEqual(live(merged.cards).map((entry) => entry.id).sort(), ['s1', 's2', 'two']);
	assert.equal(merged.cards.find((entry) => entry.id === 'one').merged_into, undefined);
});

test('a v21 phone\'s edit to a collapsed duplicate does not bring it back', () => {
	const repaired = mergeDocuments(doc([imported('one', 1)]), doc([imported('two', 2)]));
	// The v21 phone, offline, edits its copy of the dropped duplicate later.
	const v21Edit = imported('two', 2, {notes: 'edited on the old phone', updated_at: at(30)});

	for (const merged of [mergeDocuments(repaired, doc([v21Edit])), mergeDocuments(doc([v21Edit]), repaired)]) {
		assert.deepEqual(live(merged.cards).map((entry) => entry.id), ['one']);
		assert.ok(merged.cards.find((entry) => entry.id === 'two').updated_at > at(30));
	}

	// And the v21 phone takes the tombstone back.
	const fromServer = mergeDocuments(repaired, doc([v21Edit]));

	assert.ok(v21.mergeEntries([v21Edit], fromServer.cards).find((entry) => entry.id === 'two').deleted_at);
});

test('a survivor version that never saw the folded photos gets them back', () => {
	const repaired = mergeDocuments(doc([imported('one', 1)]), doc([imported('two', 2, {photos: [photo('p2')]})]));
	// A v21 phone edits the survivor from its old copy, which has no photos.
	const v21Edit = imported('one', 1, {condition: 'Damaged', updated_at: at(40)});
	const merged = mergeDocuments(repaired, doc([v21Edit]));
	const [kept] = live(merged.cards);

	assert.equal(kept.condition, 'Damaged');
	assert.deepEqual(kept.photos.map((item) => item.id), ['p2']);
	assert.ok(kept.updated_at > at(40));
});

test('the same imported row on two phones keeps the copy that was used, whichever import is newer', () => {
	// v22 phones give the same row the same id (js/collection.js importEntryId).
	const used = imported('same', 1, {photos: [photo('p1')], updated_at: at(9)});
	const fresh = imported('same', 20);

	for (const [merged] of [mergeEntries([used], [fresh]), mergeEntries([fresh], [used])]) {
		assert.deepEqual(merged.photos.map((item) => item.id), ['p1']);
		assert.ok(merged.updated_at > at(20), 'stamped after the fresh import, so a v21 phone takes it');
	}

	// Two fresh imports: the earlier one.
	const [early] = mergeEntries([imported('same', 30)], [imported('same', 3)]);

	assert.equal(early.created_at, at(3));
	assert.deepEqual(mergeEntries([imported('same', 30)], [imported('same', 3)]), mergeEntries([imported('same', 3)], [imported('same', 30)]));
});

// js/collection.js deleteCards and restoreCard, over an in-memory IndexedDB
// (tests/fake-indexeddb.mjs). Undo after removing copies on card detail and
// in a binder's pocket sheet uses them.
test('deleteCards removes several copies in one save, and restoreCard brings them back past the tombstone', async () => {
	const {fakeIndexedDb} = await import('./fake-indexeddb.mjs');

	globalThis.window = globalThis.window || globalThis;
	globalThis.indexedDB = fakeIndexedDb();

	// No other tabs here, and an open channel would keep Node running.
	const channel = globalThis.BroadcastChannel;

	globalThis.BroadcastChannel = undefined;

	try {
		const collection = await import('../js/collection.js');
		const saves = [];
		const stop = collection.onChange((saved, {source}) => saves.push(source));
		const a = await collection.addCard({card_id: 'tst1-001', catalog: 'international', language: 'pt'});
		const b = await collection.addCard({card_id: 'tst1-001', catalog: 'international', language: 'pt'});
		const c = await collection.addCard({card_id: 'tst1-001', catalog: 'international', language: 'pt'});

		saves.length = 0;

		const deleted = await collection.deleteCards([a.id, b.id, 'no-such-id']);

		assert.deepEqual(deleted.map((entry) => entry.id), [a.id, b.id]);
		assert.deepEqual(saves, ['local'], 'one save for both');
		assert.deepEqual((await collection.listCards()).map((entry) => entry.id), [c.id]);

		const tombstone = (await collection.loadDocument()).cards.find((entry) => entry.id === a.id);

		assert.ok(tombstone.deleted_at);
		assert.equal(tombstone.updated_at, tombstone.deleted_at);
		assert.deepEqual(await collection.deleteCards([a.id]), [], 'a deleted copy is not deleted twice');

		// Restoring one.
		saves.length = 0;

		const back = await collection.restoreCard(a.id);

		assert.equal(back.id, a.id);
		assert.equal(back.deleted_at, null);
		assert.ok(back.restored_at > tombstone.deleted_at, 'restored after the delete');
		assert.equal(back.updated_at, back.restored_at);
		assert.deepEqual(saves, ['local']);
		assert.equal(await collection.restoreCard(a.id), null, 'nothing to restore on a live copy');

		// The restored copy wins over the tombstone another phone still holds,
		// from either side of the merge.
		for (const [merged] of [mergeEntries([back], [tombstone]), mergeEntries([tombstone], [back])]) {
			assert.equal(merged.deleted_at, null);
		}

		// Several at once, in one save, and a live copy is left as it is.
		await collection.deleteCards([c.id]);
		saves.length = 0;

		const several = await collection.restoreCard([b.id, c.id, a.id]);

		assert.deepEqual(several.map((entry) => entry.id).sort(), [b.id, c.id].sort());
		assert.deepEqual(saves, ['local']);
		assert.equal((await collection.listCards()).length, 3);

		// Card writes stamp the fields they change, so another phone's edit
		// to a different field of the same copy survives the merge.
		const before = structuredClone((await collection.loadDocument()).cards.find((entry) => entry.id === c.id));
		const noted = await collection.updateCard(c.id, {notes: 'this phone'});

		assert.equal(validVersion(noted), true);
		assert.equal(noted.field_stamps.notes, noted.updated_at);
		assert.equal('condition' in noted.field_stamps, false);

		const otherPhone = stampEntry(before, {...before, condition: 'Damaged', updated_at: nextStamp(noted.updated_at)});
		const [merged] = mergeEntries([structuredClone(noted)], [otherPhone]);

		assert.equal(merged.notes, 'this phone');
		assert.equal(merged.condition, 'Damaged');
		stop();
	}
	finally {
		globalThis.BroadcastChannel = channel;
	}
});

// ------------------------------------------------------- key by key
//
// Versions written by the new app carry field_stamps (stampEntry); versions
// an older app wrote do not, and fall back to the whole-entry rule.

const made = (id, fields = {}) => ({card_id: 'me01-001', created_at: at(0), deleted_at: null, id, updated_at: at(0), ...fields});

// An edit on a phone with the new app, and on a phone still on v21.
const edit = (entry, minute, patch) => stampEntry(entry, {...entry, ...patch, updated_at: at(minute)});
const oldEdit = (entry, minute, patch) => ({...entry, ...patch, updated_at: at(minute)});

const both = (a, b) => {
	const one = mergeEntry(a, b);
	const two = mergeEntry(b, a);

	assert.equal(stableJson(one), stableJson(two), 'the same result from either side');

	return one;
};

const binderOf = (fields = {}) => ({art: [], cols: 3, created_at: at(0), deleted_at: null, id: 'x', name: 'Binder', page_count: 2, rows: 3, slots: [], updated_at: at(0), ...fields});

const pocket = (page, position, minute, content) => ({page, placed_at: at(minute), position, ...content});

// Puts content in a pocket the way js/binders.js setPocket does (null takes
// it out), stamped.
const place = (entry, minute, page, position, content) => {
	const slots = entry.slots.filter((slot) => !(slot.page === page && slot.position === position) && !(content && content.entry_id && slot.entry_id === content.entry_id));

	if (content) {
		slots.push(pocket(page, position, minute, content));
	}

	return edit(entry, minute, {slots});
};

const filled = (entry) => entry.slots.filter((slot) => slot.entry_id).map((slot) => `${slot.page}:${slot.position}:${slot.entry_id}`).sort();

test('stampEntry stamps only the fields that changed, and the version counts as valid', () => {
	const base = made('a', {notes: 'n'});
	const next = edit(base, 2, {condition: 'Damaged', notes: undefined});

	assert.equal(validVersion(base), true, 'never edited');
	assert.equal(validVersion(next), true);
	assert.deepEqual(next.field_stamps, {at: at(2), condition: at(2), notes: at(2), since: at(0)});
	assert.equal(validVersion(oldEdit(next, 3, {notes: 'old app'})), false, 'an older app moves updated_at only');

	// A new edit over a version an older app wrote starts its history there.
	const over = edit(oldEdit(next, 3, {notes: 'old app'}), 4, {grade: '9'});

	assert.deepEqual(over.field_stamps, {at: at(4), grade: at(4), since: at(4)});
});

test('a Liga price on one phone and a photo on the other both survive (the E-15 repro)', () => {
	const base = made('a');
	const price = {avg: 10, currency: 'BRL', date: '2026-10-01', low_nm: 8, source: 'liga'};
	const phoneA = edit(base, 2, {price_manual: price});
	const phoneB = edit(base, 3, {photos: [photo('p1')]});
	const merged = both(phoneA, phoneB);

	assert.deepEqual(merged.price_manual, price);
	assert.deepEqual(merged.photos.map((item) => item.id), ['p1']);
	assert.ok(merged.updated_at > phoneB.updated_at, 'stamped after both');
	assert.equal(validVersion(merged), true);

	// Merging again with either side changes nothing.
	assert.equal(mergeEntry(merged, phoneA), merged);
	assert.equal(mergeEntry(phoneB, merged), merged);

	// A phone still on v21 takes the result, since it is newer.
	assert.equal(v21.mergeEntries([phoneA], [merged])[0], merged);
	assert.equal(v21.mergeEntries([merged], [phoneB])[0], merged);
});

test('a note and a condition edited on two phones both survive; the same field goes to the later edit', () => {
	const base = made('a', {condition: 'Near Mint', notes: 'first'});
	const phoneA = edit(base, 2, {notes: 'from A'});
	const phoneB = edit(base, 3, {condition: 'Damaged'});
	const merged = both(phoneA, phoneB);

	assert.equal(merged.notes, 'from A');
	assert.equal(merged.condition, 'Damaged');

	const later = both(edit(base, 4, {notes: 'later'}), edit(base, 5, {notes: 'latest'}));

	assert.equal(later.notes, 'latest');
});

test('pockets placed on two phones in one binder both survive', () => {
	const base = place(binderOf(), 1, 1, 1, {entry_id: 'c1'});
	const phoneA = place(base, 2, 1, 2, {entry_id: 'c2'});
	const phoneB = place(base, 3, 1, 3, {entry_id: 'c3'});

	assert.deepEqual(filled(both(phoneA, phoneB)), ['1:1:c1', '1:2:c2', '1:3:c3']);
});

test('a cleared pocket stays clear; a later fill wins', () => {
	const base = place(binderOf(), 1, 1, 1, {entry_id: 'c1'});
	const cleared = place(base, 3, 1, 1, null);
	const renamed = edit(base, 4, {name: 'Renamed'});
	const merged = both(cleared, renamed);

	assert.deepEqual(filled(merged), [], 'the pocket stays clear');
	assert.equal(merged.name, 'Renamed');
	assert.deepEqual(merged.slots.find((slot) => slot.cleared), {cleared: true, page: 1, placed_at: at(3), position: 1});

	const refilled = place(base, 5, 1, 1, {entry_id: 'c9'});

	assert.deepEqual(filled(both(cleared, refilled)), ['1:1:c9']);

	// A move leaves a cleared marker where the copy was.
	const moved = place(base, 2, 1, 5, {entry_id: 'c1'});

	assert.deepEqual(filled(both(moved, renamed)), ['1:5:c1']);
});

test('hand ticks merge by dex; an untick beats an older tick', () => {
	const goal = {created_at: at(0), deleted_at: null, hand_ticks: {}, id: 'g', kind: 'every_pokemon', updated_at: at(0)};
	const base = edit(goal, 1, {hand_ticks: {1: at(1)}});
	const phoneA = edit(base, 2, {hand_ticks: {1: at(1), 4: at(2)}});
	const phoneB = edit(base, 3, {hand_ticks: {}, hand_unticks: {1: at(3)}});
	const merged = both(phoneA, phoneB);

	assert.deepEqual(merged.hand_ticks, {4: at(2)});
	assert.deepEqual(merged.hand_unticks, {1: at(3)});

	const reticked = edit(phoneB, 5, {hand_ticks: {1: at(5)}, hand_unticks: undefined});

	assert.deepEqual(both(reticked, phoneA).hand_ticks, {1: at(5), 4: at(2)}, 'a tick after the untick wins');
});

test('a cover upload finishing later neither reverts a newer cover nor drops pockets', () => {
	const old = {at: at(1), id: 'cover1', path: null, type: 'image/webp'};
	const base = edit(binderOf({cover_image: null}), 1, {cover_image: old});
	// Phone A picks a new cover at minute 3. Phone B places a card at minute
	// 2, then its upload of the old cover fills in the path at minute 4,
	// without moving the cover's own stamp.
	const phoneA = edit(base, 3, {cover_image: {at: at(3), id: 'cover2', path: null, type: 'image/webp'}});
	const placed = place(base, 2, 1, 1, {entry_id: 'c1'});
	const phoneB = stampEntry(placed, {...placed, cover_image: {...old, path: 'u1/covers/cover1.webp'}, updated_at: at(4)}, {skip: ['cover_image']});
	const merged = both(phoneA, phoneB);

	assert.equal(merged.cover_image.id, 'cover2');
	assert.deepEqual(filled(merged), ['1:1:c1']);

	// The same picture: the version that knows its path wins.
	assert.equal(both(base, phoneB).cover_image.path, 'u1/covers/cover1.webp');

	// Taken away on one phone after the other set it: the later stamp wins.
	assert.equal(both(edit(phoneA, 5, {cover_image: null}), phoneB).cover_image, null);
});

test('slots outside the merged grid are dropped', () => {
	const base = place(binderOf({page_count: 3}), 1, 1, 1, {entry_id: 'c1'});
	const fewer = edit(base, 5, {page_count: 1});
	const late = place(base, 4, 3, 2, {entry_id: 'c2'});
	const merged = both(fewer, late);

	assert.equal(merged.page_count, 1);
	assert.deepEqual(filled(merged), ['1:1:c1'], 'no ghost card on page 3 when the binder grows again');
	assert.equal(merged.slots.some((slot) => slot.page > 1), false);
});

test('pockets from two different layouts never mix: the higher layout keeps its pockets', () => {
	const base = place(binderOf(), 1, 1, 1, {entry_id: 'c1'});
	const resized = edit(base, 2, {cols: 4, layout: 1, rows: 4, slots: [pocket(1, 1, 1, {entry_id: 'c1'})]});
	const placed = place(base, 3, 1, 9, {entry_id: 'c2'});
	const merged = both(resized, placed);

	assert.equal(merged.layout, 1);
	assert.equal(merged.rows, 4);
	assert.deepEqual(filled(merged), ['1:1:c1']);
});

test('photos always merge by id, even when an older app wrote one side', () => {
	const base = made('a', {photos: [photo('p1')]});
	const removed = edit(base, 2, {photos: [photo('p1', {deleted_at: at(2)})]});
	const added = oldEdit(base, 3, {notes: 'old app', photos: [photo('p1'), photo('p2')]});
	const merged = both(removed, added);

	assert.equal(merged.notes, 'old app', 'the newer version whole');
	assert.deepEqual(merged.photos.map((item) => [item.id, Boolean(item.deleted_at)]), [['p1', true], ['p2', false]]);
	assert.ok(merged.updated_at > added.updated_at);
});

test('a v21 edit falls back to whole-entry but keeps photo tombstones, cleared pockets, and unticks', () => {
	const base = place(binderOf(), 1, 1, 1, {entry_id: 'c1'});
	const cleared = place(base, 2, 1, 1, null);
	const oldRename = oldEdit(base, 3, {name: 'Old app'});
	const merged = both(cleared, oldRename);

	assert.equal(merged.name, 'Old app');
	assert.deepEqual(filled(merged), [], 'the cleared pocket stays clear');
	assert.equal(validVersion(merged), false);

	const goal = {created_at: at(0), deleted_at: null, hand_ticks: {7: at(0)}, id: 'g', kind: 'every_pokemon', updated_at: at(0)};
	const untick = edit(goal, 2, {hand_ticks: {}, hand_unticks: {7: at(2)}});
	const oldGoal = oldEdit(goal, 3, {name: 'Old app'});

	assert.deepEqual(both(untick, oldGoal).hand_ticks, {});
});

test('a pocket removed by a v21 phone is not brought back by an older copy from the new app (the since rule)', () => {
	const base = place(binderOf(), 1, 1, 1, {entry_id: 'c1'});
	const older = edit(base, 2, {notes: 'new app, older'});
	const removed = oldEdit(base, 3, {slots: []});

	assert.deepEqual(filled(both(older, removed)), [], 'the fallback keeps the newer version whole');

	// The new app edits the v21 version later: its history starts there, so
	// the older copy's pocket, placed before, is not brought back.
	const takenOver = edit(removed, 4, {name: 'Renamed'});
	const merged = both(older, takenOver);

	assert.equal(validVersion(merged), true);
	assert.deepEqual(filled(merged), []);
	assert.equal(merged.name, 'Renamed');
});

test('mergeDocuments keeps the higher merge_version', () => {
	assert.equal(mergeDocuments(doc([], {merge_version: 2}), doc([])).merge_version, 2);
	assert.equal(mergeDocuments(doc([]), doc([], {merge_version: 3})).merge_version, 3);
	assert.equal('merge_version' in mergeDocuments(doc([]), doc([])), false);
});

// ------------------------------------------------ three phones converge

// A seeded random number generator, so a failure can be replayed.
function random(seed) {
	let state = seed >>> 0;

	return () => {
		state = (state + 0x6d2b79f5) >>> 0;

		let t = state;

		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// One random edit on a phone: a card field, a photo added or removed, a
// card deleted, a pocket filled or emptied, or a hand tick flipped. A phone
// on v21 edits the way v21 does (no stamps, no markers, no unticks).
function randomChange(phone, rand, clock) {
	const pick = (list) => list[Math.floor(rand() * list.length)];
	const list = pick(['cards', 'cards', 'binders', 'goals']);
	const entries = phone.doc[list];
	const live = entries.filter((entry) => !entry.deleted_at);

	if (!live.length) {
		return;
	}

	const entry = pick(live);
	const stamp = nextStamp(entry.updated_at, clock);
	const next = {...structuredClone(entry), updated_at: stamp};

	if (list === 'cards') {
		const what = pick(['notes', 'condition', 'price', 'photo', 'unphoto', 'delete']);
		const shown = (next.photos || []).filter((item) => !item.deleted_at);

		if (what === 'notes') {
			next.notes = `note ${Math.floor(rand() * 100)}`;
		}
		else if (what === 'condition') {
			next.condition = pick(['Near Mint', 'Damaged', 'Lightly Played']);
		}
		else if (what === 'price') {
			next.price_manual = {avg: Math.floor(rand() * 50), currency: 'BRL'};
		}
		else if (what === 'photo') {
			next.photos = [...(next.photos || []), photo(`p${clock}`)];
		}
		else if (what === 'unphoto' && shown.length) {
			const target = pick(shown);

			next.photos = next.photos.map((item) => (item.id === target.id ? {...item, deleted_at: stamp} : item));
		}
		else if (what === 'delete' && rand() < 0.3) {
			next.deleted_at = stamp;
		}
	}
	else if (list === 'binders') {
		const page = 1 + Math.floor(rand() * 2);
		const position = 1 + Math.floor(rand() * 4);
		const content = rand() < 0.3 ? null : {entry_id: pick(['a', 'b', 'c'])};

		next.slots = next.slots.filter((slot) => !(slot.page === page && slot.position === position) && !(content && slot.entry_id === content.entry_id));

		if (content) {
			next.slots.push({page, placed_at: stamp, position, ...content});
		}

		next.slots.sort((x, y) => (x.page - y.page) || (x.position - y.position));
	}
	else {
		const dex = String(1 + Math.floor(rand() * 5));
		const ticks = {...next.hand_ticks};
		const unticks = {...(next.hand_unticks || {})};

		if (dex in ticks) {
			delete ticks[dex];

			if (!phone.old) {
				unticks[dex] = stamp;
			}
		}
		else {
			ticks[dex] = stamp;
			delete unticks[dex];
		}

		next.hand_ticks = ticks;
		delete next.hand_unticks;

		if (Object.keys(unticks).length) {
			next.hand_unticks = unticks;
		}
	}

	const saved = phone.old ? next : stampEntry(entry, next);

	phone.doc[list] = entries.map((item) => (item.id === entry.id ? saved : item));
}

test('three phones, mixed v21 and new, converge', () => {
	for (let seed = 1; seed <= 60; seed++) {
		const rand = random(seed);
		const start = {
			binders: [binderOf()],
			cards: ['a', 'b', 'c'].map((id) => made(id, {photos: []})),
			goals: [{created_at: at(0), deleted_at: null, hand_ticks: {}, id: 'g', kind: 'every_pokemon', updated_at: at(0)}],
			updated_at: at(0),
		};
		const phones = [{doc: structuredClone(start), old: false}, {doc: structuredClone(start), old: false}, {doc: structuredClone(start), old: true}];
		let server = structuredClone(start);
		let clock = Date.parse(at(0));

		const sync = (phone) => {
			const merged = phone.old ? v21.mergeDocuments(phone.doc, server) : mergeDocuments(phone.doc, server);

			server = structuredClone(merged);
			phone.doc = structuredClone(merged);
		};

		for (let step = 0; step < 80; step++) {
			const phone = phones[Math.floor(rand() * phones.length)];

			if (rand() < 0.35) {
				sync(phone);
			}
			else {
				clock += 1000 + Math.floor(rand() * 5000);
				randomChange(phone, rand, clock);
			}
		}

		for (let round = 0; round < 4; round++) {
			phones.forEach(sync);
		}

		const want = stableJson(server);

		phones.forEach((phone, i) => assert.equal(stableJson(phone.doc), want, `seed ${seed}: phone ${i} matches the server`));
	}
});
