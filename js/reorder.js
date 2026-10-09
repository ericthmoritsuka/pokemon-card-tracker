// The order of checklists, goals, collections, and binders (DESIGN.md
// section 11, "Reordering Lists and Binders"), and the Edit order panel
// each of those screens shows.
//
// An entry may carry `order`, a number: a section shows the entries with one
// first, lowest first, then the ones without, in the section's old order
// (when they were made, or by name). A move writes `order` on the moved
// entry only, halfway between its new neighbours; only when a neighbour has
// no order yet, or the gap is too small to halve, is the whole section
// numbered again 1, 2, 3. So two phones moving different entries both keep
// their moves, and when both move the same one, the later move stands
// (js/merge.js decides the field by its stamp). A new entry takes one more
// than the highest order in its section, or none while the section has none,
// so it goes to the end and never jumps. An older app carries the field
// along unchanged and keeps its own order; an entry it makes has none, so it
// lands at the end here.
//
// The pure parts load in Node (tests/reorder.test.mjs), and so do
// js/checklists.js, js/goals.js, js/collections.js, and js/binders.js, which
// import them; so this module builds its few elements itself rather than
// importing js/dom.js, which needs a window. orderEditor and orderSection
// need a DOM.

import {nextStamp, stampEntry} from './merge.js';

// js/dom.js h(), the part this module uses: attributes (null, undefined,
// and false left out; on* as listeners) and children.
function h(tag, attrs, ...children) {
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
			el.setAttribute(key, value === true ? '' : value);
		}
	}

	el.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));

	return el;
}

const errorText = (err) => (err && err.message) || 'Something went wrong.';

export const hasOrder = (entry) => Boolean(entry) && typeof entry.order === 'number' && Number.isFinite(entry.order);

// The section in its order. fallback compares two entries without one (the
// section's old order); ties go by id, so every phone shows the same order.
export function sortByOrder(entries, fallback = () => 0) {
	return [...entries].sort((a, b) => {
		const ordered = hasOrder(a);

		if (ordered !== hasOrder(b)) {
			return ordered ? -1 : 1;
		}

		if (ordered && a.order !== b.order) {
			return a.order - b.order;
		}

		return fallback(a, b) || String(a.id).localeCompare(String(b.id));
	});
}

export const byCreated = (a, b) => String(a.created_at).localeCompare(String(b.created_at));

// The order a new entry takes in this section (its live entries): one more
// than the highest, or null while none has an order.
export function orderForNew(section) {
	const orders = (section || []).filter(hasOrder).map((entry) => entry.order);

	return orders.length ? Math.floor(Math.max(...orders)) + 1 : null;
}

// The order changes for moving one entry to index `to` of the section as
// shown (sorted): [{id, order, before}], before being the order it had (null
// for none), which Undo writes back. Empty when nothing moves.
export function orderMoves(sorted, id, to) {
	const from = sorted.findIndex((entry) => entry.id === id);

	if (from < 0 || !Number.isInteger(to)) {
		return [];
	}

	const target = Math.min(Math.max(to, 0), sorted.length - 1);

	if (target === from) {
		return [];
	}

	const next = [...sorted];
	const [moved] = next.splice(from, 1);

	next.splice(target, 0, moved);

	if (next.every(hasOrder)) {
		const prev = next[target - 1];
		const after = next[target + 1];
		let order;

		if (!prev) {
			order = after.order - 1;
		}
		else if (!after) {
			order = prev.order + 1;
		}
		else {
			order = (prev.order + after.order) / 2;
		}

		if (Number.isFinite(order) && (!prev || order > prev.order) && (!after || order < after.order)) {
			return [{before: moved.order, id: moved.id, order}];
		}
	}

	return next
		.map((entry, i) => ({before: hasOrder(entry) ? entry.order : null, id: entry.id, order: i + 1}))
		.filter((change) => change.before !== change.order);
}

// Undo of orderMoves's changes: each entry back to the order it had.
export const undoMoves = (changes) => changes.map(({before, id, order}) => ({before: order, id, order: before}));

// The entries of a list with the changes applied, each stamped as a new
// version (field by field, so another phone's edit to the name survives).
// Only live entries the changes name come back; order null takes the field
// away.
export function withOrders(list, changes, now = Date.now()) {
	const byId = new Map((list || []).filter((entry) => entry && entry.id && !entry.deleted_at).map((entry) => [entry.id, entry]));
	const out = [];

	for (const {id, order} of changes) {
		const entry = byId.get(id);

		if (!entry) {
			continue;
		}

		const next = {...entry, updated_at: nextStamp(entry.updated_at, now)};

		if (order === null || order === undefined) {
			delete next.order;
		}
		else {
			next.order = order;
		}

		out.push(stampEntry(entry, next));
	}

	return out;
}

// ------------------------------------------------------- the panel
//
// Edit order: the section's entries as rows, each with a handle to drag
// (mouse, pen, or a finger: the handle alone takes the gesture, so the rest
// of the row still scrolls the page) and Move up and Move down buttons, for
// a keyboard and screen readers. A move redraws at once and calls
// onMove(id, toIndex); the screen saves it and calls update() with the
// entries as saved. Done calls onDone.
//
// items: [{id, name, detail}], in the order shown.

const EDGE_PX = 72;
const SCROLL_STEP = 12;

export function orderEditor({items, label, onDone, onMove}) {
	let rows = [...items];
	let drag = null;
	const status = h('p', {'aria-live': 'polite', class: 'muted reorder-status', role: 'status'});
	const list = h('ol', {'aria-label': label, class: 'reorder-list'});
	const done = h('button', {class: 'small primary reorder-done', onclick: () => onDone(), type: 'button'}, 'Done');
	const element = h('div', {class: 'reorder'},
		h('div', {class: 'reorder-head'},
			h('p', {class: 'muted reorder-hint'}, 'Drag a handle, or use the arrows.'),
			done
		),
		list,
		status
	);

	function move(id, to, how) {
		const from = rows.findIndex((row) => row.id === id);
		const target = Math.min(Math.max(to, 0), rows.length - 1);

		if (from < 0 || target === from) {
			return;
		}

		const [row] = rows.splice(from, 1);

		rows.splice(target, 0, row);
		draw(how ? {how, id} : null);
		status.textContent = `${row.name} moved to ${target + 1} of ${rows.length}.`;
		onMove(id, target);
	}

	function rowNode(row, i) {
		const up = h('button', {'aria-label': `Move ${row.name} up`, class: 'small reorder-up', 'data-move': 'up', disabled: i === 0, onclick: () => move(row.id, i - 1, 'up'), type: 'button'}, '↑');
		const down = h('button', {'aria-label': `Move ${row.name} down`, class: 'small reorder-down', 'data-move': 'down', disabled: i === rows.length - 1, onclick: () => move(row.id, i + 1, 'down'), type: 'button'}, '↓');
		const handle = h('span', {'aria-hidden': 'true', class: 'reorder-handle', title: 'Drag to move'}, h('span', {class: 'reorder-grip'}));
		const node = h('li', {class: 'reorder-row', 'data-id': row.id},
			handle,
			h('span', {class: 'reorder-text'},
				h('span', {class: 'reorder-name'}, row.name),
				row.detail ? h('span', {class: 'reorder-detail'}, row.detail) : null
			),
			up,
			down
		);

		handle.addEventListener('pointerdown', (event) => startDrag(event, row.id, node, handle));

		return node;
	}

	// focus: {id, how} keeps the keyboard on the row that moved, on the same
	// arrow, or on the other one once it reaches an end.
	function draw(focus = null) {
		list.replaceChildren(...rows.map(rowNode));

		if (focus) {
			const node = [...list.children].find((item) => item.dataset.id === focus.id);
			const same = node && node.querySelector(`[data-move="${focus.how}"]`);
			const other = node && node.querySelector(`[data-move="${focus.how === 'up' ? 'down' : 'up'}"]`);

			(same && !same.disabled ? same : other)?.focus();
		}
	}

	// ------------------------------------------------- drag and drop

	function startDrag(event, id, node, handle) {
		if (drag || (event.pointerType === 'mouse' && event.button !== 0)) {
			return;
		}

		event.preventDefault();

		const nodes = [...list.children];
		const from = nodes.indexOf(node);
		const tops = nodes.map((item) => item.getBoundingClientRect().top + window.scrollY);
		const rect = node.getBoundingClientRect();
		const gap = nodes.length > 1 ? Math.max(0, (tops[1] - tops[0]) - nodes[0].getBoundingClientRect().height) : 0;

		drag = {
			from,
			height: rect.height + gap,
			id,
			mids: nodes.map((item, i) => tops[i] + (item.getBoundingClientRect().height / 2)),
			node,
			nodes,
			pointerY: event.clientY,
			startY: event.clientY + window.scrollY,
			target: from,
			timer: 0,
		};

		try {
			handle.setPointerCapture(event.pointerId);
		}
		catch {
			// Moves still arrive while the pointer stays on the handle.
		}

		node.classList.add('dragging');
		list.classList.add('reorder-dragging');

		const moveListener = (moveEvent) => {
			drag.pointerY = moveEvent.clientY;
			follow();
		};
		const end = (endEvent) => {
			handle.removeEventListener('pointermove', moveListener);
			handle.removeEventListener('pointerup', end);
			handle.removeEventListener('pointercancel', end);
			finishDrag(endEvent.type === 'pointerup');
		};

		handle.addEventListener('pointermove', moveListener);
		handle.addEventListener('pointerup', end);
		handle.addEventListener('pointercancel', end);
		drag.timer = requestAnimationFrame(scrollNearEdge);
	}

	// The dragged row follows the finger, and the rows it passes make room.
	function follow() {
		const pageY = drag.pointerY + window.scrollY;
		const dy = pageY - drag.startY;
		const center = drag.mids[drag.from] + dy;
		let target = 0;

		drag.mids.forEach((mid, i) => {
			if (i !== drag.from && center > mid) {
				target++;
			}
		});

		drag.target = target;
		drag.node.style.transform = `translateY(${dy}px)`;
		drag.nodes.forEach((item, i) => {
			if (item === drag.node) {
				return;
			}

			let shift = 0;

			if (drag.from < target && i > drag.from && i <= target) {
				shift = -drag.height;
			}
			else if (drag.from > target && i < drag.from && i >= target) {
				shift = drag.height;
			}

			item.style.transform = shift ? `translateY(${shift}px)` : '';
		});
	}

	// Near the top or bottom of the screen, the page scrolls on its own.
	function scrollNearEdge() {
		if (!drag) {
			return;
		}

		const bottom = window.innerHeight - EDGE_PX - 64;
		let step = 0;

		if (drag.pointerY < EDGE_PX) {
			step = -SCROLL_STEP;
		}
		else if (drag.pointerY > bottom) {
			step = SCROLL_STEP;
		}

		if (step) {
			const before = window.scrollY;

			window.scrollBy(0, step);

			if (window.scrollY !== before) {
				follow();
			}
		}

		drag.timer = requestAnimationFrame(scrollNearEdge);
	}

	function finishDrag(dropped) {
		const {id, from, target, timer} = drag;

		cancelAnimationFrame(timer);
		drag.nodes.forEach((item) => {
			item.style.transform = '';
		});
		drag.node.classList.remove('dragging');
		list.classList.remove('reorder-dragging');
		drag = null;

		if (dropped && target !== from) {
			move(id, target, null);
		}
	}

	draw();

	return {
		element,
		// The entries as saved; ignored mid-drag, so a save landing then does
		// not pull the row from under the finger.
		update(next) {
			if (drag) {
				return;
			}

			const focused = document.activeElement && list.contains(document.activeElement)
				? {how: document.activeElement.dataset.move, id: document.activeElement.closest('.reorder-row')?.dataset.id}
				: null;

			rows = [...next];
			draw(focused && focused.how && focused.id ? focused : null);
		},
	};
}

// ------------------------------------------------------- a section
//
// What a screen needs for one section (Checklists, Goals, Collections,
// Binders): the Edit order button, the panel that takes the place of the
// section's tiles while it is open, and the saves. Each move is saved in
// turn, from the order the last save left, with Undo on a toast; a newer
// move's toast takes the place of the last one's.
//
//   describe(entry)  {name, detail} for a row
//   fallback         the section's old order, for entries with no order
//   label            what the rows are, for screen readers ("Checklists")
//   save(changes)    writes [{id, order}] and resolves to the saved entries
//   toast            js/shell.js toast
//   errorText        js/dom.js errorText, for a save that fails
//   onToggle(open)   the screen hides or shows its tiles
//
// set(entries) takes the section's live entries after every load; sorted()
// is the section in its order.

export const UNDO_MS = 8000;

export function orderSection({describe, errorText: failText = errorText, fallback = byCreated, label, onToggle = () => {}, save, toast}) {
	let section = [];
	let editor = null;
	let chain = Promise.resolve();
	let lastToast = null;
	const panel = h('div', {class: 'reorder-slot', hidden: true});
	const button = h('button', {'aria-expanded': 'false', class: 'small reorder-toggle', hidden: true, type: 'button'}, 'Edit order');

	const sorted = () => sortByOrder(section, fallback);
	const items = () => sorted().map((entry) => ({id: entry.id, ...describe(entry)}));

	function keep(saved) {
		const byId = new Map((saved || []).filter(Boolean).map((entry) => [entry.id, entry]));

		section = section.map((entry) => byId.get(entry.id) || entry);
	}

	// Moves not saved yet: a load that lands before them would put the rows
	// back for a moment, so the panel waits for the last one.
	let pending = 0;

	const run = (work) => {
		pending++;
		chain = chain.then(work).catch((err) => {
			toast(`The order was not saved. ${failText(err)}`);
		}).finally(() => {
			pending--;

			if (editor && !pending) {
				editor.update(items());
			}
		});

		return chain;
	};

	function move(id, to) {
		return run(async () => {
			const changes = orderMoves(sorted(), id, to);

			if (!changes.length) {
				return;
			}

			const entry = section.find((one) => one.id === id);

			keep(await save(changes));

			if (lastToast) {
				lastToast.remove();
			}

			lastToast = toast(`Moved ${describe(entry).name}.`, {
				action: () => run(async () => {
					keep(await save(undoMoves(changes)));
				}),
				actionLabel: 'Undo',
				timeout: UNDO_MS,
			});
		});
	}

	function open() {
		editor = orderEditor({items: items(), label, onDone: close, onMove: move});
		panel.replaceChildren(editor.element);
		panel.hidden = false;
		button.hidden = true;
		button.setAttribute('aria-expanded', 'true');
		onToggle(true);
		editor.element.querySelector('.reorder-done')?.focus();
	}

	function close() {
		editor = null;
		panel.replaceChildren();
		panel.hidden = true;
		button.setAttribute('aria-expanded', 'false');
		button.hidden = section.length < 2;
		onToggle(false);

		if (!button.hidden) {
			button.focus();
		}
	}

	button.addEventListener('click', open);

	return {
		button,
		close: () => editor && close(),
		get editing() {
			return Boolean(editor);
		},
		panel,
		set(entries) {
			section = [...(entries || [])];

			if (!editor) {
				button.hidden = section.length < 2;
			}
			else if (section.length < 2) {
				close();
			}
			else if (!pending) {
				editor.update(items());
			}
		},
		sorted,
	};
}
