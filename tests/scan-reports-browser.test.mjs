// Browser tests for Send report and Sent reports (Eric, 2026-11-05), in
// headless Chromium against tests/pages-server.mjs with the whole app.
// Supabase, with Storage and the scan-reports bucket's rules, is
// tests/scan-reports-fake-storage.mjs; every other host answers 404, so no
// request leaves the machine. The scans are fake: entries written to the
// real scan log (js/scan/log.js) in the page, with drawn card pictures.
//
// - Send report puts exactly the Download file and a meta file under the
//   owner's folder; Clear the sent scans keeps a scan recorded since.
// - Sent reports lists it; the report reads as text with real images, also
//   at desktop width on a second device; Download gives the scan log file;
//   a family member sees none of it; Delete removes every file.
// - Offline, the report waits on the phone and goes when it is back online.
// - A project without the bucket keeps the report and says why; Try again
//   sends it once the bucket is there.
// - Signed out, Send report lists none of the reports waiting on the phone.
// - A report still going up can be deleted, with a note that the send
//   stops; the phone that was sending it says it was deleted, sends nothing
//   more, and drops its copy when Remove it is tapped.
//
// Screenshots: $SHOTS/scan-reports-*.png (default /tmp).
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/scan-reports-browser.test.mjs

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';
import {gunzipSync} from 'node:zlib';

import {startPagesServer} from './pages-server.mjs';
import {untilInPage} from './poll.mjs';
import {FakeReportStorage, SUPABASE_ORIGIN} from './scan-reports-fake-storage.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const PHONE = {height: 780, width: 384};
const DESKTOP = {height: 900, width: 1280};
const SHOTS = process.env.SHOTS || '/tmp';

let server;
let browser;

before(async () => {
	server = await startPagesServer();
	browser = await chromium.launch();
});

after(async () => {
	await browser.close();
	await server.close();
});

const url = (path = '') => `${server.origin}${BASE}${path}`;

async function device(fake, user, {viewport = PHONE} = {}) {
	const context = await browser.newContext({acceptDownloads: true, serviceWorkers: 'block', viewport});
	const errors = [];

	await context.route((target) => !target.href.startsWith(server.origin) && !target.href.startsWith(SUPABASE_ORIGIN), (route) => route.fulfill({body: '', status: 404}));
	await fake.attach(context, user.email);
	await context.addInitScript((value) => {
		if (!localStorage.getItem('card-tracker-auth')) {
			localStorage.setItem('card-tracker-auth', value);
		}
	}, JSON.stringify(fake.session(user)));

	const page = await context.newPage();

	page.on('pageerror', (err) => errors.push(String(err)));

	return {context, errors, page};
}

// Writes fake scans to the page's scan log, as the scanner would: each
// entry with the scanner's answer, its report, a saved outcome, and (when
// asked) a drawn card picture. Answers their ids.
function recordScans(page, {from = 1, pictures = [true], tag = 'a'} = {}) {
	return page.evaluate(async ({from, pictures, tag}) => {
		const log = await import('/pokemon-card-tracker/js/scan/log.js');
		const ids = [];

		log.setRecording(true);
		log.setPictures(true);

		for (const [index, withPicture] of pictures.entries()) {
			const n = from + index;
			const id = `scan-${tag}-${n}`;
			const card = {catalog: 'international', id: `me01-00${n}`, lang: 'ko', name: `Test card ${n}`, number: `00${n}/132`, set: 'Mega Evolution'};
			const report = {
				captureMs: 0,
				fields: {name: {confidence: 80 + n, ms: 200, text: `TEST CARD ${n}`}},
				language: {code: 'ko', confidence: 0.8, source: 'Korean model'},
				match: {candidates: [{agree: ['name'], artwork: null, confidence: 0.9, conflicts: [], id: card.id, lang: 'ko', name: card.name, number: card.number, reasons: ['picture', 'name'], score: 9, setName: card.set}], count: 1, language: 'ko', ms: 300, names: [{name: card.name, score: 0.9}], partial: false, routes: ['picture', 'name'], searched: []},
				name: {confidence: 80 + n, suffix: null, text: card.name},
				number: {confidence: 90, printed: card.number, secret: false, side: 'left'},
				ocr: true,
				ocrMs: 500,
				picture: {fingerprintMs: 40, gap: 50, groups: [{cards: [card.id], score: 9}], how: null, matchMs: 60, turn: 0, variants: []},
				pictureIn: 'worker',
				rectify: {angle: 0.5, card: '1002x1400', found: true, ms: 200, note: 'Card edges found.', ratio: 0.716},
				totalMs: 900,
			};

			await log.startEntry(id, {at: new Date(Date.now() + n).toISOString(), how: 'auto', phone: {userAgent: navigator.userAgent}, source: 'camera'});
			await log.noteFirst(id, {card, finish: 'normal', finishBy: 'default', language: 'ko', languageBy: 'read', languageSource: 'read from the card', status: 'ready', sure: true, why: null}, {report, timings: {total: 900}});

			if (withPicture) {
				const canvas = document.createElement('canvas');

				canvas.width = 300;
				canvas.height = 420;

				const ctx = canvas.getContext('2d');

				ctx.fillStyle = `hsl(${n * 70}, 60%, 55%)`;
				ctx.fillRect(0, 0, 300, 420);
				ctx.fillStyle = '#111';
				ctx.font = '40px sans-serif';
				ctx.fillText(`Card ${n}`, 40, 200);
				await log.savePicture(id, await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82)));
			}

			await log.savedOutcome(id, {card: card.id, catalog: 'international', copies: 1, finish: 'normal', finishBy: 'default', language: 'ko'});
			ids.push(id);
		}

		return ids;
	}, {from, pictures, tag});
}

// A phone nobody is signed in on.
async function signedOutDevice(fake) {
	const context = await browser.newContext({serviceWorkers: 'block', viewport: PHONE});
	const errors = [];

	await context.route((target) => !target.href.startsWith(server.origin) && !target.href.startsWith(SUPABASE_ORIGIN), (route) => route.fulfill({body: '', status: 404}));
	await fake.attach(context, 'signed-out');

	const page = await context.newPage();

	page.on('pageerror', (err) => errors.push(String(err)));

	return {context, errors, page};
}

// Puts a report row straight into the phone's send queue, as an earlier
// page left it.
function queueRow(page, fields) {
	return page.evaluate(async (fields) => {
		const {database} = await import('/pokemon-card-tracker/js/idb.js');
		const db = database('card-tracker-scan-reports', ['outbox']);
		const text = JSON.stringify({app: 'v56', entries: [{id: 'scan-q-1'}], exported: new Date().toISOString()});
		const row = {
			at: Date.now(),
			blob: new Blob([text], {type: 'application/json'}),
			bytes: text.length,
			count: 1,
			encoding: 'none',
			entry_ids: ['scan-q-1'],
			error: null,
			error_kind: null,
			error_status: null,
			meta: {base: fields.base, count: 1, note: ''},
			meta_sent: false,
			note: '',
			part_bytes: 5242880,
			parts: 1,
			raw_bytes: text.length,
			sent_parts: 0,
			type: 'application/json',
			...fields,
			id: fields.base,
		};

		await db.run('outbox', 'readwrite', (store) => store.put(row, row.id));
		(await db.open()).close();
	}, fields);
}

// The Send report panel's list of waiting reports once it has read the
// queue: the panel reads it as it opens, so a read after that one ends
// after it.
function waitingShown(page) {
	return page.evaluate(async () => {
		const {reportSender} = await import('/pokemon-card-tracker/js/scan/reports.js');

		await reportSender.waiting();
		await new Promise((resolve) => setTimeout(resolve, 0));

		return {
			items: [...document.querySelectorAll('#scan-report-waiting li')].map((li) => li.textContent),
			remove: document.querySelectorAll('#scan-report-waiting .scan-report-remove').length,
			retry: !document.getElementById('scan-report-retry').hidden,
			save: document.querySelectorAll('#scan-report-waiting .scan-report-save').length,
		};
	});
}

async function openCheck(page, count) {
	await page.goto(url('check'));
	await page.waitForSelector('#scan-report-send');
	await page.waitForFunction((n) => document.getElementById('scan-log-size').textContent.startsWith(`${n} scan${n === 1 ? '' : 's'} recorded`), count);
	await page.waitForFunction(() => !document.getElementById('scan-report-send').disabled, null, {timeout: 15000});
}

const statusText = (page) => page.locator('#scan-report-status').textContent();

function unpack(fake, path) {
	const object = fake.reports.get(path);

	return object && JSON.parse(gunzipSync(object.bytes).toString('utf8'));
}

function family(fake) {
	const eric = fake.addUser('eric@example.test');
	const member = fake.addUser('member@example.test');
	const group = {id: '7f3d2c1b-0a9e-4d8c-b7a6-5f4e3d2c1b0a', name: 'Family', owner_id: eric.id};

	fake.groups.push(group);
	fake.members.push({group_id: group.id, role: 'owner', user_id: eric.id}, {group_id: group.id, role: 'member', user_id: member.id});

	return {eric, member};
}

describe('Send report and Sent reports (Eric, 2026-11-05)', () => {
	test('send three scans with a note, clear only the sent ones, read the report on a phone and a desktop, download it, keep it from the family, and delete it', async () => {
		const fake = new FakeReportStorage();
		const {eric, member} = family(fake);
		const phone = await device(fake, eric);
		const {page} = phone;

		await page.goto(url('check'));
		await recordScans(page, {pictures: [true, false, true]});
		await openCheck(page, 3);
		await page.fill('#scan-report-note', 'Korean cards, glare');
		await page.screenshot({fullPage: true, path: `${SHOTS}/scan-reports-check.png`});
		await page.click('#scan-report-send');
		await page.waitForFunction(() => /^Sent: 3 scans, \d+ KB\. It is in Sent reports\.$/.test(document.getElementById('scan-report-status').textContent), null, {timeout: 15000});
		assert.equal(await page.inputValue('#scan-report-note'), '', 'the note is cleared for the next report');

		// Exactly the Download file, gzipped, and its meta file, under Eric's
		// folder.
		const files = fake.reportsOf(eric.id).map((object) => object.path.split('/')[1]).sort();

		assert.equal(files.length, 2);
		assert.match(files[0], /^\d{8}T\d{6}\.\d{3}Z-3\.json\.gz$/);
		assert.match(files[1], /^\d{8}T\d{6}\.\d{3}Z-3\.meta\.json$/);

		const log = unpack(fake, `${eric.id}/${files[0]}`);
		const meta = JSON.parse(fake.reports.get(`${eric.id}/${files[1]}`).bytes);

		assert.deepEqual(Object.keys(log).sort(), ['app', 'entries', 'exported']);
		assert.deepEqual(log.entries.map((entry) => entry.id), ['scan-a-1', 'scan-a-2', 'scan-a-3']);
		assert.match(log.entries[0].picture, /^data:image\/jpeg;base64,/);
		assert.equal(log.entries[1].picture, null);
		assert.equal('firstLocked' in log.entries[0], false, 'the file Download makes');
		assert.equal(meta.note, 'Korean cards, glare');
		assert.equal(meta.pictures, 2);
		assert.equal(fake.reportsOf(member.id).length, 0);

		// A scan recorded after the send is kept by Clear the sent scans.
		await recordScans(page, {from: 4, pictures: [true], tag: 'b'});
		await page.waitForSelector('#scan-report-clear-sent:not([hidden])');
		assert.equal(await page.locator('#scan-report-clear-sent').textContent(), 'Clear the 3 scans sent from this phone');
		await page.click('#scan-report-clear-sent');
		assert.match(await page.locator('#scan-report-clear-confirm p').textContent(), /^Delete the 3 scans in the sent report from this phone\?/);
		await page.click('#scan-report-clear-confirm-yes');
		await page.waitForFunction(() => document.getElementById('scan-log-size').textContent.startsWith('1 scan recorded'));
		assert.equal(await statusText(page), 'Cleared 3 scans from this phone. The report is still in Sent reports.');
		assert.ok(await page.locator('#scan-report-clear-sent').isHidden());

		// Sent reports, newest first, with the note.
		await page.click('#scan-report-list');
		await page.waitForSelector('#sent-reports li');
		assert.equal(await page.locator('#sent-reports li').count(), 1);

		const item = await page.locator('#sent-reports li').first().innerText();

		assert.match(item, /3 scans · \d+ KB/);
		assert.match(item, /Note: Korean cards, glare/);
		assert.match(item, /2 with pictures/);
		await page.screenshot({fullPage: true, path: `${SHOTS}/scan-reports-list.png`});

		// The report, readable as text with real images.
		await page.click('#sent-reports li a');
		await page.waitForSelector('.scan-report-scan');
		assert.equal(await page.locator('.scan-report-scan').count(), 3);
		await untilInPage(page, 'both card pictures to be decoded', () => {
			const images = [...document.querySelectorAll('img.scan-report-picture')];

			return images.length === 2 && images.every((img) => img.complete && img.naturalWidth === 300);
		});

		const text = await page.evaluate(() => document.body.innerText);

		for (const expected of ['Scan 1 of 3: Test card 1, 001/132', 'Scan 2 of 3: Test card 2, 002/132', 'Scanner version: 40', 'What was read', 'Name: "Test card 1" (81 %)', 'Language: ko (80 %, from Korean model)', 'Text route', 'Name strip: "TEST CARD 1"', 'Picture route', 'Candidates', '<- the scanner\'s answer, saved', 'Saved: Test card 2, 002/132 (me01-002), language ko, finish normal (default), 1 copy', 'No picture in this scan.', 'Errors', 'Korean cards, glare']) {
			assert.ok(text.includes(expected), `the page says ${expected}`);
		}

		assert.deepEqual(await page.evaluate(() => window.scanReport.log.entries.map((entry) => entry.id)), ['scan-a-1', 'scan-a-2', 'scan-a-3'], 'the data, for a reader in the browser');
		await page.screenshot({fullPage: true, path: `${SHOTS}/scan-reports-report.png`});

		// Download gives the scan log file itself.
		const download = page.waitForEvent('download');

		await page.click('#scan-report-download');

		const file = await download;

		assert.equal(file.suggestedFilename(), meta.file);
		assert.deepEqual(JSON.parse(await readFile(await file.path(), 'utf8')), log);

		// Eric's computer: the same report at desktop width.
		const desk = await device(fake, eric, {viewport: DESKTOP});

		await desk.page.goto(url('check/reports'));
		await desk.page.waitForSelector('#sent-reports li a');
		await desk.page.click('#sent-reports li a');
		await desk.page.waitForSelector('.scan-report-scan');
		assert.equal(await desk.page.locator('.scan-report-scan').count(), 3);
		assert.ok((await desk.page.evaluate(() => document.body.innerText)).includes('Scan 3 of 3: Test card 3, 003/132'));
		assert.equal(await desk.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
		await desk.page.screenshot({path: `${SHOTS}/scan-reports-desktop.png`});
		assert.deepEqual(desk.errors, []);
		await desk.context.close();

		// A family member sees none of it, even asking for the file by name.
		const other = await device(fake, member);

		await other.page.goto(url('check/reports'));
		await other.page.waitForFunction(() => /No reports sent yet/.test(document.getElementById('sent-reports-status').textContent), null, {timeout: 15000});
		await other.page.goto(url(`check/reports/${encodeURIComponent(files[0].replace(/\.json\.gz$/, ''))}`));
		await other.page.waitForFunction(() => /could not be opened: This report is not in your account/.test(document.getElementById('scan-report-load-status').textContent), null, {timeout: 15000});

		const asked = await other.page.evaluate(async (path) => {
			const {getClient} = await import('/pokemon-card-tracker/js/auth.js');
			const client = await getClient();
			const {data, error} = await client.storage.from('scan-reports').download(path);

			return {data: Boolean(data), error: Boolean(error)};
		}, `${eric.id}/${files[0]}`);

		assert.deepEqual(asked, {data: false, error: true});
		assert.deepEqual(other.errors, []);
		await other.context.close();

		// Delete asks first, then removes every file and goes back to the list.
		await page.click('#scan-report-delete');
		await page.click('#scan-report-delete-confirm-no');
		assert.equal(fake.reportsOf(eric.id).length, 2, 'Keep it keeps it');
		await page.click('#scan-report-delete');
		await page.click('#scan-report-delete-confirm-yes');
		await page.waitForFunction(() => /No reports sent yet/.test((document.getElementById('sent-reports-status') || {}).textContent || ''), null, {timeout: 15000});
		assert.equal(fake.reportsOf(eric.id).length, 0);
		assert.equal(await page.evaluate(() => 'scanReport' in window), false);
		assert.deepEqual(phone.errors, []);
		await phone.context.close();
	});

	test('with no connection the report waits on the phone, with the log, and goes when the phone is back online', async () => {
		const fake = new FakeReportStorage();
		const eric = fake.addUser('eric@example.test');
		const {context, errors, page} = await device(fake, eric);

		await page.goto(url('check'));
		await recordScans(page, {pictures: [true, true]});
		await openCheck(page, 2);
		await context.setOffline(true);
		await page.fill('#scan-report-note', 'offline test');
		await page.click('#scan-report-send');
		await page.waitForFunction(() => /^No connection: the report \(2 scans, \d+ KB\) waits on this phone and goes by itself when the phone is back online\. The scan log stays here too\.$/.test(document.getElementById('scan-report-status').textContent));
		await page.waitForSelector('#scan-report-waiting li');
		assert.match(await page.locator('#scan-report-waiting li').textContent(), /^Waiting to send: 2 scans, \d+ KB, "offline test"\.$/);
		assert.equal(fake.reports.size, 0);

		// Kept on the phone, and the log too.
		const kept = await page.evaluate(async () => {
			const {reportSender} = await import('/pokemon-card-tracker/js/scan/reports.js');
			const {listEntries} = await import('/pokemon-card-tracker/js/scan/log.js');

			return {log: (await listEntries()).length, waiting: (await reportSender.waiting()).map((row) => row.count)};
		});

		assert.deepEqual(kept, {log: 2, waiting: [2]});
		await page.screenshot({fullPage: true, path: `${SHOTS}/scan-reports-offline.png`});

		await context.setOffline(false);
		await page.waitForFunction(() => /^Sent: 2 scans/.test(document.getElementById('scan-report-status').textContent), null, {timeout: 15000});
		await page.waitForFunction(() => !document.querySelector('#scan-report-waiting li'));

		const [data] = fake.reportsOf(eric.id).filter((object) => object.path.endsWith('.json.gz'));

		assert.equal(unpack(fake, data.path).entries.length, 2);
		assert.equal(JSON.parse(fake.reports.get(data.path.replace(/\.json\.gz$/, '.meta.json')).bytes).note, 'offline test');
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a project without the bucket keeps the report and says why; Try again sends it once the bucket is there', async () => {
		const fake = new FakeReportStorage();
		const eric = fake.addUser('eric@example.test');
		const {context, errors, page} = await device(fake, eric);

		fake.noBucket = true;
		await page.goto(url('check'));
		await recordScans(page, {pictures: [true]});
		await openCheck(page, 1);
		await page.click('#scan-report-send');
		await page.waitForFunction(() => /no place for reports yet/.test(document.getElementById('scan-report-status').textContent), null, {timeout: 15000});
		await page.waitForSelector('#scan-report-retry:not([hidden])');
		assert.match(await page.locator('#scan-report-waiting li').textContent(), /^Waiting to send: 1 scan, \d+ KB\. Not sent: the server has no place for reports yet/);

		fake.noBucket = false;
		await page.click('#scan-report-retry');
		await page.waitForFunction(() => /^Sent: 1 scan/.test(document.getElementById('scan-report-status').textContent), null, {timeout: 15000});
		assert.equal(fake.reportsOf(eric.id).length, 2);
		assert.ok(await page.locator('#scan-report-retry').isHidden());
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('signed out, Send report lists none of the reports waiting on the phone and says to sign in', async () => {
		const fake = new FakeReportStorage();
		const eric = fake.addUser('eric@example.test');
		const {context, errors, page} = await signedOutDevice(fake);

		await page.goto(url('check'));
		await page.waitForSelector('#scan-report-send');
		await queueRow(page, {base: '20261105T101919.274Z-1', error: 'Bucket not found', error_kind: 'refused', error_status: 400, user_id: eric.id});
		await page.reload();
		await page.waitForFunction(() => document.getElementById('scan-report-status').textContent === 'Sign in to send reports to your account.');
		assert.deepEqual(await waitingShown(page), {items: [], remove: 0, retry: false, save: 0}, 'no report, no Save it as a file, no Try sending again');
		assert.ok(await page.locator('#scan-report-send').isDisabled());
		assert.equal(fake.reports.size, 0);
		assert.deepEqual(errors, []);
		await context.close();
	});

	test('a report still going up can be deleted, with a note that the send stops; the phone says so and drops its copy only when told', async () => {
		const fake = new FakeReportStorage();
		const eric = fake.addUser('eric@example.test');
		const base = '20261105T101919.274Z-400';

		// Part 1 of 3 is up; the phone is between parts.
		fake.reports.set(`${eric.id}/${base}.json.gz.part1of3`, {bytes: Buffer.from('part one'), contentType: 'application/gzip', created_at: new Date().toISOString(), owner: eric.id});

		const desk = await device(fake, eric, {viewport: DESKTOP});

		await desk.page.goto(url('check/reports'));
		await desk.page.waitForSelector('#sent-reports li');
		assert.match(await desk.page.locator('#sent-reports li').innerText(), /Still going up: 1 of 3 parts\./);
		await desk.page.click('.sent-report-delete');
		assert.match(await desk.page.locator('#sent-reports li [role="group"] p').textContent(), /^Delete the report of .+ \(400 scans\) from your account\? It is still going up from the phone that sent it: that phone stops sending it and says so\.$/);
		await desk.page.click('#sent-reports li .danger');
		await desk.page.waitForFunction(() => !document.querySelector('#sent-reports li'));
		assert.equal(fake.reportsOf(eric.id).length, 0);
		assert.deepEqual(desk.errors, []);
		await desk.context.close();

		// The phone, told by the bucket on its next try, as the queue leaves
		// it (tests/scan-reports.test.mjs sends the parts).
		const phone = await device(fake, eric);
		const {page} = phone;

		await page.goto(url('check'));
		await page.waitForSelector('#scan-report-send');
		await queueRow(page, {base, error: 'Deleted from your account on another device', error_kind: 'deleted', parts: 3, sent_parts: 1, user_id: eric.id});
		await page.reload();
		await page.waitForSelector('#scan-report-waiting li');

		const shown = await waitingShown(page);

		assert.equal(shown.items.length, 1);
		assert.match(shown.items[0], /^Stopped: 1 scan, \d+ KB\. 1 of 3 parts sent\. Not sent: it was deleted from your account on another device\. The scan log on this phone is not touched\.Remove it$/);
		assert.deepEqual({remove: shown.remove, retry: shown.retry, save: shown.save}, {remove: 1, retry: false, save: 0});
		await page.screenshot({fullPage: true, path: `${SHOTS}/scan-reports-deleted-elsewhere.png`});

		await page.evaluate(async () => (await import('/pokemon-card-tracker/js/scan/reports.js')).reportSender.retry());
		assert.equal(fake.log.filter((entry) => entry.storage === 'upload').length, 0, 'never sent again');

		await page.click('#scan-report-waiting .scan-report-remove');
		await page.waitForFunction(() => !document.querySelector('#scan-report-waiting li'));
		assert.deepEqual(await page.evaluate(async () => (await (await import('/pokemon-card-tracker/js/scan/reports.js')).reportSender.waiting()).length), 0);
		assert.deepEqual(phone.errors, []);
		await phone.context.close();
	});
});

