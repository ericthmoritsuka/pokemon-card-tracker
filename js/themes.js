// Themes (DESIGN.md section 11, "Themes"): the default look plus one theme
// per energy type of the Pokémon Trading Card Game. No DOM here, so Node can
// load it (tests/themes.test.mjs).
//
// The 11 themes are the TCG's energy types, named as the cards name them:
// Grass, Fire, Water, Lightning, Psychic, Fighting, Darkness, Metal, Dragon,
// Colorless, and Fairy (printed from XY to Sun & Moon, kept here). Each one's
// colors follow that energy's color on the cards, and each has a frame for its
// panels and a faint motif in its header, drawn with CSS gradients and small
// inline SVG patterns only: no artwork, no energy symbols, no downloads.
//
// The 18 game types (TYPES) are kept too, each pointing at the energy theme
// it plays as in the TCG (Electric is Lightning, Ghost and Poison are
// Psychic, Normal and Flying are Colorless, and so on). A theme saved under
// a game type's id before the themes became energies ("electric") still
// works: themeById() resolves it, and the CSS paints it.
//
// Every color a theme uses is derived from a few hand-picked ones by the
// rules in palette() below, which keeps every theme at WCAG AA:
//
//   - Header and accent backgrounds are darkened (or, under dark text,
//     lightened) until their text reaches 4.5:1, measured against the
//     header's worst motif pixel as well as its plain color.
//   - Links and the strong accent (focus rings, progress) are darkened, or in
//     dark mode lightened, until they reach 4.5:1 on the panel, the page, and
//     the plain surface.
//   - The active tab mark reaches 3:1 on the tab bar, as a UI shape.
//   - The Scan disc is a Poké Ball per theme (BALLS below): the disc reaches
//     3:1 on the tab bar, and its ring and glyph 3:1 on the disc.
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

// ------------------------------------------------------------ frames

// Frames, after the selectable text box frames in the games' options menus.
// Each is a set of custom properties the panel rules in style.css read, so a
// theme set on an inner element (the picker's preview) frames that element's
// panels without touching the rest of the page. Every frame keeps its
// pattern inside the panel's 16 px padding, so no text sits on it.
const corner = (x, y) => [
	`linear-gradient(var(--frame), var(--frame)) ${x} 6px ${y} 6px / 18px 3px no-repeat`,
	`linear-gradient(var(--frame), var(--frame)) ${x} 6px ${y} 6px / 3px 18px no-repeat`,
];

const rivet = (x, y) => `radial-gradient(circle, var(--frame-soft) 0 1.5px, var(--frame) 2px 3px, transparent 3.5px) ${x} 5px ${y} 5px / 8px 8px no-repeat`;

export const FRAMES = {
	brackets: {
		label: 'Corner brackets',
		vars: {
			'--frame-bg': [...corner('left', 'top'), ...corner('right', 'top'), ...corner('left', 'bottom'), ...corner('right', 'bottom'), 'var(--panel)'].join(', '),
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
			'--frame-radius': '16px',
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
			'--frame-radius': '18px',
			'--frame-shadow': 'inset 0 0 0 3px var(--panel), inset 0 0 0 4px var(--frame-soft)',
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
	// One clean line and a breath of shadow: nothing added.
	plain: {
		label: 'Plain',
		vars: {
			'--frame-bg': 'var(--panel)',
			'--frame-border': '1px solid var(--frame)',
			'--frame-radius': '12px',
			'--frame-shadow': '0 1px 2px rgba(0, 0, 0, 0.06)',
		},
	},
	// A plate with a rivet in each corner.
	riveted: {
		label: 'Riveted plate',
		vars: {
			'--frame-bg': [rivet('left', 'top'), rivet('right', 'top'), rivet('left', 'bottom'), rivet('right', 'bottom'), 'var(--panel)'].join(', '),
			'--frame-border': '2px solid var(--frame)',
			'--frame-radius': '4px',
			'--frame-shadow': 'inset 0 0 0 1px var(--frame-soft)',
		},
	},
	// Lace scallops along the top and bottom edges.
	scalloped: {
		label: 'Scalloped',
		vars: {
			'--frame-bg': [
				'radial-gradient(circle at 50% 0, var(--frame) 0 3.5px, transparent 4px) left top / 14px 6px round no-repeat',
				'radial-gradient(circle at 50% 100%, var(--frame) 0 3.5px, transparent 4px) left bottom / 14px 6px round no-repeat',
				'var(--panel)',
			].join(', '),
			'--frame-border': '1px solid var(--frame-soft)',
			'--frame-radius': '18px',
			'--frame-shadow': 'none',
		},
	},
	// A heavy line with a hard shadow cast down and right.
	shadow: {
		label: 'Cast shadow',
		vars: {
			'--frame-bg': 'var(--panel)',
			'--frame-border': '2px solid var(--frame)',
			'--frame-radius': '4px',
			'--frame-shadow': '4px 4px 0 0 var(--frame-soft)',
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
	// Saw teeth along the top and bottom edges.
	zigzag: {
		label: 'Zigzag',
		vars: {
			'--frame-bg': [
				'linear-gradient(135deg, var(--frame) 25%, transparent 25%) left top / 12px 12px round no-repeat',
				'linear-gradient(225deg, var(--frame) 25%, transparent 25%) left top / 12px 12px round no-repeat',
				'linear-gradient(45deg, var(--frame) 25%, transparent 25%) left bottom / 12px 12px round no-repeat',
				'linear-gradient(315deg, var(--frame) 25%, transparent 25%) left bottom / 12px 12px round no-repeat',
				'var(--panel)',
			].join(', '),
			'--frame-border': '1px solid var(--frame-soft)',
			'--frame-radius': '4px',
			'--frame-shadow': 'none',
		},
	},
};

// ------------------------------------------------------------ the themes

// One row per energy type. light and dark are the swatch's two colors (the
// energy's bright and deep shades). head is the light-mode header, with ink
// (dark) or white text on it; accent is the primary button, likewise; tint
// is how much of the bright shade colors the panels; night is how much of it
// colors the dark-mode header; motif names the header motif below.
const ENERGY_ROWS = [
	{accent: '#2f7d33', dark: '#2f7d33', frame: 'dotted', head: '#2f7d33', id: 'grass', light: '#62b84a', motif: 'veins', name: 'Grass', night: 0.26, tint: 0.09},
	{accent: '#c4460f', dark: '#b8420f', frame: 'brackets', head: '#c4460f', id: 'fire', light: '#f5782f', motif: 'embers', name: 'Fire', night: 0.3, tint: 0.08},
	{accent: '#1767ab', dark: '#1767ab', frame: 'inner', head: '#1767ab', id: 'water', light: '#3ea8e6', motif: 'ripples', name: 'Water', night: 0.28, tint: 0.09},
	{accent: '#f5ca3a', accentInk: true, dark: '#b98900', frame: 'zigzag', head: '#f5ca3a', headInk: true, id: 'lightning', light: '#f8d238', motif: 'bolts', name: 'Lightning', night: 0.17, tint: 0.12},
	{accent: '#8636b4', dark: '#7a32a5', frame: 'stripes', head: '#8636b4', id: 'psychic', light: '#bb6fdd', motif: 'swirl', name: 'Psychic', night: 0.3, tint: 0.09},
	{accent: '#a24a20', dark: '#974620', frame: 'pixel', head: '#a24a20', id: 'fighting', light: '#d6824c', motif: 'grain', name: 'Fighting', night: 0.26, tint: 0.09},
	{accent: '#24484e', dark: '#1d3337', frame: 'shadow', head: '#1d3337', id: 'darkness', light: '#4d8a92', motif: 'stars', name: 'Darkness', night: 0.2, tint: 0.08},
	{accent: '#4f5b68', dark: '#566370', frame: 'riveted', head: '#55616e', id: 'metal', light: '#a9b7c4', motif: 'brushed', name: 'Metal', night: 0.24, tint: 0.12},
	{accent: '#7a5a0e', dark: '#7f5f12', frame: 'double', head: '#d8b03e', headInk: true, id: 'dragon', light: '#d8b03e', motif: 'scales', name: 'Dragon', night: 0.22, tint: 0.1},
	{accent: '#3b3b42', dark: '#8a8780', frame: 'plain', head: '#ffffff', headInk: true, id: 'colorless', light: '#e6e3da', motif: null, name: 'Colorless', night: 0.1, tint: 0.14},
	{accent: '#b23f7d', dark: '#c4478c', frame: 'scalloped', head: '#f6b2d4', headInk: true, id: 'fairy', light: '#f39cca', motif: 'sparkles', name: 'Fairy', night: 0.24, tint: 0.09},
];

// The 18 game types, each with the energy theme it plays as in the TCG.
// js/settings.js checks a Pokémon's PokeAPI type against these ids.
const GAME_TYPES = {
	bug: 'grass',
	dark: 'darkness',
	dragon: 'dragon',
	electric: 'lightning',
	fairy: 'fairy',
	fighting: 'fighting',
	fire: 'fire',
	flying: 'colorless',
	ghost: 'psychic',
	grass: 'grass',
	ground: 'fighting',
	ice: 'water',
	normal: 'colorless',
	poison: 'psychic',
	psychic: 'psychic',
	rock: 'fighting',
	steel: 'metal',
	water: 'water',
};

export const ENERGIES = ENERGY_ROWS.map((row) => ({...row, aliases: Object.keys(GAME_TYPES).filter((type) => GAME_TYPES[type] === row.id && type !== row.id)}));

export const THEMES = [
	{aliases: [], dark: '#1d2e60', frame: null, id: DEFAULT_THEME, light: '#306cb3', motif: null, name: 'Default'},
	...ENERGIES,
];

const BY_ID = new Map(THEMES.flatMap((theme) => [[theme.id, theme], ...theme.aliases.map((alias) => [alias, theme])]));

// A theme by its id or by a game type's id ("electric" is Lightning).
export const themeById = (id) => BY_ID.get(id) || null;

export const isTheme = (id) => BY_ID.has(id);

// The id to keep and to set on the page for a saved value: "electric" is
// "lightning", and anything unknown is the default.
export const canonicalTheme = (id) => (themeById(id) || THEMES[0]).id;

// Game types: {id, name, energy}.
export const TYPES = Object.entries(GAME_TYPES).map(([id, energy]) => ({energy, id, name: id[0].toUpperCase() + id.slice(1)}));

// The theme to suggest for a favorite Pokémon. cardTypes is the energy types
// of its TCG cards (TCGdex's card `types`, one list per card, for example
// [["Lightning"], ["Lightning"], ["Metal"]]); the energy most of them carry
// wins. With no card data, its game types (PokeAPI, first slot first) map
// through GAME_TYPES. Null when neither says anything.
export function suggestedTheme({cardTypes = [], gameTypes = []} = {}) {
	const counts = new Map();

	for (const types of cardTypes) {
		for (const name of types || []) {
			const id = String(name).toLowerCase();

			if (ENERGIES.some((energy) => energy.id === id)) {
				counts.set(id, (counts.get(id) || 0) + 1);
			}
		}
	}

	const fromGame = gameTypes.map((type) => GAME_TYPES[type]).filter(Boolean);
	let best = null;

	for (const [id, count] of counts) {
		const better = !best || count > best.count || (count === best.count && fromGame.indexOf(id) >= 0 && (fromGame.indexOf(best.id) < 0 || fromGame.indexOf(id) < fromGame.indexOf(best.id)));

		if (better) {
			best = {count, id};
		}
	}

	return themeById(best ? best.id : fromGame[0]) || null;
}

// ------------------------------------------------------------ color math

const INK = '#1b1b1f';
const WHITE = '#ffffff';
const BLACK = '#000000';
const RED = '#dc0a2d';

export const AA = 4.5;

// WCAG 2's floor for large text and for the shapes of UI components.
export const AA_SHAPE = 3;

// The fixed surfaces from style.css's :root, which themes leave alone.
export const BASE = {
	dark: {bg: '#16181d', border: '#34343c', muted: '#a8a8b3', surface: '#1f2128', text: '#ececf1'},
	light: {bg: '#f4f4f6', border: '#d9d9e0', muted: '#5b5b66', surface: '#ffffff', text: INK},
};

// The dark-mode header starts from this near-black, with the type mixed in.
const NIGHT = '#121419';

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

// Mixes `color` toward `toward` in 1% steps until it reaches `min` against
// every color in `against`.
const until = (color, toward, against, min = AA) => untilOk(color, toward, (candidate) => against.every((other) => contrast(candidate, other) >= min));

function untilOk(color, toward, ok) {
	for (let step = 0; step <= 100; step++) {
		const candidate = mix(color, toward, step / 100);

		if (ok(candidate)) {
			return candidate;
		}
	}

	return toward;
}

const rgba = (hex, alpha) => `rgba(${rgb(hex).join(', ')}, ${alpha})`;

// ------------------------------------------------------------ motifs

// Each motif is drawn in one ink at one opacity over the header, so its
// worst pixel is known: `over(ink, alpha, header)`. In light mode the ink is
// chosen away from the header's text (shade under white text, light under
// dark text), which can only raise the text's contrast, except for the
// motifs that glow (`lift`: Fire's embers, Darkness's stars, Metal's
// sheen). In dark mode every motif is the type's bright shade, kept faint.
// Either way the worst pixel is measured (textPairs), and headerFor()
// darkens the header until the text passes on it.
//
// Patterns are inline SVG (data URIs) or CSS gradients, with no animation.
// Shapes sit in one group with the opacity on the group, so overlaps never
// add up. Motifs paint the header only: never panels, tiles, or card art.

const svg = (width, height, body, ink, alpha) => {
	const markup = `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}' viewBox='0 0 ${width} ${height}'><g fill='none' stroke='${ink}' stroke-linecap='round' stroke-linejoin='round' opacity='${alpha}'>${body}</g></svg>`;

	return `url("data:image/svg+xml,${markup.replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E')}")`;
};

const dot = (x, y, r) => `<circle cx='${x}' cy='${y}' r='${r}' fill='currentColor' stroke='none'/>`;

const sparkle = (x, y, r) => `<path d='M${x} ${y - r}Q${x} ${y} ${x + r} ${y}Q${x} ${y} ${x} ${y + r}Q${x} ${y} ${x - r} ${y}Q${x} ${y} ${x} ${y - r}Z' stroke='none' fill='currentColor'/>`;

// Fills the shapes written with currentColor in `ink`.
const filled = (body, ink) => body.replace(/currentColor/g, ink);

// name: {alpha: {light, dark}, layers(ink, alpha, shade), lift, glow,
// worst}. layers() returns CSS background layers; alpha is the opacity the
// worst pixel is measured at (worst() widens it where two layers overlap);
// lift marks a motif drawn toward the text color, in glow when given.
const MOTIFS = {
	// Low flame tongues along the bottom edge, in shade, under a soft warm
	// glow rising at the right.
	embers: {
		alpha: {dark: 0.16, light: 0.08},
		glow: '#ffc070',
		lift: true,
		layers: (ink, alpha, shade) => [
			`radial-gradient(ellipse 240px 64px at right 48px bottom -24px, ${rgba(ink, alpha)}, transparent)`,
			svg(48, 24, filled(`<path d='M0 24C5 17 2 12 8 6C10 13 15 16 13 24ZM16 24C21 15 18 9 26 2C28 11 35 15 32 24ZM32 24C37 18 35 14 41 9C43 15 49 18 48 24Z' fill='currentColor' stroke='none'/>`, shade), shade, Math.min(alpha, 0.12)) + ' left bottom / 48px 24px repeat-x',
		],
	},
	// Fine ruled lines and one slanted sheen, like brushed steel.
	brushed: {
		alpha: {dark: 0.06, light: 0.07},
		lift: true,
		layers: (ink, alpha) => [
			`linear-gradient(100deg, transparent 30%, ${rgba(ink, alpha)} 48%, transparent 66%)`,
			`repeating-linear-gradient(0deg, ${rgba(ink, alpha)} 0 1px, transparent 1px 3px)`,
		],
		// Where a line crosses the sheen, both apply.
		worst: (alpha) => 1 - (1 - alpha) ** 2,
	},
	// Zigzag currents, offset so they never line up.
	bolts: {
		alpha: {dark: 0.14, light: 0.42},
		layers: (ink, alpha) => [
			svg(64, 56, `<path d='M-4 18l12-8 10 8 12-10 10 8 12-9 10 7' stroke-width='2'/><path d='M-4 46l12-8 10 8 12-10 10 8 12-9 10 7' stroke-width='2'/>`, ink, alpha) + ' right top / 64px 56px repeat-x',
		],
	},
	// Fine overlapping scales.
	scales: {
		alpha: {dark: 0.09, light: 0.3},
		layers: (ink, alpha) => [
			svg(20, 10, `<path d='M0 10a10 10 0 0 1 20 0M-10 5a10 10 0 0 1 20 0M10 5a10 10 0 0 1 20 0M-10 15a10 10 0 0 1 20 0M10 15a10 10 0 0 1 20 0' stroke-width='1'/>`, ink, alpha) + ' left top / 20px 10px repeat',
		],
	},
	// Small four-point sparkles.
	sparkles: {
		alpha: {dark: 0.2, light: 0.75},
		layers: (ink, alpha) => [
			svg(96, 56, filled(`${sparkle(18, 14, 4)}${sparkle(60, 38, 5)}${sparkle(84, 12, 3)}${sparkle(38, 48, 2.5)}`, ink), ink, alpha) + ' right top / 96px 56px repeat-x',
		],
	},
	// A scatter of tiny stars on a deep sky.
	stars: {
		alpha: {dark: 0.24, light: 0.3},
		lift: true,
		layers: (ink, alpha) => [
			svg(90, 56, filled(`${dot(8, 10, 0.9)}${dot(30, 40, 0.7)}${dot(52, 18, 1.1)}${dot(70, 46, 0.8)}${dot(82, 6, 0.7)}${dot(44, 52, 0.6)}${sparkle(64, 26, 2.5)}`, ink), ink, alpha) + ' right top / 90px 56px repeat-x',
		],
	},
	// A slow swirl spiraling out at the right.
	swirl: {
		alpha: {dark: 0.14, light: 0.22},
		layers: (ink, alpha) => [
			svg(160, 72, `<path d='M100 36a4 4 0 0 1 8 0a8 8 0 0 1-16 0a12 12 0 0 1 24 0a16 16 0 0 1-32 0a20 20 0 0 1 40 0a24 24 0 0 1-48 0a28 28 0 0 1 56 0a32 32 0 0 1-64 0' stroke-width='2'/>`, ink, alpha) + ' right 64px center / 160px 72px no-repeat',
		],
	},
	// Rough stone grain: irregular chips and specks.
	grain: {
		alpha: {dark: 0.14, light: 0.16},
		layers: (ink, alpha) => [
			svg(44, 44, filled(`<path d='M4 6l4-2 2 3-3 3z' fill='currentColor' stroke='none'/><path d='M24 14l5-1 1 4-4 1z' fill='currentColor' stroke='none'/><path d='M12 30l3-1 2 3-4 2z' fill='currentColor' stroke='none'/><path d='M34 34l4 0 0 3-3 1z' fill='currentColor' stroke='none'/>${dot(18, 8, 0.8)}${dot(38, 6, 1)}${dot(30, 26, 0.7)}${dot(6, 22, 1)}${dot(24, 40, 0.8)}`, ink), ink, alpha) + ' left top / 44px 44px repeat',
		],
	},
	// Gentle ripples along the bottom edge.
	ripples: {
		alpha: {dark: 0.14, light: 0.2},
		layers: (ink, alpha) => [
			svg(60, 24, `<path d='M0 8q15-7 30 0t30 0' stroke-width='1.5'/><path d='M-15 18q15-7 30 0t30 0t30 0' stroke-width='1.5'/>`, ink, alpha) + ' left bottom / 60px 24px repeat-x',
		],
	},
	// A leaf at the right: its outline, midrib, and side veins.
	veins: {
		alpha: {dark: 0.16, light: 0.2},
		layers: (ink, alpha) => [
			svg(176, 56, `<path d='M8 50C40 14 118 2 170 6C146 38 78 60 8 50Z' stroke-width='2'/><path d='M8 50Q90 30 170 6' stroke-width='2'/><path d='M42 42Q46 30 40 20M70 35Q78 22 74 10M100 27Q110 16 108 6M54 40Q70 46 84 50M86 31Q104 36 118 40M118 22Q134 25 146 28' stroke-width='1.4'/>`, ink, alpha) + ' right 64px center / 176px 56px no-repeat',
		],
	},
};

// The motif's ink: in light mode, away from the header's text (shade under
// white text, light under dark text) unless the motif glows; in dark mode,
// the type's own bright shade, kept faint.
function motifInk(theme, scheme, headText) {
	const motif = MOTIFS[theme.motif] || {};

	if (scheme === 'dark') {
		return motif.glow || theme.light;
	}

	if (headText !== WHITE) {
		return WHITE;
	}

	return motif.lift ? motif.glow || WHITE : BLACK;
}

// A second ink for motifs that glow in one place and shade in another:
// always away from the text in light mode, the type's shade in dark mode.
function shadeInk(theme, scheme, headText) {
	if (scheme === 'dark') {
		return theme.light;
	}

	return headText === WHITE ? BLACK : WHITE;
}

// The motif's worst pixel over one header color: its ink at its opacity.
// The plain header when the theme has no motif.
function worstMotifPixel(theme, scheme, header, headText) {
	const motif = MOTIFS[theme.motif];

	if (!motif) {
		return header;
	}

	const alpha = motif.alpha[scheme];
	const worst = motif.worst ? motif.worst(alpha) : alpha;

	return over(motifInk(theme, scheme, headText), worst, header);
}

// The header's CSS background layers for one scheme, on top of
// --header-bg. Dark mode adds the accent as a 3 px bar along the bottom,
// as plans/design-review.md asks.
function motifLayers(theme, scheme, vars) {
	const layers = [];

	if (scheme === 'dark' && theme.id !== DEFAULT_THEME) {
		layers.push(`linear-gradient(${vars['--accent']}, ${vars['--accent']}) left bottom / 100% 3px no-repeat`);
	}

	if (scheme === 'light' && theme.id === 'colorless') {
		layers.push(`linear-gradient(${BASE.light.border}, ${BASE.light.border}) left bottom / 100% 1px no-repeat`);
	}

	const motif = MOTIFS[theme.motif];

	if (motif) {
		layers.push(...motif.layers(motifInk(theme, scheme, vars['--header-text']), motif.alpha[scheme], shadeInk(theme, scheme, vars['--header-text'])));
	}

	return layers.length ? layers.join(', ') : 'none';
}

// A header background that keeps `text` at AA, both at full strength (the
// title) and at the 85% opacity the sync line under it uses, on the plain
// color and on the motif's worst pixel.
function headerFor(theme, scheme, color, toward, text) {
	return untilOk(color, toward, (bg) => [bg, worstMotifPixel(theme, scheme, bg, text)].every((pixel) => contrast(text, pixel) >= AA && contrast(over(text, 0.85, pixel), pixel) >= AA));
}

// ------------------------------------------------------------ Poké Balls

// The raised Scan button is a Poké Ball that follows the theme (Eric,
// 2026-10-02): the default keeps the red Poké Ball, and each energy type
// takes the ball whose colors sit with its own. A ball is a disc color and a
// ring color, hand-picked here; scanVars() then adjusts them by rule, so
// every pair holds at 3:1 (the WCAG floor for UI shapes) in both schemes:
//
//   - The disc is darkened in light mode, or lightened in dark mode, until
//     it reaches 3:1 on the tab bar (the plain surface). The two black balls
//     (Dusk, Ultra) would need to go grey to get there in dark mode, so each
//     turns inside out instead: its band color becomes the disc, and black
//     the ring.
//   - The ring, and the glyph drawn in the ring's color, are lightened or
//     darkened until they reach 3:1 on the disc. The scan tray's count dot
//     wears the ring as its border, so it is outlined on every disc.
//
// Premier's white disc is the one exception: nothing white reaches 3:1 on
// the white light-mode bar, and a grey disc is no Premier Ball, so in light
// mode its red ring carries the edge (3:1 on the bar, checked in its place)
// and the glyph is red. In dark mode the white disc passes on its own.
//
// The small Poké Ball finish badge on tiles (.ball) is not a theme: it is a
// real Poké Ball in every theme, on style.css's fixed --pokeball.
export const BALLS = {
	colorless: {disc: WHITE, name: 'Premier Ball', ring: RED},
	darkness: {dark: {disc: '#2f8a4f', ring: INK}, disc: INK, name: 'Dusk Ball', ring: '#4ad37a'},
	default: {disc: RED, name: 'Poké Ball', ring: WHITE},
	dragon: {dark: {disc: '#f5c518', ring: INK}, disc: INK, name: 'Ultra Ball', ring: '#ffd23f'},
	fairy: {disc: '#d9509a', name: 'Heal Ball', ring: WHITE},
	fighting: {disc: '#b4531f', name: 'Sport Ball', ring: '#fff1d6'},
	fire: {disc: '#c2410c', name: 'Repeat Ball', ring: '#ffd23f'},
	grass: {disc: '#2f7d33', name: 'Nest Ball', ring: WHITE},
	lightning: {disc: '#1e6fd9', name: 'Quick Ball', ring: '#ffd23f'},
	metal: {disc: '#4a6b8a', name: 'Heavy Ball', ring: '#d0d6dc'},
	psychic: {disc: '#6b3fa0', name: 'Master Ball', ring: '#f6a8d8'},
	water: {disc: '#1b4f9c', name: 'Dive Ball', ring: '#a8d8ff'},
};

// The Scan disc's custom properties for one scheme: --scan (the disc),
// --scan-ring, and --scan-glyph (the icon, in the ring's color).
export function scanVars(theme, scheme) {
	const base = BASE[scheme];
	const ball = BALLS[theme.id];
	const picked = scheme === 'dark' && ball.dark ? ball.dark : ball;
	const disc = picked.disc === WHITE ? WHITE : until(picked.disc, scheme === 'light' ? BLACK : WHITE, [base.surface], AA_SHAPE);
	const ring = until(picked.ring, luminance(picked.ring) > luminance(disc) ? WHITE : BLACK, [disc], AA_SHAPE);

	return {'--scan': disc, '--scan-glyph': ring, '--scan-ring': ring};
}

// ------------------------------------------------------------ palettes

// The custom properties a theme sets, for one color scheme.
export function palette(theme, scheme) {
	const base = BASE[scheme];

	if (theme.id === DEFAULT_THEME) {
		return sorted({...defaultPalette(scheme), ...scanVars(theme, scheme)});
	}

	const panel = mix(base.surface, theme.light, scheme === 'light' ? theme.tint : Math.min(theme.tint, 0.08));
	const backgrounds = [panel, base.bg, base.surface];
	const vars = {};

	if (scheme === 'light') {
		const headText = theme.headInk ? INK : WHITE;
		const onAccent = theme.accentInk ? INK : WHITE;
		const header = headerFor(theme, scheme, theme.head, theme.headInk ? WHITE : BLACK, headText);
		const accent = until(theme.accent, theme.accentInk ? WHITE : BLACK, [onAccent]);
		const strong = until(theme.dark, BLACK, backgrounds);

		Object.assign(vars, {
			'--accent': accent,
			'--accent-strong': strong,
			'--avatar-bg': theme.headInk ? INK : WHITE,
			'--avatar-text': theme.headInk ? (theme.id === 'colorless' ? WHITE : theme.light) : strong,
			'--frame': until(theme.dark, BLACK, [panel], AA_SHAPE),
			'--header-bg': header,
			'--header-text': headText,
			'--link': strong,
			'--on-accent': onAccent,
			'--tab-mark': until(theme.light, BLACK, [base.surface], AA_SHAPE),
		});
	}
	else {
		const accent = until(theme.light, WHITE, [INK]);
		const header = headerFor(theme, scheme, mix(NIGHT, theme.light, theme.night), BLACK, WHITE);
		const strong = until(theme.light, WHITE, backgrounds);

		Object.assign(vars, {
			'--accent': accent,
			'--accent-strong': strong,
			'--avatar-bg': accent,
			'--avatar-text': INK,
			// Softer than the accent, so a framed panel does not glare on the
			// dark page; still 3:1 on the panel.
			'--frame': until(mix(panel, theme.light, 0.7), WHITE, [panel], AA_SHAPE),
			'--header-bg': header,
			'--header-text': WHITE,
			'--link': strong,
			'--on-accent': INK,
			'--tab-mark': until(theme.light, WHITE, [base.surface], AA_SHAPE),
		});
	}

	Object.assign(vars, {
		'--danger': RED,
		'--danger-text': dangerText(scheme),
		'--frame-soft': mix(panel, vars['--frame'], 0.4),
		'--header-alert': vars['--header-text'],
		'--header-line': rgba(vars['--header-text'], 0.5),
		'--panel': panel,
		'--selected-bg': vars['--accent'],
		'--selected-text': vars['--on-accent'],
	});

	return sorted({...vars, ...scanVars(theme, scheme)});
}

// Red text that reads on the plain surface, where destructive buttons sit.
// The red itself is the same everywhere; dark mode lightens it for text.
export const dangerText = (scheme) => (scheme === 'light' ? RED : until(RED, WHITE, [BASE.dark.surface, BASE.dark.bg]));

// The default look, as style.css's :root already paints it: the pokedex's
// navy header, blue accent, and yellow marks. Printed as a theme too, so the
// picker's preview can show it inside a typed page.
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

// The header motif, as --motif-header (background layers over the
// header's color), for one scheme.
export const motifVars = (theme, scheme) => ({'--motif-header': motifLayers(theme, scheme, palette(theme, scheme))});

function sorted(vars) {
	return Object.fromEntries(Object.entries(vars).sort(([a], [b]) => (a < b ? -1 : 1)));
}

// Pairs every theme must keep at AA, for one scheme: [label, foreground,
// background, minimum ratio]. Text needs 4.5:1; the active tab mark, a UI
// shape, needs 3:1.
export function textPairs(theme, scheme) {
	const vars = palette(theme, scheme);
	const base = BASE[scheme];
	const panel = vars['--panel'];
	const header = vars['--header-bg'];
	const headText = vars['--header-text'];
	const worst = worstMotifPixel(theme, scheme, header, headText);
	const pairs = [
		['text on panel', base.text, panel, AA],
		['muted on panel', base.muted, panel, AA],
		['muted on page', base.muted, base.bg, AA],
		['link on panel', vars['--link'], panel, AA],
		['link on page', vars['--link'], base.bg, AA],
		['link on surface', vars['--link'], base.surface, AA],
		['text on accent', vars['--on-accent'], vars['--accent'], AA],
		['selected option', vars['--selected-text'], vars['--selected-bg'], AA],
		['header title', headText, header, AA],
		// The sync line under the title is drawn at 85% opacity.
		['header sync line', over(headText, 0.85, header), header, AA],
		['header title on the motif', headText, worst, AA],
		['header sync line on the motif', over(headText, 0.85, worst), worst, AA],
		['header alert', vars['--header-alert'], header, AA],
		['avatar initial', vars['--avatar-text'], vars['--avatar-bg'], AA],
		['destructive button', vars['--danger-text'], base.surface, AA],
		['scan ring on the disc', vars['--scan-ring'], vars['--scan'], AA_SHAPE],
		['scan glyph on the disc', vars['--scan-glyph'], vars['--scan'], AA_SHAPE],
		// A white disc (Premier Ball) cannot reach 3:1 on the white bar; its
		// ring is its edge there.
		vars['--scan'] === WHITE && scheme === 'light'
			? ['scan ring on the tab bar', vars['--scan-ring'], base.surface, AA_SHAPE]
			: ['scan disc on the tab bar', vars['--scan'], base.surface, AA_SHAPE],
	];

	// The default's yellow tab mark is the pokedex's, on a tab that also
	// turns its label from muted to full text, so it is not checked as a
	// shape; every energy theme's mark is.
	if (theme.id !== DEFAULT_THEME) {
		pairs.push(['active tab mark', vars['--tab-mark'], base.surface, AA_SHAPE]);
	}

	return pairs;
}

// ------------------------------------------------------------ the CSS

export const CSS_START = '/* Themes: printed by themeCss() in js/themes.js. Do not edit by hand. */';
export const CSS_END = '/* End of themes */';

const selectorFor = (theme) => [theme.id, ...theme.aliases].map((id) => `[data-theme="${id}"]`).join(',\n');

const block = (selector, vars, indent = '') =>
	`${indent}${selector.split('\n').join(`\n${indent}`)} {\n${Object.entries(vars).map(([key, value]) => `${indent}\t${key}: ${value};`).join('\n')}\n${indent}}`;

// The header takes its theme's motif over its color. A theme on an inner
// element (the picker's preview) carries its own motif to its own bar.
const MOTIF_RULE = `[data-theme] .top,
[data-theme] .preview-bar {
	background: var(--motif-header, none), var(--header-bg);
}`;

export function themeCss() {
	const out = [CSS_START, ''];

	for (const theme of THEMES) {
		out.push(block(selectorFor(theme), {...palette(theme, 'light'), ...frameVars(theme), ...motifVars(theme, 'light')}), '');
	}

	out.push('@media (prefers-color-scheme: dark) {');

	THEMES.forEach((theme, i) => {
		out.push(block(selectorFor(theme), {...palette(theme, 'dark'), ...motifVars(theme, 'dark')}, '\t'));

		if (i < THEMES.length - 1) {
			out.push('');
		}
	});

	out.push('}', '', MOTIF_RULE, '', CSS_END);

	return out.join('\n');
}
