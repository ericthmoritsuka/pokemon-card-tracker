// Every card of a Pokémon (DESIGN.md section 11), opened from a checklist
// row, or from the card page without a list:
//   lists/<listId>/pokemon/<dex>                  the person's own list
//   family/<userId>/lists/<listId>/pokemon/<dex>  a family member's, view only
//   pokemon/<dex>/<language>                      no list, from the card
//                                                 page: one language at a
//                                                 time, from a row of flags
//
// "Jigglypuff, 9 of 48 cards": every print in the list's languages, newest
// first, as the shared tiles (js/tile.js). An owned card carries the owned
// mark and the flags of the languages it is owned in; a missing one is
// dimmed, with no flag, and one tap puts it on the wishlist. All, Owned,
// and Missing, and "Count every finish", are remembered on the phone. A tile
// opens the card page with this grid as its swipe context
// (js/card-swipe.js). The data is js/pokemon-cards.js.
//
// languagesControl() is the list's languages setting (flags and an edit
// control); the checklist screen shows it too. The screen without a list
// has a row of flags instead (drawFlags): a flag per language, one shown at
// a time, each language's prints loaded the first time its flag is tapped
// (Eric, 2026-11-09).

import {currentUser} from './auth.js';
import {offerCardList} from './card-swipe.js';
import {cardImage} from './catalog.js';
import {mainName, tileNames} from './catalog-views.js';
import {
	getChecklist,
	isChecklist,
	listLanguages,
	nameOf,
	namesLanguages,
	setListLanguages,
	speciesNames,
	spriteUrl,
} from './checklists.js';
import {isLive, listCards, onChange} from './collection.js';
import {BASE, errorText, h, segmentCounts} from './dom.js';
import {flagBadge, flagSrc, flagText} from './flags.js';
import {formatCount, plural} from './format.js';
import {ASIAN_LANGUAGES, LIST_LANGUAGE_CODES, NAME_TABLES, catalogFor, catalogLanguage, htmlLang, isCatalogLanguage, languageLabel} from './languages.js';
import {cardNames, hasOwnNames, romanizeKorean} from './names.js';
import {
	CATALOG_HEADINGS,
	catalogsFor,
	cardFinishes,
	copiesByPrintOnce,
	dexFromParam,
	FLAG_LANGUAGES,
	flagCount,
	flagLanguageFrom,
	flagLanguages,
	knownRecord,
	loadAsian,
	loadInternational,
	needsLoad,
	newestFirst,
	ownedFinishes,
	passesFilter,
	printCounts,
	pokemonCardsRoute,
	printKey,
	printRecord,
	tally,
	wishLanguage,
} from './pokemon-cards.js';
import {mainArt, onImagesChange} from './photos/index.js';
import {readChoice, saveChoice} from './settings.js';
import {toast} from './shell.js';
import {memberDocument} from './sync.js';
import {cardArt, cardTile, entryFinish, variantFinish} from './tile.js';
import {addToWishlist, listWishlist} from './wishlist.js';

// The same order as everywhere: All, Owned, Missing.
const FILTERS = [
	{label: 'All', value: 'all'},
	{label: 'Owned', value: 'owned'},
	{label: 'Missing', value: 'missing'},
];

const FILTER_KEY = 'cardTracker.pokemonCardsFilter';
const FINISHES_KEY = 'cardTracker.pokemonCardsEveryFinish';
const CONCURRENCY = 4;

// The languages a list can hold, in the language table's order.
const LANGUAGE_CHOICES = LIST_LANGUAGE_CODES;

const link = (route, attrs, ...children) => h('a', {...attrs, 'data-link': route, href: BASE + route}, ...children);

export const pokemonRoute = (base, listId, n) => `${base}/${encodeURIComponent(listId)}/pokemon/${n}`;

// ------------------------------------------------------- whose list

const MINE = {
	base: 'lists',
	load: async (id) => {
		const [goal, entries, wishlist] = await Promise.all([getChecklist(id), listCards(), listWishlist()]);

		return {entries, goal, wishlist};
	},
	readOnly: false,
	watch: (reload) => onChange(reload),
};

// No list, opened from the card page: the person's own cards and wishlist,
// in the language of the flag chosen. There is no list, so the goal is an
// empty stand-in the flags take the place of.
const CATALOG = {
	base: null,
	flags: true,
	load: async () => {
		const [entries, wishlist] = await Promise.all([listCards(), listWishlist()]);

		return {entries, goal: {}, wishlist};
	},
	readOnly: false,
	watch: (reload) => onChange(reload),
};

// A family member's list, read from the server once per screen, online
// only, like the family checklist screens.
function familySource(userId) {
	let docPromise = null;

	return {
		base: `family/${encodeURIComponent(userId)}/lists`,
		load: async (id) => {
			if (!currentUser()) {
				throw new Error('Sign in to see your family\'s lists.');
			}

			if (!navigator.onLine) {
				throw new Error('A family member\'s lists show when you are online.');
			}

			docPromise = docPromise || memberDocument(userId).catch((err) => {
				docPromise = null;

				throw err;
			});

			const doc = (await docPromise) || {};
			const goal = (doc.goals || []).find((item) => item.id === id && isLive(item) && isChecklist(item)) || null;

			return {entries: (doc.cards || []).filter(isLive), goal, records: doc.card_info || [], wishlist: []};
		},
		readOnly: true,
		userId,
		watch: null,
	};
}

// --------------------------------------------------- list languages

// The list's languages as flags, with Edit opening checkboxes. Returns
// {element, update(goal)}; update redraws the flags unless the editor is
// open. readOnly shows the flags alone.
export function languagesControl({listId, readOnly = false, onSaved = null}) {
	let goal = null;
	let editing = false;

	const element = h('div', {class: 'pc-languages', id: 'list-languages'});

	// A list that names no languages counts a copy in any language, as its
	// ticks do, and says so rather than showing every flag.
	function drawFlags() {
		const all = !namesLanguages(goal);
		const languages = listLanguages(goal);
		const names = all ? 'Counts copies in any language' : languages.map(languageLabel).join(', ');
		const edit = readOnly ? null : h('button', {
			'aria-label': `Change the list's languages (${all ? 'any language' : names})`,
			class: 'small',
			id: 'list-languages-edit',
			onclick: openEditor,
			type: 'button',
		}, 'Edit');

		element.replaceChildren(
			h('span', {class: 'pc-languages-label'}, 'Languages'),
			all
				? h('span', {class: 'pc-languages-all', id: 'list-languages-all'}, 'All')
				: flagBadge(languages, {className: 'flags-inline', prefix: 'Counts copies in'}),
			h('span', {class: 'pc-languages-names muted'}, names),
			// replaceChildren prints a null argument as "null".
			...(edit ? [edit] : [])
		);
	}

	function openEditor() {
		editing = true;

		// Any language is its own choice, ticked for a list that names none:
		// it counts every copy, German, Spanish, Italian, and copies with no
		// language included, which ticking every box below cannot.
		let any = !namesLanguages(goal);
		const chosen = new Set(any ? [] : listLanguages(goal));
		const error = h('p', {'aria-live': 'polite', class: 'form-error'});
		const anyBox = h('input', {checked: any, id: 'list-languages-any', name: 'list-language', type: 'checkbox', value: 'any'});
		const languageBoxes = [];
		const boxes = LANGUAGE_CHOICES.map((code) => {
			const box = h('input', {checked: chosen.has(code), name: 'list-language', onchange: (event) => {
				if (event.target.checked) {
					chosen.add(code);
					any = false;
					anyBox.checked = false;
				}
				else {
					chosen.delete(code);
				}
			}, type: 'checkbox', value: code});

			languageBoxes.push(box);

			return h('label', {class: 'pc-language-choice'},
				box,
				flagBadge([code], {className: 'flags-inline', prefix: null}),
				h('span', null, languageLabel(code))
			);
		});

		anyBox.addEventListener('change', () => {
			any = anyBox.checked;

			if (any) {
				chosen.clear();

				for (const box of languageBoxes) {
					box.checked = false;
				}
			}
		});

		const save = h('button', {class: 'primary', id: 'list-languages-save', type: 'button'}, 'Save');
		const cancel = h('button', {type: 'button'}, 'Cancel');

		cancel.addEventListener('click', () => {
			editing = false;
			drawFlags();
		});

		save.addEventListener('click', async () => {
			if (!any && !chosen.size) {
				error.textContent = 'Pick at least one language, or Any language.';

				return;
			}

			save.disabled = true;

			try {
				// Every box ticked saves as Any language (js/languages.js), so
				// it counts every copy rather than dropping the languages no box
				// names.
				const saved = await setListLanguages(listId, any ? null : [...chosen]);

				goal = saved;
				editing = false;
				drawFlags();

				if (onSaved) {
					onSaved(saved);
				}
			}
			catch (err) {
				error.textContent = `Not saved. ${errorText(err)}`;
				save.disabled = false;
			}
		});

		element.replaceChildren(h('fieldset', {class: 'pc-language-editor', id: 'list-languages-editor'},
			h('legend', null, 'Languages this list counts'),
			h('p', {class: 'muted'}, 'A card counts as owned only for a copy in one of these, and only their prints are shown. Any language counts every copy.'),
			h('div', {class: 'pc-language-choices'},
				h('label', {class: 'pc-language-choice pc-language-any'}, anyBox, h('span', null, 'Any language')),
				boxes
			),
			error,
			h('div', {class: 'button-row'}, cancel, save)
		));
	}

	return {
		element,
		update(next) {
			goal = next;

			if (!editing) {
				drawFlags();
			}
		},
	};
}

// ------------------------------------------------------------ helpers

// What the status line says while the cards load, or null.
function progressText(step) {
	if (!step) {
		return null;
	}

	if (step.stage === 'list') {
		return 'Downloading the card list (once, about 750 KB).';
	}

	if (step.stage === 'finishes') {
		return `Reading finishes: ${formatCount(step.done)} of ${plural(step.total, 'card', 'cards')}.`;
	}

	return 'Loading the cards...';
}

// The original names of the species under the English one, for a list with
// Japanese, Korean, or Chinese: "プリン (Purin)".
function originalNames(tables, n, languages) {
	if (!tables) {
		return [];
	}

	const out = [];
	const nameIn = (code) => {
		const table = tables[NAME_TABLES[code]];

		return (table && table[n]) || null;
	};
	// A reading in Latin letters after the name, where one is known.
	const readings = {ja: () => tables['ja-roma'] && tables['ja-roma'][n], ko: (name) => romanizeKorean(name)};

	for (const code of ASIAN_LANGUAGES.filter((one) => languages.includes(one))) {
		const name = nameIn(code);

		// Simplified and Traditional that are the same characters (皮卡丘) show once.
		if (!name || out.some((item) => item.name === name)) {
			continue;
		}

		const reading = readings[code] ? readings[code](name) : null;

		out.push({lang: htmlLang(code), name, text: reading ? `${name} (${reading})` : name});
	}

	return out.map(({lang, text}) => ({lang, text}));
}

function sprite(n) {
	const wrap = h('span', {'aria-hidden': 'true', class: 'sprite-wrap pc-sprite'});
	const img = h('img', {alt: '', class: 'sprite', decoding: 'async', height: 56, width: 56});

	img.addEventListener('error', () => wrap.replaceChildren(h('span', {class: 'sprite-fallback'}, String(n))), {once: true});
	img.src = spriteUrl(n);
	wrap.append(img);

	return wrap;
}

const FINISH_WORDS = {first: '1st Edition', masterball: 'Master Ball', normal: 'Normal', pokeball: 'Poké Ball', reverse: 'Reverse'};

// A tile's corner: the flags of the languages its copies are in, and a "?"
// for copies with no language recorded, as the scan tray marks them
// (js/scan/tile.js). Null for a card with no copies.
function ownedBadge(copies) {
	const known = [...new Set(copies.map((entry) => entry.language).filter(Boolean))];
	const unset = copies.some((entry) => !entry.language);

	if (!known.length && !unset) {
		return null;
	}

	const badge = flagBadge(known, {className: 'badge badge-lang', prefix: 'Owned in'});

	if (unset) {
		const names = [...known.map(languageLabel), 'language not set'].join(', ');

		badge.append(h('span', {'aria-hidden': 'true', class: 'flag-text flag-unset', 'data-lang': 'none'}, '?'));
		badge.setAttribute('aria-label', `Owned in ${names}`);
		badge.title = names;
	}

	return badge;
}

// ------------------------------------------------------------ the view

export const pokemonCardsView = (root, {dex, id}) => screen(root, MINE, id, dex);

export const familyPokemonCardsView = (root, {dex, id, userId}) => screen(root, familySource(userId), id, dex);

// The route's language part is "flag", not "lang", which app.js holds to
// the catalog languages: an unknown one opens on Portuguese rather than My
// Cards. With no language part, app.js passes the string "undefined".
export const catalogPokemonCardsView = (root, {dex, flag}) => screen(root, CATALOG, null, dex, flag);

// For app.js ROUTES, after the checklist routes. The one without a list
// shows your own cards, so it does not keep a family member's lens.
export const pokemonCardsRoutes = [
	{keys: ['id', 'dex'], pattern: /^lists\/([^/]+)\/pokemon\/(\d+)$/, render: pokemonCardsView, tab: 'lists', title: 'Pokémon cards | Card Tracker'},
	{keys: ['userId', 'id', 'dex'], pattern: /^family\/([^/]+)\/lists\/([^/]+)\/pokemon\/(\d+)$/, render: familyPokemonCardsView, tab: 'lists', title: 'Family Pokémon cards | Card Tracker'},
	{keys: ['dex', 'flag'], pattern: /^pokemon\/(\d+)(?:\/([a-z]{2}(?:-[a-z]{2})?))?$/, render: catalogPokemonCardsView, tab: 'lists', title: 'Pokémon cards | Card Tracker'},
];

// For app.js ACCOUNT_ROUTES: each depends on who is signed in.
export const pokemonCardsAccountViews = [pokemonCardsView, familyPokemonCardsView, catalogPokemonCardsView];

function screen(root, source, listId, dexParam, langParam = null) {
	const n = dexFromParam(dexParam);
	let alive = true;
	// Without a list, the one language shown, its flag pressed: the route's,
	// else Portuguese.
	let chosen = source.flags ? flagLanguageFrom(langParam) : null;
	let goal = null;
	let entries = [];
	// A family member's card records, whose photos and pin their tiles
	// show; null for the person's own.
	let memberRecords = null;
	let wished = new Set();
	let tables = null;
	let loadRun = 0;
	let filter = readChoice(FILTER_KEY, FILTERS.map((option) => option.value), 'all');
	let everyFinish = readChoice(FINISHES_KEY, ['on', 'off'], 'off') === 'on';
	let finishRun = 0;
	let finishStep = null;
	let loadStep = null;
	let catalogRun = 0;
	let frame = 0;

	// catalog -> {prints, error, missingList, unreadSets}, absent until it
	// first loads; pending: catalog -> the run loading it. A result with
	// missingList or error stays to be shown but loads again (needsLoad).
	const catalogs = new Map();
	const pending = new Map();
	// printKey -> record (or null: not on the phone), for the finishes.
	const records = new Map();
	const adding = new Set();

	// Without a list, Back returns to the card page it was opened from, or
	// opens Lists when the screen was the first one opened.
	const listRoute = source.base ? `${source.base}/${encodeURIComponent(listId)}` : 'lists';
	const back = link(listRoute, {class: 'back', id: 'pc-back'}, source.base ? '‹ List' : '‹ Back');
	const title = h('h2', {id: 'pc-title'});
	const originals = h('div', {class: 'pc-originals', id: 'pc-originals'});
	// A list's languages are saved to the list, whose change loads the
	// screen again. Without a list, the flags choose one language.
	const languages = source.flags ? null : languagesControl({listId, readOnly: source.readOnly});
	const flags = source.flags ? h('div', {'aria-label': 'Languages', class: 'pc-flags', id: 'pc-flags', role: 'group'}) : null;

	if (!source.base) {
		back.addEventListener('click', (event) => {
			if (history.state && history.state.inApp) {
				event.preventDefault();
				event.stopPropagation();
				history.back();
			}
		});
	}
	const status = h('p', {'aria-live': 'polite', class: 'muted', id: 'pc-status'});
	const sections = h('div', {id: 'pc-sections'});

	const filterControl = h('div', {'aria-label': 'Show', class: 'segmented', id: 'pc-filter', role: 'radiogroup'},
		FILTERS.map(({label, value}) => h('label', null,
			h('input', {checked: value === filter, name: 'pc-filter', onchange: () => {
				filter = value;
				saveChoice(FILTER_KEY, value);
				draw();
			}, type: 'radio', value}),
			h('span', {'data-label': label}, label)
		))
	);
	const finishSwitch = h('input', {checked: everyFinish, id: 'pc-finishes', role: 'switch', type: 'checkbox'});
	const finishControl = h('label', {class: 'pc-switch', for: 'pc-finishes'},
		finishSwitch,
		h('span', {class: 'pc-switch-track', 'aria-hidden': 'true'}),
		h('span', null, 'Count every finish')
	);

	finishSwitch.addEventListener('change', () => {
		everyFinish = finishSwitch.checked;
		saveChoice(FINISHES_KEY, everyFinish ? 'on' : 'off');
		draw();

		if (everyFinish) {
			loadFinishes();
		}
	});

	const speciesName = () => (n ? nameOf(tables && tables.en, n) : 'Pokémon');

	if (!n) {
		root.append(back, h('div', {class: 'card empty-state'}, h('p', {class: 'big'}, 'No Pokémon has that number.')));

		return () => {};
	}

	// ------------------------------------------------------- state

	// The languages whose prints are shown: the flag chosen, or the list's.
	const shownLanguages = () => (chosen ? [chosen] : listLanguages(goal));

	// The languages a copy must be in to count, null for any: the flag
	// chosen, with the copies that have no language (flagLanguages), or the
	// list's when it names some.
	const countedLanguages = () => (chosen ? flagLanguages(chosen) : namesLanguages(goal) ? listLanguages(goal) : null);

	// The language a tile opens the card page in: the flag's, where the card
	// routes take it (Portuguese, English, French), so the page's Pokémon
	// link comes back to this flag; else the catalog's own (English for
	// German, Italian, and Spanish, which TCGdex has no catalog in).
	const cardRouteLanguage = (catalog) => (chosen && catalogFor(chosen) === catalog && isCatalogLanguage(chosen) ? chosen : catalogLanguage(catalog));

	function shownPrints() {
		return catalogsFor(shownLanguages()).flatMap((catalog) => (catalogs.get(catalog) || {prints: []}).prints);
	}

	function stateOf(print, owned) {
		const key = printKey(print.catalog, print.cardId);
		const copies = owned.get(key) || [];
		const record = records.has(key) ? records.get(key) : undefined;
		const variants = record && Array.isArray(record.variants_detailed) ? record.variants_detailed : null;

		return {
			copies,
			finishes: record ? cardFinishes(record, variantFinish) : null,
			key,
			owned: ownedFinishes(copies, variants, entryFinish),
			print,
		};
	}

	// ------------------------------------------------------- drawing

	function drawHead(counts) {
		const name = speciesName();
		const noun = everyFinish ? ['finish', 'finishes'] : ['card', 'cards'];

		title.replaceChildren(h('span', {class: 'pc-name'}, name));

		if (counts) {
			title.append(h('span', {class: 'pc-count'}, `, ${formatCount(counts.owned)} of ${plural(counts.total, ...noun)}`));
		}

		document.title = `${name} | Card Tracker`;
		originals.replaceChildren(...originalNames(tables, n, shownLanguages()).map((item) =>
			h('p', {class: 'pc-original', lang: item.lang}, item.text)));
	}

	// A progress step belongs to the catalogs it was started for: another
	// flag's download or finishes are not this one's.
	const stepShown = (step, shown) => Boolean(step) && step.catalogs.length === shown.length && step.catalogs.every((catalog) => shown.includes(catalog));

	function drawStatus(counts) {
		const parts = [];
		const shown = catalogsFor(shownLanguages());
		const finishing = stepShown(finishStep, shown) ? finishStep : null;
		const step = finishing || (loadStep && shown.includes('international') ? loadStep : null);

		if (step) {
			parts.push(progressText(step));
		}

		// Only the catalogs on screen: a flag left keeps its prints, and its
		// troubles are not this language's.
		for (const [catalog, result] of [...catalogs].filter(([catalog]) => shown.includes(catalog))) {
			if (!result) {
				continue;
			}

			if (result.missingList) {
				parts.push(navigator.onLine && result.error
					? `${CATALOG_HEADINGS[catalog]} did not load (${errorText(result.error)}).`
					: `${CATALOG_HEADINGS[catalog]} are not on this phone yet. Open this screen once with a connection.`);
			}
			else if (result.unreadSets) {
				parts.push(`${plural(result.unreadSets, 'set', 'sets')} of ${CATALOG_HEADINGS[catalog].toLowerCase()} could not be read, so their cards show without a set name.`);
			}
		}

		if (everyFinish && counts && counts.unknown && !finishing) {
			parts.push(`${plural(counts.unknown, 'card\'s', 'cards\'')} finishes are not on this phone yet, so ${counts.unknown === 1 ? 'it counts' : 'they count'} once.`);
		}

		status.textContent = parts.filter(Boolean).join(' ');

		// A list that did not load, or is not on the phone yet, can be asked
		// for again; the connection coming back asks by itself (onOnline).
		const failed = shown.some((catalog) => catalogs.has(catalog) && needsLoad(catalogs.get(catalog)));

		if (failed && !shown.some((catalog) => pending.has(catalog))) {
			status.append(' ', h('button', {class: 'small', id: 'pc-retry', onclick: () => load({force: true}), type: 'button'}, 'Try again'));
		}
	}

	// The flag row: one button per language the app knows, in the table's
	// order, the shown one pressed. A flag whose language has loaded shows
	// its prints' count, 0 for none; the others show none. Western languages
	// share the international prints, so they load and count together.
	const flagButtons = new Map();

	function flagButton(code) {
		const src = flagSrc(code);
		const button = h('button', {
			class: 'pc-flag',
			'data-lang': code,
			id: `pc-flag-${code}`,
			onclick: () => choose(code),
			title: languageLabel(code),
			type: 'button',
		},
		src
			? h('img', {alt: '', 'aria-hidden': 'true', class: 'flag', decoding: 'async', height: 16, src, width: 21})
			: h('span', {'aria-hidden': 'true', class: 'flag-text'}, flagText(code)),
		h('span', {'aria-hidden': 'true', class: 'pc-flag-count'}));

		flagButtons.set(code, button);

		return button;
	}

	// Whether the pressed flag is wholly in the row's sight.
	function pressedInSight() {
		const button = flagButtons.get(chosen);

		return button.offsetLeft >= flags.scrollLeft && button.offsetLeft + button.offsetWidth <= flags.scrollLeft + flags.clientWidth;
	}

	// Scrolls the row so the pressed flag sits in its middle, or as near as
	// the row's ends allow (Spanish, at the far end).
	function showPressed() {
		const button = flagButtons.get(chosen);

		flags.scrollLeft = Math.max(0, button.offsetLeft - (flags.clientWidth - button.offsetWidth) / 2);
	}

	function drawFlags() {
		if (!flags) {
			return;
		}

		if (!flagButtons.size) {
			flags.append(...FLAG_LANGUAGES.map(flagButton));
		}

		// Counts arriving widen the flags before the pressed one; one that
		// was in sight stays in sight.
		const inSight = pressedInSight();

		// Loading only while a request is out: a list that is not on the
		// phone, offline, says not loaded, and its flag loads it on a tap.
		for (const [code, button] of flagButtons) {
			const count = flagCount(code, catalogs);
			const loading = count === null && pending.has(catalogFor(code));

			button.setAttribute('aria-pressed', String(code === chosen));
			button.setAttribute('aria-label', `${languageLabel(code)}, ${count !== null ? plural(count, 'card', 'cards') : loading ? 'loading' : 'not loaded'}`);
			button.querySelector('.pc-flag-count').textContent = count !== null ? formatCount(count) : '';
		}

		if (inSight && !pressedInSight()) {
			showPressed();
		}
	}

	// A flag tapped: its language's prints, loaded the first time, and the
	// route says it, so Back to this screen and a reload open on it. The
	// history entry is replaced, not added: Back still leaves the screen.
	// A flag whose list did not load (offline the first time) loads it on a
	// tap, the pressed one included.
	function choose(code) {
		const wanted = catalogsFor([code]);
		const loaded = wanted.every((catalog) => !needsLoad(catalogs.get(catalog)));

		if (code === chosen && loaded) {
			return;
		}

		// Another catalog: the finishes being read for the one left stop, and
		// go on from where they were when it is chosen again.
		if (catalogsFor([chosen]).join() !== wanted.join()) {
			finishRun++;
			finishStep = null;
		}

		chosen = code;
		history.replaceState(history.state, '', BASE + pokemonCardsRoute(n, code));
		draw();

		if (loaded) {
			if (everyFinish) {
				loadFinishes();
			}
		}
		else {
			loadCatalogs();
		}
	}

	function wishButton(print) {
		const key = printKey(print.catalog, print.cardId);
		const on = wished.has(key);

		if (on) {
			return h('span', {class: 'pc-wished', id: `pc-wished-${print.cardId}`}, 'On your wishlist');
		}

		const language = wishLanguage(shownLanguages(), print.catalog);
		const button = h('button', {
			'aria-label': `Add ${print.name || speciesName()} #${print.localId} to your wishlist${language ? ` in ${languageLabel(language)}` : ''}`,
			class: 'small pc-wish',
			disabled: adding.has(key),
			type: 'button',
		}, 'Add to wishlist');

		button.addEventListener('click', async () => {
			adding.add(key);
			button.disabled = true;

			try {
				await addToWishlist(print.cardId, {catalog: print.catalog, language});
				wished.add(key);
				toast(`Added to your wishlist${language ? ` (${languageLabel(language)})` : ''}.`);
			}
			catch (err) {
				toast(`Not added to the wishlist. ${errorText(err)}`);
			}
			finally {
				adding.delete(key);

				if (alive) {
					draw();
				}
			}
		});

		return button;
	}

	function tile(state) {
		const {copies, print} = state;
		const lang = catalogLanguage(print.catalog);
		const route = `cards/${encodeURIComponent(cardRouteLanguage(print.catalog))}/${encodeURIComponent(print.cardId)}`;
		const names = hasOwnNames(lang)
			? cardNames({dexId: [n], lang, name: print.name || ''}, tables)
			: {english: null, original: print.name || speciesName(), reading: null};
		const counts = printCounts(state, everyFinish);
		const owned = counts.owned > 0;
		const wanted = wished.has(state.key);
		const finishText = everyFinish && state.finishes
			? `${formatCount(counts.owned)} of ${plural(counts.total, 'finish', 'finishes')}`
			: null;
		const info = {name: mainName(names) || speciesName(), number: print.localId, setName: print.setName};
		// The card's main image, as My Cards picks it: the copies' photos and
		// pin, or the card's record when none is owned.
		const node = mainArt(copies.length ? copies : {catalog: print.catalog, card_id: print.cardId}, cardImage(print.image, 'low'), (src) => cardTile({
			art: {
				count: copies.length,
				info,
				src,
				status: owned ? 'owned' : wanted ? 'wanted' : null,
			},
			attrs: {id: `pc-tile-${print.catalog}-${print.cardId}`},
			className: owned ? '' : 'unowned',
			meta: [print.localId ? `#${print.localId}` : null, print.setName, finishText].filter(Boolean).join(' · '),
			names: tileNames(names, lang),
			route,
		}), (src) => cardArt(info, src, {decorative: true}), source.readOnly ? {family: false, records: memberRecords || []} : {});

		// The languages the person owns it in, in the corner, never on a
		// missing card (the tile's own flag rule hides the viewing language,
		// which this screen must show).
		const badge = ownedBadge(copies);

		if (badge) {
			node.querySelector('.art-wrap').append(badge);
		}

		if (everyFinish && state.finishes) {
			node.title = state.finishes.map((code) => `${FINISH_WORDS[code] || code}${state.owned.has(code) ? ' (owned)' : ''}`).join(', ');
		}

		const cell = h('div', {
			class: owned ? 'pc-cell pc-owned' : 'pc-cell pc-missing',
			'data-card': print.cardId,
			'data-catalog': print.catalog,
		}, node);

		// Read only, a missing card stays dimmed with nothing to tap but
		// the card.
		if (!owned && !source.readOnly) {
			cell.append(wishButton(print));
		}

		return {cell, route};
	}

	// One draw per animation frame for what streams in (finish records,
	// download progress): a Pokémon with hundreds of prints would otherwise
	// rebuild the whole grid once per record. A tap still draws at once.
	function drawSoon() {
		if (!frame) {
			frame = requestAnimationFrame(() => {
				frame = 0;

				if (alive) {
					draw();
				}
			});
		}
	}

	function draw() {
		if (frame) {
			cancelAnimationFrame(frame);
			frame = 0;
		}

		// The flags first: one tapped before the person's cards are read shows
		// pressed at once.
		drawFlags();

		if (!goal) {
			return;
		}

		const owned = copiesByPrintOnce(entries, countedLanguages());
		const shown = catalogsFor(shownLanguages());
		const allStates = [];
		const routes = [];
		const blocks = [];

		for (const catalog of shown) {
			const result = catalogs.get(catalog);
			const heading = shown.length > 1 || catalog !== 'international' ? h('h3', {class: 'pc-heading'}, CATALOG_HEADINGS[catalog]) : null;

			if (!result) {
				blocks.push(h('section', {class: 'pc-section', 'data-catalog': catalog}, heading, h('p', {class: 'muted'}, 'Loading...')));
				continue;
			}

			const states = newestFirst(result.prints).map((print) => stateOf(print, owned));

			allStates.push(...states);

			const visible = states.filter((state) => passesFilter(state, filter, everyFinish));
			const cells = visible.map(tile);

			routes.push(...cells.map((item) => item.route));

			let body;

			if (!result.prints.length) {
				body = h('p', {class: 'muted pc-none'}, result.missingList
					? 'Not on this phone yet.'
					: `The ${languageLabel(chosen && catalogFor(chosen) === catalog ? chosen : catalogLanguage(catalog))} catalog has no cards of ${speciesName()} yet.`);
			}
			else if (!cells.length) {
				body = h('p', {class: 'muted pc-none'}, filter === 'missing' ? 'Nothing missing here.' : 'None owned here yet.');
			}
			else {
				body = h('div', {class: 'card-grid pc-grid', id: `pc-grid-${catalog}`}, cells.map((item) => item.cell));
			}

			blocks.push(h('section', {class: 'pc-section', 'data-catalog': catalog}, heading, body));
		}

		// A list not on the phone has no count to give: "0 of 0 cards" would
		// say the Pokémon has none.
		const loaded = shown.every((catalog) => catalogs.get(catalog) && !catalogs.get(catalog).missingList);
		const counts = loaded ? tally(allStates, everyFinish) : null;

		drawHead(counts);
		drawStatus(counts);
		segmentCounts(filterControl, loaded ? Object.fromEntries(FILTERS.map(({value}) => [value, allStates.filter((state) => passesFilter(state, value, everyFinish)).length])) : null);
		sections.replaceChildren(...blocks);

		// The grid on screen, in this order and with this filter, is the
		// card page's swipe context.
		offerCardList(routes, speciesName());
	}

	// ------------------------------------------------------- loading

	async function loadFinishes() {
		const run = ++finishRun;
		const stepCatalogs = catalogsFor(shownLanguages());

		// Records read earlier in this session, on this screen or another,
		// come in at once, with one draw for all of them.
		for (const print of shownPrints()) {
			const key = printKey(print.catalog, print.cardId);
			const known = records.has(key) ? undefined : knownRecord(print);

			if (known) {
				records.set(key, known);
			}
		}

		const todo = shownPrints().filter((print) => !records.has(printKey(print.catalog, print.cardId)));

		if (!todo.length) {
			finishStep = null;
			draw();

			return;
		}

		let done = 0;
		let next = 0;

		finishStep = {catalogs: stepCatalogs, done, stage: 'finishes', total: todo.length};
		draw();

		await Promise.all(Array.from({length: Math.min(CONCURRENCY, todo.length)}, async () => {
			while (next < todo.length && alive && run === finishRun && everyFinish) {
				const print = todo[next++];

				records.set(printKey(print.catalog, print.cardId), await printRecord(print));
				done++;

				if (alive && run === finishRun) {
					finishStep = {catalogs: stepCatalogs, done, stage: 'finishes', total: todo.length};
					drawSoon();
				}
			}
		}));

		if (alive && run === finishRun) {
			finishStep = null;
			draw();
		}
	}

	// Loads each catalog the languages shown need that is not loaded or
	// loading yet, or whose list did not load (needsLoad); force loads them
	// again (Try again). A list drops the catalogs its languages no longer
	// need; the flags keep every catalog loaded, so going back to a flag
	// needs no request and it keeps its count.
	async function loadCatalogs({force = false} = {}) {
		const wanted = catalogsFor(shownLanguages());

		for (const catalog of [...catalogs.keys()]) {
			if ((force && wanted.includes(catalog)) || (!chosen && !wanted.includes(catalog))) {
				catalogs.delete(catalog);
			}
		}

		const start = wanted.filter((catalog) => force || (needsLoad(catalogs.get(catalog)) && !pending.has(catalog)));

		if (!start.length) {
			return;
		}

		// Pending before the draw, so the flags say loading.
		for (const catalog of start) {
			pending.set(catalog, ++catalogRun);
		}

		draw();

		await Promise.all(start.map(async (catalog) => {
			const run = pending.get(catalog);
			const result = catalog === 'international'
				? await loadInternational(n, {
					force,
					onProgress: (step) => {
						if (alive && pending.get(catalog) === run) {
							loadStep = {...step, catalogs: ['international']};
							drawSoon();
						}
					},
				})
				: await loadAsian(catalog, n, {force});

			if (!alive || pending.get(catalog) !== run) {
				return;
			}

			pending.delete(catalog);

			if (catalog === 'international') {
				loadStep = null;
			}

			catalogs.set(catalog, result);
			draw();
		}));

		if (alive && everyFinish) {
			loadFinishes();
		}
	}

	// An error or "not here" shows in its own slot, with the screen hidden
	// behind it, so a later load that finds the list shows it again (E-01).
	const notice = h('div', {id: 'pc-notice'});
	const content = h('div', {id: 'pc-content'});

	function showNotice(node) {
		content.hidden = Boolean(node);
		notice.replaceChildren(...[node].filter(Boolean));
	}

	async function load({force = false} = {}) {
		const run = ++loadRun;
		let data;

		try {
			data = await source.load(listId);
		}
		catch (err) {
			if (alive && run === loadRun) {
				showNotice(h('div', {class: 'notice', role: 'alert'}, h('p', null, source.readOnly
					? err.message || errorText(err)
					: `${source.base ? 'This list' : 'Your cards'} could not be read from this phone. ${errorText(err)}`)));
			}

			return;
		}

		if (!alive || run !== loadRun) {
			return;
		}

		if (!data.goal) {
			showNotice(h('div', {class: 'card empty-state'},
				h('p', {class: 'big'}, 'This list is not here.'),
				h('p', {class: 'muted'}, 'It may have been deleted on another phone.')
			));

			return;
		}

		showNotice(null);
		goal = data.goal;
		entries = data.entries;
		memberRecords = data.records || null;
		wished = new Set((data.wishlist || []).filter(isLive).map((item) => printKey(item.catalog || 'international', item.card_id)));

		if (source.base) {
			back.textContent = `‹ ${goal.name}`;
		}

		if (languages) {
			languages.update(goal);
		}

		draw();
		await loadCatalogs({force});
	}

	speciesNames().then((all) => {
		tables = all;

		if (alive) {
			draw();
		}
	}).catch(() => {});

	const stop = source.watch ? source.watch(() => alive && load()) : () => {};

	// The connection back: the catalogs on screen that did not load (a flag
	// tapped offline) load now, without leaving the screen.
	const onOnline = () => {
		if (alive && goal) {
			loadCatalogs();
		}
	};

	window.addEventListener('online', onOnline);
	// A twin found, or the twins on the phone read after the first draw; a
	// new photo or pin is a save, which loads the screen again.
	const stopImages = onImagesChange(() => alive && drawSoon(), {records: false});

	content.append(
		h('div', {class: 'pc-head'}, sprite(n), h('div', {class: 'pc-head-text'}, title, originals)),
		flags || languages.element,
		h('div', {class: 'pc-controls'}, filterControl, finishControl),
		status,
		sections
	);
	root.append(back, notice, content);
	drawHead(null);

	if (flags) {
		// A visit with no language, or one the app does not know, says the
		// one it opened on.
		if (langParam !== chosen) {
			history.replaceState(history.state, '', BASE + pokemonCardsRoute(n, chosen));
		}

		drawFlags();

		// A flag far along the row (Spanish) is scrolled into sight.
		if (!pressedInSight()) {
			showPressed();
		}
	}

	load();

	return () => {
		alive = false;
		finishRun++;

		if (frame) {
			cancelAnimationFrame(frame);
			frame = 0;
		}

		stop();
		stopImages();
		window.removeEventListener('online', onOnline);
	};
}
