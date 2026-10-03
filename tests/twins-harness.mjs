// A test harness for the international twin picker (js/twins-view.js). The
// page mounts twinConfirm() the way card detail will, over the real
// js/twins.js and its IndexedDB, with a result seeded as findTwin saves it.
// No Supabase and no collection: the picker touches neither.
//
// The page is served at /pokemon-card-tracker/twins-harness.html by a
// Playwright route; every other file is the real one, from
// tests/pages-server.mjs. Card images come from routeImages(), never the
// network during the test.
//
// ?card=<Japanese card id> picks which seeded card the block is for.
//
// INTEGRATION lists the lines that wire twins into the app, and
// checkIntegration asserts that each one is in the real file, so a change
// to a shared file that drops one fails tests/twins.test.mjs instead of
// leaving the module unused.

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BASE = '/pokemon-card-tracker/';

export const INTEGRATION = {
	'index.html': [
		// After the last stylesheet link, css/prices.css.
		'\t<link rel="stylesheet" href="/pokemon-card-tracker/css/twins.css">',
	],
	'js/cards-view.js': [
		'import {loadTwins, onTwinsChange, refreshTwins, twinName, twinSlides} from \'./twins.js\';',
		// Names and tile images in build() (through withTwin()) and tile().
		'\t\tconst names = withTwinName(group.plainNames, group.twinItem);',
		'\t\tconst twins = twinSlides(group.twinItem, {size: \'low\'});',
		'\t\t\t\tsrc: tileSrc(group.entries, catalogSrc, {twins: group.twins}),',
		'\t\t}), group.entries, catalogSrc, (src) => cardArt(info, src, {decorative: true}), {twins: group.twins});',
		// After the first build and draw in load(): loadTwins, then
		// refreshTwins.
		'\t\tstartTwins();',
		'\tconst stopTwins = onTwinsChange(twinsChanged);',
		'\t\tstopTwins();',
	],
	'js/catalog-views.js': [
		'import {loadTwins, onTwinsChange, twinKey, twinName, twinSlides} from \'./twins.js\';',
		'import {twinConfirm} from \'./twins-view.js\';',
		// cardView, after the photos setup.
		'\tconst twin = twinConfirm({cardId, catalog: catalogFor(lang)});',
		'\tconst stopTwins = onTwinsChange(twinChanged);',
		'\t\ttwin.check(card);',
		'\t\t\t\th(\'div\', {class: \'hero-art\'}, photos.show({art: cardArt, info, official: cardImage(card.image, \'high\'), twins})),',
		// Right after the card hero.
		'\t\t\ttwin.element,',
		'\t\ttwin.destroy();',
		'\t\tstopTwins();',
	],
	'sw.js': [
		'\t\'js/twins-view.js\',',
		'\t\'js/twins.js\',',
		'\t\'css/twins.css\',',
	],
};

// Asserts that the real files carry every line in INTEGRATION.
export async function checkIntegration() {
	for (const [path, wanted] of Object.entries(INTEGRATION)) {
		const lines = new Set((await readFile(join(ROOT, path), 'utf8')).split('\n'));

		for (const line of wanted) {
			assert.ok(lines.has(line), `${path} has: ${line.trim()}`);
		}
	}
}

export const HARNESS_PATH = `${BASE}twins-harness.html`;

// M3-068 is ambiguous in the research: the Antique Jaw and Antique Sail
// Fossil share their text, and a later set reprints a third fossil.
export const CANDIDATES = [
	{category: 'Trainer', id: 'me03-068', image: 'https://assets.tcgdex.net/en/me/me03/068', localId: '068', name: 'Antique Jaw Fossil', setId: 'me03', setName: 'Perfect Order'},
	{category: 'Trainer', id: 'me03-069', image: 'https://assets.tcgdex.net/en/me/me03/069', localId: '069', name: 'Antique Sail Fossil', setId: 'me03', setName: 'Perfect Order'},
	{category: 'Trainer', id: 'me05-072', image: 'https://assets.tcgdex.net/en/me/me05/072', localId: '072', name: 'Antique Armor Fossil', setId: 'me05', setName: 'Pitch Black'},
];

export const HARNESS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Twins harness | Card Tracker</title>
<link rel="stylesheet" href="${BASE}style.css">
<link rel="stylesheet" href="${BASE}css/twins.css">
<style>
	body { margin: 0; }
	main { padding: 12px 16px 48px; }
</style>
</head>
<body>
<main>
	<h1>Twins harness</h1>
	<div class="card-detail" id="detail"></div>
</main>
<script type="module">
	import {idbStore, MATCHER_VERSION, exportDecisions, twinImage, twinName} from '${BASE}js/twins.js';
	import {twinConfirm} from '${BASE}js/twins-view.js';

	const CANDIDATES = ${JSON.stringify(CANDIDATES)};
	const params = new URLSearchParams(location.search);
	const cardId = params.get('card') || 'M3-068';
	const store = idbStore();

	// Seeded the way findTwin saves an ambiguous result, unless already there.
	for (const id of ['M3-068', 'M3-069']) {
		if (!(await store.get('results', 'ja|' + id))) {
			await store.put('results', 'ja|' + id, {
				candidates: CANDIDATES,
				category: 'Trainer',
				checked_at: Date.now(),
				status: 'ambiguous',
				version: MATCHER_VERSION,
			});
		}
	}

	// The TCGdex record card detail holds; ensureTwin only reads its id here,
	// because the seeded result is not due.
	const record = {category: 'Trainer', id: cardId, localId: cardId.split('-')[1], name: '古びたアゴの化石', set: {cardCount: {official: 80}, id: 'M3'}};
	const block = twinConfirm({cardId, catalog: 'ja'});

	document.getElementById('detail').append(block.element);
	block.check(record);

	window.harness = {
		decisions: () => exportDecisions(),
		image: () => twinImage({card_id: cardId, catalog: 'ja'}),
		name: () => twinName({card_id: cardId, catalog: 'ja'}),
	};
	window.harnessReady = true;
</script>
</body>
</html>
`;

// Serves the harness page and the card images; counts and blocks every
// other request that leaves localhost.
export async function routeHarness(page, {images = {}} = {}) {
	const outside = [];

	await page.route('**/*', async (route) => {
		const url = new URL(route.request().url());

		if (url.pathname === HARNESS_PATH && url.hostname === 'localhost') {
			await route.fulfill({body: HARNESS_HTML, contentType: 'text/html; charset=utf-8'});

			return;
		}

		if (url.hostname === 'assets.tcgdex.net') {
			const key = url.pathname.replace(/\/low\.webp$|\/high\.webp$/, '');
			const image = images[`https://assets.tcgdex.net${key}`];

			await (image
				? route.fulfill({body: image.body, contentType: image.type})
				: route.fulfill({body: STAND_IN, contentType: 'image/svg+xml'}));

			return;
		}

		if (url.hostname !== 'localhost') {
			outside.push(url.href);
			await route.abort();

			return;
		}

		await route.continue();
	});

	return outside;
}

// A drawn card, for when the real images could not be fetched.
const STAND_IN = `<svg xmlns="http://www.w3.org/2000/svg" width="245" height="342" viewBox="0 0 245 342"><rect width="245" height="342" rx="12" fill="#1d2e60"/><rect x="14" y="40" width="217" height="150" fill="#ffcb05"/><text x="122" y="250" fill="#fff" font-family="sans-serif" font-size="20" text-anchor="middle">Stand-in</text></svg>`;
