// A test harness for binder spreads (js/binder-spread.js), cover images
// (js/binder-cover.js), and the size presets (js/binder-presets.js). The
// shell files (js/binders-view.js, index.html, sw.js) get their integration
// lines from the app shell work; until then this page mounts the exported
// components the way those lines do: binderSpread() with a pocket renderer
// and handler shaped like js/binders-view.js's (tiles from js/tile.js, a tap
// that places a card through js/binders.js), a binder list cover painted by
// paintCover(), and the presets row.
//
// Every file is the real one, served by tests/pages-server.mjs, except the
// harness page itself, which a Playwright route serves at
// /pokemon-card-tracker/binder-spread-harness.html.
//
// Run on its own: node tests/binder-spread-harness.mjs [port]

import {fileURLToPath} from 'node:url';

import {startPagesServer} from './pages-server.mjs';

const BASE = '/pokemon-card-tracker/';

export const HARNESS_PATH = `${BASE}binder-spread-harness.html`;

export const HARNESS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Binder spread harness | Card Tracker</title>
<link rel="stylesheet" href="${BASE}style.css">
<link rel="stylesheet" href="${BASE}css/binders.css">
<link rel="stylesheet" href="${BASE}css/photos.css">
<link rel="stylesheet" href="${BASE}css/binder-spread.css">
<style>
	.h-list { display: grid; gap: 12px; grid-template-columns: 150px 1fr; align-items: start; margin-top: 16px; }
	.h-tools { display: grid; gap: 8px; }
</style>
</head>
<body>
<div id="errors"></div>
<main>
	<div id="view"></div>
	<div class="h-list">
		<div id="list"></div>
		<div class="h-tools"><button id="h-cover" type="button">Cover image</button><div id="presets"></div></div>
	</div>
</main>
<script type="module">
	import {currentUser, restoreSession} from '${BASE}js/auth.js';
	import {binderSpread} from '${BASE}js/binder-spread.js';
	import {coverImageUrl, localCover, paintCover, pickCoverImage} from '${BASE}js/binder-cover.js';
	import {presetFields, presetPicker} from '${BASE}js/binder-presets.js';
	import {createBinder, getBinder, leaveEmpty, listBinders, pageSlots, placeCard, placePlaceholder, placements, unplacedCards} from '${BASE}js/binders.js';
	import {addCard, listCards, loadDocument, useAccount} from '${BASE}js/collection.js';
	import {cardArt, tileArt} from '${BASE}js/tile.js';

	const NAMES = ['Alakazam', 'Blastoise', 'Chansey', 'Charizard', 'Clefairy', 'Gyarados', 'Hitmonchan', 'Machamp', 'Magneton', 'Mewtwo', 'Nidoking', 'Ninetales', 'Poliwrath', 'Raichu', 'Venusaur', 'Zapdos'];
	const IMAGE = (n) => 'https://assets.tcgdex.net/en/base/base1/' + n + '/low.webp';

	const taps = [];
	let binder = null;
	let spread = null;
	let entries = new Map();
	let placed = new Map();
	let slotCache = new Map();

	async function seed() {
		const existing = (await listBinders())[0];

		if (existing) {
			return existing;
		}

		for (let i = 0; i < NAMES.length; i++) {
			await addCard({card_id: 'base1-' + (i + 1), catalog: 'international', language: i === 3 ? 'ja' : 'en', language_source: 'manual'});
		}

		const made = await createBinder({cover_color: '#1d2e60', name: 'Gen 1 and 2', notes: 'Generations 1 and 2', ...presetFields('9-pocket-zip')});
		const cards = await listCards();

		// Page 1 full but one, pages 2 and 3 partly, a placeholder and an
		// empty-on-purpose pocket; the rest of the cards stay unplaced.
		const spots = [[1, 1], [1, 2], [1, 3], [1, 4], [1, 5], [1, 6], [1, 7], [1, 8], [2, 1], [2, 5], [3, 3], [3, 9]];

		for (let i = 0; i < spots.length; i++) {
			await placeCard(made.id, spots[i][0], spots[i][1], cards[i].id);
		}

		await placePlaceholder(made.id, 2, 2, {card_id: 'base1-16', image: IMAGE(16), name: 'Zapdos'});
		await leaveEmpty(made.id, 3, 5);

		return getBinder(made.id);
	}

	const infoOf = (entry) => {
		const n = Number(String(entry.card_id).split('-')[1]);

		return {image: IMAGE(n), name: NAMES[n - 1] || entry.card_id, number: String(n), setName: 'Base'};
	};

	// The way js/binders-view.js draws a pocket: a button whose tap is the
	// caller's handler (there, the picker sheet; here, place the next card
	// not in a binder, so the test can see a card land).
	function renderPocket(page, position) {
		if (!slotCache.has(page)) {
			slotCache.set(page, pageSlots(binder, page, placed));
		}

		const slot = slotCache.get(page).get(position) || null;
		let kind = 'open';
		let node = document.createElement('span');
		let label = 'Empty';

		node.className = 'pocket-plus';
		node.textContent = '+';

		if (slot && slot.entry_id && entries.get(slot.entry_id)) {
			const entry = entries.get(slot.entry_id);
			const info = infoOf(entry);

			kind = 'card';
			label = info.name;
			node = tileArt({info, languages: [entry.language], src: info.image, viewing: 'en'});
		}
		else if (slot && slot.want) {
			const info = {image: slot.want.image, name: slot.want.name, number: null, setName: null};
			const tag = document.createElement('span');

			kind = 'want';
			label = info.name + ', placeholder';
			node = document.createElement('div');
			node.className = 'art-wrap';
			tag.className = 'pocket-tag';
			tag.textContent = 'Want';
			node.append(cardArt(info, info.image), tag);
		}
		else if (slot && slot.empty) {
			kind = 'empty';
			label = 'Left empty on purpose';
			node = document.createElement('span');
			node.className = 'pocket-text';
			node.textContent = 'Empty';
		}

		const button = document.createElement('button');

		button.type = 'button';
		button.className = 'pocket pocket-' + kind;
		button.dataset.kind = kind;
		button.dataset.position = String(position);
		button.setAttribute('aria-label', 'Page ' + page + ', pocket ' + position + ': ' + label);
		button.addEventListener('click', () => onPocketTap(page, position));
		button.append(node);

		return button;
	}

	async function onPocketTap(page, position) {
		taps.push({page, position});

		const loose = await unplacedCards();

		if (loose.length) {
			await placeCard(binder.id, page, position, loose[0].id);
			await reload();
		}
	}

	async function reload() {
		const doc = await loadDocument();

		binder = await getBinder(binder.id);
		entries = new Map(doc.cards.map((entry) => [entry.id, entry]));
		placed = placements(doc.binders);
		slotCache = new Map();

		if (spread) {
			spread.update(binder);
		}

		drawList();
	}

	function drawList() {
		const tile = document.createElement('a');

		tile.className = 'binder-cover';
		tile.id = 'h-list-cover';
		tile.innerHTML = '<span class="binder-name"></span><span class="binder-notes"></span><span class="binder-foot"><span>3 × 3 · 40 pages</span></span>';
		tile.querySelector('.binder-name').textContent = binder.name;
		tile.querySelector('.binder-notes').textContent = binder.notes;
		paintCover(tile, binder);
		document.getElementById('list').replaceChildren(tile);
	}

	async function start() {
		await restoreSession();

		const user = currentUser();

		if (user) {
			await useAccount(user.id);
		}

		binder = await seed();
		await reload();

		spread = binderSpread({binder, renderPocket});
		document.getElementById('view').replaceChildren(spread.element);

		const picker = presetPicker({onPick: (fields) => { window.H.picked = fields; }});

		document.getElementById('presets').append(picker.element);
		document.getElementById('h-cover').addEventListener('click', () => pickCoverImage({binder, onSaved: () => reload()}));
		document.body.dataset.ready = 'true';
	}

	// A made-up phone photo of a binder on a table: a dark background and a
	// tilted, two-tone cover with a stripe, as base64 JPEG bytes.
	async function makeCoverPhoto() {
		const canvas = document.createElement('canvas');

		canvas.width = 1200;
		canvas.height = 1500;

		const ctx = canvas.getContext('2d');

		ctx.fillStyle = '#18161c';
		ctx.fillRect(0, 0, 1200, 1500);
		ctx.save();
		ctx.translate(600, 760);
		ctx.rotate(-0.06);

		const grad = ctx.createLinearGradient(-400, -520, 400, 520);

		grad.addColorStop(0, '#d0412f');
		grad.addColorStop(1, '#f2a541');
		ctx.fillStyle = grad;
		ctx.fillRect(-420, -540, 840, 1080);
		ctx.fillStyle = '#fbe9c8';
		ctx.fillRect(-420, -60, 840, 120);
		ctx.fillStyle = '#2b2a33';
		ctx.font = 'bold 120px sans-serif';
		ctx.textAlign = 'center';
		ctx.fillText('MY BINDER', 0, 40);
		ctx.restore();

		const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
		const bytes = new Uint8Array(await blob.arrayBuffer());
		let text = '';

		for (let i = 0; i < bytes.length; i += 0x8000) {
			text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		}

		return btoa(text);
	}

	// Frame times while work() runs: the gaps between animation frames, in
	// ms, each marked with whether the leaf was moving (its animation had
	// started) or the turn was still building the new pages.
	async function frames(work) {
		const gaps = [];
		let last = performance.now();
		let running = true;
		const tick = (now) => {
			const leaf = document.querySelector('.bs-leaf');

			gaps.push({gap: now - last, moving: Boolean(leaf && leaf.getAnimations().length)});
			last = now;

			if (running) {
				requestAnimationFrame(tick);
			}
		};

		requestAnimationFrame(tick);
		await work();
		running = false;

		return gaps.slice(1);
	}

	// Elements in the binder drawing that could read as a ring: SVG circles
	// and ellipses, round outlined shapes with an open middle, and any class
	// naming a ring.
	function ringLike(root = document.getElementById('binder-spread')) {
		const found = [];

		for (const node of root.querySelectorAll('*')) {
			const name = typeof node.className === 'string' ? node.className : (node.className && node.className.baseVal) || '';

			if (/ring/i.test(name) || node.localName === 'circle' || node.localName === 'ellipse') {
				found.push(node.localName + '.' + name);
				continue;
			}

			for (const pseudo of [null, '::before', '::after']) {
				const style = getComputedStyle(node, pseudo);

				if (pseudo && style.content === 'none') {
					continue;
				}

				const width = parseFloat(style.width);
				const height = parseFloat(style.height);
				const radius = parseFloat(style.borderTopLeftRadius);
				const round = width > 4 && Math.abs(width - height) < 2 && (style.borderTopLeftRadius.endsWith('%') ? radius >= 50 : radius >= width / 2 - 1);
				const outlined = parseFloat(style.borderTopWidth) > 0 || /inset|0px 0px 0px [1-9]/.test(style.boxShadow);
				const open = style.backgroundColor === 'rgba(0, 0, 0, 0)' && style.backgroundImage === 'none';

				if (round && outlined && open) {
					found.push(node.localName + '.' + name + (pseudo || ''));
				}
			}
		}

		return found;
	}

	window.H = {
		binder: () => binder,
		coverImageUrl: () => coverImageUrl(binder),
		frames,
		localCover,
		makeCoverPhoto,
		picked: null,
		reload,
		ringLike,
		spread: () => spread,
		taps,
		user: () => currentUser(),
	};

	start().catch((err) => {
		document.body.dataset.ready = 'error';
		document.body.dataset.error = String(err && err.stack || err);
	});
</script>
</body>
</html>
`;

// Serves the harness page, with any search string (?spread=); every other
// app file goes to the Pages imitation.
export async function routeHarness(context, origin) {
	await context.route((url) => url.origin === origin && url.pathname === HARNESS_PATH, (route) => route.fulfill({body: HARNESS_HTML, contentType: 'text/html; charset=utf-8'}));
}

export const startHarness = (port = 0) => startPagesServer(port);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const {origin} = await startHarness(Number(process.argv[2]) || 8003);

	console.log(`Pages imitation at ${origin}${BASE}; the harness page needs the Playwright route in tests/binder-spread-browser.test.mjs.`);
}
