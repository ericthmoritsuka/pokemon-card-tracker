// Add to binder on a binder made from a list (Eric, 2026-11-24: "add a card
// to ANY binder I have"). The card page's sheet (js/binder-hand.js) and My
// Cards' bulk Add to binder (js/bulk-select.js) both work through here, so
// the two follow one rule:
//   pick  the binder has a pocket for the card (its card's pocket, or on a
//         checklist a pocket of one of its Pokémon, for a copy in a language
//         the list counts): that copy becomes the pocket's hand pick
//   add   otherwise the card joins after the list (extra_cards, always that
//         print), filling the extra pages first, with that copy picked
// A hand-made binder keeps its own way: the copy waits in its tray or in the
// hand until it is placed.

import {cardKey, claimIndex, dexKey, isGenerated} from './binder-rules.js';
import {sourceEntry} from './binder-sources.js';
import {copyClaims, saveListAdds} from './binders.js';
import {cardIndex} from './catalog.js';
import {isLive, loadDocument} from './collection.js';
import {cleanListLanguages, namesListLanguages} from './languages.js';

const catalogOf = (entry) => entry.catalog || 'international';

// Where a copy of a card goes in a list's binder, without saving it:
// {kind: 'pick' | 'add', key, page}. card: {catalog, cardId, dexIds,
// language}; languages: the checklist's, or null when it counts any.
export function listTarget(binder, card, {languages = null} = {}) {
	const snapshot = (binder && binder.snapshot) || {};
	const keys = Array.isArray(snapshot.keys) ? snapshot.keys : [];
	const per = binder.rows * binder.cols;
	const key = cardKey(card.catalog, card.cardId);
	let at = keys.indexOf(key);
	const counted = !languages || !card.language || languages.includes(card.language);

	if (at < 0 && binder.rule && binder.rule.source && binder.rule.source.kind === 'checklist' && counted) {
		at = keys.findIndex((one) => (card.dexIds || []).some((n) => one === dexKey(n)));
	}

	return at >= 0
		? {key: keys[at], kind: 'pick', page: Math.floor(at / per) + 1}
		: {key, kind: 'add', page: Math.floor(keys.length / per) + 1};
}

// The languages a binder's checklist counts, or null.
export function listLanguagesOf(binder, doc) {
	if (!binder || !binder.rule || !binder.rule.source || binder.rule.source.kind !== 'checklist') {
		return null;
	}

	const list = sourceEntry(binder.rule, doc);

	return list && namesListLanguages(list) ? cleanListLanguages(list.languages) : null;
}

// The words the sheet shows under a list's binder before the tap. name: the
// pocket's card or Pokémon as the sheet calls it.
export function targetText(target) {
	return target.kind === 'pick'
		? `Shows your copy in its pocket, page ${target.page}.`
		: `Adds it after the list, page ${target.page}.`;
}

// Which copy goes: one not in use in another pocket first, then the newest.
export function copyToShow(copies, claims) {
	const free = copies.filter((entry) => !(claims.get(entry.id) || []).length);
	const newest = (list) => [...list].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;

	return newest(free) || newest(copies);
}

// The plan for copies going into a list's binder: one copy per card, and
// one card per pocket (the first to ask). Returns {picks, adds, targets,
// skipped}: picks and adds as js/binders.js saveListAdds takes them, the
// target of each card in order, and how many copies stay where they are.
export function planListAdds(binder, copies, {claims = new Map(), index = new Map(), languages = null} = {}) {
	const byCard = new Map();

	for (const entry of copies.filter((one) => one && isLive(one))) {
		const key = cardKey(catalogOf(entry), entry.card_id);

		byCard.set(key, [...(byCard.get(key) || []), entry]);
	}

	const picks = [];
	const adds = [];
	const targets = [];
	const taken = new Set();
	let skipped = 0;

	for (const [key, list] of byCard) {
		const entry = copyToShow(list, claims);
		const record = index.get(key);
		const target = listTarget(binder, {catalog: catalogOf(entry), cardId: entry.card_id, dexIds: (record && record.dex_ids) || [], language: entry.language}, {languages});

		skipped += list.length - 1;

		if (taken.has(target.key)) {
			skipped++;
			continue;
		}

		taken.add(target.key);
		targets.push({...target, entryId: entry.id});
		(target.kind === 'pick' ? picks : adds).push({entryId: entry.id, key: target.key});
	}

	return {adds, picks, skipped, targets};
}

// Saves copies into a list's binder: plans with the person's document and
// card index, then one write. Resolves {adds, picks, previous, skipped,
// targets}; previous and adds undo it (js/binders.js undoListAdds).
export async function addCopiesToListBinder(binderId, copies) {
	const [doc, index] = await Promise.all([loadDocument(), cardIndex().catch(() => new Map())]);
	const binder = (doc.binders || []).find((one) => one && one.id === binderId && isLive(one));

	if (!isGenerated(binder)) {
		throw new Error('This binder is not on this phone. It may have been deleted.');
	}

	const plan = planListAdds(binder, copies, {claims: claimIndex(copyClaims(doc)), index, languages: listLanguagesOf(binder, doc)});
	const saved = plan.adds.length || plan.picks.length ? await saveListAdds(binderId, {adds: plan.adds, picks: plan.picks}) : {previous: []};

	return {...plan, previous: saved.previous};
}
