// Hand-made cards on screen (js/custom-card.js holds the model): the sheet
// that adds or edits one, and its card page. The sheet opens from My Cards
// ("Add a card by hand"), from the scanner's Add by hand, and from each
// unmatched row of the import report, prefilled with what is known.
//
// The card page is card detail for a card the catalog lacks: the name, set,
// and number typed in, the owner's photo (or the card back with the name),
// Your copies with the same rows, steppers, and sheets as any card, and no
// Liga, US, or EU price, since there is no catalog record to price; a Liga
// price typed on a copy still shows on its row. Edit card and Remove card
// change every copy at once. When the catalog later lists a card with the
// same set and number, the page offers to link the copies to it.

import {catalogLanguage, languageLabel, setDetail, setList, viewingLanguage} from './catalog.js';
import {addCards, deleteCards, listCards, onChange, updateCards} from './collection.js';
import {
	alikeKey,
	closeCopySheet,
	conditionOptions,
	copyLanguages,
	copyPlaces,
	copyStepper,
	languageName,
	MAX_ADD,
	openAddSheet,
	openEditSheet,
	placeText,
	rawFinishes,
	removeWithUndo,
	sheetDialog,
	sheetField,
	sheetSelect,
	showSheet,
	UNDO_MS,
} from './copy-sheet.js';
import {CUSTOM, customCard, customEntries, customRoute, editPatches, findCatalogCard, findSet, linkLookups, linkPatches, NAME_MAX, newCustomCardId, NUMBER_MAX, SET_MAX} from './custom-card.js';
import {BASE, errorText, go, h} from './dom.js';
import {memberDocumentKept, whenMemberName} from './family.js';
import {flagBadge} from './flags.js';
import {finishLabel} from './monprice.js';
import {copyPriceText} from './price-view.js';
import {cardPhotos} from './photos/index.js';
import {lensMember, toast} from './shell.js';
import {cardArt} from './tile.js';

// ------------------------------------------------------------ known sets

// The sets the catalog lists for a language, flattened, for the set field's
// suggestions and the link check: [{id, name, code, catalog}]. Cache first;
// empty when the catalog cannot be read (offline with nothing saved).
export async function knownSets(language) {
	const out = [];

	for (const {catalog, lang} of linkLookups(language)) {
		try {
			const {data} = await setList(lang);

			for (const serie of data || []) {
				for (const set of serie.sets || []) {
					out.push({catalog, code: set.code || null, id: set.id, lang, name: set.name});
				}
			}
		}
		catch {
			// Free text only for this catalog.
		}
	}

	return out;
}

// The catalog card a hand-made card now matches, by set and number:
// {catalog, card, set} or null. Nothing is asked when the card has no
// number or no set to look in.
export async function catalogMatch(card, language) {
	if (!card || !card.number || (!card.setCode && !card.setName)) {
		return null;
	}

	for (const {catalog, lang} of linkLookups(language)) {
		let sets;

		try {
			sets = (await setList(lang)).data || [];
		}
		catch {
			continue;
		}

		const set = findSet(sets.flatMap((serie) => serie.sets || []), card);

		if (!set) {
			continue;
		}

		try {
			const {data} = await setDetail(lang, set.id);
			const found = findCatalogCard(data, card.number);

			if (found) {
				return {card: found, catalog, lang, set: data};
			}
		}
		catch {
			// The set could not be read; try the next catalog.
		}
	}

	return null;
}

// ------------------------------------------------------------ the sheet

const LANGUAGE_CODES = copyLanguages(CUSTOM).map(({code}) => code);

const defaultLanguage = () => {
	const viewing = viewingLanguage();

	return LANGUAGE_CODES.includes(viewing) ? viewing : 'pt';
};

// The sheet that adds a hand-made card, or edits one.
//
//   prefill     {name, setName, setCode, number, language, finish, count}
//               for a new card, from the scanner or an import row
//   card        js/custom-card.js customCard: edits its name, set, and
//               number on every copy instead of adding
//   onSaved     (entries) after a save
//   openPage    true opens the new card's page after adding
export function openCustomCardSheet({card = null, onSaved = null, openPage = true, prefill = {}} = {}) {
	const editing = Boolean(card);
	const sheet = sheetDialog('hand-sheet', editing ? 'Edit card' : 'Add a card by hand');
	const close = () => sheet.close();
	const values = editing ? {name: card.name, number: card.number, setCode: card.setCode, setName: card.setName} : prefill;
	const error = h('p', {'aria-live': 'polite', class: 'form-error', id: 'hand-error'});

	const name = h('input', {autocomplete: 'off', class: 'search', id: 'hand-name', maxlength: NAME_MAX, name: 'hand-name', required: true, value: values.name || ''});
	const setName = h('input', {autocomplete: 'off', class: 'search', id: 'hand-set', list: 'hand-sets', maxlength: SET_MAX, name: 'hand-set', value: values.setName || ''});
	const setCode = h('input', {autocapitalize: 'characters', autocomplete: 'off', class: 'search', id: 'hand-code', maxlength: 20, name: 'hand-code', value: values.setCode || ''});
	const number = h('input', {autocomplete: 'off', class: 'search', id: 'hand-number', maxlength: NUMBER_MAX, name: 'hand-number', value: values.number || ''});
	const suggestions = h('datalist', {id: 'hand-sets'});
	const initialLanguage = LANGUAGE_CODES.includes(values.language) ? values.language : defaultLanguage();
	const language = editing ? null : sheetSelect('hand-language', copyLanguages(CUSTOM).map(({code, label}) => ({label, value: code})), initialLanguage);
	const finish = editing ? null : sheetSelect('hand-finish', [{label: 'Not set', value: ''}, ...rawFinishes()], rawFinishes().some((option) => option.value === values.finish) ? values.finish : '');
	const condition = editing ? null : sheetSelect('hand-condition', conditionOptions(), '');
	const startCount = Math.min(MAX_ADD, Math.max(1, Number.parseInt(values.count, 10) || 1));
	const count = editing ? null : h('input', {class: 'search copy-count', id: 'hand-count', inputmode: 'numeric', max: MAX_ADD, min: 1, name: 'hand-count', step: 1, type: 'number', value: startCount});
	const submit = h('button', {class: 'primary', id: 'hand-save', type: 'submit'}, editing ? 'Save' : 'Add card');

	// The set field suggests the catalog's sets in the card's language; a set
	// picked from them fills the set code, which is what a later catalog
	// card is matched by.
	let sets = [];
	let codeFilled = false;

	async function suggest() {
		const lang = language ? language.value : (card.entries[0] || {}).language;

		sets = await knownSets(lang);

		if (sheet.isConnected) {
			suggestions.replaceChildren(...sets.map((set) => h('option', {value: set.name}, set.code || set.id)));
		}
	}

	setName.addEventListener('change', () => {
		const set = findSet(sets, {setName: setName.value});

		if (set && (!setCode.value.trim() || codeFilled)) {
			setCode.value = set.code || set.id;
			codeFilled = true;
		}
	});
	setCode.addEventListener('input', () => {
		codeFilled = false;
	});

	if (language) {
		language.addEventListener('change', () => suggest().catch(() => {}));
	}

	const howMany = () => {
		const n = Number.parseInt(count.value, 10);

		return Number.isInteger(n) && n >= 1 && n <= MAX_ADD ? n : null;
	};

	const form = h('form', {class: 'copy-form hand-form', id: 'hand-form', novalidate: true},
		sheetField('Name', 'hand-name', name),
		sheetField('Set', 'hand-set', setName),
		suggestions,
		h('div', {class: 'hand-pair'},
			sheetField('Set code', 'hand-code', setCode),
			sheetField('Number', 'hand-number', number)
		),
		language ? sheetField('Language', 'hand-language', language) : null,
		finish ? sheetField('Finish', 'hand-finish', finish) : null,
		condition ? sheetField('Condition', 'hand-condition', condition) : null,
		count ? sheetField(`How many (1 to ${MAX_ADD})`, 'hand-count', count) : null,
		error,
		submit
	);

	// A message about a field goes once the field is typed in again.
	form.addEventListener('input', () => {
		error.textContent = '';
	});

	form.addEventListener('submit', async (event) => {
		event.preventDefault();
		error.textContent = '';

		const typed = {name: name.value, number: number.value, setCode: setCode.value, setName: setName.value};

		submit.disabled = true;

		try {
			if (editing) {
				const patches = editPatches(card.entries, typed);

				if (patches.length) {
					await updateCards(patches);
				}

				close();
				toast(patches.length ? 'Card saved.' : 'Nothing changed.');

				if (onSaved) {
					onSaved(card.entries);
				}

				return;
			}

			const n = howMany();

			if (!n) {
				throw new Error(`Choose from 1 to ${MAX_ADD} copies.`);
			}

			const cardId = newCustomCardId();
			const added = await addCards(customEntries({
				...typed,
				cardId,
				condition: condition.value || null,
				count: n,
				finish: finish.value || null,
				language: language.value,
			}));

			// The new page takes the sheet's history entry (js/dom.js pushRoute)
			// and closes the sheet as it draws; closing first would go Back
			// after the page opened.
			if (openPage) {
				go(customRoute(cardId, language.value));
			}
			else {
				close();
			}

			toast(`Added ${added[0].name_local}${n > 1 ? ` (${n} copies)` : ''}.`, {
				action: () => deleteCards(added.map((entry) => entry.id)).catch(() => {}),
				actionLabel: 'Undo',
				timeout: UNDO_MS,
			});

			if (onSaved) {
				onSaved(added);
			}
		}
		catch (err) {
			submit.disabled = false;
			error.textContent = err && err.message && !/^(Abort|Network)/.test(err.name || '') ? err.message : `Not saved. ${errorText(err)}`;
		}
	});

	sheet.replaceChildren(
		h('div', {class: 'sheet-head'},
			h('h2', {id: 'hand-sheet-title'}, editing ? 'Edit card' : 'Add a card by hand'),
			h('button', {class: 'small', id: 'hand-close', onclick: close, type: 'button'}, 'Close')
		),
		h('p', {class: 'muted copy-sub'}, editing
			? 'Changes the name, set, and number on every copy.'
			: 'For a card the catalog does not have. You can add a photo on its page after saving.'),
		form
	);

	suggest().catch(() => {});
	showSheet(sheet);
	name.focus({preventScroll: true});

	return sheet;
}

// ------------------------------------------------------------ the page

const back = () => h('a', {class: 'back', 'data-link': 'cards', href: `${BASE}cards`, onclick: (event) => {
	if (history.state && history.state.inApp) {
		event.preventDefault();
		event.stopPropagation();
		history.back();
	}
}, style: 'min-width: 48px'}, '‹ Back');

const finishName = (entry) => (entry.finish_raw ? finishLabel(entry.finish_raw) : 'Finish not set');

// The card page for a hand-made card, at cards/<language>/<card id>. A family
// member's (the Mine switcher on their cards) is read only.
export function customCardView(root, {cardId}) {
	let alive = true;
	let card = null;
	let match = null;
	let matchAsked = false;
	const member = lensMember();
	const readOnly = Boolean(member);
	let photos = cardPhotos({cardId, catalog: CUSTOM, entries: member ? [] : null, readOnly});
	const body = h('div', {class: 'card-detail custom-detail', id: 'custom-detail'});
	const copies = h('section', {'aria-labelledby': 'copies-title', class: 'copies'});
	const linkSlot = h('div', {id: 'custom-link-slot'});

	const whose = () => (member ? `${member.name || 'Family member'}'s` : 'Your');

	async function read() {
		if (member) {
			const doc = await memberDocumentKept(member.userId);

			return (doc && doc.cards) || [];
		}

		return listCards();
	}

	function facts() {
		const info = {name: card.name, number: card.number, setName: card.setName};

		document.title = `${card.name} | Card Tracker`;

		return h('div', {class: 'card-hero'},
			h('div', {class: 'hero-art'}, photos.show({art: cardArt, info, official: null})),
			h('div', {class: 'hero-facts'},
				h('h2', {id: 'custom-name'}, card.name),
				h('dl', {class: 'facts'},
					...row('Set', card.setName),
					...row('Set code', card.setCode),
					...row('Number', card.number),
					...row('Catalog', 'Hand-made card')
				),
				h('p', {class: 'muted custom-note'}, 'Added by hand: not in the card catalog, so it has no catalog prices.'),
				readOnly ? null : h('div', {class: 'custom-actions'},
					h('button', {class: 'small', id: 'custom-edit', onclick: () => openCustomCardSheet({card}), type: 'button'}, 'Edit card'),
					h('button', {class: 'small danger', id: 'custom-remove', onclick: removeCard, type: 'button'}, 'Remove card')
				)
			)
		);
	}

	function row(label, value) {
		return value ? [h('dt', null, label), h('dd', null, value)] : [];
	}

	async function removeCard() {
		const places = await copyPlaces().catch(() => new Map());

		try {
			await removeWithUndo(card.entries, places);
		}
		catch (err) {
			toast(`Not removed. ${errorText(err)}`);
		}
	}

	const sheetCard = () => ({id: cardId, name: card.name, number: card.number});

	// What every new copy carries: the card's own facts.
	const extra = () => {
		const first = card.entries[0];

		return {name_local: first.name_local, number_local: first.number_local || null, set_code: first.set_code || null, set_name_local: first.set_name_local || null};
	};

	function addButton() {
		return h('button', {class: 'small copy-add', id: 'copy-add', onclick: () => openAddSheet({
			card: sheetCard(),
			catalog: CUSTOM,
			extra: extra(),
			finishes: rawFinishes(),
			lang: card.entries[0].language,
		}), type: 'button'}, 'Add a copy');
	}

	function drawCopies(places) {
		const groups = new Map();

		for (const entry of card.entries) {
			const key = alikeKey(entry);
			const group = groups.get(key) || {condition: entry.condition || null, entries: [], finish: finishName(entry), language: entry.language, notes: new Set(), prices: new Set()};

			if (copyPriceText(entry)) {
				group.prices.add(copyPriceText(entry));
			}

			if (entry.notes) {
				group.notes.add(entry.notes);
			}

			group.entries.push(entry);
			groups.set(key, group);
		}

		const content = (group) => [
			flagBadge([group.language], {className: 'flags-inline'}),
			h('span', {class: 'copy-text'}, [readOnly ? languageName(group.language) : null, group.finish, group.condition].filter(Boolean).join(' · ') + (readOnly && group.entries.length > 1 ? ` ×${group.entries.length}` : '')),
			...[...group.prices].map((price) => h('span', {class: 'copy-price'}, price)),
			...group.entries.filter((entry) => places.has(entry.id)).map((entry) => h('span', {class: 'copy-place'}, placeText(places.get(entry.id)))),
			...[...group.notes].map((note) => h('span', {class: 'copy-note'}, note)),
		];
		const label = (group) => [languageName(group.language), group.finish, group.condition].filter(Boolean).join(', ');

		copies.replaceChildren(
			h('div', {class: 'copies-head'},
				h('h3', {id: 'copies-title'}, `${whose()} copies (${card.entries.length})`),
				readOnly ? null : addButton()
			),
			h('ul', {class: readOnly ? 'variants copy-rows' : 'variants copy-rows editable'}, [...groups.values()].map((group) => (readOnly
				? h('li', null, content(group))
				: h('li', {class: 'copy-line', 'data-alike': alikeKey(group.entries[0])},
					h('button', {
						'aria-haspopup': 'dialog',
						class: 'copy-row',
						onclick: () => openEditSheet({card: sheetCard(), catalog: CUSTOM, entries: group.entries, finishes: rawFinishes(), places}),
						type: 'button',
					}, content(group)),
					copyStepper({entries: group.entries, label: label(group), places}).element
				))))
		);
	}

	// The offer to link, once the catalog lists a card with this set and
	// number. Asked once per visit, cache first.
	async function checkMatch() {
		if (readOnly || matchAsked || !card) {
			return;
		}

		matchAsked = true;
		match = await catalogMatch(card, card.entries[0].language).catch(() => null);

		if (alive) {
			drawLink();
		}
	}

	function drawLink() {
		if (!match || !card) {
			linkSlot.replaceChildren();

			return;
		}

		const {catalog, lang, set} = match;
		const found = match.card;
		const linkButton = h('button', {class: 'primary small', id: 'custom-link', type: 'button'}, 'Link to the catalog card');

		linkButton.addEventListener('click', async () => {
			linkButton.disabled = true;

			try {
				await updateCards(linkPatches(card.entries, {cardId: found.id, catalog}));
				toast('Linked to the catalog card. Photos, notes, and binder places stay.');
				go(`cards/${encodeURIComponent(lang)}/${encodeURIComponent(found.id)}`, {replace: true});
			}
			catch (err) {
				linkButton.disabled = false;
				toast(`Not linked. ${errorText(err)}`);
			}
		});

		linkSlot.replaceChildren(h('div', {class: 'notice custom-link', id: 'custom-link-offer', role: 'status'},
			h('p', null, `The catalog now has ${found.name || found.id}, number ${found.localId}, in ${set.name || set.id} (${catalog === 'international' ? 'international' : languageLabel(catalogLanguage(catalog))} catalog).`),
			h('p', {class: 'muted'}, 'Linking moves these copies onto it, with their photos, notes, and binder places, and brings its image and prices.'),
			linkButton
		));
	}

	async function draw() {
		let cards;
		let places = new Map();

		try {
			cards = await read();
			places = readOnly ? new Map() : await copyPlaces().catch(() => new Map());
		}
		catch (err) {
			if (alive) {
				body.replaceChildren(h('div', {class: 'notice', role: 'alert'}, h('p', null, `This card could not be read. ${errorText(err)}`)));
			}

			return;
		}

		if (!alive) {
			return;
		}

		card = customCard(cards, cardId);

		if (!card) {
			document.title = 'Hand-made card | Card Tracker';
			body.replaceChildren(h('div', {class: 'card empty-state', id: 'custom-gone'},
				h('p', {class: 'big'}, readOnly ? 'Not in these cards' : 'This hand-made card is not in your cards'),
				h('p', {class: 'muted'}, readOnly ? 'It may have been removed.' : 'Its copies were removed. Undo on the message brings them back.'),
				h('a', {class: 'button', 'data-link': 'cards', href: `${BASE}cards`}, 'Open My Cards')
			));

			return;
		}

		// A member's photos come with their copies, so the block is made
		// from them each time (read only).
		if (member) {
			photos.destroy();
			photos = cardPhotos({cardId, catalog: CUSTOM, entries: card.entries, readOnly: true});
		}

		drawCopies(places);
		body.replaceChildren(facts(), linkSlot, copies);
		drawLink();
		checkMatch();
	}

	root.append(h('div', {class: 'card-top'}, back()), body);
	draw();

	const stop = onChange(() => alive && draw());

	if (member && !member.name) {
		whenMemberName(member.userId, () => alive && draw());
	}

	return () => {
		alive = false;
		stop();
		closeCopySheet();
		photos.destroy();

		const sheet = document.getElementById('hand-sheet');

		if (sheet && sheet.open) {
			sheet.close();
		}
	};
}

