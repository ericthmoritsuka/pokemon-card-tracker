// Card Tracker.
//
// A tiny router over real paths through the History API. Never a # hash:
// iOS drops the camera permission whenever the hash changes.
//
// Routes, under the /pokemon-card-tracker/ base:
//   cards                     My Cards, the home tab
//   sets                      Sets, by series, in the viewing language
//   sets/<lang>/<setId>       One set's cards
//   cards/<lang>/<cardId>     One card
//   scan                      Scan (js/scan/routes.js)
//   binders[/...]             Binders (js/binders-view.js)
//   lists, lists/<id>         Lists: Pokémon checklists, and one checklist
//   wishlist[/<userId>]       Lists: the wishlist (js/wishlist-view.js)
//   profile, signin           Profile, and its sign-in panel on its own
//   import, check, camera, storage  Opened from Profile: Import from
//                             monprice, Phone check and its two tests
//   family/<userId>[/lists[/<id>]]  A family member's cards or checklists,
//                             view only (js/shell.js holds the lens)
//
// Each route names the tab it belongs to (tab), the kind of screen for the
// family view-only strip (kind, when it differs from tab), and whether a
// family member's lens stays on while it is open (keepsLens).

import {profileView, setSignInNotice, signInView} from './js/account-views.js';
import {binderAccountViews, binderRoutes} from './js/binders-view.js';
import {completeInvite, completeSignIn, currentUser, onUser, restoreSession, signInErrorText, takeAuthReturn} from './js/auth.js';
import {followCardLink} from './js/card-swipe.js';
import {familyCardsView, myCardsView} from './js/cards-view.js';
import {cardView, setView, setsView} from './js/catalog-views.js';
import {isLanguage} from './js/catalog.js';
import {checklistView, checklistsView, familyChecklistView, familyChecklistsView} from './js/checklists-view.js';
import {BASE, go, pushRoute, showError} from './js/dom.js';
import {importView} from './js/import-view.js';
import {cameraView, phoneCheckView, storageView} from './js/phone-check.js';
import {startPhotoSync} from './js/photos/index.js';
import {pokemonCardsAccountViews, pokemonCardsRoutes} from './js/pokemon-cards-view.js';
import {euroRates, exchangeRates} from './js/prices.js';
import {scanView} from './js/scan/routes.js';
import {startSettings} from './js/settings.js';
import {closeSheets} from './js/sheet.js';
import {shellRoute, startShell, toast} from './js/shell.js';
import {onSyncStatus, startSync, statusText, syncNow} from './js/sync.js';
import {WISHLIST_ACCOUNT_VIEWS, WISHLIST_ROUTES} from './js/wishlist-view.js';
import {keepFamilyWishlistsCached} from './js/wishlist.js';

const ROUTES = [
	{pattern: /^cards$/, render: myCardsView, tab: 'cards', title: 'My Cards | Card Tracker'},
	{pattern: /^import$/, render: importView, tab: null, title: 'Import from monprice | Card Tracker'},
	{pattern: /^sets$/, keepsLens: true, render: setsView, tab: 'sets', title: 'Sets | Card Tracker'},
	{keys: ['lang', 'setId'], keepsLens: true, pattern: /^sets\/([^/]+)\/([^/]+)$/, render: setView, tab: 'sets', title: 'Set | Card Tracker'},
	{keys: ['lang', 'cardId'], keepsLens: true, pattern: /^cards\/([^/]+)\/([^/]+)$/, render: cardView, tab: null, title: 'Card | Card Tracker'},
	{pattern: /^scan$/, render: scanView, tab: 'scan', title: 'Scan | Card Tracker'},
	{pattern: /^check$/, render: phoneCheckView, tab: null, title: 'Phone check | Card Tracker'},
	{pattern: /^camera$/, render: cameraView, tab: null, title: 'Camera test | Card Tracker'},
	{pattern: /^storage$/, render: storageView, tab: null, title: 'Storage test | Card Tracker'},
	{pattern: /^signin$/, render: signInView, tab: null, title: 'Sign in | Card Tracker'},
	{pattern: /^profile$/, render: profileView, tab: null, title: 'Profile | Card Tracker'},
	{keys: ['userId'], pattern: /^family\/([^/]+)$/, render: familyCardsView, tab: 'cards', title: 'Family cards | Card Tracker'},
	{pattern: /^lists$/, render: checklistsView, tab: 'lists', title: 'Lists | Card Tracker'},
	{keys: ['id'], pattern: /^lists\/([^/]+)$/, render: checklistView, tab: 'lists', title: 'List | Card Tracker'},
	{keys: ['userId'], pattern: /^family\/([^/]+)\/lists$/, render: familyChecklistsView, tab: 'lists', title: 'Family lists | Card Tracker'},
	{keys: ['userId', 'id'], pattern: /^family\/([^/]+)\/lists\/([^/]+)$/, render: familyChecklistView, tab: 'lists', title: 'Family list | Card Tracker'},
	...pokemonCardsRoutes,
	...binderRoutes,
	...WISHLIST_ROUTES,
];

// Routes whose screen depends on who is signed in, redrawn on sign-in and
// sign-out.
const ACCOUNT_ROUTES = new Set([signInView, profileView, familyCardsView, myCardsView, checklistsView, checklistView, familyChecklistsView, familyChecklistView, ...binderAccountViews, ...WISHLIST_ACCOUNT_VIEWS, ...pokemonCardsAccountViews]);

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

// Back to a screen puts it where it was left. Its tiles may still be
// loading from IndexedDB, so the scroll waits for the page to be tall
// enough, and gives up when the person scrolls or after a few seconds.
let restoreRun = 0;

function restoreScroll(y) {
	const run = ++restoreRun;
	const started = Date.now();
	const stop = () => {
		restoreRun++;
	};

	window.addEventListener('touchstart', stop, {once: true, passive: true});
	window.addEventListener('wheel', stop, {once: true, passive: true});

	const attempt = () => {
		if (run !== restoreRun) {
			return;
		}

		const room = document.documentElement.scrollHeight - window.innerHeight;

		if (room >= y - 1 || Date.now() - started > 4000) {
			window.scrollTo(0, Math.min(y, Math.max(0, room)));
			window.removeEventListener('touchstart', stop);
			window.removeEventListener('wheel', stop);

			return;
		}

		requestAnimationFrame(attempt);
	};

	attempt();
}

function render() {
	// A sheet still open (a route change from code, a redraw) closes with
	// the screen it was opened over.
	closeSheets();

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
	const savedScroll = history.state && typeof history.state.scrollY === 'number' ? history.state.scrollY : null;

	currentRoute = route;

	document.getElementById('errors').replaceChildren();
	view.replaceChildren();
	document.title = route.title;
	shellRoute(route, params);

	try {
		cleanup = route.render(view, params) || null;
	}
	catch (err) {
		showError('This view failed to open.', err);
	}

	restoreRun++;

	if (savedScroll) {
		restoreScroll(savedScroll);
	}
	else {
		window.scrollTo(0, 0);
	}
}

function navigate(route) {
	const target = BASE + route;

	if (target !== window.location.pathname) {
		pushRoute(target);
	}

	render();
}

document.addEventListener('click', (event) => {
	const link = event.target.closest('a[data-link]');

	if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
		return;
	}

	event.preventDefault();

	// A card opened from a grid keeps that grid as its swipe context.
	followCardLink(link.dataset.link);
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

async function registerServiceWorker() {
	if (!('serviceWorker' in navigator)) {
		return;
	}

	const hadController = Boolean(navigator.serviceWorker.controller);
	let reloading = false;
	let offered = false;

	navigator.serviceWorker.addEventListener('controllerchange', () => {
		// After Reload, the waiting version took over: load its files.
		if (reloading) {
			window.location.reload();

			return;
		}

		// A toast floats over the page, so nothing shifts when it shows.
		// Reload in another tab moved this one to the new version too.
		if (hadController) {
			toast('A new version is installed.', {action: () => window.location.reload(), actionLabel: 'Reload', timeout: 0});
		}
		else {
			toast('Saved on this phone. Card Tracker now opens offline.');
		}
	});

	// A new version installs in the background and waits, so this page keeps
	// running on one version's files until the person taps Reload.
	function offer(worker) {
		if (offered || !worker || !navigator.serviceWorker.controller) {
			return;
		}

		offered = true;
		toast('A new version is installed.', {
			action: () => {
				reloading = true;
				worker.postMessage('skip-waiting');
			},
			actionLabel: 'Reload',
			timeout: 0,
		});
	}

	try {
		const registration = await navigator.serviceWorker.register(new URL('sw.js', import.meta.url), {scope: BASE});

		// Some browsers, and tests that block workers, give no registration.
		if (!registration) {
			return;
		}

		offer(registration.waiting);
		registration.addEventListener('updatefound', () => {
			const worker = registration.installing;

			worker?.addEventListener('statechange', () => {
				if (worker.state === 'installed') {
					offer(worker);
				}
			});
		});
	}
	catch (err) {
		showError('Offline support could not be set up.', err);
	}
}

// ------------------------------------------------------------ the account

// The sync status under the title: hidden when signed out, tappable to sync
// again. js/shell.js draws the avatar and the offline strip.
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
	watchSyncStatus();

	onUser(() => {
		if (currentRoute && ACCOUNT_ROUTES.has(currentRoute.render)) {
			render();
		}
	});

	startSync();
	keepFamilyWishlistsCached();
	startPhotoSync();

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
startShell();

// The day's dollar and euro rates, saved on the phone for the price
// estimates (js/prices.js). Offline, the last saved ones stay in use.
exchangeRates().catch(() => {});
euroRates().catch(() => {});

render();
registerServiceWorker();
startAccount(authReturn).catch((err) => showError('Signing in did not work.', err));
