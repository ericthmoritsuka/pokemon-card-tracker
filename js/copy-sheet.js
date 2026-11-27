// Copies by hand (plans/audit-qa.md Q-01, plans/design-review.md "Card
// Detail"): the sheet that edits one copy's language, finish, condition,
// where it is stored, and notes, or removes it; the Places sheet that
// renames and removes storage places; the sheet that stores many copies in
// one place (My Cards); the sheet that adds copies of a card; and the count
// stepper ("-  N  +") on each row of Your copies and in a binder's pocket
// sheet. Card detail (js/catalog-views.js) and the binder view
// (js/binders-view.js) place them; none is shown in family view, which is
// read only.
//
// A removal is written at once, with Undo on a toast that brings the very
// same copies back (js/collection.js restoreCard), so their photos, binder
// pockets, and Liga prices come back with them.
//
// No picker wheel for the count: buttons plus typing work better with
// Android keyboards and screen readers (Eric, 2026-10-02).

import {listBinders, placements} from './binders.js';
import {addCopies, afterText, undoAdding} from './placeholder-fill.js';
import {
	cardInfoOf,
	cleanPlace,
	deleteCards,
	listCards,
	listPlaces,
	placeFold,
	removePlace,
	renamePlace,
	restoreCard,
	setCardNotes,
	setStorage,
	STORAGE_MAX,
	undoStorage,
	updateCard,
	updateCards,
} from './collection.js';
import {errorText, go, h} from './dom.js';
import {plural} from './format.js';
import {catalogFor, copyLanguageCodes, languageLabel} from './languages.js';
import {FINISHES, finishLabel} from './monprice.js';
import {formatBrl, isStandardSize} from './prices.js';
import {PRICE_FORM_TEXT, parsePrice, priceForInput, setPendingMove} from './moves.js';
import {pricePatches, salePrice as copySalePrice} from './shop.js';
import {CONDITIONS} from './scan/session.js';
import {openDialogSheet} from './sheet.js';
import {setAddAndSell, shopOwnerKnown, wantsAddAndSell} from './shop-owner.js';
import {toast} from './shell.js';
import {kitNamesText} from './kits.js';
import {kitNamesFor, withdrawListings} from './store-publish.js';

// The most copies one Add sheet makes: enough for a box of the same card,
// few enough that a slip of the thumb cannot add thousands (Q-08).
export const MAX_ADD = 20;

// The most a stepper's count can be typed up to.
export const MAX_COUNT = 999;

export const NOTES_MAX = 500;

// How long Undo stays on a toast.
export const UNDO_MS = 8000;

// A language's English name, from js/languages.js.
export const languageName = languageLabel;

// The languages a copy of a card in this catalog can be printed in
// (js/languages.js copyLanguageCodes). International records hold every
// Western print; a Japanese record also holds Korean copies of sets Korea
// prints under the Japanese codes (DESIGN.md section 5); a hand-made card
// can be in any language. current is kept when it is something else, so
// opening the sheet never changes a copy by itself.
export function copyLanguages(catalog, current = null) {
	const known = copyLanguageCodes(catalog);
	const codes = known.length ? known : [catalog];

	if (current && !codes.includes(current)) {
		codes.push(current);
	}

	return codes.map((code) => ({code, label: languageName(code)}));
}

// ---------------------------------------------------------- alike copies

// Copies are alike when they are the same card in the same catalog, in the
// same language, finish, and condition, stored in the same place. A row of
// Your copies holds alike copies, and the stepper counts them, so copies in
// two boxes are two rows, each with its own count and its own Stored in.
export const alikeKey = (entry) => JSON.stringify([
	entry.catalog || 'international',
	entry.card_id,
	entry.language || null,
	entry.variant_id || null,
	// An unmatched monprice finish tells copies apart only without a variant.
	entry.variant_id ? null : entry.finish_raw || null,
	entry.condition || null,
	entry.storage ? placeFold(entry.storage) : null,
]);

// What a copy added by + carries over from one alike: the card, language,
// finish, condition, where it is stored, and the source's names; never
// notes, photos, prices, or a binder pocket.
export function alikeFields(entry) {
	const fields = {
		card_id: entry.card_id,
		catalog: entry.catalog || 'international',
		language: entry.language,
		language_source: 'manual',
		variant_id: entry.variant_id || null,
	};

	// A hand-made card's own facts ride on every copy (js/custom-card.js).
	for (const key of ['condition', 'storage', 'fallback', 'name_local', 'set_name_local', 'number_local', 'set_code', 'dex_number']) {
		if (entry[key]) {
			fields[key] = entry[key];
		}
	}

	if (!entry.variant_id && entry.finish_raw) {
		fields.finish_raw = entry.finish_raw;
	}

	return fields;
}

// How many photos a copy shows: photos belong to the card in the copy's
// language (js/card-info.js), so they are read from that record, with any
// an older phone left on the copy that have not moved to it yet. record:
// the card's record, the person's own (collection.js cardInfoOf) when left
// out.
export function photoCount(entry, record = cardInfoOf(entry)) {
	const ids = new Set();
	const lists = [record && !record.deleted_at ? record.photos : null, entry && entry.photos];

	for (const photo of lists.flatMap((list) => (Array.isArray(list) ? list : []))) {
		if (photo && photo.id && !photo.deleted_at) {
			ids.add(photo.id);
		}
	}

	return ids.size;
}

// A copy that still holds a live photo itself: one an older phone took,
// waiting to upload before it moves to the card (js/card-info.js).
const holdsPhoto = (entry) => Boolean(entry) && Array.isArray(entry.photos) && entry.photos.some((photo) => photo && !photo.deleted_at);

// Where every placed copy is: Map entry id -> {binder_id, binder_name, page,
// position}.
// binders: a family member's list; your own when left out.
export async function copyPlaces(binders = null) {
	const placed = placements(binders || await listBinders());

	return new Map([...placed].map(([id, {binder, slot}]) => [id, {binder_id: binder.id, binder_name: binder.name, page: slot.page, position: slot.position}]));
}

export const placeText = (where) => `${where.binder_name}, page ${where.page}, pocket ${where.position}`;

const newestFirst = (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''));

// Which copies go when a count drops by n. First the copies in no binder
// pocket and holding no photo, newest first; the rest only when those run
// out. When the rest must be chosen among (more of them than are still to
// go), ask is {count, from} and the person picks; otherwise every one goes
// and ask is null. keep is a copy that never goes (the one in the pocket a
// binder's sheet is for).
//
// The card's photos are on its record (js/card-info.js), which every copy's
// removal keeps, so they never decide which copy goes; askWhich only names
// them (photoCount). A copy still holding a photo of its own (an older
// phone's, waiting to upload) goes last, since that phone never uploads a
// deleted copy's photo.
export function removalPlan(entries, n, {keep = null, places = new Map()} = {}) {
	const pool = entries.filter((entry) => entry.id !== keep);
	const free = pool.filter((entry) => !places.has(entry.id) && !holdsPhoto(entry)).sort(newestFirst);

	if (n <= free.length) {
		return {ask: null, chosen: free.slice(0, n)};
	}

	const rest = pool.filter((entry) => !free.includes(entry)).sort(newestFirst);
	const more = Math.min(n - free.length, rest.length);

	if (more >= rest.length) {
		return {ask: null, chosen: [...free, ...rest]};
	}

	return {ask: {count: more, from: rest}, chosen: free};
}

// The copies This copy can mean in a row of alike copies (QA, 2026-11-20:
// Set finish on a row named "Kanto 151 p9 #3" changed its copy in no
// pocket): [{value, label, entries}], each copy in a binder pocket by its
// pocket, in the row's order (the order its title names them), then the
// copies in none as one choice, value LOOSE, since nothing tells them
// apart. The first is the one the sheet opens with. Null when no copy is
// in a pocket, where any one of them is the same.
export const LOOSE = 'loose';

export function thisCopyChoices(entries, places = new Map()) {
	const placed = entries.filter((entry) => places.has(entry.id));

	if (!placed.length) {
		return null;
	}

	const loose = entries.filter((entry) => !places.has(entry.id));

	return [
		...placed.map((entry) => ({entries: [entry], label: placeText(places.get(entry.id)), value: entry.id})),
		...(loose.length ? [{entries: loose, label: loose.length === 1 ? 'Not in a binder' : `One of ${loose.length} not in a binder`, value: LOOSE}] : []),
	];
}

// The binder pockets some copies leave, as one sentence: "It leaves
// Binder A, page 3." places holds only the placed ones. Null for none.
export function leavesText(places) {
	const named = [...new Set(places.filter(Boolean).map((where) => `${where.binder_name}, page ${where.page}`))];

	if (!named.length) {
		return null;
	}

	const list = named.length === 1 ? named[0] : `${named.slice(0, -1).join('; ')} and ${named[named.length - 1]}`;

	return `${places.length === 1 ? 'It leaves' : 'They leave'} ${list}.`;
}

// Removes copies now, with Undo on a toast that restores them.
export async function removeWithUndo(entries, places = new Map()) {
	const ids = entries.map((entry) => entry.id);

	await deleteCards(ids);

	const what = ids.length === 1 ? `${languageName(entries[0].language)} copy removed.` : `${ids.length} copies removed.`;
	const leaves = leavesText(entries.map((entry) => places.get(entry.id)).filter(Boolean));

	toast(leaves ? `${what} ${leaves}` : what, {
		action: () => restoreCard(ids).catch((err) => toast(`Could not bring the copies back. ${errorText(err)}`)),
		actionLabel: 'Undo',
		timeout: UNDO_MS,
	});
}

// Adds n copies alike to entry, in one save, through
// js/placeholder-fill.js addCopies: the placeholders waiting for them are
// filled and the wishes they fit move to Got it. Resolves {added, placed,
// got, error}.
export async function addAlike(entry, n) {
	const fields = alikeFields(entry);

	return addCopies(Array.from({length: n}, () => ({...fields})));
}

// The toast after copies were added: `text`, then what went into binders
// and the wishlist, with Undo that takes all of it back.
export function toastAdded(text, result) {
	const more = afterText(result);

	toast(more ? `${text} ${more}` : text, {
		action: async () => {
			await undoAdding(result);
			await deleteCards(result.added.map((entry) => entry.id)).catch(() => {});
		},
		actionLabel: 'Undo',
		timeout: UNDO_MS,
	});
}

// The alike copies of entry on this phone now, and where the placed ones are.
async function alikeNow(entry) {
	const key = alikeKey(entry);
	const [cards, places] = await Promise.all([listCards(), copyPlaces().catch(() => new Map())]);

	return {entries: cards.filter((card) => alikeKey(card) === key), places};
}

// ------------------------------------------------------------ the sheets

function dialog(id, title) {
	let sheet = document.getElementById(id);

	if (!sheet) {
		sheet = h('dialog', {'aria-labelledby': `${id}-title`, class: `sheet ${id}`, id});
		sheet.addEventListener('click', (event) => {
			if (event.target === sheet) {
				sheet.close();
			}
		});
		document.body.append(sheet);
	}

	sheet.setAttribute('aria-label', title);

	return sheet;
}

// Shows a sheet: Back and Escape close it, and focus returns where it was
// (js/sheet.js).
function show(sheet, onClose = null) {
	if (!sheet.open) {
		openDialogSheet(sheet, {onClose});
	}

	return sheet;
}

const sheetElement = () => dialog('copy-sheet', 'Copy');

// Closes the copy sheets if they are open, for card detail's cleanup.
export function closeCopySheet() {
	for (const id of ['places-sheet', 'copy-pick-sheet', 'copy-sheet', 'store-sheet']) {
		const sheet = document.getElementById(id);

		if (sheet && sheet.open) {
			sheet.close();
		}
	}
}

// Asks which copies go when every copy left is in a pocket or has photos.
// Resolves with the chosen entries, or null when the sheet is closed.
export function askWhich({count, from, places = new Map(), title = null}) {
	const sheet = dialog('copy-pick-sheet', 'Which copy');
	let chosen = null;

	return new Promise((resolve) => {
		const close = () => sheet.close();
		const remove = h('button', {class: 'danger', disabled: true, id: 'copy-pick-remove', type: 'button'}, count === 1 ? 'Remove this copy' : `Remove these ${count}`);
		const boxes = from.map((entry) => h('input', {'data-entry': entry.id, name: 'copy-pick', type: count === 1 ? 'radio' : 'checkbox', value: entry.id}));
		const options = from.map((entry, i) => {
			const where = places.get(entry.id);
			const count = photoCount(entry);
			const photos = count ? `${count} ${count === 1 ? 'photo' : 'photos'}` : null;

			return h('label', {class: 'copy-pick-option'}, boxes[i], h('span', null, [where ? placeText(where) : 'Not in a binder', photos].filter(Boolean).join(' · ')));
		});

		for (const box of boxes) {
			box.addEventListener('change', () => {
				remove.disabled = boxes.filter((item) => item.checked).length !== count;
			});
		}

		remove.addEventListener('click', () => {
			const ids = new Set(boxes.filter((item) => item.checked).map((item) => item.value));

			chosen = from.filter((entry) => ids.has(entry.id));
			close();
		});

		sheet.replaceChildren(
			h('div', {class: 'sheet-head'},
				h('h2', {id: 'copy-pick-sheet-title'}, title || (count === 1 ? 'Which copy goes?' : `Which ${count} copies go?`)),
				h('button', {class: 'small', id: 'copy-pick-close', onclick: close, type: 'button'}, 'Cancel')
			),
			h('p', {class: 'muted copy-sub'}, 'Every copy left like this is in a binder pocket or has photos.'),
			h('div', {class: 'copy-pick-list'}, options),
			h('div', {class: 'copy-danger'}, remove)
		);
		show(sheet, () => resolve(chosen));
	});
}

const field = (label, id, control) => h('div', {class: 'copy-field'},
	h('label', {for: id}, label),
	control.tagName === 'SELECT' ? h('span', {class: 'select-wrap'}, control) : control
);

function select(id, options, value) {
	const control = h('select', {id, name: id},
		options.map((option) => h('option', {value: option.value}, option.label))
	);

	control.value = value;

	return control;
}

const NOT_SET = '';

const conditionOptions = () => [{label: 'Not set', value: NOT_SET}, ...CONDITIONS.map((condition) => ({label: condition, value: condition}))];

// A finish no catalog printing stands for, as the select tells it from a
// variant ID: "raw:" and monprice's word (js/monprice.js FINISHES).
const RAW = 'raw:';

// The finishes every card may be in, offered with the catalog's printings
// whenever the list has no plain print of that kind (Eric, 2026-11-18:
// "Sometimes they appear as 1st edition, but they are normal, or reverse
// holo, or holo"). TCGdex may list only a stamped print, so without them a
// plain copy could never be said to be plain.
const GENERIC = [['NORMAL', 'normal'], ['HOLOFOIL', 'holo'], ['REVERSE_HOLOFOIL', 'reverse']];

// The subtypes that still make a plain print: none, or Unlimited (the plain
// print of a set that also has a Shadowless or 1st Edition one), as
// js/monprice.js resolveFinish prefers them.
const PLAIN_SUBTYPES = new Set(['', 'unlimited']);

// The kind of plain print a variants_detailed entry is ('normal', 'holo',
// or 'reverse'), or null for anything with a stamp, a special foil, another
// size, or a subtype such as Shadowless.
export function plainKind(variant) {
	if (!variant || variant.foil || (variant.stamp || []).length || !isStandardSize(variant)) {
		return null;
	}

	if (!PLAIN_SUBTYPES.has(String(variant.subtype || '').trim().toLowerCase())) {
		return null;
	}

	const type = String(variant.type || '').trim().toLowerCase();

	return GENERIC.some(([, kind]) => kind === type) ? type : null;
}

// What a monprice word is called where it is not one of the catalog's
// printings: short, so the select stays one line at 360 px. While the
// catalog is not answering and the phone has no list of printings, the
// sheet cannot tell whether TCGdex lists the word, so it says why there is
// no list instead, as the copy's row does ("Finish (catalog offline)",
// js/catalog-views.js finishName).
const notListed = (word, offline) => `${finishLabel(word)} (${offline ? 'catalog offline' : 'not listed'})`;

// The finish select's options.
//   finishes  [{value: variantId, label, variant}] from the card's
//             variants_detailed (js/catalog-views.js finishChoices), or
//             monprice's words for a hand-made card (rawFinishes)
//   current   the select's value for the copy (finishValue): a variant ID
//             the list does not know (the catalog is not answering, or
//             TCGdex renamed it) or a word not offered is kept as it is
//   catalog   'custom' for a hand-made card, whose list already holds
//             every word
//   offline   true when the card page drew what the phone saved because
//             TCGdex failed (its unreachable notice). It counts only when
//             the list is empty: a saved list of printings still says what
//             TCGdex lists, and an empty list is not proof of a failure,
//             since a Japanese card with no variants online looks the same.
//             A current variant ID the list lacks says offline whenever
//             the card page does, as its row does (finishName)
export function finishOptions(finishes, current = null, catalog = null, offline = false) {
	const options = [{label: 'Not set', value: NOT_SET}, ...finishes.map(({label, value}) => ({label, value}))];
	const unknown = Boolean(offline) && !finishes.length;

	if (catalog !== 'custom') {
		const plain = new Set(finishes.map((option) => plainKind(option.variant)).filter(Boolean));

		for (const [word, kind] of GENERIC) {
			if (!plain.has(kind)) {
				options.push({label: notListed(word, unknown), value: RAW + word});
			}
		}
	}

	if (current && !options.some((option) => option.value === current)) {
		options.push({label: current.startsWith(RAW) ? notListed(current.slice(RAW.length), unknown) : offline ? 'Current finish (catalog offline)' : 'Current finish (not in the catalog list)', value: current});
	}

	return options;
}

// A hand-made card has no catalog printings: its finish is one of
// monprice's words, kept in finish_raw like an unmatched import's.
export const rawFinishes = () => Object.entries(FINISHES).map(([value, label]) => ({label, value}));

// The finish select's value for a copy: its variant ID, else its monprice
// word (an unmatched import, or a finish picked that the catalog does not
// list). A hand-made card's select holds the bare words.
export function finishValue(entry, catalog) {
	if (catalog === 'custom') {
		return entry.finish_raw || NOT_SET;
	}

	return entry.variant_id || (entry.finish_raw ? RAW + entry.finish_raw : NOT_SET);
}

// The fields a finish picked in the select sets. A catalog printing is its
// variant ID with no word, and a finish the catalog does not list is the
// word with no variant ID, as an unmatched monprice import stores it, so
// prices, tiles, the scanner tray, and the CSV treat both alike.
export function finishFields(value, catalog) {
	if (catalog === 'custom') {
		return {finish_raw: value || null};
	}

	if (value && value.startsWith(RAW)) {
		return {finish_raw: value.slice(RAW.length), variant_id: null};
	}

	return {finish_raw: null, variant_id: value || null};
}

function head(title, close) {
	return h('div', {class: 'sheet-head'},
		h('h2', {id: 'copy-sheet-title'}, title),
		h('button', {class: 'small', id: 'copy-sheet-close', onclick: close, type: 'button'}, 'Close')
	);
}

// The edit sheet for one row of Your copies.
//
//   card        {name, number} for the line under the title
//   entries     the row's copies, all alike (one or more)
//   catalog     the record's catalog
//   finishes    [{value, label}] for the finish select
//   places      Map entry id -> binder place, for the placed copies
//   offline     the card page is showing what the phone saved because
//               TCGdex failed (finishOptions)
// forSale, given to the shop owner only (js/catalog-views.js), maps each
// copy's id to {listed, price} as the Shop works it out (js/shop.js
// listingByCopy): with it, the sheet shows For sale on HOTARU. priceCopies,
// with it, maps each copy's id to every live copy of its finish (js/shop.js
// shopKey), whose one Shop price the sheet shows and saves as the Shop does.
export function openEditSheet({card, catalog, entries, finishes, forSale = null, offline = false, places = new Map(), priceCopies = null}) {
	const sheet = sheetElement();
	const first = entries[0];
	const many = entries.length > 1;
	const close = () => sheet.close();
	const error = h('p', {'aria-live': 'polite', class: 'form-error', id: 'copy-error'});

	const language = select('copy-language', copyLanguages(catalog, first.language).map(({code, label}) => ({label, value: code})), first.language);
	// The finish the copies have now, so a sheet only opened and closed
	// never rewrites it (a copy may carry a stale word beside its variant).
	const startFinish = finishValue(first, catalog);
	const finish = select('copy-finish', finishOptions(finishes, startFinish, catalog, offline), startFinish);
	const condition = select('copy-condition', conditionOptions(), CONDITIONS.includes(first.condition) ? first.condition : NOT_SET);
	// Notes belong to the card in the copy's language, shared by every copy
	// of it (js/card-info.js). Notes joined from several copies may run
	// past NOTES_MAX; they are never cut unless edited. The box shows the
	// notes of noteSource; a language picked before the notes are edited
	// shows that language's, and edited notes save to the language they
	// came from, so another language's notes are never overwritten.
	const notesOf = (language) => ({card_id: first.card_id, catalog: first.catalog, language});
	let noteSource = notesOf(first.language);
	let cardNotes = (cardInfoOf(noteSource) || {}).notes || '';
	let notesMax = Math.max(NOTES_MAX, cardNotes.length);
	const notes = h('textarea', {class: 'copy-notes', id: 'copy-notes', maxlength: notesMax, name: 'copy-notes', rows: 2}, cardNotes);

	language.addEventListener('change', () => {
		if (notes.value !== cardNotes) {
			return;
		}

		noteSource = notesOf(language.value);
		cardNotes = (cardInfoOf(noteSource) || {}).notes || '';
		notesMax = Math.max(NOTES_MAX, cardNotes.length);
		notes.maxLength = notesMax;
		notes.value = cardNotes;
	});
	// Alike copies are stored in one place (alikeKey).
	const storage = placePicker({id: 'copy-storage', value: first.storage});

	// For sale on HOTARU (plans/hotaru-for-sale-plan.md; Eric, 2026-11-24:
	// the mark is the listing). Ticked when the copies are offered now, by
	// the spare rule or a mark. Changing it marks them (true) or keeps them
	// (false); left alone, nothing is written and the spare rule goes on.
	const saleStates = forSale ? entries.map((entry) => forSale.get(entry.id) || {listed: false, price: null}) : null;
	const saleStart = Boolean(saleStates && saleStates.every((state) => state.listed));
	// The finish's Shop price (js/shop.js groupPrice: any copy's, as all
	// hold it), shown and edited here; one finish keeps one price.
	const finishCopies = saleStates && priceCopies ? priceCopies.get(first.id) || entries : null;
	const startPrice = saleStates
		? (saleStates.find((state) => state.price !== null) || {price: (finishCopies || []).map(copySalePrice).find((value) => value !== null) ?? null}).price
		: null;
	const priceInput = finishCopies
		? h('input', {'aria-describedby': 'copy-for-sale-hint', autocomplete: 'off', class: 'copy-sale-price', id: 'copy-sale-price', inputmode: 'decimal', placeholder: 'No price', type: 'text', value: priceForInput(startPrice)})
		: null;
	const typedPrice = () => (priceInput ? parsePrice(priceInput.value) : {error: null, value: startPrice});
	const priceNow = () => {
		const typed = typedPrice();

		return typed.error ? startPrice : typed.value;
	};
	const pricePatchList = () => (finishCopies && priceNow() !== startPrice ? pricePatches([{copies: finishCopies}], priceNow()) : []);
	const saleBox = saleStates ? h('input', {'aria-describedby': 'copy-for-sale-hint', checked: saleStart, class: 'copy-for-sale-box', id: 'copy-for-sale', type: 'checkbox'}) : null;
	const saleHint = saleStates ? h('p', {class: 'muted copy-for-sale-hint', id: 'copy-for-sale-hint'}) : null;
	const saleChange = () => (saleBox && saleBox.checked !== saleStart ? {for_sale: saleBox.checked} : {});
	// The kits on HOTARU that hold these copies (v114), read once as the
	// sheet opens, so the hint says what For sale does to them.
	let kitNames = [];

	function drawSaleHint() {
		if (!saleBox) {
			return;
		}

		const place = entries.map((entry) => places.get(entry.id)).find(Boolean);
		const lines = saleBox.checked
			? [
				typedPrice().error ? PRICE_FORM_TEXT : priceNow() === null ? 'Not on HOTARU until this finish has a price in the Shop.' : `On HOTARU at ${formatBrl(priceNow())}.`,
				place ? `It leaves ${placeText(place)} when it sells.` : null,
				first.is_favorite === true ? 'A favorite: For sale lists it anyway.' : null,
				kitNames.length ? `In ${kitNamesText(kitNames)}: it sells alone or in the kit.` : null,
			]
			: [saleStart ? `Kept: it comes off HOTARU when you close this${kitNames.length ? `, and ${kitNamesText(kitNames)} with it` : ''}.` : 'Not for sale.'];

		saleHint.textContent = lines.filter(Boolean).join(' ');
	}

	if (saleBox) {
		saleBox.addEventListener('change', drawSaleHint);

		if (priceInput) {
			priceInput.addEventListener('input', drawSaleHint);
		}

		drawSaleHint();

		if (saleStart) {
			kitNamesFor(entries.map((entry) => entry.id)).then((names) => {
				kitNames = names;

				if (names.length) {
					drawSaleHint();
				}
			});
		}
	}

	const saleField = saleBox
		? h('div', {class: 'copy-field copy-for-sale'},
			h('label', {class: 'copy-for-sale-label', for: 'copy-for-sale'}, saleBox, ' For sale on HOTARU'),
			priceInput ? h('label', {class: 'copy-sale-price-label', for: 'copy-sale-price'}, 'Shop price for this finish, R$') : null,
			priceInput,
			saleHint)
		: null;

	// A row of alike copies changes one of them, or all of them. The choice
	// sits first, named and explained, because a holo among normal copies
	// is told apart by changing one copy (Eric, 2026-11-18: "Sometimes I
	// have a holo and a non holo copy"); that copy then has its own row.
	// This copy is the one in the pocket the row names, and Which copy under
	// the choice says so and picks another (thisCopyChoices; QA,
	// 2026-11-20); in a row with no copy in a pocket, the copy a minus
	// would take (removalPlan).
	let scope = 'one';
	const choices = many ? thisCopyChoices(entries, places) : null;
	const which = choices ? select('copy-which', choices, choices[0].value) : null;
	const whichField = which ? field('Which copy', 'copy-which', which) : null;
	const scopeChoice = many
		? h('div', {class: 'copy-field copy-scope-field'},
			h('span', {class: 'copy-scope-label', id: 'copy-scope-label'}, 'Change'),
			h('div', {'aria-describedby': 'copy-scope-hint', 'aria-labelledby': 'copy-scope-label', class: 'segmented copy-scope', role: 'radiogroup'},
				[['one', 'This copy'], ['all', `All ${entries.length}`]].map(([value, label]) => h('label', null,
					h('input', {checked: value === scope, name: 'copy-scope', onchange: () => {
						scope = value;
						drawWhich();
					}, type: 'radio', value}),
					h('span', null, label)
				))),
			h('p', {class: 'muted copy-scope-hint', id: 'copy-scope-hint'}, 'Change one copy to give it its own finish. It then shows as its own row.')
		)
		: null;
	// The copy picked in Which copy: {entries, fixed}, fixed when it names
	// one copy (one in a pocket), else the copies one is taken from.
	const picked = () => {
		const choice = choices && choices.find((item) => item.value === which.value);

		return choice ? {entries: choice.entries, fixed: choice.value !== LOOSE} : {entries, fixed: false};
	};
	const one = () => {
		const {entries: pool, fixed} = picked();

		if (fixed) {
			return pool;
		}

		const plan = removalPlan(pool, 1, {places});

		return plan.chosen.length ? plan.chosen : [[...pool].sort(newestFirst)[0]];
	};
	const targets = () => (scope === 'all' ? entries : one());

	const remove = h('button', {class: 'danger', id: 'copy-remove', type: 'button'});
	const leaves = h('p', {class: 'muted copy-leaves', id: 'copy-leaves'});

	function drawRemove() {
		const chosen = targets();
		const text = leavesText(chosen.map((entry) => places.get(entry.id)).filter(Boolean));

		remove.textContent = chosen.length === 1 ? 'Remove copy' : `Remove ${chosen.length} copies`;
		leaves.textContent = text ? `${text.replace(/\.$/, '')} when removed.` : '';
		leaves.hidden = !text;
	}

	// Which copy shows only while one copy is changed.
	function drawWhich() {
		if (whichField) {
			whichField.hidden = scope === 'all';
		}

		drawRemove();
	}

	if (which) {
		which.addEventListener('change', drawRemove);
	}

	drawWhich();

	remove.addEventListener('click', async () => {
		let chosen = targets();

		// Removing is not an edit: the sheet closes without saving.
		settled = true;

		// One copy from copies where every one is in a pocket or has photos,
		// and none was picked by its pocket: ask which.
		if (scope === 'one' && !picked().fixed) {
			const plan = removalPlan(picked().entries, 1, {places});

			if (plan.ask) {
				close();

				const picked = await askWhich({...plan.ask, places});

				if (!picked) {
					return;
				}

				chosen = picked;
			}
		}

		close();

		try {
			await removeWithUndo(chosen, places);
		}
		catch (err) {
			toast(`Not removed. ${errorText(err)}`);
		}
	});

	// Trade or sale (js/moves-view.js): the copies this sheet would change,
	// taken to Log a trade or sale, where the rest is chosen. It was "Sell
	// or trade", the same action under a second name (design polish,
	// 2026-11-06: one term per concept).
	const move = h('button', {id: 'copy-move', type: 'button'}, 'Trade or sale');

	// The route change closes the sheet (js/sheet.js), its history entry
	// becoming the new screen's.
	move.addEventListener('click', () => {
		setPendingMove({out: targets().map((entry) => entry.id)});
		go('trades/new');
	});

	const form = h('form', {class: 'copy-form', id: 'copy-form'},
		scopeChoice,
		whichField,
		field('Language', 'copy-language', language),
		field('Finish', 'copy-finish', finish),
		field('Condition', 'copy-condition', condition),
		field('Stored in', 'copy-storage', storage.element),
		saleField,
		field('Notes', 'copy-notes', notes),
		error,
		h('button', {class: 'primary', id: 'copy-save', type: 'submit'}, 'Save')
	);

	// Closing saves (Eric, 2026-11-17: copies changed to reverse holo after
	// a scan were lost when he closed this sheet without Save, and the
	// scanner's own sheet keeps a finish as soon as it is tapped). Close,
	// Back, Escape, a tap outside, and leaving the card all save what
	// changed, as Save does; only Remove closes without saving. The toast
	// offers Undo, which puts the fields back as they were.
	let settled = false;
	let open = true;

	// What the fields would change, read as they are now; null when
	// nothing would.
	function pending() {
		const patches = targets().map((entry) => ({id: entry.id, patch: {...changes(entry, catalog, {
			condition: condition.value || null,
			language: language.value,
			storage: storage.value(),
			...(finish.value === startFinish ? {} : finishFields(finish.value, catalog)),
		}), ...saleChange()}})).filter((item) => Object.keys(item.patch).length);

		// The price goes on every copy of the finish, exactly as the Shop's
		// price field saves it (js/shop.js pricePatches).
		for (const {id, patch} of pricePatchList()) {
			const same = patches.find((item) => item.id === id);

			if (same) {
				Object.assign(same.patch, patch);
			}
			else {
				patches.push({id, patch});
			}
		}

		const typed = notes.value.trim().slice(0, notesMax);
		const notesBefore = (cardInfoOf(noteSource) || {}).notes || '';
		const noteChanged = notes.value !== cardNotes && typed !== notesBefore;

		if (!patches.length && !noteChanged) {
			return null;
		}

		// Undo's patches, taken before the write: saving changes the
		// entries in place.
		const back = patches.map(({id, patch}) => {
			const entry = entries.find((item) => item.id === id) || (finishCopies || []).find((item) => item.id === id);

			return {id, patch: Object.fromEntries(Object.keys(patch).map((key) => [key, key === 'fallback' ? Boolean(entry.fallback) : entry[key] ?? null]))};
		});

		return {back, noteChanged, notesBefore, noteSource, patches, typed};
	}

	async function write({noteChanged, noteSource: source, patches, typed}) {
		if (noteChanged) {
			await setCardNotes(source, typed);
		}

		if (patches.length === 1) {
			await updateCard(patches[0].id, patches[0].patch);
		}
		else if (patches.length) {
			await updateCards(patches);
		}
	}

	// Each changed field back to what the copy had when the sheet opened.
	async function unwrite({back, noteChanged, notesBefore, noteSource: source}) {
		if (back.length) {
			await updateCards(back);
		}

		if (noteChanged) {
			await setCardNotes(source, notesBefore);
		}
	}

	// Taken off sale: off HOTARU at once, as the star does, so no order can
	// come for a copy that is kept (supabase/store-withdraw.sql). Put on
	// sale: the Shop publishes it the next time it opens.
	async function afterSale(change) {
		const kept = change.patches.filter(({patch}) => patch.for_sale === false).map(({id}) => id);

		if (!kept.length) {
			return change.patches.some(({patch}) => patch.for_sale === true) ? ' It goes on HOTARU when you tap Publish changes in the Shop.' : '';
		}

		try {
			const gone = await withdrawListings(kept);

			return gone.length ? ` Taken off HOTARU (${plural(gone.length, 'copy', 'copies')}).` : '';
		}
		catch {
			return ' It leaves HOTARU the next time you open the Shop online.';
		}
	}

	async function saved(change) {
		const n = change.patches.length;
		const sale = await afterSale(change);

		toast(n ? `${n === 1 ? 'Copy saved.' : `${n} copies saved.`}${sale}` : 'Notes saved.', {
			action: () => unwrite(change).catch((err) => toast(`Could not undo. ${errorText(err)}`)),
			actionLabel: 'Undo',
			timeout: UNDO_MS,
		});
	}

	// The sheet closed, however it closed.
	function closed() {
		open = false;

		if (settled) {
			return;
		}

		settled = true;

		const change = pending();

		if (change) {
			write(change).then(() => saved(change), (err) => toast(`Not saved. ${errorText(err)}`));
		}
	}

	form.addEventListener('submit', async (event) => {
		event.preventDefault();

		if (settled) {
			return;
		}

		error.textContent = '';
		settled = true;

		const change = pending();

		try {
			if (change) {
				await write(change);
			}
		}
		catch (err) {
			settled = false;

			if (open) {
				error.textContent = `Not saved. ${errorText(err)}`;
			}
			else {
				toast(`Not saved. ${errorText(err)}`);
			}

			return;
		}

		close();

		if (change) {
			saved(change);
		}
	});

	const placed = entries.map((entry) => places.get(entry.id)).filter(Boolean);

	sheet.replaceChildren(
		head(many ? `Edit copies (${entries.length} alike)` : 'Edit copy', close),
		h('p', {class: 'muted copy-sub'}, [card.name, card.number, placed.length === 1 && !many ? placeText(placed[0]) : null].filter(Boolean).join(' · ')),
		form,
		h('div', {class: 'copy-danger'}, h('div', {class: 'copy-danger-row'}, move, remove), leaves)
	);

	return show(sheet, closed);
}

// Only what changed, so an untouched field is never stamped as edited and
// a copy keeps fields it never had.
export function changes(entry, catalog, next) {
	const patch = {};

	if (next.language !== entry.language) {
		patch.language = next.language;
		patch.language_source = 'manual';
	}

	// A copy whose language belongs to another catalog (a Korean copy on a
	// Japanese record) is a fallback match (DESIGN.md section 5). A
	// hand-made card belongs to no catalog, so it never is.
	const fallback = catalog !== 'custom' && catalogFor(next.language) !== catalog;

	if (fallback !== Boolean(entry.fallback)) {
		patch.fallback = fallback;
	}

	if (next.variant_id !== undefined && (next.variant_id || null) !== (entry.variant_id || null)) {
		patch.variant_id = next.variant_id || null;
	}

	if (next.finish_raw !== undefined && (next.finish_raw || null) !== (entry.finish_raw || null)) {
		patch.finish_raw = next.finish_raw || null;
	}

	if ((next.condition || null) !== (entry.condition || null)) {
		patch.condition = next.condition || null;
	}

	if (next.notes !== undefined && (next.notes || '') !== (entry.notes || '')) {
		patch.notes = next.notes || null;
	}

	if (next.storage !== undefined && (cleanPlace(next.storage) || null) !== (entry.storage || null)) {
		patch.storage = cleanPlace(next.storage) || null;
	}

	return patch;
}

// The sheet that adds copies of a card.
//
//   card        {id, name, number}
//   catalog     the record's catalog
//   lang        the language the card is viewed in, picked first
//   finishes    [{value, label}]
//   plain       the plain print's variantId, picked first (the scanner's
//               rule: never the last finish chosen)
//   extra       fields every new copy carries: a hand-made card's own
//               facts (js/custom-card.js)
//   offline     as openEditSheet's
export function openAddSheet({card, catalog, extra = null, finishes, lang, offline = false, plain = null}) {
	const sheet = sheetElement();
	const close = () => sheet.close();
	const languages = copyLanguages(catalog);
	const error = h('p', {'aria-live': 'polite', class: 'form-error', id: 'copy-error'});

	const language = select('copy-language', languages.map(({code, label}) => ({label, value: code})), languages.some((item) => item.code === lang) ? lang : languages[0].code);
	const finish = select('copy-finish', finishOptions(finishes, null, catalog, offline), plain && finishes.some((option) => option.value === plain) ? plain : NOT_SET);
	const condition = select('copy-condition', conditionOptions(), NOT_SET);
	const storage = placePicker({id: 'copy-storage'});
	const count = h('input', {class: 'search copy-count', id: 'copy-count', inputmode: 'numeric', max: MAX_ADD, min: 1, name: 'copy-count', step: 1, type: 'number', value: 1});
	const submit = h('button', {class: 'primary', id: 'copy-add-save', type: 'submit'}, 'Add 1 copy');

	const howMany = () => {
		const n = Number.parseInt(count.value, 10);

		return Number.isInteger(n) && n >= 1 && n <= MAX_ADD ? n : null;
	};

	count.addEventListener('input', () => {
		const n = howMany();

		submit.textContent = n ? `Add ${n} ${n === 1 ? 'copy' : 'copies'}` : 'Add copies';
	});

	// For sale on HOTARU, for the shop owner (plans/hotaru-for-sale-plan.md,
	// Add and sell): the copies added are marked For sale, and a price typed
	// here is their finish's sale price. Ticked when the Shop's Add and sell
	// sent the owner here (js/shop-owner.js).
	const owner = shopOwnerKnown() === true;
	const saleBox = owner ? h('input', {checked: wantsAddAndSell(), class: 'copy-for-sale-box', id: 'copy-add-for-sale', type: 'checkbox'}) : null;
	const salePriceInput = owner ? h('input', {autocomplete: 'off', class: 'search copy-sale-price', id: 'copy-add-sale-price', inputmode: 'decimal', placeholder: 'Not priced', type: 'text'}) : null;
	const salePriceField = owner ? field('Sale price (R$)', 'copy-add-sale-price', salePriceInput) : null;
	const drawSale = () => {
		if (salePriceField) {
			salePriceField.hidden = !saleBox.checked;
		}
	};

	if (saleBox) {
		saleBox.addEventListener('change', drawSale);
		drawSale();
	}

	const saleField = saleBox
		? h('div', {class: 'copy-field copy-for-sale'}, h('label', {class: 'copy-for-sale-label', for: 'copy-add-for-sale'}, saleBox, ' For sale on HOTARU'))
		: null;

	// novalidate: the sheet says what is wrong in its own words.
	const form = h('form', {class: 'copy-form', id: 'copy-form', novalidate: true},
		field('Language', 'copy-language', language),
		field('Finish', 'copy-finish', finish),
		field('Condition', 'copy-condition', condition),
		field('Stored in', 'copy-storage', storage.element),
		field(`How many (1 to ${MAX_ADD})`, 'copy-count', count),
		saleField,
		salePriceField,
		error,
		submit
	);

	form.addEventListener('submit', async (event) => {
		event.preventDefault();
		error.textContent = '';

		const n = howMany();

		if (!n) {
			error.textContent = `Choose from 1 to ${MAX_ADD} copies.`;
			count.focus();

			return;
		}

		const chosen = finishFields(finish.value, catalog);
		const fields = {...extra, card_id: card.id, catalog, language: language.value, language_source: 'manual', variant_id: chosen.variant_id || null};

		if (chosen.finish_raw) {
			fields.finish_raw = chosen.finish_raw;
		}

		if (catalog !== 'custom' && catalogFor(language.value) !== catalog) {
			fields.fallback = true;
		}

		if (condition.value) {
			fields.condition = condition.value;
		}

		if (storage.value()) {
			fields.storage = storage.value();
		}

		const selling = Boolean(saleBox && saleBox.checked);

		if (selling) {
			fields.for_sale = true;

			const typed = salePriceInput.value.trim() ? parsePrice(salePriceInput.value) : {error: null, value: null};

			if (typed.error) {
				error.textContent = typed.error;
				salePriceInput.focus();

				return;
			}

			if (typed.value !== null) {
				fields.sale_price = typed.value;
			}
		}

		submit.disabled = true;

		let result;

		try {
			result = await addCopies(Array.from({length: n}, () => ({...fields})));
		}
		catch (err) {
			submit.disabled = false;
			error.textContent = `Not added. ${errorText(err)}`;

			return;
		}

		close();

		if (selling) {
			setAddAndSell(false);
		}

		toastAdded(`Added ${n} ${languageName(language.value)} ${n === 1 ? 'copy' : 'copies'}.${selling ? ' For sale: it goes on HOTARU when you tap Publish changes in the Shop.' : ''}`, result);
	});

	sheet.replaceChildren(
		head('Add a copy', close),
		h('p', {class: 'muted copy-sub'}, [card.name, card.number].filter(Boolean).join(' · ')),
		form
	);

	return show(sheet);
}

// ------------------------------------------------------ where it is stored

// A row's Stored in line on card detail, read only too: "Stored in Bulk box
// A". Null when the row's copies are stored nowhere. A copy in a binder
// pocket shows its pocket as well; the place says where the binder or the
// copy lives, and neither is made up from the other.
export function storedLine(entries) {
	const name = cleanPlace(entries && entries[0] && entries[0].storage);

	return name ? h('span', {class: 'copy-stored'}, `Stored in ${name}`) : null;
}

// How many place chips show before More.
const QUICK_PLACES = 8;

// The Stored in field: a text field (at most STORAGE_MAX characters) with
// the saved places as chips under it, most used first, and Not set first
// of all, so a tap is enough and typing is for a new place. Manage places
// opens the Places sheet over the sheet it sits in.
//
//   id      the text field's id; a label's for points at it
//   value   the place to start with
// Returns {element, refresh(), value()}, value() being the place as typed,
// cleaned ("" for Not set).
export function placePicker({id = 'copy-storage', value = ''} = {}) {
	let places = [];
	let expanded = false;

	const input = h('input', {
		autocapitalize: 'sentences',
		autocomplete: 'off',
		class: 'search place-input',
		enterkeyhint: 'done',
		id,
		list: `${id}-list`,
		maxlength: STORAGE_MAX,
		name: id,
		placeholder: 'Not set: tap a place or type one',
		type: 'text',
		value: cleanPlace(value),
	});
	const datalist = h('datalist', {id: `${id}-list`});
	const chips = h('div', {'aria-label': 'Saved places', class: 'place-chips', id: `${id}-chips`, role: 'group'});

	const chip = (label, place, on) => h('button', {
		'aria-pressed': String(on),
		class: 'chip place-chip',
		'data-place': place,
		onclick: () => {
			input.value = place;
			draw();
			chips.querySelector(`[data-place="${CSS.escape(place)}"]`)?.focus();
		},
		type: 'button',
	}, label);

	function draw() {
		const current = placeFold(input.value);
		const shown = expanded ? places : places.slice(0, QUICK_PLACES);

		datalist.replaceChildren(...places.map((place) => h('option', {value: place.name})));
		chips.replaceChildren(...[
			chip('Not set', '', !current),
			...shown.map((place) => chip(place.name, place.name, placeFold(place.name) === current)),
			places.length > shown.length
				? h('button', {class: 'chip place-more', onclick: () => {
					expanded = true;
					draw();
				}, type: 'button'}, `More (${places.length - shown.length})`)
				: null,
		].filter(Boolean));
	}

	async function refresh() {
		try {
			places = await listPlaces();
		}
		catch {
			// No places this time; typing still works.
		}

		draw();
	}

	input.addEventListener('input', draw);

	// What the Places sheet changed follows into the field, so saving the
	// sheet under it does not bring a renamed or removed place back.
	const manage = h('button', {class: 'link-button place-manage', id: `${id}-manage`, onclick: () => openPlacesSheet({onClose: ({removed, renamed}) => {
		const fold = placeFold(input.value);

		if (renamed.has(fold)) {
			input.value = renamed.get(fold);
		}
		else if (removed.has(fold)) {
			input.value = '';
		}

		refresh();
	}}), type: 'button'}, 'Manage places');

	draw();
	refresh();

	return {
		element: h('div', {class: 'place-picker'}, input, datalist, chips, manage),
		refresh,
		value: () => cleanPlace(input.value),
	};
}

// Undo for a change to places: on a toast, and in the Places sheet's own
// status line while it is open (a toast under an open sheet cannot be
// tapped). Either one undoes it, once.
function offerUndo(message, undo, {after = null, status = null} = {}) {
	let used = false;
	const run = async () => {
		if (used) {
			return;
		}

		used = true;

		try {
			await undoStorage(undo);

			if (status && status.isConnected) {
				status.replaceChildren(h('span', null, 'Undone.'));
			}

			if (after) {
				after();
			}
		}
		catch (err) {
			toast(`Could not undo. ${errorText(err)}`);
		}
	};

	if (status) {
		status.replaceChildren(
			h('span', null, message),
			h('button', {class: 'small', id: 'places-undo', onclick: run, type: 'button'}, 'Undo')
		);
	}

	toast(message, {action: run, actionLabel: 'Undo', timeout: UNDO_MS});
}

const copiesText = (n) => (n ? plural(n, 'copy', 'copies') : 'No copies');

// The Places sheet: every saved place with how many copies are stored
// there, to rename (every copy follows) or remove (its copies show Not set;
// asked first when copies are stored there). Both with Undo. onClose gets
// {renamed: Map old folded name -> new name, removed: Set of folded names}.
export function openPlacesSheet({onClose = null} = {}) {
	const sheet = dialog('places-sheet', 'Places');
	const renamed = new Map();
	const removed = new Set();
	const close = () => sheet.close();
	const status = h('div', {'aria-live': 'polite', class: 'places-status', id: 'places-status'});
	const list = h('ul', {class: 'places-list', id: 'places-list'});
	// The place being renamed, or asked about before removing, by folded name.
	let editing = null;
	let asking = null;

	async function rename(place, text) {
		const fold = placeFold(place.name);

		try {
			const done = await renamePlace(place.name, text);

			editing = null;
			renamed.set(fold, done.name);
			removed.delete(fold);
			offerUndo(`Renamed to ${done.name}${done.changed ? `, ${plural(done.changed, 'copy', 'copies')} updated` : ''}.`, done.undo, {
				after: () => {
					renamed.delete(fold);
					draw();
				},
				status,
			});
		}
		catch (err) {
			status.replaceChildren(h('span', {class: 'form-error'}, `Not renamed. ${errorText(err)}`));
		}

		draw(fold);
	}

	async function remove(place) {
		const fold = placeFold(place.name);

		try {
			const done = await removePlace(place.name);

			asking = null;
			removed.add(fold);
			offerUndo(`${place.name} removed${done.changed ? `, ${plural(done.changed, 'copy', 'copies')} now Not set` : ''}.`, done.undo, {
				after: () => {
					removed.delete(fold);
					draw();
				},
				status,
			});
		}
		catch (err) {
			status.replaceChildren(h('span', {class: 'form-error'}, `Not removed. ${errorText(err)}`));
		}

		draw();
	}

	function row(place, i) {
		const fold = placeFold(place.name);
		const label = h('span', {class: 'place-name'}, place.name);
		const count = h('span', {class: 'muted place-count'}, copiesText(place.count));

		if (editing === fold) {
			const field = h('input', {'aria-label': `New name for ${place.name}`, autocomplete: 'off', class: 'search place-input', id: `places-name-${i}`, maxlength: STORAGE_MAX, type: 'text', value: place.name});
			const form = h('form', {class: 'place-rename'},
				field,
				h('div', {class: 'place-actions'},
					h('button', {class: 'small', onclick: () => {
						editing = null;
						draw(fold);
					}, type: 'button'}, 'Cancel'),
					h('button', {class: 'small primary', type: 'submit'}, 'Save')
				)
			);

			form.addEventListener('submit', (event) => {
				event.preventDefault();

				if (!cleanPlace(field.value)) {
					status.replaceChildren(h('span', {class: 'form-error'}, 'A place needs a name.'));
					field.focus();

					return;
				}

				rename(place, field.value);
			});

			return h('li', {class: 'place-row', 'data-place': place.name}, form);
		}

		if (asking === fold) {
			return h('li', {class: 'place-row place-asking', 'data-place': place.name},
				h('span', {class: 'place-text'}, label),
				h('p', {class: 'place-ask'}, `${plural(place.count, 'copy is', 'copies are')} stored here; ${place.count === 1 ? 'it' : 'they'} will show Not set.`),
				h('div', {class: 'place-actions'},
					h('button', {class: 'small', onclick: () => {
						asking = null;
						draw(fold);
					}, type: 'button'}, 'Cancel'),
					h('button', {class: 'small danger place-remove-yes', onclick: () => remove(place), type: 'button'}, 'Remove')
				)
			);
		}

		return h('li', {class: 'place-row', 'data-place': place.name},
			h('span', {class: 'place-text'}, label, count),
			h('div', {class: 'place-actions'},
				h('button', {'aria-label': `Rename ${place.name}`, class: 'small place-rename-open', onclick: () => {
					editing = fold;
					asking = null;
					draw(fold);
				}, type: 'button'}, 'Rename'),
				h('button', {'aria-label': `Remove ${place.name}`, class: 'small place-remove', onclick: () => {
					if (place.count) {
						asking = fold;
						editing = null;
						draw(fold);
					}
					else {
						remove(place);
					}
				}, type: 'button'}, 'Remove')
			)
		);
	}

	// Redraws the list; focus goes to the row it was about (its first
	// control), or stays in the sheet.
	async function draw(focusFold = null) {
		let places = [];

		try {
			places = await listPlaces();
		}
		catch (err) {
			status.replaceChildren(h('span', {class: 'form-error'}, `The places could not be read. ${errorText(err)}`));
		}

		list.replaceChildren(...(places.length
			? places.map(row)
			: [h('li', {class: 'muted places-none'}, 'No places yet. Type one in a copy\'s Stored in field.')]));

		if (focusFold !== null && sheet.open) {
			const target = [...list.querySelectorAll('.place-row')].find((item) => placeFold(item.dataset.place) === focusFold);
			const control = target && target.querySelector('input, button');

			(control || sheet.querySelector('#places-close')).focus();
		}
	}

	sheet.replaceChildren(
		h('div', {class: 'sheet-head'},
			h('h2', {id: 'places-sheet-title'}, 'Places'),
			h('button', {class: 'small', id: 'places-close', onclick: close, type: 'button'}, 'Done')
		),
		h('p', {class: 'muted copy-sub'}, 'Where your copies are stored. Renaming a place renames it on every copy stored there.'),
		list,
		status
	);
	draw();

	return show(sheet, () => {
		if (onClose) {
			onClose({removed, renamed});
		}
	});
}

// Stores many copies in one place at once: My Cards' "Set storage for
// these N copies", and its bulk select's Stored in. entries are the copies;
// the field starts on their place when they share one. sub is the line
// under the title, saying which copies these are. Undo on a toast puts
// every copy back.
export function openStoreSheet({entries, sub = null}) {
	const sheet = dialog('store-sheet', 'Stored in');
	const close = () => sheet.close();
	const n = entries.length;
	const folds = new Set(entries.map((entry) => placeFold(entry.storage)));
	const picker = placePicker({id: 'store-place', value: folds.size === 1 ? entries[0].storage : ''});
	const error = h('p', {'aria-live': 'polite', class: 'form-error', id: 'store-error'});
	const submit = h('button', {class: 'primary', id: 'store-save', type: 'submit'}, `Save for ${plural(n, 'copy', 'copies')}`);
	const form = h('form', {class: 'copy-form', id: 'store-form'},
		field('Stored in', 'store-place', picker.element),
		error,
		submit
	);

	form.addEventListener('submit', async (event) => {
		event.preventDefault();
		error.textContent = '';
		submit.disabled = true;

		try {
			const done = await setStorage(entries.map((entry) => entry.id), picker.value());

			close();

			if (!done.changed) {
				toast(done.name ? `Every copy is already stored in ${done.name}.` : 'No copy had a place to clear.');

				return;
			}

			offerUndo(done.name
				? `${plural(done.changed, 'copy', 'copies')} stored in ${done.name}.`
				: `Stored in cleared on ${plural(done.changed, 'copy', 'copies')}.`, done.undo);
		}
		catch (err) {
			submit.disabled = false;
			error.textContent = `Not saved. ${errorText(err)}`;
		}
	});

	sheet.replaceChildren(
		h('div', {class: 'sheet-head'},
			h('h2', {id: 'store-sheet-title'}, 'Stored in'),
			h('button', {class: 'small', id: 'store-close', onclick: close, type: 'button'}, 'Close')
		),
		h('p', {class: 'muted copy-sub', id: 'store-sub'}, sub || `${plural(n, 'copy', 'copies')}: the ones My Cards shows now. Not set clears their place.`),
		form
	);

	return show(sheet);
}

// ------------------------------------------------------------ the stepper

// "-  N  +" for a set of alike copies. + adds one copy alike at once; -
// removes one (removalPlan picks which, or asks) with Undo on a toast; the
// number can be typed, 0 to 999, and the difference is added or removed.
//
//   entries     the alike copies now (at least one, the pattern for +)
//   places      Map entry id -> binder place
//   label       what the copies are, for screen readers ("Portuguese,
//               Normal")
//   keep        a copy that never goes, and min 1: the copy in the pocket a
//               binder's sheet is for
//   min         the lowest count (0 on card detail, where 0 removes the row)
//   onChange    (count) => void after a change is written
export function copyStepper({entries, keep = null, label, min = 0, onChange = null, places = new Map()}) {
	const pattern = entries.find((entry) => entry.id === keep) || [...entries].sort(newestFirst)[0];
	let state = {entries, places};
	let busy = false;

	const less = h('button', {'aria-label': `One copy fewer: ${label}`, class: 'step step-less', type: 'button'}, '−');
	const more = h('button', {'aria-label': `One copy more: ${label}`, class: 'step step-more', type: 'button'}, '+');
	const count = h('input', {
		'aria-label': `Number of copies: ${label}`,
		class: 'step-count',
		enterkeyhint: 'done',
		inputmode: 'numeric',
		max: MAX_COUNT,
		min,
		type: 'number',
	});
	const element = h('div', {class: 'copy-stepper', role: 'group', 'aria-label': `Copies: ${label}`}, less, count, more);

	function draw() {
		const n = state.entries.length;

		// Never disabled while busy: a disabled button drops the focus. A tap
		// while a change is being written is ignored instead.
		count.value = String(n);
		less.disabled = n <= min;
		more.disabled = n >= MAX_COUNT;
		element.setAttribute('aria-busy', busy ? 'true' : 'false');
	}

	async function set(target) {
		const n = state.entries.length;
		const wanted = Math.max(min, Math.min(MAX_COUNT, target));

		if (busy || wanted === n || !Number.isInteger(wanted)) {
			draw();

			return;
		}

		busy = true;
		draw();

		try {
			if (wanted > n) {
				const result = await addAlike(pattern, wanted - n);

				if (result.added.length > 1 || afterText(result)) {
					toastAdded(`Added ${plural(result.added.length, 'copy', 'copies')}.`, result);
				}
			}
			else {
				const plan = removalPlan(state.entries, n - wanted, {keep, places: state.places});
				let chosen = plan.chosen;

				if (plan.ask) {
					const picked = await askWhich({...plan.ask, places: state.places});

					if (!picked) {
						busy = false;
						draw();

						return;
					}

					chosen = [...chosen, ...picked];
				}

				await removeWithUndo(chosen, state.places);
			}

			state = await alikeNow(pattern);

			if (onChange) {
				onChange(state.entries.length);
			}
		}
		catch (err) {
			toast(`Could not change the count. ${errorText(err)}`);
		}

		busy = false;

		if (element.isConnected) {
			draw();

			// The focus stays where the finger is, through a redraw too.
			if (document.activeElement === document.body) {
				count.focus({preventScroll: true});
			}
		}
	}

	less.addEventListener('click', () => set(state.entries.length - 1));
	more.addEventListener('click', () => set(state.entries.length + 1));
	count.addEventListener('change', () => {
		const typed = Number.parseInt(count.value, 10);

		if (Number.isInteger(typed)) {
			set(typed);
		}
		else {
			draw();
		}
	});
	count.addEventListener('keydown', (event) => {
		if (event.key === 'Enter') {
			event.preventDefault();
			count.blur();
		}
	});
	count.addEventListener('focus', () => count.select());

	draw();

	return {element, refresh: async () => {
		state = await alikeNow(pattern);
		draw();
	}};
}

// The sheet parts js/custom-card-view.js builds its sheet from, so a
// hand-made card's sheet looks and behaves like the copy sheets.
export {conditionOptions, dialog as sheetDialog, field as sheetField, select as sheetSelect, show as showSheet};
