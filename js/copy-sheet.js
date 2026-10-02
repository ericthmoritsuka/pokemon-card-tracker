// Copies by hand on card detail (plans/audit-qa.md Q-01, plans/design-review.md
// "Card Detail"): the sheet that edits one copy's language, finish,
// condition, and notes, or removes it, and the sheet that adds copies of a
// card. Card detail (js/catalog-views.js) opens them; neither is shown in
// family view, which is read only.
//
// A removal waits a few seconds before it is written, with Undo on a toast,
// so taking a copy back keeps the very same entry: its photos, its binder
// pocket, and its Liga price. The collection has no way to bring a deleted
// entry back (js/collection.js deleteCard leaves a tombstone), so the copy
// stays in the document, hidden from card detail, until the time is up, the
// person leaves the page, or the app goes to the background.

import {catalogFor, isLanguage, languageLabel} from './catalog.js';
import {addCard, deleteCard, updateCard, updateCards} from './collection.js';
import {errorText, h} from './dom.js';
import {flagLanguageName} from './flags.js';
import {CONDITIONS} from './scan/session.js';
import {toast} from './shell.js';

// The most copies one Add makes: enough for a box of the same card, few
// enough that a slip of the thumb cannot add thousands (Q-08).
export const MAX_ADD = 20;

export const NOTES_MAX = 500;

// How long Undo stays on offer before a removal is written.
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

// ------------------------------------------------------ waiting removals

// entry id -> the batch it was removed with.
const waiting = new Map();
const watchers = new Set();

export const isRemoving = (id) => waiting.has(id);

// listener() runs when a removal starts, is undone, or is written. Returns
// the unsubscribe function.
export function onRemovals(listener) {
	watchers.add(listener);

	return () => watchers.delete(listener);
}

const notify = () => watchers.forEach((listener) => listener());

async function commit(batch) {
	if (batch.done) {
		return;
	}

	batch.done = true;
	clearTimeout(batch.timer);

	if (batch.note) {
		batch.note.remove();
	}

	const failed = [];

	for (const id of batch.ids) {
		try {
			await deleteCard(id);
		}
		catch (err) {
			failed.push(err);
		}
	}

	batch.ids.forEach((id) => waiting.delete(id));
	notify();

	if (failed.length) {
		toast(`Could not remove ${failed.length === 1 ? 'the copy' : `${failed.length} copies`}. ${errorText(failed[0])}`);
	}
}

function undo(batch) {
	if (batch.done) {
		return;
	}

	batch.done = true;
	clearTimeout(batch.timer);
	batch.ids.forEach((id) => waiting.delete(id));
	notify();
}

// Removes copies after UNDO_MS, with message and Undo on a toast. Returns
// a promise that settles once the removal is written or undone.
export function removeLater(ids, message) {
	const batch = {done: false, ids: [...ids], note: null, timer: null};

	batch.ids.forEach((id) => waiting.set(id, batch));
	notify();

	return new Promise((resolve) => {
		const finish = (work) => () => Promise.resolve(work(batch)).then(resolve, resolve);

		batch.note = toast(message, {action: finish(undo), actionLabel: 'Undo', timeout: UNDO_MS});
		batch.timer = setTimeout(finish(commit), UNDO_MS);
		batch.flush = finish(commit);
	});
}

// Writes every waiting removal now. Runs when the app is hidden or closed,
// so a removal is never lost, only its Undo.
export function flushRemovals() {
	const batches = new Set(waiting.values());

	return Promise.all([...batches].map((batch) => batch.flush()));
}

window.addEventListener('pagehide', () => {
	flushRemovals();
});
document.addEventListener('visibilitychange', () => {
	if (document.visibilityState === 'hidden') {
		flushRemovals();
	}
});

// ------------------------------------------------------------ the sheet

function sheetElement() {
	let sheet = document.getElementById('copy-sheet');

	if (!sheet) {
		sheet = h('dialog', {'aria-labelledby': 'copy-sheet-title', class: 'sheet copy-sheet', id: 'copy-sheet'});
		sheet.addEventListener('click', (event) => {
			if (event.target === sheet) {
				sheet.close();
			}
		});
		document.body.append(sheet);
	}

	return sheet;
}

// Closes the sheet if it is open, for card detail's cleanup.
export function closeCopySheet() {
	const sheet = document.getElementById('copy-sheet');

	if (sheet && sheet.open) {
		sheet.close();
	}
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

// The binder pockets some copies sit in, as one sentence for the remove
// confirmation: "It leaves Binder A, page 3." Null when none does.
export function leavesText(places) {
	const named = [...new Set(places.filter(Boolean).map((where) => `${where.binder_name}, page ${where.page}`))];

	if (!named.length) {
		return null;
	}

	const list = named.length === 1 ? named[0] : `${named.slice(0, -1).join('; ')} and ${named[named.length - 1]}`;

	return `${places.length === 1 ? 'It leaves' : 'They leave'} ${list}.`;
}

// The edit sheet for one row of Your copies.
//
//   card        {name, number} for the line under the title
//   entries     the row's copies, all alike (one or more)
//   catalog     the record's catalog
//   finishes    [{value, label}] for the finish select
//   where       the binder place of the row's copies, {binder_name, page,
//               position}, or null
//   placeText   where as words ("Binder A, page 3, pocket 5"), or null
export function openEditSheet({card, catalog, entries, finishes, placeText = null, where = null}) {
	const sheet = sheetElement();
	const first = entries[0];
	const many = entries.length > 1;
	const close = () => sheet.close();
	const error = h('p', {'aria-live': 'polite', class: 'form-error', id: 'copy-error'});

	const language = select('copy-language', copyLanguages(catalog, first.language).map(({code, label}) => ({label, value: code})), first.language);
	const finish = select('copy-finish', finishOptions(finishes, first.variant_id), first.variant_id || NOT_SET);
	const condition = select('copy-condition', conditionOptions(), CONDITIONS.includes(first.condition) ? first.condition : NOT_SET);
	const notes = h('textarea', {class: 'copy-notes', id: 'copy-notes', maxlength: NOTES_MAX, name: 'copy-notes', rows: 2}, first.notes || '');

	// A row of alike copies changes one of them, or all of them.
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
	const targets = () => (scope === 'all' ? entries : [entries[entries.length - 1]]);

	const remove = h('button', {class: 'danger', id: 'copy-remove', type: 'button'});
	const leaves = h('p', {class: 'muted copy-leaves', id: 'copy-leaves'});

	function drawRemove() {
		const count = targets().length;

		remove.textContent = count === 1 ? 'Remove copy' : `Remove ${count} copies`;

		const text = where ? leavesText(targets().map(() => where)) : null;

		leaves.textContent = text ? `${text.replace(/\.$/, '')} when removed.` : '';
		leaves.hidden = !text;
	}

	drawRemove();

	remove.addEventListener('click', () => {
		const chosen = targets();
		const what = chosen.length === 1 ? `${languageName(first.language)} copy removed.` : `${chosen.length} copies removed.`;
		const text = where ? leavesText(chosen.map(() => where)) : null;

		close();
		removeLater(chosen.map((entry) => entry.id), text ? `${what} ${text}` : what);
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

	sheet.replaceChildren(
		head(many ? `Edit copies (${entries.length} alike)` : 'Edit copy', close),
		h('p', {class: 'muted copy-sub'}, [card.name, card.number, placeText].filter(Boolean).join(' · ')),
		form,
		h('div', {class: 'copy-danger'}, remove, leaves)
	);
	sheet.showModal();

	return sheet;
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
			action: async () => {
				for (const entry of added) {
					await deleteCard(entry.id).catch(() => {});
				}
			},
			actionLabel: 'Undo',
			timeout: UNDO_MS,
		});
	});

	sheet.replaceChildren(
		head('Add a copy', close),
		h('p', {class: 'muted copy-sub'}, [card.name, card.number].filter(Boolean).join(' · ')),
		form
	);
	sheet.showModal();

	return sheet;
}
