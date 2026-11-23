// Wishlist screens (js/wishlist.js). Two routes, under the app's base:
//   wishlist            the person's own wishlist: add, edit, remove
//   wishlist/<userId>   a family member's wishlist, read only, with the
//                       viewer's spares of each item
//
// WISHLIST_ROUTES is shaped like app.js's ROUTES, and WISHLIST_ACCOUNT_VIEWS
// lists the views to redraw on sign-in and sign-out (app.js ACCOUNT_ROUTES).
// The wishlist is the second half of the Lists tab (dom.js listsSwitch), and
// js/shell.js draws the view-only strip and the "Mine" switcher.

import {currentUser} from './auth.js';
import {offerCardList} from './card-swipe.js';
import {cardImage, viewingLanguage} from './catalog.js';
import {listCards, onChange} from './collection.js';
import {BASE, errorText, go, h, listsSwitch} from './dom.js';
import {memberCards} from './family.js';
import {setPendingMove} from './moves.js';
import {formatCount, plural} from './format.js';
import {CATALOG_LANGUAGES, catalogFor, languageChip, languageLabel} from './languages.js';
import {imageCardKey, mainArt, onFamilyPhotosChange, onImagesChange, sharedRecordsFor} from './photos/index.js';
import {copyValue, formatBrlCompact, savedRates} from './prices.js';
import {readChoice, saveChoice} from './settings.js';
import {cardArt, cardTile, tileArt, variantFinish} from './tile.js';
import {
	NOTE_MAX,
	PRIORITIES,
	PRIORITY_LABELS,
	SearchHint,
	addToWishlist,
	cardRecord,
	displayLanguage,
	languagesFor,
	listGotWishes,
	listWishlist,
	memberWishlist,
	ownedCopies,
	refreshFamilyWishlists,
	removeWish,
	searchCards,
	sparesFor,
	tradeIdeas,
	updateWish,
	variantLabel,
	wantAgain,
} from './wishlist.js';

const link = (route, attrs, ...children) => h('a', {...attrs, 'data-link': route, href: BASE + route}, ...children);

const routeTo = (...parts) => parts.map((part) => encodeURIComponent(part)).join('/');

// The card page an item opens, in the language it is shown in.
const itemRoute = (item, viewing) => routeTo('cards', displayLanguage(item, viewing), item.card_id);

const SEARCH_LANG_KEY = 'cardTracker.wishlistSearchLanguage';

// ------------------------------------------------------- card details

// Card details for the items on screen, one request per card even when an
// item is drawn twice. Cache first (js/catalog.js), so a card shown once
// shows again offline.
function cardLoader() {
	const loaded = new Map();

	return (item, viewing) => {
		const lang = displayLanguage(item, viewing);
		const key = `${lang}|${item.catalog || 'international'}|${item.card_id}`;

		if (!loaded.has(key)) {
			loaded.set(key, cardRecord(item.card_id, lang, item.catalog || 'international').catch(() => null));
		}

		return loaded.get(key);
	};
}

function cardInfo(item, found) {
	const card = found && found.card;
	const set = (card && card.set) || {};

	return {
		image: card ? cardImage(card.image, 'low') : null,
		name: (card && card.name) || item.card_id,
		number: card ? card.localId : null,
		official: set.cardCount ? set.cardCount.official : null,
		setName: set.name || null,
		variants: card && Array.isArray(card.variants_detailed) ? card.variants_detailed : null,
	};
}

const numberText = (info) => (info.number ? `#${info.number}${info.official ? ` / ${info.official}` : ''}` : null);

// What a wished card costs, "≈ R$ 12,40", as a copy of it in the wished
// language and finish would be valued (prices.js copyValue, the market
// price at the saved dollar rate); null when the record has no price or
// there is no rate yet (design review 2, 2026-11-20).
function wishValue(item, found, viewing) {
	const card = found && found.card;

	if (!card) {
		return null;
	}

	const value = copyValue({card_id: item.card_id, catalog: item.catalog || 'international', language: item.language || displayLanguage(item, viewing), variant_id: item.variant_id || null}, card, {rates: savedRates()});

	return value && typeof value.brl === 'number' && value.brl > 0 ? `≈ ${formatBrlCompact(value.brl)}` : null;
}

function finishText(item, info) {
	if (!item.variant_id) {
		return null;
	}

	const variant = (info.variants || []).find((entry) => entry.variantId === item.variant_id);

	return variant ? variantLabel(variant) : 'A chosen finish';
}

// ------------------------------------------------------ one item row

// The day an item was got, as "Oct 31".
const gotDay = (at) => new Date(at).toLocaleDateString('en-US', {day: 'numeric', month: 'short'});

// Each drawn row's art, so a new image draws the art again from what the
// row was drawn with, never the whole list (redrawArt).
const rowArt = new WeakMap();

// Draws again the art of the rows in `lists` whose card is in `cards` (a
// Set of "catalog~card_id", onImagesChange), or of every row for null.
function redrawArt(lists, cards) {
	for (const list of lists) {
		for (const row of list.children) {
			const art = rowArt.get(row);

			if (art && (!cards || cards.has(art.key))) {
				art.draw();
			}
		}
	}
}

// got: {onClear, onBack} for a row of Got it, which shows when it was got
// in place of Edit. records(target): a family member's card records on
// their wishlist, whose photos the art shows; null for the person's own.
// line: a sentence under the chips in place of the spares line (Trade
// ideas: "Leo has 1 spare · Near Mint").
function itemRow(item, found, {got = null, line = null, mine = false, onEdit = null, onRemove = null, owned = 0, records = null, spares = 0, viewing = null} = {}) {
	const info = cardInfo(item, found);
	const variant = item.variant_id ? (info.variants || []).find((entry) => entry.variantId === item.variant_id) : null;
	const finish = finishText(item, info);
	const chips = h('div', {class: 'wl-chips'},
		h('span', {class: `wl-priority wl-priority-${item.priority || 'normal'}`}, `${PRIORITY_LABELS[item.priority] || 'Normal'} priority`),
		item.language
			? h('span', {'aria-label': `Printed in ${languageLabel(item.language)}`, class: 'wl-chip'}, languageChip(item.language))
			: h('span', {class: 'wl-chip wl-chip-any'}, 'Any language'),
		h('span', {class: finish ? 'wl-chip' : 'wl-chip wl-chip-any'}, finish || 'Any finish')
	);
	const value = wishValue(item, found, viewing);
	const body = h('div', {class: 'wl-body'},
		h('span', {class: 'wl-name'}, info.name),
		h('span', {class: 'wl-meta'}, [numberText(info), info.setName].filter(Boolean).join(' · ') || item.card_id),
		value ? h('span', {class: 'wl-value'}, value) : null,
		chips,
		item.note ? h('p', {class: 'wl-note'}, item.note) : null
	);

	if (mine && owned) {
		body.append(h('div', {class: 'wl-owned', role: 'status'},
			h('span', null, owned > 1 ? `You have this now (${formatCount(owned)} copies)` : 'You have this now'),
			h('button', {'aria-label': `Remove ${info.name} from the wishlist`, class: 'wl-owned-remove', onclick: onRemove, type: 'button'}, 'Remove')
		));
	}

	if (line) {
		body.append(h('p', {class: 'wl-spare'}, line));
	}
	else if (!mine && spares) {
		body.append(h('p', {class: 'wl-spare'}, `You have ${formatCount(spares)} spare`));
	}

	if (got) {
		body.append(h('div', {class: 'wl-got', role: 'status'},
			h('span', null, `Got it ${gotDay(item.got_at)}`),
			h('button', {'aria-label': `Clear ${info.name} from Got it`, class: 'wl-got-clear', onclick: got.onClear, type: 'button'}, 'Clear'),
			h('button', {'aria-label': `Put ${info.name} back on the wishlist`, class: 'wl-got-back', onclick: got.onBack, type: 'button'}, 'Want again')
		));
	}
	else if (mine) {
		// Inline with the chips, so a row is about 150 px tall rather than
		// 200 (design review 2, 2026-11-20).
		chips.append(h('button', {'aria-label': `Edit ${info.name}`, class: 'wl-edit', onclick: onEdit, type: 'button'}, 'Edit'));
	}

	// The art is the shared tile (js/tile.js), and opens the card page, which
	// swipes through the list. Its image is the card's main image, as My
	// Cards picks it: the card's record keeps photos at zero copies, in the
	// wished language, or any when the wish takes any.
	const target = {catalog: item.catalog || 'international', card_id: item.card_id, language: item.language || null};
	const art = () => mainArt(target, info.image, (src) => link(itemRoute(item, viewing), {'aria-label': `Open ${info.name}`, class: 'wl-art'}, tileArt({
		finish: variantFinish(variant),
		info,
		languages: item.language ? [item.language] : [],
		src,
		status: mine && owned ? 'owned' : null,
		statusLabel: mine && owned ? 'You have this now' : null,
		viewing,
	})), (src) => cardArt(info, src), records ? {family: false, records: records(target)} : {});
	let shown = art();
	const row = h('li', {class: owned && mine ? 'wl-item wl-has' : 'wl-item', 'data-id': item.id}, shown, body);

	rowArt.set(row, {
		draw: () => {
			const next = art();

			shown.replaceWith(next);
			shown = next;
		},
		key: imageCardKey(target),
	});

	return row;
}

// --------------------------------------------------- whose wishlist

function heading(text, memberId) {
	return h('div', null,
		h('div', {class: 'view-head'}, h('h2', {id: 'wishlist-title'}, text)),
		listsSwitch('wishlist', memberId)
	);
}

// --------------------------------------------------------- the editor

// The form for a new item or a change to one. card: the TCGdex card (for its
// finishes) or null when it is not on the phone.
function editor({card, catalog, item = null, onCancel, onRemove = null, onSave, title}) {
	const languages = languagesFor(catalog);
	const variants = card && Array.isArray(card.variants_detailed) ? card.variants_detailed.filter((variant) => variant.variantId) : [];
	const language = h('select', {id: 'wish-language'},
		h('option', {value: ''}, 'Any language'),
		languages.map((lang) => h('option', {value: lang.code}, lang.label))
	);
	const finish = h('select', {id: 'wish-finish'},
		h('option', {value: ''}, 'Any finish'),
		variants.map((variant) => h('option', {value: variant.variantId}, variantLabel(variant)))
	);
	const chosen = (item && item.priority) || 'normal';
	const priority = h('div', {'aria-label': 'Priority', class: 'segmented', id: 'wish-priority', role: 'radiogroup'},
		PRIORITIES.map((value) => h('label', null,
			h('input', {checked: value === chosen, name: 'wish-priority', type: 'radio', value}),
			h('span', null, PRIORITY_LABELS[value])
		))
	);
	const note = h('textarea', {class: 'wl-textarea', id: 'wish-note', maxlength: NOTE_MAX, placeholder: 'Optional, for example "for the binder" or "PT only if cheap"', rows: 3});
	const status = h('p', {class: 'muted', role: 'status'});
	const save = h('button', {class: 'primary', id: 'wish-save', type: 'submit'}, item ? 'Save changes' : 'Add to wishlist');

	language.value = (item && item.language) || '';
	note.value = (item && item.note) || '';

	if (item && item.variant_id) {
		if (!variants.some((variant) => variant.variantId === item.variant_id)) {
			finish.append(h('option', {value: item.variant_id}, 'The finish chosen before'));
		}

		finish.value = item.variant_id;
	}

	const finishNote = card
		? (variants.length ? null : h('p', {class: 'muted'}, 'The catalog lists no separate finishes for this card.'))
		: h('p', {class: 'muted'}, 'Finishes show once the card has been opened with a connection.');

	const form = h('form', {class: 'card wl-editor', id: 'wishlist-editor'},
		h('h3', null, title),
		h('label', {for: 'wish-language'}, 'Language'),
		h('span', {class: 'select-wrap'}, language),
		h('label', {class: 'wl-label', for: 'wish-finish'}, 'Finish'),
		h('span', {class: 'select-wrap'}, finish),
		finishNote,
		h('span', {class: 'wl-label wl-label-block'}, 'Priority'),
		priority,
		h('label', {class: 'wl-label', for: 'wish-note'}, 'Note'),
		note,
		status,
		h('div', {class: 'wl-editor-actions'},
			save,
			h('button', {id: 'wish-cancel', onclick: onCancel, type: 'button'}, 'Cancel'),
			onRemove ? h('button', {class: 'wl-danger', id: 'wish-remove', onclick: onRemove, type: 'button'}, 'Remove from wishlist') : null
		)
	);

	form.addEventListener('submit', async (event) => {
		event.preventDefault();
		save.disabled = true;
		status.textContent = 'Saving.';

		try {
			await onSave({
				language: language.value || null,
				note: note.value,
				priority: (form.querySelector('input[name="wish-priority"]:checked') || {value: 'normal'}).value,
				variantId: finish.value || null,
			});
		}
		catch (err) {
			status.textContent = `Not saved. ${errorText(err)}`;
			save.disabled = false;
		}
	});

	return form;
}

// --------------------------------------------------------- the search

function searchPanel({onClose, onPick, wished}) {
	const codes = CATALOG_LANGUAGES.map((item) => item.code);
	const lang = readChoice(SEARCH_LANG_KEY, codes, viewingLanguage());
	// The language last searched in; with none kept, the one most of his
	// copies are in once they are read (suggest), else the viewing language.
	let chosen = readChoice(SEARCH_LANG_KEY, codes, null) !== null;
	const language = h('select', {'aria-label': 'Search in', id: 'wishlist-search-lang'},
		CATALOG_LANGUAGES.map((item) => h('option', {value: item.code}, item.label))
	);
	const input = h('input', {
		'aria-label': 'Card name or number',
		autocomplete: 'off',
		class: 'search',
		enterkeyhint: 'search',
		id: 'wishlist-search',
		placeholder: 'Name or number, e.g. Pinsir or 3/131',
		type: 'search',
	});
	const results = h('div', {class: 'card-grid wl-results', id: 'wishlist-results'});
	const status = h('p', {class: 'muted', id: 'wishlist-search-status', role: 'status'});
	let run = 0;

	language.value = lang;
	language.addEventListener('change', () => {
		chosen = true;
		saveChoice(SEARCH_LANG_KEY, language.value);
	});

	function tile(card) {
		const info = {name: card.name, number: card.localId, setName: card.setName};
		const on = wished(card);

		return cardTile({
			art: {info, src: cardImage(card.image, 'low'), status: on ? 'wanted' : null, statusLabel: on ? 'On your wishlist' : null},
			attrs: {'data-card': card.id},
			className: on ? 'wl-result wl-on' : 'wl-result',
			meta: [`#${card.localId}`, card.setName || card.setId].filter(Boolean).join(' · '),
			names: card.name,
			onclick: () => onPick(card),
			tag: 'button',
		});
	}

	let last = [];

	async function search() {
		const mine = ++run;
		const text = input.value;

		status.textContent = 'Searching.';
		results.replaceChildren();

		try {
			const {more, results: found} = await searchCards(text, language.value);

			if (mine !== run) {
				return;
			}

			last = found;
			status.textContent = found.length
				? `${plural(found.length, 'card', 'cards')}${more ? `, and ${formatCount(more)} more: add the number to narrow it` : ''}. Tap one to add it.`
				: `No ${languageLabel(language.value)} cards match "${text.trim()}".`;
			results.replaceChildren(...found.map(tile));
		}
		catch (err) {
			if (mine !== run) {
				return;
			}

			status.textContent = err instanceof SearchHint
				? err.message
				: navigator.onLine
					? `The catalog did not answer. Try again in a minute. (${errorText(err)})`
					: 'This search is not on this phone. Search again with a connection.';
		}
	}

	// The name first, the whole width, with ✕ closing the search; then the
	// language and Search (design review 2, 2026-11-20).
	const close = h('button', {'aria-label': 'Close search', class: 'wl-search-close', id: 'wishlist-search-close', onclick: () => onClose(), type: 'button'}, h('span', {'aria-hidden': 'true'}, '✕'));
	const form = h('form', {class: 'wl-search', id: 'wishlist-search-form', role: 'search'},
		h('div', {class: 'wl-search-input'}, input, close),
		h('div', {class: 'toolbar two wl-search-row'},
			h('span', {class: 'select-wrap'}, language),
			h('button', {class: 'primary', id: 'wishlist-search-go', type: 'submit'}, 'Search')
		)
	);

	form.addEventListener('submit', (event) => {
		event.preventDefault();
		input.blur();
		chosen = true;
		saveChoice(SEARCH_LANG_KEY, language.value);
		search();
	});

	return {
		element: h('section', {class: 'wl-add', id: 'wishlist-add-panel'}, form, status, results),
		focus: () => input.focus(),
		redraw: () => results.replaceChildren(...last.map(tile)),
		// The language most of his copies are in, while he has kept none.
		suggest(code) {
			if (!chosen && codes.includes(code)) {
				language.value = code;
			}
		},
	};
}

// --------------------------------------------------------- my wishlist

// The language most of the live copies are in, or null.
function mostLanguage(cards) {
	const counts = new Map();

	for (const entry of cards || []) {
		if (entry && !entry.deleted_at && entry.language) {
			counts.set(entry.language, (counts.get(entry.language) || 0) + 1);
		}
	}

	const [top] = [...counts].sort((a, b) => b[1] - a[1]);

	return top ? top[0] : null;
}

export function wishlistView(root) {
	let alive = true;
	let items = [];
	let gotItems = [];
	let cards = [];
	let editing = null;
	// The list has been read once (reload).
	let loaded = false;

	const viewing = viewingLanguage();
	const load = cardLoader();
	const summary = h('p', {class: 'muted', id: 'wishlist-summary'});
	const list = h('ul', {class: 'wl-list', id: 'wishlist-items'});
	// Got it: items a copy added since filled (js/wishlist.js got_at), to
	// clear or put back to wanted.
	const gotList = h('ul', {class: 'wl-list', id: 'wishlist-got-items'});
	const gotSection = h('section', {'aria-labelledby': 'wishlist-got-title', hidden: true, id: 'wishlist-got'},
		h('h3', {id: 'wishlist-got-title'}, 'Got it'),
		gotList
	);
	const flash = h('p', {class: 'wl-flash', id: 'wishlist-flash', role: 'status'});
	const editorSlot = h('div');
	const addButton = h('button', {class: 'primary', id: 'wishlist-add', type: 'button'}, 'Add a card');
	const empty = h('div', {class: 'card empty-state', hidden: true, id: 'wishlist-empty'},
		h('p', {class: 'big'}, 'Your wishlist is empty.'),
		h('p', {class: 'muted'}, 'Add the cards you are hunting for. Your family can see the list and spot a spare they hold.')
	);

	const wishedKey = (cardId, catalog) => `${catalog}|${cardId}`;
	let wishedSet = new Set();

	const addRow = h('div', {class: 'wl-add-row'}, addButton);
	// Open, the search takes Add a card's place, and its ✕ gives it back.
	const showSearch = (open) => {
		panel.element.hidden = !open;
		addRow.hidden = open;
	};
	const panel = searchPanel({
		onClose: () => {
			showSearch(false);
			addButton.focus();
		},
		onPick: (card) => openNew(card),
		wished: (card) => wishedSet.has(wishedKey(card.id, card.catalog)),
	});

	panel.element.hidden = true;

	addButton.addEventListener('click', () => {
		showSearch(true);
		closeEditor();
		panel.focus();
	});

	function say(text) {
		flash.textContent = text;
	}

	function closeEditor() {
		editing = null;
		editorSlot.replaceChildren();
	}

	async function openNew(result) {
		const catalog = result.catalog || catalogFor(result.lang);
		const found = await cardRecord(result.id, result.lang, catalog).catch(() => null);

		if (!alive) {
			return;
		}

		editing = {cardId: result.id};
		editorSlot.replaceChildren(editor({
			card: found && found.card,
			catalog,
			onCancel: closeEditor,
			onSave: async (fields) => {
				await addToWishlist(result.id, {...fields, catalog});
				closeEditor();
				say(`Added ${result.name} to your wishlist.`);
			},
			title: `Add ${result.name}${result.setName ? `, ${result.setName}` : ''} #${result.localId}`,
		}));
		editorSlot.scrollIntoView({block: 'start'});
	}

	async function openEdit(item) {
		const found = await load(item, viewing);

		if (!alive) {
			return;
		}

		const info = cardInfo(item, found);

		showSearch(false);
		editing = {id: item.id};
		editorSlot.replaceChildren(editor({
			card: found && found.card,
			catalog: item.catalog || 'international',
			item,
			onCancel: closeEditor,
			onRemove: () => remove(item, info.name),
			onSave: async (fields) => {
				await updateWish(item.id, fields);
				closeEditor();
				say(`Saved ${info.name}.`);
			},
			title: `Edit ${info.name}`,
		}));
		editorSlot.scrollIntoView({block: 'start'});
	}

	async function remove(item, name) {
		try {
			await removeWish(item.id);
			closeEditor();
			say(`Removed ${name} from your wishlist.`);
		}
		catch (err) {
			say(`Not removed. ${errorText(err)}`);
		}
	}

	async function gotChange(change, text) {
		try {
			await change();
			say(text);
		}
		catch (err) {
			say(`Not changed. ${errorText(err)}`);
		}
	}

	function drawGot() {
		gotSection.hidden = !gotItems.length;
		gotList.replaceChildren(...gotItems.map((item) => {
			const row = h('li', {class: 'wl-item wl-loading', 'data-id': item.id});

			load(item, viewing).then((found) => {
				if (!alive) {
					return;
				}

				const info = cardInfo(item, found);

				row.replaceWith(itemRow(item, found, {
					got: {
						onBack: () => gotChange(() => wantAgain(item.id), `${info.name} is wanted again.`),
						onClear: () => gotChange(() => removeWish(item.id), `Cleared ${info.name}.`),
					},
					viewing,
				}));
			});

			return row;
		}));
	}

	function draw() {
		wishedSet = new Set(items.map((item) => wishedKey(item.card_id, item.catalog || 'international')));
		panel.redraw();
		drawGot();

		const haveNow = items.filter((item) => ownedCopies(item, cards).length).length;

		empty.hidden = items.length > 0 || gotItems.length > 0;
		summary.hidden = !items.length;
		summary.textContent = `${plural(items.length, 'card', 'cards')} wanted.${haveNow ? ` You have ${formatCount(haveNow)} of them now.` : ''}`;

		list.replaceChildren(...items.map((item) => {
			const row = h('li', {class: 'wl-item wl-loading', 'data-id': item.id});

			load(item, viewing).then((found) => {
				if (!alive) {
					return;
				}

				const owned = ownedCopies(item, cards).length;
				const info = cardInfo(item, found);

				row.replaceWith(itemRow(item, found, {
					mine: true,
					onEdit: () => openEdit(item),
					onRemove: () => remove(item, info.name),
					owned,
					viewing,
				}));
			});

			return row;
		}));
		offerCardList(items.map((item) => itemRoute(item, viewing)), 'Wishlist');
	}

	async function reload() {
		try {
			[items, gotItems, cards] = await Promise.all([listWishlist(), listGotWishes(), listCards()]);
			loaded = true;
		}
		catch (err) {
			list.replaceChildren(h('li', {class: 'notice', role: 'alert'}, `Your wishlist could not be read from this phone. ${errorText(err)}`));

			return;
		}

		if (!alive) {
			return;
		}

		panel.suggest(mostLanguage(cards));

		if (editing && editing.id && !items.some((item) => item.id === editing.id)) {
			closeEditor();
		}

		draw();
	}

	const stop = onChange(() => alive && reload());
	// A twin found, or the twins on the phone read after the first draw:
	// the art of the rows of those cards, once a frame, from what they were
	// drawn with, and only once the list is read (an empty list before then
	// would say "Your wishlist is empty."). A new photo or pin is a save,
	// which reloads the list.
	const stopImages = onImagesChange((changed) => alive && loaded && redrawArt([list, gotList], changed), {frame: true, records: false});

	root.append(
		heading('Wishlist', null),
		summary,
		addRow,
		panel.element,
		editorSlot,
		flash,
		empty,
		list,
		gotSection
	);
	reload();

	// Keep the family's wishlists on the phone for the scanner and for
	// opening theirs offline.
	if (currentUser() && navigator.onLine) {
		refreshFamilyWishlists().catch(() => {});
	}

	return () => {
		alive = false;
		stop();
		stopImages();
	};
}

// ---------------------------------------------------- a family member's

const savedAt = (at) => new Date(at).toLocaleString('en-US', {dateStyle: 'medium', timeStyle: 'short'});

export function familyWishlistView(root, {userId}) {
	let alive = true;

	const viewing = viewingLanguage();
	const load = cardLoader();
	// Their photos on the rows' art, from the photo index the family
	// shares: their wishlist is read alone, never their whole document, so
	// their pin is not known here.
	const records = (target) => sharedRecordsFor(userId, target);
	const note = h('p', {class: 'muted', hidden: true, id: 'wishlist-saved-note'});
	const summary = h('p', {class: 'muted', id: 'wishlist-summary'});
	const list = h('ul', {class: 'wl-list', id: 'wishlist-items'});
	const ideas = link(`family/${encodeURIComponent(userId)}/ideas`, {class: 'button small', id: 'wishlist-ideas'}, 'Trade ideas');
	const body = h('div', null, note, summary, ideas, list);
	const head = heading('Wishlist', userId);

	function name(text) {
		head.querySelector('h2').textContent = `${text}'s wishlist`;
		document.title = `${text}'s wishlist | Card Tracker`;
	}

	name('Family member');

	async function show() {
		if (!currentUser()) {
			body.replaceChildren(h('div', {class: 'notice', role: 'alert'}, h('p', null, 'Sign in to see your family\'s wishlists.')));

			return;
		}

		let result;
		let cards;

		try {
			[result, cards] = await Promise.all([memberWishlist(userId), listCards()]);
		}
		catch (err) {
			body.replaceChildren(h('div', {class: 'notice', role: 'alert'}, h('p', null, `This wishlist could not be read. ${errorText(err)}`)));

			return;
		}

		if (!alive) {
			return;
		}

		const {at, fromCache, member} = result;

		if (!member) {
			body.replaceChildren(h('div', {class: 'notice', role: 'alert'}, h('p', null, navigator.onLine
				? 'This person is not in your family group.'
				: 'This wishlist is not on this phone yet. Open it once with a connection, and it opens offline after that.')));

			return;
		}

		name(member.name);

		if (fromCache && at) {
			note.hidden = false;
			note.textContent = `Saved on this phone ${savedAt(at)}. Connect to see changes since.`;
		}

		const items = member.wishlist;

		if (!items.length) {
			summary.hidden = true;
			list.replaceChildren(h('li', {class: 'card empty-state'}, h('p', {class: 'big'}, `${member.name}'s wishlist is empty.`)));

			return;
		}

		const withSpares = items.filter((item) => sparesFor(item, cards) > 0).length;

		summary.textContent = `${plural(items.length, 'card', 'cards')} wanted.${withSpares ? ` You have spares of ${formatCount(withSpares)}.` : ''}`;
		list.replaceChildren(...items.map((item) => {
			const row = h('li', {class: 'wl-item wl-loading', 'data-id': item.id});

			load(item, viewing).then((found) => {
				if (alive) {
					row.replaceWith(itemRow(item, found, {records, spares: sparesFor(item, cards), viewing}));
				}
			});

			return row;
		}));
		offerCardList(items.map((item) => itemRoute(item, viewing)), `${member.name}'s wishlist`);
	}

	// Their list does not change while it is open, but the viewer's own
	// spares do. A twin answer, or the family's photo lists read again,
	// draws the art of the rows it concerns again, once a frame, from what
	// was read: never their wishlist again.
	const stop = onChange(() => alive && show());
	const redraw = (changed) => alive && redrawArt([list], changed);
	const stopImages = onImagesChange(redraw, {frame: true, records: false});
	const stopShared = onFamilyPhotosChange(() => redraw(null));

	root.append(head, body);
	show();

	return () => {
		alive = false;
		stop();
		stopImages();
		stopShared();
	};
}

// ------------------------------------------------------ trade ideas

// "You have 1 spare · Near Mint": how many spares fit, and their conditions.
function sparesLine(who, copies) {
	const conditions = [...new Set(copies.map((entry) => entry.condition).filter(Boolean))];
	const n = copies.length;

	return [`${who} ${formatCount(n)} ${n === 1 ? 'spare' : 'spares'}`, ...conditions].join(' · ');
}

// Trade ideas with a family member (Eric, 2026-11-23; DESIGN.md section 6,
// "Trade Ideas"): your spares their wishlist wants, and their spares your
// wishlist wants (js/wishlist.js tradeIdeas), each row a wish with the
// spares that fit it. Their wishlist comes from the phone when offline, as
// their wishlist screen does; their spares need their cards, read only
// online. Log a trade opens the trades form with both sides filled: one
// spare of yours for each of their wishes, one of theirs for each of yours,
// and their name, to trim and save there.
export function tradeIdeasView(root, {userId}) {
	let alive = true;

	const viewing = viewingLanguage();
	const load = cardLoader();
	const theirRecords = (target) => sharedRecordsFor(userId, target);
	const title = h('h2', {id: 'ideas-title'}, 'Trade ideas');
	const note = h('p', {class: 'muted', hidden: true, id: 'ideas-saved-note'});
	const summary = h('p', {class: 'muted', id: 'ideas-summary'});
	const giveTitle = h('h3', {class: 'ideas-section', id: 'ideas-give-title'});
	const give = h('ul', {class: 'wl-list', id: 'ideas-give'});
	const getTitle = h('h3', {class: 'ideas-section', id: 'ideas-get-title'});
	const getNote = h('p', {class: 'muted', hidden: true, id: 'ideas-get-note'});
	const get = h('ul', {class: 'wl-list', id: 'ideas-get'});
	const logButton = h('button', {class: 'primary', hidden: true, id: 'ideas-log', type: 'button'}, 'Log a trade');
	const body = h('div', {id: 'trade-ideas'}, note, summary, giveTitle, give, getTitle, getNote, get, logButton);
	const head = h('div', {class: 'view-head'}, title);
	let handoff = null;

	function rows(list, ideas, line, records) {
		list.replaceChildren(...ideas.map(({copies, item}) => {
			const row = h('li', {class: 'wl-item wl-loading', 'data-id': item.id});

			load(item, viewing).then((found) => {
				if (alive) {
					row.replaceWith(itemRow(item, found, {line: line(copies), records, viewing}));
				}
			});

			return row;
		}));
	}

	// What the trades form opens with: their name, a spare of yours for each
	// of their wishes (never one copy twice), and one of theirs for each of
	// yours, as the copies you would add.
	async function handoffFor(name, giving, getting) {
		const out = [...new Set(giving.map(({copies}) => copies[0].id))];
		const ins = await Promise.all(getting.map(async ({copies}) => {
			const copy = copies[0];
			const found = await load(copy, viewing);
			const info = cardInfo(copy, found);

			return {
				fields: {
					card_id: copy.card_id,
					catalog: copy.catalog || 'international',
					condition: copy.condition || null,
					language: copy.language || null,
					language_source: 'manual',
					variant_id: copy.variant_id || null,
				},
				info: {image: info.image, name: info.name, number: info.number, setName: info.setName},
				n: 1,
			};
		}));

		return {in: ins, kind: 'traded', out, who: name};
	}

	logButton.addEventListener('click', () => {
		if (handoff) {
			setPendingMove(handoff);
			go('trades/new');
		}
	});

	async function show() {
		if (!currentUser()) {
			body.replaceChildren(h('div', {class: 'notice', role: 'alert'}, h('p', null, 'Sign in to see trade ideas with your family.')));

			return;
		}

		let result;
		let mine;
		let wishes;

		try {
			[result, mine, wishes] = await Promise.all([memberWishlist(userId), listCards(), listWishlist()]);
		}
		catch (err) {
			body.replaceChildren(h('div', {class: 'notice', role: 'alert'}, h('p', null, `The trade ideas could not be worked out. ${errorText(err)}`)));

			return;
		}

		if (!alive) {
			return;
		}

		const {at, fromCache, member} = result;

		if (!member) {
			body.replaceChildren(h('div', {class: 'notice', role: 'alert'}, h('p', null, navigator.onLine
				? 'This person is not in your family group.'
				: 'Their wishlist is not on this phone yet. Open it once with a connection, and it opens offline after that.')));

			return;
		}

		const name = member.name;

		title.textContent = `Trade ideas with ${name}`;
		document.title = `Trade ideas with ${name} | Card Tracker`;
		note.hidden = !(fromCache && at);
		note.textContent = fromCache && at ? `${name}'s wishlist as saved on this phone ${savedAt(at)}. Connect to see changes since.` : '';

		const giving = tradeIdeas(member.wishlist, mine);
		let getting = [];
		let theirs = null;

		try {
			theirs = await memberCards(userId);
			getting = tradeIdeas(wishes, theirs);
		}
		catch (err) {
			getNote.hidden = false;
			getNote.textContent = (err && err.message) || `${name}'s spares show when you are online.`;
		}

		if (!alive) {
			return;
		}

		if (theirs) {
			getNote.hidden = getting.length > 0;
			getNote.textContent = getting.length ? '' : `None of ${name}'s spares are on your wishlist.`;
		}

		giveTitle.textContent = `Your spares ${name} wants (${formatCount(giving.length)})`;
		getTitle.textContent = `${name}'s spares you want${theirs ? ` (${formatCount(getting.length)})` : ''}`;
		summary.textContent = giving.length || getting.length
			? 'Each row is a card on a wishlist, with the spares that fit it. A spare is a copy beyond the first of the same card in the same language.'
			: `Nothing to trade with ${name} yet: none of your spares are on their wishlist${theirs ? ', and none of theirs are on yours' : ''}.`;

		rows(give, giving, (copies) => sparesLine('You have', copies), theirRecords);
		rows(get, getting, (copies) => sparesLine(`${name} has`, copies), null);

		if (!giving.length) {
			give.replaceChildren(h('li', {class: 'muted ideas-none'}, `None of your spares are on ${name}'s wishlist.`));
		}

		handoff = giving.length || getting.length ? await handoffFor(name, giving, getting) : null;

		if (alive) {
			logButton.hidden = !handoff;
			logButton.textContent = `Log a trade with ${name}`;
		}
	}

	// Your own cards and wishlist can change while it is open (a trade logged,
	// a wish added); theirs are read again on the next visit.
	const stop = onChange(() => alive && show());
	const redraw = (changed) => alive && redrawArt([give, get], changed);
	const stopImages = onImagesChange(redraw, {frame: true, records: false});
	const stopShared = onFamilyPhotosChange(() => redraw(null));

	root.append(head, body);
	show();

	return () => {
		alive = false;
		stop();
		stopImages();
		stopShared();
	};
}

// ----------------------------------------------------------- routes

export const WISHLIST_ROUTES = [
	{kind: 'wishlist', pattern: /^wishlist$/, render: wishlistView, tab: 'lists', title: 'Wishlist | Card Tracker'},
	{keys: ['userId'], kind: 'wishlist', pattern: /^wishlist\/([^/]+)$/, render: familyWishlistView, tab: 'lists', title: 'Family wishlist | Card Tracker'},
	{keys: ['userId'], pattern: /^family\/([^/]+)\/ideas$/, render: tradeIdeasView, tab: 'cards', title: 'Trade ideas | Card Tracker'},
];

export const WISHLIST_ACCOUNT_VIEWS = [wishlistView, familyWishlistView, tradeIdeasView];
