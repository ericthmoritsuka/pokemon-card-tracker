// The Adjust sheet for one of the owner's photos (DESIGN.md section 5,
// "Adjust a photo"; Eric, 2026-10-31): the photo, Auto, four sliders
// (Brightness, Contrast, Saturation, Warmth), Reset, and a before and after
// view, held on the photo or toggled with Original. The preview redraws at
// most once per animation frame while a slider moves. The pixel work is
// adjust.js; saving the result is the caller's (index.js).

import {h} from '../dom.js';
import {openSheet} from '../sheet.js';

import {SLIDERS, SLIDER_MAX, SLIDER_MIN, applyAdjust, autoLevels, isNeutral, neutralSettings} from './adjust.js';
import {contain} from './editor.js';
import {canvasOf, pixelsOf, putPixels} from './encode.js';

const LABELS = {
	brightness: 'Brightness',
	contrast: 'Contrast',
	saturation: 'Saturation',
	warmth: 'Warmth',
};

const signed = (n) => (n > 0 ? `+${n}` : String(n));

// Opens the sheet. load() resolves with a canvas of the photo as stored.
// save({canvas, settings}) gets the adjusted photo at the same size and the
// settings (for the detail copy) and resolves once it is saved; a throw
// shows its message and keeps the sheet open. Cancel, the close button,
// Escape, and Back change nothing. Returns {close, element}.
export function openAdjustPhoto({load, save}) {
	let closed = false;
	let handle = null;

	const title = h('h2', {class: 'ph-sheet-title', id: 'ph-adjust-title'}, 'Adjust photo');
	const dismiss = h('button', {'aria-label': 'Close', class: 'ph-sheet-close', type: 'button'}, '×');
	const body = h('div', {class: 'ph-sheet-body ph-adjust'});
	const sheet = h('div', {
		'aria-labelledby': 'ph-adjust-title',
		'aria-modal': 'true',
		class: 'ph-sheet ph-adjust-sheet',
		'data-swipe-own': true,
		role: 'dialog',
	}, h('div', {class: 'ph-sheet-head'}, title, dismiss), body);

	contain(sheet);

	const close = () => {
		if (handle) {
			handle.close();
		}
	};

	dismiss.addEventListener('click', close);

	const status = h('p', {class: 'ph-message muted'}, 'Opening the photo…');

	body.replaceChildren(status);

	function setStatus(text, kind = 'muted') {
		status.className = `ph-message ${kind}`;

		if (kind === 'error') {
			status.setAttribute('role', 'alert');
		}
		else {
			status.removeAttribute('role');
		}

		status.textContent = text;
	}

	function edit(source) {
		const original = pixelsOf(source);
		const buffer = new Uint8ClampedArray(original.data.length);
		const settings = neutralSettings();
		let auto = null;
		let showOriginal = false;
		let holding = false;
		let frame = 0;

		const preview = h('canvas', {'aria-label': 'Adjusted photo', class: 'ph-adjust-preview', height: source.height, role: 'img', width: source.width});
		const badge = h('span', {class: 'ph-adjust-badge', hidden: true}, 'Original');
		const autoButton = h('button', {'aria-pressed': 'false', class: 'ph-adjust-auto', type: 'button'}, 'Auto');
		const originalButton = h('button', {'aria-pressed': 'false', class: 'ph-adjust-original', type: 'button'}, 'Original');
		const reset = h('button', {class: 'ph-adjust-reset', type: 'button'}, 'Reset');
		const saveButton = h('button', {class: 'primary ph-adjust-save', disabled: true, type: 'button'}, 'Save');
		const cancel = h('button', {class: 'ph-cancel', type: 'button'}, 'Cancel');
		const inputs = {};
		const outputs = {};

		const rows = SLIDERS.map((key) => {
			const id = `ph-adjust-${key}`;

			inputs[key] = h('input', {class: 'ph-adjust-slider', 'data-key': key, id, max: SLIDER_MAX, min: SLIDER_MIN, step: 1, type: 'range', value: 0});
			outputs[key] = h('output', {class: 'ph-adjust-value', for: id}, '0');
			inputs[key].addEventListener('input', () => {
				settings[key] = Number(inputs[key].value) || 0;
				outputs[key].textContent = signed(settings[key]);
				changed();
			});

			return h('div', {class: 'ph-adjust-row'}, h('label', {for: id}, LABELS[key]), outputs[key], inputs[key]);
		});

		function draw() {
			frame = 0;

			const before = showOriginal || holding;

			putPixels(preview, before ? original : applyAdjust(original, settings, buffer));
			badge.hidden = !before;
			preview.dataset.showing = before ? 'original' : 'adjusted';
			preview.dataset.version = String(Number(preview.dataset.version || 0) + 1);
		}

		// One redraw per animation frame, however many slider events come.
		function schedule() {
			if (!frame && !closed) {
				frame = requestAnimationFrame(draw);
			}
		}

		function changed() {
			saveButton.disabled = isNeutral(settings);
			sheet.dataset.neutral = String(isNeutral(settings));
			schedule();
		}

		autoButton.addEventListener('click', () => {
			if (settings.auto) {
				settings.auto = null;
			}
			else {
				auto = auto || autoLevels(original);
				settings.auto = auto;

				if (!auto) {
					setStatus('This photo is one flat colour, so Auto has nothing to fix.');
				}
			}

			autoButton.setAttribute('aria-pressed', settings.auto ? 'true' : 'false');
			changed();
		});

		originalButton.addEventListener('click', () => {
			showOriginal = !showOriginal;
			originalButton.setAttribute('aria-pressed', showOriginal ? 'true' : 'false');
			schedule();
		});

		// Holding a finger or the mouse on the photo shows the original.
		const hold = (on) => () => {
			holding = on;
			schedule();
		};

		preview.addEventListener('pointerdown', hold(true));

		for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
			preview.addEventListener(type, hold(false));
		}

		reset.addEventListener('click', () => {
			Object.assign(settings, neutralSettings());

			for (const key of SLIDERS) {
				inputs[key].value = '0';
				outputs[key].textContent = '0';
			}

			autoButton.setAttribute('aria-pressed', 'false');
			setStatus('');
			changed();
		});

		cancel.addEventListener('click', close);

		saveButton.addEventListener('click', async () => {
			if (closed || isNeutral(settings)) {
				return;
			}

			saveButton.disabled = true;
			saveButton.textContent = 'Saving…';
			setStatus('');

			try {
				const out = canvasOf(original.width, original.height);

				putPixels(out, applyAdjust(original, settings));
				await save({canvas: out, settings: {...settings}});
				close();
			}
			catch (err) {
				saveButton.disabled = false;
				saveButton.textContent = 'Save';
				setStatus(`Could not save the photo: ${(err && err.message) || err}`, 'error');
			}
		});

		setStatus('');
		body.replaceChildren(
			h('div', {class: 'ph-adjust-stage'}, preview, badge),
			h('div', {class: 'ph-adjust-tools'}, autoButton, originalButton, reset),
			...rows,
			status,
			h('div', {class: 'ph-adjust-actions'}, saveButton, cancel),
		);
		sheet.dataset.neutral = 'true';
		draw();
		autoButton.focus({preventScroll: true});
	}

	handle = openSheet(sheet, {onClose: () => {
		closed = true;
	}});

	Promise.resolve().then(load).then((source) => {
		if (!closed) {
			edit(source);
		}
	}, (err) => {
		if (!closed) {
			setStatus((err && err.message) || String(err), 'error');
			body.append(h('div', {class: 'ph-adjust-actions'}, h('button', {class: 'ph-cancel', onclick: close, type: 'button'}, 'Close')));
		}
	});

	return {close, element: sheet};
}
