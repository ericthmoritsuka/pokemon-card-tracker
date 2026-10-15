// The same timing as timing.mjs, through onnxruntime-web's WebAssembly
// backend (SIMD, 1 thread) running in Node: the code path a browser
// without WebGPU would take, on this machine's CPU. A phone is slower
// again by the factor RESULTS.md discusses.
//
// ORT_WEB=<folder of onnxruntime-web> node lab/embedding/timing-wasm.mjs
//   <scan-log.json> [--models a,b] [--threads 1]

import {readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

import {args as parseArgs, dataUrlBytes, decodeImage, median, readLogs} from '../holder/lib.mjs';
import {MODELS, MODELS_DIR, regionPixels, REGIONS, toTensorData} from './lib.mjs';

const opts = parseArgs();
const dir = process.env.ORT_WEB || '/tmp/emb/node/node_modules/onnxruntime-web';
const ort = await import(pathToFileURL(join(dir, 'dist/ort.node.min.mjs')).href);

ort.env.wasm.numThreads = Number(opts.threads || 1);
ort.env.wasm.simd = true;

const names = opts.models ? String(opts.models).split(',') : Object.keys(MODELS);
const entry = readLogs(opts._).find((e) => e.picture);
const img = decodeImage(dataUrlBytes(entry.picture));

console.log(`| Model | File MB | WASM load ms | WASM ms per crop (2 regions, ${ort.env.wasm.numThreads} thread) |`);
console.log('| --- | --- | --- | --- |');

for (const name of names) {
	const spec = MODELS[name];
	const S = spec.size;
	const path = join(MODELS_DIR, spec.file);
	let session;
	const started = performance.now();

	try {
		session = await ort.InferenceSession.create(new Uint8Array(readFileSync(path)), {executionProviders: ['wasm']});
	}
	catch (err) {
		console.log(`| ${name} | ${(statSync(path).size / 1e6).toFixed(1)} | fails: ${String(err.message).slice(0, 80)} | - |`);
		continue;
	}

	const loadMs = performance.now() - started;
	const tensors = Object.values(REGIONS).map((rect) => new ort.Tensor('float32', toTensorData(regionPixels(img, rect, S), S, spec), spec.layout === 'nhwc' ? [1, S, S, 3] : [1, 3, S, S]));
	const runs = [];

	for (let i = 0; i < 12; i++) {
		const t0 = performance.now();

		for (const t of tensors) {
			await session.run({[session.inputNames[0]]: t});
		}

		if (i >= 2) {
			runs.push(performance.now() - t0);
		}
	}

	console.log(`| ${name} | ${(statSync(path).size / 1e6).toFixed(1)} | ${Math.round(loadMs)} | ${median(runs).toFixed(1)} |`);
}
