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
// A photo saved with a detail copy (DESIGN.md section 5, "Inspection
// viewer") has a second, larger file beside it at
// <user_id>/<entry_id>/<photo_id>-detail.webp. It uploads after the normal
// copy, is deleted with it, and is fetched from the bucket only when the
// viewer zooms past the normal copy's resolution, then kept on the phone.
//
// The database, beside the collection's (js/collection.js):
//   blobs  photo id -> {blob, type, at}         the image itself, and
//          photo id + "#detail" -> the same     its detail copy
//   queue  photo id -> {op, photo_id, entry_id, user_id, type, at, error}
//                                               op is upload or delete
//          photo id + "#detail" -> the same     op upload-detail
//   made   photo id -> {entry_id, photo}        photos this phone took, so a
//                                               sync that drops one from its
//                                               entry puts it back

import {currentUser, getClient, onUser} from '../auth.js';
import {loadDocument, onChange, resolveEntry, updateCards} from '../collection.js';

import {PHOTO_BUCKET, detailPath, pathOwner, patchedPhotos, photoPath, restoredPhotos} from './model.js';

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

// The key of a photo's detail copy, in blobs and in the queue.
export const detailKey = (photoId) => `${photoId}#detail`;

const DETAIL_OP = 'upload-detail';

const queueKey = (row) => (row.op === DETAIL_OP ? detailKey(row.photo_id) : row.photo_id);

// ------------------------------------------------------------- the setting

// "Keep a detail copy of new photos": a choice for this phone only (it
// costs this phone's camera time and the account's storage), off unless
// turned on.
export const DETAIL_SETTING_KEY = 'card-tracker-photo-detail';

export function keepDetailCopies() {
	try {
		return localStorage.getItem(DETAIL_SETTING_KEY) === 'on';
	}
	catch {
		return false;
	}
}

export function setKeepDetailCopies(on) {
	try {
		if (on) {
			localStorage.setItem(DETAIL_SETTING_KEY, 'on');
		}
		else {
			localStorage.removeItem(DETAIL_SETTING_KEY);
		}
	}
	catch {
		// Private mode or storage off: the choice lasts for this visit only.
	}
}

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

function forgetUrl(key) {
	const url = urls.get(key);

	if (url) {
		URL.revokeObjectURL(url);
		urls.delete(key);
	}

	failedAt.delete(key);
}

// Drops the phone's copy, and its detail copy. The photo comes back from
// the bucket the next time it is shown, if it was uploaded.
export async function forgetLocalPhoto(photoId) {
	forgetUrl(photoId);
	forgetUrl(detailKey(photoId));
	await idb('blobs', 'readwrite', (s) => {
		s.delete(detailKey(photoId));

		return s.delete(photoId);
	});
}

// Drops only the detail copy from the phone, which then comes back from the
// bucket the next time the viewer zooms in.
export async function forgetLocalDetail(photoId) {
	forgetUrl(detailKey(photoId));
	await idb('blobs', 'readwrite', (s) => s.delete(detailKey(photoId)));
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

// An object URL for the file stored under `key`: from this session, from
// the phone, or from the bucket at `path` (then kept on the phone).
function fileUrl(key, path) {
	if (urls.has(key)) {
		return Promise.resolve(urls.get(key));
	}

	if (!fetching.has(key)) {
		fetching.set(key, (async () => {
			const local = await localPhoto(key).catch(() => null);

			if (local) {
				return remember(key, local);
			}

			if (Date.now() - (failedAt.get(key) || 0) < RETRY_FETCH_MS) {
				return null;
			}

			try {
				const blob = await download(path);

				if (!blob) {
					return null;
				}

				await savePhotoLocally(key, blob).catch(() => {});
				failedAt.delete(key);

				return remember(key, blob);
			}
			catch {
				failedAt.set(key, Date.now());

				return null;
			}
		})().finally(() => fetching.delete(key)));
	}

	return fetching.get(key);
}

// An object URL for the photo: from this session, from the phone, or from
// the bucket (then kept on the phone). Null when none of them has it right
// now: offline, signed out, or not uploaded yet from the phone that took it.
export function photoUrl(photo) {
	if (!photo || !photo.id) {
		return Promise.resolve(null);
	}

	return fileUrl(photo.id, photo.path);
}

// The same for the photo's detail copy, for the viewer when it zooms past
// the normal copy. Null for a photo saved without one, and whenever the
// detail copy cannot be had right now; the normal copy then stays.
export function detailUrl(photo) {
	if (!photo || !photo.id || !photo.detail) {
		return Promise.resolve(null);
	}

	return fileUrl(detailKey(photo.id), detailPath(photo.path, photo.detail.type));
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

	// A photo taken on a copy the merge has since folded into another
	// (js/merge.js, merged_into) belongs to the copy it was folded into.
	const {cards} = await loadDocument();
	const byEntry = new Map();

	for (const row of made) {
		const entry = row && row.photo ? resolveEntry(cards, row.entry_id) : null;

		if (!entry) {
			continue;
		}

		if (!byEntry.has(entry.id)) {
			byEntry.set(entry.id, []);
		}

		byEntry.get(entry.id).push(row.photo);
	}

	const patches = [];

	for (const entry of cards.filter((card) => card && !card.deleted_at)) {
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
// When the merge folded the copy into another (js/merge.js, merged_into),
// that is the one.
async function freshEntry(entryOrId) {
	const id = typeof entryOrId === 'string' ? entryOrId : entryOrId && entryOrId.id;

	return resolveEntry((await loadDocument()).cards, id);
}

// Saves a new photo on the phone, adds it to its entry, and queues its
// upload. `photo` is a model.js newPhoto() record; detailBlob is its detail
// copy when photo.detail says it has one, queued to upload after it.
export async function addPhotoToEntry(entryOrId, photo, blob, detailBlob = null) {
	const doc = await loadDocument();
	const entry = await freshEntry(entryOrId);

	if (!entry) {
		throw new Error('That copy is no longer in your cards.');
	}

	await savePhotoLocally(photo.id, blob);
	remember(photo.id, blob);

	const withDetail = Boolean(detailBlob && photo.detail);

	if (withDetail) {
		await savePhotoLocally(detailKey(photo.id), detailBlob);
	}

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

	if (withDetail) {
		await idb('queue', 'readwrite', (s) => s.put({
			at: Date.now() + 1,
			entry_id: entry.id,
			error: null,
			op: DETAIL_OP,
			photo_id: photo.id,
			type: detailBlob.type,
			user_id: doc.user_id || null,
		}, detailKey(photo.id)));
	}

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
	const detail = photo.detail ? detailPath(photo.path, photo.detail.type) : null;

	if (photo.path) {
		await idb('queue', 'readwrite', (s) => s.put({
			at: Date.now(),
			entry_id: entry.id,
			error: null,
			op: 'delete',
			path: photo.path,
			paths: [photo.path, detail].filter(Boolean),
			photo_id: photoId,
			user_id: pathOwner(photo.path),
		}, photoId));
	}
	else if (queued) {
		await idb('queue', 'readwrite', (s) => s.delete(photoId));
	}

	// A detail copy still waiting to go up stays nowhere.
	await idb('queue', 'readwrite', (s) => s.delete(detailKey(photoId))).catch(() => {});

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
	// The copy the photo was taken on, or the one the merge folded it into,
	// which holds its photos now.
	const entry = resolveEntry((await loadDocument()).cards, row.entry_id);
	const photo = entry && (entry.photos || []).find((item) => item.id === row.photo_id);

	// The card or the photo was removed before it went up: nothing to send.
	if (!entry || !photo || photo.deleted_at) {
		return true;
	}

	if (row.op === DETAIL_OP) {
		return uploadDetail(client, row, entry, photo, userId);
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

// The detail copy goes up beside the normal copy, once that one has its
// path (its upload row is older, so it went first).
async function uploadDetail(client, row, entry, photo, userId) {
	const blob = await localPhoto(detailKey(row.photo_id));

	if (!blob || !photo.detail) {
		return true;
	}

	const path = detailPath(photo.path || photoPath(userId, entry.id, photo.id, photo.detail.type), photo.detail.type);
	const {error} = await client.storage.from(PHOTO_BUCKET).upload(path, await blob.arrayBuffer(), {
		cacheControl: '31536000',
		contentType: row.type || blob.type || 'image/webp',
		upsert: true,
	});

	if (error) {
		throw error;
	}

	return true;
}

async function deleteOne(client, row) {
	const {error} = await client.storage.from(PHOTO_BUCKET).remove(row.paths && row.paths.length ? row.paths : [row.path]);

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

					await idb('queue', 'readwrite', (s) => s.delete(queueKey(row)));

					if (row.op !== DETAIL_OP) {
						pending.delete(row.photo_id);
					}
				}
				catch (err) {
					const message = (err && err.message) || String(err);

					await idb('queue', 'readwrite', (s) => s.put({...row, error: message}, queueKey(row))).catch(() => {});

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
