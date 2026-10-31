// A small in-memory IndexedDB for Node tests of modules that keep data in
// it (js/collection.js). Only what those modules use: open with an upgrade,
// one object store per name, and transactions whose get, put, and delete
// requests answer in order, each onsuccess running before the next, with
// oncomplete after the last (a callback may add more requests, as
// js/collection.js saveDocument does). Values are copied in and out with
// structuredClone, as a real database stores copies.
//
// realOrder: oncomplete runs in a later task than the last onsuccess, as in
// a real browser, where the commit sits between them; code that awaits a
// save can then see other work land in that gap. onPut(value, key) runs
// after each put is stored.

function request(tx, work) {
	const req = {error: null, onerror: null, onsuccess: null, result: undefined};

	tx.queue.push(() => {
		req.result = work();

		if (req.onsuccess) {
			req.onsuccess({target: req});
		}
	});

	return req;
}

function transaction(db, names, {onPut = null, realOrder = false} = {}) {
	const tx = {error: null, onabort: null, oncomplete: null, onerror: null, queue: []};

	tx.objectStore = (name) => {
		const store = db.stores.get(name);

		if (!store || !names.includes(name)) {
			throw new Error(`No object store ${name} in this transaction.`);
		}

		return {
			delete: (key) => request(tx, () => {
				store.delete(key);
			}),
			get: (key) => request(tx, () => (store.has(key) ? structuredClone(store.get(key)) : undefined)),
			put: (value, key) => request(tx, () => {
				store.set(key, structuredClone(value));

				if (onPut) {
					onPut(value, key);
				}

				return key;
			}),
		};
	};

	// Runs after the caller has attached its handlers.
	setTimeout(() => {
		while (tx.queue.length) {
			tx.queue.shift()();
		}

		if (realOrder) {
			setTimeout(() => tx.oncomplete && tx.oncomplete(), 0);
		}
		else if (tx.oncomplete) {
			tx.oncomplete();
		}
	}, 0);

	return tx;
}

export function fakeIndexedDb(options = {}) {
	const databases = new Map();

	return {
		open(name) {
			const req = {error: null, onerror: null, onsuccess: null, onupgradeneeded: null, result: null};

			setTimeout(() => {
				let db = databases.get(name);
				const created = !db;

				if (created) {
					db = {
						createObjectStore: (store) => db.stores.set(store, new Map()),
						objectStoreNames: {contains: (store) => db.stores.has(store)},
						stores: new Map(),
						transaction: (stores) => transaction(db, Array.isArray(stores) ? stores : [stores], options),
					};
					databases.set(name, db);
				}

				req.result = db;

				if (created && req.onupgradeneeded) {
					req.onupgradeneeded();
				}

				if (req.onsuccess) {
					req.onsuccess();
				}
			}, 0);

			return req;
		},
	};
}
