// An invented collection with the shapes that put wrong listings on HOTARU
// on 2026-11-26 (plans/roadmap.md, "Backlog: preventing wrong listings").
// Invented ids and neutral names only: no copy, binder, or name here comes
// from a real export. Used by the held, free, and listing tests
// (tests/held-free.test.mjs, tests/shop-audit.test.mjs).
//
// Every card is international, in Portuguese, unless it says otherwise.
// EXPECTED lists, per card, language, and finish, how many copies each
// shape leaves held (in a pocket) and free (offered to trade or sell).

const at = (minute) => `2026-11-20T10:${String(minute).padStart(2, '0')}:00.000Z`;

let clock = 0;

const copy = (id, cardId, fields = {}) => ({
	card_id: cardId,
	catalog: 'international',
	condition: 'Near Mint',
	created_at: at(++clock),
	deleted_at: null,
	id,
	language: 'pt',
	updated_at: at(0),
	variant_id: null,
	...fields,
});

const binder = (id, fields = {}) => ({
	art: [],
	cols: 3,
	cover_color: '#1b1b1f',
	created_at: at(0),
	deleted_at: null,
	id,
	name: id,
	notes: '',
	page_count: 4,
	rows: 3,
	slots: [],
	updated_at: at(0),
	...fields,
});

const pocket = (entryId, page, position) => ({entry_id: entryId, page, placed_at: at(1), position});

// A binder made from a list, whose last refresh stored shown[key] on top of
// each pocket.
const listBinder = (id, created, keys, shown) => binder(id, {
	created_at: at(created),
	name: id,
	rule: {order: 'number', source: {id: `list-${id}`, kind: 'checklist'}},
	snapshot: {at: at(created), keys, rule_key: 'x', shown},
});

const pick = (binderId, key, entryId, fields = {}) => ({binder_id: binderId, created_at: at(1), deleted_at: null, entry_id: entryId, id: `${binderId}|${key}`, key, updated_at: at(1), ...fields});

export const CARD = {
	multi: 'zz1-001',      // three normals and a lone reverse holo
	unset: 'zz1-002',      // a Normal and a copy with no finish set
	imported: 'zz1-003',   // monprice duplicates, finish word only
	twoLists: 'zz1-004',   // one card shown by two list binders
	hand: 'zz1-005',       // a hand binder's copy and a loose one
	picked: 'zz1-006',     // a hand pick in a list pocket
	tray: 'zz1-007',       // a copy in a binder's tray
	keep: 'zz1-008',       // Keep the placeholder: every copy skipped
	forSale: 'zz1-009',    // a lone copy marked For sale
	favorite: 'zz1-010',   // a favorite card
	offSale: 'zz1-011',    // a spare taken off sale
};

const key = (cardId) => `international|${cardId}`;

export function collectionShape() {
	clock = 0;

	const cards = [
		copy('m1', CARD.multi, {variant_id: 'zz1-001-normal'}),
		copy('m2', CARD.multi, {variant_id: 'zz1-001-normal'}),
		copy('m3', CARD.multi, {variant_id: 'zz1-001-normal'}),
		copy('m4', CARD.multi, {variant_id: 'zz1-001-reverse'}),
		copy('u1', CARD.unset, {variant_id: 'zz1-002-normal'}),
		copy('u2', CARD.unset),
		copy('i1', CARD.imported, {finish_raw: 'Normal', import_key: 'monprice:zz1-003:1'}),
		copy('i2', CARD.imported, {finish_raw: 'Normal', import_key: 'monprice:zz1-003:2'}),
		copy('t1', CARD.twoLists),
		copy('t2', CARD.twoLists),
		copy('h1', CARD.hand),
		copy('h2', CARD.hand),
		copy('p1', CARD.picked),
		copy('p2', CARD.picked),
		copy('p3', CARD.picked),
		copy('r1', CARD.tray),
		copy('r2', CARD.tray),
		copy('k1', CARD.keep),
		copy('k2', CARD.keep),
		copy('s1', CARD.forSale, {for_sale: true}),
		copy('f1', CARD.favorite, {is_favorite: true}),
		copy('f2', CARD.favorite),
		copy('o1', CARD.offSale),
		copy('o2', CARD.offSale, {for_sale: false}),
		copy('gone', CARD.hand, {deleted_at: at(30)}),
	];

	const binders = [
		// A hand binder: h1 in a pocket, r1 waiting in its tray.
		binder('hand-a', {slots: [pocket('h1', 1, 1)], staged: ['r1']}),
		// Two list binders whose last refreshes both stored t1.
		listBinder('list-old', 2, [key(CARD.twoLists), key(CARD.picked), key(CARD.keep)], {[key(CARD.twoLists)]: 't1', [key(CARD.picked)]: 'p1', [key(CARD.keep)]: 'k1'}),
		listBinder('list-new', 5, [key(CARD.twoLists)], {[key(CARD.twoLists)]: 't1'}),
	];

	const binder_picks = [
		// The hand pick puts p2 on top of the picked card's pocket.
		pick('list-old', key(CARD.picked), 'p2'),
		// Keep the placeholder: every copy that fits is skipped there.
		pick('list-old', key(CARD.keep), null, {skipped: ['k1', 'k2']}),
	];

	return {binder_picks, binders, cards};
}

// card|language|finish -> {held, free}, for every finish group with a copy.
export const EXPECTED = {
	'zz1-001|pt|v:zz1-001-normal': {free: 2, held: 0},
	'zz1-001|pt|v:zz1-001-reverse': {free: 0, held: 0},
	'zz1-002|pt|v:zz1-002-normal': {free: 0, held: 0},
	'zz1-002|pt|': {free: 0, held: 0},
	'zz1-003|pt|raw:Normal': {free: 1, held: 0},
	'zz1-004|pt|': {free: 0, held: 2},
	'zz1-005|pt|': {free: 1, held: 1},
	'zz1-006|pt|': {free: 2, held: 1},
	'zz1-007|pt|': {free: 1, held: 0},
	'zz1-008|pt|': {free: 1, held: 0},
	'zz1-009|pt|': {free: 1, held: 0},
	'zz1-010|pt|': {free: 0, held: 0},
	'zz1-011|pt|': {free: 0, held: 0},
};
