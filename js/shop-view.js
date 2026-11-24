// The Shop screen: Eric's private staging page for selling his spares on
// HOTARU (plans/hotaru-catalog-plan.md, section 5). One row per card and
// language that has spares, with the sale price Eric typed, or Not priced,
// and suggestions that never leave this screen: TCGplayer's market price
// and Cardmarket's trend in reais, and a Use button that types the higher,
// rounded up to the next R$ 0,50. There is no Liga link here, by Eric's
// choice (2026-11-24): he may price above the market. Only a priced card is
// published: opening the screen and every price saved or cleared send the
// whole set of priced spares to the HOTARU catalog (js/store-publish.js,
// supabase/store.sql), with each card's name in its copies' language and its
// picture copied once into the shop's public bucket.
//
// Pricing many at once: search and filter the rows, then Price all shown,
// for "every 30th Anniversary common is R$ 1,00". The numbers are
// js/shop.js; styles are css/shop.css.
//
// Route (app.js ROUTES):
//   shop     your spares, priced for sale

import {currentUser} from './auth.js';
import {entryInfo} from './binders-view.js';
import {cardIndex, compareNumbers, indexKey, pricesDue, readPriceRecord, savedCardRecords, viewingLanguage} from './catalog.js';
import {listCards, updateCards} from './collection.js';
import {BASE, backWords, errorText, h} from './dom.js';
import {formatCount, plural} from './format.js';
import {languageLabel} from './languages.js';
import {parsePrice, priceForInput, PRICE_FORM_TEXT} from './moves.js';
import {euroRates, exchangeRates, extractPrices, finishOf, formatBrl, savedEuroRates, savedRates} from './prices.js';
import {PRICE_FILTERS, groupMark, listingRows, priceFilter, pricePatches, shopGroups, shopTotals, storePicturePath, suggestion, undoPricePatches} from './shop.js';
import {publishErrorText, syncListings, uploadPicture} from './store-publish.js';
import {onSyncStatus, syncStatus} from './sync.js';

const SHOW_KEY = 'cardTracker.shopShow';
const SHOW_LABELS = {all: 'All', priced: 'Priced', unpriced: 'Not priced'};
// Reading the prices of cards never read before stops after this many
// failures in a row (offline, or TCGdex failing), as My Cards' pass does.
const MAX_FAILURES = 3;

function readShow() {
	try {
		const value = localStorage.getItem(SHOW_KEY);

		return PRICE_FILTERS.includes(value) ? value : 'unpriced';
	}
	catch {
		return 'unpriced';
	}
}

function keepShow(value) {
	try {
		localStorage.setItem(SHOW_KEY, value);
	}
	catch {
		// Not kept; the next visit starts at Not priced.
	}
}

const fold = (text) => String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

const toast = (message, options) => import('./shell.js').then((shell) => shell.toast(message, options)).catch(() => {
	// No toast area: the row itself shows the change.
});

export function shopView(root) {
	let alive = true;
	let groups = [];
	let index = new Map();
	let saved = new Map();
	let rates = savedRates();
	let euroRate = savedEuroRates();
	let show = readShow();
	// True once the pass that reads missing records has ended.
	let filled = false;
	let query = '';
	let setFilter = '';
	let rarityFilter = '';
	// Rows as drawn, by group key, so a suggestion can be put in place.
	const rows = new Map();
	// store_sync's last answer, {<copy id>: {status, image_path}}, and the
	// publishing run in progress, with whether another must follow it.
	let states = {};
	let publishing = null;
	let publishAgain = false;
	// Waiting for the sync to settle before publishing, and its listener.
	let stopWaiting = null;
	const publishLine = h('p', {'aria-live': 'polite', class: 'muted shop-publish', id: 'shop-publish'});

	const summary = h('p', {class: 'muted shop-summary', id: 'shop-summary'}, 'Reading your spares…');
	const search = h('input', {'aria-label': 'Search your spares', class: 'search shop-search', id: 'shop-search', placeholder: 'Search your spares', type: 'search'});
	const setSelect = h('select', {'aria-label': 'Set', class: 'shop-select', id: 'shop-set'});
	const raritySelect = h('select', {'aria-label': 'Rarity', class: 'shop-select', id: 'shop-rarity'});
	const filter = h('div', {'aria-label': 'Show', class: 'segmented', id: 'shop-filter', role: 'radiogroup'},
		PRICE_FILTERS.map((value) => h('label', null,
			h('input', {checked: value === show, name: 'shop-filter', onchange: () => {
				show = value;
				keepShow(value);
				drawList();
			}, type: 'radio', value}),
			h('span', {'data-label': SHOW_LABELS[value]}, SHOW_LABELS[value])
		))
	);
	const bulkInput = h('input', {'aria-label': 'Price for every card shown', autocomplete: 'off', class: 'search shop-price-input', id: 'shop-bulk-price', inputmode: 'decimal', placeholder: '1,00', type: 'text'});
	const bulkButton = h('button', {class: 'small', id: 'shop-bulk-set', type: 'submit'}, 'Price all shown');
	const bulkError = h('p', {class: 'form-error', hidden: true, id: 'shop-bulk-error', role: 'alert'});
	const bulk = h('form', {class: 'shop-bulk', id: 'shop-bulk', onsubmit: (event) => {
		event.preventDefault();
		priceShown();
	}}, h('label', {class: 'shop-bulk-label', for: 'shop-bulk-price'}, 'R$'), bulkInput, bulkButton);
	const list = h('ul', {'aria-label': 'Your spares', class: 'shop-list', id: 'shop-list'});
	const empty = h('p', {class: 'muted', hidden: true, id: 'shop-empty'});

	search.addEventListener('input', () => {
		query = search.value;
		drawList();
	});
	setSelect.addEventListener('change', () => {
		setFilter = setSelect.value;
		drawList();
	});
	raritySelect.addEventListener('change', () => {
		rarityFilter = raritySelect.value;
		drawList();
	});

	root.append(
		h('a', {class: 'back', 'data-link': 'trade', href: `${BASE}trade`, id: 'shop-back'}, backWords('Spares')),
		h('div', {class: 'view-head'}, h('h2', null, 'Shop')),
		h('p', {class: 'muted shop-intro'}, 'Price your spares for HOTARU. Only cards with a price will be offered, and the suggestions stay on this screen.'),
		summary,
		publishLine,
		h('div', {class: 'shop-controls'}, search, filter, h('div', {class: 'shop-selects'}, setSelect, raritySelect)),
		bulk,
		bulkError,
		list,
		empty
	);

	// Each group's name, set, and rarity, worked out once per load.
	function describe(group) {
		const info = entryInfo(group.spares[0], index, viewingLanguage());
		const record = index.get(indexKey(group.catalog, group.card_id)) || null;

		// What the catalog shows: the name and set in the copies' own
		// language, the one the buyer gets, and the picture.
		const sold = entryInfo(group.spares[0], index, group.language);

		group.info = info;
		group.publishInfo = sold;
		group.pictureBase = sold.image ? sold.image.replace(/\/low\.webp$/, '') : null;
		group.rarity = (record && record.rarity) || null;
		// info.search holds the English names too, as My Cards' search does,
		// so "Pikachu" finds a Japanese print.
		group.search = fold([info.search, info.name, info.setName, info.number, group.card_id, languageLabel(group.language)].join(' '));
	}

	const recordOf = (group) => saved.get(`${group.catalog}|${group.card_id}`) || null;

	function shown() {
		const words = fold(query).split(/\s+/).filter(Boolean);

		return priceFilter(groups, show).filter((group) => (!setFilter || group.set_id === setFilter)
			&& (!rarityFilter || group.rarity === rarityFilter)
			&& words.every((word) => group.search.includes(word)));
	}

	function fillSelect(select, label, values, current) {
		select.replaceChildren(
			h('option', {value: ''}, label),
			...values.map(([value, text]) => h('option', {selected: value === current, value}, text))
		);
	}

	function drawSelects() {
		const sets = new Map();

		for (const group of groups) {
			if (group.set_id && !sets.has(group.set_id)) {
				sets.set(group.set_id, group.info.setName || group.set_id);
			}
		}

		const rarities = [...new Set(groups.map((group) => group.rarity).filter(Boolean))].sort();

		if (setFilter && !sets.has(setFilter)) {
			setFilter = '';
		}

		if (rarityFilter && !rarities.includes(rarityFilter)) {
			rarityFilter = '';
		}

		fillSelect(setSelect, 'Every set', [...sets].sort((a, b) => a[1].localeCompare(b[1])), setFilter);
		fillSelect(raritySelect, 'Every rarity', rarities.map((rarity) => [rarity, rarity]), rarityFilter);
	}

	function drawSummary() {
		const totals = shopTotals(groups);

		summary.textContent = totals.groups
			? `${formatCount(totals.priced)} of ${plural(totals.groups, 'card', 'cards')} priced, ${plural(totals.spares, 'spare', 'spares')} in all.${totals.priced ? ` The priced spares come to ${formatBrl(totals.value)}.` : ''}`
			: '';
	}

	function suggestionNode(group) {
		const found = suggestion(group, recordOf(group), {euroRates: euroRate, rates});
		const parts = [
			found.tcgplayer !== null ? `TCGplayer ≈ ${formatBrl(found.tcgplayer)}` : null,
			found.cardmarket !== null ? `Cardmarket ≈ ${formatBrl(found.cardmarket)}` : null,
		].filter(Boolean);

		return h('p', {class: 'shop-suggestion'},
			parts.length ? `Suggested: ${parts.join(' · ')}` : (recordOf(group) || filled ? 'No suggestion for this card.' : 'Looking for a suggestion…')
		);
	}

	const MARKS = {
		pending: 'Not on HOTARU yet',
		published: 'On HOTARU',
		reserved: 'Reserved by an order',
	};

	function markNode(group) {
		const mark = groupMark(group, states);

		return mark ? h('p', {class: `shop-mark shop-mark-${mark}`}, MARKS[mark]) : null;
	}

	function row(group) {
		const {info} = group;
		const id = `shop-${group.key.replace(/[^a-z0-9]+/gi, '-')}`;
		const input = h('input', {'aria-describedby': `${id}-error`, 'aria-label': `Sale price for ${info.name}`, autocomplete: 'off', class: 'search shop-price-input', id: `${id}-price`, inputmode: 'decimal', placeholder: 'Not priced', type: 'text', value: priceForInput(group.price)});
		const error = h('p', {class: 'form-error', hidden: true, id: `${id}-error`, role: 'alert'});
		const found = suggestion(group, recordOf(group), {euroRates: euroRate, rates});
		const use = found.use !== null
			? h('button', {class: 'small shop-use', onclick: () => {
				input.value = priceForInput(found.use);
				input.focus();
			}, type: 'button'}, `Use ${formatBrl(found.use)}`)
			: null;
		const clear = group.price !== null
			? h('button', {class: 'small shop-clear', onclick: () => savePrice([group], null, {label: info.name}), type: 'button'}, 'Clear')
			: null;
		const form = h('form', {class: 'shop-price', onsubmit: (event) => {
			event.preventDefault();

			const typed = parsePrice(input.value);

			if (typed.error) {
				error.textContent = typed.error;
				error.hidden = false;
				input.focus();

				return;
			}

			error.hidden = true;
			savePrice([group], typed.value, {label: info.name});
		}},
		h('span', {'aria-hidden': 'true', class: 'shop-currency'}, 'R$'),
		input,
		h('button', {class: 'small primary shop-save', type: 'submit'}, 'Save'),
		use,
		clear);

		const meta = [info.number ? `#${info.number}` : null, info.setName, languageLabel(group.language), group.rarity, plural(group.spares.length, 'spare', 'spares')].filter(Boolean).join(' · ');
		const element = h('li', {class: `card shop-row${group.price === null ? ' shop-unpriced' : ''}`, 'data-key': group.key, id},
			info.image
				? h('img', {alt: '', class: 'shop-art', decoding: 'async', loading: 'lazy', onerror: (event) => event.target.replaceWith(h('div', {'aria-hidden': 'true', class: 'shop-art shop-art-none'})), src: info.image})
				: h('div', {'aria-hidden': 'true', class: 'shop-art shop-art-none'}),
			h('div', {class: 'shop-body'},
				h('a', {class: 'shop-name', 'data-link': info.route, href: BASE + info.route}, info.name),
				h('p', {class: 'muted shop-meta'}, meta),
				h('p', {class: 'shop-state'}, group.price !== null ? `For sale at ${formatBrl(group.price)} each` : 'Not priced: not offered'),
				markNode(group),
				suggestionNode(group),
				form,
				error
			)
		);

		rows.set(group.key, element);

		return element;
	}

	function drawList() {
		const visible = shown();

		rows.clear();
		list.replaceChildren(...visible.map(row));
		empty.hidden = visible.length > 0;
		empty.textContent = !groups.length
			? 'No spares yet. A spare is a copy beyond the first of the same card in the same language.'
			: show === 'unpriced' && !query && !setFilter && !rarityFilter
				? 'Every spare is priced.'
				: 'No spares match.';
		bulkButton.textContent = visible.length ? `Price all ${formatCount(visible.length)} shown` : 'Price all shown';
		bulkButton.disabled = !visible.length;
	}

	// A suggestion arrived for some groups: their rows' suggestion lines and
	// Use buttons are drawn again in place, keeping what was typed.
	function patchSuggestions(keys) {
		for (const key of keys) {
			const element = rows.get(key);
			const group = groups.find((one) => one.key === key);

			if (!element || !element.isConnected || !group) {
				continue;
			}

			const typed = element.querySelector('.shop-price-input').value;
			const hadFocus = element.contains(document.activeElement);
			const fresh = row(group);

			fresh.querySelector('.shop-price-input').value = typed;
			element.replaceWith(fresh);

			if (hadFocus) {
				fresh.querySelector('.shop-price-input').focus();
			}
		}
	}

	async function savePrice(targets, price, {label}) {
		const patches = pricePatches(targets, price);

		if (!patches.length) {
			toast(price === null ? `${label} has no price.` : `${label} is already ${formatBrl(price)}.`);

			return;
		}

		const undo = undoPricePatches(targets, patches);

		try {
			await updateCards(patches);
		}
		catch (err) {
			toast(`Price not saved. ${errorText(err)}`);

			return;
		}

		await reload();
		publish();

		const words = price === null ? `${label}: price cleared.` : `${label}: ${formatBrl(price)}.`;

		toast(words, {
			action: () => updateCards(undo).then(reload).then(publish).catch((err) => toast(`Price not put back. ${errorText(err)}`)),
			actionLabel: 'Undo',
			timeout: 8000,
		});
	}

	function priceShown() {
		const typed = parsePrice(bulkInput.value);
		const visible = shown();

		if (typed.error || typed.value === null) {
			bulkError.textContent = typed.error || PRICE_FORM_TEXT;
			bulkError.hidden = false;
			bulkInput.focus();

			return;
		}

		bulkError.hidden = true;
		savePrice(visible, typed.value, {label: plural(visible.length, 'card', 'cards')});
	}

	// A copy's finish as the catalog names it: the card's listed finish, else
	// the word the import kept.
	function finishName(entry, group) {
		const record = recordOf(group);
		const finish = record ? finishOf(entry, extractPrices(record)) : null;

		return (finish && finish.label) || entry.finish_raw || null;
	}

	const priced = () => groups.filter((group) => group.price !== null);

	function rowsFor(list) {
		return listingRows(list.map((group) => ({...group, info: group.publishInfo})), {finishOf: finishName});
	}

	function drawMarks() {
		for (const element of rows.values()) {
			const group = groups.find((one) => one.key === element.dataset.key);
			const old = element.querySelector('.shop-mark');
			const fresh = group ? markNode(group) : null;

			if (old && fresh) {
				old.replaceWith(fresh);
			}
			else if (old) {
				old.remove();
			}
			else if (fresh) {
				element.querySelector('.shop-state').after(fresh);
			}
		}
	}

	// Sends every priced spare to the catalog and withdraws the rest, then
	// copies the pictures the catalog does not have yet and sends the paths.
	// One run at a time; a price saved during a run starts one more after it.
	function publish() {
		if (publishing) {
			publishAgain = true;

			return publishing;
		}

		publishing = (async () => {
			do {
				publishAgain = false;
				await publishOnce();
			} while (publishAgain && alive);
		})().finally(() => {
			publishing = null;
		});

		return publishing;
	}

	async function publishOnce() {
		if (!currentUser()) {
			publishLine.textContent = 'Sign in to publish your priced spares to HOTARU.';

			return;
		}

		if (!navigator.onLine) {
			publishLine.textContent = 'Offline: your prices are saved, and they reach HOTARU when you open the Shop online.';

			return;
		}

		// Publishing sends the whole set and withdraws everything else, so it
		// waits until this phone holds every card the server does and has
		// sent its own changes: a phone just signed in, still reading the
		// collection, would otherwise take every card off HOTARU.
		const sync = syncStatus();

		if (sync.phase !== 'synced' || sync.pending) {
			publishLine.textContent = 'Waiting for your cards to sync before publishing to HOTARU…';

			if (!stopWaiting) {
				stopWaiting = onSyncStatus((next) => {
					if (next.phase === 'synced' && !next.pending && stopWaiting) {
						const stop = stopWaiting;

						stopWaiting = null;
						queueMicrotask(() => {
							stop();

							if (alive) {
								reload().then(publish);
							}
						});
					}
				});
			}

			return;
		}

		publishLine.textContent = 'Publishing to HOTARU…';

		try {
			states = await syncListings(rowsFor(priced()));

			if (!alive) {
				return;
			}

			drawMarks();

			// The pictures still missing, one per card.
			const missing = priced().filter((group) => group.pictureBase
				&& group.spares.every((entry) => !(states[entry.id] && states[entry.id].image_path)));
			const uploaded = [];

			for (const group of missing) {
				const path = storePicturePath(group.pictureBase);

				if (alive && path && await uploadPicture(group.pictureBase, path).catch(() => false)) {
					uploaded.push({...group, picturePath: path});
				}
			}

			if (uploaded.length && alive) {
				const withPictures = new Map(uploaded.map((group) => [group.key, group]));

				states = await syncListings(rowsFor(priced().map((group) => withPictures.get(group.key) || group)));
			}

			if (!alive) {
				return;
			}

			drawMarks();

			const live = priced().filter((group) => groupMark(group, states) === 'published').length;
			const spares = priced().filter((group) => groupMark(group, states) === 'published').reduce((n, group) => n + group.spares.length, 0);
			const noPicture = priced().filter((group) => !group.spares.some((entry) => states[entry.id] && states[entry.id].image_path)).length;

			publishLine.textContent = live
				? `On HOTARU: ${plural(live, 'card', 'cards')}, ${plural(spares, 'spare', 'spares')}.${noPicture ? ` ${plural(noPicture, 'card has', 'cards have')} no picture yet.` : ''}`
				: 'Nothing on HOTARU yet: give a card a price to offer it.';
		}
		catch (err) {
			if (alive) {
				publishLine.textContent = publishErrorText(err);
			}
		}
	}

	async function reload() {
		const cards = await listCards();

		if (!alive) {
			return;
		}

		groups = shopGroups(cards);
		groups.forEach(describe);
		groups.sort((a, b) => (a.info.setName || '').localeCompare(b.info.setName || '')
			|| compareNumbers(a.info.number || '', b.info.number || '')
			|| a.language.localeCompare(b.language));
		drawSummary();
		drawSelects();
		drawList();
	}

	// The full records of cards never read before, for their suggestions:
	// read one at a time, the shown rows first, stopping after a few
	// failures in a row.
	async function fillRecords() {
		const order = shown().concat(groups).flatMap((group) => group.spares);
		const due = (await pricesDue(order)).filter((item) => !item.at);
		let failures = 0;

		for (const item of due) {
			if (!alive || failures >= MAX_FAILURES) {
				return;
			}

			try {
				const record = await readPriceRecord(item);

				failures = 0;

				if (record && alive) {
					saved.set(`international|${item.cardId}`, record);
					patchSuggestions(groups.filter((group) => group.catalog === 'international' && group.card_id === item.cardId).map((group) => group.key));
				}
			}
			catch {
				failures++;
			}
		}
	}

	(async () => {
		index = await cardIndex().catch(() => new Map());
		await reload();

		saved = await savedCardRecords(groups.flatMap((group) => group.spares)).catch(() => new Map());

		if (!alive) {
			return;
		}

		drawList();

		const [usd, eur] = await Promise.all([exchangeRates().catch(() => null), euroRates().catch(() => null)]);

		if (alive && (usd || eur)) {
			rates = usd || rates;
			euroRate = eur || euroRate;
			drawList();
		}

		if (alive) {
			publish();
			await fillRecords();
		}

		// Cards whose records never arrived say so rather than "Looking".
		if (alive) {
			filled = true;
			patchSuggestions(groups.filter((group) => !recordOf(group)).map((group) => group.key));
		}
	})().catch((err) => {
		if (alive) {
			list.replaceChildren(h('li', {class: 'notice', role: 'alert'}, h('p', null, `The Shop could not be read. ${errorText(err)}`)));
		}
	});

	return () => {
		alive = false;

		if (stopWaiting) {
			stopWaiting();
			stopWaiting = null;
		}
	};
}

export const shopRoutes = [
	{pattern: /^shop$/, render: shopView, tab: 'cards', title: 'Shop | Card Tracker'},
];

export const shopAccountViews = [shopView];
