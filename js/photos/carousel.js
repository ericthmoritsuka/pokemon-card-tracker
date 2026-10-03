// The image carousel on card detail (DESIGN.md section 5, "Image carousel
// per card"): every image of the card, swiped sideways, with dots under it
// when there is more than one, a source label on each, "Use as main image",
// and a tap for the full-screen inspection viewer (viewer.js).
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

import {openViewer} from './viewer.js';

// The full-screen inspection viewer the carousel opens (viewer.js).
export {openViewer};

export const OWNER = 'photo-carousel';
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

export function plainArt(src) {
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

// Stops every pointer, touch, and wheel event at `element` and marks it as
// the carousel's (gestureConsumed). The viewer uses it too.
export function contain(element) {
	for (const type of STOPPED) {
		element.addEventListener(type, (event) => {
			consumed.add(event);
			event.stopPropagation();
		}, {passive: true});
	}
}

// The carousel's sideways drag handling. onDrag(dx) while dragging,
// onEnd(dx, velocity) after, onTap(event) for a tap. `blocked()` true skips
// swiping.
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
//   resolveDetail   the same for a photo's detail copy, which the viewer
//                   shows when zoomed in (store.js detailUrl)
//   pending         Set of photo ids still waiting to upload
//   problems        Map photo id -> why its upload did not go (the server
//                   refused it, or the person must sign in again), shown
//                   on the photo in place of the waiting badge
//   waitingText     what the waiting badge says ("Waiting to upload", or
//                   while signed out that it uploads after a sign-in)
//   readOnly        no "Use as main image" (a family member's card)
//   onUseAsMain(slide), onRemove(slide), onSwipeConsumed(direction, index)
export function photoCarousel({
	art = plainArt,
	mainId = null,
	onRemove = null,
	onSwipeConsumed = null,
	onUseAsMain = null,
	pending = new Set(),
	problems = new Map(),
	readOnly = false,
	resolveDetail = () => Promise.resolve(null),
	resolveSrc = () => Promise.resolve(null),
	slides = [],
	waitingText = 'Waiting to upload',
} = {}) {
	let index = 0;
	let state = {mainId, pending, problems, slides, waitingText};
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
		const problem = waiting ? (state.problems && state.problems.get(slide.id)) || null : null;
		const badgeText = problem || state.waitingText || 'Waiting to upload';
		const badge = node.querySelector('.ph-pending');
		const main = slide.id === state.mainId;
		node.querySelector('.ph-source').textContent = slide.label;
		badge.hidden = !waiting;
		badge.textContent = badgeText;
		badge.classList.toggle('ph-problem', Boolean(problem));
		node.classList.toggle('ph-waiting', waiting);
		node.setAttribute('aria-label', `${i + 1} of ${count}: ${slide.label}${waiting ? `, ${badgeText.charAt(0).toLowerCase()}${badgeText.slice(1)}` : ''}${main ? ', main image' : ''}`);

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
		if (destroyed) {
			return;
		}

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
	let destroyed = false;

	function openFull() {
		if (!state.slides.length || destroyed) {
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
			resolveDetail,
			resolveSrc,
			slides: state.slides,
		});
	}

	render();

	return {
		current: () => state.slides[index] || null,
		// Closes the viewer (the screen is going); after it, a late save or
		// photo download changes nothing.
		destroy() {
			destroyed = true;

			if (viewer) {
				viewer.close();
				viewer = null;
			}
		},
		element,
		show,
		update(next) {
			if (destroyed) {
				return;
			}

			state = {...state, ...next};
			render();
		},
	};
}
