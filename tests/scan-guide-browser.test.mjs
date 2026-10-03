// The scanner's guide with a portrait rear camera, in headless Chromium,
// against tests/scan-harness.mjs (Supabase is never reached; TCGdex
// answers are replayed from the harness cache).
//
// Chrome's fake capture device is landscape, which hides what Eric's phone
// showed (2026-10-03: 384 x 854 CSS px at DPR 2.8125, the rear camera 2160 x
// 3840 portrait): a guide sized from the camera frame ran under the tray.
// Here getUserMedia is replaced by a 2160 x 3840 canvas stream, at three
// heights of the video area. A card (a TCGdex scan) is drawn where a person
// would hold it, filling the guide outline, and the test times the
// automatic capture and the read.
//
// MEASURE_ONLY=1 prints the measurements without asserting them (for
// measuring an older checkout with this file copied in).
//
// Run: PLAYWRIGHT=/path/to/node_modules/playwright node --test tests/scan-guide-browser.test.mjs

import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {after, before, describe, test} from 'node:test';

import {cardImage, routeTcgdex, startScanHarness} from './scan-harness.mjs';

const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT || 'playwright');

const BASE = '/pokemon-card-tracker/';
const SHOTS = process.env.SHOTS || '/tmp';
const MEASURE_ONLY = process.env.MEASURE_ONLY === '1';
const LABEL = process.env.SHOT_LABEL || 'after';
const CARD = 'me01-001';
const FRAME = {height: 3840, width: 2160};

let harness;
let browser;

before(async () => {
	harness = await startScanHarness();
	browser = await chromium.launch();
});

after(async () => {
	await browser.close();
	await harness.close();
});

// In the page before any script: getUserMedia answers with a portrait
// canvas stream. The canvas shows a table, and, once window.showCard is
// true, the card filling 0.95 of the guide outline wherever it is drawn
// (the frame position under the outline, through object-fit: cover).
function portraitCamera({height, width}) {
	const canvas = document.createElement('canvas');
	const ctx = canvas.getContext('2d');
	const card = new Image();

	canvas.width = width;
	canvas.height = height;
	card.src = '/__test-card.webp';
	window.showCard = false;

	const draw = () => {
		ctx.fillStyle = '#7a6250';
		ctx.fillRect(0, 0, width, height);

		const guide = document.getElementById('scan-guide');
		const video = document.getElementById('scan-video');

		if (window.showCard && guide && !guide.hidden && video && card.complete) {
			const g = guide.getBoundingClientRect();
			const v = video.getBoundingClientRect();
			const scale = Math.max(v.width / width, v.height / height);
			const offsetX = v.left + (v.width - width * scale) / 2;
			const offsetY = v.top + (v.height - height * scale) / 2;
			const cx = (g.left + g.width / 2 - offsetX) / scale;
			const cy = (g.top + g.height / 2 - offsetY) / scale;
			const ch = (g.height / scale) * 0.95;
			const cw = ch * 63 / 88;

			ctx.save();
			ctx.translate(cx, cy);
			ctx.rotate(0.6 * Math.PI / 180);
			ctx.drawImage(card, -cw / 2, -ch / 2, cw, ch);
			ctx.restore();
		}
	};

	draw();
	setInterval(draw, 40);

	const stream = canvas.captureStream(25);

	navigator.mediaDevices.getUserMedia = async () => stream;
}

async function measure(height) {
	const context = await browser.newContext({deviceScaleFactor: 2.8125, viewport: {height, width: 384}});

	await context.grantPermissions(['camera'], {origin: harness.origin});
	await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
	await routeTcgdex(context);
	await context.route('**/__test-card.webp', async (route) => route.fulfill({contentType: 'image/webp', path: await cardImage(CARD)}));
	await context.addInitScript(portraitCamera, FRAME);

	const page = await context.newPage();
	const errors = [];

	page.on('pageerror', (err) => errors.push(String(err)));
	await page.goto(`${harness.origin}${BASE}scan`);
	await page.waitForSelector('#scan-guide:not([hidden])', {timeout: 30000});
	await page.waitForFunction(() => document.getElementById('scan-video').videoWidth > 0);
	await page.waitForTimeout(400);

	const boxes = await page.evaluate(() => {
		const rect = (el) => {
			const r = el.getBoundingClientRect();

			return {bottom: r.bottom, height: r.height, left: r.left, right: r.right, top: r.top, width: r.width};
		};
		const video = document.getElementById('scan-video');

		return {camera: `${video.videoWidth} x ${video.videoHeight}`, guide: rect(document.getElementById('scan-guide')), stage: rect(video.parentElement)};
	});

	await page.screenshot({path: `${SHOTS}/scan-guide-${height}-${LABEL}.png`});

	// The card held up: how long until the automatic capture, and until the
	// card is in the tray.
	const shown = await page.evaluate(() => {
		window.showCard = true;

		return performance.now();
	});
	let captured = null;
	let settled = null;

	for (let i = 0; i < 200 && settled === null; i++) {
		await page.waitForTimeout(50);

		const state = await page.evaluate(async () => {
			const view = await import('/pokemon-card-tracker/js/scan/view.js');
			const tile = document.querySelector('#scan-tray .scan-tile');

			return {captures: view.scanStats.captures, now: performance.now(), status: tile ? tile.dataset.status : null};
		});

		if (captured === null && state.captures > 0) {
			captured = Math.round(state.now - shown);
		}

		if (state.status && ['ready', 'unsure', 'unmatched', 'language', 'waiting'].includes(state.status)) {
			settled = Math.round(state.now - shown);
		}
	}

	// The label row is read behind the result; give it a moment.
	for (let i = 0; i < 100; i++) {
		const read = await page.evaluate(async () => {
			const session = await (await import('/pokemon-card-tracker/js/scan/draft.js')).loadSession();

			return Boolean(session && session.items[0] && session.items[0].labelCheck);
		});

		if (read) {
			break;
		}

		await page.waitForTimeout(200);
	}

	await page.waitForTimeout(300);
	await page.screenshot({path: `${SHOTS}/scan-guide-${height}-${LABEL}-result.png`});

	const report = await page.evaluate(async () => {
		const draft = await import('/pokemon-card-tracker/js/scan/draft.js');
		const session = await draft.loadSession();
		const item = session && session.items[0];

		return item ? {card: item.card && item.card.id, label: item.labelCheck || null, language: item.language, languageBy: item.languageBy, name: item.card && item.card.name, report: item.report || null, sure: item.sure} : null;
	});

	await context.close();

	return {boxes, captured, errors, report, settled};
}

describe('the guide with a portrait camera (Eric\'s phone, 2026-10-03)', () => {
	for (const height of [700, 730, 780]) {
		test(`384 x ${height}: the whole guide shows, and a card held to it is captured and read`, async () => {
			const {boxes, captured, errors, report, settled} = await measure(height);
			const {guide, stage} = boxes;
			const picture = report && report.report && report.report.picture;
			const rectify = report && report.report && report.report.rectify;
			const match = report && report.report && report.report.match;

			console.log(`# ${height}: camera ${boxes.camera}; stage ${Math.round(stage.width)} x ${Math.round(stage.height)} at ${Math.round(stage.top)}; guide ${Math.round(guide.width)} x ${Math.round(guide.height)}, top ${Math.round(guide.top - stage.top)}, bottom ${Math.round(stage.bottom - guide.bottom)} px inside the stage (negative: cut off); auto capture ${captured} ms after the card appeared; in the tray ${settled} ms; edges ${rectify ? `${rectify.found ? 'found' : 'not found'}${rectify.guessed ? `, ${rectify.guessed} guessed` : ''}` : '?'}; top distance ${picture && picture.groups[0] ? picture.groups[0].score : '?'}, lead ${picture ? picture.gap : '?'}; lookup ${match ? match.ms : '?'} ms; ${report ? `${report.card} "${report.name}", ${report.language} (${report.languageBy}), ${report.sure ? 'sure' : 'not sure'}` : 'no card'}`);

			if (MEASURE_ONLY) {
				return;
			}

			assert.deepEqual(errors, []);
			assert.ok(guide.top - stage.top >= 13.5, `guide top ${guide.top - stage.top} px inside`);
			assert.ok(stage.bottom - guide.bottom >= 13.5, `guide bottom ${stage.bottom - guide.bottom} px inside`);
			assert.ok(guide.left >= 13.5 && guide.right <= 384 - 13.5);
			assert.ok(Math.abs(guide.width / guide.height - 63 / 88) < 0.01);
			assert.ok(captured !== null && captured < 2000, `captured after ${captured} ms`);
			assert.equal(report.card, CARD);
			assert.equal(rectify.found, true);
			assert.equal(rectify.guessed, null, 'all four edges found');
			assert.ok(picture.groups[0].score <= 45, `distance ${picture.groups[0].score}`);
			assert.equal(report.sure, true);
			// No language picked yet, so it started in Portuguese; the card is
			// an English print, and its label row, read in the background,
			// said so.
			assert.equal(report.label && report.label.code, 'en');
			assert.equal(report.language, 'en');
			assert.equal(report.languageBy, 'read');
			assert.match(report.report.geometry.capture, /^\d+ x \d+ at \d+, \d+$/);
		});
	}
});
