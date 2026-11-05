// One scan of a sent report in words (Profile > Phone check > Sent reports,
// js/scan-reports-view.js). Pure functions over a scan log entry as the
// file holds it (js/scan/log.js logFile), so Node tests them
// (tests/scan-reports.test.mjs): each scan is a heading, its pictures, and
// sections of plain lines, read by a person or by page text extraction on
// any device. Nothing here draws on a canvas.

import {REPORT_FIELDS} from './session.js';

const ms = (value) => (typeof value === 'number' ? `${Math.round(value)} ms` : 'not timed');
const pct = (value) => (typeof value === 'number' ? `${Math.round(value <= 1 ? value * 100 : value)} %` : '?');
const oneLine = (text) => String(text || '').replace(/\s*\n\s*/g, ' | ').trim();
const compact = (value) => {
	try {
		return JSON.stringify(value);
	}
	catch {
		return String(value);
	}
};

// The fields every entry may carry; anything else is listed under Other.
const KNOWN = new Set(['app', 'at', 'drop', 'error', 'evidence', 'first', 'firstLocked', 'how', 'id', 'mode', 'outcome', 'phone', 'picture', 'report', 'scanner', 'source', 'timings', 'views', 'why']);

function sourceText(entry) {
	if (entry.how === 'holder' && !entry.report) {
		return 'holder mode: a drop that took nothing';
	}

	if (entry.how === 'mode') {
		return `holder mode switched ${entry.mode === 'holder' ? 'on' : 'off'}`;
	}

	if (entry.source === 'photo') {
		return 'a photo picked from the gallery';
	}

	const how = {auto: 'taken automatically', shutter: 'the shutter'}[entry.how] || null;

	return `the camera${how ? `, ${how}` : ''}`;
}

const cardText = (card) => (card ? `${card.name || '?'}, ${card.number || '?'}, ${card.set || card.setName || '?'} (${card.id}${card.catalog && card.catalog !== 'international' ? `, ${card.catalog} catalog` : ''}${card.lang ? `, ${card.lang}` : ''})` : 'no card');

// The name and number of a card id, from what the scan looked at.
function nameOf(entry, id) {
	const first = entry.first && entry.first.card;

	if (first && first.id === id) {
		return `${first.name}, ${first.number}`;
	}

	const candidate = ((entry.report && entry.report.match && entry.report.match.candidates) || []).find((c) => c.id === id);

	return candidate ? `${candidate.name}, ${candidate.number}` : null;
}

function readLines(report) {
	if (!report) {
		return ['Nothing was read (no scan report in this entry).'];
	}

	const lines = [];

	lines.push(`Name: ${report.name ? `"${report.name.text}" (${pct(report.name.confidence)})${report.name.suffix ? `, suffix ${report.name.suffix}` : ''}` : 'unreadable'}`);

	if (report.number) {
		lines.push(`Number: ${report.number.printed} (${pct(report.number.confidence)}, ${report.number.side || '?'} side)${report.number.secret ? ', past the set total: a secret rare' : ''}`);
	}
	else {
		lines.push(`Number: unreadable${report.partial ? `; partly read as ${report.partial}` : ''}`);
	}

	lines.push(`Language: ${report.language ? `${report.language.code || 'none'} (${pct(report.language.confidence)}, from ${report.language.source || '?'})` : 'unknown'}`);
	lines.push(`HP: ${report.hp ? `${report.hp.value}${report.hp.after ? ' (printed after the number)' : ''}` : 'unreadable'}`);

	if (report.setCodeBox) {
		lines.push(`Set code box: "${report.setCodeBox.text}"${report.setCodeBox.setCode ? `, set ${report.setCodeBox.setCode}` : ''}${report.setCodeBox.langCode ? `, language ${report.setCodeBox.langCode}` : ''}`);
	}

	lines.push(`Copyright year: ${report.copyrightYear || 'unread'}${report.wizards ? '; Wizards of the Coast' : ''}`);

	if (report.attackText) {
		lines.push(`Attack names: "${oneLine(report.attackText)}"`);
	}

	return lines;
}

function textRouteLines(report) {
	if (!report) {
		return [];
	}

	const lines = [];

	if (report.ocr === false) {
		lines.push('OCR: not run (the picture was enough).');
	}
	else {
		lines.push(`OCR, all reads: ${ms(report.ocrMs)}`);

		for (const [key, title] of REPORT_FIELDS) {
			const field = report.fields && report.fields[key];

			if (field) {
				lines.push(`${title}: "${oneLine(field.text) || '(nothing)'}" (confidence ${field.confidence ?? '?'}, ${ms(field.ms)})`);
			}
		}
	}

	const match = report.match;

	if (match) {
		lines.push(`Catalog lookup: ${ms(match.ms)}; routes ${match.routes && match.routes.length ? match.routes.join(', ') : 'none'}; searched for ${match.language || 'an unknown language'}${match.partial ? '; some sets were out of reach' : ''}`);

		if (match.setName) {
			lines.push(`The name strip read a set's name ("${match.setName}"), so it was not used as a name.`);
		}

		lines.push(`Species the name matched: ${match.names && match.names.length ? match.names.map((n) => `${n.name} (${n.score})`).join(', ') : 'none'}`);
	}
	else {
		lines.push('Catalog lookup: not done.');
	}

	return lines;
}

function pictureRouteLines(report) {
	if (!report) {
		return [];
	}

	const picture = report.picture;

	if (!picture) {
		return [report.ocr === false ? 'Not recorded.' : 'Not done (the picture index was not on this phone, or the card was read in full).'];
	}

	const where = report.pictureIn === 'worker' ? 'in the picture worker' : report.pictureIn === 'main' ? `on the main thread${report.pictureWhy ? ` (${report.pictureWhy})` : ''}` : 'where not recorded';
	const lines = [`Fingerprint ${ms(picture.fingerprintMs)}, match ${ms(picture.matchMs)}, ${where}; lead over the second: ${picture.gap ?? 'none (one group)'}`];

	if (picture.how) {
		lines.push(`Crop used: ${picture.how}${(picture.variants || []).length ? `; crops tried: ${picture.variants.join(', ')}` : ''}${typeof picture.before === 'number' ? ` (the crop as found was ${picture.before} away)` : ''}`);
	}

	if (picture.turn) {
		lines.push(`Turned ${picture.turn} degrees to match.`);
	}

	for (const [index, group] of (picture.groups || []).entries()) {
		lines.push(`${index + 1}. ${group.cards.join(', ')}: distance ${group.score}`);
	}

	return lines;
}

function candidateLines(entry) {
	const match = entry.report && entry.report.match;

	if (!match) {
		return [];
	}

	const firstId = entry.first && entry.first.card && entry.first.card.id;
	const savedId = entry.outcome && entry.outcome.kind === 'saved' ? entry.outcome.card : null;
	const lines = [`${match.count} found, the first ${match.candidates.length} kept.`];

	for (const [index, c] of match.candidates.entries()) {
		const marks = [c.id === firstId ? 'the scanner\'s answer' : null, c.id === savedId ? 'saved' : null].filter(Boolean);

		lines.push(`${index + 1}. ${c.name}, ${c.number}, ${c.setName} (${c.id}, ${c.lang || '?'}): score ${c.score}${c.confidence !== null && c.confidence !== undefined ? `, confidence ${pct(c.confidence)}` : ''}${c.artwork !== null && c.artwork !== undefined ? `, artwork ${c.artwork}` : ''}; why: ${(c.reasons || []).join('; ') || 'nothing'}${(c.agree || []).length ? `; agrees: ${c.agree.join(', ')}` : ''}${(c.conflicts || []).length ? `; against: ${c.conflicts.join(', ')}` : ''}${marks.length ? `  <- ${marks.join(', ')}` : ''}`);
	}

	return lines;
}

function answerLines(entry) {
	const first = entry.first;

	if (!first) {
		return ['No answer recorded.'];
	}

	const lines = [`Card: ${cardText(first.card)}`, first.sure ? 'Sure match.' : `Not sure${first.why ? `: ${first.why}` : '.'}`];

	lines.push(`Language: ${first.language || 'none'}${first.languageSource ? ` (${first.languageSource})` : first.languageBy ? ` (${first.languageBy})` : ''}`);

	if (first.finish) {
		lines.push(`Finish: ${first.finish}${first.finishBy ? ` (${first.finishBy})` : ''}`);
	}

	if (first.status && first.status !== 'ready') {
		lines.push(`Status: ${first.status}`);
	}

	if (first.labelCheck) {
		lines.push(`Label row read in the background: ${first.labelCheck.code ? `${first.labelCheck.code} (${pct(first.labelCheck.confidence)})` : 'no language'}${first.labelCheck.text ? `: "${oneLine(first.labelCheck.text)}"` : ''}`);
	}

	return lines;
}

function outcomeLines(entry) {
	const outcome = entry.outcome;

	if (!outcome) {
		return ['No outcome recorded (the card was still in the tray when the log was made).'];
	}

	switch (outcome.kind) {
		case 'saved': {
			const name = nameOf(entry, outcome.card);
			const lines = [`Saved: ${name ? `${name} ` : ''}(${outcome.card}${outcome.catalog && outcome.catalog !== 'international' ? `, ${outcome.catalog} catalog` : ''}), language ${outcome.language || 'none'}, finish ${outcome.finish || 'none'}${outcome.finishBy ? ` (${outcome.finishBy})` : ''}, ${outcome.copies || 1} ${outcome.copies > 1 ? 'copies' : 'copy'}`];

			lines.push(outcome.changed ? `Changed by hand from the scanner's answer: ${(outcome.changes || []).join(', ')}` : 'The same as the scanner\'s answer.');

			if (outcome.undone) {
				lines.push('Taken back with Undo session.');
			}

			return lines;
		}
		case 'removed':
			return ['Removed from the tray.'];
		case 'discarded':
			return ['Discarded with the session.'];
		case 'skipped':
			return [`Skipped${outcome.why ? `: ${outcome.why}` : ''}.`];
		case 'handmade':
			return ['Saved as a hand-made card.'];
		case 'dropped':
			return [`Dropped by the scanner${outcome.why ? `: ${outcome.why}` : ''}.`];
		case 'mode':
			return ['Holder mode changed.'];
		default:
			return [`${outcome.kind}${outcome.why ? `: ${outcome.why}` : ''}`];
	}
}

function timingLines(entry) {
	const report = entry.report;
	const t = entry.timings;
	const lines = [];

	if (report) {
		lines.push(`Capture ${ms(report.captureMs)}; edges and straightening ${ms(report.rectify && report.rectify.ms)}; total from capture to read ${ms(report.totalMs)}`);
	}

	if (t) {
		lines.push(`Steps: ${Object.entries(t).map(([key, value]) => `${key} ${ms(value)}`).join(', ')}`);
	}

	return lines;
}

function framingLines(entry) {
	const report = entry.report;
	const lines = [];

	if (report && report.frame) {
		lines.push(`Frame: ${report.frame}`);
	}

	if (report && report.rectify) {
		const r = report.rectify;

		lines.push(`Edges: ${r.found ? 'found' : 'NOT found'}${r.guessed ? `, ${r.guessed} edge guessed` : ''}${typeof r.angle === 'number' ? `, turned ${r.angle} degrees` : ''}${r.card ? `, card ${r.card} px` : ''}${typeof r.ratio === 'number' ? `, ${r.ratio} wide for its height` : ''}. ${r.note || ''}`.trim());
	}

	if (report && report.geometry) {
		const g = report.geometry;

		lines.push(`Guide and capture: ${g.holder ? 'holder mode' : 'held by hand'}; zoom ${g.zoom ?? 'not reported'}${g.card ? `; card in the frame at ${pct(g.card.x)}, ${pct(g.card.y)}, ${pct(g.card.w)} wide, ${pct(g.card.h)} tall` : '; no card found in the frame'}`);
	}

	if (entry.drop) {
		lines.push(`Drop: ${compact(entry.drop)}`);
	}

	if (entry.evidence) {
		lines.push(`Evidence: ${compact(entry.evidence)}`);
	}

	return lines;
}

// Every problem the entry records, in words; empty when there was none.
export function scanErrors(entry) {
	const errors = [];
	const report = entry.report;

	if (entry.error) {
		errors.push(`Error: ${oneLine(entry.error)}`);
	}

	if (report && report.rectify && report.rectify.found === false) {
		errors.push('The card\'s edges were not found.');
	}

	if (report && report.pictureWhy) {
		errors.push(`The picture match left the worker: ${report.pictureWhy}.`);
	}

	if (report && report.match && report.match.partial) {
		errors.push('Some sets could not be reached during the lookup.');
	}

	if (entry.first && entry.first.status && !['ready'].includes(entry.first.status)) {
		errors.push(`The scanner stopped at: ${entry.first.status}.`);
	}

	if (entry.outcome && entry.outcome.kind === 'dropped') {
		errors.push(`Dropped by the scanner${entry.outcome.why ? `: ${entry.outcome.why}` : ''}.`);
	}

	if (entry.how === 'holder' && !entry.report && entry.why) {
		errors.push(`Nothing taken: ${entry.why}.`);
	}

	return errors;
}

// The scan as {title, at, version, picture, views, sections}: title like
// "Scan 3 of 30: Bulbasaur, 001/132"; picture the data URL (or null);
// views {before, after} data URLs; sections [{title, lines}], with no
// empty one.
export function scanView(entry, index, total) {
	const first = entry.first && entry.first.card;
	const savedId = entry.outcome && entry.outcome.kind === 'saved' ? entry.outcome.card : null;
	const label = first ? `${first.name}, ${first.number}` : savedId ? nameOf(entry, savedId) || savedId : entry.how === 'holder' ? 'a drop that took nothing' : entry.how === 'mode' ? 'holder mode' : 'no card';
	const errors = scanErrors(entry);
	const other = Object.keys(entry).filter((key) => !KNOWN.has(key)).sort();
	const sections = [
		{lines: [
			`Time: ${entry.at || 'not recorded'}`,
			`Scanner version: ${entry.scanner ?? 'not recorded'}; app ${entry.app || 'not recorded'}`,
			`Source: ${sourceText(entry)}`,
			...(entry.why && entry.how !== 'holder' ? [`Why: ${entry.why}`] : []),
		], title: 'Scan'},
		{lines: entry.report ? readLines(entry.report) : [], title: 'What was read'},
		{lines: textRouteLines(entry.report), title: 'Text route'},
		{lines: pictureRouteLines(entry.report), title: 'Picture route'},
		{lines: candidateLines(entry), title: 'Candidates'},
		{lines: entry.how === 'holder' && !entry.report ? [] : answerLines(entry), title: 'The scanner\'s answer'},
		{lines: outcomeLines(entry), title: 'Saved'},
		{lines: framingLines(entry), title: 'Framing'},
		{lines: timingLines(entry), title: 'Timings'},
		{lines: errors.length ? errors : ['None.'], title: 'Errors'},
		{lines: other.map((key) => `${key}: ${compact(entry[key])}`), title: 'Other fields'},
	].filter((section) => section.lines.length);

	return {
		at: entry.at || null,
		errors: errors.length,
		picture: typeof entry.picture === 'string' && entry.picture.startsWith('data:image/') ? entry.picture : null,
		sections,
		title: `Scan ${index + 1} of ${total}: ${label}`,
		version: entry.scanner ?? null,
		views: entry.views ? {after: entry.views.after || null, before: entry.views.before || null} : null,
	};
}
