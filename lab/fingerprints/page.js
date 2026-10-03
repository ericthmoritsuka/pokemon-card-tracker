// The Fingerprint Lab page: camera or photo, the scanner's own rectify.js,
// then matcher.js against index.bin. Shows the five best artwork groups
// with their TCGdex images, and how long each step took.

import {rectify} from '../../js/scan/rectify.js';
import {GUIDE_FILL, grab, startCamera} from '../js/camera.js';
import {guideRect} from '../js/pipeline.js';
import {loadIndex, match, verdict} from '../../js/vision/matcher.js';

const $ = (id) => document.getElementById(id);

let index = null;
let camera = null;

function setStatus(text) {
	$('status').textContent = text;
}

function h(tag, props = {}, ...children) {
	const el = Object.assign(document.createElement(tag), props);

	el.append(...children.filter((c) => c !== null && c !== undefined));

	return el;
}

async function start() {
	try {
		const t0 = performance.now();

		index = await loadIndex('../../js/vision/index.bin');

		const built = index.header.built ? index.header.built.slice(0, 10) : 'unknown';

		$('index-status').textContent = `Index: ${index.count.toLocaleString('en')} cards, built ${built}, ready in ${Math.round(performance.now() - t0)} ms.`;
	}
	catch (err) {
		$('index-status').textContent = `Index: could not load (${err.message}).`;
	}
}

function placeGuide() {
	const {height, width} = camera.frame;
	const guide = guideRect(width, height, GUIDE_FILL);
	const box = $('guide');

	$('viewfinder').style.aspectRatio = `${width} / ${height}`;
	Object.assign(box.style, {height: `${(guide.h / height) * 100}%`, left: `${(guide.x / width) * 100}%`, top: `${(guide.y / height) * 100}%`, width: `${(guide.w / width) * 100}%`});
	box.hidden = false;
}

async function toggleCamera() {
	if (camera) {
		camera.stop();
		camera = null;
		$('start').textContent = 'Start camera';
		$('capture').disabled = true;
		$('video').hidden = true;
		$('guide').hidden = true;
		$('placeholder').hidden = false;

		return;
	}

	try {
		camera = await startCamera($('video'));
		$('video').hidden = false;
		$('placeholder').hidden = true;
		placeGuide();
		$('start').textContent = 'Stop camera';
		$('capture').disabled = !index;
	}
	catch (err) {
		camera = null;
		setStatus(`The camera could not start. ${err.message}`);
	}
}

function show(card, note) {
	const canvas = $('card-canvas');

	canvas.width = card.width;
	canvas.height = card.height;
	canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(card.data), card.width, card.height), 0, 0);
	$('card-note').textContent = note;
}

function run(image, extra = '') {
	if (!index) {
		setStatus('The index is not loaded.');

		return;
	}

	const t0 = performance.now();
	const r = rectify(image);
	const t1 = performance.now();
	const result = match(index, r.card);
	const v = verdict(result);

	show(r.card, `${r.note}${extra}`);
	$('timings').textContent = `Straighten ${Math.round(t1 - t0)} ms, fingerprint ${Math.round(result.timings.fingerprint)} ms, match ${Math.round(result.timings.match)} ms.`;
	$('verdict').textContent = !result.groups.length ? 'Nothing matched.' : v.sure
		? `Clear match (gap ${v.gap.toFixed(1)})${v.needsText ? ': same art as other prints, so the number or language decides between them.' : '.'}`
		: `Not sure (gap ${v.gap.toFixed(1)}): pick from the list.`;

	const list = $('matches');

	list.replaceChildren(...result.groups.map((g) => {
		const first = g.cards[0];
		const others = g.cards.slice(1).map((c) => `${c.catalog} ${c.id}`).join(', ');

		return h('li', {},
			h('img', {alt: first.id, loading: 'lazy', src: `${first.image}/low.webp`}),
			h('div', {},
				h('strong', {textContent: `${first.catalog} ${first.id}${first.full ? ' (full art)' : ''}`}),
				h('p', {className: 'muted', textContent: `Score ${g.score.toFixed(1)}: art ${first.art}, card ${first.card}, colour ${first.color}`}),
				others ? h('p', {className: 'members', textContent: `Same art: ${others}`}) : null));
	}));
	$('result-panel').hidden = false;
	setStatus('');
}

function capture() {
	const {height, width} = camera.frame;

	run(grab($('video'), width, height).image);
}

async function pickPhoto(event) {
	const file = event.target.files[0];

	if (!file) {
		return;
	}

	setStatus('Reading the photo...');

	const bitmap = await createImageBitmap(file);

	// The photo as the camera would frame it: its guide area first; the whole
	// photo when no card edges are found there.
	const framed = grab(bitmap, bitmap.width, bitmap.height).image;
	const tried = rectify(framed);

	if (tried.found) {
		run(framed, ' (guide area of the photo)');
	}
	else {
		const canvas = h('canvas', {height: bitmap.height, width: bitmap.width});
		const ctx = canvas.getContext('2d', {willReadFrequently: true});

		ctx.drawImage(bitmap, 0, 0);
		run(ctx.getImageData(0, 0, bitmap.width, bitmap.height), ' (whole photo)');
	}

	event.target.value = '';
}

$('start').addEventListener('click', toggleCamera);
$('capture').addEventListener('click', capture);
$('photo').addEventListener('change', pickPhoto);
start();
