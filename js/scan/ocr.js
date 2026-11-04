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
// (createSlots) loads in Node, where its tests run. `lang` is the model:
// 'eng', or 'jpn' or 'kor' for the Asian workers (createAsianReader).
async function startWorker(logger, lang = 'eng') {
	const {default: Tesseract} = await import('../../lab/vendor/tesseract/tesseract.esm.min.js');
	const worker = await Tesseract.createWorker(lang, Tesseract.OEM.LSTM_ONLY, {
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

// The Japanese and Korean models (Eric, 2026-11-04; DESIGN.md section 6),
// for the name strip of a Japanese or Korean card (js/scan/cjk.js wantsCjk).
// tessdata_fast models from tesseract-ocr/tessdata_fast (Apache-2.0),
// gzipped beside the English one: jpn 1.5 MB, kor 1.1 MB. They load only
// when a card asks for one, in workers of their own, never in place of an
// English worker, so a Latin card's reads never wait for them; the service
// worker keeps them on first use (sw.js ocrResponse), never in its install
// precache.
export const ASIAN_MODELS = ['jpn', 'kor'];

// A load that takes longer than this (a slow connection) is not waited for:
// the card is read without it, and the model goes on loading for the next
// one. The time runs from the load's start, once for every read waiting on
// it, so the reads of one card never add their waits up.
export const ASIAN_WAIT_MS = 20000;

// A model is fetched here first, before Tesseract fetches it in its worker,
// so a model that cannot be fetched (offline before the service worker kept
// it) fails before any worker is made: Tesseract's own failed fetch would
// leave its worker alive, and its start never settling. The fetch fills the
// service worker's and the browser's caches, which the worker's fetch then
// reads. (Tesseract.js 7.0.0 cannot take the bytes instead: its initialize
// names a model given as {code, data} by its data.)
const fetched = new Map();

function fetchModel(lang) {
	if (!fetched.has(lang)) {
		const loading = fetch(`${VENDOR}lang/${lang}.traineddata.gz`).then(async (response) => {
			if (!response.ok) {
				throw new Error(`The ${lang} model answered ${response.status}.`);
			}

			await response.arrayBuffer();
		});

		fetched.set(lang, loading);
		loading.catch(() => fetched.delete(lang));
	}

	return fetched.get(lang);
}

// A Tesseract worker holding `lang`, whose reinitialize(lang) switches it to
// another model, each fetched first (fetchModel).
async function startAsianWorker(logger, lang) {
	await fetchModel(lang);

	const worker = await startWorker(logger, lang);

	return {
		recognize: (...args) => worker.recognize(...args),
		async reinitialize(next, oem) {
			await fetchModel(next);
			await worker.reinitialize(next, oem);
		},
		setParameters: (...args) => worker.setParameters(...args),
		terminate: () => worker.terminate(),
	};
}

// The Japanese and Korean readers: {ocr(image, {lang, psm, whitelist,
// noWait}), prepare(lang), state(lang), terminate(), loads, started}.
//
// - perModel: one worker per model, so the two never switch (measured in
//   headless Chromium, 2026-11-04: an English worker about 80 MB, a
//   Japanese or Korean one about 35 MB more each). createPool asks for it
//   when the phone has the memory for two English workers (workerCount);
//   otherwise one worker holds one model at a time and switches
//   (reinitialize, about 40 ms for a model loaded before).
// - A model loads outside the reads: a start or a switch holds its worker,
//   so no read runs while it changes models, and every read waiting on it
//   races the same time limit (`wait`) from the load's start. Past it, the
//   waiting reads give up together, and later reads for that worker give
//   up at once until the load settles.
// - noWait: true for a card whose language is not known, which never waits
//   for a model that is not loaded: such a read gives up at once (the
//   caller prepares the model for the next card; read.js readName).
// - A start that fails (offline before the model was kept) makes no
//   worker, and nothing is tried again this session until the browser says
//   it is back online (`onOnline`).
// - state(lang): 'held' when a worker holds the model and is not loading
//   another, 'ready' when it loaded once (a switch back reads it from the
//   caches), null otherwise.
//
// Pure apart from `start` (startAsianWorker) and `onOnline`, which tests
// replace.
const defaultOnOnline = (listener) => {
	if (typeof globalThis.addEventListener === 'function') {
		globalThis.addEventListener('online', listener);
	}
};

export function createAsianReader({logger = () => {}, onOnline = defaultOnOnline, perModel = false, start = startAsianWorker, wait = ASIAN_WAIT_MS} = {}) {
	const loads = [];
	const ready = new Set();
	const slots = new Map();
	let failed = null;
	let stopped = false;

	onOnline(() => {
		failed = null;
	});

	const slotFor = (lang) => {
		const key = perModel ? lang : 'one';

		if (!slots.has(key)) {
			slots.set(key, {current: '', loading: null, lock: Promise.resolve(), model: null, worker: null});
		}

		return slots.get(key);
	};

	// Runs `job` on the slot's worker once nothing else is.
	const exclusive = (slot, job) => {
		const next = slot.lock.then(job, job);

		slot.lock = next.catch(() => {});

		return next;
	};

	// Puts `lang` on the slot's worker, starting it or switching its model.
	const put = async (slot, lang) => {
		const started = performance.now();

		if (!slot.worker) {
			const made = await start(logger, lang);

			if (stopped) {
				made.terminate();

				throw new Error('The reader stopped.');
			}

			slot.worker = made;
			loads.push({lang, ms: Math.round(performance.now() - started)});
		}
		else {
			try {
				await slot.worker.reinitialize(lang, 1);
				await slot.worker.setParameters(FIXED);
			}
			catch (err) {
				// A worker that failed half way through a switch holds no
				// model it can be trusted with.
				const broken = slot.worker;

				slot.worker = null;
				slot.model = null;
				Promise.resolve().then(() => broken.terminate()).catch(() => {});

				throw err;
			}

			loads.push({lang, ms: Math.round(performance.now() - started), switched: true});
		}

		slot.model = lang;
		slot.current = '';
		ready.add(lang);
	};

	// The slot's load of `lang`, begun now or joined: {lang, done, expired,
	// timeout}. done settles when the model is on the worker; timeout
	// resolves `wait` after the load began.
	const begin = (slot, lang) => {
		if (slot.loading && slot.loading.lang === lang) {
			return slot.loading;
		}

		const load = {expired: false, lang};
		let timer = null;

		load.timeout = new Promise((resolve) => {
			timer = setTimeout(() => {
				load.expired = true;
				resolve();
			}, wait);
		});
		load.done = exclusive(slot, () => (slot.model === lang && slot.worker ? null : put(slot, lang)));
		slot.loading = load;
		load.done.then(() => {}, (err) => {
			if (!ready.has(lang) || !slot.worker) {
				failed = err || new Error(`The ${lang} model could not load.`);
			}
		}).finally(() => {
			clearTimeout(timer);

			if (slot.loading === load) {
				slot.loading = null;
			}
		});

		return load;
	};

	const state = (lang) => {
		if (!ready.has(lang) || failed) {
			return null;
		}

		const slot = slotFor(lang);

		return slot.model === lang && !slot.loading ? 'held' : 'ready';
	};

	return {
		loads,
		ocr(image, {lang, noWait = false, psm = '7', whitelist = ''} = {}) {
			if (!ASIAN_MODELS.includes(lang)) {
				return Promise.reject(new Error(`No ${lang} model.`));
			}

			if (failed) {
				return Promise.reject(new Error(`The ${lang} model could not load; it is tried again when the phone is back online.`));
			}

			const slot = slotFor(lang);

			// A load that is downloading a model holds the worker: a read
			// that may not wait gives up now.
			const downloading = slot.loading && !ready.has(slot.loading.lang);

			if (noWait && (!ready.has(lang) || downloading)) {
				return Promise.reject(new Error(`The ${lang} model is still loading.`));
			}

			return (async () => {
				// A load past its time holds the worker: every read gives up,
				// once what is left of this turn of the event loop has not
				// seen it finish, and none begins another load behind it.
				const stuck = slot.loading && slot.loading.expired ? slot.loading : null;

				if (stuck && await Promise.race([stuck.done.then(() => false, () => false), new Promise((resolve) => setTimeout(() => resolve(true), 0))])) {
					throw new Error(`The ${lang} model is still loading.`);
				}

				const load = ready.has(lang) ? slot.loading : begin(slot, lang);

				if (load) {
					const settled = await Promise.race([load.done.then(() => 'done', () => 'failed'), load.timeout.then(() => 'late')]);

					if (settled === 'late') {
						throw new Error(`The ${lang} model is still loading.`);
					}

					if (settled === 'failed' && load.lang === lang) {
						throw new Error(`The ${lang} model could not load.`);
					}
				}

				return exclusive(slot, async () => {
					if (slot.model !== lang) {
						// A model loaded before, put back after the other
						// one was read with.
						if (!ready.has(lang)) {
							throw new Error(`The ${lang} model is not loaded.`);
						}

						await put(slot, lang);
					}

					const key = `${psm}|${whitelist}`;

					if (key !== slot.current) {
						await slot.worker.setParameters({tessedit_char_whitelist: whitelist, tessedit_pageseg_mode: psm});
						slot.current = key;
					}

					const {data} = await slot.worker.recognize(toPgm(image), {}, {blocks: true, text: true});

					return {confidence: Math.round(data.confidence), lines: linesOf(data), text: data.text.trim()};
				});
			})();
		},
		// Starts loading `lang` behind whatever runs: for a card known to be
		// Japanese or Korean before its name is read, or for the next card
		// when this one could not wait.
		prepare(lang) {
			if (!ASIAN_MODELS.includes(lang) || failed || stopped || ready.has(lang)) {
				return;
			}

			begin(slotFor(lang), lang).done.catch(() => {});
		},
		get started() {
			return [...slots.values()].some((slot) => slot.worker || slot.loading);
		},
		state,
		terminate() {
			stopped = true;

			return Promise.all([...slots.values()].map((slot) => exclusive(slot, () => (slot.worker ? slot.worker.terminate() : null)).catch(() => {})));
		},
	};
}

// Starts the pool. The first worker is waited for; the second joins when it
// is up, so a read never waits for it. Returns {ocr, size, terminate,
// loadMs, trace, prepare, asianLoads, asianState}; ocr(image, {psm,
// whitelist, background, lang, noWait}) resolves to {confidence, lines,
// text}, like lab/js/ocr.js; background: true for a read nobody is waiting
// on (createSlots); lang 'jpn' or 'kor' for the Asian workers
// (createAsianReader), started on first use, one per model on a phone with
// the memory for two English workers; noWait for an Asian read that must
// not wait for its model to load; asianState(lang) whether that model is
// loaded (createAsianReader state). trace: the last TRACE_KEPT
// calls, {background, queued, started, ended, lang} (performance.now()),
// for the tests and the phone check.
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

	const asian = createAsianReader({logger, perModel: size >= 2});

	async function ocr(image, {background = false, lang = 'eng', noWait = false, psm = '7', whitelist = ''} = {}) {
		const call = {background, ended: null, queued: performance.now(), started: null, ...(lang === 'eng' ? {} : {lang})};

		trace.push(call);

		if (trace.length > TRACE_KEPT) {
			trace.shift();
		}

		if (lang !== 'eng') {
			call.started = performance.now();

			try {
				return await asian.ocr(image, {lang, noWait, psm, whitelist});
			}
			finally {
				call.ended = performance.now();
			}
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
		asianLoads: asian.loads,
		asianState: (lang) => asian.state(lang),
		loadMs,
		ocr,
		prepare: (lang) => asian.prepare(lang),
		get size() {
			return all.length;
		},
		terminate: () => {
			stopped = true;

			return Promise.all([...all.map((slot) => slot.worker.terminate()), asian.terminate()]);
		},
		trace,
	};
}
