// The Value sheet: what a list of copies is worth, opened on demand from a
// small Value button (DESIGN.md section 10: never a headline total). It
// leads with how much of the list has a price at all, because a total over
// half the cards reads as the whole collection's otherwise. My Cards opens
// it; the Trade view can open it for the spares the same way, and a set, a
// list, and a binder through valueButton below.

import {cardIndex, savedCardRecords} from './catalog.js';
import {h} from './dom.js';
import {statsBar} from './price-view.js';
import {copyValue, savedRates} from './prices.js';

const ASIAN = new Set(['ja', 'ko', 'zh-cn', 'zh-tw']);

const count = (n) => Number(n).toLocaleString('en-US');

const copies = (n) => `${count(n)} ${n === 1 ? 'copy' : 'copies'}`;

// Why a copy has a price or not:
//   'priced'   a Liga price, or a US estimate
//   'asian'    a Japanese, Korean, or Chinese print: no market price exists
//   'waiting'  an international card whose full record is not on the phone
//              yet (the background pass reads it)
//   'none'     the record is here, and TCGdex has no market price for it
//   'norate'   a US price, but no exchange rate saved yet
// record is the full TCGdex record when saved (it carries the prices),
// else null.
export function priceState(entry, record, rates) {
	const value = copyValue(entry, record, {rates});

	if (value.kind !== 'unknown') {
		return 'priced';
	}

	if (ASIAN.has(entry.catalog)) {
		return 'asian';
	}

	if (!record) {
		return 'waiting';
	}

	return value.usd === null || value.usd === undefined ? 'none' : 'norate';
}

// {count, priced, asian, waiting, none, norate} over live copies. saved maps
// "<catalog>|<card id>" to the full records on the phone.
export function priceCoverage(entries, saved, rates = savedRates()) {
	const out = {asian: 0, count: 0, none: 0, norate: 0, priced: 0, waiting: 0};

	for (const entry of entries || []) {
		if (!entry || entry.deleted_at) {
			continue;
		}

		out.count++;
		out[priceState(entry, saved.get(`${entry.catalog || 'international'}|${entry.card_id}`) || null, rates)]++;
	}

	return out;
}

let sheetCount = 0;

// Opens the sheet. Options:
//   entries         the copies
//   cardsById       records for statsBar: card index records with the saved
//                   full records over them
//   saved           the full records alone, Map "<catalog>|<card id>"
//   label           what the copies are ("your collection")
//   onShowUnpriced  when given, a link filters the screen to the copies
//                   without a price; the sheet closes first
//   filling         true while the background pass is still reading prices
// Returns the dialog, already open; it removes itself when closed.
export function openValueSheet({cardsById, entries, filling = false, label = 'these cards', onShowUnpriced = null, rates = savedRates(), saved}) {
	const id = `value-sheet-${++sheetCount}`;
	const coverage = priceCoverage(entries, saved, rates);
	const unpriced = coverage.count - coverage.priced;
	const opener = document.activeElement;
	const lines = [];

	if (coverage.asian) {
		lines.push(h('li', {class: 'vs-asian'}, `${copies(coverage.asian)} ${coverage.asian === 1 ? 'is a Japanese, Korean, or Chinese print' : 'are Japanese, Korean, or Chinese prints'} with no market price.`));
	}

	if (coverage.waiting) {
		lines.push(h('li', {class: 'vs-waiting'}, `${copies(coverage.waiting)} still ${coverage.waiting === 1 ? 'waits' : 'wait'} for a price${filling ? '; prices download while My Cards is open' : ''}.`));
	}

	if (coverage.none) {
		lines.push(h('li', {class: 'vs-none'}, `${copies(coverage.none)} ${coverage.none === 1 ? 'has' : 'have'} no market price on TCGdex.`));
	}

	if (coverage.norate) {
		lines.push(h('li', {class: 'vs-norate'}, `${copies(coverage.norate)} ${coverage.norate === 1 ? 'has' : 'have'} a US price but no exchange rate on this phone yet.`));
	}

	const sheet = h('dialog', {'aria-labelledby': `${id}-title`, class: 'sheet value-sheet', id},
		h('div', {class: 'sheet-head'},
			h('h2', {id: `${id}-title`}, 'Value'),
			h('button', {class: 'small', onclick: () => sheet.close(), type: 'button'}, 'Close')
		),
		h('div', {class: 'vs-body'},
			h('p', {class: 'vs-coverage'}, h('strong', null, `Priced: ${count(coverage.priced)} of ${copies(coverage.count)}`)),
			lines.length ? h('ul', {class: 'vs-reasons'}, lines) : null,
			onShowUnpriced && unpriced ? h('button', {class: 'link-button vs-unpriced', onclick: () => {
				sheet.close();
				onShowUnpriced();
			}, type: 'button'}, `Show the ${copies(unpriced)} without a price`) : null,
			h('h3', {class: 'vs-of'}, coverage.priced === coverage.count ? 'All copies are priced' : 'Of the priced copies'),
			statsBar({cardsById, entries, label, rates})
		)
	);

	sheet.addEventListener('click', (event) => {
		if (event.target === sheet) {
			sheet.close();
		}
	});
	sheet.addEventListener('close', () => {
		sheet.remove();

		if (opener && opener.isConnected && typeof opener.focus === 'function') {
			opener.focus();
		}
	});
	document.body.append(sheet);
	sheet.showModal();

	return sheet;
}

// The small Value button for a screen that is not My Cards (a set, a list,
// a binder): entries() gives the copies at the tap, and the records the
// sheet needs are read then, not on every redraw. id names the button;
// label says what the copies are ("your cards from Base"), or is a function
// that does at the tap.
export function valueButton({entries, id, label}) {
	let opening = false;

	const button = h('button', {'aria-haspopup': 'dialog', class: 'small value-open', id, onclick: async () => {
		if (opening) {
			return;
		}

		opening = true;

		try {
			const list = entries();
			const [index, saved] = await Promise.all([cardIndex().catch(() => new Map()), savedCardRecords(list)]);

			if (button.isConnected) {
				button.focus();
				openValueSheet({cardsById: new Map([...index, ...saved]), entries: list, label: typeof label === 'function' ? label() : label, saved});
			}
		}
		finally {
			opening = false;
		}
	}, type: 'button'}, 'Value');

	return button;
}
