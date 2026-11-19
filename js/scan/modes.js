// The two rows of icon buttons at the head of the scanner's tray, under the
// camera (Eric, 2026-11-19; DESIGN.md section 11, "How and For"), in place
// of the Add / Trade or sale switch:
//
//   How: [#] Card  [img] Photo  [:::] Page
//   For: [+] Add   [$] Buy      [<>] Trade or sale
//
// How is the way the cards come in: Card is the camera, the scanner's own
// way, and shows pressed while the camera shows the picture; Photo (one card
// from the gallery) and Page (a whole binder page) are actions that open a
// picker, so they are plain buttons and never pressed. For is what the
// cards are for, a mode remembered on the phone (js/scan/trade.js
// storedMode), the one in use pressed. Each button is an icon and one short
// word, at least 44 px tall, and both rows fit 360 px wide.
// js/scan/view.js runs them.

import {h} from '../dom.js';

const SVG = 'http://www.w3.org/2000/svg';

// The app's line icons (index.html's tab bar): a 24 px box, round ends, no
// fill, the stroke in the text's colour (css/scan.css .scan-icon). Each is a
// list of [tag, attributes].
const ICONS = {
	// The Scan tab's glyph: a card in the camera's corners.
	card: [
		['path', {d: 'M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3'}],
		['rect', {height: 10, rx: 1, width: 7, x: 8.5, y: 7}],
	],
	// A picture: a frame, the sun, and a hill.
	photo: [
		['rect', {height: 16, rx: 2, width: 18, x: 3, y: 4}],
		['circle', {cx: 8.5, cy: 9.5, r: 1.5}],
		['path', {d: 'm21 16-5-5-9 9'}],
	],
	// A binder page: three rows of three pockets.
	page: [
		['rect', {height: 5, rx: 1, width: 4.5, x: 3, y: 2.5}],
		['rect', {height: 5, rx: 1, width: 4.5, x: 9.75, y: 2.5}],
		['rect', {height: 5, rx: 1, width: 4.5, x: 16.5, y: 2.5}],
		['rect', {height: 5, rx: 1, width: 4.5, x: 3, y: 9.5}],
		['rect', {height: 5, rx: 1, width: 4.5, x: 9.75, y: 9.5}],
		['rect', {height: 5, rx: 1, width: 4.5, x: 16.5, y: 9.5}],
		['rect', {height: 5, rx: 1, width: 4.5, x: 3, y: 16.5}],
		['rect', {height: 5, rx: 1, width: 4.5, x: 9.75, y: 16.5}],
		['rect', {height: 5, rx: 1, width: 4.5, x: 16.5, y: 16.5}],
	],
	add: [
		['path', {d: 'M12 5v14M5 12h14'}],
	],
	// A dollar sign, Eric's mockup's [$]: money paid.
	buy: [
		['path', {d: 'M12 3v18'}],
		['path', {d: 'M16.5 7.5C16.5 5.6 14.5 4.5 12 4.5S7.5 5.7 7.5 7.6c0 4.4 9 2.4 9 6.9 0 2-2 3.1-4.5 3.1s-4.5-1.1-4.5-3'}],
	],
	// Two arrows passing each other, Eric's mockup's [<>]: cards both ways.
	trade: [
		['path', {d: 'M8 3 4 7l4 4M4 7h15'}],
		['path', {d: 'm16 13 4 4-4 4M20 17H5'}],
	],
};

export function icon(name) {
	const svg = document.createElementNS(SVG, 'svg');

	svg.setAttribute('aria-hidden', 'true');
	svg.setAttribute('class', 'scan-icon');
	svg.setAttribute('focusable', 'false');
	svg.setAttribute('viewBox', '0 0 24 24');

	for (const [tag, attributes] of ICONS[name]) {
		const shape = document.createElementNS(SVG, tag);

		for (const [key, value] of Object.entries(attributes)) {
			shape.setAttribute(key, String(value));
		}

		svg.append(shape);
	}

	return svg;
}

// The names the person reads for each mode: on its button, first in the
// running count over the camera, and in what is announced on a switch.
export const MODE_NAMES = {add: 'Add', buy: 'Buy', trade: 'Trade or sale'};

// Buy's Done: "Log purchase 3", counting the tray as Done counts the Add
// tray ("Done 3"), so the button says the cards go to the trades log, not
// into the collection (Eric, 2026-11-19).
export const purchaseLabel = (count) => (count ? `Log purchase ${count}` : 'Log purchase');

// A button of either row: the icon and its word, the icon hidden from a
// screen reader, so the word is the button's name unless `label` gives a
// longer one that starts with it.
function iconButton({id, label = null, name, onclick, word, ...rest}) {
	return h('button', {'aria-label': label, class: 'scan-icon-button', id, onclick, type: 'button', ...rest}, icon(name), h('span', {class: 'scan-icon-word'}, word));
}

// The row's own word ("How", "For") is for the eye; the group's label says
// it in full to a screen reader, so the word itself is hidden from one.
function row({id, labelText, word, buttons}) {
	return h('div', {'aria-label': labelText, class: 'scan-head-group', id, role: 'group'},
		h('span', {'aria-hidden': 'true', class: 'scan-head-label'}, word),
		...buttons);
}

// How: Card, Photo, and Page. onCard runs when Card is tapped (the camera
// again, when it is off); onPhoto and onPage open their pickers, and must
// click a file input within the tap, as a browser asks.
export function howRow({onCard, onPhoto, onPage}) {
	return row({
		buttons: [
			iconButton({'aria-pressed': 'true', id: 'scan-how-card', label: 'Card: scan with the camera', name: 'card', onclick: onCard, word: 'Card'}),
			iconButton({id: 'scan-photo-open', label: 'Photo: pick a photo of one card', name: 'photo', onclick: onPhoto, word: 'Photo'}),
			iconButton({'aria-haspopup': 'dialog', id: 'scan-page-open', label: 'Page: a whole binder page from a photo', name: 'page', onclick: onPage, word: 'Page'}),
		],
		id: 'scan-how',
		labelText: 'How to scan',
		word: 'How',
	});
}

// Card is pressed while the camera shows the picture: that is the scanning
// in use. With the camera off (no permission, no camera), nothing is.
export function drawHow(el, {camera}) {
	el.querySelector('#scan-how-card').setAttribute('aria-pressed', String(Boolean(camera)));
}

// For: Add, Buy, and Trade or sale, the one in use pressed (teal for Trade
// or sale). Pressing another asks to switch; the view may refuse, and
// draws the row again either way.
export function forRow(onChoose) {
	const button = (mode, name) => iconButton({'aria-pressed': 'false', 'data-mode-to': mode, id: `scan-mode-${mode}`, name, onclick: () => onChoose(mode), word: MODE_NAMES[mode]});

	const el = row({
		buttons: [button('add', 'add'), button('buy', 'buy'), button('trade', 'trade')],
		id: 'scan-mode',
		labelText: 'What the cards are for',
		word: 'For',
	});

	el.dataset.mode = 'add';

	return el;
}

export function drawFor(el, mode) {
	el.dataset.mode = MODE_NAMES[mode] ? mode : 'add';

	for (const button of el.querySelectorAll('[data-mode-to]')) {
		button.setAttribute('aria-pressed', String(button.dataset.modeTo === el.dataset.mode));
	}
}
