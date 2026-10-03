// Every card of a Pokémon (DESIGN.md section 11), opened from a checklist
// row:
//   lists/<listId>/pokemon/<dex>                  the person's own list
//   family/<userId>/lists/<listId>/pokemon/<dex>  a family member's, view only
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
// control); the checklist screen shows it too.

import {currentUser} from './auth.js';
import {offerCardList} from './card-swipe.js';
import {LANGUAGES, cardImage, catalogLanguage, languageLabel} from './catalog.js';
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
import {flagBadge} from './flags.js';
import {cardNames, hasOwnNames, romanizeKorean} from './names.js';
import {
	CATALOG_HEADINGS,
	catalogsFor,
	cardFinishes,
	copiesByPrintOnce,
	dexFromParam,
	knownRecord,
	loadAsian,
	loadInternational,
	newestFirst,
	ownedFinishes,
	passesFilter,
	printCounts,
	printKey,
	printRecord,
	tally,
	wishLanguage,
} from './pokemon-cards.js';
import {toast} from './shell.js';
import {memberDocument} from './sync.js';
import {cardTile, entryFinish, variantFinish} from './tile.js';
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

// The languages a list can hold, Portuguese first, then the order of the
// catalog's language list.
const LANGUAGE_CHOICES = ['pt', ...LANGUAGES.map((lang) => lang.code).filter((code) => code !== 'pt')];

const formatCount = (n) => Number(n).toLocaleString('en-US');

const plural = (n, one, many) => `${formatCount(n)} ${n === 1 ? one : many}`;

const link = (route, attrs, ...children) => h('a', {...attrs, 'data-link': route, href: BASE + route}, ...children);

export const pokemonRoute = (base, listId, n) => `${base}/${encodeURIComponent(listId)}/pokemon/${n}`;

function readChoice(key, allowed, fallback) {
	try {
		const saved = localStorage.getItem(key);

		return allowed.includes(saved) ? saved : fallback;
	}
	catch {
		return fallback;
	}
}

function saveChoice(key, value) {
	try {
		localStorage.setItem(key, value);
	}
	catch {
		// The choice lasts for this visit only.
	}
}

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

			return {entries: (doc.cards || []).filter(isLive), goal, wishlist: []};
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
				// Every box ticked reads as Any language, so it counts every
				// copy rather than dropping the languages no box names.
				const every = LANGUAGE_CHOICES.every((code) => chosen.has(code));
				const saved = await setListLanguages(listId, any || every ? null : LANGUAGE_CHOICES.filter((code) => chosen.has(code)));

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

	if (languages.includes('ja') && tables.ja && tables.ja[n]) {
		const reading = tables['ja-roma'] && tables['ja-roma'][n];

		out.push({lang: 'ja', text: reading ? `${tables.ja[n]} (${reading})` : tables.ja[n]});
	}

	if (languages.includes('ko') && tables.ko && tables.ko[n]) {
		const reading = romanizeKorean(tables.ko[n]);

		out.push({lang: 'ko', text: reading ? `${tables.ko[n]} (${reading})` : tables.ko[n]});
	}

	if (languages.includes('zh-cn') && tables['zh-hans'] && tables['zh-hans'][n]) {
		out.push({lang: 'zh-Hans', text: tables['zh-hans'][n]});
	}

	// Simplified and Traditional that are the same characters (皮卡丘) show once.
	if (languages.includes('zh-tw') && tables['zh-hant'] && tables['zh-hant'][n] && !(languages.includes('zh-cn') && tables['zh-hans'] && tables['zh-hans'][n] === tables['zh-hant'][n])) {
		out.push({lang: 'zh-Hant', text: tables['zh-hant'][n]});
	}

	return out;
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

// ------------------------------------------------------------ the view

export const pokemonCardsView = (root, {dex, id}) => screen(root, MINE, id, dex);

export const familyPokemonCardsView = (root, {dex, id, userId}) => screen(root, familySource(userId), id, dex);

// For app.js ROUTES, after the checklist routes.
export const pokemonCardsRoutes = [
	{keys: ['id', 'dex'], pattern: /^lists\/([^/]+)\/pokemon\/(\d+)$/, render: pokemonCardsView, tab: 'lists', title: 'Pokémon cards | Card Tracker'},
	{keys: ['userId', 'id', 'dex'], pattern: /^family\/([^/]+)\/lists\/([^/]+)\/pokemon\/(\d+)$/, render: familyPokemonCardsView, tab: 'lists', title: 'Family Pokémon cards | Card Tracker'},
];

// For app.js ACCOUNT_ROUTES: both depend on who is signed in.
export const pokemonCardsAccountViews = [pokemonCardsView, familyPokemonCardsView];

function screen(root, source, listId, dexParam) {
	const n = dexFromParam(dexParam);
	let alive = true;
	let goal = null;
	let entries = [];
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

	// catalog -> {prints, error, missingList, unreadSets}, absent while it
	// loads; pending: catalog -> the run loading it.
	const catalogs = new Map();
	const pending = new Map();
	// printKey -> record (or null: not on the phone), for the finishes.
	const records = new Map();
	const adding = new Set();

	const listRoute = `${source.base}/${encodeURIComponent(listId)}`;
	const back = link(listRoute, {class: 'back', id: 'pc-back'}, '‹ List');
	const title = h('h2', {id: 'pc-title'});
	const originals = h('div', {class: 'pc-originals', id: 'pc-originals'});
	const languages = languagesControl({listId, readOnly: source.readOnly});
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

	function shownPrints() {
		return catalogsFor(listLanguages(goal)).flatMap((catalog) => (catalogs.get(catalog) || {prints: []}).prints);
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
		originals.replaceChildren(...originalNames(tables, n, listLanguages(goal)).map((item) =>
			h('p', {class: 'pc-original', lang: item.lang}, item.text)));
	}

	function drawStatus(counts) {
		const parts = [];
		const step = finishStep || loadStep;

		if (step) {
			parts.push(progressText(step));
		}

		for (const [catalog, result] of catalogs) {
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

		if (everyFinish && counts && counts.unknown && !finishStep) {
			parts.push(`${plural(counts.unknown, 'card\'s', 'cards\'')} finishes are not on this phone yet, so ${counts.unknown === 1 ? 'it counts' : 'they count'} once.`);
		}

		status.textContent = parts.filter(Boolean).join(' ');

		const failed = [...catalogs.values()].some((result) => result && result.error);

		if (failed && navigator.onLine && !pending.size) {
			status.append(' ', h('button', {class: 'small', id: 'pc-retry', onclick: () => load({force: true}), type: 'button'}, 'Try again'));
		}
	}

	function wishButton(print) {
		const key = printKey(print.catalog, print.cardId);
		const on = wished.has(key);

		if (on) {
			return h('span', {class: 'pc-wished', id: `pc-wished-${print.cardId}`}, 'On your wishlist');
		}

		const language = wishLanguage(listLanguages(goal), print.catalog);
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
		const route = `cards/${encodeURIComponent(lang)}/${encodeURIComponent(print.cardId)}`;
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
		const node = cardTile({
			art: {
				count: copies.length,
				info,
				src: cardImage(print.image, 'low'),
				status: owned ? 'owned' : wanted ? 'wanted' : null,
			},
			attrs: {id: `pc-tile-${print.catalog}-${print.cardId}`},
			className: owned ? '' : 'unowned',
			meta: [print.localId ? `#${print.localId}` : null, print.setName, finishText].filter(Boolean).join(' · '),
			names: tileNames(names, lang),
			route,
		});

		// The languages the person owns it in, in the corner, never on a
		// missing card (the tile's own flag rule hides the viewing language,
		// which this screen must show).
		const ownedIn = [...new Set(copies.map((entry) => entry.language).filter(Boolean))];

		if (ownedIn.length) {
			node.querySelector('.art-wrap').append(flagBadge(ownedIn, {className: 'badge badge-lang', prefix: 'Owned in'}));
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

		if (!goal) {
			return;
		}

		const owned = copiesByPrintOnce(entries, namesLanguages(goal) ? listLanguages(goal) : null);
		const shown = catalogsFor(listLanguages(goal));
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
					: `The ${languageLabel(catalogLanguage(catalog))} catalog has no cards of ${speciesName()} yet.`);
			}
			else if (!cells.length) {
				body = h('p', {class: 'muted pc-none'}, filter === 'missing' ? 'Nothing missing here.' : 'None owned here yet.');
			}
			else {
				body = h('div', {class: 'card-grid pc-grid', id: `pc-grid-${catalog}`}, cells.map((item) => item.cell));
			}

			blocks.push(h('section', {class: 'pc-section', 'data-catalog': catalog}, heading, body));
		}

		const loaded = shown.every((catalog) => catalogs.get(catalog));
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

		finishStep = {done, stage: 'finishes', total: todo.length};
		draw();

		await Promise.all(Array.from({length: Math.min(CONCURRENCY, todo.length)}, async () => {
			while (next < todo.length && alive && run === finishRun && everyFinish) {
				const print = todo[next++];

				records.set(printKey(print.catalog, print.cardId), await printRecord(print));
				done++;

				if (alive && run === finishRun) {
					finishStep = {done, stage: 'finishes', total: todo.length};
					drawSoon();
				}
			}
		}));

		if (alive && run === finishRun) {
			finishStep = null;
			draw();
		}
	}

	// Loads each catalog the list's languages need and is not loaded or
	// loading yet; force loads them all again (Try again).
	async function loadCatalogs({force = false} = {}) {
		const wanted = catalogsFor(listLanguages(goal));

		for (const catalog of [...catalogs.keys()]) {
			if (force || !wanted.includes(catalog)) {
				catalogs.delete(catalog);
			}
		}

		const start = wanted.filter((catalog) => force || (!catalogs.has(catalog) && !pending.has(catalog)));

		if (!start.length) {
			return;
		}

		draw();

		await Promise.all(start.map(async (catalog) => {
			const run = ++catalogRun;

			pending.set(catalog, run);

			const result = catalog === 'international'
				? await loadInternational(n, {
					force,
					onProgress: (step) => {
						if (alive && pending.get(catalog) === run) {
							loadStep = step;
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
					: `This list could not be read from this phone. ${errorText(err)}`)));
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
		wished = new Set((data.wishlist || []).filter(isLive).map((item) => printKey(item.catalog || 'international', item.card_id)));
		back.textContent = `‹ ${goal.name}`;
		languages.update(goal);
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

	content.append(
		h('div', {class: 'pc-head'}, sprite(n), h('div', {class: 'pc-head-text'}, title, originals)),
		languages.element,
		h('div', {class: 'pc-controls'}, filterControl, finishControl),
		status,
		sections
	);
	root.append(back, notice, content);
	drawHead(null);
	load();

	return () => {
		alive = false;
		finishRun++;

		if (frame) {
			cancelAnimationFrame(frame);
			frame = 0;
		}

		stop();
	};
}
