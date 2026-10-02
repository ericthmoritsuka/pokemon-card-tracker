// The person's settings (DESIGN.md sections 4 and 11): the theme and the
// favorite Pokémon, kept in the document as settings: {theme,
// favorite_pokemon, updated_at}, so they follow the person to every device.
//
// The theme also lives on the device, in localStorage, for two reasons: a
// script in index.html's <head> reads it and sets data-theme before the first
// paint, so the page never flashes the default; and signed out, the device is
// the only place a theme can live. Signed in, the document's theme wins
// whenever it holds one.
//
// js/collection.js has no setter for settings, so a change is merged in
// through mergeIntoLocal, as js/checklists.js does for goals. js/merge.js
// gives the settings object to whichever side changed it last (its
// updated_at), so the new value wins here and on the server. That save is
// marked as coming from the sync, which does not schedule a push, so this
// module asks the sync to run a moment later.

import {currentUser, onUser} from './auth.js';
import {MAX_DEX, spriteUrl} from './checklists.js';
import {loadDocument, mergeIntoLocal, onChange} from './collection.js';
import {BASE} from './dom.js';
import {nextStamp} from './merge.js';
import {canonicalTheme, DEFAULT_THEME, isTheme, palette, suggestedTheme, themeById, TYPES} from './themes.js';

export const THEME_KEY = 'card-tracker-theme';

const PUSH_DELAY_MS = 2000;
const TYPE_KEY = 'card-tracker-primary-type';
const CARD_TYPES_KEY = 'card-tracker-card-types';
const TCGDEX_GRAPHQL = 'https://api.tcgdex.net/v2/graphql';

const DEFAULT_ICON = `${BASE}icons/icon-192.png`;

export const validDex = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_DEX;

const listeners = new Set();

function readDevice(key) {
	try {
		return localStorage.getItem(key);
	}
	catch {
		return null;
	}
}

function writeDevice(key, value) {
	try {
		localStorage.setItem(key, value);
	}
	catch {
		// Private mode or storage off: the theme still applies for this visit.
	}
}

// ------------------------------------------------------------ the theme

export function currentTheme() {
	const id = document.documentElement.dataset.theme;

	return isTheme(id) ? id : DEFAULT_THEME;
}

const darkScheme = () => window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

// The browser bar takes the header's color.
function paintThemeColor(id) {
	const meta = document.querySelector('meta[name="theme-color"]');
	const theme = themeById(id);

	if (meta && theme) {
		meta.content = palette(theme, darkScheme() ? 'dark' : 'light')['--header-bg'];
	}
}

// Applies a theme to the page and remembers it on the device. Saving it to
// the person's document is chooseTheme's job. A theme saved under a game
// type's id ("electric") is put on, and kept, as its energy ("lightning").
export function applyTheme(id) {
	const theme = canonicalTheme(id);

	document.documentElement.dataset.theme = theme;
	writeDevice(THEME_KEY, theme);
	paintThemeColor(theme);
	emit();

	return theme;
}

// The person picked a theme: apply it, and signed in, save it to the
// document so it syncs.
export async function chooseTheme(id) {
	const theme = applyTheme(id);

	await saveSettings({theme});

	return theme;
}

// ------------------------------------------------------------ settings

// The signed-in person's settings, or null signed out (and while the
// phone's document still belongs to someone else).
export async function accountSettings() {
	const user = currentUser();

	if (!user) {
		return null;
	}

	const doc = await loadDocument();

	if (doc.user_id !== user.id) {
		return null;
	}

	return doc.settings && typeof doc.settings === 'object' ? doc.settings : {};
}

export async function favoritePokemon() {
	const settings = await accountSettings();
	const n = settings ? Number(settings.favorite_pokemon) : NaN;

	return validDex(n) ? n : null;
}

let pushTimer = null;

function schedulePush() {
	clearTimeout(pushTimer);
	pushTimer = setTimeout(() => {
		import('./sync.js')
			.then((sync) => sync.syncNow())
			.catch(() => {
				// The next sync (opening the app, coming back online) pushes it.
			});
	}, PUSH_DELAY_MS);
}

// Merges `patch` into the signed-in person's settings. Signed out, there is
// no document to follow anyone, so nothing is saved and false comes back.
export async function saveSettings(patch) {
	const settings = await accountSettings();

	if (!settings) {
		return false;
	}

	await mergeIntoLocal({settings: {...settings, ...patch, updated_at: nextStamp(settings.updated_at)}});
	schedulePush();

	return true;
}

export const setFavoritePokemon = (n) => saveSettings({favorite_pokemon: validDex(n) ? n : null});

// ------------------------------------------------------------ primary type

const TYPE_IDS = new Set(TYPES.map((type) => type.id));

function cachedTypes() {
	try {
		return JSON.parse(readDevice(TYPE_KEY) || '{}') || {};
	}
	catch {
		return {};
	}
}

// The Pokémon's first type, as a theme id ("electric"), or null when it
// cannot be learned (offline on a first visit). PokeAPI's GraphQL endpoint
// answers in a few hundred bytes; the REST record is the fallback. Kept on
// the device, since a species' type does not change.
export async function primaryType(n) {
	if (!validDex(n)) {
		return null;
	}

	const cache = cachedTypes();

	if (TYPE_IDS.has(cache[n])) {
		return cache[n];
	}

	let type = null;

	try {
		const response = await fetch('https://graphql.pokeapi.co/v1beta2', {
			body: JSON.stringify({query: `{ pokemontype(where: {pokemon_id: {_eq: ${n}}, slot: {_eq: 1}}) { type { name } } }`}),
			headers: {'content-type': 'application/json'},
			method: 'POST',
		});
		const json = response.ok ? await response.json() : null;
		const row = json && json.data && json.data.pokemontype && json.data.pokemontype[0];

		type = row && row.type ? row.type.name : null;
	}
	catch {
		type = null;
	}

	if (!TYPE_IDS.has(type)) {
		try {
			const response = await fetch(`https://pokeapi.co/api/v2/pokemon/${n}`);
			const json = response.ok ? await response.json() : null;
			const slot = json && (json.types || []).find((entry) => entry.slot === 1);

			type = slot ? slot.type.name : null;
		}
		catch {
			type = null;
		}
	}

	if (!TYPE_IDS.has(type)) {
		return null;
	}

	writeDevice(TYPE_KEY, JSON.stringify({...cachedTypes(), [n]: type}));

	return type;
}

// ------------------------------------------------------------ the suggestion

function cachedCardTypes() {
	try {
		return JSON.parse(readDevice(CARD_TYPES_KEY) || '{}') || {};
	}
	catch {
		return {};
	}
}

// How many of the Pokémon's TCG cards carry each energy ({Lightning: 98}),
// from one TCGdex GraphQL query (the first 100 cards are plenty to decide),
// or null when TCGdex cannot be reached. Kept on the device.
async function cardTypeCounts(n) {
	const cache = cachedCardTypes();

	if (cache[n] && typeof cache[n] === 'object') {
		return cache[n];
	}

	try {
		const response = await fetch(TCGDEX_GRAPHQL, {
			body: JSON.stringify({query: `{ cards(filters: {dexId: ${n}}, pagination: {page: 1, count: 100}) { types } }`}),
			headers: {'content-type': 'application/json'},
			method: 'POST',
		});
		const json = response.ok ? await response.json() : null;
		const cards = json && json.data && json.data.cards;

		if (!Array.isArray(cards)) {
			return null;
		}

		const counts = {};

		for (const card of cards) {
			for (const type of (card && card.types) || []) {
				counts[type] = (counts[type] || 0) + 1;
			}
		}

		writeDevice(CARD_TYPES_KEY, JSON.stringify({...cachedCardTypes(), [n]: counts}));

		return counts;
	}
	catch {
		return null;
	}
}

// The theme to suggest for a favorite Pokémon: the energy most of its TCG
// cards carry, and with no card data, the energy its first game type plays
// as (js/themes.js suggestedTheme). Null when neither can be learned.
export async function suggestedThemeFor(n) {
	if (!validDex(n)) {
		return null;
	}

	const [counts, type] = await Promise.all([cardTypeCounts(n), primaryType(n)]);
	const cardTypes = Object.entries(counts || {}).flatMap(([name, count]) => Array.from({length: count}, () => [name]));

	return suggestedTheme({cardTypes, gameTypes: type ? [type] : []});
}

// ------------------------------------------------------------ the header

// Signed in, the header shows a mark beside the title: the app icon, or the
// favorite Pokémon's sprite, which replaces the icon in the tab too. Signed
// out, the wide Sign in button needs the room, so the mark is hidden. The
// home screen icon cannot change: an installed web app takes it from the one
// manifest every person shares (DESIGN.md section 11).
function drawFavorite(n) {
	const mark = document.getElementById('brand-mark');
	const icon = document.querySelector('link[rel="icon"]');
	const src = n ? spriteUrl(n) : DEFAULT_ICON;

	if (mark) {
		mark.hidden = !currentUser();
	}

	if (mark && mark.getAttribute('src') !== src) {
		mark.src = src;
		mark.classList.toggle('sprite-mark', Boolean(n));
		mark.dataset.dex = n ? String(n) : '';
	}

	if (icon && icon.getAttribute('href') !== src) {
		icon.href = src;
		icon.type = 'image/png';

		if (n) {
			icon.removeAttribute('sizes');
		}
		else {
			icon.setAttribute('sizes', '192x192');
		}
	}
}

// listener() runs whenever the theme or the settings change.
export function onSettings(listener) {
	listeners.add(listener);

	return () => listeners.delete(listener);
}

function emit() {
	listeners.forEach((listener) => listener());
}

async function refresh() {
	const settings = await accountSettings();

	if (settings && isTheme(settings.theme) && canonicalTheme(settings.theme) !== currentTheme()) {
		applyTheme(settings.theme);
	}

	const n = settings ? Number(settings.favorite_pokemon) : NaN;

	drawFavorite(validDex(n) ? n : null);
	emit();
}

// Once, from app.js: the theme the <head> script set is checked, and the
// document's settings are applied on sign-in and whenever a sync brings
// them in from another device.
export function startSettings() {
	applyTheme(readDevice(THEME_KEY));

	const run = () => refresh().catch(() => {});

	onUser(run);
	onChange(run);

	if (window.matchMedia) {
		window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => paintThemeColor(currentTheme()));
	}

	run();
}
