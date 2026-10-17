// Add to binder from a card's page (plans/roadmap.md, Eric 2026-10-16): the
// sheet card detail opens (js/catalog-views.js), and the card "in hand" it
// hands to the binder screen (js/binders-view.js), which draws the bar at the
// bottom and places the card.
//
// The sheet lists the person's hand-made binders (a binder made from a list
// places nothing, js/binder-rules.js) with their cover and how full they
// are. Choosing one opens it with the card in hand. When every copy of the
// card is already in a pocket, the sheet says so and lists none.
//
// The hand travels with the binder's history entry (history.state
// handToken), so a page zoomed and closed again keeps it, and Back off the
// binder leaves it behind. It lives for the page load only: a reload opens
// the binder without it.

import {isLive, loadDocument} from './collection.js';
import {binderStats, handBinders, placements, sortBinders, stagedOf} from './binders.js';
import {paintCover} from './binder-cover.js';
import {BASE, errorText, go, h, rememberInHistory} from './dom.js';
import {formatCount} from './format.js';
import {openDialogSheet} from './sheet.js';

// token -> {binderId, cardId, catalog}
const hands = new Map();
let pending = null;
let seq = 0;

const catalogOf = (entry) => entry.catalog || 'international';

// The live copies of the card: {cardId, catalog}, any language.
export const copiesOf = (cards, hand) => (cards || []).filter((entry) => isLive(entry) && entry.card_id === hand.cardId && catalogOf(entry) === hand.catalog);

// The copy of the card to move next, or null when every copy is in a pocket.
// For a pocket: one already in this binder's tray, then one in no tray, then
// one in another binder's tray. For the tray (toTray): one in no tray, then
// one in another binder's tray, never one this tray holds already.
export function handCopy(binders, cards, hand, binderId, {toTray = false} = {}) {
	const placed = placements(binders);
	const trayOfEntry = new Map();

	for (const binder of handBinders(binders)) {
		for (const id of stagedOf(binder)) {
			trayOfEntry.set(id, binder.id);
		}
	}

	const loose = copiesOf(cards, hand).filter((entry) => !placed.has(entry.id));
	const rank = (entry) => {
		const tray = trayOfEntry.get(entry.id);

		if (tray === binderId) {
			return toTray ? null : 0;
		}

		return tray ? 2 : 1;
	};
	const ranked = loose.map((entry) => ({entry, rank: rank(entry)})).filter((item) => item.rank !== null).sort((a, b) => a.rank - b.rank);

	return ranked.length ? {entry: ranked[0].entry, trayId: trayOfEntry.get(ranked[0].entry.id) || null} : null;
}

// For the binder screen as it opens: the card in hand for this binder,
// {token, binderId, cardId, catalog}, or null.
export function takeHand(binderId) {
	if (pending && pending.binderId === binderId) {
		const token = `hand-${++seq}`;

		hands.set(token, pending);
		pending = null;
		rememberInHistory({handToken: token});
	}

	const token = history.state && history.state.handToken;
	const hand = token ? hands.get(token) : null;

	return hand && hand.binderId === binderId ? {...hand, token} : null;
}

// The card is placed, kept in the tray, or put down: Back to this entry
// does not pick it up again.
export function dropHand(token) {
	hands.delete(token);
}

function coverThumb(binder) {
	const node = h('span', {'aria-hidden': 'true', class: 'atb-thumb'});

	paintCover(node, binder).catch(() => {
		// The cover color shows instead.
	});

	return node;
}

// The sheet on card detail. card: {cardId, catalog, name}.
export async function openAddToBinder({cardId, catalog, name = 'this card'}) {
	const id = 'add-binder-sheet';
	const opener = document.activeElement;
	const doc = await loadDocument();
	const hand = {cardId, catalog};
	const copies = copiesOf(doc.cards, hand);
	const placed = placements(doc.binders);
	const loose = copies.filter((entry) => !placed.has(entry.id));
	const liveIds = new Set((doc.cards || []).filter(isLive).map((entry) => entry.id));
	const binders = sortBinders(handBinders(doc.binders));
	const dialog = h('dialog', {'aria-labelledby': `${id}-title`, class: 'sheet add-binder-sheet', id});
	let body;

	const choose = (binder) => {
		pending = {binderId: binder.id, cardId, catalog};
		dialog.close();
		// In the same click as the close, so the sheet's history entry
		// becomes the binder's and one Back returns to the card.
		go(`binders/${encodeURIComponent(binder.id)}`);
	};

	if (!copies.length) {
		body = [h('p', {id: 'add-binder-none'}, 'You have no copy of this card to place.')];
	}
	else if (!loose.length) {
		const where = copies.map((entry) => placed.get(entry.id)).map(({binder, slot}) => `${binder.name}, page ${slot.page}, pocket ${slot.position}`);

		body = [
			h('p', {id: 'add-binder-all-placed'}, copies.length === 1 ? 'Your copy of this card is already in a pocket.' : `All ${copies.length} copies of this card are already in pockets.`),
			h('ul', {class: 'atb-where', id: 'add-binder-where'}, where.map((text) => h('li', null, text))),
		];
	}
	else if (!binders.length) {
		body = [
			h('p', {id: 'add-binder-none'}, 'You have no binders to arrange by hand yet.'),
			h('a', {class: 'button', 'data-link': 'binders', href: `${BASE}binders`, onclick: () => dialog.close()}, 'Make a binder'),
		];
	}
	else {
		body = [
			h('p', {class: 'muted'}, `Choose a binder, then a pocket for ${loose.length === 1 ? 'the copy' : 'one copy'}. Binders made from a list are not shown.`),
			h('ul', {'aria-label': 'Binders', class: 'atb-list', id: 'add-binder-list'}, binders.map((binder) => {
				const stats = binderStats(binder, placed, liveIds);

				return h('li', null, h('button', {class: 'atb-binder', 'data-binder': binder.id, onclick: () => choose(binder), type: 'button'},
					coverThumb(binder),
					h('span', {class: 'atb-text'},
						h('span', {class: 'atb-name'}, binder.name),
						h('span', {class: 'atb-fill muted'}, `${formatCount(stats.filled)} of ${formatCount(stats.total)} pockets`))
				));
			})),
		];
	}

	dialog.append(
		h('div', {class: 'sheet-head'},
			h('h2', {id: `${id}-title`}, 'Add to binder'),
			h('button', {class: 'small', id: 'add-binder-close', onclick: () => dialog.close(), type: 'button'}, 'Close')
		),
		h('p', {class: 'muted', id: 'add-binder-card'}, name),
		...body
	);
	dialog.addEventListener('click', (event) => {
		if (event.target === dialog) {
			dialog.close();
		}
	});
	dialog.addEventListener('close', () => {
		dialog.remove();

		if (opener && opener.isConnected && typeof opener.focus === 'function' && !pending) {
			opener.focus();
		}
	});
	document.getElementById(id)?.remove();
	document.body.append(dialog);
	openDialogSheet(dialog);

	return dialog;
}

// For card detail's button: opens the sheet, or says why it did not.
export function addToBinderButton({cardId, catalog, name, toast}) {
	return h('button', {'aria-haspopup': 'dialog', class: 'small atb-open', id: 'copies-binder', onclick: () => {
		openAddToBinder({cardId, catalog, name}).catch((err) => toast(`Add to binder did not open. ${errorText(err)}`));
	}, type: 'button'}, 'Add to binder');
}
