// Value over time on screen (Eric, 2026-11-18): the collection's line in the
// Value sheet for My Cards, and a card's weekly line on its price panel. The
// data and its storage are js/value-history.js; styles are in
// css/prices.css.
//
// The chart is a plain inline SVG with one line, no library. It carries only
// the shape: every number is HTML text beside it, so it wraps at 360 px and
// grows with larger system text, and the SVG's own name says in words what
// the line shows, for a screen reader. Nothing rests on color: the change is
// an arrow and a word.

import {h} from './dom.js';
import {formatCount, plural} from './format.js';
import {formatBrl, shortDate} from './prices.js';
import {valueChange} from './value-history.js';

const SVG = 'http://www.w3.org/2000/svg';

const copies = (n) => plural(n, 'copy', 'copies');

// The drawing's own units; CSS sets the size and the line keeps its 2 px
// width however the drawing is stretched (vector-effect).
const WIDTH = 300;
const HEIGHT = 100;
const PAD = 8;

function svg(tag, attrs) {
	const node = document.createElementNS(SVG, tag);

	for (const [key, value] of Object.entries(attrs)) {
		node.setAttribute(key, String(value));
	}

	return node;
}

const dayNumber = (date) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));

// "8%", "less than 1%", or null when there is no percentage to give.
function percentText(percent) {
	if (percent === null || percent === undefined) {
		return null;
	}

	const size = Math.abs(percent);

	return size > 0 && size < 1 ? 'less than 1%' : `${Math.round(size)}%`;
}

// {shape, word, text}: "Up R$ 120,00 (8%)". The word and the arrow say the
// direction, so it never rests on color.
function changeWords(change) {
	const direction = change.brl > 0 ? 'up' : change.brl < 0 ? 'down' : 'steady';
	const percent = percentText(change.percent);

	if (direction === 'steady') {
		return {direction, shape: '→', text: 'No change'};
	}

	return {
		direction,
		shape: direction === 'up' ? '↑' : '↓',
		text: `${direction === 'up' ? 'Up' : 'Down'} ${formatBrl(Math.abs(change.brl))}${percent ? ` (${percent})` : ''}`,
	};
}

// What the line shows, in one sentence: its span, first and latest values,
// the change, and its highest and lowest points.
function summary(points, what) {
	const change = valueChange(points);
	const first = change.first;
	const latest = change.latest;
	const highest = points.reduce((best, item) => (item.brl > best.brl ? item : best), first);
	const lowest = points.reduce((best, item) => (item.brl < best.brl ? item : best), first);
	const date = (item) => shortDate(item.date, {year: true});

	return `Line chart of ${what}, ${plural(points.length, 'reading')} from ${date(first)} to ${date(latest)}: `
		+ `${formatBrl(first.brl)} to ${formatBrl(latest.brl)}, ${changeWords(change).text.toLowerCase()}. `
		+ `Highest ${formatBrl(highest.brl)} on ${date(highest)}, lowest ${formatBrl(lowest.brl)} on ${date(lowest)}.`;
}

// The line for points [{date, brl}] (at least two), oldest first, spaced by
// date so a gap of weeks looks like one. what names it for the summary
// ("your collection's value").
export function historyChart(points, {what = 'the value'} = {}) {
	const xs = points.map((item) => dayNumber(item.date));
	const ys = points.map((item) => item.brl);
	const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
	const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
	const x = (value) => (x1 === x0 ? WIDTH / 2 : ((value - x0) / (x1 - x0)) * WIDTH);
	// A flat line sits in the middle rather than on the floor.
	const y = (value) => (y1 === y0 ? HEIGHT / 2 : PAD + (1 - (value - y0) / (y1 - y0)) * (HEIGHT - 2 * PAD));
	const path = points.map((item, i) => `${i ? 'L' : 'M'}${x(xs[i]).toFixed(1)} ${y(item.brl).toFixed(1)}`).join(' ');
	const last = points.length - 1;
	const drawing = svg('svg', {'aria-label': summary(points, what), class: 'vh-svg', focusable: 'false', preserveAspectRatio: 'none', role: 'img', viewBox: `0 0 ${WIDTH} ${HEIGHT}`});

	drawing.append(
		svg('line', {class: 'vh-floor', 'vector-effect': 'non-scaling-stroke', x1: 0, x2: WIDTH, y1: HEIGHT - 0.5, y2: HEIGHT - 0.5}),
		svg('path', {class: 'vh-line', d: path, 'vector-effect': 'non-scaling-stroke'}),
		// The first and latest points as dots: a zero-length stroke with a
		// round cap stays round however the drawing is stretched.
		...[0, last].map((i) => svg('path', {class: 'vh-dot', d: `M${x(xs[i]).toFixed(1)} ${y(points[i].brl).toFixed(1)} h0`, 'vector-effect': 'non-scaling-stroke'}))
	);

	const end = (item, className) => h('p', {class: `vh-end ${className}`},
		h('span', {class: 'vh-end-date'}, shortDate(item.date)),
		h('span', {class: 'vh-end-value'}, formatBrl(item.brl))
	);

	return h('div', {class: 'vh-chart'},
		drawing,
		h('div', {'aria-hidden': 'true', class: 'vh-ends'}, end(points[0], 'vh-first'), end(points[last], 'vh-latest'))
	);
}

// "↑ Up R$ 120,00 (8%) since 1 Nov".
function changeLine(points, className) {
	const change = valueChange(points);
	const words = changeWords(change);

	return h('p', {class: `${className} vh-change vh-change-${words.direction}`, 'data-direction': words.direction},
		h('span', {'aria-hidden': 'true', class: 'vh-change-shape'}, `${words.shape} `),
		`${words.text} since ${shortDate(change.first.date)}`
	);
}

// The Value sheet's "Over time" part for My Cards. history is a promise of
// the snapshots (js/value-history.js readValueHistory), oldest first; the
// part says it is reading until they arrive, so the sheet opens at once.
let partCount = 0;

export function collectionHistory(history) {
	const id = `vh-collection-${++partCount}`;
	const part = h('section', {'aria-labelledby': id, class: 'vh-collection'},
		h('h3', {class: 'vs-of', id}, 'Over time'),
		h('p', {class: 'muted vh-reading'}, 'Reading the values saved on this phone.')
	);

	const fill = (snapshots) => {
		const list = Array.isArray(snapshots) ? snapshots : [];
		const title = part.firstChild;

		if (list.length < 2) {
			const only = list[0];

			part.replaceChildren(title,
				only ? h('p', {class: 'vh-today'}, `${shortDate(only.date)}: ${formatBrl(only.brl)} for ${plural(only.priced, 'priced copy', 'priced copies')}.`) : null,
				h('p', {class: 'muted vh-empty'}, 'The chart fills in as days pass. This phone notes your collection\'s value once a day, when My Cards has fresh prices.')
			);

			return;
		}

		const first = list[0];
		const latest = list[list.length - 1];
		const moved = first.priced !== latest.priced || first.copies !== latest.copies;

		part.replaceChildren(title,
			changeLine(list, 'vh-collection-change'),
			historyChart(list, {what: 'your collection\'s value'}),
			moved ? h('p', {class: 'muted vh-coverage'}, `${formatCount(latest.priced)} of ${copies(latest.copies)} priced now, ${formatCount(first.priced)} of ${copies(first.copies)} on ${shortDate(first.date)}, so cards added or newly priced move the line too.`) : null,
			h('p', {class: 'muted vh-note'}, 'One value a day, worked out on this phone from the US market estimates and any Liga prices kept, converted at that day\'s rate. Copies without a price are left out.')
		);
	};

	Promise.resolve(history).then(fill, () => fill([]));

	return part;
}

// A card's weekly line on its price panel, once the phone holds two weeks of
// it for the finish shown (js/value-history.js cardSeries).
export function cardHistory(series) {
	const market = series.market === 'tcgplayer' ? 'TCGplayer market' : 'Cardmarket trend';

	return h('div', {class: 'vh-card'},
		h('h4', {class: 'vh-card-title'}, 'Saved on this phone'),
		h('p', {class: 'price-meta vh-card-what'}, `${market} for ${series.label}, one price a week, in reais at each week's rate.`),
		changeLine(series.points, 'vh-card-change'),
		historyChart(series.points, {what: `the ${market} price for ${series.label}`})
	);
}
