// Themes without a browser: every theme keeps text at WCAG AA in light and
// dark mode, style.css holds exactly the CSS js/themes.js prints, and the
// person's settings survive the document merge.
//
// Run: node --test tests/themes.test.mjs

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';

import {mergeDocuments, sameContent} from '../js/merge.js';
import {AA, BASE, contrast, CSS_END, CSS_START, dangerText, isBright, palette, textPairs, themeCss, THEMES, TYPES} from '../js/themes.js';

const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

const SCHEMES = ['light', 'dark'];

test('every theme keeps every text pair at AA in light and dark mode', () => {
	let lowest = {ratio: Infinity};
	const failures = [];

	for (const theme of THEMES) {
		for (const scheme of SCHEMES) {
			for (const [label, text, background] of textPairs(theme, scheme)) {
				const ratio = contrast(text, background);

				if (ratio < lowest.ratio) {
					lowest = {label, ratio, scheme, theme: theme.id};
				}

				if (ratio < AA) {
					failures.push(`${theme.id} ${scheme}: ${label} ${text} on ${background} is ${ratio.toFixed(2)}`);
				}
			}
		}
	}

	console.log(`lowest ratio: ${lowest.ratio.toFixed(2)} (${lowest.theme}, ${lowest.scheme}, ${lowest.label})`);
	assert.deepEqual(failures, []);
});

test('the 18 types are all there, and bright types put dark text on the accent', () => {
	assert.equal(TYPES.length, 18);
	assert.equal(THEMES[0].id, 'default');

	for (const id of ['electric', 'ice', 'fairy']) {
		const type = TYPES.find((entry) => entry.id === id);

		assert.ok(isBright(type), `${id} counts as bright`);
		assert.equal(palette(type, 'light')['--on-accent'], '#1b1b1f');
	}

	for (const id of ['fire', 'water', 'ghost', 'dragon']) {
		assert.equal(palette(TYPES.find((entry) => entry.id === id), 'light')['--on-accent'], '#ffffff', `${id} keeps white text`);
	}
});

test('destructive red is the same in every theme', () => {
	for (const scheme of SCHEMES) {
		const reds = new Set(THEMES.map((theme) => palette(theme, scheme)['--danger']));
		const texts = new Set(THEMES.map((theme) => palette(theme, scheme)['--danger-text']));

		assert.deepEqual([...reds], ['#dc0a2d']);
		assert.deepEqual([...texts], [dangerText(scheme)]);
	}
});

test('style.css holds exactly the CSS js/themes.js prints', () => {
	const start = css.indexOf(CSS_START);
	const end = css.indexOf(CSS_END);

	assert.ok(start >= 0 && end > start, 'the theme markers are in style.css');
	assert.equal(css.slice(start, end + CSS_END.length), themeCss(), 'style.css is out of date: print themeCss() again (js/themes.js says how)');
});

test(':root paints the default theme, so no attribute and data-theme="default" look the same', () => {
	const rootBlock = /^:root \{([\s\S]*?)^\}/m.exec(css)[1];
	const darkBlock = /@media \(prefers-color-scheme: dark\) \{\n\t:root \{([\s\S]*?)\n\t\}/.exec(css)[1];
	const vars = (text) => Object.fromEntries([...text.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
	const root = vars(rootBlock);
	const dark = {...root, ...vars(darkBlock)};
	const resolve = (scope, value) => value.replace(/var\((--[\w-]+)\)/g, (_, name) => resolve(scope, scope[name]));
	const defaults = THEMES[0];

	for (const [scheme, scope] of [['light', root], ['dark', dark]]) {
		for (const [key, value] of Object.entries(palette(defaults, scheme))) {
			assert.equal(resolve(scope, scope[key] || '(missing)'), value, `${scheme} :root ${key}`);
		}
	}

	assert.equal(root['--bg'], BASE.light.bg);
	assert.equal(dark['--surface'], BASE.dark.surface);
});

test('settings survive the merge: the newer side wins, and the change counts as content', () => {
	const older = {cards: [], settings: {favorite_pokemon: 25, theme: 'electric', updated_at: '2026-10-01T10:00:00.000Z'}};
	const newer = {cards: [], settings: {favorite_pokemon: 25, theme: 'water', updated_at: '2026-10-01T11:00:00.000Z'}};

	assert.equal(mergeDocuments(older, newer).settings.theme, 'water');
	assert.equal(mergeDocuments(newer, older).settings.theme, 'water');
	assert.equal(mergeDocuments(older, {cards: []}).settings.favorite_pokemon, 25, 'a side with no settings keeps the other side\'s');
	assert.equal(mergeDocuments({cards: []}, newer).settings.theme, 'water', 'a phone with no settings takes the server\'s');
	assert.equal(sameContent(older, newer), false, 'a settings change is a change to push');

	// A key only the older side has is kept rather than dropped.
	const merged = mergeDocuments({settings: {theme: 'fire', updated_at: '2026-10-01T12:00:00.000Z'}}, older);

	assert.deepEqual(merged.settings, {favorite_pokemon: 25, theme: 'fire', updated_at: '2026-10-01T12:00:00.000Z'});
});
