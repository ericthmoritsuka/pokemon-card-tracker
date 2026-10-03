// The scan benchmark: 40 TCGdex card scans (lab/bench/dataset.json) through
// six simulated captures each, read and matched by the scanner's own code in
// headless Chromium. See lab/bench/README.md.
//
// node lab/bench/run.mjs [--passes clean,blur] [--only <regexp>] [--limit N]
//   [--throttle 4] [--workers 2] [--out results.json] [--crops <dir>]
//   [--photo <file> --box x,y,w,h [--framings name:fit:angle:size,...] [--stills <dir>]]
//
// REPO=<tree> measures another checkout of the app (default: this repo).
// BENCH_CACHE=<dir> is where card images, recorded TCGdex answers, and
// results go (default /tmp/scan-bench-cache); never inside the repo.

import {mkdir, writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {cardImage, routeNet} from './net.mjs';
import {startServer} from './server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const args = Object.fromEntries(process.argv.slice(2)
	.map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : null))
	.filter(Boolean));
const cache = resolve(process.env.BENCH_CACHE || '/tmp/scan-bench-cache');
const repo = resolve(process.env.REPO || join(HERE, '../..'));

if (cache.startsWith(resolve(HERE, '../..') + '/')) {
	throw new Error('BENCH_CACHE must be outside the repo: it holds card images and results.');
}

const passes = args.passes ? String(args.passes).split(',') : ['clean', 'blur', 'glare', 'tilt', 'jpeg', 'nonumber'];
const photo = args.photo ? resolve(String(args.photo)) : null;

// Photo framings: name, fit (width or height), angle in degrees, size.
const framings = String(args.framings || 'width:width:0:1,height:height:0:1,slant:width:12:1,slant-height:height:12:1,far:width:0:0.45')
	.split(',')
	.map((spec) => {
		const [name, fit = 'width', angle = '0', size = '1'] = spec.split(':');

		return {angle: Number(angle), fit, name, size: Number(size)};
	});

const server = await startServer({cache, photo, repo});
const browser = await chromium.launch();
const context = await browser.newContext({viewport: {height: 740, width: 360}});
const counts = await routeNet(context, cache);
const page = await context.newPage();

page.on('pageerror', (err) => console.error('pageerror', err.message));
await page.goto(`${server.origin}/bench/bench.html`);
await page.waitForFunction(() => window.benchReady === true, null, {timeout: 60000});
console.log('init', JSON.stringify(await page.evaluate((workers) => window.bench.init({workers}), Number(args.workers || 2))));

const cdp = await context.newCDPSession(page);
const options = args.options ? JSON.parse(args.options) : {};

// --picture: the app's picture-first route (bench.js measurePicture).
if (args.picture) {
	options.pictureFirst = true;
}
const throttle = (rate) => cdp.send('Emulation.setCPUThrottlingRate', {rate});

// With --throttle, a warm run at full speed first, so TCGdex answers are in
// the page's IndexedDB and only the scanner's own work is slowed.
async function measured(fn) {
	if (args.throttle) {
		await fn();
		await throttle(Number(args.throttle));
	}

	try {
		return await fn();
	}
	finally {
		if (args.throttle) {
			await throttle(1);
		}
	}
}

async function saveCrops(result, prefix) {
	if (!args.crops) {
		return;
	}

	await mkdir(String(args.crops), {recursive: true});

	for (const [k, v] of Object.entries(result.new.crops || {})) {
		await writeFile(join(String(args.crops), `${prefix}-${k}.png`), Buffer.from(v.split(',')[1], 'base64'));
	}

	delete result.new.crops;
}

// A Y4M still of an RGBA frame, the format Chrome's fake camera plays
// (--use-file-for-fake-video-capture).
function y4m({data, height, width}) {
	const rgba = Buffer.from(data, 'base64');
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

	return Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420jpeg\nFRAME\n`), y, u, v]);
}

const rows = [];
const rank = (list, truth) => {
	const i = (list || []).findIndex((c) => c.id === truth);

	return i < 0 ? '-' : i + 1;
};

if (photo) {
	if (!args.box) {
		throw new Error('--photo needs --box x,y,w,h: the card\'s box in the photo, in its pixels.');
	}

	const [x, y, w, h] = String(args.box).split(',').map(Number);
	const truth = args.truth ? String(args.truth) : null;

	for (const framing of framings) {
		const frame = {...framing, box: {h, w, x, y}};

		if (args.stills) {
			await mkdir(String(args.stills), {recursive: true});
			await writeFile(join(String(args.stills), `${framing.name}.y4m`), y4m(await page.evaluate(([f]) => window.bench.photoFrameBytes('/photo', f), [frame])));
		}

		const r = await measured(() => page.evaluate(([f, o]) => window.bench.photo('/photo', f, o), [frame, {crops: Boolean(args.crops), options}]));

		await saveCrops(r, framing.name);
		r.truth = truth;
		rows.push(r);

		const top = r.new.candidates[0];

		console.log(`${framing.name} (fit ${framing.fit}, ${framing.angle} deg, size ${framing.size}): edges ${r.new.found ? 'found' : 'not found'} (${r.new.note}, angle ${r.new.angle}); first ${top ? top.id : 'none'}${truth ? ` (right card at ${rank(r.new.candidates, truth)})` : ''}, ${r.new.sure ? 'sure' : `not sure: ${r.new.why}`}; number ${r.new.number || 'unread'}, name "${r.new.name ? r.new.name.text : ''}"; ${r.new.timings.total} ms`);
	}
}
else {
	let dataset = JSON.parse(readFileSync(join(HERE, 'dataset.json'), 'utf8'));

	if (args.only) {
		dataset = dataset.filter((d) => new RegExp(String(args.only)).test(d.id));
	}

	if (args.limit) {
		dataset = dataset.slice(0, Number(args.limit));
	}

	for (const item of dataset) {
		item.file = await cardImage(cache, item);
	}

	for (const pass of passes) {
		for (const item of dataset) {
			let r;

			try {
				r = await measured(() => page.evaluate(([it, o]) => window.bench.run(it, o), [item, {crops: Boolean(args.crops), options, pass}]));
			}
			catch (err) {
				console.error(item.id, pass, err.message);
				continue;
			}

			await saveCrops(r, `${item.id}-${pass}`);
			r.truth = item.id;
			r.group = `${item.group}-${item.lang}`;
			rows.push(r);
			console.log(`${pass} ${item.id} num:${rank(r.new.numberOnly, item.id)} name:${rank(r.new.noArt, item.id)} full:${rank(r.new.candidates, item.id)} | n=${r.new.number} name="${r.new.name && r.new.name.text}" hp=${r.new.hp && r.new.hp.value} ${r.new.timings.total}ms (ocr ${r.new.timings.ocr})`);
		}
	}

	// The summary: how often the right card is first (and in the first
	// three), with the number alone, with the name route, and with the
	// artwork tiebreak too (what the scanner shows); then what was read,
	// and the timings.
	const at = (key, n) => (r) => {
		const i = (r.new[key] || []).findIndex((c) => c.id === r.truth);

		return i >= 0 && i < n;
	};
	const share = (list, fn) => {
		const k = list.filter(fn).length;

		return `${Math.round((100 * k) / Math.max(1, list.length))} % (${k})`;
	};

	console.log('\n| Pass | n | Number only first | +Name first | +Name top 3 | +Name+art first | +Name+art top 3 |');
	console.log('| --- | --- | --- | --- | --- | --- | --- |');

	for (const pass of [...passes, 'all']) {
		const list = rows.filter((r) => pass === 'all' || r.pass === pass);

		console.log(`| ${pass} | ${list.length} | ${share(list, at('numberOnly', 1))} | ${share(list, at('noArt', 1))} | ${share(list, at('noArt', 3))} | ${share(list, at('candidates', 1))} | ${share(list, at('candidates', 3))} |`);
	}

	console.log('');

	const median = (list) => {
		const sorted = [...list].sort((a, b) => a - b);

		return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
	};

	for (const pass of passes) {
		const list = rows.filter((r) => r.pass === pass);
		const times = list.map((r) => r.new.timings);
		const totals = times.map((t) => t.total).sort((a, b) => a - b);

		if (args.picture) {
			const ocr = list.filter((r) => r.new.ocr);

			console.log(`${pass}: OCR ran for ${ocr.length}/${list.length}, sure ${list.filter((r) => r.new.sure).length} (wrong ${list.filter((r) => r.new.sure && (r.new.candidates[0] || {}).id !== r.truth).length}); rectify ${median(times.map((t) => t.rectify))} ms, fingerprint ${median(times.map((t) => t.fingerprint))} ms, match ${median(times.map((t) => t.match))} ms, total median ${median(totals)} ms, p90 ${totals[Math.max(0, Math.ceil(totals.length * 0.9) - 1)] || 0} ms; without OCR ${median(list.filter((r) => !r.new.ocr).map((r) => r.new.timings.total))} ms, with OCR ${median(ocr.map((r) => r.new.timings.total))} ms`);
			continue;
		}

		console.log(`${pass}: name matched ${list.filter((r) => r.new.names && r.new.names[0] && r.new.names[0].score >= 0.75).length}/${list.length}, number read ${list.filter((r) => r.new.number).length}, HP read ${list.filter((r) => r.new.hp).length}, edges ${list.filter((r) => r.new.found).length}; rectify ${median(times.map((t) => t.rectify))} ms, OCR ${median(times.map((t) => t.ocr))} ms, match ${median(times.map((t) => t.match))} ms, total median ${median(totals)} ms, p90 ${totals[Math.max(0, Math.ceil(totals.length * 0.9) - 1)] || 0} ms`);
	}
}

const out = args.out ? resolve(String(args.out)) : join(cache, 'results.json');

await mkdir(dirname(out), {recursive: true});
await writeFile(out, JSON.stringify({args, counts, rows}, null, 1));
console.log(`\nResults: ${out}`);
await browser.close();
await server.close();
