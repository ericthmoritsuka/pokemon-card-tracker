// Shared helpers for the holder benchmarks (lab/holder/README.md): images
// decoded and frames streamed through ffmpeg, scan logs read and merged, and
// the fingerprint index loaded from the repo. Nothing here writes into the
// repo: every output path must be outside it.

import {spawn, spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {unpackIndex} from '../../js/vision/pack.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export const REPO = resolve(HERE, '../..');

export function args(argv = process.argv.slice(2)) {
	const out = {_: []};

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];

		if (a.startsWith('--')) {
			const next = argv[i + 1];

			out[a.slice(2)] = next !== undefined && !next.startsWith('--') ? (i++, next) : true;
		}
		else {
			out._.push(a);
		}
	}

	return out;
}

// Refuses a path inside the repo: logs, frames, crops, and results are
// personal and the repo is public.
export function outside(path) {
	const full = resolve(path);

	if (full === REPO || full.startsWith(`${REPO}/`)) {
		throw new Error(`${path} is inside the repo; keep personal data and results outside it.`);
	}

	return full;
}

export function loadFingerprintIndex(path = join(REPO, 'js/vision/index.bin')) {
	return unpackIndex(new Uint8Array(readFileSync(path)));
}

// An image file (or a Buffer of one) as ImageData-shaped RGBA, through
// ffmpeg. maxSide scales it down first when it is larger.
export function decodeImage(input, {maxSide = 0} = {}) {
	const isBuffer = Buffer.isBuffer(input);
	const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', isBuffer ? 'pipe:0' : input], {input: isBuffer ? input : undefined});
	let [width, height] = String(probe.stdout).trim().split('x').map(Number);

	if (!width || !height) {
		throw new Error(`Cannot read the size of ${isBuffer ? 'an image buffer' : input}`);
	}

	const filters = [];

	if (maxSide && Math.max(width, height) > maxSide) {
		const s = maxSide / Math.max(width, height);

		width = Math.max(1, Math.round(width * s));
		height = Math.max(1, Math.round(height * s));
		filters.push('-vf', `scale=${width}:${height}:flags=area`);
	}

	const out = spawnSync('ffmpeg', ['-v', 'error', '-i', isBuffer ? 'pipe:0' : input, ...filters, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], {input: isBuffer ? input : undefined, maxBuffer: 1 << 30});

	if (out.status !== 0) {
		throw new Error(`ffmpeg failed: ${out.stderr}`);
	}

	return {data: new Uint8ClampedArray(out.stdout.buffer, out.stdout.byteOffset, width * height * 4), height, width};
}

// RGBA (ImageData-shaped) to a JPEG file, through ffmpeg.
export function encodeJpeg(img, path, quality = 4) {
	const out = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${img.width}x${img.height}`, '-i', 'pipe:0', '-q:v', String(quality), outside(path)], {input: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength)});

	if (out.status !== 0) {
		throw new Error(`ffmpeg failed: ${out.stderr}`);
	}
}

export function videoInfo(path) {
	const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate,nb_frames', '-of', 'json', path]);
	const s = JSON.parse(String(probe.stdout)).streams[0];
	const [n, d] = s.avg_frame_rate.split('/').map(Number);

	return {fps: n / d, frames: Number(s.nb_frames), height: s.height, width: s.width};
}

// Every frame of a video at `fps` (or its own rate), scaled to at most
// maxSide, as an async generator of {index, t, image}. t is in seconds.
export async function* videoFrames(path, {fps = 0, maxSide = 0, start = 0, duration = 0} = {}) {
	const info = videoInfo(path);
	let {width, height} = info;
	const filters = [];

	if (fps) {
		filters.push(`fps=${fps}`);
	}

	if (maxSide && Math.max(width, height) > maxSide) {
		const s = maxSide / Math.max(width, height);

		width = Math.round(width * s / 2) * 2;
		height = Math.round(height * s / 2) * 2;
		filters.push(`scale=${width}:${height}:flags=area`);
	}

	const rate = fps || info.fps;
	const cli = ['-v', 'error', ...(start ? ['-ss', String(start)] : []), '-i', path, ...(duration ? ['-t', String(duration)] : []), ...(filters.length ? ['-vf', filters.join(',')] : []), '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'];
	const child = spawn('ffmpeg', cli, {stdio: ['ignore', 'pipe', 'inherit']});
	const size = width * height * 4;
	let pending = Buffer.alloc(0);
	let index = 0;

	for await (const chunk of child.stdout) {
		pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;

		while (pending.length >= size) {
			const frame = Buffer.from(pending.subarray(0, size));

			pending = pending.subarray(size);
			yield {image: {data: new Uint8ClampedArray(frame.buffer, frame.byteOffset, size), height, width}, index, t: start + index / rate};
			index++;
		}
	}
}

// The entries of one or more scan logs (js/scan/log.js logFile), merged by
// id (a later log holds the earlier one's entries too), oldest first. Each
// gets `truth`: the card Eric saved (outcome.card), else the scanner's first
// answer when he removed it unchanged, else null.
export function readLogs(paths) {
	const byId = new Map();

	for (const path of paths) {
		const file = JSON.parse(readFileSync(path, 'utf8'));

		for (const entry of file.entries || []) {
			byId.set(entry.id, entry);
		}
	}

	return [...byId.values()].sort((a, b) => String(a.at).localeCompare(String(b.at))).map((entry) => {
		const outcome = entry.outcome || {};
		const first = entry.first && entry.first.card ? entry.first.card.id : null;

		return {...entry, truth: outcome.kind === 'saved' && outcome.card ? outcome.card : first};
	});
}

// A data URL's bytes.
export const dataUrlBytes = (url) => Buffer.from(String(url).split(',')[1] || '', 'base64');

export const median = (values) => {
	const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);

	return v.length ? v[Math.floor((v.length - 1) / 2)] : null;
};

export const percentile = (values, p) => {
	const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);

	return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : null;
};

export const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : 'n/a');
