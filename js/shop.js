// The Shop: Eric's private staging page for selling his spares on HOTARU
// (plans/hotaru-catalog-plan.md, section 5). Each finish of a card has its
// own sale price, typed by hand (Eric, 2026-11-24: a reverse holo or a holo
// sells for more than the plain card); only a priced finish is published,
// and the suggestions beside it never leave this screen. Worked out without
// the page, so node can test it; js/shop-view.js draws it.
//
// A shop group is one finish of one card in one language that has spares or
// a copy marked For sale: {key, catalog, card_id, language, finish_key,
// spares, marked, listed, copies, price}. spares are the copies of that
// finish spareEntries picks; marked, the other copies marked For sale;
// listed, the ones offered on HOTARU; copies, every live copy of the card in
// that language and finish, keeper included. The sale price is saved on
// every copy of the finish, so a change of keeper (a new favorite) never
// leaves a spare unpriced, and only the listed copies are ever published.
//
// For sale (plans/hotaru-for-sale-plan.md, Eric, 2026-11-24: the mark is the
// listing). A copy's for_sale is true when Eric put it up for sale, false
// when he took it off, and absent for today's rule:
//
//   listed = (spares whose for_sale is not false) + (copies marked true)
//
// So a priced spare is offered as before, a copy marked true is offered even
// when it is the last one, in a binder, or a favorite, and a spare marked
// false stays his.

import {tileKey} from './bulk-edit.js';
import {setIdOfCard} from './catalog.js';
import {isLive} from './collection.js';
import {isCustom, sameNumber} from './custom-card.js';
import {extractPrices, fallbackPrice, finishOf, isAsianPrint, usdToBrl, eurToBrl} from './prices.js';
import {copyFinishKey, spareEntries} from './wishlist.js';

// A suggestion is rounded up to the next R$ 0,50 (Eric, 2026-11-24).
export const SALE_STEP = 0.5;

// The sale price on a copy: a positive amount to the cent, or null. Above
// SALE_MAX (HOTARU's numeric(10, 2) column holds less) it is null, so one
// bad price saved by an older version never blocks the others' publish
// (QA shop 6).
export const SALE_MAX = 99999.99;

export function salePrice(entry) {
	const value = entry && entry.sale_price;

	return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= SALE_MAX ? Math.round(value * 100) / 100 : null;
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

// A copy's finish as it is stored (js/wishlist.js copyFinishKey): its
// variant ID, else the monprice word, else '' when it was never set. The
// spare rule keeps one copy per finish with the same key, so a Shop row and
// the copy kept always agree.
export const finishKey = copyFinishKey;

// The Shop group a copy belongs to: its card and language, as a Spares tile
// (js/bulk-edit.js tileKey), and its finish.
export const shopKey = (entry) => `${tileKey(entry)}|${finishKey(entry)}`;

// The groups that have spares, in no particular order. cards are the
// person's copies, live or not; held, the copies in their binders
// (js/wishlist.js spareEntries), which are never for sale. Spares are
// decided per card, language, and finish (Eric, 2026-11-26), so a finish
// with one copy has no row: a lone reverse holo beside three normals stays
// home, and only the two spare normals are offered.
//
// A hand-made copy of a card the catalog lists too counts as a copy of that
// catalog card (catalogTwins), so a CRI card added by hand before TCGdex
// listed the set and a copy scanned later are one card with one spare, not
// two cards with none. codeOf(setId) is the set's printed code
// (js/catalog.js printedCode). away: the copies in open HOTARU orders,
// which are never chosen as the copy kept (js/wishlist.js spareEntries).
export function shopGroups(cards, {away, codeOf = () => null, held} = {}) {
	const live = (cards || []).filter((entry) => entry && isLive(entry));
	const twins = catalogTwins(live, {codeOf});
	const byId = new Map(live.map((entry) => [entry.id, entry]));
	// A copy saved with no catalog is an international one, as spareEntries
	// counts it, so it never splits from its card into a second row.
	const asCard = (entry) => (twins.has(entry.id) ? {...entry, ...twins.get(entry.id)} : {...entry, catalog: entry.catalog || 'international'});
	const counted = live.map(asCard);
	const groups = new Map();
	const groupOf = (card) => {
		const key = shopKey(card);

		if (!groups.has(key)) {
			groups.set(key, {
				card_id: card.card_id,
				catalog: card.catalog || 'international',
				copies: [],
				finish_key: finishKey(card),
				key,
				listed: [],
				language: card.language,
				marked: [],
				price: null,
				set_id: setIdOfCard(card.card_id),
				spares: [],
			});
		}

		return groups.get(key);
	};
	const spares = spareEntries(counted, {away: away || undefined, held});
	const spareIds = new Set(spares.map((spare) => spare.id));

	for (const spare of spares) {
		groupOf(spare).spares.push(byId.get(spare.id) || spare);
	}

	// A copy marked For sale that is not a spare: the last one, one in a
	// binder, or one the keeper rule keeps.
	for (const card of counted) {
		if (card.for_sale === true && !spareIds.has(card.id)) {
			groupOf(card).marked.push(byId.get(card.id) || card);
		}
	}

	for (const entry of live) {
		const group = groups.get(shopKey(asCard(entry)));

		if (group) {
			group.copies.push(entry);
		}
	}

	for (const group of groups.values()) {
		group.price = groupPrice(group);
		group.listed = [...group.spares.filter((entry) => entry.for_sale !== false), ...group.marked];
	}

	return [...groups.values()];
}

// The copies a group offers. A group made by hand, without listed (an older
// caller, a test), offers its spares, as before For sale.
export const listedOf = (group) => (group && (group.listed || group.spares)) || [];

// The copies that are free (Eric, 2026-11-25: "three Scraggy, one in the
// region binder, one in the 30 anos binder, so only one is really a spare"):
// the ones the Shop would offer, priced or not. That is every spare
// (js/wishlist.js spareEntries: not in a pocket, not a favorite, not the copy
// kept) less the ones taken off sale (for_sale false), plus any copy marked
// For sale. The tile's "×3 | 1" badge (js/tile.js tileArt free) and Check
// spares (js/spare-check.js) count them. Takes shopGroups' result, or the
// cards and its options. Returns a Set of entry ids.
export function freeCopyIds(cardsOrGroups, options = {}) {
	const groups = options.groups || shopGroups(cardsOrGroups, options);

	return new Set(groups.flatMap(listedOf).map((entry) => entry.id));
}

// The copy a group is shown and described by: one offered, else a spare,
// else any copy (a group whose spares were all taken off sale).
export const groupCopy = (group) => listedOf(group)[0] || (group.spares || [])[0] || (group.marked || [])[0] || (group.copies || [])[0];

// Each copy of the groups by id: {listed, price}, whether it is offered and
// its finish's sale price (null when not priced yet), for the card page's
// For sale switch (js/copy-sheet.js). A copy in no group is in no listing.
export function listingByCopy(groups) {
	const byId = new Map();

	for (const group of groups || []) {
		const listed = new Set(listedOf(group).map((entry) => entry.id));

		for (const entry of [...(group.copies || []), ...(group.marked || [])]) {
			byId.set(entry.id, {listed: listed.has(entry.id), price: group.price ?? null});
		}
	}

	return byId;
}

// [{id, patch}] marking copies For sale (true), taking them off (false), or
// back to today's rule (null). Copies that already say it are left alone.
export function forSalePatches(entries, value) {
	return (entries || [])
		.filter((entry) => (entry.for_sale ?? null) !== value)
		.map((entry) => ({id: entry.id, patch: {for_sale: value}}));
}

// Undo's patches for forSalePatches: each copy back to what it says now.
export const undoForSalePatches = (entries, patches) => {
	const byId = new Map((entries || []).map((entry) => [entry.id, entry]));

	return patches.map(({id}) => ({id, patch: {for_sale: byId.has(id) ? byId.get(id).for_sale ?? null : null}}));
};

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
	const entry = group && groupCopy(group);

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

// {groups, priced, listed, value}: how many cards the Shop holds and how
// many are priced, how many copies are for sale, and what the priced ones
// would bring.
export function shopTotals(groups) {
	let priced = 0;
	let listed = 0;
	let value = 0;

	for (const group of groups) {
		listed += listedOf(group).length;

		if (group.price !== null) {
			priced++;
			value += group.price * listedOf(group).length;
		}
	}

	return {groups: groups.length, listed, priced, value: Math.round(value * 100) / 100};
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

// The rows store_sync takes: one per listed copy of every priced card, and
// nothing for a card without a price or a copy taken off sale, so
// publishing them withdraws the rest.
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

		for (const entry of listedOf(group)) {
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
// ({<id>: {status}}): 'reserved' when any listed copy is held by an order,
// 'published' when every one is for sale, 'pending' when some are not
// published yet, and null for a card without a price or with nothing
// listed.
export function groupMark(group, states) {
	const listed = listedOf(group);

	if (group.price === null || !listed.length) {
		return null;
	}

	const statuses = listed.map((entry) => (states && states[entry.id] ? states[entry.id].status : null));

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

// The copy ids in open HOTARU orders (store_orders_open: pending, and paid
// but not handed over), the cards only: each is on its way to a buyer, so
// the listing invariant counts it as leaving and the spare rule never keeps
// it (v128 review H1).
export function openOrderCopyIds(orders) {
	const ids = new Set();

	for (const order of orders || []) {
		for (const item of (order && order.items) || []) {
			if (item && isCard(item) && item.listing_id) {
				ids.add(item.listing_id);
			}
		}
	}

	return ids;
}

// A live listing as store_catalog returns it, in store_sync's row shape, so
// the automatic publish can send it back exactly as HOTARU holds it (v128
// review M1: a stale screen keeps a listing it does not know about, rather
// than withdrawing it).
export function unchangedRow(listing) {
	const row = {};

	for (const key of ['card_id', 'catalog', 'condition', 'finish', 'id', 'image_path', 'language', 'name', 'number', 'price_brl', 'rarity', 'set_name']) {
		row[key] = listing[key] ?? null;
	}

	return row;
}
