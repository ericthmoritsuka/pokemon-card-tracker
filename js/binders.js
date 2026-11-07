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
//   layout       a whole number, one more each time the grid changes shape
//                (or the binder is emptied into its tray), so pockets saved
//                for one grid are never read on another; missing counts as 0
//   staged       the binder's tray: entry ids of copies meant for this
//                binder but not in a pocket yet, in the order they go in.
//                A copy is in at most one tray, and never in a tray and a
//                pocket at once
//   order        its place on the Binders screen (js/reorder.js)
//   rule, snapshot  a binder made from a list (js/binder-rules.js): what
//                fills it and the layout of its last refresh. Its slots
//                stay empty, and it never places a copy (placements below)
//   list_languages  for a binder made from a checklist: the list's
//                languages ("en,pt") when its layout was last saved here,
//                absent for a list that names none. Kept outside the
//                snapshot, which a v56 phone rewrites whole (planRefresh
//                languageOnly)
//   list_edits   for a binder made from a list: what is left out of it or
//                moved, applied after the list's order on every refresh
//                (js/binder-rules.js listEditsOf). Kept outside the
//                snapshot for the same reason (planRefresh editsOnly)
// A slot is one pocket that holds something. A pocket with no slot is
// empty. Pages and positions count from 1, and a position runs across each
// row, then down: on a 3 x 3 page, pocket 4 is row 2, column 1. Each slot is
// one of:
//   {page, position, placed_at, entry_id}      an owned card (one copy)
//   {page, position, placed_at, want}          a placeholder, with want =
//       {card_id, catalog, variant_id, name, image} for a card not owned,
//       and language when it was made from a copy (Start over); or a
//       Pokémon's placeholder, laid out from a checklist
//       (js/binder-layout.js): {card_id: null, catalog: null, variant_id:
//       null, image: null, name, dex}, and languages (["en", "pt"]) when
//       the list names some. Any copy of a card showing that Pokémon fills
//       it, in one of those languages (isPokemonWant)
//   {page, position, placed_at, empty: true}   left empty on purpose
//   {page, position, art}                      a tile of Michi art (not
//       edited here yet; kept as it is)
//   {page, position, placed_at, cleared: true} taken out: the pocket is
//       empty, and the marker tells the merge it was emptied on purpose
//       (slotKind reads it as nothing)
//
// The merge (js/merge.js) joins two versions of a binder pocket by pocket,
// so cards placed in different pockets on two phones both stay. Every change
// here is stamped against the binder it started from (stamped below).
//
// A binder is a physical place, so a card entry sits in at most one pocket
// across every binder (DESIGN.md section 3). Placing a copy takes it out of
// wherever it was. Two phones can still disagree after a merge: one phone
// moves a copy from binder A to binder B while the other, still on an older
// app, edits A. Then the copy is in both, and the slot placed last
// (placed_at) is the real one; the other is read as empty and dropped the
// next time that binder is saved.
//
// The pure functions take the binders and the time, so Node can test them
// (tests/binders.test.mjs). The rest read and save the document on the phone.

import {isLive, loadDocument, mergeIntoLocal, newId, nowIso} from './collection.js';
import {nextStamp, restoreEntry, stampEntry} from './merge.js';
import {byCreated, orderForNew, sortByOrder, withOrders} from './reorder.js';
import {checkBinderRule, checkFits, isGenerated, pagesFor, pickEntry, pickId, ruleKey} from './binder-rules.js';

export {isGenerated};

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

// A placeholder for a Pokémon rather than a card (laid out from a list).
export const isPokemonWant = (want) => Boolean(want) && !want.card_id && Number.isInteger(want.dex) && want.dex > 0;

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

export const liveBinders = (binders) => (binders || []).filter((binder) => binder && isLive(binder));

// The binders that hold real pockets: every live one but those made from a
// list, which show copies without placing them (js/binder-rules.js).
export const handBinders = (binders) => liveBinders(binders).filter((binder) => !isGenerated(binder));

// Where every placed copy is: Map entry_id -> {binder, slot}. A copy found in
// more than one pocket (two phones disagreeing, see above) goes to the slot
// placed last; ties go to the binder id, then the page and position, so
// every phone picks the same one. A binder made from a list places nothing,
// even when an older app put a card in one of its pockets.
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

	for (const binder of handBinders(binders)) {
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

	for (const binder of handBinders(binders)) {
		for (const slot of slotsOf(binder)) {
			if (slot.want && slot.want.card_id && slot.want.card_id === cardId && (!slot.want.catalog || !catalog || slot.want.catalog === catalog)) {
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

// copy -> the binder it was made from, so stamped() can tell what changed.
const madeFrom = new WeakMap();

function copyOf(binder, at) {
	const next = structuredClone(binder);

	next.slots = Array.isArray(next.slots) ? next.slots : [];
	next.updated_at = nextStamp(binder.updated_at, Date.parse(at));
	madeFrom.set(next, binder);

	return next;
}

// Changed copies, each stamped against the binder it was made from
// (js/merge.js stampEntry): the fields that changed get the new stamp, a
// pocket emptied or left out gets a cleared marker, and a pocket that
// changed is placed after what it replaced. So another phone's edit to
// other pockets or fields of the same binder survives the merge.
// skip: fields not to stamp (the cover path filled in after an upload).
function stamped(changed, {skip = []} = {}) {
	return changed.map((binder) => (madeFrom.has(binder) ? stampEntry(madeFrom.get(binder), binder, {skip}) : binder));
}

function findLive(binders, id) {
	const binder = liveBinders(binders).find((item) => item.id === id);

	if (!binder) {
		throw new Error('This binder is not on this phone. It may have been deleted.');
	}

	return binder;
}

function checkPocket(binder, page, position) {
	if (isGenerated(binder)) {
		throw new Error('This binder is made from a list, so its pockets fill themselves.');
	}

	if (!inGrid(binder, {page, position})) {
		throw new Error(`Page ${page}, pocket ${position} is not in this binder.`);
	}
}

// Puts content in one pocket. content is {entry_id}, {want}, {empty: true},
// or null to take out whatever is there. A copy placed leaves every tray.
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

	// One pocket per copy: take it out of every other pocket and every tray,
	// in any binder.
	if (entryId) {
		for (const binder of liveBinders(binders)) {
			if ((binder.slots || []).some((slot) => slot.entry_id === entryId && !(binder.id === binderId && here(slot)))) {
				const next = edit(binder);

				next.slots = next.slots.filter((slot) => slot.entry_id !== entryId || (binder.id === binderId && here(slot)));
			}

			if (stagedOf(binder).includes(entryId)) {
				const next = edit(binder);

				next.staged = stagedOf(next).filter((id) => id !== entryId);
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

	return stamped([...changed.values()]);
}

// Moves what is in one pocket of a hand-made binder to another pocket of
// it: into an empty pocket, or swapping with what is there (a card, a
// placeholder, a pocket left empty on purpose, or art). from and to are
// {page, position}. Moving the same two pockets again puts both back.
export function swapPockets(binders, {at = nowIso(), binderId, from, to}) {
	const target = findLive(binders, binderId);

	checkPocket(target, from.page, from.position);
	checkPocket(target, to.page, to.position);

	const at1 = (where) => (slot) => slot.page === where.page && slot.position === where.position;
	const held = (where) => slotsOf(target).find(at1(where));
	const moving = held(from);

	if (!moving) {
		throw new Error(`Page ${from.page}, pocket ${from.position} is empty.`);
	}

	if (from.page === to.page && from.position === to.position) {
		return [];
	}

	const there = held(to);
	const next = copyOf(target, at);

	next.slots = next.slots.filter((slot) => !at1(from)(slot) && !at1(to)(slot));
	next.slots.push({...moving, page: to.page, placed_at: at, position: to.position});

	if (there) {
		next.slots.push({...there, page: from.page, placed_at: at, position: from.position});
	}

	next.slots.sort((a, b) => (a.page - b.page) || (a.position - b.position));

	return stamped([next]);
}

// ------------------------------------------------ remove and shift
//
// Remove from this binder and Move to... (Eric, 2026-11-06: "the app should
// give me the choice to keep it as it is or shift the cards"). A pocket is
// counted across the whole binder in reading order, from 0. A shift moves
// every pocket between two pockets one place, empty ones too, so the gaps
// in between keep their places relative to the cards; placeholders, pockets
// left empty on purpose, and art move as pocket contents. It never reaches
// past the two pockets it runs between, so nothing leaves the last page,
// and it touches this binder alone: a removed copy goes to no binder and no
// tray (To the tray is its own action). One save, stamped pocket by pocket
// (stamped), so another phone's edit to other pockets survives the merge.

// What a pocket holds, as a string, to tell later whether it changed.
export const contentKey = (slot) => (slot ? JSON.stringify([slot.entry_id || null, slot.want ? slot.want.card_id || `dex:${slot.want.dex}` : null, Boolean(slot.art), Boolean(slot.empty)]) : 'none');

const pocketIndex = (binder, where) => ((where.page - 1) * pocketsPerPage(binder)) + where.position - 1;

const pocketAtIndex = (binder, i) => pageOfPocket(binder, i + 1);

// The last pocket holding anything (a card, a Gone card, a placeholder,
// art, or one left empty on purpose), as an index; -1 when none does.
export function lastInUse(binder, placed = placements([binder])) {
	const slots = slotsOf(binder, placed);

	return slots.length ? Math.max(...slots.map((slot) => pocketIndex(binder, slot))) : -1;
}

// moves: Map from index -> index for every pocket that moves; drop: the
// index whose content leaves the binder, or null. Returns {changed, done}
// with done = {binderId, layout, rows, cols, pockets: [{page, position,
// before, after}]} for undoShift: each pocket that changed, the slot it
// held, and what it holds now (contentKey).
function rewrite(binders, target, {at, drop = null, moves}) {
	const placed = placements(binders);
	const slots = slotsOf(target, placed);
	const total = totalPockets(target);
	const byIndex = new Map(slots.map((slot) => [pocketIndex(target, slot), slot]));
	const after = new Map();

	for (const [i, slot] of byIndex) {
		if (i === drop) {
			continue;
		}

		const to = moves.has(i) ? moves.get(i) : i;

		if (!Number.isInteger(to) || to < 0 || to >= total || after.has(to)) {
			throw new Error('That would push a card out of the binder, so nothing moved.');
		}

		if (to === i) {
			after.set(i, slot);
			continue;
		}

		const where = pocketAtIndex(target, to);
		const moved = {...slot, page: where.page, position: where.position};

		if (!slot.art) {
			moved.placed_at = at;
		}

		after.set(to, moved);
	}

	const touched = new Set([...moves.keys(), ...moves.values(), ...(drop === null ? [] : [drop])]);
	const pockets = [...touched].sort((x, y) => x - y)
		.filter((i) => contentKey(byIndex.get(i)) !== contentKey(after.get(i)))
		.map((i) => ({...pocketAtIndex(target, i), after: contentKey(after.get(i)), before: byIndex.get(i) || null}));
	const next = copyOf(target, at);

	next.slots = [...after.values()].sort((a, b) => (a.page - b.page) || (a.position - b.position));

	return {
		changed: pockets.length ? stamped([next]) : [],
		done: {binderId: target.id, cols: target.cols, layout: layoutOf(target), pockets, rows: target.rows},
	};
}

function checkHeld(binder, where, expect) {
	checkPocket(binder, where.page, where.position);

	const slot = slotsOf(binder).find((item) => item.page === where.page && item.position === where.position) || null;

	if (!slot) {
		throw new Error(`Page ${where.page}, pocket ${where.position} is empty.`);
	}

	if (expect !== undefined && contentKey(slot) !== expect) {
		throw new Error('This pocket changed on another phone, so nothing moved.');
	}

	return slot;
}

// Remove from this binder: the pocket's content leaves it. shift: every
// later pocket moves back one, closing the gap; else the pocket stays
// empty. expect: the contentKey the person saw, so a pocket a sync changed
// since is left alone.
export function removePocket(binders, {at = nowIso(), binderId, expect = undefined, page, position, shift = false}) {
	const target = findLive(binders, binderId);

	checkHeld(target, {page, position}, expect);

	const from = pocketIndex(target, {page, position});
	const moves = new Map();

	if (shift) {
		const last = lastInUse(target);

		for (let i = from + 1; i <= last; i++) {
			moves.set(i, i - 1);
		}
	}

	return rewrite(binders, target, {at, drop: from, moves});
}

// Move to...: the pocket's content goes to `to` ({page, position}, or
// 'end' for the last pocket in use), and the pockets between shift one
// place to make room, back when it moves later in the binder, forward when
// it moves earlier. Moving the first card to the end makes the second
// card pocket 1.
export function shiftMove(binders, {at = nowIso(), binderId, expect = undefined, from, to}) {
	const target = findLive(binders, binderId);

	checkHeld(target, from, expect);

	const s = pocketIndex(target, from);
	let t;

	if (to === 'end') {
		t = lastInUse(target);
	}
	else {
		checkPocket(target, to.page, to.position);
		t = pocketIndex(target, to);
	}

	const moves = new Map();

	if (t > s) {
		for (let i = s + 1; i <= t; i++) {
			moves.set(i, i - 1);
		}
	}
	else {
		for (let i = t; i < s; i++) {
			moves.set(i, i + 1);
		}
	}

	if (t !== s) {
		moves.set(s, t);
	}

	return {...rewrite(binders, target, {at, moves}), to: pocketAtIndex(target, t)};
}

// Undo of removePocket or shiftMove: every pocket it changed gets back what
// it held, in one save, but only while each still holds what the change
// put there, the grid is the same, and no copy it brings back has gone to
// another pocket or a tray since. Returns {changed, back} (back false when
// something changed since; then nothing is written).
export function undoShift(binders, {at = nowIso(), done}) {
	const target = liveBinders(binders).find((item) => item.id === done.binderId);

	if (!target || layoutOf(target) !== done.layout || target.rows !== done.rows || target.cols !== done.cols) {
		return {back: false, changed: []};
	}

	const placed = placements(binders);
	const now = new Map(slotsOf(target, placed).map((slot) => [`${slot.page}|${slot.position}`, slot]));
	const here = new Set(done.pockets.map((pocket) => `${pocket.page}|${pocket.position}`));
	const elsewhere = (entryId) => {
		const real = placed.get(entryId);

		return (real && (real.binder.id !== target.id || !here.has(`${real.slot.page}|${real.slot.position}`)))
			|| liveBinders(binders).some((binder) => stagedOf(binder).includes(entryId));
	};

	if (done.pockets.some((pocket) => contentKey(now.get(`${pocket.page}|${pocket.position}`)) !== pocket.after
		|| (pocket.before && pocket.before.entry_id && elsewhere(pocket.before.entry_id)))) {
		return {back: false, changed: []};
	}

	const next = copyOf(target, at);
	const kept = [...now.values()].filter((slot) => !here.has(`${slot.page}|${slot.position}`));
	const back = done.pockets.filter((pocket) => pocket.before).map((pocket) => (pocket.before.art ? {...pocket.before} : {...pocket.before, placed_at: at}));

	next.slots = [...kept, ...back].sort((a, b) => (a.page - b.page) || (a.position - b.position));

	return {back: true, changed: stamped([next])};
}

// ----------------------------------------------------------- the tray
//
// A binder's tray (staged) holds copies meant for it that are not in a
// pocket yet: cards a resize pushed out, a binder emptied to be arranged by
// hand, or a card taken out of a pocket to go somewhere else.

export const layoutOf = (binder) => (isWhole(binder && binder.layout) && binder.layout >= 0 ? binder.layout : 0);

// The tray as saved: entry ids, each once, in order.
export function stagedOf(binder) {
	const seen = new Set();

	for (const id of Array.isArray(binder && binder.staged) ? binder.staged : []) {
		if (typeof id === 'string' && id) {
			seen.add(id);
		}
	}

	return [...seen];
}

// The tray as shown: copies still in the collection (liveIds, when given)
// and in no pocket (placed, when given). A copy deleted from the collection
// leaves the tray here, and the next save of the binder drops it.
export function trayOf(binder, {liveIds = null, placed = null} = {}) {
	return stagedOf(binder).filter((id) => (!liveIds || liveIds.has(id)) && (!placed || !placed.has(id)));
}

// Changes made one after another on the same binders: each set of changed
// binders applied over the list, and the latest copy of each kept.
const withChanges = (binders, changed) => binders.map((binder) => changed.find((item) => item.id === binder.id) || binder);

function gather(...lists) {
	const out = new Map();

	for (const binder of lists.flat()) {
		out.set(binder.id, binder);
	}

	return [...out.values()];
}

// Puts copies in a binder's tray, at index (the end when left out), taking
// each out of every pocket and every other tray first.
export function stageCards(binders, {at = nowIso(), binderId, entryIds, index = null}) {
	const target = findLive(binders, binderId);

	if (isGenerated(target)) {
		throw new Error('This binder is made from a list, so it has no tray.');
	}
	const ids = [...new Set((entryIds || []).filter((id) => typeof id === 'string' && id))];
	const changed = new Map();
	const edit = (binder) => {
		if (!changed.has(binder.id)) {
			changed.set(binder.id, copyOf(binder, at));
		}

		return changed.get(binder.id);
	};

	if (!ids.length) {
		return [];
	}

	for (const binder of liveBinders(binders)) {
		if ((binder.slots || []).some((slot) => ids.includes(slot.entry_id))) {
			const next = edit(binder);

			next.slots = next.slots.filter((slot) => !ids.includes(slot.entry_id));
		}

		if (binder.id !== binderId && stagedOf(binder).some((id) => ids.includes(id))) {
			const next = edit(binder);

			next.staged = stagedOf(next).filter((id) => !ids.includes(id));
		}
	}

	const next = edit(target);
	const rest = stagedOf(next).filter((id) => !ids.includes(id));
	const cut = index === null ? rest.length : Math.min(Math.max(0, index), rest.length);

	next.staged = [...rest.slice(0, cut), ...ids, ...rest.slice(cut)];

	return stamped([...changed.values()]);
}

// The copies "Add cards to the tray" offers: live copies in no pocket (My
// Cards' "Not in a binder yet") that no binder's tray holds either, so
// adding one never takes it from a tray it was meant for.
export function trayCandidates(entries, binders) {
	const held = new Set(handBinders(binders).flatMap((binder) => stagedOf(binder)));

	return unplaced(entries, binders).filter((entry) => !held.has(entry.id));
}

// Undo for "Add cards to the tray": takes copies out of one binder's tray.
// A copy placed in a pocket since then stays where it is.
export function unstageCards(binders, {at = nowIso(), binderId, entryIds}) {
	const target = findLive(binders, binderId);
	const ids = new Set(entryIds || []);
	const staged = stagedOf(target);

	if (!staged.some((id) => ids.has(id))) {
		return [];
	}

	const next = copyOf(target, at);

	next.staged = staged.filter((id) => !ids.has(id));

	return stamped([next]);
}

// Takes the card in a pocket out into the binder's tray, at the end.
// entryId, when given, is the copy the person saw there: when the pocket
// holds another by now (a sync while the sheet or the card was open),
// nothing moves and the error says so.
export function pocketToTray(binders, {at = nowIso(), binderId, entryId = null, page, position}) {
	const target = findLive(binders, binderId);
	const slot = pageSlots(target, page, placements(binders)).get(position);

	if (!slot || !slot.entry_id) {
		throw new Error('There is no card in that pocket to move to the tray.');
	}

	if (entryId && slot.entry_id !== entryId) {
		throw new Error('That pocket holds another card now, so nothing moved.');
	}

	return stageCards(binders, {at, binderId, entryIds: [slot.entry_id]});
}

// Places a card from the tray in a pocket. A card already in that pocket
// swaps into the tray, where the placed one was, so it is the next to go;
// a placeholder or a pocket left empty on purpose is replaced.
export function placeFromTray(binders, {at = nowIso(), binderId, entryId, page, position}) {
	const target = findLive(binders, binderId);
	const index = stagedOf(target).indexOf(entryId);
	const occupant = pageSlots(target, page, placements(binders)).get(position);
	const placedNow = setPocket(binders, {at, binderId, content: {entry_id: entryId}, page, position});

	if (!occupant || !occupant.entry_id || occupant.entry_id === entryId) {
		return placedNow;
	}

	const swapped = stageCards(withChanges(binders, placedNow), {at, binderId, entryIds: [occupant.entry_id], index: index < 0 ? null : index});

	return gather(placedNow, swapped);
}

// The pockets with nothing in them, in reading order: [{page, position}].
export function openPockets(binder, placed) {
	const filled = new Set(slotsOf(binder, placed).map((slot) => `${slot.page}|${slot.position}`));
	const out = [];

	for (let page = 1; page <= binder.page_count; page++) {
		for (let position = 1; position <= pocketsPerPage(binder); position++) {
			if (!filled.has(`${page}|${position}`)) {
				out.push({page, position});
			}
		}
	}

	return out;
}

// "Fill the rest in order": the tray's cards go into the pockets with
// nothing in them, in reading order, from page 1. Placeholders and pockets
// left empty on purpose are passed over. Returns {changed, placed, left}:
// the binders to save, and how many cards went in and how many stay.
export function fillFromTray(binders, {at = nowIso(), binderId, liveIds = null}) {
	const target = findLive(binders, binderId);
	const placedMap = placements(binders);
	const tray = trayOf(target, {liveIds, placed: placedMap});
	const open = openPockets(target, placedMap);
	const going = tray.slice(0, open.length);

	if (!going.length) {
		return {changed: [], left: tray.length, placed: 0};
	}

	const next = copyOf(target, at);

	next.slots = structuredClone(slotsOf(target, placedMap));
	next.slots.push(...going.map((entryId, i) => ({entry_id: entryId, page: open[i].page, placed_at: at, position: open[i].position})));
	next.slots.sort((a, b) => (a.page - b.page) || (a.position - b.position));
	// The tray keeps what did not fit; copies deleted since leave it.
	next.staged = stagedOf(target).filter((id) => !going.includes(id) && (!liveIds || liveIds.has(id)));

	return {changed: stamped([next]), left: tray.length - going.length, placed: going.length};
}

// --------------------------------------------------------- resizing
//
// Eric's rule (DESIGN.md section 11, "Resizing a binder", 2026-10-02):
//   - a grid that grows (rows and columns both at least the old ones) keeps
//     every pocket at its row and column, on its page;
//   - a grid that shrinks or changes shape keeps every pocket at its row and
//     column when all of them still fit, and otherwise lays the whole binder
//     out again in reading order: pockets with nothing in them close up,
//     placeholders and pockets left empty on purpose keep their place in the
//     sequence, and pages are added so nothing falls out (unless the person
//     asked for fewer pages);
//   - fewer pages push out what is on the pages cut;
//   - Michi art goes on any change of shape;
//   - the layout number goes up by one on any change of shape.
// mode "tray" empties the binder instead: every card goes to the tray, to
// be arranged by hand, and placeholders and empty-on-purpose pockets go.
//
// Returns the plan, without changing the binder:
//   how         "same" (only the pages changed), "grow", "keep", "reflow",
//               or "tray"
//   reshaped    the grid changed shape
//   page_count  the pages after the change: the ones asked for, or more
//   added       pages added so nothing falls out
//   slots       the binder's slots after the change, in reading order
//   toTray      entry ids that go to the tray, in reading order
//   dropped     {wants, empties, art}: placeholders, empty-on-purpose
//               pockets, and Michi art tiles that go
//   moved       slots that changed page, row, or column
//   layout      the layout number after the change
export function planResize(binder, {cols, page_count: asked, rows}, {mode = 'auto', placed = undefined} = {}) {
	const shape = {cols, rows};
	const per = rows * cols;
	const reshaped = rows !== binder.rows || cols !== binder.cols;
	const grows = rows >= binder.rows && cols >= binder.cols;
	const all = slotsOf(binder, placed);
	const art = all.filter((slot) => slot.art);
	const items = all.filter((slot) => !slot.art);
	const dropped = {art: 0, empties: 0, wants: 0};
	const toTray = [];
	const lose = (slot) => {
		if (slot.entry_id) {
			toTray.push(slot.entry_id);
		}
		else if (slot.want) {
			dropped.wants++;
		}
		else if (slot.empty) {
			dropped.empties++;
		}
		else if (slot.art) {
			dropped.art++;
		}
	};
	const atOwnPlace = (slot) => {
		const {col, row} = cellOf(binder, slot.position);

		return {...slot, position: positionOf(shape, row, col)};
	};

	let how;
	let pageCount = asked;
	let laid;

	if (mode === 'tray') {
		how = 'tray';
		laid = [];
		items.forEach(lose);
	}
	else if (!reshaped || grows || items.every((slot) => cellOf(binder, slot.position).row <= rows && cellOf(binder, slot.position).col <= cols)) {
		how = !reshaped ? 'same' : grows ? 'grow' : 'keep';
		laid = items.map(atOwnPlace);
	}
	else {
		how = 'reflow';

		// More pages only make up for the smaller grid; a person who asked
		// for fewer pages gets the pages asked for.
		if (asked >= binder.page_count) {
			pageCount = Math.min(MAX_PAGES, Math.max(asked, Math.ceil(items.length / per)));
		}

		laid = items.map((slot, i) => ({...slot, page: Math.floor(i / per) + 1, position: (i % per) + 1}));
	}

	const slots = [];

	for (const slot of laid) {
		if (slot.page <= pageCount) {
			slots.push(slot);
		}
		else {
			lose(slot);
		}
	}

	// Michi art is sliced to one grid: it stays only while the shape does.
	for (const slot of art) {
		if (!reshaped && mode !== 'tray' && slot.page <= pageCount) {
			slots.push(slot);
		}
		else {
			lose(slot);
		}
	}

	slots.sort((a, b) => (a.page - b.page) || (a.position - b.position));

	const before = new Map(items.map((slot) => [slot, cellOf(binder, slot.position)]));
	const moved = laid.filter((slot, i) => {
		const old = items[i];
		const cell = cellOf(shape, slot.position);
		const was = before.get(old);

		return slot.page !== old.page || cell.row !== was.row || cell.col !== was.col;
	}).length;

	return {
		added: pageCount - asked,
		dropped,
		how,
		layout: reshaped || mode === 'tray' ? layoutOf(binder) + 1 : layoutOf(binder),
		moved,
		page_count: pageCount,
		reshaped,
		slots,
		toTray,
	};
}

// The binder after a resize: the fields, the plan's slots and pages, cards
// that fall out in its tray (after any already there), Michi art cleared
// on a change of shape, and the layout number. at stamps the copy.
export function resizedBinder(binder, fields, {at = nowIso(), mode = 'auto', placed = undefined} = {}) {
	const plan = planResize(binder, fields, {mode, placed});
	const next = copyOf(binder, at);

	Object.assign(next, fields);
	next.page_count = plan.page_count;
	next.slots = structuredClone(plan.slots);
	next.layout = plan.layout;
	next.staged = [...new Set([...stagedOf(binder), ...plan.toTray])];

	if (plan.reshaped) {
		next.art = [];
	}

	return {binder: stamped([next])[0], plan};
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

// Live binders in the order the person set (js/reorder.js), the ones with no
// order last, oldest first.
export const sortBinders = (binders) => sortByOrder(liveBinders(binders), byCreated);

export async function listBinders() {
	return sortBinders(await allBinders());
}

// Writes new orders, [{id, order}], and resolves to the saved binders.
export const reorderBinders = (changes) => serial(async () => saveBinders(withOrders(await allBinders(), changes)));

// Brings a deleted binder back on purpose (js/merge.js restoreEntry), for
// Undo after a delete: its pockets, tray, cover, and order as they were. A
// copy placed elsewhere meanwhile stays where it went last (placements).
export const restoreBinder = (id) => serial(async () => {
	const binder = (await allBinders()).find((one) => one && one.id === id);

	if (!binder || !binder.deleted_at) {
		return binder || null;
	}

	const [saved] = await saveBinders([restoreEntry(binder)]);

	return saved;
});

export async function getBinder(id) {
	return liveBinders(await allBinders()).find((binder) => binder.id === id) || null;
}

export function createBinder(fields) {
	const clean = cleanFields(fields);
	const at = nowIso();

	return serial(async () => {
		const order = orderForNew(liveBinders(await allBinders()));
		const [binder] = await saveBinders([{
			...clean,
			art: [],
			created_at: at,
			deleted_at: null,
			id: newId(),
			...(order === null ? {} : {order}),
			slots: [],
			updated_at: at,
		}]);

		return binder;
	});
}

// ------------------------------------------------- binders from a list
//
// js/binder-rules.js has the rule, the layout, and the picks; these save
// them. The snapshot comes from planRefresh, worked out by the screen with
// the source's cards (js/binder-sources.js).

// The binder fields for a list's layout: the grid asked for, and the pages
// its pockets need.
function generatedFields(fields, snapshot) {
	const rows = Number(fields.rows);
	const cols = Number(fields.cols);
	const count = snapshot && Array.isArray(snapshot.keys) ? snapshot.keys.length : 0;

	if (validGrid(rows, cols)) {
		checkFits(count, rows, cols);
	}

	return cleanFields({...fields, page_count: validGrid(rows, cols) ? pagesFor(count, rows, cols) : 1});
}

// list_languages from a refresh plan's languages: a list's languages are
// recorded, a list without them removes the field, and undefined (not a
// checklist, or no new layout) leaves it as it is.
function recordLanguages(next, languages) {
	if (typeof languages === 'string') {
		next.list_languages = languages;
	}
	else if (languages === null) {
		delete next.list_languages;
	}
}

// A new binder made from a list: fields as for createBinder (the pages are
// worked out), rule {source, order}, and the first snapshot. languages: the
// plan's (planRefresh), recorded as list_languages.
export function createGeneratedBinder(fields, rule, snapshot, {languages} = {}) {
	const clean = generatedFields(fields, snapshot);
	const checked = checkBinderRule(rule);
	const at = nowIso();

	return serial(async () => {
		const order = orderForNew(liveBinders(await allBinders()));
		const made = {
			...clean,
			art: [],
			created_at: at,
			deleted_at: null,
			id: newId(),
			...(order === null ? {} : {order}),
			rule: checked,
			slots: [],
			snapshot: {...snapshot, at},
			updated_at: at,
		};

		recordLanguages(made, languages);

		const [binder] = await saveBinders([made]);

		return binder;
	});
}

// Changes a list's binder: name, notes, cover, the grid, the rule, and the
// layout worked out for them. A change of grid raises the layout number, as
// a resize does. languages: as for createGeneratedBinder, given with a new
// layout.
export function updateGeneratedBinder(id, fields, rule, snapshot, {languages} = {}) {
	const clean = generatedFields(fields, snapshot);
	const checked = checkBinderRule(rule);

	return serial(async () => {
		const binder = findLive(await allBinders(), id);
		const at = nowIso();
		const next = copyOf(binder, at);

		Object.assign(next, clean);
		next.rule = checked;
		next.snapshot = {...snapshot, at: next.updated_at};
		next.slots = [];
		recordLanguages(next, languages);

		if (clean.rows !== binder.rows || clean.cols !== binder.cols) {
			next.layout = layoutOf(binder) + 1;
		}

		const [saved] = await saveBinders(stamped([next]));

		return saved;
	});
}

// Saves a refresh's layout (planRefresh): the snapshot and the pages, and
// for a checklist the list's languages it was worked out with
// (list_languages). A refresh worked out for a rule the binder no longer
// has (changed on another phone meanwhile) is dropped. Resolves the saved
// binder, or null.
export function saveRefresh(id, {languages, page_count: pageCount, snapshot}) {
	return serial(async () => {
		const binder = liveBinders(await allBinders()).find((item) => item.id === id);

		if (!binder || !isGenerated(binder) || !snapshot) {
			return null;
		}

		if (ruleKey(binder.rule) !== snapshot.rule_key) {
			return null;
		}

		const next = copyOf(binder, nowIso());

		next.snapshot = {...snapshot, at: next.updated_at};
		next.page_count = Math.min(MAX_PAGES, Math.max(1, pageCount));
		recordLanguages(next, languages);

		const [saved] = await saveBinders(stamped([next]));

		return saved;
	});
}

// A list's binder's exceptions (list_edits, js/binder-rules.js
// listEditsOf), saved with the layout they give when the screen could work
// it out (plan: {snapshot, page_count, languages}, as saveRefresh), in one
// save. The field merges as a whole, like name, and an older app keeps it
// when it saves the binder, since it edits a clone of the entry.
export function saveListEdits(id, edits, plan = null) {
	return serial(async () => {
		const binder = liveBinders(await allBinders()).find((item) => item.id === id);

		if (!binder || !isGenerated(binder)) {
			throw new Error('This binder is not on this phone. It may have been deleted.');
		}

		const next = copyOf(binder, nowIso());

		next.list_edits = edits;

		if (plan && plan.snapshot && ruleKey(binder.rule) === plan.snapshot.rule_key) {
			next.snapshot = {...plan.snapshot, at: next.updated_at};
			next.page_count = Math.min(MAX_PAGES, Math.max(1, plan.page_count));
			recordLanguages(next, plan.languages);
		}

		const [saved] = await saveBinders(stamped([next]));

		return saved;
	});
}

// Picks the copy a pocket of a list's binder shows (entryId), or puts the
// default back (null). Saved in binder_picks, one entry per pocket, merged
// entry by entry like any list.
export function setPocketPick(binderId, key, entryId) {
	return serial(async () => {
		const doc = await loadDocument();
		const binder = findLive(doc.binders || [], binderId);

		if (!isGenerated(binder)) {
			throw new Error('Only a binder made from a list picks its copies.');
		}

		const id = pickId(binderId, key);
		const previous = (Array.isArray(doc.binder_picks) ? doc.binder_picks : []).find((pick) => pick && pick.id === id) || null;
		const entry = pickEntry({at: nextStamp(previous && previous.updated_at), binderId, entryId, key, previous});

		await mergeIntoLocal({binder_picks: [entry]});
		schedulePush();

		return entry;
	});
}

// Changes name, notes, cover, grid, or pages, by the resize rule above
// (planResize): mode "auto" for the rule, "tray" to empty every card into
// the tray. Cards that fall out land in the binder's tray.
export function updateBinder(id, fields, {mode = 'auto'} = {}) {
	const clean = cleanFields(fields);

	return serial(async () => {
		const binders = await allBinders();
		const binder = findLive(binders, id);
		const {binder: next} = resizedBinder(binder, clean, {at: nowIso(), mode, placed: placements(binders)});
		const [saved] = await saveBinders([next]);

		return saved;
	});
}

// Sets the cover image record ({id, path, type, at}), or takes the image
// away with null so the cover color shows again. Nothing else changes.
// fill: true when only the uploaded path is being filled in
// (js/binder-cover.js), which must not count as choosing the cover again: the
// cover keeps its stamp, so a newer cover picked on another phone still wins.
export function setCoverImage(id, image, {fill = false} = {}) {
	const clean = image ? cleanCoverImage(image) : null;

	if (image && !clean) {
		throw new Error('That cover image record is not valid.');
	}

	return serial(async () => {
		const binder = findLive(await allBinders(), id);
		const next = copyOf(binder, nowIso());

		next.cover_image = clean;

		const [saved] = await saveBinders(stamped([next], {skip: fill ? ['cover_image'] : []}));

		return saved;
	});
}

// Soft delete: the entry stays as a tombstone, so a phone holding an older
// copy cannot bring the binder back. Its cards become unplaced.
export function deleteBinder(id) {
	return serial(async () => {
		const binder = findLive(await allBinders(), id);
		const at = nowIso();
		const draft = copyOf(binder, at);

		draft.deleted_at = draft.updated_at;

		const [next] = await saveBinders(stamped([draft]));

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
		// The language the pocket wants, when the placeholder was made from a
		// copy (Start over); Fill placeholders prefers a copy in it.
		...(want.language ? {language: want.language} : {}),
		name: want.name || null,
		variant_id: want.variant_id || null,
	},
});

export const leaveEmpty = (binderId, page, position) => pocketChange(binderId, page, position, {empty: true});

export const clearPocket = (binderId, page, position) => pocketChange(binderId, page, position, null);

// from and to are {page, position}; see swapPockets.
export const movePocket = (binderId, from, to) => serial(async () => saveBinders(swapPockets(await allBinders(), {binderId, from, to})));

// The tray, saved. Each reads what the last change saved, like the pockets.
const liveCardIds = async () => new Set(((await loadDocument()).cards || []).filter(isLive).map((entry) => entry.id));

export const moveToTray = (binderId, page, position, entryId = null) => serial(async () => saveBinders(pocketToTray(await allBinders(), {binderId, entryId, page, position})));

// "Add cards to the tray", and its Undo.
export const addToTray = (binderId, entryIds) => serial(async () => saveBinders(stageCards(await allBinders(), {binderId, entryIds})));

export const takeFromTray = (binderId, entryIds) => serial(async () => saveBinders(unstageCards(await allBinders(), {binderId, entryIds})));

export const placeStaged = (binderId, page, position, entryId) => serial(async () => saveBinders(placeFromTray(await allBinders(), {binderId, entryId, page, position})));

// Resolves {placed, left}.
export const fillTray = (binderId) => serial(async () => {
	const result = fillFromTray(await allBinders(), {binderId, liveIds: await liveCardIds()});

	await saveBinders(result.changed);

	return {left: result.left, placed: result.placed};
});

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

// ------------------------------------------------------------ scanning
//
// The scanner (js/scan/) names the pocket a scanned card goes in when a
// placeholder waits for it ("Goes in Binder 2, page 7, pocket 4"), and
// once the copy is saved, puts it there. Only the person's own binders: a
// family member's are never read or changed here.

// Every placeholder, in binder order (the binder list's, sortBinders), then
// page and pocket: [{binder_id, binder_name, page, position, card_id,
// catalog}]. catalog is null for a placeholder that names none.
export function placeholderList(binders) {
	const out = [];

	for (const binder of sortBinders(binders).filter((item) => !isGenerated(item))) {
		for (const slot of slotsOf(binder)) {
			if (slot.want && slot.want.card_id) {
				out.push({
					binder_id: binder.id,
					binder_name: binder.name,
					card_id: slot.want.card_id,
					catalog: slot.want.catalog || null,
					page: slot.page,
					position: slot.position,
				});
			}
		}
	}

	return out;
}

// Changes many pockets in one pass per binder, so thousands of pockets cost
// one copy and one stamp per binder: each row's pocket gets content(row,
// slot) when fits(row, slot, seen) says the pocket still holds what the row
// expects, and is passed over otherwise (moved or filled on another phone
// since). seen is {placed, staged}: where every copy sits now
// (placements) and every copy in some tray, as they were before this
// change. A row whose binder is gone or made from a list is passed over.
// Returns {changed, done, passed}: the binders to save, and the rows
// changed and passed over, each done row with the slot it replaced.
function changePockets(binders, rows, {at, content, fits}) {
	const placed = placements(binders);
	const live = liveBinders(binders);
	const byId = new Map(live.map((binder) => [binder.id, binder]));
	const staged = new Set(live.flatMap((binder) => stagedOf(binder)));
	const seen = {placed, staged};
	const pockets = new Map();
	const writes = new Map();
	const done = [];
	const passed = [];
	const keyOf = (where) => `${where.page}|${where.position}`;

	const pocketsOf = (binder) => {
		if (!pockets.has(binder.id)) {
			pockets.set(binder.id, new Map(slotsOf(binder, placed).map((slot) => [keyOf(slot), slot])));
		}

		return pockets.get(binder.id);
	};

	for (const row of rows || []) {
		const binder = byId.get(row.binderId);

		if (!binder || isGenerated(binder) || !inGrid(binder, row)) {
			passed.push(row);
			continue;
		}

		const held = pocketsOf(binder);
		const slot = held.get(keyOf(row));

		if (!slot || !fits(row, slot, seen)) {
			passed.push(row);
			continue;
		}

		const written = {page: row.page, placed_at: at, position: row.position, ...content(row, slot)};

		held.set(keyOf(row), written);

		if (!writes.has(binder.id)) {
			writes.set(binder.id, new Map());
		}

		writes.get(binder.id).set(keyOf(row), written);
		done.push({...row, was: slot});
	}

	const changed = [];

	for (const [binderId, written] of writes) {
		const binder = byId.get(binderId);
		const next = copyOf(binder, at);
		const entering = new Set([...written.values()].map((slot) => slot.entry_id).filter(Boolean));
		// Slots for copies that are really in another pocket (a merge left
		// them behind) are dropped while the binder is being saved anyway.
		const elsewhere = (slot) => {
			const real = slot.entry_id && placed.get(slot.entry_id);

			return Boolean(real) && (real.binder.id !== binderId || real.slot.page !== slot.page || real.slot.position !== slot.position);
		};

		next.slots = next.slots.filter((slot) => !written.has(keyOf(slot)) && !elsewhere(slot));
		next.slots.push(...written.values());
		next.slots.sort((a, b) => (a.page - b.page) || (a.position - b.position));

		// A copy placed leaves the tray (fills only take copies in no tray,
		// so this is for safety).
		if (stagedOf(next).some((id) => entering.has(id))) {
			next.staged = stagedOf(next).filter((id) => !entering.has(id));
		}

		changed.push(next);
	}

	return {changed: stamped(changed), done, passed};
}

// True when a placeholder stands for the card a row brings: the same card
// id, and the same catalog when both name one; for a Pokémon's
// placeholder, a row the plan made for that Pokémon (row.dex, set by
// js/placeholder-fill.js fillPlan once it checked the card shows it).
const wantFits = (want, row) => {
	if (!want) {
		return false;
	}

	if (isPokemonWant(want)) {
		return row.dex === want.dex;
	}

	return want.card_id === row.cardId && (!row.catalog || !want.catalog || want.catalog === row.catalog);
};

// Puts saved copies in the placeholders waiting for them, one copy per
// pocket. rows: [{binderId, page, position, entryId, cardId, catalog}]
// (catalog optional), and dex for a Pokémon's placeholder. A pocket that no longer holds a placeholder for the
// card is passed over, and so is a copy already in a pocket or a tray (it
// is never moved) or one an earlier row placed. Each done row carries want,
// the placeholder it replaced, so restorePlaceholders can put it back.
export function fillPlaceholders(binders, rows, {at = nowIso()} = {}) {
	const used = new Set();
	const result = changePockets(binders, rows, {
		at,
		content: (row) => ({entry_id: row.entryId}),
		fits: (row, slot, {placed, staged}) => {
			if (!wantFits(slot.want, row) || !row.entryId || used.has(row.entryId) || placed.has(row.entryId) || staged.has(row.entryId)) {
				return false;
			}

			used.add(row.entryId);

			return true;
		},
	});

	return {changed: result.changed, done: result.done.map(({was, ...row}) => ({...row, want: was.want})), passed: result.passed};
}

// Undoes fillPlaceholders: rows are its done rows. Only a pocket that still
// holds the copy it wrote gets its placeholder back; one that holds
// something else by now (moved, emptied, or filled on another phone) is
// passed over.
export function restorePlaceholders(binders, rows, {at = nowIso()} = {}) {
	const result = changePockets(binders, (rows || []).filter((row) => row.want), {
		at,
		content: (row) => ({want: row.want}),
		fits: (row, slot) => slot.entry_id === row.entryId,
	});

	return {changed: result.changed, done: result.done.map(({was, ...row}) => row), passed: result.passed};
}

// ------------------------------------------------- laid out from a list
//
// "Lay out from a list" (js/binder-layout.js; Eric, 2026-11-06): Pokémon
// placeholders written into pockets with nothing in them, in one copy and
// one stamp of the binder, and taken back by Undo.

// Writes pockets [{page, position, want}] into a hand-made binder, each
// only where the pocket has nothing in it now, so a filled pocket never
// changes. pageCount, when more than the binder's pages, adds pages at the
// end first (up to MAX_PAGES). Returns {changed, done}: the binder to save,
// and the pockets written.
export function layOutWants(binders, {at = nowIso(), binderId, pageCount = null, pockets}) {
	const target = findLive(binders, binderId);

	if (isGenerated(target)) {
		throw new Error('This binder is made from a list, so its pockets fill themselves.');
	}

	const next = copyOf(target, at);

	if (Number.isInteger(pageCount) && pageCount > target.page_count) {
		next.page_count = Math.min(MAX_PAGES, pageCount);
	}

	const held = new Set(slotsOf(target, placements(binders)).map((slot) => `${slot.page}|${slot.position}`));
	const done = [];

	for (const pocket of pockets || []) {
		const key = `${pocket.page}|${pocket.position}`;

		if (held.has(key) || !inGrid(next, pocket) || !pocket.want) {
			continue;
		}

		held.add(key);
		done.push({page: pocket.page, position: pocket.position, want: pocket.want});
	}

	if (!done.length && next.page_count === target.page_count) {
		return {changed: [], done};
	}

	const writing = new Set(done.map((pocket) => `${pocket.page}|${pocket.position}`));

	// Cleared markers and stale slots in those pockets give way.
	next.slots = next.slots.filter((slot) => slot.art || !writing.has(`${slot.page}|${slot.position}`));
	next.slots.push(...done.map((pocket) => ({page: pocket.page, placed_at: at, position: pocket.position, want: pocket.want})));
	next.slots.sort((a, b) => (a.page - b.page) || (a.position - b.position));

	return {changed: stamped([next]), done};
}

// Undo of a layout: takes out each Pokémon placeholder it wrote (wants:
// [{page, position, dex, placedAt}]) and each copy its fill put in (fills:
// [{page, position, entryId}]), only where the pocket still holds it. A
// placeholder counts as the layout's only with the placed_at the layout
// gave it, so the same Pokémon laid out again by a later layout stays. The
// pages the layout added stay too, empty, to be removed in Edit binder:
// this phone cannot know whether another phone has placed a card on them
// that has not synced yet, and fewer pages would drop it (decided
// 2026-11-06). Returns {changed, back, kept}: the binder to save, the
// pockets emptied, and the pockets left as they are because they changed
// since.
export function undoLayOut(binders, {at = nowIso(), binderId, fills = [], wants = []}) {
	const target = liveBinders(binders).find((binder) => binder.id === binderId && !isGenerated(binder));

	if (!target) {
		return {back: 0, changed: [], kept: wants.length};
	}

	const keyOf = (where) => `${where.page}|${where.position}`;
	const holds = new Map(slotsOf(target, placements(binders)).map((slot) => [keyOf(slot), slot]));
	const take = new Set();

	for (const row of fills) {
		const slot = holds.get(keyOf(row));

		if (slot && slot.entry_id === row.entryId) {
			take.add(keyOf(row));
		}
	}

	for (const row of wants) {
		const slot = holds.get(keyOf(row));

		if (slot && isPokemonWant(slot.want) && slot.want.dex === row.dex && slot.placed_at === row.placedAt) {
			take.add(keyOf(row));
		}
	}

	if (!take.size) {
		return {back: 0, changed: [], kept: wants.length};
	}

	const next = copyOf(target, at);

	next.slots = next.slots.filter((slot) => slot.art || !take.has(keyOf(slot)));

	return {
		back: take.size,
		changed: stamped([next]),
		kept: wants.filter((row) => !take.has(keyOf(row))).length,
	};
}

// Saved: runs change(doc) with the document read now, in the queue with
// every other binder change, and saves the binders it returns as changed.
// Resolves the rest of what it returns. For a change planned across lists
// (js/binder-layout.js reads the cards and the binders together).
export const changeBinders = (change) => serial(async () => {
	const {changed = [], ...rest} = await change(await loadDocument());

	await saveBinders(changed);

	return rest;
});

// Saved: Remove from this binder (removePocket), Move to... (shiftMove),
// and their Undo (undoShift). Each resolves what the pure function returns.
export const removeFromBinder = (binderId, where, {expect, shift}) => serial(async () => {
	const result = removePocket(await allBinders(), {binderId, expect, page: where.page, position: where.position, shift});

	await saveBinders(result.changed);

	return result;
});

export const moveWithShift = (binderId, from, to, {expect} = {}) => serial(async () => {
	const result = shiftMove(await allBinders(), {binderId, expect, from, to});

	await saveBinders(result.changed);

	return result;
});

export const undoShifted = (done) => serial(async () => {
	const result = undoShift(await allBinders(), {done});

	await saveBinders(result.changed);

	return result;
});

// Saved: every placeholder in the person's binders, for the scanner.
export async function waitingPlaceholderList() {
	return placeholderList(await allBinders());
}

// Saved: resolves {done, passed}, as fillPlaceholders.
export const placeScanned = (rows) => serial(async () => {
	const result = fillPlaceholders(await allBinders(), rows);

	await saveBinders(result.changed);

	return {done: result.done, passed: result.passed};
});

// Saved: resolves {done, passed}, as restorePlaceholders.
export const unplaceScanned = (rows) => serial(async () => {
	const result = restorePlaceholders(await allBinders(), rows);

	await saveBinders(result.changed);

	return {done: result.done, passed: result.passed};
});
