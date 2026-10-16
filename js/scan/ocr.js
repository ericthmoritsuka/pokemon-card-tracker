// The OCR engine for the scanner: Tesseract.js from lab/vendor/tesseract,
// never a CDN, as one or two workers that read crops side by side.
//
// Tesseract.js has a scheduler (createScheduler), but its jobs cannot carry
// their own page segmentation mode or character whitelist: those are worker
// parameters. Every region here wants its own, so this module keeps its own
// small pool instead: each job goes to the first idle worker, which changes
// its parameters only when the job asks for different ones.
//
// Crops reach Tesseract as PGM bytes (a 15-byte header and one grey byte
// per pixel), which Leptonica reads directly. A canvas would be encoded to
// PNG on the main thread and decoded again in the worker, which is time a
// mid-range phone does not have.

const VENDOR = new URL('../../lab/vendor/tesseract/', import.meta.url).href;

export const TESSERACT_VERSION = '7.0.0';

// Two workers when the phone reports at least 4 GB of memory and 4 cores;
// one otherwise, or when it reports nothing (Safari, Firefox). Each worker
// holds the WebAssembly core and the English model, about 40 MB once
// started.
export function workerCount(nav = typeof navigator === 'undefined' ? {} : navigator) {
	const memory = Number(nav.deviceMemory) || 0;
	const cores = Number(nav.hardwareConcurrency) || 0;

	return memory >= 4 && cores >= 4 ? 2 : 1;
}

// A grey ImageData-shaped crop (prepareCrop output: R = G = B) as PGM bytes.
export function toPgm(image) {
	const header = new TextEncoder().encode(`P5\n${image.width} ${image.height}\n255\n`);
	const out = new Uint8Array(header.length + image.width * image.height);

	out.set(header, 0);

	for (let i = 0, o = header.length; i < image.width * image.height; i++, o++) {
		out[o] = image.data[i * 4];
	}

	return out;
}

const linesOf = (data) => {
	const lines = [];

	for (const block of data.blocks || []) {
		for (const paragraph of block.paragraphs) {
			for (const line of paragraph.lines) {
				lines.push({
					text: line.text.trim(),
					words: line.words.map((word) => ({bbox: word.bbox, confidence: Math.round(word.confidence), text: word.text})),
				});
			}
		}
	}

	return lines;
};

// Set once per worker. tessedit_do_invert 0: Tesseract otherwise reads any
// line it is unsure of a second time inverted, doubling the work on exactly
// the poor captures that are slow already; the reader inverts the crops
// that need it (the set code box, a light HP) itself. user_defined_dpi:
// crops arrive as PGM with no resolution, which Tesseract otherwise
// estimates for every call.
const FIXED = {tessedit_do_invert: '0', user_defined_dpi: '300'};

// Tesseract.js is imported with the first worker, so the pool's scheduler
// (createSlots) loads in Node, where its tests run.
async function startWorker(logger) {
	const {default: Tesseract} = await import('../../lab/vendor/tesseract/tesseract.esm.min.js');
	const worker = await Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
		cacheMethod: 'none',
		// A folder, so Tesseract picks the relaxed-SIMD, SIMD, or plain build
		// to suit the browser. All three are vendored.
		corePath: VENDOR + 'core',
		gzip: true,
		langPath: VENDOR + 'lang',
		logger,
		workerBlobURL: false,
		workerPath: VENDOR + 'worker.min.js',
	});

	await worker.setParameters(FIXED);

	return worker;
}

// The pool's workers handed out in turn (createPool): take(background)
// resolves with a free slot, release(slot) gives it back. A background job
// (a label check behind the tray, identify.js readLanguageLabel) waits
// while any foreground job (a card's number being read) waits, and holds at
// most BACKGROUND_SLOTS slots at once, so a card being read never queues
// behind label checks (Eric's phone, version 38: text reads waited up to
// 17 s behind them). Pure, so Node tests it.
export const BACKGROUND_SLOTS = 1;

export function createSlots({backgroundSlots = BACKGROUND_SLOTS} = {}) {
	const idle = [];
	const front = [];
	const back = [];
	let backRunning = 0;

	const give = (slot) => {
		if (front.length) {
			front.shift()(slot);

			return true;
		}

		if (back.length && backRunning < backgroundSlots) {
			backRunning++;
			slot.background = true;
			back.shift()(slot);

			return true;
		}

		return false;
	};

	return {
		get waiting() {
			return {back: back.length, front: front.length};
		},
		release(slot) {
			if (slot.background) {
				slot.background = false;
				backRunning--;
			}

			if (!give(slot)) {
				idle.push(slot);
			}
		},
		take(background = false) {
			return new Promise((resolve) => {
				(background ? back : front).push(resolve);

				while (idle.length && give(idle[0])) {
					idle.shift();
				}
			});
		},
	};
}

// Starts the pool. The first worker is waited for; the second joins when it
// is up, so a read never waits for it. Returns {ocr, size, terminate,
// loadMs, trace}; ocr(image, {psm, whitelist, background}) resolves to
// {confidence, lines, text}, like lab/js/ocr.js; background: true for a
// read nobody is waiting on (createSlots). trace: the last TRACE_KEPT
// calls, {background, queued, started, ended} (performance.now()), for the
// tests and the phone check.
const TRACE_KEPT = 200;

export async function createPool({logger = () => {}, size = workerCount()} = {}) {
	const started = performance.now();
	const slots = createSlots();
	const all = [];
	const trace = [];
	let stopped = false;

	const add = (worker) => {
		if (stopped) {
			worker.terminate();

			return;
		}

		const slot = {current: '', worker};

		all.push(slot);
		slots.release(slot);
	};

	add(await startWorker(logger));

	const loadMs = Math.round(performance.now() - started);

	for (let i = 1; i < size; i++) {
		// A second worker that does not start (memory, say) leaves one.
		startWorker(() => {}).then(add, () => {});
	}

	async function ocr(image, {background = false, psm = '7', whitelist = ''} = {}) {
		const call = {background, ended: null, queued: performance.now(), started: null};

		trace.push(call);

		if (trace.length > TRACE_KEPT) {
			trace.shift();
		}

		const slot = await slots.take(background);

		call.started = performance.now();

		try {
			const key = `${psm}|${whitelist}`;

			if (key !== slot.current) {
				await slot.worker.setParameters({tessedit_char_whitelist: whitelist, tessedit_pageseg_mode: psm});
				slot.current = key;
			}

			const {data} = await slot.worker.recognize(toPgm(image), {}, {blocks: true, text: true});

			return {confidence: Math.round(data.confidence), lines: linesOf(data), text: data.text.trim()};
		}
		finally {
			call.ended = performance.now();
			slots.release(slot);
		}
	}

	return {
		loadMs,
		ocr,
		get size() {
			return all.length;
		},
		terminate: () => {
			stopped = true;

			return Promise.all(all.map((slot) => slot.worker.terminate()));
		},
		trace,
	};
}
