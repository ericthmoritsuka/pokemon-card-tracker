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
import {isLive, listCards, onChange} from './collection.js';
import {BASE, h} from './dom.js';
import {whenMemberName} from './family.js';
import {memberDocument} from './sync.js';
import {sparesFor} from './wishlist.js';

const CHOICE_KEY = 'cardTracker.tradeChoice';
// The filters that mean something over spares.
const OFFERED = ['set', 'language', 'rarity', 'price', 'favorite'];

const entryCatalog = (entry) => entry.catalog || 'international';

// Which copy a person keeps: a favorite first, then the one added first.
const keeperOrder = (a, b) => Number(b.is_favorite === true) - Number(a.is_favorite === true)
	|| String(a.created_at).localeCompare(String(b.created_at))
	|| String(a.id).localeCompare(String(b.id));

// The live copies that are spares. How many each card and language holds is
// js/wishlist.js sparesFor, the same count a family wishlist shows; this only
// picks which copies they are (the keeper is left out).
export function spareEntries(cards) {
	const groups = new Map();

	for (const entry of (cards || []).filter((one) => one && isLive(one))) {
		const key = `${entryCatalog(entry)}|${entry.card_id}|${entry.language}`;

		groups.set(key, [...(groups.get(key) || []), entry]);
	}

	const spares = [];

	for (const group of groups.values()) {
		const [first] = group;
		const count = sparesFor({card_id: first.card_id, catalog: entryCatalog(first), language: first.language}, group);

		spares.push(...group.sort(keeperOrder).slice(group.length - count));
	}

	return spares;
}

// "2 spares · Near Mint": the count and the conditions the spares are in.
function metaFor(group) {
	const conditions = [...new Set(group.entries.map((entry) => entry.condition).filter(Boolean))];
	const n = group.entries.length;

	return [`${n} ${n === 1 ? 'spare' : 'spares'}`, ...conditions].join(' · ');
}

const emptyNode = (mine) => () => h('div', {class: 'card empty-state', id: 'trade-empty'},
	h('div', {'aria-hidden': 'true', class: 'empty-art'}),
	h('p', {class: 'big'}, mine ? 'No spares yet' : 'No spares'),
	h('p', {class: 'muted'}, 'A spare is a copy beyond the first of the same card in the same language. A Portuguese and an English copy of a card are both kept; a second Portuguese copy is a spare, whatever its finish.'),
	h('p', {class: 'muted'}, mine ? 'Cards you own twice show up here, ready to trade.' : 'Cards they own twice show up here.'),
	h('a', {class: 'button', 'data-link': 'cards', href: `${BASE}cards`}, 'Back to My Cards')
);

export function tradeView(root) {
	return cardsScreen(root, {
		emptyNode: emptyNode(true),
		emptyText: () => 'No spares yet.',
		label: 'your spares',
		load: async () => spareEntries(await listCards()),
		metaFor,
		offered: OFFERED,
		placeholder: 'Search my spares',
		storageKey: CHOICE_KEY,
		title: 'Trade',
		watch: (reload) => onChange((doc, info) => reload(doc && Array.isArray(doc.cards) ? {...doc, cards: spareEntries(doc.cards)} : doc, info)),
	});
}

// A family member's spares, read only: their document is read from the
// server each time, like their My Cards.
export function familyTradeView(root, {userId}) {
	let name = 'Family member';

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

			const doc = await memberDocument(userId);

			return spareEntries((doc && doc.cards) || []);
		},
		metaFor,
		offered: OFFERED,
		placeholder: 'Search their spares',
		readOnly: true,
		storageKey: `${CHOICE_KEY}.family`,
		title: 'Family member\'s spares',
	});
}

export const tradeRoutes = [
	{pattern: /^trade$/, render: tradeView, tab: 'cards', title: 'Trade | Card Tracker'},
	{keys: ['userId'], pattern: /^family\/([^/]+)\/trade$/, render: familyTradeView, tab: 'cards', title: 'Family spares | Card Tracker'},
];

export const tradeAccountViews = [tradeView, familyTradeView];
