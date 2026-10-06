// A test harness for the scanner (js/scan/*). It serves the repo the way
// GitHub Pages does (tests/pages-server.mjs, plus the OCR engine's file
// types) and serves the real app.js, index.html, and sw.js untouched: the
// scanner's integration lines are in those files.
//
// INTEGRATION lists those lines, and checkIntegration asserts that each one
// is in the real file, so a change to a shared file that drops one fails the
// test instead of silently testing an app without the scanner.
//
// It also builds what the browser tests feed Chrome's fake camera: a Y4M
// still of a TCGdex English high.webp scan laid on a table-colored
// background inside the guide frame, slightly turned. Card images and TCGdex
// API answers are fetched once and kept under /tmp, so later runs need no
// network.
//
// Run on its own: node tests/scan-harness.mjs [port]

import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
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
		// Replaces the placeholder's import; the /scan route in ROUTES
		// renders it.
		import: 'import {scanView} from \'./js/scan/routes.js\';',
		route: '\t{pattern: /^scan$/, render: scanView, tab: \'scan\', title: \'Scan | Card Tracker\'},',
	},
	index: {
		// After the last stylesheet link.
		stylesheet: '\t<link rel="stylesheet" href="/pokemon-card-tracker/css/scan.css">',
	},
	sw: {
		// In SHELL: the scanner's modules, the lab modules it imports, the
		// Tesseract.js loader those import (63 KB, imported only when a card
		// needs text), and its stylesheet.
		shell: [
			'\t\'js/scan/artwork.js\',',
			'\t\'js/scan/camera.js\',',
			'\t\'js/scan/draft.js\',',
			'\t\'js/scan/evidence.js\',',
			'\t\'js/scan/finish.js\',',
			'\t\'js/scan/identify.js\',',
			'\t\'js/scan/image.js\',',
			'\t\'js/scan/match.js\',',
			'\t\'js/scan/ocr.js\',',
			'\t\'js/scan/read.js\',',
			'\t\'js/scan/picture.js\',',
			'\t\'js/scan/rectify.js\',',
			'\t\'js/scan/routes.js\',',
			'\t\'js/scan/session.js\',',
			'\t\'js/scan/sheets.js\',',
			'\t\'js/scan/steady.js\',',
			'\t\'js/scan/tile.js\',',
			'\t\'js/scan/view.js\',',
			// The picture-first recogniser and its index (about 1.4 MB, 1.1 MB
			// gzipped), precached so the first scan needs no download.
			'\t\'js/vision/fingerprint.js\',',
			'\t\'js/vision/matcher.js\',',
			'\t\'js/vision/pack.js\',',
			'\t\'js/vision/index.bin\',',
			'\t\'lab/js/camera.js\',',
			'\t\'lab/js/match.js\',',
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
		// same shell" comment, so it runs before the lab's navigation bypass.
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

const read = (path) => readFile(join(ROOT, path), 'utf8');

const lines = (text) => new Set(text.split('\n'));

// Asserts that the real app.js, index.html, and sw.js carry every line in
// INTEGRATION, and that sw.js SHELL lists every module app.js loads.
export async function checkIntegration() {
	const app = await read('app.js');
	const index = await read('index.html');
	const sw = await read('sw.js');

	assert.ok(lines(app).has(INTEGRATION.app.import), 'app.js imports scanView from js/scan/routes.js');

	const routesBody = /const ROUTES = \[\n([\s\S]*?)\n\];/.exec(app);

	assert.ok(routesBody, 'app.js has ROUTES');
	assert.ok(lines(routesBody[1]).has(INTEGRATION.app.route), 'ROUTES renders /scan with scanView');
	assert.ok(!app.includes('scan-placeholder.js'), 'app.js no longer loads the placeholder');

	assert.ok(lines(index).has(INTEGRATION.index.stylesheet), 'index.html links css/scan.css');

	for (const line of INTEGRATION.sw.shell) {
		assert.ok(lines(sw).has(line), `sw.js SHELL lists ${line.trim()}`);
	}

	const ocrCache = INTEGRATION.sw.ocrCache.slice(1).join('\n');
	const ocrRoute = INTEGRATION.sw.ocrRoute.join('\n');
	const shellAt = sw.indexOf('const SHELL = [');
	const routeAt = sw.indexOf(ocrRoute);

	assert.ok(sw.includes(`${ocrCache}\n\nconst SHELL = [`), 'sw.js defines OCR_CACHE, OCR_PATH, and ocrResponse() just before SHELL');
	assert.ok(shellAt >= 0 && routeAt >= 0, 'the fetch handler answers the OCR engine\'s files');
	assert.ok(routeAt < sw.indexOf('// Every page in the app is the same shell'), 'the OCR route sits before the shell comment');
	assert.ok(routeAt < sw.indexOf('new URL(\'lab/\', self.registration.scope)'), 'the OCR route sits before the lab navigation bypass');

	const listed = new Set([...sw.matchAll(/^\t'([^']+)',$/gm)].map((match) => match[1]));
	const missing = (await moduleGraph(app)).filter((path) => !listed.has(path)).sort();

	assert.deepEqual(missing, [], 'sw.js SHELL lists every module app.js loads');

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
	'.woff2': 'font/woff2',
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

// Checks the integration, then starts the Pages imitation over the real
// files. Returns {origin, close, requests}: requests counts what was served,
// by path.
export async function startScanHarness(port = 0) {
	await checkIntegration();

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

// A GraphQL query is a POST to one URL, so its body is part of the name.
const safeName = (url, body = '') => url.replace(/^https:\/\//, '').replace(/[^a-zA-Z0-9.-]+/g, '_').slice(0, 180)
	+ (body ? `_${createHash('sha1').update(body).digest('hex').slice(0, 16)}` : '');

// Answers https://api.tcgdex.net, https://assets.tcgdex.net, and PokeAPI
// (the species names the scanner's name route reads) from files under
// CACHE_DIR, fetching and keeping each one the first time. net.offline makes
// every request fail as a dropped connection. counts records what was
// asked, by kind.
export async function routeTcgdex(context, net = {offline: false}) {
	const dir = join(CACHE_DIR, 'tcgdex');

	await mkdir(dir, {recursive: true});

	const counts = {api: 0, images: 0};

	const answer = async (route, kind) => {
		const request = route.request();
		const url = request.url();
		const body = request.method() === 'POST' ? request.postData() || '' : '';

		counts[kind]++;

		if (net.offline) {
			return route.abort('internetdisconnected');
		}

		const file = join(dir, safeName(url, body));
		const meta = `${file}.meta.json`;

		if (await exists(meta)) {
			const {contentType, status} = JSON.parse(await readFile(meta, 'utf8'));

			return route.fulfill({body: await readFile(file), contentType, headers: {'access-control-allow-origin': '*'}, status});
		}

		let response;

		try {
			response = await fetch(url, body ? {body, headers: {'content-type': 'application/json'}, method: 'POST'} : {});
		}
		catch {
			return route.abort('internetdisconnected');
		}

		const answerBody = Buffer.from(await response.arrayBuffer());
		const contentType = response.headers.get('content-type') || 'application/octet-stream';

		// Server errors are passed on but never kept.
		if (response.status < 500) {
			await writeFile(file, answerBody);
			await writeFile(meta, JSON.stringify({contentType, status: response.status}));
		}

		return route.fulfill({body: answerBody, contentType, headers: {'access-control-allow-origin': '*'}, status: response.status});
	};

	await context.route('https://api.tcgdex.net/**', (route) => answer(route, 'api'));
	await context.route('https://assets.tcgdex.net/**', (route) => answer(route, 'images'));
	await context.route(/^https:\/\/(graphql\.)?pokeapi\.co\//, (route) => answer(route, 'api'));

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
// hideNumber blurs the bottom 12 % of the card out of reading, as a thumb,
// a sleeve edge, or a bad photo would, so only the top of the card reads.
//
// screen draws the card as a photo of it shown in an app on a laptop: a
// dark screen instead of the table, the app's `heading` in large light
// letters just above the card, the app's text to its right, a button under
// it, and the screen's edge as a long straight line in the capture margin
// past the card's right side. screen.keystone (top width over bottom width)
// draws the card as seen at a slant, wider at the top. screen.fit says
// what `fill` measures: 'width', the card's widest row against the guide's
// width (so a keystoned card is shorter than the guide, with the heading
// inside the capture), or 'height', the card's height against the guide's
// (so its top runs past the guide's sides into the margin).
//
// Uses `browser` (Playwright) to decode the WebP and draw the frame.
export async function cardVideo(browser, cardId, {angle = 0.8, fill = 0.97, height = 1920, hideNumber = false, screen = null, width = 1080} = {}) {
	const dir = join(CACHE_DIR, 'video');
	const look = screen ? `-screen-${String(screen.heading).replace(/[^a-z0-9]+/gi, '_')}-${screen.keystone || 1}-${screen.fit || 'width'}` : '';
	const file = join(dir, `${cardId}-${width}x${height}-${angle}-${fill}${hideNumber ? '-nonumber' : ''}${look}.y4m`);

	await mkdir(dir, {recursive: true});

	if (await exists(file)) {
		return file;
	}

	const webp = (await readFile(await cardImage(cardId))).toString('base64');
	const page = await browser.newPage();
	const rgba = Buffer.from(await page.evaluate(async ({angle, fill, height, hideNumber, screen, webp, width}) => {
		const img = new Image();

		img.src = `data:image/webp;base64,${webp}`;
		await img.decode();

		let face = img;

		if (hideNumber) {
			face = document.createElement('canvas');
			face.width = img.naturalWidth;
			face.height = img.naturalHeight;

			const faceCtx = face.getContext('2d');
			const cut = Math.round(face.height * 0.88);

			faceCtx.drawImage(img, 0, 0);
			faceCtx.filter = 'blur(6px)';
			faceCtx.drawImage(img, 0, cut, face.width, face.height - cut, 0, cut, face.width, face.height - cut);
		}

		const canvas = document.createElement('canvas');

		canvas.width = width;
		canvas.height = height;

		const ctx = canvas.getContext('2d');

		ctx.fillStyle = screen ? '#1b1b20' : '#7a6250';
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

		if (!screen) {
			ctx.drawImage(face, -gw * fill / 2, -gh * fill / 2, gw * fill, gh * fill);
		}
		else {
			// The card's widths at its top and bottom, their mean the card's
			// own shape for its height.
			const keystone = screen.keystone || 1;
			const ch = screen.fit === 'height' ? gh * fill : (gw * fill * (1 + keystone)) / (2 * keystone) * 88 / 63;
			const mean = ch * 63 / 88;
			const top = (mean * 2 * keystone) / (1 + keystone);
			const bottom = (mean * 2) / (1 + keystone);
			const edge = Math.max(top, bottom) / 2 + gw * 0.04;

			ctx.fillStyle = '#e8c8cc';
			ctx.font = `bold ${Math.round(ch * 0.045)}px sans-serif`;
			ctx.fillText(screen.heading, -mean / 2, -ch / 2 - ch * 0.04);
			ctx.fillStyle = '#d0d0d8';
			ctx.font = `bold ${Math.round(ch * 0.03)}px sans-serif`;

			// Right beside the card's sides at its middle, the app's details
			// on the right and its menu on the left (the card, drawn after,
			// covers what falls under its wider top).
			for (const [i, word] of ['Set', 'Name', 'No.', '001', 'Rarity', 'Common', 'Illus.', 'Eng'].entries()) {
				ctx.textAlign = 'left';
				ctx.fillText(word, mean / 2 + gw * 0.03, -ch * 0.4 + i * ch * 0.08);
				ctx.textAlign = 'right';
				ctx.fillText(['Cards', 'Sets', 'Scan', 'Lists', 'Binders', 'Trade', 'Help', 'Profile'][i], -mean / 2 - gw * 0.03, -ch * 0.4 + i * ch * 0.08);
			}

			ctx.textAlign = 'left';

			ctx.fillStyle = '#2c2c33';
			ctx.fillRect(-mean * 0.4, ch / 2 + ch * 0.02, mean * 0.8, ch * 0.06);
			ctx.fillStyle = '#d0d0d8';
			ctx.fillText('Add photo', -mean * 0.1, ch / 2 + ch * 0.065);
			ctx.fillStyle = '#050505';
			ctx.fillRect(edge, -height, width, height * 2);

			// Row by row, in perspective: the card turned back about its
			// horizontal axis, so a row of the card a share v down it lands a
			// share s = keystone v / (1 + (keystone - 1) v) down the drawing,
			// at width top / (1 + (keystone - 1) v).
			const rows = Math.round(ch);

			for (let row = 0; row < rows; row++) {
				const s = (row + 0.5) / rows;
				const v = s / (keystone - s * (keystone - 1));
				const w = top / (1 + (keystone - 1) * v);

				ctx.drawImage(face, 0, Math.min(face.height - 1, v * face.height), face.width, Math.max(1, face.height / rows), -w / 2, -ch / 2 + row, w, 1.5);
			}
		}

		const data = ctx.getImageData(0, 0, width, height).data;
		let binary = '';

		for (let i = 0; i < data.length; i += 0x8000) {
			binary += String.fromCharCode.apply(null, data.subarray(i, i + 0x8000));
		}

		return btoa(binary);
	}, {angle, fill, height, hideNumber, screen, webp, width}), 'base64');

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

	console.log(`Serving the app with the scanner at ${origin}${BASE}scan`);
}
