// Whether the signed-in person owns the Shop: the family group's owner, the
// one person supabase/store.sql private.is_store_owner lets publish to
// HOTARU and read its orders. Only they see Shop in the header (js/shell.js),
// and anyone else who opens the shop address sees a short notice
// (js/shop-view.js shopScreen). Eric, 2026-11-24: the Shop makes no sense to
// the rest of the family.
//
// The answer comes from the group overview (js/sync.js familyOverview) and
// is kept on the phone per account, so the header shows Shop at once on the
// next visit and with no signal. The server still decides every write: a
// stale answer here can only show or hide a link.

import {currentUser} from './auth.js';
import {familyOverview} from './sync.js';

const KEY = 'cardTracker.shopOwner';

function readKept() {
	try {
		const kept = JSON.parse(localStorage.getItem(KEY));

		return kept && typeof kept === 'object' && !Array.isArray(kept) ? kept : {};
	}
	catch {
		return {};
	}
}

// Told each answer as it comes, so a screen drawn before it (the Shop opened
// from its address while the session was still coming back) shows what is
// the owner's once it is known.
const listeners = new Set();

export function onShopOwner(listener) {
	listeners.add(listener);

	return () => listeners.delete(listener);
}

function keep(userId, owner) {
	try {
		localStorage.setItem(KEY, JSON.stringify({...readKept(), [userId]: owner}));
	}
	catch {
		// Not kept; the next visit asks the server again.
	}

	for (const listener of [...listeners]) {
		listener(owner);
	}
}

// true or false as last read for the signed-in person, or null when it was
// never read on this phone or nobody is signed in.
export function shopOwnerKnown() {
	const user = currentUser();

	if (!user) {
		return null;
	}

	const owner = readKept()[user.id];

	return typeof owner === 'boolean' ? owner : null;
}

// Asks the server (once a visit, js/sync.js caches the overview) and keeps
// the answer. Resolves true or false, or the kept answer, or null, when the
// server cannot be reached.
export async function checkShopOwner() {
	const user = currentUser();

	if (!user) {
		return null;
	}

	try {
		const overview = await familyOverview();

		if (currentUser() !== user) {
			return shopOwnerKnown();
		}

		// No group yet is not an answer: the first sign-in makes the family
		// group (js/sync.js claim) after this may have asked, and the header
		// asks again once synced.
		if (!overview || !overview.role) {
			return shopOwnerKnown();
		}

		const owner = overview.role === 'owner';

		keep(user.id, owner);

		return owner;
	}
	catch {
		return shopOwnerKnown();
	}
}

// Add and sell (plans/hotaru-for-sale-plan.md, section 5): the Shop's
// button sends the owner to find a card, and the next Add a copy sheet
// opens with For sale on HOTARU ticked. Kept on this tab only, and dropped
// once a copy is added that way or the Shop is opened again.
const ADD_AND_SELL_KEY = 'cardTracker.addAndSell';

export function wantsAddAndSell() {
	try {
		return sessionStorage.getItem(ADD_AND_SELL_KEY) === '1';
	}
	catch {
		return false;
	}
}

export function setAddAndSell(on) {
	try {
		if (on) {
			sessionStorage.setItem(ADD_AND_SELL_KEY, '1');
		}
		else {
			sessionStorage.removeItem(ADD_AND_SELL_KEY);
		}
	}
	catch {
		// Not kept: the sheet opens unticked, and the box is still there.
	}
}

// Consign a card (plans/hotaru-consignment-plan.md; Eric, 2026-11-26: picking
// the card should take him straight back to consigning): the Consign tab's
// button sends the owner to find a card, and the next card page opens its
// Consign sheet by itself; saving it goes back to the Consign tab. Kept on
// this tab only, and dropped once a card is consigned that way or the Shop
// is opened again.
const CONSIGN_PICK_KEY = 'cardTracker.consignPick';

export function wantsConsignPick() {
	try {
		return sessionStorage.getItem(CONSIGN_PICK_KEY) === '1';
	}
	catch {
		return false;
	}
}

export function setConsignPick(on) {
	try {
		if (on) {
			sessionStorage.setItem(CONSIGN_PICK_KEY, '1');
		}
		else {
			sessionStorage.removeItem(CONSIGN_PICK_KEY);
		}
	}
	catch {
		// Not kept: the card page shows its Consign button as usual.
	}
}

// The Shop's tab (Eric, 2026-11-26: one part to price the cards, one for
// kits, one for the orders, and one for consigned cards): 'prices', 'kits',
// 'orders', or 'consign', kept on this tab so the Shop opens where it was
// left. A new order's alert, and the
// header's bag while orders are open, set 'orders' before opening it.
const TAB_KEY = 'cardTracker.shopTab';

export const SHOP_TABS = ['prices', 'kits', 'orders', 'consign'];

export function shopTab() {
	try {
		const tab = sessionStorage.getItem(TAB_KEY);

		return SHOP_TABS.includes(tab) ? tab : 'prices';
	}
	catch {
		return 'prices';
	}
}

export function setShopTab(tab) {
	if (!SHOP_TABS.includes(tab)) {
		return;
	}

	try {
		sessionStorage.setItem(TAB_KEY, tab);
	}
	catch {
		// Not kept: the Shop opens on Prices.
	}
}
