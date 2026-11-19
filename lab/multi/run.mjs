// The multi-card lab: synthetic frames holding several cards (binder pages
// and loose cards on a table), made from the scan benchmark's 40 TCGdex card
// images, and the two ways of finding them (lab/multi/multi.js), measured
// in headless Chromium. See lab/multi/README.md.
//
// node lab/multi/run.mjs [--pages 20] [--loose 24] [--single] [--paths page,free]
//   [--throttle 4] [--side 360] [--pad 0.05] [--text] [--shots <dir>]
//   [--out results.json]
// node lab/multi/run.mjs --photos a.jpg,b.jpg [--side 360] [--shots <dir>]
//
// BENCH_CACHE=<dir> is the scan benchmark's cache folder (card images and
// recorded TCGdex answers; default /tmp/scan-bench-cache), never inside the
// repo. Card images it lacks are downloaded into it, as the benchmark does.

import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {cardImage, routeNet} from '../bench/net.mjs';
import {startServer} from '../bench/server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const args = Object.fromEntries(process.argv.slice(2)
	.map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : null))
	.filter(Boolean));
const cache = resolve(process.env.BENCH_CACHE || '/tmp/scan-bench-cache');

if (cache.startsWith(ROOT + '/')) {
	throw new Error('BENCH_CACHE must be outside the repo: it holds card images and results.');
}

const pageCount = Number(args.pages ?? 20);
const looseCount = Number(args.loose ?? 24);
const paths = String(args.paths || 'page,free').split(',');
const options = {fit: !args['no-fit'], pad: Number(args.pad ?? 0.1), refine: !args['no-refine'], side: Number(args.side ?? 360), text: Boolean(args.text)};

function seeded(text) {
	let h = 2166136261;

	for (const ch of text) {
		h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
	}

	return () => {
		h = Math.imul(h ^ (h >>> 15), 2246822507);
		h = Math.imul(h ^ (h >>> 13), 3266489909);
		h ^= h >>> 16;

		return (h >>> 0) / 4294967296;
	};
}

function shuffled(list, rand) {
	const out = [...list];

	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));

		[out[i], out[j]] = [out[j], out[i]];
	}

	return out;
}

const dataset = JSON.parse(readFileSync(join(ROOT, 'lab/bench/dataset.json'), 'utf8'));

for (const item of dataset) {
	item.file = await cardImage(cache, item);
}

const files = dataset.map((item) => item.file);
const ids = Object.fromEntries(dataset.map((item) => [item.file, item.id]));

// The scenes, the same every run: pages with 0, 1, or 2 empty pockets (4 in
// 10, 3 in 10, 3 in 10) and 1 or 2 glare bands; loose frames of 2, 3, 4,
// and 5 cards in turn, every fourth with two cards touching.
const scenes = [];

for (let i = 0; i < pageCount; i++) {
	const rand = seeded(`page${i}`);
	const pick = shuffled(files, rand).slice(0, 9);
	const roll = rand();
	const empties = roll < 0.4 ? 0 : roll < 0.7 ? 1 : 2;

	for (const index of shuffled([0, 1, 2, 3, 4, 5, 6, 7, 8], rand).slice(0, empties)) {
		pick[index] = null;
	}

	scenes.push({cards: pick, glare: rand() < 0.5 ? 1 : 2, kind: 'page', name: `page${i}`, seed: `page${i}`});
}

for (let i = 0; i < looseCount; i++) {
	const rand = seeded(`loose${i}`);
	const n = 2 + (i % 4);

	scenes.push({cards: shuffled(files, rand).slice(0, n), kind: 'loose', name: `loose${i}`, seed: `loose${i}`, touch: i % 4 === 3});
}

if (args.single) {
	for (const file of files) {
		scenes.push({kind: 'single', name: `single ${ids[file]}`, seed: `single${file}`, src: file});
	}
}

const server = await startServer({cache, repo: ROOT});
const browser = await chromium.launch();
const context = await browser.newContext({viewport: {height: 740, width: 360}});
const counts = await routeNet(context, cache);
const page = await context.newPage();

page.on('pageerror', (err) => console.error('pageerror', err.message));
await page.goto(`${server.origin}/pokemon-card-tracker/lab/multi/multi.html`);
await page.waitForFunction(() => window.multiReady === true, null, {timeout: 60000});
console.log('init', JSON.stringify(await page.evaluate((cards) => window.multi.init({cards}), ids)));

const cdp = await context.newCDPSession(page);
const throttle = (rate) => cdp.send('Emulation.setCPUThrottlingRate', {rate});

// Throttled, the scene is made at full speed and only the path is slowed.
async function detect(path) {
	if (args.throttle) {
		await throttle(Number(args.throttle));
	}

	try {
		return await page.evaluate(([p, o]) => window.multi.detect(p, o), [path, options]);
	}
	finally {
		if (args.throttle) {
			await throttle(1);
		}
	}
}

// A warm-up frame, not counted: the first matches compile the matcher.
await page.evaluate((s) => window.multi.compose(s), scenes[0].kind === 'page' ? scenes[0] : {cards: files.slice(0, 3), kind: 'loose', seed: 'warm'});

for (const path of scenes[0].kind === 'page' ? paths : ['free']) {
	await page.evaluate(([p, o]) => window.multi.detect(p, o), [path, options]);
}

// --photos: real photos (a binder page, or a spread taken with the phone
// turned), read in place and served to the page at /photo/<n>; nothing is
// copied. Each goes through both paths, and what each pocket or outline
// was matched to is printed, for judging by eye.
if (args.photos) {
	const photos = String(args.photos).split(',').map((file) => resolve(file));

	await context.route(/\/photo\/\d+$/, async (route) => {
		const n = Number(new URL(route.request().url()).pathname.split('/').pop());

		await route.fulfill({body: await readFile(photos[n]), contentType: 'image/jpeg'});
	});

	const results = [];

	for (const [n, file] of photos.entries()) {
		const r = await page.evaluate(([src, o]) => window.multi.photo(src, o), [`${server.origin}/photo/${n}`, options]);

		results.push({file: basename(file), ...r});
		console.log(`\n${basename(file)} (${r.width} x ${r.height})`);

		for (const path of paths) {
			const one = r[path];

			console.log(`  ${path}: ${path === 'page' ? `${one.pages} page(s)${one.split ? ' (a spread cut in two)' : ''}, fitted to ${JSON.stringify(one.fitted)} cards, ` : ''}${one.items.filter((item) => item.card).length} card(s) of ${one.items.length} ${path === 'page' ? 'pockets' : 'outlines'}; find ${one.findMs} ms, total ${one.totalMs} ms`);

			for (const item of one.items) {
				console.log(`    ${path === 'page' ? `page ${item.page + 1} pocket ${item.pocket + 1}` : `at ${Math.round(item.middle.x)},${Math.round(item.middle.y)}`}: ${item.card ? '' : '(no card) '}${item.first} ${item.name} | ${item.sure ? 'SURE' : 'unsure'}, distance ${item.distance}, gap ${item.gap}, ${item.ms} ms | group ${item.group.join(' ')}`);
			}
		}

		if (args.shots) {
			await mkdir(String(args.shots), {recursive: true});
			await writeFile(join(String(args.shots), `photo-${basename(file)}`), Buffer.from(await page.evaluate(() => window.multi.shot()), 'base64'));
		}
	}

	const out = args.out ? resolve(String(args.out)) : join(cache, 'multi-photos.json');

	await writeFile(out, JSON.stringify({args, options, results}, null, 1));
	console.log(`\nResults: ${out}`);
	await browser.close();
	await server.close();
	process.exit(0);
}

const rows = [];

for (const scene of scenes) {
	const made = await page.evaluate((s) => window.multi.compose(s), scene);

	for (const path of scene.kind === 'single' ? ['single'] : paths.filter((p) => p !== 'page' || scene.kind === 'page')) {
		const r = await detect(path);

		rows.push({...r, kind: scene.kind, name: scene.name, path, touch: made.touch});

		const cards = r.cards;

		console.log(`${scene.name} ${path}${r.page === false ? ' PAGE NOT FOUND' : ''}${made.touch ? ' (touching)' : ''}: found ${cards.filter((c) => c.found).length}/${cards.length}, artwork ${cards.filter((c) => c.inGroup).length}, print ${cards.filter((c) => c.right).length}, sure ${cards.filter((c) => c.sure).length}${cards.some((c) => c.wrongSure) ? `, WRONG BUT SURE ${cards.filter((c) => c.wrongSure).length}` : ''}${r.falseCards ? `, false cards ${r.falseCards}` : ''}${r.duplicates ? `, duplicates ${r.duplicates}` : ''}${r.empties ? `, empty pockets judged empty ${r.emptyRight}/${r.empties}` : ''}; find ${r.findMs} ms, total ${r.totalMs} ms | distances ${cards.map((c) => (c.found ? c.distance : `(${c.distance ?? '-'})`)).join(' ')}`);
	}

	if (args.shots && scene.kind !== 'single') {
		await mkdir(String(args.shots), {recursive: true});
		await writeFile(join(String(args.shots), `${scene.name}.jpg`), Buffer.from(await page.evaluate(() => window.multi.shot()), 'base64'));
	}
}

const median = (list) => {
	const sorted = [...list].filter((v) => typeof v === 'number').sort((a, b) => a - b);

	return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};
const p90 = (list) => {
	const sorted = [...list].filter((v) => typeof v === 'number').sort((a, b) => a - b);

	return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * 0.9) - 1)] : 0;
};
const pct = (k, n) => `${Math.round((100 * k) / Math.max(1, n))} % (${k})`;

console.log(`\nSide ${options.side}, pad ${options.pad}${options.text ? ', number read when the picture is unsure' : ', picture only'}${args.throttle ? `, CPU throttled ${args.throttle}x` : ''}\n`);
console.log('| Scenes | Path | Frames | Cards | Outlined | Found | Right artwork first | Right print first | Sure | Wrong but sure | False cards | Frames all right | ms per frame (median, p90) | Find ms | ms per card (median) |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');

const groups = [['page', 'page'], ['page', 'free'], ['loose', 'free'], ['loose (apart)', 'free'], ['loose (touching)', 'free'], ['single', 'single']];

for (const [kind, path] of groups) {
	const list = rows.filter((r) => r.path === path && (kind === 'loose (apart)' ? r.kind === 'loose' && !r.touch : kind === 'loose (touching)' ? r.kind === 'loose' && r.touch : r.kind === kind));

	if (!list.length) {
		continue;
	}

	const cards = list.flatMap((r) => r.cards);
	const allRight = list.filter((r) => r.cards.every((c) => c.right) && !r.falseCards).length;

	console.log(`| ${kind} | ${path} | ${list.length} | ${cards.length} | ${pct(cards.filter((c) => c.outlined).length, cards.length)} | ${pct(cards.filter((c) => c.found).length, cards.length)} | ${pct(cards.filter((c) => c.inGroup).length, cards.length)} | ${pct(cards.filter((c) => c.right).length, cards.length)} | ${pct(cards.filter((c) => c.sure).length, cards.length)} | ${cards.filter((c) => c.wrongSure).length} | ${list.reduce((sum, r) => sum + r.falseCards + r.duplicates, 0)} | ${allRight}/${list.length} | ${median(list.map((r) => r.totalMs))}, ${p90(list.map((r) => r.totalMs))} | ${median(list.map((r) => r.findMs))} | ${median(cards.map((c) => c.ms))} |`);
}

const pages = rows.filter((r) => r.kind === 'page' && r.path === 'page');

if (pages.length) {
	const empties = pages.reduce((sum, r) => sum + r.empties, 0);

	console.log(`\nPage path: page found ${pages.filter((r) => r.page).length}/${pages.length}; empty pockets judged empty ${pages.reduce((sum, r) => sum + r.emptyRight, 0)}/${empties}, taken for a card ${pages.reduce((sum, r) => sum + r.falseCards, 0)}`);
}

const out = args.out ? resolve(String(args.out)) : join(cache, 'multi-results.json');

await mkdir(dirname(out), {recursive: true});
await writeFile(out, JSON.stringify({args, counts, options, rows}, null, 1));
console.log(`\nResults: ${out}`);
await browser.close();
await server.close();
