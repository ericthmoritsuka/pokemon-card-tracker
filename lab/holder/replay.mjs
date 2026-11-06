// Detection replay: a holder video through the scanner's drop detection,
// crop, and picture match, at the app's frame-loop rate (lab/holder/README.md).
//
// node lab/holder/replay.mjs <video> --labels <labels.json> [--mode v35|v36|v40|v62]
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
// answered with the repeat bar instead of a capture is "asked". --mode v62
// (default): version 40's, taking a drop only once it has settled
// (createV62, drop.js settleVerdict).
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
	console.error('node lab/holder/replay.mjs <video> --labels <labels.json> [--mode v35|v36|v40|v62]');
	process.exit(1);
}

const repo = resolve(opts.repo || REPO);
const mode = String(opts.mode || 'v62');
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

// ------------------------------------------------------------ version 62

// view.js holderTick of version 62: version 40's loop, where a drop is
// taken only once it has settled (drop.js settleVerdict: the card's part of
// the view still over the last looks, printed, and sharp, on the outline cut
// first and on what changed, the worse of the two). Until then it waits,
// the detector holding the picture before it (hold), and is judged again
// on each still look; a card dead still for SETTLE_PATIENCE_MS while it
// reads soft or plain is taken all the same, so is a sharp one still
// stirring after SETTLE_STIR_MS, and so is any that has waited
// SETTLE_LIMIT_MS (view.js waitToSettle). "waiting" in the notes.
function createV62() {
	const detector = drop.createDropDetector();
	let last = null;
	let pending = null;

	const plan = (frame, area, view, change) => {
		const fine = viewFrame(frame, area.view, steady.FIND_SIDE_CAPTURE);

		return {...drop.dropCapture(change, view, fine, steady.findCard(fine.grey, fine.width, fine.height), {frame, last}), fine};
	};

	// grabbed: the frame already cut for it (takeReady), or null.
	const take = (frame, change, planned, step, content, at, settle = null, grabbed = null) => {
		last = {...drop.takenCard(last, planned.card), at, fresh: false, print: content.print, quad: content.quad};

		return {capture: {change, content, frame: grabbed || grabFrame(frame, planned.region), identify: (image) => identifyMod.identifyPicture(image, {quads: planned.quads}), plan: planned, region: planned.region, settle, settleMs: step.still + (step.heldMs || 0), sharpness: planned.sharpness}};
	};

	// view.js releaseDrop.
	let afterWaitTake = false;

	const release = (box = null) => {
		const held = pending;

		pending = null;

		if (detector.held) {
			detector.release(box);
			afterWaitTake = Boolean(box);
		}

		return held;
	};

	// view.js settledAt.
	const settledAt = (places, view, fine) => {
		const stir = Math.max(...places.map((corners) => detector.stirIn(drop.grownBox(corners.map(drop.toView(view))))));
		const focus = places.map((corners) => drop.cardFocus(fine.grey, fine.width, fine.height, corners.map(drop.toView(fine)))).reduce((a, b) => ({blur: Math.max(a.blur, b.blur), texture: Math.min(a.texture, b.texture)}));

		return {blur: Math.round(focus.blur * 100) / 100, focusWhy: drop.focusVerdict(focus), limit: false, patience: false, stir: Math.round(stir * 1000) / 1000, texture: Math.round(focus.texture * 100) / 100, waited: [], why: drop.settleVerdict({focus, stir})};
	};

	// view.js waitToSettle: 'take', 'wait', or 'give up'; ready keeps the
	// frame cut at that look (frame) for takeReady.
	const waitToSettle = (held, step, at, settle, {edge = false, frame = null, ready = null, spot = false} = {}) => {
		const {why} = settle;

		settle.waited = held ? held.whys : [];
		delete settle.why;

		if (!why) {
			return 'take';
		}

		const still = why !== 'moving';

		if (!held) {
			pending = {at, ready: null, spot, step: {...step, at}, stillSince: still ? at : null, whys: [why]};
			detector.hold();
			settle.why = why;
		}
		else {
			pending = held;
			held.spot = held.spot || spot;

			if (!detector.held) {
				detector.hold();
			}

			if (!held.whys.includes(why)) {
				held.whys.push(why);
			}

			held.stillSince = still ? (held.stillSince ?? at) : null;
		}

		const wait = pending;
		const waited = at - wait.at;

		if (why === 'soft' && !edge && !wait.spot && ready) {
			wait.ready = wait.ready || {...ready, cells: detector.latest, grabbed: grabFrame(frame, ready.plan.region)};
		}
		else if (why !== 'soft' || edge) {
			wait.ready = null;
		}

		if (wait.spot) {
			return waited >= drop.SETTLE_LIMIT_MS ? 'give up' : 'wait';
		}

		if (why === 'moving' && !settle.focusWhy && !edge && waited >= drop.SETTLE_STIR_MS) {
			settle.limit = true;
		}
		else if (waited >= drop.SETTLE_LIMIT_MS) {
			if (edge || settle.focusWhy === 'plain') {
				return 'give up';
			}

			settle.limit = true;
		}
		else if (why === 'soft' && !edge && at - wait.stillSince >= drop.SETTLE_PATIENCE_MS) {
			settle.patience = true;
		}
		else {
			return 'wait';
		}

		wait.ready = null;

		return 'take';
	};

	// view.js takeReady.
	const takeReady = (held, at) => {
		const {box, cells, change, content, grabbed, plan: planned, settle} = held.ready;

		pending = null;
		detector.release(box, cells);
		afterWaitTake = true;

		return take(null, change, planned, {...held.step, heldMs: at - held.at}, content, at, {...settle, early: true, waited: held.whys}, grabbed);
	};

	// view.js giveUp.
	const giveUp = () => {
		release();

		return {note: 'unsettled'};
	};

	const nonDrop = (frame, area, view, step, at, held = null) => {
		const recheck = afterWaitTake;

		afterWaitTake = false;

		const fine = (step.burst || recheck) && ['none', 'small', 'shape'].includes(step.change.kind) ? viewFrame(frame, area.view, steady.FIND_SIDE_CAPTURE) : null;
		const content = fine ? drop.contentAt(last, fine) : null;

		if (content && content.verdict === 'new') {
			const spot = {...drop.planCapture(last.quad, [], view, fine, steady.findCard(fine.grey, fine.width, fine.height), {frame, sharpBox: drop.boxOf(last.quad.map(drop.toView(view)))}), fine};
			const settle = settledAt([last.quad], view, fine);
			const next = waitToSettle(held, step, at, settle, {spot: true});

			if (next === 'take') {
				release(drop.grownBox(last.quad.map(drop.toView(view))));

				return take(frame, step.change, spot, {...(held ? held.step : step), heldMs: held ? at - held.at : 0}, {...drop.contentCheck(spot, fine, null), distance: content.distance, verdict: 'new on the same spot'}, at, settle);
			}

			return next === 'give up' ? giveUp() : {note: held ? null : `waiting on the same spot (${settle.why})`, settle};
		}

		if (content && content.verdict === 'same' && drop.asksRepeat(step.burst, last)) {
			return {burst: step.burst, change: step.change, content, motion: step.motion, note: 'repeat bar'};
		}

		if (step.change.kind === 'none' && !step.burst && last && last.quad && !last.fresh) {
			const now = viewFrame(frame, area.view, steady.FIND_SIDE_CAPTURE);

			last.fresh = true;
			last.print = drop.printOf(now.grey, now.width, now.height, last.quad.map(drop.toView(now)));
		}

		return {change: step.change, content, motion: step.motion, note: step.change.kind};
	};

	const consider = (frame, area, view, step, at) => {
		const held = pending;

		afterWaitTake = false;
		const first = held ? held.step : step;
		const planned = plan(frame, area, view, step.change);

		if (planned.skip) {
			if (held) {
				held.stillSince = null;

				return at - held.at >= drop.SETTLE_LIMIT_MS ? (held.ready ? takeReady(held, at) : giveUp()) : {note: null};
			}

			return {change: step.change, note: planned.skip};
		}

		const content = drop.contentCheck(planned, planned.fine, last);

		if (content.verdict === 'same') {
			release();
			last = {...last, print: content.match.print, quad: content.match.quad};

			return {burst: first.burst, change: step.change, content, note: drop.asksRepeat(first.burst, last) ? 'repeat bar' : 'same card'};
		}

		const settle = settledAt([content.quad, planned.card.corners], view, planned.fine);
		const edge = drop.reachesEdge(step.change, view.width, view.height);
		const box = drop.grownBox(content.quad.map(drop.toView(view)));
		const next = waitToSettle(held, step, at, settle, {edge, frame, ready: {box, change: step.change, content, plan: planned, settle: {...settle}}});

		if (next === 'take') {
			release(box);

			return take(frame, step.change, planned, {...first, heldMs: held ? at - held.at : 0}, content, at, settle);
		}

		return next === 'give up' ? giveUp() : {change: step.change, content, note: held ? null : `waiting (${settle.why})`, settle};
	};

	return {
		reframe() {
			detector.reframe();
			last = null;
			pending = null;
		},
		tick(frame, area, at) {
			const view = viewFrame(frame, area.view, steady.FIND_SIDE);
			const step = detector.push(view, at);

			// view.js waitingLook.
			if (pending) {
				const held = pending;

				if (step.moving) {
					held.stillSince = null;

					if (held.ready) {
						return takeReady(held, at);
					}

					return at - held.at >= drop.SETTLE_LIMIT_MS ? giveUp() : {motion: step.motion, note: null};
				}

				if (!step.change) {
					return {note: null};
				}

				if (step.drop) {
					return consider(frame, area, view, step, at);
				}

				if (step.change.kind === 'none' || held.spot) {
					release();
					held.ready = null;

					return nonDrop(frame, area, view, {...step, burst: step.burst || held.step.burst}, at, held);
				}

				held.stillSince = null;

				if (at - held.at >= drop.SETTLE_LIMIT_MS) {
					return held.ready ? takeReady(held, at) : giveUp();
				}

				return {note: null};
			}

			if (!step.change) {
				return {motion: step.motion, note: null};
			}

			return step.drop ? consider(frame, area, view, step, at) : nonDrop(frame, area, view, step, at);
		},
	};
}

// ------------------------------------------------------------ the replay

const info = videoInfo(videoPath);
const frameSize = {height: info.height, width: info.width};
const area = camera.layoutGuide(frameSize, {height: stageH, width: stageW});
const loop = mode === 'v35' ? createV35() : mode === 'v36' ? createV36() : mode === 'v40' ? createV40() : createV62();
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

			console.log(`${t.toFixed(2)}s ${step.note}${step.settle ? ` settle=${JSON.stringify(step.settle)}` : ''} share=${(c.share || 0).toFixed(3)}${c.rect ? ` rect=${Math.round(c.rect.w)}x${Math.round(c.rect.h)} fill=${(c.fill || 0).toFixed(2)} flat=${(c.flat || 0).toFixed(2)}` : ''}${step.content ? ` print=${step.content.distance ?? '-'} ${step.content.verdict}` : ''}${step.burst ? ` burst=${step.burst.frames}x${step.burst.peak.toFixed(1)}` : ''}`);
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
			settle: capture.settle ?? null,
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
			console.log(`${row.t.toFixed(2)}s capture ${row.top[0] || '-'} d=${row.distance} gap=${row.gap} ${row.sure ? 'sure' : row.clear ? 'clear' : 'unsure'} ${pictureMs} ms ${row.how || ''}${capture.plan && capture.change.rect && capture.change.cover !== undefined ? ` agree=${capture.plan.agree} cover=${capture.change.cover.toFixed(2)} rect=${Math.round(capture.change.rect.w)}x${Math.round(capture.change.rect.h)}@${capture.change.rect.angle} sharp=${capture.plan.sharpness} alike=${capture.change.alike}` : ''}${capture.content ? ` print=${capture.content.distance ?? '-'} ${capture.content.verdict}` : ''}${capture.settle ? ` settle=${JSON.stringify(capture.settle)}` : ''}`);
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

for (const c of captures) {
	const owner = [...drops].reverse().find((d) => d.start <= c.t + 0.01);

	c.drop = owner ? owner.i : null;

	if (owner) {
		owner.captures.push(c);
		c.midFall = c.t < owner.settle - 0.05;
		c.waitMs = Math.round((c.t - owner.settle) * 1000);
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
		// From the labelled settle to the first capture: how long the card
		// waited once it lay still.
		settled: median(firsts.filter((c) => !c.midFall).map((c) => c.waitMs)),
		settledP90: percentile(firsts.filter((c) => !c.midFall).map((c) => c.waitMs), 0.9),
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
console.log('| Segment | Drops | Noticed once | Asked (repeat bar) | Missed | Double | Mid-fall | Sure | Unsure | Right / labelled | Wrong but sure | Picture ms (median, p90) | Settle to capture ms (median, p90) |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');

for (const r of rows) {
	console.log(`| ${r.name} | ${r.drops} | ${r.noticedOnce} | ${r.asked} | ${r.missed} | ${r.double} | ${r.midFall} | ${r.sure} | ${r.unsure} (${pct(r.unsure, r.sure + r.unsure)}) | ${r.right} / ${r.labelled} | ${r.wrongSure} | ${r.pictureMs}, ${r.pictureP90} | ${r.settled}, ${r.settledP90} |`);
}

if (extra.length) {
	console.log(`\nCaptures before the first labelled drop: ${extra.length}`);
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
