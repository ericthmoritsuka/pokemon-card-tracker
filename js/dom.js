// Shared DOM and error helpers.

// '/pokemon-card-tracker/' on GitHub Pages and when served locally from the
// repo's parent folder. This file sits one folder below the app root.
export const BASE = new URL('../', import.meta.url).pathname;

// Opens an app route from code, the way a data-link click does: app.js
// renders on popstate.
export function go(route, {replace = false} = {}) {
	const target = BASE + route;

	if (replace) {
		history.replaceState(history.state, '', target);
	}
	else if (target !== window.location.pathname) {
		history.pushState({inApp: true}, '', target);
	}

	window.dispatchEvent(new PopStateEvent('popstate'));
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
