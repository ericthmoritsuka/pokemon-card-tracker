// Swiping between cards in the list a card page was opened from (DESIGN.md
// section 3, "Swipe between cards in the list you came from").
//
// A grid offers its cards, in the order and with the filters on screen, with
// offerCardList(). When a card in it is tapped, app.js calls
// followCardLink(), and that list becomes the card page's context: a
// position line ("12 of 1,359") between a previous and a next arrow beside
// Back, a horizontal swipe anywhere on the page except inside
// [data-swipe-own] (the image carousel will carry it), and the arrow keys.
// The arrows sit in the top row so they never cover the page: floating at
// the bottom corners they hid the copies list and Ver na Liga on a phone.
// A move replaces the history entry, so Back returns to the list, where
// app.js restores the scroll position. The context is kept for this tab in
// sessionStorage, so a reload on a card page keeps it.

import {go, h} from './dom.js';
import {formatCount} from './format.js';

const KEY = 'card-tracker-card-list';
const SWIPE_MIN = 60;
const EDGE = 16;

let offered = null;
let active = readSaved();

function readSaved() {
	try {
		const saved = JSON.parse(sessionStorage.getItem(KEY) || 'null');

		return saved && Array.isArray(saved.routes) ? saved : null;
	}
	catch {
		return null;
	}
}

function save() {
	try {
		if (active) {
			sessionStorage.setItem(KEY, JSON.stringify(active));
		}
		else {
			sessionStorage.removeItem(KEY);
		}
	}
	catch {
		// The context lasts until a reload.
	}
}

// A grid's card routes ("cards/<lang>/<id>", as their data-link carries
// them), in screen order. label names the list on the position line.
export function offerCardList(routes, label) {
	offered = {label: label || null, path: window.location.pathname, routes: [...routes]};
}

// A link to a card was followed from the screen at window.location: the
// offered list becomes the context when it holds that card, and any other
// card link clears it.
export function followCardLink(route) {
	if (!/^cards\/[^/]+\/[^/]+$/.test(route)) {
		return;
	}

	if (offered && offered.path === window.location.pathname && offered.routes.includes(route)) {
		active = {label: offered.label, routes: offered.routes};
	}
	else {
		active = null;
	}

	save();
}

// {index, total, prev, next, label} for a card route in the context, or null.
export function cardPosition(route) {
	if (!active) {
		return null;
	}

	const index = active.routes.indexOf(route);

	if (index < 0) {
		return null;
	}

	return {
		index,
		label: active.label,
		next: active.routes[index + 1] || null,
		prev: index > 0 ? active.routes[index - 1] : null,
		total: active.routes.length,
	};
}

const reducedMotion = () => Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

function move(route, direction) {
	if (!route) {
		return;
	}

	// The next page slides in from the side it comes from; with reduced
	// motion it simply appears.
	const view = document.getElementById('view');

	if (view && !reducedMotion()) {
		view.dataset.swipe = direction;
		setTimeout(() => {
			delete view.dataset.swipe;
		}, 250);
	}

	go(route, {replace: true});
}

// The position line, the arrows, and the gestures for one card page.
// Returns {element, line, stop}: line holds the arrows and the position
// text, for the row beside Back, and is null when the card has no context;
// element is always null now that nothing floats over the page.
export function cardSwipe(root, route) {
	const position = cardPosition(route);

	if (!position) {
		return {element: null, line: null, stop: () => {}};
	}

	const prev = h('button', {
		'aria-label': 'Previous card',
		class: 'card-nav-arrow',
		disabled: !position.prev,
		id: 'card-prev',
		onclick: () => move(position.prev, 'back'),
		type: 'button',
	}, '‹');
	const next = h('button', {
		'aria-label': 'Next card',
		class: 'card-nav-arrow',
		disabled: !position.next,
		id: 'card-next',
		onclick: () => move(position.next, 'forward'),
		type: 'button',
	}, '›');
	const text = h('p', {
		'aria-label': `Card ${formatCount(position.index + 1)} of ${formatCount(position.total)}${position.label ? ` in ${position.label}` : ''}`,
		class: 'card-position',
		id: 'card-position',
	}, `${formatCount(position.index + 1)} of ${formatCount(position.total)}`);
	// A swipe anywhere is the one-handed way; the arrows are for a tap.
	const line = h('nav', {'aria-label': 'Cards in this list', class: 'card-steps', id: 'card-nav'}, prev, text, next);

	let start = null;

	const onStart = (event) => {
		const touch = event.changedTouches[0];
		const owned = event.target.closest && event.target.closest('[data-swipe-own], input, textarea, select, dialog');

		// The screen edges belong to the system back gesture.
		start = owned || touch.clientX < EDGE || touch.clientX > window.innerWidth - EDGE
			? null
			: {x: touch.clientX, y: touch.clientY};
	};

	const onEnd = (event) => {
		if (!start) {
			return;
		}

		const touch = event.changedTouches[0];
		const dx = touch.clientX - start.x;
		const dy = touch.clientY - start.y;

		start = null;

		if (Math.abs(dx) >= SWIPE_MIN && Math.abs(dx) > Math.abs(dy) * 1.5) {
			if (dx < 0) {
				move(position.next, 'forward');
			}
			else {
				move(position.prev, 'back');
			}
		}
	};

	const onKey = (event) => {
		if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.target.closest('input, textarea, select, dialog')) {
			return;
		}

		if (event.key === 'ArrowRight' && position.next) {
			event.preventDefault();
			move(position.next, 'forward');
		}
		else if (event.key === 'ArrowLeft' && position.prev) {
			event.preventDefault();
			move(position.prev, 'back');
		}
	};

	root.addEventListener('touchstart', onStart, {passive: true});
	root.addEventListener('touchend', onEnd, {passive: true});
	document.addEventListener('keydown', onKey);

	return {
		element: null,
		line,
		stop: () => {
			root.removeEventListener('touchstart', onStart);
			root.removeEventListener('touchend', onEnd);
			document.removeEventListener('keydown', onKey);
		},
	};
}
