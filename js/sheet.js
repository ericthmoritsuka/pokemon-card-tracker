// Sheets and full-screen viewers (plans/design-review.md section 5, items 3
// and 9): what every sheet laid over a screen shares, written once.
//
//   openSheet(element, options)   shows a sheet; returns {close, element}
//   openDialogSheet(dialog)       the same for a native <dialog>
//   closeSheets()                 closes every open sheet, for a route change
//
// An open sheet
//   - locks the page's scroll (the first sheet saves body overflow, the last
//     one to close puts it back);
//   - closes with Escape, and keeps Tab and Shift+Tab inside itself;
//   - gives focus back to what opened it when it closes;
//   - closes with the system Back button or gesture instead of leaving the
//     screen. Opening one adds a history entry at the same address; Back
//     takes that entry away, and the sheet closes without the screen under
//     it being drawn again. Closing it any other way (its own button,
//     Escape, Save) takes the entry away too, so the next Back leaves the
//     screen as it should, rather than doing nothing;
//   - closes when the screen under it goes: a route change by code (go() in
//     js/dom.js), or closeSheets() from the router, or its owner's cleanup
//     calling close(). Those leave the history alone, since the address has
//     already moved on.
//
// The Back handling is a popstate listener on window in the capture phase,
// which runs before the router's own popstate listener (app.js) and the
// binder spread's (js/binder-spread.js), and stops them from seeing the
// popstate that only closed a sheet.

const FOCUSABLE = [
	'a[href]',
	'button:not([disabled])',
	'input:not([disabled]):not([type="hidden"])',
	'select:not([disabled])',
	'textarea:not([disabled])',
	'[tabindex]:not([tabindex="-1"])',
].join(', ');

// The open sheets, the last one on top.
const stack = [];

let seq = 0;
let lockCount = 0;
let savedOverflow = '';

// This module's own history.go() calls, scheduled or on their way, whose
// popstates are not the person's Back; and what waits for them.
let ownPops = 0;
let ownTimer = 0;
let waiting = [];

function settle() {
	ownPops = 0;
	clearTimeout(ownTimer);

	const done = waiting;

	waiting = [];
	done.forEach((resolve) => resolve());
}

function ownPopDone() {
	ownPops = Math.max(0, ownPops - 1);

	if (!ownPops) {
		settle();
	}
}

// Resolves once the history entries of sheets closed so far are gone.
function settled() {
	return ownPops ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve();
}

// Takes the newest `count` entries away, `token` being the top one's. It
// waits for the rest of the current event first: a link tapped in a sheet
// closes the sheet and then pushes its route in the same click, and going
// back after that push would undo the route instead. When the address has
// moved on like that, the entries stay behind the new screen.
function goBack(count, token) {
	ownPops++;
	setTimeout(() => {
		if (!(history.state && history.state.sheet === token)) {
			ownPopDone();

			return;
		}

		clearTimeout(ownTimer);
		// A traversal that never reports back (none should) does not leave
		// the next real Back swallowed.
		ownTimer = setTimeout(settle, 1500);
		history.go(-count);
	}, 0);
}

const visible = (el) => el.getClientRects().length > 0 && !el.closest('[hidden]');

function lockScroll() {
	if (lockCount++ === 0) {
		savedOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
	}
}

function unlockScroll() {
	if (lockCount > 0 && --lockCount === 0) {
		document.body.style.overflow = savedOverflow;
	}
}

function onKey(event) {
	const top = stack[stack.length - 1];

	if (!top) {
		return;
	}

	if (event.key === 'Escape' && top.escape) {
		event.preventDefault();

		if (!(top.onEscape && top.onEscape())) {
			top.close('escape');
		}
	}
	else if (event.key === 'Tab' && top.trap) {
		const stops = (top.focusables ? top.focusables() : [...top.element.querySelectorAll(FOCUSABLE)]).filter(visible);

		if (!stops.length) {
			event.preventDefault();

			return;
		}

		const i = stops.indexOf(document.activeElement);
		const next = i < 0
			? (event.shiftKey ? stops[stops.length - 1] : stops[0])
			: stops[(i + (event.shiftKey ? stops.length - 1 : 1)) % stops.length];

		event.preventDefault();
		next.focus();
	}
}

// Takes `entry` (and every sheet above it) off the screen. reason goes to
// each one's onClose.
function finish(entry, reason) {
	const at = stack.indexOf(entry);

	if (at < 0) {
		return;
	}

	stack.splice(at, 1);
	entry.closed = true;

	if (!stack.length) {
		document.removeEventListener('keydown', onKey, true);
	}

	if (entry.lockScroll) {
		unlockScroll();
	}

	if (entry.remove) {
		entry.element.remove();
	}

	const back = entry.opener;

	if (entry.returnFocus && back && back.isConnected && typeof back.focus === 'function') {
		back.focus({preventScroll: true});
	}

	if (entry.onClose) {
		entry.onClose(reason);
	}
}

window.addEventListener('popstate', (event) => {
	if (ownPops > 0 && event.isTrusted) {
		// The entry of a sheet that closed by its own button, going away.
		event.stopImmediatePropagation();
		ownPopDone();

		return;
	}

	if (!stack.length) {
		return;
	}

	// A popstate from code (js/dom.js go()) is a route change.
	if (!event.isTrusted) {
		closeSheets('route');

		return;
	}

	// Back (or Forward) by the person. The sheets whose entries are still
	// in the history up to here stay open; those above close.
	const token = event.state && event.state.sheet;
	const keep = stack.findIndex((entry) => entry.token === token);
	const leaving = stack.slice(keep + 1).reverse();
	const sameScreen = window.location.href === stack[0].href;

	for (const entry of leaving) {
		finish(entry, sameScreen ? 'back' : 'route');
	}

	// Only sheets closed: the screen under them is still the right one.
	if (sameScreen) {
		event.stopImmediatePropagation();
	}
}, true);

// Shows `element` as a sheet. Options:
//   onClose(reason)  after it closes: 'close' (close() from code, the
//                    sheet's own buttons), 'escape', 'back', or 'route'
//   onEscape()       Escape pressed: return true when that was handled
//                    some other way (the viewer leaving Compare)
//   mount            where to append the element (document.body); null
//                    when the caller has placed it already
//   remove           take the element out of the page on close (true)
//   lockScroll       lock the page's scroll while open (true)
//   escape           Escape closes it (true)
//   trap             Tab stays inside (true)
//   focusables()     the Tab stops, in order, in place of every focusable
//                    element inside
//   returnFocus      focus goes back to the opener on close (true)
//   opener           what gets focus back (the focused element)
// Returns {close(reason), element}; close() resolves once the sheet's
// history entry is gone.
export function openSheet(element, {
	escape = true,
	focusables = null,
	lockScroll: lock = true,
	mount = document.body,
	onClose = null,
	onEscape = null,
	opener = document.activeElement,
	remove = true,
	returnFocus = true,
	trap = true,
} = {}) {
	const entry = {
		closed: false,
		element,
		escape,
		focusables,
		href: window.location.href,
		lockScroll: lock,
		onClose,
		onEscape,
		opener,
		pushed: false,
		remove,
		returnFocus,
		token: `${Date.now().toString(36)}-${++seq}`,
		trap,
	};

	entry.close = (reason = 'close') => {
		if (entry.closed) {
			return settled();
		}

		// This sheet and any opened over it.
		const closing = stack.slice(stack.indexOf(entry)).reverse();
		const top = stack[stack.length - 1];
		const onTop = Boolean(history.state && top && history.state.sheet === top.token);
		const entries = closing.filter((item) => item.pushed).length;

		for (const item of closing) {
			finish(item, item === entry ? reason : 'close');
		}

		// The sheets' entries are the newest ones in the history: take them
		// away. When the address has moved on (a route change), they are
		// left behind it.
		if (onTop && entries) {
			goBack(entries, top.token);
		}

		return settled();
	};

	const push = () => {
		if (!entry.closed) {
			// The screen's scroll position stays with its own entry, for
			// app.js to restore when Back returns to it from another route.
			history.replaceState({...(history.state || {}), scrollY: window.scrollY}, '');
			history.pushState({...(history.state || {}), sheet: entry.token}, '');
			entry.pushed = true;
		}
	};

	if (!stack.length) {
		document.addEventListener('keydown', onKey, true);
	}

	stack.push(entry);

	if (lock) {
		lockScroll();
	}

	if (mount) {
		mount.append(element);
	}

	// A sheet closed just before still has its entry going away: this one's
	// goes on after it.
	if (ownPops) {
		settled().then(push);
	}
	else {
		push();
	}

	return {close: entry.close, element};
}

// A native <dialog> as a sheet: shows it with showModal() (which keeps
// focus inside, closes it with Escape, and gives focus back by itself) and
// adds the Back handling. Closing the dialog any way closes the sheet, and
// Back closes the dialog. Returns the openSheet() handle.
export function openDialogSheet(dialog, {onClose = null} = {}) {
	let handle = null;

	const onDialogClose = () => {
		dialog.removeEventListener('close', onDialogClose);

		if (handle) {
			handle.close();
		}
	};

	handle = openSheet(dialog, {
		escape: false,
		lockScroll: false,
		mount: null,
		onClose(reason) {
			dialog.removeEventListener('close', onDialogClose);

			if (dialog.open) {
				dialog.close();
			}

			if (onClose) {
				onClose(reason);
			}
		},
		remove: false,
		returnFocus: false,
		trap: false,
	});
	dialog.addEventListener('close', onDialogClose);

	if (!dialog.open) {
		dialog.showModal();
	}

	return handle;
}

// Closes every open sheet without touching the history: the screen under
// them is going (app.js calls this as it draws a new route).
export function closeSheets(reason = 'route') {
	for (const entry of [...stack].reverse()) {
		finish(entry, reason);
	}
}

// How many sheets are open, for tests and for a screen that needs to know.
export const openSheetCount = () => stack.length;
