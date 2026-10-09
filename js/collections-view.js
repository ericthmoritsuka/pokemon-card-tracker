// Collection screens (js/collections.js). Routes, under the app's base:
//   collections                          your collections, each with its count and value
//   collections/<id>                     one collection: its cards, with the shared filter bar and Value sheet
//   family/<userId>/collections          a family member's collections, read only
//   family/<userId>/collections/<id>     one of theirs, read only
//
// Collections are the third half of the Lists tab (dom.js listsSwitch). A
// collection screen is My Cards' own (js/cards-view.js cardsScreen) over the
// cards the collection holds, as the Trade screen is over the spares.
//
// COLLECTIONS_ROUTES is shaped like app.js's ROUTES, and
// COLLECTIONS_ACCOUNT_VIEWS lists the views to redraw on sign-in and sign-out
// (app.js ACCOUNT_ROUTES). openCollectionsSheet is the "Add to collection"
// sheet card detail opens.

import {currentUser} from './auth.js';
import {cardImage, cardIndex, catalogLanguage, indexKey, languageLabel, savedCardRecords} from './catalog.js';
import {cardsScreen} from './cards-view.js';
import {
	NAME_MAX,
	RULE_FIELDS,
	STAR_RARITIES,
	addToCollection,
	cleanRule,
	collectionEntries,
	createCollection,
	byName,
	fillDetails,
	isMember,
	itemFor,
	leaveOut,
	leftOut,
	loadCollections,
	putBack,
	removeCollection,
	removeFromCollection,
	reorderCollections,
	restoreCollection,
	ruleMatches,
	ruleText,
	sortCollections,
	updateCollection,
} from './collections.js';
import {isLive, onChange, sourceNames} from './collection.js';
import {BASE, errorText, go, h, listsSwitch} from './dom.js';
import {memberDocumentKept, whenMemberName} from './family.js';
import {REGION_OPTIONS, filterOptions} from './filter-bar.js';
import {formatCount, plural} from './format.js';
import {formatBrl, listStats, savedRates} from './prices.js';
import {UNDO_MS, orderSection} from './reorder.js';
import {toast} from './shell.js';

const routeTo = (...parts) => parts.map((part) => encodeURIComponent(part)).join('/');

const collectionsRoute = (userId) => (userId ? `family/${routeTo(userId)}/collections` : 'collections');

const collectionRoute = (userId, id) => `${collectionsRoute(userId)}/${routeTo(id)}`;

const kindText = (collection) => (collection.kind === 'rule' ? 'Fills itself' : 'Hand-picked');

// ---------------------------------------------------------- readable rules

// Names for the stored values of a rule: sets, languages, regions.
function ruleLabels(options) {
	const labels = {language: {}, region: {}, set: {}};

	for (const kind of ['language', 'region', 'set']) {
		for (const option of (options && options[kind]) || []) {
			labels[kind][option.value] = option.label;
		}
	}

	for (const region of REGION_OPTIONS) {
		labels.region[region.id] = labels.region[region.id] || region.label;
	}

	return labels;
}

const itemsOf = (cards, index) => (cards || []).filter(isLive).map((entry) => itemFor(entry, index.get(`${entry.catalog || 'international'}|${entry.card_id}`)));

// ----------------------------------------------------------------- value

const valueText = (stats) => {
	if (!stats.count) {
		return null;
	}

	if (!stats.priced) {
		return 'No prices yet';
	}

	return stats.unknown.count ? `${formatBrl(stats.total)}, partly priced` : formatBrl(stats.total);
};

// ------------------------------------------------------------- the editor

// A rule's choices and its preview read card details this phone may not have
// saved yet, so the editor waits a moment for them (and goes on without them
// when the network is slow or away).
const DETAILS_WAIT_MS = 2000;

async function withDetails(data) {
	const wait = new Promise((resolve) => setTimeout(() => resolve(null), DETAILS_WAIT_MS));
	const next = await Promise.race([fillDetails(data.cards, data.index).catch(() => null), wait]);

	return next ? {...data, index: next} : data;
}

// A checkbox group for one rule field: a closed list that says how many are
// chosen, with a search box when it is long (sets).
function choiceGroup({kind, label, onChange: changed, options, selected}) {
	const known = new Set(options.map((option) => option.value));
	const all = [...options, ...[...selected].filter((value) => !known.has(value)).map((value) => ({count: 0, label: value, value}))];
	const summary = h('summary', {class: 'col-group-summary'});
	const list = h('div', {class: 'col-options'});
	const search = all.length > 12 ? h('input', {'aria-label': `Find a ${label.toLowerCase()}`, autocomplete: 'off', class: 'search col-find', placeholder: `Find a ${label.toLowerCase()}`, type: 'search'}) : null;
	const rows = all.map((option) => {
		const box = h('input', {'data-kind': kind, id: `col-${kind}-${all.indexOf(option)}`, type: 'checkbox', value: option.value});

		box.checked = selected.has(option.value);
		box.addEventListener('change', () => {
			if (box.checked) {
				selected.add(option.value);
			}
			else {
				selected.delete(option.value);
			}

			draw();
			changed();
		});

		return {box, option, row: h('div', {class: 'fb-check'}, box, h('label', {for: box.id}, option.count ? `${option.label} (${formatCount(option.count)})` : option.label))};
	});

	function draw() {
		summary.textContent = `${label}${selected.size ? ` (${selected.size} chosen)` : ''}`;

		for (const item of rows) {
			item.box.checked = selected.has(item.option.value);
		}
	}

	if (search) {
		search.addEventListener('input', () => {
			const needle = search.value.trim().toLowerCase();

			for (const item of rows) {
				item.row.hidden = Boolean(needle) && !item.option.label.toLowerCase().includes(needle);
			}
		});
	}

	list.append(...(search ? [search] : []), ...rows.map((item) => item.row));

	if (!all.length) {
		list.append(h('p', {class: 'muted col-none'}, `None of your cards has a ${label.toLowerCase()} yet.`));
	}

	draw();

	const element = h('details', {class: 'col-group', id: `col-group-${kind}`}, summary, list);

	// Chosen ones open the list, so a saved rule shows what it holds.
	element.open = selected.size > 0 && selected.size <= 6;

	return {draw, element};
}

// The sheet to make a collection or change one. collection null makes one;
// cards and index are your cards and the card index, for the rule's choices.
// onSaved(entry) runs after a save, onDeleted(entry) after a delete.
export function openCollectionEditor({cards, collection = null, index, onDeleted = null, onSaved = null}) {
	const editing = Boolean(collection);
	const id = 'collection-editor';
	const opener = document.activeElement;
	const options = filterOptions(itemsOf(cards, index));
	const labels = ruleLabels(options);
	const items = itemsOf(cards, index);
	const rule = (collection && collection.rule) || {};
	const chosen = Object.fromEntries(RULE_FIELDS.map((kind) => [kind, new Set(Array.isArray(rule[kind]) ? rule[kind] : [])]));
	let kind = collection ? collection.kind : 'hand';
	let favorite = rule.favorite === true;
	const dex = rule.dex || null;
	const error = h('p', {class: 'notice col-error', hidden: true, id: 'col-error', role: 'alert'});
	const preview = h('p', {class: 'muted', id: 'col-preview', role: 'status'});
	const name = h('input', {autocomplete: 'off', class: 'search', id: 'col-name', maxlength: NAME_MAX, placeholder: 'Star cards, Binder 1, Trade bait', type: 'text', value: collection ? collection.name : ''});
	const ruleNow = () => ({...Object.fromEntries(RULE_FIELDS.map((field) => [field, [...chosen[field]]])), dex, favorite});

	const favoriteBox = h('input', {id: 'col-favorite', type: 'checkbox'});

	favoriteBox.checked = favorite;
	favoriteBox.addEventListener('change', () => {
		favorite = favoriteBox.checked;
		drawPreview();
	});

	const groups = RULE_FIELDS.map((field) => {
		const text = {language: 'Language', rarity: 'Rarity', region: 'Region', set: 'Set', type: 'Type'}[field];
		const found = field === 'region' ? REGION_OPTIONS.map((region) => ({count: 0, label: region.label, value: region.id})) : options[field];

		return choiceGroup({kind: field, label: text, onChange: drawPreview, options: found, selected: chosen[field]});
	});

	const star = h('button', {class: 'small', id: 'col-star', onclick: () => {
		for (const rarity of STAR_RARITIES) {
			chosen.rarity.add(rarity);
		}

		const group = groups[RULE_FIELDS.indexOf('rarity')];

		group.element.open = true;
		rebuildRarity();
		drawPreview();
	}, type: 'button'}, 'Star: every illustration rare');

	// The rarity group is built once, so the Star button redraws its list by
	// replacing it with one that reads the new choice.
	function rebuildRarity() {
		const at = RULE_FIELDS.indexOf('rarity');
		const next = choiceGroup({kind: 'rarity', label: 'Rarity', onChange: drawPreview, options: options.rarity, selected: chosen.rarity});

		next.element.open = true;
		groups[at].element.replaceWith(next.element);
		groups[at] = next;
	}

	const rulePanel = h('div', {class: 'col-rule', id: 'col-rule'},
		h('p', {class: 'muted'}, 'A card joins when it fits every field you choose below. A field with several choices takes any one of them.'),
		star,
		...groups.map((group) => group.element),
		h('div', {class: 'fb-check'}, favoriteBox, h('label', {for: 'col-favorite'}, 'Favorites only')),
		preview
	);

	function drawPreview() {
		let text = '';

		try {
			const clean = cleanRule(ruleNow());
			const count = items.filter((item) => ruleMatches(clean, item)).length;

			text = `${plural(count, 'card matches', 'cards match')} now. ${ruleText(clean, labels)}`;
		}
		catch (err) {
			text = err.message;
		}

		preview.textContent = text;
	}

	const kindRadio = (value, text, note) => {
		const radio = h('input', {id: `col-kind-${value}`, name: 'col-kind', type: 'radio', value});

		radio.checked = kind === value;
		radio.disabled = editing;
		radio.addEventListener('change', () => {
			kind = value;
			sync();
		});

		return h('label', {class: 'col-kind', for: radio.id}, radio, h('span', null, h('strong', null, text), h('span', {class: 'muted'}, note)));
	};

	function sync() {
		rulePanel.hidden = kind !== 'rule';

		if (kind === 'rule') {
			drawPreview();
		}
	}

	const save = h('button', {class: 'primary', id: 'col-save', type: 'submit'}, editing ? 'Save' : 'Create');
	const remove = editing ? h('button', {class: 'danger', id: 'col-delete', type: 'button'}, 'Delete collection') : null;

	const form = h('form', {class: 'fb-sheet-body', novalidate: true},
		h('div', {class: 'fb-field'}, h('label', {for: 'col-name'}, 'Name'), name),
		editing ? null : h('fieldset', {class: 'fb-field col-kinds'},
			h('legend', null, 'Kind'),
			kindRadio('hand', 'Hand-picked', 'You choose each card.'),
			kindRadio('rule', 'Fills itself', 'A rule collects the cards, such as every illustration rare.')
		),
		rulePanel,
		error
	);

	const dialog = h('dialog', {'aria-labelledby': `${id}-title`, class: 'sheet fb-sheet collection-sheet', id},
		h('div', {class: 'sheet-head'},
			h('h2', {id: `${id}-title`}, editing ? 'Edit collection' : 'New collection'),
			h('button', {class: 'small', onclick: () => dialog.close(), type: 'button'}, 'Close')
		),
		form,
		h('div', {class: 'fb-sheet-foot col-foot'}, remove, save)
	);

	function fail(text) {
		error.textContent = text;
		error.hidden = false;
	}

	async function submit() {
		error.hidden = true;
		save.disabled = true;

		try {
			const fields = {name: name.value};
			let entry;

			if (editing) {
				if (collection.kind === 'rule') {
					fields.rule = cleanRule(ruleNow());
				}

				entry = await updateCollection(collection.id, fields);
			}
			else {
				entry = await createCollection({...fields, kind, rule: kind === 'rule' ? cleanRule(ruleNow()) : null});
			}

			dialog.close();

			if (onSaved) {
				onSaved(entry);
			}
		}
		catch (err) {
			fail(err.message || errorText(err));
			save.disabled = false;
		}
	}

	form.addEventListener('submit', (event) => {
		event.preventDefault();
		submit();
	});
	save.addEventListener('click', (event) => {
		event.preventDefault();
		submit();
	});

	if (remove) {
		remove.addEventListener('click', async () => {
			try {
				await removeCollection(collection.id);
				dialog.close();
				toast(`Deleted ${collection.name}.`, {
					action: () => restoreCollection(collection.id).catch((err) => toast(`Could not bring it back. ${errorText(err)}`)),
					actionLabel: 'Undo',
					timeout: UNDO_MS,
				});

				if (onDeleted) {
					onDeleted(collection);
				}
			}
			catch (err) {
				fail(err.message || errorText(err));
			}
		});
	}

	dialog.addEventListener('click', (event) => {
		if (event.target === dialog) {
			dialog.close();
		}
	});
	dialog.addEventListener('close', () => {
		dialog.remove();

		if (opener && opener.isConnected && typeof opener.focus === 'function') {
			opener.focus();
		}
	});
	document.getElementById(id)?.remove();
	document.body.append(dialog);
	sync();
	dialog.showModal();

	return dialog;
}

// ------------------------------------------------------------- the list

function heading(text, userId) {
	return h('div', null,
		h('div', {class: 'view-head'}, h('h2', {id: 'collections-title'}, text)),
		listsSwitch('collections', userId)
	);
}

// The rows for a set of collections, each a link with its count and value.
function rowsFor(collections, {cards, index, saved, userId}) {
	const rates = savedRates();
	const byId = new Map([...index, ...(saved || [])]);

	return collections.map((collection) => {
		const entries = collectionEntries(collection, cards, index);
		const stats = listStats(entries, byId, {rates});
		const value = saved ? valueText(stats) : null;

		return h('li', null,
			h('a', {class: 'col-row', 'data-collection': collection.id, 'data-link': collectionRoute(userId, collection.id), href: BASE + collectionRoute(userId, collection.id)},
				h('span', {class: 'col-name'}, collection.name),
				h('span', {class: 'col-kind-tag'}, kindText(collection)),
				h('span', {class: 'col-meta'},
					h('span', {class: 'col-count'}, plural(entries.length, 'card', 'cards')),
					entries.length ? h('span', {class: 'col-value'}, value || 'Value loading') : null
				)
			)
		);
	});
}

// The list screen, yours or a member's. read() resolves to {cards,
// collections, index}.
function listScreen(root, {emptyText, newButton, read, userId, watch}) {
	let alive = true;
	let loadRun = 0;
	const list = h('ul', {class: 'col-list', id: 'collections-list'});
	const status = h('p', {class: 'muted', id: 'collections-status', role: 'status'});
	const empty = h('div', {class: 'card empty-state', hidden: true, id: 'collections-empty'}, emptyText);
	// Edit order (js/reorder.js), on your own list: the collections as rows
	// to drag or move, in place of the list while it is open.
	const order = userId ? null : orderSection({
		describe: (collection) => ({detail: kindText(collection), name: collection.name}),
		errorText,
		fallback: byName,
		label: 'Collections',
		onToggle: (open) => {
			list.hidden = open;

			if (newButton) {
				newButton.hidden = open;
			}
		},
		save: reorderCollections,
		toast,
	});

	if (order) {
		order.button.id = 'collections-order';
		order.panel.id = 'collections-order-panel';
	}

	const body = h('div', null, status, list, order ? order.panel : null, empty);

	root.append(...[heading(userId ? 'Family collections' : 'Collections', userId), newButton ? h('div', {class: 'col-new-row'}, newButton, order ? order.button : null) : null, body].filter(Boolean));

	async function load() {
		const run = ++loadRun;
		let data;

		try {
			data = await read();
		}
		catch (err) {
			if (alive && run === loadRun) {
				status.textContent = userId ? err.message || errorText(err) : `Your collections could not be read from this phone. ${errorText(err)}`;
			}

			return;
		}

		if (!alive || run !== loadRun) {
			return;
		}

		status.textContent = '';
		empty.hidden = data.collections.length > 0;
		draw(data, null);

		if (!data.collections.length) {
			return;
		}

		const held = [...new Set(data.collections.flatMap((collection) => collectionEntries(collection, data.cards, data.index)))];
		const saved = await savedCardRecords(held).catch(() => new Map());

		if (alive && run === loadRun) {
			draw(data, saved);
		}

		if (data.collections.some((collection) => collection.kind === 'rule') && !userId) {
			const next = await fillDetails(data.cards, data.index, () => alive && run === loadRun).catch(() => null);

			if (next && alive && run === loadRun) {
				load();
			}
		}
	}

	function draw(data, saved) {
		if (order) {
			order.set(data.collections);
		}

		list.replaceChildren(...rowsFor(data.collections, {cards: data.cards, index: data.index, saved, userId}));
	}

	const stop = watch ? watch(load) : () => {};

	load();

	return () => {
		alive = false;
		stop();
	};
}

export function collectionsView(root) {
	const add = h('button', {class: 'primary', id: 'collections-new', onclick: async () => {
		const data = await withDetails(await loadCollections());

		openCollectionEditor({cards: data.cards, index: data.index, onSaved: (entry) => go(collectionRoute(null, entry.id))});
	}, type: 'button'}, 'New collection');

	return listScreen(root, {
		emptyText: [
			h('p', {class: 'big'}, 'No collections yet.'),
			h('p', {class: 'muted'}, 'Group cards you own: pick them by hand, or let a rule such as every illustration rare collect them for you. A card can be in more than one.')
		],
		newButton: add,
		read: loadCollections,
		watch: (load) => onChange(() => load()),
	});
}

async function memberData(userId) {
	if (!currentUser()) {
		throw new Error('Sign in to see your family\'s collections.');
	}

	if (!navigator.onLine) {
		throw new Error('A family member\'s collections show when you are online.');
	}

	const [doc, index] = await Promise.all([memberDocumentKept(userId), cardIndex()]);

	return {cards: Array.isArray(doc.cards) ? doc.cards : [], collections: sortCollections(Array.isArray(doc.collections) ? doc.collections : []), index};
}

export function familyCollectionsView(root, {userId}) {
	const stop = listScreen(root, {
		emptyText: [h('p', {class: 'big'}, 'No collections yet.'), h('p', {class: 'muted'}, 'They have not made a collection.')],
		newButton: null,
		read: () => memberData(userId),
		userId,
	});

	whenMemberName(userId, (name) => {
		const title = root.querySelector('#collections-title');

		document.title = `${name}'s collections | Card Tracker`;

		if (title) {
			title.textContent = `${name}'s collections`;
		}
	});

	return stop;
}

// ------------------------------------------- cards left out of a rule
//
// A rule collection takes every copy that fits, and any of them can be left
// out by hand (Eric, 2026-10-06): from the collection's own screen ("Leave
// cards out", a sheet of the cards it holds) or from card detail's Add to
// collection sheet. "N left out" opens the ones left out, to put back. Each
// change is saved at once with Undo on a toast.

// What a row shows of a card: its name, set, number, and image, from the
// card index (or the names saved on the copy for a card the catalog lacks).
function cardLabel(entry, index) {
	const catalog = entry.catalog || 'international';
	const record = index.get(indexKey(catalog, entry.card_id)) || null;
	const localizations = (record && record.localizations) || {};
	const local = localizations[entry.language] || localizations[catalogLanguage(catalog)] || Object.values(localizations)[0] || null;
	const source = sourceNames(entry, record);

	return {
		image: local && local.image ? cardImage(local.image, 'low') : null,
		name: (source && source.name) || (local && local.name) || entry.name_local || entry.card_id,
		number: (record && record.collector_number) || entry.number_local || null,
		setName: (source && source.setName) || (local && local.set_name) || entry.set_name_local || null,
	};
}

// Copies grouped by card, in name order: [{key, entries, label}].
function cardGroups(entries, index) {
	const groups = new Map();

	for (const entry of entries) {
		const key = `${entry.catalog || 'international'}|${entry.card_id}`;

		if (!groups.has(key)) {
			groups.set(key, {entries: [], key, label: cardLabel(entry, index)});
		}

		groups.get(key).entries.push(entry);
	}

	return [...groups.values()].sort((a, b) => a.label.name.localeCompare(b.label.name) || a.key.localeCompare(b.key));
}

const groupDetail = (group) => [
	group.label.setName,
	group.label.number ? `#${group.label.number}` : null,
	[...new Set(group.entries.map((entry) => languageLabel(entry.language)))].join(', '),
	group.entries.length > 1 ? plural(group.entries.length, 'copy', 'copies') : null,
].filter(Boolean).join(' · ');

// A sheet of cards, each row with one button. read() resolves to the groups
// to show now; act(group) does the row's change and resolves to the words
// for the toast and its Undo, {text, undo}. bulk, when given, is a button
// above the rows for all of them at once: {label, act(groups)}.
async function openCardsSheet({actionLabel, bulk = null, empty, id, intro, read, act, title}) {
	const opener = document.activeElement;
	const note = h('p', {class: 'muted', id: `${id}-note`, role: 'status'});
	const search = h('input', {'aria-label': 'Find a card', autocomplete: 'off', class: 'search col-find', hidden: true, id: `${id}-find`, placeholder: 'Find a card', type: 'search'});
	const list = h('ul', {class: 'col-cards', id: `${id}-list`});
	const all = bulk ? h('button', {class: 'small col-cards-all', hidden: true, id: `${id}-all`, type: 'button'}, bulk.label) : null;
	const dialog = h('dialog', {'aria-labelledby': `${id}-title`, class: 'sheet collection-sheet', id},
		h('div', {class: 'sheet-head'},
			h('h2', {id: `${id}-title`}, title),
			h('button', {class: 'small', onclick: () => dialog.close(), type: 'button'}, 'Done')
		),
		h('p', {class: 'muted'}, intro),
		all,
		search,
		list,
		note
	);
	let groups = [];

	function filter() {
		const needle = search.value.trim().toLowerCase();

		for (const row of list.children) {
			row.hidden = Boolean(needle) && !row.dataset.name.toLowerCase().includes(needle);
		}
	}

	async function run(work) {
		for (const button of dialog.querySelectorAll('.col-cards button, .col-cards-all')) {
			button.disabled = true;
		}

		try {
			const {text, undo} = await work();

			note.textContent = text;
			toast(text, {
				action: () => undo().catch((err) => toast(`Could not undo it. ${errorText(err)}`)),
				actionLabel: 'Undo',
				timeout: UNDO_MS,
			});
		}
		catch (err) {
			note.textContent = err.message || errorText(err);
		}

		await draw();
	}

	async function draw() {
		groups = await read();
		search.hidden = groups.length <= 8;

		if (all) {
			all.hidden = groups.length < 2;
		}

		list.replaceChildren(...groups.map((group) => {
			const image = group.label.image
				? h('img', {alt: '', class: 'col-card-art', decoding: 'async', loading: 'lazy', src: group.label.image})
				: h('span', {'aria-hidden': 'true', class: 'col-card-art'});
			const button = h('button', {'aria-label': `${actionLabel}: ${group.label.name}`, class: 'small', 'data-card': group.key, type: 'button'}, actionLabel);

			button.addEventListener('click', () => run(() => act(group)));

			return h('li', {class: 'col-card', 'data-name': group.label.name},
				image,
				h('span', {class: 'col-card-text'},
					h('span', {class: 'col-card-name'}, group.label.name),
					h('span', {class: 'col-card-meta'}, groupDetail(group))
				),
				button
			);
		}));

		if (!groups.length) {
			list.replaceChildren(h('li', {class: 'muted col-cards-empty'}, empty));
		}

		filter();
	}

	search.addEventListener('input', filter);

	if (all) {
		all.addEventListener('click', () => run(() => bulk.act(groups)));
	}

	dialog.addEventListener('click', (event) => {
		if (event.target === dialog) {
			dialog.close();
		}
	});
	dialog.addEventListener('close', () => {
		dialog.remove();

		if (opener && opener.isConnected && typeof opener.focus === 'function') {
			opener.focus();
		}
	});
	document.getElementById(id)?.remove();
	await draw();
	document.body.append(dialog);
	dialog.showModal();

	return dialog;
}

// The collection as saved now, with the cards and the index.
async function freshCollection(id) {
	const data = await loadCollections();

	return {...data, collection: data.collections.find((item) => item.id === id) || null};
}

const groupIds = (groups) => groups.flatMap((group) => group.entries.map((entry) => entry.id));

// "Leave cards out": the cards the rule collection holds, each with Leave out.
function openLeaveOutSheet(collection) {
	return openCardsSheet({
		act: async (group) => {
			const ids = groupIds([group]);

			await leaveOut(collection.id, ids);

			return {text: `Left ${group.label.name} out of ${collection.name}.`, undo: () => putBack(collection.id, ids)};
		},
		actionLabel: 'Leave out',
		empty: 'No cards in this collection now.',
		id: 'leave-out-sheet',
		intro: `The rule keeps adding new cards that fit. A card you leave out stays out until you put it back.`,
		read: async () => {
			const {cards, collection: now, index} = await freshCollection(collection.id);

			return now ? cardGroups(collectionEntries(now, cards, index), index) : [];
		},
		title: 'Leave cards out',
	});
}

// The live copies left out, grouped by card, each knowing the stored ids a
// put back must answer.
function leftOutGroups(collection, cards, index) {
	const out = leftOut(collection, cards, index);
	const live = new Map(cards.filter((entry) => entry && out.has(entry.id)).map((entry) => [entry.id, entry]));
	const groups = cardGroups([...live.values()], index);

	for (const group of groups) {
		group.stored = group.entries.flatMap((entry) => out.get(entry.id) || []);
	}

	return groups;
}

// "N left out": the cards left out, each with Put back, and Put all back.
function openLeftOutSheet(collection) {
	const back = async (groups, text) => {
		const stored = groups.flatMap((group) => group.stored);

		await putBack(collection.id, stored);

		return {text, undo: () => leaveOut(collection.id, stored)};
	};

	return openCardsSheet({
		act: (group) => back([group], `Put ${group.label.name} back in ${collection.name}.`),
		actionLabel: 'Put back',
		bulk: {act: (groups) => back(groups, `Put ${plural(groups.length, 'card', 'cards')} back in ${collection.name}.`), label: 'Put all back'},
		empty: 'Nothing is left out now.',
		id: 'left-out-sheet',
		intro: 'Cards that fit the rule but you took out by hand.',
		read: async () => {
			const {cards, collection: now, index} = await freshCollection(collection.id);

			return now ? leftOutGroups(now, cards, index) : [];
		},
		title: 'Left out',
	});
}

// ------------------------------------------------------ one collection

function collectionScreen(root, {id, userId = null}) {
	const readOnly = Boolean(userId);
	let alive = true;
	let collection = null;
	let allCards = [];
	let index = new Map();
	let poke = null;
	let missing = false;
	const about = h('p', {class: 'muted', id: 'collection-about'});
	const edit = readOnly ? null : h('button', {class: 'small', disabled: true, id: 'collection-edit', onclick: async () => {
		if (collection) {
			const data = collection.kind === 'rule' ? await withDetails({cards: allCards, index}) : {cards: allCards, index};

			openCollectionEditor({cards: data.cards, collection, index: data.index, onDeleted: () => go('collections')});
		}
	}, type: 'button'}, 'Edit');
	const back = h('a', {class: 'button small', 'data-link': collectionsRoute(userId), href: BASE + collectionsRoute(userId), id: 'collection-back'}, 'Collections');
	// A rule collection's cards can be left out by hand, and put back.
	const leave = readOnly ? null : h('button', {class: 'small', hidden: true, id: 'collection-leave-out', onclick: () => {
		if (collection) {
			openLeaveOutSheet(collection).catch((err) => toast(`The cards did not open. ${errorText(err)}`));
		}
	}, type: 'button'}, 'Leave cards out');
	const leftButton = readOnly ? null : h('button', {class: 'small link-button', id: 'collection-left-out', onclick: () => {
		if (collection) {
			openLeftOutSheet(collection).catch((err) => toast(`The cards did not open. ${errorText(err)}`));
		}
	}, type: 'button'});
	const leftLine = readOnly ? null : h('p', {class: 'muted col-left', hidden: true, id: 'collection-left'}, leftButton);
	const actions = h('div', {class: 'col-actions'}, back, edit, leave);
	const screen = h('div', {class: 'col-screen'});

	root.append(...[actions, about, leftLine, screen].filter(Boolean));

	function describe() {
		const title = screen.querySelector('.view-head h2');

		if (title) {
			title.textContent = collection ? collection.name : 'Collection';
		}

		if (collection) {
			document.title = `${collection.name} | Card Tracker`;
		}

		about.textContent = collection
			? `${kindText(collection)}${collection.kind === 'rule' ? `. ${ruleText(collection.rule, ruleLabels(filterOptions(itemsOf(allCards, index))))}` : ''}`
			: '';

		if (edit) {
			edit.disabled = !collection;
		}

		if (leave) {
			const rule = Boolean(collection) && collection.kind === 'rule';
			const out = rule ? leftOut(collection, allCards, index).size : 0;

			leave.hidden = !rule;
			leftLine.hidden = !out;
			leftButton.textContent = `${plural(out, 'card', 'cards')} left out`;
		}
	}

	function apply(data) {
		allCards = data.cards;
		index = data.index;
		collection = data.collections.find((item) => item.id === id) || null;
		missing = !collection;
		describe();

		return collection ? collectionEntries(collection, allCards, index).filter(isLive) : [];
	}

	const read = async () => {
		if (readOnly) {
			return apply(await memberData(userId));
		}

		const entries = apply(await loadCollections());

		// A rule reads details this phone may not have saved yet.
		if (collection && collection.kind === 'rule') {
			fillDetails(allCards, index, () => alive).then((next) => {
				if (next && alive && poke) {
					poke(null);
				}
			}).catch(() => {});
		}

		return entries;
	};

	const emptyNode = () => {
		if (missing) {
			return h('div', {class: 'card empty-state', id: 'collection-missing'},
				h('p', {class: 'big'}, 'This collection is not here.'),
				h('p', {class: 'muted'}, 'It may have been deleted.'),
				h('a', {class: 'button', 'data-link': 'collections', href: `${BASE}collections`}, 'Back to collections')
			);
		}

		return h('div', {class: 'card empty-state', id: 'collection-empty'},
			h('p', {class: 'big'}, 'No cards yet'),
			h('p', {class: 'muted'}, collection && collection.kind === 'rule'
				? 'No card you own fits this rule yet. Cards join by themselves when you save them.'
				: 'Open a card you own and tap Add to collection, or add a whole scan session when you save it.')
		);
	};

	const cleanup = cardsScreen(screen, {
		emptyNode,
		emptyText: () => (missing ? 'This collection is not here.' : 'No cards in this collection yet.'),
		label: 'this collection',
		load: read,
		placeholder: 'Search this collection',
		readOnly,
		storageKey: `cardTracker.collectionChoice${readOnly ? '.family' : ''}`,
		title: 'Collection',
		watch: readOnly ? null : (reload) => {
			poke = reload;

			return onChange((doc, info) => {
				if (!doc || !Array.isArray(doc.cards)) {
					return reload(doc, info);
				}

				const now = sortCollections(doc.collections || []).find((item) => item.id === id) || null;

				if (!now) {
					return reload(null, info);
				}

				collection = now;
				allCards = doc.cards;
				describe();

				return reload({...doc, cards: collectionEntries(now, doc.cards, index)}, info);
			});
		},
	});

	describe();

	if (readOnly) {
		whenMemberName(userId, (name) => {
			about.dataset.member = name;
		});
	}

	return () => {
		alive = false;
		cleanup();
	};
}

export const collectionView = (root, {id}) => collectionScreen(root, {id});

export const familyCollectionView = (root, {id, userId}) => collectionScreen(root, {id, userId});

// ------------------------------------------------ the "Add to collection" sheet

// The sheet card detail opens: tick the hand-picked collections these copies
// belong to, or start a new one. entries are your live copies of the card;
// a tick adds all of them and clears take them all out. Collections that fill
// themselves are listed below them when the card fits their rule, ticked
// while they hold its copies: clearing one leaves the copies out of it, and
// ticking it again puts them back.
export async function openCollectionsSheet({entries, name = 'this card'}) {
	const id = 'collections-sheet';
	const opener = document.activeElement;
	const ids = entries.map((entry) => entry.id);
	const index = await cardIndex();
	const note = h('p', {class: 'muted', id: 'collections-sheet-note', role: 'status'});
	const list = h('div', {class: 'col-pick', id: 'collections-sheet-list'});
	const nameInput = h('input', {'aria-label': 'New collection name', autocomplete: 'off', class: 'search', id: 'collections-sheet-name', maxlength: NAME_MAX, placeholder: 'New collection', type: 'text'});
	const create = h('button', {class: 'small', id: 'collections-sheet-create', type: 'button'}, 'Create and add');
	const dialog = h('dialog', {'aria-labelledby': `${id}-title`, class: 'sheet collection-sheet', id},
		h('div', {class: 'sheet-head'},
			h('h2', {id: `${id}-title`}, 'Add to collection'),
			h('button', {class: 'small', onclick: () => dialog.close(), type: 'button'}, 'Done')
		),
		h('p', {class: 'muted'}, name),
		list,
		h('div', {class: 'col-create'}, nameInput, create),
		note
	);

	// A rule collection that fits the card: ticked while it holds the card's
	// copies, clear when they are all left out. Unticking leaves them out,
	// ticking puts them back; the rule goes on adding other cards.
	function ruleRow(collection, cards) {
		const fits = entries.filter((entry) => ruleMatches(collection.rule, itemFor(entry, index.get(`${entry.catalog || 'international'}|${entry.card_id}`))));

		if (!fits.length) {
			return null;
		}

		const out = leftOut(collection, cards, index);
		const outCount = fits.filter((entry) => out.has(entry.id)).length;
		const box = h('input', {'data-collection': collection.id, 'data-rule': 'true', id: `col-pick-${collection.id}`, type: 'checkbox'});

		box.checked = outCount === 0;
		box.indeterminate = outCount > 0 && outCount < fits.length;
		box.addEventListener('change', async () => {
			box.disabled = true;

			try {
				if (box.checked) {
					await putBack(collection.id, fits.flatMap((entry) => out.get(entry.id) || []));
				}
				else {
					await leaveOut(collection.id, fits.map((entry) => entry.id));
				}

				note.textContent = box.checked ? `Back in ${collection.name}.` : `Left out of ${collection.name}. The rule still adds other cards.`;
			}
			catch (err) {
				note.textContent = err.message || errorText(err);
			}

			await draw();
		});

		return h('div', {class: 'fb-check'}, box, h('label', {for: box.id}, collection.name, h('span', {class: 'col-pick-kind'}, ' · fills itself')));
	}

	async function draw() {
		const {cards, collections} = await loadCollections();
		const rows = [];
		const filling = [];

		for (const collection of collections) {
			if (collection.kind === 'rule') {
				const row = ruleRow(collection, cards);

				if (row) {
					filling.push(row);
				}

				continue;
			}

			const held = ids.filter((one) => isMember(collection, one)).length;
			const box = h('input', {'data-collection': collection.id, id: `col-pick-${collection.id}`, type: 'checkbox'});

			box.checked = held === ids.length;
			box.indeterminate = held > 0 && held < ids.length;
			box.addEventListener('change', async () => {
				box.disabled = true;

				try {
					if (box.checked) {
						await addToCollection(collection.id, ids);
					}
					else {
						await removeFromCollection(collection.id, ids);
					}

					note.textContent = box.checked ? `Added to ${collection.name}.` : `Removed from ${collection.name}.`;
				}
				catch (err) {
					note.textContent = err.message || errorText(err);
				}

				await draw();
			});
			rows.push(h('div', {class: 'fb-check'}, box, h('label', {for: box.id}, collection.name)));
		}

		if (!rows.length) {
			rows.push(h('p', {class: 'muted'}, 'You have no hand-picked collections yet. Name one below.'));
		}

		if (filling.length) {
			rows.push(h('div', {class: 'col-pick-rules', id: 'collections-sheet-rules'},
				h('p', {class: 'muted'}, 'Filled by a rule. Untick to leave this card out.'),
				...filling
			));
		}

		list.replaceChildren(...rows);
	}

	create.addEventListener('click', async () => {
		create.disabled = true;

		try {
			const made = await createCollection({kind: 'hand', name: nameInput.value});

			await addToCollection(made.id, ids);
			nameInput.value = '';
			note.textContent = `Added to ${made.name}.`;
			await draw();
		}
		catch (err) {
			note.textContent = err.message || errorText(err);
		}

		create.disabled = false;
	});
	nameInput.addEventListener('keydown', (event) => {
		if (event.key === 'Enter') {
			event.preventDefault();
			create.click();
		}
	});
	dialog.addEventListener('click', (event) => {
		if (event.target === dialog) {
			dialog.close();
		}
	});
	dialog.addEventListener('close', () => {
		dialog.remove();

		if (opener && opener.isConnected && typeof opener.focus === 'function') {
			opener.focus();
		}
	});
	document.getElementById(id)?.remove();
	await draw();
	document.body.append(dialog);
	dialog.showModal();

	return dialog;
}

// ----------------------------------------------------------- routes

export const COLLECTIONS_ROUTES = [
	{kind: 'lists', pattern: /^collections$/, render: collectionsView, tab: 'lists', title: 'Collections | Card Tracker'},
	{keys: ['id'], kind: 'lists', pattern: /^collections\/([^/]+)$/, render: collectionView, tab: 'lists', title: 'Collection | Card Tracker'},
	{keys: ['userId'], kind: 'lists', pattern: /^family\/([^/]+)\/collections$/, render: familyCollectionsView, tab: 'lists', title: 'Family collections | Card Tracker'},
	{keys: ['userId', 'id'], kind: 'lists', pattern: /^family\/([^/]+)\/collections\/([^/]+)$/, render: familyCollectionView, tab: 'lists', title: 'Family collection | Card Tracker'},
];

export const COLLECTIONS_ACCOUNT_VIEWS = [collectionsView, collectionView, familyCollectionsView, familyCollectionView];
