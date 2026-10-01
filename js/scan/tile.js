// One tray tile: the card's photo with the four badge corners of the design
// review's badge system (plans/design-review.md, "Badge System"): language
// flag top left (always, in the tray), quantity top right from ×2, finish
// bottom left when it is not the plain print, and one status bottom right,
// first match wins: ? (needs a look), waiting (cloud), wanted (heart).
// Under the art, a caption: the card's name or what it is waiting for, and
// the wishlist line with the member's name.

import {h} from '../dom.js';
import {flagBadge, flagLanguageName} from '../flags.js';
import {blocker, itemFinishChip, needsLook, wishLine} from './session.js';
import {finishOptions} from './finish.js';

const STATUS_TEXT = {
	finishes: 'Loading finishes',
	language: 'Pick the language',
	matching: 'Looking it up',
	reading: 'Reading',
	rematch: 'Looking it up',
	unmatched: 'Not found',
	unsure: 'Needs a look',
	waiting: 'Waiting for signal',
};

const FINISH_WORDS = {'1ST': '1st Edition', FOIL: 'foil pattern', HOLO: 'holo', JUMBO: 'jumbo', MB: 'Master Ball pattern', PB: 'Poké Ball pattern', REV: 'reverse holo', STAMP: 'stamped'};

const cardLine = (card) => (card ? `${card.name}, ${card.setName || card.setId}, ${Number(card.localId) || card.localId} of ${card.official || '?'}` : 'Unknown card');

// info: {quantity, duplicate, marks, photoUrl}.
export function trayTile(item, {marks = [], photoUrl = null, quantity = 1} = {}) {
	const reason = blocker(item);
	const look = needsLook(item);
	const waiting = item.status === 'waiting';
	const chip = itemFinishChip(item);
	const wished = wishLine(marks);
	const status = look ? 'look' : waiting ? 'waiting' : marks.length ? 'wanted' : null;
	const option = finishOptions(item.variants).find((entry) => entry.variantId === item.variantId);

	const label = [
		cardLine(item.card),
		item.language ? flagLanguageName(item.language) : 'language not set',
		quantity > 1 ? `${quantity} copies` : null,
		chip ? FINISH_WORDS[chip] || option.label : null,
		reason ? STATUS_TEXT[reason] : null,
		wished,
	].filter(Boolean).join(', ');

	const art = h('span', {class: 'scan-tile-art'},
		photoUrl ? h('img', {alt: '', class: 'scan-tile-photo', decoding: 'async', src: photoUrl}) : h('span', {class: 'scan-tile-blank'}),
		item.language
			? flagBadge([item.language], {className: 'scan-badge scan-badge-tl'})
			: h('span', {'aria-hidden': 'true', class: 'scan-badge scan-badge-tl scan-badge-unknown'}, '?'),
		quantity > 1 ? h('span', {'aria-hidden': 'true', class: 'scan-badge scan-badge-tr scan-qty'}, `×${quantity}`) : null,
		chip ? h('span', {'aria-hidden': 'true', class: 'scan-badge scan-badge-bl scan-finish'}, chip) : null,
		status ? h('span', {'aria-hidden': 'true', class: `scan-badge scan-badge-br scan-status-${status}`, title: status}, status === 'look' ? '?' : status === 'waiting' ? '☁' : '♥') : null,
		reason === 'reading' || reason === 'matching' || reason === 'rematch' ? h('span', {'aria-hidden': 'true', class: 'scan-tile-busy'}) : null
	);

	const caption = reason && reason !== 'finishes' ? STATUS_TEXT[reason] : item.card ? item.card.name : 'Unknown card';

	return h('li', {class: 'scan-tray-item'},
		h('button', {
			'aria-label': label,
			class: ['scan-tile', look ? 'is-look' : '', waiting ? 'is-waiting' : ''].filter(Boolean).join(' '),
			'data-item': item.id,
			'data-status': reason || 'ready',
			title: label,
			type: 'button',
		},
		art,
		h('span', {class: 'scan-tile-caption'}, caption),
		wished ? h('span', {class: 'scan-tile-wish'}, wished) : null)
	);
}
