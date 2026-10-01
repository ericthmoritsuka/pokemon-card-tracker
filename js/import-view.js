// Import from monprice: pick an export, match it against TCGdex, review the
// match report, then save (DESIGN.md section 7, plans/ux-plan.md section 6).

import {languageChip} from './cards-view.js';
import {applyImport, importKeys} from './collection.js';
import {importApi, languageLabel, saveToCardIndex} from './catalog.js';
import {BASE, errorText, h, namedError} from './dom.js';
import {finishLabel, importEntries, matchRows, parseExport} from './monprice.js';

const formatCount = (n) => Number(n).toLocaleString('en-US');

const plural = (n, one, many) => `${formatCount(n)} ${n === 1 ? one : many}`;

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
// a 1,400-row report does not build every list up front.
function reportLine(label, results, explain, {open = false} = {}) {
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
			explain ? h('span', {class: 'muted'}, explain(result)) : null
		)));
	};

	details.addEventListener('toggle', fill);
	fill();

	if (!results.length) {
		details.classList.add('empty');
	}

	return details;
}

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

export function importView(root) {
	let alive = true;

	const input = h('input', {accept: '.csv,.json,text/csv,application/json', class: 'offscreen', id: 'monprice-file', type: 'file'});
	const picker = h('label', {class: 'button primary', for: 'monprice-file'}, 'Pick a monprice file');
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

		const entries = importEntries(saved);

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

		report.replaceChildren(
			reportLine(`Matched: ${plural(matched.length, 'row', 'rows')} (${plural(copiesOf(matched), 'copy', 'copies')})`, matched, (result) => `${result.cardId} · set found by ${result.setMethod}`),
			reportLine(`Matched through a fallback record: ${plural(fallback.length, 'row', 'rows')} (${plural(copiesOf(fallback), 'copy', 'copies')})`, fallback, (result) => result.reason),
			...fallbackLines.map((line) => {
				line.classList.add('sub');

				return line;
			}),
			reportLine(`Finish not resolved: ${plural(unresolved.length, 'row', 'rows')}. Saved with no finish; pick it by hand later.`, unresolved, (result) => result.finishReason),
			reportLine(`Finish taken from the card's only printing: ${plural(only.length, 'row', 'rows')}`, only, (result) => `monprice says ${finishLabel(result.row.finish).toLowerCase()}; TCGdex lists one printing`),
			reportLine(`Reverse holos set to the plain reverse: ${plural(reverse.length, 'row', 'rows')}. Check for Poké Ball and Master Ball patterns.`, reverse, null),
			reportLine(`Not matched: ${plural(unmatched.length, 'row', 'rows')} (${plural(copiesOf(unmatched), 'copy', 'copies')}). Not saved; add these by hand later.`, unmatched, (result) => result.reason, {open: unmatched.length > 0 && unmatched.length <= 30}),
			parsed.errors.length ? parseErrors(parsed.errors) : null,
			h('div', {class: 'actions'}, save, saveStatus)
		);

		async function doSave() {
			save.disabled = true;
			saveStatus.textContent = 'Saving...';

			try {
				await saveToCardIndex(cards);

				const counts = await applyImport(entries);

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
				saveStatus.textContent = `Could not save. Nothing was changed. ${errorText(err)}`;
			}
		}
	}

	root.append(
		h('h2', null, 'Import from monprice'),
		h('p', null, 'Export a collection from monprice as CSV or JSON, then pick the file here. The cards are matched to the catalog and listed in a report before anything is saved.'),
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
