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
import {OVERVIEW_QUERY, SIDEWAYS_QUERY, binderSpread} from './binder-spread.js';
import {offerCardList} from './card-swipe.js';
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
import {cardArt, cardTile, entryFinish, groupFinish, tileArt} from './tile.js';
import {valueButton} from './value-sheet.js';
import {SearchHint, addToWishlist, searchCards} from './wishlist.js';
import {indexAt, parseKey, picksOf, planRefresh, refreshText, ruleKey, shownCopy} from './binder-rules.js';
import {filterLabels, ruleSection} from './binder-rule-view.js';
import {cardItem, loadRuleItems, pokemonItem, rankerFor, sourceEntry, sourceText} from './binder-sources.js';
import {pokemonNames} from './checklists.js';
import {nowIso} from './collection.js';
import {
	COVER_SWATCHES,
	DEFAULT_COVER,
	GRID_PICKS,
	MAX_PAGES,
	binderStats,
	clearPocket,
	cleanFields,
	coverImageOf,
	coverTextColor,
	createBinder,
	createGeneratedBinder,
	deleteBinder,
	fillTray,
	isGenerated,
	isHex,
	leaveEmpty,
	liveBinders,
	locate,
	moveToTray,
	pageSlots,
	placeCard,
	placePlaceholder,
	placeStaged,
	placements,
	planResize,
	reorderBinders,
	restoreBinder,
	saveRefresh,
	setPocketPick,
	slotsOf,
	sortBinders,
	trayOf,
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

// What a tile needs for one copy.
function entryInfo(entry, index, viewing) {
	const record = index.get(indexKey(entry.catalog, entry.card_id)) || null;
	const local = display(record, [catalogFor(viewing) === entry.catalog ? viewing : null, entry.language, catalogLanguage(entry.catalog)]);
	const source = sourceNames(entry, record);

	return {
		image: local ? cardImage(local.image, 'low') : null,
		name: (source && source.name) || (local && local.name) || entry.name_local || entry.card_id,
		// A hand-made card's number is on the copy (js/custom-card.js).
		number: (record && record.collector_number) || entry.number_local || null,
		route: entry.catalog === 'custom' ? customRoute(entry.card_id, entry.language) : cardRoute(local, entry.catalog, entry.card_id),
		setName: (source && source.setName) || (local && local.set_name) || null,
	};
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

function recordFrom(catalog, lang, card) {
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
async function fillRecords(items, index, isAlive) {
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
// {plan, rankOf}.
async function planLayout(binderLike, loaded, {liveIds = null, picks = new Map()} = {}) {
	const rankOf = await rankerFor(itemCopies(loaded.items));

	return {plan: planRefresh(binderLike, loaded.items, {at: nowIso(), liveIds, partial: loaded.partial, picks, rankOf}), rankOf};
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
			const binder = await createGeneratedBinder(fields, rule, plan.snapshot);

			go(`binders/${encodeURIComponent(binder.id)}`);
		},
		rule: ruleSection({doc, index, start}),
		title: 'New binder from a list',
	});
}

// Filled pockets of a list's binder, from its last layout: {filled, total}.
function listStats(binder, picksList, liveIds) {
	const snapshot = binder.snapshot || {};
	const keys = Array.isArray(snapshot.keys) ? snapshot.keys : [];
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

		body.replaceChildren(
			h('div', {class: 'binder-shelf'}, binders.map((binder) => cover(binder, isGenerated(binder) ? listStats(binder, data.picks, liveIds) : binderStats(binder, placed, liveIds), source.base))),
			unplacedLink || ''
		);
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

	root.append(...[heading, body, order ? order.panel : null, newButton, editor].filter(Boolean));
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
	const gen = {busy: null, gone: false, items: null, names: null, partial: false, rankOf: undefined, started: false};
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

	const viewing = viewingLanguage();
	const back = link(source.base, {class: 'back'}, '‹ Binders');
	const title = h('h2', {id: 'binder-title'}, 'Binder');
	const meta = h('p', {class: 'muted', id: 'binder-meta'});
	const notes = h('p', {class: 'binder-notes-text', id: 'binder-notes-text', hidden: true});
	const spreadHolder = h('div', {id: 'binder-spread-holder'});
	const summary = h('p', {'aria-live': 'polite', class: 'muted', id: 'binder-summary'});
	// The value of the copies in the binder, on demand and at the top: a
	// small Value button opens the sheet (js/value-sheet.js), never a big box.
	const statsSlot = h('div', {class: 'binder-stats', id: 'binder-stats'});
	let statsEntries = [];
	const valueOpen = valueButton({entries: () => statsEntries, id: 'binder-value', label: () => (binder ? binder.name : 'this binder')});
	const unplacedLink = source.readOnly ? null : link('binders/unplaced', {class: 'unplaced-link', id: 'unplaced-link'}, 'Owned cards not in any binder');
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

	// A tap on the backdrop closes the sheet, as Escape does.
	if (sheet) {
		sheet.addEventListener('click', (event) => {
			if (event.target === sheet) {
				closeSheet();
			}
		});
	}

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
				const frame = tileArt({finish: entryFinish(entry), info, languages: [entry.language], src: info.image, viewing});

				return {info, kind: 'card', label: `${info.name}, ${languageLabel(entry.language)}`, node: frame};
			}

			// A copy deleted or traded away since it was placed leaves a
			// placeholder of its card, not a hole.
			const info = entry ? entryInfo(entry, index, viewing) : {image: null, name: 'A card no longer owned', number: null, setName: null};

			return {
				info,
				kind: 'gone',
				label: `${info.name}, no longer owned`,
				node: h('div', {class: 'art-wrap'}, cardArt(info, info.image), h('span', {class: 'pocket-tag'}, 'Gone')),
			};
		}

		if (slot.want) {
			const info = wantInfo(slot.want, index, viewing);

			return {
				info,
				kind: 'want',
				label: `${info.name}, placeholder for a card not owned`,
				node: h('div', {class: 'art-wrap'}, cardArt(info, info.image), h('span', {class: 'pocket-tag'}, 'Want')),
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
			'data-kind': content.kind,
			'data-page': pg,
			'data-position': position,
		};

		if (!source.readOnly) {
			// With a tray card picked, a tap places it; otherwise it opens
			// the picker sheet.
			return h('button', {...attrs, onclick: () => (picked ? placeFromTrayAt(picked, pg, position) : openSheet(pg, position)), type: 'button'}, content.node);
		}

		if (content.kind === 'card' && content.info && content.info.route) {
			return link(content.info.route, attrs, content.node);
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
			spreadHolder.replaceChildren(...[spread.element, tray, tray && trayNote].filter(Boolean));

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
			refreshButton.hidden = !listMode;
		}

		drawPage();
		drawTray();
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

		binder = liveBinders(data.binders).find((item) => item.id === id) || null;

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
				h('div', {class: 'binder-head'}, title, meta, notes),
				statsSlot,
				listNote,
				spreadHolder,
				summary,
				emptyHint,
				unplacedLink,
				source.readOnly
					? null
					: h('div', {class: 'actions'},
						refreshButton,
						h('button', {id: 'edit-binder', onclick: openEditor, type: 'button'}, 'Edit binder'),
						h('button', {id: 'binder-cover-image', onclick: () => pickCoverImage({binder}), type: 'button'}, 'Cover image'),
						h('button', {class: 'danger', id: 'delete-binder', onclick: remove, type: 'button'}, 'Delete binder')
					),
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
			const frame = tileArt({count, finish: entryFinish(entry), info, languages: [entry.language], src: info.image, viewing});
			const extra = [count > 1 ? `${count} copies fit` : null, picked ? 'picked by hand' : null].filter(Boolean).join(', ');

			return {info, item, kind: 'card', label: `${item.name}: ${info.name}, ${languageLabel(entry.language)}${extra ? `, ${extra}` : ''}`, node: frame};
		}

		const info = item.kind === 'pokemon'
			? {image: item.image, name: item.name, number: String(item.dex).padStart(3, '0'), setName: null}
			: wantInfo({card_id: item.cardId, catalog: item.catalog, image: item.image, name: item.name}, index, viewing);
		const src = item.kind === 'pokemon' ? item.image : info.image;

		return {
			info,
			item,
			kind: 'want',
			label: `${item.kind === 'pokemon' ? `${item.number} ${item.name}` : info.name}, not owned yet`,
			node: h('div', {class: 'art-wrap'}, cardArt(info, src), h('span', {class: 'pocket-tag'}, 'Want')),
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

		if (!source.readOnly) {
			return h('button', {...attrs, onclick: () => openListSheet(pg, position), type: 'button'}, content.node);
		}

		if (content.kind === 'card' && content.info && content.info.route) {
			return link(content.info.route, attrs, content.node);
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
		summary.textContent = `${where} of ${binder.page_count}: ${filled} of ${per * pages.length} pockets filled. ${formatCount(owned)} of ${plural(keys.length, 'pocket', 'pockets')} with a card you own.`;
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
	// for cards that left, owned cards filled in, and defaults moved to the
	// best copy, picks kept (planRefresh). Saves only what changed, and says
	// it. manual: the Refresh button, which also asks again what a failed
	// download put off (force).
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
			const {plan, rankOf} = await planLayout(binder, loaded, {liveIds, picks});

			if (!alive || binder.id !== binderId) {
				return;
			}

			gen.items = new Map(loaded.items.map((item) => [item.key, item]));
			gen.rankOf = rankOf;
			gen.partial = loaded.partial;

			const text = refreshText(plan, nameOfKey);
			const partly = loaded.partial ? ' Some cards could not be checked yet; their pockets stay as they were.' : '';

			showListNote(text ? `${text}${partly}` : manual ? `Up to date.${partly}` : '');

			if (plan.changed) {
				await saveRefresh(binderId, plan);
			}
			else {
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
	function openListSheet(page, position) {
		const i = indexAt(page, position, binder.rows, binder.cols);
		const message = h('p', {'aria-live': 'polite', class: 'form-error'});
		const body = h('div', {class: 'list-sheet', id: 'list-sheet'});

		function fill() {
			const state = listState(i);

			if (!state) {
				closeSheet();

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
					tileArt({finish: entryFinish(entry), info, languages: [entry.language], src: info.image}),
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
				}

				await updateGeneratedBinder(editing.id, fields, rule, snapshot);
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
			spread.element.dataset.placing = picked ? 'true' : '';
		}
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
		tray.hidden = !ids.length;
		trayStrip.replaceChildren(...ids.map((entryId) => {
			const entry = entriesById.get(entryId);
			const info = entryInfo(entry, index, viewing);

			return h('button', {
				'aria-label': `${info.name}, ${languageLabel(entry.language)}`,
				'aria-pressed': String(entryId === picked),
				class: 'bt-card',
				'data-entry': entryId,
				role: 'listitem',
				type: 'button',
			}, cardArt(info, info.image));
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
	function openSheet(page, position) {
		const slot = pageSlots(binder, page, placed).get(position) || null;
		const content = pocketContent(slot);
		const chooser = h('div', {class: 'chooser', hidden: Boolean(slot)});
		const message = h('p', {'aria-live': 'polite', class: 'form-error'});

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
					content.kind === 'card'
						? h('button', {id: 'pocket-to-tray', onclick: () => act(() => moveToTray(binder.id, page, position), 'Could not move the card to the tray.'), type: 'button'}, 'To the tray')
						: null,
					slot.art
						? h('p', {class: 'muted'}, 'Michi art is edited with the art tools, which are not here yet.')
						: h('button', {class: 'danger', id: 'pocket-clear', onclick: () => act(() => clearPocket(binder.id, page, position), 'Could not empty the pocket.'), type: 'button'}, 'Take out')
				))
			: null;

		chooser.append(...pocketChooser(page, position, message));
		sheet.replaceChildren(header, current || '', chooser, message);
		// Focus goes to Close, not the search field: most people scroll the
		// list, and on a phone a focused field raises the keyboard over it.
		// Back closes the sheet instead of leaving the binder.
		if (!sheet.open) {
			openDialogSheet(sheet);
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

	// Your cards, one tile per copy: those not in a binder yet first.
	function ownedPicker(page, position, message) {
		const search = h('input', {'aria-label': 'Search your cards', autocomplete: 'off', class: 'search', id: 'owned-search', placeholder: 'Search your cards', type: 'search'});
		const filter = h('div', {class: 'segmented', id: 'owned-filter', role: 'radiogroup'},
			h('label', null, h('input', {checked: true, name: 'owned-filter', type: 'radio', value: 'unplaced'}), h('span', null, 'Not in a binder yet')),
			h('label', null, h('input', {name: 'owned-filter', type: 'radio', value: 'all'}), h('span', null, 'All my cards'))
		);
		const count = h('p', {'aria-live': 'polite', class: 'muted', id: 'owned-count'});
		const results = h('div', {class: 'pick-grid', id: 'owned-results'});
		const confirmBox = h('div', {class: 'move-confirm', hidden: true, id: 'move-confirm', role: 'alertdialog'});
		const more = h('button', {hidden: true, id: 'owned-more', type: 'button'}, 'Show more');
		let shown = PICK_PAGE;

		const live = data.cards.filter(isLive).map((entry) => ({entry, info: entryInfo(entry, index, viewing), where: locate(data.binders, entry.id)}));

		live.sort((a, b) => (Boolean(a.where) - Boolean(b.where)) || a.info.name.localeCompare(b.info.name) || String(a.entry.created_at).localeCompare(String(b.entry.created_at)));

		function matches(item, query) {
			if (!query) {
				return true;
			}

			return [item.info.name, item.info.setName, item.info.number, item.entry.card_id]
				.some((value) => value && String(value).toLowerCase().includes(query));
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

		function draw() {
			const query = search.value.trim().toLowerCase();
			const onlyLoose = filter.querySelector('input:checked').value === 'unplaced';
			const found = live.filter((item) => (!onlyLoose || !item.where) && matches(item, query));

			if (!live.length) {
				count.textContent = 'No cards on this phone yet. Add a placeholder for a card you want instead.';
			}
			else if (!found.length) {
				count.textContent = onlyLoose && !query
					? 'Every card you own is in a binder. Pick All my cards to move one.'
					: 'No cards match.';
			}
			else {
				count.textContent = `${plural(found.length, 'card', 'cards')}${onlyLoose ? ' not in a binder yet' : ''}.`;
			}

			results.replaceChildren(...found.slice(0, shown).map((item) => {
				// Picking one physical copy: its language always shows.
				const frame = tileArt({finish: entryFinish(item.entry), info: item.info, languages: [item.entry.language], src: item.info.image});

				return h('button', {class: 'pick', 'data-entry': item.entry.id, onclick: () => choose(item), type: 'button'},
					frame,
					h('span', {class: 'tile-name'}, item.info.name),
					h('span', {class: 'tile-meta'}, [item.info.number ? `#${item.info.number}` : null, item.info.setName].filter(Boolean).join(' · ') || item.entry.card_id),
					h('span', {class: item.where ? 'tile-meta pick-where' : 'tile-meta pick-where loose'}, item.where ? `In ${item.where.binder_name}, p${item.where.page}` : 'Not in a binder')
				);
			}));
			more.hidden = found.length <= shown;
			more.textContent = `Show more (${formatCount(found.length - shown)} left)`;

			// Names and images for the copies shown that the phone has no
			// catalog record for yet.
			fillRecords(found.slice(0, shown).map((item) => ({cardId: item.entry.card_id, catalog: item.entry.catalog})), index, () => alive && sheet.open)
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
			draw();
		};

		search.addEventListener('input', restart);
		filter.addEventListener('change', restart);
		more.addEventListener('click', () => {
			shown += PICK_PAGE;
			draw();
		});

		draw();

		return [search, filter, confirmBox, count, results, more];
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

	root.append(...[back, body, sheet].filter(Boolean));
	load();

	return () => {
		alive = false;
		closeSheet();
		closeResize();
		clearTimeout(trayNoteTimer);
		stop();
		stopCovers();

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

	function draw() {
		const copies = groups.reduce((sum, group) => sum + group.entries.length, 0);

		summary.textContent = copies
			? `${plural(copies, 'copy', 'copies')} not in any binder, in ${plural(groups.length, 'tile', 'tiles')}.`
			: 'Every card you own is in a binder.';

		const visible = groups.slice(0, shown);

		grid.replaceChildren(...visible.map((group) => cardTile({
			art: {
				count: group.entries.length,
				finish: groupFinish(group.entries),
				info: group.info,
				languages: [group.first.language],
				src: group.info.image,
				viewing,
			},
			meta: [group.info.number ? `#${group.info.number}` : null, group.info.setName].filter(Boolean).join(' · '),
			names: group.info.name,
			route: group.info.route,
		})));
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

	root.append(
		link('binders', {class: 'back'}, '‹ Binders'),
		h('div', {class: 'view-head'}, h('h2', null, 'Not in a binder')),
		body
	);
	load();

	return () => {
		alive = false;
		stop();
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
