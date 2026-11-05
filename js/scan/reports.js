// Scan reports in the account (DESIGN.md, "Send report"): Phone check's
// Send report puts the scan log in the private scan-reports bucket, and
// Profile > Phone check > Sent reports lists, opens, and deletes them, on
// any device signed in to the same account. Only the owner reads them
// (supabase/scan-reports.sql): no family member, nobody signed out.
//
// The queue (js/scan/report-queue.js) keeps each report on this phone
// until it is in the bucket, in its own database, apart from the scan log:
//   outbox  report id -> the queue's row, the packed file inside

import {currentUser, getClient, isAuthStatus, onSession, onUser, sessionExpired} from '../auth.js';
import {database} from '../idb.js';

import {logFile} from './log.js';
import {createReportSender} from './report-queue.js';
import {REPORT_BUCKET, objectPath, readReport, readReports} from './report-file.js';

const OUTBOX = 'outbox';

const db = database('card-tracker-scan-reports', [OUTBOX]);

const store = {
	all: async () => (await db.run(OUTBOX, 'readonly', (s) => s.getAll())) || [],
	put: (row) => db.run(OUTBOX, 'readwrite', (s) => s.put(row, row.id)),
	remove: (id) => db.run(OUTBOX, 'readwrite', (s) => s.delete(id)),
};

export const reportSender = createReportSender({
	currentUser,
	expired: sessionExpired,
	getClient,
	isAuth: isAuthStatus,
	online: () => navigator.onLine,
	store,
});

// Makes the scan log file now, exactly as Download scan log does, queues it
// with the note, and starts sending. Answers the queued row's summary.
export async function sendReport(note) {
	const user = currentUser();

	if (!user) {
		throw new Error('Sign in to send a report.');
	}

	const file = await logFile();
	const row = await reportSender.add({file, note, userId: user.id});

	reportSender.flush();

	return row;
}

let started = false;

// Sends what waits now, when the phone comes back online (every report at
// once, without waiting its turn), when someone signs in, and when an ended
// session comes back. Safe to call from every view.
export function startReportSync() {
	if (started) {
		return;
	}

	started = true;
	window.addEventListener('online', () => reportSender.wake());
	onUser(() => reportSender.retry());
	onSession(({expired}) => {
		if (!expired) {
			reportSender.flush();
		}
	});
	reportSender.flush();
}

// ------------------------------------------------------------- reading

async function bucket() {
	const user = currentUser();

	if (!user) {
		throw new Error('Sign in to see sent reports.');
	}

	const client = await getClient();

	return {files: client.storage.from(REPORT_BUCKET), user};
}

// The signed-in person's reports, newest first, each with its meta file
// read (note, numbers) or null when it has none yet.
export async function listReports() {
	const {files, user} = await bucket();

	return readReports(files, user.id);
}

// One report by its base name: {report, info, log, text}, log the parsed
// scan log file and text the file itself. Throws when it is not there or
// cannot be read. Only its own files are listed and downloaded.
export async function loadReport(base) {
	const {files, user} = await bucket();

	return readReport(files, user.id, base);
}

// Deletes every file of a report. Throws when the server kept any.
export async function deleteReport(report) {
	const {files, user} = await bucket();
	const names = [...report.files, report.meta].filter(Boolean);
	const {data, error} = await files.remove(names.map((name) => objectPath(user.id, name)));

	if (error) {
		throw error;
	}

	if (!data || data.length < names.length) {
		throw new Error('The server kept some of its files. Try again.');
	}
}
