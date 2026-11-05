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
// the bucket.
//
// A row: {id, base, user_id, at, blob, type, encoding, bytes, raw_bytes,
// parts, part_bytes, sent_parts, meta, meta_sent, count, note, entry_ids,
// error, error_kind, error_status}.

import {PART_BYTES, dataNames, failureKind, failureStatus, metaName, objectPath, packReport, partCount, partOf, REPORT_BUCKET, reportBase, reportMeta} from './report-file.js';

// What a view sees of a row: everything but the file.
export function rowSummary(row) {
	const {blob, ...rest} = row;

	return rest;
}

export function createReportSender({
	clearTimer = clearTimeout,
	currentUser,
	expired = () => false,
	getClient,
	isAuth = () => false,
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
	let flushing = null;
	let flushAgain = false;
	let timer = null;
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

	async function sendRow(client, row) {
		const bucket = client.storage.from(REPORT_BUCKET);
		const names = dataNames(row.base, row.encoding, row.parts);
		let current = row;

		sending = {base: row.base, part: row.sent_parts, parts: row.parts};

		for (let index = row.sent_parts; index < row.parts; index++) {
			sending = {base: row.base, part: index + 1, parts: row.parts};
			emit({part: index + 1, parts: row.parts, row: rowSummary(current), type: 'progress'});
			await upload(bucket, objectPath(row.user_id, names[index]), partOf(row.blob, index, row.part_bytes || partBytes), row.type);
			current = {...current, error: null, error_kind: null, error_status: null, sent_parts: index + 1};
			await store.put(current);
		}

		if (!current.meta_sent) {
			await upload(bucket, objectPath(row.user_id, metaName(row.base)), new Blob([JSON.stringify(row.meta, null, 1)], {type: 'application/json'}), 'application/json');
			current = {...current, meta_sent: true};
		}

		await store.remove(row.id);
		lastSent = rowSummary(current);
		emit({row: lastSent, type: 'sent'});
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
			let retry = false;

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
					if (row.error_kind === 'refused' && refusedHere.has(row.id)) {
						continue;
					}

					try {
						await sendRow(client, row);
					}
					catch (err) {
						const kind = failureKind(err, isAuth);
						const latest = (await store.all().catch(() => [])).find((item) => item.id === row.id) || row;
						const failed = {...latest, error: (err && err.message) || String(err), error_kind: kind, error_status: failureStatus(err)};

						if (kind === 'refused') {
							refusedHere.add(row.id);
						}

						await store.put(failed).catch(() => {});
						emit({row: rowSummary(failed), type: 'failed'});

						if (kind !== 'refused') {
							// A refused token waits for a sign-in; anything else
							// (no connection, a server hiccup) is tried again soon.
							// The rest waits too.
							retry = kind !== 'auth' || !expired();

							break;
						}
					}
				}
			}
			catch {
				retry = true;
			}
			finally {
				sending = null;

				if (retry && online() && !timer) {
					timer = setTimer(() => {
						timer = null;
						flush();
					}, retryMs);
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

	// Try again now, refused ones included.
	function retry() {
		refusedHere.clear();

		if (timer) {
			clearTimer(timer);
			timer = null;
		}

		return flush();
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

	// Drops a waiting row the server refused. One being sent is left alone.
	async function remove(id) {
		if (sending && sending.base === id) {
			return false;
		}

		await store.remove(id);
		refusedHere.delete(id);
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
	};
}
