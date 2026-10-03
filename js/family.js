// The family group as the app shell and the views see it: the other members
// and their names. Online, the server's group overview (js/sync.js); offline,
// the members saved on this phone with their wishlists (js/wishlist.js), so
// the header switcher and the view-only strip still work in a shop.

//
// It also keeps what the family screens share: each member's favorite
// Pokémon for the switcher (only that field is read, js/sync.js
// memberFavorites), and a member's document for a minute, so Sets, a set,
// and a card opened in turn while viewing them read it once.

import {currentUser, onUser} from './auth.js';
import {validDex} from './settings.js';
import {familyOverview, memberDocument, memberFavorites} from './sync.js';
import {cachedFamilyWishlists} from './wishlist.js';

const FAVORITES_KEY = 'card-tracker-member-favorites';
const DOC_FOR_MS = 60 * 1000;

export const memberName = (member) =>
	(member && (member.display_name || member.name || (member.email ? member.email.split('@')[0] : null))) || 'Family member';

// The other members of the signed-in person's group, as [{name, user_id}].
// Empty signed out, alone in a group, or with nothing saved offline.
export async function familyMembers() {
	const me = currentUser();

	if (!me) {
		return [];
	}

	const fromCache = async () => {
		try {
			const {members} = await cachedFamilyWishlists();

			return (members || []).filter((member) => member.user_id !== me.id).map((member) => ({name: memberName(member), user_id: member.user_id}));
		}
		catch {
			return [];
		}
	};

	if (!navigator.onLine) {
		return fromCache();
	}

	try {
		const overview = await familyOverview();

		return ((overview && overview.members) || [])
			.filter((member) => member.user_id !== me.id)
			.map((member) => ({name: memberName(member), user_id: member.user_id}));
	}
	catch {
		return fromCache();
	}
}

// Calls onName with a member's name once it is known. Nothing happens when
// the member is not found.
export function whenMemberName(userId, onName) {
	familyMembers().then((members) => {
		const member = members.find((item) => item.user_id === userId);

		if (member) {
			onName(member.name);
		}
	}).catch(() => {});
}

// ------------------------------------------------------- favorites

let favoritesPromise = null;

function savedFavorites() {
	try {
		const saved = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '{}');

		return saved && typeof saved === 'object' ? saved : {};
	}
	catch {
		return {};
	}
}

function keepFavorites(map) {
	try {
		localStorage.setItem(FAVORITES_KEY, JSON.stringify({...savedFavorites(), ...Object.fromEntries(map)}));
	}
	catch {
		// Read again next visit.
	}
}

// The favorite Pokémon saved on this phone for each member, as Map
// user_id -> dex number or null: what the switcher draws at once, and
// offline.
export function knownFavorites(userIds) {
	const saved = savedFavorites();

	return new Map(userIds.map((id) => [id, validDex(Number(saved[id])) ? Number(saved[id]) : null]));
}

// The members' favorite Pokémon from the server, read once a visit (and
// kept on the phone), as Map user_id -> dex number or null. Offline or on a
// failure, what the phone saved last time.
export function familyFavorites(userIds) {
	if (!userIds.length || !currentUser()) {
		return Promise.resolve(new Map());
	}

	if (!navigator.onLine) {
		return Promise.resolve(knownFavorites(userIds));
	}

	const asked = favoritesPromise && userIds.every((id) => favoritesPromise.ids.has(id));

	if (!asked) {
		const promise = memberFavorites(userIds).then((found) => {
			const favorites = new Map(userIds.map((id) => {
				const n = Number(found.get(id));

				return [id, validDex(n) ? n : null];
			}));

			keepFavorites(favorites);

			return favorites;
		}).catch(() => {
			if (favoritesPromise === promise) {
				favoritesPromise = null;
			}

			return knownFavorites(userIds);
		});

		promise.ids = new Set(userIds);
		favoritesPromise = promise;
	}

	return favoritesPromise;
}

// ------------------------------------------------- a member's document

const memberDocs = new Map();

// A family member's document, read only, kept a minute. Throws with words
// for the screen when signed out or offline.
export function memberDocumentKept(userId) {
	if (!currentUser()) {
		return Promise.reject(new Error('Sign in to see your family\'s cards.'));
	}

	if (!navigator.onLine) {
		return Promise.reject(new Error('A family member\'s cards show when you are online.'));
	}

	const hit = memberDocs.get(userId);

	if (hit && Date.now() - hit.at < DOC_FOR_MS) {
		return hit.promise;
	}

	const promise = memberDocument(userId).then((doc) => doc || {}).catch((err) => {
		memberDocs.delete(userId);

		throw err;
	});

	memberDocs.set(userId, {at: Date.now(), promise});

	return promise;
}

// A family member's live copies.
export async function memberCards(userId) {
	const doc = await memberDocumentKept(userId);

	return (Array.isArray(doc.cards) ? doc.cards : []).filter((entry) => entry && !entry.deleted_at);
}

onUser(() => {
	favoritesPromise = null;
	memberDocs.clear();
});
