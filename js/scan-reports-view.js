// Scan reports on screen (DESIGN.md, "Send report"): Send report in Phone
// check's Scanner card, and Profile > Phone check > Sent reports with one
// report opened. A report reads as plain text and real <img> elements, so a
// person, or page text extraction on any device signed in to the account,
// reads every scan without downloading anything. An opened report is also
// window.scanReport ({base, info, log}) while it is on screen.
//
// Routes: check/reports (the list) and check/reports/<base> (one report).

import {currentUser, onUser} from './auth.js';
import {BASE, go, h} from './dom.js';
import {downloadBlob} from './scan/image.js';
import {removeEntries} from './scan/log.js';
import {NOTE_MAX, problemText, scansText, sizeText, stampDate} from './scan/report-file.js';
import {scanView} from './scan/report-scans.js';
import {deleteReport, listReports, loadReport, reportSender, sendReport, startReportSync} from './scan/reports.js';

const when = (date) => {
	const d = date instanceof Date ? date : new Date(date);

	return Number.isNaN(d.getTime()) ? 'an unknown time' : d.toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'});
};

// An error's own words, for a status line.
const reason = (err) => String((err && err.message) || err || 'unknown error').replace(/\.$/, '');

const reportRoute = (base) => `check/reports/${encodeURIComponent(base)}`;

// A row of two buttons asking before something is deleted.
function confirmRow(id, text, [yes, no], onYes, onNo) {
	return h('div', {'aria-label': text, class: 'scan-report-confirm', id, role: 'group'},
		h('p', {style: 'grid-column: 1 / -1; margin: 0'}, text),
		h('button', {class: 'danger', id: `${id}-yes`, onclick: onYes, type: 'button'}, yes),
		h('button', {id: `${id}-no`, onclick: onNo, type: 'button'}, no));
}

function waitingLine(row) {
	const what = `${scansText(row.count)}, ${sizeText(row.bytes)}${row.note ? `, "${row.note}"` : ''}`;
	const problem = problemText(row);
	const progress = row.parts > 1 && row.sent_parts ? ` ${row.sent_parts} of ${row.parts} parts sent.` : '';

	return `Waiting to send: ${what}.${progress}${problem ? ` ${problem}` : ''}`;
}

// ------------------------------------------------------------- Send report

// Send report, for js/phone-check.js's Scanner card: a note, the button,
// its progress, what still waits on this phone, and after a send the offer
// to clear the scans it holds. onLogChanged() runs when scans were
// cleared. Answers {element, setCount, stop}.
export function reportSendPanel({onLogChanged = () => {}} = {}) {
	startReportSync();

	const note = h('input', {'aria-label': 'Note for the report', autocomplete: 'off', class: 'search', id: 'scan-report-note', maxlength: NOTE_MAX, placeholder: 'A note, e.g. Korean cards, glare', type: 'text'});
	const send = h('button', {class: 'primary', id: 'scan-report-send', onclick: () => sendNow(), type: 'button'}, 'Send report');
	const status = h('p', {'aria-live': 'polite', class: 'muted', id: 'scan-report-status', style: 'margin: 0'});
	const waitingList = h('ul', {class: 'muted', id: 'scan-report-waiting', style: 'margin: 0; padding-left: 1.2em'});
	const retry = h('button', {hidden: true, id: 'scan-report-retry', onclick: () => reportSender.retry(), type: 'button'}, 'Try sending again');
	const clearSent = h('button', {hidden: true, id: 'scan-report-clear-sent', onclick: () => askClear(true), type: 'button'}, 'Clear the sent scans');
	const confirm = h('div', {hidden: true});
	const list = h('a', {class: 'button', 'data-link': 'check/reports', href: `${BASE}check/reports`, id: 'scan-report-list'}, 'Sent reports');
	let count = 0;
	let busy = false;
	// Rows queued from this panel: their progress and result show here.
	const mine = new Set();
	// The last report sent while this panel was open (or earlier in this
	// page), whose scans can be cleared.
	let offer = null;

	function drawButton() {
		const user = currentUser();

		send.disabled = busy || !count || !user;

		if (!user && !busy && !status.dataset.result) {
			status.textContent = 'Sign in to send reports to your account.';
			status.dataset.hint = 'signin';
		}
		else if (status.dataset.hint === 'signin' && user) {
			status.textContent = '';
			delete status.dataset.hint;
		}
	}

	function say(text, result = false) {
		status.textContent = text;
		delete status.dataset.hint;

		if (result) {
			status.dataset.result = 'true';
		}
		else {
			delete status.dataset.result;
		}
	}

	async function drawWaiting() {
		const rows = await reportSender.waiting().catch(() => []);
		const user = currentUser();
		const shown = rows.filter((row) => !user || row.user_id === user.id);

		waitingList.replaceChildren(...shown.map((row) => {
			const actions = [];

			if (row.error_kind === 'refused') {
				actions.push(
					h('button', {class: 'scan-report-save', onclick: () => saveFile(row.id), type: 'button'}, 'Save it as a file'),
					h('button', {class: 'scan-report-remove', onclick: () => removeRow(row.id), type: 'button'}, 'Remove it'));
			}

			return h('li', {'data-id': row.id}, waitingLine(row), actions.length ? h('div', {style: 'display: grid; gap: 8px; margin-top: 8px'}, ...actions) : null);
		}));
		retry.hidden = !shown.some((row) => row.error);
	}

	async function saveFile(id) {
		const file = await reportSender.fileOf(id);

		if (file) {
			downloadBlob(file.blob, file.name);
		}
	}

	async function removeRow(id) {
		await reportSender.remove(id);
		await drawWaiting();
	}

	function drawOffer() {
		clearSent.hidden = !offer || !offer.entry_ids.length || !confirm.hidden;
		clearSent.textContent = offer ? `Clear the ${scansText(offer.entry_ids.length)} sent from this phone` : '';
	}

	function askClear(open) {
		confirm.hidden = !open;

		if (open && offer) {
			confirm.replaceChildren(confirmRow('scan-report-clear-confirm', `Delete the ${scansText(offer.entry_ids.length)} in the sent report from this phone? The report stays in Sent reports, and scans recorded since are kept.`, ['Delete them', 'Keep them'], doClear, () => askClear(false)));
			document.getElementById('scan-report-clear-confirm-no').focus();
		}

		drawOffer();
	}

	async function doClear() {
		const ids = offer ? offer.entry_ids : [];

		try {
			const removed = await removeEntries(ids);

			say(`Cleared ${scansText(removed)} from this phone. The report is still in Sent reports.`, true);
			offer = null;
		}
		catch (err) {
			say(`The scans could not be cleared: ${reason(err)}`, true);
		}

		askClear(false);
		onLogChanged();
	}

	async function sendNow() {
		if (busy) {
			return;
		}

		busy = true;
		drawButton();
		say('Making the report...');

		try {
			const row = await sendReport(note.value);

			mine.add(row.id);
			note.value = '';
			say(navigator.onLine
				? `Sending ${scansText(row.count)} (${sizeText(row.bytes)})...`
				: `No connection: the report (${scansText(row.count)}, ${sizeText(row.bytes)}) waits on this phone and goes by itself when the phone is back online. The scan log stays here too.`, !navigator.onLine);
		}
		catch (err) {
			say(`The report could not be made: ${reason(err)}. The scan log is unchanged.`, true);
		}

		busy = false;
		drawButton();
		await drawWaiting();
	}

	const stopSender = reportSender.onChange((event) => {
		const row = event.row;

		if (event.type === 'progress' && row && mine.has(row.id)) {
			say(row.parts > 1 ? `Sending part ${event.part} of ${event.parts} (${scansText(row.count)}, ${sizeText(row.bytes)})...` : `Sending ${scansText(row.count)} (${sizeText(row.bytes)})...`);
		}

		if (event.type === 'sent' && row && (mine.has(row.id) || !offer)) {
			if (mine.has(row.id)) {
				say(`Sent: ${scansText(row.count)}, ${sizeText(row.bytes)}. It is in Sent reports.`, true);
			}

			mine.delete(row.id);
			offer = row;
			drawOffer();
		}

		if (event.type === 'failed' && row && mine.has(row.id)) {
			say(row.error_kind === 'refused' ? problemText(row) : `${problemText(row)} The report is kept on this phone until it goes.`, true);
		}

		drawWaiting();
	});
	const stopUser = onUser(() => {
		drawButton();
		drawWaiting();
	});

	// A report sent earlier in this page, still offered.
	offer = reportSender.lastSent();
	drawButton();
	drawOffer();
	drawWaiting();

	return {
		element: h('div', {id: 'scan-report', style: 'display: grid; gap: 8px'},
			note, send, status, waitingList, retry, clearSent, confirm, list),
		setCount(next) {
			count = next;
			drawButton();
		},
		stop() {
			stopSender();
			stopUser();
		},
	};
}

// ------------------------------------------------------------- Sent reports

function signedOutCard(text) {
	return h('section', {class: 'card'},
		h('h2', null, 'Sent reports'),
		h('p', {id: 'sent-reports-status'}, text),
		h('a', {class: 'button', 'data-link': 'signin', href: `${BASE}signin`}, 'Sign in'));
}

// One report in the list, with Delete asking first.
function reportItem(report, onDeleted) {
	const info = report.info || {};
	const sentAt = info.sent_at ? new Date(info.sent_at) : report.at;
	const status = h('p', {'aria-live': 'polite', class: 'muted', style: 'margin: 0'});
	const del = h('button', {class: 'sent-report-delete', onclick: () => ask(true), type: 'button'}, 'Delete');
	const confirm = h('div', {hidden: true});
	const facts = [
		info.app ? `App ${info.app}` : null,
		info.scanners && info.scanners.length ? `scanner ${info.scanners.join(', ')}` : null,
		typeof info.pictures === 'number' ? `${info.pictures} with pictures` : null,
	].filter(Boolean);

	function ask(open) {
		confirm.hidden = !open;
		del.hidden = open;

		if (open) {
			confirm.replaceChildren(confirmRow(`sent-report-confirm-${report.base.replace(/\W/g, '')}`, `Delete the report of ${when(sentAt)} (${scansText(report.count)}) from your account?`, ['Delete it', 'Keep it'], remove, () => ask(false)));
		}
	}

	async function remove() {
		status.textContent = 'Deleting...';

		try {
			await deleteReport(report);
			onDeleted(report);
		}
		catch (err) {
			status.textContent = `Not deleted: ${reason(err)}`;
			ask(false);
		}
	}

	return h('li', {class: 'sent-report', 'data-base': report.base},
		h('a', {'data-link': reportRoute(report.base), href: BASE + reportRoute(report.base)}, `${when(sentAt)} · ${scansText(report.count)} · ${sizeText(report.bytes)}`),
		h('p', {style: 'margin: 0'}, `Note: ${info.note || 'none'}`),
		facts.length ? h('p', {class: 'muted', style: 'margin: 0'}, facts.join(' · ')) : null,
		report.complete ? null : h('p', {class: 'muted', style: 'margin: 0'}, `Still going up: ${report.found} of ${report.parts} parts.`),
		del, confirm, status);
}

export function sentReportsView(root) {
	if (!currentUser()) {
		root.append(signedOutCard('Sign in to see the scan reports sent to your account.'));

		return null;
	}

	startReportSync();

	const status = h('p', {'aria-live': 'polite', id: 'sent-reports-status'}, 'Loading the reports...');
	const list = h('ol', {class: 'sent-reports', id: 'sent-reports'});
	const waiting = h('ul', {class: 'muted', id: 'sent-reports-waiting', style: 'margin: 0; padding-left: 1.2em'});
	let alive = true;

	async function drawWaiting() {
		const user = currentUser();
		const rows = (await reportSender.waiting().catch(() => [])).filter((row) => user && row.user_id === user.id);

		waiting.replaceChildren(...rows.map((row) => h('li', null, waitingLine(row))));
	}

	async function load() {
		if (!navigator.onLine) {
			status.textContent = 'Sent reports need a connection. Reports sent from this device while offline wait here until then.';
			list.replaceChildren();

			return;
		}

		try {
			const reports = await listReports();

			if (!alive) {
				return;
			}

			list.replaceChildren(...reports.map((report) => reportItem(report, (gone) => {
				list.querySelector(`[data-base="${CSS.escape(gone.base)}"]`)?.remove();
				status.textContent = `Deleted the report of ${when(gone.info && gone.info.sent_at ? new Date(gone.info.sent_at) : gone.at)}.`;
			})));
			status.textContent = reports.length ? `${reports.length} ${reports.length === 1 ? 'report' : 'reports'}, newest first.` : 'No reports sent yet. Send one from Phone check.';
		}
		catch (err) {
			if (alive) {
				status.textContent = `The reports could not be listed: ${reason(err)}`;
			}
		}
	}

	root.append(
		h('section', {class: 'card'},
			h('h2', null, 'Sent reports'),
			h('p', {class: 'muted'}, 'Scan logs sent with Send report in Phone check, kept in your account. Only you can see them, from any device you are signed in on.'),
			status,
			waiting,
			list),
		h('a', {class: 'button', 'data-link': 'check', href: `${BASE}check`}, 'Phone check'));

	const stop = reportSender.onChange((event) => {
		drawWaiting();

		if (event.type === 'sent') {
			load();
		}
	});
	const online = () => load();

	window.addEventListener('online', online);
	drawWaiting();
	load();

	return () => {
		alive = false;
		stop();
		window.removeEventListener('online', online);
	};
}

// ------------------------------------------------------------- one report

function summaryTable(base, info, log, report) {
	const entries = log.entries || [];
	const sentAt = info && info.sent_at ? new Date(info.sent_at) : stampDate(base);
	const phones = info && info.phones ? info.phones : [...new Set(entries.map((entry) => entry.phone && entry.phone.userAgent).filter(Boolean))];
	const scanners = [...new Set(entries.map((entry) => entry.scanner).filter((value) => value !== undefined && value !== null))];
	const times = entries.map((entry) => entry.at).filter(Boolean).sort();
	const rows = [
		['Sent', `${when(sentAt)} (${sentAt ? sentAt.toISOString() : '?'})`],
		['Scans', String(entries.length)],
		['With pictures', String(entries.filter((entry) => entry.picture).length)],
		['Note', (info && info.note) || 'none'],
		['Size', `${sizeText(report.bytes)} sent${report.encoding === 'gzip' && info && info.raw_bytes ? `, ${sizeText(info.raw_bytes)} unzipped` : ''}${report.parts > 1 ? `, in ${report.parts} parts` : ''}`],
		['App', log.app || 'not recorded'],
		['Scanner', scanners.length ? scanners.join(', ') : 'not recorded'],
		['Scans taken', times.length ? `${times[0]} to ${times[times.length - 1]}` : 'none'],
		['Phone', phones.length ? phones.join(' | ') : 'not recorded'],
		['File', (info && info.file) || 'not recorded'],
	];

	return h('table', {class: 'results', id: 'scan-report-summary'},
		h('tbody', null, rows.map(([label, value]) => h('tr', null, h('th', {scope: 'row'}, label), h('td', null, value)))));
}

function scanCard(entry, index, total) {
	const view = scanView(entry, index, total);
	const pictures = [];

	if (view.picture) {
		pictures.push(h('figure', null, h('img', {alt: `Card picture of scan ${index + 1}`, class: 'scan-report-picture', src: view.picture}), h('figcaption', null, 'Card picture')));
	}

	if (view.views) {
		for (const key of ['before', 'after']) {
			if (view.views[key]) {
				pictures.push(h('figure', null, h('img', {alt: `View ${key} the drop, scan ${index + 1}`, src: view.views[key]}), h('figcaption', null, `View ${key} the drop`)));
			}
		}
	}

	return h('section', {class: 'card scan-report-scan', 'data-errors': view.errors, id: `scan-${index + 1}`},
		h('h3', null, view.title),
		pictures.length ? h('div', {class: 'scan-report-pictures'}, ...pictures) : h('p', {class: 'muted'}, 'No picture in this scan.'),
		...view.sections.flatMap((section) => [
			h('h4', null, section.title),
			h('ul', null, section.lines.map((line) => h('li', null, line))),
		]));
}

export function scanReportView(root, {base}) {
	if (!currentUser()) {
		root.append(signedOutCard('Sign in to see this report.'));

		return null;
	}

	const status = h('p', {'aria-live': 'polite', id: 'scan-report-load-status'}, 'Loading the report...');
	const head = h('section', {class: 'card', id: 'scan-report-head'},
		h('h2', null, `Scan report, ${when(stampDate(base))}`),
		status);
	const scans = h('div', {id: 'scan-report-scans'});
	let alive = true;
	let loaded = null;

	root.append(h('a', {class: 'button', 'data-link': 'check/reports', href: `${BASE}check/reports`, id: 'scan-report-back'}, 'Sent reports'), head, scans);

	function download() {
		const name = (loaded.info && loaded.info.file) || `scan-log-${base}.json`;

		downloadBlob(new File([loaded.text], name, {type: 'application/json'}), name);
	}

	const delStatus = h('p', {'aria-live': 'polite', class: 'muted', id: 'scan-report-delete-status', style: 'margin: 0'});
	const del = h('button', {class: 'danger', id: 'scan-report-delete', onclick: () => ask(true), type: 'button'}, 'Delete this report');
	const confirm = h('div', {hidden: true});

	function ask(open) {
		confirm.hidden = !open;
		del.hidden = open;

		if (open) {
			confirm.replaceChildren(confirmRow('scan-report-delete-confirm', 'Delete this report from your account? The scans on the phone that sent it are not touched.', ['Delete it', 'Keep it'], remove, () => ask(false)));
		}
	}

	async function remove() {
		delStatus.textContent = 'Deleting...';

		try {
			await deleteReport(loaded.report);
			go('check/reports', {replace: true});
		}
		catch (err) {
			delStatus.textContent = `Not deleted: ${reason(err)}`;
			ask(false);
		}
	}

	(async () => {
		try {
			if (!navigator.onLine) {
				throw new Error('Reports need a connection');
			}

			loaded = await loadReport(base);

			if (!alive) {
				return;
			}

			const entries = loaded.log.entries || [];

			window.scanReport = {base, info: loaded.info, log: loaded.log};
			status.textContent = `${scansText(entries.length)}, oldest first.`;
			head.append(
				summaryTable(base, loaded.info, loaded.log, loaded.report),
				h('div', {style: 'display: grid; gap: 8px; margin-top: 12px'},
					h('button', {id: 'scan-report-download', onclick: download, type: 'button'}, 'Download the scan log file'),
					del, confirm, delStatus));
			scans.replaceChildren(...entries.map((entry, index) => scanCard(entry, index, entries.length)));
		}
		catch (err) {
			if (alive) {
				status.textContent = `The report could not be opened: ${reason(err)}`;
			}
		}
	})();

	return () => {
		alive = false;

		if (window.scanReport && window.scanReport.base === base) {
			delete window.scanReport;
		}
	};
}

export const scanReportRoutes = [
	{pattern: /^check\/reports$/, render: sentReportsView, tab: null, title: 'Sent reports | Card Tracker'},
	{keys: ['base'], pattern: /^check\/reports\/([^/]+)$/, render: scanReportView, tab: null, title: 'Scan report | Card Tracker'},
];

export const scanReportAccountViews = [sentReportsView, scanReportView];
