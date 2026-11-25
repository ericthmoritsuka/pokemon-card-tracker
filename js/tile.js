// One card tile for every grid: My Cards, set detail, binders, the wishlist,
// and a checklist's owned cards (plans/design-review.md section 4, Badge
// System). Each corner means one thing everywhere:
//
//   top-right     the quantity, ×2 and up, never ×1
//   bottom-left   the language flag, only when the copy's language is not
//                 the viewing language (js/flags.js), then the finish
//                 beside it, for anything but the plain print: REV, Poké
//                 Ball, Master Ball (M), 1st, HOLO. Both sit over the card's
//                 illustrator and copyright strip, clear of its printed
//                 name (design review 2, 2026-11-20: the flag covered it).
//   bottom-right  one status, first match wins: ? (not sure), waiting (not
//                 synced), wanted (on a wishlist), owned (catalog views only)
//
// Every badge pairs its color with a glyph or text and carries a name for
// screen readers, so nothing depends on color alone. Owned is a check in a
// yellow disc, never the danger red. Below 88 px of tile width only the
// right-hand corners show (style.css).

import {BASE, h} from './dom.js';
import {flagBadge} from './flags.js';
import {isStandardSize} from './prices.js';

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
// the language in the path differs. Null for any other image. The service
// worker uses the same rule (js/image-folders.js englishOf).
//
// Many Portuguese and French images send Access-Control-Allow-Origin twice,
// so the service worker keeps them as opaque responses, which Chrome counts
// at about 7 MiB each: about a hundred fit on a 10 GB phone, while it keeps
// thousands of English ones. For each image it keeps opaque it also keeps the English
// one. Offline, a Portuguese tile whose image is not on the phone shows the
// English art instead of the card back (E-20). Online, the English art also
// stands in for a Portuguese image that fails to load.
const LOCALIZED_IMAGE = /^(https:\/\/assets\.tcgdex\.net\/)(?:pt|fr)(\/)/;

export const englishImage = (src) => (LOCALIZED_IMAGE.test(String(src || '')) ? String(src).replace(LOCALIZED_IMAGE, '$1en$2') : null);

// What the art shows when src fails: the English image with the note that
// says so, or null when there is no stand-in (the card back follows).
export const ENGLISH_NOTE = 'English image';

export function artFallback(src) {
	const english = englishImage(src);

	return english ? {note: ENGLISH_NOTE, src: english} : null;
}

// Every stand-in to try in turn when src fails: the English image (as
// artFallback), then the large image in the same language, then the large
// English one. TCGdex sometimes has a card's large image only (sv10-028
// Arcanine, 2026-11-20: low.webp 404, high.webp 200), so a tile or pocket,
// which asks for the small one, stayed blank while the card page showed it.
const LOW_IMAGE = /\/low\.webp$/;

export function artFallbacks(src) {
	const english = artFallback(src);
	const list = english ? [english] : [];

	if (LOW_IMAGE.test(String(src || ''))) {
		list.push({note: null, src: String(src).replace(LOW_IMAGE, '/high.webp')});

		if (english) {
			list.push({note: ENGLISH_NOTE, src: english.src.replace(LOW_IMAGE, '/high.webp')});
		}
	}

	return list;
}

// Says that the art is a stand-in: a line under a tile's meta line, like a
// family member's "Photo by" line, or a caption on the art anywhere else
// (the card detail, the scan sheets). Never on a tile that shows or waits
// for a family member's photo (its "Photo by" line): a photo wins over the
// English stand-in, and js/photos/index.js fillPhoto takes the line away
// when a photo replaces the art.
function noteStandIn(frame, note) {
	const tile = frame.closest('.tile');

	if (!tile) {
		frame.append(h('span', {class: 'art-note'}, note));

		return;
	}

	if (tile.querySelector('.art-by') || tile.querySelector('.ph-by')) {
		return;
	}

	const line = h('span', {class: 'tile-meta art-by'}, note);
	const meta = tile.querySelector(':scope > .tile-meta');

	if (meta) {
		meta.after(line);
	}
	else {
		tile.append(line);
	}
}

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
		setName ? h('span', {class: 'card-back-set'}, setName) : null,
		h('span', {class: 'card-back-status'}, imageStatus(missing))
	);
}

// Card art in the 63:88 card shape. It shimmers while the image loads and
// turns into the card-back tile if the image fails, after trying the English
// image of a Portuguese or French card (artFallback), which is marked
// "English image" when it shows.
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
	const fallbacks = artFallbacks(src);
	let note = null;

	img.addEventListener('load', () => {
		frame.classList.remove('loading');

		if (note) {
			noteStandIn(frame, note);
		}
	}, {once: true});
	img.addEventListener('error', function failed() {
		forgetImage(shown);

		const next = fallbacks.shift();

		if (next) {
			shown = next.src;
			note = next.note;

			if (next.note) {
				frame.dataset.fallback = 'en';
			}
			else {
				delete frame.dataset.fallback;
			}

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

// The finishes that get a corner, by code. The plain print gets none. Holo
// got none either, by a design review decision (holo is the plain print of
// a holo rare), until Eric reversed it for holo only on 2026-11-24: a holo
// copy shows HOLO as a reverse one shows REV, because when he buys a card
// whose copy is holo and the one on offer is not, something is wrong.
export const FINISHES = {
	first: {label: '1st Edition', text: '1st'},
	holo: {label: 'Holo', text: 'HOLO'},
	masterball: {ball: 'masterball', label: 'Master Ball pattern', text: 'M'},
	pokeball: {ball: 'pokeball', label: 'Poké Ball pattern', text: ''},
	reverse: {label: 'Reverse holo', text: 'REV'},
};

// monprice's finish words (js/monprice.js FINISHES) to a code. Both holo
// words are the holo print (js/monprice.js resolveFinish reads them alike).
const MONPRICE_FINISHES = {FIRST_EDITION: 'first', HOLOFOIL: 'holo', REVERSE_HOLOFOIL: 'reverse', UNLIMITED_HOLOFOIL: 'holo'};

// A TCGdex variants_detailed entry to a finish code, or null for the plain
// print. One corner names one finish, so the order is the precedence: a
// ball pattern wins over the reverse it is printed on, the 1st Edition
// stamp over the reverse and the holo, and a reverse over a holo.
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

	const type = String(variant.type || '').toLowerCase();

	if (type === 'reverse') {
		return 'reverse';
	}

	return type === 'holo' ? 'holo' : null;
}

// The finish a tile shows for a card that is not owned, from its TCGdex
// record: HOLO when every printing of the card itself is holo, so that
// whoever is about to buy a copy can tell a holo print from a plain one.
// Null when the card has any other printing (normal, reverse, or a ball
// pattern), because the copy on offer could be that one, and null when the
// record lists no printings. A stamped printing (1st Edition, a prerelease
// or staff stamp) and a jumbo one are other products, so they do not count.
export function printFinish(record) {
	const list = record && Array.isArray(record.variants_detailed) ? record.variants_detailed : [];
	const prints = list.filter((variant) => variant && isStandardSize(variant) && !(variant.stamp || []).length);

	return prints.length && prints.every((variant) => variantFinish(variant) === 'holo') ? 'holo' : null;
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

	// The copy's own word decides when it has one: a finish picked in the
	// sheet (Eric, 2026-11-18) stands over the word its import key keeps, so
	// a 1st Edition import set to plain Holo loses its "1st" corner.
	if (entry.finish_raw) {
		return MONPRICE_FINISHES[entry.finish_raw] || null;
	}

	for (const word of String(entry.import_key || '').split('|')) {
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

// The finish corner as a badge node, or null for the plain print. tileArt
// puts it in a tile's corner; a copy picker whose art is not a tile (the
// tray strip, the card in hand) lays it over the art itself.
export function finishBadge(code) {
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
	const flagNode = flags.length ? flagBadge(flags, {className: 'badge badge-lang'}) : null;
	const finishNode = finishBadge(finish);

	// The flag and the finish share the bottom-left corner, in that order.
	if (flagNode || finishNode) {
		frame.append(h('span', {class: 'badge-corner'}, flagNode, finishNode));
	}

	if (count > 1) {
		frame.append(h('span', {'aria-label': `${count} copies`, class: 'badge badge-qty', role: 'img'}, `×${count}`));
	}

	if (favorite) {
		frame.append(h('span', {'aria-label': 'Favorite', class: 'badge badge-fav', role: 'img', title: 'Favorite'}, '★'));
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

// The tile's meta line ("#006 · ポケモンカード151"). A long Japanese or
// Korean set name would wrap it to three lines at 360 px, so style.css
// stops it at two with an ellipsis (Q-05). The whole text stays in the page
// for screen readers, and in the title for a long press or a hover.
function metaLine(meta) {
	const line = h('span', {class: 'tile-meta'}, meta);

	line.title = line.textContent;

	return line;
}

// A whole tile: the art, the name lines, the meta line, and the price
// (js/price-view.js tilePrice, or noPrice()) last when one is known, then a
// badge, such as For sale (js/cards-view.js), under the art and clear of
// its corners. route makes it a
// link into the app; tag 'button' makes a picker tile instead (onclick).
// names: the nodes catalog-views.js tileNames() makes, or a plain string.
export function cardTile({
	art,
	attrs = {},
	badge = null,
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
		meta === null || meta === '' ? null : metaLine(meta),
		price ? h('span', {class: 'tile-price'}, price) : null,
		badge ? h('span', {class: 'tile-badge tile-for-sale'}, badge) : null,
	];

	if (tag === 'button' || !route) {
		return h(tag || 'div', {...attrs, class: classes, onclick, type: tag === 'button' ? 'button' : null}, ...children);
	}

	return h('a', {...attrs, class: classes, 'data-link': route, href: BASE + route}, ...children);
}
