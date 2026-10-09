// Price components: the card detail's price block, a tile's price, and the
// statistics bar for any set of cards. Styles are in css/prices.css; the data
// is js/prices.js.
//
// The automatic prices lead (Eric, 2026-10-09): TCGplayer's US market price
// and Cardmarket's EU trend, each converted to reais and marked approximate,
// with the original amount small under it. The real Brazilian price is on
// Liga Pokémon, which Ver na Liga opens; the app never fetches Liga and no
// longer takes Liga prices by hand. A copy that still holds one from before
// shows it on one small read-only line, which can be removed. Tiles and the
// statistics bar take that Liga price when a copy has one, else the US
// estimate, and never Cardmarket.

import {languageLabel} from './catalog.js';
import {updateCards} from './collection.js';
import {h} from './dom.js';
import {plural} from './format.js';
import {ligaUrl} from './liga.js';
import {finishLabel} from './monprice.js';
import {
	ASIAN_LANGUAGES,
	LIGA_SOURCE,
	cardmarketTrend,
	euroRates,
	eurToBrl,
	exchangeRates,
	extractPrices,
	fallbackPrice,
	finishFits,
	finishOf,
	formatBrl,
	formatBrlCompact,
	formatMoney,
	listStats,
	manualPrice,
	savedEuroRates,
	savedRates,
	shortDate,
	tileFinish,
	tileValue,
	usdToBrl,
} from './prices.js';

let sectionCount = 0;

// The printed languages that never get Ver na Liga (DESIGN.md section 10,
// "Languages on Liga").
const ASIAN_NO_LIGA = ['ko', 'zh-cn', 'zh-tw'];

// A date that never breaks at its spaces.
const day = (date) => h('span', {class: 'price-nowrap'}, date);

// The finish and language a Liga price says it is for: Liga averages each
// finish apart, and Portuguese and English share one page with different
// prices. A price saved before v31 has neither. price_manual.finish is the
// finish's name ("Holo", "Reverse holo") and price_manual.language a
// language code ("pt").
export function manualFor(entry) {
	const manual = entry && entry.price_manual;
	const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

	return manual && typeof manual === 'object'
		? {finish: text(manual.finish), language: text(manual.language)}
		: {finish: null, language: null};
}

// "Liga, 1 Oct 2026: lowest NM R$ 12,00 · average R$ 15,00 (Holo,
// Portuguese)": a Liga price kept on a copy, as one line, or null when the
// copy holds none. The card's price panel and its "Your copies" rows both
// say it this way.
export function copyPriceText(entry) {
	const manual = manualPrice(entry);

	if (!manual) {
		return null;
	}

	const {finish, language} = manualFor(entry);
	const source = manual.source === LIGA_SOURCE ? 'Liga' : manual.source;
	const date = shortDate(manual.date, {year: true});
	const amounts = [
		manual.low_nm !== null ? `lowest NM ${formatBrl(manual.low_nm)}` : null,
		manual.avg !== null ? `average ${formatBrl(manual.avg)}` : null,
	].filter(Boolean).join(' · ');
	const what = [finish, language ? languageLabel(language) : null].filter(Boolean);

	return `${date ? `${source}, ${date}` : source}: ${amounts}${what.length ? ` (${what.join(', ')})` : ''}`;
}

// "≈ R$ 6,74", read aloud as "About R$ 6,74".
const about = (brl) => [h('span', {'aria-hidden': 'true'}, '≈ '), h('span', {class: 'price-sr'}, 'About '), formatBrl(brl)];

// The trend's word and shape: an arrow, so it never rests on color.
const TRENDS = {
	falling: {shape: '↓', word: 'falling'},
	rising: {shape: '↑', word: 'rising'},
	steady: {shape: '→', word: 'steady'},
};

// The rate line under the prices, for the currencies shown: "US$ 1 = R$ 5,19
// · € 1 = R$ 5,88, rates of 1 Oct". Each rate carries its own date when the
// two differ, and a rate kept from an earlier day says so.
function rateText({eur, eurShown, usd, usdShown}) {
	const shown = [
		usdShown ? {name: 'dollar', rate: usd, text: (rate) => `US$ 1 = ${formatBrl(rate.brlPerUsd)}`} : null,
		eurShown ? {name: 'euro', rate: eur, text: (rate) => `€ 1 = ${formatBrl(rate.brlPerEur)}`} : null,
	].filter(Boolean);
	const known = shown.filter((item) => item.rate);
	const missing = shown.filter((item) => !item.rate);
	const parts = [];

	if (known.length) {
		const dates = new Set(known.map((item) => item.rate.date));
		const same = dates.size === 1;

		parts.push(known.map((item) => item.text(item.rate) + (same ? '' : ` (${shortDate(item.rate.date)})`)).join(' · '));

		if (same) {
			parts.push(`, ${known.length > 1 ? 'rates' : 'rate'} of ${shortDate(known[0].rate.date)}`);
		}

		if (known.some((item) => item.rate.fresh === false)) {
			parts.push(', last saved on this phone');
		}

		parts.push('.');
	}

	if (missing.length) {
		parts.push(known.length ? ' ' : '', known.length
			? `No ${missing[0].name} rate saved on this phone yet, so no reais for it.`
			: 'No exchange rate saved on this phone yet, so no reais.');
	}

	return parts.join('');
}

// The card detail's price block for one card.
//
//   card            the TCGdex card record (any language; its pricing is the
//                   same international product)
//   variantId       the finish to show first; else the first copy's finish
//   language        the copy's printed language, for the market note and
//                   the Ver na Liga link (null: any)
//   entries         the owner's live copies of this card ([] when none)
//   recordLanguage  the language of card; Ver na Liga is built from it only
//                   when it is 'en', since Liga searches by English name
//   ligaHref        a ready Ver na Liga URL, or null for none; overrides the
//                   one built from card
//   rates           a dollar rate to use instead of the saved one
//   eurRates        a euro rate to use instead of the saved one
//   save            (patches) => Promise, defaults to collection updateCards;
//                   used only to remove a Liga price kept on a copy
//   onSaved         (entries) => void after a Liga price is removed or
//                   brought back
//   toast           (message, {action, actionLabel, timeout}) => void, for
//                   Undo; defaults to js/shell.js toast
export function priceSection({card, entries = [], eurRates = undefined, language = null, ligaHref, onSaved = null, rates = undefined, recordLanguage = 'en', save = updateCards, toast = null, variantId = null} = {}) {
	const id = `price-${++sectionCount}`;
	const finishes = extractPrices(card);
	const section = h('section', {'aria-labelledby': `${id}-title`, class: 'price'});
	let copies = (entries || []).filter((entry) => entry && !entry.deleted_at);
	let rate = rates !== undefined ? rates : savedRates();
	let euroRate = eurRates !== undefined ? eurRates : savedEuroRates();

	// Japanese, Korean, and Chinese prints never borrow another finish's
	// price (DESIGN.md section 10, "The language gap").
	const asian = ASIAN_LANGUAGES.includes(language) || ASIAN_LANGUAGES.includes(recordLanguage);

	const ownedOf = (finish) => copies.filter((entry) => finishOf(entry, finishes) === finish);
	const unmatched = () => copies.filter((entry) => !finishOf(entry, finishes));

	// The finish to show first: the one asked for, else an owned one, else
	// the one whose price stands in for every other (a plain normal first).
	const preferred = () => {
		const other = fallbackPrice(card, 'tcgplayer', finishes) || fallbackPrice(card, 'cardmarket', finishes);

		return other ? finishes.find((finish) => finish.label === other.label) : null;
	};

	let selected = finishes.find((finish) => variantId && finish.variantId === variantId)
		|| finishes.find((finish) => ownedOf(finish).length)
		|| preferred()
		|| finishes[0]
		|| null;

	const set = (card && card.set) || {};

	// Korean and Chinese prints get no link, whatever the record: whether
	// Liga lists them is unchecked, so a Korean copy on a Japanese record
	// never gets the Japanese print's page (Q-30).
	const href = ASIAN_NO_LIGA.includes(language)
		? null
		: ligaHref !== undefined
			? ligaHref
			: recordLanguage === 'en' && card
				? ligaUrl({localId: card.localId, name: card.name, official: set.cardCount && set.cardCount.official, setId: set.id, setName: set.name})
				: null;

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

		// Japanese prints do get a link once an English name is found, so a
		// Japanese card without one is just this card.
		return h('p', {class: 'muted price-liga-none'}, ASIAN_NO_LIGA.includes(language) ? `No Liga link for ${languageLabel(language)} prints.` : 'No Liga link for this card.');
	}

	// What the owner's copy is, for "your copy is Holo": the finish shown
	// when a copy truly is of it, else the finish of the copies the card does
	// not list (monprice's word, such as a "Holo" on a card listed only as
	// Normal), else null when no copy is in question or its finish is not
	// known.
	function copyFinish() {
		const owned = selected ? ownedOf(selected) : [];

		if (owned.some((entry) => finishFits(entry, selected))) {
			return selected.label;
		}

		const loose = [...owned, ...unmatched()];

		if (!loose.length) {
			return null;
		}

		const names = [...new Set(loose.map((entry) => entry.finish_raw).filter(Boolean).map(finishLabel))];

		return names.length ? names.join(' or ') : null;
	}

	// The prices a market row shows, and the note that says whose they are
	// when they are not the shown finish's own: {prices, note} or null when
	// the card has no price in that market for any finish.
	function pick(market, has) {
		const own = selected ? selected[market] : null;
		const mine = copyFinish();

		if (own && has(own)) {
			// The copies' finish is not listed: say the price is another's.
			return {note: mine && mine !== selected.label ? `for ${selected.label}; your copy is ${mine}` : null, prices: own};
		}

		const other = asian ? null : fallbackPrice(card, market, finishes);

		if (!other) {
			return null;
		}

		const why = mine === other.label ? null : mine ? `your copy is ${mine}` : selected ? `none listed for ${selected.label}` : null;

		return {note: why ? `for ${other.label}; ${why}` : `for ${other.label}`, prices: other.prices};
	}

	// One market's row: its name and the reais, then the original amount,
	// its kind, and its date, small.
	function row({className, extra = [], name, note, original, value}) {
		return h('li', {class: `price-row ${className}`},
			h('p', {class: 'price-line'},
				h('span', {class: 'price-source'}, name),
				h('span', {class: 'price-value'}, value)
			),
			...[
				original ? h('p', {class: 'price-meta price-original'}, original) : null,
				note ? h('p', {class: 'price-meta price-for'}, note) : null,
				...extra,
			].filter(Boolean)
		);
	}

	const noPrice = (className, name) => row({className: `${className} price-row-none`, name, value: h('span', {class: 'price-none'}, 'No price')});

	function usRow() {
		const found = pick('tcgplayer', (tcg) => tcg.marketPrice !== null);

		if (!found) {
			return {node: noPrice('price-us', 'TCGplayer'), shown: false};
		}

		const tcg = found.prices;
		const brl = usdToBrl(tcg.marketPrice, rate);
		const usd = formatMoney(tcg.marketPrice, 'USD');
		const date = shortDate(tcg.date);

		return {
			node: row({
				className: 'price-us',
				extra: tcg.shared && tcg.shared.length && !found.note ? [h('p', {class: 'price-meta price-shared'}, `TCGplayer prices this together with ${tcg.shared.join(' and ')}.`)] : [],
				name: 'TCGplayer',
				note: found.note,
				original: [brl !== null ? `${usd}, ` : '', 'TCGplayer market', date ? ', ' : null, date ? day(date) : null],
				value: brl !== null ? h('span', {class: 'price-us-value'}, about(brl)) : h('span', {class: 'price-us-value-usd'}, usd),
			}),
			shown: true,
		};
	}

	// Cardmarket's trend price for the finish, converted, with the euros, the
	// date, and the 7 against 30 day trend beside it.
	function euRow() {
		const found = pick('cardmarket', (cm) => cm.trend !== null);

		if (!found) {
			return {node: noPrice('price-eu', 'Cardmarket'), shown: false};
		}

		const cm = found.prices;
		const brl = eurToBrl(cm.trend, euroRate);
		const eur = formatMoney(cm.trend, 'EUR');
		const date = shortDate(cm.date);
		const trend = cardmarketTrend(cm, {rates: euroRate});
		let trendMark = null;

		if (trend) {
			const {shape, word} = TRENDS[trend.direction];
			const avg30 = eurToBrl(trend.avg30, euroRate);
			const average = avg30 !== null ? `about ${formatBrl(avg30)}` : formatMoney(trend.avg30, 'EUR');

			trendMark = h('span', {class: `price-trend price-trend-${trend.direction}`, 'data-trend': trend.direction, title: `30-day average ${average}`},
				h('span', {'aria-hidden': 'true', class: 'price-trend-shape'}, shape),
				h('span', {class: 'price-sr'}, 'Trend '),
				word,
				h('span', {class: 'price-sr'}, `, 30-day average ${average}`)
			);
		}

		return {
			node: row({
				className: 'price-eu',
				extra: cm.shared && cm.shared.length && !found.note ? [h('p', {class: 'price-meta price-shared'}, `Cardmarket prices this together with ${cm.shared.join(' and ')}.`)] : [],
				name: 'Cardmarket',
				note: found.note,
				original: [brl !== null ? `${eur}, ` : '', 'Cardmarket trend', date ? ', ' : null, date ? day(date) : null],
				value: [brl !== null ? h('span', {class: 'price-eu-value'}, about(brl)) : h('span', {class: 'price-eu-value-eur'}, eur), trendMark ? ' ' : null, trendMark].filter(Boolean),
			}),
			shown: true,
		};
	}

	// The Liga prices kept on copies, one line for each different one, with
	// Remove. Copies holding the very same price share a line, and Remove
	// takes it off all of them.
	const ligaKey = (entry) => JSON.stringify([manualPrice(entry), manualFor(entry)]);

	function ligaLines() {
		const lines = new Map();

		for (const entry of copies) {
			const text = copyPriceText(entry);

			if (text && !lines.has(ligaKey(entry))) {
				lines.set(ligaKey(entry), text);
			}
		}

		if (!lines.size) {
			return null;
		}

		return h('ul', {'aria-label': 'Liga prices kept on your copies', class: 'price-liga'},
			[...lines].map(([key, text]) => h('li', {class: 'price-liga-line'},
				h('span', {class: 'price-liga-text'}, text),
				h('button', {'aria-label': `Remove ${text}`, class: 'link-button price-edit price-remove', type: 'button', onclick: () => removeLiga(key)}, 'Remove')
			))
		);
	}

	const notify = (message, options) => (toast
		? Promise.resolve(toast(message, options))
		: import('./shell.js').then((shell) => shell.toast(message, options))
	).catch(() => {
		// No toast area: the panel itself shows the change.
	});

	// Writes price_manual on some copies and redraws, keeping the focus in
	// the panel.
	async function store(changes) {
		const changed = await save(changes.map(({id: copyId, manual}) => ({id: copyId, patch: {price_manual: manual}})));
		const byId = new Map((changed || []).map((entry) => [entry.id, entry]));
		const wanted = new Map(changes.map((change) => [change.id, change.manual]));

		copies = copies.map((entry) => byId.get(entry.id) || (wanted.has(entry.id) ? {...entry, price_manual: wanted.get(entry.id)} : entry));
		draw();

		if (onSaved) {
			onSaved(copies);
		}
	}

	async function removeLiga(key) {
		const targets = copies.filter((entry) => ligaKey(entry) === key);
		const before = targets.map((entry) => ({id: entry.id, manual: entry.price_manual}));
		const hadFocus = section.contains(document.activeElement);

		try {
			await store(targets.map((entry) => ({id: entry.id, manual: null})));
		}
		catch (err) {
			notify(`Liga price not removed. ${(err && err.message) || err}`);

			return;
		}

		if (hadFocus) {
			const next = section.querySelector('.price-remove') || section.querySelector(`#${id}-title`);

			next.focus();
		}

		notify(targets.length > 1 ? `Liga price removed from ${plural(targets.length, 'copy', 'copies')}.` : 'Liga price removed.', {
			action: () => store(before).catch((err) => notify(`Liga price not brought back. ${(err && err.message) || err}`)),
			actionLabel: 'Undo',
			timeout: 8000,
		});
	}

	function draw() {
		const scroll = section.querySelector('.price-finishes');
		const kept = scroll ? scroll.scrollLeft : 0;
		const us = usRow();
		const eu = euRow();
		const rateLine = us.shown || eu.shown
			? rateText({eur: euroRate, eurShown: eu.shown, usd: rate, usdShown: us.shown})
			: '';
		const foreign = language && language !== 'en' && (us.shown || eu.shown);

		section.replaceChildren(...[
			h('h3', {id: `${id}-title`, tabindex: '-1'}, 'Price'),
			switcher(),
			h('ul', {'aria-label': 'Market prices', class: 'price-markets'}, us.node, eu.node),
			rateLine ? h('p', {class: 'price-meta price-rate'}, rateLine) : null,
			foreign ? h('p', {class: 'price-meta price-language'}, `Market prices for English cards, not for ${languageLabel(language)} prints.`) : null,
			ligaLines(),
			h('div', {class: 'price-actions'}, ligaLink()),
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

	// Redraws with a fresh rate, keeping the focus on the control it was on.
	function redraw() {
		const focused = section.contains(document.activeElement) ? document.activeElement : null;
		const chip = focused && focused.classList.contains('price-finish') ? [...section.querySelectorAll('.price-finish')].indexOf(focused) : -1;

		draw();

		if (chip >= 0) {
			section.querySelectorAll('.price-finish')[chip].focus();
		}
	}

	draw();

	if (eurRates === undefined) {
		euroRates().then((fresh) => {
			if (fresh && (!euroRate || fresh.brlPerEur !== euroRate.brlPerEur || fresh.date !== euroRate.date || fresh.fresh !== euroRate.fresh)) {
				euroRate = fresh;
				redraw();
			}
		}).catch(() => {
			// The saved rate, or none, stays on screen.
		});
	}

	if (rates === undefined) {
		exchangeRates().then((fresh) => {
			if (fresh && (!rate || fresh.brlPerUsd !== rate.brlPerUsd || fresh.date !== rate.date || fresh.fresh !== rate.fresh)) {
				rate = fresh;
				redraw();
			}
		}).catch(() => {
			// The saved rate, or none, stays on screen.
		});
	}

	return section;
}

// A tile's price for its copies (one card), for the caller to place: a Liga
// price kept on a copy first, else the US estimate marked "~" and "US". Null
// when neither is known. card is the TCGdex record, which carries the US
// price; a card index record has none, so only Liga prices show with one.
// An estimate borrowed from another finish (js/prices.js fallbackPrice) says
// whose in its label; the tile has no room for more.
export function tilePrice(entries, card, {basis = 'avg', rates = savedRates()} = {}) {
	const value = tileValue(entries, card, {basis, rates});

	if (!value) {
		return null;
	}

	const text = formatBrlCompact(value.brl);

	// Copies of several finishes share one tile, so the price says whose it is.
	const finish = tileFinish(entries, card, {basis, rates});
	const note = value.fallback ? `, price for ${value.fallback}` : finish ? `, ${finish}` : '';

	if (value.kind === 'liga') {
		return h('span', {'aria-label': finish ? `${text}, Liga Pokémon${note}` : null, class: 'price-tile', title: `Liga Pokémon${note}, ${value.date || 'no date'}`}, text);
	}

	return h('span', {'aria-label': `About ${text}, US market estimate${note}`, class: 'price-tile price-tile-estimate', title: `Estimated from the US market (TCGplayer)${note}`},
		h('span', {'aria-hidden': 'true'}, `~${text}`),
		h('span', {'aria-hidden': 'true', class: 'price-tile-us'}, 'US')
	);
}

// The statistics bar for any set of copies (a binder, a list, a set, the
// Trade spares, the whole collection): total, average, highest, lowest, and
// how many are priced by US estimate or not at all. Estimated values carry
// "~". Copies that still hold a Liga price count it, and only then do the
// Liga count and the switch between Liga's average and lowest NM show.
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
			stats.liga.count ? h('span', {class: 'price-count-liga'}, `${plural(stats.liga.count, 'copy', 'copies')} by Liga`) : null,
			h('span', {class: 'price-count-estimate'}, `${plural(stats.estimate.count, 'copy', 'copies')} by US estimate (~)`),
			h('span', {class: 'price-count-unknown'}, `${plural(stats.unknown.count, 'copy', 'copies')} unknown`)
		));

		const notes = [];

		if (stats.estimate.count) {
			notes.push(`${formatBrl(stats.estimate.total)} of the total is estimated from the US market at the rate of `, day(stats.rateDate), '.');
		}

		if (stats.estimate.fallback) {
			notes.push(' ', `${plural(stats.estimate.fallback, 'copy takes', 'copies take')} the price of another finish of the card, as TCGplayer lists none for ${stats.estimate.fallback === 1 ? 'its own' : 'theirs'}.`);
		}

		if (stats.unknown.count) {
			notes.push(notes.length ? ' ' : '', 'Unknown prices are left out of the total and the average, not counted as zero.');
		}

		if (stats.unknown.noRate) {
			notes.push(notes.length ? ' ' : '', `${plural(stats.unknown.noRate, 'copy has', 'copies have')} a US price but no exchange rate is saved on this phone yet.`);
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

		if (stats.liga.count) {
			parts.push(h('fieldset', {class: 'segmented price-basis'},
				h('legend', {class: 'price-sr'}, 'Liga price to use'),
				option('avg', 'Liga average'),
				option('low_nm', 'Liga lowest NM')
			));
		}

		bar.replaceChildren(...parts);
	}

	draw();

	return bar;
}
