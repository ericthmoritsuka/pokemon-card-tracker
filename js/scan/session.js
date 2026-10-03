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

// A name read that matched a species this well (js/scan/match.js looks
// cards up by it from here) names that Pokémon clearly enough to stop a
// number match for another card from counting as sure.
export const NAME_CLEAR = 0.75;

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
		readSetName: null,
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
// from the search). setName: the set's name the name strip read instead of
// a name (js/scan/match.js), said as such.
export function readLine(read, {setName = null} = {}) {
	if (!read) {
		return null;
	}

	const parts = [setName
		? `Name: unreadable ("${setName}" is a set's name)`
		: `Name: ${read.name && read.name.text ? read.name.text : 'unreadable'}`];

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
// species the read name matched (spelled right), else the name as read,
// unless it was a set's name (item.readSetName).
export function searchPrefill(item) {
	const best = item && item.names && item.names[0];

	if (best && best.score >= 0.75) {
		return best.name;
	}

	if (item && item.readSetName) {
		return '';
	}

	return (item && item.read && item.read.name && item.read.name.text) || '';
}

// The read is in: the item moves on to matching. The language is taken from
// the card only when the read is sure of it; otherwise nothing is
// preselected and languageHint orders the chips after Portuguese and
// English (Japanese, Korean, and Chinese next for "non-latin"). A language
// already set by hand or by Set for all is kept.
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
// by more than a point, a clear read, every set searched; and now nothing
// read against it: no conflicting clue (an HP that differs), and no name
// read that clearly names another Pokémon (`names`, the species the read
// name matched, js/scan/match.js), since one misread digit turns a card
// into its neighbour in the same set. Without a number, the text clues must
// carry it: at least three agreeing (the name and two of the total, the
// HP, an attack, a partly read number), none against, and no card within a
// point. The artwork never counts here; it only orders.
export function judgeMatch(read, candidates, partial = false, names = []) {
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
		return {
			sure: false,
			why: candidates.some((c) => (c.reasons || []).includes('number and total'))
				? `The number reads ${printed}, but the other clues point to another card. Tap the right one.`
				: `The number read as ${printed} matches no card exactly.`,
		};
	}

	const named = names && names[0] && names[0].score >= NAME_CLEAR ? names[0].name : null;

	if (named && !(top.agree || []).includes('name')) {
		return {sure: false, why: `The number reads ${printed}, but the name reads as ${named}. Tap the right card.`};
	}

	if ((top.conflicts || []).length) {
		return {sure: false, why: `The number reads ${printed}, but the ${top.conflicts.includes('hp') ? 'HP' : top.conflicts[0]} does not fit. Check it.`};
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

// Whether the best candidate is worth showing as the card before anyone
// taps it, as a guess to confirm: at least two identity clues agree with it
// (number and total, or the name and the HP, say), none is against it (nor
// a name read that clearly names another Pokémon: `names`, as judgeMatch),
// and no other card is within a point. Anything less (one clue, a tie, a
// misread number that fits no card exactly) is a list to pick from, never a
// card that looks like the answer.
export function isLead(candidates, names = []) {
	const [top, second] = candidates || [];
	const named = names && names[0] && names[0].score >= NAME_CLEAR;

	return Boolean(top) && (top.agree || []).length >= 2 && !(top.conflicts || []).length && !(named && !(top.agree || []).includes('name')) && !(second && second.score >= top.score - 1);
}

// The catalog answered. The best candidate is chosen when the match is sure
// or a lead (isLead), and its finish waits for the card's variants
// (applyVariants). Otherwise the item is ready with no card: its sheet
// offers the candidates to pick from and a search filled in with what was
// read. An empty candidate list leaves only the search.
//
// setName: the set's name the name strip read (js/scan/match.js), judged as
// no name at all.
export function applyMatch(session, id, {candidates = [], names = [], partial = false, setName = null} = {}, now = nowIso()) {
	const item = mustFind(session, id);
	const read = setName && item.read ? {...item.read, name: null} : item.read;
	const judged = judgeMatch(read, candidates, partial, names);

	item.candidates = candidates.slice(0, 6);
	item.names = (names || []).slice(0, 3);
	item.readSetName = setName || null;
	item.partial = partial;
	item.sure = judged.sure;
	item.why = judged.why;
	item.status = 'ready';
	item.waitingFor = null;
	setCard(item, candidates.length && (judged.sure || isLead(candidates, names)) ? candidates[0] : null);
	touch(session, now);

	return item;
}

// The picture match is in (js/scan/picture.js pictureMatch): the card it
// settled, or the candidates to tap (the top five artwork groups, as
// pictures). A picture and a number that disagree leave the card shown but
// unsure, so it needs a look. A Japanese or Chinese record hints at an
// Asian print without choosing which (a Korean print shares the Japanese
// art). hand: the add-by-hand prefill, when the number names a set the
// catalog has not got yet.
export function applyPicture(session, id, found, now = nowIso()) {
	const item = mustFind(session, id);

	item.candidates = (found.candidates || []).slice(0, 8);
	item.names = [];
	item.readSetName = null;
	item.partial = false;
	item.sure = Boolean(found.sure && found.card);
	item.why = found.why || null;
	item.disagree = Boolean(found.disagree);
	item.hand = found.hand || null;
	item.status = 'ready';
	item.waitingFor = null;
	setCard(item, found.card || null);

	if (!item.languageBy && !item.language && found.card && ['ja', 'zh-tw', 'zh-cn'].includes(found.card.lang)) {
		item.languageHint = 'non-latin';
	}

	touch(session, now);

	return item;
}

// A card whose set the catalog has not got yet, added by hand from its set
// code and number (the read's prefill, item.hand). It is saved against the
// record the set will have, `<set>-<number>`, in the catalog its language
// is saved in (Korean against the Japanese one, DESIGN.md section 5), with
// no finish to pick.
export function addByHand(session, id, {setId, number, language}, now = nowIso()) {
	const item = mustFind(session, id);
	const setCode = String(setId || '').trim();
	const localId = String(number || '').trim();

	if (!setCode || !localId || !language) {
		throw new Error('A set code, a number, and a language are needed.');
	}

	const lang = language === 'ko' ? 'ja' : catalogFor(language) === 'international' ? 'en' : language;

	setCard(item, {id: `${setCode}-${localId}`, image: null, lang, localId, name: `${setCode} ${localId}`, official: item.hand && item.hand.total ? String(Number(item.hand.total)) : null, setId: setCode, setName: setCode});
	item.card.byHand = true;
	item.language = language;
	item.languageBy = 'hand';
	item.variants = [];
	item.variantId = null;
	item.finishBy = 'plain';
	item.confirmed = true;
	item.status = 'ready';
	item.waitingFor = null;
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

	// No card chosen: unsure while there are candidates to pick from,
	// unmatched when there are none.
	if (!item.card) {
		return item.candidates && item.candidates.length ? 'unsure' : 'unmatched';
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

// The languages a tile's chips offer, in the order to show them: Portuguese
// and English always first (the owner collects in Brazil, so those are most
// of the cards he holds; Q-21 in plans/audit-qa.md), then the read's guess
// when it is neither (Japanese, Korean, and Chinese for a card that read no
// Latin label), then the rest in the fixed order. An order, never a
// preselection.
export const LEADING_LANGUAGES = ['pt', 'en'];

export function languageChoices(item) {
	const hint = item.languageHint;
	const guessed = hint === 'non-latin' ? ASIAN_LANGUAGES : isScanLanguage(hint) ? [hint] : [];
	const order = [...LEADING_LANGUAGES, ...guessed, ...SCAN_LANGUAGES];

	return order.filter((code, index) => order.indexOf(code) === index);
}

// The finish chip for the item's current pick, or null on the plain print.
export function itemFinishChip(item) {
	const option = finishOptions(item.variants).find((entry) => entry.variantId === item.variantId);

	return option ? option.chip : null;
}


// ------------------------------------------------------------ the scan report

// The scan report: everything a read and a lookup did, as plain text the
// owner can copy on the phone and paste to us (no images). reportOfRead and
// reportOfMatch keep the facts on the tray card (item.report), small enough
// to store with the draft, so a report still shows after the app closes;
// reportText words them.

// The OCR reads, in the order the report lists them, with their names.
export const REPORT_FIELDS = [
	['name', 'Name strip'],
	['hp', 'HP'],
	['numberLeft', 'Number, bottom left'],
	['numberRight', 'Number, bottom right'],
	['setCode', 'Set code box'],
	['label', 'Weakness row (language)'],
	['attacks', 'Attack names'],
];

// How many candidates the report lists.
export const REPORT_CANDIDATES = 5;

// The mean confidence (0 to 100) of the words OCR found, or null.
function wordConfidence(result) {
	const words = (result.lines || []).flatMap((line) => line.words || []);

	if (!words.length) {
		return typeof result.confidence === 'number' && result.confidence > 0 ? result.confidence : null;
	}

	return Math.round(words.reduce((sum, word) => sum + (word.confidence || 0), 0) / words.length);
}

// What the read left for the report: result is js/scan/identify.js's
// answer. captureMs: how long the capture took; source: 'camera' or
// 'photo'; frame: the image's size, "width x height"; geometry: where the
// guide and the capture were (js/scan/view.js geometryReport: the camera's
// frame, the stage, the guide on the screen, the guide and the capture in
// the frame, and how the capture was taken), or null.
export function reportOfRead(result, {captureMs = null, frame = null, geometry = null, source = 'camera'} = {}) {
	const read = result.read || {};
	const raw = read.raw || {};
	const timings = read.timings || {};
	const fields = {};

	for (const [key] of REPORT_FIELDS) {
		if (raw[key]) {
			fields[key] = {confidence: wordConfidence(raw[key]), ms: timings[key] ?? null, text: String(raw[key].text || '').trim().slice(0, 300)};
		}
	}

	const number = read.number || null;
	const box = read.setCodeBox || {};

	return {
		artworkMs: result.timings && result.timings.artwork != null ? result.timings.artwork : null,
		attackText: read.attackText ? String(read.attackText).slice(0, 200) : '',
		captureMs,
		copyrightYear: read.copyrightYear || null,
		fields,
		frame,
		geometry: geometry || null,
		hp: read.hp && read.hp.value ? {after: Boolean(read.hp.after), value: read.hp.value} : null,
		label: read.label ? {code: read.label.code || null, confidence: read.label.confidence || 0} : null,
		language: read.language ? {code: read.language.code || null, confidence: read.language.confidence || 0, source: read.language.source || null} : null,
		name: read.name && read.name.text ? {confidence: read.name.confidence || 0, suffix: read.name.suffix || null, text: String(read.name.text).slice(0, 60)} : null,
		number: number
			? {
				confidence: number.confidence || 0,
				printed: `${number.numberPrinted}/${number.totalPrinted}`,
				// A number past the set's total: a secret rare (a special
				// illustration, a gold card), numbered after the set proper.
				secret: Number(number.number) > Number(number.total),
				side: number.side || null,
			}
			: null,
		ocr: result.ocr !== undefined ? Boolean(result.ocr) : true,
		ocrMs: result.timings ? result.timings.ocr : null,
		// The picture match: the five best artwork groups with their
		// distances, the lead of the first over the second, the crop the
		// fingerprint chose, and how long it took.
		picture: result.picture
			? {
				fingerprintMs: result.timings ? result.timings.fingerprint ?? null : null,
				before: result.picture.before ?? null,
				gap: result.picture.gap,
				groups: result.picture.groups.slice(0, 5).map((group) => ({cards: group.cards.slice(0, 4).map((c) => c.id), score: group.score})),
				how: result.picture.how || null,
				matchMs: result.timings ? result.timings.match ?? null : null,
				variants: result.picture.variants || [],
			}
			: null,
		partial: read.partial && (read.partial.number || read.partial.total) ? `${read.partial.number || '?'}/${read.partial.total || '?'}` : null,
		rectify: {
			angle: result.angle ?? null,
			card: result.card ? `${result.card.width}x${result.card.height}` : null,
			found: Boolean(result.found),
			guessed: result.guessed || null,
			ms: result.timings ? result.timings.rectify : null,
			note: result.note || null,
			ratio: typeof result.ratio === 'number' ? result.ratio : null,
		},
		setCodeBox: box.text ? {langCode: box.langCode || null, setCode: box.setCode || null, text: String(box.text).trim().slice(0, 60)} : null,
		source,
		totalMs: result.timings ? result.timings.total : null,
		wizards: Boolean(read.wizards),
		workers: result.timings ? result.timings.workers ?? null : null,
	};
}

// What the lookup left for the report: found is js/scan/match.js
// findCandidates's answer, ms how long it took, language what was searched
// for.
export function reportOfMatch(found, {language = null, ms = null} = {}) {
	return {
		artwork: found.artwork || null,
		candidates: (found.candidates || []).slice(0, REPORT_CANDIDATES).map((c) => ({
			agree: c.agree || [],
			artwork: typeof c.artwork === 'number' ? Math.round(c.artwork * 100) / 100 : null,
			confidence: c.confidence ?? null,
			conflicts: c.conflicts || [],
			id: c.id,
			lang: c.lang || null,
			name: c.name,
			number: `${c.localId}${c.official ? `/${c.official}` : ''}`,
			reasons: c.reasons || [],
			score: typeof c.score === 'number' ? Math.round(c.score * 100) / 100 : c.score,
			setName: c.setName || c.setId || null,
		})),
		count: (found.candidates || []).length,
		language,
		ms,
		names: (found.names || []).slice(0, 3).map((n) => ({name: n.name, score: Math.round((n.score || 0) * 100) / 100})),
		partial: Boolean(found.partial),
		routes: found.routes || [],
		searched: (found.searched || []).slice(0, 12),
		setName: found.setName || null,
	};
}

// The script the label row suggests, in words: a Latin label read names the
// language; none read means a Japanese, Korean, or Chinese print is
// suspected (the reader has only the English model, so it cannot tell those
// apart), or the row was blurred or covered.
export function scriptLine(report) {
	const language = report && report.language;
	const code = language && language.code;

	if (code && code !== 'non-latin') {
		return `Latin script. Language guess: ${code} (${Math.round((language.confidence || 0) * 100)} %, from ${language.source || 'the label row'}).`;
	}

	return 'No Latin weakness row was read: Japanese, Korean, or Chinese text is suspected (or the row was blurred or covered). This reader has no Japanese or Korean model, so it cannot tell which; pick the language by hand.';
}

const ms = (value) => (typeof value === 'number' ? `${value} ms` : 'not timed');
const pct = (value) => (typeof value === 'number' ? `${Math.round(value <= 1 ? value * 100 : value)} %` : '?');
const oneLine = (text) => String(text || '').replace(/\s*\n\s*/g, ' | ').trim();

// The report as text. device: {userAgent, cores, memory, screen, camera,
// online, version}; at: when it was made (ISO time).
export function reportText(item, {at = nowIso(), device = {}} = {}) {
	const report = (item && item.report) || {};
	const lines = [`Card Tracker scan report, ${at}`];

	lines.push('', 'Device');
	lines.push(`- Browser: ${device.userAgent || 'unknown'}`);
	lines.push(`- CPU cores: ${device.cores || 'unknown'}; memory: ${device.memory ? `${device.memory} GB` : 'not reported'}; screen: ${device.screen || 'unknown'}`);

	if (device.camera) {
		lines.push(`- Camera: ${device.camera}`);
	}

	lines.push(`- Online: ${device.online === false ? 'no' : 'yes'}${device.version ? `; app ${device.version}` : ''}; OCR workers: ${report.workers ?? '?'}`);

	lines.push('', 'Steps');
	lines.push(`- Source: ${report.source === 'photo' ? 'a photo picked from the gallery' : 'the camera'}${report.frame ? `, ${report.frame}` : ''}`);
	lines.push(`- Capture: ${ms(report.captureMs)}${report.geometry && report.geometry.how ? ` (${report.geometry.how === 'auto' ? 'taken automatically' : 'shutter'})` : ''}`);

	if (report.geometry) {
		const g = report.geometry;

		lines.push(`- Guide: ${g.screen} on a ${g.stage} screen area; in the ${g.frame} frame, guide ${g.guide}, captured ${g.capture}`);
	}

	if (report.rectify) {
		lines.push(`- Edges and straightening: ${ms(report.rectify.ms)}; ${report.rectify.found ? 'card edges found' : 'card edges NOT found'}${typeof report.rectify.angle === 'number' ? `, turned ${report.rectify.angle} degrees` : ''}${report.rectify.card ? `, card ${report.rectify.card} px` : ''}. ${report.rectify.note || ''}`.trim());
	}

	if (report.rectify && report.rectify.found) {
		const guessed = report.rectify.guessed;

		lines.push(`- Edges: ${guessed === 'top' ? 'left, right, and bottom found; top GUESSED (worked out from the width)' : guessed === 'bottom' ? 'all four found, but the box was too tall; snapped up from the bottom, which may be the wrong edge' : 'all four found'}`);
	}

	if (report.rectify && typeof report.rectify.ratio === 'number') {
		lines.push(`- Crop shape: the edges made a box ${report.rectify.ratio} wide for its height (a card is 0.716); the crop was snapped to a card's shape${report.picture && report.picture.how ? `, ${report.picture.how}` : ''}`);
	}

	if (report.picture) {
		lines.push(`- Picture match: fingerprint ${ms(report.picture.fingerprintMs)}, match ${ms(report.picture.matchMs)}; lead over the second ${report.picture.gap ?? 'none (one group)'}`);

		if ((report.picture.variants || []).length) {
			lines.push(`- Crops tried for the guessed edge: ${report.picture.variants.join(', ')}; ${report.picture.before !== null ? `${report.picture.how} won (the crop as found was ${report.picture.before} away)` : 'none beat the crop as found'}`);
		}

		for (const [index, group] of report.picture.groups.entries()) {
			lines.push(`  ${index + 1}. ${group.cards.join(', ')}: distance ${group.score}`);
		}
	}
	else if (report.ocr !== false) {
		lines.push('- Picture match: not done (the picture index was not on this phone); read in full');
	}

	lines.push(report.ocr === false ? '- OCR: not run (the picture was enough)' : `- OCR, all reads: ${ms(report.ocrMs)} (reads run side by side, so their times overlap)`);

	for (const [key, title] of REPORT_FIELDS) {
		const field = report.fields && report.fields[key];

		if (field) {
			lines.push(`  - ${title}: ${ms(field.ms)}, confidence ${field.confidence ?? '?'}: "${oneLine(field.text) || '(nothing)'}"`);
		}
	}

	lines.push(`- Artwork fingerprint: ${ms(report.artworkMs)}`);

	const match = report.match;

	if (match) {
		lines.push(`- Catalog lookup: ${ms(match.ms)}; routes ${match.routes.length ? match.routes.join(', ') : 'none'}; searched for ${match.language || 'an unknown language'}${match.partial ? '; some sets were out of reach' : ''}`);
		lines.push(`- Artwork tiebreak: ${match.candidates.some((c) => c.artwork !== null) ? 'compared the level cards' : 'not needed or not possible'}`);
	}
	else {
		lines.push('- Catalog lookup: not done yet');
	}

	lines.push(`- Total from capture to read: ${ms(report.totalMs)}`);

	lines.push('', 'What was read');
	lines.push(`- Name: ${report.name ? `"${report.name.text}" (${pct(report.name.confidence)})${report.name.suffix ? `, suffix ${report.name.suffix}` : ''}` : 'unreadable'}`);
	lines.push(`- HP: ${report.hp ? `${report.hp.value}${report.hp.after ? ' (printed after the number, an old card)' : ''}` : 'unreadable'}`);

	if (report.number) {
		lines.push(`- Number: ${report.number.printed} (${pct(report.number.confidence)}, ${report.number.side || '?'} side)${report.number.secret ? '; past the set total: a secret rare' : ''}`);
	}
	else {
		lines.push(`- Number: unreadable${report.partial ? `; partly read as ${report.partial}` : ''}`);
	}

	if (report.setCodeBox) {
		lines.push(`- Set code box: "${report.setCodeBox.text}"${report.setCodeBox.setCode ? `, set ${report.setCodeBox.setCode}` : ''}${report.setCodeBox.langCode ? `, language ${report.setCodeBox.langCode}` : ''}`);
	}

	lines.push(`- Copyright year: ${report.copyrightYear || 'unread'}${report.wizards ? '; Wizards of the Coast' : ''}`);

	if (report.attackText) {
		lines.push(`- Attack names: "${oneLine(report.attackText)}"`);
	}

	lines.push(`- Language: ${report.language ? `${report.language.code || 'none'} (${pct(report.language.confidence)}, ${report.language.source || '?'})` : 'unknown'}`);
	lines.push(`- Script: ${scriptLine(report)}`);

	if (match) {
		if (match.setName) {
			lines.push(`- The name strip read a set's name ("${match.setName}"), so it was not used as a name.`);
		}

		lines.push(`- Species the name matched: ${match.names.length ? match.names.map((n) => `${n.name} (${n.score})`).join(', ') : 'none'}`);

		lines.push('', `Candidates (${match.count} found, first ${Math.min(match.count, REPORT_CANDIDATES)} shown)`);

		if (!match.candidates.length) {
			lines.push('- none');
		}

		for (const [index, c] of match.candidates.entries()) {
			lines.push(`${index + 1}. ${c.name}, ${c.number}, ${c.setName} (${c.id}, ${c.lang || '?'}): score ${c.score}${c.confidence !== null ? `, confidence ${pct(c.confidence)}` : ''}${c.artwork !== null ? `, artwork ${c.artwork}` : ''}`);
			lines.push(`   why: ${c.reasons.join('; ') || 'nothing'}${c.agree.length ? `; agrees: ${c.agree.join(', ')}` : ''}${c.conflicts.length ? `; against: ${c.conflicts.join(', ')}` : ''}`);
		}
	}

	lines.push('', 'Result');

	if (item && item.card) {
		lines.push(`- Shown: ${item.card.name}, ${item.card.localId}${item.card.official ? `/${item.card.official}` : ''}, ${item.card.setName || item.card.setId} (${item.card.id})`);
	}
	else {
		lines.push('- Shown: no card');
	}

	lines.push(`- ${item && item.sure ? 'Sure match' : `Not sure${item && item.why ? `: ${item.why}` : ''}`}`);

	return lines.join('\n');
}
