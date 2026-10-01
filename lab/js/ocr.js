// The OCR engine: Tesseract.js, loaded only from lab/vendor/tesseract. No
// file is ever requested from a CDN: the worker, the WebAssembly core, and
// the English model are all given as same-origin URLs.

import Tesseract from '../vendor/tesseract/tesseract.esm.min.js';

const VENDOR = new URL('../vendor/tesseract/', import.meta.url).href;

export const TESSERACT_VERSION = '7.0.0';

// Starts one Tesseract worker with the LSTM engine. `langPath` may point at
// another folder holding an eng.traineddata.gz, which is how the benchmark
// compares models; the lab page always uses the vendored one.
//
// Returns {ocr, terminate, loadMs}, where ocr(image, {psm, whitelist})
// resolves to {confidence, lines, text}; each line is {text, words} and each
// word {bbox: {x0, x1, y0, y1}, confidence, text}. `image` is
// ImageData-shaped.
export async function createEngine({langPath = VENDOR + 'lang', logger = () => {}} = {}) {
	const started = performance.now();

	const worker = await Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
		cacheMethod: 'none',
		// A folder, so Tesseract picks the relaxed-SIMD, SIMD, or plain build
		// to suit the browser. All three are vendored.
		corePath: VENDOR + 'core',
		gzip: true,
		langPath,
		logger,
		workerBlobURL: false,
		workerPath: VENDOR + 'worker.min.js',
	});

	const loadMs = Math.round(performance.now() - started);
	const canvas = document.createElement('canvas');
	let current = '';

	async function ocr(image, {psm, whitelist}) {
		const key = psm + '|' + (whitelist || '');

		if (key !== current) {
			await worker.setParameters({
				tessedit_char_whitelist: whitelist || '',
				tessedit_pageseg_mode: psm,
			});
			current = key;
		}

		canvas.width = image.width;
		canvas.height = image.height;
		canvas.getContext('2d').putImageData(new ImageData(image.data, image.width, image.height), 0, 0);

		const {data} = await worker.recognize(canvas, {}, {blocks: true, text: true});
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

		return {confidence: Math.round(data.confidence), lines, text: data.text.trim()};
	}

	return {loadMs, ocr, terminate: () => worker.terminate()};
}
