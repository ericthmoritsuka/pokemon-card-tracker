// One search, filter, and sort bar for card lists (DESIGN.md section 11,
// "Filters and Sorting"). My Cards uses it first; the binder card picker,
// the scan tray, and the wishlist can take it as they are. Nothing here
// knows about a screen: the screen hands over its items and redraws when
// the bar says the choice changed.
//
// An item is one tile, with these fields (any may be missing; an item with
// no data for a filter simply does not match it):
//
//   key          unique within the list
//   name         the name shown, for sorting
//   search       searchKey()ed terms joined by "\n" (searchTextOf builds it)
//   dexIds       National Dex numbers ([] for Trainers and Energy); the dex
//                filter and "#25" or "#1-151" in the search read them
//   types        TCGdex energy types, in English: ["Fire"]
//   category     "Pokemon", "Trainer", or "Energy", as TCGdex writes them
//   setKey       "<catalog>|<set id>", since Asian catalogs reuse set IDs
//   setName      for the set filter's options
//   releaseDate  the set's, "YYYY-MM-DD"
//   number       the collector number
//   language     the copies' language code
//   rarity       TCGdex's English rarity
//   unplaced     true when a copy is in no binder yet
//   favorite     true when a copy is a favorite
//   priced       false when a copy has no price
//   price        the tile's value in reais, or null
//   newest, oldest  ISO times the copies were added
//
// The choice (search text aside) is remembered per screen in localStorage,
// so My Cards opens as it was left. On a phone the filters open in a bottom
// sheet, and the Filters button counts the active ones.

import {h} from './dom.js';
import {REGIONS} from './checklists.js';
import {languageLabel} from './catalog.js';
import {searchKey} from './names.js';
import {ENERGIES} from './themes.js';

// ------------------------------------------------------------- choices

// Hisui is Legends: Arceus, a generation 8 game.
const GENERATIONS = {alola: 7, galar: 8, hisui: 8, hoenn: 3, johto: 2, kalos: 6, kanto: 1, paldea: 9, sinnoh: 4, unova: 5};

export const REGION_OPTIONS = REGIONS.map((region) => ({...region, generation: GENERATIONS[region.id], label: `${region.name} (Gen ${GENERATIONS[region.id]})`}));

export const CATEGORIES = [
	{label: 'Pokémon', value: 'Pokemon'},
	{label: 'Trainer', value: 'Trainer'},
	{label: 'Energy', value: 'Energy'},
];

export const PRICE_STATES = [
	{label: 'Priced', value: 'priced'},
	{label: 'No price', value: 'unpriced'},
];

// Short labels, so the sort fits beside the buttons at 360 px untruncated.
export const SORTS = [
	{label: 'Newest', long: 'Newest added first', value: 'newest'},
	{label: 'Oldest', long: 'Oldest added first', value: 'oldest'},
	{label: 'Name', long: 'Name, A to Z', value: 'name'},
	{label: 'Pokédex', long: 'Pokédex number', value: 'dex'},
	{label: 'Set', long: 'Set and number, newest set first', value: 'set'},
	{label: 'Price', long: 'Price, highest first', value: 'price'},
];

// Every filter the bar knows, in the order the sheet shows them. dex is a
// Pokédex number range, kept as "<from>-<to>" ("25-25" for one number).
export const FILTERS = ['region', 'dex', 'type', 'category', 'set', 'language', 'rarity', 'price', 'unplaced', 'favorite'];

// The filters that are a checkbox, not a choice.
export const BOOLEAN_FILTERS = ['unplaced', 'favorite'];

export const emptyFilters = () => ({category: '', dex: '', favorite: false, language: '', price: '', rarity: '', region: '', set: '', type: '', unplaced: false});

export const MAX_DEX = REGIONS[REGIONS.length - 1].last;

const dexNumber = (value) => {
	const n = Number.parseInt(String(value ?? '').replace(/^#/, ''), 10);

	return Number.isInteger(n) && n >= 1 && n <= MAX_DEX ? n : null;
};

// A Pokédex range from two typed numbers: either alone means that one
// number ("25" to nothing is 25 to 25), and a reversed pair is turned round.
// "" when neither is a Dex number.
export function dexRangeValue(from, to) {
	const a = dexNumber(from);
	const b = dexNumber(to);

	if (a === null && b === null) {
		return '';
	}

	const low = Math.min(a ?? b, b ?? a);
	const high = Math.max(a ?? b, b ?? a);

	return `${low}-${high}`;
}

// {from, to} from a dex filter value, or null.
export function dexRange(value) {
	const match = /^(\d+)-(\d+)$/.exec(String(value || ''));

	if (!match) {
		return null;
	}

	const from = dexNumber(match[1]);
	const to = dexNumber(match[2]);

	return from !== null && to !== null && from <= to ? {from, to} : null;
}

export const dexLabel = ({from, to}) => (from === to ? `Pokédex #${from}` : `Pokédex #${from} to #${to}`);

// A card with several Dex numbers (a TAG TEAM) fits when any of them does;
// one with none (a Trainer, an Energy, or details not read yet) never does.
export const inDexRange = (item, {from, to}) => (item.dexIds || []).some((n) => n >= from && n <= to);

export const regionOf = (n) => REGION_OPTIONS.find((region) => n >= region.first && n <= region.last) || null;

export const regionsOf = (dexIds) => [...new Set((dexIds || []).map((n) => regionOf(n)).filter(Boolean).map((region) => region.id))];

// ------------------------------------------------------------ searching

// Every text a tile can be found by, folded once when the list is built so
// a keystroke over 1,600 tiles is a few string searches each.
export const searchTextOf = (texts) => [...new Set(texts.filter(Boolean).map(searchKey))].filter(Boolean).join('\n');

// A query in parts: {words, dex}. "#25", "#025", and "#1-151" are Pokédex
// numbers and ranges (dex, as {from, to}); every other word is folded the
// same way as the terms, and "25", "025", and "25/165" look for the
// collector number. "#TG10" is a number too, with the "#" dropped.
export function parseQuery(text) {
	const words = [];
	const dex = [];

	for (const raw of String(text || '').split(/\s+/)) {
		const range = /^#(\d{1,4})(?:-#?(\d{1,4}))?$/.exec(raw);

		if (range) {
			const value = dexRange(dexRangeValue(range[1], range[2] ?? range[1]));

			// "#0" or "#2000" can be no Pokémon, so nothing matches it.
			dex.push(value || {from: 0, to: -1});
			continue;
		}

		const word = searchKey(raw.replace(/^#/, '').replace(/\/.*$/, ''));

		if (word) {
			words.push(word);
		}
	}

	return {dex, words};
}

export const queryWords = (text) => parseQuery(text).words;

export const matchesWords = (item, words) => words.every((word) => (item.search || '').includes(word));

export const matchesQuery = (item, {dex, words}) => matchesWords(item, words) && dex.every((range) => inDexRange(item, range));

// --------------------------------------------------------- filter, sort

const matchers = {
	category: (item, value) => item.category === value,
	favorite: (item, value) => !value || item.favorite === true,
	dex: (item, value) => {
		const range = dexRange(value);

		return Boolean(range) && inDexRange(item, range);
	},
	language: (item, value) => item.language === value,
	price: (item, value) => (value === 'unpriced' ? item.priced === false : item.priced === true),
	rarity: (item, value) => item.rarity === value,
	region: (item, value) => regionsOf(item.dexIds).includes(value),
	set: (item, value) => item.setKey === value,
	type: (item, value) => (item.types || []).includes(value),
	unplaced: (item, value) => !value || item.unplaced === true,
};

export function applyFilters(items, {filters = emptyFilters(), query = ''} = {}) {
	const parsed = parseQuery(query);
	const searching = parsed.words.length || parsed.dex.length;
	const active = FILTERS.filter((kind) => filters[kind]);

	return items.filter((item) => active.every((kind) => matchers[kind](item, filters[kind])) && (!searching || matchesQuery(item, parsed)));
}

const collator = new Intl.Collator('en', {numeric: true, sensitivity: 'base'});
const text = (value) => String(value ?? '');
const firstDex = (item) => (item.dexIds && item.dexIds.length ? Math.min(...item.dexIds) : Infinity);

const byName = (a, b) => collator.compare(text(a.name), text(b.name)) || text(a.language).localeCompare(text(b.language));

const bySet = (a, b) => text(b.releaseDate).localeCompare(text(a.releaseDate))
	|| text(a.setKey).localeCompare(text(b.setKey))
	|| collator.compare(text(a.number), text(b.number));

const SORTERS = {
	dex: (a, b) => firstDex(a) - firstDex(b) || byName(a, b),
	name: byName,
	newest: (a, b) => text(b.newest).localeCompare(text(a.newest)),
	oldest: (a, b) => text(a.oldest).localeCompare(text(b.oldest)),
	// Unknown prices last, never counted as zero.
	price: (a, b) => (b.price ?? -1) - (a.price ?? -1) || byName(a, b),
	set: bySet,
};

export const sortItems = (items, sort) => [...items].sort(SORTERS[sort] || SORTERS.newest);

// The options each filter offers for these items, with how many tiles each
// holds: {region: [{value, label, count}], ...}. Only what the list holds is
// offered.
export function filterOptions(items) {
	const count = (map, value, label, extra = {}) => {
		if (value === null || value === undefined || value === '') {
			return;
		}

		const old = map.get(value);

		map.set(value, {count: (old ? old.count : 0) + 1, label, value, ...extra});
	};
	const maps = {category: new Map(), language: new Map(), rarity: new Map(), region: new Map(), set: new Map(), type: new Map()};
	let unplaced = 0;
	let favorite = 0;
	let unpriced = 0;
	let priced = 0;

	for (const item of items) {
		for (const id of regionsOf(item.dexIds)) {
			count(maps.region, id, id);
		}

		for (const type of item.types || []) {
			count(maps.type, type, type);
		}

		count(maps.category, item.category, item.category);
		count(maps.set, item.setKey, item.setName || item.setKey, {releaseDate: item.releaseDate || ''});
		count(maps.language, item.language, languageLabel(item.language));
		count(maps.rarity, item.rarity, item.rarity);
		unplaced += item.unplaced === true ? 1 : 0;
		favorite += item.favorite === true ? 1 : 0;
		unpriced += item.priced === false ? 1 : 0;
		priced += item.priced === true ? 1 : 0;
	}

	const inOrder = (map, order) => order.filter((option) => map.has(option.value)).map((option) => ({...map.get(option.value), label: option.label}));

	return {
		category: inOrder(maps.category, CATEGORIES),
		language: [...maps.language.values()].sort((a, b) => b.count - a.count),
		price: [{count: priced, label: 'Priced', value: 'priced'}, {count: unpriced, label: 'No price', value: 'unpriced'}].filter((option) => option.count),
		rarity: [...maps.rarity.values()].sort((a, b) => collator.compare(a.label, b.label)),
		region: inOrder(maps.region, REGION_OPTIONS.map((region) => ({label: region.label, value: region.id}))),
		set: [...maps.set.values()].sort((a, b) => b.releaseDate.localeCompare(a.releaseDate) || collator.compare(a.label, b.label)),
		type: inOrder(maps.type, ENERGIES.map((energy) => ({label: energy.name, value: energy.name}))),
		favorite,
		unplaced,
	};
}

export const activeFilters = (filters) => FILTERS.filter((kind) => filters && filters[kind]);

// ---------------------------------------------------------- remembering

function readChoice(storageKey, legacy) {
	let saved = null;

	try {
		saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
	}
	catch {
		saved = null;
	}

	if (!saved || typeof saved !== 'object') {
		saved = legacy ? legacy() : null;
	}

	const filters = emptyFilters();

	for (const kind of FILTERS) {
		const value = saved && saved.filters ? saved.filters[kind] : undefined;

		if (BOOLEAN_FILTERS.includes(kind)) {
			filters[kind] = value === true;
		}
		else if (typeof value === 'string') {
			filters[kind] = value;
		}
	}

	const sort = saved && SORTS.some((option) => option.value === saved.sort) ? saved.sort : null;

	return {filters, sort};
}

function writeChoice(storageKey, state) {
	try {
		localStorage.setItem(storageKey, JSON.stringify({filters: state.filters, sort: state.sort}));
	}
	catch {
		// The choice lasts for this visit only.
	}
}

// ------------------------------------------------------------------ bar

const SEARCH_DELAY_MS = 120;

let barCount = 0;

// The bar. Options:
//   id          prefix for the controls' ids ("cards" gives #cards-search)
//   storageKey  where the choice is remembered
//   filters     which of FILTERS to offer (default all)
//   sorts       which SORTS values to offer (default all)
//   sort        the default sort
//   legacy      () => {filters, sort} read when nothing is saved yet
//   query       the search text to start with (Back from a card page)
//   extra       nodes placed after the Filters button (My Cards' Value)
//   placeholder the search field's hint
//   onChange(state, reason)  reason is 'query', 'filter', or 'sort'
// Returns {element, state, setItems(items), setFilter(kind, value),
// clearFilters(), openSheet(), destroy()}.
export function filterBar({
	extra = [],
	filters: offered = FILTERS,
	id = `fb${++barCount}`,
	legacy = null,
	onChange = () => {},
	placeholder = 'Search my cards',
	query = '',
	sort: defaultSort = 'newest',
	sorts: sortValues = SORTS.map((option) => option.value),
	storageKey,
}) {
	const saved = readChoice(storageKey, legacy);
	const state = {
		filters: saved.filters,
		query: String(query || ''),
		sort: saved.sort && sortValues.includes(saved.sort) ? saved.sort : defaultSort,
	};
	let items = [];
	let searchTimer = null;

	for (const kind of FILTERS) {
		if (!offered.includes(kind)) {
			state.filters[kind] = BOOLEAN_FILTERS.includes(kind) ? false : '';
		}
	}

	const changed = (reason) => {
		if (reason !== 'query') {
			writeChoice(storageKey, state);
		}

		drawChips();
		onChange(state, reason);
	};

	const search = h('input', {
		'aria-label': placeholder,
		autocomplete: 'off',
		class: 'search fb-search',
		enterkeyhint: 'search',
		id: `${id}-search`,
		placeholder,
		type: 'search',
		value: state.query,
	});

	search.addEventListener('input', () => {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			state.query = search.value;
			changed('query');
		}, SEARCH_DELAY_MS);
	});
	search.addEventListener('keydown', (event) => {
		if (event.key === 'Enter') {
			search.blur();
		}
	});

	const sortSelect = h('select', {'aria-label': 'Sort cards', class: 'fb-sort', id: `${id}-sort`, onchange: () => {
		state.sort = sortSelect.value;
		changed('sort');
	}}, SORTS.filter((option) => sortValues.includes(option.value)).map((option) => h('option', {title: option.long, value: option.value}, option.label)));

	sortSelect.value = state.sort;

	const countBadge = h('span', {'aria-hidden': 'true', class: 'fb-count', hidden: true});
	const filterButton = h('button', {'aria-haspopup': 'dialog', class: 'small fb-open', id: `${id}-filters`, onclick: () => openSheet(), type: 'button'}, 'Filters', countBadge);
	const chips = h('div', {'aria-label': 'Active filters', class: 'fb-chips', hidden: true, role: 'group'});
	const element = h('div', {class: 'fb'},
		search,
		h('div', {class: 'fb-row'},
			h('span', {class: 'select-wrap fb-sort-wrap'}, sortSelect),
			filterButton,
			...extra
		),
		chips
	);

	// --------------------------------------------------- the active chips

	const labelOf = (kind, value) => {
		if (kind === 'favorite') {
			return 'Favorites';
		}

		if (kind === 'unplaced') {
			return 'Not in a binder';
		}

		if (kind === 'region') {
			const region = REGION_OPTIONS.find((option) => option.id === value);

			return region ? region.label : value;
		}

		if (kind === 'dex') {
			const range = dexRange(value);

			return range ? dexLabel(range) : value;
		}

		if (kind === 'category') {
			return (CATEGORIES.find((option) => option.value === value) || {label: value}).label;
		}

		if (kind === 'price') {
			return (PRICE_STATES.find((option) => option.value === value) || {label: value}).label;
		}

		if (kind === 'language') {
			return languageLabel(value);
		}

		if (kind === 'set') {
			const item = items.find((one) => one.setKey === value);

			return (item && item.setName) || value.slice(value.indexOf('|') + 1);
		}

		return value;
	};

	function drawChips() {
		const active = activeFilters(state.filters);

		countBadge.hidden = !active.length;
		countBadge.textContent = String(active.length);
		filterButton.setAttribute('aria-label', active.length ? `Filters, ${active.length} active` : 'Filters');
		chips.hidden = !active.length;
		chips.replaceChildren(...[
			...active.map((kind) => h('button', {
				'aria-label': `Remove filter ${labelOf(kind, state.filters[kind])}`,
				class: 'chip fb-chip',
				'data-filter': kind,
				onclick: () => setFilter(kind, BOOLEAN_FILTERS.includes(kind) ? false : ''),
				type: 'button',
			}, h('span', null, labelOf(kind, state.filters[kind])), h('span', {'aria-hidden': 'true', class: 'fb-chip-x'}, '×'))),
			active.length > 1 ? h('button', {class: 'chip fb-clear', onclick: clearFilters, type: 'button'}, 'Clear all') : null,
		].filter(Boolean));
	}

	// ----------------------------------------------------------- the sheet

	let sheet = null;
	let sheetBody = null;
	let showButton = null;

	function setFilter(kind, value) {
		state.filters[kind] = BOOLEAN_FILTERS.includes(kind) ? value === true : String(value || '');
		changed('filter');
		drawSheet();
	}

	function clearFilters() {
		state.filters = emptyFilters();
		changed('filter');
		drawSheet();
	}

	const field = (kind, label, control) => h('div', {class: 'fb-field', 'data-filter': kind}, h('label', {for: control.id}, label), h('span', {class: 'select-wrap'}, control));

	const select = (kind, label, anyText, options) => {
		const control = h('select', {id: `${id}-f-${kind}`, onchange: () => setFilter(kind, control.value)},
			h('option', {value: ''}, anyText),
			options.map((option) => h('option', {value: option.value}, `${option.label} (${option.count.toLocaleString('en-US')})`))
		);

		// A remembered choice the list no longer holds still shows, so it can
		// be cleared from here as well as from its chip.
		if (state.filters[kind] && !options.some((option) => option.value === state.filters[kind])) {
			control.append(h('option', {value: state.filters[kind]}, `${labelOf(kind, state.filters[kind])} (0)`));
		}

		control.value = state.filters[kind];

		return field(kind, label, control);
	};

	// A one-of-many choice as buttons, for the short lists: the energy types
	// with their theme colors, and the categories.
	const choices = (kind, label, options, swatch = null) => h('fieldset', {class: `fb-field fb-choices fb-${kind}`, 'data-filter': kind},
		h('legend', null, label),
		h('div', {class: 'fb-choice-row'},
			[{count: null, label: 'Any', value: ''}, ...options].map((option) => h('button', {
				'aria-pressed': String(state.filters[kind] === option.value),
				class: 'chip fb-choice',
				'data-value': option.value,
				onclick: () => setFilter(kind, option.value),
				type: 'button',
			},
			swatch && option.value ? h('span', {'aria-hidden': 'true', class: 'fb-swatch', style: `--swatch: ${swatch(option.value)}`}) : null,
			h('span', null, option.label),
			option.count === null ? null : h('span', {class: 'fb-choice-count'}, option.count.toLocaleString('en-US'))))
		)
	);

	// The Pokédex range: two numbers, applied when one is left (change), so
	// typing "151" does not redraw the sheet at "1" and "15".
	function dexField() {
		const range = dexRange(state.filters.dex);
		const number = (which, value) => h('input', {
			'aria-describedby': `${id}-f-dex-hint`,
			class: 'search fb-dex-input',
			id: `${id}-f-dex-${which}`,
			inputmode: 'numeric',
			max: MAX_DEX,
			min: 1,
			onchange: () => setFilter('dex', dexRangeValue(document.getElementById(`${id}-f-dex-from`).value, document.getElementById(`${id}-f-dex-to`).value)),
			placeholder: which === 'from' ? '1' : String(MAX_DEX),
			type: 'number',
			value: value === null ? null : String(value),
		});

		return h('fieldset', {class: 'fb-field fb-dex', 'data-filter': 'dex'},
			h('legend', null, 'Pokédex number'),
			h('div', {class: 'fb-dex-row'},
				h('label', {for: `${id}-f-dex-from`}, 'From'),
				number('from', range ? range.from : null),
				h('label', {for: `${id}-f-dex-to`}, 'to'),
				number('to', range && range.to !== range.from ? range.to : null)
			),
			h('p', {class: 'muted fb-hint', id: `${id}-f-dex-hint`}, 'Leave "to" empty for one Pokémon. The search finds them too: #25, or #1-151.')
		);
	}

	const energyColor = (name) => (ENERGIES.find((energy) => energy.name === name) || {light: 'transparent'}).light;

	// The sheet keeps one slot per filter and redraws the slots in place,
	// all but the Pokédex range: its two fields stay as typed while the
	// keyboard moves between them, and take the state only from outside
	// (a chip removed, Clear all).
	let slots = null;
	let dexNode = null;

	function syncDex() {
		const range = dexRange(state.filters.dex);
		const from = document.getElementById(`${id}-f-dex-from`);
		const to = document.getElementById(`${id}-f-dex-to`);

		if (!from || !to || [from, to].includes(document.activeElement)) {
			return;
		}

		if (dexRangeValue(from.value, to.value) !== (range ? `${range.from}-${range.to}` : '')) {
			from.value = range ? String(range.from) : '';
			to.value = range && range.to !== range.from ? String(range.to) : '';
		}
	}

	function fieldFor(kind, options) {
		if (kind === 'region') {
			return select('region', 'Region or generation', 'Any region', options.region);
		}

		if (kind === 'type') {
			return choices('type', 'Energy type', options.type, energyColor);
		}

		if (kind === 'category') {
			return choices('category', 'Category', options.category);
		}

		if (kind === 'set') {
			return select('set', 'Set', 'Any set', options.set);
		}

		if (kind === 'language') {
			return select('language', 'Language', 'Any language', options.language);
		}

		if (kind === 'rarity') {
			return select('rarity', 'Rarity', 'Any rarity', options.rarity);
		}

		if (kind === 'price') {
			return select('price', 'Price', 'Priced or not', options.price);
		}

		if (kind === 'favorite') {
			const star = h('input', {checked: state.filters.favorite, id: `${id}-f-favorite`, onchange: () => setFilter('favorite', star.checked), type: 'checkbox'});

			return h('div', {class: 'fb-field fb-check', 'data-filter': 'favorite'},
				star,
				h('label', {for: star.id}, `Favorites only (${options.favorite.toLocaleString('en-US')})`)
			);
		}

		const box = h('input', {checked: state.filters.unplaced, id: `${id}-f-unplaced`, onchange: () => setFilter('unplaced', box.checked), type: 'checkbox'});

		return h('div', {class: 'fb-field fb-check', 'data-filter': 'unplaced'},
			box,
			h('label', {for: box.id}, `Not in a binder yet (${options.unplaced.toLocaleString('en-US')})`)
		);
	}

	const DETAIL_FILTERS = ['region', 'dex', 'type', 'category', 'rarity'];

	function drawSheet() {
		if (!sheet || !sheet.open) {
			return;
		}

		if (!slots) {
			slots = new Map([['note', h('div', {class: 'fb-slot'})], ...offered.map((kind) => [kind, h('div', {class: 'fb-slot'})])]);
			sheetBody.replaceChildren(...slots.values());
		}

		const options = filterOptions(items);
		const waiting = items.length && !items.some((item) => item.category);
		const active = document.activeElement;
		const focused = active && sheetBody.contains(active)
			? (active.id || (active.dataset.value !== undefined ? `choice:${active.closest('[data-filter]').dataset.filter}:${active.dataset.value}` : null))
			: null;

		slots.get('note').replaceChildren(...(waiting && offered.some((kind) => DETAIL_FILTERS.includes(kind))
			? [h('p', {class: 'muted fb-note'}, 'Regions, Pokédex numbers, types, categories, and rarities fill in as card details download. Cards without them do not match those filters yet.')]
			: []));

		for (const kind of offered) {
			if (kind !== 'dex') {
				slots.get(kind).replaceChildren(fieldFor(kind, options));
			}
			else if (!dexNode) {
				dexNode = dexField();
				slots.get('dex').append(dexNode);
			}
			else {
				syncDex();
			}
		}

		const shown = applyFilters(items, {filters: state.filters, query: state.query}).length;

		showButton.textContent = `Show ${shown.toLocaleString('en-US')} ${shown === 1 ? 'card' : 'cards'}`;

		// Redrawing must not drop the keyboard's place.
		if (focused && !sheetBody.contains(document.activeElement)) {
			const [, kind, value] = focused.startsWith('choice:') ? focused.split(':') : [];
			const target = kind
				? sheetBody.querySelector(`[data-filter="${kind}"] [data-value="${CSS.escape(value)}"]`)
				: document.getElementById(focused);

			if (target) {
				target.focus();
			}
		}
	}

	function openSheet() {
		if (!sheet) {
			sheetBody = h('div', {class: 'fb-sheet-body'});
			showButton = h('button', {class: 'primary fb-show', onclick: () => sheet.close(), type: 'button'}, 'Show');
			sheet = h('dialog', {'aria-labelledby': `${id}-sheet-title`, class: 'sheet fb-sheet', id: `${id}-sheet`},
				h('div', {class: 'sheet-head'},
					h('h2', {id: `${id}-sheet-title`}, 'Filters'),
					h('button', {class: 'small', id: `${id}-sheet-close`, onclick: () => sheet.close(), type: 'button'}, 'Done')
				),
				sheetBody,
				h('div', {class: 'fb-sheet-foot'},
					h('button', {class: 'fb-reset', id: `${id}-clear`, onclick: clearFilters, type: 'button'}, 'Clear all'),
					showButton
				)
			);
			sheet.addEventListener('click', (event) => {
				if (event.target === sheet) {
					sheet.close();
				}
			});
			sheet.addEventListener('close', () => {
				if (filterButton.isConnected) {
					filterButton.focus();
				}
			});
			document.body.append(sheet);
		}

		if (!sheet.open) {
			sheet.showModal();
		}

		drawSheet();
	}

	function setItems(next) {
		items = next;
		drawChips();
		drawSheet();
	}

	function destroy() {
		clearTimeout(searchTimer);

		if (sheet) {
			if (sheet.open) {
				sheet.close();
			}

			sheet.remove();
		}
	}

	drawChips();

	return {clearFilters, destroy, element, openSheet, setFilter, setItems, state};
}
