// Share a card, or a binder page, as a picture (2026-11-19, from a survey of
// other collection apps; Eric sends cards to his family on WhatsApp). Card
// detail's Share (js/catalog-views.js) draws the card's main picture with
// its name, set, number, and the copies; a binder's Share page
// (js/binders-view.js) draws the open page, or both pages of the spread, as
// they look, with the binder's name and the page numbers. The phone's share
// sheet gets a PNG (navigator.share with files); where there is none (a
// computer), the PNG downloads. Loaded only when Share is tapped.
//
// Every picture is read as a file (fetch, then createImageBitmap) and never
// drawn from an <img> on the page: the app's card images carry no
// crossorigin attribute (js/tile.js), and drawing one would taint the canvas
// so that no PNG could be made of it. Own and family photos are object URLs
// of files read from the phone or the bucket (js/photos/store.js), so they
// read as they are. A TCGdex picture is read in cors mode (the service
// worker answers from its cors cache when it has it), then through the
// relay Save image uses (js/photos/save.js relayRead), since TCGdex sends
// Access-Control-Allow-Origin twice on many pictures. A picture that cannot
// be read leaves a card back with the name, never a failed share. DESIGN.md
// section 5, "Share as a picture".
//
// The layout at the top is pure, so Node tests it (tests/share-image.test.mjs);
// nothing here touches the DOM until a draw function runs.

import {cleanFileName, officialUrls, relayRead} from './photos/save.js';
import {downloadBlob} from './scan/image.js';

// ------------------------------------------------------------ layout

// A card's shape, width over height.
export const CARD_RATIO = 63 / 88;

// The card picture, in layout units; the canvas is drawn SCALE times larger.
export const CARD = {
	art: 520,
	pad: 44,
	scale: 1.5,
	width: 720,
};

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

// Each kind of line on the card picture: its font, height, and color.
export const LINES = {
	copies: {color: '#333333', font: `400 26px ${FONT}`, height: 36},
	copiesTitle: {color: '#1a1a1a', font: `600 28px ${FONT}`, height: 40},
	detail: {color: '#444444', font: `400 28px ${FONT}`, height: 38},
	footer: {color: '#8a8a8a', font: `400 20px ${FONT}`, height: 28},
	name: {color: '#111111', font: `700 40px ${FONT}`, height: 50},
};

// The copies, one line per language and finish with a count, most first:
// "English · Reverse holo ×2". items: [{language, finish}], finish null
// when not known. Past max lines, the last says how many more.
export function copyLines(items, {max = 6} = {}) {
	const counts = new Map();

	for (const item of items || []) {
		const text = [item && item.language, item && item.finish].filter(Boolean).join(' · ');

		if (text) {
			counts.set(text, (counts.get(text) || 0) + 1);
		}
	}

	const lines = [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([text, n]) => (n > 1 ? `${text} ×${n}` : text));

	if (lines.length <= max) {
		return lines;
	}

	const rest = lines.length - (max - 1);

	return [...lines.slice(0, max - 1), `and ${rest} more`];
}

// Words in lines no wider than width, by measure(text) -> width. A word
// wider than a line stays whole on its own line. Past maxLines, the last
// line ends with "…".
export function wrapText(text, width, measure, maxLines = Infinity) {
	const words = String(text || '').split(/\s+/).filter(Boolean);
	const lines = [];
	let line = '';

	for (const word of words) {
		const next = line ? `${line} ${word}` : word;

		if (line && measure(next) > width) {
			lines.push(line);
			line = word;
		}
		else {
			line = next;
		}
	}

	if (line) {
		lines.push(line);
	}

	if (lines.length <= maxLines) {
		return lines;
	}

	const kept = lines.slice(0, maxLines);
	let last = `${kept[maxLines - 1]}…`;

	while (last.length > 1 && measure(last) > width) {
		last = `${last.slice(0, -2).trimEnd()}…`;
	}

	kept[maxLines - 1] = last;

	return kept;
}

// Where everything on the card picture goes, in layout units: the art box,
// then each line centered under it. lines: {name, details, copiesTitle,
// copies}, each an array of already wrapped lines (copiesTitle a string or
// null). Returns {width, height, art: {x, y, w, h}, texts: [{kind, text, x,
// y}]}, y the top of each line.
export function cardLayout({copies = [], copiesTitle = null, details = [], name = []} = {}) {
	const {art: artWidth, pad, width} = CARD;
	const art = {h: Math.round(artWidth / CARD_RATIO), w: artWidth, x: (width - artWidth) / 2, y: pad};
	const texts = [];
	let y = art.y + art.h + 32;

	const put = (kind, text) => {
		texts.push({kind, text, x: width / 2, y});
		y += LINES[kind].height;
	};

	name.forEach((text) => put('name', text));
	y += 4;
	details.forEach((text) => put('detail', text));

	if (copiesTitle && copies.length) {
		y += 18;
		put('copiesTitle', copiesTitle);
		copies.forEach((text) => put('copies', text));
	}

	y += 22;
	put('footer', 'Card Tracker');

	return {art, height: Math.ceil(y + pad - 8), texts, width};
}

// A picture of iw x ih in box: 'cover' fills the box and crops the
// picture's middle (a card's art), 'contain' fits it whole (a Pokémon's
// sprite). Returns drawImage's source and destination rectangles.
export function fitImage(iw, ih, box, mode = 'cover') {
	const scale = mode === 'cover' ? Math.max(box.w / iw, box.h / ih) : Math.min(box.w / iw, box.h / ih);

	if (mode === 'cover') {
		const sw = box.w / scale;
		const sh = box.h / scale;

		return {dh: box.h, dw: box.w, dx: box.x, dy: box.y, sh, sw, sx: (iw - sw) / 2, sy: (ih - sh) / 2};
	}

	const dw = iw * scale;
	const dh = ih * scale;

	return {dh, dw, dx: box.x + ((box.w - dw) / 2), dy: box.y + ((box.h - dh) / 2), sh: ih, sw: iw, sx: 0, sy: 0};
}

// A picture shaped like a card fills its pocket; anything else (a sprite,
// a square photo) fits inside it.
export const fitMode = (iw, ih) => (Math.abs((iw / ih) - CARD_RATIO) / CARD_RATIO <= 0.12 ? 'cover' : 'contain');

// "Page 3", or "Pages 2 and 3" for a spread.
export function pagesLabel(pages) {
	const list = (pages || []).filter(Boolean);

	return list.length > 1 ? `Pages ${list.join(' and ')}` : `Page ${list[0] || 1}`;
}

// The binder page picture, in pixels.
export const PAGE = {
	folio: 30,
	gap: 12,
	header: 92,
	maxPocket: 200,
	maxWidth: 1600,
	minPocket: 48,
	minWidth: 640,
	outer: 32,
	pagePad: 18,
	spine: 22,
};

// Where the pages and their pockets go: the binder's name and the page
// numbers across the top, then the pages side by side (left first, as
// js/binder-spread.js visiblePages gives them) with a gap for the spine,
// each pocket card shaped. A pocket is as wide as maxPocket, smaller when
// that would pass maxWidth (four columns on a spread). Returns {width,
// height, title: {x, y}, label: {x, y}, pages: [{page, x, y, w, h, folio:
// {x, y}, pockets: [{position, x, y, w, h}]}]}.
export function pageLayout({cols, pages, rows}) {
	const {folio, gap, header, maxPocket, maxWidth, minPocket, minWidth, outer, pagePad, spine} = PAGE;
	const list = (pages || []).filter(Boolean);
	const n = Math.max(1, list.length);
	const c = Math.max(1, cols | 0);
	const r = Math.max(1, rows | 0);
	const room = maxWidth - (2 * outer) - ((n - 1) * spine) - (n * ((2 * pagePad) + ((c - 1) * gap)));
	const pw = Math.max(minPocket, Math.min(maxPocket, Math.floor(room / (n * c))));
	const ph = Math.round(pw / CARD_RATIO);
	const pageW = (2 * pagePad) + (c * pw) + ((c - 1) * gap);
	const pageH = (2 * pagePad) + (r * ph) + ((r - 1) * gap) + folio;
	const inner = (n * pageW) + ((n - 1) * spine);
	const width = Math.max(minWidth, inner + (2 * outer));
	const left = (width - inner) / 2;
	const top = outer + header;

	return {
		height: top + pageH + outer,
		label: {x: width / 2, y: outer + 48},
		pages: list.map((page, i) => {
			const x = left + (i * (pageW + spine));
			const pockets = [];

			for (let position = 1; position <= r * c; position++) {
				const row = Math.floor((position - 1) / c);
				const col = (position - 1) % c;

				pockets.push({h: ph, position, w: pw, x: x + pagePad + (col * (pw + gap)), y: top + pagePad + (row * (ph + gap))});
			}

			return {folio: {x: x + (pageW / 2), y: top + pageH - folio + 2}, h: pageH, page, pockets, w: pageW, x, y: top};
		}),
		title: {x: width / 2, y: outer},
		width,
	};
}

// The file a picture is shared as: "Pikachu - Surging Sparks 057.png".
export const pngName = (stem) => `${cleanFileName(stem)}.png`;

// ------------------------------------------------------------ pictures

const TCGDEX = 'assets.tcgdex.net';

const hostOf = (src) => {
	try {
		return new URL(src, globalThis.location ? globalThis.location.href : undefined).hostname;
	}
	catch {
		return '';
	}
};

async function readBlob(src, fetchImpl) {
	try {
		const response = await fetchImpl(src, {credentials: 'omit', mode: 'cors'});

		return response.ok ? await response.blob() : null;
	}
	catch {
		return null;
	}
}

// A picture to draw, as an ImageBitmap, or null when it cannot be read
// here. A TCGdex picture that fails in cors mode is asked of the relay (its
// high WebP, the only kind the relay hands out), unless past deadline.
export async function readPicture(src, {deadline = Infinity, fetchImpl = (...args) => fetch(...args), relay = relayRead} = {}) {
	if (!src) {
		return null;
	}

	let blob = await readBlob(src, fetchImpl);

	if (!blob && hostOf(src) === TCGDEX && Date.now() < deadline) {
		const urls = officialUrls(src);

		blob = urls ? await relay(urls.webp).catch(() => null) : null;
	}

	if (!blob) {
		return null;
	}

	try {
		return await createImageBitmap(blob);
	}
	catch {
		return null;
	}
}

// Runs fn over items, limit at a time, in order.
async function eachLimit(items, limit, fn) {
	const out = new Array(items.length);
	let next = 0;

	async function worker() {
		while (next < items.length) {
			const at = next++;

			out[at] = await fn(items[at], at);
		}
	}

	await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));

	return out;
}

// ------------------------------------------------------------ drawing

function roundRect(ctx, x, y, w, h, r) {
	const radius = Math.max(0, Math.min(r, w / 2, h / 2));

	ctx.beginPath();
	ctx.moveTo(x + radius, y);
	ctx.arcTo(x + w, y, x + w, y + h, radius);
	ctx.arcTo(x + w, y + h, x, y + h, radius);
	ctx.arcTo(x, y + h, x, y, radius);
	ctx.arcTo(x, y, x + w, y, radius);
	ctx.closePath();
}

// A picture clipped to a card's rounded corners.
function drawPicture(ctx, bitmap, box, {alpha = 1, radius} = {}) {
	const fit = fitImage(bitmap.width, bitmap.height, box, fitMode(bitmap.width, bitmap.height));

	ctx.save();
	roundRect(ctx, box.x, box.y, box.w, box.h, radius);
	ctx.clip();
	ctx.globalAlpha = alpha;
	ctx.drawImage(bitmap, fit.sx, fit.sy, fit.sw, fit.sh, fit.dx, fit.dy, fit.dw, fit.dh);
	ctx.restore();
}

// A card back with the name, for a picture that could not be read, as the
// app's own tiles show one (js/tile.js cardBack).
function drawCardBack(ctx, box, name, {alpha = 1, radius} = {}) {
	ctx.save();
	ctx.globalAlpha = alpha;
	roundRect(ctx, box.x, box.y, box.w, box.h, radius);
	ctx.fillStyle = '#2b3a67';
	ctx.fill();

	const size = Math.max(10, Math.round(box.w * 0.11));

	ctx.fillStyle = '#ffffff';
	ctx.font = `600 ${size}px ${FONT}`;
	ctx.textAlign = 'center';
	ctx.textBaseline = 'top';

	const lines = wrapText(name || '', box.w * 0.84, (text) => ctx.measureText(text).width, 4);
	const lineH = Math.round(size * 1.25);
	const top = box.y + ((box.h - (lines.length * lineH)) / 2);

	lines.forEach((line, i) => ctx.fillText(line, box.x + (box.w / 2), top + (i * lineH)));
	ctx.restore();
}

function newCanvas(width, height, scale = 1) {
	const canvas = document.createElement('canvas');

	canvas.width = Math.round(width * scale);
	canvas.height = Math.round(height * scale);

	const ctx = canvas.getContext('2d');

	ctx.scale(scale, scale);

	return {canvas, ctx};
}

// The card picture. card: {name, details: [lines], copiesTitle, copies:
// [lines]}; picture: an ImageBitmap or null (the card back shows).
export function drawCard(card, picture) {
	const measure = document.createElement('canvas').getContext('2d');
	const wrap = (kind, text, max) => {
		measure.font = LINES[kind].font;

		return wrapText(text, CARD.width - (2 * CARD.pad), (line) => measure.measureText(line).width, max);
	};
	const layout = cardLayout({
		copies: (card.copies || []).flatMap((line) => wrap('copies', line, 2)),
		copiesTitle: card.copiesTitle || null,
		details: (card.details || []).filter(Boolean).flatMap((line) => wrap('detail', line, 2)),
		name: wrap('name', card.name || 'Card', 3),
	});
	const {canvas, ctx} = newCanvas(layout.width, layout.height, CARD.scale);
	const radius = layout.art.w * 0.045;

	ctx.fillStyle = '#ffffff';
	ctx.fillRect(0, 0, layout.width, layout.height);

	// A soft shadow under the card, so a white-bordered card still stands
	// out from the white around it.
	ctx.save();
	ctx.shadowBlur = 18;
	ctx.shadowColor = 'rgba(0, 0, 0, 0.22)';
	ctx.shadowOffsetY = 4;
	roundRect(ctx, layout.art.x, layout.art.y, layout.art.w, layout.art.h, radius);
	ctx.fillStyle = '#ffffff';
	ctx.fill();
	ctx.restore();

	if (picture) {
		drawPicture(ctx, picture, layout.art, {radius});
	}
	else {
		drawCardBack(ctx, layout.art, card.name, {radius});
	}

	ctx.textAlign = 'center';
	ctx.textBaseline = 'top';

	for (const {kind, text, x, y} of layout.texts) {
		ctx.font = LINES[kind].font;
		ctx.fillStyle = LINES[kind].color;
		ctx.fillText(text, x, y);
	}

	return canvas;
}

const TAGS = {gone: 'Gone', want: 'Want'};
const TEXTS = {art: 'Art', empty: 'Empty'};

function drawPocket(ctx, box, pocket, bitmap) {
	const radius = box.w * 0.05;
	const kind = pocket ? pocket.kind : 'open';

	roundRect(ctx, box.x, box.y, box.w, box.h, radius);
	ctx.fillStyle = '#ecebe5';
	ctx.fill();
	ctx.strokeStyle = '#d3d1c8';
	ctx.lineWidth = 1;
	ctx.stroke();

	if (kind === 'card' || kind === 'gone' || kind === 'want') {
		// A placeholder and a card no longer owned are dimmed, as on screen.
		const alpha = kind === 'card' ? 1 : 0.45;

		if (bitmap) {
			drawPicture(ctx, bitmap, box, {alpha, radius});
		}
		else {
			drawCardBack(ctx, box, pocket.name, {alpha, radius});
		}

		if (TAGS[kind]) {
			const size = Math.max(10, Math.round(box.w * 0.1));

			ctx.font = `700 ${size}px ${FONT}`;

			const w = ctx.measureText(TAGS[kind]).width + (size * 1.2);
			const h = size * 1.6;
			const x = box.x + ((box.w - w) / 2);
			const y = box.y + box.h - h - (box.h * 0.05);

			roundRect(ctx, x, y, w, h, h / 2);
			ctx.fillStyle = 'rgba(20, 20, 20, 0.75)';
			ctx.fill();
			ctx.fillStyle = '#ffffff';
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.fillText(TAGS[kind], x + (w / 2), y + (h / 2));
		}

		return;
	}

	if (TEXTS[kind]) {
		ctx.font = `600 ${Math.max(10, Math.round(box.w * 0.12))}px ${FONT}`;
		ctx.fillStyle = '#8a877c';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText(TEXTS[kind], box.x + (box.w / 2), box.y + (box.h / 2));
	}
}

// The binder page picture. binder: {name, color, textColor, rows, cols};
// pages: [{page, pockets: [{kind, name, src}]}] with the pockets in order;
// bitmaps: Map of src to ImageBitmap.
export function drawPages(binder, pages, bitmaps = new Map()) {
	const layout = pageLayout({cols: binder.cols, pages: pages.map((item) => item.page), rows: binder.rows});
	const {canvas, ctx} = newCanvas(layout.width, layout.height);

	ctx.fillStyle = binder.color || '#1d2e60';
	ctx.fillRect(0, 0, layout.width, layout.height);
	ctx.textAlign = 'center';
	ctx.textBaseline = 'top';
	ctx.fillStyle = binder.textColor || '#ffffff';
	ctx.font = `700 34px ${FONT}`;

	const [title = ''] = wrapText(binder.name || 'Binder', layout.width - (2 * PAGE.outer), (text) => ctx.measureText(text).width, 1);

	ctx.fillText(title, layout.title.x, layout.title.y);
	ctx.font = `400 24px ${FONT}`;
	ctx.fillText(pagesLabel(pages.map((item) => item.page)), layout.label.x, layout.label.y);

	layout.pages.forEach((shape, i) => {
		roundRect(ctx, shape.x, shape.y, shape.w, shape.h, 10);
		ctx.fillStyle = '#fbfaf6';
		ctx.fill();

		const pockets = pages[i].pockets || [];

		for (const box of shape.pockets) {
			const pocket = pockets[box.position - 1] || null;

			drawPocket(ctx, box, pocket, pocket && pocket.src ? bitmaps.get(pocket.src) || null : null);
		}

		ctx.font = `400 18px ${FONT}`;
		ctx.fillStyle = '#8a877c';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'top';
		ctx.fillText(String(shape.page), shape.folio.x, shape.folio.y);
	});

	return canvas;
}

// ------------------------------------------------------------ the file

export const TAINTED = 'A picture here could not be used, so no image was made.';

// The canvas as a PNG. A canvas some picture tainted refuses (a
// SecurityError), which is said plainly rather than thrown as it comes.
export async function canvasPng(canvas) {
	let blob;

	try {
		blob = await new Promise((resolve, reject) => {
			try {
				canvas.toBlob(resolve, 'image/png');
			}
			catch (err) {
				reject(err);
			}
		});
	}
	catch (err) {
		throw new Error(err && err.name === 'SecurityError' ? TAINTED : 'The image could not be made.');
	}

	if (!blob) {
		throw new Error('The image could not be made.');
	}

	return blob;
}

function canShareFile(file) {
	if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') {
		return false;
	}

	try {
		return typeof navigator.canShare !== 'function' || navigator.canShare({files: [file]});
	}
	catch {
		return false;
	}
}

// The phone's share sheet with the file, or a download where files cannot
// be shared (a computer). Resolves with what happened: 'shared', 'closed'
// (the sheet was closed), 'retry' (the phone wanted a fresh tap: making
// the picture took too long for the first one to count, so the toast's
// Share is the new tap), or 'saved'.
export async function shareFile(file, {download = downloadBlob, notify = () => {}, title = ''} = {}) {
	if (!canShareFile(file)) {
		download(file, file.name);
		notify(`Saved ${file.name}.`);

		return 'saved';
	}

	try {
		await navigator.share({files: [file], title});

		return 'shared';
	}
	catch (err) {
		if (err && err.name === 'AbortError') {
			return 'closed';
		}

		if (err && err.name === 'NotAllowedError') {
			notify('The image is ready.', {action: () => shareFile(file, {download, notify, title}), actionLabel: 'Share', timeout: 15000});

			return 'retry';
		}

		download(file, file.name);
		notify(`Sharing did not work, so the image was saved as ${file.name}.`);

		return 'saved';
	}
}

// Card detail's Share. card: {name, details, copiesTitle, copies, stem};
// picture() resolves to the main picture's URL, or null.
export async function shareCard(card, {notify = () => {}, picture = () => null, read = readPicture, share = shareFile} = {}) {
	const src = await Promise.resolve(picture()).catch(() => null);
	const bitmap = src ? await read(src) : null;

	if (src && !bitmap) {
		notify('The card\'s picture could not be added, so the image shows its name.');
	}

	const canvas = drawCard(card, bitmap);
	const blob = await canvasPng(canvas);
	const file = new File([blob], pngName(card.stem || card.name || 'Card'), {type: 'image/png'});

	return share(file, {notify, title: card.name || ''});
}

// How long a binder page waits for the relay before drawing card backs
// instead, so a page of pictures TCGdex will not hand over still shares.
export const RELAY_BUDGET_MS = 8000;

// A binder's Share page. binder: {name, color, textColor, rows, cols};
// pages: [{page, pockets: [{kind, name, src}]}].
export async function sharePages(binder, pages, {notify = () => {}, read = readPicture, share = shareFile} = {}) {
	const sources = [...new Set(pages.flatMap((item) => (item.pockets || []).map((pocket) => pocket && pocket.src).filter(Boolean)))];
	const deadline = Date.now() + RELAY_BUDGET_MS;
	const pictures = await eachLimit(sources, 4, (src) => read(src, {deadline}));
	const bitmaps = new Map(sources.map((src, i) => [src, pictures[i]]).filter(([, bitmap]) => bitmap));

	if (bitmaps.size < sources.length) {
		notify(bitmaps.size ? 'Some pictures could not be added, so those pockets show the card\'s name.' : 'The pictures could not be added, so the pockets show the cards\' names.');
	}

	const label = pagesLabel(pages.map((item) => item.page));
	const canvas = drawPages(binder, pages, bitmaps);
	const blob = await canvasPng(canvas);
	const file = new File([blob], pngName(`${binder.name || 'Binder'} - ${label}`), {type: 'image/png'});

	return share(file, {notify, title: `${binder.name || 'Binder'}, ${label.toLowerCase()}`});
}
