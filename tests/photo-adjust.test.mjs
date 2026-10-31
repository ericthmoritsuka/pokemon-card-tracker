// Unit tests for Adjust (DESIGN.md section 5, "Adjust a photo"): the pixel
// functions in js/photos/adjust.js, and the merge rule that lets a photo
// brought back by Undo edit win over its own tombstone
// (js/photos/model.js mergePhotoLists). Invented pixels only.
//
// Run: node --test tests/photo-adjust.test.mjs

import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

import {AUTO_CLIP, SLIDERS, applyAdjust, autoLevels, isNeutral, lookupTables, neutralSettings} from '../js/photos/adjust.js';
import {mergePhotoLists} from '../js/photos/model.js';

// A width x height image whose pixel i is color(i, x, y) as [r, g, b].
function image(width, height, color) {
	const data = new Uint8ClampedArray(width * height * 4);

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = y * width + x;
			const [r, g, b] = color(i, x, y);

			data.set([r, g, b, 255], i * 4);
		}
	}

	return {data, height, width};
}

// A made-up photo of a card: a smooth scene of varied colours with a little
// noise, its values scaled into [lo, hi].
function scene(lo, hi, {height = 84, width = 60} = {}) {
	let seed = 7;
	const noise = () => {
		seed = (seed * 1103515245 + 12345) % 2147483648;

		return seed / 2147483648;
	};

	return image(width, height, (i, x, y) => {
		const base = [x / (width - 1), y / (height - 1), ((x + y) % 37) / 36];

		return base.map((v) => lo + Math.min(1, Math.max(0, v * 0.9 + noise() * 0.1)) * (hi - lo));
	});
}

const mean = (img, channel = null) => {
	let sum = 0;
	let n = 0;

	for (let i = 0; i < img.data.length; i += 4) {
		for (let c = 0; c < 3; c++) {
			if (channel === null || channel === c) {
				sum += img.data[i + c];
				n++;
			}
		}
	}

	return sum / n;
};

const luma = (data, i) => data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;

describe('Auto', () => {
	test('brightens a dark photo', () => {
		const dark = scene(8, 90);
		const out = applyAdjust(dark, {...neutralSettings(), auto: autoLevels(dark)});

		assert.ok(mean(out) > mean(dark) + 60, `mean ${mean(dark).toFixed(1)} -> ${mean(out).toFixed(1)}`);
	});

	test('brightens a flat, foggy photo by stretching it', () => {
		const flat = scene(70, 150);
		const levels = autoLevels(flat);
		const out = applyAdjust(flat, {...neutralSettings(), auto: levels});
		let lo = 255;
		let hi = 0;

		for (let i = 0; i < out.data.length; i += 4) {
			lo = Math.min(lo, out.data[i], out.data[i + 1], out.data[i + 2]);
			hi = Math.max(hi, out.data[i], out.data[i + 1], out.data[i + 2]);
		}

		assert.ok(lo < 10 && hi > 245, `range ${lo} to ${hi}`);
	});

	test('leaves a well-exposed photo nearly unchanged', () => {
		const good = scene(0, 255);
		const out = applyAdjust(good, {...neutralSettings(), auto: autoLevels(good)});
		let worst = 0;

		for (let i = 0; i < good.data.length; i++) {
			worst = Math.max(worst, Math.abs(out.data[i] - good.data[i]));
		}

		assert.ok(worst <= 6, `largest change ${worst}`);
		assert.ok(Math.abs(mean(out) - mean(good)) < 2);
	});

	test('never inverts: a lighter pixel stays at least as light, in every channel', () => {
		for (const img of [scene(8, 90), scene(70, 150), scene(0, 255), scene(200, 250)]) {
			const [red, green, blue] = lookupTables({...neutralSettings(), auto: autoLevels(img)});

			for (const table of [red, green, blue]) {
				for (let v = 1; v < 256; v++) {
					assert.ok(table[v] >= table[v - 1], `table at ${v}`);
				}
			}

			const out = applyAdjust(img, {...neutralSettings(), auto: autoLevels(img)});

			for (let i = 0; i + 4 < img.data.length; i += 4) {
				const j = i + 4;

				if (luma(img.data, j) > luma(img.data, i) + 1 && img.data[j] >= img.data[i] && img.data[j + 1] >= img.data[i + 1] && img.data[j + 2] >= img.data[i + 2]) {
					assert.ok(luma(out.data, j) >= luma(out.data, i));
				}
			}
		}
	});

	test('clips at most the chosen share of each channel at each end', () => {
		for (const [lo, hi] of [[8, 90], [70, 150], [30, 220]]) {
			const img = scene(lo, hi, {height: 140, width: 100});

			for (const clip of [AUTO_CLIP, 0.02]) {
				const out = applyAdjust(img, {...neutralSettings(), auto: autoLevels(img, {clip})});
				const pixels = img.data.length / 4;

				for (let c = 0; c < 3; c++) {
					let black = 0;
					let white = 0;

					for (let i = c; i < img.data.length; i += 4) {
						black += out.data[i] === 0 && img.data[i] > 0 ? 1 : 0;
						white += out.data[i] === 255 && img.data[i] < 255 ? 1 : 0;
					}

					assert.ok(black <= clip * pixels, `channel ${c}, clip ${clip}: ${black} of ${pixels} went black`);
					assert.ok(white <= clip * pixels, `channel ${c}, clip ${clip}: ${white} of ${pixels} went white`);
				}
			}
		}
	});

	test('a single flat colour has nothing to stretch', () => {
		assert.equal(autoLevels(image(10, 10, () => [40, 40, 40])), null);
	});

	test('a nearly flat photo is stretched at most four times', () => {
		const img = image(50, 50, (i) => [100 + (i % 6), 100 + (i % 6), 100 + (i % 6)]);
		const levels = autoLevels(img);

		assert.ok(levels.hi - levels.lo + 1 >= 64, JSON.stringify(levels));
	});
});

describe('the sliders', () => {
	const sample = scene(5, 250);

	test('neutral settings, and each slider at zero, change nothing', () => {
		assert.ok(isNeutral(neutralSettings()));
		assert.deepEqual([...applyAdjust(sample, neutralSettings()).data], [...sample.data]);

		for (const key of SLIDERS) {
			const settings = {...neutralSettings(), [key]: 0};

			assert.ok(isNeutral(settings), key);
			assert.deepEqual([...applyAdjust(sample, settings).data], [...sample.data], key);
			assert.ok(!isNeutral({...neutralSettings(), [key]: 30}), key);
		}
	});

	test('brightness lightens and darkens without moving black or white', () => {
		const up = applyAdjust(sample, {...neutralSettings(), brightness: 60});
		const down = applyAdjust(sample, {...neutralSettings(), brightness: -60});
		const [red] = lookupTables({...neutralSettings(), brightness: 100});

		assert.ok(mean(up) > mean(sample) + 10);
		assert.ok(mean(down) < mean(sample) - 10);
		assert.equal(red[0], 0);
		assert.equal(red[255], 255);
	});

	test('contrast spreads values away from mid grey, and negative contrast pulls them in', () => {
		const [more] = lookupTables({...neutralSettings(), contrast: 50});
		const [less] = lookupTables({...neutralSettings(), contrast: -50});

		assert.ok(more[64] < 64 && more[192] > 192);
		assert.ok(less[64] > 64 && less[192] < 192);
	});

	test('saturation adds or removes colour, and leaves grey alone', () => {
		const color = image(1, 1, () => [200, 100, 60]);
		const grey = image(1, 1, () => [120, 120, 120]);
		const spread = (img) => Math.max(...img.data.slice(0, 3)) - Math.min(...img.data.slice(0, 3));

		assert.ok(spread(applyAdjust(color, {...neutralSettings(), saturation: 50})) > spread(color));
		assert.equal(spread(applyAdjust(color, {...neutralSettings(), saturation: -100})) <= 1, true);
		assert.deepEqual([...applyAdjust(grey, {...neutralSettings(), saturation: 80}).data], [...grey.data]);
	});

	test('warmth moves red and blue in opposite directions and leaves green', () => {
		const grey = image(4, 4, () => [128, 128, 128]);
		const warm = applyAdjust(grey, {...neutralSettings(), warmth: 60});
		const cool = applyAdjust(grey, {...neutralSettings(), warmth: -60});

		assert.ok(mean(warm, 0) > 128 && mean(warm, 2) < 128, 'warmer: more red, less blue');
		assert.ok(mean(cool, 0) < 128 && mean(cool, 2) > 128, 'cooler: less red, more blue');
		assert.equal(mean(warm, 1), 128);
		assert.equal(mean(cool, 1), 128);
	});

	test('values out of range are held to -100 to 100, and alpha is kept', () => {
		const img = image(2, 2, () => [10, 200, 90]);

		img.data[3] = 17;

		const wild = applyAdjust(img, {...neutralSettings(), brightness: 9999, contrast: -9999});
		const capped = applyAdjust(img, {...neutralSettings(), brightness: 100, contrast: -100});

		assert.deepEqual([...wild.data], [...capped.data]);
		assert.equal(wild.data[3], 17);
	});

	test('writes into the buffer it is given', () => {
		const buffer = new Uint8ClampedArray(sample.data.length);
		const out = applyAdjust(sample, {...neutralSettings(), warmth: 20}, buffer);

		assert.equal(out.data, buffer);
	});
});

describe('Undo edit and the merge', () => {
	const live = {created_at: '2026-10-01T00:00:00.000Z', deleted_at: null, id: 'p1', path: 'u/p1/p1.webp', side: 'front'};
	const removed = {...live, deleted_at: '2026-10-31T10:00:00.000Z'};
	const restored = {...live, restored_at: '2026-10-31T10:00:05.000Z'};

	test('a photo restored after its removal wins over the tombstone, from either side', () => {
		assert.equal(mergePhotoLists([restored], [removed])[0].deleted_at, null);
		assert.equal(mergePhotoLists([removed], [restored])[0].deleted_at, null);
	});

	test('a removal after the restore wins again, and a plain live photo still loses', () => {
		const again = {...restored, deleted_at: '2026-10-31T10:01:00.000Z'};

		assert.equal(mergePhotoLists([restored], [again])[0].deleted_at, again.deleted_at);
		assert.equal(mergePhotoLists([live], [removed])[0].deleted_at, removed.deleted_at);
	});
});
