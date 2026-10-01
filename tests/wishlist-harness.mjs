// A test harness for the wishlist (js/wishlist.js, js/wishlist-view.js).
// It starts tests/pages-server.mjs and serves the real app.js, index.html,
// and sw.js untouched: the wishlist's integration lines are in those files.
//
// INTEGRATION lists those lines, and checkIntegration asserts that each one
// is in the real file, so a change to a shared file that drops one fails the
// test instead of silently testing an app without the wishlist.
//
// Run on its own: node tests/wishlist-harness.mjs [port]

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

import {startPagesServer} from './pages-server.mjs';

const BASE = '/pokemon-card-tracker/';

export const INTEGRATION = {
	app: {
		// After the last import line.
		import: [
			'import {WISHLIST_ACCOUNT_VIEWS, WISHLIST_ROUTES} from \'./js/wishlist-view.js\';',
			'import {keepFamilyWishlistsCached} from \'./js/wishlist.js\';',
		],
		// An element of ROUTES.
		routes: '\t...WISHLIST_ROUTES,',
		// Inside the ACCOUNT_ROUTES Set.
		account: '...WISHLIST_ACCOUNT_VIEWS',
		// In startAccount, after startSync();
		cache: '\tkeepFamilyWishlistsCached();',
	},
	index: {
		// After the style.css link.
		stylesheet: '\t<link rel="stylesheet" href="/pokemon-card-tracker/css/wishlist.css">',
		// The Lists tab, whose Wishlist segment (js/dom.js listsSwitch)
		// opens the wishlist.
		tab: '\t\t<a href="/pokemon-card-tracker/lists" data-link="lists" data-tab="lists">',
	},
	sw: {
		// In SHELL.
		js: ['\t\'js/wishlist-view.js\',', '\t\'js/wishlist.js\','],
		css: '\t\'css/wishlist.css\',',
	},
};

const ROOT = new URL('../', import.meta.url);

const read = (path) => readFile(new URL(path, ROOT), 'utf8');

const lines = (text) => new Set(text.split('\n'));

// Asserts that the real app.js, index.html, and sw.js carry every line in
// INTEGRATION, and that sw.js SHELL lists every module app.js loads.
export async function checkIntegration() {
	const app = await read('app.js');
	const index = await read('index.html');
	const sw = await read('sw.js');
	const {account, cache, import: imports, routes} = INTEGRATION.app;

	for (const line of imports) {
		assert.ok(lines(app).has(line), `app.js imports: ${line}`);
	}

	const routesBody = /const ROUTES = \[\n([\s\S]*?)\n\];/.exec(app);

	assert.ok(routesBody, 'app.js has ROUTES');
	assert.ok(lines(routesBody[1]).has(routes), 'the wishlist routes are in ROUTES');

	const accountRoutes = /const ACCOUNT_ROUTES = new Set\(\[([^\]]*)\]\);/.exec(app);

	assert.ok(accountRoutes, 'app.js has ACCOUNT_ROUTES');
	assert.ok(accountRoutes[1].split(', ').includes(account), 'the wishlist views are in ACCOUNT_ROUTES');
	assert.match(app, /^\tstartSync\(\);\n\tkeepFamilyWishlistsCached\(\);$/m, `app.js runs ${cache.trim()} after startSync()`);

	const {stylesheet, tab} = INTEGRATION.index;

	assert.ok(lines(index).has(stylesheet), 'index.html links css/wishlist.css');

	const tabs = /<nav class="tabs"[^>]*>\n([\s\S]*?)<\/nav>/.exec(index);

	assert.ok(tabs, 'index.html has the tab bar');
	assert.ok(lines(tabs[1]).has(tab), 'the tab bar has the Lists tab');

	const {css, js} = INTEGRATION.sw;

	for (const line of [...js, css]) {
		assert.ok(lines(sw).has(line), `sw.js SHELL lists ${line.trim()}`);
	}

	const listed = new Set([...sw.matchAll(/^\t'([^']+)',$/gm)].map((match) => match[1]));
	const missing = (await moduleGraph(app)).filter((path) => !listed.has(path)).sort();

	assert.deepEqual(missing, [], 'sw.js SHELL lists every module app.js loads');
}

// Every module the app loads, by repo path: the static imports from app.js
// down, plus dynamic imports with a literal path.
async function moduleGraph(appText) {
	const seen = new Set();
	const queue = [['app.js', appText]];

	while (queue.length) {
		const [path, text] = queue.shift();

		for (const match of text.matchAll(/(?:from\s+|import\()\s*'(\.{1,2}\/[^']+)'/g)) {
			const target = new URL(match[1], new URL(path, 'file:///r/')).pathname.replace(/^\/r\//, '');

			if (!seen.has(target)) {
				seen.add(target);

				// A path that is no file (an example in a comment) is skipped.
				const source = await read(target).catch(() => null);

				if (source === null) {
					seen.delete(target);
				}
				else {
					queue.push([target, source]);
				}
			}
		}
	}

	return [...seen];
}

// Starts the Pages imitation, which serves the real files. Returns
// {origin, close}.
export function startHarness(port = 0) {
	return startPagesServer(port);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await checkIntegration();

	const {origin} = await startHarness(Number(process.argv[2]) || 8001);

	console.log(`Serving the app with the wishlist wired in at ${origin}${BASE}`);
}
