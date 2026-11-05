// Unit tests for Send report and Sent reports (Eric, 2026-11-05): the
// report's names and the bucket's rule for them (js/scan/report-file.js,
// supabase/scan-reports.sql), gzip and parts, the size of a real-shaped log
// of 30 cards with pictures, the send queue and its retries
// (js/scan/report-queue.js), and one scan in words
// (js/scan/report-scans.js). Plain Node: the queue runs over a Map and a
// fake bucket, every card is from the scan log sample shape, and nothing is
// requested.
//
// Run: node --test tests/scan-reports.test.mjs

import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {describe, test} from 'node:test';

import {
	NAME_PATTERN,
	PART_BYTES,
	dataNames,
	failureKind,
	groupReports,
	metaName,
	packReport,
	parseName,
	partCount,
	partOf,
	problemText,
	reportBase,
	reportStamp,
	sizeText,
	stampDate,
	unpackReport,
} from '../js/scan/report-file.js';
import {createReportSender} from '../js/scan/report-queue.js';
import {scanErrors, scanView} from '../js/scan/report-scans.js';

import {REPORT_PATH} from './scan-reports-fake-storage.mjs';

const USER = '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed';
const OTHER = '2c8e7cde-ccfe-4c3e-8c6e-bc9efccd5cfe';
const AT = new Date('2026-11-05T10:19:19.274Z');

// A JPEG-sized picture: random bytes, which gzip cannot shrink, as it
// cannot shrink a JPEG's.
const picture = (bytes = 29000) => `data:image/jpeg;base64,${randomBytes(bytes).toString('base64')}`;

// One scan as the log file holds it (the shape of /tmp/scan-log-sample.json,
// js/scan/log.js logFile).
function entry(n, fields = {}) {
	return {
		app: 'v56',
		at: new Date(Date.parse('2026-11-05T10:00:00.000Z') + n * 20000).toISOString(),
		first: {
			card: {catalog: 'international', id: 'me01-001', lang: 'en', name: 'Bulbasaur', number: '001/132', set: 'Mega Evolution'},
			finish: 'normal',
			finishBy: 'default',
			labelCheck: null,
			language: 'pt',
			languageBy: 'default',
			languageSource: 'your last pick in Scan (no text was read)',
			status: 'ready',
			sure: true,
			why: null,
		},
		how: 'auto',
		id: `scan-${n}`,
		outcome: {at: '2026-11-05T10:30:00.000Z', card: 'me01-001', catalog: 'international', changed: true, changes: ['language'], copies: 2, finish: 'normal', finishBy: 'default', kind: 'saved', language: 'ko'},
		phone: {camera: '2160 x 3840', cores: 8, memory: 8, online: true, screen: '384 x 780 at 2.8125x', userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7)'},
		picture: picture(),
		report: {
			artworkMs: null,
			attackText: '',
			captureMs: 0,
			copyrightYear: 2025,
			fields: {name: {confidence: 88, ms: 210, text: 'Bulbasaur'}},
			frame: '2160 x 2987',
			geometry: {card: {angle: 1, h: 0.645, ratio: 0.717, w: 0.837, x: 0.079, y: 0.173}, holder: false, how: 'auto', zoom: null},
			hp: {after: false, value: 70},
			label: null,
			language: {code: 'pt', confidence: 0.36, source: 'label row'},
			match: {
				candidates: [
					{agree: ['name'], artwork: null, confidence: 0.92, conflicts: [], id: 'me01-001', lang: 'en', name: 'Bulbasaur', number: '001/132', reasons: ['picture', 'name'], score: 7, setName: 'Mega Evolution'},
					{agree: [], artwork: null, confidence: null, conflicts: ['number'], id: 'sm1-39', lang: 'en', name: 'Ivysaur', number: '39/149', reasons: ['picture'], score: 67.6, setName: 'Sun & Moon'},
				],
				count: 5,
				fullMs: null,
				indexMs: 0,
				language: 'pt',
				ms: 1562,
				names: [{name: 'Bulbasaur', score: 0.95}],
				partial: false,
				routes: ['picture', 'name'],
				searched: [],
				setName: null,
			},
			name: {confidence: 88, suffix: null, text: 'Bulbasaur'},
			number: {confidence: 91, printed: '001/132', secret: false, side: 'left'},
			ocr: true,
			ocrMs: 640,
			partial: null,
			picture: {before: null, fingerprintMs: 51, gap: 60.6, groups: [{cards: ['me01-001'], score: 7}, {cards: ['sm1-39'], score: 67.6}], how: 'the card found in the frame', matchMs: 78, turn: 0, variants: []},
			pictureIn: 'worker',
			pictureWhy: null,
			rectify: {angle: 0.6, card: '1002x1400', found: true, guessed: null, ms: 240, note: 'Card edges found.', ratio: 0.716},
			setCodeBox: null,
			source: 'camera',
			totalMs: 1059,
			wizards: false,
			workers: null,
		},
		scanner: 40,
		source: 'camera',
		timings: {fingerprint: 51, match: 1562, rectify: 240, total: 1059},
		...fields,
	};
}

// The scan log file, as Download scan log makes it.
function logFileOf(entries, name = 'scan-log-20261105-071919.json') {
	return new File([JSON.stringify({app: 'v56', entries, exported: AT.toISOString()}, null, 1)], name, {type: 'application/json'});
}

// ------------------------------------------------------------- names

describe('report names', () => {
	test('the stamp is ISO 8601 basic UTC with milliseconds, and the name carries the scan count', () => {
		assert.equal(reportStamp(AT), '20261105T101919.274Z');
		assert.equal(stampDate('20261105T101919.274Z').toISOString(), AT.toISOString());
		assert.equal(reportBase(AT, 30), '20261105T101919.274Z-30');
		assert.deepEqual(dataNames('20261105T101919.274Z-30', 'gzip'), ['20261105T101919.274Z-30.json.gz']);
		assert.deepEqual(dataNames('20261105T101919.274Z-30', 'none'), ['20261105T101919.274Z-30.json']);
		assert.deepEqual(dataNames('20261105T101919.274Z-30', 'gzip', 3), ['20261105T101919.274Z-30.json.gz.part1of3', '20261105T101919.274Z-30.json.gz.part2of3', '20261105T101919.274Z-30.json.gz.part3of3']);
		assert.equal(metaName('20261105T101919.274Z-30'), '20261105T101919.274Z-30.meta.json');
		assert.deepEqual(parseName('20261105T101919.274Z-30.json.gz.part2of3'), {base: '20261105T101919.274Z-30', encoding: 'gzip', kind: 'data', of: 3, part: 2});
		assert.equal(parseName('notes.txt'), null);
		assert.equal(parseName('20261105T101919Z-30.json'), null, 'no milliseconds: not a report name');
	});

	test('a listing groups each report\'s files, newest first, and says when parts are missing', () => {
		const listing = [
			{metadata: null, name: 'some-folder'},
			{metadata: {size: 900000}, name: '20261105T101919.274Z-30.json.gz'},
			{metadata: {size: 400}, name: '20261105T101919.274Z-30.meta.json'},
			{metadata: {size: 5242880}, name: '20261106T080000.000Z-400.json.gz.part2of3'},
			{metadata: {size: 5242880}, name: '20261106T080000.000Z-400.json.gz.part1of3'},
			{metadata: {size: 12}, name: 'stray.json'},
		];
		const reports = groupReports(listing);

		assert.deepEqual(reports.map((report) => report.base), ['20261106T080000.000Z-400', '20261105T101919.274Z-30']);
		assert.equal(reports[0].complete, false, '2 of 3 parts');
		assert.equal(reports[0].found, 2);
		assert.equal(reports[0].parts, 3);
		assert.equal(reports[0].meta, null);
		assert.deepEqual(reports[0].files, ['20261106T080000.000Z-400.json.gz.part1of3', '20261106T080000.000Z-400.json.gz.part2of3']);
		assert.equal(reports[1].complete, true);
		assert.equal(reports[1].count, 30);
		assert.equal(reports[1].bytes, 900000);
		assert.equal(reports[1].encoding, 'gzip');
		assert.equal(reports[1].meta, '20261105T101919.274Z-30.meta.json');
	});

	test('supabase/scan-reports.sql, the fake bucket, and the app agree on the name shape; the bucket is private and owner only', async () => {
		const sql = await readFile(new URL('../supabase/scan-reports.sql', import.meta.url), 'utf8');
		const code = sql.replace(/^\s*--.*$/gm, '');
		const pattern = /name ~ '([^']+)'/.exec(code)[1];

		assert.equal(pattern, REPORT_PATH.source.replace(/\\\//g, '/'), 'the fake bucket tests the rule the script sets');

		const rule = new RegExp(pattern);
		const base = reportBase(AT, 30);

		for (const name of [...dataNames(base, 'gzip'), ...dataNames(base, 'none'), ...dataNames(base, 'gzip', 12), metaName(base)]) {
			assert.ok(rule.test(`${USER}/${name}`), name);
			assert.ok(NAME_PATTERN.test(name), name);
		}

		assert.ok(!rule.test(`${USER}/../${base}.json`));
		assert.ok(!rule.test(`not-a-user/${base}.json`));
		assert.ok(!rule.test(`${USER}/${base}.json.zip`));
		assert.match(code, /values \('scan-reports', 'scan-reports', false, 6291456, array\['application\/gzip', 'application\/json'\]\)/);
		assert.equal((code.match(/create policy "scan-reports: /g) || []).length, 3, 'read, add, delete');
		assert.doesNotMatch(code, /for update|shares_group|to anon|public = true/, 'no replace, no family, nobody signed out');
		assert.equal((code.match(/\(storage\.foldername\(name\)\)\[1\] = \(select auth\.uid\(\)\)::text/g) || []).length, 3, 'every rule is the owner\'s folder');
	});
});

// ------------------------------------------------------------- bytes and size

describe('gzip, parts, and size', () => {
	test('the file goes back byte for byte through gzip and parts', async () => {
		const file = logFileOf([entry(1), entry(2)]);
		const packed = await packReport(file);

		assert.equal(packed.encoding, 'gzip');
		assert.equal(packed.type, 'application/gzip');
		assert.ok(packed.bytes < file.size, 'smaller');

		const pieces = Array.from({length: partCount(packed.bytes, 10000)}, (_, i) => partOf(packed.blob, i, 10000));

		assert.ok(pieces.length > 3);
		assert.ok(pieces.every((piece) => piece.size <= 10000));
		assert.equal(await unpackReport(pieces, 'gzip'), await file.text());

		const plain = await packReport(file, {gzip: false});

		assert.equal(plain.encoding, 'none');
		assert.equal(await unpackReport([plain.blob], 'none'), await file.text());
	});

	test('30 cards with pictures is about 1.3 MB as a file and goes up as one gzip piece of about 0.9 to 1 MB; 500 scans stay in 5 MiB parts', async () => {
		const file = logFileOf(Array.from({length: 30}, (_, n) => entry(n)));
		const packed = await packReport(file);

		console.log(`30 cards with pictures: file ${sizeText(file.size)}, sent ${sizeText(packed.bytes)} gzipped`);
		assert.ok(file.size > 1.1e6 && file.size < 1.5e6, `file ${file.size}`);
		assert.ok(packed.bytes > 0.8e6 && packed.bytes < 1.1e6, `gzip ${packed.bytes}`);
		assert.equal(partCount(packed.bytes), 1);

		// The log's limit (LOG_MAX) with pictures: parts, each under the
		// bucket's 6 MB file limit.
		const big = await packReport(logFileOf(Array.from({length: 500}, (_, n) => entry(n))));
		const parts = partCount(big.bytes);

		assert.ok(parts >= 3, `${parts} parts for ${big.bytes} bytes`);
		assert.ok(Array.from({length: parts}, (_, i) => partOf(big.blob, i).size).every((size) => size <= PART_BYTES && size <= 6291456));
	});

	test('sizes in words', () => {
		assert.equal(sizeText(85000), '85 KB');
		assert.equal(sizeText(930000), '930 KB');
		assert.equal(sizeText(1330000), '1.3 MB');
	});
});

// ------------------------------------------------------------- the queue

// A bucket that keeps what it is sent. fail(path, call) answers an error
// for that upload, or null.
function fakeBucket(fail = () => null) {
	const files = new Map();
	const calls = [];
	const client = {
		storage: {
			from: (bucket) => ({
				async upload(path, body, options) {
					calls.push({bucket, options, path, size: body.byteLength});

					const error = fail(path, calls.length);

					if (error) {
						return {data: null, error};
					}

					if (files.has(path)) {
						return {data: null, error: {message: 'The resource already exists', status: 409}};
					}

					files.set(path, {body: Buffer.from(body), type: options.contentType});

					return {data: {path}, error: null};
				},
			}),
		},
	};

	return {calls, client, files};
}

function setup({fail, partBytes, user = {id: USER}} = {}) {
	const rows = new Map();
	const bucket = fakeBucket(fail);
	const timers = [];
	const state = {expired: false, online: true, user};
	const events = [];
	let clock = AT.getTime();
	const sender = createReportSender({
		clearTimer: () => {},
		currentUser: () => state.user,
		expired: () => state.expired,
		getClient: async () => bucket.client,
		isAuth: (status) => status === 401,
		now: () => new Date(clock++),
		online: () => state.online,
		partBytes,
		setTimer: (fn, ms) => {
			timers.push({fn, ms});

			return timers.length;
		},
		store: {
			all: async () => [...rows.values()].map((row) => ({...row})),
			put: async (row) => {
				rows.set(row.id, {...row});
			},
			remove: async (id) => {
				rows.delete(id);
			},
		},
	});

	sender.onChange((event) => events.push(event));

	return {bucket, events, rows, sender, state, timers};
}

describe('the send queue', () => {
	test('Send report keeps the file on the phone first, then sends the log and its meta file under the owner\'s folder', async () => {
		const {bucket, events, rows, sender} = setup();
		const file = logFileOf([entry(1), entry(2), entry(3, {picture: null})]);
		const row = await sender.add({file, note: '  Korean cards,\n glare ', userId: USER});

		assert.equal(rows.size, 1, 'kept before anything goes out');
		assert.equal(row.base, '20261105T101919.274Z-3');
		assert.equal(row.note, 'Korean cards, glare');
		assert.deepEqual(row.entry_ids, ['scan-1', 'scan-2', 'scan-3']);
		assert.equal('blob' in row, false, 'a summary has no file');

		await sender.flush();

		assert.deepEqual(bucket.calls.map((call) => call.path), [`${USER}/20261105T101919.274Z-3.json.gz`, `${USER}/20261105T101919.274Z-3.meta.json`], 'the log, then its meta');
		assert.ok(bucket.calls.every((call) => call.bucket === 'scan-reports' && call.options.upsert === false));

		const sent = bucket.files.get(`${USER}/20261105T101919.274Z-3.json.gz`);

		assert.equal(sent.type, 'application/gzip');
		assert.equal(await unpackReport([new Blob([sent.body])], 'gzip'), await file.text(), 'exactly the file Download makes');

		const meta = JSON.parse(bucket.files.get(`${USER}/20261105T101919.274Z-3.meta.json`).body);

		assert.equal(meta.note, 'Korean cards, glare');
		assert.equal(meta.count, 3);
		assert.equal(meta.pictures, 2);
		assert.equal(meta.file, 'scan-log-20261105-071919.json');
		assert.equal(meta.raw_bytes, file.size);
		assert.deepEqual(meta.scanners, [40]);
		assert.equal(rows.size, 0, 'dropped once every file is in');
		assert.deepEqual(events.map((event) => event.type), ['queued', 'progress', 'sent', 'idle']);
		assert.deepEqual(sender.lastSent().entry_ids, ['scan-1', 'scan-2', 'scan-3'], 'for Clear the sent scans');
	});

	test('offline or signed out it waits on the phone; back online it goes; another person\'s report waits for them', async () => {
		const {bucket, rows, sender, state} = setup();

		state.online = false;
		await sender.add({file: logFileOf([entry(1)]), userId: USER});
		await sender.add({file: logFileOf([entry(2)]), userId: OTHER});
		await sender.flush();
		assert.equal(bucket.calls.length, 0, 'nothing tried with no connection');

		state.online = true;
		state.user = null;
		await sender.flush();
		assert.equal(bucket.calls.length, 0, 'nothing tried signed out');

		state.user = {id: USER};
		await sender.flush();
		assert.equal(bucket.files.size, 2);
		assert.deepEqual([...rows.values()].map((row) => row.user_id), [OTHER], 'the other account\'s report still waits');
	});

	test('a send cut off in part 2 of 3 keeps the report, retries on a timer, and goes on from part 2', async () => {
		let down = true;
		const {bucket, rows, sender, timers} = setup({
			fail: (path) => (down && path.endsWith('part2of3') ? {message: 'Failed to fetch', name: 'StorageUnknownError'} : null),
			partBytes: 2000,
		});
		const file = logFileOf([entry(1, {picture: picture(2600)})]);
		const row = await sender.add({file, userId: USER});

		assert.equal(row.parts, 3, 'three pieces at 2000 bytes');
		await sender.flush();

		const [waiting] = rows.values();

		assert.equal(waiting.sent_parts, 1);
		assert.equal(waiting.error_kind, 'retry');
		assert.equal(timers.length, 1, 'tried again by itself');
		assert.equal(timers[0].ms, 30000);
		assert.match(problemText(waiting), /Not sent yet: Failed to fetch\. It goes again by itself\./);

		down = false;
		await timers[0].fn();
		await sender.flush();

		const paths = bucket.calls.map((call) => call.path.split('/')[1]);

		assert.deepEqual(paths.filter((name) => name.endsWith('part1of3')).length, 1, 'part 1 is not sent twice');
		assert.equal(rows.size, 0);
		assert.equal(await unpackReport([1, 2, 3].map((n) => new Blob([bucket.files.get(`${USER}/${row.base}.json.gz.part${n}of3`).body])), 'gzip'), await file.text());
	});

	test('a piece already in the bucket (its answer was lost) counts as sent', async () => {
		const {bucket, rows, sender} = setup();
		const row = await sender.add({file: logFileOf([entry(1)]), userId: USER});

		bucket.files.set(`${USER}/${row.base}.json.gz`, {body: Buffer.from('x'), type: 'application/gzip'});
		await sender.flush();
		assert.equal(rows.size, 0);
		assert.ok(bucket.files.has(`${USER}/${row.base}.meta.json`));
		assert.equal(failureKind({message: 'The resource already exists', statusCode: '409'}), 'exists');
	});

	test('a refusal is kept with its reason and not tried again until Try again; a refused token waits for a sign-in', async () => {
		let answer = {message: 'Bucket not found', status: 400};
		const {bucket, rows, sender, timers} = setup({fail: () => answer});

		await sender.add({file: logFileOf([entry(1)]), userId: USER});
		await sender.flush();
		await sender.flush();

		const [refused] = rows.values();

		assert.equal(refused.error_kind, 'refused');
		assert.equal(bucket.calls.length, 1, 'not repeated by every flush');
		assert.equal(timers.length, 0);
		assert.match(problemText(refused), /no place for reports yet .*supabase\/scan-reports\.sql/);

		answer = {message: 'Invalid JWT', status: 401};
		await sender.retry();
		assert.equal([...rows.values()][0].error_kind, 'auth');
		assert.equal(problemText([...rows.values()][0]), 'Sign in again to send it.');

		answer = null;
		await sender.retry();
		assert.equal(rows.size, 0, 'sent');
	});

	test('a refused report can be saved as a file or removed; nothing else removes one', async () => {
		const {rows, sender} = setup({fail: () => ({message: 'The object exceeded the maximum allowed size', status: 413})});
		const row = await sender.add({file: logFileOf([entry(1)]), userId: USER});

		await sender.flush();
		assert.equal(problemText([...rows.values()][0]), 'Not sent: too large for the server.');

		const saved = await sender.fileOf(row.id);

		assert.equal(saved.name, `${row.base}.json.gz`);
		assert.ok(saved.blob.size > 0);
		assert.equal(await sender.remove(row.id), true);
		assert.equal(rows.size, 0);
	});
});

// ------------------------------------------------------------- one scan in words

const sectionOf = (view, title) => (view.sections.find((section) => section.title === title) || {lines: []}).lines;

describe('one scan in words', () => {
	test('time, scanner version, what was read, both routes, the candidates with the answer and the saved one, the picture, and no errors', () => {
		const view = scanView(entry(3), 2, 30);

		assert.equal(view.title, 'Scan 3 of 30: Bulbasaur, 001/132');
		assert.match(view.picture, /^data:image\/jpeg;base64,/);
		assert.equal(view.errors, 0);
		assert.deepEqual(sectionOf(view, 'Scan'), ['Time: 2026-11-05T10:01:00.000Z', 'Scanner version: 40; app v56', 'Source: the camera, taken automatically']);
		assert.ok(sectionOf(view, 'What was read').includes('Name: "Bulbasaur" (88 %)'));
		assert.ok(sectionOf(view, 'What was read').includes('Number: 001/132 (91 %, left side)'));
		assert.ok(sectionOf(view, 'What was read').includes('Language: pt (36 %, from label row)'));
		assert.ok(sectionOf(view, 'Text route').includes('Name strip: "Bulbasaur" (confidence 88, 210 ms)'));
		assert.ok(sectionOf(view, 'Text route').includes('Species the name matched: Bulbasaur (0.95)'));
		assert.ok(sectionOf(view, 'Picture route').includes('1. me01-001: distance 7'));
		assert.match(sectionOf(view, 'Candidates')[1], /^1\. Bulbasaur, 001\/132, Mega Evolution \(me01-001, en\): score 7, confidence 92 %; why: picture; name; agrees: name {2}<- the scanner's answer, saved$/);
		assert.match(sectionOf(view, 'Candidates')[2], /against: number$/);
		assert.deepEqual(sectionOf(view, 'Saved'), ['Saved: Bulbasaur, 001/132 (me01-001), language ko, finish normal (default), 2 copies', 'Changed by hand from the scanner\'s answer: language']);
		assert.deepEqual(sectionOf(view, 'Errors'), ['None.']);
	});

	test('errors are named, and a holder drop that took nothing reads as one with its views', () => {
		const failed = entry(1, {error: 'TypeError: x is undefined\n at read', first: {...entry(1).first, status: 'no card'}, report: {...entry(1).report, pictureWhy: 'timeout', rectify: {found: false, ms: 300}}});

		assert.deepEqual(scanErrors(failed), ['Error: TypeError: x is undefined | at read', 'The card\'s edges were not found.', 'The picture match left the worker: timeout.', 'The scanner stopped at: no card.']);

		const drop = scanView({app: 'v56', at: '2026-11-05T10:00:00.000Z', drop: {change: 0.4, share: 0.02}, first: null, how: 'holder', id: 'event-1', outcome: {at: '2026-11-05T10:00:00.000Z', kind: 'skipped', why: 'small'}, phone: null, picture: null, report: null, scanner: 40, source: 'camera', views: {after: 'data:image/jpeg;base64,AAAA', before: 'data:image/jpeg;base64,BBBB'}, why: 'small'}, 0, 1);

		assert.equal(drop.title, 'Scan 1 of 1: a drop that took nothing');
		assert.equal(drop.picture, null);
		assert.deepEqual(drop.views, {after: 'data:image/jpeg;base64,AAAA', before: 'data:image/jpeg;base64,BBBB'});
		assert.ok(sectionOf(drop, 'Scan').includes('Source: holder mode: a drop that took nothing'));
		assert.deepEqual(sectionOf(drop, 'Saved'), ['Skipped: small.']);
		assert.ok(sectionOf(drop, 'Framing').includes('Drop: {"change":0.4,"share":0.02}'));
		assert.deepEqual(sectionOf(drop, 'Errors'), ['Nothing taken: small.']);
		assert.deepEqual(sectionOf(drop, 'What was read'), []);
	});

	test('a field this screen does not know is still shown', () => {
		const view = scanView(entry(1, {newThing: {a: 1}}), 0, 1);

		assert.deepEqual(sectionOf(view, 'Other fields'), ['newThing: {"a":1}']);
	});
});
