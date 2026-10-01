// The attempt log: every scan the tester judges, kept in localStorage on
// this phone, with a running summary and JSON and CSV export.
//
// localStorage can be missing or full (a private tab, cleared site data), so
// every access is wrapped: the log then lasts for this visit only, and the
// page says so.

const KEY = 'scanLab.attempts.v1';

let memory = null;
let persistent = true;

export function loadAttempts() {
	if (memory) {
		return memory;
	}

	try {
		const saved = JSON.parse(localStorage.getItem(KEY) || '[]');

		memory = Array.isArray(saved) ? saved : [];
	}
	catch {
		memory = [];
		persistent = false;
	}

	return memory;
}

export const isPersistent = () => persistent;

function save() {
	try {
		localStorage.setItem(KEY, JSON.stringify(memory));
		persistent = true;
	}
	catch {
		persistent = false;
	}
}

export function addAttempt(attempt) {
	loadAttempts().push(attempt);
	save();
}

export function resetAttempts() {
	memory = [];

	try {
		localStorage.removeItem(KEY);
	}
	catch {
		persistent = false;
	}
}

const median = (values) => {
	if (!values.length) {
		return null;
	}

	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);

	return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

// {count, numberRight, languageRight, top1, top3, medianOcrMs, slowestOcrMs},
// each rate as {right, of}.
export function summarise(attempts = loadAttempts()) {
	const rate = (key) => ({of: attempts.length, right: attempts.filter((a) => a.verdict[key]).length});
	const times = attempts.map((a) => a.timings.ocr).filter((ms) => typeof ms === 'number');

	return {
		count: attempts.length,
		languageRight: rate('languageRight'),
		medianOcrMs: median(times),
		numberRight: rate('numberRight'),
		slowestOcrMs: times.length ? Math.max(...times) : null,
		top1: rate('top1'),
		top3: rate('top3'),
	};
}

// ------------------------------------------------------------ export

function download(name, type, text) {
	const url = URL.createObjectURL(new Blob([text], {type}));
	const link = document.createElement('a');

	link.href = url;
	link.download = name;
	document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

export function exportJson() {
	download(`scan-lab-${stamp()}.json`, 'application/json', JSON.stringify(loadAttempts(), null, '\t'));
}

const CSV_COLUMNS = [
	['at', (a) => a.at],
	['source', (a) => a.source],
	['number_read', (a) => a.read.number],
	['total_read', (a) => a.read.total],
	['number_side', (a) => a.read.side],
	['number_confidence', (a) => a.read.numberConfidence],
	['set_code_read', (a) => a.read.setCodeRun],
	['language_code_read', (a) => a.read.langCode],
	['regulation_mark_read', (a) => a.read.regulationMark],
	['copyright_year_read', (a) => a.read.copyrightYear],
	['label_language', (a) => a.read.labelLanguage],
	['label_confidence', (a) => a.read.labelConfidence],
	['language', (a) => a.read.language],
	['language_confidence', (a) => a.read.languageConfidence],
	['candidates', (a) => a.candidates.map((c) => c.id).join('|')],
	['chosen_card', (a) => a.verdict.chosenId],
	['chosen_rank', (a) => a.verdict.chosenRank],
	['actual_number', (a) => a.verdict.actualNumber],
	['actual_total', (a) => a.verdict.actualTotal],
	['actual_language', (a) => a.verdict.actualLanguage],
	['number_right', (a) => a.verdict.numberRight],
	['language_right', (a) => a.verdict.languageRight],
	['top1', (a) => a.verdict.top1],
	['top3', (a) => a.verdict.top3],
	['ocr_ms', (a) => a.timings.ocr],
	['rectify_ms', (a) => a.timings.rectify],
	['match_ms', (a) => a.timings.match],
	['frame', (a) => a.frame],
	['card_px', (a) => a.cardPx],
	['card_edges_found', (a) => a.rectify.found],
	['tilt_degrees', (a) => a.rectify.angle],
	['torch', (a) => a.camera.torch],
	['zoom', (a) => a.camera.zoom],
	['raw_label', (a) => a.raw.label],
	['raw_number_left', (a) => a.raw.numberLeft],
	['raw_number_right', (a) => a.raw.numberRight],
	['raw_set_code', (a) => a.raw.setCode],
	['user_agent', (a) => a.userAgent],
];

// Every field quoted, so collector numbers such as 063 stay text in a
// spreadsheet; UTF-8 with a byte order mark, so accented names survive Excel.
const quote = (value) => `"${String(value === null || value === undefined ? '' : value).replace(/"/g, '""')}"`;

export function toCsv(attempts = loadAttempts()) {
	const lines = [CSV_COLUMNS.map(([name]) => name).join(',')];

	for (const attempt of attempts) {
		lines.push(CSV_COLUMNS.map(([, get]) => {
			try {
				return quote(get(attempt));
			}
			catch {
				return quote('');
			}
		}).join(','));
	}

	return '﻿' + lines.join('\r\n') + '\r\n';
}

export function exportCsv() {
	download(`scan-lab-${stamp()}.csv`, 'text/csv;charset=utf-8', toCsv());
}
