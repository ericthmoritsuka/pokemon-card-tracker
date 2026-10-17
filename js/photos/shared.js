// Family members' photos for cards with no image of their own (js/photos/
// model.js, "Shared family photos"). Only the members' photo_index lists
// are read from the server (js/sync.js memberPhotoIndexes), never their
// documents, and kept on the phone for offline, per signed-in account. The
// photos themselves come through the photo store (store.js photoUrl), which
// keeps them on the phone like the person's own; supabase/photos.sql lets
// the group read each other's photos.
//
//   startSharedPhotos()        loads the saved indexes, refreshes them now
//                              and every so often; safe to call often
//   sharedPhotosFor(card)      [{name, photo, user_id}] for a card, at once
//   sharedReady()              resolves once the saved indexes are loaded
//   sharedSettled()            resolves once a refresh on its way is done
//   onSharedPhotosChange(fn)   fn() after the indexes change

import {currentUser, onUser} from '../auth.js';
import {familyMembers} from '../family.js';
import {database, timedCache} from '../idb.js';
import {memberPhotoIndexes} from '../sync.js';

import {familyPhotos} from './model.js';

const REFRESH_AFTER_MS = 10 * 60 * 1000;
const CHECK_EVERY_MS = 5 * 60 * 1000;

const cache = timedCache(database('card-tracker-family-photos', ['cache']), 'cache');
const cacheKey = (userId) => `family:${userId}`;

const listeners = new Set();

let members = [];
let savedAt = 0;
let ready = null;
let readyFor = null;
let refreshing = null;
let started = false;

const online = () => typeof navigator === 'undefined' || navigator.onLine !== false;

const notify = () => listeners.forEach((listener) => {
	try {
		listener();
	}
	catch {
		// A view that went away.
	}
});

// Live entries with photos only: tombstones are of no use to another phone.
const slim = (index) => (Array.isArray(index) ? index : [])
	.filter((item) => item && !item.deleted_at && item.card_id && Array.isArray(item.photos) && item.photos.length)
	.map(({card_id, catalog, id, language, photos}) => ({card_id, catalog, id, language, photos}));

// Loads what this phone saved for the signed-in account.
function load() {
	const user = currentUser();
	const id = user ? user.id : null;

	if (!ready || readyFor !== id) {
		readyFor = id;
		members = [];
		savedAt = 0;
		ready = (async () => {
			if (!id) {
				return;
			}

			const hit = await cache.get(cacheKey(id));

			if (hit && readyFor === id && Array.isArray(hit.data)) {
				members = hit.data;
				savedAt = hit.at || 0;
				notify();
			}
		})().catch(() => {});
	}

	return ready;
}

// Reads the members' indexes from the server and saves them. Keeps what
// was there when offline, signed out, or on a failure.
export function refreshSharedPhotos() {
	if (!refreshing) {
		refreshing = (async () => {
			await load();

			const user = currentUser();

			if (!user || !online()) {
				return;
			}

			const others = await familyMembers();
			const found = others.length ? await memberPhotoIndexes(others.map((member) => member.user_id)) : new Map();

			if (!currentUser() || currentUser().id !== user.id) {
				return;
			}

			members = others.map((member) => ({index: slim(found.get(member.user_id)), name: member.name, user_id: member.user_id}));
			savedAt = Date.now();
			await cache.put(cacheKey(user.id), members);
			notify();
		})().catch(() => {}).finally(() => {
			refreshing = null;
		});
	}

	return refreshing;
}

const refreshIfOld = () => load().then(() => {
	if (online() && currentUser() && Date.now() - savedAt > REFRESH_AFTER_MS) {
		return refreshSharedPhotos();
	}

	return null;
});

export function startSharedPhotos() {
	if (started) {
		return;
	}

	started = true;
	refreshSharedPhotos();
	window.addEventListener('online', () => refreshIfOld());
	onUser(() => {
		load();
		notify();
		refreshSharedPhotos();
	});
	setInterval(() => refreshIfOld(), CHECK_EVERY_MS);
}

export const sharedReady = () => load();

// Resolves once a refresh on its way has finished (at once when none is).
export const sharedSettled = () => refreshing || Promise.resolve();

// A family member's photos of the card ({catalog, card_id, language}), the
// same language first, from what is loaded now.
export const sharedPhotosFor = (card) => (currentUser() ? familyPhotos(members, card) : []);

export function onSharedPhotosChange(listener) {
	listeners.add(listener);

	return () => listeners.delete(listener);
}
