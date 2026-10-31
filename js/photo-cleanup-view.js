// The notice and Review sheet that offer to delete the owner's photos of
// cards that gained an official image (DESIGN.md section 5, "Offer to
// delete photos once the catalog has an image"). The rules are in
// js/photo-cleanup.js.
//
// offerPhotoCleanup() runs after My Cards' background pass (js/cards-view.js),
// which refreshes the saved TCGdex records weekly: the catalog refresh. The
// notice sits with the toasts until Review or Not now; Not now (or closing
// Review) remembers the cards offered, so it shows again only when another
// card gains an image. Delete removes the ticked photos through the normal
// removal, with Undo on a toast.

import {currentUser} from './auth.js';
import {cardImage, cardIndex, savedOwnRecords, saveToCardIndex} from './catalog.js';
import {loadDocument, newId, updateCardInfo} from './collection.js';
import {errorText, h} from './dom.js';
import {plural} from './format.js';
import {
	cleanupCandidates,
	deletedText,
	deletePhotos,
	indexImages,
	initialTicks,
	noticeText,
	readSeen,
	rememberSeen,
	shouldOffer,
	undoDelete,
} from './photo-cleanup.js';
import {localPhoto, photoUrl, removePhotoFromEntry, savePhotoLocally} from './photos/store.js';
import {UNDO_MS} from './reorder.js';
import {openDialogSheet} from './sheet.js';
import {toast} from './shell.js';

const NOTICE_ID = 'photo-cleanup-notice';
const SHEET_ID = 'photo-cleanup-sheet';

const storage = () => {
	try {
		return window.localStorage;
	}
	catch {
		return null;
	}
};

const userId = () => (currentUser() || {}).id || null;

// The cards to offer now, with the index they were read against.
async function findCandidates() {
	const records = ((await loadDocument()).card_info || []).filter((record) => record && !record.deleted_at);
	const [index, saved] = await Promise.all([cardIndex(), savedOwnRecords(records)]);

	return {candidates: cleanupCandidates(records, index, saved), index};
}

let running = null;

// Shows the notice when a card not offered before has gained an image.
// Resolves to the number of cards offered (0 when nothing shows).
export function offerPhotoCleanup() {
	if (!running) {
		running = (async () => {
			const store = storage();

			if (!store || document.getElementById(NOTICE_ID) || document.getElementById(SHEET_ID)) {
				return 0;
			}

			const {candidates, index} = await findCandidates();

			if (!candidates.length || !shouldOffer(candidates, readSeen(store, userId()))) {
				return 0;
			}

			showNotice(candidates, index);

			return candidates.length;
		})().catch(() => 0).finally(() => {
			running = null;
		});
	}

	return running;
}

function showNotice(candidates, index) {
	const box = document.getElementById('toasts');

	if (!box) {
		return;
	}

	const notice = h('div', {class: 'toast', id: NOTICE_ID, role: 'status'},
		h('span', {class: 'toast-text'}, noticeText(candidates)),
		h('button', {class: 'small', onclick: () => {
			notice.remove();
			openReview(candidates, index);
		}, type: 'button'}, 'Review'),
		h('button', {class: 'small', onclick: () => {
			notice.remove();
			rememberSeen(storage(), userId(), candidates.map((item) => item.key));
		}, type: 'button'}, 'Not now'));

	box.append(notice);
}

function photoImage(photo) {
	const img = h('img', {alt: 'Your photo', class: 'pc-photo', height: 140, loading: 'lazy', width: 100});

	photoUrl(photo).then((url) => {
		if (url) {
			img.src = url;
		}
	}).catch(() => {});

	return img;
}

function openReview(candidates, index) {
	const ticks = initialTicks(candidates);
	const deleteButton = h('button', {class: 'primary pc-delete', type: 'button'});
	const draw = () => {
		deleteButton.textContent = `Delete ${plural(ticks.size, 'photo')}`;
		deleteButton.disabled = !ticks.size;
	};

	const art = 'display: block; width: 100%; aspect-ratio: 63 / 88; object-fit: cover; border-radius: 6px; background: var(--surface-2, #0002);';

	const rows = candidates.flatMap((item) => item.photos.map(({photo, pinned}) => {
		const box = h('input', {checked: ticks.has(photo.id), class: 'pc-tick', 'data-photo': photo.id, type: 'checkbox'});

		box.addEventListener('change', () => {
			if (box.checked) {
				ticks.add(photo.id);
			}
			else {
				ticks.delete(photo.id);
			}

			draw();
		});

		const official = h('img', {alt: 'Official image', class: 'pc-official', height: 140, src: cardImage(item.image, 'low'), width: 100});
		const mine = photoImage(photo);
		const note = h('span', {class: 'muted'}, pinned ? ' (your main image)' : '');
		const row = h('li', {class: 'pc-row', 'data-card': item.key, style: 'margin-bottom: 12px;'},
			h('label', {style: 'align-items: center; display: flex; gap: 8px; margin-bottom: 6px;'}, box,
				h('span', null, item.name, note)),
			h('div', {style: 'display: grid; gap: 8px; grid-template-columns: repeat(2, 96px);'}, official, mine));

		official.setAttribute('style', art);
		mine.setAttribute('style', art);

		// An official image that does not load is no reason to delete the
		// photo: the row is unticked, cannot be ticked, and says why.
		official.addEventListener('error', () => {
			box.checked = false;
			box.disabled = true;
			ticks.delete(photo.id);
			row.classList.add('pc-broken');
			note.textContent = ' (the official image did not load)';
			draw();
		}, {once: true});

		return row;
	}));

	const dialog = h('dialog', {'aria-labelledby': `${SHEET_ID}-title`, class: 'sheet', id: SHEET_ID, style: 'overflow-y: auto;'},
		h('div', {class: 'sheet-head'},
			h('h2', {id: `${SHEET_ID}-title`}, 'Photos you can delete'),
			h('button', {class: 'small', onclick: () => dialog.close(), type: 'button'}, 'Close')),
		h('p', {class: 'muted'}, 'Each card shows its official image beside your photo. Ticked photos are deleted; your main image is left unticked.'),
		h('ul', {style: 'list-style: none; margin: 0; padding: 0;'}, rows),
		deleteButton);

	let deleting = false;
	let failedKeys = new Set();

	deleteButton.addEventListener('click', async () => {
		if (deleting || !ticks.size) {
			return;
		}

		deleting = true;
		deleteButton.disabled = true;

		// The card index takes the official images first, so no card is
		// left with neither a photo nor an image; when that fails nothing
		// is deleted.
		try {
			const records = indexImages(candidates, index, candidates.filter((item) => item.photos.some((entry) => ticks.has(entry.photo.id))).map((item) => item.card));

			if (records.length) {
				await saveToCardIndex(records);
			}
		}
		catch (err) {
			deleting = false;
			draw();
			toast(`Could not delete the photos. ${errorText(err)}`);

			return;
		}

		const result = await deletePhotos(candidates, ticks, {readBlob: localPhoto, remove: removePhotoFromEntry});
		const {error, left, removed} = result;
		const text = error ? `${deletedText(result)} ${errorText(error)}` : deletedText(result);

		// A card with a photo left over is offered again next time.
		failedKeys = new Set(left.map((entry) => entry.key));
		dialog.close();
		toast(text, removed.length ? {
			action: () => undoDelete(removed, {newId, saveBlob: savePhotoLocally, update: updateCardInfo})
				.catch((err) => toast(`Could not bring them back. ${errorText(err)}`)),
			actionLabel: 'Undo',
			timeout: UNDO_MS,
		} : {});
	});

	dialog.addEventListener('click', (event) => {
		if (event.target === dialog) {
			dialog.close();
		}
	});
	dialog.addEventListener('close', () => {
		rememberSeen(storage(), userId(), candidates.map((item) => item.key).filter((key) => !failedKeys.has(key)));
		dialog.remove();
	});

	draw();
	document.getElementById(SHEET_ID)?.remove();
	document.body.append(dialog);
	openDialogSheet(dialog);

	return dialog;
}
