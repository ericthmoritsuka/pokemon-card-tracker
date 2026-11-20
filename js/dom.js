// Shared DOM and error helpers.

// '/pokemon-card-tracker/' on GitHub Pages and when served locally from the
// repo's parent folder. This file sits one folder below the app root.
export const BASE = new URL('../', import.meta.url).pathname;

// Merges fields into the current history entry's state, so a screen can
// find them again when Back returns to it (its scroll position, how many
// tiles were shown).
export function rememberInHistory(fields) {
	history.replaceState({...(history.state || {}), ...fields}, '');
}

// A number this history entry remembered, or fallback.
export function fromHistory(key, fallback) {
	const value = history.state && history.state[key];

	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// Leaving a screen for a new one: its scroll position stays with its
// history entry, for Back (app.js restores it).
export function pushRoute(target) {
	rememberInHistory({scrollY: window.scrollY});

	// A link tapped in a sheet: the sheet's entry becomes the new screen's,
	// so one Back returns to the screen under the sheet.
	if (history.state && history.state.sheet) {
		history.replaceState({inApp: true}, '', target);
	}
	else {
		history.pushState({inApp: true}, '', target);
	}
}

// Opens an app route from code, the way a data-link click does: app.js
// renders on popstate. replace swaps the current entry, so Back skips it.
export function go(route, {replace = false} = {}) {
	const target = BASE + route;

	if (replace) {
		history.replaceState({inApp: Boolean(history.state && history.state.inApp)}, '', target);
	}
	else if (target !== window.location.pathname) {
		pushRoute(target);
	}

	window.dispatchEvent(new PopStateEvent('popstate', {state: history.state}));
}

// The Lists tab's three parts, Checklists, Wishlist, and Collections, as one segmented
// control of links. userId shows a family member's.
export function listsSwitch(active, userId = null) {
	const member = userId ? encodeURIComponent(userId) : null;
	const item = (id, label, route) => h('a', {
		'aria-current': id === active ? 'page' : null,
		class: id === active ? 'lists-switch-item on' : 'lists-switch-item',
		'data-link': route,
		href: BASE + route,
		id: `lists-switch-${id}`,
	}, label);

	return h('nav', {'aria-label': 'Lists', class: 'lists-switch'},
		item('checklists', 'Checklists', member ? `family/${member}/lists` : 'lists'),
		item('wishlist', 'Wishlist', member ? `wishlist/${member}` : 'wishlist'),
		item('collections', 'Collections', member ? `family/${member}/collections` : 'collections')
	);
}

export function h(tag, attrs, ...children) {
	const el = document.createElement(tag);

	for (const [key, value] of Object.entries(attrs || {})) {
		if (value === null || value === undefined || value === false) {
			continue;
		}

		if (key === 'class') {
			el.className = value;
		}
		else if (key.startsWith('on') && typeof value === 'function') {
			el.addEventListener(key.slice(2), value);
		}
		else {
			el.setAttribute(key, value === true ? '' : String(value));
		}
	}

	for (const child of children.flat()) {
		if (child === null || child === undefined || child === false) {
			continue;
		}

		el.append(child instanceof Node ? child : String(child));
	}

	return el;
}

// A back link's words after its ‹, which is drawn but not read: a screen
// reader said "single left-pointing angle quotation mark" (accessibility
// audit, 2026-11-20). The link's text is still "‹ All sets"; in a flex
// link that space is dropped, so the mark keeps its own (style.css).
export const backWords = (text) => [h('span', {'aria-hidden': 'true', class: 'back-mark'}, '‹'), ` ${text}`];

// The All, Owned, and Missing segments with their counts ("All 207",
// "Owned 9", "Missing 198"): each segment's text is its label, then its
// number from counts ({all, owned, missing}). The label is kept in
// data-label, so a redraw never stacks a second number. The number is its
// own element, a data element so the segment's span stays its only span:
// when any segment's label and number do not fit side by side (a 324 px
// phone, larger system text, a four-digit count), every segment
// puts its number under its label (segments-stacked, style.css), rather
// than one segment wrapping alone (v74). Checked again when the control's
// width changes, as on turning the phone.
export function segmentCounts(control, counts) {
	for (const span of control.querySelectorAll('span[data-label]')) {
		const n = counts && counts[span.closest('label').querySelector('input').value];

		if (typeof n === 'number') {
			span.replaceChildren(`${span.dataset.label} `, h('data', {class: 'segment-count', value: String(n)}, n.toLocaleString('en-US')));
		}
		else {
			span.textContent = span.dataset.label;
		}
	}

	fitSegments(control);

	if (!fitWatched.has(control) && typeof ResizeObserver === 'function') {
		let width = control.clientWidth;

		fitWatched.add(control);
		// Stacking changes the control's height, so it waits for the next
		// frame: changed inside the observer's own callback, Chrome reports a
		// "ResizeObserver loop" error, which the app shows as an error.
		new ResizeObserver(() => requestAnimationFrame(() => {
			if (control.clientWidth !== width) {
				width = control.clientWidth;
				fitSegments(control);
			}
		})).observe(control);
	}
}

const fitWatched = new WeakSet();

function fitSegments(control) {
	control.classList.remove('segments-stacked');

	const spans = [...control.querySelectorAll('span[data-label]')];

	// Not laid out yet (hidden, or not in the page): the observer checks
	// once it has a width.
	if (!control.clientWidth) {
		return;
	}

	// A segment too narrow for its words widens its column (1fr keeps the
	// words' width as its least), so the control overflows rather than the
	// segment.
	control.classList.toggle('segments-stacked', control.scrollWidth > control.clientWidth || spans.some((span) => span.scrollWidth > span.clientWidth));
}

export function namedError(name, message) {
	const err = new Error(message);

	err.name = name;

	return err;
}

export function errorText(err) {
	if (err === null || err === undefined) {
		return 'Unknown error (no details were given).';
	}

	if (typeof err !== 'object') {
		return String(err);
	}

	const name = err.name || 'Error';
	const message = err.message || String(err);

	return `${name}: ${message}`;
}

export function showError(context, err) {
	const box = document.getElementById('errors');

	box.append(
		h('div', {class: 'error', role: 'alert'},
			h('strong', null, context),
			' ',
			errorText(err)
		)
	);
}

window.addEventListener('error', (event) => {
	showError('Script error.', event.error || namedError('Error', event.message));
});

window.addEventListener('unhandledrejection', (event) => {
	showError('Unhandled error.', event.reason);
});
