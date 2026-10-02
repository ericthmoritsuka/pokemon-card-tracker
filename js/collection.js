// Each person's cards: one JSON document per person, kept in IndexedDB
// (DESIGN.md sections 3 and 4). The phone shows one document, stored under
// the key "local". Its user_id is null until someone signs in on this phone;
// from then on it belongs to that account and js/sync.js keeps it merged with
// the account's documents row.
//
// Every entry carries id, updated_at, and deleted_at, so the sync merges
// entry by entry (js/merge.js): the newer updated_at wins, and a deletion
// stays as a tombstone so an offline phone cannot bring a deleted card back.

import {cardIndex} from './catalog.js';
import {LISTS, mergeDocuments, nextStamp, sameContent} from './merge.js';

export {mergeEntries} from './merge.js';

const DB_NAME = 'card-tracker-collection';
const STORE = 'documents';
const LOCAL_PERSON = 'local';

let dbPromise = null;
let current = null;

const listeners = new Set();

function openDb() {
	if (!dbPromise) {
		dbPromise = new Promise((resolve, reject) => {
			if (!('indexedDB' in window)) {
				reject(new Error('IndexedDB is not available.'));

				return;
			}

			const request = indexedDB.open(DB_NAME, 1);

			request.onupgradeneeded = () => request.result.createObjectStore(STORE);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		}).catch((err) => {
			dbPromise = null;

			throw err;
		});
	}

	return dbPromise;
}

async function idb(mode, op) {
	const db = await openDb();

	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, mode);
		const request = op(tx.objectStore(STORE));

		tx.oncomplete = () => resolve(request.result);
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

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

export async function loadDocument() {
	if (!current) {
		const stored = await idb('readonly', (store) => store.get(LOCAL_PERSON));

		current = normalize(stored || emptyDocument());
	}

	return current;
}

// source is 'local' for the person's own edits, 'sync' for entries merged in
// from the server, and 'account' when the document changes hands. Only
// 'local' saves are pushed.
async function saveDocument(doc, source = 'local') {
	doc.updated_at = nowIso();
	await idb('readwrite', (store) => store.put(doc, LOCAL_PERSON));
	current = doc;
	listeners.forEach((listener) => listener(doc, {source}));
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
	await saveDocument(doc, 'account');

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
	const entry = {...pick(fields), created_at: at, deleted_at: null, id: newId(), updated_at: at};

	doc.cards.push(entry);
	await saveDocument(doc);

	return entry;
}

export async function updateCard(id, patch) {
	const doc = await loadDocument();
	const entry = doc.cards.find((card) => card.id === id && isLive(card));

	if (!entry) {
		throw new Error(`No card entry ${id}.`);
	}

	Object.assign(entry, pick(patch), {updated_at: nextStamp(entry.updated_at)});
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
			Object.assign(entry, pick(patch), {updated_at: nextStamp(entry.updated_at, now)});
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

		entry.deleted_at = at;
		entry.updated_at = at;
		await saveDocument(doc);
	}

	return entry || null;
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

export async function importKeys() {
	const doc = await loadDocument();

	return entriesByKey(doc.cards);
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
