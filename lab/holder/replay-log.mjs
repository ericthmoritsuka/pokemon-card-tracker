// Replays the holder drops kept in a scan log (lab/holder/README.md).
//
// node lab/holder/replay-log.mjs <scan-log.json>... [--repo <checkout>]
//   [--identify] [--verbose]
//
// From version 36 the scan log keeps, for each holder drop it took and each
// it skipped, two small copies of the part of the frame watched: the view
// as it last lay still before the drop, and the view at the drop (entry
// `views`, about 320 px). Each pair goes through drop.js judgeChange and
// dropCapture again, so a change to the detector can be checked against a
// real session: did it still take the cards taken, and skip what was
// skipped? --identify also matches the card cut from the small view
// (much softer than the phone's own capture, so a lower bound).
//
// From version 40 each drop is also checked by its picture against the
// card before it (drop.js contentCheck, contentAt), as view.js holderTick
// does: the card before is the last drop the replay took, printed on its
// own view after (where it had settled), when the two views are the same
// size. A drop whose picture is the last card's replays as 'same card'
// (no disturbance like a drop's: its motion peak under DISTURB_PEAK) or
// 'repeat bar'; the scan log's motion peak and frames (version 40; a
// version 36 to 39 log has the peak only, and two frames are assumed)
// tell which.
//
// From version 64 each card taken is also put through the focus check
// (drop.js captureFocus) on the straightened picture the log kept, scaled
// to the card's size in the finer view (200 pixels tall at 1x) with the
// contrast of the view after: added at once, or retried (soft, plain), as
// view.js captureDrop decides. The log keeps one look per drop, so what the
// looks after a retried capture would have shown (a sharper look, the card
// before, nothing left) is not replayed: --verbose names, for each retried
// card, the outcome the phone's own answer and Eric's fix point to.

import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

import {args as parseArgs, dataUrlBytes, decodeImage, pct, readLogs, REPO} from './lib.mjs';

const opts = parseArgs();
const repo = resolve(opts.repo || REPO);
const load = (path) => import(pathToFileURL(join(repo, path)).href);
const drop = await load('js/scan/drop.js');
const steady = await load('js/scan/steady.js');
const entries = readLogs(opts._).filter((entry) => entry.views && entry.views.before && entry.views.after);

if (!entries.length) {
	console.error('No entries with drop views (scan logs from version 36 on, with pictures kept).');
	process.exit(1);
}

let picture = null;
let identifyMod = null;

if (opts.identify) {
	const {register} = await import('node:module');
	const {readFileSync} = await import('node:fs');

	register('./no-ocr.mjs', import.meta.url);
	picture = await load('js/scan/picture.js');
	identifyMod = await load('js/scan/identify.js');
	await picture.loadFingerprints({fetchImpl: async () => ({arrayBuffer: async () => {
		const bytes = readFileSync(join(repo, 'js/vision/index.bin'));

		return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	}, ok: true})});
}

// A decoded view as camera.js viewFrame answers it, at most `side` pixels.
function view(image, side) {
	const scale = Math.min(1, side / Math.max(image.width, image.height));
	const small = scale < 1 ? decodeImage(image.bytes, {maxSide: side}) : image;

	return {grey: steady.toGrey(small.data, small.width, small.height), height: small.height, rect: {h: image.height, w: image.width, x: 0, y: 0}, scale: small.width / image.width, width: small.width};
}

let agree = 0;
// The focus check (version 64) on each card taken: added at once, or why it
// would be retried.
const withFocus = typeof drop.captureFocus === 'function';
const focusCounts = {};

function focusOf(entry) {
	if (!withFocus || !entry.picture || !entry.views || !entry.views.after) {
		return null;
	}

	const card = decodeImage(dataUrlBytes(entry.picture), {maxSide: 200});
	const viewed = decodeImage(dataUrlBytes(entry.views.after), {maxSide: steady.FIND_SIDE_CAPTURE});
	const contrast = drop.viewContrast(steady.toGrey(viewed.data, viewed.width, viewed.height), viewed.width, viewed.height);
	const {height: h, width: w} = card;
	const focus = drop.cardFocus(steady.toGrey(card.data, w, h), w, h, [{x: 0, y: 0}, {x: w, y: 0}, {x: w, y: h}, {x: 0, y: h}], {contrast});
	const why = drop.focusVerdict(focus);
	const outcome = entry.outcome ? `${entry.outcome.kind}${entry.outcome.card ? ` ${entry.outcome.card}` : ''}` : 'no outcome';

	focusCounts[why ? `retried (${why})` : 'added at once'] = (focusCounts[why ? `retried (${why})` : 'added at once'] || 0) + 1;

	if (why) {
		const key = `retried, then ${entry.outcome ? entry.outcome.kind : 'no outcome'}`;

		focusCounts[key] = (focusCounts[key] || 0) + 1;
	}

	return `${why ? `retried (${why})` : 'added at once'} blur=${focus.blur.toFixed(2)} texture=${focus.texture.toFixed(2)}; on the phone: ${outcome}`;
}

let right = 0;
let labelled = 0;
// The last drop taken, for the content check: {print, quad, size}.
let last = null;
const withContent = typeof drop.contentCheck === 'function';

for (const entry of entries) {
	const beforeBytes = dataUrlBytes(entry.views.before);
	const afterBytes = dataUrlBytes(entry.views.after);
	const after = {...decodeImage(afterBytes), bytes: afterBytes};
	const before = {...decodeImage(beforeBytes), bytes: beforeBytes};
	const a = view(after, steady.FIND_SIDE);
	const b = view(before, steady.FIND_SIDE);
	const change = drop.judgeChange(drop.cells(a.grey, a.width, a.height), drop.cells(b.grey, b.width, b.height));
	const logged = entry.how === 'holder' ? entry.why : 'drop';
	const size = `${after.width}x${after.height}`;
	const fine = view(after, steady.FIND_SIDE_CAPTURE);
	const logDrop = entry.drop || (entry.report && entry.report.geometry && entry.report.geometry.drop) || {};
	const burst = typeof logDrop.motionPeak === 'number' ? {frames: logDrop.motionFrames ?? 2, peak: logDrop.motionPeak} : null;
	const previous = last && last.size === size ? last : null;
	let replayed = change.kind;
	let top = null;
	let content = null;

	if (withContent && change.kind !== 'drop' && burst && previous && ['none', 'small', 'shape'].includes(change.kind)) {
		content = drop.contentAt(previous, fine);
		replayed = content.verdict === 'new' ? 'drop (same spot)' : content.verdict === 'same' && drop.disturbedBy(burst) ? 'repeat bar' : change.kind;

		if (content.verdict === 'new') {
			last = {print: drop.printOf(fine.grey, fine.width, fine.height, previous.quad.map(drop.toView(fine))), quad: previous.quad, size};
		}
	}

	if (change.kind === 'drop') {
		const plan = drop.dropCapture(change, a, fine, steady.findCard(fine.grey, fine.width, fine.height), {frame: {height: after.height, width: after.width}});

		replayed = plan.skip || 'drop';

		if (withContent && !plan.skip) {
			content = drop.contentCheck(plan, fine, previous);

			if (content.verdict === 'same') {
				replayed = drop.disturbedBy(burst) ? 'repeat bar' : 'same card';
			}
			else {
				last = {print: content.print, quad: content.quad, size};
			}
		}

		if (identifyMod && !plan.skip) {
			const region = plan.region;
			const data = new Uint8ClampedArray(region.w * region.h * 4);

			for (let y = 0; y < region.h; y++) {
				data.set(after.data.subarray(((region.y + y) * after.width + region.x) * 4, ((region.y + y) * after.width + region.x + region.w) * 4), y * region.w * 4);
			}

			const result = await identifyMod.identifyPicture({data, height: region.h, width: region.w}, {quads: plan.quads});
			const groups = result.picture ? result.picture.groups : [];

			top = groups[0] ? groups[0].cards.map((c) => c.id) : [];

			if (entry.truth) {
				labelled++;
				right += top.includes(entry.truth) ? 1 : 0;
			}
		}
	}

	agree += replayed === logged || (logged === 'drop' && replayed.startsWith('drop')) ? 1 : 0;

	const focused = logged === 'drop' ? focusOf(entry) : null;

	if (opts.verbose || replayed !== logged) {
		console.log(`${entry.at} logged ${logged}, replayed ${replayed}${top ? `, ${top[0] || 'nothing'}${entry.truth ? ` (saved ${entry.truth})` : ''}` : ''} share=${change.share.toFixed(3)}${change.alike !== undefined ? ` alike=${change.alike}` : ''}${content ? ` print=${content.distance ?? '-'} ${content.verdict}` : ''}${focused ? `; ${focused}` : ''}`);
	}
}

console.log(`\n${entries.length} drops with views: the replay agrees on ${agree} (${pct(agree, entries.length)})${labelled ? `; picture right on ${right} of ${labelled} saved cards` : ''}`);

if (Object.keys(focusCounts).length) {
	console.log(`Cards taken, put through the focus check on their pictures: ${Object.entries(focusCounts).map(([why, n]) => `${why} ${n}`).join(', ')}`);
}
