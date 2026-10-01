// Card Tracker.
//
// A tiny router over real paths through the History API. Never a # hash:
// iOS drops the camera permission whenever the hash changes.
//
// Routes, under the /pokemon-card-tracker/ base:
//   cards                     My Cards, the home tab
//   import                    Import from monprice
//   sets                      Sets, by series, in the viewing language
//   sets/<lang>/<setId>       One set's cards
//   cards/<lang>/<cardId>     One card
//   check, camera, storage    Phone check and its two tests
//   signin, profile           Sign in, and the signed-in person's Profile
//   family/<userId>           A family member's My Cards, read only
//   lists, lists/<id>         Pokémon checklists, and one checklist
//   family/<userId>/lists[/<id>]  A family member's checklists, read only

import {profileView, setSignInNotice, signInView} from './js/account-views.js';
import {binderAccountViews, binderRoutes} from './js/binders-view.js';
import {completeInvite, completeSignIn, currentUser, onUser, restoreSession, signInErrorText, takeAuthReturn} from './js/auth.js';
import {familyCardsView, myCardsView} from './js/cards-view.js';
import {cardView, setView, setsView} from './js/catalog-views.js';
import {isLanguage} from './js/catalog.js';
import {checklistView, checklistsView, familyChecklistView, familyChecklistsView} from './js/checklists-view.js';
import {BASE, go, h, showError} from './js/dom.js';
import {importView} from './js/import-view.js';
import {cameraView, phoneCheckView, storageView} from './js/phone-check.js';
import {startSettings} from './js/settings.js';
import {onSyncStatus, startSync, statusText, syncNow} from './js/sync.js';
import {WISHLIST_ACCOUNT_VIEWS, WISHLIST_ROUTES} from './js/wishlist-view.js';
import {keepFamilyWishlistsCached} from './js/wishlist.js';

const ROUTES = [
	{pattern: /^cards$/, render: myCardsView, tab: 'cards', title: 'My Cards | Card Tracker'},
	{pattern: /^import$/, render: importView, tab: 'cards', title: 'Import from monprice | Card Tracker'},
	{pattern: /^sets$/, render: setsView, tab: 'sets', title: 'Sets | Card Tracker'},
	{keys: ['lang', 'setId'], pattern: /^sets\/([^/]+)\/([^/]+)$/, render: setView, tab: 'sets', title: 'Set | Card Tracker'},
	{keys: ['lang', 'cardId'], pattern: /^cards\/([^/]+)\/([^/]+)$/, render: cardView, tab: 'sets', title: 'Card | Card Tracker'},
	{pattern: /^check$/, render: phoneCheckView, tab: 'check', title: 'Phone check | Card Tracker'},
	{pattern: /^camera$/, render: cameraView, tab: 'check', title: 'Camera test | Card Tracker'},
	{pattern: /^storage$/, render: storageView, tab: 'check', title: 'Storage test | Card Tracker'},
	{pattern: /^signin$/, render: signInView, tab: null, title: 'Sign in | Card Tracker'},
	{pattern: /^profile$/, render: profileView, tab: null, title: 'Profile | Card Tracker'},
	{keys: ['userId'], pattern: /^family\/([^/]+)$/, render: familyCardsView, tab: 'cards', title: 'Family cards | Card Tracker'},
	{pattern: /^lists$/, render: checklistsView, tab: 'lists', title: 'Lists | Card Tracker'},
	{keys: ['id'], pattern: /^lists\/([^/]+)$/, render: checklistView, tab: 'lists', title: 'List | Card Tracker'},
	{keys: ['userId'], pattern: /^family\/([^/]+)\/lists$/, render: familyChecklistsView, tab: 'lists', title: 'Family lists | Card Tracker'},
	{keys: ['userId', 'id'], pattern: /^family\/([^/]+)\/lists\/([^/]+)$/, render: familyChecklistView, tab: 'lists', title: 'Family list | Card Tracker'},
	...binderRoutes,
	...WISHLIST_ROUTES,
];

// Routes whose screen depends on who is signed in, redrawn on sign-in and
// sign-out.
const ACCOUNT_ROUTES = new Set([signInView, profileView, familyCardsView, myCardsView, checklistsView, familyChecklistsView, familyChecklistView, ...binderAccountViews, ...WISHLIST_ACCOUNT_VIEWS]);

const DEFAULT_ROUTE = 'cards';

let cleanup = null;
let currentRoute = null;

function routePath() {
	let path = window.location.pathname;

	path = path.startsWith(BASE) ? path.slice(BASE.length) : '';

	return path.replace(/\/+$/, '');
}

function matchRoute(path) {
	for (const route of ROUTES) {
		const match = route.pattern.exec(path);

		if (!match) {
			continue;
		}

		const params = {};

		try {
			(route.keys || []).forEach((key, i) => {
				params[key] = decodeURIComponent(match[i + 1]);
			});
		}
		catch {
			return null;
		}

		if (params.lang && !isLanguage(params.lang)) {
			return null;
		}

		return {params, route};
	}

	return null;
}

function render() {
	if (cleanup) {
		try {
			cleanup();
		}
		catch (err) {
			showError('Could not close the previous view.', err);
		}

		cleanup = null;
	}

	let found = matchRoute(routePath());

	if (!found) {
		// Home, index.html, and unknown paths all open My Cards.
		history.replaceState(history.state, '', BASE + DEFAULT_ROUTE);
		found = matchRoute(DEFAULT_ROUTE);
	}

	const {params, route} = found;
	const view = document.getElementById('view');

	currentRoute = route;

	document.getElementById('errors').replaceChildren();
	document.getElementById('menu').open = false;
	view.replaceChildren();
	document.title = route.title;

	for (const tab of document.querySelectorAll('.tabs a')) {
		if (tab.dataset.tab === route.tab) {
			tab.setAttribute('aria-current', 'page');
		}
		else {
			tab.removeAttribute('aria-current');
		}
	}

	try {
		cleanup = route.render(view, params) || null;
	}
	catch (err) {
		showError('This view failed to open.', err);
	}

	window.scrollTo(0, 0);
}

function navigate(route) {
	const target = BASE + route;

	if (target !== window.location.pathname) {
		history.pushState({inApp: true}, '', target);
	}

	render();
}

document.addEventListener('click', (event) => {
	const link = event.target.closest('a[data-link]');

	if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
		return;
	}

	event.preventDefault();
	navigate(link.dataset.link);
});

window.addEventListener('popstate', render);

// 404.html sends an unknown path here as ?p=<path>. Put the path back
// before the first render, without adding a history entry.
function restoreRedirectedPath() {
	const params = new URLSearchParams(window.location.search);

	if (!params.has('p')) {
		return;
	}

	const path = params.get('p').replace(/^\/+/, '');

	params.delete('p');

	const query = params.toString();

	history.replaceState(null, '', BASE + path + (query ? `?${query}` : ''));
}

function showBanner(message, actionLabel, action) {
	const banner = document.getElementById('banner');

	// replaceChildren prints a null argument as the text "null", so add the
	// button only when there is one.

	const children = [h('span', null, message)];

	if (actionLabel) {
		children.push(h('button', {type: 'button', onclick: action}, actionLabel));
	}

	banner.replaceChildren(...children);
	banner.hidden = false;
}

async function registerServiceWorker() {
	if (!('serviceWorker' in navigator)) {
		return;
	}

	const hadController = Boolean(navigator.serviceWorker.controller);

	navigator.serviceWorker.addEventListener('controllerchange', () => {
		if (hadController) {
			showBanner('A new version is installed.', 'Reload', () => window.location.reload());
		}
		else {
			showBanner('The app is now saved for offline use.');
		}
	});

	try {
		await navigator.serviceWorker.register(new URL('sw.js', import.meta.url), {scope: BASE});
	}
	catch (err) {
		showError('Offline support could not be set up.', err);
	}
}

// ------------------------------------------------------------ the account

// The header: sync status under the title, and Sign in or the avatar that
// opens Profile.
function drawAccount(user) {
	const account = document.getElementById('account');

	if (user) {
		const initial = (user.email || '?').trim().charAt(0).toUpperCase();

		account.className = 'account avatar';
		account.dataset.link = 'profile';
		account.href = `${BASE}profile`;
		account.setAttribute('aria-label', `Profile, signed in as ${user.email}`);
		account.textContent = initial;
	}
	else {
		account.className = 'account';
		account.dataset.link = 'signin';
		account.href = `${BASE}signin`;
		account.removeAttribute('aria-label');
		account.textContent = 'Sign in';
	}
}

function watchSyncStatus() {
	const line = document.getElementById('sync-status');

	line.addEventListener('click', () => syncNow());

	onSyncStatus((status) => {
		const text = statusText(status);

		line.hidden = !text;
		line.textContent = text;
		line.dataset.phase = status.phase;
		line.title = status.phase === 'error' && status.error ? String(status.error.message || status.error) : '';
	});
}

async function startAccount(authReturn) {
	drawAccount(null);
	watchSyncStatus();

	onUser((user) => {
		drawAccount(user);

		if (currentRoute && ACCOUNT_ROUTES.has(currentRoute.render)) {
			render();
		}
	});

	startSync();
	keepFamilyWishlistsCached();

	if (authReturn && authReturn.error) {
		setSignInNotice(signInErrorText(authReturn.error));
		go('signin', {replace: true});
	}

	await restoreSession();

	if (authReturn && (authReturn.code || authReturn.tokens) && !currentUser()) {
		try {
			if (authReturn.code) {
				await completeSignIn(authReturn.code);
			}
			else {
				await completeInvite(authReturn.tokens);
			}
		}
		catch (err) {
			setSignInNotice(signInErrorText(err));
			go('signin', {replace: true});
		}
	}
}

restoreRedirectedPath();

// A sign-in link or Google returns with ?code=, and a dashboard invitation
// with the session in the fragment; take either off the address before the
// router replaces the path.
const authReturn = takeAuthReturn();

// The theme and, signed in, the favorite Pokémon in the header.
startSettings();
render();
registerServiceWorker();
startAccount(authReturn).catch((err) => showError('Signing in did not work.', err));
