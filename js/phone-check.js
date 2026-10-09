// Phone check: the weekend zero tests (device report, Camera test, Storage
// test), kept so each family phone can still be checked.

import {BASE, errorText, h, namedError, showError} from './dom.js';
import {formatCount} from './format.js';
import {openDatabase} from './idb.js';
import {downloadBlob} from './scan/image.js';
import {clearLog, logFile, logSize, picturesOn, recording, setPictures, setRecording} from './scan/log.js';
import {clockGap, clockIsOff, clockOffset, onClockOffset} from './sync.js';

const RESULTS_KEY = 'cardTracker.spike.v1';
const SHELL_CACHE_PREFIX = 'card-tracker-shell-';

const DB_NAME = 'card-tracker-spike';
const DB_STORE = 'entries';
const ENTRY_COUNT = 1600;

const yesNo = (value) => (value ? 'Yes' : 'No');

function formatBytes(bytes) {
	if (typeof bytes !== 'number') {
		return 'Not reported';
	}

	const mb = bytes / (1024 * 1024);

	if (mb >= 1024) {
		return `${(mb / 1024).toFixed(1)} GB`;
	}

	return `${mb.toFixed(1)} MB`;
}

const formatMs = (ms) => `${Math.round(ms)} ms`;

const timestamp = () => new Date().toLocaleString();

// ------------------------------------------------------------ environment

function isInstalled() {
	const standaloneMedia = window.matchMedia('(display-mode: standalone)').matches;

	return standaloneMedia || navigator.standalone === true;
}

const runMode = () => (isInstalled() ? 'installed' : 'browser');

const MODE_LABELS = {
	browser: 'in the browser',
	installed: 'installed (home screen)',
};

function platformName() {
	if (navigator.userAgentData && navigator.userAgentData.platform) {
		return navigator.userAgentData.platform;
	}

	return navigator.platform || 'Not reported';
}

async function shellCacheNames() {
	if (!('caches' in window)) {
		return 'Cache API not available';
	}

	try {
		const keys = await caches.keys();
		const shell = keys.filter((key) => key.startsWith(SHELL_CACHE_PREFIX));

		return shell.length ? shell.join(', ') : 'None yet';
	}
	catch (err) {
		return errorText(err);
	}
}

const swControls = () => Boolean(navigator.serviceWorker && navigator.serviceWorker.controller);

function swStatus() {
	if (!('serviceWorker' in navigator)) {
		return 'Service workers not supported';
	}

	return yesNo(swControls());
}

// The phone's clock against the server's, from the last sync that saved
// (js/sync.js): warn only, the app never corrects it.
function clockText(estimate = clockOffset()) {
	if (!estimate) {
		return 'Not measured yet. Each sync that saves measures it.';
	}

	if (!clockIsOff(estimate)) {
		return 'Right, within 2 minutes of the server';
	}

	return `${clockGap(estimate.offsetMs)} ${estimate.offsetMs < 0 ? 'ahead of' : 'behind'} the server`;
}

async function deviceRows() {
	return [
		['Report time', timestamp()],
		['Running', MODE_LABELS[runMode()]],
		['display-mode: standalone', yesNo(window.matchMedia('(display-mode: standalone)').matches)],
		['navigator.standalone', navigator.standalone === undefined ? 'Not present' : String(navigator.standalone)],
		['User agent', navigator.userAgent],
		['Platform', platformName()],
		['Touch points', String(navigator.maxTouchPoints ?? 'Not reported')],
		['Screen', `${screen.width} x ${screen.height} CSS px, pixel ratio ${window.devicePixelRatio}`],
		['Viewport', `${window.innerWidth} x ${window.innerHeight} CSS px`],
		['Online', yesNo(navigator.onLine)],
		['Secure context', yesNo(window.isSecureContext)],
		['Service worker controls page', swStatus()],
		['Shell cache', await shellCacheNames()],
		['Phone clock', clockText()],
	];
}

// ------------------------------------------------------- saved results

function loadResults() {
	try {
		const parsed = JSON.parse(localStorage.getItem(RESULTS_KEY));

		return parsed && typeof parsed === 'object' ? parsed : {};
	}
	catch {
		return {};
	}
}

function saveResult(test, rows) {
	try {
		const all = loadResults();

		all[test] = all[test] || {};
		all[test][runMode()] = {at: timestamp(), rows};

		localStorage.setItem(RESULTS_KEY, JSON.stringify(all));
	}
	catch (err) {
		showError('Could not save this result to localStorage.', err);
	}
}

function savedRows(test) {
	const saved = loadResults()[test];
	const entry = saved && saved[runMode()];

	return entry && Array.isArray(entry.rows) ? entry.rows : null;
}

// One table renderer for every result list, so the screen and the copied
// report always show the same rows.
function fillTable(table, rows) {
	table.replaceChildren(
		h('tbody', null,
			rows.map(([label, value]) => h('tr', null, h('th', {scope: 'row'}, label), h('td', null, value)))
		)
	);
}

function setRow(rows, label, value) {
	const existing = rows.find((row) => row[0] === label);

	if (existing) {
		existing[1] = value;
	}
	else {
		rows.push([label, value]);
	}
}

async function buildReport() {
	const lines = ['Card Tracker phone test report', '', 'DEVICE'];

	for (const [label, value] of await deviceRows()) {
		lines.push(`${label}: ${value}`);
	}

	const results = loadResults();

	for (const [test, title] of [['camera', 'CAMERA TEST'], ['storage', 'STORAGE TEST']]) {
		for (const mode of ['browser', 'installed']) {
			const entry = results[test] && results[test][mode];

			lines.push('', `${title}, ${MODE_LABELS[mode]}`);

			if (!entry) {
				lines.push('Not run yet in this mode.');

				continue;
			}

			lines.push(`Run at: ${entry.at}`);

			for (const [label, value] of entry.rows) {
				lines.push(`${label}: ${value}`);
			}
		}
	}

	return lines.join('\n');
}

async function copyText(text) {
	if (navigator.clipboard && navigator.clipboard.writeText) {
		try {
			await navigator.clipboard.writeText(text);

			return;
		}
		catch {
			// Fall through to the older method below.
		}
	}

	const area = h('textarea', {readonly: true, class: 'offscreen'});

	area.value = text;
	document.body.append(area);
	area.select();
	area.setSelectionRange(0, text.length);

	let copied = false;

	try {
		copied = document.execCommand('copy');
	}
	finally {
		area.remove();
	}

	if (!copied) {
		throw namedError('NotAllowedError', 'This browser blocked copying. Press and hold the report text to select it, then copy it by hand.');
	}
}

// ------------------------------------------------------------ home view

export function phoneCheckView(root) {
	const report = h('pre', {class: 'report'}, 'Building the report...');
	const status = h('p', {class: 'status', role: 'status'});

	// Shown only while the clock is more than 2 minutes off.
	const clockCard = h('section', {class: 'card', hidden: true, id: 'phone-clock'},
		h('h2', null, 'Phone clock'),
		h('p', {id: 'phone-clock-text'})
	);

	function drawClock() {
		const estimate = clockOffset();

		clockCard.hidden = !clockIsOff(estimate);

		if (!clockCard.hidden) {
			clockCard.querySelector('p').textContent = `This phone's clock is ${clockText(estimate)}. Set the date and time to automatic in the phone's settings so edits sync in the right order. The app never changes the clock or your edits' times.`;
		}
	}

	async function refresh() {
		drawClock();

		try {
			report.textContent = await buildReport();
		}
		catch (err) {
			showError('Could not build the report.', err);
		}
	}

	async function copy() {
		status.textContent = '';

		try {
			await refresh();
			await copyText(report.textContent);
			status.textContent = 'Copied. Paste it into the chat with Eric.';
		}
		catch (err) {
			showError('Copy failed.', err);
		}
	}

	root.append(
		h('section', {class: 'card'},
			h('h2', null, 'Phone check'),
			h('p', null, 'A quick check of what this phone can do from a web app: use the camera, and keep data with no signal.')
		),
		clockCard,
		h('section', {class: 'card'},
			h('h2', null, 'How to test'),
			h('ol', null,
				h('li', null, 'Install to your home screen first: on iPhone, Share then Add to Home Screen; on Android, the browser menu then Install app.'),
				h('li', null, 'Run both tests here in the browser, then again from the home screen icon.'),
				h('li', null, 'In the installed app, run the storage test, turn on airplane mode, reload, and tap Count again.'),
				h('li', null, 'Come back here and tap Copy report, then send it to Eric.')
			)
		),
		h('div', {class: 'link-grid'},
			h('a', {class: 'button', href: BASE + 'camera', 'data-link': 'camera'}, 'Camera test'),
			h('a', {class: 'button', href: BASE + 'storage', 'data-link': 'storage'}, 'Storage test')
		),
		scanLogCard(),
		h('section', {class: 'card'},
			h('h2', null, 'Device report'),
			h('p', {class: 'muted'}, 'Results are kept on this phone. The installed app and the browser may keep them separately, so copy the report from each.'),
			report
		),
		h('div', {class: 'actions'},
			h('button', {class: 'primary wide', type: 'button', onclick: copy}, 'Copy report'),
			status
		)
	);

	refresh();

	window.addEventListener('online', refresh);
	window.addEventListener('offline', refresh);

	const stopClock = onClockOffset(refresh);

	return () => {
		window.removeEventListener('online', refresh);
		window.removeEventListener('offline', refresh);
		stopClock();
	};
}

// ---------------------------------------------------------- the scan log

const megabytes = (bytes) => `${bytes && bytes < 100000 ? '0.1' : (bytes / 1e6).toFixed(1)} MB`;

// Whether the phone's share sheet takes a file (Chrome on Android does), as
// the CSV export in js/cards-view.js asks.
function canShareFile(file) {
	try {
		return Boolean(navigator.canShare && navigator.canShare({files: [file]}));
	}
	catch {
		return false;
	}
}

// The Scanner section: Record every scan (js/scan/log.js), off until
// switched on here, so nobody records by surprise; Include card pictures;
// how much is kept; and the log as one file to download or share.
function scanLogCard() {
	const size = h('p', {id: 'scan-log-size'}, 'Counting the recorded scans...');
	const status = h('p', {'aria-live': 'polite', class: 'muted', id: 'scan-log-status'});
	const share = h('button', {hidden: true, id: 'scan-log-share', onclick: () => shareNow(), type: 'button'}, 'Share');
	const download = h('button', {class: 'primary', id: 'scan-log-download', onclick: () => send(), type: 'button'}, 'Download scan log');
	const clear = h('button', {id: 'scan-log-clear', onclick: () => askClear(true), type: 'button'}, 'Clear log');
	const confirmRow = h('div', {hidden: true, id: 'scan-log-confirm', role: 'group', 'aria-label': 'Clear the scan log', style: 'display: grid; gap: 8px; grid-template-columns: 1fr 1fr'},
		h('p', {id: 'scan-log-confirm-text', style: 'grid-column: 1 / -1; margin: 0'}),
		h('button', {class: 'danger', id: 'scan-log-clear-yes', onclick: doClear, type: 'button'}, 'Delete them'),
		h('button', {id: 'scan-log-clear-no', onclick: () => askClear(false), type: 'button'}, 'Keep them'));
	let count = 0;

	async function drawSize() {
		const found = await logSize();

		count = found.count;
		size.textContent = count ? `${formatCount(count)} ${count === 1 ? 'scan' : 'scans'} recorded · ${megabytes(found.bytes)}` : 'No scans recorded yet.';
		download.disabled = !count;
		clear.disabled = !count;
		share.hidden = !count || !canShareFile(new File(['{}'], 'scan-log.txt', {type: 'text/plain'}));
		prepare();
	}

	// The file for Share, made ahead: Android opens the share sheet only
	// within a few seconds of the tap, and making a log with pictures takes
	// longer, so a file made after the tap was refused. It goes as plain
	// text, a type every share target takes (.json is not on Chrome's list);
	// its content is the same JSON the download saves.
	let ready = null;
	let readyFile = null;

	function prepare() {
		readyFile = null;
		ready = count && !share.hidden ? logFile().then((file) => {
			readyFile = new File([file], file.name.replace(/\.json$/, '.txt'), {type: 'text/plain'});

			return readyFile;
		}).catch(() => null) : null;
	}

	async function shareNow() {
		if (!readyFile) {
			status.textContent = 'Getting the file ready...';

			if (await (ready || Promise.resolve(null))) {
				status.textContent = 'Ready. Tap Share again.';
			}
			else {
				status.textContent = 'The scan log could not be made. Use Download scan log.';
			}

			return;
		}

		try {
			await navigator.share({files: [readyFile], title: 'Card Tracker scan log'});
			status.textContent = 'Shared.';
		}
		catch (err) {
			// Closing the share sheet is not an error; a refusal after a slow
			// moment is fixed by tapping again.
			status.textContent = err && err.name === 'AbortError' ? '' : err && err.name === 'NotAllowedError' ? 'The phone did not open sharing. Tap Share again.' : `Sharing did not work: ${errorText(err)}`;
		}
	}

	async function send() {
		status.textContent = 'Making the file...';

		try {
			const file = await logFile();

			// As the scan report's Save capture image does.
			downloadBlob(file, file.name);
			status.textContent = `Saved ${file.name}. Send that file to Eric.`;
		}
		catch (err) {
			status.textContent = `The scan log could not be made: ${errorText(err)}`;
		}
	}

	function askClear(open) {
		confirmRow.hidden = !open;
		clear.hidden = open;

		if (open) {
			confirmRow.querySelector('p').textContent = `Delete all ${formatCount(count)} recorded ${count === 1 ? 'scan' : 'scans'} from this phone?`;
			document.getElementById('scan-log-clear-no').focus();
		}
		else {
			clear.focus();
		}
	}

	async function doClear() {
		try {
			await clearLog();
			status.textContent = 'The scan log is empty.';
		}
		catch (err) {
			status.textContent = `The scan log could not be cleared: ${errorText(err)}`;
		}

		askClear(false);
		await drawSize();
	}

	drawSize();

	return h('section', {class: 'card', id: 'scan-log'},
		h('h2', null, 'Scanner'),
		h('label', null,
			h('input', {checked: recording(), id: 'scan-log-record', onchange: (event) => setRecording(event.target.checked), type: 'checkbox'}),
			' Record every scan'),
		h('label', null,
			h('input', {checked: picturesOn(), id: 'scan-log-pictures', onchange: (event) => setPictures(event.target.checked), type: 'checkbox'}),
			' Include card pictures'),
		h('p', {class: 'muted'}, 'While this is on, every scan is kept on this phone: the phone, each step\'s time, what was read, the cards considered, and what you saved in the end. Pictures are small copies of each card. Download the scan log and send the file to Eric.'),
		size,
		h('div', {style: 'display: grid; gap: 8px'}, download, share, clear, confirmRow),
		status
	);
}

// ---------------------------------------------------------- camera view

function cameraFailureLabel(err) {
	switch (err && err.name) {
		case 'NotAllowedError':
			return 'Denied or blocked';
		case 'NotFoundError':
			return 'No camera found';
		case 'NotReadableError':
			return 'Camera busy or unavailable';
		case 'OverconstrainedError':
			return `Constraint not met (${err.constraint || 'unknown'})`;
		case 'SecurityError':
			return 'Blocked by security settings';
		case 'NotSupportedError':
			return 'Camera API not available';
		default:
			return 'Failed';
	}
}

async function cameraPermissionState() {
	if (!navigator.permissions || !navigator.permissions.query) {
		return 'Permissions API not available';
	}

	try {
		const status = await navigator.permissions.query({name: 'camera'});

		return status.state;
	}
	catch (err) {
		return `Not available (${errorText(err)})`;
	}
}

function torchSupported(caps) {
	if (!caps) {
		return false;
	}

	return caps.torch === true || (Array.isArray(caps.torch) && caps.torch.includes(true));
}

function waitForFrame(video) {
	if (video.videoWidth > 0) {
		return Promise.resolve();
	}

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(namedError('TimeoutError', 'The camera started but sent no video frame within 10 seconds.'));
		}, 10000);

		video.addEventListener('loadedmetadata', () => {
			clearTimeout(timer);
			resolve();
		}, {once: true});
	});
}

export function cameraView(root) {
	let stream = null;
	let track = null;
	let torchOn = false;
	let closed = false;
	let rows = savedRows('camera') || [];

	const video = h('video', {class: 'video', playsinline: true, 'webkit-playsinline': true, muted: true, autoplay: true, hidden: true});

	video.muted = true;

	const placeholder = h('div', {class: 'video-placeholder'}, 'Camera is off');
	const table = h('table', {class: 'results'});
	const shot = h('div', {class: 'shot'});
	const note = h('p', {class: 'muted'});

	const startButton = h('button', {class: 'primary', type: 'button', onclick: () => (stream ? stop() : start())}, 'Start camera');
	const captureButton = h('button', {type: 'button', disabled: true, onclick: capture}, 'Capture');
	const torchButton = h('button', {class: 'wide', type: 'button', hidden: true, 'aria-pressed': 'false', onclick: toggleTorch}, 'Torch: off');

	function render() {
		if (rows.length) {
			fillTable(table, rows);
			note.textContent = `Saved as the camera test ${MODE_LABELS[runMode()]}.`;
		}
		else {
			table.replaceChildren();
			note.textContent = 'No result yet. Tap Start camera.';
		}
	}

	function record() {
		render();
		saveResult('camera', rows);
	}

	function updateButtons() {
		startButton.textContent = stream ? 'Stop camera' : 'Start camera';
		startButton.disabled = false;
		captureButton.disabled = !stream;
		torchButton.textContent = torchOn ? 'Torch: on' : 'Torch: off';
		torchButton.setAttribute('aria-pressed', String(torchOn));
	}

	async function start() {
		startButton.disabled = true;
		startButton.textContent = 'Starting...';
		shot.replaceChildren();

		const before = await cameraPermissionState();

		rows = [['Permission state before start', before]];

		if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
			const err = namedError('NotSupportedError', 'navigator.mediaDevices.getUserMedia is not available. The page must be opened over HTTPS or from localhost.');

			rows.push(['Permission', cameraFailureLabel(err)], ['Error', errorText(err)]);
			showError('Camera could not start.', err);
			record();
			updateButtons();

			return;
		}

		const started = performance.now();

		try {
			stream = await navigator.mediaDevices.getUserMedia({
				audio: false,
				video: {
					facingMode: {ideal: 'environment'},
					height: {ideal: 1080},
					width: {ideal: 1920},
				},
			});

			if (closed) {
				// The tester left the view while the permission prompt was open.
				for (const t of stream.getTracks()) {
					t.stop();
				}

				stream = null;

				return;
			}

			rows.push(['Permission', 'Granted']);

			track = stream.getVideoTracks()[0];
			video.srcObject = stream;
			video.hidden = false;
			placeholder.hidden = true;

			try {
				await video.play();
			}
			catch (err) {
				rows.push(['Video playback', errorText(err)]);
				showError('The live video would not play.', err);
			}

			await waitForFrame(video);

			const elapsed = performance.now() - started;
			const settings = typeof track.getSettings === 'function' ? track.getSettings() : {};
			const caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() : null;

			rows.push(
				['Camera label', track.label || 'No label'],
				['Facing mode', settings.facingMode || 'Not reported'],
				['Video resolution', `${video.videoWidth} x ${video.videoHeight}`],
				['Track settings', `${settings.width ?? '?'} x ${settings.height ?? '?'}, ${settings.frameRate ? Math.round(settings.frameRate) : '?'} fps`],
				['Time to start (includes the permission prompt)', formatMs(elapsed)],
				['getCapabilities', caps ? 'Supported' : 'Not supported'],
				['Max resolution', caps && caps.width && caps.width.max ? `${caps.width.max} x ${caps.height.max}` : 'Not reported'],
				['Torch', caps ? (torchSupported(caps) ? 'Supported' : 'Not supported') : 'Unknown (no getCapabilities)'],
				['Zoom', caps && caps.zoom ? `Supported, ${caps.zoom.min} to ${caps.zoom.max}` : (caps ? 'Not supported' : 'Unknown (no getCapabilities)')],
				['Focus modes', caps && Array.isArray(caps.focusMode) && caps.focusMode.length ? caps.focusMode.join(', ') : (caps ? 'Not reported' : 'Unknown (no getCapabilities)')],
				['ImageCapture API', yesNo('ImageCapture' in window)]
			);

			try {
				const devices = await navigator.mediaDevices.enumerateDevices();

				rows.push(['Cameras listed', String(devices.filter((device) => device.kind === 'videoinput').length)]);
			}
			catch (err) {
				rows.push(['Cameras listed', errorText(err)]);
			}

			torchButton.hidden = !torchSupported(caps);
		}
		catch (err) {
			if (!stream) {
				rows.push(['Permission', cameraFailureLabel(err)]);
			}

			rows.push(['Error', errorText(err)]);
			showError(stream ? 'The camera started, then failed.' : 'Camera could not start.', err);
			stop();
		}

		record();
		updateButtons();
	}

	function stop() {
		if (stream) {
			for (const t of stream.getTracks()) {
				t.stop();
			}
		}

		stream = null;
		track = null;
		torchOn = false;
		video.srcObject = null;
		video.hidden = true;
		placeholder.hidden = false;
		torchButton.hidden = true;
		updateButtons();
	}

	async function toggleTorch() {
		if (!track) {
			return;
		}

		try {
			await track.applyConstraints({advanced: [{torch: !torchOn}]});
			torchOn = !torchOn;
			setRow(rows, 'Torch toggle', 'Worked');
		}
		catch (err) {
			showError('Torch could not be switched.', err);
			setRow(rows, 'Torch toggle', errorText(err));
		}

		record();
		updateButtons();
	}

	function capture() {
		try {
			const width = video.videoWidth;
			const height = video.videoHeight;

			if (!width || !height) {
				throw namedError('InvalidStateError', 'The video has no frame to capture yet.');
			}

			const canvas = h('canvas', {width, height});

			canvas.getContext('2d').drawImage(video, 0, 0, width, height);

			const caption = h('p', {class: 'muted'}, `Captured frame: ${width} x ${height} pixels.`);

			shot.replaceChildren(canvas, caption);
			setRow(rows, 'Capture', `${width} x ${height} px`);
			record();

			canvas.toBlob((blob) => {
				if (!blob) {
					return;
				}

				const kb = Math.round(blob.size / 1024);

				caption.textContent = `Captured frame: ${width} x ${height} pixels, ${kb} KB as JPEG.`;
				setRow(rows, 'Capture', `${width} x ${height} px, ${kb} KB as JPEG`);
				record();
			}, 'image/jpeg', 0.9);
		}
		catch (err) {
			showError('Capture failed.', err);
			setRow(rows, 'Capture', errorText(err));
			record();
		}
	}

	root.append(
		h('h2', null, 'Camera test'),
		h('p', null, 'Starts the rear camera and checks what it supports. Allow camera access when asked.'),
		h('div', {class: 'video-wrap'}, video, placeholder),
		h('div', {class: 'actions'}, startButton, captureButton, torchButton),
		shot,
		h('section', {class: 'card'}, h('h3', null, 'Results'), note, table)
	);

	render();

	const onPageHide = () => stop();

	window.addEventListener('pagehide', onPageHide);

	return () => {
		closed = true;
		window.removeEventListener('pagehide', onPageHide);
		stop();
	};
}

// --------------------------------------------------------- storage view

function openDb() {
	if (!('indexedDB' in window)) {
		return Promise.reject(namedError('NotSupportedError', 'IndexedDB is not available in this browser.'));
	}

	return openDatabase(DB_NAME, (db) => db.createObjectStore(DB_STORE, {keyPath: 'id'}), {
		onBlocked: () => namedError('BlockedError', 'The database is open in another tab. Close other tabs of this app and try again.'),
	});
}

function requestDone(request) {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function transactionDone(tx) {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error || namedError('AbortError', 'The transaction was aborted.'));
	});
}

function fallbackUuid() {
	const bytes = crypto.getRandomValues(new Uint8Array(16));

	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;

	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function fakeEntries(count) {
	const languages = ['en', 'pt', 'ja', 'ko', 'fr', 'de'];
	const sets = ['sv01', 'sv02', 'sv03', 'me01', 'base1'];
	const uuid = typeof crypto.randomUUID === 'function' ? () => crypto.randomUUID() : fallbackUuid;
	const now = Date.now();

	return Array.from({length: count}, (_, i) => ({
		card_id: `${sets[i % sets.length]}-${String((i % 200) + 1).padStart(3, '0')}`,
		id: uuid(),
		language: languages[i % languages.length],
		updated_at: new Date(now - i * 60000).toISOString(),
	}));
}

async function countEntries() {
	const db = await openDb();

	try {
		const started = performance.now();
		const tx = db.transaction(DB_STORE, 'readonly');
		const count = await requestDone(tx.objectStore(DB_STORE).count());

		return {count, ms: performance.now() - started};
	}
	finally {
		db.close();
	}
}

async function storageRows() {
	const rows = [];

	if (navigator.storage && navigator.storage.persisted) {
		try {
			rows.push(['Persisted before asking', yesNo(await navigator.storage.persisted())]);
		}
		catch (err) {
			rows.push(['Persisted before asking', errorText(err)]);
		}
	}

	if (navigator.storage && navigator.storage.persist) {
		try {
			rows.push(['storage.persist() result', String(await navigator.storage.persist())]);
		}
		catch (err) {
			rows.push(['storage.persist() result', errorText(err)]);
		}
	}
	else {
		rows.push(['storage.persist() result', 'Not supported']);
	}

	if (navigator.storage && navigator.storage.estimate) {
		try {
			const estimate = await navigator.storage.estimate();

			rows.push(['Storage used', formatBytes(estimate.usage)], ['Storage quota', formatBytes(estimate.quota)]);
		}
		catch (err) {
			rows.push(['Storage estimate', errorText(err)]);
		}
	}
	else {
		rows.push(['Storage estimate', 'Not supported']);
	}

	return rows;
}

function contextRows() {
	return [
		['Running', MODE_LABELS[runMode()]],
		['Online', yesNo(navigator.onLine)],
		['Service worker controls page', swStatus()],
	];
}

export function storageView(root) {
	let rows = savedRows('storage') || [];

	const table = h('table', {class: 'results'});
	const note = h('p', {class: 'muted'});
	const current = h('p', {class: 'big', role: 'status'}, 'Counting stored entries...');

	const runButton = h('button', {class: 'primary wide', type: 'button', onclick: run}, `Write ${formatCount(ENTRY_COUNT)} entries`);
	const countButton = h('button', {type: 'button', onclick: () => recount(true)}, 'Count again');
	const reloadButton = h('button', {type: 'button', onclick: () => window.location.reload()}, 'Reload page');

	function render() {
		if (rows.length) {
			fillTable(table, rows);
			note.textContent = `Saved as the storage test ${MODE_LABELS[runMode()]}.`;
		}
		else {
			table.replaceChildren();
			note.textContent = `No result yet. Tap Write ${formatCount(ENTRY_COUNT)} entries.`;
		}
	}

	function setBusy(busy) {
		runButton.disabled = busy;
		countButton.disabled = busy;
	}

	async function run() {
		setBusy(true);
		runButton.textContent = 'Writing...';

		const next = [];

		try {
			const entries = fakeEntries(ENTRY_COUNT);
			const db = await openDb();

			try {
				const clearTx = db.transaction(DB_STORE, 'readwrite');

				clearTx.objectStore(DB_STORE).clear();
				await transactionDone(clearTx);

				const writeStarted = performance.now();
				const writeTx = db.transaction(DB_STORE, 'readwrite');
				const store = writeTx.objectStore(DB_STORE);

				for (const entry of entries) {
					store.put(entry);
				}

				await transactionDone(writeTx);

				const writeMs = performance.now() - writeStarted;

				const readStarted = performance.now();
				const readTx = db.transaction(DB_STORE, 'readonly');
				const all = await requestDone(readTx.objectStore(DB_STORE).getAll());
				const readMs = performance.now() - readStarted;

				const stored = new Set(all.map((entry) => entry.id));
				const matched = entries.filter((entry) => stored.has(entry.id)).length;

				next.push(
					['Entries written', formatCount(entries.length)],
					['Write time (one transaction)', formatMs(writeMs)],
					['Entries read back', formatCount(all.length)],
					['Read time (getAll)', formatMs(readMs)],
					['Read back matches written', `${formatCount(matched)} of ${formatCount(entries.length)}`],
					['Size as JSON', `${Math.round(JSON.stringify(all).length / 1024)} KB`],
					['crypto.randomUUID', yesNo(typeof crypto.randomUUID === 'function')]
				);
			}
			finally {
				db.close();
			}
		}
		catch (err) {
			next.push(['Write and read', errorText(err)]);
			showError('Storage test failed.', err);
		}

		next.push(...(await storageRows()), ...contextRows());

		rows = next;
		render();
		saveResult('storage', rows);

		runButton.textContent = `Write ${formatCount(ENTRY_COUNT)} entries`;
		setBusy(false);
		await recount(false);
	}

	async function recount(save) {
		setBusy(true);

		try {
			const {count, ms} = await countEntries();
			const online = navigator.onLine ? 'online' : 'offline';

			current.textContent = `${formatCount(count)} entries stored on this phone.`;

			if (save) {
				setRow(rows, 'Count again', `${formatCount(count)} entries in ${formatMs(ms)}, ${online}, at ${timestamp()}`);
				setRow(rows, 'Service worker controls page', swStatus());
				render();
				saveResult('storage', rows);
			}
		}
		catch (err) {
			current.textContent = 'Could not count the stored entries.';
			showError('Count failed.', err);

			if (save) {
				setRow(rows, 'Count again', errorText(err));
				render();
				saveResult('storage', rows);
			}
		}

		setBusy(false);
	}

	root.append(
		h('h2', null, 'Storage test'),
		h('p', null, `Writes ${formatCount(ENTRY_COUNT)} fake card entries to this phone's database, reads them back, and checks how much it may store.`),
		h('p', {class: 'muted'}, 'Offline check: run the test, turn on airplane mode, tap Reload page, then tap Count again. The count should not change.'),
		current,
		h('div', {class: 'actions'}, runButton, countButton, reloadButton),
		h('section', {class: 'card'}, h('h3', null, 'Results'), note, table)
	);

	render();
	recount(false);

	return null;
}
