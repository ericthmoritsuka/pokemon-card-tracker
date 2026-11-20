// Holds the phone's reads of saved card records (js/catalog.js readSaved),
// so a test can act while My Cards is still reading them: the window
// between the bar showing and the first tiles, or between the first paint
// and the rest of the records.
//
// holdRecords(context) adds an init script. Each IndexedDB transaction on
// the catalog store notes the keys it asks for; when it completes, its
// complete handler waits while window.__holdRecords says to hold it:
//   true            any transaction that asks for a card record (card:...)
//                   or lists them (the key range from card:)
//   [key, ...]      a transaction that asks for one of these keys
// Set window.__holdRecords before the page loads with holdWith(), or in
// the page at any time; releaseRecords(page) lets every held one finish.
// The requests themselves run as usual, so what a transaction reads is
// what IndexedDB holds; only the caller learns of it later.

export async function holdRecords(context, hold = false) {
	await context.addInitScript((initial) => {
		let release;
		const held = new Promise((done) => {
			release = done;
		});

		window.__holdRecords = initial;
		window.__releaseRecords = () => {
			window.__holdRecords = false;
			release();
		};

		const asked = new WeakMap();
		const note = (store, key) => {
			if (store.transaction.db.name !== 'card-tracker-catalog') {
				return;
			}

			if (!asked.has(store.transaction)) {
				asked.set(store.transaction, []);
			}

			asked.get(store.transaction).push(key);
		};
		const get = IDBObjectStore.prototype.get;
		const getAllKeys = IDBObjectStore.prototype.getAllKeys;

		IDBObjectStore.prototype.get = function (key, ...rest) {
			note(this, key);

			return get.call(this, key, ...rest);
		};
		IDBObjectStore.prototype.getAllKeys = function (range, ...rest) {
			note(this, range && typeof range.lower === 'string' ? range.lower : range);

			return getAllKeys.call(this, range, ...rest);
		};

		const holds = (keys) => {
			const hold = window.__holdRecords;

			if (hold === true) {
				return keys.some((key) => typeof key === 'string' && key.startsWith('card:'));
			}

			return Array.isArray(hold) && keys.some((key) => hold.includes(key));
		};
		const complete = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');

		Object.defineProperty(IDBTransaction.prototype, 'oncomplete', {
			configurable: true,
			enumerable: complete.enumerable,
			get() {
				return complete.get.call(this);
			},
			set(handler) {
				if (typeof handler !== 'function') {
					complete.set.call(this, handler);

					return;
				}

				// Decided when it completes, once every request is asked.
				complete.set.call(this, function (event) {
					if (holds(asked.get(this) || [])) {
						held.then(() => handler.call(this, event));
					}
					else {
						handler.call(this, event);
					}
				});
			},
		});
	}, hold);
}

export const releaseRecords = (page) => page.evaluate(() => window.__releaseRecords());
