// Recognising a card by its picture first (DESIGN.md section 6, Eric,
// 2026-10-03): the straightened card is fingerprinted (js/vision/
// fingerprint.js) and matched against the packed index of every catalog
// image (js/vision/index.bin, js/vision/matcher.js), which answers with the
// five best artwork groups. Text is read only when the picture cannot
// settle it (identify.js), and this module turns the groups, plus whatever
// number was read, into the tray's candidates and a verdict.
//
// - The first group leads the second by AUTO_GAP or more and holds one
//   card: that is the card, no text needed.
// - It leads but holds several cards (reprints, a Japanese print and its
//   English twin): the collector number and total choose inside it.
// - The lead is small: the top five are shown as pictures to tap, and a
//   number read that names one of them promotes it.
// - The picture and a number read disagree: the card needs a look, never a
//   silent save.
//
// The index is loaded once, on first use, and kept in memory (about 1.4
// MB; the service worker keeps the file).

import {importApi} from '../catalog.js';
import {confusedVariants, sameNumber} from '../../lab/js/match.js';
import {queryFingerprints} from '../vision/fingerprint.js';
import {AUTO_GAP, loadIndex, matchFingerprints} from '../vision/matcher.js';

export {AUTO_GAP};

// How close the first group must be for the picture to count at all, and
// for it to settle the card alone. Measured on real captures (Eric's
// phone, version 24, 2026-10-03): the right card was 29.2 and 31.6 away
// when the crop was right, and 68.4 to 76.1 away when an edge was wrong,
// with leads of 0.1 to 3.5, and once (me04-007, distance 68.5) still first.
// On the benchmark (240 simulated captures) the right card's distance is
// 9.8 at the median, 29.8 at the 90th percentile, and 37.9 at the 95th;
// the three wrong first places were 66.9 to 78.3 away. So:
//
// - SURE_DISTANCE: at or under 45, a lead of AUTO_GAP settles a one-card
//   group with no text. Between 45 and 60 the picture is probably right
//   (four benchmark glare reads, all right) but not certain, so the
//   number is read to confirm it.
// - CLEAR_DISTANCE: above 60 nothing is clear, whatever the lead: that
//   distance is a wrong crop, and a lead there means nothing.
export const SURE_DISTANCE = 45;
export const CLEAR_DISTANCE = 60;

export const INDEX_URL = new URL('../vision/index.bin', import.meta.url).href;

let indexPromise = null;

// The fingerprint index, loaded once. A failed load is tried again next time.
export function loadFingerprints({url = INDEX_URL, fetchImpl = (...args) => fetch(...args)} = {}) {
	if (!indexPromise) {
		indexPromise = loadIndex(url, {fetchImpl}).catch((err) => {
			indexPromise = null;

			throw err;
		});
	}

	return indexPromise;
}

export const fingerprintsLoaded = () => Boolean(indexPromise);

// The straightened card, and any other crops of it (rectify.js `others`:
// the same box trimmed another way), against the index. Each crop is
// fingerprinted at the matcher's small shifts (QUERY_SHIFTS), and the crop
// whose best group scores lowest wins. Returns {groups, gap, crop, timings}:
// crop is the index into `crops` that won.
export function matchCrops(index, crops) {
	const t0 = performance.now();
	const bits = {artBits: index.header.fields.art.bytes * 8, cardBits: index.header.fields.card ? index.header.fields.card.bytes * 8 : 64};
	let best = null;
	let fingerprintMs = 0;

	crops.forEach((crop, i) => {
		const at = performance.now();
		const queries = queryFingerprints(crop, bits);

		fingerprintMs += performance.now() - at;

		const result = matchFingerprints(index, queries);
		const score = result.groups[0] ? result.groups[0].score : Infinity;

		if (!best || score < best.score) {
			best = {crop: i, result, score};
		}
	});

	const {groups} = best.result;
	const gap = groups.length > 1 ? groups[1].score - groups[0].score : groups.length ? Infinity : 0;

	return {crop: best.crop, gap, groups, timings: {fingerprint: Math.round(fingerprintMs), match: Math.round(performance.now() - t0 - fingerprintMs)}};
}

// How many cards of a group are kept on the tray card.
const GROUP_CARDS = 8;

// The match as the tray card keeps it (small enough to store with the
// draft): {gap, groups: [{score, cards: [{id, catalog, set, image, score}]}]}.
// how: the crop the fingerprint chose, when not the box as found; variants:
// the moved crops tried for an edge worked out (identify.js), and before
// the first crop's distance when one of them won.
export function compactPicture(matched, {before = null, how = null, variants = []} = {}) {
	return {
		before: typeof before === 'number' && Number.isFinite(before) ? Math.round(before * 10) / 10 : null,
		gap: Number.isFinite(matched.gap) ? Math.round(matched.gap * 10) / 10 : null,
		groups: matched.groups.map((group) => ({
			cards: group.cards.slice(0, GROUP_CARDS).map(({catalog, id, image, score, set}) => ({catalog, id, image, score, set})),
			score: Math.round(group.score * 10) / 10,
		})),
		how,
		variants: variants.length ? variants : undefined,
	};
}

// What the picture alone says: sure (one card, close, with a clear lead),
// several (a clear lead, but the group holds more than one card), or
// neither (the lead is small, or the first group is too far away to mean
// anything: CLEAR_DISTANCE). A clear one-card group between SURE_DISTANCE
// and CLEAR_DISTANCE is not sure: its number is read to confirm it.
export function pictureVerdict(picture) {
	const lead = picture && picture.groups && picture.groups[0];

	if (!lead) {
		return {clear: false, close: false, several: false, sure: false};
	}

	const near = typeof lead.score !== 'number' || lead.score <= CLEAR_DISTANCE;
	const clear = near && (picture.gap === null || picture.gap >= AUTO_GAP);
	const close = typeof lead.score !== 'number' || lead.score <= SURE_DISTANCE;

	return {clear, close, several: clear && lead.cards.length > 1, sure: clear && close && lead.cards.length === 1};
}

// Whether text has to be read for this picture: anything short of one card
// with a clear lead.
export const needsText = (picture) => !pictureVerdict(picture).sure;

// ------------------------------------------------------------ candidates

// The catalog language of an index catalog. Portuguese cards are indexed by
// their English image, except sm3.5 (pt).
const langOf = (catalog) => catalog;

// The localId of an index card: what follows its set id.
const localIdOf = (card) => (card.id.startsWith(`${card.set}-`) ? card.id.slice(card.set.length + 1) : card.id.split('-').pop());

const within = (promise, ms, fallback) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms))]);

// How long a set record may take: a few seconds with no signal (it is on the
// phone or not), longer online, where a request may still be retrying from
// before the signal came back.
const describeMs = () => (typeof navigator !== 'undefined' && navigator.onLine === false ? 3000 : 12000);

// The catalog the app saves an index catalog's cards against (js/catalog.js
// catalogFor): Western prints share the international one.
const savedCatalog = (catalog) => (['ja', 'ko', 'zh-cn', 'zh-tw'].includes(catalog) ? catalog : 'international');

// What the phone already knows about some index cards, with no request: the
// card index (js/catalog.js cardIndex, every card the family owns or this
// phone imported), as a Map of "<catalog>|<id>" to its record. Returns a
// function (card) => {name, image, official, setName} or null.
export function knownFrom(index) {
	return (card) => {
		const record = index && index.get(`${savedCatalog(card.catalog)}|${card.id}`);

		if (!record) {
			return null;
		}

		const local = (record.localizations || {})[langOf(card.catalog)] || Object.values(record.localizations || {})[0] || {};

		return local.name ? {image: local.image || null, name: local.name, official: record.official || null, setName: local.set_name || null} : null;
	};
}

// Names, numbers, and set names for the index cards, from each set's record
// (js/catalog.js keeps them on the phone once read). A set out of reach
// within `wait` ms leaves its cards named from `known` (knownFrom), or by
// their number in their set.
async function describe(cards, api, {known = null, wait = describeMs()} = {}) {
	const sets = new Map();

	for (const card of cards) {
		const key = `${langOf(card.catalog)}|${card.set}`;

		if (!sets.has(key)) {
			sets.set(key, within(Promise.resolve().then(() => api.setDetail(langOf(card.catalog), card.set)).catch(() => null), wait, null));
		}
	}

	const details = new Map();

	await Promise.all([...sets].map(async ([key, promise]) => {
		const value = await promise;

		details.set(key, value && value.data !== undefined ? value.data : value);
	}));

	return cards.map((card) => {
		const set = details.get(`${langOf(card.catalog)}|${card.set}`);
		const record = set && (set.cards || []).find((c) => c.id === card.id);
		const localId = (record && record.localId) || localIdOf(card);
		const kept = !record && known ? known(card) : null;

		return {
			agree: [],
			conflicts: [],
			id: card.id,
			image: (record && record.image) || (kept && kept.image) || card.image,
			lang: langOf(card.catalog),
			localId,
			name: (record && record.name) || (kept && kept.name) || card.id,
			named: Boolean(record || kept),
			official: (set && set.cardCount && set.cardCount.official) || (kept && kept.official) || null,
			picture: card.score,
			reasons: ['picture'],
			releaseDate: (set && set.releaseDate) || '',
			score: card.score,
			setCode: null,
			setId: card.set,
			setName: (set && set.name) || (kept && kept.setName) || card.set,
		};
	});
}

// The Western languages TCGdex lists a set's cards in under their own
// names (its international records are English).
const LOCAL_PRINTS = ['pt', 'fr', 'de', 'it', 'es'];

// The print of an international card in `language`: its name, picture, and
// set name from that language's set record (js/catalog.js keeps it on the
// phone once read), or null when the language is English or Asian, or the
// record has no such card. For a Portuguese copy, the tray shows the
// Portuguese name and picture rather than the English ones.
export async function localPrint(card, language, {api = {setDetail: importApi.setDetail}, wait = describeMs()} = {}) {
	if (!card || card.lang !== 'en' || !LOCAL_PRINTS.includes(language)) {
		return null;
	}

	const set = await within(Promise.resolve().then(() => api.setDetail(language, card.setId)).catch(() => null), wait, null);
	const data = set && set.data !== undefined ? set.data : set;
	const record = data && (data.cards || []).find((c) => c.id === card.id);

	return record && record.name ? {image: record.image || null, lang: language, name: record.name, setName: data.name || null} : null;
}

// Whether a candidate is what the number read says: the number, and the
// total when both are known (one confused digit allowed in the total, as
// 195 for 198).
const digitsOf = (value) => String(value || '').replace(/\D/g, '');

function totalFits(candidate, number) {
	if (!number.total || !candidate.official) {
		return true;
	}

	const total = String(Number(digitsOf(number.total)));

	return String(candidate.official) === total || confusedVariants(total).includes(String(candidate.official));
}

function numberFits(candidate, number) {
	return Boolean(number) && sameNumber(candidate.localId, number.number) && totalFits(candidate, number);
}

// Near enough not to count against the picture: the number alone, or the
// number one confused digit away with the total right.
function numberNear(candidate, number) {
	if (!number) {
		return false;
	}

	if (sameNumber(candidate.localId, number.number)) {
		return true;
	}

	const digits = digitsOf(number.number);

	return Boolean(digits) && totalFits(candidate, number) && confusedVariants(String(Number(digits))).some((value) => sameNumber(candidate.localId, value));
}

const ASIAN = ['ja', 'ko', 'zh-cn', 'zh-tw'];

// Whether a candidate's catalog can hold a copy in `language` (Korean
// copies are saved against the Japanese record, DESIGN.md section 5).
function languageFits(candidate, language) {
	if (!language || language === 'non-latin') {
		return true;
	}

	if (ASIAN.includes(language)) {
		return candidate.lang === language || (language === 'ko' && candidate.lang === 'ja');
	}

	return !ASIAN.includes(candidate.lang);
}

// The tray's candidates and verdict from a picture match and the read (a
// number-only read, or null when no text was needed). Returns {candidates,
// sure, why, card (the candidate to show, or null), disagree, hand (an
// add-by-hand prefill, or null), unnamed (no card's set record could be
// reached), ms}.
//
// textRoute(read, language): the old text-only lookup (js/scan/match.js
// findCandidates), tried when the picture is unsure and the number read
// names none of its cards, so a card the index cannot have (a set with no
// images yet) is still found by its number.
//
// wait: how long to wait for each set's record (default: a few seconds
// offline, longer online); known: what the phone knows with no request
// (knownFrom). The scanner first asks with a short wait, to show the card
// at once from what is on the phone, then again in full behind it
// (js/scan/view.js pictureItemNow).
export async function pictureMatch(picture, read, language, {api = {setDetail: importApi.setDetail}, known = null, now = () => performance.now(), textRoute = null, wait = undefined} = {}) {
	const started = now();
	const verdict = pictureVerdict(picture);
	const number = read && read.number && read.number.number ? read.number : null;
	const groups = (picture && picture.groups) || [];
	const leadCards = groups[0] ? groups[0].cards : [];
	const rest = groups.slice(1).map((group) => group.cards[0]).filter(Boolean);
	const described = await describe([...leadCards, ...rest], api, {known, wait});
	const lead = described.slice(0, leadCards.length);
	const others = described.slice(leadCards.length);
	const fitting = lead.filter((c) => languageFits(c, language));
	const byNumber = (list) => list.filter((c) => numberFits(c, number));
	const printed = number ? `${number.numberPrinted || number.number}${number.total ? `/${number.totalPrinted || number.total}` : ''}` : null;
	// No set record reached for the first group's cards (no signal, and their
	// sets never on this phone): the view waits for signal rather than show
	// bare ids.
	const unnamed = lead.length > 0 && !lead.some((c) => c.named);
	const done = (result) => ({candidates: [], card: null, disagree: false, hand: null, ms: Math.round(now() - started), sure: false, unnamed, why: null, ...result});

	// The lead group's own order: the number read first, then the language,
	// then, with no Asian language known, the international record before a
	// Japanese or Chinese twin (most cards scanned are Portuguese or English:
	// session.js LEADING_LANGUAGES), then the picture's distance.
	// A label row that read no Latin text ("non-latin") does not count as
	// an Asian language: on the benchmark a blurred or glared Latin label
	// read that way 27 times, and putting the Japanese twin first then cost
	// 24 right cards of 240.
	const asianKnown = ASIAN.includes(language);
	const western = (c) => (asianKnown || ASIAN.includes(c.lang) ? 0 : 1);
	const order = (list) => [...list].sort((a, b) => (numberFits(b, number) - numberFits(a, number)) || (languageFits(b, language) - languageFits(a, language)) || (western(b) - western(a)) || a.score - b.score);

	if (verdict.clear) {
		const ordered = order(lead);
		const candidates = [...ordered, ...others];
		const matches = byNumber(lead);

		if (number && !lead.some((c) => numberNear(c, number))) {
			// The picture is clear and the number names another card.
			return done({
				candidates,
				card: ordered[0],
				disagree: true,
				why: `The picture looks like ${ordered[0].name} (${ordered[0].localId}${ordered[0].official ? `/${ordered[0].official}` : ''}), but the number reads ${printed}. Check it.`,
			});
		}

		if (verdict.sure) {
			return done({candidates, card: ordered[0], sure: true});
		}

		const narrowed = matches.length ? matches.filter((c) => languageFits(c, language)) : fitting;

		if (narrowed.length === 1 && (matches.length || !lead.some((c) => c !== narrowed[0] && languageFits(c, language)))) {
			// Past SURE_DISTANCE only the number read makes it sure.
			return done({candidates, card: narrowed[0], sure: matches.length > 0 || (verdict.close && Boolean(language && language !== 'non-latin'))});
		}

		return done({candidates, card: ordered[0], why: `${lead.length} cards share this picture${number ? '' : ' and the number did not read'}. Tap the right one.`});
	}

	// The lead is small: a number read that names one of the five promotes it.
	const all = [...order(lead), ...others];
	const named = byNumber(all);

	if (named.length === 1) {
		return done({candidates: [named[0], ...all.filter((c) => c !== named[0])], card: named[0], sure: (number.confidence || 0) >= 0.6});
	}

	if (number && !named.length && textRoute) {
		let found = null;

		try {
			found = await textRoute(read, language);
		}
		catch {
			found = null;
		}

		const exact = found ? (found.candidates || []).filter((c) => (c.reasons || []).includes('number and total')) : [];

		if (exact.length) {
			return done({candidates: [...found.candidates, ...all].slice(0, 8), card: exact.length === 1 ? exact[0] : null, why: `The picture was not clear; the number ${printed} names ${exact.length === 1 ? 'this card' : `${exact.length} cards`}. Check it.`});
		}

		if (found && !(found.candidates || []).length && number.total) {
			// A number and total no catalog set has: a set the catalog has not
			// got yet (Korean and Japanese M6, say).
			return done({
				candidates: all,
				hand: {language: language && language !== 'non-latin' ? language : null, number: number.numberPrinted || number.number, setCode: number.setCodeRun || '', total: number.totalPrinted || number.total},
				why: `The number reads ${printed}, but the catalog has not got that set yet. Add it by hand, or pick a card below.`,
			});
		}
	}

	return done({candidates: all, why: number && !named.length ? `The picture was not clear, and the number ${printed} names none of these. Tap the right one, or search.` : 'The picture was not clear. Tap the right card.'});
}
