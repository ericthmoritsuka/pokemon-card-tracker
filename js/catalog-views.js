// Catalog browser: Sets, set detail, and card detail.

import {
	LANGUAGES,
	NotOnPhoneError,
	cardDetail,
	cardImage,
	cardIndex,
	catalogFor,
	compareNumbers,
	languageLabel,
	logoImage,
	priceRecords,
	setDetail,
	setList,
	setViewingLanguage,
	viewingLanguage,
} from './catalog.js';
import {speciesNames} from './checklists.js';
import {onChange, ownedBySet, ownedIn, sourceNames} from './collection.js';
import {cardPosition, cardSwipe, offerCardList} from './card-swipe.js';
import {BASE, errorText, h} from './dom.js';
import {flagBadge} from './flags.js';
import {ligaUrl} from './liga.js';
import {finishLabel} from './monprice.js';
import {cardNames, hasOwnNames} from './names.js';
import {copyPriceText, priceSection, statsBar} from './price-view.js';
import {cardArt, cardTile, forgetImage, groupFinish} from './tile.js';
import {cardPhotos} from './photos/index.js';
import {loadTwins, onTwinsChange, twinKey, twinName, twinSlides} from './twins.js';
import {twinConfirm} from './twins-view.js';

// Card art lives in js/tile.js with the badges; this name stays for the
// modules that import it from here.
export {cardArt};

// International prints share English card records (DESIGN.md section 3), so
// only these languages fall back to the English list of the same set.
const FALLS_BACK_TO_ENGLISH = new Set(['pt', 'fr']);

const cardsText = (n) => `${n} ${n === 1 ? 'card' : 'cards'}`;

const routeTo = (...parts) => parts.map((part) => encodeURIComponent(part)).join('/');

const link = (route, attrs, ...children) => h('a', {...attrs, 'data-link': route, href: BASE + route}, ...children);

// ------------------------------------------------------- card names
//
// Japanese, Korean, and Chinese prints show an English name first and the
// original name, with a reading, under it (js/names.js). The species names
// those need come from PokeAPI once a device (js/checklists.js); until they
// are on the phone, a card shows its original name.

let speciesTables = null;
let speciesLoad = null;

// Redraws waiting for the tables, each run once however many tiles asked.
const waiting = new Set();

// The species tables, or null while they load. onLoad runs once they are
// in, so a view can redraw with the English names.
export function loadedSpeciesNames(onLoad) {
	if (speciesTables) {
		return speciesTables;
	}

	if (onLoad) {
		waiting.add(onLoad);
	}

	if (!speciesLoad) {
		speciesLoad = speciesNames()
			.then((tables) => {
				speciesTables = tables;
			})
			.catch(() => {
				// Original names only, this visit.
			})
			.finally(() => {
				speciesLoad = null;

				const callbacks = [...waiting];

				waiting.clear();
				callbacks.forEach((callback) => callback());
			});
	}

	return null;
}

// The lang attribute for a name in a catalog language, so the browser picks
// a Japanese, Korean, or Chinese font for it.
export const htmlLang = (lang) => ({'zh-cn': 'zh-Hans', 'zh-tw': 'zh-Hant'}[lang] || lang);

// {english, original, reading} for a card name in a language. Western
// names come back as they are. onLoad as for loadedSpeciesNames.
export function namesFor({category = null, dexId = null, lang, name}, onLoad) {
	if (!hasOwnNames(lang)) {
		return {english: null, original: String(name || ''), reading: null};
	}

	return cardNames({category, dexId, lang, name}, loadedSpeciesNames(onLoad));
}

// The smaller line under the main name: the original with its reading, or
// the reading alone when the original is the main name. Null when there is
// nothing more to say.
export function originalLine({english, original, reading}) {
	if (english) {
		return reading ? `${original} (${reading})` : original;
	}

	return reading ? `(${reading})` : null;
}

export const mainName = (names) => names.english || names.original;

// The names with a confident or confirmed international twin's English name
// (js/twins.js), for a Japanese Trainer or Energy that js/names.js has no
// English name for. item is {card_id, catalog}.
export function withTwinName(names, item) {
	if (names.english) {
		return names;
	}

	const english = twinName(item);

	return english ? {...names, english} : names;
}

// A tile's name: the main name, and the original line under it. lang is
// the language the original is written in.
export const tileNames = (names, lang) => [
	h('span', {class: 'tile-name', lang: names.english ? null : htmlLang(lang)}, mainName(names)),
	originalLine(names) ? h('span', {class: 'tile-original', lang: htmlLang(lang)}, originalLine(names)) : null,
];

// -------------------------------------------------------- loading states

function skeletonTiles(count) {
	return Array.from({length: count}, () =>
		h('div', {class: 'tile skeleton', 'aria-hidden': 'true'},
			h('div', {class: 'art loading'}),
			h('span', {class: 'bar'}),
			h('span', {class: 'bar short'})
		)
	);
}

function loadFailure(err, what, retry) {
	let message;

	if (err instanceof NotOnPhoneError) {
		message = `${what} is not on this phone yet. It downloads the next time you're online.`;
	}
	else if (err && err.status) {
		message = `Could not load ${what.toLowerCase()}. ${err.message}`;
	}
	else {
		// A dropped connection, or an API error page without CORS headers.
		message = `Could not load ${what.toLowerCase()}. TCGdex, the card catalog, did not answer. Try again in a minute. (${errorText(err)})`;
	}

	// A full-width panel, never a notice inside a grid column.
	return h('div', {class: 'notice notice-wide', role: 'alert'},
		h('p', null, message),
		h('button', {type: 'button', onclick: retry}, 'Try again')
	);
}

// ------------------------------------------------------------ sets view

// Sets order, remembered like the viewing language.
const SET_SORTS = [
	{label: 'Newest first', value: 'newest'},
	{label: 'Oldest first', value: 'oldest'},
	{label: 'Name A to Z', value: 'name'},
];

const SET_SORT_KEY = 'cardTracker.setSort';

// Set detail: every card, only owned ones, or only missing ones.
const SET_FILTERS = [
	{label: 'All', value: 'all'},
	{label: 'Owned', value: 'owned'},
	{label: 'Missing', value: 'missing'},
];

const SET_FILTER_KEY = 'cardTracker.setFilter';

function readChoice(key, allowed, fallback) {
	try {
		const saved = localStorage.getItem(key);

		return allowed.includes(saved) ? saved : fallback;
	}
	catch {
		return fallback;
	}
}

function saveChoice(key, value) {
	try {
		localStorage.setItem(key, value);
	}
	catch {
		// The choice lasts for this visit only.
	}
}

// Newest first: series by their TCGdex releaseDate, and sets within a series
// by their place in the API's release-date order (releaseRank, 0 newest).
// A set list saved before ranks were added has neither, so its API order,
// which is oldest first, is reversed instead.
function orderSeries(series, sort) {
	const sets = (serie) => serie.sets.map((set, i) => ({rank: set.releaseRank ?? (100000 - i), set}));
	const newest = series.map((serie, i) => {
		const ranked = sets(serie).sort((a, b) => a.rank - b.rank);

		return {
			date: serie.releaseDate || '',
			first: ranked.length ? ranked[0].rank : Infinity,
			i,
			serie: {...serie, sets: ranked.map((item) => item.set)},
		};
	}).sort((a, b) => (b.date || a.date ? b.date.localeCompare(a.date) : 0) || a.first - b.first || b.i - a.i)
		.map((item) => item.serie);

	if (sort === 'oldest') {
		return newest.reverse().map((serie) => ({...serie, sets: [...serie.sets].reverse()}));
	}

	return newest;
}

export function setsView(root) {
	let alive = true;
	let lang = viewingLanguage();
	let series = null;
	let owned = new Map();

	const select = h('select', {id: 'viewing', onchange: () => changeLanguage(select.value)},
		LANGUAGES.map(({code, label}) => h('option', {selected: code === lang, value: code}, label))
	);
	const sort = h('select', {'aria-label': 'Sort sets', id: 'set-sort', onchange: () => {
		saveChoice(SET_SORT_KEY, sort.value);
		draw();
	}}, SET_SORTS.map(({label, value}) => h('option', {value}, label)));

	sort.value = readChoice(SET_SORT_KEY, SET_SORTS.map((option) => option.value), 'newest');
	const search = h('input', {
		'aria-label': 'Search sets by name or code',
		autocomplete: 'off',
		class: 'search',
		oninput: draw,
		placeholder: 'Search sets by name or code',
		type: 'search',
	});
	const list = h('div', {class: 'set-list'});

	function changeLanguage(code) {
		lang = code;
		select.value = code;
		setViewingLanguage(code);
		load();
	}

	function setTile(set) {
		const total = set.cardCount.total ?? set.cardCount.official;
		const logo = h('div', {class: 'logo'});
		const src = logoImage(set.logo);
		const noLogo = () => logo.replaceChildren(h('span', {class: 'logo-text'}, set.id));

		if (src) {
			const img = h('img', {alt: '', decoding: 'async', loading: 'lazy'});

			img.addEventListener('error', () => {
				forgetImage(src);
				noLogo();
			}, {once: true});
			img.src = src;
			logo.append(img);
		}
		else {
			noLogo();
		}

		const have = (owned.get(`${catalogFor(lang)}|${set.id}`) || new Set()).size;
		// The ring always comes with its "12 / 102" text, never alone.
		const progress = typeof total === 'number'
			? h('span', {'aria-label': `${have} of ${total} cards owned`, class: have ? 'owned-count owned' : 'owned-count'},
				h('span', {
					'aria-hidden': 'true',
					class: 'ring',
					style: `--p: ${total ? Math.min(100, Math.round((have / total) * 100)) : 0}`,
				}),
				h('span', {'aria-hidden': 'true'}, `${have} / ${total}`)
			)
			: null;

		return link(routeTo('sets', lang, set.id), {class: 'set-tile'},
			logo,
			h('span', {class: 'set-name'}, set.name),
			h('span', {class: 'set-foot'}, h('span', {class: 'set-meta'}, set.id), progress)
		);
	}

	function draw() {
		if (!series) {
			return;
		}

		const query = search.value.trim().toLowerCase();
		const matches = (set) => !query || set.name.toLowerCase().includes(query) || set.id.toLowerCase().includes(query);
		let groups;

		if (sort.value === 'name') {
			// One flat list: a series heading means little in name order.
			const all = series.flatMap((serie) => serie.sets).filter(matches);
			const collator = new Intl.Collator(lang, {numeric: true, sensitivity: 'base'});

			groups = all.length ? [{name: null, sets: all.sort((a, b) => collator.compare(a.name, b.name))}] : [];
		}
		else {
			groups = orderSeries(series, sort.value)
				.map((serie) => ({...serie, sets: serie.sets.filter(matches)}))
				.filter((serie) => serie.sets.length);
		}

		const children = groups.map((serie) =>
			h('section', {class: 'serie'},
				serie.name ? h('h3', null, serie.name) : null,
				h('div', {class: 'set-grid'}, serie.sets.map(setTile))
			)
		);

		if (!groups.length) {
			children.push(h('p', {class: 'muted'}, `No ${languageLabel(lang)} sets match "${search.value.trim()}".`));
		}

		if (lang === 'ko') {
			children.push(
				h('div', {class: 'notice'},
					h('p', null, 'Korean sets in this catalog end at the SV5 era. Newer Korean cards, such as M4 and M6, use the Japanese sets, which have the same set codes.'),
					h('button', {type: 'button', onclick: () => changeLanguage('ja')}, 'Show Japanese sets')
				)
			);
		}

		list.replaceChildren(...children);
	}

	async function load() {
		const wanted = lang;

		series = null;
		list.replaceChildren(h('div', {class: 'set-grid'}, Array.from({length: 8}, () => h('div', {class: 'set-tile skeleton', 'aria-hidden': 'true'}, h('div', {class: 'logo loading'})))));

		try {
			const result = await setList(wanted, (fresh) => {
				if (alive && lang === wanted) {
					series = fresh;
					draw();
				}
			});

			if (!alive || lang !== wanted) {
				return;
			}

			series = result.data;
			draw();
		}
		catch (err) {
			if (alive && lang === wanted) {
				list.replaceChildren(loadFailure(err, `The ${languageLabel(wanted)} set list`, load));
			}
		}
	}

	root.append(
		h('div', {class: 'toolbar'},
			h('div', {class: 'toolbar-row'},
				h('label', {class: 'viewing', for: 'viewing'}, h('span', null, 'Viewing:'), h('span', {class: 'select-wrap'}, select)),
				h('span', {class: 'select-wrap sort-wrap'}, sort)
			),
			search
		),
		list
	);

	ownedBySet()
		.then((sets) => {
			owned = sets;

			if (alive) {
				draw();
			}
		})
		.catch(() => {
			// Rings stay at zero.
		});

	load();

	return () => {
		alive = false;
	};
}

// ------------------------------------------------------ set detail view

export function setView(root, {lang, setId}) {
	let alive = true;

	const back = link('sets', {class: 'back'}, '‹ All sets');
	const title = h('h2', null, setId);
	const meta = h('p', {class: 'muted'});
	const note = h('div', {hidden: true});
	const problem = h('div');
	const grid = h('div', {class: 'card-grid'});
	// The value of the copies owned from this set (js/price-view.js).
	const stats = h('div', {class: 'set-stats', id: 'set-stats'});

	let owned = new Map();
	let shown = null;
	let show = readChoice(SET_FILTER_KEY, SET_FILTERS.map((option) => option.value), 'all');
	let statsKey = null;

	// Redrawn only when the owned copies change, so the filter keeps the
	// Liga price basis the person picked.
	async function drawStats(set, cards) {
		const entries = cards.filter((card) => owned.has(card.id)).flatMap((card) => owned.get(card.id).entries);
		const key = `${set.id}|${entries.map((entry) => `${entry.id}:${JSON.stringify(entry.price_manual || null)}`).join(',')}`;

		if (key === statsKey) {
			return;
		}

		statsKey = key;

		if (!entries.length) {
			stats.replaceChildren();

			return;
		}

		const records = await priceRecords(entries);

		if (alive && statsKey === key) {
			stats.replaceChildren(statsBar({cardsById: records, entries, label: `your cards from ${set.name}`}));
		}
	}

	const filter = h('div', {'aria-label': 'Show', class: 'segmented', role: 'radiogroup'},
		SET_FILTERS.map(({label, value}) => h('label', null,
			h('input', {checked: value === show, name: 'set-filter', onchange: () => {
				show = value;
				saveChoice(SET_FILTER_KEY, value);

				if (shown) {
					draw(...shown);
				}
			}, type: 'radio', value}),
			h('span', null, label)
		))
	);

	function draw(set, cards, cardLang) {
		shown = [set, cards, cardLang];

		const redraw = () => alive && shown && draw(...shown);

		const total = set.cardCount && (set.cardCount.total ?? set.cardCount.official);

		title.textContent = set.name;
		document.title = `${set.name} | Card Tracker`;
		meta.textContent = [set.id, set.serie && set.serie.name, typeof total === 'number' ? cardsText(total) : null, languageLabel(lang)]
			.filter(Boolean)
			.join(' · ');

		if (!cards.length) {
			grid.replaceChildren(h('p', {class: 'muted grid-wide'}, `TCGdex lists no cards for this set in ${languageLabel(lang)}.`));
			offerCardList([], set.name);

			return;
		}

		const sorted = [...cards].sort((a, b) => compareNumbers(a.localId, b.localId));

		const have = sorted.filter((card) => owned.has(card.id)).length;

		meta.textContent += ` · ${have} / ${sorted.length} owned`;
		drawStats(set, sorted).catch(() => {
			// No statistics this time; the set itself is unaffected.
		});

		const visible = sorted.filter((card) => show === 'all' || (show === 'owned') === owned.has(card.id));

		if (!visible.length) {
			grid.replaceChildren(h('p', {class: 'muted grid-wide'}, show === 'owned' ? 'No cards from this set are saved yet.' : 'Every card in this set is owned.'));
			offerCardList([], set.name);

			return;
		}

		const tiles = visible.map((card) => {
			const names = namesFor({lang: cardLang, name: card.name}, redraw);
			const info = {name: mainName(names), number: card.localId, setName: set.name};
			const mine = owned.get(card.id);
			const route = routeTo('cards', cardLang, card.id);
			let art = {info, src: cardImage(card.image, 'low')};
			let status = null;

			if (mine) {
				const languages = [...mine.byLanguage.entries()].sort((a, b) => b[1] - a[1]).map(([code]) => code);
				// The count is for the language the corner flag names: the
				// viewing language when a copy is in it, else the only other.
				const count = mine.byLanguage.has(lang)
					? mine.byLanguage.get(lang)
					: languages.length === 1 ? mine.total : 0;

				// Owned: a check in a yellow disc and full color, plus the
				// words in the meta line. Never the danger red.
				art = {...art, count, finish: groupFinish(mine.entries), languages, status: 'owned', viewing: lang};

				// "Owned in PT" when no copy is in the language being viewed
				// (DESIGN.md section 3).
				status = mine.byLanguage.has(lang) ? 'Owned' : `Owned in ${languages.map(chip).join(', ')}`;
			}

			return {
				node: cardTile({
					art,
					className: mine ? 'owned' : 'unowned',
					meta: [`#${card.localId}`, status ? h('span', {class: 'owned-text'}, ` · ${status}`) : ' · Missing'],
					names: tileNames(names, cardLang),
					route,
				}),
				route,
			};
		});

		grid.replaceChildren(...tiles.map((tile) => tile.node));
		offerCardList(tiles.map((tile) => tile.route), set.name);
	}

	async function load() {
		note.hidden = true;
		problem.replaceChildren();
		grid.replaceChildren(...skeletonTiles(12));

		try {
			owned = await ownedIn(catalogFor(lang));
		}
		catch {
			owned = new Map();
		}

		try {
			const {data: set} = await setDetail(lang, setId, (fresh) => {
				if (alive && (fresh.cards || []).length) {
					draw(fresh, fresh.cards, lang);
				}
			});

			if (!alive) {
				return;
			}

			const cards = set.cards || [];

			if (!cards.length && FALLS_BACK_TO_ENGLISH.has(lang)) {
				const {data: english} = await setDetail('en', setId);

				if (!alive) {
					return;
				}

				note.replaceChildren(h('p', null, `No ${languageLabel(lang)} list for this set. Showing English.`));
				note.className = 'notice';
				note.hidden = false;
				draw(set, english.cards || [], 'en');

				return;
			}

			draw(set, cards, lang);
		}
		catch (err) {
			if (alive) {
				grid.replaceChildren();
				problem.replaceChildren(loadFailure(err, 'This set', load));
			}
		}
	}

	root.append(back, title, meta, stats, filter, note, problem, grid);
	load();

	return () => {
		alive = false;
	};
}

// ----------------------------------------------------- card detail view

const VARIANT_TYPES = {holo: 'Holo', normal: 'Normal', reverse: 'Reverse holo'};

const chip = (code) => (code === 'zh-cn' ? 'CHS' : code === 'zh-tw' ? 'CHT' : String(code).toUpperCase());
const FOILS = {masterball: 'Master Ball pattern', pokeball: 'Poké Ball pattern'};
const STAMPS = {'1st-edition': '1st Edition stamp'};

const sentence = (text) => {
	// "1999-2000-copyright" becomes "1999-2000 copyright".
	const words = String(text).replace(/_+/g, ' ').replace(/-(?=\D)|(?<=\D)-/g, ' ');

	return words.charAt(0).toUpperCase() + words.slice(1);
};

function variantText(variant) {
	const parts = [VARIANT_TYPES[String(variant.type).toLowerCase()] || sentence(variant.type || 'Unknown')];

	if (variant.subtype) {
		parts.push(sentence(variant.subtype));
	}

	if (variant.foil) {
		parts.push(FOILS[variant.foil] || `${sentence(variant.foil)} foil`);
	}

	for (const stamp of variant.stamp || []) {
		parts.push(STAMPS[stamp] || `${sentence(stamp)} stamp`);
	}

	if (variant.size && variant.size !== 'standard') {
		parts.push(sentence(variant.size));
	}

	return parts.join(', ');
}

export function cardView(root, {lang, cardId}) {
	let alive = true;

	// Opened from a list, the card keeps it: a position line, edge arrows,
	// and swiping move through it (js/card-swipe.js).
	const route = routeTo('cards', lang, cardId);
	const position = cardPosition(route);
	const swipe = cardSwipe(root, route);
	const photos = cardPhotos({cardId, catalog: catalogFor(lang)});
	// A Japanese print's international twin: its image joins the carousel,
	// its English name leads for a Trainer or Energy, and the picker asks
	// when the matcher was unsure (js/twins.js, js/twins-view.js).
	const twinItem = {card_id: cardId, catalog: catalogFor(lang)};
	const twin = twinConfirm({cardId, catalog: catalogFor(lang)});
	const twinShown = () => JSON.stringify([twinSlides(twinItem), twinName(twinItem)]);
	let twinDrawn = null;
	const twinChanged = (key) => alive && current && (!key || key === twinKey(twinItem)) && twinShown() !== twinDrawn && draw(current);
	const stopTwins = onTwinsChange(twinChanged);
	// At least 48 px wide, like its height, however short the label ("‹ 151").
	const back = link('sets', {class: 'back', style: 'min-width: 48px'}, position && position.label ? `‹ ${position.label}` : '‹ Back');
	const body = h('div', {class: 'card-detail'},
		h('div', {class: 'card-hero'}, h('div', {class: 'art loading hero-art', 'aria-hidden': 'true'}))
	);

	back.addEventListener('click', (event) => {
		// Return to the grid the card was opened from, which may be another
		// language when a set fell back to English.
		if (history.state && history.state.inApp) {
			event.preventDefault();
			event.stopPropagation();
			history.back();
		}
	});

	function row(label, value) {
		return value ? [h('dt', null, label), h('dd', null, value)] : [];
	}

	// The names the source gave the owner's copies, when every copy of this
	// card is one the catalog has no names for in its language (a Korean
	// copy on a Japanese record). Null shows the catalog's names.
	let source = null;

	function draw(card) {
		current = card;
		render(card);
		twin.check(card);
		drawCopies(card, Array.isArray(card.variants_detailed) ? card.variants_detailed : []);
		drawLiga(card);
	}

	// The names shown: English first for an Asian print, in the language the
	// name is written in (a Korean copy's own name on a Japanese record).
	const nameLang = () => (source && source.language) || lang;
	const shownNames = (card) => withTwinName(namesFor({
		category: card.category || null,
		dexId: card.dexId || null,
		lang: nameLang(),
		name: (source && source.name) || card.name,
	}, redrawNames), twinItem);

	let current = null;

	function redrawNames() {
		if (alive && current) {
			draw(current);
		}
	}

	function render(card) {
		const set = card.set || {};
		const official = set.cardCount && set.cardCount.official;
		const number = official ? `${card.localId} / ${official}` : card.localId;
		const names = shownNames(card);
		const name = mainName(names);
		const below = originalLine(names);
		const setName = (source && source.setName) || set.name;
		const info = {name, number: card.localId, setName};
		const variants = Array.isArray(card.variants_detailed) ? card.variants_detailed : null;
		const twins = twinSlides(twinItem);

		twinDrawn = twinShown();
		document.title = `${name} | Card Tracker`;

		if (set.id) {
			back.href = BASE + routeTo('sets', lang, set.id);
			back.dataset.link = routeTo('sets', lang, set.id);

			if (!position || !position.label) {
				back.textContent = `‹ ${set.name || set.id}`;
			}
		}

		// The art beside the facts, at about 45 percent of the width, so the
		// facts, the price with Ver na Liga, and Your copies show without a
		// long scroll (plans/design-review.md section 3, "Card Detail").
		// replaceChildren prints a null argument as "null", so the optional
		// variants section is filtered out when there is none.
		body.replaceChildren(...[
			h('div', {class: 'card-hero'},
				h('div', {class: 'hero-art'}, photos.show({art: cardArt, info, official: cardImage(card.image, 'high'), twins})),
				h('div', {class: 'hero-facts'},
					h('h2', {lang: names.english ? null : htmlLang(nameLang())}, name),
					below ? h('p', {class: 'name-original', lang: htmlLang(nameLang())}, below) : null,
					h('dl', {class: 'facts'},
						row('Set', setName),
						row('Number', number),
						row('Rarity', card.rarity),
						row('Illustrator', card.illustrator),
						row('Catalog', languageLabel(lang))
					)
				)
			),
			twin.element,
			priceSlot,
			copies,
			variants && variants.length
				? h('section', {class: 'variants-section'},
					h('h3', null, 'Variants'),
					h('ul', {class: 'variants'}, variants.map((variant) => h('li', null, variantText(variant))))
				)
				: null,
		].filter(Boolean));
	}

	const copies = h('section', {class: 'copies', hidden: true});

	// The price, full width under the hero (js/price-view.js): the Liga price
	// the person typed in, with Ver na Liga, then the US and EU references.
	// It carries the one Ver na Liga button, and says why there is none for
	// Korean and Chinese prints.
	const priceSlot = h('div', {class: 'price-slot', id: 'card-price'});
	// The person's live copies of this card, and the Ver na Liga link once
	// known (null for none).
	let owned = [];
	let ownedKnown = false;
	let ligaHref = null;
	let priceKey = null;

	const copiesKey = (entries) => JSON.stringify(entries.map((entry) => [entry.id, entry.variant_id || null, entry.language, entry.price_manual || null]));

	// The copies' printed language, which picks the copies a Liga price is
	// saved to: the one language they share, else the catalog's when some
	// are in it, else any.
	function priceLanguage() {
		const languages = new Set(owned.map((entry) => entry.language));

		if (!languages.size) {
			return lang;
		}

		return languages.size === 1 ? [...languages][0] : languages.has(lang) ? lang : null;
	}

	// Redrawn when the card record, the copies, or the link change, but never
	// under a finger typing a price.
	function drawPrice() {
		// Drawn once the copies are read, so it never flashes "Add a copy"
		// on a card the person owns.
		if (!alive || !current || !ownedKnown) {
			return;
		}

		const key = [current, ligaHref, copiesKey(owned)];

		if (priceKey && priceKey[0] === key[0] && priceKey[1] === key[1] && priceKey[2] === key[2]) {
			return;
		}

		const typing = priceSlot.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';

		if (typing && priceKey && priceKey[0] === key[0] && priceKey[1] === key[1]) {
			return;
		}

		priceKey = key;
		priceSlot.replaceChildren(priceSection({
			card: current,
			entries: owned,
			language: priceLanguage(),
			ligaHref,
			onSaved: (entries) => {
				// The section already shows the saved price; only the copies
				// list below it needs the news.
				owned = entries;
				priceKey = [current, ligaHref, copiesKey(owned)];
			},
			recordLanguage: lang,
		}));
	}

	// Ver na Liga: a link to Liga Pokémon's own search, never a fetch from
	// it (DESIGN.md section 10). Liga matches the English name, so the link is
	// built from TCGdex's English record of the same card, and there is none
	// when that record or the set's official count is not available.
	function setLiga(href) {
		ligaHref = href || null;
		drawPrice();
	}

	let ligaRun = 0;

	function showLiga(english, card) {
		const set = english.set || card.set || {};
		const href = english.id === cardId
			? ligaUrl({
				localId: english.localId,
				name: english.name,
				official: set.cardCount && set.cardCount.official,
				setId: set.id,
				setName: set.name,
			})
			: null;

		setLiga(href);
	}

	// A Japanese print has its own Liga page under its English name and the
	// Japanese set's number and official total (DESIGN.md section 10,
	// "Languages on Liga"), so it gets the button once an English name is
	// found. Korean and Chinese prints, and a Japanese record shown for
	// Korean copies, get none: whether Liga lists them is unchecked.
	function showJapaneseLiga(card) {
		const set = card.set || {};
		const names = shownNames(card);
		const href = !source && names.english
			? ligaUrl({
				localId: card.localId,
				name: names.english,
				official: set.cardCount && set.cardCount.official,
				setId: set.id,
				setName: set.name,
			})
			: null;

		setLiga(href);
	}

	async function drawLiga(card) {
		const run = ++ligaRun;

		if (lang === 'ja') {
			showJapaneseLiga(card);

			return;
		}

		if (catalogFor(lang) !== 'international') {
			setLiga(null);

			return;
		}

		if (lang === 'en') {
			showLiga(card, card);

			return;
		}

		try {
			const {data} = await cardDetail('en', cardId, (fresh) => alive && run === ligaRun && showLiga(fresh, card));

			if (alive && run === ligaRun) {
				showLiga(data, card);
			}
		}
		catch {
			if (alive && run === ligaRun) {
				setLiga(null);
			}
		}
	}

	async function drawCopies(card, variants) {
		let mine;
		let record;

		try {
			const catalog = catalogFor(lang);
			const [owned, index] = await Promise.all([ownedIn(catalog), cardIndex()]);

			mine = owned.get(cardId);
			record = index.get(`${catalog}|${cardId}`) || null;
		}
		catch {
			ownedKnown = true;
			drawPrice();

			return;
		}

		if (!alive) {
			return;
		}

		const names = mine ? mine.entries.map((entry) => sourceNames(entry, record)) : [];
		const next = names.length && names.every(Boolean) ? {...names[0], language: mine.entries[0].language} : null;

		if ((next && next.name) !== (source && source.name) || (next && next.setName) !== (source && source.setName)) {
			source = next;
			render(card);
			drawLiga(card);
		}

		owned = mine ? mine.entries : [];
		ownedKnown = true;
		drawPrice();

		if (!mine) {
			copies.hidden = true;

			return;
		}

		const shownName = (source && source.name) || card.name;
		const flagged = (language) => flagBadge([language], {className: 'flags-inline'});
		const groups = new Map();

		for (const entry of mine.entries) {
			const variant = variants.find((item) => item.variantId && item.variantId === entry.variant_id);
			const finish = variant
				? variantText(variant)
				: entry.finish_raw
					? `${finishLabel(entry.finish_raw)} (from monprice, finish not matched)`
					: 'Finish not set';
			// Each copy's own name, when it differs from the one shown above.
			const localName = entry.name_local && entry.name_local !== shownName ? entry.name_local : null;
			// Its Liga price, when one is saved on it.
			const price = copyPriceText(entry);
			const key = `${entry.language}|${localName}|${finish}|${price}`;

			groups.set(key, {count: (groups.get(key) || {count: 0}).count + 1, finish, language: entry.language, localName, price});
		}

		copies.hidden = false;
		copies.replaceChildren(
			h('h3', null, `Your copies (${mine.total})`),
			h('ul', {class: 'variants'}, [...groups.values()].map((group) =>
				h('li', null,
					flagged(group.language),
					[languageLabel(group.language), group.localName, group.finish].filter(Boolean).join(' · ') + (group.count > 1 ? ` ×${group.count}` : ''),
					group.price ? h('span', {class: 'copy-price'}, group.price) : null
				)
			))
		);
	}

	async function load() {
		try {
			const {data} = await cardDetail(lang, cardId, (fresh) => alive && draw(fresh));

			if (alive) {
				draw(data);
			}
		}
		catch (err) {
			if (alive) {
				body.replaceChildren(loadFailure(err, 'This card', load));
			}
		}
	}

	root.append(h('div', {class: 'card-top'}, back, swipe.line), body, ...[swipe.element].filter(Boolean));
	load();
	// The twins saved on this phone load once a session; a card drawn before
	// they are in is drawn again only when its twin then shows something.
	loadTwins().then(() => twinChanged(null), () => {});

	// A copy added, removed, or priced elsewhere (or arriving with a sync)
	// redraws Your copies and the price.
	const stopWatching = onChange(() => {
		if (alive && current) {
			drawCopies(current, Array.isArray(current.variants_detailed) ? current.variants_detailed : []);
		}
	});

	return () => {
		alive = false;
		stopWatching();
		swipe.stop();
		twin.destroy();
		stopTwins();
		photos.destroy();
	};
}
