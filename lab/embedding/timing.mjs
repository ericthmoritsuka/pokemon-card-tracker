// Time per crop for each candidate on this machine: session load, then the
// median of 30 runs of both regions (art box and whole card) of one crop,
// on 1 thread and on 4.
//
// node lab/embedding/timing.mjs <scan-log.json> [--models a,b]

import {statSync} from 'node:fs';
import {join} from 'node:path';

import {args as parseArgs, dataUrlBytes, decodeImage, median, readLogs} from '../holder/lib.mjs';
import {loadModel, MODELS, MODELS_DIR} from './lib.mjs';

const opts = parseArgs();
const names = opts.models ? String(opts.models).split(',') : Object.keys(MODELS);
const entry = readLogs(opts._).find((e) => e.picture);
const img = decodeImage(dataUrlBytes(entry.picture));

console.log('| Model | File MB | Load ms | 1 thread, ms per crop (2 regions) | 4 threads |');
console.log('| --- | --- | --- | --- | --- |');

for (const name of names) {
	const cells = [];
	let loadMs = 0;

	for (const threads of [1, 4]) {
		const started = performance.now();
		const model = await loadModel(name, {threads});

		if (threads === 1) {
			loadMs = performance.now() - started;
		}

		await model.embed(img);
		await model.embed(img);

		const runs = [];

		for (let i = 0; i < 30; i++) {
			const before = model.netMs;

			await model.embed(img);
			runs.push(model.netMs - before);
		}

		cells.push(median(runs).toFixed(1));
	}

	const mb = statSync(join(MODELS_DIR, MODELS[name].file)).size / 1e6;

	console.log(`| ${name} | ${mb.toFixed(1)} | ${Math.round(loadMs)} | ${cells[0]} | ${cells[1]} |`);
}
