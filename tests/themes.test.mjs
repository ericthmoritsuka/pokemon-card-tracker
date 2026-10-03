// Themes without a browser: every theme keeps text at WCAG AA in light and
// dark mode (on its header motif too), the themes are the TCG's energy types
// with every game type still resolving to one, style.css holds exactly the
// CSS js/themes.js prints, and the person's settings survive the document
// merge.
//
// Run: node --test tests/themes.test.mjs

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';

import {mergeDocuments, sameContent} from '../js/merge.js';
import {AA_SHAPE, BALLS, BASE, canonicalTheme, contrast, luminance, CSS_END, CSS_START, dangerText, ENERGIES, isTheme, motifVars, palette, scanVars, suggestedTheme, textPairs, themeById, themeCss, THEMES, TYPES} from '../js/themes.js';

const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

const SCHEMES = ['light', 'dark'];

test('every theme keeps every pair at AA in light and dark mode: 4.5:1 for text, 3:1 for the tab mark', () => {
	let lowest = {ratio: Infinity};
	const failures = [];

	for (const theme of THEMES) {
		for (const scheme of SCHEMES) {
			for (const [label, text, background, min] of textPairs(theme, scheme)) {
				const ratio = contrast(text, background);

				if (ratio < lowest.ratio) {
					lowest = {label, ratio, scheme, theme: theme.id};
				}

				if (ratio < min) {
					failures.push(`${theme.id} ${scheme}: ${label} ${text} on ${background} is ${ratio.toFixed(2)}, under ${min}`);
				}
			}
		}
	}

	console.log(`lowest ratio: ${lowest.ratio.toFixed(2)} (${lowest.theme}, ${lowest.scheme}, ${lowest.label})`);
	assert.deepEqual(failures, []);
});

test('the themes are the default and the 11 TCG energy types, by their card names', () => {
	assert.equal(THEMES[0].id, 'default');
	assert.deepEqual(ENERGIES.map((theme) => theme.name), ['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal', 'Dragon', 'Colorless', 'Fairy']);
	assert.equal(THEMES.length, 12);

	// Bright headers take dark text; deep ones keep white.
	for (const id of ['lightning', 'dragon', 'colorless', 'fairy']) {
		assert.equal(palette(themeById(id), 'light')['--header-text'], '#1b1b1f', `${id} puts dark text on its header`);
	}

	assert.equal(palette(themeById('lightning'), 'light')['--on-accent'], '#1b1b1f', 'Lightning buttons are yellow with dark text');

	for (const id of ['grass', 'fire', 'water', 'psychic', 'fighting', 'darkness', 'metal']) {
		assert.equal(palette(themeById(id), 'light')['--on-accent'], '#ffffff', `${id} keeps white text`);
	}

	// Dark mode is its own palette, not the light one: a deep header and a
	// bright accent.
	for (const theme of ENERGIES) {
		const day = palette(theme, 'light');
		const night = palette(theme, 'dark');

		assert.notEqual(day['--header-bg'], night['--header-bg'], `${theme.id} has a dark-mode header`);
		assert.ok(luminance(night['--header-bg']) < 0.06, `${theme.id}'s dark header is deep`);
		assert.equal(night['--on-accent'], '#1b1b1f', `${theme.id}'s dark accent is bright with dark text`);
	}
});

test('every game type, and every theme saved under one, resolves to its energy', () => {
	const expected = {
		bug: 'grass', dark: 'darkness', dragon: 'dragon', electric: 'lightning', fairy: 'fairy', fighting: 'fighting',
		fire: 'fire', flying: 'colorless', ghost: 'psychic', grass: 'grass', ground: 'fighting', ice: 'water',
		normal: 'colorless', poison: 'psychic', psychic: 'psychic', rock: 'fighting', steel: 'metal', water: 'water',
	};

	assert.equal(TYPES.length, 18);

	for (const type of TYPES) {
		assert.equal(type.energy, expected[type.id], type.id);
		assert.ok(isTheme(type.id), `a theme saved as "${type.id}" still works`);
		assert.equal(themeById(type.id).id, expected[type.id]);
		assert.equal(canonicalTheme(type.id), expected[type.id]);
	}

	assert.equal(canonicalTheme('nonsense'), 'default');
	assert.equal(canonicalTheme(null), 'default');

	// The CSS paints a saved game type before any script runs.
	const printed = themeCss();

	for (const id of Object.keys(expected)) {
		assert.ok(printed.includes(`[data-theme="${id}"]`), `the CSS has a selector for "${id}"`);
	}
});

test('the favorite\'s suggested theme: the energy most of its cards carry, else its game type', () => {
	// Pikachu's cards: nearly all Lightning, a few Metal.
	assert.equal(suggestedTheme({cardTypes: [['Lightning'], ['Lightning'], ['Metal'], ['Lightning']], gameTypes: ['electric']}).id, 'lightning');
	// Charizard: mostly Fire, some Darkness.
	assert.equal(suggestedTheme({cardTypes: [['Fire'], ['Darkness'], ['Fire']], gameTypes: ['fire', 'flying']}).id, 'fire');
	// Jigglypuff: Colorless more often than Fairy.
	assert.equal(suggestedTheme({cardTypes: [['Colorless'], ['Fairy'], ['Colorless']], gameTypes: ['normal', 'fairy']}).id, 'colorless');
	// A tie goes to the energy its game types point at.
	assert.equal(suggestedTheme({cardTypes: [['Psychic'], ['Darkness']], gameTypes: ['ghost', 'poison']}).id, 'psychic');
	// No card data: the first game type, mapped.
	assert.equal(suggestedTheme({gameTypes: ['ghost', 'poison']}).id, 'psychic');
	assert.equal(suggestedTheme({gameTypes: ['steel']}).id, 'metal');
	assert.equal(suggestedTheme({}), null);
});

test('motifs are header-only, offline, and clean where they should be', () => {
	const printed = themeCss();

	// No image downloads: every url() is an inline data URI.
	for (const match of printed.matchAll(/url\((["']?)([^)"']*)/g)) {
		assert.ok(match[2].startsWith('data:image/svg+xml,'), `url(${match[2].slice(0, 40)}) is inline`);
	}

	// The one rule outside the variable blocks paints the header and the
	// picker's preview bar, and nothing near card art.
	const selectors = printed.replace(/\/\*[\s\S]*?\*\//g, '').split('{').slice(0, -1).map((chunk) => chunk.split('}').pop().replace(/\s+/g, ' ').trim());
	const rules = selectors.filter((selector) => !selector.startsWith('@media') && !/^\[data-theme="[a-z]+"\](, \[data-theme="[a-z]+"\])*$/.test(selector));

	assert.deepEqual(rules, ['[data-theme] .top, [data-theme] .preview-bar']);
	assert.ok(!/tile|card-grid|img/.test(printed), 'nothing in the themes targets card art');

	// The default stays as it was, and Colorless deliberately plain.
	assert.equal(motifVars(themeById('default'), 'light')['--motif-header'], 'none');
	assert.ok(!motifVars(themeById('colorless'), 'light')['--motif-header'].includes('url('), 'Colorless has no pattern');

	for (const theme of ENERGIES.filter((entry) => entry.id !== 'colorless')) {
		for (const scheme of SCHEMES) {
			assert.notEqual(motifVars(theme, scheme)['--motif-header'], 'none', `${theme.id} ${scheme} has a motif`);
		}
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

test('the Scan disc is a Poké Ball per theme: disc, ring, and glyph, each at 3:1 where it sits', () => {
	const rows = [];

	assert.deepEqual(Object.keys(BALLS).sort(), THEMES.map((theme) => theme.id).sort(), 'one ball per theme');
	assert.equal(new Set(Object.values(BALLS).map((ball) => ball.name)).size, THEMES.length, 'no two themes share a ball');
	assert.deepEqual(BALLS.default, {disc: '#dc0a2d', name: 'Poké Ball', ring: '#ffffff'}, 'the default keeps the red Poké Ball');

	for (const theme of THEMES) {
		for (const scheme of SCHEMES) {
			const vars = palette(theme, scheme);
			const bar = BASE[scheme].surface;

			for (const key of ['--scan', '--scan-ring', '--scan-glyph']) {
				assert.match(vars[key] || '', /^#[0-9a-f]{6}$/, `${theme.id} ${scheme} sets ${key}`);
			}

			assert.deepEqual(scanVars(theme, scheme), {'--scan': vars['--scan'], '--scan-glyph': vars['--scan-glyph'], '--scan-ring': vars['--scan-ring']});

			const disc = vars['--scan'];
			const onBar = contrast(disc, bar);
			const ring = contrast(vars['--scan-ring'], disc);
			const glyph = contrast(vars['--scan-glyph'], disc);

			// Premier's white disc sits on the white light-mode bar; its red
			// ring is its edge there, and must clear the bar instead.
			if (theme.id === 'colorless' && scheme === 'light') {
				assert.equal(disc, '#ffffff');
				assert.ok(contrast(vars['--scan-ring'], bar) >= AA_SHAPE, 'the Premier ring clears the white bar');
			}
			else {
				assert.ok(onBar >= AA_SHAPE, `${theme.id} ${scheme}: disc ${disc} on the tab bar ${bar} is ${onBar.toFixed(2)}`);
			}

			assert.ok(ring >= AA_SHAPE, `${theme.id} ${scheme}: ring on the disc is ${ring.toFixed(2)}`);
			assert.ok(glyph >= AA_SHAPE, `${theme.id} ${scheme}: glyph on the disc is ${glyph.toFixed(2)}`);
			// The tray's count dot is red with the ring as its border, so the
			// ring's 3:1 outlines it on every disc.
			assert.equal(vars['--danger'], '#dc0a2d');
			rows.push(`${theme.id} ${scheme}: ${BALLS[theme.id].name} ${disc} / ${vars['--scan-ring']} / ${vars['--scan-glyph']} (bar ${onBar.toFixed(2)}, ring ${ring.toFixed(2)}, glyph ${glyph.toFixed(2)})`);
		}
	}

	console.log(rows.join('\n'));

	// Dark mode keeps a disc on the dark bar: the black balls turn inside out.
	for (const id of ['darkness', 'dragon']) {
		assert.equal(palette(themeById(id), 'light')['--scan'], '#1b1b1f', `${id} is black in light mode`);
		assert.notEqual(palette(themeById(id), 'dark')['--scan'], '#1b1b1f', `${id} is not black on the dark bar`);
		assert.equal(palette(themeById(id), 'dark')['--scan-ring'], '#1b1b1f', `${id}'s dark ring is black`);
	}

	// The printed CSS carries the three, and :root's fixed badge red stays.
	const printed = themeCss();

	assert.equal((printed.match(/--scan: /g) || []).length, THEMES.length * 2);
	assert.equal((printed.match(/--scan-glyph: /g) || []).length, THEMES.length * 2);
	assert.match(css, /--pokeball: #dc0a2d;/, 'the finish badge has its own red');
	assert.match(css, /\.ball \{\n\tbackground: linear-gradient\(var\(--pokeball\)/, 'the finish badge paints --pokeball, not the themed disc');
	assert.match(css, /\.scan-disc \{[^}]*color: var\(--scan-glyph\)/, 'the disc draws its glyph in --scan-glyph');
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
