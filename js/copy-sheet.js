// Copies by hand (plans/audit-qa.md Q-01, plans/design-review.md "Card
// Detail"): the sheet that edits one copy's language, finish, condition,
// where it is stored, and notes, or removes it; the Places sheet that
// renames and removes storage places; the sheet that stores many copies in
// one place (My Cards); the sheet that adds copies of a card; and the count
// stepper ("-  N  +") on each row of Your copies and in a binder's pocket
// sheet. Card detail (js/catalog-views.js) and the binder view
// (js/binders-view.js) place them; none is shown in family view, which is
// read only.
//
// A removal is written at once, with Undo on a toast that brings the very
// same copies back (js/collection.js restoreCard), so their photos, binder
// pockets, and Liga prices come back with them.
//
// No picker wheel for the count: buttons plus typing work better with
// Android keyboards and screen readers (Eric, 2026-10-02).

import {catalogFor, isLanguage, languageLabel} from './catalog.js';
import {listBinders, placements} from './binders.js';
import {
	addCard,
	cleanPlace,
	deleteCards,
	listCards,
	listPlaces,
	placeFold,
	removePlace,
	renamePlace,
	restoreCard,
	setStorage,
	STORAGE_MAX,
	undoStorage,
	updateCard,
	updateCards,
} from './collection.js';
import {errorText, h} from './dom.js';
import {flagLanguageName} from './flags.js';
import {plural} from './format.js';
import {FINISHES} from './monprice.js';
import {CONDITIONS} from './scan/session.js';
import {openDialogSheet} from './sheet.js';
import {toast} from './shell.js';

// The most copies one Add sheet makes: enough for a box of the same card,
// few enough that a slip of the thumb cannot add thousands (Q-08).
export const MAX_ADD = 20;

// The most a stepper's count can be typed up to.
export const MAX_COUNT = 999;

export const NOTES_MAX = 500;

// How long Undo stays on a toast.
export const UNDO_MS = 8000;

// The app's languages, then German, Italian, and Spanish, which the scanner
// saves on international records too (js/scan/session.js SCAN_LANGUAGES).
export const languageName = (code) => (isLanguage(code) ? languageLabel(code) : flagLanguageName(code));

// The languages a copy of a card in this catalog can be printed in.
// International records hold every Western print; a Japanese record also
// holds Korean copies of sets Korea prints under the Japanese codes
// (DESIGN.md section 5). current is kept when it is something else, so
// opening the sheet never changes a copy by itself.
export function copyLanguages(catalog, current = null) {
	const codes = catalog === 'international'
		? ['pt', 'en', 'fr', 'de', 'it', 'es']
		: catalog === 'ja' ? ['ja', 'ko']
			// A hand-made card (js/custom-card.js) can be in any language.
			: catalog === 'custom' ? ['pt', 'en', 'fr', 'de', 'it', 'es', 'ja', 'ko', 'zh-cn', 'zh-tw'] : [catalog];

	if (current && !codes.includes(current)) {
		codes.push(current);
	}

	return codes.map((code) => ({code, label: languageName(code)}));
}

// ---------------------------------------------------------- alike copies

// Copies are alike when they are the same card in the same catalog, in the
// same language, finish, and condition, stored in the same place. A row of
// Your copies holds alike copies, and the stepper counts them, so copies in
// two boxes are two rows, each with its own count and its own Stored in.
export const alikeKey = (entry) => JSON.stringify([
	entry.catalog || 'international',
	entry.card_id,
	entry.language || null,
	entry.variant_id || null,
	// An unmatched monprice finish tells copies apart only without a variant.
	entry.variant_id ? null : entry.finish_raw || null,
	entry.condition || null,
	entry.storage ? placeFold(entry.storage) : null,
]);

// What a copy added by + carries over from one alike: the card, language,
// finish, condition, where it is stored, and the source's names; never
// notes, photos, prices, or a binder pocket.
export function alikeFields(entry) {
	const fields = {
		card_id: entry.card_id,
		catalog: entry.catalog || 'international',
		language: entry.language,
		language_source: 'manual',
		variant_id: entry.variant_id || null,
	};

	// A hand-made card's own facts ride on every copy (js/custom-card.js).
	for (const key of ['condition', 'storage', 'fallback', 'name_local', 'set_name_local', 'number_local', 'set_code']) {
		if (entry[key]) {
			fields[key] = entry[key];
		}
	}

	if (!entry.variant_id && entry.finish_raw) {
		fields.finish_raw = entry.finish_raw;
	}

	return fields;
}

export const hasPhotos = (entry) => Array.isArray(entry.photos) && entry.photos.length > 0;

// Where every placed copy is: Map entry id -> {binder_id, binder_name, page,
// position}.
// binders: a family member's list; your own when left out.
export async function copyPlaces(binders = null) {
	const placed = placements(binders || await listBinders());

	return new Map([...placed].map(([id, {binder, slot}]) => [id, {binder_id: binder.id, binder_name: binder.name, page: slot.page, position: slot.position}]));
}

export const placeText = (where) => `${where.binder_name}, page ${where.page}, pocket ${where.position}`;

const newestFirst = (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''));

// Which copies go when a count drops by n. First the copies in no binder
// pocket and with no photos, newest first; the rest only when those run
// out. When the rest must be chosen among (more of them than are still to
// go), ask is {count, from} and the person picks; otherwise every one goes
// and ask is null. keep is a copy that never goes (the one in the pocket a
// binder's sheet is for).
export function removalPlan(entries, n, {keep = null, places = new Map()} = {}) {
	const pool = entries.filter((entry) => entry.id !== keep);
	const free = pool.filter((entry) => !places.has(entry.id) && !hasPhotos(entry)).sort(newestFirst);

	if (n <= free.length) {
		return {ask: null, chosen: free.slice(0, n)};
	}

	const rest = pool.filter((entry) => !free.includes(entry)).sort(newestFirst);
	const more = Math.min(n - free.length, rest.length);

	if (more >= rest.length) {
		return {ask: null, chosen: [...free, ...rest]};
	}

	return {ask: {count: more, from: rest}, chosen: free};
}

// The binder pockets some copies leave, as one sentence: "It leaves
// Binder A, page 3." places holds only the placed ones. Null for none.
export function leavesText(places) {
	const named = [...new Set(places.filter(Boolean).map((where) => `${where.binder_name}, page ${where.page}`))];

	if (!named.length) {
		return null;
	}

	const list = named.length === 1 ? named[0] : `${named.slice(0, -1).join('; ')} and ${named[named.length - 1]}`;

	return `${places.length === 1 ? 'It leaves' : 'They leave'} ${list}.`;
}

// Removes copies now, with Undo on a toast that restores them.
export async function removeWithUndo(entries, places = new Map()) {
	const ids = entries.map((entry) => entry.id);

	await deleteCards(ids);

	const what = ids.length === 1 ? `${languageName(entries[0].language)} copy removed.` : `${ids.length} copies removed.`;
	const leaves = leavesText(entries.map((entry) => places.get(entry.id)).filter(Boolean));

	toast(leaves ? `${what} ${leaves}` : what, {
		action: () => restoreCard(ids).catch((err) => toast(`Could not bring the copies back. ${errorText(err)}`)),
		actionLabel: 'Undo',
		timeout: UNDO_MS,
	});
}

// Adds n copies alike to entry.
export async function addAlike(entry, n) {
	const fields = alikeFields(entry);
	const added = [];

	for (let i = 0; i < n; i++) {
		added.push(await addCard(fields));
	}

	return added;
}

// The alike copies of entry on this phone now, and where the placed ones are.
async function alikeNow(entry) {
	const key = alikeKey(entry);
	const [cards, places] = await Promise.all([listCards(), copyPlaces().catch(() => new Map())]);

	return {entries: cards.filter((card) => alikeKey(card) === key), places};
}

// ------------------------------------------------------------ the sheets

function dialog(id, title) {
	let sheet = document.getElementById(id);

	if (!sheet) {
		sheet = h('dialog', {'aria-labelledby': `${id}-title`, class: `sheet ${id}`, id});
		sheet.addEventListener('click', (event) => {
			if (event.target === sheet) {
				sheet.close();
			}
		});
		document.body.append(sheet);
	}

	sheet.setAttribute('aria-label', title);

	return sheet;
}

// Shows a sheet: Back and Escape close it, and focus returns where it was
// (js/sheet.js).
function show(sheet, onClose = null) {
	if (!sheet.open) {
		openDialogSheet(sheet, {onClose});
	}

	return sheet;
}

const sheetElement = () => dialog('copy-sheet', 'Copy');

// Closes the copy sheets if they are open, for card detail's cleanup.
export function closeCopySheet() {
	for (const id of ['places-sheet', 'copy-pick-sheet', 'copy-sheet', 'store-sheet']) {
		const sheet = document.getElementById(id);

		if (sheet && sheet.open) {
			sheet.close();
		}
	}
}

// Asks which copies go when every copy left is in a pocket or has photos.
// Resolves with the chosen entries, or null when the sheet is closed.
export function askWhich({count, from, places = new Map(), title = null}) {
	const sheet = dialog('copy-pick-sheet', 'Which copy');
	let chosen = null;

	return new Promise((resolve) => {
		const close = () => sheet.close();
		const remove = h('button', {class: 'danger', disabled: true, id: 'copy-pick-remove', type: 'button'}, count === 1 ? 'Remove this copy' : `Remove these ${count}`);
		const boxes = from.map((entry) => h('input', {'data-entry': entry.id, name: 'copy-pick', type: count === 1 ? 'radio' : 'checkbox', value: entry.id}));
		const options = from.map((entry, i) => {
			const where = places.get(entry.id);
			const photos = hasPhotos(entry) ? `${entry.photos.length} ${entry.photos.length === 1 ? 'photo' : 'photos'}` : null;

			return h('label', {class: 'copy-pick-option'}, boxes[i], h('span', null, [where ? placeText(where) : 'Not in a binder', photos].filter(Boolean).join(' · ')));
		});

		for (const box of boxes) {
			box.addEventListener('change', () => {
				remove.disabled = boxes.filter((item) => item.checked).length !== count;
			});
		}

		remove.addEventListener('click', () => {
			const ids = new Set(boxes.filter((item) => item.checked).map((item) => item.value));

			chosen = from.filter((entry) => ids.has(entry.id));
			close();
		});

		sheet.replaceChildren(
			h('div', {class: 'sheet-head'},
				h('h2', {id: 'copy-pick-sheet-title'}, title || (count === 1 ? 'Which copy goes?' : `Which ${count} copies go?`)),
				h('button', {class: 'small', id: 'copy-pick-close', onclick: close, type: 'button'}, 'Cancel')
			),
			h('p', {class: 'muted copy-sub'}, 'Every copy left like this is in a binder pocket or has photos.'),
			h('div', {class: 'copy-pick-list'}, options),
			h('div', {class: 'copy-danger'}, remove)
		);
		show(sheet, () => resolve(chosen));
	});
}

const field = (label, id, control) => h('div', {class: 'copy-field'},
	h('label', {for: id}, label),
	control.tagName === 'SELECT' ? h('span', {class: 'select-wrap'}, control) : control
);

function select(id, options, value) {
	const control = h('select', {id, name: id},
		options.map((option) => h('option', {value: option.value}, option.label))
	);

	control.value = value;

	return control;
}

const NOT_SET = '';

const conditionOptions = () => [{label: 'Not set', value: NOT_SET}, ...CONDITIONS.map((condition) => ({label: condition, value: condition}))];

// finishes: [{value: variantId, label}] from the card's variants_detailed.
// current: a copy's variant_id the list does not know (the catalog is not
// answering, or TCGdex renamed it), kept as it is.
function finishOptions(finishes, current) {
	const options = [{label: 'Not set', value: NOT_SET}, ...finishes];

	if (current && !finishes.some((option) => option.value === current)) {
		options.push({label: 'Current finish (not in the catalog list)', value: current});
	}

	return options;
}

// A hand-made card has no catalog printings: its finish is one of
// monprice's words, kept in finish_raw like an unmatched import's.
export const rawFinishes = () => Object.entries(FINISHES).map(([value, label]) => ({label, value}));

const finishKey = (catalog) => (catalog === 'custom' ? 'finish_raw' : 'variant_id');

function head(title, close) {
	return h('div', {class: 'sheet-head'},
		h('h2', {id: 'copy-sheet-title'}, title),
		h('button', {class: 'small', id: 'copy-sheet-close', onclick: close, type: 'button'}, 'Close')
	);
}

// The edit sheet for one row of Your copies.
//
//   card        {name, number} for the line under the title
//   entries     the row's copies, all alike (one or more)
//   catalog     the record's catalog
//   finishes    [{value, label}] for the finish select
//   places      Map entry id -> binder place, for the placed copies
export function openEditSheet({card, catalog, entries, finishes, places = new Map()}) {
	const sheet = sheetElement();
	const first = entries[0];
	const many = entries.length > 1;
	const close = () => sheet.close();
	const error = h('p', {'aria-live': 'polite', class: 'form-error', id: 'copy-error'});

	const language = select('copy-language', copyLanguages(catalog, first.language).map(({code, label}) => ({label, value: code})), first.language);
	const finish = select('copy-finish', finishOptions(finishes, first[finishKey(catalog)]), first[finishKey(catalog)] || NOT_SET);
	const condition = select('copy-condition', conditionOptions(), CONDITIONS.includes(first.condition) ? first.condition : NOT_SET);
	const notes = h('textarea', {class: 'copy-notes', id: 'copy-notes', maxlength: NOTES_MAX, name: 'copy-notes', rows: 2}, first.notes || '');
	// Alike copies are stored in one place (alikeKey).
	const storage = placePicker({id: 'copy-storage', value: first.storage});

	// A row of alike copies changes one of them, or all of them. One of
	// them is the copy a minus would take (removalPlan).
	let scope = 'one';
	const scopeChoice = many
		? h('div', {'aria-label': 'Change', class: 'segmented copy-scope', role: 'radiogroup'},
			[['one', 'This copy'], ['all', `All ${entries.length}`]].map(([value, label]) => h('label', null,
				h('input', {checked: value === scope, name: 'copy-scope', onchange: () => {
					scope = value;
					drawRemove();
				}, type: 'radio', value}),
				h('span', null, label)
			)))
		: null;
	const one = () => {
		const plan = removalPlan(entries, 1, {places});

		return plan.chosen.length ? plan.chosen : [[...entries].sort(newestFirst)[0]];
	};
	const targets = () => (scope === 'all' ? entries : one());

	const remove = h('button', {class: 'danger', id: 'copy-remove', type: 'button'});
	const leaves = h('p', {class: 'muted copy-leaves', id: 'copy-leaves'});

	function drawRemove() {
		const chosen = targets();
		const text = leavesText(chosen.map((entry) => places.get(entry.id)).filter(Boolean));

		remove.textContent = chosen.length === 1 ? 'Remove copy' : `Remove ${chosen.length} copies`;
		leaves.textContent = text ? `${text.replace(/\.$/, '')} when removed.` : '';
		leaves.hidden = !text;
	}

	drawRemove();

	remove.addEventListener('click', async () => {
		let chosen = targets();

		// One copy from a row where every copy is in a pocket or has photos:
		// ask which.
		if (scope === 'one') {
			const plan = removalPlan(entries, 1, {places});

			if (plan.ask) {
				close();

				const picked = await askWhich({...plan.ask, places});

				if (!picked) {
					return;
				}

				chosen = picked;
			}
		}

		close();

		try {
			await removeWithUndo(chosen, places);
		}
		catch (err) {
			toast(`Not removed. ${errorText(err)}`);
		}
	});

	const form = h('form', {class: 'copy-form', id: 'copy-form'},
		scopeChoice,
		field('Language', 'copy-language', language),
		field('Finish', 'copy-finish', finish),
		field('Condition', 'copy-condition', condition),
		field('Stored in', 'copy-storage', storage.element),
		field('Notes', 'copy-notes', notes),
		error,
		h('button', {class: 'primary', id: 'copy-save', type: 'submit'}, 'Save')
	);

	form.addEventListener('submit', async (event) => {
		event.preventDefault();
		error.textContent = '';

		const patches = targets().map((entry) => ({id: entry.id, patch: changes(entry, catalog, {
			condition: condition.value || null,
			language: language.value,
			notes: notes.value.trim().slice(0, NOTES_MAX),
			storage: storage.value(),
			[finishKey(catalog)]: finish.value || null,
		})})).filter((item) => Object.keys(item.patch).length);

		try {
			if (patches.length === 1) {
				await updateCard(patches[0].id, patches[0].patch);
			}
			else if (patches.length) {
				await updateCards(patches);
			}

			close();

			if (patches.length) {
				toast(patches.length === 1 ? 'Copy saved.' : `${patches.length} copies saved.`);
			}
		}
		catch (err) {
			error.textContent = `Not saved. ${errorText(err)}`;
		}
	});

	const placed = entries.map((entry) => places.get(entry.id)).filter(Boolean);

	sheet.replaceChildren(
		head(many ? `Edit copies (${entries.length} alike)` : 'Edit copy', close),
		h('p', {class: 'muted copy-sub'}, [card.name, card.number, placed.length === 1 && !many ? placeText(placed[0]) : null].filter(Boolean).join(' · ')),
		form,
		h('div', {class: 'copy-danger'}, remove, leaves)
	);

	return show(sheet);
}

// Only what changed, so an untouched field is never stamped as edited and
// a copy keeps fields it never had.
export function changes(entry, catalog, next) {
	const patch = {};

	if (next.language !== entry.language) {
		patch.language = next.language;
		patch.language_source = 'manual';
	}

	// A copy whose language belongs to another catalog (a Korean copy on a
	// Japanese record) is a fallback match (DESIGN.md section 5). A
	// hand-made card belongs to no catalog, so it never is.
	const fallback = catalog !== 'custom' && catalogFor(next.language) !== catalog;

	if (fallback !== Boolean(entry.fallback)) {
		patch.fallback = fallback;
	}

	if (next.variant_id !== undefined && (next.variant_id || null) !== (entry.variant_id || null)) {
		patch.variant_id = next.variant_id || null;
	}

	if (next.finish_raw !== undefined && (next.finish_raw || null) !== (entry.finish_raw || null)) {
		patch.finish_raw = next.finish_raw || null;
	}

	if ((next.condition || null) !== (entry.condition || null)) {
		patch.condition = next.condition || null;
	}

	if ((next.notes || '') !== (entry.notes || '')) {
		patch.notes = next.notes || null;
	}

	if (next.storage !== undefined && (cleanPlace(next.storage) || null) !== (entry.storage || null)) {
		patch.storage = cleanPlace(next.storage) || null;
	}

	return patch;
}

// The sheet that adds copies of a card.
//
//   card        {id, name, number}
//   catalog     the record's catalog
//   lang        the language the card is viewed in, picked first
//   finishes    [{value, label}]
//   plain       the plain print's variantId, picked first (the scanner's
//               rule: never the last finish chosen)
//   extra       fields every new copy carries: a hand-made card's own
//               facts (js/custom-card.js)
export function openAddSheet({card, catalog, extra = null, finishes, lang, plain = null}) {
	const sheet = sheetElement();
	const close = () => sheet.close();
	const languages = copyLanguages(catalog);
	const error = h('p', {'aria-live': 'polite', class: 'form-error', id: 'copy-error'});

	const language = select('copy-language', languages.map(({code, label}) => ({label, value: code})), languages.some((item) => item.code === lang) ? lang : languages[0].code);
	const finish = select('copy-finish', finishOptions(finishes, null), plain && finishes.some((option) => option.value === plain) ? plain : NOT_SET);
	const condition = select('copy-condition', conditionOptions(), NOT_SET);
	const storage = placePicker({id: 'copy-storage'});
	const count = h('input', {class: 'search copy-count', id: 'copy-count', inputmode: 'numeric', max: MAX_ADD, min: 1, name: 'copy-count', step: 1, type: 'number', value: 1});
	const submit = h('button', {class: 'primary', id: 'copy-add-save', type: 'submit'}, 'Add 1 copy');

	const howMany = () => {
		const n = Number.parseInt(count.value, 10);

		return Number.isInteger(n) && n >= 1 && n <= MAX_ADD ? n : null;
	};

	count.addEventListener('input', () => {
		const n = howMany();

		submit.textContent = n ? `Add ${n} ${n === 1 ? 'copy' : 'copies'}` : 'Add copies';
	});

	// novalidate: the sheet says what is wrong in its own words.
	const form = h('form', {class: 'copy-form', id: 'copy-form', novalidate: true},
		field('Language', 'copy-language', language),
		field('Finish', 'copy-finish', finish),
		field('Condition', 'copy-condition', condition),
		field('Stored in', 'copy-storage', storage.element),
		field(`How many (1 to ${MAX_ADD})`, 'copy-count', count),
		error,
		submit
	);

	form.addEventListener('submit', async (event) => {
		event.preventDefault();
		error.textContent = '';

		const n = howMany();

		if (!n) {
			error.textContent = `Choose from 1 to ${MAX_ADD} copies.`;
			count.focus();

			return;
		}

		const fields = {...extra, card_id: card.id, catalog, language: language.value, language_source: 'manual', variant_id: catalog === 'custom' ? null : finish.value || null};

		if (catalog === 'custom' && finish.value) {
			fields.finish_raw = finish.value;
		}

		if (catalog !== 'custom' && catalogFor(language.value) !== catalog) {
			fields.fallback = true;
		}

		if (condition.value) {
			fields.condition = condition.value;
		}

		if (storage.value()) {
			fields.storage = storage.value();
		}

		submit.disabled = true;

		const added = [];

		try {
			for (let i = 0; i < n; i++) {
				added.push(await addCard(fields));
			}
		}
		catch (err) {
			submit.disabled = false;
			error.textContent = `${added.length ? `Only ${added.length} added. ` : 'Not added. '}${errorText(err)}`;

			return;
		}

		close();
		toast(`Added ${n} ${languageName(language.value)} ${n === 1 ? 'copy' : 'copies'}.`, {
			action: () => deleteCards(added.map((entry) => entry.id)).catch(() => {}),
			actionLabel: 'Undo',
			timeout: UNDO_MS,
		});
	});

	sheet.replaceChildren(
		head('Add a copy', close),
		h('p', {class: 'muted copy-sub'}, [card.name, card.number].filter(Boolean).join(' · ')),
		form
	);

	return show(sheet);
}

// ------------------------------------------------------ where it is stored

// A row's Stored in line on card detail, read only too: "Stored in Bulk box
// A". Null when the row's copies are stored nowhere. A copy in a binder
// pocket shows its pocket as well; the place says where the binder or the
// copy lives, and neither is made up from the other.
export function storedLine(entries) {
	const name = cleanPlace(entries && entries[0] && entries[0].storage);

	return name ? h('span', {class: 'copy-stored'}, `Stored in ${name}`) : null;
}

// How many place chips show before More.
const QUICK_PLACES = 8;

// The Stored in field: a text field (at most STORAGE_MAX characters) with
// the saved places as chips under it, most used first, and Not set first
// of all, so a tap is enough and typing is for a new place. Manage places
// opens the Places sheet over the sheet it sits in.
//
//   id      the text field's id; a label's for points at it
//   value   the place to start with
// Returns {element, refresh(), value()}, value() being the place as typed,
// cleaned ("" for Not set).
export function placePicker({id = 'copy-storage', value = ''} = {}) {
	let places = [];
	let expanded = false;

	const input = h('input', {
		autocapitalize: 'sentences',
		autocomplete: 'off',
		class: 'search place-input',
		enterkeyhint: 'done',
		id,
		list: `${id}-list`,
		maxlength: STORAGE_MAX,
		name: id,
		placeholder: 'Not set: tap a place or type one',
		type: 'text',
		value: cleanPlace(value),
	});
	const datalist = h('datalist', {id: `${id}-list`});
	const chips = h('div', {'aria-label': 'Saved places', class: 'place-chips', id: `${id}-chips`, role: 'group'});

	const chip = (label, place, on) => h('button', {
		'aria-pressed': String(on),
		class: 'chip place-chip',
		'data-place': place,
		onclick: () => {
			input.value = place;
			draw();
			chips.querySelector(`[data-place="${CSS.escape(place)}"]`)?.focus();
		},
		type: 'button',
	}, label);

	function draw() {
		const current = placeFold(input.value);
		const shown = expanded ? places : places.slice(0, QUICK_PLACES);

		datalist.replaceChildren(...places.map((place) => h('option', {value: place.name})));
		chips.replaceChildren(...[
			chip('Not set', '', !current),
			...shown.map((place) => chip(place.name, place.name, placeFold(place.name) === current)),
			places.length > shown.length
				? h('button', {class: 'chip place-more', onclick: () => {
					expanded = true;
					draw();
				}, type: 'button'}, `More (${places.length - shown.length})`)
				: null,
		].filter(Boolean));
	}

	async function refresh() {
		try {
			places = await listPlaces();
		}
		catch {
			// No places this time; typing still works.
		}

		draw();
	}

	input.addEventListener('input', draw);

	// What the Places sheet changed follows into the field, so saving the
	// sheet under it does not bring a renamed or removed place back.
	const manage = h('button', {class: 'link-button place-manage', id: `${id}-manage`, onclick: () => openPlacesSheet({onClose: ({removed, renamed}) => {
		const fold = placeFold(input.value);

		if (renamed.has(fold)) {
			input.value = renamed.get(fold);
		}
		else if (removed.has(fold)) {
			input.value = '';
		}

		refresh();
	}}), type: 'button'}, 'Manage places');

	draw();
	refresh();

	return {
		element: h('div', {class: 'place-picker'}, input, datalist, chips, manage),
		refresh,
		value: () => cleanPlace(input.value),
	};
}

// Undo for a change to places: on a toast, and in the Places sheet's own
// status line while it is open (a toast under an open sheet cannot be
// tapped). Either one undoes it, once.
function offerUndo(message, undo, {after = null, status = null} = {}) {
	let used = false;
	const run = async () => {
		if (used) {
			return;
		}

		used = true;

		try {
			await undoStorage(undo);

			if (status && status.isConnected) {
				status.replaceChildren(h('span', null, 'Undone.'));
			}

			if (after) {
				after();
			}
		}
		catch (err) {
			toast(`Could not undo. ${errorText(err)}`);
		}
	};

	if (status) {
		status.replaceChildren(
			h('span', null, message),
			h('button', {class: 'small', id: 'places-undo', onclick: run, type: 'button'}, 'Undo')
		);
	}

	toast(message, {action: run, actionLabel: 'Undo', timeout: UNDO_MS});
}

const copiesText = (n) => (n ? plural(n, 'copy', 'copies') : 'No copies');

// The Places sheet: every saved place with how many copies are stored
// there, to rename (every copy follows) or remove (its copies show Not set;
// asked first when copies are stored there). Both with Undo. onClose gets
// {renamed: Map old folded name -> new name, removed: Set of folded names}.
export function openPlacesSheet({onClose = null} = {}) {
	const sheet = dialog('places-sheet', 'Places');
	const renamed = new Map();
	const removed = new Set();
	const close = () => sheet.close();
	const status = h('div', {'aria-live': 'polite', class: 'places-status', id: 'places-status'});
	const list = h('ul', {class: 'places-list', id: 'places-list'});
	// The place being renamed, or asked about before removing, by folded name.
	let editing = null;
	let asking = null;

	async function rename(place, text) {
		const fold = placeFold(place.name);

		try {
			const done = await renamePlace(place.name, text);

			editing = null;
			renamed.set(fold, done.name);
			removed.delete(fold);
			offerUndo(`Renamed to ${done.name}${done.changed ? `, ${plural(done.changed, 'copy', 'copies')} updated` : ''}.`, done.undo, {
				after: () => {
					renamed.delete(fold);
					draw();
				},
				status,
			});
		}
		catch (err) {
			status.replaceChildren(h('span', {class: 'form-error'}, `Not renamed. ${errorText(err)}`));
		}

		draw(fold);
	}

	async function remove(place) {
		const fold = placeFold(place.name);

		try {
			const done = await removePlace(place.name);

			asking = null;
			removed.add(fold);
			offerUndo(`${place.name} removed${done.changed ? `, ${plural(done.changed, 'copy', 'copies')} now Not set` : ''}.`, done.undo, {
				after: () => {
					removed.delete(fold);
					draw();
				},
				status,
			});
		}
		catch (err) {
			status.replaceChildren(h('span', {class: 'form-error'}, `Not removed. ${errorText(err)}`));
		}

		draw();
	}

	function row(place, i) {
		const fold = placeFold(place.name);
		const label = h('span', {class: 'place-name'}, place.name);
		const count = h('span', {class: 'muted place-count'}, copiesText(place.count));

		if (editing === fold) {
			const field = h('input', {'aria-label': `New name for ${place.name}`, autocomplete: 'off', class: 'search place-input', id: `places-name-${i}`, maxlength: STORAGE_MAX, type: 'text', value: place.name});
			const form = h('form', {class: 'place-rename'},
				field,
				h('div', {class: 'place-actions'},
					h('button', {class: 'small', onclick: () => {
						editing = null;
						draw(fold);
					}, type: 'button'}, 'Cancel'),
					h('button', {class: 'small primary', type: 'submit'}, 'Save')
				)
			);

			form.addEventListener('submit', (event) => {
				event.preventDefault();

				if (!cleanPlace(field.value)) {
					status.replaceChildren(h('span', {class: 'form-error'}, 'A place needs a name.'));
					field.focus();

					return;
				}

				rename(place, field.value);
			});

			return h('li', {class: 'place-row', 'data-place': place.name}, form);
		}

		if (asking === fold) {
			return h('li', {class: 'place-row place-asking', 'data-place': place.name},
				h('span', {class: 'place-text'}, label),
				h('p', {class: 'place-ask'}, `${plural(place.count, 'copy is', 'copies are')} stored here; ${place.count === 1 ? 'it' : 'they'} will show Not set.`),
				h('div', {class: 'place-actions'},
					h('button', {class: 'small', onclick: () => {
						asking = null;
						draw(fold);
					}, type: 'button'}, 'Cancel'),
					h('button', {class: 'small danger place-remove-yes', onclick: () => remove(place), type: 'button'}, 'Remove')
				)
			);
		}

		return h('li', {class: 'place-row', 'data-place': place.name},
			h('span', {class: 'place-text'}, label, count),
			h('div', {class: 'place-actions'},
				h('button', {'aria-label': `Rename ${place.name}`, class: 'small place-rename-open', onclick: () => {
					editing = fold;
					asking = null;
					draw(fold);
				}, type: 'button'}, 'Rename'),
				h('button', {'aria-label': `Remove ${place.name}`, class: 'small place-remove', onclick: () => {
					if (place.count) {
						asking = fold;
						editing = null;
						draw(fold);
					}
					else {
						remove(place);
					}
				}, type: 'button'}, 'Remove')
			)
		);
	}

	// Redraws the list; focus goes to the row it was about (its first
	// control), or stays in the sheet.
	async function draw(focusFold = null) {
		let places = [];

		try {
			places = await listPlaces();
		}
		catch (err) {
			status.replaceChildren(h('span', {class: 'form-error'}, `The places could not be read. ${errorText(err)}`));
		}

		list.replaceChildren(...(places.length
			? places.map(row)
			: [h('li', {class: 'muted places-none'}, 'No places yet. Type one in a copy\'s Stored in field.')]));

		if (focusFold !== null && sheet.open) {
			const target = [...list.querySelectorAll('.place-row')].find((item) => placeFold(item.dataset.place) === focusFold);
			const control = target && target.querySelector('input, button');

			(control || sheet.querySelector('#places-close')).focus();
		}
	}

	sheet.replaceChildren(
		h('div', {class: 'sheet-head'},
			h('h2', {id: 'places-sheet-title'}, 'Places'),
			h('button', {class: 'small', id: 'places-close', onclick: close, type: 'button'}, 'Done')
		),
		h('p', {class: 'muted copy-sub'}, 'Where your copies are stored. Renaming a place renames it on every copy stored there.'),
		list,
		status
	);
	draw();

	return show(sheet, () => {
		if (onClose) {
			onClose({removed, renamed});
		}
	});
}

// Stores many copies in one place at once: My Cards' "Set storage for
// these N copies". entries are the copies; the field starts on their
// place when they share one. Undo on a toast puts every copy back.
export function openStoreSheet({entries}) {
	const sheet = dialog('store-sheet', 'Stored in');
	const close = () => sheet.close();
	const n = entries.length;
	const folds = new Set(entries.map((entry) => placeFold(entry.storage)));
	const picker = placePicker({id: 'store-place', value: folds.size === 1 ? entries[0].storage : ''});
	const error = h('p', {'aria-live': 'polite', class: 'form-error', id: 'store-error'});
	const submit = h('button', {class: 'primary', id: 'store-save', type: 'submit'}, `Save for ${plural(n, 'copy', 'copies')}`);
	const form = h('form', {class: 'copy-form', id: 'store-form'},
		field('Stored in', 'store-place', picker.element),
		error,
		submit
	);

	form.addEventListener('submit', async (event) => {
		event.preventDefault();
		error.textContent = '';
		submit.disabled = true;

		try {
			const done = await setStorage(entries.map((entry) => entry.id), picker.value());

			close();

			if (!done.changed) {
				toast(done.name ? `Every copy is already stored in ${done.name}.` : 'No copy had a place to clear.');

				return;
			}

			offerUndo(done.name
				? `${plural(done.changed, 'copy', 'copies')} stored in ${done.name}.`
				: `Stored in cleared on ${plural(done.changed, 'copy', 'copies')}.`, done.undo);
		}
		catch (err) {
			submit.disabled = false;
			error.textContent = `Not saved. ${errorText(err)}`;
		}
	});

	sheet.replaceChildren(
		h('div', {class: 'sheet-head'},
			h('h2', {id: 'store-sheet-title'}, 'Stored in'),
			h('button', {class: 'small', id: 'store-close', onclick: close, type: 'button'}, 'Close')
		),
		h('p', {class: 'muted copy-sub', id: 'store-sub'}, `${plural(n, 'copy', 'copies')}: the ones My Cards shows now. Not set clears their place.`),
		form
	);

	return show(sheet);
}

// ------------------------------------------------------------ the stepper

// "-  N  +" for a set of alike copies. + adds one copy alike at once; -
// removes one (removalPlan picks which, or asks) with Undo on a toast; the
// number can be typed, 0 to 999, and the difference is added or removed.
//
//   entries     the alike copies now (at least one, the pattern for +)
//   places      Map entry id -> binder place
//   label       what the copies are, for screen readers ("Portuguese,
//               Normal")
//   keep        a copy that never goes, and min 1: the copy in the pocket a
//               binder's sheet is for
//   min         the lowest count (0 on card detail, where 0 removes the row)
//   onChange    (count) => void after a change is written
export function copyStepper({entries, keep = null, label, min = 0, onChange = null, places = new Map()}) {
	const pattern = entries.find((entry) => entry.id === keep) || [...entries].sort(newestFirst)[0];
	let state = {entries, places};
	let busy = false;

	const less = h('button', {'aria-label': `One copy fewer: ${label}`, class: 'step step-less', type: 'button'}, '−');
	const more = h('button', {'aria-label': `One copy more: ${label}`, class: 'step step-more', type: 'button'}, '+');
	const count = h('input', {
		'aria-label': `Number of copies: ${label}`,
		class: 'step-count',
		enterkeyhint: 'done',
		inputmode: 'numeric',
		max: MAX_COUNT,
		min,
		type: 'number',
	});
	const element = h('div', {class: 'copy-stepper', role: 'group', 'aria-label': `Copies: ${label}`}, less, count, more);

	function draw() {
		const n = state.entries.length;

		// Never disabled while busy: a disabled button drops the focus. A tap
		// while a change is being written is ignored instead.
		count.value = String(n);
		less.disabled = n <= min;
		more.disabled = n >= MAX_COUNT;
		element.setAttribute('aria-busy', busy ? 'true' : 'false');
	}

	async function set(target) {
		const n = state.entries.length;
		const wanted = Math.max(min, Math.min(MAX_COUNT, target));

		if (busy || wanted === n || !Number.isInteger(wanted)) {
			draw();

			return;
		}

		busy = true;
		draw();

		try {
			if (wanted > n) {
				const added = await addAlike(pattern, wanted - n);

				if (added.length > 1) {
					toast(`Added ${added.length} copies.`, {
						action: () => deleteCards(added.map((entry) => entry.id)).catch(() => {}),
						actionLabel: 'Undo',
						timeout: UNDO_MS,
					});
				}
			}
			else {
				const plan = removalPlan(state.entries, n - wanted, {keep, places: state.places});
				let chosen = plan.chosen;

				if (plan.ask) {
					const picked = await askWhich({...plan.ask, places: state.places});

					if (!picked) {
						busy = false;
						draw();

						return;
					}

					chosen = [...chosen, ...picked];
				}

				await removeWithUndo(chosen, state.places);
			}

			state = await alikeNow(pattern);

			if (onChange) {
				onChange(state.entries.length);
			}
		}
		catch (err) {
			toast(`Could not change the count. ${errorText(err)}`);
		}

		busy = false;

		if (element.isConnected) {
			draw();

			// The focus stays where the finger is, through a redraw too.
			if (document.activeElement === document.body) {
				count.focus({preventScroll: true});
			}
		}
	}

	less.addEventListener('click', () => set(state.entries.length - 1));
	more.addEventListener('click', () => set(state.entries.length + 1));
	count.addEventListener('change', () => {
		const typed = Number.parseInt(count.value, 10);

		if (Number.isInteger(typed)) {
			set(typed);
		}
		else {
			draw();
		}
	});
	count.addEventListener('keydown', (event) => {
		if (event.key === 'Enter') {
			event.preventDefault();
			count.blur();
		}
	});
	count.addEventListener('focus', () => count.select());

	draw();

	return {element, refresh: async () => {
		state = await alikeNow(pattern);
		draw();
	}};
}

// The sheet parts js/custom-card-view.js builds its sheet from, so a
// hand-made card's sheet looks and behaves like the copy sheets.
export {conditionOptions, dialog as sheetDialog, field as sheetField, select as sheetSelect, show as showSheet};
