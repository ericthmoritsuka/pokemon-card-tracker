// One tray tile: the card's photo with the four badge corners of the design
// review's badge system (plans/design-review.md, "Badge System"): language
// flag top left (always, in the tray), quantity top right (how many there
// will be in all once saved, owned and other tray cards included) when it is
// more than this card's own copies, finish
// bottom left when it is not the plain print, and one status bottom right,
// first match wins: ? (needs a look), waiting (cloud), wanted (heart).
// Under the art, a caption: the card's name or what it is waiting for, and
// the wishlist line with the member's name. A card standing for several
// copies (the Copies stepper) leads its caption with ×N, what this tile
// adds. Beside the art's right edge,
// between the top and bottom corners, an x removes the tile in one tap
// (view.js offers Undo), for a card taken by accident.

import {h} from '../dom.js';
import {flagBadge, flagLanguageName} from '../flags.js';
import {blocker, copiesOf, itemFinishChip, needsLook, wishLine} from './session.js';
import {finishOptions} from './finish.js';

const STATUS_TEXT = {
	finishes: 'Loading finishes',
	language: 'Pick the language',
	matching: 'Looking it up…',
	reading: 'Reading…',
	rematch: 'Looking it up…',
	unmatched: 'Not found',
	unsure: 'Needs a look',
	waiting: 'Waiting for signal',
};

const FINISH_WORDS = {'1ST': '1st Edition', FOIL: 'foil pattern', HOLO: 'holo', JUMBO: 'jumbo', MB: 'Master Ball pattern', PB: 'Poké Ball pattern', REV: 'reverse holo', STAMP: 'stamped'};

const cardLine = (card) => (card ? `${card.name}, ${card.setName || card.setId}, ${Number(card.localId) || card.localId} of ${card.official || '?'}` : 'Unknown card');

// info: {quantity, duplicate, marks, photoUrl, progress}. progress is how
// far the read of a card still being read has got, 0 to 1, drawn as a bar
// along the tile's foot.
export function trayTile(item, {marks = [], photoUrl = null, progress = null, quantity = 1} = {}) {
	const reason = blocker(item);
	const look = needsLook(item);
	const waiting = item.status === 'waiting';
	const chip = itemFinishChip(item);
	const wished = wishLine(marks);
	const status = look ? 'look' : waiting ? 'waiting' : marks.length ? 'wanted' : null;
	const option = finishOptions(item.variants).find((entry) => entry.variantId === item.variantId);
	const copies = copiesOf(item);

	const label = [
		cardLine(item.card),
		item.language ? flagLanguageName(item.language) : 'language not set',
		copies > 1 ? `adds ${copies} copies` : null,
		quantity > copies ? `${quantity} copies in all` : null,
		chip ? FINISH_WORDS[chip] || option.label : null,
		reason ? STATUS_TEXT[reason] : null,
		wished,
	].filter(Boolean).join(', ');

	const art = h('span', {class: 'scan-tile-art'},
		photoUrl ? h('img', {alt: '', class: 'scan-tile-photo', decoding: 'async', src: photoUrl}) : h('span', {class: 'scan-tile-blank'}),
		item.language
			? flagBadge([item.language], {className: 'scan-badge scan-badge-tl'})
			: h('span', {'aria-hidden': 'true', class: 'scan-badge scan-badge-tl scan-badge-unknown'}, '?'),
		quantity > copies ? h('span', {'aria-hidden': 'true', class: 'scan-badge scan-badge-tr scan-qty'}, `×${quantity}`) : null,
		chip ? h('span', {'aria-hidden': 'true', class: 'scan-badge scan-badge-bl scan-finish'}, chip) : null,
		status ? h('span', {'aria-hidden': 'true', class: `scan-badge scan-badge-br scan-status-${status}`, title: status}, status === 'look' ? '?' : status === 'waiting' ? '☁' : '♥') : null,
		reason === 'reading' || reason === 'matching' || reason === 'rematch' ? h('span', {'aria-hidden': 'true', class: 'scan-tile-busy'}) : null,
		reason === 'reading' || reason === 'matching'
			? h('span', {'aria-hidden': 'true', class: 'scan-tile-progress'}, h('span', {style: `width: ${Math.round(Math.max(0.08, Math.min(1, reason === 'matching' ? 0.9 : progress || 0)) * 100)}%`}))
			: null
	);

	const caption = reason && reason !== 'finishes' ? STATUS_TEXT[reason] : item.card ? item.card.name : 'Unknown card';

	return h('li', {class: 'scan-tray-item'},
		h('button', {'aria-label': `Remove ${item.card ? item.card.name : 'this scan'}`, class: 'scan-tile-remove', 'data-remove': item.id, title: 'Remove', type: 'button'},
			h('span', {'aria-hidden': 'true'}, '×')),
		h('button', {
			'aria-label': label,
			class: ['scan-tile', look ? 'is-look' : '', waiting ? 'is-waiting' : ''].filter(Boolean).join(' '),
			'data-item': item.id,
			'data-status': reason || 'ready',
			title: label,
			type: 'button',
		},
		art,
		h('span', {class: 'scan-tile-caption'}, copies > 1 ? h('span', {class: 'scan-tile-copies'}, `×${copies}`) : null, caption),
		wished ? h('span', {class: 'scan-tile-wish'}, wished) : null)
	);
}
