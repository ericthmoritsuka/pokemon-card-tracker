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

import {artOf, cardFilterItem, entryInfo, fillRecords} from './binders-view.js';
import {catalogFor, cardIndex, printedCode, viewingLanguage} from './catalog.js';
import {loadDocument, onChange, storedPlaces} from './collection.js';
import {languageName} from './copy-sheet.js';
import {isCustomId} from './custom-card.js';
import {BASE, backWords, errorText, h} from './dom.js';
import {applyFilters, FILTERS, filterBar, filterOn, sortItems, storageOf} from './filter-bar.js';
import {formatCount, freeText, plural} from './format.js';
import {applyMove, undoMove} from './moves.js';
import {undoneText} from './moves-view.js';
import {toast} from './shell.js';
import {shopOwnerKnown} from './shop-owner.js';
import {ANY, CHECK_SORTS, REASONS, SHOWS, goneFields, narrowChecks, placeLabel, spareCheck, whereOptions} from './spare-check.js';
import {withdrawListings} from './store-publish.js';
import {FINISHES, entryFinish, tileArt} from './tile.js';

const UNDO_MS = 8000;
const PAGE = 30;

// The search and filters are the bar's, kept under their own key; the
// sort, Where, and Show are kept beside them here.
const BAR_CHOICE = 'cardTracker.spareCheckChoice';
const OWN_CHOICE = 'cardTracker.spareCheckOwn';

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

// "Reverse holo · Near Mint", or "Regular" for the plain print.
function copyWords(entry) {
	const code = entryFinish(entry);

	return [code && FINISHES[code] ? FINISHES[code].label : 'Regular', entry.condition].filter(Boolean).join(' · ');
}

// "Hoenn, page 3, pocket 4", "Loose", or both places of a copy two binders
// claim, so a clash shows rather than hides.
const whereText = (places) => (places.length ? places.map(placeLabel).join(' · also ') : placeLabel(null));

export function spareCheckView(root, {cardId = null, lang = null} = {}) {
	let alive = true;
	let index = new Map();
	let shown = PAGE;
	let focusKey = null;
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
		h('p', {class: 'muted check-intro'}, 'Where every copy is, and why it counts as free or not. If you cannot find one, tap I don\'t have this one: it is logged in Trades as given away, so your spares and the Shop follow. Undo takes it back.'),
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
			countShown: (state) => narrowChecks(applyFilters(groups.map(itemOf), {filters: state.filters, query: state.query}), {show: own.show, where: own.where}).length,
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
			const options = whereOptions(groups);

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

		return narrowChecks(applyFilters(items, {filters, query}), {show: own.show, sort: own.sort, sortItems, where: own.where}).map((item) => item.group);
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

	function copyItem(row, info) {
		const reason = REASONS[row.reason];
		const button = h('button', {class: 'small check-gone', type: 'button'}, 'I don\'t have this one');

		button.setAttribute('aria-label', `I don't have this one: ${copyWords(row.entry)}, ${whereText(row.places)}`);
		button.onclick = () => {
			focusKey = row.groupKey;
			giveAway(row, info, button);
		};

		return h('li', {class: row.free ? 'check-copy is-free' : 'check-copy', 'data-entry': row.entry.id},
			h('div', {class: 'check-copy-text'},
				h('span', {class: 'check-copy-what'}, copyWords(row.entry)),
				h('span', {class: 'check-copy-where'}, whereText(row.places)),
				h('span', {class: 'check-copy-why'}, h('span', {class: row.free ? 'check-tag is-free' : 'check-tag'}, reason.label), ` ${reason.text}`)),
			button);
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
			h('ul', {class: 'check-copies'}, ...group.rows.map((row) => copyItem({...row, groupKey: group.key}, info))));
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

		if (!kept.length) {
			summary.textContent = one ? 'You have no copies of this card.'
				: groups.length && isNarrowed() ? 'No card matches. Clear all shows every card again.'
					: 'No card has more than one copy.';
			list.replaceChildren();

			return;
		}

		const counts = `${plural(copies, 'copy', 'copies')}, ${formatCount(free)} free.`;

		summary.textContent = one
			? freeText(copies, free)
			: isNarrowed()
				? `${formatCount(kept.length)} of ${plural(groups.length, 'card', 'cards')} with more than one copy: ${counts}`
				: `${plural(kept.length, 'card', 'cards')} with more than one copy: ${counts}`;

		const visible = kept.slice(0, shown);
		const more = kept.length - visible.length;

		const moreButton = more > 0
			? h('button', {class: 'check-more', id: 'check-more', onclick: () => {
				shown += PAGE;
				draw(kept);
			}, type: 'button'}, `Show ${formatCount(Math.min(more, PAGE))} more`)
			: null;

		list.replaceChildren(...visible.map(groupNode), ...(moreButton ? [moreButton] : []));

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

	(async () => {
		const [doc, found] = await Promise.all([loadDocument(), cardIndex().catch(() => new Map())]);

		if (!alive) {
			return;
		}

		index = found;
		groups = check(doc);

		if (bar) {
			bar.setPlaces(storedPlaces(doc).map((place) => place.name));
		}

		redraw();
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
		}
	});

	return () => {
		alive = false;
		stop();

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
