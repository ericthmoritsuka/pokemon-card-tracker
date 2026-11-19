// The scanner's icon controls (Eric, 2026-11-19; DESIGN.md section 11, "How
// and For"). For is a row at the head of the tray, under the camera:
//
//   For: [+] Add   [$] Buy   [<>] Trade or sale
//
// what the cards are for, a mode remembered on the phone (js/scan/trade.js
// storedMode), the one in use pressed. How the cards come in sits in the
// shutter's row instead, where a camera app keeps its gallery button
// (design review, 2026-11-19: a second row of icons cost the camera 44 px):
//
//   [x Close] [Photo] [Page]  (shutter)  [Done]
//
// The camera itself is the card way in, so it needs no button. Each button
// is an icon and one short word, at least 44 px tall, and fits 360 px wide.
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
	close: [
		['path', {d: 'M6 6l12 12M18 6 6 18'}],
	],
	// Three dots: the tray's menu (Set for all, Clear).
	more: [
		['circle', {cx: 5, cy: 12, r: 1.4}],
		['circle', {cx: 12, cy: 12, r: 1.4}],
		['circle', {cx: 19, cy: 12, r: 1.4}],
	],
	// A cog of eight teeth round a hole: the scanner's settings.
	settings: [
		['path', {d: 'M19.03 10.46 L21.51 10.68 L21.51 13.32 L19.03 13.54 L18.06 15.88 L19.65 17.79 L17.79 19.65 L15.88 18.06 L13.54 19.03 L13.32 21.51 L10.68 21.51 L10.46 19.03 L8.12 18.06 L6.21 19.65 L4.35 17.79 L5.94 15.88 L4.97 13.54 L2.49 13.32 L2.49 10.68 L4.97 10.46 L5.94 8.12 L4.35 6.21 L6.21 4.35 L8.12 5.94 L10.46 4.97 L10.68 2.49 L13.32 2.49 L13.54 4.97 L15.88 5.94 L17.79 4.35 L19.65 6.21 L18.06 8.12Z'}],
		['circle', {cx: 12, cy: 12, r: 3}],
	],
	// A torch: its head, body, and a ray.
	torch: [
		['path', {d: 'M8 3h8l-1.5 5h-5zM9.5 8h5v12a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1z'}],
		['path', {d: 'M12 12.5v3'}],
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

// Done in Buy and in Trade or sale: "Log 3 ›" (design review, 2026-11-19:
// "Log purchase 3" took two lines at 360 px). The pressed For button and
// the count over the camera already name the mode; the arrow says another
// screen follows and nothing is saved yet. The full words are its name for a
// screen reader (logAria).
// The Done sheet's button that hands the Add tray over as a purchase:
// "Log purchase 3", a full-width button with room for it.
export const purchaseLabel = (count) => (count ? `Log purchase ${count}` : 'Log purchase');

export const logButtonText = (count) => (count ? `Log ${count} ›` : 'Log ›');

export const logAria = (count, mode) => `Log ${count === 1 ? '1 card' : `${count} cards`} as ${mode === 'buy' ? 'a purchase' : 'a trade or sale'}`;

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

// A button of the shutter's row: its icon over its word (Close, Photo,
// Page), so three fit beside the shutter and Done at 360 px.
export function controlButton({id, label = null, name, onclick, word, ...rest}) {
	return h('button', {'aria-label': label, class: 'scan-control scan-icon-control', id, onclick, type: 'button', ...rest}, icon(name), h('span', {class: 'scan-icon-word'}, word));
}

// A round icon chip over the camera's foot (Settings, the torch): no word,
// so its name is `label`.
export function iconChip({id, label, name, onclick, ...rest}) {
	return h('button', {'aria-label': label, class: 'scan-chip scan-icon-chip', id, onclick, type: 'button', ...rest}, icon(name));
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
