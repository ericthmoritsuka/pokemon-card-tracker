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
