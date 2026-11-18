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

import {asianSession, numberSide, numberSides, otherStripFor} from '../js/scan/identify.js';
import {readNumber, stripSharpness} from '../js/scan/read.js';

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

	test('the other strip is skipped only for a picture close enough for its candidates\' era to count', () => {
		const modern = picture('sv01-001', 'swsh3-102', 'sm4-19');

		assert.equal(otherStripFor(modern), false, 'all five print on the left, and the picture is close (40 to 44)');
		assert.equal(otherStripFor({...modern, groups: modern.groups.map((g) => ({...g, score: g.score + 30}))}), true, 'past 60: a card the index lacks, or a bad crop');
		assert.equal(otherStripFor(picture('sv01-001', 'xy1-5')), true, 'one candidate prints on the right');
		assert.equal(otherStripFor(null), true);
	});

	test('the name strip is read only while Japanese or Korean cards are scanned', () => {
		assert.equal(asianSession({guess: 'ko', language: null, lean: false}), false, 'a Latin session: the last Asian pick alone does not count');
		assert.equal(asianSession({guess: 'ko', language: 'ko', lean: false}), true, 'the card is Korean');
		assert.equal(asianSession({guess: 'ja', language: null, lean: true}), true, 'the last pick in Scan was Japanese or Korean');
		assert.equal(asianSession(null), false);
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

	test('stripSharpness is high on sharp edges and low on the same strip blurred, and readNumber reports it', async () => {
		const w = 120;
		const h = 24;
		const strip = (blur) => {
			const data = new Uint8ClampedArray(w * h * 4).fill(255);

			for (let y = 0; y < h; y++) {
				for (let x = 0; x < w; x++) {
					// Bars four pixels wide; blurred, each edge is a ramp.
					const phase = (x % 8) / 8;
					const v = blur ? 128 + 127 * Math.cos(phase * 2 * Math.PI) : (x % 8 < 4 ? 0 : 255);
					const i = (y * w + x) * 4;

					data[i] = data[i + 1] = data[i + 2] = v;
				}
			}

			return {data, height: h, width: w};
		};

		assert.ok(stripSharpness(strip(false)) > 4 * stripSharpness(strip(true)), `${stripSharpness(strip(false))} against ${stripSharpness(strip(true))}`);
		assert.equal(stripSharpness({data: new Uint8ClampedArray(16), height: 2, width: 2}), null);

		const read = await readNumber(blankCard(), nothing, {prefer: 'left'});

		assert.deepEqual(read.sharpness, {side: 'left', value: 0}, 'a white strip has no edges');
	});
});

