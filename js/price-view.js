// Price components: the card detail's price block, a tile's price, and the
// statistics bar for any set of cards. Styles are in css/prices.css; the data
// is js/prices.js.
//
// Brazil first: the Liga Pokémon price the owner typed in leads, large, next
// to Ver na Liga, the main price action (open Liga, read, come back, type).
// The US market price (TCGplayer) follows, smaller, as a converted
// reference. No Cardmarket price is shown.

import {languageLabel} from './catalog.js';
import {updateCards} from './collection.js';
import {h} from './dom.js';
import {ligaUrl} from './liga.js';
import {
	LIGA_SOURCE,
	MANUAL_FIELDS,
	ageText,
	cleanManualPrice,
	exchangeRates,
	extractPrices,
	finishOf,
	formatBrl,
	formatBrlCompact,
	formatMoney,
	listStats,
	manualPrice,
	newestManual,
	parseBrl,
	savedRates,
	tileValue,
	today,
	usdToBrl,
} from './prices.js';

let sectionCount = 0;

// A date that never breaks at its hyphens.
const day = (date) => h('span', {class: 'price-nowrap'}, date);

const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

// "Liga Pokémon · 2026-09-19 · 12 days ago".
function dateLine(source, date) {
	const age = date ? ageText(date) : null;
	const parts = [source, date ? day(date) : null, age].filter(Boolean);

	return parts.flatMap((part, i) => (i ? [' · ', part] : [part]));
}

// "R$ 45,90 lowest NM, R$ 52,30 average (Liga Pokémon, 2026-09-19)": one
// copy's Liga price as a line for a "Your copies" row, or null.
export function copyPriceText(entry) {
	const manual = manualPrice(entry);

	if (!manual) {
		return null;
	}

	const parts = [
		manual.low_nm !== null ? `${formatBrl(manual.low_nm)} lowest NM` : null,
		manual.avg !== null ? `${formatBrl(manual.avg)} average` : null,
	].filter(Boolean);

	return `${parts.join(', ')} (${[manual.source, manual.date].filter(Boolean).join(', ')})`;
}

// The US$ line under an estimate, and where its rate came from.
function rateLine(rates) {
	if (!rates) {
		return ['No exchange rate is saved on this phone yet, so the reais value is not shown.'];
	}

	return [`At ${formatBrl(rates.brlPerUsd)} per US$ 1, rate of `, day(rates.date), rates.fresh === false ? ', the last rate saved on this phone.' : '.'];
}

// The Liga price editor. Two amounts that accept a decimal comma, and one
// tap to save; the source and date sit behind a disclosure with their
// defaults filled in.
function ligaEditor({current, group, id, onCancel, onSave}) {
	const field = (key, value) => {
		const input = h('input', {
			autocomplete: 'off',
			class: 'price-amount',
			id: `${id}-${key}`,
			inputmode: 'decimal',
			name: key,
			placeholder: '0,00',
			type: 'text',
			value: value !== null && value !== undefined ? formatBrl(value).replace(/^R\$\s/, '') : '',
		});

		return {
			input,
			row: h('label', {class: 'price-field', for: `${id}-${key}`},
				h('span', null, MANUAL_FIELDS[key]),
				h('span', {class: 'price-amount-wrap'}, h('span', {'aria-hidden': 'true', class: 'price-currency'}, 'R$'), input)
			),
		};
	};
	const low = field('low_nm', current && current.low_nm);
	const avg = field('avg', current && current.avg);
	const source = h('input', {id: `${id}-source`, list: `${id}-sources`, name: 'source', type: 'text', value: (current && current.source) || LIGA_SOURCE});
	const date = h('input', {id: `${id}-date`, max: today(), name: 'date', type: 'date', value: today()});
	const status = h('p', {'aria-live': 'polite', class: 'price-form-status', role: 'status'});
	const save = h('button', {class: 'primary', type: 'submit'}, group.length > 1 ? `Save to ${plural(group.length, 'copy', 'copies')}` : 'Save');

	const form = h('form', {class: 'price-form', novalidate: true},
		h('div', {class: 'price-fields'}, low.row, avg.row),
		h('details', {class: 'price-more'},
			h('summary', null, 'Source and date'),
			h('label', {class: 'price-field', for: `${id}-source`}, h('span', null, 'Source'), source),
			h('datalist', {id: `${id}-sources`}, h('option', {value: LIGA_SOURCE})),
			h('label', {class: 'price-field', for: `${id}-date`}, h('span', null, 'Date'), date)
		),
		status,
		h('div', {class: 'price-form-actions'},
			save,
			current ? h('button', {class: 'link-button price-clear', type: 'button', onclick: () => onSave(null)}, 'Remove Liga price') : null,
			onCancel ? h('button', {class: 'link-button', type: 'button', onclick: onCancel}, 'Cancel') : null
		)
	);

	form.addEventListener('submit', async (event) => {
		event.preventDefault();

		const bad = [[low, MANUAL_FIELDS.low_nm], [avg, MANUAL_FIELDS.avg]].find(([item]) => Number.isNaN(parseBrl(item.input.value)));

		for (const item of [low, avg]) {
			item.input.removeAttribute('aria-invalid');
		}

		if (bad) {
			bad[0].input.setAttribute('aria-invalid', 'true');
			bad[0].input.focus();
			status.textContent = `${bad[1]} must be an amount in reais, such as 45,90.`;

			return;
		}

		let manual;

		try {
			manual = cleanManualPrice({avg: avg.input.value, date: date.value, low_nm: low.input.value, source: source.value});
		}
		catch (err) {
			status.textContent = err.message;

			return;
		}

		if (!manual) {
			low.input.focus();
			status.textContent = 'Type at least one of the two prices.';

			return;
		}

		save.disabled = true;
		status.textContent = 'Saving.';

		try {
			await onSave(manual);
		}
		catch (err) {
			save.disabled = false;
			status.textContent = `Not saved: ${err.message || err}`;
		}
	});

	return {focus: () => low.input.focus(), form};
}

// The card detail's price block for one card.
//
//   card            the TCGdex card record (any language; its pricing is the
//                   same international product)
//   variantId       the finish to show first; else the first copy's finish
//   language        the copy's printed language, for the market note and to
//                   pick which copies a Liga price is saved to (null: any)
//   entries         the owner's live copies of this card ([] when none)
//   recordLanguage  the language of card; Ver na Liga is built from it only
//                   when it is 'en', since Liga searches by English name
//   ligaHref        a ready Ver na Liga URL, or null for none; overrides the
//                   one built from card
//   rates           an exchange rate to use instead of the saved one
//   save            (patches) => Promise, defaults to collection updateCards
//   onSaved         (entries) => void after a Liga price is saved
export function priceSection({card, entries = [], language = null, ligaHref, onSaved = null, rates = undefined, recordLanguage = 'en', save = updateCards, variantId = null} = {}) {
	const id = `price-${++sectionCount}`;
	const finishes = extractPrices(card);
	const section = h('section', {'aria-labelledby': `${id}-title`, class: 'price'});
	let copies = (entries || []).filter((entry) => entry && !entry.deleted_at);
	let rate = rates !== undefined ? rates : savedRates();
	let editing = false;

	const ownedOf = (finish) => copies.filter((entry) => finishOf(entry, finishes) === finish);

	let selected = finishes.find((finish) => variantId && finish.variantId === variantId)
		|| finishes.find((finish) => ownedOf(finish).length)
		|| finishes.find((finish) => finish.tcgplayer)
		|| finishes[0]
		|| null;

	const set = (card && card.set) || {};
	const href = ligaHref !== undefined
		? ligaHref
		: recordLanguage === 'en' && card
			? ligaUrl({localId: card.localId, name: card.name, official: set.cardCount && set.cardCount.official, setId: set.id, setName: set.name})
			: null;

	// The copies a Liga price is read from and saved to: this finish, in the
	// copy's language when one is given. With no finishes (a record without
	// variants), every copy.
	const group = () => {
		const mine = selected ? ownedOf(selected) : finishes.length ? [] : copies;

		return language ? mine.filter((entry) => entry.language === language) : mine;
	};

	function switcher() {
		if (finishes.length < 2) {
			return null;
		}

		return h('div', {'aria-label': 'Finish', class: 'price-finishes', role: 'group'},
			finishes.map((finish) => {
				const owned = ownedOf(finish).length;

				return h('button', {
					'aria-pressed': finish === selected ? 'true' : 'false',
					class: 'chip price-finish',
					type: 'button',
					onclick: () => {
						selected = finish;
						editing = false;
						draw();
					},
				}, finish.label, owned ? ` (${owned} owned)` : null);
			})
		);
	}

	function ligaLink() {
		if (href) {
			return h('a', {class: 'button primary price-liga-link', href, rel: 'noopener noreferrer', target: '_blank'},
				'Ver na Liga',
				h('span', {'aria-hidden': 'true', class: 'price-out'}, ' ↗'),
				h('span', {class: 'price-sr'}, ' (opens Liga Pokémon)')
			);
		}

		const asian = ['ja', 'ko', 'zh-cn', 'zh-tw'].includes(language);

		return h('p', {class: 'muted price-liga-none'}, asian ? `No Liga link for ${languageLabel(language)} prints.` : 'No Liga link for this card.');
	}

	async function store(manual) {
		const targets = group();
		const changed = await save(targets.map((entry) => ({id: entry.id, patch: {price_manual: manual}})));
		const byId = new Map((changed || []).map((entry) => [entry.id, entry]));

		copies = copies.map((entry) => byId.get(entry.id) || (targets.includes(entry) ? {...entry, price_manual: manual} : entry));
		editing = false;
		draw();

		const button = section.querySelector('.price-edit');

		if (button) {
			button.focus();
		}

		if (onSaved) {
			onSaved(copies);
		}
	}

	function ligaBlock() {
		const mine = group();
		const manual = newestManual(mine);
		const block = h('div', {class: 'price-liga'},
			h('p', {class: 'price-market'}, 'Brazil (Liga Pokémon)')
		);

		if (manual) {
			block.append(
				h('dl', {class: 'price-liga-values'},
					manual.low_nm !== null ? h('div', null, h('dt', null, MANUAL_FIELDS.low_nm), h('dd', {class: 'price-big'}, formatBrl(manual.low_nm))) : null,
					manual.avg !== null ? h('div', null, h('dt', null, MANUAL_FIELDS.avg), h('dd', {class: 'price-big'}, formatBrl(manual.avg))) : null
				),
				h('p', {class: 'price-meta price-liga-date'}, dateLine(manual.source, manual.date))
			);
		}
		else if (mine.length) {
			block.append(h('p', {class: 'muted price-none'}, 'No Liga price saved for this finish yet.'));
		}
		else {
			block.append(h('p', {class: 'muted price-none'}, copies.length ? 'You have no copy of this finish to save a Liga price on.' : 'Add a copy of this card to save its Liga price.'));
		}

		const actions = h('div', {class: 'price-actions'}, ligaLink());

		if (mine.length && manual && !editing) {
			actions.append(h('button', {class: 'price-edit', type: 'button', onclick: () => {
				editing = true;
				draw();
				section.querySelector('.price-amount').focus();
			}}, 'Update Liga price'));
		}

		block.append(actions);

		// With no price yet, the fields are already open: back from Liga, the
		// owner types and saves without another tap.
		if (mine.length && (!manual || editing)) {
			block.append(ligaEditor({
				current: editing ? manual : null,
				group: mine,
				id,
				onCancel: editing ? () => {
					editing = false;
					draw();
				} : null,
				onSave: store,
			}).form);
		}

		return block;
	}

	function usBlock() {
		const tcg = selected && selected.tcgplayer;
		const block = h('div', {class: 'price-us'},
			h('p', {class: 'price-market'}, 'US market reference (TCGplayer)')
		);

		if (!tcg || tcg.marketPrice === null) {
			block.append(h('p', {class: 'muted price-none'}, 'No US market price for this finish.'));

			return block;
		}

		const brl = usdToBrl(tcg.marketPrice, rate);

		// append prints a null argument as "null", so the optional line is
		// filtered out when there is no rate.
		block.append(...[
			brl !== null
				? h('p', {class: 'price-us-value'}, h('span', {'aria-hidden': 'true'}, '~'), h('span', {class: 'price-sr'}, 'About '), formatBrl(brl), h('span', {class: 'price-estimate'}, ' estimate'))
				: null,
			h('p', {class: 'price-meta price-us-usd'}, `${formatMoney(tcg.marketPrice, 'USD')} market price`, tcg.date ? [', updated ', day(tcg.date)] : null),
			h('p', {class: 'price-meta price-rate'}, rateLine(rate)),
		].filter(Boolean));

		if (selected.shared.length) {
			block.append(h('p', {class: 'price-meta price-shared'}, `TCGplayer lists this with ${selected.shared.join(' and ')} as one price, so it may not tell them apart.`));
		}

		if (language && language !== 'en') {
			block.append(h('p', {class: 'price-meta price-language'}, `This is the US price for English cards, not for this ${languageLabel(language)} printing.`));
		}

		return block;
	}

	// The chosen finish chip, scrolled into the row's view without moving
	// the page.
	function revealChoice() {
		const row = section.querySelector('.price-finishes');
		const chip = row && row.querySelector('[aria-pressed="true"]');

		if (chip && row.scrollWidth > row.clientWidth) {
			const left = chip.offsetLeft - row.offsetLeft;

			if (left < row.scrollLeft || left + chip.offsetWidth > row.scrollLeft + row.clientWidth) {
				row.scrollLeft = Math.max(0, left - 16);
			}
		}
	}

	function draw() {
		const scroll = section.querySelector('.price-finishes');
		const kept = scroll ? scroll.scrollLeft : 0;

		section.replaceChildren(...[
			h('h3', {id: `${id}-title`}, 'Price'),
			switcher(),
			ligaBlock(),
			usBlock(),
		].filter(Boolean));

		const row = section.querySelector('.price-finishes');

		if (row) {
			row.scrollLeft = kept;
		}

		if (section.isConnected) {
			revealChoice();
		}
		else {
			requestAnimationFrame(revealChoice);
		}
	}

	draw();

	if (rates === undefined) {
		exchangeRates().then((fresh) => {
			if (fresh && (!rate || fresh.brlPerUsd !== rate.brlPerUsd || fresh.date !== rate.date || fresh.fresh !== rate.fresh)) {
				rate = fresh;

				// Redraws only the US block, so a half-typed Liga price stays.
				const old = section.querySelector('.price-us');

				if (old) {
					old.replaceWith(usBlock());
				}
			}
		}).catch(() => {
			// The saved rate, or none, stays on screen.
		});
	}

	return section;
}

// A tile's price for its copies (one card), for the caller to place: the
// Liga price first, else the US estimate marked "~" and "US". Null when
// neither is known. card is the TCGdex record, which carries the US price;
// a card index record has none, so only Liga prices show with one.
export function tilePrice(entries, card, {basis = 'avg', rates = savedRates()} = {}) {
	const value = tileValue(entries, card, {basis, rates});

	if (!value) {
		return null;
	}

	const text = formatBrlCompact(value.brl);

	if (value.kind === 'liga') {
		return h('span', {class: 'price-tile', title: `Liga Pokémon, ${value.date || 'no date'}`}, text);
	}

	return h('span', {'aria-label': `About ${text}, US market estimate`, class: 'price-tile price-tile-estimate', title: 'Estimated from the US market (TCGplayer)'},
		h('span', {'aria-hidden': 'true'}, `~${text}`),
		h('span', {'aria-hidden': 'true', class: 'price-tile-us'}, 'US')
	);
}

// The statistics bar for any set of copies (a binder, a list, a set, the
// Trade spares, the whole collection): total, average, highest, lowest, and
// how many are priced by Liga, by US estimate, or not at all. Estimated
// values carry "~". The Liga average or lowest NM price is the basis, with a
// switch between them.
//
//   entries    the copies
//   cardsById  TCGdex card records, keyed as js/prices.js listStats takes
//   basis      'avg' (default) or 'low_nm'
//   rates      an exchange rate to use instead of the saved one
//   label      what the cards are, for the bar's accessible name
export function statsBar({basis = 'avg', cardsById, entries, label = 'these cards', rates = savedRates()} = {}) {
	const id = `price-${++sectionCount}`;
	const bar = h('section', {'aria-label': `Value of ${label}`, class: 'price-stats'});
	let chosen = basis === 'low_nm' ? 'low_nm' : 'avg';

	const amount = (item) => (item.kind === 'estimate' ? `~${formatBrl(item.brl)}` : formatBrl(item.brl));

	function draw() {
		const stats = listStats(entries, cardsById, {basis: chosen, rates});
		const parts = [];

		if (stats.priced) {
			const estimated = stats.estimate.count > 0;

			parts.push(
				h('div', {class: 'price-stats-main'},
					h('p', null, h('span', {class: 'price-stats-label'}, 'Total'), h('strong', {class: 'price-stats-total'}, `${estimated ? '~' : ''}${formatBrl(stats.total)}`)),
					h('p', null, h('span', {class: 'price-stats-label'}, 'Average'), h('strong', {class: 'price-stats-average'}, `${estimated ? '~' : ''}${formatBrl(stats.average)}`))
				),
				h('p', {class: 'price-stats-range'},
					h('span', {class: 'price-stats-highest'}, `Highest ${amount(stats.highest)}, ${stats.highest.name}`),
					h('span', {class: 'price-stats-lowest'}, `Lowest ${amount(stats.lowest)}, ${stats.lowest.name}`)
				)
			);
		}
		else {
			parts.push(h('p', {class: 'price-stats-none'}, `No prices known for ${label} yet.`));
		}

		parts.push(h('p', {class: 'price-stats-counts'},
			h('span', {class: 'price-count-liga'}, `${plural(stats.liga.count, 'card', 'cards')} by Liga`),
			h('span', {class: 'price-count-estimate'}, `${plural(stats.estimate.count, 'card', 'cards')} by US estimate (~)`),
			h('span', {class: 'price-count-unknown'}, `${plural(stats.unknown.count, 'card', 'cards')} unknown`)
		));

		const notes = [];

		if (stats.estimate.count) {
			notes.push(`${formatBrl(stats.estimate.total)} of the total is estimated from the US market at the rate of `, day(stats.rateDate), '.');
		}

		if (stats.unknown.count) {
			notes.push(notes.length ? ' ' : '', 'Unknown prices are left out of the total and the average, not counted as zero.');
		}

		if (stats.unknown.noRate) {
			notes.push(notes.length ? ' ' : '', `${plural(stats.unknown.noRate, 'card has', 'cards have')} a US price but no exchange rate is saved on this phone yet.`);
		}

		if (notes.length) {
			parts.push(h('p', {class: 'muted price-stats-notes'}, notes));
		}

		const option = (value, text) => h('label', null,
			h('input', {checked: chosen === value, name: `${id}-basis`, type: 'radio', value, onchange: () => {
				chosen = value;
				draw();
				bar.querySelector(`input[value="${value}"]`).focus();
			}}),
			h('span', null, text)
		);

		parts.push(h('fieldset', {class: 'segmented price-basis'},
			h('legend', {class: 'price-sr'}, 'Liga price to use'),
			option('avg', 'Liga average'),
			option('low_nm', 'Liga lowest NM')
		));

		bar.replaceChildren(...parts);
	}

	draw();

	return bar;
}
