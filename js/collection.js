// Each person's cards: one JSON document per person, kept in IndexedDB
// (DESIGN.md sections 3 and 4). There are no accounts yet, so the phone holds
// one local person.
//
// Every entry carries id, updated_at, and deleted_at, so a later sync can
// merge entry by entry: the newer updated_at wins, and a deletion stays as a
// tombstone so an offline phone cannot bring a deleted card back.

import {cardIndex} from './catalog.js';

const DB_NAME = 'card-tracker-collection';
const STORE = 'documents';
const LOCAL_PERSON = 'local';

const LISTS = ['cards', 'collections', 'goals', 'binders', 'wishlist', 'openings'];

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
	const doc = {person: LOCAL_PERSON, updated_at: nowIso(), version: 1};

	for (const list of LISTS) {
		doc[list] = [];
	}

	return doc;
}

export async function loadDocument() {
	if (!current) {
		const stored = await idb('readonly', (store) => store.get(LOCAL_PERSON));
		const doc = stored || emptyDocument();

		for (const list of LISTS) {
			doc[list] = Array.isArray(doc[list]) ? doc[list] : [];
		}

		current = doc;
	}

	return current;
}

async function saveDocument(doc) {
	doc.updated_at = nowIso();
	await idb('readwrite', (store) => store.put(doc, LOCAL_PERSON));
	current = doc;
	listeners.forEach((listener) => listener(doc));
}

// listener(doc) runs after every save. Returns the unsubscribe function.
export function onChange(listener) {
	listeners.add(listener);

	return () => listeners.delete(listener);
}

// ------------------------------------------------------------ card entries

// The fields an entry may carry. One physical card, one entry: there is no
// quantity field (DESIGN.md section 3).
const ENTRY_FIELDS = [
	'card_id', 'catalog', 'variant_id', 'finish_raw', 'fallback',
	'language', 'language_source', 'import_key',
	'condition', 'purchase_price', 'purchase_currency', 'opening_id', 'storage',
	'grader', 'grade', 'cert_number', 'graded_price',
	'notes', 'is_favorite', 'photo_path',
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

	Object.assign(entry, pick(patch), {updated_at: nowIso()});
	await saveDocument(doc);

	return entry;
}

// Soft delete: the entry stays as a tombstone.
export async function deleteCard(id) {
	const doc = await loadDocument();
	const entry = doc.cards.find((card) => card.id === id && isLive(card));

	if (entry) {
		const at = nowIso();

		entry.deleted_at = at;
		entry.updated_at = at;
		await saveDocument(doc);
	}

	return entry || null;
}

// Adds or updates imported entries by import_key in one save. An entry
// whose key is already present is updated when its catalog match changed and
// left alone otherwise; a key whose entry was deleted is skipped, so a rerun
// never brings back a card the owner removed.
export async function applyImport(entries) {
	const doc = await loadDocument();
	const byKey = new Map();

	for (const card of doc.cards) {
		if (card.import_key) {
			byKey.set(card.import_key, card);
		}
	}

	const counts = {added: 0, skippedDeleted: 0, unchanged: 0, updated: 0};
	const compared = ['card_id', 'catalog', 'variant_id', 'finish_raw', 'fallback', 'language'];
	const base = Date.now();

	entries.forEach((fields, i) => {
		const existing = byKey.get(fields.import_key);

		if (!existing) {
			// One millisecond apart, so "date added" keeps the export's order.
			const at = new Date(base + i).toISOString();

			doc.cards.push({...pick(fields), created_at: at, deleted_at: null, id: newId(), updated_at: at});
			counts.added++;

			return;
		}

		if (!isLive(existing)) {
			counts.skippedDeleted++;

			return;
		}

		const next = pick(fields);
		const changed = compared.some((key) => (existing[key] ?? null) !== (next[key] ?? null));

		if (!changed) {
			counts.unchanged++;

			return;
		}

		for (const key of compared) {
			if (next[key] === undefined) {
				delete existing[key];
			}
		}

		Object.assign(existing, next, {updated_at: nowIso()});
		counts.updated++;
	});

	await saveDocument(doc);

	return counts;
}

// For a later sync: merges two versions of one list, entry by entry. The
// newer updated_at wins, and a tombstone is kept like any other entry.
export function mergeEntries(local, remote) {
	const merged = new Map(local.map((entry) => [entry.id, entry]));

	for (const entry of remote) {
		const mine = merged.get(entry.id);

		if (!mine || String(entry.updated_at) > String(mine.updated_at)) {
			merged.set(entry.id, entry);
		}
	}

	return [...merged.values()];
}

export async function importKeys() {
	const doc = await loadDocument();

	return new Map(doc.cards.filter((card) => card.import_key).map((card) => [card.import_key, card]));
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
