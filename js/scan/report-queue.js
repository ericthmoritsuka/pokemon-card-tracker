// The send queue for scan reports (Phone check > Send report; DESIGN.md,
// "Send report"). Its parts come in as arguments (the phone's store, the
// Supabase client, who is signed in, whether the phone is online), so Node
// tests run it over a Map and a fake bucket (tests/scan-reports.test.mjs);
// js/scan/reports.js gives it the real ones.
//
// Send report makes the file at the tap and keeps it in the queue on the
// phone before anything goes out, so the log can be cleared, the app
// closed, or the signal lost, and the report still goes: with no signal, or
// signed out, it waits, and goes when the phone is back online, someone
// signs in, or the app starts. A row holds the packed file and how far it
// got (sent_parts, then the meta file), so a send cut off part way goes on
// from the piece that failed. Nothing is dropped until every file is in
// the bucket, or until the person has been told it was deleted elsewhere.
//
// One report failing for a while (no connection, a server hiccup) does not
// hold the others back: the rest go on, and each failing report waits its
// own time before it is tried again, 30 s and then twice as long each time,
// up to 10 minutes. The phone back online, a sign-in, or Try sending again
// tries every report at once.
//
// Sent reports on another device can delete a report while this phone is
// between its parts. Before going on from a part sent earlier, and before
// the meta file that finishes a report, the phone checks that the parts it
// sent are still in the bucket. When any is gone, it sends nothing more of
// that report, removes what it sent since, and keeps the row as 'deleted':
// never sent again, shown as deleted elsewhere, and dropped when the person
// taps Remove it. The scan log itself is never touched.
//
// A row: {id, base, user_id, at, blob, type, encoding, bytes, raw_bytes,
// parts, part_bytes, sent_parts, meta, meta_sent, count, note, entry_ids,
// error, error_kind, error_status}.

import {PART_BYTES, dataNames, failureKind, failureStatus, listFolder, metaName, objectPath, packReport, partCount, partOf, REPORT_BUCKET, reportBase, reportMeta} from './report-file.js';

// What a row's error says when its report was deleted on another device.
export const DELETED_ELSEWHERE = 'Deleted from your account on another device';

// What a view sees of a row: everything but the file.
export function rowSummary(row) {
	const {blob, ...rest} = row;

	return rest;
}

export function createReportSender({
	clearTimer = clearTimeout,
	clock = () => Date.now(),
	currentUser,
	expired = () => false,
	getClient,
	isAuth = () => false,
	maxRetryMs = 10 * 60 * 1000,
	now = () => new Date(),
	online = () => true,
	partBytes = PART_BYTES,
	retryMs = 30 * 1000,
	setTimer = setTimeout,
	store,
}) {
	const listeners = new Set();
	// Rows the server refused in this page: tried again only by hand, at the
	// next start, or after a sign-in, so a refusal is not repeated forever.
	const refusedHere = new Set();
	// Each failing row's own wait: report id -> {at, tries}, at the clock()
	// time it may be tried again.
	const waits = new Map();
	let flushing = null;
	let flushAgain = false;
	let timer = null;
	let timerAt = null;
	let lastSent = null;
	let sending = null;

	const emit = (event) => listeners.forEach((listener) => {
		try {
			listener(event);
		}
		catch {
			// A view that went away.
		}
	});

	// Queues the scan log file (js/scan/log.js logFile) as one report of
	// userId, with Eric's note. Answers the row's summary. Throws only when
	// the file cannot be kept on the phone, and then nothing was changed.
	async function add({file, note = '', userId}) {
		if (!userId) {
			throw new Error('Sign in to send a report.');
		}

		const text = await file.text();
		let log = null;

		try {
			log = JSON.parse(text);
		}
		catch {
			log = null;
		}

		const entries = log && Array.isArray(log.entries) ? log.entries : [];
		const at = now();
		const base = reportBase(at, entries.length);
		const packed = await packReport(file);
		const parts = partCount(packed.bytes, partBytes);
		const meta = reportMeta({base, file, log, note, packed, parts, sentAt: at.toISOString()});
		const row = {
			at: at.getTime(),
			base,
			blob: packed.blob,
			bytes: packed.bytes,
			count: entries.length,
			encoding: packed.encoding,
			entry_ids: entries.map((entry) => entry.id).filter(Boolean),
			error: null,
			error_kind: null,
			error_status: null,
			id: base,
			meta,
			meta_sent: false,
			note: meta.note,
			part_bytes: partBytes,
			parts,
			raw_bytes: packed.rawBytes,
			sent_parts: 0,
			type: packed.type,
			user_id: userId,
		};

		await store.put(row);
		emit({row: rowSummary(row), type: 'queued'});

		return rowSummary(row);
	}

	async function upload(bucket, path, blob, type) {
		const {error} = await bucket.upload(path, await blob.arrayBuffer(), {cacheControl: '3600', contentType: type, upsert: false});

		// Already there: an earlier try went up and its answer was lost.
		if (error && failureKind(error, isAuth) !== 'exists') {
			throw error;
		}
	}

	// Throws a 'deleted' error when a data part this row sent earlier is no
	// longer in the bucket (Sent reports deleted the report on another
	// device), after removing what is left of it, so no report is left that
	// can never finish. Only this report's files are listed.
	async function checkKept(bucket, row, sentParts) {
		const names = dataNames(row.base, row.encoding, row.parts).slice(0, sentParts);
		const there = await listFolder(bucket, row.user_id, {search: `${row.base}.`});
		const found = new Set(there.map((object) => object.name));

		if (names.every((name) => found.has(name))) {
			return;
		}

		if (there.length) {
			await bucket.remove(there.map((object) => objectPath(row.user_id, object.name))).catch(() => {});
		}

		const err = new Error(DELETED_ELSEWHERE);

		err.deletedElsewhere = true;

		throw err;
	}

	async function sendRow(client, row) {
		const bucket = client.storage.from(REPORT_BUCKET);
		const names = dataNames(row.base, row.encoding, row.parts);
		let current = row;

		sending = {base: row.base, part: row.sent_parts, parts: row.parts};

		// Going on from a part sent earlier: is the report still there?
		if (row.sent_parts > 0) {
			await checkKept(bucket, row, row.sent_parts);
		}

		for (let index = row.sent_parts; index < row.parts; index++) {
			sending = {base: row.base, part: index + 1, parts: row.parts};
			emit({part: index + 1, parts: row.parts, row: rowSummary(current), type: 'progress'});
			await upload(bucket, objectPath(row.user_id, names[index]), partOf(row.blob, index, row.part_bytes || partBytes), row.type);
			current = {...current, error: null, error_kind: null, error_status: null, sent_parts: index + 1};
			await store.put(current);
		}

		if (!current.meta_sent) {
			// The meta file finishes the report: never after a delete.
			if (current.sent_parts !== row.sent_parts) {
				await checkKept(bucket, row, current.sent_parts);
			}

			await upload(bucket, objectPath(row.user_id, metaName(row.base)), new Blob([JSON.stringify(row.meta, null, 1)], {type: 'application/json'}), 'application/json');
			current = {...current, meta_sent: true};
		}

		await store.remove(row.id);
		lastSent = rowSummary(current);
		emit({row: lastSent, type: 'sent'});
	}

	// Wakes flush() at clock() time `at`, unless a timer already wakes it
	// sooner.
	function wakeAt(at) {
		if (timer && timerAt <= at) {
			return;
		}

		if (timer) {
			clearTimer(timer);
		}

		timerAt = at;
		timer = setTimer(() => {
			timer = null;
			timerAt = null;
			flush();
		}, Math.max(0, at - clock()));
	}

	// Sends what waits, oldest first. Waits quietly when offline, signed
	// out, or the session has ended; sends only the signed-in person's
	// rows.
	function flush() {
		if (flushing) {
			flushAgain = true;

			return flushing;
		}

		flushing = (async () => {
			// The soonest clock() time a row waiting its turn may go again.
			let next = null;
			const later = (at) => {
				next = next === null ? at : Math.min(next, at);
			};

			try {
				const user = currentUser();

				if (!user || !online() || expired()) {
					return;
				}

				const rows = (await store.all()).filter((row) => row.user_id === user.id).sort((a, b) => a.at - b.at);

				if (!rows.length) {
					return;
				}

				const client = await getClient();

				for (const row of rows) {
					if (row.error_kind === 'deleted' || (row.error_kind === 'refused' && refusedHere.has(row.id))) {
						continue;
					}

					const wait = waits.get(row.id);

					if (wait && wait.at > clock()) {
						later(wait.at);

						continue;
					}

					try {
						await sendRow(client, row);
						waits.delete(row.id);
					}
					catch (err) {
						const kind = err && err.deletedElsewhere ? 'deleted' : failureKind(err, isAuth);
						const latest = (await store.all().catch(() => [])).find((item) => item.id === row.id) || row;
						const failed = {...latest, error: (err && err.message) || String(err), error_kind: kind, error_status: failureStatus(err)};

						if (kind === 'refused') {
							refusedHere.add(row.id);
						}

						if (kind === 'deleted' || kind === 'refused') {
							waits.delete(row.id);
						}

						await store.put(failed).catch(() => {});
						emit({row: rowSummary(failed), type: 'failed'});

						if (kind === 'auth') {
							// A refused token: every report would be refused
							// the same, so the rest wait for a sign-in, or for
							// a session that has not ended to be tried again.
							if (!expired()) {
								later(clock() + retryMs);
							}

							break;
						}

						if (kind === 'retry') {
							// No connection, a server hiccup: this report
							// waits its own time, growing, and the rest go on.
							const tries = (wait ? wait.tries : 0) + 1;
							const at = clock() + Math.min(maxRetryMs, retryMs * 2 ** (tries - 1));

							waits.set(row.id, {at, tries});
							later(at);
						}
					}
				}
			}
			catch {
				later(clock() + retryMs);
			}
			finally {
				sending = null;

				if (next !== null && online()) {
					wakeAt(next);
				}

				emit({type: 'idle'});
			}
		})().finally(() => {
			flushing = null;

			if (flushAgain) {
				flushAgain = false;
				flush();
			}
		});

		return flushing;
	}

	// Try every waiting report now, without waiting their turns: the phone
	// is back online.
	function wake() {
		waits.clear();

		if (timer) {
			clearTimer(timer);
			timer = null;
			timerAt = null;
		}

		return flush();
	}

	// Try again now, refused ones included (not one deleted elsewhere).
	function retry() {
		refusedHere.clear();

		return wake();
	}

	// Every waiting row's summary, oldest first.
	async function waiting() {
		return (await store.all()).sort((a, b) => a.at - b.at).map(rowSummary);
	}

	// The packed file of a waiting row, to save by hand.
	async function fileOf(id) {
		const row = (await store.all()).find((item) => item.id === id);

		return row ? {blob: row.blob, name: dataNames(row.base, row.encoding, 1)[0]} : null;
	}

	// Drops a waiting row the server refused, or one deleted elsewhere. One
	// being sent is left alone.
	async function remove(id) {
		if (sending && sending.base === id) {
			return false;
		}

		await store.remove(id);
		refusedHere.delete(id);
		waits.delete(id);
		emit({id, type: 'removed'});

		return true;
	}

	return {
		add,
		fileOf,
		flush,
		lastSent: () => lastSent,
		onChange(listener) {
			listeners.add(listener);

			return () => listeners.delete(listener);
		},
		remove,
		retry,
		sending: () => sending,
		waiting,
		wake,
	};
}
