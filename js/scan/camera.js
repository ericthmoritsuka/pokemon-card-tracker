// The rear camera for the scanner. lab/js/camera.js, with three changes:
// after the stream starts it asks for the largest resolution the camera
// reports (the lab stops at 3840 x 2160), its error names the scanner
// rather than the lab, and the guide is laid out on the screen first and
// mapped back onto the frame (layoutGuide), rather than cut from the frame
// and drawn wherever it lands.
//
// Why: on Eric's phone (2026-10-03: 384 x 854 CSS px, the rear camera
// 2160 x 3840 portrait) the lab's guide, 0.86 of the frame's width, is drawn
// about 461 px tall whatever the room above the tray, and with Chrome's
// toolbar and Android's buttons the video area is about that tall or less,
// so the guide's bottom sat under the tray. He held the card to the part he
// could see, the capture (the guide plus 6 %) cut it short, and the
// straightening worked the top edge out from a wrong bottom: distances of 68
// to 76 against about 30 for a good capture.

import {cancelled, GUIDE_FILL, playStream, stopStream} from '../../lab/js/camera.js';
import {CARD_RATIO, guideRect} from '../../lab/js/pipeline.js';
import {colourfulness, THUMB_H, THUMB_W, toGrey} from './steady.js';

export {GUIDE_FILL};

// CSS pixels kept clear between the guide and the edges of the part of the
// video that shows (at least; 3 % of its shorter side on a large screen).
export const GUIDE_MARGIN_PX = 14;

// The capture is the guide plus this share of the guide's width on the left
// and right, and of its height above and below, kept inside the frame: a
// card held a little large, small, or off centre still has all four of its
// edges in the capture, with table around them, so the straightening finds
// them rather than working one out. (The lab keeps 6 %, which a card held
// to a guide whose bottom could not be seen overran.)
export const CAPTURE_PAD = 0.1;

// Where the guide goes. frame: the camera's {width, height}; stage: the
// {width, height} in CSS pixels of the box the video is drawn in with
// object-fit: cover. The guide is the largest 63:88 box that fits the part
// of the drawn video that shows (the drawn video and the stage overlap)
// with `margin` around it, never larger than the lab's guide (`fill` of the
// frame), centred in that part.
//
// Returns {screen, guide, capture, scale, visible}: screen is the guide in
// stage pixels {x, y, w, h}; guide and capture are frame pixels {x, y, w,
// h}, capture the guide plus `pad` on every side, inside the frame; scale is
// the frame-to-stage scale, and visible the part of the stage the video
// shows {x, y, w, h}.
export function layoutGuide(frame, stage, {fill = GUIDE_FILL, margin = GUIDE_MARGIN_PX, pad = CAPTURE_PAD} = {}) {
	const scale = Math.max(stage.width / frame.width, stage.height / frame.height);
	const drawnW = frame.width * scale;
	const drawnH = frame.height * scale;
	const offsetX = (stage.width - drawnW) / 2;
	const offsetY = (stage.height - drawnH) / 2;
	const x0 = Math.max(0, offsetX);
	const y0 = Math.max(0, offsetY);
	const visible = {h: Math.min(stage.height, offsetY + drawnH) - y0, w: Math.min(stage.width, offsetX + drawnW) - x0, x: x0, y: y0};
	const m = Math.max(margin, 0.03 * Math.min(visible.w, visible.h));
	const lab = guideRect(frame.width, frame.height, fill);
	const roomW = Math.max(1, Math.min(visible.w - m * 2, lab.w * scale));
	const roomH = Math.max(1, Math.min(visible.h - m * 2, lab.h * scale));
	let h = roomH;
	let w = h * CARD_RATIO;

	if (w > roomW) {
		w = roomW;
		h = w / CARD_RATIO;
	}

	const screen = {h, w, x: visible.x + (visible.w - w) / 2, y: visible.y + (visible.h - h) / 2};
	const guide = {
		h: Math.round(h / scale),
		w: Math.round(w / scale),
		x: Math.round((screen.x - offsetX) / scale),
		y: Math.round((screen.y - offsetY) / scale),
	};
	const capture = padRect(frame, guide, pad);

	return {capture, guide, scale, screen, visible};
}

// `guide` (frame pixels) plus `pad` of its width on the left and right and
// of its height above and below, inside the frame.
export function padRect(frame, guide, pad = CAPTURE_PAD) {
	const px = Math.round(guide.w * pad);
	const py = Math.round(guide.h * pad);
	const x = Math.max(0, guide.x - px);
	const y = Math.max(0, guide.y - py);

	return {
		h: Math.min(frame.height, guide.y + guide.h + py) - y,
		w: Math.min(frame.width, guide.x + guide.w + px) - x,
		x,
		y,
	};
}

// The capture area for a frame with no screen layout (a photo picked from
// the gallery): the lab's guide plus CAPTURE_PAD.
export const defaultCapture = (width, height) => padRect({height, width}, guideRect(width, height, GUIDE_FILL));

export class CameraUnavailable extends Error {
	constructor(message, cause) {
		super(message);
		this.name = 'CameraUnavailable';
		this.cause = cause;
	}
}

const supports = (caps, key, value) => {
	const options = caps && caps[key];

	if (value === undefined) {
		return Boolean(options);
	}

	return options === value || (Array.isArray(options) && options.includes(value));
};

// Starts the rear camera into `video`. Throws CameraUnavailable with a
// reason a person can act on. signal (an AbortSignal) cancels the start:
// the stream is stopped, even one that arrives after the cancel, and it
// throws an AbortError. A start that fails after the camera opened stops
// it too.
export async function startCamera(video, {signal = null} = {}) {
	if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
		throw new CameraUnavailable('This browser gives no camera access here.');
	}

	if (signal && signal.aborted) {
		throw cancelled();
	}

	let stream;

	try {
		stream = await navigator.mediaDevices.getUserMedia({
			audio: false,
			video: {facingMode: {ideal: 'environment'}, height: {ideal: 2160}, width: {ideal: 3840}},
		});
	}
	catch (err) {
		const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');

		throw new CameraUnavailable(denied ? 'Camera access is turned off for this app.' : 'The camera could not start.', err);
	}

	const stillWanted = () => {
		if (signal && signal.aborted) {
			stopStream(stream);

			throw cancelled();
		}
	};

	stillWanted();

	const track = stream.getVideoTracks()[0];
	const caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() : null;

	// The highest resolution offered, when it is above what the first ask got.
	if (caps && caps.width && caps.height && caps.width.max && caps.height.max) {
		const settings = track.getSettings ? track.getSettings() : {};

		if ((settings.width || 0) * (settings.height || 0) < caps.width.max * caps.height.max) {
			try {
				await track.applyConstraints({height: {ideal: caps.height.max}, width: {ideal: caps.width.max}});
			}
			catch {
				// Keeps the resolution the first ask got.
			}

			stillWanted();
		}
	}

	if (supports(caps, 'focusMode', 'continuous')) {
		try {
			await track.applyConstraints({advanced: [{focusMode: 'continuous'}]});
		}
		catch {
			// Focus stays as the browser chose.
		}
	}

	await playStream(video, stream, {noPicture: () => new CameraUnavailable('The camera sent no picture within 10 seconds.'), signal});

	let torchOn = false;
	let zoom = caps && caps.zoom ? (track.getSettings().zoom || caps.zoom.min) : null;

	return {
		get frame() {
			return {height: video.videoHeight, width: video.videoWidth};
		},
		stop() {
			stopStream(stream, video);
		},
		get torch() {
			return torchOn;
		},
		torchSupported: supports(caps, 'torch', true),
		async setTorch(on) {
			await track.applyConstraints({advanced: [{torch: on}]});
			torchOn = on;
		},
		get zoom() {
			return zoom;
		},
		zoomRange: caps && caps.zoom && caps.zoom.max > caps.zoom.min ? {max: caps.zoom.max, min: caps.zoom.min} : null,
		async setZoom(value) {
			await track.applyConstraints({advanced: [{zoom: value}]});
			zoom = value;
		},
	};
}

// The capture area to use for `video` now: `rect` (from layoutGuide) when
// it was laid out for this frame size, else the guide as the lab places it
// plus CAPTURE_PAD.
const areaOf = (width, height, rect) => (rect && rect.x + rect.w <= width && rect.y + rect.h <= height ? rect : defaultCapture(width, height));

// A small grey picture of the capture area (`rect`, frame pixels), for the
// steadiness check, and how much colour its middle has (steady.js
// colourfulness: a card's artwork has some, a sheet of paper none). Null
// before the video has a picture.
export function thumbnailFrame(video, canvas, rect = null) {
	const width = video.videoWidth;
	const height = video.videoHeight;

	if (!width || !height) {
		return null;
	}

	const area = areaOf(width, height, rect);

	canvas.width = THUMB_W;
	canvas.height = THUMB_H;

	const ctx = canvas.getContext('2d', {willReadFrequently: true});

	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = 'medium';
	ctx.drawImage(video, area.x, area.y, area.w, area.h, 0, 0, THUMB_W, THUMB_H);

	const rgba = ctx.getImageData(0, 0, THUMB_W, THUMB_H).data;

	return {colour: colourfulness(rgba, THUMB_W, THUMB_H), grey: toGrey(rgba, THUMB_W, THUMB_H)};
}

// The grey thumbnail alone.
export function thumbnail(video, canvas, rect = null) {
	const frame = thumbnailFrame(video, canvas, rect);

	return frame ? frame.grey : null;
}

// The full-resolution capture area (`rect`, frame pixels) as ImageData.
export function grabFrame(video, rect = null) {
	const area = areaOf(video.videoWidth, video.videoHeight, rect);
	const canvas = document.createElement('canvas');

	canvas.width = area.w;
	canvas.height = area.h;

	const ctx = canvas.getContext('2d', {willReadFrequently: true});

	ctx.drawImage(video, area.x, area.y, area.w, area.h, 0, 0, area.w, area.h);

	return ctx.getImageData(0, 0, area.w, area.h);
}
