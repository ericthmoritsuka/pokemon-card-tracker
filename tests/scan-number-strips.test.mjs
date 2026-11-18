// Which number strips a picture-first read reads (js/scan/read.js
// readNumber otherStrip, js/scan/identify.js numberSides): when the likelier
// strip gives no number, the other one is read only when some card the
// picture offers prints its number there. In Eric's 2026-11-18 report the
// other strip was read 28 times, about 2.5 s each, and never gave a number.
// Node only.
//
// Run: node --test tests/scan-number-strips.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {numberSide, numberSides} from '../js/scan/identify.js';
import {readNumber} from '../js/scan/read.js';

// A white card: nothing reads on either strip, so the fallback runs.
const blankCard = () => ({data: new Uint8ClampedArray(600 * 825 * 4).fill(255), height: 825, width: 600});

const nothing = async () => ({confidence: 0, lines: [], text: ''});

const picture = (...ids) => ({gap: 3, groups: ids.map((id, i) => ({cards: [{catalog: 'en', id, score: 40 + i, set: id.split('-')[0]}], score: 40 + i}))});

describe('the number strips a picture match reads', () => {
	test('numberSides names the strips the top five groups print on', () => {
		assert.deepEqual(numberSides(picture('sv01-001', 'swsh3-102', 'sm4-19')), {left: true, right: false});
		assert.deepEqual(numberSides(picture('sv01-001', 'xy1-5')), {left: true, right: true});
		assert.deepEqual(numberSides(picture('base1-4', 'neo1-9')), {left: false, right: true});
		assert.deepEqual(numberSides(null), {left: true, right: true}, 'no picture: both, as before');
		assert.equal(numberSide(picture('base1-4', 'neo1-9')), 'right');
	});

	test('with otherStrip false, a strip that reads nothing leaves the other strip unread', async () => {
		const read = await readNumber(blankCard(), nothing, {otherStrip: false, prefer: 'left'});

		assert.equal(read.number, null);
		assert.equal(read.timings.numberRight, undefined, 'the right strip is never read');
		assert.ok('numberLeft' in read.timings, 'the left strip and its sparse pass are');
	});

	test('by default, the other strip is still read when the likelier one gives nothing', async () => {
		const read = await readNumber(blankCard(), nothing, {prefer: 'left'});

		assert.ok('numberRight' in read.timings);
	});
});
