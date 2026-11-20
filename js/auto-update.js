// A new version takes over by itself (Eric, 2026-11-20). A computer ran v87
// for hours while v90 sat installed and waiting, because only the update
// toast's Reload, Profile's Reload, or closing every tab moved it, and his
// devices showed different data meanwhile. Now the page moves itself to a
// waiting version (skipWaiting, then a reload once the new worker is
// activated, exactly as Reload does: js/whats-new.js applyUpdate), and
// Reload stays as it was for the moments this declines.
//
// When: only when the app comes back after being away at least AWAY_MS
// (hidden: another app, another tab, the screen off), or opens cold after
// that long, and nothing has been touched since. Never on a screen change,
// and never while the person is using the page. v91 to v94 also switched on
// a screen change and kept a list of what to wait for, and two QA passes
// (2026-11-20) kept finding work held only in memory that the list missed:
// a card in hand for Add to binder, Edit binder's Grid and Size set by
// buttons, My Cards' Select ticks, a family member's view-only lens. Coming
// back after minutes away is when nothing in memory is being relied on: the
// person has put the task down, and on a phone the system may already have
// closed the page. Five minutes is longer than a glance at a message, a
// call answered, or a look through a box of cards, and short enough that a
// device used every day takes a new version within the day.
//
// What survives the reload: everything saved (every edit is in IndexedDB
// first, js/collection.js; the scanner's tray too, js/scan/draft.js), the
// screen (the address), a family member's lens (js/shell.js) and a card in
// hand on a binder (js/binder-hand.js), which are kept in sessionStorage for
// the next load. Accepted as lost after AWAY_MS away: My Cards' Select
// ticks, and a choice made by a button in a form but not saved.
//
// And quiet, as before (quietBlocker below):
//   - online, since the reload reads every module again;
//   - no long save running (holdUpdate: an import or Start over, which also
//     ask the browser before the page closes, js/import-view.js);
//   - not signing in: the account has finished starting, which includes a
//     sign-in link's or Google's ?code= exchange (app.js startAccount), and
//     no ?code= is on the address;
//   - not on a screen whose work lives in the page (BUSY_SCREENS): Scan, with
//     its camera, captures and reads; the camera and storage tests and Phone
//     check; Import; Sign in; Log a trade or sale; New binder; New goal;
//   - no sheet open: the copy sheet, binder and list edits, trade and
//     purchase forms, Start over's confirmation, What's new itself;
//   - nothing typed or chosen in a form on this screen since it was drawn,
//     and no text field in focus;
//   - no toast offering Undo;
//   - no push to the server under way (sync phase "saving").
// After the moment, a short settle, abandoned on any tap or key.
//
// The new shell is fully cached before any of this: a worker only reaches
// "installed" (waiting) when its install step's cache.addAll of every shell
// file succeeded (sw.js), and one failed file fails the whole install. The
// reload waits for the new worker to be activated, at most ACTIVATE_MS, and
// without it nothing reloads and Reload stays offered (js/whats-new.js); a
// tap, or anything quietBlocker names, during that wait stops it too.
//
// Never in a loop: each automatic switch is stamped in sessionStorage, and
// none follows within GUARD_MS of the last. Without sessionStorage there is
// no guard, so there is no automatic switch either.
//
// Another tab that takes the new version moves this page's controller too
// (app.js controllerchange), as does a switch that gave up waiting after
// the worker had started activating: the page then runs old modules under
// the new worker, so it reloads at its next moment as well (stale), once
// that worker is activated.
//
// The page also asks for an update when it comes back into view or changes
// screen, at most once a minute, so a tab left open for hours notices a new
// version without a full navigation. A version that finishes installing
// while nothing has been touched since a long time away takes over then.

import {keepHandsForSwitch} from './binder-hand.js';
import {BASE} from './dom.js';
import {draftSaved} from './scan/draft.js';
import {openSheetCount} from './sheet.js';
import {keepLensForSwitch} from './shell.js';
import {syncStatus} from './sync.js';
import {applyUpdate} from './whats-new.js';

// Screens, by path under BASE, whose work a reload would cut short or lose.
export const BUSY_SCREENS = /^(scan|camera|storage|check|import|signin|trades\/new|binders\/new|goals\/new)(\/|$)/;

export const GUARD_KEY = 'cardTracker.autoUpdateAt';
const GUARD_MS = 10 * 60 * 1000;

// How long the app must have been out of view before a switch.
export const AWAY_MS = 5 * 60 * 1000;

// When a page of the app was last hidden or closed, for telling how long a
// cold start was away. Any tab's: a cold start has nothing in memory to lose.
export const HIDDEN_KEY = 'cardTracker.hiddenAt';

// The wait after the moment starts, so a save under way (the Scan tray's
// last save) lands, and a tap that follows stops it.
const SETTLE_MS = 600;

// The least time between two update checks.
const CHECK_GAP_MS = 60 * 1000;

const TEXT_INPUT = /^(date|datetime-local|email|month|number|password|search|tel|text|time|url|week)$/;

// The worker that controlled this page when it loaded.
const loadController = typeof navigator !== 'undefined' && navigator.serviceWorker ? navigator.serviceWorker.controller : null;

let registration = null;
let accountReady = false;
let started = false;
let stale = false;
let holds = 0;
let typed = false;
let lastInput = 0;
let lastCheck = 0;
let switching = false;
// When the page was hidden (0 while in view), and when it last came back,
// or opened, after AWAY_MS away (0: not since it loaded).
let hiddenAt = 0;
let returnedAt = 0;

// Holds the automatic switch while a long save runs; call what it returns
// when the save ends.
export function holdUpdate() {
	let held = true;

	holds++;

	return () => {
		if (held) {
			held = false;
			holds--;
		}
	};
}

const isTextField = (el) => Boolean(el) && (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && TEXT_INPUT.test(el.type)));

// Any form control a person can change: a choice made by a tap (a select, a
// colour, a checkbox) is as much unsaved work as typed text. 2026-11-20: an
// Edit binder form with a new colour and grid, nothing typed, was thrown
// away by the switch (it is an inline form, not a sheet).
const isFormControl = (el) => Boolean(el) && (el.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName));

function screenPath() {
	const path = window.location.pathname;

	return (path.startsWith(BASE) ? path.slice(BASE.length) : '').replace(/\/+$/, '');
}

// Why the page cannot switch now, or null when it can.
export function quietBlocker() {
	if (!navigator.onLine) {
		return 'offline';
	}

	if (holds) {
		return 'saving';
	}

	if (!accountReady || new URLSearchParams(window.location.search).has('code')) {
		return 'signing in';
	}

	if (BUSY_SCREENS.test(screenPath())) {
		return 'busy screen';
	}

	if (openSheetCount() || document.querySelector('dialog[open]')) {
		return 'sheet';
	}

	if (typed || isTextField(document.activeElement)) {
		return 'typing';
	}

	// A toast offering a way back (Undo, Undo edit, Put back): a reload
	// would take it away. The update toast's own Reload does not count.
	if ([...document.querySelectorAll('.toast button.small')].some((button) => /^(Undo|Put back)\b/.test(button.textContent.trim()))) {
		return 'undo offered';
	}

	if (syncStatus().phase === 'saving') {
		return 'syncing';
	}

	if (document.visibilityState !== 'visible') {
		return 'hidden';
	}

	return null;
}

function guardFree() {
	try {
		const at = Number(sessionStorage.getItem(GUARD_KEY));

		return !(at && Date.now() - at < GUARD_MS && Date.now() >= at);
	}
	catch {
		return false;
	}
}

function stampGuard() {
	try {
		sessionStorage.setItem(GUARD_KEY, String(Date.now()));

		return true;
	}
	catch {
		return false;
	}
}

const waitingWorker = () => {
	const worker = registration && registration.waiting;

	return worker && worker.state === 'installed' ? worker : null;
};

// A clock set back reads as not away.
const awayLongEnough = (since) => since > 0 && Date.now() - since >= AWAY_MS;

// Nothing tapped or typed since the page came back, or opened, after
// AWAY_MS away.
const untouchedSinceAway = () => returnedAt > 0 && lastInput < returnedAt;

// The page runs old modules under a newer worker than the one it loaded
// with: another tab's Reload, or a switch that gave up while the new worker
// was activating.
const isStale = () => {
	const controller = navigator.serviceWorker.controller;

	return stale || Boolean(loadController && controller && controller !== loadController);
};

// Just before the reload: what the next load takes back.
function keepForNextLoad() {
	keepLensForSwitch();
	keepHandsForSwitch();
}

// Switches to the waiting version, or reloads a stale page, when the page
// came back after AWAY_MS away, nothing was touched since, and it is quiet;
// otherwise does nothing, and the next moment tries again. Resolves true when
// the page is reloading.
export async function switchWhenQuiet() {
	if (switching || !registration || !navigator.serviceWorker.controller || !untouchedSinceAway() || (!isStale() && !waitingWorker())) {
		return false;
	}

	if (quietBlocker() || !guardFree()) {
		return false;
	}

	switching = true;

	try {
		await Promise.all([
			draftSaved().catch(() => {}),
			new Promise((resolve) => setTimeout(resolve, SETTLE_MS)),
		]);

		if (!untouchedSinceAway() || quietBlocker() || !guardFree()) {
			return false;
		}

		const worker = waitingWorker();

		if (worker) {
			// The wait for activation can take seconds: a tap or a sheet
			// opened meanwhile stops the reload.
			return stampGuard() && await applyUpdate(worker, {beforeReload: keepForNextLoad, stillWanted: () => untouchedSinceAway() && !quietBlocker()});
		}

		// Stale: the newer worker already controls the page. A reload while
		// it is still activating would wait on it, so only once activated.
		const controller = navigator.serviceWorker.controller;

		if (!isStale() || !controller || controller.state !== 'activated' || !stampGuard()) {
			return false;
		}

		keepForNextLoad();
		window.location.reload();

		return true;
	}
	finally {
		switching = false;
	}
}

// Asks the server for a newer sw.js, at most once a minute and only online.
function checkForUpdate() {
	if (!registration || !navigator.onLine || Date.now() - lastCheck < CHECK_GAP_MS) {
		return;
	}

	lastCheck = Date.now();
	registration.update().catch(() => {});
}

// A screen was drawn (app.js render): whatever was typed went with the old
// one. Never a moment to switch: a screen change is the person at work.
export function screenDrawn() {
	typed = false;

	if (started) {
		checkForUpdate();
	}
}

// Another tab moved this page's controller to a new version.
export function markStale() {
	stale = true;
}

function wentAway() {
	if (!hiddenAt) {
		hiddenAt = Date.now();
	}

	try {
		localStorage.setItem(HIDDEN_KEY, String(hiddenAt));
	}
	catch {
		// A cold start then counts as away long enough, as with no record.
	}
}

function cameBack() {
	if (awayLongEnough(hiddenAt)) {
		returnedAt = Date.now();
	}

	hiddenAt = 0;
	checkForUpdate();
	switchWhenQuiet();
}

// Taps, keys, and wheel scrolls, from the first moment, so a cold start
// counts what the person did before the worker was registered.
if (typeof document !== 'undefined') {
	const touched = () => {
		lastInput = Date.now();
	};

	document.addEventListener('pointerdown', touched, {capture: true, passive: true});
	document.addEventListener('keydown', touched, {capture: true});
	document.addEventListener('wheel', touched, {capture: true, passive: true});

	// A cold start after AWAY_MS away, or with no record of the last time
	// the app was hidden, is a return.
	try {
		const at = Number(localStorage.getItem(HIDDEN_KEY));

		if (!at || awayLongEnough(at)) {
			returnedAt = Date.now();
		}
	}
	catch {
		returnedAt = Date.now();
	}
}

// Starts watching, once the worker is registered. `account` settles when the
// account has started (app.js startAccount), sign-in returns included.
export function startAutoUpdate(found, account) {
	if (started || !found) {
		return;
	}

	started = true;
	registration = found;
	lastCheck = Date.now();

	const changed = (event) => {
		if (isFormControl(event.target)) {
			typed = true;
		}
	};

	document.addEventListener('input', changed, {capture: true});
	document.addEventListener('change', changed, {capture: true});

	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') {
			cameBack();
		}
		else {
			wentAway();
		}
	});
	window.addEventListener('pagehide', wentAway);
	window.addEventListener('pageshow', (event) => {
		if (event.persisted) {
			cameBack();
		}
	});

	// A version that finishes installing after the return, before anything
	// was touched.
	registration.addEventListener('updatefound', () => {
		const worker = registration.installing;

		worker?.addEventListener('statechange', () => {
			if (worker.state === 'installed') {
				switchWhenQuiet();
			}
		});
	});

	Promise.resolve(account).catch(() => {}).finally(() => {
		accountReady = true;
		// The app opened with a version already waiting.
		switchWhenQuiet();
	});
}
