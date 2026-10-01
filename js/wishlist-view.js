// Wishlist screens (js/wishlist.js). Two routes, under the app's base:
//   wishlist            the person's own wishlist: add, edit, remove
//   wishlist/<userId>   a family member's wishlist, read only, with the
//                       viewer's spares of each item
//
// WISHLIST_ROUTES is shaped like app.js's ROUTES, and WISHLIST_ACCOUNT_VIEWS
// lists the views to redraw on sign-in and sign-out (app.js ACCOUNT_ROUTES).

import {memberName} from './account-views.js';
import {currentUser} from './auth.js';
import {LANGUAGES, cardImage, catalogFor, languageLabel, viewingLanguage} from './catalog.js';
import {cardArt} from './catalog-views.js';
import {languageChip} from './cards-view.js';
import {listCards, onChange} from './collection.js';
import {BASE, errorText, go, h} from './dom.js';
import {familyOverview} from './sync.js';
import {
	NOTE_MAX,
	PRIORITIES,
	PRIORITY_LABELS,
	SearchHint,
	addToWishlist,
	cachedFamilyWishlists,
	cardRecord,
	displayLanguage,
	languagesFor,
	listWishlist,
	memberWishlist,
	ownedCopies,
	refreshFamilyWishlists,
	removeWish,
	searchCards,
	sparesFor,
	updateWish,
	variantLabel,
} from './wishlist.js';

const formatCount = (n) => Number(n).toLocaleString('en-US');

const plural = (n, one, many) => `${formatCount(n)} ${n === 1 ? one : many}`;

const link = (route, attrs, ...children) => h('a', {...attrs, 'data-link': route, href: BASE + route}, ...children);

const SEARCH_LANG_KEY = 'cardTracker.wishlistSearchLanguage';

function readChoice(key, allowed, fallback) {
	try {
		const saved = localStorage.getItem(key);

		return allowed.includes(saved) ? saved : fallback;
	}
	catch {
		return fallback;
	}
}

function saveChoice(key, value) {
	try {
		localStorage.setItem(key, value);
	}
	catch {
		// The choice lasts for this visit only.
	}
}

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

function finishText(item, info) {
	if (!item.variant_id) {
		return null;
	}

	const variant = (info.variants || []).find((entry) => entry.variantId === item.variant_id);

	return variant ? variantLabel(variant) : 'A chosen finish';
}

// ------------------------------------------------------ one item row

function itemRow(item, found, {mine = false, onEdit = null, onRemove = null, owned = 0, spares = 0} = {}) {
	const info = cardInfo(item, found);
	const finish = finishText(item, info);
	const chips = h('div', {class: 'wl-chips'},
		h('span', {class: `wl-priority wl-priority-${item.priority || 'normal'}`}, `${PRIORITY_LABELS[item.priority] || 'Normal'} priority`),
		item.language
			? h('span', {'aria-label': `Printed in ${languageLabel(item.language)}`, class: 'wl-chip'}, languageChip(item.language))
			: h('span', {class: 'wl-chip wl-chip-any'}, 'Any language'),
		h('span', {class: finish ? 'wl-chip' : 'wl-chip wl-chip-any'}, finish || 'Any finish')
	);
	const body = h('div', {class: 'wl-body'},
		h('span', {class: 'wl-name'}, info.name),
		h('span', {class: 'wl-meta'}, [numberText(info), info.setName].filter(Boolean).join(' · ') || item.card_id),
		chips,
		item.note ? h('p', {class: 'wl-note'}, item.note) : null
	);

	if (mine && owned) {
		body.append(h('div', {class: 'wl-owned', role: 'status'},
			h('span', null, owned > 1 ? `You have this now (${formatCount(owned)} copies)` : 'You have this now'),
			h('button', {'aria-label': `Remove ${info.name} from the wishlist`, class: 'wl-owned-remove', onclick: onRemove, type: 'button'}, 'Remove')
		));
	}

	if (!mine && spares) {
		body.append(h('p', {class: 'wl-spare'}, `You have ${formatCount(spares)} spare`));
	}

	if (mine) {
		body.append(h('button', {'aria-label': `Edit ${info.name}`, class: 'wl-edit', onclick: onEdit, type: 'button'}, 'Edit'));
	}

	return h('li', {class: owned && mine ? 'wl-item wl-has' : 'wl-item', 'data-id': item.id},
		h('div', {class: 'wl-art'}, cardArt(info, info.image)),
		body
	);
}

// --------------------------------------------------- whose wishlist

// "My wishlist" and each other member of the family group. Offline, the
// members saved with their wishlists stand in for the server's list.
function familySwitcher(selectedId) {
	const select = h('select', {'aria-label': 'Whose wishlist', id: 'wishlist-family-switcher'});
	const wrap = h('span', {class: 'select-wrap family-switch', hidden: true}, select);

	select.addEventListener('change', () => go(select.value ? `wishlist/${encodeURIComponent(select.value)}` : 'wishlist'));

	const fill = (others) => {
		if (!others.length) {
			return;
		}

		select.replaceChildren(
			h('option', {value: ''}, 'My wishlist'),
			...others.map((member) => h('option', {value: member.user_id}, `${member.name}'s wishlist`))
		);
		select.value = selectedId || '';
		wrap.hidden = false;
	};

	const fromCache = () => cachedFamilyWishlists().then(({members}) => fill(members)).catch(() => {});

	if (!navigator.onLine) {
		fromCache();

		return wrap;
	}

	familyOverview().then((overview) => {
		const me = currentUser();

		fill(((overview && overview.members) || [])
			.filter((member) => !me || member.user_id !== me.id)
			.map((member) => ({name: memberName(member), user_id: member.user_id})));
	}).catch(fromCache);

	return wrap;
}

function heading(text, memberId) {
	const head = h('div', {class: 'view-head'}, h('h2', {id: 'wishlist-title'}, text));

	if (currentUser()) {
		head.append(familySwitcher(memberId));
	}

	return head;
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

function searchPanel({onPick, wished}) {
	const lang = readChoice(SEARCH_LANG_KEY, LANGUAGES.map((item) => item.code), viewingLanguage());
	const language = h('select', {'aria-label': 'Search in', id: 'wishlist-search-lang'},
		LANGUAGES.map((item) => h('option', {value: item.code}, item.label))
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
	language.addEventListener('change', () => saveChoice(SEARCH_LANG_KEY, language.value));

	function tile(card) {
		const info = {name: card.name, number: card.localId, setName: card.setName};
		const on = wished(card);

		return h('button', {class: on ? 'tile wl-result wl-on' : 'tile wl-result', 'data-card': card.id, onclick: () => onPick(card), type: 'button'},
			h('div', {class: 'art-wrap'}, cardArt(info, cardImage(card.image, 'low')),
				on ? h('span', {class: 'badge wl-badge-on'}, 'Wanted') : null),
			h('span', {class: 'tile-name'}, card.name),
			h('span', {class: 'tile-meta'}, [`#${card.localId}`, card.setName || card.setId].filter(Boolean).join(' · '))
		);
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

	const form = h('form', {class: 'wl-search', id: 'wishlist-search-form', role: 'search'},
		h('div', {class: 'toolbar two wl-search-row'},
			h('span', {class: 'select-wrap'}, language),
			h('button', {class: 'primary', id: 'wishlist-search-go', type: 'submit'}, 'Search')
		),
		input
	);

	form.addEventListener('submit', (event) => {
		event.preventDefault();
		input.blur();
		search();
	});

	return {
		element: h('section', {class: 'wl-add', id: 'wishlist-add-panel'}, form, status, results),
		focus: () => input.focus(),
		redraw: () => results.replaceChildren(...last.map(tile)),
	};
}

// --------------------------------------------------------- my wishlist

export function wishlistView(root) {
	let alive = true;
	let items = [];
	let cards = [];
	let editing = null;

	const viewing = viewingLanguage();
	const load = cardLoader();
	const summary = h('p', {class: 'muted', id: 'wishlist-summary'});
	const list = h('ul', {class: 'wl-list', id: 'wishlist-items'});
	const flash = h('p', {class: 'wl-flash', id: 'wishlist-flash', role: 'status'});
	const editorSlot = h('div');
	const addButton = h('button', {class: 'primary', id: 'wishlist-add', type: 'button'}, 'Add a card');
	const empty = h('div', {class: 'card empty-state', hidden: true, id: 'wishlist-empty'},
		h('p', {class: 'big'}, 'Your wishlist is empty.'),
		h('p', {class: 'muted'}, 'Add the cards you are hunting for. Your family can see the list and spot a spare they hold.')
	);

	const wishedKey = (cardId, catalog) => `${catalog}|${cardId}`;
	let wishedSet = new Set();

	const panel = searchPanel({
		onPick: (card) => openNew(card),
		wished: (card) => wishedSet.has(wishedKey(card.id, card.catalog)),
	});

	panel.element.hidden = true;

	addButton.addEventListener('click', () => {
		const opening = panel.element.hidden;

		panel.element.hidden = !opening;
		addButton.textContent = opening ? 'Close search' : 'Add a card';
		closeEditor();

		if (opening) {
			panel.focus();
		}
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

		panel.element.hidden = true;
		addButton.textContent = 'Add a card';
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

	function draw() {
		wishedSet = new Set(items.map((item) => wishedKey(item.card_id, item.catalog || 'international')));
		panel.redraw();

		const haveNow = items.filter((item) => ownedCopies(item, cards).length).length;

		empty.hidden = items.length > 0;
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
				}));
			});

			return row;
		}));
	}

	async function reload() {
		try {
			[items, cards] = await Promise.all([listWishlist(), listCards()]);
		}
		catch (err) {
			list.replaceChildren(h('li', {class: 'notice', role: 'alert'}, `Your wishlist could not be read from this phone. ${errorText(err)}`));

			return;
		}

		if (!alive) {
			return;
		}

		if (editing && editing.id && !items.some((item) => item.id === editing.id)) {
			closeEditor();
		}

		draw();
	}

	const stop = onChange(() => alive && reload());

	root.append(
		heading('Wishlist', null),
		summary,
		h('div', {class: 'wl-add-row'}, addButton),
		panel.element,
		editorSlot,
		flash,
		empty,
		list
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
	};
}

// ---------------------------------------------------- a family member's

const savedAt = (at) => new Date(at).toLocaleString('en-US', {dateStyle: 'medium', timeStyle: 'short'});

export function familyWishlistView(root, {userId}) {
	let alive = true;

	const viewing = viewingLanguage();
	const load = cardLoader();
	const banner = h('div', {class: 'view-only', role: 'status'});
	const note = h('p', {class: 'muted', hidden: true, id: 'wishlist-saved-note'});
	const summary = h('p', {class: 'muted', id: 'wishlist-summary'});
	const list = h('ul', {class: 'wl-list', id: 'wishlist-items'});
	const body = h('div', null, note, summary, list);
	const head = heading('Wishlist', userId);

	function name(text) {
		banner.replaceChildren(h('span', null, `${text}'s wishlist, view only`), link('wishlist', null, 'Back to mine'));
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
					row.replaceWith(itemRow(item, found, {spares: sparesFor(item, cards)}));
				}
			});

			return row;
		}));
	}

	// Their list does not change while it is open, but the viewer's own
	// spares do.
	const stop = onChange(() => alive && show());

	root.append(banner, head, body);
	show();

	return () => {
		alive = false;
		stop();
	};
}

// ----------------------------------------------------------- routes

export const WISHLIST_ROUTES = [
	{pattern: /^wishlist$/, render: wishlistView, tab: 'wishlist', title: 'Wishlist | Card Tracker'},
	{keys: ['userId'], pattern: /^wishlist\/([^/]+)$/, render: familyWishlistView, tab: 'wishlist', title: 'Family wishlist | Card Tracker'},
];

export const WISHLIST_ACCOUNT_VIEWS = [wishlistView, familyWishlistView];
