// Unit tests for the scanner's Trade or sale mode (js/scan/trade.js; Eric,
// 2026-11-06; DESIGN.md section 11, "Scan a trade or a sale"): which copy a
// card going out takes (loose copies first, in the language and finish
// read, alike ones taken by themselves with spares first, asking only when
// the copies differ or would leave a binder, a card not owned, the same copy
// never twice, a hand pick), the side a capture joins, what the tray can log, and
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

	test('three alike loose copies: one goes without asking, a spare first and the newest of those', () => {
		// Eric, 2026-11-06: "the app is asking me about every card I'm
		// scanning in the trade to select which copy goes out".
		const cards = [copy('k1'), copy('s1', {created_at: at(2)}), copy('s2', {created_at: at(3)})];
		const result = T.outCopies(tray([{}]), cards).get('t1');

		assert.equal(result.status, 'chosen');
		assert.equal(result.by, 'auto');
		assert.deepEqual(ids(result.copies), ['s2']);
		assert.deepEqual(result.suggested, ['s2']);
		assert.deepEqual(ids(result.candidates).slice(2), ['k1'], 'the copy kept comes last');
	});

	test('one loose copy and one in a binder: the loose one goes, even the copy kept', () => {
		const cards = [copy('k1'), copy('s1', {created_at: at(2)})];

		for (const where of [
			new Map([['s1', {binder_name: 'Binder', kind: 'tray'}]]),
			new Map([['s1', {binder_name: 'Binder', kind: 'pocket', page: 1, position: 2}]]),
		]) {
			const result = T.outCopies(tray([{}]), cards, {where}).get('t1');

			assert.equal(result.status, 'chosen', `the spare in a binder ${where.get('s1').kind} stays`);
			assert.equal(result.by, 'auto');
			assert.deepEqual(ids(result.copies), ['k1']);
		}

		// Two loose and one in a binder: a loose spare goes.
		const three = [copy('k1'), copy('s1', {created_at: at(2)}), copy('s2', {created_at: at(3)})];
		const pocket = new Map([['s2', {binder_name: 'Binder', kind: 'pocket', page: 1, position: 2}]]);

		assert.deepEqual(ids(T.outCopies(tray([{}]), three, {where: pocket}).get('t1').copies), ['s1']);
	});

	test('two loose copies in different conditions: it asks, since the choice changes what leaves', () => {
		const cards = [copy('k1', {condition: 'Near Mint'}), copy('s1', {condition: 'Played', created_at: at(2)})];
		const result = T.outCopies(tray([{}]), cards).get('t1');

		assert.equal(result.status, 'ask');
		assert.deepEqual(result.copies, []);
		assert.deepEqual(result.suggested, ['s1'], 'the spare suggested');
		assert.equal(T.outLine(result), 'Pick which copy goes (2 fit).');

		// A condition saved on one and not the other differs too.
		const unset = T.outCopies(tray([{}]), [copy('k1', {condition: 'Near Mint'}), copy('s1', {created_at: at(2)})]).get('t1');

		assert.equal(unset.status, 'ask');

		// No finish read: two loose copies in different finishes ask too.
		const finishes = T.outCopies(tray([{variantId: null}]), [copy('k1'), copy('r1', {variant_id: 'reverse'})]).get('t1');

		assert.equal(finishes.status, 'ask');
	});

	test('only copies in binders fit: it asks rather than empty a pocket, and says where each is', () => {
		const cards = [copy('k1'), copy('s1', {created_at: at(2)})];
		const where = new Map([
			['k1', {binder_name: 'Binder', kind: 'pocket', page: 3, position: 2}],
			['s1', {binder_name: 'Binder', kind: 'tray'}],
		]);
		const result = T.outCopies(tray([{}]), cards, {where}).get('t1');

		assert.equal(result.status, 'ask');
		assert.deepEqual(result.suggested, ['s1']);

		// Even the one copy owned, in a binder, asks.
		const one = T.outCopies(tray([{}]), [copy('k1')], {where}).get('t1');

		assert.equal(one.status, 'ask');
		assert.deepEqual(ids(one.candidates), ['k1']);

		// Not enough loose copies for a card standing for two: it asks.
		const two = T.outCopies(tray([{copies: 2}]), [copy('k1'), copy('s1', {created_at: at(2)}), copy('l1', {created_at: at(3)})], {where}).get('t1');

		assert.equal(two.status, 'ask');
		assert.equal(T.whereText(where.get('s1')), 'In Binder\'s tray');
		assert.equal(T.whereText(where.get('k1')), 'Binder, page 3, pocket 2');
		assert.equal(T.whereText(null, copy('x', {storage: 'Box 1'})), 'Stored in Box 1');
		assert.equal(T.whereText(null, copy('x')), 'Not in a binder');
	});

	test('a finish read narrows to that finish: a copy with no finish saved goes only when none in the finish is loose', () => {
		// u1 (no finish saved) is newer and a spare, but h1 is the holo read.
		const cards = [copy('h1', {condition: 'Near Mint'}), copy('u1', {condition: 'Played', created_at: at(2), variant_id: null})];
		const result = T.outCopies(tray([{}]), cards).get('t1');

		assert.equal(result.status, 'chosen');
		assert.deepEqual(ids(result.copies), ['h1']);

		// Two holo copies that differ: it asks, though the copy with no
		// finish saved also fits.
		const differ = T.outCopies(tray([{}]), [...cards, copy('h2', {condition: 'Played', created_at: at(3)})]).get('t1');

		assert.equal(differ.status, 'ask');

		// The holo copy in a binder: the loose one with no finish saved goes.
		const binder = T.outCopies(tray([{}]), cards, {where: new Map([['h1', {binder_name: 'Binder', kind: 'tray'}]])}).get('t1');

		assert.deepEqual(ids(binder.copies), ['u1']);

		// A card standing for two: the one holo goes, and of the two alike
		// copies with no finish saved, the newer.
		const two = T.outCopies(tray([{copies: 2}]), [copy('h1'), copy('u1', {created_at: at(2), variant_id: null}), copy('u2', {created_at: at(3), variant_id: null})]).get('t1');

		assert.equal(two.status, 'chosen');
		assert.deepEqual(ids(two.copies), ['h1', 'u2']);
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
		assert.equal(twice.get('t2').status, 'ask', 'the later card asks again rather than take another copy');
		assert.equal(twice.get('t2').stale, 'taken');
		assert.deepEqual(twice.get('t2').copies, []);
		assert.equal(T.outLine(twice.get('t2')), 'The copy you picked goes out with another card; pick again.');
	});

	test('a picked copy that is gone (removed on another phone) asks again, and holds Log it back until he picks', () => {
		const session = tray([{}]);

		T.pickCopies(session, 't1', ['x1'], AT);

		const cards = [copy('x1', {deleted_at: at(9)}), copy('y1')];
		const results = T.outCopies(session, cards);
		const result = results.get('t1');

		assert.equal(result.status, 'ask', 'never another copy without a word');
		assert.equal(result.stale, 'gone');
		assert.deepEqual(result.copies, []);
		assert.deepEqual(ids(result.candidates), ['y1']);
		assert.equal(T.outLine(result), 'The copy you picked is gone; pick again.');
		assert.equal(T.tradeSummary(session, results).loggable, false);
		assert.deepEqual(T.tradeHandoff(session, results).out, []);

		T.pickCopies(session, 't1', ['y1'], AT);
		assert.equal(T.tradeSummary(session, T.outCopies(session, cards)).loggable, true);

		// A pick of a copy now of another card counts as gone too; with no
		// copy left to pick, the line says to remove the card.
		T.pickCopies(session, 't1', ['o1'], AT);

		const other = T.outCopies(session, [copy('o1', {card_id: 'tst1-002'})]).get('t1');

		assert.equal(other.status, 'ask');
		assert.equal(T.outLine(other), 'The copy you picked is gone; no other copy fits, so remove this card.');
	});

	test('before his cards are read, or when they cannot be, no card going out is matched and Log it waits', () => {
		const session = tray([{}, {side: 'in'}]);

		for (const known of ['loading', 'failed']) {
			const results = T.outCopies(session, [], {known});
			const sum = T.tradeSummary(session, results);

			assert.equal(results.get('t1').status, 'busy', `${known}: not "not in your cards"`);
			assert.equal(sum.skipped, 0);
			assert.equal(sum.busy, 1);
			assert.equal(sum.loggable, false, `${known}: no purchase logged without the cards going out`);
		}

		assert.equal(T.outLine(T.outCopies(session, [], {known: 'failed'}).get('t1')), 'Could not read your cards; try again.');
		assert.equal(T.outLine(T.outCopies(session, [], {known: 'loading'}).get('t1')), 'Checking your cards…');
		assert.equal(T.outCopies(session, [copy('k1')]).get('t1').status, 'chosen', 'once read, the copy is matched');
	});

	test('a card standing for two copies takes two, also of more alike ones, and asks when they differ', () => {
		const two = T.outCopies(tray([{copies: 2}]), [copy('k1'), copy('s1', {created_at: at(2)}), copy('s2', {created_at: at(3)})]).get('t1');

		assert.equal(two.status, 'chosen');
		assert.deepEqual(new Set(ids(two.copies)), new Set(['s1', 's2']));

		const four = [copy('k1'), copy('s1', {created_at: at(2)}), copy('s2', {created_at: at(3)}), copy('s3', {created_at: at(4)})];
		const alike = T.outCopies(tray([{copies: 2}]), four).get('t1');

		assert.equal(alike.status, 'chosen');
		assert.deepEqual(ids(alike.copies), ['s3', 's2'], 'the newest spares');

		four[3].condition = 'Played';

		const three = T.outCopies(tray([{copies: 2}]), four).get('t1');

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
		const cards = [copy('k1'), copy('s1', {created_at: at(2)}), copy('s2', {condition: 'Played', created_at: at(3)})];
		const asked = T.tradeSummary(session, T.outCopies(session, cards));

		assert.equal(asked.ask, 1);
		assert.equal(asked.loggable, false);

		T.pickCopies(session, 't1', ['s2'], AT);
		assert.equal(T.tradeSummary(session, T.outCopies(session, cards)).loggable, true);
	});
});
