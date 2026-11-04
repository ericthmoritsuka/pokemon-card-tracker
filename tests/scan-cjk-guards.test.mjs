// The guards on Japanese and Korean name reading (review of version 56's
// first draft, 2026-11-04): a name never makes a card sure, a Latin card
// never waits for a Japanese or Korean model, and the app's first load does
// not grow by the models. So: Energy and Trainer cards (no weakness row)
// load no model; a card whose language is not known reads only with a
// model already loaded; a model's load is waited for once, never while a
// switch is under way; the models do not switch back and forth; junk reads
// rarely name a Pokémon, and names the folding cannot tell apart stay ties;
// the Western table is asked only when a model might be wanted, and an
// unloaded table says nothing; a model that cannot load is not tried again
// until the phone is back online; the name route asks its catalogs at once;
// and the service worker keeps each model by its version. Node only: the
// OCR is a fake and the strings it returns are invented.
//
// Run: node --test tests/scan-cjk-guards.test.mjs

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test, {describe} from 'node:test';

import * as C from '../js/scan/cjk.js';
import * as L from '../js/scan/local-names.js';
import * as M from '../js/scan/match.js';
import * as O from '../js/scan/ocr.js';
import * as R from '../js/scan/read.js';
import * as S from '../js/scan/session.js';

const TABLE = JSON.parse(readFileSync(new URL('../js/scan/asian-names.json', import.meta.url), 'utf8'));
const WESTERN = JSON.parse(readFileSync(new URL('../js/scan/local-names.json', import.meta.url), 'utf8'));
const ENTRIES = C.asianNameEntries(TABLE, WESTERN.species.en.split('|'));
const LATIN = L.localNameEntries(WESTERN);

const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------ images

const blank = (width, height) => ({data: new Uint8ClampedArray(width * height * 4).fill(255), height, width});

const paint = (image, x0, y0, w, h) => {
	for (let y = y0; y < y0 + h; y++) {
		for (let x = x0; x < x0 + w; x++) {
			image.data.set([0, 0, 0, 255], (y * image.width + x) * 4);
		}
	}
};

// A Hangul-like syllable: a closed loop beside a vowel bar, a bottom stroke.
function syllable(image, x, y, size) {
	const stroke = Math.max(2, Math.round(size / 10));
	const box = Math.round(size * 0.5);

	paint(image, x, y, box, stroke);
	paint(image, x, y + box - stroke, box, stroke);
	paint(image, x, y, stroke, box);
	paint(image, x + box - stroke, y, stroke, box);
	paint(image, x + box, y, stroke, size);
	paint(image, x + box, y + Math.round(size * 0.3), Math.round(size * 0.25), stroke);
	paint(image, x, y + size - stroke, Math.round(size * 0.75), stroke);
}

// A Latin-like word: narrow letters, most of them x-height.
function word(image, x, y, size) {
	const stroke = Math.max(2, Math.round(size / 8));
	const xh = Math.round(size * 0.55);
	let at = x;

	for (const [tall, wide] of [[1, 0.55], [0, 0.45], [0, 0.45], [1, 0.12], [0, 0.45], [0, 0.4], [0, 0.45]]) {
		const h = tall ? size : xh;
		const w = Math.round(size * wide);

		paint(image, at, y + size - h, stroke, h);
		paint(image, at + w - stroke, y + size - h, stroke, h);
		paint(image, at, y + size - stroke, w, stroke);
		at += w + Math.round(size * 0.12);
	}
}

const latinCard = () => {
	const image = blank(600, 825);

	word(image, 40, 30, 24);
	word(image, 160, 30, 24);

	return image;
};

const hangulCard = () => {
	const image = blank(600, 825);

	for (let i = 0; i < 4; i++) {
		syllable(image, 40 + i * 30, 30, 24);
	}

	return image;
};

const line = (text, confidence) => ({confidence, lines: [{text, words: text.split(' ').map((part, i) => ({bbox: {x0: i * 90, x1: i * 90 + 80, y0: 0, y1: 30}, confidence, text: part}))}], text});
const nothing = {confidence: 0, lines: [], text: ''};
const tally = (calls) => calls.reduce((counts, lang) => ({...counts, [lang]: (counts[lang] || 0) + 1}), {});
const scoreName = async (text) => (C.matchCjkNames(text, ENTRIES, {limit: 1, min: 0})[0] || {score: 0}).score;

// ------------------------------------------------------------ Energy and Trainer cards

describe('a Latin card with no weakness row loads no model', () => {
	test('a label row with no Latin label is no reason on its own: the strip must look Japanese or Korean', () => {
		const junk = {confidence: 0.3, text: 'Ele TLE'};
		const latinShapes = {cjk: false, glyphs: 7, holes: 0, tall: 0.56, wide: 0.47};

		assert.equal(C.wantsCjk({guess: 'ko', noLatinLabel: true}, junk, latinShapes, 0.4).read, false);
		assert.equal(C.wantsCjk({guess: 'ko', noLatinLabel: true}, junk, null, 0.4).read, false);
	});

	test('an Energy\'s name is a plausible Latin name, basic or special, in any Western language', () => {
		for (const text of ['Fire Energy', 'Basic Fire Energy', 'Darkness Energy', 'Double Colorless Energy', 'Energia de Fogo', 'Énergie Feu', 'Feuer-Energie', 'Energv Retrieval']) {
			assert.equal(C.plausibleLatin({confidence: 0.9, text}, 0.66), true, text);
		}

		assert.equal(C.plausibleLatin({confidence: 0.9, text: 'Ele TLE'}, 0.4), false);
		assert.equal(C.plausibleLatin({confidence: 0.9, text: 'Enemy'}, 0.4), false);
	});

	test('a perfect "Fire Energy" read, its table score under the bar and no label read, is never read in Korean or Japanese', async () => {
		const calls = [];
		const ocr = async (image, settings) => {
			const lang = settings.lang || 'eng';

			calls.push(lang);

			if (lang !== 'eng') {
				return line(lang === 'kor' ? '오를은' : 'ファ', 40);
			}

			return image.height < 120 && image.width > 200 && calls.filter((call) => call === 'eng').length <= 2 ? line('Fire Energy', 92) : nothing;
		};
		const read = await R.readCard(latinCard(), ocr, {attacks: false, cjk: {guess: 'ko', language: null, lean: false}, scoreLatin: async () => 0.66, scoreName});

		assert.equal(read.name.text, 'Fire Energy');
		assert.deepEqual(Object.keys(tally(calls)), ['eng'], JSON.stringify(tally(calls)));
	});
});

// ------------------------------------------------------------ never waiting with no language known

describe('a card whose language is not known never waits for a model', () => {
	const koreanOcr = (calls, settingsSeen = []) => async (image, settings) => {
		calls.push(settings.lang || 'eng');
		settingsSeen.push(settings);

		if (settings.lang === 'kor') {
			return line('헤라크로스', 88);
		}

		return settings.lang ? line('口口', 40) : line('Ele TLE', 30);
	};

	test('no model loaded: none is read with, the one the strip asks for is prepared for the next card', async () => {
		const calls = [];
		const prepared = [];
		const read = await R.readNumber(hangulCard(), koreanOcr(calls), {cjk: {guess: 'ja', language: null}, modelState: () => null, name: true, prepareModel: (model) => prepared.push(model), scoreLatin: async () => 0.4, scoreName});

		assert.deepEqual(Object.keys(tally(calls)), ['eng'], JSON.stringify(tally(calls)));
		assert.deepEqual(prepared, ['kor'], 'the loops say Hangul');
		assert.notEqual(read.name && read.name.script, 'ko');
	});

	test('the model loaded: read with it, never waiting, and the other is prepared only when it names nothing', async () => {
		const calls = [];
		const seen = [];
		const prepared = [];
		const read = await R.readNumber(hangulCard(), koreanOcr(calls, seen), {cjk: {guess: 'ja', language: null}, modelState: (model) => (model === 'kor' ? 'held' : null), name: true, prepareModel: (model) => prepared.push(model), scoreLatin: async () => 0.4, scoreName});

		assert.equal(read.name.text, '헤라크로스');
		assert.ok(seen.filter((settings) => settings.lang).every((settings) => settings.noWait === true), 'every Korean read may not wait');
		assert.ok(!calls.includes('jpn'));
		assert.deepEqual(prepared, [], 'the Korean read named a Pokémon');
	});

	test('a card picked as Korean still waits for its model, as before', async () => {
		const calls = [];
		const seen = [];

		await R.readNumber(hangulCard(), koreanOcr(calls, seen), {cjk: {guess: 'ja', language: 'ko'}, modelState: () => null, name: true, scoreName});
		assert.ok(calls.includes('kor'));
		assert.ok(seen.filter((settings) => settings.lang).every((settings) => !settings.noWait));
	});

	test('the reader: a read that may not wait gives up at once while its model is not loaded', async () => {
		let starts = 0;
		const reader = O.createAsianReader({start: () => {
			starts++;

			return later(200).then(() => ({recognize: async () => ({data: {blocks: [], confidence: 80, text: 'ok'}}), reinitialize: async () => {}, setParameters: async () => {}, terminate: async () => {}}));
		}, wait: 5000});
		const at = performance.now();

		await assert.rejects(reader.ocr(blank(4, 4), {lang: 'kor', noWait: true}), /still loading/);
		assert.ok(performance.now() - at < 50);
		assert.equal(starts, 0, 'nothing starts for it: the caller prepares');
		assert.equal(reader.state('kor'), null);
		reader.prepare('kor');
		await later(260);
		assert.equal(reader.state('kor'), 'held');
		assert.equal((await reader.ocr(blank(4, 4), {lang: 'kor', noWait: true})).text, 'ok');
	});
});

// ------------------------------------------------------------ waiting once, and never mid-switch

describe('a model load is waited for once, and no read runs while a model switches', () => {
	const slowStart = (loadMs) => (logger, lang) => later(loadMs).then(() => ({
		recognize: async () => ({data: {blocks: [], confidence: 80, text: `${lang} read`}}),
		reinitialize: () => later(loadMs),
		setParameters: async () => {},
		terminate: async () => {},
	}));

	test('a card known to be Japanese: prepare, then its two name lines, give up together at the limit, not after the load', async () => {
		const reader = O.createAsianReader({start: slowStart(1000), wait: 150});
		const at = performance.now();

		reader.prepare('jpn');

		const results = await Promise.allSettled([reader.ocr(blank(4, 4), {lang: 'jpn'}), reader.ocr(blank(4, 4), {lang: 'jpn'})]);
		const took = performance.now() - at;

		assert.deepEqual(results.map((result) => result.status), ['rejected', 'rejected']);
		assert.ok(took < 400, `gave up after ${Math.round(took)} ms`);
	});

	test('past the limit, the next reads give up at once until the load settles, and no second wait is added', async () => {
		const reader = O.createAsianReader({start: slowStart(1000), wait: 150});

		await assert.rejects(Promise.all([reader.ocr(blank(4, 4), {lang: 'jpn'}), reader.ocr(blank(4, 4), {lang: 'jpn'})]));

		const at = performance.now();

		await assert.rejects(Promise.all([reader.ocr(blank(4, 4), {lang: 'kor'}), reader.ocr(blank(4, 4), {lang: 'kor'})]));
		await assert.rejects(reader.ocr(blank(4, 4), {lang: 'jpn'}));
		assert.ok(performance.now() - at < 60, `the Korean and the next Japanese reads gave up after ${Math.round(performance.now() - at)} ms`);
		await later(1000);
		assert.equal((await reader.ocr(blank(4, 4), {lang: 'jpn'})).text, 'jpn read', 'once loaded, read');
	});

	test('a read never runs while the worker switches models, so it never reads with the wrong one', async () => {
		let model = 'kor';
		let switching = false;
		const overlapped = [];
		const reader = O.createAsianReader({start: async (logger, lang) => {
			model = lang;

			return {
				recognize: async () => {
					if (switching) {
						overlapped.push(model);
					}

					return {data: {blocks: [], confidence: 80, text: `${model} read`}};
				},
				reinitialize: async (next) => {
					switching = true;
					await later(300);
					model = next;
					switching = false;
				},
				setParameters: async () => {},
				terminate: async () => {},
			};
		}, wait: 50});

		assert.equal((await reader.ocr(blank(4, 4), {lang: 'kor'})).text, 'kor read');
		await assert.rejects(reader.ocr(blank(4, 4), {lang: 'jpn'}), /still loading/);

		const during = await Promise.allSettled([reader.ocr(blank(4, 4), {lang: 'kor'})]);

		assert.equal(during[0].status, 'rejected', 'the Korean read behind the switch gives up rather than read');
		await later(350);
		assert.equal((await reader.ocr(blank(4, 4), {lang: 'kor'})).text, 'kor read', 'switched back before reading');
		assert.deepEqual(overlapped, []);
	});
});

// ------------------------------------------------------------ switching

describe('the models do not switch back and forth', () => {
	const counting = (log) => async (logger, lang) => {
		log.push(`start ${lang}`);

		return {recognize: async () => ({data: {blocks: [], confidence: 30, text: '오를은'}}), reinitialize: async (next) => log.push(`switch ${next}`), setParameters: async () => {}, terminate: async () => {}};
	};

	test('one worker per model: three unclear cards read with both models switch nothing', async () => {
		const log = [];
		const reader = O.createAsianReader({perModel: true, start: counting(log)});

		for (let card = 0; card < 3; card++) {
			for (const lang of ['kor', 'jpn']) {
				await Promise.all([reader.ocr(blank(4, 4), {lang}), reader.ocr(blank(4, 4), {lang})]);
			}
		}

		assert.deepEqual(log, ['start kor', 'start jpn']);
		assert.equal(reader.state('kor'), 'held');
		assert.equal(reader.state('jpn'), 'held');
	});

	test('the pool asks for a worker per model when the phone has the memory for two English workers', () => {
		assert.match(readFileSync(new URL('../js/scan/ocr.js', import.meta.url), 'utf8'), /createAsianReader\(\{logger, perModel: size >= 2\}\)/);
	});

	test('the shapes do not say: the model held is tried first, then one loaded before, then the last pick', () => {
		const junk = {confidence: 0.3, text: 'Ele TLE'};
		const unclear = {cjk: true, glyphs: 4, holes: 0.2, tall: 0.95, wide: 0.9};

		assert.deepEqual(C.wantsCjk({guess: 'ko'}, junk, unclear, 0.4, {ja: 'held', ko: 'ready'}), {first: 'ja', read: true, skipLatin: false, then: 'ko'});
		assert.deepEqual(C.wantsCjk({guess: 'ko'}, junk, unclear, 0.4, {ja: 'ready', ko: 'held'}), {first: 'ko', read: true, skipLatin: false, then: 'ja'});
		assert.deepEqual(C.wantsCjk({guess: 'ja'}, junk, unclear, 0.4, {ja: null, ko: 'held'}), {first: 'ko', read: true, skipLatin: false, then: null});
		assert.deepEqual(C.wantsCjk({guess: 'ko'}, junk, {...unclear, holes: 0.5}, 0.4, {ja: 'held', ko: null}), {first: 'ja', prepare: 'ko', read: true, skipLatin: false, then: null}, 'the loops say Hangul: the Korean model is prepared, the Japanese one read meanwhile');
	});
});

// ------------------------------------------------------------ junk and ties

describe('a junk read rarely names a Pokémon, and names the folding cannot tell apart stay ties', () => {
	test('random Hangul and katakana of two to five letters reach 0.7 against the table under 1 % of the time', () => {
		let seed = 11;
		const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
		const hangul = [...new Set(ENTRIES.filter((entry) => entry.lang === 'ko' && entry.dex).map((entry) => entry.name.replace(/[^가-힯]/gu, '')).join(''))];
		const kana = [...'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワンーガギグゲゴザジズゼゾダヂヅデドバビブベボパピプペポッャュョ'];

		for (const [name, alphabet] of [['Hangul', hangul], ['katakana', kana]]) {
			for (const length of [2, 3, 4, 5]) {
				let named = 0;

				for (let i = 0; i < 250; i++) {
					let text = '';

					for (let k = 0; k < length; k++) {
						text += alphabet[Math.floor(random() * alphabet.length)];
					}

					named += C.matchCjkNames(text, ENTRIES, {limit: 1, min: 0.7}).length ? 1 : 0;
				}

				assert.ok(named / 250 < 0.01, `${name}, ${length} letters: ${named} of 250`);
			}
		}
	});

	test('a short name is never found inside a longer read: Houndour (헬가) is not in "젤갑돌", under seven jamo or four kana', () => {
		assert.equal(C.SUBSTRING_SHORTEST, 7);
		assert.ok(C.cjkSimilarity('헬가', '젤갑돌') < 0.7);
		assert.ok(C.cjkSimilarity('블루', '불루랄') < 0.7);
		assert.equal(C.matchCjkNames('たねピカチュウ', ENTRIES)[0].dex, 25, 'a long name still reads through a glued stage label');
		assert.equal(C.matchCjkNames('デスナヘビ', ENTRIES)[0].dex, 843, 'a four-kana name too');
	});

	test('a two-syllable Korean name and a two-kana name must read exactly', () => {
		assert.ok(C.cjkSimilarity('캥카', '캥라') < 0.7);
		assert.equal(C.cjkSimilarity('ハウ', 'ハウ'), 1);
		assert.ok(C.cjkSimilarity('ハウ', 'パウ') < 0.7, 'the voicing marks count in a name this short');
		assert.equal(C.matchCjkNames('피카추', ENTRIES)[0].dex, 25, 'a three-syllable name may still be a stroke off');
	});

	test('カラカラ and ガラガラ, ポリゴン and its two evolutions, ニドラン♀ and ♂ come back as ties, never one of them', () => {
		const dexes = (text) => C.matchCjkNames(text, ENTRIES, {limit: 1}).filter((match) => match.score === 1).map((match) => match.dex).sort((a, b) => a - b);

		assert.deepEqual(dexes('ガラガラ'), [104, 105]);
		assert.deepEqual(dexes('ポリゴン'), [137, 233, 474]);
		assert.deepEqual(dexes('폴리곤'), [137, 233, 474]);
		assert.deepEqual(dexes('ニドラン'), [29, 32]);
		assert.deepEqual(C.dexesOfCjkName('ニドラン♂', ENTRIES), [32], 'a record\'s printed name is exact');
		assert.deepEqual(C.dexesOfCjkName('ポリゴン2', ENTRIES), [233]);
		assert.deepEqual(C.dexesOfCjkName('ニドラン', ENTRIES).sort((a, b) => a - b), [29, 32]);
		assert.equal(C.dexOfCjkName('ニドラン', ENTRIES), null, 'never one of two');
	});

	test('the name route asks for every species tied for the best name', async () => {
		const asked = [];
		const api = {
			allSets: async () => [],
			asianNamedPrints: async () => [],
			asianNames: async () => ENTRIES,
			asianPrints: async (catalog, dex) => {
				asked.push(`${catalog} ${dex}`);

				return [];
			},
			cardDetail: async () => null,
			setDetail: async () => null,
		};
		const read = S.summariseRead({language: {code: 'non-latin'}, name: {confidence: 0.86, lang: 'ko', script: 'ko', suffix: null, text: '폴리곤'}, number: null});

		await M.findCandidates(read, 'non-latin', {api}).catch(() => null);
		assert.deepEqual(asked.filter((entry) => entry.startsWith('ko')).sort(), ['ko 137', 'ko 233', 'ko 474']);
	});

	test('a Korean read that names a card only at 0.7 to 0.8 does not skip the English passes', async () => {
		const calls = [];
		const ocr = async (image, settings) => {
			calls.push(settings.lang || 'eng');

			return settings.lang ? line('헤라크로', 70) : nothing;
		};

		await R.readNumber(hangulCard(), ocr, {cjk: {guess: 'ko', language: null}, name: true, scoreLatin: async () => 0.4, scoreName: async () => 0.75});
		assert.equal(R.CJK_NAME_TAKEN, 0.8);
		assert.ok(calls.lastIndexOf('eng') > calls.indexOf('kor'), `the inverted English pass ran after the Korean read: ${calls.join(' ')}`);
	});
});

// ------------------------------------------------------------ the Western table's cost

describe('the Western table is asked only when a model might be wanted, and an unloaded one says nothing', () => {
	test('an unloaded table answers null, not 0', async () => {
		assert.equal(await L.latinNameScore('Pikachu', {load: async () => []}), null);
		assert.equal(await L.latinNameScore('Pikachu', {load: async () => LATIN}), 1);
	});

	test('a strip of Latin shapes, no Japanese or Korean pick: the table is not asked', async () => {
		let asked = 0;
		const ocr = async (image, settings) => (settings.lang ? line('오를은', 40) : line('Ve Gartt', 50));

		await R.readNumber(latinCard(), ocr, {cjk: {guess: 'ko', language: null, lean: false}, name: true, scoreLatin: async () => {
			asked++;

			return 0.4;
		}, scoreName});
		assert.equal(asked, 0);
	});

	test('the table could not load: no model is read with, however the strip looks', async () => {
		const calls = [];
		const ocr = async (image, settings) => {
			calls.push(settings.lang || 'eng');

			return settings.lang ? line('헤라크로스', 88) : line('Ele TLE', 30);
		};

		await R.readNumber(hangulCard(), ocr, {cjk: {guess: 'ko', language: null}, name: true, scoreLatin: async () => null, scoreName});
		assert.deepEqual(Object.keys(tally(calls)), ['eng'], JSON.stringify(tally(calls)));
	});
});

// ------------------------------------------------------------ a model that cannot load

describe('a model that cannot load is not tried again until the phone is back online', () => {
	test('a failed start makes no second worker on the next card; back online, it is tried again', async () => {
		let starts = 0;
		let fail = true;
		let back = null;
		const reader = O.createAsianReader({onOnline: (listener) => {
			back = listener;
		}, start: async () => {
			starts++;

			if (fail) {
				throw new Error('offline');
			}

			return {recognize: async () => ({data: {blocks: [], confidence: 80, text: 'ok'}}), reinitialize: async () => {}, setParameters: async () => {}, terminate: async () => {}};
		}});

		await assert.rejects(reader.ocr(blank(4, 4), {lang: 'jpn'}));
		await assert.rejects(reader.ocr(blank(4, 4), {lang: 'jpn'}));
		reader.prepare('kor');
		await later(0);
		assert.equal(starts, 1, 'one start this session');
		fail = false;
		back();
		assert.equal((await reader.ocr(blank(4, 4), {lang: 'jpn'})).text, 'ok');
		assert.equal(starts, 2);
	});

	test('a worker that fails half way through a switch is let go, not kept', async () => {
		const ended = [];
		const reader = O.createAsianReader({onOnline: () => {}, start: async (logger, lang) => ({
			recognize: async () => ({data: {blocks: [], confidence: 80, text: lang}}),
			reinitialize: async () => {
				throw new Error('no model');
			},
			setParameters: async () => {},
			terminate: async () => ended.push(lang),
		})});

		await reader.ocr(blank(4, 4), {lang: 'kor'});
		await assert.rejects(reader.ocr(blank(4, 4), {lang: 'jpn'}));
		await later(0);
		assert.deepEqual(ended, ['kor']);
	});
});

// ------------------------------------------------------------ the name route's time

describe('the Japanese and Korean name route asks its catalogs at once, within one time limit', () => {
	test('two catalogs, their set lists and lookups, take one wait, not four', async () => {
		const slow = (value) => later(150).then(() => value);
		const api = {
			allSets: () => slow([]),
			asianNamedPrints: async () => [],
			asianNames: async () => ENTRIES,
			asianPrints: (catalog) => slow(catalog === 'ja' ? [{cardId: 'M6-001', image: null, localId: '001', name: 'ヘラクロス', releaseDate: '', setId: 'M6', setName: 'M6'}] : []),
			cardDetail: async () => null,
			setDetail: async () => null,
		};
		const read = S.summariseRead({language: {code: 'non-latin'}, name: {confidence: 0.86, lang: 'ko', script: 'ko', suffix: null, text: '헤라크로스'}, number: null});
		const at = performance.now();
		const found = await M.findCandidates(read, 'non-latin', {api});
		const took = performance.now() - at;

		assert.equal(found.candidates[0].id, 'M6-001');
		assert.ok(took < 450, `took ${Math.round(took)} ms (one after another, 600 or more)`);
		assert.equal(M.ASIAN_ROUTE_MS, 4000);
	});
});

// ------------------------------------------------------------ the service worker

describe('the service worker keeps each OCR model by its version', () => {
	const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');

	test('the versions are the models\' own (the first 12 hex digits of their SHA-256)', () => {
		const versions = /const OCR_MODELS = (\{[^}]+\});/.exec(sw);

		assert.ok(versions, 'sw.js has OCR_MODELS');

		const table = Function(`return ${versions[1]}`)();

		assert.deepEqual(Object.keys(table).sort(), ['eng', 'jpn', 'kor']);

		for (const [model, version] of Object.entries(table)) {
			const bytes = readFileSync(new URL(`../lab/vendor/tesseract/lang/${model}.traineddata.gz`, import.meta.url));

			assert.equal(version, createHash('sha256').update(bytes).digest('hex').slice(0, 12), `${model}: update OCR_MODELS in sw.js when the model changes`);
		}
	});

	test('a model is kept under its address with its version, so a changed one is fetched again', () => {
		assert.match(sw, /const key = version \? `\$\{url\.origin\}\$\{url\.pathname\}\?v=\$\{version\}` : event\.request;/);
		assert.match(sw, /cache\.match\(key, \{ignoreSearch: !version\}\)/);
	});
});
