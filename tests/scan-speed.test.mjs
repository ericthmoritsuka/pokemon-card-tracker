// Reading less for a card the picture could not settle (v86; Eric,
// 2026-11-18: scanning "still a bit slow"): a number strip's lines are read
// as many at a time as the reader has workers (two at least), and no more
// once a number reads (js/scan/read.js readNumber workers); a number that names one card
// of the picture's leaves the label row and the set code box unread
// (js/scan/identify.js numberSettles, readNumber settled); and a picture a
// notch short of sure is taken when its one card is from the set of one of
// the last cards (js/scan/identify.js recentStack, js/scan/session.js
// recentSets). Node only.
//
// Run: node --test tests/scan-speed.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {numberSettles, recentStack} from '../js/scan/identify.js';
import {LINES_AT_ONCE, OCR_SETTINGS, readNumber} from '../js/scan/read.js';
import {recentSets, stackSet} from '../js/scan/session.js';

// ------------------------------------------------------------ the reads

// A white 600 x 825 card with three text-like rows of bars in the bottom
// left number strip (js/vision/pipeline.js REGIONS.numberLeft, 759 to 821
// down), the first the densest, so findTextLines ranks them in that order.
function stripCard() {
	const width = 600;
	const height = 825;
	const data = new Uint8ClampedArray(width * height * 4).fill(255);

	for (const [y0, step] of [[764, 4], [780, 6], [800, 10]]) {
		for (let y = y0; y < y0 + 8; y++) {
			for (let x = 20; x < 300; x++) {
				if (x % step < step / 2) {
					data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
				}
			}
		}
	}

	return {data, height, width};
}

const numberLine = {confidence: 90, lines: [{text: '053/198', words: [{bbox: {x0: 40, x1: 140, y0: 4, y1: 20}, confidence: 90, text: '053/198'}]}], text: '053/198'};
const nothing = {confidence: 0, lines: [], text: ''};

// Every call, by its settings; a number on every number line when `number`.
function fakeOcr(calls, {number = true} = {}) {
	return async (image, settings) => {
		calls.push(settings);

		return number && settings === OCR_SETTINGS.numberLine ? numberLine : nothing;
	};
}

describe('reading the number strip a few lines at a time', () => {
	test('with one worker, the likeliest two lines at once (LINES_AT_ONCE), and the third never once they give the number', async () => {
		const calls = [];
		const read = await readNumber(stripCard(), fakeOcr(calls), {workers: 1});

		assert.equal(LINES_AT_ONCE, 2);
		assert.equal(read.number.number, '53');
		assert.equal(read.timings.reads.numberLeft, 2);
		assert.equal(read.timings.calls, 2);
	});

	test('with no worker count, the lines are read side by side as before, and the number is the same', async () => {
		const calls = [];
		const read = await readNumber(stripCard(), fakeOcr(calls), {});

		assert.equal(read.number.number, '53');
		assert.equal(read.timings.reads.numberLeft, 3);
	});

	test('with two workers, the first two lines, then the third only when they give nothing', async () => {
		const read = await readNumber(stripCard(), fakeOcr([]), {workers: 2});

		assert.equal(read.timings.reads.numberLeft, 2);

		const none = await readNumber(stripCard(), fakeOcr([], {number: false}), {otherStrip: false, workers: 2});

		assert.equal(none.number, null);
		assert.equal(none.timings.reads.numberLeft, 4, 'three lines and the strip\'s sparse pass');
	});
});

describe('a number that settles the card', () => {
	test('leaves the label row and the set code box unread', async () => {
		const calls = [];
		const read = await readNumber(stripCard(), fakeOcr(calls), {label: true, setCode: true, settled: () => true, workers: 1});

		assert.equal(read.number.number, '53');
		assert.equal(read.settled, true);
		assert.equal(read.label, null);
		assert.equal(read.timings.label, undefined);
		assert.equal(read.timings.setCode, undefined);
		assert.equal(calls.length, 2);
	});

	test('a number that does not settle it has both read after it', async () => {
		const read = await readNumber(stripCard(), fakeOcr([]), {label: true, setCode: true, settled: async () => false, workers: 1});

		assert.equal(read.settled, false);
		assert.ok('label' in read.timings);
		assert.ok('setCode' in read.timings);
	});

	test('with no number read, the label row is read all the same', async () => {
		const read = await readNumber(stripCard(), fakeOcr([], {number: false}), {label: true, otherStrip: false, settled: () => true, workers: 1});

		assert.equal(read.number, null);
		assert.equal(read.settled, false);
		assert.ok('label' in read.timings);
	});

	test('with no settled test, the label row is read beside the number, as before', async () => {
		const read = await readNumber(stripCard(), fakeOcr([]), {label: true});

		assert.equal(read.settled, false);
		assert.ok('label' in read.timings);
	});
});

// Charizard's artwork in Base Set and its 30th Celebration reprint, a
// Japanese twin, and another group's card.
const card = (id, set, score, catalog = 'en') => ({catalog, id, score, set});
const table = {cards: {}, sets: {'en|30th': ['30th Celebration', 128], 'en|base1': ['Base', 102], 'en|sv01': ['Scarlet & Violet', 198], 'ja|SV1S': ['Scarlet ex', 78]}};
const shared = {gap: 40, groups: [{cards: [card('base1-4', 'base1', 20), card('30th-4', '30th', 21)], score: 20}, {cards: [card('sv01-004', 'sv01', 60)], score: 60}]};

describe('numberSettles', () => {
	test('a number and total that name one of the picture\'s cards settle it', () => {
		const settles = numberSettles(shared, table);

		assert.equal(settles({number: '4', total: '102'}), true, 'Base Set');
		assert.equal(settles({number: '004', total: '128'}), true, 'the reprint');
		assert.equal(settles({number: '4', total: '198'}), true, 'another group\'s card: pictureMatch weighs it too');
	});

	test('anything less leaves the label row and set code box to be read', () => {
		const settles = numberSettles(shared, table);

		assert.equal(settles({number: '4', total: null}), false, 'no total: both prints are 4');
		assert.equal(settles({number: '5', total: '102'}), false, 'names none');
		assert.equal(numberSettles(shared, {cards: {}, sets: {'en|base1': ['Base', 102]}})({number: '4', total: '102'}), false, 'a set the table lacks');
		assert.equal(numberSettles({gap: 40, groups: [{cards: [card('base1-4', 'base1', 20), card('x-4', 'x', 21)], score: 20}]}, {cards: {}, sets: {'en|base1': ['Base', 102], 'en|x': ['X', 162]}})({number: '4', total: '102'}), false, '162 is a confused 102: two cards near it');
		assert.equal(numberSettles(null, table)({number: '4', total: '102'}), false);
	});

	test('a Japanese twin is told apart by its own total', () => {
		const twins = {gap: 30, groups: [{cards: [card('sv01-004', 'sv01', 10), card('SV1S-004', 'SV1S', 11, 'ja')], score: 10}]};

		assert.equal(numberSettles(twins, table)({number: '4', total: '198'}), true);
		assert.equal(numberSettles(twins, table)({number: '4', total: '78'}), true);
	});
});

// ------------------------------------------------------------ the recent sets

const one = (score, gap, extra = {}) => ({gap, groups: [{cards: [{...card('sv01-089', 'sv01', score), ...extra}], score}, {cards: [card('sv03-017', 'sv03', score + gap)], score: score + gap}]});

describe('recentStack', () => {
	const sets = new Set(['sv01', 'sv03']);

	test('one card a notch short of sure, from a recent set, is the stack', () => {
		assert.equal(recentStack(one(50, 11), sets), 'sv01', 'within FIRM_DISTANCE with a lead of AUTO_GAP (sure alone at 45)');
		assert.equal(recentStack(one(58, 16), sets), 'sv01', 'within CLEAR_DISTANCE with a lead of FIRM_GAP (sure alone at 55)');
	});

	test('nothing else is', () => {
		assert.equal(recentStack(one(50, 11), new Set(['swsh1'])), null, 'not a recent set');
		assert.equal(recentStack(one(50, 8), sets), null, 'a lead under AUTO_GAP: not clear');
		assert.equal(recentStack(one(58, 12), sets), null, 'past FIRM_DISTANCE, a lead under FIRM_GAP');
		assert.equal(recentStack(one(62, 30), sets), null, 'past CLEAR_DISTANCE');
		assert.equal(recentStack(one(30, 20), sets), null, 'sure alone: nothing to add');
		assert.equal(recentStack(one(50, 11, {twin: true}), sets), null, 'an image-less twin: only the number tells');
		assert.equal(recentStack(shared, new Set(['base1'])), null, 'a group of several prints is stackSet\'s');
		assert.equal(recentStack(one(50, 11), new Set()), null);
		assert.equal(recentStack(null, sets), null);
	});
});

describe('recentSets', () => {
	const item = (id, setId, fields = {}) => ({card: setId ? {id: `${setId}-1`, setId} : null, id, sure: true, ...fields});

	test('the sets of the last five cards settled without the stack, before this one', () => {
		const session = {items: [item('a', 'base1'), item('b', 'sv01'), item('c', 'sv01', {stacked: true}), item('d', 'sv03', {confirmed: true, sure: false}), item('e', 'swsh1', {sure: false}), item('f', null)]};

		assert.deepEqual([...recentSets(session, 'f')].sort(), ['base1', 'sv01', 'sv03']);
		assert.deepEqual([...recentSets(session, 'b')], ['base1'], 'cards after this one do not count');
		assert.equal(stackSet(session, 'f'), null, 'stackSet still asks three of five');
	});
});
