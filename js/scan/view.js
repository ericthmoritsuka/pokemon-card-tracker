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
//
// Scanning flows card after card with no tap between them (Eric,
// 2026-10-09): no sheet opens by itself after a camera scan, a buzz says
// whether each card was recognised or needs a look, and a count over the
// camera says how many are in the tray. With Record every scan on (Phone
// check), each scan is kept in the scan log (js/scan/log.js).

import {placeScanned, unplaceScanned, waitingPlaceholderList} from '../binders.js';
import {addCard, deleteCard, listCards, onChange} from '../collection.js';
import {cardIndex, saveToCardIndex} from '../catalog.js';
import {BASE, go, h} from '../dom.js';
import {flagLanguageName} from '../flags.js';
import {openSheet} from '../sheet.js';
import {familyWishlists, refreshFamilyWishlists} from '../wishlist.js';
import {boxAround, CameraUnavailable, grabFrame, layoutGuide, startCamera, thumbnailFrame, viewFrame} from './camera.js';
import * as draft from './draft.js';
import {createDropDetector, dropCapture, SHARP_WAIT_MS, sharpEnough, takenCard} from './drop.js';
import {EngineUnavailable, identify, identifyPictureAway, identifyText, readLanguageLabel, releaseEngineSoon, warmPicture} from './identify.js';
import {blobImage, imageBlob, saveCaptureImages} from './image.js';
import * as scanLog from './log.js';
import {cardCategory, cardVariants, DEFAULT_API, findCandidates, WaitingForSignal, warmNameRoute} from './match.js';
import {knownFrom, localPrint, noCard, pictureKey, pictureMatch, pictureVerdict, repeatOfLast, repeatOfPrevious} from './picture.js';
import * as S from './session.js';
import {confirmSheet, doneSheet, reportSheet, setAllSheet} from './sheets.js';
import {coarse, COLOURLESS, createAutoCapture, createHolderCapture, difference, FIND_SIDE, FIND_SIDE_CAPTURE, findCard, presence, STILL, THUMB_H, THUMB_W} from './steady.js';
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

// Holder mode (Eric, 2026-10-09, steady.js createHolderCapture): the phone
// held still in a stand over cards dropped under it. Remembered on the
// phone, off at first.
const HOLDER_KEY = 'card-tracker:scan-holder';

function holderOn() {
	try {
		return localStorage.getItem(HOLDER_KEY) === 'on';
	}
	catch {
		return false;
	}
}

function rememberHolder(on) {
	try {
		localStorage.setItem(HOLDER_KEY, on ? 'on' : 'off');
	}
	catch {
		// Not kept; the next visit starts as before.
	}
}

// Holder mode's lighting tip (Eric's videos, 2026-10-09: the phone's torch
// and a lamp beside the box both gave sure answers; a lamp high behind the
// box gave the most cards to check, and glare on holo foil is worst under
// one light from above), shown once holder mode is on until dismissed.
const HOLDER_TIP = 'Light tip: the torch or a lamp beside the box works best. Cover the phone\'s indicator light.';
const TIP_KEY = 'card-tracker:scan-holder-tip';

function tipDismissed() {
	try {
		return localStorage.getItem(TIP_KEY) === 'off';
	}
	catch {
		return false;
	}
}

function rememberTipDismissed() {
	try {
		localStorage.setItem(TIP_KEY, 'off');
	}
	catch {
		// Shown again next visit.
	}
}

// A card found anywhere in the frame is taken on its own only when its
// long side is at least this share of the guide's height; a smaller one
// says "Move closer" (Q-19) and is taken only by the shutter.
const MIN_CARD_SHARE = 0.5;

// Two boxes round a found card (frame pixels) closer than this share of
// their size on every side are the same place: the box is kept, so a card
// held still is compared with itself frame after frame (steady.js), not
// with a box a pixel off.
const SAME_BOX = 0.06;

const sameBox = (a, b, share = SAME_BOX) => Boolean(a && b) && ['x', 'y', 'w', 'h'].every((key) => Math.abs(a[key] - b[key]) <= share * Math.max(a.w, a.h, b.w, b.h));

// How much two boxes overlap: their shared area over their joint area.
function overlap(a, b) {
	if (!a || !b) {
		return 0;
	}

	const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
	const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

	return (w * h) / (a.w * a.h + b.w * b.h - w * h);
}

// Two outlines of one card still in place (its edge and its inner border,
// found in turn from frame to frame) keep the box: the box only moves
// when the card does.
const STEADY_OVERLAP = 0.85;
const samePlace = (a, b) => sameBox(a, b) || overlap(a, b) >= STEADY_OVERLAP;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The shutter pressed with no whole card in the frame keeps looking for
// this long, every SHUTTER_STEP_MS, for a frame where a whole card is
// found and still, then takes the picture anyway (Eric's log, version 32:
// the shutter was pressed exactly when auto capture could not find the
// card's edges, and took the bad crop).
const SHUTTER_WAIT_MS = 1000;
const SHUTTER_STEP_MS = 60;

// The buzzes (navigator.vibrate, in milliseconds). The capture's tick says
// the picture was taken, so the next card can go in; once the card is read,
// one short buzz says it was recognised, and a double one that it needs a
// look. The read takes a few tenths of a second at least, so the tick and
// the answer never run together.
const BUZZ_CAPTURE = 30;
const BUZZ_SURE = 40;
const BUZZ_LOOK = [60, 80, 60];

function buzz(pattern) {
	if (navigator.vibrate) {
		try {
			navigator.vibrate(pattern);
		}
		catch {
			// No haptics here.
		}
	}
}

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
	// When the camera last opened (performance.now()), for Q-20's window,
	// and the cards captured since then: Q-20 is for a card added before
	// the camera opened; one added since is the repeat bar's (askRepeat).
	let cameraOpenedAt = -Infinity;
	const sinceOpen = new Set();
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
	// The card last taken out with its tile's x, until Undo, another
	// removal, Done, or Discard: {item, index}. Its photos stay until then.
	// Scanning on keeps it, so a run of captures does not lose the Undo.
	let removed = null;
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
	// Camera captures not yet answered, which buzz once when their first
	// answer comes. Memory only: a card read again after the app reopens
	// does not buzz.
	const toBuzz = new Set();
	// The last few scans' captures and what was found on them (identify's
	// trace), for "Save capture image". Memory only.
	const traces = new Map();
	const detector = createAutoCapture();
	// Holder mode's detector; it also measures how long the picture has been
	// still, for the scan log, in either mode.
	const holderDetector = createHolderCapture();
	// Holder mode's drop detector (drop.js).
	const dropDetector = createDropDetector();
	let holder = holderOn();
	// The box round the card found in the frame, kept while the card stays
	// in place (SAME_BOX), and where the last frame's thumbnail came from.
	let stableBox = null;
	let thumbFrom = null;
	// Whether the picture settled on a card running off the frame.
	let pileHigh = false;
	// The shutter is waiting for a whole card (SHUTTER_WAIT_MS).
	let shutterBusy = false;
	// The camera captures' pictures as soon as they are matched, before their
	// photos are saved, so the next capture can tell whether it repeats one
	// (askRepeat), and the reads in progress.
	const pictures = new Map();
	const readings = new Map();
	// How long each capture waited in the picture queue and the text queue
	// before its turn (ms), for the scan report.
	const queueWaits = new Map();
	// A Review run through the cards that need a look (openReview), or null.
	let review = null;
	const viewCanvas = document.createElement('canvas');
	const fineCanvas = document.createElement('canvas');
	// Where the guide is (camera.js layoutGuide): on the screen, and the
	// guide and capture area in the camera's frame. Laid out again when the
	// screen or the camera's frame changes size.
	let geometry = null;
	const thumbCanvas = document.createElement('canvas');

	const video = h('video', {'aria-hidden': 'true', autoplay: true, class: 'scan-video', id: 'scan-video', muted: true, playsinline: true});
	const guide = h('div', {'aria-hidden': 'true', class: 'scan-guide', hidden: true, id: 'scan-guide'}, h('span', {class: 'scan-hint', id: 'scan-hint'}, 'Card inside the frame. Hold still.'));
	const status = h('p', {'aria-live': 'polite', class: 'scan-top-status', id: 'scan-top-status', hidden: true});
	// The running count over the camera ("12 cards · 2 to check"), so a
	// long run needs no look at the tray.
	const runCount = h('p', {'aria-live': 'polite', class: 'scan-run-count', hidden: true, id: 'scan-run-count'});
	// The repeat bar (askRepeat), at the foot of the camera, clear of the
	// shutter. The region is always there, so what appears in it is read
	// out.
	const repeatBar = h('div', {'aria-live': 'polite', class: 'scan-repeat', id: 'scan-repeat', role: 'group', 'aria-label': 'Same card again'});
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
	const holderSwitch = h('button', {
		'aria-checked': String(holder),
		'aria-label': 'Holder mode: the phone stays still in a stand over cards dropped under it',
		class: 'scan-chip scan-holder',
		id: 'scan-holder',
		onclick: () => setHolder(!holder),
		role: 'switch',
		type: 'button',
	}, 'Holder');
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

	// Holder mode's lighting tip, one line, until dismissed (drawTip).
	const tip = h('p', {class: 'scan-tip', hidden: true, id: 'scan-tip'},
		h('span', null, HOLDER_TIP),
		h('button', {'aria-label': 'Dismiss the lighting tip', class: 'scan-tip-close', id: 'scan-tip-close', onclick: () => {
			rememberTipDismissed();
			drawTip();
		}, type: 'button'}, h('span', {'aria-hidden': 'true'}, '×')));
	const stage = h('div', {class: 'scan-stage', id: 'scan-stage'}, video, guide, h('div', {class: 'scan-stage-top'}, status, runCount, tip), holderSwitch, repeatBar, cameraOff);
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
		openReview,
		review: (id) => reviewState(id),
		reviewNext: () => reviewNext(),
		reviewStop: () => reviewStop(),
		openSetAll,
		get owned() {
			return owned;
		},
		photoUrl: (id) => photoUrls.get(id) || null,
		get placeholders() {
			return placeholders;
		},
		remove,
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
		setCopies: (id, count) => change(() => S.setCopies(session, id, count)),
		setFinish: (id, variantId) => {
			scanLog.lockFirst(id);
			change(() => S.setFinish(session, id, variantId));
		},
		setPlace: (id, on) => change(() => S.setPlace(session, id, on)),
		setLanguage: (id, code) => {
			scanLog.lockFirst(id);

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

	// A change the scanner makes on its own to card `id` (a read, a match,
	// finishes loaded, the label row): the scan log keeps it as the
	// scanner's answer until a change by hand, and a camera capture buzzes
	// once its first answer is in.
	function scannerChange(id, fn) {
		const result = change(fn);

		answered(id);

		return result;
	}

	function answered(id) {
		const item = S.findItem(session, id);

		if (!item) {
			return;
		}

		scanLog.noteFirst(id, answerOf(item), {report: item.report || null, timings: item.timings || null});

		if (item.status === 'reading' || item.status === 'matching' || !toBuzz.has(id)) {
			return;
		}

		toBuzz.delete(id);

		// Waiting for signal: it resolves on its own, with no buzz.
		if (item.status !== 'waiting') {
			buzz(S.needsLook(item) ? BUZZ_LOOK : BUZZ_SURE);
		}
	}

	// What the scanner answered for a card, as the scan log keeps it.
	function answerOf(item) {
		const card = item.card;

		return {
			card: card ? {catalog: card.catalog || null, id: card.id, lang: card.lang || null, name: card.name, number: `${card.localId}${card.official ? `/${card.official}` : ''}`, set: card.setName || card.setId || null} : null,
			finish: item.variantId || null,
			labelCheck: item.labelCheck || null,
			language: item.language || null,
			languageBy: item.languageBy || null,
			languageSource: S.languageSource(item),
			status: S.blocker(item) || 'ready',
			sure: Boolean(item.sure),
			why: item.why || null,
		};
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

		const running = items.length ? `${plural(items.length, 'card')}${summary.look ? ` · ${summary.look} to check` : ''}` : '';

		// "N to check" is a way into the Review run (openReview).
		if (runCount.textContent !== running) {
			runCount.replaceChildren(items.length ? plural(items.length, 'card') : '', ...(summary.look ? [' · ', h('button', {'aria-label': `${summary.look} to check: check them one after the other`, class: 'scan-look-count', id: 'scan-look-count', onclick: () => openReview(), type: 'button'}, `${summary.look} to check`)] : []));
		}

		runCount.hidden = !items.length;
		setAllButton.hidden = items.length < 2;
		clearButton.hidden = !items.length;
		doneButton.disabled = !items.length;
		doneButton.textContent = items.length ? `Done ${items.length}${summary.look ? ` · ${summary.look} to check` : ''}` : 'Done';

		drawNote();

		// A Review run moves on from a card once it no longer needs a look.
		if (review && sheet && sheet.itemId === review.current && reviewMoved()) {
			return;
		}

		if (sheet) {
			// The sheet is redrawn from the session, only when what it shows
			// changed: in holder mode cards keep arriving while one is checked,
			// and a redraw under the finger swapped the button being tapped, or
			// shrank the sheet so a second tap landed on the backdrop and closed
			// it (Eric, 2026-10-09: "I select the card, it closes"). It never
			// shrinks while open. Focus stays on the same control, found again
			// by its id.
			const mark = sheetMark(summary);

			if (mark !== null && mark === sheet.mark) {
				return;
			}

			sheet.mark = mark;

			const focused = sheet.el.contains(document.activeElement) ? document.activeElement.id : null;
			const before = sheet.el.offsetHeight;

			sheet.refresh();

			if (sheet && sheet.el.offsetHeight < before) {
				sheet.el.style.minHeight = `${before}px`;
			}

			if (focused && sheet && !sheet.el.contains(document.activeElement)) {
				const again = document.getElementById(focused);

				if (again) {
					again.focus({preventScroll: true});
				}
			}
		}
	}

	// What the open sheet shows, to tell whether it needs a redraw: its card
	// and what the sheet says about the session around it. Null for a sheet
	// with no card of its own (Done, Set for all), which is always redrawn.
	function sheetMark(summary) {
		const item = sheet && sheet.itemId ? S.findItem(session, sheet.itemId) : null;

		if (!item) {
			return null;
		}

		const run = review && review.current === item.id ? reviewState(item.id) : null;

		return JSON.stringify([item, photoUrls.has(item.id), session.items.length, summary.look, summary.waiting, summary.total, run, owned.size, family.length, placeholders.length, Boolean(session.lastSave)]);
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
		else if (removed) {
			children.push(h('span', {id: 'scan-removed-line'}, `Removed ${removed.item.card ? removed.item.card.name : 'the card'}.`),
				h('button', {class: 'scan-text-button', id: 'scan-undo-remove', onclick: undoRemove, type: 'button'}, 'Undo'));
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
		holderDetector.pause();

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
	// what opened it). Back, Escape, or Close end a Review run.
	function sheetClosed() {
		endReview();
		sheetHandle = null;
		sheet = null;
		sheetLayer.replaceChildren();
		sheetLayer.hidden = true;
		screen.classList.remove('has-sheet');
		detector.resume();
		holderDetector.resume();
	}

	function openItem(id) {
		if (!S.findItem(session, id)) {
			return;
		}

		endReview();

		showSheet(confirmSheet(ctx, id));
	}

	// ------------------------------------------------------------ Review

	// Review (Eric, 2026-10-09): the cards that need a look open one after
	// the other, in the tray's order (newest first) from the one tapped,
	// round to the start. Every way in starts a run: a tile that needs a
	// look, the "N to check" count over the camera, Done's Review, and Save
	// when a card still needs a look. Once the card open no longer needs a
	// look (the right card tapped, its language picked), the next one opens
	// by itself, a moment later so the change shows; Next card skips to it
	// at once. After the last, the camera comes back (version 36; scanning
	// goes on). Stop, Back, or Close end the run, and the cards left stay
	// marked in the tray. A card dropped while the run is open joins it.
	//
	// review: {current, seen, timer}: the card open, the cards opened in this
	// run (a card skipped is not opened again), and the pending move.
	const REVIEW_MOVE_MS = 700;

	// The cards that need a look, in the tray's order from card `startId`
	// (or from the newest), round to the start.
	function lookOrder(startId = null) {
		const shown = [...session.items].reverse();
		const at = startId ? Math.max(0, shown.findIndex((item) => item.id === startId)) : 0;

		return [...shown.slice(at), ...shown.slice(0, at)].filter((item) => S.needsLook(item));
	}

	const unseenLook = () => (review ? lookOrder(review.current).find((item) => !review.seen.has(item.id)) || null : null);

	function openReview(startId = null) {
		const [first] = lookOrder(startId);

		if (!first) {
			if (startId) {
				openItem(startId);
			}

			return;
		}

		endReview();
		review = {current: first.id, seen: new Set([first.id]), timer: 0};
		showSheet(confirmSheet(ctx, first.id));
	}

	// The run, as the confirm sheet of card `id` shows it: which card of how
	// many to check, and whether another follows. Null outside a run.
	function reviewState(id) {
		if (!review || review.current !== id) {
			return null;
		}

		const left = lookOrder(id).filter((item) => !review.seen.has(item.id)).length;

		return {index: review.seen.size, next: left > 0, total: review.seen.size + left};
	}

	// Called as the tray is drawn: the card open was taken out (the next one
	// opens at once) or no longer needs a look (it opens after a moment).
	// Returns true when the sheet was swapped.
	function reviewMoved() {
		const item = S.findItem(session, review.current);

		if (!item) {
			reviewNext();

			return true;
		}

		if (!S.needsLook(item) && !review.timer) {
			const current = review.current;

			review.timer = setTimeout(() => {
				if (!review || review.current !== current) {
					return;
				}

				review.timer = 0;

				const now = S.findItem(session, current);

				if (!now || !S.needsLook(now)) {
					reviewNext();
				}
			}, REVIEW_MOVE_MS);
		}

		return false;
	}

	function reviewNext() {
		if (!review) {
			return;
		}

		clearTimeout(review.timer);
		review.timer = 0;

		const next = unseenLook();

		if (!next) {
			endReview();
			announce('No more cards to check.');
			closeSheet();

			return;
		}

		review.current = next.id;
		review.seen.add(next.id);
		showSheet(confirmSheet(ctx, next.id));
	}

	function reviewStop() {
		endReview();
		closeSheet();
	}

	function endReview() {
		if (review) {
			clearTimeout(review.timer);
			review = null;
		}
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
		scanLog.lockFirst(id);

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
		scanLog.lockFirst(id);
		change(() => S.addByHand(session, id, fields));
	}

	// Takes a card out of the tray. outcome: how the scan log records it
	// (kept only when the scan has none yet: a card the scanner dropped
	// already says why), or null to leave it for later (the repeat bar).
	function remove(id, outcome = {kind: 'removed'}) {
		if (outcome) {
			scanLog.setOutcome(id, outcome);
		}

		toBuzz.delete(id);
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

	// The tile's x: out of the tray at once, with Undo, which puts it back
	// exactly as it was (its read, answer, and choices). The sheet does not
	// open.
	function removeTile(id) {
		const index = session.items.findIndex((item) => item.id === id);

		if (index < 0) {
			return;
		}

		forgetRemoved();
		removed = {index, item: JSON.parse(JSON.stringify(session.items[index]))};
		noteText = null;
		scanLog.setOutcome(id, {kind: 'removed'});
		toBuzz.delete(id);
		forgetCard([id]);
		change(() => S.removeItem(session, id));
		announce(`Removed ${removed.item.card ? removed.item.card.name : 'the card'}. Undo is below the camera.`);
	}

	function undoRemove() {
		if (!removed) {
			return;
		}

		const {index, item} = removed;

		removed = null;
		session.items.splice(Math.min(index, session.items.length), 0, item);
		scanLog.setOutcome(item.id, null);
		persist();
		draw();
		announce(`${item.card ? item.card.name : 'The card'} is back.`);
		// A card taken out while it was read is read again.
		resume().catch(() => {});
	}

	// The removed card's photos go once Undo can no longer bring it back.
	function forgetRemoved() {
		if (!removed) {
			return;
		}

		const {id} = removed.item;

		removed = null;
		artworks.delete(id);
		cardImages.delete(id);
		progress.delete(id);
		draft.deletePhoto(id).catch(() => {});
		draft.deletePhoto(`${id}:full`).catch(() => {});
		dropPhoto(id);
		drawNote();
	}

	function applySetAll(field, value, options) {
		const {changed, rematch} = change(() => S.setForAll(session, field, value, options));

		if (field !== 'condition') {
			for (const id of changed) {
				scanLog.lockFirst(id);
			}
		}

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
			openReview();

			return;
		}

		const rows = S.entriesToSave(session, owned, {skipOwned});

		forgetRemoved();
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
		const savedIds = [...new Set(saved.map((row) => row.itemId))];
		const records = savedIds.map((id) => rows.find((row) => row.itemId === id)).map((row) => {
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

		for (const id of savedIds) {
			const row = rows.find((one) => one.itemId === id);

			scanLog.savedOutcome(id, {card: row.fields.card_id, catalog: row.fields.catalog, copies: saved.filter((done) => done.itemId === id).length, finish: row.fields.variant_id, language: row.fields.language});
		}

		for (const item of skipped) {
			scanLog.setOutcome(item.id, {kind: 'skipped', why: 'already owned'});
		}

		S.afterSave(session, saved);
		// Which scans Undo session takes back, for the scan log.
		session.lastSave.items = saved.map((row) => row.itemId);

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
		const undone = (session.lastSave && session.lastSave.items) || [];
		const ids = S.takeUndo(session);

		for (const id of undone) {
			scanLog.markUndone(id);
		}

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

		forgetRemoved();

		discarded = kept.items.length ? kept : null;
		forgetCard(kept.items.map((item) => item.id));

		for (const item of kept.items) {
			scanLog.setOutcome(item.id, {kind: 'discarded'});
			toBuzz.delete(item.id);
		}

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
			scanLog.setOutcome(item.id, null);
		}

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

	// What the camera shows now (Eric, 2026-10-09): the card found anywhere
	// in the part of the frame on the screen (steady.js findCard), judged as
	// a card on a thumbnail of the box round it with every check made on the
	// guide's since version 17 (presence: stripes, a colourless sheet, a card
	// too far away); with no card found there, the guide's capture area,
	// judged as before. fine: the finer copy, for the corners at the moment
	// of capture (its box is then not kept as the steady one).
	//
	// Returns {card, seen, shot, view, touching}, or null before the camera
	// has a picture: card is the card found ({quad, others, box, angle,
	// ratio, upright, small}, frame pixels; others are other outlines found
	// close to it, for the picture to choose from), or null; seen presence's
	// verdict on shot, the thumbnail judged; view the copy searched; touching
	// whether, with no card found, a card-shaped outline runs off the frame.
	function look({fine = false} = {}) {
		const area = currentGeometry();

		if (!area || !video.videoWidth) {
			return null;
		}

		const view = viewFrame(video, viewCanvas, area.view, fine ? FIND_SIDE_CAPTURE : FIND_SIDE);

		if (!view) {
			return null;
		}

		const found = findCard(view.grey, view.width, view.height);
		const toFrame = (p) => ({x: view.rect.x + p.x / view.scale, y: view.rect.y + p.y / view.scale});

		if (found.quad) {
			// The outlines found, in frame pixels, the best first. The one where
			// the card was found a moment ago is kept while it is still among
			// them: two outlines a few pixels apart (the card's edge and its
			// inner border) can trade places from frame to frame.
			const all = [{angle: found.angle, corners: found.quad, ratio: found.ratio, upright: found.upright}, ...found.others]
				.map((one) => ({...one, box: boxAround(area.frame, one.corners.map(toFrame)), corners: one.corners.map(toFrame)}));
			const chosen = (!fine && all.find((one) => samePlace(one.box, stableBox))) || all[0];
			const quad = chosen.corners;
			const long = (Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y) + Math.hypot(quad[2].x - quad[1].x, quad[2].y - quad[1].y)) / 2;
			const small = long < area.guide.h * MIN_CARD_SHARE;
			let box = chosen.box;

			if (!fine) {
				if (samePlace(box, stableBox)) {
					box = stableBox;
				}
				else {
					stableBox = box;
				}
			}

			const shot = thumbnailFrame(video, thumbCanvas, box);
			// A card standing up, turned no more than presence turns back, is
			// judged the way a card held to the guide is; one lying on its side,
			// or turned further, has its colour to show it is no sheet of paper.
			const upright = chosen.upright && Math.abs(chosen.angle) <= 20;
			const judged = !shot ? null : upright
				? presence(shot.grey, THUMB_W, THUMB_H, {colour: shot.colour})
				: {detail: 99, edges: {left: 0, right: 0}, glare: false, present: shot.colour >= COLOURLESS, reason: shot.colour >= COLOURLESS ? null : 'colourless', small: false, turn: chosen.angle};

			if (judged && judged.present) {
				const inBox = (c) => c.x >= box.x && c.y >= box.y && c.x <= box.x + box.w && c.y <= box.y + box.h;
				const others = all.filter((one) => one !== chosen && one.corners.every(inBox)).map(({angle, corners, ratio, upright}) => ({angle, corners, ratio, upright}));
				const card = {angle: chosen.angle, box, others, quad, ratio: chosen.ratio, small, upright: chosen.upright};

				return {card, seen: small ? {...judged, present: false, small: true} : judged, shot, touching: false, view};
			}
		}
		else if (!fine) {
			stableBox = null;
		}

		const shot = thumbnailFrame(video, thumbCanvas, area.capture);

		return shot ? {card: null, seen: presence(shot.grey, THUMB_W, THUMB_H, {colour: shot.colour}), shot, touching: found.touching, view} : null;
	}

	const whole = (now) => Boolean(now && now.card && !now.card.small && now.seen.present);

	// The shutter: a whole card found in the frame now is taken at once;
	// otherwise the frames of the next SHUTTER_WAIT_MS are looked at for one
	// where a whole card is found and still (the same box, its thumbnail
	// within STILL of the frame before), which is taken; with none, the
	// picture is taken anyway when the time is up. The shutter always takes
	// a picture. Returns {now, shutterFound, shutterWaitMs}, or null when the
	// camera went away meanwhile.
	async function waitForCard() {
		const started = performance.now();
		const first = look({fine: true});

		if (whole(first)) {
			return {now: first, shutterFound: true, shutterWaitMs: 0};
		}

		shutterBusy = true;
		shutter.setAttribute('aria-busy', 'true');

		try {
			let before = null;

			while (performance.now() - started < SHUTTER_WAIT_MS) {
				await sleep(SHUTTER_STEP_MS);

				if (!alive || !camera) {
					return null;
				}

				const next = look();

				if (whole(next) && whole(before) && sameBox(next.card.box, before.card.box) && difference(coarse(next.shot.grey), coarse(before.shot.grey)) <= STILL) {
					const fine = look({fine: true});

					return {now: whole(fine) ? fine : next, shutterFound: true, shutterWaitMs: Math.round(performance.now() - started)};
				}

				before = next;
			}

			return {now: look({fine: true}), shutterFound: false, shutterWaitMs: Math.round(performance.now() - started)};
		}
		finally {
			shutterBusy = false;
			shutter.removeAttribute('aria-busy');
		}
	}

	// Takes the picture. how: 'auto' or 'shutter'; looked: what the frame
	// loop saw (look) when auto capture fired; settleMs: how long the
	// picture had been still by then, for the scan log.
	//
	// The part of the frame cut is the box round the card found in it, so a
	// card larger than the guide, beside it, or turned is whole in the
	// capture, and the outlines found are handed to identify.js to cut by
	// their own corners; with no card found, the guide's capture area, as
	// before.
	async function capture(how, {looked = null, settleMs = null} = {}) {
		if (!camera || !video.videoWidth || shutterBusy) {
			return;
		}

		let now = null;
		let shutterFound = null;
		let shutterWaitMs = null;

		if (how === 'shutter') {
			const waited = await waitForCard();

			if (!waited || !camera || !video.videoWidth) {
				return;
			}

			({now, shutterFound, shutterWaitMs} = waited);
		}
		else {
			const fine = look({fine: true});

			now = fine && fine.card ? fine : looked || fine;
		}

		const area = currentGeometry();
		const card = now && now.card && (how === 'shutter' || !now.card.small) ? now.card : null;
		const region = card ? boxAround(area.frame, [...card.quad, ...card.others.flatMap((other) => other.corners)]) : area && area.capture;
		const grabbed = performance.now();
		const frame = grabFrame(video, region);
		const captureMs = Math.round(performance.now() - grabbed);
		const shot = now ? now.shot : thumbnailFrame(video, thumbCanvas, area && area.capture);
		// What the frame held as it was taken, for telling a frame with no
		// card from one with a card too far away (Q-19).
		const seen = now ? now.seen : shot ? presence(shot.grey, THUMB_W, THUMB_H, {colour: shot.colour}) : null;
		// The detectors compare what follows with the thumbnail the frame
		// loop saw (the steady box), not the finer copy's.
		const steadyShot = looked && looked.shot ? looked.shot : shot;

		detector.captured(steadyShot ? steadyShot.grey : null);
		holderDetector.captured();

		// The shutter in holder mode: the card it took is the pile now, not a
		// drop still to take.
		if (holder) {
			dropDetector.reframe();
			pendingDrop = null;
		}
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

		toBuzz.add(item.id);
		sinceOpen.add(item.id);
		scanLog.startEntry(item.id, {at: item.captured_at, how, phone: deviceInfo(), source: 'camera'});
		persist();
		draw();

		// The full capture is kept until it is read, so a read cut short by the
		// app closing starts again next time.
		const fullSaved = imageBlob(frame, {quality: 0.92}).then((blob) => draft.savePhoto(`${item.id}:full`, blob)).catch(() => {});

		// Where the guide sits in the capture, for identify.js to fingerprint
		// it as one more crop, when no card was found in the frame; else the
		// outlines found, in the capture's pixels.
		const guideIn = !card && area && area.capture ? {h: area.guide.h, w: area.guide.w, x: area.guide.x - area.capture.x, y: area.guide.y - area.capture.y} : null;
		const quads = card ? [{...card, corners: card.quad}, ...card.others].map((quad) => ({corners: quad.corners.map((c) => ({x: c.x - region.x, y: c.y - region.y})), ratio: quad.ratio, upright: quad.upright})) : [];

		await readItem(item.id, frame, {auto: how === 'auto', captureMs, fullSaved, geometry: area ? geometryReport(area, how, {card, region, settleMs, shutterFound, shutterWaitMs}) : null, guide: guideIn, quads, seen});
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
		scanLog.startEntry(item.id, {at: item.captured_at, how: null, phone: deviceInfo(), source: 'photo'});
		persist();
		draw();

		const fullSaved = imageBlob(frame, {quality: 0.92}).then((blob) => draft.savePhoto(`${item.id}:full`, blob)).catch(() => {});

		await readItem(item.id, frame, {captureMs, fullSaved, photo: true});
	}

	function flash() {
		guide.classList.remove('is-flash');
		void guide.offsetWidth;
		guide.classList.add('is-flash');
		buzz(BUZZ_CAPTURE);
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

	async function readItemNow(id, frame, {auto = false, captureMs = null, dropped = false, fullSaved = null, geometry: area = null, guide: guideIn = null, photo = false, quads = [], seen = null, straight = false} = {}) {
		let result;
		let readDone = () => {};

		readings.set(id, new Promise((resolve) => {
			readDone = resolve;
		}));

		try {
			engineState = engineState === 'ready' ? 'ready' : 'loading';
			drawStatus();
			let drawn = 0;

			progress.set(id, 0.05);
			draw();

			const readOptions = {onProgress: (fraction) => {
				progress.set(id, fraction);

				// At most a redraw every tenth of the way.
				if (fraction - drawn >= 0.1) {
					drawn = fraction;
					draw();
				}
			}};
			const options = {guide: guideIn, photo, quads, readOptions, straight};

			if (textFirst()) {
				result = await identify(frame, {...options, pictureFirst: false});
			}
			else {
				// The picture in its own queue (in a worker, off the frame loop),
				// then the text, when the picture wants it, in another: a card
				// whose number is being read never holds up the next card's
				// picture (Eric's holder log, 2026-10-09: 3 to 14 s).
				const asked = performance.now();
				const seen = await identifyPictureAway(frame, options);

				queueWaits.set(id, {picture: Math.max(0, Math.round(performance.now() - asked - (seen.timings.total || 0))), pictureMs: Math.round(performance.now() - asked)});
				progress.set(id, 0.3);
				draw();

				const textAsked = performance.now();

				result = seen.needsText ? await identifyText(seen, {readOptions}) : seen;

				if (seen.needsText) {
					queueWaits.set(id, {...queueWaits.get(id), text: Math.max(0, Math.round(performance.now() - textAsked - ((result.timings.total || 0) - (seen.timings.total || 0))))});
				}
			}

			engineState = 'ready';
			drawStatus();
		}
		catch (err) {
			progress.delete(id);
			readings.delete(id);
			readDone(null);

			if (!alive || !S.findItem(session, id)) {
				return;
			}

			engineState = err instanceof EngineUnavailable ? 'unavailable' : engineState;
			drawStatus();
			scannerChange(id, () => S.markWaiting(session, id, 'ocr'));

			return;
		}

		// The picture, kept the moment it is known: the capture after this one
		// asks whether it repeats it before this one's photo is saved (Eric's
		// log, version 32: the same card taken again 2.6 s later joined the
		// tray as a second tile, because the picture was only kept on the card
		// after its photos were saved, which on his phone took longer).
		pictures.set(id, result.picture || null);
		readings.delete(id);
		readDone(result.picture || null);

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

		// A card the picture settled with no text read, or with its number
		// alone (identify.js): its straightened image is kept until its label
		// row has been read in the background.
		if (result.picture && (!result.read || !result.read.label)) {
			cardImages.set(id, result.card);
		}

		scanStats.reads.push({ocr: result.timings.ocr, rectify: result.timings.rectify, total: result.timings.total, workers: result.timings.workers});

		// An automatic capture with no card edges and no number read was not a
		// card (a hand, the table): it leaves the tray. A shutter capture
		// always stays, because the person meant it.
		const report = () => ({...S.reportOfRead(result, {captureMs, frame: `${frame.width} x ${frame.height}`, geometry: area, source: photo ? 'photo' : 'camera'}), queue: queueWaits.get(id) || null});

		if (auto && !result.found && !(result.read && result.read.number) && !(result.picture && pictureVerdict(result.picture).sure)) {
			await drop(id, 'not a card', {fullSaved, report: report(), result});
			setNote('That did not look like a card. Hold one inside the frame.');

			return;
		}

		// A frame with no card in it (a blank wall, a sheet of paper) does not
		// join the tray, even from the shutter (Q-19, picture.js noCard).
		if (!photo && !straight && noCard(result, seen)) {
			await drop(id, 'not a card', {fullSaved, report: report(), result});
			setNote('That did not look like a card. Hold one inside the frame.');

			return;
		}

		// The card just added, still in front of the camera when Scan opened
		// again (Q-20): taken once is enough. The shutter adds it anyway.
		const last = lastCard();

		if (auto && !dropped && last && !sinceOpen.has(last.item) && repeatOfLast(result.picture, last.key, performance.now() - cameraOpenedAt)) {
			await drop(id, 'repeat on reopen', {fullSaved, report: report(), result});
			setNote('That card was just added. Tap the shutter to add it again.');

			return;
		}

		// The same card as the camera's capture just before it: held a
		// moment longer, or a second copy. The repeat bar asks which; the
		// capture itself never joins the tray.
		// In holder mode a card dropped is a new card, the same card included
		// (a second copy dropped in): the drop detector never takes one card
		// twice (drop.js), so nothing is asked.
		const previous = auto && !dropped ? previousCapture(id) : null;
		const previousPicture = previous ? await pictureOf(previous) : null;

		if (!alive || !S.findItem(session, id)) {
			return;
		}

		if (previous && repeatOfPrevious(result.picture, previousPicture)) {
			await drop(id, 'repeat', {fullSaved, outcome: null, report: report(), result});
			askRepeat(id, previous.id);

			return;
		}

		// Any other card taken: the open question is answered No.
		answerRepeat(false);

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

			scanLog.savePicture(id, blob);
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
		item.report = report();
		item.picture = result.picture || null;
		scannerChange(id, () => (result.read ? S.applyRead(session, id, result.read) : S.markMatching(session, id)));

		if (fullSaved) {
			await fullSaved;
		}

		draft.deletePhoto(`${id}:full`).catch(() => {});

		await matchItemNow(id);
	}

	// How long a capture waits for the read of the capture before it, to
	// tell whether it repeats it.
	const REPEAT_WAIT_MS = 20000;

	// A tray card's picture match: on the card, kept from its read, or, while
	// it is still being read, once that read is done (at most REPEAT_WAIT_MS).
	async function pictureOf(item) {
		if (item.picture) {
			return item.picture;
		}

		if (pictures.has(item.id)) {
			return pictures.get(item.id);
		}

		const reading = readings.get(item.id);

		return reading ? within(reading, REPEAT_WAIT_MS, null) : null;
	}

	// The camera's capture just before card `id` in the tray, or null:
	// photos picked from the gallery and cards added from the search are
	// passed over. One still being read has no picture yet, so it repeats
	// nothing.
	function previousCapture(id) {
		const index = session.items.findIndex((item) => item.id === id);

		for (let i = index - 1; i >= 0; i--) {
			const item = session.items[i];
			const fromPhoto = openWhenMatched.has(item.id) || (item.report && item.report.source === 'photo');
			const fromSearch = !item.report && !item.picture && !item.read && item.status !== 'reading';

			if (!fromPhoto && !fromSearch) {
				return item;
			}
		}

		return null;
	}

	// A capture the scanner drops from the tray on its own (`why`: not a
	// card, or the card just added again), kept in the scan log with its
	// report and picture.
	async function drop(id, why, {fullSaved, outcome = {kind: 'dropped', why}, report, result}) {
		if (fullSaved) {
			await fullSaved;
		}

		scanLog.updateEntry(id, {report});

		if (result.card && scanLog.recording() && scanLog.picturesOn()) {
			scanLog.savePicture(id, await imageBlob(result.card, {maxHeight: PHOTO_HEIGHT, quality: 0.82}).catch(() => null));
		}

		remove(id, outcome);
	}

	// ------------------------------------------------------------ the repeat bar

	// How long the repeat bar waits for an answer before it counts as No.
	const REPEAT_ASK_MS = 8000;

	// The open question, {id: the dropped capture, previous: the tray card
	// it repeats, timer}, or null.
	let repeat = null;

	// "Same card as the last one." with Add a copy and Mistake, over the
	// camera; scanning goes on under it. A further repeat of the same card
	// while it shows is dropped quietly, not asked again.
	function askRepeat(id, previous) {
		if (repeat && repeat.previous === previous) {
			scanLog.setOutcome(id, {kind: 'dropped', why: 'repeat'});

			return;
		}

		answerRepeat(false);
		repeat = {id, previous, timer: setTimeout(() => answerRepeat(false), REPEAT_ASK_MS)};
		drawRepeat();
	}

	// Add a copy (yes: the card before gets one more copy) or Mistake, no
	// answer, or another card (no: nothing is added).
	function answerRepeat(yes) {
		if (!repeat) {
			return;
		}

		const {id, previous, timer} = repeat;
		const item = S.findItem(session, previous);

		clearTimeout(timer);
		repeat = null;

		if (yes && item) {
			change(() => S.setCopies(session, previous, S.copiesOf(item) + 1));
			scanLog.setOutcome(id, {kind: 'added-copy', to: previous});
			buzz(BUZZ_SURE);
			announce(`${item.card ? item.card.name : 'The card'}: ${plural(S.copiesOf(S.findItem(session, previous)), 'copy', 'copies')}.`);
		}
		else {
			scanLog.setOutcome(id, {kind: 'dropped', why: 'repeat'});
		}

		drawRepeat();
	}

	function drawRepeat() {
		if (!repeat) {
			repeatBar.replaceChildren();
			repeatBar.classList.remove('is-open');

			return;
		}

		repeatBar.classList.add('is-open');
		repeatBar.replaceChildren(
			h('p', {class: 'scan-repeat-text', id: 'scan-repeat-text'}, 'Same card as the last one.'),
			h('button', {class: 'scan-button scan-primary', id: 'scan-repeat-add', onclick: () => answerRepeat(true), type: 'button'}, 'Add a copy'),
			h('button', {class: 'scan-button', id: 'scan-repeat-no', onclick: () => answerRepeat(false), type: 'button'}, 'Mistake'));
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

		scannerChange(id, () => S.markMatching(session, id));

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
				scannerChange(id, () => S.markWaiting(session, id, 'catalog'));
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

		scannerChange(id, () => S.applyMatch(session, id, found));

		const last = scanStats.reads[scanStats.reads.length - 1];

		if (last && last.match === undefined) {
			last.match = current.timings.match;
		}

		if (current.card) {
			announce(`Added ${current.card.name}${current.language ? `, ${flagLanguageName(current.language)}` : ''}. ${plural(session.items.length, 'card')} in this session.`);
		}

		await loadVariants(id);
		openIfPicked(id);
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
			openIfPicked(id);
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
			scannerChange(id, () => S.markWaiting(session, id, 'catalog'));

			return;
		}

		if (!shown || sameAs(shown, current)) {
			showPicture(id, full, {fullMs: shown ? fullMs : null, indexMs, language, ms: shown ? quickMs : fullMs});
		}
		else if (current.report && current.report.match) {
			current.report = {...current.report, match: {...current.report.match, fullMs}};
			persist();
			answered(id);
		}

		const after = S.findItem(session, id);

		if (after && after.card && after.variants === null) {
			await loadVariants(id);
		}

		if (!shown) {
			openIfPicked(id);
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

		scannerChange(id, () => {
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
				scannerChange(id, () => S.localisePrint(session, id, cardId, local));
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

			const changed = scannerChange(id, () => S.applyLabel(session, id, label, undefined, {asian: lastAsianLanguage(), category, western: lastLanguage()}));

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
				scannerChange(id, () => S.applyVariants(session, id, card.id, variants));
			}
		}
		catch (err) {
			if (alive && S.findItem(session, id)) {
				scannerChange(id, () => S.markWaiting(session, id, 'catalog'));
			}

			if (!(err instanceof WaitingForSignal)) {
				setNote(`A card's finishes did not load. ${err.message}`);
			}
		}
	}

	// A photo picked from the gallery opens its sheet once looked up. A
	// camera scan never opens one by itself, the first of a session
	// included, so scanning flows with no tap between cards (Eric,
	// 2026-10-09, DESIGN.md section 3); a tap on its tile opens it.
	function openIfPicked(id) {
		if (openWhenMatched.delete(id) && !sheet && S.findItem(session, id)) {
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
					scannerChange(item.id, () => S.markLost(session, item.id));
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

		const before = geometry && geometry.capture;

		geometry = {...layoutGuide(camera.frame, box), frame: {...camera.frame}, stage: {height: Math.round(box.height), width: Math.round(box.width)}};

		if (before && ['x', 'y', 'w', 'h'].some((key) => before[key] !== geometry.capture[key])) {
			detector.reframe();
		}

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

	// The geometry as the scan report keeps it: where the guide was, the part
	// of the frame captured, and (Eric, 2026-10-09) the card found in the
	// frame (its box as shares of the frame's width and height, its shape,
	// and its turn), the zoom, whether holder mode was on, how long the
	// picture had been still, and how long the shutter waited for a whole
	// card and whether one came.
	function geometryReport(area, how, {card = null, region = null, settleMs = null, shutterFound = null, shutterWaitMs = null} = {}) {
		const rect = (r) => `${Math.round(r.w)} x ${Math.round(r.h)} at ${Math.round(r.x)}, ${Math.round(r.y)}`;
		const share = (value, of) => Math.round((value / of) * 1000) / 1000;
		let found = null;

		if (card) {
			const xs = card.quad.map((p) => p.x);
			const ys = card.quad.map((p) => p.y);

			found = {
				angle: card.angle,
				h: share(Math.max(...ys) - Math.min(...ys), area.frame.height),
				others: card.others.length,
				ratio: card.ratio,
				small: card.small,
				upright: card.upright,
				w: share(Math.max(...xs) - Math.min(...xs), area.frame.width),
				x: share(Math.min(...xs), area.frame.width),
				y: share(Math.min(...ys), area.frame.height),
			};
		}

		return {
			capture: rect(region || area.capture),
			card: found,
			frame: `${area.frame.width} x ${area.frame.height}`,
			guide: rect(area.guide),
			holder,
			how,
			screen: rect(area.screen),
			settleMs: settleMs === null ? null : Math.round(settleMs),
			shutterFound,
			shutterWaitMs,
			stage: `${area.stage.width} x ${area.stage.height}`,
			zoom: camera && typeof camera.zoom === 'number' ? Math.round(camera.zoom * 100) / 100 : null,
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
		sinceOpen.clear();

		cameraOff.hidden = true;
		shutter.disabled = false;
		placeGuide();
		drawCameraControls();
		drawTip();

		if (holder) {
			document.getElementById('scan-hint').textContent = 'Drop a card in.';
		}

		reframeHolder();
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
		warmPicture().then(() => {
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
					reframeHolder();
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

	// ------------------------------------------------------------ holder mode

	// Holder mode (Eric, 2026-10-09, version 36): a card is what changed
	// since the picture was last still (drop.js), so a card is taken when it
	// lands whatever its edges look like, once, and the next one is taken
	// even when it lands on the same spot. Detection goes on while a sheet is
	// open, so cards dropped while one is checked still join the tray.
	//
	// pendingDrop: a drop held for a sharper frame (drop.js sharpEnough):
	// {change, until}. lastDrop: the card taken last (drop.js takenCard),
	// forgotten when the zoom changes. sharpRecent: the last few cards'
	// sharpness.
	let pendingDrop = null;
	let lastDrop = null;
	let pileCheckedAt = -Infinity;
	let holderView = null;
	const PILE_CHECK_MS = 1000;
	const sharpRecent = [];
	// A small copy of the view as it was before the last drop, for the scan
	// log (the frames a replay needs), redrawn on every still frame.
	const beforeCanvas = document.createElement('canvas');
	const LOG_VIEW_SIDE = 320;

	function holderTick() {
		const laid = currentGeometry();

		if (!laid || !video.videoWidth) {
			return;
		}

		// The part of the frame watched stays where it was when holder mode
		// started (or the zoom changed): the screen laid out again (a tray tile
		// added, a note) moves the part on the screen, and every card would
		// seem to move with it.
		holderView = holderView || laid.view;

		const area = {...laid, view: holderView};

		const view = viewFrame(video, viewCanvas, area.view, FIND_SIDE);

		if (!view) {
			return;
		}

		const at = performance.now();
		const step = dropDetector.push(view, at);

		if (pendingDrop) {
			const plan = planDrop(pendingDrop.change, view, area);

			if (plan.skip || step.moving || at >= pendingDrop.until || sharpEnough(plan.sharpness, sharpRecent)) {
				const held = pendingDrop;

				pendingDrop = null;

				if (!plan.skip) {
					takeDrop(held.change, plan, {...held.step, heldMs: Math.round(at - held.at)}, area);
				}
			}

			return;
		}

		if (!step.change) {
			return;
		}

		if (!step.drop) {
			if (step.change.kind !== 'none') {
				logSkipped(step.change.kind, step);
			}

			// A still picture with nothing new: the last drop's frame for the
			// log is this one, and once a second the pile is checked for a card
			// running off the frame (a hint only).
			keepBeforeView(area);

			if (at - pileCheckedAt >= PILE_CHECK_MS) {
				pileCheckedAt = at;

				const found = findCard(view.grey, view.width, view.height);

				setPile(Boolean(found.touching && !found.quad));
			}

			return;
		}

		const plan = planDrop(step.change, view, area);

		if (plan.skip) {
			if (plan.skip === 'off the frame') {
				setPile(true);
			}

			logSkipped(plan.skip, step);
			keepBeforeView(area);

			return;
		}

		setPile(false);

		if (!sharpEnough(plan.sharpness, sharpRecent)) {
			pendingDrop = {at, change: step.change, step, until: at + SHARP_WAIT_MS};

			return;
		}

		takeDrop(step.change, plan, step, area);
	}

	// The capture for a drop (drop.js dropCapture), with the card outlines
	// found on the finer copy of the view.
	function planDrop(change, view, area) {
		const fine = viewFrame(video, fineCanvas, area.view, FIND_SIDE_CAPTURE);
		const found = fine ? findCard(fine.grey, fine.width, fine.height) : null;

		return dropCapture(change, view, fine || view, found, {frame: camera.frame, last: lastDrop});
	}

	function drawTip() {
		tip.hidden = !holder || tipDismissed();
	}

	function setPile(on) {
		if (on !== pileHigh) {
			pileHigh = on;
			guide.classList.toggle('is-pile', on);
			document.getElementById('scan-hint').textContent = on ? 'Pile too high: empty the box.' : 'Drop a card in.';

			if (on) {
				announce('Pile too high: empty the box.');
			}
		}
	}

	function keepBeforeView(area) {
		if (!scanLog.recording() || !scanLog.picturesOn()) {
			return;
		}

		const scale = Math.min(1, LOG_VIEW_SIDE / Math.max(area.view.w, area.view.h));

		beforeCanvas.width = Math.max(1, Math.round(area.view.w * scale));
		beforeCanvas.height = Math.max(1, Math.round(area.view.h * scale));
		beforeCanvas.getContext('2d').drawImage(video, area.view.x, area.view.y, area.view.w, area.view.h, 0, 0, beforeCanvas.width, beforeCanvas.height);
	}

	// The view now and the view before the drop, as small JPEGs for the scan
	// log, so lab/holder/replay.mjs can replay the drop from a log.
	async function logViews(id, area) {
		if (!scanLog.recording() || !scanLog.picturesOn() || !beforeCanvas.width) {
			return;
		}

		const after = document.createElement('canvas');

		after.width = beforeCanvas.width;
		after.height = beforeCanvas.height;
		after.getContext('2d').drawImage(video, area.view.x, area.view.y, area.view.w, area.view.h, 0, 0, after.width, after.height);

		const blob = (canvas) => new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.7));
		const [before, now] = await Promise.all([blob(beforeCanvas), blob(after)]);

		scanLog.saveViews(id, {after: now, before});
	}

	// What the scan log keeps of a drop.
	const dropReport = (change, plan, step) => ({
		agree: plan ? plan.agree : null,
		blob: change ? Math.round((change.blob || 0) * 1000) / 1000 : null,
		cover: change && change.cover !== undefined ? Math.round(change.cover * 100) / 100 : null,
		heldMs: step.heldMs ?? null,
		kind: change ? change.kind : null,
		motionPeak: step.burst ? Math.round(step.burst.peak * 10) / 10 : null,
		movingMs: step.burst ? Math.round(performance.now() - step.burst.start - step.still) : null,
		share: change ? Math.round(change.share * 1000) / 1000 : null,
		sharpness: plan ? plan.sharpness : null,
		stillFrames: step.stillFrames ?? null,
		stillMs: Math.round(step.still),
	});

	// A drop the detector saw that took nothing: why, in the scan log.
	function logSkipped(why, step) {
		scanLog.logEvent({at: new Date().toISOString(), drop: dropReport(step.change, null, step), how: 'holder', why});
	}

	// Takes the card a drop brought: a tile at once, the picture matched off
	// the frame loop.
	function takeDrop(change, plan, step, area) {
		sharpRecent.push(plan.sharpness);

		if (sharpRecent.length > 5) {
			sharpRecent.shift();
		}

		lastDrop = takenCard(lastDrop, plan.card);
		dropsTaken++;

		const grabbed = performance.now();
		const frame = grabFrame(video, plan.region);
		const captureMs = Math.round(performance.now() - grabbed);

		scanStats.captures++;
		flash();
		noteText = null;

		if (discarded) {
			discarded = null;
			draft.prunePhotos(session.items.map((item) => item.id)).catch(() => {});
		}

		const item = S.addCapture(session);

		toBuzz.add(item.id);
		sinceOpen.add(item.id);
		scanLog.startEntry(item.id, {at: item.captured_at, how: 'auto', phone: deviceInfo(), source: 'camera'});
		logViews(item.id, area).catch(() => {});
		persist();
		draw();

		const fullSaved = imageBlob(frame, {quality: 0.92}).then((blob) => draft.savePhoto(`${item.id}:full`, blob)).catch(() => {});
		// The card as the change found it, in the scan log's terms (the
		// outlines found over it are the others).
		const card = {angle: change.rect.angle, others: plan.quads.slice(1), quad: plan.card.corners, ratio: Math.round((Math.min(change.rect.w, change.rect.h) / Math.max(change.rect.w, change.rect.h)) * 1000) / 1000, small: false, upright: change.rect.h >= change.rect.w};
		const geometry = {...geometryReport(area, 'auto', {card, region: plan.region, settleMs: Math.round(step.still)}), drop: dropReport(change, plan, step)};

		refocusSoon();
		readItem(item.id, frame, {auto: true, captureMs, dropped: true, fullSaved, geometry, quads: plan.quads});
	}

	// Focus and white balance are held once the camera has found them, in
	// holder mode only (camera.js holdFocus: a box under a still phone keeps
	// its distance and light), and found again every REFOCUS_EVERY cards, as
	// the pile grows towards the lens, and when the zoom changes.
	const REFOCUS_EVERY = 10;
	let dropsTaken = 0;
	let focusTimer = 0;

	function holdFocusSoon(ms = 1500) {
		clearTimeout(focusTimer);

		if (!holder || !camera || !camera.holdFocus) {
			return;
		}

		focusTimer = setTimeout(() => {
			if (holder && camera && camera.holdFocus) {
				camera.holdFocus().catch(() => {});
			}
		}, ms);
	}

	function refocusSoon() {
		if (dropsTaken % REFOCUS_EVERY === 0 && camera && camera.refocus) {
			camera.refocus().then(() => holdFocusSoon()).catch(() => {});
		}
	}

	// The zoom changed, or the camera restarted: the drop detector starts
	// again from the next still picture, and the last card's size is
	// forgotten.
	function reframeHolder() {
		dropDetector.reframe();
		holderView = null;
		pendingDrop = null;
		lastDrop = null;
		sharpRecent.length = 0;
		holdFocusSoon();
	}

	function startLoop() {
		clearInterval(loop);
		loop = setInterval(() => {
			if (!camera || document.hidden || shutterBusy) {
				return;
			}

			if (holder) {
				holderTick();

				return;
			}

			if (sheet) {
				return;
			}

			const now = look();

			if (!now) {
				return;
			}

			const {seen} = now;
			const from = now.card ? now.card.box : 'guide';

			// The thumbnail moved to another part of the frame: the next one is
			// not compared with this one as a jump.
			if (from !== thumbFrom) {
				detector.reframe();
				thumbFrom = from;
			}

			// How long the picture has been still, for the scan log.
			const step = holderDetector.push(now.view.grey, now.view.width, now.view.height, {card: whole(now), touching: now.touching}, performance.now());

			document.getElementById('scan-hint').textContent = seen.glare && seen.present ? 'Tilt to cut the glare.' : seen.small ? 'Move closer.' : 'Card inside the frame. Hold still.';
			guide.classList.toggle('is-seen', seen.present);

			if (detector.push(now.shot.grey, seen)) {
				capture('auto', {looked: now, settleMs: step.settleMs});
			}
		}, FRAME_MS);
	}

	// Holder mode on or off (the switch beside the zoom).
	function setHolder(on) {
		holder = on;
		rememberHolder(on);
		holderSwitch.setAttribute('aria-checked', String(on));
		holderDetector.reframe();
		reframeHolder();
		setPile(false);
		guide.classList.remove('is-seen');
		document.getElementById('scan-hint').textContent = on ? 'Drop a card in.' : 'Card inside the frame. Hold still.';
		drawTip();

		if (!on && camera && camera.releaseFocus) {
			clearTimeout(focusTimer);
			camera.releaseFocus().catch(() => {});
		}

		announce(on ? 'Holder mode on: each card dropped under the phone is taken once it settles.' : 'Holder mode off.');
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
		const x = event.target.closest('[data-remove]');

		if (x) {
			removeTile(x.dataset.remove);

			return;
		}

		const tile = event.target.closest('[data-item]');

		if (tile) {
			const item = S.findItem(session, tile.dataset.item);

			if (item && S.needsLook(item)) {
				openReview(item.id);
			}
			else {
				openItem(tile.dataset.item);
			}
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

		if (repeat) {
			clearTimeout(repeat.timer);
			scanLog.setOutcome(repeat.id, {kind: 'dropped', why: 'repeat'});
			repeat = null;
		}

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
