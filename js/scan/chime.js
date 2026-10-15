// The chime for a valuable card (js/scan/worth.js), off unless switched on
// in Scan: two short rising notes made with Web Audio, no audio file. Where
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
