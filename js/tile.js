// One card tile for every grid: My Cards, set detail, binders, the wishlist,
// and a checklist's owned cards (plans/design-review.md section 4, Badge
// System). Each corner means one thing everywhere:
//
//   top-left      the language flag, only when the copy's language is not
//                 the viewing language (js/flags.js)
//   top-right     the quantity, ×2 and up, never ×1
//   bottom-left   the finish, for anything but the plain print: REV, Poké
//                 Ball, Master Ball (M), 1st
//   bottom-right  one status, first match wins: ? (not sure), waiting (not
//                 synced), wanted (on a wishlist), owned (catalog views only)
//
// Every badge pairs its color with a glyph or text and carries a name for
// screen readers, so nothing depends on color alone. Owned is a check in a
// yellow disc, never the danger red. Below 88 px of tile width only the
// right-hand corners show (style.css).

import {BASE, h} from './dom.js';
import {flagBadge} from './flags.js';

// ------------------------------------------------------------ card art

// The service worker may hold an opaque copy of an image, whose status it
// cannot read, so a failed image is dropped from the caches here, where the
// failure is known. The next view fetches it again.
const IMAGE_CACHES = ['card-tracker-images', 'card-tracker-images-opaque'];

export function forgetImage(url) {
	if (!('caches' in window)) {
		return;
	}

	for (const name of IMAGE_CACHES) {
		caches.open(name).then((cache) => cache.delete(url)).catch(() => {});
	}
}

// The English image of the same card, for a Portuguese or French one:
// international prints share one card ID in every Western language, so only
// the language in the path differs. Null for any other image.
//
// Most Portuguese and French images send Access-Control-Allow-Origin twice,
// so the service worker can keep only a few of them (opaque, capped at 100),
// while it keeps thousands of English ones. Offline, a Portuguese tile whose
// image is not on the phone shows the English art instead of the card back
// (E-20). Online, the English art also stands in for a Portuguese image that
// fails to load.
const LOCALIZED_IMAGE = /^(https:\/\/assets\.tcgdex\.net\/)(?:pt|fr)(\/)/;

export const englishImage = (src) => (LOCALIZED_IMAGE.test(String(src || '')) ? String(src).replace(LOCALIZED_IMAGE, '$1en$2') : null);

function imageStatus(missing) {
	if (!navigator.onLine) {
		return 'Image not on this phone';
	}

	return missing ? 'No image in the catalog' : 'Image not available right now';
}

// A card-back style tile, so a missing image still says which card it is.
function cardBack({name, number, setName}, missing) {
	return h('div', {class: 'card-back'},
		h('span', {class: 'card-back-name'}, name),
		number ? h('span', null, `#${number}`) : null,
		setName ? h('span', null, setName) : null,
		h('span', {class: 'card-back-status'}, imageStatus(missing))
	);
}

// Card art in the 63:88 card shape. It shimmers while the image loads and
// turns into the card-back tile if the image fails, after trying the English
// image of a Portuguese or French card (englishImage).
//
// decorative: the name is already in text beside the art (a tile), so the
// image has an empty alt and a screen reader does not say the name twice.
export function cardArt(info, src, {decorative = false, eager = false} = {}) {
	const frame = h('div', {class: 'art loading'});

	if (!src) {
		frame.classList.remove('loading');
		frame.append(cardBack(info, true));

		return frame;
	}

	// No crossorigin attribute: many assets.tcgdex.net images send
	// Access-Control-Allow-Origin twice, which fails a CORS request outright.
	// The service worker still tries CORS first (see sw.js).
	const img = h('img', {
		alt: decorative ? '' : info.name,
		decoding: 'async',
		height: 88,
		loading: eager ? 'eager' : 'lazy',
		width: 63,
	});

	let shown = src;
	let fallback = englishImage(src);

	img.addEventListener('load', () => frame.classList.remove('loading'), {once: true});
	img.addEventListener('error', function failed() {
		forgetImage(shown);

		if (fallback) {
			shown = fallback;
			fallback = null;
			frame.dataset.fallback = 'en';
			img.addEventListener('error', failed, {once: true});
			img.src = shown;

			return;
		}

		frame.classList.remove('loading');
		frame.replaceChildren(cardBack(info, false));
	}, {once: true});
	img.src = src;
	frame.append(img);

	return frame;
}

// ------------------------------------------------------------- finishes

// The finishes that get a corner, by code. The plain print, and holo (the
// plain print of a holo rare), get none.
export const FINISHES = {
	first: {label: '1st Edition', text: '1st'},
	masterball: {ball: 'masterball', label: 'Master Ball pattern', text: 'M'},
	pokeball: {ball: 'pokeball', label: 'Poké Ball pattern', text: ''},
	reverse: {label: 'Reverse holo', text: 'REV'},
};

// monprice's finish words (js/monprice.js FINISHES) to a code.
const MONPRICE_FINISHES = {FIRST_EDITION: 'first', REVERSE_HOLOFOIL: 'reverse'};

// A TCGdex variants_detailed entry to a finish code, or null for the plain
// print. Ball patterns win over the reverse they are printed on.
export function variantFinish(variant) {
	if (!variant) {
		return null;
	}

	if (variant.foil === 'masterball' || variant.foil === 'pokeball') {
		return variant.foil;
	}

	if ((variant.stamp || []).includes('1st-edition')) {
		return 'first';
	}

	return String(variant.type || '').toLowerCase() === 'reverse' ? 'reverse' : null;
}

// One copy's finish code. The variant ID alone is opaque (a TCGdex ID), so
// a copy is read through its variant when the caller has it, then through
// the finish monprice gave it (finish_raw, or the word in its import key).
export function entryFinish(entry, variants = null) {
	if (!entry) {
		return null;
	}

	if (variants && entry.variant_id) {
		const variant = variants.find((item) => item.variantId === entry.variant_id);

		if (variant) {
			return variantFinish(variant);
		}
	}

	if (entry.finish && FINISHES[entry.finish]) {
		return entry.finish;
	}

	const words = [entry.finish_raw, ...String(entry.import_key || '').split('|')];

	for (const word of words) {
		if (word && MONPRICE_FINISHES[word]) {
			return MONPRICE_FINISHES[word];
		}
	}

	return null;
}

// The finish a tile of several copies shows: theirs when every copy shares
// it, else none, since one corner cannot name two finishes.
export function groupFinish(entries, variants = null) {
	const codes = new Set((entries || []).map((entry) => entryFinish(entry, variants)));

	return codes.size === 1 ? [...codes][0] : null;
}

// --------------------------------------------------------------- badges

const SVG = 'http://www.w3.org/2000/svg';

function glyph(path, viewBox = '0 0 16 16') {
	const svg = document.createElementNS(SVG, 'svg');
	const shape = document.createElementNS(SVG, 'path');

	svg.setAttribute('viewBox', viewBox);
	svg.setAttribute('aria-hidden', 'true');
	svg.setAttribute('focusable', 'false');
	shape.setAttribute('d', path);
	svg.append(shape);

	return svg;
}

const CHECK = 'M6.4 11.6 2.8 8l1.3-1.3 2.3 2.3 5.5-5.5L13.2 4.8z';
const HEART = 'M8 14 2.6 8.6A3.2 3.2 0 0 1 8 4.1a3.2 3.2 0 0 1 5.4 4.5z';
const CLOUD = 'M4.5 12.5a3 3 0 0 1-.4-6 4 4 0 0 1 7.7-1 3.5 3.5 0 0 1 .2 7z';

export const STATUSES = {
	owned: {className: 'badge-owned', label: 'Owned', make: () => glyph(CHECK)},
	unsure: {className: 'badge-unsure', label: 'Not sure, check it', make: () => '?'},
	waiting: {className: 'badge-waiting', label: 'Waiting to sync', make: () => glyph(CLOUD)},
	wanted: {className: 'badge-wanted', label: 'On a wishlist', make: () => glyph(HEART)},
};

function finishBadge(code) {
	const finish = FINISHES[code];

	if (!finish) {
		return null;
	}

	const badge = h('span', {'aria-label': finish.label, class: `badge badge-finish badge-finish-${code}`, role: 'img', title: finish.label});

	if (finish.ball) {
		badge.append(h('span', {'aria-hidden': 'true', class: `ball ball-${finish.ball}`}, finish.text || null));
	}
	else {
		badge.append(finish.text);
	}

	return badge;
}

function statusBadge(code, label) {
	const status = STATUSES[code];

	if (!status) {
		return null;
	}

	const text = label || status.label;

	return h('span', {'aria-label': text, class: `badge badge-status ${status.className}`, role: 'img', title: text}, status.make());
}

// The art with its four corners. languages: the copies' languages; the ones
// equal to viewing are left out, so a PT copy viewed in PT shows no flag.
// viewing null shows every language (a picker choosing one physical copy).
export function tileArt({
	count = 0,
	decorative = false,
	eager = false,
	favorite = false,
	finish = null,
	info,
	languages = [],
	src = null,
	status = null,
	statusLabel = null,
	viewing = null,
}) {
	const frame = h('div', {class: 'art-wrap'}, cardArt(info, src, {decorative, eager}));
	const flags = [...new Set(languages.filter((code) => code && code !== viewing))];

	if (flags.length) {
		frame.append(flagBadge(flags, {className: 'badge badge-lang'}));
	}

	if (count > 1) {
		frame.append(h('span', {'aria-label': `${count} copies`, class: 'badge badge-qty', role: 'img'}, `×${count}`));
	}

	if (favorite) {
		frame.append(h('span', {'aria-label': 'Favorite', class: 'badge badge-fav', role: 'img', title: 'Favorite'}, '★'));
	}

	const finishNode = finishBadge(finish);

	if (finishNode) {
		frame.append(finishNode);
	}

	const statusNode = statusBadge(status, statusLabel);

	if (statusNode) {
		frame.append(statusNode);
	}

	return frame;
}

// The quiet line a tile shows instead of a price when its card has no
// market price at all: Japanese, Korean, and Chinese prints, and cards
// TCGdex has no price for. A card whose price is still downloading shows
// nothing rather than this.
export const noPrice = () => h('span', {class: 'price-tile price-none'}, 'No price');

// A whole tile: the art, the name lines, the meta line, and the price
// (js/price-view.js tilePrice, or noPrice()) last when one is known. route makes it a
// link into the app; tag 'button' makes a picker tile instead (onclick).
// names: the nodes catalog-views.js tileNames() makes, or a plain string.
export function cardTile({
	art,
	attrs = {},
	className = '',
	meta = null,
	names = [],
	onclick = null,
	price = null,
	route = null,
	tag = null,
}) {
	const classes = ['tile', className].filter(Boolean).join(' ');
	const nameNodes = typeof names === 'string' ? [h('span', {class: 'tile-name'}, names)] : names;
	const children = [
		tileArt({decorative: true, ...art}),
		...nameNodes,
		meta === null || meta === '' ? null : h('span', {class: 'tile-meta'}, meta),
		price ? h('span', {class: 'tile-price'}, price) : null,
	];

	if (tag === 'button' || !route) {
		return h(tag || 'div', {...attrs, class: classes, onclick, type: tag === 'button' ? 'button' : null}, ...children);
	}

	return h('a', {...attrs, class: classes, 'data-link': route, href: BASE + route}, ...children);
}
