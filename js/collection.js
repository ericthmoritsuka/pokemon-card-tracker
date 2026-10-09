// Each person's cards: one JSON document per person, kept in IndexedDB
// (DESIGN.md sections 3 and 4). The phone shows one document, stored under
// the key "local". Its user_id is null until someone signs in on this phone;
// from then on it belongs to that account and js/sync.js keeps it merged with
// the account's documents row.
//
// Every entry carries id, updated_at, and deleted_at, so the sync merges
// entry by entry (js/merge.js): the newer updated_at wins, and a deletion
// stays as a tombstone that sticks, so an offline phone cannot bring a
// deleted card back. Two tabs on one phone merge the same way (see "tabs").

import {cardIndex} from './catalog.js';
import {database} from './idb.js';
import {LISTS, mergeDocuments, nextStamp, restoreEntry, sameContent, stampEntry} from './merge.js';

export {mergeEntries} from './merge.js';

const DB_NAME = 'card-tracker-collection';
const STORE = 'documents';
const LOCAL_PERSON = 'local';

let current = null;

const listeners = new Set();

const phoneDb = database(DB_NAME, [STORE]);
const openDb = phoneDb.open;
const idb = (mode, op) => phoneDb.run(STORE, mode, op);

export const nowIso = () => new Date().toISOString();

export function newId() {
	if (crypto.randomUUID) {
		return crypto.randomUUID();
	}

	// RFC 4122 version 4 from random bytes, for browsers without randomUUID.
	const bytes = crypto.getRandomValues(new Uint8Array(16));

	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;

	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function emptyDocument() {
	const doc = {person: LOCAL_PERSON, updated_at: nowIso(), user_id: null, version: 1};

	for (const list of LISTS) {
		doc[list] = [];
	}

	return doc;
}

function normalize(doc) {
	for (const list of LISTS) {
		doc[list] = Array.isArray(doc[list]) ? doc[list] : [];
	}

	doc.user_id = doc.user_id || null;

	return doc;
}

// ------------------------------------------------------- tabs
//
// Two tabs of the app (or the installed app and a Chrome tab, which share
// storage on Android) each hold the document in memory. Every save
// therefore re-reads the stored document inside its own IndexedDB
// transaction, and when another tab wrote since this one last read or
// wrote, merges this tab's version into it entry by entry (js/merge.js)
// before writing; then it tells the other tabs through a BroadcastChannel,
// and they merge the stored document into theirs so they show the change.
// A save writes a fresh revision id beside the document, so "another tab
// wrote" is one comparison and the common case costs no merge. Signed in,
// the sync merges with the server as before.

const REV_KEY = 'local:rev';
const CHANNEL = 'card-tracker-collection';

let knownRev = null;
let knownStamp = null;
let channel = null;

// Reads the stored document and its revision in one transaction.
async function readStored() {
	const db = await openDb();

	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, 'readonly');
		const docRequest = tx.objectStore(STORE).get(LOCAL_PERSON);
		const revRequest = tx.objectStore(STORE).get(REV_KEY);

		tx.oncomplete = () => resolve({rev: revRequest.result ?? null, stored: docRequest.result || null});
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

const changedElsewhere = (stored, rev) => Boolean(stored) && (rev !== knownRev || stored.updated_at !== knownStamp);

// Puts `next`'s content into `doc`, the object every view and edit holds.
function replaceContent(doc, next) {
	for (const key of Object.keys(doc)) {
		delete doc[key];
	}

	Object.assign(doc, next);
}

// Merges the stored version into `doc` in place, entry by entry. The
// stored version names the account when this tab's does not yet (another
// tab signed in).
function absorb(doc, stored) {
	const merged = mergeDocuments(doc, stored);

	for (const key of Object.keys(merged)) {
		if (key !== 'user_id' && key !== 'person') {
			doc[key] = merged[key];
		}
	}

	doc.user_id = doc.user_id || stored.user_id || null;
	normalize(doc);
}

const notify = (doc, source) => listeners.forEach((listener) => listener(doc, {source}));

// Another tab saved: merge what it stored into this tab's document, so the
// screen shows it. When the other tab switched to another account, this tab
// follows. Returns true when anything was taken in.
async function refreshFromStore() {
	if (!current) {
		return false;
	}

	const {rev, stored} = await readStored();

	if (!changedElsewhere(stored, rev)) {
		return false;
	}

	const doc = current;
	let source = 'tab';

	if (doc.user_id && stored.user_id !== doc.user_id) {
		replaceContent(doc, normalize({...stored}));
		source = 'account';
	}
	else {
		absorb(doc, stored);
	}

	knownRev = rev;
	knownStamp = stored.updated_at;
	notify(doc, source);

	return true;
}

function listenToTabs() {
	if (channel || typeof BroadcastChannel !== 'function') {
		return;
	}

	channel = new BroadcastChannel(CHANNEL);
	channel.onmessage = () => {
		refreshFromStore().catch(() => {
			// The next save merges with the stored document anyway.
		});
	};
}

export async function loadDocument() {
	if (!current) {
		const {rev, stored} = await readStored();

		if (!current) {
			current = normalize(stored || emptyDocument());
			knownRev = rev;
			knownStamp = stored ? stored.updated_at : null;
			listenToTabs();
		}
	}

	return current;
}

// source is 'local' for the person's own edits, 'sync' for entries merged in
// from the server, and 'account' when the document changes hands. Only
// 'local' saves are pushed. Other tabs see the change with source 'tab'.
// replace: write this document as it is, never merged with the stored one
// (only for a switch of account).
async function saveDocument(doc, source = 'local', {replace = false} = {}) {
	const rev = newId();
	const db = await openDb();
	let tookOver = false;

	await new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, 'readwrite');
		const store = tx.objectStore(STORE);
		const docRequest = store.get(LOCAL_PERSON);
		const revRequest = store.get(REV_KEY);

		// Requests in one transaction finish in order, so the document is read
		// by now. Everything below is synchronous, inside the transaction, so
		// no other tab can write in between.
		revRequest.onsuccess = () => {
			const stored = docRequest.result;

			if (!replace && changedElsewhere(stored, revRequest.result ?? null)) {
				if (doc.user_id && stored.user_id && stored.user_id !== doc.user_id) {
					// Another tab switched accounts: this tab's version goes to
					// its owner's stash, never into the other account, and this
					// tab takes the stored document.
					const key = `user:${doc.user_id}`;
					const mine = {...doc};
					const stash = store.get(key);

					stash.onsuccess = () => store.put(stash.result ? mergeDocuments(mine, stash.result) : mine, key);
					replaceContent(doc, normalize({...stored}));
					tookOver = true;
				}
				else {
					absorb(doc, stored);
				}
			}

			doc.updated_at = nowIso();
			store.put(doc, LOCAL_PERSON);
			store.put(rev, REV_KEY);
			knownRev = rev;
			knownStamp = doc.updated_at;
		};

		tx.oncomplete = () => resolve();
		tx.onerror = () => {
			knownRev = null;
			reject(tx.error);
		};
		tx.onabort = () => {
			knownRev = null;
			reject(tx.error);
		};
	});

	current = doc;
	notify(doc, tookOver ? 'account' : source);

	if (channel) {
		channel.postMessage({rev});
	}
}

// listener(doc, {source}) runs after every save. Returns the unsubscribe
// function.
export function onChange(listener) {
	listeners.add(listener);

	return () => listeners.delete(listener);
}

// Merges another version of the document (the server's) into the one on the
// phone. The merge lands in the same object every view and edit holds, so an
// edit made while a sync was on the network is kept: it is newer, so it wins.
// Returns true when anything changed.
export async function mergeIntoLocal(other) {
	const doc = await loadDocument();
	const merged = mergeDocuments(doc, other);

	if (sameContent(doc, merged)) {
		return false;
	}

	for (const key of Object.keys(merged)) {
		if (key !== 'user_id' && key !== 'person') {
			doc[key] = merged[key];
		}
	}

	await saveDocument(doc, 'sync');

	return true;
}

// Ties the phone's document to the signed-in account. A document no account
// has claimed yet (cards added while signed out) becomes this account's, so
// the first sign-in uploads it. A document that belongs to someone else is
// set aside under "user:<id>", never merged into another account, and comes
// back when that person signs in here again.
export async function useAccount(userId) {
	const doc = await loadDocument();

	// Another tab may have signed in or switched accounts already.
	await refreshFromStore().catch(() => {});

	if (doc.user_id === userId) {
		return {adopted: false};
	}

	if (!doc.user_id) {
		doc.user_id = userId;
		await saveDocument(doc, 'account');

		return {adopted: true};
	}

	const theirs = doc.user_id;
	const stashed = await idb('readonly', (store) => store.get(`user:${userId}`));
	const next = normalize(stashed || emptyDocument());

	next.user_id = userId;
	await idb('readwrite', (store) => store.put({...doc}, `user:${theirs}`));

	for (const key of Object.keys(doc)) {
		delete doc[key];
	}

	Object.assign(doc, next);
	await saveDocument(doc, 'account', {replace: true});

	if (stashed) {
		await idb('readwrite', (store) => store.delete(`user:${userId}`));
	}

	return {adopted: false};
}

// Small records beside the document, such as what the sync last saw on the
// server. Kept in the same database, so they go when the document goes.
export const readMeta = (key) => idb('readonly', (store) => store.get(`meta:${key}`));

export const writeMeta = (key, value) => idb('readwrite', (store) => store.put(value, `meta:${key}`));

// ------------------------------------------------------------ card entries

// The fields an entry may carry. One physical card, one entry: there is no
// quantity field (DESIGN.md section 3).
const ENTRY_FIELDS = [
	'card_id', 'catalog', 'variant_id', 'finish_raw', 'fallback',
	'language', 'language_source', 'import_key', 'name_local', 'set_name_local',
	'condition', 'purchase_price', 'purchase_currency', 'opening_id', 'storage',
	'grader', 'grade', 'cert_number', 'graded_price',
	'notes', 'is_favorite', 'photo_path',
	// The owner's own photos and the pinned tile image (js/photos/model.js).
	'photos', 'main_image',
	// The Liga Pokémon price the owner typed in, {low_nm, avg, currency:
	// 'BRL', source, date} (js/prices.js). null clears it.
	'price_manual',
	// A hand-made card's printed number and set code (js/custom-card.js);
	// its name and set name are name_local and set_name_local.
	'number_local', 'set_code',
];

function pick(fields) {
	const out = {};

	for (const key of ENTRY_FIELDS) {
		if (fields[key] !== undefined) {
			out[key] = fields[key];
		}
	}

	return out;
}

export const isLive = (entry) => !entry.deleted_at;

// Changes a stored entry in place and stamps what changed (js/merge.js
// stampEntry), so the merge can tell which fields this edit touched and
// keep another phone's edit to the others.
function editEntry(entry, change) {
	const before = {...entry};

	change();
	Object.assign(entry, stampEntry(before, entry));
}

// The live entry an id stands for now: the entry itself, or, when the merge
// folded it into another copy of the same card (js/merge.js, merged_into),
// the copy it was folded into. Null when there is no live one. Photo uploads
// and the photo restore use it, so a photo taken on a duplicate is not lost.
export function resolveEntry(cards, id) {
	const byId = new Map((cards || []).filter(Boolean).map((card) => [card.id, card]));
	let entry = byId.get(id);

	for (let hops = 0; entry && entry.deleted_at && entry.merged_into && hops < 32; hops++) {
		entry = byId.get(entry.merged_into);
	}

	return entry && isLive(entry) ? entry : null;
}

// The names the source gave a copy (name_local, set_name_local), when the
// catalog record has no localization in the copy's own language: a Korean
// copy on a Japanese record, or any fallback match (DESIGN.md section 5).
// Null when the catalog's names apply, or when the source gave no name.
export function sourceNames(entry, record) {
	if (!entry || !entry.name_local) {
		return null;
	}

	const localizations = (record && record.localizations) || {};

	if (!entry.fallback && localizations[entry.language]) {
		return null;
	}

	return {name: entry.name_local, setName: entry.set_name_local || null};
}

export async function listCards() {
	const doc = await loadDocument();

	return doc.cards.filter(isLive);
}

export async function addCard(fields) {
	const doc = await loadDocument();
	const at = fields.created_at || nowIso();
	const entry = {...pick(withPlace(doc, fields, Date.now())), created_at: at, deleted_at: null, id: newId(), updated_at: at};

	doc.cards.push(entry);
	await saveDocument(doc);

	return entry;
}

// Several new entries in one save, so a hand-made card's copies are written
// once (js/custom-card.js). Each is stamped one millisecond after the last.
// Returns the entries added.
export async function addCards(list) {
	const doc = await loadDocument();
	const now = Date.now();
	const added = list.map((fields, i) => {
		const at = fields.created_at || new Date(now + i).toISOString();

		return {...pick(withPlace(doc, fields, now)), created_at: at, deleted_at: null, id: newId(), updated_at: at};
	});

	if (added.length) {
		doc.cards.push(...added);
		await saveDocument(doc);
	}

	return added;
}

export async function updateCard(id, patch) {
	const doc = await loadDocument();
	const entry = doc.cards.find((card) => card.id === id && isLive(card));

	if (!entry) {
		throw new Error(`No card entry ${id}.`);
	}

	editEntry(entry, () => Object.assign(entry, pick(withPlace(doc, patch, Date.now())), {updated_at: nextStamp(entry.updated_at)}));
	await saveDocument(doc);

	return entry;
}

// Several updateCard patches in one save, so a change that touches every
// copy of a card (its main image) redraws the views once. patches is
// [{id, patch}]; ids with no live entry are skipped. Returns the entries
// changed.
export async function updateCards(patches) {
	const doc = await loadDocument();
	const now = Date.now();
	const changed = [];

	for (const {id, patch} of patches) {
		const entry = doc.cards.find((card) => card.id === id && isLive(card));

		if (entry) {
			editEntry(entry, () => Object.assign(entry, pick(withPlace(doc, patch, now)), {updated_at: nextStamp(entry.updated_at, now)}));
			changed.push(entry);
		}
	}

	if (changed.length) {
		await saveDocument(doc);
	}

	return changed;
}

// Soft delete: the entry stays as a tombstone.
export async function deleteCard(id) {
	const doc = await loadDocument();
	const entry = doc.cards.find((card) => card.id === id && isLive(card));

	if (entry) {
		const at = nextStamp(entry.updated_at);

		editEntry(entry, () => Object.assign(entry, {deleted_at: at, updated_at: at}));
		await saveDocument(doc);
	}

	return entry || null;
}

// Several deleteCard calls in one save, so removing many copies at once
// (Remove all, a count typed lower) writes the document once. Ids with no
// live entry are skipped. Returns the entries deleted.
export async function deleteCards(ids) {
	const wanted = new Set(ids);
	const doc = await loadDocument();
	const now = Date.now();
	const deleted = [];

	for (const entry of doc.cards) {
		if (wanted.has(entry.id) && isLive(entry)) {
			const at = nextStamp(entry.updated_at, now);

			editEntry(entry, () => Object.assign(entry, {deleted_at: at, updated_at: at}));
			deleted.push(entry);
		}
	}

	if (deleted.length) {
		await saveDocument(doc);
	}

	return deleted;
}

// Brings deleted copies back on purpose, for Undo after a removal:
// deleted_at cleared and restored_at stamped after the delete (js/merge.js
// restoreEntry), so the merge lets them win over the tombstone another
// phone may already hold. id is one id or a list of them, restored in one
// save. Returns the restored entry (null when there was none to restore),
// or the list of restored entries for a list.
export async function restoreCard(id) {
	const ids = Array.isArray(id) ? id : [id];
	const wanted = new Set(ids);
	const doc = await loadDocument();
	const now = Date.now();
	const restored = [];

	doc.cards.forEach((entry, i) => {
		if (wanted.has(entry.id) && entry.deleted_at) {
			doc.cards[i] = restoreEntry(entry, now);
			restored.push(doc.cards[i]);
		}
	});

	if (restored.length) {
		await saveDocument(doc);
	}

	return Array.isArray(id) ? restored : restored[0] || null;
}

// The fields an import compares to decide whether a row changed.
const IMPORT_COMPARED = ['card_id', 'catalog', 'variant_id', 'finish_raw', 'fallback', 'language', 'name_local', 'set_name_local'];

// A fixed namespace for import ids. Never change it: every phone must turn
// the same import key into the same id.
const IMPORT_NAMESPACE = '7be437b4-f8be-497e-9069-eee96a6cffac';

const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

const uuidText = (text) => `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20, 32)}`;

// The entry id for an imported row: a UUID version 5 of its import key, so
// the same file imported on two phones (or signed out, then signed in) gives
// the same ids and the merge sees one entry per copy (plans/sync-merge-plan.md
// section 1a). Lowercase hex and hyphens, which photo paths accept
// (supabase/photos.sql). Falls back to a random id where crypto.subtle is
// missing; the merge's duplicate repair (js/merge.js) covers that phone.
export async function importEntryId(importKey) {
	const subtle = globalThis.crypto && globalThis.crypto.subtle;

	if (!subtle) {
		return newId();
	}

	const namespace = IMPORT_NAMESPACE.replace(/-/g, '').match(/../g).map((pair) => Number.parseInt(pair, 16));
	const name = new TextEncoder().encode(String(importKey));
	const input = new Uint8Array(namespace.length + name.length);

	input.set(namespace);
	input.set(name, namespace.length);

	const bytes = new Uint8Array(await subtle.digest('SHA-1', input)).slice(0, 16);

	bytes[6] = (bytes[6] & 0x0f) | 0x50;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;

	return uuidText(hex(bytes));
}

// import_key -> the entry an import should compare with. A live entry wins
// over a tombstone with the same key, so a duplicate the merge folded away
// (js/merge.js, merged_into) never hides the copy that is still there.
function entriesByKey(cards) {
	const byKey = new Map();

	for (const card of cards) {
		if (!card || !card.import_key) {
			continue;
		}

		const there = byKey.get(card.import_key);

		if (!there || (!isLive(there) && isLive(card))) {
			byKey.set(card.import_key, card);
		}
	}

	return byKey;
}

// What an import does to the cards, without saving anything: a pure step, so
// Node tests it (tests/import.test.mjs). An entry whose key is already
// present is updated when its catalog match or its source names changed and
// left alone otherwise; a key whose entry was deleted is skipped, so a rerun
// never brings back a card the owner removed. New entries take their id from
// `ids` (import_key -> id, see importEntryId) and are stamped one
// millisecond apart from `now`, so "date added" keeps the export's order.
// Returns {cards, counts}: a new list, with changed entries as new objects;
// the list passed in is not changed.
export function planImport(cards, entries, {ids = new Map(), now = Date.now()} = {}) {
	const out = [...cards];
	const byKey = entriesByKey(out);
	const position = new Map(out.map((card, i) => [card, i]));
	const taken = new Set(out.map((card) => card.id));
	const counts = {added: 0, skippedDeleted: 0, unchanged: 0, updated: 0};

	entries.forEach((fields, i) => {
		const existing = byKey.get(fields.import_key);

		if (!existing) {
			const at = new Date(now + i).toISOString();
			const wanted = ids.get(fields.import_key);
			const id = wanted && !taken.has(wanted) ? wanted : newId();
			const entry = {...pick(fields), created_at: at, deleted_at: null, id, updated_at: at};

			out.push(entry);
			taken.add(id);
			byKey.set(entry.import_key, entry);
			counts.added++;

			return;
		}

		if (!isLive(existing)) {
			counts.skippedDeleted++;

			return;
		}

		const next = pick(fields);
		const changed = IMPORT_COMPARED.some((key) => (existing[key] ?? null) !== (next[key] ?? null));

		if (!changed) {
			counts.unchanged++;

			return;
		}

		const updated = {...existing};

		for (const key of IMPORT_COMPARED) {
			if (next[key] === undefined) {
				delete updated[key];
			}
		}

		Object.assign(updated, next, {updated_at: nextStamp(existing.updated_at, now)});
		Object.assign(updated, stampEntry(existing, updated));
		out[position.get(existing)] = updated;
		position.set(updated, position.get(existing));
		byKey.set(updated.import_key, updated);
		counts.updated++;
	});

	return {cards: out, counts};
}

// Adds or updates imported entries by import_key in one save (planImport).
export async function applyImport(entries) {
	const doc = await loadDocument();
	const byKey = entriesByKey(doc.cards);
	const ids = new Map();

	for (const fields of entries) {
		if (!byKey.has(fields.import_key) && !ids.has(fields.import_key)) {
			ids.set(fields.import_key, await importEntryId(fields.import_key));
		}
	}

	const {cards, counts} = planImport(doc.cards, entries, {ids, now: Date.now()});

	doc.cards = cards;
	await saveDocument(doc);

	return counts;
}

// ------------------------------------------------- the app's own CSV

// The fields a re-import of the app's own CSV restores and compares
// (DESIGN.md section 9). A row leaves out a field (undefined) when its file
// has no column for it, an older export say, and that field is then left
// as it is.
const OWN_COMPARED = [
	'card_id', 'catalog', 'variant_id', 'finish_raw', 'fallback', 'language', 'import_key',
	'name_local', 'set_name_local', 'condition', 'notes', 'price_manual', 'number_local', 'set_code',
	'storage',
];

const day = (value) => (value ? String(value).slice(0, 10) : null);

// A Liga price as the CSV can carry it: the two prices and the day.
const priceText = (value) => (value && typeof value === 'object'
	? JSON.stringify([value.low_nm ?? null, value.avg ?? null, day(value.date)])
	: 'null');

function sameField(key, a, b) {
	if (key === 'price_manual') {
		return priceText(a) === priceText(b);
	}

	if (key === 'fallback') {
		return Boolean(a) === Boolean(b);
	}

	return (a ?? null) === (b ?? null) || ((a ?? '') === '' && (b ?? '') === '');
}

// The fields of a row that differ from the entry, as a patch.
function ownPatch(entry, fields) {
	const patch = {};

	for (const key of OWN_COMPARED) {
		if (fields[key] !== undefined && !sameField(key, entry[key], fields[key])) {
			patch[key] = fields[key];
		}
	}

	return patch;
}

// What re-importing the app's own CSV does, without saving: a pure step,
// tested in Node (tests/import.test.mjs). rows are js/monprice.js
// parseOwnCsv rows, {id, created_at, ...fields}. Each row is the entry with
// its id: absent, it is added with that id (or, when the id is taken by
// something else, a new one); live and alike, it is left alone; live and
// different, only the differing fields change; deleted, it stays deleted
// unless revive is true, which brings it back as Undo does (restoreEntry).
// A row whose id is unknown but whose import_key a live entry holds is that
// entry, so a monprice import and a re-import never make two of one copy.
// Returns {cards, counts, statuses}; the list passed in is not changed.
export function planOwnImport(cards, rows, {now = Date.now(), revive = false} = {}) {
	const out = [...cards];
	const byId = new Map(out.map((card, i) => [card.id, i]));
	const byKey = entriesByKey(out);
	const counts = {added: 0, revived: 0, skippedDeleted: 0, unchanged: 0, updated: 0};
	// Each row's outcome, in order: added, unchanged, updated, deleted (left
	// deleted), or revived.
	const statuses = [];

	const stampChange = (i, patch, base = out[i]) => {
		const updated = {...base, ...pick(patch), updated_at: nextStamp(base.updated_at, now)};

		out[i] = {...updated, ...stampEntry(base, updated)};
	};

	rows.forEach((raw, n) => {
		// Stored in, cleaned as the copy sheet saves it.
		const row = raw.storage === undefined ? raw : {...raw, storage: cleanPlace(raw.storage) || null};
		let i = byId.get(row.id);

		if (i === undefined && row.import_key) {
			const keyed = byKey.get(row.import_key);

			if (keyed && isLive(keyed)) {
				i = out.indexOf(keyed);
			}
		}

		if (i !== undefined && !isLive(out[i]) && out[i].merged_into) {
			const live = resolveEntry(out, out[i].id);

			i = live ? out.indexOf(live) : i;
		}

		if (i === undefined) {
			const at = new Date(now + n).toISOString();
			// Empty cells add nothing, so a new copy carries only its fields.
			const fields = Object.fromEntries(Object.entries(pick(row)).filter(([, value]) => value !== null));
			const entry = {...fields, created_at: row.created_at || at, deleted_at: null, id: row.id, updated_at: at};

			out.push(entry);
			byId.set(entry.id, out.length - 1);

			if (entry.import_key) {
				byKey.set(entry.import_key, entry);
			}

			counts.added++;
			statuses.push('added');

			return;
		}

		const entry = out[i];

		if (!isLive(entry)) {
			if (!revive) {
				counts.skippedDeleted++;
				statuses.push('deleted');

				return;
			}

			const restored = restoreEntry(entry, now);

			out[i] = restored;

			const patch = ownPatch(restored, row);

			if (Object.keys(patch).length) {
				stampChange(i, patch, restored);
			}

			counts.revived++;
			statuses.push('revived');

			return;
		}

		const patch = ownPatch(entry, row);

		if (!Object.keys(patch).length) {
			counts.unchanged++;
			statuses.push('unchanged');

			return;
		}

		stampChange(i, patch);
		counts.updated++;
		statuses.push('updated');
	});

	return {cards: out, counts, statuses};
}

// Adds, updates, and (when revive) restores the rows of the app's own CSV
// in one save (planOwnImport).
export async function applyOwnImport(rows, {revive = false} = {}) {
	const doc = await loadDocument();
	const now = Date.now();
	const {cards, counts} = planOwnImport(doc.cards, rows, {now, revive});

	doc.cards = cards;

	// A place a row names joins the saved places, as if typed in the sheet.
	for (const row of rows) {
		if (cleanPlace(row.storage)) {
			ensurePlace(doc, cleanPlace(row.storage), now);
		}
	}

	await saveDocument(doc);

	return counts;
}

// What a re-import of these rows would do now, for the report.
export async function previewOwnImport(rows) {
	const doc = await loadDocument();

	const {counts, statuses} = planOwnImport(doc.cards, rows);

	return {counts, statuses};
}

export async function importKeys() {
	const doc = await loadDocument();

	return entriesByKey(doc.cards);
}

// ---------------------------------------------- where copies are stored
//
// "Stored in" (DESIGN.md section 4, Eric, 2026-10-09): each copy's storage
// field names a place in a few words, "Bulk box A". The places themselves
// are a list of their own in the document, storage_places, so a place stays
// on offer when no copy is in it any more. A place is added the first time
// a copy is stored in it, and renamed or removed from the Places sheet
// (js/copy-sheet.js), which changes every copy stored there.
//
// The list syncs with no change to js/merge.js: every top-level array in
// the document is merged entry by entry, like cards and binders, so a place
// added on each of two phones keeps both and a removed place is a tombstone
// that stays removed. A place's id comes from its name, so the same place
// typed on two phones is one entry, not two.

// The longest place name: a box label, not a note.
export const STORAGE_MAX = 40;

// A place as it is saved: one line, single spaces, at most STORAGE_MAX
// characters. "" when nothing is left.
export const cleanPlace = (text) => String(text ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, STORAGE_MAX).trim();

// What makes two spellings one place: "box a" is "Box A".
export const placeFold = (text) => cleanPlace(text).toLocaleLowerCase('en');

// FNV-1a over the folded name, twice with two seeds: a stable id per name.
function placeId(fold) {
	const hash = (seed) => {
		let value = seed;

		for (const char of fold) {
			value ^= char.codePointAt(0);
			value = Math.imul(value, 16777619) >>> 0;
		}

		return value.toString(16).padStart(8, '0');
	};

	return `place_${hash(2166136261)}${hash(84696351)}`;
}

const livePlace = (place) => Boolean(place && place.id && !place.deleted_at && cleanPlace(place.name));

const placeOrder = (a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || String(a.id).localeCompare(String(b.id));

// The live saved places with this folded name, oldest first.
const savedAs = (doc, fold) => (Array.isArray(doc.storage_places) ? doc.storage_places : [])
	.filter((place) => livePlace(place) && placeFold(place.name) === fold)
	.sort(placeOrder);

// Remembers how a place was before a change, once, for Undo: null when the
// change made it.
function note(touched, place, made = false) {
	if (touched && !touched.has(place.id)) {
		touched.set(place.id, made ? null : structuredClone(place));
	}
}

function editPlace(doc, place, change, now) {
	const list = doc.storage_places;
	const i = list.indexOf(place);
	const next = {...place, ...change, updated_at: nextStamp(place.updated_at, now)};

	list[i] = stampEntry(place, next);

	return list[i];
}

// The saved place for name, added (or a removed one brought back) when
// there is none. Returns the name as the place spells it.
function ensurePlace(doc, name, now, touched = null) {
	const fold = placeFold(name);
	const [found] = savedAs(doc, fold);

	if (found) {
		return found.name;
	}

	if (!Array.isArray(doc.storage_places)) {
		doc.storage_places = [];
	}

	const list = doc.storage_places;
	const id = placeId(fold);
	const old = list.find((place) => place && place.id === id);

	if (old && old.deleted_at) {
		note(touched, old);

		const back = restoreEntry(old, now);

		list[list.indexOf(old)] = back;

		if (back.name !== name) {
			editPlace(doc, back, {name}, now);
		}

		return name;
	}

	const at = new Date(now).toISOString();
	// The id a name gives is taken when a place was renamed away from it.
	const place = {created_at: at, deleted_at: null, id: old ? newId() : id, name, updated_at: at};

	list.push(place);
	note(touched, place, true);

	return name;
}

// fields with storage cleaned and spelled as its saved place, which is
// added to the document's places when new. Fields without storage are
// returned as they are.
function withPlace(doc, fields, now) {
	if (!fields || fields.storage === undefined) {
		return fields;
	}

	const name = cleanPlace(fields.storage);

	return {...fields, storage: name ? ensurePlace(doc, name, now) : null};
}

const collator = new Intl.Collator('en', {numeric: true, sensitivity: 'base'});

// Every place, {name, count, saved}: the saved ones, and any a copy names
// that the list lacks (saved false: written by a CSV, or a place removed on
// another phone while this one stored a copy there). count is the live
// copies stored there. Most used first, then by name.
export function storedPlaces(doc) {
	const places = new Map();

	for (const place of (Array.isArray(doc && doc.storage_places) ? doc.storage_places : []).filter(livePlace).sort(placeOrder)) {
		const fold = placeFold(place.name);

		if (!places.has(fold)) {
			places.set(fold, {count: 0, name: cleanPlace(place.name), saved: true});
		}
	}

	for (const card of (doc && Array.isArray(doc.cards) ? doc.cards : [])) {
		const name = card && !card.deleted_at ? cleanPlace(card.storage) : '';

		if (!name) {
			continue;
		}

		const fold = placeFold(name);

		if (!places.has(fold)) {
			places.set(fold, {count: 0, name, saved: false});
		}

		places.get(fold).count++;
	}

	return [...places.values()].sort((a, b) => b.count - a.count || collator.compare(a.name, b.name));
}

export async function listPlaces() {
	return storedPlaces(await loadDocument());
}

// Before-images of the copies a change touches, for Undo.
const cardBefore = (entry) => ({had: Object.hasOwn(entry, 'storage'), id: entry.id, storage: entry.storage ?? null});

function storeIn(entry, name, now) {
	editEntry(entry, () => Object.assign(entry, {storage: name, updated_at: nextStamp(entry.updated_at, now)}));
}

async function finish(doc, cards, touched, name = null) {
	if (cards.length || touched.size) {
		await saveDocument(doc);
	}

	return {changed: cards.length, name, undo: {cards, places: [...touched]}};
}

// Stores these copies in one place (text as typed; empty clears it), in one
// save. Returns {changed, name, undo}: the copies changed, the place as
// saved, and what undoStorage needs to put it all back.
export async function setStorage(ids, text) {
	const doc = await loadDocument();
	const now = Date.now();
	const touched = new Map();
	const clean = cleanPlace(text);
	const name = clean ? ensurePlace(doc, clean, now, touched) : null;
	const wanted = new Set(ids);
	const cards = [];

	for (const entry of doc.cards) {
		if (wanted.has(entry.id) && isLive(entry) && (entry.storage ?? null) !== name) {
			cards.push(cardBefore(entry));
			storeIn(entry, name, now);
		}
	}

	return finish(doc, cards, touched, name);
}

// Renames a place, and every copy stored there with it. Renamed to another
// saved place's name, the two become one. Returns {changed, name, undo}.
export async function renamePlace(from, to) {
	const name = cleanPlace(to);

	if (!name) {
		throw new Error('A place needs a name.');
	}

	const doc = await loadDocument();
	const now = Date.now();
	const touched = new Map();
	const fold = placeFold(from);
	const mine = savedAs(doc, fold);
	const [other] = placeFold(name) === fold ? [] : savedAs(doc, placeFold(name));
	let final = name;

	if (other) {
		final = other.name;
		mine.forEach((place) => {
			note(touched, place);
			editPlace(doc, place, {deleted_at: nextStamp(place.updated_at, now)}, now);
		});
	}
	else if (mine.length) {
		const [keep, ...extra] = mine;

		note(touched, keep);
		editPlace(doc, keep, {name}, now);
		extra.forEach((place) => {
			note(touched, place);
			editPlace(doc, place, {deleted_at: nextStamp(place.updated_at, now)}, now);
		});
	}
	else {
		final = ensurePlace(doc, name, now, touched);
	}

	const cards = [];

	for (const entry of doc.cards) {
		if (isLive(entry) && entry.storage && placeFold(entry.storage) === fold && entry.storage !== final) {
			cards.push(cardBefore(entry));
			storeIn(entry, final, now);
		}
	}

	return finish(doc, cards, touched, final);
}

// Removes a place: off the list, and every copy stored there shows Not set.
// Returns {changed, undo}.
export async function removePlace(name) {
	const doc = await loadDocument();
	const now = Date.now();
	const touched = new Map();
	const fold = placeFold(name);

	for (const place of savedAs(doc, fold)) {
		note(touched, place);
		editPlace(doc, place, {deleted_at: nextStamp(place.updated_at, now)}, now);
	}

	const cards = [];

	for (const entry of doc.cards) {
		if (isLive(entry) && entry.storage && placeFold(entry.storage) === fold) {
			cards.push(cardBefore(entry));
			storeIn(entry, null, now);
		}
	}

	return finish(doc, cards, touched);
}

// Puts back what setStorage, renamePlace, or removePlace changed: each copy's
// place as it was, and each place as it was (a place the change made is
// removed again). Every step is a new stamped edit, so it syncs like any
// other. Copies removed since are left alone.
export async function undoStorage(undo) {
	const doc = await loadDocument();
	const now = Date.now();
	const byId = new Map(doc.cards.map((entry) => [entry.id, entry]));

	for (const {had, id, storage} of undo.cards || []) {
		const entry = byId.get(id);

		if (!entry || !isLive(entry) || (entry.storage ?? null) === storage) {
			continue;
		}

		editEntry(entry, () => {
			if (had) {
				entry.storage = storage;
			}
			else {
				delete entry.storage;
			}

			entry.updated_at = nextStamp(entry.updated_at, now);
		});
	}

	const list = Array.isArray(doc.storage_places) ? doc.storage_places : [];

	for (const [id, before] of undo.places || []) {
		let place = list.find((item) => item && item.id === id);

		if (!place) {
			continue;
		}

		if (!before || before.deleted_at) {
			if (!place.deleted_at) {
				editPlace(doc, place, {deleted_at: nextStamp(place.updated_at, now)}, now);
			}

			continue;
		}

		if (place.deleted_at) {
			place = restoreEntry(place, now);
			list[list.findIndex((item) => item && item.id === id)] = place;
		}

		if (place.name !== before.name) {
			editPlace(doc, place, {name: before.name}, now);
		}
	}

	await saveDocument(doc);
}

// ------------------------------------------------------------ ownership

// Owned copies for one catalog, by card ID:
// Map card_id -> {total, byLanguage: Map lang -> count}.
export async function ownedIn(catalog) {
	const owned = new Map();

	for (const entry of await listCards()) {
		if (entry.catalog !== catalog) {
			continue;
		}

		if (!owned.has(entry.card_id)) {
			owned.set(entry.card_id, {byLanguage: new Map(), entries: [], total: 0});
		}

		const item = owned.get(entry.card_id);

		item.total++;
		item.entries.push(entry);
		item.byLanguage.set(entry.language, (item.byLanguage.get(entry.language) || 0) + 1);
	}

	return owned;
}

// Distinct cards owned in any language, by "<catalog>|<set id>". Set tiles
// count a card as owned whatever language the copy is in (DESIGN.md
// section 3).
export async function ownedBySet() {
	const [entries, index] = await Promise.all([listCards(), cardIndex()]);
	const sets = new Map();

	for (const entry of entries) {
		const record = index.get(`${entry.catalog}|${entry.card_id}`);

		if (!record) {
			continue;
		}

		const key = `${entry.catalog}|${record.set_id}`;

		if (!sets.has(key)) {
			sets.set(key, new Set());
		}

		sets.get(key).add(entry.card_id);
	}

	return sets;
}
