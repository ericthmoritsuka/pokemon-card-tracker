// The Shop screen: Eric's private staging page for selling his spares on
// HOTARU (plans/hotaru-catalog-plan.md, section 5). One row per card and
// language that has spares, with the sale price Eric typed, or Not priced,
// and suggestions that never leave this screen: TCGplayer's market price
// and Cardmarket's trend in reais, and a Use button that types the higher,
// rounded up to the next R$ 0,50. There is no Liga link here, by Eric's
// choice (2026-11-24): he may price above the market. Only a priced card is
// published, and a copy goes on the HOTARU catalog for the first time only
// from the Publish changes button (Eric, 2026-11-26). Opening the screen and
// every price saved or cleared only bring the live listings up to date and
// withdraw what should no longer be there (js/store-publish.js,
// supabase/store.sql), with each card's name in its copies' language and its
// picture copied once into the shop's public bucket. Every copy is checked
// against js/listing-invariant.js before it is sent.
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
import {entryInfo, fillRecords as fillCardRecords} from './binders-view.js';
import {heldCopies} from './binders.js';
import {loadedSpeciesNames} from './catalog-views.js';
import {cardIndex, compareNumbers, importApi, indexKey, pricesDue, printedCode, readPriceRecord, savedCardRecords, saveToCardIndex, setFacts, setIdOfCard, setList, shopSetMark, viewingLanguage} from './catalog.js';
import {listCards, loadDocument, onChange, updateCards} from './collection.js';
import {BASE, errorText, go, h, segmentCounts} from './dom.js';
import {formatCount, plural} from './format.js';
import {catalogFor, languageLabel} from './languages.js';
import {finishLabel, NO_FINISH as NO_FINISH_TEXT} from './monprice.js';
import {applyMove, parseSalePrice, priceForInput, PRICE_FORM_TEXT} from './moves.js';
import {addPhotoButton, mainSlide, slideSrc} from './photos/index.js';
import {euroRates, exchangeRates, extractPrices, finishFits, finishOf, formatBrl, savedEuroRates, savedRates, shortDate} from './prices.js';
import {PRICE_FILTERS, forSalePatches, groupCopy, groupMark, hasCards, listedOf, listingRows, openOrderCopyIds, orderCheck, ownPicturePath, priceFilter, pricePatches, saleFields, shopGroups, shopKey, shopTotals, storePicturePath, suggestion, timeLeft, unchangedRow, undoForSalePatches, undoPricePatches} from './shop.js';
import {readLiveListings} from './shop-audit.js';
import {setPicker} from './set-picker.js';
import {consignmentSection} from './shop-consignment.js';
import {kitsSection, openKitSheet, orderItemsNode} from './shop-kits.js';
import {alertsOn, NEW_ORDERS_EVENT, notifyPermission, turnOff, turnOn} from './order-alerts.js';
import {checkShopOwner, onShopOwner, setAddAndSell, setConsignPick, setShopTab, SHOP_TABS, shopOwnerKnown, shopTab} from './shop-owner.js';
import {openDialogSheet} from './sheet.js';
import {announceOrders, cancelOrder, DELIVERED_DAYS, deliveredErrorText, deliveredOrders, keepOrderChecks, markDelivered, markPaid, openOrders, ORDER_CHECKS_EVENT, orderChecks, orderErrorText, receiptLink, setOrderCheck, syncOrderChecks, unsavedChecks} from './store-orders.js';
import {PROBLEM_TEXT, keptByChoice, listingProblems} from './listing-invariant.js';
import {listingStatus, publishErrorText, serverSkipped, syncListings, uploadOwnPicture, uploadPicture} from './store-publish.js';
import {onSyncStatus, syncStatus} from './sync.js';
import {loadOnePrintings} from './wishlist.js';

const SHOW_KEY = 'cardTracker.shopShow';
// HOTARU's admin page for sealed products (ericthmoritsuka/hotaru).
const HOTARU_ADMIN = 'https://lojahotaru.com.br/admin.html';
// The prices typed and not saved yet, {<group key>: <text as typed>}.
const DRAFTS_KEY = 'cardTracker.shopDrafts';
const SHOW_LABELS = {all: 'All', priced: 'Priced', unpriced: 'Not priced'};
// The finish filter's name for the rows whose finish is not set, as the row
// itself says.
const NO_FINISH = NO_FINISH_TEXT;

// One filter choice per finish however its row spells it: a monprice word
// kept as typed ("Reverse Holofoil") and the catalog's "Reverse holo".
const finishChoice = (label) => label.toLowerCase().replace(/holofoil/g, 'holo');
// Reading the prices of cards never read before stops after this many
// failures in a row (offline, or TCGdex failing), as My Cards' pass does.
const MAX_FAILURES = 3;
// Above this many new copies in one publish, the list is shown and Publish
// changes asks first (Eric, 2026-11-26: 56 withdrawn cards went out in one
// sync).
export const PUBLISH_GUARD = 10;
// Why Publish changes sent nothing when the open orders could not be read
// (v128 review H1).
const ORDERS_UNREAD = 'Could not read HOTARU\'s open orders, so nothing was published. Try Publish changes again in a moment.';
// How long an order a tick or a payment moved to another stage stays under
// the filter it was in (Eric, 2026-11-27: five to ten seconds).
const ORDER_MOVE_MS = 5000;

function readShow() {
	try {
		const value = localStorage.getItem(SHOW_KEY);

		return PRICE_FILTERS.includes(value) ? value : null;
	}
	catch {
		return null;
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
	// With no choice kept, the Shop opens on Not priced only while something
	// is unpriced, else on All (design review F3).
	let showChosen = readShow() !== null;
	let show = readShow() || 'unpriced';
	// True once the pass that reads missing records has ended.
	let filled = false;
	let query = '';
	let setFilter = '';
	let rarityFilter = '';
	// A finish choice (finishChoice), so the reverse holos can be priced
	// together (Eric, 2026-11-25), or '' for every finish.
	let finishFilter = '';
	// Rows as drawn, by group key, so a suggestion can be put in place.
	const rows = new Map();
	// store_sync's last answer, {<copy id>: {status, image_path}}, and the
	// publishing run in progress, with whether another must follow it.
	let states = {};
	let publishing = null;
	let publishAgain = false;
	// An explicit publish (Publish changes) asked for, for the next run or
	// for when the sync settles, and the new copies still to publish.
	// publishOnly and waitingOnly: the new copies the guard sheet showed, so
	// a publish sends only what Eric confirmed (null: every new copy).
	let publishExplicit = false;
	let publishOnly = null;
	let waitingExplicit = false;
	let waitingOnly = null;
	let pendingNew = [];
	// The copies in open HOTARU orders, as last read (v128 review H1): never
	// the copy kept, and counted as leaving by the listing invariant.
	let awayIds = new Set();
	// Whether the card index was read on the last reload (v128 review M2).
	let indexRead = true;
	// The copies whose price was cleared on this screen (automaticBatch).
	const unpricedHere = new Set();
	// Waiting for the sync to settle before publishing, and its listener.
	let stopWaiting = null;
	// The prices typed and not saved yet, by group key, as typed.
	const drafts = new Map(Object.entries(readDrafts()).filter(([, text]) => typeof text === 'string'));
	let saving = false;
	const publishLine = h('p', {'aria-live': 'polite', class: 'muted shop-publish', id: 'shop-publish'});
	// On the other tabs, one quiet line says copies wait, and leads to Prices.
	const publishHint = h('button', {class: 'link-button muted shop-publish-hint', hidden: true, id: 'shop-publish-hint', onclick: () => showTab('prices', {focus: true}), type: 'button'});
	const publishButton = h('button', {class: 'primary shop-publish-changes', hidden: true, id: 'shop-publish-changes', onclick: () => publishChanges(), type: 'button'}, 'Publish changes');
	// HOTARU's orders (step 5): those waiting for payment and the paid ones
	// still to hand over, with the document they are checked against, the
	// question an order is asking (paid or cancel), and the orders whose
	// call is running. Also the orders delivered lately, for the Delivered
	// filter (v122), or why they could not be read.
	let orders = [];
	let orderDoc = null;
	let deliveredList = [];
	let deliveredError = null;
	// The orders this filter keeps in sight after a tick or a payment moved
	// them to another stage, so an order never vanishes under the finger.
	// Each moves on its own ORDER_MOVE_MS after its last tick or payment
	// (Eric, 2026-11-27: the last tick should take an order to Ready without
	// a refresh, after five to ten seconds), so unticking a card by mistake
	// in that time keeps it here; changing the filter moves them all at once.
	const heldInView = new Set();
	const heldTimers = new Map();
	// The checklist progress lines drawn now, by order code, redrawn when
	// the ticks reach the server or wait on this device.
	const progressDrawers = new Map();
	const asking = new Map();
	const working = new Set();
	const ordersBox = h('section', {'aria-labelledby': 'shop-orders-title', class: 'shop-orders', hidden: true, id: 'shop-orders'});
	// Kits (plans/hotaru-bundles-plan.md): several cards sold together,
	// made from the ticked cards (js/shop-kits.js).
	// The kit count for the Kits tab, kept until the tabs are drawn: the
	// section may draw before them.
	let kitCount = null;
	let tabsDrawn = false;
	const kits = kitsSection({finishText: (group) => finishName(groupCopy(group), group), groups: () => groups, onDraw: (count) => {
		kitCount = count;

		if (tabsDrawn) {
			tabLabel('kits', count);
		}
	}, toast});
	// Consignment (plans/hotaru-consignment-plan.md): other people's cards,
	// sold for a commission, kept on the server only (js/shop-consignment.js).
	const consignment = consignmentSection({go, onLoad: () => {
		if (orders.length) {
			drawOrders();
		}
	}, toast});

	// HOTARU's sealed products are added on its own admin page, which signs
	// in with this app's session (Eric, 2026-11-24). Shown once the server
	// says this is the family's owner, the only one it lets save them.
	// Check live listings sits by the publish line it checks; the sealed
	// products link folds into More (design review F4).
	const sealedLink = h('a', {class: 'button small', href: HOTARU_ADMIN, id: 'shop-sealed-admin-link'}, 'Add sealed products on HOTARU');
	const sealedAdmin = h('p', {class: 'shop-sealed-admin', hidden: true, id: 'shop-sealed-admin'},
		h('a', {class: 'link-button', 'data-link': 'shop/audit', href: `${BASE}shop/audit`, id: 'shop-audit-link'}, 'Check live listings'));

	// For sale beyond the spares (plans/hotaru-for-sale-plan.md, sections 4
	// and 5): one of his own copies, or a card added to sell.
	// One row of two (design review F4): Sell a card, and More for the
	// rarer ones.
	const sellMore = h('div', {class: 'shop-sell-more', hidden: true, id: 'shop-sell-more'},
		h('button', {class: 'small', id: 'shop-sell-own', onclick: () => openSellOwn(), type: 'button'}, 'Sell a card I own'),
		h('details', {class: 'shop-more', id: 'shop-more'},
			h('summary', {class: 'button small'}, 'More'),
			h('div', {class: 'shop-more-items'},
				sealedLink,
				h('button', {class: 'small', id: 'shop-add-sell', onclick: () => {
			setAddAndSell(true);
			go('sets');
			import('./shell.js').then((shell) => shell.toast('Add and sell: find the card, open it, and tap Add. For sale on HOTARU is ticked.', {key: 'add-and-sell', timeout: 0})).catch(() => {});
		}, type: 'button'}, 'Add and sell'))));

	// Opening the Shop ends an Add and sell left unfinished.
	setAddAndSell(false);
	// And a Consign a card left unfinished.
	setConsignPick(false);

	// The owner's controls, shown at once from the answer kept on the phone,
	// and as the server answers, now or once the session is back.
	const drawOwner = (owner) => {
		sealedAdmin.hidden = owner !== true;
		sellMore.hidden = owner !== true;
		kits.setOwner(owner);
		consignment.setOwner(owner);
	};
	const stopOwner = onShopOwner(drawOwner);

	drawOwner(shopOwnerKnown());
	checkShopOwner().then((owner) => {
		if (owner !== null) {
			drawOwner(owner);
		}
	});

	const summary = h('p', {class: 'muted shop-summary', id: 'shop-summary'}, 'Reading your spares…');
	const search = h('input', {'aria-label': 'Search your spares', class: 'search shop-search', id: 'shop-search', placeholder: 'Search your spares', type: 'search'});
	// The set filter shows symbols, so it is a listbox (js/set-picker.js);
	// the facts behind them (setFacts) come from the English set list once.
	const setSelect = setPicker({id: 'shop-set', label: 'Set', onChange: (value) => {
		setFilter = value;
		drawList();
	}});
	let facts = new Map();
	let factsAsked = false;
	const raritySelect = h('select', {'aria-label': 'Rarity', class: 'shop-select', id: 'shop-rarity'});
	const finishSelect = h('select', {'aria-label': 'Finish', class: 'shop-select', id: 'shop-finish'});
	const filter = h('div', {'aria-label': 'Show', class: 'segmented', id: 'shop-filter', role: 'radiogroup'},
		PRICE_FILTERS.map((value) => h('label', null,
			h('input', {checked: value === show, name: 'shop-filter', onchange: () => {
				show = value;
				showChosen = true;
				keepShow(value);
				drawList();
			}, type: 'radio', value}),
			h('span', {'data-label': SHOW_LABELS[value]}, SHOW_LABELS[value])
		))
	);
	// Cards ticked for one price (Eric, 2026-11-24: "select several and set
	// one price"), by group key. A tick stays through a search or a filter,
	// so cards from several searches can share one price.
	const selected = new Set();
	const selectShown = h('button', {class: 'link-button', id: 'shop-select-shown', onclick: () => {
		shown().forEach((group) => selected.add(group.key));
		drawList();
	}, type: 'button'}, 'Select all shown');
	const clearSelection = h('button', {class: 'link-button', id: 'shop-clear-selection', onclick: () => {
		selected.clear();
		drawList();
	}, type: 'button'}, 'Clear selection');
	const bulkInput = h('input', {'aria-label': 'One price for the cards chosen', autocomplete: 'off', class: 'search shop-price-input', id: 'shop-bulk-price', inputmode: 'decimal', placeholder: '1,00', type: 'text'});
	const bulkButton = h('button', {class: 'small', id: 'shop-bulk-set', type: 'submit'}, 'Fill all shown');
	const kitButton = h('button', {class: 'small', hidden: true, id: 'shop-kit-make', onclick: () => makeKit(), type: 'button'}, 'Kit selected');
	const bulkError = h('p', {class: 'form-error', hidden: true, id: 'shop-bulk-error', role: 'alert'});
	const bulk = h('form', {class: 'shop-bulk', id: 'shop-bulk', onsubmit: (event) => {
		event.preventDefault();
		fillShown();
	// Kit sits beside Fill: both act on the ticked cards (Eric, 2026-11-25:
	// in the row of text links it was squeezed into a tall, narrow box).
	}}, h('label', {class: 'shop-bulk-label', for: 'shop-bulk-price'}, 'R$'), bulkInput, bulkButton, kitButton,
	h('div', {class: 'shop-select-tools'}, selectShown, clearSelection));
	const list = h('ul', {'aria-label': 'Your spares', class: 'shop-list', id: 'shop-list'});
	const empty = h('p', {class: 'muted', hidden: true, id: 'shop-empty'});
	const saveStatus = h('p', {'aria-live': 'polite', class: 'status shop-save-status', id: 'shop-save-status'});
	const discardButton = h('button', {id: 'shop-discard', onclick: () => discard(), type: 'button'}, 'Discard');
	const saveButton = h('button', {class: 'primary', id: 'shop-save-all', onclick: () => saveAll(), type: 'button'}, 'Save');
	const saveBar = h('div', {class: 'actions shop-savebar', hidden: true, id: 'shop-savebar'}, saveStatus, discardButton, saveButton);
	// The ticked cards' actions where the thumb is (Eric, 2026-11-25: after
	// ticking far down the list, Fill and Kit were all the way up): a bar
	// that sticks to the bottom while anything is ticked, above the Save bar
	// when that shows too. The row at the top stays as it is.
	const selCount = h('p', {'aria-live': 'polite', class: 'status shop-selbar-count', id: 'shop-selbar-count'});
	const selInput = h('input', {'aria-label': 'One price for the ticked cards', autocomplete: 'off', class: 'search shop-price-input', id: 'shop-selbar-price', inputmode: 'decimal', placeholder: '1,00', type: 'text'});
	const selFill = h('button', {class: 'small', id: 'shop-selbar-fill', type: 'submit'}, 'Fill');
	const selKit = h('button', {class: 'small', id: 'shop-selbar-kit', onclick: () => makeKit(), type: 'button'}, 'Kit');
	const selError = h('p', {class: 'form-error', hidden: true, id: 'shop-selbar-error', role: 'alert'});
	const selBar = h('div', {'aria-label': 'Ticked cards', class: 'actions shop-selbar', hidden: true, id: 'shop-selbar', role: 'region'},
		h('div', {class: 'shop-selbar-head'}, selCount, h('button', {class: 'link-button', id: 'shop-selbar-clear', onclick: () => {
			selected.clear();
			drawList();
		}, type: 'button'}, 'Clear')),
		h('form', {class: 'shop-bulk shop-selbar-form', id: 'shop-selbar-form', onsubmit: (event) => {
			event.preventDefault();
			fillShown(selInput, selError);
		}}, h('label', {class: 'shop-bulk-label', for: 'shop-selbar-price'}, 'R$'), selInput, selFill, selKit),
		selError);
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
	raritySelect.addEventListener('change', () => {
		rarityFilter = raritySelect.value;
		drawList();
	});
	finishSelect.addEventListener('change', () => {
		finishFilter = finishSelect.value;
		drawList();
	});

	// Prices, Kits, and Orders each on a tab of their own (Eric, 2026-11-26:
	// orders and kits in one column above the cards would get confusing as
	// both grow; one part to price the cards, one for kits, one for orders). The tab is kept on this browser tab (js/shop-owner.js
	// shopTab); ?tab= in the address, from a new order's notification, and
	// the header's bag while orders are open choose Orders. The Save bar
	// stays under every tab, so unsaved prices are never out of sight.
	const TAB_NAMES = {consign: 'Consign', kits: 'Kits', orders: 'Orders', prices: 'Prices'};
	const tabButtons = {};
	const panels = {};
	let tab = startTab();

	function startTab() {
		const asked = new URLSearchParams(window.location.search).get('tab');

		if (SHOP_TABS.includes(asked)) {
			setShopTab(asked);
			history.replaceState(history.state, '', window.location.pathname);
		}

		return shopTab();
	}

	function tabLabel(name, count) {
		const button = tabButtons[name];

		if (button) {
			// The count as a pill on the word's line, so "Orders" never wraps
			// at 360 px (design review F5); read aloud as "Orders (3)".
			button.replaceChildren(...(count
				? [TAB_NAMES[name], h('span', {class: 'visually-hidden'}, ' ('), h('span', {class: 'tab-count'}, formatCount(count)), h('span', {class: 'visually-hidden'}, ')')]
				: [TAB_NAMES[name]]));
		}
	}

	function showTab(name, {focus = false} = {}) {
		tab = name;
		setShopTab(name);

		for (const each of SHOP_TABS) {
			const on = each === name;

			tabButtons[each].classList.toggle('on', on);
			tabButtons[each].setAttribute('aria-selected', String(on));
			tabButtons[each].tabIndex = on ? 0 : -1;
			panels[each].hidden = !on;
		}

		if (focus) {
			tabButtons[name].focus();
		}

		publishHint.hidden = !pendingNew.length || name === 'prices';
		drawSelBar();
	}

	// Arrow keys move between the tabs, as a tab list does.
	function tabKeys(event) {
		const step = {ArrowLeft: -1, ArrowRight: 1}[event.key];
		const at = SHOP_TABS.indexOf(tab);
		let next = null;

		if (step) {
			next = SHOP_TABS[(at + step + SHOP_TABS.length) % SHOP_TABS.length];
		}
		else if (event.key === 'Home') {
			next = SHOP_TABS[0];
		}
		else if (event.key === 'End') {
			next = SHOP_TABS[SHOP_TABS.length - 1];
		}

		if (next) {
			event.preventDefault();
			showTab(next, {focus: true});
		}
	}

	const tabList = h('div', {'aria-label': 'Shop', class: 'lists-switch shop-tabs', id: 'shop-tabs', onkeydown: tabKeys, role: 'tablist'},
		SHOP_TABS.map((name) => {
			tabButtons[name] = h('button', {'aria-controls': `shop-panel-${name}`, class: 'lists-switch-item', id: `shop-tab-${name}`, onclick: () => showTab(name), role: 'tab', type: 'button'}, TAB_NAMES[name]);

			return tabButtons[name];
		}));

	const panel = (name, ...children) => {
		panels[name] = h('div', {'aria-labelledby': `shop-tab-${name}`, class: 'shop-panel', id: `shop-panel-${name}`, role: 'tabpanel'}, ...children);

		return panels[name];
	};

	// The new-order alerts (js/order-alerts.js): a chime and a Chrome
	// notification, turned on here because the browser asks only from a tap.
	const alertsBox = h('div', {class: 'card shop-alerts', id: 'shop-alerts'});

	function drawAlerts() {
		const on = alertsOn();
		const permission = notifyPermission();
		let note;

		if (!on) {
			note = 'Turn on alerts to hear a chime, and get a Chrome notification, when an order or a receipt comes in while the Card Tracker is open.';
		}
		else if (permission === 'granted') {
			note = 'On: a chime and a Chrome notification for each new order or receipt while the Card Tracker is open, even in a tab behind others.';
		}
		else if (permission === 'denied') {
			note = 'On, with the chime only: Chrome is blocking notifications for this site. Allow them in the site settings (the icon left of the address) to get them too.';
		}
		else {
			note = 'On, with the chime only: this browser shows no notifications.';
		}

		// Off, it leads the tab, where it is seen; on, it waits below the
		// orders.
		if (panels.orders) {
			if (on) {
				panels.orders.append(alertsBox);
			}
			else {
				panels.orders.prepend(alertsBox);
			}
		}

		alertsBox.replaceChildren(
			h('p', {class: 'muted', id: 'shop-alerts-note'}, note),
			h('div', {class: 'shop-alerts-actions'},
				on
					? h('button', {class: 'small', id: 'shop-alerts-off', onclick: () => {
						turnOff();
						drawAlerts();
					}, type: 'button'}, 'Turn off alerts')
					: h('button', {class: 'small primary', id: 'shop-alerts-on', onclick: async () => {
						await turnOn();

						if (alive) {
							drawAlerts();
						}
					}, type: 'button'}, 'Turn on alerts'))
		);
	}

	drawAlerts();

	root.append(
		h('div', {class: 'view-head'}, h('h2', null, 'Shop')),
		publishLine,
		sealedAdmin,
		publishHint,
		tabList,
		panel('prices',
			h('p', {class: 'muted shop-intro'}, 'Price your spares for HOTARU. Only cards with a price will be offered, and the suggestions stay on this screen.'),
			sellMore,
			summary,
			h('div', {class: 'shop-controls'}, search, filter, h('div', {class: 'shop-selects'}, setSelect.node, raritySelect, finishSelect)),
			bulk,
			bulkError,
			list,
			empty,
			selBar,
			// The button lives on Prices alone, in a bar that stays in reach
			// (design review F4), so it never shouts over an order.
			h('div', {class: 'shop-publish-bar', id: 'shop-publish-bar'}, publishButton)),
		panel('kits', kits.node),
		panel('orders', ordersBox, alertsBox),
		// Consigned cards have a tab of their own (Eric, 2026-11-26).
		panel('consign', consignment.node),
		saveBar
	);

	tabsDrawn = true;
	tabLabel('kits', kitCount);
	drawAlerts();
	showTab(tab);

	// Each group's name, set, and rarity, worked out once per load.
	function describe(group) {
		const info = entryInfo(groupCopy(group), index, viewingLanguage());
		const record = index.get(indexKey(group.catalog, group.card_id)) || null;

		// What the catalog shows: the name and set in the copies' own
		// language, the one the buyer gets, and the picture.
		const sold = entryInfo(groupCopy(group), index, group.language);

		group.info = info;
		group.publishInfo = sold;
		group.pictureBase = sold.image ? sold.image.replace(/\/low\.webp$/, '') : null;
		group.ownPhoto = null;

		// No catalog picture (a hand-made card, a print TCGdex has none
		// for): the image the card's tiles show instead, the international
		// print or the owner's own photo (js/photos/index.js mainSlide). A
		// family member's photo is theirs, so it is never listed.
		if (!group.pictureBase) {
			const slide = mainSlide(group.copies, null);

			if (slide.kind === 'twin' && slide.src) {
				group.pictureBase = slide.src.replace(/\/(low|high)\.webp$/, '');
			}
			else if (slide.kind === 'photo' && slide.photo) {
				group.ownPhoto = slide.photo;
			}
		}
		group.rarity = (record && record.rarity) || null;
		noteFinish(group);
		group.search = searchText(group);
	}

	// info.search holds the English names too, as My Cards' search does,
	// so "Pikachu" finds a Japanese print, once the species names are in
	// (js/catalog-views.js loadedSpeciesNames).
	function searchText(group) {
		const {info} = group;

		return fold([info.search, info.name, info.setName, info.number, group.card_id, languageLabel(group.language), finishName(groupCopy(group), group)].filter(Boolean).join(' '));
	}

	// The finish the row prints, so the filter matches what is shown. A
	// record read later can name it (a copy known by its variant alone), so
	// it is read again then; true when it changed.
	function noteFinish(group) {
		const before = group.finishLabel;

		group.finishLabel = finishName(groupCopy(group), group) || NO_FINISH;
		group.finish = finishChoice(group.finishLabel);

		return before !== undefined && before !== group.finishLabel;
	}

	// The finishes again once records arrive: the filter's choices, and the
	// list when it is filtered by a finish that changed.
	function refreshFinishes(read) {
		const changed = read.filter(noteFinish).length > 0;

		if (changed) {
			drawSelects();

			if (finishFilter) {
				drawList();
			}
		}
	}

	const recordOf = (group) => saved.get(`${group.catalog}|${group.card_id}`) || null;

	function shown() {
		const words = fold(query).split(/\s+/).filter(Boolean);

		return priceFilter(groups, show).filter((group) => (!setFilter || group.set_id === setFilter)
			&& (!rarityFilter || group.rarity === rarityFilter)
			&& (!finishFilter || group.finish === finishFilter)
			&& words.every((word) => group.search.includes(word)));
	}

	function fillSelect(select, label, values, current) {
		select.replaceChildren(
			h('option', {value: ''}, label),
			...values.map(([value, text]) => h('option', {selected: value === current, value}, text))
		);
	}

	// A set's option shows what its cards print (Eric, 2026-11-24: he keeps
	// his cards apart by set): an older Western set's symbol, a newer set's
	// code, "(CRI) Caos Ascendente" (js/catalog.js shopSetMark), and stays
	// sorted by name. A set with neither shows its name alone.
	function drawSelects() {
		askFacts();

		const sets = new Map();

		for (const group of groups) {
			if (group.set_id && !sets.has(group.set_id)) {
				const name = group.info.setName || group.set_id;

				sets.set(group.set_id, {...shopSetMark(group.catalog, group.set_id, facts), text: name, value: group.set_id});
			}
		}

		const rarities = [...new Set(groups.map((group) => group.rarity).filter(Boolean))].sort();

		if (setFilter && !sets.has(setFilter)) {
			setFilter = '';
		}

		if (rarityFilter && !rarities.includes(rarityFilter)) {
			rarityFilter = '';
		}

		// By name, with the rows whose finish is not set last. A choice
		// shows the catalog's spelling when any row has it.
		const finishes = new Map();

		for (const group of groups) {
			const label = finishes.get(group.finish);

			if (!label || (/holofoil/i.test(label) && !/holofoil/i.test(group.finishLabel))) {
				finishes.set(group.finish, group.finishLabel);
			}
		}

		const noFinish = finishChoice(NO_FINISH);
		const finishOptions = [...finishes].sort(([a, aText], [b, bText]) => (a === noFinish) - (b === noFinish) || aText.localeCompare(bText));

		if (finishFilter && !finishes.has(finishFilter)) {
			finishFilter = '';
		}

		setSelect.setOptions([{code: null, symbol: null, text: 'Every set', value: ''}, ...[...sets.values()].sort((a, b) => a.text.localeCompare(b.text))], setFilter);
		fillSelect(raritySelect, 'Every rarity', rarities.map((rarity) => [rarity, rarity]), rarityFilter);
		fillSelect(finishSelect, 'Every finish', finishOptions, finishFilter);
	}

	// The English set list, saved or fetched, for the symbols: the only
	// one that has every older set. Without it the codes show.
	function askFacts() {
		if (factsAsked || !groups.some((group) => group.catalog === 'international')) {
			return;
		}

		factsAsked = true;

		const take = (data) => {
			if (alive) {
				facts = setFacts(data);
				drawSelects();
			}
		};

		setList('en', take).then(({data}) => take(data)).catch(() => {
			// The codes stand in.
		});
	}

	function drawSummary() {
		const totals = shopTotals(groups);

		summary.textContent = totals.groups
			? `${formatCount(totals.priced)} of ${plural(totals.groups, 'card', 'cards')} priced, ${plural(totals.listed, 'copy', 'copies')} for sale in all.${totals.priced ? ` The priced copies come to ${formatBrl(totals.value)}.` : ''}`
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
		// The new habit, said where it applies (design review F3).
		pending: 'Waiting for Publish changes',
		published: 'On HOTARU',
		reserved: 'Reserved by an order',
	};

	function markNode(group) {
		const mark = groupMark(group, states);

		return mark ? h('p', {class: `shop-mark shop-mark-${mark}`}, MARKS[mark]) : null;
	}

	// A row with no finish set keeps the ID it had before finishes were split.
	const rowId = (group) => `shop-${group.key.replace(/[^a-z0-9]+/gi, '-').replace(/-+$/, '')}`;

	// The text a row's field shows: its draft, else its saved price.
	const fieldText = (group) => (drafts.has(group.key) ? drafts.get(group.key) : priceForInput(group.price));

	// Keeps what was typed as a draft, or drops the draft when it says what
	// is saved already.
	function setDraft(group, text) {
		const typed = parseSalePrice(text);
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

	// "2 spares", or with For sale marks "1 spare, 1 more for sale" and "1
	// spare, kept". Only the listed copies go to HOTARU.
	function listedText(group) {
		const kept = group.spares.length - group.spares.filter((entry) => entry.for_sale !== false).length;
		const parts = [group.spares.length ? plural(group.spares.length, 'spare', 'spares') : null];

		if (group.marked.length) {
			parts.push(group.spares.length ? `${formatCount(group.marked.length)} more for sale` : `${plural(group.marked.length, 'copy', 'copies')} for sale`);
		}

		if (kept) {
			parts.push(`${formatCount(kept)} kept`);
		}

		return parts.filter(Boolean).join(', ');
	}

	function stateText(group) {
		if (group.price === null) {
			return 'Not priced: not offered';
		}

		return group.listed.length ? `For sale at ${formatBrl(group.price)} each` : `Priced at ${formatBrl(group.price)}, every copy kept: not offered`;
	}

	function row(group) {
		const {info} = group;
		const id = rowId(group);
		const dirty = drafts.has(group.key);
		// Each finish is its own row and price, so every row names its finish.
		const named = finishName(groupCopy(group), group);
		const finish = named || 'No finish set';
		const input = h('input', {'aria-describedby': `${id}-error`, 'aria-label': `Sale price for ${info.name}, ${finish}`, autocomplete: 'off', class: 'search shop-price-input', enterkeyhint: 'next', id: `${id}-price`, inputmode: 'decimal', placeholder: 'Not priced', type: 'text', value: fieldText(group)});
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

		const meta = [info.number ? `#${info.number}` : null, info.setName, languageLabel(group.language), group.rarity, listedText(group)].filter(Boolean).join(' · ');
		const pick = h('input', {'aria-label': `Select ${info.name}, ${finish}`, checked: selected.has(group.key), class: 'shop-pick', id: `${id}-pick`, onchange: (event) => {
			if (event.target.checked) {
				selected.add(group.key);
			}
			else {
				selected.delete(group.key);
			}

			element.classList.toggle('shop-picked', event.target.checked);
			drawBulk(shown());
		}, type: 'checkbox'});
		const element = h('li', {class: `card shop-row${group.price === null ? ' shop-unpriced' : ''}${dirty ? ' shop-dirty' : ''}${selected.has(group.key) ? ' shop-picked' : ''}`, 'data-key': group.key, id},
			pick,
			artNode(group),
			h('div', {class: 'shop-body'},
				h('a', {class: 'shop-name', 'data-link': info.route, href: BASE + info.route}, info.name),
				// HOTARU reads an unset finish as Normal, a known limitation
				// (design review F14), so the row says so.
				h('p', {class: 'shop-finish-line'}, h('span', {class: `shop-finish${named ? '' : ' shop-finish-unset'}`}, finish), named ? null : h('span', {class: 'muted shop-finish-hotaru'}, ' · Shows as Normal on HOTARU')),
				h('p', {class: 'muted shop-meta'}, meta),
				h('p', {class: 'shop-state'}, stateText(group)),
				h('p', {class: 'shop-draft', hidden: !dirty}, 'Changed, not saved yet'),
				markNode(group),
				suggestionNode(group),
				form,
				pictureButton(group),
				error
			)
		);

		rows.set(group.key, element);

		return element;
	}

	// The row's picture: the catalog's, else what the listing will carry
	// (the international print, or the owner's photo, read from the photo
	// store once it is on the phone).
	function artNode(group) {
		const none = () => h('div', {'aria-hidden': 'true', class: 'shop-art shop-art-none'});
		const src = group.info.image || (group.pictureBase ? `${group.pictureBase}/low.webp` : null);
		const img = (url) => h('img', {alt: '', class: 'shop-art', decoding: 'async', loading: 'lazy', onerror: (event) => event.target.replaceWith(none()), src: url});

		if (src) {
			return img(src);
		}

		const frame = none();

		if (group.ownPhoto) {
			slideSrc({photo: group.ownPhoto}).then((url) => {
				if (url && frame.isConnected) {
					frame.replaceWith(img(url));
				}
			}).catch(() => {});
		}

		return frame;
	}

	// A card with no picture at all gets Add a listing picture: the photo
	// goes on the card, as card detail's Add photo does, and becomes the
	// picture its tiles and its HOTARU listing show.
	function pictureButton(group) {
		if (group.pictureBase || group.ownPhoto) {
			return null;
		}

		const button = addPhotoButton({
			entries: () => group.copies,
			label: 'Add a listing picture',
			onSaved: () => {
				if (alive) {
					reload().then(publish);
				}
			},
		});

		button.classList.add('small', 'shop-add-picture');

		return button;
	}

	function drawList() {
		const visible = shown();
		// The price field being typed in keeps the focus and the caret: the
		// Shop draws the list again as it opens (records, pictures, rates),
		// and a field drawn anew would take the next keys nowhere (2026-11-24,
		// a price typed right after opening was lost). What was typed is in
		// the draft already, which the new field shows.
		const active = document.activeElement;
		const typing = active && active.classList.contains('shop-price-input') && list.contains(active)
			? {end: active.selectionEnd, key: active.closest('.shop-row').dataset.key, start: active.selectionStart}
			: null;

		rows.clear();
		list.replaceChildren(...visible.map(row));

		const again = typing && rows.get(typing.key);

		if (again) {
			const input = again.querySelector('.shop-price-input');

			input.focus({preventScroll: true});

			try {
				input.setSelectionRange(typing.start, typing.end);
			}
			catch {
				// A field that holds no caret; the focus is what matters.
			}
		}
		empty.hidden = visible.length > 0;
		empty.textContent = !groups.length
			? 'No spares yet. A spare is a copy beyond the first of the same card in the same language, never a favorite.'
			: show === 'unpriced' && !query && !setFilter && !rarityFilter && !finishFilter
				? 'Every spare is priced.'
				: 'No spares match.';
		drawBulk(visible);
	}

	// The fill button names what it fills: the ticked cards when there are
	// any, else every card shown.
	function drawBulk(visible) {
		// A tick on a card that is no longer a spare is dropped.
		for (const key of selected) {
			if (!groups.some((group) => group.key === key)) {
				selected.delete(key);
			}
		}

		bulkButton.textContent = selected.size
			? `Fill ${formatCount(selected.size)} selected`
			: (visible.length ? `Fill all ${formatCount(visible.length)} shown` : 'Fill all shown');
		bulkButton.disabled = !selected.size && !visible.length;
		clearSelection.hidden = !selected.size;
		selectShown.hidden = !visible.length || visible.every((group) => selected.has(group.key));
		// A kit is two or more ticked cards, for the owner.
		kitButton.hidden = selected.size < 2 || sellMore.hidden;
		kitButton.textContent = `Kit ${formatCount(selected.size)} selected`;
		drawSelBar();
	}

	function drawSelBar() {
		const n = selected.size;
		const count = `${formatCount(n)} selected`;

		selBar.hidden = !n;

		if (selCount.textContent !== count) {
			selCount.textContent = count;
		}

		selFill.setAttribute('aria-label', `Fill ${count}`);
		selKit.hidden = sellMore.hidden;
		selKit.disabled = n < 2;
		selKit.setAttribute('aria-label', n < 2 ? 'Kit: tick 2 or more cards' : `Kit ${count}`);
		selKit.title = n < 2 ? 'Tick 2 or more cards for a kit' : '';

		if (!n) {
			selError.hidden = true;
		}
	}

	// The ticked cards as a new kit; the ticks clear once it is saved.
	function makeKit() {
		openKitSheet({
			chosen: groups.filter((group) => selected.has(group.key)),
			kits: kits.kits,
			onSaved: async () => {
				selected.clear();
				drawList();
				await kits.load();
			},
			// Before the visit's first publish answers, the server decides.
			states: Object.keys(states || {}).length ? states : null,
			toast,
		});
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
		// The ticked cards' bar rides above the Save bar.
		root.style.setProperty('--shop-savebar-h', n ? `${saveBar.offsetHeight}px` : '0px');
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

			const typed = parseSalePrice(text);

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

		// A price cleared here takes its copies off HOTARU on the automatic
		// path; a price merely unknown here (another device's, not merged
		// yet) does not (v128 review M1).
		for (const {group, price} of changes) {
			for (const entry of group.copies || []) {
				if (price === null) {
					unpricedHere.add(entry.id);
				}
				else {
					unpricedHere.delete(entry.id);
				}
			}
		}
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

	// Types one price into the ticked cards, or every card shown when none
	// is ticked, as drafts; the ticks are then cleared.
	function fillShown(input = bulkInput, error = bulkError) {
		const typed = parseSalePrice(input.value);
		const visible = selected.size ? groups.filter((group) => selected.has(group.key)) : shown();

		if (typed.error || typed.value === null) {
			error.textContent = typed.error || PRICE_FORM_TEXT;
			error.hidden = false;
			input.focus();

			return;
		}

		error.hidden = true;
		input.value = '';

		for (const group of visible) {
			if (group.price === typed.value) {
				drafts.delete(group.key);
			}
			else {
				drafts.set(group.key, priceForInput(typed.value));
			}
		}

		keepDrafts(drafts);
		selected.clear();
		drawList();
		drawSaveBar();
	}

	// A copy's finish as the catalog names it: the card's listed finish, else
	// the word the import kept. A card's only printing is taken for any copy
	// (finishOf), but a copy whose word says otherwise, such as a Reverse
	// holo on a card listed only as Normal, is named by its word, as My Cards
	// names it (js/cards-view.js), so its row and its HOTARU listing are not
	// taken for the Normal's.
	// Sell a card I own: every card, language, and finish of his with a copy
	// not offered yet, searchable; picking one marks one copy For sale, a
	// loose one before one in a binder, and shows it in the Shop to price.
	async function openSellOwn() {
		let cards;
		let held;

		try {
			const [list, doc] = await Promise.all([listCards(), loadDocument()]);

			cards = list;
			held = heldCopies(doc);
		}
		catch (err) {
			toast(`Your cards could not be read. ${errorText(err)}`);

			return;
		}

		const offered = new Set(groups.flatMap((group) => group.listed).map((entry) => entry.id));
		const byKey = new Map();

		for (const entry of cards) {
			if (offered.has(entry.id)) {
				continue;
			}

			const key = shopKey({...entry, catalog: entry.catalog || 'international'});

			if (!byKey.has(key)) {
				byKey.set(key, {card_id: entry.card_id, catalog: entry.catalog || 'international', entries: [], key, language: entry.language});
			}

			byKey.get(key).entries.push(entry);
		}

		const choices = [...byKey.values()].map((choice) => {
			const info = entryInfo(choice.entries[0], index, viewingLanguage());
			const finish = finishName(choice.entries[0], choice);

			return {...choice, finish, info, search: fold([info.search, info.name, info.setName, info.number, choice.card_id, languageLabel(choice.language), finish].filter(Boolean).join(' '))};
		}).sort((a, b) => (a.info.setName || '').localeCompare(b.info.setName || '') || compareNumbers(a.info.number || '', b.info.number || ''));

		const sheet = h('dialog', {'aria-labelledby': 'shop-sell-title', class: 'sheet shop-sell-sheet', id: 'shop-sell-sheet'});
		const field = h('input', {'aria-label': 'Search your cards', class: 'search', id: 'shop-sell-search', placeholder: 'Search your cards', type: 'search'});
		const list = h('ul', {class: 'shop-sell-list', id: 'shop-sell-list'});
		const MAX_SHOWN = 40;

		function drawChoices() {
			const words = fold(field.value).split(/\s+/).filter(Boolean);
			const found = choices.filter((choice) => words.every((word) => choice.search.includes(word)));

			list.replaceChildren(...found.slice(0, MAX_SHOWN).map((choice) => {
				const loose = choice.entries.filter((entry) => !held.has(entry.id)).length;
				const where = loose ? `${plural(choice.entries.length, 'copy', 'copies')}` : `${plural(choice.entries.length, 'copy', 'copies')}, in a binder`;

				return h('li', null, h('button', {class: 'shop-sell-choice', 'data-key': choice.key, onclick: () => pick(choice), type: 'button'},
					h('span', {class: 'shop-sell-name'}, choice.info.name),
					h('span', {class: 'muted shop-sell-meta'}, [choice.info.number ? `#${choice.info.number}` : null, choice.info.setName, languageLabel(choice.language), choice.finish, where].filter(Boolean).join(' · '))));
			}), found.length > MAX_SHOWN ? h('li', {class: 'muted shop-sell-more-note'}, `${formatCount(found.length - MAX_SHOWN)} more: search to narrow them.`) : '');
		}

		async function pick(choice) {
			// A loose copy before one in a binder, and not a favorite's, the
			// copy added last first.
			const copy = [...choice.entries].sort((a, b) => Number(held.has(a.id)) - Number(held.has(b.id))
				|| Number(a.is_favorite === true) - Number(b.is_favorite === true)
				|| String(b.created_at).localeCompare(String(a.created_at)))[0];
			const patches = forSalePatches([copy], true);
			const undo = undoForSalePatches([copy], patches);

			sheet.close();

			try {
				await updateCards(patches);
			}
			catch (err) {
				toast(`Not marked. ${errorText(err)}`);

				return;
			}

			await reload();

			const group = groups.find((one) => one.listed.some((entry) => entry.id === copy.id));

			if (group && group.price === null && show === 'priced') {
				show = 'all';
				keepShow(show);
				filter.querySelector('input[value="all"]').checked = true;
			}

			query = '';
			search.value = '';
			drawList();

			const input = group ? document.getElementById(`${rowId(group)}-price`) : null;

			if (input) {
				input.scrollIntoView({block: 'center'});
				input.focus();
			}

			toast(`${choice.info.name} is For sale${held.has(copy.id) ? ': it leaves its binder pocket when it sells' : ''}. ${group && group.price !== null ? 'Publish changes to put it on HOTARU.' : 'Give it a price to put it on HOTARU.'}`, {
				action: () => updateCards(undo).then(reload).then(publish).catch((err) => toast(`Not put back. ${errorText(err)}`)),
				actionLabel: 'Undo',
				timeout: 8000,
			});
			publish();
		}

		field.addEventListener('input', drawChoices);
		sheet.addEventListener('click', (event) => {
			if (event.target === sheet) {
				sheet.close();
			}
		});
		sheet.append(
			h('div', {class: 'sheet-head'},
				h('h2', {id: 'shop-sell-title'}, 'Sell a card I own'),
				h('button', {class: 'small', id: 'shop-sell-close', onclick: () => sheet.close(), type: 'button'}, 'Close')),
			h('p', {class: 'muted'}, 'One copy of the card you pick is marked For sale, even your last one or one in a binder. It leaves your cards when it sells.'),
			field,
			list
		);
		document.body.append(sheet);
		drawChoices();
		openDialogSheet(sheet, {onClose: () => sheet.remove()});
		field.focus();
	}

	function finishName(entry, group) {
		const record = recordOf(group);
		const matched = record ? finishOf(entry, extractPrices(record)) : null;
		const found = matched && finishFits(entry, matched) ? matched : null;

		return (found && found.label) || (entry.finish_raw ? finishLabel(entry.finish_raw) : null);
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

	// Two ways to sync (Eric, 2026-11-26: opening the Shop re-listed 56
	// withdrawn cards). publish(), run on opening and after every save, is
	// the automatic path: it keeps the copies already live (or reserved) up
	// to date and withdraws the rest, and never lists a new copy.
	// publishChanges(), the Publish changes button, also lists the new ones,
	// asking first above PUBLISH_GUARD of them. One run at a time; a change
	// during a run starts one more after it, and an explicit publish asked
	// for during a run is kept for that next run.
	function publish({explicit = false, only = null} = {}) {
		if (explicit) {
			publishOnly = publishExplicit ? (publishOnly && only ? new Set([...publishOnly, ...only]) : null) : only;
		}

		publishExplicit = publishExplicit || explicit;

		if (publishing) {
			publishAgain = true;

			return publishing;
		}

		publishing = (async () => {
			do {
				publishAgain = false;

				const mode = publishExplicit;
				const only = publishOnly;

				publishExplicit = false;
				publishOnly = null;
				await publishOnce({explicit: mode, only});
			} while (publishAgain && alive);
		})().finally(() => {
			publishing = null;
		});

		return publishing;
	}

	// The rows that may go out, checked against the listing invariant
	// (js/listing-invariant.js) right before the upsert: a copy that breaks
	// it is skipped, fail closed. Resolves to {rows, skipped, status}, where
	// skipped is [{group, entry, reason}] and status is listing_status's
	// answer for every priced copy, or null when it could not be read.
	// away is the copy ids in open orders, or null when the orders could not
	// be read; live, with {live: true}, HOTARU's available singles
	// (store_catalog), or null when they could not be read.
	async function plan({live: readLive = false} = {}) {
		// Planned from the latest merged document, never the screen's last
		// read (QA shop 1 to 3: a star, Not for sale, or a price from
		// another device).
		await reload();

		let away = null;

		try {
			away = openOrderCopyIds(await openOrders());
		}
		catch {
			away = null;
		}

		// A copy newly in an order can no longer be the copy kept, so the
		// groups are worked out again before anything is sent.
		if (away && (away.size !== awayIds.size || [...away].some((id) => !awayIds.has(id)))) {
			awayIds = away;
			await reload();
		}

		const doc = await loadDocument();
		const all = rowsFor(priced());
		const problems = listingProblems(doc, all.map((row) => row.id), away ? [...away] : []);
		const skipped = [];

		for (const group of priced()) {
			for (const entry of listedOf(group)) {
				if (problems.has(entry.id)) {
					skipped.push({entry, group, reason: problems.get(entry.id)});
				}
			}
		}

		let status = null;

		try {
			status = await listingStatus(all.map((row) => row.id));
		}
		catch {
			status = null;
		}

		let live = null;

		if (readLive) {
			try {
				live = await readLiveListings();
			}
			catch {
				live = null;
			}
		}

		return {away, doc, live, problems, rows: all.filter((row) => !problems.has(row.id)), skipped, status};
	}

	// The automatic path's batch (v128 review M1, the interim without new
	// SQL): every copy live on HOTARU is sent again, this screen's row where
	// it has one and HOTARU's own row unchanged where it does not, so a
	// screen that has not caught up with another device never withdraws a
	// listing it merely does not know. A live copy leaves only when this
	// device's document says so: the copy is gone, held, the last of its
	// finish, taken off sale, or its finish lost its price here. Resolves the
	// ids to withdraw too.
	function automaticBatch(planned) {
		const {away, doc, live, status} = planned;
		const mine = rowsFor(priced());
		const mineIds = new Set(mine.map((row) => row.id));
		const byId = new Map(((doc && doc.cards) || []).filter((entry) => entry && entry.id && !entry.deleted_at).map((entry) => [entry.id, entry]));
		const kept = keptByChoice(doc);
		const offSale = (id) => {
			const entry = byId.get(id);

			return entry && (kept.has(id) || unpricedHere.has(id));
		};
		const candidates = [
			...mine.filter((row) => isLiveStatus(status[row.id])),
			...(live || []).filter((row) => !mineIds.has(row.id) && !offSale(row.id)).map(unchangedRow),
		];
		const problems = listingProblems(doc, candidates.map((row) => row.id), [...(away || [])]);
		const rows = candidates.filter((row) => !problems.has(row.id));
		const sent = new Set(rows.map((row) => row.id));
		const withdrawn = (live || []).filter((row) => !sent.has(row.id)).map((row) => row.id);

		return {extra: rows.filter((row) => !mineIds.has(row.id)), ids: sent, problems, withdrawn};
	}

	const isLiveStatus = (value) => value === 'available' || value === 'reserved';

	// The copies a publish would list for the first time, from plan().
	const newRows = ({rows, status}) => rows.filter((row) => !status || !isLiveStatus(status[row.id]));

	// The copies kept home, as the guard and the publish line both say them
	// (design review F6 and F7): "Staying home (2):", one per line, each
	// with the shared reason (js/listing-invariant.js REASONS).
	const stayingLine = ({entry, group, reason}) => {
		const info = (group && (group.publishInfo || group.info)) || {};
		const name = [info.name || (group && group.card_id) || (entry && entry.id), info.number].filter(Boolean).join(' ');

		return `${name}: ${PROBLEM_TEXT[reason]}`;
	};

	function skippedText(skipped) {
		if (!skipped.length) {
			return '';
		}

		const named = skipped.slice(0, 5).map(stayingLine);

		return ` Staying home (${formatCount(skipped.length)}): ${named.join('; ')}${skipped.length > 5 ? '; and more' : ''}.`;
	}

	function stayingHomeNode(skipped, id) {
		return h('div', {class: 'shop-staying', id},
			h('p', {class: 'status'}, `Staying home (${formatCount(skipped.length)}):`),
			h('ul', {class: 'shop-staying-list'}, ...skipped.map((one) => h('li', null, stayingLine(one)))));
	}

	// The Publish changes button: hidden with nothing new to list, and
	// saying how many copies will go out.
	function drawPending() {
		const count = pendingNew.length;

		publishButton.hidden = !count;
		publishButton.parentElement && (publishButton.parentElement.hidden = !count);
		publishHint.hidden = !count || tab === 'prices';
		publishHint.textContent = count ? `${plural(count, 'new copy waits', 'new copies wait')} to publish · Prices` : '';
		publishButton.textContent = count ? `Publish changes: ${plural(count, 'new copy', 'new copies')}` : 'Publish changes';
	}

	// Lists the new copies too. More than PUBLISH_GUARD of them shows the
	// list in a sheet and asks first.
	async function publishChanges() {
		const planned = await plan();

		if (!planned.away) {
			publishLine.textContent = ORDERS_UNREAD;

			return;
		}

		const fresh = newRows(planned);

		if (fresh.length > PUBLISH_GUARD && !(await confirmBatch(fresh, planned.skipped))) {
			return;
		}

		// Only the copies shown (and so confirmed) go out as new; one priced
		// in the meantime waits for the next Publish changes (v128 review,
		// Low 2).
		await publish({explicit: true, only: new Set(fresh.map((row) => row.id))});
	}

	// The guard list, one line per card, language, finish, and price with
	// a count (design review F6), and the total.
	function guardLines(fresh) {
		const lines = new Map();

		for (const row of fresh) {
			const text = `${row.name}${row.number ? ` ${row.number}` : ''} · ${languageLabel(row.language) || row.language || ''} · ${row.finish || NO_FINISH} · ${formatBrl(row.price_brl)}`;

			lines.set(text, (lines.get(text) || 0) + 1);
		}

		return [...lines].map(([text, n]) => (n > 1 ? `${text} ×${n}` : text));
	}

	function confirmBatch(fresh, skipped) {
		return new Promise((resolve) => {
			const sheet = h('dialog', {'aria-labelledby': 'shop-guard-title', class: 'sheet shop-guard', id: 'shop-guard'});
			const total = fresh.reduce((sum, row) => sum + (Number(row.price_brl) || 0), 0);
			const cancel = h('button', {id: 'shop-guard-cancel', onclick: () => close(false), type: 'button'}, 'Not now');
			let answer = false;
			const close = (value) => {
				answer = value;
				sheet.close();
			};

			// Built from h() children, never a bare null (design review B1:
			// append() printed it as "null").
			sheet.append(...[
				h('div', {class: 'sheet-head'}, h('h2', {id: 'shop-guard-title', tabindex: '-1'}, `List ${plural(fresh.length, 'new copy', 'new copies')} on HOTARU?`)),
				h('p', {class: 'muted'}, `This publish puts more than ${formatCount(PUBLISH_GUARD)} new copies on HOTARU at once. Check the list before they go out.`),
				h('ul', {class: 'shop-guard-list', id: 'shop-guard-list'}, ...guardLines(fresh).map((line) => h('li', null, line))),
				h('p', {class: 'shop-guard-total', id: 'shop-guard-total'}, `${plural(fresh.length, 'copy', 'copies')} · ${formatBrl(Math.round(total * 100) / 100)}`),
				skipped.length ? stayingHomeNode(skipped, 'shop-guard-skipped') : null,
				h('div', {class: 'shop-guard-actions'},
					h('button', {class: 'primary', id: 'shop-guard-publish', onclick: () => close(true), type: 'button'}, 'Publish'),
					cancel),
			].filter(Boolean));
			document.body.append(sheet);
			openDialogSheet(sheet, {onClose: () => {
				sheet.remove();
				resolve(answer);
			}});
			// The question first and Not now focused, so one tap never
			// publishes the batch unread (design review B1).
			sheet.scrollTop = 0;
			cancel.focus();
		});
	}

	async function publishOnce({explicit = false, only = null} = {}) {
		if (!currentUser()) {
			publishLine.textContent = 'Sign in to publish your priced spares to HOTARU.';

			return;
		}

		if (!navigator.onLine) {
			publishLine.textContent = 'Offline: your prices are saved. Live listings catch up when you open the Shop online.';

			return;
		}

		// Publishing sends the whole set and withdraws everything else, so it
		// waits until this phone holds every card the server does and has
		// sent its own changes: a phone just signed in, still reading the
		// collection, would otherwise take every card off HOTARU.
		const sync = syncStatus();

		if (sync.phase !== 'synced' || sync.pending) {
			publishLine.textContent = 'Waiting for your cards to sync before publishing to HOTARU…';

			if (explicit) {
				waitingOnly = waitingExplicit ? null : only;
				waitingExplicit = true;
			}

			if (!stopWaiting) {
				stopWaiting = onSyncStatus((next) => {
					if (next.phase === 'synced' && !next.pending && stopWaiting) {
						const stop = stopWaiting;

						stopWaiting = null;
						queueMicrotask(() => {
							stop();

							if (alive) {
								const again = waitingExplicit;
								const againOnly = waitingOnly;

								waitingExplicit = false;
								waitingOnly = null;
								reload().then(() => publish({explicit: again, only: againOnly}));
							}
						});
					}
				});
			}

			return;
		}

		publishLine.textContent = 'Publishing to HOTARU…';

		try {
			const planned = await plan({live: true});

			if (!alive) {
				return;
			}

			// Without the open orders, a copy on its way to a buyer would count
			// as at home, so nothing is sent (v128 review H1).
			if (!planned.away) {
				pendingNew = planned.status ? newRows(planned) : pendingNew;
				drawPending();
				publishLine.textContent = explicit ? ORDERS_UNREAD : 'Could not read HOTARU\'s open orders, so nothing changed there.';

				return;
			}

			// The automatic path never lists a new copy. When it cannot tell
			// which copies are live, or the card index (which tells finishes
			// apart) could not be read, it changes nothing: a partial set would
			// withdraw the rest.
			if (!explicit && !indexRead) {
				pendingNew = planned.status ? newRows(planned) : pendingNew;
				drawPending();
				publishLine.textContent = 'Could not read the card index, so nothing changed on HOTARU.';

				return;
			}

			if (!explicit && (!planned.status || !planned.live)) {
				pendingNew = planned.status ? newRows(planned) : pendingNew;
				drawPending();
				publishLine.textContent = `Could not read what is on HOTARU, so nothing changed there.${skippedText(planned.skipped)}`;

				return;
			}

			const auto = explicit ? null : automaticBatch(planned);
			const allowed = explicit
				? new Set(planned.rows.filter((row) => !only || only.has(row.id) || (planned.status && isLiveStatus(planned.status[row.id]))).map((row) => row.id))
				: auto.ids;
			const extra = auto ? auto.extra : [];
			// A finish this screen cannot name yet (the card's record not read)
			// keeps the one HOTARU holds, so a listing never flips between
			// "Normal" and none from one run to the next (QA shop 18).
			const liveFinish = new Map((planned.live || []).filter((row) => row.finish).map((row) => [row.id, row.finish]));
			const named = (row) => (!row.finish && liveFinish.has(row.id) ? {...row, finish: liveFinish.get(row.id)} : row);
			const send = (list) => [...rowsFor(list).filter((row) => allowed.has(row.id)).map(named), ...extra];
			// Live copies that break the invariant, or that this device took
			// off sale, leave HOTARU now.
			const pulled = explicit
				? planned.skipped.filter(({entry}) => planned.status && planned.status[entry.id] === 'available').length
				: auto.withdrawn.length;

			// Known before the call, so a failed sync still offers the button
			// (QA shop 12).
			pendingNew = explicit ? newRows(planned).filter((row) => !allowed.has(row.id)) : newRows(planned);
			drawPending();
			states = await syncListings(send(priced()), {relist: explicit});
			pendingNew = explicit ? newRows(planned).filter((row) => !allowed.has(row.id)) : newRows(planned);

			if (!alive) {
				return;
			}

			drawMarks();
			drawPending();

			// The pictures still missing, one per card. The finishes of a card
			// share its picture: one already in the bucket is only named, and
			// each picture is copied at most once. A card the catalog has no
			// picture for takes the owner's photo.
			// A card is missing its picture while any listed copy lacks one:
			// a copy listed after the first keeps none of its own (v111,
			// Eric 2026-11-25). A sibling copy's picture is reused as is.
			const sent = (entry) => allowed.has(entry.id);
			const pictureOf = (entry) => (states[entry.id] && states[entry.id].image_path) || null;
			const missing = priced().filter((group) => group.listed.some(sent) && group.listed.some((entry) => sent(entry) && !pictureOf(entry))
				&& (group.pictureBase || group.ownPhoto || group.listed.some(pictureOf)));
			const stored = new Set(Object.values(states || {}).map((one) => one && one.image_path).filter(Boolean));
			const copied = new Map();
			const uploaded = [];

			for (const group of missing) {
				const sibling = group.listed.map(pictureOf).find(Boolean);

				if (sibling) {
					uploaded.push({...group, picturePath: sibling});

					continue;
				}

				const path = group.pictureBase ? storePicturePath(group.pictureBase) : ownPicturePath(group.ownPhoto);
				const sendPicture = () => (group.pictureBase ? uploadPicture(group.pictureBase, path) : uploadOwnPicture(group.ownPhoto, path));

				if (!alive || !path) {
					continue;
				}

				if (!stored.has(path) && !copied.has(path)) {
					copied.set(path, await sendPicture().catch(() => false));
				}

				if (stored.has(path) || copied.get(path)) {
					uploaded.push({...group, picturePath: path});
				}
			}

			if (uploaded.length && alive) {
				const withPictures = new Map(uploaded.map((group) => [group.key, group]));

				states = await syncListings(send(priced().map((group) => withPictures.get(group.key) || group)), {relist: explicit});
			}

			if (!alive) {
				return;
			}

			drawMarks();

			// A card counts as on HOTARU while any listed copy is (QA shop 10:
			// a half-live card counted as none).
			const isOn = (entry) => Boolean(states[entry.id]) && states[entry.id].status === 'available';
			const live = priced().filter((group) => group.listed.some(isOn)).length;
			const copies = priced().reduce((n, group) => n + group.listed.filter(isOn).length, 0);
			const noPicture = priced().filter((group) => group.listed.some((entry) => sent(entry) && !(states[entry.id] && states[entry.id].image_path))).length;
			// The waiting count first, then what is live, then the pictures,
			// one per line (design review P5).
			const parts = [
				pendingNew.length ? `${plural(pendingNew.length, 'new copy waits', 'new copies wait')} to publish.` : null,
				live
					? `On HOTARU: ${plural(live, 'card', 'cards')}, ${plural(copies, 'copy', 'copies')}.`
					: (pendingNew.length ? 'Nothing on HOTARU yet.' : 'Nothing on HOTARU yet: give a card a price to offer it.'),
				noPicture ? `${plural(noPicture, 'card has', 'cards have')} no picture yet.` : null,
			].filter(Boolean);

			if (pulled) {
				parts.push(`Withdrew ${plural(pulled, 'copy', 'copies')} that should not be listed.`);
			}

			// Copies the server refused (the listing invariant's server half,
			// supabase/store-hardening.sql), named the way the client's own
			// skips are.
			const refused = serverSkipped(states).map(({id, reason}) => {
				const group = priced().find((one) => one.listed.some((entry) => entry.id === id));
				const name = group ? (group.publishInfo && group.publishInfo.name) || (group.info && group.info.name) || group.card_id : id;

				return {group: {card_id: group ? group.card_id : id, info: {name}}, reason};
			});

			// One fact per line, not one run-on paragraph (design review P5).
			publishLine.textContent = [...parts, skippedText([...planned.skipped, ...refused]).trim()].filter(Boolean).join('\n');

			// A kit whose copy is gone takes another copy of the same card.
			await kits.refill(states).catch(() => {});
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
			// Read with the orders: a paid or delivered order changes what
			// consignors are owed, and an order names whose card it holds.
			// The ticks come from the server too (v122), so the phone and
			// the computer agree on what is separated; neither they nor the
			// delivered orders stop the open ones from showing.
			const [found, doc, , , done] = await Promise.all([
				openOrders(),
				loadDocument(),
				consignment.load().catch(() => null),
				syncOrderChecks(),
				deliveredOrders().then((list) => ({list}), (error) => ({error})),
			]);

			if (!alive) {
				return;
			}

			orders = found;
			orderDoc = doc;
			deliveredList = done.list || [];
			deliveredError = done.error || null;
			keepOrderChecks(found.map((order) => order.code));
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

	// A card names its number, finish, and condition; a sealed product
	// (step 4) its kind; a consigned card whose it is. The finish (Eric,
	// 2026-11-26: without it, which copy to pull is hard to tell) is the one
	// the listing was published with, or, on a listing published without
	// one, the copy's own as the Shop names it.
	const itemFinish = (item) => {
		if (item.finish) {
			return item.finish;
		}

		const copy = ((orderDoc && orderDoc.cards) || []).find((entry) => entry && entry.id === item.listing_id);

		return copy ? finishName(copy, {card_id: copy.card_id, catalog: copy.catalog || 'international'}) : null;
	};
	const itemLine = (item) => (item.kind === 'sealed'
		? [item.name, item.set_name, item.language ? languageLabel(item.language) : null, 'Sealed'].filter(Boolean).join(' · ')
		: [item.name, item.number ? `#${item.number}` : null, itemFinish(item), item.set_name, item.language ? languageLabel(item.language) : null, item.condition,
			item.kind === 'consigned' ? ['Consigned', consignment.ownerOf(item.listing_id)].filter(Boolean).join(' · ') : null].filter(Boolean).join(' · '));

	// The card's picture over its order line while the pointer rests on it
	// (Eric, 2026-11-26: to find the card by its picture when its number is
	// not enough). The copy's own picture, as its tiles show it; a consigned
	// card, never in the collection, the catalog print in the order's
	// language. Read once per card while the Shop is open.
	const orderPictures = new Map();

	async function readOrderPicture(item) {
		if (item.kind === 'sealed') {
			return null;
		}

		const copy = ((orderDoc && orderDoc.cards) || []).find((entry) => entry && entry.id === item.listing_id) || null;
		const entry = copy
			? {...copy, catalog: copy.catalog || 'international'}
			: (item.card_id ? {card_id: item.card_id, catalog: catalogFor(item.language), language: item.language} : null);

		if (!entry) {
			return null;
		}

		let records = index;

		if (!records.has(indexKey(entry.catalog, entry.card_id))) {
			records = (await fillCardRecords([{catalog: entry.catalog, cardId: entry.card_id}], index, () => alive).catch(() => null)) || index;
		}

		const info = entryInfo(entry, records, item.language || entry.language);

		if (info.full || info.image) {
			return info.full || info.image;
		}

		if (copy) {
			const slide = mainSlide([copy], null);

			if (slide.kind === 'twin' && slide.src) {
				return slide.src;
			}

			if (slide.kind === 'photo' && slide.photo) {
				return slideSrc({photo: slide.photo});
			}
		}

		return null;
	}

	function orderPicture(item) {
		if (!orderPictures.has(item.listing_id)) {
			orderPictures.set(item.listing_id, readOrderPicture(item).catch(() => null));
		}

		return orderPictures.get(item.listing_id);
	}

	// Shows the picture above the line, or below it when the line is too
	// near the top of the window. A mouse shows it while it rests on the
	// line, the keyboard while the box has the focus, and a finger while it
	// holds the line down (a long press, which then does not tick the box;
	// a tap still ticks it, and a finger that moves is scrolling).
	const LONG_PRESS_MS = 450;

	function peekNode(item, label) {
		const peek = h('img', {alt: '', class: 'shop-order-peek', decoding: 'async', hidden: true});
		let wanted = false;

		const show = () => {
			wanted = true;
			orderPicture(item).then((url) => {
				if (!wanted || !url || !label.isConnected) {
					return;
				}

				if (peek.getAttribute('src') !== url) {
					peek.src = url;
				}

				peek.classList.toggle('shop-order-peek-below', label.getBoundingClientRect().top < 300);
				peek.hidden = false;
			});
		};
		const hide = () => {
			wanted = false;
			peek.hidden = true;
		};

		let press = null;
		let pressed = false;
		const endPress = () => {
			if (press) {
				clearTimeout(press.timer);
				press = null;
			}
		};

		label.addEventListener('pointerdown', (event) => {
			if (event.pointerType === 'mouse') {
				return;
			}

			endPress();
			pressed = false;
			press = {
				timer: setTimeout(() => {
					pressed = true;
					show();
				}, LONG_PRESS_MS),
				x: event.clientX,
				y: event.clientY,
			};
		});
		label.addEventListener('pointermove', (event) => {
			if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) {
				endPress();
			}
		});
		for (const name of ['pointerup', 'pointercancel']) {
			label.addEventListener(name, (event) => {
				if (event.pointerType !== 'mouse') {
					endPress();
					hide();
				}
			});
		}
		// The long press opened the picture: the click it ends with leaves
		// the box as it was, and no menu opens.
		label.addEventListener('click', (event) => {
			if (pressed) {
				pressed = false;
				event.preventDefault();
			}
		});
		label.addEventListener('contextmenu', (event) => {
			if (press || pressed) {
				event.preventDefault();
			}
		});

		peek.addEventListener('error', hide);
		label.addEventListener('pointerenter', (event) => {
			if (event.pointerType === 'mouse') {
				show();
			}
		});
		label.addEventListener('pointerleave', hide);
		label.addEventListener('focusin', (event) => {
			if (event.target.matches(':focus-visible')) {
				show();
			}
		});
		label.addEventListener('focusout', hide);

		return peek;
	}

	// An open order's stage (Eric, 2026-11-26): Unpaid until the Pix
	// arrives; then Separating while any card is not ticked, and Ready once
	// every card is, to hand over. The ticks decide it, so a tick moves the
	// order with no button of its own.
	const allTicked = (order, ticked = orderChecks(order.code)) => (order.items || []).every((item) => ticked.has(item.listing_id));
	const orderStage = (order) => {
		if (order.status === 'pending') {
			return 'pending';
		}

		return allTicked(order) ? 'ready' : 'separating';
	};
	const URGENT_MS = 2 * 60 * 60 * 1000;
	const urgent = (order) => order.status === 'pending' && Date.parse(order.reserved_until) - Date.now() < URGENT_MS;
	const stageText = (order) => ({
		// Under 2 hours, the time leads, and a receipt says to check the Pix
		// (design review F11).
		pending: () => (urgent(order)
			? `${timeLeft(order.reserved_until)}${order.receipt_path ? ' · Receipt sent: check the Pix' : ' · Waiting for payment'}`
			: `Waiting for payment · ${timeLeft(order.reserved_until)}`),
		ready: () => 'Paid · ready to hand over',
		separating: () => 'Paid · separating',
	})[orderStage(order)]();

	// The order's checklist (Eric, 2026-11-26): a box beside each card to
	// tick it off while putting the order together, so the right cards go
	// out, and a line counting the ticks. Ticking redraws only that line,
	// the order's state, and the filter's counts, so the box keeps its focus;
	// the order stays under this filter until it changes (heldInView).
	function orderChecklist(order, onTick) {
		const ticked = orderChecks(order.code);
		const items = order.items || [];
		const progress = h('p', {'aria-live': 'polite', class: 'shop-order-progress', hidden: !items.length});
		const drawProgress = () => {
			const count = items.filter((item) => ticked.has(item.listing_id)).length;
			const done = Boolean(items.length) && count === items.length;
			const unsaved = unsavedChecks(order.code);
			const line = done
				? (items.length === 1 ? 'Separated' : `All ${formatCount(items.length)} separated`)
				: `Separated ${formatCount(count)} of ${formatCount(items.length)}`;

			// Ticks the server has not taken yet show on this device only.
			progress.textContent = unsaved ? `${line} · ${formatCount(unsaved)} not saved yet` : line;
			progress.classList.toggle('shop-order-progress-done', done);
			progress.classList.toggle('shop-order-progress-unsaved', Boolean(unsaved));
		};

		progressDrawers.set(order.code, drawProgress);
		const check = (item, text) => {
			const on = ticked.has(item.listing_id);
			// The stage's own word (design review F2): "Checked" is Check
			// spares' word for a verified copy.
			const box = h('input', {'aria-label': `Separated: ${text}`, checked: on, onchange: (event) => {
				const value = event.target.checked;

				if (value) {
					ticked.add(item.listing_id);
				}
				else {
					ticked.delete(item.listing_id);
				}

				setOrderCheck(order.code, item.listing_id, value);
				label.classList.toggle('shop-order-checked', value);
				drawProgress();
				onTick();
			}, type: 'checkbox'});
			const label = h('label', {class: `shop-order-check${on ? ' shop-order-checked' : ''}`}, box, h('span', null, text));

			label.append(peekNode(item, label));

			return label;
		};

		drawProgress();

		return {check, progress};
	}

	function orderCard(order) {
		const {logged, missing} = orderCheck(order, orderDoc);
		const state = h('p', {class: `shop-order-state${urgent(order) ? ' shop-order-urgent' : ''}`}, stageText(order));
		const checklist = orderChecklist(order, () => {
			holdInView(order.code);
			state.textContent = stageText(order);
			drawOrderCounts();
		});
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
		else if (question === 'delivered') {
			const left = (order.items || []).filter((item) => !orderChecks(order.code).has(item.listing_id));
			const unticked = left.length;
			const named = unticked === 1 ? [left[0].name, left[0].number ? `#${left[0].number}` : null].filter(Boolean).join(' ') : '';
			// Back is focused, so a stray tap never delivers (design review P9).
			const back = h('button', {disabled: busy, id: `shop-deliver-back-${order.code}`, onclick: () => ask(null), type: 'button'}, 'Back');

			actions = [
				h('p', {class: 'shop-order-ask'}, `${named ? `${named} is` : plural(unticked, 'card is', 'cards are')} not separated yet. Deliver anyway?`),
				h('button', {class: 'primary', disabled: busy, onclick: () => delivered(order), type: 'button'}, 'Deliver anyway'),
				back,
			];
			queueMicrotask(() => back.isConnected && back.focus());
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
				h('button', {class: logged ? 'primary' : '', disabled: busy, onclick: () => (allTicked(order) ? delivered(order) : ask('delivered')), type: 'button'}, 'Delivered'),
			];
		}

		return h('article', {class: `card shop-order shop-order-${order.status}`, 'data-code': order.code, id: `order-${order.code}`},
			h('h4', {class: 'shop-order-head'}, `${order.code} · ${order.name}`),
			h('p', {class: 'shop-order-who'},
				h('a', {href: `tel:${String(order.phone).replace(/[^\d+]/g, '')}`}, order.phone),
				order.note ? ` · ${order.note}` : null),
			state,
			order.receipt_path
				? h('p', {class: 'shop-order-receipt'}, h('button', {class: 'small', onclick: () => openReceipt(order), type: 'button'}, 'Open receipt'))
				: (pending ? h('p', {class: 'muted shop-order-receipt'}, 'No receipt yet') : null),
			orderItemsNode(order.items, itemLine, checklist.check),
			checklist.progress,
			h('p', {class: 'shop-order-total'}, `Total ${formatBrl(order.total)}`),
			missing.length && pending
				? h('p', {class: 'status shop-order-missing', role: 'alert'}, `${plural(missing.length, 'copy', 'copies')} of this order ${missing.length === 1 ? 'is' : 'are'} no longer in your cards. Cancel the order, or add ${missing.length === 1 ? 'it' : 'them'} back.`)
				: null,
			!pending && !logged ? h('p', {class: 'status shop-order-missing'}, 'Paid, but the sale is not in your Trades yet.') : null,
			h('div', {class: 'shop-order-actions'}, ...actions.filter(Boolean))
		);
	}

	// The day an order was handed over, on this phone's calendar.
	const deliveredDay = (stamp) => {
		const when = new Date(stamp);

		if (Number.isNaN(when.getTime())) {
			return null;
		}

		const pad = (n) => String(n).padStart(2, '0');

		return shortDate(`${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`);
	};

	// A delivered order (v122): what went out, to whom, and when, with no
	// checklist and nothing left to do but log a sale that is missing.
	function deliveredCard(order) {
		const {logged} = orderCheck(order, orderDoc);
		const day = deliveredDay(order.delivered_at);

		return h('article', {class: 'card shop-order shop-order-delivered', 'data-code': order.code, id: `order-${order.code}`},
			h('h4', {class: 'shop-order-head'}, `${order.code} · ${order.name}`),
			h('p', {class: 'shop-order-who'},
				h('a', {href: `tel:${String(order.phone).replace(/[^\d+]/g, '')}`}, order.phone),
				order.note ? ` · ${order.note}` : null),
			h('p', {class: 'shop-order-state'}, day ? `Delivered ${day}` : 'Delivered'),
			orderItemsNode(order.items, itemLine),
			h('p', {class: 'shop-order-total'}, `Total ${formatBrl(order.total)}`),
			logged ? null : h('p', {class: 'status shop-order-missing'}, 'Delivered, but the sale is not in your Trades yet.'),
			logged ? null : h('div', {class: 'shop-order-actions'},
				h('button', {class: 'primary', disabled: working.has(order.code), onclick: () => logSale(order), type: 'button'}, 'Log the sale'))
		);
	}

	// Which orders the list shows (Eric, 2026-11-26): the four stages an
	// order goes through, each with its count. No All: the four cover every
	// order, and a fifth segment does not fit a phone.
	const ORDER_FILTERS = ['pending', 'separating', 'ready', 'delivered'];
	const ORDER_FILTER_KEY = 'cardTracker.shopOrderFilter';
	let orderFilter = (() => {
		try {
			const kept = sessionStorage.getItem(ORDER_FILTER_KEY);

			// v118's Ready (paid, not delivered) is now Separating or Ready.
			if (kept === 'paid') {
				return 'separating';
			}

			return ORDER_FILTERS.includes(kept) ? kept : 'pending';
		}
		catch {
			return 'pending';
		}
	})();

	// Keeps an order under this filter for ORDER_MOVE_MS more, then lets it
	// go where its stage puts it; a later tick or payment starts the time
	// again.
	function holdInView(code) {
		clearTimeout(heldTimers.get(code));
		heldInView.add(code);
		heldTimers.set(code, setTimeout(() => {
			heldTimers.delete(code);
			heldInView.delete(code);

			if (alive) {
				drawOrders();
			}
		}, ORDER_MOVE_MS));
	}

	function releaseHeld() {
		for (const timer of heldTimers.values()) {
			clearTimeout(timer);
		}

		heldTimers.clear();
		heldInView.clear();
	}

	function setOrderFilter(value) {
		orderFilter = value;
		releaseHeld();

		try {
			sessionStorage.setItem(ORDER_FILTER_KEY, value);
		}
		catch {
			// Not kept past this screen.
		}

		drawOrders();
	}

	// One control, kept across redraws, with its counts (js/dom.js
	// segmentCounts, as All, Owned, Missing elsewhere).
	const ORDER_FILTER_NAMES = {delivered: 'Delivered', pending: 'Unpaid', ready: 'Ready', separating: 'Separating'};
	const orderFilterNode = h('div', {'aria-label': 'Show orders', class: 'segmented shop-order-filter', id: 'shop-order-filter', role: 'radiogroup'},
		ORDER_FILTERS.map((value) => h('label', null,
			h('input', {checked: value === orderFilter, id: `shop-order-filter-${value}`, name: 'shop-order-filter', onchange: () => setOrderFilter(value), type: 'radio', value}),
			h('span', {'data-label': ORDER_FILTER_NAMES[value]}, ORDER_FILTER_NAMES[value]))));

	function orderCounts() {
		const counts = {delivered: deliveredList.length, pending: 0, ready: 0, separating: 0};

		for (const order of orders) {
			counts[orderStage(order)] += 1;
		}

		return counts;
	}

	function drawOrderCounts() {
		segmentCounts(orderFilterNode, orderCounts());
	}

	function drawOrders() {
		ordersBox.hidden = false;
		announceOrders(orders);
		tabLabel('orders', orders.length);

		const shown = orderFilter === 'delivered'
			? deliveredList
			: orders.filter((order) => orderStage(order) === orderFilter || heldInView.has(order.code));

		// Unpaid: receipt sent first, then the least time left (design
		// review F11).
		if (orderFilter === 'pending') {
			shown.sort((a, b) => Number(Boolean(b.receipt_path)) - Number(Boolean(a.receipt_path))
				|| String(a.reserved_until).localeCompare(String(b.reserved_until)));
		}
		// The radios are drawn anew with the list; the one that had the
		// focus gets it back.
		const hadFocus = orderFilterNode.contains(document.activeElement);

		for (const input of orderFilterNode.querySelectorAll('input')) {
			input.checked = input.value === orderFilter;
		}

		const none = {
			delivered: deliveredError
				? deliveredErrorText(deliveredError)
				: `Nothing delivered in the last ${formatCount(DELIVERED_DAYS)} days.`,
			pending: 'Nothing waiting for payment.',
			ready: 'Nothing ready: no paid order has every card separated.',
			separating: 'Nothing to separate: every paid order has its cards separated.',
		};

		progressDrawers.clear();
		ordersBox.replaceChildren(...[
			h('h3', {id: 'shop-orders-title'}, orders.length ? `Orders (${formatCount(orders.length)})` : 'Orders'),
			orderFilterNode,
			shown.length
				? null
				: h('p', {class: 'muted', id: 'shop-orders-none'}, none[orderFilter]),
			...shown.map(orderFilter === 'delivered' ? deliveredCard : orderCard),
		].filter(Boolean));

		drawOrderCounts();

		if (hadFocus) {
			const checked = ordersBox.querySelector('input[name="shop-order-filter"]:checked');

			if (checked) {
				checked.focus();
			}
		}
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
				holdInView(order.code);
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

	// A new order or receipt heard by the header's read (js/order-alerts.js):
	// the list reads again, and Publish reads store_sync, so the order's
	// cards show Reserved by an order at once rather than at the next
	// Publish. An order the list already has is not read again.
	const ordersOnNew = (event) => {
		const detail = event.detail || {};
		const known = new Set(orders.map((order) => order.code));
		const fresh = (detail.orders || []).some((order) => !known.has(order.code));
		const receipt = (detail.receipts || []).some((order) => !(orders.find((each) => each.code === order.code) || {}).receipt_path);

		if (fresh || receipt) {
			loadOrders();
		}

		if ((detail.orders || []).length) {
			publish();
		}
	};

	window.addEventListener(NEW_ORDERS_EVENT, ordersOnNew);

	// The ticks reached the server, or wait on this device: the progress
	// lines say so. A tick the server refused is undone already
	// (js/store-orders.js); say why, and read the orders again, since the
	// usual reason is an order no longer open.
	const ordersOnChecks = (event) => {
		const refusedTicks = (event.detail && event.detail.refused) || [];

		for (const draw of progressDrawers.values()) {
			draw();
		}

		if (refusedTicks.length) {
			const codes = [...new Set(refusedTicks.map((entry) => entry.code))].join(', ');
			const reason = refusedTicks[0].message;

			toast(`A check in ${codes} was not saved and is undone.${reason ? ` ${reason}` : ''}`);
			loadOrders();
		}
	};

	window.addEventListener(ORDER_CHECKS_EVENT, ordersOnChecks);

	// Back online, live listings catch up at once (QA shop 17).
	const onOnline = () => {
		if (alive) {
			publish();
		}
	};

	window.addEventListener('online', onOnline);

	// Another device's change (a star, Not for sale, a new price) reaches
	// this screen: its groups and the pending count follow it (QA shop 1 to
	// 3), and a change that touches a live listing syncs.
	let changeTimer = null;
	const stopChanges = onChange((doc, {source} = {}) => {
		if (source === 'local' || !alive) {
			return;
		}

		clearTimeout(changeTimer);
		changeTimer = setTimeout(() => {
			if (alive && !saving) {
				reload().then(() => publish()).catch(() => {});
			}
		}, 400);
	});

	async function reload() {
		// loadOnePrintings first, so what the Shop publishes never depends on
		// how fast the card index read (js/wishlist.js copyFinishKey).
		const [cards, doc, read] = await Promise.all([listCards(), loadDocument(), loadOnePrintings()]);

		if (!alive) {
			return;
		}

		indexRead = read !== false;
		groups = shopGroups(cards, {away: awayIds, codeOf: printedCode, held: heldCopies(doc)});
		groups.forEach(describe);
		// Opened from its address, the Shop can draw before the species
		// names are read; the searches take the English names when they are.
		loadedSpeciesNames(() => {
			if (!alive) {
				return;
			}

			for (const group of groups) {
				group.search = searchText(group);
			}

			if (query) {
				drawList();
			}
		});
		groups.sort((a, b) => (a.info.setName || '').localeCompare(b.info.setName || '')
			|| compareNumbers(a.info.number || '', b.info.number || '')
			|| a.language.localeCompare(b.language)
			// A card's finishes sit together, by name.
			|| (finishName(groupCopy(a), a) || '').localeCompare(finishName(groupCopy(b), b) || ''));
		// A draft for a card that is no longer a spare, or that now says what
		// is saved (another phone saved it), is dropped.
		for (const [key, text] of drafts) {
			const group = groups.find((one) => one.key === key);
			const typed = parseSalePrice(text);

			if (!group || (!typed.error && typed.value === group.price)) {
				drafts.delete(key);
			}
		}

		keepDrafts(drafts);

		if (!showChosen) {
			show = groups.some((group) => group.price === null) ? 'unpriced' : 'all';

			for (const input of filter.querySelectorAll('input[name="shop-filter"]')) {
				input.checked = input.value === show;
			}
		}

		drawSummary();
		drawSelects();
		drawList();
		drawSaveBar();
	}

	// A record saved before TCGdex had the card's picture (a new set is
	// listed first and pictured later, as CRI was) keeps no image for good,
	// since nothing reads a record again once the index has it: the row has
	// no thumbnail and the listing no picture. The sets of the cards with
	// none are read again once a visit (js/catalog.js setDetailAgain), and
	// the pictures found go into the index.
	async function refreshPictures() {
		const due = new Map();

		for (const group of groups) {
			const setId = group.catalog === 'international' && !group.publishInfo.image ? setIdOfCard(group.card_id) : null;

			if (setId && group.language) {
				due.set(`${group.language}|${setId}`, {lang: group.language, setId});
			}
		}

		const records = [];

		for (const {lang, setId} of due.values()) {
			if (!alive) {
				return;
			}

			const set = await importApi.setDetailAgain(lang, setId).catch(() => null);

			for (const card of (set && set.cards) || []) {
				if (card.image && groups.some((group) => group.card_id === card.id && group.language === lang)) {
					records.push({catalog: 'international', id: card.id, localizations: {[lang]: {image: card.image, lang, name: card.name, set_name: set.name || null}}});
				}
			}
		}

		if (records.length && alive) {
			index = await saveToCardIndex(records);
			await reload();
		}
	}

	// The full records of cards never read before, for their suggestions:
	// read one at a time, the shown rows first, stopping after a few
	// failures in a row.
	async function fillRecords() {
		const order = shown().concat(groups).map(groupCopy);
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

					const read = groups.filter((group) => group.catalog === 'international' && group.card_id === item.cardId);

					patchSuggestions(read.map((group) => group.key));
					refreshFinishes(read);
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

		// Cards this phone has no catalog record for yet (a set new since
		// My Cards last filled them, or a Shop opened on a computer) would
		// show a bare ID with no name, set, or picture, so a search for the
		// name misses them and they publish with no picture: read them now,
		// as a binder does (js/binders-view.js fillRecords).
		const filledIndex = await fillCardRecords(groups.map((group) => ({catalog: group.catalog, cardId: group.card_id})), index, () => alive).catch(() => null);

		if (filledIndex && alive) {
			index = filledIndex;
			await reload();
		}

		await refreshPictures();

		saved = await savedCardRecords(groups.map(groupCopy)).catch(() => new Map());

		if (!alive) {
			return;
		}

		groups.forEach(noteFinish);
		drawSelects();
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
		stopChanges();
		clearTimeout(changeTimer);
		window.removeEventListener('online', onOnline);
		stopOwner();
		kits.stop();
		consignment.stop();
		window.removeEventListener('beforeunload', warnUnsaved);
		document.removeEventListener('visibilitychange', ordersOnReturn);
		window.removeEventListener(NEW_ORDERS_EVENT, ordersOnNew);
		window.removeEventListener(ORDER_CHECKS_EVENT, ordersOnChecks);
		releaseHeld();

		if (stopWaiting) {
			stopWaiting();
			stopWaiting = null;
		}
	};
}

// What anyone but the family's owner sees at the shop address: the Shop
// prices the owner's spares and takes HOTARU's orders, and the server lets
// nobody else do either (js/shop-owner.js). Signed out, and while the
// answer is not known, the Shop draws as before; an answer of "not the
// owner" that arrives later takes its place.
function notOwnerNotice(root) {
	root.replaceChildren(
		h('div', {class: 'view-head'}, h('h2', null, 'Shop')),
		h('div', {class: 'card empty-state', id: 'shop-not-owner'},
			h('p', {class: 'big'}, 'The Shop is for the family\'s owner'),
			h('p', {class: 'muted'}, 'It prices the owner\'s spares for their HOTARU shop. Your spares stay in Spares, ready to trade.'),
			h('a', {class: 'button', 'data-link': 'trade', href: `${BASE}trade`}, 'Open Spares')
		)
	);
}

export function shopScreen(root) {
	if (shopOwnerKnown() === false) {
		notOwnerNotice(root);

		return () => {};
	}

	let alive = true;
	let stop = shopView(root);

	if (currentUser()) {
		checkShopOwner().then((owner) => {
			if (alive && owner === false) {
				stop();
				stop = () => {};
				notOwnerNotice(root);
			}
		});
	}

	return () => {
		alive = false;
		stop();
	};
}

export const shopRoutes = [
	{kind: 'shop', pattern: /^shop$/, render: shopScreen, tab: null, title: 'Shop | Card Tracker'},
];

export const shopAccountViews = [shopScreen];
