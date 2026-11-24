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
// Typing a price saves nothing by itself (Eric, 2026-11-24: "enter the
// prices and press save at the end"). Each typed price is a draft, kept on
// this tab (sessionStorage) so a search, a filter, or a trip to a card page
// and Back keeps it; Enter moves to the next card's field. The bar above the
// tabs saves every draft in one write, with one Undo, or discards them. A
// draft that cannot be read stops the whole save and says where. Fill all
// shown types one price into every card the search and filters show, for
// "every 30th Anniversary common is R$ 1,00", as drafts too. The numbers
// are js/shop.js; styles are css/shop.css.
//
// Route (app.js ROUTES):
//   shop     your spares, priced for sale

import {currentUser} from './auth.js';
import {entryInfo} from './binders-view.js';
import {cardIndex, compareNumbers, indexKey, pricesDue, readPriceRecord, savedCardRecords, viewingLanguage} from './catalog.js';
import {listCards, loadDocument, updateCards} from './collection.js';
import {BASE, backWords, errorText, h} from './dom.js';
import {formatCount, plural} from './format.js';
import {languageLabel} from './languages.js';
import {applyMove, parsePrice, priceForInput, PRICE_FORM_TEXT} from './moves.js';
import {euroRates, exchangeRates, extractPrices, finishOf, formatBrl, savedEuroRates, savedRates} from './prices.js';
import {PRICE_FILTERS, groupMark, hasCards, listingRows, orderCheck, priceFilter, pricePatches, saleFields, shopGroups, shopTotals, storePicturePath, suggestion, timeLeft, undoPricePatches} from './shop.js';
import {cancelOrder, markDelivered, markPaid, openOrders, orderErrorText, receiptLink} from './store-orders.js';
import {publishErrorText, syncListings, uploadPicture} from './store-publish.js';
import {onSyncStatus, syncStatus} from './sync.js';

const SHOW_KEY = 'cardTracker.shopShow';
// The prices typed and not saved yet, {<group key>: <text as typed>}.
const DRAFTS_KEY = 'cardTracker.shopDrafts';
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

function readDrafts() {
	try {
		const value = JSON.parse(sessionStorage.getItem(DRAFTS_KEY) || '{}');

		return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
	}
	catch {
		return {};
	}
}

function keepDrafts(drafts) {
	try {
		if (drafts.size) {
			sessionStorage.setItem(DRAFTS_KEY, JSON.stringify(Object.fromEntries(drafts)));
		}
		else {
			sessionStorage.removeItem(DRAFTS_KEY);
		}
	}
	catch {
		// Not kept past this screen; the bar still saves them.
	}
}

const fold = (text) => String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Every Shop toast shares one key, so only the latest shows.
const toast = (message, options) => import('./shell.js').then((shell) => shell.toast(message, {...options, key: 'shop'})).catch(() => {
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
	// The prices typed and not saved yet, by group key, as typed.
	const drafts = new Map(Object.entries(readDrafts()).filter(([, text]) => typeof text === 'string'));
	let saving = false;
	const publishLine = h('p', {'aria-live': 'polite', class: 'muted shop-publish', id: 'shop-publish'});
	// HOTARU's orders (step 5): those waiting for payment and the paid ones
	// still to hand over, with the document they are checked against, the
	// question an order is asking (paid or cancel), and the orders whose
	// call is running.
	let orders = [];
	let orderDoc = null;
	const asking = new Map();
	const working = new Set();
	const ordersBox = h('section', {'aria-labelledby': 'shop-orders-title', class: 'shop-orders', hidden: true, id: 'shop-orders'});

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
	const bulkButton = h('button', {class: 'small', id: 'shop-bulk-set', type: 'submit'}, 'Fill all shown');
	const bulkError = h('p', {class: 'form-error', hidden: true, id: 'shop-bulk-error', role: 'alert'});
	const bulk = h('form', {class: 'shop-bulk', id: 'shop-bulk', onsubmit: (event) => {
		event.preventDefault();
		fillShown();
	}}, h('label', {class: 'shop-bulk-label', for: 'shop-bulk-price'}, 'R$'), bulkInput, bulkButton);
	const list = h('ul', {'aria-label': 'Your spares', class: 'shop-list', id: 'shop-list'});
	const empty = h('p', {class: 'muted', hidden: true, id: 'shop-empty'});
	const saveStatus = h('p', {'aria-live': 'polite', class: 'status shop-save-status', id: 'shop-save-status'});
	const discardButton = h('button', {id: 'shop-discard', onclick: () => discard(), type: 'button'}, 'Discard');
	const saveButton = h('button', {class: 'primary', id: 'shop-save-all', onclick: () => saveAll(), type: 'button'}, 'Save');
	const saveBar = h('div', {class: 'actions shop-savebar', hidden: true, id: 'shop-savebar'}, saveStatus, discardButton, saveButton);
	// Closing the tab with prices typed and not saved asks first.
	const warnUnsaved = (event) => {
		if (drafts.size) {
			event.preventDefault();
			event.returnValue = '';
		}
	};

	window.addEventListener('beforeunload', warnUnsaved);

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
		ordersBox,
		h('div', {class: 'shop-controls'}, search, filter, h('div', {class: 'shop-selects'}, setSelect, raritySelect)),
		bulk,
		bulkError,
		list,
		empty,
		saveBar
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

	const rowId = (group) => `shop-${group.key.replace(/[^a-z0-9]+/gi, '-')}`;

	// The text a row's field shows: its draft, else its saved price.
	const fieldText = (group) => (drafts.has(group.key) ? drafts.get(group.key) : priceForInput(group.price));

	// Keeps what was typed as a draft, or drops the draft when it says what
	// is saved already.
	function setDraft(group, text) {
		const typed = parsePrice(text);
		const same = !typed.error && typed.value === group.price;

		if (same) {
			drafts.delete(group.key);
		}
		else {
			drafts.set(group.key, text);
		}

		keepDrafts(drafts);

		const element = rows.get(group.key);

		if (element) {
			element.classList.toggle('shop-dirty', !same);
			element.querySelector('.shop-draft').hidden = same;
			element.querySelector('.form-error').hidden = true;
		}

		drawSaveBar();
	}

	// Enter goes to the next card's field, then to Save.
	function nextField(input) {
		const fields = [...list.querySelectorAll('.shop-price-input')];
		const next = fields[fields.indexOf(input) + 1];

		(next || (saveBar.hidden ? input : saveButton)).focus();
	}

	function row(group) {
		const {info} = group;
		const id = rowId(group);
		const dirty = drafts.has(group.key);
		const input = h('input', {'aria-describedby': `${id}-error`, 'aria-label': `Sale price for ${info.name}`, autocomplete: 'off', class: 'search shop-price-input', enterkeyhint: 'next', id: `${id}-price`, inputmode: 'decimal', placeholder: 'Not priced', type: 'text', value: fieldText(group)});
		const error = h('p', {class: 'form-error', hidden: true, id: `${id}-error`, role: 'alert'});
		const found = suggestion(group, recordOf(group), {euroRates: euroRate, rates});
		const fill = (text) => {
			input.value = text;
			setDraft(group, text);
			input.focus();
		};
		const use = found.use !== null
			? h('button', {class: 'small shop-use', onclick: () => fill(priceForInput(found.use)), type: 'button'}, `Use ${formatBrl(found.use)}`)
			: null;
		const clear = h('button', {class: 'small shop-clear', onclick: () => fill(''), type: 'button'}, 'Clear');

		input.addEventListener('input', () => setDraft(group, input.value));
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				nextField(input);
			}
		});

		const form = h('div', {class: 'shop-price'},
			h('span', {'aria-hidden': 'true', class: 'shop-currency'}, 'R$'),
			input,
			use,
			clear);

		const meta = [info.number ? `#${info.number}` : null, info.setName, languageLabel(group.language), group.rarity, plural(group.spares.length, 'spare', 'spares')].filter(Boolean).join(' · ');
		const element = h('li', {class: `card shop-row${group.price === null ? ' shop-unpriced' : ''}${dirty ? ' shop-dirty' : ''}`, 'data-key': group.key, id},
			info.image
				? h('img', {alt: '', class: 'shop-art', decoding: 'async', loading: 'lazy', onerror: (event) => event.target.replaceWith(h('div', {'aria-hidden': 'true', class: 'shop-art shop-art-none'})), src: info.image})
				: h('div', {'aria-hidden': 'true', class: 'shop-art shop-art-none'}),
			h('div', {class: 'shop-body'},
				h('a', {class: 'shop-name', 'data-link': info.route, href: BASE + info.route}, info.name),
				h('p', {class: 'muted shop-meta'}, meta),
				h('p', {class: 'shop-state'}, group.price !== null ? `For sale at ${formatBrl(group.price)} each` : 'Not priced: not offered'),
				h('p', {class: 'shop-draft', hidden: !dirty}, 'Changed, not saved yet'),
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
		bulkButton.textContent = visible.length ? `Fill all ${formatCount(visible.length)} shown` : 'Fill all shown';
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

			const hadFocus = element.contains(document.activeElement);
			const fresh = row(group);

			element.replaceWith(fresh);

			if (hadFocus) {
				fresh.querySelector('.shop-price-input').focus();
			}
		}
	}

	function drawSaveBar() {
		const n = drafts.size;

		saveBar.hidden = !n;
		saveButton.textContent = n === 1 ? 'Save 1 price' : `Save ${formatCount(n)} prices`;
		saveButton.disabled = saving;
		discardButton.disabled = saving;

		if (!saving) {
			saveStatus.textContent = '';
		}
	}

	// Saves every draft in one write, or none: a draft that cannot be read
	// stops the save, says so in its row, and takes the focus there.
	async function saveAll() {
		if (saving || !drafts.size) {
			return;
		}

		const byKey = new Map(groups.map((group) => [group.key, group]));
		const changes = [];
		const bad = [];

		for (const [key, text] of drafts) {
			const group = byKey.get(key);

			if (!group) {
				// No longer a spare: nothing to price.
				drafts.delete(key);
				continue;
			}

			const typed = parsePrice(text);

			if (typed.error) {
				bad.push(group);
			}
			else {
				changes.push({group, price: typed.value});
			}
		}

		if (bad.length) {
			for (const group of bad) {
				const element = rows.get(group.key);

				if (element) {
					const error = element.querySelector('.form-error');

					error.textContent = PRICE_FORM_TEXT;
					error.hidden = false;
				}
			}

			const first = bad.map((group) => rows.get(group.key)).find(Boolean);

			saveStatus.textContent = `${bad.length === 1 ? '1 price needs' : `${formatCount(bad.length)} prices need`} fixing first${first ? '' : ': clear the search and filters to see them'}. Nothing was saved.`;

			if (first) {
				first.querySelector('.shop-price-input').focus();
			}

			return;
		}

		const patches = changes.flatMap(({group, price}) => pricePatches([group], price));
		const undo = undoPricePatches(changes.map(({group}) => group), patches);
		const n = changes.length;

		saving = true;
		drawSaveBar();
		saveStatus.textContent = 'Saving…';

		try {
			if (patches.length) {
				await updateCards(patches);
			}
		}
		catch (err) {
			saving = false;
			drawSaveBar();
			saveStatus.textContent = `Not saved. ${errorText(err)}`;

			return;
		}

		drafts.clear();
		keepDrafts(drafts);
		saving = false;
		await reload();
		publish();

		toast(n === 1 ? '1 price saved.' : `${formatCount(n)} prices saved.`, {
			action: () => updateCards(undo).then(reload).then(publish).catch((err) => toast(`Prices not put back. ${errorText(err)}`)),
			actionLabel: 'Undo',
			timeout: 8000,
		});
	}

	function discard() {
		drafts.clear();
		keepDrafts(drafts);
		drawList();
		drawSaveBar();
	}

	// Types one price into every card shown, as drafts.
	function fillShown() {
		const typed = parsePrice(bulkInput.value);
		const visible = shown();

		if (typed.error || typed.value === null) {
			bulkError.textContent = typed.error || PRICE_FORM_TEXT;
			bulkError.hidden = false;
			bulkInput.focus();

			return;
		}

		bulkError.hidden = true;

		for (const group of visible) {
			if (group.price === typed.value) {
				drafts.delete(group.key);
			}
			else {
				drafts.set(group.key, priceForInput(typed.value));
			}
		}

		keepDrafts(drafts);
		drawList();
		drawSaveBar();
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

	// ------------------------------------------------------------ orders

	async function loadOrders() {
		if (!currentUser() || !navigator.onLine) {
			ordersBox.hidden = true;

			return;
		}

		try {
			const [found, doc] = await Promise.all([openOrders(), loadDocument()]);

			if (!alive) {
				return;
			}

			orders = found;
			orderDoc = doc;
			drawOrders();
		}
		catch (err) {
			if (!alive) {
				return;
			}

			// A family member who is not the shop's owner sees no orders.
			if (err && err.code === '42501') {
				ordersBox.hidden = true;

				return;
			}

			ordersBox.hidden = false;
			ordersBox.replaceChildren(h('h3', {id: 'shop-orders-title'}, 'Orders'), h('p', {class: 'muted', role: 'status'}, orderErrorText(err)));
		}
	}

	// A card names its number and condition; a sealed product (step 4) its kind.
	const itemLine = (item) => (item.kind === 'sealed'
		? [item.name, item.set_name, item.language ? languageLabel(item.language) : null, 'Sealed'].filter(Boolean).join(' · ')
		: [item.name, item.number ? `#${item.number}` : null, item.set_name, item.language ? languageLabel(item.language) : null, item.condition].filter(Boolean).join(' · '));

	function orderCard(order) {
		const {logged, missing} = orderCheck(order, orderDoc);
		const pending = order.status === 'pending';
		const busy = working.has(order.code);
		const question = asking.get(order.code);
		const ask = (value) => {
			if (value) {
				asking.set(order.code, value);
			}
			else {
				asking.delete(order.code);
			}

			drawOrders();
		};
		let actions;

		if (question === 'paid') {
			actions = [
				h('p', {class: 'shop-order-ask'}, `${formatBrl(order.total)} from ${order.name} is in your account?`),
				h('button', {class: 'primary', disabled: busy, onclick: () => paid(order), type: 'button'}, 'Yes, received'),
				h('button', {disabled: busy, onclick: () => ask(null), type: 'button'}, 'Back'),
			];
		}
		else if (question === 'cancel') {
			actions = [
				h('p', {class: 'shop-order-ask'}, `Cancel ${order.code}? Its cards go back on HOTARU.`),
				h('button', {disabled: busy, onclick: () => cancel(order), type: 'button'}, 'Cancel order'),
				h('button', {disabled: busy, onclick: () => ask(null), type: 'button'}, 'Back'),
			];
		}
		else if (pending) {
			actions = [
				h('button', {class: 'primary', disabled: busy || missing.length > 0, onclick: () => ask('paid'), type: 'button'}, 'Payment received'),
				h('button', {disabled: busy, onclick: () => ask('cancel'), type: 'button'}, 'Cancel order'),
			];
		}
		else {
			actions = [
				logged ? null : h('button', {class: 'primary', disabled: busy, onclick: () => logSale(order), type: 'button'}, 'Log the sale'),
				h('button', {class: logged ? 'primary' : '', disabled: busy, onclick: () => delivered(order), type: 'button'}, 'Delivered'),
			];
		}

		return h('article', {class: `card shop-order shop-order-${order.status}`, 'data-code': order.code, id: `order-${order.code}`},
			h('h4', {class: 'shop-order-head'}, `${order.code} · ${order.name}`),
			h('p', {class: 'shop-order-who'},
				h('a', {href: `tel:${String(order.phone).replace(/[^\d+]/g, '')}`}, order.phone),
				order.note ? ` · ${order.note}` : null),
			h('p', {class: 'shop-order-state'}, pending ? `Waiting for payment · ${timeLeft(order.reserved_until)}` : 'Paid · to hand over'),
			order.receipt_path
				? h('p', {class: 'shop-order-receipt'}, 'Receipt sent ', h('button', {class: 'link-button', onclick: () => openReceipt(order), type: 'button'}, 'Receipt'))
				: (pending ? h('p', {class: 'muted shop-order-receipt'}, 'No receipt yet') : null),
			h('ul', {class: 'shop-order-items'}, (order.items || []).map((item) => h('li', null, `${itemLine(item)} · ${formatBrl(item.price_brl)}`))),
			h('p', {class: 'shop-order-total'}, `Total ${formatBrl(order.total)}`),
			missing.length && pending
				? h('p', {class: 'status shop-order-missing', role: 'alert'}, `${plural(missing.length, 'copy', 'copies')} of this order ${missing.length === 1 ? 'is' : 'are'} no longer in your cards. Cancel the order, or add ${missing.length === 1 ? 'it' : 'them'} back.`)
				: null,
			!pending && !logged ? h('p', {class: 'status shop-order-missing'}, 'Paid, but the sale is not in your Trades yet.') : null,
			h('div', {class: 'shop-order-actions'}, ...actions.filter(Boolean))
		);
	}

	function drawOrders() {
		ordersBox.hidden = false;

		const waiting = orders.filter((order) => order.status === 'pending').length;

		ordersBox.replaceChildren(
			h('h3', {id: 'shop-orders-title'}, orders.length ? `Orders (${formatCount(orders.length)})` : 'Orders'),
			orders.length
				? h('p', {class: 'muted'}, waiting ? `${plural(waiting, 'order', 'orders')} waiting for payment.` : 'Nothing waiting for payment.')
				: h('p', {class: 'muted', id: 'shop-orders-none'}, 'No open orders.'),
			...orders.map(orderCard)
		);
	}

	async function run(order, action) {
		working.add(order.code);
		drawOrders();

		try {
			await action();
		}
		finally {
			working.delete(order.code);
			asking.delete(order.code);

			// The buttons were drawn while the call ran, disabled.
			if (alive) {
				drawOrders();
			}
		}
	}

	// The sale, logged under the order's ID: a second try finds it there and
	// logs nothing (js/moves.js planMove).
	async function logSale(order) {
		await run(order, async () => {
			try {
				// Sealed products alone are sold from HOTARU's stock: no card
				// leaves the collection, so there is no sale to log.
				if (hasCards(order)) {
					await applyMove(saleFields(order), {id: order.id});
					toast(`${order.code}: sale logged in your Trades.`);
				}
				else {
					toast(`${order.code} is paid.`);
				}
			}
			catch (err) {
				if (!(err && err.logged)) {
					toast(`${order.code} is paid, but the sale was not logged. ${errorText(err)}`);
				}
			}

			await reload();
			await loadOrders();
			publish();
		});
	}

	// Payment received: HOTARU first, so an order that expired meanwhile
	// changes nothing here; then the sale, which takes the copies out of the
	// collection and so out of the spares.
	async function paid(order) {
		let done = false;

		await run(order, async () => {
			try {
				await markPaid(order.code);
				done = true;
			}
			catch (err) {
				toast(`${order.code} was not marked paid. ${orderErrorText(err)}`);
				await loadOrders();
			}
		});

		if (done) {
			await logSale(order);
		}
	}

	async function cancel(order) {
		await run(order, async () => {
			try {
				await cancelOrder(order.code);
				toast(`${order.code} cancelled. Its cards are back on HOTARU.`);
			}
			catch (err) {
				toast(`${order.code} was not cancelled. ${orderErrorText(err)}`);
			}

			await loadOrders();
			publish();
		});
	}

	async function delivered(order) {
		await run(order, async () => {
			try {
				await markDelivered(order.code);
				toast(`${order.code} delivered.`);
			}
			catch (err) {
				toast(`${order.code} was not marked delivered. ${orderErrorText(err)}`);
			}

			await loadOrders();
		});
	}

	function openReceipt(order) {
		// Opened now, while the tap still counts, and pointed at the link once
		// it arrives.
		const tab = window.open('', '_blank');

		receiptLink(order.receipt_path)
			.then((url) => {
				if (tab) {
					tab.location.href = url;
				}
				else {
					window.location.href = url;
				}
			})
			.catch((err) => {
				if (tab) {
					tab.close();
				}

				toast(`The receipt did not open. ${errorText(err)}`);
			});
	}

	// Orders change on another phone or on HOTARU: read again on return.
	const ordersOnReturn = () => {
		if (document.visibilityState === 'visible') {
			loadOrders();
		}
	};

	document.addEventListener('visibilitychange', ordersOnReturn);

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
		// A draft for a card that is no longer a spare, or that now says what
		// is saved (another phone saved it), is dropped.
		for (const [key, text] of drafts) {
			const group = groups.find((one) => one.key === key);
			const typed = parsePrice(text);

			if (!group || (!typed.error && typed.value === group.price)) {
				drafts.delete(key);
			}
		}

		keepDrafts(drafts);
		drawSummary();
		drawSelects();
		drawList();
		drawSaveBar();
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
			loadOrders();
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
		window.removeEventListener('beforeunload', warnUnsaved);
		document.removeEventListener('visibilitychange', ordersOnReturn);

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
