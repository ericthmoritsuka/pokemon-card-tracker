// Themes (DESIGN.md section 11, "Themes"): the default look plus one theme
// per Pokémon type. No DOM here, so Node can load it (tests/themes.test.mjs).
//
// The 18 type colors are the pokedex project's (its style.css, the
// `.details.<type>` rules: --c light, --cd dark), so the two apps share a
// palette. Every other color a theme uses is derived from those two by the
// rules in palette() below, which is what keeps every theme at WCAG AA:
//
//   - Text on the accent is white when the type's own color is dark enough
//     for it after a small darkening. A bright type (its light color's
//     relative luminance above BRIGHT, which catches Electric, Ice, Fairy,
//     Normal, and Ground) keeps its bright color instead, and the text on it
//     turns dark. In dark mode every accent is the light color with dark text.
//   - Links and the strong accent (focus rings, progress) are darkened, or in
//     dark mode lightened, until they reach 4.5:1 on the panel, the page, and
//     the plain surface.
//   - Destructive actions use one red in every theme, so danger never
//     changes color.
//
// style.css holds the CSS that themeCss() prints, between the two marker
// comments, so a theme paints before any script runs. After changing
// anything here, print it again and paste it over the old block:
//
//   node --input-type=module -e "import('./js/themes.js').then((m) => console.log(m.themeCss()))"
//
// tests/themes.test.mjs fails when style.css and this file disagree.

export const DEFAULT_THEME = 'default';

// Frames, after the selectable text box frames in the games' options menus.
// Each is a set of custom properties the panel rules in style.css read, so a
// theme set on an inner element (the picker's preview) frames that element's
// panels without touching the rest of the page.
export const FRAMES = {
	brackets: {
		label: 'Corner brackets',
		vars: {
			'--frame-bg': [
				'linear-gradient(var(--frame), var(--frame)) left 6px top 6px / 18px 3px no-repeat',
				'linear-gradient(var(--frame), var(--frame)) left 6px top 6px / 3px 18px no-repeat',
				'linear-gradient(var(--frame), var(--frame)) right 6px top 6px / 18px 3px no-repeat',
				'linear-gradient(var(--frame), var(--frame)) right 6px top 6px / 3px 18px no-repeat',
				'linear-gradient(var(--frame), var(--frame)) left 6px bottom 6px / 18px 3px no-repeat',
				'linear-gradient(var(--frame), var(--frame)) left 6px bottom 6px / 3px 18px no-repeat',
				'linear-gradient(var(--frame), var(--frame)) right 6px bottom 6px / 18px 3px no-repeat',
				'linear-gradient(var(--frame), var(--frame)) right 6px bottom 6px / 3px 18px no-repeat',
				'var(--panel)',
			].join(', '),
			'--frame-border': '1px solid var(--frame-soft)',
			'--frame-radius': '6px',
			'--frame-shadow': 'none',
		},
	},
	dotted: {
		label: 'Dotted',
		vars: {
			'--frame-bg': 'var(--panel)',
			'--frame-border': '3px dotted var(--frame)',
			'--frame-radius': '14px',
			'--frame-shadow': 'inset 0 0 0 3px var(--panel), inset 0 0 0 4px var(--frame-soft)',
		},
	},
	double: {
		label: 'Double line',
		vars: {
			'--frame-bg': 'var(--panel)',
			'--frame-border': '5px double var(--frame)',
			'--frame-radius': '12px',
			'--frame-shadow': 'none',
		},
	},
	inner: {
		label: 'Inner line',
		vars: {
			'--frame-bg': 'var(--panel)',
			'--frame-border': '2px solid var(--frame)',
			'--frame-radius': '16px',
			'--frame-shadow': 'inset 0 0 0 3px var(--panel), inset 0 0 0 5px var(--frame-soft)',
		},
	},
	// Square, with the corners left out, like an 8-bit menu box.
	pixel: {
		label: 'Pixel',
		vars: {
			'--frame-bg': 'var(--panel)',
			'--frame-border': '0 solid transparent',
			'--frame-radius': '0',
			'--frame-shadow': '0 -4px 0 0 var(--frame), 0 4px 0 0 var(--frame), -4px 0 0 0 var(--frame), 4px 0 0 0 var(--frame), inset 0 0 0 2px var(--frame-soft)',
		},
	},
	stripes: {
		label: 'Striped edge',
		vars: {
			'--frame-bg': [
				'linear-gradient(var(--panel), var(--panel)) padding-box',
				'repeating-linear-gradient(-45deg, var(--frame) 0 5px, var(--frame-soft) 5px 10px) border-box',
			].join(', '),
			'--frame-border': '5px solid transparent',
			'--frame-radius': '10px',
			'--frame-shadow': 'none',
		},
	},
};

// [id, name, light color, dark color, frame]. Light and dark are the
// pokedex project's --c and --cd for that type.
const TYPE_ROWS = [
	['normal', 'Normal', '#cec698', '#67634c', 'double'],
	['fire', 'Fire', '#ed8a8b', '#ba6c6d', 'brackets'],
	['water', 'Water', '#76befe', '#5e97cb', 'inner'],
	['grass', 'Grass', '#49d0b0', '#379d84', 'dotted'],
	['electric', 'Electric', '#fcc719', '#c99e13', 'stripes'],
	['ice', 'Ice', '#8fd8d8', '#58a8a8', 'inner'],
	['fighting', 'Fighting', '#d67873', '#a5453f', 'brackets'],
	['poison', 'Poison', '#b884dd', '#8e51b3', 'dotted'],
	['ground', 'Ground', '#e0c068', '#ab9048', 'pixel'],
	['flying', 'Flying', '#a890f0', '#7a68c0', 'double'],
	['psychic', 'Psychic', '#f85888', '#c03863', 'inner'],
	['bug', 'Bug', '#8fcc6c', '#597f43', 'dotted'],
	['rock', 'Rock', '#c8b686', '#948350', 'pixel'],
	['ghost', 'Ghost', '#8571be', '#5b4a91', 'stripes'],
	['dragon', 'Dragon', '#7f6df0', '#5442c2', 'brackets'],
	['dark', 'Dark', '#8d7b6a', '#57443a', 'stripes'],
	['steel', 'Steel', '#b8b8d0', '#8888a0', 'pixel'],
	['fairy', 'Fairy', '#f0a6e8', '#c465ba', 'double'],
];

export const TYPES = TYPE_ROWS.map(([id, name, light, dark, frame]) => ({dark, frame, id, light, name}));

export const THEMES = [
	{dark: '#1d2e60', frame: null, id: DEFAULT_THEME, light: '#306cb3', name: 'Default'},
	...TYPES,
];

export const themeById = (id) => THEMES.find((theme) => theme.id === id) || null;

export const isTheme = (id) => Boolean(themeById(id));

// ------------------------------------------------------------ color math

const INK = '#1b1b1f';
const WHITE = '#ffffff';
const RED = '#dc0a2d';

export const AA = 4.5;

// A type is bright when its light color's relative luminance is above this:
// white text would need the color darkened past recognition.
export const BRIGHT = 0.51;

// The fixed surfaces from style.css's :root, which themes leave alone.
export const BASE = {
	dark: {bg: '#16181d', border: '#34343c', muted: '#a8a8b3', surface: '#1f2128', text: '#ececf1'},
	light: {bg: '#f4f4f6', border: '#d9d9e0', muted: '#5b5b66', surface: '#ffffff', text: INK},
};

export function rgb(hex) {
	const n = parseInt(hex.slice(1), 16);

	return [n >> 16, (n >> 8) & 255, n & 255];
}

export const toHex = (parts) => `#${parts.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;

// a with t of b mixed in, in sRGB, the way color-mix(in srgb) does it.
export const mix = (a, b, t) => toHex(rgb(a).map((v, i) => v + (rgb(b)[i] - v) * t));

// WCAG 2 relative luminance and contrast ratio.
export function luminance(hex) {
	const [r, g, b] = rgb(hex).map((v) => {
		const c = v / 255;

		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	});

	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
	const x = luminance(a);
	const y = luminance(b);

	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// What a color shows as when drawn at `alpha` over `under`.
export const over = (color, alpha, under) => mix(under, color, alpha);

// Mixes `color` toward `toward` in 1% steps until it reaches AA against
// every color in `against`.
const until = (color, toward, against) => untilOk(color, toward, (candidate) => against.every((other) => contrast(candidate, other) >= AA));

function untilOk(color, toward, ok) {
	for (let step = 0; step <= 100; step++) {
		const candidate = mix(color, toward, step / 100);

		if (ok(candidate)) {
			return candidate;
		}
	}

	return toward;
}

// A header background that keeps `text` at AA, both at full strength (the
// title) and at the 85% opacity the sync line under it uses.
const headerFor = (color, toward, text) => untilOk(color, toward, (bg) => contrast(text, bg) >= AA && contrast(over(text, 0.85, bg), bg) >= AA);

export const isBright = (type) => luminance(type.light) > BRIGHT;

const rgba = (hex, alpha) => `rgba(${rgb(hex).join(', ')}, ${alpha})`;

// ------------------------------------------------------------ palettes

// The custom properties a theme sets, for one color scheme.
export function palette(theme, scheme) {
	const base = BASE[scheme];

	if (theme.id === DEFAULT_THEME) {
		return defaultPalette(scheme);
	}

	const panel = mix(base.surface, theme.light, scheme === 'light' ? 0.1 : 0.12);
	const backgrounds = [panel, base.bg, base.surface];
	const vars = {};

	if (scheme === 'light') {
		const bright = isBright(theme);
		const accent = bright ? headerFor(theme.light, '#000000', INK) : headerFor(theme.dark, '#000000', WHITE);
		const onAccent = bright ? INK : WHITE;
		const strong = until(theme.dark, '#000000', backgrounds);

		Object.assign(vars, {
			'--accent': accent,
			'--accent-strong': strong,
			'--avatar-bg': WHITE,
			'--avatar-text': strong,
			'--frame': theme.dark,
			'--header-bg': accent,
			'--header-text': onAccent,
			'--link': strong,
			'--on-accent': onAccent,
		});
	}
	else {
		const accent = until(theme.light, '#ffffff', [INK]);
		const header = headerFor(mix(base.surface, theme.light, 0.4), '#000000', WHITE);
		const strong = until(theme.light, '#ffffff', backgrounds);

		Object.assign(vars, {
			'--accent': accent,
			'--accent-strong': strong,
			'--avatar-bg': accent,
			'--avatar-text': INK,
			'--frame': theme.light,
			'--header-bg': header,
			'--header-text': WHITE,
			'--link': strong,
			'--on-accent': INK,
		});
	}

	Object.assign(vars, {
		'--danger': RED,
		'--danger-text': dangerText(scheme),
		'--frame-soft': mix(panel, vars['--frame'], 0.45),
		'--header-alert': vars['--header-text'],
		'--header-line': rgba(vars['--header-text'], 0.5),
		'--panel': panel,
		'--selected-bg': vars['--accent'],
		'--selected-text': vars['--on-accent'],
		'--tab-mark': theme.light,
	});

	return sorted(vars);
}

// Red text that reads on the plain surface, where destructive buttons sit.
// The red itself is the same everywhere; dark mode lightens it for text.
export const dangerText = (scheme) => (scheme === 'light' ? RED : until(RED, '#ffffff', [BASE.dark.surface, BASE.dark.bg]));

// The default look, as style.css's :root already paints it. Printed as a
// theme too, so the picker's preview can show it inside a typed page.
function defaultPalette(scheme) {
	const light = scheme === 'light';
	const base = BASE[scheme];

	return sorted({
		'--accent': '#306cb3',
		'--accent-strong': '#306cb3',
		'--avatar-bg': '#ffcb05',
		'--avatar-text': '#1d2e60',
		'--danger': RED,
		'--danger-text': dangerText(scheme),
		'--frame': base.border,
		'--frame-soft': base.border,
		'--header-alert': '#ffcb05',
		'--header-bg': '#1d2e60',
		'--header-line': rgba(WHITE, 0.5),
		'--header-text': WHITE,
		'--link': light ? '#306cb3' : '#8db4ec',
		'--on-accent': WHITE,
		'--panel': base.surface,
		'--selected-bg': '#1d2e60',
		'--selected-text': WHITE,
		'--tab-mark': '#ffcb05',
	});
}

const DEFAULT_FRAME = {
	'--frame-bg': 'var(--panel)',
	'--frame-border': '1px solid var(--border)',
	'--frame-radius': '12px',
	'--frame-shadow': 'none',
};

export const frameVars = (theme) => (theme.frame ? FRAMES[theme.frame].vars : DEFAULT_FRAME);

function sorted(vars) {
	return Object.fromEntries(Object.entries(vars).sort(([a], [b]) => (a < b ? -1 : 1)));
}

// Text and background pairs every theme must keep at AA, for one scheme:
// [label, text color, background color].
export function textPairs(theme, scheme) {
	const vars = palette(theme, scheme);
	const base = BASE[scheme];
	const panel = vars['--panel'];

	return [
		['text on panel', base.text, panel],
		['muted on panel', base.muted, panel],
		['muted on page', base.muted, base.bg],
		['link on panel', vars['--link'], panel],
		['link on page', vars['--link'], base.bg],
		['link on surface', vars['--link'], base.surface],
		['text on accent', vars['--on-accent'], vars['--accent']],
		['selected option', vars['--selected-text'], vars['--selected-bg']],
		['header title', vars['--header-text'], vars['--header-bg']],
		// The sync line under the title is drawn at 85% opacity.
		['header sync line', over(vars['--header-text'], 0.85, vars['--header-bg']), vars['--header-bg']],
		['header alert', vars['--header-alert'], vars['--header-bg']],
		['avatar initial', vars['--avatar-text'], vars['--avatar-bg']],
		['destructive button', vars['--danger-text'], base.surface],
	];
}

// ------------------------------------------------------------ the CSS

export const CSS_START = '/* Themes: printed by themeCss() in js/themes.js. Do not edit by hand. */';
export const CSS_END = '/* End of themes */';

const block = (selector, vars, indent = '') =>
	`${indent}${selector} {\n${Object.entries(vars).map(([key, value]) => `${indent}\t${key}: ${value};`).join('\n')}\n${indent}}`;

export function themeCss() {
	const out = [CSS_START, ''];

	for (const theme of THEMES) {
		out.push(block(`[data-theme="${theme.id}"]`, {...palette(theme, 'light'), ...frameVars(theme)}), '');
	}

	out.push('@media (prefers-color-scheme: dark) {');

	THEMES.forEach((theme, i) => {
		out.push(block(`[data-theme="${theme.id}"]`, palette(theme, 'dark'), '\t'));

		if (i < THEMES.length - 1) {
			out.push('');
		}
	});

	out.push('}', '', CSS_END);

	return out.join('\n');
}
