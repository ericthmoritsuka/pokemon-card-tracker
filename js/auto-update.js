// A new version takes over by itself at a quiet moment (Eric, 2026-11-20).
// A computer ran v87 for hours while v90 sat installed and waiting, because
// only the update toast's Reload, Profile's Reload, or closing every tab
// moved it, and his devices showed different data meanwhile. Now the page
// moves itself to a waiting version (skipWaiting, then a reload, exactly as
// Reload does: js/whats-new.js applyUpdate), and Reload stays as it was for
// the moments this declines.
//
// When: the page coming back into view (visibilitychange to visible, or a
// pageshow from the back-forward cache), a move to another screen (app.js
// render calls screenDrawn), and the app opening with a version already
// waiting. Never while the person is looking at the same screen: the switch
// waits for one of those moments, then a short settle, and gives up if the
// person taps or types during it.
//
// Quiet means a reload cannot lose anything (quietBlocker below):
//   - online, since the reload reads every module again;
//   - no long save running (holdUpdate: an import or Start over, which also
//     ask the browser before the page closes, js/import-view.js);
//   - not signing in: the account has finished starting, which includes a
//     sign-in link's or Google's ?code= exchange (app.js startAccount), and
//     no ?code= is on the address;
//   - not on a screen whose work lives in the page (BUSY_SCREENS): Scan, with
//     its camera, captures and reads; the camera and storage tests and Phone
//     check; Import; Sign in; Log a trade or sale; New binder; New goal. The
//     scanner's tray is saved to IndexedDB as it changes (js/scan/draft.js),
//     so leaving Scan is safe once that save lands (draftSaved);
//   - no sheet open: the copy sheet, binder and list edits, trade and
//     purchase forms, Start over's confirmation, What's new itself;
//   - no text typed on this screen since it was drawn, and no text field in
//     focus;
//   - no push to the server under way (sync phase "saving"). The changes it
//     carries are already in IndexedDB (js/collection.js saves every edit
//     there first), so they would survive, but the page is not idle.
//
// The new shell is fully cached before any of this: a worker only reaches
// "installed" (waiting) when its install step's cache.addAll of every shell
// file succeeded (sw.js), and one failed file fails the whole install.
//
// Never in a loop: each automatic switch is stamped in sessionStorage, and
// none follows within GUARD_MS of the last. Without sessionStorage there is
// no guard, so there is no automatic switch either.
//
// Another tab that takes the new version moves this page's controller too
// (app.js controllerchange): the page then runs old modules under the new
// worker, so it reloads at its next quiet moment as well (markStale).
//
// The page also asks for an update when it comes back into view or changes
// screen, at most once a minute, so a tab left open for hours notices a new
// version without a full navigation.

import {BASE} from './dom.js';
import {draftSaved} from './scan/draft.js';
import {openSheetCount} from './sheet.js';
import {syncStatus} from './sync.js';
import {applyUpdate} from './whats-new.js';

// Screens, by path under BASE, whose work a reload would cut short or lose.
export const BUSY_SCREENS = /^(scan|camera|storage|check|import|signin|trades\/new|binders\/new|goals\/new)(\/|$)/;

export const GUARD_KEY = 'cardTracker.autoUpdateAt';
const GUARD_MS = 10 * 60 * 1000;

// The wait after a quiet moment starts, so a save the screen change began
// (the Scan tray's last save) lands, and a tap that follows stops it.
const SETTLE_MS = 600;

// The least time between two update checks.
const CHECK_GAP_MS = 60 * 1000;

const TEXT_INPUT = /^(date|datetime-local|email|month|number|password|search|tel|text|time|url|week)$/;

let registration = null;
let accountReady = false;
let started = false;
let stale = false;
let holds = 0;
let typed = false;
let lastInput = 0;
let lastCheck = 0;
let switching = false;

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

// Switches to the waiting version, or reloads a stale page, when the page is
// quiet; otherwise does nothing, and the next moment tries again.
export async function switchWhenQuiet() {
	if (switching || !registration || !navigator.serviceWorker.controller || (!stale && !waitingWorker())) {
		return false;
	}

	if (quietBlocker() || !guardFree()) {
		return false;
	}

	switching = true;

	try {
		const since = Date.now();

		await Promise.all([
			draftSaved().catch(() => {}),
			new Promise((resolve) => setTimeout(resolve, SETTLE_MS)),
		]);

		if (lastInput > since || quietBlocker() || !guardFree()) {
			return false;
		}

		const worker = waitingWorker();

		if (!worker && !stale) {
			return false;
		}

		if (!stampGuard()) {
			return false;
		}

		if (worker) {
			applyUpdate(worker);
		}
		else {
			window.location.reload();
		}

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
// one, and moving between screens is a moment to switch.
export function screenDrawn() {
	typed = false;

	if (started) {
		checkForUpdate();
		switchWhenQuiet();
	}
}

// Another tab moved this page's controller to a new version.
export function markStale() {
	stale = true;
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

	document.addEventListener('pointerdown', () => {
		lastInput = Date.now();
	}, {capture: true, passive: true});
	document.addEventListener('keydown', () => {
		lastInput = Date.now();
	}, {capture: true});
	document.addEventListener('input', (event) => {
		if (isTextField(event.target)) {
			typed = true;
		}
	}, {capture: true});

	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') {
			checkForUpdate();
			switchWhenQuiet();
		}
	});
	window.addEventListener('pageshow', (event) => {
		if (event.persisted) {
			checkForUpdate();
			switchWhenQuiet();
		}
	});

	Promise.resolve(account).catch(() => {}).finally(() => {
		accountReady = true;
		// The app opened with a version already waiting.
		switchWhenQuiet();
	});
}
