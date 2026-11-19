// Plain Node tests for sharing a card or a binder page as a picture
// (js/share-image.js): the copy lines, wrapping, the card and page layouts,
// fitting a picture in a pocket, the file names, and the share sheet's
// fallbacks. The browser half is tests/share-image-browser.test.mjs.
//
// Run: node --test tests/share-image.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {
	CARD,
	CARD_RATIO,
	PAGE,
	cardLayout,
	copyLines,
	fitImage,
	fitMode,
	pageLayout,
	pagesLabel,
	pngName,
	readPicture,
	shareFile,
	wrapText,
} from '../js/share-image.js';

// Every character 10 units wide.
const measure = (text) => text.length * 10;

describe('copyLines', () => {
	test('one line per language and finish, counted, most first', () => {
		assert.deepEqual(copyLines([
			{finish: null, language: 'Portuguese'},
			{finish: 'Reverse holo', language: 'English'},
			{finish: 'Reverse holo', language: 'English'},
			{finish: null, language: 'English'},
		]), ['English · Reverse holo ×2', 'English', 'Portuguese']);
	});

	test('past the limit, the last line says how many more', () => {
		const items = ['A', 'B', 'C', 'D'].map((language) => ({finish: null, language}));

		assert.deepEqual(copyLines(items, {max: 3}), ['A', 'B', 'and 2 more']);
		assert.deepEqual(copyLines(items, {max: 4}), ['A', 'B', 'C', 'D']);
	});

	test('nothing for no copies or empty items', () => {
		assert.deepEqual(copyLines([]), []);
		assert.deepEqual(copyLines([{finish: null, language: ''}, null]), []);
	});
});

describe('wrapText', () => {
	test('breaks between words at the width', () => {
		assert.deepEqual(wrapText('Charizard ex Special Illustration', 130, measure), ['Charizard ex', 'Special', 'Illustration']);
	});

	test('a word wider than the line stays whole', () => {
		assert.deepEqual(wrapText('Supercalifragilistic a', 50, measure), ['Supercalifragilistic', 'a']);
	});

	test('past maxLines the last line ends in an ellipsis that fits', () => {
		const lines = wrapText('one two three four five six', 90, measure, 2);

		assert.equal(lines.length, 2);
		assert.equal(lines[0], 'one two');
		assert.ok(lines[1].endsWith('…'), lines[1]);
		assert.ok(measure(lines[1]) <= 90, lines[1]);
	});

	test('empty text is no lines', () => {
		assert.deepEqual(wrapText('', 100, measure), []);
		assert.deepEqual(wrapText(null, 100, measure), []);
	});
});

describe('cardLayout', () => {
	test('the art is card shaped and centered, the lines under it in order', () => {
		const layout = cardLayout({copies: ['English ×2', 'Portuguese'], copiesTitle: 'My copies (3)', details: ['Surging Sparks · 057 / 191'], name: ['Pikachu ex']});

		assert.equal(layout.width, CARD.width);
		assert.equal(layout.art.w, CARD.art);
		assert.ok(Math.abs((layout.art.w / layout.art.h) - CARD_RATIO) < 0.01);
		assert.equal(layout.art.x * 2 + layout.art.w, layout.width, 'centered');
		assert.deepEqual(layout.texts.map((item) => [item.kind, item.text]), [
			['name', 'Pikachu ex'],
			['detail', 'Surging Sparks · 057 / 191'],
			['copiesTitle', 'My copies (3)'],
			['copies', 'English ×2'],
			['copies', 'Portuguese'],
			['footer', 'Card Tracker'],
		]);

		const ys = layout.texts.map((item) => item.y);

		assert.ok(ys[0] > layout.art.y + layout.art.h, 'the name is under the art');
		assert.deepEqual([...ys].sort((a, b) => a - b), ys, 'top to bottom');
		assert.ok(layout.height > ys.at(-1) + 20, 'the footer fits');
	});

	test('no copies: no copies title, and the picture is shorter', () => {
		const without = cardLayout({copies: [], copiesTitle: null, details: ['Set · 1'], name: ['A']});
		const withCopies = cardLayout({copies: ['English'], copiesTitle: 'My copy', details: ['Set · 1'], name: ['A']});

		assert.deepEqual(without.texts.map((item) => item.kind), ['name', 'detail', 'footer']);
		assert.ok(withCopies.height > without.height);
	});
});

describe('fitImage and fitMode', () => {
	const box = {h: 88, w: 63, x: 10, y: 20};

	test('cover fills the box and crops the middle', () => {
		const fit = fitImage(200, 200, box, 'cover');

		assert.deepEqual([fit.dx, fit.dy, fit.dw, fit.dh], [10, 20, 63, 88]);
		assert.ok(Math.abs(fit.sh - 200) < 1e-9);
		assert.ok(Math.abs(fit.sw - (200 * 63 / 88)) < 1e-9);
		assert.ok(Math.abs(fit.sx - ((200 - fit.sw) / 2)) < 1e-9);
	});

	test('contain fits it whole, centered', () => {
		const fit = fitImage(100, 100, box, 'contain');

		assert.equal(fit.dw, 63);
		assert.equal(fit.dh, 63);
		assert.equal(fit.dy, 20 + ((88 - 63) / 2));
		assert.deepEqual([fit.sx, fit.sy, fit.sw, fit.sh], [0, 0, 100, 100]);
	});

	test('a card shaped picture covers; a sprite or a wide picture fits inside', () => {
		assert.equal(fitMode(245, 337), 'cover');
		assert.equal(fitMode(600, 825), 'cover');
		assert.equal(fitMode(96, 96), 'contain');
		assert.equal(fitMode(800, 600), 'contain');
	});
});

describe('pageLayout', () => {
	test('one 3 x 3 page: nine card shaped pockets in rows, inside the page', () => {
		const layout = pageLayout({cols: 3, pages: [5], rows: 3});
		const [page] = layout.pages;

		assert.equal(layout.pages.length, 1);
		assert.equal(page.page, 5);
		assert.equal(page.pockets.length, 9);
		assert.equal(page.pockets[0].w, PAGE.maxPocket);
		assert.ok(Math.abs((page.pockets[0].w / page.pockets[0].h) - CARD_RATIO) < 0.01);
		assert.ok(page.pockets[1].x > page.pockets[0].x && page.pockets[1].y === page.pockets[0].y, 'pocket 2 beside pocket 1');
		assert.ok(page.pockets[3].y > page.pockets[0].y && page.pockets[3].x === page.pockets[0].x, 'pocket 4 under pocket 1');

		for (const pocket of page.pockets) {
			assert.ok(pocket.x >= page.x && pocket.x + pocket.w <= page.x + page.w);
			assert.ok(pocket.y >= page.y && pocket.y + pocket.h <= page.folio.y);
		}

		assert.ok(page.y >= layout.label.y + 24, 'the page starts under the title and label');
		assert.ok(page.y + page.h <= layout.height);
		assert.ok(page.x >= 0 && page.x + page.w <= layout.width);
	});

	test('a spread: two pages side by side, left first, with the spine between', () => {
		const layout = pageLayout({cols: 3, pages: [2, 3], rows: 3});
		const [left, right] = layout.pages;

		assert.deepEqual(layout.pages.map((page) => page.page), [2, 3]);
		assert.equal(right.x - (left.x + left.w), PAGE.spine);
		assert.equal(left.y, right.y);
		assert.ok(right.x + right.w + PAGE.outer <= layout.width + 0.5);
	});

	test('a wide spread shrinks its pockets to stay inside the width', () => {
		const layout = pageLayout({cols: 4, pages: [2, 3], rows: 5});

		assert.ok(layout.width <= PAGE.maxWidth, `${layout.width} wide`);
		assert.ok(layout.pages[0].pockets[0].w < PAGE.maxPocket);
		assert.equal(layout.pages[0].pockets.length, 20);
	});

	test('a narrow page keeps room for the title, centered', () => {
		const layout = pageLayout({cols: 1, pages: [1], rows: 1});
		const [page] = layout.pages;

		assert.equal(layout.width, PAGE.minWidth);
		assert.ok(Math.abs((page.x * 2) + page.w - layout.width) < 1e-9);
	});
});

describe('names', () => {
	test('pagesLabel', () => {
		assert.equal(pagesLabel([3]), 'Page 3');
		assert.equal(pagesLabel([2, 3]), 'Pages 2 and 3');
		assert.equal(pagesLabel([]), 'Page 1');
	});

	test('pngName makes a safe file name', () => {
		assert.equal(pngName('Pikachu - Surging Sparks 057'), 'Pikachu - Surging Sparks 057.png');
		assert.equal(pngName('Kanto: A/B - Pages 2 and 3'), 'Kanto A B - Pages 2 and 3.png');
	});
});

describe('readPicture', () => {
	const failing = () => Promise.reject(new TypeError('Failed to fetch'));

	test('no source reads nothing', async () => {
		assert.equal(await readPicture(null, {fetchImpl: failing}), null);
	});

	test('a TCGdex picture that fails in cors mode asks the relay for its high WebP', async () => {
		const asked = [];

		await readPicture('https://assets.tcgdex.net/en/sv/sv08/057/low.webp', {
			fetchImpl: failing,
			relay: (url) => {
				asked.push(url);

				return Promise.resolve(null);
			},
		});
		assert.deepEqual(asked, ['https://assets.tcgdex.net/en/sv/sv08/057/high.webp']);
	});

	test('past the deadline, or for another host, the relay is not asked', async () => {
		const asked = [];
		const relay = (url) => {
			asked.push(url);

			return Promise.resolve(null);
		};

		await readPicture('https://assets.tcgdex.net/en/sv/sv08/057/low.webp', {deadline: Date.now() - 1, fetchImpl: failing, relay});
		await readPicture('https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/1.png', {fetchImpl: failing, relay});
		assert.deepEqual(asked, []);
	});
});

describe('shareFile', () => {
	const file = {name: 'Card.png', type: 'image/png'};

	async function withNavigator(value, run) {
		const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

		Object.defineProperty(globalThis, 'navigator', {configurable: true, value, writable: true});

		try {
			return await run();
		}
		finally {
			if (had) {
				Object.defineProperty(globalThis, 'navigator', had);
			}
			else {
				delete globalThis.navigator;
			}
		}
	}

	test('with the share sheet, the file goes to it', async () => {
		const shared = [];
		const outcome = await withNavigator({canShare: () => true, share: (data) => {
			shared.push(data);

			return Promise.resolve();
		}}, () => shareFile(file, {download: () => assert.fail('no download'), title: 'Pikachu'}));

		assert.equal(outcome, 'shared');
		assert.deepEqual(shared, [{files: [file], title: 'Pikachu'}]);
	});

	test('without it, or when files cannot be shared, the file downloads', async () => {
		for (const nav of [{}, {canShare: () => false, share: () => assert.fail('not shared')}]) {
			const saved = [];
			const notes = [];
			const outcome = await withNavigator(nav, () => shareFile(file, {download: (blob, name) => saved.push(name), notify: (text) => notes.push(text)}));

			assert.equal(outcome, 'saved');
			assert.deepEqual(saved, ['Card.png']);
			assert.deepEqual(notes, ['Saved Card.png.']);
		}
	});

	test('closing the sheet is not an error; a refused tap offers Share again', async () => {
		const abort = Object.assign(new Error('closed'), {name: 'AbortError'});
		const refused = Object.assign(new Error('needs a tap'), {name: 'NotAllowedError'});
		const notes = [];

		assert.equal(await withNavigator({share: () => Promise.reject(abort)}, () => shareFile(file, {download: () => assert.fail('no download')})), 'closed');
		assert.equal(await withNavigator({share: () => Promise.reject(refused)}, () => shareFile(file, {download: () => assert.fail('no download'), notify: (text, options) => notes.push([text, options && options.actionLabel])})), 'retry');
		assert.deepEqual(notes, [['The image is ready.', 'Share']]);
	});

	test('any other failure saves the file instead', async () => {
		const saved = [];
		const outcome = await withNavigator({share: () => Promise.reject(new TypeError('bad'))}, () => shareFile(file, {download: (blob, name) => saved.push(name)}));

		assert.equal(outcome, 'saved');
		assert.deepEqual(saved, ['Card.png']);
	});
});
