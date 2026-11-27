// Check spares (Eric, 2026-11-25): every card he has more than once, each
// copy with where it is and why it counts as free or not (js/spare-check.js),
// and "I don't have this one" on each, which logs the copy as given away in
// the trades log (js/moves.js, a gift with no money), so the spares, the
// Shop, and HOTARU follow. Undo on the toast takes the gift back. A copy
// that was offered on HOTARU is withdrawn at once when he is the shop owner
// and online (js/store-publish.js withdrawListings); otherwise the Shop's
// next publish withdraws it, as the copy is gone.
//
// Routes (app.js):
//   trade/check                     every card with more than one copy,
//                                   from the Spares screen
//   trade/check/<lang>/<cardId>     one card in every language, from the
//                                   card page's Check next to the copies
//
// The whole list takes the search and Filters of My Cards (js/filter-bar.js)
// and its own sort, Where, and Show (js/spare-check.js narrowChecks), so
// Eric can check one pile at a time in the order it lies (2026-11-26). The
// choice is kept on this phone; one card's check has none.
//
// Finish (Eric, 2026-11-26): a copy added without its finish reads as a
// different one, so three "regulars" may be two and a reverse holo. Each
// copy's Finish opens the card page's own edit sheet (js/copy-sheet.js
// openEditSheet) on that copy, with the card's printings, so the finish is
// written, synced, and undone exactly as there; the list follows at once.
// Each copy is named as the card page's Your copies names it
// (js/catalog-views.js copyFinishName), so an unset finish says so.
//
// Checked (Eric, 2026-11-26): a card whose copies are all there leaves the
// whole list when he taps Checked, and the next card comes up under his
// thumb. The mark is kept on this phone only and changes no copy
// (js/spare-check.js isChecked); Show: Checked lists the marked cards, each
// with Not checked to bring it back.

import {artOf, cardFilterItem, entryInfo, fillRecords} from './binders-view.js';
import {catalogFor, catalogLanguage, cardIndex, printedCode, savedOwnRecords, viewingLanguage} from './catalog.js';
import {copyFinishName, finishChoices} from './catalog-views.js';
import {loadDocument, onChange, storedPlaces} from './collection.js';
import {closeCopySheet, languageName, openEditSheet, rawFinishes} from './copy-sheet.js';
import {isCustomId} from './custom-card.js';
import {BASE, backWords, errorText, h} from './dom.js';
import {applyFilters, FILTERS, filterBar, filterOn, sortItems, storageOf} from './filter-bar.js';
import {formatCount, freeText, plural} from './format.js';
import {finishLabel} from './monprice.js';
import {applyMove, undoMove} from './moves.js';
import {undoneText} from './moves-view.js';
import {toast} from './shell.js';
import {shopOwnerKnown} from './shop-owner.js';
import {ANY, CHECK_SORTS, REASONS, SHOWS, checkedPool, checkedSignature, goneFields, isChecked, keepChecked, narrowChecks, placeLabel, spareCheck, whereOptions} from './spare-check.js';
import {withdrawListings} from './store-publish.js';
import {tileArt} from './tile.js';
import {cardRecord, noteOnePrintings} from './wishlist.js';

const UNDO_MS = 8000;
const PAGE = 30;

// The search and filters are the bar's, kept under their own key; the
// sort, Where, and Show are kept beside them here.
const BAR_CHOICE = 'cardTracker.spareCheckChoice';
const OWN_CHOICE = 'cardTracker.spareCheckOwn';
const CHECKED_KEY = 'cardTracker.spareChecked';

// Favorites is a Show choice here, and Not in a binder is Where's Loose
// and trays; a price and a picture say nothing about a copy's place.
const OFFERED = FILTERS.filter((kind) => !['favorite', 'picture', 'price', 'unplaced'].includes(kind));

function readOwn() {
	try {
		const saved = JSON.parse(localStorage.getItem(OWN_CHOICE) || 'null') || {};

		return {
			show: SHOWS.some((option) => option.value === saved.show) ? saved.show : 'all',
			sort: CHECK_SORTS.some((option) => option.value === saved.sort) ? saved.sort : 'free',
			where: typeof saved.where === 'string' && saved.where ? saved.where : ANY,
			whereLabel: typeof saved.whereLabel === 'string' ? saved.whereLabel : '',
		};
	}
	catch {
		return {show: 'all', sort: 'free', where: ANY, whereLabel: ''};
	}
}

// The cards marked Checked, {group key: signature}. Without storage (a
// private window), the marks last for this visit.
function readChecked() {
	try {
		const saved = JSON.parse(localStorage.getItem(CHECKED_KEY) || 'null');

		return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
	}
	catch {
		return {};
	}
}

function writeChecked(marks) {
	try {
		localStorage.setItem(CHECKED_KEY, JSON.stringify(marks));
	}
	catch {
		// The marks last for this visit only.
	}
}

function writeOwn(own) {
	try {
		localStorage.setItem(OWN_CHOICE, JSON.stringify(own));
	}
	catch {
		// The choice lasts for this visit only.
	}
}

// The phone's own day, YYYY-MM-DD, as the trades log dates a move.
function today() {
	const now = new Date();

	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// What a copy's finish is called, as on the card page's Your copies:
// "Reverse Holo", "Finish not set", or the word of a finish the catalog
// does not list. variants: the card's printings, or null when this phone
// has not saved its record. A hand-made card's finish is monprice's word.
function finishText(entry, variants) {
	if (entry.catalog === 'custom') {
		return entry.finish_raw ? finishLabel(entry.finish_raw) : 'Finish not set';
	}

	return copyFinishName(entry, variants || [], variants === null);
}

// "Reverse Holo · Near Mint", or "Finish not set · Played".
const copyWords = (entry, variants) => [finishText(entry, variants), entry.condition].filter(Boolean).join(' · ');

// "Hoenn, page 3, pocket 4", "Loose", or both places of a copy two binders
// claim, so a clash shows rather than hides.
const whereText = (places) => (places.length ? places.map(placeLabel).join(' · also ') : placeLabel(null));

// The same words, each pocket a link to its binder's page that opens the
// pocket's Remove panel, where Keep the placeholder is (Eric, 2026-11-26: a
// pocket kept empty on purpose must say so, or it holds a copy he sells; see
// js/binders-view.js POCKET_PARAM). Two taps from here.
export const pocketRoute = (place) => `binders/${encodeURIComponent(place.binder_id)}/${place.page}?pocket=${place.position}`;

const whereNodes = (places) => (places.length
	? places.flatMap((place, i) => [
		i ? ' · also ' : null,
		place.kind === 'pocket' ? h('a', {class: 'check-copy-pocket', 'data-link': pocketRoute(place), href: BASE + pocketRoute(place)}, placeLabel(place)) : placeLabel(place),
	]).filter((part) => part !== null)
	: [placeLabel(null)]);

export function spareCheckView(root, {cardId = null, lang = null} = {}) {
	let alive = true;
	let index = new Map();
	let shown = PAGE;
	let focusKey = null;
	// After Checked, the place in the list whose card gets the focus: the
	// next card has moved up into it.
	let focusAt = null;
	let marks = readChecked();
	// Each card's printings from the record saved on this phone, by the
	// key the catalog saves it under ("card:<lang>:<card id>"), or null.
	let printings = new Map();
	const one = cardId ? {card_id: cardId, catalog: isCustomId(cardId) ? 'custom' : catalogFor(lang)} : null;
	const viewing = viewingLanguage();
	const back = one ? `cards/${encodeURIComponent(lang)}/${encodeURIComponent(cardId)}` : 'trade';
	const summary = h('p', {'aria-live': 'polite', class: 'muted', id: 'check-summary'}, 'Reading your cards…');
	const list = h('div', {class: 'check-list', id: 'check-list'});
	// Every group as last worked out, before the choice narrows it.
	let groups = [];
	const own = readOwn();
	const bar = one ? null : checkBar();

	root.append(
		h('a', {class: 'back', 'data-link': back, href: BASE + back, id: 'check-back'}, backWords(one ? 'Card' : 'Spares')),
		h('div', {class: 'view-head'}, h('h2', {id: 'check-title', tabindex: '-1'}, 'Check spares')),
		h('p', {class: 'muted check-intro'}, `Where every copy is, and why it counts as free or not. If you cannot find one, tap I don't have this one: it is logged in Trades as given away, so your spares and the Shop follow. Undo takes it back.${one ? '' : ' When every copy is there, tap Checked and the next card comes up.'}`),
		...(bar ? [bar.element] : []),
		summary,
		list
	);

	// The bar, with the sort beside Filters, and Where and Show on the line
	// under them. Clear all clears Where and Show too.
	function checkBar() {
		const option = ({label, long, value}) => h('option', {title: long || null, value}, label);
		const sortSelect = h('select', {'aria-label': 'Sort the cards', class: 'check-sort', id: 'check-sort'}, CHECK_SORTS.map((one) => option({...one, label: `Sort: ${one.label}`})));
		const whereSelect = h('select', {'aria-label': 'Where the copies are', class: 'check-where', id: 'check-where'});
		const showSelect = h('select', {'aria-label': 'Which cards to show', class: 'check-show', id: 'check-show'}, SHOWS.map(option));
		const pick = (key, select) => {
			select.onchange = () => {
				own[key] = select.value;
				writeOwn(own);
				shown = PAGE;
				redraw();
			};
		};

		sortSelect.value = own.sort;
		showSelect.value = own.show;
		pick('sort', sortSelect);
		pick('where', whereSelect);
		pick('show', showSelect);

		// The place's name, kept for when no card there is left to check.
		whereSelect.addEventListener('change', () => {
			const picked = whereSelect.selectedOptions[0];

			own.whereLabel = picked && own.where !== ANY ? picked.dataset.label || '' : '';
			writeOwn(own);
		});

		const made = filterBar({
			// The sheet's Show N cards counts what the list will show, Where
			// and Show included.
			// Check spares reads the details My Cards has downloaded and
			// downloads none itself, so a card added since may lack them.
			detailsPending: (items) => items.some((item) => !item.category && item.group.catalog !== 'custom'),
			countShown: (state) => narrowChecks(applyFilters(groups.map(itemOf), {filters: state.filters, query: state.query}), {checked: marks, show: own.show, where: own.where}).length,
			below: [h('div', {class: 'fb-row check-narrow'},
				h('span', {class: 'select-wrap'}, whereSelect),
				h('span', {class: 'select-wrap'}, showSelect))],
			extra: [h('span', {class: 'select-wrap fb-sort-wrap'}, sortSelect)],
			filters: OFFERED,
			id: 'check',
			narrowed: () => own.where !== ANY || own.show !== 'all',
			onChange: () => {
				shown = PAGE;
				redraw();
			},
			onClearAll: () => {
				own.where = ANY;
				own.whereLabel = '';
				own.show = 'all';
				writeOwn(own);
				showSelect.value = own.show;
			},
			placeholder: 'Search these cards',
			sorts: [],
			storageKey: BAR_CHOICE,
		});

		made.drawWhere = () => {
			const options = whereOptions(checkedPool(groups, {checked: marks, show: own.show}));

			// A place chosen stays chosen, at 0, once every card there is
			// checked, until another is picked.
			if (own.where !== ANY && !options.some((one) => one.value === own.where)) {
				options.push({count: 0, label: own.whereLabel || 'The place picked before', value: own.where});
			}

			whereSelect.replaceChildren(
				h('option', {value: ANY}, 'Anywhere'),
				...options.map((one) => h('option', {'data-label': one.label, value: one.value}, `${one.label} · ${plural(one.count, 'copy', 'copies')}`))
			);
			whereSelect.value = own.where;
		};

		return made;
	}

	// The bar's item for a group: the card's filter fields, where its
	// copies are stored, and its words for the search.
	function itemOf(group) {
		const entries = group.rows.map((row) => row.entry);
		const info = entryInfo(entries[0], index, viewing);
		const times = entries.map((entry) => String(entry.created_at || '')).sort();

		return {
			...cardFilterItem(entries[0], info, index),
			...storageOf(entries),
			favorite: group.favorite,
			group,
			key: group.key,
			newest: times[times.length - 1],
			oldest: times[0],
			search: info.search,
		};
	}

	// The groups the choice leaves, in its order.
	function narrowed() {
		if (!bar) {
			return groups;
		}

		const {filters, query} = bar.state;
		const items = groups.map(itemOf);

		bar.setItems(items);

		return narrowChecks(applyFilters(items, {filters, query}), {checked: marks, show: own.show, sort: own.sort, sortItems, where: own.where}).map((item) => item.group);
	}

	const isNarrowed = () => Boolean(bar) && (own.where !== ANY || own.show !== 'all' || bar.state.query.trim() !== '' || Object.values(bar.state.filters).some(filterOn));

	async function giveAway(row, info, button) {
		button.disabled = true;

		try {
			const {move} = await applyMove(goneFields(row.entry.id, {date: today()}));

			toast(`${info.name} logged as given away.`, {
				action: async () => {
					try {
						toast(undoneText(await undoMove(move.id)), {timeout: UNDO_MS});
					}
					catch (err) {
						toast(err.stale ? err.message : `Not undone. ${errorText(err)}`);
					}
				},
				actionLabel: 'Undo',
				timeout: UNDO_MS,
			});

			// Off HOTARU now, rather than at the next publish.
			if (row.free && shopOwnerKnown() === true && navigator.onLine) {
				withdrawListings([row.entry.id]).catch(() => {});
			}
		}
		catch (err) {
			if (alive && button.isConnected) {
				button.disabled = false;
			}

			toast(`Not saved. ${errorText(err)}`);
		}
	}

	// Checked, or Not checked under Show: Checked. The card leaves the list
	// and the one after it takes its place, where the focus goes.
	function setChecked(group, info, on) {
		const node = [...list.querySelectorAll('.check-group')].findIndex((section) => section.dataset.key === group.key);
		const before = marks;

		marks = {...marks};

		if (on) {
			marks[group.key] = checkedSignature(group);
		}
		else {
			delete marks[group.key];
		}

		writeChecked(marks);
		focusAt = node < 0 ? null : node;
		redraw();

		toast(on ? `${info.name} checked.` : `${info.name} is back in the list.`, {
			action: () => {
				if (!alive) {
					return;
				}

				marks = before;
				writeChecked(marks);
				focusKey = group.key;
				redraw();
			},
			actionLabel: 'Undo',
			timeout: UNDO_MS,
		});
	}

	function checkedButton(group, info) {
		const on = !isChecked(group, marks);
		const button = h('button', {class: on ? 'primary check-done' : 'check-done', type: 'button'}, on ? 'Checked' : 'Not checked');

		button.setAttribute('aria-label', on
			? `Checked: every copy of ${info.name} is there`
			: `Not checked: put ${info.name} back in the list`);
		button.onclick = () => setChecked(group, info, on);

		return h('div', {class: 'check-foot'}, button);
	}

	// The key the catalog saves a copy's full record under
	// (js/catalog.js savedOwnRecords).
	const recordKey = (entry) => `card:${entry.language || catalogLanguage(entry.catalog || 'international')}:${entry.card_id}`;
	const variantsOf = (entry) => {
		const record = printings.get(recordKey(entry));

		return record && Array.isArray(record.variants_detailed) ? record.variants_detailed : null;
	};

	// The card page's edit sheet on one copy, its finish to hand. The
	// printings are read as the card page reads them, cache first; without
	// them the sheet offers the plain words and says the catalog is offline.
	async function editCopy(row, info, button) {
		const entry = row.entry;
		let variants = [];
		let offline = false;

		// Busy, not disabled: a disabled button drops the focus, and the
		// sheet gives the focus back to whatever had it when it opened.
		if (button.getAttribute('aria-busy') === 'true') {
			return;
		}

		button.setAttribute('aria-busy', 'true');

		if (entry.catalog !== 'custom') {
			try {
				const found = await cardRecord(entry.card_id, entry.language, entry.catalog || 'international');

				variants = found && Array.isArray(found.card.variants_detailed) ? found.card.variants_detailed : [];

				if (found) {
					printings = new Map(printings).set(recordKey(entry), found.card);
				}
			}
			catch {
				offline = true;
			}
		}

		button.removeAttribute('aria-busy');

		if (!alive || !button.isConnected) {
			return;
		}

		// The pocket it is in, for the sheet's line under the title and its
		// Remove, as the card page gives it (js/copy-sheet.js copyPlaces).
		const pocket = row.places.find((place) => place.kind === 'pocket');
		const sheet = openEditSheet({
			card: {id: entry.card_id, name: info.name, number: info.number || null},
			catalog: entry.catalog === 'custom' ? 'custom' : entry.catalog || 'international',
			entries: [entry],
			finishes: entry.catalog === 'custom' ? rawFinishes() : finishChoices(variants, entry.card_id),
			offline,
			places: pocket ? new Map([[entry.id, pocket]]) : new Map(),
		});
		const select = sheet && sheet.querySelector('#copy-finish');

		if (select) {
			select.focus();
		}
	}

	function copyItem(row, info) {
		const reason = REASONS[row.reason];
		const words = copyWords(row.entry, variantsOf(row.entry));
		const button = h('button', {class: 'small check-gone', type: 'button'}, 'I don\'t have this one');
		const finish = h('button', {'aria-haspopup': 'dialog', class: 'small check-finish', type: 'button'}, 'Finish');

		button.setAttribute('aria-label', `I don't have this one: ${words}, ${whereText(row.places)}`);
		button.onclick = () => {
			focusKey = row.groupKey;
			giveAway(row, info, button);
		};
		finish.setAttribute('aria-label', `Finish: ${words}, ${whereText(row.places)}`);
		finish.onclick = () => editCopy(row, info, finish);

		return h('li', {class: row.free ? 'check-copy is-free' : 'check-copy', 'data-entry': row.entry.id},
			h('div', {class: 'check-copy-text'},
				h('span', {class: 'check-copy-what'}, words),
				h('span', {class: 'check-copy-where'}, ...whereNodes(row.places)),
				h('span', {class: 'check-copy-why'}, h('span', {class: row.free ? 'check-tag is-free' : 'check-tag'}, reason.label), ` ${reason.text}`)),
			h('div', {class: 'check-copy-actions'}, finish, button));
	}

	function groupNode(group) {
		const info = entryInfo(group.rows[0].entry, index, viewing);
		const art = artOf({catalog: group.catalog, card_id: group.card_id, language: group.language}, info, (src) => tileArt({
			count: group.copies,
			decorative: true,
			free: group.free,
			info,
			languages: [group.language],
			src,
			viewing: null,
		}));
		const headingId = `check-${group.key.replace(/[^a-z0-9]+/gi, '-')}`;

		return h('section', {'aria-labelledby': headingId, class: 'card check-group', 'data-key': group.key},
			h('div', {class: 'check-head'},
				h('a', {'aria-hidden': 'true', class: 'check-thumb', 'data-link': info.route, href: BASE + info.route, tabindex: '-1'}, art),
				h('div', {class: 'check-head-text'},
					h('h3', {class: 'check-name', id: headingId, tabindex: '-1'}, h('a', {'data-link': info.route, href: BASE + info.route}, info.name)),
					h('span', {class: 'check-meta'}, [info.number ? `#${info.number}` : null, info.setName, languageName(group.language)].filter(Boolean).join(' · ')),
					h('span', {class: group.free ? 'check-count is-free' : 'check-count'}, freeText(group.copies, group.free)))),
			h('ul', {class: 'check-copies'}, ...group.rows.map((row) => copyItem({...row, groupKey: group.key}, info))),
			...(bar ? [checkedButton(group, info)] : []));
	}

	function redraw() {
		if (bar) {
			bar.drawWhere();
		}

		draw(narrowed());
	}

	function draw(kept) {
		const free = kept.reduce((sum, group) => sum + group.free, 0);
		const copies = kept.reduce((sum, group) => sum + group.copies, 0);

		// The cards marked Checked, left out of every Show but Checked.
		const done = bar ? groups.filter((group) => isChecked(group, marks)).length : 0;
		const hidden = own.show === 'checked' || !done ? '' : ` ${formatCount(done)} checked.`;

		if (!kept.length) {
			summary.textContent = one ? 'You have no copies of this card.'
				: own.show === 'checked' && !done ? 'No card is checked yet.'
					: groups.length && isNarrowed() ? 'No card matches. Clear all shows every card again.'
						: groups.length && done === groups.length ? 'Every card is checked. Show: Checked lists them.'
							: 'No card has more than one copy.';
			list.replaceChildren();

			// The last card checked: the focus goes to the title.
			if (focusKey !== null || focusAt !== null) {
				focusKey = null;
				focusAt = null;
				root.querySelector('#check-title').focus();
			}

			return;
		}

		const counts = `${plural(copies, 'copy', 'copies')}, ${formatCount(free)} free.`;

		summary.textContent = one
			? freeText(copies, free)
			: isNarrowed() || done
				? `${formatCount(kept.length)} of ${plural(groups.length, 'card', 'cards')} with more than one copy: ${counts}${hidden}`
				: `${plural(kept.length, 'card', 'cards')} with more than one copy: ${counts}`;

		const visible = kept.slice(0, shown);
		const more = kept.length - visible.length;

		const moreButton = more > 0
			? h('button', {class: 'check-more', id: 'check-more', onclick: () => {
				shown += PAGE;
				draw(kept);
			}, type: 'button'}, `Show ${formatCount(Math.min(more, PAGE))} more`)
			: null;

		// A redraw (a finish saved, a sync) keeps the focus on the same
		// button of the same copy, as the card page's rows do; the edit
		// sheet gives the focus back to Finish when it closes.
		const was = list.contains(document.activeElement) ? document.activeElement : null;
		const wasCopy = was && was.closest('[data-entry]') ? was.closest('[data-entry]').dataset.entry : null;
		const wasClass = was ? ['check-finish', 'check-gone'].find((name) => was.classList.contains(name)) : null;

		list.replaceChildren(...visible.map(groupNode), ...(moreButton ? [moreButton] : []));

		if (wasCopy && wasClass && focusKey === null && focusAt === null) {
			const copy = [...list.querySelectorAll('[data-entry]')].find((node) => node.dataset.entry === wasCopy);
			const again = copy && copy.querySelector(`.${wasClass}`);

			if (again) {
				again.focus({preventScroll: true});
			}
		}

		// After a copy goes, the focus stays at its card, or at the title
		// when the card left the list.
		if (focusKey !== null) {
			const section = [...list.querySelectorAll('.check-group')].find((node) => node.dataset.key === focusKey);
			const target = section ? section.querySelector('.check-name') : root.querySelector('#check-title');

			focusKey = null;

			if (target) {
				target.focus();
			}
		}

		// After Checked, the card now in its place, top of the screen, or
		// the last card when the checked one was last.
		if (focusAt !== null) {
			const sections = [...list.querySelectorAll('.check-group')];
			const section = sections[Math.min(focusAt, sections.length - 1)];

			focusAt = null;

			if (section) {
				section.scrollIntoView({block: 'start'});
				section.querySelector('.check-name').focus({preventScroll: true});
			}
		}

		fillMissing();
	}

	// The records the cards lack: the set, number, and name the tiles,
	// filters, and sorts read. A whole list asks for every card's, since a
	// filter or sort reads the cards not yet shown too. Each card is asked
	// for once a visit, so a card the catalog lacks is not asked for again
	// at every change of filter.
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

	const check = (doc) => spareCheck(doc, {codeOf: printedCode, only: one});

	// The full records this phone has saved for the cards, with no request
	// (My Cards and the card page save them), so each copy's finish is
	// named; a card with none says its finish as its word.
	let reading = 0;

	function readPrintings() {
		const run = ++reading;

		savedOwnRecords(groups.flatMap((group) => group.rows.map((row) => row.entry))).then((found) => {
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
		// A card with one printing counts an unset copy as it (js/wishlist.js
		// noteOnePrintings), so the index is read into it before the groups.
		noteOnePrintings(found.values());
		groups = check(doc);

		// Forget the marks on cards whose copies changed since: the list
		// they were checked against no longer holds. Only at opening, so an
		// Undo during the visit brings a mark back with its copy.
		if (bar) {
			marks = keepChecked(groups, marks);
			writeChecked(marks);
		}

		if (bar) {
			bar.setPlaces(storedPlaces(doc).map((place) => place.name));
		}

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
			groups = check(doc);
			redraw();
			readPrintings();
		}
	});

	return () => {
		alive = false;
		stop();
		closeCopySheet();

		if (bar) {
			bar.destroy();
		}
	};
}

export const spareCheckRoutes = [
	{pattern: /^trade\/check$/, render: spareCheckView, tab: 'cards', title: 'Check spares | Card Tracker'},
	{keys: ['lang', 'cardId'], pattern: /^trade\/check\/([^/]+)\/([^/]+)$/, render: spareCheckView, tab: 'cards', title: 'Check spares | Card Tracker'},
];

export const spareCheckAccountViews = [spareCheckView];
