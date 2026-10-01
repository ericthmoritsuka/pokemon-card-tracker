// Zoom and pan math for the inspection viewer (js/photos/viewer.js,
// DESIGN.md section 5, "Inspection viewer"). Pure functions over plain
// numbers, with no DOM, so Node tests them (tests/photos-viewer.test.mjs).
//
// A pane is a stage of {width, height} CSS pixels. The image is laid out at
// `base`, its size fitted inside the stage at zoom 1, and drawn with
//
//     transform: translate(tx, ty) scale(s)      (transform-origin 0 0)
//
// so a view {s, tx, ty} puts the image's top-left corner at (tx, ty) in the
// stage and makes it s * base.width wide. At s = 1 the image is centered.
//
// Card coordinates are normalized: (0, 0) is the card's top-left corner and
// (1, 1) its bottom-right, whatever the image's pixel size. The owner's
// photos are straightened to the card shape and official images are scans
// of the whole card, so the same (u, v) is the same spot on every image of
// a card, which is what Compare's synchronized zoom relies on.

// Zoom never stops short of this, so a small image on a big screen still
// magnifies enough to read a set symbol.
export const MIN_MAX_ZOOM = 4;

// The most any image zooms, whatever its resolution.
export const MAX_ZOOM_CAP = 12;

// What a double tap zooms to, about the tapped point.
export const DOUBLE_TAP_ZOOM = 2.5;

// Two taps closer than this in time (ms) and space (CSS px) are a double tap.
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_SLOP = 32;

// Momentum: the pan's speed decays as exp(-t / tau), so a flick at v px/ms
// travels v * tau px in all. Below the stop speed it ends.
export const MOMENTUM_TAU = 325;
export const MOMENTUM_STOP = 0.02;

// How far past an edge a drag may stretch, as a share of the stage.
const RUBBER = 0.55;

// Past the zoom limits during a pinch, the scale moves this fraction as fast.
const SCALE_RESIST = 0.3;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// The size an image of aspect width / height takes inside the stage at zoom
// 1 (object-fit: contain).
export function fitSize(stage, aspect) {
	const a = aspect > 0 ? aspect : 1;
	const width = Math.min(stage.width, stage.height * a);

	return {height: width / a, width};
}

// The view at zoom 1: the image centered in the stage.
export function restView(stage, base) {
	return {s: 1, tx: (stage.width - base.width) / 2, ty: (stage.height - base.height) / 2};
}

// How far the image may move at scale s: an axis where it is smaller than
// the stage stays centered, an axis where it is larger may move until its
// edge meets the stage's edge, never further.
export function bounds(stage, base, s) {
	const w = base.width * s;
	const h = base.height * s;
	const x = w <= stage.width ? [(stage.width - w) / 2, (stage.width - w) / 2] : [stage.width - w, 0];
	const y = h <= stage.height ? [(stage.height - h) / 2, (stage.height - h) / 2] : [stage.height - h, 0];

	return {maxX: x[1], maxY: y[1], minX: x[0], minY: y[0]};
}

// The highest zoom for an image of `natural` pixels drawn at `base`: one
// image pixel per CSS pixel (its native resolution), but never less than
// MIN_MAX_ZOOM nor more than MAX_ZOOM_CAP. With no natural size known, the
// floor.
export function maxZoom(base, natural) {
	const native = natural && natural.width > 0 && base.width > 0 ? natural.width / base.width : 0;

	return clamp(native, MIN_MAX_ZOOM, MAX_ZOOM_CAP);
}

// The view moved inside its bounds, with s clamped to [1, max].
export function clampView(view, stage, base, max = MIN_MAX_ZOOM) {
	const s = clamp(view.s, 1, Math.max(1, max));
	const b = bounds(stage, base, s);

	return {s, tx: clamp(view.tx, b.minX, b.maxX), ty: clamp(view.ty, b.minY, b.maxY)};
}

// How far a drag `over` CSS pixels past an edge shows, in a stage `size`
// pixels long: almost one to one at first, then stiffer, never more than
// the size itself.
export function rubber(over, size) {
	if (!over) {
		return 0;
	}

	const sign = over < 0 ? -1 : 1;
	const d = Math.abs(over);

	return sign * (1 - 1 / (d * RUBBER / Math.max(1, size) + 1)) * size;
}

// The view during a drag: inside the bounds as is, past them stretched by
// rubber(), so the edge is felt.
export function rubberView(view, stage, base) {
	const b = bounds(stage, base, view.s);
	const axis = (value, low, high, size) => {
		if (value < low) {
			return low + rubber(value - low, size);
		}

		if (value > high) {
			return high + rubber(value - high, size);
		}

		return value;
	};

	return {s: view.s, tx: axis(view.tx, b.minX, b.maxX, stage.width), ty: axis(view.ty, b.minY, b.maxY, stage.height)};
}

// The view at scale s2 that keeps the stage point (px, py) over the same
// spot of the image.
export function zoomAbout(view, s2, px, py) {
	const k = s2 / view.s;

	return {s: s2, tx: px - (px - view.tx) * k, ty: py - (py - view.ty) * k};
}

// A scale past [low, high] slowed down, for the feel of a limit during a
// pinch; settleView() brings it back afterwards.
export function resistScale(s, low, high) {
	if (s > high) {
		return high * (s / high) ** SCALE_RESIST;
	}

	if (s < low) {
		return low * (s / low) ** SCALE_RESIST;
	}

	return s;
}

// The view during a two-finger pinch. `start` is the view when the second
// finger landed, startMid and startDistance the fingers' midpoint and
// spread then; mid and distance are now. The spot of the image that was
// under the starting midpoint follows the current midpoint, so the pinch
// also pans.
export function pinchView(start, startMid, startDistance, mid, distance, max) {
	const raw = start.s * (distance / Math.max(1, startDistance));
	const s = resistScale(raw, 1, max);
	const k = s / start.s;

	return {s, tx: mid.x - (startMid.x - start.tx) * k, ty: mid.y - (startMid.y - start.ty) * k};
}

// Where a view that went past a limit settles: the scale back inside
// [1, max] about the point (px, py), then the position inside the bounds.
export function settleView(view, stage, base, max, px = stage.width / 2, py = stage.height / 2) {
	const s = clamp(view.s, 1, Math.max(1, max));

	return clampView(s === view.s ? view : zoomAbout(view, s, px, py), stage, base, max);
}

// A double tap: zoomed in, back to zoom 1; at zoom 1, DOUBLE_TAP_ZOOM (or
// the max, if lower) about the tapped point, which then stays under the
// finger unless that would show past an edge of the image.
export function doubleTapView(view, point, stage, base, max = MIN_MAX_ZOOM) {
	if (view.s > 1.01) {
		return restView(stage, base);
	}

	return clampView(zoomAbout(view, Math.min(DOUBLE_TAP_ZOOM, max), point.x, point.y), stage, base, max);
}

// The card point (u, v) under the stage point (px, py).
export function toCard(view, base, px, py) {
	return {u: (px - view.tx) / (view.s * base.width), v: (py - view.ty) / (view.s * base.height)};
}

// The stage point over the card point (u, v).
export function fromCard(view, base, u, v) {
	return {x: view.tx + u * view.s * base.width, y: view.ty + v * view.s * base.height};
}

// What a pane shows, independent of its pixel sizes: the zoom and the card
// point at the stage's center.
export function cardFocus(view, stage, base) {
	const {u, v} = toCard(view, base, stage.width / 2, stage.height / 2);

	return {s: view.s, u, v};
}

// The view of another pane that shows the same card focus: the same zoom
// over its own fitted size, with the same card point at its center, then
// kept inside its bounds.
export function viewForFocus(focus, stage, base, max) {
	return clampView({
		s: focus.s,
		tx: stage.width / 2 - focus.u * focus.s * base.width,
		ty: stage.height / 2 - focus.v * focus.s * base.height,
	}, stage, base, max);
}

// The pointer's speed in px/ms from its recent samples [{t, x, y}], read
// over the last `window` ms, so a finger that stopped before lifting
// throws nothing.
export function velocityOf(samples, now, window = 100) {
	const recent = samples.filter((sample) => now - sample.t <= window);

	if (recent.length < 2) {
		return {x: 0, y: 0};
	}

	const first = recent[0];
	const last = recent[recent.length - 1];
	const dt = last.t - first.t;

	if (dt <= 0 || now - last.t > 50) {
		return {x: 0, y: 0};
	}

	return {x: (last.x - first.x) / dt, y: (last.y - first.y) / dt};
}

// Where a flick released at `start` with velocity (px/ms) has carried the
// view after t ms, stopped at the bounds: {view, done}. done is true once
// it is slower than MOMENTUM_STOP or every moving axis has hit an edge.
export function momentumAt(start, velocity, t, stage, base, tau = MOMENTUM_TAU) {
	const b = bounds(stage, base, start.s);
	const travel = tau * (1 - Math.exp(-t / tau));
	const speed = Math.hypot(velocity.x, velocity.y) * Math.exp(-t / tau);
	const tx = start.tx + velocity.x * travel;
	const ty = start.ty + velocity.y * travel;
	const view = {s: start.s, tx: clamp(tx, b.minX, b.maxX), ty: clamp(ty, b.minY, b.maxY)};
	const stuckX = !velocity.x || view.tx !== tx;
	const stuckY = !velocity.y || view.ty !== ty;

	return {done: speed < MOMENTUM_STOP || (stuckX && stuckY), view};
}

// True when the view shows the image larger than its pixels can fill: one
// image pixel spread over more than one device pixel (counting at most 2
// per CSS pixel, so a 3x screen does not ask at every zoom). That is when a
// detail copy is worth fetching.
export function needsDetail(s, baseWidth, naturalWidth, dpr = 1) {
	if (s <= 1.05 || !(naturalWidth > 0)) {
		return false;
	}

	return s * baseWidth * Math.min(Math.max(1, dpr), 2) > naturalWidth;
}

// Two taps make a double tap when the second comes soon after the first
// and lands near it.
export function isDoubleTap(previous, tap) {
	return Boolean(previous)
		&& tap.t - previous.t < DOUBLE_TAP_MS
		&& Math.hypot(tap.x - previous.x, tap.y - previous.y) < DOUBLE_TAP_SLOP;
}

// A short ease-out for animated moves between views.
export const easeOut = (t) => 1 - (1 - t) ** 3;

export function mixView(a, b, t) {
	return {s: a.s + (b.s - a.s) * t, tx: a.tx + (b.tx - a.tx) * t, ty: a.ty + (b.ty - a.ty) * t};
}

// The interpolated view at fraction t of an animated zoom from a to b, with
// the scale interpolated in log space and the position chosen so the
// zoom's fixed point stays put, as a pinch would move it. Plain linear
// mixing of translate and scale makes the image swing sideways.
export function zoomStep(a, b, t) {
	if (Math.abs(a.s - b.s) < 1e-6) {
		return mixView(a, b, t);
	}

	// The point that stays still during a -> b: p = (b.tx * a.s - a.tx * b.s) / (a.s - b.s).
	const px = (b.tx * a.s - a.tx * b.s) / (a.s - b.s);
	const py = (b.ty * a.s - a.ty * b.s) / (a.s - b.s);
	const s = a.s * (b.s / a.s) ** t;

	return zoomAbout(a, s, px, py);
}
