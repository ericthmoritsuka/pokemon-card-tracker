// Copies by hand (plans/audit-qa.md Q-01, plans/design-review.md "Card
// Detail"): the sheet that edits one copy's language, finish, condition, and
// notes, or removes it; the sheet that adds copies of a card; and the count
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
import {addCard, deleteCards, listCards, restoreCard, updateCard, updateCards} from './collection.js';
import {errorText, h} from './dom.js';
import {flagLanguageName} from './flags.js';
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
		: catalog === 'ja' ? ['ja', 'ko'] : [catalog];

	if (current && !codes.includes(current)) {
		codes.push(current);
	}

	return codes.map((code) => ({code, label: languageName(code)}));
}

// ---------------------------------------------------------- alike copies

// Copies are alike when they are the same card in the same catalog, in the
// same language, finish, and condition. A row of Your copies holds alike
// copies, and the stepper counts them.
export const alikeKey = (entry) => JSON.stringify([
	entry.catalog || 'international',
	entry.card_id,
	entry.language || null,
	entry.variant_id || null,
	// An unmatched monprice finish tells copies apart only without a variant.
	entry.variant_id ? null : entry.finish_raw || null,
	entry.condition || null,
]);

// What a copy added by + carries over from one alike: the card, language,
// finish, condition, and the source's names; never notes, photos, prices,
// or a binder pocket.
export function alikeFields(entry) {
	const fields = {
		card_id: entry.card_id,
		catalog: entry.catalog || 'international',
		language: entry.language,
		language_source: 'manual',
		variant_id: entry.variant_id || null,
	};

	for (const key of ['condition', 'fallback', 'name_local', 'set_name_local']) {
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
	for (const id of ['copy-pick-sheet', 'copy-sheet']) {
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
	const finish = select('copy-finish', finishOptions(finishes, first.variant_id), first.variant_id || NOT_SET);
	const condition = select('copy-condition', conditionOptions(), CONDITIONS.includes(first.condition) ? first.condition : NOT_SET);
	const notes = h('textarea', {class: 'copy-notes', id: 'copy-notes', maxlength: NOTES_MAX, name: 'copy-notes', rows: 2}, first.notes || '');

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
			variant_id: finish.value || null,
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
	// Japanese record) is a fallback match (DESIGN.md section 5).
	const fallback = catalogFor(next.language) !== catalog;

	if (fallback !== Boolean(entry.fallback)) {
		patch.fallback = fallback;
	}

	if ((next.variant_id || null) !== (entry.variant_id || null)) {
		patch.variant_id = next.variant_id || null;
	}

	if ((next.condition || null) !== (entry.condition || null)) {
		patch.condition = next.condition || null;
	}

	if ((next.notes || '') !== (entry.notes || '')) {
		patch.notes = next.notes || null;
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
export function openAddSheet({card, catalog, finishes, lang, plain = null}) {
	const sheet = sheetElement();
	const close = () => sheet.close();
	const languages = copyLanguages(catalog);
	const error = h('p', {'aria-live': 'polite', class: 'form-error', id: 'copy-error'});

	const language = select('copy-language', languages.map(({code, label}) => ({label, value: code})), languages.some((item) => item.code === lang) ? lang : languages[0].code);
	const finish = select('copy-finish', finishOptions(finishes, null), plain && finishes.some((option) => option.value === plain) ? plain : NOT_SET);
	const condition = select('copy-condition', conditionOptions(), NOT_SET);
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

		const fields = {card_id: card.id, catalog, language: language.value, language_source: 'manual', variant_id: finish.value || null};

		if (catalogFor(language.value) !== catalog) {
			fields.fallback = true;
		}

		if (condition.value) {
			fields.condition = condition.value;
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
