// Japanese and Korean names on the name strip (Eric, 2026-11-04): the
// folding and matching of js/scan/cjk.js, when the Japanese or Korean model
// is loaded (cjk.js wantsCjk, read.js readName, ocr.js createAsianReader),
// the name table shipped with the app (js/scan/asian-names.json), and the
// name route that finds the Japanese record a Korean copy sits on
// (js/scan/match.js findCandidates, js/scan/picture.js pictureMatch). Node
// only: the OCR is a fake, TCGdex and PokeAPI are never asked, and the
// strings the fake OCR returns are invented.
//
// Run: node --test tests/scan-cjk.test.mjs

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test, {describe} from 'node:test';

import * as C from '../js/scan/cjk.js';
import * as E from '../js/scan/evidence.js';
import {loadAsianNames} from '../js/scan/local-names.js';
import {asianNamedPrintsFrom, asianNamedPrintsPath, findCandidates} from '../js/scan/match.js';
import {ASIAN_MODELS, createAsianReader} from '../js/scan/ocr.js';
import {pictureMatch} from '../js/scan/picture.js';
import {OCR_SETTINGS, readCard, readNumber} from '../js/scan/read.js';
import * as S from '../js/scan/session.js';

const TABLE = JSON.parse(readFileSync(new URL('../js/scan/asian-names.json', import.meta.url), 'utf8'));
const WESTERN = JSON.parse(readFileSync(new URL('../js/scan/local-names.json', import.meta.url), 'utf8'));
const ENTRIES = C.asianNameEntries(TABLE, WESTERN.species.en.split('|'));

// ------------------------------------------------------------ images

const blank = (width, height, value = 255) => {
	const data = new Uint8ClampedArray(width * height * 4);

	for (let i = 0; i < width * height; i++) {
		data.set([value, value, value, 255], i * 4);
	}

	return {data, height, width};
};

const paint = (image, x0, y0, w, h, value) => {
	for (let y = Math.max(0, y0); y < Math.min(image.height, y0 + h); y++) {
		for (let x = Math.max(0, x0); x < Math.min(image.width, x0 + w); x++) {
			image.data.set([value, value, value, 255], (y * image.width + x) * 4);
		}
	}
};

// A Hangul-like syllable: thin strokes over a square, with a closed loop
// (ㅁ) beside a vowel bar that touches it, and a stroke along the bottom.
function syllable(image, x, y, size) {
	const stroke = Math.max(2, Math.round(size / 10));
	const box = Math.round(size * 0.5);

	paint(image, x, y, box, stroke, 0);
	paint(image, x, y + box - stroke, box, stroke, 0);
	paint(image, x, y, stroke, box, 0);
	paint(image, x + box - stroke, y, stroke, box, 0);
	paint(image, x + box, y, stroke, size, 0);
	paint(image, x + box, y + Math.round(size * 0.3), Math.round(size * 0.25), stroke, 0);
	paint(image, x, y + size - stroke, Math.round(size * 0.75), stroke, 0);
}

// A Latin-like word: narrow letters, most of them x-height (a little over
// half the capitals), one capital and one tall letter.
function word(image, x, y, size) {
	const stroke = Math.max(2, Math.round(size / 8));
	const xh = Math.round(size * 0.55);
	let at = x;

	for (const [tall, wide] of [[1, 0.55], [0, 0.45], [0, 0.45], [1, 0.12], [0, 0.45], [0, 0.4], [0, 0.45]]) {
		const h = tall ? size : xh;
		const w = Math.round(size * wide);

		paint(image, at, y + size - h, stroke, h, 0);
		paint(image, at + w - stroke, y + size - h, stroke, h, 0);
		paint(image, at, y + size - stroke, w, stroke, 0);
		at += w + Math.round(size * 0.12);
	}
}

// ------------------------------------------------------------ folding

describe('folding Japanese and Korean names', () => {
	test('full and half width, hiragana and katakana, small kana, and voicing marks fold to one key', () => {
		const key = C.cjkKey('ピカチュウ');

		assert.equal(C.cjkKey('ﾋﾟｶﾁｭｳ'), key, 'half-width katakana');
		assert.equal(C.cjkKey('ぴかちゅう'), key, 'hiragana');
		assert.equal(C.cjkKey('ピカチユウ'), key, 'a small kana read full size');
		assert.equal(C.cjkKey('ヒカチュウ'), key, 'the handakuten lost');
		assert.equal(C.cjkKey('ピカチュウex'), key, 'the suffix in Latin letters');
		assert.equal(C.cjkKey('ピカチュウ ＥＸ'), key, 'a full-width suffix');
	});

	test('the kanji and marks the Japanese model reads for katakana fold to the katakana', () => {
		assert.equal(C.cjkKey('口コン'), C.cjkKey('ロコン'), '口 for ロ');
		assert.equal(C.cjkKey('リザ一ドン'), C.cjkKey('リザードン'), 'the kanji one for the long vowel mark');
		assert.equal(C.cjkKey('リザ-ドン'), C.cjkKey('リザードン'), 'a hyphen for it');
		assert.equal(C.cjkKey('ミ二ーブ'), C.cjkKey('ミニーブ'), '二 for ニ');
		assert.equal(C.cjkKey('力イリュー'), C.cjkKey('カイリュー'), '力 for カ');
		assert.equal(C.cjkKey('シ'), C.cjkKey('ツ'), 'シ and ツ');
	});

	test('Hangul composed, spelled out in jamo, or in compatibility jamo is one key', () => {
		const key = C.cjkKey('피카츄');

		assert.equal(C.cjkKey('피카츄'.normalize('NFD')), key);
		assert.equal(C.cjkKey('ㅍㅣㅋㅏㅊㅠ'), key, 'compatibility jamo');
		assert.ok(key.length > 3, 'a syllable is spelled out, so one misread stroke is one letter of several');
	});

	test('the script of a read', () => {
		assert.equal(C.scriptOf('피카츄V'), 'ko');
		assert.equal(C.scriptOf('ピカチュウV'), 'ja');
		assert.equal(C.scriptOf('博士の研究'), 'ja');
		assert.equal(C.scriptOf('Pikachu'), null);
		assert.equal(C.hasCjk(''), false);
	});
});

// ------------------------------------------------------------ matching

describe('matching Japanese and Korean names', () => {
	test('a Japanese read finds its species, with its English name, through OCR lookalikes and a glued stage label', () => {
		assert.deepEqual(C.matchCjkNames('ピカチユウ', ENTRIES)[0], {dex: 25, lang: 'ja', name: 'Pikachu', score: 1, spelling: 'ピカチュウ'});
		assert.equal(C.matchCjkNames('たねピカチュウ', ENTRIES)[0].dex, 25, 'the stage label read with it');
		assert.equal(C.matchCjkNames('口コン', ENTRIES)[0].name, 'Vulpix');
		assert.equal(C.matchCjkNames('ﾐﾆｰﾌﾞ', ENTRIES)[0].name, 'Smoliv');
	});

	test('a Korean read finds its species, a stroke misread', () => {
		assert.deepEqual(C.matchCjkNames('피카츄', ENTRIES)[0], {dex: 25, lang: 'ko', name: 'Pikachu', score: 1, spelling: '피카츄'});
		assert.equal(C.matchCjkNames('피카추', ENTRIES)[0].dex, 25, 'ㅠ read as ㅜ');
		assert.equal(C.matchCjkNames('헤라크로스', ENTRIES)[0].name, 'Heracross');
		assert.equal(C.matchCjkNames('질퍽이', ENTRIES)[0].name, 'Grimer');
	});

	test('a short name must read exactly: Mew is not found inside Mewtwo', () => {
		const found = C.matchCjkNames('뮤츠', ENTRIES);

		assert.equal(found[0].name, 'Mewtwo');
		assert.ok(!found.some((match) => match.name === 'Mew' && match.score >= 0.75));
	});

	test('a Korean read is never matched to a Japanese name, nor a Japanese one to Korean', () => {
		assert.ok(C.matchCjkNames('피카츄', ENTRIES).every((match) => match.lang === 'ko'));
		assert.ok(C.matchCjkNames('ピカチュウ', ENTRIES).every((match) => match.lang === 'ja'));
		assert.deepEqual(C.matchCjkNames('Pikachu', ENTRIES), []);
	});

	test('a Japanese Trainer is found by its Japanese name', () => {
		assert.deepEqual(C.matchCjkNames('博士の研究', ENTRIES)[0], {dex: null, lang: 'ja', name: '博士の研究', score: 1, spelling: '博士の研究', trainer: true});
	});

	test('the species a printed Japanese or Korean record name is', () => {
		assert.equal(C.dexOfCjkName('ヘラクロス', ENTRIES), 214);
		assert.equal(C.dexOfCjkName('メガグソクムシャex', ENTRIES), 768, 'a Mega prefix');
		assert.equal(C.dexOfCjkName('ゼラオラVMAX', ENTRIES), 807);
		assert.equal(C.dexOfCjkName('잠만보', ENTRIES), 143);
		assert.equal(C.dexOfCjkName('カビゴンドール', ENTRIES), null, 'a Trainer named after a Pokémon');
	});

	test('a card found by its number agrees with a Japanese or Korean name read, and never by an empty Latin key', () => {
		const clues = E.cluesOf({name: {confidence: 0.9, text: 'ヘラクロス'}, names: C.matchCjkNames('ヘラクロス', ENTRIES)});

		assert.ok(E.scoreCard(clues, {localId: '001', name: 'ヘラクロス', official: '76'}).agree.includes('name'), 'its own Japanese name');
		assert.ok(!E.scoreCard(clues, {localId: '002', name: 'アメタマ', official: '76'}).agree.includes('name'), 'another Japanese name');
		assert.ok(E.scoreCard(clues, {localId: '010', name: 'Heracross', official: '76'}).agree.includes('name'), 'the English print, through the English name');

		const trainer = E.cluesOf({name: {confidence: 0.9, text: '博士の研究'}, names: C.matchCjkNames('博士の研究', ENTRIES)});

		assert.ok(!E.scoreCard(trainer, {localId: '070', name: 'ネストボール', official: '78'}).agree.includes('name'), 'two Japanese names whose Latin keys are both empty do not agree');
	});
});

describe('the name table shipped with the app', () => {
	const text = readFileSync(new URL('../js/scan/asian-names.json', import.meta.url), 'utf8');

	test('is small, names its sources and licences, has every species in both languages, and no dashes the style forbids', () => {
		assert.ok(text.length < 64 * 1024, `${text.length} bytes`);
		assert.match(TABLE.about, /PokeAPI.*BSD-3-Clause/);
		assert.match(TABLE.about, /TCGdex.*MIT/);
		assert.match(TABLE.about, /No free source of Korean Trainer names/);
		assert.doesNotMatch(text, /[\u2013\u2014]/);
		assert.equal(TABLE.species.ja.split('|').length, 1025);
		assert.equal(TABLE.species.ko.split('|').length, 1025);
		assert.ok(TABLE.trainers.ja.length > 500);
	});

	test('is fetched once, with the English names from the Western table, and a failed fetch is tried again', async () => {
		let asked = 0;
		const failing = await loadAsianNames({fetchImpl: async () => {
			asked++;

			return {ok: false, status: 503};
		}, local: async () => []});

		assert.deepEqual(failing, []);

		const western = [{dex: 25, key: 'pikachu', lang: 'en', name: 'Pikachu'}];
		const first = await loadAsianNames({fetchImpl: async () => {
			asked++;

			return {json: async () => TABLE, ok: true};
		}, local: async () => western});
		const second = await loadAsianNames({fetchImpl: async () => {
			throw new Error('asked twice');
		}});

		assert.equal(asked, 2);
		assert.equal(second, first);
		assert.equal(first.find((entry) => entry.dex === 25 && entry.lang === 'ja').english, 'Pikachu');
	});
});

describe('the name strip in Japanese or Korean', () => {
	test('a name read with the stage label and a suffix', () => {
		const line = {text: 'たね ミニーブ ex', words: [
			{bbox: {x0: 0, x1: 30, y0: 10, y1: 20}, confidence: 80, text: 'たね'},
			{bbox: {x0: 40, x1: 120, y0: 0, y1: 30}, confidence: 90, text: 'ミニーブ'},
			{bbox: {x0: 125, x1: 150, y0: 4, y1: 30}, confidence: 70, text: 'ex'},
		]};

		assert.deepEqual(C.parseCjkName([line]), {confidence: 0.9, script: 'ja', suffix: 'ex', text: 'ミニーブ'});
		assert.equal(C.parseCjkName([{text: '기본 피카츄V', words: []}]).text, '피카츄');
		assert.equal(C.parseCjkName([{text: 'Basic', words: []}]).text, '');
	});

	test('the shapes of a line: Hangul-like blocks look CJK, with loops; a Latin word does not', () => {
		const hangul = blank(400, 60);

		for (let i = 0; i < 4; i++) {
			syllable(hangul, 10 + i * 50, 10, 40);
		}

		const latin = blank(400, 60);

		word(latin, 10, 10, 40);

		const h = C.looksCjk(hangul);
		const l = C.looksCjk(latin);

		assert.ok(h.cjk, JSON.stringify(h));
		assert.ok(h.holes >= C.HANGUL_HOLES, 'loops per glyph');
		assert.ok(!l.cjk, JSON.stringify(l));
		assert.equal(C.looksCjk({data: new Uint8ClampedArray(0), height: 0, width: 0}).cjk, false);
	});

	test('light print on a dark ground is measured the other way round', () => {
		const hangul = blank(400, 60, 20);

		for (let i = 0; i < 4; i++) {
			const one = blank(40, 40);

			syllable(one, 0, 0, 40);

			for (let y = 0; y < 40; y++) {
				for (let x = 0; x < 40; x++) {
					const v = 255 - one.data[(y * 40 + x) * 4];

					hangul.data.set([v, v, v, 255], ((y + 10) * 400 + 10 + i * 50 + x) * 4);
				}
			}
		}

		assert.ok(C.looksCjk(hangul).cjk);
	});
});

// ------------------------------------------------------------ when the models load

describe('when the Japanese or Korean model is loaded', () => {
	const junk = {confidence: 0.3, text: 'Ele TLE'};
	const named = {confidence: 0.9, text: 'Pikachu'};
	const cjkShapes = {cjk: true, glyphs: 4, holes: 0.5, tall: 0.95, wide: 0.9};
	const kanaShapes = {cjk: true, glyphs: 4, holes: 0, tall: 0.95, wide: 0.9};
	const latinShapes = {cjk: false, glyphs: 7, holes: 0.3, tall: 0.6, wide: 0.45};

	test('a card known to be Japanese or Korean is read with its model only', () => {
		assert.deepEqual(C.wantsCjk({guess: 'ko', language: 'ja'}), {first: 'ja', read: true, skipLatin: true, then: null});
		assert.deepEqual(C.wantsCjk({guess: 'ja', language: 'ko'}), {first: 'ko', read: true, skipLatin: true, then: null});
	});

	test('never for a plausible Latin name, nor for a strip with Latin shapes', () => {
		assert.equal(C.wantsCjk({guess: 'ko'}, named, cjkShapes).read, false);
		assert.equal(C.wantsCjk({guess: 'ko'}, junk, cjkShapes, 1).read, false, 'the read names a known Pokémon');
		assert.equal(C.wantsCjk({guess: 'ko'}, junk, latinShapes, 0.4).read, false);
		assert.equal(C.wantsCjk(null, junk, cjkShapes).read, false, 'Japanese and Korean reading off');
	});

	test('a Latin read that names nothing on a strip of CJK shapes: the model its loops suggest first, the other next', () => {
		assert.deepEqual(C.wantsCjk({guess: 'ja'}, junk, cjkShapes, 0.6), {first: 'ko', read: true, skipLatin: false, then: 'ja'});
		assert.deepEqual(C.wantsCjk({guess: 'ko'}, junk, kanaShapes, 0.6), {first: 'ja', read: true, skipLatin: false, then: 'ko'});
		assert.deepEqual(C.wantsCjk({guess: 'ja'}, junk, {...cjkShapes, holes: 0.2}, 0.6), {first: 'ja', read: true, skipLatin: false, then: 'ko'}, 'unclear loops: the last Asian pick');
	});

	test('the last pick Japanese or Korean: no shapes needed', () => {
		assert.equal(C.wantsCjk({guess: 'ko', lean: true}, junk, latinShapes, 0.6).read, true);
		assert.equal(C.wantsCjk({guess: 'ko', lean: true}, named, latinShapes, 1).read, false);
	});

	test('a Latin read is plausible by the name table when there is one, else by its confidence', () => {
		assert.equal(C.plausibleLatin({confidence: 0.9, text: 'Pt RE'}, 0.6), false);
		assert.equal(C.plausibleLatin({confidence: 0.3, text: 'Bulbasar'}, 0.9), true);
		assert.equal(C.plausibleLatin({confidence: 0.9, text: 'Bulbasar'}), true);
		assert.equal(C.plausibleLatin({confidence: 0.3, text: 'Bulbasar'}), false);
		assert.equal(C.plausibleLatin({confidence: 0.9, text: 'ab'}), false);
	});
});

describe('the Asian worker loads on first use and switches models', () => {
	const fakeStart = (log) => async (logger, lang) => {
		log.push(`start ${lang}`);

		let model = lang;

		return {
			recognize: async () => ({data: {blocks: [], confidence: 88, text: `${model} read`}}),
			reinitialize: async (next) => {
				log.push(`switch ${next}`);
				model = next;
			},
			setParameters: async () => {},
			terminate: async () => log.push('end'),
		};
	};

	test('nothing starts until a Japanese or Korean read is asked for', async () => {
		const log = [];
		const reader = createAsianReader({start: fakeStart(log)});

		assert.equal(reader.started, false);
		assert.deepEqual(log, []);
		assert.deepEqual(ASIAN_MODELS, ['jpn', 'kor']);

		const image = blank(4, 4);

		assert.equal((await reader.ocr(image, {lang: 'kor'})).text, 'kor read');
		assert.equal((await reader.ocr(image, {lang: 'kor'})).text, 'kor read');
		assert.equal((await reader.ocr(image, {lang: 'jpn'})).text, 'jpn read');
		assert.deepEqual(log, ['start kor', 'switch jpn'], 'one worker, the model switched when the other is asked for');
		await assert.rejects(reader.ocr(image, {lang: 'eng'}));
		await reader.terminate();
		assert.deepEqual(log.at(-1), 'end');
	});

	test('a model still loading past the wait gives up on this card, and the next one gets it', async () => {
		let release = null;
		const reader = createAsianReader({start: () => new Promise((resolve) => {
			release = () => resolve({recognize: async () => ({data: {blocks: [], confidence: 70, text: 'ok'}}), setParameters: async () => {}, terminate: async () => {}});
		}), wait: 30});
		const image = blank(4, 4);

		await assert.rejects(reader.ocr(image, {lang: 'jpn'}), /still loading/);
		release();
		assert.equal((await reader.ocr(image, {lang: 'jpn'})).text, 'ok');
	});

	test('prepare starts the model before the first read', async () => {
		const log = [];
		const reader = createAsianReader({start: fakeStart(log)});

		reader.prepare('jpn');
		reader.prepare('eng');
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(log, ['start jpn']);
	});
});

// ------------------------------------------------------------ the read

describe('reading the name strip of a card whose number does not read', () => {
	// A white card with Hangul-like blocks on the name strip and nothing in
	// the number strips.
	const card = () => {
		const image = blank(600, 825);

		for (let i = 0; i < 4; i++) {
			syllable(image, 40 + i * 30, 30, 24);
		}

		return image;
	};
	const fakeOcr = (calls) => async (image, settings) => {
		calls.push(settings.lang || 'eng');

		if (settings.lang === 'kor') {
			return {confidence: 88, lines: [{text: '헤라크로스', words: [{bbox: {x0: 0, x1: 100, y0: 0, y1: 30}, confidence: 88, text: '헤라크로스'}]}], text: '헤라크로스'};
		}

		if (settings.lang === 'jpn') {
			return {confidence: 40, lines: [{text: 'ㅁ口', words: [{bbox: {x0: 0, x1: 40, y0: 0, y1: 30}, confidence: 40, text: '口口'}]}], text: '口口'};
		}

		return {confidence: 30, lines: [{text: 'Ele TLE', words: [{bbox: {x0: 0, x1: 40, y0: 0, y1: 30}, confidence: 30, text: 'Ele'}, {bbox: {x0: 50, x1: 90, y0: 0, y1: 30}, confidence: 30, text: 'TLE'}]}], text: 'Ele TLE'};
	};
	const scoreName = async (text) => (C.matchCjkNames(text, ENTRIES, {limit: 1, min: 0})[0] || {score: 0}).score;
	const scoreLatin = async () => 0.4;

	test('the English read names nothing and the strip looks Korean: the Korean model reads the name', async () => {
		const calls = [];
		const read = await readNumber(card(), fakeOcr(calls), {cjk: {guess: 'ja', language: null}, name: true, scoreLatin, scoreName});

		assert.equal(read.number, null);
		assert.equal(read.name.text, '헤라크로스');
		assert.equal(read.name.script, 'ko');
		assert.ok(calls.includes('kor'));
		assert.ok(!calls.includes('jpn'), 'the loops said Hangul, and the Korean read named a Pokémon: the Japanese model is never loaded');
		assert.match(read.raw.nameShapes.text, /holes/);
	});

	test('a card known to be Korean skips the English read of its name', async () => {
		const calls = [];
		const read = await readNumber(card(), fakeOcr(calls), {cjk: {guess: 'ja', language: 'ko'}, name: true, scoreName});
		const nameCalls = calls.filter((lang) => lang !== 'eng');

		assert.equal(read.name.text, '헤라크로스');
		assert.deepEqual(nameCalls, ['kor']);
		assert.ok(!read.raw.name.text, 'no English read of the name strip');
	});

	test('without the Japanese and Korean options the read is as before: no model is asked for', async () => {
		const calls = [];
		const read = await readNumber(card(), fakeOcr(calls), {name: true});

		assert.ok(calls.every((lang) => lang === 'eng'));
		assert.equal(read.name.text.includes('헤'), false);
	});

	test('the whole read of a card known to be Japanese starts its model at once', async () => {
		const prepared = [];
		const calls = [];

		await readCard(card(), fakeOcr(calls), {cjk: {guess: 'ko', language: 'ja'}, prepareModel: (model) => prepared.push(model), scoreName});
		assert.deepEqual(prepared, ['jpn']);
		assert.ok(calls.includes('jpn'));
	});

	test('a Latin label row read vetoes the Japanese and Korean models, however the strip looks', async () => {
		const calls = [];
		const ocr = fakeOcr(calls);
		// The blank test card's label band has no lines, so the row is read
		// sparse.
		const labelled = async (image, settings) => (settings === OCR_SETTINGS.label || settings === OCR_SETTINGS.sparse
			? {confidence: 90, lines: [{text: 'Weakness Resistance Retreat', words: []}], text: 'Weakness Resistance Retreat'}
			: ocr(image, settings));

		await readCard(card(), labelled, {cjk: {guess: 'ko', language: null}, scoreLatin, scoreName});
		assert.ok(calls.every((lang) => lang === 'eng'), calls.join(' '));
	});

	test('a Japanese or Korean read that names nothing waits for the English passes, and is kept only when they read nothing', async () => {
		const calls = [];
		const weak = async (image, settings) => {
			calls.push(settings.lang || 'eng');

			return settings.lang ? {confidence: 40, lines: [{text: '오를은', words: [{bbox: {x0: 0, x1: 60, y0: 0, y1: 30}, confidence: 40, text: '오를은'}]}], text: '오를은'} : {confidence: 0, lines: [], text: ''};
		};
		const read = await readNumber(card(), weak, {cjk: {guess: 'ko', language: null}, name: true, scoreLatin, scoreName});

		assert.ok(calls.includes('kor') && calls.includes('jpn'), 'both models tried');
		assert.equal(read.name.text, '오를은', 'the English passes read nothing, so the Korean read stands');
		assert.ok(read.raw.name.text !== undefined);
	});

	test('the stored read keeps the name\'s script', () => {
		const summary = S.summariseRead({language: {code: 'non-latin'}, name: {confidence: 0.88, lang: 'ko', script: 'ko', suffix: null, text: '헤라크로스'}, number: null});

		assert.deepEqual(summary.name, {confidence: 0.88, lang: 'ko', script: 'ko', suffix: null, text: '헤라크로스'});
	});
});

// ------------------------------------------------------------ finding the card

describe('a Korean name finds the Japanese record a Korean copy sits on', () => {
	// The Japanese catalog's M6 (Korean copies of it are kept on its
	// records, which have no images), invented down to two cards.
	const sets = {ja: [{cardCount: {official: 76}, id: 'M6', name: 'ストームエメラルダ', serie: 'M'}], ko: []};
	const records = {
		'M6-001': {id: 'M6-001', image: null, localId: '001', name: 'ヘラクロス'},
		'M6-002': {id: 'M6-002', image: null, localId: '002', name: 'アメタマ'},
	};
	const asked = [];
	const api = {
		allSets: async (lang) => sets[lang] || [],
		asianNamedPrints: async () => [],
		asianNames: async () => ENTRIES,
		asianPrints: async (catalog, dex) => {
			asked.push(`${catalog} ${dex}`);

			return catalog === 'ja' && dex === 214 ? [{cardId: 'M6-001', image: null, localId: '001', name: 'ヘラクロス', releaseDate: '2026-09-26', setId: 'M6', setName: 'ストームエメラルダ'}] : [];
		},
		cardDetail: async () => null,
		localNames: async () => {
			throw new Error('a Korean name never asks for the Western names');
		},
		setDetail: async (lang, setId) => (lang === 'ja' && setId === 'M6' ? {cardCount: {official: 76}, cards: Object.values(records), id: 'M6', name: 'ストームエメラルダ', releaseDate: '2026-09-26'} : null),
		species: async () => {
			throw new Error('a Korean name never asks for the English species list');
		},
	};
	const korean = (number = null) => S.summariseRead({language: {code: 'non-latin', confidence: 0.2, source: 'no Latin label read'}, name: {confidence: 0.86, lang: 'ko', script: 'ko', suffix: null, text: '헤라크로스'}, number});

	test('with no number: the name route finds the Japanese record, by the Korean catalog first, and it is not sure', async () => {
		const found = await findCandidates(korean(), 'non-latin', {api});

		assert.deepEqual(found.routes, ['name']);
		assert.equal(found.names[0].name, 'Heracross');
		assert.equal(found.names[0].spelling, '헤라크로스');
		assert.deepEqual(asked.slice(0, 2), ['ko 214', 'ja 214']);
		assert.equal(found.candidates[0].id, 'M6-001');
		assert.equal(found.candidates[0].lang, 'ja');
		assert.equal(found.candidates[0].official, '76');
		assert.ok(found.candidates[0].reasons.includes('name'));
		assert.equal(S.judgeMatch(korean(), found.candidates, false, found.names).sure, false, 'a name alone never makes a card sure');
	});

	test('with the number: the record found by number agrees with the Korean name through its Japanese one', async () => {
		const number = {confidence: 0.9, number: '1', numberPrinted: '001', side: 'left', total: '76', totalPrinted: '076'};
		const found = await findCandidates(korean(number), 'non-latin', {api});

		assert.equal(found.candidates[0].id, 'M6-001');
		assert.ok(found.candidates[0].reasons.includes('number and total'));
		assert.ok(found.candidates[0].agree.includes('name'), 'ヘラクロス is Heracross');
		assert.equal(S.judgeMatch(korean(number), found.candidates, false, found.names).sure, true, 'the number and the name agree');
	});

	test('a number that names another card than the Korean name keeps it from being sure', async () => {
		const number = {confidence: 0.9, number: '2', numberPrinted: '002', side: 'left', total: '76', totalPrinted: '076'};
		const found = await findCandidates(korean(number), 'non-latin', {api});
		const judged = S.judgeMatch(korean(number), found.candidates, false, found.names);

		assert.equal(judged.sure, false);
		assert.ok(found.candidates.some((c) => c.id === 'M6-001'), 'the card the name names is offered too');
	});

	test('the picture could not settle it and the number did not read: the Korean name puts the Japanese record first, not sure', async () => {
		const card = (id, score) => ({catalog: 'ja', id, image: null, score, set: 'M6'});
		const picture = {gap: 2, groups: [{cards: [card('M6-002', 60)], score: 60}, {cards: [card('M6-001', 62)], score: 62}]};
		const describeApi = {setDetail: api.setDetail};
		const textRoute = (read, lang) => findCandidates(read, lang, {api});
		const found = await pictureMatch(picture, korean(), 'non-latin', {api: describeApi, asian: 'ko', textRoute});

		assert.equal(found.card.id, 'M6-001');
		assert.equal(found.candidates[0].id, 'M6-001');
		assert.equal(found.sure, false);
		assert.match(found.why, /name reads "헤라크로스"/);
	});

	test('a Japanese Trainer\'s prints are asked by its Japanese name', () => {
		assert.equal(asianNamedPrintsPath('ja', '博士の研究'), `ja/cards?name=eq:${encodeURIComponent('博士の研究')}`);
		assert.deepEqual(asianNamedPrintsFrom([{id: 'S12a-159', image: 'https://assets.tcgdex.net/ja/S/S12a/159', localId: '159', name: '博士の研究'}]), [{cardId: 'S12a-159', image: 'https://assets.tcgdex.net/ja/S/S12a/159', localId: '159', name: '博士の研究', releaseDate: '', setId: 'S12a', setName: null}]);
	});
});

// ------------------------------------------------------------ the service worker

describe('the service worker', () => {
	const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
	const shell = sw.slice(sw.indexOf('const SHELL = ['), sw.indexOf('];', sw.indexOf('const SHELL = [')));

	test('precaches the new scanner files and the Asian names, never the Japanese and Korean models', () => {
		assert.match(shell, /'js\/scan\/cjk\.js'/);
		assert.match(shell, /'js\/scan\/asian-names\.json'/);
		assert.doesNotMatch(shell, /jpn|kor/);
	});

	test('keeps the models on first use, in the OCR cache under the vendored folder', () => {
		for (const model of ['jpn', 'kor']) {
			assert.ok(readFileSync(new URL(`../lab/vendor/tesseract/lang/${model}.traineddata.gz`, import.meta.url)).length > 500 * 1024);
		}

		assert.match(sw, /const OCR_PATH = 'lab\/vendor\/tesseract\/'/);
	});
});
