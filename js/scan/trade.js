// The scanner's Trade or sale mode (Eric, 2026-11-06: "Maybe I could use the
// scanner to register the trades/sales too instead of registering them just
// manually"; DESIGN.md section 11, "Scan a trade or a sale"). Pure parts
// only, no DOM, so Node tests them (tests/scan-trade.test.mjs); the tray and
// the copy picker are js/scan/trade-sheets.js, and js/scan/view.js runs both.
//
// Scan has two modes, Add (what it always did, the default) and Trade or
// sale, remembered on the phone. In Trade or sale the tray is a session of
// its own (session.mode 'trade', kept in the draft under its own key, so the
// Add tray waits untouched), with two sides: each card carries side 'out'
// (Going out) or 'in' (Coming in), from the side chosen when it was scanned
// (session.side, Going out first).
//
// A card going out is one of Eric's copies (outCopies): one that fits what
// the scanner read (the same card, the language, and the finish, where both
// the scan and the copy name one). Copies in no binder pocket or tray come
// first, then the very finish read. When the copies it would choose between
// are alike (the same finish and condition), it takes one by itself, a
// spare first (the Trade view's rule, js/wishlist.js spareEntries), then the
// newest. Eric picks (item.picked, the copies' ids) only when the choice
// matters: the loose copies differ in finish or condition, or not enough
// loose copies fit, so one would leave a binder. A card he does not own
// cannot go out and is not logged. No copy goes out twice.
// A card coming in is a new copy as Add would make it (session.js
// entriesToSave). Log it hands both lists to the trades log's form
// (tradeHandoff, js/moves.js setPendingMove), which saves as it always does;
// nothing in the collection changes before that save.

import {cardImage} from '../catalog.js';
import {handBinders, placements, stagedOf} from '../binders.js';
import {isLive, nowIso} from '../collection.js';
import {spareEntries} from '../wishlist.js';
import {blocker, copiesOf, entriesToSave, newSession} from './session.js';

export const MODE_KEY = 'card-tracker:scan-mode';

// The scanning mode remembered on this phone: 'add' (the default) or 'trade'.
export function storedMode() {
	try {
		return localStorage.getItem(MODE_KEY) === 'trade' ? 'trade' : 'add';
	}
	catch {
		return 'add';
	}
}

export function rememberMode(mode) {
	try {
		localStorage.setItem(MODE_KEY, mode === 'trade' ? 'trade' : 'add');
	}
	catch {
		// Not kept; Scan opens in Add next time.
	}
}

export const isTrade = (session) => Boolean(session && session.mode === 'trade');

export function newTradeSession(now = nowIso(), id = undefined) {
	return {...newSession(now, id), mode: 'trade', side: 'out'};
}

export const sideOf = (item) => (item && item.side === 'in' ? 'in' : 'out');

export const SIDE_NAMES = {in: 'Coming in', out: 'Going out'};

// Which side the next scans go to.
export function setSide(session, side, now = nowIso()) {
	session.side = side === 'in' ? 'in' : 'out';
	session.updated_at = now;

	return session.side;
}

// A card scanned on the wrong side moves to the other; a pick of copies
// stays with Going out only.
export function moveToSide(session, id, side, now = nowIso()) {
	const item = session.items.find((one) => one.id === id);

	if (!item) {
		return null;
	}

	item.side = side === 'in' ? 'in' : 'out';
	delete item.picked;
	session.updated_at = now;

	return item.side;
}

// The copies Eric picked for a card going out (copy ids, as many as the
// card's copies), or none to let the scanner choose again.
export function pickCopies(session, id, entryIds, now = nowIso()) {
	const item = session.items.find((one) => one.id === id);

	if (!item) {
		return null;
	}

	const ids = [...new Set((entryIds || []).filter((entryId) => typeof entryId === 'string' && entryId))].slice(0, copiesOf(item));

	if (ids.length) {
		item.picked = ids;
	}
	else {
		delete item.picked;
	}

	session.updated_at = now;

	return ids;
}

// ------------------------------------------------------------ where a copy is

// Where each copy is that a binder holds: Map entry id -> {kind: 'pocket',
// binder_name, page, position} or {kind: 'tray', binder_name}. A copy in no
// binder is not in the map: it is loose.
export function copyWhere(binders) {
	const where = new Map();

	for (const binder of handBinders(binders)) {
		for (const id of stagedOf(binder)) {
			where.set(id, {binder_name: binder.name, kind: 'tray'});
		}
	}

	for (const [id, {binder, slot}] of placements(binders)) {
		where.set(id, {binder_name: binder.name, kind: 'pocket', page: slot.page, position: slot.position});
	}

	return where;
}

// "Binder A, page 3, pocket 2", "In Binder A's tray", "Stored in Box 1", or
// "Not in a binder".
export function whereText(where, entry = null) {
	if (where && where.kind === 'pocket') {
		return `${where.binder_name}, page ${where.page}, pocket ${where.position}`;
	}

	if (where && where.kind === 'tray') {
		return `In ${where.binder_name}'s tray`;
	}

	return entry && entry.storage ? `Stored in ${entry.storage}` : 'Not in a binder';
}

// ------------------------------------------------------------ copies going out

const entryCatalog = (entry) => entry.catalog || 'international';

const sameCard = (entry, item) => Boolean(item.card) && entry.card_id === item.card.id && entryCatalog(entry) === (item.card.catalog || 'international');

// A copy fits a scan in its language, and in its finish where both name one
// (a copy saved with no finish, or a scan with none picked, fits any).
export const fitsScan = (entry, item) => sameCard(entry, item)
	&& entry.language === item.language
	&& (!item.variantId || !entry.variant_id || entry.variant_id === item.variantId);

// A card the scanner is still working on has no copy yet.
const BUSY = new Set(['reading', 'matching', 'waiting', 'rematch']);

const byAge = (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || String(a.id).localeCompare(String(b.id));

// Which copy each card going out takes: Map item id -> {status, need, copies,
// candidates, suggested, by}.
//
//   status  'busy'    the card is not read yet, or has no language
//           'none'    no copy of the card at all: it cannot go out
//           'other'   copies of the card, none in this language and finish
//                     (or every one already going out): not logged unless
//                     Eric picks one
//           'ask'     the loose copies it would choose between differ in
//                     finish or condition (a loose copy with no finish saved
//                     counts for the condition beside the ones in the finish
//                     read), too few loose copies fit and the rest are in
//                     binders, or the finish read is in a binder while the
//                     loose copies have no finish saved: Eric picks
//           'short'   fewer copies fit than the card's copies: those go
//           'chosen'  the copies are settled (by 'auto' or 'hand')
//   need        how many copies the card stands for (its Copies)
//   copies      the copies chosen (entries)
//   candidates  every copy he may pick for it, best first: the fitting ones,
//               or for 'other' every copy of the card no other card takes
//   suggested   the ids the scanner would take first
//   stale       'gone' when a copy Eric picked is no longer in his cards
//               (removed on another phone, say), 'taken' when an earlier
//               card took it: the card asks again rather than take another
//               copy without a word
//   why         for 'busy' while his cards are not read yet: 'loading', or
//               'failed' when they could not be read
//
// cards: the person's copies (live ones are used); where: copyWhere. Cards
// are settled in the tray's order (the first scanned first), after every
// hand pick has taken its copies, so no copy is chosen twice. known:
// 'loaded' once the cards were read, else 'loading' or 'failed': until
// they are, no card going out is matched (an empty list would read as
// "not in your cards" and let Log it log a purchase without them).
export function outCopies(session, cards, {known = 'loaded', where = new Map()} = {}) {
	const live = (cards || []).filter((entry) => entry && entry.id && isLive(entry));
	const byId = new Map(live.map((entry) => [entry.id, entry]));
	const spares = new Set(spareEntries(live).map((entry) => entry.id));
	const loose = (entry) => !where.has(entry.id);
	const spare = (entry) => spares.has(entry.id);
	const outs = session.items.filter((item) => sideOf(item) === 'out');
	const taken = new Set();
	const hands = new Map();
	const stale = new Map();
	const results = new Map();

	if (known !== 'loaded') {
		for (const item of outs) {
			results.set(item.id, {by: null, candidates: [], copies: [], need: copiesOf(item), status: 'busy', suggested: [], why: known === 'failed' ? 'failed' : 'loading'});
		}

		return results;
	}

	// Hand picks first, in tray order: a copy picked twice stays with the
	// first card. A pick whose copy is gone, or went to an earlier card,
	// makes its card ask again.
	for (const item of outs) {
		const picked = [];

		for (const id of (item.picked || []).slice(0, copiesOf(item))) {
			const entry = byId.get(id);

			if (!entry || !sameCard(entry, item)) {
				stale.set(item.id, 'gone');
			}
			else if (taken.has(entry.id)) {
				stale.set(item.id, stale.get(item.id) || 'taken');
			}
			else {
				picked.push(entry);
				taken.add(entry.id);
			}
		}

		hands.set(item.id, picked);
	}

	const exact = (item, entry) => Boolean(item.variantId) && entry.variant_id === item.variantId;
	// Best first: loose, then the very finish read, then spares, then the
	// newest added.
	const rank = (item) => (a, b) => Number(loose(b)) - Number(loose(a))
		|| Number(exact(item, b)) - Number(exact(item, a))
		|| Number(spare(b)) - Number(spare(a))
		|| byAge(a, b);
	// Copies alike for whoever gets them: the same finish and condition (a
	// copy with neither saved is alike only to another without).
	const kindOf = (entry) => JSON.stringify([entry.variant_id || null, entry.condition || null]);

	for (const item of outs) {
		const need = copiesOf(item);
		const hand = hands.get(item.id);
		const result = {by: null, candidates: [], copies: [], need, status: 'busy', suggested: []};

		results.set(item.id, result);

		if (!item.card || !item.language || BUSY.has(blocker(item))) {
			continue;
		}

		const all = live.filter((entry) => sameCard(entry, item));
		const free = all.filter((entry) => !taken.has(entry.id));
		const fits = free.filter((entry) => fitsScan(entry, item)).sort(rank(item));
		const remaining = need - hand.length;

		if (stale.has(item.id)) {
			const others = (fits.length ? fits : free.sort(rank(item))).filter((entry) => !hand.includes(entry));

			Object.assign(result, {by: 'hand', candidates: [...hand, ...others], copies: hand, stale: stale.get(item.id), status: 'ask'});
			continue;
		}

		if (remaining <= 0) {
			Object.assign(result, {by: 'hand', candidates: [...hand, ...fits], copies: hand, status: 'chosen'});
			continue;
		}

		if (!all.length) {
			result.status = 'none';
			continue;
		}

		if (!fits.length) {
			Object.assign(result, {by: hand.length ? 'hand' : null, candidates: [...hand, ...free.sort(rank(item))], copies: hand, status: hand.length ? 'short' : 'other'});
			continue;
		}

		if (fits.length < remaining) {
			const copies = [...hand, ...fits];

			for (const entry of fits) {
				taken.add(entry.id);
			}

			Object.assign(result, {by: 'auto', candidates: [...hand, ...fits], copies, status: 'short', suggested: fits.map((entry) => entry.id)});
			continue;
		}

		// Eric's rule (2026-11-06): the loose copies, in the finish read where
		// enough are; among those, the scanner chooses by itself when the
		// ones it chooses between are alike, and asks when the choice changes
		// what leaves, or when a copy would have to leave a binder.
		const looseFits = fits.filter(loose);

		result.candidates = [...hand, ...fits];
		result.suggested = fits.slice(0, remaining).map((entry) => entry.id);

		if (looseFits.length < remaining) {
			Object.assign(result, {copies: hand, status: 'ask'});
			continue;
		}

		const exactFits = looseFits.filter((entry) => exact(item, entry));
		const settled = exactFits.length >= remaining ? [] : exactFits;
		const between = exactFits.length >= remaining ? exactFits : looseFits.filter((entry) => !settled.includes(entry));
		const left = remaining - settled.length;
		// Loose copies with no finish saved may be the finish read too: when
		// the copies in that finish are enough, they still count for the
		// condition, so a Played holo never goes silently while a Near Mint
		// copy of unknown finish was the other choice.
		const unknown = exactFits.length >= remaining ? looseFits.filter((entry) => !entry.variant_id) : [];
		const conditions = new Set([...between, ...unknown].map((entry) => entry.condition || null));
		// A finish read, too few loose copies in it, and the loose ones left
		// have no finish saved while a copy in that very finish sits in a
		// binder: which one is the card in his hand is his call.
		const binderExact = Boolean(item.variantId) && exactFits.length < remaining && fits.some((entry) => !loose(entry) && exact(item, entry)) && between.every((entry) => !entry.variant_id);

		if ((between.length > left && new Set(between.map(kindOf)).size > 1) || (unknown.length && conditions.size > 1) || binderExact) {
			Object.assign(result, {copies: hand, status: 'ask'});
			continue;
		}

		const chosen = [...settled, ...between.slice(0, left)];

		for (const entry of chosen) {
			taken.add(entry.id);
		}

		Object.assign(result, {by: hand.length ? 'hand' : 'auto', copies: [...hand, ...chosen], status: 'chosen'});
	}

	return results;
}

// ------------------------------------------------------------ what the tray can log

const LOOK = new Set(['unmatched', 'unsure', 'language', 'finish']);

// How the trade tray stands: {out, in} rows, {outCopies, inCopies} that Log
// it would hand over, look (cards needing a look), busy (still read or
// looked up), ask (cards going out whose copy Eric picks), skipped (cards
// going out that are not owned), and loggable.
export function tradeSummary(session, results) {
	const out = {ask: 0, busy: 0, in: 0, inCopies: 0, look: 0, loggable: false, out: 0, outCopies: 0, skipped: 0};

	for (const item of session.items) {
		const reason = blocker(item);
		const side = sideOf(item);

		out[side]++;

		if (LOOK.has(reason)) {
			out.look++;
			continue;
		}

		if (side === 'in') {
			if (reason === null) {
				out.inCopies += copiesOf(item);
			}
			else {
				out.busy++;
			}

			continue;
		}

		const result = results.get(item.id);

		if (reason !== null || !result || result.status === 'busy') {
			out.busy++;
		}
		else if (result.status === 'ask') {
			out.ask++;
		}
		else if (result.status === 'none' || result.status === 'other') {
			out.skipped++;
		}
		else {
			out.outCopies += result.copies.length;
		}
	}

	out.loggable = out.look === 0 && out.busy === 0 && out.ask === 0 && out.outCopies + out.inCopies > 0;

	return out;
}

// The kind of move the sides suggest: cards only going out are Sold (or
// given: Gift), only coming in Bought (or received: Gift), both ways Traded.
export function guessKind(outCount, inCount) {
	if (outCount && inCount) {
		return {alternatives: [], kind: 'traded'};
	}

	if (outCount) {
		return {alternatives: ['gift'], kind: 'sold'};
	}

	if (inCount) {
		return {alternatives: ['gift'], kind: 'bought'};
	}

	return {alternatives: [], kind: null};
}

// What Log it hands the trades log's form (js/moves-view.js newMoveView):
// {kind, alternatives, out: [copy ids], in: [{fields, info, n}], items:
// {out, in} (the tray's item ids on each side), records, session}. The cards in are the copies Add would save (session.js
// entriesToSave: card, catalog, language, language_source 'scan', finish,
// condition), one row per tray card with its copies as n; records names
// them in the card index (as Add's save does), so the form shows their
// names offline. Cards going out that are not owned, or not settled, are
// left out.
export function tradeHandoff(session, results, owned = new Map()) {
	const out = [];

	for (const item of session.items.filter((one) => sideOf(one) === 'out')) {
		const result = results.get(item.id);

		if (result && (result.status === 'chosen' || result.status === 'short')) {
			out.push(...result.copies.map((entry) => entry.id));
		}
	}

	const ins = session.items.filter((item) => sideOf(item) === 'in');
	const rows = entriesToSave({...session, items: ins}, owned);
	const incoming = [];
	const records = [];

	for (const item of ins) {
		const row = rows.find((one) => one.itemId === item.id);

		if (!row) {
			continue;
		}

		const card = item.card;

		incoming.push({
			fields: {...row.fields},
			info: {image: card.image ? cardImage(card.image, 'low') : null, name: card.name, number: card.localId, setName: card.setName || null},
			n: copiesOf(item),
		});
		records.push({
			catalog: card.catalog,
			collector_number: card.localId,
			id: card.id,
			localizations: {[card.lang]: {image: card.image || null, lang: card.lang, name: card.name, set_name: card.setName || null}},
			official: card.official ? Number(card.official) : null,
			release_date: card.releaseDate || null,
			set_id: card.setId,
		});
	}

	const {alternatives, kind} = guessKind(out.length, incoming.length);
	// The tray's cards on each side as they are now: the save takes out
	// only these (draft.js clearTrade).
	const items = {in: ins.map((item) => item.id), out: session.items.filter((item) => sideOf(item) === 'out').map((item) => item.id)};

	return {alternatives, in: incoming, items, kind, out, records, session: session.id};
}

// One line under a card going out, saying which copy goes or why none does.
export function outLine(result, {where = new Map(), languageName = (code) => code} = {}) {
	if (result && result.status === 'busy' && result.why === 'failed') {
		return 'Could not read your cards; try again.';
	}

	if (result && result.status === 'busy' && result.why === 'loading') {
		return 'Checking your cards…';
	}

	if (!result || result.status === 'busy') {
		return null;
	}

	if (result.stale) {
		const again = result.candidates.length ? 'pick again.' : 'no other copy fits, so remove this card.';

		return result.stale === 'gone' ? `The copy you picked is gone; ${again}` : `The copy you picked goes out with another card; ${again}`;
	}

	const placeOf = (entry) => whereText(where.get(entry.id), entry);

	switch (result.status) {
		case 'none':
			return 'Not in your cards, so it cannot go out. Not logged.';
		case 'other':
			return result.candidates.length
				? 'None of your copies is in this language and finish. Not logged unless you pick one.'
				: 'Every copy you own of it is already going out. Not logged.';
		case 'ask':
			return `${result.candidates.length} ${result.candidates.length === 1 ? 'copy matches' : 'copies match'}${result.need > 1 ? `; pick ${result.need}` : ''}.`;
		case 'short':
			return `You own only ${result.copies.length} that ${result.copies.length === 1 ? 'fits' : 'fit'}; ${result.copies.length === 1 ? 'it goes' : 'they go'}.`;
		default: {
			const [first] = result.copies;
			const places = [...new Set(result.copies.map(placeOf))];

			return [result.by === 'hand' ? 'Your pick' : null, first ? languageName(first.language) : null, result.copies.length > 1 ? `${result.copies.length} copies` : null, places.join('; ')].filter(Boolean).join(' · ');
		}
	}
}
