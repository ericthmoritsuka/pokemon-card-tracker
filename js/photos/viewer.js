// The inspection viewer (DESIGN.md section 5, "Inspection viewer"): a card's
// images full screen, to find details and to compare a copy with the
// official print when checking whether it is original.
//
//   - Pinch, double-tap, Ctrl and the wheel, or + and - zoom; drag pans,
//     with momentum, and stops at the image's edges. A double tap zoomed in
//     goes back to the whole card.
//   - At zoom 1, a sideways swipe (or the arrow keys) moves between the
//     card's images.
//   - Compare shows two images, stacked in portrait and side by side in
//     landscape: by default the official image and the person's photo,
//     either one switchable. Zoom and pan are linked in card coordinates
//     (js/photos/zoom.js), so zooming into a corner of one shows the same
//     corner of the other; Linked turns that off and on.
//   - A photo saved with a detail copy (store.js) shows it in place of the
//     normal copy once the zoom passes the normal copy's resolution; it is
//     downloaded then, not before.
//
// Everything moves by transform alone, from pointer events, on stages with
// touch-action: none, so the browser neither scrolls nor zooms the page
// under it. With reduced motion, zooms jump and a released pan stops where
// it is. Like the carousel, the viewer carries data-swipe-own and stops
// every pointer, touch, and key event, so the card page behind never swipes.
//
// carousel.js imports this module and this one imports carousel.js; neither
// reads the other's exports until a function runs, so the cycle is safe.

import {h} from '../dom.js';

import {OWNER, contain, plainArt, settleIndex} from './carousel.js';
import {comparePair} from './model.js';
import {
	cardFocus,
	clampView,
	doubleTapView,
	easeOut,
	fitSize,
	isDoubleTap,
	maxZoom,
	momentumAt,
	needsDetail,
	pinchView,
	restView,
	rubberView,
	settleView,
	velocityOf,
	viewForFocus,
	zoomAbout,
	zoomStep,
} from './zoom.js';

// The first time the viewer, and Compare, open on this phone, a line says
// how to use them.
export const HINT_KEY = 'card-tracker-viewer-hint';
export const COMPARE_HINT_KEY = 'card-tracker-compare-hint';

const HINT_MS = 5000;

// A card's shape until its image says otherwise.
const CARD_ASPECT = 63 / 88;

// A finger that moves less than this is still a tap; a sideways move this
// far, more sideways than down, at zoom 1 is a swipe.
const SLOP = 8;
const TAP_MS = 500;

const ZOOM_MS = 220;
const KEY_ZOOM = 1.6;

function readFlag(key) {
	try {
		return localStorage.getItem(key) === 'seen';
	}
	catch {
		return true;
	}
}

function writeFlag(key) {
	try {
		localStorage.setItem(key, 'seen');
	}
	catch {
		// Storage off: the hint shows again next time.
	}
}

const reducedMotion = () => Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

const now = () => performance.now();

const zoomText = (s) => `${s < 9.95 ? s.toFixed(1) : Math.round(s)}×`;

// ------------------------------------------------------------- one pane

// One zoomable image. The viewer owns two: one in single view, both in
// Compare.
//
//   onView(pane)     the view changed by the person (a gesture or a key):
//                    the viewer passes it to the other pane when linked
//   onActive(pane)   a gesture started here
//   onReady(pane)    the image is laid out
//   swipe            {allowed(), drag(dx), end(dx, velocity)}, the single
//                    view's sideways swipe at zoom 1
function zoomPane({art, onActive, onReady, onView, resolveDetail, resolveSrc, swipe}) {
	const inner = h('div', {class: 'ph-pane-art'});
	const element = h('div', {class: 'ph-pane', role: 'img'}, inner);

	let slide = null;
	let token = 0;
	let img = null;
	let natural = null;
	let detailState = null;
	let stage = {height: 1, width: 1};
	let base = {height: 1, width: CARD_ASPECT};
	let view = {s: 1, tx: 0, ty: 0};
	let limitOverride = null;
	let offset = 0;
	let frame = 0;
	let anim = 0;
	let movingTimer = 0;

	const best = () => (slide && slide.photo && slide.photo.detail ? slide.photo.detail : natural);
	const ownLimit = () => maxZoom(base, best());
	const limit = () => limitOverride || ownLimit();

	function measure() {
		stage = {height: element.clientHeight || 1, width: element.clientWidth || 1};

		const aspect = natural && natural.width > 0 && natural.height > 0 ? natural.width / natural.height : CARD_ASPECT;

		base = fitSize(stage, aspect);
		inner.style.width = `${base.width}px`;
		inner.style.height = `${base.height}px`;
	}

	function paint() {
		frame = 0;
		inner.style.transform = `translate3d(${view.tx + offset}px, ${view.ty}px, 0) scale(${view.s})`;

		const focus = cardFocus(view, stage, base);

		element.dataset.s = view.s.toFixed(3);
		element.dataset.u = focus.u.toFixed(4);
		element.dataset.v = focus.v.toFixed(4);
		element.dataset.tx = view.tx.toFixed(1);
		element.dataset.ty = view.ty.toFixed(1);
		element.classList.toggle('ph-zoomed', view.s > 1.01);
	}

	function render() {
		if (!frame) {
			frame = requestAnimationFrame(paint);
		}

		maybeDetail();
	}

	// While it moves, the layer is promoted; after, the browser may draw it
	// again at the new scale, so a zoomed image is sharp, not a stretched
	// bitmap.
	function moving() {
		inner.classList.add('ph-moving');
		clearTimeout(movingTimer);
		movingTimer = setTimeout(() => inner.classList.remove('ph-moving'), 160);
	}

	function set(next, {emit = true} = {}) {
		view = next;
		moving();
		render();

		if (emit && onView) {
			onView(api);
		}
	}

	function stop() {
		if (anim) {
			cancelAnimationFrame(anim);
			anim = 0;
		}
	}

	function animateTo(target, {emit = true} = {}) {
		stop();

		if (reducedMotion()) {
			set(target, {emit});

			return;
		}

		const from = view;
		const start = now();

		const step = () => {
			const k = easeOut(Math.min(1, (now() - start) / ZOOM_MS));

			set(k >= 1 ? target : zoomStep(from, target, k), {emit});
			anim = k < 1 ? requestAnimationFrame(step) : 0;
		};

		anim = requestAnimationFrame(step);
	}

	function fling(velocity) {
		stop();

		const b = clampView(view, stage, base, limit());

		// Released past an edge: back to it, no throw.
		if (b.tx !== view.tx || b.ty !== view.ty || reducedMotion()) {
			animateTo(b);

			return;
		}

		if (Math.hypot(velocity.x, velocity.y) < 0.05) {
			return;
		}

		const from = view;
		const start = now();

		const step = () => {
			const {done, view: next} = momentumAt(from, velocity, now() - start, stage, base);

			set(next);
			anim = done ? 0 : requestAnimationFrame(step);
		};

		anim = requestAnimationFrame(step);
	}

	// ------------------------------------------------------- detail copy

	function maybeDetail() {
		if (detailState || !slide || slide.kind !== 'photo' || !slide.photo || !slide.photo.detail || !natural || !img) {
			return;
		}

		if (!needsDetail(view.s, base.width, natural.width, window.devicePixelRatio || 1)) {
			return;
		}

		const mine = token;

		detailState = 'loading';
		element.dataset.detail = 'loading';

		Promise.resolve(resolveDetail(slide)).then(async (url) => {
			if (mine !== token) {
				return;
			}

			if (!url) {
				detailState = 'missing';
				element.dataset.detail = 'missing';

				return;
			}

			const next = h('img', {alt: '', class: 'ph-full-img', decoding: 'async', draggable: 'false', src: url});

			await next.decode().catch(() => {});

			if (mine !== token || !next.naturalWidth) {
				if (mine === token) {
					detailState = 'missing';
					element.dataset.detail = 'missing';
				}

				return;
			}

			img.replaceWith(next);
			img = next;
			natural = {height: next.naturalHeight, width: next.naturalWidth};
			detailState = 'shown';
			element.dataset.detail = 'shown';
			element.dataset.natural = `${natural.width}x${natural.height}`;

			// The same 5:7 shape, so the layout stays and only the sharpness
			// changes; were it a pixel off, the same card spot is kept.
			const before = base;
			const focus = cardFocus(view, stage, base);

			measure();

			if (Math.abs(base.width - before.width) > 0.5 || Math.abs(base.height - before.height) > 0.5) {
				view = viewForFocus(focus, stage, base, limit());
			}

			render();
		}).catch(() => {
			if (mine === token) {
				detailState = 'missing';
				element.dataset.detail = 'missing';
			}
		});
	}

	// ------------------------------------------------------- the image

	async function show(next) {
		token++;

		const mine = token;

		stop();
		slide = next;
		img = null;
		natural = null;
		detailState = null;
		offset = 0;
		delete element.dataset.detail;
		delete element.dataset.natural;
		element.dataset.slide = next ? next.id : '';
		element.dataset.ready = 'false';
		element.setAttribute('aria-label', next ? next.label : 'No image');
		inner.replaceChildren(h('div', {class: 'art loading'}));
		measure();
		view = restView(stage, base);
		paint();

		const src = next ? next.src || await Promise.resolve(resolveSrc(next)).catch(() => null) : null;

		if (mine !== token) {
			return;
		}

		if (src) {
			const image = h('img', {alt: '', class: 'ph-full-img', decoding: 'async', draggable: 'false', src});

			inner.replaceChildren(image);
			await image.decode().catch(() => {});

			if (mine !== token) {
				return;
			}

			img = image.naturalWidth ? image : null;
			natural = img ? {height: image.naturalHeight, width: image.naturalWidth} : null;
			element.dataset.natural = natural ? `${natural.width}x${natural.height}` : '';
		}
		else {
			inner.replaceChildren(art(null, {eager: true}));
		}

		measure();
		view = restView(stage, base);
		paint();
		element.dataset.ready = 'true';

		if (onReady) {
			onReady(api);
		}
	}

	// Called when the stage changes size (a turn of the phone, Compare on
	// or off): the same card spot stays in the middle at the same zoom.
	function resize() {
		const focus = cardFocus(view, stage, base);
		const wasRest = view.s <= 1.001;

		measure();
		view = wasRest ? restView(stage, base) : viewForFocus(focus, stage, base, limit());
		paint();
	}

	// ------------------------------------------------------- gestures

	const pointers = new Map();
	let gesture = null;
	let samples = [];
	let lastTap = null;

	const local = (event) => {
		const box = element.getBoundingClientRect();

		return {x: event.clientX - box.left, y: event.clientY - box.top};
	};

	function twoFingers() {
		const [a, b] = [...pointers.values()];

		return {distance: Math.hypot(a.x - b.x, a.y - b.y), mid: {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2}};
	}

	// Zoomed in, a finger pans at once; it is still a tap (for a double
	// tap) if it lifts quickly without having moved past SLOP.
	function startPan(point, t) {
		gesture = {kind: view.s > 1.01 ? 'pan' : 'pending', moved: 0, start: {...view}, t, x: point.x, y: point.y};
		samples = [{t, x: point.x, y: point.y}];
	}

	element.addEventListener('pointerdown', (event) => {
		if (event.pointerType === 'mouse' && event.button !== 0) {
			return;
		}

		stop();

		try {
			element.setPointerCapture(event.pointerId);
		}
		catch {
			// The pointer already went away.
		}

		const point = local(event);

		pointers.set(event.pointerId, point);

		if (onActive) {
			onActive(api);
		}

		if (pointers.size === 1) {
			startPan(point, event.timeStamp);
		}
		else if (pointers.size === 2) {
			const {distance, mid} = twoFingers();

			if (gesture && gesture.kind === 'swipe') {
				swipe.end(0, 0);
			}

			lastTap = null;
			gesture = {distance, kind: 'pinch', mid, start: {...view}};
		}
	});

	element.addEventListener('pointermove', (event) => {
		if (!pointers.has(event.pointerId) || !gesture) {
			return;
		}

		const point = local(event);

		pointers.set(event.pointerId, point);

		if (gesture.kind === 'pinch') {
			if (pointers.size < 2) {
				return;
			}

			const {distance, mid} = twoFingers();

			gesture.last = mid;
			set(rubberView(pinchView(gesture.start, gesture.mid, gesture.distance, mid, distance, limit()), stage, base));

			return;
		}

		const dx = point.x - gesture.x;
		const dy = point.y - gesture.y;

		gesture.moved = Math.max(gesture.moved || 0, Math.hypot(dx, dy));

		if (gesture.kind === 'pending' && Math.hypot(dx, dy) > SLOP) {
			gesture.kind = swipe && swipe.allowed() && Math.abs(dx) > Math.abs(dy) * 1.2 ? 'swipe' : 'pan';
		}

		if (gesture.kind === 'pan') {
			samples.push({t: event.timeStamp, x: point.x, y: point.y});

			if (samples.length > 12) {
				samples.shift();
			}

			set(rubberView({s: gesture.start.s, tx: gesture.start.tx + dx, ty: gesture.start.ty + dy}, stage, base));
		}
		else if (gesture.kind === 'swipe') {
			swipe.drag(dx);
		}
	});

	function release(event, cancelled) {
		if (!pointers.has(event.pointerId)) {
			return;
		}

		const point = local(event);

		pointers.delete(event.pointerId);

		if (!gesture) {
			return;
		}

		if (gesture.kind === 'pinch') {
			if (pointers.size === 1) {
				// One finger stays: it pans on from here.
				const [rest] = [...pointers.values()];

				gesture = {anchor: gesture.last || gesture.mid, kind: 'pan', start: {...view}, t: event.timeStamp, x: rest.x, y: rest.y};
				samples = [{t: event.timeStamp, x: rest.x, y: rest.y}];
			}
			else if (!pointers.size) {
				const at = gesture.last || gesture.mid;

				gesture = null;
				animateTo(settleView(view, stage, base, limit(), at.x, at.y));
			}

			return;
		}

		if (pointers.size) {
			return;
		}

		const {anchor, moved = 0} = gesture;
		const elapsed = event.timeStamp - gesture.t;
		const dx = point.x - gesture.x;
		const tapped = !cancelled && elapsed < TAP_MS && moved <= SLOP && !anchor;
		const kind = tapped && gesture.kind === 'pan' ? 'pending' : gesture.kind;

		gesture = null;

		if (kind === 'pending' && tapped && view.s > 1.01) {
			// A tap on a zoomed image that moved it a pixel or two: put it back
			// inside the bounds before the tap counts.
			const inside = clampView(view, stage, base, limit());

			if (inside.tx !== view.tx || inside.ty !== view.ty) {
				set(inside);
			}
		}

		if (kind === 'pan') {
			const velocity = cancelled ? {x: 0, y: 0} : velocityOf(samples, event.timeStamp);

			if (view.s < 1 || view.s > limit()) {
				const p = anchor || {x: stage.width / 2, y: stage.height / 2};

				animateTo(settleView(view, stage, base, limit(), p.x, p.y));
			}
			else {
				fling(velocity);
			}
		}
		else if (kind === 'swipe') {
			swipe.end(cancelled ? 0 : dx, cancelled ? 0 : dx / Math.max(1, elapsed));
		}
		else if (kind === 'pending' && tapped) {
			const tap = {t: event.timeStamp, x: point.x, y: point.y};

			if (isDoubleTap(lastTap, tap)) {
				lastTap = null;
				animateTo(doubleTapView(view, tap, stage, base, limit()));
			}
			else {
				lastTap = tap;
			}
		}
	}

	element.addEventListener('pointerup', (event) => release(event, false));
	element.addEventListener('pointercancel', (event) => release(event, true));

	// Ctrl (or Command) and the wheel, which is also a trackpad's pinch,
	// zooms about the pointer; the wheel alone pans a zoomed image.
	element.addEventListener('wheel', (event) => {
		const zoom = event.ctrlKey || event.metaKey;

		if (!zoom && view.s <= 1.01) {
			return;
		}

		event.preventDefault();
		stop();

		if (onActive) {
			onActive(api);
		}

		const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.height : 1;

		if (zoom) {
			const p = local(event);
			const s = Math.min(limit(), Math.max(1, view.s * Math.exp(-event.deltaY * unit * 0.01)));

			set(clampView(zoomAbout(view, s, p.x, p.y), stage, base, limit()));
		}
		else {
			set(clampView({s: view.s, tx: view.tx - event.deltaX * unit, ty: view.ty - event.deltaY * unit}, stage, base, limit()));
		}
	}, {passive: false});

	const api = {
		element,
		// The card spot at the middle, and the zoom.
		focus: () => cardFocus(view, stage, base),
		// Shows the same card spot as another pane, without telling it back.
		follow(focus) {
			stop();
			view = viewForFocus(focus, stage, base, limit());
			moving();
			render();
		},
		limit,
		ownLimit,
		ready: () => element.dataset.ready === 'true',
		reset({animate = true} = {}) {
			const target = restView(stage, base);

			if (animate) {
				animateTo(target);
			}
			else {
				stop();
				set(target);
			}
		},
		resize,
		scale: () => view.s,
		// The single view's swipe: the image follows the finger by dx;
		// settle() lets it slide back.
		setOffset(dx, {settle = false} = {}) {
			offset = dx;
			inner.classList.toggle('ph-settle', settle && !reducedMotion());
			paint();
		},
		setLimit(value) {
			limitOverride = value;
		},
		show,
		slide: () => slide,
		// Zooms by `factor` about the middle (the + and - keys).
		zoomBy(factor) {
			const s = Math.min(limit(), Math.max(1, view.s * factor));

			animateTo(clampView(zoomAbout(view, s, stage.width / 2, stage.height / 2), stage, base, limit()));
		},
	};

	inner.addEventListener('transitionend', () => inner.classList.remove('ph-settle'));

	return api;
}

// ------------------------------------------------------------- the viewer

// Opens the viewer on slides[index] (model.js gallerySlides output).
// resolveSrc(slide) and resolveDetail(slide) resolve with object URLs for a
// photo and its detail copy (store.js photoUrl, detailUrl), or null.
// onClose(index) runs after it closes, with the image it ended on;
// onRemove(slide), when given, offers Remove photo. compare: open in
// Compare. Returns {close, compare, element}.
export function openViewer({
	art = plainArt,
	compare: startInCompare = false,
	index = 0,
	onClose = null,
	onRemove = null,
	resolveDetail = () => Promise.resolve(null),
	resolveSrc = () => Promise.resolve(null),
	slides,
}) {
	let at = Math.min(slides.length - 1, Math.max(0, index));
	let comparing = false;
	let linked = true;
	let leader = null;
	let hintTimer = 0;
	let closed = false;
	const opener = document.activeElement;

	const close = h('button', {'aria-label': 'Close', class: 'ph-full-close', type: 'button'}, '×');
	const compareButton = h('button', {'aria-pressed': 'false', class: 'ph-full-compare', type: 'button'}, 'Compare');
	const linkButton = h('button', {
		'aria-label': 'Link zoom and pan of both images',
		'aria-pressed': 'true',
		class: 'ph-full-link',
		hidden: true,
		type: 'button',
	}, 'Linked');
	const zoomLabel = h('span', {'aria-hidden': 'true', class: 'ph-full-zoom'}, zoomText(1));
	const label = h('p', {class: 'ph-full-label'});
	const remove = h('button', {class: 'ph-full-remove', type: 'button'}, 'Remove photo');
	const hint = h('p', {class: 'ph-full-hint', hidden: true, role: 'status'});
	const live = h('p', {'aria-live': 'polite', class: 'ph-live'});

	const swipe = {
		allowed: () => !comparing && slides.length > 1,
		drag(dx) {
			const atEdge = (dx > 0 && at === 0) || (dx < 0 && at === slides.length - 1);

			panes[0].setOffset(atEdge ? dx * 0.35 : dx);
		},
		end(dx, velocity) {
			const next = settleIndex(at, slides.length, dx, velocity, panes[0].element.clientWidth || 1);

			if (next !== at) {
				go(next);
			}
			else {
				panes[0].setOffset(0, {settle: true});
			}
		},
	};

	function onView(pane) {
		leader = pane;

		if (comparing && linked) {
			const other = panes[0] === pane ? panes[1] : panes[0];

			if (other.ready()) {
				other.follow(pane.focus());
			}
		}

		zoomLabel.textContent = zoomText(pane.scale());
	}

	function onReady(pane) {
		updateLimits();

		// A side switched to another image takes up the other side's view.
		if (comparing && linked) {
			const other = panes[0] === pane ? panes[1] : panes[0];

			if (other.ready() && other.scale() > 1.001) {
				pane.follow(other.focus());
			}
		}
	}

	const panes = [0, 1].map(() => zoomPane({
		art,
		onActive(pane) {
			leader = pane;
			hideHint();
		},
		onReady,
		onView,
		resolveDetail,
		resolveSrc,
		swipe,
	}));

	// Each Compare side has a picker of the card's images.
	const pickers = panes.map((pane, i) => {
		const select = h('select', {'aria-label': i === 0 ? 'First image' : 'Second image', class: 'ph-side-pick'},
			slides.map((slide, n) => h('option', {value: String(n)}, `${n + 1}. ${slide.label}`)));

		select.addEventListener('change', () => pane.show(slides[Number(select.value)]));

		return select;
	});
	const sides = panes.map((pane, i) => h('div', {class: 'ph-full-side', 'data-side': String(i)}, pickers[i], pane.element));
	const area = h('div', {class: 'ph-full-panes'}, ...sides);

	const dialog = h('div', {
		'aria-label': 'Card image, full screen',
		'aria-modal': 'true',
		class: 'ph-full',
		'data-swipe-own': true,
		'data-swipe-owner': OWNER,
		role: 'dialog',
	},
	h('div', {class: 'ph-full-top'}, compareButton, linkButton, zoomLabel),
	close,
	area,
	hint,
	h('div', {class: 'ph-full-bar'}, label, remove),
	live);

	contain(dialog);

	// Older Safari zooms the page on a pinch even with touch-action: none.
	dialog.addEventListener('gesturestart', (event) => event.preventDefault());

	// Keys stay in the viewer, so the arrows never move the card page behind
	// it (js/card-swipe.js listens on the document).
	dialog.addEventListener('keydown', (event) => event.stopPropagation());

	function updateLimits() {
		// Linked, both sides zoom as far as the sharper one allows, so the
		// link never breaks at one side's limit.
		const shared = comparing && linked ? Math.max(panes[0].ownLimit(), panes[1].ownLimit()) : null;

		panes[0].setLimit(shared);
		panes[1].setLimit(shared);
	}

	function drawBar() {
		const slide = slides[at];

		label.textContent = comparing ? 'Compare' : `${at + 1} of ${slides.length} · ${slide.label}`;
		remove.hidden = comparing || !onRemove || slide.kind !== 'photo';
		compareButton.hidden = slides.length < 2;
		compareButton.textContent = comparing ? 'Single image' : 'Compare';
		compareButton.setAttribute('aria-pressed', comparing ? 'true' : 'false');
		linkButton.hidden = !comparing;
		linkButton.textContent = linked ? 'Linked' : 'Unlinked';
		linkButton.setAttribute('aria-pressed', linked ? 'true' : 'false');
		dialog.dataset.mode = comparing ? 'compare' : 'single';
		dialog.dataset.linked = String(linked);
		dialog.dataset.index = String(at);
	}

	function go(next) {
		at = next;
		zoomLabel.textContent = zoomText(1);
		drawBar();
		panes[0].show(slides[at]);
		live.textContent = `Image ${at + 1} of ${slides.length}: ${slides[at].label}`;
	}

	function showHint(key, text) {
		if (readFlag(key)) {
			return;
		}

		writeFlag(key);
		hint.textContent = text;
		hint.hidden = false;
		clearTimeout(hintTimer);
		hintTimer = setTimeout(hideHint, HINT_MS);
	}

	function hideHint() {
		clearTimeout(hintTimer);
		hint.hidden = true;
	}

	function enterCompare() {
		const pair = comparePair(slides, at);

		if (!pair) {
			return;
		}

		comparing = true;
		linked = true;
		area.classList.add('ph-compare');
		pickers.forEach((select, i) => {
			select.value = String(pair[i]);
		});
		drawBar();
		zoomLabel.textContent = zoomText(1);
		panes[0].show(slides[pair[0]]);
		panes[1].show(slides[pair[1]]);
		updateLimits();
		showHint(COMPARE_HINT_KEY, 'Zoom either image and the other shows the same spot. Unlink to move them separately.');
	}

	function leaveCompare() {
		comparing = false;
		area.classList.remove('ph-compare');
		hideHint();
		updateLimits();
		go(at);
	}

	compareButton.addEventListener('click', () => (comparing ? leaveCompare() : enterCompare()));
	linkButton.addEventListener('click', () => {
		linked = !linked;
		updateLimits();
		drawBar();

		// Linked again: the other side jumps to the one last moved.
		if (linked) {
			const from = leader || panes[0];
			const other = from === panes[0] ? panes[1] : panes[0];

			other.follow(from.focus());
		}

		live.textContent = linked ? 'Zoom linked' : 'Zoom not linked';
	});

	// The stages change size with the window (turning the phone) and with
	// Compare; each pane keeps its card spot.
	const observer = typeof ResizeObserver === 'function'
		? new ResizeObserver(() => panes.forEach((pane) => pane.resize()))
		: null;
	const onResize = () => panes.forEach((pane) => pane.resize());

	if (observer) {
		panes.forEach((pane) => observer.observe(pane.element));
	}
	else {
		window.addEventListener('resize', onResize);
	}

	function focusables() {
		return [compareButton, linkButton, close, ...(comparing ? pickers : []), remove].filter((el) => !el.hidden);
	}

	function onKey(event) {
		const inPicker = event.target && event.target.tagName === 'SELECT';
		const pane = comparing ? leader || panes[0] : panes[0];

		if (event.key === 'Escape') {
			event.preventDefault();

			if (comparing) {
				leaveCompare();
			}
			else {
				done();
			}
		}
		else if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && !inPicker) {
			event.preventDefault();

			if (!comparing) {
				const next = Math.min(slides.length - 1, Math.max(0, at + (event.key === 'ArrowRight' ? 1 : -1)));

				if (next !== at) {
					go(next);
				}
			}
		}
		else if (event.key === '+' || event.key === '=') {
			event.preventDefault();
			pane.zoomBy(KEY_ZOOM);
		}
		else if (event.key === '-' || event.key === '_') {
			event.preventDefault();
			pane.zoomBy(1 / KEY_ZOOM);
		}
		else if (event.key === '0') {
			event.preventDefault();
			pane.reset();
		}
		else if (event.key === 'Tab') {
			// Focus stays inside the dialog.
			const stops = focusables();
			const i = stops.indexOf(document.activeElement);

			event.preventDefault();
			stops[(i + (event.shiftKey ? stops.length - 1 : 1) + stops.length) % stops.length].focus();
		}
	}

	const overflow = document.body.style.overflow;

	function done() {
		if (closed) {
			return;
		}

		closed = true;
		clearTimeout(hintTimer);
		document.removeEventListener('keydown', onKey, true);

		if (observer) {
			observer.disconnect();
		}
		else {
			window.removeEventListener('resize', onResize);
		}

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
	drawBar();
	panes[0].show(slides[at]);
	close.focus({preventScroll: true});

	if (startInCompare) {
		enterCompare();
	}
	else {
		showHint(HINT_KEY, slides.length > 1
			? 'Pinch or double-tap to zoom, then drag to look around. Swipe for the next image.'
			: 'Pinch or double-tap to zoom, then drag to look around.');
	}

	return {close: done, compare: enterCompare, element: dialog};
}
