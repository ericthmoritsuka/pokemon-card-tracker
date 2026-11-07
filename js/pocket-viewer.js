// A card out of its pocket (DESIGN.md section 11, Binders, "A card out of
// its pocket"; Eric, 2026-11-06: "as if I was taking it out of the slot and
// looking at it in real life"). Tapping a filled pocket lifts the card out
// of it, slides it toward the pocket's open side and up to the middle of
// the screen, large, over the dimmed binder. It zooms like the inspection
// viewer (js/photos/viewer.js zoomPane: pinch, double tap, Ctrl and the
// wheel, + and -), and under it a row of what the pocket offers (the
// caller's actions, such as Edit pocket, To the tray, Move, and Card page).
//
// A tap outside the card, a swipe down at zoom 1, Escape, Back, and Close
// put the card back: it shrinks to the pocket's side and slides in. With
// reduced motion it appears and goes without moving. An action closes the
// viewer at once and then runs, so its own sheet opens in its place.
//
// It is a js/sheet.js sheet: Back closes it instead of leaving the binder,
// Tab stays inside, focus goes to its first action and back to the pocket.

import {BASE, h} from './dom.js';
import {openSheet} from './sheet.js';
import {OWNER, contain} from './photos/carousel.js';
import {zoomPane} from './photos/viewer.js';
import {slideDetail, slideSrc} from './photos/index.js';

const OPEN_MS = 420;
const CLOSE_MS = 320;
const FADE_MS = 160;
const KEY_ZOOM = 1.6;

// A pull down this far (CSS px), or this fast (px per ms), puts it back.
const PULL_CLOSE = 96;
const PULL_SPEED = 0.6;

const reducedMotion = () => Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

const canAnimate = (element) => typeof element.animate === 'function' && !reducedMotion();

const finished = (animation) => (animation && animation.finished ? animation.finished.catch(() => {}) : Promise.resolve());

// Opens it. Returns {close(), element}.
//   art(src, opts)   draws the card shape for an image, or the card back
//                    with its name when there is none (js/tile.js cardArt)
//   slide            js/photos/index.js mainSlide: the person's main
//                    image, a photo or the official image in its large size
//   title            the card's name; subtitle, a line under it
//   origin()         the pocket's element now, for where the card comes
//                    from and goes back to (the spread may have drawn it
//                    again since); null when it is not on screen
//   outward          1 when the pocket opens to the right (a right-hand
//                    page), -1 to the left
//   actions          [{id, label, run}] or [{id, label, route}], in order
export function openPocketViewer({actions = [], art, origin = () => null, outward = 1, slide, subtitle = '', title}) {
	let handle = null;
	let pulled = 0;
	let gone = false;

	const first = origin();
	const closeButton = h('button', {'aria-label': 'Put the card back', class: 'pv-close', id: 'pv-close', type: 'button'}, '×');
	const pane = zoomPane({
		art,
		pull: {
			allowed: () => !gone,
			drag(dy) {
				pulled = dy;
				lift.style.transform = `translate3d(0, ${dy}px, 0)`;
				shade.style.opacity = String(Math.max(0.25, 1 - (dy / 420)));
			},
			end(dy, speed) {
				if (dy > PULL_CLOSE || speed > PULL_SPEED) {
					done('pull');

					return;
				}

				const from = lift.style.transform;

				pulled = 0;
				lift.style.transform = '';
				shade.style.opacity = '';

				if (canAnimate(lift) && from) {
					lift.animate([{transform: from}, {transform: 'none'}], {duration: 180, easing: 'ease-out'});
				}
			},
		},
		resolveDetail: slideDetail,
		resolveSrc: slideSrc,
	});
	const lift = h('div', {class: 'pv-lift', id: 'pv-lift'}, pane.element);
	const buttons = actions.map((action) => (action.route
		? h('a', {class: 'button', 'data-link': action.route, href: BASE + action.route, id: action.id}, action.label)
		: h('button', {class: action.primary ? 'primary' : '', id: action.id, type: 'button'}, action.label)));
	const name = h('h3', {class: 'pv-name', id: 'pv-name'}, title);
	const meta = h('p', {class: 'pv-meta', id: 'pv-meta'}, subtitle);
	const foot = h('div', {class: 'pv-foot'}, name, subtitle ? meta : null, h('div', {class: 'pv-actions', id: 'pv-actions'}, buttons));
	const shade = h('div', {'aria-hidden': 'true', class: 'pv-shade'});
	const dialog = h('div', {
		'aria-describedby': 'pv-help',
		'aria-labelledby': 'pv-name',
		'aria-modal': 'true',
		class: 'pv',
		'data-state': 'opening',
		'data-swipe-own': true,
		'data-swipe-owner': OWNER,
		id: 'pocket-viewer',
		role: 'dialog',
		// A tap on the card focuses the viewer itself (not the page under
		// it), so its keys stay here.
		tabindex: '-1',
	},
	shade,
	h('div', {class: 'pv-stage'}, lift, foot),
	h('p', {class: 'pv-help', id: 'pv-help'}, 'Pinch or double-tap the card to zoom. Swipe down or tap outside it to put it back.'),
	closeButton);

	// Pointer events stay in the viewer, as in the inspection viewer, so the
	// spread behind never turns a page or starts a drag.
	contain(dialog);
	dialog.addEventListener('gesturestart', (event) => event.preventDefault());

	// Keys stay here too (the spread turns pages on the arrows); Escape and
	// Tab are js/sheet.js's, which listens first.
	dialog.addEventListener('keydown', (event) => {
		event.stopPropagation();

		if (event.target && event.target.tagName === 'A') {
			return;
		}

		if (event.key === '+' || event.key === '=') {
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
	});

	shade.addEventListener('click', () => done('outside'));
	closeButton.addEventListener('click', () => done('close'));

	actions.forEach((action, i) => {
		buttons[i].addEventListener('click', () => {
			if (action.route) {
				// The router changes the screen, which closes the viewer.
				return;
			}

			done('action');
			action.run();
		});
	});

	const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => pane.resize()) : null;

	if (observer) {
		observer.observe(pane.element);
	}

	// The pocket's rect when it is on screen, else null.
	function pocketRect() {
		const element = origin();

		if (!element || !element.isConnected) {
			return null;
		}

		const rect = element.getBoundingClientRect();

		if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) {
			return null;
		}

		return rect;
	}

	// The transform that puts the lifted card over `rect`, from its place
	// in the middle (transform-origin is its top left corner).
	function over(rect, dx = 0) {
		const saved = lift.style.transform;

		lift.style.transform = '';

		const to = lift.getBoundingClientRect();

		lift.style.transform = saved;

		const scale = to.width ? rect.width / to.width : 1;

		return `translate3d(${rect.left - to.left + dx}px, ${rect.top - to.top}px, 0) scale(${scale})`;
	}

	function markPocket(out) {
		const element = origin();

		if (element) {
			element.classList.toggle('pv-out', out);
		}
	}

	function opened() {
		if (!gone) {
			dialog.dataset.state = 'open';
		}
	}

	function open() {
		const rect = pocketRect();

		markPocket(true);

		if (!rect || !canAnimate(lift)) {
			opened();

			return;
		}

		const at = over(rect);
		const aside = over(rect, outward * rect.width * 0.62);

		shade.animate([{opacity: 0}, {opacity: 1}], {duration: OPEN_MS * 0.6, easing: 'ease-out'});
		foot.animate([{opacity: 0}, {offset: 0.55, opacity: 0}, {opacity: 1}], {duration: OPEN_MS, easing: 'ease-out'});
		finished(lift.animate([
			{transform: at},
			{offset: 0.38, transform: aside},
			{transform: 'none'},
		], {duration: OPEN_MS, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)'})).then(opened);
	}

	// After js/sheet.js has closed it, however it closed: the card goes back
	// into its pocket, then the viewer leaves the page. A route change
	// (Card page) or an action does not wait for that.
	async function putBack(reason) {
		gone = true;
		dialog.dataset.state = 'closing';

		if (observer) {
			observer.disconnect();
		}

		const rect = reason === 'route' || reason === 'action' ? null : pocketRect();

		if (canAnimate(lift)) {
			if (rect) {
				const from = pulled ? `translate3d(0, ${pulled}px, 0)` : 'none';

				foot.animate([{opacity: 1}, {opacity: 0}], {duration: FADE_MS, fill: 'forwards'});
				shade.animate([{opacity: Number(getComputedStyle(shade).opacity) || 1}, {opacity: 0}], {duration: CLOSE_MS, fill: 'forwards'});
				await finished(lift.animate([
					{transform: from},
					{offset: 0.62, transform: over(rect, outward * rect.width * 0.62)},
					{transform: over(rect)},
				], {duration: CLOSE_MS, easing: 'cubic-bezier(0.4, 0, 0.6, 1)', fill: 'forwards'}));
			}
			else if (reason !== 'route') {
				await finished(dialog.animate([{opacity: 1}, {opacity: 0}], {duration: FADE_MS, fill: 'forwards'}));
			}
		}

		markPocket(false);
		dialog.remove();
	}

	function done(reason) {
		if (handle && !gone) {
			handle.close(reason);
		}
	}

	handle = openSheet(dialog, {
		focusables: () => [...buttons, closeButton],
		onClose: (reason) => {
			putBack(reason);
		},
		opener: first || document.activeElement,
		remove: false,
	});

	pane.show({...slide, label: `${title}: ${slide.label}`});
	(buttons[0] || closeButton).focus({preventScroll: true});
	requestAnimationFrame(open);

	return {close: () => done('close'), element: dialog};
}
