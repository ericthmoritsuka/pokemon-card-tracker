// js/photos/save.js in Node: the file names Save image gives, and what it
// does when the image cannot be read (the doubled CORS header, a blocked
// tab, no connection). The browser side is tests/photos-save-browser.test.mjs.
//
// Run: node --test tests/photos-save.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {cardFileStem, cleanFileName, imageLanguage, officialUrls, saveSlideImage, slideFileStem} from '../js/photos/save.js';

const BASE = 'https://assets.tcgdex.net/en/sv08/057';
const INFO = {name: 'Pikachu ex', number: '057', setName: 'Surging Sparks'};
const OFFICIAL = {id: 'official', kind: 'official', label: 'Official', src: `${BASE}/high.webp`};

describe('file names', () => {
	test('a card\'s name, set, number, and image language', () => {
		assert.equal(cardFileStem(INFO), 'Pikachu ex - Surging Sparks 057');
		assert.equal(slideFileStem(OFFICIAL, {info: INFO}), 'Pikachu ex - Surging Sparks 057 (EN)');
		assert.equal(slideFileStem({...OFFICIAL, src: 'https://assets.tcgdex.net/pt/me/me01/001/high.webp'}, {info: INFO}), 'Pikachu ex - Surging Sparks 057 (PT)');
		assert.equal(slideFileStem({id: 'twin', kind: 'twin', src: `${BASE}/high.webp`}, {info: INFO}), 'Pikachu ex - Surging Sparks 057 international print (EN)');
	});

	test('a photo is numbered among the card\'s photos', () => {
		const a = {id: 'a', kind: 'photo'};
		const b = {id: 'b', kind: 'photo'};
		const slides = [OFFICIAL, a, b];

		assert.equal(slideFileStem(a, {info: INFO, slides}), 'Pikachu ex - Surging Sparks 057 photo 1');
		assert.equal(slideFileStem(b, {info: INFO, slides}), 'Pikachu ex - Surging Sparks 057 photo 2');
	});

	test('characters Windows or Android refuse become spaces, and a missing part is left out', () => {
		assert.equal(cleanFileName('Unown ?: "A/B" <x>|y*z\\. '), 'Unown A B x y z');
		assert.equal(cleanFileName('Farfetch\'d - Base Set 27'), 'Farfetch\'d - Base Set 27');
		assert.equal(cleanFileName(''), 'Card');
		assert.equal(cardFileStem({name: 'Mew'}), 'Mew');
		assert.equal(cardFileStem({name: 'Mew', number: '151'}), 'Mew - 151');
	});

	test('the PNG and WebP beside an official image, and its language', () => {
		assert.deepEqual(officialUrls(`${BASE}/high.webp`), {png: `${BASE}/high.png`, webp: `${BASE}/high.webp`});
		assert.deepEqual(officialUrls(`${BASE}/low.webp`), {png: `${BASE}/high.png`, webp: `${BASE}/high.webp`});
		assert.equal(officialUrls(BASE), null);
		assert.equal(imageLanguage(`${BASE}/high.webp`), 'EN');
		assert.equal(imageLanguage('blob:https://example.test/1'), '');
	});
});

// What saveSlideImage did, with fetch, the relay, the download, the tab, and
// the toast faked.
function run(slide, {online = true, opens = true, reads = {}, relays = {}} = {}) {
	const did = {downloads: [], fetched: [], notices: [], tabs: []};

	const done = saveSlideImage(slide, {
		relay(url) {
			did.fetched.push(`relay ${url}`);

			return Promise.resolve(relays[url] || null);
		},
		download: (blob, name) => did.downloads.push(name),
		async fetchImpl(url, init) {
			did.fetched.push(`${init && init.mode} ${url}`);

			if (!(url in reads)) {
				throw new TypeError('Failed to fetch');
			}

			return new Response(reads[url], {status: reads[url] === null ? 404 : 200});
		},
		info: INFO,
		notify: (message, options) => did.notices.push({message, options}),
		online: () => online,
		open(url) {
			did.tabs.push(url);

			return opens;
		},
		resolveDetail: (item) => Promise.resolve(item.detailUrl || null),
		resolveSrc: (item) => Promise.resolve(item.url || null),
		slides: [OFFICIAL, {id: 'p', kind: 'photo', url: 'blob:p'}],
	});

	return done.then((result) => ({...did, result}));
}

describe('saving', () => {
	test('an official image reads its PNG in cors mode and downloads it', async () => {
		const did = await run(OFFICIAL, {reads: {[`${BASE}/high.png`]: new Blob(['png'], {type: 'image/png'})}});

		assert.deepEqual(did.fetched, [`cors ${BASE}/high.png`]);
		assert.deepEqual(did.downloads, ['Pikachu ex - Surging Sparks 057 (EN).png']);
		assert.deepEqual(did.tabs, []);
		assert.deepEqual(did.notices, []);
	});

	test('when the PNG cannot be read, the relay\'s PNG is saved, before any WebP', async () => {
		const did = await run(OFFICIAL, {
			reads: {[`${BASE}/high.webp`]: new Blob(['webp'], {type: 'image/webp'})},
			relays: {[`${BASE}/high.png`]: new Blob(['png'], {type: 'image/png'})},
		});

		assert.deepEqual(did.fetched, [`cors ${BASE}/high.png`, `relay ${BASE}/high.png`]);
		assert.deepEqual(did.downloads, ['Pikachu ex - Surging Sparks 057 (EN).png']);
		assert.deepEqual(did.tabs, []);
	});

	test('when nothing can be read, the PNG opens in a tab and a toast says so', async () => {
		const did = await run(OFFICIAL);

		assert.deepEqual(did.fetched, [`cors ${BASE}/high.png`, `relay ${BASE}/high.png`, `cors ${BASE}/high.webp`]);
		assert.deepEqual(did.tabs, [`${BASE}/high.png`]);
		assert.deepEqual(did.notices.map((notice) => notice.message), ['Opened the image in a new tab. Save it from there.']);
		assert.equal(did.result.outcome, 'tab');
	});

	test('a blocked tab leaves an Open image button on the toast, which opens it', async () => {
		const did = await run(OFFICIAL, {opens: false});

		assert.equal(did.result.outcome, 'blocked');
		assert.equal(did.notices.length, 1);
		assert.equal(did.notices[0].options.actionLabel, 'Open image');
		did.notices[0].options.action();
		assert.deepEqual(did.tabs, [`${BASE}/high.png`, `${BASE}/high.png`]);
	});

	test('offline, nothing opens and the toast says it needs a connection', async () => {
		const did = await run(OFFICIAL, {online: false});

		assert.deepEqual(did.tabs, []);
		assert.deepEqual(did.notices.map((notice) => notice.message), ['Saving the image needs a connection.']);
	});

	test('offline with the WebP still readable (kept by the service worker), the WebP is saved', async () => {
		const did = await run(OFFICIAL, {online: false, reads: {[`${BASE}/high.webp`]: new Blob(['webp'], {type: 'image/webp'})}});

		assert.deepEqual(did.downloads, ['Pikachu ex - Surging Sparks 057 (EN).webp']);
	});

	test('a photo saves its detail copy when there is one, named by its real type', async () => {
		const riff = new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])]);
		const photo = {detailUrl: 'blob:detail', id: 'p', kind: 'photo', url: 'blob:p'};
		const did = await run(photo, {reads: {'blob:detail': riff, 'blob:p': new Blob(['x'], {type: 'image/jpeg'})}});

		assert.deepEqual(did.fetched, ['cors blob:detail']);
		assert.deepEqual(did.downloads, ['Pikachu ex - Surging Sparks 057 photo 1.webp'], 'a WebP without a type, told by its bytes');
	});

	test('a photo not on this phone says so, or that it needs a connection', async () => {
		const photo = {id: 'p', kind: 'photo'};

		assert.deepEqual((await run(photo)).notices.map((notice) => notice.message), ['This photo is not on this phone yet. Try again in a moment.']);
		assert.deepEqual((await run(photo, {online: false})).notices.map((notice) => notice.message), ['Saving this photo needs a connection.']);
	});
});
