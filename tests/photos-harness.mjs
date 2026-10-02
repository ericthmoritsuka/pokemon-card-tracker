// A test harness for the owner's card photos (js/photos/). The app's own
// files (app.js, index.html, sw.js, catalog-views.js, cards-view.js) carry
// the photos' integration lines; this page mounts the exported components
// directly, the way those lines do: card detail's image block (cardPhotos)
// in a .hero-art column beside the facts, and a row of tiles made by
// js/tile.js cardTile() with tileSrc and withMainPhoto, over the real
// collection, auth, and Supabase client.
//
// The page is served at /pokemon-card-tracker/photos-harness.html by a
// Playwright route; every other file is the real one, from
// tests/pages-server.mjs, or, while a test has the browser offline, straight
// from disk (standing in for the service worker's shell cache, which lists
// the photo modules).
//
// INTEGRATION lists the lines in the shared files, and checkIntegration
// asserts that each one is in the real file, so a change to a shared file
// that drops one fails the test instead of silently testing without photos.
// PENDING lists the lines the inspection viewer and the detail-copy setting
// need in shared files that may not carry them yet; pendingIntegration()
// names the missing ones without failing, so a test can print them. Once
// they land, move them into INTEGRATION.
//
// Run on its own: node tests/photos-harness.mjs [port]

import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {extname, join, normalize} from 'node:path';
import {fileURLToPath} from 'node:url';

import {startPagesServer} from './pages-server.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BASE = '/pokemon-card-tracker/';

export const HARNESS_PATH = `${BASE}photos-harness.html`;

export const INTEGRATION = {
	catalogViews: {
		// After the last import line.
		import: 'import {cardPhotos} from \'./photos/index.js\';',
		// In cardView, after const swipe = cardSwipe(root, route);
		create: '\tconst photos = cardPhotos({cardId, catalog: catalogFor(lang)});',
		// In render(), replacing the hero-art line. twins is the
		// international twin's slide (js/twins.js twinSlides), or none.
		art: '\t\t\t\th(\'div\', {class: \'hero-art\'}, photos.show({art: cardArt, info, official: cardImage(card.image, \'high\'), twins})),',
		// In the returned cleanup, after alive = false;
		destroy: '\t\tphotos.destroy();',
	},
	cardsView: {
		// After the last import line.
		import: 'import {tileSrc, withMainPhoto} from \'./photos/index.js\';',
		// The tile.js import gains cardArt.
		tileImport: 'import {cardArt, cardTile, groupFinish} from \'./tile.js\';',
		// In tile(group), after const info = {...};
		catalogSrc: '\t\tconst catalogSrc = local ? cardImage(local.image, \'low\') : null;',
		// return cardTile({...}) becomes
		wrap: '\t\treturn withMainPhoto(cardTile({',
		// art.src becomes (twins: the group's international twin slide,
		// js/twins.js twinSlides)
		src: '\t\t\t\tsrc: tileSrc(group.entries, catalogSrc, {twins: group.twins}),',
		// and the call closes with
		close: '\t\t}), group.entries, catalogSrc, (src) => cardArt(info, src), {twins: group.twins});',
	},
	app: {
		// Among the imports, and in startAccount after startSync(); (and the
		// wishlist's keepFamilyWishlistsCached();).
		import: 'import {startPhotoSync} from \'./js/photos/index.js\';',
		sync: '\tstartPhotoSync();',
	},
	index: {
		// After the last stylesheet link.
		stylesheet: '\t<link rel="stylesheet" href="/pokemon-card-tracker/css/photos.css">',
	},
	sw: {
		// In SHELL, and bump VERSION.
		shell: [
			'\t\'js/photos/carousel.js\',',
			'\t\'js/photos/detect.js\',',
			'\t\'js/photos/editor.js\',',
			'\t\'js/photos/encode.js\',',
			'\t\'js/photos/geometry.js\',',
			'\t\'js/photos/index.js\',',
			'\t\'js/photos/model.js\',',
			'\t\'js/photos/store.js\',',
			'\t\'lab/js/camera.js\',',
			'\t\'lab/js/pipeline.js\',',
			'\t\'lab/js/rectify.js\',',
			'\t\'css/photos.css\',',
		],
	},
};

export const PENDING = {
	sw: {
		// In SHELL, after 'js/photos/store.js', (and bump VERSION).
		shell: [
			'\t\'js/photos/viewer.js\',',
			'\t\'js/photos/zoom.js\',',
		],
	},
	accountViews: {
		// After the last import line.
		import: 'import {photoSettingsCard} from \'./photos/index.js\';',
		// In profileView, after dataCard(), in the signed-out branch...
		signedOut: '\t\t\tphotoSettingsCard(),',
		// ...and in the signed-in one.
		signedIn: '\t\tphotoSettingsCard(),',
	},
};

const read = (path) => readFile(join(ROOT, path), 'utf8');

const lines = (text) => new Set(text.split('\n'));

// Asserts that the real shared files carry every line in INTEGRATION.
export async function checkIntegration() {
	const app = await read('app.js');
	const catalogViews = await read('js/catalog-views.js');
	const cardsView = await read('js/cards-view.js');
	const index = await read('index.html');
	const sw = await read('sw.js');

	assert.ok(lines(app).has(INTEGRATION.app.import), 'app.js imports startPhotoSync');
	assert.match(app, /^\tstartSync\(\);\n(?:\tkeepFamilyWishlistsCached\(\);\n)?\tstartPhotoSync\(\);$/m, 'app.js runs startPhotoSync() after startSync()');

	const card = /^export function cardView\([\s\S]*?\n\}\n/m.exec(catalogViews);

	assert.ok(card, 'js/catalog-views.js has cardView');

	const {art, create, destroy, import: photosImport} = INTEGRATION.catalogViews;

	assert.ok(lines(catalogViews).has(photosImport), 'js/catalog-views.js imports cardPhotos');
	assert.match(card[0], /^\tconst swipe = cardSwipe\(root, route\);\n\tconst photos = cardPhotos\(\{cardId, catalog: catalogFor\(lang\)\}\);$/m, 'cardView creates the photos after the swipe');
	assert.ok(lines(card[0]).has(create));
	assert.ok(lines(card[0]).has(art), 'the hero art is the photos block');
	assert.match(card[0], /\treturn \(\) => \{\n\t\talive = false;\n(?:\t\t.*\n)*?\t\tphotos\.destroy\(\);\n\t\};\n\}\n$/, 'the cleanup destroys the photos');
	assert.ok(lines(card[0]).has(destroy));

	for (const line of Object.values(INTEGRATION.cardsView)) {
		assert.ok(lines(cardsView).has(line), `js/cards-view.js carries ${line.trim()}`);
	}

	assert.ok(lines(index).has(INTEGRATION.index.stylesheet), 'index.html links css/photos.css');

	for (const line of INTEGRATION.sw.shell) {
		assert.ok(lines(sw).has(line), `sw.js SHELL lists ${line.trim()}`);
	}
}

// The PENDING lines the shared files do not carry yet, as
// "<file>: <line>" strings; empty once everything is integrated.
export async function pendingIntegration() {
	const sw = lines(await read('sw.js'));
	const account = lines(await read('js/account-views.js'));
	const missing = [];

	for (const line of PENDING.sw.shell) {
		if (!sw.has(line)) {
			missing.push(`sw.js: ${line.trim()}`);
		}
	}

	for (const line of Object.values(PENDING.accountViews)) {
		if (!account.has(line)) {
			missing.push(`js/account-views.js: ${line.trim()}`);
		}
	}

	return missing;
}

export const HARNESS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Photos harness | Card Tracker</title>
<link rel="stylesheet" href="${BASE}style.css">
<link rel="stylesheet" href="${BASE}css/photos.css">
<style>
	body { margin: 0; }
	main { padding: 12px 16px 48px; }
	.h-tiles { display: grid; gap: 8px; grid-template-columns: repeat(3, 1fr); margin-bottom: 16px; }
	.h-tiles .tile { color: inherit; display: block; font-size: 0.75rem; text-decoration: none; }
	.h-page { border: 1px dashed var(--border); border-radius: 12px; padding: 16px; margin-top: 16px; }
	.h-hero { align-items: start; display: grid; gap: 12px; grid-template-columns: 45% 1fr; }
	.h-hero .hero-facts h2 { font-size: 1.1rem; margin: 0 0 8px; }
</style>
</head>
<body>
<div id="errors"></div>
<main>
	<h1 class="h-title">Photos harness</h1>
	<div class="card-grid" id="tiles"></div>
	<div class="card-hero h-hero">
		<div class="hero-art" id="detail"></div>
		<div class="hero-facts"><h2 id="detail-name"></h2><p class="muted">Facts, price, and Ver na Liga sit here on card detail.</p></div>
	</div>
	<div class="h-page" id="page-area">Page area: a sideways drag here is a page swipe.</div>
	<div id="settings"></div>
</main>
<script type="module">
	import {currentUser, restoreSession} from '${BASE}js/auth.js';
	import {cardArt} from '${BASE}js/catalog-views.js';
	import {cardTile} from '${BASE}js/tile.js';
	import {addCard, listCards, loadDocument, useAccount} from '${BASE}js/collection.js';
	import {applyHomography, solveHomography} from '${BASE}js/photos/geometry.js';
	import {SWIPE_EVENT, cardPhotos, isCarouselGesture, mainImage, photoSettingsCard, tileSrc, withMainPhoto} from '${BASE}js/photos/index.js';
	import * as store from '${BASE}js/photos/store.js';

	const counts = {carouselSwipes: 0, pageSwipes: 0, pagePointerMovesFromCarousel: 0};

	// A stand-in for the page-level swipe between cards (DESIGN.md section 3):
	// a sideways drag of 60 px anywhere it hears about counts as one.
	let down = null;

	document.addEventListener('pointerdown', (event) => {
		down = {x: event.clientX, y: event.clientY};
	});
	document.addEventListener('pointermove', (event) => {
		if (isCarouselGesture(event)) {
			counts.pagePointerMovesFromCarousel++;
		}
	});
	document.addEventListener('pointerup', (event) => {
		if (down && Math.abs(event.clientX - down.x) > 60 && Math.abs(event.clientX - down.x) > Math.abs(event.clientY - down.y)) {
			counts.pageSwipes++;
		}

		down = null;
	});
	document.addEventListener(SWIPE_EVENT, () => {
		counts.carouselSwipes++;
	});

	const OFFICIAL = {
		high: 'https://assets.tcgdex.net/en/me/me01/001/high.webp',
		low: 'https://assets.tcgdex.net/en/me/me01/001/low.webp',
	};

	const CARDS = {
		e1: {card_id: 'me01-001', catalog: 'international', language: 'en', language_source: 'manual'},
		k1: {card_id: 'M6-007', catalog: 'ja', language: 'ko', language_source: 'import', name_local: '테스트 카드', set_name_local: '테스트 세트'},
	};

	let detail = null;
	let ids = {};

	async function seed() {
		const doc = await loadDocument();

		if (!doc.cards.length) {
			await addCard(CARDS.e1);
			await addCard(CARDS.k1);
		}

		const cards = await listCards();

		ids = {e1: cards.find((card) => card.card_id === CARDS.e1.card_id).id, k1: cards.find((card) => card.card_id === CARDS.k1.card_id).id};

		return ids;
	}

	const officialOf = (entry, size) => (entry.card_id === CARDS.e1.card_id ? OFFICIAL[size] : null);
	const infoOf = (entry) => ({name: entry.card_id === CARDS.e1.card_id ? 'Test Bulbasaur' : '테스트 카드', number: '001', setName: 'Test set'});

	async function drawTiles() {
		const cards = await listCards();
		const tiles = document.getElementById('tiles');

		// The way js/cards-view.js tile() will call it, with the integration
		// lines in place.
		tiles.replaceChildren(...cards.map((entry) => {
			const info = infoOf(entry);
			const catalogSrc = officialOf(entry, 'low');

			return withMainPhoto(cardTile({
				art: {
					count: 1,
					info,
					languages: [entry.language],
					src: tileSrc([entry], catalogSrc),
					viewing: 'en',
				},
				attrs: {'data-entry': entry.id, 'data-kind': mainImage([entry], catalogSrc).kind},
				meta: '#001',
				names: info.name,
			}), [entry], catalogSrc, (src) => cardArt(info, src));
		}));
	}

	async function openDetail(key) {
		if (detail) {
			detail.destroy();
		}

		const cards = await listCards();
		const entry = cards.find((card) => card.id === ids[key]);

		detail = cardPhotos({cardId: entry.card_id, catalog: entry.catalog});
		detail.element.dataset.card = key;
		document.getElementById('detail-name').textContent = infoOf(entry).name;
		document.getElementById('detail').replaceChildren(detail.show({art: cardArt, info: infoOf(entry), official: officialOf(entry, 'high')}));
	}

	// A phone photo of the card on a dark table: the card image warped onto
	// quad (a perspective tilt) on a dark, slightly lit, noisy background.
	// Returns base64 JPEG bytes. With no card image (no network when the test
	// started), a drawn stand-in card is used.
	async function makeTestPhoto({height = 1600, quad, width = 1200}) {
		const face = await cardFace();
		const canvas = document.createElement('canvas');

		canvas.width = width;
		canvas.height = height;

		const ctx = canvas.getContext('2d');
		const light = ctx.createRadialGradient(width * 0.4, height * 0.3, 50, width * 0.5, height * 0.5, height * 0.8);

		light.addColorStop(0, '#2b2a30');
		light.addColorStop(1, '#0d0d10');
		ctx.fillStyle = light;
		ctx.fillRect(0, 0, width, height);

		const bg = ctx.getImageData(0, 0, width, height);
		const h = solveHomography(quad, [{x: 0, y: 0}, {x: face.width, y: 0}, {x: face.width, y: face.height}, {x: 0, y: face.height}]);
		let seed = 11;

		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const o = (y * width + x) * 4;

				seed = (seed * 1103515245 + 12345) % 2147483648;

				const noise = (seed / 2147483648) * 14 - 7;
				const p = applyHomography(h, x + 0.5, y + 0.5);
				let r = bg.data[o] + noise;
				let g = bg.data[o + 1] + noise;
				let b = bg.data[o + 2] + noise;

				if (p.x >= 0 && p.y >= 0 && p.x < face.width && p.y < face.height) {
					const i = (Math.floor(p.y) * face.width + Math.floor(p.x)) * 4;
					const a = face.data[i + 3] / 255;

					r = r * (1 - a) + face.data[i] * a;
					g = g * (1 - a) + face.data[i + 1] * a;
					b = b * (1 - a) + face.data[i + 2] * a;
				}

				bg.data[o] = r;
				bg.data[o + 1] = g;
				bg.data[o + 2] = b;
			}
		}

		ctx.putImageData(bg, 0, 0);

		const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
		const bytes = new Uint8Array(await blob.arrayBuffer());
		let text = '';

		for (let i = 0; i < bytes.length; i += 0x8000) {
			text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		}

		return btoa(text);
	}

	async function cardFace() {
		try {
			const img = new Image();

			img.crossOrigin = 'anonymous';
			img.src = OFFICIAL.high;
			await img.decode();

			const canvas = document.createElement('canvas');

			canvas.width = img.naturalWidth;
			canvas.height = img.naturalHeight;
			canvas.getContext('2d').drawImage(img, 0, 0);

			return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
		}
		catch {
			const canvas = document.createElement('canvas');

			canvas.width = 600;
			canvas.height = 825;

			const ctx = canvas.getContext('2d');

			ctx.fillStyle = '#eec834';
			ctx.fillRect(0, 0, 600, 825);
			ctx.fillStyle = '#9ac7e0';
			ctx.fillRect(40, 80, 520, 330);
			ctx.fillStyle = '#d8d2c4';
			ctx.fillRect(28, 430, 544, 360);

			return ctx.getImageData(0, 0, 600, 825);
		}
	}

	async function photoInfo(photoId) {
		const blob = await store.localPhoto(photoId);

		if (!blob) {
			return null;
		}

		const bitmap = await createImageBitmap(blob);

		return {bytes: blob.size, height: bitmap.height, type: blob.type, width: bitmap.width};
	}

	async function start() {
		await restoreSession();

		const user = currentUser();

		if (user) {
			await useAccount(user.id);
		}

		await seed();
		await drawTiles();

		// Profile's card for this phone's photo setting, as js/account-views.js
		// mounts it.
		document.getElementById('settings').replaceChildren(photoSettingsCard());
		document.body.dataset.ready = 'true';
	}

	window.H = {
		counts,
		drawTiles,
		ids: () => ids,
		listCards,
		loadDocument,
		makeTestPhoto,
		openDetail,
		photoInfo,
		start,
		store,
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

const TYPES = {
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.webmanifest': 'application/manifest+json',
};

// Serves the harness page, and every app file from disk while `offline()`
// is true (the service worker's shell cache, offline). Online, app files go
// to the Pages imitation.
export async function routeHarness(context, origin, {offline = () => false} = {}) {
	await context.route(`${origin}${BASE}**`, async (route) => {
		const {pathname} = new URL(route.request().url());

		if (pathname === HARNESS_PATH) {
			return route.fulfill({body: HARNESS_HTML, contentType: 'text/html; charset=utf-8'});
		}

		if (!offline()) {
			return route.continue();
		}

		const relative = normalize(decodeURIComponent(pathname.slice(BASE.length)));

		if (relative.startsWith('..')) {
			return route.abort();
		}

		try {
			const body = await readFile(join(ROOT, relative));

			return route.fulfill({body, contentType: TYPES[extname(relative)] || 'application/octet-stream'});
		}
		catch {
			return route.abort('internetdisconnected');
		}
	});
}

// Checks the integration, then starts the Pages imitation over the real
// files.
export async function startHarness(port = 0) {
	await checkIntegration();

	return startPagesServer(port);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const {origin} = await startHarness(Number(process.argv[2]) || 8002);

	console.log(`Pages imitation at ${origin}${BASE}; the harness page needs the Playwright route in tests/photos-browser.test.mjs.`);
}
