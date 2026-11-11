// Save image on card detail (Eric, 2026-11-11: he needed a card's picture
// for a video, and the page offered only to save the page). The button in
// the carousel (carousel.js) saves the slide on screen as a file named after
// the card; the browser's own image menu (right-click, long-press) works on
// the image too.
//
// An official image (or the international print) is TCGdex's PNG of it,
// read in cors mode so it can be handed over as a named download. TCGdex
// sends Access-Control-Allow-Origin twice on some images (js/image-folders.js),
// which fails that read whatever the code does, and so does a 404, which it
// sends with no CORS header. On 2026-11-11, 32 of 48 sampled images failed
// for both their PNG and their WebP, from the CDN's copies as the browser
// gets them, and a request past those copies failed every time, so trying
// again does not help. So the PNG is asked next of the project's relay
// (supabase/functions/tcgdex-image), which fetches it server side and sends
// the header once, for a signed-in person. Then the WebP the carousel shows
// (the service worker may have it kept, even offline), saved as a PNG
// (toPng). When all of them fail, the PNG opens in a new tab, where the
// browser's own menu saves it. A photo
// (yours, or a family member's) is read the way the carousel reads it
// (store.js: from the phone, else from the bucket), its detail copy when
// there is one, since that is the sharpest.

import {downloadBlob} from '../scan/image.js';

// Characters Windows or Android refuse in a file name, and control
// characters.
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;

// A file name made safe on Windows and Android: each illegal character a
// space ("A/B" stays two words), spaces collapsed, and no trailing dot or
// space (Windows drops those).
export function cleanFileName(text) {
	const clean = String(text || '').replace(ILLEGAL, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');

	return clean.slice(0, 180).trim() || 'Card';
}

// "Pikachu - Surging Sparks 057": what the card page knows (its info, as
// cardPhotos show() gets it), the missing parts left out.
export function cardFileStem(info = {}) {
	const where = [info.setName, info.number].filter(Boolean).join(' ');

	return [info.name, where].filter(Boolean).join(' - ');
}

// The TCGdex language folder of an image URL, upper case ("EN"), or ''.
export function imageLanguage(src) {
	try {
		const {hostname, pathname} = new URL(src);

		return hostname === 'assets.tcgdex.net' ? (pathname.split('/')[1] || '').toUpperCase() : '';
	}
	catch {
		return '';
	}
}

// The same image as a PNG, and as the WebP the app shows: TCGdex serves
// both beside each other ({base}/high.png and {base}/high.webp).
export function officialUrls(src) {
	const base = String(src || '').replace(/\/[a-z]+\.(?:webp|png|jpg)$/, '');

	return base && base !== src ? {png: `${base}/high.png`, webp: `${base}/high.webp`} : null;
}

const EXTENSIONS = {'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp'};

// A blob's file extension from its type, else from its first bytes (a
// bucket download can come without a type).
async function extensionOf(blob) {
	if (EXTENSIONS[blob.type]) {
		return EXTENSIONS[blob.type];
	}

	const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
	const text = String.fromCharCode(...head);

	if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') {
		return 'webp';
	}

	if (head[0] === 0x89 && text.slice(1, 4) === 'PNG') {
		return 'png';
	}

	return 'jpg';
}

const isPhoto = (slide) => slide && (slide.kind === 'photo' || slide.kind === 'family');

// The file name for a slide, without its extension.
export function slideFileStem(slide, {info = {}, slides = []} = {}) {
	const stem = cardFileStem(info);

	if (isPhoto(slide)) {
		const n = slides.filter(isPhoto).indexOf(slide) + 1;

		return cleanFileName(`${stem} photo ${Math.max(1, n)}`);
	}

	const language = imageLanguage(slide && slide.src);
	const print = slide && slide.kind === 'twin' ? ' international print' : '';

	return cleanFileName(`${stem}${print}${language ? ` (${language})` : ''}`);
}

// The tab the fallback opens. Not 'noopener' as a feature, which makes
// window.open return null even when the tab opened, so a blocked tab could
// not be told apart; the opener is cut by hand instead.
function openTab(url) {
	const tab = window.open(url, '_blank');

	if (tab) {
		tab.opener = null;
	}

	return Boolean(tab);
}

async function readImage(url, fetchImpl) {
	try {
		const response = await fetchImpl(url, {credentials: 'omit', mode: 'cors'});

		return response.ok ? await response.blob() : null;
	}
	catch {
		return null;
	}
}

// The relay waits this long at most, so the new tab that may follow still
// counts as the tap's (Chrome lets a tap open a tab for about five seconds;
// past that, the toast's Open image button is the new tap).
const RELAY_TIMEOUT_MS = 4000;

// A TCGdex picture through the project's relay (supabase/functions/
// tcgdex-image), or null: signed out, offline, too slow, or the function not
// deployed. auth.js is loaded only here, so the Node tests of this file do
// not load supabase-js.
export async function relayRead(url, fetchImpl = (...args) => fetch(...args)) {
	try {
		const {SUPABASE_KEY, SUPABASE_URL, getClient} = await import('../auth.js');
		const client = await getClient();
		const {data} = await client.auth.getSession();
		const token = data && data.session && data.session.access_token;

		if (!token) {
			return null;
		}

		const path = new URL(url).pathname.slice(1);
		const response = await fetchImpl(`${SUPABASE_URL}/functions/v1/tcgdex-image?path=${encodeURIComponent(path)}`, {
			credentials: 'omit',
			headers: {apikey: SUPABASE_KEY, authorization: `Bearer ${token}`},
			mode: 'cors',
			signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
		});
		const blob = response.ok ? await response.blob() : null;

		return blob && /^image\/(?:png|webp)$/.test(blob.type) ? blob : null;
	}
	catch {
		return null;
	}
}

// The WebP as a PNG, so the file opens in any video or photo editor (some
// do not take WebP). A cors read does not taint the canvas. When the browser
// cannot decode or encode it, the WebP itself is kept.
export async function toPng(blob) {
	try {
		const bitmap = await createImageBitmap(blob);
		const canvas = document.createElement('canvas');

		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		canvas.getContext('2d').drawImage(bitmap, 0, 0);
		bitmap.close();

		const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));

		return png || blob;
	}
	catch {
		return blob;
	}
}

// Saves `slide` as a download. Resolves with what happened, for the tests
// and the carousel: {outcome: 'saved', name} | {outcome: 'tab', url} |
// {outcome: 'blocked', url} | {outcome: 'offline'} | {outcome: 'missing'}.
// notify(message, options) is the app's toast (js/shell.js).
export async function saveSlideImage(slide, {
	download = downloadBlob,
	fetchImpl = (...args) => fetch(...args),
	info = {},
	notify = () => {},
	online = () => navigator.onLine !== false,
	open = openTab,
	relay = relayRead,
	resolveDetail = () => Promise.resolve(null),
	resolveSrc = () => Promise.resolve(null),
	slides = [],
} = {}) {
	if (!slide) {
		return {outcome: 'missing'};
	}

	const stem = slideFileStem(slide, {info, slides});

	if (isPhoto(slide)) {
		const url = await Promise.resolve(resolveDetail(slide)).catch(() => null) || await Promise.resolve(resolveSrc(slide)).catch(() => null);
		const blob = url ? await readImage(url, fetchImpl) : null;

		if (!blob) {
			notify(online() ? 'This photo is not on this phone yet. Try again in a moment.' : 'Saving this photo needs a connection.');

			return {outcome: online() ? 'missing' : 'offline'};
		}

		const name = `${stem}.${await extensionOf(blob)}`;

		download(blob, name);

		return {name, outcome: 'saved'};
	}

	const urls = officialUrls(slide.src);

	if (!urls) {
		return {outcome: 'missing'};
	}

	const reads = [
		() => readImage(urls.png, fetchImpl),
		() => relay(urls.png),
		async () => {
			const webp = await readImage(urls.webp, fetchImpl);

			return webp ? toPng(webp) : null;
		},
	];

	for (const read of reads) {
		const blob = await read();

		if (blob) {
			const name = `${stem}.${blob.type === 'image/webp' ? 'webp' : 'png'}`;

			download(blob, name);

			return {name, outcome: 'saved'};
		}
	}

	// navigator.onLine is only a hint: the reads above failing is what
	// counts, and it is asked only after they did.
	if (!online()) {
		notify('Saving the image needs a connection.');

		return {outcome: 'offline'};
	}

	if (open(urls.png)) {
		notify('Opened the image in a new tab. Save it from there.');

		return {outcome: 'tab', url: urls.png};
	}

	// The tab was blocked (the read took too long for the tap to still
	// count): the toast's button is a new tap.
	notify('The image could not be saved here.', {action: () => open(urls.png), actionLabel: 'Open image', timeout: 10000});

	return {outcome: 'blocked', url: urls.png};
}
