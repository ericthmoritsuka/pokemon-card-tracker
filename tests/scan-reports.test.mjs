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
	CLEANUP_EVERY_MS,
	CLEANUP_KEY,
	LIST_PAGE,
	NAME_PATTERN,
	PART_BYTES,
	REPORT_KEEP_DAYS,
	createReportCleanup,
	dataNames,
	deleteAt,
	failureKind,
	groupReports,
	metaName,
	packReport,
	parseName,
	partCount,
	partOf,
	problemText,
	readReport,
	readReports,
	reportBase,
	removeReport,
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
// for that upload, or null; uploaded(path, files) runs after an upload is
// kept (another device deleting files in between). list answers names
// starting with `search`, as Supabase Storage does, and remove deletes.
function fakeBucket(fail = () => null, uploaded = () => {}) {
	const files = new Map();
	const calls = [];
	const lists = [];
	const removes = [];
	const client = {
		storage: {
			from: (bucket) => ({
				async list(folder, {limit = 100, offset = 0, search = ''} = {}) {
					lists.push({folder, limit, offset, search});

					const names = [...files.keys()].filter((path) => path.startsWith(`${folder}/`)).map((path) => path.slice(folder.length + 1)).filter((name) => name.startsWith(search)).sort();

					return {data: names.slice(offset, offset + limit).map((name) => ({metadata: {size: files.get(`${folder}/${name}`).body.length}, name})), error: null};
				},
				async remove(paths) {
					removes.push(paths);

					const gone = paths.filter((path) => files.delete(path));

					return {data: gone.map((name) => ({name})), error: null};
				},
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
					uploaded(path, files);

					return {data: {path}, error: null};
				},
			}),
		},
	};

	return {calls, client, files, lists, removes};
}

// The sender over a Map and a fake bucket. state.clock is the time the
// waits count in; running a timer moves it on to when the timer was due.
function setup({fail, partBytes, uploaded, user = {id: USER}} = {}) {
	const rows = new Map();
	const bucket = fakeBucket(fail, uploaded);
	const timers = [];
	const state = {clock: AT.getTime(), expired: false, online: true, user};
	const events = [];
	let clock = AT.getTime();
	const sender = createReportSender({
		clearTimer: (id) => {
			timers[id - 1].cleared = true;
		},
		clock: () => state.clock,
		currentUser: () => state.user,
		expired: () => state.expired,
		getClient: async () => bucket.client,
		isAuth: (status) => status === 401,
		now: () => new Date(clock++),
		online: () => state.online,
		partBytes,
		setTimer: (fn, ms) => {
			const due = state.clock + ms;
			const timer = {
				fn: () => {
					timer.ran = true;
					state.clock = Math.max(state.clock, due);

					return fn();
				},
				ms,
			};

			timers.push(timer);

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

describe('the send queue, reports going up at once', () => {
	test('a report deleted on another device between its parts stops: nothing more goes up, nothing is left half sent, and the phone keeps its copy until it has said so', async () => {
		let down = true;
		const {bucket, events, rows, sender, timers} = setup({
			fail: (path) => (down && path.endsWith('part2of3') ? {message: 'Service Unavailable', status: 503} : null),
			partBytes: 2000,
		});
		const row = await sender.add({file: logFileOf([entry(1, {picture: picture(2600)})]), userId: USER});

		await sender.flush();
		assert.equal([...rows.values()][0].sent_parts, 1, 'part 1 is up, part 2 failed');

		// Sent reports > Delete on the desktop removes every file it lists.
		bucket.files.clear();
		down = false;

		const uploads = bucket.calls.length;

		await timers[0].fn();
		await sender.flush();

		assert.equal(bucket.calls.length, uploads, 'no part goes up after the delete');
		assert.equal(bucket.files.size, 0, 'no report is left that can never finish');
		assert.ok(bucket.lists.length > 0 && bucket.lists.every((list) => list.folder === USER && list.search === `${row.base}.`), 'only this report\'s files are looked up');

		const [stopped] = rows.values();

		assert.equal(stopped.error_kind, 'deleted', 'kept on the phone until the person is told');
		assert.match(problemText(stopped), /deleted from your account on another device/);
		assert.equal(events.filter((event) => event.type === 'failed').at(-1).row.error_kind, 'deleted');
		assert.equal(timers.length, 1, 'not tried again by itself');

		await sender.retry();
		assert.equal(bucket.calls.length, uploads, 'Try sending again does not send it either');
		assert.equal(await sender.remove(row.id), true, 'removed once the person has seen it');
		assert.equal(rows.size, 0);
	});

	test('a report deleted on another device after its last part is not finished with a meta file alone', async () => {
		const {bucket, rows, sender} = setup({
			partBytes: 2000,
			uploaded: (path, files) => {
				if (path.endsWith('part2of3')) {
					files.clear();
				}
			},
		});

		await sender.add({file: logFileOf([entry(1, {picture: picture(2600)})]), userId: USER});
		await sender.flush();

		assert.equal(bucket.calls.some((call) => call.path.endsWith('.meta.json')), false, 'no meta file');
		assert.equal(bucket.files.size, 0, 'part 3, sent after the delete, is removed again');
		assert.equal([...rows.values()][0].error_kind, 'deleted');
	});

	test('a report failing for a while does not hold the newer ones back, and each waits its own growing time', async () => {
		const failing = new Set();
		const {bucket, rows, sender, timers} = setup({fail: (path) => ([...failing].some((base) => path.includes(`/${base}.`)) ? {message: 'Failed to fetch', name: 'StorageUnknownError'} : null)});
		const older = await sender.add({file: logFileOf([entry(1)]), userId: USER});
		const newer = await sender.add({file: logFileOf([entry(2)]), userId: USER});
		const tries = (base) => bucket.calls.filter((call) => call.path.includes(`/${base}.`)).length;

		failing.add(older.base);
		await sender.flush();
		assert.ok(bucket.files.has(`${USER}/${newer.base}.meta.json`), 'the newer report went');
		assert.deepEqual([...rows.keys()], [older.base]);
		assert.equal(timers.length, 1);
		assert.equal(timers[0].ms, 30000);

		await sender.flush();
		assert.equal(tries(older.base), 1, 'not tried again before its wait is over');

		await timers[0].fn();
		await sender.flush();
		assert.equal(tries(older.base), 2);
		assert.equal(timers.at(-1).ms, 60000, 'its wait grows');

		// A third report fails once: its own first wait, which ends sooner.
		const third = await sender.add({file: logFileOf([entry(3)]), userId: USER});

		failing.add(third.base);
		await sender.flush();
		assert.equal(tries(older.base), 2, 'the first still waits');
		assert.equal(timers.at(-1).ms, 30000, 'the third waits its own 30 s');
		assert.ok(timers.slice(0, -1).every((timer) => timer.cleared || timer.ran), 'one timer at a time');

		failing.clear();
		await timers.at(-1).fn();
		await sender.flush();
		assert.ok(bucket.files.has(`${USER}/${third.base}.meta.json`), 'the third went when its wait was over');
		assert.ok(rows.has(older.base), 'the first still waits for its own time');
		assert.equal(timers.at(-1).ms, 30000, 'and is woken when it is over');

		// Back online: everything waiting goes at once.
		await sender.wake();
		assert.equal(rows.size, 0);
	});
});

// ------------------------------------------------------------- reading

// A person's folder in the bucket with `count` reports of 3 scans, one
// second apart, plain JSON, each with its meta file; list honours limit,
// offset, and search (a name prefix), as Supabase Storage does. Counts
// every list and download.
function folderOf(count, {extra = []} = {}) {
	const objects = new Map();
	const lists = [];
	const downloads = [];
	const bases = [];
	const put = (base, note) => {
		bases.push(base);
		objects.set(`${USER}/${base}.json`, JSON.stringify({app: 'v56', entries: [{id: `${base}-a`}], exported: AT.toISOString()}));
		objects.set(`${USER}/${metaName(base)}`, JSON.stringify({note, sent_at: stampDate(base).toISOString()}));
	};

	for (let i = 0; i < count; i++) {
		put(reportBase(new Date(AT.getTime() + i * 1000), 3), `note ${i}`);
	}

	for (const base of extra) {
		put(base, `note ${base}`);
	}

	const files = {
		async download(path) {
			downloads.push(path);

			return objects.has(path) ? {data: new Blob([objects.get(path)]), error: null} : {data: null, error: {message: 'Object not found', status: 400}};
		},
		async list(folder, {limit = 100, offset = 0, search = ''} = {}) {
			lists.push({folder, limit, offset, search});

			const names = [...objects.keys()].map((path) => path.slice(folder.length + 1)).filter((name) => name.startsWith(search)).sort().reverse();

			return {data: names.slice(offset, offset + limit).map((name) => ({metadata: {size: objects.get(`${USER}/${name}`).length}, name})), error: null};
		},
	};

	return {bases, downloads, files, lists};
}

describe('reading reports from the bucket', () => {
	test('Sent reports pages through the folder, so every report is listed however many there are', async () => {
		const {bases, files, lists} = folderOf(5);
		const reports = await readReports(files, USER, {page: 4});

		assert.deepEqual(reports.map((report) => report.base), [...bases].reverse(), 'all five, newest first');
		assert.deepEqual(lists.map((list) => list.offset), [0, 4, 8], 'ten files in pages of four');
		assert.deepEqual(reports.map((report) => report.info.note), ['note 4', 'note 3', 'note 2', 'note 1', 'note 0']);
		assert.equal(LIST_PAGE, 1000);
	});

	test('opening one report lists only its files and downloads only them', async () => {
		const at = new Date(AT.getTime() + 2000);
		const {bases, downloads, files, lists} = folderOf(5, {extra: [reportBase(at, 30)]});
		const target = bases[2];

		assert.equal(target, reportBase(at, 3), 'a report whose name starts another\'s');

		const opened = await readReport(files, USER, target);

		assert.deepEqual(lists.map((list) => list.search), [`${target}.`], 'one list, of this report');
		assert.deepEqual(downloads.sort(), [`${USER}/${target}.json`, `${USER}/${target}.meta.json`]);
		assert.equal(opened.info.note, 'note 2');
		assert.deepEqual(opened.log.entries.map((item) => item.id), [`${target}-a`]);
		assert.equal(opened.report.base, target);
		await assert.rejects(readReport(files, USER, reportBase(new Date(AT.getTime() + 99000), 3)), /not in your account/);
	});
});

// ------------------------------------------------------------- cleanup

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-12-10T12:00:00.000Z');

// A folder with reports sent `days` ago each (a 3-part gzip log and its
// meta file, or one JSON file), plus any other names, read and deleted
// through readReports and removeReport as js/scan/reports.js does. The
// clock, the phone's storage, the outbox, and who is signed in are state.
function cleanupSetup({days = [], extra = [], failRemove = () => false, queued = []} = {}) {
	const objects = new Map();
	const removes = [];
	const warnings = [];
	const state = {listed: 0, now: NOW, online: true, user: {id: USER}};
	const bases = days.map((ago, i) => reportBase(new Date(NOW - ago * DAY), 10 + i));

	bases.forEach((base, i) => {
		const names = i % 2 ? dataNames(base, 'none') : dataNames(base, 'gzip', 3);

		for (const name of [...names, metaName(base)]) {
			objects.set(`${USER}/${name}`, '{}');
		}
	});

	for (const name of extra) {
		objects.set(`${USER}/${name}`, '{}');
	}

	const files = {
		async download(path) {
			return {data: new Blob([objects.get(path) || '{}']), error: null};
		},
		async list(folder, {limit = 100, offset = 0, search = ''} = {}) {
			state.listed++;

			const names = [...objects.keys()].filter((path) => path.startsWith(`${folder}/`)).map((path) => path.slice(folder.length + 1)).filter((name) => name.startsWith(search)).sort().reverse();

			return {data: names.slice(offset, offset + limit).map((name) => ({metadata: {size: 2}, name})), error: null};
		},
		async remove(paths) {
			removes.push(paths);

			if (failRemove(paths)) {
				return {data: null, error: {message: 'Service unavailable', status: 503}};
			}

			return {data: paths.filter((path) => objects.delete(path)).map((name) => ({name})), error: null};
		},
	};
	const kept = new Map();
	const cleanup = createReportCleanup({
		currentUser: () => state.user,
		deleteReport: (report) => removeReport(files, USER, report),
		listReports: () => readReports(files, USER),
		now: () => state.now,
		online: () => state.online,
		storage: {getItem: (key) => (kept.has(key) ? kept.get(key) : null), setItem: (key, value) => kept.set(key, value)},
		waiting: async () => queued.map((index) => ({base: bases[index]})),
		warn: (...args) => warnings.push(args.join(' ')),
	});
	const left = () => [...objects.keys()].map((path) => path.slice(USER.length + 1)).sort();

	return {bases, cleanup, kept, left, removes, state, warnings};
}

describe('deleting old reports', () => {
	test('a report sent 31 days ago goes with all its parts and its meta file in one delete; one sent 29 days ago stays', async () => {
		const {bases, cleanup, left, removes, warnings} = cleanupSetup({days: [31, 29]});
		const result = await cleanup.run();

		assert.equal(REPORT_KEEP_DAYS, 30);
		assert.deepEqual(result, {deleted: 1, failed: 0});
		assert.deepEqual(removes, [[...dataNames(bases[0], 'gzip', 3), metaName(bases[0])].map((name) => `${USER}/${name}`)], 'one call, every file of the old report');
		assert.deepEqual(left(), [...dataNames(bases[1], 'none'), metaName(bases[1])].sort());
		assert.deepEqual(warnings, []);
		assert.equal(deleteAt(stampDate(bases[1])).getTime(), NOW + DAY, 'the kept one goes in a day');
	});

	test('names it cannot read as a report, and a report still in the phone\'s outbox, are never deleted', async () => {
		const extra = ['notes.txt', '2026-01-01.json', 'old.json.gz', '20251001T000000Z-3.json'];
		const {bases, cleanup, left, removes} = cleanupSetup({days: [40, 45], extra, queued: [1]});

		assert.deepEqual(await cleanup.run(), {deleted: 1, failed: 0});
		assert.equal(removes.length, 1);
		assert.ok(removes[0].every((path) => path.includes(bases[0])));
		assert.deepEqual(left(), [...extra, ...dataNames(bases[1], 'none'), metaName(bases[1])].sort());
	});

	test('it runs at most once a day on a phone', async () => {
		const {cleanup, kept, state} = cleanupSetup({days: [31]});

		await cleanup.run();
		assert.equal(state.listed, 1);
		assert.equal(kept.get(`${CLEANUP_KEY}:${USER}`), String(NOW));

		state.now = NOW + CLEANUP_EVERY_MS - 1;
		assert.deepEqual(await cleanup.run(), {skipped: 'ran today'});
		assert.equal(state.listed, 1, 'not listed again the same day');

		state.now = NOW + CLEANUP_EVERY_MS;
		assert.deepEqual(await cleanup.run(), {deleted: 0, failed: 0});
		assert.equal(state.listed, 2, 'listed again the next day');
	});

	test('signed out or offline it does nothing, and runs once signed in and online', async () => {
		const {cleanup, kept, left, state} = cleanupSetup({days: [31]});

		state.user = null;
		assert.deepEqual(await cleanup.run(), {skipped: 'signed out'});
		state.user = {id: USER};
		state.online = false;
		assert.deepEqual(await cleanup.run(), {skipped: 'offline'});
		assert.equal(state.listed, 0);
		assert.equal(kept.size, 0, 'no day noted');
		assert.equal(left().length, 4, '3 parts and the meta file');

		state.online = true;
		assert.deepEqual(await cleanup.run(), {deleted: 1, failed: 0});
		assert.deepEqual(left(), []);
	});

	test('a failed delete does not throw, only warns, and is tried again the next day', async () => {
		let down = true;
		const {cleanup, left, removes, state, warnings} = cleanupSetup({days: [31, 35], failRemove: () => down});

		assert.deepEqual(await cleanup.run(), {deleted: 0, failed: 2});
		assert.equal(warnings.length, 2);
		assert.match(warnings[0], /not deleted; tried again another day/);
		assert.equal(left().length, 6, 'nothing deleted');

		down = false;
		state.now = NOW + DAY / 2;
		assert.deepEqual(await cleanup.run(), {skipped: 'ran today'});
		state.now = NOW + DAY;
		assert.deepEqual(await cleanup.run(), {deleted: 2, failed: 0});
		assert.deepEqual(left(), []);
		assert.equal(removes.length, 4);
	});

	test('a listing that fails, or a phone whose storage throws, does not throw either', async () => {
		const warnings = [];
		const cleanup = createReportCleanup({
			currentUser: () => ({id: USER}),
			deleteReport: async () => assert.fail('nothing to delete'),
			listReports: async () => {
				throw new Error('Failed to fetch');
			},
			now: () => NOW,
			storage: {
				getItem: () => {
					throw new Error('SecurityError');
				},
				setItem: () => {
					throw new Error('SecurityError');
				},
			},
			warn: (...args) => warnings.push(args.join(' ')),
		});
		const result = await cleanup.run();

		assert.equal(result.error.message, 'Failed to fetch');
		assert.match(warnings[0], /not checked; tried again another day/);
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
