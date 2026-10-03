// A static server for the fingerprint builder and measurements, driven in
// headless Chromium: /pokemon-card-tracker/ is this checkout, as GitHub
// Pages serves it (so js/scan/rectify.js and lab/ load by their real
// paths); /cache/ is the cache folder outside the repo, where the TCGdex
// images are kept; /photo is one photo given on the command line, read in
// place and never copied.

import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {dirname, extname, join, normalize, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const TYPES = {'.bin': 'application/octet-stream', '.css': 'text/css', '.html': 'text/html', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.js': 'text/javascript', '.json': 'application/json', '.mjs': 'text/javascript', '.png': 'image/png', '.webp': 'image/webp'};

export function startServer({cache, photo = null, repo = REPO}) {
	const mounts = [['/pokemon-card-tracker/', repo], ['/cache/', cache]];

	async function fileFor(pathname) {
		if (pathname === '/photo') {
			return photo;
		}

		for (const [prefix, root] of mounts) {
			if (!pathname.startsWith(prefix)) {
				continue;
			}

			const relative = normalize(decodeURIComponent(pathname.slice(prefix.length)));

			if (relative.startsWith('..')) {
				return null;
			}

			const file = join(root, relative);

			try {
				return (await stat(file)).isFile() ? file : null;
			}
			catch {
				return null;
			}
		}

		return null;
	}

	const server = createServer(async (request, response) => {
		const file = await fileFor(new URL(request.url, 'http://localhost').pathname);

		if (!file) {
			response.writeHead(404);
			response.end('Not found');

			return;
		}

		response.writeHead(200, {'cache-control': 'no-cache', 'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream'});
		createReadStream(file).pipe(response);
	});

	return new Promise((done) => {
		server.listen(0, '127.0.0.1', () => done({
			close: () => new Promise((closed) => {
				server.closeAllConnections();
				server.close(closed);
			}),
			origin: `http://127.0.0.1:${server.address().port}`,
		}));
	});
}

// Chromium from Playwright (PLAYWRIGHT=<path to its package>, or found by
// name), with a page on `path` under the server, once `ready` is true.
export async function openPage(server, path, ready = 'window.fpReady === true') {
	const {createRequire} = await import('node:module');
	const require = createRequire(import.meta.url);
	const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');
	const browser = await chromium.launch();
	const context = await browser.newContext();

	// The page reads only this server: no TCGdex, no fonts, nothing else.
	await context.route((url) => !url.href.startsWith(server.origin), (route) => route.abort());

	const page = await context.newPage();

	page.on('pageerror', (err) => console.error('pageerror', err.message));
	page.on('console', (msg) => msg.type() === 'error' && console.error('console', msg.text()));
	await page.goto(`${server.origin}${path}`);
	await page.waitForFunction(ready, null, {timeout: 60000});

	return {browser, context, page};
}
