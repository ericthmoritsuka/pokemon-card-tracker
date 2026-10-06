// The scanner (/scan): a full-screen rear camera with a card guide, auto
// capture when the frame holds still, a shutter as the fallback, the tray of
// this session's cards, and the confirm, Done, and Set for all sheets
// (plans/design-review.md, "Scan: Viewfinder and Tray", "Scan: Confirm
// Sheet", "Scan: Done Sheet").
//
// Always dark, whatever the theme; every control sits in the bottom part of
// the screen, for one hand. Every capture lands in the tray at once and is
// read behind it; the tray is a draft in IndexedDB (js/scan/draft.js), so
// closing the app keeps it. Done saves one entry per physical card through
// js/collection.js and offers Undo session; Discard saves nothing.

import {placeScanned, unplaceScanned, waitingPlaceholderList} from '../binders.js';
import {addCard, deleteCard, listCards, onChange} from '../collection.js';
import {cardIndex, saveToCardIndex} from '../catalog.js';
import {BASE, go, h} from '../dom.js';
import {flagLanguageName} from '../flags.js';
import {openSheet} from '../sheet.js';
import {familyWishlists, refreshFamilyWishlists} from '../wishlist.js';
import {CameraUnavailable, grabFrame, layoutGuide, startCamera, thumbnailFrame} from './camera.js';
import * as draft from './draft.js';
import {EngineUnavailable, identify, readLanguageLabel, releaseEngineSoon} from './identify.js';
import {blobImage, imageBlob, saveCaptureImages} from './image.js';
import {cardCategory, cardVariants, DEFAULT_API, findCandidates, WaitingForSignal, warmNameRoute} from './match.js';
import {knownFrom, loadFingerprints, localPrint, noCard, pictureKey, pictureMatch, pictureVerdict, repeatOfLast} from './picture.js';
import * as S from './session.js';
import {confirmSheet, doneSheet, reportSheet, setAllSheet} from './sheets.js';
import {createAutoCapture, presence, THUMB_H, THUMB_W} from './steady.js';
import {trayTile} from './tile.js';

const FRAME_MS = 125;

// A developer switch (localStorage card-tracker:scan-text-first = on): read
// every card in full and look it up by text, as before the picture-first
// switch, to compare the two on a phone. The browser tests of the text
// route use it.
const TEXT_FIRST_KEY = 'card-tracker:scan-text-first';

function textFirst() {
	try {
		return localStorage.getItem(TEXT_FIRST_KEY) === 'on';
	}
	catch {
		return false;
	}
}

// The language last picked in Scan (by a tap on a card's sheet, or Set for
// all), which a card the picture settled starts in (session.js
// defaultLanguage). Two are kept: the last Western pick (Portuguese before
// any: most cards scanned here are Portuguese, session.js
// LEADING_LANGUAGES) and the last Asian one (Korean before any: most of the
// owner's Asian cards are Korean), for a card whose label row read no Latin
// text. A Western pick never starts such a card (Eric's phone, version 25:
// a Chinese Eevee started in Portuguese).
const LANGUAGE_KEY = 'card-tracker:scan-language';
const ASIAN_LANGUAGE_KEY = 'card-tracker:scan-language-asian';

function stored(key, fallback, fits) {
	try {
		const value = localStorage.getItem(key);

		return value && fits(value) ? value : fallback;
	}
	catch {
		return fallback;
	}
}

const lastLanguage = () => stored(LANGUAGE_KEY, 'pt', (code) => !S.ASIAN_LANGUAGES.includes(code));
const lastAsianLanguage = () => stored(ASIAN_LANGUAGE_KEY, 'ko', (code) => S.ASIAN_LANGUAGES.includes(code));

function rememberLanguage(code) {
	try {
		localStorage.setItem(S.ASIAN_LANGUAGES.includes(code) ? ASIAN_LANGUAGE_KEY : LANGUAGE_KEY, code);
	}
	catch {
		// Not kept; the next card starts in Portuguese, or Korean.
	}
}

// The card last added from the camera ({key: picture.js pictureKey, item:
// its tray id}), kept across visits and reloads, so opening Scan again with
// it still in view does not add it again (picture.js repeatOfLast). A card
// removed from the tray or discarded is forgotten: taking it again is meant.
const LAST_CARD_KEY = 'card-tracker:scan-last-card';

function lastCard() {
	try {
		const last = JSON.parse(localStorage.getItem(LAST_CARD_KEY) || 'null');

		return last && typeof last.key === 'string' ? last : null;
	}
	catch {
		return null;
	}
}

function rememberCard(key, item) {
	try {
		localStorage.setItem(LAST_CARD_KEY, JSON.stringify({item, key}));
	}
	catch {
		// Not kept; a return with the card in view may add it again.
	}
}

function forgetCard(items) {
	const last = lastCard();

	if (last && items.includes(last.item)) {
		try {
			localStorage.removeItem(LAST_CARD_KEY);
		}
		catch {
			// Kept; the next return with it in view skips it.
		}
	}
}

// How long the first answer to a picture match waits for each set's record
// before showing the card from what the phone has (the card index, the
// fingerprint index's own ids and pictures). The records keep loading
// behind it, and the card is named again when they come.
const QUICK_MS = 120;

// Resolves with `promise`, or with `fallback` after ms.
const within = (promise, ms, fallback) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms))]);

// The text route's catalog calls, answered only from what the phone has
// within a moment (js/catalog.js keeps set lists and records once read):
// no full records for HP and attacks, and no artwork tiebreak. A set list
// out of reach counts as out of reach, so the route answers at once.
const quickApi = {
	...DEFAULT_API,
	allSets: (lang) => within(DEFAULT_API.allSets(lang), QUICK_MS * 2, null).then((list) => {
		if (!list) {
			throw new WaitingForSignal();
		}

		return list;
	}),
	artworkSims: null,
	cardDetail: async () => null,
	setDetail: (lang, setId) => within(Promise.resolve().then(() => DEFAULT_API.setDetail(lang, setId)), QUICK_MS, null),
	species: null,
	speciesPrints: async () => [],
};

const PHOTO_HEIGHT = 420;

// How many scans keep their capture in memory for the scan report's "Save
// capture image": a phone frame is a few megabytes, and nothing is stored.
const TRACES_KEPT = 3;

// A photo from the gallery is read at most this many pixels on its longer
// side: a phone camera's 4000 x 3000 photo would hold 48 MB of pixels, and
// the camera's own captures are smaller than this.
const PHOTO_MAX_SIDE = 2400;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const online = () => navigator.onLine !== false;

// What the tests and the phone check can read back: the last few reads'
// timings, in milliseconds.
export const scanStats = {captures: 0, reads: []};

export function scanView(root) {
	let session = null;
	let owned = new Map();
	let family = [];
	// The placeholders in the person's own binders (js/binders.js
	// placeholderList), read from the phone, so they work offline.
	let placeholders = [];
	let camera = null;
	// When the camera last opened (performance.now()), for Q-20's window.
	let cameraOpenedAt = -Infinity;
	// The camera start in progress (an AbortController), so there is never
	// a second one, and leaving or hiding the page can cancel it.
	let cameraStart = null;
	let sheet = null;
	// The sheet layer's js/sheet.js handle while a sheet shows: Escape, the
	// system Back, and Tab staying inside. Swapping one sheet for another
	// keeps it.
	let sheetHandle = null;
	let loop = null;
	let discarded = null;
	// The card index once read (js/catalog.js cardIndex), kept for the
	// quick picture answer.
	let knownIndex = null;
	let alive = true;
	let wakeLock = null;
	let engineState = 'idle';
	const photoUrls = new Map();
	// How far each card being read has got (0 to 1), for its tile, and each
	// read card's artwork vector, for the tiebreak. Neither is stored: a card
	// read again after the app closes gets both again.
	const progress = new Map();
	const artworks = new Map();
	// Cards being read or looked up right now, so resume() never starts a
	// second read of the same card.
	const working = new Set();
	// Photos picked from the gallery, whose sheet opens once looked up.
	const openWhenMatched = new Set();
	// Straightened cards waiting for their label row to be read (no text was
	// read for them), dropped once read.
	const cardImages = new Map();
	// The last few scans' captures and what was found on them (identify's
	// trace), for "Save capture image". Memory only.
	const traces = new Map();
	const detector = createAutoCapture();
	// Where the guide is (camera.js layoutGuide): on the screen, and the
	// guide and capture area in the camera's frame. Laid out again when the
	// screen or the camera's frame changes size.
	let geometry = null;
	const thumbCanvas = document.createElement('canvas');

	const video = h('video', {'aria-hidden': 'true', autoplay: true, class: 'scan-video', id: 'scan-video', muted: true, playsinline: true});
	const guide = h('div', {'aria-hidden': 'true', class: 'scan-guide', hidden: true, id: 'scan-guide'}, h('span', {class: 'scan-hint', id: 'scan-hint'}, 'Card inside the frame. Hold still.'));
	const status = h('p', {'aria-live': 'polite', class: 'scan-top-status', id: 'scan-top-status', hidden: true});
	const cameraOff = h('div', {class: 'scan-camera-off', hidden: true, id: 'scan-camera-off'});
	const note = h('div', {'aria-live': 'polite', class: 'scan-note', id: 'scan-note'});
	const count = h('p', {class: 'scan-count', id: 'scan-count'});
	const setAllButton = h('button', {class: 'scan-text-button', id: 'scan-setall-open', onclick: () => openSetAll('language'), type: 'button'}, 'Set for all');
	// A photo from the gallery, read the way a capture is.
	const photoInput = h('input', {accept: 'image/*', class: 'scan-photo-input', hidden: true, id: 'scan-photo-input', onchange: () => {
		const [file] = photoInput.files || [];

		photoInput.value = '';

		if (file) {
			readPhoto(file);
		}
	}, type: 'file'});
	const photoButton = h('button', {class: 'scan-text-button', id: 'scan-photo-open', onclick: () => photoInput.click(), type: 'button'}, 'Pick a photo');
	// Empties the tray in one tap, with Undo, as Discard session does.
	const clearButton = h('button', {'aria-label': 'Clear the tray: discard every card in this session', class: 'scan-text-button', hidden: true, id: 'scan-clear', onclick: () => discard(), type: 'button'}, 'Clear');
	const tray = h('ul', {'aria-label': 'Cards in this session', class: 'scan-tray', id: 'scan-tray'});
	const zoomRow = h('div', {class: 'scan-zoom', hidden: true, id: 'scan-zoom', role: 'group', 'aria-label': 'Zoom'});
	const closeButton = h('button', {class: 'scan-control', id: 'scan-close', onclick: close, type: 'button'}, 'Close');
	const torchButton = h('button', {'aria-pressed': 'false', class: 'scan-control', hidden: true, id: 'scan-torch', onclick: toggleTorch, type: 'button'}, 'Torch');
	const shutter = h('button', {'aria-label': 'Take the picture', class: 'scan-shutter', disabled: true, id: 'scan-shutter', onclick: () => capture('shutter'), type: 'button'}, h('span', {'aria-hidden': 'true'}));
	const doneButton = h('button', {class: 'scan-control scan-done-button', disabled: true, id: 'scan-done-open', onclick: () => openDone(), type: 'button'}, 'Done');
	const live = h('p', {'aria-live': 'polite', class: 'scan-live', id: 'scan-live'});
	const sheetLayer = h('div', {class: 'scan-sheet-layer', hidden: true, id: 'scan-sheet-layer', onclick: (event) => {
		if (event.target === sheetLayer) {
			closeSheet();
		}
	}});

	const stage = h('div', {class: 'scan-stage', id: 'scan-stage'}, video, guide, status, cameraOff);
	const screen = h('section', {'aria-label': 'Scan cards', class: 'scan', id: 'scan'},
		stage,
		h('div', {class: 'scan-bottom'},
			note,
			h('div', {class: 'scan-tray-head'}, count, h('div', {class: 'scan-tray-actions'}, photoButton, clearButton, setAllButton), photoInput),
			tray,
			zoomRow,
			h('div', {class: 'scan-controls'}, closeButton, torchButton, shutter, doneButton)
		),
		sheetLayer,
		live
	);

	root.replaceChildren(screen);
	document.documentElement.classList.add('scan-open');

	// ------------------------------------------------------------ context for the sheets

	const ctx = {
		addByHand,
		applySetAll,
		chooseCard,
		closeSheet,
		discard,
		get family() {
			return family;
		},
		openDone,
		openItem,
		openReport,
		openSetAll,
		get owned() {
			return owned;
		},
		photoUrl: (id) => photoUrls.get(id) || null,
		get placeholders() {
			return placeholders;
		},
		remove,
		get reportOn() {
			return draft.reportAlwaysOn();
		},
		reportText: (id) => S.reportText(S.findItem(session, id), {device: deviceInfo()}),
		hasCapture: (id) => traces.has(id),
		saveCapture: async (id) => {
			const trace = traces.get(id);

			if (!trace) {
				return [];
			}

			// read.js is on the phone with the app (sw.js), so this works offline.
			const {REGIONS} = await import('./read.js');

			return saveCaptureImages(trace, {regions: REGIONS});
		},
		save,
		get session() {
			return session;
		},
		setCondition: (id, value) => change(() => S.setCondition(session, id, value)),
		setReportOn: (on) => {
			draft.setReportAlwaysOn(on);
			draw();
		},
		setFinish: (id, variantId) => change(() => S.setFinish(session, id, variantId)),
		setPlace: (id, on) => change(() => S.setPlace(session, id, on)),
		setLanguage: (id, code) => {
			const rematch = change(() => S.setLanguage(session, id, code));

			rememberLanguage(code);

			if (rematch) {
				rematchItem(id);
			}
			else {
				localiseLater(id);
			}
		},
	};

	// ------------------------------------------------------------ state

	function persist() {
		if (session) {
			draft.saveSession(session).catch((err) => setNote(`The tray could not be saved on this phone. ${err.message}`));
		}
	}

	function change(fn) {
		const result = fn();

		persist();
		draw();

		return result;
	}

	async function loadPhotoUrl(id) {
		if (photoUrls.has(id)) {
			return;
		}

		try {
			const blob = await draft.loadPhoto(id);

			if (blob && alive) {
				photoUrls.set(id, URL.createObjectURL(blob));
			}
		}
		catch {
			// The tile shows a blank card.
		}
	}

	function dropPhoto(id) {
		const url = photoUrls.get(id);

		if (url) {
			URL.revokeObjectURL(url);
			photoUrls.delete(id);
		}
	}

	async function refreshOwned() {
		try {
			owned = S.ownedIndex(await listCards());
		}
		catch {
			owned = new Map();
		}

		try {
			placeholders = await waitingPlaceholderList();
		}
		catch {
			placeholders = [];
		}

		draw();
	}

	// The family's wishlists as kept on the phone, at once, then fresh from
	// the server when there is signal, so a wish added a minute ago shows.
	async function refreshFamily() {
		try {
			family = await familyWishlists();
		}
		catch {
			family = [];
		}

		draw();

		if (online()) {
			try {
				const fresh = await refreshFamilyWishlists({warm: false});

				if (alive) {
					family = fresh;
					draw();
				}
			}
			catch {
				// Keeps the saved copy.
			}
		}
	}

	// ------------------------------------------------------------ drawing

	function draw() {
		if (!alive || !session) {
			return;
		}

		const items = session.items;
		const summary = S.doneSummary(session, owned);

		// Newest at the left.
		tray.replaceChildren(...[...items].reverse().map((item) => trayTile(item, {
			marks: S.wishMarks(item, family),
			photoUrl: photoUrls.get(item.id) || null,
			progress: progress.get(item.id) ?? null,
			quantity: S.quantity(session, item, owned),
		})));

		const parts = [items.length ? `Session · ${plural(items.length, 'card')}` : 'No cards yet'];

		if (summary.look) {
			parts.push(`${summary.look} ${summary.look === 1 ? 'needs' : 'need'} a look`);
		}

		if (summary.waiting) {
			parts.push(`${summary.waiting} waiting for signal`);
		}

		count.textContent = parts.join(' · ');
		setAllButton.hidden = items.length < 2;
		clearButton.hidden = !items.length;
		doneButton.disabled = !items.length;
		doneButton.textContent = items.length ? `Done ${items.length}${summary.look ? ` · ${summary.look} to check` : ''}` : 'Done';

		drawNote();

		if (sheet) {
			// The sheet is redrawn from the session; focus stays on the same
			// control, found again by its id.
			const focused = sheet.el.contains(document.activeElement) ? document.activeElement.id : null;

			sheet.refresh();

			if (focused && sheet && !sheet.el.contains(document.activeElement)) {
				const again = document.getElementById(focused);

				if (again) {
					again.focus({preventScroll: true});
				}
			}
		}
	}

	let noteText = null;

	function setNote(text) {
		noteText = text;
		drawNote();
	}

	function drawNote() {
		const children = [];

		if (noteText) {
			children.push(h('span', null, noteText));
		}
		else if (discarded) {
			children.push(h('span', null, `Discarded ${plural(discarded.items.length, 'card')}. Nothing saved.`),
				h('button', {class: 'scan-text-button', id: 'scan-undo-discard', onclick: undoDiscard, type: 'button'}, 'Undo'));
		}
		else if (session && session.lastSave) {
			const inBinders = (session.lastSave.placed || []).length;

			children.push(h('span', {id: 'scan-saved-line'}, `Saved ${plural(session.lastSave.count, 'card')}${inBinders ? `, ${inBinders} placed in a binder` : ''}`),
				h('button', {class: 'scan-text-button', id: 'scan-undo-session', onclick: undoSession, type: 'button'}, 'Undo session'));
		}

		note.replaceChildren(...children);
		note.hidden = !children.length;
	}

	function drawStatus() {
		const lines = [];

		if (!online()) {
			lines.push(engineState === 'unavailable' ? 'Offline · the reader downloads once there is signal' : 'Offline · reads still work');
		}
		else if (engineState === 'loading') {
			lines.push('Getting the reader ready');
		}
		else if (engineState === 'unavailable') {
			lines.push('The reader could not start. Cards wait in the tray.');
		}

		status.textContent = lines.join(' ');
		status.hidden = !lines.length;
	}

	// ------------------------------------------------------------ sheets

	function showSheet(next) {
		sheet = next;
		sheetLayer.replaceChildren(next.el);
		sheetLayer.hidden = false;
		screen.classList.add('has-sheet');
		detector.pause();

		if (!sheetHandle) {
			sheetHandle = openSheet(sheetLayer, {
				focusables: () => (sheet ? [...sheet.el.querySelectorAll('button:not([disabled]), select, input, [tabindex]:not([tabindex="-1"])')] : []),
				lockScroll: false,
				mount: null,
				onClose: sheetClosed,
				remove: false,
			});
		}

		const focus = next.el.querySelector('.scan-sheet-title');

		if (focus) {
			focus.setAttribute('tabindex', '-1');
			focus.focus({preventScroll: true});
		}
	}

	function closeSheet() {
		if (sheetHandle) {
			sheetHandle.close();
		}
	}

	// After the sheet layer closes, however it closed (focus goes back to
	// what opened it).
	function sheetClosed() {
		sheetHandle = null;
		sheet = null;
		sheetLayer.replaceChildren();
		sheetLayer.hidden = true;
		screen.classList.remove('has-sheet');
		detector.resume();
	}

	function openItem(id) {
		if (!S.findItem(session, id)) {
			return;
		}

		showSheet(confirmSheet(ctx, id));
	}

	function openReport(id) {
		if (S.findItem(session, id)) {
			showSheet(reportSheet(ctx, id));
		}
	}

	// The phone, for the scan report: nothing that names the person.
	function deviceInfo() {
		return {
			camera: camera && camera.frame.width ? `${camera.frame.width} x ${camera.frame.height}` : null,
			cores: navigator.hardwareConcurrency || null,
			memory: navigator.deviceMemory || null,
			online: online(),
			screen: `${window.screen.width} x ${window.screen.height} at ${window.devicePixelRatio || 1}x`,
			userAgent: navigator.userAgent,
		};
	}

	function openDone() {
		if (!session.items.length) {
			return;
		}

		showSheet(doneSheet(ctx));
	}

	function openSetAll(field) {
		showSheet(setAllSheet(ctx, field));
	}

	// ------------------------------------------------------------ actions

	function chooseCard(id, candidate) {
		const item = S.findItem(session, id);
		const before = item && item.card && item.card.id;

		change(() => S.chooseCard(session, id, candidate));
		localiseLater(id);

		const after = S.findItem(session, id);

		if (after && after.card && (after.card.id !== before || after.variants === null)) {
			loadVariants(id);
		}
	}

	// A card whose set the catalog has not got yet, from the add-by-hand form.
	function addByHand(id, fields) {
		change(() => S.addByHand(session, id, fields));
	}

	function remove(id) {
		forgetCard([id]);
		artworks.delete(id);
		cardImages.delete(id);
		progress.delete(id);
		change(() => S.removeItem(session, id));
		draft.deletePhoto(id).catch(() => {});
		draft.deletePhoto(`${id}:full`).catch(() => {});
		dropPhoto(id);

		if (sheet && sheet.itemId === id) {
			closeSheet();
		}
	}

	function applySetAll(field, value, options) {
		const {changed, rematch} = change(() => S.setForAll(session, field, value, options));

		if (field === 'language') {
			rememberLanguage(value);

			for (const id of changed.filter((other) => !rematch.includes(other))) {
				localiseLater(id);
			}
		}

		for (const id of rematch) {
			rematchItem(id);
		}

		openDone();
	}

	let saving = false;

	async function save(options = {}) {
		if (saving) {
			return;
		}

		saving = true;

		try {
			await saveNow(options);
		}
		finally {
			saving = false;
		}
	}

	async function saveNow({skipOwned = false} = {}) {
		const summary = S.doneSummary(session, owned);

		if (!S.canSave(summary)) {
			const first = session.items.find((item) => S.needsLook(item));

			if (first) {
				openItem(first.id);
			}

			return;
		}

		const rows = S.entriesToSave(session, owned, {skipOwned});
		const skipped = skipOwned ? session.items.filter((item) => S.isSavable(item) && S.ownedFor(item, owned).inLanguage) : [];
		const saved = [];

		try {
			for (const row of rows) {
				const entry = await addCard(row.fields);

				saved.push({entryId: entry.id, itemId: row.itemId});
			}
		}
		catch (err) {
			setNote(`Saving stopped after ${plural(saved.length, 'card')}. ${err.message}`);
		}

		// The catalog record for each saved card, so My Cards can name it
		// with no signal.
		const records = rows.filter((row) => saved.some((done) => done.itemId === row.itemId)).map((row) => {
			const item = S.findItem(session, row.itemId);
			const card = item.card;

			return {
				catalog: card.catalog,
				collector_number: card.localId,
				id: card.id,
				localizations: {[card.lang]: {image: card.image || null, lang: card.lang, name: card.name, set_name: card.setName || null}},
				official: card.official ? Number(card.official) : null,
				release_date: card.releaseDate || null,
				set_id: card.setId,
			};
		});

		saveToCardIndex(records).catch(() => {});

		const leaving = [...saved.map((row) => row.itemId), ...skipped.map((item) => item.id)];
		// The saved copies set to Place it there go in their placeholders,
		// worked out before they leave the tray.
		const toPlace = S.placementsToSave(session, saved, placeholders);
		let placed = [];
		let placeError = null;

		if (toPlace.length) {
			try {
				placed = (await placeScanned(toPlace)).done;
			}
			catch (err) {
				placeError = err;
			}
		}

		discarded = null;
		noteText = placeError ? `Saved, but the binder pockets were not filled. ${placeError.message}` : null;
		S.afterSave(session, saved);

		if (placed.length) {
			// Undo session puts the placeholders back.
			session.lastSave.placed = placed;
		}

		for (const item of skipped) {
			S.removeItem(session, item.id);
		}

		for (const id of leaving) {
			dropPhoto(id);
		}

		persist();
		draft.prunePhotos(session.items.map((item) => item.id)).catch(() => {});
		closeSheet();
		announce(`Saved ${plural(saved.length, 'card')}.${placed.length ? ` ${plural(placed.length, 'card')} placed in a binder.` : ''}`);
		await refreshOwned();
	}

	async function undoSession() {
		const placed = (session.lastSave && session.lastSave.placed) || [];
		const ids = S.takeUndo(session);

		persist();

		if (placed.length) {
			await unplaceScanned(placed).catch(() => null);
		}

		let removed = 0;

		for (const id of ids) {
			if (await deleteCard(id).catch(() => null)) {
				removed++;
			}
		}

		setNote(`Undid the session: ${plural(removed, 'card')} removed from your cards.`);
		announce(`Removed ${plural(removed, 'card')}.`);
		await refreshOwned();
	}

	function discard() {
		const kept = session;

		discarded = kept.items.length ? kept : null;
		forgetCard(kept.items.map((item) => item.id));
		noteText = null;
		session = S.newSession();
		session.lastSave = kept.lastSave;
		persist();
		closeSheet();
		draw();
		announce('Discarded. Nothing saved.');
	}

	function undoDiscard() {
		if (!discarded) {
			return;
		}

		const lastSave = session.lastSave;

		session = discarded;
		session.lastSave = lastSave;
		discarded = null;

		for (const item of session.items) {
			loadPhotoUrl(item.id).then(draw);
		}

		persist();
		draw();
	}

	function announce(text) {
		live.textContent = '';
		setTimeout(() => {
			live.textContent = text;
		}, 50);
	}

	// ------------------------------------------------------------ capture and reading

	async function capture(how) {
		if (!camera || !video.videoWidth) {
			return;
		}

		const area = currentGeometry();
		const grabbed = performance.now();
		const frame = grabFrame(video, area && area.capture);
		const captureMs = Math.round(performance.now() - grabbed);
		const shot = thumbnailFrame(video, thumbCanvas, area && area.capture);
		const thumb = shot ? shot.grey : null;
		// What the guide held as it was taken, for telling a frame with no
		// card from one with a card too far away (Q-19).
		const seen = shot ? presence(shot.grey, THUMB_W, THUMB_H, {colour: shot.colour}) : null;

		detector.captured(thumb);
		scanStats.captures++;
		flash();

		if (how === 'shutter') {
			setNote(null);
		}

		noteText = null;

		// A new scan ends the chance to bring a discarded session back.
		if (discarded) {
			discarded = null;
			draft.prunePhotos(session.items.map((item) => item.id)).catch(() => {});
		}

		const item = S.addCapture(session);

		persist();
		draw();

		// The full capture is kept until it is read, so a read cut short by the
		// app closing starts again next time.
		const fullSaved = imageBlob(frame, {quality: 0.92}).then((blob) => draft.savePhoto(`${item.id}:full`, blob)).catch(() => {});

		// Where the guide sits in the capture, for identify.js to fingerprint
		// it as one more crop.
		const guideIn = area && area.capture ? {h: area.guide.h, w: area.guide.w, x: area.guide.x - area.capture.x, y: area.guide.y - area.capture.y} : null;

		await readItem(item.id, frame, {auto: how === 'auto', captureMs, fullSaved, geometry: area ? geometryReport(area, how) : null, guide: guideIn, seen});
	}

	// A photo picked from the gallery joins the tray like a capture and is
	// read the same way (the whole photo first, then the part a camera's
	// guide would hold), and its sheet opens when it is looked up.
	async function readPhoto(file) {
		const started = performance.now();
		let frame;

		try {
			frame = await blobImage(file, {maxSide: PHOTO_MAX_SIDE});
		}
		catch {
			setNote('That photo could not be opened. Try another one.');

			return;
		}

		const captureMs = Math.round(performance.now() - started);

		setNote(null);
		noteText = null;

		if (discarded) {
			discarded = null;
			draft.prunePhotos(session.items.map((item) => item.id)).catch(() => {});
		}

		const item = S.addCapture(session);

		openWhenMatched.add(item.id);
		persist();
		draw();

		const fullSaved = imageBlob(frame, {quality: 0.92}).then((blob) => draft.savePhoto(`${item.id}:full`, blob)).catch(() => {});

		await readItem(item.id, frame, {captureMs, fullSaved, photo: true});
	}

	function flash() {
		guide.classList.remove('is-flash');
		void guide.offsetWidth;
		guide.classList.add('is-flash');

		if (navigator.vibrate) {
			try {
				navigator.vibrate(30);
			}
			catch {
				// No haptics here.
			}
		}
	}

	async function readItem(id, frame, options = {}) {
		working.add(id);

		try {
			await readItemNow(id, frame, options);
		}
		finally {
			working.delete(id);
		}
	}

	async function readItemNow(id, frame, {auto = false, captureMs = null, fullSaved = null, geometry: area = null, guide: guideIn = null, photo = false, seen = null, straight = false} = {}) {
		let result;

		try {
			engineState = engineState === 'ready' ? 'ready' : 'loading';
			drawStatus();
			let drawn = 0;

			progress.set(id, 0.05);
			draw();
			result = await identify(frame, {pictureFirst: !textFirst(), readOptions: {onProgress: (fraction) => {
				progress.set(id, fraction);

				// At most a redraw every tenth of the way.
				if (fraction - drawn >= 0.1) {
					drawn = fraction;
					draw();
				}
			}}, guide: guideIn, photo, straight});
			engineState = 'ready';
			drawStatus();
		}
		catch (err) {
			progress.delete(id);

			if (!alive || !S.findItem(session, id)) {
				return;
			}

			engineState = err instanceof EngineUnavailable ? 'unavailable' : engineState;
			drawStatus();
			change(() => S.markWaiting(session, id, 'ocr'));

			return;
		}

		if (!alive || !S.findItem(session, id)) {
			return;
		}

		progress.delete(id);
		artworks.set(id, result.artwork);

		if (result.trace && result.trace.card) {
			traces.delete(id);
			traces.set(id, result.trace);

			while (traces.size > TRACES_KEPT) {
				traces.delete(traces.keys().next().value);
			}
		}

		// A card the picture settled with no text read: its straightened image
		// is kept until its label row has been read in the background.
		if (!result.read && result.picture) {
			cardImages.set(id, result.card);
		}

		scanStats.reads.push({ocr: result.timings.ocr, rectify: result.timings.rectify, total: result.timings.total, workers: result.timings.workers});

		// An automatic capture with no card edges and no number read was not a
		// card (a hand, the table): it leaves the tray. A shutter capture
		// always stays, because the person meant it.
		if (auto && !result.found && !(result.read && result.read.number) && !(result.picture && pictureVerdict(result.picture).sure)) {
			if (fullSaved) {
				await fullSaved;
			}

			remove(id);
			setNote('That did not look like a card. Hold one inside the frame.');

			return;
		}

		// A frame with no card in it (a blank wall, a sheet of paper) does not
		// join the tray, even from the shutter (Q-19, picture.js noCard).
		if (!photo && !straight && noCard(result, seen)) {
			if (fullSaved) {
				await fullSaved;
			}

			remove(id);
			setNote('That did not look like a card. Hold one inside the frame.');

			return;
		}

		// The card just added, still in front of the camera when Scan opened
		// again (Q-20): taken once is enough. The shutter adds it anyway.
		const last = lastCard();

		if (auto && repeatOfLast(result.picture, last && last.key, performance.now() - cameraOpenedAt)) {
			if (fullSaved) {
				await fullSaved;
			}

			remove(id);
			setNote('That card was just added. Tap the shutter to add it again.');

			return;
		}

		if (!photo && !straight) {
			const key = pictureKey(result.picture);

			if (key) {
				rememberCard(key, id);
			}
		}

		// A card held too far away to read well (Q-19).
		if (seen && seen.small && !(result.picture && pictureVerdict(result.picture).sure)) {
			setNote('Move closer: the card is small in the frame.');
		}

		try {
			const blob = await imageBlob(result.card, {maxHeight: PHOTO_HEIGHT, quality: 0.82});

			await draft.savePhoto(id, blob);
			dropPhoto(id);
			await loadPhotoUrl(id);
		}
		catch {
			// The tile shows a blank card.
		}

		const item = S.findItem(session, id);

		if (!item) {
			return;
		}

		item.timings = {...result.timings};
		item.report = S.reportOfRead(result, {captureMs, frame: `${frame.width} x ${frame.height}`, geometry: area, source: photo ? 'photo' : 'camera'});
		item.picture = result.picture || null;
		change(() => (result.read ? S.applyRead(session, id, result.read) : S.markMatching(session, id)));

		if (fullSaved) {
			await fullSaved;
		}

		draft.deletePhoto(`${id}:full`).catch(() => {});

		await matchItemNow(id);
	}

	async function matchItem(id) {
		if (working.has(id)) {
			return;
		}

		working.add(id);

		try {
			await matchItemNow(id);
		}
		finally {
			working.delete(id);
		}
	}

	async function matchItemNow(id) {
		const item = S.findItem(session, id);

		if (!item || (!item.read && !item.picture)) {
			return;
		}

		change(() => S.markMatching(session, id));

		if (item.picture) {
			await pictureItemNow(id);

			return;
		}

		const started = performance.now();
		const language = item.language || item.languageHint;
		let found;

		try {
			// The language picked, or else the read's guess ("non-latin"
			// searches Japanese first), never another card's.
			found = await findCandidates(item.read, language, {artwork: artworks.get(id) || null});
		}
		catch (err) {
			if (alive && S.findItem(session, id)) {
				change(() => S.markWaiting(session, id, 'catalog'));
			}

			if (!(err instanceof WaitingForSignal)) {
				setNote(`Looking a card up failed. ${err.message}`);
			}

			return;
		}

		if (!alive || !S.findItem(session, id)) {
			return;
		}

		const current = S.findItem(session, id);

		current.confirmed = false;
		current.timings = {...current.timings, match: Math.round(performance.now() - started)};

		if (current.report) {
			current.report = {...current.report, match: S.reportOfMatch(found, {language, ms: current.timings.match})};
		}

		change(() => S.applyMatch(session, id, found));

		const last = scanStats.reads[scanStats.reads.length - 1];

		if (last && last.match === undefined) {
			last.match = current.timings.match;
		}

		if (current.card) {
			announce(`Added ${current.card.name}${current.language ? `, ${flagLanguageName(current.language)}` : ''}. ${plural(session.items.length, 'card')} in this session.`);
		}

		await loadVariants(id);
		maybeOpenFirst(id);
	}

	// Picture first (js/scan/picture.js): the artwork groups, a number read
	// to choose inside one, and the text route behind them for a card the
	// picture could not settle.
	//
	// Shown in two steps, because waiting for every set's record took 0.4 to
	// 5.8 s on Eric's phone (version 24): first from what the phone has (the
	// records already kept, waiting QUICK_MS for each, then the card index
	// and the fingerprint index's own ids and pictures), then again with the
	// full records behind it. The second answer replaces the first only when
	// nobody has touched the card in between; otherwise it just fills in the
	// names.
	async function pictureItemNow(id) {
		const item = S.findItem(session, id);
		const started = performance.now();
		const language = item.language || item.languageHint;
		const artwork = artworks.get(id) || null;
		// The card index read when the scanner opened, or, while that is still
		// being read, at most QUICK_MS of waiting for it.
		const index = knownIndex || await within(cardIndex().catch(() => null), QUICK_MS, null);
		const indexMs = Math.round(performance.now() - started);
		const known = knownFrom(index);
		const asian = lastAsianLanguage();
		// The text route from what the phone has too (quickApi), so a card the
		// picture could not settle (a set with no images yet, a number that
		// names none of the five) is shown at once rather than after every
		// set list and record has been fetched (Eric's phone, version 25: 0.6
		// to 2 s to show, 1.8 to 6.9 s for the full records).
		const quick = await pictureMatch(item.picture, item.read, language, {asian, known, textRoute: (read, lang) => findCandidates(read, lang, {api: quickApi}), wait: QUICK_MS});

		if (!alive || !S.findItem(session, id)) {
			return;
		}

		const quickMs = Math.round(performance.now() - started);
		let shown = null;

		// Recognised, but none of its sets is on this phone yet, and no
		// signal: it is named and its finishes loaded once there is signal.
		if (!(quick.unnamed && !online())) {
			showPicture(id, quick, {indexMs, language, ms: quickMs});
			shown = snapshot(S.findItem(session, id));
			maybeOpenFirst(id);
			// The finishes load beside the full records, not after them.
			loadVariants(id);
		}

		const full = await pictureMatch(item.picture, item.read, language, {asian, known, textRoute: (read, lang) => findCandidates(read, lang, {artwork})});

		if (!alive || !S.findItem(session, id)) {
			return;
		}

		const fullMs = Math.round(performance.now() - started);
		const current = S.findItem(session, id);

		if (!shown && full.unnamed && !online()) {
			change(() => S.markWaiting(session, id, 'catalog'));

			return;
		}

		if (!shown || sameAs(shown, current)) {
			showPicture(id, full, {fullMs: shown ? fullMs : null, indexMs, language, ms: shown ? quickMs : fullMs});
		}
		else if (current.report && current.report.match) {
			current.report = {...current.report, match: {...current.report.match, fullMs}};
			persist();
		}

		const after = S.findItem(session, id);

		if (after && after.card && after.variants === null) {
			await loadVariants(id);
		}

		if (!shown) {
			maybeOpenFirst(id);
		}
	}

	// What a picture answer left on the card, to tell whether anyone changed
	// it before the next one.
	const snapshot = (item) => ({card: item.card ? item.card.id : null, confirmed: item.confirmed, language: item.language, languageBy: item.languageBy});
	const sameAs = (before, item) => {
		const now = snapshot(item);

		return now.card === before.card && now.confirmed === before.confirmed && now.language === before.language && now.languageBy === before.languageBy;
	};

	// A picture answer onto the card: the match, the language a settled card
	// starts in, the scan report, and, behind it, the print in that language
	// and the label row read.
	function showPicture(id, found, {fullMs = null, indexMs = null, language, ms}) {
		const current = S.findItem(session, id);

		current.confirmed = false;
		current.timings = {...current.timings, match: ms};

		if (current.report) {
			current.report = {...current.report, match: S.reportOfMatch({...found, candidates: found.card ? [found.card, ...found.candidates.filter((c) => c !== found.card)] : found.candidates, routes: ['picture']}, {fullMs, indexMs, language, ms})};
		}

		change(() => {
			S.applyPicture(session, id, found);

			if (found.card) {
				S.defaultLanguage(session, id, lastLanguage(), undefined, {asian: lastAsianLanguage()});
			}
		});

		const after = S.findItem(session, id);

		if (after.card) {
			announce(`Added ${after.card.name}${after.language ? `, ${flagLanguageName(after.language)}` : ''}. ${plural(session.items.length, 'card')} in this session.`);
		}

		localiseLater(id);
		checkLabelLater(id);
	}

	// The card's name and picture in its language's print, read behind the
	// tray (a set record, kept on the phone once read).
	function localiseLater(id) {
		const item = S.findItem(session, id);

		if (!item || !item.card) {
			return;
		}

		const cardId = item.card.id;

		localPrint(item.card, item.language).then((local) => {
			const now = S.findItem(session, id);

			if (alive && now && now.card && now.card.id === cardId && (local || now.card.own)) {
				change(() => S.localisePrint(session, id, cardId, local));
			}
		}).catch(() => {});
	}

	// A card that starts in the last picked language has its label row read
	// in the background (a few small OCR calls), which corrects the language
	// when it clearly names another. Waits a moment, so the tray and the
	// sheet draw first.
	function checkLabelLater(id) {
		const image = cardImages.get(id);
		const item = S.findItem(session, id);

		// A card left with no language because its label row read nothing is
		// read again too: a Trainer or Energy then takes the Western pick.
		const open = item && (item.languageBy === 'default' || (!item.languageBy && !item.language && item.card && item.languageHint === 'non-latin'));

		if (!image || !open) {
			return;
		}

		cardImages.delete(id);
		setTimeout(async () => {
			let label = null;

			try {
				label = await readLanguageLabel(image);
			}
			catch {
				// No reader on this phone yet: the default stands.
				return;
			}

			const now = alive && S.findItem(session, id);

			if (!now) {
				return;
			}

			// Only a label row with no Latin text needs the category.
			const card = now.card;
			const category = card && !card.category && (!label || !label.code || label.code === 'non-latin') ? await cardCategory(card) : null;

			const later = alive && S.findItem(session, id);

			if (!later || (later.card && later.card.id) !== (card && card.id)) {
				return;
			}

			const changed = change(() => S.applyLabel(session, id, label, undefined, {asian: lastAsianLanguage(), category, western: lastLanguage()}));

			if (changed) {
				if (S.needsRematch(S.findItem(session, id))) {
					rematchItem(id);
				}
				else {
					localiseLater(id);
				}
			}
		}, 300);
	}

	// A language that lives in another catalog (a Japanese match changed to
	// English): look the card up again in that language.
	async function rematchItem(id) {
		const item = S.findItem(session, id);

		if (!item) {
			return;
		}

		if (!item.read && !item.picture) {
			// Added from the search, so there is nothing to look up again: search
			// in the new language. The card it had is no candidate there.
			change(() => {
				item.card = null;
				item.candidates = [];
				item.variants = null;
				item.variantId = null;
				item.confirmed = false;
				item.sure = false;
				item.why = `Search for this card in ${flagLanguageName(item.language)}.`;
			});

			return;
		}

		await matchItem(id);
	}

	async function loadVariants(id) {
		const item = S.findItem(session, id);

		if (!item || !item.card) {
			return;
		}

		const card = item.card;

		try {
			const variants = await cardVariants(card);

			if (alive && S.findItem(session, id)) {
				change(() => S.applyVariants(session, id, card.id, variants));
			}
		}
		catch (err) {
			if (alive && S.findItem(session, id)) {
				change(() => S.markWaiting(session, id, 'catalog'));
			}

			if (!(err instanceof WaitingForSignal)) {
				setNote(`A card's finishes did not load. ${err.message}`);
			}
		}
	}

	// The first scan of a session opens its sheet; later ones go straight to
	// the tray (plans/design-review.md: "The first scan opens the confirm
	// sheet; Scan next sends later cards straight to the tray").
	// The first scan of a session opens its sheet; with the scan report
	// switched on, or for a photo picked from the gallery, every one does.
	function maybeOpenFirst(id) {
		const wanted = openWhenMatched.delete(id) || draft.reportAlwaysOn();

		if ((!session.sheetShown || wanted) && !sheet && S.findItem(session, id)) {
			session.sheetShown = true;
			persist();
			openItem(id);
		}
	}

	// Picks up every card left unfinished: the app closed mid-read, or the
	// signal came back.
	async function resume() {
		for (const item of [...session.items]) {
			if (!alive) {
				return;
			}

			if (!S.findItem(session, item.id) || working.has(item.id)) {
				continue;
			}

			if (item.status === 'reading' || (item.status === 'waiting' && item.waitingFor === 'ocr')) {
				const blob = await draft.loadPhoto(`${item.id}:full`).catch(() => null);

				if (blob) {
					const frame = await blobImage(blob);

					await readItem(item.id, frame);
				}
				else {
					change(() => S.markLost(session, item.id));
				}
			}
			else if (item.status === 'matching' || (item.status === 'waiting' && !item.card) || S.needsRematch(item)) {
				await matchItem(item.id);
			}
			// A match made while some sets were out of reach (the name route
			// can answer offline from the lists on the phone) is made again
			// once they can be reached; that also loads its finishes.
			else if (item.partial && !item.confirmed && online()) {
				await matchItem(item.id);
			}
			else if (item.card && item.variants === null) {
				await loadVariants(item.id);
			}
		}
	}

	function onOnline() {
		drawStatus();
		resume().catch(() => {});
		refreshFamily();
	}

	function onOffline() {
		drawStatus();
	}

	// ------------------------------------------------------------ the camera

	// The guide inside the part of the video that shows (camera.js
	// layoutGuide), so its whole outline is on the screen whatever the room
	// above the tray.
	function placeGuide() {
		if (!camera || !video.videoWidth) {
			return;
		}

		const box = stage.getBoundingClientRect();

		if (!box.width || !box.height) {
			return;
		}

		geometry = {...layoutGuide(camera.frame, box), frame: {...camera.frame}, stage: {height: Math.round(box.height), width: Math.round(box.width)}};

		const {screen: place} = geometry;

		guide.style.left = `${place.x}px`;
		guide.style.top = `${place.y}px`;
		guide.style.width = `${place.w}px`;
		guide.style.height = `${place.h}px`;
		guide.hidden = false;
	}

	// The layout for the camera's frame as it is now (a phone turned, or the
	// camera switching resolution, changes it between resizes).
	function currentGeometry() {
		if (camera && video.videoWidth && (!geometry || geometry.frame.width !== video.videoWidth || geometry.frame.height !== video.videoHeight)) {
			placeGuide();
		}

		return geometry;
	}

	// The geometry as the scan report keeps it.
	function geometryReport(area, how) {
		const rect = (r) => `${Math.round(r.w)} x ${Math.round(r.h)} at ${Math.round(r.x)}, ${Math.round(r.y)}`;

		return {
			capture: rect(area.capture),
			frame: `${area.frame.width} x ${area.frame.height}`,
			guide: rect(area.guide),
			how,
			screen: rect(area.screen),
			stage: `${area.stage.width} x ${area.stage.height}`,
		};
	}

	function showCameraOff(err) {
		cameraOff.hidden = false;
		guide.hidden = true;
		shutter.disabled = true;
		cameraOff.replaceChildren(
			h('p', {class: 'scan-card-name', id: 'scan-camera-off-title'}, 'Camera is off'),
			h('p', {class: 'scan-muted'}, err && err.message ? err.message : 'The camera could not start.'),
			h('button', {class: 'scan-button scan-primary', id: 'scan-search-instead', onclick: addBySearch, type: 'button'}, 'Search by name or number'),
			h('button', {class: 'scan-button', id: 'scan-photo-instead', onclick: () => photoInput.click(), type: 'button'}, 'Pick a photo'),
			h('a', {class: 'scan-button', 'data-link': 'check', href: `${BASE}check`, id: 'scan-phone-check'}, 'Run phone check')
		);
	}

	// With no camera, a card can still join the tray from the search.
	function addBySearch() {
		const item = S.addCapture(session);

		item.status = 'ready';
		item.why = 'Search for the card, then pick its language.';
		persist();
		draw();
		openItem(item.id);
		session.sheetShown = true;

		const panel = document.getElementById('scan-search-panel');

		if (panel) {
			panel.hidden = false;
			document.getElementById('scan-search').focus();
		}
	}

	async function openCamera() {
		// Already on, or starting: hiding and showing the page during a
		// start must not open the camera twice.
		if (camera || cameraStart || !alive) {
			return;
		}

		const run = new AbortController();
		let started;

		cameraStart = run;

		try {
			started = await startCamera(video, {signal: run.signal});
		}
		catch (err) {
			if (run.signal.aborted) {
				// Left or hidden while starting: startCamera has stopped the
				// stream it opened.
				return;
			}

			cameraStart = null;

			if (alive) {
				showCameraOff(err instanceof CameraUnavailable ? err : new CameraUnavailable('The camera could not start.', err));
			}

			return;
		}

		cameraStart = null;

		if (!alive || document.hidden) {
			started.stop();

			return;
		}

		camera = started;
		cameraOpenedAt = performance.now();

		cameraOff.hidden = true;
		shutter.disabled = false;
		placeGuide();
		drawCameraControls();
		startLoop();
		requestWakeLock();
		startEngine();
	}

	// The reader starts as the screen opens, and again with the camera if it
	// failed: the picture index (about 1.4 MB, kept by the service worker).
	function startEngine() {
		if (engineState === 'ready' || engineState === 'loading') {
			return;
		}

		engineState = 'loading';
		drawStatus();
		// The picture index only: the OCR engine loads when a card needs text
		// (identify.js), so the screen opens without its download.
		loadFingerprints().then(() => {
			engineState = 'ready';
			drawStatus();
		}).catch(() => {
			engineState = 'unavailable';
			drawStatus();
		});
	}

	function drawCameraControls() {
		torchButton.hidden = !camera.torchSupported;

		const range = camera.zoomRange;

		if (!range) {
			zoomRow.hidden = true;

			return;
		}

		const steps = [1, 1.5, 2].filter((value) => value >= range.min && value <= range.max);

		zoomRow.replaceChildren(...steps.map((value) => h('button', {
			'aria-pressed': String(Math.abs((camera.zoom || 1) - value) < 0.05),
			class: 'scan-chip',
			onclick: async () => {
				try {
					await camera.setZoom(value);
				}
				catch {
					// Zoom stays where it was.
				}

				drawCameraControls();
			},
			type: 'button',
		}, `${value}x`)));
		zoomRow.hidden = steps.length < 2;
	}

	async function toggleTorch() {
		try {
			await camera.setTorch(!camera.torch);
		}
		catch {
			setNote('The torch could not be switched.');
		}

		torchButton.setAttribute('aria-pressed', String(Boolean(camera && camera.torch)));
	}

	function stopCamera() {
		clearInterval(loop);
		loop = null;

		if (cameraStart) {
			cameraStart.abort();
			cameraStart = null;
		}

		if (camera) {
			camera.stop();
			camera = null;
		}

		geometry = null;

		shutter.disabled = true;

		if (wakeLock) {
			wakeLock.release().catch(() => {});
			wakeLock = null;
		}
	}

	async function requestWakeLock() {
		try {
			wakeLock = navigator.wakeLock ? await navigator.wakeLock.request('screen') : null;
		}
		catch {
			wakeLock = null;
		}
	}

	function startLoop() {
		clearInterval(loop);
		loop = setInterval(() => {
			if (!camera || document.hidden || sheet) {
				return;
			}

			const area = currentGeometry();
			const shot = thumbnailFrame(video, thumbCanvas, area && area.capture);

			if (!shot) {
				return;
			}

			const thumb = shot.grey;
			const seen = presence(thumb, THUMB_W, THUMB_H, {colour: shot.colour});

			document.getElementById('scan-hint').textContent = seen.glare && seen.present ? 'Tilt to cut the glare.' : seen.small ? 'Move closer.' : 'Card inside the frame. Hold still.';
			guide.classList.toggle('is-seen', seen.present);

			if (detector.push(thumb, seen)) {
				capture('auto');
			}
		}, FRAME_MS);
	}

	function onVisibility() {
		if (document.hidden) {
			stopCamera();
		}
		else if (alive && !camera) {
			openCamera();
		}
	}

	function onResize() {
		if (camera) {
			placeGuide();
		}
	}

	// ------------------------------------------------------------ leaving

	// Close returns to where the person came from: back, when they came from
	// another screen in the app; My Cards, when the scanner was opened
	// directly (the home screen shortcut, a reload).
	function close() {
		if (history.state && history.state.inApp && history.length > 1) {
			history.back();
		}
		else {
			go('cards', {replace: true});
		}
	}

	tray.addEventListener('click', (event) => {
		const tile = event.target.closest('[data-item]');

		if (tile) {
			openItem(tile.dataset.item);
		}
	});

	document.addEventListener('visibilitychange', onVisibility);
	window.addEventListener('online', onOnline);
	window.addEventListener('offline', onOffline);
	window.addEventListener('resize', onResize);
	window.addEventListener('orientationchange', onResize);
	// The stage changes size without the window doing so too (the tray
	// growing, the browser's toolbar sliding away), and the camera's frame
	// changes size when the phone turns.
	const stageWatch = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null;

	if (stageWatch) {
		stageWatch.observe(stage);
	}

	video.addEventListener('resize', onResize);

	const stopOwned = onChange(() => refreshOwned());

	// ------------------------------------------------------------ start

	(async () => {
		try {
			session = (await draft.loadSession()) || S.newSession();
		}
		catch {
			session = S.newSession();
			setNote('This phone could not keep a draft tray; save before closing the app.');
		}

		if (!alive) {
			return;
		}

		await Promise.all(session.items.map((item) => loadPhotoUrl(item.id)));
		draft.prunePhotos(session.items.map((item) => item.id)).catch(() => {});
		draw();
		drawStatus();
		refreshOwned();
		refreshFamily();

		// The reader and the name lists start with the screen, alongside the
		// camera, so the first capture does not wait for them.
		startEngine();
		// The card index, read once, so a picture match can name a card from
		// it at once.
		cardIndex().then((index) => {
			knownIndex = index;
		}).catch(() => {});

		if (online()) {
			warmNameRoute();
		}

		openCamera();
		resume().catch(() => {});
	})();

	return () => {
		alive = false;
		stopCamera();
		closeSheet();
		persist();
		stopOwned();
		document.removeEventListener('visibilitychange', onVisibility);
		window.removeEventListener('online', onOnline);
		window.removeEventListener('offline', onOffline);
		window.removeEventListener('resize', onResize);
		window.removeEventListener('orientationchange', onResize);

		if (stageWatch) {
			stageWatch.disconnect();
		}

		video.removeEventListener('resize', onResize);
		document.documentElement.classList.remove('scan-open');

		for (const url of photoUrls.values()) {
			URL.revokeObjectURL(url);
		}

		photoUrls.clear();
		releaseEngineSoon();
	};
}
