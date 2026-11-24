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

function keep(userId, owner) {
	try {
		localStorage.setItem(KEY, JSON.stringify({...readKept(), [userId]: owner}));
	}
	catch {
		// Not kept; the next visit asks the server again.
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
