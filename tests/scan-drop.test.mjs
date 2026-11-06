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

// ------------------------------------------------------------ settled (version 62)

// The finer view the settle check reads (FIND_SIDE_CAPTURE: 284 x 360 at
// 1x), a white box with card faces painted into it, and a box blur: a card
// out of focus, as the next card in Eric's hand near the lens was in his
// v60 log (2026-11-06).
const FW = 284;
const FH = 360;

function paint(cards, {light = 1} = {}) {
	const grey = new Float32Array(FW * FH);

	for (let y = 0; y < FH; y++) {
		for (let x = 0; x < FW; x++) {
			let v = x < FW * 0.1 || x > FW * 0.9 ? 205 : 238;

			for (const c of cards) {
				const u = (x + 0.5 - c.x) / c.w;
				const t = (y + 0.5 - c.y) / c.h;

				if (u >= 0 && u <= 1 && t >= 0 && t <= 1) {
					v = c.plain ? 90 : c.face(u, t);
				}
			}

			grey[y * FW + x] = v * light;
		}
	}

	return grey;
}

// Blurs the part of `grey` in box (a {x, y, w, h}) with a box filter of
// radius r, three times (close to a Gaussian).
function blurBox(grey, box, r) {
	let out = grey;

	for (let pass = 0; pass < 3; pass++) {
		const src = out;

		out = Float32Array.from(src);

		for (let y = Math.max(0, box.y); y < Math.min(FH, box.y + box.h); y++) {
			for (let x = Math.max(0, box.x); x < Math.min(FW, box.x + box.w); x++) {
				let sum = 0;
				let n = 0;

				for (let dy = -r; dy <= r; dy++) {
					for (let dx = -r; dx <= r; dx++) {
						const xx = Math.min(FW - 1, Math.max(0, x + dx));
						const yy = Math.min(FH - 1, Math.max(0, y + dy));

						sum += src[yy * FW + xx];
						n++;
					}
				}

				out[y * FW + x] = sum / n;
			}
		}
	}

	return out;
}

const PLACE = {h: 210, w: 150, x: 67, y: 75};
const cornersIn = ({h, w, x, y}) => [{x, y}, {x: x + w, y}, {x: x + w, y: y + h}, {x, y: y + h}];
const focusOf = (grey, place = PLACE) => D.cardFocus(grey, FW, FH, cornersIn(place));

describe('holder mode takes a card once it has settled (Eric, 2026-11-06, version 62)', () => {
	test('a sharp card is settled; the same card soft, or with a blurred card held over half of it, is not', () => {
		const sharp = paint([{...PLACE, face: FACES[0]}]);

		assert.equal(D.settleVerdict({focus: focusOf(sharp), stir: 0}), null, JSON.stringify(focusOf(sharp)));

		const soft = blurBox(sharp, {h: FH, w: FW, x: 0, y: 0}, 2);

		assert.equal(D.settleVerdict({focus: focusOf(soft), stir: 0}), 'soft', JSON.stringify(focusOf(soft)));

		// The next card in the hand, larger (near the lens) and out of focus,
		// over the bottom of the card on the pile.
		const held = {face: FACES[3], h: 260, w: 190, x: 40, y: 190};
		const covered = blurBox(paint([{...PLACE, face: FACES[0]}, held]), {h: 300, w: 260, x: 20, y: 170}, 4);

		assert.equal(D.settleVerdict({focus: focusOf(covered), stir: 0}), 'soft', JSON.stringify(focusOf(covered)));
	});

	test('dim light does not change the verdict (the measure is relative to the view\'s own contrast)', () => {
		const sharp = paint([{...PLACE, face: FACES[1]}], {light: 0.3});
		const soft = blurBox(sharp, {h: FH, w: FW, x: 0, y: 0}, 2);

		assert.equal(D.settleVerdict({focus: focusOf(sharp), stir: 0}), null, JSON.stringify(focusOf(sharp)));
		assert.equal(D.settleVerdict({focus: focusOf(soft), stir: 0}), 'soft', JSON.stringify(focusOf(soft)));
	});

	test('a blurred blob with no print (a hand, a sleeve) is plain', () => {
		const blob = blurBox(paint([{...PLACE, plain: true}]), {h: FH, w: FW, x: 0, y: 0}, 5);

		assert.equal(D.settleVerdict({focus: focusOf(blob), stir: 0}), 'plain', JSON.stringify(focusOf(blob)));
	});

	test('the card\'s part of the view moving is not settled, the light changing is', () => {
		assert.equal(D.settleVerdict({focus: {blur: 0, texture: 1}, stir: D.REGION_STIR * 2}), 'moving');

		const pile = [card(0)];
		const box = D.grownBox(cornersOf(card(0)));
		const detector = D.createDropDetector();
		let at = 0;

		for (let k = 0; k < 12; k++, at += FRAME_MS) {
			detector.push(render({cards: pile}), at);
		}

		assert.equal(detector.stirIn(box), 0, 'a card lying still');

		// A darker card held over the bottom of it, moving a little each look.
		for (let k = 0; k < 3; k++, at += FRAME_MS) {
			detector.push(render({cards: [...pile, {...card(3, {cy: 0.78, h: 0.6}), cx: 0.5 + (k % 2 ? 0.03 : -0.03), smear: 0.06}]}), at);
		}

		assert.ok(detector.stirIn(box) > D.REGION_STIR, `a card held over it, moving: ${detector.stirIn(box)}`);

		for (const light of [0.85, 1.1, 0.9]) {
			detector.push(render({cards: pile, light}), at);
			at += FRAME_MS;
		}

		assert.ok(detector.stirIn(box) <= D.REGION_STIR, `the light changing: ${detector.stirIn(box)}`);
	});

	test('a drop waiting to settle is judged against the picture before it; a hand that leaves nothing changes nothing; release moves the base on', () => {
		const detector = D.createDropDetector();
		const before = run([...settle({cards: [card(0)]})], detector);

		assert.equal(before.drops.length, 0);

		// Card 1 lands; the drop is held on the look that saw it.
		let at = 5000;
		let seen = null;

		for (const scene of [{cards: [card(0), {...card(1), cy: 0.9, smear: 0.08}]}, {cards: [card(0), card(1)]}, {cards: [card(0), card(1)]}, {cards: [card(0), card(1)]}, {cards: [card(0), card(1)]}]) {
			const out = detector.push(render(scene), at);

			at += FRAME_MS;

			if (out.drop && !seen) {
				seen = out;
				detector.hold();
			}
		}

		assert.ok(seen, 'the drop was seen');

		// Later still looks still see card 1 as what changed.
		let later = null;

		for (let k = 0; k < 4; k++, at += FRAME_MS) {
			const out = detector.push(render({cards: [card(0), card(1)]}), at);

			later = out.change || later;
		}

		assert.equal(later.kind, 'drop', 'still the drop, against the picture before it');
		detector.release();

		let after = null;

		for (let k = 0; k < 4; k++, at += FRAME_MS) {
			const out = detector.push(render({cards: [card(0), card(1)]}), at);

			after = out.change || after;
		}

		assert.equal(after.kind, 'none', 'released: the card is the base now');

		// A hand over the pile is held as a drop, and leaves nothing.
		const hand = {cards: [card(0), card(1)], hand: {r: 0.3, x: 0.5, y: 0.5}};
		let held = false;
		let last = null;

		for (const scene of [hand, hand, hand, hand, {cards: [card(0), card(1)]}, {cards: [card(0), card(1)]}, {cards: [card(0), card(1)]}, {cards: [card(0), card(1)]}]) {
			const out = detector.push(render(scene), at);

			at += FRAME_MS;

			if (out.change && !held && out.change.kind !== 'none') {
				held = true;
				detector.hold();
			}
			else if (out.change) {
				last = out.change;
			}
		}

		assert.ok(held, 'the hand was judged');
		assert.equal(last.kind, 'none', 'nothing changed once the hand left');
	});
});
