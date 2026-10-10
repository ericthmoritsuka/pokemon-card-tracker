// Detection replay: a holder video through the scanner's drop detection,
// crop, and picture match, at the app's frame-loop rate (lab/holder/README.md).
//
// node lab/holder/replay.mjs <video> --labels <labels.json> [--mode v35|v36]
//   [--repo <checkout>] [--fps 8] [--stage 384x470] [--busy 0]
//   [--out <results.json>] [--crops <dir>] [--verbose]
//
// The video stands in for the camera: each frame, at --fps, is the camera
// frame, the part of it the screen shows (camera.js layoutGuide with the
// stage size of Eric's phone) is what the frame loop looks at, and a
// capture is cut from the frame itself (the video's resolution, not the
// phone's: crops here are softer than the app's, so the picture results are
// a lower bound).
//
// --mode v35: the frame loop of version 35 in holder mode (view.js
// startLoop, look, capture): findCard on every frame, steady.js
// createHolderCapture, and identify.js identify on each capture.
// --mode v36 (default): drop.js createDropDetector and the capture it plans
// (drop.js dropCapture), then identify.js identifyPicture.
//
// --busy N holds the frame loop for N times the time the capture took here
// (synchronous work on the phone's main thread blocks the loop; about 4 for
// a mid-range phone), so a slow capture can miss what follows.
//
// Labels (label.mjs, then edited by hand): {drops: [{start, settle, card}],
// segments: [{name, from, to, light, zoom, speed}], reframes: [seconds]}.
// A capture belongs to the last drop that started before it; one taken
// before that drop's settle time is mid-fall; a second capture of one drop
// is double; a drop with none is missed. OCR is never run: the picture
// stage alone is measured.

import {register} from 'node:module';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

import {args as parseArgs, encodeJpeg, median, outside, pct, percentile, REPO, videoFrames, videoInfo} from './lib.mjs';

register('./no-ocr.mjs', import.meta.url);

const opts = parseArgs();
const videoPath = opts._[0];

if (!videoPath) {
	console.error('node lab/holder/replay.mjs <video> --labels <labels.json> [--mode v35|v36]');
	process.exit(1);
}

const repo = resolve(opts.repo || REPO);
const mode = String(opts.mode || 'v36');
const fps = Number(opts.fps || 8);
const busy = Number(opts.busy || 0);
const [stageW, stageH] = String(opts.stage || '384x470').split('x').map(Number);
const labels = opts.labels ? JSON.parse(readFileSync(opts.labels, 'utf8')) : {drops: [], reframes: [], segments: []};
const load = (path) => import(pathToFileURL(join(repo, path)).href);

const steady = await load('js/scan/steady.js');
const camera = await load('js/scan/camera.js');
const identifyMod = await load('js/scan/identify.js');
const picture = await load('js/scan/picture.js');
const drop = mode === 'v36' ? await load('js/scan/drop.js') : null;

// The index, read from the checkout rather than fetched.
await picture.loadFingerprints({fetchImpl: async () => ({arrayBuffer: async () => {
	const bytes = readFileSync(join(repo, 'js/vision/index.bin'));

	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}, ok: true})});

// ------------------------------------------------------------ the camera

// A rect of the frame averaged down to w x h, RGBA.
function resize(frame, rect, w, h) {
	const out = new Uint8ClampedArray(w * h * 4);
	const sx = rect.w / w;
	const sy = rect.h / h;

	for (let y = 0; y < h; y++) {
		const y0 = Math.floor(rect.y + y * sy);
		const y1 = Math.max(y0 + 1, Math.min(frame.height, Math.floor(rect.y + (y + 1) * sy)));

		for (let x = 0; x < w; x++) {
			const x0 = Math.floor(rect.x + x * sx);
			const x1 = Math.max(x0 + 1, Math.min(frame.width, Math.floor(rect.x + (x + 1) * sx)));
			let r = 0;
			let g = 0;
			let b = 0;
			let n = 0;

			for (let yy = y0; yy < y1; yy++) {
				for (let xx = x0; xx < x1; xx++) {
					const i = (yy * frame.width + xx) * 4;

					r += frame.data[i];
					g += frame.data[i + 1];
					b += frame.data[i + 2];
					n++;
				}
			}

			const o = (y * w + x) * 4;

			out[o] = r / n;
			out[o + 1] = g / n;
			out[o + 2] = b / n;
			out[o + 3] = 255;
		}
	}

	return out;
}

const fits = (frame, rect) => rect && rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= frame.width && rect.y + rect.h <= frame.height;

// camera.js viewFrame, thumbnailFrame, and grabFrame over a decoded frame.
function viewFrame(frame, rect, side) {
	const area = fits(frame, rect) ? rect : {h: frame.height, w: frame.width, x: 0, y: 0};
	const scale = Math.min(1, side / Math.max(area.w, area.h));
	const w = Math.max(1, Math.round(area.w * scale));
	const h = Math.max(1, Math.round(area.h * scale));

	return {grey: steady.toGrey(resize(frame, area, w, h), w, h), height: h, rect: area, scale: w / area.w, width: w};
}

function thumbnailFrame(frame, rect) {
	const area = fits(frame, rect) ? rect : camera.defaultCapture(frame.width, frame.height);
	const rgba = resize(frame, area, steady.THUMB_W, steady.THUMB_H);

	return {colour: steady.colourfulness(rgba, steady.THUMB_W, steady.THUMB_H), grey: steady.toGrey(rgba, steady.THUMB_W, steady.THUMB_H)};
}

function grabFrame(frame, rect) {
	const area = fits(frame, rect) ? rect : camera.defaultCapture(frame.width, frame.height);
	const data = new Uint8ClampedArray(area.w * area.h * 4);

	for (let y = 0; y < area.h; y++) {
		data.set(frame.data.subarray(((area.y + y) * frame.width + area.x) * 4, ((area.y + y) * frame.width + area.x + area.w) * 4), y * area.w * 4);
	}

	return {data, height: area.h, width: area.w};
}

// ------------------------------------------------------------ version 35

const MIN_CARD_SHARE = 0.5;
const SAME_BOX = 0.06;
const sameBox = (a, b, share = SAME_BOX) => Boolean(a && b) && ['x', 'y', 'w', 'h'].every((key) => Math.abs(a[key] - b[key]) <= share * Math.max(a.w, a.h, b.w, b.h));

function overlap(a, b) {
	if (!a || !b) {
		return 0;
	}

	const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
	const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

	return (w * h) / (a.w * a.h + b.w * b.h - w * h);
}

const samePlace = (a, b) => sameBox(a, b) || overlap(a, b) >= 0.85;

function createV35() {
	const holderDetector = steady.createHolderCapture();
	let stableBox = null;
	let lastHolder = null;

	// view.js look().
	function look(frame, area, {fine = false} = {}) {
		const view = viewFrame(frame, area.view, fine ? steady.FIND_SIDE_CAPTURE : steady.FIND_SIDE);
		const found = steady.findCard(view.grey, view.width, view.height);
		const toFrame = (p) => ({x: view.rect.x + p.x / view.scale, y: view.rect.y + p.y / view.scale});

		if (found.quad) {
			const all = [{angle: found.angle, corners: found.quad, ratio: found.ratio, upright: found.upright}, ...found.others]
				.map((one) => ({...one, box: camera.boxAround(frame, one.corners.map(toFrame)), corners: one.corners.map(toFrame)}));
			const chosen = (!fine && all.find((one) => samePlace(one.box, stableBox))) || all[0];
			const quad = chosen.corners;
			const long = (Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y) + Math.hypot(quad[2].x - quad[1].x, quad[2].y - quad[1].y)) / 2;
			const small = long < area.guide.h * MIN_CARD_SHARE;
			let box = chosen.box;

			if (!fine) {
				if (samePlace(box, stableBox)) {
					box = stableBox;
				}
				else {
					stableBox = box;
				}
			}

			const shot = thumbnailFrame(frame, box);
			const upright = chosen.upright && Math.abs(chosen.angle) <= 20;
			const judged = upright
				? steady.presence(shot.grey, steady.THUMB_W, steady.THUMB_H, {colour: shot.colour})
				: {detail: 99, glare: false, present: shot.colour >= steady.COLOURLESS, reason: null, small: false};

			if (judged.present) {
				const inBox = (c) => c.x >= box.x && c.y >= box.y && c.x <= box.x + box.w && c.y <= box.y + box.h;
				const others = all.filter((one) => one !== chosen && one.corners.every(inBox)).map(({angle, corners, ratio, upright: up}) => ({angle, corners, ratio, upright: up}));

				return {card: {angle: chosen.angle, box, others, quad, ratio: chosen.ratio, small, upright: chosen.upright}, seen: small ? {...judged, present: false, small: true} : judged, shot, touching: false, view};
			}
		}
		else if (!fine) {
			stableBox = null;
		}

		const shot = thumbnailFrame(frame, area.capture);

		return {card: null, seen: steady.presence(shot.grey, steady.THUMB_W, steady.THUMB_H, {colour: shot.colour}), shot, touching: found.touching, view};
	}

	const whole = (now) => Boolean(now && now.card && !now.card.small && now.seen.present);

	return {
		reframe() {
			holderDetector.reframe();
		},
		tick(frame, area, at) {
			const now = look(frame, area);
			const step = holderDetector.push(now.view.grey, now.view.width, now.view.height, {card: whole(now), touching: now.touching}, at);

			if (!step.capture) {
				return {note: step.pile ? 'pile' : null};
			}

			if (lastHolder && now.card && sameBox(now.card.box, lastHolder.box, 0.05) && steady.difference(steady.coarse(now.shot.grey), lastHolder.thumb) <= steady.CHANGED) {
				holderDetector.captured();

				return {note: 'same as last'};
			}

			// view.js capture('auto').
			const fineLook = look(frame, area, {fine: true});
			const chosen = fineLook && fineLook.card ? fineLook : now;
			const card = chosen.card && !chosen.card.small ? chosen.card : null;
			const region = card ? camera.boxAround(frame, [...card.quad, ...card.others.flatMap((o) => o.corners)]) : area.capture;

			holderDetector.captured();
			lastHolder = card ? {box: now.card ? now.card.box : card.box, thumb: steady.coarse(now.shot.grey)} : null;

			const guide = !card ? {h: area.guide.h, w: area.guide.w, x: area.guide.x - area.capture.x, y: area.guide.y - area.capture.y} : null;
			const quads = card ? [{...card, corners: card.quad}, ...card.others].map((q) => ({corners: q.corners.map((c) => ({x: c.x - region.x, y: c.y - region.y})), ratio: q.ratio, upright: q.upright})) : [];

			return {capture: {frame: grabFrame(frame, region), identify: (image) => identifyMod.identify(image, {guide, quads}), region, settleMs: step.settleMs}};
		},
	};
}

// ------------------------------------------------------------ version 36

// view.js holderTick, planDrop, and takeDrop: the same drop.js calls, the
// sharpness hold included.
function createV36() {
	const detector = drop.createDropDetector();
	const recent = [];
	let last = null;
	let pending = null;

	const plan = (frame, area, view, change) => {
		const fine = viewFrame(frame, area.view, steady.FIND_SIDE_CAPTURE);

		return drop.dropCapture(change, view, fine, steady.findCard(fine.grey, fine.width, fine.height), {frame, last});
	};

	const take = (frame, change, planned, step) => {
		recent.push(planned.sharpness);

		if (recent.length > 5) {
			recent.shift();
		}

		last = drop.takenCard(last, planned.card);

		return {capture: {change, frame: grabFrame(frame, planned.region), identify: (image) => identifyMod.identifyPicture(image, {quads: planned.quads}), plan: planned, region: planned.region, settleMs: step.still, sharpness: planned.sharpness}};
	};

	return {
		reframe() {
			detector.reframe();
			last = null;
			pending = null;
			recent.length = 0;
		},
		tick(frame, area, at) {
			const view = viewFrame(frame, area.view, steady.FIND_SIDE);
			const step = detector.push(view, at);

			if (pending) {
				const planned = plan(frame, area, view, pending.change);

				if (planned.skip || step.moving || at >= pending.until || drop.sharpEnough(planned.sharpness, recent)) {
					const held = pending;

					pending = null;

					return planned.skip ? {note: planned.skip} : take(frame, held.change, planned, held.step);
				}

				return {note: null};
			}

			if (!step.change) {
				return {motion: step.motion, note: null};
			}

			if (!step.drop) {
				return {change: step.change, motion: step.motion, note: step.change.kind};
			}

			const planned = plan(frame, area, view, step.change);

			if (planned.skip) {
				return {change: step.change, note: planned.skip};
			}

			if (!drop.sharpEnough(planned.sharpness, recent)) {
				pending = {change: step.change, step, until: at + drop.SHARP_WAIT_MS};

				return {note: 'held for a sharper frame'};
			}

			return take(frame, step.change, planned, step);
		},
	};
}

// ------------------------------------------------------------ the replay

const info = videoInfo(videoPath);
const frameSize = {height: info.height, width: info.width};
const area = camera.layoutGuide(frameSize, {height: stageH, width: stageW});
const loop = mode === 'v35' ? createV35() : createV36();
const reframes = [...(labels.reframes || [])].sort((a, b) => a - b);
const captures = [];
const notes = [];
const cropsDir = opts.crops ? outside(opts.crops) : null;
let blockedUntil = -Infinity;

if (cropsDir) {
	mkdirSync(cropsDir, {recursive: true});
}

for await (const {image, t} of videoFrames(videoPath, {fps})) {
	while (reframes.length && reframes[0] <= t) {
		reframes.shift();
		loop.reframe();
	}

	if (t < blockedUntil) {
		continue;
	}

	const at = t * 1000;
	const started = performance.now();
	const step = loop.tick(image, area, at);
	const tickMs = performance.now() - started;

	if (step.note) {
		notes.push({note: step.note, t});

		if (opts.verbose && step.note !== 'none') {
			const c = step.change || {};

			console.log(`${t.toFixed(2)}s ${step.note} share=${(c.share || 0).toFixed(3)}${c.rect ? ` rect=${Math.round(c.rect.w)}x${Math.round(c.rect.h)} fill=${(c.fill || 0).toFixed(2)} flat=${(c.flat || 0).toFixed(2)}` : ''}`);
		}
	}

	if (step.capture) {
		const {capture} = step;
		const idStarted = performance.now();
		const result = await capture.identify(capture.frame);
		const pictureMs = Math.round(performance.now() - idStarted);
		const syncMs = performance.now() - started;
		const groups = result.picture ? result.picture.groups : [];
		const verdict = picture.pictureVerdict(result.picture);
		const row = {
			distance: groups[0] ? groups[0].score : null,
			gap: result.picture ? result.picture.gap : null,
			how: result.picture ? result.picture.how : null,
			pictureMs,
			timings: result.timings,
			region: capture.region,
			settleMs: capture.settleMs,
			sharpness: capture.sharpness ?? null,
			sure: verdict.sure,
			clear: verdict.clear,
			t: Math.round(t * 1000) / 1000,
			top: groups[0] ? groups[0].cards.map((c) => c.id) : [],
		};

		captures.push(row);

		// Version 35 matches on the main thread; version 36 in a worker, so
		// only the frame loop's own work holds it.
		if (busy) {
			blockedUntil = t + ((mode === 'v35' ? syncMs : tickMs) * busy) / 1000;
		}

		if (cropsDir && result.card) {
			encodeJpeg(result.card, join(cropsDir, `${mode}-${row.t.toFixed(2)}s.jpg`), 4);
		}

		if (opts.verbose) {
			console.log(`${row.t.toFixed(2)}s capture ${row.top[0] || '-'} d=${row.distance} gap=${row.gap} ${row.sure ? 'sure' : row.clear ? 'clear' : 'unsure'} ${pictureMs} ms ${row.how || ''}${capture.plan ? ` agree=${capture.plan.agree} cover=${capture.change.cover.toFixed(2)} rect=${Math.round(capture.change.rect.w)}x${Math.round(capture.change.rect.h)}@${capture.change.rect.angle} sharp=${capture.plan.sharpness} alike=${capture.change.alike}` : ''}`);
		}
	}
}

// ------------------------------------------------------------ scoring

const drops = (labels.drops || []).map((d, i) => ({...d, captures: [], i}));

for (const c of captures) {
	const owner = [...drops].reverse().find((d) => d.start <= c.t + 0.01);

	c.drop = owner ? owner.i : null;

	if (owner) {
		owner.captures.push(c);
		c.midFall = c.t < owner.settle - 0.05;
		c.right = owner.card ? c.top.includes(owner.card) : null;
	}
}

const segmentOf = (t) => (labels.segments || []).find((s) => t >= s.from && t < s.to) || {name: '-'};
const rows = [];

function summary(list, name, extra = {}) {
	const ds = list;
	const cs = ds.flatMap((d) => d.captures);
	const firsts = ds.filter((d) => d.captures.length).map((d) => d.captures[0]);
	const labelled = firsts.filter((c) => c.right !== null);

	return {
		captures: cs.length,
		double: ds.filter((d) => d.captures.length > 1).length,
		drops: ds.length,
		midFall: firsts.filter((c) => c.midFall).length,
		missed: ds.filter((d) => !d.captures.length).length,
		name,
		noticedOnce: ds.filter((d) => d.captures.length === 1).length,
		pictureMs: median(firsts.map((c) => c.pictureMs)),
		pictureP90: percentile(firsts.map((c) => c.pictureMs), 0.9),
		right: labelled.filter((c) => c.right).length,
		labelled: labelled.length,
		sure: firsts.filter((c) => c.sure).length,
		unsure: firsts.filter((c) => !c.sure).length,
		wrongSure: labelled.filter((c) => c.sure && !c.right).length,
		...extra,
	};
}

for (const seg of labels.segments || []) {
	const list = drops.filter((d) => segmentOf(d.settle).name === seg.name);
	const gaps = list.slice(1).map((d, k) => d.settle - list[k].settle);

	rows.push(summary(list, `${seg.name}: ${seg.light}, ${seg.zoom}, ${seg.speed}`, {gap: median(gaps)}));
}

rows.push(summary(drops, 'all'));

const extra = captures.filter((c) => c.drop === null);

console.log(`\n${videoPath.split('/').pop()}: mode ${mode}, ${fps} fps loop, stage ${stageW}x${stageH}, busy x${busy}`);
console.log('| Segment | Drops | Noticed once | Missed | Double | Mid-fall | Sure | Unsure | Right / labelled | Wrong but sure | Picture ms (median, p90) |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');

for (const r of rows) {
	console.log(`| ${r.name} | ${r.drops} | ${r.noticedOnce} | ${r.missed} | ${r.double} | ${r.midFall} | ${r.sure} | ${r.unsure} (${pct(r.unsure, r.sure + r.unsure)}) | ${r.right} / ${r.labelled} | ${r.wrongSure} | ${r.pictureMs}, ${r.pictureP90} |`);
}

if (extra.length) {
	console.log(`\nCaptures before the first labelled drop: ${extra.length}`);
}

if (opts.verbose) {
	for (const d of drops) {
		console.log(`drop ${String(d.i).padStart(2)} ${d.start.toFixed(2)}-${d.settle.toFixed(2)}s ${(d.card || '?').padEnd(12)} ${d.captures.map((c) => `${c.t.toFixed(2)}s ${c.top[0] || '-'} ${c.sure ? 'sure' : 'unsure'} d=${c.distance}${c.midFall ? ' MID-FALL' : ''}${c.right === false ? ' WRONG' : ''}`).join(' | ') || 'MISSED'}`);
	}

	const counts = {};

	for (const n of notes) {
		counts[n.note] = (counts[n.note] || 0) + 1;
	}

	console.log('notes', JSON.stringify(counts));
}

if (opts.out) {
	writeFileSync(outside(opts.out), JSON.stringify({captures, drops: drops.map(({captures: cs, ...d}) => ({...d, captures: cs.map((c) => c.t)})), mode, notes, rows}, null, 1));
}
