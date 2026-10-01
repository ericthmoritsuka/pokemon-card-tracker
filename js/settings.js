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
import {DEFAULT_THEME, isTheme, palette, themeById, TYPES} from './themes.js';

export const THEME_KEY = 'card-tracker-theme';

const PUSH_DELAY_MS = 2000;
const TYPE_KEY = 'card-tracker-primary-type';

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
// the person's document is chooseTheme's job.
export function applyTheme(id) {
	const theme = isTheme(id) ? id : DEFAULT_THEME;

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

// A stamp strictly newer than the last one, so the merge always takes the
// new settings even when two changes land in one millisecond.
function nextStamp(previous) {
	const now = Date.now();
	const before = Date.parse(previous);

	return new Date(Number.isNaN(before) || now > before ? now : before + 1).toISOString();
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

	if (settings && isTheme(settings.theme) && settings.theme !== currentTheme()) {
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
