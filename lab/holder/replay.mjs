// Detection replay: a holder video through the scanner's drop detection,
// crop, and picture match, at the app's frame-loop rate (lab/holder/README.md).
//
// node lab/holder/replay.mjs <video> --labels <labels.json> [--mode v35|v36|v40|v64]
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
// --mode v36: drop.js createDropDetector and the capture it plans
// (drop.js dropCapture), then identify.js identifyPicture. --mode v40:
// version 36's loop with version 40's content check (createV40); a drop
// answered with the repeat bar instead of a capture is "asked". --mode v64
// (default): version 40's loop, where a capture that reads out of focus
// waits up to drop.js RETRY_MS for a sharper still look of its spot, is
// added from that look, logged as a repeat or as gone, or added blurred,
// marked to check when its match is not sure; a card dropped on a waiting
// one is its own card (createV64, view.js captureDrop).
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
	console.error('node lab/holder/replay.mjs <video> --labels <labels.json> [--mode v35|v36|v40|v64]');
	process.exit(1);
}

const repo = resolve(opts.repo || REPO);
const mode = String(opts.mode || 'v64');
const fps = Number(opts.fps || 8);
const busy = Number(opts.busy || 0);
const [stageW, stageH] = String(opts.stage || '384x470').split('x').map(Number);
const labels = opts.labels ? JSON.parse(readFileSync(opts.labels, 'utf8')) : {drops: [], reframes: [], segments: []};
const load = (path) => import(pathToFileURL(join(repo, path)).href);

const steady = await load('js/scan/steady.js');
const camera = await load('js/scan/camera.js');
const identifyMod = await load('js/scan/identify.js');
const picture = await load('js/scan/picture.js');
const drop = mode === 'v35' ? null : await load('js/scan/drop.js');

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

// ------------------------------------------------------------ version 40

// view.js holderTick of version 40: version 36's loop, without the "moved"
// skip, with the content check (drop.js contentCheck, contentAt): the same
// picture as the last card is nothing after a nudge, or the repeat bar
// ("repeat bar" in the notes) after a disturbance like a drop's, and a new
// picture where the last card lay is taken even when what changed is no
// card's shape.
function createV40() {
	const detector = drop.createDropDetector();
	const recent = [];
	let last = null;
	let pending = null;

	const plan = (frame, area, view, change) => {
		const fine = viewFrame(frame, area.view, steady.FIND_SIDE_CAPTURE);

		return {...drop.dropCapture(change, view, fine, steady.findCard(fine.grey, fine.width, fine.height), {frame, last}), fine};
	};

	const take = (frame, change, planned, step, content, at) => {
		recent.push(planned.sharpness);

		if (recent.length > 5) {
			recent.shift();
		}

		last = {...drop.takenCard(last, planned.card), at, fresh: false, print: content.print, quad: content.quad};

		return {capture: {change, content, frame: grabFrame(frame, planned.region), identify: (image) => identifyMod.identifyPicture(image, {quads: planned.quads}), plan: planned, region: planned.region, settleMs: step.still, sharpness: planned.sharpness}};
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

					return planned.skip ? {note: planned.skip} : take(frame, held.change, planned, held.step, drop.contentCheck(planned, planned.fine, last), at);
				}

				return {note: null};
			}

			if (!step.change) {
				return {motion: step.motion, note: null};
			}

			const disturbed = drop.asksRepeat(step.burst, last);

			if (!step.drop) {
				const fine = step.burst && ['none', 'small', 'shape'].includes(step.change.kind) ? viewFrame(frame, area.view, steady.FIND_SIDE_CAPTURE) : null;
				const content = fine ? drop.contentAt(last, fine) : null;

				if (content && content.verdict === 'new') {
					const spot = {...drop.planCapture(last.quad, [], view, fine, steady.findCard(fine.grey, fine.width, fine.height), {frame, sharpBox: drop.boxOf(last.quad.map(drop.toView(view)))}), fine};

					return take(frame, step.change, spot, step, {...drop.contentCheck(spot, fine, null), distance: content.distance, verdict: 'new on the same spot'}, at);
				}

				if (content && content.verdict === 'same' && disturbed) {
					return {burst: step.burst, change: step.change, content, motion: step.motion, note: 'repeat bar'};
				}

				if (step.change.kind === 'none' && !step.burst && last && last.quad && !last.fresh) {
					const now = viewFrame(frame, area.view, steady.FIND_SIDE_CAPTURE);

					last.fresh = true;
					last.print = drop.printOf(now.grey, now.width, now.height, last.quad.map(drop.toView(now)));
				}

				return {change: step.change, content, motion: step.motion, note: step.change.kind};
			}

			const planned = plan(frame, area, view, step.change);

			if (planned.skip) {
				return {change: step.change, note: planned.skip};
			}

			const content = drop.contentCheck(planned, planned.fine, last);

			if (content.verdict === 'same') {
				last = {...last, print: content.match.print, quad: content.match.quad};

				return {burst: step.burst, change: step.change, content, note: disturbed ? 'repeat bar' : 'same card'};
			}

			if (!drop.sharpEnough(planned.sharpness, recent)) {
				pending = {change: step.change, step, until: at + drop.SHARP_WAIT_MS};

				return {note: 'held for a sharper frame'};
			}

			return take(frame, step.change, planned, step, content, at);
		},
	};
}

// ------------------------------------------------------------ version 64

// view.js holderTick of version 64: version 40's loop unchanged (the base
// moves on every still look), with each capture it decides on going
// through captureDrop: sharp (drop.js captureFocus), it is taken at once; out
// of focus, its frame is cut and kept, and each still look after it judges
// its spot (drop.js retryVerdict, view.js retryTick) for at most RETRY_MS:
// 'sharp' takes that look, 'repeat' and 'gone' take nothing (notes), and
// with no answer in time, or another card elsewhere, the kept frame is
// taken, marked blurred. A tick can then give two captures (captures).
function createV64() {
	const detector = drop.createDropDetector();
	const recent = [];
	let last = null;
	let pending = null;
	let retry = null;

	const plan = (frame, area, view, change) => {
		const fine = viewFrame(frame, area.view, steady.FIND_SIDE_CAPTURE);

		return {...drop.dropCapture(change, view, fine, steady.findCard(fine.grey, fine.width, fine.height), {frame, last}), fine};
	};

	const take = (frame, change, planned, step, content, at, {blurred = false, check = false, grabbed = null, over = null, retried = null, thumb = null} = {}) => {
		recent.push(planned.sharpness);

		if (recent.length > 5) {
			recent.shift();
		}

		const capture = {blurred, change, check, content, focus: planned.focus || null, frame: grabbed || grabFrame(frame, planned.region), identify: (image) => identifyMod.identifyPicture(image, {quads: planned.quads}), lookAt: retried ? at - retried.ms : at, plan: planned, region: planned.region, retried, settleMs: step.still, sharpness: planned.sharpness};

		last = {...drop.takenCard(last, planned.card), at, capture, flushed: blurred, fresh: false, over: blurred ? over : null, print: content.print, quad: content.quad, thumb: blurred ? thumb : (planned.fine ? drop.thumbAt(planned.fine, content.quad) : null)};

		return capture;
	};

	// view.js flushRetry: a capture, or null when it is logged as a repeat.
	const flush = (reason, at) => {
		const held = retry;

		retry = null;

		const hand = Boolean(held) && held.plan.focus.blur > drop.HAND_BLUR;

		if (!held || (held.underPrev && (reason !== 'time' || hand))) {
			if (held) {
				notes.push({note: 'retry: repeat (under the hand)', t: at / 1000});
			}

			return null;
		}

		return take(null, held.change, held.plan, held.step, held.content, at, {blurred: true, check: reason !== 'time' || hand, grabbed: held.grabbed, over: held.prev, retried: {ms: Math.round(at - held.at), reason, verdict: 'kept blurred'}, thumb: held.thumb});
	};

	// view.js captureDrop: {captures, note}.
	const capture = (frame, change, planned, step, content, before, at, byPicture = false) => {
		const fine = planned.fine;
		const quads = [drop.planQuads(planned, fine, 1)[0].map(drop.fromView(fine)), planned.card.corners];
		const focus = drop.captureFocus(fine, quads.map((quad) => quad.map(drop.toView(fine))));
		const withFocus = {...planned, focus};
		const box = drop.boxOf(planned.card.corners);
		const out = [];

		if (retry) {
			const held = retry;
			const near = drop.contentCheck(withFocus, fine, {print: held.content.print, quad: held.content.quad});
			const spot = drop.sameSpot(box, held.box) ? drop.spotVerdict({fell: drop.disturbedBy(step.burst), landed: true, print: near.match ? near.match.print : near.print, same: drop.sameCardThere(held.thumb, drop.thumbAt(fine, held.quads[0])), sharp: !focus.why, waiting: held.content.print}) : null;

			if (spot === 'settled') {
				retry = null;

				return {captures: [take(frame, change, withFocus, step, content, at, {retried: {ms: Math.round(at - held.at), verdict: 'retaken'}})], note: null};
			}

			if (spot === 'second copy') {
				return {captures: [flush('same card dropped on it', at)], note: 'repeat bar'};
			}

			if (spot === 'waiting') {
				held.folded++;

				return {captures: out, note: 'blurred, waiting'};
			}

			out.push(flush('next card', at));
		}

		if (!focus.why) {
			// view.js captureDrop: sharp where a blurred capture was just added.
			const flushed = last && last.flushed && last.quad && drop.sameSpot(box, drop.boxOf(last.quad)) ? last : null;
			const under = flushed && flushed.over ? drop.contentCheck(withFocus, fine, flushed.over) : null;

			if (under && under.verdict === 'same') {
				last = {...flushed.over, print: under.match.print, quad: under.match.quad};

				return {captures: out, note: 'retry: repeat'};
			}

			if (flushed && flushed.thumb && flushed.capture && drop.sameCardThere(flushed.thumb, drop.thumbAt(fine, flushed.quad))) {
				// Its sharp look takes the blurred one's place.
				flushed.capture.replaced = true;

				if (flushed.capture.row) {
					flushed.capture.row.replaced = true;
				}

				out.push(take(frame, change, withFocus, step, content, at, {retried: {ms: 0, verdict: 'retaken after adding'}}));

				return {captures: out, note: 'retry: replaced'};
			}

			out.push(take(frame, change, withFocus, step, content, at));

			return {captures: out, note: null};
		}

		const prev = last;

		retry = {at, before, box, byPicture, change, content, folded: 0, grabbed: grabFrame(frame, planned.region), landed: false, plan: withFocus, prev, quads, step, thumb: drop.thumbAt(fine, quads[0]), underPrev: Boolean(prev && prev.thumb && prev.quad) && drop.revealedIn(drop.thumbAt(fine, prev.quad), prev.thumb), until: at + drop.RETRY_MS};

		return {captures: out, note: `blurred (${focus.why} ${focus.blur.toFixed(2)})`};
	};

	// view.js retryTick: {captures, note, consumed}.
	const retryTick = (frame, area, view, step, at) => {
		if (!retry) {
			return null;
		}

		if (step.change) {
			const fine = viewFrame(frame, area.view, steady.FIND_SIDE_CAPTURE);
			const held = retry;
			const spotBox = drop.boxOf(held.quads[1].map(drop.toView(view)));
			const focus = drop.captureFocus(fine, held.quads.map((quad) => quad.map(drop.toView(fine))));
			const stir = drop.regionStir(detector.base, held.before, spotBox);
			let planned = null;

			if (step.drop && drop.sameSpot(drop.boxOf(step.change.corners), spotBox)) {
				held.landed = true;
			}
			else if (step.burst && ['none', 'small', 'shape'].includes(step.change.kind) && held.prev && held.prev.quad && drop.sameSpot(drop.boxOf(held.prev.quad.map(drop.toView(view))), spotBox)) {
				const there = drop.contentAt(held.prev, fine);

				held.landed = held.landed || Boolean(there && there.verdict === 'new');
			}

			let content = null;

			if (!focus.why) {
				planned = {...drop.planCapture(held.quads[1], [], view, fine, steady.findCard(fine.grey, fine.width, fine.height), {frame, sharpBox: spotBox}), fine, focus};
				content = drop.contentCheck(planned, fine, held.prev);
			}

			const verdict = drop.retryVerdict({byPicture: held.byPicture, content, focus, stir});
			const consumedBy = () => !(step.drop && !drop.sameSpot(drop.boxOf(step.change.corners), spotBox));

			const near = planned ? drop.contentCheck(planned, fine, {print: held.content.print, quad: held.content.quad}) : null;

			const other = verdict === 'sharp' && drop.landedOn({landed: true, print: near.match ? near.match.print : near.print, same: drop.sameCardThere(held.thumb, drop.thumbAt(fine, held.quads[0])), waiting: held.content.print});

			if (other && !held.landed) {
				return {captures: [flush('left the spot', at)], consumed: false, note: 'retry: left the spot'};
			}

			if (other) {
				const first = flush('next card', at);
				const dropped = step.drop && drop.sameSpot(drop.boxOf(step.change.corners), spotBox) ? plan(frame, area, view, step.change) : null;
				const own = dropped && !dropped.skip ? dropped : planned;

				return {captures: [first, take(frame, dropped && !dropped.skip ? step.change : held.change, own, step, drop.contentCheck(own, own.fine, last), at)], consumed: consumedBy(), note: 'retry: another card landed'};
			}

			if (verdict) {
				retry = null;

				const consumed = !(step.drop && !drop.sameSpot(drop.boxOf(step.change.corners), spotBox));

				if (verdict === 'sharp') {
					return {captures: [take(frame, held.change, planned, held.step, content, at, {retried: {ms: Math.round(at - held.at), verdict}})], consumed, note: null};
				}

				if (verdict === 'repeat' && held.prev && content.match) {
					held.prev.print = content.match.print;
					held.prev.quad = content.match.quad;
				}

				return {captures: [], consumed, note: verdict === 'repeat' ? 'retry: repeat' : 'retry: gone'};
			}
		}

		if (at >= retry.until) {
			return {captures: [flush('time', at)], consumed: false, note: null};
		}

		return null;
	};

	return {
		reframe() {
			const out = flush('reframe', 0);

			detector.reframe();
			last = null;
			pending = null;
			recent.length = 0;

			return out;
		},
		tick(frame, area, at) {
			const view = viewFrame(frame, area.view, steady.FIND_SIDE);
			const before = detector.base;
			const step = detector.push(view, at);

			if (pending) {
				const planned = plan(frame, area, view, pending.change);

				if (planned.skip || step.moving || at >= pending.until || drop.sharpEnough(planned.sharpness, recent)) {
					const held = pending;

					pending = null;

					return planned.skip ? {note: planned.skip} : capture(frame, held.change, planned, held.step, drop.contentCheck(planned, planned.fine, last), held.before, at);
				}

				return {note: null};
			}

			const retried = retryTick(frame, area, view, step, at);
			const early = retried ? retried.captures : [];

			if (retried && retried.consumed) {
				return {captures: early, note: retried.note};
			}

			const rest = (answer) => ({...answer, captures: [...early, ...(answer.captures || [])], note: answer.note ?? (retried && retried.note) ?? null});

			if (!step.change) {
				return rest({motion: step.motion, note: null});
			}

			const disturbed = drop.asksRepeat(step.burst, last);

			if (!step.drop) {
				const fine = step.burst && ['none', 'small', 'shape'].includes(step.change.kind) ? viewFrame(frame, area.view, steady.FIND_SIDE_CAPTURE) : null;
				const content = fine ? drop.contentAt(last, fine) : null;

				if (content && content.verdict === 'new') {
					const spot = {...drop.planCapture(last.quad, [], view, fine, steady.findCard(fine.grey, fine.width, fine.height), {frame, sharpBox: drop.boxOf(last.quad.map(drop.toView(view)))}), fine};

					return rest(capture(frame, step.change, spot, step, {...drop.contentCheck(spot, fine, null), distance: content.distance, verdict: 'new on the same spot'}, before, at, true));
				}

				if (content && content.verdict === 'same' && disturbed) {
					return rest({burst: step.burst, change: step.change, content, motion: step.motion, note: 'repeat bar'});
				}

				if (step.change.kind === 'none' && !step.burst && last && last.quad && !last.fresh && !retry) {
					const now = viewFrame(frame, area.view, steady.FIND_SIDE_CAPTURE);

					last.fresh = true;
					last.print = drop.printOf(now.grey, now.width, now.height, last.quad.map(drop.toView(now)));
					last.thumb = drop.thumbAt(now, last.quad);
				}

				return rest({change: step.change, content, motion: step.motion, note: step.change.kind});
			}

			const planned = plan(frame, area, view, step.change);

			if (planned.skip) {
				return rest({change: step.change, note: planned.skip});
			}

			const content = drop.contentCheck(planned, planned.fine, last);

			if (content.verdict === 'same') {
				// In place, as view.js does: a waiting capture's card before is
				// this object.
				last.print = content.match.print;
				last.quad = content.match.quad;

				return rest({burst: step.burst, change: step.change, content, note: disturbed ? 'repeat bar' : 'same card'});
			}

			if (!drop.sharpEnough(planned.sharpness, recent)) {
				pending = {before, change: step.change, step, until: at + drop.SHARP_WAIT_MS};

				return rest({note: 'held for a sharper frame'});
			}

			return rest(capture(frame, step.change, planned, step, content, before, at));
		},
	};
}

// ------------------------------------------------------------ the replay

const info = videoInfo(videoPath);
const frameSize = {height: info.height, width: info.width};
const area = camera.layoutGuide(frameSize, {height: stageH, width: stageW});
const loop = mode === 'v35' ? createV35() : mode === 'v36' ? createV36() : mode === 'v40' ? createV40() : createV64();
const reframes = [...(labels.reframes || [])].sort((a, b) => a - b);
const captures = [];
const notes = [];
const cropsDir = opts.crops ? outside(opts.crops) : null;
let blockedUntil = -Infinity;

if (cropsDir) {
	mkdirSync(cropsDir, {recursive: true});
}

for await (const {image, t} of videoFrames(videoPath, {fps})) {
	const flushed = [];

	while (reframes.length && reframes[0] <= t) {
		reframes.shift();

		const out = loop.reframe();

		if (out) {
			flushed.push(out);
		}
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

			console.log(`${t.toFixed(2)}s ${step.note} share=${(c.share || 0).toFixed(3)}${c.rect ? ` rect=${Math.round(c.rect.w)}x${Math.round(c.rect.h)} fill=${(c.fill || 0).toFixed(2)} flat=${(c.flat || 0).toFixed(2)}` : ''}${step.content ? ` print=${step.content.distance ?? '-'} ${step.content.verdict}` : ''}${step.burst ? ` burst=${step.burst.frames}x${step.burst.peak.toFixed(1)}` : ''}`);
		}
	}

	for (const capture of [...flushed, ...(step.captures || []), ...(step.capture ? [step.capture] : [])].filter(Boolean)) {
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
			// Version 64: added blurred (marked to check when not sure); how
			// a blurred capture's wait ended; its focus.
			blurred: Boolean(capture.blurred),
			check: Boolean(capture.check),
			// The look that first decided to take it (a blurred capture's, when
			// it waited): the drop it belongs to is told by this time.
			dropT: typeof capture.lookAt === 'number' ? Math.round(capture.lookAt) / 1000 : null,
			focus: capture.focus ? {blur: Math.round(capture.focus.blur * 100) / 100, texture: Math.round(capture.focus.texture * 100) / 100, why: capture.focus.why} : null,
			retried: capture.retried || null,
		};

		capture.row = row;
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
			console.log(`${row.t.toFixed(2)}s capture ${row.top[0] || '-'} d=${row.distance} gap=${row.gap} ${row.sure ? 'sure' : row.clear ? 'clear' : 'unsure'} ${pictureMs} ms ${row.how || ''}${capture.plan && capture.change.rect && capture.change.cover !== undefined ? ` agree=${capture.plan.agree} cover=${capture.change.cover.toFixed(2)} rect=${Math.round(capture.change.rect.w)}x${Math.round(capture.change.rect.h)}@${capture.change.rect.angle} sharp=${capture.plan.sharpness} alike=${capture.change.alike}` : ''}${capture.content ? ` print=${capture.content.distance ?? '-'} ${capture.content.verdict}` : ''}${capture.focus ? ` focus=${capture.focus.blur.toFixed(2)}/${capture.focus.texture.toFixed(2)}` : ''}${capture.retried ? ` retried=${capture.retried.verdict}${capture.retried.reason ? `(${capture.retried.reason})` : ''} ${capture.retried.ms} ms` : ''}${capture.blurred ? ' BLURRED' : ''}`);
		}
	}
}

// ------------------------------------------------------------ scoring

const drops = (labels.drops || []).map((d, i) => ({...d, asked: 0, captures: [], i}));

// The repeat bar (version 40) belongs to the last drop that started before it.
for (const n of notes.filter((one) => one.note === 'repeat bar')) {
	const owner = [...drops].reverse().find((d) => d.start <= n.t + 0.01);

	if (owner) {
		owner.asked++;
	}
}

// Version 64: a blurred capture whose sharp look later took its place is
// not a card in the tray.
const kept = captures.filter((c) => !c.replaced);

for (const c of kept) {
	const owner = [...drops].reverse().find((d) => d.start <= (c.dropT ?? c.t) + 0.01);

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
		asked: ds.filter((d) => !d.captures.length && d.asked).length,
		captures: cs.length,
		double: ds.filter((d) => d.captures.length > 1).length,
		drops: ds.length,
		midFall: firsts.filter((c) => c.midFall).length,
		missed: ds.filter((d) => !d.captures.length && !d.asked).length,
		name,
		noticedOnce: ds.filter((d) => d.captures.length === 1).length,
		pictureMs: median(firsts.map((c) => c.pictureMs)),
		pictureP90: percentile(firsts.map((c) => c.pictureMs), 0.9),
		right: labelled.filter((c) => c.right).length,
		labelled: labelled.length,
		// Added blurred and not sure, or flushed by another card or leaving:
		// marked to check (session.js blocker).
		marked: cs.filter((c) => c.blurred && (!c.sure || c.check)).length,
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
console.log('| Segment | Drops | Noticed once | Asked (repeat bar) | Missed | Double | Mid-fall | Marked to check | Sure | Unsure | Right / labelled | Wrong but sure | Picture ms (median, p90) |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');

for (const r of rows) {
	console.log(`| ${r.name} | ${r.drops} | ${r.noticedOnce} | ${r.asked} | ${r.missed} | ${r.double} | ${r.midFall} | ${r.marked} | ${r.sure} | ${r.unsure} (${pct(r.unsure, r.sure + r.unsure)}) | ${r.right} / ${r.labelled} | ${r.wrongSure} | ${r.pictureMs}, ${r.pictureP90} |`);
}

if (extra.length) {
	console.log(`\nCaptures before the first labelled drop: ${extra.length}`);
}

// Version 64: how each blurred capture's wait ended.
if (mode === 'v64') {
	const ends = {};

	for (const n of notes) {
		const key = n.note.startsWith('blurred (') ? 'blurred, waited' : n.note;

		if (key.startsWith('retry: ') || key.startsWith('blurred')) {
			ends[key] = (ends[key] || 0) + 1;
		}
	}

	for (const c of captures.filter((one) => one.retried)) {
		const key = `added: ${c.retried.verdict}${c.retried.reason ? ` (${c.retried.reason})` : ''}`;

		ends[key] = (ends[key] || 0) + 1;
	}

	console.log(`\nBlurred captures: ${JSON.stringify(ends)}`);
}

if (opts.verbose) {
	for (const d of drops) {
		console.log(`drop ${String(d.i).padStart(2)} ${d.start.toFixed(2)}-${d.settle.toFixed(2)}s ${(d.card || '?').padEnd(12)} ${d.captures.map((c) => `${c.t.toFixed(2)}s ${c.top[0] || '-'} ${c.sure ? 'sure' : 'unsure'} d=${c.distance}${c.midFall ? ' MID-FALL' : ''}${c.right === false ? ' WRONG' : ''}`).join(' | ') || (d.asked ? 'ASKED' : 'MISSED')}`);
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
