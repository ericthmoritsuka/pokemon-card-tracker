// A local server that behaves like GitHub Pages for this repo: the repo is
// served under /pokemon-card-tracker/, a folder serves its index.html, and
// any path with no file gets 404.html with status 404.
//
// Run on its own: node tests/pages-server.mjs [port]

import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {extname, join, normalize, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BASE = '/pokemon-card-tracker/';

const TYPES = {
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
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

export function startPagesServer(port = 0) {
	const server = createServer(async (request, response) => {
		const {pathname} = new URL(request.url, 'http://localhost');
		const file = await fileFor(pathname);
		const target = file || join(ROOT, '404.html');

		response.writeHead(file ? 200 : 404, {
			'Cache-Control': 'no-cache',
			'Content-Type': TYPES[extname(target)] || 'application/octet-stream',
		});
		createReadStream(target).pipe(response);
	});

	return new Promise((done) => {
		server.listen(port, '127.0.0.1', () => {
			done({close: () => new Promise((closed) => server.close(closed)), origin: `http://localhost:${server.address().port}`, server});
		});
	});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const {origin} = await startPagesServer(Number(process.argv[2]) || 8000);

	console.log(`Serving ${origin}${BASE}`);
}
