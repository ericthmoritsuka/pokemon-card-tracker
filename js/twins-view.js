// The international twin picker for card detail (DESIGN.md section 5,
// "International twins for Asian prints"): when the matcher found two or
// three English prints that could share a Japanese card's artwork, it shows
// them side by side, each with "This one", and "None of these" underneath.
// The answer is kept on the device (js/twins.js setDecision), and a
// confirmed twin then joins the card's images as "International print".
//
//   twinPicker({candidates, onPick, onNone})   the picker alone
//   twinConfirm({cardId, catalog})             card detail's block: check(record)
//                                              from every render; it shows the
//                                              picker only when there is
//                                              something to ask
//
// Styles: css/twins.css.

import {cardImage} from './catalog.js';
import {h} from './dom.js';
import {ensureTwin, loadTwins, setDecision, twinState} from './twins.js';

const describe = (candidate) => [candidate.name, [candidate.setName || candidate.setId, candidate.localId].filter(Boolean).join(' ')]
	.filter(Boolean).join(', ');

function option(candidate, onPick) {
	const label = describe(candidate);
	const src = cardImage(candidate.image, 'low');
	const art = src
		? h('img', {alt: label, class: 'tw-image', decoding: 'async', loading: 'lazy', src})
		: h('div', {'aria-label': label, class: 'tw-image tw-missing', role: 'img'}, 'No image');
	const button = h('button', {'aria-label': `This one: ${label}`, class: 'small tw-pick', type: 'button'}, 'This one');

	button.addEventListener('click', () => onPick(candidate));

	return h('li', {class: 'tw-option', 'data-twin': candidate.id},
		art,
		h('span', {class: 'tw-name'}, candidate.name),
		h('span', {class: 'tw-set'}, [candidate.setName || candidate.setId, candidate.localId ? `#${candidate.localId}` : null].filter(Boolean).join(' ')),
		button
	);
}

// The picker: one to three candidates ({id, name, image, setId, setName,
// localId}). onPick(candidate) and onNone() run once; the buttons are
// disabled after either.
let pickers = 0;

export function twinPicker({candidates, onNone, onPick}) {
	const shown = candidates.slice(0, 3);
	const titleId = `tw-title-${++pickers}`;
	let done = false;

	const once = (fn) => (...args) => {
		if (done) {
			return;
		}

		done = true;

		for (const button of element.querySelectorAll('button')) {
			button.disabled = true;
		}

		fn(...args);
	};

	const none = h('button', {class: 'small tw-none', type: 'button'}, 'None of these');
	const element = h('section', {'aria-labelledby': titleId, class: 'tw-confirm'},
		h('h3', {class: 'tw-title', id: titleId}, shown.length === 1 ? 'Is this the international print?' : 'Which is the international print?'),
		h('p', {class: 'muted tw-hint'}, shown.length === 1
			? 'It may be the English print of this card. Confirm it to show its image here.'
			: 'One of these may be the English print of this card. Pick it to show its image here.'),
		h('ul', {class: 'tw-options', style: `--tw-count: ${shown.length}`}, shown.map((candidate) => option(candidate, once(onPick)))),
		h('div', {class: 'tw-actions'}, none)
	);

	none.addEventListener('click', once(onNone));

	return element;
}

// Card detail's block for one Asian card. check(record) with the TCGdex
// record from every render works out the twin when it is due (at most once
// a week for a card with none) and shows the picker when the result is
// ambiguous and unanswered. The element is empty and hidden otherwise.
// After an answer it says what was saved, in a polite live region.
export function twinConfirm({cardId, catalog}) {
	const element = h('div', {class: 'tw-block', hidden: true});
	const status = h('p', {'aria-live': 'polite', class: 'muted tw-status', role: 'status'});
	let alive = true;
	let asked = null;
	let run = 0;

	element.append(status);

	function draw() {
		if (!alive) {
			return;
		}

		const state = twinState({card_id: cardId, catalog});
		const key = state.ask ? state.candidates.map((c) => c.id).join(',') : null;

		if (key === asked) {
			return;
		}

		asked = key;
		element.querySelector('.tw-confirm')?.remove();

		if (!state.ask) {
			element.hidden = !status.textContent;

			return;
		}

		status.textContent = '';
		element.hidden = false;
		element.prepend(twinPicker({
			candidates: state.candidates,
			async onNone() {
				await setDecision({card_id: cardId, catalog}, {choice: 'rejected', rejected: state.candidates.map((c) => c.id)});
				status.textContent = 'Saved: no international print for now.';
				draw();
			},
			async onPick(candidate) {
				await setDecision({card_id: cardId, catalog}, {choice: 'confirmed', twin: candidate});
				status.textContent = `Saved: ${candidate.name} is the international print.`;
				draw();
			},
		}));
	}

	return {
		check(record) {
			const mine = ++run;

			if (catalog !== 'ja' || !record) {
				element.hidden = true;

				return;
			}

			loadTwins()
				.then(() => {
					if (alive && mine === run) {
						draw();
					}

					return ensureTwin(record, {catalog});
				})
				.then(() => {
					if (alive && mine === run) {
						draw();
					}
				})
				.catch(() => {
					// Offline or a TCGdex error: nothing to ask; the next visit tries again.
				});
		},
		destroy() {
			alive = false;
		},
		element,
	};
}
