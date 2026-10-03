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

// The Lists tab's two halves, Checklists and Wishlist, as one segmented
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
		item('wishlist', 'Wishlist', member ? `wishlist/${member}` : 'wishlist')
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

// The All, Owned, and Missing segments with their counts ("All 207",
// "Owned 9", "Missing 198"): each segment's text is its label, then its
// number from counts ({all, owned, missing}). The label is kept in
// data-label, so a redraw never stacks a second number.
export function segmentCounts(control, counts) {
	for (const span of control.querySelectorAll('span[data-label]')) {
		const n = counts && counts[span.closest('label').querySelector('input').value];

		span.textContent = typeof n === 'number' ? `${span.dataset.label} ${n.toLocaleString('en-US')}` : span.dataset.label;
	}
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
