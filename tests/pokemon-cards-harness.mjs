// A test harness for every card of a Pokémon (js/pokemon-cards.js,
// js/pokemon-cards-view.js, css/pokemon-cards.css).
//
// The screen is wired in by lines in shared files (app.js, index.html,
// sw.js, js/checklists-view.js). INTEGRATION lists those lines, and
// checkIntegration() asserts that each one is in the real file, so a change
// to a shared file that drops one fails with its name instead of silently
// testing an app without the screen. The browser tests run against the real
// files, served untouched by tests/pages-server.mjs.
//
// Run on its own: node tests/pokemon-cards-harness.mjs [port]

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

import {startPagesServer} from './pages-server.mjs';

const BASE = '/pokemon-card-tracker/';
const ROOT = new URL('../', import.meta.url);

// Each check: line (a whole line the file must hold) or pattern (a regular
// expression it must match), with the name a failure reports.
export const INTEGRATION = {
	'app.js': [
		{
			line: 'import {pokemonCardsAccountViews, pokemonCardsRoutes} from \'./js/pokemon-cards-view.js\';',
			name: 'app.js imports the routes and account views',
		},
		{
			name: 'app.js ROUTES holds ...pokemonCardsRoutes',
			pattern: /const ROUTES = \[\n(?:(?!\n\];)[\s\S])*?\n\t\.\.\.pokemonCardsRoutes,\n/,
		},
		{
			name: 'app.js ACCOUNT_ROUTES holds ...pokemonCardsAccountViews',
			pattern: /const ACCOUNT_ROUTES = new Set\(\[[^\]]*?, \.\.\.pokemonCardsAccountViews[,\]]/,
		},
	],
	'index.html': [
		{
			line: '\t<link rel="stylesheet" href="/pokemon-card-tracker/css/pokemon-cards.css">',
			name: 'index.html links css/pokemon-cards.css',
		},
	],
	'js/checklists-view.js': [
		{
			line: 'import {languagesControl, pokemonRoute} from \'./pokemon-cards-view.js\';',
			name: 'checklists-view.js imports languagesControl and pokemonRoute',
		},
		{
			line: '\tconst languages = languagesControl({listId: id, readOnly: source.readOnly});',
			name: 'checklistScreen makes the languages control',
		},
		{
			name: 'checklistScreen load() updates the languages control after goal = found;',
			pattern: /\n\t\tgoal = found;\n\t\tlanguages\.update\(goal\);\n/,
		},
		{
			// Whether a list's languages decide its ticks is still Eric's to
			// decide (plans/roadmap.md, "Open Decisions for Eric"), so the
			// checklist keeps ticking from a copy in any language.
			name: 'checklistScreen load() still ticks from every language',
			pattern: /\n\t\tconst resolved = await resolveOwned\(data\.entries, \{\n/,
		},
		{
			// After the meta line, with the v14 price stats bar kept.
			name: 'checklistScreen root.append shows the languages control after meta, and the stats bar',
			pattern: /\troot\.append\(\.\.\.\[back, title, meta, languages\.element, [^\]]*\bstatsSlot\b[^\]]*\]/,
		},
		{
			line: '\t\tconst entry = link(pokemonRoute(source.base, id, n), {class: \'dex-entry dex-link\'},',
			name: 'row(n) links the Pokémon to its cards',
		},
		{
			line: '\t\tconst tick = kind === \'owned\' || source.readOnly',
			name: 'row(n) shows the mark alone for an owned row or read only',
		},
		{
			line: '\t\treturn h(\'li\', {class: `dex-row dex-row-linked ${kind}`, \'data-dex\': n}, entry, tick);',
			name: 'row(n) returns the linked row',
		},
	],
	'sw.js': [
		{line: '\t\'js/pokemon-cards-view.js\',', name: 'sw.js SHELL lists js/pokemon-cards-view.js'},
		{line: '\t\'js/pokemon-cards.js\',', name: 'sw.js SHELL lists js/pokemon-cards.js'},
		{line: '\t\'css/pokemon-cards.css\',', name: 'sw.js SHELL lists css/pokemon-cards.css'},
	],
};

const read = (path) => readFile(new URL(path, ROOT), 'utf8');

// Every module the app loads, by repo path: the static imports from app.js
// down, plus dynamic imports with a literal path.
export async function moduleGraph() {
	const seen = new Set();
	const queue = [['app.js', await read('app.js')]];

	while (queue.length) {
		const [path, text] = queue.shift();

		for (const match of text.matchAll(/(?:from\s+|import\()\s*'(\.{1,2}\/[^']+)'/g)) {
			const target = new URL(match[1], new URL(path, 'file:///r/')).pathname.replace(/^\/r\//, '');

			if (seen.has(target)) {
				continue;
			}

			const source = await read(target).catch(() => null);

			// A path that is no file (an example in a comment) is skipped.
			if (source !== null) {
				seen.add(target);
				queue.push([target, source]);
			}
		}
	}

	return [...seen];
}

// Asserts that the real files carry every line in INTEGRATION, and that
// sw.js SHELL lists every module app.js loads, so the app opens offline.
export async function checkIntegration() {
	for (const [file, checks] of Object.entries(INTEGRATION)) {
		const text = await read(file);
		const lines = new Set(text.split('\n'));

		for (const check of checks) {
			if (check.line) {
				assert.ok(lines.has(check.line), `${file}: ${check.name}`);
			}
			else {
				assert.match(text, check.pattern, `${file}: ${check.name}`);
			}
		}
	}

	const sw = await read('sw.js');
	const listed = new Set([...sw.matchAll(/^\t'([^']+)',$/gm)].map((match) => match[1]));
	const missing = (await moduleGraph()).filter((path) => !listed.has(path)).sort();

	assert.deepEqual(missing, [], 'sw.js SHELL lists every module app.js loads');
}

// Checks the integration, then serves the real app. Returns {origin, close}.
export async function startHarness(port = 0) {
	await checkIntegration();

	const {close, origin} = await startPagesServer(port);

	return {close, origin};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const {origin} = await startHarness(Number(process.argv[2]) || 8002);

	console.log(`Serving the app with every card of a Pokémon at ${origin}${BASE}`);
}
