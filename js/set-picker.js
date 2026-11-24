// A filter whose options can show a picture, which a native <select> cannot:
// the Shop's set filter, where an older set shows its symbol beside its name
// (Eric, 2026-11-24: he sorts his cards by what is printed on them).
//
// The WAI-ARIA listbox pattern: a button that names the choice and opens a
// list. The list takes focus and moves an active option with
// aria-activedescendant: Up and Down, Home and End, and a letter typed jumps
// to the next option starting with it. Enter or Space picks, Escape closes
// and gives focus back to the button, and Tab or a tap elsewhere closes.
// onChange runs only when a person picks a different value, as a select's
// change event does.
//
// setPicker({id, label, onChange}) -> {node, setOptions, value}
//   setOptions(options, value) draws [{value, text, code, symbol}], the first
//   being the "every" choice; code shows as "(CRI)", and symbol is an image
//   address shown instead of the code, which comes back when the image fails.
import {h} from './dom.js';

let pickers = 0;

export function setPicker({id, label, onChange}) {
	const key = `${id}-${++pickers}`;
	let options = [];
	let value = '';
	let active = -1;
	let typed = '';
	let typedAt = 0;

	const face = h('span', {class: 'set-picker-face'});
	const button = h('button', {'aria-controls': `${key}-list`, 'aria-expanded': 'false', 'aria-haspopup': 'listbox', class: 'set-picker-button', id, type: 'button'},
		h('span', {class: 'visually-hidden'}, `${label}: `), face);
	const list = h('ul', {'aria-label': label, class: 'set-picker-list', hidden: true, id: `${key}-list`, role: 'listbox', tabindex: '-1'});
	const node = h('div', {class: 'set-picker'}, button, list);

	const isOpen = () => !list.hidden;
	const optionId = (index) => `${key}-option-${index}`;

	// The symbol, or the code when there is no symbol or its image fails.
	function mark(option) {
		const code = option.code ? h('span', {class: 'set-picker-code'}, `(${option.code})`) : null;

		if (!option.symbol) {
			return code;
		}

		const img = h('img', {alt: '', class: 'set-picker-symbol', decoding: 'async', height: 26, src: option.symbol, width: 26});

		img.addEventListener('error', () => (code ? img.replaceWith(code) : img.remove()), {once: true});

		return img;
	}

	const content = (option) => [mark(option), ' ', h('span', {class: 'set-picker-text'}, option.text)].filter(Boolean);

	function drawFace() {
		const chosen = options.find((option) => option.value === value) || options[0];

		face.replaceChildren(...(chosen ? content(chosen) : []));
	}

	function drawList() {
		list.replaceChildren(...options.map((option, index) => h('li', {
			'aria-selected': option.value === value ? 'true' : 'false',
			class: 'set-picker-option',
			'data-value': option.value,
			id: optionId(index),
			onclick: () => choose(index),
			// Keeps focus in the list, so a tap does not close it first.
			onmousedown: (event) => event.preventDefault(),
			role: 'option',
		}, content(option))));
		markActive();
	}

	function markActive() {
		list.querySelectorAll('.set-picker-option').forEach((item, index) => item.classList.toggle('active', index === active));

		if (active >= 0 && options[active]) {
			list.setAttribute('aria-activedescendant', optionId(active));
			list.children[active].scrollIntoView({block: 'nearest'});
		}
		else {
			list.removeAttribute('aria-activedescendant');
		}
	}

	function open() {
		if (isOpen() || !options.length) {
			return;
		}

		active = Math.max(0, options.findIndex((option) => option.value === value));
		list.hidden = false;
		button.setAttribute('aria-expanded', 'true');
		markActive();
		list.focus();
	}

	function close(refocus) {
		if (!isOpen()) {
			return;
		}

		list.hidden = true;
		button.setAttribute('aria-expanded', 'false');

		if (refocus) {
			button.focus();
		}
	}

	function choose(index) {
		const option = options[index];

		close(true);

		if (!option || option.value === value) {
			return;
		}

		value = option.value;
		drawFace();
		drawList();
		onChange(value);
	}

	function move(to) {
		active = Math.min(options.length - 1, Math.max(0, to));
		markActive();
	}

	function typeAhead(letter) {
		const now = Date.now();

		typed = now - typedAt < 700 ? typed + letter : letter;
		typedAt = now;

		const starts = (index) => options[index].text.toLocaleLowerCase().startsWith(typed);
		const order = options.map((_, index) => (active + (typed.length > 1 ? 0 : 1) + index) % options.length);
		const found = order.find(starts);

		if (found !== undefined) {
			move(found);
		}
	}

	button.addEventListener('click', () => (isOpen() ? close(true) : open()));
	button.addEventListener('keydown', (event) => {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			open();
		}
	});
	list.addEventListener('keydown', (event) => {
		const keys = {
			ArrowDown: () => move(active + 1),
			ArrowUp: () => move(active - 1),
			End: () => move(options.length - 1),
			Enter: () => choose(active),
			Escape: () => close(true),
			Home: () => move(0),
			' ': () => choose(active),
		};

		if (keys[event.key]) {
			event.preventDefault();
			keys[event.key]();
		}
		else if (event.key === 'Tab') {
			close(false);
		}
		else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
			typeAhead(event.key.toLocaleLowerCase());
		}
	});
	node.addEventListener('focusout', (event) => {
		if (!node.contains(event.relatedTarget)) {
			close(false);
		}
	});

	return {
		node,
		setOptions(next, current) {
			options = next;
			value = current;
			drawFace();
			drawList();
		},
		get value() {
			return value;
		},
	};
}
