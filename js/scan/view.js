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

import {addCard, deleteCard, listCards, onChange} from '../collection.js';
import {saveToCardIndex} from '../catalog.js';
import {BASE, go, h} from '../dom.js';
import {flagLanguageName} from '../flags.js';
import {openSheet} from '../sheet.js';
import {familyWishlists, refreshFamilyWishlists} from '../wishlist.js';
import {CameraUnavailable, grabFrame, layoutGuide, startCamera, thumbnail, thumbnailFrame} from './camera.js';
import * as draft from './draft.js';
import {EngineUnavailable, identify, releaseEngineSoon} from './identify.js';
import {blobImage, imageBlob} from './image.js';
import {cardVariants, findCandidates, WaitingForSignal, warmNameRoute} from './match.js';
import {loadFingerprints, pictureMatch, pictureVerdict} from './picture.js';
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
const PHOTO_HEIGHT = 420;

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
	let camera = null;
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
			h('div', {class: 'scan-tray-head'}, count, h('div', {class: 'scan-tray-actions'}, photoButton, setAllButton), photoInput),
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
		remove,
		get reportOn() {
			return draft.reportAlwaysOn();
		},
		reportText: (id) => S.reportText(S.findItem(session, id), {device: deviceInfo()}),
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
		setLanguage: (id, code) => {
			const rematch = change(() => S.setLanguage(session, id, code));

			if (rematch) {
				rematchItem(id);
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
			children.push(h('span', {id: 'scan-saved-line'}, `Saved ${plural(session.lastSave.count, 'card')}`),
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
		artworks.delete(id);
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
		const {rematch} = change(() => S.setForAll(session, field, value, options));

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

		discarded = null;
		noteText = null;
		S.afterSave(session, saved);

		for (const item of skipped) {
			S.removeItem(session, item.id);
		}

		for (const id of leaving) {
			dropPhoto(id);
		}

		persist();
		draft.prunePhotos(session.items.map((item) => item.id)).catch(() => {});
		closeSheet();
		announce(`Saved ${plural(saved.length, 'card')}.`);
		await refreshOwned();
	}

	async function undoSession() {
		const ids = S.takeUndo(session);

		persist();

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
		const thumb = thumbnail(video, thumbCanvas, area && area.capture);

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

		await readItem(item.id, frame, {auto: how === 'auto', captureMs, fullSaved, geometry: area ? geometryReport(area, how) : null});
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

	async function readItemNow(id, frame, {auto = false, captureMs = null, fullSaved = null, geometry: area = null, photo = false, straight = false} = {}) {
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
			}}, photo, straight});
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
	async function pictureItemNow(id) {
		const item = S.findItem(session, id);
		const started = performance.now();
		const language = item.language || item.languageHint;
		const artwork = artworks.get(id) || null;
		const found = await pictureMatch(item.picture, item.read, language, {textRoute: (read, lang) => findCandidates(read, lang, {artwork})});

		if (!alive || !S.findItem(session, id)) {
			return;
		}

		if (found.unnamed && !online()) {
			// Recognised, but none of its sets is on this phone yet: it is named
			// and its finishes loaded once there is signal.
			change(() => S.markWaiting(session, id, 'catalog'));

			return;
		}

		const current = S.findItem(session, id);

		current.confirmed = false;
		current.timings = {...current.timings, match: Math.round(performance.now() - started)};

		if (current.report) {
			current.report = {...current.report, match: S.reportOfMatch({...found, candidates: found.card ? [found.card, ...found.candidates.filter((c) => c !== found.card)] : found.candidates, routes: ['picture']}, {language, ms: current.timings.match})};
		}

		change(() => S.applyPicture(session, id, found));

		if (current.card) {
			announce(`Added ${current.card.name}${current.language ? `, ${flagLanguageName(current.language)}` : ''}. ${plural(session.items.length, 'card')} in this session.`);
		}

		await loadVariants(id);
		maybeOpenFirst(id);
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

			document.getElementById('scan-hint').textContent = seen.glare && seen.present ? 'Tilt to cut the glare.' : 'Card inside the frame. Hold still.';
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
