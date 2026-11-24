// Publishing the Shop's priced spares to the HOTARU catalog (plans/
// hotaru-catalog-plan.md, step 2): the calls to Supabase that
// js/shop-view.js makes. store_sync (supabase/store.sql) takes the whole set
// of spare copies that should be for sale and withdraws the rest; a card's
// picture is copied once into the public store bucket, read from TCGdex
// through the project's relay (supabase/functions/tcgdex-image), because a
// browser cannot read TCGdex's pictures itself (js/photos/save.js).

import {getClient} from './auth.js';
import {cardImage} from './catalog.js';
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
		return 'Publishing is not set up yet: run supabase/store.sql in the Supabase SQL Editor.';
	}

	return `Not published. ${message || 'The server did not answer.'}`;
}

// Calls store_sync with the rows (js/shop.js listingRows). Resolves to
// {<id>: {status, image_path}}; throws supabase-js's error.
export async function syncListings(rows) {
	const client = await getClient();
	const {data, error} = await client.rpc('store_sync', {listings: rows});

	if (error) {
		throw error;
	}

	return data || {};
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
