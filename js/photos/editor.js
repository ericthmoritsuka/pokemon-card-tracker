// "Add photo" on card detail (DESIGN.md section 5, "Own photos, cropped to
// the card"): take a picture or pick one from the gallery, find the card's
// four corners, show the straightened card with four draggable corner
// handles that re-warp it live, and save a 600 x 840 WebP of about 80 KB.
// With "Keep a detail copy of new photos" on (store.js), the photo is
// opened at higher resolution and a detail copy of up to 1440 x 2016 is
// saved beside it, when the card in the photo is big enough to hold one.
//
// Everything runs on the phone. The camera is the scan lab's
// (lab/js/camera.js), so a capture is the frame the lab's edge finder was
// benchmarked on; a phone without camera access in the page uses the
// system camera through <input capture>.

import {captureRect, grab, startCamera} from '../../lab/js/camera.js';
import {h} from '../dom.js';
import {openSheet} from '../sheet.js';

import {detectCorners} from './detect.js';
import {
	DETAIL_SOURCE_SIDE,
	SOURCE_SIDE,
	canvasOf,
	decodeImageFile,
	detailSize,
	drawScaled,
	encodeDetail,
	encodePhoto,
	pixelsOf,
	putPixels,
	straighten,
} from './encode.js';
import {clampPoint, fitWithin, rotateCorners, scaleCorners, warp} from './geometry.js';
import {SIDES} from './model.js';

// The live preview: a small straightened card, warped from a copy of the
// photo at most PREVIEW_SOURCE pixels on its long side, on every drag frame.
const PREVIEW_WIDTH = 240;
const PREVIEW_HEIGHT = 336;
const PREVIEW_SOURCE = 960;

const CORNER_NAMES = ['Top-left', 'Top-right', 'Bottom-right', 'Bottom-left'];

const LANGUAGE_CODES = (code) => String(code || '').toUpperCase();

export function describeCopy(entry, i) {
	const parts = [LANGUAGE_CODES(entry.language), entry.condition].filter(Boolean);

	return `Copy ${i + 1}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

function fileInput({capture}) {
	const input = h('input', {accept: 'image/*', class: 'ph-file', type: 'file'});

	if (capture) {
		input.setAttribute('capture', 'environment');
	}

	return input;
}

// Stops every touch, pointer, and key event at the sheet, so nothing under
// it (the card page's swipe and arrow keys, js/card-swipe.js) reacts while
// the corners are placed.
function contain(element) {
	for (const type of ['pointerdown', 'pointermove', 'pointerup', 'touchstart', 'touchmove', 'touchend', 'keydown']) {
		element.addEventListener(type, (event) => event.stopPropagation(), {passive: true});
	}
}

// Opens the Add photo sheet. entries: the person's live copies of this card
// (the photo goes on one of them). save({entry, blob, type, side, detail})
// stores it and resolves with the new photo; detail is {blob, type, width,
// height} or null. keepDetail: make a detail copy too. Returns {close}.
//
// The sheet is a js/sheet.js sheet: Escape, the system Back, and a route
// change close it too, and closing it always stops the camera, even one
// still starting.
export function openAddPhoto({describe = describeCopy, entries, keepDetail = false, save}) {
	let camera = null;
	// The camera start in progress, so a newer start, a step back, or
	// closing the sheet can cancel it (startCamera stops its stream).
	let cameraStart = null;
	let closed = false;

	const title = h('h2', {class: 'ph-sheet-title', id: 'ph-sheet-title'}, 'Add photo');
	const dismiss = h('button', {'aria-label': 'Close', class: 'ph-sheet-close', type: 'button'}, '×');
	const body = h('div', {class: 'ph-sheet-body'});
	const sheet = h('div', {
		'aria-labelledby': 'ph-sheet-title',
		'aria-modal': 'true',
		class: 'ph-sheet',
		'data-swipe-own': true,
		role: 'dialog',
	}, h('div', {class: 'ph-sheet-head'}, title, dismiss), body);

	contain(sheet);
	dismiss.addEventListener('click', () => close());

	const choice = {entry: entries[0], side: 'front'};

	let handle = null;

	function close() {
		if (handle) {
			handle.close();
		}
	}

	// After the sheet closes, however it closed.
	function onClosed() {
		closed = true;
		stopCamera();
	}

	function stopCamera() {
		if (cameraStart) {
			cameraStart.abort();
			cameraStart = null;
		}

		if (camera) {
			camera.stop();
			camera = null;
		}
	}

	function message(text, kind = 'muted') {
		return h('p', {class: `ph-message ${kind}`, role: kind === 'error' ? 'alert' : null}, text);
	}

	// Rewrites a message in place, so a second error shows as the first did.
	function setMessage(element, text, kind = 'muted') {
		element.className = `ph-message ${kind}`;

		if (kind === 'error') {
			element.setAttribute('role', 'alert');
		}
		else {
			element.removeAttribute('role');
		}

		element.textContent = text;
	}

	// ----------------------------------------------------------- step 1

	function start(note = null) {
		stopCamera();
		title.textContent = 'Add photo';

		const copy = entries.length > 1
			? h('label', {class: 'ph-field'}, 'Which copy',
				h('select', {class: 'ph-copy', onchange: (event) => {
					choice.entry = entries[Number(event.target.value)];
				}}, entries.map((entry, i) => h('option', {selected: entry === choice.entry, value: String(i)}, describe(entry, i)))))
			: null;

		const sides = h('fieldset', {class: 'ph-sides'},
			h('legend', null, 'Side'),
			...SIDES.map((side) => h('label', {class: 'ph-side'},
				h('input', {checked: choice.side === side, name: 'ph-side', onchange: () => {
					choice.side = side;
				}, type: 'radio', value: side}),
				h('span', null, side === 'front' ? 'Front' : 'Back')
			))
		);

		const gallery = fileInput({capture: false});
		const system = fileInput({capture: true});
		const take = h('button', {class: 'primary ph-take', type: 'button'}, 'Take photo');
		const pick = h('button', {class: 'ph-pick', type: 'button'}, 'Choose from gallery');
		const cancel = h('button', {class: 'ph-cancel', type: 'button'}, 'Cancel');

		take.addEventListener('click', () => {
			if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
				openCamera();
			}
			else {
				system.click();
			}
		});
		pick.addEventListener('click', () => gallery.click());
		cancel.addEventListener('click', close);

		for (const input of [gallery, system]) {
			input.addEventListener('change', () => {
				const file = input.files && input.files[0];

				if (file) {
					openFile(file);
				}
			});
		}

		// replaceChildren prints a null argument as the text "null", so the
		// note and the copy picker are left out when there is none.
		body.replaceChildren(...[
			note,
			copy,
			sides,
			h('p', {class: 'muted ph-tip'}, 'Lay the card on a plain, dark surface and fill most of the picture with it.'),
			h('div', {class: 'ph-actions'}, take, pick, cancel),
			gallery,
			system,
		].filter(Boolean));
		take.focus({preventScroll: true});
	}

	// ----------------------------------------------------------- camera

	async function openCamera() {
		stopCamera();
		title.textContent = 'Take photo';

		const video = h('video', {autoplay: true, class: 'ph-video', muted: true, playsinline: true});
		const guide = h('div', {class: 'ph-guide', 'aria-hidden': 'true'});
		const shutter = h('button', {class: 'primary ph-shutter', disabled: true, type: 'button'}, 'Capture');
		const torch = h('button', {class: 'ph-torch', hidden: true, type: 'button'}, 'Torch');
		const back = h('button', {class: 'ph-cancel', type: 'button'}, 'Back');
		const status = message('Starting the camera…');

		body.replaceChildren(h('div', {class: 'ph-camera'}, video, guide), status, h('div', {class: 'ph-actions'}, shutter, torch, back));
		back.addEventListener('click', () => start());

		const run = new AbortController();

		cameraStart = run;

		try {
			camera = await startCamera(video, {signal: run.signal});
		}
		catch (err) {
			if (run.signal.aborted) {
				// Back, a newer start, or the sheet closed: startCamera has
				// stopped the stream it opened.
				return;
			}

			cameraStart = null;
			// No permission or no camera: the system camera app still works.
			start(message(`The camera did not start (${(err && err.message) || err}). Choose a photo from the gallery, or use "Take photo" again to try once more.`, 'error'));

			return;
		}

		cameraStart = null;

		if (closed) {
			stopCamera();

			return;
		}

		const placeGuide = () => {
			const {height, width} = camera.frame;
			const rect = captureRect(width, height).guide;
			const scale = Math.min(video.clientWidth / width, video.clientHeight / height) || 1;
			const offsetX = (video.clientWidth - width * scale) / 2;
			const offsetY = (video.clientHeight - height * scale) / 2;

			Object.assign(guide.style, {
				height: `${rect.h * scale}px`,
				left: `${offsetX + rect.x * scale}px`,
				top: `${offsetY + rect.y * scale}px`,
				width: `${rect.w * scale}px`,
			});
		};

		placeGuide();
		status.textContent = 'Fill the frame with the card, then capture.';
		shutter.disabled = false;
		torch.hidden = !camera.torchSupported;
		torch.addEventListener('click', () => camera && camera.setTorch(!camera.torch).catch(() => {}));
		shutter.addEventListener('click', () => {
			if (closed || !camera) {
				return;
			}

			const {height, width} = camera.frame;
			const {image} = grab(video, width, height);
			const canvas = canvasOf(image.width, image.height);

			putPixels(canvas, image);
			stopCamera();
			edit(drawScaled(canvas, canvas.width, canvas.height, keepDetail ? DETAIL_SOURCE_SIDE : SOURCE_SIDE));
		});
	}

	// ----------------------------------------------------------- file

	async function openFile(file) {
		body.replaceChildren(message('Opening the photo…'));

		try {
			const source = await decodeImageFile(file, keepDetail ? DETAIL_SOURCE_SIDE : SOURCE_SIDE);

			if (!closed) {
				edit(source);
			}
		}
		catch (err) {
			if (!closed) {
				start(message((err && err.message) || String(err), 'error'));
			}
		}
	}

	// ----------------------------------------------------------- editor

	function edit(source) {
		title.textContent = 'Fit the corners';

		// What detection and the preview read: smaller copies of the photo.
		const previewSize = fitWithin(source.width, source.height, PREVIEW_SOURCE);
		const previewCanvas = drawScaled(source, source.width, source.height, PREVIEW_SOURCE);
		const previewPixels = pixelsOf(previewCanvas);
		const found = detectCorners(previewPixels);
		const fromPreview = source.width / previewCanvas.width;
		const detected = scaleCorners(found.corners, fromPreview);
		let corners = detected.map((p) => ({...p}));

		const photo = h('canvas', {'aria-hidden': 'true', class: 'ph-photo'});
		const outline = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		const shape = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
		const loupe = h('canvas', {'aria-hidden': 'true', class: 'ph-loupe', height: 112, hidden: true, width: 112});
		const handles = CORNER_NAMES.map((name, i) => h('button', {
			'aria-label': `${name} corner. Drag, or use the arrow keys.`,
			class: 'ph-handle',
			'data-corner': String(i),
			type: 'button',
		}));
		const stage = h('div', {class: 'ph-stage'}, photo, outline, ...handles, loupe);
		const preview = h('canvas', {'aria-label': 'Straightened card', class: 'ph-preview', height: PREVIEW_HEIGHT, role: 'img', width: PREVIEW_WIDTH});
		const status = message(found.note, found.found ? 'muted' : 'warn');
		const saveButton = h('button', {class: 'primary ph-save', type: 'button'}, 'Save');
		const rotate = h('button', {class: 'ph-rotate', type: 'button'}, 'Rotate');
		const reset = h('button', {class: 'ph-reset', type: 'button'}, 'Reset corners');
		const retake = h('button', {class: 'ph-retake', type: 'button'}, 'Retake');

		outline.setAttribute('class', 'ph-outline');
		outline.setAttribute('aria-hidden', 'true');
		outline.append(shape);
		stage.dataset.method = found.method;
		stage.dataset.found = String(found.found);

		body.replaceChildren(
			stage,
			h('div', {class: 'ph-review'},
				preview,
				h('div', {class: 'ph-review-actions'}, saveButton, rotate, reset, retake)
			),
			status
		);

		// The photo is drawn at the size it shows; handles sit on it in CSS
		// pixels, and their positions convert to source pixels by `scale`.
		let scale = 1;

		function layout() {
			const room = Math.min(stage.parentElement.clientWidth || 328, 560);
			const maxHeight = Math.max(240, Math.round(window.innerHeight * 0.48));
			const fit = Math.min(room / source.width, maxHeight / source.height);
			const width = Math.round(source.width * fit);
			const height = Math.round(source.height * fit);

			scale = fit;
			photo.width = Math.round(width * Math.min(2, window.devicePixelRatio || 1));
			photo.height = Math.round(height * Math.min(2, window.devicePixelRatio || 1));
			photo.style.width = `${width}px`;
			photo.style.height = `${height}px`;
			stage.style.width = `${width}px`;
			stage.style.height = `${height}px`;
			outline.setAttribute('viewBox', `0 0 ${width} ${height}`);
			outline.setAttribute('width', String(width));
			outline.setAttribute('height', String(height));

			const ctx = photo.getContext('2d');

			ctx.imageSmoothingQuality = 'high';
			ctx.drawImage(source, 0, 0, photo.width, photo.height);
			drawOverlay();
		}

		function drawOverlay() {
			shape.setAttribute('points', corners.map((p) => `${p.x * scale},${p.y * scale}`).join(' '));
			handles.forEach((handle, i) => {
				handle.style.transform = `translate(${corners[i].x * scale}px, ${corners[i].y * scale}px)`;
				handle.dataset.x = corners[i].x.toFixed(1);
				handle.dataset.y = corners[i].y.toFixed(1);
			});
		}

		const previewBuffer = new Uint8ClampedArray(PREVIEW_WIDTH * PREVIEW_HEIGHT * 4);
		let frame = 0;

		function drawPreview() {
			frame = 0;

			const image = warp(previewPixels, scaleCorners(corners, 1 / fromPreview), PREVIEW_WIDTH, PREVIEW_HEIGHT, previewBuffer);

			putPixels(preview, image);
			preview.dataset.version = String(Number(preview.dataset.version || 0) + 1);
		}

		function schedule() {
			drawOverlay();

			if (!frame) {
				frame = requestAnimationFrame(drawPreview);
			}
		}

		function drawLoupe(i) {
			const size = loupe.width;
			const zoom = 3;
			const span = size / (zoom * scale);
			const ctx = loupe.getContext('2d');
			const p = corners[i];

			ctx.fillStyle = '#000';
			ctx.fillRect(0, 0, size, size);
			ctx.drawImage(source, p.x - span / 2, p.y - span / 2, span, span, 0, 0, size, size);
			ctx.strokeStyle = '#ffcb05';
			ctx.lineWidth = 2;
			ctx.beginPath();
			ctx.moveTo(size / 2, 0);
			ctx.lineTo(size / 2, size);
			ctx.moveTo(0, size / 2);
			ctx.lineTo(size, size / 2);
			ctx.stroke();

			// Above the finger, or below it near the top edge.
			const x = Math.min(stage.clientWidth - size, Math.max(0, p.x * scale - size / 2));
			const above = p.y * scale - size - 40;
			const y = above >= 0 ? above : p.y * scale + 40;

			loupe.style.transform = `translate(${x}px, ${y}px)`;
		}

		handles.forEach((handle, i) => {
			let drag = null;

			handle.addEventListener('pointerdown', (event) => {
				event.preventDefault();
				drag = {id: event.pointerId, start: {...corners[i]}, x: event.clientX, y: event.clientY};
				handle.setPointerCapture(event.pointerId);
				handle.classList.add('ph-dragging');
				loupe.hidden = false;
				drawLoupe(i);
			});
			handle.addEventListener('pointermove', (event) => {
				if (!drag || event.pointerId !== drag.id) {
					return;
				}

				// The corner moves by the finger's movement, not to the finger,
				// so the finger never has to cover the corner it is placing.
				corners[i] = clampPoint({
					x: drag.start.x + (event.clientX - drag.x) / scale,
					y: drag.start.y + (event.clientY - drag.y) / scale,
				}, source.width, source.height);
				drawLoupe(i);
				schedule();
			});

			const end = (event) => {
				if (drag && event.pointerId === drag.id) {
					drag = null;
					handle.classList.remove('ph-dragging');
					loupe.hidden = true;
					stage.dataset.moved = 'true';
					schedule();
				}
			};

			handle.addEventListener('pointerup', end);
			handle.addEventListener('pointercancel', end);
			handle.addEventListener('keydown', (event) => {
				const step = (event.shiftKey ? 10 : 1) / scale;
				const moves = {ArrowDown: [0, step], ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step]};
				const move = moves[event.key];

				if (move) {
					event.preventDefault();
					corners[i] = clampPoint({x: corners[i].x + move[0], y: corners[i].y + move[1]}, source.width, source.height);
					schedule();
				}
			});
		});

		rotate.addEventListener('click', () => {
			corners = rotateCorners(corners, 1);
			schedule();
		});
		reset.addEventListener('click', () => {
			corners = detected.map((p) => ({...p}));
			schedule();
		});
		retake.addEventListener('click', () => start());
		saveButton.addEventListener('click', async () => {
			if (closed) {
				return;
			}

			saveButton.disabled = true;
			saveButton.textContent = 'Saving…';

			try {
				const card = straighten(source, corners);
				const {blob, type} = await encodePhoto(card);
				const size = keepDetail ? detailSize(corners) : null;
				let detail = null;

				if (size) {
					const encoded = await encodeDetail(straighten(source, corners, size.width, size.height));

					detail = {blob: encoded.blob, height: encoded.height, type: encoded.type, width: encoded.width};
				}

				// Closed while encoding (Back to another screen): nothing is
				// saved on a copy no longer shown.
				if (closed) {
					return;
				}

				const saved = await save({blob, detail, entry: choice.entry, side: choice.side, type});

				sheet.dataset.saved = saved ? saved.id : '';
				close();
			}
			catch (err) {
				saveButton.disabled = false;
				saveButton.textContent = 'Save';
				setMessage(status, `Could not save the photo: ${(err && err.message) || err}`, 'error');
			}
		});

		layout();
		drawPreview();
		handles[0].focus({preventScroll: true});
		stage.dataset.previewSize = `${previewSize.width}x${previewSize.height}`;
	}

	handle = openSheet(sheet, {onClose: onClosed});
	start();

	return {close, element: sheet};
}
