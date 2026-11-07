// Holder mode's drop detector (js/scan/drop.js, Eric, 2026-10-09, version
// 36) on drawn scenes, in Node: a phone still over a white box, cards
// falling in at the app's frame rate (one look every 125 ms), with what went
// wrong on Eric's real videos and logs drawn in: a card landing on the very
// spot of the last, a strip of the card beneath showing, a card turned, a
// smeared frame before a sharp one, a lamp flickering or moved, a hand
// passing over, a card lifted off, and his fast drop rhythm.
//
// Run: node --test tests/scan-drop.test.mjs

import assert from 'node:assert/strict';
import test, {describe} from 'node:test';

import * as D from '../js/scan/drop.js';

// The view the frame loop looks at: 120 x 200 grey (FIND_SIDE on the long
// side). The box: a white floor with grey walls running out to the edges.
const W = 120;
const H = 200;
const FRAME_MS = 125;

// A card's face as a function of (u, v) in 0..1: a silver border, a
// picture box of blocks seeded by the card, and lines of text below.
function face(seed) {
	let s = seed * 9973 + 17;
	const rand = () => {
		s = (s * 16807) % 2147483647;

		return s / 2147483647;
	};
	const blocks = Array.from({length: 48}, () => 40 + rand() * 180);
	const tint = 120 + rand() * 80;

	return (u, v) => {
		if (u < 0.045 || u > 0.955 || v < 0.035 || v > 0.965) {
			return 185;
		}

		if (v > 0.11 && v < 0.52 && u > 0.08 && u < 0.92) {
			const bx = Math.floor(((u - 0.08) / 0.84) * 8);
			const by = Math.floor(((v - 0.11) / 0.41) * 6);

			return blocks[by * 8 + bx];
		}

		if (v > 0.6 && v < 0.9 && Math.floor(v * 60) % 4 === 0 && u > 0.12 && u < 0.85) {
			return 60;
		}

		return tint;
	};
}

const FACES = [face(1), face(2), face(3), face(4), face(5), face(6)];

// Draws a scene: {cards: [{face, cx, cy, h, angle}], light, hand, smear}.
// cx, cy, h are shares of the view (h of its height); light scales every
// pixel (a lamp flickering, the camera re-exposing); lampSide brightens one
// side (a lamp moved); hand is a dark disc {x, y, r}; smear draws each card
// at several positions along dy (motion blur).
function render({cards = [], hand = null, lampSide = 0, light = 1} = {}) {
	const grey = new Uint8Array(W * H);

	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const wall = x < W * 0.1 || x > W * 0.9 || y < H * 0.08 || y > H * 0.92;
			let v = wall ? 205 : 238;
			let hit = 0;
			let sum = 0;

			for (const card of cards) {
				const samples = card.smear ? 5 : 1;
				let inside = 0;
				let value = 0;

				for (let k = 0; k < samples; k++) {
					const cy = card.cy + (card.smear ? (k / (samples - 1) - 0.5) * card.smear : 0);
					const ch = card.h * H;
					const cw = ch * (63 / 88);
					const a = ((card.angle || 0) * Math.PI) / 180;
					const dx = x + 0.5 - card.cx * W;
					const dy = y + 0.5 - cy * H;
					const u = (dx * Math.cos(a) + dy * Math.sin(a)) / cw + 0.5;
					const t = (-dx * Math.sin(a) + dy * Math.cos(a)) / ch + 0.5;

					if (u >= 0 && u <= 1 && t >= 0 && t <= 1) {
						inside++;
						value += card.face(u, t);
					}
				}

				if (inside) {
					// Later cards cover earlier ones.
					hit = inside / samples;
					sum = value / inside;
				}
			}

			if (hit) {
				v = v * (1 - hit) + sum * hit;
			}

			if (hand && (x - hand.x * W) ** 2 + (y - hand.y * H) ** 2 < (hand.r * W) ** 2) {
				v = 70;
			}

			v *= light * (1 + lampSide * (x / W - 0.5));
			grey[y * W + x] = Math.max(0, Math.min(255, Math.round(v)));
		}
	}

	return {grey, height: H, width: W};
}

// Runs scenes through a detector: each step is a scene shown for `ms`.
// Returns the drops seen ({at, change}) and every change judged.
function run(steps, detector = D.createDropDetector()) {
	const drops = [];
	const judged = [];
	let at = 0;

	for (const step of steps) {
		const frames = Math.max(1, Math.round((step.ms ?? FRAME_MS) / FRAME_MS));
		const view = render(step.scene);

		for (let f = 0; f < frames; f++) {
			const out = detector.push(view, at);

			if (out.change) {
				judged.push({at, kind: out.change.kind});
			}

			if (out.drop) {
				drops.push({at, change: out.change});
			}

			at += FRAME_MS;
		}
	}

	return {drops, judged};
}

// A card falling into the box from the bottom edge (cards slide in from the
// open front of Eric's box), in `frames` looks, then lying still for
// `stillMs`, over `under` (the pile).
function fall(under, card, {frames = 3, stillMs = 1200} = {}) {
	const steps = [];

	for (let k = frames; k >= 1; k--) {
		steps.push({ms: FRAME_MS, scene: {cards: [...under, {...card, angle: (card.angle || 0) + k * 6, cy: card.cy + k * 0.22, smear: 0.08}]}});
	}

	steps.push({ms: stillMs, scene: {cards: [...under, card]}});

	return steps;
}

const settle = (scene, ms = 1500) => [{ms, scene}];
const card = (i, extra = {}) => ({cx: 0.5, cy: 0.48, face: FACES[i], h: 0.55, ...extra});

describe('holder mode: a card is what changed since the picture was last still', () => {
	test('each card dropped is seen once, after it lands, never while it falls', () => {
		const pile = [];
		const steps = [...settle({cards: []})];

		for (let i = 0; i < 4; i++) {
			steps.push(...fall(pile, card(i, {cx: 0.5 + (i % 2 ? 0.03 : -0.02), cy: 0.48 + i * 0.01})));
			pile.push(card(i, {cx: 0.5 + (i % 2 ? 0.03 : -0.02), cy: 0.48 + i * 0.01}));
		}

		const {drops} = run(steps);

		assert.equal(drops.length, 4);

		for (const {change} of drops) {
			assert.ok(Math.abs(change.rect.cx / W - 0.5) < 0.08, `the change is the card: ${JSON.stringify(change.rect)}`);
			assert.ok(change.rect.h / H > 0.4 && change.rect.h / H < 0.7);
		}
	});

	test('cards landing on the very spot of the last are each seen (version 35 took them for the same card)', () => {
		const pile = [];
		const steps = [...settle({cards: []})];

		for (let i = 0; i < 5; i++) {
			steps.push(...fall(pile, card(i)));
			pile.push(card(i));
		}

		const out = run(steps);

		assert.equal(out.drops.length, 5, JSON.stringify(out.judged.filter((j) => j.kind !== 'none')));
	});

	test('the same card dropped again on the very same spot changes nothing and is not seen', () => {
		const steps = [...settle({cards: []}), ...fall([], card(0)), ...fall([card(0)], card(0))];

		assert.equal(run(steps).drops.length, 1);
	});

	// The cut that matches best wins (picture.js matchCrops), so one of the
	// change's cuts must be the card: not the card and the strip together.
	test('a strip of the card beneath showing: among the cuts is the new card alone, not the two together', () => {
		const below = card(0, {cy: 0.5});
		const top = card(1, {cy: 0.44});
		const {drops} = run([...settle({cards: [below]}), ...fall([below], top)]);

		assert.equal(drops.length, 1);

		const tall = (corners) => Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y) / H;
		const cuts = [drops[0].change.corners, ...drops[0].change.others];
		const best = cuts.reduce((a, b) => (Math.abs(tall(a) - 0.55) <= Math.abs(tall(b) - 0.55) ? a : b));
		const middle = best.reduce((sum, p) => sum + p.y, 0) / 4 / H;

		assert.ok(Math.abs(tall(best) - 0.55) < 0.05, `one card tall: ${cuts.map((c) => tall(c).toFixed(3)).join(', ')} of the view`);
		assert.ok(Math.abs(middle - 0.44) < 0.05, `where the top card lies: ${middle.toFixed(3)}`);
		assert.ok(cuts.every((c) => tall(c) < 0.55 + 0.06 * 1.5), 'no cut takes the strip beneath');
	});

	test('a card landing turned is found turned', () => {
		const {drops} = run([...settle({cards: []}), ...fall([], card(2, {angle: 12}))]);

		assert.equal(drops.length, 1);
		assert.ok(Math.abs(drops[0].change.rect.angle - 12) <= 3, `turned ${drops[0].change.rect.angle}`);
	});

	test('a fast rhythm: a card every 0.9 s (Eric\'s fastest was 1.3 s), each falling for two looks, is each seen once', () => {
		const pile = [];
		const steps = [...settle({cards: []})];

		for (let i = 0; i < 6; i++) {
			steps.push(...fall(pile, card(i, {cy: 0.48 + (i % 3) * 0.01}), {frames: 2, stillMs: 625}));
			pile.push(card(i, {cy: 0.48 + (i % 3) * 0.01}));
		}

		assert.equal(run(steps).drops.length, 6);
	});

	test('a card that lands while the loop was held up (a slow phone) is still seen on the next still frame', () => {
		const detector = D.createDropDetector();
		const empty = render({cards: []});
		const landed = render({cards: [card(0)]});
		let at = 0;
		const drops = [];

		for (let k = 0; k < 12; k++, at += FRAME_MS) {
			detector.push(empty, at);
		}

		// No look for 1.5 s: the card fell and lay down meanwhile.
		at += 1500;

		for (let k = 0; k < 6; k++, at += FRAME_MS) {
			if (detector.push(landed, at).drop) {
				drops.push(at);
			}
		}

		assert.equal(drops.length, 1);
	});

	test('a hand passing over the pile leaves nothing and takes nothing', () => {
		const pile = [card(0)];
		const steps = [...settle({cards: pile})];

		for (let k = 0; k < 6; k++) {
			steps.push({ms: FRAME_MS, scene: {cards: pile, hand: {r: 0.25, x: 0.2 + k * 0.12, y: 0.5}}});
		}

		steps.push(...settle({cards: pile}));

		assert.equal(run(steps).drops.length, 0);
	});

	test('a lamp flickering, or the camera re-exposing, is not a card', () => {
		const pile = [card(0)];
		const steps = [...settle({cards: pile})];

		for (const light of [0.8, 1.15, 0.9, 1.1, 0.85]) {
			steps.push({ms: 500, scene: {cards: pile, light}});
		}

		assert.equal(run(steps).drops.length, 0);
	});

	test('a lamp moved to the other side of the box is not a card', () => {
		const pile = [card(0)];
		const {drops, judged} = run([...settle({cards: pile}), {ms: 250, scene: {cards: pile, lampSide: -0.4}}, ...settle({cards: pile, lampSide: 0.5})]);

		assert.equal(drops.length, 0, JSON.stringify(judged.filter((j) => j.kind !== 'none')));
	});

	test('a card lifted off the floor (the box emptied) is not a card', () => {
		const {drops, judged} = run([...settle({cards: [card(0)]}), {ms: 125, scene: {cards: [], hand: {r: 0.3, x: 0.5, y: 0.5}}}, ...settle({cards: []})]);

		assert.equal(drops.length, 0);
		assert.ok(judged.some((j) => j.kind === 'removed'), JSON.stringify(judged.filter((j) => j.kind !== 'none')));
	});

	test('zoom changed (reframe): the next still picture is the base and takes nothing', () => {
		const detector = D.createDropDetector();

		run([...settle({cards: []})], detector);
		detector.reframe();

		assert.equal(run([...settle({cards: [card(0, {h: 0.75})]}, 2000)], detector).drops.length, 0);
		assert.equal(run(fall([card(0, {h: 0.75})], card(1, {h: 0.75})), detector).drops.length, 1);
	});
});

describe('holder mode: the capture of a drop', () => {
	const frame = {height: 400, width: 240};
	const viewOf = (scene) => ({...render(scene), rect: {h: 400, w: 240, x: 0, y: 0}, scale: 0.5});

	test('the card is cut from the frame round the change, with the change\'s rectangle among the outlines', () => {
		const {drops} = run([...settle({cards: []}), ...fall([], card(0))]);
		const view = viewOf({cards: [card(0)]});
		const plan = D.dropCapture(drops[0].change, view, view, null, {frame});

		assert.ok(!plan.skip);
		assert.ok(plan.quads.length >= 1);
		assert.ok(plan.region.w > 0 && plan.region.h > 0 && plan.region.x >= 0 && plan.region.y >= 0);
		assert.ok(plan.region.x + plan.region.w <= frame.width && plan.region.y + plan.region.h <= frame.height);
		assert.ok(plan.card.trusted);
	});

	test('a change much smaller than the last card, inside where it lay, is planned like any other (version 40: its picture decides)', () => {
		const last = D.takenCard(null, {box: {h: 220, w: 158, x: 41, y: 90}, trusted: true});
		const change = {blob: 0.02, corners: [{x: 40, y: 50}, {x: 52, y: 50}, {x: 52, y: 62}, {x: 40, y: 62}], cover: 1, others: [], rect: {angle: 0, cx: 46, cy: 56, h: 12, w: 12}};
		const view = viewOf({cards: [card(0)]});
		const plan = D.dropCapture(change, view, view, null, {frame, last});

		assert.equal(plan.skip, undefined, 'no "moved" skip any more');
		assert.ok(plan.quads.length >= 1);
	});

	test('a blurred drop waits for a sharper frame, by the last cards\' sharpness', () => {
		assert.equal(D.sharpEnough(100, []), true, 'nothing to go by');
		assert.equal(D.sharpEnough(300, [1000, 900, 1100]), false);
		assert.equal(D.sharpEnough(800, [1000, 900, 1100]), true);

		const sharp = render({cards: [card(0)]});
		const smeared = render({cards: [{...card(0), smear: 0.05}]});
		const box = {h: 110, w: 79, x: 20, y: 41};

		assert.ok(D.sharpness(smeared.grey, W, H, box) < D.sharpness(sharp.grey, W, H, box) * 0.6, 'a smeared card is less sharp');
	});
});

// A card whose art is a low-contrast pattern over the same layout: two of
// them differ by less than drop.js CHANGE in every cell, as two cards of
// one set with close colours can, but their pictures do not agree.
function twin(pattern) {
	const base = face(1);

	return (u, v) => {
		if (v > 0.11 && v < 0.52 && u > 0.08 && u < 0.92) {
			const bx = Math.floor(((u - 0.08) / 0.84) * 4);
			const by = Math.floor(((v - 0.11) / 0.41) * 3);

			return 128 + 7 * pattern[by * 4 + bx];
		}

		return base(u, v);
	};
}

const TWINS = [twin([1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, -1]), twin([-1, -1, 1, 1, 1, 1, -1, -1, -1, 1, 1, -1])];

// A card's corners in the view (top left, top right, bottom right, bottom
// left), as render draws it.
function cornersOf(c) {
	const ch = c.h * H;
	const cw = (ch * 63) / 88;
	const a = ((c.angle || 0) * Math.PI) / 180;
	const at = (u, v) => ({x: c.cx * W + u * cw * Math.cos(a) - v * ch * Math.sin(a), y: c.cy * H + u * cw * Math.sin(a) + v * ch * Math.cos(a)});

	return [at(-0.5, -0.5), at(0.5, -0.5), at(0.5, 0.5), at(-0.5, 0.5)];
}

describe('a new card means a new picture (Eric, 2026-10-16): the content check', () => {
	const frame = {height: H, width: W};
	const viewOf = (scene) => ({...render(scene), rect: {h: H, w: W, x: 0, y: 0}, scale: 1});
	const printAt = (scene, c) => {
		const view = render(scene);

		return D.printOf(view.grey, W, H, cornersOf(c));
	};

	test('the same card printed in two places and lights is close; two different cards on one spot are far apart', () => {
		const a = card(0);
		const moved = card(0, {angle: 2, cx: 0.52, cy: 0.49});
		const same = D.printDistance(printAt({cards: [a]}, a), printAt({cards: [moved], light: 0.85}, moved));

		assert.ok(same <= D.SAME_PRINT, `the same card nudged and dimmed: ${same}`);

		for (let i = 1; i < FACES.length; i++) {
			const other = D.printDistance(printAt({cards: [a]}, a), printAt({cards: [card(i)]}, card(i)));

			assert.ok(other >= D.NEW_PRINT, `card ${i} on card 0's spot: ${other}`);
		}

		const twins = D.printDistance(printAt({cards: [card(0, {face: TWINS[0]})]}, card(0)), printAt({cards: [card(0, {face: TWINS[1]})]}, card(0)));

		assert.ok(twins >= D.NEW_PRINT, `two cards of one layout and close colours: ${twins}`);
	});

	test('a card dropped on the last one\'s spot is new; the last card nudged is the same; a nudge is no disturbance, a drop is', () => {
		const first = run([...settle({cards: []}), ...fall([], card(0))]).drops[0];
		const view0 = viewOf({cards: [card(0)]});
		const plan0 = D.dropCapture(first.change, view0, view0, null, {frame});
		const last = D.contentCheck(plan0, view0, null);

		assert.equal(last.verdict, 'new', 'the first card: nothing before it');

		// Card 1 falls onto card 0's very spot.
		const plain = run([...settle({cards: [card(0)]}), ...fall([card(0)], card(1))]);
		const dropped = plain.drops[0];
		const view1 = viewOf({cards: [card(0), card(1)]});
		const plan1 = D.dropCapture(dropped.change, view1, view1, null, {frame, last});
		const check1 = D.contentCheck(plan1, view1, last);

		assert.equal(check1.verdict, 'new', `card 1 on card 0's spot: ${check1.distance}`);

		// Card 0 nudged a little in one look: a change, but the same picture,
		// and no disturbance like a drop's.
		const nudged = card(0, {angle: 1.5, cx: 0.515, cy: 0.49});
		const nudge = D.createDropDetector();

		run(settle({cards: [card(0)]}), nudge);

		const outs = [];

		for (const [k, scene] of [{cards: [nudged]}, {cards: [nudged]}, {cards: [nudged]}, {cards: [nudged]}, {cards: [nudged]}].entries()) {
			outs.push(nudge.push(render(scene), 1500 + k * FRAME_MS + 2000));
		}

		const judged = outs.find((out) => out.change);

		assert.ok(judged, 'the nudge was judged');
		assert.equal(D.disturbedBy(judged.burst), false, `a nudge is no disturbance: ${JSON.stringify(judged.burst)}`);

		const viewN = viewOf({cards: [nudged]});

		if (judged.change.kind === 'drop') {
			const planN = D.dropCapture(judged.change, viewN, viewN, null, {frame, last});

			assert.equal(D.contentCheck(planN, viewN, {...last, print: D.printOf(viewN.grey, W, H, cornersOf(nudged))}).verdict, 'same');
		}

		assert.notEqual(D.contentAt(last, viewN).verdict, 'new', 'where card 0 lay, card 0 still shows, a little moved: no new card');

		// A drop's disturbance.
		const fell = run([...settle({cards: [card(0)]}), ...fall([card(0)], card(0))]);

		assert.equal(fell.drops.length, 0, 'the same card dropped on the same spot changes nothing');
	});

	test('a card of the same layout and close colours landing on the last one\'s spot changes no cell enough, but its picture is new', () => {
		const a = card(0, {face: TWINS[0]});
		const b = card(0, {face: TWINS[1]});
		const detector = D.createDropDetector();

		run(settle({cards: [a]}), detector);

		let at = 1500;
		let still = null;
		const push = (scene) => {
			const out = detector.push(render(scene), at);

			at += FRAME_MS;

			if (out.change && !still) {
				still = out;
			}
		};

		for (const x of [0.2, 0.4, 0.6, 0.8]) {
			push({cards: [x < 0.5 ? a : b], hand: {r: 0.3, x, y: 0.5}});
		}

		for (let k = 0; k < 6; k++) {
			push({cards: [b]});
		}

		assert.ok(still, 'judged once still');
		assert.notEqual(still.change.kind, 'drop', `the change is no card's shape: ${still.change.kind}`);
		assert.ok(D.disturbedBy(still.burst), 'a hand at the box is a disturbance');

		const last = {print: D.printOf(render({cards: [a]}).grey, W, H, cornersOf(a)), quad: cornersOf(a)};
		const view = viewOf({cards: [b]});

		assert.equal(D.contentAt(last, view).verdict, 'new');

		const plan = D.planCapture(last.quad, [], view, view, null, {frame, sharpBox: D.boxOf(last.quad)});

		assert.ok(plan.quads.length >= 1 && plan.region.w > 0);
		assert.equal(D.contentCheck(plan, view, null).verdict, 'new');
	});
});

// ------------------------------------------------------------ a blurred capture (version 64)

describe('a blurred capture is retried, never lost (Eric, 2026-11-06, version 64)', () => {
	// The finer view (FIND_SIDE_CAPTURE): 160 x 260 grey, a card 200 pixels
	// tall in its middle with a detailed print (fine strokes, as a card's art
	// and text are at that size) over a plain floor.
	const FW = 160;
	const FH = 260;
	const CH = 200;
	const CW = Math.round(CH * (63 / 88));
	const X0 = Math.round((FW - CW) / 2);
	const Y0 = Math.round((FH - CH) / 2);
	const QUAD = [{x: X0, y: Y0}, {x: X0 + CW, y: Y0}, {x: X0 + CW, y: Y0 + CH}, {x: X0, y: Y0 + CH}];

	// A print of fine detail: a grey of its own in each 4 x 4 pixel cell.
	const cellGrey = (cx, cy) => {
		let hash = Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663);

		hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
		hash ^= hash >>> 16;

		return 60 + ((hash >>> 0) % 140);
	};

	// blur: passes of a 3 x 3 box filter; light scales every pixel (dim
	// light); print 'detail', 'plain' (a blob), or 'smooth' (a soft gradient,
	// as a basic Energy's).
	function fineView({blur = 0, light = 1, print = 'detail'} = {}) {
		let grey = new Float32Array(FW * FH);

		for (let y = 0; y < FH; y++) {
			for (let x = 0; x < FW; x++) {
				const u = (x - X0) / CW;
				const v = (y - Y0) / CH;
				let value = 230;

				if (u >= 0 && u < 1 && v >= 0 && v < 1) {
					value = print === 'plain'
						? 170
						: print === 'smooth'
							? 120 + 80 * Math.sin(u * 3) * Math.cos(v * 2)
							: cellGrey(Math.floor(x / 4), Math.floor(y / 4));
				}

				grey[y * FW + x] = value;
			}
		}

		for (let pass = 0; pass < blur; pass++) {
			const next = new Float32Array(grey.length);

			for (let y = 0; y < FH; y++) {
				for (let x = 0; x < FW; x++) {
					let sum = 0;
					let n = 0;

					for (let dy = -1; dy <= 1; dy++) {
						for (let dx = -1; dx <= 1; dx++) {
							const xx = Math.min(FW - 1, Math.max(0, x + dx));
							const yy = Math.min(FH - 1, Math.max(0, y + dy));

							sum += grey[yy * FW + xx];
							n++;
						}
					}

					next[y * FW + x] = sum / n;
				}
			}

			grey = next;
		}

		return {grey: Uint8ClampedArray.from(grey, (value) => value * light), height: FH, width: FW};
	}

	test('a sharp card reads sharp, the same card out of focus reads soft, in good light and dim', () => {
		for (const light of [1, 0.35]) {
			const sharp = D.captureFocus(fineView({light}), [QUAD]);
			const soft = D.captureFocus(fineView({blur: 2, light}), [QUAD]);

			assert.equal(sharp.why, null, `sharp at light ${light}: ${JSON.stringify(sharp)}`);
			assert.ok(sharp.blur <= D.BLUR_SHARE && sharp.texture >= D.TEXTURE_MIN);
			assert.equal(soft.why, 'soft', `out of focus at light ${light}: ${JSON.stringify(soft)}`);
		}
	});

	test('a plain blob is plain, and a soft print of its own (a basic Energy\'s gradient) is not sharp', () => {
		assert.equal(D.captureFocus(fineView({print: 'plain'}), [QUAD]).why, 'plain');
		assert.notEqual(D.captureFocus(fineView({print: 'smooth'}), [QUAD]).why, null);
	});

	test('the worse of two outlines counts: a card half out of focus is not sharp', () => {
		const view = fineView();
		const soft = fineView({blur: 2});
		// The lower half from the blurred picture: a hand's card over it.
		const half = {...view, grey: Uint8ClampedArray.from(view.grey, (value, i) => (Math.floor(i / FW) > Y0 + CH / 2 ? soft.grey[i] : value))};
		const top = [QUAD[0], QUAD[1], {x: QUAD[1].x, y: Y0 + CH / 2}, {x: QUAD[0].x, y: Y0 + CH / 2}];

		assert.equal(D.captureFocus(half, [top]).why, null, 'the top half alone reads sharp');
		assert.notEqual(D.captureFocus(half, [top, QUAD]).why, null, 'with the whole card, the soft half counts');
	});

	test('regionStir: an unchanged spot is still, under a lamp flickering too; a card landing on it is not', () => {
		const empty = render({cards: []});
		const withCard = render({cards: [card(0)]});
		const cellsOf = (view) => D.cells(view.grey, view.width, view.height);
		const spot = {h: H * 0.55, w: H * 0.55 * (63 / 88), x: W * 0.5 - H * 0.55 * (63 / 88) / 2, y: H * 0.48 - H * 0.55 / 2};

		assert.ok(D.regionStir(cellsOf(empty), cellsOf(empty), spot) <= D.GONE_STIR);
		assert.ok(D.regionStir(cellsOf(render({cards: [], light: 0.85})), cellsOf(empty), spot) <= D.GONE_STIR, 'the light alone');
		assert.ok(D.regionStir(cellsOf(withCard), cellsOf(empty), spot) > 0.3, 'a card on the spot');
		assert.ok(D.regionStir(cellsOf(render({cards: [card(0), card(1)]})), cellsOf(withCard), spot) > 0.1, 'another card on the very spot of the last');
		assert.equal(D.regionStir(cellsOf(empty), null, spot), 1, 'nothing to compare with: it changed');
	});

	test('retryVerdict: a sharp look of the card before is a repeat, a spot as it was is gone, a sharp new look is the card, else it waits', () => {
		const sharp = {blur: 0.02, texture: 0.9};
		const soft = {blur: 0.3, texture: 0.9};

		assert.equal(D.retryVerdict({content: {verdict: 'same'}, focus: sharp, stir: 0.5}), 'repeat');
		assert.equal(D.retryVerdict({content: {verdict: 'same'}, focus: sharp, stir: 0}), 'repeat');
		assert.equal(D.retryVerdict({content: {verdict: 'new'}, focus: sharp, stir: 0.01}), 'gone', 'the spot shows what lay there before the drop');
		assert.equal(D.retryVerdict({focus: soft, stir: 0.01}), 'gone', 'a hand left nothing, even out of focus');
		assert.equal(D.retryVerdict({content: {verdict: 'new'}, focus: sharp, stir: 0.4}), 'sharp');
		assert.equal(D.retryVerdict({content: {verdict: 'unsure'}, focus: sharp, stir: 0.4}), 'sharp', 'unsure whether it is the same card: added');
		assert.equal(D.retryVerdict({focus: soft, stir: 0.4}), null, 'still blurred: it waits');
		assert.equal(D.retryVerdict({focus: {blur: 0, texture: 0.1}, stir: 0.4}), null, 'plain: it waits');
		// A card on the very spot of the last, told by its picture: its cells
		// barely change, so it is never taken for gone.
		assert.equal(D.retryVerdict({byPicture: true, content: {verdict: 'new'}, focus: sharp, stir: 0}), 'sharp');
		assert.equal(D.retryVerdict({byPicture: true, focus: soft, stir: 0}), null);
	});

	test('landedOn: a card-shaped change on the spot and a print far from the waiting one is another card, unless the waiting card shows again', () => {
		// Prints as printOf makes them: two 64-bit hashes, two 32-bit words each.
		const a = {art: Uint32Array.from([0x01234567, 0x89abcdef]), face: Uint32Array.from([0x0f0f0f0f, 0x0f0f0f0f])};
		const near = {art: Uint32Array.from([0x01234560, 0x89abcdef]), face: a.face};
		const far = {art: Uint32Array.from([~0x01234567 >>> 0, ~0x89abcdef >>> 0]), face: a.face};

		assert.ok(D.printDistance(near, a) < D.NEW_PRINT && D.printDistance(far, a) >= D.NEW_PRINT);
		assert.equal(D.landedOn({landed: true, print: far, waiting: a}), true, 'a different card dropped on it');
		assert.equal(D.landedOn({landed: true, print: near, waiting: a}), false, 'the same card, settled');
		assert.equal(D.landedOn({landed: false, print: far, waiting: a}), false, 'no card-shaped change on the spot: the card settling');
		assert.equal(D.landedOn({landed: true, print: far, same: true, waiting: a}), false, 'the waiting card shows again: a hand over it left, or it came into focus');
		assert.equal(D.landedOn({landed: true, print: far, waiting: null}), true, 'no print to compare: added, never replaced');
	});

	test('spotVerdict: on a waiting capture\'s spot, another card, the card settled, a second copy, or one more look', () => {
		const a = {art: Uint32Array.from([0x01234567, 0x89abcdef]), face: Uint32Array.from([0x0f0f0f0f, 0x0f0f0f0f])};
		const far = {art: Uint32Array.from([~0x01234567 >>> 0, ~0x89abcdef >>> 0]), face: a.face};

		assert.equal(D.spotVerdict({landed: true, print: far, sharp: true, waiting: a}), 'another card');
		assert.equal(D.spotVerdict({landed: true, print: far, sharp: false, waiting: a}), 'another card', 'blurred too: added after the waiting one');
		assert.equal(D.spotVerdict({landed: true, print: far, same: true, sharp: true, waiting: a}), 'settled', 'a hand over it left, or it came into focus');
		assert.equal(D.spotVerdict({landed: true, print: a, sharp: true, waiting: a}), 'settled');
		// Review of 2026-11-06: two Fire Energies, the second dropped on the
		// first while it waited, were folded into one without a word.
		assert.equal(D.spotVerdict({fell: true, landed: true, print: a, sharp: false, waiting: a}), 'second copy');
		assert.equal(D.spotVerdict({fell: false, landed: true, print: a, sharp: false, waiting: a}), 'waiting', 'a hand over it moving slowly');
		assert.equal(D.spotVerdict({fell: true, landed: true, print: a, same: true, sharp: false, waiting: a}), 'waiting', 'the waiting card itself');
	});

	test('blurredLike: the same card out of focus reads close to its sharp look; another card does not', () => {
		const thumbOf = (view) => D.cardThumb(view.grey, view.width, view.height, QUAD);
		const sharp = fineView();
		const other = {...sharp, grey: Uint8ClampedArray.from(sharp.grey, (value) => 255 - value)};

		assert.ok(D.blurredLike(thumbOf(fineView({blur: 3})), thumbOf(sharp)) <= D.LIKE_MAD);
		assert.ok(D.blurredLike(thumbOf(fineView({blur: 3})), thumbOf(other)) > D.LIKE_MAD);
		assert.equal(D.sameCardThere(thumbOf(fineView({blur: 3})), thumbOf(sharp)), true);
	});

	test('revealedIn: the sharp part of a card half under a blurred hand is found again once the hand leaves; another card on it is not', () => {
		const corners = QUAD;
		const thumbOf = (view) => D.cardThumb(view.grey, view.width, view.height, corners);
		const sharp = fineView();
		const soft = fineView({blur: 3});
		// The lower half under a hand's card out of focus.
		const covered = {...sharp, grey: Uint8ClampedArray.from(sharp.grey, (value, i) => (Math.floor(i / FW) > Y0 + CH / 2 ? soft.grey[i] : value))};
		const other = {...sharp, grey: Uint8ClampedArray.from(sharp.grey, (value, i) => 255 - value)};

		assert.equal(D.revealedIn(thumbOf(covered), thumbOf(sharp)), true, 'the card, the hand gone');
		assert.equal(D.revealedIn(thumbOf(covered), thumbOf(other)), false, 'another card dropped on it');
		assert.equal(D.revealedIn(thumbOf(fineView({blur: 10})), thumbOf(sharp)), false, 'nothing sharp to go by: never taken for the same');
		assert.equal(D.revealedIn(thumbOf(soft), thumbOf(sharp)), true, 'a little soft, the same card');
		assert.ok(D.detailMatch(thumbOf(covered), thumbOf(sharp)).cells >= D.REVEAL_MIN);
	});

	test('sameSpot: a card on the waiting one\'s spot is one spot; a card beside it is another', () => {
		const spot = {h: 100, w: 70, x: 50, y: 50};

		assert.ok(D.sameSpot(spot, {h: 96, w: 68, x: 55, y: 54}));
		assert.ok(D.sameSpot(spot, {h: 200, w: 140, x: 20, y: 20}), 'a larger change round it');
		assert.ok(!D.sameSpot(spot, {h: 100, w: 70, x: 110, y: 50}), 'beside it');
		assert.ok(!D.sameSpot(spot, null));
		assert.equal(D.RETRY_MS, 1500);
	});
});
