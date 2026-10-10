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
let right = 0;
let labelled = 0;

for (const entry of entries) {
	const beforeBytes = dataUrlBytes(entry.views.before);
	const afterBytes = dataUrlBytes(entry.views.after);
	const after = {...decodeImage(afterBytes), bytes: afterBytes};
	const before = {...decodeImage(beforeBytes), bytes: beforeBytes};
	const a = view(after, steady.FIND_SIDE);
	const b = view(before, steady.FIND_SIDE);
	const change = drop.judgeChange(drop.cells(a.grey, a.width, a.height), drop.cells(b.grey, b.width, b.height));
	const logged = entry.how === 'holder' ? entry.why : 'drop';
	let replayed = change.kind;
	let top = null;

	if (change.kind === 'drop') {
		const fine = view(after, steady.FIND_SIDE_CAPTURE);
		const plan = drop.dropCapture(change, a, fine, steady.findCard(fine.grey, fine.width, fine.height), {frame: {height: after.height, width: after.width}});

		replayed = plan.skip || 'drop';

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

	agree += replayed === logged ? 1 : 0;

	if (opts.verbose || replayed !== logged) {
		console.log(`${entry.at} logged ${logged}, replayed ${replayed}${top ? `, ${top[0] || 'nothing'}${entry.truth ? ` (saved ${entry.truth})` : ''}` : ''} share=${change.share.toFixed(3)}${change.alike !== undefined ? ` alike=${change.alike}` : ''}`);
	}
}

console.log(`\n${entries.length} drops with views: the replay agrees on ${agree} (${pct(agree, entries.length)})${labelled ? `; picture right on ${right} of ${labelled} saved cards` : ''}`);
