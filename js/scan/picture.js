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
import {ASIAN_LANGUAGES} from '../languages.js';
import {confusedVariants, sameNumber} from '../vision/match.js';
import {fold, nameKey, nameSimilarity, SUFFIXES} from './evidence.js';
import {queryFingerprints, thumbnail, turnImage, turnThumb, WIDE_SHIFTS} from '../vision/fingerprint.js';
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
//   group with no text.
// - FIRM_DISTANCE: at or under 55, a lead of FIRM_GAP does too (Eric's
//   phone, version 25: Skrelp under a flashlight was 46.4 away with a lead
//   of 25.7, plainly right, and was left "Not sure"). A wrong first place
//   has never led by more than 5.8, and its distance was past 60. FIRM_GAP
//   was 20 until version 36 (Eric, 2026-10-09): on his holder-log crops and
//   1,056 re-crops of them (lab/holder/crops.mjs) the 141 wrong first places
//   led by 6 at most, all past 61, while 140 right ones within 55 led by 15
//   to 20 and waited for their number to be read.
// - Between those and CLEAR_DISTANCE the picture is probably right but not
//   certain, so the number is read to confirm it.
// - CLEAR_DISTANCE: above 60 nothing is clear, whatever the lead: that
//   distance is a wrong crop, and a lead there means nothing.
export const SURE_DISTANCE = 45;
export const FIRM_DISTANCE = 55;
export const FIRM_GAP = 15;
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
//
// When no crop is sure that way, the closest WIDE_CROPS crops are matched
// again with the wider search (fingerprint.js WIDE_SHIFTS: moves of up to
// 7.5 %, a smaller and larger crop, the card squeezed by a strip of the
// card underneath or a side cut short, and FAR_PLACES: moved 10 %, 10 %
// smaller or larger, pile strips of 12 and 20 %, each with the small shifts
// round it), so a crop that is right as found pays nothing for it. On
// Eric's holder-log crops (lab/holder/crops.mjs, 2026-10-09) it put the
// right card first on 92 of 96 against 88, sure on 69 against 55, none
// wrong but sure, and the right card first on 920 of 1,056 re-crops
// (moved, zoomed, pile strips, turned) against 472. FAR_PLACES (2026-10-16)
// took the re-crops to 1,002 right first and 718 sure (from 919 and 552)
// and the crops as kept to 77 sure (73), still none wrong but sure; the
// wrong first places led by 7.8 at most, all 58 or more away. It costs
// 113 fingerprints against 59 before, about 1.5 times the time (a crop
// widened: about 200 ms against 130 at the median on this laptop, the
// plain search about 22 ms). wide: false skips it.
export const WIDE_CROPS = 2;

// How many cards matcher.js scores in full after screening the index on
// each hash's first word ({base, wide}: the plain search and the wide one;
// 0 scores every card).
export const SCREEN = {base: 2000, wide: 2000};

// A card upside down or on its side: when no crop is sure and the closest
// is past TURN_FROM (an upright card the picture is unsure of is nearer
// than that: its trouble is a lookalike, not the way it lies), the closest
// WIDE_CROPS crops are matched again turned half a turn, and a crop wider
// than it is tall (a card on its side) a quarter turn either way. A turn
// wins only when it comes TURN_MARGIN closer than the crop as it lay, and
// the answer's `turn` says how many quarter turns clockwise the card lay
// (turnImage turns it upright). Each turn costs what one crop's plain
// search does, screened as it is. turns: false skips it.
export const TURN_FROM = SURE_DISTANCE;
export const TURN_MARGIN = 8;

const turnsOf = (crop) => (crop.width > crop.height ? [1, 3] : [2]);

export function matchCrops(index, crops, {screen = SCREEN, turns = true, wide = true} = {}) {
	const t0 = performance.now();
	const bits = {artBits: index.header.fields.art.bytes * 8, cardBits: index.header.fields.card ? index.header.fields.card.bytes * 8 : 64};
	const tried = [];
	let fingerprintMs = 0;
	const gapOf = (groups) => (groups.length > 1 ? groups[1].score - groups[0].score : groups.length ? Infinity : 0);
	const scoreOf = (result) => (result.groups[0] ? result.groups[0].score : Infinity);

	crops.forEach((crop, i) => {
		const at = performance.now();
		const thumb = thumbnail(crop);
		const queries = queryFingerprints(thumb, bits);

		fingerprintMs += performance.now() - at;

		const result = matchFingerprints(index, queries, {screen: screen.base});

		tried.push({crop: i, queries, result, score: scoreOf(result), thumb});
	});

	tried.sort((a, b) => a.score - b.score || a.crop - b.crop);

	const sureOf = (one) => pictureVerdict({gap: gapOf(one.result.groups), groups: one.result.groups}).sure;
	let best = tried[0];
	let widened = false;
	let turnedTried = false;
	let plain = tried[0] ? tried[0].score : null;
	// The crops the wide search starts from: the closest as they lay, and
	// turned when turns were tried.
	let pool = tried;
	// The closest crop as it lay, for the margin a turn must win by.
	let upright = tried[0] || {score: Infinity};
	// Whether a turn won by TURN_MARGIN before the wide search, when both
	// ways had the same few shifts.
	let turnWon = false;

	if (turns && best && !sureOf(best) && best.score > TURN_FROM) {
		turnedTried = true;

		const turned = [];

		for (const one of tried.slice(0, WIDE_CROPS)) {
			for (const turn of turnsOf(crops[one.crop])) {
				const at = performance.now();
				const thumb = turn === 2 ? turnThumb(one.thumb) : thumbnail(turnImage(crops[one.crop], turn));
				const queries = queryFingerprints(thumb, bits);

				fingerprintMs += performance.now() - at;

				const result = matchFingerprints(index, queries, {screen: screen.base});

				turned.push({crop: one.crop, queries, result, score: scoreOf(result), thumb, turn});
			}
		}

		turned.sort((a, b) => a.score - b.score || a.crop - b.crop);

		if (turned[0] && turned[0].score < best.score - TURN_MARGIN) {
			best = turned[0];
			plain = Math.min(plain, best.score);
			turnWon = true;
		}

		// The wide search starts from the closest crops, a turned one first
		// when it is nearer than any as it lay (a card upside down and a
		// little off, not yet nearer by TURN_MARGIN); a turn farther away
		// costs the wide search nothing.
		pool = [...turned.filter((one) => one.score < tried[0].score), ...tried];
	}

	// The closest crop before the wide search, and its lead group after it.
	const unwidened = best;
	let unwidenedLead = null;

	if (wide && best && !sureOf(best)) {
		widened = true;

		for (const one of pool.slice(0, WIDE_CROPS)) {
			const at = performance.now();
			const more = queryFingerprints(one.thumb, bits, WIDE_SHIFTS);

			fingerprintMs += performance.now() - at;

			const result = matchFingerprints(index, [...one.queries, ...more], {screen: screen.wide});
			const score = scoreOf(result);

			if (one === unwidened) {
				unwidenedLead = result.groups[0] || null;
			}

			if (score < best.score || (one === best && score <= best.score)) {
				best = {...one, result, score};
			}

			if (!one.turn && score < upright.score) {
				upright = {...one, result, score};
			}
		}
	}

	// A turn that only the wide search made the closest has to win by
	// TURN_MARGIN too: that search brings any crop a little closer, a wrong
	// way up included. One that had already won by TURN_MARGIN, both ways
	// searched alike, keeps its place unless the crop as it lay comes closer
	// still: with FAR_PLACES the wide search brings the wrong way up within
	// 8 of the right one (an upside-down card, Eric's holder log: 72.0
	// against 64.4), which took a card the turn had found away again.
	if (best && best.turn && upright.score <= best.score + (turnWon ? 0 : TURN_MARGIN)) {
		best = upright;
	}

	const {groups} = best.result;
	// The crop kept (identify.js reads the number and the label row from
	// it): the wide search moves a crop up to 10 % or resizes it, so another
	// outline of the same card (a card dropped exactly on another, say) can
	// come a little closer by being moved, and its edges are then off for
	// the read. When the crop closest as it lay names the same lead artwork
	// after the wide search too, the same way up, that crop is kept; the
	// match itself is the closest one's.
	const leadIds = (group) => new Set(group ? group.cards.map((c) => c.id) : []);
	const sameLead = unwidenedLead && groups[0] && [...leadIds(groups[0])].some((id) => leadIds(unwidenedLead).has(id));
	const crop = widened && sameLead && (best.turn || 0) === (unwidened.turn || 0) ? unwidened.crop : best.crop;

	return {crop, gap: gapOf(groups), groups, plain, timings: {fingerprint: Math.round(fingerprintMs), match: Math.round(performance.now() - t0 - fingerprintMs)}, turn: best.turn || 0, turned: turnedTried, wide: widened};
}

// How many cards of a group are kept on the tray card.
const GROUP_CARDS = 8;

// The match as the tray card keeps it (small enough to store with the
// draft): {gap, groups: [{score, cards: [{id, catalog, set, image, score}]}]}.
// how: the crop the fingerprint chose, when not the box as found; variants:
// the moved crops tried for an edge worked out (identify.js), and before
// the first crop's distance when one of them won; turn the quarter turns
// clockwise the card lay (matchCrops), when not upright.
export function compactPicture(matched, {before = null, how = null, turn = 0, variants = []} = {}) {
	return {
		before: typeof before === 'number' && Number.isFinite(before) ? Math.round(before * 10) / 10 : null,
		plain: typeof matched.plain === 'number' && Number.isFinite(matched.plain) ? Math.round(matched.plain * 10) / 10 : undefined,
		gap: Number.isFinite(matched.gap) ? Math.round(matched.gap * 10) / 10 : null,
		groups: matched.groups.map((group) => ({
			cards: group.cards.slice(0, GROUP_CARDS).map(({catalog, full, id, image, score, set}) => ({catalog, ...(full ? {full: true} : {}), id, image, score, set})),
			score: Math.round(group.score * 10) / 10,
		})),
		how,
		turn: turn || undefined,
		variants: variants.length ? variants : undefined,
	};
}

// What the picture alone says: sure (one card, close, with a clear lead),
// several (a clear lead, but the group holds more than one card), or
// neither (the lead is small, or the first group is too far away to mean
// anything: CLEAR_DISTANCE). close: near enough, for its lead, to settle
// the card: SURE_DISTANCE with AUTO_GAP, or FIRM_DISTANCE with FIRM_GAP. A
// clear one-card group short of that is not sure: its number is read to
// confirm it.
export function pictureVerdict(picture) {
	const lead = picture && picture.groups && picture.groups[0];

	if (!lead) {
		return {clear: false, close: false, several: false, sure: false};
	}

	const score = typeof lead.score === 'number' ? lead.score : 0;
	const gap = picture.gap === null || picture.gap === undefined ? Infinity : picture.gap;
	const clear = score <= CLEAR_DISTANCE && gap >= AUTO_GAP;
	const close = clear && (score <= SURE_DISTANCE || (score <= FIRM_DISTANCE && gap >= FIRM_GAP));

	return {clear, close, several: clear && lead.cards.length > 1, sure: close && lead.cards.length === 1};
}

// Whether text has to be read for this picture: anything short of one card
// with a clear lead.
export const needsText = (picture) => !pictureVerdict(picture).sure;

// Past this distance the closest artwork is no match at all (Q-19). Real
// cards that the picture or the number settles are at most CLEAR_DISTANCE
// away; a real card with a wrong crop was 63 to 76 away, but its outline
// was seen. Measured on frames with no card in them (2026-10-06): a sheet
// of printed paper 71, a textured table 76.9, a flat table or wall 108.6.
export const NOT_CARD_DISTANCE = 65;

// Whether a capture held no card, so it should not join the tray, whether
// auto capture or the shutter took it. Every clue must agree:
//
// - seen (steady.js presence on the capture's thumbnail): no card in the
//   guide, and none held too far away (small);
// - no card outline was found (rectify), or the frame has no colour or
//   stripes across it (seen.reason), which an outline does not outweigh;
// - no collector number was read;
// - the closest artwork is past NOT_CARD_DISTANCE. With no picture match
//   (the index not on this phone yet) nothing can be told, and the capture
//   stays.
export function noCard({found = false, picture = null, read = null}, seen) {
	const lead = picture && picture.groups && picture.groups[0];

	if (!seen || seen.present || seen.small || (found && !seen.reason) || (read && read.number) || !lead) {
		return false;
	}

	// The distance before the wider search (matchCrops `plain`): that search
	// brings anything a little closer, a sheet of paper included, and the
	// threshold was measured without it.
	const distance = typeof picture.plain === 'number' ? Math.max(picture.plain, lead.score) : lead.score;

	return typeof distance === 'number' && distance > NOT_CARD_DISTANCE;
}

// Q-20: opening Scan again with the card just added still in front of the
// camera took it again (2, then 3, then 4 Weedles). For this long after the
// camera opens, an automatic capture whose picture clearly names the card
// last added is that same card, and does not join the tray. The shutter
// always adds it.
export const REPEAT_MS = 10 * 1000;

// The card a picture clearly names ("<catalog>|<id>" of its first group's
// first card), or null when the lead is not clear (pictureVerdict).
export function pictureKey(picture) {
	if (!pictureVerdict(picture).clear) {
		return null;
	}

	const card = picture.groups[0].cards[0];

	return card ? `${card.catalog}|${card.id}` : null;
}

// Whether an automatic capture `sinceOpenMs` after the camera opened is the
// card last added (`lastKey`, a pictureKey) again.
export function repeatOfLast(picture, lastKey, sinceOpenMs) {
	if (!lastKey || !(sinceOpenMs >= 0 && sinceOpenMs <= REPEAT_MS)) {
		return false;
	}

	return pictureKey(picture) === lastKey;
}

// The same card twice in a row (Eric, 2026-10-09): an automatic capture
// whose picture clearly names the same card as the camera's capture just
// before it, still in the tray, is that card held a moment longer (a shake
// moved it past steady.js CHANGED), not a second copy, and does not join
// the tray, at any time, not only after the camera opens (repeatOfLast). A
// second copy is the Copies stepper on the card's sheet, or the shutter,
// which always adds the card. A different card in between (A, B, A) adds
// A again. previous: that capture's picture match, or null when there is
// none (or it is still being read).
export function repeatOfPrevious(picture, previous) {
	const key = pictureKey(picture);

	return key !== null && key === pictureKey(previous);
}

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
const savedCatalog = (catalog) => (ASIAN_LANGUAGES.includes(catalog) ? catalog : 'international');

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
			...(card.full ? {full: true} : {}),
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

// A name read with no number puts a card of the picture's five first when it
// names that card this closely (evidence.js matchNames scores, 0 to 1).
export const NAME_PROMOTE = 0.8;

const baseOf = (name) => {
	const words = String(name || '').split(/\s+/);

	while (words.length > 1 && SUFFIXES.includes(fold(words[words.length - 1]).replace(/[^a-z]/g, ''))) {
		words.pop();
	}

	return nameKey(words.join(' '));
};

// Whether a candidate bears the name read: its name, less its mechanic
// suffix, is one of the names matched (the English name, or the spelling
// read), or reads closely like the text itself (a Portuguese print's own
// name).
function namedBy(candidate, names, text) {
	const base = baseOf(candidate.name);

	if (base.length < 3) {
		return false;
	}

	return names.some((match) => baseOf(match.name) === base || (match.spelling && baseOf(match.spelling) === base))
		|| nameSimilarity(base, baseOf(text)) >= NAME_PROMOTE;
}

const ASIAN = ASIAN_LANGUAGES;

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
// The number to go by: the one read, or for a number whose slash read as
// another character (read.misreads, Palafin "10227084" on Eric's phone,
// version 26), the split whose number and total fit a candidate, else whose
// total is a candidate's set total, else the reader's first. A split never
// stands against a sure picture: it is dropped when no card of the
// picture's group is near it.
function misreadSettled(read, described, lead, verdict) {
	const number = read && read.number && read.number.number ? read.number : null;

	if (!number || !number.misread) {
		return number;
	}

	const splits = (read.misreads && read.misreads.length ? read.misreads : [number]).map((split) => ({...number, ...split}));
	const totals = new Set(described.map((c) => (c.official ? String(Number(c.official)) : null)).filter(Boolean));
	const pick = splits.find((split) => described.some((c) => numberFits(c, split))) || splits.find((split) => totals.has(split.total)) || splits[0];

	return verdict.sure && !lead.some((c) => numberNear(c, pick)) ? null : pick;
}

// asian: the last Asian language picked, for a card whose label row read
// no Latin text (language 'non-latin'): the group's print in that language
// comes first (a Korean copy is the Japanese record's), the text route
// searches it first, and the add-by-hand prefill starts in it. It orders
// only; it never makes a card sure.
//
// wait: how long to wait for each set's record (default: a few seconds
// offline, longer online); known: what the phone knows with no request
// (knownFrom). The scanner first asks with a short wait, to show the card
// at once from what is on the phone, then again in full behind it
// (js/scan/view.js pictureItemNow).
export async function pictureMatch(picture, read, said, {api = {setDetail: importApi.setDetail}, asian = null, known = null, now = () => performance.now(), textRoute = null, wait = undefined} = {}) {
	const started = now();
	// The language read or picked (`said`), or for a card with no Latin label
	// the last Asian pick, to order by.
	const language = said === 'non-latin' && ASIAN.includes(asian) ? asian : said;
	const verdict = pictureVerdict(picture);
	const groups = (picture && picture.groups) || [];
	const leadCards = groups[0] ? groups[0].cards : [];
	const rest = groups.slice(1).map((group) => group.cards[0]).filter(Boolean);
	const described = await describe([...leadCards, ...rest], api, {known, wait});
	const lead = described.slice(0, leadCards.length);
	const others = described.slice(leadCards.length);
	const number = misreadSettled(read, described, lead, verdict);
	const fitting = lead.filter((c) => languageFits(c, language));
	const byNumber = (list) => list.filter((c) => numberFits(c, number));
	const printed = number ? `${number.numberPrinted || number.number}${number.total ? `/${number.totalPrinted || number.total}` : ''}` : null;
	// No set record reached for the first group's cards (no signal, and their
	// sets never on this phone): the view waits for signal rather than show
	// bare ids.
	const unnamed = lead.length > 0 && !lead.some((c) => c.named);
	const groupLangs = [...new Set(lead.map((c) => c.lang))];
	const done = (result) => ({candidates: [], card: null, disagree: false, groupLangs, hand: null, ms: Math.round(now() - started), sure: false, unnamed, why: null, ...result});

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

		// A number read outranks the last Asian pick (an ordering only): it filters
		// by the language read or picked.
		const narrowed = matches.length ? matches.filter((c) => languageFits(c, said)) : fitting;

		if (narrowed.length === 1 && (matches.length || !lead.some((c) => c !== narrowed[0] && languageFits(c, language)))) {
			// Past SURE_DISTANCE only the number read makes it sure.
			return done({candidates, card: narrowed[0], sure: matches.length > 0 || (verdict.close && Boolean(said && said !== 'non-latin'))});
		}

		return done({candidates, card: ordered[0], why: `${lead.length} cards share this picture${number ? '' : ' and the number did not read'}. Tap the right one.`});
	}

	// The lead is small: a number read that names one of the five promotes it.
	const all = [...order(lead), ...others];
	const named = byNumber(all);

	if (named.length === 1) {
		return done({candidates: [named[0], ...all.filter((c) => c !== named[0])], card: named[0], sure: (number.confidence || 0) >= 0.6});
	}

	// No number read, but a name (read.js readNumber reads the name strip
	// when the picture is not clear and the number does not read): the text
	// route matches it against every name, Portuguese, French, and German
	// spellings included (js/scan/local-names.js), and a card of the five
	// that bears it is put first; when none does, the cards the name finds
	// are offered before them. A name never makes a card sure here.
	const nameText = !number && read && read.name && read.name.text ? read.name.text : '';

	if (nameText && textRoute) {
		let found = null;

		try {
			found = await textRoute(read, language);
		}
		catch {
			found = null;
		}

		const names = ((found && found.names) || []).filter((match) => match.score >= NAME_PROMOTE);
		const bearing = all.filter((c) => namedBy(c, names, nameText));

		if (bearing.length) {
			return done({
				candidates: [...bearing, ...all.filter((c) => !bearing.includes(c))],
				card: bearing[0],
				why: `The picture was not clear and the number did not read; the name reads "${nameText}". Check it.`,
			});
		}

		const byName = found ? (found.candidates || []).filter((c) => !all.some((one) => one.id === c.id)) : [];

		if (byName.length) {
			return done({candidates: [...byName.slice(0, 5), ...all], why: `The picture was not clear and the number did not read; the name "${nameText}" names these. Tap the right one, or search.`});
		}
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
