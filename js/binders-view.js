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
import {dropBinderCover, paintCover, pickCoverImage} from './binder-cover.js';
import {presetFor, presetPicker} from './binder-presets.js';
import {OVERVIEW_QUERY, binderSpread} from './binder-spread.js';
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
	priceRecords,
	saveToCardIndex,
	viewingLanguage,
} from './catalog.js';
import {isLive, loadDocument, onChange, sourceNames} from './collection.js';
import {BASE, errorText, fromHistory, go, h, rememberInHistory, showError} from './dom.js';
import {whenMemberName} from './family.js';
import {statsBar} from './price-view.js';
import {memberDocument} from './sync.js';
import {cardArt, cardTile, entryFinish, groupFinish, tileArt} from './tile.js';
import {
	COVER_SWATCHES,
	DEFAULT_COVER,
	GRID_PICKS,
	MAX_PAGES,
	binderStats,
	clearPocket,
	cleanFields,
	coverTextColor,
	createBinder,
	deleteBinder,
	leaveEmpty,
	liveBinders,
	locate,
	pageSlots,
	placeCard,
	placePlaceholder,
	placements,
	slotsOf,
	slotsOutside,
	unplaced,
	updateBinder,
	validGrid,
} from './binders.js';

const TCGDEX = 'https://api.tcgdex.net/v2/';
const PICK_PAGE = 60;
const LIST_PAGE = 120;

const formatCount = (n) => Number(n).toLocaleString('en-US');

const plural = (n, one, many) => `${formatCount(n)} ${n === 1 ? one : many}`;

const link = (route, attrs, ...children) => h('a', {...attrs, 'data-link': route, href: BASE + route}, ...children);

const routeTo = (...parts) => parts.map((part) => encodeURIComponent(part)).join('/');

const gridText = (binder) => `${binder.rows} × ${binder.cols}`;

// --------------------------------------------------------- whose binders

// The person's own binders, read from the phone.
const MINE = {
	base: 'binders',
	load: async () => {
		const doc = await loadDocument();

		return {binders: doc.binders || [], cards: doc.cards || []};
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

			return {binders: doc.binders || [], cards: doc.cards || []};
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
		number: record && record.collector_number,
		route: cardRoute(local, entry.catalog, entry.card_id),
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

		if (cardId && !index.has(key)) {
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

// Name, notes, cover color, grid, and pages, for a new binder or an edit.
// onSubmit(fields) saves; it may throw a message to show.
function binderForm({binder = null, onCancel, onSubmit}) {
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

	const fields = () => ({
		cols: Number(colsSelect.value),
		cover_color: coverColor(),
		name: name.value,
		notes: notes.value,
		page_count: Number(pages.value),
		preset: presetFor({cols: colsSelect.value, page_count: pages.value, rows: rowsSelect.value}),
		rows: Number(rowsSelect.value),
	});

	function check() {
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

		if (binder && ok && Number.isInteger(pageCount) && pageCount >= 1) {
			const lost = slotsOutside(binder, {cols, page_count: pageCount, rows});
			const cards = lost.filter((slot) => slot.entry_id).length;

			if (lost.length) {
				warning.textContent = `${plural(lost.length, 'filled pocket falls', 'filled pockets fall')} outside the new size${cards ? `, and ${plural(cards, 'card comes', 'cards come')} out of the binder` : ''}.`;
			}
		}
	}

	rowsSelect.addEventListener('change', check);
	colsSelect.addEventListener('change', check);
	pages.addEventListener('input', check);

	const form = h('form', {class: 'card binder-form', id: 'binder-form'},
		h('h3', null, binder ? 'Edit binder' : 'New binder'),
		h('label', {for: 'binder-name'}, 'Name'),
		name,
		h('label', {for: 'binder-notes'}, 'Notes'),
		notes,
		h('span', {class: 'field-label'}, 'Cover color'),
		swatches,
		h('span', {class: 'field-label'}, 'Size'),
		presets.element,
		h('span', {class: 'field-label'}, 'Grid'),
		picks,
		h('div', {class: 'toolbar two grid-steppers'}, h('span', {class: 'select-wrap'}, rowsSelect), h('span', {class: 'select-wrap'}, colsSelect)),
		gridNote,
		h('label', {for: 'binder-pages'}, 'Pages'),
		pages,
		warning,
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
		}
		catch (err) {
			message.textContent = err.message;

			return;
		}

		save.disabled = true;

		try {
			await onSubmit(clean);
		}
		catch (err) {
			message.textContent = `Could not save the binder. ${err.message || errorText(err)}`;
			save.disabled = false;
		}
	});

	check();

	return form;
}

// ------------------------------------------------------ the binder list

export const bindersListView = (root) => bindersScreen(root, MINE);

export const familyBindersView = (root, {userId}) => bindersScreen(root, familySource(userId));

function cover(binder, stats, base) {
	const color = binder.cover_color || DEFAULT_COVER;
	const node = link(`${base}/${encodeURIComponent(binder.id)}`, {
		class: 'binder-cover',
		'data-binder': binder.id,
		style: `--cover: ${color}; --cover-text: ${coverTextColor(color)}`,
	},
	h('span', {class: 'binder-name'}, binder.name),
	binder.notes ? h('span', {class: 'binder-notes'}, binder.notes) : null,
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

	const heading = h('div', {class: 'view-head'}, h('h2', null, 'Binders'));
	const body = h('div', {id: 'binders-body'});
	const editor = h('div', {id: 'binder-editor'});
	const newButton = source.readOnly ? null : h('button', {class: 'primary', id: 'new-binder', type: 'button'}, 'New binder');
	let name = 'Family member';

	if (source.readOnly) {
		heading.querySelector('h2').textContent = `${name}'s binders`;
		whenMemberName(source.userId, (memberLabel) => {
			name = memberLabel;
			heading.querySelector('h2').textContent = `${memberLabel}'s binders`;
			document.title = `${memberLabel}'s binders | Card Tracker`;
		});
	}

	function openForm() {
		newButton.hidden = true;
		editor.replaceChildren(binderForm({
			onCancel: () => {
				editor.replaceChildren();
				newButton.hidden = false;
			},
			onSubmit: async (fields) => {
				const binder = await createBinder(fields);

				go(`binders/${encodeURIComponent(binder.id)}`);
			},
		}));
		editor.querySelector('#binder-name').focus();
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

		const binders = liveBinders(data.binders).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
		const live = data.cards.filter(isLive);
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
			h('div', {class: 'binder-shelf'}, binders.map((binder) => cover(binder, binderStats(binder, placed, liveIds), source.base))),
			unplacedLink || ''
		);
	}

	const stop = source.watch ? source.watch(() => alive && load()) : () => {};

	root.append(...[heading, body, newButton, editor].filter(Boolean));
	load();

	return () => {
		alive = false;
		stop();
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

	const viewing = viewingLanguage();
	const back = link(source.base, {class: 'back'}, '‹ Binders');
	const title = h('h2', {id: 'binder-title'}, 'Binder');
	const meta = h('p', {class: 'muted', id: 'binder-meta'});
	const notes = h('p', {class: 'binder-notes-text', id: 'binder-notes-text', hidden: true});
	const spreadHolder = h('div', {id: 'binder-spread-holder'});
	const summary = h('p', {'aria-live': 'polite', class: 'muted', id: 'binder-summary'});
	// The value of the copies in the binder (js/price-view.js), at the top.
	const statsSlot = h('div', {class: 'binder-stats', id: 'binder-stats'});
	let statsKey = null;
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
		const content = pocketContent(slotsOn(pg).get(position) || null);
		const attrs = {
			'aria-label': `Page ${pg}, pocket ${position}: ${content.label}`,
			class: `pocket pocket-${content.kind}`,
			'data-kind': content.kind,
			'data-page': pg,
			'data-position': position,
		};

		if (!source.readOnly) {
			return h('button', {...attrs, onclick: () => openSheet(pg, position), type: 'button'}, content.node);
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
			spreadHolder.replaceChildren(spread.element);
		}
		else {
			spread.update(binder);
		}

		drawSummary();
	}

	function drawSummary() {
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

		summary.textContent = `${where} of ${binder.page_count}: ${filled} of ${per * pages.length} pockets filled. ${formatCount(stats.filled)} of ${formatCount(stats.total)} in the binder${stats.wanted ? `, ${plural(stats.wanted, 'placeholder', 'placeholders')}` : ''}.`;

		fillVisible(pages);
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

	// Redrawn only when the binder's copies or their prices change, so a
	// page turn keeps the Liga price basis the person picked.
	async function drawStats() {
		const entries = slotsOf(binder, placed)
			.map((slot) => (slot.entry_id ? entriesById.get(slot.entry_id) : null))
			.filter((entry) => entry && isLive(entry));
		const key = `${binder.id}|${entries.map((entry) => `${entry.id}:${JSON.stringify(entry.price_manual || null)}`).join(',')}`;

		if (key === statsKey) {
			return;
		}

		statsKey = key;

		if (!entries.length) {
			statsSlot.replaceChildren();

			return;
		}

		const records = await priceRecords(entries);

		if (alive && statsKey === key) {
			statsSlot.replaceChildren(statsBar({cardsById: records, entries, label: binder.name}));
		}
	}

	function draw() {
		title.textContent = binder.name;
		document.title = `${binder.name} | Card Tracker`;
		meta.textContent = `${gridText(binder)} · ${plural(binder.page_count, 'page', 'pages')}`;
		notes.textContent = binder.notes || '';
		notes.hidden = !binder.notes;
		body.style.setProperty('--cover', binder.cover_color || DEFAULT_COVER);
		body.style.setProperty('--cover-text', coverTextColor(binder.cover_color || DEFAULT_COVER));

		if (!source.readOnly) {
			const loose = unplaced(data.cards.filter(isLive), data.binders).length;

			unplacedLink.textContent = `${plural(loose, 'owned card', 'owned cards')} not in any binder`;
		}

		drawPage();
		drawStats().catch(() => {
			// No statistics this time; the binder itself is unaffected.
		});
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

		if (!body.contains(spreadHolder)) {
			body.replaceChildren(
				h('div', {class: 'binder-head'}, title, meta, notes),
				statsSlot,
				spreadHolder,
				summary,
				emptyHint,
				unplacedLink,
				source.readOnly
					? null
					: h('div', {class: 'actions'},
						h('button', {id: 'edit-binder', onclick: openEditor, type: 'button'}, 'Edit binder'),
						h('button', {id: 'binder-cover-image', onclick: () => pickCoverImage({binder}), type: 'button'}, 'Cover image'),
						h('button', {class: 'danger', id: 'delete-binder', onclick: remove, type: 'button'}, 'Delete binder')
					),
				editor
			);
		}

		draw();
	}

	function openEditor() {
		editor.replaceChildren(binderForm({
			binder,
			onCancel: () => editor.replaceChildren(),
			onSubmit: async (fields) => {
				const lost = slotsOutside(binder, fields);

				if (lost.length && !window.confirm(`${plural(lost.length, 'filled pocket falls', 'filled pockets fall')} outside the new size and will be emptied. Save anyway?`)) {
					throw new Error('Nothing was changed.');
				}

				await updateBinder(binder.id, fields);
				editor.replaceChildren();
			},
		}));
		editor.scrollIntoView({block: 'start'});
	}

	async function remove() {
		if (!window.confirm(`Delete ${binder.name}? Its cards stay in your collection and show as not in a binder.`)) {
			return;
		}

		const deleting = binder;

		try {
			await deleteBinder(deleting.id);
		}
		catch (err) {
			showError('Could not delete the binder.', err);

			return;
		}

		// Its cover image leaves the bucket too: queued, so offline it goes
		// when there is signal. Never waited on, and never an error here.
		dropBinderCover(deleting);
		go('binders');
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
					slot.art
						? h('p', {class: 'muted'}, 'Michi art is edited with the art tools, which are not here yet.')
						: h('button', {class: 'danger', id: 'pocket-clear', onclick: () => act(() => clearPocket(binder.id, page, position), 'Could not empty the pocket.'), type: 'button'}, 'Take out')
				))
			: null;

		chooser.append(...pocketChooser(page, position, message));
		sheet.replaceChildren(header, current || '', chooser, message);
		sheet.showModal();

		const search = sheet.querySelector('#owned-search');

		if (!slot && search) {
			search.focus();
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
			(want ? wantPanel.querySelector('#want-search') : ownedPanel.querySelector('#owned-search')).focus();
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

	// A placeholder: search the catalog by name, in the viewing language.
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
				catalog,
				image: card.image || null,
				name: card.name,
				variant_id: null,
			}), 'Could not save the placeholder.');

			// The set name, for the tile; the placeholder works without it.
			importApi.cardDetail(lang, card.id)
				.then((detail) => (detail && detail.set ? saveToCardIndex([recordFrom(catalog, lang, detail)]) : null))
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

			if (!navigator.onLine) {
				status.textContent = 'Searching the catalog needs a connection. Your own cards are under Your cards.';

				return;
			}

			const ticket = ++asked;

			status.textContent = 'Searching…';
			results.replaceChildren();

			try {
				const response = await fetch(`${TCGDEX}${encodeURIComponent(lang)}/cards?name=${encodeURIComponent(query)}&pagination:itemsPerPage=${PICK_PAGE}`);

				if (!response.ok) {
					throw new Error(`TCGdex answered ${response.status}.`);
				}

				const cards = await response.json();

				if (ticket !== asked || !alive) {
					return;
				}

				const list = Array.isArray(cards) ? cards : [];

				status.textContent = list.length
					? `${plural(list.length, 'card', 'cards')} named like "${query}"${list.length === PICK_PAGE ? ', the first ones shown' : ''}.`
					: `No ${languageLabel(lang)} cards are named like "${query}".`;
				results.replaceChildren(...list.map((card) => {
					const cut = String(card.id).lastIndexOf('-');
					const setId = cut > 0 ? card.id.slice(0, cut) : '';
					const info = {name: card.name, number: card.localId, setName: setId};

					return h('button', {class: 'pick', 'data-card': card.id, onclick: () => choose(card), type: 'button'},
						h('div', {class: 'art-wrap'}, cardArt(info, cardImage(card.image, 'low'))),
						h('span', {class: 'tile-name'}, card.name),
						h('span', {class: 'tile-meta'}, [card.localId ? `#${card.localId}` : null, setId].filter(Boolean).join(' · '))
					);
				}));
			}
			catch (err) {
				if (ticket === asked) {
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

	root.append(...[back, body, sheet].filter(Boolean));
	load();

	return () => {
		alive = false;
		closeSheet();
		stop();

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

		fillRecords(visible.map((group) => ({cardId: group.first.card_id, catalog: group.first.catalog})), index, () => alive).then((filled) => {
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
// unplaced route comes before binders/<id>, so it is matched first.
export const binderRoutes = [
	{pattern: /^binders$/, render: bindersListView, tab: 'binders', title: 'Binders | Card Tracker'},
	{pattern: /^binders\/unplaced$/, render: unplacedView, tab: 'binders', title: 'Not in a binder | Card Tracker'},
	{keys: ['id'], pattern: /^binders\/([^/]+)$/, render: binderView, tab: 'binders', title: 'Binder | Card Tracker'},
	{keys: ['id', 'page'], pattern: /^binders\/([^/]+)\/(\d+)$/, render: binderView, tab: 'binders', title: 'Binder | Card Tracker'},
	{keys: ['userId'], pattern: /^family\/([^/]+)\/binders$/, render: familyBindersView, tab: 'binders', title: 'Family binders | Card Tracker'},
	{keys: ['userId', 'id'], pattern: /^family\/([^/]+)\/binders\/([^/]+)$/, render: familyBinderView, tab: 'binders', title: 'Family binder | Card Tracker'},
	{keys: ['userId', 'id', 'page'], pattern: /^family\/([^/]+)\/binders\/([^/]+)\/(\d+)$/, render: familyBinderView, tab: 'binders', title: 'Family binder | Card Tracker'},
];

// Views whose screen depends on who is signed in, for app.js's
// ACCOUNT_ROUTES: the family switcher, the family views, and the document
// that changes hands on sign-in.
export const binderAccountViews = [bindersListView, binderView, unplacedView, familyBindersView, familyBinderView];
