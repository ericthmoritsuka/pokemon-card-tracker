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

	if (!special) {
		return newerEntry(a, b);
	}

	return newerEntry(a, b) === special ? special : {...special, updated_at: stampAfter(a, b)};
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

	return {...rest, deleted_at: null, restored_at: at, updated_at: at};
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

	out.cards = refoldPhotos(collapseImportDuplicates(out.cards));
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

		replace.set(kept.id, kept);

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

		replace.set(kept.id, {...kept, deleted_at: null, updated_at: at});

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

		return {...card, photos, updated_at: stampAfter(card, card)};
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

		return {
			...binder,
			slots: binder.slots.map((slot) => (slot && next.has(slot.entry_id) ? {...slot, entry_id: resolve(slot.entry_id)} : slot)),
			updated_at: stampAfter(binder, binder),
		};
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
