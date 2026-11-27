// Monprice import check (Eric, 2026-11-26): the groups of copies the import
// made where one card, language, and finish has more than one copy
// (js/import-dup-check.js), for him to count in his hands. Since v122 such a
// second copy is a spare and gets listed for sale, so a duplicate the import
// made by mistake would be sold. Each group shows the picture, the name, the
// set and number, the language, the finish, how many copies, and when they
// were added, with a link to the card page, where a copy that is not there
// is removed with Remove copy and its Undo (js/copy-sheet.js), and a
// "Checked, I have them" mark that hides the group.
//
// The mark is kept on this phone only, like Check spares' Checked
// (js/spare-check-view.js), and changes no copy: a group comes back when its
// count changes (js/import-dup-check.js checkedSignature). "Show checked"
// lists the marked groups, each with Not checked.
//
// Route (app.js, through js/copy-cleanup.js):
//   trade/check/import    from Check spares, one line under its heading

import {artOf, entryInfo, fillRecords} from './binders-view.js';
import {cardIndex, savedOwnRecords, viewingLanguage} from './catalog.js';
import {copyFinishName} from './catalog-views.js';
import {loadDocument, onChange} from './collection.js';
import {languageName} from './copy-sheet.js';
import {BASE, backWords, errorText, h} from './dom.js';
import {formatCount, plural} from './format.js';
import {addedText, checkedSignature, importDuplicates, isChecked, keepChecked, markedChecked, toCheck} from './import-dup-check.js';
import {finishLabel} from './monprice.js';
import {toast} from './shell.js';
import {tileArt} from './tile.js';
import {noteOnePrintings} from './wishlist.js';

const UNDO_MS = 8000;
const PAGE = 30;

export const IMPORT_CHECKED_KEY = 'cardTracker.importChecked';

// The groups marked Checked, {group key: signature}. Without storage (a
// private window), the marks last for this visit.
export function readImportChecked() {
	try {
		const saved = JSON.parse(localStorage.getItem(IMPORT_CHECKED_KEY) || 'null');

		return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
	}
	catch {
		return {};
	}
}

function writeChecked(marks) {
	try {
		localStorage.setItem(IMPORT_CHECKED_KEY, JSON.stringify(marks));
	}
	catch {
		// The marks last for this visit only.
	}
}

// What a group's finish is called: as the card page's Your copies names a
// copy's, from a copy that has one (a group whose finish key came from a
// card's only printing may hold copies with no finish set).
function finishWords(group, variants) {
	const entry = group.rows.find((row) => row.variant_id || row.finish_raw) || group.rows[0];

	if (entry.catalog === 'custom') {
		return entry.finish_raw ? finishLabel(entry.finish_raw) : 'No finish set';
	}

	return copyFinishName(entry, variants || [], variants === null);
}

export function importDupView(root) {
	let alive = true;
	let index = new Map();
	let groups = [];
	let marks = readImportChecked();
	let showChecked = false;
	let shown = PAGE;
	// After Checked, the place in the list whose group gets the focus: the
	// next group has moved up into it.
	let focusAt = null;
	// Each card's printings from the record saved on this phone, by
	// "card:<lang>:<card id>", for naming the finish.
	let printings = new Map();
	const viewing = viewingLanguage();
	const summary = h('p', {'aria-live': 'polite', class: 'muted', id: 'import-summary'}, 'Reading your cards…');
	const list = h('div', {class: 'check-list', id: 'import-list'});
	const toggle = h('button', {class: 'small', hidden: true, id: 'import-show-checked', type: 'button'});

	root.append(
		h('a', {class: 'back', 'data-link': 'trade/check', href: `${BASE}trade/check`, id: 'import-back'}, backWords('Check spares')),
		h('div', {class: 'view-head'}, h('h2', {id: 'import-title', tabindex: '-1'}, 'Monprice import check')),
		h('p', {class: 'muted check-intro'}, 'Cards the monprice import added more than once in the same language and finish. Since a second copy in the same finish counts as a spare and is listed for sale, count each group in your hands. If a copy is not there, open the card and remove it: Remove copy has an Undo. When you have them all, tap Checked.'),
		summary,
		h('div', {class: 'import-toggle'}, toggle),
		list
	);

	toggle.onclick = () => {
		showChecked = !showChecked;
		shown = PAGE;
		redraw();
	};

	const recordKey = (entry) => `card:${entry.language || 'en'}:${entry.card_id}`;
	const variantsOf = (group) => {
		const record = printings.get(recordKey(group.rows[0]));

		return record && Array.isArray(record.variants_detailed) ? record.variants_detailed : null;
	};

	// Checked, or Not checked under Show checked.
	function setChecked(group, info, on) {
		const position = [...list.querySelectorAll('.import-group')].findIndex((section) => section.dataset.key === group.key);
		const before = marks;

		marks = {...marks};

		if (on) {
			marks[group.key] = checkedSignature(group);
		}
		else {
			delete marks[group.key];
		}

		writeChecked(marks);
		focusAt = position < 0 ? null : position;
		redraw();

		toast(on ? `${info.name} checked.` : `${info.name} is back in the list.`, {
			action: () => {
				if (!alive) {
					return;
				}

				marks = before;
				writeChecked(marks);
				focusAt = position < 0 ? null : position;
				redraw();
			},
			actionLabel: 'Undo',
			timeout: UNDO_MS,
		});
	}

	function groupNode(group) {
		const info = entryInfo(group.rows[0], index, viewing);
		const checked = isChecked(group, marks);
		const art = artOf({catalog: group.catalog, card_id: group.card_id, language: group.language}, info, (src) => tileArt({
			count: group.copies,
			decorative: true,
			info,
			languages: [group.language],
			src,
			viewing: null,
		}));
		const headingId = `import-${group.key.replace(/[^a-z0-9]+/gi, '-')}`;
		const button = h('button', {class: checked ? 'import-done' : 'primary import-done', type: 'button'}, checked ? 'Not checked' : 'Checked, I have them');

		button.setAttribute('aria-label', checked
			? `Not checked: put ${info.name} back in the list`
			: `Checked, I have them: all ${group.copies} copies of ${info.name}, ${finishWords(group, variantsOf(group))}`);
		button.onclick = () => setChecked(group, info, !checked);

		const open = h('a', {'aria-label': `Open ${info.name} to remove a copy`, class: 'button small import-open', 'data-link': info.route, href: BASE + info.route}, 'Open card');

		return h('section', {'aria-labelledby': headingId, class: 'card check-group import-group', 'data-key': group.key},
			h('div', {class: 'check-head'},
				h('a', {'aria-hidden': 'true', class: 'check-thumb', 'data-link': info.route, href: BASE + info.route, tabindex: '-1'}, art),
				h('div', {class: 'check-head-text'},
					h('h3', {class: 'check-name', id: headingId, tabindex: '-1'}, h('a', {'data-link': info.route, href: BASE + info.route}, info.name)),
					h('span', {class: 'check-meta'}, [info.number ? `#${info.number}` : null, info.setName, languageName(group.language)].filter(Boolean).join(' · ')),
					h('span', {class: 'import-finish'}, finishWords(group, variantsOf(group))),
					h('span', {class: 'check-count import-count'}, `${group.copies} copies`),
					h('span', {class: 'check-meta import-added'}, addedText(group)))),
			h('div', {class: 'check-foot import-foot'}, open, button));
	}

	function redraw() {
		const pending = toCheck(groups, marks);
		const done = markedChecked(groups, marks);

		// Nothing left checked: back to the groups to check.
		if (!done.length) {
			showChecked = false;
		}

		const kept = showChecked ? done : pending;

		toggle.hidden = !done.length;
		toggle.textContent = showChecked ? 'Show groups to check' : `Show checked (${formatCount(done.length)})`;

		if (!groups.length) {
			summary.textContent = 'No imported card has more than one copy in the same language and finish, so there is nothing to check.';
		}
		else if (showChecked) {
			summary.textContent = `${plural(done.length, 'group', 'groups')} checked.`;
		}
		else if (!pending.length) {
			summary.textContent = 'Every group is checked. Show checked lists them.';
		}
		else {
			const copies = pending.reduce((sum, group) => sum + group.copies, 0);

			summary.textContent = `${plural(pending.length, 'group', 'groups')} to check, ${plural(copies, 'copy', 'copies')} in all.${done.length ? ` ${formatCount(done.length)} checked.` : ''}`;
		}

		const visible = kept.slice(0, shown);
		const more = kept.length - visible.length;
		const moreButton = more > 0
			? h('button', {class: 'check-more', id: 'import-more', onclick: () => {
				shown += PAGE;
				redraw();
			}, type: 'button'}, `Show ${formatCount(Math.min(more, PAGE))} more`)
			: null;

		list.replaceChildren(...visible.map(groupNode), ...(moreButton ? [moreButton] : []));

		// After Checked, the group now in its place takes the focus, or the
		// title when the list is empty.
		if (focusAt !== null) {
			const sections = [...list.querySelectorAll('.import-group')];
			const section = sections[Math.min(focusAt, sections.length - 1)];

			focusAt = null;

			if (section) {
				section.scrollIntoView({block: 'start'});
				section.querySelector('.check-name').focus({preventScroll: true});
			}
			else {
				root.querySelector('#import-title').focus();
			}
		}

		fillMissing();
	}

	// The records the cards lack, once a visit each, for the names, sets,
	// and numbers.
	let filling = false;
	const asked = new Set();

	function fillMissing() {
		if (filling) {
			return;
		}

		const missing = groups.map((group) => ({cardId: group.card_id, catalog: group.catalog}))
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

	// The full records this phone has saved, with no request, so a finish is
	// named as the card page names it.
	let reading = 0;

	function readPrintings() {
		const run = ++reading;

		savedOwnRecords(groups.flatMap((group) => group.rows)).then((found) => {
			if (!alive || run !== reading) {
				return;
			}

			const changed = [...found.keys()].some((key) => !printings.has(key));

			printings = new Map([...printings, ...found]);

			if (changed) {
				redraw();
			}
		}).catch(() => {});
	}

	(async () => {
		const [doc, found] = await Promise.all([loadDocument(), cardIndex().catch(() => new Map())]);

		if (!alive) {
			return;
		}

		index = found;
		// A card with one printing counts an unset copy as it
		// (js/wishlist.js noteOnePrintings), as the spares do.
		noteOnePrintings(found.values());
		groups = importDuplicates(doc.cards);

		// Forget the marks on groups that changed or went, only at opening,
		// so an Undo during the visit brings a mark back with its copy.
		marks = keepChecked(groups, marks);
		writeChecked(marks);
		redraw();
		readPrintings();
	})().catch((err) => {
		if (alive) {
			summary.textContent = '';
			list.replaceChildren(h('div', {class: 'notice', role: 'alert'}, h('p', null, `Your cards could not be read. ${errorText(err)}`)));
		}
	});

	const stop = onChange((doc) => {
		if (alive && doc && Array.isArray(doc.cards)) {
			groups = importDuplicates(doc.cards);
			redraw();
			readPrintings();
		}
	});

	return () => {
		alive = false;
		stop();
	};
}

export const importDupRoutes = [
	{pattern: /^trade\/check\/import$/, render: importDupView, tab: 'cards', title: 'Monprice import check | Card Tracker'},
];

export const importDupAccountViews = [importDupView];
