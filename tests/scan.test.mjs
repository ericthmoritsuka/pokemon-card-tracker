// Unit tests for the scanner's pure parts: the tray state machine
// (js/scan/session.js), the finish picker (js/scan/finish.js), auto-capture
// (js/scan/steady.js), the evidence combination and fuzzy name match
// (js/scan/evidence.js), and the matcher's routes and waiting rule
// (js/scan/match.js).
// Run: node --test tests/scan.test.mjs

import assert from 'node:assert/strict';
import test, {describe} from 'node:test';

import * as E from '../js/scan/evidence.js';
import {finishChip, finishOptions, plainVariantId} from '../js/scan/finish.js';
import {findCandidates, WaitingForSignal} from '../js/scan/match.js';
import * as S from '../js/scan/session.js';
import {createAutoCapture, difference, presence, THUMB_H, THUMB_W} from '../js/scan/steady.js';
import {newWish} from '../js/wishlist.js';

const AT = '2026-10-01T12:00:00.000Z';

// Real variants_detailed shapes from TCGdex (checked 2026-10-01).
const PINSIR = [
	{size: 'standard', type: 'normal', variantId: 'endfynwn4n10gzq'},
	{size: 'standard', type: 'reverse', variantId: 'cm4kqul3x1bwlz1f'},
	{foil: 'pokeball', size: 'standard', type: 'reverse', variantId: '3739bbtj3i910y5ynn9xc6ryf'},
	{foil: 'masterball', size: 'standard', type: 'reverse', variantId: '2asus05yghmpd1ud1sdmlq3as4e'},
];
const SPINARAK = PINSIR.slice(0, 2);
const CHARIZARD = [
	{size: 'standard', subtype: 'unlimited', type: 'holo', variantId: 'unlimited'},
	{size: 'standard', stamp: ['1st-edition'], subtype: 'shadowless', type: 'holo', variantId: 'first'},
	{size: 'standard', subtype: 'shadowless', type: 'holo', variantId: 'shadowless'},
];
const DRAGAPULT = [
	{size: 'jumbo', type: 'holo', variantId: 'jumbo'},
	{size: 'standard', type: 'holo', variantId: 'holo'},
];

const NORMAL = 'endfynwn4n10gzq';
const REVERSE = 'cm4kqul3x1bwlz1f';

const read = (number, total, language = {code: 'en', confidence: 1, source: 'label'}, confidence = 0.95) => ({
	copyrightYear: 2023,
	language,
	number: {confidence, number, numberPrinted: number.padStart(3, '0'), setCodeRun: '', side: 'left', total, totalPrinted: total},
	wizards: false,
});

const candidate = (id, fields = {}) => ({
	id,
	image: `https://assets.tcgdex.net/en/x/${id}`,
	lang: 'en',
	localId: id.split('-')[1],
	name: `Card ${id}`,
	official: '131',
	reasons: ['number and total', 'en catalog'],
	releaseDate: '2025-01-17',
	score: 6,
	setCode: 'PRE',
	setId: id.split('-')[0],
	setName: 'Prismatic Evolutions',
	...fields,
});

// One tray card taken all the way to ready, with its variants.
function scanned(session, id, {cand = candidate(id), language, numberConfidence, variants = PINSIR} = {}) {
	const item = S.addCapture(session, {at: AT, id: `item-${session.items.length + 1}`});

	S.applyRead(session, item.id, read(cand.localId, cand.official, language, numberConfidence), AT);
	S.applyMatch(session, item.id, {candidates: [cand]}, AT);
	S.applyVariants(session, item.id, cand.id, variants, AT);

	return item;
}

const entry = (id, cardId, fields = {}) => ({card_id: cardId, catalog: 'international', created_at: AT, deleted_at: null, id, language: 'en', updated_at: AT, variant_id: null, ...fields});

describe('the tray state machine', () => {
	test('a capture is read, matched, and gets its finishes before it can be saved', () => {
		const session = S.newSession(AT, 's1');
		const item = S.addCapture(session, {at: AT, id: 'a'});

		assert.equal(item.status, 'reading');
		assert.equal(S.blocker(item), 'reading');

		S.applyRead(session, 'a', read('3', '131'), AT);
		assert.equal(item.status, 'matching');
		assert.equal(item.language, 'en');
		assert.equal(item.languageBy, 'read');

		S.applyMatch(session, 'a', {candidates: [candidate('sv08.5-003')]}, AT);
		assert.equal(item.status, 'ready');
		assert.equal(item.sure, true);
		assert.equal(S.blocker(item), 'finishes');

		S.applyVariants(session, 'a', 'sv08.5-003', PINSIR, AT);
		assert.equal(S.blocker(item), null);
		assert.equal(item.variantId, NORMAL);
		assert.ok(S.isSavable(item));
	});

	test('a language the read is not sure of is left unpicked, never borrowed from another card', () => {
		const session = S.newSession(AT, 's1');

		scanned(session, 'sv08.5-003', {language: {code: 'pt', confidence: 1, source: 'label'}});

		const second = S.addCapture(session, {at: AT, id: 'b'});

		S.applyRead(session, 'b', read('3', '131', {code: 'non-latin', confidence: 0.5, source: 'no Latin label read'}), AT);
		assert.equal(second.language, null);
		assert.equal(second.languageHint, 'non-latin');
		assert.deepEqual(S.languageChoices(second).slice(0, 4), ['ja', 'ko', 'zh-cn', 'zh-tw']);

		const third = S.addCapture(session, {at: AT, id: 'c'});

		S.applyRead(session, 'c', read('3', '131', {code: 'fr', confidence: 0.22, source: 'label'}), AT);
		assert.equal(third.language, null, 'one label read is not enough');
		assert.equal(S.languageChoices(third)[0], 'fr', 'the guess goes first');

		S.applyMatch(session, 'c', {candidates: [candidate('sv08.5-003')]}, AT);
		S.applyVariants(session, 'c', 'sv08.5-003', PINSIR, AT);
		assert.equal(S.blocker(third), 'language');
		assert.ok(S.needsLook(third));

		S.setLanguage(session, 'c', 'fr', 'hand', AT);
		assert.equal(S.blocker(third), null);
	});

	test('a card whose photo was lost mid-read asks for a new scan or a search', () => {
		const session = S.newSession(AT, 's1');
		const item = S.addCapture(session, {at: AT, id: 'a'});

		S.markLost(session, 'a', AT);
		assert.equal(S.blocker(item), 'unmatched');
		assert.match(S.lookReason(item), /Scan the card again, or search/);
		assert.deepEqual(S.languageChoices(item), S.SCAN_LANGUAGES, 'no read: the fixed order, nothing picked');
		assert.equal(item.language, null);
	});

	test('an unsure match needs a tap, and a tap on any candidate clears it', () => {
		const session = S.newSession(AT, 's1');
		const item = S.addCapture(session, {at: AT, id: 'a'});

		S.applyRead(session, 'a', read('1', '102'), AT);
		S.applyMatch(session, 'a', {candidates: [candidate('base1-1', {score: 5}), candidate('ex1-1', {score: 5})]}, AT);
		assert.equal(item.sure, false);
		assert.match(item.why, /2 cards match/);
		assert.equal(S.blocker(item), 'unsure');

		S.chooseCard(session, 'a', item.candidates[1], AT);
		assert.equal(item.card.id, 'ex1-1');
		assert.equal(item.confirmed, true);
		assert.equal(S.blocker(item), 'finishes', 'the new card waits for its finishes');
	});

	test('a hard-to-read number, a near number, no number, and partial sets each ask for a look', () => {
		const looks = [
			S.judgeMatch(read('3', '131', undefined, 0.4), [candidate('sv08.5-003')]),
			S.judgeMatch(read('3', '131'), [candidate('sv08.5-003', {reasons: ['number one digit off']})]),
			S.judgeMatch({number: null}, []),
			S.judgeMatch(read('3', '131'), []),
			S.judgeMatch(read('3', '131'), [candidate('sv08.5-003')], true),
		];

		assert.ok(looks.every((look) => !look.sure && look.why));
		assert.ok(S.judgeMatch(read('3', '131'), [candidate('sv08.5-003'), candidate('sv08-3', {score: 2})]).sure);
	});

	test('waiting for signal blocks the card but not the rest, and Done stays open for them', () => {
		const session = S.newSession(AT, 's1');

		scanned(session, 'sv08.5-003');

		const waiting = S.addCapture(session, {at: AT, id: 'w'});

		S.applyRead(session, 'w', read('102', '189'), AT);
		S.markWaiting(session, 'w', 'catalog', AT);

		const summary = S.doneSummary(session, new Map());

		assert.deepEqual({look: summary.look, savable: summary.savable, waiting: summary.waiting}, {look: 0, savable: 1, waiting: 1});
		assert.ok(S.canSave(summary));
		assert.equal(S.entriesToSave(session, new Map()).length, 1);
	});

	test('Done is blocked while any card needs a look or is still being read', () => {
		const session = S.newSession(AT, 's1');

		scanned(session, 'sv08.5-003');

		const unsure = S.addCapture(session, {at: AT, id: 'u'});

		S.applyRead(session, 'u', read('3', '131'), AT);
		S.applyMatch(session, 'u', {candidates: []}, AT);

		let summary = S.doneSummary(session, new Map());

		assert.equal(summary.look, 1);
		assert.equal(S.canSave(summary), false);

		S.removeItem(session, 'u', AT);
		S.addCapture(session, {at: AT, id: 'r'});
		summary = S.doneSummary(session, new Map());
		assert.equal(summary.busy, 1);
		assert.equal(S.canSave(summary), false);
	});
});

describe('duplicate counting', () => {
	test('owned copies in the same language and repeats in the tray both count; other languages do not', () => {
		const session = S.newSession(AT, 's1');
		const owned = S.ownedIndex([
			entry('e1', 'sv08.5-003', {language: 'en'}),
			entry('e2', 'sv08.5-003', {language: 'pt'}),
			entry('e3', 'sv08.5-003', {deleted_at: AT, language: 'en'}),
		]);
		const a = scanned(session, 'sv08.5-003');
		const b = scanned(session, 'swsh3-102', {cand: candidate('swsh3-102', {official: '189'}), variants: SPINARAK});

		assert.equal(S.quantity(session, a, owned), 2, 'one owned in English plus this one');
		assert.equal(S.duplicateKind(session, a, owned), 'owned');
		assert.equal(S.quantity(session, b, owned), 1);
		assert.equal(S.duplicateKind(session, b, owned), null);

		const b2 = scanned(session, 'swsh3-102', {cand: candidate('swsh3-102', {official: '189'}), variants: SPINARAK});

		assert.equal(S.quantity(session, b, owned), 2);
		assert.equal(S.quantity(session, b2, owned), 2);
		assert.equal(S.duplicateKind(session, b2, owned), 'twice');

		S.setLanguage(session, b2.id, 'pt', 'hand', AT);
		assert.equal(S.quantity(session, b, owned), 1, 'a Portuguese copy is not a second English one');
		assert.equal(S.quantity(session, b2, owned), 1);
	});

	test('a Japanese record and an international one with the same ID are different cards', () => {
		const owned = S.ownedIndex([entry('e1', 'SV1S-001', {catalog: 'ja', language: 'ja'})]);
		const session = S.newSession(AT, 's1');
		const item = scanned(session, 'SV1S-001', {cand: candidate('SV1S-001', {lang: 'en'})});

		assert.equal(S.ownedFor(item, owned).total, 0);
	});
});

describe('the finish picker', () => {
	test('starts on the plain print', () => {
		assert.equal(plainVariantId(PINSIR), NORMAL);
		assert.equal(plainVariantId(CHARIZARD), 'unlimited', 'Base Set: the Unlimited holo, not Shadowless or 1st Edition');
		assert.equal(plainVariantId(DRAGAPULT), 'holo', 'a standard size before a jumbo');
		assert.equal(plainVariantId([]), null);
		assert.equal(plainVariantId([{type: 'normal'}]), null, 'a printing with no variantId is not offered');
	});

	test('lists only the card\'s own printings, plain first, with tray chips', () => {
		const options = finishOptions(PINSIR);

		assert.deepEqual(options.map((option) => option.label), ['Normal', 'Reverse holo', 'Reverse holo, Poké Ball pattern', 'Reverse holo, Master Ball pattern']);
		assert.deepEqual(options.map((option) => option.chip), [null, 'REV', 'PB', 'MB']);
		assert.deepEqual(finishOptions(SPINARAK).map((option) => option.variantId), [NORMAL, REVERSE]);
		assert.deepEqual(finishOptions(DRAGAPULT).map((option) => option.variantId), ['holo', 'jumbo']);
		assert.equal(finishChip(CHARIZARD[1], 'unlimited'), '1ST');
	});

	test('never remembers the last pick: every new card, and every card change, starts on the plain print', () => {
		const session = S.newSession(AT, 's1');
		const first = scanned(session, 'sv08.5-003');

		S.setFinish(session, first.id, '2asus05yghmpd1ud1sdmlq3as4e', 'hand', AT);
		assert.equal(first.variantId, '2asus05yghmpd1ud1sdmlq3as4e');

		const second = scanned(session, 'sv08.5-004');

		assert.equal(second.variantId, NORMAL, 'the next card starts plain');

		// Changing the first card to another candidate starts it over too.
		S.chooseCard(session, first.id, candidate('sv08.5-005'), AT);
		assert.equal(first.variantId, null);
		S.applyVariants(session, first.id, 'sv08.5-005', PINSIR, AT);
		assert.equal(first.variantId, NORMAL);

		// A fresh session starts plain as well, and nothing carries a "last".
		const next = S.newSession(AT, 's2');
		const third = scanned(next, 'sv08.5-003');

		assert.equal(third.variantId, NORMAL);
		assert.deepEqual(Object.keys(next).sort(), ['created_at', 'id', 'items', 'lastSave', 'sheetShown', 'updated_at'], 'a session keeps no last-used finish, language, or condition');
	});

	test('rejects a finish the card does not have', () => {
		const session = S.newSession(AT, 's1');
		const item = scanned(session, 'swsh3-102', {variants: SPINARAK});

		assert.throws(() => S.setFinish(session, item.id, '3739bbtj3i910y5ynn9xc6ryf', 'hand', AT), /no printing/);
	});
});

describe('Set for all', () => {
	function tray() {
		const session = S.newSession(AT, 's1');
		const items = [
			scanned(session, 'sv08.5-003'),
			scanned(session, 'swsh3-102', {cand: candidate('swsh3-102', {official: '189'}), variants: SPINARAK}),
			scanned(session, 'sv06-130', {cand: candidate('sv06-130', {official: '167'}), variants: DRAGAPULT}),
		];

		return {items, session};
	}

	test('previews how many cards change, and keeps the ones set by hand when asked', () => {
		const {items, session} = tray();

		S.setLanguage(session, items[1].id, 'fr', 'hand', AT);

		assert.deepEqual(S.setForAllPreview(session, 'language', 'pt'), {changes: 3, hand: 1, skipped: 0, total: 3});

		const {changed} = S.setForAll(session, 'language', 'pt', {keepHand: true}, AT);

		assert.equal(changed.length, 2);
		assert.deepEqual(items.map((item) => item.language), ['pt', 'fr', 'pt']);
		assert.deepEqual(items.map((item) => item.languageBy), ['all', 'hand', 'all']);

		S.setForAll(session, 'language', 'pt', {keepHand: false}, AT);
		assert.deepEqual(items.map((item) => item.language), ['pt', 'pt', 'pt']);
		assert.deepEqual(S.setForAllPreview(session, 'language', 'pt'), {changes: 0, hand: 0, skipped: 0, total: 3});
	});

	test('a finish applies to the cards that have it and skips the rest', () => {
		const {items, session} = tray();
		const reverse = finishOptions(PINSIR)[1].key;

		assert.deepEqual(S.setForAllPreview(session, 'finish', reverse), {changes: 2, hand: 0, skipped: 1, total: 3});
		S.setForAll(session, 'finish', reverse, {}, AT);
		assert.deepEqual(items.map((item) => item.variantId), [REVERSE, REVERSE, 'holo']);
		assert.ok(S.sessionFinishes(session).some((finish) => finish.key === reverse && finish.count === 2));
	});

	test('a condition applies to all, and can be cleared', () => {
		const {items, session} = tray();

		S.setForAll(session, 'condition', 'Near Mint', {}, AT);
		assert.ok(items.every((item) => item.condition === 'Near Mint'));
		S.setForAll(session, 'condition', null, {}, AT);
		assert.ok(items.every((item) => item.condition === null));
	});

	test('a language in another catalog sends the card back to be looked up', () => {
		const session = S.newSession(AT, 's1');
		const japanese = scanned(session, 'SV1S-001', {cand: candidate('SV1S-001', {lang: 'ja'}), language: {code: 'non-latin', confidence: 0.5}});

		assert.equal(japanese.card.catalog, 'ja');

		let {rematch} = S.setForAll(session, 'language', 'ko', {}, AT);

		assert.deepEqual(rematch, [], 'Korean prints can sit on the Japanese record');
		assert.equal(S.blocker(japanese), null);
		assert.equal(S.entriesToSave(session, new Map())[0].fields.fallback, true);

		({rematch} = S.setForAll(session, 'language', 'en', {}, AT));
		assert.deepEqual(rematch, [japanese.id]);
		assert.equal(S.blocker(japanese), 'rematch');
	});
});

describe('Done and Undo', () => {
	test('saves one entry per physical card, language from the scan', () => {
		const session = S.newSession(AT, 's1');
		const owned = S.ownedIndex([entry('e1', 'sv08.5-003')]);

		scanned(session, 'sv08.5-003');
		scanned(session, 'sv08.5-003');
		scanned(session, 'swsh3-102', {cand: candidate('swsh3-102', {official: '189'}), language: {code: 'pt', confidence: 1}, variants: SPINARAK});
		S.setCondition(session, 'item-3', 'Lightly Played', 'hand', AT);

		const rows = S.entriesToSave(session, owned);

		assert.equal(rows.length, 3, 'two copies of the same card are two entries');
		assert.deepEqual(rows[2].fields, {card_id: 'swsh3-102', catalog: 'international', condition: 'Lightly Played', language: 'pt', language_source: 'scan', variant_id: NORMAL});
		assert.ok(rows.every((row) => row.fields.language_source === 'scan'));
		assert.equal(S.doneSummary(session, owned).owned, 2);
		assert.equal(S.entriesToSave(session, owned, {skipOwned: true}).length, 1, 'Skip leaves out the cards already owned');
	});

	test('Undo session gives back exactly the entries saved, once', () => {
		const session = S.newSession(AT, 's1');

		scanned(session, 'sv08.5-003');
		scanned(session, 'swsh3-102', {cand: candidate('swsh3-102', {official: '189'}), variants: SPINARAK});

		const waiting = S.addCapture(session, {at: AT, id: 'w'});

		S.markWaiting(session, waiting.id, 'ocr', AT);

		const rows = S.entriesToSave(session, new Map());
		const saved = rows.map((row, i) => ({entryId: `entry-${i}`, itemId: row.itemId}));

		S.afterSave(session, saved, AT);
		assert.deepEqual(session.items.map((item) => item.id), ['w'], 'the waiting card stays in the tray');
		assert.deepEqual(session.lastSave, {at: AT, count: 2, entryIds: ['entry-0', 'entry-1']});
		assert.deepEqual(S.takeUndo(session, AT), ['entry-0', 'entry-1']);
		assert.deepEqual(S.takeUndo(session, AT), [], 'a second undo removes nothing');
	});
});

describe('wishlist marks', () => {
	const family = [
		{name: 'Member A', user_id: 'u-ana', wishlist: [newWish('sv08.5-003', {language: 'pt'}, AT, 'w1')]},
		{name: 'Member B', user_id: 'u-bia', wishlist: [newWish('sv08.5-003', {}, AT, 'w2'), newWish('sv08.5-003', {variantId: REVERSE}, AT, 'w3')]},
		{name: 'Member C', user_id: 'u-caio', wishlist: [{...newWish('sv08.5-003', {}, AT, 'w4'), deleted_at: AT}]},
	];

	test('names the members who want the card, from their data, once each', () => {
		const session = S.newSession(AT, 's1');
		const item = scanned(session, 'sv08.5-003', {language: {code: 'pt', confidence: 1}});

		assert.deepEqual(S.wishMarks(item, family).map((mark) => mark.name), ['Member A', 'Member B']);
		assert.equal(S.wishLine(S.wishMarks(item, family)), 'Member A and Member B want this');

		S.setLanguage(session, item.id, 'en', 'hand', AT);
		assert.deepEqual(S.wishMarks(item, family).map((mark) => mark.name), ['Member B'], 'Member A asked for Portuguese');
		assert.equal(S.wishLine(S.wishMarks(item, family)), 'Member B wants this');
	});

	test('no family, no card, or nobody wanting it: no mark', () => {
		const session = S.newSession(AT, 's1');
		const item = scanned(session, 'swsh3-102', {variants: SPINARAK});

		assert.deepEqual(S.wishMarks(item, family), []);
		assert.deepEqual(S.wishMarks(item, []), []);
		assert.equal(S.wishLine([]), null);
		assert.equal(S.wishLine([{name: 'Member A'}, {name: 'Member B'}, {name: 'Member C'}]), 'Member A, Member B, and Member C want this');
	});
});

describe('auto-capture', () => {
	const W = THUMB_W;
	const H = THUMB_H;

	// A card: a light card face with dark text lines, inside a darker table,
	// edges about 5 % in from each side.
	function cardFrame(shift = 0, noise = 0) {
		const grey = new Uint8Array(W * H);
		const left = 3 + shift;
		const right = W - 4 + shift;

		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				let value = 90;

				if (x >= left && x <= right && y >= 2 && y < H - 2) {
					value = (y % 6 < 2 && x % 4 < 3) ? 40 : 220;
				}

				grey[y * W + x] = Math.max(0, Math.min(255, value + (noise ? Math.round((Math.sin(x * 7 + y * 13) * noise)) : 0)));
			}
		}

		return grey;
	}

	const table = () => new Uint8Array(W * H).fill(92);

	test('sees a card, and not an empty table or a cluttered scene', () => {
		assert.equal(presence(cardFrame(), W, H).present, true);
		assert.equal(presence(table(), W, H).present, false);

		const clutter = new Uint8Array(W * H).map((_, i) => ((i * 2654435761) >>> 24));

		assert.equal(presence(clutter, W, H).present, false);
	});

	test('a still card is captured once, and again only after it moves away', () => {
		const detector = createAutoCapture();
		let fired = 0;

		const feed = (frame, times) => {
			for (let i = 0; i < times; i++) {
				if (detector.push(frame, presence(frame, W, H))) {
					fired++;
					detector.captured(frame);
				}
			}
		};

		feed(cardFrame(), 30);
		assert.equal(fired, 1, 'held still for four seconds: one capture');

		feed(cardFrame(0, 3), 10);
		assert.equal(fired, 1, 'sensor noise is not a new card');

		feed(table(), 3);
		feed(cardFrame(), 10);
		assert.equal(fired, 2, 'taken away and back: a second capture');
	});

	test('waits while the hand moves, and while paused', () => {
		const detector = createAutoCapture();
		let fired = 0;

		for (let i = 0; i < 20; i++) {
			const frame = cardFrame(i % 2 ? 2 : -2);

			fired += detector.push(frame, presence(frame, W, H)) ? 1 : 0;
		}

		assert.equal(fired, 0, 'a moving card is never steady');
		assert.ok(difference(cardFrame(2), cardFrame(-2)) > 6);

		detector.pause();

		for (let i = 0; i < 10; i++) {
			fired += detector.push(cardFrame(), {present: true}) ? 1 : 0;
		}

		assert.equal(fired, 0);
		detector.resume();

		for (let i = 0; i < 6; i++) {
			fired += detector.push(cardFrame(), {present: true}) ? 1 : 0;
		}

		assert.ok(fired >= 1);
	});

	test('the shutter counts as the capture, so the same still card is not taken again on its own', () => {
		const detector = createAutoCapture();

		detector.captured(cardFrame());

		let fired = 0;

		for (let i = 0; i < 20; i++) {
			fired += detector.push(cardFrame(), {present: true}) ? 1 : 0;
		}

		assert.equal(fired, 0);
	});
});

describe('matching offline', () => {
	const set = (id, official, cards) => ({cardCount: {official}, cards, id, name: id, releaseDate: '2025-01-17'});
	const brief = (setId, localId) => ({id: `${setId}-${localId}`, image: null, localId, name: `Card ${localId}`});

	test('finds the card in the sets on the phone', async () => {
		const api = {
			allSets: async () => [{cardCount: {official: 131}, id: 'sv08.5'}],
			setDetail: async (lang, id) => set(id, 131, [brief(id, '003')]),
		};
		const found = await findCandidates(read('3', '131'), 'en', {api});

		assert.equal(found.candidates[0].id, 'sv08.5-003');
		assert.equal(found.partial, false);
	});

	test('waits for signal when the set list or every candidate set is out of reach', async () => {
		const offline = async () => {
			throw new TypeError('Failed to fetch');
		};

		await assert.rejects(findCandidates(read('3', '131'), 'en', {api: {allSets: offline, setDetail: offline}}), WaitingForSignal);
		await assert.rejects(findCandidates(read('3', '131'), 'en', {api: {allSets: async () => [{cardCount: {official: 131}, id: 'sv08.5'}], setDetail: offline}}), WaitingForSignal);
	});

	test('a partial search still answers, flagged so the card asks for a look', async () => {
		const api = {
			allSets: async () => [{cardCount: {official: 131}, id: 'sv08.5'}, {cardCount: {official: 131}, id: 'other'}],
			setDetail: async (lang, id) => {
				if (id === 'other') {
					throw new TypeError('Failed to fetch');
				}

				return set(id, 131, [brief(id, '003')]);
			},
		};
		const found = await findCandidates(read('3', '131'), 'en', {api});

		assert.equal(found.partial, true);
		assert.equal(S.judgeMatch(read('3', '131'), found.candidates, found.partial).sure, false);
	});

	test('searches Japanese first when the language is not known, and Korean before Japanese for Korean', () => {
		assert.deepEqual(S.searchOrder(null), ['ja', 'en']);
		assert.deepEqual(S.searchOrder('ko'), ['ko', 'ja']);
		assert.deepEqual(S.searchOrder('pt'), ['pt', 'en']);
		assert.deepEqual(S.searchOrder('en'), ['en']);
	});
});

// ------------------------------------------------------------ evidence

// A few species, at their National Dex numbers, the way
// js/checklists.js speciesNames().en lists them.
const SPECIES = [];

Object.assign(SPECIES, {13: 'Weedle', 14: 'Kakuna', 25: 'Pikachu', 60: 'Poliwag', 122: 'Mr. Mime', 150: 'Mewtwo', 151: 'Mew', 167: 'Spinarak', 669: 'Flabébé'});

// A catalog card as the matcher scores it.
const card = (id, fields = {}) => ({
	dexIds: [13],
	id,
	lang: 'en',
	localId: id.split('-')[1],
	name: 'Weedle',
	official: '86',
	releaseDate: '2026-03-27',
	setId: id.split('-')[0],
	...fields,
});

const nameRead = (text, extra = {}) => ({
	copyrightYear: null,
	hp: null,
	language: {code: 'en', confidence: 1, source: 'label'},
	name: {confidence: 0.9, suffix: null, text},
	number: null,
	partial: null,
	wizards: false,
	...extra,
});

const rank = (read, cards) => {
	const clues = E.cluesOf(read);

	clues.names = read.name ? E.matchSpecies(read.name.text, SPECIES) : [];

	return E.rankCards(clues, cards);
};

describe('the fuzzy name match', () => {
	test('reads through accents and the usual OCR mix-ups', () => {
		assert.equal(E.matchSpecies('Flabebe', SPECIES)[0].name, 'Flabébé', 'accents');
		assert.equal(E.matchSpecies('P0liwag', SPECIES)[0].name, 'Poliwag', '0 for O');
		assert.equal(E.matchSpecies('WeedIe', SPECIES)[0].name, 'Weedle', 'I for l');
		assert.equal(E.matchSpecies('Wee d1e', SPECIES)[0].name, 'Weedle', '1 for l, and a split word');
		assert.equal(E.matchSpecies('Spinarak', SPECIES)[0].score, 1);
		assert.equal(E.matchSpecies('Mr Mime', SPECIES)[0].name, 'Mr. Mime');
	});

	test('finds the name glued to the stage label, keeps short names exact, and ignores noise', () => {
		assert.equal(E.matchSpecies('BASICWeedle', SPECIES)[0].name, 'Weedle');
		assert.deepEqual(E.matchSpecies('Mewtwo', SPECIES).map((m) => m.name), ['Mewtwo'], 'Mew is not inside Mewtwo');
		assert.deepEqual(E.matchSpecies('==" %%', SPECIES), []);
		assert.ok(E.nameSimilarity('Pikachu', 'Pikac') < 0.8 && E.nameSimilarity('Pikachu', 'Pikac') > 0.6, 'a cut-off name is a partial match');
	});

	test('the name strip: the stage label, the Evolves from line, and a suffix are not the name', () => {
		const line = (text, ink) => ({text, words: text.split(' ').map((word) => ({bbox: {x0: 0, x1: 10, y0: 0, y1: 40}, confidence: 90, ink, text: word}))});

		assert.equal(E.parseName([line('BASIC Weedle', 30)]).text, 'Weedle');
		assert.equal(E.parseName([line('STAGE 1 Evolves from Weedle Put Kakuna', 14), line('Kakuna', 30)]).text, 'Kakuna');
		assert.equal(E.parseName([line('Evoves from Weedle', 30), line('Kakuna', 30)]).text, 'Kakuna', 'the word after a loosely read "Evolves from" is dropped');
		assert.deepEqual(E.parseName([line('Arctovish V', 30)]), {confidence: 0.9, suffix: 'v', text: 'Arctovish'});
	});

	test('HP and the partly read number', () => {
		assert.deepEqual(E.parseHp('HP 50', 0.8), {after: false, confidence: 0.8, value: 50, values: [50]});
		assert.equal(E.parseHp('80 HP').after, true, 'the WotC-era order');
		assert.equal(E.parseHp('80 HP').value, 80);
		assert.deepEqual(E.parseHp('350', 0.8).values, [350, 50], 'a small PS read as a 3');
		assert.equal(E.parseHp('w/0@'), null);
		assert.deepEqual(E.parsePartialNumber('CRI EN /086'), {number: null, total: '86'});
		assert.deepEqual(E.parsePartialNumber('001/0'), {number: '1', total: null});
	});
});

describe('combining the evidence', () => {
	const weedle = card('me04-001', {hp: 50});
	const otherWeedle = card('sv03.5-013', {hp: 40, localId: '013', official: '165', releaseDate: '2023-09-22'});
	const kakuna = card('me04-002', {dexIds: [14], hp: 80, localId: '002', name: 'Kakuna'});

	test('number only: the number and the total decide', () => {
		const ranked = rank({...nameRead(''), name: null, number: {confidence: 0.9, number: '1', numberPrinted: '001', setCodeRun: '', side: 'left', total: '86', totalPrinted: '086'}}, [otherWeedle, kakuna, weedle]);

		assert.equal(ranked[0].id, 'me04-001');
		assert.ok(ranked[0].reasons.includes('number and total'));
		assert.deepEqual(ranked[0].agree.sort(), ['number', 'total']);
	});

	test('name only: every print of the species is level, and none is sure', () => {
		const ranked = rank(nameRead('Weedle'), [kakuna, weedle, otherWeedle]);

		assert.deepEqual(ranked.slice(0, 2).map((c) => c.id).sort(), ['me04-001', 'sv03.5-013']);
		assert.equal(ranked[0].score, ranked[1].score);
		assert.ok(ranked[0].confidence < 0.4, 'one clue, and a tie');
		assert.equal(ranked[2].id, 'me04-002');
		assert.equal(S.judgeMatch(nameRead('Weedle'), ranked).sure, false);
	});

	test('name plus total: the set count settles which print', () => {
		const read = nameRead('Weedle', {partial: {number: null, total: '86'}});
		const ranked = rank(read, [otherWeedle, weedle, kakuna]);

		assert.equal(ranked[0].id, 'me04-001');
		assert.deepEqual(ranked[0].agree.sort(), ['name', 'total']);
		assert.ok(ranked[0].confidence > ranked[1].confidence);
	});

	test('name plus HP: the HP settles it, and name, HP, and total together are sure', () => {
		const ranked = rank(nameRead('Weedle', {hp: {confidence: 0.8, value: 50, values: [50]}}), [otherWeedle, weedle]);

		assert.equal(ranked[0].id, 'me04-001');
		assert.ok(ranked[0].reasons.includes('HP 50'));
		assert.ok(ranked[1].conflicts.includes('hp'), 'an HP read clearly that disagrees counts against');

		const three = nameRead('Weedle', {hp: {confidence: 0.8, value: 50, values: [50]}, partial: {number: null, total: '86'}});
		const sure = rank(three, [otherWeedle, weedle, kakuna]);

		assert.equal(sure[0].confidence, 0.85);
		assert.equal(S.judgeMatch(three, sure).sure, true);
	});

	test('an HP printed after its number ("80 HP") points to a WotC-era print', () => {
		const base = card('base1-18', {dexIds: [148], hp: 80, localId: '18', name: 'Dragonair', official: '102', releaseDate: '1999-01-09'});
		const modern = card('sv03.5-148', {dexIds: [148], hp: 80, localId: '148', name: 'Dragonair', official: '165', releaseDate: '2023-09-22'});

		SPECIES[148] = 'Dragonair';

		const ranked = rank(nameRead('Dragonair', {hp: E.parseHp('80 HP', 0.8)}), [modern, base]);

		assert.equal(ranked[0].id, 'base1-18');
		assert.ok(ranked[0].reasons.includes('HP printed WotC style'));
	});

	test('conflicting clues: a clear number outweighs a name it disagrees with, and the confidence drops', () => {
		// The number reads Kakuna's 002/086; the name strip reads Weedle (the
		// "Evolves from" line, say).
		const read = nameRead('Weedle', {number: {confidence: 0.9, number: '2', numberPrinted: '002', setCodeRun: '', side: 'left', total: '86', totalPrinted: '086'}});
		const ranked = rank(read, [weedle, kakuna]);

		assert.equal(ranked[0].id, 'me04-002', 'number and total beat the name');
		assert.ok(ranked[0].conflicts.includes('name'));
		assert.ok(ranked[1].conflicts.includes('number'));
		assert.ok(ranked[0].confidence < E.confidenceOf({agree: ['number', 'total'], conflicts: []}));
	});

	test('the artwork orders a tie and never lifts a card that lost on text', () => {
		const ranked = rank(nameRead('Weedle'), [kakuna, otherWeedle, weedle]);
		const sims = new Map([['me04-001', 0.95], ['sv03.5-013', 0.2], ['me04-002', 0.99]]);
		const ordered = E.orderByArtwork(ranked, sims);

		assert.equal(ordered[0].id, 'me04-001');
		assert.ok(ordered[0].reasons.includes('artwork'));
		assert.equal(ordered[2].id, 'me04-002', 'Kakuna stays behind, however alike');
		assert.equal(S.judgeMatch(nameRead('Weedle'), ordered).sure, false, 'artwork alone never makes it sure');
	});
});

describe('the name route', () => {
	const sets = [{cardCount: {official: 86}, id: 'me04', serie: 'me'}, {cardCount: {official: 165}, id: 'sv03.5', serie: 'sv'}];
	const prints = {
		13: [
			{cardId: 'me04-001', image: 'https://assets.tcgdex.net/en/me/me04/001', localId: '001', name: 'Weedle', releaseDate: '2026-03-27', setId: 'me04', setName: 'Chaos Rising'},
			{cardId: 'sv03.5-013', image: null, localId: '013', name: 'Weedle', releaseDate: '2023-09-22', setId: 'sv03.5', setName: '151'},
		],
	};
	const api = {
		allSets: async () => sets,
		cardDetail: async (lang, id) => ({dexId: [13], hp: id === 'me04-001' ? 50 : 40}),
		setDetail: async () => {
			throw new Error('the name route needs no set detail');
		},
		species: async () => SPECIES,
		speciesPrints: async (dex) => prints[dex] || [],
	};

	test('a card whose number did not read is found by its name and HP', async () => {
		const read = S.summariseRead(nameRead('Weedle', {hp: {confidence: 0.8, value: 50}}));
		const found = await findCandidates(read, 'en', {api});

		assert.deepEqual(found.routes, ['name']);
		assert.equal(found.names[0].name, 'Weedle');
		assert.equal(found.candidates[0].id, 'me04-001');
		assert.equal(found.candidates[0].official, '86');
		assert.ok(found.candidates[0].reasons.includes('HP 50'));
		assert.equal(found.candidates[0].setName, 'Chaos Rising');
	});

	test('a tie the text cannot break goes to the artwork', async () => {
		const read = S.summariseRead(nameRead('Weedle'));
		const found = await findCandidates(read, 'en', {api: {...api, artworkSims: async () => new Map([['sv03.5-013', 0.9], ['me04-001', 0.1]])}, artwork: new Float32Array(4)});

		assert.equal(found.candidates[0].id, 'sv03.5-013');
		assert.equal(found.candidates[0].artwork, 0.9);
	});

	test('what was read, and what the search starts with', () => {
		const read = S.summariseRead(nameRead('Pikac', {partial: {number: null, total: '86'}}));

		assert.equal(S.readLine(read), 'Name: Pikac, number: ?/86');
		assert.equal(S.readLine(S.summariseRead({name: null, number: null})), 'Name: unreadable, number: unreadable');
		assert.equal(S.searchPrefill({names: [{dex: 25, name: 'Pikachu', score: 0.8}], read}), 'Pikachu');
		assert.equal(S.searchPrefill({names: [], read}), 'Pikac');
	});
});
