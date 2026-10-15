// The scanner's sounds, made with Web Audio, no audio file: the chime for a
// valuable card (js/scan/worth.js), off unless switched on in Scan, two
// short rising notes; and the shutter sound (Eric, 2026-10-15), on unless
// switched off, a short click the moment a capture is taken. Where
// the browser lets a page say what kind of sound it plays (Safari's
// navigator.audioSession), it is "ambient", so the phone's silent switch
// mutes it; nothing plays while the page is hidden.

let context = null;

function audio() {
	const Context = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;

	if (!Context) {
		return null;
	}

	if (!context) {
		try {
			if (navigator.audioSession) {
				navigator.audioSession.type = 'ambient';
			}
		}
		catch {
			// The browser plays it as it plays any sound.
		}

		context = new Context();
	}

	return context;
}

// Called from a tap (the switch turned on), so a browser that needs a
// gesture before sound lets the chime play later.
export function unlockChime() {
	const ctx = audio();

	if (ctx && ctx.state === 'suspended') {
		ctx.resume().catch(() => {});
	}
}

// Plays the chime; resolves false when it could not (no Web Audio, page
// hidden, sound not allowed yet).
export async function playChime() {
	if (typeof document !== 'undefined' && document.hidden) {
		return false;
	}

	const ctx = audio();

	if (!ctx) {
		return false;
	}

	try {
		if (ctx.state === 'suspended') {
			await ctx.resume();
		}

		const start = ctx.currentTime + 0.02;

		for (const [i, frequency] of [880, 1318.5].entries()) {
			const osc = ctx.createOscillator();
			const gain = ctx.createGain();
			const at = start + i * 0.12;

			osc.type = 'sine';
			osc.frequency.value = frequency;
			gain.gain.setValueAtTime(0.0001, at);
			gain.gain.exponentialRampToValueAtTime(0.18, at + 0.015);
			gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.25);
			osc.connect(gain).connect(ctx.destination);
			osc.start(at);
			osc.stop(at + 0.27);
		}

		return true;
	}
	catch {
		return false;
	}
}

// The shutter sound's switch, kept on this phone: on until switched off.
const SHUTTER_KEY = 'card-tracker:scan-shutter-sound';

export function shutterSoundOn(store = globalThis.localStorage) {
	try {
		return !store || store.getItem(SHUTTER_KEY) !== 'off';
	}
	catch {
		return true;
	}
}

export function saveShutterSound(on, store = globalThis.localStorage) {
	try {
		store.setItem(SHUTTER_KEY, on ? 'on' : 'off');
	}
	catch {
		// Not kept; the next visit starts with the sound on.
	}
}

// Plays the shutter's click: a burst of noise falling away in 60 ms, over
// a short low thump. Resolves false when it could not play.
export async function playShutter() {
	if (typeof document !== 'undefined' && document.hidden) {
		return false;
	}

	const ctx = audio();

	if (!ctx) {
		return false;
	}

	try {
		if (ctx.state === 'suspended') {
			await ctx.resume();
		}

		const at = ctx.currentTime + 0.005;
		const length = Math.round(ctx.sampleRate * 0.06);
		const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
		const data = buffer.getChannelData(0);

		for (let i = 0; i < length; i++) {
			data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
		}

		const noise = ctx.createBufferSource();
		const gain = ctx.createGain();

		noise.buffer = buffer;
		gain.gain.value = 0.25;
		noise.connect(gain).connect(ctx.destination);
		noise.start(at);

		const thump = ctx.createOscillator();
		const thumpGain = ctx.createGain();

		thump.type = 'sine';
		thump.frequency.setValueAtTime(180, at);
		thump.frequency.exponentialRampToValueAtTime(60, at + 0.05);
		thumpGain.gain.setValueAtTime(0.2, at);
		thumpGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
		thump.connect(thumpGain).connect(ctx.destination);
		thump.start(at);
		thump.stop(at + 0.07);

		return true;
	}
	catch {
		return false;
	}
}
