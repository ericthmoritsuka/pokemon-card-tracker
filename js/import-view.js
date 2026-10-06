// Import from monprice: pick an export, match it against TCGdex, review the
// match report, then save (DESIGN.md section 7, plans/ux-plan.md section 6).
// The app's own CSV export comes back through the same screen: its rows
// already name their cards, so its report says what is new, what changes,
// and what was deleted here, before anything is saved (DESIGN.md section 9).
// An unmatched monprice row can be added by hand from its line.

import {languageChip} from './cards-view.js';
import {applyImport, applyOwnImport, importKeys, previewOwnImport} from './collection.js';
import {importApi, languageLabel, saveToCardIndex} from './catalog.js';
import {openCustomCardSheet} from './custom-card-view.js';
import {BASE, errorText, h, namedError} from './dom.js';
import {formatCount, plural} from './format.js';
import {LARGE_COUNT, finishLabel, importEntries, localPart, matchRows, parseExport} from './monprice.js';

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

function holdPage(event) {
	event.preventDefault();
	event.returnValue = '';
}

export function importView(root) {
	let alive = true;

	const input = h('input', {accept: '.csv,.json,text/csv,application/json', class: 'offscreen', id: 'monprice-file', type: 'file'});
	const picker = h('label', {class: 'button primary', for: 'monprice-file'}, 'Pick a file');
	const status = h('div', {'aria-live': 'polite'});
	const report = h('div');

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

		const fallbackLines = [...groupBy(fallback, (result) => (result.catalog === 'ja' ? 'ja' : 'en')).entries()].map(([lang, list]) =>
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
		}

		save.disabled = !entries.length;

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
		].filter(Boolean));

		async function doSave() {
			const saving = entries;

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
		input,
		picker,
		status,
		report
	);

	return () => {
		alive = false;
	};
}
