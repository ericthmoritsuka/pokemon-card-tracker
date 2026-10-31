// Unit tests for Import "Match this file" (js/match-file.js planMatch and
// undoPlan): copies matched by count per card, language, and finish, app
// copies included; the oldest kept; a deleted copy's import_key never
// blocks an add; condition, Stored in, and favorite carried over; pockets
// given another copy or a placeholder; cards the file could not match left
// alone; photos and notes untouched; Undo back to the state before. Plain
// Node, invented data only.
//
// Run: node --test tests/match-file.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {groupKey, planMatch, undoPlan} from '../js/match-file.js';
import {placements, slotsOf} from '../js/binders.js';
import {importEntries} from '../js/monprice.js';
import {moveToCardInfo} from '../js/card-info.js';

const at = (minute) => `2026-10-01T10:${String(minute).padStart(2, '0')}:00.000Z`;
const NOW = Date.parse('2026-10-30T12:00:00.000Z');

let serial = 0;

// A live copy; id and created_at from its minute unless given.
function copy(minute, fields = {}) {
	serial++;

	return {
		card_id: 'tst1-001',
		catalog: 'international',
		created_at: at(minute),
		deleted_at: null,
		id: `00000000-0000-4000-8000-${String(serial).padStart(12, '0')}`,
		language: 'pt',
		updated_at: at(minute),
		variant_id: 'normal',
		...fields,
	};
}

// One matched monprice row, as js/monprice.js matchRows returns it.
const row = (monpriceId, cardId, count, {finish = 'NORMAL', language = 'pt', variantId = 'normal'} = {}) => ({
	cardId,
	catalog: 'international',
	row: {count, finish, language, monpriceId, name: `Invented ${cardId}`, number: cardId.split('-').pop(), setName: 'Invented set'},
	status: 'matched',
	variantId,
});

const binderOf = (id, slots = []) => ({
	art: [], cols: 3, cover_color: '#1b1b1f', created_at: at(0), deleted_at: null, id, name: `Binder ${id}`,
	notes: '', page_count: 2, rows: 3, slots, updated_at: at(0),
});

const pocket = (position, content) => ({page: 1, placed_at: at(1), position, ...content});

const live = (cards) => cards.filter((card) => !card.deleted_at);

describe('planMatch counts', () => {
	test('app copies with no import_key count; the oldest are kept and the extras removed', () => {
		const old = copy(1, {import_key: 'monprice|tst1_int_1|pt|NORMAL|0'});
		const scanned = copy(2, {language_source: 'scan'});
		const newer = copy(3);
		const doc = {binders: [], cards: [newer, scanned, old]};
		const plan = planMatch(doc, importEntries([row('tst1_int_1', 'tst1-001', 2)]), {now: NOW});

		assert.deepEqual([plan.counts.added, plan.counts.removed, plan.counts.kept], [0, 1, 2]);
		assert.deepEqual(live(plan.cards).map((card) => card.id).sort(), [old.id, scanned.id].sort());

		const gone = plan.cards.find((card) => card.id === newer.id);

		assert.ok(gone.deleted_at, 'a soft delete: the entry stays as a tombstone');
		assert.equal(gone.field_stamps.at, gone.updated_at, 'stamped as an edit');
		assert.equal(doc.cards[0].deleted_at, null, 'the document passed in is not changed');
		// The kept app copy takes the file's free key, so the normal import of
		// the same file adds nothing afterwards.
		assert.equal(plan.cards.find((card) => card.id === scanned.id).import_key, 'monprice|tst1_int_1|pt|NORMAL|1');
	});

	test('ties on created_at keep the lower id', () => {
		const a = copy(5);
		const b = copy(5);
		const plan = planMatch({cards: [b, a]}, importEntries([row('tst1_int_1', 'tst1-001', 1)]), {now: NOW});

		assert.deepEqual(live(plan.cards).map((card) => card.id), [[a.id, b.id].sort()[0]]);
	});

	test('the shortfall is added, and a deleted copy with the same import_key does not block it', () => {
		const key = 'monprice|tst1_int_1|pt|NORMAL|0';
		const tombstone = copy(1, {deleted_at: at(2), id: 'aaaaaaaa-0000-5000-8000-000000000001', import_key: key, updated_at: at(2)});
		const ids = new Map([[key, tombstone.id]]);
		const plan = planMatch({cards: [tombstone]}, importEntries([row('tst1_int_1', 'tst1-001', 2)]), {ids, now: NOW});
		const added = live(plan.cards);

		assert.equal(plan.counts.added, 2);
		assert.equal(added.length, 2);
		assert.ok(added.every((card) => card.id !== tombstone.id), 'a taken id is never reused');
		assert.deepEqual(added.map((card) => card.import_key).sort(), [key, 'monprice|tst1_int_1|pt|NORMAL|1']);
		assert.ok(added.every((card) => card.card_id === 'tst1-001' && card.language === 'pt' && card.variant_id === 'normal' && card.language_source === 'import'));
		assert.equal(plan.cards.find((card) => card.id === tombstone.id).deleted_at, at(2), 'the tombstone stays deleted');
	});

	test('a card, language, or finish the file does not name is removed; another finish is its own group', () => {
		const holo = copy(1, {variant_id: 'holo'});
		const english = copy(2, {language: 'en'});
		const other = copy(3, {card_id: 'tst1-002'});
		const plain = copy(4);
		const plan = planMatch({cards: [holo, english, other, plain]}, importEntries([row('tst1_int_1', 'tst1-001', 1)]), {now: NOW});

		assert.deepEqual(live(plan.cards).map((card) => card.id), [plain.id]);
		assert.equal(plan.counts.removed, 3);
	});

	test('rows the file could not match leave their cards alone, and so do hand-made cards and untick large rows', () => {
		const byKey = copy(1, {card_id: 'tst9-050', import_key: 'monprice|tst9_int_50|pt|NORMAL|0'});
		const byNumber = copy(2, {card_id: 'tst8-TG07', language: 'en'});
		const hand = copy(3, {card_id: `hand_${'b'.repeat(32)}`, catalog: 'custom', variant_id: null});
		const large = copy(4, {card_id: 'tst1-003'});
		const sold = copy(5, {card_id: 'tst1-004'});
		const unmatched = [
			{catalog: 'international', row: {language: 'pt', monpriceId: 'tst9_int_50', number: '050/100'}, status: 'unmatched'},
			{catalog: 'international', row: {language: 'en', monpriceId: 'zzz_int_TG7', number: 'TG07/TG30'}, status: 'unmatched'},
		];
		const skipped = importEntries([row('tst1_int_3', 'tst1-003', 60)]);
		const plan = planMatch({cards: [byKey, byNumber, hand, large, sold]}, importEntries([row('tst1_int_1', 'tst1-001', 1)]), {now: NOW, skipped, unmatched});

		assert.deepEqual(live(plan.cards).map((card) => card.card_id).sort(), ['hand_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'tst1-001', 'tst1-003', 'tst8-TG07', 'tst9-050']);
		assert.deepEqual([plan.counts.removed, plan.counts.leftAlone, plan.counts.hand], [1, 3, 1]);
		assert.ok(plan.cards.find((card) => card.id === sold.id).deleted_at, 'a card the file matched elsewhere and does not name is removed');
	});
});

describe('planMatch carry-over', () => {
	test('only the surplus is removed; what a removed copy holds goes to a blank kept copy, own finish first', () => {
		const reverseOld = copy(0, {variant_id: 'reverse'});
		const kept = copy(1);
		const keptDone = copy(2, {condition: 'Near Mint'});
		const donorA = copy(3, {condition: 'Lightly Played', is_favorite: true, storage: 'Box A', variant_id: 'holo'});
		const donorB = copy(4, {grade: '9', grader: 'PSA', purchase_currency: 'BRL', purchase_price: 40, storage: 'Box B', variant_id: 'holo'});
		const donorC = copy(5, {condition: 'Damaged', variant_id: 'holo'});
		const reverseDonor = copy(6, {storage: 'Box R', variant_id: 'reverse'});
		const before = [reverseOld, kept, keptDone, donorA, donorB, donorC, reverseDonor];
		const entries = importEntries([
			row('tst1_int_1', 'tst1-001', 3),
			row('tst1_int_1', 'tst1-001', 1, {finish: 'REVERSE_HOLOFOIL', variantId: 'reverse'}),
		]);
		const plan = planMatch({cards: before}, entries, {now: NOW});
		const after = live(plan.cards);
		const byId = new Map(after.map((card) => [card.id, card]));

		// Seven copies, four in the file: three go, none is added.
		assert.deepEqual([plan.counts.added, plan.counts.removed, plan.counts.carried, plan.counts.kept], [0, 3, 1, 4]);
		assert.ok(byId.has(reverseDonor.id) && !byId.has(reverseOld.id), 'a copy holding something he set is kept before a blank one of its finish');
		assert.equal(byId.get(donorA.id).variant_id, 'normal', 'a copy of another finish fills the third plain copy, relabelled from the file');
		assert.deepEqual([byId.get(donorA.id).condition, byId.get(donorA.id).storage, byId.get(donorA.id).is_favorite], ['Lightly Played', 'Box A', true]);
		assert.deepEqual(
			['grade', 'grader', 'purchase_currency', 'purchase_price', 'storage'].map((key) => byId.get(kept.id)[key]),
			['9', 'PSA', 'BRL', 40, 'Box B'],
			'every field he set moves from the oldest removed donor to the blank kept copy'
		);
		assert.equal(byId.get(keptDone.id).storage, undefined, 'a copy with its own details is not a target');
		assert.equal(after.filter((card) => card.condition === 'Damaged').length, 0, 'no blank copy is left for the last donor');
	});

	test('a removed copy\'s place in a hand-picked collection goes to the copy that takes its details', () => {
		const sameRow = copy(1, {import_key: 'monprice|tst1_int_1|pt|NORMAL|0'});
		const donor = copy(2, {condition: 'Near Mint', variant_id: 'holo'});
		const collection = {created_at: at(0), deleted_at: null, entry_ids: {[donor.id]: at(5)}, id: 'c1', kind: 'hand', name: 'Invented', rule: null, updated_at: at(5)};
		const plan = planMatch({binders: [], cards: [sameRow, donor], collections: [collection]}, importEntries([row('tst1_int_1', 'tst1-001', 1)]), {now: NOW});
		const [joined] = plan.collections;

		assert.ok(plan.cards.find((card) => card.id === donor.id).deleted_at, 'the import_key match is kept before the collection member');
		assert.equal(plan.cards.find((card) => card.id === sameRow.id).condition, 'Near Mint');
		assert.ok(joined.entry_ids[sameRow.id], 'the kept copy joins the collection');
		assert.ok(joined.entry_ids[donor.id], 'the removed copy keeps its own place, for Undo');

		undoPlan(plan, plan.undo, NOW + 1000);
		assert.equal(plan.collections[0].entry_ids[sameRow.id], undefined, 'Undo takes the kept copy out again');
		assert.equal(plan.cards.find((card) => card.id === sameRow.id).condition, undefined);
	});

	test('a removed English copy never gives its details to a Portuguese one', () => {
		const pt = copy(1);
		const en = copy(2, {condition: 'Damaged', language: 'en'});
		const plan = planMatch({cards: [pt, en]}, importEntries([row('tst1_int_1', 'tst1-001', 1)]), {now: NOW});

		assert.equal(live(plan.cards)[0].condition, undefined);
	});
});

describe('planMatch pockets', () => {
	test('a removed copy\'s pocket takes another unplaced copy of the card, or becomes its placeholder', () => {
		const a = copy(1);
		const b = copy(2);
		const c = copy(3, {variant_id: 'holo'});
		const gone = copy(4, {card_id: 'tst1-002', name_local: 'Invented two'});
		const binder = binderOf('b1', [pocket(1, {entry_id: c.id}), pocket(2, {entry_id: gone.id})]);
		const plan = planMatch({binders: [binder], cards: [a, b, c, gone]}, importEntries([row('tst1_int_1', 'tst1-001', 2)]), {now: NOW});
		const slots = slotsOf(plan.binders[0], placements(plan.binders));

		assert.deepEqual([plan.counts.pocketsMoved, plan.counts.pocketsToPlaceholder], [1, 1]);
		assert.ok(plan.cards.find((card) => card.id === c.id).deleted_at, 'the plain copies match the file\'s finish first');
		assert.equal(slots.find((slot) => slot.position === 1).entry_id, a.id, 'the oldest unplaced copy takes the pocket');
		assert.deepEqual(slots.find((slot) => slot.position === 2).want, {card_id: 'tst1-002', catalog: 'international', image: null, name: 'Invented two', variant_id: 'normal'});
		assert.equal(binder.slots.length, 2, 'the binder passed in is not changed');
	});

	test('a placed copy of another finish is kept and relabelled; its pocket stays', () => {
		const wrongFinish = copy(1, {variant_id: 'holo'});
		const binder = binderOf('b1', [pocket(5, {entry_id: wrongFinish.id})]);
		const plan = planMatch({binders: [binder], cards: [wrongFinish]}, importEntries([row('tst1_int_1', 'tst1-001', 1)]), {now: NOW});
		const [kept] = live(plan.cards);
		const [slot] = slotsOf(plan.binders[0], placements(plan.binders));

		assert.deepEqual([kept.id, kept.variant_id, plan.counts.added, plan.counts.removed], [wrongFinish.id, 'normal', 0, 0]);
		assert.equal(slot.entry_id, wrongFinish.id);
		assert.equal(plan.binders[0], binder, 'the binder is not touched');
	});

	test('a removed copy in a tray gives its place to an unplaced copy, or leaves the tray; Undo puts it back', () => {
		const a = copy(1, {import_key: 'monprice|tst1_int_1|pt|NORMAL|0'});
		const staged = copy(2, {variant_id: 'holo'});
		const b = copy(3, {card_id: 'tst1-002'});
		const stagedB = copy(4, {card_id: 'tst1-002', variant_id: 'holo'});
		const binder = {...binderOf('b1'), staged: [staged.id, stagedB.id]};
		const doc = {binders: [binder], cards: [a, staged, b, stagedB]};
		// tst1-001: a is kept by its key, the staged holo goes and a takes its
		// tray place; tst1-002 is not in the file, so both go.
		const plan = planMatch(doc, importEntries([row('tst1_int_1', 'tst1-001', 1)]), {now: NOW});

		assert.deepEqual(plan.binders[0].staged, [a.id]);
		undoPlan(plan, plan.undo, NOW + 1000);
		assert.deepEqual(plan.binders[0].staged, [staged.id, stagedB.id]);
	});

	test('a rule binder\'s hand pick of a removed copy is left alone', () => {
		const a = copy(1);
		const b = copy(2);
		const picks = [{binder_id: 'r1', created_at: at(3), deleted_at: null, entry_id: b.id, id: 'r1|x', key: 'x', updated_at: at(3)}];
		const plan = planMatch({binder_picks: picks, binders: [], cards: [a, b]}, importEntries([row('tst1_int_1', 'tst1-001', 1)]), {now: NOW});

		assert.equal(plan.binder_picks, undefined, 'the plan writes no picks: the binder shows its default copy until Undo');
	});
});

describe('photos and notes', () => {
	test('removing copies never touches the card records, and the preview counts the photos kept', () => {
		const a = copy(1);
		const b = copy(2);
		const record = {
			card_id: 'tst1-001', catalog: 'international', created_at: at(0), deleted_at: null, id: 'international~tst1-001~pt', language: 'pt',
			main_image: {photo_id: 'p2'}, notes: 'Bought at a fair', updated_at: at(0),
			photos: [{id: 'p1', path: 'u/p1.webp'}, {id: 'p2', path: 'u/p2.webp'}, {deleted_at: at(1), id: 'p3', path: 'u/p3.webp'}],
		};
		const doc = {binders: [], card_info: [record], cards: [a, b]};
		const frozen = structuredClone(doc.card_info);
		const plan = planMatch(doc, [], {now: NOW});

		assert.equal(plan.counts.removed, 2);
		assert.equal(plan.counts.photosKept, 2);
		assert.deepEqual(doc.card_info, frozen);
		assert.equal(plan.card_info, undefined, 'the plan has no card records to write');
		assert.ok(plan.cards.every((card) => card.photos === undefined && card.notes === undefined));
	});
});

describe('photos an older phone left on a copy', () => {
	test('a removed copy keeps them, so they still move to the card record', () => {
		const a = copy(1);
		const b = copy(2, {photos: [{id: 'p9', path: 'u/p9.webp', uploaded_at: at(2)}]});
		const plan = planMatch({binders: [], cards: [a, b]}, importEntries([row('tst1_int_1', 'tst1-001', 1)]), {now: NOW});
		const removed = plan.cards.find((card) => card.id === b.id);

		assert.ok(removed.deleted_at);
		assert.deepEqual(removed.photos.map((photo) => photo.id), ['p9']);

		const doc = {card_info: [], cards: plan.cards};

		moveToCardInfo(doc, NOW);
		assert.deepEqual(doc.card_info[0].photos.map((photo) => photo.id), ['p9']);
	});
});

describe('undoPlan', () => {
	test('puts every copy and pocket back as it was', () => {
		const a = copy(1);
		const b = copy(2, {condition: 'Lightly Played'});
		const gone = copy(3, {card_id: 'tst1-002', storage: 'Box Z'});
		const binder = binderOf('b1', [pocket(1, {entry_id: b.id}), pocket(2, {entry_id: gone.id})]);
		const doc = {binders: [binder], cards: [a, b, gone]};
		const before = structuredClone(doc);
		const plan = planMatch(doc, importEntries([row('tst1_int_1', 'tst1-001', 1), row('tst1_int_9', 'tst1-009', 1)]), {now: NOW});

		const applied = {binders: plan.binders, cards: plan.cards};

		undoPlan(applied, plan.undo, NOW + 1000);

		const content = (card) => Object.fromEntries(Object.entries(card).filter(([key]) => !['field_stamps', 'restored_at', 'updated_at'].includes(key)));

		assert.deepEqual(live(applied.cards).map(content), before.cards.map(content));
		assert.equal(applied.cards.length, 4, 'the added copy stays as a tombstone, for the sync');

		const shown = (binders) => slotsOf(binders[0], placements(binders)).map(({entry_id: id, page, position, want}) => ({id, page, position, want}));

		assert.deepEqual(shown(applied.binders), shown(before.binders));
		assert.ok(applied.cards.find((card) => card.id === gone.id).restored_at, 'restored so the merge lets it win over the tombstone');
	});
});

// The rule (Eric, 2026-10-30): a copy he still owns is never removed and
// replaced by a new blank one, whatever finish label either side carries.
describe('a copy he still owns is kept', () => {
	const owned = {cert_number: 'C-1', condition: 'Near Mint', grade: '9', graded_price: 300, grader: 'PSA', is_favorite: true, opening_id: 'o1', price_manual: {avg: 10}, purchase_currency: 'BRL', purchase_price: 50, storage: 'Box A'};

	test('an old copy with the raw finish takes the variant the rescan found', () => {
		const old = copy(1, {...owned, finish_raw: 'HOLOFOIL', import_key: 'monprice|M1|pt|HOLOFOIL|0', variant_id: null});
		const plan = planMatch({binders: [], cards: [old]}, importEntries([row('M1', 'tst1-001', 1, {finish: 'HOLOFOIL', variantId: 'holo'})]), {now: NOW});
		const [kept] = live(plan.cards);

		assert.deepEqual([plan.counts.added, plan.counts.removed, plan.counts.kept], [0, 0, 1]);
		assert.equal(kept.id, old.id);
		assert.equal(kept.variant_id, 'holo');
		assert.equal(Object.hasOwn(kept, 'finish_raw'), false);
		assert.deepEqual(Object.fromEntries(Object.keys(owned).map((key) => [key, kept[key]])), owned, 'every field he set stays');
	});

	test('a copy with a variant stays as it is when the rescan found none', () => {
		const old = copy(1, {...owned, import_key: 'monprice|M1|pt|HOLOFOIL|0', variant_id: 'holo'});
		const plan = planMatch({binders: [], cards: [old]}, importEntries([row('M1', 'tst1-001', 1, {finish: 'HOLOFOIL', variantId: null})]), {now: NOW});

		assert.deepEqual([plan.counts.added, plan.counts.removed], [0, 0]);
		assert.equal(plan.cards[0], old, 'nothing to change');
	});

	test('app copies with no finish, or another finish, are kept and take the file\'s', () => {
		const none = copy(1, {...owned, variant_id: null});
		const other = copy(2, {condition: 'Damaged', variant_id: 'reverse'});
		const plan = planMatch({binders: [], cards: [none, other]}, importEntries([row('M1', 'tst1-001', 2, {finish: 'HOLOFOIL', variantId: 'holo'})]), {now: NOW});
		const after = live(plan.cards);

		assert.deepEqual([plan.counts.added, plan.counts.removed], [0, 0]);
		assert.deepEqual(after.map((card) => [card.id, card.variant_id]), [[none.id, 'holo'], [other.id, 'holo']]);
		assert.deepEqual(after.map((card) => card.import_key).sort(), ['monprice|M1|pt|HOLOFOIL|0', 'monprice|M1|pt|HOLOFOIL|1']);
		assert.equal(after[0].purchase_price, 50);
	});

	test('a copy the old import put on another card or catalog moves to the file\'s card, with its record', () => {
		const fallback = copy(1, {...owned, card_id: 'tst1-001', catalog: 'international', fallback: true, import_key: 'monprice|M5|ja|NORMAL|0', language: 'ja'});
		const binder = binderOf('b1', [pocket(1, {entry_id: fallback.id})]);
		const record = {
			card_id: 'tst1-001', catalog: 'international', created_at: at(0), deleted_at: null, id: 'international~tst1-001~ja', language: 'ja',
			notes: 'Bought at a fair', photos: [{id: 'p1', path: 'u/p1.webp'}], updated_at: at(0),
		};
		const entries = importEntries([{cardId: 'J1-001', catalog: 'ja', row: {count: 1, finish: 'NORMAL', language: 'ja', monpriceId: 'M5', name: 'Invented', number: '001', setName: 'Invented set'}, status: 'matched', variantId: 'normal'}]);
		const doc = {binders: [binder], card_info: [record], cards: [fallback]};
		const plan = planMatch(doc, entries, {now: NOW});
		const [kept] = live(plan.cards);

		assert.deepEqual([plan.counts.added, plan.counts.removed, plan.counts.kept], [0, 0, 1]);
		assert.deepEqual([kept.id, kept.catalog, kept.card_id, kept.fallback, kept.purchase_price], [fallback.id, 'ja', 'J1-001', undefined, 50]);
		assert.equal(slotsOf(plan.binders[0], placements(plan.binders))[0].entry_id, fallback.id, 'the pocket keeps the copy');

		const moved = plan.card_info.find((item) => item.id === 'ja~J1-001~ja');

		assert.ok(plan.card_info.find((item) => item.id === record.id).deleted_at, 'the old record becomes a tombstone');
		assert.deepEqual([moved.notes, moved.photos.map((photo) => photo.id), moved.deleted_at], ['Bought at a fair', ['p1'], null]);

		undoPlan(plan, plan.undo, NOW + 1000);
		assert.deepEqual([plan.cards[0].catalog, plan.cards[0].card_id, plan.cards[0].fallback], ['international', 'tst1-001', true]);
		assert.equal(plan.card_info.find((item) => item.id === record.id).deleted_at, null, 'Undo brings the record back');
		assert.ok(plan.card_info.find((item) => item.id === 'ja~J1-001~ja').deleted_at, 'and removes the one it made');
	});

	test('the record stays when other copies of the old card remain', () => {
		const fallback = copy(1, {import_key: 'monprice|M5|ja|NORMAL|0', language: 'ja'});
		const stays = copy(2, {language: 'ja'});
		const record = {card_id: 'tst1-001', catalog: 'international', created_at: at(0), deleted_at: null, id: 'international~tst1-001~ja', language: 'ja', photos: [], updated_at: at(0)};
		const entries = importEntries([
			{cardId: 'J1-001', catalog: 'ja', row: {count: 1, finish: 'NORMAL', language: 'ja', monpriceId: 'M5', number: '001'}, status: 'matched', variantId: 'normal'},
			{cardId: 'tst1-001', catalog: 'international', row: {count: 1, finish: 'NORMAL', language: 'ja', monpriceId: 'M6', number: '001'}, status: 'matched', variantId: 'normal'},
		]);
		const plan = planMatch({binders: [], card_info: [record], cards: [fallback, stays]}, entries, {now: NOW});

		assert.deepEqual([plan.counts.added, plan.counts.removed], [0, 0]);
		assert.equal(plan.card_info, undefined);
	});
});

describe('rows left out or not matched', () => {
	test('a skipped row protects its copies by monprice id, under a drifted finish too', () => {
		const copies = [0, 1, 2].map((i) => copy(i, {finish_raw: 'HOLOFOIL', import_key: `monprice|M9|pt|HOLOFOIL|${i}`, variant_id: null}));
		const skipped = importEntries([row('M9', 'tst1-001', 3, {finish: 'HOLOFOIL', variantId: 'holo'})]);
		const plan = planMatch({binders: [], cards: copies}, importEntries([row('X', 'tst1-002', 1)]), {now: NOW, skipped});

		assert.deepEqual([plan.counts.removed, plan.counts.leftAlone, plan.counts.added], [0, 3, 1]);
	});

	test('a skipped row sharing a card and finish with a ticked row: its copies are left alone, not counted against the ticked one', () => {
		const big = Array.from({length: 40}, (_, i) => copy(1, {import_key: `monprice|BIG|pt|HOLOFOIL|${i}`, variant_id: 'holo'}));
		const skipped = importEntries([row('BIG', 'tst1-001', 40, {finish: 'HOLOFOIL', variantId: 'holo'})]);
		const plan = planMatch({binders: [], cards: big}, importEntries([row('SMALL', 'tst1-001', 1, {finish: 'HOLOFOIL', variantId: 'holo'})]), {now: NOW, skipped});

		assert.deepEqual([plan.counts.removed, plan.counts.leftAlone, plan.counts.added], [0, 40, 1]);
	});

	test('app copies of a skipped row\'s card and language that the ticked rows do not need are left alone', () => {
		const app = [1, 2, 3].map((minute) => copy(minute));
		const skipped = importEntries([row('BIG', 'tst1-001', 60)]);
		const plan = planMatch({binders: [], cards: app}, importEntries([row('SMALL', 'tst1-001', 1)]), {now: NOW, skipped});

		assert.deepEqual([plan.counts.removed, plan.counts.leftAlone, plan.counts.added, plan.counts.kept], [0, 2, 0, 1]);
	});
});

describe('undoPlan after other changes', () => {
	test('a field, a pocket, or a tray changed since Apply stays', () => {
		const keep = copy(1, {import_key: 'monprice|M1|pt|NORMAL|0', variant_id: null});
		const extra = copy(2, {storage: 'Box Z', variant_id: 'holo'});
		const binder = {...binderOf('b1', [pocket(1, {entry_id: extra.id})])};
		const doc = {binders: [binder], cards: [keep, extra]};
		const plan = planMatch(doc, importEntries([row('M1', 'tst1-001', 1)]), {now: NOW});
		const applied = {binders: plan.binders, cards: plan.cards};
		const kept = applied.cards.find((card) => card.id === keep.id);

		assert.deepEqual([kept.variant_id, kept.storage], ['normal', 'Box Z']);
		assert.equal(slotsOf(applied.binders[0], placements(applied.binders))[0].entry_id, keep.id);

		// Another phone sets the finish and the place, and moves the pocket
		// to a placeholder; that merges in before Undo.
		const i = applied.cards.indexOf(kept);

		applied.cards[i] = {...kept, storage: 'Box Q', updated_at: at(59), variant_id: 'reverse'};
		applied.binders = applied.binders.map((item) => ({...item, slots: [pocket(1, {want: {card_id: 'tst1-009'}})]}));

		undoPlan(applied, plan.undo, NOW + 1000);

		const after = applied.cards.find((card) => card.id === keep.id);

		assert.deepEqual([after.variant_id, after.storage], ['reverse', 'Box Q'], 'the other phone\'s edits stay');
		assert.equal(applied.cards.find((card) => card.id === extra.id).deleted_at, null, 'the removed copy comes back');
		assert.deepEqual(slotsOf(applied.binders[0], placements(applied.binders)).map((slot) => slot.want && slot.want.card_id), ['tst1-009'], 'the pocket changed since stays');
	});

	test('an added copy placed in a pocket or tray after Apply leaves it on Undo', () => {
		const doc = {binders: [binderOf('b1')], cards: []};
		const plan = planMatch(doc, importEntries([row('M1', 'tst1-001', 2)]), {now: NOW});
		const [first, second] = live(plan.cards);
		const applied = {binders: plan.binders.map((item) => ({...item, slots: [pocket(3, {entry_id: first.id})], staged: [second.id]})), cards: plan.cards};

		undoPlan(applied, plan.undo, NOW + 1000);

		assert.equal(live(applied.cards).length, 0);
		assert.deepEqual(slotsOf(applied.binders[0], placements(applied.binders)), [], 'no pocket points at a removed copy');
		assert.deepEqual(applied.binders[0].staged, []);
	});
});

describe('groupKey', () => {
	test('a raw finish stands in for a missing variant', () => {
		assert.equal(groupKey({card_id: 'x-1', finish_raw: 'HOLOFOIL', language: 'ko', variant_id: null}), 'international|x-1|ko|raw:HOLOFOIL');
		assert.equal(groupKey({card_id: 'x-1', catalog: 'ja', language: 'ja', variant_id: 'holo'}), 'ja|x-1|ja|holo');
	});
});
