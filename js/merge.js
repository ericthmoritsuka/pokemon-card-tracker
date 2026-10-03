// Merging two versions of one person's document, entry by entry (DESIGN.md
// section 3). Pure functions with no DOM or storage, so Node can test them
// (tests/merge.test.mjs).
//
// The rules, for two versions of the entry with one id:
//   1. A delete sticks. A tombstone (deleted_at set) wins over a live
//      version, however much newer the live one is, unless the live one was
//      restored on purpose after the delete (restored_at later than
//      deleted_at, see restoreEntry). So an offline phone that edits a card
//      after another phone deleted it cannot bring the card back.
//   2. Otherwise the newer updated_at wins.
//   3. At the same updated_at, a tombstone wins.
//   4. Otherwise the one whose content sorts last wins, so every device makes
//      the same choice and the two copies end up identical.
// When rule 1 picks the older version, the result is stamped just after
// both (the bump rule), so stamps() sees it as a change and pushes it, and a
// phone still on the old rules (newer updated_at wins) takes it too.
// (Decided 2026-10-02, Eric's audit fixes; plans/sync-merge-plan.md.)

import {mergePhotoLists} from './photos/model.js';

export const LISTS = ['cards', 'collections', 'goals', 'binders', 'wishlist', 'openings'];

function time(value) {
	const ms = Date.parse(value);

	return Number.isNaN(ms) ? -Infinity : ms;
}

// JSON with the keys sorted, so equal content gives equal text.
export function stableJson(value) {
	if (Array.isArray(value)) {
		return `[${value.map(stableJson).join(',')}]`;
	}

	if (value && typeof value === 'object') {
		return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
	}

	return JSON.stringify(value === undefined ? null : value);
}

export function newerEntry(a, b) {
	const diff = time(a.updated_at) - time(b.updated_at);

	if (diff !== 0) {
		return diff > 0 ? a : b;
	}

	if (Boolean(a.deleted_at) !== Boolean(b.deleted_at)) {
		return a.deleted_at ? a : b;
	}

	return stableJson(a) >= stableJson(b) ? a : b;
}

// The stamp just after both versions'.
function stampAfter(a, b) {
	const newest = Math.max(time(a.updated_at), time(b.updated_at));

	return new Date(Number.isFinite(newest) ? newest + 1 : 0).toISOString();
}

// An imported copy nobody has changed since the import.
const untouchedImport = (entry) => Boolean(entry.import_key) && !entry.restored_at && time(entry.updated_at) === time(entry.created_at);

// The version a rule other than "newer wins" picks, or null when the plain
// rule (newerEntry) decides.
function specialPick(a, b) {
	const deadA = Boolean(a.deleted_at);

	if (deadA !== Boolean(b.deleted_at)) {
		const dead = deadA ? a : b;
		const live = deadA ? b : a;

		return time(live.restored_at) > time(dead.deleted_at) ? live : dead;
	}

	// Two phones that imported the same row made the same id
	// (js/collection.js importEntryId). The copy someone has used since (a
	// photo, a price, a note) wins over a fresh import of the same row,
	// whichever is newer; between two fresh imports, the earlier one wins.
	if (!deadA && a.import_key && a.import_key === b.import_key) {
		const freshA = untouchedImport(a);
		const freshB = untouchedImport(b);

		if (freshA !== freshB) {
			return freshA ? b : a;
		}

		if (freshA && time(a.created_at) !== time(b.created_at)) {
			return time(a.created_at) < time(b.created_at) ? a : b;
		}
	}

	return null;
}

// Merges two versions of one entry (the rules at the top). Returns one of
// the two objects when its content is the result, else a new object.
export function mergeEntry(a, b) {
	if (a === b) {
		return a;
	}

	const special = specialPick(a, b);

	if (special) {
		return newerEntry(a, b) === special ? special : bumpTo(special, stampAfter(a, b));
	}

	if (a.deleted_at && b.deleted_at) {
		return newerEntry(a, b);
	}

	return validVersion(a) && validVersion(b) ? mergeValid(a, b) : mergeFallback(a, b);
}

// ---------------------------------------------------- key by key
//
// From merge_version 2 (plans/sync-merge-plan.md section 2), two live versions merge
// field by field and pocket by pocket when both were written by an app that
// stamps, so an edit to one part of an entry on one phone and to another part
// on a second phone both survive. A version written by an older app falls
// back to the whole-entry rule above, minus the parts that never lose data
// (photos, cleared pockets, unticks, the cover by its time).
//
// The data that makes it work, all optional, so older apps carry it along:
//   field_stamps {at, since, <field>: iso}
//       at     the updated_at of the version that wrote these stamps. When an
//              older app edits the entry it moves updated_at but not at, so
//              that version no longer counts as valid (validVersion).
//       since  when this version's history became trustworthy: created_at,
//              or the moment a new app took over a version an older app
//              wrote. An older app removes a pocket or a tick by leaving it
//              out, so something only one side holds is kept only when it is
//              newer than the other side's since.
//       field  when that top-level field last changed; a field without one
//              counts as since.
//   binder slots  each pocket by page|position with its placed_at; taking
//              something out leaves {page, position, placed_at, cleared:
//              true}, which slotKind reads as nothing.
//   goal hand_unticks  dex -> when a hand tick was taken away.
//   collection entry_ids / removed_ids  card entry id -> when it was added to
//              a hand-picked collection, and when it was taken out. Per id the
//              later stamp stands, a removal on a tie, so two phones adding
//              different cards both keep theirs (mergeMembers).
// Binders also carry layout (js/binders.js): pockets saved for two different
// layouts, or two different grids, never mix; the side with the higher
// layout, then the grid changed last, keeps its whole set of pockets.

export const MERGE_VERSION = 2;

// Never stamped per field: what the merge itself keeps track of, and the
// collections that carry stamps of their own inside.
const BOOKKEEPING = new Set(['id', 'created_at', 'updated_at', 'deleted_at', 'restored_at', 'merged_into', 'field_stamps']);
const KEYED = new Set(['photos', 'slots', 'hand_ticks', 'hand_unticks', 'entry_ids', 'removed_ids']);
const OWN_RULE = new Set(['cover_image', 'layout']);

// -1, 0, or 1, with a missing time counting as the earliest.
function compareTimes(x, y) {
	const a = time(x);
	const b = time(y);

	if (a === b) {
		return 0;
	}

	return a > b ? 1 : -1;
}

function compareJson(x, y) {
	const a = stableJson(x);
	const b = stableJson(y);

	if (a === b) {
		return 0;
	}

	return a > b ? 1 : -1;
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// True when a new app wrote this version: its field_stamps were written with
// its updated_at, or it was never edited (no stamps, updated_at equal to
// created_at, which covers every untouched import at no extra size).
export function validVersion(entry) {
	if (!entry || !Number.isFinite(time(entry.updated_at))) {
		return false;
	}

	if (isObject(entry.field_stamps)) {
		return time(entry.field_stamps.at) === time(entry.updated_at);
	}

	return time(entry.created_at) === time(entry.updated_at);
}

const sinceOf = (entry) => (isObject(entry.field_stamps) && entry.field_stamps.since) || entry.created_at || null;

// When a field last changed; never before since.
function fieldStamp(entry, key) {
	const since = sinceOf(entry);
	const own = isObject(entry.field_stamps) ? entry.field_stamps[key] : null;

	return own && compareTimes(own, since) > 0 ? own : since;
}

// The field stamps an entry stands for, in one form: since, and every field
// stamped later than since.
function canonicalStamps(entry) {
	const since = sinceOf(entry);
	const out = {since};

	for (const [key, value] of Object.entries(isObject(entry.field_stamps) ? entry.field_stamps : {})) {
		if (key !== 'at' && key !== 'since' && compareTimes(value, since) > 0) {
			out[key] = value;
		}
	}

	return out;
}

// The version as a copy at a new stamp. A valid one stays valid.
function bumpTo(entry, at) {
	const out = {...entry, updated_at: at};

	if (validVersion(entry)) {
		out.field_stamps = {...canonicalStamps(entry), at};
	}

	return out;
}

const layoutNumber = (binder) => (Number.isInteger(binder && binder.layout) && binder.layout >= 0 ? binder.layout : 0);

const isArt = (slot) => Boolean(slot && slot.art);

const pocketKey = (slot) => `${slot.page}|${slot.position}`;

const isPocket = (slot) => Boolean(slot) && Number.isInteger(slot.page) && Number.isInteger(slot.position);

// Of two slots in one pocket, the one that stands: placed later, then a
// cleared marker, then the content that sorts last.
function slotWins(a, b) {
	const times = compareTimes(a.placed_at, b.placed_at);

	if (times !== 0) {
		return times > 0;
	}

	if (Boolean(a.cleared) !== Boolean(b.cleared)) {
		return Boolean(a.cleared);
	}

	return compareJson(a, b) >= 0;
}

// page|position -> the slot that stands there, art left out.
function pocketMap(slots) {
	const out = new Map();

	for (const slot of Array.isArray(slots) ? slots : []) {
		if (!isPocket(slot) || isArt(slot)) {
			continue;
		}

		const key = pocketKey(slot);
		const there = out.get(key);

		if (!there || slotWins(slot, there)) {
			out.set(key, slot);
		}
	}

	return out;
}

function inBinderGrid(binder, slot) {
	const per = Number(binder.rows) * Number(binder.cols);
	const pages = Number(binder.page_count);

	if (!Number.isFinite(per) || !Number.isFinite(pages)) {
		return true;
	}

	return slot.page >= 1 && slot.page <= pages && slot.position >= 1 && slot.position <= per;
}

const sortSlots = (slots) => slots.sort((a, b) => (a.page - b.page) || (a.position - b.position) || compareJson(a, b));

// Pockets saved for the same grid: same layout number, rows, and columns.
const sameGrid = (a, b) => layoutNumber(a) === layoutNumber(b) && a.rows === b.rows && a.cols === b.cols;

// The side whose grid stands when two grids differ: the higher layout, then
// the grid changed last, then the plain rule.
function gridSide(a, b) {
	if (layoutNumber(a) !== layoutNumber(b)) {
		return layoutNumber(a) > layoutNumber(b) ? a : b;
	}

	const stamp = (entry) => later(fieldStamp(entry, 'rows'), fieldStamp(entry, 'cols'));
	const times = compareTimes(stamp(a), stamp(b));

	if (times !== 0) {
		return times > 0 ? a : b;
	}

	return newerEntry(a, b);
}

// Pockets merged one by one (both versions valid, same grid). A pocket only
// one side holds stays when it was placed after the other side's since, and
// a cleared marker always stays. Art tiles (no placed_at) come with the grid.
function mergeSlots(a, b) {
	const mine = pocketMap(a.slots);
	const theirs = pocketMap(b.slots);
	const out = [];

	for (const key of new Set([...mine.keys(), ...theirs.keys()])) {
		const x = mine.get(key);
		const y = theirs.get(key);

		if (x && y) {
			out.push(slotWins(x, y) ? x : y);
		}
		else if (x) {
			if (x.cleared || compareTimes(x.placed_at, sinceOf(b)) > 0) {
				out.push(x);
			}
		}
		else if (y.cleared || compareTimes(y.placed_at, sinceOf(a)) > 0) {
			out.push(y);
		}
	}

	for (const slot of gridSide(a, b).slots || []) {
		if (isArt(slot)) {
			out.push(slot);
		}
	}

	return out;
}

// Hand ticks merged dex by dex (both versions valid): the later of the tick
// and the untick stands, and an untick wins a tie. A tick only one side
// knows stays when it is newer than the other side's since.
function mergeTicks(a, b) {
	const ticksA = isObject(a.hand_ticks) ? a.hand_ticks : {};
	const ticksB = isObject(b.hand_ticks) ? b.hand_ticks : {};
	const untA = isObject(a.hand_unticks) ? a.hand_unticks : {};
	const untB = isObject(b.hand_unticks) ? b.hand_unticks : {};
	const ticks = {};
	const unticks = {};
	const knows = (ticksOf, untOf, dex) => dex in ticksOf || dex in untOf;

	for (const dex of new Set([...Object.keys(ticksA), ...Object.keys(ticksB), ...Object.keys(untA), ...Object.keys(untB)])) {
		let tick = null;

		if (dex in ticksA && (knows(ticksB, untB, dex) || compareTimes(ticksA[dex], sinceOf(b)) > 0)) {
			tick = ticksA[dex];
		}

		if (dex in ticksB && (knows(ticksA, untA, dex) || compareTimes(ticksB[dex], sinceOf(a)) > 0)) {
			tick = tick === null ? ticksB[dex] : later(tick, ticksB[dex]);
		}

		const untick = dex in untA || dex in untB ? later(untA[dex] ?? null, untB[dex] ?? null) : null;

		if (tick !== null && (untick === null || compareTimes(tick, untick) > 0)) {
			ticks[dex] = tick;
		}
		else if (untick !== null) {
			unticks[dex] = untick;
		}
	}

	return {ticks, unticks};
}

// A hand-picked collection's members merged id by id: of the add stamp
// (entry_ids) and the removal stamp (removed_ids) the later stands, and a
// removal wins a tie. Both versions' ids are kept, so cards two phones added
// apart both stay in. Returns {added, removed}.
function mergeMembers(a, b) {
	const stampsOf = (entry, key) => (isObject(entry[key]) ? entry[key] : {});
	const adds = [stampsOf(a, 'entry_ids'), stampsOf(b, 'entry_ids')];
	const gone = [stampsOf(a, 'removed_ids'), stampsOf(b, 'removed_ids')];
	const added = {};
	const removed = {};

	for (const id of new Set([...adds, ...gone].flatMap((map) => Object.keys(map)))) {
		const add = later(adds[0][id] ?? null, adds[1][id] ?? null);
		const removal = later(gone[0][id] ?? null, gone[1][id] ?? null);

		if (removal !== null && (add === null || compareTimes(removal, add) >= 0)) {
			removed[id] = removal;
		}
		else {
			added[id] = add;
		}
	}

	return {added, removed};
}

const hasMembers = (entry) => isObject(entry.entry_ids) || isObject(entry.removed_ids);

// Writes the merged members onto out, only when either version has any.
function applyMembers(out, a, b) {
	if (!hasMembers(a) && !hasMembers(b)) {
		return;
	}

	const {added, removed} = mergeMembers(a, b);

	out.entry_ids = added;

	if (Object.keys(removed).length) {
		out.removed_ids = removed;
	}
}

// Two cover images: different pictures go to the one made later (its at),
// the same picture to the version that knows its uploaded path. Null when
// the rule cannot tell (one side has none).
function coverPick(x, y) {
	if (!isObject(x) || !isObject(y)) {
		return null;
	}

	if (x.id !== y.id) {
		const times = compareTimes(x.at, y.at);

		if (times !== 0) {
			return times > 0 ? x : y;
		}
	}
	else if (Boolean(x.path) !== Boolean(y.path)) {
		return x.path ? x : y;
	}

	return compareJson(x, y) >= 0 ? x : y;
}

// What two versions are compared by: everything but the stamps, with the
// pockets in one order and no empty unticks.
function contentOf(entry) {
	const {field_stamps: _stamps, updated_at: _at, ...rest} = entry;

	if (Array.isArray(rest.slots)) {
		rest.slots = rest.slots.map(stableJson).sort();
	}

	if (isObject(rest.hand_unticks) && !Object.keys(rest.hand_unticks).length) {
		delete rest.hand_unticks;
	}

	return stableJson(rest);
}

// The value and stamp of a field decided by its stamp, then by content.
function pickField(a, b, key) {
	const stampA = fieldStamp(a, key);
	const stampB = fieldStamp(b, key);
	const times = compareTimes(stampA, stampB);
	const from = times !== 0 ? (times > 0 ? a : b) : (compareJson(a[key], b[key]) >= 0 ? a : b);

	return {from, stamp: times >= 0 ? stampA : stampB};
}

// Both versions written by a new app: field by field and pocket by pocket.
function mergeValid(a, b) {
	const newer = newerEntry(a, b);
	const older = newer === a ? b : a;
	const since = later(sinceOf(a), sinceOf(b));
	const stamps = {since};
	const out = {id: newer.id};

	if (a.created_at !== undefined || b.created_at !== undefined) {
		const known = [a.created_at, b.created_at].filter((value) => value !== undefined);

		out.created_at = known.reduce((x, y) => (compareTimes(x, y) <= 0 ? x : y));
	}

	for (const key of ['deleted_at', 'merged_into']) {
		if (key in newer) {
			out[key] = newer[key];
		}
	}

	if (a.restored_at || b.restored_at) {
		out.restored_at = later(a.restored_at || null, b.restored_at || null);
	}

	const stamped = (key, stamp) => {
		if (compareTimes(stamp, since) > 0) {
			stamps[key] = stamp;
		}
	};

	for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
		if (BOOKKEEPING.has(key) || KEYED.has(key) || OWN_RULE.has(key)) {
			continue;
		}

		const {from, stamp} = pickField(a, b, key);

		if (from[key] !== undefined) {
			out[key] = from[key];
		}

		stamped(key, stamp);
	}

	if ('layout' in a || 'layout' in b) {
		out.layout = Math.max(layoutNumber(a), layoutNumber(b));
	}

	if (Array.isArray(a.photos) || Array.isArray(b.photos)) {
		out.photos = mergePhotoLists(newer.photos, older.photos);
	}

	if (Array.isArray(a.slots) || Array.isArray(b.slots)) {
		let slots;

		if (sameGrid(a, b)) {
			slots = mergeSlots(a, b);
		}
		else {
			const side = gridSide(a, b);

			slots = Array.isArray(side.slots) ? [...side.slots] : [];

			for (const key of ['rows', 'cols']) {
				if (side[key] === undefined) {
					delete out[key];
				}
				else {
					out[key] = side[key];
				}
			}
		}

		out.slots = sortSlots(slots.filter((slot) => !isPocket(slot) || inBinderGrid(out, slot)));
	}

	if (isObject(a.hand_ticks) || isObject(b.hand_ticks) || isObject(a.hand_unticks) || isObject(b.hand_unticks)) {
		const {ticks, unticks} = mergeTicks(a, b);

		out.hand_ticks = ticks;

		if (Object.keys(unticks).length) {
			out.hand_unticks = unticks;
		}
	}

	applyMembers(out, a, b);

	if ('cover_image' in a || 'cover_image' in b) {
		const picked = coverPick(a.cover_image, b.cover_image);
		const {from, stamp} = pickField(a, b, 'cover_image');

		if (picked) {
			out.cover_image = picked;
		}
		else if (from.cover_image !== undefined) {
			out.cover_image = from.cover_image;
		}

		stamped('cover_image', stamp);
	}

	// The newer version, when it already holds the whole result.
	if (contentOf(out) === contentOf(newer) && stableJson(stamps) === stableJson(canonicalStamps(newer))) {
		return newer;
	}

	const at = stampAfter(a, b);

	out.updated_at = at;
	out.field_stamps = {...stamps, at};

	return out;
}

// At least one version written by an older app: the newer version whole, as
// that app would pick, plus what never loses data. Photos are unioned (older
// apps only tombstone photos), the other version's cleared pockets and
// unticks that are newer than what the winner holds there apply, and two
// cover pictures go by their time. Pockets or ticks only the other version
// added are not brought back: the older app may have removed them on purpose.
function mergeFallback(a, b) {
	const winner = newerEntry(a, b);
	const loser = winner === a ? b : a;
	const out = {...winner};

	if (Array.isArray(winner.photos) || Array.isArray(loser.photos)) {
		out.photos = mergePhotoLists(winner.photos, loser.photos);
	}

	if (Array.isArray(winner.slots) && Array.isArray(loser.slots) && sameGrid(winner, loser)) {
		let slots = winner.slots;

		for (const marker of pocketMap(loser.slots).values()) {
			if (!marker.cleared) {
				continue;
			}

			const there = pocketMap(slots).get(pocketKey(marker));

			if (!there || compareTimes(marker.placed_at, there.placed_at) > 0) {
				slots = [...slots.filter((slot) => isArt(slot) || !isPocket(slot) || pocketKey(slot) !== pocketKey(marker)), marker];
			}
		}

		if (slots !== winner.slots) {
			out.slots = sortSlots(slots);
		}
	}

	if (isObject(loser.hand_unticks)) {
		const ticks = {...(isObject(winner.hand_ticks) ? winner.hand_ticks : {})};
		const unticks = {...(isObject(winner.hand_unticks) ? winner.hand_unticks : {})};
		let touched = false;

		for (const [dex, at] of Object.entries(loser.hand_unticks)) {
			const held = later(ticks[dex] ?? null, unticks[dex] ?? null);

			if (held === null || compareTimes(at, held) > 0) {
				delete ticks[dex];
				unticks[dex] = at;
				touched = true;
			}
		}

		if (touched) {
			out.hand_ticks = ticks;
			out.hand_unticks = unticks;
		}
	}

	applyMembers(out, winner, loser);

	const cover = coverPick(winner.cover_image, loser.cover_image);

	if (cover) {
		out.cover_image = cover;
	}

	if (stableJson(out) === stableJson(winner)) {
		return winner;
	}

	out.updated_at = stampAfter(a, b);

	return out;
}

// A version a writer made from `before`, stamped: every top-level field
// whose content changed gets the new stamp (fields removed outright too),
// field_stamps.at takes the version's updated_at so it counts as valid, and
// since stays, or starts now when an older app wrote `before`. Binder
// pockets the writer emptied or left out get a cleared marker, and a pocket
// whose content changed is placed after what was there, whatever the
// phone's clock says. skip names fields not to stamp (the cover path filled
// in after an upload). Returns a new object; neither input is changed.
export function stampEntry(before, after, {at = after && after.updated_at, skip = []} = {}) {
	if (!before || !after) {
		return after;
	}

	const out = {...after, updated_at: at};
	const valid = validVersion(before);
	const stamps = valid ? canonicalStamps(before) : {};

	stamps.since = (valid && sinceOf(before)) || at;

	for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
		if (!BOOKKEEPING.has(key) && !KEYED.has(key) && !skip.includes(key) && stableJson(before[key]) !== stableJson(after[key])) {
			stamps[key] = at;
		}
	}

	stamps.at = at;
	out.field_stamps = stamps;

	if (Array.isArray(before.slots) && Array.isArray(after.slots) && sameGrid(before, after)) {
		out.slots = markPockets(before.slots, after, at);
	}

	return out;
}

// The writer's pockets with a cleared marker wherever something was taken
// out (cleared markers already there are kept), and changed pockets placed
// after what they replace.
function markPockets(beforeSlots, after, at) {
	const was = pocketMap(beforeSlots);
	const now = pocketMap(after.slots);
	const ms = time(at);
	let changed = false;

	const slots = after.slots.map((slot) => {
		const prev = isPocket(slot) && !isArt(slot) ? was.get(pocketKey(slot)) : null;

		if (prev && now.get(pocketKey(slot)) === slot && stableJson(prev) !== stableJson(slot) && compareTimes(slot.placed_at, prev.placed_at) <= 0) {
			changed = true;

			return {...slot, placed_at: nextStamp(prev.placed_at, ms)};
		}

		return slot;
	});

	for (const [key, prev] of was) {
		if (now.has(key) || !inBinderGrid(after, prev)) {
			continue;
		}

		changed = true;
		slots.push(prev.cleared ? prev : {cleared: true, page: prev.page, placed_at: nextStamp(prev.placed_at, ms), position: prev.position});
	}

	return changed ? sortSlots(slots) : after.slots;
}

// Brings a deleted entry back on purpose: deleted_at cleared, and
// restored_at stamped after the delete, so the merge lets this version win
// over the tombstone (rule 1). Nothing in the app calls it yet: deletes are
// permanent until a "Recently deleted" screen exists (Eric, 2026-10-02).
export function restoreEntry(entry, now = Date.now()) {
	if (!entry || !entry.deleted_at) {
		return entry;
	}

	const {merged_into: _merged, ...rest} = entry;
	const at = nextStamp(later(entry.updated_at, entry.deleted_at), now);

	return stampEntry(entry, {...rest, deleted_at: null, restored_at: at, updated_at: at});
}

// Merges two versions of one list. Entries keep the local order, and entries
// only the other side has follow in its order. Neither input is changed.
export function mergeEntries(local, remote) {
	const merged = new Map();
	const loose = [];

	for (const entry of local || []) {
		if (entry && entry.id) {
			merged.set(entry.id, entry);
		}
		else {
			loose.push(entry);
		}
	}

	for (const entry of remote || []) {
		if (!entry || !entry.id) {
			continue;
		}

		const mine = merged.get(entry.id);

		merged.set(entry.id, mine ? mergeEntry(mine, entry) : entry);
	}

	return [...merged.values(), ...loose];
}

const later = (a, b) => (time(a) >= time(b) ? a : b);

// A stamp strictly newer than the entry's last one, so the merge always
// takes the new version: even when two edits land in one millisecond, and
// even on a phone whose clock is behind the phone that wrote `previous`.
// Every write in the app takes its updated_at from here.
export function nextStamp(previous, now = Date.now()) {
	const before = Date.parse(previous);

	return new Date(Number.isNaN(before) || now > before ? now : before + 1).toISOString();
}

// Merges two whole documents. Every list is merged entry by entry; settings
// go to whichever side changed them last; other fields keep the local value
// and gain any the remote side has that the local one lacks.
export function mergeDocuments(local, remote) {
	local = local || {};
	remote = remote || {};

	const out = {...remote, ...local};
	const lists = new Set(LISTS);

	for (const key of Object.keys(out)) {
		if (Array.isArray(local[key]) || Array.isArray(remote[key])) {
			lists.add(key);
		}
	}

	for (const key of lists) {
		out[key] = mergeEntries(Array.isArray(local[key]) ? local[key] : [], Array.isArray(remote[key]) ? remote[key] : []);
	}

	if (local.settings || remote.settings) {
		const mine = local.settings || {};
		const theirs = remote.settings || {};
		const newest = time(theirs.updated_at) > time(mine.updated_at) ? theirs : mine;

		out.settings = {...(newest === mine ? theirs : mine), ...newest};
	}

	if (local.updated_at || remote.updated_at) {
		out.updated_at = later(local.updated_at, remote.updated_at);
	}

	// The highest merge rules any phone has used on this document. A phone
	// whose own rules are older stops pushing (js/sync.js).
	if (local.merge_version || remote.merge_version) {
		out.merge_version = Math.max(Number(local.merge_version) || 0, Number(remote.merge_version) || 0);
	}

	out.cards =refoldPhotos(collapseImportDuplicates(out.cards));
	out.binders = redirectPockets(out.binders, out.cards);
	out.wishlist = dedupeWishes(out.wishlist);

	return out;
}

// ------------------------------------------------------- duplicate wishes

// What makes two wishes the same: the card, its catalog, and the language
// and finish they name (js/wishlist.js sameWish).
const wishKey = (wish) => wish.card_id ? [wish.catalog || 'international', wish.card_id, wish.language || '', wish.variant_id || ''].join('|') : null;

// The same card wished for on two phones, or an edit that made one wish the
// twin of another, leaves two live items. They fold into the oldest
// (earliest created_at, then the lowest id), which takes the priority of the
// most recently edited one and the newest non-empty note; the others become
// tombstones naming it in merged_into, all stamped just after the newest of
// the group. Removing the survivor then removes the wish everywhere.
export function dedupeWishes(wishes) {
	if (!Array.isArray(wishes)) {
		return wishes;
	}

	const replace = new Map();

	for (const members of liveGroups(wishes, wishKey)) {
		const [survivor] = [...members].sort(oldestFirst);
		const newest = [...members].sort(newestFirst);
		const noted = newest.find((member) => filled(member.note));
		const at = stampAfterAll(members);
		const kept = {...survivor, deleted_at: null, updated_at: at};

		if (newest[0].priority !== undefined) {
			kept.priority = newest[0].priority;
		}

		if (noted) {
			kept.note = noted.note;
		}

		replace.set(kept.id, stampEntry(survivor, kept));

		for (const member of members) {
			if (member.id !== kept.id) {
				replace.set(member.id, {...member, deleted_at: at, merged_into: kept.id, updated_at: at});
			}
		}
	}

	return replace.size ? wishes.map((wish) => (wish && replace.get(wish.id)) || wish) : wishes;
}

// ------------------------------------------------------- duplicate copies
//
// Before v22, every import gave its rows random ids, so the same file
// imported on two phones (or signed out, then signed in) left two live
// entries per physical card. One import_key is one physical copy
// (js/monprice.js importKey), so live entries that share a key are always
// the same card, and every merge folds them into one (plans/sync-merge-plan.md
// section 1b). This runs on every merge for good, not once: a v21 phone's
// random ids and a v22 phone's import ids for the same rows still meet.

// What a person sets on a copy; the newest non-empty value is kept.
const USER_FIELDS = ['condition', 'purchase_price', 'purchase_currency', 'storage', 'grader', 'grade', 'cert_number', 'graded_price', 'notes', 'opening_id'];

// What the import set; taken from the most recently edited copy.
const IMPORT_FIELDS = ['card_id', 'catalog', 'variant_id', 'finish_raw', 'fallback', 'language', 'language_source', 'name_local', 'set_name_local', 'photo_path'];

const filled = (value) => value !== undefined && value !== null && value !== '';

const byId = (a, b) => {
	if (String(a.id) === String(b.id)) {
		return 0;
	}

	return String(a.id) < String(b.id) ? -1 : 1;
};

const order = (diff) => (Number.isNaN(diff) ? 0 : diff);

const newestFirst = (a, b) => order(time(b.updated_at) - time(a.updated_at)) || byId(a, b);

const oldestFirst = (a, b) => order(time(a.created_at) - time(b.created_at)) || byId(a, b);

function stampAfterAll(entries) {
	const times = entries.map((entry) => time(entry.updated_at)).filter(Number.isFinite);

	return new Date((times.length ? Math.max(...times) : 0) + 1).toISOString();
}

// Live entries grouped by `key(entry)`, only groups of two or more.
function liveGroups(list, key) {
	const groups = new Map();

	for (const entry of list) {
		const value = entry && entry.id && !entry.deleted_at ? key(entry) : null;

		if (value) {
			if (!groups.has(value)) {
				groups.set(value, []);
			}

			groups.get(value).push(entry);
		}
	}

	return [...groups.values()].filter((members) => members.length > 1);
}

const livePhotoIds = (photos) => new Set((Array.isArray(photos) ? photos : []).filter((photo) => photo && photo.id && !photo.deleted_at).map((photo) => photo.id));

// One copy out of the group: the oldest (earliest created_at, then the
// lowest id) survives, so every phone picks the same one. It keeps every
// photo of the group, its own pin while that still shows a live image (else
// the newest other pin), the newest Liga price, the newest non-empty value of
// each field a person sets, and the import fields of the most recently
// edited copy.
function survivorOf(members) {
	const [survivor] = [...members].sort(oldestFirst);
	const newest = [...members].sort(newestFirst);
	const kept = {...survivor};

	for (const key of IMPORT_FIELDS) {
		if (newest[0][key] === undefined) {
			delete kept[key];
		}
		else {
			kept[key] = newest[0][key];
		}
	}

	for (const key of USER_FIELDS) {
		const from = newest.find((member) => filled(member[key]));

		if (from) {
			kept[key] = from[key];
		}
	}

	if (members.some((member) => member.is_favorite)) {
		kept.is_favorite = true;
	}

	const priced = newest.find((member) => member.price_manual);

	if (priced) {
		kept.price_manual = priced.price_manual;
	}

	if (members.some((member) => Array.isArray(member.photos))) {
		kept.photos = [survivor, ...newest.filter((member) => member !== survivor)]
			.reduce((photos, member) => mergePhotoLists(photos, member.photos), []);
	}

	const live = livePhotoIds(kept.photos);
	const shows = (pin) => pin === 'official' || pin === 'twin' || live.has(pin);

	if (!shows(survivor.main_image)) {
		const pinned = newest.find((member) => member !== survivor && filled(member.main_image) && shows(member.main_image));

		if (pinned) {
			kept.main_image = pinned.main_image;
		}
	}

	return kept;
}

// Folds live cards that share an import_key into one. The others become
// tombstones that name the survivor in merged_into; all of them, survivor
// included, are stamped just after the newest of the group, so every phone
// computes the same result. Returns the list passed in when nothing changed.
export function collapseImportDuplicates(cards) {
	if (!Array.isArray(cards)) {
		return cards;
	}

	const replace = new Map();

	for (const members of liveGroups(cards, (card) => card.import_key || null)) {
		const kept = survivorOf(members);
		const at = stampAfterAll(members);

		replace.set(kept.id, stampEntry(members.find((member) => member.id === kept.id), {...kept, deleted_at: null, updated_at: at}));

		for (const member of members) {
			if (member.id !== kept.id) {
				replace.set(member.id, {...member, deleted_at: at, merged_into: kept.id, updated_at: at});
			}
		}
	}

	return replace.size ? cards.map((card) => (card && replace.get(card.id)) || card) : cards;
}

// merged_into id -> the live entry it ends at, following chains.
function mergedTargets(list) {
	const next = new Map();

	for (const entry of list || []) {
		if (entry && entry.deleted_at && entry.merged_into) {
			next.set(entry.id, entry.merged_into);
		}
	}

	const resolve = (id) => {
		let at = id;

		for (let hops = 0; next.has(at) && hops < 32; hops++) {
			at = next.get(at);
		}

		return at;
	};

	return {next, resolve};
}

// The survivor keeps every photo of the copies folded into it, even when a
// version of it that never saw them (an edit from a phone that had not
// synced yet) wins a later merge. Photos are never dropped from a list, only
// tombstoned, so a union can never bring a removed photo back.
function refoldPhotos(cards) {
	if (!Array.isArray(cards)) {
		return cards;
	}

	const {next, resolve} = mergedTargets(cards);

	if (!next.size) {
		return cards;
	}

	const sources = new Map();

	for (const card of cards) {
		if (card && next.has(card.id) && Array.isArray(card.photos) && card.photos.length) {
			const target = resolve(card.id);

			if (!sources.has(target)) {
				sources.set(target, []);
			}

			sources.get(target).push(card);
		}
	}

	if (!sources.size) {
		return cards;
	}

	return cards.map((card) => {
		if (!card || card.deleted_at || !sources.has(card.id)) {
			return card;
		}

		const photos = sources.get(card.id).sort(byId).reduce((list, source) => mergePhotoLists(list, source.photos), Array.isArray(card.photos) ? card.photos : []);

		if (stableJson(photos) === stableJson(card.photos || [])) {
			return card;
		}

		return bumpTo({...card, photos}, stampAfter(card, card));
	});
}

// Binder pockets that hold a copy folded into another now hold the
// survivor. Each pocket keeps its placed_at, so "placed last wins"
// (js/binders.js placements) still decides when the survivor ends up in two
// pockets. A rewritten binder is stamped 1 ms after its own version. This
// runs after every merge, so a stale pocket coming back from a phone that has
// not repaired yet is redirected again.
export function redirectPockets(binders, cards) {
	if (!Array.isArray(binders)) {
		return binders;
	}

	const {next, resolve} = mergedTargets(cards);

	if (!next.size) {
		return binders;
	}

	let changed = false;

	const out = binders.map((binder) => {
		if (!binder || binder.deleted_at || !Array.isArray(binder.slots) || !binder.slots.some((slot) => slot && next.has(slot.entry_id))) {
			return binder;
		}

		changed = true;

		return bumpTo({
			...binder,
			slots: binder.slots.map((slot) => (slot && next.has(slot.entry_id) ? {...slot, entry_id: resolve(slot.entry_id)} : slot)),
		}, stampAfter(binder, binder));
	});

	return changed ? out : binders;
}

// "list|id" -> updated_at for every entry, plus "settings" -> its content:
// what a document holds, in a form two documents can be compared by.
export function stamps(doc) {
	const out = new Map();

	if (doc && doc.settings) {
		out.set('settings', stableJson(doc.settings));
	}

	for (const [key, value] of Object.entries(doc || {})) {
		if (!Array.isArray(value)) {
			continue;
		}

		for (const entry of value) {
			if (entry && entry.id) {
				out.set(`${key}|${entry.id}`, String(entry.updated_at));
			}
		}
	}

	return out;
}

// True when the two documents hold the same entries at the same versions,
// and the same settings.
export function sameContent(a, b) {
	const left = stamps(a);
	const right = stamps(b);

	if (left.size !== right.size) {
		return false;
	}

	for (const [key, value] of left) {
		if (right.get(key) !== value) {
			return false;
		}
	}

	return true;
}

// Entries in doc that differ from the stamps last known to be on the server.
export function countChanged(doc, base) {
	let changed = 0;

	for (const [key, value] of stamps(doc)) {
		if (!base || base.get(key) !== value) {
			changed++;
		}
	}

	return changed;
}
