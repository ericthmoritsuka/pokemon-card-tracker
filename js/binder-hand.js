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
// the binder without it. The one exception is the reload that switches to a
// new version (js/auto-update.js): keepHandsForSwitch puts the hands in
// sessionStorage just before it, and the next load takes them back once,
// within KEPT_MS, so the binder opens with the card still in hand (the
// history entry, and its handToken, survive a reload).

import {isLive, loadDocument} from './collection.js';
import {addCopiesToListBinder, copyToShow, listLanguagesOf, listTarget, targetText} from './binder-add.js';
import {cardKey, claimIndex, isGenerated} from './binder-rules.js';
import {binderStats, copyClaims, handBinders, liveBinders, placements, sortBinders, stagedOf, undoListAdds} from './binders.js';
import {cardIndex} from './catalog.js';
import {paintCover} from './binder-cover.js';
import {BASE, errorText, go, h, rememberInHistory} from './dom.js';
import {formatCount} from './format.js';
import {openDialogSheet} from './sheet.js';

// The hands kept for the reload that switches versions, and how long the
// next load may take them back.
export const HANDS_KEPT_KEY = 'cardTracker.switchHands';
const KEPT_MS = 60 * 1000;

// The hands the switch kept, once: {hands: [[token, hand]], seq}.
function keptHands() {
	try {
		const kept = JSON.parse(sessionStorage.getItem(HANDS_KEPT_KEY));

		sessionStorage.removeItem(HANDS_KEPT_KEY);

		if (kept && Array.isArray(kept.hands) && Number.isInteger(kept.seq) && Math.abs(Date.now() - kept.at) < KEPT_MS) {
			return kept;
		}
	}
	catch {
		// No sessionStorage, or nothing readable kept.
	}

	return {hands: [], seq: 0};
}

const kept = keptHands();

// token -> {binderId, cardId, catalog}
const hands = new Map(kept.hands);
let pending = null;
let seq = kept.seq;

// Just before the reload that switches versions (js/auto-update.js).
export function keepHandsForSwitch() {
	if (!hands.size) {
		return;
	}

	try {
		sessionStorage.setItem(HANDS_KEPT_KEY, JSON.stringify({at: Date.now(), hands: [...hands], seq}));
	}
	catch {
		// Without sessionStorage there is no automatic switch either.
	}
}

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

// The binders to choose from, each with its cover and how full it is. Also
// My Cards' bulk Add to binder (js/bulk-select.js). noteOf(binder): what
// choosing a binder made from a list will do (js/binder-add.js), shown in
// place of how full it is.
export function binderList({binders, choose, id, liveIds, noteOf = () => null, placed}) {
	return h('ul', {'aria-label': 'Binders', class: 'atb-list', id}, binders.map((binder) => {
		const note = noteOf(binder);
		const stats = note ? null : binderStats(binder, placed, liveIds);

		return h('li', null, h('button', {class: 'atb-binder', 'data-binder': binder.id, 'data-list': isGenerated(binder) ? 'true' : null, onclick: () => choose(binder), type: 'button'},
			coverThumb(binder),
			h('span', {class: 'atb-text'},
				h('span', {class: 'atb-name'}, binder.name),
				h('span', {class: 'atb-fill muted'}, note || `${formatCount(stats.filled)} of ${formatCount(stats.total)} pockets`))
		));
	}));
}

// Words and the toast for copies saved into a list's binder
// (js/binder-add.js addCopiesToListBinder's result).
export function listAddText(binder, result) {
	const shown = result.picks.length ? `${result.picks.length === 1 ? '1 copy shows' : `${result.picks.length} copies show`} in ${binder.name}'s pockets` : '';
	const added = result.adds.length ? `${result.adds.length === 1 ? '1 card' : `${result.adds.length} cards`} added after the list` : '';
	const kept = result.skipped ? `${result.skipped === 1 ? '1 copy stays' : `${result.skipped} copies stay`} where ${result.skipped === 1 ? 'it is' : 'they are'}: one copy per card, and one card per pocket` : '';

	return `${[shown, added, kept].filter(Boolean).join('; ')}.`;
}

// Undo for that toast.
export const listAddUndo = (binder, result, toast) => () => undoListAdds(binder.id, {adds: result.adds, previous: result.previous})
	.catch((err) => toast(`Could not undo. ${errorText(err)}`));

// The sheet on card detail. card: {cardId, catalog, name}. Every binder is
// offered (Eric, 2026-11-24): a hand-made one takes a copy into the hand to
// place, when a copy is not in a pocket yet; a binder made from a list
// shows a copy in the card's pocket there, or adds the card after its list,
// and its row says which before the tap (js/binder-add.js).
export async function openAddToBinder({cardId, catalog, name = 'this card', toast = () => {}}) {
	const id = 'add-binder-sheet';
	const opener = document.activeElement;
	const [doc, index] = await Promise.all([loadDocument(), cardIndex().catch(() => new Map())]);
	const hand = {cardId, catalog};
	const copies = copiesOf(doc.cards, hand);
	const placed = placements(doc.binders);
	const loose = copies.filter((entry) => !placed.has(entry.id));
	const liveIds = new Set((doc.cards || []).filter(isLive).map((entry) => entry.id));
	const all = sortBinders(liveBinders(doc.binders));
	const lists = new Set(all.filter(isGenerated).map((binder) => binder.id));
	// Hand-made binders only while a copy is free to place.
	const binders = all.filter((binder) => lists.has(binder.id) || loose.length);
	const dialog = h('dialog', {'aria-labelledby': `${id}-title`, class: 'sheet add-binder-sheet', id});
	const claims = claimIndex(copyClaims(doc));
	const shownCopy = copies.length ? copyToShow(copies, claims) : null;
	const record = index.get(cardKey(catalog, cardId));
	const targets = new Map(shownCopy ? all.filter((binder) => lists.has(binder.id)).map((binder) => [binder.id, listTarget(binder, {catalog, cardId, dexIds: (record && record.dex_ids) || [], language: shownCopy.language}, {languages: listLanguagesOf(binder, doc)})]) : []);
	let body;

	const choose = (binder) => {
		const target = targets.get(binder.id);

		if (target) {
			dialog.close();
			addCopiesToListBinder(binder.id, [shownCopy]).then((result) => {
				go(`binders/${encodeURIComponent(binder.id)}/${target.page}`);
				toast(listAddText(binder, result), {action: listAddUndo(binder, result, toast), actionLabel: 'Undo', timeout: 8000});
			}, (err) => toast(`Could not add it to ${binder.name}. ${errorText(err)}`));

			return;
		}

		pending = {binderId: binder.id, cardId, catalog};
		dialog.close();
		// In the same click as the close, so the sheet's history entry
		// becomes the binder's and one Back returns to the card.
		go(`binders/${encodeURIComponent(binder.id)}`);
	};
	const where = loose.length ? [] : copies.map((entry) => placed.get(entry.id)).map(({binder, slot}) => `${binder.name}, page ${slot.page}, pocket ${slot.position}`);
	const allPlaced = copies.length && !loose.length
		? [
			h('p', {id: 'add-binder-all-placed'}, copies.length === 1 ? 'Your copy of this card is already in a pocket.' : `All ${copies.length} copies of this card are already in pockets.`),
			h('ul', {class: 'atb-where', id: 'add-binder-where'}, where.map((text) => h('li', null, text))),
		]
		: [];

	if (!copies.length) {
		body = [h('p', {id: 'add-binder-none'}, 'You have no copy of this card to place.')];
	}
	else if (!binders.length) {
		body = [
			...allPlaced,
			h('p', {id: 'add-binder-none'}, allPlaced.length ? 'You have no binder made from a list to show it in.' : 'You have no binders yet.'),
			h('a', {class: 'button', 'data-link': 'binders', href: `${BASE}binders`, onclick: () => dialog.close()}, 'Make a binder'),
		];
	}
	else {
		body = [
			...allPlaced,
			h('p', {class: 'muted', id: 'add-binder-intro'}, lists.size && loose.length
				? `Choose a binder. In one you arrange by hand, you then choose a pocket for ${loose.length === 1 ? 'the copy' : 'one copy'}.`
				: lists.size ? 'Choose a binder made from a list.' : `Choose a binder, then a pocket for ${loose.length === 1 ? 'the copy' : 'one copy'}.`),
			binderList({binders, choose, id: 'add-binder-list', liveIds, noteOf: (binder) => (targets.has(binder.id) ? targetText(targets.get(binder.id)) : null), placed}),
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
		openAddToBinder({cardId, catalog, name, toast}).catch((err) => toast(`Add to binder did not open. ${errorText(err)}`));
	}, type: 'button'}, 'Add to binder');
}
