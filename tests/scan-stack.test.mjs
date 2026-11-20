// The stack hint (js/scan/session.js stackSet, js/scan/picture.js stackPick
// and pictureMatch's stack): a reprint shares its artwork with the original,
// so the picture alone finds a group of prints; when most of the last cards
// added are from one set and exactly one print of the group is from it, that
// print is the card, with no number read. In Eric's 2026-11-18 report the
// rule applied 33 times (13 of them cards that read their number for 9 s)
// and named the card he kept every time. Node only.
//
// Run: node --test tests/scan-stack.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {readPlan} from '../js/scan/identify.js';
import {pictureMatch, stackPick} from '../js/scan/picture.js';
import {applyVerifyRead, doubtPick, doubtUnverified, settleVerifies, stackSet, VERIFY_WHY} from '../js/scan/session.js';

const item = (id, setId, fields = {}) => ({card: setId ? {id: `${setId}-1`, setId} : null, id, sure: true, ...fields});
const session = (...sets) => ({items: sets.map((set, i) => item(`i${i}`, set))});

// Charizard's artwork, in Base Set and reprinted in 30th Celebration.
const card = (id, set, score) => ({catalog: 'en', id, image: `https://assets/${id}`, score, set});
const shared = {gap: 40, groups: [{cards: [card('base1-4', 'base1', 20), card('30th-4', '30th', 21)], score: 20}, {cards: [card('sv01-089', 'sv01', 60)], score: 60}]};
const table = {
	cards: {'en|30th': {'30th-4': 'Charizard'}, 'en|base1': {'base1-4': 'Charizard'}, 'en|sv01': {'sv01-089': 'Drifloon'}},
	sets: {'en|30th': ['30th Celebration', 128, '2026-02-27'], 'en|base1': ['Base', 102, '1999-01-09'], 'en|sv01': ['Scarlet & Violet', 198, '2023-03-31']},
};
const api = {indexNames: async () => table, setDetail: async () => null};
const number = (n, total) => ({number: {confidence: 0.9, number: n, numberPrinted: n, side: 'left', total, totalPrinted: total}});

describe('the stack a card is scanned from', () => {
	test('stackSet is the set of at least three of the last five cards before this one', () => {
		assert.equal(stackSet(session('30th', '30th', 'sv01', '30th', 'base1', null), 'i5'), '30th');
		assert.equal(stackSet(session('30th', '30th', 'sv01', 'base1', null), 'i4'), null, 'two of five: no stack');
		assert.equal(stackSet(session('30th', '30th', '30th', 'sv01', 'sv01', 'sv01', 'sv01', null), 'i7'), 'sv01', 'only the last five count');
		assert.equal(stackSet(session('30th', '30th', '30th', null, 'sv01'), 'i3'), '30th', 'cards after this one do not count');
		assert.equal(stackSet({items: []}, 'x'), null);
	});

	test('only cards settled without the stack count: not unsure guesses, not the stack\'s own picks', () => {
		const items = [item('a', '30th'), item('b', '30th', {sure: false}), item('c', '30th', {stacked: true}), item('d', '30th', {confirmed: true, sure: false}), item('e', null)];

		assert.equal(stackSet({items}, 'e'), null, 'two settled 30th cards (a, d): no stack');
		assert.equal(stackSet({items: [...items.slice(0, 4), item('f', '30th'), item('g', null)]}, 'g'), '30th');
	});

	test('stackPick takes the one print of the first group from the stack\'s set', () => {
		assert.equal(stackPick(shared, '30th').id, '30th-4');
		assert.equal(stackPick(shared, 'base1').id, 'base1-4');
		assert.equal(stackPick(shared, 'sv01'), null, 'a set only in a later group does not count');
		assert.equal(stackPick(shared, null), null);
		assert.equal(stackPick({gap: 40, groups: [{cards: [card('30th-4', '30th', 20), card('30th-4a', '30th', 21)], score: 20}]}, '30th'), null, 'two prints from the set: not settled');
		assert.equal(stackPick({...shared, gap: 4}, '30th'), null, 'a picture that is not clear: a card the index lacks finds some unrelated nearest group');
		assert.equal(stackPick({gap: 40, groups: [{cards: [card('30th-9', '30th', 62)], score: 62}]}, '30th'), null, 'too far to be this artwork');
	});

	test('pictureMatch with a stack makes the stack\'s print the card, sure, with no number read', async () => {
		const found = await pictureMatch(shared, null, 'pt', {api, stack: '30th'});

		assert.equal(found.card.id, '30th-4');
		assert.equal(found.card.name, 'Charizard');
		assert.equal(found.sure, true);
		assert.equal(found.stack, true);
		assert.deepEqual(found.candidates.map((c) => c.id), ['30th-4', 'base1-4', 'sv01-089']);
	});

	test('a number read that names the other print wins over the stack', async () => {
		const found = await pictureMatch(shared, number('4', '102'), 'pt', {api, stack: '30th'});

		assert.equal(found.stack, undefined);
		assert.equal(found.card.id, 'base1-4');
	});

	test('a card the index lacks, near nothing, is not taken from the stack', async () => {
		const unknown = {gap: 3, groups: [{cards: [card('30th-50', '30th', 52)], score: 52}, {cards: [card('sv01-089', 'sv01', 55)], score: 55}]};
		const found = await pictureMatch(unknown, null, 'pt', {api, stack: '30th'});

		assert.equal(found.stack, undefined);
		assert.equal(found.sure, false);
	});

	// A release review, 2026-11-20: a McDonald's Collection 2021 Charmander,
	// which the index cannot hold, scanned after Burning Shadows cards came
	// out sure as sm3-18, whose artwork it shares (index-twins.json).
	describe('a print with an image-less twin is not taken from the stack', () => {
		const twinned = {gap: 40, groups: [{cards: [{...card('sm3-18', 'sm3', 9), twin: true}], score: 9}, {cards: [card('sv01-089', 'sv01', 49)], score: 49}]};
		const shadows = {
			cards: {...table.cards, 'en|sm3': {'sm3-18': 'Charmander'}},
			sets: {...table.sets, 'en|sm3': ['Burning Shadows', 147, '2017-08-05']},
		};
		const named = {indexNames: async () => shadows, setDetail: async () => null};

		test('stackPick leaves it, so the number is read', () => {
			assert.equal(stackPick(twinned, 'sm3'), null);
		});

		test('pictureMatch with the stack is not sure without the number, and sure with it', async () => {
			const found = await pictureMatch(twinned, null, 'pt', {api: named, stack: 'sm3'});

			assert.equal(found.card.id, 'sm3-18');
			assert.equal(found.sure, false);
			assert.equal(found.stack, undefined);

			const own = await pictureMatch(twinned, number('18', '147'), 'pt', {api: named, stack: 'sm3'});

			assert.equal(own.sure, true);
		});
	});

	test('without a stack the shared artwork is not settled by the picture', async () => {
		const found = await pictureMatch(shared, null, 'pt', {api});

		assert.equal(found.sure, false);
		assert.equal(found.stack, undefined);
	});
});

// A one-card group a notch short of sure from one of the last cards' sets
// (identify.js recentStack, v86) is shown at once, and its number is still
// read behind it (v86 review: as first built that read was skipped, so a
// print the index lacks, such as a stamped reprint whose nearest artwork is
// one card of a recent set, came out sure as that card with nothing to
// check it).
describe('a recent-set pick and its number read', () => {
	// Drifloon, 50 away and 11 ahead of the next artwork: sure alone needs 45.
	const recent = {gap: 11, groups: [{cards: [card('sv01-089', 'sv01', 50)], score: 50}, {cards: [card('base1-4', 'base1', 61)], score: 61}]};
	const sets = new Set(['sv01', 'base1']);

	test('readPlan shows the recent pick at once and still reads its number; the three-of-five stack reads none', () => {
		assert.deepEqual(readPlan(recent, {needsText: true, recent: sets, stack: null}), {stack: 'sv01', text: false, verify: true});
		assert.deepEqual(readPlan(shared, {needsText: true, recent: sets, stack: '30th'}), {stack: '30th', text: false, verify: false}, 'stackSet\'s pick: no number read, as before');
		assert.deepEqual(readPlan(recent, {needsText: true, page: true, recent: sets, stack: 'sv01'}), {stack: null, text: true, verify: false}, 'a binder page takes no stack');
		assert.deepEqual(readPlan(recent, {needsText: true, recent: new Set(['sv03']), stack: null}), {stack: null, text: true, verify: false}, 'not a recent set: read as any card');
		assert.deepEqual(readPlan({gap: 20, groups: [{cards: [card('sv01-089', 'sv01', 30)], score: 30}]}, {needsText: false, recent: sets, stack: null}), {stack: null, text: false, verify: false}, 'sure alone');
	});

	test('the pick is sure with no number yet, stays sure on its own number, and turns to check on another print\'s', async () => {
		const shown = await pictureMatch(recent, null, 'pt', {api, stack: 'sv01'});

		assert.equal(shown.card.id, 'sv01-089');
		assert.equal(shown.sure, true);

		const own = await pictureMatch(recent, number('89', '198'), 'pt', {api, stack: 'sv01'});

		assert.equal(own.card.id, 'sv01-089');
		assert.equal(own.sure, true);

		// A promo's number: the card the index lacks.
		const other = await pictureMatch(recent, number('12', '25'), 'pt', {api, stack: 'sv01'});

		assert.equal(other.sure, false);
		assert.equal(other.disagree, true);
		assert.match(other.why, /the number reads 12\/25/);
	});

	const pick = (id, fields = {}) => ({card: {id: 'sv01-089', setId: 'sv01'}, confirmed: false, id, stacked: true, sure: true, verify: 'pending', why: null, ...fields});

	test('the number read, when it comes, is kept on the card and the card no longer waits', () => {
		const tray = {items: [pick('a')]};

		applyVerifyRead(tray, 'a', number('12', '25'));
		assert.equal(tray.items[0].verify, null);
		assert.equal(tray.items[0].read.number.number, '12');
		assert.equal(tray.items[0].sure, true, 'weighing it is the scanner\'s next step (pictureMatch)');

		doubtPick(tray, 'a', 'Check it.');
		assert.deepEqual((({disagree, sure, why}) => ({disagree, sure, why}))(tray.items[0]), {disagree: true, sure: false, why: 'Check it.'});
	});

	test('Save waits a bounded time for the reads, then a pick still unread is to check', async () => {
		const tray = {items: [pick('a'), pick('b'), pick('c'), pick('d', {confirmed: true}), {card: {id: 'sv01-001', setId: 'sv01'}, id: 'e', sure: true}]};
		const runs = new Map([
			// Its read comes in (view.js verifyAfter clears verify) after 20 ms.
			['a', {done: new Promise((resolve) => setTimeout(() => resolve(applyVerifyRead(tray, 'a', number('89', '198'))), 20))}],
			// Its read never comes.
			['b', {done: new Promise(() => {})}],
			// c's read was lost when Scan closed: nothing to wait for.
		]);
		const started = Date.now();
		const doubted = await settleVerifies(tray, runs, 300);
		const took = Date.now() - started;

		assert.deepEqual(doubted, ['b', 'c']);
		assert.ok(took >= 280 && took < 2000, `waited the bound once: ${took} ms`);
		assert.deepEqual(tray.items.map((item) => [item.id, item.sure, item.why || null, item.verify || null]), [
			['a', true, null, null],
			['b', false, VERIFY_WHY, null],
			['c', false, VERIFY_WHY, null],
			['d', true, null, null],
			['e', true, null, null],
		]);
	});

	test('with every read in, Save does not wait out the bound', async () => {
		const tray = {items: [pick('a')]};
		const runs = new Map([['a', {done: Promise.resolve().then(() => applyVerifyRead(tray, 'a', null))}]]);
		const started = Date.now();

		assert.deepEqual(await settleVerifies(tray, runs, 5000), []);
		assert.ok(Date.now() - started < 1000);
		assert.equal(tray.items[0].sure, true, 'no number read: the pick stands');
	});

	test('a tray opened again with a read lost has the pick to check', () => {
		const tray = {items: [pick('a'), pick('b', {verify: null})]};

		assert.deepEqual(doubtUnverified(tray), ['a']);
		assert.equal(tray.items[1].sure, true);
	});
});
