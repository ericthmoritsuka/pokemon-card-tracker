// Copies with no finish set (Eric, 2026-11-26): every copy whose finish was
// never said, by set, with a bulk Set finish. An unset finish never pairs
// with Normal, so real duplicates with no finish stay home and never reach
// the spares (js/wishlist.js copyFinishKey); setting it is what lets them
// count. The list, the selection, and the reading of printings are worked
// out in js/unset-finish.js.
//
// A card is one tile (card and language) holding its unset copies. Each tile
// has a checkbox, and each set a Select all that ticks its cards. Set finish
// opens a sheet that reads the ticked cards' printings, FINISH_READS cards
// at a time with the progress said (js/bulk-edit.js), from the records saved
// on the phone first and TCGdex, cache first, for the rest, as My Cards'
// Finish does; then offers the finishes, a card's only printing first, and
// saves them with js/bulk-edit.js finishPlan in one write with Undo.
//
// Route (app.js, through js/copy-cleanup.js):
//   trade/check/finish    from Check spares, one line under its heading

import {finishPlan, undoPatches} from './bulk-edit.js';
import {artOf, entryInfo, fillRecords} from './binders-view.js';
import {cardDetail, catalogLanguage, cardIndex, indexKey, savedCardRecords, viewingLanguage} from './catalog.js';
import {finishChoices} from './catalog-views.js';
import {loadDocument, onChange, updateCards} from './collection.js';
import {UNDO_MS, languageName, rawFinishes, sheetDialog, sheetField, sheetSelect, showSheet} from './copy-sheet.js';
import {BASE, backWords, errorText, h} from './dom.js';
import {plural} from './format.js';
import {toast} from './shell.js';
import {tileArt} from './tile.js';
import {copyCount, finishOptions, groupBySet, progressText, pruneSelection, readFinishes, savedText, selectState, setIdOf, toggleSet, unsetTiles} from './unset-finish.js';

const SHEET = 'finish-sheet';

export function unsetFinishView(root) {
	let alive = true;
	let index = new Map();
	let tiles = [];
	let selected = new Set();
	// Each tile's finishes, [{label, value}], by tile key, once read.
	const known = new Map();
	// The full records saved on this phone, "catalog|card id".
	let saved = new Map();
	// A later Set finish supersedes an earlier one still reading.
	let run = 0;
	const viewing = viewingLanguage();
	const summary = h('p', {'aria-live': 'polite', class: 'muted', id: 'unset-summary'}, 'Reading your cards…');
	const list = h('div', {class: 'check-list unset-list', id: 'unset-list'});
	const count = h('p', {'aria-live': 'polite', class: 'bulk-count', id: 'unset-count'});
	const clear = h('button', {class: 'small', id: 'unset-clear', type: 'button'}, 'Clear');
	const finish = h('button', {class: 'small primary', id: 'unset-finish', type: 'button'}, 'Set finish');
	const bar = h('div', {class: 'bulk-bar unset-bar', hidden: true, id: 'unset-bar'}, h('div', {class: 'bulk-row'}, count, clear, finish));

	root.append(
		h('a', {class: 'back', 'data-link': 'trade/check', href: `${BASE}trade/check`, id: 'unset-back'}, backWords('Check spares')),
		h('div', {class: 'view-head'}, h('h2', {id: 'unset-title', tabindex: '-1'}, 'Copies with no finish')),
		h('p', {class: 'muted check-intro'}, 'A copy with no finish set never pairs with Normal, so two real copies stay home instead of counting as spares. Tick the cards, then Set finish. A card with one printing offers that printing first.'),
		summary,
		list,
		bar
	);

	const chosenTiles = () => tiles.filter((tile) => selected.has(tile.key));
	const infoOf = (tile) => entryInfo(tile.entries[0], index, viewing);

	function setOf(tile) {
		if (tile.catalog === 'custom') {
			return {id: 'custom', last: true, name: 'Hand-made cards'};
		}

		const record = index.get(indexKey(tile.catalog, tile.cardId));

		return {id: (record && record.set_id) || setIdOf(tile.cardId), name: infoOf(tile).setName || ''};
	}

	const sets = () => groupBySet(tiles, {nameOf: (tile) => infoOf(tile).name, setOf});

	// ----------------------------------------------------------- drawing

	function updateBar() {
		const chosen = chosenTiles();

		bar.hidden = !chosen.length;
		count.textContent = `${plural(chosen.length, 'card', 'cards')} selected, ${plural(copyCount(chosen), 'copy', 'copies')}`;
		finish.setAttribute('aria-label', `Set finish on ${plural(chosen.length, 'selected card', 'selected cards')}`);

		for (const section of list.querySelectorAll('.unset-set')) {
			const set = sets().find((one) => one.id === section.dataset.set);
			const button = section.querySelector('.unset-all');

			if (set && button) {
				const state = selectState(selected, set);
				const name = set.name || set.id || 'these cards';

				button.textContent = state === 'all' ? 'Clear' : 'Select all';
				button.setAttribute('aria-label', state === 'all' ? `Clear the selection in ${name}` : `Select all ${plural(set.tiles.length, 'card', 'cards')} in ${name}`);
				button.setAttribute('aria-pressed', String(state === 'all'));
			}
		}
	}

	function tileNode(tile) {
		const info = infoOf(tile);
		const words = `${info.name}, ${languageName(tile.language)}, ${plural(tile.entries.length, 'copy', 'copies')}`;
		const pick = h('input', {class: 'unset-pick', type: 'checkbox'});
		const choices = known.get(tile.key);
		const art = artOf({catalog: tile.catalog, card_id: tile.cardId, language: tile.language}, info, (src) => tileArt({
			count: tile.entries.length,
			decorative: true,
			info,
			languages: [tile.language],
			src,
			viewing: null,
		}));

		pick.checked = selected.has(tile.key);
		pick.setAttribute('aria-label', words);
		pick.addEventListener('change', () => {
			if (pick.checked) {
				selected.add(tile.key);
			}
			else {
				selected.delete(tile.key);
			}

			updateBar();
		});

		return h('li', {class: 'unset-card', 'data-key': tile.key},
			h('label', {class: 'unset-pick-wrap'}, pick),
			h('a', {'aria-hidden': 'true', class: 'unset-thumb', 'data-link': info.route, href: BASE + info.route, tabindex: '-1'}, art),
			h('div', {class: 'unset-text'},
				h('a', {class: 'unset-name', 'data-link': info.route, href: BASE + info.route}, info.name),
				h('span', {class: 'check-meta'}, [info.number ? `#${info.number}` : null, languageName(tile.language), plural(tile.entries.length, 'copy', 'copies')].filter(Boolean).join(' · ')),
				choices && choices.length === 1 ? h('span', {class: 'check-meta unset-only'}, `Only printing: ${choices[0].label}`) : null));
	}

	function setNode(set) {
		const headingId = `unset-set-${String(set.id).replace(/[^a-z0-9]+/gi, '-')}`;
		const button = h('button', {class: 'small unset-all', type: 'button'}, 'Select all');

		button.onclick = () => {
			selected = toggleSet(selected, set);

			for (const box of section.querySelectorAll('.unset-pick')) {
				box.checked = selected.has(box.closest('.unset-card').dataset.key);
			}

			updateBar();
		};

		const section = h('section', {'aria-labelledby': headingId, class: 'card unset-set', 'data-set': set.id},
			h('div', {class: 'unset-set-head'},
				h('div', {class: 'unset-set-title'},
					h('h3', {class: 'unset-set-name', id: headingId}, set.name || set.id || 'Other cards'),
					h('span', {class: 'check-meta'}, `${plural(set.tiles.length, 'card', 'cards')}, ${plural(set.copies, 'copy', 'copies')}`)),
				button),
			h('ul', {class: 'unset-cards'}, ...set.tiles.map(tileNode)));

		return section;
	}

	function redraw() {
		const copies = copyCount(tiles);
		const grouped = sets();

		if (!tiles.length) {
			summary.textContent = 'Every copy has a finish set.';
			list.replaceChildren();
			updateBar();

			return;
		}

		summary.textContent = `${plural(copies, 'copy', 'copies')} with no finish set, ${plural(tiles.length, 'card', 'cards')} in ${plural(grouped.length, 'set', 'sets')}.`;
		list.replaceChildren(...grouped.map(setNode));
		updateBar();
		fillMissing();
	}

	// The records the cards lack, once a visit each, for the names and sets
	// the list groups by.
	let filling = false;
	const asked = new Set();

	function fillMissing() {
		if (filling) {
			return;
		}

		const missing = tiles.map((tile) => ({cardId: tile.cardId, catalog: tile.catalog}))
			.filter(({cardId, catalog}) => !asked.has(`${catalog}|${cardId}`));

		if (!missing.length) {
			return;
		}

		filling = true;

		for (const {cardId, catalog} of missing) {
			asked.add(`${catalog}|${cardId}`);
		}

		fillRecords(missing, index, () => alive).then((next) => {
			if (next && alive) {
				index = next;
				redraw();
			}
		}).catch(() => {}).finally(() => {
			filling = false;
		});
	}

	// ------------------------------------------------------------ finish

	const sheet = () => sheetDialog(SHEET, 'Set finish');

	const close = () => {
		const element = document.getElementById(SHEET);

		if (element && element.open) {
			element.close();
		}
	};

	const head = (title) => h('div', {class: 'sheet-head'},
		h('h2', {id: `${SHEET}-title`}, title),
		h('button', {class: 'small', id: 'unset-sheet-close', onclick: close, type: 'button'}, 'Close')
	);

	function step(...children) {
		const element = sheet();

		element.replaceChildren(...children.filter(Boolean));
		showSheet(element);
		(element.querySelector('select') || element.querySelector('#unset-sheet-close')).focus();

		return element;
	}

	// A card's finishes with no request: a hand-made card takes monprice's
	// words, and a record saved on the phone lists its printings.
	function local(tile) {
		if (tile.catalog === 'custom') {
			return rawFinishes();
		}

		const record = saved.get(indexKey(tile.catalog, tile.cardId));
		const variants = record && record.variants_detailed;
		const choices = Array.isArray(variants) ? finishChoices(variants, tile.cardId) : [];

		return choices.length ? choices : null;
	}

	// TCGdex's record of the card, cache first, as My Cards' Finish reads it.
	async function read(tile) {
		const hit = await cardDetail(catalogLanguage(tile.catalog), tile.cardId);
		const variants = hit && hit.data && hit.data.variants_detailed;
		const choices = Array.isArray(variants) ? finishChoices(variants, tile.cardId) : [];

		return choices.length ? choices : null;
	}

	async function setFinish() {
		const chosen = chosenTiles();

		if (!chosen.length) {
			return;
		}

		const mine = ++run;
		const reading = h('p', {'aria-live': 'polite', class: 'muted copy-sub', id: 'unset-progress'}, 'Reading the cards\' finishes.');
		const meter = h('progress', {'aria-hidden': 'true', id: 'unset-meter', max: 1, value: 0});
		const element = step(head('Set finish'), reading, meter);
		const current = () => alive && mine === run && element.open;

		try {
			saved = new Map([...saved, ...await savedCardRecords(chosen.flatMap((tile) => tile.entries))]);
		}
		catch {
			// Read from TCGdex, then.
		}

		await readFinishes(chosen, {
			isAlive: current,
			known,
			local,
			onProgress: (report) => {
				reading.textContent = report.total ? progressText(report) : 'Reading the cards\' finishes.';
				meter.max = report.total || 1;
				meter.value = report.done;
			},
			read,
		});

		if (!current()) {
			return;
		}

		const choicesOf = (tile) => known.get(tile.key) || null;
		const options = finishOptions(chosen, choicesOf);
		const unknown = chosen.filter((tile) => !choicesOf(tile)).length;

		if (!options.length) {
			step(head('Set finish'), h('p', {id: 'unset-none'}, 'The finishes of these cards could not be read. Go online and try again.'));

			return;
		}

		const n = chosen.length;
		const label = (option) => [
			option.label,
			option.only ? `only printing of ${plural(option.only, 'card', 'cards')}` : null,
			option.fits < n ? `${option.fits} of ${n}` : null,
		].filter(Boolean).join(' · ');
		const control = sheetSelect('unset-finish-select', options.map((option) => ({label: label(option), value: option.label})), options[0].label);
		const submit = h('button', {class: 'primary', id: 'unset-save', type: 'submit'}, 'Save');
		const form = h('form', {class: 'copy-form', id: 'unset-form'},
			sheetField('Finish', 'unset-finish-select', control),
			h('p', {class: 'muted bulk-note', id: 'unset-note'}, [
				'Only the cards that come in the finish you pick change.',
				options.some((option) => option.fits < n) ? ' A finish with a count fits only some of them.' : '',
				options[0].only ? ' A card with one printing has it offered first.' : '',
				unknown ? ` ${plural(unknown, 'card', 'cards')} could not be read and stay as they are.` : '',
			].join('')),
			submit
		);

		form.addEventListener('submit', (event) => {
			event.preventDefault();
			submit.disabled = true;
			close();
			apply(control.value).catch((err) => toast(`Not saved. ${errorText(err)}`));
		});

		step(head('Set finish'), form);
	}

	// Sets the finish named `label` on the ticked cards in one write, with
	// Undo, which puts every copy back as it was and the ticks with it.
	async function apply(label) {
		const chosen = chosenTiles();
		const plan = finishPlan(chosen, label, (tile) => known.get(tile.key) || null);

		if (!plan.patches.length) {
			toast(savedText(label, plan, 0));

			return;
		}

		const before = new Set(selected);
		const back = undoPatches(chosen.flatMap((tile) => tile.entries), plan.patches);

		await updateCards(plan.patches);
		selected = pruneSelection(selected, tiles);
		redraw();

		toast(savedText(label, plan, plan.patches.length), {
			action: () => updateCards(back)
				.then(() => {
					if (alive) {
						selected = before;
						redraw();
					}
				})
				.catch((err) => toast(`Could not undo. ${errorText(err)}`)),
			actionLabel: 'Undo',
			timeout: UNDO_MS,
		});
	}

	clear.onclick = () => {
		selected = new Set();

		for (const box of list.querySelectorAll('.unset-pick')) {
			box.checked = false;
		}

		updateBar();
	};
	finish.onclick = () => {
		setFinish().catch((err) => toast(`Could not read the finishes. ${errorText(err)}`));
	};

	(async () => {
		const [doc, found] = await Promise.all([loadDocument(), cardIndex().catch(() => new Map())]);

		if (!alive) {
			return;
		}

		index = found;
		tiles = unsetTiles(doc.cards);
		redraw();
	})().catch((err) => {
		if (alive) {
			summary.textContent = '';
			list.replaceChildren(h('div', {class: 'notice', role: 'alert'}, h('p', null, `Your cards could not be read. ${errorText(err)}`)));
		}
	});

	const stop = onChange((doc) => {
		if (alive && doc && Array.isArray(doc.cards)) {
			tiles = unsetTiles(doc.cards);
			redraw();
		}
	});

	return () => {
		alive = false;
		run++;
		stop();
		close();
	};
}

export const unsetFinishRoutes = [
	{pattern: /^trade\/check\/finish$/, render: unsetFinishView, tab: 'cards', title: 'Copies with no finish | Card Tracker'},
];

export const unsetFinishAccountViews = [unsetFinishView];
