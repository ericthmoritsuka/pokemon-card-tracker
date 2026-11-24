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
//                toast. A purchase says where it came from (From, with the
//                places of earlier purchases offered) and is priced with
//                one total or card by card (Price each card; Eric,
//                2026-11-19).
//
// Reached from the Trades button beside Spares on My Cards, "Trades and
// sales" in Profile, and Trade or sale on a copy sheet and a card's page,
// which hand their copies over (js/moves.js setPendingMove). Never on a
// family member's screens.

import {cardImage, cardIndex, catalogFor, saveToCardIndex, viewingLanguage} from './catalog.js';
import {artOf, entryInfo, fillRecords, recordFrom} from './binders-view.js';
import {placements} from './binders.js';
import {finishChoices} from './catalog-views.js';
import {isLive, loadDocument, newId, onChange} from './collection.js';
import {MAX_ADD, conditionOptions, copyLanguages, finishFields, finishOptions, languageName, sheetDialog, sheetField, sheetSelect, showSheet} from './copy-sheet.js';
import {BASE, backWords, errorText, go, h, rememberInHistory} from './dom.js';
import {formatCount, plural} from './format.js';
import {formatMoney, shortDate} from './prices.js';
import {CURRENCIES, LOGGED_TEXT, TWICE_MONEY_TEXT, applyMove, cleanInPrices, editMove, liveMoves, monthTotals, moveTitle, ownPrices, parsePrice, pastCandidates, priceForInput, priceText, pricedCards, purchaseSources, sumPrices, takePendingMove, twiceOut, twiceOutText, undoMove} from './moves.js';
import {searchKey} from './names.js';
import {afterText, keptStartOver} from './placeholder-fill.js';
import {clearPurchase, clearTrade} from './scan/draft.js';
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

	// A copy logged out twice stays out with the other move (QA, 2026-11-20).
	if (counts.held) {
		parts.push(`${plural(counts.held, 'copy stays', 'copies stay')} out, as another trade or sale took ${counts.held === 1 ? 'it' : 'them'} out too.`);
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
// that takes it out of the move. extra goes under the meta: the card's own
// price on a purchase priced card by card.
function chosenRow(attrs, art, name, meta, onRemove, extra = null) {
	return h('div', {...attrs, class: 'move-row'},
		h('span', {class: 'move-row-thumb'}, art),
		h('div', {class: 'move-row-text'}, h('span', {class: 'move-row-name'}, name), h('span', {class: 'move-row-meta'}, meta), extra),
		h('button', {'aria-label': `Take ${name} out of the list`, class: 'move-row-remove move-unpick', onclick: onRemove, type: 'button'}, h('span', {'aria-hidden': 'true'}, '×')));
}

// "Price each card" (Eric, 2026-11-19): the switch on a purchase that
// gives each card coming in a price of its own, the total being their sum.
// The Pokémon list's switch (css/pokemon-cards.css), so the app has one.
function eachSwitch(id) {
	const box = h('input', {id, role: 'switch', type: 'checkbox'});
	const row = h('label', {class: 'pc-switch move-each', for: id}, box, h('span', {class: 'pc-switch-track', 'aria-hidden': 'true'}), h('span', null, 'Price each card'));

	return {box, row};
}

// The move's currency, beside the price. The price's label names the text
// field only, so the select carries a name of its own (accessibility audit,
// 2026-11-20: a combobox with no name).
function currencySelect(id, value) {
	const control = sheetSelect(id, CURRENCIES.map((code) => ({label: code, value: code})), value);

	control.setAttribute('aria-label', 'Currency');

	return control;
}

// The field after `input` in its form that takes typing (a text, number,
// or date field, a select, or a text area), focused; with none, the
// keyboard is put away.
function focusNextField(input) {
	const typed = (el) => (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['button', 'checkbox', 'hidden', 'radio', 'reset', 'submit'].includes(el.type)))
		&& !el.disabled && el.getClientRects().length > 0;
	const fields = input.form ? [...input.form.elements].filter((el) => el === input || typed(el)) : [];
	const next = fields[fields.indexOf(input) + 1];

	if (next) {
		next.focus();
	}
	else {
		input.blur();
	}
}

// One card's own price: typed and read back as Paid is (js/moves.js
// parsePrice, "Saved as R$ 12,00"), in the move's one currency. n copies
// each cost it (a card added with Copies 3 is three copies at one price),
// so the read-back says so. Blank is allowed: the card has no price of its
// own and counts 0 toward the total.
//
// The cards come first in the form, above Date, Who, Price, and Note, so
// Enter (Go on a phone's keyboard) in a card's price goes to the next field
// and never saves the form (v86 review: it saved with the details below
// still untouched); the keyboard's key says Next.
function cardPriceField(id, name, {currency, n = 1, onInput = () => {}, value = ''}) {
	const input = h('input', {'aria-label': `Price of ${name}${n > 1 ? `, each of ${n} copies` : ''}`, autocomplete: 'off', class: 'search move-card-price-input', enterkeyhint: 'next', id, inputmode: 'decimal', placeholder: '0,00', type: 'text', value});
	const read = h('p', {'aria-live': 'polite', class: 'muted move-price-read', id: `${id}-read`});
	const box = h('div', {class: 'move-card-price'}, h('label', {for: id}, n > 1 ? 'Price each' : 'Price'), input, read);

	function refresh() {
		const {error: wrong, value: amount} = parsePrice(input.value);

		read.classList.toggle('form-error', Boolean(wrong));
		read.textContent = wrong || (amount ? `Saved as ${formatMoney(amount, currency())}${n > 1 ? ` each, ${formatMoney(sumPrices(Array(n).fill(amount)), currency())} for ${n}` : ''}` : '');
	}

	input.addEventListener('input', () => {
		refresh();
		onInput();
	});
	input.addEventListener('keydown', (event) => {
		if (event.key === 'Enter' && !event.isComposing) {
			event.preventDefault();
			focusNextField(input);
		}
	});
	refresh();

	return {box, input, n, refresh};
}

// The total of the card prices, shown where Paid is typed, not typed itself.
const totalBox = (id) => h('output', {'aria-live': 'polite', class: 'move-price-total', id});

// The first card price that cannot be read, focused with its message in
// error, or false when every one reads (blank included).
function badCardPrice(fields, error) {
	const bad = fields.find((field) => parsePrice(field.input.value).error);

	if (!bad) {
		return false;
	}

	bad.refresh();
	error.textContent = parsePrice(bad.input.value).error;
	bad.input.focus();

	return true;
}

// The From field's hint and suggestions on a purchase (Eric, 2026-11-19):
// where earlier purchases came from, newest first (js/moves.js
// purchaseSources), as a datalist, so the phone offers them as he types.
const WHO_HINT = 'A store, site, event, or person';

function sourcesList(id, doc) {
	return h('datalist', {id}, purchaseSources(doc).map((name) => h('option', {value: name})));
}

// ------------------------------------------------------------- History

export function historyView(root) {
	let alive = true;
	const body = h('div', {class: 'moves-body', id: 'moves-body'}, h('p', {class: 'muted'}, 'Loading…'));
	const sheet = sheetDialog('move-sheet', 'Trade or sale');
	// The names of a move's cards, from the last draw, for Cancel in Edit.
	let cardNames = () => [];
	// The document and card names of the last draw, for a purchase's card
	// prices in its sheet and in Edit, and the From suggestions.
	let drawn = {doc: {}, info: () => ({name: ''})};
	const outNames = (move) => cardNames(move.out);
	const inNames = (move) => cardNames(move.in);

	async function draw() {
		const doc = await loadDocument();
		const index = await cardIndex().catch(() => new Map());

		if (!alive) {
			return;
		}

		const months = monthTotals(liveMoves(doc));
		// Copies logged out twice, on two phones offline (QA, 2026-11-20).
		const twice = twiceOut(liveMoves(doc));
		const byId = new Map((doc.cards || []).filter((entry) => entry && entry.id).map((entry) => [entry.id, entry]));
		const viewing = viewingLanguage();
		const names = (ids) => (ids || []).map((id) => byId.get(id)).filter(Boolean).map((entry) => entryInfo(entry, index, viewing).name);

		cardNames = names;
		drawn = {doc, info: (entry) => entryInfo(entry, index, viewing), twice};

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
				// Money's way in words, not In and Out, which the cards'
				// own Out: and In: lines use (design review 2, 2026-11-20).
				// Received and Paid, as a move's sheet says: the money in
				// counts cash received in a trade, not only sales (v86
				// review: it read Sold).
				h('p', {class: 'moves-money'}, [
					Object.keys(month.in).length ? `Received ${moneyLine(month.in)}` : null,
					Object.keys(month.out).length ? `Paid ${moneyLine(month.out)}` : null,
				].filter(Boolean).join(' · ') || 'No money in or out'),
				// The totals count every live move as logged; a month
				// counting a copy logged out twice says so (QA, 2026-11-20).
				month.twice ? h('p', {class: 'moves-twice-money'}, TWICE_MONEY_TEXT) : null
			),
			h('ul', {class: 'moves-list'}, month.moves.map((move) => {
				const out = names(move.out);
				const came = names(move.in);

				return h('li', null, h('button', {'aria-haspopup': 'dialog', class: 'moves-row', 'data-move': move.id, onclick: () => openMove(move, out, came), type: 'button'},
					h('span', {class: 'moves-title'}, moveTitle(move)),
					h('span', {class: 'moves-meta'}, [shortDate(move.date) || move.date, out.length ? `${formatCount(out.length)} out` : null, came.length ? `${formatCount(came.length)} in` : null].filter(Boolean).join(' · ')),
					h('span', {class: 'moves-cards'}, [out.length ? `Out: ${out.join(', ')}` : null, came.length ? `In: ${came.join(', ')}` : null].filter(Boolean).join('. ')),
					twice.has(move.id) ? h('span', {class: 'moves-twice'}, twiceOutText(twice.get(move.id), {names})) : null
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
		}, type: 'button'}, move.kind === 'bought' ? 'Undo this purchase' : 'Undo this trade or sale');
		const edit = h('button', {id: 'move-edit', onclick: () => editMoveForm(move), type: 'button'}, 'Edit');
		// A purchase priced card by card lists its cards with their prices
		// (Eric, 2026-11-19); a copy with none says so.
		const priced = pricedCards(move, drawn.doc.cards);
		const currency = CURRENCIES.includes(move.currency) ? move.currency : 'BRL';
		const cameIn = priced
			? h('dd', {id: 'move-sheet-in'}, h('ul', {class: 'move-priced'}, priced.map((row) => {
				const n = row.entries.length;
				const name = drawn.info(row.entries[0]).name;

				return h('li', null, `${name}${n > 1 ? ` (${n} copies)` : ''}, ${row.price ? `${formatMoney(row.price, currency)}${n > 1 ? ' each' : ''}` : 'no price'}`);
			})))
			: h('dd', {id: 'move-sheet-in'}, came.join(', '));

		sheet.replaceChildren(
			h('div', {class: 'sheet-head'},
				h('h2', {id: 'move-sheet-title'}, moveTitle(move)),
				h('button', {class: 'small', id: 'move-sheet-close', onclick: close, type: 'button'}, 'Close')
			),
			h('dl', {class: 'facts move-facts'},
				h('dt', null, 'Date'), h('dd', null, shortDate(move.date, {year: true}) || move.date),
				...(priceText(move) ? [h('dt', null, 'Money'), h('dd', {id: 'move-sheet-money'}, `${move.money === 'in' ? 'Received' : 'Paid'} ${priceText(move)}`)] : []),
				...(out.length ? [h('dt', null, 'Going out'), h('dd', {id: 'move-sheet-out'}, out.join(', '))] : []),
				...(came.length ? [h('dt', null, 'Coming in'), cameIn] : []),
				...(move.note ? [h('dt', null, 'Note'), h('dd', null, move.note)] : [])
			),
			drawn.twice && drawn.twice.has(move.id) ? h('p', {class: 'moves-twice', id: 'move-sheet-twice'}, twiceOutText(drawn.twice.get(move.id), {names: cardNames})) : null,
			h('div', {class: 'button-row move-sheet-actions'}, edit),
			h('p', {class: 'muted move-edit-hint'}, `Edit changes the date, ${move.kind === 'bought' ? 'where from, the prices' : 'who, price'}, and note. To change the cards, undo this trade or sale and log it again.`),
			h('div', {class: 'copy-danger'}, undo, confirm)
		);
		showSheet(sheet);
	}

	// Edit a logged move (Eric, 2026-11-05): the date, who, price with its
	// currency and which way it went, and the note, in the same sheet. The
	// cards stay as they are (js/moves.js planEditMove). The form keeps the
	// move it was filled from and saves only what was changed in it, so a
	// change another phone made while it was open stays. A purchase has From
	// with its suggestions and Price each card, as the log form does (Eric,
	// 2026-11-19); its card prices are saved with the total as one unit.
	function editMoveForm(move) {
		const opened = structuredClone(move);
		const close = () => sheet.close();
		const [whoWords, priceWords] = KIND_WORDS[move.kind] || KIND_WORDS.gift;
		const bought = move.kind === 'bought';
		const date = h('input', {class: 'search', id: 'move-edit-date', name: 'move-edit-date', type: 'date', value: move.date || today()});
		const who = h('input', {'aria-describedby': bought ? 'move-edit-who-hint' : null, autocomplete: 'off', class: 'search', id: 'move-edit-who', list: bought ? 'move-edit-who-sources' : null, maxlength: 80, name: 'move-edit-who', type: 'text', value: move.who || ''});
		const price = h('input', {class: 'search', id: 'move-edit-price', inputmode: 'decimal', name: 'move-edit-price', placeholder: '0,00', type: 'text', value: priceForInput(move.price)});
		const currency = currencySelect('move-edit-currency', CURRENCIES.includes(move.currency) ? move.currency : 'BRL');
		const money = sheetSelect('move-edit-money', [{label: 'I paid it', value: 'out'}, {label: 'I got it', value: 'in'}], move.money === 'in' ? 'in' : 'out');
		const priceRead = h('p', {'aria-live': 'polite', class: 'muted move-price-read', id: 'move-edit-price-read'});
		const note = h('textarea', {class: 'copy-notes', id: 'move-edit-note', maxlength: 500, name: 'move-edit-note', rows: 2});
		const error = h('p', {'aria-live': 'polite', class: 'form-error', id: 'move-edit-error'});
		const save = h('button', {class: 'primary', id: 'move-edit-save', type: 'submit'}, 'Save');
		const cancel = h('button', {id: 'move-edit-cancel', onclick: () => openMove(move, outNames(move), inNames(move)), type: 'button'}, 'Cancel');
		const priceLabel = h('label', {for: 'move-edit-price'}, priceWords);
		const total = totalBox('move-edit-price-total');
		// A purchase's cards, one row per card, language, and price, each
		// with its price: the prices it has, even ones an older phone's Edit
		// of the total left behind, so turning the switch on brings them back.
		const cards = bought && Array.isArray(move.in) && move.in.length ? pricedCards(move, drawn.doc.cards, cleanInPrices(move.in_prices, move.in) || {}) : null;
		const each = cards && cards.length ? eachSwitch('move-edit-each') : null;
		const fields = (cards || []).map((row, i) => {
			const name = drawn.info(row.entries[0]).name;
			const field = cardPriceField(`move-edit-card-price-${i}`, name, {currency: () => currency.value, n: row.entries.length, onInput: readPrice, value: priceForInput(row.price)});

			return {...field, name, row};
		});
		const cardList = h('div', {class: 'move-edit-cards', hidden: true, id: 'move-edit-cards'}, fields.map(({box, name, row}) => h('div', {class: 'move-edit-card', 'data-card': row.entries[0].card_id},
			h('span', {class: 'move-row-name'}, name),
			h('span', {class: 'move-row-meta'}, [row.entries.length > 1 ? `${row.entries.length} copies` : null, languageName(row.entries[0].language), row.entries[0].condition].filter(Boolean).join(' · ')),
			box)));
		const eachOn = () => Boolean(each && each.box.checked);
		const cardSum = () => sumPrices(fields.flatMap((field) => Array(field.n).fill(field.input.value)));

		note.value = move.note || '';

		if (each) {
			each.box.checked = Boolean(ownPrices(move));
		}

		// The price as it will be saved, as the log form shows it: with Price
		// each card on, the sum of the card prices.
		function readPrice() {
			if (eachOn()) {
				const sum = cardSum();

				priceRead.classList.remove('form-error');
				total.textContent = priceForInput(sum) || '0,00';
				priceRead.textContent = sum ? `Saved as ${formatMoney(sum, currency.value)}, the sum of the card prices` : 'No card has a price yet.';

				return;
			}

			const {error: wrong, value} = parsePrice(price.value);

			priceRead.classList.toggle('form-error', Boolean(wrong));
			priceRead.textContent = wrong || (value ? `Saved as ${formatMoney(value, currency.value)}` : '');
		}

		function drawEach() {
			const on = eachOn();

			price.hidden = on;
			total.hidden = !on;
			cardList.hidden = !on;
			priceLabel.textContent = on ? 'Total' : priceWords;
			priceLabel.setAttribute('for', on ? 'move-edit-price-total' : 'move-edit-price');
			readPrice();
		}

		price.addEventListener('input', () => {
			error.textContent = '';
			readPrice();
		});
		currency.addEventListener('change', () => {
			readPrice();
			fields.forEach((field) => field.refresh());
		});

		if (each) {
			each.box.addEventListener('change', () => {
				// Turned off with no total typed: the card prices' sum is kept
				// as the total rather than lost.
				if (!each.box.checked && !price.value.trim() && cardSum()) {
					price.value = priceForInput(cardSum());
				}

				error.textContent = '';
				drawEach();
			});
		}

		drawEach();

		const form = h('form', {class: 'copy-form move-form', id: 'move-edit-form', novalidate: true},
			sheetField('Date', 'move-edit-date', date),
			h('div', {class: 'copy-field'}, h('label', {for: 'move-edit-who'}, whoWords), who,
				...(bought ? [h('p', {class: 'muted move-who-hint', id: 'move-edit-who-hint'}, WHO_HINT), sourcesList('move-edit-who-sources', drawn.doc)] : [])),
			...(priceWords ? [h('div', {class: 'copy-field move-price-row'}, priceLabel, h('div', {class: 'move-price-inputs'}, price, total, h('span', {class: 'select-wrap'}, currency)), priceRead, ...(each ? [each.row, cardList] : []))] : []),
			...(move.kind === 'traded' ? [h('div', {class: 'copy-field'}, h('label', {for: 'move-edit-money'}, 'The cash'), h('span', {class: 'select-wrap'}, money))] : []),
			sheetField('Note', 'move-edit-note', note),
			error,
			h('div', {class: 'button-row'}, cancel, save)
		);

		form.addEventListener('submit', async (event) => {
			event.preventDefault();
			error.textContent = '';

			if (eachOn() && badCardPrice(fields, error)) {
				return;
			}

			if (!eachOn() && priceWords && parsePrice(price.value).error) {
				readPrice();
				error.textContent = parsePrice(price.value).error;
				price.focus();

				return;
			}

			const sent = {date: date.value || move.date, note: note.value, who: who.value};

			if (priceWords) {
				Object.assign(sent, {currency: currency.value, price: eachOn() ? priceForInput(cardSum()) : price.value});
			}

			// The card prices go with the total as one unit (js/moves.js
			// planEditMove): each copy of a row takes its row's price, and
			// with the switch off they are none, the total standing alone.
			if (each) {
				sent.in_prices = eachOn() ? Object.fromEntries(fields.flatMap((field) => field.row.entries.map((entry) => [entry.id, field.input.value]))) : null;
			}

			if (move.kind === 'traded') {
				sent.money = money.value;
			}

			save.disabled = true;

			try {
				const {changed} = await editMove(move.id, sent, {base: opened});

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
// price for a gift. The log form and Edit share them. A purchase's who is
// where it came from, a store, site, event, or person, so it reads From
// (Eric, 2026-11-19; it read "Bought from").
const KIND_WORDS = {
	bought: ['From', 'Paid (optional)'],
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

// ------------------------------------------------- the form kept for a reload

// The log form as it stands, kept for its history entry (QA, 2026-11-20: a
// reload, or Back then Forward, on the form the scanner opened showed an
// empty Sold form, the handoff taken and what was typed lost). Each form
// has a token in its history entry's state (moveForm), and under it in
// sessionStorage: {at, handed, moveId, typed}, handed being what the form
// was opened with (data only) and typed the form's fields and cards. Back
// or Forward to the entry finds it by the token. A reload on GitHub Pages
// goes through 404.html, which loses the entry's state (app.js
// restoreRedirectedPath), so a page load on the form with no state of its
// own takes the form this tab showed last (LAST_FORM_KEY); a screen opened
// from a link always has state, so Log a move still opens a blank form.
// sessionStorage lasts as long as the tab. A form goes when its move is
// saved (the save also replaces the entry, so Back never returns to it),
// when a newer form takes over the same scanner tray, and past the
// FORMS_KEPT newest. moveId is the id the move saves under, so the same
// form saved twice (a reload while it saved, a copied tab) logs it once
// (js/moves.js planMove).
const FORM_KEY = 'card-tracker-move-form:';
const LAST_FORM_KEY = 'card-tracker-move-form-last';
const FORMS_KEPT = 8;

function readLastForm() {
	try {
		return sessionStorage.getItem(LAST_FORM_KEY);
	}
	catch {
		return null;
	}
}

function writeLastForm(token) {
	try {
		sessionStorage.setItem(LAST_FORM_KEY, token);
	}
	catch {
		// A reload through 404.html opens a blank form, as before.
	}
}

function keptForms() {
	try {
		return Object.keys(sessionStorage).filter((key) => key.startsWith(FORM_KEY)).map((key) => {
			try {
				return {key, value: JSON.parse(sessionStorage.getItem(key)) || {}};
			}
			catch {
				return {key, value: {}};
			}
		});
	}
	catch {
		return [];
	}
}

function readForm(token) {
	try {
		const value = JSON.parse(sessionStorage.getItem(FORM_KEY + token) || 'null');

		return value && typeof value === 'object' && value.handed && typeof value.moveId === 'string' ? value : null;
	}
	catch {
		return null;
	}
}

function writeForm(token, value) {
	try {
		sessionStorage.setItem(FORM_KEY + token, JSON.stringify(value));
	}
	catch {
		// Kept until a reload only, as before.
	}
}

function dropForms(drop) {
	for (const {key, value} of keptForms()) {
		const token = key.slice(FORM_KEY.length);

		if (drop(token, value)) {
			try {
				sessionStorage.removeItem(key);

				if (readLastForm() === token) {
					sessionStorage.removeItem(LAST_FORM_KEY);
				}
			}
			catch {
				// Nothing kept to drop.
			}
		}
	}
}

// A new form: an older one for the same scanner tray is left for good (its
// cards are handed to this one, and two forms must never save them twice),
// and only the newest FORMS_KEPT stay.
function pruneForms(token, handed) {
	const tray = handed.from === 'scan' && handed.session ? handed.session : null;

	dropForms((other, value) => other !== token && Boolean(tray) && Boolean(value.handed) && value.handed.session === tray);

	const old = keptForms().filter(({key}) => key !== FORM_KEY + token).sort((a, b) => (b.value.at || 0) - (a.value.at || 0)).slice(FORMS_KEPT - 1);

	dropForms((other) => old.some(({key}) => key === FORM_KEY + other));
}

// The scanner's tray lets go of the cards of the sides a move saved, and
// only those handed over (js/scan/draft.js); a side the kind left out stays
// for another move. From the handoff's data, so a form kept for a reload
// does it too.
function letGoOfTray(handed, sides) {
	if (handed.from !== 'scan' || !handed.session) {
		return Promise.resolve();
	}

	if (handed.tray === 'trade') {
		return clearTrade(handed.session, sides, handed.items || {in: [], out: []});
	}

	if (handed.tray === 'add' && sides.in) {
		return clearPurchase(handed.session, (handed.items && handed.items.in) || []);
	}

	return Promise.resolve();
}

export function newMoveView(root) {
	let alive = true;
	// The form's title, which drawKind names for the kind picked.
	const heading = h('h2', null, 'Log a trade or sale');
	// A handoff just made opens a new form; otherwise the form this history
	// entry kept, if any (a reload, Back or Forward).
	const fresh = takePendingMove();
	const state = history.state;
	const pageLoad = !state || (!state.inApp && typeof state.moveForm !== 'string');
	const entryToken = state && typeof state.moveForm === 'string' ? state.moveForm : pageLoad ? readLastForm() : null;
	const restored = !fresh && entryToken ? readForm(entryToken) : null;
	const formToken = (!fresh && entryToken) || `f-${newId()}`;
	const handed = restored ? restored.handed : JSON.parse(JSON.stringify(fresh || {}));
	const moveId = restored ? restored.moveId : newId();
	const typed = (restored && restored.typed) || {};
	const formAt = (restored && restored.at) || Date.now();

	try {
		rememberInHistory({moveForm: formToken});
	}
	catch {
		// Kept until a reload only, as before.
	}

	writeLastForm(formToken);

	if (!restored) {
		pruneForms(formToken, handed);
	}

	const outIds = new Set(Array.isArray(typed.out) ? typed.out : handed.out || []);
	// What the scanner handed over, so the left-out line counts only its cards.
	const handedOut = new Set(handed.out || []);
	const pastIds = new Set(Array.isArray(typed.past) ? typed.past : []);
	// The cards in: {fields, info, n}. The scanner's Trade or sale mode hands
	// its cards coming in over in this shape (js/scan/trade.js tradeHandoff).
	// A kept form brings back its own, with the card prices typed (cardPrice).
	const ins = (Array.isArray(typed.ins) ? typed.ins : (handed.in || []).map((item) => ({...item, scanned: true})))
		.map((item) => ({cardPrice: item.cardPrice || '', fields: {...item.fields}, info: {...item.info}, n: item.n, scanned: Boolean(item.scanned)}));
	let kind = [typed.kind, handed.kind].find((value) => KIND_LABELS.some(([one]) => one === value)) || 'sold';
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
	// On a purchase: the hint, and the places of earlier purchases to pick
	// from, filled once his moves are read.
	const whoHint = h('p', {class: 'muted move-who-hint', hidden: true, id: 'move-who-hint'}, WHO_HINT);
	let sources = h('datalist', {id: 'move-who-sources'});
	const price = h('input', {class: 'search', id: 'move-price', inputmode: 'decimal', name: 'move-price', placeholder: '0,00', type: 'text'});
	const priceLabel = h('label', {for: 'move-price'}, 'Sold for (optional)');
	const currency = currencySelect('move-currency', 'BRL');
	const money = sheetSelect('move-money', [{label: 'I paid it', value: 'out'}, {label: 'I got it', value: 'in'}], 'out');
	const moneyRow = h('div', {class: 'copy-field', hidden: true}, h('label', {for: 'move-money'}, 'The cash'), h('span', {class: 'select-wrap'}, money));
	// The price as it will be saved, under the field as he types, so "1.500"
	// reads back as R$ 1.500,00 before he saves (js/moves.js parsePrice).
	const priceRead = h('p', {'aria-live': 'polite', class: 'muted move-price-read', id: 'move-price-read'});
	// Price each card, on a purchase (Eric, 2026-11-19): off, one total as
	// before; on, each card coming in has a price of its own, and the total
	// shows here, not typed, as their sum.
	const each = eachSwitch('move-each');
	const total = totalBox('move-price-total');
	const priceRow = h('div', {class: 'copy-field move-price-row'}, priceLabel, h('div', {class: 'move-price-inputs'}, price, total, h('span', {class: 'select-wrap'}, currency)), priceRead, each.row);
	const eachOn = () => kind === 'bought' && each.box.checked;
	let priceSeq = 0;

	// A card coming in's own price field, made once and kept on the card, so
	// a redraw of the list keeps what was typed and where the cursor is.
	function priceFieldOf(item) {
		if (!item.price) {
			item.price = cardPriceField(`move-card-price-${priceSeq++}`, item.info.name, {currency: () => currency.value, n: item.n, onInput: readPrice, value: item.cardPrice || ''});
		}

		return item.price;
	}

	const cardPrices = () => ins.map(priceFieldOf);
	const cardSum = () => sumPrices(ins.flatMap((item) => Array(item.n).fill(priceFieldOf(item).input.value)));

	function readPrice() {
		if (eachOn()) {
			const sum = cardSum();

			priceRead.classList.remove('form-error');
			total.textContent = priceForInput(sum) || '0,00';
			priceRead.textContent = sum ? `Saved as ${formatMoney(sum, currency.value)}, the sum of the card prices` : 'Type each card\'s price under Coming in, above. A card left blank has no price.';

			return;
		}

		const {error: wrong, value} = parsePrice(price.value);

		priceRead.classList.toggle('form-error', Boolean(wrong));
		priceRead.textContent = wrong || (value ? `Saved as ${formatMoney(value, currency.value)}` : '');
	}

	price.addEventListener('input', readPrice);
	currency.addEventListener('change', () => {
		readPrice();
		ins.forEach((item) => item.price && item.price.refresh());
	});
	each.box.addEventListener('change', () => {
		// Turned off with no total typed: the card prices' sum is kept as the
		// total rather than lost. The card prices stay typed for turning it
		// on again.
		if (!each.box.checked && !price.value.trim() && cardSum()) {
			price.value = priceForInput(cardSum());
		}

		error.textContent = '';
		drawKind();
	});
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
		const bought = kind === 'bought';
		const on = eachOn();

		// The title names a purchase as one (design review, 2026-11-19).
		heading.textContent = bought ? 'Log a purchase' : 'Log a trade or sale';

		whoLabel.textContent = words[0];
		whoHint.hidden = !bought;

		for (const [key, value] of [['list', 'move-who-sources'], ['aria-describedby', 'move-who-hint']]) {
			if (bought) {
				who.setAttribute(key, value);
			}
			else {
				who.removeAttribute(key);
			}
		}

		priceRow.hidden = !words[1];
		priceLabel.textContent = on ? 'Total' : words[1] || '';
		priceLabel.setAttribute('for', on ? 'move-price-total' : 'move-price');
		price.hidden = on;
		total.hidden = !on;
		each.row.hidden = !bought;
		readPrice();
		drawIn();
		moneyRow.hidden = kind !== 'traded';
		outSection.hidden = !side.out;
		inSection.hidden = !side.in;

		// A kind that leaves out cards the scanner handed over says so: they
		// are not saved, and stay in the scanner's trade tray (letGoOfTray).
		const left = handed.from === 'scan' ? leftOutText(kind, {in: ins.filter((item) => item.scanned).reduce((sum, item) => sum + item.n, 0), out: [...outIds].filter((id) => handedOut.has(id)).length}) : null;

		leftOut.hidden = !left;
		leftOut.textContent = left || '';
	}

	function drawChosen() {
		drawOut();
		drawIn();
	}

	const none = () => [h('p', {class: 'muted'}, 'None yet.')];

	function drawOut() {
		if (!doc) {
			return;
		}

		const byId = new Map(doc.cards.filter((entry) => entry && entry.id).map((entry) => [entry.id, entry]));
		const out = [...outIds, ...pastIds].map((id) => byId.get(id)).filter(Boolean);

		const dropOut = (id) => {
			outIds.delete(id);
			pastIds.delete(id);
			drawOut();
		};

		if (compact) {
			outList.replaceChildren(...(out.length ? described(out, index, viewing).map((item) => chosenRow({'data-entry': item.entry.id},
				artOf({catalog: item.entry.catalog || 'international', card_id: item.entry.card_id, language: item.entry.language || null}, item.info, (src) => cardArt(item.info, src, {decorative: true})),
				item.info.name,
				copyMeta(item.entry, pastIds.has(item.entry.id) ? `Removed ${shortDate(item.entry.deleted_at) || ''}` : null),
				() => dropOut(item.entry.id))) : none()));
		}
		else {
			outList.replaceChildren(...(out.length ? described(out, index, viewing).map((item) => h('div', {class: 'pick-cell', 'data-entry': item.entry.id},
				h('div', {class: 'pick'}, ...copyTile(item, {extra: pastIds.has(item.entry.id) ? `Removed ${shortDate(item.entry.deleted_at) || ''}` : null})),
				h('button', {'aria-label': `Take ${item.info.name} out of the list`, class: 'small move-unpick', onclick: () => dropOut(item.entry.id), type: 'button'}, 'Remove'))) : none()));
		}

		remember();

		// Only the cards going out are read again: the cards coming in keep
		// their price fields, and the cursor in one, while records arrive.
		fillRecords(out.map((entry) => ({cardId: entry.card_id, catalog: entry.catalog})), index, () => alive)
			.then((filled) => {
				if (filled && alive) {
					index = filled;
					drawOut();
				}
			})
			.catch(() => {});
	}

	// The cards coming in, each with its own price under it while Price each
	// card is on.
	function drawIn() {
		const dropIn = (i) => {
			ins.splice(i, 1);
			drawIn();
			readPrice();
		};
		const priced = (item) => (eachOn() ? priceFieldOf(item).box : null);
		const meta = (item) => [item.n > 1 ? `${item.n} copies` : null, languageName(item.fields.language), item.fields.condition].filter(Boolean).join(' · ');

		if (compact) {
			inList.replaceChildren(...(ins.length ? ins.map((item, i) => chosenRow({'data-card': item.fields.card_id},
				cardArt(item.info, item.info.image, {decorative: true}),
				item.info.name,
				meta(item),
				() => dropIn(i),
				priced(item))) : none()));
		}
		else {
			inList.replaceChildren(...(ins.length ? ins.map((item, i) => h('div', {class: 'pick-cell', 'data-card': item.fields.card_id},
				h('div', {class: 'pick'},
					h('div', {class: 'art-wrap'}, cardArt(item.info, item.info.image)),
					h('span', {class: 'tile-name'}, item.info.name),
					h('span', {class: 'tile-meta'}, meta(item))),
				priced(item),
				h('button', {'aria-label': `Take ${item.info.name} out of the list`, class: 'small move-unpick', onclick: () => dropIn(i), type: 'button'}, 'Remove'))) : none()));
		}

		remember();
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
		const spares = new Set(spareEntries(live, {held: placements(doc.binders || [])}).map((entry) => entry.id));
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

					remember();
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
			const finish = sheetSelect('move-in-finish', finishOptions(finishes, null, catalog), plain && finishes.some((option) => option.value === plain) ? plain : '');
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

				// The same finishes as the copy sheet's Add, a print the
				// catalog does not list kept as its word (2026-11-19).
				const chosen = finishFields(finish.value, catalog);
				const fields = {card_id: card.id, catalog, language: language.value, language_source: 'manual', variant_id: chosen.variant_id || null};

				if (chosen.finish_raw) {
					fields.finish_raw = chosen.finish_raw;
				}

				if (catalogFor(language.value) !== catalog) {
					fields.fallback = true;
				}

				if (condition.value) {
					fields.condition = condition.value;
				}

				ins.push({fields, info, n});
				readPrice();

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

	// The cards first, then the details (design review 2, 2026-11-20): with
	// the cards last under a sticky Save, the form looked complete with no
	// card picked. With Price each card on, each price sits with its card.
	const formElement = h('form', {class: 'copy-form move-form', id: 'move-form', novalidate: true},
		kinds,
		...(scanned ? [scanned, leftOut] : []),
		outSection,
		inSection,
		sheetField('Date', 'move-date', date),
		h('div', {class: 'copy-field'}, whoLabel, who, whoHint, sources),
		priceRow,
		moneyRow,
		sheetField('Note', 'move-note', note),
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

		if (eachOn() && badCardPrice(cardPrices(), error)) {
			return;
		}

		if (!priceRow.hidden && !eachOn() && parsePrice(price.value).error) {
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
				price: priceRow.hidden || eachOn() ? null : price.value,
				who: who.value,
				// One price per copy, in the order of `in`: a card added with
				// Copies 3 gives its price to each of its three copies.
				...(eachOn() ? {in_prices: ins.flatMap((item) => Array(item.n).fill(priceFieldOf(item).input.value))} : {}),
			}, {id: moveId});
		}
		catch (err) {
			if (err.logged) {
				loadDocument().then((now) => savedAlready(liveMoves(now).find((one) => one.id === moveId)), () => savedAlready(null));

				return;
			}

			save.disabled = false;
			error.textContent = `Not saved. ${errorText(err)}`;

			return;
		}

		const {counts, move} = result;

		forget();

		// The scanner's tray lets go of the sides this move saved; a side
		// the kind left out stays there.
		letGoOfTray(handed, side).catch(() => {});
		const words = [counts.out + counts.past ? `${plural(counts.out + counts.past, 'card', 'cards')} out` : null, counts.in ? `${plural(counts.in, 'card', 'cards')} in` : null].filter(Boolean).join(', ');
		const after = afterText({got: {length: counts.got}, placed: {length: counts.filled}});

		go('trades', {replace: true});
		toast(`Saved: ${words}.${after ? ` ${after}` : ''}`, {
			action: () => runUndo(move.id),
			actionLabel: 'Undo',
			timeout: UNDO_MS,
		});
	});

	// Who it is with, when the handoff names them (Trade ideas, js/wishlist-view.js:
	// "Log a trade with Leo"); a kept form's own typing wins below.
	if (typeof handed.who === 'string') {
		who.value = handed.who;
	}

	// A kept form's fields as they were.
	if (restored) {
		for (const [field, value] of [[date, typed.date], [who, typed.who], [price, typed.price], [note, typed.note]]) {
			if (typeof value === 'string') {
				field.value = value;
			}
		}

		if (CURRENCIES.includes(typed.currency)) {
			currency.value = typed.currency;
		}

		if (typed.money === 'in' || typed.money === 'out') {
			money.value = typed.money;
		}

		each.box.checked = Boolean(typed.each);
	}

	// Saved, or saved already: nothing is kept for this form from now on.
	let settled = false;

	// The form as it stands, kept for this history entry (FORM_KEY).
	function remember() {
		if (settled || !alive) {
			return;
		}

		writeForm(formToken, {
			at: formAt,
			handed,
			moveId,
			typed: {
				currency: currency.value,
				date: date.value,
				each: each.box.checked,
				ins: ins.map((item) => ({cardPrice: item.price ? item.price.input.value : item.cardPrice, fields: item.fields, info: item.info, n: item.n, scanned: item.scanned})),
				kind,
				money: money.value,
				note: note.value,
				out: [...outIds],
				past: [...pastIds],
				price: price.value,
				who: who.value,
			},
		});
	}

	// The move is saved: the form is not kept, and the form for the same
	// scanner tray is not either.
	function forget() {
		settled = true;
		dropForms((other, value) => other === formToken || (handed.from === 'scan' && Boolean(handed.session) && Boolean(value.handed) && value.handed.session === handed.session));
	}

	// This form's move is in the log already, saved before a reload or from
	// a copied tab: nothing is saved again, the scanner's tray lets go of
	// the cards the move took, as the save would have, and History opens.
	function savedAlready(move) {
		forget();

		if (move) {
			letGoOfTray(handed, {in: move.in.length > 0, out: move.out.length > 0}).catch(() => {});
		}

		go('trades', {replace: true});
		toast(LOGGED_TEXT);
	}

	formElement.addEventListener('input', remember);
	formElement.addEventListener('change', remember);

	root.append(
		h('a', {class: 'back', 'data-link': 'trades', href: `${BASE}trades`}, backWords('Trades and sales')),
		h('div', {class: 'view-head'}, heading),
		formElement
	);
	drawKind();
	remember();

	Promise.all([loadDocument(), cardIndex().catch(() => new Map())]).then(async ([loaded, read]) => {
		if (!alive) {
			return;
		}

		doc = loaded;
		index = read;

		// Kept from before a reload, and saved since.
		if (restored && (doc.moves || []).some((move) => move && move.id === moveId)) {
			savedAlready(liveMoves(doc).find((move) => move.id === moveId));

			return;
		}

		kept = await keptStartOver(doc).catch(() => null);

		if (!alive) {
			return;
		}

		const filled = sourcesList('move-who-sources', doc);

		sources.replaceWith(filled);
		sources = filled;

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
