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
//
// A pocket holding several cards (a binder from a list, where every copy
// that fits stacks in one pocket) shows them one after another: a sideways
// swipe at zoom 1, the arrow keys, or the two arrow buttons move between
// them, and "Show this one here" puts the one in view on top and slides it
// back into the pocket (Eric, 2026-11-18: "once I click on the photo, I
// would be able to see the others in a carrousel ... instead of having to
// click edit pocket").

import {BASE, h} from './dom.js';
import {openSheet} from './sheet.js';
import {OWNER, contain} from './photos/carousel.js';
import {zoomPane} from './photos/viewer.js';
import {slideDetail, slideSrc} from './photos/index.js';

const OPEN_MS = 420;
const CLOSE_MS = 320;
const FADE_MS = 160;
const KEY_ZOOM = 1.6;

// A swipe this far (CSS px), or this fast (px per ms), moves to the next
// card in a pocket of several.
const SWIPE_STEP = 64;
const SWIPE_SPEED = 0.45;

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
//   stack            for a pocket of several cards, {cards: [{art, slide,
//                    subtitle, title}], onPick(i)}: cards[0] is the one on
//                    top, whose art, slide, subtitle, and title these
//                    replace; onPick puts card i on top (null when the
//                    pocket cannot change, read only)
export function openPocketViewer({actions = [], art: topArt, origin = () => null, outward = 1, slide: topSlide, stack = null, subtitle: topSubtitle = '', title: topTitle}) {
	let handle = null;
	let pulled = 0;
	let gone = false;

	const cards = stack && stack.cards && stack.cards.length > 1 ? stack.cards : [{art: topArt, slide: topSlide, subtitle: topSubtitle, title: topTitle}];
	const several = cards.length > 1;
	let at = 0;
	const {slide, subtitle, title} = cards[0];

	const first = origin();
	const closeButton = h('button', {'aria-label': 'Put the card back', class: 'pv-close', id: 'pv-close', type: 'button'}, '×');
	const pane = zoomPane({
		art: (src, options) => cards[at].art(src, options),
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
		swipe: several ? {
			allowed: () => !gone,
			drag(dx) {
				// Past the first or the last card it gives, as at an edge.
				const edge = (dx > 0 && at === 0) || (dx < 0 && at === cards.length - 1);

				lift.style.transform = `translate3d(${edge ? dx * 0.3 : dx}px, 0, 0)`;
			},
			end(dx, speed) {
				const step = dx < -SWIPE_STEP || speed < -SWIPE_SPEED ? 1 : dx > SWIPE_STEP || speed > SWIPE_SPEED ? -1 : 0;
				const from = lift.style.transform;

				lift.style.transform = '';

				if (step && go(at + step)) {
					return;
				}

				if (canAnimate(lift) && from) {
					lift.animate([{transform: from}, {transform: 'none'}], {duration: 180, easing: 'ease-out'});
				}
			},
		} : null,
	});
	const lift = h('div', {class: 'pv-lift', id: 'pv-lift'}, pane.element);
	const pickButton = several && stack.onPick ? h('button', {class: 'primary', id: 'pv-pick', type: 'button'}, 'Show this one here') : null;
	const buttons = [pickButton, ...actions.map((action) => (action.route
		? h('a', {class: 'button', 'data-link': action.route, href: BASE + action.route, id: action.id}, action.label)
		: h('button', {class: action.primary ? 'primary' : action.danger ? 'danger' : '', id: action.id, type: 'button'}, action.label)))].filter(Boolean);
	const actionButtons = pickButton ? buttons.slice(1) : buttons;
	const name = h('h3', {class: 'pv-name', id: 'pv-name'}, title);
	const meta = h('p', {class: 'pv-meta', id: 'pv-meta'}, subtitle);
	const prev = several ? h('button', {'aria-label': 'Previous card in this pocket', class: 'pv-step', id: 'pv-prev', type: 'button'}, '‹') : null;
	const next = several ? h('button', {'aria-label': 'Next card in this pocket', class: 'pv-step', id: 'pv-next', type: 'button'}, '›') : null;
	const count = several ? h('span', {'aria-live': 'polite', class: 'pv-count', id: 'pv-count'}) : null;
	const steps = several ? h('div', {class: 'pv-steps'}, prev, count, next) : null;
	const foot = h('div', {class: 'pv-foot'}, steps, name, subtitle || several ? meta : null, h('div', {class: 'pv-actions', id: 'pv-actions'}, buttons));
	const shade = h('div', {'aria-hidden': 'true', class: 'pv-shade'});
	const stage = h('div', {class: 'pv-stage'}, lift, foot);
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
	stage,
	h('p', {class: 'pv-help', id: 'pv-help'}, several
		? 'Swipe sideways for the other cards in this pocket. Pinch or double-tap the card to zoom. Swipe down or tap outside it to put it back.'
		: 'Pinch or double-tap the card to zoom. Swipe down or tap outside it to put it back.'),
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
		else if (several && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
			event.preventDefault();
			go(at + (event.key === 'ArrowRight' ? 1 : -1));
		}
	});

	// Shows card i of the pocket's stack. Returns whether it moved.
	function go(i) {
		if (!several || gone || i < 0 || i >= cards.length || i === at) {
			return false;
		}

		at = i;
		pane.reset();
		drawCard();

		return true;
	}

	function drawCard() {
		const card = cards[at];

		name.textContent = card.title;
		meta.textContent = card.subtitle || '';
		dialog.dataset.card = String(at);

		if (several) {
			count.textContent = `${at + 1} of ${cards.length} in this pocket`;
			prev.disabled = at === 0;
			next.disabled = at === cards.length - 1;
		}

		if (pickButton) {
			// The card on top already shows here.
			pickButton.disabled = at === 0;
			pickButton.textContent = at === 0 ? 'Shown here' : 'Show this one here';
		}

		pane.show({...card.slide, label: `${card.title}: ${card.slide.label}`});
	}

	if (several) {
		prev.addEventListener('click', () => go(at - 1));
		next.addEventListener('click', () => go(at + 1));
	}

	if (pickButton) {
		pickButton.addEventListener('click', () => {
			const picked = at;

			// Back into the pocket, which draws the picked card on top once
			// the pick is saved.
			done('pick');
			stack.onPick(picked);
		});
	}

	shade.addEventListener('click', () => done('outside'));
	closeButton.addEventListener('click', () => done('close'));

	actions.forEach((action, i) => {
		actionButtons[i].addEventListener('click', () => {
			if (action.route) {
				// The router changes the screen, which closes the viewer.
				return;
			}

			done('action');
			action.run();
		});
	});

	// The card's width caps at what the screen leaves above the name and
	// the actions, which wrap to more rows with more of them (a pocket of
	// several cards adds the arrows and Show this one here), so the card
	// never starts above the screen and the last action never ends below it.
	function fit() {
		const style = getComputedStyle(stage);
		const room = stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - parseFloat(style.rowGap || style.gap || 0) - foot.offsetHeight;

		lift.style.maxWidth = room > 0 ? `${Math.max(120, Math.floor(room * 63 / 88))}px` : '';
	}

	window.addEventListener('resize', fit);

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

		window.removeEventListener('resize', fit);

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

	drawCard();
	fit();
	(actionButtons[0] || buttons[0] || closeButton).focus({preventScroll: true});
	requestAnimationFrame(open);

	return {close: () => done('close'), element: dialog};
}
