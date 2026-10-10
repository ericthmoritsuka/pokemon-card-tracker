// Proposes the drop events of a holder video, for labelling by hand
// (lab/holder/README.md).
//
// node lab/holder/label.mjs <video> --out <labels.json> [--sheet <dir>]
//
// Reads every frame at the video's own rate, measures how much the picture
// moves from one frame to the next (mean absolute grey difference on a
// small copy, brightness change taken out), and proposes one drop per burst
// of motion that is followed by a still picture: `start` (the first moving
// frame) and `settle` (the first frame of the still run), in seconds. With
// --sheet, writes one JPEG per proposal (the frame before, the last moving
// frames, and the settled frame) to check by eye; edit the JSON by hand
// afterwards: delete false drops (a hand, the flash moved), add missed ones,
// and fill `card` (the card's id, as the scanner names it) and the
// `segments` (time ranges with their light, zoom, and drop speed).

import {writeFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';

import {args as parseArgs, encodeJpeg, outside, videoFrames, videoInfo} from './lib.mjs';

const opts = parseArgs();
const video = opts._[0];

if (!video || !opts.out) {
	console.error('node lab/holder/label.mjs <video> --out <labels.json> [--sheet <dir>]');
	process.exit(1);
}

const W = 48;
const H = 85;

function small(img) {
	const out = new Float32Array(W * H);
	const sx = img.width / W;
	const sy = img.height / H;

	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			let s = 0;
			let n = 0;

			for (let yy = Math.floor(y * sy); yy < Math.floor((y + 1) * sy); yy += 2) {
				for (let xx = Math.floor(x * sx); xx < Math.floor((x + 1) * sx); xx += 2) {
					const i = (yy * img.width + xx) * 4;

					s += img.data[i] * 0.299 + img.data[i + 1] * 0.587 + img.data[i + 2] * 0.114;
					n++;
				}
			}

			out[y * W + x] = s / n;
		}
	}

	return out;
}

function moved(a, b) {
	let shift = 0;

	for (let i = 0; i < a.length; i++) {
		shift += a[i] - b[i];
	}

	shift /= a.length;

	let sum = 0;

	for (let i = 0; i < a.length; i++) {
		sum += Math.abs(a[i] - b[i] - shift);
	}

	return sum / a.length;
}

const info = videoInfo(video);
const motion = [];
const frames = [];
let previous = null;

for await (const {image, t} of videoFrames(video)) {
	const s = small(image);

	motion.push({m: previous ? moved(s, previous) : 0, t});
	frames.push(opts.sheet ? image : null);
	previous = s;
}

// A burst: motion above MOVING; settled once it stays under STILL for
// STILL_FRAMES frames.
const MOVING = 4;
const STILL = 1.5;
const STILL_FRAMES = Math.round(info.fps * 0.3);
const drops = [];
let start = null;
let peak = 0;

for (let i = 1; i < motion.length; i++) {
	if (motion[i].m > MOVING) {
		if (start === null) {
			start = i;
			peak = 0;
		}

		peak = Math.max(peak, motion[i].m);
		continue;
	}

	if (start !== null) {
		let still = 0;

		for (let k = i; k < Math.min(motion.length, i + STILL_FRAMES); k++) {
			still += motion[k].m < STILL ? 1 : 0;
		}

		if (still === STILL_FRAMES) {
			drops.push({card: null, frame: i, peak: Math.round(peak * 10) / 10, settle: Math.round(motion[i].t * 100) / 100, start: Math.round(motion[start].t * 100) / 100});
			start = null;
		}
	}
}

writeFileSync(outside(opts.out), JSON.stringify({drops, fps: info.fps, motion: motion.map((m) => Math.round(m.m * 10) / 10), segments: [], video}, null, 1));
console.log(`${drops.length} proposed drops in ${motion.length} frames (${info.fps.toFixed(2)} fps)`);

if (opts.sheet) {
	const dir = outside(opts.sheet);

	mkdirSync(dir, {recursive: true});
	drops.forEach((drop, n) => {
		const picks = [Math.max(0, motion.findIndex((m) => m.t >= drop.start) - 2), drop.frame - 2, drop.frame, Math.min(frames.length - 1, drop.frame + Math.round(info.fps * 0.5))];
		const tiles = picks.map((k) => frames[k]);
		const w = tiles[0].width;
		const h = tiles[0].height;
		const data = new Uint8ClampedArray(w * tiles.length * h * 4);

		tiles.forEach((tile, j) => {
			for (let y = 0; y < h; y++) {
				data.set(tile.data.subarray(y * w * 4, (y + 1) * w * 4), (y * w * tiles.length + j * w) * 4);
			}
		});

		encodeJpeg({data, height: h, width: w * tiles.length}, join(dir, `drop-${String(n).padStart(3, '0')}-${drop.settle}s.jpg`), 6);
	});
}
