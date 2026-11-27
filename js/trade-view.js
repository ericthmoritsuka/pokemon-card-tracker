// The Trade view: the spare copies, one tile per card and language
// (DESIGN.md section 3, the Trade rule). A spare is every copy beyond the
// first of the same card in the same language, so a PT and an EN copy are
// both keepers and a second PT copy is a spare whatever its finish. Trade is
// a query over the copies, never a stored list, so it stays right after a
// card is traded away. The screen is My Cards' own (js/cards-view.js
// cardsScreen) over the spares only: the shared filter bar, the Value sheet
// with its coverage line, and the card tiles with their ×N badge, which here
// counts spares.
//
// Routes (the integrator adds tradeRoutes to app.js ROUTES and
// tradeAccountViews to ACCOUNT_ROUTES, css/trade.css to index.html and sw.js):
//   trade                  your spares
//   family/<id>/trade      a family member's spares, read only

import {currentUser} from './auth.js';
import {cardsScreen} from './cards-view.js';
import {loadDocument, onChange} from './collection.js';
import {BASE, h} from './dom.js';
import {freeEntries} from './held-free.js';
import {whenMemberName} from './family.js';
import {memberDocument} from './sync.js';
import {printingsReady, spareEntries} from './wishlist.js';

const CHOICE_KEY = 'cardTracker.tradeChoice';
// The filters that mean something over spares.
// No Favorite: a favorite card is never a spare (js/wishlist.js).
const OFFERED = ['set', 'language', 'rarity', 'price', 'storage'];

// The spares rule lives in js/wishlist.js beside sparesFor, so the scanner's
// Trade or sale mode can reach it from Node tests too.
export {spareEntries};

// "2 spares · Near Mint": the count and the conditions the spares are in.
function metaFor(group) {
	const conditions = [...new Set(group.entries.map((entry) => entry.condition).filter(Boolean))];
	const n = group.entries.length;

	return [`${n} ${n === 1 ? 'spare' : 'spares'}`, ...conditions].join(' · ');
}

const emptyNode = (mine) => () => h('div', {class: 'card empty-state', id: 'trade-empty'},
	h('div', {'aria-hidden': 'true', class: 'empty-art'}),
	h('p', {class: 'big'}, mine ? 'No spares yet' : 'No spares'),
	h('p', {class: 'muted'}, 'A spare is a copy beyond the first of the same card in the same language and finish. A Portuguese and an English copy of a card are both kept, and so are a normal and a reverse holo; a second Portuguese normal is a spare. A copy in a binder is never a spare, and no copy of a favorite card is.'),
	h('p', {class: 'muted'}, mine ? 'Cards you own twice show up here, ready to trade.' : 'Cards they own twice show up here.'),
	h('a', {class: 'button', 'data-link': 'cards', href: `${BASE}cards`}, 'Back to My Cards')
);

// A document's spares: the copies free to trade or sell, as Check spares,
// the tile's badge, the binders, and the Shop count them (js/held-free.js
// copyState): not in a pocket, not the copy kept, not taken off sale, or
// marked For sale.
const docSpares = (doc) => freeEntries(doc);

export function tradeView(root) {
	return cardsScreen(root, {
		checkRoute: 'trade/check',
		freeWhenFewer: true,
		emptyNode: emptyNode(true),
		emptyText: () => 'No spares yet.',
		label: 'your spares',
		// After the card index, as every screen that counts spares waits.
		load: async () => docSpares((await Promise.all([loadDocument(), printingsReady()]))[0]),
		metaFor,
		offered: OFFERED,
		placeholder: 'Search my spares',
		storageKey: CHOICE_KEY,
		title: 'Spares',
		watch: (reload) => onChange((doc, info) => reload(doc && Array.isArray(doc.cards) ? {...doc, cards: docSpares(doc)} : doc, info)),
	});
}

// A family member's spares, read only: their document is read from the
// server each time, like their My Cards.
export function familyTradeView(root, {userId}) {
	let name = 'Family member';
	// Their card records: the tiles show their photos and pin, not yours.
	let records = [];

	whenMemberName(userId, (label) => {
		name = label;
		document.title = `${name}'s spares | Card Tracker`;

		const heading = root.querySelector('.view-head h2');

		if (heading) {
			heading.textContent = `${name}'s spares`;
		}
	});

	return cardsScreen(root, {
		emptyNode: emptyNode(false),
		emptyText: () => `${name} has no spares.`,
		label: 'these spares',
		load: async () => {
			if (!currentUser()) {
				throw new Error('Sign in to see your family\'s cards.');
			}

			if (!navigator.onLine) {
				throw new Error('A family member\'s cards show when you are online.');
			}

			const [doc] = await Promise.all([memberDocument(userId), printingsReady()]);

			records = (doc && doc.card_info) || [];

			return docSpares(doc);
		},
		loadRecords: () => records,
		metaFor,
		offered: OFFERED,
		placeholder: 'Search their spares',
		readOnly: true,
		storageKey: `${CHOICE_KEY}.family`,
		title: 'Family member\'s spares',
	});
}

export const tradeRoutes = [
	{pattern: /^trade$/, render: tradeView, tab: 'cards', title: 'Spares | Card Tracker'},
	{keys: ['userId'], pattern: /^family\/([^/]+)\/trade$/, render: familyTradeView, tab: 'cards', title: 'Family spares | Card Tracker'},
];

export const tradeAccountViews = [tradeView, familyTradeView];
