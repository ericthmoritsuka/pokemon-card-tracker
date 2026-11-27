// Withdraws a live listing the moment its copy stops being free to sell
// (QA shop 4, v128): sold in Trades, deleted, put in a binder pocket,
// starred, or set Not for sale, on any screen. Before, such a copy stayed on
// HOTARU until the Shop was next opened online. It reuses the star's path,
// store_withdraw (supabase/store-withdraw.sql, js/store-publish.js
// withdrawListings), which takes available singles down and leaves a
// reserved or sold one alone. Owner only; offline, the ids wait in this
// browser's storage and go when it is back online.
//
// Started once by app.js. Free is js/held-free.js copyState's, the same
// set the Shop lists from, so only a priced copy that was free and no
// longer is gets a call.

import {loadDocument, onChange} from './collection.js';
import {copyState} from './held-free.js';
import {salePrice} from './shop.js';
import {loadOnePrintings} from './wishlist.js';

const QUEUE_KEY = 'cardTracker.withdrawQueue';

// The priced copies free to sell in doc.
export function sellableIds(doc) {
	const priced = new Set(((doc && doc.cards) || []).filter((entry) => entry && salePrice(entry) !== null).map((entry) => entry.id));

	return new Set([...copyState(doc).free].filter((id) => priced.has(id)));
}

// The ids that were free to sell before and are not now.
export function leftSale(before, after) {
	return [...before].filter((id) => !after.has(id));
}

function readQueue() {
	try {
		const list = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');

		return Array.isArray(list) ? list.filter((id) => typeof id === 'string') : [];
	}
	catch {
		return [];
	}
}

function keepQueue(ids) {
	try {
		if (ids.length) {
			localStorage.setItem(QUEUE_KEY, JSON.stringify([...new Set(ids)].slice(-2000)));
		}
		else {
			localStorage.removeItem(QUEUE_KEY);
		}
	}
	catch {
		// Not kept: the Shop's next automatic publish withdraws them.
	}
}

let started = false;

export function startListingGuard({withdraw = null, owner = null} = {}) {
	if (started) {
		return;
	}

	started = true;

	let known = null;
	let timer = null;

	const send = async () => {
		const ids = readQueue();

		if (!ids.length || !navigator.onLine || !(await import('./auth.js')).currentUser()) {
			return;
		}

		try {
			const isOwner = owner ? await owner() : await (await import('./shop-owner.js')).checkShopOwner();

			if (isOwner !== true) {
				keepQueue([]);

				return;
			}

			const call = withdraw || (await import('./store-publish.js')).withdrawListings;

			await call(ids);
			keepQueue(readQueue().filter((id) => !ids.includes(id)));
		}
		catch {
			// Kept for the next change or the next time online.
		}
	};

	const check = async () => {
		// Finish keys depend on the card index (js/wishlist.js
		// copyFinishKey), so without it a free copy could look taken: no
		// call is made then, and the next change starts afresh.
		const [doc, read] = await Promise.all([loadDocument().catch(() => null), loadOnePrintings()]);

		if (!doc || !read) {
			known = null;

			return;
		}

		const now = sellableIds(doc);
		const gone = known ? leftSale(known, now) : [];

		known = now;

		if (gone.length) {
			keepQueue([...readQueue(), ...gone]);
		}

		await send();
	};

	onChange((doc, {source} = {}) => {
		if (source === 'account') {
			known = null;
		}

		clearTimeout(timer);
		timer = setTimeout(() => check().catch(() => {}), 300);
	});
	window.addEventListener('online', () => send());
	check().catch(() => {});
}
