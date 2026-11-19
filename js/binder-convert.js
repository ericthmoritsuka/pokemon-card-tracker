// "Make a list binder from this" (DESIGN.md section 11, Binders; Eric,
// 2026-11-18). His region binders are hand-made, one copy per pocket, so
// tapping a pocket shows that copy alone. A binder made from a list shows a
// Pokémon per pocket and every copy of it on a tap (js/binder-rules.js).
// This turns the first into the second without losing his choices: a NEW
// binder from a list, with a hand pick (binder_picks) for every pocket
// whose Pokémon or card the hand-made binder holds, naming the exact copy
// that sits there. The hand-made binder is never changed, so nothing is
// lost if he does not like the result.
//
// Pure functions only, so Node can test them (tests/binder-convert.test.mjs).
// js/binders-view.js reads the list and saves the binder and its picks.

// The name the new binder starts with: the hand-made one's, marked, within
// the 80 characters the name field takes.
export function listBinderName(name) {
	const mark = ' (list)';
	const base = String(name ?? '').trim();

	return `${base.slice(0, 80 - mark.length).trim()}${mark}`;
}

// The Pokédex numbers a hand-made binder shows, to guess the checklist it
// was laid out from (Lay out from a list records none). slots: its pockets
// (js/binders.js slotsOf); copyDex(entryId) and cardDex(catalog, cardId):
// the Pokédex numbers of a copy's card and of a card placeholder's card.
// A Pokémon's placeholder names its number itself.
export function handDex(slots, {cardDex = () => [], copyDex = () => []} = {}) {
	const out = new Set();
	const add = (numbers) => {
		for (const n of numbers || []) {
			if (Number.isInteger(n) && n > 0) {
				out.add(n);
			}
		}
	};

	for (const slot of slots || []) {
		if (slot.entry_id) {
			add(copyDex(slot.entry_id));
		}
		else if (slot.want && Number.isInteger(slot.want.dex) && !slot.want.card_id) {
			add([slot.want.dex]);
		}
		else if (slot.want && slot.want.card_id) {
			add(cardDex(slot.want.catalog || 'international', slot.want.card_id));
		}
	}

	return out;
}

// The checklist the binder most likely came from: the one that matches its
// Pokémon best, as the share of the list and the binder together that both
// hold. So a Kanto binder with a Johto card or two still picks Kanto over a
// list of every Pokémon, which holds them all but is mostly not in the
// binder. A tie goes to the smaller list, then to the person's own order.
// lists: [{id, dex: [numbers]}] in that order; dex: handDex. Null when no
// list holds any of them.
export function guessChecklist(lists, dex) {
	const binder = new Set(dex || []);
	let best = null;

	for (const list of lists || []) {
		const numbers = new Set(list.dex || []);
		let hits = 0;

		for (const n of binder) {
			if (numbers.has(n)) {
				hits++;
			}
		}

		const score = hits / (numbers.size + binder.size - hits);

		if (hits && (!best || score > best.score || (score === best.score && numbers.size < best.size))) {
			best = {id: list.id, score, size: numbers.size};
		}
	}

	return best ? best.id : null;
}

// The hand picks the new binder gets. slots: the hand-made binder's
// pockets in pocket order (js/binders.js slotsOf); items: the list's
// pockets, each {key, copies} (js/binder-sources.js loadRuleItems); keys:
// the new binder's pockets (its snapshot keys), the items' own when not
// given. liveIds: the live copies, so a Gone pocket (its copy deleted) is
// passed over rather than counted as off the list.
//
// A copy is picked for the pocket whose copies include it, so the pick
// always fits (js/binder-rules.js shownCopy shows it). When two copies of
// the hand-made binder fit one pocket, the first in pocket order is picked
// and the other is counted in `unused`. A copy that fits several pockets
// (a TAG TEAM card shows two or three Pokémon) is placed after the copies
// that fit one, in the first of its pockets still free in the list's order,
// so a card of Zekrom alone keeps Zekrom's pocket from a TAG TEAM card that
// also shows Pikachu.
//
// Returns {picks: [{key, entryId, page, position}] in pocket order,
// unused, outside}: unused, copies that fit a pocket an earlier copy took;
// outside, copies that fit no pocket of the list (a card not on it, or in a
// language the list does not count). Placeholders, art, and empty pockets
// are no copy, so they count in neither.
export function handPicks(slots, items, {keys = null, liveIds = null} = {}) {
	const pockets = new Set((keys || (items || []).map((item) => item.key)).filter(Boolean));
	const rank = new Map((items || []).map((item, i) => [item.key, i]));
	const fits = new Map();

	for (const item of items || []) {
		if (!pockets.has(item.key)) {
			continue;
		}

		for (const entry of item.copies || []) {
			if (entry && entry.id) {
				fits.set(entry.id, [...(fits.get(entry.id) || []), item.key]);
			}
		}
	}

	const held = (slots || [])
		.filter((slot) => slot && slot.entry_id && (!liveIds || liveIds.has(slot.entry_id)))
		.sort((a, b) => (a.page - b.page) || (a.position - b.position));
	const seen = new Set();
	const copies = [];
	let outside = 0;

	for (const slot of held) {
		// A copy read in two pockets (two phones disagreeing) counts once.
		if (seen.has(slot.entry_id)) {
			continue;
		}

		seen.add(slot.entry_id);

		const keysOf = fits.get(slot.entry_id);

		if (!keysOf) {
			outside++;
		}
		else {
			copies.push({keys: [...keysOf].sort((a, b) => rank.get(a) - rank.get(b)), slot});
		}
	}

	const taken = new Map();
	let unused = 0;

	for (const pass of [(copy) => copy.keys.length === 1, (copy) => copy.keys.length > 1]) {
		for (const copy of copies.filter(pass)) {
			const key = copy.keys.find((one) => !taken.has(one));

			if (key) {
				taken.set(key, copy.slot);
			}
			else {
				unused++;
			}
		}
	}

	const picks = [...taken.entries()]
		.map(([key, slot]) => ({entryId: slot.entry_id, key, page: slot.page, position: slot.position}))
		.sort((a, b) => (a.page - b.page) || (a.position - b.position));

	return {outside, picks, unused};
}

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// What the conversion will do, for the form, before anything is saved.
export function convertPreview({outside, picks, unused}, handName) {
	if (!picks.length) {
		return `None of the cards in ${handName} fit this list, so every pocket shows its default copy.`;
	}

	const parts = [`${count(picks.length, 'pocket shows', 'pockets show')} the card you chose in ${handName}.`];

	if (unused) {
		parts.push(`${count(unused, 'card shares', 'cards share')} a pocket with an earlier card and ${unused === 1 ? 'is' : 'are'} not used.`);
	}

	if (outside) {
		parts.push(`${count(outside, 'card is', 'cards are')} not on this list.`);
	}

	return parts.join(' ');
}

// The notice after it is made, in one line: what was made, the picks kept,
// and that the hand-made binder is as it was.
export function convertDoneText({name, picks, unused}, handName) {
	const kept = picks.length
		? `${count(picks.length, 'pocket keeps', 'pockets keep')} the card you chose${unused ? ` (${count(unused, 'more card', 'more cards')} shared a pocket and ${unused === 1 ? 'was' : 'were'} not used)` : ''}`
		: 'no pocket kept a card you chose';

	return `Made ${name}: ${kept}. ${handName} is unchanged; delete it when you are happy with the new one.`;
}
