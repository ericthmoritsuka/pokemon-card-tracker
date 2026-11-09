// Unit tests for the stored View choice (js/card-view-mode.js): Grid by
// default, a value that is not a view falls back to Grid, and storage that
// throws breaks nothing. The switch itself is tested in the browser
// (tests/card-views-browser.test.mjs). Node only, no browser.
//
// Run: node --test tests/card-view-mode.test.mjs

import assert from 'node:assert/strict';
import {afterEach, before, describe, test} from 'node:test';

let mode;

// A localStorage that keeps values in a Map, or throws on every call.
function memoryStorage() {
	const values = new Map();

	return {
		getItem: (key) => (values.has(key) ? values.get(key) : null),
		setItem: (key, value) => values.set(key, String(value)),
		values,
	};
}

const brokenStorage = () => ({
	getItem() {
		throw new Error('SecurityError: storage is off');
	},
	setItem() {
		throw new Error('QuotaExceededError');
	},
});

before(async () => {
	// js/dom.js listens for errors on window when it loads.
	globalThis.window = globalThis.window || {addEventListener() {}};
	mode = await import('../js/card-view-mode.js');
});

afterEach(() => {
	delete globalThis.localStorage;
});

describe('the stored view', () => {
	test('offers Large, Grid, Mini, and List, in that order, with Grid the default', () => {
		assert.deepEqual(mode.CARD_VIEWS.map((view) => view.label), ['Large', 'Grid', 'Mini', 'List']);
		assert.equal(mode.DEFAULT_VIEW, 'grid');
		assert.equal(mode.CARDS_VIEW_KEY, 'cardTracker.cardsView');
	});

	test('is Grid when nothing is saved', () => {
		globalThis.localStorage = memoryStorage();
		assert.equal(mode.savedCardView(), 'grid');
	});

	test('reads back each view saved', () => {
		globalThis.localStorage = memoryStorage();

		for (const view of ['large', 'mini', 'list', 'grid']) {
			mode.saveCardView(view);
			assert.equal(mode.savedCardView(), view);
			assert.equal(globalThis.localStorage.values.get('cardTracker.cardsView'), view);
		}
	});

	test('falls back to Grid for a stored value that is not a view', () => {
		globalThis.localStorage = memoryStorage();

		for (const value of ['huge', 'List', '', 'null', '{"view":"list"}']) {
			globalThis.localStorage.setItem('cardTracker.cardsView', value);
			assert.equal(mode.savedCardView(), 'grid', JSON.stringify(value));
		}
	});

	test('never saves a value that is not a view', () => {
		globalThis.localStorage = memoryStorage();
		mode.saveCardView('mini');
		mode.saveCardView('huge');
		mode.saveCardView(undefined);
		assert.equal(mode.savedCardView(), 'mini');
	});

	test('keeps each screen\'s choice under its own key', () => {
		globalThis.localStorage = memoryStorage();
		mode.saveCardView('list');
		mode.saveCardView('mini', 'cardTracker.setView');
		assert.equal(mode.savedCardView(), 'list');
		assert.equal(mode.savedCardView('cardTracker.setView'), 'mini');
	});

	test('storage that throws gives Grid and saves nothing, without an error', () => {
		globalThis.localStorage = brokenStorage();
		assert.equal(mode.savedCardView(), 'grid');
		assert.doesNotThrow(() => mode.saveCardView('list'));
	});

	test('no storage at all gives Grid', () => {
		assert.equal(globalThis.localStorage, undefined);
		assert.equal(mode.savedCardView(), 'grid');
		assert.doesNotThrow(() => mode.saveCardView('large'));
	});

	test('tells views from other values', () => {
		assert.ok(mode.isCardView('large'));
		assert.ok(!mode.isCardView('Large'));
		assert.ok(!mode.isCardView(null));
	});
});
