// The phone's IndexedDB databases, opened one way (plans/audit-engineering.md
// E-30). Each module keeps its own database name, store names, and version 1,
// so a phone that already holds data opens the same databases as before.
//
//   openDatabase(name, upgrade)  one raw open, for a caller that closes it
//   database(name, stores)       an open kept for the page, with run()
//   timedCache(db, store)        get and put of {at, data} records

// Opens a database once. `upgrade(db)` runs when the database is new.
// `onBlocked()` returns the error to reject with when another tab holds an
// older version open; without it the open waits, as the browser does.
export function openDatabase(name, upgrade, {onBlocked = null, version = 1} = {}) {
	return new Promise((resolve, reject) => {
		if (typeof indexedDB === 'undefined') {
			reject(new Error('IndexedDB is not available.'));

			return;
		}

		const request = indexedDB.open(name, version);

		request.onupgradeneeded = () => upgrade(request.result);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);

		if (onBlocked) {
			request.onblocked = () => reject(onBlocked());
		}
	});
}

// A database with these object stores (out-of-line keys), opened on first
// use and kept open. A failed open is forgotten, so the next call tries
// again. run(store, mode, op) answers op's request result once the
// transaction completes.
export function database(name, stores) {
	let dbPromise = null;

	const open = () => {
		if (!dbPromise) {
			dbPromise = openDatabase(name, (db) => {
				for (const store of stores) {
					if (!db.objectStoreNames.contains(store)) {
						db.createObjectStore(store);
					}
				}
			}).catch((err) => {
				dbPromise = null;

				throw err;
			});
		}

		return dbPromise;
	};

	const run = async (store, mode, op) => {
		const db = await open();

		return new Promise((resolve, reject) => {
			const tx = db.transaction(store, mode);
			const request = op(tx.objectStore(store));

			tx.oncomplete = () => resolve(request && request.result);
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error);
		});
	};

	return {open, run};
}

// A cache of fetched data in one store, each value kept as {at, data} with
// the time it was saved. Neither call throws: a miss reads as undefined, and
// a failed save means the next visit asks again.
export function timedCache(db, store) {
	return {
		async get(key) {
			try {
				return await db.run(store, 'readonly', (s) => s.get(key));
			}
			catch {
				return undefined;
			}
		},
		async put(key, data) {
			try {
				await db.run(store, 'readwrite', (s) => s.put({at: Date.now(), data}, key));
			}
			catch {
				// Not kept; the next visit asks again.
			}
		},
	};
}
