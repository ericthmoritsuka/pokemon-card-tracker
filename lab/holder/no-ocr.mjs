// A module hook for the replay (replay.mjs registers it): the scanner's OCR
// engine (js/scan/ocr.js) is swapped for one that never starts, so only the
// picture stage runs, as on a phone where the reader has not downloaded.

const STUB = 'data:text/javascript,export async function createPool() { throw new Error("OCR is off in the replay"); }';

export async function resolve(specifier, context, next) {
	if (/(^|\/)ocr\.js$/.test(specifier) && context.parentURL && context.parentURL.includes('/js/scan/')) {
		return {shortCircuit: true, url: STUB};
	}

	return next(specifier, context);
}
