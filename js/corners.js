// The corner editor: a picture with four draggable corner handles and the
// outline between them, written once for the card photo editor
// (js/photos/editor.js) and the binder cover (js/binder-cover.js), E-33.
//
// A corner moves by the finger's movement, not to the finger, so the finger
// never has to cover the corner it is placing; the arrow keys move the
// focused corner by 1 pixel on screen, or 10 with Shift. Corners are in the
// source picture's pixels and stay inside it.
//
// Each caller keeps what is its own: what it detects first, its preview
// (onChange runs once a frame after any move), and its buttons. The class
// names stay the callers' own (handleClass, draggingClass), so each sheet
// keeps its look.
//
//   const editor = cornerEditor({source, corners, onChange});
//   body.append(editor.stage);
//   editor.layout();               // once the stage is in the page
//   editor.corners                 // the corners now, [{x, y}] x 4
//   editor.setCorners(points)      // Rotate, Reset corners
//   editor.handles[0].focus()

import {h} from './dom.js';
import {clampPoint} from './photos/geometry.js';

export const CORNER_NAMES = ['Top-left', 'Top-right', 'Bottom-right', 'Bottom-left'];

const SVG = 'http://www.w3.org/2000/svg';

// options:
//   source         the picture (a canvas or an image bitmap), full size
//   corners        the starting corners, in source pixels
//   onChange       runs on the next animation frame after the corners move
//   stageClass     the stage's classes ('ph-stage' and any more)
//   stageId        the stage's id, or null
//   handleClass    each handle's class
//   draggingClass  the class a handle carries while dragged
//   minHeight      the stage's smallest height cap, in CSS pixels
//   heightShare    the share of the window's height the stage may take
//   smoothing      the canvas imageSmoothingQuality for the shown picture,
//                  or null for the browser's default
//   loupe          true for a magnifier above the finger while dragging
//   marks          true to write each handle's corner, in source pixels, on
//                  data-x and data-y (tests read them)
//   onDragEnd      runs when a drag ends
export function cornerEditor({
	corners: start,
	draggingClass = 'ph-dragging',
	handleClass = 'ph-handle',
	heightShare = 0.48,
	loupe: withLoupe = false,
	marks = false,
	minHeight = 240,
	onChange = () => {},
	onDragEnd = () => {},
	smoothing = null,
	source,
	stageClass = 'ph-stage',
	stageId = null,
}) {
	let corners = start.map((p) => ({...p}));
	let scale = 1;
	let frame = 0;

	const photo = h('canvas', {'aria-hidden': 'true', class: 'ph-photo'});
	const outline = document.createElementNS(SVG, 'svg');
	const shape = document.createElementNS(SVG, 'polygon');
	const loupe = withLoupe ? h('canvas', {'aria-hidden': 'true', class: 'ph-loupe', height: 112, hidden: true, width: 112}) : null;
	const handles = CORNER_NAMES.map((name, i) => h('button', {
		'aria-label': `${name} corner. Drag, or use the arrow keys.`,
		class: handleClass,
		'data-corner': String(i),
		type: 'button',
	}));
	const stage = h('div', {class: stageClass, id: stageId}, photo, outline, ...handles, loupe);

	outline.setAttribute('class', 'ph-outline');
	outline.setAttribute('aria-hidden', 'true');
	outline.append(shape);

	// The picture is drawn at the size it shows; handles sit on it in CSS
	// pixels, and their positions convert to source pixels by `scale`.
	function layout() {
		const room = Math.min(stage.parentElement.clientWidth || 328, 560);
		const maxHeight = Math.max(minHeight, Math.round(window.innerHeight * heightShare));
		const fit = Math.min(room / source.width, maxHeight / source.height);
		const width = Math.round(source.width * fit);
		const height = Math.round(source.height * fit);
		const dpr = Math.min(2, window.devicePixelRatio || 1);

		scale = fit;
		photo.width = Math.round(width * dpr);
		photo.height = Math.round(height * dpr);
		photo.style.width = `${width}px`;
		photo.style.height = `${height}px`;
		stage.style.width = `${width}px`;
		stage.style.height = `${height}px`;
		outline.setAttribute('viewBox', `0 0 ${width} ${height}`);
		outline.setAttribute('width', String(width));
		outline.setAttribute('height', String(height));

		const ctx = photo.getContext('2d');

		if (smoothing) {
			ctx.imageSmoothingQuality = smoothing;
		}

		ctx.drawImage(source, 0, 0, photo.width, photo.height);
		overlay();
	}

	function overlay() {
		shape.setAttribute('points', corners.map((p) => `${p.x * scale},${p.y * scale}`).join(' '));
		handles.forEach((handle, i) => {
			handle.style.transform = `translate(${corners[i].x * scale}px, ${corners[i].y * scale}px)`;

			if (marks) {
				handle.dataset.x = corners[i].x.toFixed(1);
				handle.dataset.y = corners[i].y.toFixed(1);
			}
		});
	}

	function changed() {
		frame = 0;
		onChange(corners);
	}

	function schedule() {
		overlay();

		if (!frame) {
			frame = requestAnimationFrame(changed);
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
			handle.classList.add(draggingClass);

			if (loupe) {
				loupe.hidden = false;
				drawLoupe(i);
			}
		});
		handle.addEventListener('pointermove', (event) => {
			if (!drag || event.pointerId !== drag.id) {
				return;
			}

			corners[i] = clampPoint({
				x: drag.start.x + ((event.clientX - drag.x) / scale),
				y: drag.start.y + ((event.clientY - drag.y) / scale),
			}, source.width, source.height);

			if (loupe) {
				drawLoupe(i);
			}

			schedule();
		});

		const end = (event) => {
			if (drag && event.pointerId === drag.id) {
				drag = null;
				handle.classList.remove(draggingClass);

				if (loupe) {
					loupe.hidden = true;
				}

				onDragEnd();
				schedule();
			}
		};

		handle.addEventListener('pointerup', end);
		handle.addEventListener('pointercancel', end);
		handle.addEventListener('keydown', (event) => {
			const step = (event.shiftKey ? 10 : 1) / scale;
			const move = {ArrowDown: [0, step], ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step]}[event.key];

			if (move) {
				event.preventDefault();
				corners[i] = clampPoint({x: corners[i].x + move[0], y: corners[i].y + move[1]}, source.width, source.height);
				schedule();
			}
		});
	});

	return {
		get corners() {
			return corners;
		},
		handles,
		layout,
		setCorners(points) {
			corners = points.map((p) => ({...p}));
			schedule();
		},
		stage,
	};
}
