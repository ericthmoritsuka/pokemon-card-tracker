// Binders: the binder list, one binder's pages, and the owned cards in no
// binder (js/binders.js). Each binder screen is also shown read only for a
// family member:
//   binders                                 the person's binders, as covers
//   binders/unplaced                        owned cards not in any binder
//   binders/<id>[/<page>]                   one binder, open as a spread
//   family/<userId>/binders                 a family member's, view only
//   family/<userId>/binders/<id>[/<page>]   one of theirs, view only
//
// A binder opens like a real one (js/binder-spread.js): facing pages turned
// around the spine, with ?spread=<k> (and &page=<p> for a page zoomed on a
// phone held upright) keeping the place. This file draws the pockets and
// their picker sheet.
//
// app.js wires these in from binderRoutes below; binderAccountViews lists the
// views to redraw on sign-in and sign-out. js/shell.js draws the view-only
// strip and the "Mine" switcher. Michi art is not edited here yet: a pocket
// holding a tile of it shows as art and is left alone.

import {currentUser} from './auth.js';
import {dropBinderCover, onCoversChange, paintCover, pickCoverImage, sweepCovers} from './binder-cover.js';
import {presetFor, presetPicker} from './binder-presets.js';
import {OVERVIEW_QUERY, SIDEWAYS_QUERY, binderSpread, spreadOfPage} from './binder-spread.js';
import {dropHand, handCopy, takeHand} from './binder-hand.js';
import {offerCardList} from './card-swipe.js';
import {pocketDrag} from './pocket-drag.js';
import {
	cardImage,
	cardIndex,
	catalogFor,
	catalogLanguage,
	importApi,
	indexKey,
	isLanguage,
	languageLabel,
	saveToCardIndex,
	setIdOfCard,
	viewingLanguage,
} from './catalog.js';
import {isLive, loadDocument, onChange, sourceNames} from './collection.js';
import {customRoute} from './custom-card.js';
import {alikeKey, copyStepper} from './copy-sheet.js';
import {BASE, errorText, fromHistory, go, h, rememberInHistory, showError} from './dom.js';
import {formatCount, plural} from './format.js';
import {UNDO_MS, orderSection} from './reorder.js';
import {toast} from './shell.js';
import {openDialogSheet} from './sheet.js';
import {whenMemberName} from './family.js';
import {memberDocument} from './sync.js';
import {imageCardKey, mainArt, mainSlide, onImagesChange} from './photos/index.js';
import {openPocketViewer} from './pocket-viewer.js';
import {addPagesText, applyLayout, doneText, previewLayout, previewLines, readList, undoLayout, undoText} from './binder-layout.js';
import {cardArt, cardTile, entryFinish, groupFinish, tileArt} from './tile.js';
import {showTotal, valueButton} from './value-sheet.js';
import {SearchHint, addToWishlist, searchCards} from './wishlist.js';
import {addToBinder, undoAddToBinder} from './placeholder-fill.js';
import {fillPanel} from './fill-view.js';
import {applyListEdits, indexAt, listEditEntries, listEditsOf, moveEdit, pagesFor, parseKey, picksOf, planRefresh, refreshText, ruleKey, shownCopy, withListEdit} from './binder-rules.js';
import {filterLabels, ruleSection} from './binder-rule-view.js';
import {cardItem, loadRuleItems, pokemonItem, rankerFor, sourceChoices, sourceEntry, sourceText, trayFromChoices, trayFromIds} from './binder-sources.js';
import {dexLabel, pokemonNames, spriteUrl} from './checklists.js';
import {loadedSpeciesNames, namesFor} from './catalog-views.js';
import {activeFilters, applyFilters, filterBar, searchTextOf, sortItems} from './filter-bar.js';
import {searchKey} from './names.js';
import {nowIso} from './collection.js';
import {
	COVER_SWATCHES,
	DEFAULT_COVER,
	GRID_PICKS,
	MAX_PAGES,
	binderStats,
	clearPocket,
	contentKey,
	cleanFields,
	coverImageOf,
	coverTextColor,
	createBinder,
	createGeneratedBinder,
	addToTray,
	binderLocation,
	deleteBinder,
	fillTray,
	isGenerated,
	isHex,
	isPokemonWant,
	leaveEmpty,
	liveBinders,
	openPockets,
	placeholdersFor,
	locate,
	getBinder,
	movePocket,
	moveWithShift,
	moveToTray,
	pageSlots,
	placeCard,
	placePlaceholder,
	placeStaged,
	placements,
	planResize,
	pocketsPerPage,
	removeFromBinder,
	reorderBinders,
	restoreBinder,
	saveListEdits,
	saveRefresh,
	setPocketPick,
	slotsOf,
	sortBinders,
	takeFromTray,
	trayCandidates,
	trayOf,
	undoShifted,
	unplaced,
	updateBinder,
	updateGeneratedBinder,
	validGrid,
} from './binders.js';

const PICK_PAGE = 60;
const LIST_PAGE = 120;

const link = (route, attrs, ...children) => h('a', {...attrs, 'data-link': route, href: BASE + route}, ...children);

const routeTo = (...parts) => parts.map((part) => encodeURIComponent(part)).join('/');

const gridText = (binder) => `${binder.rows} × ${binder.cols}`;

// Cover pictures no live binder uses are dropped from the phone once a page
// load, the first time the person's binders are read (js/binder-cover.js).
let coversSwept = false;

function sweepOnce(source) {
	if (!source.readOnly && !coversSwept) {
		coversSwept = true;
		sweepCovers().catch(() => {});
	}
}

// --------------------------------------------------------- whose binders

// The person's own binders, read from the phone.
const MINE = {
	base: 'binders',
	load: async () => {
		const doc = await loadDocument();

		return {binders: doc.binders || [], cards: doc.cards || [], doc, picks: doc.binder_picks || []};
	},
	readOnly: false,
	watch: (reload) => onChange(reload),
};

// A family member's binders, read from the server once per screen. Viewing
// them changes nothing on this phone.
function familySource(userId) {
	let docPromise = null;

	return {
		base: `family/${encodeURIComponent(userId)}/binders`,
		load: async () => {
			if (!currentUser()) {
				throw new Error('Sign in to see your family\'s binders.');
			}

			if (!navigator.onLine) {
				throw new Error('A family member\'s binders show when you are online.');
			}

			docPromise = docPromise || memberDocument(userId).catch((err) => {
				docPromise = null;

				throw err;
			});

			const doc = (await docPromise) || {};

			return {binders: doc.binders || [], cards: doc.cards || [], doc, picks: doc.binder_picks || []};
		},
		readOnly: true,
		userId,
		watch: null,
	};
}

function failure(err, readOnly) {
	return h('div', {class: 'notice', role: 'alert'}, h('p', null, readOnly
		? err.message || errorText(err)
		: `Your binders could not be read from this phone. ${errorText(err)}`));
}

// ------------------------------------------------------ names and images

// The localization to show: the viewing language when the card's catalog
// has it, then the copy's own language, then the catalog's base language.
function display(record, preferred) {
	const localizations = (record && record.localizations) || {};

	for (const lang of preferred) {
		if (lang && localizations[lang]) {
			return localizations[lang];
		}
	}

	return Object.values(localizations)[0] || null;
}

function cardRoute(local, catalog, cardId) {
	const lang = local && isLanguage(local.lang) ? local.lang : catalogLanguage(catalog);

	return routeTo('cards', lang, cardId);
}

// What a tile needs for one copy. Also the trades log's (js/moves-view.js).
export function entryInfo(entry, index, viewing) {
	const record = index.get(indexKey(entry.catalog, entry.card_id)) || null;
	const local = display(record, [catalogFor(viewing) === entry.catalog ? viewing : null, entry.language, catalogLanguage(entry.catalog)]);
	const source = sourceNames(entry, record);

	const info = {
		// The large image, for the card held up out of its pocket
		// (js/pocket-viewer.js).
		full: local ? cardImage(local.image, 'high') : null,
		image: local ? cardImage(local.image, 'low') : null,
		name: (source && source.name) || (local && local.name) || entry.name_local || entry.card_id,
		// A hand-made card's number is on the copy (js/custom-card.js).
		number: (record && record.collector_number) || entry.number_local || null,
		route: entry.catalog === 'custom' ? customRoute(entry.card_id, entry.language) : cardRoute(local, entry.catalog, entry.card_id),
		setName: (source && source.setName) || (local && local.set_name) || null,
	};
	// Folded on the first search, and kept once the English names are in.
	let search = null;

	Object.defineProperty(info, 'search', {get: () => search || entrySearch(entry, record, local, source, info, (text) => (search = text))});

	return info;
}

// Copies a picker shows as one tile: the same card in the same catalog,
// language, and finish. Condition and where a copy is stored do not part
// them here, as they do in Your copies (js/copy-sheet.js alikeKey).
const pickKey = (entry) => JSON.stringify([
	entry.catalog || 'international',
	entry.card_id,
	entry.language || null,
	entry.variant_id || null,
	entry.variant_id ? null : entry.finish_raw || null,
]);

// Picker items ({entry, info}) as tiles, {key, items}, in the order of each
// tile's first copy.
function groupPicks(items, keyOf = (item) => pickKey(item.entry)) {
	const groups = new Map();

	for (const item of items) {
		const key = keyOf(item);

		if (!groups.has(key)) {
			groups.set(key, {key, items: []});
		}

		groups.get(key).items.push(item);
	}

	return [...groups.values()];
}

// A picker's tile as the Filters sheet reads it (js/filter-bar.js), from
// the card index: what My Cards' tiles carry, but the price.
function pickFilterItem(group, index) {
	const {entry, info} = group.items[0];
	const catalog = entry.catalog || 'international';
	const record = index.get(indexKey(catalog, entry.card_id)) || null;
	const setId = (record && record.set_id) || setIdOfCard(entry.card_id);

	return {
		artist: (record && record.illustrator) || null,
		category: (record && record.category) || null,
		dexIds: (record && record.dex_ids) || [],
		group,
		key: group.key,
		language: entry.language || null,
		name: info.name,
		number: (record && record.collector_number) || info.number || null,
		rarity: (record && record.rarity) || null,
		releaseDate: (record && record.release_date) || '',
		setKey: setId ? `${catalog}|${setId}` : null,
		setName: info.setName || entry.set_name_local || null,
		types: (record && record.types) || [],
	};
}

// The tiles the sheet's choice leaves, in its sort. Tiles the sort ties
// keep the order they came in.
function filterPicks(groups, {filters, sort}, index) {
	const items = groups.map((group) => pickFilterItem(group, index));

	return sortItems(activeFilters(filters).length ? applyFilters(items, {filters}) : items, sort).map((item) => item.group);
}

// The binder pickers' sorts (Eric, 2026-11-06: his binders go by region,
// so Pokédex number first), and the last one picked, on this phone only.
const PICK_SORTS = ['dex', 'setOld', 'name'];
const PICK_SORT_KEY = 'cardTracker.binderPickerSort';

function savedPickSort() {
	try {
		const saved = localStorage.getItem(PICK_SORT_KEY);

		return PICK_SORTS.includes(saved) ? saved : PICK_SORTS[0];
	}
	catch {
		return PICK_SORTS[0];
	}
}

function savePickSort(sort) {
	try {
		localStorage.setItem(PICK_SORT_KEY, sort);
	}
	catch {
		// The order lasts while the picker is open.
	}
}

// The filters a picker offers: all My Cards has but the price (a picker
// reads no prices), where the copies are stored (From does that), and the
// checkboxes. The tray picker keeps its own set list beside Select all.
const PICK_FILTERS = ['region', 'dex', 'type', 'category', 'set', 'language', 'rarity', 'artist'];
const TRAY_FILTERS = PICK_FILTERS.filter((kind) => kind !== 'set');

// A mouse or trackpad: a picker's search can take the focus as it opens
// without raising a keyboard over the list, as it would on a phone.
const finePointer = () => typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;

const copiesIn = (groups) => groups.reduce((sum, group) => sum + group.items.length, 0);

// Every text a picker finds a copy by, as My Cards does (js/cards-view.js):
// its English name, original name, reading, names in each language, set,
// number, and ID.
function entrySearch(entry, record, local, source, info, keep) {
	const tables = loadedSpeciesNames(null);
	const names = namesFor({
		category: (record && record.category) || null,
		dexId: (record && record.dex_ids) || null,
		lang: source ? entry.language : (local && local.lang) || catalogLanguage(entry.catalog),
		name: info.name,
	}, null);
	const texts = [names.english, names.original, names.reading, info.name, info.setName, info.number, entry.card_id];

	for (const localization of Object.values((record && record.localizations) || {})) {
		texts.push(localization.name, localization.set_name);
	}

	const text = searchTextOf(texts);

	if (tables) {
		keep(text);
	}

	return text;
}

// What a tile needs for a placeholder: the card index when this phone has
// the card, else the name and image saved with the placeholder.
function wantInfo(want, index, viewing) {
	const catalog = want.catalog || 'international';
	const record = index.get(indexKey(catalog, want.card_id)) || null;
	const local = display(record, [catalogFor(viewing) === catalog ? viewing : null, catalogLanguage(catalog)]);

	return {
		image: cardImage((local && local.image) || want.image, 'low'),
		name: (local && local.name) || want.name || want.card_id,
		number: record && record.collector_number,
		route: cardRoute(local, catalog, want.card_id),
		setName: (local && local.set_name) || null,
	};
}

// The card a placeholder (or a Gone pocket) stands for, with no copy: its
// photos and pin come from the card's record, kept at zero copies
// (js/card-info.js recordsForCard).
const cardTarget = (item) => ({catalog: item.catalog || 'international', card_id: item.card_id, language: item.language || null});

// Card art with its main image, as My Cards picks it (js/photos/index.js):
// the official image, the international twin, or the person's photo, the
// pin winning, else the card back. draw(src) makes the element holding the
// art (tileArt, or an .art-wrap); a photo that arrives later is drawn as
// cardArt in its place. records: a family member's card records on their
// binder, whose photos it shows; null for the person's own.
export function artOf(target, info, draw, records = null) {
	const options = records ? {family: false, records} : {};

	return mainArt(target, info.image, draw, (src) => cardArt(info, src), options);
}

export function recordFrom(catalog, lang, card) {
	const set = card.set || {};

	return {
		catalog,
		collector_number: card.localId,
		id: card.id,
		localizations: {[lang]: {image: card.image || null, lang, name: card.name, set_name: set.name || null}},
		set_id: set.id,
	};
}

// Reads the catalog records the visible tiles have none for, four at a
// time, cache first. Returns the new index, or null when nothing was added.
export async function fillRecords(items, index, isAlive) {
	const missing = new Map();

	for (const {catalog, cardId} of items) {
		const key = indexKey(catalog, cardId);

		// A hand-made card (catalog "custom") has no record to read.
		if (cardId && !index.has(key) && catalog !== 'custom') {
			missing.set(key, {catalog, cardId});
		}
	}

	if (!missing.size || !navigator.onLine) {
		return null;
	}

	const queue = [...missing.values()];
	const records = [];

	const worker = async () => {
		while (queue.length && isAlive()) {
			const {catalog, cardId} = queue.shift();
			const lang = catalogLanguage(catalog);

			try {
				const card = await importApi.cardDetail(lang, cardId);

				if (card && card.set) {
					records.push(recordFrom(catalog, lang, card));
				}
			}
			catch {
				// The tile keeps its card-back with the name.
			}
		}
	};

	await Promise.all([worker(), worker(), worker(), worker()]);

	return records.length && isAlive() ? saveToCardIndex(records) : null;
}

// ---------------------------------------------------------- the form

// What a change of size does to a binder's pockets (planResize in
// js/binders.js), in sentences, for the form and the preview sheet.
function resizeLines(binder, plan) {
	const lines = [];
	const out = plan.toTray.length;
	const gone = [
		plan.dropped.wants ? plural(plan.dropped.wants, 'placeholder', 'placeholders') : null,
		plan.dropped.empties ? plural(plan.dropped.empties, 'pocket left empty on purpose', 'pockets left empty on purpose') : null,
	].filter(Boolean);

	if (plan.how === 'grow') {
		lines.push('Every card keeps its row and column; the new pockets are empty.');
	}
	else if (plan.how === 'keep') {
		lines.push('Every card still fits at its row and column, so only the empty edge goes.');
	}
	else if (plan.how === 'reflow') {
		lines.push('Some cards would not fit where they are, so the binder is laid out again in reading order: empty pockets close up, and placeholders and pockets left empty on purpose move with the cards.');
	}
	else if (plan.how === 'tray') {
		lines.push(`Every pocket is emptied, and ${out ? `${plural(out, 'card goes', 'cards go')} to the tray to place by hand` : 'the tray keeps what it has'}.`);
	}

	if (plan.added) {
		lines.push(`This binder grows from ${formatCount(binder.page_count)} to ${plural(plan.page_count, 'page', 'pages')}, so nothing falls out.`);
	}

	if (out && plan.how !== 'tray') {
		lines.push(`${plural(out, 'card does', 'cards do')} not fit and ${out === 1 ? 'goes' : 'go'} to the tray.`);
	}

	if (gone.length) {
		lines.push(`${gone.join(' and ')} ${plan.dropped.wants + plan.dropped.empties === 1 ? 'is' : 'are'} removed.`);
	}

	if (plan.dropped.art) {
		lines.push('Michi art is cleared, since it was cut for the old grid.');
	}

	return lines;
}

// A resize the person should see before it is saved: one that moves,
// removes, or sends something to the tray.
const resizeMatters = (binder, plan) => slotsOf(binder).length > 0
	&& (plan.reshaped || plan.toTray.length > 0 || plan.dropped.wants + plan.dropped.empties + plan.dropped.art > 0);

// Name, notes, cover color, grid, and pages, for a new binder or an edit.
// onSubmit(fields) saves; it may throw a message to show, or return false
// to leave the form open with nothing saved. placed is placements() of
// every binder, for the resize summary.
// rule: a binder made from a list (js/binder-rule-view.js ruleSection) puts
// its section, which chooses the cards, the order, and the pocket size, in
// place of the grid and pages, and onSubmit gets (fields, section).
function binderForm({binder = null, onCancel, onSubmit, placed = undefined, rule = null, title = null}) {
	const start = binder || {cols: 3, cover_color: DEFAULT_COVER, name: '', notes: '', page_count: 40, rows: 3};
	const swatchColors = COVER_SWATCHES.map((swatch) => swatch.color);
	const name = h('input', {autocomplete: 'off', class: 'search', id: 'binder-name', maxlength: 80, type: 'text', value: start.name});
	const notes = h('textarea', {class: 'search binder-notes-input', id: 'binder-notes', maxlength: 500, rows: 2});
	const custom = h('input', {'aria-label': 'Custom cover color', id: 'binder-cover-custom', type: 'color', value: start.cover_color});
	const customRadio = h('input', {'aria-label': 'Custom color', name: 'binder-cover', type: 'radio', value: 'custom'});
	const rowsSelect = h('select', {'aria-label': 'Rows', id: 'binder-rows'}, [1, 2, 3, 4, 5].map((n) => h('option', {value: n}, `${n} ${n === 1 ? 'row' : 'rows'}`)));
	const colsSelect = h('select', {'aria-label': 'Columns', id: 'binder-cols'}, [1, 2, 3, 4, 5].map((n) => h('option', {value: n}, `${n} ${n === 1 ? 'column' : 'columns'}`)));
	const pages = h('input', {class: 'search', id: 'binder-pages', inputmode: 'numeric', max: MAX_PAGES, min: 1, type: 'number', value: start.page_count});
	const gridNote = h('p', {'aria-live': 'polite', class: 'muted', id: 'binder-grid-note'});
	const warning = h('p', {'aria-live': 'polite', class: 'form-error', id: 'binder-resize-warning'});
	const message = h('p', {'aria-live': 'polite', class: 'form-error', id: 'binder-form-error'});
	const save = h('button', {class: 'primary', id: 'binder-save', type: 'submit'}, binder ? 'Save changes' : 'Create binder');

	notes.value = start.notes || '';
	rowsSelect.value = String(start.rows);
	colsSelect.value = String(start.cols);

	const swatches = h('div', {class: 'cover-swatches', role: 'radiogroup', 'aria-label': 'Cover color'},
		COVER_SWATCHES.map(({color, name: label}) => h('label', {class: 'cover-swatch', title: label},
			h('input', {'aria-label': label, checked: color === start.cover_color, name: 'binder-cover', type: 'radio', value: color}),
			h('span', {'aria-hidden': 'true', class: 'swatch-dot', style: `background: ${color}`})
		)),
		h('label', {class: 'cover-swatch custom', title: 'Custom color'}, customRadio, custom)
	);

	if (!swatchColors.includes(start.cover_color)) {
		customRadio.checked = true;
	}

	custom.addEventListener('input', () => {
		customRadio.checked = true;
	});

	// A size fills in the grid and pages. Custom keeps what the form has and
	// stays marked until the person changes a field (check() then marks the
	// size that matches, if any).
	const presets = presetPicker({
		onPick: (picked) => {
			if (!picked.rows) {
				rowsSelect.focus();

				return;
			}

			rowsSelect.value = String(picked.rows);
			colsSelect.value = String(picked.cols);
			pages.value = String(picked.page_count);
			check();
		},
		value: presetFor(start),
	});

	const picks = h('div', {class: 'grid-picks'}, GRID_PICKS.map(([rows, cols]) => h('button', {
		class: 'small grid-pick',
		'data-grid': `${rows}x${cols}`,
		onclick: () => {
			rowsSelect.value = String(rows);
			colsSelect.value = String(cols);
			check();
		},
		type: 'button',
	}, `${rows} × ${cols}`)));

	const coverColor = () => {
		const picked = swatches.querySelector('input[name="binder-cover"]:checked');

		return !picked || picked.value === 'custom' ? custom.value : picked.value;
	};

	const fields = () => (rule
		? {
			...rule.fields(),
			cover_color: coverColor(),
			// A binder left unnamed takes its list's name.
			name: name.value.trim() || rule.nameHint(),
			notes: notes.value,
		}
		: {
			cols: Number(colsSelect.value),
			cover_color: coverColor(),
			name: name.value,
			notes: notes.value,
			page_count: Number(pages.value),
			preset: presetFor({cols: colsSelect.value, page_count: pages.value, rows: rowsSelect.value}),
			rows: Number(rowsSelect.value),
		});

	function check() {
		if (rule) {
			return;
		}

		const {cols, page_count: pageCount, rows} = fields();
		const ok = validGrid(rows, cols);

		presets.set({cols, page_count: pageCount, rows});

		for (const pick of picks.children) {
			pick.setAttribute('aria-pressed', String(pick.dataset.grid === `${rows}x${cols}`));
		}

		gridNote.textContent = ok
			? `${rows * cols} pockets a page.`
			: 'Grids run up to 5 × 4 or 4 × 5.';
		gridNote.className = ok ? 'muted' : 'form-error';
		warning.textContent = '';
		warning.className = 'muted';

		if (binder && ok && Number.isInteger(pageCount) && pageCount >= 1 && pageCount <= MAX_PAGES) {
			const plan = planResize(binder, {cols, page_count: pageCount, rows}, {placed});

			if (resizeMatters(binder, plan)) {
				warning.textContent = resizeLines(binder, plan).join(' ');
				warning.className = plan.toTray.length || plan.dropped.wants || plan.dropped.empties ? 'form-error' : 'muted';
			}
		}
	}

	rowsSelect.addEventListener('change', check);
	colsSelect.addEventListener('change', check);
	pages.addEventListener('input', check);

	const form = h('form', {class: 'card binder-form', id: 'binder-form'},
		h('h3', null, title || (binder ? 'Edit binder' : 'New binder')),
		h('label', {for: 'binder-name'}, 'Name'),
		name,
		h('label', {for: 'binder-notes'}, 'Notes'),
		notes,
		h('span', {class: 'field-label'}, 'Cover color'),
		swatches,
		...(rule
			? [rule.element]
			: [
				h('span', {class: 'field-label'}, 'Size'),
				presets.element,
				h('span', {class: 'field-label'}, 'Grid'),
				picks,
				h('div', {class: 'toolbar two grid-steppers'}, h('span', {class: 'select-wrap'}, rowsSelect), h('span', {class: 'select-wrap'}, colsSelect)),
				gridNote,
				h('label', {for: 'binder-pages'}, 'Pages'),
				pages,
				warning,
			]),
		message,
		h('div', {class: 'button-row'},
			h('button', {id: 'binder-cancel', onclick: onCancel, type: 'button'}, 'Cancel'),
			save
		)
	);

	form.addEventListener('submit', async (event) => {
		event.preventDefault();
		message.textContent = '';

		let clean;

		try {
			clean = cleanFields(fields());

			if (rule) {
				rule.rule();
			}
		}
		catch (err) {
			message.textContent = err.message;

			return;
		}

		save.disabled = true;

		try {
			if (await onSubmit(clean, rule) === false) {
				save.disabled = false;
			}
		}
		catch (err) {
			message.textContent = `Could not save the binder. ${err.message || errorText(err)}`;
			save.disabled = false;
		}
	});

	check();

	return form;
}

// ------------------------------------------------- binders from a list
//
// js/binder-rules.js keeps the rule and works out the layout;
// js/binder-sources.js reads the cards; js/binder-rule-view.js is the form.

const itemCopies = (items) => items.flatMap((item) => item.copies);

// What a refresh of binderLike ({rows, cols, rule, snapshot, page_count})
// with the loaded items would save, the defaults ranked by value:
// {plan, rankOf}. For a checklist with languages, the plan also says
// whether it differs from the stored layout only by those languages
// (languageOnly), ranked over every copy as a v56 phone ranks them.
async function planLayout(binderLike, loaded, {liveIds = null, picks = new Map()} = {}) {
	const rankOf = await rankerFor(itemCopies(loaded.anyItems || loaded.items));
	const plan = planRefresh(binderLike, loaded.items, {anyItems: loaded.anyItems, at: nowIso(), languages: loaded.languages, liveIds, partial: loaded.partial, picks, rankOf});

	return {plan, rankOf};
}

// The form for a new binder made from a list: the binder form with the
// list section. start: {kind, id} to preselect a list.
async function listForm({onCancel, start = {}}) {
	const [doc, index] = await Promise.all([loadDocument(), cardIndex()]);

	return binderForm({
		onCancel,
		onSubmit: async (fields, section) => {
			const loaded = await section.ready();

			if (loaded.gone) {
				throw new Error('That list was deleted. Choose another.');
			}

			const rule = section.rule();
			const {plan} = await planLayout({cols: fields.cols, rows: fields.rows, rule}, loaded);
			const binder = await createGeneratedBinder(fields, rule, plan.snapshot, {languages: plan.languages});

			go(`binders/${encodeURIComponent(binder.id)}`);
		},
		rule: ruleSection({doc, index, start}),
		title: 'New binder from a list',
	});
}

// Filled pockets of a list's binder, from its last layout: {filled, total}.
function listStats(binder, picksList, liveIds) {
	const snapshot = binder.snapshot || {};
	// An empty key is a pocket left empty on purpose, not a pocket of the
	// list (js/binder-rules.js list_edits gap).
	const keys = Array.isArray(snapshot.keys) ? snapshot.keys.filter(Boolean) : [];
	const shown = snapshot.shown || {};
	const picks = picksOf(picksList, binder.id);
	const filled = keys.filter((key) => (picks.has(key) && liveIds.has(picks.get(key))) || (shown[key] && liveIds.has(shown[key]))).length;

	return {filled, total: keys.length};
}

// binders/new/<kind>/<id>: a new binder from a checklist, collection, or
// goal, the "Make a binder" button on those screens.
export function newFromListView(root, {id = null, kind = null} = {}) {
	let alive = true;
	const holder = h('div', {id: 'binder-editor'});

	root.append(
		link('binders', {class: 'back'}, '‹ Binders'),
		h('div', {class: 'view-head'}, h('h2', null, 'New binder')),
		holder
	);

	listForm({onCancel: () => go('binders'), start: {id, kind}})
		.then((form) => {
			if (alive) {
				holder.replaceChildren(form);
			}
		})
		.catch((err) => holder.replaceChildren(failure(err, false)));

	return () => {
		alive = false;
	};
}

// ------------------------------------------------------ the binder list

export const bindersListView = (root) => bindersScreen(root, MINE);

export const familyBindersView = (root, {userId}) => bindersScreen(root, familySource(userId));

function cover(binder, stats, base) {
	const fromList = isGenerated(binder);
	// A family member's colour comes from their document: only a hex colour
	// reaches the style attribute.
	const color = isHex(binder.cover_color) ? binder.cover_color : DEFAULT_COVER;
	const node = link(`${base}/${encodeURIComponent(binder.id)}`, {
		class: 'binder-cover',
		'data-binder': binder.id,
		style: `--cover: ${color}; --cover-text: ${coverTextColor(color)}`,
	},
	h('span', {class: 'binder-name'}, binder.name),
	binder.notes ? h('span', {class: 'binder-notes'}, binder.notes) : null,
	fromList ? h('span', {class: 'binder-from'}, 'From a list') : null,
	h('span', {class: 'binder-foot'},
		h('span', null, `${gridText(binder)} · ${plural(binder.page_count, 'page', 'pages')}`),
		h('span', {'aria-label': `${stats.filled} of ${stats.total} pockets filled`, class: 'binder-fill'}, `${formatCount(stats.filled)} / ${formatCount(stats.total)}`)
	));

	paintCover(node, binder).catch(() => {
		// The cover color shows instead.
	});

	return node;
}

function bindersScreen(root, source) {
	let alive = true;

	const body = h('div', {id: 'binders-body'});
	const editor = h('div', {id: 'binder-editor'});
	const newButton = source.readOnly ? null : h('button', {class: 'primary', id: 'new-binder', type: 'button'}, 'New binder');
	// Edit order (js/reorder.js): the binders as rows to drag or move, in
	// place of the shelf while it is open.
	const order = source.readOnly ? null : orderSection({
		describe: (binder) => ({detail: `${gridText(binder)} · ${plural(binder.page_count, 'page', 'pages')}`, name: binder.name}),
		errorText,
		label: 'Binders',
		onToggle: (open) => {
			body.hidden = open;
			newButton.hidden = open;
			editor.hidden = open;
		},
		save: reorderBinders,
		toast,
	});

	if (order) {
		order.button.id = 'binders-order';
		order.panel.id = 'binders-order-panel';
	}

	const heading = h('div', {class: 'view-head'}, h('h2', null, 'Binders'), order ? order.button : null);
	// Fill placeholders in every hand-made binder (js/fill-view.js).
	const fill = source.readOnly ? null : fillPanel();
	let name = 'Family member';
	// The binders shown, by id, for repainting their covers.
	let shelf = new Map();

	if (source.readOnly) {
		heading.querySelector('h2').textContent = `${name}'s binders`;
		whenMemberName(source.userId, (memberLabel) => {
			name = memberLabel;
			heading.querySelector('h2').textContent = `${memberLabel}'s binders`;
			document.title = `${memberLabel}'s binders | Card Tracker`;
		});
	}

	// New binder: an empty one to fill by hand, or one made from a list
	// (js/binder-rules.js).
	function openForm() {
		const close = () => {
			editor.replaceChildren();
			newButton.hidden = false;
		};
		const holder = h('div', {id: 'new-binder-form'});
		const kinds = h('div', {'aria-label': 'Kind of binder', class: 'segmented new-binder-kind', id: 'new-binder-kind', role: 'radiogroup'},
			h('label', null, h('input', {checked: true, id: 'new-binder-empty', name: 'new-binder-kind', type: 'radio', value: 'empty'}), h('span', null, 'Empty binder')),
			h('label', null, h('input', {id: 'new-binder-list', name: 'new-binder-kind', type: 'radio', value: 'list'}), h('span', null, 'From a list'))
		);
		let asked = 0;

		const show = async (kind) => {
			const ticket = ++asked;
			const form = kind === 'list'
				? await listForm({onCancel: close}).catch((err) => failure(err, false))
				: binderForm({
					onCancel: close,
					onSubmit: async (fields) => {
						const binder = await createBinder(fields);

						go(`binders/${encodeURIComponent(binder.id)}`);
					},
				});

			if (ticket === asked && alive) {
				holder.replaceChildren(form);

				const field = holder.querySelector('#binder-name');

				if (field && kind !== 'list') {
					field.focus();
				}
			}
		};

		kinds.addEventListener('change', () => show(kinds.querySelector('input:checked').value));
		newButton.hidden = true;
		editor.replaceChildren(kinds, holder);
		show('empty');
	}

	if (newButton) {
		newButton.addEventListener('click', openForm);
	}

	async function load() {
		let data;

		try {
			data = await source.load();
		}
		catch (err) {
			body.replaceChildren(failure(err, source.readOnly));

			return;
		}

		if (!alive) {
			return;
		}

		const binders = sortBinders(data.binders);
		const live = data.cards.filter(isLive);

		if (order) {
			order.set(binders);
		}

		shelf = new Map(binders.map((binder) => [binder.id, binder]));
		sweepOnce(source);
		const liveIds = new Set(live.map((entry) => entry.id));
		const placed = placements(data.binders);
		const loose = unplaced(live, data.binders).length;
		const unplacedLink = source.readOnly || !live.length
			? null
			: link('binders/unplaced', {class: 'unplaced-link', id: 'unplaced-link'}, `${plural(loose, 'owned card', 'owned cards')} not in any binder`);

		if (!binders.length) {
			body.replaceChildren(h('div', {class: 'card empty-state'},
				h('p', {class: 'big'}, source.readOnly ? `${name} hasn't set up binders yet.` : 'No binders yet.'),
				source.readOnly ? null : h('p', {class: 'muted'}, 'Add one for each real binder: its grid, its pages, and its cover color, so it is easy to match. Then place your cards pocket by pocket.'),
				// No cards yet either: scanning is the way to get some.
				source.readOnly || live.length ? null : h('a', {class: 'button', 'data-link': 'scan', href: `${BASE}scan`, id: 'binders-empty-scan'}, 'Scan your first card')
			), unplacedLink || '');

			return;
		}

		let wanted = 0;
		const covers = binders.map((binder) => {
			const stats = isGenerated(binder) ? listStats(binder, data.picks, liveIds) : binderStats(binder, placed, liveIds);

			wanted += isGenerated(binder) ? 0 : stats.wanted;

			return cover(binder, stats, source.base);
		});

		body.replaceChildren(
			h('div', {class: 'binder-shelf'}, covers),
			unplacedLink || ''
		);

		if (fill) {
			fill.show(wanted);
		}
	}

	const stop = source.watch ? source.watch(() => alive && load()) : () => {};

	// A cover picture that arrives later (uploaded, or back in reach once
	// online) is painted on the covers still showing their color.
	const stopCovers = onCoversChange(() => {
		if (!alive) {
			return;
		}

		for (const node of body.querySelectorAll('.binder-cover:not([data-cover-image])')) {
			const binder = shelf.get(node.dataset.binder);

			if (binder) {
				paintCover(node, binder).catch(() => {});
			}
		}
	});

	root.append(...[heading, body, order ? order.panel : null, fill ? h('div', {class: 'actions fill-row'}, fill.button) : null, fill ? fill.box : null, newButton, editor].filter(Boolean));
	load();

	return () => {
		alive = false;
		stop();
		stopCovers();
	};
}

// ------------------------------------------------------- one binder

export const binderView = (root, {id, page}) => binderScreen(root, MINE, id, page);

export const familyBinderView = (root, {id, page, userId}) => binderScreen(root, familySource(userId), id, page);

function binderScreen(root, source, id, pageParam) {
	let alive = true;
	let binder = null;
	let data = null;
	let index = new Map();
	// The route's page (binders/<id>/<page>, the links card detail makes):
	// js/binder-spread.js opens on the spread holding it, then keeps its
	// place in the URL's search part.
	const routePage = Number.parseInt(pageParam, 10) || null;
	let placed = new Map();
	let entriesById = new Map();
	let spread = null;
	let slotCache = new Map();
	// A binder made from a list (js/binder-rules.js): its hand picks, and
	// what the last read of its list found (items by key, the ranking of
	// copies), so pockets show their copies and counts; null items until
	// then, when the pockets show the last layout.
	let listMode = false;
	let picks = new Map();
	const gen = {busy: null, gone: false, held: null, items: null, loaded: null, names: null, partial: false, rankOf: undefined, started: false};
	const refreshButton = source.readOnly ? null : h('button', {hidden: true, id: 'binder-refresh', onclick: () => refreshList({force: true, manual: true}), type: 'button'}, 'Refresh');
	const listNote = h('p', {'aria-live': 'polite', class: 'binder-list-note', hidden: true, id: 'binder-list-note'});
	// Closes the resize preview, if it is open (leaving the screen).
	let closeResize = () => {};
	// The tray (see "the tray" below): the copy picked to place next, the
	// tray position to pick from after a placement lands, and its parts.
	let picked = null;
	let advanceFrom = null;
	let trayClickBlock = 0;
	let trayNoteTimer = null;
	const trayStrip = h('div', {'aria-label': 'Cards to place', class: 'bt-strip', id: 'bt-strip', role: 'list'});
	const trayStatus = h('p', {'aria-live': 'polite', class: 'bt-status', id: 'bt-status'});
	const trayFill = h('button', {class: 'small bt-fill', id: 'bt-fill', type: 'button'}, 'Fill the rest in order');
	const tray = source.readOnly ? null : h('section', {'aria-label': 'Tray: cards to place in this binder', class: 'bt', hidden: true, id: 'binder-tray'},
		trayStrip,
		h('div', {class: 'bt-foot'}, trayStatus, h('span', {'aria-hidden': 'true', class: 'bt-gap'}), trayFill));
	const trayNote = h('p', {'aria-live': 'polite', class: 'bt-note', hidden: true, id: 'bt-note'});
	// A card in hand, brought from its page (js/binder-hand.js): the bar at
	// the bottom, and a tap on an empty pocket places one copy of it (see
	// "the card in hand" below).
	let hand = source.readOnly ? null : takeHand(id);
	const handArt = h('div', {class: 'bh-art', id: 'bh-art'});
	const handName = h('p', {class: 'bh-name', id: 'bh-name'});
	const handStatus = h('p', {'aria-live': 'polite', class: 'bh-status', id: 'bh-status'});
	const handWaitText = h('span', {id: 'bh-wait-text'});
	const handWaitButton = h('button', {class: 'small', id: 'bh-wait-place', type: 'button'}, 'Place it there');
	const handWait = h('p', {class: 'bh-wait', hidden: true, id: 'bh-wait'}, handWaitText, ' ', handWaitButton);
	const handNext = h('button', {class: 'small', id: 'bh-next', type: 'button'}, 'Next free pocket');
	const handTray = h('button', {class: 'small', id: 'bh-tray', type: 'button'}, 'Keep in tray');
	const handCancel = h('button', {class: 'small', id: 'bh-cancel', type: 'button'}, 'Cancel');
	const handBar = source.readOnly ? null : h('section', {'aria-label': 'Card in hand', class: 'bh', hidden: true, id: 'binder-hand'},
		h('div', {class: 'bh-top'}, handArt, h('div', {class: 'bh-text'}, handName, handStatus)),
		handWait,
		h('div', {class: 'bh-actions'}, handNext, handTray, handCancel));

	const viewing = viewingLanguage();
	const back = link(source.base, {class: 'back'}, '‹ Binders');
	const title = h('h2', {id: 'binder-title'}, 'Binder');
	const meta = h('p', {class: 'muted', id: 'binder-meta'});
	const notes = h('p', {class: 'binder-notes-text', id: 'binder-notes-text', hidden: true});
	const spreadHolder = h('div', {id: 'binder-spread-holder'});
	const summary = h('p', {'aria-live': 'polite', class: 'muted', id: 'binder-summary'});
	const leftOut = h('p', {class: 'muted binder-left-out', hidden: true, id: 'binder-left-out'});
	// The value of the copies in the binder: a line under its name with the
	// total, a button that reads as text and opens the sheet (js/value-sheet.js;
	// Eric, 2026-11-06), never a box.
	const statsSlot = h('div', {class: 'binder-stats', id: 'binder-stats'});
	let statsEntries = [];
	// The total, read after the pages draw; a later read wins (showTotal).
	// Pockets and Liga prices change through draw; a rate the sheet read, on
	// its close; prices saved by another screen, on coming back to this one.
	const drawValue = () => {
		if (alive && statsEntries.length) {
			showTotal(valueOpen, statsEntries, {index}).catch(() => {});
		}
	};
	const valueOpen = valueButton({entries: () => statsEntries, id: 'binder-value', label: () => (binder ? binder.name : 'this binder'), onClose: drawValue});

	valueOpen.className = 'value-open value-line';
	const onVisible = () => document.visibilityState === 'visible' && drawValue();
	const unplacedLink = source.readOnly ? null : link('binders/unplaced', {class: 'unplaced-link', id: 'unplaced-link'}, 'Owned cards not in any binder');
	// Many cards into the tray at once; a binder made from a list has none.
	const addTrayButton = source.readOnly ? null : h('button', {id: 'binder-add-tray', onclick: () => openTrayPicker(), type: 'button'}, 'Add cards to the tray');
	// Fill this binder's placeholders with cards you own (js/fill-view.js).
	const fill = source.readOnly ? null : fillPanel({binderId: id});
	// A checklist's Pokémon as placeholders (openLayout); hand-made only.
	const layoutButton = source.readOnly ? null : h('button', {id: 'binder-layout-list', onclick: () => openLayout(), type: 'button'}, 'Lay out from a list');
	const editor = h('div', {id: 'binder-editor'});
	const body = h('div', {id: 'binder-body'});
	const sheet = source.readOnly ? null : h('dialog', {'aria-labelledby': 'sheet-title', class: 'pocket-sheet', id: 'pocket-sheet'});
	// An empty binder offers the scanner, where new cards come from. Its
	// words follow the spread (drawSummary): held upright, a page is tapped
	// open before its pockets take a tap.
	const emptyText = h('p', {id: 'binder-empty-text'});
	const emptyHint = source.readOnly ? null : h('div', {class: 'card empty-state binder-empty', hidden: true, id: 'binder-empty'},
		emptyText,
		h('a', {class: 'button', 'data-link': 'scan', href: `${BASE}scan`, id: 'binder-empty-scan'}, 'Scan cards')
	);

	// A picker's Filters and sort (js/filter-bar.js): one bar at a time, its
	// sheet removed when the picker closes or gives way to another. A sort
	// picked is kept for the next picker (savedPickSort); the filters are not.
	let pickerBars = [];

	function dropPickerBars() {
		for (const bar of pickerBars) {
			bar.destroy();
		}

		pickerBars = [];
	}

	function pickerBar({onChange = () => {}, ...options}) {
		dropPickerBars();

		const bar = filterBar({
			onChange: (state, reason) => {
				if (reason === 'sort') {
					savePickSort(state.sort);
				}

				onChange(state, reason);
			},
			placeholder: 'Search your cards',
			search: false,
			sort: savedPickSort(),
			// Under the tray's set list, a bare "Set" reads as a second set filter.
			sortPrefix: 'Sort: ',
			sorts: PICK_SORTS,
			storageKey: null,
			...options,
		});

		pickerBars.push(bar);

		return bar;
	}

	// A tap on the backdrop closes the sheet, as Escape does.
	if (sheet) {
		sheet.addEventListener('click', (event) => {
			if (event.target === sheet) {
				closeSheet();
			}
		});
		sheet.addEventListener('close', dropPickerBars);
	}

	// A family member's card records on their binder, so its pockets show
	// their photos and pin; null for the person's own (artOf).
	const recordsShown = () => (source.readOnly ? (data && data.doc && data.doc.card_info) || [] : null);

	// One pocket's content, as a tile.
	function pocketContent(slot) {
		if (!slot) {
			return {kind: 'open', label: 'Empty', node: h('span', {'aria-hidden': 'true', class: 'pocket-plus'}, source.readOnly ? '' : '+')};
		}

		if (slot.entry_id) {
			const entry = entriesById.get(slot.entry_id);

			if (entry && isLive(entry)) {
				const info = entryInfo(entry, index, viewing);
				// One physical copy per pocket: its flag and finish, never a
				// count (js/tile.js).
				const frame = artOf(entry, info, (src) => tileArt({finish: entryFinish(entry), info, languages: [entry.language], src, viewing}), recordsShown());

				return {info, kind: 'card', label: `${info.name}, ${languageLabel(entry.language)}`, node: frame};
			}

			// A copy deleted or traded away since it was placed leaves a
			// placeholder of its card, not a hole.
			const info = entry ? entryInfo(entry, index, viewing) : {image: null, name: 'A card no longer owned', number: null, setName: null};

			return {
				info,
				kind: 'gone',
				label: `${info.name}, no longer owned`,
				node: entry
					? artOf(cardTarget(entry), info, (src) => h('div', {class: 'art-wrap'}, cardArt(info, src), h('span', {class: 'pocket-tag'}, 'Gone')), recordsShown())
					: h('div', {class: 'art-wrap'}, cardArt(info, info.image), h('span', {class: 'pocket-tag'}, 'Gone')),
			};
		}

		// A Pokémon's placeholder, laid out from a list
		// (js/binder-layout.js): its picture and name, and no card to open.
		if (isPokemonWant(slot.want)) {
			const info = {image: spriteUrl(slot.want.dex), name: slot.want.name || `Pokémon ${dexLabel(slot.want.dex)}`, number: dexLabel(slot.want.dex), route: null, setName: null};

			return {
				info,
				item: 'pokemon',
				kind: 'want',
				label: `${dexLabel(slot.want.dex)} ${info.name}, placeholder for a Pokémon not owned`,
				node: h('div', {class: 'art-wrap'}, cardArt(info, info.image), h('span', {class: 'pocket-tag'}, 'Want')),
			};
		}

		if (slot.want) {
			const info = wantInfo(slot.want, index, viewing);

			return {
				info,
				kind: 'want',
				label: `${info.name}, placeholder for a card not owned`,
				node: artOf(cardTarget(slot.want), info, (src) => h('div', {class: 'art-wrap'}, cardArt(info, src), h('span', {class: 'pocket-tag'}, 'Want')), recordsShown()),
			};
		}

		if (slot.art) {
			return {kind: 'art', label: 'Michi art', node: h('span', {class: 'pocket-text'}, 'Art')};
		}

		return {kind: 'empty', label: 'Left empty on purpose', node: h('span', {class: 'pocket-text'}, 'Empty')};
	}

	function slotsOn(pg) {
		if (!slotCache.has(pg)) {
			slotCache.set(pg, pageSlots(binder, pg, placed));
		}

		return slotCache.get(pg);
	}

	// One pocket, for js/binder-spread.js: a button that opens the picker
	// sheet, or read only, a link to an owned card.
	function pocketElement(pg, position) {
		if (listMode) {
			return listPocket(pg, position);
		}

		const content = pocketContent(slotsOn(pg).get(position) || null);
		const attrs = {
			'aria-label': `Page ${pg}, pocket ${position}: ${content.label}`,
			class: `pocket pocket-${content.kind}`,
			'data-item': content.item || null,
			'data-kind': content.kind,
			'data-page': pg,
			'data-position': position,
		};

		if (!source.readOnly) {
			// With a card in hand, a tap places it there; with a tray card
			// picked, a tap places that. Otherwise a card you own comes out
			// of its pocket (viewPocket), and any other pocket opens the
			// picker sheet.
			return h('button', {...attrs, onclick: (event) => {
				if (hand) {
					handAt(pg, position);
				}
				else if (picked) {
					placeFromTrayAt(picked, pg, position);
				}
				else if (content.kind === 'card') {
					viewPocket(pg, position, event.currentTarget);
				}
				else {
					openSheet(pg, position);
				}
			}, type: 'button'}, content.node);
		}

		// Read only, a card comes out of its pocket too, with Card page.
		if (content.kind === 'card') {
			return h('button', {...attrs, onclick: (event) => viewPocket(pg, position, event.currentTarget), type: 'button'}, content.node);
		}

		return h('div', attrs, content.node);
	}

	function drawPage() {
		slotCache = new Map();

		if (!spread) {
			spread = binderSpread({
				base: BASE,
				binder,
				onChange: drawSummary,
				page: routePage,
				path: `${source.base}/${encodeURIComponent(id)}`,
				readOnly: source.readOnly,
				renderPocket: pocketElement,
			});
			spreadHolder.replaceChildren(...[spread.element, tray, tray && trayNote, handBar].filter(Boolean));

			// Long press a card or placeholder, then drag it to another
			// pocket. Binders made from a list fill themselves, so not there.
			if (!source.readOnly) {
				const shown = spread;

				pocketDrag(shown.element, {
					canLift: (pocket) => !listMode && pocketsLive() && ['card', 'gone', 'want'].includes(pocket.querySelector('.pocket')?.dataset.kind),
					onDrop: (from, to) => movePockets(
						{page: Number(from.dataset.page), position: Number(from.dataset.position)},
						{page: Number(to.dataset.page), position: Number(to.dataset.position)}
					),
					onLift: () => shown.cancelSwipe(),
				});
			}

			// Held sideways, the binder opens on its pages, whole above the
			// tab bar, unless Back is bringing back where the person was.
			if (window.matchMedia && window.matchMedia(SIDEWAYS_QUERY).matches && !(history.state && history.state.scrollY)) {
				requestAnimationFrame(() => alive && spread && spread.element.scrollIntoView({block: 'start'}));
			}
		}
		else {
			spread.update(binder);
		}

		drawSummary();
	}

	function drawSummary() {
		if (listMode) {
			drawListSummary();

			return;
		}

		const pages = spread.pages();
		const per = binder.rows * binder.cols;
		const live = (slot) => slot.entry_id && entriesById.get(slot.entry_id) && isLive(entriesById.get(slot.entry_id));
		const filled = pages.reduce((sum, pg) => sum + [...slotsOn(pg).values()].filter(live).length, 0);
		const stats = binderStats(binder, placed, new Set([...entriesById.values()].filter(isLive).map((entry) => entry.id)));
		const where = pages.length > 1 ? `Pages ${pages[0]} and ${pages[1]}` : `Page ${pages[0]}`;

		// Any pocket in use (a card, a Gone card, a placeholder, art, or one
		// left empty on purpose) means the binder is not new.
		if (emptyHint) {
			const upright = Boolean(window.matchMedia && window.matchMedia(OVERVIEW_QUERY).matches);

			emptyHint.hidden = slotsOf(binder, placed).length > 0;
			emptyText.textContent = upright
				? 'Nothing in this binder yet. Tap a page, then a pocket, to place a card you own, or scan new ones.'
				: 'Nothing in this binder yet. Tap a pocket to place a card you own, or scan new ones.';
		}

		// A card page opened from this binder swipes through its cards in
		// page and pocket order.
		offerCardList(slotsOf(binder, placed)
			.map((slot) => (slot.entry_id ? entriesById.get(slot.entry_id) : null))
			.filter((entry) => entry && isLive(entry))
			.map((entry) => entryInfo(entry, index, viewing).route), binder.name);

		drawTrayStatus();
		summary.textContent = `${where} of ${binder.page_count}: ${filled} of ${per * pages.length} pockets filled. ${formatCount(stats.filled)} of ${formatCount(stats.total)} in the binder${stats.wanted ? `, ${plural(stats.wanted, 'placeholder', 'placeholders')}` : ''}.`;

		fillVisible(pages).catch(() => {});
	}

	// Catalog records for the cards on the pages shown that the phone has
	// none for, such as a family member's cards.
	async function fillVisible(pages) {
		const items = [];

		for (const pg of pages) {
			for (const slot of slotsOn(pg).values()) {
				const entry = slot.entry_id && entriesById.get(slot.entry_id);

				if (entry) {
					items.push({cardId: entry.card_id, catalog: entry.catalog});
				}
				else if (slot.want) {
					items.push({cardId: slot.want.card_id, catalog: slot.want.catalog || 'international'});
				}
			}
		}

		const shown = pages.join(',');
		const filled = await fillRecords(items, index, () => alive);

		if (filled && alive) {
			index = filled;

			if (spread && spread.pages().join(',') === shown) {
				drawPage();
			}
		}
	}

	// The binder's live copies; the button shows only when there are some.
	function drawStats() {
		statsEntries = listMode
			? listShown()
			: slotsOf(binder, placed)
				.map((slot) => (slot.entry_id ? entriesById.get(slot.entry_id) : null))
				.filter((entry) => entry && isLive(entry));

		if (!statsEntries.length) {
			statsSlot.replaceChildren();
		}
		else if (!statsSlot.contains(valueOpen)) {
			statsSlot.replaceChildren(valueOpen);
		}

		drawValue();
	}

	function draw() {
		title.textContent = binder.name;
		document.title = `${binder.name} | Card Tracker`;
		meta.textContent = `${gridText(binder)} · ${plural(binder.page_count, 'page', 'pages')}${listMode ? ` · ${listMeta()}` : ''}`;
		notes.textContent = binder.notes || '';
		notes.hidden = !binder.notes;
		body.style.setProperty('--cover', isHex(binder.cover_color) ? binder.cover_color : DEFAULT_COVER);
		body.style.setProperty('--cover-text', coverTextColor(isHex(binder.cover_color) ? binder.cover_color : DEFAULT_COVER));

		if (!source.readOnly) {
			const loose = unplaced(data.cards.filter(isLive), data.binders).length;

			unplacedLink.textContent = `${plural(loose, 'owned card', 'owned cards')} not in any binder`;
			unplacedLink.hidden = listMode;
			addTrayButton.hidden = listMode;
			layoutButton.hidden = listMode;
			refreshButton.hidden = !listMode;
			fill.show(listMode ? 0 : binderStats(binder, placed).wanted);
		}

		drawPage();
		drawTray();
		drawHand();
		drawStats();
	}

	async function load() {
		try {
			data = await source.load();
			index = await cardIndex();
		}
		catch (err) {
			body.replaceChildren(failure(err, source.readOnly));

			return;
		}

		if (!alive) {
			return;
		}

		binder = shownList(liveBinders(data.binders).find((item) => item.id === id) || null);

		if (!binder) {
			if (spread) {
				spread.destroy();
				spread = null;
			}

			body.replaceChildren(h('div', {class: 'notice', role: 'alert'}, h('p', null, source.readOnly
				? 'This binder is not there any more.'
				: 'This binder is not on this phone. It may have been deleted.')));

			return;
		}

		placed = placements(data.binders);
		entriesById = new Map(data.cards.map((entry) => [entry.id, entry]));
		listMode = isGenerated(binder);
		picks = listMode ? picksOf(data.picks, binder.id) : new Map();
		sweepOnce(source);

		if (!body.contains(spreadHolder)) {
			// replaceChildren prints a null argument as "null", and a family
			// member's binder leaves several parts out.
			body.replaceChildren(...[
				h('div', {class: 'binder-head'}, title, meta, statsSlot, notes),
				listNote,
				spreadHolder,
				summary,
				leftOut,
				emptyHint,
				unplacedLink,
				source.readOnly
					? null
					: h('div', {class: 'actions'},
						refreshButton,
						fill.button,
						addTrayButton,
						layoutButton,
						h('button', {id: 'edit-binder', onclick: openEditor, type: 'button'}, 'Edit binder'),
						h('button', {id: 'binder-cover-image', onclick: () => pickCoverImage({binder}), type: 'button'}, 'Cover image'),
						h('button', {class: 'danger', id: 'delete-binder', onclick: remove, type: 'button'}, 'Delete binder')
					),
				fill ? fill.box : null,
				editor,
			].filter(Boolean));
		}

		draw();

		if (listMode) {
			startList();
		}
	}

	function openEditor() {
		if (listMode) {
			openListEditor().catch((err) => showError('Could not open the editor.', err));

			return;
		}

		editor.replaceChildren(binderForm({
			binder,
			onCancel: () => editor.replaceChildren(),
			onSubmit: async (fields) => {
				let mode = 'auto';

				if (resizeMatters(binder, planResize(binder, fields, {placed}))) {
					mode = await askResize(fields);

					if (!mode) {
						return false;
					}
				}

				await updateBinder(binder.id, fields, {mode});
				editor.replaceChildren();

				return true;
			},
			placed,
		}));
		editor.scrollIntoView({block: 'start'});
	}

	// The preview before a resize is saved, in the app's own sheet: the
	// first page after the change, what happens to the pockets, and the two
	// ways to do it (the rule, or everything into the tray). Resolves "auto",
	// "tray", or null for Cancel.
	function askResize(fields) {
		const box = h('dialog', {'aria-labelledby': 'resize-title', class: 'pocket-sheet resize-sheet', id: 'resize-sheet'});
		const lines = h('div', {'aria-live': 'polite', class: 'resize-lines', id: 'resize-lines'});
		const preview = h('div', {class: 'resize-preview', id: 'resize-preview'});
		const choice = h('div', {'aria-label': 'How to resize', class: 'resize-choice', role: 'radiogroup'},
			h('label', null, h('input', {checked: true, id: 'resize-auto', name: 'resize-mode', type: 'radio', value: 'auto'}), h('span', null, 'Arrange automatically')),
			h('label', null, h('input', {id: 'resize-tray', name: 'resize-mode', type: 'radio', value: 'tray'}), h('span', null, 'Empty into the tray and arrange by hand'))
		);
		const cancel = h('button', {id: 'resize-cancel', type: 'button'}, 'Cancel');
		const save = h('button', {class: 'primary', id: 'resize-save', type: 'button'}, 'Save');
		const mode = () => choice.querySelector('input:checked').value;

		function draw() {
			const plan = planResize(binder, fields, {mode: mode(), placed});
			const shape = {cols: fields.cols, rows: fields.rows};
			const first = new Map(plan.slots.filter((slot) => slot.page === 1).map((slot) => [slot.position, slot]));
			const cells = [];

			for (let position = 1; position <= fields.rows * fields.cols; position++) {
				const content = pocketContent(first.get(position) || null);

				cells.push(h('div', {'aria-label': content.label, class: `pocket pocket-${content.kind}`, 'data-kind': content.kind, role: 'img'}, content.kind === 'open' ? '' : content.node));
			}

			lines.replaceChildren(...resizeLines(binder, plan).map((line) => h('p', null, line)));
			preview.replaceChildren(
				h('p', {class: 'field-label'}, `Page 1 after the change, ${shape.rows} × ${shape.cols}`),
				h('div', {class: 'resize-page', style: `--rz-cols: ${shape.cols}`}, cells)
			);
		}

		return new Promise((resolve) => {
			const finish = (value) => {
				if (box.open) {
					box.close();
				}

				box.remove();
				resolve(value);
			};

			choice.addEventListener('change', draw);
			cancel.addEventListener('click', () => finish(null));
			save.addEventListener('click', () => finish(mode()));
			box.addEventListener('cancel', (event) => {
				event.preventDefault();
				finish(null);
			});
			box.addEventListener('click', (event) => {
				if (event.target === box) {
					finish(null);
				}
			});
			closeResize = () => finish(null);
			box.append(
				h('div', {class: 'sheet-head'}, h('h3', {id: 'resize-title'}, `Change the size of ${binder.name}?`)),
				h('p', {class: 'muted'}, `New size: ${fields.rows} × ${fields.cols}, ${plural(fields.page_count, 'page', 'pages')}.`),
				choice,
				lines,
				preview,
				h('div', {class: 'button-row'}, cancel, save)
			);
			draw();
			root.append(box);
			box.showModal();
			save.focus();
		});
	}

	// Deleted at once, with Undo on a toast that brings the binder back as it
	// was: its pockets, tray, cover, and place (Eric, 2026-10-06).
	async function remove() {
		const deleting = binder;
		let undone = false;

		try {
			await deleteBinder(deleting.id);
		}
		catch (err) {
			showError('Could not delete the binder.', err);

			return;
		}

		// Its cover image leaves the bucket too: queued, so offline it goes
		// when there is signal, and the bucket file waits out a grace period
		// that a binder brought back cancels. Never waited on, and never an
		// error here. A cover not uploaded yet lives only on this phone, so
		// it waits for Undo to run out first.
		const cover = coverImageOf(deleting);

		if (cover && !cover.path) {
			setTimeout(() => {
				if (!undone) {
					dropBinderCover(deleting);
				}
			}, UNDO_MS + 1000);
		}
		else {
			dropBinderCover(deleting);
		}

		go('binders');
		toast(`Deleted ${deleting.name}.`, {
			action: () => {
				undone = true;
				restoreBinder(deleting.id).catch((err) => toast(`Could not bring it back. ${errorText(err)}`));
			},
			actionLabel: 'Undo',
			timeout: UNDO_MS,
		});
	}

	// ---------------------------------------------- a binder from a list
	//
	// The pockets follow the binder's last layout (snapshot keys), one per
	// Pokémon or card. Each shows the copy picked by hand, else the default
	// the last refresh chose, else the default now; a count when more copies
	// fit; a faded placeholder with Add to wishlist when none is owned.
	// Opening the binder reads its list again and saves what changed
	// (refreshList), which is also the Refresh button.

	const listKeys = () => (binder && binder.snapshot && Array.isArray(binder.snapshot.keys) ? binder.snapshot.keys : []);

	// A layout worked out here but not saved on opening (planRefresh
	// languageOnly or editsOnly: an older phone saved the stored one and
	// would put it back), shown in its place while the stored one is the
	// same.
	function shownList(stored) {
		const held = gen.held;

		if (!stored || !held || !isGenerated(stored) || !stored.snapshot || stored.snapshot.at !== held.at) {
			return stored;
		}

		return {...stored, page_count: held.page_count, snapshot: held.snapshot};
	}

	const liveEntry = (id) => {
		const entry = id ? entriesById.get(id) : null;

		return entry && isLive(entry) ? entry : null;
	};

	// The item for a key when the list has not been read: its name and
	// picture from the Pokémon names or the card index.
	function fallbackItem(key) {
		const parsed = parseKey(key);

		if (parsed && parsed.kind === 'pokemon') {
			return pokemonItem(parsed.dex, gen.names || []);
		}

		return cardItem(key, index, {});
	}

	// Pocket i's state: {key, item, shown: {entry, picked} | null, count},
	// or null past the last pocket.
	function listState(i) {
		const key = listKeys()[i];

		if (!key) {
			return null;
		}

		const stored = (binder.snapshot.shown || {})[key] || null;
		const pick = picks.get(key) || null;
		const item = gen.items && gen.items.get(key);

		if (item) {
			return {count: item.copies.length, item, key, shown: shownCopy(item, {pick, rankOf: gen.rankOf, stored})};
		}

		// Not read yet, or a family member's binder: the pick or the stored
		// default, while that copy is still owned.
		const entry = liveEntry(pick) || liveEntry(stored);

		return {count: 0, item: fallbackItem(key), key, shown: entry ? {entry, picked: Boolean(liveEntry(pick))} : null};
	}

	// The copies shown, in pocket order.
	const listShown = () => listKeys().map((key, i) => listState(i)).filter((state) => state && state.shown).map((state) => state.shown.entry);

	function listMeta() {
		const orderNames = {dex: 'Pokédex order', name: 'name order', release: 'newest set first', set: 'set order'};
		const doc = data.doc || {};
		const what = binder.rule.source.kind === 'filter' ? sourceText(binder.rule, doc, filterLabels(doc, index)) : sourceText(binder.rule, doc);

		return `${what}, ${orderNames[binder.rule.order] || binder.rule.order}`;
	}

	// One pocket's look, from its state (listState).
	function listPocketContent(state) {
		if (!state) {
			return {kind: 'open', label: 'Empty', node: h('span', {'aria-hidden': 'true', class: 'pocket-plus'}, '')};
		}

		const {count, item, shown} = state;

		if (shown) {
			const {entry, picked} = shown;
			const info = entryInfo(entry, index, viewing);
			const frame = artOf(entry, info, (src) => tileArt({count, finish: entryFinish(entry), info, languages: [entry.language], src, viewing}), recordsShown());
			const extra = [count > 1 ? `${count} copies fit` : null, picked ? 'picked by hand' : null].filter(Boolean).join(', ');

			return {info, item, kind: 'card', label: `${item.name}: ${info.name}, ${languageLabel(entry.language)}${extra ? `, ${extra}` : ''}`, node: frame};
		}

		const info = item.kind === 'pokemon'
			? {image: item.image, name: item.name, number: String(item.dex).padStart(3, '0'), setName: null}
			: wantInfo({card_id: item.cardId, catalog: item.catalog, image: item.image, name: item.name}, index, viewing);
		const want = (src) => h('div', {class: 'art-wrap'}, cardArt(info, src), h('span', {class: 'pocket-tag'}, 'Want'));

		return {
			info,
			item,
			kind: 'want',
			label: `${item.kind === 'pokemon' ? `${item.number} ${item.name}` : info.name}, not owned yet`,
			// A Pokémon's pocket shows its picture; a card's, its main image.
			node: item.kind === 'pokemon' ? want(item.image) : artOf(cardTarget({card_id: item.cardId, catalog: item.catalog}), info, want, recordsShown()),
		};
	}

	function listPocket(pg, position) {
		const i = indexAt(pg, position, binder.rows, binder.cols);
		const state = listState(i);
		const content = listPocketContent(state);
		const attrs = {
			'aria-label': `Page ${pg}, pocket ${position}: ${content.label}`,
			class: `pocket pocket-${content.kind}`,
			'data-item': state ? state.item.kind : null,
			'data-key': state ? state.key : null,
			'data-kind': content.kind,
			'data-page': pg,
			'data-picked': state && state.shown && state.shown.picked ? 'true' : null,
			'data-position': position,
		};

		if (!state) {
			return h('div', attrs, content.node);
		}

		// A copy shown comes out of its pocket (viewListPocket); a pocket
		// with none opens the sheet, read only nothing.
		if (state.shown) {
			return h('button', {...attrs, onclick: (event) => viewListPocket(pg, position, event.currentTarget), type: 'button'}, content.node);
		}

		if (!source.readOnly) {
			return h('button', {...attrs, onclick: () => openListSheet(pg, position), type: 'button'}, content.node);
		}

		return h('div', attrs, content.node);
	}

	function drawListSummary() {
		const pages = spread.pages();
		const per = binder.rows * binder.cols;
		const keys = listKeys();
		const where = pages.length > 1 ? `Pages ${pages[0]} and ${pages[1]}` : `Page ${pages[0]}`;
		let filled = 0;
		let owned = 0;

		keys.forEach((key, i) => {
			const state = listState(i);

			if (state && state.shown) {
				owned++;

				if (pages.includes(Math.floor(i / per) + 1)) {
					filled++;
				}
			}
		});

		if (emptyHint) {
			emptyHint.hidden = keys.length > 0;
			emptyText.textContent = 'No cards fit this list yet. Edit binder to choose another list, or scan new cards.';
		}

		offerCardList(listShown().map((entry) => entryInfo(entry, index, viewing).route), binder.name);
		summary.textContent = `${where} of ${binder.page_count}: ${filled} of ${per * pages.length} pockets filled. ${formatCount(owned)} of ${plural(keys.filter(Boolean).length, 'pocket', 'pockets')} with a card you own.`;
		drawLeftOut();
		fillListRecords(pages).catch(() => {});
	}

	// Names and pictures for the cards on the pages shown that the phone has
	// no record for (a family member's, or a goal's cards not owned).
	async function fillListRecords(pages) {
		const per = binder.rows * binder.cols;
		const items = [];

		listKeys().forEach((key, i) => {
			if (!pages.includes(Math.floor(i / per) + 1)) {
				return;
			}

			const state = listState(i);
			const entry = state && state.shown && state.shown.entry;
			const parsed = parseKey(key);

			if (entry) {
				items.push({cardId: entry.card_id, catalog: entry.catalog});
			}
			else if (parsed && parsed.kind === 'card' && !(gen.items && gen.items.get(key) && gen.items.get(key).image)) {
				items.push({cardId: parsed.cardId, catalog: parsed.catalog});
			}
		});

		const shown = pages.join(',');
		const filled = await fillRecords(items, index, () => alive);

		if (filled && alive) {
			index = filled;

			if (spread && spread.pages().join(',') === shown) {
				drawPage();
			}
		}
	}

	function showListNote(text) {
		listNote.textContent = text;
		listNote.hidden = !text;
	}

	const nameOfKey = (key) => ((gen.items && gen.items.get(key)) || fallbackItem(key)).name;

	// Once a screen: the Pokémon names for the placeholders, and for your
	// own binder, a read of its list (refreshList). Again when another phone
	// changed the rule since.
	function startList() {
		if (!gen.started) {
			gen.started = true;

			if (listKeys().some((key) => key.startsWith('dex:'))) {
				pokemonNames().then((names) => {
					gen.names = names;

					if (alive && listMode) {
						drawPage();
					}
				}).catch(() => {});
			}

			if (!source.readOnly) {
				gen.busy = refreshList();
			}

			return;
		}

		if (!source.readOnly && !gen.busy && binder.snapshot && binder.snapshot.rule_key !== ruleKey(binder.rule)) {
			gen.busy = refreshList();
		}
	}

	// Reads the list again: new pockets for cards added to it, pockets gone
	// for cards that left, owned cards filled in, pockets emptied, and
	// defaults moved to the best copy, picks kept (planRefresh). Saves only
	// what changed, and says it. manual: the Refresh button, which also asks
	// again what a failed download put off (force). On opening, a layout
	// that differs from the stored one only by the list's languages, which
	// a v56 phone would put back on its next opening, is shown but neither
	// saved nor told (planRefresh languageOnly); Refresh saves it.
	async function refreshList({force = false, manual = false} = {}) {
		if (source.readOnly || !binder || !listMode) {
			return;
		}

		const binderId = binder.id;

		if (manual) {
			refreshButton.disabled = true;
			showListNote('Reading the list again…');
		}

		try {
			const doc = await loadDocument();
			const loaded = await loadRuleItems(binder.rule, doc, {force, index, isAlive: () => alive});

			if (!alive || !binder || binder.id !== binderId) {
				return;
			}

			index = loaded.index || index;

			if (loaded.gone) {
				gen.gone = true;
				showListNote('The list this binder was made from was deleted. Its pages stay as they were; Edit binder to choose another list.');

				return;
			}

			if (loaded.partial && !loaded.items.length) {
				showListNote(manual ? `The list's cards could not be read${navigator.onLine ? '' : ' offline'}. The pages stay as they were.` : '');

				return;
			}

			const liveIds = new Set([...entriesById.values()].filter(isLive).map((entry) => entry.id));
			// Against the binder as saved, not a layout shown in its place.
			const stored = liveBinders(doc.binders).find((item) => item.id === binderId) || binder;
			const {plan, rankOf} = await planLayout(stored, loaded, {liveIds, picks});

			if (!alive || binder.id !== binderId) {
				return;
			}

			gen.items = new Map(loaded.items.map((item) => [item.key, item]));
			gen.loaded = loaded;
			gen.rankOf = rankOf;
			gen.partial = loaded.partial;

			const held = (plan.languageOnly || plan.editsOnly) && !manual;
			const text = held ? '' : refreshText(plan, nameOfKey);
			const partly = loaded.partial ? ' Some cards could not be checked yet; their pockets stay as they were.' : '';

			showListNote(text ? `${text}${partly}` : manual ? `Up to date.${partly}` : '');

			if (plan.changed && !held) {
				gen.held = null;
				await saveRefresh(binderId, plan);
			}
			else {
				const at = stored.snapshot && stored.snapshot.at;

				gen.held = plan.changed ? {at, page_count: plan.page_count, snapshot: {...plan.snapshot, at}} : null;
				binder = shownList(binder);
				draw();
			}
		}
		catch (err) {
			if (manual) {
				showListNote('');
				showError('Could not refresh the binder.', err);
			}
		}
		finally {
			gen.busy = null;

			if (refreshButton) {
				refreshButton.disabled = false;
			}
		}
	}

	// The sheet for one pocket: every owned copy that fits, as pictures, to
	// pick the one shown (the pick sticks through refreshes), or for a card
	// not owned, Add to wishlist.
	// move or remove: open on Move to... or Remove from this binder.
	function openListSheet(page, position, {move = false, remove = false} = {}) {
		const i = indexAt(page, position, binder.rows, binder.cols);
		const message = h('p', {'aria-live': 'polite', class: 'form-error'});
		const body = h('div', {class: 'list-sheet', id: 'list-sheet'});
		let panel = move ? 'move' : remove ? 'remove' : null;

		function fill() {
			const state = listState(i);

			if (!state) {
				closeSheet();

				return;
			}

			if (panel) {
				sheet.querySelector('#sheet-title').textContent = state.item.kind === 'pokemon' ? `${state.item.number} ${state.item.name}` : state.item.name;
				const shown = panel === 'move' ? listMovePanel(i, state) : listRemovePanel(state);

				shown.hidden = false;
				body.replaceChildren(shown);
				body.querySelector(panel === 'move' ? '#move-end' : '#remove-shift').focus();

				return;
			}

			const {item, key, shown} = state;
			const copies = gen.items && gen.items.get(key) ? [...gen.items.get(key).copies] : [];
			const parts = [];

			sheet.querySelector('#sheet-title').textContent = item.kind === 'pokemon' ? `${item.number} ${item.name}` : item.name;

			if (!gen.items) {
				parts.push(h('p', {class: 'muted', id: 'list-sheet-wait'}, 'Reading your cards for this list…'));
				(gen.busy || Promise.resolve()).then(() => {
					if (alive && sheet.open && body.isConnected) {
						fill();
					}
				});
			}

			if (copies.length) {
				const fallback = shownCopy({copies}, {rankOf: gen.rankOf, stored: (binder.snapshot.shown || {})[key]});
				const defaultId = fallback ? fallback.entry.id : null;

				copies.sort((a, b) => (Number(b.id === defaultId) - Number(a.id === defaultId)) || String(b.created_at).localeCompare(String(a.created_at)));
				parts.push(h('p', {class: 'muted', id: 'list-sheet-count'}, copies.length > 1
					? `${plural(copies.length, 'copy fits', 'copies fit')} this pocket. Tap the one to show here.`
					: 'Your copy for this pocket.'));
				parts.push(h('div', {class: 'pick-grid', id: 'list-copies'}, copies.map((entry) => {
					const info = entryInfo(entry, index, viewing);
					const current = Boolean(shown) && shown.entry.id === entry.id;
					const where = locate(data.binders, entry.id);

					return h('button', {
						'aria-pressed': String(current),
						class: 'pick list-copy',
						'data-entry': entry.id,
						onclick: () => (current && shown.picked ? closeSheet() : act(() => setPocketPick(binder.id, key, entry.id), 'Could not pick the copy.')),
						type: 'button',
					},
					artOf(entry, info, (src) => tileArt({finish: entryFinish(entry), info, languages: [entry.language], src})),
					h('span', {class: 'tile-name'}, info.name),
					h('span', {class: 'tile-meta'}, [languageLabel(entry.language), entry.condition, entry.storage].filter(Boolean).join(' · ')),
					entry.id === defaultId ? h('span', {class: 'tile-meta list-default-tag'}, 'Default') : null,
					where ? h('span', {class: 'tile-meta pick-where'}, `In ${where.binder_name}, p${where.page}`) : null);
				})));

				const actions = [];

				if (shown && shown.picked) {
					actions.push(h('button', {id: 'list-use-default', onclick: () => act(() => setPocketPick(binder.id, key, null), 'Could not save the pocket.'), type: 'button'}, 'Show the default again'));
				}

				if (shown) {
					actions.push(link(entryInfo(shown.entry, index, viewing).route, {class: 'button', onclick: closeSheet}, 'Open card'));
				}

				parts.push(h('div', {class: 'button-row'}, actions));
			}
			else if (gen.items) {
				const content = listPocketContent({count: 0, item, key, shown: null});
				const actions = [];

				parts.push(h('div', {class: 'list-want'},
					h('div', {class: 'pocket pocket-want list-want-art', 'data-item': item.kind}, content.node),
					h('p', {id: 'list-sheet-missing'}, 'You do not own this yet.')));

				if (item.kind === 'card') {
					actions.push(h('button', {class: 'primary', id: 'list-wish', onclick: async (event) => {
						const button = event.currentTarget;

						button.disabled = true;

						try {
							await addToWishlist(item.cardId, {catalog: item.catalog});
							button.textContent = 'On your wishlist';
							toast(`${item.name} is on your wishlist.`);
						}
						catch (err) {
							button.disabled = false;
							message.textContent = `Could not add it to the wishlist. ${err.message || errorText(err)}`;
						}
					}, type: 'button'}, 'Add to wishlist'));
					actions.push(link(content.info.route || cardRoute(null, item.catalog, item.cardId), {class: 'button', onclick: closeSheet}, 'Open card'));
				}
				else if (binder.rule.source.kind === 'checklist' && sourceEntry(binder.rule, data.doc || {})) {
					actions.push(link(`lists/${encodeURIComponent(binder.rule.source.id)}/pokemon/${item.dex}`, {class: 'button primary', id: 'list-wish', onclick: closeSheet}, 'Add to wishlist: choose a card'));
				}

				parts.push(h('div', {class: 'button-row'}, actions));
			}

			if (!source.readOnly) {
				const open = (which) => () => {
					panel = which;
					fill();
				};

				parts.push(h('div', {class: 'button-row list-arrange'},
					h('button', {id: 'list-move', onclick: open('move'), type: 'button'}, 'Move to…'),
					h('button', {class: 'danger', id: 'list-remove', onclick: open('remove'), type: 'button'}, 'Remove from this binder')));
			}

			body.replaceChildren(...parts);
		}

		sheet.replaceChildren(
			h('div', {class: 'sheet-head'},
				h('h3', {id: 'sheet-title'}, `Page ${page}, pocket ${position}`),
				h('button', {'aria-label': 'Close', class: 'small', id: 'sheet-close', onclick: closeSheet, type: 'button'}, 'Close')),
			h('p', {class: 'muted list-sheet-where'}, `Page ${page}, pocket ${position}`),
			body,
			message
		);
		fill();

		if (!sheet.open) {
			openDialogSheet(sheet);
		}
	}

	// ------------------------------------ left out and moved, from a list
	//
	// A binder from a list leaves a Pokémon or card out, or moves it, as an
	// exception on the binder (list_edits, js/binder-rules.js), applied after
	// the list's order on every refresh (Eric, 2026-11-06).

	const listEdits = () => listEditsOf(binder);

	// The layout with these changes to the saved edits (withListEdit):
	// worked out from the list when it has been read, else the shown pockets
	// with the one edit applied. Null when neither can tell (an Undo or Put
	// back before the list was read): the next refresh lays it out.
	function listPlanWith(changes, edit = null) {
		const liveIds = new Set([...entriesById.values()].filter(isLive).map((entry) => entry.id));

		if (gen.loaded && gen.items) {
			const entries = changes.reduce(withListEdit, listEditEntries(binder));

			return planRefresh({...binder, list_edits: entries}, gen.loaded.items, {at: nowIso(), languages: gen.loaded.languages, liveIds, partial: gen.loaded.partial, picks, rankOf: gen.rankOf});
		}

		if (!edit || edit.kind === 'none') {
			return null;
		}

		const keys = applyListEdits(listKeys(), [edit]);
		const shown = binder.snapshot.shown || {};

		return {
			page_count: pagesFor(keys.length, binder.rows, binder.cols),
			snapshot: {...binder.snapshot, keys, shown: Object.fromEntries(Object.entries(shown).filter(([key]) => keys.includes(key)))},
		};
	}

	async function saveListEdit(key, edit, text) {
		const binderId = binder.id;
		const previous = listEdits().find((item) => item.key === key) || null;

		await saveListEdits(binderId, [edit], listPlanWith([edit], edit));
		toast(text, {
			action: () => undoListEdit(binderId, key, edit, previous),
			actionLabel: 'Undo',
			timeout: UNDO_MS,
		});
	}

	// Undo: the key's edit before, again at a new time so it wins the merge,
	// or none, while the one made is still the latest.
	async function undoListEdit(binderId, key, made, previous) {
		try {
			const fresh = await getBinder(binderId);
			const current = fresh ? listEditsOf(fresh).find((item) => item.key === key) : null;

			if (!current || current.at !== made.at || current.kind !== made.kind) {
				toast('That pocket has changed since, so it stays as it is.');

				return;
			}

			const change = previous ? {...previous, at: nowIso()} : {at: nowIso(), key, kind: 'none'};

			await saveListEdits(binderId, [change], binder && binder.id === binderId ? listPlanWith([change], change) : null);
		}
		catch (err) {
			showError('Could not undo.', err);
		}
	}

	function listRemovePanel(state) {
		const {item, key} = state;

		return removePanel({
			note: `${item.name} is left out of this binder: refreshing keeps it out, and cards that join the list later still take their places.`,
			onEmpty: () => act(() => saveListEdit(key, {at: nowIso(), key, kind: 'gap'}, `${item.name} is left out of this binder; its pocket stays empty.`), 'Could not save the binder.'),
			onShift: () => act(() => saveListEdit(key, {at: nowIso(), key, kind: 'out'}, `${item.name} is left out of this binder; the pockets after it moved back one.`), 'Could not save the binder.'),
		});
	}

	// Move to...: the end of the binder, or a page and pocket; the pockets
	// between shift to make room.
	function listMovePanel(i, state) {
		const {item} = state;
		const per = binder.rows * binder.cols;
		const keys = listKeys();
		const here = {page: Math.floor(i / per) + 1, position: (i % per) + 1};
		const pageSelect = h('select', {'aria-label': 'Page', id: 'move-page'},
			...Array.from({length: binder.page_count}, (_, n) => h('option', {selected: n + 1 === here.page, value: n + 1}, `Page ${n + 1}`)));
		const pocketSelect = h('select', {'aria-label': 'Pocket', id: 'move-pocket'});
		const moveButton = h('button', {class: 'primary', id: 'move-shift', type: 'button'}, 'Move here');
		const holds = h('p', {'aria-live': 'polite', class: 'muted', id: 'move-holds'});
		const target = () => ((Number(pageSelect.value) - 1) * per) + Number(pocketSelect.value) - 1;
		const describe = () => {
			moveButton.disabled = target() === i;
			holds.textContent = moveButton.disabled ? 'This is the pocket it is in now.' : nameAt(target()) === 'Empty' ? 'Empty.' : `Holds ${nameAt(target())}.`;
		};
		const nameAt = (n) => {
			const at = listState(n);

			return at ? at.item.name : 'Empty';
		};

		const fillPockets = () => {
			const shownPage = Number(pageSelect.value);

			pocketSelect.replaceChildren(...Array.from({length: per}, (_, n) => h('option', {value: n + 1}, `Pocket ${n + 1}`)));
			pocketSelect.value = String(shownPage === here.page ? (here.position === per ? 1 : here.position + 1) : 1);
			describe();
		};

		const go = (to) => act(async () => {
			const edit = moveEdit(keys, i, to, nowIso());

			if (!edit) {
				toast(to === 'end' ? `${item.name} is at the end already.` : `${item.name} is in that pocket already.`);

				return;
			}

			const placed = applyListEdits(keys, [edit]).indexOf(item.key);
			const where = {page: Math.floor(placed / per) + 1, position: (placed % per) + 1};

			await saveListEdit(item.key, edit, edit.kind === 'end'
				? `${item.name} goes to the end of this binder, page ${where.page}, pocket ${where.position}.`
				: `${item.name} goes to page ${where.page}, pocket ${where.position}; the pockets between shifted one.`);
		}, 'Could not save the binder.');

		pageSelect.addEventListener('change', fillPockets);
		pocketSelect.addEventListener('change', describe);
		moveButton.addEventListener('click', () => go(target()));
		fillPockets();

		return h('div', {class: 'move-panel', id: 'move-panel'},
			h('h4', null, 'Move to…'),
			h('p', {class: 'muted'}, 'Every refresh keeps it there; cards that join the list later still take their places.'),
			h('button', {class: 'primary move-end', id: 'move-end', onclick: () => go('end'), type: 'button'}, 'End of the binder'),
			h('p', {class: 'muted move-or'}, 'Or a pocket:'),
			h('div', {class: 'button-row'}, pageSelect, pocketSelect),
			holds,
			h('div', {class: 'button-row'}, moveButton)
		);
	}

	// What is left out, and Put back, under the pages.
	function drawLeftOut() {
		const out = source.readOnly ? [] : listEdits().filter((edit) => edit.kind === 'out' || edit.kind === 'gap');

		leftOut.hidden = !out.length;

		if (!out.length) {
			leftOut.replaceChildren();

			return;
		}

		const names = out.map((edit) => nameOfKey(edit.key));

		leftOut.replaceChildren(
			h('span', null, `Left out of this binder: ${names.slice(0, 5).join(', ')}${names.length > 5 ? `, and ${names.length - 5} more` : ''}. `),
			h('button', {class: 'small', id: 'list-put-back', onclick: async () => {
				try {
					const binderId = binder.id;
					const now = nowIso();
					const changes = out.map((edit) => ({at: now, key: edit.key, kind: 'none'}));

					await saveListEdits(binderId, changes, listPlanWith(changes));
					toast(`${plural(out.length, 'card is', 'cards are')} back in their list places.`);
				}
				catch (err) {
					showError('Could not save the binder.', err);
				}
			}, type: 'button'}, 'Put back'));
	}

	// Edit for a binder made from a list: name, notes, and cover, and the
	// list, the order, and the pocket size. A change to the layout shows
	// its first page in a sheet before it is saved.
	async function openListEditor() {
		const doc = await loadDocument();
		const editing = binder;

		editor.replaceChildren(binderForm({
			binder: editing,
			onCancel: () => editor.replaceChildren(),
			onSubmit: async (fields, section) => {
				const rule = section.rule();
				let snapshot = editing.snapshot;
				let languages;

				if (!snapshot || ruleKey(rule) !== ruleKey(editing.rule) || fields.rows !== editing.rows || fields.cols !== editing.cols) {
					const loaded = await section.ready();

					if (loaded.gone) {
						throw new Error('That list was deleted. Choose another.');
					}

					const liveIds = new Set([...entriesById.values()].filter(isLive).map((entry) => entry.id));
					const draft = {...editing, cols: fields.cols, rows: fields.rows, rule};
					const {plan, rankOf} = await planLayout(draft, loaded, {liveIds, picks});

					if (!await askRelayout(draft, loaded.items, plan, rankOf)) {
						return false;
					}

					snapshot = plan.snapshot;
					languages = plan.languages;
				}

				await updateGeneratedBinder(editing.id, fields, rule, snapshot, {languages});
				editor.replaceChildren();

				return true;
			},
			rule: ruleSection({binder: editing, doc, index}),
			title: 'Edit binder',
		}));
		editor.scrollIntoView({block: 'start'});
	}

	// The preview before a new layout is saved: what changes and the first
	// page. Resolves true for Save, false for Cancel.
	function askRelayout(draft, items, plan, rankOf) {
		const box = h('dialog', {'aria-labelledby': 'relayout-title', class: 'pocket-sheet resize-sheet', id: 'relayout-sheet'});
		const cancel = h('button', {id: 'relayout-cancel', type: 'button'}, 'Cancel');
		const save = h('button', {class: 'primary', id: 'relayout-save', type: 'button'}, 'Save');
		const per = draft.rows * draft.cols;
		const byKey = new Map(items.map((item) => [item.key, item]));
		const lines = [`${plural(plan.snapshot.keys.length, 'pocket', 'pockets')} on ${plural(plan.page_count, 'page', 'pages')} of ${draft.rows} × ${draft.cols}, was ${plural(binder.page_count, 'page', 'pages')} of ${binder.rows} × ${binder.cols}.`];
		const changed = refreshText({...plan, updated: []}, (key) => (byKey.get(key) || fallbackItem(key)).name);

		if (changed) {
			lines.push(changed);
		}

		if (picks.size) {
			lines.push('The copies you picked by hand stay with their Pokémon or card.');
		}

		const cells = [];

		for (let position = 1; position <= per; position++) {
			const key = plan.snapshot.keys[position - 1];
			const item = key ? byKey.get(key) : null;
			const state = item ? {count: item.copies.length, item, key, shown: shownCopy(item, {pick: picks.get(key), rankOf, stored: plan.snapshot.shown[key]})} : null;
			const content = listPocketContent(state);

			cells.push(h('div', {'aria-label': content.label, class: `pocket pocket-${content.kind}`, 'data-item': state ? state.item.kind : null, 'data-kind': content.kind, role: 'img'}, content.kind === 'open' ? '' : content.node));
		}

		return new Promise((resolve) => {
			const finish = (value) => {
				if (box.open) {
					box.close();
				}

				box.remove();
				resolve(value);
			};

			cancel.addEventListener('click', () => finish(false));
			save.addEventListener('click', () => finish(true));
			box.addEventListener('cancel', (event) => {
				event.preventDefault();
				finish(false);
			});
			box.addEventListener('click', (event) => {
				if (event.target === box) {
					finish(false);
				}
			});
			closeResize = () => finish(false);
			box.append(
				h('div', {class: 'sheet-head'}, h('h3', {id: 'relayout-title'}, `Lay out ${binder.name} again?`)),
				h('div', {'aria-live': 'polite', class: 'resize-lines', id: 'relayout-lines'}, lines.map((line) => h('p', null, line))),
				h('div', {class: 'resize-preview', id: 'relayout-preview'},
					h('p', {class: 'field-label'}, `Page 1 after the change, ${draft.rows} × ${draft.cols}`),
					h('div', {class: 'resize-page', style: `--rz-cols: ${draft.cols}`}, cells)),
				h('div', {class: 'button-row'}, cancel, save)
			);
			root.append(box);
			box.showModal();
			save.focus();
		});
	}

	// ------------------------------------------------ the card in hand
	//
	// A card brought from its page with Add to binder (js/binder-hand.js).
	// The bar at the bottom shows it; a tap on an empty pocket, or on the
	// placeholder waiting for it, places one copy there; Next free pocket
	// uses the first empty pocket in reading order; Keep in tray puts it in
	// this binder's tray. Each puts the card down, with Undo on a toast, and
	// so do Cancel and Escape. Back off the binder leaves it behind.

	let handMessage = '';
	let handMessageTimer = null;
	let handFocused = false;
	let handFilling = false;

	const handPick = (options) => (data && binder && hand ? handCopy(data.binders, data.cards, hand, binder.id, options) : null);

	// The placeholder in this binder waiting for the card, with its want, or
	// null.
	function handWaiting() {
		const found = binder && hand ? placeholdersFor([binder], hand.catalog, hand.cardId)[0] : null;
		const slot = found ? slotsOn(found.page).get(found.position) : null;

		return slot && slot.want ? {page: found.page, position: found.position, want: slot.want} : null;
	}

	function drawHandStatus() {
		if (!handBar || !hand) {
			return;
		}

		if (handMessage) {
			handStatus.textContent = handMessage;
		}
		else if (!handPick()) {
			handStatus.textContent = 'Every copy of this card is in a pocket now.';
		}
		else {
			handStatus.textContent = pocketsLive() ? 'Tap an empty pocket' : 'Open a page, then tap an empty pocket';
		}
	}

	function drawHand() {
		if (!handBar) {
			return;
		}

		// A binder made from a list places nothing.
		if (hand && listMode) {
			putDown();

			return;
		}

		handBar.hidden = !hand;

		if (!hand || !data) {
			return;
		}

		const copies = data.cards.filter((entry) => isLive(entry) && entry.card_id === hand.cardId && (entry.catalog || 'international') === hand.catalog);
		const pick = handPick();
		const face = (pick && pick.entry) || copies[0];
		const info = face ? entryInfo(face, index, viewing) : null;
		const wait = pick ? handWaiting() : null;

		// Its catalog record, when the phone has none yet: the name and art.
		if (!handFilling && !index.has(indexKey(hand.catalog, hand.cardId))) {
			handFilling = true;
			fillRecords([{cardId: hand.cardId, catalog: hand.catalog}], index, () => alive).then((filled) => {
				if (filled && alive) {
					index = filled;
					drawHand();
				}
			}, () => {});
		}

		if (info) {
			artOf(face, info, (src) => {
				handArt.replaceChildren(cardArt(info, src));

				return handArt;
			});
		}
		else {
			handArt.replaceChildren();
		}
		handName.textContent = info ? info.name : 'This card';
		handWait.hidden = !wait;
		handWaitText.textContent = wait ? `Page ${wait.page}, pocket ${wait.position} is waiting for this card` : '';
		handNext.disabled = !pick;
		handTray.disabled = !handPick({toTray: true});
		drawHandStatus();

		if (spread) {
			spread.element.dataset.placing = 'true';
		}

		if (!handFocused) {
			handFocused = true;
			handBar.setAttribute('tabindex', '-1');
			requestAnimationFrame(() => alive && hand && handBar.focus({preventScroll: true}));
		}
	}

	function handSay(text) {
		clearTimeout(handMessageTimer);
		handMessage = text;
		drawHandStatus();
		handMessageTimer = setTimeout(() => {
			handMessage = '';
			drawHandStatus();
		}, 5000);
	}

	function putDown() {
		if (!hand) {
			return;
		}

		const hadFocus = handBar.contains(document.activeElement);

		dropHand(hand.token);
		hand = null;
		handMessage = '';
		clearTimeout(handMessageTimer);
		handBar.hidden = true;
		drawTray();

		// Focus stays on the screen, not on a bar that is gone.
		if (hadFocus) {
			title.setAttribute('tabindex', '-1');
			title.focus({preventScroll: true});
		}
	}

	// The page placed on, in view when it is not.
	function showPage(pg) {
		if (spread && !spread.state().zoom && !spread.pages().includes(pg)) {
			spread.goTo(spreadOfPage(pg));
		}
	}

	// A tap on a pocket with the card in hand.
	function handAt(pg, position) {
		const slot = slotsOn(pg).get(position) || null;
		const waiting = Boolean(slot && slot.want && slot.want.card_id === hand.cardId && (!slot.want.catalog || slot.want.catalog === hand.catalog));

		if (slot && !waiting) {
			handSay('That pocket is taken. Tap an empty pocket.');

			return;
		}

		placeHand(pg, position, waiting ? slot.want : null);
	}

	async function placeHand(pg, position, want) {
		const pick = handPick();

		if (!pick) {
			handSay('Every copy of this card is in a pocket now.');

			return;
		}

		const binderId = binder.id;
		const entryId = pick.entry.id;

		putDown();

		try {
			await placeCard(binderId, pg, position, entryId);
		}
		catch (err) {
			showError('Could not place the card.', err);

			return;
		}

		showPage(pg);
		toast(`Placed on page ${pg}, pocket ${position}.`, {
			action: () => undoHandPlace({binderId, entryId, page: pg, position, trayId: pick.trayId, want}),
			actionLabel: 'Undo',
			timeout: UNDO_MS,
		});
	}

	// Undo for a placed card: the pocket as it was (empty, or the
	// placeholder), and the copy back in the tray it came from. A copy moved
	// again since stays where it is now.
	async function undoHandPlace({binderId, entryId, page: pg, position, trayId, want}) {
		try {
			const now = await binderLocation(entryId);

			if (!now || now.binder_id !== binderId || now.page !== pg || now.position !== position) {
				toast('That card has moved since, so it stays where it is.');

				return;
			}

			if (want) {
				await placePlaceholder(binderId, pg, position, want);
			}

			if (trayId) {
				await addToTray(trayId, [entryId]);
			}
			else if (!want) {
				await clearPocket(binderId, pg, position);
			}
		}
		catch (err) {
			showError('Could not undo.', err);
		}
	}

	function handNextFree() {
		const open = openPockets(binder, placed)[0];

		if (!open) {
			handSay('No empty pocket is left in this binder. Keep it in the tray, or add pages.');

			return;
		}

		placeHand(open.page, open.position, null);
	}

	async function handKeepTray() {
		const pick = handPick({toTray: true});

		if (!pick) {
			handSay('Every copy not in a pocket is in this tray already.');

			return;
		}

		const binderId = binder.id;
		const entryId = pick.entry.id;

		putDown();

		try {
			await addToTray(binderId, [entryId]);
		}
		catch (err) {
			showError('Could not put the card in the tray.', err);

			return;
		}

		toast(`In the tray of ${binder.name}.`, {
			action: () => (pick.trayId ? addToTray(pick.trayId, [entryId]) : takeFromTray(binderId, [entryId])).catch((err) => showError('Could not undo.', err)),
			actionLabel: 'Undo',
			timeout: UNDO_MS,
		});
	}

	const onHandKey = (event) => {
		if (hand && event.key === 'Escape' && !document.querySelector('dialog[open]')) {
			putDown();
		}
	};

	if (handBar) {
		handNext.addEventListener('click', handNextFree);
		handTray.addEventListener('click', handKeepTray);
		handCancel.addEventListener('click', putDown);
		handWaitButton.addEventListener('click', () => {
			const wait = handWaiting();

			if (wait) {
				placeHand(wait.page, wait.position, wait.want);
			}
		});
		document.addEventListener('keydown', onHandKey);
	}

	// ------------------------------------------------------- the tray
	//
	// Copies meant for this binder but in no pocket yet (js/binders.js
	// staged): small thumbnails docked above the tab bar (beside the spread
	// when the phone is sideways). Tap one to pick it, then tap a pocket to
	// place it, and the next one is picked; or drag it onto a pocket where
	// the pages are directly editable. "Fill the rest in order" puts the
	// rest in the pockets with nothing in them, in reading order.

	function trayIds() {
		const liveIds = new Set([...entriesById.values()].filter(isLive).map((entry) => entry.id));

		return trayOf(binder, {liveIds, placed});
	}

	// Pockets take a placed card while the pages are editable: the spread
	// held sideways or on a large screen, or a page zoomed open.
	const pocketsLive = () => Boolean(spread) && (spread.element.dataset.mode === 'direct' || Boolean(spread.state().zoom));

	function drawTrayStatus() {
		if (!tray) {
			return;
		}

		const ids = trayIds();
		const entry = picked && entriesById.get(picked);

		trayStatus.textContent = entry
			? (pocketsLive() ? `Tap a pocket for ${entryInfo(entry, index, viewing).name}` : 'Open a page, then tap a pocket')
			: `${plural(ids.length, 'card', 'cards')} to place`;

		if (spread) {
			spread.element.dataset.placing = picked || hand ? 'true' : '';
		}

		drawHandStatus();
	}

	function drawTray() {
		if (!tray) {
			return;
		}

		const ids = trayIds();

		// The card just placed has left the tray: pick the one now in its
		// place (after a swap, the card that was in the pocket), or none.
		if (picked && !ids.includes(picked)) {
			picked = advanceFrom !== null && ids.length ? ids[Math.min(advanceFrom, ids.length - 1)] : null;
		}

		advanceFrom = null;
		// The bar of a card in hand takes the tray's place while it shows.
		tray.hidden = !ids.length || Boolean(hand);
		trayStrip.replaceChildren(...ids.map((entryId) => {
			const entry = entriesById.get(entryId);
			const info = entryInfo(entry, index, viewing);

			return artOf(entry, info, (src) => h('button', {
				'aria-label': `${info.name}, ${languageLabel(entry.language)}`,
				'aria-pressed': String(entryId === picked),
				class: 'bt-card',
				'data-entry': entryId,
				role: 'listitem',
				type: 'button',
			}, cardArt(info, src)));
		}));

		for (const img of trayStrip.querySelectorAll('img')) {
			img.draggable = false;
		}

		drawTrayStatus();

		const shown = trayStrip.querySelector('.bt-card[aria-pressed="true"]');

		if (shown && typeof shown.scrollIntoView === 'function') {
			shown.scrollIntoView({block: 'nearest', inline: 'nearest'});
		}
	}

	function trayMessage(text) {
		clearTimeout(trayNoteTimer);
		trayNote.textContent = text;
		trayNote.hidden = !text;

		if (text) {
			trayNoteTimer = setTimeout(() => {
				trayNote.textContent = '';
				trayNote.hidden = true;
			}, 6000);
		}
	}

	// Places a tray card in a pocket; the next tray card is picked once the
	// save lands (drawTray).
	async function placeFromTrayAt(entryId, pg, position) {
		const slot = slotsOn(pg).get(position);

		if (slot && slot.art) {
			trayMessage('That pocket holds Michi art. Pick another.');

			return;
		}

		advanceFrom = trayIds().indexOf(entryId);
		picked = entryId;
		trayMessage('');

		try {
			await placeStaged(binder.id, pg, position, entryId);
		}
		catch (err) {
			advanceFrom = null;
			showError('Could not place the card.', err);
		}
	}

	async function fillRest() {
		picked = null;
		trayFill.disabled = true;

		try {
			const {left, placed: count} = await fillTray(binder.id);

			trayMessage(left
				? `${plural(count, 'card', 'cards')} placed. ${plural(left, 'card does', 'cards do')} not fit: add pages or free some pockets.`
				: `${plural(count, 'card', 'cards')} placed in order.`);
		}
		catch (err) {
			showError('Could not fill the binder from the tray.', err);
		}
		finally {
			trayFill.disabled = false;
		}
	}

	if (tray) {
		trayStrip.addEventListener('click', (event) => {
			const card = event.target.closest('.bt-card');

			if (!card || Date.now() < trayClickBlock) {
				return;
			}

			picked = picked === card.dataset.entry ? null : card.dataset.entry;
			trayMessage('');

			for (const item of trayStrip.querySelectorAll('.bt-card')) {
				item.setAttribute('aria-pressed', String(item.dataset.entry === picked));
			}

			drawTrayStatus();
		});
		trayFill.addEventListener('click', fillRest);
		trayDrag();
	}

	// Drag and drop from the tray onto a pocket, with a finger or a mouse:
	// pointer events, so it works where HTML drag and drop does not (touch).
	// A move along the strip scrolls it (touch-action in css/binders.css); a
	// move across it lifts the card.
	function trayDrag() {
		let drag = null;

		const pocketAt = (x, y) => {
			const hit = document.elementFromPoint(x, y);
			const pocket = hit && hit.closest('.bs-pocket');

			return pocket && !pocket.closest('[inert]') ? pocket : null;
		};

		const end = () => {
			if (drag && drag.ghost) {
				drag.ghost.remove();
			}

			if (drag && drag.over) {
				drag.over.classList.remove('bt-over');
			}

			drag = null;
		};

		trayStrip.addEventListener('pointerdown', (event) => {
			const card = event.target.closest('.bt-card');

			drag = card && event.isPrimary && !(event.pointerType === 'mouse' && event.button !== 0)
				? {card, ghost: null, id: card.dataset.entry, over: null, pointerId: event.pointerId, x: event.clientX, y: event.clientY}
				: null;
		});

		trayStrip.addEventListener('pointermove', (event) => {
			if (!drag || event.pointerId !== drag.pointerId) {
				return;
			}

			const dx = event.clientX - drag.x;
			const dy = event.clientY - drag.y;

			if (!drag.ghost) {
				if (Math.hypot(dx, dy) < 10) {
					return;
				}

				const column = getComputedStyle(trayStrip).flexDirection === 'column';
				const across = column ? Math.abs(dx) > Math.abs(dy) : Math.abs(dy) > Math.abs(dx);

				if (!across || !pocketsLive()) {
					drag = null;

					return;
				}

				const box = drag.card.getBoundingClientRect();

				drag.ghost = h('div', {'aria-hidden': 'true', class: 'bt-ghost', style: `width: ${box.width}px; height: ${box.height}px`}, drag.card.firstElementChild.cloneNode(true));
				document.body.append(drag.ghost);
				drag.half = {x: box.width / 2, y: box.height / 2};

				try {
					trayStrip.setPointerCapture(event.pointerId);
				}
				catch {
					// The pointer went away; pointerup or pointercancel ends it.
				}
			}

			event.preventDefault();
			drag.ghost.style.transform = `translate(${event.clientX - drag.half.x}px, ${event.clientY - drag.half.y}px)`;

			const over = pocketAt(event.clientX, event.clientY);

			if (over !== drag.over) {
				if (drag.over) {
					drag.over.classList.remove('bt-over');
				}

				if (over) {
					over.classList.add('bt-over');
				}

				drag.over = over;
			}
		});

		trayStrip.addEventListener('pointerup', (event) => {
			if (!drag || event.pointerId !== drag.pointerId) {
				return;
			}

			const {ghost, id: entryId} = drag;
			const target = ghost ? pocketAt(event.clientX, event.clientY) : null;

			end();

			if (ghost) {
				// The lift is not a tap on the card under the finger.
				trayClickBlock = Date.now() + 400;

				if (target) {
					placeFromTrayAt(entryId, Number(target.dataset.page), Number(target.dataset.position));
				}
			}
		});

		trayStrip.addEventListener('pointercancel', end);
		trayStrip.addEventListener('dragstart', (event) => event.preventDefault());
	}

	// ------------------------------------ adding many cards to the tray
	//
	// "Add cards to the tray": a picker over the copies in no binder yet
	// (js/binders.js trayCandidates), with a search, a set filter,
	// Filters (the sheet My Cards has, PICK_FILTERS), and the sort. Tap
	// tiles to select them, or Select all for what is shown, then add them
	// all; Undo on the toast takes them back out. Alike copies share one
	// tile with a count (pickKey), and a selected tile's "- N +" says how
	// many of them go. A binder made from a list
	// has no tray, so the button is hidden there. "From" narrows the copies
	// to one place they are stored in or one list (js/binder-sources.js
	// trayFromChoices), still only those in no pocket and no tray.

	function openTrayPicker() {
		if (!sheet || listMode) {
			return;
		}

		// Tile key -> how many of its copies go.
		const chosen = new Map();
		const message = h('p', {'aria-live': 'polite', class: 'form-error'});
		const search = h('input', {'aria-label': 'Search your cards', autocomplete: 'off', class: 'search', id: 'tray-search', placeholder: 'Search your cards', type: 'search'});
		const setFilter = h('select', {'aria-label': 'Set', id: 'tray-set'});
		const fromFilter = h('select', {id: 'tray-from'}, h('option', {value: ''}, 'All your cards'));
		const fromRow = h('label', {class: 'tray-from-row', hidden: true}, h('span', {class: 'tray-from-word'}, 'From'), h('span', {class: 'select-wrap'}, fromFilter));
		const count = h('p', {'aria-live': 'polite', class: 'muted', id: 'tray-count'});
		const selectAll = h('button', {class: 'small', id: 'tray-all', type: 'button'}, 'Select all');
		const results = h('div', {class: 'pick-grid', id: 'tray-results'});
		const more = h('button', {hidden: true, id: 'tray-more', type: 'button'}, 'Show more');
		const add = h('button', {class: 'primary', disabled: true, id: 'tray-add', type: 'button'}, 'Add to the tray');
		let shown = PICK_PAGE;

		const all = trayCandidates(data.cards, data.binders).map((entry) => ({entry, info: entryInfo(entry, index, viewing)}));
		// The candidates "From" leaves, and what it is doing.
		let items = all;
		let fromState = 'all';
		let fromRead = 0;
		const byName = (a, b) => a.info.name.localeCompare(b.info.name) || String(a.entry.created_at).localeCompare(String(b.entry.created_at));
		const setOf = (item) => item.info.setName || item.entry.set_name_local || '';

		function drawSets() {
			const counts = new Map();

			for (const item of items) {
				counts.set(setOf(item), (counts.get(setOf(item)) || 0) + 1);
			}

			const current = setFilter.value;
			const names = [...counts.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b));

			setFilter.replaceChildren(
				h('option', {value: ''}, `All sets (${formatCount(items.length)})`),
				...names.map((name) => h('option', {value: name}, `${name} (${formatCount(counts.get(name))})`))
			);
			setFilter.value = names.includes(current) ? current : '';
			bar.setItems(groupPicks(items).map((group) => pickFilterItem(group, index)));
		}

		function matches(item, query) {
			if (!query) {
				return true;
			}

			return item.info.search.includes(searchKey(query));
		}

		const found = () => {
			const query = search.value.trim().toLowerCase();
			const set = setFilter.value;

			return filterPicks(groupPicks(items.filter((item) => (!set || setOf(item) === set) && matches(item, query)).sort(byName)), bar.state, index);
		};
		const chosenOf = (group) => Math.min(chosen.get(group.key) || 0, group.items.length);
		const total = () => [...chosen.values()].reduce((sum, n) => sum + n, 0);

		function drawFoot() {
			const n = total();

			add.disabled = !n;
			add.textContent = n ? `Add ${plural(n, 'card', 'cards')} to the tray` : 'Add to the tray';
		}

		function tile(group) {
			const {entry, info} = group.items[0];
			const copies = group.items.length;
			const n = chosenOf(group);
			const on = n > 0;
			// Picking physical copies: the language always shows, and a
			// check marks the ones selected, with aria-pressed for screen
			// readers.
			const frame = artOf(group.items.map((item) => item.entry), info, (src) => tileArt({
				count: copies,
				finish: entryFinish(entry),
				info,
				languages: [entry.language],
				src,
				status: on ? 'owned' : null,
				statusLabel: on ? 'Selected' : null,
			}));
			const button = h('button', {'aria-pressed': String(on), class: 'pick tray-pick', 'data-entry': entry.id, type: 'button'},
				frame,
				h('span', {class: 'tile-name'}, info.name),
				h('span', {class: 'tile-meta'}, [info.number ? `#${info.number}` : null, info.setName].filter(Boolean).join(' · ') || entry.card_id)
			);
			const step = on && copies > 1
				? h('div', {'aria-label': `Copies of ${info.name} to add`, class: 'pick-step', role: 'group'},
					h('button', {'aria-label': 'One copy fewer', class: 'small pick-less', disabled: n <= 1, type: 'button'}, '−'),
					h('span', {class: 'pick-n'}, `${n} of ${copies}`),
					h('button', {'aria-label': 'One copy more', class: 'small pick-more', disabled: n >= copies, type: 'button'}, '+'))
				: null;

			return h('div', {class: 'pick-cell', 'data-key': group.key}, button, step);
		}

		function draw() {
			const list = fromState === 'reading' ? [] : found();
			const from = fromFilter.value ? fromFilter.selectedOptions[0].textContent : '';

			if (fromState === 'reading') {
				count.textContent = `Reading ${from}…`;
			}
			else if (fromState === 'failed') {
				count.textContent = `Could not read ${from}. Try again, or choose another.`;
			}
			else if (!all.length) {
				count.textContent = 'Every card you own is in a binder or a tray already.';
			}
			else if (!items.length) {
				count.textContent = `No cards from ${from} are waiting: they are in a binder or a tray already, or there are none.`;
			}
			else if (!list.length) {
				count.textContent = 'No cards match.';
			}
			else {
				count.textContent = from
					? `${plural(copiesIn(list), 'card', 'cards')} from ${from} not in a binder yet.`
					: `${plural(copiesIn(list), 'card', 'cards')} not in a binder yet.`;
			}

			selectAll.hidden = !list.length;
			selectAll.textContent = list.length && list.every((group) => chosenOf(group) >= group.items.length)
				? 'Select none'
				: `Select all ${formatCount(copiesIn(list))}`;
			results.replaceChildren(...list.slice(0, shown).map(tile));
			more.hidden = list.length <= shown;
			more.textContent = `Show more (${formatCount(list.length - shown)} left)`;
			drawFoot();

			// Names and images for the copies shown that the phone has no
			// catalog record for yet.
			fillRecords(list.slice(0, shown).map(({items: [item]}) => ({cardId: item.entry.card_id, catalog: item.entry.catalog})), index, () => alive && sheet.open)
				.then((filled) => {
					if (filled && alive && sheet.open) {
						index = filled;

						for (const item of all) {
							item.info = entryInfo(item.entry, index, viewing);
						}

						drawSets();
						draw();
					}
				})
				.catch(() => {});
		}

		const restart = () => {
			shown = PICK_PAGE;
			message.textContent = '';
			bar.refresh();
			draw();
		};

		// Clear all clears the search, the set, and From as well.
		const bar = pickerBar({
			countShown: () => found().length,
			filters: TRAY_FILTERS,
			id: 'tray',
			narrowed: () => search.value.trim() !== '' || setFilter.value !== '' || fromFilter.value !== '',
			onChange: () => restart(),
			onClearAll: () => {
				search.value = '';
				setFilter.value = '';

				if (fromFilter.value) {
					fromFilter.value = '';
					fromFilter.dispatchEvent(new Event('change'));
				}
			},
		});

		// A tap on a tile selects all its copies, or none; - and + under a
		// selected tile take one copy off or put one back, 1 to all of them.
		results.addEventListener('click', (event) => {
			const control = event.target.closest('.tray-pick, .pick-less, .pick-more');
			const cell = control && control.closest('.pick-cell');
			const group = cell && found().find((item) => item.key === cell.dataset.key);

			if (!group) {
				return;
			}

			const n = chosenOf(group);
			const which = ['tray-pick', 'pick-less', 'pick-more'].find((name) => control.classList.contains(name));

			if (which === 'tray-pick') {
				if (n) {
					chosen.delete(group.key);
				}
				else {
					chosen.set(group.key, group.items.length);
				}
			}
			else {
				chosen.set(group.key, Math.max(1, Math.min(group.items.length, n + (which === 'pick-more' ? 1 : -1))));
			}

			// Drawn again for the counts, keeping focus on what was tapped,
			// or on the tile once that is disabled.
			draw();

			const at = `.pick-cell[data-key="${CSS.escape(group.key)}"]`;
			const again = results.querySelector(`${at} .${which}:not(:disabled)`) || results.querySelector(`${at} .tray-pick`);

			if (again) {
				again.focus();
			}
		});

		selectAll.addEventListener('click', () => {
			const list = found();
			const every = list.every((group) => chosenOf(group) >= group.items.length);

			for (const group of list) {
				if (every) {
					chosen.delete(group.key);
				}
				else {
					chosen.set(group.key, group.items.length);
				}
			}

			draw();
		});

		search.addEventListener('input', restart);
		// The English names load once; a search typed before they are in runs again.
		loadedSpeciesNames(() => alive && sheet.open && search.value.trim() && draw());
		setFilter.addEventListener('change', restart);
		fromFilter.addEventListener('change', async () => {
			const value = fromFilter.value;
			const read = ++fromRead;

			if (!value) {
				items = all;
				fromState = 'all';
				drawSets();
				restart();

				return;
			}

			fromState = 'reading';
			restart();

			try {
				const ids = await trayFromIds(value, await loadDocument(), {index, isAlive: () => alive && sheet.open});

				if (read !== fromRead) {
					return;
				}

				items = all.filter((item) => ids.has(item.entry.id));
				fromState = 'shown';
			}
			catch {
				if (read !== fromRead) {
					return;
				}

				items = [];
				fromState = 'failed';
			}

			drawSets();
			restart();
		});

		// The places and lists, once the document is read.
		loadDocument().then((doc) => {
			const groups = trayFromChoices(doc);

			if (!groups.length || !alive) {
				return;
			}

			fromFilter.append(...groups.map((group) => h('optgroup', {label: group.label}, ...group.options.map((option) => h('option', {value: option.value}, option.label)))));
			fromRow.hidden = false;
		}).catch(() => {});
		more.addEventListener('click', () => {
			shown += PICK_PAGE;
			draw();
		});

		add.addEventListener('click', async () => {
			// In the order shown, so the tray fills in the same order. Of a
			// tile's copies, those "From" shows go first.
			const shownIds = new Set(items.map((item) => item.entry.id));
			const ids = filterPicks(groupPicks([...all].sort(byName)), {filters: null, sort: bar.state.sort}, index)
				.filter((group) => chosen.get(group.key))
				.flatMap((group) => group.items
					.map((item) => item.entry.id)
					.sort((a, b) => shownIds.has(b) - shownIds.has(a))
					.slice(0, chosen.get(group.key)));
			const target = binder;

			add.disabled = true;

			// A card this binder has a placeholder for goes into it, with
			// "Fill binder placeholders automatically" on (js/placeholder-fill.js).
			let result;

			try {
				result = await addToBinder(target.id, ids);
			}
			catch (err) {
				message.textContent = `Could not add the cards to the tray. ${err.message || errorText(err)}`;
				drawFoot();

				return;
			}

			closeSheet();

			const into = result.placed.length ? `${plural(result.placed.length, 'card', 'cards')} went into ${target.name}'s placeholders` : '';
			const trayed = result.staged.length ? `${plural(result.staged.length, 'card', 'cards')} added to the tray of ${target.name}` : '';

			toast(`${[into, trayed].filter(Boolean).join('; ')}.`, {
				action: () => {
					undoAddToBinder(target.id, result).catch((err) => toast(`Could not take them back out. ${errorText(err)}`));
				},
				actionLabel: 'Undo',
				timeout: UNDO_MS,
			});
		});

		sheet.replaceChildren(
			h('div', {class: 'sheet-head'},
				h('h3', {id: 'sheet-title'}, 'Add cards to the tray'),
				h('button', {'aria-label': 'Close', class: 'small', id: 'sheet-close', onclick: closeSheet, type: 'button'}, 'Close')
			),
			h('p', {class: 'muted', id: 'tray-intro'}, 'Pick the cards you own that are not in a binder yet. They wait in the tray until you place them.'),
			fromRow,
			search,
			// As the pocket's chooser: the sort and Filters on one row; the
			// set menu has its own row, so "All sets (12)" is never cut, and
			// Select all sits beside the count it selects (design polish,
			// 2026-11-06).
			h('div', {class: 'select-wrap tray-set-row'}, setFilter),
			bar.element,
			h('div', {class: 'tray-count-row'}, count, selectAll),
			results,
			more,
			h('div', {class: 'tray-pick-foot'}, message, add)
		);

		if (!sheet.open) {
			openDialogSheet(sheet);
		}

		// Drawn once the sheet is open, so the names it lacks are read.
		drawSets();
		draw();

		if (finePointer()) {
			search.focus();
		}
	}

	// ------------------------------------ moving a pocket to another one
	//
	// From a long press and drag, or Move to pocket in the sheet: into an
	// empty pocket, or swapping with what is there. Undo on the toast moves
	// both back, unless either pocket has changed since.

	function slotIn(fresh, where) {
		return slotsOf(fresh).find((slot) => slot.page === where.page && slot.position === where.position) || null;
	}

	async function movePockets(from, to) {
		if (!binder || listMode || (from.page === to.page && from.position === to.position)) {
			return;
		}

		const binderId = binder.id;
		const moving = slotIn(binder, from);
		const there = slotIn(binder, to);

		if (!moving) {
			return;
		}

		try {
			await movePocket(binderId, from, to);
		}
		catch (err) {
			showError('Could not move the card.', err);

			return;
		}

		const what = moving.want ? 'the placeholder' : 'the card';

		toast(there
			? `Swapped page ${from.page}, pocket ${from.position} with page ${to.page}, pocket ${to.position}.`
			: `Moved ${what} to page ${to.page}, pocket ${to.position}.`, {
			action: () => undoMove({binderId, from, moved: contentKey(moving), swapped: contentKey(there), to}),
			actionLabel: 'Undo',
			timeout: UNDO_MS,
		});
	}

	async function undoMove({binderId, from, moved, swapped, to}) {
		try {
			const fresh = await getBinder(binderId);

			if (!fresh || contentKey(slotIn(fresh, to)) !== moved || contentKey(slotIn(fresh, from)) !== swapped) {
				toast('Those pockets have changed since, so they stay as they are.');

				return;
			}

			await movePocket(binderId, to, from);
		}
		catch (err) {
			showError('Could not undo.', err);
		}
	}

	// The sheet's way to move: a page and a pocket, or the next free pocket.
	function movePanel(page, position) {
		const per = pocketsPerPage(binder);
		const pageSelect = h('select', {'aria-label': 'Page', id: 'move-page'},
			...Array.from({length: binder.page_count}, (_, i) => h('option', {selected: i + 1 === page, value: i + 1}, `Page ${i + 1}`)));
		const pocketSelect = h('select', {'aria-label': 'Pocket', id: 'move-pocket'});
		const holds = h('p', {'aria-live': 'polite', class: 'muted', id: 'move-holds'});
		const moveButton = h('button', {class: 'primary', id: 'move-go', type: 'button'}, 'Move here');
		const shiftButton = h('button', {class: 'primary', hidden: true, id: 'move-shift', type: 'button'}, 'Move here, shifting the cards between');
		const target = () => ({page: Number(pageSelect.value), position: Number(pocketSelect.value)});

		const describe = () => {
			const where = target();
			const slot = slotIn(binder, where);

			moveButton.disabled = where.page === page && where.position === position;
			holds.textContent = moveButton.disabled
				? 'This is the pocket it is in now.'
				: slot ? `Holds ${pocketContent(slot).label}. Move here shifts it and the cards between one pocket to make room; Swap trades the two.` : 'Empty.';
			moveButton.textContent = slot ? 'Swap with this pocket' : 'Move here';
			moveButton.classList.toggle('primary', !slot);
			shiftButton.hidden = !slot || moveButton.disabled;
		};

		const fillPockets = () => {
			const shownPage = Number(pageSelect.value);
			const slots = Array.from({length: per}, (_, i) => slotIn(binder, {page: shownPage, position: i + 1}));
			// The first empty pocket on the page, else the first other one.
			const empty = slots.findIndex((slot, i) => !slot && !(shownPage === page && i + 1 === position));
			const other = shownPage === page ? (position === per ? 1 : position + 1) : 1;

			// Short, so the two pickers fit side by side at 360 px; what the
			// pocket holds is the line under them.
			pocketSelect.replaceChildren(...slots.map((slot, i) => h('option', {value: i + 1}, `Pocket ${i + 1}${slot ? '' : ' (empty)'}`)));
			pocketSelect.value = String(empty >= 0 ? empty + 1 : Math.min(other, per));
			describe();
		};

		pageSelect.addEventListener('change', fillPockets);
		pocketSelect.addEventListener('change', describe);
		moveButton.addEventListener('click', () => act(() => movePockets({page, position}, target()), 'Could not move the card.'));
		shiftButton.addEventListener('click', () => act(() => shiftPockets({page, position}, target()), 'Could not move the card.'));

		const free = openPockets(binder, placed)[0];
		const nextFree = free
			? h('button', {id: 'move-next-free', onclick: () => act(() => movePockets({page, position}, free), 'Could not move the card.'), type: 'button'}, `Move to the next free pocket (page ${free.page}, pocket ${free.position})`)
			: h('p', {class: 'muted', id: 'move-no-free'}, 'No empty pocket is left in this binder.');

		fillPockets();

		return h('div', {class: 'move-panel', hidden: true, id: 'move-panel'},
			h('h4', null, 'Move to…'),
			h('button', {class: 'primary move-end', id: 'move-end', onclick: () => act(() => shiftPockets({page, position}, 'end'), 'Could not move the card.'), type: 'button'}, 'End of the binder'),
			h('p', {class: 'muted move-or'}, 'Or a pocket:'),
			h('div', {class: 'button-row'}, pageSelect, pocketSelect),
			holds,
			h('div', {class: 'button-row'}, shiftButton, moveButton, nextFree)
		);
	}

	// Remove from this binder, then Leave the pocket empty or Shift the rest
	// back (Eric, 2026-11-06). note says where the content goes.
	function removePanel({note, onEmpty, onShift}) {
		return h('div', {class: 'remove-panel', hidden: true, id: 'remove-panel'},
			h('h4', null, 'Remove from this binder'),
			h('p', {class: 'muted', id: 'remove-note'}, note),
			h('div', {class: 'button-row'},
				h('button', {id: 'remove-empty', onclick: onEmpty, type: 'button'}, 'Leave the pocket empty'),
				h('button', {class: 'primary', id: 'remove-shift', onclick: onShift, type: 'button'}, 'Shift the rest back'))
		);
	}

	// Undo on the toast of a shift: every pocket back, only while each holds
	// what the shift put there (js/binders.js undoShift).
	const shiftUndo = (done) => ({
		action: async () => {
			try {
				const result = await undoShifted(done);

				if (!result.back) {
					toast('Those pockets have changed since, so they stay as they are.');
				}
			}
			catch (err) {
				showError('Could not undo.', err);
			}
		},
		actionLabel: 'Undo',
		timeout: UNDO_MS,
	});

	// Move to... with the cards between shifting: to a pocket, or 'end'.
	async function shiftPockets(from, to) {
		if (!binder || listMode) {
			return;
		}

		const moving = slotIn(binder, from);

		if (!moving) {
			return;
		}

		const label = pocketContent(moving).label;
		const result = await moveWithShift(binder.id, from, to, {expect: contentKey(moving)});

		if (!result.changed.length) {
			toast(to === 'end' ? `${label} is the last pocket in use already.` : 'Nothing moved.');

			return;
		}

		toast(to === 'end'
			? `Moved ${label} to the end of the binder, page ${result.to.page}, pocket ${result.to.position}.`
			: `Moved ${label} to page ${result.to.page}, pocket ${result.to.position}; the cards between shifted one pocket.`, shiftUndo(result.done));
	}

	// Remove from this binder: the pocket's content leaves it (a card goes to
	// no binder and no tray), and the pocket stays empty or the rest shift
	// back one pocket.
	async function removeHere(page, position, shift) {
		const slot = slotIn(binder, {page, position});

		if (!slot) {
			return;
		}

		const label = pocketContent(slot).label;
		const result = await removeFromBinder(binder.id, {page, position}, {expect: contentKey(slot), shift});

		toast(shift
			? `Removed ${label}; the pockets after it moved back one.`
			: `Removed ${label}. Page ${page}, pocket ${position} stays empty.`, shiftUndo(result.done));
	}

	// ------------------------------------------- a card out of its pocket
	//
	// A tap on a pocket holding a card takes the card out, large, over the
	// dimmed binder (js/pocket-viewer.js; Eric, 2026-11-06), with what that
	// pocket's sheet offers there: Edit pocket (the sheet itself), To the
	// tray, Move, and Card page on your own hand-made binder; Edit pocket and
	// Card page on a binder from a list; Card page alone read only. A tap
	// that places a tray card or the card in hand never gets here. Edit
	// pocket was "Details"; not "Edit copy", since the sheet changes what the
	// pocket holds (another card, which copy shows), never the copy itself
	// (design polish, 2026-11-06).

	// The pocket's element now, for the card to come from and go back to:
	// the one tapped while it is on the page, else the one drawn since that
	// is on screen (the spread draws pockets again on a sync).
	function pocketOrigin(pg, position, tapped) {
		return () => {
			if (tapped && tapped.isConnected && tapped.getClientRects().length) {
				return tapped;
			}

			const drawn = spread ? [...spread.element.querySelectorAll(`.pocket[data-page="${pg}"][data-position="${position}"]`)] : [];

			return drawn.find((node) => node.getClientRects().length > 0) || null;
		};
	}

	function showCard({actions, entry, info, pg, position, tapped}) {
		const records = recordsShown();

		openPocketViewer({
			actions,
			art: (src) => cardArt(info, src, {eager: true}),
			origin: pocketOrigin(pg, position, tapped),
			// Pockets open on the page's outer edge: right on a right-hand
			// (odd) page, left on a left-hand one.
			outward: pg % 2 === 1 ? 1 : -1,
			slide: mainSlide(entry, info.full || info.image, records ? {family: false, records} : {}),
			subtitle: `${languageLabel(entry.language)} · Page ${pg}, pocket ${position}`,
			title: info.name,
		});
	}

	function viewPocket(pg, position, tapped) {
		const slot = slotsOn(pg).get(position) || null;
		const entry = slot && slot.entry_id ? entriesById.get(slot.entry_id) : null;

		if (!entry || !isLive(entry)) {
			if (!source.readOnly) {
				openSheet(pg, position);
			}

			return;
		}

		const info = entryInfo(entry, index, viewing);
		const actions = [];

		if (!source.readOnly) {
			actions.push({id: 'pv-details', label: 'Edit pocket', run: () => openSheet(pg, position)});
			// Only the copy shown: a sync may have changed the pocket since.
			actions.push({id: 'pv-to-tray', label: 'To the tray', run: () => moveToTray(binder.id, pg, position, entry.id).catch((err) => toast(err.message || `Could not move the card to the tray. ${errorText(err)}`))});

			// As the sheet: a one-pocket binder has nowhere to move to.
			if (pocketsPerPage(binder) * binder.page_count > 1) {
				actions.push({id: 'pv-move', label: 'Move to…', run: () => openSheet(pg, position, {move: true})});
			}

			actions.push({id: 'pv-remove', label: 'Remove from this binder', run: () => openSheet(pg, position, {remove: true})});
		}

		if (info.route) {
			actions.push({id: 'pv-card-page', label: 'Card page', route: info.route});
		}

		showCard({actions, entry, info, pg, position, tapped});
	}

	function viewListPocket(pg, position, tapped) {
		const state = listState(indexAt(pg, position, binder.rows, binder.cols));

		if (!state || !state.shown) {
			return;
		}

		const {entry} = state.shown;
		const info = entryInfo(entry, index, viewing);
		const actions = source.readOnly ? [] : [
			{id: 'pv-details', label: 'Edit pocket', run: () => openListSheet(pg, position)},
			{id: 'pv-move', label: 'Move to…', run: () => openListSheet(pg, position, {move: true})},
			{id: 'pv-remove', label: 'Remove from this binder', run: () => openListSheet(pg, position, {remove: true})},
		];

		if (info.route) {
			actions.push({id: 'pv-card-page', label: 'Card page', route: info.route});
		}

		showCard({actions, entry, info, pg, position, tapped});
	}

	// ------------------------------------------- lay out from a list
	//
	// A hand-made binder takes a checklist's Pokémon as placeholders in its
	// empty pockets, in Pokédex order (js/binder-layout.js; Eric,
	// 2026-11-06). A sheet picks the list and shows what would happen, then
	// one save, with Undo on the toast.

	let closeLayout = () => {};

	async function openLayout() {
		let doc;

		try {
			doc = await loadDocument();
		}
		catch (err) {
			showError('Could not open the lists.', err);

			return;
		}

		if (!alive || !binder || listMode) {
			return;
		}

		const binderId = binder.id;
		const lists = sourceChoices(doc).checklist;
		const box = h('dialog', {'aria-labelledby': 'layout-title', class: 'pocket-sheet resize-sheet', id: 'layout-sheet'});
		const select = h('select', {'aria-label': 'Checklist', id: 'layout-list'}, lists.map((item) => h('option', {value: item.id}, item.name)));
		const from = h('div', {'aria-label': 'Where the placeholders go', class: 'resize-choice', id: 'layout-from', role: 'radiogroup'},
			h('label', null, h('input', {checked: true, id: 'layout-from-after', name: 'layout-from', type: 'radio', value: 'after'}), h('span', null, 'After the last pocket in use')),
			h('label', null, h('input', {id: 'layout-from-start', name: 'layout-from', type: 'radio', value: 'start'}), h('span', null, 'Every empty pocket from page 1')));
		const lines = h('div', {'aria-live': 'polite', class: 'resize-lines', id: 'layout-preview'});
		const addPages = h('input', {id: 'layout-add-pages', type: 'checkbox'});
		const addText = h('span', {id: 'layout-add-text'});
		// A bordered 48 px row, as the radio rows above it.
		const addRow = h('label', {class: 'layout-add', hidden: true, id: 'layout-add'}, addPages, addText);
		const message = h('p', {'aria-live': 'polite', class: 'form-error', id: 'layout-error'});
		const cancel = h('button', {id: 'layout-cancel', type: 'button'}, lists.length ? 'Cancel' : 'Close');
		const go = h('button', {class: 'primary', disabled: true, id: 'layout-go', type: 'button'}, 'Lay out');
		let loaded = null;
		let asked = 0;
		let handle = null;

		const fromValue = () => from.querySelector('input:checked').value;
		const options = () => ({addPages: addPages.checked, from: fromValue()});

		function finish() {
			closeLayout = () => {};

			if (handle) {
				handle.close();
			}
		}

		// The preview for the list read and the choices now; the latest wins.
		async function draw() {
			const ticket = ++asked;

			go.disabled = true;
			message.textContent = '';

			if (!loaded) {
				return;
			}

			if (loaded.gone) {
				lines.replaceChildren(h('p', null, 'That list was deleted. Choose another.'));

				return;
			}

			try {
				const preview = await previewLayout(binderId, loaded, options());

				if (ticket !== asked || !box.open) {
					return;
				}

				const offer = addPagesText(preview.plan, pocketsPerPage(binder));

				lines.replaceChildren(...previewLines(preview, {from: fromValue(), partial: loaded.partial}).map((line) => h('p', null, line)));
				addText.textContent = offer || addText.textContent;
				addRow.hidden = !offer && !addPages.checked;
				go.disabled = !preview.plan.pockets.length;
			}
			catch (err) {
				if (ticket === asked) {
					message.textContent = `Could not work it out. ${err.message || errorText(err)}`;
				}
			}
		}

		async function read() {
			const ticket = ++asked;

			loaded = null;
			addPages.checked = false;
			addRow.hidden = true;
			go.disabled = true;
			lines.replaceChildren(h('p', {class: 'muted'}, 'Reading the list and your cards…'));

			try {
				const result = await readList(select.value, {index, isAlive: () => alive && box.open});

				if (ticket !== asked || !box.open) {
					return;
				}

				loaded = result;
				index = result.index || index;
				draw();
			}
			catch (err) {
				if (ticket === asked) {
					lines.replaceChildren();
					message.textContent = `The list could not be read. ${err.message || errorText(err)}`;
				}
			}
		}

		select.addEventListener('change', read);
		from.addEventListener('change', draw);
		addPages.addEventListener('change', draw);
		cancel.addEventListener('click', finish);
		box.addEventListener('click', (event) => {
			if (event.target === box) {
				finish();
			}
		});
		go.addEventListener('click', async () => {
			const name = loaded.name || 'the list';

			go.disabled = true;
			cancel.disabled = true;

			let result;

			try {
				result = await applyLayout(binderId, loaded, options());
			}
			catch (err) {
				go.disabled = false;
				cancel.disabled = false;
				message.textContent = `Could not lay it out. Nothing was changed. ${err.message || errorText(err)}`;

				return;
			}

			finish();
			toast(doneText(result, name), {
				action: () => {
					undoLayout(result.done)
						.then((undone) => toast(undoText(undone, result.done)))
						.catch((err) => toast(`Could not undo. ${errorText(err)}`));
				},
				actionLabel: 'Undo',
				timeout: UNDO_MS,
			});
		});

		box.append(
			h('div', {class: 'sheet-head'}, h('h3', {id: 'layout-title'}, `Lay out ${binder.name} from a list`)),
			...(lists.length
				? [
					// One sentence (design polish, 2026-11-06): the preview
					// under it says what is skipped and where it starts.
					h('p', {class: 'muted', id: 'layout-intro'}, 'Puts the list\'s Pokémon in empty pockets as placeholders, in Pokédex order.'),
					h('label', {class: 'field-label', for: 'layout-list'}, 'Checklist'),
					h('span', {class: 'select-wrap'}, select),
					from,
					lines,
					addRow,
				]
				: [h('p', {id: 'layout-none'}, 'You have no checklists yet. Make one in the Lists tab, such as a region, then come back.')]),
			// Lay out and Cancel stay in reach at the sheet's foot while the
			// preview scrolls (design polish, 2026-11-06: off screen at 740
			// px tall).
			h('div', {class: 'sheet-foot', id: 'layout-foot'},
				message,
				h('div', {class: 'button-row'}, cancel, lists.length ? go : null))
		);
		root.append(box);
		handle = openDialogSheet(box, {onClose: () => {
			closeLayout = () => {};
			box.remove();
		}});
		closeLayout = finish;

		if (lists.length) {
			select.focus();
			read();
		}
		else {
			cancel.focus();
		}
	}

	// ------------------------------------------------- the pocket sheet

	function closeSheet() {
		if (sheet && sheet.open) {
			sheet.close();
		}
	}

	async function act(work, failText) {
		try {
			await work();
			closeSheet();
		}
		catch (err) {
			const box = sheet.querySelector('.form-error');

			if (box) {
				box.textContent = `${failText} ${err.message || errorText(err)}`;
			}
			else {
				showError(failText, err);
			}
		}
	}

	// How many copies like the one in a pocket you have (same card,
	// language, finish, and condition), with a stepper to fix the count while
	// paging through the binder (js/copy-sheet.js). The copy in the pocket
	// stays there: the count never goes below 1, and + adds copies in no
	// pocket. Copies are alike only in the same Stored in place (alikeKey),
	// so the label names the place when the pocket's copy has one.
	function pocketCount(entry, label) {
		const key = alikeKey(entry);
		const alike = [...entriesById.values()].filter((item) => isLive(item) && alikeKey(item) === key);
		const places = new Map([...placed].map(([entryId, where]) => [entryId, {binder_id: where.binder.id, binder_name: where.binder.name, page: where.slot.page, position: where.slot.position}]));

		return h('div', {class: 'pocket-count', id: 'pocket-count'},
			h('p', {class: 'pocket-count-label', id: 'pocket-count-label'}, entry.storage ? `Copies like this, stored in ${entry.storage}` : 'Copies like this'),
			copyStepper({entries: alike, keep: entry.id, label, min: 1, places}).element
		);
	}

	// The sheet for one pocket. The page travels with it, so a redraw while
	// it is open (a sync, a turn) cannot move what it saves to another page.
	// move: open on Move to... (the Move to... of a card out of its pocket);
	// remove: open on Remove from this binder.
	function openSheet(page, position, {move = false, remove = false} = {}) {
		const slot = pageSlots(binder, page, placed).get(position) || null;
		const content = pocketContent(slot);
		const chooser = h('div', {class: 'chooser', hidden: Boolean(slot)});
		const message = h('p', {'aria-live': 'polite', class: 'form-error'});
		const per = pocketsPerPage(binder) * binder.page_count;
		const mover = slot && ['card', 'gone', 'want'].includes(content.kind) && per > 1 ? movePanel(page, position) : null;
		const remover = slot && !slot.art
			? removePanel({
				note: content.kind === 'card'
					? 'The card leaves this binder and goes to Not in a binder. To keep it for this binder, use To the tray.'
					: content.kind === 'want' ? 'The placeholder goes.' : 'The pocket is free again.',
				onEmpty: () => act(() => removeHere(page, position, false), 'Could not remove it.'),
				onShift: () => act(() => removeHere(page, position, true), 'Could not remove it.'),
			})
			: null;

		const header = h('div', {class: 'sheet-head'},
			h('h3', {id: 'sheet-title'}, `Page ${page}, pocket ${position}`),
			h('button', {'aria-label': 'Close', class: 'small', id: 'sheet-close', onclick: closeSheet, type: 'button'}, 'Close')
		);

		const current = slot
			? h('div', {class: 'sheet-current'},
				h('p', {class: 'big', id: 'sheet-current-label'}, content.label),
				content.kind === 'card' ? pocketCount(entriesById.get(slot.entry_id), content.label) : null,
				h('div', {class: 'button-row'},
					content.info && content.info.route && (content.kind === 'card' || content.kind === 'want')
						? link(content.info.route, {class: 'button', onclick: closeSheet}, 'Open card')
						: null,
					slot.art
						? null
						: h('button', {id: 'pocket-change', onclick: (event) => {
							event.currentTarget.closest('.sheet-current').hidden = true;
							chooser.hidden = false;
						}, type: 'button'}, 'Change'),
					['card', 'gone', 'want'].includes(content.kind) && per > 1
						? h('button', {id: 'pocket-move', onclick: (event) => {
							event.currentTarget.closest('.sheet-current').hidden = true;
							mover.hidden = false;
							mover.querySelector('#move-page').focus();
						}, type: 'button'}, 'Move to…')
						: null,
					content.kind === 'card'
						? h('button', {id: 'pocket-to-tray', onclick: () => act(() => moveToTray(binder.id, page, position, slot.entry_id), 'Could not move the card to the tray.'), type: 'button'}, 'To the tray')
						: null,
					slot.art
						? h('p', {class: 'muted'}, 'Michi art is edited with the art tools, which are not here yet.')
						: h('button', {class: 'danger', id: 'pocket-clear', onclick: (event) => {
							event.currentTarget.closest('.sheet-current').hidden = true;
							remover.hidden = false;
							remover.querySelector('#remove-shift').focus();
						}, type: 'button'}, 'Remove from this binder')
				))
			: null;

		chooser.append(...pocketChooser(page, position, message));
		sheet.replaceChildren(header, current || '', mover || '', remover || '', chooser, message);
		// On a phone focus goes to Close, not the search field: most people
		// scroll the list, and a focused field raises the keyboard over it.
		// With a mouse the search takes it. Back closes the sheet instead of
		// leaving the binder.
		if (!sheet.open) {
			openDialogSheet(sheet);
		}

		if (!slot && finePointer()) {
			sheet.querySelector('#owned-search').focus();
		}

		if (move && mover) {
			current.hidden = true;
			mover.hidden = false;
			mover.querySelector('#move-page').focus();
		}
		else if (remove && remover) {
			current.hidden = true;
			remover.hidden = false;
			remover.querySelector('#remove-shift').focus();
		}
	}

	// The three ways to fill a pocket: one of your cards, a placeholder, or
	// empty on purpose.
	function pocketChooser(page, position, message) {
		const ownedPanel = h('div', {id: 'owned-panel'});
		const wantPanel = h('div', {hidden: true, id: 'want-panel'});
		const tabs = h('div', {class: 'segmented sheet-tabs', role: 'radiogroup'},
			h('label', null, h('input', {checked: true, id: 'choose-owned', name: 'pocket-choice', type: 'radio', value: 'owned'}), h('span', null, 'Your cards')),
			h('label', null, h('input', {id: 'choose-want', name: 'pocket-choice', type: 'radio', value: 'want'}), h('span', null, 'Placeholder'))
		);

		tabs.addEventListener('change', () => {
			const want = tabs.querySelector('input:checked').value === 'want';

			ownedPanel.hidden = want;
			wantPanel.hidden = !want;

			// A placeholder is found by typing its name; your cards are
			// mostly scrolled, so their search waits for a tap.
			if (want) {
				wantPanel.querySelector('#want-search').focus();
			}
		});

		ownedPanel.append(...ownedPicker(page, position, message));
		wantPanel.append(...wantPicker(page, position, message));

		return [
			tabs,
			ownedPanel,
			wantPanel,
			h('button', {class: 'leave-empty', id: 'pocket-leave-empty', onclick: () => act(() => leaveEmpty(binder.id, page, position), 'Could not save the pocket.'), type: 'button'}, 'Leave empty on purpose'),
		];
	}

	// Your cards, those not in a binder yet first. Alike copies not in a
	// pocket share one tile with a count (pickKey), and a tap places one of
	// them, one in no tray if it can; a copy in a pocket keeps its own tile,
	// which says where it is.
	function ownedPicker(page, position, message) {
		const search = h('input', {'aria-label': 'Search your cards', autocomplete: 'off', class: 'search', id: 'owned-search', placeholder: 'Search your cards', type: 'search'});
		const filter = h('div', {class: 'segmented', id: 'owned-filter', role: 'radiogroup'},
			h('label', null, h('input', {checked: true, name: 'owned-filter', type: 'radio', value: 'unplaced'}), h('span', null, 'Not in a binder')),
			h('label', null, h('input', {name: 'owned-filter', type: 'radio', value: 'all'}), h('span', null, 'All my cards'))
		);
		const count = h('p', {'aria-live': 'polite', class: 'muted', id: 'owned-count'});
		const results = h('div', {class: 'pick-grid', id: 'owned-results'});
		const confirmBox = h('div', {class: 'move-confirm', hidden: true, id: 'move-confirm', role: 'alertdialog'});
		const more = h('button', {hidden: true, id: 'owned-more', type: 'button'}, 'Show more');
		let shown = PICK_PAGE;

		const live = data.cards.filter(isLive).map((entry) => ({entry, info: entryInfo(entry, index, viewing), where: locate(data.binders, entry.id)}));
		const free = new Set(trayCandidates(data.cards, data.binders).map((entry) => entry.id));

		live.sort((a, b) => (Boolean(a.where) - Boolean(b.where)) || a.info.name.localeCompare(b.info.name) || String(a.entry.created_at).localeCompare(String(b.entry.created_at)));

		function matches(item, query) {
			if (!query) {
				return true;
			}

			return item.info.search.includes(searchKey(query));
		}

		function choose(item) {
			const {entry, where} = item;

			if (where && where.binder_id === binder.id && where.page === page && where.position === position) {
				closeSheet();

				return;
			}

			if (!where) {
				act(() => placeCard(binder.id, page, position, entry.id), 'Could not place the card.');

				return;
			}

			confirmBox.replaceChildren(
				h('p', {id: 'move-text'}, `This copy is in ${where.binder_name}, page ${where.page}, pocket ${where.position}. Move it here?`),
				h('div', {class: 'button-row'},
					h('button', {id: 'move-no', onclick: () => {
						confirmBox.hidden = true;
					}, type: 'button'}, 'Cancel'),
					h('button', {class: 'primary', id: 'move-yes', onclick: () => act(() => placeCard(binder.id, page, position, entry.id), 'Could not move the card.'), type: 'button'}, 'Move it here')
				)
			);
			confirmBox.hidden = false;
			confirmBox.querySelector('#move-yes').focus();
		}

		const onlyLoose = () => filter.querySelector('input:checked').value === 'unplaced';
		const tilesOf = (list) => groupPicks(list, (item) => (item.where ? item.entry.id : pickKey(item.entry)));
		// The tiles the search and Filters leave.
		const visible = () => {
			const query = search.value.trim().toLowerCase();

			const groups = filterPicks(tilesOf(live.filter((item) => (!onlyLoose() || !item.where) && matches(item, query))), bar.state, index);

			// Copies in no pocket yet stay first.
			return [...groups.filter((group) => !group.items[0].where), ...groups.filter((group) => group.items[0].where)];
		};

		function draw() {
			const query = search.value.trim();
			const loose = onlyLoose();
			const offered = live.filter((item) => !loose || !item.where);
			const groups = visible();
			const copies = copiesIn(groups);

			bar.setItems(tilesOf(offered).map((group) => pickFilterItem(group, index)));

			if (!live.length) {
				count.textContent = 'No cards on this phone yet. Add a placeholder for a card you want instead.';
			}
			else if (!copies) {
				count.textContent = loose && !query && !offered.length
					? 'Every card you own is in a binder. Pick All my cards to move one.'
					: 'No cards match.';
			}
			else {
				count.textContent = `${plural(copies, 'card', 'cards')}${loose ? ' not in a binder yet' : ''}.`;
			}

			results.replaceChildren(...groups.slice(0, shown).map((group) => {
				const item = group.items[0];
				const pick = group.items.find((copy) => free.has(copy.entry.id)) || item;
				// Picking a physical copy: its language always shows.
				const frame = artOf(group.items.map((copy) => copy.entry), item.info, (src) => tileArt({count: group.items.length, finish: entryFinish(item.entry), info: item.info, languages: [item.entry.language], src}));

				return h('button', {class: 'pick', 'data-entry': item.entry.id, onclick: () => choose(pick), type: 'button'},
					frame,
					h('span', {class: 'tile-name'}, item.info.name),
					h('span', {class: 'tile-meta'}, [item.info.number ? `#${item.info.number}` : null, item.info.setName].filter(Boolean).join(' · ') || item.entry.card_id),
					h('span', {class: item.where ? 'tile-meta pick-where' : 'tile-meta pick-where loose'}, item.where ? `In ${item.where.binder_name}, p${item.where.page}` : 'Not in a binder')
				);
			}));
			more.hidden = groups.length <= shown;
			more.textContent = `Show more (${formatCount(groups.length - shown)} left)`;

			// Names and images for the copies shown that the phone has no
			// catalog record for yet.
			fillRecords(groups.slice(0, shown).map(({items: [item]}) => ({cardId: item.entry.card_id, catalog: item.entry.catalog})), index, () => alive && sheet.open)
				.then((filled) => {
					if (filled && alive && sheet.open) {
						index = filled;

						for (const item of live) {
							item.info = entryInfo(item.entry, index, viewing);
						}

						draw();
					}
				})
				.catch(() => {});
		}

		const restart = () => {
			shown = PICK_PAGE;
			confirmBox.hidden = true;
			message.textContent = '';
			bar.refresh();
			draw();
		};

		// Filters, as in My Cards; Clear all clears the search too.
		const bar = pickerBar({
			countShown: () => visible().length,
			filters: PICK_FILTERS,
			id: 'owned',
			narrowed: () => search.value.trim() !== '',
			onChange: () => restart(),
			onClearAll: () => {
				search.value = '';
			},
		});

		search.addEventListener('input', restart);
		// The English names load once; a search typed before they are in runs again.
		loadedSpeciesNames(() => alive && sheet.open && search.value.trim() && draw());
		filter.addEventListener('change', restart);
		more.addEventListener('click', () => {
			shown += PICK_PAGE;
			draw();
		});

		draw();

		return [search, filter, bar.element, confirmBox, count, results, more];
	}

	// A placeholder: search the catalog by name or number, in the viewing
	// language, with the shared card search (js/wishlist.js searchCards: kept
	// on the phone for a day, so a search made once works offline, and no
	// TCG Pocket cards).
	function wantPicker(page, position, message) {
		const lang = viewing;
		const catalog = catalogFor(lang);
		const search = h('input', {'aria-label': 'Search the catalog by name', autocomplete: 'off', class: 'search', id: 'want-search', placeholder: 'Card name, such as Pikachu', type: 'search'});
		const status = h('p', {'aria-live': 'polite', class: 'muted', id: 'want-status'}, `Searches the ${languageLabel(lang)} catalog for a card you do not own yet.`);
		const results = h('div', {class: 'pick-grid', id: 'want-results'});
		const form = h('form', {class: 'want-form', id: 'want-form'}, search, h('button', {class: 'primary', id: 'want-go', type: 'submit'}, 'Search'));
		let asked = 0;

		async function choose(card) {
			await act(() => placePlaceholder(binder.id, page, position, {
				card_id: card.id,
				catalog: card.catalog || catalog,
				image: card.image || null,
				name: card.name,
				variant_id: null,
			}), 'Could not save the placeholder.');

			// The set name, for the tile: from the search when it knew it,
			// else read from the catalog. The placeholder works without it.
			const known = card.setName
				? Promise.resolve([{catalog: card.catalog || catalog, collector_number: card.localId, id: card.id, localizations: {[lang]: {image: card.image || null, lang, name: card.name, set_name: card.setName}}, set_id: card.setId}])
				: importApi.cardDetail(lang, card.id).then((detail) => (detail && detail.set ? [recordFrom(catalog, lang, detail)] : null));

			known
				.then((records) => (records ? saveToCardIndex(records) : null))
				.then((filled) => {
					if (filled && alive && binder) {
						index = filled;
						drawPage();
					}
				})
				.catch(() => {});
		}

		form.addEventListener('submit', async (event) => {
			event.preventDefault();
			message.textContent = '';

			const query = search.value.trim();

			if (query.length < 2) {
				status.textContent = 'Type at least two letters of the name.';

				return;
			}

			const ticket = ++asked;

			status.textContent = 'Searching…';
			results.replaceChildren();

			try {
				const {more, results: list} = await searchCards(query, lang);

				if (ticket !== asked || !alive) {
					return;
				}

				status.textContent = list.length
					? `${plural(list.length + more, 'card', 'cards')} found for "${query}"${more ? `, the first ${formatCount(list.length)} shown` : ''}.`
					: `No ${languageLabel(lang)} cards found for "${query}".`;
				results.replaceChildren(...list.map((card) => {
					// The set's real name when the set list is on the phone;
					// never its raw id.
					const info = {name: card.name, number: card.localId, setName: card.setName};

					return h('button', {class: 'pick', 'data-card': card.id, onclick: () => choose(card), type: 'button'},
						h('div', {class: 'art-wrap'}, cardArt(info, cardImage(card.image, 'low'))),
						h('span', {class: 'tile-name'}, card.name),
						h('span', {class: 'tile-meta'}, [card.localId ? `#${card.localId}` : null, card.setName].filter(Boolean).join(' · '))
					);
				}));
			}
			catch (err) {
				if (ticket !== asked) {
					return;
				}

				if (err instanceof SearchHint) {
					status.textContent = err.message;
				}
				else if (!navigator.onLine) {
					status.textContent = 'This search needs a connection the first time. Your own cards are under Your cards.';
				}
				else {
					status.textContent = `The catalog search did not work. ${errorText(err)}`;
				}
			}
		});

		return [form, status, results];
	}

	const stop = source.watch ? source.watch(() => {
		if (alive) {
			load();
		}
	}) : () => {};

	// A cover picture that arrives later is painted on the spread's board.
	const stopCovers = onCoversChange(() => {
		if (alive && spread) {
			spread.refreshCover();
		}
	});
	// A twin found, or the twins on the phone read after the first draw,
	// redraws the pages shown, once a frame; a new photo or pin is a save,
	// which the binder already draws again for (source.watch), and a
	// family member's records do not change while it is open.
	let imagesFrame = 0;
	const stopImages = onImagesChange(() => {
		if (alive && spread && !imagesFrame) {
			imagesFrame = requestAnimationFrame(() => {
				imagesFrame = 0;

				if (alive && spread && binder) {
					drawPage();
				}
			});
		}
	}, {records: false});

	document.addEventListener('visibilitychange', onVisible);
	root.append(...[back, body, sheet].filter(Boolean));
	load();

	return () => {
		alive = false;
		closeSheet();
		closeResize();
		closeLayout();
		clearTimeout(trayNoteTimer);
		clearTimeout(handMessageTimer);
		document.removeEventListener('keydown', onHandKey);
		document.removeEventListener('visibilitychange', onVisible);
		stop();
		stopCovers();
		stopImages();
		cancelAnimationFrame(imagesFrame);

		if (spread) {
			spread.destroy();
		}
	};
}

// ------------------------------------------- cards not in any binder

export function unplacedView(root) {
	let alive = true;
	let shown = Math.max(LIST_PAGE, fromHistory('shown', LIST_PAGE));
	let index = new Map();
	let groups = [];
	// The tiles on screen, by group.
	let tiles = new Map();

	const viewing = viewingLanguage();
	const summary = h('p', {class: 'muted', id: 'unplaced-summary'});
	const grid = h('div', {class: 'card-grid', id: 'unplaced-grid'});
	const more = h('button', {hidden: true, type: 'button'}, 'Show more');
	const body = h('div');

	more.addEventListener('click', () => {
		shown += LIST_PAGE;
		rememberInHistory({shown});
		draw();
	});

	function build(entries) {
		const map = new Map();

		for (const entry of entries) {
			const key = `${entry.catalog}|${entry.card_id}|${entry.language}`;

			if (!map.has(key)) {
				map.set(key, []);
			}

			map.get(key).push(entry);
		}

		groups = [...map.values()].map((list) => ({entries: list, first: list[0], info: entryInfo(list[0], index, viewing)}))
			.sort((a, b) => a.info.name.localeCompare(b.info.name) || a.first.language.localeCompare(b.first.language));
	}

	const tileOf = (group) => artOf(group.entries, group.info, (src) => cardTile({
		art: {
			count: group.entries.length,
			finish: groupFinish(group.entries),
			info: group.info,
			languages: [group.first.language],
			src,
			viewing,
		},
		meta: [group.info.number ? `#${group.info.number}` : null, group.info.setName].filter(Boolean).join(' · '),
		names: group.info.name,
		route: group.info.route,
	}));

	// Draws again the tiles of the cards in `changed` (a Set of
	// "catalog~card_id", or null for every tile) from the groups as last
	// read: a new image, never the whole grid.
	function drawImages(changed) {
		for (const [group, tile] of tiles) {
			if (!changed || changed.has(imageCardKey(group.first))) {
				const next = tileOf(group);

				tile.replaceWith(next);
				tiles.set(group, next);
			}
		}
	}

	function draw() {
		const copies = groups.reduce((sum, group) => sum + group.entries.length, 0);

		summary.textContent = copies
			? `${plural(copies, 'copy', 'copies')} not in any binder, in ${plural(groups.length, 'tile', 'tiles')}.`
			: 'Every card you own is in a binder.';

		const visible = groups.slice(0, shown);

		tiles = new Map(visible.map((group) => [group, tileOf(group)]));
		grid.replaceChildren(...tiles.values());
		offerCardList(groups.map((group) => group.info.route), 'Not in a binder');
		more.hidden = groups.length <= shown;
		more.textContent = `Show more (${formatCount(groups.length - shown)} left)`;

		fillRecords(visible.map((group) => ({cardId: group.first.card_id, catalog: group.first.catalog})), index, () => alive).catch(() => null).then((filled) => {
			if (filled && alive) {
				index = filled;
				build(groups.flatMap((group) => group.entries));
				draw();
			}
		});
	}

	async function load() {
		let doc;

		try {
			doc = await loadDocument();
			index = await cardIndex();
		}
		catch (err) {
			body.replaceChildren(failure(err, false));

			return;
		}

		if (!alive) {
			return;
		}

		const live = (doc.cards || []).filter(isLive);

		if (!live.length) {
			body.replaceChildren(h('div', {class: 'card empty-state'},
				h('p', {class: 'big'}, 'No cards on this phone yet.'),
				h('a', {class: 'button primary', 'data-link': 'scan', href: `${BASE}scan`}, 'Scan your first card')
			));

			return;
		}

		body.replaceChildren(summary, grid, more);
		build(unplaced(live, doc.binders));
		draw();
	}

	const stop = onChange(() => alive && load());
	// A twin found, or the twins on the phone read after the first draw:
	// the tiles of those cards, once a frame. A new photo or pin is a save,
	// which loads the screen again.
	const stopImages = onImagesChange((changed) => alive && drawImages(changed), {frame: true, records: false});

	root.append(
		link('binders', {class: 'back'}, '‹ Binders'),
		h('div', {class: 'view-head'}, h('h2', null, 'Not in a binder')),
		body
	);
	load();

	return () => {
		alive = false;
		stop();
		stopImages();
	};
}

// ------------------------------------------------------------- routes

// In app.js's route shape: keys name the pattern's groups, in order. The
// unplaced and new routes come before binders/<id>, so they are matched
// first.
export const binderRoutes = [
	{pattern: /^binders$/, render: bindersListView, tab: 'binders', title: 'Binders | Card Tracker'},
	{pattern: /^binders\/unplaced$/, render: unplacedView, tab: 'binders', title: 'Not in a binder | Card Tracker'},
	{pattern: /^binders\/new$/, render: newFromListView, tab: 'binders', title: 'New binder | Card Tracker'},
	{keys: ['kind', 'id'], pattern: /^binders\/new\/(checklist|collection|goal)\/([^/]+)$/, render: newFromListView, tab: 'binders', title: 'New binder | Card Tracker'},
	{keys: ['id'], pattern: /^binders\/([^/]+)$/, render: binderView, tab: 'binders', title: 'Binder | Card Tracker'},
	{keys: ['id', 'page'], pattern: /^binders\/([^/]+)\/(\d+)$/, render: binderView, tab: 'binders', title: 'Binder | Card Tracker'},
	{keys: ['userId'], pattern: /^family\/([^/]+)\/binders$/, render: familyBindersView, tab: 'binders', title: 'Family binders | Card Tracker'},
	{keys: ['userId', 'id'], pattern: /^family\/([^/]+)\/binders\/([^/]+)$/, render: familyBinderView, tab: 'binders', title: 'Family binder | Card Tracker'},
	{keys: ['userId', 'id', 'page'], pattern: /^family\/([^/]+)\/binders\/([^/]+)\/(\d+)$/, render: familyBinderView, tab: 'binders', title: 'Family binder | Card Tracker'},
];

// Views whose screen depends on who is signed in, for app.js's
// ACCOUNT_ROUTES: the family switcher, the family views, and the document
// that changes hands on sign-in.
export const binderAccountViews = [bindersListView, binderView, unplacedView, newFromListView, familyBindersView, familyBinderView];
