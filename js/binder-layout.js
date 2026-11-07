// "Lay out from a list" (DESIGN.md section 11, Binders; Eric, 2026-11-06:
// "if I put the Johto list and select a binder for it, it should imagine
// I'm adding the Pokémon from Johto in order"). A hand-made binder takes a
// checklist's Pokémon, in Pokédex order, as placeholders in its pockets
// with nothing in them, so the binder fills the way he fills a real one.
//
//   - Where: from the first empty pocket after the last pocket in use (a
//     card, a Gone card, a placeholder, art, or one left empty on purpose),
//     since his binders fill in order; or, chosen in the preview, every
//     empty pocket from page 1. A pocket that holds anything, left empty
//     on purpose included, never changes.
//   - What: one placeholder per Pokémon on the list that this binder does
//     not have yet: a Pokémon is in it when a copy in one of its pockets
//     shows it (in any language), or a placeholder stands for it (a
//     Pokémon's, or a card's whose record names it).
//   - Too many: the preview says how many did not fit and offers pages at
//     the end, up to the 200 a binder can have.
//   - Cards he owns: with "Fill binder placeholders automatically" on,
//     copies in no pocket and no tray go into their placeholders in the
//     same save, the most valuable first (readList rankOf), through
//     js/placeholder-fill.js fillPlan and js/binders.js fillPlaceholders;
//     later copies fill them through the same automatic fill (afterAdding).
//   - One save, with Undo on the toast: Undo takes out each placeholder
//     and each copy the layout put in, where the pocket still holds it;
//     pages it added stay, empty, to be removed in Edit binder (another
//     phone may have placed a card there that has not synced yet).
//
// A Pokémon's placeholder is the existing placeholder (slot.want) with no
// card: {card_id: null, catalog: null, variant_id: null, image: null,
// name, dex, languages?} (js/binders.js isPokemonWant). DESIGN.md says why,
// and what an older app does with it.
//
// layoutDraft is pure, so Node tests it (tests/binder-layout.test.mjs).

import {indexKey} from './catalog.js';
import {loadDocument, nowIso} from './collection.js';
import {formatCount, plural} from './format.js';
import {MAX_PAGES, changeBinders, fillPlaceholders, handBinders, isPokemonWant, layOutWants, openPockets, placements, pocketsPerPage, slotsOf, undoLayOut} from './binders.js';
import {loadRuleItems, rankerFor, sourceEntry} from './binder-sources.js';
import {autoFillOn, fillPlan} from './placeholder-fill.js';

const keyOf = (where) => `${where.page}|${where.position}`;

// The rule a checklist's Pokémon are read with: the binder from a list's
// own (js/binder-sources.js loadRuleItems), in Pokédex order.
export const listRule = (listId) => ({order: 'dex', source: {id: listId, kind: 'checklist'}});

// A Pokémon's placeholder for one checklist item. languages: the list's,
// or null when it names none.
export const pokemonWant = (item, languages = null) => ({
	card_id: null,
	catalog: null,
	dex: item.dex,
	image: null,
	...(languages && languages.length ? {languages: [...languages]} : {}),
	name: item.name || null,
	variant_id: null,
});

// Map entry id -> the Pokédex numbers its card shows, from a list's items
// (each item's copies are the ones that show its Pokémon).
export function dexOfItems(items) {
	const out = new Map();

	for (const item of items || []) {
		for (const entry of item.copies || []) {
			out.set(entry.id, [...(out.get(entry.id) || []), item.dex]);
		}
	}

	return out;
}

// Pure: where the list's Pokémon go in `binder`. items: the checklist's
// items in Pokédex order (loadRuleItems); owned: the same with copies in
// any language (its anyItems, or items), to tell which Pokémon this
// binder has already; cardDex(catalog, cardId): the Pokédex numbers of a
// card placeholder's card. from: "after" (the first empty pocket after the
// last one in use) or "start" (every empty pocket from page 1). addPages:
// add pages at the end for what does not fit.
// Returns {pockets: [{page, position, want}], present, missing, open,
// overflow, morePages, pageCountBefore, pageCount, start}: present, the
// list's Pokémon this binder has; missing, the ones it does not; open, the
// empty pockets it may use without new pages; overflow, Pokémon left out;
// morePages, the pages that would make room for what does not fit (within
// MAX_PAGES); start, the first pocket used or null.
export function planListLayout(binder, items, {addPages = false, cardDex = () => [], from = 'after', languages = null, owned = null, placed = placements([binder])} = {}) {
	const per = pocketsPerPage(binder);
	const slots = slotsOf(binder, placed);
	const listed = new Set((items || []).map((item) => item.dex));
	const inHere = new Set(slots.filter((slot) => slot.entry_id).map((slot) => slot.entry_id));
	const present = new Set();

	for (const item of owned || items || []) {
		if ((item.copies || []).some((entry) => inHere.has(entry.id))) {
			present.add(item.dex);
		}
	}

	for (const slot of slots) {
		if (isPokemonWant(slot.want)) {
			present.add(slot.want.dex);
		}
		else if (slot.want && slot.want.card_id) {
			for (const n of cardDex(slot.want.catalog || 'international', slot.want.card_id) || []) {
				present.add(n);
			}
		}
	}

	const missing = (items || []).filter((item) => !present.has(item.dex));
	const last = slots.reduce((max, slot) => Math.max(max, ((slot.page - 1) * per) + slot.position), 0);
	const after = from === 'start' ? 0 : last;
	const open = openPockets(binder, placed).filter((pocket) => ((pocket.page - 1) * per) + pocket.position > after);
	const rest = Math.max(0, missing.length - open.length);
	const room = Math.max(0, MAX_PAGES - binder.page_count);
	const morePages = Math.min(room, Math.ceil(rest / per));
	const pageCount = addPages ? binder.page_count + morePages : binder.page_count;
	const spots = [...open];

	for (let page = binder.page_count + 1; page <= pageCount; page++) {
		for (let position = 1; position <= per; position++) {
			spots.push({page, position});
		}
	}

	const pockets = missing.slice(0, spots.length).map((item, i) => ({...spots[i], want: pokemonWant(item, languages)}));

	return {
		missing: missing.length,
		morePages,
		open: open.length,
		overflow: missing.length - pockets.length,
		pageCount,
		pageCountBefore: binder.page_count,
		pockets,
		present: [...present].filter((n) => listed.has(n)).length,
		start: pockets.length ? {page: pockets[0].page, position: pockets[0].position} : null,
	};
}

// The Pokédex numbers of a card, from the card index.
export const cardDexFrom = (index) => (catalog, cardId) => {
	const record = index ? index.get(indexKey(catalog, cardId)) : null;

	return record && Array.isArray(record.dex_ids) ? record.dex_ids : [];
};

// Pure: the layout and the fill for `doc` now, as one change. loaded: the
// list read (readList). Returns {plan, changed, done, fills}: changed is the
// binder to save; done is what undoLayout takes; fills, how many
// placeholders a copy you own fills now.
export function layoutDraft(doc, binderId, loaded, {addPages = false, at = nowIso(), from = 'after'} = {}) {
	const binders = (doc && doc.binders) || [];
	const binder = handBinders(binders).find((item) => item.id === binderId);

	if (!binder) {
		throw new Error('This binder is not on this phone, or it is made from a list.');
	}

	const placed = placements(binders);
	const languages = loaded.languages ? String(loaded.languages).split(',') : null;
	const plan = planListLayout(binder, loaded.items, {addPages, cardDex: cardDexFrom(loaded.index), from, languages, owned: loaded.anyItems || loaded.items, placed});
	const laid = layOutWants(binders, {at, binderId, pageCount: plan.pageCount, pockets: plan.pockets});
	let changed = laid.changed;
	let fills = [];

	if (laid.done.length && autoFillOn(doc)) {
		const draft = {...doc, binders: binders.map((item) => changed.find((one) => one.id === item.id) || item)};
		const written = new Set(laid.done.map(keyOf));
		const rows = fillPlan(draft, {binderId, dexOf: dexOfItems(loaded.items), rankOf: loaded.rankOf || null}).rows.filter((row) => written.has(keyOf(row)));

		if (rows.length) {
			const filled = fillPlaceholders(draft.binders, rows, {at});

			changed = changed.map((item) => filled.changed.find((one) => one.id === item.id) || item);
			fills = filled.done.map((row) => ({entryId: row.entryId, page: row.page, position: row.position}));
		}
	}

	// Each placeholder's placed_at as saved (the stamp may move it past
	// `at`), so Undo takes out only this layout's.
	const saved = changed.find((item) => item.id === binderId);
	const placedAt = new Map(saved ? slotsOf(saved).map((slot) => [keyOf(slot), slot.placed_at]) : []);

	return {
		changed,
		done: {
			binderId,
			fills,
			pagesAdded: plan.pageCount - plan.pageCountBefore,
			wants: laid.done.map((pocket) => ({dex: pocket.want.dex, page: pocket.page, placedAt: placedAt.get(keyOf(pocket)) || at, position: pocket.position})),
		},
		fills: fills.length,
		plan,
	};
}

// ---------------------------------------------------------------- saved

// Reads a checklist's Pokémon and the copies that show them, as a binder
// from a list reads them. Resolves loadRuleItems's result, with the list's
// name (name) and rankOf, the prices and rarities of those copies
// (js/binder-sources.js rankerFor), so the most valuable copy fills its
// placeholder (Eric, 2026-11-06); or {gone: true}.
export async function readList(listId, {index = null, isAlive = () => true} = {}) {
	const doc = await loadDocument();
	const rule = listRule(listId);
	const list = sourceEntry(rule, doc);

	if (!list) {
		return {gone: true, items: []};
	}

	const loaded = await loadRuleItems(rule, doc, {index, isAlive});
	const copies = (loaded.anyItems || loaded.items || []).flatMap((item) => item.copies || []);
	const rankOf = await rankerFor(copies).catch(() => null);

	return {...loaded, name: list.name, rankOf};
}

// What it would do now, without saving: layoutDraft's {plan, fills}, and
// fill: whether owned copies go in now (the setting).
export async function previewLayout(binderId, loaded, options = {}) {
	const doc = await loadDocument();
	const {fills, plan} = layoutDraft(doc, binderId, loaded, options);

	return {fill: autoFillOn(doc), fills, plan};
}

// Saves it, planned again on the document as it is now. Resolves {done,
// fills, plan}; done is what undoLayout takes.
export const applyLayout = (binderId, loaded, options = {}) => changeBinders(async (doc) => layoutDraft(doc, binderId, loaded, {...options, at: nowIso()}));

// Undo: resolves {back, kept} (js/binders.js undoLayOut).
export const undoLayout = (done) => changeBinders(async (doc) => undoLayOut((doc && doc.binders) || [], {...done, at: nowIso()}));

// ------------------------------------------------------------- the words

const pagesText = (pockets) => {
	const first = pockets[0].page;
	const last = pockets[pockets.length - 1].page;

	return first === last ? `page ${first}` : `pages ${first} to ${last}`;
};

// The preview's sentences: "152 placeholders on pages 3 to 19, 23 filled
// with cards you own.", and what was skipped, what does not fit, and why
// nothing is filled. preview: previewLayout's; from: as planned.
export function previewLines({fill, fills, plan}, {from = 'after', partial = false} = {}) {
	const lines = [];
	const n = plan.pockets.length;

	if (!plan.missing) {
		lines.push(plan.present ? 'Every Pokémon on this list is in this binder already.' : 'This list has no Pokémon.');

		return lines;
	}

	if (n) {
		const filled = fills ? `, ${formatCount(fills)} filled with ${fills === 1 ? 'a card' : 'cards'} you own` : '';

		lines.push(`${plural(n, 'placeholder', 'placeholders')} on ${pagesText(plan.pockets)}${filled}.`);
		lines.push(from === 'start'
			? `In the empty pockets from page 1, starting at page ${plan.start.page}, pocket ${plan.start.position}.`
			: `Starting at page ${plan.start.page}, pocket ${plan.start.position}, the first empty pocket after the last one in use.`);
	}

	if (plan.present) {
		lines.push(`${plural(plan.present, 'Pokémon', 'Pokémon')} on the list ${plan.present === 1 ? 'is' : 'are'} in this binder already and ${plan.present === 1 ? 'is' : 'are'} skipped.`);
	}

	if (plan.pageCount > plan.pageCountBefore) {
		lines.push(`${plural(plan.pageCount - plan.pageCountBefore, 'page', 'pages')} added at the end: ${formatCount(plan.pageCountBefore)} to ${formatCount(plan.pageCount)}.`);
	}

	if (plan.overflow) {
		lines.push(plan.pageCount > plan.pageCountBefore || !plan.morePages
			? `${plural(plan.overflow, 'Pokémon', 'Pokémon')} still ${plan.overflow === 1 ? 'does' : 'do'} not fit: a binder has at most ${MAX_PAGES} pages.`
			: `${plural(plan.overflow, 'Pokémon', 'Pokémon')} ${plan.overflow === 1 ? 'does' : 'do'} not fit in the empty pockets.`);
	}

	if (n && !fill) {
		lines.push('"Fill binder placeholders automatically" is off in Profile, so no card you own goes in now.');
	}

	if (partial) {
		lines.push('Some of your cards could not be checked yet, so a Pokémon you have may get a placeholder too. Its copy fills it later.');
	}

	return lines;
}

// The offer to add pages, or '' when nothing is left out or no page can be
// added: "Add 5 pages so they fit (20 to 25 pages)".
export function addPagesText(plan, perPage) {
	if (!plan.overflow || !plan.morePages || plan.pageCount > plan.pageCountBefore) {
		return '';
	}

	const after = plan.pageCountBefore + plan.morePages;
	const fits = plan.morePages * perPage >= plan.overflow;

	return `Add ${plural(plan.morePages, 'page', 'pages')} ${fits ? 'so they fit' : `up to the ${MAX_PAGES} a binder can have`} (${formatCount(plan.pageCountBefore)} to ${formatCount(after)} pages)`;
}

// The toast after it is saved.
export function doneText(result, listName) {
	const n = result.done.wants.length;
	const filled = result.fills ? `; ${formatCount(result.fills)} filled with ${result.fills === 1 ? 'a card' : 'cards'} you own` : '';

	return `Laid out ${plural(n, 'placeholder', 'placeholders')} from ${listName}${filled}.`;
}

// The toast after Undo. kept: pockets left as they were (undoLayOut);
// done.pagesAdded: pages the layout added, which stay.
export function undoText({kept}, done) {
	const pages = done && done.pagesAdded
		? ` The ${done.pagesAdded === 1 ? 'page it added stays' : `${formatCount(done.pagesAdded)} pages it added stay`}, empty; remove ${done.pagesAdded === 1 ? 'it' : 'them'} in Edit binder.`
		: '';

	if (kept) {
		return `Taken back, but ${plural(kept, 'pocket has', 'pockets have')} changed since, so ${kept === 1 ? 'it stays' : 'they stay'} as ${kept === 1 ? 'it is' : 'they are'}.${pages}`;
	}

	return pages ? `Taken back.${pages}` : 'The binder is as it was.';
}
