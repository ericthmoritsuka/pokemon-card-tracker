// A test harness for the scanner (js/scan/*). The scanner is a
// self-contained module: app.js, index.html, and sw.js do not carry its
// integration lines yet. This harness serves the repo the way GitHub Pages
// does (tests/pages-server.mjs) and adds those lines to its copies of the
// three shell files in memory, so the browser runs the app as it will be once
// they are added. INTEGRATION is the exact text to add; the files on disk are
// never written.
//
// It also builds what the browser tests feed Chrome's fake camera: a Y4M
// still of a TCGdex English high.webp scan laid on a table-colored
// background inside the guide frame, slightly turned. Card images and TCGdex
// API answers are fetched once and kept under /tmp, so later runs need no
// network.
//
// Run on its own: node tests/scan-harness.mjs [port]

import assert from 'node:assert/strict';
import {createReadStream} from 'node:fs';
import {mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {extname, join, normalize, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BASE = '/pokemon-card-tracker/';

export const CACHE_DIR = process.env.SCAN_CACHE || '/tmp/scan-harness-cache';

// ------------------------------------------------------------ integration lines

export const INTEGRATION = {
	app: {
		// app.js already routes /scan to js/scan-placeholder.js; the scanner
		// replaces that one import line.
		placeholder: 'import {scanView} from \'./js/scan-placeholder.js\';',
		import: 'import {scanView} from \'./js/scan/routes.js\';',
		// For an app.js with no /scan route: this import, and the route in
		// ROUTES after ...WISHLIST_ROUTES,
		importRoutes: 'import {scanRoutes} from \'./js/scan/routes.js\';',
		routes: '\t...scanRoutes,',
	},
	index: {
		// After the last stylesheet link.
		stylesheet: '\t<link rel="stylesheet" href="/pokemon-card-tracker/css/scan.css">',
	},
	sw: {
		// In SHELL: the scanner's modules, the lab modules it imports, the
		// Tesseract.js loader those import (63 KB), and its stylesheet.
		shell: [
			'\t\'js/scan/camera.js\',',
			'\t\'js/scan/draft.js\',',
			'\t\'js/scan/finish.js\',',
			'\t\'js/scan/identify.js\',',
			'\t\'js/scan/image.js\',',
			'\t\'js/scan/match.js\',',
			'\t\'js/scan/routes.js\',',
			'\t\'js/scan/session.js\',',
			'\t\'js/scan/sheets.js\',',
			'\t\'js/scan/steady.js\',',
			'\t\'js/scan/tile.js\',',
			'\t\'js/scan/view.js\',',
			'\t\'lab/js/camera.js\',',
			'\t\'lab/js/match.js\',',
			'\t\'lab/js/ocr.js\',',
			'\t\'lab/js/pipeline.js\',',
			'\t\'lab/js/rectify.js\',',
			'\t\'lab/vendor/tesseract/tesseract.esm.min.js\',',
			'\t\'css/scan.css\',',
		],
		// Just before `const SHELL = [`.
		ocrCache: [
			'',
			'// The OCR engine\'s worker, WebAssembly core, and English model, kept the',
			'// first time the scanner starts the engine (about 7 MB on a phone: the one',
			'// core of three that suits its browser, plus the 2.9 MB model). The cache is',
			'// named for the Tesseract.js version rather than VERSION, so a new app',
			'// version does not download them again, and activate leaves it alone.',
			'const OCR_CACHE = \'card-tracker-ocr-tesseract-7.0.0\';',
			'const OCR_PATH = \'lab/vendor/tesseract/\';',
			'',
			'async function ocrResponse(event) {',
			'\tconst cache = await caches.open(OCR_CACHE);',
			'\tconst hit = await cache.match(event.request, {ignoreSearch: true});',
			'',
			'\tif (hit) {',
			'\t\treturn hit;',
			'\t}',
			'',
			'\tconst response = await fetch(event.request);',
			'',
			'\tif (response.ok) {',
			'\t\tconst copy = response.clone();',
			'',
			'\t\tevent.waitUntil(cache.put(event.request, copy).catch(() => {}));',
			'\t}',
			'',
			'\treturn response;',
			'}',
		],
		// In the fetch handler, just before the "Every page in the app is the
		// same shell" comment.
		ocrRoute: [
			'\t// The OCR engine\'s files: cache first, kept on first use (ocrResponse).',
			'\tif (url.pathname.startsWith(new URL(OCR_PATH, self.registration.scope).pathname) && !url.pathname.endsWith(\'.esm.min.js\')) {',
			'\t\tevent.respondWith(ocrResponse(event));',
			'',
			'\t\treturn;',
			'\t}',
			'',
		],
	},
};

const insertAfter = (text, anchor, lines, label) => {
	const at = text.indexOf(anchor);

	assert.ok(at >= 0, `${label}: anchor not found: ${anchor}`);

	const end = text.indexOf('\n', at) + 1;

	return text.slice(0, end) + lines.join('\n') + '\n' + text.slice(end);
};

const insertBefore = (text, anchor, lines, label) => {
	const at = text.indexOf(anchor);

	assert.ok(at >= 0, `${label}: anchor not found: ${anchor}`);

	const start = text.lastIndexOf('\n', at) + 1;

	return text.slice(0, start) + lines.join('\n') + '\n' + text.slice(start);
};

export function patchApp(text) {
	const {import: line, importRoutes, placeholder, routes} = INTEGRATION.app;

	if (text.includes(placeholder)) {
		return text.replace(placeholder, line);
	}

	const imports = [...text.matchAll(/^import .*;$/gm)];
	const out = insertAfter(text, imports[imports.length - 1][0], [importRoutes], 'app.js import');

	return insertAfter(out, '\t...WISHLIST_ROUTES,', [routes], 'app.js routes');
}

export function patchIndex(text) {
	const links = [...text.matchAll(/^\t<link rel="stylesheet" href="\/pokemon-card-tracker\/[^"]+\.css">$/gm)];

	return insertAfter(text, links[links.length - 1][0], [INTEGRATION.index.stylesheet], 'index.html stylesheet');
}

export function patchSw(text) {
	let out = text.replace(/const VERSION = '([^']+)';/, (line, version) => `const VERSION = '${version}-scan';`);

	out = insertAfter(out, '\t\'css/wishlist.css\',', INTEGRATION.sw.shell, 'sw.js SHELL');
	out = insertBefore(out, 'const SHELL = [', [...INTEGRATION.sw.ocrCache.slice(1), ''], 'sw.js caches');
	out = insertBefore(out, '// Every page in the app is the same shell', INTEGRATION.sw.ocrRoute, 'sw.js fetch');

	return out;
}

const read = (path) => readFile(join(ROOT, path), 'utf8');

// Checks that the patches apply to the files as they are now, and that the
// patched sw.js SHELL lists every module the patched app.js loads.
export async function checkIntegration() {
	const app = patchApp(await read('app.js'));
	const index = patchIndex(await read('index.html'));
	const sw = patchSw(await read('sw.js'));

	assert.ok(app.includes(INTEGRATION.app.import) || (app.includes(INTEGRATION.app.importRoutes) && app.includes(INTEGRATION.app.routes)), 'app.js routes /scan to the scanner');
	assert.ok(!app.includes('scan-placeholder.js'), 'app.js no longer loads the placeholder');
	assert.ok(index.includes(INTEGRATION.index.stylesheet));

	const listed = new Set([...sw.matchAll(/^\t'([^']+)',$/gm)].map((match) => match[1]));
	const missing = (await moduleGraph(app)).filter((path) => !listed.has(path)).sort();

	assert.deepEqual(missing, [], 'the patched sw.js SHELL lists every module the patched app.js loads');
	assert.ok(sw.includes('event.respondWith(ocrResponse(event));'));

	return {app, index, sw};
}

async function moduleGraph(appText) {
	const seen = new Set();
	const queue = [['app.js', appText]];

	while (queue.length) {
		const [path, text] = queue.shift();

		for (const match of text.matchAll(/(?:from\s+|import\()\s*'(\.{1,2}\/[^']+)'/g)) {
			const target = new URL(match[1], new URL(path, 'file:///r/')).pathname.replace(/^\/r\//, '');

			if (!seen.has(target)) {
				const source = await read(target).catch(() => null);

				if (source !== null) {
					seen.add(target);
					queue.push([target, source]);
				}
			}
		}
	}

	return [...seen];
}

// ------------------------------------------------------------ the server

const TYPES = {
	'.css': 'text/css; charset=utf-8',
	'.gz': 'application/gzip',
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.wasm': 'application/wasm',
	'.webmanifest': 'application/manifest+json',
};

async function fileFor(pathname) {
	if (!pathname.startsWith(BASE)) {
		return null;
	}

	const relative = normalize(decodeURIComponent(pathname.slice(BASE.length)));

	if (relative.startsWith('..')) {
		return null;
	}

	let file = join(ROOT, relative);

	try {
		const info = await stat(file);

		if (info.isDirectory()) {
			file = join(file, 'index.html');
			await stat(file);
		}

		return file;
	}
	catch {
		return null;
	}
}

// Starts the Pages imitation with the patched shell files. Returns
// {origin, close, requests}: requests counts what was served, by path.
export async function startScanHarness(port = 0) {
	const patched = await checkIntegration();
	const shell = new Map([
		[join(ROOT, 'app.js'), patched.app],
		[join(ROOT, 'index.html'), patched.index],
		[join(ROOT, 'sw.js'), patched.sw],
	]);
	const requests = new Map();

	const server = createServer(async (request, response) => {
		const {pathname} = new URL(request.url, 'http://localhost');
		const file = await fileFor(pathname);
		const target = file || join(ROOT, '404.html');

		requests.set(pathname, (requests.get(pathname) || 0) + 1);
		response.writeHead(file ? 200 : 404, {
			'Cache-Control': 'no-cache',
			'Content-Type': TYPES[extname(target)] || 'application/octet-stream',
		});

		if (shell.has(target)) {
			response.end(shell.get(target));

			return;
		}

		createReadStream(target).pipe(response);
	});

	return new Promise((done) => {
		server.listen(port, '127.0.0.1', () => {
			done({
				close: () => new Promise((closed) => {
					server.closeAllConnections && server.closeAllConnections();
					server.close(closed);
				}),
				origin: `http://localhost:${server.address().port}`,
				requests,
			});
		});
	});
}

// ------------------------------------------------------------ TCGdex, recorded

async function exists(path) {
	try {
		await stat(path);

		return true;
	}
	catch {
		return false;
	}
}

const safeName = (url) => url.replace(/^https:\/\//, '').replace(/[^a-zA-Z0-9.-]+/g, '_');

// Answers https://api.tcgdex.net and https://assets.tcgdex.net from files
// under CACHE_DIR, fetching and keeping each one the first time. net.offline
// makes every request fail as a dropped connection. counts records what was
// asked, by kind.
export async function routeTcgdex(context, net = {offline: false}) {
	const dir = join(CACHE_DIR, 'tcgdex');

	await mkdir(dir, {recursive: true});

	const counts = {api: 0, images: 0};

	const answer = async (route, kind) => {
		const url = route.request().url();

		counts[kind]++;

		if (net.offline) {
			return route.abort('internetdisconnected');
		}

		const file = join(dir, safeName(url));
		const meta = `${file}.meta.json`;

		if (await exists(meta)) {
			const {contentType, status} = JSON.parse(await readFile(meta, 'utf8'));

			return route.fulfill({body: await readFile(file), contentType, headers: {'access-control-allow-origin': '*'}, status});
		}

		let response;

		try {
			response = await fetch(url);
		}
		catch {
			return route.abort('internetdisconnected');
		}

		const body = Buffer.from(await response.arrayBuffer());
		const contentType = response.headers.get('content-type') || 'application/octet-stream';

		// Server errors are passed on but never kept.
		if (response.status < 500) {
			await writeFile(file, body);
			await writeFile(meta, JSON.stringify({contentType, status: response.status}));
		}

		return route.fulfill({body, contentType, headers: {'access-control-allow-origin': '*'}, status: response.status});
	};

	await context.route('https://api.tcgdex.net/**', (route) => answer(route, 'api'));
	await context.route('https://assets.tcgdex.net/**', (route) => answer(route, 'images'));

	return counts;
}

// ------------------------------------------------------------ the fake camera

// A TCGdex English card scan (high.webp, 600 x 825), downloaded once.
export async function cardImage(cardId) {
	const dir = join(CACHE_DIR, 'cards');
	const file = join(dir, `${cardId}.webp`);

	await mkdir(dir, {recursive: true});

	if (await exists(file)) {
		return file;
	}

	const card = await (await fetch(`https://api.tcgdex.net/v2/en/cards/${encodeURIComponent(cardId)}`)).json();

	assert.ok(card.image, `TCGdex has an image for ${cardId}`);

	const response = await fetch(`${card.image}/high.webp`);

	assert.ok(response.ok, `TCGdex served ${cardId}'s image (${response.status})`);
	await writeFile(file, Buffer.from(await response.arrayBuffer()));

	return file;
}

// Writes a Y4M still (one frame, which Chrome repeats) of the card inside the
// guide frame the scanner draws: 97 % of the guide's size, turned by `angle`
// degrees, over a wood-colored table. width x height is the camera frame.
// Uses `browser` (Playwright) to decode the WebP and draw the frame.
export async function cardVideo(browser, cardId, {angle = 0.8, fill = 0.97, height = 1920, width = 1080} = {}) {
	const dir = join(CACHE_DIR, 'video');
	const file = join(dir, `${cardId}-${width}x${height}-${angle}-${fill}.y4m`);

	await mkdir(dir, {recursive: true});

	if (await exists(file)) {
		return file;
	}

	const webp = (await readFile(await cardImage(cardId))).toString('base64');
	const page = await browser.newPage();
	const rgba = Buffer.from(await page.evaluate(async ({angle, fill, height, webp, width}) => {
		const img = new Image();

		img.src = `data:image/webp;base64,${webp}`;
		await img.decode();

		const canvas = document.createElement('canvas');

		canvas.width = width;
		canvas.height = height;

		const ctx = canvas.getContext('2d');

		ctx.fillStyle = '#7a6250';
		ctx.fillRect(0, 0, width, height);

		// lab/js/pipeline.js guideRect with lab/js/camera.js GUIDE_FILL.
		let gh = height * 0.86;
		let gw = gh * 63 / 88;

		if (gw > width * 0.86) {
			gw = width * 0.86;
			gh = gw / (63 / 88);
		}

		ctx.translate(width / 2, height / 2);
		ctx.rotate(angle * Math.PI / 180);
		ctx.drawImage(img, -gw * fill / 2, -gh * fill / 2, gw * fill, gh * fill);

		const data = ctx.getImageData(0, 0, width, height).data;
		let binary = '';

		for (let i = 0; i < data.length; i += 0x8000) {
			binary += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
		}

		return btoa(binary);
	}, {angle, fill, height, webp, width}), 'base64');

	await page.close();

	const y = Buffer.alloc(width * height);
	const u = Buffer.alloc((width * height) / 4);
	const v = Buffer.alloc((width * height) / 4);
	const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));

	for (let i = 0; i < width * height; i++) {
		y[i] = clamp(0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]);
	}

	for (let row = 0; row < height / 2; row++) {
		for (let col = 0; col < width / 2; col++) {
			let r = 0;
			let g = 0;
			let b = 0;

			for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
				const i = ((row * 2 + dy) * width + col * 2 + dx) * 4;

				r += rgba[i] / 4;
				g += rgba[i + 1] / 4;
				b += rgba[i + 2] / 4;
			}

			u[row * (width / 2) + col] = clamp(128 - 0.168736 * r - 0.331264 * g + 0.5 * b);
			v[row * (width / 2) + col] = clamp(128 + 0.5 * r - 0.418688 * g - 0.081312 * b);
		}
	}

	await writeFile(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420jpeg\nFRAME\n`), y, u, v]));

	return file;
}

// Chrome's flags for a fake rear camera showing `video`.
export const fakeCameraArgs = (video) => [
	'--use-fake-device-for-media-stream',
	'--use-fake-ui-for-media-stream',
	`--use-file-for-fake-video-capture=${video}`,
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const {origin} = await startScanHarness(Number(process.argv[2]) || 8002);

	console.log(`Serving the app with the scanner wired in at ${origin}${BASE}scan`);
}
