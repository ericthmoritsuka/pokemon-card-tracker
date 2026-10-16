// The scanner's text reading (2026-10-15): full-art collector numbers read
// by their ring (js/scan/read.js ringedNumbers), and names printed
// in Portuguese, French, and German mapped to their cards
// (js/scan/local-names.js, js/scan/evidence.js matchNames, the name route in
// js/scan/match.js, and js/scan/picture.js pictureMatch). Node only: the
// OCR is a fake, TCGdex and PokeAPI are never asked, and the OCR strings are
// invented.
//
// Also the OCR pool's order (js/scan/ocr.js createSlots, 2026-10-16): a
// label check behind the tray never holds a card's read up.
//
// Run: node --test tests/scan-reading.test.mjs

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test, {describe} from 'node:test';

import * as E from '../js/scan/evidence.js';
import {fullArtPicture} from '../js/scan/identify.js';
import {loadLocalNames, localNameEntries} from '../js/scan/local-names.js';
import {createSlots} from '../js/scan/ocr.js';
import {findCandidates, namedPrintsFrom, namedPrintsQuery} from '../js/scan/match.js';
import {pictureMatch} from '../js/scan/picture.js';
import {FULL_ART_SURE, readNumber, REGIONS, ringedNumbers} from '../js/scan/read.js';
import * as S from '../js/scan/session.js';
import {regionRect, scaleFor} from '../js/vision/pipeline.js';

// ------------------------------------------------------------ images

const grey = (width, height, value) => {
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

// A number as full-art cards print it, simplified: a white ring (a box)
// with dark digits (bars) inside, `height` tall, over dark art.
function ringedNumber(image, x, y, width, height) {
	const stroke = Math.max(2, Math.round(height / 6));

	paint(image, x, y, width, height, 250);

	for (let bar = x + stroke * 2; bar + stroke <= x + width - stroke * 2; bar += stroke * 3) {
		paint(image, bar, y + stroke, stroke, height - stroke * 2, 30);
	}
}

const value = (image, x, y) => image.data[(y * image.width + x) * 4];

// ------------------------------------------------------------ full-art strips

describe('full-art collector numbers', () => {
	test('the digits inside a white ring are cut out dark on white; the art and the ring fall away', () => {
		// A strip as prepareRegion makes it, at TEXT_PX: the ring a little
		// over a text line tall, the ground a dark, uneven art.
		const strip = grey(400, 120, 0);

		for (let y = 0; y < 120; y++) {
			for (let x = 0; x < 400; x++) {
				const tone = 30 + ((x * 7 + y * 13) % 90);

				strip.data.set([tone, tone, tone, 255], (y * 400 + x) * 4);
			}
		}

		ringedNumber(strip, 60, 40, 220, 42);

		const runs = ringedNumbers(strip, 32);

		assert.equal(runs.length, 1);

		const [run] = runs;
		const margin = 12;

		assert.equal(run.height, 42 + margin * 2);
		assert.equal(value(run, margin + 7 * 2 + 3, margin + 21), 0, 'a digit is dark');
		assert.equal(value(run, margin + 3, margin + 21), 255, 'the ring is white');
		assert.equal(value(run, 2, 2), 255, 'and so is the margin');
	});

	test('a strip with no ring gives nothing to read', () => {
		assert.deepEqual(ringedNumbers(grey(400, 120, 128), 32), []);
	});

	// A 600 x 825 card, dark, with a ringed number where the collector
	// number goes (bottom left) and dark bars on light where the name goes.
	function card({name = true, number = true} = {}) {
		const image = grey(600, 825, 60);

		for (let y = 760; y < 825; y++) {
			for (let x = 0; x < 600; x++) {
				const tone = 30 + ((x * 7 + y * 13) % 90);

				image.data.set([tone, tone, tone, 255], (y * 600 + x) * 4);
			}
		}

		if (number) {
			ringedNumber(image, 60, 776, 200, 15);
		}

		if (name) {
			paint(image, 20, 15, 400, 40, 230);

			for (let x = 40; x < 260; x += 12) {
				paint(image, x, 22, 5, 22, 20);
			}
		}

		return image;
	}

	const nameWidth = () => {
		const rect = regionRect({height: 825, width: 600}, REGIONS.name);

		return Math.round(rect.w * scaleFor({height: 825, width: 600}, REGIONS.name));
	};

	const binary = (image) => {
		for (let i = 0; i < image.data.length; i += 4) {
			if (image.data[i] !== 0 && image.data[i] !== 255) {
				return false;
			}
		}

		return true;
	};

	const line = (text, confidence) => ({confidence, lines: [{text, words: text.split(' ').map((word, i) => ({bbox: {x0: i * 60, x1: i * 60 + 50, y0: 4, y1: 36}, confidence, text: word}))}], text});

	// The fake OCR reads the number only from ringed digits cut out (black
	// and white), the name from the name strip, and nothing else.
	function fakeOcr(calls) {
		return async (image) => {
			calls.push({binary: binary(image), width: image.width});

			if (image.width === nameWidth()) {
				return line('Presa Grande ex', 88);
			}

			return binary(image) ? line('090/086', 91) : line('YO Rn ese ro', 40);
		};
	}

	test('a full-art card\'s ringed digits are read first, and a sure number there needs no other read', async () => {
		const calls = [];
		const read = await readNumber(card(), fakeOcr(calls), {fullArt: true});

		assert.equal(read.number.number, '90');
		assert.equal(read.number.total, '86');
		assert.equal(read.number.ringed, true);
		assert.equal(read.number.box, null, 'no set code box is looked for from it');
		assert.ok(read.number.confidence >= FULL_ART_SURE);
		assert.ok(calls.length >= 1 && calls.every((call) => call.binary), 'only the ringed digits were read');
		assert.equal(read.name, null, 'a number read: no name asked for');
	});

	test('a card that is not full art is never read by its ring', async () => {
		const calls = [];
		const read = await readNumber(card(), fakeOcr(calls), {});

		assert.equal(read.number, null);
		assert.equal(calls.filter((call) => call.binary).length, 0);
	});

	test('with no number read, the name strip is read when asked for', async () => {
		const calls = [];
		const read = await readNumber(card({number: false}), fakeOcr(calls), {name: true});

		assert.equal(read.number, null);
		assert.equal(read.name.text, 'Presa Grande');
		assert.equal(read.name.suffix, 'ex');
		assert.equal(S.summariseRead(read).name.text, 'Presa Grande');
	});

	test('a picture whose first card, or half its top five, is full art reads as full art', () => {
		const group = (full) => ({cards: [{id: 'x', ...(full ? {full: true} : {})}], score: 50});

		assert.equal(fullArtPicture({groups: [group(true), group(false), group(false)]}), true);
		assert.equal(fullArtPicture({groups: [group(false), group(true), group(true), group(false)]}), true);
		assert.equal(fullArtPicture({groups: [group(false), group(true), group(false)]}), false);
		assert.equal(fullArtPicture(null), false);
	});
});

// ------------------------------------------------------------ translated names

// A few rows in the table's shape (lab/names/build.mjs), invented where the
// real table would be long.
const TABLE = {
	prints: [[984, 'Presa Grande'], [992, 'Mãos Férreas'], [1005, 'Lua Estrondo']],
	species: {
		de: ['Bisasam', '', 'Glumanda'].concat(Array(989).fill('')).join('|'),
		en: ['Bulbasaur', 'Ivysaur', 'Charmander'].concat(Array(980).fill('Filler'), ['Great Tusk'], Array(7).fill('Filler'), ['Iron Hands'], Array(12).fill('Filler'), ['Roaring Moon']).join('|'),
		fr: ['Bulbizarre', 'Herbizarre', 'Salamèche'].concat(Array(1002).fill('')).join('|'),
	},
	trainers: [["Professor's Research", 'Pesquisa de Professores', 'Recherches Professorales', 'Forschung des Professors'], ['Rare Candy', 'Doce Raro', 'Bonbon Rare', 'Sonderbonbon']],
};

const ENTRIES = localNameEntries(TABLE);

describe('names printed in Portuguese, French, and German', () => {
	test('the table rows become entries with their English names', () => {
		const tusk = ENTRIES.find((entry) => entry.name === 'Presa Grande');

		assert.deepEqual({dex: tusk.dex, english: tusk.english, lang: tusk.lang}, {dex: 984, english: 'Great Tusk', lang: 'print'});
		assert.equal(ENTRIES.find((entry) => entry.name === 'Glumanda').english, 'Charmander');
		assert.equal(ENTRIES.find((entry) => entry.name === 'Sonderbonbon').dex, null);
		assert.equal(ENTRIES.filter((entry) => entry.name === 'Ivysaur').length, 1, 'an empty German name adds nothing');
	});

	test('OCR misreads of a Paradox Pokémon\'s Portuguese name still find it', () => {
		assert.deepEqual(E.matchNames('Presa Grande', ENTRIES)[0], {dex: 984, lang: 'print', name: 'Great Tusk', score: 1, spelling: 'Presa Grande'});
		assert.equal(E.matchNames('Pres4 Grancle', ENTRIES)[0].dex, 984, '4 for a, cl for d');
		assert.equal(E.matchNames('Maos Ferreas', ENTRIES)[0].name, 'Iron Hands', 'accents lost');
		assert.equal(E.matchNames('LuaEstrondo', ENTRIES)[0].dex, 1005, 'words run together');
		assert.equal(E.matchNames('BASICO Lua Estr0ndo', ENTRIES)[0].dex, 1005, 'the stage label before it');
	});

	test('French and German species names, misread, find the species', () => {
		assert.equal(E.matchNames('Bulbizarrc', ENTRIES)[0].name, 'Bulbasaur');
		assert.equal(E.matchNames('Bisasarn', ENTRIES)[0].name, 'Bulbasaur', 'm read as rn');
		assert.equal(E.matchNames('Salameche', ENTRIES)[0].name, 'Charmander');
		assert.equal(E.matchNames('G1umanda', ENTRIES)[0].name, 'Charmander');
	});

	test('a Trainer\'s name in any of the three languages names its English card, with no species', () => {
		const [german] = E.matchNames('Forschung des Profess0rs', ENTRIES);

		assert.deepEqual({dex: german.dex, name: german.name}, {dex: null, name: "Professor's Research"});
		assert.equal(E.matchNames('Pesquisa de Professores', ENTRIES)[0].name, "Professor's Research");
		assert.equal(E.matchNames('Doce Rar0', ENTRIES)[0].name, 'Rare Candy');
	});

	test('an English name read as printed keeps the plain answer, and noise names nothing', () => {
		assert.deepEqual(E.matchNames('Bulbasaur', ENTRIES)[0], {dex: 1, name: 'Bulbasaur', score: 1});
		assert.deepEqual(E.matchNames('~~ ,.', ENTRIES), []);
		assert.deepEqual(E.matchNames('Zzyzzx Qwvv', ENTRIES), []);
	});

	test('a card found by its number agrees with its name read in Portuguese', () => {
		const clues = E.cluesOf({name: {confidence: 0.9, text: 'Presa Grande'}, names: E.matchNames('Presa Grande', ENTRIES)});
		const scored = E.scoreCard(clues, {localId: '097', name: 'Great Tusk ex', official: '182'});

		assert.ok(scored.agree.includes('name'));
		assert.equal(scored.conflicts.length, 0);
	});
});

describe('the name route with translated names', () => {
	const sets = [{cardCount: {official: 182}, id: 'sv04', serie: 'sv'}, {cardCount: {official: 198}, id: 'sv01', serie: 'sv'}];
	const prints = {
		984: [{cardId: 'sv04-097', image: null, localId: '097', name: 'Great Tusk ex', releaseDate: '2023-11-03', setId: 'sv04', setName: 'Paradox Rift'}],
	};
	const trainers = {
		"Professor's Research": [{cardId: 'sv01-189', image: null, localId: '189', name: "Professor's Research", releaseDate: '2023-03-31', setId: 'sv01', setName: 'Scarlet & Violet'}],
	};
	const asked = [];
	const api = {
		allSets: async () => sets,
		cardDetail: async () => null,
		localNames: async () => ENTRIES,
		namedPrints: async (name) => {
			asked.push(name);

			return trainers[name] || [];
		},
		setDetail: async () => {
			throw new Error('the name route needs no set detail');
		},
		species: async () => [],
		speciesPrints: async (dex) => prints[dex] || [],
	};
	const nameOnly = (text) => S.summariseRead({language: {code: 'pt', confidence: 0.9, source: 'label'}, name: {confidence: 0.85, suffix: null, text}, number: null});

	test('a Portuguese Paradox name finds the English print, with no species list on the phone yet', async () => {
		const found = await findCandidates(nameOnly('Presa Grande'), 'pt', {api});

		assert.deepEqual(found.routes, ['name']);
		assert.equal(found.names[0].name, 'Great Tusk');
		assert.equal(found.names[0].spelling, 'Presa Grande');
		assert.equal(found.candidates[0].id, 'sv04-097');
		assert.ok(found.candidates[0].reasons.includes('name'));
	});

	test('a German Trainer name finds its prints by the English name', async () => {
		const found = await findCandidates(nameOnly('Forschung des Professors'), 'de', {api});

		assert.equal(found.candidates[0].id, 'sv01-189');
		assert.ok(found.candidates[0].reasons.includes('name'));
		assert.ok(asked.includes("Professor's Research"));
	});

	test('the Trainer lookup asks for the name and keeps only its prints, without TCG Pocket', () => {
		assert.match(namedPrintsQuery("Professor's Research"), /filters: \{name: "Professor's Research"\}/);

		const data = {cards: [
			{id: 'sv01-189', image: 'https://assets.tcgdex.net/en/sv/sv01/189', localId: '189', name: "Professor's Research", set: {id: 'sv01', name: 'Scarlet & Violet', releaseDate: '2023-03-31'}},
			{id: 'swsh1-178', image: null, localId: '178', name: "Professor's Research (Professor Magnolia)", set: {id: 'swsh1', name: 'Sword & Shield', releaseDate: '2020-02-07'}},
			{id: 'P-A-007', image: 'https://assets.tcgdex.net/en/tcgp/P-A/007', localId: '007', name: "Professor's Research", set: {id: 'P-A', name: 'Promo-A', releaseDate: '2024-10-30'}},
		]};

		assert.deepEqual(namedPrintsFrom(data, "Professor's Research").map((print) => print.cardId), ['sv01-189', 'swsh1-178'], 'the subtitle in brackets aside');
	});
});

describe('a picture that is not clear, a number that did not read, and a name', () => {
	const card = (id, score) => ({catalog: 'en', id, image: `https://assets/${id}`, score, set: id.split('-')[0]});
	const picture = {gap: 2, groups: [{cards: [card('sv04-099', 62)], score: 62}, {cards: [card('sv04-097', 63)], score: 63}, {cards: [card('sv01-050', 64)], score: 64}]};
	const names = {'sv01-050': 'Pikachu', 'sv04-097': 'Great Tusk ex', 'sv04-099': 'Iron Treads ex'};
	const api = {setDetail: async (lang, setId) => ({cardCount: {official: setId === 'sv04' ? 182 : 198}, cards: Object.entries(names).filter(([id]) => id.startsWith(setId)).map(([id, name]) => ({id, localId: id.split('-')[1], name})), name: setId})};
	const read = (text) => ({language: {code: 'pt', confidence: 0.9, source: 'label'}, name: {confidence: 0.8, suffix: 'ex', text}, number: null});
	const textRoute = async (r) => ({candidates: [], names: E.matchNames(r.name.text, ENTRIES)});

	test('the card of the five that bears the name read in Portuguese comes first, and is not sure', async () => {
		const found = await pictureMatch(picture, read('Presa Grand3'), 'pt', {api, textRoute});

		assert.equal(found.card.id, 'sv04-097');
		assert.equal(found.candidates[0].id, 'sv04-097');
		assert.equal(found.sure, false);
		assert.match(found.why, /name reads "Presa Grand3"/);
	});

	test('a name none of the five bears offers the cards the name route found first', async () => {
		const route = async () => ({candidates: [{id: 'sv03-001', name: 'Roaring Moon ex'}], names: E.matchNames('Lua Estrondo', ENTRIES)});
		const found = await pictureMatch(picture, read('Lua Estrondo'), 'pt', {api, textRoute: route});

		assert.equal(found.card, null);
		assert.deepEqual(found.candidates.map((c) => c.id), ['sv03-001', 'sv04-099', 'sv04-097', 'sv01-050']);
	});

	test('with no name read it is as before: the five, nothing picked', async () => {
		const found = await pictureMatch(picture, null, 'pt', {api, textRoute});

		assert.equal(found.card, null);
		assert.equal(found.candidates.length, 3);
	});
});

describe('the name table shipped with the app', () => {
	const file = new URL('../js/scan/local-names.json', import.meta.url);
	const text = readFileSync(file, 'utf8');
	const table = JSON.parse(text);
	const entries = localNameEntries(table);

	test('is small, names its sources and licences, and has no dashes the style forbids', () => {
		assert.ok(text.length < 100 * 1024, `${text.length} bytes`);
		assert.match(table.about, /PokeAPI.*BSD-3-Clause/);
		assert.match(table.about, /TCGdex.*MIT/);
		assert.doesNotMatch(text, /[\u2013\u2014]/);
		assert.equal(table.species.en.split('|').length, 1025);
	});

	test('holds the Portuguese Paradox Pokémon, French and German species, and Trainers', () => {
		const english = (name) => (E.matchNames(name, entries)[0] || {}).name;

		assert.equal(english('Presa Grande'), 'Great Tusk');
		assert.equal(english('Valentia Férrea'), 'Iron Valiant');
		assert.equal(english('Lua Estrondo'), 'Roaring Moon');
		assert.equal(english('Dracaufeu'), 'Charizard');
		assert.equal(english('Glurak'), 'Charizard');
		assert.equal(english('Pesquisa de Professores'), "Professor's Research");
		assert.equal(english('Sonderbonbon'), 'Rare Candy');
	});

	test('is fetched once, and a failed fetch is tried again', async () => {
		let asked = 0;
		const failing = await loadLocalNames({fetchImpl: async () => {
			asked++;

			return {ok: false, status: 503};
		}});

		assert.deepEqual(failing, []);

		const ok = {json: async () => TABLE, ok: true};
		const first = await loadLocalNames({fetchImpl: async () => {
			asked++;

			return ok;
		}});
		const second = await loadLocalNames({fetchImpl: async () => {
			throw new Error('asked twice');
		}});

		assert.equal(asked, 2);
		assert.equal(first.length, ENTRIES.length);
		assert.equal(second, first);
	});
});

describe('the OCR pool serves card reads before label checks (Eric\'s phone, version 38: reads waited up to 17 s)', () => {
	test('a background job waits while a foreground one waits, and holds one worker at most', async () => {
		const slots = createSlots();
		const order = [];
		const run = async (name, background) => {
			const slot = await slots.take(background);

			order.push(`${name} on ${slot.name}`);

			return () => slots.release(slot);
		};

		slots.release({name: 'w1'});
		slots.release({name: 'w2'});

		// Two label checks first: one takes a worker, the other waits, so the
		// second worker stays free for a card read.
		const label1 = run('label 1', true);
		const label2 = run('label 2', true);
		const done1 = await label1;

		await Promise.resolve();
		assert.deepEqual(order, ['label 1 on w1']);

		const read1 = await run('read 1', false);

		assert.deepEqual(order, ['label 1 on w1', 'read 1 on w2']);

		// Both busy: a read and a label check wait; the read goes first when
		// a worker comes free, even the label check's.
		const read2 = run('read 2', false);

		done1();
		await read2;
		assert.deepEqual(order, ['label 1 on w1', 'read 1 on w2', 'read 2 on w1']);
		assert.deepEqual(slots.waiting, {back: 1, front: 0});

		read1();
		await label2;
		assert.equal(order[3], 'label 2 on w2', 'the label check runs once no read waits');
	});
});
