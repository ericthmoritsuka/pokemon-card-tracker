// Shared parts of the embedding experiment (lab/embedding/RESULTS.md): the
// candidate models, how a straightened card becomes a model input, and
// the embedding cache. Nothing here is loaded by the app.
//
// onnxruntime-node is not a dependency of the repo: install it outside
// (`npm install onnxruntime-node@1.22.0` in a folder of your own, with
// ONNXRUNTIME_NODE_INSTALL_CUDA=skip) and point ORT_NODE at its package
// folder. Model files live in EMB_MODELS (see RESULTS.md for where each
// one comes from); nothing is downloaded from here.

import {createRequire} from 'node:module';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

import {ART} from '../../js/vision/fingerprint.js';
import {decodeImage} from '../holder/lib.mjs';

export const MODELS_DIR = process.env.EMB_MODELS || '/tmp/emb/models';

export function loadOrt() {
	const dir = process.env.ORT_NODE || '/tmp/emb/node/node_modules/onnxruntime-node';

	return createRequire(join(dir, 'package.json'))(dir);
}

const IMAGENET = {mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225]};

// Each candidate: the ONNX file, the input size and layout, normalisation,
// and how its output becomes one vector. `pool` for DINOv2 (a ViT whose
// output is every token): `cls` the class token, `mean` the mean of the
// patch tokens, `both` the two concatenated (each at unit length).
export const MODELS = {
	'dinov2-fp32': {file: 'dinov2_fp32.onnx', size: 224, ...IMAGENET, layout: 'nchw', pool: 'both'},
	'dinov2-uint8': {file: 'dinov2_uint8.onnx', size: 224, ...IMAGENET, layout: 'nchw', pool: 'both'},
	'dinov2-q4': {file: 'dinov2_q4.onnx', size: 224, ...IMAGENET, layout: 'nchw', pool: 'both'},
	'mclip2-fp32': {file: 'mclip2_fp32.onnx', size: 256, mean: [0, 0, 0], std: [1, 1, 1], layout: 'nchw'},
	'mclip2-uint8': {file: 'mclip2_uint8.onnx', size: 256, mean: [0, 0, 0], std: [1, 1, 1], layout: 'nchw'},
	'mnv3-fp32': {file: 'mnv3feat_fp32.onnx', size: 224, ...IMAGENET, layout: 'nchw'},
	'mnv3-uint8': {file: 'mnv3feat_uint8.onnx', size: 224, ...IMAGENET, layout: 'nchw'},
	'effl0-fp32': {file: 'effl0feat_fp32.onnx', size: 224, mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5], layout: 'nhwc'},
	'effl0-uint8': {file: 'effl0feat_uint8.onnx', size: 224, mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5], layout: 'nhwc'},
};

// The two regions the app's fingerprint also reads: the art box
// (fingerprint.js ART) and the whole card edge to edge.
export const REGIONS = {
	art: ART,
	card: {h: 1, w: 1, x: 0, y: 0},
};

// A region of an ImageData-shaped card as S x S RGB floats in 0..1, each
// output pixel the mean of the source pixels it covers (area resampling,
// so a 420 px crop and a 337 px catalog image are smoothed alike).
export function regionPixels(img, rect, S) {
	const {data, width: W, height: H} = img;
	const x0 = rect.x * W;
	const y0 = rect.y * H;
	const cw = (rect.w * W) / S;
	const ch = (rect.h * H) / S;
	const out = new Float32Array(S * S * 3);

	for (let v = 0; v < S; v++) {
		const ya = y0 + v * ch;
		const yb = ya + ch;
		const ys = Math.max(0, Math.floor(ya));
		const ye = Math.min(H, Math.max(ys + 1, Math.ceil(yb)));

		for (let u = 0; u < S; u++) {
			const xa = x0 + u * cw;
			const xb = xa + cw;
			const xs = Math.max(0, Math.floor(xa));
			const xe = Math.min(W, Math.max(xs + 1, Math.ceil(xb)));
			let r = 0;
			let g = 0;
			let b = 0;
			let n = 0;

			for (let y = ys; y < ye; y++) {
				for (let x = xs; x < xe; x++) {
					const i = (y * W + x) * 4;

					r += data[i];
					g += data[i + 1];
					b += data[i + 2];
					n++;
				}
			}

			const o = (v * S + u) * 3;

			out[o] = r / n / 255;
			out[o + 1] = g / n / 255;
			out[o + 2] = b / n / 255;
		}
	}

	return out;
}

export function toTensorData(pixels, S, spec) {
	const out = new Float32Array(S * S * 3);

	for (let p = 0; p < S * S; p++) {
		for (let c = 0; c < 3; c++) {
			const value = (pixels[p * 3 + c] - spec.mean[c]) / spec.std[c];

			if (spec.layout === 'nhwc') {
				out[p * 3 + c] = value;
			}
			else {
				out[c * S * S + p] = value;
			}
		}
	}

	return out;
}

export function normalize(v) {
	let s = 0;

	for (let i = 0; i < v.length; i++) {
		s += v[i] * v[i];
	}

	s = Math.sqrt(s) || 1;

	const out = new Float32Array(v.length);

	for (let i = 0; i < v.length; i++) {
		out[i] = v[i] / s;
	}

	return out;
}

// A model ready to embed: embed(img) -> {art, card} unit vectors, plus the
// time the network took.
export async function loadModel(name, {threads = 1} = {}) {
	const ort = loadOrt();
	const spec = MODELS[name];
	const path = join(MODELS_DIR, spec.file);

	if (!existsSync(path)) {
		throw new Error(`${path} is missing; see lab/embedding/RESULTS.md for where it comes from.`);
	}

	const session = await ort.InferenceSession.create(path, {executionMode: 'sequential', interOpNumThreads: 1, intraOpNumThreads: threads});
	const input = session.inputNames[0];
	const output = session.outputNames[0];
	const S = spec.size;
	let netMs = 0;

	async function run(pixels) {
		const dims = spec.layout === 'nhwc' ? [1, S, S, 3] : [1, 3, S, S];
		const tensor = new ort.Tensor('float32', toTensorData(pixels, S, spec), dims);
		const started = performance.now();
		const result = await session.run({[input]: tensor});

		netMs += performance.now() - started;

		const out = result[output];

		if (!spec.pool) {
			return normalize(out.data);
		}

		// [1, tokens, dim]: class token first.
		const [, tokens, dim] = out.dims;
		const cls = normalize(out.data.subarray(0, dim));
		const mean = new Float32Array(dim);

		for (let t = 1; t < tokens; t++) {
			for (let d = 0; d < dim; d++) {
				mean[d] += out.data[t * dim + d];
			}
		}

		const m = normalize(mean);

		if (spec.pool === 'cls') {
			return cls;
		}

		if (spec.pool === 'mean') {
			return m;
		}

		const both = new Float32Array(dim * 2);

		both.set(cls, 0);
		both.set(m, dim);

		return both;
	}

	return {
		async embed(img) {
			const out = {};

			for (const [region, rect] of Object.entries(REGIONS)) {
				out[region] = await run(regionPixels(img, rect, S));
			}

			return out;
		},
		name,
		get netMs() {
			return netMs;
		},
		spec,
	};
}

// Cached embeddings: one binary file per model and region, rows in the
// order of the reference list, plus a JSON list of keys.
export function readEmbeddings(file) {
	if (!existsSync(file)) {
		return null;
	}

	const buf = readFileSync(file);
	const n = buf.readUInt32LE(0);
	const dim = buf.readUInt32LE(4);

	return {data: new Float32Array(buf.buffer.slice(buf.byteOffset + 8, buf.byteOffset + 8 + n * dim * 4)), dim, n};
}

export function writeEmbeddingsBuffer(rows, dim) {
	const buf = Buffer.alloc(8 + rows.length * dim * 4);

	buf.writeUInt32LE(rows.length, 0);
	buf.writeUInt32LE(dim, 4);
	rows.forEach((row, i) => Buffer.from(row.buffer, row.byteOffset, dim * 4).copy(buf, 8 + i * dim * 4));

	return buf;
}

// A catalog image file as ImageData-shaped RGBA. Through sharp when
// SHARP names its package folder (thousands of images; one ffmpeg process
// per image is slow), else through ffmpeg (lab/holder/lib.mjs).
let sharp;

export async function decodeFile(path) {
	if (sharp === undefined) {
		sharp = process.env.SHARP ? createRequire(join(process.env.SHARP, 'package.json'))(process.env.SHARP) : null;
	}

	if (!sharp) {
		return decodeImage(path);
	}

	const {data, info} = await sharp(path).ensureAlpha().raw().toBuffer({resolveWithObject: true});

	return {data: new Uint8ClampedArray(data.buffer, data.byteOffset, info.width * info.height * 4), height: info.height, width: info.width};
}

// The key a reference card is known by: catalog and id.
export const refKey = (card) => `${card.catalog}:${card.id}`;
