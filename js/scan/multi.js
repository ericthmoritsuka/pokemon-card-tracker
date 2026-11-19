// Several cards in one frame (lab/multi, Eric, 2026-11-18): a binder page
// taken whole, its pockets cut into a grid, or a few cards lying apart on a
// table. Nothing in the app calls this yet: lab/multi measures it first.
// The searches themselves are in js/scan/steady.js (findCards, findPage),
// beside findCard, whose helpers they share.

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
