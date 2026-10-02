// The rear camera for the scanner. lab/js/camera.js, with two changes: after
// the stream starts it asks for the largest resolution the camera reports
// (the lab stops at 3840 x 2160), and its error names the scanner rather
// than the lab. The capture geometry (guide frame plus margin) is the lab's,
// so the straightening and reading code sees what the benchmark measured.

import {cancelled, captureRect, GUIDE_FILL, playStream, stopStream} from '../../lab/js/camera.js';
import {guideRect} from '../../lab/js/pipeline.js';
import {THUMB_H, THUMB_W, toGrey} from './steady.js';

export {captureRect, GUIDE_FILL};

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

// The guide frame as fractions of the video frame, for drawing the outline.
export function guideBox(width, height) {
	const guide = guideRect(width, height, GUIDE_FILL);

	return {h: guide.h / height, w: guide.w / width, x: guide.x / width, y: guide.y / height};
}

// A small grey picture of the capture area, for the steadiness check.
export function thumbnail(video, canvas) {
	const width = video.videoWidth;
	const height = video.videoHeight;

	if (!width || !height) {
		return null;
	}

	const rect = captureRect(width, height);

	canvas.width = THUMB_W;
	canvas.height = THUMB_H;

	const ctx = canvas.getContext('2d', {willReadFrequently: true});

	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = 'medium';
	ctx.drawImage(video, rect.x, rect.y, rect.w, rect.h, 0, 0, THUMB_W, THUMB_H);

	return toGrey(ctx.getImageData(0, 0, THUMB_W, THUMB_H).data, THUMB_W, THUMB_H);
}

// The full-resolution capture area as ImageData.
export function grabFrame(video) {
	const width = video.videoWidth;
	const height = video.videoHeight;
	const rect = captureRect(width, height);
	const canvas = document.createElement('canvas');

	canvas.width = rect.w;
	canvas.height = rect.h;

	const ctx = canvas.getContext('2d', {willReadFrequently: true});

	ctx.drawImage(video, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);

	return ctx.getImageData(0, 0, rect.w, rect.h);
}
