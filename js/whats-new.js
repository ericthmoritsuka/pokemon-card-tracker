// What's new, with the version (plans/roadmap.md): the app's version, a
// short list of what each release changed in friendly words, and the sheet
// that shows it. The text ships with the app, so it works offline; write a
// new entry at the top at each release, in plain words for the family, not
// CHANGELOG.md's.
//
// The running version is the active service worker's: sw.js names its shell
// cache `card-tracker-shell-<VERSION>`. The worker is asked first (a sw.js
// that answers {type: 'version'}), and else the shell caches are read, oldest
// first: the active worker's cache comes before the one a newer worker
// installed. With no worker (tests, a browser without them, the first load
// before the worker is ready) there is no version, and the Profile line says
// "Card Tracker" alone.
//
// Styles are in css/whats-new.css.

import {h} from './dom.js';
import {openDialogSheet} from './sheet.js';

// Newest first. items are short sentences, three or four per release.
export const RELEASES = [
	{
		date: '2026-10-09',
		items: [
			'Scan card after card without touching the phone: a buzz says it knows the card, and a count shows how many need a look.',
			'Each scanned card has an x to throw away a mistake, and a Copies count for duplicates.',
			'The same card twice in a row asks: Add a copy, or Mistake.',
			'Phone check can record every scan and save them all in one file to send.',
		],
		version: 'v32',
	},
	{
		date: '2026-10-09',
		items: [
			'The scanner skips frames with no card, says Move closer when a card is far, and does not add the same card twice when you reopen it.',
			'A Liga price you type now says which finish and language it is for.',
			'Theme swatches in Profile stay put when you pick a theme.',
			'A note when your phone\'s clock is off, and this list after each update.',
		],
		version: 'v31',
	},
	{
		date: '2026-10-06',
		items: [
			'Add to wishlist from a family member\'s cards, with a line when they have a spare.',
			'A small Value button on sets, checklists, and binders.',
			'A scanned card says which binder pocket waits for it.',
			'Checklist rows no longer tick by hand: a missing row opens the Pokémon\'s cards.',
			'Ver na Liga finds Radiant Collection, Scarlet & Violet promos, and McDonald\'s 2023 cards.',
		],
		version: 'v30',
	},
];

export const SHELL_CACHE_PREFIX = 'card-tracker-shell-';

// The version the What's new sheet last showed on this phone (or recorded
// without showing, on the first install).
const SEEN_KEY = 'cardTracker.whatsNewSeen';

// What SEEN_KEY holds between a first load and the worker's answer.
const FIRST_INSTALL = 'first-install';

// How long a worker gets to answer before the caches are read instead. A
// worker from before v31 never answers.
const ASK_MS = 500;

export const versionOfCache = (name) => (typeof name === 'string' && name.startsWith(SHELL_CACHE_PREFIX) ? name.slice(SHELL_CACHE_PREFIX.length) || null : null);

export const releaseFor = (version) => RELEASES.find((release) => release.version === version) || null;

// "v31" as 31, for telling an update from a rollback; NaN for anything else.
const versionNumber = (version) => (typeof version === 'string' && /^v\d+$/.test(version) ? Number(version.slice(1)) : NaN);

// ------------------------------------------------------- the version

// The version a worker reports, or null when it does not answer in time.
function askWorker(worker) {
	if (!worker || typeof MessageChannel === 'undefined') {
		return Promise.resolve(null);
	}

	return new Promise((resolve) => {
		const channel = new MessageChannel();
		const timer = setTimeout(() => {
			channel.port1.close();
			resolve(null);
		}, ASK_MS);

		channel.port1.onmessage = (event) => {
			clearTimeout(timer);
			channel.port1.close();

			const version = event.data && event.data.version;

			resolve(typeof version === 'string' && version ? version : null);
		};

		try {
			worker.postMessage({type: 'version'}, [channel.port2]);
		}
		catch {
			clearTimeout(timer);
			resolve(null);
		}
	});
}

async function shellCaches() {
	if (typeof caches === 'undefined') {
		return [];
	}

	try {
		return (await caches.keys()).map(versionOfCache).filter(Boolean);
	}
	catch {
		return [];
	}
}

async function registration() {
	if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
		return null;
	}

	try {
		return (await navigator.serviceWorker.getRegistration()) || null;
	}
	catch {
		return null;
	}
}

// {current, waiting, worker}: the running version and a newer one waiting
// for Reload (null when none), with the waiting worker for applyUpdate.
// Every field is null when there is no worker.
export async function appVersions() {
	const found = await registration();

	if (!found || !found.active) {
		return {current: null, waiting: null, worker: null};
	}

	let [current, waiting] = await Promise.all([askWorker(found.active), askWorker(found.waiting)]);

	if (!current || (found.waiting && !waiting)) {
		// Cache Storage lists names in the order they were made. The active
		// worker's cache comes before any made by a worker still installing
		// or waiting, and activate deletes the older ones.
		const names = await shellCaches();
		const pending = [found.installing, found.waiting].filter(Boolean).length;
		const at = Math.max(0, names.length - 1 - pending);

		current = current || names[at] || null;
		waiting = waiting || (found.waiting ? names[at + 1] || null : null);
	}

	if (waiting && waiting === current) {
		waiting = null;
	}

	return {current, waiting, worker: found.waiting && waiting ? found.waiting : null};
}

// ------------------------------------------------------------- Reload

let applying = false;

// True once Reload was tapped: the controller change that follows is this
// page moving to the new version, so it reloads rather than offering Reload
// again (app.js registerServiceWorker).
export const updateApplying = () => applying;

// Reload: the waiting worker takes over, and the page loads its files. The
// same as the update toast's Reload in app.js.
export function applyUpdate(worker) {
	if (!worker) {
		return;
	}

	if (!applying) {
		applying = true;
		navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), {once: true});
	}

	worker.postMessage('skip-waiting');
}

// -------------------------------------------------------------- sheet

function seenVersion() {
	try {
		return localStorage.getItem(SEEN_KEY);
	}
	catch {
		return null;
	}
}

function rememberSeen(version) {
	try {
		localStorage.setItem(SEEN_KEY, version);
	}
	catch {
		// Private mode or blocked storage: the sheet may show again.
	}
}

function releaseList(release) {
	return h('ul', {class: 'whats-new-items'}, release.items.map((item) => h('li', null, item)));
}

// The What's new sheet: one release ("What's new in v31") after an update,
// or every release, newest first, from Profile.
export function openWhatsNew({version = null} = {}) {
	const id = 'whats-new-sheet';
	const one = version ? releaseFor(version) : null;
	const dialog = h('dialog', {'aria-labelledby': `${id}-title`, class: 'sheet whats-new-sheet', id},
		h('div', {class: 'sheet-head'},
			h('h2', {id: `${id}-title`}, one ? `What's new in ${one.version}` : 'What\'s new'),
			h('button', {class: 'small', id: `${id}-close`, onclick: () => dialog.close(), type: 'button'}, 'Close')
		),
		h('div', {class: 'whats-new-body'},
			one
				? releaseList(one)
				: RELEASES.map((release) => h('section', {class: 'whats-new-release', 'data-version': release.version},
					h('h3', null, release.version, h('span', {class: 'muted whats-new-date'}, ` · ${release.date}`)),
					releaseList(release)
				))
		)
	);

	dialog.addEventListener('click', (event) => {
		if (event.target === dialog) {
			dialog.close();
		}
	});
	dialog.addEventListener('close', () => dialog.remove());
	document.getElementById(id)?.remove();
	document.body.append(dialog);

	return openDialogSheet(dialog);
}

// Called once at start (app.js): after Reload brings a new version, its
// What's new shows once. The first install records the version and shows
// nothing. A page that opened under a worker but has nothing recorded came
// from a version before What's new, so it shows too. Pass `controlled` as
// navigator.serviceWorker.controller was when the page loaded.
export async function showWhatsNewOnce({controlled = Boolean(typeof navigator !== 'undefined' && navigator.serviceWorker && navigator.serviceWorker.controller)} = {}) {
	if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
		return null;
	}

	if (!controlled) {
		// The first install: mark it at once, in case the page is reloaded
		// before the worker answers, then wait for the worker and record.
		if (!seenVersion()) {
			rememberSeen(FIRST_INSTALL);
		}

		try {
			await navigator.serviceWorker.ready;
		}
		catch {
			return null;
		}
	}

	const {current} = await appVersions();

	if (!current) {
		return null;
	}

	const seen = seenVersion();

	if (seen === current) {
		return null;
	}

	rememberSeen(current);

	if ((!seen && !controlled) || seen === FIRST_INSTALL || versionNumber(current) <= versionNumber(seen)) {
		return null;
	}

	return releaseFor(current) ? openWhatsNew({version: current}) : null;
}

// ------------------------------------------------------ Profile line

// "Card Tracker v30 · What's new", and "v31 ready" with Reload while a newer
// version waits. Returns {element, stop}.
export function versionLine() {
	const line = h('p', {class: 'muted whats-new-line', id: 'profile-version'}, 'Card Tracker');
	let alive = true;
	let watched = null;

	const whatsNew = () => h('button', {class: 'link-button whats-new-open', id: 'profile-whats-new', onclick: () => openWhatsNew(), type: 'button'}, 'What\'s new');

	function draw({current = null, waiting = null, worker = null} = {}) {
		line.replaceChildren(...[
			current ? `Card Tracker ${current}` : 'Card Tracker',
			' · ',
			...(waiting && worker
				? [
					h('span', {id: 'profile-version-ready'}, `${waiting} ready`),
					' ',
					h('button', {class: 'small whats-new-reload', id: 'profile-version-reload', onclick: () => applyUpdate(worker), type: 'button'}, 'Reload'),
					' · ',
				]
				: []),
			whatsNew(),
		]);
	}

	async function refresh() {
		const versions = await appVersions();

		if (alive) {
			draw(versions);
		}
	}

	// A newer version that finishes installing while Profile is open.
	function onUpdateFound() {
		const worker = watched && watched.installing;

		worker?.addEventListener('statechange', () => {
			if (worker.state === 'installed') {
				refresh();
			}
		});
	}

	draw();
	refresh();
	registration().then((found) => {
		if (alive && found) {
			watched = found;
			found.addEventListener('updatefound', onUpdateFound);
		}
	});

	return {
		element: line,
		stop() {
			alive = false;

			if (watched) {
				watched.removeEventListener('updatefound', onUpdateFound);
			}
		},
	};
}
