// Bulk select on My Cards (Eric, 2026-11-18: change many cards at once
// instead of opening each one). Select, at the end of the summary line,
// starts it; a tap on a tile then ticks it instead of opening the card, and
// a bar docked above the tab bar counts the ticked tiles and offers Select
// all shown, Clear, Done, and Actions. Only the person's own My Cards offers
// it (js/cards-view.js myCardsView): never a family member's cards, which are
// read only, and never the binder pickers.
//
// A tile is one card in one language, holding one or more copies, and every
// action applies to every copy of each ticked tile: Stored in, Add to
// binder, Language, Finish, Condition, Favorite on or off, and Remove copies.
// Each saves the whole batch in one write and offers Undo on a toast, which
// puts every copy back as it was. What each one changes is worked out in
// js/bulk-edit.js, without the page.
//
// The ticked tiles are kept by key while the screen is open, so a redraw
// (a save, a sync, a filter) keeps them; Done or leaving the screen ends it.

import {binderCopies, fieldPatches, finishLabels, finishPlan, languageChoices, languagePlan, undoPatches} from './bulk-edit.js';
import {addCopiesToListBinder, listLanguagesOf, planListAdds} from './binder-add.js';
import {binderList, listAddText, listAddUndo} from './binder-hand.js';
import {claimIndex, isGenerated} from './binder-rules.js';
import {copyClaims, handBinders, liveBinders, placements, sortBinders, stagedOf} from './binders.js';
import {cardDetail, cardIndex, catalogLanguage} from './catalog.js';
import {finishChoices} from './catalog-views.js';
import {isLive, loadDocument, updateCards} from './collection.js';
import {
	conditionOptions,
	copyPlaces,
	leavesText,
	openStoreSheet,
	rawFinishes,
	removeWithUndo,
	sheetDialog,
	sheetField,
	sheetSelect,
	showSheet,
	UNDO_MS,
} from './copy-sheet.js';
import {BASE, errorText, h} from './dom.js';
import {formatCount, plural} from './format.js';
import {languageLabel} from './languages.js';
import {addToBinder, undoAddToBinder} from './placeholder-fill.js';
import {toast} from './shell.js';
import {pool} from './tcgdex.js';

const SHEET = 'bulk-sheet';

// The most cards whose finishes are read from TCGdex for one Finish: the
// rest are said to be unknown rather than sending hundreds of requests.
const FINISH_READS = 60;

const copiesOf = (tiles) => tiles.flatMap((tile) => tile.entries);

// "1 card was left as it was: it cannot be in Korean." Empty for none.
const leftText = (n, one, many) => {
	if (!n) {
		return '';
	}

	return n === 1 ? `1 card was left as it was: it ${one}.` : `${formatCount(n)} cards were left as they were: they ${many}.`;
};

const sentences = (...parts) => parts.filter(Boolean).join(' ');

// The tiles and their copies in words: "the 3 selected cards".
const selectedCards = (n) => (n === 1 ? 'the selected card' : `the ${formatCount(n)} selected cards`);

//   grid        the card grid, whose clicks tick tiles while selecting
//   groups()    every tile My Cards has now, filtered or not
//   visible()   the tiles the search and filters show, every page of them
//   tiles()     Map key -> the tile element drawn for it
//   fullRecord(group)  the card's full TCGdex record saved on the phone,
//                      for its finishes, or null
//   recordsReady()     resolves once fullRecord has every record My Cards
//                      reads after its first screen
// Returns {bar, button, destroy, mark, shown}: mark(element, key) dresses a
// tile as it is drawn, and shown(visible) follows each draw.
export function bulkSelect({fullRecord, grid, groups, recordsReady = () => Promise.resolve(), tiles, visible}) {
	let selecting = false;
	const selected = new Set();
	// Keys a save is about to give a ticked tile (a new language): kept
	// while it runs, though no tile has them yet.
	const coming = new Set();

	const button = h('button', {class: 'small cards-select', id: 'cards-select', onclick: () => start(), type: 'button'}, 'Select');
	const count = h('p', {'aria-live': 'polite', class: 'bulk-count', id: 'bulk-count'});
	const clear = h('button', {class: 'small', id: 'bulk-clear', onclick: () => clearAll(), type: 'button'}, 'Clear');
	const done = h('button', {class: 'small', id: 'bulk-done', onclick: () => stop(), type: 'button'}, 'Done');
	const all = h('button', {class: 'small bulk-all', id: 'bulk-all', onclick: () => selectAll(), type: 'button'}, 'Select all shown');
	const actions = h('button', {'aria-haspopup': 'dialog', class: 'small primary', id: 'bulk-actions', onclick: () => openMenu(), type: 'button'}, 'Actions');
	const bar = h('div', {'aria-label': 'Selected cards', class: 'bulk-bar', hidden: true, id: 'bulk-bar', role: 'region'},
		h('div', {class: 'bulk-row'}, count, clear, done),
		h('div', {class: 'bulk-row'}, all, actions)
	);

	// ------------------------------------------------------------- ticking

	const chosenTiles = () => groups().filter((group) => selected.has(group.key));

	// A tile drawn while selecting is a checkbox: its art carries a circle,
	// ticked or empty, so the state never rests on colour alone.
	function paint(element, on) {
		element.classList.add('bulk-tile');
		element.classList.toggle('bulk-on', on);
		element.setAttribute('role', 'checkbox');
		element.setAttribute('aria-checked', String(on));

		let check = element.querySelector('.bulk-check');

		if (!check) {
			check = h('span', {'aria-hidden': 'true', class: 'bulk-check'});
			(element.querySelector('.art-wrap') || element).append(check);
		}

		check.textContent = on ? '✓' : '';
	}

	function unpaint(element) {
		element.classList.remove('bulk-tile', 'bulk-on');
		element.removeAttribute('role');
		element.removeAttribute('aria-checked');
		element.querySelector('.bulk-check')?.remove();
	}

	function repaint() {
		for (const [key, element] of tiles()) {
			if (selecting) {
				paint(element, selected.has(key));
			}
			else {
				unpaint(element);
			}
		}
	}

	function mark(element, key) {
		element.dataset.bulkKey = key;

		if (selecting) {
			paint(element, selected.has(key));
		}

		return element;
	}

	function update() {
		const list = visible();
		const shownKeys = new Set(list.map((group) => group.key));
		const n = selected.size;
		const hidden = [...selected].filter((key) => !shownKeys.has(key)).length;

		count.textContent = n
			? `${formatCount(n)} selected${hidden ? ` (${formatCount(hidden)} not shown)` : ''}`
			: 'Tap cards to select them';
		all.textContent = `Select all shown (${formatCount(list.length)})`;
		all.disabled = !list.length || list.every((group) => selected.has(group.key));
		clear.disabled = !n;
		actions.disabled = !n;
	}

	function toggle(element) {
		const key = element.dataset.bulkKey;

		if (!key) {
			return;
		}

		if (selected.has(key)) {
			selected.delete(key);
		}
		else {
			selected.add(key);
		}

		paint(element, selected.has(key));
		update();
	}

	function start() {
		selecting = true;
		grid.classList.add('bulk-selecting');
		button.hidden = true;
		bar.hidden = false;
		repaint();
		update();
		all.focus();
	}

	function stop() {
		selecting = false;
		selected.clear();
		coming.clear();
		grid.classList.remove('bulk-selecting');
		repaint();
		bar.hidden = true;
		button.hidden = false;
		button.focus();
	}

	function selectAll() {
		for (const group of visible()) {
			selected.add(group.key);
		}

		repaint();
		update();
	}

	function clearAll() {
		selected.clear();
		repaint();
		update();
		all.focus();
	}

	// A tap or Enter on a tile ticks it instead of opening the card: the
	// click is cancelled, so app.js does not follow the link. Space ticks it
	// too, as on any checkbox.
	const onClick = (event) => {
		const element = selecting && event.target.closest('.bulk-tile');

		if (element && grid.contains(element)) {
			event.preventDefault();
			toggle(element);
		}
	};
	const onKey = (event) => {
		if (selecting && event.key === ' ' && event.target.classList.contains('bulk-tile')) {
			event.preventDefault();
			toggle(event.target);
		}
	};

	grid.addEventListener('click', onClick);
	grid.addEventListener('keydown', onKey);

	// After each draw: tiles that are gone (every copy removed) leave the
	// selection, and the count follows.
	function shown() {
		if (!selecting) {
			return;
		}

		const keys = new Set(groups().map((group) => group.key));

		for (const key of selected) {
			if (!keys.has(key) && !coming.has(key)) {
				selected.delete(key);
			}
		}

		update();
	}

	// ------------------------------------------------------------- saving

	// Saves patches in one write, then a toast with Undo that writes each
	// changed field back. afterUndo runs once Undo has saved.
	async function save(patches, message, {afterUndo = null} = {}) {
		const back = undoPatches(copiesOf(groups()), patches);

		await updateCards(patches);
		toast(message, {
			action: () => updateCards(back)
				.then(() => afterUndo && afterUndo())
				.catch((err) => toast(`Could not undo. ${errorText(err)}`)),
			actionLabel: 'Undo',
			timeout: UNDO_MS,
		});
	}

	// ------------------------------------------------------------- sheets

	const sheet = () => sheetDialog(SHEET, 'Change the selected cards');

	const close = () => {
		const element = document.getElementById(SHEET);

		if (element && element.open) {
			element.close();
		}
	};

	// Closes the sheet, then runs next once it is off the stack: a dialog's
	// close event comes a moment later, and a sheet opened before it would
	// be closed with it (js/sheet.js closes every sheet above the one that
	// closes).
	const closeThen = (next) => {
		const element = document.getElementById(SHEET);

		if (!element || !element.open) {
			next();

			return;
		}

		element.addEventListener('close', () => setTimeout(next, 0), {once: true});
		element.close();
	};

	const head = (title) => h('div', {class: 'sheet-head'},
		h('h2', {id: `${SHEET}-title`}, title),
		h('button', {class: 'small', id: 'bulk-close', onclick: close, type: 'button'}, 'Close')
	);

	// Puts a step in the sheet and moves focus into it, as the button that
	// had it is gone. Remove copies starts on Cancel, so a stray Enter
	// removes nothing.
	function step(...children) {
		const element = sheet();

		element.replaceChildren(...children.filter(Boolean));
		showSheet(element);
		(element.querySelector('select, .bulk-menu button, .atb-binder, #bulk-remove-cancel') || element.querySelector('#bulk-close')).focus();

		return element;
	}

	function openMenu() {
		const chosen = chosenTiles();

		if (!chosen.length) {
			return;
		}

		const action = (id, label, run, className = 'bulk-action') => h('button', {class: className, id, onclick: run, type: 'button'}, label);

		step(
			head(`Change ${formatCount(chosen.length)} selected`),
			h('p', {class: 'muted copy-sub', id: 'bulk-sub'}, `${plural(copiesOf(chosen).length, 'copy', 'copies')} in all. Each change applies to every copy of ${selectedCards(chosen.length)}.`),
			h('div', {'aria-label': 'Changes', class: 'bulk-menu', role: 'group'},
				action('bulk-store', 'Stored in', storeStep),
				action('bulk-binder', 'Add to binder', () => binderStep().catch(failed)),
				action('bulk-language', 'Language', languageStep),
				action('bulk-finish', 'Finish', () => finishStep().catch(failed)),
				action('bulk-condition', 'Condition', conditionStep),
				action('bulk-fav-on', 'Mark as a favorite', () => favorite(true)),
				action('bulk-fav-off', 'Remove from favorites', () => favorite(false)),
				action('bulk-remove', 'Remove copies', () => removeStep().catch(failed), 'bulk-action danger')
			)
		);
	}

	const failed = (err) => {
		close();
		toast(`Not saved. ${errorText(err)}`);
	};

	// A form with one select and Save: Language, Finish, and Condition.
	function selectForm({id, label, note = null, onSave, options, value}) {
		const control = sheetSelect(id, options, value);
		const submit = h('button', {class: 'primary', id: 'bulk-save', type: 'submit'}, 'Save');
		const form = h('form', {class: 'copy-form', id: 'bulk-form'},
			sheetField(label, id, control),
			note ? h('p', {class: 'muted bulk-note', id: 'bulk-note'}, note) : null,
			submit
		);

		form.addEventListener('submit', (event) => {
			event.preventDefault();
			submit.disabled = true;
			close();
			Promise.resolve(onSave(control.value)).catch((err) => toast(`Not saved. ${errorText(err)}`));
		});

		return form;
	}

	// The value every copy shares, or fallback when they differ.
	const shared = (entries, read, fallback) => {
		const values = new Set(entries.map(read));

		return values.size === 1 ? [...values][0] : fallback;
	};

	// Stored in: the copy sheets' own place picker (js/copy-sheet.js
	// openStoreSheet), which saves in one write and offers Undo.
	function storeStep() {
		const entries = copiesOf(chosenTiles());
		const sub = `${plural(entries.length, 'copy', 'copies')}: every copy of ${selectedCards(chosenTiles().length)}. Not set clears their place.`;

		closeThen(() => openStoreSheet({entries, sub}));
	}

	// Add to binder: a binder to choose, as on a card's page, and the copies
	// go to its tray (or its placeholders for them, with "Fill binder
	// placeholders automatically" on), as the binder's Add cards to the tray
	// does (js/placeholder-fill.js addToBinder). Copies already in a pocket
	// or a tray stay where they are.
	// A binder made from a list is offered too (Eric, 2026-11-24): each card
	// shows a copy in its pocket there, or joins after the list, one copy per
	// card, as on a card's page (js/binder-add.js); its row says how many of
	// each before the tap.
	async function binderStep() {
		const [doc, index] = await Promise.all([loadDocument(), cardIndex().catch(() => new Map())]);
		const placed = placements(doc.binders);
		const trayed = new Set(handBinders(doc.binders).flatMap((binder) => stagedOf(binder)));
		const {ids, kept} = binderCopies(chosenTiles(), new Set(placed.keys()), trayed);
		const all = sortBinders(liveBinders(doc.binders));
		// Hand-made binders only while a selected copy is free to go in.
		const binders = all.filter((binder) => isGenerated(binder) || ids.length);
		const keptText = kept && ids.length ? `${plural(kept, 'copy', 'copies')} already in a pocket or a tray ${kept === 1 ? 'stays where it is' : 'stay where they are'}.` : null;
		const selectedCopies = copiesOf(chosenTiles());
		const claims = claimIndex(copyClaims(doc));
		const plans = new Map(all.filter(isGenerated).map((binder) => [binder.id, planListAdds(binder, selectedCopies, {claims, index, languages: listLanguagesOf(binder, doc)})]));
		const noteOf = (binder) => {
			const plan = plans.get(binder.id);

			if (!plan) {
				return null;
			}

			return [
				plan.picks.length ? `${plural(plan.picks.length, 'copy shows', 'copies show')} in ${plan.picks.length === 1 ? 'its pocket' : 'their pockets'}` : null,
				plan.adds.length ? `${plural(plan.adds.length, 'card', 'cards')} added after the list` : null,
			].filter(Boolean).join(', ') + '.';
		};

		const choose = async (binder) => {
			close();

			if (plans.has(binder.id)) {
				try {
					const done = await addCopiesToListBinder(binder.id, selectedCopies);

					toast(listAddText(binder, done), {action: listAddUndo(binder, done, toast), actionLabel: 'Undo', timeout: UNDO_MS});
				}
				catch (err) {
					toast(`Could not add the copies to ${binder.name}. ${errorText(err)}`);
				}

				return;
			}

			let result;

			try {
				result = await addToBinder(binder.id, ids);
			}
			catch (err) {
				toast(`Could not add the copies to ${binder.name}. ${errorText(err)}`);

				return;
			}

			const into = result.placed.length ? `${plural(result.placed.length, 'copy', 'copies')} went into ${binder.name}'s placeholders` : '';
			const trayedText = result.staged.length ? `${plural(result.staged.length, 'copy', 'copies')} added to the tray of ${binder.name}` : '';

			toast(`${[into, trayedText].filter(Boolean).join('; ')}.`, {
				action: () => undoAddToBinder(binder.id, result).catch((err) => toast(`Could not take them back out. ${errorText(err)}`)),
				actionLabel: 'Undo',
				timeout: UNDO_MS,
			});
		};

		let body;

		if (!binders.length) {
			body = [
				h('p', {id: 'bulk-binder-none'}, all.length ? 'Every selected copy is already in a binder pocket or a tray.' : 'You have no binders yet.'),
				all.length ? null : h('a', {class: 'button', 'data-link': 'binders', href: `${BASE}binders`, onclick: close}, 'Make a binder'),
			];
		}
		else {
			const lists = binders.some(isGenerated);
			const hands = binders.some((binder) => !isGenerated(binder));

			body = [
				h('p', {class: 'muted copy-sub', id: 'bulk-binder-intro'}, [
					hands ? `In a binder you arrange by hand, ${plural(ids.length, 'copy waits', 'copies wait')} in its tray until you place ${ids.length === 1 ? 'it' : 'them'}.` : null,
					lists ? 'In a binder made from a list, one copy of each card shows in its pocket, or the card joins after the list.' : null,
				].filter(Boolean).join(' ')),
				keptText ? h('p', {class: 'muted bulk-note', id: 'bulk-binder-kept'}, keptText) : null,
				binderList({binders, choose, id: 'bulk-binder-list', liveIds: new Set((doc.cards || []).filter(isLive).map((entry) => entry.id)), noteOf, placed}),
			];
		}

		step(head('Add to binder'), ...body);
	}

	// Moves ticked keys to the keys a language change gives them, held
	// until the save is done. Returns a function that lets them go.
	function follow(keys) {
		const held = [];

		for (const [from, to] of keys) {
			if (selected.has(from)) {
				selected.delete(from);
				selected.add(to);
				coming.add(to);
				held.push(to);
			}
		}

		return () => {
			held.forEach((key) => coming.delete(key));
			shown();
		};
	}

	function languageStep() {
		const chosen = chosenTiles();
		const n = chosen.length;
		const options = languageChoices(chosen);
		const value = shared(copiesOf(chosen), (entry) => entry.language, options[0].code);
		const someOnly = options.some((option) => option.fits < n);

		step(head('Language'), selectForm({
			id: 'bulk-language-select',
			label: 'Language',
			note: someOnly ? 'A language with a count fits only some of the cards: the others stay as they are.' : null,
			onSave: async (code) => {
				const tiles = chosenTiles();
				const plan = languagePlan(tiles, code);
				const label = languageLabel(code);
				const left = leftText(plan.skipped, `cannot be in ${label}`, `cannot be in ${label}`);

				if (!plan.patches.length) {
					toast(sentences(plan.skipped === tiles.length ? '' : `Every copy is already in ${label}.`, left));

					return;
				}

				// After Undo the ticks are exactly the ones from before: a
				// tile the change merged into (English Charmander set to
				// Portuguese beside a Portuguese one) was never picked, so it
				// is not left ticked (2026-11-19).
				const before = [...selected];
				const release = follow(plan.keys);

				try {
					await save(plan.patches, sentences(`${label} set on ${plural(plan.patches.length, 'copy', 'copies')}.`, left), {afterUndo: () => {
						if (selecting) {
							selected.clear();
							before.forEach((key) => selected.add(key));
						}

						// The redraw after Undo's save came first, so its tiles
						// were drawn unticked: paint them for the keys back.
						repaint();
						shown();
					}});
				}
				finally {
					release();
				}
			},
			options: options.map(({code, fits}) => ({label: fits < n ? `${languageLabel(code)} (${fits} of ${n})` : languageLabel(code), value: code})),
			value,
		}));
	}

	// Each tile's finishes, [{label, value}], by key: the card's saved full
	// record, or TCGdex (cache first) for a few without one. Null where they
	// are not known. A hand-made card takes monprice's finish words.
	async function finishesOf(tiles) {
		// Read on its own past the first screen's records, a card My Cards
		// was still reading would count as not known on this phone.
		await recordsReady();

		const found = new Map();
		const read = (variants) => {
			const choices = Array.isArray(variants) ? finishChoices(variants) : [];

			return choices.length ? choices : null;
		};
		const missing = [];

		for (const tile of tiles) {
			if (tile.catalog === 'custom') {
				found.set(tile.key, rawFinishes());

				continue;
			}

			const choices = read((fullRecord(tile) || {}).variants_detailed);

			if (choices) {
				found.set(tile.key, choices);
			}
			else {
				missing.push(tile);
			}
		}

		await pool(missing.slice(0, FINISH_READS), 4, async (tile) => {
			try {
				const hit = await cardDetail(catalogLanguage(tile.catalog), tile.cardId);
				const choices = read(hit && hit.data && hit.data.variants_detailed);

				if (choices) {
					found.set(tile.key, choices);
				}
			}
			catch {
				// Not known, then: the card is left as it is.
			}
		});

		return found;
	}

	async function finishStep() {
		const chosen = chosenTiles();
		const n = chosen.length;
		const element = step(head('Finish'), h('p', {class: 'muted copy-sub', id: 'bulk-finish-reading'}, 'Reading the cards\' finishes.'));
		const known = await finishesOf(chosen);
		const choicesOf = (tile) => known.get(tile.key) || null;
		const labels = finishLabels(chosen, choicesOf);

		if (!element.open) {
			return;
		}

		if (!labels.length) {
			step(head('Finish'), h('p', {id: 'bulk-finish-none'}, 'The finishes of these cards are not known on this phone yet. Open one of them while online, then try again.'));

			return;
		}

		step(head('Finish'), selectForm({
			id: 'bulk-finish-select',
			label: 'Finish',
			note: 'Only the cards that come in the finish you pick change. A finish with a count fits only some of them.',
			onSave: async (label) => {
				const plan = finishPlan(chosenTiles(), label, choicesOf);
				const left = sentences(
					leftText(plan.missing, `does not come in ${label}`, `do not come in ${label}`),
					leftText(plan.unknown, 'has no finishes known on this phone yet', 'have no finishes known on this phone yet')
				);

				if (!plan.patches.length) {
					toast(sentences(plan.missing + plan.unknown < chosenTiles().length ? `Every copy that comes in ${label} already has it.` : '', left));

					return;
				}

				await save(plan.patches, sentences(`${label} set on ${plural(plan.patches.length, 'copy', 'copies')}.`, left));
			},
			options: labels.map(({fits, label}) => ({label: fits < n ? `${label} (${fits} of ${n})` : label, value: label})),
			value: labels[0].label,
		}));
	}

	function conditionStep() {
		const chosen = chosenTiles();
		const options = conditionOptions();

		step(head('Condition'), selectForm({
			id: 'bulk-condition-select',
			label: 'Condition',
			onSave: async (value) => {
				const patches = fieldPatches(copiesOf(chosenTiles()), {condition: value || null});

				if (!patches.length) {
					toast(value ? `Every copy is already ${value}.` : 'No copy had a condition to clear.');

					return;
				}

				await save(patches, value
					? `Condition set to ${value} on ${plural(patches.length, 'copy', 'copies')}.`
					: `Condition cleared on ${plural(patches.length, 'copy', 'copies')}.`);
			},
			options,
			value: shared(copiesOf(chosen), (entry) => (options.some((option) => option.value === entry.condition) ? entry.condition : ''), ''),
		}));
	}

	// Favorite on or off, at once from the menu: is_favorite on each copy,
	// as the card page's star sets it on every copy of a card.
	function favorite(on) {
		const patches = fieldPatches(copiesOf(chosenTiles()), {is_favorite: on});

		close();

		if (!patches.length) {
			toast(on ? 'Every copy is already a favorite.' : 'No copy was a favorite.');

			return;
		}

		const n = patches.length;

		save(patches, on
			? `${plural(n, 'copy', 'copies')} marked as ${n === 1 ? 'a favorite' : 'favorites'}.`
			: `${plural(n, 'copy', 'copies')} removed from favorites.`).catch(failed);
	}

	// Remove copies: asked first, naming how many copies go and the binder
	// pockets they leave, then removed in one write with Undo, which brings
	// the very same copies back into their pockets (js/copy-sheet.js
	// removeWithUndo, as Remove copy on a card's page).
	async function removeStep() {
		const chosen = chosenTiles();
		const entries = copiesOf(chosen);
		const places = await copyPlaces().catch(() => new Map());
		const leaves = leavesText(entries.map((entry) => places.get(entry.id)).filter(Boolean));
		const what = plural(entries.length, 'copy', 'copies');
		const confirm = h('button', {class: 'danger', id: 'bulk-remove-confirm', type: 'button'}, `Remove ${what}`);

		confirm.addEventListener('click', () => {
			confirm.disabled = true;
			close();
			removeWithUndo(entries, places).catch((err) => toast(`Not removed. ${errorText(err)}`));
		});

		step(
			head('Remove copies'),
			h('p', {id: 'bulk-remove-text'}, `This removes ${what}: every copy of ${selectedCards(chosen.length)}.`),
			leaves ? h('p', {class: 'muted', id: 'bulk-remove-leaves'}, leaves) : null,
			h('p', {class: 'muted'}, 'Undo on the message that follows brings them back, in their pockets.'),
			h('div', {class: 'copy-danger-row bulk-remove-row'},
				h('button', {id: 'bulk-remove-cancel', onclick: close, type: 'button'}, 'Cancel'),
				confirm
			)
		);
	}

	function destroy() {
		grid.removeEventListener('click', onClick);
		grid.removeEventListener('keydown', onKey);
		close();
	}

	return {bar, button, destroy, mark, shown};
}
