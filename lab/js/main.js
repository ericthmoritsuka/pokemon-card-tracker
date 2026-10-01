// The scan lab page: capture, read, match, verdict, score.

import {GUIDE_FILL, grab, startCamera} from './camera.js';
import {addAttempt, exportCsv, exportJson, isPersistent, loadAttempts, resetAttempts, summarise} from './log.js';
import {findCandidates, sameNumber} from './match.js';
import {createEngine, TESSERACT_VERSION} from './ocr.js';
import {CARD_RATIO, guideRect, LANGUAGE_NAMES, readCard} from './pipeline.js';
import {rectify} from './rectify.js';

const $ = (id) => document.getElementById(id);

function h(tag, attrs, ...children) {
	const el = document.createElement(tag);

	for (const [key, value] of Object.entries(attrs || {})) {
		if (value === null || value === undefined || value === false) {
			continue;
		}

		if (key === 'class') {
			el.className = value;
		}
		else if (key.startsWith('on') && typeof value === 'function') {
			el.addEventListener(key.slice(2), value);
		}
		else {
			el.setAttribute(key, value === true ? '' : String(value));
		}
	}

	for (const child of children.flat()) {
		if (child !== null && child !== undefined && child !== false) {
			el.append(child instanceof Node ? child : String(child));
		}
	}

	return el;
}

const errorText = (err) => (err && err.name && err.message ? `${err.name}: ${err.message}` : String(err));

const percent = ({of, right}) => (of ? `${Math.round((right / of) * 100)} % (${right} of ${of})` : 'No attempts yet');

const ACTUAL_LANGUAGES = ['en', 'pt', 'fr', 'de', 'it', 'es', 'ja', 'ko', 'zh-cn', 'zh-tw'];
const ACTUAL_NAMES = {...LANGUAGE_NAMES, ko: 'Korean', 'zh-cn': 'Chinese (Simplified)', 'zh-tw': 'Chinese (Traditional)'};
const NOT_LATIN = new Set(['ja', 'ko', 'zh-cn', 'zh-tw']);

let engine = null;
let enginePromise = null;
let camera = null;
let busy = false;
let current = null;

// ------------------------------------------------------------ status lines

function setStatus(text, kind = 'busy') {
	const status = $('read-status');

	status.textContent = text;
	status.className = `status ${kind}`;
}

function startEngine() {
	if (!enginePromise) {
		const line = $('engine-status');

		line.textContent = 'OCR engine: loading from this site (about 5 MB the first time).';
		enginePromise = createEngine({
			logger: (message) => {
				if (message.status && typeof message.progress === 'number' && message.progress < 1) {
					line.textContent = `OCR engine: ${message.status}, ${Math.round(message.progress * 100)} %.`;
				}
			},
		})
			.then((started) => {
				engine = started;
				line.textContent = `OCR engine: ready. Tesseract.js ${TESSERACT_VERSION}, English LSTM model, loaded in ${started.loadMs} ms.`;

				return started;
			})
			.catch((err) => {
				enginePromise = null;
				line.textContent = `OCR engine failed to start: ${errorText(err)}`;
				throw err;
			});
	}

	return enginePromise;
}

// ------------------------------------------------------------ camera

function placeGuide() {
	const {height, width} = camera.frame;
	const guide = guideRect(width, height, GUIDE_FILL);
	const box = $('guide');

	$('viewfinder').style.aspectRatio = `${width} / ${height}`;
	box.style.left = `${(guide.x / width) * 100}%`;
	box.style.top = `${(guide.y / height) * 100}%`;
	box.style.width = `${(guide.w / width) * 100}%`;
	box.style.height = `${(guide.h / height) * 100}%`;
	box.hidden = false;
}

async function toggleCamera() {
	const start = $('start');

	if (camera) {
		camera.stop();
		camera = null;
		$('video').hidden = true;
		$('guide').hidden = true;
		$('placeholder').hidden = false;
		$('viewfinder').style.aspectRatio = '';
		$('capture').disabled = true;
		$('torch').hidden = true;
		$('zoom-row').hidden = true;
		$('camera-info').textContent = '';
		start.textContent = 'Start camera';

		return;
	}

	start.disabled = true;
	start.textContent = 'Starting...';

	try {
		camera = await startCamera($('video'));
		$('video').hidden = false;
		$('placeholder').hidden = true;
		placeGuide();
		$('capture').disabled = false;
		$('torch').hidden = !camera.torchSupported;

		if (camera.zoomRange && camera.zoomRange.max > camera.zoomRange.min) {
			const zoom = $('zoom');

			zoom.min = String(camera.zoomRange.min);
			zoom.max = String(camera.zoomRange.max);
			zoom.step = String(camera.zoomRange.step);
			zoom.value = String(camera.zoom);
			$('zoom-value').textContent = Number(camera.zoom).toFixed(1);
			$('zoom-row').hidden = false;
		}

		const {height, width} = camera.frame;
		const max = camera.caps && camera.caps.width ? `; the camera reports up to ${camera.caps.width.max} x ${camera.caps.height.max}` : '';

		$('camera-info').textContent = `${camera.label}: ${width} x ${height}${max}. Started in ${camera.startMs} ms.`;
		start.textContent = 'Stop camera';
		startEngine().catch(() => {});
	}
	catch (err) {
		camera = null;
		start.textContent = 'Start camera';
		setStatus(`The camera could not start. ${errorText(err)}`, 'error');
	}

	start.disabled = false;
}

async function toggleTorch() {
	const button = $('torch');

	try {
		await camera.setTorch(!camera.torch);
		button.textContent = camera.torch ? 'Torch: on' : 'Torch: off';
		button.setAttribute('aria-pressed', String(camera.torch));
	}
	catch (err) {
		setStatus(`The torch could not be switched. ${errorText(err)}`, 'error');
	}
}

async function changeZoom() {
	const value = Number($('zoom').value);

	$('zoom-value').textContent = value.toFixed(1);

	try {
		await camera.setZoom(value);
	}
	catch (err) {
		setStatus(`Zoom could not be changed. ${errorText(err)}`, 'error');
	}
}

// ------------------------------------------------------------ read

function toCanvas(image) {
	const canvas = h('canvas', {height: image.height, width: image.width});

	canvas.getContext('2d').putImageData(new ImageData(image.data, image.width, image.height), 0, 0);

	return canvas;
}

async function readAndMatch(source, frame, info) {
	if (busy) {
		return;
	}

	busy = true;
	$('capture').disabled = true;
	setStatus('Reading the card...');

	try {
		const ready = await startEngine();
		const started = performance.now();
		const rectified = rectify(info.image);
		const rectifyMs = Math.round(performance.now() - started);
		const read = await readCard(rectified.card, ready.ocr);

		setStatus('Looking the number up in TCGdex...');

		let found = {candidates: [], ms: 0, searched: []};
		let matchError = null;

		try {
			found = await findCandidates(read, {limit: 6});
		}
		catch (err) {
			matchError = err;
		}

		current = {
			camera: {torch: camera ? camera.torch : null, zoom: camera ? camera.zoom : null},
			candidates: found.candidates,
			chosen: undefined,
			frame,
			matchError,
			read,
			rectified,
			searched: found.searched,
			source,
			timings: {match: found.ms, ocr: read.timings.ocr, rectify: rectifyMs},
		};

		renderRead();
		renderCandidates();
		$('verdict-panel').hidden = true;
		setStatus(`Read in ${read.timings.ocr + rectifyMs} ms. Mark the right card below.`, 'ok');
	}
	catch (err) {
		setStatus(`Reading failed. ${errorText(err)}`, 'error');
	}
	finally {
		busy = false;
		$('capture').disabled = !camera;
	}
}

function capture() {
	const video = $('video');
	const width = video.videoWidth;
	const height = video.videoHeight;

	if (!width || !height) {
		setStatus('The camera has no frame yet.', 'error');

		return;
	}

	readAndMatch('camera', `${width} x ${height}`, grab(video, width, height));
}

async function readPhoto(event) {
	const file = event.target.files && event.target.files[0];

	event.target.value = '';

	if (!file) {
		return;
	}

	try {
		const bitmap = await createImageBitmap(file);
		const {height, width} = bitmap;

		// A photo already cut to the card is read whole; any other photo is
		// treated like a camera frame, cut to where the guide would be.
		const cardShaped = Math.abs(width / height - CARD_RATIO) / CARD_RATIO < 0.08;
		let info;

		if (cardShaped) {
			const canvas = h('canvas', {height, width});
			const ctx = canvas.getContext('2d', {willReadFrequently: true});

			ctx.drawImage(bitmap, 0, 0);
			info = {image: ctx.getImageData(0, 0, width, height), rect: {h: height, w: width, x: 0, y: 0}};
		}
		else {
			info = grab(bitmap, width, height);
		}

		await readAndMatch('photo', `${width} x ${height}`, info);
	}
	catch (err) {
		setStatus(`That photo could not be read. ${errorText(err)}`, 'error');
	}
}

const yesNo = (value) => (value ? 'Yes' : 'No');
const confidence = (value) => (typeof value === 'number' ? `${Math.round(value * 100)} %` : '');

function renderRead() {
	const {read, rectified, timings} = current;
	const number = read.number;
	const card = rectified.card;
	const cardCanvas = $('card-canvas');

	cardCanvas.width = card.width;
	cardCanvas.height = card.height;
	cardCanvas.getContext('2d').putImageData(new ImageData(card.data, card.width, card.height), 0, 0);
	$('card-note').textContent = `${rectified.note} ${card.width} x ${card.height} px${rectified.found && rectified.angle ? `, straightened by ${rectified.angle} degrees` : ''}.`;

	const rows = [
		['Number', number ? `${number.numberPrinted} (read as ${number.number})` : 'Not read'],
		['Total', number ? number.total : 'Not read'],
		['Where', number ? (number.side === 'left' ? 'Bottom left (Sun & Moon and later)' : 'Bottom right (XY and earlier)') : ''],
		['Number confidence', number ? confidence(number.confidence) : ''],
		['Set code box', number && number.side === 'left' ? (read.setCodeBox.run || 'Not read') : 'Not printed on this layout'],
		['Language code in the box', number && number.langCode ? ACTUAL_NAMES[number.langCode] : 'None read'],
		['Regulation mark', number && number.regulationMark ? number.regulationMark : 'None read'],
		['Copyright year', read.copyrightYear || 'Not read'],
		['Names Wizards', yesNo(read.wizards)],
		['Label language', read.label.code ? `${ACTUAL_NAMES[read.label.code]}, ${confidence(read.label.confidence)}` : 'No Latin label read'],
		['Language', `${ACTUAL_NAMES[read.language.code] || read.language.code}, ${confidence(read.language.confidence)} (from ${read.language.source})`],
		['Time', `straighten ${timings.rectify} ms, OCR ${timings.ocr} ms (label ${read.timings.label}, left ${read.timings.numberLeft}, right ${read.timings.numberRight}${read.timings.setCode ? `, set code ${read.timings.setCode}` : ''})`],
	];

	$('parsed').replaceChildren(...rows.map(([label, value]) => h('tr', null, h('th', {scope: 'row'}, label), h('td', null, value))));

	const groups = [
		['Label row', ['label', 'labelLine1', 'labelLine2'], read.raw.label],
		['Number strip, bottom left', ['numberLeft', 'numberLeftLine1', 'numberLeftLine2', 'numberLeftLine3'], read.raw.numberLeft],
		['Number strip, bottom right', ['numberRight', 'numberRightLine1', 'numberRightLine2'], read.raw.numberRight],
		['Set code box (inverted)', ['setCode'], read.raw.setCode],
	];

	$('regions').replaceChildren(...groups
		.filter(([, , raw]) => raw)
		.map(([title, keys, raw]) => h('div', {class: 'region'},
			h('h4', null, title),
			keys.filter((key) => read.crops[key]).map((key) => toCanvas(read.crops[key])),
			h('pre', null, raw.text || '(no text)'))));

	$('read-panel').hidden = false;
}

// ------------------------------------------------------------ match

function renderCandidates() {
	const {candidates, matchError, read, searched} = current;
	const list = $('candidates');
	const languages = searched.map((code) => ACTUAL_NAMES[code] || code).join(', then ');

	if (matchError) {
		$('match-note').textContent = `TCGdex could not be reached: ${errorText(matchError)} Mark "None of these" and type the number.`;
	}
	else if (!read.number) {
		$('match-note').textContent = 'No number was read, so there is nothing to look up. Mark "None of these" and type the number.';
	}
	else if (!candidates.length) {
		$('match-note').textContent = `No card ${read.number.number}/${read.number.total} in ${languages}.`;
	}
	else {
		$('match-note').textContent = `Best first. Searched ${languages}. Tap the card you scanned.`;
	}

	list.replaceChildren(...candidates.map((candidate, index) => h('li', {class: current.chosen === index ? 'chosen' : null},
		candidate.image
			? h('img', {alt: `${candidate.name}, ${candidate.setName}`, decoding: 'async', loading: 'lazy', src: `${candidate.image}/low.webp`})
			: h('div', {class: 'no-image'}, 'No image in TCGdex'),
		h('span', {class: 'name'}, `${index + 1}. ${candidate.name}`),
		h('span', {class: 'meta'}, `${candidate.setName} (${candidate.setId}), ${candidate.localId}/${candidate.official}, ${ACTUAL_NAMES[candidate.lang] || candidate.lang} catalog`),
		h('span', {class: 'meta'}, `Score ${candidate.score}: ${candidate.reasons.join(', ')}`),
		h('button', {onclick: () => choose(index), type: 'button'}, 'This one'))));

	$('match-panel').hidden = false;
}

function choose(index) {
	current.chosen = index;

	const candidate = index === null ? null : current.candidates[index];
	const number = current.read.number;
	const detected = current.read.language.code;

	$('verdict-choice').textContent = candidate
		? `Chosen: ${index + 1}. ${candidate.name}, ${candidate.setName}. Correct the number and language if they are wrong.`
		: 'None of the candidates. Type the number and language as printed on the card.';
	$('actual-number').value = candidate
		? `${candidate.localId}/${candidate.official}`
		: (number ? `${number.numberPrinted}/${number.totalPrinted}` : '');
	$('actual-language').value = detected === 'non-latin' ? 'ja' : detected;

	renderCandidates();
	$('verdict-panel').hidden = false;
	$('verdict-panel').scrollIntoView({behavior: 'smooth', block: 'start'});
}

function saveVerdict(event) {
	event.preventDefault();

	if (!current || current.chosen === undefined) {
		return;
	}

	const [actualNumber = '', actualTotal = ''] = $('actual-number').value.trim().toUpperCase().split(/\s*\/\s*/);
	const actualLanguage = $('actual-language').value;
	const {candidates, chosen, read} = current;
	const number = read.number;
	const detected = read.language.code;
	const candidate = chosen === null ? null : candidates[chosen];

	addAttempt({
		at: new Date().toISOString(),
		camera: current.camera,
		candidates: candidates.map((c) => ({id: c.id, lang: c.lang, reasons: c.reasons, score: c.score})),
		cardPx: `${current.rectified.card.width} x ${current.rectified.card.height}`,
		frame: current.frame,
		raw: {
			label: read.raw.label.text,
			numberLeft: read.raw.numberLeft.text,
			numberRight: read.raw.numberRight.text,
			setCode: read.raw.setCode ? read.raw.setCode.text : '',
		},
		read: {
			copyrightYear: read.copyrightYear,
			labelConfidence: read.label.confidence,
			labelLanguage: read.label.code,
			langCode: number ? number.langCode : null,
			language: detected,
			languageConfidence: read.language.confidence,
			number: number ? number.number : null,
			numberConfidence: number ? number.confidence : null,
			regulationMark: number ? number.regulationMark : null,
			setCodeRun: number ? number.setCodeRun || null : null,
			side: number ? number.side : null,
			total: number ? number.total : null,
			wizards: read.wizards,
		},
		rectify: {angle: current.rectified.angle, found: current.rectified.found},
		searched: current.searched,
		source: current.source,
		timings: current.timings,
		userAgent: navigator.userAgent,
		verdict: {
			actualLanguage,
			actualNumber,
			actualTotal,
			chosenId: candidate ? candidate.id : null,
			chosenRank: candidate ? chosen + 1 : null,
			languageRight: NOT_LATIN.has(actualLanguage) ? detected === 'non-latin' : detected === actualLanguage,
			numberRight: Boolean(number) && sameNumber(number.number, actualNumber) && Number(number.total) === Number(actualTotal),
			top1: chosen === 0,
			top3: chosen !== null && chosen < 3,
		},
	});

	current = null;
	$('verdict-panel').hidden = true;
	$('match-panel').hidden = true;
	$('read-panel').hidden = true;
	setStatus('Saved. Capture the next card.', 'ok');
	renderScore();
	window.scrollTo({behavior: 'smooth', top: 0});
}

// ------------------------------------------------------------ score

function renderScore() {
	const summary = summarise();
	const rows = [
		['Attempts', String(summary.count)],
		['Number and total read right', percent(summary.numberRight)],
		['Language right', percent(summary.languageRight)],
		['Right card first', percent(summary.top1)],
		['Right card in the top 3', percent(summary.top3)],
		['OCR time, median', summary.medianOcrMs === null ? '' : `${summary.medianOcrMs} ms`],
		['OCR time, slowest', summary.slowestOcrMs === null ? '' : `${summary.slowestOcrMs} ms`],
	];

	$('summary').replaceChildren(...rows.map(([label, value]) => h('tr', null, h('th', {scope: 'row'}, label), h('td', null, value))));
	$('storage-note').textContent = isPersistent()
		? 'Kept on this phone in this browser. Export before clearing site data.'
		: 'This browser is not keeping the log (private tab or storage blocked). It lasts until the page closes; export it before then.';

	const attempts = loadAttempts().slice(-30).reverse();
	const head = ['When', 'Read', 'Actual', 'Language', 'Actual', 'Chosen', 'OCR ms'];

	$('log').replaceChildren(
		h('thead', null, h('tr', null, head.map((label) => h('th', {scope: 'col'}, label)))),
		h('tbody', null, attempts.map((a) => h('tr', null,
			h('td', null, a.at.slice(5, 16).replace('T', ' ')),
			h('td', null, a.read.number ? `${a.read.number}/${a.read.total}` : '-'),
			h('td', null, `${a.verdict.actualNumber}/${a.verdict.actualTotal}`),
			h('td', null, a.read.language),
			h('td', null, a.verdict.actualLanguage),
			h('td', null, a.verdict.chosenRank ? `#${a.verdict.chosenRank} ${a.verdict.chosenId}` : 'none'),
			h('td', null, String(a.timings.ocr))))));
}

function reset() {
	// eslint-disable-next-line no-alert
	if (window.confirm('Delete every saved attempt on this phone? Export first if you want to keep them.')) {
		resetAttempts();
		renderScore();
	}
}

// ------------------------------------------------------------ start

$('actual-language').replaceChildren(...ACTUAL_LANGUAGES.map((code) => h('option', {value: code}, ACTUAL_NAMES[code])));
$('start').addEventListener('click', toggleCamera);
$('capture').addEventListener('click', capture);
$('torch').addEventListener('click', toggleTorch);
$('zoom').addEventListener('change', changeZoom);
$('photo').addEventListener('change', readPhoto);
$('none').addEventListener('click', () => choose(null));
$('verdict-form').addEventListener('submit', saveVerdict);
$('export-json').addEventListener('click', exportJson);
$('export-csv').addEventListener('click', exportCsv);
$('reset').addEventListener('click', reset);

renderScore();
startEngine().catch(() => {});
