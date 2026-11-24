// The app shell around every screen (plans/design-review.md sections 2 and
// 3, "Shared Header"): the avatar that opens Profile, the "Mine" switcher and
// family view-only mode, Shop for the family's owner (js/shop-owner.js), the
// offline strip, toasts, and the five tabs, with a count dot on Scan while
// the scanner's draft tray holds unsaved cards.
//
// Family view-only mode is a lens on a family member's data. It starts on a
// family route (family/<id>, family/<id>/binders, family/<id>/lists,
// wishlist/<id>), stays on while the person browses Sets or opens a card, and
// ends with Done, the "Mine" switcher, the avatar (Profile), or Scan, which
// always saves to you. It lives in memory, so a cold start always opens your
// own cards. The one exception is the reload that switches to a new version
// (js/auto-update.js), which must not drop the lens and show your own cards
// as if they were the member's: keepLensForSwitch puts it in sessionStorage
// just before that reload, and the next load takes it back once, within
// KEPT_MS.
//
// The switcher and its "Whose cards" sheet show each person's favorite
// Pokémon (DESIGN.md section 11, "Favorite Pokémon"): yours from your
// settings, a member's from the one field js/family.js reads of their
// document, and the first letter of the name when there is none or the
// sprite does not load.

import {accountLabel, currentUser, onUser} from './auth.js';
import {spriteUrl} from './checklists.js';
import {BASE, go, h} from './dom.js';
import {familyFavorites, familyMembers, knownFavorites} from './family.js';
import {formatCount} from './format.js';
import {DRAFT_EVENT, draftCount} from './scan/draft.js';
import {favoritePokemon, onSettings} from './settings.js';
import {openDialogSheet} from './sheet.js';
import {checkShopOwner, shopOwnerKnown} from './shop-owner.js';
import {onSyncStatus, syncStatus} from './sync.js';

// What each kind of screen is called on the view-only strip, and where it
// is for you and for a member.
const KINDS = {
	binders: {member: (id) => `family/${id}/binders`, mine: 'binders', noun: 'binders'},
	cards: {member: (id) => `family/${id}`, mine: 'cards', noun: 'cards'},
	lists: {member: (id) => `family/${id}/lists`, mine: 'lists', noun: 'lists'},
	wishlist: {member: (id) => `wishlist/${id}`, mine: 'wishlist', noun: 'wishlist'},
};

// The tabs that follow a member while the lens is on, and the kind each
// opens.
const LENS_TABS = {binders: 'binders', cards: 'cards', lists: 'lists'};

// Screens that show the "Mine" switcher.
const SWITCHER_TABS = new Set(['binders', 'cards', 'lists']);

// The lens kept for the reload that switches versions, and how long the
// next load may take it back.
export const LENS_KEPT_KEY = 'cardTracker.switchLens';
const KEPT_MS = 60 * 1000;

// The lens the switch kept, once, or null.
function keptLens() {
	try {
		const kept = JSON.parse(sessionStorage.getItem(LENS_KEPT_KEY));

		sessionStorage.removeItem(LENS_KEPT_KEY);

		if (kept && typeof kept.userId === 'string' && kept.userId && Math.abs(Date.now() - kept.at) < KEPT_MS) {
			return {name: typeof kept.name === 'string' ? kept.name : null, userId: kept.userId};
		}
	}
	catch {
		// No sessionStorage, or nothing readable kept.
	}

	return null;
}

let lens = keptLens();
let members = [];
let current = {kind: null, params: {}, route: null};
// Favorite Pokémon: yours, and the members' by user_id.
let myFavorite = null;
let favorites = new Map();
let ownerHandle = null;

// ------------------------------------------------------------- toasts

// At most this many toasts show at once; a new one beyond it takes the
// oldest away, so a run of saves never covers the screen (Eric,
// 2026-11-24: saving prices one by one stacked a toast for each).
export const MAX_TOASTS = 3;

// A short message above the tab bar. It floats over the page, so nothing
// shifts when it comes and goes. timeout 0 keeps it until it is closed. A
// key replaces the toast shown with the same key, so a screen that toasts
// each save shows only its latest.
export function toast(message, {action = null, actionLabel = null, key = null, timeout = 5000} = {}) {
	const box = document.getElementById('toasts');

	if (!box) {
		return null;
	}

	if (key) {
		for (const old of box.querySelectorAll('.toast')) {
			if (old.dataset.toastKey === key) {
				old.remove();
			}
		}
	}

	const item = h('div', {class: 'toast', 'data-toast-key': key, role: 'status'}, h('span', {class: 'toast-text'}, message));
	const close = () => item.remove();

	if (actionLabel && action) {
		item.append(h('button', {class: 'small', onclick: () => {
			close();
			action();
		}, type: 'button'}, actionLabel));
	}

	item.append(h('button', {'aria-label': 'Dismiss', class: 'toast-close', onclick: close, type: 'button'}, '×'));
	box.append(item);

	const shown = box.querySelectorAll('.toast');

	for (let i = 0; i < shown.length - MAX_TOASTS; i++) {
		shown[i].remove();
	}

	if (timeout) {
		setTimeout(close, timeout);
	}

	return item;
}

// ------------------------------------------------------------ the lens

export const lensMember = () => lens;

// Just before the reload that switches versions (js/auto-update.js).
export function keepLensForSwitch() {
	if (!lens) {
		return;
	}

	try {
		sessionStorage.setItem(LENS_KEPT_KEY, JSON.stringify({at: Date.now(), name: lens.name, userId: lens.userId}));
	}
	catch {
		// Without sessionStorage there is no automatic switch either.
	}
}

const kindOf = (kind) => (KINDS[kind] ? kind : null);

function memberLabel(userId) {
	const member = members.find((item) => item.user_id === userId);

	return member ? member.name : null;
}

// The route under the app's base, as go() takes it.
const routeHere = () => window.location.pathname.slice(BASE.length);

// Back to your own cards: a family route goes to your screen of the same
// kind, and a screen the lens only followed you to (Sets, a set, a card) is
// drawn again with your own cards.
function exitLens() {
	const kind = kindOf(current.kind);

	lens = null;
	go(current.params.userId && kind ? KINDS[kind].mine : routeHere());
}

function drawLens() {
	const slot = document.getElementById('shell-strips');
	const old = document.getElementById('family-strip');

	if (!lens) {
		if (old) {
			old.remove();
		}

		return;
	}

	const kind = kindOf(current.kind);
	const noun = kind ? KINDS[kind].noun : 'collection';
	const strip = old || h('div', {class: 'view-only', id: 'family-strip', role: 'status'});

	strip.replaceChildren(
		h('span', {class: 'view-only-text'}, `${lens.name || 'Family member'}'s ${noun}, view only`),
		h('button', {class: 'small view-only-done', id: 'family-done', onclick: exitLens, type: 'button'}, 'Done')
	);

	if (!old && slot) {
		slot.append(strip);
	}
}

// ------------------------------------------------------------- the tabs

function drawTabs() {
	for (const tab of document.querySelectorAll('.tabs a[data-tab]')) {
		const id = tab.dataset.tab;
		const kind = lens ? LENS_TABS[id] : null;
		const route = kind ? KINDS[kind].member(encodeURIComponent(lens.userId)) : id;

		tab.dataset.link = route;
		tab.href = BASE + route;

		if (current.route && id === current.route.tab) {
			tab.setAttribute('aria-current', 'page');
		}
		else {
			tab.removeAttribute('aria-current');
		}
	}
}

// Unsaved tray cards (plans/design-review.md, "A draft resumes"): a count
// dot on the Scan disc, and the count in the tab's name, so a draft left on
// the phone is not forgotten; and a binder page Already mine waiting to be
// placed. js/scan/draft.js says both on every save (draftWaiting); at start
// they are read once from the draft itself.
function drawScanDot({count = 0, page = 0} = {}) {
	const tab = document.querySelector('.tabs a[data-tab="scan"]');
	const disc = tab && tab.querySelector('.scan-disc');

	if (!disc) {
		return;
	}

	let dot = document.getElementById('scan-dot');

	if (!count && !page) {
		if (dot) {
			dot.remove();
		}

		tab.removeAttribute('aria-label');

		return;
	}

	if (!dot) {
		dot = h('span', {'aria-hidden': 'true', class: 'scan-dot', id: 'scan-dot'});
		disc.append(dot);
	}

	// The tray's cards, as the tray counts them; a binder page Already mine
	// and not placed is not in the tray, so it is not in the number: with
	// the tray empty the dot is there with no number, and says so to a
	// screen reader (a review, 2026-11-20).
	dot.textContent = !count ? '' : count > 99 ? '99+' : formatCount(count);

	const said = [count ? `${formatCount(count)} unsaved ${count === 1 ? 'card' : 'cards'} in the tray` : null, page ? 'a binder page to place' : null].filter(Boolean).join(' and ');

	tab.setAttribute('aria-label', `Scan, ${said}`);
}

// --------------------------------------------------- the "Mine" switcher

function ownerSheet() {
	let sheet = document.getElementById('owner-sheet');

	if (sheet) {
		return sheet;
	}

	sheet = h('dialog', {'aria-labelledby': 'owner-sheet-title', class: 'sheet owner-sheet', id: 'owner-sheet'});
	sheet.addEventListener('click', (event) => {
		if (event.target === sheet) {
			sheet.close();
		}
	});
	document.body.append(sheet);

	return sheet;
}

function initialOf(name) {
	return String(name || '?').trim().charAt(0).toUpperCase() || '?';
}

const favoriteOf = (userId) => (userId ? favorites.get(userId) || null : myFavorite);

// A person's favorite Pokémon sprite in a circle, or the first letter of
// their name when they have none or it does not load (offline, before the
// browser ever kept it).
function personMark(userId, name, size) {
	const n = favoriteOf(userId);
	const mark = h('span', {'aria-hidden': 'true', class: 'owner-initial', 'data-dex': n || null});

	if (!n) {
		mark.textContent = initialOf(name);

		return mark;
	}

	const img = h('img', {alt: '', class: 'owner-sprite', decoding: 'async', height: size, src: spriteUrl(n), width: size});

	img.addEventListener('error', () => {
		delete mark.dataset.dex;
		mark.textContent = initialOf(name);
	}, {once: true});
	mark.append(img);

	return mark;
}

function closeOwnerSheet() {
	const sheet = document.getElementById('owner-sheet');

	if (sheet && sheet.open) {
		sheet.close();
	}
}

// Picking a person changes route while the sheet is still open. go()
// (js/dom.js pushRoute) then makes the sheet's history entry the new
// screen's, and the route change closes the sheet (js/sheet.js), so one
// Back returns to the screen the sheet was opened over. Closing the sheet
// first would have its entry going away (history.go, a moment later) while
// the new route is pushed, leaving an extra entry behind it. A route to the
// address already shown draws that screen again, and the sheet's entry is
// taken away as for any close.
function pickOwner(userId) {
	const selected = lens ? lens.userId : '';

	if (userId === selected) {
		closeOwnerSheet();

		return;
	}

	if (!userId) {
		exitLens();

		return;
	}

	const kind = kindOf(current.kind) || kindOf(LENS_TABS[current.route && current.route.tab]) || 'cards';

	lens = {name: memberLabel(userId), userId};
	go(KINDS[kind].member(encodeURIComponent(userId)));
}

function ownerOptions() {
	const selected = lens ? lens.userId : '';
	const me = currentUser();
	const option = (userId, name, text) => h('li', null, h('button', {
		'aria-current': userId === selected ? 'true' : null,
		class: 'owner-option',
		'data-member': userId,
		onclick: () => pickOwner(userId),
		type: 'button',
	},
	personMark(userId, name, 36),
	h('span', {class: 'owner-name'}, text),
	userId === selected ? h('span', {class: 'owner-state'}, 'Showing') : null));

	return [
		option('', me ? me.email : 'Me', 'Mine'),
		...members.map((member) => option(member.user_id, member.name, `${member.name}'s`)),
	];
}

function openOwnerSheet() {
	const sheet = ownerSheet();
	const list = h('ul', {class: 'owner-list'}, ownerOptions());

	sheet.replaceChildren(
		h('div', {class: 'sheet-head'},
			h('h2', {id: 'owner-sheet-title'}, 'Whose cards'),
			h('button', {class: 'small', id: 'owner-sheet-close', onclick: () => sheet.close(), type: 'button'}, 'Close')
		),
		h('p', {class: 'muted'}, 'A family member\'s cards, binders, and lists open view only. Scanning always saves to you.'),
		list
	);

	// Back closes the sheet and stays on the screen (js/sheet.js).
	if (!ownerHandle) {
		ownerHandle = openDialogSheet(sheet, {onClose: () => {
			ownerHandle = null;
		}});
	}

	// Favorites that arrive while the sheet is open are drawn at once.
	loadFavorites().then((changed) => {
		if (changed && sheet.open && list.isConnected) {
			list.replaceChildren(...ownerOptions());
		}
	});
}

function drawSwitcher() {
	const button = document.getElementById('owner-switch');

	if (!button) {
		return;
	}

	const tab = current.route ? current.route.tab : null;
	const show = Boolean(currentUser()) && members.length > 0 && (Boolean(lens) || SWITCHER_TABS.has(tab));
	const text = lens ? `${lens.name || 'Family member'}'s` : 'Mine';
	const n = favoriteOf(lens ? lens.userId : '');
	const shown = button.querySelector('.owner-switch-sprite');

	button.hidden = !show;
	button.setAttribute('aria-label', `Whose cards: ${text}. Change`);
	button.classList.toggle('lensed', Boolean(lens));

	if (!n) {
		button.textContent = text;

		return;
	}

	if (shown && shown.dataset.dex === String(n)) {
		button.lastChild.textContent = text;

		return;
	}

	// A small sprite before the words; it steps aside if it cannot load.
	const img = h('img', {
		alt: '',
		class: 'owner-switch-sprite',
		'data-dex': String(n),
		decoding: 'async',
		height: 26,
		src: spriteUrl(n),
		style: 'margin: -6px 4px -4px -8px; vertical-align: middle',
		width: 26,
	});

	img.addEventListener('error', () => img.remove(), {once: true});
	button.replaceChildren(img, h('span', {class: 'owner-switch-text'}, text));
}

// Your favorite and the members' (js/family.js): the ones saved on the
// phone at once, then the server's once a visit. Resolves true when any
// changed.
async function loadFavorites() {
	const before = JSON.stringify([myFavorite, [...favorites]]);
	const ids = members.map((member) => member.user_id);

	myFavorite = await favoritePokemon().catch(() => null);
	favorites = new Map([...knownFavorites(ids), ...favorites]);

	if (ids.length) {
		favorites = await familyFavorites(ids).catch(() => favorites);
	}

	const changed = JSON.stringify([myFavorite, [...favorites]]) !== before;

	if (changed) {
		drawSwitcher();
	}

	return changed;
}

async function loadMembers() {
	const user = currentUser();

	members = user ? await familyMembers().catch(() => []) : [];

	if (lens && !lens.name) {
		lens = {...lens, name: memberLabel(lens.userId)};
		drawLens();
	}

	drawSwitcher();

	if (members.length) {
		loadFavorites();
	}
}

// ------------------------------------------------------------ the avatar

// Signed in: the favorite Pokémon's sprite, or the first letter of the email,
// opening Profile. Signed out: "Sign in", opening Profile with the sign-in
// panel at the top.
async function drawAccount() {
	const account = document.getElementById('account');
	const user = currentUser();

	if (!account) {
		return;
	}

	account.dataset.link = 'profile';
	account.href = `${BASE}profile`;

	if (!user) {
		account.className = 'account';
		account.removeAttribute('aria-label');
		account.textContent = 'Sign in';

		return;
	}

	const n = await favoritePokemon().catch(() => null);

	if (currentUser() !== user) {
		return;
	}

	account.className = n ? 'account avatar avatar-sprite' : 'account avatar';
	account.setAttribute('aria-label', `Profile, signed in as ${accountLabel(user.email)}`);

	if (n) {
		const img = h('img', {alt: '', class: 'avatar-img', decoding: 'async', height: 44, src: spriteUrl(n), width: 44});

		img.addEventListener('error', () => {
			account.classList.remove('avatar-sprite');
			account.textContent = initialOf(user.email);
		}, {once: true});
		account.replaceChildren(img);
	}
	else {
		account.textContent = initialOf(user.email);
	}
}

// ------------------------------------------------------------- Shop

// Shown to the family's owner only, at once from the answer kept on the
// phone, then as the server says.
function drawShopLink(owner = shopOwnerKnown()) {
	const link = document.getElementById('shop-link');

	if (!link) {
		return;
	}

	link.hidden = !(currentUser() && owner === true);

	if (current.route && current.route.kind === 'shop') {
		link.setAttribute('aria-current', 'page');
	}
	else {
		link.removeAttribute('aria-current');
	}
}

// The overview is read once a visit (js/sync.js), and read again after the
// first sign-in makes the family group, so asking on each synced status
// costs nothing until then.
async function loadShopOwner() {
	const user = currentUser();
	const owner = await checkShopOwner();

	if (currentUser() === user) {
		drawShopLink(owner);
	}
}

// ---------------------------------------------------- the offline strip

function drawOffline(status = syncStatus()) {
	const strip = document.getElementById('offline-strip');

	if (!strip) {
		return;
	}

	const offline = !navigator.onLine || status.phase === 'offline';
	const pending = status.pending || 0;

	strip.hidden = !offline;
	document.documentElement.classList.toggle('is-offline', offline);
	strip.textContent = pending
		? `Offline · ${formatCount(pending)} ${pending === 1 ? 'change' : 'changes'} waiting`
		: 'Offline · your cards are saved on this phone';
}

// ------------------------------------------------------------- the route

// app.js calls this before each screen draws. route carries tab, kind, and
// keepsLens; params.userId marks a family route.
export function shellRoute(route, params) {
	current = {kind: route.kind || route.tab, params: params || {}, route};

	if (params && params.userId && kindOf(current.kind)) {
		if (!lens || lens.userId !== params.userId) {
			lens = {name: memberLabel(params.userId), userId: params.userId};
		}
	}
	else if (!route.keepsLens) {
		lens = null;
	}

	drawLens();
	drawTabs();
	drawSwitcher();
	drawShopLink();

	if (lens && !lens.name) {
		loadMembers();
	}
}

// Once, from app.js.
// ------------------------------------------- focus clear of the bars

// The bars that can stick over the tab bar at the foot of a screen, and
// the room kept between one and a focused control.
const FOOT_BARS = '.actions, .bulk-bar, .bh, .bt';
const FOCUS_ROOM = 8;

// A focused control is never left under the header or the bars at the foot
// (WCAG 2.4.11 Focus Not Obscured; accessibility audit, 2026-11-20). html's
// scroll-padding (style.css) clears the header and the tab bar, with the
// header's height, strips included, kept in --shell-top-height. A bar that
// sticks over the tab bar (a form's actions, the bulk bar, the binder's
// hand) comes and goes with the screen, so it is cleared here, once the
// browser has scrolled the control into view.
function trackShellTop() {
	const top = document.getElementById('shell-top');

	if (!top || typeof ResizeObserver !== 'function') {
		return;
	}

	new ResizeObserver(() => {
		document.documentElement.style.setProperty('--shell-top-height', `${top.offsetHeight}px`);
	}).observe(top);
}

function keepFocusClear(event) {
	const target = event.target;

	if (!(target instanceof Element) || target.closest(`dialog, .shell-top, .tabs, ${FOOT_BARS}`)) {
		return;
	}

	requestAnimationFrame(() => {
		if (document.activeElement !== target) {
			return;
		}

		const tabs = document.querySelector('.tabs');
		let foot = tabs && tabs.offsetHeight ? tabs.getBoundingClientRect().top : window.innerHeight;
		const tabsTop = foot;

		for (const bar of document.querySelectorAll(FOOT_BARS)) {
			const position = getComputedStyle(bar).position;
			const box = bar.getBoundingClientRect();

			if ((position === 'fixed' || position === 'sticky') && box.height && box.top < foot && box.bottom >= tabsTop - 2) {
				foot = box.top;
			}
		}

		const box = target.getBoundingClientRect();
		const shellTop = document.getElementById('shell-top');
		const top = shellTop ? shellTop.getBoundingClientRect().bottom : 0;
		const under = box.bottom - (foot - FOCUS_ROOM);

		if (foot < tabsTop && under > 0) {
			// Never so far that its top goes under the header.
			window.scrollBy({behavior: 'instant', top: Math.min(under, Math.max(0, box.top - top - FOCUS_ROOM))});
		}
	});
}

export function startShell() {
	trackShellTop();
	document.addEventListener('focusin', keepFocusClear, true);

	const button = document.getElementById('owner-switch');

	if (button) {
		button.addEventListener('click', openOwnerSheet);
	}

	// "Sign in again" under the title opens the sign-in panel (the session
	// ended, js/auth.js); in every other phase a tap syncs (app.js).
	const status = document.getElementById('sync-status');

	if (status) {
		status.addEventListener('click', () => {
			if (syncStatus().phase === 'signin') {
				go('signin');
			}
		});
	}

	onUser(() => {
		favorites = new Map();
		myFavorite = null;
		closeOwnerSheet();
		drawAccount();
		drawShopLink();
		loadMembers();
		loadShopOwner();
	});
	onSettings(() => {
		drawAccount();

		if (members.length) {
			loadFavorites();
		}
	});
	onSyncStatus(drawOffline);
	onSyncStatus((status) => {
		if (status.phase === 'synced' && shopOwnerKnown() !== true) {
			loadShopOwner();
		}
	});
	window.addEventListener('online', () => drawOffline());
	window.addEventListener('offline', () => drawOffline());

	let draftSaved = false;

	window.addEventListener(DRAFT_EVENT, (event) => {
		draftSaved = true;
		drawScanDot(event.detail || {});
	});

	drawAccount();
	drawShopLink();
	loadShopOwner();
	drawOffline();
	// A save that lands first knows better than this read.
	draftCount().then((waiting) => {
		if (!draftSaved) {
			drawScanDot(waiting);
		}
	});
}
