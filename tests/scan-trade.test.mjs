// Unit tests for the scanner's Trade or sale mode (js/scan/trade.js; Eric,
// 2026-11-06; DESIGN.md section 11, "Scan a trade or a sale"): which copy a
// card going out takes (spares first, in the language and finish read,
// asking when two or more still fit, a card not owned, the same copy never
// twice, a hand pick), the side a capture joins, what the tray can log, and
// what Log it hands the trades log's form (the kind guessed from the sides,
// the cards in as Add would save them), saved through js/moves.js planMove
// as the form saves it. Plain Node; invented data only.
//
// Run: node --test tests/scan-trade.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

// js/collection.js reaches window when it loads.
globalThis.window = globalThis.window || globalThis;
globalThis.addEventListener = globalThis.addEventListener || (() => {});

const S = await import('../js/scan/session.js');
const T = await import('../js/scan/trade.js');
const {planMove} = await import('../js/moves.js');

const AT = '2026-11-06T10:00:00.000Z';
const at = (day) => `2026-10-${String(day).padStart(2, '0')}T10:00:00.000Z`;

const copy = (id, fields = {}) => ({card_id: 'tst1-001', catalog: 'international', created_at: at(1), deleted_at: null, id, language: 'pt', updated_at: at(1), variant_id: 'holo', ...fields});

const CARD = {catalog: 'international', id: 'tst1-001', image: 'https://assets.example/tst1/001', lang: 'en', localId: '1', name: 'Testmon', official: '99', releaseDate: '2026-01-01', setId: 'tst1', setName: 'Test Set'};
const OTHER = {...CARD, id: 'tst1-002', localId: '2', name: 'Othermon'};

// A trade tray with cards scanned on the given sides, read and settled:
// [{side, card, language, variantId, copies}].
function tray(cards) {
	const session = T.newTradeSession(AT, 's1');

	cards.forEach((one, i) => {
		T.setSide(session, one.side || 'out', AT);

		const item = S.addCapture(session, {at: AT, id: `t${i + 1}`});

		Object.assign(item, {
			card: one.card || CARD,
			confirmed: true,
			language: one.language || 'pt',
			languageBy: 'hand',
			status: 'ready',
			sure: true,
			variantId: one.variantId === undefined ? 'holo' : one.variantId,
			variants: [],
		});

		if (one.copies) {
			S.setCopies(session, item.id, one.copies, AT);
		}

		if (one.condition) {
			S.setCondition(session, item.id, one.condition, 'hand', AT);
		}
	});

	return session;
}

const ids = (entries) => entries.map((entry) => entry.id);

describe('the side a capture joins', () => {
	test('Going out first, then the side chosen; an Add session has no sides', () => {
		const session = T.newTradeSession(AT, 's1');

		assert.equal(S.addCapture(session, {at: AT, id: 'a'}).side, 'out');
		T.setSide(session, 'in', AT);
		assert.equal(S.addCapture(session, {at: AT, id: 'b'}).side, 'in');
		T.moveToSide(session, 'b', 'out', AT);
		assert.equal(T.sideOf(S.findItem(session, 'b')), 'out');
		assert.equal('side' in S.addCapture(S.newSession(AT, 'add'), {at: AT, id: 'c'}), false);
	});
});

describe('which copy goes out', () => {
	test('the one spare goes by itself; the copy kept is never taken first', () => {
		// k1 is the keeper (added first), k2 the spare.
		const cards = [copy('k1'), copy('k2', {created_at: at(2)})];
		const result = T.outCopies(tray([{}]), cards).get('t1');

		assert.equal(result.status, 'chosen');
		assert.equal(result.by, 'auto');
		assert.deepEqual(ids(result.copies), ['k2']);
	});

	test('the language and the finish read: a copy in another language or finish does not fit', () => {
		const cards = [copy('en1', {language: 'en'}), copy('rev1', {variant_id: 'reverse'}), copy('pt1')];
		const result = T.outCopies(tray([{}]), cards).get('t1');

		assert.equal(result.status, 'chosen');
		assert.deepEqual(ids(result.copies), ['pt1'], 'the only Portuguese holo copy');

		// No finish read, or a copy with none saved: any finish fits.
		const any = T.outCopies(tray([{variantId: null}]), [copy('rev1', {variant_id: 'reverse'})]).get('t1');

		assert.deepEqual(ids(any.copies), ['rev1']);

		const unset = T.outCopies(tray([{}]), [copy('u1', {variant_id: null})]).get('t1');

		assert.deepEqual(ids(unset.copies), ['u1']);
	});

	test('two spares that fit: it asks, best first, and suggests the loose one', () => {
		const cards = [copy('k1'), copy('s1', {created_at: at(2)}), copy('s2', {created_at: at(3)})];
		const where = new Map([['s1', {binder_name: 'Binder', kind: 'pocket', page: 1, position: 2}]]);
		const asked = T.outCopies(tray([{}]), cards).get('t1');

		assert.equal(asked.status, 'ask');
		assert.deepEqual(asked.copies, []);
		assert.deepEqual(new Set(ids(asked.candidates)), new Set(['k1', 's1', 's2']));
		assert.deepEqual(ids(asked.candidates).slice(2), ['k1'], 'the copy kept comes last');

		// With s1 in a binder pocket, s2 (a spare in no binder) is the one.
		const loose = T.outCopies(tray([{}]), cards, {where}).get('t1');

		assert.equal(loose.status, 'chosen');
		assert.deepEqual(ids(loose.copies), ['s2']);
	});

	test('the one spare in a binder while a loose copy also fits: it asks rather than empty a pocket', () => {
		const cards = [copy('k1'), copy('s1', {created_at: at(2)})];
		const where = new Map([['s1', {binder_name: 'Binder', kind: 'tray'}]]);
		const result = T.outCopies(tray([{}]), cards, {where}).get('t1');

		assert.equal(result.status, 'ask');
		assert.deepEqual(result.suggested, ['s1']);
		assert.equal(T.whereText(where.get('s1')), 'In Binder\'s tray');
		assert.equal(T.whereText(null, copy('x', {storage: 'Box 1'})), 'Stored in Box 1');
		assert.equal(T.whereText(null, copy('x')), 'Not in a binder');
	});

	test('a card not owned cannot go out, and is not logged', () => {
		const session = tray([{card: OTHER}]);
		const results = T.outCopies(session, [copy('k1')]);
		const result = results.get('t1');

		assert.equal(result.status, 'none');
		assert.equal(T.outLine(result), 'Not in your cards, so it cannot go out. Not logged.');

		const sum = T.tradeSummary(session, results);

		assert.equal(sum.skipped, 1);
		assert.equal(sum.loggable, false);
	});

	test('owned only in another language: not logged unless picked', () => {
		const session = tray([{language: 'en'}]);
		const result = T.outCopies(session, [copy('k1')]).get('t1');

		assert.equal(result.status, 'other');
		assert.deepEqual(ids(result.candidates), ['k1']);

		T.pickCopies(session, 't1', ['k1'], AT);

		const picked = T.outCopies(session, [copy('k1')]).get('t1');

		assert.equal(picked.status, 'chosen');
		assert.equal(picked.by, 'hand');
		assert.deepEqual(ids(picked.copies), ['k1']);
	});

	test('the same copy is never chosen twice: two scans of one card take two copies', () => {
		const cards = [copy('k1'), copy('s1', {created_at: at(2)})];
		const results = T.outCopies(tray([{}, {}]), cards);

		assert.deepEqual(ids(results.get('t1').copies), ['s1'], 'the first scan takes the spare');
		assert.equal(results.get('t2').status, 'chosen', 'the second, with no spare left, takes the copy kept');
		assert.deepEqual(ids(results.get('t2').copies), ['k1']);

		// A third scan has nothing left.
		const three = T.outCopies(tray([{}, {}, {}]), cards).get('t3');

		assert.equal(three.status, 'other');
		assert.deepEqual(three.candidates, []);
		assert.equal(T.outLine(three), 'Every copy you own of it is already going out. Not logged.');
	});

	test('a hand pick holds its copy against an earlier scan, and a copy picked twice stays with the first', () => {
		const cards = [copy('k1'), copy('s1', {created_at: at(2)}), copy('s2', {created_at: at(3)})];
		const session = tray([{}, {}]);

		T.pickCopies(session, 't2', ['s2'], AT);

		const results = T.outCopies(session, cards);

		assert.deepEqual(ids(results.get('t2').copies), ['s2']);
		assert.deepEqual(ids(results.get('t1').copies), ['s1'], 'the earlier scan takes the spare left');

		T.pickCopies(session, 't1', ['s2'], AT);

		const twice = T.outCopies(session, cards);

		assert.deepEqual(ids(twice.get('t1').copies), ['s2']);
		assert.notDeepEqual(ids(twice.get('t2').copies), ['s2']);
	});

	test('a card standing for two copies takes two, and asks when three fit', () => {
		const two = T.outCopies(tray([{copies: 2}]), [copy('k1'), copy('s1', {created_at: at(2)}), copy('s2', {created_at: at(3)})]).get('t1');

		assert.equal(two.status, 'chosen');
		assert.deepEqual(new Set(ids(two.copies)), new Set(['s1', 's2']));

		const three = T.outCopies(tray([{copies: 2}]), [copy('k1'), copy('s1', {created_at: at(2)}), copy('s2', {created_at: at(3)}), copy('s3', {created_at: at(4)})]).get('t1');

		assert.equal(three.status, 'ask');
		assert.equal(T.outLine(three), 'Pick which 2 copies go (4 fit).');

		const short = T.outCopies(tray([{copies: 3}]), [copy('k1'), copy('s1', {created_at: at(2)})]).get('t1');

		assert.equal(short.status, 'short');
		assert.equal(short.copies.length, 2);
	});

	test('a copy deleted or in another card is not offered', () => {
		const cards = [copy('gone', {deleted_at: at(5)}), copy('o1', {card_id: 'tst1-002'}), copy('k1')];
		const result = T.outCopies(tray([{}]), cards).get('t1');

		assert.deepEqual(ids(result.candidates), ['k1']);
	});

	test('a card still being read has no copy yet, and holds Log it back', () => {
		const session = tray([{}]);

		session.items[0].status = 'reading';

		const results = T.outCopies(session, [copy('k1')]);

		assert.equal(results.get('t1').status, 'busy');
		assert.equal(T.tradeSummary(session, results).busy, 1);
	});
});

describe('Log it', () => {
	test('the kind follows the sides: Sold or Gift for cards out, Bought or Gift for cards in, Traded for both', () => {
		assert.deepEqual(T.guessKind(2, 0), {alternatives: ['gift'], kind: 'sold'});
		assert.deepEqual(T.guessKind(0, 1), {alternatives: ['gift'], kind: 'bought'});
		assert.deepEqual(T.guessKind(2, 1), {alternatives: [], kind: 'traded'});
		assert.equal(T.guessKind(0, 0).kind, null);
	});

	test('two out and one in hand over the copies chosen and the card in as Add would save it, and the trades log saves them', () => {
		const session = tray([
			{},
			{card: OTHER},
			{card: {...CARD, id: 'tst1-003', localId: '3', name: 'Newmon'}, condition: 'Near Mint', language: 'en', side: 'in', variantId: 'normal'},
		]);
		const cards = [copy('k1'), copy('s1', {created_at: at(2)}), copy('o1', {card_id: 'tst1-002'})];
		const results = T.outCopies(session, cards);
		const sum = T.tradeSummary(session, results);

		assert.deepEqual({in: sum.in, inCopies: sum.inCopies, loggable: sum.loggable, out: sum.out, outCopies: sum.outCopies}, {in: 1, inCopies: 1, loggable: true, out: 2, outCopies: 2});

		const handoff = T.tradeHandoff(session, results);

		assert.equal(handoff.kind, 'traded');
		assert.deepEqual(handoff.out, ['s1', 'o1']);
		assert.equal(handoff.session, 's1');
		assert.deepEqual(handoff.in, [{
			fields: {card_id: 'tst1-003', catalog: 'international', condition: 'Near Mint', language: 'en', language_source: 'scan', variant_id: 'normal'},
			info: {image: 'https://assets.example/tst1/001/low.webp', name: 'Newmon', number: '3', setName: 'Test Set'},
			n: 1,
		}]);
		assert.equal(handoff.records[0].id, 'tst1-003');

		// The form saves {kind, out, in: one row per copy} through planMove,
		// the trades log's one save path.
		const doc = {binders: [], cards, collections: [], goals: [], openings: [], wishlist: []};
		const {doc: next, move} = planMove(doc, {date: '2026-11-06', in: handoff.in.flatMap((item) => Array.from({length: item.n}, () => ({...item.fields}))), kind: handoff.kind, out: handoff.out, who: 'Bruno'}, {id: 'm1', now: Date.parse(AT)});

		assert.deepEqual(move.out, ['s1', 'o1']);
		assert.equal(move.in.length, 1);
		assert.deepEqual(next.cards.filter((entry) => entry.left_via === 'm1').map((entry) => [entry.id, Boolean(entry.deleted_at)]), [['s1', true], ['o1', true]]);
		assert.deepEqual(next.cards.filter((entry) => entry.came_via === 'm1').map((entry) => [entry.card_id, entry.language, entry.variant_id, entry.condition, entry.language_source]), [['tst1-003', 'en', 'normal', 'Near Mint', 'scan']]);
		assert.ok(next.cards.find((entry) => entry.id === 'k1' && !entry.deleted_at), 'the copy kept stays');
	});

	test('cards only going out hand over Sold, with Gift offered; a card not owned is left out', () => {
		const session = tray([{}, {card: OTHER}]);
		const results = T.outCopies(session, [copy('k1'), copy('s1', {created_at: at(2)})]);
		const handoff = T.tradeHandoff(session, results);

		assert.equal(handoff.kind, 'sold');
		assert.deepEqual(handoff.alternatives, ['gift']);
		assert.deepEqual(handoff.out, ['s1']);
		assert.deepEqual(handoff.in, []);
	});

	test('cards only coming in hand over Bought, each with its copies', () => {
		const session = tray([{copies: 3, side: 'in'}]);
		const handoff = T.tradeHandoff(session, T.outCopies(session, []));

		assert.equal(handoff.kind, 'bought');
		assert.equal(handoff.in[0].n, 3);
		assert.equal(handoff.in[0].fields.language_source, 'scan');
	});

	test('a card that asks for its copy holds Log it back until it is picked', () => {
		const session = tray([{}]);
		const cards = [copy('k1'), copy('s1', {created_at: at(2)}), copy('s2', {created_at: at(3)})];
		const asked = T.tradeSummary(session, T.outCopies(session, cards));

		assert.equal(asked.ask, 1);
		assert.equal(asked.loggable, false);

		T.pickCopies(session, 't1', ['s2'], AT);
		assert.equal(T.tradeSummary(session, T.outCopies(session, cards)).loggable, true);
	});
});
