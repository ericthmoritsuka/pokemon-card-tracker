// The family group as the app shell and the views see it: the other members
// and their names. Online, the server's group overview (js/sync.js); offline,
// the members saved on this phone with their wishlists (js/wishlist.js), so
// the header switcher and the view-only strip still work in a shop.

import {currentUser} from './auth.js';
import {familyOverview} from './sync.js';
import {cachedFamilyWishlists} from './wishlist.js';

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
