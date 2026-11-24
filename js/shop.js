// The Shop: Eric's private staging page for selling his spares on HOTARU
// (plans/hotaru-catalog-plan.md, section 5). Each card has one sale price,
// typed by hand; only a priced card is published, and the suggestions
// beside it never leave this screen. Worked out without the page, so node
// can test it; js/shop-view.js draws it.
//
// A shop group is one card in one language that has spares, like a Spares
// tile: {key, catalog, card_id, language, spares, copies, price}. spares are
// the copies spareEntries picks; copies are every live copy of the card in
// that language, keeper included. The sale price is saved on every copy, so
// a change of keeper (a new favorite) never leaves a spare unpriced, and
// only the spares are ever published.

import {tileKey} from './bulk-edit.js';
import {setIdOfCard} from './catalog.js';
import {isLive} from './collection.js';
import {isCustom, sameNumber} from './custom-card.js';
import {extractPrices, fallbackPrice, finishOf, isAsianPrint, usdToBrl, eurToBrl} from './prices.js';
import {spareEntries} from './wishlist.js';

// A suggestion is rounded up to the next R$ 0,50 (Eric, 2026-11-24).
export const SALE_STEP = 0.5;

// The sale price on a copy: a positive amount to the cent, or null.
export function salePrice(entry) {
	const value = entry && entry.sale_price;

	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : null;
}

// Up to the next step, never below one step: R$ 2,10 is R$ 2,50, R$ 2,50
// stays, R$ 0,20 is R$ 0,50. Null for no amount.
export function roundUpToStep(brl, step = SALE_STEP) {
	if (typeof brl !== 'number' || !Number.isFinite(brl) || brl <= 0) {
		return null;
	}

	// The small allowance keeps R$ 2,50 computed as 2.5000000001 at R$ 2,50.
	return Math.max(step, Math.ceil(brl / step - 1e-9) * step);
}

// The groups that have spares, in no particular order. cards are the
// person's copies, live or not; held, the copies in their binders
// (js/wishlist.js spareEntries), which are never for sale.
//
// A hand-made copy of a card the catalog lists too counts as a copy of that
// catalog card (catalogTwins), so a CRI card added by hand before TCGdex
// listed the set and a copy scanned later are one card with one spare, not
// two cards with none. codeOf(setId) is the set's printed code
// (js/catalog.js printedCode).
export function shopGroups(cards, {codeOf = () => null, held} = {}) {
	const live = (cards || []).filter((entry) => entry && isLive(entry));
	const twins = catalogTwins(live, {codeOf});
	const byId = new Map(live.map((entry) => [entry.id, entry]));
	// A copy saved with no catalog is an international one, as spareEntries
	// counts it, so it never splits from its card into a second row.
	const asCard = (entry) => (twins.has(entry.id) ? {...entry, ...twins.get(entry.id)} : {...entry, catalog: entry.catalog || 'international'});
	const counted = live.map(asCard);
	const groups = new Map();

	for (const spare of spareEntries(counted, {held})) {
		const entry = byId.get(spare.id) || spare;
		const key = tileKey(spare);

		if (!groups.has(key)) {
			groups.set(key, {
				card_id: spare.card_id,
				catalog: spare.catalog || 'international',
				copies: [],
				key,
				language: spare.language,
				price: null,
				set_id: setIdOfCard(spare.card_id),
				spares: [],
			});
		}

		groups.get(key).spares.push(entry);
	}

	for (const entry of live) {
		const group = groups.get(tileKey(asCard(entry)));

		if (group) {
			group.copies.push(entry);
		}
	}

	for (const group of groups.values()) {
		group.price = groupPrice(group);
	}

	return [...groups.values()];
}

// A hand-made copy's number, and the same number without a set code in
// front ("MEP 012" is 012), for matching it to a catalog card.
function handNumbers(number) {
	const text = String(number ?? '').trim();
	const bare = text.replace(/^[A-Za-z]+[\s-]+(?=\d)/, '');

	return bare && bare !== text ? [text, bare] : [text];
}

// {<hand-made copy id>: {catalog, card_id}}: each live hand-made copy whose
// set (its set code as TCGdex's set id or the printed code, or its set name)
// and number match a catalog copy owned in the same language. Only copies
// owned are matched, so this needs no catalog read; a hand-made card no
// catalog copy matches stays itself. The card page's Link (js/custom-card.js
// linkPatches) still makes the move for good.
export function catalogTwins(live, {codeOf = () => null} = {}) {
	const out = new Map();
	const catalogCopies = live.filter((entry) => !isCustom(entry) && entry.card_id);
	const fold = (value) => String(value ?? '').trim().toLowerCase();

	for (const hand of live.filter((entry) => isCustom(entry) && entry.number_local)) {
		const code = fold(hand.set_code);
		const setName = fold(hand.set_name_local);
		const numbers = handNumbers(hand.number_local);
		const twin = catalogCopies.find((entry) => {
			const setId = setIdOfCard(entry.card_id);

			if (!setId || entry.language !== hand.language) {
				return false;
			}

			const setFits = (code && (code === fold(setId) || code === fold(codeOf(setId))))
				|| (setName && setName === fold(entry.set_name_local));
			const localId = entry.card_id.slice(setId.length + 1);

			return setFits && numbers.some((number) => sameNumber(number, localId));
		});

		if (twin) {
			out.set(hand.id, {card_id: twin.card_id, catalog: twin.catalog || 'international'});
		}
	}

	return out;
}

// The group's sale price: a spare's first, else any copy's, since the
// price is saved on all of them and a copy added later has none yet.
export function groupPrice(group) {
	for (const entry of [...group.spares, ...group.copies]) {
		const price = salePrice(entry);

		if (price !== null) {
			return price;
		}
	}

	return null;
}

// [{id, patch}] giving every copy of the groups the price, or clearing it
// with null. Copies that already hold it are left alone, so they are not
// stamped as edited.
export function pricePatches(groups, price) {
	const value = price === null ? null : Math.round(price * 100) / 100;
	const patches = [];

	for (const group of groups) {
		for (const entry of group.copies) {
			if ((salePrice(entry) ?? null) !== value) {
				patches.push({id: entry.id, patch: {sale_price: value}});
			}
		}
	}

	return patches;
}

// Undo's patches for pricePatches: each copy back to the price it has now.
export function undoPricePatches(groups, patches) {
	const byId = new Map(groups.flatMap((group) => group.copies).map((entry) => [entry.id, entry]));

	return patches.map(({id}) => ({id, patch: {sale_price: salePrice(byId.get(id))}}));
}

// One market's price for a copy, from the card's full record: its own
// finish's, else another finish's (prices.js fallbackPrice). market is
// 'tcgplayer' (US$, market price) or 'cardmarket' (€, trend).
function marketAmount(entry, record, market) {
	const field = market === 'tcgplayer' ? 'marketPrice' : 'trend';
	const finishes = extractPrices(record);
	const own = finishOf(entry, finishes);
	const prices = own && own[market] && own[market][field] !== null ? own[market] : (fallbackPrice(record, market, finishes) || {}).prices;
	const value = prices ? prices[field] : null;

	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

// What the Shop suggests for a group, private to Eric's screen:
// {tcgplayer, cardmarket, use}, each in reais or null. tcgplayer is
// TCGplayer's market price and cardmarket Cardmarket's trend, converted
// with the saved rates ({brlPerUsd}, {brlPerEur}); use is the higher of the
// two rounded up to the next R$ 0,50, what the Use button types. A Japanese,
// Korean, or Chinese print gets none: TCGdex's prices are not known to be
// for it (DESIGN.md section 10, "The language gap"). record is the card's
// full TCGdex record, or null when it is not on the phone yet.
export function suggestion(group, record, {euroRates = null, rates = null} = {}) {
	const none = {cardmarket: null, tcgplayer: null, use: null};
	const entry = group && group.spares[0];

	if (!entry || !record || isAsianPrint(entry)) {
		return none;
	}

	const usd = marketAmount(entry, record, 'tcgplayer');
	const eur = marketAmount(entry, record, 'cardmarket');
	const tcgplayer = usd === null ? null : usdToBrl(usd, rates);
	const cardmarket = eur === null ? null : eurToBrl(eur, euroRates);
	const known = [tcgplayer, cardmarket].filter((value) => typeof value === 'number');

	return {cardmarket, tcgplayer, use: known.length ? roundUpToStep(Math.max(...known)) : null};
}

// The Shop's own filters, beside its search: 'all', 'unpriced', or
// 'priced'.
export const PRICE_FILTERS = ['all', 'unpriced', 'priced'];

export function priceFilter(groups, show) {
	if (show === 'unpriced') {
		return groups.filter((group) => group.price === null);
	}

	if (show === 'priced') {
		return groups.filter((group) => group.price !== null);
	}

	return groups;
}

// {groups, priced, spares, value}: how many cards and spare copies the Shop
// holds, how many cards are priced, and what the priced spares would bring.
export function shopTotals(groups) {
	let priced = 0;
	let spares = 0;
	let value = 0;

	for (const group of groups) {
		spares += group.spares.length;

		if (group.price !== null) {
			priced++;
			value += group.price * group.spares.length;
		}
	}

	return {groups: groups.length, priced, spares, value: Math.round(value * 100) / 100};
}

// ------------------------------------------------------------- publishing

// Where a card's picture is kept in the shop's public bucket
// (supabase/store.sql, private.is_store_path): the TCGdex picture's own
// path, tcgdex/<language>/<series>/<set>/<number>.webp. base is the picture
// address js/catalog.js pictureOf gives, without a size. Null for anything
// else, a hand-made card's say.
export function storePicturePath(base) {
	let url;

	try {
		url = new URL(base);
	}
	catch {
		return null;
	}

	const path = url.pathname.replace(/^\/+|\/+$/g, '');

	return url.origin === 'https://assets.tcgdex.net' && /^[a-z]{2}(-[a-z]{2})?\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(path)
		? `tcgdex/${path}.webp`
		: null;
}

// Where one of the owner's own card photos is kept in the shop's bucket
// when it is a listing's picture (a card the catalog has no picture for, or
// a hand-made one): own/<photo id>.webp or .jpg, as the photo was saved.
// supabase/store-own-pictures.sql lets the owner add these. Null for a photo
// with no usable id.
export function ownPicturePath(photo) {
	const id = photo && typeof photo.id === 'string' ? photo.id : '';

	if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
		return null;
	}

	return `own/${id}.${/\.jpe?g$/i.test(String(photo.path || '')) ? 'jpg' : 'webp'}`;
}

const text = (value, max) => {
	const clean = value === null || value === undefined ? '' : String(value).trim();

	return clean ? clean.slice(0, max) : null;
};

// The rows store_sync takes: one per spare copy of every priced card, and
// nothing for a card without a price, so publishing them withdraws the rest.
// Each group carries what js/shop-view.js worked out for it: info ({name,
// number, setName}), rarity, and picturePath, the bucket path once the
// picture is there (omitted until then, so the stored one is kept).
// finishOf(entry, group) names a copy's finish, or null.
export function listingRows(groups, {finishOf = () => null} = {}) {
	const rows = [];

	for (const group of groups) {
		if (group.price === null) {
			continue;
		}

		const info = group.info || {};

		for (const entry of group.spares) {
			const row = {
				card_id: group.card_id,
				catalog: group.catalog,
				condition: text(entry.condition, 40),
				finish: text(finishOf(entry, group), 80),
				id: entry.id,
				language: group.language || null,
				name: text(info.name, 160) || group.card_id,
				number: text(info.number, 32),
				price_brl: group.price,
				rarity: text(group.rarity, 80),
				set_name: text(info.setName, 160),
			};

			if (group.picturePath) {
				row.image_path = group.picturePath;
			}

			rows.push(row);
		}
	}

	return rows;
}

// What a priced card shows about its listings, from store_sync's answer
// ({<id>: {status}}): 'reserved' when any spare is held by an order,
// 'published' when every spare is for sale, 'pending' when some are not
// published yet, and null for a card without a price.
export function groupMark(group, states) {
	if (group.price === null) {
		return null;
	}

	const statuses = group.spares.map((entry) => (states && states[entry.id] ? states[entry.id].status : null));

	if (statuses.includes('reserved')) {
		return 'reserved';
	}

	return statuses.every((status) => status === 'available') ? 'published' : 'pending';
}

// ----------------------------------------------------------------- orders

// How long a pending order still holds its cards: "47 h left", "35 min
// left", or "Expired" (supabase/store-orders.sql lets it go on the next
// call).
export function timeLeft(reservedUntil, now = Date.now()) {
	const ms = Date.parse(reservedUntil) - now;

	if (!Number.isFinite(ms) || ms <= 0) {
		return 'Expired';
	}

	const minutes = Math.ceil(ms / 60000);

	return minutes >= 60 ? `${Math.floor(minutes / 60)} h left` : `${minutes} min left`;
}

// What an order means for the collection on this phone: missing, its
// copies that are no longer live here (traded or removed meanwhile), and
// logged, whether its sale is in the moves already. A sale is logged under
// the order's own ID, so it is never logged twice (js/moves.js planMove).
//
// Only cards are copies in the collection: a sealed product (step 4) is sold
// from HOTARU's own stock, so it is never missing here and is not part of
// the sale logged in Trades. An order of sealed products alone has nothing
// to log, and counts as logged.
const isCard = (item) => (item.kind || 'single') === 'single';

export function orderCheck(order, doc) {
	const live = new Set(((doc && doc.cards) || []).filter((entry) => entry && isLive(entry)).map((entry) => entry.id));
	const moves = (doc && Array.isArray(doc.moves) ? doc.moves : []);
	const cards = (order.items || []).filter(isCard);

	return {
		logged: !cards.length || moves.some((move) => move && move.id === order.id && !move.deleted_at),
		missing: cards.map((item) => item.listing_id).filter((id) => !live.has(id)),
	};
}

// Whether an order holds a card, so paying it logs a sale in Trades.
export const hasCards = (order) => (order.items || []).some(isCard);

// The sale a paid order logs (js/moves.js applyMove, with the order's ID).
export function saleFields(order, {now = new Date()} = {}) {
	const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');

	const cards = (order.items || []).filter(isCard);
	const sealed = (order.items || []).filter((item) => !isCard(item));
	// The sealed products of a mixed order are named in the note, and their
	// price is left out of the cards' sale.
	const others = [...sealed.reduce((counts, item) => counts.set(item.name, (counts.get(item.name) || 0) + 1), new Map())]
		.map(([name, n]) => (n > 1 ? `${n}× ${name}` : name));
	const price = Math.round(cards.reduce((sum, item) => sum + Number(item.price_brl || 0), 0) * 100) / 100;

	return {
		currency: 'BRL',
		date,
		kind: 'sold',
		note: others.length ? `HOTARU ${order.code}, with ${others.join(', ')}` : `HOTARU ${order.code}`,
		out: cards.map((item) => item.listing_id),
		price: sealed.length ? price : Number(order.total),
		who: order.name,
	};
}
