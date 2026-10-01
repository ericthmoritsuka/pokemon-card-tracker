// The scanner's entry for app.js: scanView, the render function of the
// /scan route (it replaces js/scan-placeholder.js), and scanRoutes, the same
// route in app.js's ROUTES shape for an app.js without a /scan route.
//
// The scanner's modules (and the OCR engine's 63 KB loader they import) load
// when /scan first opens, not with the app, so every other screen starts as
// fast as before. sw.js precaches them, so /scan still opens offline.

import {showError} from '../dom.js';

export function scanView(root, params) {
	let cleanup = null;
	let closed = false;

	import('./view.js')
		.then((module) => {
			if (!closed) {
				cleanup = module.scanView(root, params);
			}
		})
		.catch((err) => showError('The scanner did not open.', err));

	return () => {
		closed = true;

		if (cleanup) {
			cleanup();
		}
	};
}

export const scanRoutes = [
	{pattern: /^scan$/, render: scanView, tab: 'scan', title: 'Scan | Card Tracker'},
];
