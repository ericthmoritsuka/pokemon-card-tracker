// The owner's card photos on this phone and in Supabase Storage (DESIGN.md
// sections 5 and 8).
//
// A photo belongs to its card's record (js/card-info.js), never to a copy.
// Every photo is kept on the phone in IndexedDB, so it shows with no
// connection, and in the private card-photos bucket at
// <user_id>/<folder>/<photo_id>.webp, readable by the owner and their
// family group (supabase/photos.sql). A photo taken with no signal, or
// signed out, waits in an upload queue on the phone and goes up when there
// is signal and someone is signed in. A family member's photo is fetched
// from the bucket the first time it is shown, then kept on this phone too.
//
// A photo saved with a detail copy (DESIGN.md section 5, "Inspection
// viewer") has a second, larger file beside it at
// <user_id>/<folder>/<photo_id>-detail.webp. The folder is the photo's own
// id from v48, and the copy's id for a photo taken before; the path is a
// stored string, so old files stay where they are. It uploads after the normal
// copy, is deleted with it, and is fetched from the bucket only when the
// viewer zooms past the normal copy's resolution, then kept on the phone.
//
// The database, beside the collection's (js/collection.js):
//   blobs  photo id -> {blob, type, at}         the image itself, and
//          photo id + "#detail" -> the same     its detail copy
//   queue  photo id -> {op, photo_id, entry_id, user_id, type, at, error}
//                                               op is upload or delete;
//                                               entry_id the record (a copy
//                                               on rows from before v48); a
//                                               delete also holds path,
//                                               paths, list, and not_before
//          photo id + "#detail" -> the same     op upload-detail
//   made   photo id -> {card, photo}            photos this phone took, so a
//                                               sync that drops one from its
//                                               record puts it back; card is
//                                               {catalog, card_id, language}
//                                               (entry_id, a copy, before v48)
//          "swept:" + photo id -> {swept, at}   written before v48, unused
//
// A removed photo leaves the phone at once, but its bucket file stays for a
// grace period (model.js bucketDeleteState): another phone may still show
// it, and the delete must reach the server first, so no phone can bring the
// photo back pointing at a missing file.

import {currentUser, getClient, isAuthStatus, onSession, onUser, sessionExpired} from '../auth.js';
import {infoKey, recordWithPhoto} from '../card-info.js';
import {loadDocument, newId, onChange, resolveEntry, updateCardInfo} from '../collection.js';
import {database} from '../idb.js';
import {onSyncStatus, serverHolds} from '../sync.js';

import {BUCKET_DELETE_GRACE_MS, PHOTO_BUCKET, bucketDeleteState, detailPath, pathOwner, patchedPhotos, photoPath, restoredPhotos} from './model.js';

const DB_NAME = 'card-tracker-photos';
const STORES = ['blobs', 'queue', 'made'];

// A failed fetch of someone's photo is not retried for this long, so a grid
// of thirty tiles does not ask thirty times a second.
const RETRY_FETCH_MS = 30 * 1000;
const RETRY_QUEUE_MS = 30 * 1000;

const phoneDb = database(DB_NAME, STORES);
const idb = phoneDb.run;

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

// The card a photo belongs to, as {catalog, card_id, language}.
const cardOf = (item) => ({card_id: item.card_id, catalog: item.catalog || 'international', language: item.language || ''});

async function rememberMade(card, photo) {
	await idb('made', 'readwrite', (s) => s.put({card: cardOf(card), photo}, photo.id));
}

// Puts back photos this phone took that a merged-in version of their card's
// record lacks (model.js, restoredPhotos). A row from before v48 names the
// copy the photo was taken on, deleted or not: its card is the copy's.
export async function restoreDroppedPhotos() {
	const made = await getAll('made').catch(() => []);

	if (!made.length) {
		return 0;
	}

	const {cards} = await loadDocument();
	const byCard = new Map();

	for (const row of made) {
		let card = row && row.photo && row.card && row.card.card_id ? row.card : null;

		if (!card && row && row.photo && row.entry_id) {
			const copy = resolveEntry(cards, row.entry_id) || (cards || []).find((item) => item && item.id === row.entry_id);

			card = copy && copy.card_id ? cardOf(copy) : null;
		}

		if (!card) {
			continue;
		}

		const key = infoKey(card);

		if (!byCard.has(key)) {
			byCard.set(key, {card, photos: []});
		}

		byCard.get(key).photos.push(row.photo);
	}

	const groups = [...byCard.values()];
	const changed = await updateCardInfo(groups.map((group) => group.card), (record) => {
		const group = byCard.get(record.id);
		const photos = group ? restoredPhotos(record, group.photos) : null;

		return photos ? {photos} : null;
	});

	return changed.length;
}

// ------------------------------------------------------------- queue

let pending = new Set();
let problems = new Map();
let queueLoaded = false;

async function loadPending() {
	const rows = await getAll('queue').catch(() => []);
	const uploads = rows.filter((row) => row.op === 'upload');

	pending = new Set(uploads.map((row) => row.photo_id));
	problems = new Map(uploads.filter((row) => problemText(row)).map((row) => [row.photo_id, problemText(row)]));
	queueLoaded = true;
}

// Photo ids whose upload has not gone up yet.
export const pendingUploads = () => new Set(pending);

// Photo ids whose upload did not go, and why in a few words (problemText):
// the server refused the file, or the session must be signed in again.
export function uploadProblems() {
	if (sessionExpired()) {
		return new Map([...pending].map((id) => [id, problems.get(id) && !/^Sign in/.test(problems.get(id)) ? problems.get(id) : 'Sign in again to upload']));
	}

	return new Map(problems);
}

// What a waiting photo says while nothing is wrong: signed out, nothing
// can upload until someone signs in.
export const waitingText = () => (currentUser() ? 'Waiting to upload' : 'Saved on this phone; uploads after you sign in');

// The uploads the server refused, or that wait for a new sign-in, for
// Profile: [{photo_id, entry_id, text, kind}], oldest first.
export async function failedUploads() {
	const rows = await getAll('queue').catch(() => []);
	// With the session over, every waiting upload waits for the sign-in.
	const ended = sessionExpired();
	const describe = (row) => (row.error_kind === 'refused' ? problemText(row) : ended ? 'Sign in again to upload' : problemText(row));

	return rows
		.filter((row) => row.op === 'upload' && describe(row))
		.sort((a, b) => a.at - b.at)
		.map((row) => ({entry_id: row.entry_id, kind: row.error_kind === 'refused' ? 'refused' : 'auth', photo_id: row.photo_id, text: describe(row)}));
}

// Tries a refused upload again now (Profile's Retry): its error is cleared
// and the queue sent.
export async function retryUpload(photoId) {
	for (const key of [photoId, detailKey(photoId)]) {
		refusedHere.delete(key);

		const row = await idb('queue', 'readonly', (s) => s.get(key)).catch(() => null);

		if (row) {
			await idb('queue', 'readwrite', (s) => s.put({...row, error: null, error_kind: null, error_status: null}, key));
		}
	}

	await loadPending().catch(() => {});
	notify();

	return flushQueue();
}

export async function queuedItems() {
	return getAll('queue');
}

// Saves a new photo on the phone, adds it to its card's record (made when
// the card has none yet), and queues its upload. card is {catalog, card_id,
// language}, a record or a copy; `photo` is a model.js newPhoto() record;
// detailBlob is its detail copy when photo.detail says it has one, queued
// to upload after it.
export async function addPhotoToCard(card, photo, blob, detailBlob = null) {
	const doc = await loadDocument();

	if (!card || !card.card_id) {
		throw new Error('That card is not known.');
	}

	await savePhotoLocally(photo.id, blob);
	remember(photo.id, blob);

	const withDetail = Boolean(detailBlob && photo.detail);

	if (withDetail) {
		await savePhotoLocally(detailKey(photo.id), detailBlob);
	}

	await rememberMade(card, photo);
	await updateCardInfo([cardOf(card)], (record) => ({photos: [...(Array.isArray(record.photos) ? record.photos : []), photo]}));

	const entryId = infoKey(card);

	await idb('queue', 'readwrite', (s) => s.put({
		at: Date.now(),
		entry_id: entryId,
		error: null,
		list: 'card_info',
		op: 'upload',
		photo_id: photo.id,
		type: blob.type,
		user_id: doc.user_id || null,
	}, photo.id));

	if (withDetail) {
		await idb('queue', 'readwrite', (s) => s.put({
			at: Date.now() + 1,
			entry_id: entryId,
			error: null,
			list: 'card_info',
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

// The record holding a live photo, or null: the one given when it holds
// it, else whichever record does (a queue row from before v48 names a copy).
async function holderOf(recordOrId, photoId) {
	const records = (await loadDocument()).card_info || [];
	const id = typeof recordOrId === 'string' ? recordOrId : recordOrId && recordOrId.id;
	const given = records.find((record) => record && record.id === id);
	const record = given && (given.photos || []).some((photo) => photo && photo.id === photoId) ? given : recordWithPhoto(records, photoId);

	return record && !record.deleted_at ? record : null;
}

// Removes a photo: a tombstone in its card's record (and the pin cleared
// when it pointed there), the phone's copy dropped, and the bucket's copy
// queued for deletion once the grace period has passed and the server holds
// the tombstone. Removing the photo is the only thing that deletes its file:
// deleting copies of the card never does. Resolves true when the photo was
// live here, false when no record holds it or it was already removed (on
// another phone, say), so a caller counts only what it removed.
export async function removePhotoFromEntry(recordOrId, photoId) {
	const at = new Date().toISOString();
	const record = await holderOf(recordOrId, photoId);
	const photos = record && patchedPhotos(record, photoId, {deleted_at: at});

	if (!photos) {
		return false;
	}

	const wasLive = (record.photos || []).some((item) => item && item.id === photoId && !item.deleted_at);

	const photo = photos.find((item) => item.id === photoId);

	await updateCardInfo([cardOf(record)], (current) => {
		const patch = {photos: patchedPhotos(current, photoId, {deleted_at: at}) || current.photos};

		if (current.main_image === photoId) {
			patch.main_image = null;
		}

		return patch;
	});
	await rememberMade(record, photo).catch(() => {});

	const queued = await idb('queue', 'readonly', (s) => s.get(photoId));

	if (photo.path) {
		await idb('queue', 'readwrite', (s) => s.put(deleteRow(record.id, photo, Date.now()), photoId));
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

	return wasLive;
}

// ------------------------------------------------------------- replace

// A file on the phone as {bytes, type}, read now, or null. Undo edit keeps
// the old photo's files this way: a Blob read back from IndexedDB may no
// longer read once its row is deleted.
async function fileBytes(key) {
	try {
		const blob = await localPhoto(key);

		return blob ? {bytes: await blob.arrayBuffer(), type: blob.type} : null;
	}
	catch {
		return null;
	}
}

const fileBlob = (file) => new Blob([file.bytes], {type: file.type});

// Puts `photo`, a new model.js newPhoto() record (an adjusted copy of the
// old one, DESIGN.md section 5, "Adjust a photo"), in the place of the live
// photo oldId on the card's record: saved and queued like any new photo
// (addPhotoToCard), so it uploads when there is signal; every record of the
// card pinned to the old photo pinned to the new one; and the old photo
// removed the normal way (removePhotoFromEntry), so its bucket file goes
// only after the grace period. The caller gives the new photo the old one's
// side and created_at, which put it at the same place in the carousel.
//
// Resolves with what undoReplacePhoto needs to bring the old photo back:
// the old photo, its files on this phone (read now), its queue rows, and
// the id it will come back under.
export async function replacePhoto(recordOrId, oldId, photo, blob, detailBlob = null) {
	const record = await holderOf(recordOrId, oldId);
	const old = record && (record.photos || []).find((item) => item && item.id === oldId && !item.deleted_at);

	if (!old) {
		throw new Error('That photo is no longer on this card.');
	}

	const doc = await loadDocument();
	const pins = (doc.card_info || [])
		.filter((item) => item && !item.deleted_at && item.main_image === oldId)
		.map(cardOf);
	const undo = {
		adjustedId: photo.id,
		card: cardOf(record),
		files: {
			detail: await fileBytes(detailKey(oldId)),
			photo: await fileBytes(oldId),
		},
		old: {...old},
		restoredId: newId(),
		rows: {
			detail: await idb('queue', 'readonly', (s) => s.get(detailKey(oldId))).catch(() => null),
			photo: await idb('queue', 'readonly', (s) => s.get(oldId)).catch(() => null),
		},
	};

	await addPhotoToCard(record, photo, blob, detailBlob);

	if (pins.length) {
		await updateCardInfo(pins, (current) => (current.main_image === oldId ? {main_image: photo.id} : null));
	}

	await removePhotoFromEntry(record, oldId);

	return undo;
}

// Undo edit: the old photo back in the adjusted one's place, and the
// adjusted one removed the normal way. The old photo comes back as a new
// photo (undo.restoredId) with its path, detail, side, and created_at, as
// the photo cleanup's Undo does (js/photo-cleanup.js undoDelete): a
// tombstone wins every merge, on every version of the app, so the old id
// cannot come back once a sync has carried its removal. Its bucket file
// was never deleted: a removal waits for the grace period, and a live photo
// at the same path cancels the waiting delete (model.js bucketDeleteState
// on the phone, supabase/card-photos-keep.sql on the server). Its files on
// this phone are saved under the new id, and an upload that had not gone
// up yet waits again.
//
// The steps run in an order that leaves the adjusted photo in place
// whatever fails: the files and queue rows, then the old photo on the
// record, then the pins, then the adjusted photo removed. A failure before
// the old photo is on the record takes its files and rows away again; one
// after leaves both photos showing. Each step is safe to run again, so Undo
// edit can be tried again; once the adjusted photo is gone it is refused.
// step(name), for tests, runs before each step. Resolves with the photo
// brought back.
export function undoReplacePhoto(undo, options = {}) {
	if (!undo.running) {
		undo.running = undoReplace(undo, options).finally(() => {
			undo.running = null;
		});
	}

	return undo.running;
}

async function undoReplace(undo, {step = () => {}}) {
	const {old, restoredId} = undo;
	const files = undo.files || {};
	const doc = await loadDocument();
	const record = (doc.card_info || []).find((item) => item && item.id === infoKey(undo.card));
	const photos = (record && record.photos) || [];

	if (!record || record.deleted_at || !photos.some((item) => item && item.id === undo.adjustedId && !item.deleted_at)) {
		throw new Error('The adjusted photo is no longer on this card.');
	}

	const now = photos.find((item) => item && item.id === old.id);
	const path = (now && now.path) || old.path || null;
	// Not up yet when Save removed it: it goes up again, from this phone.
	const upload = Boolean(undo.rows.photo && undo.rows.photo.op === 'upload') || !path;
	const uploadDetail = Boolean(undo.rows.detail && undo.rows.detail.op === DETAIL_OP);
	const back = {...old, deleted_at: null, id: restoredId, path};

	if (old.detail && uploadDetail && !files.detail) {
		delete back.detail;
	}

	if (upload && !files.photo) {
		throw new Error('The old photo is no longer on this phone.');
	}

	// The upload rows, each put only where the queue has none.
	const rowOf = (row, op, at) => ({...row, at, error: null, error_kind: null, error_status: null, op, photo_id: restoredId});
	const rows = [
		upload ? [restoredId, rowOf(undo.rows.photo || {entry_id: record.id, list: 'card_info', type: files.photo.type, user_id: doc.user_id || null}, 'upload', Date.now())] : null,
		uploadDetail && back.detail ? [detailKey(restoredId), rowOf(undo.rows.detail, DETAIL_OP, Date.now() + 1)] : null,
	].filter(Boolean);
	const queueRows = async () => {
		for (const [key, row] of rows) {
			await idb('queue', 'readwrite', (s) => {
				const request = s.get(key);

				request.onsuccess = () => {
					if (!request.result) {
						s.put(row, key);
					}
				};

				return request;
			});
		}
	};
	const onRecord = async () => ((await loadDocument()).card_info || [])
		.some((item) => item && item.id === record.id && (item.photos || []).some((photo) => photo && photo.id === restoredId));

	if (!photos.some((item) => item && item.id === restoredId)) {
		try {
			await step('photo file');

			if (files.photo) {
				await savePhotoLocally(restoredId, fileBlob(files.photo));
			}

			if (files.detail && back.detail) {
				await step('detail file');
				await savePhotoLocally(detailKey(restoredId), fileBlob(files.detail));
			}

			await step('queue');
			await queueRows();
			await step('add');
			await updateCardInfo([undo.card], (current) => {
				const list = Array.isArray(current.photos) ? current.photos : [];

				return list.some((item) => item && item.id === restoredId) ? null : {photos: [...list, back]};
			});
		}
		catch (err) {
			if (!(await onRecord().catch(() => true))) {
				await forgetLocalPhoto(restoredId).catch(() => {});
				await idb('queue', 'readwrite', (s) => {
					s.delete(detailKey(restoredId));

					return s.delete(restoredId);
				}).catch(() => {});
			}

			throw err;
		}

		// Again, in case a flush that ran before the photo was on the record
		// dropped them (uploadOne: no photo, nothing to send).
		await queueRows().catch(() => {});
		await rememberMade(undo.card, back).catch(() => {});

		if (files.photo) {
			remember(restoredId, fileBlob(files.photo));
		}

		if (upload) {
			pending.add(restoredId);
		}

		notify();
	}

	await step('pins');

	const pinned = ((await loadDocument()).card_info || [])
		.filter((item) => item && !item.deleted_at && item.main_image === undo.adjustedId)
		.map(cardOf);

	if (pinned.length) {
		await updateCardInfo(pinned, (current) => (current.main_image === undo.adjustedId ? {main_image: restoredId} : null));
	}

	await step('remove');
	await removePhotoFromEntry(record.id, undo.adjustedId);

	return back;
}

const statusOf = (err) => Number(err && (err.status || err.statusCode));

// What kind of failure: 'auth' when the session's token was refused (the
// upload goes again once the session is refreshed or the person signs in
// again, js/auth.js), 'refused' when the server will not take the file
// (too large, a policy: retried only at the next start, sign-in, or Retry),
// else 'retry' (no connection, a server hiccup).
function failureKind(err) {
	const status = statusOf(err);
	const message = (err && err.message) || '';

	if (isAuthStatus(status, message)) {
		return 'auth';
	}

	return status >= 400 && status < 500 && status !== 408 && status !== 429 ? 'refused' : 'retry';
}

const permanent = (err) => failureKind(err) === 'refused';

// Short words for a queue row's failure, for the photo and Profile.
export function problemText(row) {
	if (!row || !row.error) {
		return null;
	}

	if (row.error_kind === 'auth') {
		return 'Sign in again to upload';
	}

	if (row.error_kind !== 'refused') {
		return null;
	}

	const status = Number(row.error_status);
	const message = String(row.error);

	if (status === 413 || /maximum allowed size|too large/i.test(message)) {
		return 'Not uploaded: too large for the server';
	}

	if (status === 415 || /mime type/i.test(message)) {
		return 'Not uploaded: the server does not take this file type';
	}

	if (/row-level security|unauthorized|permission/i.test(message)) {
		return 'Not uploaded: the server refused it (no permission)';
	}

	return `Not uploaded: ${message}`;
}

async function uploadOne(client, row, userId) {
	// The card's record that holds the photo (on a row from before v48,
	// entry_id names a copy; the photo has moved to its card since).
	const entry = await holderOf(row.entry_id, row.photo_id);
	const photo = entry && (entry.photos || []).find((item) => item.id === row.photo_id);

	// The photo was removed before it went up: nothing to send.
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

	const path = photo.path || photoPath(userId, photo.id, photo.id, row.type || blob.type);
	const {error} = await client.storage.from(PHOTO_BUCKET).upload(path, await blob.arrayBuffer(), {
		cacheControl: '31536000',
		contentType: row.type || blob.type || 'image/webp',
		upsert: true,
	});

	if (error) {
		throw error;
	}

	if (photo.path !== path) {
		await updateCardInfo([cardOf(entry)], (current) => {
			const photos = patchedPhotos(current, photo.id, {path});

			return photos ? {photos} : null;
		});
		await rememberMade(entry, {...photo, path}).catch(() => {});
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

	const path = detailPath(photo.path || photoPath(userId, photo.id, photo.id, photo.detail.type), photo.detail.type);
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

// The queue row that deletes a photo's files from the bucket, no earlier
// than the grace period after `at`.
function deleteRow(entryId, photo, at) {
	const detail = photo.detail ? detailPath(photo.path, photo.detail.type) : null;

	return {
		at,
		entry_id: entryId,
		error: null,
		list: 'card_info',
		not_before: at + BUCKET_DELETE_GRACE_MS,
		op: 'delete',
		path: photo.path,
		paths: [photo.path, detail].filter(Boolean),
		photo_id: photo.id,
		user_id: pathOwner(photo.path),
	};
}

async function deleteOne(client, row) {
	const {error} = await client.storage.from(PHOTO_BUCKET).remove(row.paths && row.paths.length ? row.paths : [row.path]);

	if (error) {
		throw error;
	}

	return true;
}

// A queue row's key is its photo id, so a row written while another was
// being sent takes its place: Save or Undo edit removing a photo while it
// goes up writes the photo's delete there. When the send is done, the row
// is dropped, or its error written, only while it is still the one sent
// (the same op and at), so that delete is never lost and the bucket file
// never left behind.
const sameRow = (a, b) => Boolean(a && b) && a.op === b.op && a.at === b.at;

function replaceRow(row, next) {
	const key = queueKey(row);

	return idb('queue', 'readwrite', (s) => {
		const request = s.get(key);

		request.onsuccess = () => {
			if (sameRow(request.result, row)) {
				if (next) {
					s.put(next, key);
				}
				else {
					s.delete(key);
				}
			}
		};

		return request;
	});
}

const dropRow = (row) => replaceRow(row, null);

let flushing = null;
let flushAgain = false;
let retryTimer = null;

// Queue keys of uploads the server refused in this page. Each sync flushes
// the queue, so without this a refused file would go up again after every
// save; it waits for the next start, a sign-in, or Retry instead.
const refusedHere = new Set();

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

			if (!user || !navigator.onLine || doc.user_id !== user.id || sessionExpired()) {
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

				if (row.op !== 'delete' && row.error_kind === 'refused' && refusedHere.has(queueKey(row))) {
					continue;
				}

				// A delete waits for the grace period and the server; one
				// whose photo is live again is dropped.
				if (row.op === 'delete') {
					const state = bucketDeleteState(row, doc, serverHolds, Date.now());

					if (state === 'cancel') {
						await dropRow(row).catch(() => {});
					}

					if (state !== 'go') {
						continue;
					}
				}

				try {
					if (row.op === 'delete') {
						await deleteOne(client, row);
					}
					else {
						await uploadOne(client, row, user.id);
					}

					await dropRow(row);

					if (row.op !== DETAIL_OP) {
						pending.delete(row.photo_id);
					}
				}
				catch (err) {
					const message = (err && err.message) || String(err);
					const kind = failureKind(err);

					if (kind === 'refused' && row.op !== 'delete') {
						refusedHere.add(queueKey(row));
					}

					await replaceRow(row, {...row, error: message, error_kind: kind, error_status: statusOf(err) || null}).catch(() => {});

					if (!permanent(err)) {
						// A refused token waits for the session to be refreshed or
						// for a new sign-in (onSession below); with no session
						// left, retrying on a timer would only be refused again.
						retry = kind !== 'auth' || !sessionExpired();

						// Lost the connection (or the session) mid-way: the rest
						// waits too.
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

// ------------------------------------------------------------- sweep

const getAllKeys = (store) => idb(store, 'readonly', (s) => s.getAllKeys());

// Housekeeping after a sync (plans/audit-engineering.md E-21). Removed
// photos leave this phone's storage, whichever phone removed them. A photo
// lives as long as its card's record holds it (js/card-info.js), so a
// deleted copy, or a card at zero copies, never takes a photo with it, and
// nothing here queues a bucket delete: only removing the photo does
// (removePhotoFromEntry). Family members' photos kept here are never
// touched: only photos in this phone's own document are looked at.
export async function sweepPhotos() {
	const doc = await loadDocument();
	const live = new Set();
	const dead = new Set();

	const look = (holder, photo) => {
		if (!photo || !photo.id) {
			return;
		}

		if (!holder.deleted_at && !photo.deleted_at) {
			live.add(photo.id);
		}
		else {
			dead.add(photo.id);
		}
	};

	for (const record of doc.card_info || []) {
		for (const photo of (record && Array.isArray(record.photos) ? record.photos : [])) {
			look(record, photo);
		}
	}

	// A photo still on a copy (waiting for an older phone to upload it) is
	// also on the record; one marked moved is the record's.
	for (const card of doc.cards || []) {
		for (const photo of (card && Array.isArray(card.photos) ? card.photos : [])) {
			if (photo && !photo.moved) {
				look(card, photo);
			}
		}
	}

	for (const id of live) {
		dead.delete(id);
	}

	if (!dead.size) {
		return 0;
	}

	let dropped = 0;

	for (const key of await getAllKeys('blobs').catch(() => [])) {
		if (dead.has(String(key).replace(/#detail$/, ''))) {
			forgetUrl(key);
			await idb('blobs', 'readwrite', (s) => s.delete(key)).catch(() => {});
			dropped++;
		}
	}

	return dropped;
}

// ------------------------------------------------------------- start

let started = false;

// Starts the queue and the photo restore once per page: flushes now, when
// the phone comes back online, when someone signs in, and when a sync
// finishes (a waiting delete may go once the server holds its tombstone);
// restores dropped photos and sweeps removed ones after every sync. Safe to
// call from every view that shows photos.
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
		refusedHere.clear();
		notify();
		flushQueue();
	});
	// The session ended (the photos say to sign in again) or came back (what
	// waited goes up, the same person signing in again included).
	onSession(({expired}) => {
		notify();

		if (!expired) {
			flushQueue();
		}
	});
	onChange((doc, {source}) => {
		if (source === 'sync' || source === 'account') {
			restoreDroppedPhotos().then(() => sweepPhotos()).catch(() => {}).then(() => flushQueue());
		}
	});

	// Every finished sync: the server may now hold a removal a waiting
	// delete needs, and this phone's own deletes are swept.
	onSyncStatus(({phase}) => {
		if (phase === 'synced') {
			sweepPhotos().catch(() => {}).then(() => flushQueue());
		}
	});
	sweepPhotos().catch(() => {}).then(() => flushQueue());
}
