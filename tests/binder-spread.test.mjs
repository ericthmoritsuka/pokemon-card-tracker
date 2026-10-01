// Plain Node tests for binder spreads (js/binder-spread.js), the size
// presets (js/binder-presets.js), and the fields js/binders.js gained for
// them (cover_image, preset). The browser half is
// tests/binder-spread-browser.test.mjs.
//
// Run: node --test tests/binder-spread.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {CUSTOM, PRESETS, presetById, presetCards, presetFields, presetFor, presetSummary} from '../js/binder-presets.js';
import {
	clampSpread,
	coverAspect,
	pageAspect,
	readSpreadState,
	sideOfPage,
	spreadCount,
	spreadLabel,
	spreadOfPage,
	spreadOfPocket,
	spreadPages,
	writeSpreadState,
} from '../js/binder-spread.js';
import {cleanCoverImage, cleanFields, cleanPreset, coverImageOf} from '../js/binders.js';

describe('spread math', () => {
	test('page 1 is alone on the right, with the inside cover on the left', () => {
		assert.deepEqual(spreadPages(40, 1), {left: null, right: 1});
		assert.deepEqual(spreadPages(1, 1), {left: null, right: 1});
		assert.equal(spreadCount(1), 1);
		assert.equal(spreadOfPage(1), 1);
	});

	test('then two-page spreads: 2 and 3, 4 and 5', () => {
		assert.deepEqual(spreadPages(40, 2), {left: 2, right: 3});
		assert.deepEqual(spreadPages(40, 3), {left: 4, right: 5});
		assert.deepEqual(spreadPages(40, 20), {left: 38, right: 39});
	});

	test('an even page count ends with its last page alone on the left', () => {
		assert.equal(spreadCount(40), 21);
		assert.deepEqual(spreadPages(40, 21), {left: 40, right: null});
		assert.equal(spreadCount(2), 2);
		assert.deepEqual(spreadPages(2, 2), {left: 2, right: null});
	});

	test('an odd page count ends with a full pair', () => {
		assert.equal(spreadCount(41), 21);
		assert.deepEqual(spreadPages(41, 21), {left: 40, right: 41});
		assert.equal(spreadCount(3), 2);
		assert.deepEqual(spreadPages(3, 2), {left: 2, right: 3});
	});

	test('every page is on exactly one spread, on its own side', () => {
		for (const count of [1, 2, 3, 4, 5, 20, 39, 40, 41, 200]) {
			const seen = [];

			for (let spread = 1; spread <= spreadCount(count); spread++) {
				const {left, right} = spreadPages(count, spread);

				for (const [page, side] of [[left, 'left'], [right, 'right']]) {
					if (page) {
						seen.push(page);
						assert.equal(spreadOfPage(page), spread, `page ${page} of ${count}`);
						assert.equal(sideOfPage(page), side, `page ${page} side`);
					}
				}
			}

			assert.deepEqual(seen, Array.from({length: count}, (_, i) => i + 1), `${count} pages`);
		}
	});

	test('spreads are clamped to the binder', () => {
		assert.equal(clampSpread(40, 0), 1);
		assert.equal(clampSpread(40, -3), 1);
		assert.equal(clampSpread(40, 99), 21);
		assert.equal(clampSpread(40, '5'), 5);
		assert.equal(clampSpread(40, 'x'), 1);
		assert.deepEqual(spreadPages(40, 99), {left: 40, right: null});
	});

	test('the spread a pocket is on', () => {
		const binder = {cols: 3, page_count: 40, rows: 3};

		// Pocket 1 is page 1; pocket 10 starts page 2; 27 ends page 3.
		assert.equal(spreadOfPocket(binder, 1), 1);
		assert.equal(spreadOfPocket(binder, 9), 1);
		assert.equal(spreadOfPocket(binder, 10), 2);
		assert.equal(spreadOfPocket(binder, 27), 2);
		assert.equal(spreadOfPocket(binder, 28), 3);
		assert.equal(spreadOfPocket(binder, 360), 21);
		assert.equal(spreadOfPocket({cols: 4, page_count: 40, rows: 3}, 13), 2);
	});

	test('labels name the pages shown', () => {
		assert.equal(spreadLabel(40, 1), 'Page 1 of 40');
		assert.equal(spreadLabel(40, 2), 'Pages 2 and 3 of 40');
		assert.equal(spreadLabel(40, 21), 'Page 40 of 40');
		assert.equal(spreadLabel(41, 21), 'Pages 40 and 41 of 41');
	});

	test('a page and its cover keep the grid\'s shape', () => {
		assert.ok(pageAspect(3, 3) > 0.65 && pageAspect(3, 3) < 0.75);
		assert.ok(pageAspect(3, 4) > pageAspect(3, 3));
		assert.ok(coverAspect(3, 3) > pageAspect(3, 3));
	});
});

describe('the URL', () => {
	test('a spread round-trips through the search string', () => {
		for (let spread = 1; spread <= spreadCount(40); spread++) {
			const search = writeSpreadState('', {spread});

			assert.deepEqual(readSpreadState(search, 40), {spread, zoom: null}, search);
		}

		assert.equal(writeSpreadState('', {spread: 1}), '');
		assert.equal(writeSpreadState('', {spread: 3}), '?spread=3');
	});

	test('a zoomed page round-trips and decides the spread', () => {
		for (const zoom of [1, 2, 3, 39, 40]) {
			const search = writeSpreadState('', {spread: spreadOfPage(zoom), zoom});

			assert.deepEqual(readSpreadState(search, 40), {spread: spreadOfPage(zoom), zoom}, search);
		}

		assert.equal(writeSpreadState('', {spread: 3, zoom: 5}), '?spread=3&page=5');
		assert.deepEqual(readSpreadState('?spread=9&page=5', 40), {spread: 3, zoom: 5});
	});

	test('other parameters are kept, and bad values fall back', () => {
		assert.equal(writeSpreadState('?p=x&spread=2', {spread: 4}), '?p=x&spread=4');
		assert.equal(writeSpreadState('?p=x&spread=2&page=3', {spread: 1}), '?p=x');
		assert.deepEqual(readSpreadState('?spread=abc', 40), {spread: 1, zoom: null});
		assert.deepEqual(readSpreadState('?spread=500', 40), {spread: 21, zoom: null});
		assert.deepEqual(readSpreadState('?page=99', 40), {spread: 1, zoom: null});
	});

	test('the route\'s own page opens the spread holding it', () => {
		assert.deepEqual(readSpreadState('', 40, '7'), {spread: 4, zoom: null});
		assert.deepEqual(readSpreadState('', 40, 99), {spread: 21, zoom: null});
		assert.deepEqual(readSpreadState('?spread=2', 40, '7'), {spread: 2, zoom: null});
	});
});

describe('presets', () => {
	test('the quick picks fill rows, columns, and pages', () => {
		assert.deepEqual(PRESETS.map((preset) => [preset.id, preset.rows, preset.cols, preset.page_count, presetCards(preset)]), [
			['4-pocket', 2, 2, 40, 160],
			['9-pocket-zip', 3, 3, 40, 360],
			['12-pocket', 3, 4, 40, 480],
		]);
		assert.deepEqual(presetFields('9-pocket-zip'), {cols: 3, page_count: 40, preset: '9-pocket-zip', rows: 3});
		assert.deepEqual(presetFields(CUSTOM), {preset: CUSTOM});
		assert.equal(presetSummary(presetById('9-pocket-zip')), '3 x 3, 20 double-sided pages, 360 cards');
	});

	test('a form matching a preset names it; anything else is Custom', () => {
		assert.equal(presetFor({cols: 3, page_count: 40, rows: 3}), '9-pocket-zip');
		assert.equal(presetFor({cols: '4', page_count: '40', rows: '3'}), '12-pocket');
		assert.equal(presetFor({cols: 3, page_count: 20, rows: 3}), CUSTOM);
		assert.equal(presetFor({cols: 4, page_count: 40, rows: 4}), CUSTOM);
	});

	test('every preset is a valid binder', () => {
		for (const preset of PRESETS) {
			const clean = cleanFields({name: 'x', ...presetFields(preset.id)});

			assert.equal(clean.preset, preset.id);
			assert.equal(clean.rows * clean.cols * clean.page_count, presetCards(preset));
		}
	});
});

describe('the new binder fields', () => {
	test('cleanFields keeps a preset only when one is passed', () => {
		assert.equal('preset' in cleanFields({cols: 3, name: 'x', page_count: 1, rows: 3}), false);
		assert.equal(cleanFields({cols: 3, name: 'x', page_count: 1, preset: 'custom', rows: 3}).preset, 'custom');
		assert.equal('preset' in cleanFields({cols: 3, name: 'x', page_count: 1, preset: 'Not <ok>', rows: 3}), false);
		assert.equal(cleanPreset(' 9-pocket-zip '), '9-pocket-zip');
	});

	test('a cover image record is checked', () => {
		assert.deepEqual(cleanCoverImage({at: '2026-10-01T00:00:00.000Z', id: 'abc-1', path: null, type: 'image/jpeg'}),
			{at: '2026-10-01T00:00:00.000Z', id: 'abc-1', path: null, type: 'image/jpeg'});
		assert.equal(cleanCoverImage({id: 'abc', type: 'image/png'}).type, 'image/webp');
		assert.equal(cleanCoverImage({id: '../x'}), null);
		assert.equal(cleanCoverImage(null), null);
		assert.equal(coverImageOf({cover_color: '#000000'}), null);
		assert.equal(coverImageOf({cover_image: {id: 'k'}}).id, 'k');
	});
});
