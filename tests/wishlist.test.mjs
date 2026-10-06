// Unit tests for the pure parts of js/wishlist.js: matching for the scanner,
// owned detection, spares, the builders, and how wishlist entries survive the
// document merge. Run: node --test tests/wishlist.test.mjs

import assert from 'node:assert/strict';
import test, {describe} from 'node:test';

import {mergeDocuments, nextStamp, sameContent} from '../js/merge.js';
import {
	copyFits,
	deletedWish,
	editedWish,
	languagesFor,
	newWish,
	ownedCopies,
	parseQuery,
	sameNumber,
	sortWishes,
	sparesFor,
	variantLabel,
	wishedBy,
} from '../js/wishlist.js';

const at = (minute) => `2026-10-01T10:${String(minute).padStart(2, '0')}:00.000Z`;

const wish = (id, cardId, fields = {}) => newWish(cardId, fields, at(0), id);

const copy = (id, cardId, fields = {}) => ({card_id: cardId, catalog: 'international', created_at: at(0), deleted_at: null, id, language: 'en', updated_at: at(0), variant_id: null, ...fields});

const REVERSE = 'rev-pinsir';
const NORMAL = 'norm-pinsir';

describe('wishedBy', () => {
	const family = [
		{name: 'Member A', user_id: 'u-ana', wishlist: [
			wish('a1', 'sv08.5-003'),
			wish('a2', 'swsh3-102', {language: 'pt'}),
		]},
		{doc: {wishlist: [
			wish('b1', 'sv08.5-003', {language: 'pt', priority: 'high', variantId: REVERSE}),
			{...wish('b2', 'me01-001'), deleted_at: at(3)},
		]}, name: 'Member B', user_id: 'u-bia'},
		{name: 'Member C', user_id: 'u-caio', wishlist: [wish('c1', 'S4a-001', {catalog: 'ja'})]},
	];

	test('an item with no language or finish matches any copy of the card', () => {
		const rows = wishedBy('sv08.5-003', {language: 'en', variantId: NORMAL}, family);

		assert.deepEqual(rows.map((row) => row.userId), ['u-ana']);
		assert.deepEqual(rows[0].unconfirmed, []);
	});

	test('an item naming a language and a finish matches only that print', () => {
		const rows = wishedBy('sv08.5-003', {language: 'pt', variantId: REVERSE}, family);

		// High priority first, and whole documents work as well as wishlists.
		assert.deepEqual(rows.map((row) => [row.name, row.item.id]), [['Member B', 'b1'], ['Member A', 'a1']]);
		assert.equal(wishedBy('sv08.5-003', {language: 'pt', variantId: NORMAL}, family).some((row) => row.item.id === 'b1'), false, 'wrong finish');
		assert.equal(wishedBy('sv08.5-003', {language: 'en', variantId: REVERSE}, family).some((row) => row.item.id === 'b1'), false, 'wrong language');
	});

	test('a scan that does not say yet still matches, with the open field named', () => {
		const rows = wishedBy('sv08.5-003', {}, family);
		const bia = rows.find((row) => row.item.id === 'b1');

		assert.deepEqual(bia.unconfirmed, ['language', 'variant']);
		assert.deepEqual(wishedBy('sv08.5-003', {language: 'pt'}, family).find((row) => row.item.id === 'b1').unconfirmed, ['variant']);
		assert.deepEqual(wishedBy('swsh3-102', {variantId: NORMAL}, family).map((row) => row.unconfirmed), [['language']]);
	});

	test('a language requirement is checked', () => {
		assert.equal(wishedBy('swsh3-102', {language: 'pt'}, family).length, 1);
		assert.equal(wishedBy('swsh3-102', {language: 'en'}, family).length, 0);
	});

	test('deleted items and other catalogs do not match', () => {
		assert.equal(wishedBy('me01-001', {language: 'en'}, family).length, 0);
		assert.equal(wishedBy('S4a-001', {language: 'ja'}, family).length, 1);
		assert.equal(wishedBy('S4a-001', {language: 'ko'}, family).length, 0, 'the Korean catalog reuses the ID');
		assert.equal(wishedBy('S4a-001', {catalog: 'ko'}, family).length, 0);
		assert.equal(wishedBy('nope-1', {}, family).length, 0);
		assert.deepEqual(wishedBy('sv08.5-003', {}, []), []);
		assert.deepEqual(wishedBy('sv08.5-003', {}, [null, {}]), []);
	});
});

describe('owned detection', () => {
	const cards = [
		copy('c1', 'sv08.5-003', {language: 'pt', variant_id: NORMAL}),
		copy('c2', 'sv08.5-003', {deleted_at: at(2), language: 'pt', variant_id: REVERSE}),
		copy('c3', 'S4a-001', {catalog: 'ko', language: 'ko'}),
	];

	test('any live copy of the card counts when the item names nothing', () => {
		assert.deepEqual(ownedCopies(wish('w', 'sv08.5-003'), cards).map((entry) => entry.id), ['c1']);
	});

	test('the language and the finish count when the item names them', () => {
		assert.equal(ownedCopies(wish('w', 'sv08.5-003', {language: 'pt'}), cards).length, 1);
		assert.equal(ownedCopies(wish('w', 'sv08.5-003', {language: 'en'}), cards).length, 0);
		assert.equal(ownedCopies(wish('w', 'sv08.5-003', {variantId: NORMAL}), cards).length, 1);
		assert.equal(ownedCopies(wish('w', 'sv08.5-003', {variantId: REVERSE}), cards).length, 0, 'the reverse holo was deleted');
	});

	test('the catalog must match, and an entry with no catalog is international', () => {
		assert.equal(ownedCopies(wish('w', 'S4a-001', {catalog: 'ja'}), cards).length, 0);
		assert.equal(ownedCopies(wish('w', 'S4a-001', {catalog: 'ko'}), cards).length, 1);

		const old = copy('c9', 'base1-4');

		delete old.catalog;
		assert.ok(copyFits(wish('w', 'base1-4'), old));
	});
});

describe('spares', () => {
	test('one copy is a keeper, the second in the same language is a spare', () => {
		const item = wish('w', 'me01-001', {language: 'pt'});

		assert.equal(sparesFor(item, [copy('a', 'me01-001', {language: 'pt'})]), 0);
		assert.equal(sparesFor(item, [copy('a', 'me01-001', {language: 'pt'}), copy('b', 'me01-001', {language: 'pt'})]), 1);
		assert.equal(sparesFor(item, [copy('a', 'me01-001', {language: 'pt'}), copy('b', 'me01-001', {language: 'en'})]), 0, 'a PT and an EN copy are both keepers');
	});

	test('an item with no language counts spares in every language', () => {
		const cards = [
			copy('a', 'me01-001', {language: 'pt'}),
			copy('b', 'me01-001', {language: 'pt'}),
			copy('c', 'me01-001', {language: 'en'}),
			copy('d', 'me01-001', {language: 'en'}),
			copy('e', 'me01-001', {language: 'en'}),
			copy('f', 'me01-001', {deleted_at: at(1), language: 'en'}),
		];

		assert.equal(sparesFor(wish('w', 'me01-001'), cards), 3);
		assert.equal(sparesFor(wish('w', 'me01-001', {language: 'en'}), cards), 2);
	});

	test('a named finish counts only copies in it, keeping another copy when there is one', () => {
		const item = wish('w', 'sv08.5-003', {language: 'pt', variantId: REVERSE});

		assert.equal(sparesFor(item, [copy('a', 'sv08.5-003', {language: 'pt', variant_id: NORMAL}), copy('b', 'sv08.5-003', {language: 'pt', variant_id: REVERSE})]), 1);
		assert.equal(sparesFor(item, [copy('a', 'sv08.5-003', {language: 'pt', variant_id: NORMAL}), copy('b', 'sv08.5-003', {language: 'pt', variant_id: NORMAL})]), 0);
		assert.equal(sparesFor(item, [copy('a', 'sv08.5-003', {language: 'pt', variant_id: REVERSE}), copy('b', 'sv08.5-003', {language: 'pt', variant_id: REVERSE})]), 1);
		assert.equal(sparesFor(item, [copy('a', 'sv08.5-003', {language: 'pt', variant_id: REVERSE})]), 0, 'the only copy is a keeper');
	});
});

describe('builders', () => {
	test('a new item has the merge fields and sensible defaults', () => {
		const item = wish('w1', 'sv08.5-003');

		assert.deepEqual(item, {
			card_id: 'sv08.5-003', catalog: 'international', created_at: at(0), deleted_at: null, id: 'w1',
			language: null, note: '', priority: 'normal', updated_at: at(0), variant_id: null,
		});
		assert.equal(newWish('S4a-001', {language: 'ja'}).catalog, 'ja');
		assert.match(newWish('x-1').id, /^[0-9a-f-]{36}$/);
	});

	test('bad values are refused', () => {
		assert.throws(() => newWish('', {}), /needs a card/);
		assert.throws(() => newWish('x-1', {priority: 'urgent'}), /high, normal, or low/);
		assert.throws(() => newWish('x-1', {catalog: 'international', language: 'ja'}), /cannot be wished for in ja/);
		assert.throws(() => newWish('x-1', {catalog: 'mars'}), /Unknown catalog/);
	});

	test('notes are trimmed and capped', () => {
		assert.equal(wish('w', 'x-1', {note: '  for the binder  '}).note, 'for the binder');
		assert.equal(wish('w', 'x-1', {note: 'a'.repeat(900)}).note.length, 500);
	});

	test('an edit is a new copy with a newer stamp, and the original is untouched', () => {
		const item = wish('w', 'x-1');
		const next = editedWish(item, {note: 'mint only', priority: 'high'}, Date.parse(at(0)));

		assert.equal(item.priority, 'normal');
		assert.equal(next.priority, 'high');
		assert.equal(next.note, 'mint only');
		assert.ok(Date.parse(next.updated_at) > Date.parse(item.updated_at), 'strictly newer even in the same millisecond');
		assert.equal(editedWish(item, {variantId: 'v1'}).variant_id, 'v1');
		assert.equal(editedWish({...item, variant_id: 'v1'}, {variantId: null}).variant_id, null);
		assert.equal(nextStamp(at(5), Date.parse(at(9))), at(9));
	});

	test('a removal is a tombstone', () => {
		const gone = deletedWish(wish('w', 'x-1'));

		assert.ok(gone.deleted_at);
		assert.equal(gone.deleted_at, gone.updated_at);
		assert.deepEqual(sortWishes([gone]), []);
	});

	test('the list sorts high priority first, then newest added', () => {
		const items = [
			newWish('a-1', {priority: 'low'}, at(1), 'low'),
			newWish('b-1', {}, at(2), 'normal-old'),
			newWish('c-1', {priority: 'high'}, at(1), 'high'),
			newWish('d-1', {}, at(4), 'normal-new'),
		];

		assert.deepEqual(sortWishes(items).map((item) => item.id), ['high', 'normal-new', 'normal-old', 'low']);
	});

	test('languages follow the catalog', () => {
		assert.deepEqual(languagesFor('international').map((lang) => lang.code), ['en', 'pt', 'fr']);
		assert.deepEqual(languagesFor('ja').map((lang) => lang.code), ['ja']);
	});

	test('finish labels match the card detail wording', () => {
		assert.equal(variantLabel({type: 'reverse', foil: 'pokeball'}), 'Reverse holo, Poké Ball pattern');
		assert.equal(variantLabel({stamp: ['1st-edition'], type: 'holo'}), 'Holo, 1st Edition stamp');
		assert.equal(variantLabel(null), 'Any finish');
	});
});

describe('merge survival', () => {
	const doc = (wishlist) => ({binders: [], cards: [], collections: [], goals: [], openings: [], updated_at: at(0), wishlist});

	test('wishlist entries merge field by field: a priority on one phone and a note on another both stay', () => {
		const base = wish('w1', 'sv08.5-003');
		const phone = editedWish(base, {priority: 'high'}, Date.parse(at(2)));
		const laptop = editedWish(base, {note: 'laptop'}, Date.parse(at(1)));

		for (const merged of [mergeDocuments(doc([phone]), doc([laptop])), mergeDocuments(doc([laptop]), doc([phone]))]) {
			assert.equal(merged.wishlist.length, 1);
			assert.equal(merged.wishlist[0].priority, 'high');
			assert.equal(merged.wishlist[0].note, 'laptop');
		}

		// The same field edited on both: the later edit wins.
		const later = editedWish(base, {note: 'later'}, Date.parse(at(4)));

		assert.equal(mergeDocuments(doc([later]), doc([laptop])).wishlist[0].note, 'later');
		assert.equal(mergeDocuments(doc([laptop]), doc([later])).wishlist[0].note, 'later');
	});

	test('a removal is not brought back by an offline phone holding an older copy', () => {
		const base = wish('w1', 'sv08.5-003');
		const offlineEdit = editedWish(base, {note: 'edited offline'}, Date.parse(at(3)));
		const removed = deletedWish(base, Date.parse(at(5)));

		for (const merged of [mergeDocuments(doc([offlineEdit]), doc([removed])), mergeDocuments(doc([removed]), doc([offlineEdit]))]) {
			assert.equal(merged.wishlist.length, 1);
			assert.ok(merged.wishlist[0].deleted_at);
			assert.deepEqual(sortWishes(merged.wishlist), []);
		}
	});

	test('two devices adding different items keep both, and the merge settles', () => {
		const a = doc([newWish('a-1', {}, at(1), 'phone')]);
		const b = doc([newWish('b-1', {priority: 'high'}, at(2), 'laptop')]);
		const ab = mergeDocuments(a, b);

		assert.deepEqual(ab.wishlist.map((item) => item.id).sort(), ['laptop', 'phone']);
		assert.ok(sameContent(ab, mergeDocuments(b, a)));
		assert.ok(sameContent(mergeDocuments(ab, b), ab));
	});

	test('a wishlist saved the way the app saves it (a document holding only that entry) merges in', () => {
		const local = doc([wish('w1', 'x-1'), wish('w2', 'x-2')]);
		const change = editedWish(local.wishlist[1], {priority: 'low'});
		const merged = mergeDocuments(local, {wishlist: [change]});

		assert.equal(merged.wishlist.length, 2);
		assert.equal(merged.wishlist.find((item) => item.id === 'w2').priority, 'low');
		assert.deepEqual(merged.cards, []);
	});

	const live = (list) => list.filter((item) => !item.deleted_at);

	test('the same card wished on two phones merges into one item', () => {
		const phone = newWish('sv08.5-003', {language: 'pt'}, at(1), 'phone');
		const laptop = newWish('sv08.5-003', {language: 'pt'}, at(2), 'laptop');

		for (const merged of [mergeDocuments(doc([phone]), doc([laptop])), mergeDocuments(doc([laptop]), doc([phone]))]) {
			assert.deepEqual(live(merged.wishlist).map((item) => item.id), ['phone']);
			assert.equal(merged.wishlist.find((item) => item.id === 'laptop').merged_into, 'phone');
			assert.equal(sortWishes(merged.wishlist).length, 1);
		}

		assert.ok(sameContent(mergeDocuments(doc([phone]), doc([laptop])), mergeDocuments(doc([laptop]), doc([phone]))));

		// Removing the survivor removes the wish everywhere.
		const merged = mergeDocuments(doc([phone]), doc([laptop]));
		const removed = deletedWish(live(merged.wishlist)[0], Date.parse(at(9)));

		assert.deepEqual(live(mergeDocuments(merged, {wishlist: [removed]}).wishlist), []);
	});

	test('a duplicate made by an edit is merged too', () => {
		const first = wish('w1', 'sv08.5-003', {language: 'pt'});
		const second = wish('w2', 'sv08.5-003', {language: 'en'});
		const local = doc([first, second]);
		// The second item is changed to Portuguese: now it asks for the same
		// print as the first.
		const change = editedWish(second, {language: 'pt'}, Date.parse(at(3)));
		const merged = mergeDocuments(local, {wishlist: [change]});

		assert.equal(live(merged.wishlist).length, 1);
		assert.equal(live(merged.wishlist)[0].id, 'w1');
	});

	test('the survivor keeps the earliest date, and the newest note and priority', () => {
		const older = editedWish(newWish('sv08.5-003', {note: 'the old note'}, at(1), 'older'), {}, Date.parse(at(2)));
		const newer = editedWish(newWish('sv08.5-003', {}, at(3), 'newer'), {priority: 'high'}, Date.parse(at(6)));
		const middle = editedWish(newWish('sv08.5-003', {note: 'middle note'}, at(4), 'middle'), {priority: 'low'}, Date.parse(at(5)));
		const merged = mergeDocuments(doc([older, middle]), doc([newer]));
		const [kept] = live(merged.wishlist);

		assert.equal(kept.id, 'older');
		assert.equal(kept.created_at, at(1));
		assert.equal(kept.priority, 'high', 'from the most recently edited item');
		assert.equal(kept.note, 'middle note', 'the newest note that is not empty');
		assert.ok(kept.updated_at > at(6));

		// Different languages or finishes stay separate items.
		const apart = mergeDocuments(doc([newWish('x-1', {language: 'pt'}, at(1), 'p')]), doc([newWish('x-1', {language: 'en'}, at(1), 'e'), newWish('x-1', {variantId: 'holo'}, at(1), 'h')]));

		assert.equal(live(apart.wishlist).length, 3);
	});
});

describe('search parsing', () => {
	test('names, numbers, totals, and card IDs', () => {
		assert.deepEqual(parseQuery('Pinsir'), {name: 'Pinsir', number: null, total: null});
		assert.deepEqual(parseQuery(' Pinsir  3 '), {name: 'Pinsir', number: '3', total: null});
		assert.deepEqual(parseQuery('3/131'), {name: '', number: '3', total: 131});
		assert.deepEqual(parseQuery('#003 / 131'), {name: '', number: '003', total: 131});
		assert.deepEqual(parseQuery('Pikachu TG10'), {name: 'Pikachu', number: 'TG10', total: null});
		assert.deepEqual(parseQuery('Porygon2'), {name: 'Porygon2', number: null, total: null});
		assert.deepEqual(parseQuery('sv08.5-003'), {cardId: 'sv08.5-003', name: '', number: null, total: null});
		assert.deepEqual(parseQuery('Mr. Mime'), {name: 'Mr. Mime', number: null, total: null});
		assert.deepEqual(parseQuery(''), {name: '', number: null, total: null});
	});

	test('"001" and "1" are the same number', () => {
		assert.ok(sameNumber('001', '1'));
		assert.ok(sameNumber('TG10', 'tg10'));
		assert.ok(!sameNumber('13', '3'));
	});
});
