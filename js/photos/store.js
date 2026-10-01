// The owner's card photos on this phone and in Supabase Storage (DESIGN.md
// sections 5 and 8).
//
// Every photo is kept on the phone in IndexedDB, so it shows with no
// connection, and in the private card-photos bucket at
// <user_id>/<entry_id>/<photo_id>.webp, readable by the owner and their
// family group (supabase/photos.sql). A photo taken with no signal, or
// signed out, waits in an upload queue on the phone and goes up when there
// is signal and someone is signed in. A family member's photo is fetched
// from the bucket the first time it is shown, then kept on this phone too.
//
// The database, beside the collection's (js/collection.js):
//   blobs  photo id -> {blob, type, at}         the image itself
//   queue  photo id -> {op, photo_id, entry_id, user_id, type, at, error}
//                                               op is upload or delete
//   made   photo id -> {entry_id, photo}        photos this phone took, so a
//                                               sync that drops one from its
//                                               entry puts it back

import {currentUser, getClient, onUser} from '../auth.js';
import {listCards, loadDocument, onChange, updateCards} from '../collection.js';

import {PHOTO_BUCKET, pathOwner, patchedPhotos, photoPath, restoredPhotos} from './model.js';

const DB_NAME = 'card-tracker-photos';
const STORES = ['blobs', 'queue', 'made'];

// A failed fetch of someone's photo is not retried for this long, so a grid
// of thirty tiles does not ask thirty times a second.
const RETRY_FETCH_MS = 30 * 1000;
const RETRY_QUEUE_MS = 30 * 1000;

let dbPromise = null;

function openDb() {
	if (!dbPromise) {
		dbPromise = new Promise((resolve, reject) => {
			if (!('indexedDB' in window)) {
				reject(new Error('IndexedDB is not available.'));

				return;
			}

			const request = indexedDB.open(DB_NAME, 1);

			request.onupgradeneeded = () => {
				for (const name of STORES) {
					if (!request.result.objectStoreNames.contains(name)) {
						request.result.createObjectStore(name);
					}
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		}).catch((err) => {
			dbPromise = null;

			throw err;
		});
	}

	return dbPromise;
}

async function idb(store, mode, op) {
	const db = await openDb();

	return new Promise((resolve, reject) => {
		const tx = db.transaction(store, mode);
		const request = op(tx.objectStore(store));

		tx.oncomplete = () => resolve(request && request.result);
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

const getAll = (store) => idb(store, 'readonly', (s) => s.getAll());

// ------------------------------------------------------------- listeners

const listeners = new Set();

// listener() runs when the queue changes or a photo arrives on the phone.
// Returns the unsubscribe function.
export function onPhotosChange(listener) {
	listeners.add(listener);

	return () => listeners.delete(listener);
}

const notify = () => listeners.forEach((listener) => {
	try {
		listener();
	}
	catch {
		// A view that went away.
	}
});

// ------------------------------------------------------------- blobs

const urls = new Map();
const fetching = new Map();
const failedAt = new Map();

export async function savePhotoLocally(photoId, blob) {
	await idb('blobs', 'readwrite', (s) => s.put({at: Date.now(), blob, type: blob.type}, photoId));
}

export async function localPhoto(photoId) {
	const row = await idb('blobs', 'readonly', (s) => s.get(photoId));

	return row ? row.blob : null;
}

// Drops the phone's copy. The photo comes back from the bucket the next time
// it is shown, if it was uploaded.
export async function forgetLocalPhoto(photoId) {
	const url = urls.get(photoId);

	if (url) {
		URL.revokeObjectURL(url);
		urls.delete(photoId);
	}

	failedAt.delete(photoId);
	await idb('blobs', 'readwrite', (s) => s.delete(photoId));
}

// The object URL of a photo already opened in this session, or null.
export const cachedPhotoUrl = (photoId) => urls.get(photoId) || null;

function remember(photoId, blob) {
	if (!urls.has(photoId)) {
		urls.set(photoId, URL.createObjectURL(blob));
	}

	return urls.get(photoId);
}

async function download(path) {
	const user = currentUser();

	if (!path || !user || !navigator.onLine) {
		return null;
	}

	const client = await getClient();
	const {data, error} = await client.storage.from(PHOTO_BUCKET).download(path);

	if (error || !data) {
		throw error || new Error(`No photo at ${path}.`);
	}

	return data;
}

// An object URL for the photo: from this session, from the phone, or from
// the bucket (then kept on the phone). Null when none of them has it right
// now: offline, signed out, or not uploaded yet from the phone that took it.
export function photoUrl(photo) {
	if (!photo || !photo.id) {
		return Promise.resolve(null);
	}

	if (urls.has(photo.id)) {
		return Promise.resolve(urls.get(photo.id));
	}

	if (!fetching.has(photo.id)) {
		fetching.set(photo.id, (async () => {
			const local = await localPhoto(photo.id).catch(() => null);

			if (local) {
				return remember(photo.id, local);
			}

			if (Date.now() - (failedAt.get(photo.id) || 0) < RETRY_FETCH_MS) {
				return null;
			}

			try {
				const blob = await download(photo.path);

				if (!blob) {
					return null;
				}

				await savePhotoLocally(photo.id, blob).catch(() => {});
				failedAt.delete(photo.id);

				return remember(photo.id, blob);
			}
			catch {
				failedAt.set(photo.id, Date.now());

				return null;
			}
		})().finally(() => fetching.delete(photo.id)));
	}

	return fetching.get(photo.id);
}

// ------------------------------------------------------------- made

async function rememberMade(entryId, photo) {
	await idb('made', 'readwrite', (s) => s.put({entry_id: entryId, photo}, photo.id));
}

// Puts back photos this phone took that a merged-in version of their entry
// lacks (model.js, restoredPhotos).
export async function restoreDroppedPhotos() {
	const made = await getAll('made').catch(() => []);

	if (!made.length) {
		return 0;
	}

	const byEntry = new Map();

	for (const row of made) {
		if (!byEntry.has(row.entry_id)) {
			byEntry.set(row.entry_id, []);
		}

		byEntry.get(row.entry_id).push(row.photo);
	}

	const patches = [];

	for (const entry of await listCards()) {
		const photos = byEntry.has(entry.id) ? restoredPhotos(entry, byEntry.get(entry.id)) : null;

		if (photos) {
			patches.push({id: entry.id, patch: {photos}});
		}
	}

	if (patches.length) {
		await updateCards(patches);
	}

	return patches.length;
}

// ------------------------------------------------------------- queue

let pending = new Set();
let queueLoaded = false;

async function loadPending() {
	const rows = await getAll('queue').catch(() => []);

	pending = new Set(rows.filter((row) => row.op === 'upload').map((row) => row.photo_id));
	queueLoaded = true;
}

// Photo ids whose upload has not gone up yet.
export const pendingUploads = () => new Set(pending);

export async function queuedItems() {
	return getAll('queue');
}

// The live entry as the document holds it now, never a copy a view kept.
async function freshEntry(entryOrId) {
	const id = typeof entryOrId === 'string' ? entryOrId : entryOrId && entryOrId.id;

	return (await listCards()).find((card) => card.id === id) || null;
}

// Saves a new photo on the phone, adds it to its entry, and queues its
// upload. `photo` is a model.js newPhoto() record.
export async function addPhotoToEntry(entryOrId, photo, blob) {
	const doc = await loadDocument();
	const entry = await freshEntry(entryOrId);

	if (!entry) {
		throw new Error('That copy is no longer in your cards.');
	}

	await savePhotoLocally(photo.id, blob);
	remember(photo.id, blob);
	await rememberMade(entry.id, photo);
	await updateCards([{id: entry.id, patch: {photos: [...(Array.isArray(entry.photos) ? entry.photos : []), photo]}}]);
	await idb('queue', 'readwrite', (s) => s.put({
		at: Date.now(),
		entry_id: entry.id,
		error: null,
		op: 'upload',
		photo_id: photo.id,
		type: blob.type,
		user_id: doc.user_id || null,
	}, photo.id));
	pending.add(photo.id);
	notify();
	flushQueue();
}

// Removes a photo: a tombstone in its entry (and the pin cleared when it
// pointed there), the phone's copy dropped, and the bucket's copy deleted
// when there is one.
export async function removePhotoFromEntry(entryOrId, photoId) {
	const at = new Date().toISOString();
	const entry = await freshEntry(entryOrId);
	const photos = entry && patchedPhotos(entry, photoId, {deleted_at: at});

	if (!photos) {
		return;
	}

	const photo = photos.find((item) => item.id === photoId);
	const patch = {photos};

	if (entry.main_image === photoId) {
		patch.main_image = null;
	}

	await updateCards([{id: entry.id, patch}]);
	await rememberMade(entry.id, photo).catch(() => {});

	const queued = await idb('queue', 'readonly', (s) => s.get(photoId));

	if (photo.path) {
		await idb('queue', 'readwrite', (s) => s.put({
			at: Date.now(),
			entry_id: entry.id,
			error: null,
			op: 'delete',
			path: photo.path,
			photo_id: photoId,
			user_id: pathOwner(photo.path),
		}, photoId));
	}
	else if (queued) {
		await idb('queue', 'readwrite', (s) => s.delete(photoId));
	}

	pending.delete(photoId);
	await forgetLocalPhoto(photoId).catch(() => {});
	notify();
	flushQueue();
}

// A failure worth retrying (no connection, a server hiccup) or not (the
// server refused: retried only at the next start or sign-in).
const permanent = (err) => {
	const status = Number(err && (err.status || err.statusCode));

	return status >= 400 && status < 500 && status !== 408 && status !== 429;
};

async function uploadOne(client, row, userId) {
	const cards = await listCards();
	const entry = cards.find((card) => card.id === row.entry_id);
	const photo = entry && (entry.photos || []).find((item) => item.id === row.photo_id);

	// The card or the photo was removed before it went up: nothing to send.
	if (!entry || !photo || photo.deleted_at) {
		return true;
	}

	const blob = await localPhoto(row.photo_id);

	if (!blob) {
		return true;
	}

	const path = photo.path || photoPath(userId, entry.id, photo.id, row.type || blob.type);
	const {error} = await client.storage.from(PHOTO_BUCKET).upload(path, await blob.arrayBuffer(), {
		cacheControl: '31536000',
		contentType: row.type || blob.type || 'image/webp',
		upsert: true,
	});

	if (error) {
		throw error;
	}

	if (photo.path !== path) {
		const photos = patchedPhotos(entry, photo.id, {path});

		await updateCards([{id: entry.id, patch: {photos}}]);
		await rememberMade(entry.id, {...photo, path}).catch(() => {});
	}

	return true;
}

async function deleteOne(client, row) {
	const {error} = await client.storage.from(PHOTO_BUCKET).remove([row.path]);

	if (error) {
		throw error;
	}

	return true;
}

let flushing = null;
let flushAgain = false;
let retryTimer = null;

// Sends what the queue holds, oldest first. Waits quietly when offline or
// signed out, and when the phone's document belongs to another account than
// the one signed in.
export function flushQueue() {
	if (flushing) {
		flushAgain = true;

		return flushing;
	}

	flushing = (async () => {
		let retry = false;

		try {
			const user = currentUser();
			const doc = await loadDocument();

			if (!user || !navigator.onLine || doc.user_id !== user.id) {
				return;
			}

			const rows = (await getAll('queue')).sort((a, b) => a.at - b.at);

			if (!rows.length) {
				return;
			}

			const client = await getClient();

			for (const row of rows) {
				if (row.user_id && row.user_id !== user.id) {
					continue;
				}

				try {
					if (row.op === 'delete') {
						await deleteOne(client, row);
					}
					else {
						await uploadOne(client, row, user.id);
					}

					await idb('queue', 'readwrite', (s) => s.delete(row.photo_id));
					pending.delete(row.photo_id);
				}
				catch (err) {
					const message = (err && err.message) || String(err);

					await idb('queue', 'readwrite', (s) => s.put({...row, error: message}, row.photo_id)).catch(() => {});

					if (!permanent(err)) {
						retry = true;

						// Lost the connection mid-way: the rest waits too.
						break;
					}
				}
			}
		}
		catch {
			retry = true;
		}
		finally {
			await loadPending().catch(() => {});
			notify();

			if (retry && navigator.onLine && !retryTimer) {
				retryTimer = setTimeout(() => {
					retryTimer = null;
					flushQueue();
				}, RETRY_QUEUE_MS);
			}
		}
	})().finally(() => {
		flushing = null;

		if (flushAgain) {
			flushAgain = false;
			flushQueue();
		}
	});

	return flushing;
}

// ------------------------------------------------------------- start

let started = false;

// Starts the queue and the photo restore once per page: flushes now, when
// the phone comes back online, and when someone signs in; restores dropped
// photos after every sync. Safe to call from every view that shows photos.
export function startPhotoSync() {
	if (started) {
		return;
	}

	started = true;

	if (!queueLoaded) {
		loadPending().then(notify).catch(() => {});
	}

	window.addEventListener('online', () => {
		failedAt.clear();
		flushQueue();
		notify();
	});
	window.addEventListener('offline', notify);
	onUser(() => {
		failedAt.clear();
		flushQueue();
	});
	onChange((doc, {source}) => {
		if (source === 'sync' || source === 'account') {
			restoreDroppedPhotos().catch(() => {});
			flushQueue();
		}
	});
	flushQueue();
}
