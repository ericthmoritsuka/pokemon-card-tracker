// Long press on a pocket, then drag it to another pocket (js/binders-view.js,
// hand-made binders). Pointer events, so a finger and a mouse work alike.
//
// A press that stays still for HOLD_MS lifts the pocket: a ghost of its card
// follows the pointer, and the pocket under it is outlined. Only then does
// the drag own the gesture (onLift, so the spread forgets the swipe); a press
// that moves first is left alone, so a swipe still turns the page. Lifting
// over another pocket calls onDrop(from, to) with the two .bs-pocket
// elements; lifting anywhere else does nothing.

export const HOLD_MS = 400;
const SLOP = 8;

// element: the spread's root. canLift(pocket): whether this .bs-pocket may be
// lifted now. Returns {destroy}.
export function pocketDrag(element, {canLift, onDrop, onLift = () => {}}) {
	let press = null;
	let clickBlock = 0;

	const pocketAt = (x, y) => {
		const hit = document.elementFromPoint(x, y);
		const pocket = hit && hit.closest && hit.closest('.bs-pocket');

		return pocket && element.contains(pocket) && !pocket.closest('[inert]') ? pocket : null;
	};

	const mark = (over) => {
		if (over === press.over) {
			return;
		}

		if (press.over) {
			press.over.classList.remove('bt-over');
		}

		if (over && over !== press.pocket) {
			over.classList.add('bt-over');
		}

		press.over = over;
	};

	const place = () => {
		press.ghost.style.transform = `translate(${press.x - press.half.x}px, ${press.y - press.half.y}px)`;
	};

	const end = () => {
		if (!press) {
			return;
		}

		clearTimeout(press.timer);

		if (press.ghost) {
			press.ghost.remove();
			press.pocket.classList.remove('pd-lifted');
		}

		if (press.over) {
			press.over.classList.remove('bt-over');
		}

		press = null;
	};

	const lift = () => {
		if (!press || !press.pocket.isConnected) {
			end();

			return;
		}

		const box = press.pocket.getBoundingClientRect();
		const art = press.pocket.querySelector('.pocket');

		press.ghost = document.createElement('div');
		press.ghost.className = 'bt-ghost pd-ghost';
		press.ghost.setAttribute('aria-hidden', 'true');
		press.ghost.style.width = `${box.width}px`;
		press.ghost.style.height = `${box.height}px`;

		if (art && art.firstElementChild) {
			press.ghost.append(art.firstElementChild.cloneNode(true));
		}

		press.half = {x: box.width / 2, y: box.height / 2};
		document.body.append(press.ghost);
		press.pocket.classList.add('pd-lifted');
		place();
		onLift();

		try {
			element.setPointerCapture(press.pointerId);
		}
		catch {
			// The pointer is gone; pointerup or pointercancel ends it.
		}

		if (navigator.vibrate) {
			try {
				navigator.vibrate(15);
			}
			catch {
				// No vibration here.
			}
		}
	};

	const onDown = (event) => {
		end();

		if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) {
			return;
		}

		const pocket = event.target.closest && event.target.closest('.bs-pocket');

		if (!pocket || !element.contains(pocket) || pocket.closest('[inert]') || !canLift(pocket)) {
			return;
		}

		press = {ghost: null, over: null, pocket, pointerId: event.pointerId, sx: event.clientX, sy: event.clientY, timer: 0, x: event.clientX, y: event.clientY};
		press.timer = setTimeout(lift, HOLD_MS);
	};

	const onMove = (event) => {
		if (!press || event.pointerId !== press.pointerId) {
			return;
		}

		press.x = event.clientX;
		press.y = event.clientY;

		if (!press.ghost) {
			if (Math.hypot(press.x - press.sx, press.y - press.sy) > SLOP) {
				end();
			}

			return;
		}

		event.preventDefault();
		place();
		mark(pocketAt(press.x, press.y));
	};

	const onUp = (event) => {
		if (!press || event.pointerId !== press.pointerId) {
			return;
		}

		const {ghost, pocket} = press;
		const target = ghost ? pocketAt(event.clientX, event.clientY) : null;

		end();

		if (ghost) {
			// The lift is not a tap on the pocket under it.
			clickBlock = Date.now() + 400;

			if (target && target !== pocket) {
				onDrop(pocket, target);
			}
		}
	};

	// A finger that has lifted a pocket does not scroll the page.
	const onTouchMove = (event) => {
		if (press && press.ghost && event.cancelable) {
			event.preventDefault();
		}
	};

	const onClick = (event) => {
		if (Date.now() < clickBlock) {
			event.preventDefault();
			event.stopPropagation();
		}
	};

	// No callout menu or image drag while a pocket is held.
	const onMenu = (event) => {
		if (press) {
			event.preventDefault();
		}
	};

	const onDragStart = (event) => {
		if (event.target.closest && event.target.closest('.bs-pocket')) {
			event.preventDefault();
		}
	};

	element.addEventListener('pointerdown', onDown);
	element.addEventListener('pointermove', onMove);
	element.addEventListener('pointerup', onUp);
	element.addEventListener('pointercancel', end);
	element.addEventListener('touchmove', onTouchMove, {passive: false});
	element.addEventListener('click', onClick, true);
	element.addEventListener('contextmenu', onMenu);
	element.addEventListener('dragstart', onDragStart);

	return {
		destroy() {
			end();
			element.removeEventListener('pointerdown', onDown);
			element.removeEventListener('pointermove', onMove);
			element.removeEventListener('pointerup', onUp);
			element.removeEventListener('pointercancel', end);
			element.removeEventListener('touchmove', onTouchMove);
			element.removeEventListener('click', onClick, true);
			element.removeEventListener('contextmenu', onMenu);
			element.removeEventListener('dragstart', onDragStart);
		},
	};
}
