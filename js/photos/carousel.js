// The image carousel on card detail (DESIGN.md section 5, "Image carousel
// per card"): every image of the card, swiped sideways, with dots under it
// when there is more than one, a source label on each, "Use as main image",
// and a tap for full screen.
//
// Swipes on the carousel belong to it. DESIGN.md section 3 has the page
// swipe between cards everywhere except the image, so every pointer and
// touch event inside the carousel stops at the carousel, and the carousel
// carries data-swipe-own, which js/card-swipe.js skips. Arrow keys it uses
// are defaultPrevented, which card-swipe.js also respects. A page handler
// can ask too: isCarouselGesture(event) is true for anything that starts
// inside one, and after a sideways swipe moves the carousel it dispatches a
// bubbling "photo-carousel-swipe" event ({direction, index} in detail) and
// calls onSwipeConsumed, so the page knows that gesture was used.

import {h} from '../dom.js';

const OWNER = 'photo-carousel';
const SWIPE_EVENT = 'photo-carousel-swipe';

// A move this far sideways (CSS pixels), and more sideways than down, is a
// swipe; this far down first is the page scrolling.
const SLOP = 8;

const consumed = new WeakSet();

// True when the event started inside a carousel (or a full-screen viewer).
export function isCarouselGesture(eventOrTarget) {
	const target = eventOrTarget && 'target' in eventOrTarget ? eventOrTarget.target : eventOrTarget;

	return Boolean(target && target.closest && target.closest(`[data-swipe-owner="${OWNER}"]`));
}

// True for an event the carousel handled, for a listener that still sees it
// (one on the carousel's own element).
export const gestureConsumed = (event) => consumed.has(event);

export {SWIPE_EVENT};

function plainArt(src) {
	const frame = h('div', {class: 'art'});

	if (src) {
		frame.append(h('img', {alt: '', decoding: 'async', src}));
	}
	else {
		frame.append(h('div', {class: 'card-back'}, h('span', {class: 'card-back-status'}, 'No image')));
	}

	return frame;
}

const STOPPED = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'touchstart', 'touchmove', 'touchend', 'touchcancel', 'mousedown', 'mouseup', 'wheel'];

function contain(element) {
	for (const type of STOPPED) {
		element.addEventListener(type, (event) => {
			consumed.add(event);
			event.stopPropagation();
		}, {passive: true});
	}
}

// Sideways drag handling shared by the carousel and the full-screen viewer.
// onDrag(dx) while dragging, onEnd(dx, velocity) after, onTap(event) for a
// tap. `blocked()` true skips swiping (the viewer while zoomed).
function swipeable(element, {blocked = () => false, onDrag, onEnd, onTap}) {
	let start = null;

	element.addEventListener('pointerdown', (event) => {
		if (!event.isPrimary || event.button > 0) {
			return;
		}

		start = {id: event.pointerId, mode: 'pending', t: event.timeStamp, x: event.clientX, y: event.clientY};
	});

	element.addEventListener('pointermove', (event) => {
		if (!start || event.pointerId !== start.id) {
			return;
		}

		const dx = event.clientX - start.x;
		const dy = event.clientY - start.y;

		if (start.mode === 'pending') {
			if (Math.abs(dx) > SLOP && Math.abs(dx) > Math.abs(dy) * 1.2 && !blocked()) {
				start.mode = 'drag';

				try {
					element.setPointerCapture(event.pointerId);
				}
				catch {
					// The pointer already went away.
				}
			}
			else if (Math.abs(dy) > SLOP) {
				start.mode = 'scroll';
			}
		}

		if (start.mode === 'drag') {
			onDrag(dx);
		}
	});

	const finish = (event, cancelled) => {
		if (!start || event.pointerId !== start.id) {
			return;
		}

		const dx = event.clientX - start.x;
		const elapsed = Math.max(1, event.timeStamp - start.t);

		if (start.mode === 'drag') {
			onEnd(cancelled ? 0 : dx, cancelled ? 0 : dx / elapsed);
		}
		else if (!cancelled && start.mode === 'pending' && elapsed < 600 && onTap) {
			onTap(event);
		}

		start = null;
	};

	element.addEventListener('pointerup', (event) => finish(event, false));
	element.addEventListener('pointercancel', (event) => finish(event, true));
}

// Which slide a released drag lands on: the next one past a fifth of the
// width or a quick flick, else back where it was.
export function settleIndex(index, count, dx, velocity, width) {
	const far = Math.abs(dx) > width * 0.2 || Math.abs(velocity) > 0.45;

	if (!far || dx === 0) {
		return index;
	}

	return Math.min(count - 1, Math.max(0, index + (dx < 0 ? 1 : -1)));
}

// ------------------------------------------------------------- carousel

// photoCarousel(options) returns {element, update, show, current, destroy}.
//
//   slides          model.js gallerySlides() output
//   mainId          the slide id tiles show (model.js mainSlideId)
//   art(src, opts)  draws one image in the card shape (catalog-views.js
//                   cardArt bound to the card's names); a plain image
//                   otherwise
//   resolveSrc      slide -> Promise<url or null>, for photos (store.js
//                   photoUrl)
//   pending         Set of photo ids still waiting to upload
//   readOnly        no "Use as main image" (a family member's card)
//   onUseAsMain(slide), onRemove(slide), onSwipeConsumed(direction, index)
export function photoCarousel({
	art = plainArt,
	mainId = null,
	onRemove = null,
	onSwipeConsumed = null,
	onUseAsMain = null,
	pending = new Set(),
	readOnly = false,
	resolveSrc = () => Promise.resolve(null),
	slides = [],
} = {}) {
	let index = 0;
	let state = {mainId, pending, slides};
	const drawn = new Map();

	const track = h('div', {class: 'ph-track'});
	const viewport = h('div', {
		'aria-label': 'Card images. Swipe or use the arrow keys; Enter opens full screen.',
		class: 'ph-viewport',
		tabindex: '0',
	}, track);
	const dots = h('div', {class: 'ph-dots'});
	const useMain = h('button', {class: 'ph-use-main', type: 'button'}, 'Use as main image');
	const live = h('p', {'aria-live': 'polite', class: 'ph-live'});
	const element = h('div', {
		'aria-roledescription': 'carousel',
		class: 'ph-carousel',
		'data-swipe-own': true,
		'data-swipe-owner': OWNER,
		role: 'region',
	}, viewport, dots, useMain, live);

	element.setAttribute('aria-label', 'Card images');
	contain(element);

	const width = () => viewport.clientWidth || 1;

	function place(dx = 0, animate = true) {
		track.classList.toggle('ph-animate', animate);
		track.style.transform = `translateX(calc(${-index * 100}% + ${dx}px))`;
	}

	function slideElement(slide, i, count) {
		const key = `${slide.id}|${slide.src || ''}`;
		const existing = drawn.get(slide.id);
		let node;

		// A photo that could not be fetched (offline) is tried again on the
		// next update.
		if (existing && existing.key === key && existing.node.dataset.src !== 'missing') {
			node = existing.node;
		}
		else {
			const holder = h('div', {class: 'ph-art'});
			const label = h('span', {class: 'ph-source'}, slide.label);
			const waiting = h('span', {class: 'ph-pending', hidden: true}, 'Waiting to upload');

			node = h('div', {class: 'ph-slide', 'data-slide': slide.id, role: 'group'}, holder, label, waiting);
			node.setAttribute('aria-roledescription', 'slide');

			if (slide.src) {
				holder.append(art(slide.src, {eager: i === 0}));
			}
			else {
				holder.append(h('div', {class: 'art loading'}));
				resolveSrc(slide).then((url) => {
					holder.replaceChildren(art(url, {eager: true}));
					node.dataset.src = url ? 'ready' : 'missing';
				});
			}

			drawn.set(slide.id, {key, node});
		}

		const waiting = slide.kind === 'photo' && state.pending.has(slide.id);
		const main = slide.id === state.mainId;
		node.querySelector('.ph-source').textContent = slide.label;
		node.querySelector('.ph-pending').hidden = !waiting;
		node.classList.toggle('ph-waiting', waiting);
		node.setAttribute('aria-label', `${i + 1} of ${count}: ${slide.label}${waiting ? ', waiting to upload' : ''}${main ? ', main image' : ''}`);

		return node;
	}

	function drawControls() {
		const {slides: list} = state;
		const slide = list[index];

		dots.hidden = list.length < 2;
		dots.replaceChildren(...(list.length < 2 ? [] : list.map((item, i) => {
			const dot = h('button', {
				'aria-current': i === index ? 'true' : null,
				'aria-label': `Image ${i + 1} of ${list.length}: ${item.label}`,
				class: 'ph-dot',
				type: 'button',
			});

			dot.addEventListener('click', () => show(i));

			return dot;
		})));

		const isMain = slide && slide.id === state.mainId;

		useMain.hidden = readOnly || !onUseAsMain || list.length < 2 || !slide;
		useMain.disabled = Boolean(isMain);
		useMain.textContent = isMain ? 'Main image' : 'Use as main image';
		useMain.setAttribute('aria-pressed', isMain ? 'true' : 'false');
	}

	function render() {
		const {slides: list} = state;
		const ids = new Set(list.map((slide) => slide.id));

		for (const id of [...drawn.keys()]) {
			if (!ids.has(id)) {
				drawn.delete(id);
			}
		}

		if (!list.length) {
			track.replaceChildren(h('div', {class: 'ph-slide'}, h('div', {class: 'ph-art'}, art(null, {eager: true}))));
		}
		else {
			track.replaceChildren(...list.map((slide, i) => slideElement(slide, i, list.length)));
		}

		index = Math.min(index, Math.max(0, list.length - 1));
		element.dataset.count = String(list.length);
		place(0, false);
		drawControls();
	}

	function show(target, {announce = true} = {}) {
		const {slides: list} = state;
		const i = typeof target === 'number' ? target : list.findIndex((slide) => slide.id === target);

		if (i < 0 || i >= list.length) {
			return;
		}

		index = i;
		place(0, true);
		drawControls();
		element.dataset.index = String(index);

		if (announce && list[index]) {
			live.textContent = `Image ${index + 1} of ${list.length}: ${list[index].label}`;
		}
	}

	swipeable(viewport, {
		onDrag(dx) {
			const atEdge = (dx > 0 && index === 0) || (dx < 0 && index === state.slides.length - 1);

			place(atEdge ? dx * 0.35 : dx, false);
		},
		onEnd(dx, velocity) {
			const next = settleIndex(index, state.slides.length, dx, velocity, width());
			const direction = dx < 0 ? 'next' : 'previous';

			element.dataset.swiped = String(Number(element.dataset.swiped || 0) + 1);
			show(next);
			element.dispatchEvent(new CustomEvent(SWIPE_EVENT, {bubbles: true, detail: {direction, index: next}}));

			if (onSwipeConsumed) {
				onSwipeConsumed(direction, next);
			}
		},
		onTap() {
			openFull();
		},
	});

	viewport.addEventListener('keydown', (event) => {
		if (event.key === 'ArrowRight') {
			show(index + 1);
			event.preventDefault();
		}
		else if (event.key === 'ArrowLeft') {
			show(index - 1);
			event.preventDefault();
		}
		else if (event.key === 'Enter' || event.key === ' ') {
			openFull();
			event.preventDefault();
		}
	});

	useMain.addEventListener('click', () => {
		const slide = state.slides[index];

		if (slide && onUseAsMain) {
			onUseAsMain(slide);
		}
	});

	let viewer = null;

	function openFull() {
		if (!state.slides.length) {
			return;
		}

		viewer = openViewer({
			art,
			index,
			onClose: (at) => {
				viewer = null;
				show(at, {announce: false});
				viewport.focus({preventScroll: true});
			},
			onRemove: readOnly ? null : onRemove,
			resolveSrc,
			slides: state.slides,
		});
	}

	render();

	return {
		current: () => state.slides[index] || null,
		destroy() {
			if (viewer) {
				viewer.close();
			}
		},
		element,
		show,
		update(next) {
			state = {...state, ...next};
			render();
		},
	};
}

// ------------------------------------------------------------- full screen

// The full-screen viewer: one image at a time over a dark backdrop, swiped
// like the carousel, double-tap to zoom (then drag to look around), Escape
// or the close button to leave.
export function openViewer({art = plainArt, index = 0, onClose = null, onRemove = null, resolveSrc, slides}) {
	let at = index;
	let zoom = null;
	const opener = document.activeElement;

	const picture = h('div', {class: 'ph-full-art'});
	const label = h('p', {class: 'ph-full-label'});
	const close = h('button', {'aria-label': 'Close', class: 'ph-full-close', type: 'button'}, '×');
	const remove = h('button', {class: 'ph-full-remove', type: 'button'}, 'Remove photo');
	const stage = h('div', {class: 'ph-full-stage'}, picture);
	const dialog = h('div', {
		'aria-label': 'Card image, full screen',
		'aria-modal': 'true',
		class: 'ph-full',
		'data-swipe-own': true,
		'data-swipe-owner': OWNER,
		role: 'dialog',
	}, close, stage, h('div', {class: 'ph-full-bar'}, label, remove));

	contain(dialog);

	// Keys stay in the viewer, so the arrows never move the card page behind
	// it (js/card-swipe.js listens on the document).
	dialog.addEventListener('keydown', (event) => event.stopPropagation());

	async function draw() {
		const slide = slides[at];

		zoom = null;
		picture.style.transform = '';
		label.textContent = `${at + 1} of ${slides.length} · ${slide.label}`;
		remove.hidden = !onRemove || slide.kind !== 'photo';

		const src = slide.src || await resolveSrc(slide);

		if (slides[at] !== slide) {
			return;
		}

		picture.replaceChildren(src
			? h('img', {alt: slide.label, class: 'ph-full-img', decoding: 'async', src})
			: art(null, {eager: true}));
	}

	function move(step) {
		const next = Math.min(slides.length - 1, Math.max(0, at + step));

		if (next !== at) {
			at = next;
			draw();
		}
	}

	swipeable(stage, {
		blocked: () => Boolean(zoom),
		onDrag(dx) {
			picture.style.transform = `translateX(${dx}px)`;
		},
		onEnd(dx, velocity) {
			picture.style.transform = '';

			const next = settleIndex(at, slides.length, dx, velocity, stage.clientWidth || 1);

			if (next !== at) {
				at = next;
				draw();
			}
		},
	});

	// Double tap (or double click) zooms 2.5 times about the tapped point;
	// dragging while zoomed pans.
	let lastTap = 0;
	let pan = null;

	stage.addEventListener('pointerup', (event) => {
		if (event.timeStamp - lastTap < 300) {
			const box = picture.getBoundingClientRect();

			if (zoom) {
				zoom = null;
				picture.style.transform = '';
			}
			else {
				zoom = {x: 0, y: 0};
				picture.style.transformOrigin = `${event.clientX - box.left}px ${event.clientY - box.top}px`;
				picture.style.transform = 'scale(2.5)';
			}

			lastTap = 0;
		}
		else {
			lastTap = event.timeStamp;
		}

		pan = null;
	});
	stage.addEventListener('pointerdown', (event) => {
		if (zoom) {
			pan = {x: event.clientX - zoom.x, y: event.clientY - zoom.y};
		}
	});
	stage.addEventListener('pointermove', (event) => {
		if (zoom && pan) {
			zoom = {x: event.clientX - pan.x, y: event.clientY - pan.y};
			picture.style.transform = `translate(${zoom.x}px, ${zoom.y}px) scale(2.5)`;
		}
	});

	function onKey(event) {
		if (event.key === 'Escape') {
			event.preventDefault();
			done();
		}
		else if (event.key === 'ArrowRight') {
			event.preventDefault();
			move(1);
		}
		else if (event.key === 'ArrowLeft') {
			event.preventDefault();
			move(-1);
		}
		else if (event.key === 'Tab') {
			// Focus stays inside the dialog.
			const stops = [close, remove].filter((button) => !button.hidden);
			const i = stops.indexOf(document.activeElement);

			event.preventDefault();
			stops[(i + (event.shiftKey ? stops.length - 1 : 1)) % stops.length].focus();
		}
	}

	const overflow = document.body.style.overflow;

	function done() {
		document.removeEventListener('keydown', onKey, true);
		document.body.style.overflow = overflow;
		dialog.remove();

		if (opener && opener.focus && !onClose) {
			opener.focus({preventScroll: true});
		}

		if (onClose) {
			onClose(at);
		}
	}

	close.addEventListener('click', done);
	remove.addEventListener('click', async () => {
		const slide = slides[at];

		// The browser's own confirm: one tap more, nothing lost by accident.
		if (onRemove && slide.kind === 'photo' && window.confirm('Remove this photo? It is deleted from this phone and from your account.')) {
			done();
			await onRemove(slide);
		}
	});

	document.addEventListener('keydown', onKey, true);
	document.body.style.overflow = 'hidden';
	document.body.append(dialog);
	draw();
	close.focus({preventScroll: true});

	return {close: done, element: dialog};
}
