// The stage label reader (js/scan/read.js stageLanguage, stageCrop) and how
// a binder pocket takes its answer (js/scan/session.js applyStage). The OCR
// strings are ones the reader produced on Eric's binder pages (2026-11-19).

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {STAGE_CROPS, stageCrop, stageLanguage} from '../js/scan/read.js';
import {addCapture, applyPicture, applyStage, defaultLanguage, newSession, setForAll, setLanguage} from '../js/scan/session.js';

describe('the language a stage label names (stageLanguage)', () => {
	test('reads Portuguese from BÁSICO, ESTÁGIO, Pokémon Básico, and Evolui de, however the OCR garbles them', () => {
		for (const text of ['BÁSICO Charmander', '8ASICO', 'Pekimen BISICO', 'NASICO', 'STAGO', 'STAGKO', 'STAG', 'ESTARIO 1', 'Evolui de Weedle', 'ESTÁGIO 1 Kakuna']) {
			assert.equal(stageLanguage(text).code, 'pt', text);
		}
	});

	test('reads English from BASIC, STAGE, Basic Pokémon, and Evolves from', () => {
		for (const text of ['BASIC Rattata', 'Basic Pokémon Squirtle', 'STAGE 1', 'Evolves from Squirtle', 'EVOLVES']) {
			assert.equal(stageLanguage(text).code, 'en', text);
		}
	});

	test('BASICO and BASIC never vote for each other, and STAG with no E after it is never STAGE', () => {
		assert.deepEqual(stageLanguage('BASICO').votes, {en: 0, pt: 1});
		assert.deepEqual(stageLanguage('BASIC').votes, {en: 1, pt: 0});
		assert.equal(stageLanguage('STAGO').code, 'pt');
		assert.equal(stageLanguage('STAGE').code, 'en');
	});

	test('names nothing for a name alone, noise, or a split vote', () => {
		for (const text of ['Caterple', 'Pidgeotto', '== ~~ a a', '', 'BASIC BASICO']) {
			assert.equal(stageLanguage(text).code, null, text);
		}
	});

	test('a vote three times the other wins', () => {
		assert.equal(stageLanguage('BASICO BASICO BASICO STAGE').code, 'pt');
	});
});

describe('a stage crop (stageCrop)', () => {
	test('is scaled to the text height asked and stretched to full contrast', () => {
		const card = {data: new Uint8ClampedArray(100 * 140 * 4), height: 140, width: 100};

		for (let i = 0; i < 100 * 140; i++) {
			const v = (i % 100) < 50 ? 100 : 140;

			card.data.set([v, v, v, 255], i * 4);
		}

		const [line] = STAGE_CROPS;
		const rect = {h: line.h * 140, w: line.w * 100, x: line.x * 100, y: line.y * 140};
		const crop = stageCrop(card, rect, line.textPx / (line.text * 140));

		assert.equal(crop.height, Math.round(rect.h * (line.textPx / (line.text * 140))));
		let low = 255;
		let high = 0;

		for (let i = 0; i < crop.data.length; i += 4) {
			low = Math.min(low, crop.data[i]);
			high = Math.max(high, crop.data[i]);
		}

		assert.equal(low, 0);
		assert.equal(high, 255);
	});
});

describe('a binder pocket takes its stage label\'s language (applyStage)', () => {
	const english = {catalog: 'international', id: 'base5-46', lang: 'en', localId: '46', name: 'Dark Wartortle', official: '82', setId: 'base5'};
	const japanese = {catalog: 'ja', id: 'SV9-001', lang: 'ja', localId: '001', name: 'キャタピー', official: '100', setId: 'SV9'};

	function pocket(card, {page = 8} = {}) {
		const session = newSession();
		const item = addCapture(session);

		if (page) {
			item.page = page;
		}

		applyPicture(session, item.id, {candidates: [card], card, sure: false});
		defaultLanguage(session, item.id, 'pt');

		return {item, session};
	}

	test('a pocket defaulted to Portuguese whose label reads English becomes English, read from its stage label', () => {
		const {item, session} = pocket(english);

		assert.equal(item.language, 'pt');
		assert.equal(applyStage(session, item.id, {code: 'en', text: 'Evolves from Squirtle', votes: {en: 1, pt: 0}}), true);
		assert.equal(item.language, 'en');
		assert.equal(item.languageBy, 'stage');
		assert.equal(item.stageCheck.text, 'Evolves from Squirtle', 'kept for the scan log');
	});

	test('the page\'s language row (setForAll, onlyDefault) leaves a language read off the stage label', () => {
		const read = pocket(english);
		const unread = pocket(english, {page: 7});

		applyStage(read.session, read.item.id, {code: 'pt', text: 'BASICO'});
		read.item.languageBy = 'stage';

		const session = read.session;

		session.items.push(unread.item);
		assert.equal(unread.item.language, 'pt', 'a default to start with');
		setForAll(session, 'language', 'en', {ids: [read.item.id, unread.item.id], onlyDefault: true});
		assert.equal(read.item.language, 'pt', 'the stage read stays');
		assert.equal(read.item.languageBy, 'stage');
		assert.equal(unread.item.language, 'en', 'the default takes the row\'s');
	});

	test('no answer, a language picked by hand, a card not from a page, or a Japanese record is left alone', () => {
		const none = pocket(english);

		assert.equal(applyStage(none.session, none.item.id, {code: null, text: 'Caterple'}), false);
		assert.equal(none.item.language, 'pt');

		const picked = pocket(english);

		setLanguage(picked.session, picked.item.id, 'pt');
		assert.equal(applyStage(picked.session, picked.item.id, {code: 'en'}), false);
		assert.equal(picked.item.language, 'pt');

		const single = pocket(english, {page: null});

		assert.equal(applyStage(single.session, single.item.id, {code: 'en'}), false);

		const asian = pocket(japanese);

		assert.equal(applyStage(asian.session, asian.item.id, {code: 'en'}), false);
	});
});
