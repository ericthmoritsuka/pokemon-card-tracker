// A binder open on the table (DESIGN.md section 11, "Spreads with a page
// turn", "No rings, ever", "Cover image"): two facing pages on a zipped,
// ringless cover, turned with a 3D flip around a stitched spine.
//
// Spreads count from 1, like pages and positions in js/binders.js:
//   spread 1   the inside cover on the left, page 1 alone on the right
//   spread k   pages 2k - 2 and 2k - 1 (2 and 3, 4 and 5, ...)
//   the last   page N alone on the left, with the inside back cover on the
//              right, when N is even (the pages after page 1 are then odd
//              in number); when N is odd, the last spread is a full pair
// A page is one side of a sheet, so turning a page flips a sheet: the right
// page lifts and lands on the left, and its back is the next left page.
//
// The URL keeps the place: ?spread=<k> for a spread, and ?spread=<k>&page=<p>
// while one page is zoomed (a phone held upright). Turning a page replaces
// the history entry; zooming adds one, so Back returns to the spread.
//
// binderSpread() is the component. js/binders-view.js keeps the pockets: it
// passes renderPocket(page, position), which returns the pocket element with
// its own tap handler (the picker sheet), or onPocket(page, position) to have
// the component call it for a tap on a pocket. The area is
// [data-swipe-own], so js/card-swipe.js leaves its swipes alone.
//
// The math at the top is pure, so Node tests it (tests/binder-spread.test.mjs);
// nothing here touches the DOM until binderSpread() runs.

import {coverImageOf, coverTextColor, DEFAULT_COVER, pageOfPocket} from './binders.js';

export const TURN_MS = 450;
export const FADE_MS = 220;
export const SPREAD_PARAM = 'spread';
export const ZOOM_PARAM = 'page';
export const HINT_KEY = 'card-tracker-sideways-hint';
export const HINT_TIMES = 3;

// A phone held upright: the spread is an overview there, and a tapped page
// opens at full size for placing cards.
export const OVERVIEW_QUERY = '(orientation: portrait) and (max-width: 599px)';

// Back from a zoomed page lands on the spread's own history entry, whose URL
// still names the spread the zoom started from; after stepping through the
// pages that is the wrong one. Zooming marks that entry (history.state
// bsReturn) and the zoomed entry with one key, stepping records here the
// spread holding the page shown, and the spread drawn on Back (by the app's
// router, or by onPop) opens there. Kept for the page load only.
const returns = new Map();
let returnKeys = 0;

// ---------------------------------------------------------- spread math

const whole = (value, fallback) => {
	const n = Number.parseInt(value, 10);

	return Number.isInteger(n) ? n : fallback;
};

export const spreadCount = (pageCount) => 1 + Math.ceil(Math.max(0, whole(pageCount, 1) - 1) / 2);

export const clampSpread = (pageCount, spread) => Math.min(Math.max(1, whole(spread, 1)), spreadCount(pageCount));

// The pages a spread shows: {left, right}, null for an inside cover.
export function spreadPages(pageCount, spread) {
	const count = Math.max(1, whole(pageCount, 1));
	const k = clampSpread(count, spread);

	if (k === 1) {
		return {left: null, right: 1};
	}

	const right = (2 * k) - 1;

	return {left: (2 * k) - 2, right: right <= count ? right : null};
}

export const spreadOfPage = (page) => (whole(page, 1) <= 1 ? 1 : Math.floor(whole(page, 1) / 2) + 1);

// The spread a pocket number across the whole binder falls on.
export const spreadOfPocket = (binder, pocket) => spreadOfPage(pageOfPocket(binder, pocket).page);

// Odd pages are fronts, on the right; even pages backs, on the left.
export const sideOfPage = (page) => (whole(page, 1) % 2 === 1 ? 'right' : 'left');

export function spreadLabel(pageCount, spread) {
	const {left, right} = spreadPages(pageCount, spread);
	const of = ` of ${pageCount}`;

	if (left && right) {
		return `Pages ${left} and ${right}${of}`;
	}

	return `Page ${left || right}${of}`;
}

// Where the URL says to be: {spread, zoom}. ?page= (a zoomed page) wins,
// then ?spread=, then the route's own page (binders/<id>/<page>, the links
// card detail makes), then the first spread.
export function readSpreadState(search, pageCount, routePage = null) {
	const params = new URLSearchParams(search || '');
	const count = Math.max(1, whole(pageCount, 1));
	const zoom = params.has(ZOOM_PARAM) ? whole(params.get(ZOOM_PARAM), NaN) : NaN;

	if (Number.isInteger(zoom) && zoom >= 1 && zoom <= count) {
		return {spread: spreadOfPage(zoom), zoom};
	}

	if (params.has(SPREAD_PARAM)) {
		return {spread: clampSpread(count, params.get(SPREAD_PARAM)), zoom: null};
	}

	const page = whole(routePage, NaN);

	return {spread: Number.isInteger(page) ? spreadOfPage(Math.min(Math.max(1, page), count)) : 1, zoom: null};
}

// The search string for a state, keeping any other parameters. Spread 1
// with no zoomed page is the bare route.
export function writeSpreadState(search, {spread, zoom = null}) {
	const params = new URLSearchParams(search || '');

	params.delete(SPREAD_PARAM);
	params.delete(ZOOM_PARAM);

	if (spread > 1 || zoom) {
		params.set(SPREAD_PARAM, String(spread));
	}

	if (zoom) {
		params.set(ZOOM_PARAM, String(zoom));
	}

	const text = params.toString();

	return text ? `?${text}` : '';
}

// A page's shape, width over height, in card units: pockets of 63 x 88 mm
// with 5 mm between and around them, and a strip at the foot for the page
// number. The cover is the page with a 6 mm margin of board around it.
const POCKET_W = 63;
const POCKET_H = 88;
const GAP = 5;
const FOLIO = 12;
const MARGIN = 6;

const pageW = (cols) => (cols * POCKET_W) + ((cols + 1) * GAP);
const pageH = (rows) => (rows * POCKET_H) + ((rows + 1) * GAP) + FOLIO;

export const pageAspect = (rows, cols) => pageW(cols) / pageH(rows);

export const coverAspect = (rows, cols) => (pageW(cols) + (2 * MARGIN)) / (pageH(rows) + (2 * MARGIN));

// Where Back from a zoomed page lands: the URL's place, unless this is the
// spread entry a zoom left from and the zoomed page moved on. Used once.
function landing(place, pageCount) {
	const key = history.state && !history.state.bsZoom ? history.state.bsReturn : null;

	if (place.zoom || !key || !returns.has(key)) {
		return place;
	}

	const spread = returns.get(key);

	returns.delete(key);

	return {spread: clampSpread(pageCount, spread), zoom: null};
}

// ---------------------------------------------------------- the hint

function readHint() {
	try {
		const saved = JSON.parse(localStorage.getItem(HINT_KEY) || 'null');

		return saved && typeof saved === 'object' ? {done: Boolean(saved.done), shown: whole(saved.shown, 0)} : {done: false, shown: 0};
	}
	catch {
		return {done: false, shown: 0};
	}
}

// A showing is counted once per page load, so the binder screen redrawing
// (Back from a zoomed page) does not use up the few times.
let hintCounted = false;

function writeHint(value) {
	try {
		localStorage.setItem(HINT_KEY, JSON.stringify(value));
	}
	catch {
		// Private browsing: the hint may show again next time.
	}
}

// ---------------------------------------------------------- the DOM

function el(tag, attrs, ...children) {
	const node = document.createElement(tag);

	for (const [key, value] of Object.entries(attrs || {})) {
		if (value === null || value === undefined || value === false) {
			continue;
		}

		if (key === 'class') {
			node.className = value;
		}
		else if (key.startsWith('on') && typeof value === 'function') {
			node.addEventListener(key.slice(2), value);
		}
		else {
			node.setAttribute(key, value === true ? '' : String(value));
		}
	}

	for (const child of children.flat()) {
		if (child !== null && child !== undefined && child !== false) {
			node.append(child instanceof Node ? child : String(child));
		}
	}

	return node;
}

const SVG = 'http://www.w3.org/2000/svg';

function svg(tag, attrs) {
	const node = document.createElementNS(SVG, tag);

	for (const [key, value] of Object.entries(attrs)) {
		node.setAttribute(key, String(value));
	}

	return node;
}

// The zip around the cover's edge: a tape, a row of teeth, and the slider
// with its pull tab at the top corner, all straight-sided. Drawn in a
// 0..1000 box stretched over the cover, with non-scaling strokes so the
// teeth keep their size at any width.
function zipper() {
	const box = svg('svg', {'aria-hidden': 'true', class: 'bs-zipper', focusable: 'false', preserveAspectRatio: 'none', viewBox: '0 0 1000 1000'});
	const edge = 'M 12 30 Q 12 12 30 12 L 970 12 Q 988 12 988 30 L 988 970 Q 988 988 970 988 L 30 988 Q 12 988 12 970 Z';

	box.append(
		svg('path', {class: 'bs-zip-tape', d: edge, fill: 'none', 'vector-effect': 'non-scaling-stroke'}),
		svg('path', {class: 'bs-zip-teeth', d: edge, fill: 'none', 'vector-effect': 'non-scaling-stroke'})
	);

	return box;
}

// The slider and pull, drawn apart from the stretched zip so they keep
// their shape: a tapered body and a flat tab with a slot.
function zipPull() {
	const box = svg('svg', {'aria-hidden': 'true', class: 'bs-zip-pull', focusable: 'false', viewBox: '0 0 24 40'});

	box.append(
		svg('path', {class: 'bs-zip-slider', d: 'M 4 2 L 20 2 L 18 14 L 6 14 Z'}),
		svg('path', {class: 'bs-zip-tab', d: 'M 8 13 L 16 13 L 17 37 Q 17 39 15 39 L 9 39 Q 7 39 7 37 Z'}),
		svg('rect', {class: 'bs-zip-slot', height: 9, rx: 1.5, width: 4, x: 10, y: 26})
	);

	return box;
}

// The spine: bonded sheet edges between two rows of stitches.
function spine() {
	return el('div', {'aria-hidden': 'true', class: 'bs-spine'},
		el('span', {class: 'bs-stitch bs-stitch-left'}),
		el('span', {class: 'bs-stitch bs-stitch-right'}));
}

const reducedMotion = () => Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

const finished = (animation) => (animation && animation.finished ? animation.finished.catch(() => {}) : Promise.resolve());

// ---------------------------------------------------------- the component

// binder        the binder entry (js/binders.js); update() takes a newer one
// page          the route's page (binders/<id>/<page>), when it has one
// path          the app route the URL keeps, such as "binders/<id>"; the
//               current path when left out. Only its search part changes.
// base          the app's base path (js/dom.js BASE), prefixed to path
// readOnly      a family member's binder: words change, nothing else
// renderPocket  (page, position) => Element, the pocket as the caller draws
//               it (js/binders-view.js pocket tiles)
// onPocket      (page, position) => void, called for a tap on a pocket in an
//               editable view; leave it out when renderPocket's element
//               handles its own taps
// onChange      ({spread, zoom, pages}) => void after the place changes
//
// Returns {element, update, state, pages, turn, goTo, zoom, unzoom, destroy}.
export function binderSpread({
	base = '',
	binder: start,
	onChange = null,
	onPocket = null,
	page: routePage = null,
	path = null,
	readOnly = false,
	renderPocket,
}) {
	let binder = start;
	let state = landing(readSpreadState(window.location.search, binder.page_count, routePage), binder.page_count);
	let busy = false;
	let pending = 0;
	let alive = true;
	let suppressUntil = 0;
	let hintShown = false;
	let dirty = false;

	const overviewQuery = window.matchMedia ? window.matchMedia(OVERVIEW_QUERY) : null;
	const overview = () => Boolean(overviewQuery && overviewQuery.matches);

	// ------------------------------------------------------- the parts

	const label = el('span', {'aria-live': 'polite', class: 'bs-label', id: 'bs-label'});
	const jump = el('select', {'aria-label': 'Go to pages', class: 'bs-jump', id: 'bs-jump'});
	const prevEdge = el('button', {'aria-label': 'Turn back a page', class: 'bs-edge bs-edge-prev', id: 'bs-prev', type: 'button'}, el('span', {'aria-hidden': 'true'}, '‹'));
	const nextEdge = el('button', {'aria-label': 'Turn the page', class: 'bs-edge bs-edge-next', id: 'bs-next', type: 'button'}, el('span', {'aria-hidden': 'true'}, '›'));
	const leftSide = el('div', {class: 'bs-side bs-side-left', 'data-side': 'left'});
	const rightSide = el('div', {class: 'bs-side bs-side-right', 'data-side': 'right'});
	const book = el('div', {class: 'bs-book', id: 'bs-book'}, zipper(), zipPull(), spine(), leftSide, rightSide);
	const stage = el('div', {'aria-label': 'Binder pages', class: 'bs-stage', id: 'bs-stage', role: 'group'}, book, prevEdge, nextEdge);
	const spreadBar = el('div', {class: 'bs-bar'}, el('span', {class: 'bs-jump-wrap select-wrap'}, jump));

	const zoomBack = el('button', {class: 'bs-zoom-back', id: 'bs-zoom-back', type: 'button'}, '‹ Both pages');
	const zoomLabel = el('span', {'aria-live': 'polite', class: 'bs-label', id: 'bs-zoom-label'});
	const zoomPrev = el('button', {'aria-label': 'Previous page', class: 'small bs-zoom-step', id: 'bs-zoom-prev', type: 'button'}, '‹');
	const zoomNext = el('button', {'aria-label': 'Next page', class: 'small bs-zoom-step', id: 'bs-zoom-next', type: 'button'}, '›');
	const zoomSheet = el('div', {class: 'bs-zoom-sheet', id: 'bs-zoom-sheet'});
	const zoomFrame = el('div', {class: 'bs-zoom-frame'}, zoomSheet);
	const zoomView = el('div', {class: 'bs-zoom', hidden: true, id: 'bs-zoom'},
		el('div', {class: 'bs-zoom-bar'}, zoomBack, el('span', {class: 'bs-zoom-steps'}, zoomPrev, zoomNext)),
		zoomLabel,
		zoomFrame);

	const hint = el('div', {class: 'bs-hint', hidden: true, id: 'bs-hint', role: 'note'},
		el('span', {'aria-hidden': 'true', class: 'bs-hint-icon'}),
		el('span', {class: 'bs-hint-text'}, 'Turn your phone sideways to see both pages'),
		el('button', {'aria-label': 'Dismiss the hint', class: 'small bs-hint-close', id: 'bs-hint-close', type: 'button'}, 'Got it'));

	const spreadView = el('div', {class: 'bs-spread', id: 'bs-spread'}, label, stage, spreadBar);
	const element = el('section', {
		'aria-label': 'Binder',
		class: 'bs',
		'data-swipe-own': true,
		id: 'binder-spread',
	}, hint, spreadView, zoomView);

	// ------------------------------------------------------- pages

	function pocketsFor(page, interactive) {
		const grid = el('div', {class: 'bs-grid'});

		for (let position = 1; position <= binder.rows * binder.cols; position++) {
			const node = renderPocket(page, position);

			grid.append(el('div', {class: 'bs-pocket', 'data-page': page, 'data-position': position}, node, el('span', {'aria-hidden': 'true', class: 'bs-slit'})));
		}

		grid.inert = !interactive;

		return grid;
	}

	// One page, or an inside cover for null. inSpread pages get the Open
	// button in overview; a zoomed page and every page in direct mode are
	// live.
	function sheet(page, side, {live = true, open = false} = {}) {
		if (!page) {
			return el('div', {class: 'bs-page bs-inside', 'data-side': side},
				el('div', {class: 'bs-inside-label'},
					el('span', {class: 'bs-inside-name'}, binder.name || ''),
					binder.notes ? el('span', {class: 'bs-inside-notes'}, binder.notes) : null));
		}

		const node = el('div', {class: 'bs-page', 'data-page': page, 'data-side': side},
			pocketsFor(page, live),
			el('span', {'aria-hidden': 'true', class: 'bs-folio'}, String(page)),
			el('span', {'aria-hidden': 'true', class: 'bs-gutter'}));

		if (open) {
			node.append(el('button', {
				'aria-label': readOnly ? `Open page ${page}` : `Open page ${page} to place cards`,
				class: 'bs-open',
				'data-open': page,
				onclick: () => zoomTo(page),
				type: 'button',
			}));
		}

		return node;
	}

	const spreadSheet = (page, side) => sheet(page, side, {live: !overview(), open: overview() && Boolean(page)});

	function fillSides() {
		const {left, right} = spreadPages(binder.page_count, state.spread);

		leftSide.replaceChildren(spreadSheet(left, 'left'));
		rightSide.replaceChildren(spreadSheet(right, 'right'));
	}

	// ------------------------------------------------------- drawing

	function stackDepth() {
		const count = spreadCount(binder.page_count);
		const done = count > 1 ? (state.spread - 1) / (count - 1) : 0;

		book.style.setProperty('--bs-left-stack', done.toFixed(3));
		book.style.setProperty('--bs-right-stack', (1 - done).toFixed(3));
	}

	function drawControls() {
		const count = spreadCount(binder.page_count);

		label.textContent = spreadLabel(binder.page_count, state.spread);
		prevEdge.disabled = state.spread <= 1;
		nextEdge.disabled = state.spread >= count;
		jump.value = String(state.spread);
		zoomLabel.textContent = state.zoom ? `Page ${state.zoom} of ${binder.page_count}` : '';
		zoomPrev.disabled = !state.zoom || state.zoom <= 1;
		zoomNext.disabled = !state.zoom || state.zoom >= binder.page_count;
		element.dataset.spread = String(state.spread);
		element.dataset.zoom = state.zoom ? String(state.zoom) : '';
		stackDepth();
	}

	function drawShape() {
		const color = binder.cover_color || DEFAULT_COVER;

		element.style.setProperty('--cover', color);
		element.style.setProperty('--cover-text', coverTextColor(color));
		element.style.setProperty('--bs-cols', binder.cols);
		element.style.setProperty('--bs-rows', binder.rows);
		element.style.setProperty('--bs-page-aspect', pageAspect(binder.rows, binder.cols).toFixed(4));

		// The pockets' inset and gaps, as shares of the page, so a page of any
		// size keeps the shape pageAspect() gives it.
		const w = pageW(binder.cols);
		const tall = pageH(binder.rows);
		const pct = (n) => `${(n * 100).toFixed(3)}%`;

		element.style.setProperty('--bs-pad-x', pct(GAP / w));
		element.style.setProperty('--bs-pad-y', pct(GAP / tall));
		element.style.setProperty('--bs-foot', pct((GAP + FOLIO) / tall));
		element.style.setProperty('--bs-gap-c', pct(GAP / (w - (2 * GAP))));
		element.style.setProperty('--bs-gap-r', pct(GAP / (tall - (2 * GAP) - FOLIO)));
		element.style.setProperty('--bs-spread-aspect', ((2 * pageAspect(binder.rows, binder.cols)) + 0.06).toFixed(4));
		jump.replaceChildren(...Array.from({length: spreadCount(binder.page_count)}, (_, i) => {
			const {left, right} = spreadPages(binder.page_count, i + 1);

			return el('option', {value: i + 1}, left && right ? `Pages ${left} and ${right}` : `Page ${left || right}`);
		}));
	}

	let coverKey = null;

	function drawCover() {
		const image = coverImageOf(binder);
		const key = `${binder.cover_color}|${image ? image.id : ''}`;

		if (key === coverKey) {
			return;
		}

		coverKey = key;

		if (!image) {
			element.style.removeProperty('--cover-image');
			delete element.dataset.coverImage;

			return;
		}

		// The cover module reads the image from the phone or the bucket.
		import('./binder-cover.js')
			.then((cover) => cover.coverImageUrl(binder))
			.then((url) => {
				if (alive && url && coverKey === key) {
					element.style.setProperty('--cover-image', `url("${url}")`);
					element.dataset.coverImage = 'true';
				}
			})
			.catch(() => {
				// The cover color shows instead.
			});
	}

	function drawZoom() {
		const side = sideOfPage(state.zoom);

		zoomSheet.replaceChildren(sheet(state.zoom, side, {live: true}));
		zoomSheet.dataset.side = side;
	}

	function draw() {
		element.dataset.mode = overview() ? 'overview' : 'direct';
		element.dataset.view = state.zoom ? 'page' : 'spread';
		spreadView.hidden = Boolean(state.zoom);
		zoomView.hidden = !state.zoom;

		if (state.zoom) {
			drawZoom();
		}
		else {
			fillSides();
		}

		drawControls();
		drawHint();
		placeEdges();
	}

	// The edge arrows go outside the book when there is room beside it.
	function placeEdges() {
		const room = (spreadView.clientWidth - stage.offsetWidth) / 2;

		element.dataset.edges = room >= 48 ? 'outside' : 'inside';
	}

	const resizes = typeof ResizeObserver === 'function' ? new ResizeObserver(() => alive && placeEdges()) : null;

	function changed() {
		drawControls();

		if (onChange) {
			onChange({pages: visiblePages(), spread: state.spread, zoom: state.zoom});
		}
	}

	// ------------------------------------------------------- the URL

	function urlFor(next) {
		const pathname = path === null ? window.location.pathname : `${base}${path}`;

		return `${pathname}${writeSpreadState(window.location.search, next)}${window.location.hash}`;
	}

	const replaceUrl = (at = state) => history.replaceState(history.state, '', urlFor(at));

	// Zooming adds a history entry, like opening a screen: the spread's entry
	// keeps its scroll position and the return key for Back.
	function pushZoomUrl() {
		const key = `bs-${++returnKeys}`;

		returns.set(key, state.spread);
		history.replaceState({...(history.state || {}), bsReturn: key, scrollY: window.scrollY}, '');
		history.pushState({bsReturn: key, bsZoom: true, inApp: true}, '', urlFor(state));
	}

	// The zoomed page moved: Back should land on the spread holding it.
	function noteReturn() {
		if (history.state && history.state.bsZoom && history.state.bsReturn) {
			returns.set(history.state.bsReturn, state.spread);
		}
	}

	// ------------------------------------------------------- the hint

	function drawHint() {
		const saved = readHint();
		const show = overview() && !state.zoom && !saved.done && (hintShown || hintCounted || saved.shown < HINT_TIMES);

		if (show && !hintShown) {
			hintShown = true;

			if (!hintCounted) {
				hintCounted = true;
				writeHint({done: false, shown: saved.shown + 1});
			}
		}

		hint.hidden = !show;
	}

	hint.querySelector('#bs-hint-close').addEventListener('click', () => {
		writeHint({...readHint(), done: true});
		hint.hidden = true;
	});

	// ------------------------------------------------------- turning

	function visiblePages() {
		if (state.zoom) {
			return [state.zoom];
		}

		const {left, right} = spreadPages(binder.page_count, state.spread);

		return [left, right].filter(Boolean);
	}

	function shade(className) {
		return el('span', {'aria-hidden': 'true', class: `bs-shade ${className}`});
	}

	// The 3D flip: the sheet on the turning side lifts around the spine and
	// lands on the other side, showing its back, while a shadow sweeps over
	// the page it uncovers and the page it lands on. Transform and opacity
	// only, so the compositor runs it.
	async function flip(dir, to) {
		const {left, right} = spreadPages(binder.page_count, to);
		const forward = dir > 0;
		const from = forward ? rightSide : leftSide;
		const onto = forward ? leftSide : rightSide;
		const leaving = from.firstElementChild;
		const under = spreadSheet(forward ? right : left, forward ? 'right' : 'left');
		const back = spreadSheet(forward ? left : right, forward ? 'left' : 'right');
		const box = {height: from.offsetHeight, left: from.offsetLeft, top: from.offsetTop, width: from.offsetWidth};
		const frontShade = shade('bs-shade-front');
		const backShade = shade('bs-shade-back');
		const sweep = shade(forward ? 'bs-sweep bs-sweep-forward' : 'bs-sweep bs-sweep-back');
		const cast = shade(forward ? 'bs-cast bs-cast-forward' : 'bs-cast bs-cast-back');
		const front = el('div', {class: 'bs-face bs-face-front'}, leaving, frontShade);
		const reverse = el('div', {class: 'bs-face bs-face-back'}, back, backShade);
		const leaf = el('div', {'aria-hidden': 'true', class: `bs-leaf ${forward ? 'bs-leaf-forward' : 'bs-leaf-back'}`, inert: true}, front, reverse);

		Object.assign(leaf.style, {height: `${box.height}px`, left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`});
		from.replaceChildren(under, el('span', {'aria-hidden': 'true', class: 'bs-fx'}, sweep));
		onto.append(el('span', {'aria-hidden': 'true', class: 'bs-fx'}, cast));
		book.append(leaf);
		element.dataset.turning = forward ? 'forward' : 'back';

		// One frame for the new pages to lay out before anything moves.
		await nextFrame();

		const angle = forward ? -180 : 180;
		const timing = {duration: TURN_MS, easing: 'cubic-bezier(0.45, 0.05, 0.35, 1)', fill: 'forwards'};
		const animations = [
			leaf.animate([
				{transform: 'translateZ(0) rotateY(0deg)'},
				{offset: 0.5, transform: `translateZ(36px) rotateY(${angle / 2}deg)`},
				{transform: `translateZ(0) rotateY(${angle}deg)`},
			], timing),
			frontShade.animate([{opacity: 0}, {offset: 0.5, opacity: 0.45}, {opacity: 0.45}], timing),
			backShade.animate([{opacity: 0.45}, {offset: 0.5, opacity: 0.45}, {opacity: 0}], timing),
			sweep.animate([
				{opacity: 0.7, transform: `translateX(${forward ? 100 : -100}%)`},
				{offset: 0.5, opacity: 0.55, transform: 'translateX(0%)'},
				{opacity: 0, transform: 'translateX(0%)'},
			], timing),
			cast.animate([
				{opacity: 0, transform: 'translateX(0%)'},
				{offset: 0.55, opacity: 0.5, transform: 'translateX(0%)'},
				{opacity: 0, transform: `translateX(${forward ? -100 : 100}%)`},
			], timing),
		];

		await Promise.all(animations.map(finished));

		// The sheet has landed: its back is the new page on that side.
		onto.replaceChildren(back);
		from.replaceChildren(under);
		leaf.remove();
		delete element.dataset.turning;
	}

	// Under reduced motion the old pages fade out over the new ones.
	async function crossfadeSpread(to) {
		const {left, right} = spreadPages(binder.page_count, to);
		const layer = el('div', {'aria-hidden': 'true', class: 'bs-xfade', inert: true});
		const oldLeft = leftSide.firstElementChild;
		const oldRight = rightSide.firstElementChild;

		layer.append(el('div', {class: 'bs-xfade-cell bs-xfade-left'}, oldLeft || ''), el('div', {class: 'bs-xfade-cell bs-xfade-right'}, oldRight || ''));
		Object.assign(layer.style, {
			height: `${leftSide.offsetHeight}px`,
			left: `${leftSide.offsetLeft}px`,
			top: `${leftSide.offsetTop}px`,
			width: `${(rightSide.offsetLeft + rightSide.offsetWidth) - leftSide.offsetLeft}px`,
		});
		leftSide.replaceChildren(spreadSheet(left, 'left'));
		rightSide.replaceChildren(spreadSheet(right, 'right'));
		book.append(layer);
		element.dataset.turning = 'fade';
		await finished(layer.animate([{opacity: 1}, {opacity: 0}], {duration: FADE_MS, easing: 'ease-out', fill: 'forwards'}));
		layer.remove();
		delete element.dataset.turning;
	}

	async function run(dir) {
		const count = spreadCount(binder.page_count);
		const to = state.spread + dir;

		if (to < 1 || to > count) {
			return false;
		}

		busy = true;
		state = {spread: to, zoom: null};
		replaceUrl();
		changed();

		try {
			if (reducedMotion()) {
				await crossfadeSpread(to);
			}
			else {
				await flip(dir, to);
			}
		}
		finally {
			busy = false;
		}

		// A save that landed mid-turn redraws the new place now.
		if (dirty && alive) {
			dirty = false;
			draw();
		}

		return true;
	}

	// Turns one page forward (1) or back (-1). A turn asked for while one is
	// running waits for it, so quick swipes flip page after page.
	async function turn(dir) {
		if (!alive || state.zoom) {
			return stepZoom(dir);
		}

		if (busy) {
			pending = dir;

			return true;
		}

		const did = await run(dir);

		while (alive && pending) {
			const next = pending;

			pending = 0;
			await run(next);
		}

		return did;
	}

	// Jumps to a spread with no animation (the page list).
	function goTo(spread) {
		if (busy) {
			return;
		}

		state = {spread: clampSpread(binder.page_count, spread), zoom: null};
		replaceUrl();
		draw();
		changed();
	}

	// ------------------------------------------------------- zoom

	function zoomTo(page) {
		state = {spread: spreadOfPage(page), zoom: page};
		pushZoomUrl();
		draw();
		changed();
		zoomBack.focus({preventScroll: true});
		// Its top below the app's sticky header (scroll-margin-top in CSS).
		element.scrollIntoView({block: 'start'});
	}

	function unzoom() {
		const page = state.zoom;

		state = {spread: state.spread, zoom: null};

		if (history.state && history.state.bsZoom) {
			// The app redraws the binder on Back; until then, the spread shows.
			draw();
			changed();
			history.back();

			return;
		}

		replaceUrl();
		draw();
		changed();

		const open = page && element.querySelector(`.bs-open[data-open="${page}"]`);

		if (open) {
			open.focus({preventScroll: true});
		}
	}

	async function stepZoom(dir) {
		const to = (state.zoom || 1) + dir;

		if (!state.zoom || to < 1 || to > binder.page_count) {
			return false;
		}

		state = {spread: spreadOfPage(to), zoom: to};
		replaceUrl();
		noteReturn();

		if (reducedMotion()) {
			const old = zoomSheet.firstElementChild;
			const layer = el('div', {'aria-hidden': 'true', class: 'bs-xfade bs-xfade-zoom', inert: true}, old || '');

			drawZoom();
			zoomSheet.append(layer);
			changed();
			await finished(layer.animate([{opacity: 1}, {opacity: 0}], {duration: FADE_MS, fill: 'forwards'}));
			layer.remove();
		}
		else {
			drawZoom();
			changed();
			await finished(zoomSheet.firstElementChild.animate([
				{opacity: 0.2, transform: `translateX(${dir > 0 ? 24 : -24}px)`},
				{opacity: 1, transform: 'translateX(0)'},
			], {duration: 200, easing: 'ease-out'}));
		}

		return true;
	}

	zoomBack.addEventListener('click', unzoom);
	zoomPrev.addEventListener('click', () => stepZoom(-1));
	zoomNext.addEventListener('click', () => stepZoom(1));
	prevEdge.addEventListener('click', () => turn(-1));
	nextEdge.addEventListener('click', () => turn(1));
	jump.addEventListener('change', () => goTo(Number(jump.value)));

	// ------------------------------------------------------- gestures

	const SWIPE_MIN = 50;
	const EDGE = 16;
	let down = null;

	element.addEventListener('pointerdown', (event) => {
		if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) {
			down = null;

			return;
		}

		// The screen edges belong to the system back gesture; the form
		// controls keep their own drags.
		const owned = event.target.closest && event.target.closest('input, select, textarea, .bs-hint');

		down = owned || event.clientX < EDGE || event.clientX > window.innerWidth - EDGE
			? null
			: {id: event.pointerId, x: event.clientX, y: event.clientY};
	});

	element.addEventListener('pointerup', (event) => {
		if (!down || event.pointerId !== down.id) {
			return;
		}

		const dx = event.clientX - down.x;
		const dy = event.clientY - down.y;

		down = null;

		if (Math.abs(dx) >= SWIPE_MIN && Math.abs(dx) > Math.abs(dy) * 1.5) {
			// The finger's lift is not a tap on the pocket under it.
			suppressUntil = Date.now() + 400;
			turn(dx < 0 ? 1 : -1);
		}
	});

	element.addEventListener('pointercancel', () => {
		down = null;
	});

	element.addEventListener('click', (event) => {
		if (Date.now() < suppressUntil) {
			event.preventDefault();
			event.stopPropagation();
		}
	}, true);

	if (onPocket) {
		element.addEventListener('click', (event) => {
			const pocket = event.target.closest('.bs-pocket');

			if (pocket && !pocket.closest('[inert]') && !event.defaultPrevented) {
				onPocket(Number(pocket.dataset.page), Number(pocket.dataset.position));
			}
		});
	}

	// The arrow keys turn pages while nothing else wants them.
	function onKey(event) {
		if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
			return;
		}

		if ((event.target.closest && event.target.closest('input, textarea, select, dialog')) || document.querySelector('dialog[open], .ph-sheet, .bc-sheet')) {
			return;
		}

		if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
			event.preventDefault();
			turn(event.key === 'ArrowRight' ? 1 : -1);
		}
		else if (event.key === 'Escape' && state.zoom) {
			event.preventDefault();
			unzoom();
		}
	}

	document.addEventListener('keydown', onKey);

	// Rotating the phone switches at once: upright shows the overview, sideways
	// the full spread, and a zoomed page goes back to the spread.
	function onMode() {
		if (!alive) {
			return;
		}

		if (!overview()) {
			if (hintShown && !hint.hidden) {
				writeHint({...readHint(), done: true});
			}

			if (state.zoom) {
				state = {spread: state.spread, zoom: null};
				replaceUrl();
			}
		}

		draw();
		changed();
	}

	if (overviewQuery) {
		overviewQuery.addEventListener('change', onMode);
	}

	// Back and Forward between a spread and a zoomed page, for a page with no
	// router redrawing it (the app redraws the whole binder screen anyway).
	function onPop() {
		if (!alive) {
			return;
		}

		const fromUrl = readSpreadState(window.location.search, binder.page_count, routePage);
		const next = landing(fromUrl, binder.page_count);

		if (next !== fromUrl) {
			replaceUrl(next);
		}

		if (next.spread !== state.spread || next.zoom !== state.zoom) {
			state = next;
			draw();
			changed();
		}
	}

	window.addEventListener('popstate', onPop);

	// ------------------------------------------------------- start

	drawShape();
	drawCover();

	if (state.zoom && !overview()) {
		state = {spread: state.spread, zoom: null};
	}

	replaceUrl();
	draw();

	if (resizes) {
		resizes.observe(element);
	}

	return {
		destroy() {
			alive = false;

			if (resizes) {
				resizes.disconnect();
			}

			document.removeEventListener('keydown', onKey);
			window.removeEventListener('popstate', onPop);

			if (overviewQuery) {
				overviewQuery.removeEventListener('change', onMode);
			}
		},
		element,
		goTo,
		pages: visiblePages,
		state: () => ({...state}),
		turn,
		unzoom,
		// A newer copy of the binder (after a save): the same place, redrawn.
		update(next) {
			const reshaped = next.rows !== binder.rows || next.cols !== binder.cols || next.page_count !== binder.page_count;

			binder = next;

			if (reshaped) {
				drawShape();
			}

			drawCover();
			state = {
				spread: clampSpread(binder.page_count, state.spread),
				zoom: state.zoom && state.zoom <= binder.page_count ? state.zoom : null,
			};

			if (busy) {
				dirty = true;
			}
			else {
				draw();
			}
		},
		zoom: zoomTo,
	};
}
