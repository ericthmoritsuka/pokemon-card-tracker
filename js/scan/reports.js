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
import {REPORT_BUCKET, createReportCleanup, readReport, readReports, removeReport} from './report-file.js';

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
// session comes back, and checks for old reports to delete (cleanUpLater).
// Safe to call from every view.
export function startReportSync() {
	if (started) {
		return;
	}

	started = true;
	window.addEventListener('online', () => {
		reportSender.wake();
		cleanUpLater();
	});
	onUser(() => {
		reportSender.retry();
		cleanUpLater();
	});
	onSession(({expired}) => {
		if (!expired) {
			reportSender.flush();
		}
	});
	reportSender.flush();
	cleanUpLater();
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

	await removeReport(files, user.id, report);
}

// ------------------------------------------------------------- cleanup

// Reports are deleted REPORT_KEEP_DAYS after they are sent
// (js/scan/report-file.js createReportCleanup), checked at most once a day
// on each phone, a minute after the app starts, someone signs in, or the
// phone comes back online, so it never holds up starting or syncing.
const CLEANUP_DELAY_MS = 60 * 1000;

export const reportCleanup = createReportCleanup({
	currentUser,
	deleteReport,
	listReports,
	online: () => navigator.onLine,
	storage: {
		getItem: (key) => localStorage.getItem(key),
		setItem: (key, value) => localStorage.setItem(key, value),
	},
	waiting: () => reportSender.waiting(),
});

let cleanupTimer = null;

function cleanUpLater() {
	if (cleanupTimer) {
		return;
	}

	cleanupTimer = setTimeout(() => {
		cleanupTimer = null;
		reportCleanup.run();
	}, CLEANUP_DELAY_MS);
}
