// A test harness for every card of a Pokémon (js/pokemon-cards.js,
// js/pokemon-cards-view.js, css/pokemon-cards.css).
//
// The screen's integration lines belong in shared files other work is
// editing (app.js, index.html, sw.js, js/checklists-view.js), so they are
// not in those files yet. INTEGRATION lists them as edits, each anchored on
// a line the file holds today, and this harness serves the real files with
// the edits applied, so the tests run the real app with the screen wired in
// exactly as those lines describe. Every other file is the real one, from
// tests/pages-server.mjs. An anchor that is gone fails the run with its
// name, rather than testing an app without the screen.
//
// Once the lines are in the real files, applyIntegration() leaves a file
// alone when its edits are already there.
//
// Run on its own: node tests/pokemon-cards-harness.mjs [port]

import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';

import {startPagesServer} from './pages-server.mjs';

const BASE = '/pokemon-card-tracker/';
const ROOT = new URL('../', import.meta.url);

// The new checklist row: the row opens the Pokémon's cards, and the mark on
// the right is the hand tick.
const ROW = `	// A row opens every card of its Pokémon (js/pokemon-cards-view.js). The
	// mark on the right ticks a missing Pokémon by hand, or clears the tick.
	function row(n) {
		const {entries, kind} = state(n);
		const name = nameOf(names, n);
		const entry = link(pokemonRoute(source.base, id, n), {class: 'dex-entry dex-link'},
			sprite(n, name),
			h('span', {class: 'dex-text'},
				h('span', {class: 'dex-num'}, dexLabel(n)),
				h('span', {class: 'dex-name'}, name)
			)
		);
		const tick = kind === 'owned' || source.readOnly
			? h('span', {class: 'dex-tick'}, mark(kind, entries.length))
			: h('button', {
				'aria-label': \`\${dexLabel(n)} \${name}, \${kind === 'hand' ? 'marked by hand. Tap to clear the mark' : 'missing. Tap to mark by hand'}\`,
				'aria-pressed': kind === 'hand' ? 'true' : 'false',
				class: 'dex-tick',
				onclick: () => toggleHand(n),
				type: 'button',
			}, mark(kind, entries.length));

		return h('li', {class: \`dex-row dex-row-linked \${kind}\`, 'data-dex': n}, entry, tick);
	}

`;

// Each edit: after (insert lines after the anchor line), replace (swap the
// anchor text), or block (replace from the anchor line up to, not
// including, the until line). done is text that shows the edit is in.
export const INTEGRATION = {
	'app.js': [
		{
			after: 'import {startPhotoSync} from \'./js/photos/index.js\';',
			done: 'import {pokemonCardsAccountViews, pokemonCardsRoutes} from \'./js/pokemon-cards-view.js\';',
			lines: ['import {pokemonCardsAccountViews, pokemonCardsRoutes} from \'./js/pokemon-cards-view.js\';'],
			name: 'app.js import',
		},
		{
			after: '\t{keys: [\'userId\', \'id\'], pattern: /^family\\/([^/]+)\\/lists\\/([^/]+)$/, render: familyChecklistView, tab: \'lists\', title: \'Family list | Card Tracker\'},',
			done: '\t...pokemonCardsRoutes,',
			lines: ['\t...pokemonCardsRoutes,'],
			name: 'app.js ROUTES, after the family checklist route',
		},
		{
			done: '...pokemonCardsAccountViews]);',
			name: 'app.js ACCOUNT_ROUTES, at the end of the Set',
			replace: '...WISHLIST_ACCOUNT_VIEWS]);',
			with: '...WISHLIST_ACCOUNT_VIEWS, ...pokemonCardsAccountViews]);',
		},
	],
	'index.html': [
		{
			after: '\t<link rel="stylesheet" href="/pokemon-card-tracker/css/photos.css">',
			done: '\t<link rel="stylesheet" href="/pokemon-card-tracker/css/pokemon-cards.css">',
			lines: ['\t<link rel="stylesheet" href="/pokemon-card-tracker/css/pokemon-cards.css">'],
			name: 'index.html stylesheet, after the last one',
		},
	],
	'js/checklists-view.js': [
		{
			after: 'import {cardNames, hasOwnNames, searchKey, speciesSearchTerms} from \'./names.js\';',
			done: 'import {languagesControl, pokemonRoute} from \'./pokemon-cards-view.js\';',
			lines: ['import {languagesControl, pokemonRoute} from \'./pokemon-cards-view.js\';'],
			name: 'checklists-view.js import',
		},
		{
			after: '\tconst meta = h(\'p\', {class: \'muted\', id: \'checklist-meta\'});',
			done: '\tconst languages = languagesControl({listId: id, readOnly: source.readOnly});',
			lines: ['\tconst languages = languagesControl({listId: id, readOnly: source.readOnly});'],
			name: 'checklists-view.js checklistScreen, the languages control',
		},
		{
			after: '\t\tgoal = found;',
			done: '\t\tlanguages.update(goal);',
			lines: ['\t\tlanguages.update(goal);'],
			name: 'checklists-view.js load(), after goal = found;',
		},
		{
			done: '[back, title, meta, languages.element, summary,',
			name: 'checklists-view.js checklistScreen root.append',
			replace: '[back, title, meta, summary, status, filter, empty, list, editor, actions]',
			with: '[back, title, meta, languages.element, summary, status, filter, empty, list, editor, actions]',
		},
		{
			block: '\tfunction row(n) {',
			done: 'link(pokemonRoute(source.base, id, n)',
			name: 'checklists-view.js row(n), replaced',
			text: ROW,
			until: '\tfunction drawList() {',
		},
	],
	'sw.js': [
		{
			after: '\t\'js/phone-check.js\',',
			done: '\t\'js/pokemon-cards.js\',',
			lines: ['\t\'js/pokemon-cards-view.js\',', '\t\'js/pokemon-cards.js\','],
			name: 'sw.js SHELL, the modules',
		},
		{
			after: '\t\'css/photos.css\',',
			done: '\t\'css/pokemon-cards.css\',',
			lines: ['\t\'css/pokemon-cards.css\','],
			name: 'sw.js SHELL, the stylesheet',
		},
		{
			// Bump VERSION by one, so installed phones fetch the new shell.
			done: null,
			name: 'sw.js VERSION',
			version: true,
		},
	],
};

function applyEdit(text, edit, file) {
	if (edit.version) {
		return text.replace(/^const VERSION = 'v(\d+)';$/m, (line, n) => `const VERSION = 'v${Number(n) + 1}';`);
	}

	if (edit.done && text.includes(edit.done)) {
		return text;
	}

	const fail = () => {
		throw new Error(`${file}: the anchor for "${edit.name}" is gone. Update INTEGRATION in tests/pokemon-cards-harness.mjs.`);
	};

	if (edit.after) {
		const lines = text.split('\n');
		const at = lines.indexOf(edit.after);

		if (at < 0) {
			fail();
		}

		lines.splice(at + 1, 0, ...edit.lines);

		return lines.join('\n');
	}

	if (edit.replace) {
		if (text.split(edit.replace).length !== 2) {
			fail();
		}

		return text.replace(edit.replace, edit.with);
	}

	const lines = text.split('\n');
	const from = lines.indexOf(edit.block);
	const to = lines.indexOf(edit.until, from + 1);

	if (from < 0 || to < 0) {
		fail();
	}

	// Keep the comment lines right above the block's first line with it.
	let start = from;

	while (start > 0 && lines[start - 1].startsWith('\t//')) {
		start--;
	}

	return [...lines.slice(0, start), ...edit.text.replace(/\n$/, '').split('\n'), ...lines.slice(to)].join('\n');
}

// The file as the harness serves it: the real one with its edits applied.
export async function applyIntegration(file) {
	let text = await readFile(new URL(file, ROOT), 'utf8');

	for (const edit of INTEGRATION[file]) {
		text = applyEdit(text, edit, file);
	}

	return text;
}

// Every module the patched app loads, by repo path: the static imports from
// app.js down, plus dynamic imports with a literal path.
export async function moduleGraph() {
	const seen = new Set();
	const queue = [['app.js', await applyIntegration('app.js')]];

	while (queue.length) {
		const [path, text] = queue.shift();

		for (const match of text.matchAll(/(?:from\s+|import\()\s*'(\.{1,2}\/[^']+)'/g)) {
			const target = new URL(match[1], new URL(path, 'file:///r/')).pathname.replace(/^\/r\//, '');

			if (seen.has(target)) {
				continue;
			}

			const source = INTEGRATION[target]
				? await applyIntegration(target)
				: await readFile(new URL(target, ROOT), 'utf8').catch(() => null);

			// A path that is no file (an example in a comment) is skipped.
			if (source !== null) {
				seen.add(target);
				queue.push([target, source]);
			}
		}
	}

	return [...seen];
}

// Modules the app loads that sw.js SHELL does not list, mine aside. Other
// work in progress can leave one out, and the app then cannot open offline
// at all; the harness lists them in its sw.js so the offline test checks
// this screen, and reports them, since they are not this screen's lines.
export async function shellGaps() {
	const sw = await applyIntegration('sw.js');
	const listed = new Set([...sw.matchAll(/^\t'([^']+)',$/gm)].map((match) => match[1]));

	return (await moduleGraph()).filter((path) => !listed.has(path)).sort();
}

async function servedSw() {
	const gaps = await shellGaps();
	const text = await applyIntegration('sw.js');

	return gaps.length ? text.replace(/^const SHELL = \[$/m, `const SHELL = [\n${gaps.map((path) => `\t'${path}',`).join('\n')}`) : text;
}

// Applies every edit once, so a gone anchor fails before any browser opens.
export async function checkIntegration() {
	for (const file of Object.keys(INTEGRATION)) {
		await applyIntegration(file);
	}
}

const TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8'};

// Serves the app with the edits applied. Returns {origin, close}.
export async function startHarness(port = 0) {
	await checkIntegration();

	const pages = await startPagesServer();
	// The folder itself serves index.html, as 404.html's redirect lands
	// there.
	const patched = new Map([...Object.keys(INTEGRATION).map((file) => [`${BASE}${file}`, file]), [BASE, 'index.html']]);

	const server = createServer(async (request, response) => {
		const {pathname} = new URL(request.url, 'http://localhost');
		const file = patched.get(pathname);

		try {
			if (file) {
				const text = file === 'sw.js' ? await servedSw() : await applyIntegration(file);

				response.writeHead(200, {'Cache-Control': 'no-cache', 'Content-Type': TYPES[file.slice(file.lastIndexOf('.'))]});
				response.end(text);

				return;
			}

			const upstream = await fetch(pages.origin + request.url);
			const body = Buffer.from(await upstream.arrayBuffer());

			// A path with no file gets 404.html, as on GitHub Pages; the app
			// shell inside it is the patched index.html.
			if (upstream.status === 404 && (upstream.headers.get('content-type') || '').startsWith('text/html')) {
				response.writeHead(404, {'Cache-Control': 'no-cache', 'Content-Type': 'text/html; charset=utf-8'});
				response.end(body);

				return;
			}

			response.writeHead(upstream.status, {'Cache-Control': 'no-cache', 'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream'});
			response.end(body);
		}
		catch (err) {
			response.writeHead(500, {'Content-Type': 'text/plain'});
			response.end(String(err && err.stack));
		}
	});

	return new Promise((done) => {
		server.listen(port, '127.0.0.1', () => {
			done({
				close: async () => {
					await new Promise((closed) => server.close(closed));
					await pages.close();
				},
				origin: `http://localhost:${server.address().port}`,
			});
		});
	});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const {origin} = await startHarness(Number(process.argv[2]) || 8002);
	const gaps = await shellGaps();

	if (gaps.length) {
		console.log(`sw.js SHELL lacks ${gaps.join(', ')} (not this screen's); the harness adds them.`);
	}

	console.log(`Serving the app with every card of a Pokémon wired in at ${origin}${BASE}`);
}
