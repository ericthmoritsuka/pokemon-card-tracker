// The rear camera at the highest resolution it offers, with torch, zoom, and
// continuous focus where the phone supports them, and a still capture cut to
// the guide frame.

import {guideRect} from './pipeline.js';

// The guide frame fills this much of the frame's shorter side, and the
// capture keeps this margin around it, so a card held a little large or off
// centre is still whole in the crop (rectify.js then finds its edges).
export const GUIDE_FILL = 0.86;
export const CAPTURE_MARGIN = 0.06;

const supports = (caps, key, value) => {
	const options = caps && caps[key];

	if (value === undefined) {
		return Boolean(options);
	}

	return options === value || (Array.isArray(options) && options.includes(value));
};

export async function startCamera(video) {
	if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
		throw new Error('This browser has no camera access here. Open the lab over HTTPS (or localhost) in Chrome.');
	}

	const started = performance.now();
	const stream = await navigator.mediaDevices.getUserMedia({
		audio: false,
		video: {
			facingMode: {ideal: 'environment'},
			height: {ideal: 2160},
			width: {ideal: 3840},
		},
	});
	const track = stream.getVideoTracks()[0];
	const caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() : null;

	if (supports(caps, 'focusMode', 'continuous')) {
		try {
			await track.applyConstraints({advanced: [{focusMode: 'continuous'}]});
		}
		catch {
			// Focus stays as the browser chose.
		}
	}

	video.srcObject = stream;
	video.muted = true;
	await video.play();

	if (!video.videoWidth) {
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('The camera sent no frame within 10 seconds.')), 10000);

			video.addEventListener('loadedmetadata', () => {
				clearTimeout(timer);
				resolve();
			}, {once: true});
		});
	}

	let torchOn = false;
	let zoom = caps && caps.zoom ? (track.getSettings().zoom || caps.zoom.min) : null;

	return {
		caps,
		get frame() {
			return {height: video.videoHeight, width: video.videoWidth};
		},
		label: track.label || 'Camera',
		startMs: Math.round(performance.now() - started),
		stop() {
			for (const t of stream.getTracks()) {
				t.stop();
			}

			video.srcObject = null;
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
		zoomRange: caps && caps.zoom ? {max: caps.zoom.max, min: caps.zoom.min, step: caps.zoom.step || 0.1} : null,
		async setZoom(value) {
			await track.applyConstraints({advanced: [{zoom: value}]});
			zoom = value;
		},
	};
}

// The guide frame with its capture margin, in frame pixels, kept inside the
// frame.
export function captureRect(width, height) {
	const guide = guideRect(width, height, GUIDE_FILL);
	const mx = Math.round(guide.w * CAPTURE_MARGIN);
	const my = Math.round(guide.h * CAPTURE_MARGIN);
	const x = Math.max(0, guide.x - mx);
	const y = Math.max(0, guide.y - my);

	return {
		guide,
		h: Math.min(height - y, guide.h + my * 2),
		w: Math.min(width - x, guide.w + mx * 2),
		x,
		y,
	};
}

// Draws `source` (a video, image, or bitmap of width x height) and returns
// the capture rectangle's pixels as ImageData.
export function grab(source, width, height) {
	const rect = captureRect(width, height);
	const canvas = document.createElement('canvas');

	canvas.width = rect.w;
	canvas.height = rect.h;

	const ctx = canvas.getContext('2d', {willReadFrequently: true});

	ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);

	return {image: ctx.getImageData(0, 0, rect.w, rect.h), rect};
}
