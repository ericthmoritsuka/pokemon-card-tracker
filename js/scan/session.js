// A scan session: the tray (DESIGN.md section 3, "Every scan is a session"
// and "A scan session is a tray"). Pure state, no DOM, no network, no
// storage, so Node can test it (tests/scan.test.mjs); js/scan/draft.js keeps
// it in IndexedDB and js/scan/view.js draws it.
//
// The session is a plain object, safe to store as it is:
//   {id, created_at, updated_at, sheetShown, items: [item], lastSave}
// Each item is one physical card held up to the camera:
//   {id, captured_at, status, waitingFor, read, candidates, partial, card,
//    variants, variantId, finishBy, language, languageBy, languageHint,
//    condition, conditionBy, confirmed, sure, why, timings}
//
// status:  reading   the photo is being read
//          matching  the read is being looked up in the catalog
//          ready     a card is chosen (or none was found: card null)
//          waiting   OCR or the catalog is out of reach; resolves online
//
// Nothing here remembers a choice from one card for the next: language comes
// from that card's read (or a tap), the finish starts on the card's plain
// print, and the condition starts unset.
//
// The functions change the session in place and return what the caller
// needs to know.

import {catalogFor} from '../catalog.js';
import {newId, nowIso} from '../collection.js';
import {wishedBy} from '../wishlist.js';
import {findVariant, finishOptions, plainVariantId} from './finish.js';

// TCGplayer's condition vocabulary, verbatim (DESIGN.md section 3).
export const CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];

// The languages a card can be printed in here: the app's catalog languages,
// then German, Italian, and Spanish, which share the international records.
export const SCAN_LANGUAGES = ['pt', 'en', 'ja', 'ko', 'fr', 'zh-cn', 'zh-tw', 'de', 'it', 'es'];

export const ASIAN_LANGUAGES = ['ja', 'ko', 'zh-cn', 'zh-tw'];

const isScanLanguage = (code) => SCAN_LANGUAGES.includes(code);

// A language read off the label row needs at least two of its three labels
// (pipeline.js parseLabel gives 0.67 for two, 1 for three).
export const LANGUAGE_SURE = 0.5;

// A collector number read with less word confidence than this asks for a look.
export const NUMBER_SURE = 0.6;

// The catalog a copy in `language` can be saved against: its own, or, for
// Korean, the Japanese record (Korean sets reuse the Japanese set codes and
// numbering, DESIGN.md section 5).
export function catalogFits(language, catalog) {
	if (!language || !catalog) {
		return false;
	}

	return catalogFor(language) === catalog || (language === 'ko' && catalog === 'ja');
}

// The catalog languages to search for a card printed in `language`, in order
// (js/scan/match.js). Null or "non-latin" is a card whose Latin label row
// read nothing: a Japanese, Korean, or Chinese print, or a blurred Latin one.
export function searchOrder(language) {
	if (!language || language === 'non-latin') {
		return ['ja', 'en'];
	}

	if (language === 'ko') {
		return ['ko', 'ja'];
	}

	if (ASIAN_LANGUAGES.includes(language)) {
		return [language];
	}

	return language === 'en' ? ['en'] : [language, 'en'];
}

// ------------------------------------------------------------ the session

export function newSession(now = nowIso(), id = newId()) {
	return {created_at: now, id, items: [], lastSave: null, sheetShown: false, updated_at: now};
}

const touch = (session, now = nowIso()) => {
	session.updated_at = now;

	return session;
};

export const findItem = (session, id) => session.items.find((item) => item.id === id) || null;

function mustFind(session, id) {
	const item = findItem(session, id);

	if (!item) {
		throw new Error(`No tray card ${id}.`);
	}

	return item;
}

// A new capture lands in the tray at once, before it is read.
export function addCapture(session, {at = nowIso(), id = newId()} = {}) {
	const item = {
		candidates: [],
		captured_at: at,
		card: null,
		condition: null,
		conditionBy: null,
		confirmed: false,
		finishBy: null,
		id,
		language: null,
		languageBy: null,
		languageHint: null,
		names: [],
		partial: false,
		read: null,
		status: 'reading',
		sure: false,
		timings: {},
		variantId: null,
		variants: null,
		waitingFor: null,
		why: null,
	};

	session.items.push(item);
	touch(session, at);

	return item;
}

// What the read decided, kept small enough to store: the number, total,
// side, set code letters, copyright year, Wizards line, the language, and
// the name, HP, partial number, and attack text the name route uses, so a
// card looked up again later (signal back, language changed) uses every
// clue again.
export function summariseRead(read) {
	const number = read && read.number;
	const language = (read && read.language) || {code: null, confidence: 0, source: null};
	const name = read && read.name && read.name.text ? read.name : null;
	const hp = read && read.hp && read.hp.value ? read.hp : null;
	const partial = read && read.partial && (read.partial.number || read.partial.total) ? read.partial : null;

	return {
		attackText: read && read.attackText ? String(read.attackText).slice(0, 400) : '',
		copyrightYear: (read && read.copyrightYear) || null,
		hp: hp ? {after: Boolean(hp.after), confidence: hp.confidence || 0, value: hp.value, values: hp.values || [hp.value]} : null,
		language: {code: language.code || null, confidence: language.confidence || 0, source: language.source || null},
		name: name ? {confidence: name.confidence || 0, suffix: name.suffix || null, text: String(name.text).slice(0, 60)} : null,
		number: number
			? {
				confidence: number.confidence,
				number: number.number,
				numberPrinted: number.numberPrinted,
				setCodeRun: number.setCodeRun || '',
				side: number.side,
				total: number.total,
				totalPrinted: number.totalPrinted,
			}
			: null,
		partial: partial ? {number: partial.number || null, total: partial.total || null} : null,
		script: (read && read.script) || null,
		wizards: Boolean(read && read.wizards),
	};
}

// What was read, in words, for a card that needs a look: "Name: Weedle,
// HP: 50, number: unreadable". Null when nothing was read (a card added
// from the search).
export function readLine(read) {
	if (!read) {
		return null;
	}

	const parts = [`Name: ${read.name && read.name.text ? read.name.text : 'unreadable'}`];

	if (read.hp && read.hp.value) {
		parts.push(`HP: ${read.hp.value}`);
	}

	if (read.number) {
		parts.push(`number: ${read.number.numberPrinted}/${read.number.totalPrinted}`);
	}
	else if (read.partial && (read.partial.number || read.partial.total)) {
		parts.push(`number: ${read.partial.number || '?'}/${read.partial.total || '?'}`);
	}
	else {
		parts.push('number: unreadable');
	}

	return parts.join(', ');
}

// What the search box starts with for a card that needs a look: the
// species the read name matched (spelled right), else the name as read.
export function searchPrefill(item) {
	const best = item && item.names && item.names[0];

	if (best && best.score >= 0.75) {
		return best.name;
	}

	return (item && item.read && item.read.name && item.read.name.text) || '';
}

// The read is in: the item moves on to matching. The language is taken from
// the card only when the read is sure of it; otherwise nothing is
// preselected and languageHint orders the chips (Japanese, Korean, and
// Chinese first for "non-latin"). A language already set by hand or by Set
// for all is kept.
export function applyRead(session, id, read, now = nowIso()) {
	const item = mustFind(session, id);
	const summary = summariseRead(read);

	item.read = summary;
	item.status = 'matching';
	item.waitingFor = null;

	const {code, confidence} = summary.language;

	if (!item.languageBy) {
		if (code && code !== 'non-latin' && isScanLanguage(code) && confidence >= LANGUAGE_SURE) {
			item.language = code;
			item.languageBy = 'read';
			item.languageHint = code;
		}
		else {
			item.language = null;
			item.languageHint = code || null;
		}
	}

	touch(session, now);

	return item;
}

// OCR could not start (its files are not on the phone yet) or the catalog
// could not be reached: the card stays in the tray and resolves when online.
export function markWaiting(session, id, waitingFor, now = nowIso()) {
	const item = mustFind(session, id);

	item.status = 'waiting';
	item.waitingFor = waitingFor;
	touch(session, now);

	return item;
}

// The photo of a card still being read was lost (the app closed before it
// was kept): the card asks to be scanned again or found in the search.
export function markLost(session, id, now = nowIso()) {
	const item = mustFind(session, id);

	item.status = 'ready';
	item.waitingFor = null;
	item.card = null;
	item.sure = false;
	item.why = 'The photo was lost when the app closed. Scan the card again, or search for it.';
	touch(session, now);

	return item;
}

export function markMatching(session, id, now = nowIso()) {
	const item = mustFind(session, id);

	item.status = 'matching';
	item.waitingFor = null;
	touch(session, now);

	return item;
}

// Whether the match is sure enough to save without a look, and if not, why
// (DESIGN.md section 6, "Scan safety").
//
// With a number read, as before: an exact number and total, one card ahead
// by more than a point, a clear read, every set searched. Without one, the
// text clues must carry it: at least three agreeing (the name and two of
// the total, the HP, an attack, a partly read number), none against, and
// no card within a point. The artwork never counts here; it only orders.
export function judgeMatch(read, candidates, partial = false) {
	const number = read && read.number;
	const [top, second] = candidates;

	if (!number) {
		const name = read && read.name && read.name.text;

		if (!candidates.length) {
			return {sure: false, why: name ? `The number did not read, and no card was found for "${name}". Search for it.` : 'The collector number could not be read.'};
		}

		const agree = top.agree || [];
		const level = candidates.filter((c) => c.score >= top.score - 1).length;

		if (agree.includes('name') && agree.length >= 3 && !(top.conflicts || []).length && level === 1 && !partial) {
			return {sure: true, why: null};
		}

		if (level > 1) {
			return {sure: false, why: `The number did not read, and ${level} cards fit what did. Tap the right one.`};
		}

		return {sure: false, why: 'The number did not read, so this card is a best guess. Check it.'};
	}

	const printed = `${number.numberPrinted}/${number.totalPrinted}`;

	if (!candidates.length) {
		return {sure: false, why: `No card in the catalog has the number ${printed}.`};
	}

	const reasons = top.reasons || [];

	if (!reasons.includes('number and total')) {
		return {sure: false, why: `The number read as ${printed} matches no card exactly.`};
	}

	if (second && second.score >= top.score - 1) {
		return {sure: false, why: `${candidates.filter((c) => c.score >= top.score - 1).length} cards match ${printed}. Tap the right one.`};
	}

	if ((number.confidence || 0) < NUMBER_SURE) {
		return {sure: false, why: `The number ${printed} was hard to read.`};
	}

	if (partial) {
		return {sure: false, why: 'Some sets are not on this phone yet, so another card may match.'};
	}

	return {sure: true, why: null};
}

const cardOf = (candidate) => ({
	catalog: catalogFor(candidate.lang),
	id: candidate.id,
	image: candidate.image || null,
	lang: candidate.lang,
	localId: candidate.localId,
	name: candidate.name,
	official: candidate.official || null,
	releaseDate: candidate.releaseDate || null,
	setCode: candidate.setCode || null,
	setId: candidate.setId,
	setName: candidate.setName || null,
});

// The catalog answered. The best candidate is chosen and its finish waits
// for the card's variants (applyVariants). A candidate list that is empty
// leaves the item ready with no card: it needs a look (search or remove).
export function applyMatch(session, id, {candidates = [], names = [], partial = false} = {}, now = nowIso()) {
	const item = mustFind(session, id);
	const judged = judgeMatch(item.read, candidates, partial);

	item.candidates = candidates.slice(0, 6);
	item.names = (names || []).slice(0, 3);
	item.partial = partial;
	item.sure = judged.sure;
	item.why = judged.why;
	item.status = 'ready';
	item.waitingFor = null;
	setCard(item, candidates[0] || null);
	touch(session, now);

	return item;
}

// A card was chosen (by the match or by a tap): its finish starts over on
// the plain print once its variants are known.
function setCard(item, candidate) {
	item.card = candidate ? cardOf(candidate) : null;
	item.variants = null;
	item.variantId = null;
	item.finishBy = null;
}

// The chosen card's variants_detailed arrived: the picker starts on the
// plain print, every time.
export function applyVariants(session, id, cardId, variants, now = nowIso()) {
	const item = mustFind(session, id);

	if (!item.card || item.card.id !== cardId) {
		return item;
	}

	item.variants = Array.isArray(variants) ? variants : [];
	item.variantId = plainVariantId(item.variants);
	item.finishBy = 'plain';
	item.status = 'ready';
	item.waitingFor = null;
	touch(session, now);

	return item;
}

// "This is the card", or one of the other candidates, or a search result: a
// tap that clears the low-confidence flag.
export function chooseCard(session, id, candidate, now = nowIso()) {
	const item = mustFind(session, id);

	if (candidate) {
		const same = item.card && item.card.id === candidate.id && item.card.catalog === catalogFor(candidate.lang);

		if (!same) {
			setCard(item, candidate);
		}

		if (!item.candidates.some((c) => c.id === candidate.id && c.lang === candidate.lang)) {
			item.candidates = [candidate, ...item.candidates].slice(0, 6);
		}
	}

	item.confirmed = true;
	item.status = 'ready';
	item.waitingFor = null;
	touch(session, now);

	return item;
}

// Sets one card's language. Returns true when the chosen card's catalog does
// not hold prints in that language, so the card must be looked up again
// (a Japanese match changed to English, say).
export function setLanguage(session, id, code, by = 'hand', now = nowIso()) {
	const item = mustFind(session, id);

	if (!isScanLanguage(code)) {
		throw new Error(`Unknown language ${code}.`);
	}

	item.language = code;
	item.languageBy = by;
	touch(session, now);

	return needsRematch(item);
}

export const needsRematch = (item) => Boolean(item.card && item.language && !catalogFits(item.language, item.card.catalog));

export function setFinish(session, id, variantId, by = 'hand', now = nowIso()) {
	const item = mustFind(session, id);

	if (!findVariant(item.variants, variantId)) {
		throw new Error(`The card has no printing ${variantId}.`);
	}

	item.variantId = variantId;
	item.finishBy = by;
	touch(session, now);

	return item;
}

export function setCondition(session, id, condition, by = 'hand', now = nowIso()) {
	const item = mustFind(session, id);

	if (condition !== null && !CONDITIONS.includes(condition)) {
		throw new Error(`Unknown condition ${condition}.`);
	}

	item.condition = condition;
	item.conditionBy = condition === null ? null : by;
	touch(session, now);

	return item;
}

export function removeItem(session, id, now = nowIso()) {
	const index = session.items.findIndex((item) => item.id === id);

	if (index < 0) {
		return null;
	}

	const [item] = session.items.splice(index, 1);

	touch(session, now);

	return item;
}

// ------------------------------------------------------------ what each card needs

// Why a card cannot be saved yet, or null when it can: reading, matching,
// waiting (for signal), unmatched, unsure, language, rematch, finishes.
export function blocker(item) {
	if (item.status === 'reading') {
		return 'reading';
	}

	if (item.status === 'matching') {
		return 'matching';
	}

	if (item.status === 'waiting') {
		return 'waiting';
	}

	if (!item.card) {
		return 'unmatched';
	}

	if (!item.sure && !item.confirmed) {
		return 'unsure';
	}

	if (!item.language) {
		return 'language';
	}

	if (needsRematch(item)) {
		return 'rematch';
	}

	if (item.variants === null) {
		return 'finishes';
	}

	return null;
}

// A card a person has to look at: everything but the ones still being
// worked on or waiting for signal.
const LOOK = new Set(['unmatched', 'unsure', 'language']);

export const needsLook = (item) => LOOK.has(blocker(item));

export const isSavable = (item) => blocker(item) === null;

// The plain-language reason a card needs a look, for its sheet.
export function lookReason(item) {
	switch (blocker(item)) {
		case 'unmatched':
			return item.why || 'No card was found. Search for it, or remove it.';
		case 'unsure':
			return item.why || 'Not sure this is the card. Tap the right one.';
		case 'language':
			return 'Not sure of the language. Pick the one printed on the card.';
		default:
			return null;
	}
}

// ------------------------------------------------------------ duplicates

const cardKey = (catalog, cardId) => `${catalog}|${cardId}`;

// The person's live card entries by card: Map "<catalog>|<card id>" ->
// {total, byLanguage: Map lang -> count, entries}.
export function ownedIndex(entries) {
	const owned = new Map();

	for (const entry of entries || []) {
		if (!entry || entry.deleted_at || !entry.card_id) {
			continue;
		}

		const key = cardKey(entry.catalog || 'international', entry.card_id);

		if (!owned.has(key)) {
			owned.set(key, {byLanguage: new Map(), entries: [], total: 0});
		}

		const item = owned.get(key);

		item.total++;
		item.entries.push(entry);
		item.byLanguage.set(entry.language, (item.byLanguage.get(entry.language) || 0) + 1);
	}

	return owned;
}

export function ownedFor(item, owned) {
	if (!item.card) {
		return {inLanguage: 0, total: 0, entries: []};
	}

	const found = owned && owned.get(cardKey(item.card.catalog, item.card.id));

	if (!found) {
		return {inLanguage: 0, total: 0, entries: []};
	}

	return {entries: found.entries, inLanguage: item.language ? found.byLanguage.get(item.language) || 0 : 0, total: found.total};
}

const sameCopy = (a, b) => a.card && b.card && a.card.id === b.card.id && a.card.catalog === b.card.catalog && a.language === b.language;

// How many copies of this card, in this language, there will be once the
// session is saved: the ones owned plus the ones in the tray. A tile badges
// it from 2 up (never ×1).
export function quantity(session, item, owned) {
	if (!item.card) {
		return 1;
	}

	const inTray = session.items.filter((other) => sameCopy(other, item)).length;

	return ownedFor(item, owned).inLanguage + inTray;
}

// Why the badge is there: "owned" when the person already has one in that
// language, "twice" when the session holds it more than once.
export function duplicateKind(session, item, owned) {
	if (!item.card) {
		return null;
	}

	if (ownedFor(item, owned).inLanguage) {
		return 'owned';
	}

	return session.items.filter((other) => sameCopy(other, item)).length > 1 ? 'twice' : null;
}

// ------------------------------------------------------------ wishlist marks

// Which family members want this card, from their wishlists kept on the
// phone: [{name, userId, unconfirmed}]. The names come from the data as
// wishlist.familyWishlists() returns it, never made up.
export function wishMarks(item, family) {
	if (!item.card) {
		return [];
	}

	const rows = wishedBy(item.card.id, {catalog: item.card.catalog, language: item.language, variantId: item.variantId}, family);
	const seen = new Map();

	for (const row of rows) {
		if (!seen.has(row.userId || row.name)) {
			seen.set(row.userId || row.name, {name: row.name, unconfirmed: row.unconfirmed, userId: row.userId});
		}
	}

	return [...seen.values()];
}

// "Member A wants this", "Member A and Member B want this", "Member A, Member B, and Member C want this".
export function wishLine(marks) {
	const names = marks.map((mark) => mark.name);

	if (!names.length) {
		return null;
	}

	const list = names.length === 1
		? names[0]
		: names.length === 2
			? `${names[0]} and ${names[1]}`
			: `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;

	return `${list} ${names.length === 1 ? 'wants' : 'want'} this`;
}

// ------------------------------------------------------------ Set for all

// The finishes Set for all can offer: every finish some tray card has, by
// finishKey, with a label and how many cards have it.
export function sessionFinishes(session) {
	const found = new Map();

	for (const item of session.items) {
		for (const option of finishOptions(item.variants)) {
			const entry = found.get(option.key) || {count: 0, key: option.key, label: option.label};

			entry.count++;
			found.set(option.key, entry);
		}
	}

	return [...found.values()];
}

function plannedChange(item, field, value) {
	if (field === 'language') {
		return item.language === value ? null : {by: item.languageBy};
	}

	if (field === 'condition') {
		return item.condition === value ? null : {by: item.conditionBy};
	}

	if (field === 'finish') {
		if (!item.variants) {
			return {skip: true};
		}

		const option = finishOptions(item.variants).find((entry) => entry.key === value);

		if (!option) {
			return {skip: true};
		}

		return option.variantId === item.variantId ? null : {by: item.finishBy, variantId: option.variantId};
	}

	throw new Error(`Set for all sets language, finish, or condition, not ${field}.`);
}

// What Set for all would do: {total, changes, hand, skipped}. hand counts
// the cards among the changes that were set by hand; skipped, for a finish,
// the cards with no such printing (or no card yet).
export function setForAllPreview(session, field, value) {
	const out = {changes: 0, hand: 0, skipped: 0, total: session.items.length};

	for (const item of session.items) {
		const change = plannedChange(item, field, value);

		if (!change) {
			continue;
		}

		if (change.skip) {
			out.skipped++;
			continue;
		}

		out.changes++;

		if (change.by === 'hand') {
			out.hand++;
		}
	}

	return out;
}

// Applies Set for all. keepHand leaves the cards set by hand alone. Returns
// {changed: [ids], rematch: [ids]}: rematch lists the cards whose new
// language lives in another catalog, so they must be looked up again.
export function setForAll(session, field, value, {keepHand = false} = {}, now = nowIso()) {
	const changed = [];
	const rematch = [];

	for (const item of session.items) {
		const change = plannedChange(item, field, value);

		if (!change || change.skip || (keepHand && change.by === 'hand')) {
			continue;
		}

		if (field === 'language') {
			if (setLanguage(session, item.id, value, 'all', now)) {
				rematch.push(item.id);
			}
		}
		else if (field === 'condition') {
			setCondition(session, item.id, value, 'all', now);
		}
		else {
			setFinish(session, item.id, change.variantId, 'all', now);
		}

		changed.push(item.id);
	}

	touch(session, now);

	return {changed, rematch};
}

// ------------------------------------------------------------ Done

// The Done sheet's numbers: {total, savable, look, waiting, busy, owned,
// byLanguage: [[lang, n]]}. byLanguage counts every card whose language is
// set; owned counts the savable cards already owned in their language.
export function doneSummary(session, owned) {
	const out = {busy: 0, byLanguage: [], look: 0, owned: 0, savable: 0, total: session.items.length, waiting: 0};
	const languages = new Map();

	for (const item of session.items) {
		const reason = blocker(item);

		if (item.language) {
			languages.set(item.language, (languages.get(item.language) || 0) + 1);
		}

		if (reason === null) {
			out.savable++;

			if (ownedFor(item, owned).inLanguage) {
				out.owned++;
			}
		}
		else if (reason === 'waiting') {
			out.waiting++;
		}
		else if (LOOK.has(reason)) {
			out.look++;
		}
		else {
			out.busy++;
		}
	}

	out.byLanguage = [...languages.entries()].sort((a, b) => b[1] - a[1]);

	return out;
}

// Done is blocked while a card needs a look or is still being read.
export const canSave = (summary) => summary.look === 0 && summary.busy === 0 && summary.savable > 0;

// The card entries to save, one per physical card (DESIGN.md section 3,
// "One physical card, one entry"): [{itemId, fields}]. skipOwned leaves out
// the cards already owned in their language ("Skip" on the Done sheet).
export function entriesToSave(session, owned, {skipOwned = false} = {}) {
	const out = [];

	for (const item of session.items) {
		if (!isSavable(item)) {
			continue;
		}

		if (skipOwned && ownedFor(item, owned).inLanguage) {
			continue;
		}

		const fields = {
			card_id: item.card.id,
			catalog: item.card.catalog,
			language: item.language,
			language_source: 'scan',
			variant_id: item.variantId || null,
		};

		if (item.card.catalog !== catalogFor(item.language)) {
			fields.fallback = true;
		}

		if (item.condition) {
			fields.condition = item.condition;
		}

		out.push({fields, itemId: item.id});
	}

	return out;
}

// After a save: the saved cards leave the tray, and Undo session remembers
// exactly the entries that were written.
export function afterSave(session, saved, now = nowIso()) {
	const ids = new Set(saved.map((row) => row.itemId));

	session.items = session.items.filter((item) => !ids.has(item.id));
	session.lastSave = {at: now, entryIds: saved.map((row) => row.entryId), count: saved.length};
	session.sheetShown = session.items.length > 0 && session.sheetShown;
	touch(session, now);

	return session.lastSave;
}

// Undo session: the entry IDs to delete, and the session forgets them.
export function takeUndo(session, now = nowIso()) {
	const last = session.lastSave;

	session.lastSave = null;
	touch(session, now);

	return last ? last.entryIds : [];
}

// The languages a tile's chips offer, in the order to show them: the read's
// guess first when it was not sure, Japanese, Korean, and Chinese first for
// a card that read no Latin label, otherwise (a card added from the search)
// the fixed order. An order, never a preselection.
export function languageChoices(item) {
	const hint = item.languageHint;
	let order = [...SCAN_LANGUAGES];

	if (hint === 'non-latin') {
		order = [...ASIAN_LANGUAGES, ...SCAN_LANGUAGES.filter((code) => !ASIAN_LANGUAGES.includes(code))];
	}
	else if (isScanLanguage(hint)) {
		order = [hint, ...SCAN_LANGUAGES.filter((code) => code !== hint)];
	}

	return order;
}

// The finish chip for the item's current pick, or null on the plain print.
export function itemFinishChip(item) {
	const option = finishOptions(item.variants).find((entry) => entry.variantId === item.variantId);

	return option ? option.chip : null;
}

