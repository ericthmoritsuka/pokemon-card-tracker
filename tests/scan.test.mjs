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
import {knownFrom, localPrint, pictureMatch, pictureVerdict} from '../js/scan/picture.js';
import {layoutGuide} from '../js/scan/camera.js';
import {rectify} from '../js/scan/rectify.js';
import * as S from '../js/scan/session.js';
import {colourfulness, COLOURLESS, createAutoCapture, difference, presence, THUMB_H, THUMB_W} from '../js/scan/steady.js';
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
		assert.deepEqual(S.languageChoices(second).slice(0, 6), ['pt', 'en', 'ja', 'ko', 'zh-cn', 'zh-tw'], 'Portuguese and English, then the Asian languages');

		const third = S.addCapture(session, {at: AT, id: 'c'});

		S.applyRead(session, 'c', read('3', '131', {code: 'fr', confidence: 0.22, source: 'label'}), AT);
		assert.equal(third.language, null, 'one label read is not enough');
		assert.deepEqual(S.languageChoices(third).slice(0, 3), ['pt', 'en', 'fr'], 'the guess comes after Portuguese and English');

		S.applyMatch(session, 'c', {candidates: [candidate('sv08.5-003')]}, AT);
		S.applyVariants(session, 'c', 'sv08.5-003', PINSIR, AT);
		assert.equal(S.blocker(third), 'language');
		assert.ok(S.needsLook(third));

		S.setLanguage(session, 'c', 'fr', 'hand', AT);
		assert.equal(S.blocker(third), null);
	});

	test('the language chips lead with Portuguese and English, then the guess, each once', () => {
		const order = (languageHint) => S.languageChoices({languageHint});

		for (const hint of [null, 'pt', 'en', 'unknown']) {
			assert.deepEqual(order(hint).slice(0, 4), ['pt', 'en', 'ja', 'ko'], `hint ${hint}`);
		}

		assert.deepEqual(order('non-latin').slice(0, 4), ['pt', 'en', 'ja', 'ko'], 'the first four chips: no More needed for Portuguese or English');
		assert.deepEqual(order('ko').slice(0, 4), ['pt', 'en', 'ko', 'ja']);
		assert.deepEqual(order('de').slice(0, 3), ['pt', 'en', 'de']);

		for (const hint of [null, 'non-latin', 'fr', 'zh-tw']) {
			assert.deepEqual([...order(hint)].sort(), [...S.SCAN_LANGUAGES].sort(), `every language once for ${hint}`);
		}
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

describe('the scan report', () => {
	// What js/scan/identify.js answers for a full-art Portuguese card whose
	// name sat on busy art: the number (a secret rare, past the set total)
	// read, the name did not.
	const result = (fields = {}) => ({
		angle: 12.4,
		card: {height: 1400, width: 1002},
		found: true,
		note: 'Card edges found, at a slant.',
		read: {
			attackText: '',
			copyrightYear: 2026,
			hp: null,
			label: {code: 'pt', confidence: 0.67},
			language: {code: 'pt', confidence: 0.67, source: 'label'},
			name: {confidence: 0.2, suffix: null, text: 'Rmpharas'},
			number: {confidence: 0.91, number: '107', numberPrinted: '107', side: 'left', total: '86', totalPrinted: '086'},
			partial: {number: null, total: null},
			raw: {
				hp: {confidence: 0, lines: [{text: '', words: []}], text: ''},
				label: {confidence: 0, lines: [{text: 'fraqueza resistencia', words: [{confidence: 80, text: 'fraqueza'}, {confidence: 70, text: 'resistencia'}]}], text: 'fraqueza resistencia'},
				name: {confidence: 0, lines: [{text: 'Rmpharas', words: [{confidence: 31, text: 'Rmpharas'}]}], text: 'Rmpharas\n~~ ee'},
				numberLeft: {confidence: 0, lines: [{text: 'MEG PT 107/086', words: [{confidence: 92, text: '107/086'}]}], text: 'MEG PT 107/086'},
				numberRight: {confidence: 0, lines: [], text: ''},
			},
			setCodeBox: {langCode: 'PT', run: 'MEG', setCode: 'MEG', text: 'MEG PT'},
			timings: {hp: 410, label: 380, name: 620, numberLeft: 540, numberRight: 300, ocr: 1450},
			wizards: false,
			...fields,
		},
		timings: {artwork: 12, ocr: 1450, rectify: 96, total: 1580, workers: 2},
	});
	const device = {cores: 8, memory: 4, online: true, screen: '412 x 915 at 2.6x', userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/129'};
	const found = {
		candidates: Array.from({length: 6}, (_, i) => candidate(`me04-${107 + i}`, {agree: i ? ['total'] : ['number', 'total'], confidence: i ? 0.3 : 0.8, name: i ? 'Other' : 'Ampharos', official: '86', reasons: ['number and total', 'pt catalog'], score: 9 - i, setName: 'Chaos Rising'})),
		names: [{dex: 181, name: 'Ampharos', score: 0.62}],
		partial: false,
		routes: ['number', 'name'],
		searched: ['pt', 'en'],
		setName: null,
	};

	test('says what each read got, how long each step took, and which cards were weighed, in text', () => {
		const session = S.newSession(AT, 's1');
		const item = S.addCapture(session, {at: AT, id: 'a'});

		item.report = S.reportOfRead(result(), {captureMs: 35, frame: '1041 x 1453', source: 'camera'});
		S.applyRead(session, 'a', result().read, AT);
		S.applyMatch(session, 'a', found, AT);
		item.report = {...item.report, match: S.reportOfMatch(found, {language: 'pt', ms: 210})};

		const text = S.reportText(item, {at: AT, device});

		assert.ok(JSON.stringify(item.report).length < 6000, 'small enough to keep with the draft');
		assert.doesNotMatch(text, /data:image|base64/, 'no images');

		for (const expected of [
			'Browser: Mozilla/5.0 (Linux; Android 14) Chrome/129',
			'CPU cores: 8; memory: 4 GB',
			'Capture: 35 ms',
			'Edges and straightening: 96 ms; card edges found, turned 12.4 degrees, card 1002x1400 px. Card edges found, at a slant.',
			'Name strip: 620 ms, confidence 31: "Rmpharas | ~~ ee"',
			'Number, bottom left: 540 ms, confidence 92: "MEG PT 107/086"',
			'Weakness row (language): 380 ms, confidence 75: "fraqueza resistencia"',
			'Artwork fingerprint: 12 ms',
			'Catalog lookup: 210 ms; routes number, name; searched for pt',
			'Number: 107/086 (91 %, left side); past the set total: a secret rare',
			'Set code box: "MEG PT", set MEG, language PT',
			'Script: Latin script. Language guess: pt',
			'Species the name matched: Ampharos (0.62)',
			'Candidates (6 found, first 5 shown)',
			'1. Ampharos, 107/86, Chaos Rising (me04-107, en): score 9, confidence 80 %',
			'why: number and total; pt catalog; agrees: number, total',
		]) {
			assert.ok(text.includes(expected), `has "${expected}" in:\n${text}`);
		}

		assert.doesNotMatch(text, /^6\. /m, 'five candidates at most');
	});

	test('a card with no Latin weakness row says Japanese or Korean text is suspected', () => {
		const item = S.addCapture(S.newSession(AT, 's1'), {at: AT, id: 'a'});

		item.report = S.reportOfRead(result({language: {code: 'non-latin', confidence: 0.5, source: 'no Latin label read'}, number: null}));

		const text = S.reportText(item, {at: AT, device});

		assert.match(text, /Script: No Latin weakness row was read: Japanese, Korean, or Chinese text is suspected/);
		assert.match(text, /Number: unreadable/);
		assert.match(text, /Catalog lookup: not done yet/);
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

	// A card held to fill the guide's height, seen at a slant on a laptop
	// screen: its wider top reaches the thumbnail's outermost columns, and the
	// app's text sits right beside its right side, so nothing beyond its
	// edges is flat.
	function slantFrame() {
		const grey = new Uint8Array(W * H).fill(30);

		for (let y = 0; y < H; y++) {
			const f = y / H;
			const left = 1 + 4 * f;
			const right = W - 2 - 4 * f;

			for (let x = 0; x < W; x++) {
				if (y >= 3 && y < H - 3 && x >= left && x <= right) {
					grey[y * W + x] = (y % 6 < 2 && x % 4 < 3 && x > left + 3 && x < right - 3) ? 40 : 205;
				}
				else if (x > right + 1 && y > H * 0.3 && y < H * 0.7 && (y % 5 < 2) && (x % 3 === 0)) {
					grey[y * W + x] = 200;
				}
			}
		}

		return grey;
	}

	test('sees a card that fills the guide\'s height at a slant, with the screen\'s text beside it', () => {
		const frame = slantFrame();

		assert.equal(presence(frame, W, H).present, true);

		const detector = createAutoCapture();
		let fired = 0;

		for (let i = 0; i < 10; i++) {
			if (detector.push(frame, presence(frame, W, H))) {
				fired++;
				detector.captured(frame);
			}
		}

		assert.equal(fired, 1, 'held still: captured once');

		// Not a card filling the guide: two long edges too close together,
		// with the screen's text beyond them.
		const narrow = new Uint8Array(W * H).fill(30);

		for (let y = 3; y < H - 3; y++) {
			for (let x = 0; x < W; x++) {
				if (x >= 13 && x < W - 13) {
					narrow[y * W + x] = y % 6 < 2 ? 40 : 205;
				}
				else if ((x < 4 || x >= W - 4) && y % 5 < 2 && x % 3 === 0) {
					narrow[y * W + x] = 200;
				}
			}
		}

		assert.equal(presence(narrow, W, H).present, false);
	});

	// cardFrame turned by `degrees` about the thumbnail's centre, slightly
	// smaller so the turned card still mostly fits.
	function turnedFrame(degrees, size = 0.9) {
		const flat = cardFrame();
		const grey = new Uint8Array(W * H).fill(90);
		const radians = (degrees * Math.PI) / 180;

		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				const dx = (x - W / 2) / size;
				const dy = (y - H / 2) / size;
				const sx = Math.round(W / 2 + dx * Math.cos(radians) + dy * Math.sin(radians));
				const sy = Math.round(H / 2 - dx * Math.sin(radians) + dy * Math.cos(radians));

				if (sx >= 0 && sx < W && sy >= 0 && sy < H) {
					grey[y * W + x] = flat[sy * W + sx];
				}
			}
		}

		return grey;
	}

	test('sees a card turned up to about 20 degrees in the hand, either way (Q-16)', () => {
		for (const degrees of [-20, -12, -6, 6, 12, 20]) {
			const seen = presence(turnedFrame(degrees), W, H);

			assert.equal(seen.present, true, `turned ${degrees} degrees`);
		}

		assert.equal(presence(cardFrame(), W, H).turn, 0, 'a straight card is judged as it is');
	});

	test('regular stripes and a frame with no colour are not a card', () => {
		for (const period of [8, 10, 14, 20]) {
			const stripes = new Uint8Array(W * H).map((_, i) => (Math.floor((i % W) / (period / 2)) % 2 ? 235 : 25));
			const seen = presence(stripes, W, H);

			assert.equal(seen.present, false, `stripes ${period} px apart`);
			assert.equal(seen.reason, 'stripes');
		}

		assert.equal(presence(cardFrame(), W, H, {colour: 12}).present, true, 'a card with colour in its art');
		assert.equal(presence(cardFrame(), W, H, {colour: 0.4}).reason, 'colourless', 'the same shapes with no colour: paper');
	});

	test('colourfulness: artwork has colour, paper and a tint do not', () => {
		const rgba = (fn) => {
			const out = new Uint8ClampedArray(W * H * 4);

			for (let i = 0; i < W * H; i++) {
				out.set([...fn(i % W, Math.floor(i / W)), 255], i * 4);
			}

			return out;
		};
		const paper = rgba((x, y) => (y % 6 < 1 && x > 10 && x < 50 ? [40, 40, 40] : [245, 232, 205]));
		const art = rgba((x, y) => [(x * 37) % 255, (y * 53) % 255, ((x + y) * 29) % 255]);

		assert.ok(colourfulness(paper, W, H) < COLOURLESS, `paper ${colourfulness(paper, W, H)}`);
		assert.ok(colourfulness(art, W, H) > COLOURLESS * 3, `art ${colourfulness(art, W, H)}`);
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

describe('a card turned in the hand (Q-16)', () => {
	const W = 520;
	const H = 726;

	// A capture with a card as wide as the guide (the capture keeps a 6 %
	// margin) turned `degrees` clockwise about the centre, over a table, so
	// at 12 degrees and more its corners run out of the capture: a light
	// border, a busy art box, and text lines on a lighter text box.
	function turnedCapture(degrees) {
		const cw = W / 1.12;
		const ch = cw * 88 / 63;
		const radians = (degrees * Math.PI) / 180;
		const data = new Uint8ClampedArray(W * H * 4);

		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				const dx = x - W / 2;
				const dy = y - H / 2;
				const u = (dx * Math.cos(radians) + dy * Math.sin(radians)) / cw + 0.5;
				const v = (-dx * Math.sin(radians) + dy * Math.cos(radians)) / ch + 0.5;
				let value = 70;

				if (u >= 0 && u < 1 && v >= 0 && v < 1) {
					if (u < 0.04 || u > 0.96 || v < 0.03 || v > 0.97) {
						value = 215;
					}
					else if (u > 0.08 && u < 0.92 && v > 0.11 && v < 0.48) {
						value = 60 + ((Math.floor(u * 90) * 7 + Math.floor(v * 120) * 13) % 70);
					}
					else if (u > 0.1 && u < 0.8 && v > 0.55 && v < 0.85 && Math.floor(v * 100) % 5 === 0) {
						value = 45;
					}
					else {
						value = 180;
					}
				}

				data.set([value, value, value, 255], (y * W + x) * 4);
			}
		}

		return {cw, image: {data, height: H, width: W}};
	}

	test('turned up to 20 degrees either way, the card is found and stood straight at its own size', () => {
		for (const degrees of [-20, -12, -5, 0, 5, 12, 20]) {
			const {cw, image} = turnedCapture(degrees);
			const straight = rectify(image);

			assert.ok(straight.found, `${degrees} degrees: ${straight.note}`);
			assert.ok(Math.abs(straight.angle - degrees) <= 1.5, `${degrees} degrees read as ${straight.angle}`);
			assert.ok(Math.abs(straight.card.width - cw) <= cw * 0.06, `${degrees} degrees: ${straight.card.width} px wide, not ${Math.round(cw)}`);
			assert.ok(Math.abs(straight.card.height / straight.card.width - 88 / 63) <= 0.08, `${degrees} degrees: card-shaped`);
		}
	});
});

describe('a card photographed on a screen', () => {
	const W = 520;
	const H = 726;

	// The card's corners in an invented photo of it on a laptop screen, as
	// the capture cuts it: seen at a slant, so it is wider at the top, and
	// its widest row fills the guide while it is shorter than its shape.
	const CORNERS = [{x: 0.058 * W, y: 0.105 * H}, {x: 0.94 * W, y: 0.117 * H}, {x: 0.847 * W, y: 0.898 * H}, {x: 0.121 * W, y: 0.89 * H}];

	// The photo: a dark screen, the app's heading in large light letters
	// just above the card, the app's text beside it, a button under it, and
	// the screen's edge as a long straight line in the margin past the
	// card's right side.
	function screenPhoto() {
		const [tl, tr, br, bl] = CORNERS;
		const lerp = (a, b, t) => a + (b - a) * t;
		const data = new Uint8ClampedArray(W * H * 4);

		for (let y = 0; y < H; y++) {
			const xl = lerp(tl.x, bl.x, (y - tl.y) / (bl.y - tl.y));
			const xr = lerp(tr.x, br.x, (y - tr.y) / (br.y - tr.y));

			for (let x = 0; x < W; x++) {
				const yt = lerp(tl.y, tr.y, (x - tl.x) / (tr.x - tl.x));
				const yb = lerp(bl.y, br.y, (x - bl.x) / (br.x - bl.x));
				let value = x > 0.986 * W ? 5 : 27;

				if (x >= xl && x <= xr && y >= yt && y <= yb) {
					const u = (x - xl) / (xr - xl);
					const v = (y - yt) / (yb - yt);

					if (u < 0.035 || u > 0.965 || v < 0.025 || v > 0.975) {
						value = 200;
					}
					else if (u > 0.07 && u < 0.93 && v > 0.11 && v < 0.48) {
						value = 60 + ((x * 7 + y * 13) % 50);
					}
					else if (u > 0.1 && u < 0.8 && v > 0.55 && v < 0.85 && Math.floor(v * 100) % 5 === 0) {
						value = 40;
					}
					else {
						value = 175;
					}
				}
				else if (y > 0.035 * H && y < 0.075 * H && x > 0.06 * W && x < 0.45 * W && Math.floor(x / 9) % 3 !== 2) {
					value = 225;
				}
				else if (x > xr + 6 && x < 0.98 * W && y > 0.3 * H && y < 0.7 * H && (y / (0.06 * H)) % 1 < 0.4) {
					value = 210;
				}
				else if (x > 0.15 * W && x < 0.85 * W && y > 0.915 * H && y < 0.965 * H) {
					value = 55;
				}

				data.set([value, value, value, 255], (y * W + x) * 4);
			}
		}

		return {data, height: H, width: W};
	}

	test('the card is straightened to its own border, without the heading above it or the screen beside it', () => {
		const straight = rectify(screenPhoto());

		assert.ok(straight.found, straight.note);
		assert.ok(straight.corners, 'found as a slanted box');

		for (const [index, corner] of straight.corners.entries()) {
			const truth = CORNERS[index];

			assert.ok(Math.abs(corner.x - truth.x) <= W * 0.02 && Math.abs(corner.y - truth.y) <= H * 0.02, `corner ${index} at ${Math.round(corner.x)}, ${Math.round(corner.y)}, not ${Math.round(truth.x)}, ${Math.round(truth.y)}`);
		}
	});

	// What a read of that photo found before the fix: the heading read where
	// the name should be, and the hidden number misread.
	const sets = [
		{cardCount: {official: 86}, id: 'me04', name: 'Chaos Rising', serie: 'me'},
		{cardCount: {official: 5}, id: 'fut2020', name: 'Pokémon Futsal 2020', serie: 'misc'},
		{cardCount: {official: 165}, id: 'sv03.5', name: '151', serie: 'sv'},
	];
	const details = {
		fut2020: {
			cardCount: {official: 5},
			cards: [{id: 'fut2020-1', image: null, localId: '1', name: 'Pikachu on the Ball'}, {id: 'fut2020-2', image: null, localId: '2', name: 'Bulbasaur on the Ball'}],
			id: 'fut2020',
			name: 'Pokémon Futsal 2020',
			releaseDate: '2020-09-11',
		},
	};
	const prints = {
		13: [
			{cardId: 'me04-001', image: null, localId: '001', name: 'Weedle', releaseDate: '2026-03-27', setId: 'me04', setName: 'Chaos Rising'},
			{cardId: 'sv03.5-013', image: null, localId: '013', name: 'Weedle', releaseDate: '2023-09-22', setId: 'sv03.5', setName: '151'},
		],
	};
	const api = {
		allSets: async () => sets,
		setDetail: async (lang, id) => details[id] || {cardCount: {official: 0}, cards: [], id},
		species: async () => SPECIES,
		speciesPrints: async (dex) => prints[dex] || [],
	};
	const misread = {confidence: 0.44, number: '1', numberPrinted: '01', setCodeRun: '', side: 'left', total: '6', totalPrinted: '006'};

	test('a set\'s name read as the card\'s name is no name, and nothing is offered as the answer', async () => {
		assert.equal(E.setNameRead('Chaos Rising', sets, SPECIES), 'Chaos Rising');
		assert.equal(E.setNameRead('Weedle', sets, SPECIES), null);
		assert.equal(E.setNameRead('Pikachu', [{name: 'Pikachu'}], SPECIES), null, 'a set named for a species leaves the name alone');

		const heading = S.summariseRead(nameRead('Chaos Rising', {number: misread}));
		const found = await findCandidates(heading, 'en', {api});

		assert.equal(found.setName, 'Chaos Rising');
		assert.deepEqual(found.names, []);
		assert.equal(found.candidates[0].id, 'fut2020-1', 'the misread number still finds what it fits');

		const session = S.newSession(AT, 's1');
		const item = S.addCapture(session, {at: AT, id: 'w'});

		S.applyRead(session, 'w', heading, AT);
		S.applyMatch(session, 'w', found, AT);
		assert.equal(item.sure, false);
		assert.equal(item.card, null, 'no card preselected as if it were the answer');
		assert.equal(S.blocker(item), 'unsure', 'the candidates wait for a tap');
		assert.match(item.why, /01\/006 matches no card exactly/);
		assert.equal(S.searchPrefill(item), '', 'the set\'s name is not searched for as a name');
		assert.equal(S.readLine(item.read, {setName: item.readSetName}), 'Name: unreadable ("Chaos Rising" is a set\'s name), number: 01/006');

		S.chooseCard(session, 'w', {...prints[13][0], id: 'me04-001', lang: 'en', localId: '001', official: '86', reasons: ['search'], score: 0}, AT);
		assert.equal(item.card.id, 'me04-001');
		assert.equal(S.blocker(item), 'finishes', 'a tap settles it');
	});

	test('a doubtful number that fits no card exactly does not bury the cards the name found', async () => {
		// Misread as 02/006, a number neither Weedle print has.
		const weedle = S.summariseRead(nameRead('Weedle', {number: {...misread, number: '2', numberPrinted: '02'}}));
		const found = await findCandidates(weedle, 'en', {api});

		assert.deepEqual(found.routes, ['number', 'name']);
		assert.equal(found.candidates[0].name, 'Weedle', `the name route's prints come first, not ${found.candidates[0].id}`);
		assert.ok(found.candidates.findIndex((c) => c.id === 'fut2020-2') > 0);

		const session = S.newSession(AT, 's1');
		const item = S.addCapture(session, {at: AT, id: 'w'});

		S.applyRead(session, 'w', weedle, AT);
		S.applyMatch(session, 'w', found, AT);
		assert.equal(item.card, null, 'two Weedle prints are level: neither is shown as the answer');
		assert.equal(S.searchPrefill(item), 'Weedle');

		// One digit misread into the card's neighbour in its own set (001 as
		// 007, both of 132) read clearly enough to count, while the name read
		// names the card itself: never sure of the neighbour, and the named
		// card is there to pick.
		SPECIES[1] = 'Bulbasaur';

		const neighbours = {
			...api,
			allSets: async () => [...sets, {cardCount: {official: 132}, id: 'me01', name: 'Mega Evolution', serie: 'me'}],
			setDetail: async (lang, id) => (id === 'me01'
				? {abbreviation: {official: 'MEG'}, cardCount: {official: 132}, cards: [{id: 'me01-001', image: null, localId: '001', name: 'Bulbasaur'}, {id: 'me01-007', image: null, localId: '007', name: 'Tangrowth'}], id, name: 'Mega Evolution', releaseDate: '2025-09-26'}
				: api.setDetail(lang, id)),
			speciesPrints: async (dex) => (dex === 1 ? [{cardId: 'me01-001', image: null, localId: '001', name: 'Bulbasaur', releaseDate: '2025-09-26', setId: 'me01', setName: 'Mega Evolution'}] : []),
		};
		const slip = S.summariseRead(nameRead('Bylbasaur', {number: {confidence: 0.73, number: '7', numberPrinted: '007', setCodeRun: 'MEG', side: 'left', total: '132', totalPrinted: '132'}}));
		const both = await findCandidates(slip, 'en', {api: neighbours});

		assert.deepEqual(both.routes, ['number', 'name'], 'the name route runs although the number fits a card exactly');
		assert.ok(both.candidates.some((c) => c.id === 'me01-001'));

		const slipped = S.addCapture(session, {at: AT, id: 's'});

		S.applyRead(session, 's', slip, AT);
		S.applyMatch(session, 's', both, AT);
		assert.equal(slipped.sure, false, `not sure (${slipped.why})`);
		assert.ok(!slipped.card || slipped.card.id === 'me01-001', 'the neighbour is never chosen for the person');

		// A number and total that fit a card exactly, but read poorly, are
		// still a guess worth showing: preselected, and it needs a tap.
		const lead = S.addCapture(session, {at: AT, id: 'l'});

		S.applyRead(session, 'l', read('3', '131', undefined, 0.4), AT);
		S.applyMatch(session, 'l', {candidates: [candidate('sv08.5-003', {agree: ['number', 'total'], conflicts: []})]}, AT);
		assert.equal(lead.card.id, 'sv08.5-003');
		assert.equal(lead.sure, false);
		assert.equal(S.blocker(lead), 'unsure');
	});
});

describe('picture first (Eric, 2026-10-03)', () => {
	// A capture whose card has a light strip beside its right edge (a sleeve
	// edge, a margin of the screen), so the edges found make a box about 3 %
	// too wide, as on Eric's phone (0.733 to 0.740 against 0.716).
	function stripCapture() {
		const W = 520;
		const H = 726;
		const cw = W / 1.2;
		const ch = cw * 88 / 63;
		const x0 = (W - cw) / 2 - cw * 0.0175;
		const y0 = (H - ch) / 2;
		const strip = cw * 0.035;
		const data = new Uint8ClampedArray(W * H * 4);

		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				const u = (x - x0) / cw;
				const v = (y - y0) / ch;
				let value = 70;

				if (v >= 0 && v < 1 && u >= 0 && u < 1 + strip / cw) {
					if (u >= 1) {
						value = 215;
					}
					else if (u < 0.04 || u > 0.96 || v < 0.03 || v > 0.97) {
						value = 215;
					}
					else if (u > 0.08 && u < 0.92 && v > 0.11 && v < 0.48) {
						value = 60 + ((Math.floor(u * 90) * 7 + Math.floor(v * 120) * 13) % 70);
					}
					else {
						value = 180;
					}
				}

				data.set([value, value, value, 255], (y * W + x) * 4);
			}
		}

		return {data, height: H, width: W};
	}

	test('a box a few percent too wide is snapped to a card\'s shape, with the trimmed crops kept for the fingerprint', () => {
		const straight = rectify(stripCapture());

		assert.ok(straight.found, straight.note);
		assert.ok(straight.ratio > 0.725 && straight.ratio < 0.76, `the box measured ${straight.ratio}`);
		assert.ok(Math.abs(straight.card.width / straight.card.height - 63 / 88) < 0.006, `snapped: ${straight.card.width}x${straight.card.height}`);
		assert.deepEqual(straight.others.map((other) => other.how), ['trim left', 'trim right', 'trim both']);

		const trimmed = straight.cut(straight.others[1].rect, 402);

		assert.ok(Math.abs(trimmed.width / trimmed.height - 63 / 88) < 0.006, `the trimmed crop is card-shaped too: ${trimmed.width}x${trimmed.height}`);
	});

	const sets = {
		'en|me04': {cardCount: {official: 86}, cards: [{id: 'me04-001', image: 'https://img/me04-001', localId: '001', name: 'Weedle'}, {id: 'me04-090', image: 'https://img/me04-090', localId: '090', name: 'Ampharos'}], name: 'Chaos Rising'},
		'en|sv01': {cardCount: {official: 198}, cards: [{id: 'sv01-089', localId: '089', name: 'Drifloon'}], name: 'Scarlet & Violet'},
		'en|sv02': {cardCount: {official: 193}, cards: [{id: 'sv02-010', localId: '010', name: 'Other'}], name: 'Paldea Evolved'},
		'ja|M4': {cardCount: {official: 83}, cards: [{id: 'M4-001', image: 'https://img/M4-001', localId: '001', name: 'Weedle JA'}], name: 'M4'},
	};
	const api = {setDetail: async (lang, set) => sets[`${lang}|${set}`] || null};
	const card = (id, catalog, set, score) => ({catalog, id, image: `https://assets/${id}`, score, set});
	const number = (n, total, confidence = 0.9) => ({number: {confidence, number: n, numberPrinted: n, side: 'left', total, totalPrinted: total}});

	test('one card well ahead is the card, with no text read', async () => {
		const picture = {gap: 40, groups: [{cards: [card('me04-090', 'en', 'me04', 9)], score: 9}, {cards: [card('sv01-089', 'en', 'sv01', 49)], score: 49}]};

		assert.deepEqual(pictureVerdict(picture), {clear: true, close: true, several: false, sure: true});

		const found = await pictureMatch(picture, null, null, {api});

		assert.equal(found.card.id, 'me04-090');
		assert.equal(found.card.name, 'Ampharos');
		assert.equal(found.card.official, 86);
		assert.equal(found.sure, true);
	});

	test('the number chooses inside a group of prints that share the picture', async () => {
		const picture = {gap: 30, groups: [{cards: [card('me04-001', 'en', 'me04', 8), card('M4-001', 'ja', 'M4', 9)], score: 8}, {cards: [card('sv01-089', 'en', 'sv01', 38)], score: 38}]};

		assert.equal(pictureVerdict(picture).several, true);

		const found = await pictureMatch(picture, number('001', '083'), 'non-latin', {api});

		assert.equal(found.card.id, 'M4-001');
		assert.equal(found.sure, true);

		const unknown = await pictureMatch(picture, null, null, {api});

		assert.equal(unknown.card.id, 'me04-001', 'with no language known, the international record first');
		assert.equal(unknown.sure, false);
		assert.match(unknown.why, /2 cards share this picture/);
	});

	test('a picture and a number that disagree need a look, never a save', async () => {
		const picture = {gap: 40, groups: [{cards: [card('me04-001', 'en', 'me04', 9)], score: 9}, {cards: [card('sv02-010', 'en', 'sv02', 49)], score: 49}]};
		const found = await pictureMatch(picture, number('057', '086'), 'pt', {api});

		assert.equal(found.disagree, true);
		assert.equal(found.sure, false);
		assert.match(found.why, /looks like Weedle .* but the number reads 057\/086/);

		const session = S.newSession();
		const item = S.addCapture(session);

		S.applyPicture(session, item.id, found);
		assert.equal(item.card.id, 'me04-001');
		assert.equal(S.blocker(item), 'unsure');

		// One confused digit in the total is no disagreement (195 for 198).
		const near = await pictureMatch({gap: 40, groups: [{cards: [card('sv01-089', 'en', 'sv01', 9)], score: 9}]}, number('089', '195'), 'en', {api});

		assert.equal(near.disagree, false);
		assert.equal(near.sure, true);
	});

	test('a small lead offers the top five, and a number read that names one promotes it', async () => {
		const picture = {gap: 2, groups: [{cards: [card('sv01-089', 'en', 'sv01', 60)], score: 60}, {cards: [card('sv02-010', 'en', 'sv02', 62)], score: 62}, {cards: [card('me04-001', 'en', 'me04', 63)], score: 63}]};
		const found = await pictureMatch(picture, number('001', '086'), 'pt', {api});

		assert.equal(found.card.id, 'me04-001');
		assert.equal(found.sure, true);
		assert.equal(found.candidates.length, 3);

		const unsure = await pictureMatch(picture, null, 'pt', {api});

		assert.equal(unsure.card, null);
		assert.deepEqual(unsure.candidates.map((c) => c.id), ['sv01-089', 'sv02-010', 'me04-001']);
	});

	test('a number that names a set the catalog has not got yet offers Add by hand', async () => {
		const picture = {gap: 1, groups: [{cards: [card('sv01-089', 'en', 'sv01', 70)], score: 70}, {cards: [card('sv02-010', 'en', 'sv02', 71)], score: 71}]};
		const read = number('047', '076');

		read.number.setCodeRun = 'M6';

		const found = await pictureMatch(picture, read, 'ko', {api, textRoute: async () => ({candidates: []})});

		assert.deepEqual(found.hand, {language: 'ko', number: '047', setCode: 'M6', total: '076'});
		assert.match(found.why, /catalog has not got that set yet/);

		const session = S.newSession();
		const item = S.addCapture(session);

		S.applyPicture(session, item.id, found);
		S.addByHand(session, item.id, {language: 'ko', number: '047', setId: 'M6'});
		assert.equal(item.card.id, 'M6-047');
		assert.equal(item.card.lang, 'ja');
		assert.equal(S.blocker(item), null);
		assert.deepEqual(S.entriesToSave(session, new Map())[0].fields, {card_id: 'M6-047', catalog: 'ja', fallback: true, language: 'ko', language_source: 'scan', variant_id: null});
	});
});

describe('the guide on the screen and the capture around it (Eric, 2026-10-03)', () => {
	// Eric's phone: 384 CSS px wide, the rear camera 2160 x 3840 portrait,
	// and the video area above the tray a few hundred pixels tall.
	const frame = {height: 3840, width: 2160};

	test('the whole guide is inside the part of the video that shows, with a margin, at 63:88', () => {
		for (const height of [380, 410, 440, 470, 560]) {
			const stage = {height, width: 384};
			const {capture, guide, scale, screen} = layoutGuide(frame, stage);

			assert.ok(screen.y >= 13.9 && screen.y + screen.h <= height - 13.9, `${height}: top ${screen.y}, bottom ${screen.y + screen.h}`);
			assert.ok(screen.x >= 13.9 && screen.x + screen.w <= 384 - 13.9, `${height}: left ${screen.x}`);
			assert.ok(Math.abs(screen.w / screen.h - 63 / 88) < 0.001);
			// Never larger than the lab's guide, 0.86 of the frame's width.
			assert.ok(guide.w <= 2160 * 0.86 + 1, `${height}: guide ${guide.w}`);

			// The guide in frame pixels is the screen guide through the cover
			// scale: drawn back, it lands where the outline is.
			const offsetY = (height - frame.height * scale) / 2;

			assert.ok(Math.abs(guide.y * scale + offsetY - screen.y) < 1, `${height}: guide maps back`);
			// The capture holds the guide with room on every side, inside the
			// frame.
			assert.ok(capture.x >= 0 && capture.y >= 0 && capture.x + capture.w <= frame.width && capture.y + capture.h <= frame.height);
			assert.ok(guide.y - capture.y >= guide.h * 0.09 && capture.y + capture.h - (guide.y + guide.h) >= guide.h * 0.09, `${height}: room above and below`);
			assert.ok(guide.x - capture.x >= Math.min(guide.w * 0.09, guide.x) - 1, `${height}: room beside`);
		}
	});

	test('a short stage gives a smaller guide, not one cut off under the tray', () => {
		const short = layoutGuide(frame, {height: 410, width: 384});
		const tall = layoutGuide(frame, {height: 560, width: 384});

		assert.ok(short.screen.h <= 410 - 28);
		assert.ok(short.guide.h < tall.guide.h);
		// The lab's guide was about 461 px tall here whatever the stage.
		assert.ok(tall.screen.h > 455 && tall.screen.h < 462, `${tall.screen.h}`);
	});

	test('a landscape camera in a portrait stage keeps the guide on the drawn video', () => {
		const {screen, visible} = layoutGuide({height: 1080, width: 1920}, {height: 450, width: 360});

		assert.ok(screen.y >= visible.y && screen.y + screen.h <= visible.y + visible.h);
		assert.ok(screen.x >= visible.x && screen.x + screen.w <= visible.x + visible.w);
	});
});

describe('a weak picture with an edge worked out tries the box moved (Eric, 2026-10-03)', () => {
	// A synthetic capture: table 70, card border 215, body 180, and a busy
	// art box. lostTop: the card's top fifth is the colour of the table
	// (glare, or a light border on a light table), so its top edge is not
	// found where a card's shape puts it.
	function capture({lostTop = false} = {}) {
		const W = 520;
		const H = 726;
		const cw = W / 1.2;
		const ch = cw * 88 / 63;
		const x0 = (W - cw) / 2;
		const y0 = (H - ch) / 2;
		const top = lostTop ? 0.2 : 0;
		const data = new Uint8ClampedArray(W * H * 4);

		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				const u = (x - x0) / cw;
				const v = (y - y0) / ch;
				let value = 70;

				if (v >= top && v < 1 && u >= 0 && u < 1) {
					if (u < 0.04 || u > 0.96 || v > 0.97 || (!lostTop && v < 0.03)) {
						value = 215;
					}
					else if (u > 0.08 && u < 0.92 && v > 0.25 && v < 0.48) {
						value = 60 + ((Math.floor(u * 90) * 7 + Math.floor(v * 120) * 13) % 70);
					}
					else {
						value = 180;
					}
				}

				data.set([value, value, value, 255], (y * W + x) * 4);
			}
		}

		return {data, height: H, width: W};
	}

	test('the top edge is reported as guessed, with crops moved up and down to try', () => {
		const straight = rectify(capture({lostTop: true}));

		assert.ok(straight.found, straight.note);
		assert.equal(straight.guessed, 'top');
		assert.ok(straight.variants.length >= 2, `${straight.variants.length} variants`);
		assert.ok(straight.variants.some((v) => /up/.test(v.how)) && straight.variants.some((v) => /down/.test(v.how)));

		const moved = straight.variant(straight.variants[0], 402);

		assert.equal(moved.height, 402);
		assert.ok(Math.abs(moved.width / moved.height - 63 / 88) < 0.006);
	});

	test('the moves reach 12 % up and down, and the box made larger and smaller (Eric, 2026-10-03, version 25)', () => {
		const straight = rectify(capture({lostTop: true}));
		const hows = straight.variants.map((v) => v.how);

		assert.ok(hows.includes('moved up 12 %') || hows.includes('moved up 9 %'), hows.join(', '));
		assert.ok(hows.includes('moved down 12 %'), hows.join(', '));
		assert.ok(hows.includes('larger by 8 %') && hows.includes('smaller by 7 %'), hows.join(', '));
		assert.ok(hows.includes('larger by 8 %, from the bottom edge'), hows.join(', '));

		const larger = straight.variants.find((v) => v.how === 'larger by 8 %');

		assert.ok(Math.abs(larger.rect.w / straight.rect.w - 1.08) < 0.01);
	});

	test('a card with all four edges found has nothing guessed; its moves are there for a weak match', () => {
		const straight = rectify(capture());

		assert.ok(straight.found, straight.note);
		assert.equal(straight.guessed, null);
		assert.ok(straight.variants.every((v) => v.how !== 'hung from the top edge found'));
	});
});

describe('a silver border on a light table (synthetic, version 25 geometry, 2026-10-03)', () => {
	// Table 224, the card's border 222 inside a thin outline of 196 (all a
	// silver border shows against a light table), its inner line a strong
	// step to a green body at 150, and a busy art box. The card fills the
	// guide, which the capture pads by 10 %.
	function lightTable() {
		const W = 600;
		const H = Math.round(W * 1.2 * 88 / 63 / 1.2);
		const cw = W / 1.2;
		const ch = cw * 88 / 63;
		const x0 = (W - cw) / 2;
		const y0 = (H - ch) / 2;
		const data = new Uint8ClampedArray(W * H * 4);

		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				const u = (x - x0) / cw;
				const v = (y - y0) / ch;
				let value = 224 + ((x * 7 + y * 13) % 5) - 2;

				if (u >= 0 && u < 1 && v >= 0 && v < 1) {
					const outline = Math.min(u * cw, (1 - u) * cw, v * ch, (1 - v) * ch) < 1.5;

					if (outline) {
						value = 196;
					}
					else if (u < 0.045 || u > 0.955 || v < 0.035 || v > 0.965) {
						value = 222;
					}
					else if (u > 0.08 && u < 0.92 && v > 0.11 && v < 0.5) {
						value = 50 + ((Math.floor(u * 90) * 7 + Math.floor(v * 120) * 13) % 90);
					}
					else {
						value = 150;
					}
				}

				data.set([value, value, value, 255], (y * W + x) * 4);
			}
		}

		return {cw, data, height: H, width: W, x0};
	}

	test('the sides are the card\'s outline, not the border\'s inner line', () => {
		const image = lightTable();
		const straight = rectify(image);
		const left = straight.rect ? straight.rect.x : Math.min(...straight.corners.map((p) => p.x));
		const width = straight.rect ? straight.rect.w : Math.max(...straight.corners.map((p) => p.x)) - left;

		assert.ok(straight.found, straight.note);
		assert.ok(Math.abs(width - image.cw) <= image.cw * 0.02, `width ${width} against ${image.cw}: ${straight.note}`);
		assert.ok(Math.abs(left - image.x0) <= image.cw * 0.02, `left ${left} against ${image.x0}`);
	});
});

describe('when the picture is sure (Eric\'s phone, 2026-10-03)', () => {
	const card = (id, score) => ({catalog: 'en', id, image: null, score, set: id.split('-')[0]});
	const picture = (score, gap, cards = 1) => ({gap, groups: [{cards: Array.from({length: cards}, (_, i) => card(`me04-0${10 + i}`, score)), score}, {cards: [card('sv01-001', score + gap)], score: score + gap}]});

	test('close with a clear lead is sure; a good capture was about 30 away', () => {
		assert.equal(pictureVerdict(picture(29.2, 42.7)).sure, true);
		assert.equal(pictureVerdict(picture(31.6, 30.4)).sure, true);
		assert.equal(pictureVerdict(picture(45, 10)).sure, true);
	});

	test('between 45 and 60 the lead counts, but only the number makes it sure', () => {
		const verdict = pictureVerdict(picture(52, 20));

		assert.equal(verdict.clear, true);
		assert.equal(verdict.sure, false);
	});

	test('past 60 nothing is clear, whatever the lead: that is a wrong crop', () => {
		for (const [score, gap] of [[68.5, 3.5], [68.4, 1.4], [76.1, 0.1], [65, 25]]) {
			const verdict = pictureVerdict(picture(score, gap));

			assert.equal(verdict.clear, false, `${score}`);
			assert.equal(verdict.sure, false, `${score}`);
		}
	});

	test('a one-card group past SURE_DISTANCE with no number read is shown, not sure', async () => {
		const api = {setDetail: async () => ({cardCount: {official: 100}, cards: [{id: 'me04-010', localId: '010', name: 'Card'}], name: 'Set'})};
		const found = await pictureMatch(picture(52, 20), null, 'pt', {api});

		assert.equal(found.card.id, 'me04-010');
		assert.equal(found.sure, false);
	});
});

describe('auto-capture with a card held by hand (Eric, 2026-10-03)', () => {
	const W = THUMB_W;
	const H = THUMB_H;

	// A card of `size` (a share of the thumbnail's width, card-shaped),
	// centred and moved by dx, dy pixels (fractions too: each pixel averages
	// 4 x 4 samples, as a camera's does), on a table with some texture of
	// its own (so nothing beyond the card is flat), the card's face light
	// with dark text lines and a busy art box that move with it.
	function heldCard(size, dx = 0, dy = 0) {
		const grey = new Uint8Array(W * H);
		const cw = W * size;
		const ch = cw * 88 / 63;
		const left = (W - cw) / 2 + dx;
		const top = (H - ch) / 2 + dy;
		const at = (px, py) => {
			const u = (px - left) / cw;
			const v = (py - top) / ch;

			if (u < 0 || u >= 1 || v < 0 || v >= 1) {
				return 70 + ((Math.floor(px) * 5 + Math.floor(py) * 3) % 9);
			}

			if (u > 0.1 && u < 0.9 && v > 0.12 && v < 0.5) {
				return 60 + ((Math.floor(u * 40) * 37 + Math.floor(v * 50) * 23) % 120);
			}

			return v > 0.55 && Math.floor(v * 40) % 3 === 0 && u > 0.1 && u < 0.8 ? 50 : 215;
		};

		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				let sum = 0;

				for (let sy = 0; sy < 4; sy++) {
					for (let sx = 0; sx < 4; sx++) {
						sum += at(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4);
					}
				}

				grey[y * W + x] = Math.round(sum / 16);
			}
		}

		return grey;
	}

	test('a card held smaller than the guide, a little off its middle, is seen', () => {
		for (const [size, dx, dy] of [[0.6, 0, 0], [0.62, 3, -2], [0.7, -2, 3]]) {
			assert.equal(presence(heldCard(size, dx, dy), W, H).present, true, `${size} at ${dx}, ${dy}`);
		}
	});

	test('a box the wrong shape for a card is not', () => {
		const grey = new Uint8Array(W * H).fill(72);

		// Square, half the thumbnail across.
		for (let y = 22; y < 54; y++) {
			for (let x = 16; x < 48; x++) {
				grey[y * W + x] = (x + y) % 5 ? 210 : 60;
			}
		}

		assert.equal(presence(grey, W, H).present, false);
	});

	// A hand shaking by 0.6 of a thumbnail pixel (about 1 % of the capture's
	// width) between frames: the full thumbnails differ by more than STILL
	// (the old rule never fired), their coarse copies by about half of it.
	test('a hand that shakes about 1 % of the width still takes the picture within half a second', () => {
		const detector = createAutoCapture();
		const shake = [[0, 0], [0.6, 0], [0, 0], [0.6, 0], [0, 0], [0.6, 0], [0, 0]];

		assert.ok(difference(heldCard(0.8), heldCard(0.8, 0.6, 0)) > 6, 'the old rule saw this as moving');
		let frames = 0;
		let fired = false;

		for (const [dx, dy] of [...shake, ...shake]) {
			const frame = heldCard(0.8, dx, dy);

			frames++;

			if (detector.push(frame, presence(frame, W, H))) {
				fired = true;
				break;
			}
		}

		assert.ok(fired, 'captured');
		assert.ok(frames <= 5, `after ${frames} frames (${frames * 125} ms)`);
	});

	test('the same card, still shaking a little, is not taken twice', () => {
		const detector = createAutoCapture();
		let fired = 0;

		for (let i = 0; i < 40; i++) {
			const frame = heldCard(0.8, i % 2 ? 0.6 : 0, 0);

			if (detector.push(frame, presence(frame, W, H))) {
				fired++;
				detector.captured(frame);
			}
		}

		assert.equal(fired, 1);
	});
});

describe('the language of a card the picture settled (Eric, 2026-10-03)', () => {
	const settled = () => {
		const session = S.newSession(AT, 's1');
		const item = S.addCapture(session, AT);

		S.applyPicture(session, item.id, {candidates: [], card: {id: 'me04-090', image: 'https://img/en/me04-090', lang: 'en', localId: '090', name: 'Ampharos', official: 86, setId: 'me04', setName: 'Chaos Rising'}, sure: true}, AT);

		return {item, session};
	};

	test('starts in the last language picked, and a label read clearly naming another corrects it', () => {
		const {item, session} = settled();

		assert.equal(S.defaultLanguage(session, item.id, 'pt', AT), true);
		assert.equal(item.language, 'pt');
		assert.equal(item.languageBy, 'default');
		assert.notEqual(S.blocker(item), 'language', 'a language is set, so it does not hold the save');

		assert.equal(S.applyLabel(session, item.id, {code: 'en', confidence: 0.3}, AT), false, 'a weak read leaves it');
		assert.equal(item.language, 'pt');
		assert.equal(S.applyLabel(session, item.id, {code: 'en', confidence: 0.67, ms: 240, text: 'Weakness Resistance'}, AT), true);
		assert.equal(item.language, 'en');
		assert.equal(item.languageBy, 'read');
		assert.match(S.reportText(item, {at: AT}), /Label row read in the background: en \(67 %\), 240 ms/);
	});

	test('a label that agrees confirms it; a language picked by hand is never changed', () => {
		const {item, session} = settled();

		S.defaultLanguage(session, item.id, 'pt', AT);
		assert.equal(S.applyLabel(session, item.id, {code: 'pt', confidence: 1}, AT), false);
		assert.equal(item.languageBy, 'read');

		const other = settled();

		S.setLanguage(other.session, other.item.id, 'fr', 'hand', AT);
		assert.equal(S.defaultLanguage(other.session, other.item.id, 'pt', AT), false);
		assert.equal(S.applyLabel(other.session, other.item.id, {code: 'en', confidence: 1}, AT), false);
		assert.equal(other.item.language, 'fr');
	});

	test('a Japanese record keeps its hint rather than the last Western pick', () => {
		const session = S.newSession(AT, 's1');
		const item = S.addCapture(session, AT);

		S.applyPicture(session, item.id, {candidates: [], card: {id: 'M4-001', lang: 'ja', localId: '001', name: 'Weedle JA', setId: 'M4'}, sure: true}, AT);
		assert.equal(S.defaultLanguage(session, item.id, 'pt', AT), false);
		assert.equal(item.language, null);
	});

	test('the Portuguese print\'s name and picture are shown, and the English ones come back', async () => {
		const {item, session} = settled();
		const api = {setDetail: async (lang, set) => (lang === 'pt' && set === 'me04' ? {cards: [{id: 'me04-090', image: 'https://img/pt/me04-090', localId: '090', name: 'Ampharos PT'}], name: 'Caos Crescente'} : null)};
		const local = await localPrint(item.card, 'pt', {api});

		assert.deepEqual(local, {image: 'https://img/pt/me04-090', lang: 'pt', name: 'Ampharos PT', setName: 'Caos Crescente'});
		assert.equal(await localPrint(item.card, 'en', {api}), null);
		assert.equal(await localPrint(item.card, 'fr', {api}), null, 'no French record');

		S.localisePrint(session, item.id, 'me04-090', local, AT);
		assert.equal(item.card.name, 'Ampharos PT');
		assert.equal(item.card.setName, 'Caos Crescente');
		assert.equal(item.card.id, 'me04-090', 'still saved against the same record');
		assert.equal(item.card.catalog, 'international');

		S.localisePrint(session, item.id, 'me04-090', null, AT);
		assert.equal(item.card.name, 'Ampharos');
		assert.equal(item.card.image, 'https://img/en/me04-090');
		assert.equal(item.card.own, undefined);
	});
});

describe('a picture match shown at once from what the phone has (Eric, 2026-10-03)', () => {
	const card = (id, score) => ({catalog: 'en', id, image: `https://assets/${id}`, score, set: id.split('-')[0]});
	const picture = {gap: 30, groups: [{cards: [card('me04-058', 29)], score: 29}, {cards: [card('sv01-001', 59)], score: 59}]};

	test('a set record that is slow to come is not waited for: the card index names the card', async () => {
		const slow = {setDetail: () => new Promise((resolve) => setTimeout(() => resolve({cardCount: {official: 86}, cards: [{id: 'me04-058', localId: '058', name: 'Slowking'}], name: 'Chaos Rising'}), 400))};
		const index = new Map([['international|me04-058', {catalog: 'international', id: 'me04-058', localizations: {en: {image: 'https://img/me04-058', lang: 'en', name: 'Slowking', set_name: 'Chaos Rising'}}, official: 86}]]);
		const started = Date.now();
		const quick = await pictureMatch(picture, null, 'pt', {api: slow, known: knownFrom(index), wait: 50});

		assert.ok(Date.now() - started < 300, `${Date.now() - started} ms`);
		assert.equal(quick.card.name, 'Slowking');
		assert.equal(quick.card.setName, 'Chaos Rising');
		assert.equal(quick.card.official, 86);
		assert.equal(quick.sure, true);
		assert.equal(quick.unnamed, false);

		// Not in the card index either: named by its id for now, with the
		// index's own picture.
		const bare = await pictureMatch(picture, null, 'pt', {api: slow, known: knownFrom(new Map()), wait: 50});

		assert.equal(bare.card.id, 'me04-058');
		assert.equal(bare.card.image, 'https://assets/me04-058');
		assert.equal(bare.unnamed, true);
	});
});

describe('the scan report says where the guide was and what was guessed (Eric, 2026-10-03)', () => {
	test('guide and capture geometry, a guessed edge, the moved crops tried, and the lookup in two steps', () => {
		const session = S.newSession(AT, 's1');
		const item = S.addCapture(session, AT);
		const result = {
			angle: 1.3,
			card: {height: 1400, width: 1002},
			found: true,
			guessed: 'top',
			note: 'Card edges found; top edge worked out from the width.',
			ocr: false,
			picture: {before: 68.4, gap: 21.5, groups: [{cards: [{id: 'me04-023'}], score: 31.2}, {cards: [{id: 'sv01-001'}], score: 52.7}], how: 'moved up 3 %', variants: ['moved up 6 %', 'moved up 3 %', 'moved down 3 %']},
			ratio: 0.716,
			read: null,
			timings: {fingerprint: 30, match: 40, rectify: 80, total: 160},
		};

		item.report = S.reportOfRead(result, {captureMs: 25, frame: '2106 x 2942', geometry: {capture: '2106 x 2942 at 27, 449', frame: '2160 x 3840', guide: '1755 x 2452 at 202, 694', how: 'auto', screen: '312 x 436 at 36, 14', stage: '384 x 464'}});
		item.report.match = S.reportOfMatch({candidates: [], routes: ['picture']}, {fullMs: 2400, language: 'pt', ms: 90});

		const text = S.reportText(item, {at: AT});

		assert.match(text, /- Capture: 25 ms \(taken automatically\)/);
		assert.match(text, /- Guide: 312 x 436 at 36, 14 on a 384 x 464 screen area; in the 2160 x 3840 frame, guide 1755 x 2452 at 202, 694, captured 2106 x 2942 at 27, 449/);
		assert.match(text, /- Edges: left, right, and bottom found; top GUESSED/);
		assert.match(text, /- Crops tried for a weak match: moved up 6 %, moved up 3 %, moved down 3 %; moved up 3 % won \(the crop as found was 68.4 away\)/);
		assert.match(text, /- Catalog lookup: shown after 90 ms from what the phone had; full records 2400 ms/);
	});
});
