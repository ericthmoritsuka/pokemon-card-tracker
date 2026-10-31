// Import from monprice: pick an export, match it against TCGdex, review the
// match report, then save (DESIGN.md section 7, plans/ux-plan.md section 6).
// The app's own CSV export comes back through the same screen: its rows
// already name their cards, so its report says what is new, what changes,
// and what was deleted here, before anything is saved (DESIGN.md section 9).
// An unmatched monprice row can be added by hand from its line.

import {applyImport, applyOwnImport, importKeys, previewOwnImport} from './collection.js';
import {cardIndex, importApi, indexKey, saveToCardIndex} from './catalog.js';
import {openCustomCardSheet} from './custom-card-view.js';
import {BASE, errorText, h, namedError} from './dom.js';
import {formatCount, plural} from './format.js';
import {catalogLanguage, languageChip, languageLabel} from './languages.js';
import {LARGE_COUNT, finishLabel, importEntries, isImportableFile, localPart, matchRows, newFromRepeats, parseExport} from './monprice.js';
import {UNDO_DAYS, UPLOAD_KEEP_DAYS, applyStartOver, previewStartOver, savedUndo, undoStartOver} from './start-over.js';

const STAGES = {
	finishes: 'Reading each card\'s finishes',
	lists: 'Reading set lists',
	sets: 'Finding sets',
};

function rowText(result) {
	const {row} = result;

	return [`Line ${row.line}`, row.name, row.number, row.setName, row.language ? languageChip(row.language) : row.languageRaw, finishLabel(row.finish)]
		.filter(Boolean)
		.join(' · ');
}

// One expandable line of the report. Rows are drawn when it is opened, so
// a 1,400-row report does not build every list up front. action(result)
// returns a control for the row, or null.
function reportLine(label, results, explain, {action = null, open = false} = {}) {
	const list = h('ol', {class: 'report-rows'});
	const details = h('details', {class: 'report-line', open},
		h('summary', null, h('span', null, label)),
		list
	);

	const fill = () => {
		if (list.childElementCount || !details.open) {
			return;
		}

		list.append(...results.map((result) => h('li', null,
			h('span', null, rowText(result)),
			explain ? h('span', {class: 'muted'}, explain(result)) : null,
			action ? action(result) : null
		)));
	};

	details.addEventListener('toggle', fill);
	fill();

	if (!results.length) {
		details.classList.add('empty');
	}

	return details;
}

// An own-CSV row in the report's words (rowText).
const ownRow = (row) => ({
	finish: row.finish_raw || null,
	language: row.language,
	line: row.line,
	name: row.name_local || row.card_id,
	number: row.number_local || null,
	setName: row.set_name_local || null,
});

function copiesOf(results) {
	return results.reduce((sum, result) => sum + result.row.count, 0);
}

function groupBy(results, key) {
	const groups = new Map();

	for (const result of results) {
		const value = key(result);

		if (!groups.has(value)) {
			groups.set(value, []);
		}

		groups.get(value).push(result);
	}

	return groups;
}

// A file shared from another app (sw.js shareResponse) waits in this cache
// under the share action's URL. It is read once and deleted.
const SHARE_CACHE = 'card-tracker-share';
const SHARE_KEY = `${BASE}share-import`;

async function takeSharedFile() {
	if (!('caches' in window)) {
		return null;
	}

	const cache = await caches.open(SHARE_CACHE);
	const response = await cache.match(SHARE_KEY);

	if (!response) {
		return null;
	}

	await cache.delete(SHARE_KEY);

	const name = decodeURIComponent(response.headers.get('X-File-Name') || '') || 'Shared file';
	const type = response.headers.get('Content-Type') || '';

	return new File([await response.blob()], name, {type: type === 'application/octet-stream' ? '' : type});
}

function holdPage(event) {
	event.preventDefault();
	event.returnValue = '';
}

// Undo for Start over (js/start-over.js) into `box`: a button that undoes
// it and then says what came back.
function undoStartOverButton(box, undo, label, id) {
	const button = h('button', {id, type: 'button'}, label);

	button.addEventListener('click', async () => {
		button.disabled = true;

		try {
			const back = await undoStartOver(undo);

			box.replaceChildren(...[
				h('p', {class: 'big', id: 'start-over-undone'}, `Undone. ${plural(back.restored, 'copy is', 'copies are')} back, and ${plural(back.added, 'added copy was', 'added copies were')} removed.`),
				back.kept
					? h('p', {id: 'start-over-undo-kept'}, `${plural(back.kept, 'added copy was', 'added copies were')} kept because you changed ${back.kept === 1 ? 'it' : 'them'} since.`)
					: null,
			].filter(Boolean));
		}
		catch (err) {
			if (err && err.stale) {
				box.replaceChildren(h('p', {id: 'start-over-undo-stale', role: 'alert'}, err.message));

				return;
			}

			button.disabled = false;
			box.append(h('p', {role: 'alert'}, `Could not undo. Nothing was changed. ${errorText(err)}`));
		}
	});

	return button;
}

// A card with no copy after Start over, in the preview's words.
function goneText(card, index) {
	const record = index.get(indexKey(card.catalog, card.card_id));
	const name = card.name || (record && record.name) || card.card_id;

	return [name, name === card.card_id ? null : card.card_id, card.language ? languageChip(card.language) : null, plural(card.copies, 'copy', 'copies')].filter(Boolean).join(' · ');
}

export function importView(root) {
	let alive = true;

	const input = h('input', {accept: '.csv,.json,text/csv,application/json', class: 'offscreen', id: 'monprice-file', type: 'file'});
	const picker = h('label', {class: 'button primary', for: 'monprice-file'}, 'Pick a file');
	const status = h('div', {'aria-live': 'polite'});
	const report = h('div');
	const keptUndo = h('div', {id: 'start-over-kept'});

	input.addEventListener('change', () => {
		const file = input.files && input.files[0];

		if (file) {
			run(file);
		}

		// Picking the same file again still fires change.
		input.value = '';
	});

	// Stops a match in flight when the view closes; the rest of its requests
	// fail at once instead of reaching TCGdex.
	const guarded = {};

	for (const [name, call] of Object.entries(importApi)) {
		guarded[name] = (...args) => {
			if (!alive) {
				return Promise.reject(namedError('AbortError', 'The import screen was closed.'));
			}

			return call(...args);
		};
	}

	function progress(stage, done, total) {
		const bar = h('progress', {max: total || 1, value: done});

		status.replaceChildren(
			h('div', {class: 'card'},
				h('p', {class: 'big'}, STAGES[stage]),
				bar,
				h('p', {class: 'muted'}, `${formatCount(done)} of ${formatCount(total)}. Everything read is kept on this phone, so running the import again is quick.`)
			)
		);
	}

	async function run(file) {
		report.replaceChildren();
		picker.classList.remove('primary');
		status.replaceChildren(h('p', {class: 'muted'}, `Reading ${file.name}...`));

		let parsed;

		try {
			parsed = parseExport(await file.text(), file.name);
		}
		catch (err) {
			status.replaceChildren(h('div', {class: 'notice', role: 'alert'},
				h('p', null, `${file.name} could not be read, so nothing was imported.`),
				h('p', {class: 'muted'}, errorText(err))
			));

			return;
		}

		if (!parsed.rows.length) {
			status.replaceChildren(h('div', {class: 'notice', role: 'alert'},
				h('p', null, `${file.name} has no rows that can be imported.`)
			));
			report.append(parseErrors(parsed.errors));

			return;
		}

		if (parsed.format === 'own') {
			showOwnReport(file, parsed, await previewOwnImport(parsed.rows));

			return;
		}

		let outcome;

		try {
			outcome = await matchRows(parsed.rows, guarded, ({done, stage, total}) => alive && progress(stage, done, total));
		}
		catch (err) {
			if (alive) {
				status.replaceChildren(h('div', {class: 'notice', role: 'alert'},
					h('p', null, 'Matching stopped before the end. Nothing was saved. Try again in a minute: what was already read is kept.'),
					h('p', {class: 'muted'}, errorText(err)),
					h('button', {onclick: () => run(file), type: 'button'}, 'Try again')
				));
			}

			return;
		}

		if (alive) {
			showReport(file, parsed, outcome, await importKeys());
		}
	}

	// Add by hand on an unmatched row: the hand-made card sheet, prefilled
	// from the row, its count included. A row added this way says so.
	function handButton(result) {
		const {row} = result;
		const button = h('button', {class: 'small report-hand', type: 'button'}, 'Add by hand');

		button.addEventListener('click', () => openCustomCardSheet({
			onSaved: () => {
				button.replaceWith(h('span', {class: 'report-hand-done'}, 'Added by hand'));
			},
			openPage: false,
			prefill: {
				count: row.count,
				finish: row.finish,
				language: row.language,
				name: row.name,
				number: localPart(row.number),
				setCode: row.setCode,
				setName: row.setName,
			},
		}));

		return button;
	}

	function parseErrors(errors) {
		return reportLine(`Rows the file could not describe: ${formatCount(errors.length)}`, errors.map((row) => ({row})), (result) => result.row.reason);
	}

	function showReport(file, parsed, {cards, results}, existing) {
		const matched = results.filter((result) => result.status === 'matched');
		const fallback = results.filter((result) => result.status === 'fallback');
		const unmatched = results.filter((result) => result.status === 'unmatched');
		const saved = [...matched, ...fallback];
		const unresolved = saved.filter((result) => !result.variantId);
		const only = saved.filter((result) => result.finishHow === 'only printing');
		const reverse = saved.filter((result) => result.variantId && result.row.finish === 'REVERSE_HOLOFOIL');

		// Rows asking for more than LARGE_COUNT copies are saved only when
		// ticked below (plans/audit-qa.md Q-08).
		const large = saved.filter((result) => result.row.large);
		const confirmed = new Set();
		const chosen = () => saved.filter((result) => !result.row.large || confirmed.has(result));
		let entries = importEntries(chosen());

		const already = entries.filter((entry) => existing.has(entry.import_key)).length;
		const languages = groupBy(parsed.rows.map((row) => ({row})), (result) => result.row.language);
		const languageText = [...languages.entries()]
			.sort((a, b) => b[1].length - a[1].length)
			.map(([code, rows]) => `${languageChip(code)} ${formatCount(rows.length)}`)
			.join(', ');

		const fallbackLines = [...groupBy(fallback, (result) => catalogLanguage(result.catalog || 'international')).entries()].map(([lang, list]) =>
			reportLine(
				`${plural(list.length, 'row uses', 'rows use')} the ${languageLabel(lang)} card record`,
				list,
				(result) => result.reason
			)
		);

		const save = h('button', {class: 'primary wide', onclick: doSave, type: 'button'}, `Save ${plural(entries.length, 'copy', 'copies')}`);
		const saveStatus = h('p', {'aria-live': 'polite', class: 'status muted'});

		function chooseAgain() {
			entries = importEntries(chosen());
			save.textContent = `Save ${plural(entries.length, 'copy', 'copies')}`;
			save.disabled = !entries.length;
			startEmpty();
		}

		save.disabled = !entries.length;

		// Start over with this file (DESIGN.md section 7): a preview first,
		// then a confirmation, then one save, with Undo after it.
		const startButton = h('button', {id: 'start-over', type: 'button'}, 'Start over with this file');
		const startBox = h('div', {'aria-live': 'polite', id: 'start-over-box'});
		const startOver = h('div', {class: 'card', id: 'start-over-card'},
			h('h3', null, 'Start over with this file'),
			h('p', {class: 'muted'}, 'Removes every copy on this phone except hand-made cards, then adds every matched row of this file as a new copy. Photos and notes stay with their cards and show again on the cards that get a copy. Each copy\'s own details (grade, price, favorite, condition, Stored in, pack opening) are not copied to the new copies. Rows not matched are not added; add them by hand from the report.'),
			startButton,
			startBox
		);
		const noRows = h('p', {class: 'muted', id: 'start-over-empty'}, 'No row of this file matched a card, so Start over has nothing to add.');

		// Start over needs at least one matched row to add.
		function startEmpty() {
			startButton.disabled = !entries.length;
			noRows.hidden = Boolean(entries.length);
		}

		startButton.after(noRows);
		startEmpty();

		startButton.addEventListener('click', async () => {
			const planned = entries;
			const leftOut = large.filter((result) => !confirmed.has(result));

			startButton.disabled = true;
			startBox.replaceChildren(h('p', {class: 'muted'}, 'Working out what changes...'));

			let counts;
			let index;

			try {
				[counts, index] = await Promise.all([previewStartOver(planned), cardIndex().catch(() => new Map())]);
			}
			catch (err) {
				startButton.disabled = false;
				startBox.replaceChildren(h('p', {role: 'alert'}, `Could not work it out. Nothing was changed. ${errorText(err)}`));

				return;
			}

			const go = h('button', {class: 'danger', id: 'start-over-go', type: 'button'}, 'Start over');
			const cancel = h('button', {id: 'start-over-cancel', type: 'button'}, 'Cancel');
			const exportButton = h('button', {id: 'start-over-export', type: 'button'}, 'Export CSV first');
			const exportStatus = h('span', {'aria-live': 'polite', class: 'muted'});

			// The app's own CSV keeps every copy's details, and the same screen
			// imports it back (DESIGN.md section 9).
			exportButton.addEventListener('click', async () => {
				exportButton.disabled = true;
				exportStatus.textContent = 'Preparing the export...';

				try {
					const {exportCollection} = await import('./cards-view.js');
					const count = await exportCollection();

					exportStatus.textContent = `Exported ${plural(count, 'copy', 'copies')}.`;
				}
				catch (err) {
					exportStatus.textContent = `The export did not work. ${errorText(err)}`;
				}
				finally {
					exportButton.disabled = false;
				}
			});

			const leftOutLine = leftOut.length ? reportLine(`${plural(leftOut.length, 'row is', 'rows are')} left out: more than ${LARGE_COUNT} copies and not ticked above`, leftOut, null) : null;

			if (leftOutLine) {
				leftOutLine.id = 'start-over-left-out';
			}

			startBox.replaceChildren(...[
				h('p', {class: 'big', id: 'start-over-preview'}, `Remove ${plural(counts.removed, 'copy', 'copies')}, add ${plural(counts.added, 'copy', 'copies')}, ${plural(counts.photos, 'photo', 'photos')} kept, ${plural(counts.pockets, 'pocket becomes a placeholder', 'pockets become placeholders')}.`),
				h('p', null, 'Photos and notes stay with their cards.'),
				counts.unsynced
					? h('p', {id: 'start-over-unsynced', role: 'alert'}, 'Open the app on your other phones and let them sync first, or their newest changes will stay.')
					: null,
				counts.uploading
					? h('p', {id: 'start-over-uploading'}, `${plural(counts.uploading, 'copy is', 'copies are')} kept because a photo is still uploading on another phone. A photo still not uploaded after ${UPLOAD_KEEP_DAYS} days no longer keeps its copy.`)
					: null,
				counts.details
					? h('p', {id: 'start-over-details'}, `${plural(counts.details, 'copy has', 'copies have')} a grade, price, favorite, condition, Stored in, or pack opening; these stay with the old copies and are not copied over.`)
					: null,
				counts.gone.length
					? h('details', {class: 'report-line', id: 'start-over-gone', open: counts.gone.length <= 30},
						h('summary', null, h('span', null, `${plural(counts.gone.length, 'card has', 'cards have')} no copy after Start over`)),
						h('ol', {class: 'report-rows'}, ...counts.gone.map((card) => h('li', null, h('span', null, goneText(card, index)))))
					)
					: null,
				counts.gone.length
					? h('p', {id: 'start-over-hidden'}, `Their card records keep ${plural(counts.hiddenPhotos, 'photo', 'photos')} and ${plural(counts.hiddenNotes, 'note', 'notes')}, which show again only when the card is added again.`)
					: null,
				leftOut.length
					? leftOutLine
					: null,
				h('p', {class: 'muted'}, 'Export CSV first to keep a file of every copy as it is now.'),
				h('div', {class: 'actions'}, exportButton, exportStatus),
				h('div', {class: 'actions'}, go, cancel),
			].filter(Boolean));

			cancel.addEventListener('click', () => {
				startBox.replaceChildren();
				startButton.disabled = false;
			});

			go.addEventListener('click', async () => {
				if (!window.confirm(`Remove ${plural(counts.removed, 'copy', 'copies')} and add ${plural(counts.added, 'copy', 'copies')} from this file? You can undo it right after.`)) {
					return;
				}

				go.disabled = true;
				cancel.disabled = true;
				save.disabled = true;
				window.addEventListener('beforeunload', holdPage);

				try {
					await saveToCardIndex(cards);

					const {counts: done, undo} = await applyStartOver(planned);

					startBox.replaceChildren(
						h('p', {class: 'big', id: 'start-over-done'}, `Started over. ${formatCount(done.removed)} removed, ${formatCount(done.added)} added.`),
						h('p', {class: 'muted'}, `Undo stays on this screen for ${UNDO_DAYS} days, until you start over again.`),
						h('div', {class: 'actions'}, undoStartOverButton(startBox, undo, 'Undo', 'start-over-undo'), h('a', {class: 'button primary', 'data-link': 'cards', href: `${BASE}cards`}, 'Open My Cards'))
					);
					save.remove();
					keptUndo.replaceChildren();
				}
				catch (err) {
					go.disabled = false;
					cancel.disabled = false;
					save.disabled = !entries.length;
					startBox.append(h('p', {role: 'alert'}, `Could not start over. Nothing was changed. ${errorText(err)}`));
				}
				finally {
					window.removeEventListener('beforeunload', holdPage);
				}
			});
		});

		const largeCheck = large.length ? h('div', {class: 'notice', id: 'import-large', role: 'group', 'aria-labelledby': 'import-large-title'},
			h('h3', {id: 'import-large-title'}, 'Check these counts'),
			h('p', null, large.length === 1
				? `One row asks for more than ${LARGE_COUNT} copies of one card. That is usually a typo in the Count column, so it is left out unless you tick it.`
				: `${formatCount(large.length)} rows ask for more than ${LARGE_COUNT} copies of one card. That is usually a typo in the Count column, so they are left out unless you tick them.`),
			h('ul', {class: 'report-rows'}, ...large.map((result) => {
				const box = h('input', {type: 'checkbox'});

				box.addEventListener('change', () => {
					if (box.checked) {
						confirmed.add(result);
					}
					else {
						confirmed.delete(result);
					}

					chooseAgain();
				});

				return h('li', null, h('label', null, box, ` Save all ${formatCount(result.row.count)} copies: ${rowText(result)}`));
			}))
		) : null;

		status.replaceChildren(
			h('div', {class: 'card'},
				h('h3', null, 'Match report'),
				h('p', null, `${file.name}: ${plural(parsed.rows.length + parsed.errors.length, 'row', 'rows')}, ${plural(copiesOf(saved) + copiesOf(unmatched), 'copy', 'copies')}. ${languageText}.`),
				h('p', {class: 'muted'}, 'Nothing is saved until you tap Save. Prices and rarity are not imported: prices come fresh from TCGdex, and rarity from the catalog.'),
				already
					? h('p', null, `${plural(already, 'copy is', 'copies are')} already on this phone from an earlier import. Saving updates them instead of adding them again.`)
					: null
			)
		);

		// replaceChildren prints a null argument as the text "null", so the
		// optional lines are filtered out first.
		report.replaceChildren(...[
			reportLine(`Matched: ${plural(matched.length, 'row', 'rows')} (${plural(copiesOf(matched), 'copy', 'copies')})`, matched, (result) => `${result.cardId} · set found by ${result.setMethod}`),
			reportLine(`Matched through a fallback record: ${plural(fallback.length, 'row', 'rows')} (${plural(copiesOf(fallback), 'copy', 'copies')})`, fallback, (result) => result.reason),
			...fallbackLines.map((line) => {
				line.classList.add('sub');

				return line;
			}),
			reportLine(`Finish not resolved: ${plural(unresolved.length, 'row', 'rows')}. Saved with no finish; pick it by hand later.`, unresolved, (result) => result.finishReason),
			reportLine(`Finish taken from the card's only printing: ${plural(only.length, 'row', 'rows')}`, only, (result) => `monprice says ${finishLabel(result.row.finish).toLowerCase()}; TCGdex lists one printing`),
			reportLine(`Reverse holos set to the plain reverse: ${plural(reverse.length, 'row', 'rows')}. Check for Poké Ball and Master Ball patterns.`, reverse, null),
			reportLine(`Not matched: ${plural(unmatched.length, 'row', 'rows')} (${plural(copiesOf(unmatched), 'copy', 'copies')}). Not saved with the others; add each by hand.`, unmatched, (result) => result.reason, {action: handButton, open: unmatched.length > 0 && unmatched.length <= 30}),
			parsed.errors.length ? parseErrors(parsed.errors) : null,
			largeCheck,
			h('div', {class: 'actions'}, save, saveStatus),
			startOver,
		].filter(Boolean));

		async function doSave() {
			const saving = entries;
			const results = chosen();

			save.disabled = true;
			saveStatus.textContent = 'Saving...';

			if (largeCheck) {
				largeCheck.querySelectorAll('input').forEach((box) => {
					box.disabled = true;
				});
			}

			// Closing or reloading the page mid-save would lose the import, so
			// the browser asks first. Moving to another screen is safe: the
			// save goes on.
			window.addEventListener('beforeunload', holdPage);

			try {
				await saveToCardIndex(cards);

				// From v51 a repeated row's copies get keys of their own, so the
				// first import after an older app's adds the copies it collapsed.
				const repeats = newFromRepeats(results, await importKeys().catch(() => new Map()));
				const counts = await applyImport(saving);

				if (!alive) {
					return;
				}

				save.remove();
				// replaceChildren prints a null argument as "null", so the
				// optional sentence is added only when there is one.
				saveStatus.replaceChildren(h('span', {class: 'big'}, `Saved. ${formatCount(counts.added)} added, ${formatCount(counts.updated)} updated, ${formatCount(counts.unchanged)} already up to date.`));

				if (counts.skippedDeleted) {
					saveStatus.append(` ${plural(counts.skippedDeleted, 'copy was', 'copies were')} deleted earlier and stayed deleted.`);
				}

				if (repeats) {
					saveStatus.append(` ${plural(repeats, 'copy', 'copies')} from repeated rows ${repeats === 1 ? 'is' : 'are'} new.`);
				}
				saveStatus.after(h('a', {class: 'button primary wide', 'data-link': 'cards', href: `${BASE}cards`}, 'Open My Cards'));
			}
			catch (err) {
				save.disabled = false;

				if (largeCheck) {
					largeCheck.querySelectorAll('input').forEach((box) => {
						box.disabled = false;
					});
				}

				saveStatus.textContent = `Could not save. Nothing was changed. ${errorText(err)}`;
			}
			finally {
				window.removeEventListener('beforeunload', holdPage);
			}
		}
	}

	// The app's own export: each row is a copy with its entry id. Ids already
	// here update only when a field differs; ids deleted here stay deleted
	// unless ticked; hand-made cards come back as they were.
	function showOwnReport(file, parsed, {statuses}) {
		const by = (kind) => parsed.rows.filter((row, i) => statuses[i] === kind).map((row) => ({row: ownRow(row)}));
		const added = by('added');
		const updated = by('updated');
		const unchanged = by('unchanged');
		const deleted = by('deleted');
		const hand = parsed.rows.filter((row) => row.catalog === 'custom');
		let revive = false;

		const reviveBox = h('input', {id: 'import-revive', type: 'checkbox'});
		const save = h('button', {class: 'primary wide', id: 'import-save', type: 'button'});
		const saveStatus = h('p', {'aria-live': 'polite', class: 'status muted'});
		const willChange = () => added.length + updated.length + (revive ? deleted.length : 0);

		function label() {
			const n = willChange();

			save.textContent = n ? `Save ${plural(n, 'copy', 'copies')}` : 'Nothing to save';
			save.disabled = !n;
		}

		reviveBox.addEventListener('change', () => {
			revive = reviveBox.checked;
			label();
		});
		label();

		status.replaceChildren(
			h('div', {class: 'card'},
				h('h3', null, 'Match report'),
				h('p', null, `${file.name}: a Card Tracker export, ${plural(parsed.rows.length + parsed.errors.length, 'row', 'rows')}, one per copy.`),
				h('p', {class: 'muted'}, 'Each row is matched to the copy with the same entry id, so importing the same file twice adds nothing. Nothing is saved until you tap Save.'),
				hand.length ? h('p', null, hand.length === 1 ? 'One copy is a hand-made card, kept as it is.' : `${formatCount(hand.length)} copies are hand-made cards, kept as they are.`) : null
			)
		);

		report.replaceChildren(...[
			reportLine(`New on this phone: ${plural(added.length, 'copy', 'copies')}`, added, null),
			reportLine(`Already here, with changes: ${plural(updated.length, 'copy', 'copies')}. Saving updates only what differs.`, updated, null),
			reportLine(`Already here, the same: ${plural(unchanged.length, 'copy', 'copies')}. Left as they are.`, unchanged, null),
			deleted.length ? h('div', {class: 'notice', id: 'import-deleted'},
				h('p', null, `${plural(deleted.length, 'copy was', 'copies were')} deleted on this phone and ${deleted.length === 1 ? 'stays' : 'stay'} deleted.`),
				h('label', null, reviveBox, deleted.length === 1 ? ' Bring it back' : ` Bring all ${formatCount(deleted.length)} back`)
			) : null,
			parsed.errors.length ? parseErrors(parsed.errors) : null,
			h('div', {class: 'actions'}, save, saveStatus),
		].filter(Boolean));

		save.addEventListener('click', async () => {
			save.disabled = true;
			reviveBox.disabled = true;
			saveStatus.textContent = 'Saving...';
			window.addEventListener('beforeunload', holdPage);

			try {
				const counts = await applyOwnImport(parsed.rows, {revive});

				if (!alive) {
					return;
				}

				save.remove();
				saveStatus.replaceChildren(h('span', {class: 'big'}, `Saved. ${formatCount(counts.added)} added, ${formatCount(counts.updated)} updated, ${formatCount(counts.unchanged)} already up to date${counts.revived ? `, ${formatCount(counts.revived)} brought back` : ''}.`));

				if (counts.skippedDeleted) {
					saveStatus.append(` ${plural(counts.skippedDeleted, 'copy was', 'copies were')} deleted earlier and stayed deleted.`);
				}

				saveStatus.after(h('a', {class: 'button primary wide', 'data-link': 'cards', href: `${BASE}cards`}, 'Open My Cards'));
			}
			catch (err) {
				label();
				reviveBox.disabled = false;
				saveStatus.textContent = `Could not save. Nothing was changed. ${errorText(err)}`;
			}
			finally {
				window.removeEventListener('beforeunload', holdPage);
			}
		});
	}

	root.append(
		h('h2', null, 'Import a collection'),
		h('p', null, 'Pick a monprice export (CSV or JSON), or a CSV this app exported. A monprice file is matched to the catalog; every file is listed in a report before anything is saved.'),
		h('p', {class: 'muted'}, 'Importing the same file again does not add the cards twice.'),
		keptUndo,
		input,
		picker,
		status,
		report
	);

	// The last Start over's Undo, kept beside the document (js/start-over.js
	// savedUndo), so leaving this screen or reloading does not lose it.
	async function offerKeptUndo() {
		const kept = await savedUndo().catch(() => null);

		if (!alive || !kept) {
			return;
		}

		const box = h('div', {'aria-live': 'polite'});
		const day = new Date(kept.at).toLocaleDateString('en-US', {day: 'numeric', month: 'long'});

		box.append(
			h('p', null, `You started over on ${day}: ${formatCount(kept.counts.removed)} removed, ${formatCount(kept.counts.added)} added. Undo brings the removed copies back and removes the added ones, except where they changed since.`),
			h('div', {class: 'actions'}, undoStartOverButton(box, kept.undo, 'Undo Start over', 'start-over-kept-undo'))
		);
		keptUndo.replaceChildren(h('div', {class: 'card'}, h('h3', null, 'Undo Start over'), box));
	}

	offerKeptUndo();

	// Opened from Android's share sheet: sw.js put the file aside and sent
	// ?shared=1 (or ?shared=none when the share had no file). The flag is
	// taken off the address, so a reload does not look for the file again.
	async function pickUpShared() {
		const params = new URLSearchParams(window.location.search);
		const flag = params.get('shared');

		if (flag === null) {
			return;
		}

		params.delete('shared');
		history.replaceState(history.state, '', window.location.pathname + (params.toString() ? `?${params}` : ''));

		const shareProblem = (text) => status.replaceChildren(h('div', {class: 'notice', id: 'import-share-problem', role: 'alert'},
			h('p', null, text),
			h('p', {class: 'muted'}, 'Share the CSV or JSON export from monprice, or a CSV this app exported, or pick the file below.')
		));

		let file = null;

		try {
			file = flag === 'none' ? null : await takeSharedFile();
		}
		catch {
			file = null;
		}

		if (!alive) {
			return;
		}

		if (!file) {
			shareProblem('No file came with the share, so nothing was read.');

			return;
		}

		if (!isImportableFile(file.name, file.type)) {
			shareProblem(`${file.name} is not a CSV or JSON file, so it was not read.`);

			return;
		}

		run(file);
	}

	pickUpShared();

	return () => {
		alive = false;
	};
}
