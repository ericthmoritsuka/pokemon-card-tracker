// A binder's cover image (DESIGN.md section 11, "Cover image"): a photo of
// the real binder or any picture, cropped to the cover's shape with the
// photos module's tools (js/photos/encode.js straighten and encodePhoto),
// kept on this phone, and stored in the card-photos bucket beside the card
// photos.
//
// The binder entry carries the record, {id, path, type, at}
// (js/binders.js cover_image). The picture itself lives:
//   - on this phone, in IndexedDB card-tracker-binder-covers, so the cover
//     shows with no connection;
//   - in the bucket at <user_id>/binder-<binder_id>/<image_id>.webp, a path
//     of the one shape supabase/photos.sql already allows (three parts, the
//     owner's id first), so the owner and their family group can read it. A
//     new picture gets a new id, so no cache ever serves an old cover.
// Taken signed out or offline, it waits in an upload queue here and goes up
// when there is signal and someone is signed in, as card photos do. A
// replaced or deleted cover leaves the phone at once, but its bucket file
// waits for the grace period and for the server to hold the binder version
// that dropped it (js/photos/model.js bucketDeleteState), since another
// phone may still show it.
//
//   pickCoverImage({binder})   the sheet: choose or take a picture, fit its
//                              four corners, save; or take the image away
//   coverImageUrl(binder)      an object URL for the cover, or null
//   paintCover(node, binder)   puts the cover color and image on an element
//                              (a binder list cover, the spread's board)
//   dropBinderCover(binder)    a deleted binder's cover off the bucket and
//                              the phone
//   sweepCovers()              this person's pictures kept on this phone
//                              that no live binder uses any more, dropped
//   onCoversChange(listener)   runs after each pass over the upload queue,
//                              so a view can repaint a cover that arrived
//   coverPath(...)             the bucket path for a cover image

import {currentUser, getClient, onUser} from './auth.js';
import {coverAspect} from './binder-spread.js';
import {coverImageOf, coverTextColor, DEFAULT_COVER, getBinder, isHex, setCoverImage} from './binders.js';
import {loadDocument, newId, nowIso} from './collection.js';
import {h} from './dom.js';
import {database} from './idb.js';
import {detectCorners} from './photos/detect.js';
import {decodeImageFile, drawScaled, encodePhoto, pixelsOf, putPixels, straighten} from './photos/encode.js';
import {clampPoint, scaleCorners, warp} from './photos/geometry.js';
import {BUCKET_DELETE_GRACE_MS, PHOTO_BUCKET, bucketDeleteState, photoExtension} from './photos/model.js';
import {openSheet} from './sheet.js';
import {onSyncStatus, serverHolds} from './sync.js';

const DB_NAME = 'card-tracker-binder-covers';
const STORES = ['blobs', 'queue'];
const COVER_WIDTH = 600;
const COVER_BYTES = 90 * 1024;
const PREVIEW_SOURCE = 960;
const PREVIEW_WIDTH = 180;
const RETRY_MS = 30 * 1000;

export const coverPath = (userId, binderId, imageId, type = 'image/webp') => `${userId}/binder-${binderId}/${imageId}.${photoExtension(type)}`;

// The cover's size in pixels for a grid: COVER_WIDTH wide, as tall as the
// cover's shape makes it.
export function coverSize(binder) {
	const aspect = coverAspect(binder.rows || 3, binder.cols || 3);

	return {height: Math.round(COVER_WIDTH / aspect), width: COVER_WIDTH};
}

// ------------------------------------------------------------- storage

const phoneDb = database(DB_NAME, STORES);
const openDb = phoneDb.open;
const idb = phoneDb.run;

export const localCover = async (imageId) => {
	const row = await idb('blobs', 'readonly', (s) => s.get(imageId));

	return row ? row.blob : null;
};

// `path` is the image's bucket path (null until it is known); `mine` marks a
// cover saved on this phone. The sweep below uses both to tell this
// person's covers from a family member's.
const saveLocal = (imageId, blob, {mine = false, path = null} = {}) => idb('blobs', 'readwrite', (s) => s.put({at: Date.now(), blob, mine, path, type: blob.type}, imageId));

const urls = new Map();
const fetching = new Map();
const failedAt = new Map();

function remember(imageId, blob) {
	if (!urls.has(imageId)) {
		urls.set(imageId, URL.createObjectURL(blob));
	}

	return urls.get(imageId);
}

async function forgetLocal(imageId) {
	const url = urls.get(imageId);

	if (url) {
		URL.revokeObjectURL(url);
		urls.delete(imageId);
	}

	await idb('blobs', 'readwrite', (s) => s.delete(imageId));
}

// An object URL for the binder's cover image: from this session, from the
// phone, or from the bucket (then kept on the phone). Null when there is no
// image, or none of them has it right now.
export function coverImageUrl(binder) {
	const image = coverImageOf(binder);

	if (!image) {
		return Promise.resolve(null);
	}

	if (urls.has(image.id)) {
		return Promise.resolve(urls.get(image.id));
	}

	startCoverSync();

	if (!fetching.has(image.id)) {
		fetching.set(image.id, (async () => {
			const local = await localCover(image.id).catch(() => null);

			if (local) {
				return remember(image.id, local);
			}

			if (!image.path || !currentUser() || !navigator.onLine || Date.now() - (failedAt.get(image.id) || 0) < RETRY_MS) {
				return null;
			}

			try {
				const client = await getClient();
				const {data, error} = await client.storage.from(PHOTO_BUCKET).download(image.path);

				if (error || !data) {
					throw error || new Error('No cover image there.');
				}

				await saveLocal(image.id, data, {path: image.path}).catch(() => {});
				failedAt.delete(image.id);

				return remember(image.id, data);
			}
			catch {
				failedAt.set(image.id, Date.now());

				return null;
			}
		})().finally(() => fetching.delete(image.id)));
	}

	return fetching.get(image.id);
}

// Puts the binder's cover on an element: --cover and --cover-text always,
// and --cover-image with data-cover-image="true" once the picture is ready.
// Returns a promise that settles when the image is on (or known missing).
export function paintCover(node, binder) {
	const color = isHex(binder.cover_color) ? binder.cover_color : DEFAULT_COVER;
	const image = coverImageOf(binder);

	node.style.setProperty('--cover', color);
	node.style.setProperty('--cover-text', coverTextColor(color));
	node.dataset.coverKey = image ? image.id : '';

	if (!image) {
		node.style.removeProperty('--cover-image');
		delete node.dataset.coverImage;

		return Promise.resolve(false);
	}

	return coverImageUrl(binder).then((url) => {
		if (url && node.dataset.coverKey === image.id) {
			node.style.setProperty('--cover-image', `url("${url}")`);
			node.dataset.coverImage = 'true';

			return true;
		}

		return false;
	});
}

// ------------------------------------------------------------- the queue

const listeners = new Set();

// listener() runs when an upload finishes or the queue changes.
export function onCoversChange(listener) {
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

const permanent = (err) => {
	const status = Number(err && (err.status || err.statusCode));

	return status >= 400 && status < 500 && status !== 408 && status !== 429;
};

let flushing = null;
let again = false;
let retryTimer = null;

// Sends the queue, oldest first: uploads, then the record's path filled in,
// and deletes of replaced covers. Waits while offline, signed out, or when
// the phone's document is another account's.
export function flushCovers() {
	if (flushing) {
		again = true;

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

			const rows = (await idb('queue', 'readonly', (s) => s.getAll())).sort((a, b) => a.at - b.at);

			if (!rows.length) {
				return;
			}

			const client = await getClient();

			for (const row of rows) {
				if (row.user_id && row.user_id !== user.id) {
					continue;
				}

				// A delete waits for the grace period and the server; one whose
				// cover is back on a live binder is dropped.
				if (row.op === 'delete') {
					const state = bucketDeleteState(row, doc, serverHolds, Date.now());

					if (state === 'cancel') {
						await idb('queue', 'readwrite', (s) => s.delete(row.key)).catch(() => {});
					}

					if (state !== 'go') {
						continue;
					}
				}

				try {
					if (row.op === 'delete') {
						const {error} = await client.storage.from(PHOTO_BUCKET).remove([row.path]);

						if (error) {
							throw error;
						}
					}
					else {
						await uploadOne(client, row, user.id);
					}

					await idb('queue', 'readwrite', (s) => s.delete(row.key));
				}
				catch (err) {
					await idb('queue', 'readwrite', (s) => s.put({...row, error: (err && err.message) || String(err)}, row.key)).catch(() => {});

					if (!permanent(err)) {
						retry = true;

						break;
					}
				}
			}
		}
		catch {
			retry = true;
		}
		finally {
			notify();

			if (retry && navigator.onLine && !retryTimer) {
				retryTimer = setTimeout(() => {
					retryTimer = null;
					flushCovers();
				}, RETRY_MS);
			}
		}
	})().finally(() => {
		flushing = null;

		if (again) {
			again = false;
			flushCovers();
		}
	});

	return flushing;
}

async function uploadOne(client, row, userId) {
	const binder = await getBinder(row.binder_id);
	const image = coverImageOf(binder);

	// The binder was deleted or its cover changed before this went up.
	if (!binder || !image || image.id !== row.image_id) {
		return;
	}

	const blob = await localCover(row.image_id);

	if (!blob) {
		return;
	}

	const path = image.path || coverPath(userId, binder.id, image.id, image.type || blob.type);
	const {error} = await client.storage.from(PHOTO_BUCKET).upload(path, await blob.arrayBuffer(), {
		cacheControl: '31536000',
		contentType: image.type || blob.type || 'image/webp',
		upsert: true,
	});

	if (error) {
		throw error;
	}

	if (image.path !== path) {
		// Filling in the path is not choosing the cover again (fill).
		await setCoverImage(binder.id, {...image, path}, {fill: true});
	}
}

const enqueue = (row) => idb('queue', 'readwrite', (s) => s.put({at: Date.now(), error: null, ...row}, row.key));

let started = false;

// Flushes now, when the phone comes back online, on sign-in, and when a
// sync finishes (a waiting delete may go once the server holds the binder
// version that dropped the cover, and other phones' deletes are swept).
// Safe to call from every view that shows covers.
export function startCoverSync() {
	if (started) {
		return;
	}

	started = true;
	window.addEventListener('online', () => {
		failedAt.clear();
		flushCovers();
	});
	onUser(() => {
		failedAt.clear();
		flushCovers();
	});

	onSyncStatus(({phase}) => {
		if (phase === 'synced') {
			sweepCovers().catch(() => {}).then(() => flushCovers());
		}
	});
	sweepCovers().catch(() => {}).then(() => flushCovers());
}

// Housekeeping (plans/audit-engineering.md E-21): drops this person's
// cover pictures that no live binder of theirs shows any more, which
// another phone deleted or replaced. A family member's covers kept here are
// left alone, and so is anything a live binder still shows.
export async function sweepCovers() {
	const doc = await loadDocument();
	const binders = (doc.binders || []).filter(Boolean);
	const shown = new Set(binders.filter((binder) => !binder.deleted_at).map((binder) => coverImageOf(binder)).filter(Boolean).map((image) => image.id));
	const ofDeleted = new Set(binders.filter((binder) => binder.deleted_at).map((binder) => coverImageOf(binder)).filter(Boolean).map((image) => image.id));
	// A picture still waiting to upload, or shown in this session, stays.
	const waiting = new Set((await idb('queue', 'readonly', (s) => s.getAll())).filter((row) => row.op === 'upload').map((row) => row.image_id));
	const db = await openDb();
	const [keys, rows] = await new Promise((resolve, reject) => {
		const tx = db.transaction('blobs', 'readonly');
		const keyRequest = tx.objectStore('blobs').getAllKeys();
		const rowRequest = tx.objectStore('blobs').getAll();

		tx.oncomplete = () => resolve([keyRequest.result, rowRequest.result]);
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
	let dropped = 0;

	for (let i = 0; i < keys.length; i++) {
		const row = rows[i] || {};
		const mine = row.mine || (doc.user_id && row.path && String(row.path).split('/')[0] === doc.user_id);
		// A cover saved this minute may not be on its binder yet; a deleted
		// binder's cover never comes back.
		const settled = !(Date.now() - Number(row.at) < 60 * 1000);

		// A deleted binder's cover goes even if it was shown this session.
		if (!ofDeleted.has(keys[i]) && (waiting.has(keys[i]) || urls.has(keys[i]))) {
			continue;
		}

		if (!shown.has(keys[i]) && (ofDeleted.has(keys[i]) || (mine && settled))) {
			await forgetLocal(keys[i]).catch(() => {});
			dropped++;
		}
	}

	return dropped;
}

// Saves an encoded cover for a binder: on the phone at once, the record on
// the binder, the upload queued, and the cover it replaces deleted.
export async function saveCoverImage(binderId, blob, type = blob.type) {
	const doc = await loadDocument();
	const before = coverImageOf(await getBinder(binderId));
	const id = newId();
	const image = {at: nowIso(), id, path: doc.user_id ? coverPath(doc.user_id, binderId, id, type) : null, type};

	await saveLocal(id, blob, {mine: true, path: image.path});
	remember(id, blob);

	const saved = await setCoverImage(binderId, image);

	await enqueue({binder_id: binderId, image_id: id, key: `upload:${id}`, op: 'upload', type, user_id: doc.user_id || null});

	if (before) {
		await dropOld(before, binderId);
	}

	startCoverSync();
	flushCovers();

	return saved;
}

// Takes the image off the cover: the color shows again.
export async function removeCoverImage(binderId) {
	const before = coverImageOf(await getBinder(binderId));
	const saved = await setCoverImage(binderId, null);

	if (before) {
		await dropOld(before, binderId);
	}

	startCoverSync();
	flushCovers();

	return saved;
}

// A deleted binder's cover: a waiting upload is dropped, the file's delete
// from the bucket is queued (it goes after the grace period, once the
// server holds the deleted binder, and a failed try is retried as uploads
// are), and the phone's copy goes. Best
// effort: it never throws, since the binder is gone either way and a cover
// left behind only takes space. Resolves true when there was a cover and it
// was dropped.
export async function dropBinderCover(binder) {
	const image = coverImageOf(binder);

	if (!image) {
		return false;
	}

	try {
		await dropOld(image, binder.id);
		startCoverSync();
		flushCovers();

		return true;
	}
	catch {
		return false;
	}
}

async function dropOld(image, binderId) {
	await idb('queue', 'readwrite', (s) => s.delete(`upload:${image.id}`)).catch(() => {});

	if (image.path) {
		const at = Date.now();

		await enqueue({
			at,
			entry_id: binderId || null,
			image_id: image.id,
			key: `delete:${image.id}`,
			list: 'binders',
			not_before: at + BUCKET_DELETE_GRACE_MS,
			op: 'delete',
			path: image.path,
			user_id: image.path.split('/')[0],
		});
	}

	await forgetLocal(image.id).catch(() => {});
}

// ------------------------------------------------------------- the sheet

const CORNERS = ['Top-left', 'Top-right', 'Bottom-right', 'Bottom-left'];

// A cover-shaped box, 90 percent of the largest that fits, in the middle.
function startCorners(width, height, aspect) {
	let h = height * 0.9;
	let w = h * aspect;

	if (w > width * 0.9) {
		w = width * 0.9;
		h = w / aspect;
	}

	const x = (width - w) / 2;
	const y = (height - h) / 2;

	return [{x, y}, {x: x + w, y}, {x: x + w, y: y + h}, {x, y: y + h}];
}

// Opens the Cover image sheet for a binder. onSaved(binder) runs after a
// new image is saved or the image is taken away. Returns {close, element}.
// It is a js/sheet.js sheet: Escape, the system Back, and a route change
// close it too.
export function pickCoverImage({binder, onSaved = null}) {
	const size = coverSize(binder);
	const aspect = size.width / size.height;
	const title = h('h2', {class: 'ph-sheet-title', id: 'bc-title'}, 'Cover image');
	const dismiss = h('button', {'aria-label': 'Close', class: 'ph-sheet-close', id: 'bc-close', type: 'button'}, '×');
	const body = h('div', {class: 'ph-sheet-body'});
	const sheet = h('div', {
		'aria-labelledby': 'bc-title',
		'aria-modal': 'true',
		class: 'ph-sheet bc-sheet',
		'data-swipe-own': true,
		id: 'bc-sheet',
		role: 'dialog',
	}, h('div', {class: 'ph-sheet-head'}, title, dismiss), body);
	let closed = false;

	// Nothing under the sheet (the page swipe, the arrow keys) reacts.
	for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown']) {
		sheet.addEventListener(type, (event) => event.stopPropagation(), {passive: true});
	}

	let handle = null;

	function close() {
		if (handle) {
			handle.close();
		}
	}

	const message = (text, kind = 'muted') => h('p', {class: `ph-message ${kind}`, role: kind === 'error' ? 'alert' : null}, text);

	// Rewrites a message in place, so a second error shows as the first did.
	function setMessage(element, text, kind = 'muted') {
		element.className = `ph-message ${kind}`;

		if (kind === 'error') {
			element.setAttribute('role', 'alert');
		}
		else {
			element.removeAttribute('role');
		}

		element.textContent = text;
	}

	function start(note = null) {
		title.textContent = 'Cover image';

		const gallery = h('input', {accept: 'image/*', class: 'ph-file', id: 'bc-file', type: 'file'});
		const camera = h('input', {accept: 'image/*', capture: 'environment', class: 'ph-file', id: 'bc-camera', type: 'file'});
		const current = coverImageOf(binder);
		const remove = current
			? h('button', {class: 'danger', id: 'bc-remove', type: 'button'}, 'Use the cover color instead')
			: null;

		for (const input of [gallery, camera]) {
			input.addEventListener('change', () => {
				const file = input.files && input.files[0];

				if (file) {
					open(file);
				}
			});
		}

		if (remove) {
			remove.addEventListener('click', async () => {
				remove.disabled = true;

				try {
					const saved = await removeCoverImage(binder.id);

					close();

					if (onSaved) {
						onSaved(saved);
					}
				}
				catch (err) {
					if (!closed) {
						remove.disabled = false;
						start(message(`Could not change the cover: ${(err && err.message) || err}`, 'error'));
					}
				}
			});
		}

		body.replaceChildren(
			note || '',
			h('p', {class: 'muted'}, 'A photo of your real binder, or any picture. You fit it to the cover\'s shape next.'),
			h('div', {class: 'ph-actions'},
				h('button', {class: 'primary', id: 'bc-pick', onclick: () => gallery.click(), type: 'button'}, 'Choose a picture'),
				h('button', {id: 'bc-take', onclick: () => camera.click(), type: 'button'}, 'Take a photo'),
				remove,
				h('button', {id: 'bc-cancel', onclick: close, type: 'button'}, 'Cancel')),
			gallery,
			camera
		);
		body.querySelector('#bc-pick').focus({preventScroll: true});
	}

	async function open(file) {
		body.replaceChildren(message('Opening the picture…'));

		try {
			const source = await decodeImageFile(file);

			if (!closed) {
				fit(source);
			}
		}
		catch (err) {
			if (!closed) {
				start(message((err && err.message) || String(err), 'error'));
			}
		}
	}

	// The four corners, as the card photo editor places them: drag a corner,
	// or move it with the arrow keys; the preview is the cover as it saves.
	function fit(source) {
		title.textContent = 'Fit the cover';

		const previewSource = drawScaled(source, source.width, source.height, PREVIEW_SOURCE);
		const previewPixels = pixelsOf(previewSource);
		const toPreview = previewSource.width / source.width;
		const previewHeight = Math.round(PREVIEW_WIDTH / aspect);
		// The card finder looks for a straight-edged shape about a card's
		// proportions, which a photo of a binder on a table often is; when it
		// finds none, a cover-shaped box in the middle.
		const found = detectCorners(previewPixels);
		const initial = found.found
			? scaleCorners(found.corners, 1 / toPreview)
			: startCorners(source.width, source.height, aspect);
		let corners = initial.map((p) => ({...p}));
		let scale = 1;
		let frame = 0;

		const photo = h('canvas', {'aria-hidden': 'true', class: 'ph-photo'});
		const outline = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		const shape = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
		const handles = CORNERS.map((name, i) => h('button', {
			'aria-label': `${name} corner. Drag, or use the arrow keys.`,
			class: 'bc-handle',
			'data-corner': i,
			type: 'button',
		}));
		const stage = h('div', {class: 'ph-stage bc-stage', id: 'bc-stage'}, photo, outline, ...handles);
		const preview = h('canvas', {'aria-label': 'The cover as it will look', class: 'bc-preview', height: previewHeight, id: 'bc-preview', role: 'img', width: PREVIEW_WIDTH});
		const save = h('button', {class: 'primary', id: 'bc-save', type: 'button'}, 'Save cover');
		const reset = h('button', {id: 'bc-reset', type: 'button'}, 'Reset corners');
		const again = h('button', {id: 'bc-again', type: 'button'}, 'Another picture');
		const status = message(found.found
			? 'Found the edges. Drag a corner if it is off, or around the part of the picture you want.'
			: 'Drag the corners onto the cover\'s corners, or around the part of the picture you want.');
		const buffer = new Uint8ClampedArray(PREVIEW_WIDTH * previewHeight * 4);

		outline.setAttribute('class', 'ph-outline');
		outline.setAttribute('aria-hidden', 'true');
		outline.append(shape);
		preview.style.aspectRatio = `${size.width} / ${size.height}`;

		body.replaceChildren(stage, h('div', {class: 'ph-review bc-review'}, preview, h('div', {class: 'ph-review-actions'}, save, reset, again)), status);

		function layout() {
			const room = Math.min(stage.parentElement.clientWidth || 328, 560);
			const maxHeight = Math.max(220, Math.round(window.innerHeight * 0.46));
			const fitScale = Math.min(room / source.width, maxHeight / source.height);
			const width = Math.round(source.width * fitScale);
			const height = Math.round(source.height * fitScale);
			const dpr = Math.min(2, window.devicePixelRatio || 1);

			scale = fitScale;
			photo.width = Math.round(width * dpr);
			photo.height = Math.round(height * dpr);
			photo.style.width = `${width}px`;
			photo.style.height = `${height}px`;
			stage.style.width = `${width}px`;
			stage.style.height = `${height}px`;
			outline.setAttribute('viewBox', `0 0 ${width} ${height}`);
			outline.setAttribute('width', String(width));
			outline.setAttribute('height', String(height));
			photo.getContext('2d').drawImage(source, 0, 0, photo.width, photo.height);
			overlay();
		}

		function overlay() {
			shape.setAttribute('points', corners.map((p) => `${p.x * scale},${p.y * scale}`).join(' '));
			handles.forEach((handle, i) => {
				handle.style.transform = `translate(${corners[i].x * scale}px, ${corners[i].y * scale}px)`;
			});
		}

		function drawPreview() {
			frame = 0;
			putPixels(preview, warp(previewPixels, scaleCorners(corners, toPreview), PREVIEW_WIDTH, previewHeight, buffer));
			preview.dataset.version = String(Number(preview.dataset.version || 0) + 1);
		}

		function schedule() {
			overlay();

			if (!frame) {
				frame = requestAnimationFrame(drawPreview);
			}
		}

		handles.forEach((handle, i) => {
			let drag = null;

			handle.addEventListener('pointerdown', (event) => {
				event.preventDefault();
				drag = {id: event.pointerId, start: {...corners[i]}, x: event.clientX, y: event.clientY};
				handle.setPointerCapture(event.pointerId);
				handle.classList.add('bc-dragging');
			});
			handle.addEventListener('pointermove', (event) => {
				if (drag && event.pointerId === drag.id) {
					corners[i] = clampPoint({x: drag.start.x + ((event.clientX - drag.x) / scale), y: drag.start.y + ((event.clientY - drag.y) / scale)}, source.width, source.height);
					schedule();
				}
			});

			const end = (event) => {
				if (drag && event.pointerId === drag.id) {
					drag = null;
					handle.classList.remove('bc-dragging');
					schedule();
				}
			};

			handle.addEventListener('pointerup', end);
			handle.addEventListener('pointercancel', end);
			handle.addEventListener('keydown', (event) => {
				const step = (event.shiftKey ? 10 : 1) / scale;
				const move = {ArrowDown: [0, step], ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step]}[event.key];

				if (move) {
					event.preventDefault();
					corners[i] = clampPoint({x: corners[i].x + move[0], y: corners[i].y + move[1]}, source.width, source.height);
					schedule();
				}
			});
		});

		reset.addEventListener('click', () => {
			corners = initial.map((p) => ({...p}));
			schedule();
		});
		again.addEventListener('click', () => start());
		save.addEventListener('click', async () => {
			save.disabled = true;
			save.textContent = 'Saving…';

			try {
				const cover = straighten(source, corners, size.width, size.height);
				const {blob, type} = await encodePhoto(cover, {target: COVER_BYTES});
				const saved = await saveCoverImage(binder.id, blob, type);

				sheet.dataset.saved = (saved && saved.cover_image && saved.cover_image.id) || '';
				close();

				if (onSaved) {
					onSaved(saved);
				}
			}
			catch (err) {
				save.disabled = false;
				save.textContent = 'Save cover';
				setMessage(status, `Could not save the cover: ${(err && err.message) || err}`, 'error');
			}
		});

		layout();
		drawPreview();
		handles[0].focus({preventScroll: true});
	}

	dismiss.addEventListener('click', close);
	handle = openSheet(sheet, {
		onClose() {
			closed = true;
		},
	});
	start();

	return {close, element: sheet};
}

