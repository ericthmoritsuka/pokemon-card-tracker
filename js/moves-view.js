// The trades and sales log's screens (js/moves.js; DESIGN.md section 11,
// "Trades and Sales"):
//
//   trades       History: every move, newest first, by month, with the
//                money in and out each month. A move opens a sheet with its
//                cards and Undo this move. Scan the cards, beside Log a
//                move, opens Scan in Trade or sale (js/scan/trade.js).
//   trades/new   Log a trade or sale: the kind, date, who, price, note, the cards out
//                (picked from your copies, spares first, or from the copies
//                you removed in the last 30 days: Log a past sale) and the
//                cards in (picked from the catalog with language, finish,
//                and condition, as Add a copy asks). Saving shows Undo on a
//                toast.
//
// Reached from the Trades button beside Spares on My Cards, "Trades and
// sales" in Profile, and Trade or sale on a copy sheet and a card's page,
// which hand their copies over (js/moves.js setPendingMove). Never on a
// family member's screens.

import {cardImage, cardIndex, catalogFor, saveToCardIndex, viewingLanguage} from './catalog.js';
import {artOf, entryInfo, fillRecords, recordFrom} from './binders-view.js';
import {finishChoices} from './catalog-views.js';
import {isLive, loadDocument, onChange} from './collection.js';
import {MAX_ADD, conditionOptions, copyLanguages, languageName, sheetDialog, sheetField, sheetSelect, showSheet} from './copy-sheet.js';
import {BASE, errorText, go, h} from './dom.js';
import {formatCount, plural} from './format.js';
import {formatMoney, shortDate} from './prices.js';
import {CURRENCIES, applyMove, editMove, liveMoves, monthTotals, moveTitle, parsePrice, pastCandidates, priceForInput, priceText, takePendingMove, undoMove} from './moves.js';
import {searchKey} from './names.js';
import {afterText, keptStartOver} from './placeholder-fill.js';
import {plainVariantId} from './scan/finish.js';
import {rememberMode} from './scan/trade.js';
import {toast} from './shell.js';
import {cardArt, entryFinish, tileArt} from './tile.js';
import {spareEntries} from './trade-view.js';
import {SearchHint, cardRecord, searchCards} from './wishlist.js';

const UNDO_MS = 8000;
const PAGE = 60;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const monthName = (month) => (/^\d{4}-\d{2}$/.test(month) ? `${MONTHS[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}` : 'No date');

const moneyLine = (sums) => Object.entries(sums).map(([currency, amount]) => formatMoney(amount, currency)).join(' + ');

// The phone's own day, YYYY-MM-DD.
function today() {
	const now = new Date();

	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// "Undone. 1 copy is back, and 1 card in was removed."
export function undoneText(counts) {
	const parts = [`Undone. ${plural(counts.restored, 'copy is', 'copies are')} back, and ${plural(counts.added, 'card in was', 'cards in were')} removed.`];

	if (counts.kept) {
		parts.push(`${plural(counts.kept, 'card in was', 'cards in were')} kept because you changed ${counts.kept === 1 ? 'it' : 'them'} since.`);
	}

	if (counts.unlinked) {
		parts.push(`${plural(counts.unlinked, 'removed copy is', 'removed copies are')} no longer linked to it.`);
	}

	return parts.join(' ');
}

async function runUndo(moveId) {
	try {
		toast(undoneText(await undoMove(moveId)), {timeout: UNDO_MS});
	}
	catch (err) {
		toast(err.stale ? err.message : `Not undone. ${errorText(err)}`);
	}
}

// The names, languages, and art of copies: {entry, info}. The scanner's
// copy picker (js/scan/trade-sheets.js) shows copies the same way.
export const described = (entries, index, viewing) => entries.map((entry) => ({entry, info: entryInfo(entry, index, viewing)}));

const copyMeta = (entry, extra = null) => [languageName(entry.language), entry.condition, extra].filter(Boolean).join(' · ');

export function copyTile({entry, info}, {extra = null, selected = null} = {}) {
	const frame = artOf({catalog: entry.catalog || 'international', card_id: entry.card_id, language: entry.language || null}, info, (src) => tileArt({
		finish: entryFinish(entry),
		info,
		languages: [entry.language],
		src,
		status: selected ? 'owned' : null,
		statusLabel: selected ? 'Selected' : null,
	}));

	return [frame, h('span', {class: 'tile-name'}, info.name), h('span', {class: 'tile-meta'}, copyMeta(entry, extra))];
}

// The Scan tab's glyph (index.html), for the buttons that open Scan in
// Trade or sale.
function scanIcon() {
	const SVG = 'http://www.w3.org/2000/svg';
	const svg = document.createElementNS(SVG, 'svg');
	const frame = document.createElementNS(SVG, 'path');
	const card = document.createElementNS(SVG, 'rect');

	svg.setAttribute('aria-hidden', 'true');
	svg.setAttribute('class', 'tab-icon button-icon');
	svg.setAttribute('focusable', 'false');
	svg.setAttribute('viewBox', '0 0 24 24');
	frame.setAttribute('d', 'M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3');
	Object.entries({height: 10, rx: 1, width: 7, x: 8.5, y: 7}).forEach(([key, value]) => card.setAttribute(key, String(value)));
	svg.append(frame, card);

	return svg;
}

// A compact row for a card the scanner handed over (design review,
// 2026-11-06): its picture, its name, its language and condition, and an x
// that takes it out of the move.
function chosenRow(attrs, art, name, meta, onRemove) {
	return h('div', {...attrs, class: 'move-row'},
		h('span', {class: 'move-row-thumb'}, art),
		h('span', {class: 'move-row-text'}, h('span', {class: 'move-row-name'}, name), h('span', {class: 'move-row-meta'}, meta)),
		h('button', {'aria-label': `Take ${name} out of the list`, class: 'move-row-remove move-unpick', onclick: onRemove, type: 'button'}, h('span', {'aria-hidden': 'true'}, '×')));
}

// ------------------------------------------------------------- History

export function historyView(root) {
	let alive = true;
	const body = h('div', {class: 'moves-body', id: 'moves-body'}, h('p', {class: 'muted'}, 'Loading…'));
	const sheet = sheetDialog('move-sheet', 'Trade or sale');
	// The names of a move's cards, from the last draw, for Cancel in Edit.
	let cardNames = () => [];
	const outNames = (move) => cardNames(move.out);
	const inNames = (move) => cardNames(move.in);

	async function draw() {
		const doc = await loadDocument();
		const index = await cardIndex().catch(() => new Map());

		if (!alive) {
			return;
		}

		const months = monthTotals(liveMoves(doc));
		const byId = new Map((doc.cards || []).filter((entry) => entry && entry.id).map((entry) => [entry.id, entry]));
		const viewing = viewingLanguage();
		const names = (ids) => (ids || []).map((id) => byId.get(id)).filter(Boolean).map((entry) => entryInfo(entry, index, viewing).name);

		cardNames = names;

		if (!months.length) {
			body.replaceChildren(h('div', {class: 'card empty-state', id: 'moves-empty'},
				h('p', {class: 'big'}, 'No trades or sales yet'),
				h('p', {class: 'muted'}, 'Scan the cards going out and coming in, or log a trade or sale by hand.'),
				h('div', {class: 'moves-empty-actions'},
					h('a', {class: 'button primary', 'data-link': 'trades/new', href: `${BASE}trades/new`}, 'Log a trade or sale'),
					h('a', {class: 'button', 'data-link': 'scan', href: `${BASE}scan`, id: 'moves-empty-scan', onclick: () => rememberMode('trade')}, scanIcon(), 'Scan a trade or sale'))
			));

			return;
		}

		body.replaceChildren(...months.map((month) => h('section', {'aria-label': monthName(month.month), class: 'moves-month', 'data-month': month.month},
			h('div', {class: 'moves-month-head'},
				h('h3', null, monthName(month.month)),
				h('p', {class: 'moves-money'}, [
					Object.keys(month.in).length ? `In ${moneyLine(month.in)}` : null,
					Object.keys(month.out).length ? `Out ${moneyLine(month.out)}` : null,
				].filter(Boolean).join(' · ') || 'No money in or out')
			),
			h('ul', {class: 'moves-list'}, month.moves.map((move) => {
				const out = names(move.out);
				const came = names(move.in);

				return h('li', null, h('button', {'aria-haspopup': 'dialog', class: 'moves-row', 'data-move': move.id, onclick: () => openMove(move, out, came), type: 'button'},
					h('span', {class: 'moves-title'}, moveTitle(move)),
					h('span', {class: 'moves-meta'}, [shortDate(move.date) || move.date, out.length ? `${formatCount(out.length)} out` : null, came.length ? `${formatCount(came.length)} in` : null].filter(Boolean).join(' · ')),
					h('span', {class: 'moves-cards'}, [out.length ? `Out: ${out.join(', ')}` : null, came.length ? `In: ${came.join(', ')}` : null].filter(Boolean).join('. '))
				));
			}))
		)));
	}

	function openMove(move, out, came) {
		const close = () => sheet.close();
		const confirm = h('div', {class: 'move-confirm', hidden: true, id: 'move-confirm'},
			h('p', null, `Put ${plural(out.length, 'card', 'cards')} out back and remove ${plural(came.length, 'card', 'cards')} in? A card in that you changed since stays.`),
			h('div', {class: 'copy-danger-row'},
				h('button', {class: 'danger', id: 'move-undo-go', onclick: async () => {
					close();
					await runUndo(move.id);
				}, type: 'button'}, 'Undo it'),
				h('button', {id: 'move-undo-cancel', onclick: () => {
					confirm.hidden = true;
					undo.hidden = false;
				}, type: 'button'}, 'Cancel'))
		);
		const undo = h('button', {class: 'danger', id: 'move-undo', onclick: () => {
			undo.hidden = true;
			confirm.hidden = false;
		}, type: 'button'}, 'Undo this trade or sale');
		const edit = h('button', {id: 'move-edit', onclick: () => editMoveForm(move), type: 'button'}, 'Edit');

		sheet.replaceChildren(
			h('div', {class: 'sheet-head'},
				h('h2', {id: 'move-sheet-title'}, moveTitle(move)),
				h('button', {class: 'small', id: 'move-sheet-close', onclick: close, type: 'button'}, 'Close')
			),
			h('dl', {class: 'facts move-facts'},
				h('dt', null, 'Date'), h('dd', null, shortDate(move.date, {year: true}) || move.date),
				...(priceText(move) ? [h('dt', null, 'Money'), h('dd', null, `${priceText(move)} ${move.money === 'in' ? 'in' : 'out'}`)] : []),
				...(out.length ? [h('dt', null, 'Going out'), h('dd', {id: 'move-sheet-out'}, out.join(', '))] : []),
				...(came.length ? [h('dt', null, 'Coming in'), h('dd', {id: 'move-sheet-in'}, came.join(', '))] : []),
				...(move.note ? [h('dt', null, 'Note'), h('dd', null, move.note)] : [])
			),
			h('div', {class: 'button-row move-sheet-actions'}, edit),
			h('p', {class: 'muted move-edit-hint'}, 'Edit changes the date, who, price, and note. To change the cards, undo this trade or sale and log it again.'),
			h('div', {class: 'copy-danger'}, undo, confirm)
		);
		showSheet(sheet);
	}

	// Edit a logged move (Eric, 2026-11-05): the date, who, price with its
	// currency and which way it went, and the note, in the same sheet. The
	// cards stay as they are (js/moves.js planEditMove). The form keeps the
	// move it was filled from and saves only what was changed in it, so a
	// change another phone made while it was open stays.
	function editMoveForm(move) {
		const opened = structuredClone(move);
		const close = () => sheet.close();
		const [whoWords, priceWords] = KIND_WORDS[move.kind] || KIND_WORDS.gift;
		const date = h('input', {class: 'search', id: 'move-edit-date', name: 'move-edit-date', type: 'date', value: move.date || today()});
		const who = h('input', {autocomplete: 'off', class: 'search', id: 'move-edit-who', maxlength: 80, name: 'move-edit-who', type: 'text', value: move.who || ''});
		const price = h('input', {class: 'search', id: 'move-edit-price', inputmode: 'decimal', name: 'move-edit-price', placeholder: '0,00', type: 'text', value: priceForInput(move.price)});
		const currency = sheetSelect('move-edit-currency', CURRENCIES.map((code) => ({label: code, value: code})), CURRENCIES.includes(move.currency) ? move.currency : 'BRL');
		const money = sheetSelect('move-edit-money', [{label: 'I paid it', value: 'out'}, {label: 'I got it', value: 'in'}], move.money === 'in' ? 'in' : 'out');
		const priceRead = h('p', {'aria-live': 'polite', class: 'muted move-price-read', id: 'move-edit-price-read'});
		const note = h('textarea', {class: 'copy-notes', id: 'move-edit-note', maxlength: 500, name: 'move-edit-note', rows: 2});
		const error = h('p', {'aria-live': 'polite', class: 'form-error', id: 'move-edit-error'});
		const save = h('button', {class: 'primary', id: 'move-edit-save', type: 'submit'}, 'Save');
		const cancel = h('button', {id: 'move-edit-cancel', onclick: () => openMove(move, outNames(move), inNames(move)), type: 'button'}, 'Cancel');

		note.value = move.note || '';

		// The price as it will be saved, as the log form shows it.
		function readPrice() {
			const {error: wrong, value} = parsePrice(price.value);

			priceRead.classList.toggle('form-error', Boolean(wrong));
			priceRead.textContent = wrong || (value ? `Saved as ${formatMoney(value, currency.value)}` : '');
		}

		price.addEventListener('input', () => {
			error.textContent = '';
			readPrice();
		});
		currency.addEventListener('change', readPrice);
		readPrice();

		const form = h('form', {class: 'copy-form move-form', id: 'move-edit-form', novalidate: true},
			sheetField('Date', 'move-edit-date', date),
			h('div', {class: 'copy-field'}, h('label', {for: 'move-edit-who'}, whoWords), who),
			...(priceWords ? [h('div', {class: 'copy-field move-price-row'}, h('label', {for: 'move-edit-price'}, priceWords), h('div', {class: 'move-price-inputs'}, price, h('span', {class: 'select-wrap'}, currency)), priceRead)] : []),
			...(move.kind === 'traded' ? [h('div', {class: 'copy-field'}, h('label', {for: 'move-edit-money'}, 'The cash'), h('span', {class: 'select-wrap'}, money))] : []),
			sheetField('Note', 'move-edit-note', note),
			error,
			h('div', {class: 'button-row'}, cancel, save)
		);

		form.addEventListener('submit', async (event) => {
			event.preventDefault();
			error.textContent = '';

			if (priceWords && parsePrice(price.value).error) {
				readPrice();
				error.textContent = parsePrice(price.value).error;
				price.focus();

				return;
			}

			const fields = {date: date.value || move.date, note: note.value, who: who.value};

			if (priceWords) {
				Object.assign(fields, {currency: currency.value, price: price.value});
			}

			if (move.kind === 'traded') {
				fields.money = money.value;
			}

			save.disabled = true;

			try {
				const {changed} = await editMove(move.id, fields, {base: opened});

				close();
				toast(changed.length ? 'Saved your changes to the trade or sale.' : 'Nothing changed.');
			}
			catch (err) {
				save.disabled = false;
				error.textContent = err.stale ? err.message : `Not saved. ${errorText(err)}`;
			}
		});

		sheet.replaceChildren(
			h('div', {class: 'sheet-head'},
				h('h2', {id: 'move-sheet-title'}, `Edit: ${moveTitle(move)}`),
				h('button', {class: 'small', id: 'move-sheet-close', onclick: close, type: 'button'}, 'Close')
			),
			form
		);
		date.focus();
	}

	const stop = onChange(() => {
		if (alive) {
			draw().catch(() => {});
		}
	});

	root.append(
		h('div', {class: 'view-head'},
			h('h2', null, 'Trades and sales'),
			h('div', {class: 'view-head-links'},
				// Scan opened in Trade or sale (Eric, 2026-11-06): the mode is
				// kept on the phone as the scanner's own switch keeps it, and
				// the trade tray is kept as it is, cards and all.
				h('a', {class: 'button small view-head-link', 'data-link': 'scan', href: `${BASE}scan`, id: 'moves-scan', onclick: () => rememberMode('trade')}, scanIcon(), 'Scan a trade or sale'),
				h('a', {class: 'button small primary view-head-link', 'data-link': 'trades/new', href: `${BASE}trades/new`, id: 'moves-new'}, 'Log a trade or sale'))
		),
		body
	);
	draw().catch((err) => body.replaceChildren(h('p', {class: 'form-error'}, `History did not load. ${errorText(err)}`)));

	return () => {
		alive = false;
		stop();

		if (sheet.open) {
			sheet.close();
		}
	};
}

// ------------------------------------------------------------ Log a trade or sale

// The labels of who and the price for each kind: [who, price], with no
// price for a gift. The log form and Edit share them.
const KIND_WORDS = {
	bought: ['Bought from', 'Paid (optional)'],
	gift: ['Who', null],
	sold: ['Sold to', 'Sold for (optional)'],
	traded: ['Traded with', 'Cash added (optional)'],
};

// In the order a person reaches for them.
const KIND_LABELS = [['sold', 'Sold'], ['bought', 'Bought'], ['traded', 'Traded'], ['gift', 'Gift']];

const kindLabel = (value) => (KIND_LABELS.find(([one]) => one === value) || [null, value])[1];

// "Scanned 2 going out, 1 coming in. Add who and the price, then Save."
// (design review, 2026-11-06), with the alternative the sides allow; the
// kind picked shows in the kinds above it. out counts the copies still in
// his cards; dropped, those handed over that are not any more (removed on
// another phone since the scan), which were scanned all the same.
export function scannedText({alternatives = [], dropped = 0, in: incoming = [], kind, out = []}) {
	const inCount = incoming.reduce((sum, item) => sum + (item.n || 1), 0);
	const outCount = out.length + dropped;
	const sides = [outCount ? `${outCount} going out` : null, inCount ? `${inCount} coming in` : null].filter(Boolean).join(', ');
	const other = alternatives.length ? ` Pick ${alternatives.map(kindLabel).join(' or ')} if ${kind === 'bought' ? 'they were a gift to you' : 'you gave them away'}.` : '';
	const gone = dropped ? ` ${plural(dropped, 'copy', 'copies')} you scanned going out ${dropped === 1 ? 'is' : 'are'} no longer in your cards, so ${dropped === 1 ? 'it is' : 'they are'} left out.` : '';

	return `Scanned ${sides || 'no cards'}.${gone}${other} Add who and the price, then Save.`;
}

// Under the kinds, when the kind picked leaves out a side the scanner
// handed over: "The 1 card coming in is not part of a sale; it stays in
// the scanner's trade tray." Null when nothing is left out.
export function leftOutText(kind, {in: inCount = 0, out: outCount = 0}) {
	if (kind === 'sold' && inCount) {
		return `The ${plural(inCount, 'card')} coming in ${inCount === 1 ? 'is' : 'are'} not part of a sale; ${inCount === 1 ? 'it stays' : 'they stay'} in the scanner's trade tray.`;
	}

	if (kind === 'bought' && outCount) {
		return `The ${plural(outCount, 'card')} going out ${outCount === 1 ? 'is' : 'are'} not part of a purchase; ${outCount === 1 ? 'it stays' : 'they stay'} in the scanner's trade tray.`;
	}

	return null;
}

export function newMoveView(root) {
	let alive = true;
	const handed = takePendingMove() || {};
	const outIds = new Set(handed.out || []);
	// What the scanner handed over, so the left-out line counts only its cards.
	const handedOut = new Set(handed.out || []);
	const pastIds = new Set();
	// The cards in: {fields, info, n}. The scanner's Trade or sale mode hands
	// its cards coming in over in this shape (js/scan/trade.js tradeHandoff).
	const ins = (handed.in || []).map((item) => ({fields: {...item.fields}, info: {...item.info}, n: item.n, scanned: true}));
	let kind = KIND_LABELS.some(([value]) => value === handed.kind) ? handed.kind : 'sold';
	let doc = null;
	// The kept Start over undo, which tells Log a past sale what an older
	// Start over removed (js/moves.js pastCandidates).
	let kept = null;
	let index = new Map();
	const viewing = viewingLanguage();
	const outSheet = sheetDialog('move-out-sheet', 'Going out');
	const inSheet = sheetDialog('move-in-sheet', 'A card coming in');
	// The scanner's cards as compact rows, so the form stays short.
	const compact = handed.from === 'scan';

	const date = h('input', {class: 'search', id: 'move-date', name: 'move-date', type: 'date', value: today()});
	const who = h('input', {autocomplete: 'off', class: 'search', id: 'move-who', maxlength: 80, name: 'move-who', type: 'text'});
	const whoLabel = h('label', {for: 'move-who'}, 'Sold to');
	const price = h('input', {class: 'search', id: 'move-price', inputmode: 'decimal', name: 'move-price', placeholder: '0,00', type: 'text'});
	const priceLabel = h('label', {for: 'move-price'}, 'Sold for (optional)');
	const currency = sheetSelect('move-currency', CURRENCIES.map((code) => ({label: code, value: code})), 'BRL');
	const money = sheetSelect('move-money', [{label: 'I paid it', value: 'out'}, {label: 'I got it', value: 'in'}], 'out');
	const moneyRow = h('div', {class: 'copy-field', hidden: true}, h('label', {for: 'move-money'}, 'The cash'), h('span', {class: 'select-wrap'}, money));
	// The price as it will be saved, under the field as he types, so "1.500"
	// reads back as R$ 1.500,00 before he saves (js/moves.js parsePrice).
	const priceRead = h('p', {'aria-live': 'polite', class: 'muted move-price-read', id: 'move-price-read'});
	const priceRow = h('div', {class: 'copy-field move-price-row'}, priceLabel, h('div', {class: 'move-price-inputs'}, price, h('span', {class: 'select-wrap'}, currency)), priceRead);

	function readPrice() {
		const {error: wrong, value} = parsePrice(price.value);

		priceRead.classList.toggle('form-error', Boolean(wrong));
		priceRead.textContent = wrong || (value ? `Saved as ${formatMoney(value, currency.value)}` : '');
	}

	price.addEventListener('input', readPrice);
	currency.addEventListener('change', readPrice);
	const note = h('textarea', {class: 'copy-notes', id: 'move-note', maxlength: 500, name: 'move-note', rows: 2});
	const listClass = compact ? 'move-rows' : 'pick-grid move-chosen';
	const outList = h('div', {class: listClass, id: 'move-out-list'});
	const inList = h('div', {class: listClass, id: 'move-in-list'});
	// One name for each side, whatever the kind (design review, 2026-11-06).
	const outTitle = h('h3', null, 'Going out');
	const inTitle = h('h3', null, 'Coming in');
	const outSection = h('section', {class: 'card move-side', id: 'move-out-section'}, outTitle, outList,
		h('button', {'aria-haspopup': 'dialog', id: 'move-add-out', onclick: () => openOut(), type: 'button'}, 'Add a card going out'));
	const inSection = h('section', {class: 'card move-side', id: 'move-in-section'}, inTitle, inList,
		h('button', {'aria-haspopup': 'dialog', id: 'move-add-in', onclick: () => openIn(), type: 'button'}, 'Add a card coming in'));
	const error = h('p', {'aria-live': 'polite', class: 'form-error', id: 'move-error'});
	const save = h('button', {class: 'primary wide', id: 'move-save', type: 'submit'}, 'Save');
	const kinds = h('div', {'aria-label': 'What happened', class: 'segmented move-kinds', role: 'radiogroup'},
		KIND_LABELS.map(([value, label]) => h('label', null,
			h('input', {checked: value === kind, id: `move-kind-${value}`, name: 'move-kind', onchange: () => {
				kind = value;
				drawKind();
			}, type: 'radio', value}),
			h('span', null, label))));
	// From the scanner: what was scanned, and the kind it suggests, which he
	// can change (Sold or Gift for cards only going out, Bought or Gift for
	// cards only coming in).
	// Its text waits for the cards, so it counts only copies still in them.
	const scanned = handed.from === 'scan' ? h('p', {class: 'muted move-scanned', id: 'move-scanned'}) : null;
	const leftOut = h('p', {class: 'muted move-left-out', hidden: true, id: 'move-left-out'});

	const shows = () => ({in: kind !== 'sold', out: kind !== 'bought'});

	function drawKind() {
		const side = shows();
		const words = KIND_WORDS[kind];

		whoLabel.textContent = words[0];
		priceRow.hidden = !words[1];
		priceLabel.textContent = words[1] || '';
		moneyRow.hidden = kind !== 'traded';
		outSection.hidden = !side.out;
		inSection.hidden = !side.in;

		// A kind that leaves out cards the scanner handed over says so: they
		// are not saved, and stay in the scanner's trade tray (onSaved).
		const left = handed.from === 'scan' ? leftOutText(kind, {in: ins.filter((item) => item.scanned).reduce((sum, item) => sum + item.n, 0), out: [...outIds].filter((id) => handedOut.has(id)).length}) : null;

		leftOut.hidden = !left;
		leftOut.textContent = left || '';
	}

	function drawChosen() {
		if (!doc) {
			return;
		}

		const byId = new Map(doc.cards.filter((entry) => entry && entry.id).map((entry) => [entry.id, entry]));
		const out = [...outIds, ...pastIds].map((id) => byId.get(id)).filter(Boolean);

		const dropOut = (id) => {
			outIds.delete(id);
			pastIds.delete(id);
			drawChosen();
		};
		const dropIn = (i) => {
			ins.splice(i, 1);
			drawChosen();
		};
		const none = () => [h('p', {class: 'muted'}, 'None yet.')];

		if (compact) {
			outList.replaceChildren(...(out.length ? described(out, index, viewing).map((item) => chosenRow({'data-entry': item.entry.id},
				artOf({catalog: item.entry.catalog || 'international', card_id: item.entry.card_id, language: item.entry.language || null}, item.info, (src) => cardArt(item.info, src, {decorative: true})),
				item.info.name,
				copyMeta(item.entry, pastIds.has(item.entry.id) ? `Removed ${shortDate(item.entry.deleted_at) || ''}` : null),
				() => dropOut(item.entry.id))) : none()));
			inList.replaceChildren(...(ins.length ? ins.map((item, i) => chosenRow({'data-card': item.fields.card_id},
				cardArt(item.info, item.info.image, {decorative: true}),
				item.info.name,
				[item.n > 1 ? `${item.n} copies` : null, languageName(item.fields.language), item.fields.condition].filter(Boolean).join(' · '),
				() => dropIn(i))) : none()));
		}
		else {
		outList.replaceChildren(...(out.length ? described(out, index, viewing).map((item) => h('div', {class: 'pick-cell', 'data-entry': item.entry.id},
			h('div', {class: 'pick'}, ...copyTile(item, {extra: pastIds.has(item.entry.id) ? `Removed ${shortDate(item.entry.deleted_at) || ''}` : null})),
			h('button', {'aria-label': `Take ${item.info.name} out of the list`, class: 'small move-unpick', onclick: () => {
				outIds.delete(item.entry.id);
				pastIds.delete(item.entry.id);
				drawChosen();
			}, type: 'button'}, 'Remove'))) : [h('p', {class: 'muted'}, 'None yet.')]));
		inList.replaceChildren(...(ins.length ? ins.map((item, i) => h('div', {class: 'pick-cell', 'data-card': item.fields.card_id},
			h('div', {class: 'pick'},
				h('div', {class: 'art-wrap'}, cardArt(item.info, item.info.image)),
				h('span', {class: 'tile-name'}, item.info.name),
				h('span', {class: 'tile-meta'}, [item.n > 1 ? `${item.n} copies` : null, languageName(item.fields.language), item.fields.condition].filter(Boolean).join(' · '))),
			h('button', {'aria-label': `Take ${item.info.name} out of the list`, class: 'small move-unpick', onclick: () => {
				ins.splice(i, 1);
				drawChosen();
			}, type: 'button'}, 'Remove'))) : [h('p', {class: 'muted'}, 'None yet.')]));
		}

		fillRecords(out.map((entry) => ({cardId: entry.card_id, catalog: entry.catalog})), index, () => alive)
			.then((filled) => {
				if (filled && alive) {
					index = filled;
					drawChosen();
				}
			})
			.catch(() => {});
	}

	// ---------------------------------------------------- the cards out

	function openOut({card = null} = {}) {
		if (!doc) {
			return;
		}

		let tab = 'mine';
		let only = card;
		let shown = PAGE;
		const live = doc.cards.filter((entry) => entry && entry.id && isLive(entry));
		const spares = new Set(spareEntries(live).map((entry) => entry.id));
		const mine = described(live, index, viewing).sort((a, b) => Number(spares.has(b.entry.id)) - Number(spares.has(a.entry.id)) || a.info.name.localeCompare(b.info.name) || String(a.entry.created_at).localeCompare(String(b.entry.created_at)));
		const past = described(pastCandidates(doc, {kept}), index, viewing);
		const search = h('input', {'aria-label': 'Search your cards', autocomplete: 'off', class: 'search', id: 'move-out-search', placeholder: 'Search your cards', type: 'search'});
		const tabs = h('div', {'aria-label': 'Which cards', class: 'segmented move-tabs', role: 'radiogroup'},
			[['mine', 'Your cards'], ['past', 'Removed lately']].map(([value, label]) => h('label', null,
				h('input', {checked: value === tab, id: `move-tab-${value}`, name: 'move-tab', onchange: () => {
					tab = value;
					shown = PAGE;
					draw();
				}, type: 'radio', value}),
				h('span', null, label))));
		const onlyLine = h('p', {class: 'muted move-only', hidden: true, id: 'move-out-only'});
		const count = h('p', {'aria-live': 'polite', class: 'muted', id: 'move-out-count'});
		const results = h('div', {class: 'pick-grid', id: 'move-out-results'});
		const more = h('button', {hidden: true, id: 'move-out-more', type: 'button'}, 'Show more');
		const done = h('button', {class: 'primary', id: 'move-out-done', type: 'button'}, 'Done');
		const close = () => outSheet.close();

		const picked = (id) => outIds.has(id) || pastIds.has(id);

		function found() {
			const query = search.value.trim();
			const list = (tab === 'mine' ? mine : past).filter((item) => !only || (item.entry.card_id === only.card_id && (item.entry.catalog || 'international') === only.catalog));

			return query ? list.filter((item) => item.info.search.includes(searchKey(query))) : list;
		}

		function draw() {
			const list = found();
			const n = outIds.size + pastIds.size;

			onlyLine.hidden = !only;

			if (only) {
				onlyLine.replaceChildren(`Only ${(list[0] || mine.find((item) => item.entry.card_id === only.card_id) || {info: {name: 'this card'}}).info.name}. `,
					h('button', {class: 'small', id: 'move-out-all', onclick: () => {
						only = null;
						draw();
					}, type: 'button'}, 'Show all cards'));
			}

			if (tab === 'past' && !past.length) {
				count.textContent = 'No copy was removed in the last 30 days, or every one is in a trade or sale already.';
			}
			else if (!list.length) {
				count.textContent = 'No cards match.';
			}
			else {
				count.textContent = tab === 'past'
					? `${plural(list.length, 'copy', 'copies')} you removed in the last 30 days, newest first. Picking one links it to this trade or sale; it stays removed.`
					: `${plural(list.length, 'copy', 'copies')}, spares first.`;
			}

			results.replaceChildren(...list.slice(0, shown).map((item) => {
				const on = picked(item.entry.id);
				const extra = tab === 'past' ? `Removed ${shortDate(item.entry.deleted_at) || ''}` : spares.has(item.entry.id) ? 'Spare' : null;

				return h('button', {'aria-pressed': String(on), class: 'pick move-copy', 'data-entry': item.entry.id, onclick: () => {
					const set = tab === 'past' ? pastIds : outIds;

					if (on) {
						set.delete(item.entry.id);
					}
					else {
						set.add(item.entry.id);
					}

					draw();
					results.querySelector(`[data-entry="${CSS.escape(item.entry.id)}"]`)?.focus();
				}, type: 'button'}, ...copyTile(item, {extra, selected: on}));
			}));
			more.hidden = list.length <= shown;
			more.textContent = `Show more (${formatCount(list.length - shown)} left)`;
			done.textContent = n ? `Done (${formatCount(n)})` : 'Done';

			fillRecords(list.slice(0, shown).map(({entry}) => ({cardId: entry.card_id, catalog: entry.catalog})), index, () => alive && outSheet.open)
				.then((filled) => {
					if (filled && alive && outSheet.open) {
						index = filled;

						for (const item of [...mine, ...past]) {
							item.info = entryInfo(item.entry, index, viewing);
						}

						draw();
					}
				})
				.catch(() => {});
		}

		search.addEventListener('input', () => {
			shown = PAGE;
			draw();
		});
		more.addEventListener('click', () => {
			shown += PAGE;
			draw();
		});
		done.addEventListener('click', close);

		outSheet.replaceChildren(
			h('div', {class: 'sheet-head'},
				h('h2', {id: 'move-out-sheet-title'}, 'Going out'),
				h('button', {class: 'small', id: 'move-out-close', onclick: close, type: 'button'}, 'Close')
			),
			tabs,
			onlyLine,
			search,
			count,
			results,
			more,
			h('div', {class: 'tray-pick-foot'}, done)
		);
		showSheet(outSheet, () => drawChosen());
		draw();
	}

	// ----------------------------------------------------- the cards in

	function openIn() {
		const close = () => inSheet.close();
		const lang = h('select', {'aria-label': 'Catalog', id: 'move-in-catalog'},
			h('option', {value: catalogFor(viewing) === 'international' ? viewing : 'en'}, 'International'),
			h('option', {value: 'ja'}, 'Japanese'),
			h('option', {value: 'ko'}, 'Korean'));
		const search = h('input', {'aria-label': 'Search the catalog', autocomplete: 'off', class: 'search', id: 'move-in-search', placeholder: 'Card name, number, or ID', type: 'search'});
		const status = h('p', {'aria-live': 'polite', class: 'muted', id: 'move-in-status'}, 'Search the catalog for the card that came in.');
		const results = h('div', {class: 'pick-grid', id: 'move-in-results'});
		const form = h('form', {class: 'want-form', id: 'move-in-form'}, h('span', {class: 'select-wrap'}, lang), search, h('button', {class: 'primary', id: 'move-in-go', type: 'submit'}, 'Search'));
		const pane = h('div', {class: 'move-in-pane'}, form, status, results);
		let asked = 0;

		async function choose(card) {
			const catalog = card.catalog || catalogFor(lang.value);
			const record = await cardRecord(card.id, card.lang || lang.value, catalog).catch(() => null);
			const full = record ? record.card : null;
			const variants = full && Array.isArray(full.variants_detailed) ? full.variants_detailed : [];
			const finishes = finishChoices(variants);
			const plain = plainVariantId(variants);
			const languages = copyLanguages(catalog);
			const language = sheetSelect('move-in-language', languages.map(({code, label}) => ({label, value: code})), languages.some((item) => item.code === lang.value) ? lang.value : languages[0].code);
			const finish = sheetSelect('move-in-finish', [{label: 'Not set', value: ''}, ...finishes], plain && finishes.some((option) => option.value === plain) ? plain : '');
			const condition = sheetSelect('move-in-condition', conditionOptions(), '');
			const count = h('input', {class: 'search copy-count', id: 'move-in-count', inputmode: 'numeric', max: MAX_ADD, min: 1, step: 1, type: 'number', value: 1});
			const info = {image: cardImage(card.image, 'low'), name: card.name, number: card.localId, setName: card.setName};
			const note = h('p', {'aria-live': 'polite', class: 'form-error', id: 'move-in-error'});
			const add = h('button', {class: 'primary', id: 'move-in-add', type: 'button'}, 'Add this card');
			const backButton = h('button', {class: 'small', id: 'move-in-back', onclick: () => inSheet.replaceChildren(head(), pane), type: 'button'}, 'Back to results');

			add.addEventListener('click', () => {
				const n = Number.parseInt(count.value, 10);

				if (!Number.isInteger(n) || n < 1 || n > MAX_ADD) {
					note.textContent = `Choose from 1 to ${MAX_ADD} copies.`;

					return;
				}

				const fields = {card_id: card.id, catalog, language: language.value, language_source: 'manual', variant_id: finish.value || null};

				if (catalogFor(language.value) !== catalog) {
					fields.fallback = true;
				}

				if (condition.value) {
					fields.condition = condition.value;
				}

				ins.push({fields, info, n});

				// Its name and set for the tiles, from the search or the record.
				if (full && full.set) {
					saveToCardIndex([recordFrom(catalog, record.lang, full)]).then((filled) => {
						if (filled) {
							index = filled;
						}
					}).catch(() => {});
				}

				close();
				drawChosen();
			});

			inSheet.replaceChildren(
				head(),
				h('div', {class: 'move-in-card'},
					h('div', {class: 'art-wrap'}, cardArt(info, info.image)),
					h('p', {class: 'big'}, [card.name, card.localId ? `#${card.localId}` : null, card.setName].filter(Boolean).join(' · '))
				),
				h('div', {class: 'copy-form'},
					sheetField('Language', 'move-in-language', language),
					sheetField('Finish', 'move-in-finish', finish),
					sheetField('Condition', 'move-in-condition', condition),
					sheetField(`How many (1 to ${MAX_ADD})`, 'move-in-count', count),
					note,
					add
				),
				backButton
			);
		}

		form.addEventListener('submit', async (event) => {
			event.preventDefault();

			const query = search.value.trim();

			if (query.length < 2) {
				status.textContent = 'Type at least two letters of the name.';

				return;
			}

			const ticket = ++asked;

			status.textContent = 'Searching…';
			results.replaceChildren();

			try {
				const {more, results: list} = await searchCards(query, lang.value);

				if (ticket !== asked || !alive) {
					return;
				}

				status.textContent = list.length
					? `${plural(list.length + more, 'card', 'cards')} found for "${query}"${more ? `, the first ${formatCount(list.length)} shown` : ''}.`
					: `No cards found for "${query}".`;
				results.replaceChildren(...list.map((card) => {
					const info = {name: card.name, number: card.localId, setName: card.setName};

					return h('button', {class: 'pick move-in-result', 'data-card': card.id, onclick: () => choose(card), type: 'button'},
						h('div', {class: 'art-wrap'}, cardArt(info, cardImage(card.image, 'low'))),
						h('span', {class: 'tile-name'}, card.name),
						h('span', {class: 'tile-meta'}, [card.localId ? `#${card.localId}` : null, card.setName].filter(Boolean).join(' · '))
					);
				}));
			}
			catch (err) {
				if (ticket !== asked) {
					return;
				}

				status.textContent = err instanceof SearchHint
					? err.message
					: navigator.onLine ? `The catalog search did not work. ${errorText(err)}` : 'This search needs a connection the first time.';
			}
		});

		const head = () => h('div', {class: 'sheet-head'},
			h('h2', {id: 'move-in-sheet-title'}, 'A card coming in'),
			h('button', {class: 'small', id: 'move-in-close', onclick: close, type: 'button'}, 'Close'));

		inSheet.replaceChildren(head(), pane);
		showSheet(inSheet);
		search.focus();
	}

	// ----------------------------------------------------------- saving

	const formElement = h('form', {class: 'copy-form move-form', id: 'move-form', novalidate: true},
		kinds,
		...(scanned ? [scanned, leftOut] : []),
		sheetField('Date', 'move-date', date),
		h('div', {class: 'copy-field'}, whoLabel, who),
		priceRow,
		moneyRow,
		sheetField('Note', 'move-note', note),
		outSection,
		inSection,
		error,
		// Save stays in reach, above the tab bar, however long the form.
		h('div', {class: 'actions'}, save)
	);

	formElement.addEventListener('submit', async (event) => {
		event.preventDefault();
		error.textContent = '';

		const side = shows();
		const out = side.out ? [...outIds] : [];
		const past = side.out ? [...pastIds] : [];
		const incoming = side.in ? ins.flatMap((item) => Array.from({length: item.n}, () => ({...item.fields}))) : [];

		if (kind === 'sold' && !out.length && !past.length) {
			error.textContent = 'Choose the cards you sold.';

			return;
		}

		if (kind === 'bought' && !incoming.length) {
			error.textContent = 'Add the cards you bought.';

			return;
		}

		if (!out.length && !past.length && !incoming.length) {
			error.textContent = 'Add at least one card going out or coming in.';

			return;
		}

		if (!priceRow.hidden && parsePrice(price.value).error) {
			readPrice();
			error.textContent = parsePrice(price.value).error;
			price.focus();

			return;
		}

		save.disabled = true;

		let result;

		try {
			result = await applyMove({
				currency: currency.value,
				date: date.value || today(),
				in: incoming,
				kind,
				money: money.value,
				note: note.value,
				out,
				past,
				price: priceRow.hidden ? null : price.value,
				who: who.value,
			});
		}
		catch (err) {
			save.disabled = false;
			error.textContent = `Not saved. ${errorText(err)}`;

			return;
		}

		const {counts, move} = result;

		// The scanner's Trade or sale tray lets go of the sides this move
		// saved; a side the kind left out stays there.
		if (typeof handed.onSaved === 'function') {
			Promise.resolve().then(() => handed.onSaved(move, side)).catch(() => {});
		}
		const words = [counts.out + counts.past ? `${plural(counts.out + counts.past, 'card', 'cards')} out` : null, counts.in ? `${plural(counts.in, 'card', 'cards')} in` : null].filter(Boolean).join(', ');
		const after = afterText({got: {length: counts.got}, placed: {length: counts.filled}});

		go('trades', {replace: true});
		toast(`Saved: ${words}.${after ? ` ${after}` : ''}`, {
			action: () => runUndo(move.id),
			actionLabel: 'Undo',
			timeout: UNDO_MS,
		});
	});

	root.append(
		h('a', {class: 'back', 'data-link': 'trades', href: `${BASE}trades`}, '‹ Trades and sales'),
		h('div', {class: 'view-head'}, h('h2', null, 'Log a trade or sale')),
		formElement
	);
	drawKind();

	Promise.all([loadDocument(), cardIndex().catch(() => new Map())]).then(async ([loaded, read]) => {
		if (!alive) {
			return;
		}

		doc = loaded;
		index = read;
		kept = await keptStartOver(doc).catch(() => null);

		if (!alive) {
			return;
		}

		// Copies handed over that are gone by now are dropped, and the
		// scanner's line counts what is left.
		let dropped = 0;

		for (const id of [...outIds]) {
			if (!doc.cards.some((entry) => entry && entry.id === id && isLive(entry))) {
				outIds.delete(id);
				dropped++;
			}
		}

		if (scanned) {
			scanned.textContent = scannedText({...handed, dropped, out: [...outIds]});
			drawKind();
		}

		drawChosen();

		// A card's page with several copies: its copies to pick from.
		if (handed.card && !outIds.size) {
			openOut({card: handed.card});
		}
	}).catch((err) => {
		error.textContent = `Your cards did not load. ${errorText(err)}`;
	});

	return () => {
		alive = false;

		for (const sheet of [outSheet, inSheet]) {
			if (sheet.open) {
				sheet.close();
			}
		}
	};
}

export const movesRoutes = [
	{pattern: /^trades$/, render: historyView, tab: 'cards', title: 'Trades and sales | Card Tracker'},
	{pattern: /^trades\/new$/, render: newMoveView, tab: 'cards', title: 'Log a trade or sale | Card Tracker'},
];

export const movesAccountViews = [historyView, newMoveView];
