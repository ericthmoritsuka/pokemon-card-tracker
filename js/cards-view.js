// My Cards: the owned collection, one tile per card and language, plus the
// CSV export.

import {
	cardImage,
	cardIndex,
	catalogFor,
	catalogLanguage,
	compareNumbers,
	isLanguage,
	languageLabel,
	saveToCardIndex,
	setDetailOnce,
	viewingLanguage,
} from './catalog.js';
import {cardArt} from './catalog-views.js';
import {listCards, onChange} from './collection.js';
import {BASE, errorText, h} from './dom.js';
import {finishLabel} from './monprice.js';

const formatCount = (n) => Number(n).toLocaleString('en-US');

const plural = (n, one, many) => `${formatCount(n)} ${n === 1 ? one : many}`;

export const languageChip = (code) => (code === 'zh-cn' ? 'CHS' : code === 'zh-tw' ? 'CHT' : String(code).toUpperCase());

const routeTo = (...parts) => parts.map((part) => encodeURIComponent(part)).join('/');

function readSetting(key, allowed, fallback) {
	try {
		const saved = localStorage.getItem(key);

		return allowed.includes(saved) ? saved : fallback;
	}
	catch {
		return fallback;
	}
}

function writeSetting(key, value) {
	try {
		localStorage.setItem(key, value);
	}
	catch {
		// The choice lasts for this visit only.
	}
}

// The localization a tile shows: the viewing language when the card's
// catalog has it, then the copy's own language, then the catalog's base
// language, then anything.
function display(record, preferred) {
	const localizations = (record && record.localizations) || {};

	for (const lang of preferred) {
		if (lang && localizations[lang]) {
			return localizations[lang];
		}
	}

	return Object.values(localizations)[0] || null;
}

// -------------------------------------------------------------- export

const csvField = (value) => {
	const text = value === null || value === undefined ? '' : String(value);

	return /[;"\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

// The number goes out as ="001" so a spreadsheet keeps it as text: Excel
// turns 001 into 1 and 4/16 into a date (DESIGN.md section 9).
const asText = (value) => (value ? `="${value}"` : '');

const NAME_COLUMN = 6;

const importedFinish = (entry) => entry.finish_raw || (entry.import_key ? entry.import_key.split('|')[3] : null);

export function collectionCsv(entries, index) {
	const header = [
		'Entry ID', 'Card ID', 'Catalog', 'Set ID', 'Set', 'Number', 'Name', 'Language',
		'Variant ID', 'Finish', 'Finish Matched', 'Language Source', 'Created At', 'Updated At',
	];
	const lines = [header.map(csvField).join(';')];

	for (const entry of entries) {
		const record = index.get(`${entry.catalog}|${entry.card_id}`) || {};
		const shown = display(record, [entry.language, catalogLanguage(entry.catalog)]) || {};
		const finish = importedFinish(entry);

		lines.push([
			entry.id,
			entry.card_id,
			entry.catalog,
			record.set_id,
			shown.set_name,
			asText(record.collector_number),
			// Names are always quoted: plenty of card names hold commas.
			`"${String(shown.name || '').replace(/"/g, '""')}"`,
			languageChip(entry.language),
			entry.variant_id,
			finish ? finishLabel(finish) : '',
			entry.variant_id ? 'Yes' : 'No',
			entry.language_source,
			entry.created_at,
			entry.updated_at,
		].map((value, i) => (i === NAME_COLUMN ? value : csvField(value))).join(';'));
	}

	// UTF-8 with a BOM, or Excel mangles every é.
	return `﻿${lines.join('\r\n')}\r\n`;
}

function download(name, text) {
	const url = URL.createObjectURL(new Blob([text], {type: 'text/csv;charset=utf-8'}));
	const link = h('a', {download: name, href: url, hidden: true});

	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ------------------------------------------------------------ the view

const SORTS = [
	{label: 'Newest added', value: 'newest'},
	{label: 'Oldest added', value: 'oldest'},
	{label: 'Name A to Z', value: 'name'},
	{label: 'Set, newest first', value: 'set'},
];

const SORT_KEY = 'cardTracker.cardsSort';
const FILTER_KEY = 'cardTracker.cardsLanguage';
const PAGE = 120;

export function myCardsView(root) {
	let alive = true;
	let shown = PAGE;
	let groups = [];
	let entries = [];
	let index = new Map();

	const viewing = viewingLanguage();
	const sort = h('select', {'aria-label': 'Sort cards', id: 'cards-sort', onchange: () => {
		writeSetting(SORT_KEY, sort.value);
		shown = PAGE;
		draw();
	}}, SORTS.map(({label, value}) => h('option', {value}, label)));
	const filter = h('select', {'aria-label': 'Show copies in', id: 'cards-language', onchange: () => {
		writeSetting(FILTER_KEY, filter.value);
		shown = PAGE;
		draw();
	}});
	const summary = h('p', {class: 'muted', id: 'cards-summary'});
	const grid = h('div', {class: 'card-grid'});
	const more = h('button', {hidden: true, onclick: () => {
		shown += PAGE;
		draw();
	}, type: 'button'}, 'Show more');
	const exportButton = h('button', {onclick: exportCsv, type: 'button'}, 'Export CSV');
	const body = h('div');

	sort.value = readSetting(SORT_KEY, SORTS.map((option) => option.value), 'newest');

	function exportCsv() {
		const live = [...entries].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

		download(`card-tracker-${new Date().toISOString().slice(0, 10)}.csv`, collectionCsv(live, index));
	}

	function build() {
		const map = new Map();

		for (const entry of entries) {
			const key = `${entry.catalog}|${entry.card_id}|${entry.language}`;

			if (!map.has(key)) {
				map.set(key, {entries: [], key});
			}

			map.get(key).entries.push(entry);
		}

		groups = [...map.values()].map((group) => {
			const first = group.entries[0];
			const record = index.get(`${first.catalog}|${first.card_id}`) || null;
			const base = catalogLanguage(first.catalog);
			const viewingFits = catalogFor(viewing) === first.catalog;
			const local = display(record, [viewingFits ? viewing : null, first.language, base]);
			const times = group.entries.map((entry) => String(entry.created_at)).sort();

			return {
				...group,
				catalog: first.catalog,
				cardId: first.card_id,
				language: first.language,
				local,
				newest: times[times.length - 1],
				oldest: times[0],
				record,
			};
		});
	}

	function sorted(list) {
		const by = sort.value;
		const name = (group) => (group.local && group.local.name) || group.cardId;

		return [...list].sort((a, b) => {
			if (by === 'newest') {
				return b.newest.localeCompare(a.newest);
			}

			if (by === 'oldest') {
				return a.oldest.localeCompare(b.oldest);
			}

			if (by === 'name') {
				return name(a).localeCompare(name(b)) || a.language.localeCompare(b.language);
			}

			const dateA = (a.record && a.record.release_date) || '';
			const dateB = (b.record && b.record.release_date) || '';

			return dateB.localeCompare(dateA)
				|| String(a.record && a.record.set_id).localeCompare(String(b.record && b.record.set_id))
				|| compareNumbers(a.record ? a.record.collector_number : '', b.record ? b.record.collector_number : '');
		});
	}

	function tile(group) {
		const {local, record} = group;
		const count = group.entries.length;
		const lang = local && isLanguage(local.lang) ? local.lang : catalogLanguage(group.catalog);
		const info = {
			name: (local && local.name) || group.cardId,
			number: record && record.collector_number,
			setName: local && local.set_name,
		};
		const frame = h('div', {class: 'art-wrap'}, cardArt(info, local ? cardImage(local.image, 'low') : null));

		if (count > 1) {
			frame.append(h('span', {'aria-label': `${count} copies`, class: 'badge badge-qty'}, `×${count}`));
		}

		if (group.language !== viewing) {
			frame.append(h('span', {'aria-label': `Printed in ${languageLabel(group.language)}`, class: 'badge badge-lang'}, languageChip(group.language)));
		}

		return h('a', {class: 'tile', 'data-link': routeTo('cards', lang, group.cardId), href: BASE + routeTo('cards', lang, group.cardId)},
			frame,
			h('span', {class: 'tile-name'}, info.name),
			h('span', {class: 'tile-meta'}, [info.number ? `#${info.number}` : null, info.setName].filter(Boolean).join(' · '))
		);
	}

	function draw() {
		const languages = new Map();

		for (const group of groups) {
			languages.set(group.language, (languages.get(group.language) || 0) + group.entries.length);
		}

		const wanted = readSetting(FILTER_KEY, ['all', ...languages.keys()], 'all');

		filter.replaceChildren(
			h('option', {value: 'all'}, 'All languages'),
			...[...languages.entries()]
				.sort((a, b) => b[1] - a[1])
				.map(([code, n]) => h('option', {value: code}, `${languageLabel(code)} (${formatCount(n)})`))
		);
		filter.value = wanted;

		const visible = sorted(groups.filter((group) => wanted === 'all' || group.language === wanted));
		const copies = visible.reduce((sum, group) => sum + group.entries.length, 0);

		summary.textContent = `${plural(copies, 'copy', 'copies')} in ${plural(visible.length, 'tile', 'tiles')}. One tile per card and language.`;
		grid.replaceChildren(...visible.slice(0, shown).map(tile));
		more.hidden = visible.length <= shown;
		more.textContent = `Show more (${formatCount(visible.length - shown)} left)`;
	}

	// Names and images in the viewing language, for international cards the
	// import only read in the copy's language and English. Cache first, four
	// sets at a time.
	async function fillViewingLanguage() {
		if (catalogFor(viewing) !== 'international') {
			return;
		}

		const missing = new Set();

		for (const record of index.values()) {
			if (record.catalog === 'international' && !(record.localizations || {})[viewing]) {
				missing.add(record.set_id);
			}
		}

		const sets = [...missing];
		const found = [];
		let next = 0;

		const worker = async () => {
			while (alive && next < sets.length) {
				const setId = sets[next++];

				try {
					const set = await setDetailOnce(viewing, setId);

					for (const card of (set && set.cards) || []) {
						if (index.has(`international|${card.id}`)) {
							found.push({
								catalog: 'international',
								id: card.id,
								localizations: {[viewing]: {image: card.image || null, lang: viewing, name: card.name, set_name: set.name}},
							});
						}
					}
				}
				catch {
					// Keep the copy's own language for this set.
				}
			}
		};

		await Promise.all([worker(), worker(), worker(), worker()]);

		if (alive && found.length) {
			index = await saveToCardIndex(found);
			build();
			draw();
		}
	}

	async function load() {
		try {
			[entries, index] = await Promise.all([listCards(), cardIndex()]);
		}
		catch (err) {
			body.replaceChildren(h('div', {class: 'notice', role: 'alert'}, h('p', null, `Your cards could not be read from this phone. ${errorText(err)}`)));

			return;
		}

		if (!alive) {
			return;
		}

		if (!entries.length) {
			body.replaceChildren(
				h('div', {class: 'card empty-state'},
					h('p', {class: 'big'}, 'No cards on this phone yet.'),
					h('p', {class: 'muted'}, 'Bring your collection over from monprice. Cards are matched to the catalog and listed in a report before anything is saved.'),
					h('a', {class: 'button primary', 'data-link': 'import', href: `${BASE}import`}, 'Import from monprice')
				)
			);

			return;
		}

		body.replaceChildren(
			h('div', {class: 'toolbar two'}, h('span', {class: 'select-wrap'}, sort), h('span', {class: 'select-wrap'}, filter)),
			summary,
			grid,
			more,
			h('div', {class: 'actions'},
				exportButton,
				h('a', {class: 'button', 'data-link': 'import', href: `${BASE}import`}, 'Import')
			)
		);
		build();
		draw();
		fillViewingLanguage();
	}

	const stop = onChange(() => alive && load());

	root.append(h('h2', null, 'My Cards'), body);
	load();

	return () => {
		alive = false;
		stop();
	};
}
