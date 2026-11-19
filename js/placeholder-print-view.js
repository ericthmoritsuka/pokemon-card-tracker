// Print placeholders, the page (DESIGN.md section 11, Binders): a screen
// laid over the binder with the choices (the pages on screen or all of
// them; pockets already filled or not), a preview of the sheets, and Print,
// which waits for every picture and then calls window.print(). The print
// stylesheet (css/placeholder-print.css) shows only the sheets, each card
// at the real card size, 3 x 3 to a sheet of A4 or US Letter, with thin cut
// lines. js/placeholder-print.js picks the pockets and lays out the sheets.
//
// It is a sheet (js/sheet.js), so Back and Escape close it without leaving
// the binder, and the screen under it stays as it was. The whole app stays
// in the document while it is open; body.pp-open hides it from the printer.
//
// cards: every pocket with something to print, in binder order, as
// {page, position, status, dex, name, detail, images}: dex a Pokédex
// number or null; detail a line for a specific card (set and number) or
// null; images the pictures to try in order (the card image, the official
// artwork, the sprite), plain text when none loads.

import {h} from './dom.js';
import {openSheet} from './sheet.js';
import {CARD_MM, SHEET_COLS, choosePockets, pagesText, pocketText, sheetsOf, summaryText} from './placeholder-print.js';

// How long Print waits for pictures before printing what it has: a slow
// connection should not leave the button doing nothing.
const IMAGE_WAIT_MS = 20000;

const MM_PX = 96 / 25.4;

const dexText = (n) => `#${String(n).padStart(3, '0')}`;

// One card's picture: the first image that loads, or the name in large
// type when none does. ready resolves either way.
function picture(card) {
	const box = h('div', {class: 'pp-art'});
	const urls = card.images.filter(Boolean);
	let resolve;
	const ready = new Promise((done) => {
		resolve = done;
	});

	const plain = () => {
		box.classList.add('pp-art-text');
		box.replaceChildren(h('span', {class: 'pp-art-dex'}, card.dex ? dexText(card.dex) : '?'));
		resolve();
	};

	const tryNext = (i) => {
		if (i >= urls.length) {
			plain();

			return;
		}

		// Eager, not lazy: a lazy image below the fold is not fetched
		// before the printer asks for it.
		const img = h('img', {alt: '', decoding: 'async', loading: 'eager'});

		img.addEventListener('load', () => resolve(), {once: true});
		img.addEventListener('error', () => tryNext(i + 1), {once: true});
		img.src = urls[i];
		box.replaceChildren(img);
	};

	tryNext(0);

	return {node: box, ready};
}

function cardNode(card, binderName, waits) {
	const art = picture(card);

	waits.push(art.ready);

	return h('div', {
		class: `pp-card pp-${card.status}`,
		'data-page': card.page,
		'data-position': card.position,
	},
	h('div', {class: 'pp-top'},
		h('span', {class: 'pp-dex'}, card.dex ? dexText(card.dex) : ''),
		h('span', {class: 'pp-where'}, pocketText(card.page, card.position))),
	art.node,
	h('p', {class: 'pp-name'}, card.name),
	card.detail ? h('p', {class: 'pp-detail'}, card.detail) : null,
	h('p', {class: 'pp-binder'}, binderName));
}

// Opens the page. shownPages: the pages on screen in the binder, the first
// choice. Returns the sheet handle ({close}).
export function openPlaceholderPrint({binderName, cards, shownPages}) {
	const choiceRow = (name, value, text, checked) => h('label', null,
		h('input', {checked, name, type: 'radio', value}),
		h('span', null, text));
	// All pages first when the pages on screen have nothing to fill (design
	// review, 2026-11-19: it opened on a full page, its Print off).
	const startAll = !choosePockets(cards, {pages: shownPages}).length && choosePockets(cards).length > 0;
	const pages = h('div', {'aria-label': 'Which pages', class: 'pp-choice', role: 'radiogroup'},
		choiceRow('pp-pages', 'shown', pagesText(shownPages), !startAll),
		choiceRow('pp-pages', 'all', 'All pages', startAll));
	const filled = h('input', {id: 'pp-filled', type: 'checkbox'});
	const summary = h('p', {'aria-live': 'polite', class: 'pp-summary', id: 'pp-summary'});
	const status = h('p', {'aria-live': 'polite', class: 'muted pp-status', id: 'pp-status'});
	const close = h('button', {id: 'pp-close', type: 'button'}, 'Close');
	const print = h('button', {class: 'primary', id: 'pp-print', type: 'button'}, 'Print');
	const sheets = h('div', {class: 'pp-sheets', id: 'pp-sheets'});
	const view = h('div', {'aria-labelledby': 'pp-title', 'aria-modal': 'true', class: 'pp-view', id: 'pp-view', role: 'dialog'},
		h('div', {class: 'pp-bar'},
			h('h2', {id: 'pp-title'}, 'Print placeholders'),
			h('p', {class: 'muted pp-lead'}, 'Paper cards for the pockets you still need to fill, at real card size.'),
			pages,
			h('label', {class: 'pp-check'}, filled, h('span', null, 'Include pockets already filled')),
			summary,
			h('p', {class: 'muted pp-tip'}, 'Print at 100% scale (Actual size) on A4 or Letter, then cut along the lines.'),
			status,
			h('div', {class: 'pp-buttons'}, close, print)),
		sheets);
	let waits = [];
	let printing = false;

	function draw() {
		const choice = pages.querySelector('input:checked').value;
		const chosen = choosePockets(cards, {filled: filled.checked, pages: choice === 'all' ? null : shownPages});
		const laid = sheetsOf(chosen);

		waits = [];
		sheets.replaceChildren(...laid.map((list, i) => h('section', {'aria-label': `Sheet ${i + 1} of ${laid.length}`, class: 'pp-sheet'},
			...list.map((card) => cardNode(card, binderName, waits)))));
		summary.textContent = summaryText(chosen.length);
		print.disabled = !chosen.length;
		status.textContent = '';
		fit();
	}

	// The preview fits the screen's width; the printer always gets the real
	// size, since the print stylesheet sets no zoom.
	function fit() {
		const width = SHEET_COLS * CARD_MM.width * MM_PX;
		const room = sheets.clientWidth || window.innerWidth;

		sheets.style.setProperty('--pp-zoom', String(Math.min(1, room / width)));
	}

	async function printNow() {
		if (printing) {
			return;
		}

		printing = true;
		print.disabled = true;
		status.textContent = 'Getting the pictures ready...';

		let timer = 0;

		await Promise.race([
			Promise.all(waits),
			new Promise((resolve) => {
				timer = setTimeout(resolve, IMAGE_WAIT_MS);
			}),
		]);
		clearTimeout(timer);
		status.textContent = '';
		printing = false;

		// The choices may have changed while the pictures loaded (draw):
		// print what is on the sheets now, and nothing when none is chosen.
		const any = Boolean(sheets.querySelector('.pp-card'));

		print.disabled = !any;

		if (any && view.isConnected) {
			window.print();
		}
	}

	pages.addEventListener('change', draw);
	filled.addEventListener('change', draw);
	print.addEventListener('click', printNow);
	window.addEventListener('resize', fit);
	document.body.classList.add('pp-open');

	const handle = openSheet(view, {
		onClose: () => {
			window.removeEventListener('resize', fit);
			document.body.classList.remove('pp-open');
		},
	});

	close.addEventListener('click', () => handle.close());
	draw();
	close.focus();

	return handle;
}
