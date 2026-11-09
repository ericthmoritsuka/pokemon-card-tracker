// How a card grid draws its cards (Eric, 2026-11-09; DESIGN.md section 3,
// "Card views"): Large (two a row on a phone, the art big with the name,
// number, and value under it), Grid (the tile as everywhere else, and the
// default), Mini (the art alone, a binder page's worth at a glance), or List
// (a row per card with every fact in words). My Cards offers the switch;
// another screen adopts it by giving its own storage key to viewSwitch and
// drawing its cards by the view the switch reports. css/card-views.css
// styles each view from the grid's data-view.
//
// The choice is kept on this phone only, like a picker's sort.

import {BASE, h} from './dom.js';
import {tileArt} from './tile.js';

export const CARD_VIEWS = [
	{label: 'Large', value: 'large'},
	{label: 'Grid', value: 'grid'},
	{label: 'Mini', value: 'mini'},
	{label: 'List', value: 'list'},
];

export const DEFAULT_VIEW = 'grid';

// My Cards' choice. Another screen keeps its own: cardTracker.<screen>View.
export const CARDS_VIEW_KEY = 'cardTracker.cardsView';

export const isCardView = (value) => CARD_VIEWS.some((view) => view.value === value);

// The view saved under key, or Grid when there is none, it is not a view
// (an older or mistyped value), or storage is off.
export function savedCardView(key = CARDS_VIEW_KEY) {
	try {
		const saved = localStorage.getItem(key);

		return isCardView(saved) ? saved : DEFAULT_VIEW;
	}
	catch {
		return DEFAULT_VIEW;
	}
}

export function saveCardView(view, key = CARDS_VIEW_KEY) {
	if (!isCardView(view)) {
		return;
	}

	try {
		localStorage.setItem(key, view);
	}
	catch {
		// The view lasts for this visit only.
	}
}

// The View select, for a filter bar's row (js/filter-bar.js extra): each
// option reads "View: Grid", as a picker's sort reads "Sort: Name", so the
// label shows whatever is chosen. onChange(view) runs after the choice is
// saved. Returns {element, view}, view being the current choice.
export function viewSwitch({id = 'cards', key = CARDS_VIEW_KEY, onChange = () => {}} = {}) {
	const state = {view: savedCardView(key)};
	const select = h('select', {
		'aria-label': 'View',
		class: 'fb-view',
		id: `${id}-view`,
		onchange: () => {
			state.view = isCardView(select.value) ? select.value : DEFAULT_VIEW;
			saveCardView(state.view, key);
			onChange(state.view);
		},
	}, CARD_VIEWS.map((view) => h('option', {value: view.value}, `View: ${view.label}`)));

	select.value = state.view;

	return {
		element: h('span', {class: 'select-wrap fb-view-wrap'}, select),
		get view() {
			return state.view;
		},
	};
}

// One card as a List row: a small thumbnail, then the name with the value
// at the end of its line (wrapping under it when the text is large), any
// second name line, the meta line ("Set · 025 / 120"), and the facts line
// (language, finish, copies). The row is one link with one accessible
// name, label, since its parts are read as a whole. Its classes keep a
// tile's, so js/photos/index.js and js/tile.js put a photo's "Photo by"
// line or the "English image" line after the meta line, as on a tile.
//
//   art     tileArt's options for the thumbnail (no corner badges: the
//           facts say them in words)
//   names   the name nodes (js/catalog-views.js tileNames)
//   price   the value node, or null when it is not known
export function cardRow({art, facts = [], label, meta = null, names = [], price = null, route}) {
	const [name, ...more] = names.filter(Boolean);
	const shownFacts = facts.filter(Boolean);

	return h('a', {'aria-label': label, class: 'tile card-row', 'data-link': route, href: BASE + route},
		tileArt({decorative: true, ...art}),
		h('span', {class: 'row-head'}, name || null, price ? h('span', {class: 'tile-price'}, price) : null),
		...more,
		meta ? h('span', {class: 'tile-meta'}, meta) : null,
		shownFacts.length ? h('span', {class: 'row-facts'}, ...shownFacts.map((fact) => h('span', {class: 'row-fact'}, fact))) : null
	);
}
