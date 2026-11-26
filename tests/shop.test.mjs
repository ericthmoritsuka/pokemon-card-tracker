// The Shop's numbers (js/shop.js): which cards it lists, one group and one
// sale price per finish, the sale price kept on every copy of that finish,
// the For sale mark (plans/hotaru-for-sale-plan.md), the suggestion and its
// rounding, the price filters, and the totals. No browser.
//
// Run: node --test tests/shop.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {
	finishKey,
	forSalePatches,
	groupCopy,
	groupMark,
	groupPrice,
	hasCards,
	listingRows,
	ownPicturePath,
	orderCheck,
	priceFilter,
	pricePatches,
	roundUpToStep,
	saleFields,
	salePrice,
	shopGroups,
	shopKey,
	shopTotals,
	storePicturePath,
	suggestion,
	timeLeft,
	undoForSalePatches,
	undoPricePatches,
} from '../js/shop.js';

const copy = (id, fields = {}) => ({card_id: 'sv10-001', catalog: 'international', created_at: `2026-11-0${id.length}T00:00:00Z`, deleted_at: null, id, language: 'pt', ...fields});
const RATES = {brlPerUsd: 5};
const EURO = {brlPerEur: 6};
const priced = (usd, eur) => ({
	id: 'sv10-001',
	variants_detailed: [{
		pricing: {
			cardmarket: eur === null ? undefined : {avg: eur, idProduct: 1, trend: eur, unit: 'EUR', updated: '2026-11-20T00:00:00Z'},
			tcgplayer: usd === null ? undefined : {normal: {marketPrice: usd, productId: 1}, unit: 'USD', updated: '2026-11-20T00:00:00Z'},
		},
		type: 'normal',
		variantId: 'n1',
	}],
});

describe('shopGroups with hand-made copies', () => {
	const hand = (id, fields = {}) => copy(id, {card_id: 'hand_0123456789abcdef0123456789abcdef', catalog: 'custom', name_local: 'Emolga', number_local: '030', set_code: 'CRI', set_name_local: 'Chaos Rising', ...fields});
	const codeOf = (setId) => ({me04: 'CRI'})[setId] || null;

	test('a hand-made copy and a scanned copy of the same CRI card are one card with a spare', () => {
		const cards = [hand('a'), copy('bb', {card_id: 'me04-030'})];
		const groups = shopGroups(cards, {codeOf});

		assert.equal(groups.length, 1);
		assert.equal(groups[0].card_id, 'me04-030');
		assert.equal(groups[0].catalog, 'international');
		assert.equal(groups[0].spares.length, 1);
		assert.deepEqual(groups[0].copies.map((entry) => entry.id).sort(), ['a', 'bb']);
		// The spare is the copy itself, not a renamed clone, so its price patch
		// lands on the real copy.
		assert.ok(cards.includes(groups[0].spares[0]));
	});

	test('the set code may be the TCGdex set id, and a promo number may carry its code', () => {
		assert.equal(shopGroups([hand('a', {set_code: 'me04', number_local: '30'}), copy('bb', {card_id: 'me04-030'})]).length, 1);
		assert.equal(shopGroups([hand('a', {set_code: 'MEP', number_local: 'MEP 012'}), copy('bb', {card_id: 'mep-012'})]).length, 1);
	});

	test('a twin\'s spares are counted per finish like any card\'s, and the price lands on the real copies', () => {
		const cards = [copy('bb', {card_id: 'me04-030', variant_id: 'n1'}), hand('a'), hand('ccc', {finish_raw: 'REVERSE_HOLOFOIL'}), hand('dddd', {finish_raw: 'REVERSE_HOLOFOIL'}), copy('eeeee', {card_id: 'me04-030', finish_raw: 'REVERSE_HOLOFOIL'})];
		const groups = new Map(shopGroups(cards, {codeOf}).map((group) => [group.finish_key, group]));

		assert.deepEqual([...groups.keys()], ['raw:REVERSE_HOLOFOIL'], 'the lone scanned normal and the lone unset hand-made copy are each kept');
		assert.equal(groups.get('raw:REVERSE_HOLOFOIL').card_id, 'me04-030');
		assert.deepEqual(groups.get('raw:REVERSE_HOLOFOIL').spares.map((entry) => entry.id).sort(), ['dddd', 'eeeee'], 'three reverse copies, hand-made and scanned, keep one');
		assert.deepEqual(pricePatches([groups.get('raw:REVERSE_HOLOFOIL')], 4).map(({id}) => id).sort(), ['ccc', 'dddd', 'eeeee']);
	});

	test('another number, set, or language stays apart', () => {
		assert.equal(shopGroups([hand('a', {number_local: '031'}), copy('bb', {card_id: 'me04-030'})], {codeOf}).length, 0);
		assert.equal(shopGroups([hand('a', {set_code: 'POR'}), copy('bb', {card_id: 'me04-030'})], {codeOf}).length, 0);
		assert.equal(shopGroups([hand('a', {language: 'en'}), copy('bb', {card_id: 'me04-030'})], {codeOf}).length, 0);
	});
});

describe('shopGroups: what is not a spare', () => {
	test('one copy in English and one in Portuguese are two keepers and no spare (DESIGN.md section 3, Eric 2026-10-01)', () => {
		assert.deepEqual(shopGroups([copy('a', {card_id: 'me04-030', language: 'en'}), copy('bb', {card_id: 'me04-030', language: 'pt'})]), []);
	});

	test('a copy saved with no catalog counts with the international ones, in one row', () => {
		const groups = shopGroups([copy('a', {catalog: undefined}), copy('bb'), copy('ccc', {catalog: null})]);

		assert.equal(groups.length, 1);
		assert.equal(groups[0].key, 'international|sv10-001|pt|');
		assert.equal(groups[0].copies.length, 3);
		assert.equal(groups[0].spares.length, 2);
	});
});

describe('ownPicturePath', () => {
	test('names a photo by its id in the own folder, keeping its type', () => {
		assert.equal(ownPicturePath({id: '3f2a-77', path: 'u/e/3f2a-77.webp'}), 'own/3f2a-77.webp');
		assert.equal(ownPicturePath({id: 'p1', path: 'u/e/p1.jpg'}), 'own/p1.jpg');
		assert.equal(ownPicturePath({id: '../x'}), null);
		assert.equal(ownPicturePath(null), null);
	});
});

describe('shopGroups', () => {
	test('lists only cards with spares, one group per card and language, keeper among the copies', () => {
		const cards = [
			copy('a'), copy('bb'), copy('ccc'),
			copy('d', {language: 'en'}),
			copy('e', {card_id: 'sv10-002'}),
			copy('f', {deleted_at: '2026-11-10T00:00:00Z'}),
		];
		const groups = shopGroups(cards);

		assert.equal(groups.length, 1, 'one EN copy and one sv10-002 copy are keepers only');
		assert.equal(groups[0].key, 'international|sv10-001|pt|', 'no finish set on any copy');
		assert.equal(groups[0].spares.length, 2);
		assert.deepEqual(groups[0].copies.map((entry) => entry.id).sort(), ['a', 'bb', 'ccc'], 'a removed copy is left out');
		assert.equal(groups[0].set_id, 'sv10');
	});

	test('a copy in a binder is never listed (Eric, 2026-11-24)', () => {
		const cards = [copy('a'), copy('bb'), copy('ccc')];
		const [group] = shopGroups(cards, {held: new Set(['a', 'ccc'])});

		assert.deepEqual(group.spares.map((entry) => entry.id), ['bb'], 'three copies, two in binders: one for sale');
		assert.deepEqual(group.copies.map((entry) => entry.id).sort(), ['a', 'bb', 'ccc'], 'the price still goes on every copy');
		assert.deepEqual(shopGroups(cards, {held: new Set(['a', 'bb', 'ccc'])}), [], 'all in binders: nothing for sale');
		assert.deepEqual(shopGroups([copy('a'), copy('bb', {is_favorite: true}), copy('ccc')]), [], 'a favorite card: nothing for sale (Eric, 2026-11-24)');
	});

	test('the price is the spares\' first, else any copy\'s', () => {
		const [group] = shopGroups([copy('a', {sale_price: 3}), copy('bb'), copy('ccc')]);

		assert.equal(group.price, 3, 'the keeper holds it while the spares do not yet');
		assert.equal(groupPrice({copies: [], spares: [copy('x', {sale_price: 0})]}), null, 'zero is no price');
	});
});

describe('one price per finish (Eric, 2026-11-24)', () => {
	const normal = (id, fields = {}) => copy(id, {variant_id: 'n1', ...fields});
	const reverse = (id, fields = {}) => copy(id, {variant_id: 'r1', ...fields});
	const byFinish = (groups) => new Map(groups.map((group) => [group.finish_key, group]));

	test('a finish is the variant ID, else the monprice word, else unset', () => {
		assert.equal(finishKey({variant_id: 'r1', finish_raw: 'Reverse'}), 'v:r1');
		assert.equal(finishKey({finish_raw: 'Reverse Holo'}), 'raw:Reverse Holo');
		assert.equal(finishKey({}), '');
		assert.equal(shopKey(reverse('a')), 'international|sv10-001|pt|v:r1');
	});

	test('each finish of one card and language keeps one copy, and the rest are its spares (Eric, 2026-11-26)', () => {
		const cards = [normal('a'), normal('bb'), reverse('ccc'), reverse('dddd'), reverse('eeeee')];
		const groups = byFinish(shopGroups(cards));

		assert.deepEqual([...groups.keys()].sort(), ['v:n1', 'v:r1']);
		assert.deepEqual(groups.get('v:n1').copies.map((entry) => entry.id).sort(), ['a', 'bb'], 'the keeper is among its finish\'s copies');
		assert.deepEqual(groups.get('v:n1').spares.map((entry) => entry.id), ['bb']);
		assert.deepEqual(groups.get('v:r1').spares.map((entry) => entry.id).sort(), ['dddd', 'eeeee'], 'the first reverse holo stays home');
		assert.deepEqual(groups.get('v:r1').copies.map((entry) => entry.id).sort(), ['ccc', 'dddd', 'eeeee']);
	});

	test('a finish with one copy has no row: three normals and one reverse holo offer two normals (Eric, 2026-11-26)', () => {
		const groups = shopGroups([normal('a'), normal('bb'), normal('ccc'), reverse('dddd', {sale_price: 8})]);

		assert.deepEqual(groups.map((group) => group.finish_key), ['v:n1']);
		assert.deepEqual(groups[0].spares.map((entry) => entry.id).sort(), ['bb', 'ccc']);
		assert.deepEqual(shopGroups([reverse('a'), normal('bb')]), [], 'whichever was added first, a lone finish stays home');
	});

	test('a lone reverse holo the one-off SQL withdrew stays withdrawn: the next publish leaves it out', () => {
		// supabase/oneoff/withdraw-lone-finish.sql took dddd off HOTARU; store_sync
		// withdraws every single not in the rows it is sent, so leaving it out
		// keeps it withdrawn.
		const cards = [normal('a', {sale_price: 1}), normal('bb', {sale_price: 1}), normal('ccc', {sale_price: 1}), reverse('dddd', {sale_price: 8})];
		const rows = listingRows(shopGroups(cards));

		assert.deepEqual(rows.map((row) => row.id).sort(), ['bb', 'ccc']);
	});

	test('a price typed on one finish goes on that finish\'s copies only', () => {
		const cards = [normal('a'), normal('bb'), reverse('ccc'), reverse('dddd')];
		const groups = byFinish(shopGroups(cards));
		const patches = pricePatches([groups.get('v:r1')], 4.5);

		assert.deepEqual(patches.map(({id}) => id).sort(), ['ccc', 'dddd']);
		assert.ok(patches.every(({patch}) => patch.sale_price === 4.5));

		const after = cards.map((entry) => (['ccc', 'dddd'].includes(entry.id) ? {...entry, sale_price: 4.5} : entry));
		const regrouped = byFinish(shopGroups(after));

		assert.equal(regrouped.get('v:r1').price, 4.5);
		assert.equal(regrouped.get('v:n1').price, null, 'the normal stays unpriced');
	});

	test('a price saved before finishes were split stays on every finish, and nothing is withdrawn', () => {
		// Before: one price for the card, saved on every copy of every finish.
		const cards = [normal('a', {sale_price: 3}), normal('bb', {sale_price: 3}), reverse('ccc', {sale_price: 3}), reverse('dddd', {sale_price: 3}), copy('eeeee', {sale_price: 3})];
		const groups = shopGroups(cards);

		assert.equal(groups.length, 2, 'normal and reverse; the lone copy with no finish set is kept');
		assert.ok(groups.every((group) => group.price === 3), 'every finish keeps the saved price');
		assert.deepEqual(groups.flatMap((group) => pricePatches([group], 3)), [], 'nothing to write');

		const rows = listingRows(groups);
		const spares = groups.flatMap((group) => group.spares.map((entry) => entry.id));

		assert.deepEqual(rows.map((row) => row.id).sort(), spares.sort(), 'every spare is still published');
		assert.deepEqual(rows.map((row) => row.id).sort(), ['bb', 'dddd'], 'one kept per finish');
		assert.ok(rows.every((row) => row.price_brl === 3));
	});

	test('a copy with no finish set is a row of its own', () => {
		const groups = byFinish(shopGroups([normal('a'), copy('bb'), copy('ccc')]));

		assert.deepEqual(groups.get('').spares.map((entry) => entry.id), ['ccc']);
		assert.equal(groups.has('v:n1'), false, 'the lone normal is kept');
	});

	test('each finish is published at its own price, with its finish', () => {
		const cards = [normal('a', {sale_price: 1}), normal('bb', {sale_price: 1}), reverse('ccc', {sale_price: 5}), reverse('dddd', {sale_price: 5})];
		const names = {n1: 'Normal', r1: 'Reverse Holo'};
		const rows = listingRows(shopGroups(cards), {finishOf: (entry) => names[entry.variant_id]});

		assert.deepEqual(rows.map((row) => [row.id, row.finish, row.price_brl]).sort(), [
			['bb', 'Normal', 1],
			['dddd', 'Reverse Holo', 5],
		]);
	});

	test('the suggestion is the finish\'s own market price', () => {
		const record = {
			id: 'sv10-001',
			variants_detailed: [
				{pricing: {tcgplayer: {normal: {marketPrice: 0.2, productId: 1}, unit: 'USD', updated: '2026-11-20T00:00:00Z'}}, type: 'normal', variantId: 'n1'},
				{pricing: {tcgplayer: {'reverse-holofoil': {marketPrice: 2, productId: 1}, unit: 'USD', updated: '2026-11-20T00:00:00Z'}}, subtype: 'reverse', type: 'reverse', variantId: 'r1'},
			],
		};
		const groups = byFinish(shopGroups([normal('a'), normal('bb'), reverse('ccc'), reverse('dddd')]));

		assert.equal(suggestion(groups.get('v:n1'), record, {rates: RATES}).tcgplayer, 1);
		assert.equal(suggestion(groups.get('v:r1'), record, {rates: RATES}).tcgplayer, 10);
	});
});

describe('For sale: the mark is the listing (Eric, 2026-11-24)', () => {
	const ids = (entries) => entries.map((entry) => entry.id).sort();

	test('with no mark, a priced card offers its spares, as before', () => {
		const [group] = shopGroups([copy('a', {sale_price: 2}), copy('bb', {sale_price: 2}), copy('ccc', {sale_price: 2})]);

		assert.deepEqual(ids(group.listed), ['bb', 'ccc']);
		assert.deepEqual(group.marked, []);
	});

	test('a spare marked false is kept: never offered, still a spare', () => {
		const [group] = shopGroups([copy('a'), copy('bb', {for_sale: false}), copy('ccc')]);

		assert.deepEqual(ids(group.spares), ['bb', 'ccc']);
		assert.deepEqual(ids(group.listed), ['ccc']);
	});

	test('the last copy marked true is offered, and makes a group of its own', () => {
		const groups = shopGroups([copy('a', {for_sale: true, sale_price: 5})]);

		assert.equal(groups.length, 1);
		assert.deepEqual(groups[0].spares, []);
		assert.deepEqual(ids(groups[0].marked), ['a']);
		assert.deepEqual(ids(groups[0].listed), ['a']);
		assert.equal(groups[0].price, 5);
		assert.equal(groupCopy(groups[0]).id, 'a');
	});

	test('a copy in a binder marked true is offered beside the loose spare', () => {
		const [group] = shopGroups([copy('a'), copy('bb', {for_sale: true}), copy('ccc')], {held: new Set(['a', 'bb'])});

		assert.deepEqual(ids(group.spares), ['ccc']);
		assert.deepEqual(ids(group.listed), ['bb', 'ccc']);
	});

	test('a marked copy beats the favorite star; the unmarked copies stay kept', () => {
		const [group] = shopGroups([copy('a', {is_favorite: true}), copy('bb', {for_sale: true}), copy('ccc')]);

		assert.deepEqual(ids(group.listed), ['bb'], 'the star keeps a and ccc');
	});

	test('a marked holo and a plain spare are two rows with their own prices', () => {
		const groups = shopGroups([
			copy('a'), copy('bb'),
			copy('ccc', {finish_raw: 'Holofoil', for_sale: true, sale_price: 9}),
		]);
		const plain = groups.find((group) => group.finish_key === '');
		const holo = groups.find((group) => group.finish_key !== '');

		assert.equal(groups.length, 2);
		assert.deepEqual(ids(holo.listed), ['ccc']);
		assert.equal(holo.price, 9);
		assert.equal(plain.price, null);
	});

	test('only the listed copies are published, and a priced card with every copy kept shows no mark', () => {
		const [group] = shopGroups([copy('a', {sale_price: 2}), copy('bb', {for_sale: false, sale_price: 2})]);

		assert.deepEqual(listingRows([group]), [], 'its one spare is kept');
		assert.equal(groupMark(group, {}), null);
		assert.deepEqual(shopTotals([group]), {groups: 1, listed: 0, priced: 1, value: 0});

		const [offered] = shopGroups([copy('a', {sale_price: 2}), copy('bb', {sale_price: 2}), copy('ccc', {for_sale: true, sale_price: 2})], {held: new Set(['a'])});

		assert.deepEqual(listingRows([offered]).map((row) => row.id).sort(), ['bb', 'ccc']);
		assert.equal(groupMark(offered, {bb: {status: 'available'}, ccc: {status: 'reserved'}}), 'reserved');
	});

	test('forSalePatches writes only what changes, and Undo puts each copy back', () => {
		const entries = [copy('a'), copy('bb', {for_sale: true}), copy('ccc', {for_sale: false})];
		const patches = forSalePatches(entries, true);

		assert.deepEqual(patches, [{id: 'a', patch: {for_sale: true}}, {id: 'ccc', patch: {for_sale: true}}]);
		assert.deepEqual(undoForSalePatches(entries, patches), [{id: 'a', patch: {for_sale: null}}, {id: 'ccc', patch: {for_sale: false}}]);
		assert.deepEqual(forSalePatches(entries, null), [{id: 'bb', patch: {for_sale: null}}, {id: 'ccc', patch: {for_sale: null}}]);
	});

	test('a group made without listed (before For sale) offers its spares', () => {
		const group = {copies: [], price: 2, spares: [{id: 'x'}, {id: 'y'}]};

		assert.deepEqual(listingRows([group]).map((row) => row.id), ['x', 'y']);
		assert.equal(groupCopy(group).id, 'x');
	});
});

describe('salePrice and roundUpToStep', () => {
	test('reads a positive amount to the cent only', () => {
		assert.equal(salePrice({sale_price: 2.345}), 2.35);
		assert.equal(salePrice({sale_price: '2'}), null);
		assert.equal(salePrice({sale_price: -1}), null);
		assert.equal(salePrice(null), null);
	});

	test('rounds up to the next R$ 0,50, never below it', () => {
		assert.deepEqual([2.1, 2.5, 2.5000000001, 0.2, 10.01].map((brl) => roundUpToStep(brl)), [2.5, 2.5, 2.5, 0.5, 10.5]);
		assert.equal(roundUpToStep(null), null);
		assert.equal(roundUpToStep(0), null);
	});
});

describe('pricePatches and undoPricePatches', () => {
	test('prices every copy, keeper included, and skips copies already right', () => {
		const groups = shopGroups([copy('a', {sale_price: 5}), copy('bb'), copy('ccc')]);
		const patches = pricePatches(groups, 5);

		assert.deepEqual(patches.map((patch) => patch.id).sort(), ['bb', 'ccc']);
		assert.deepEqual(patches[0].patch, {sale_price: 5});
	});

	test('clears with null, and Undo puts each copy back', () => {
		const groups = shopGroups([copy('a', {sale_price: 5}), copy('bb', {sale_price: 4}), copy('ccc')]);
		const patches = pricePatches(groups, null);

		assert.deepEqual(patches.map((patch) => [patch.id, patch.patch.sale_price]).sort(), [['a', null], ['bb', null]]);
		assert.deepEqual(undoPricePatches(groups, patches).map((patch) => [patch.id, patch.patch.sale_price]).sort(), [['a', 5], ['bb', 4]]);
	});
});

describe('suggestion', () => {
	const group = () => shopGroups([copy('a', {variant_id: 'n1'}), copy('bb', {variant_id: 'n1'})])[0];

	test('converts both markets and Use takes the higher, rounded up', () => {
		const found = suggestion(group(), priced(1, 0.5), {euroRates: EURO, rates: RATES});

		assert.deepEqual(found, {cardmarket: 3, tcgplayer: 5, use: 5});
		assert.equal(suggestion(group(), priced(0.42, 0.5), {euroRates: EURO, rates: RATES}).use, 3, 'R$ 2,10 against R$ 3,00');
		assert.equal(suggestion(group(), priced(0.43, null), {rates: RATES}).use, 2.5, 'R$ 2,15 is R$ 2,50');
	});

	test('gives none without a record, without a rate, or for an Asian print', () => {
		assert.deepEqual(suggestion(group(), null, {rates: RATES}), {cardmarket: null, tcgplayer: null, use: null});
		assert.deepEqual(suggestion(group(), priced(1, null), {}), {cardmarket: null, tcgplayer: null, use: null});

		const japanese = shopGroups([copy('a', {catalog: 'ja', language: 'ja'}), copy('bb', {catalog: 'ja', language: 'ja'})])[0];

		assert.equal(suggestion(japanese, priced(1, 1), {euroRates: EURO, rates: RATES}).use, null);
	});
});

describe('priceFilter and shopTotals', () => {
	const groups = [
		{copies: [], price: 2, spares: [{}, {}]},
		{copies: [], price: null, spares: [{}]},
		{copies: [], price: 1.5, spares: [{}]},
	];

	test('filters priced and not priced', () => {
		assert.equal(priceFilter(groups, 'all').length, 3);
		assert.equal(priceFilter(groups, 'unpriced').length, 1);
		assert.equal(priceFilter(groups, 'priced').length, 2);
	});

	test('counts cards, spares, and what the priced spares bring', () => {
		assert.deepEqual(shopTotals(groups), {groups: 3, listed: 4, priced: 2, value: 5.5});
	});
});

describe('publishing', () => {
	test('a picture path is the TCGdex path under tcgdex/, and nothing else is one', () => {
		assert.equal(storePicturePath('https://assets.tcgdex.net/pt/sv/sv10/001'), 'tcgdex/pt/sv/sv10/001.webp');
		assert.equal(storePicturePath('https://assets.tcgdex.net/zh-tw/sv/sv10/001/'), 'tcgdex/zh-tw/sv/sv10/001.webp');
		assert.equal(storePicturePath('https://example.test/pt/sv/sv10/001'), null);
		assert.equal(storePicturePath('https://assets.tcgdex.net/pt/sv10/001'), null);
		assert.equal(storePicturePath('https://assets.tcgdex.net/pt/sv/../001/x'), null);
		assert.equal(storePicturePath(null), null);
	});

	test('rows are the spares of priced cards only, never the keeper', () => {
		const [group] = shopGroups([copy('a', {condition: 'Near Mint'}), copy('bb', {condition: 'Played'}), copy('ccc')]);
		const priced = {...group, info: {name: 'Bulbasaur', number: '001', setName: 'Rivais'}, picturePath: 'tcgdex/pt/sv/sv10/001.webp', price: 2.5, rarity: 'Common'};

		assert.deepEqual(listingRows([{...group, price: null}]), []);

		const rows = listingRows([priced], {finishOf: (entry) => (entry.id === 'bb' ? 'Reverse Holo' : null)});

		assert.deepEqual(rows.map((row) => row.id).sort(), ['bb', 'ccc']);
		assert.deepEqual(rows.find((row) => row.id === 'bb'), {
			card_id: 'sv10-001', catalog: 'international', condition: 'Played', finish: 'Reverse Holo', id: 'bb', image_path: 'tcgdex/pt/sv/sv10/001.webp',
			language: 'pt', name: 'Bulbasaur', number: '001', price_brl: 2.5, rarity: 'Common', set_name: 'Rivais',
		});
		assert.equal('image_path' in listingRows([{...priced, picturePath: null}])[0], false, 'left out, so the stored picture is kept');
		assert.equal(listingRows([{...priced, info: {}}])[0].name, 'sv10-001', 'a name is never empty');
	});

	test('a card is published, reserved, or pending by its spares', () => {
		const group = {price: 2, spares: [{id: 'x'}, {id: 'y'}]};

		assert.equal(groupMark({...group, price: null}, {}), null);
		assert.equal(groupMark(group, {}), 'pending');
		assert.equal(groupMark(group, {x: {status: 'available'}, y: {status: 'available'}}), 'published');
		assert.equal(groupMark(group, {x: {status: 'available'}}), 'pending');
		assert.equal(groupMark(group, {x: {status: 'reserved'}, y: {status: 'available'}}), 'reserved');
	});
});

describe('orders', () => {
	const order = {code: 'HTR-0007', id: 'order-uuid', items: [{listing_id: 'a', price_brl: 2}, {listing_id: 'bb', price_brl: 3}], name: 'Ana', total: '5.00'};

	test('time left rounds up to the minute, and says Expired past it', () => {
		const now = Date.parse('2026-11-24T12:00:00Z');

		assert.equal(timeLeft('2026-11-26T11:30:00Z', now), '47 h left');
		assert.equal(timeLeft('2026-11-24T12:35:00Z', now), '35 min left');
		assert.equal(timeLeft('2026-11-24T12:00:30Z', now), '1 min left');
		assert.equal(timeLeft('2026-11-24T11:59:00Z', now), 'Expired');
		assert.equal(timeLeft('nonsense', now), 'Expired');
	});

	test('an order names the copies no longer live here, and whether its sale is logged', () => {
		const doc = {cards: [copy('a'), copy('bb', {deleted_at: '2026-11-20T00:00:00Z'})], moves: []};

		assert.deepEqual(orderCheck(order, doc), {logged: false, missing: ['bb']});
		assert.equal(orderCheck(order, {...doc, moves: [{id: 'order-uuid'}]}).logged, true);
		assert.equal(orderCheck(order, {...doc, moves: [{deleted_at: 'x', id: 'order-uuid'}]}).logged, false, 'an undone sale is not logged');
		assert.deepEqual(orderCheck(order, null), {logged: false, missing: ['a', 'bb']});
	});

	test('the sale takes the order\'s copies, buyer, total, and code', () => {
		assert.deepEqual(saleFields(order, {now: new Date(2026, 10, 24, 15)}), {
			currency: 'BRL', date: '2026-11-24', kind: 'sold', note: 'HOTARU HTR-0007', out: ['a', 'bb'], price: 5, who: 'Ana',
		});
	});
});

describe('orders with sealed products', () => {
	const mixed = {code: 'HTR-0009', id: 'o9', items: [
		{kind: 'single', listing_id: 'a', price_brl: 2},
		{card_id: 'p1', kind: 'sealed', listing_id: 'sealed-1', name: 'Booster Box', price_brl: 900},
		{card_id: 'p1', kind: 'sealed', listing_id: 'sealed-2', name: 'Booster Box', price_brl: 900},
		{card_id: 'p2', kind: 'sealed', listing_id: 'sealed-3', name: 'ETB', price_brl: 300},
	], name: 'Gil', total: 2102};
	const sealedOnly = {code: 'HTR-0010', id: 'o10', items: [{card_id: 'p2', kind: 'sealed', listing_id: 'sealed-4', name: 'ETB', price_brl: 300}], name: 'Rui', total: 300};

	test('a sealed product is never missing from the collection, and an order of them alone counts as logged', () => {
		const doc = {cards: [copy('a')], moves: []};

		assert.deepEqual(orderCheck(mixed, doc), {logged: false, missing: []});
		assert.deepEqual(orderCheck(sealedOnly, doc), {logged: true, missing: []});
		assert.equal(hasCards(mixed), true);
		assert.equal(hasCards(sealedOnly), false);
	});

	test('the sale of a mixed order takes the cards only, at their price, and names the sealed products', () => {
		const fields = saleFields(mixed, {now: new Date(2026, 10, 24)});

		assert.deepEqual([fields.out, fields.price, fields.note], [['a'], 2, 'HOTARU HTR-0009, with 2× Booster Box, ETB']);
	});

	test('an item with no kind, from an older order call, is a card', () => {
		assert.deepEqual(orderCheck({id: 'x', items: [{listing_id: 'gone'}]}, {cards: [], moves: []}).missing, ['gone']);
	});
});
