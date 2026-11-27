// Publishing the Shop's priced spares to the HOTARU catalog (plans/
// hotaru-catalog-plan.md, step 2): the calls to Supabase that
// js/shop-view.js makes. store_sync (supabase/store.sql) takes the whole set
// of spare copies that should be for sale and withdraws the rest; a card's
// picture is copied once into the public store bucket, read from TCGdex
// through the project's relay (supabase/functions/tcgdex-image), because a
// browser cannot read TCGdex's pictures itself (js/photos/save.js).

import {getClient} from './auth.js';
import {cardImage} from './catalog.js';
import {kitNamesHolding} from './kits.js';
import {PROBLEM_TEXT} from './listing-invariant.js';
import {relayRead} from './photos/save.js';
import {photoUrl} from './photos/store.js';

export const STORE_BUCKET = 'store';

// Why publishing did not happen, said on the Shop screen. A PostgREST code
// or a Postgres one, from supabase-js's error.
export function publishErrorText(error) {
	const code = error && error.code;
	const message = String((error && error.message) || '');

	if (code === '42501' || /shop owner/i.test(message)) {
		return 'Only the shop owner can publish to HOTARU.';
	}

	if (code === 'PGRST202' || code === '42883' || /store_sync/.test(message)) {
		return 'Publishing is not set up for this version yet: run supabase/store-hardening.sql in the Supabase SQL Editor.';
	}

	return `Not published. ${message || 'The server did not answer.'}`;
}

// Calls store_sync with the rows (js/shop.js listingRows). relist: whether
// a withdrawn listing among them may go back on sale, which only Publish
// changes asks for (v128 review H2; supabase/store-hardening.sql, version
// 3). The automatic path sends false, so it can never revive a listing.
// Resolves to {<id>: {status, image_path}}; throws supabase-js's error.
export async function syncListings(rows, {relist = false} = {}) {
	const client = await getClient();
	const {data, error} = await client.rpc('store_sync', {listings: rows, relist: relist === true});

	if (error) {
		throw error;
	}

	return data || {};
}

// What HOTARU holds for each copy id: {<id>: 'available' | 'reserved' |
// 'gone'} (listing_status, supabase/store-orders.sql, 100 ids a call). The
// Shop reads it to tell a copy already live, whose price change and
// withdrawal sync by themselves, from a new one, which only Publish changes
// lists. Throws supabase-js's error, so a caller that cannot tell changes
// nothing.
export async function listingStatus(ids, {chunk = 100} = {}) {
	const list = [...new Set(ids || [])];
	const out = {};

	if (!list.length) {
		return out;
	}

	const client = await getClient();

	for (let start = 0; start < list.length; start += chunk) {
		const {data, error} = await client.rpc('listing_status', {ids: list.slice(start, start + chunk)});

		if (error) {
			throw error;
		}

		Object.assign(out, data || {});
	}

	return out;
}

// The copies store_sync refused to publish (supabase/store-hardening.sql,
// the listing invariant's server half): its answer's "_skipped" list, as
// [{id, reason}], reason 'missing', 'held', or 'last'. Empty when the key is
// absent (nothing skipped, or an older store_sync). The words are
// js/listing-invariant.js PROBLEM_TEXT's.
export const SERVER_SKIP_TEXT = PROBLEM_TEXT;

export function serverSkipped(states) {
	const list = states && Array.isArray(states._skipped) ? states._skipped : [];

	return list.filter((one) => one && typeof one.id === 'string' && SERVER_SKIP_TEXT[one.reason]);
}

// Copies one card picture into the bucket at path (js/shop.js
// storePicturePath). base is the TCGdex picture address without a size.
// Resolves true once it is there, false when the picture could not be read
// (TCGdex has none, the relay is not deployed, or the phone is offline).
export async function uploadPicture(base, path, {read = relayRead} = {}) {
	const blob = await read(cardImage(base, 'high'));

	if (!blob) {
		return false;
	}

	const client = await getClient();
	const {error} = await client.storage.from(STORE_BUCKET).upload(path, blob, {
		cacheControl: '31536000',
		contentType: blob.type || 'image/webp',
		upsert: true,
	});

	return !error;
}

// Takes a favorite card off HOTARU the moment it is starred (Eric,
// 2026-11-24): store_withdraw (supabase/store-withdraw.sql) withdraws the
// available listings among ids, the copies' IDs, and leaves a reserved or
// sold one alone. Resolves to the IDs withdrawn; throws supabase-js's error.
export async function withdrawListings(ids) {
	if (!ids || !ids.length) {
		return [];
	}

	const client = await getClient();
	const {data, error} = await client.rpc('store_withdraw', {ids: [...ids].slice(0, 2000)});

	if (error) {
		throw error;
	}

	return data || [];
}

// The names of the kits that are on and hold any of the copies ids
// (plans/hotaru-bundles-plan.md sections 6 and 7), for the owner's card
// page: store_bundles_admin (supabase/store-bundles.sql). An empty list when
// there are none, and when the kits cannot be read (offline, not the owner,
// or the script not run), since this only explains what happened.
export async function kitNamesFor(ids) {
	if (!ids || !ids.length) {
		return [];
	}

	try {
		const client = await getClient();
		const {data, error} = await client.rpc('store_bundles_admin');

		return error ? [] : kitNamesHolding(Array.isArray(data) ? data : [], ids);
	}
	catch {
		return [];
	}
}

// What the card page says when the withdrawal did not happen. Before
// store-withdraw.sql is run (PostgREST's PGRST202, or Postgres' 42883),
// and offline, the Shop's next publish still withdraws the card, since it
// is no longer a spare (js/wishlist.js favoriteCards).
export function withdrawNoticeText(error) {
	const code = error && error.code;
	const message = String((error && error.message) || '');

	if (code === 'PGRST202' || code === '42883' || /store_withdraw/.test(message)) {
		return 'Starred. It leaves HOTARU the next time you open the Shop online.';
	}

	if (code === '42501' || /shop owner/i.test(message)) {
		return 'Starred. Only the shop owner can take it off HOTARU.';
	}

	return `Starred, but it could not be taken off HOTARU yet. It leaves the next time you open the Shop online. ${message}`.trim();
}

// Copies one of the owner's own card photos into the bucket at path
// (js/shop.js ownPicturePath), for a card the catalog has no picture for.
// The photo is read as card tiles read it: from this phone, else from the
// card-photos bucket (js/photos/store.js photoUrl). Resolves true once it is
// there, false when the photo could not be read or the bucket refused it
// (supabase/store-own-pictures.sql not run yet).
export async function uploadOwnPicture(photo, path, {url = photoUrl} = {}) {
	const objectUrl = await url(photo);

	if (!objectUrl) {
		return false;
	}

	// A read that fails, or brings nothing, is no photo: nothing is sent, and
	// the listing stays without a picture, as for a photo not found.
	const response = await fetch(objectUrl).catch(() => null);

	if (!response || !response.ok) {
		return false;
	}

	const blob = await response.blob();

	if (!blob.size) {
		return false;
	}

	const client = await getClient();
	const {error} = await client.storage.from(STORE_BUCKET).upload(path, blob, {
		cacheControl: '31536000',
		contentType: blob.type || (path.endsWith('.jpg') ? 'image/jpeg' : 'image/webp'),
		upsert: true,
	});

	return !error;
}
