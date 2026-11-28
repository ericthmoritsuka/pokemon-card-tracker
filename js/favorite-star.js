// The favorite star on a card's heading in Check spares (v129) and on each
// Prices row in the Shop (Eric, 2026-11-27: pull a card from sale where he
// prices it). One control and one helper, so the two screens star, unstar,
// word the toast, and undo the same way.
//
// A favorite is never a spare (js/wishlist.js favoriteCards), so starring
// keeps every copy of the card in every language and finish. The listing
// guard (js/listing-guard.js) withdraws any listed copy from HOTARU at once,
// so this module makes no store call. A copy marked For sale beats the star
// (markedForSale), so the toast says when a copy stays on sale.
//
// The screen passes its own toast (the Shop's carries a key, so only its
// latest shows; shell.js is not imported here because it reaches the Shop).

import {updateCards} from './collection.js';
import {errorText, h} from './dom.js';
import {favoriteKey, markedForSale} from './wishlist.js';

export const STAR_UNDO_MS = 8000;

// One undoable change to copies, with its toast. onSaved runs once the
// change is saved, before the toast, and onUndone once Undo has put it
// back, for a screen that does not redraw on its own saves; the result says
// whether it was saved.
export async function patchCopies(patches, undo, text, {onSaved = null, onUndone = null, toast}) {
	if (!patches.length) {
		return false;
	}

	try {
		await updateCards(patches);
	}
	catch (err) {
		toast(`Not saved. ${errorText(err)}`);

		return false;
	}

	if (onSaved) {
		onSaved();
	}

	toast(text, {
		action: () => updateCards(undo).then(() => onUndone && onUndone()).catch((err) => toast(`Not undone. ${errorText(err)}`)),
		actionLabel: 'Undo',
		timeout: STAR_UNDO_MS,
	});

	return true;
}

// The star button for one card.
//   entry   one copy of the card, which names it (favoriteKey)
//   copies  the copies starring marks, as a list or a function returning one
//   cards   every copy in the document, as a list or a function returning
//           one, for unstarring: the star covers every language
//   label   the button's name, which does not change with the state
//   name    the card's name, for the toast
//   on      whether the card is a favorite now
export function favoriteStar({cards, copies, entry, label, name, on, onSaved = null, onUndone = null, toast}) {
	const button = h('button', {'aria-label': label, 'aria-pressed': String(on), class: 'small check-star favorite-toggle', title: on ? 'Remove from favorites' : 'Mark as a favorite (never a spare)', type: 'button'}, on ? '★' : '☆');

	button.onclick = async () => {
		const key = favoriteKey(entry);
		const every = (await (typeof cards === 'function' ? cards() : cards)) || [];
		const marked = (await (typeof copies === 'function' ? copies() : copies)) || [];
		const entries = on ? every.filter((one) => one && !one.deleted_at && favoriteKey(one) === key) : marked;
		const patches = entries.filter((one) => (one.is_favorite === true) !== !on).map((one) => ({id: one.id, patch: {is_favorite: !on}}));
		const undo = patches.map(({id}) => ({id, patch: {is_favorite: entries.find((one) => one.id === id).is_favorite ?? null}}));
		const stays = !on && entries.some(markedForSale);

		await patchCopies(patches, undo, on
			? `${name} is no longer a favorite.`
			: `${name} is a favorite: no copy is a spare.${stays ? ' Copies marked For sale stay on sale.' : ''}`, {onSaved, onUndone, toast});
	};

	return button;
}
