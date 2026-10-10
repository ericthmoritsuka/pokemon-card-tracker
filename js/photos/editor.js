// "Add photo" on card detail (DESIGN.md section 5, "Own photos, cropped to
// the card"): take a picture or pick one from the gallery, find the card's
// four corners, show the straightened card with four draggable corner
// handles that re-warp it live, and save a 600 x 840 WebP of about 80 KB.
// With "Keep a detail copy of new photos" on (store.js), the photo is
// opened at higher resolution and a detail copy of up to 1440 x 2016 is
// saved beside it, when the card in the photo is big enough to hold one.
//
// Everything runs on the phone. The camera is the scan lab's
// (js/vision/camera.js), so a capture is the frame the lab's edge finder was
// benchmarked on; a phone without camera access in the page uses the
// system camera through <input capture>.

import {captureRect, grab, startCamera} from '../vision/camera.js';
import {cornerEditor} from '../corners.js';
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
import {fitWithin, rotateCorners, scaleCorners, warp} from './geometry.js';
import {SIDES} from './model.js';

// The live preview: a small straightened card, warped from a copy of the
// photo at most PREVIEW_SOURCE pixels on its long side, on every drag frame.
const PREVIEW_WIDTH = 240;
const PREVIEW_HEIGHT = 336;
const PREVIEW_SOURCE = 960;

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

		const preview = h('canvas', {'aria-label': 'Straightened card', class: 'ph-preview', height: PREVIEW_HEIGHT, role: 'img', width: PREVIEW_WIDTH});
		const previewBuffer = new Uint8ClampedArray(PREVIEW_WIDTH * PREVIEW_HEIGHT * 4);

		function drawPreview() {
			const image = warp(previewPixels, scaleCorners(editor.corners, 1 / fromPreview), PREVIEW_WIDTH, PREVIEW_HEIGHT, previewBuffer);

			putPixels(preview, image);
			preview.dataset.version = String(Number(preview.dataset.version || 0) + 1);
		}

		// The photo with its corner handles (js/corners.js), the loupe above
		// the finger, and each handle's corner on data-x and data-y.
		const editor = cornerEditor({
			corners: detected,
			loupe: true,
			marks: true,
			onChange: drawPreview,
			onDragEnd: () => {
				stage.dataset.moved = 'true';
			},
			smoothing: 'high',
			source,
		});
		const {handles, stage} = editor;
		const status = message(found.note, found.found ? 'muted' : 'warn');
		const saveButton = h('button', {class: 'primary ph-save', type: 'button'}, 'Save');
		const rotate = h('button', {class: 'ph-rotate', type: 'button'}, 'Rotate');
		const reset = h('button', {class: 'ph-reset', type: 'button'}, 'Reset corners');
		const retake = h('button', {class: 'ph-retake', type: 'button'}, 'Retake');

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

		rotate.addEventListener('click', () => editor.setCorners(rotateCorners(editor.corners, 1)));
		reset.addEventListener('click', () => editor.setCorners(detected));
		retake.addEventListener('click', () => start());
		saveButton.addEventListener('click', async () => {
			if (closed) {
				return;
			}

			saveButton.disabled = true;
			saveButton.textContent = 'Saving…';

			try {
				const corners = editor.corners;
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

		editor.layout();
		drawPreview();
		handles[0].focus({preventScroll: true});
		stage.dataset.previewSize = `${previewSize.width}x${previewSize.height}`;
	}

	handle = openSheet(sheet, {onClose: onClosed});
	start();

	return {close, element: sheet};
}
