// Several cards in one frame (lab/multi, Eric, 2026-11-18): a binder page
// taken whole, its pockets cut into a grid, or a few cards lying apart on a
// table. The scanner's Binder page (js/scan/page.js) reads one upright page
// with it; lab/multi measures the rest. The searches themselves are in
// js/scan/steady.js (findCards, findPage), beside findCard, whose helpers
// they share.

// The gap between two pockets' cards, as a share of a card's width: a
// 9-pocket sheet's welds are 2 to 4 mm against a card's 63 mm.
export const POCKET_GAP = 0.05;

// A binder page's width over its height, from its outer cards' edges: cols
// cards and the gaps between them across, rows cards and theirs down.
export function pageShape(rows, cols, gap = POCKET_GAP) {
	const across = cols * 63 + (cols - 1) * gap * 63;
	const down = rows * 88 + (rows - 1) * gap * 63;

	return across / down;
}

// Where the point (u, v) of the unit square lands in the quad tl, tr, br,
// bl (a projective map, as js/scan/rectify.js warpQuad cuts by), so a page
// seen at a slant is divided as it lies, not as a flat rectangle would be.
export function quadPoint([tl, tr, br, bl], u, v) {
	const dx1 = tr.x - br.x;
	const dx2 = bl.x - br.x;
	const dx3 = tl.x - tr.x + br.x - bl.x;
	const dy1 = tr.y - br.y;
	const dy2 = bl.y - br.y;
	const dy3 = tl.y - tr.y + br.y - bl.y;
	const den = dx1 * dy2 - dx2 * dy1;
	const g = den ? (dx3 * dy2 - dx2 * dy3) / den : 0;
	const h = den ? (dx1 * dy3 - dx3 * dy1) / den : 0;
	const a = tr.x - tl.x + g * tr.x;
	const b = bl.x - tl.x + h * bl.x;
	const d = tr.y - tl.y + g * tr.y;
	const e = bl.y - tl.y + h * bl.y;
	const w = g * u + h * v + 1;

	return {x: (a * u + b * v + tl.x) / w, y: (d * u + e * v + tl.y) / w};
}

// The pockets of a page (its corners as js/scan/steady.js findPage gives
// them, top left first, clockwise), row by row: for each, `card`, the quad
// where its card should lie (the page divided evenly, less half a gap on
// each inner side), and `cut`, that quad grown by `pad` of the card's width
// and height on every side, so the card's own edges lie inside the cut
// even where it sits a little off in its pocket (js/scan/rectify.js then
// finds them). Each also carries its row and col.
export function pageCells(corners, rows, cols, {gap = POCKET_GAP, pad = 0.05} = {}) {
	const cells = [];
	// The gap as a share of the page's width and height.
	const across = cols + (cols - 1) * gap;
	const down = rows * (88 / 63) + (rows - 1) * gap;
	const gu = gap / across;
	const gv = gap / down;
	const cu = 1 / across;
	const cv = 88 / 63 / down;

	for (let row = 0; row < rows; row++) {
		for (let col = 0; col < cols; col++) {
			const u0 = col * (cu + gu);
			const v0 = row * (cv + gv);
			const quad = (grow) => [[0, 0], [1, 0], [1, 1], [0, 1]].map(([i, j]) => quadPoint(corners, u0 + (i ? cu + cu * grow : -cu * grow), v0 + (j ? cv + cv * grow : -cv * grow)));

			cells.push({card: quad(0), col, cut: quad(pad), row});
		}
	}

	return cells;
}

// ------------------------------------------------- a page fitted to cards

// The projective map (3 x 3, row by row, the last entry 1) that takes each
// pair's `from` point nearest its `to` point, by least squares over four or
// more pairs (exactly through four); null when the pairs do not fix one.
export function fitHomography(pairs) {
	if (pairs.length < 4) {
		return null;
	}

	// The normal equations of the 2n x 8 system, summed pair by pair.
	const m = Array.from({length: 8}, () => new Array(9).fill(0));

	for (const {from: {x, y}, to: {x: u, y: v}} of pairs) {
		for (const [row, rhs] of [[[x, y, 1, 0, 0, 0, -u * x, -u * y], u], [[0, 0, 0, x, y, 1, -v * x, -v * y], v]]) {
			for (let i = 0; i < 8; i++) {
				for (let j = 0; j < 8; j++) {
					m[i][j] += row[i] * row[j];
				}

				m[i][8] += row[i] * rhs;
			}
		}
	}

	for (let c = 0; c < 8; c++) {
		let pivot = c;

		for (let r = c + 1; r < 8; r++) {
			if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) {
				pivot = r;
			}
		}

		if (Math.abs(m[pivot][c]) < 1e-12) {
			return null;
		}

		[m[c], m[pivot]] = [m[pivot], m[c]];

		for (let r = 0; r < 8; r++) {
			if (r !== c) {
				const f = m[r][c] / m[c][c];

				for (let k = c; k < 9; k++) {
					m[r][k] -= f * m[c][k];
				}
			}
		}
	}

	return [...m.map((row, i) => row[8] / row[i]), 1];
}

export const applyHomography = (h, {x, y}) => {
	const w = h[6] * x + h[7] * y + h[8];

	return {x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w};
};

const UNIT = [{x: 0, y: 0}, {x: 1, y: 0}, {x: 1, y: 1}, {x: 0, y: 1}];

// Where each pocket's card lies in the page's own unit square, row by row
// (the even division pageCells cuts by), as four corners each.
function unitCards(rows, cols, gap) {
	const across = cols + (cols - 1) * gap;
	const down = rows * (88 / 63) + (rows - 1) * gap;
	const cu = 1 / across;
	const cv = 88 / 63 / down;
	const out = [];

	for (let row = 0; row < rows; row++) {
		for (let col = 0; col < cols; col++) {
			const u0 = col * (cu + gap / across);
			const v0 = row * (cv + gap / down);

			out.push(UNIT.map((p) => ({x: u0 + p.x * cu, y: v0 + p.y * cv})));
		}
	}

	return out;
}

const middleOf = (corners) => ({x: corners.reduce((sum, c) => sum + c.x, 0) / 4, y: corners.reduce((sum, c) => sum + c.y, 0) / 4});

// A page's outline (findPages) fitted to the cards found in it (findCards):
// each card standing the way the page stands, its middle in the page, is
// given the pocket its middle falls in, and the page's map is fitted to
// every such card's four corners against its pocket's (fitHomography), so
// the pockets fall on the cards even where the outline found was the
// sheet's edge or the binder's. Needs `least` cards in different pockets,
// over two rows and two columns at least; returns {corners, cards} (cards:
// how many were fitted to), or null.
export function fitPage(corners, cards, rows, cols, {gap = POCKET_GAP, least = 3, slack = 0.15} = {}) {
	const toPage = fitHomography(corners.map((p, i) => ({from: p, to: UNIT[i]})));

	if (!toPage) {
		return null;
	}

	const places = unitCards(rows, cols, gap);
	const used = new Map();

	for (const card of cards) {
		const at = applyHomography(toPage, middleOf(card.corners));

		if (at.x < 0 || at.y < 0 || at.x >= 1 || at.y >= 1) {
			continue;
		}

		// The card's corners, taken round the page's way: a card found
		// standing in a page found lying is turned a quarter in it.
		const local = card.corners.map((p) => applyHomography(toPage, p));
		const index = places.findIndex((place) => {
			const xs = place.map((p) => p.x);
			const ys = place.map((p) => p.y);

			return at.x >= Math.min(...xs) - 0.03 && at.x <= Math.max(...xs) + 0.03 && at.y >= Math.min(...ys) - 0.03 && at.y <= Math.max(...ys) + 0.03;
		});
		const tall = Math.hypot(local[3].x - local[0].x, local[3].y - local[0].y) * rows;
		const wide = Math.hypot(local[1].x - local[0].x, local[1].y - local[0].y) * cols;

		// Only a card about a pocket's size, standing as the page does.
		if (index < 0 || used.has(index) || tall < 0.7 || tall > 1.3 || wide < 0.7 || wide > 1.3) {
			continue;
		}

		used.set(index, card.corners);
	}

	// Cards in one row or one column leave the map free to tilt across it.
	const rowsUsed = new Set([...used.keys()].map((index) => Math.floor(index / cols)));
	const colsUsed = new Set([...used.keys()].map((index) => index % cols));

	if (used.size < least || rowsUsed.size < 2 || colsUsed.size < 2) {
		return null;
	}

	const pairs = [...used].flatMap(([index, found]) => places[index].map((p, k) => ({from: p, to: found[k]})));
	const fitted = fitHomography(pairs);

	if (!fitted) {
		return null;
	}

	// A card given the wrong pocket pulls the map off the others: the fit
	// stands only when every card's corners land within `slack` of a card's
	// height of where it put them.
	const tallest = Math.max(...[...used.values()].map((c) => Math.hypot(c[3].x - c[0].x, c[3].y - c[0].y)));
	const worst = Math.max(...pairs.map(({from, to}) => {
		const at = applyHomography(fitted, from);

		return Math.hypot(at.x - to.x, at.y - to.y);
	}));

	return worst <= tallest * slack ? {cards: used.size, corners: UNIT.map((p) => applyHomography(fitted, p))} : null;
}

// A spread taken for one page (its outline round both pages, which for
// 3 x 3 pages has a page's shape, standing): most of the cards in it lie
// across it. Returns the two pages, each lying, its corners ordered as
// findPages orders a lying page's (the lower end of its left side first),
// or null when the cards stand as the outline does.
export function splitSpread(corners, cards, {least = 3} = {}) {
	const toPage = fitHomography(corners.map((p, i) => ({from: p, to: UNIT[i]})));
	const inside = toPage ? cards.filter((card) => {
		const at = applyHomography(toPage, middleOf(card.corners));

		return at.x >= 0 && at.y >= 0 && at.x <= 1 && at.y <= 1;
	}) : [];
	const across = inside.filter((card) => card.upright === false).length;

	if (inside.length < least || across * 3 < inside.length * 2) {
		return null;
	}

	const [tl, tr, br, bl] = corners;
	const ml = {x: (tl.x + bl.x) / 2, y: (tl.y + bl.y) / 2};
	const mr = {x: (tr.x + br.x) / 2, y: (tr.y + br.y) / 2};

	return [[ml, tl, tr, mr], [bl, ml, mr, br]];
}

// ------------------------------------------------- a page fitted from its cards alone

const quadArea = (q) => Math.abs(q.reduce((sum, p, i) => sum + p.x * q[(i + 1) % 4].y - q[(i + 1) % 4].x * p.y, 0)) / 2;
const tallOf = (c) => Math.hypot(c[3].x - c[0].x, c[3].y - c[0].y);

// How far a card's corners land from pocket `place`'s under map `h`, as a
// share of the card's height.
function missBy(h, place, corners) {
	return Math.max(...place.map((p, j) => {
		const at = applyHomography(h, p);

		return Math.hypot(at.x - corners[j].x, at.y - corners[j].y);
	})) / tallOf(corners);
}

// Each card given the pocket map `h` puts nearest it, within `slack`; one
// card a pocket, the nearer kept.
function pocketsFor(h, places, cards, slack) {
	const by = new Map();

	for (const card of cards) {
		let index = -1;
		let miss = Infinity;

		places.forEach((place, i) => {
			const off = missBy(h, place, card.corners);

			if (off < miss) {
				miss = off;
				index = i;
			}
		});

		if (miss <= slack && (!by.has(index) || by.get(index).miss > miss)) {
			by.set(index, {card, miss});
		}
	}

	return [...by].map(([index, {card, miss}]) => ({card, index, miss}));
}

// A page's outline from the cards found in it alone, with no outline to
// start from (Eric, 2026-11-19: two pages side by side, where the outline
// search finds the binder's edge, a row short, or a page lying across the
// other more often than the page): each card standing, about the size of
// the others, is tried in each pocket in turn; the page that puts most of
// the other cards in pockets, within `slack` of a card's height, is fitted
// to all of them (fitHomography), twice over. Needs `least` cards over two
// rows and two columns; a page running out of the width x height frame
// counts against it. Returns {corners, cards} as fitPage does, or null.
export function fitGrid(cards, rows, cols, {gap = POCKET_GAP, height = Infinity, least = 3, slack = 0.15, width = Infinity} = {}) {
	const places = unitCards(rows, cols, gap);
	const standing = cards.filter((card) => card.upright !== false);

	if (standing.length < least) {
		return null;
	}

	const areas = standing.map((card) => quadArea(card.corners)).sort((a, b) => a - b);
	const usual = areas[Math.floor(areas.length / 2)];
	const pool = standing.filter((card) => quadArea(card.corners) >= usual * 0.6 && quadArea(card.corners) <= usual * 1.5);
	let best = null;

	for (const anchor of pool) {
		for (const place of places) {
			let h = fitHomography(place.map((p, j) => ({from: p, to: anchor.corners[j]})));

			if (!h) {
				continue;
			}

			// The first guess, from one card, is loose far from it.
			let used = pocketsFor(h, places, pool, slack * 2);

			for (let round = 0; round < 2 && used.length >= least; round++) {
				const fitted = fitHomography(used.flatMap(({card, index}) => places[index].map((p, j) => ({from: p, to: card.corners[j]}))));

				if (!fitted) {
					break;
				}

				h = fitted;
				used = pocketsFor(h, places, pool, slack);
			}

			const rowsUsed = new Set(used.map(({index}) => Math.floor(index / cols)));
			const colsUsed = new Set(used.map(({index}) => index % cols));

			if (used.length < least || rowsUsed.size < 2 || colsUsed.size < 2) {
				continue;
			}

			const corners = UNIT.map((p) => applyHomography(h, p));
			const out = corners.reduce((sum, p) => sum + Math.max(0, -p.x, p.x - width) / width + Math.max(0, -p.y, p.y - height) / height, 0);
			const score = used.length - out * 4 - used.reduce((sum, {miss}) => sum + miss, 0) / used.length;

			if (!best || score > best.score) {
				best = {cards: used.length, corners, score};
			}
		}
	}

	return best && {cards: best.cards, corners: best.corners};
}

// ------------------------------------------------- two pages side by side

// Whether `share` of the cards found or more lie on their side (`least` of
// them at least): a binder taken with the phone turned, as Eric takes a
// spread (2026-11-19: the photo stands, the two pages one above the other).
// Two lying cards one above the other make a standing card's shape, so on
// a spread a third or more of the boxes found may stand.
export function cardsLie(cards, {least = 3, share = 2 / 3} = {}) {
	const lying = cards.filter((card) => card.upright === false).length;

	return lying >= least && lying >= cards.length * share;
}

const midX = (card) => card.corners.reduce((sum, p) => sum + p.x, 0) / 4;
const wideOf = (c) => Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y);

// Whether the standing cards found lie over two pages side by side: their
// middles spread wider than one page's three columns allow (3.5 cards'
// widths, where one page's outer middles are 2.1 apart).
export function twoPages(cards, {least = 4} = {}) {
	const standing = cards.filter((card) => card.upright !== false);

	if (standing.length < least) {
		return false;
	}

	const wides = standing.map((card) => wideOf(card.corners)).sort((a, b) => a - b);
	const wide = wides[Math.floor(wides.length / 2)];
	const xs = standing.map(midX);

	return Math.max(...xs) - Math.min(...xs) > wide * 3.5;
}

// Where the binder's spine runs between two pages side by side, as x in a
// grey copy (width x height) of the spread standing: the darkest stretch of
// columns (each column's mean over the middle rows, smoothed over a fiftieth
// of the width) in the middle 30 to 70 % of the width, where the binder's
// dark cover shows between the pages, wider than the welds between pockets.
// When a standing card's middle lies on it, the middle of the widest gap
// between the cards' middles there is taken instead.
export function spineAt(grey, width, height, cards = []) {
	const column = new Float64Array(width);
	const top = Math.floor(height * 0.2);
	const bottom = Math.ceil(height * 0.8);

	for (let x = 0; x < width; x++) {
		let sum = 0;

		for (let y = top; y < bottom; y++) {
			sum += grey[y * width + x];
		}

		column[x] = sum / (bottom - top);
	}

	const reach = Math.max(1, Math.round(width * 0.02));
	let spine = -1;
	let darkest = Infinity;

	for (let x = Math.floor(width * 0.3); x < width * 0.7; x++) {
		let sum = 0;
		let n = 0;

		for (let d = -reach; d <= reach; d++) {
			if (x + d >= 0 && x + d < width) {
				sum += column[x + d];
				n++;
			}
		}

		if (sum / n < darkest) {
			darkest = sum / n;
			spine = x;
		}
	}

	const standing = cards.filter((card) => card.upright !== false);
	const onIt = standing.some((card) => Math.abs(midX(card) - spine) < wideOf(card.corners) * 0.35);
	const xs = standing.map(midX).filter((x) => x >= width * 0.25 && x <= width * 0.75).sort((a, b) => a - b);

	if (onIt && xs.length >= 2) {
		let widest = 0;

		for (let i = 1; i < xs.length; i++) {
			if (xs[i] - xs[i - 1] > widest) {
				widest = xs[i] - xs[i - 1];
				spine = (xs[i] + xs[i - 1]) / 2;
			}
		}
	}

	return spine;
}

// How dark the darkest band of rows across the middle of a grey copy is
// against the rest: each row's mean over the middle 60 % of the width,
// smoothed over a fiftieth of the height, the darkest in the middle 30 to
// 70 % of the height over the median there. A spread taken with the phone
// turned has the binder's spine across its middle: 0.14 to 0.44 on Eric's
// spreads and a synthetic one, against 0.74 to 0.88 on his single pages,
// whose middle rows hold cards. It tells the turn where the cards found
// do not: clean prints whose art box splits each lying card into two
// standing boxes (SPINE_BAND below).
export const SPINE_BAND = 0.6;

export function darkBand(grey, width, height) {
	const left = Math.floor(width * 0.2);
	const right = Math.ceil(width * 0.8);
	const row = new Float64Array(height);

	for (let y = 0; y < height; y++) {
		let sum = 0;

		for (let x = left; x < right; x++) {
			sum += grey[y * width + x];
		}

		row[y] = sum / (right - left);
	}

	const reach = Math.max(1, Math.round(height * 0.02));
	const bands = [];

	for (let y = Math.floor(height * 0.3); y < height * 0.7; y++) {
		let sum = 0;
		let n = 0;

		for (let d = -reach; d <= reach; d++) {
			if (y + d >= 0 && y + d < height) {
				sum += row[y + d];
				n++;
			}
		}

		bands.push(sum / n);
	}

	if (!bands.length) {
		return 1;
	}

	const sorted = bands.sort((a, b) => a - b);
	const median = sorted[Math.floor(sorted.length / 2)];

	return median > 0 ? sorted[0] / median : 1;
}
