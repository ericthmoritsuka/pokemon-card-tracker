// Static server for the scan benchmark. /pokemon-card-tracker/ is the tree
// being measured (REPO, by default the repo this folder is in), served as
// GitHub Pages serves it; /bench/ is this folder; /cache/ is the cache
// folder outside the repo, where the TCGdex card images are kept; /photo is
// the one photo given with --photo, read in place.

import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import {dirname, extname, join, normalize, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const TYPES = {'.css': 'text/css', '.html': 'text/html', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.js': 'text/javascript', '.json': 'application/json', '.mjs': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.webp': 'image/webp'};

export function startServer({cache, photo = null, repo = process.env.REPO || resolve(HERE, '../..')}) {
	const mounts = [['/pokemon-card-tracker/', repo], ['/bench/', HERE], ['/cache/', cache]];

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

			let file = join(root, relative);

			try {
				if ((await stat(file)).isDirectory()) {
					file = join(file, 'index.html');
					await stat(file);
				}

				return file;
			}
			catch {
				return null;
			}
		}

		return null;
	}

	const server = createServer(async (request, response) => {
		const {pathname} = new URL(request.url, 'http://localhost');
		const file = await fileFor(pathname);

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
