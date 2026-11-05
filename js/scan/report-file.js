// A sent scan report as files in the private scan-reports bucket
// (supabase/scan-reports.sql; DESIGN.md, "Send report"). Pure functions
// over names, bytes, and listings, so Node tests them
// (tests/scan-reports.test.mjs); js/scan/reports.js does the sending.
//
// A report is the scan log exactly as Download scan log makes it
// (js/scan/log.js logFile), gzipped where the browser can
// (CompressionStream: the pictures are JPEG already, so a log of 30 cards
// with pictures goes from about 1.3 MB to about 0.9 MB, and the text
// around them shrinks to a fifth), kept under
//
//     <user_id>/<stamp>-<count>.json.gz           the log (.json unzipped)
//     <user_id>/<stamp>-<count>.meta.json         the note and the numbers
//
// stamp is when it was sent, in ISO 8601 basic form with milliseconds
// (20261105T101919.274Z), so names sort by time; count is how many scans
// it holds. A log larger than PART_BYTES goes up in parts,
// <stamp>-<count>.json.gz.part1of3 and so on, each its own upload under
// the bucket's 6 MB file limit, joined again when the report is read. The
// meta file goes up last, once every part is there.

export const REPORT_BUCKET = 'scan-reports';

// The largest piece one upload carries: 5 MiB, under the bucket's 6 MB
// file limit and small enough for a phone's link to send in one go. A log
// of 30 cards with pictures is one piece.
export const PART_BYTES = 5 * 1024 * 1024;

// The longest note kept.
export const NOTE_MAX = 300;

// The one name shape the bucket takes (supabase/scan-reports.sql and
// tests/scan-reports-fake-storage.mjs test the same pattern).
export const NAME_PATTERN = /^(\d{8}T\d{6}\.\d{3}Z-\d{1,4})\.(meta\.json|json(\.gz)?(\.part(\d{1,3})of(\d{1,3}))?)$/;

const two = (n) => String(n).padStart(2, '0');

// 2026-11-05T10:19:19.274Z -> 20261105T101919.274Z
export function reportStamp(at = new Date()) {
	const d = at instanceof Date ? at : new Date(at);

	return `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}T${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, '0')}Z`;
}

// 20261105T101919.274Z -> a Date, or null.
export function stampDate(stamp) {
	const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})Z/.exec(String(stamp || ''));

	return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7])) : null;
}

export const reportBase = (at, count) => `${reportStamp(at)}-${Math.max(0, Math.min(9999, Math.round(count) || 0))}`;

const dataExtension = (encoding) => (encoding === 'gzip' ? 'json.gz' : 'json');

// The data files' names for a report in `parts` pieces, in order.
export function dataNames(base, encoding, parts = 1) {
	const name = `${base}.${dataExtension(encoding)}`;

	return parts <= 1 ? [name] : Array.from({length: parts}, (_, i) => `${name}.part${i + 1}of${parts}`);
}

export const metaName = (base) => `${base}.meta.json`;

export const objectPath = (userId, name) => `${userId}/${name}`;

// What a name in the bucket is: {base, kind: 'meta' | 'data', encoding,
// part, of}, or null for any other name.
export function parseName(name) {
	const m = NAME_PATTERN.exec(String(name || ''));

	if (!m) {
		return null;
	}

	if (m[2] === 'meta.json') {
		return {base: m[1], kind: 'meta'};
	}

	return {base: m[1], encoding: m[3] ? 'gzip' : 'none', kind: 'data', of: m[4] ? Number(m[6]) : 1, part: m[4] ? Number(m[5]) : 1};
}

// The reports in a listing of one person's folder (Supabase Storage list:
// [{name, metadata: {size}, created_at}], folders with no metadata), newest
// first: {base, at, count, encoding, files (data names in order), meta (its
// name or null), parts, found, complete, bytes}.
export function groupReports(objects) {
	const reports = new Map();

	for (const object of objects || []) {
		const info = object && parseName(object.name);

		if (!info) {
			continue;
		}

		if (!reports.has(info.base)) {
			const count = Number(info.base.split('-').pop());

			reports.set(info.base, {at: stampDate(info.base), base: info.base, bytes: 0, count, data: [], meta: null});
		}

		const report = reports.get(info.base);

		if (info.kind === 'meta') {
			report.meta = object.name;
		}
		else {
			report.data.push({...info, name: object.name, size: Number(object.metadata && object.metadata.size) || 0});
		}
	}

	return [...reports.values()].map(({data, ...report}) => {
		const parts = data.length ? Math.max(...data.map((item) => item.of)) : 0;
		const pieces = data.sort((a, b) => a.part - b.part);
		const found = new Set(pieces.map((item) => item.part)).size;

		return {
			...report,
			bytes: pieces.reduce((sum, item) => sum + item.size, 0),
			complete: parts > 0 && found === parts && pieces.every((item) => item.of === parts),
			encoding: pieces.length ? pieces[0].encoding : null,
			files: pieces.map((item) => item.name),
			found,
			parts,
		};
	}).sort((a, b) => b.base.localeCompare(a.base));
}

// ------------------------------------------------------------- bytes

export const canGzip = () => typeof CompressionStream === 'function' && typeof Response === 'function';
export const canGunzip = () => typeof DecompressionStream === 'function' && typeof Response === 'function';

async function through(blob, stream, type) {
	const out = await new Response(blob.stream().pipeThrough(stream)).blob();

	return type ? new Blob([out], {type}) : out;
}

// The file, gzipped when the browser can: {blob, encoding, bytes,
// rawBytes, type}.
export async function packReport(file, {gzip = canGzip()} = {}) {
	if (gzip) {
		try {
			const blob = await through(file, new CompressionStream('gzip'), 'application/gzip');

			return {blob, bytes: blob.size, encoding: 'gzip', rawBytes: file.size, type: 'application/gzip'};
		}
		catch {
			// Sent as it is.
		}
	}

	const blob = new Blob([file], {type: 'application/json'});

	return {blob, bytes: blob.size, encoding: 'none', rawBytes: file.size, type: 'application/json'};
}

// How many pieces a packed report of `bytes` goes up in.
export const partCount = (bytes, partBytes = PART_BYTES) => Math.max(1, Math.ceil(bytes / partBytes));

// Piece `index` (0 based) of the packed report.
export const partOf = (blob, index, partBytes = PART_BYTES) => blob.slice(index * partBytes, Math.min(blob.size, (index + 1) * partBytes));

// The pieces as read back, joined and unzipped: the log's JSON text.
export async function unpackReport(pieces, encoding) {
	const joined = new Blob(pieces);

	if (encoding !== 'gzip') {
		return joined.text();
	}

	if (!canGunzip()) {
		throw new Error('This browser cannot unzip the report. Open it in a current Chrome, Edge, Firefox, or Safari.');
	}

	return (await through(joined, new DecompressionStream('gzip'))).text();
}

// ------------------------------------------------------------- reading

// How many names one list call asks for. A report is two files or more, so
// a folder past one page is listed page by page.
export const LIST_PAGE = 1000;

// Every object in the folder `folder` of `files` (a Supabase Storage bucket)
// whose name starts with `search`, page by page, each name once.
export async function listFolder(files, folder, {page = LIST_PAGE, search = ''} = {}) {
	const objects = new Map();

	for (let offset = 0; ; offset += page) {
		const {data, error} = await files.list(folder, {limit: page, offset, search, sortBy: {column: 'name', order: 'desc'}});

		if (error) {
			throw error;
		}

		for (const object of data || []) {
			objects.set(object.name, object);
		}

		if (!data || data.length < page) {
			return [...objects.values()];
		}
	}
}

async function readMeta(files, userId, report) {
	if (!report.meta) {
		return null;
	}

	try {
		const {data, error} = await files.download(objectPath(userId, report.meta));

		return error || !data ? null : JSON.parse(await data.text());
	}
	catch {
		return null;
	}
}

// The reports in userId's folder, newest first, each with its meta file
// read (note, numbers) as info, or null when it has none yet.
export async function readReports(files, userId, {page} = {}) {
	const reports = groupReports(await listFolder(files, userId, {page}));
	const metas = await Promise.all(reports.map((report) => readMeta(files, userId, report)));

	return reports.map((report, index) => ({...report, info: metas[index]}));
}

// One report by its base name, listing and downloading only its own files:
// {report, info, log, text}, log the parsed scan log file and text the file
// itself. Throws when it is not there, is still going up, or cannot be read.
export async function readReport(files, userId, base, {page} = {}) {
	const report = groupReports(await listFolder(files, userId, {page, search: `${base}.`})).find((item) => item.base === base);

	if (!report || !report.files.length) {
		throw new Error('This report is not in your account (it may have been deleted).');
	}

	if (!report.complete) {
		throw new Error(`This report is still going up: ${report.found} of ${report.parts} parts are there.`);
	}

	const info = await readMeta(files, userId, report);
	const pieces = [];

	for (const name of report.files) {
		const {data, error} = await files.download(objectPath(userId, name));

		if (error || !data) {
			throw error || new Error(`${name} could not be read.`);
		}

		pieces.push(data);
	}

	const text = await unpackReport(pieces, report.encoding);

	return {info, log: JSON.parse(text), report: {...report, info}, text};
}

// ------------------------------------------------------------- the meta file

const shortAgent = (agent) => String(agent || '').slice(0, 300) || null;

// What the list shows without opening the report: log is the parsed file
// ({app, exported, entries}); packed is packReport's answer.
export function reportMeta({base, file, log, note, packed, parts, sentAt}) {
	const entries = (log && log.entries) || [];
	const times = entries.map((entry) => String(entry.at || '')).filter(Boolean).sort();
	const phones = [...new Set(entries.map((entry) => entry.phone && shortAgent(entry.phone.userAgent)).filter(Boolean))];
	const scanners = [...new Set(entries.map((entry) => entry.scanner).filter((value) => value !== undefined && value !== null))];

	return {
		app: (log && log.app) || null,
		base,
		bytes: packed.bytes,
		count: entries.length,
		encoding: packed.encoding,
		exported: (log && log.exported) || null,
		file: file.name,
		first_at: times[0] || null,
		last_at: times[times.length - 1] || null,
		note: cleanNote(note),
		parts,
		phones,
		pictures: entries.filter((entry) => entry.picture).length,
		raw_bytes: packed.rawBytes,
		scanners,
		sent_at: sentAt,
		version: 1,
	};
}

export const cleanNote = (note) => String(note || '').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);

// ------------------------------------------------------------- words

// 85 KB, 0.9 MB, 12.4 MB (decimal, as Phone check counts the log).
export function sizeText(bytes) {
	const n = Number(bytes) || 0;

	if (n < 1e6) {
		return `${Math.max(1, Math.round(n / 1000))} KB`;
	}

	return `${(n / 1e6).toFixed(1)} MB`;
}

export const scansText = (count) => `${count} ${count === 1 ? 'scan' : 'scans'}`;

const statusOf = (err) => Number(err && (err.status || err.statusCode || (err.originalError && err.originalError.status)));

// What kind of failure, as js/photos/store.js sorts them: 'auth' when the
// session's token was refused (sent again after a sign-in), 'exists' when
// the piece is already in the bucket (an earlier try went up but its answer
// was lost: done), 'refused' when the server will not take it (a policy,
// too large: tried again only by hand, at the next start, or a sign-in),
// else 'retry' (no connection, a server hiccup).
export function failureKind(err, isAuth = () => false) {
	const status = statusOf(err);
	const message = String((err && err.message) || '');

	if (status === 409 || /already exists|Duplicate/i.test(message)) {
		return 'exists';
	}

	if (isAuth(status, message)) {
		return 'auth';
	}

	return status >= 400 && status < 500 && status !== 408 && status !== 429 ? 'refused' : 'retry';
}

export const failureStatus = (err) => statusOf(err) || null;

// Short words for a waiting report's failure.
export function problemText(row) {
	if (!row || !row.error) {
		return null;
	}

	if (row.error_kind === 'auth') {
		return 'Sign in again to send it.';
	}

	if (row.error_kind === 'deleted') {
		return 'Not sent: it was deleted from your account on another device. The scan log on this phone is not touched.';
	}

	if (row.error_kind !== 'refused') {
		return `Not sent yet: ${row.error}. It goes again by itself.`;
	}

	const status = Number(row.error_status);
	const message = String(row.error);

	if (status === 413 || /maximum allowed size|too large/i.test(message)) {
		return 'Not sent: too large for the server.';
	}

	if (/bucket not found/i.test(message)) {
		return 'Not sent: the server has no place for reports yet (Eric runs supabase/scan-reports.sql once).';
	}

	if (/row-level security|unauthorized|permission/i.test(message)) {
		return 'Not sent: the server refused it (no permission).';
	}

	return `Not sent: ${message}`;
}
