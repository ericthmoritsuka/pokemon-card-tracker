// Binders (DESIGN.md section 11, "Binders"): one entry per real binder, with
// a grid, a page count, and the pockets that hold something.
//
// A binder is an entry in the person's binders list (DESIGN.md section 4):
//   {id, name, notes, cover_color, rows, cols, page_count, slots, art,
//    created_at, updated_at, deleted_at}
// and, when set, two optional fields:
//   cover_image  {id, path, type, at}: a picture shown as the cover instead
//                of the color (js/binder-cover.js keeps the image itself);
//                path is null until it is uploaded
//   preset       the quick pick it was made with (js/binder-presets.js),
//                such as "9-pocket-zip", or "custom"
// A slot is one pocket that holds something. A pocket with no slot is
// empty. Pages and positions count from 1, and a position runs across each
// row, then down: on a 3 x 3 page, pocket 4 is row 2, column 1. Each slot is
// one of:
//   {page, position, placed_at, entry_id}      an owned card (one copy)
//   {page, position, placed_at, want}          a placeholder, with want =
//       {card_id, catalog, variant_id, name, image} for a card not owned
//   {page, position, placed_at, empty: true}   left empty on purpose
//   {page, position, art}                      a tile of Michi art (not
//       edited here yet; kept as it is)
//
// A binder is a physical place, so a card entry sits in at most one pocket
// across every binder (DESIGN.md section 3). Placing a copy takes it out of
// wherever it was. Two phones can still disagree after a merge, since the
// merge keeps the newer version of each binder as a whole: one phone moves a
// copy from binder A to binder B while the other edits A. Then the copy is in
// both, and the slot placed last (placed_at) is the real one; the other is
// read as empty and dropped the next time that binder is saved.
//
// The pure functions take the binders and the time, so Node can test them
// (tests/binders.test.mjs). The rest read and save the document on the phone.

import {isLive, loadDocument, mergeIntoLocal, newId, nowIso} from './collection.js';

export const MAX_PAGES = 200;

export const GRID_PICKS = [[2, 2], [3, 3], [3, 4], [4, 4]];

// Cover colors offered as swatches; any other color can be picked by hand.
export const COVER_SWATCHES = [
	{color: '#1b1b1f', name: 'Black'},
	{color: '#1d2e60', name: 'Navy'},
	{color: '#306cb3', name: 'Blue'},
	{color: '#dc0a2d', name: 'Red'},
	{color: '#ffcb05', name: 'Yellow'},
	{color: '#2e8b57', name: 'Green'},
	{color: '#6a3fa0', name: 'Purple'},
	{color: '#e86fa5', name: 'Pink'},
	{color: '#8a8a94', name: 'Grey'},
	{color: '#f4f4f6', name: 'White'},
];

export const DEFAULT_COVER = COVER_SWATCHES[1].color;

const isWhole = (n) => Number.isInteger(n);

// Grids run from 1 x 1 to 5 x 4, either way up: 5 rows of 4 or 4 rows of 5,
// never 5 x 5.
export function validGrid(rows, cols) {
	return isWhole(rows) && isWhole(cols) && rows >= 1 && cols >= 1
		&& ((rows <= 5 && cols <= 4) || (rows <= 4 && cols <= 5));
}

export const pocketsPerPage = (binder) => binder.rows * binder.cols;

export const totalPockets = (binder) => pocketsPerPage(binder) * binder.page_count;

// The row and column of a position, both from 1.
export function cellOf(binder, position) {
	return {col: ((position - 1) % binder.cols) + 1, row: Math.floor((position - 1) / binder.cols) + 1};
}

export const positionOf = (binder, row, col) => ((row - 1) * binder.cols) + col;

// The page a pocket number across the whole binder falls on, and its
// position there: pocket 10 of a 3 x 3 binder is page 2, position 1.
export function pageOfPocket(binder, pocket) {
	const per = pocketsPerPage(binder);

	return {page: Math.floor((pocket - 1) / per) + 1, position: ((pocket - 1) % per) + 1};
}

export const clampPage = (binder, page) => Math.min(Math.max(1, Number.parseInt(page, 10) || 1), binder.page_count);

export const inGrid = (binder, slot) => isWhole(slot.page) && isWhole(slot.position)
	&& slot.page >= 1 && slot.page <= binder.page_count
	&& slot.position >= 1 && slot.position <= pocketsPerPage(binder);

export const slotKind = (slot) => (slot.entry_id ? 'card' : slot.want ? 'want' : slot.art ? 'art' : slot.empty ? 'empty' : null);

export const isHex = (value) => /^#[0-9a-f]{6}$/i.test(String(value || ''));

// White or near-black text, whichever reads better on the cover.
export function coverTextColor(hex) {
	if (!isHex(hex)) {
		return '#ffffff';
	}

	const channel = (i) => {
		const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;

		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	const luminance = (0.2126 * channel(1)) + (0.7152 * channel(3)) + (0.0722 * channel(5));
	const onWhite = 1.05 / (luminance + 0.05);
	const onDark = (luminance + 0.05) / 0.0607;

	return onWhite >= onDark ? '#ffffff' : '#1b1b1f';
}

// The editable fields, checked and tidied. Throws with a message a person
// can act on.
export function cleanFields(fields) {
	const name = String(fields.name ?? '').trim();
	const rows = Number(fields.rows);
	const cols = Number(fields.cols);
	const pageCount = Number(fields.page_count);
	const color = String(fields.cover_color || '').trim();

	if (!name) {
		throw new Error('A binder needs a name.');
	}

	if (!validGrid(rows, cols)) {
		throw new Error('Pick a grid from 1 x 1 up to 5 x 4 or 4 x 5.');
	}

	if (!isWhole(pageCount) || pageCount < 1 || pageCount > MAX_PAGES) {
		throw new Error(`Pages run from 1 to ${MAX_PAGES}.`);
	}

	const preset = cleanPreset(fields.preset);

	return {
		cols,
		cover_color: isHex(color) ? color.toLowerCase() : DEFAULT_COVER,
		name,
		notes: String(fields.notes ?? '').trim(),
		page_count: pageCount,
		rows,
		// Only when the form passed one, so older callers save what they did.
		...(preset ? {preset} : {}),
	};
}

// A preset id as js/binder-presets.js names them, or null.
export function cleanPreset(value) {
	const id = String(value ?? '').trim();

	return /^[a-z0-9][a-z0-9-]{0,31}$/.test(id) ? id : null;
}

export const COVER_IMAGE_TYPES = ['image/webp', 'image/jpeg'];

// A cover image record, checked: {id, path, type, at}, or null. path stays
// null until the upload knows the user (js/binder-cover.js).
export function cleanCoverImage(value) {
	if (!value || typeof value !== 'object') {
		return null;
	}

	const id = String(value.id || '');
	const path = value.path ? String(value.path) : null;

	if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
		return null;
	}

	return {
		at: String(value.at || ''),
		id,
		path,
		type: COVER_IMAGE_TYPES.includes(value.type) ? value.type : 'image/webp',
	};
}

export const coverImageOf = (binder) => cleanCoverImage(binder && binder.cover_image);

// A stamp strictly newer than the entry's last one, so the merge always
// takes the new version even when two edits land in one millisecond.
export function nextStamp(previous, now = Date.now()) {
	const before = Date.parse(previous);

	return new Date(Number.isNaN(before) || now > before ? now : before + 1).toISOString();
}

export const liveBinders = (binders) => (binders || []).filter((binder) => binder && isLive(binder));

// Where every placed copy is: Map entry_id -> {binder, slot}. A copy found in
// more than one pocket (two phones disagreeing, see above) goes to the slot
// placed last; ties go to the binder id, then the page and position, so
// every phone picks the same one.
export function placements(binders) {
	const out = new Map();

	const wins = (a, b) => {
		const timeA = String(a.slot.placed_at || '');
		const timeB = String(b.slot.placed_at || '');

		if (timeA !== timeB) {
			return timeA > timeB;
		}

		if (a.binder.id !== b.binder.id) {
			return String(a.binder.id) < String(b.binder.id);
		}

		return a.slot.page !== b.slot.page ? a.slot.page < b.slot.page : a.slot.position < b.slot.position;
	};

	for (const binder of liveBinders(binders)) {
		for (const slot of binder.slots || []) {
			if (!slot.entry_id || !inGrid(binder, slot)) {
				continue;
			}

			const here = {binder, slot};
			const there = out.get(slot.entry_id);

			if (!there || wins(here, there)) {
				out.set(slot.entry_id, here);
			}
		}
	}

	return out;
}

// The slots a binder really holds: inside its grid, one per pocket, and no
// copy that is really in another pocket.
export function slotsOf(binder, placed = placements([binder])) {
	const byPocket = new Map();

	for (const slot of binder.slots || []) {
		if (!inGrid(binder, slot) || !slotKind(slot)) {
			continue;
		}

		if (slot.entry_id) {
			const real = placed.get(slot.entry_id);

			if (!real || real.slot !== slot) {
				continue;
			}
		}

		const key = `${slot.page}|${slot.position}`;
		const other = byPocket.get(key);

		if (!other || String(slot.placed_at || '') > String(other.placed_at || '')) {
			byPocket.set(key, slot);
		}
	}

	return [...byPocket.values()].sort((a, b) => (a.page - b.page) || (a.position - b.position));
}

export const pageSlots = (binder, page, placed) => new Map(slotsOf(binder, placed)
	.filter((slot) => slot.page === page)
	.map((slot) => [slot.position, slot]));

// A copy's place: {binder_id, binder_name, page, position, row, col}, or null.
export function locate(binders, entryId) {
	const found = placements(binders).get(entryId);

	if (!found) {
		return null;
	}

	const {binder, slot} = found;

	return {binder_id: binder.id, binder_name: binder.name, page: slot.page, position: slot.position, ...cellOf(binder, slot.position)};
}

export const locationText = (where) => (where ? `${where.binder_name}, page ${where.page}, pocket ${where.position}` : 'Not in a binder');

// Filled pockets for the binder list: owned cards placed, and placeholders.
// A copy that has been deleted since it was placed does not count as filled.
export function binderStats(binder, placed, liveIds) {
	let filled = 0;
	let wanted = 0;

	for (const slot of slotsOf(binder, placed)) {
		if (slot.entry_id && (!liveIds || liveIds.has(slot.entry_id))) {
			filled++;
		}
		else if (slot.want) {
			wanted++;
		}
	}

	return {filled, total: totalPockets(binder), wanted};
}

// Live card entries not in any pocket.
export function unplaced(entries, binders) {
	const placed = placements(binders);

	return (entries || []).filter((entry) => isLive(entry) && !placed.has(entry.id));
}

// Placeholders waiting for a card: [{binder_id, binder_name, page, position}].
export function placeholdersFor(binders, catalog, cardId) {
	const out = [];

	for (const binder of liveBinders(binders)) {
		for (const slot of slotsOf(binder)) {
			if (slot.want && slot.want.card_id === cardId && (!slot.want.catalog || !catalog || slot.want.catalog === catalog)) {
				out.push({binder_id: binder.id, binder_name: binder.name, page: slot.page, position: slot.position});
			}
		}
	}

	return out;
}

// ------------------------------------------------------- changing slots
//
// Each returns the binders that changed, as new copies with a newer
// updated_at, ready to merge in. The binders passed in are not changed.

function copyOf(binder, at) {
	const next = structuredClone(binder);

	next.slots = Array.isArray(next.slots) ? next.slots : [];
	next.updated_at = nextStamp(binder.updated_at, Date.parse(at));

	return next;
}

function findLive(binders, id) {
	const binder = liveBinders(binders).find((item) => item.id === id);

	if (!binder) {
		throw new Error('This binder is not on this phone. It may have been deleted.');
	}

	return binder;
}

function checkPocket(binder, page, position) {
	if (!inGrid(binder, {page, position})) {
		throw new Error(`Page ${page}, pocket ${position} is not in this binder.`);
	}
}

// Puts content in one pocket. content is {entry_id}, {want}, {empty: true},
// or null to take out whatever is there.
export function setPocket(binders, {at = nowIso(), binderId, content, page, position}) {
	const target = findLive(binders, binderId);

	checkPocket(target, page, position);

	const changed = new Map();
	const edit = (binder) => {
		if (!changed.has(binder.id)) {
			changed.set(binder.id, copyOf(binder, at));
		}

		return changed.get(binder.id);
	};
	const here = (slot) => slot.page === page && slot.position === position;
	const entryId = content && content.entry_id;

	// One pocket per copy: take it out of every other pocket, in any binder.
	if (entryId) {
		for (const binder of liveBinders(binders)) {
			if ((binder.slots || []).some((slot) => slot.entry_id === entryId && !(binder.id === binderId && here(slot)))) {
				const next = edit(binder);

				next.slots = next.slots.filter((slot) => slot.entry_id !== entryId || (binder.id === binderId && here(slot)));
			}
		}
	}

	const next = edit(target);
	const placed = placements(binders);
	const elsewhere = (slot) => {
		const real = slot.entry_id && placed.get(slot.entry_id);

		return Boolean(real) && (real.binder.id !== target.id || real.slot.page !== slot.page || real.slot.position !== slot.position);
	};

	// Slots for copies that are really in another pocket (a merge left them
	// behind) are dropped while the binder is being saved anyway.
	next.slots = next.slots.filter((slot) => !here(slot) && !elsewhere(slot));

	if (content) {
		next.slots.push({page, placed_at: at, position, ...content});
	}

	next.slots.sort((a, b) => (a.page - b.page) || (a.position - b.position));

	return [...changed.values()];
}

// The slots a new grid or page count would leave out. Positions keep their
// numbers, so a grid of another shape keeps cards in reading order; Michi art
// is sliced to one grid, so it goes when the shape changes.
export function slotsOutside(binder, {cols, page_count, rows}) {
	const smaller = {...binder, cols, page_count, rows};
	const reshaped = rows !== binder.rows || cols !== binder.cols;

	return slotsOf(binder).filter((slot) => (reshaped && slot.art) || !inGrid(smaller, slot));
}

// ------------------------------------------------------------- saving
//
// js/collection.js has no generic save for lists other than cards, so a
// changed binder is merged in through mergeIntoLocal, the same entry by
// entry merge a sync uses, as js/checklists.js does for goals: the entry
// carries a newer updated_at, so it wins. That save is marked as coming from
// the sync, which does not schedule a push, so this module asks the sync to
// run a moment later. Signed out or offline, the change waits on the phone
// like any other edit.

const PUSH_DELAY_MS = 2000;

let pushTimer = null;

function schedulePush() {
	clearTimeout(pushTimer);
	pushTimer = setTimeout(() => {
		import('./sync.js')
			.then((sync) => sync.syncNow())
			.catch(() => {
				// The next sync (opening the app, coming back online) pushes it.
			});
	}, PUSH_DELAY_MS);
}

async function saveBinders(changed) {
	if (changed.length) {
		await mergeIntoLocal({binders: changed});
		schedulePush();
	}

	return changed;
}

// Changes run one at a time, each reading what the last one saved, so two
// quick taps cannot overwrite each other.
let queue = Promise.resolve();

function serial(work) {
	const run = queue.then(work, work);

	queue = run.catch(() => {});

	return run;
}

const allBinders = async () => (await loadDocument()).binders || [];

export async function listBinders() {
	return liveBinders(await allBinders()).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

export async function getBinder(id) {
	return liveBinders(await allBinders()).find((binder) => binder.id === id) || null;
}

export function createBinder(fields) {
	const clean = cleanFields(fields);
	const at = nowIso();

	return serial(async () => {
		const [binder] = await saveBinders([{
			...clean,
			art: [],
			created_at: at,
			deleted_at: null,
			id: newId(),
			slots: [],
			updated_at: at,
		}]);

		return binder;
	});
}

// Changes name, notes, cover, grid, or pages. A smaller grid or fewer pages
// drops the slots that fall outside; the copies in them become unplaced.
// Michi art is kept only while the grid keeps its shape.
export function updateBinder(id, fields) {
	const clean = cleanFields(fields);

	return serial(async () => {
		const binder = findLive(await allBinders(), id);
		const at = nowIso();
		const next = copyOf(binder, at);
		const reshaped = clean.rows !== binder.rows || clean.cols !== binder.cols;
		const out = new Set(slotsOutside(binder, clean).map((slot) => `${slot.page}|${slot.position}`));
		const smaller = {...binder, ...clean};

		Object.assign(next, clean);
		next.slots = next.slots.filter((slot) => inGrid(smaller, slot) && !out.has(`${slot.page}|${slot.position}`));

		if (reshaped) {
			next.art = [];
		}

		const [saved] = await saveBinders([next]);

		return saved;
	});
}

// Sets the cover image record ({id, path, type, at}), or takes the image
// away with null so the cover color shows again. Nothing else changes.
export function setCoverImage(id, image) {
	const clean = image ? cleanCoverImage(image) : null;

	if (image && !clean) {
		throw new Error('That cover image record is not valid.');
	}

	return serial(async () => {
		const binder = findLive(await allBinders(), id);
		const next = copyOf(binder, nowIso());

		next.cover_image = clean;

		const [saved] = await saveBinders([next]);

		return saved;
	});
}

// Soft delete: the entry stays as a tombstone, so a phone holding an older
// copy cannot bring the binder back. Its cards become unplaced.
export function deleteBinder(id) {
	return serial(async () => {
		const binder = findLive(await allBinders(), id);
		const at = nowIso();
		const next = copyOf(binder, at);

		next.deleted_at = next.updated_at;

		await saveBinders([next]);

		return next;
	});
}

const pocketChange = (binderId, page, position, content) => serial(async () => saveBinders(setPocket(await allBinders(), {binderId, content, page, position})));

// Places one owned copy, taking it out of any other pocket first.
export const placeCard = (binderId, page, position, entryId) => pocketChange(binderId, page, position, {entry_id: entryId});

// want: {card_id, catalog, variant_id, name, image}
export const placePlaceholder = (binderId, page, position, want) => pocketChange(binderId, page, position, {
	want: {
		card_id: want.card_id,
		catalog: want.catalog || 'international',
		image: want.image || null,
		name: want.name || null,
		variant_id: want.variant_id || null,
	},
});

export const leaveEmpty = (binderId, page, position) => pocketChange(binderId, page, position, {empty: true});

export const clearPocket = (binderId, page, position) => pocketChange(binderId, page, position, null);

// Where a copy is, for card detail: {binder_id, binder_name, page, position,
// row, col}, or null when it is in no binder.
export async function binderLocation(entryId) {
	return locate(await allBinders(), entryId);
}

// Live card entries in no binder.
export async function unplacedCards() {
	const doc = await loadDocument();

	return unplaced(doc.cards, doc.binders);
}

// Placeholders waiting for a card, for the scan confirm screen later.
export async function placeholdersWaiting(catalog, cardId) {
	return placeholdersFor(await allBinders(), catalog, cardId);
}
