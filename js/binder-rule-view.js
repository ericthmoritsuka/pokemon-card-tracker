// The form part of a binder made from a list (js/binder-rules.js): which
// cards, in which order, and the pocket size, with the count of pockets and
// pages as the choice changes. js/binders-view.js puts it in its binder
// form in place of the grid and pages, for a new binder and for Edit.

import {presetFor, presetPicker} from './binder-presets.js';
import {h} from './dom.js';
import {filterOptions} from './filter-bar.js';
import {formatCount, plural} from './format.js';
import {LANGUAGES, languageLabel} from './catalog.js';
import {FILTER_FIELDS, cleanBinderRule, checkBinderRule, checkFits, ordersFor, pagesFor} from './binder-rules.js';
import {filterItems, loadRuleItems, sourceChoices, sourceEntry} from './binder-sources.js';

const KINDS = [
	{label: 'Checklist', value: 'checklist'},
	{label: 'Collection', value: 'collection'},
	{label: 'Goal', value: 'goal'},
	{label: 'Filter', value: 'filter'},
];

const FILTER_LABELS = {language: 'Language', rarity: 'Rarity', region: 'Region', set: 'Set', type: 'Type'};

// The filter's choices offered: region, set, type, and language (rarity
// too when the cards have it), from the owned cards, with "Any" first.
const OFFERED = ['region', 'set', 'type', 'language'];

const choice = (value, label) => h('option', {value}, label);

// The labels of the filter's stored values ({field: {value: label}}), for
// sourceText.
export function filterLabels(doc, index) {
	const options = filterOptions(filterItems(doc.cards, index));
	const out = {};

	for (const field of FILTER_FIELDS) {
		out[field] = Object.fromEntries((options[field] || []).map((option) => [option.value, option.label]));
	}

	for (const lang of LANGUAGES) {
		out.language[lang.code] = out.language[lang.code] || languageLabel(lang.code);
	}

	return out;
}

// The section: {element, fields(), rule(), ready(), nameHint()}.
//   fields()   {rows, cols, preset, page_count} for the binder form; the
//              pages follow the pockets counted last
//   rule()     the rule, checked (throws words for the form)
//   ready()    resolves the source's items for the rule now ({items, ...},
//              js/binder-sources.js loadRuleItems)
//   nameHint() the list's name, for a binder left unnamed
// start: {binder} to edit, or {kind, id} to preselect a list.
export function ruleSection({binder = null, doc, index, onChange = () => {}, start = {}}) {
	const rule = binder ? cleanBinderRule(binder.rule) : null;
	const choices = sourceChoices(doc);
	const firstKind = (rule && rule.source.kind) || start.kind || KINDS.find((kind) => kind.value === 'filter' || choices[kind.value].length).value;
	const kindGroup = h('div', {'aria-label': 'Made from', class: 'segmented rule-kinds', id: 'rule-kind', role: 'radiogroup'},
		KINDS.map(({label, value}) => h('label', null,
			h('input', {checked: value === firstKind, name: 'rule-kind', type: 'radio', value}),
			h('span', null, label))));
	const listSelect = h('select', {'aria-label': 'List', id: 'rule-list'});
	const listWrap = h('span', {class: 'select-wrap', id: 'rule-list-wrap'}, listSelect);
	const listNote = h('p', {class: 'muted', id: 'rule-list-note'});
	const options = filterOptions(filterItems(doc.cards, index));
	const filterSelects = Object.fromEntries(OFFERED.map((field) => [field, h('select', {'aria-label': FILTER_LABELS[field], id: `rule-filter-${field}`},
		choice('', `Any ${FILTER_LABELS[field].toLowerCase()}`),
		(field === 'language' && !(options.language || []).length
			? LANGUAGES.map((lang) => ({label: lang.label, value: lang.code}))
			: options[field] || []).map((option) => choice(option.value, option.label)))]));
	const filterBox = h('div', {class: 'rule-filters', id: 'rule-filters'},
		OFFERED.map((field) => h('label', {class: 'rule-filter'}, h('span', {class: 'field-label'}, FILTER_LABELS[field]), h('span', {class: 'select-wrap'}, filterSelects[field]))));
	const orderSelect = h('select', {'aria-label': 'Order', id: 'rule-order'});
	const rowsSelect = h('select', {'aria-label': 'Rows', id: 'binder-rows'}, [1, 2, 3, 4, 5].map((n) => choice(n, `${n} ${n === 1 ? 'row' : 'rows'}`)));
	const colsSelect = h('select', {'aria-label': 'Columns', id: 'binder-cols'}, [1, 2, 3, 4, 5].map((n) => choice(n, `${n} ${n === 1 ? 'column' : 'columns'}`)));
	const count = h('p', {'aria-live': 'polite', class: 'muted', id: 'rule-count'});
	let counted = null;
	let asked = 0;
	let pending = null;

	rowsSelect.value = String(binder ? binder.rows : 3);
	colsSelect.value = String(binder ? binder.cols : 3);

	if (rule && rule.source.kind === 'filter') {
		for (const field of OFFERED) {
			const value = (rule.source.filter[field] || [])[0] || '';

			if (value && ![...filterSelects[field].options].some((option) => option.value === value)) {
				filterSelects[field].append(choice(value, value));
			}

			filterSelects[field].value = value;
		}
	}

	const kind = () => kindGroup.querySelector('input:checked').value;

	// Pocket sizes fill in the grid; their page counts do not apply, since
	// the pages follow the cards.
	const presets = presetPicker({
		onPick: (picked) => {
			if (!picked.rows) {
				rowsSelect.focus();

				return;
			}

			rowsSelect.value = String(picked.rows);
			colsSelect.value = String(picked.cols);
			recount();
		},
		value: presetFor({cols: colsSelect.value, page_count: 40, rows: rowsSelect.value}),
	});

	function fillList() {
		const list = choices[kind()] || [];
		const wanted = (rule && rule.source.kind === kind() && rule.source.id) || (start.kind === kind() && start.id) || listSelect.value;

		listSelect.replaceChildren(...list.map((item) => choice(item.id, item.name)));

		if (rule && rule.source.kind === kind() && !list.some((item) => item.id === rule.source.id)) {
			listSelect.prepend(choice(rule.source.id, 'The list it was made from (deleted)'));
		}

		if ([...listSelect.options].some((option) => option.value === wanted)) {
			listSelect.value = wanted;
		}

		const none = kind() !== 'filter' && !listSelect.options.length;

		listNote.textContent = none ? `You have no ${kind()}s yet. Make one in the Lists tab, or use a filter.` : '';
		listWrap.hidden = kind() === 'filter' || none;
		filterBox.hidden = kind() !== 'filter';

		const orders = ordersFor(kind());
		const keep = (rule && orders.some((order) => order.value === rule.order) && rule.order) || orderSelect.value;

		orderSelect.replaceChildren(...orders.map((order) => choice(order.value, order.label)));

		if (orders.some((order) => order.value === keep)) {
			orderSelect.value = keep;
		}
	}

	function draft() {
		if (kind() === 'filter') {
			const filter = {};

			for (const field of OFFERED) {
				if (filterSelects[field].value) {
					filter[field] = [filterSelects[field].value];
				}
			}

			// A field the screen does not offer (rarity) stays as it was.
			if (rule && rule.source.kind === 'filter' && rule.source.filter.rarity) {
				filter.rarity = rule.source.filter.rarity;
			}

			return {order: orderSelect.value, source: {filter, kind: 'filter'}};
		}

		return {order: orderSelect.value, source: {id: listSelect.value, kind: kind()}};
	}

	const grid = () => ({cols: Number(colsSelect.value), rows: Number(rowsSelect.value)});

	function drawCount() {
		const {cols, rows} = grid();

		presets.set({cols, page_count: 40, rows});

		if (!counted) {
			return;
		}

		const n = counted.items.length;
		const owned = counted.items.filter((item) => item.copies.length).length;

		try {
			checkFits(n, rows, cols);
			count.className = 'muted';
			count.textContent = n
				? `${plural(n, 'pocket', 'pockets')} (${formatCount(owned)} with a card you own): ${plural(pagesFor(n, rows, cols), 'page', 'pages')} of ${rows} × ${cols}.`
				: 'No cards fit this yet, so the binder starts with one empty page.';
		}
		catch (err) {
			count.className = 'form-error';
			count.textContent = err.message;
		}
	}

	// Counts the pockets for the rule now; the latest ask wins.
	function recount() {
		const ticket = ++asked;
		let checked;

		counted = null;

		try {
			checked = checkBinderRule(draft());
		}
		catch (err) {
			count.className = 'muted';
			count.textContent = err.message;
			pending = Promise.reject(err);
			pending.catch(() => {});
			drawCount();
			onChange();

			return;
		}

		count.className = 'muted';
		count.textContent = 'Counting the pockets…';
		pending = loadRuleItems(checked, doc, {index}).then((result) => {
			if (ticket === asked) {
				counted = result;

				if (result.gone) {
					count.className = 'form-error';
					count.textContent = 'That list was deleted. Choose another.';
				}
				else {
					drawCount();
				}
			}

			return result;
		});
		pending.catch((err) => {
			if (ticket === asked) {
				count.className = 'form-error';
				count.textContent = `The cards could not be read. ${err.message || ''}`.trim();
			}
		});
		drawCount();
		onChange();
	}

	kindGroup.addEventListener('change', () => {
		fillList();
		recount();
	});
	listSelect.addEventListener('change', recount);
	orderSelect.addEventListener('change', recount);
	rowsSelect.addEventListener('change', () => {
		drawCount();
		onChange();
	});
	colsSelect.addEventListener('change', () => {
		drawCount();
		onChange();
	});

	for (const select of Object.values(filterSelects)) {
		select.addEventListener('change', recount);
	}

	fillList();

	const element = h('div', {class: 'rule-section', id: 'rule-section'},
		h('span', {class: 'field-label'}, 'Cards from'),
		kindGroup,
		listWrap,
		listNote,
		filterBox,
		h('label', {for: 'rule-order'}, 'Order'),
		h('span', {class: 'select-wrap'}, orderSelect),
		h('span', {class: 'field-label'}, 'Pocket size'),
		presets.element,
		h('div', {class: 'toolbar two grid-steppers'}, h('span', {class: 'select-wrap'}, rowsSelect), h('span', {class: 'select-wrap'}, colsSelect)),
		count
	);

	recount();

	return {
		element,
		fields: () => {
			const {cols, rows} = grid();
			const n = counted ? counted.items.length : 0;

			return {cols, page_count: Math.min(200, pagesFor(n, rows, cols)), preset: presetFor({cols, page_count: 40, rows}), rows};
		},
		grid,
		nameHint: () => {
			const checked = cleanBinderRule(draft());

			if (!checked) {
				return '';
			}

			if (checked.source.kind === 'filter') {
				return OFFERED.flatMap((field) => (filterSelects[field].value ? [filterSelects[field].selectedOptions[0].textContent] : [])).join(', ');
			}

			const found = sourceEntry(checked, doc);

			return found ? found.name : '';
		},
		ready: () => pending,
		rule: () => checkBinderRule(draft()),
	};
}
