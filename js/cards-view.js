// My Cards: the owned collection, one tile per card and language. The same
// screen shows a family member's cards, read only (plans/ux-plan.md, "A
// family member's cards"); js/shell.js draws the view-only strip and the
// "Mine" switcher. The CSV export lives here and is offered from Profile.

import {
	cardImage,
	cardIndex,
	catalogFor,
	catalogLanguage,
	compareNumbers,
	importApi,
	indexKey,
	isLanguage,
	languageLabel,
	savedCardRecords,
	saveToCardIndex,
	setDetailOnce,
	viewingLanguage,
} from './catalog.js';
import {currentUser} from './auth.js';
import {offerCardList} from './card-swipe.js';
import {mainName, namesFor, tileNames, withTwinName} from './catalog-views.js';
import {isLive, listCards, onChange, sourceNames} from './collection.js';
import {BASE, errorText, fromHistory, h, rememberInHistory} from './dom.js';
import {whenMemberName} from './family.js';
import {finishLabel} from './monprice.js';
import {statsBar, tilePrice} from './price-view.js';
import {manualPrice} from './prices.js';
import {memberDocument} from './sync.js';
import {cardArt, cardTile, groupFinish} from './tile.js';
import {tileSrc, withMainPhoto} from './photos/index.js';
import {loadTwins, onTwinsChange, refreshTwins, twinName, twinSlides} from './twins.js';

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

const reais = (value) => (typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2).replace('.', ',') : '');

const importedFinish = (entry) => entry.finish_raw || (entry.import_key ? entry.import_key.split('|')[3] : null);

export function collectionCsv(entries, index) {
	const header = [
		'Entry ID', 'Card ID', 'Catalog', 'Set ID', 'Set', 'Number', 'Name', 'Language',
		'Variant ID', 'Finish', 'Finish Matched', 'Language Source', 'Created At', 'Updated At',
		'liga_low_nm', 'liga_avg', 'price_source', 'price_date',
	];
	const lines = [header.map(csvField).join(';')];

	for (const entry of entries) {
		const record = index.get(`${entry.catalog}|${entry.card_id}`) || {};
		const shown = display(record, [entry.language, catalogLanguage(entry.catalog)]) || {};
		const finish = importedFinish(entry);
		const manual = manualPrice(entry) || {};

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
			// Liga prices in reais with a decimal comma, as the semicolons
			// already suit a Brazilian spreadsheet: 45,90.
			reais(manual.low_nm),
			reais(manual.avg),
			manual.source,
			manual.date,
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

// The phone's share sheet, where Google Drive is one of the targets. Shown
// only where the browser can share files (Chrome on Android can).
const csvFile = (name, text) => new File([text], name, {type: 'text/csv'});

const canShareFiles = () => {
	try {
		return Boolean(navigator.canShare && navigator.canShare({files: [csvFile('check.csv', '')]}));
	}
	catch {
		return false;
	}
};

const csvName = () => `card-tracker-${new Date().toISOString().slice(0, 10)}.csv`;

// The whole collection as CSV, oldest first: a download, or the phone's
// share sheet when share is true and the browser can share files. Profile
// offers both. Resolves to the number of copies written.
export async function exportCollection({share = false} = {}) {
	const [entries, index] = await Promise.all([listCards(), cardIndex()]);
	const text = collectionCsv([...entries].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))), index);

	if (share && canShareFiles()) {
		try {
			await navigator.share({files: [csvFile(csvName(), text)], title: 'Card Tracker export'});

			return entries.length;
		}
		catch (error) {
			// Closing the share sheet is not an error; anything else falls
			// back to a plain download so the export still happens.
			if (error && error.name === 'AbortError') {
				return 0;
			}
		}
	}

	download(csvName(), text);

	return entries.length;
}

export {canShareFiles};

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

// How long My Cards gathers twins found in the background before drawing
// them, so a refresh over hundreds of Japanese cards redraws a few times,
// not once a card.
const TWIN_REDRAW_MS = 1000;

// What a group's international twin changes on its tile: the image and the
// English name (js/twins.js). Empty until the twins are loaded.
const twinShown = (twins, name) => (twins.length || name ? `${twins.map((twin) => twin.src).join(' ')}|${name || ''}` : '');

// Card records the index lacks: cards synced from another device or held by
// a family member, which this phone never imported. TCGdex card IDs are
// "<set id>-<number>", so each set is read once, cache first, and a card
// whose set that does not find is read on its own.
const SINGLE_CARD_LIMIT = 200;

function recordFrom(catalog, lang, set, card) {
	return {
		catalog,
		collector_number: card.localId,
		id: card.id,
		localizations: {[lang]: {image: card.image || null, lang, name: card.name, set_name: set.name || null}},
		official: (set.cardCount && set.cardCount.official) || null,
		release_date: set.releaseDate || null,
		set_id: set.id,
	};
}

async function pool(items, size, work) {
	let next = 0;

	await Promise.all(Array.from({length: Math.min(size, items.length)}, async () => {
		while (next < items.length) {
			await work(items[next++]);
		}
	}));
}

async function fillMissingRecords(entries, index, isAlive) {
	const missing = new Map();

	for (const entry of entries) {
		const key = indexKey(entry.catalog, entry.card_id);

		if (entry.card_id && !index.has(key)) {
			missing.set(key, {catalog: entry.catalog, cardId: entry.card_id, lang: catalogLanguage(entry.catalog)});
		}
	}

	if (!missing.size) {
		return null;
	}

	const sets = new Map();

	for (const item of missing.values()) {
		const cut = item.cardId.lastIndexOf('-');
		const key = `${item.catalog}|${cut > 0 ? item.cardId.slice(0, cut) : ''}`;

		if (!sets.has(key)) {
			sets.set(key, {catalog: item.catalog, lang: item.lang, setId: cut > 0 ? item.cardId.slice(0, cut) : null});
		}
	}

	const records = [];

	await pool([...sets.values()].filter((set) => set.setId), 4, async ({catalog, lang, setId}) => {
		if (!isAlive()) {
			return;
		}

		try {
			const set = await importApi.setDetail(lang, setId);

			for (const card of (set && set.cards) || []) {
				const key = indexKey(catalog, card.id);

				if (missing.has(key)) {
					records.push(recordFrom(catalog, lang, set, card));
					missing.delete(key);
				}
			}
		}
		catch {
			// Read each card on its own below.
		}
	});

	await pool([...missing.values()].slice(0, SINGLE_CARD_LIMIT), 4, async ({catalog, cardId, lang}) => {
		if (!isAlive()) {
			return;
		}

		try {
			const card = await importApi.cardDetail(lang, cardId);

			if (card && card.set) {
				records.push(recordFrom(catalog, lang, card.set, card));
			}
		}
		catch {
			// The tile keeps its card-back with the card ID.
		}
	});

	return records.length ? saveToCardIndex(records) : null;
}

export function myCardsView(root) {
	return cardsScreen(root, {
		load: listCards,
		watch: (reload) => onChange(reload),
	});
}

// A family member's My Cards, read only. Their document is read from the
// server each time; scanning and importing still save to you.
export function familyCardsView(root, {userId}) {
	let name = 'Family member';

	whenMemberName(userId, (memberLabel) => {
		name = memberLabel;
		document.title = `${name}'s cards | Card Tracker`;

		const heading = root.querySelector('.view-head h2');

		if (heading) {
			heading.textContent = `${name}'s cards`;
		}
	});

	return cardsScreen(root, {
		emptyText: () => `${name} hasn't added cards yet.`,
		load: async () => {
			if (!currentUser()) {
				throw new Error('Sign in to see your family\'s cards.');
			}

			if (!navigator.onLine) {
				throw new Error('A family member\'s cards show when you are online.');
			}

			const doc = await memberDocument(userId);

			return ((doc && doc.cards) || []).filter(isLive);
		},
		readOnly: true,
		title: `Family member's cards`,
	});
}

function cardsScreen(root, {emptyText = null, load: loadEntries, readOnly = false, title = 'My Cards', watch = null}) {
	let alive = true;
	// Back from a card page shows as many tiles as before, so the scroll
	// position it returns to is still there.
	let shown = Math.max(PAGE, fromHistory('shown', PAGE));
	let groups = [];
	// The tiles drawn, by group key, so a twin can redraw just its own.
	const tiles = new Map();
	let entries = [];
	let index = new Map();
	// Full TCGdex records saved on the phone, for the tiles' US estimates.
	let saved = new Map();

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
		rememberInHistory({shown});
		draw();
	}, type: 'button'}, 'Show more');
	const body = h('div');

	// The whole collection's value is on demand only, never a headline
	// total (DESIGN.md section 10).
	const statsPanel = h('div', {class: 'cards-stats', hidden: true, id: 'cards-stats'});
	const statsToggle = h('button', {'aria-controls': 'cards-stats', 'aria-expanded': 'false', class: 'link-button', id: 'cards-stats-toggle', type: 'button', onclick: () => {
		statsPanel.hidden = !statsPanel.hidden;
		statsToggle.setAttribute('aria-expanded', String(!statsPanel.hidden));
		statsToggle.textContent = statsPanel.hidden ? 'Stats' : 'Hide stats';
		drawStats();
	}}, 'Stats');

	function drawStats() {
		if (!statsPanel.hidden) {
			statsPanel.replaceChildren(statsBar({cardsById: new Map([...index, ...saved]), entries, label: readOnly ? 'these cards' : 'your collection'}));
		}
	}

	sort.value = readSetting(SORT_KEY, SORTS.map((option) => option.value), 'newest');

	function redrawNames() {
		if (alive && groups.length) {
			build();
			draw();
		}
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
			// A copy the catalog has no names for in its language shows the
			// names the source gave it (DESIGN.md section 5).
			const source = group.entries.map((entry) => sourceNames(entry, record)).find(Boolean) || null;
			const times = group.entries.map((entry) => String(entry.created_at)).sort();
			// Asian prints: an English name first, the original under it.
			const nameLang = source ? first.language : (local && local.lang) || base;

			return withTwin({
				...group,
				catalog: first.catalog,
				cardId: first.card_id,
				language: first.language,
				local,
				nameLang,
				newest: times[times.length - 1],
				oldest: times[0],
				plainNames: namesFor({lang: nameLang, name: (source && source.name) || (local && local.name) || first.card_id}, redrawNames),
				record,
				recordKey: `${first.catalog}|${first.card_id}`,
				setName: (source && source.setName) || (local && local.set_name) || null,
				twinItem: {card_id: first.card_id, catalog: first.catalog},
			});
		});
	}

	// A group's names and images with its international twin (js/twins.js):
	// the twin's image for the tile, and for a Japanese Trainer or Energy
	// with no English name, the twin's.
	function withTwin(group) {
		const names = withTwinName(group.plainNames, group.twinItem);
		const twins = twinSlides(group.twinItem, {size: 'low'});

		return Object.assign(group, {name: mainName(names), names, twinShown: twinShown(twins, twinName(group.twinItem)), twins});
	}

	// Whether a group's twin would draw differently now.
	const twinMoved = (group) => twinShown(twinSlides(group.twinItem, {size: 'low'}), twinName(group.twinItem)) !== group.twinShown;

	// Redraws only the tiles whose twin changed, or the whole grid when the
	// cards are sorted by name, since a new name can move a tile.
	function applyTwins() {
		const moved = groups.filter(twinMoved);

		if (!moved.length) {
			return;
		}

		moved.forEach(withTwin);

		if (sort.value === 'name') {
			draw();

			return;
		}

		for (const group of moved) {
			const old = tiles.get(group.key);

			if (old && old.isConnected) {
				const next = tile(group);

				tiles.set(group.key, next);
				old.replaceWith(next);
			}
		}
	}

	// A twin found or answered ("<catalog>|<card id>"): drawn a moment
	// later, with any others found meanwhile, when it changes a tile here.
	let twinTimer = null;

	function twinsChanged(key) {
		if (!alive || !groups.length || twinTimer) {
			return;
		}

		if (!groups.some((group) => group.recordKey === key && twinMoved(group))) {
			return;
		}

		twinTimer = setTimeout(() => {
			twinTimer = null;

			if (alive) {
				applyTwins();
			}
		}, TWIN_REDRAW_MS);
	}

	// After the first paint: the twins saved on this phone, drawn when any
	// tile shows one, then the due Japanese cards checked in the background.
	// Neither holds up the tiles, and offline the saved ones still show. The
	// timer inside the frame callback runs once that frame is painted, so a
	// quick read of the twins cannot hold up the first one.
	function startTwins() {
		requestAnimationFrame(() => setTimeout(() => alive && loadTwinsNow(), 0));
	}

	function loadTwinsNow() {
		loadTwins()
			.then(() => {
				if (!alive) {
					return;
				}

				applyTwins();

				return refreshTwins(entries);
			})
			.catch(() => {
				// No twins this visit; the tiles are unchanged.
			});
	}

	function sorted(list) {
		const by = sort.value;
		const name = (group) => group.name;

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

	const routeOf = (group) => {
		const lang = group.local && isLanguage(group.local.lang) ? group.local.lang : catalogLanguage(group.catalog);

		return routeTo('cards', lang, group.cardId);
	};

	function tile(group) {
		const {local, record} = group;
		const info = {
			name: group.name,
			number: record && record.collector_number,
			setName: group.setName,
		};
		const catalogSrc = local ? cardImage(local.image, 'low') : null;

		return withMainPhoto(cardTile({
			price: tilePrice(group.entries, saved.get(group.recordKey) || record),
			art: {
				count: group.entries.length,
				finish: groupFinish(group.entries),
				info,
				languages: [group.language],
				src: tileSrc(group.entries, catalogSrc, {twins: group.twins}),
				viewing,
			},
			meta: [info.number ? `#${info.number}` : null, info.setName].filter(Boolean).join(' · '),
			names: tileNames(group.names, group.nameLang),
			route: routeOf(group),
		}), group.entries, catalogSrc, (src) => cardArt(info, src), {twins: group.twins});
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
		tiles.clear();
		grid.replaceChildren(...visible.slice(0, shown).map((group) => {
			const element = tile(group);

			tiles.set(group.key, element);

			return element;
		}));
		offerCardList(visible.map(routeOf), heading.textContent);
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
			[entries, index] = await Promise.all([loadEntries(), cardIndex()]);
			saved = await savedCardRecords(entries);
		}
		catch (err) {
			body.replaceChildren(h('div', {class: 'notice', role: 'alert'}, h('p', null, readOnly
				? err.message || errorText(err)
				: `Your cards could not be read from this phone. ${errorText(err)}`)));

			return;
		}

		if (!alive) {
			return;
		}

		if (!entries.length && readOnly) {
			body.replaceChildren(h('div', {class: 'card empty-state'}, h('p', {class: 'big'}, emptyText())));

			return;
		}

		if (!entries.length) {
			// The empty state leads to the scanner, with the monprice import
			// as the second way in (plans/design-review.md section 3).
			body.replaceChildren(
				h('div', {class: 'card empty-state', id: 'cards-empty'},
					h('div', {'aria-hidden': 'true', class: 'empty-art'}),
					h('p', {class: 'big'}, 'No cards yet'),
					h('p', {class: 'muted'}, 'Scan your cards one by one, or bring your collection over from monprice. Imported cards are matched to the catalog and listed in a report before anything is saved.'),
					h('a', {class: 'button primary', 'data-link': 'scan', href: `${BASE}scan`, id: 'cards-empty-scan'}, 'Scan your first card'),
					h('a', {class: 'button', 'data-link': 'import', href: `${BASE}import`}, 'Import from monprice')
				)
			);

			return;
		}

		body.replaceChildren(
			h('div', {class: 'toolbar two'}, h('span', {class: 'select-wrap'}, sort), h('span', {class: 'select-wrap'}, filter)),
			summary,
			statsToggle,
			statsPanel,
			grid,
			more
		);
		build();
		draw();
		drawStats();
		fillViewingLanguage();
		startTwins();

		const filled = await fillMissingRecords(entries, index, () => alive);

		if (filled && alive) {
			index = filled;
			// Reading the missing records saved their prices on the phone too.
			saved = await savedCardRecords(entries);
			build();
			draw();
			drawStats();
		}
	}

	const stop = watch ? watch(() => alive && load()) : () => {};
	const stopTwins = onTwinsChange(twinsChanged);
	const heading = h('div', {class: 'view-head'}, h('h2', null, title));

	root.append(heading, body);
	load();

	return () => {
		alive = false;
		stop();
		stopTwins();
		clearTimeout(twinTimer);
	};
}
