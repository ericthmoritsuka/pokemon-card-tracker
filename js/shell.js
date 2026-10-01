// The app shell around every screen (plans/design-review.md sections 2 and
// 3, "Shared Header"): the avatar that opens Profile, the "Mine" switcher and
// family view-only mode, the offline strip, toasts, and the five tabs.
//
// Family view-only mode is a lens on a family member's data. It starts on a
// family route (family/<id>, family/<id>/binders, family/<id>/lists,
// wishlist/<id>), stays on while the person browses Sets or opens a card, and
// ends with Done, the "Mine" switcher, the avatar (Profile), or Scan, which
// always saves to you. It lives in memory only, never in storage, so a cold
// start always opens your own cards.

import {accountLabel, currentUser, onUser} from './auth.js';
import {spriteUrl} from './checklists.js';
import {BASE, go, h} from './dom.js';
import {familyMembers} from './family.js';
import {favoritePokemon, onSettings} from './settings.js';
import {onSyncStatus, syncStatus} from './sync.js';

const formatCount = (n) => Number(n).toLocaleString('en-US');

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

let lens = null;
let members = [];
let current = {kind: null, params: {}, route: null};

// ------------------------------------------------------------- toasts

// A short message above the tab bar. It floats over the page, so nothing
// shifts when it comes and goes. timeout 0 keeps it until it is closed.
export function toast(message, {action = null, actionLabel = null, timeout = 5000} = {}) {
	const box = document.getElementById('toasts');

	if (!box) {
		return null;
	}

	const item = h('div', {class: 'toast', role: 'status'}, h('span', {class: 'toast-text'}, message));
	const close = () => item.remove();

	if (actionLabel && action) {
		item.append(h('button', {class: 'small', onclick: () => {
			close();
			action();
		}, type: 'button'}, actionLabel));
	}

	item.append(h('button', {'aria-label': 'Dismiss', class: 'toast-close', onclick: close, type: 'button'}, '×'));
	box.append(item);

	if (timeout) {
		setTimeout(close, timeout);
	}

	return item;
}

// ------------------------------------------------------------ the lens

export const lensMember = () => lens;

const kindOf = (kind) => (KINDS[kind] ? kind : null);

function memberLabel(userId) {
	const member = members.find((item) => item.user_id === userId);

	return member ? member.name : null;
}

function exitLens() {
	const kind = kindOf(current.kind);

	lens = null;

	if (current.params.userId && kind) {
		go(KINDS[kind].mine);

		return;
	}

	drawLens();
	drawTabs();
	drawSwitcher();
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

function pickOwner(userId) {
	const sheet = document.getElementById('owner-sheet');

	if (sheet && sheet.open) {
		sheet.close();
	}

	const kind = kindOf(current.kind) || kindOf(LENS_TABS[current.route && current.route.tab]) || 'cards';

	if (!userId) {
		exitLens();

		return;
	}

	lens = {name: memberLabel(userId), userId};
	go(KINDS[kind].member(encodeURIComponent(userId)));
}

function openOwnerSheet() {
	const sheet = ownerSheet();
	const selected = lens ? lens.userId : '';
	const option = (userId, name, text) => h('li', null, h('button', {
		'aria-current': userId === selected ? 'true' : null,
		class: 'owner-option',
		'data-member': userId,
		onclick: () => pickOwner(userId),
		type: 'button',
	},
	h('span', {'aria-hidden': 'true', class: 'owner-initial'}, initialOf(name)),
	h('span', {class: 'owner-name'}, text),
	userId === selected ? h('span', {class: 'owner-state'}, 'Showing') : null));

	sheet.replaceChildren(
		h('div', {class: 'sheet-head'},
			h('h2', {id: 'owner-sheet-title'}, 'Whose cards'),
			h('button', {class: 'small', id: 'owner-sheet-close', onclick: () => sheet.close(), type: 'button'}, 'Close')
		),
		h('p', {class: 'muted'}, 'A family member\'s cards, binders, and lists open view only. Scanning always saves to you.'),
		h('ul', {class: 'owner-list'},
			option('', 'Me', 'Mine'),
			...members.map((member) => option(member.user_id, member.name, `${member.name}'s`))
		)
	);
	sheet.showModal();
}

function drawSwitcher() {
	const button = document.getElementById('owner-switch');

	if (!button) {
		return;
	}

	const tab = current.route ? current.route.tab : null;
	const show = Boolean(currentUser()) && members.length > 0 && (Boolean(lens) || SWITCHER_TABS.has(tab));
	const text = lens ? `${lens.name || 'Family member'}'s` : 'Mine';

	button.hidden = !show;
	button.textContent = text;
	button.setAttribute('aria-label', `Whose cards: ${text}. Change`);
	button.classList.toggle('lensed', Boolean(lens));
}

async function loadMembers() {
	const user = currentUser();

	members = user ? await familyMembers().catch(() => []) : [];

	if (lens && !lens.name) {
		lens = {...lens, name: memberLabel(lens.userId)};
		drawLens();
	}

	drawSwitcher();
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

	if (lens && !lens.name) {
		loadMembers();
	}
}

// Once, from app.js.
export function startShell() {
	const button = document.getElementById('owner-switch');

	if (button) {
		button.addEventListener('click', openOwnerSheet);
	}

	onUser(() => {
		drawAccount();
		loadMembers();
	});
	onSettings(() => drawAccount());
	onSyncStatus(drawOffline);
	window.addEventListener('online', () => drawOffline());
	window.addEventListener('offline', () => drawOffline());

	drawAccount();
	drawOffline();
}
