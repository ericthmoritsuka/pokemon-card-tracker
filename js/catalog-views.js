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
	savedCardRecords,
	setDetail,
	setList,
	setViewingLanguage,
	viewingLanguage,
} from './catalog.js';
import {speciesNames} from './checklists.js';
import {onChange, ownedBySet, ownedIn, sourceNames, updateCards} from './collection.js';
import {alikeKey, closeCopySheet, copyPlaces, copyStepper, languageName, openAddSheet, openEditSheet, placeText} from './copy-sheet.js';
import {cardPosition, cardSwipe, offerCardList} from './card-swipe.js';
import {BASE, errorText, h, segmentCounts} from './dom.js';
import {flagBadge} from './flags.js';
import {ligaUrl} from './liga.js';
import {finishLabel} from './monprice.js';
import {cardNames, hasOwnNames} from './names.js';
import {copyPriceText, priceSection, statsBar} from './price-view.js';
import {cardArt, cardTile, forgetImage, groupFinish} from './tile.js';
import {cardPhotos} from './photos/index.js';
import {loadTwins, onTwinsChange, twinKey, twinName, twinSlides} from './twins.js';
import {twinConfirm} from './twins-view.js';
import {plainVariantId} from './scan/finish.js';
import {lensMember, toast} from './shell.js';
import {memberCards, memberDocumentKept, whenMemberName} from './family.js';
import {addToWishlist, listWishlist} from './wishlist.js';
import {isCustomId} from './custom-card.js';
import {customCardView} from './custom-card-view.js';

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

// ------------------------------------------------- a family member's cards
//
// While a family member's lens is on (js/shell.js), Sets, a set, and a card
// show that member's copies, read from their document (js/family.js), and
// no control that would change anything (plans/design-review.md, "Family
// Read-Only Mode").

// The member's name for headings, once known.
function memberLabel(member) {
	const now = lensMember();

	return (now && now.userId === member.userId && now.name) || member.name || 'Family member';
}

// Owned copies for one catalog by card ID, as js/collection.js ownedIn
// gives yours, over the member's copies.
function ownedFrom(entries, catalog) {
	const owned = new Map();

	for (const entry of entries) {
		if (entry.catalog !== catalog) {
			continue;
		}

		if (!owned.has(entry.card_id)) {
			owned.set(entry.card_id, {byLanguage: new Map(), entries: [], total: 0});
		}

		const item = owned.get(entry.card_id);

		item.total++;
		item.entries.push(entry);
		item.byLanguage.set(entry.language, (item.byLanguage.get(entry.language) || 0) + 1);
	}

	return owned;
}

// Distinct cards owned by "<catalog>|<set id>", as js/collection.js
// ownedBySet gives yours. A card this phone's index has no record of counts
// under the set its ID begins with (TCGdex IDs are <set id>-<number>).
async function ownedBySetFrom(entries) {
	const index = await cardIndex().catch(() => new Map());
	const sets = new Map();

	for (const entry of entries) {
		const record = index.get(`${entry.catalog}|${entry.card_id}`);
		const cut = String(entry.card_id || '').lastIndexOf('-');
		const setId = record ? record.set_id : cut > 0 ? entry.card_id.slice(0, cut) : null;

		if (!setId) {
			continue;
		}

		const key = `${entry.catalog}|${setId}`;

		if (!sets.has(key)) {
			sets.set(key, new Set());
		}

		sets.get(key).add(entry.card_id);
	}

	return sets;
}

// Why a member's cards are not shown, for a notice.
const memberProblem = (member, err) => `${memberLabel(member)}'s cards could not be read. ${err && err.message ? err.message : errorText(err)}`;

// A member's photos of a card, read only (no Add photo, no Use as main
// image): js/photos/index.js cardPhotos over their copies, made again once
// those are read (setEntries). Shaped like cardPhotos for cardView.
function memberPhotos(cardId, catalog) {
	let block = cardPhotos({cardId, catalog, entries: [], readOnly: true});
	let shown = {};
	let key = '';

	return {
		destroy: () => block.destroy(),
		// True when the copies changed and the block was made again.
		setEntries(entries) {
			const next = JSON.stringify(entries.map((entry) => [entry.id, entry.main_image || null, entry.photos || []]));

			if (next === key) {
				return false;
			}

			key = next;
			block.destroy();
			block = cardPhotos({cardId, catalog, entries, readOnly: true});

			return true;
		},
		show(next = {}) {
			shown = {...shown, ...next};

			return block.show(shown);
		},
	};
}

// A member's price section: what they saved and the market prices, but no
// way to type a Liga price. Its form and Update button are taken out each
// time it draws, and the line inviting you to add a copy says whose it is.
function readOnlyPrice(section, member) {
	const strip = () => {
		for (const control of section.querySelectorAll('form, .price-edit')) {
			control.remove();
		}

		for (const line of section.querySelectorAll('.price-liga .price-none:not([data-member])')) {
			line.dataset.member = 'true';
			line.textContent = `No Liga price saved by ${memberLabel(member)}.`;
		}
	};

	strip();
	new MutationObserver(strip).observe(section, {childList: true, subtree: true});

	return section;
}

export function setsView(root) {
	let alive = true;
	let lang = viewingLanguage();
	let series = null;
	let owned = new Map();
	// A family member's rings while their lens is on.
	const member = lensMember();
	const memberNote = h('div', {hidden: true, id: 'sets-member-note'});

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
		const name = h('span', {class: 'set-name'}, set.name);
		// Without a logo the name stands in for it, large, and is not said
		// again underneath (Q-12).
		const noLogo = () => {
			logo.replaceChildren(h('span', {class: 'logo-text'}, set.name));
			name.hidden = true;
		};

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
			name,
			h('span', {class: 'set-foot'}, h('span', {class: 'set-meta'}, set.id), progress)
		);
	}

	function draw() {
		if (!series) {
			return;
		}

		const query = search.value.trim().toLowerCase();
		const matches = (set) => !query || set.name.toLowerCase().includes(query) || set.id.toLowerCase().includes(query) || (set.code && set.code.toLowerCase().includes(query));
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
			children.unshift(
				h('div', {class: 'notice'},
					h('p', null, 'Korean sets in this catalog end at the SV5 era. Your Korean copies of newer cards, from Scarlet & Violet on (such as M4 and M6), live under the Japanese sets, which have the same set codes, and show there as "Owned in KO".'),
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
		memberNote,
		list
	);

	(member ? memberCards(member.userId).then(ownedBySetFrom) : ownedBySet())
		.then((sets) => {
			owned = sets;

			if (alive) {
				draw();
			}
		})
		.catch((err) => {
			// Rings stay at zero; for a member, the notice says why.
			if (alive && member) {
				memberNote.className = 'notice';
				memberNote.replaceChildren(h('p', null, memberProblem(member, err)));
				memberNote.hidden = false;
			}
		});

	load();

	return () => {
		alive = false;
	};
}

// ------------------------------------------------------ set detail view

export function setView(root, {lang, setId}) {
	let alive = true;
	// A family member's copies while their lens is on.
	const member = lensMember();

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
			stats.replaceChildren(statsBar({cardsById: records, entries, label: `${member ? `${memberLabel(member)}'s` : 'your'} cards from ${set.name}`}));
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
			h('span', {'data-label': label}, label)
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
		segmentCounts(filter, {all: sorted.length, missing: sorted.length - have, owned: have});
		drawStats(set, sorted).catch(() => {
			// No statistics this time; the set itself is unaffected.
		});

		const visible = sorted.filter((card) => show === 'all' || (show === 'owned') === owned.has(card.id));

		if (!visible.length) {
			const none = member ? `${memberLabel(member)} has no cards from this set.` : 'No cards from this set are saved yet.';

			grid.replaceChildren(h('p', {class: 'muted grid-wide'}, show === 'owned' ? none : 'Every card in this set is owned.'));
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
			owned = member ? ownedFrom(await memberCards(member.userId), catalogFor(lang)) : await ownedIn(catalogFor(lang));
		}
		catch (err) {
			owned = new Map();

			if (member && alive) {
				problem.replaceChildren(h('div', {class: 'notice', id: 'set-member-note'}, h('p', null, memberProblem(member, err))));
			}
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

// TCGdex writes some Portuguese records' variant fields in Portuguese
// ("Padrão", "Poké Bola", "Logo da coleção") where the English record of the
// same variantId has its English value (checked against TCGdex on
// 2026-10-02, sv03.5-001 and sv08.5-001). Known words are read as the English
// value, so finishes are named as on English pages; the standard size is
// never named at all.
const TCGDEX_WORDS = {
	foil: {'master bola': 'masterball', 'poké bola': 'pokeball', 'poke bola': 'pokeball'},
	size: {padrão: 'standard', padrao: 'standard'},
	stamp: {'logo da coleção': 'set-logo', 'logo da colecao': 'set-logo'},
};

const inEnglish = (kind, value) => TCGDEX_WORDS[kind][String(value).trim().toLowerCase()] || value;

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
		const foil = inEnglish('foil', variant.foil);

		parts.push(FOILS[foil] || `${sentence(foil)} foil`);
	}

	for (const raw of variant.stamp || []) {
		const stamp = inEnglish('stamp', raw);

		parts.push(STAMPS[stamp] || `${sentence(stamp)} stamp`);
	}

	const size = variant.size ? inEnglish('size', variant.size) : null;

	if (size && String(size).toLowerCase() !== 'standard') {
		parts.push(sentence(size));
	}

	return parts.join(', ');
}

// The finish select's options for a card: each variant TCGdex gives an ID.
const finishChoices = (variants) => variants
	.filter((variant) => variant && variant.variantId)
	.map((variant) => ({label: variantText(variant), value: variant.variantId}));

export function cardView(root, {lang, cardId}) {
	// A hand-made card has no catalog record: its own page
	// (js/custom-card-view.js), told by its id ("hand_...").
	if (isCustomId(cardId)) {
		return customCardView(root, {cardId});
	}

	let alive = true;

	// Opened from a list, the card keeps it: a position line, edge arrows,
	// and swiping move through it (js/card-swipe.js).
	const route = routeTo('cards', lang, cardId);
	const position = cardPosition(route);
	const swipe = cardSwipe(root, route);
	// A family member's card is read only and shows their copies: no copy
	// sheets, no Add, no photos to add or pin, no Liga form, no wishlist
	// button (plans/design-review.md, "Family Read-Only Mode").
	const member = lensMember();
	const photos = member ? memberPhotos(cardId, catalogFor(lang)) : cardPhotos({cardId, catalog: catalogFor(lang)});
	// A Japanese print's international twin: its image joins the carousel,
	// its English name leads for a Trainer or Energy, and the picker asks
	// when the matcher was unsure (js/twins.js, js/twins-view.js).
	const twinItem = {card_id: cardId, catalog: catalogFor(lang)};
	const twin = twinConfirm({cardId, catalog: catalogFor(lang)});
	const twinShown = () => JSON.stringify([twinSlides(twinItem), twinName(twinItem)]);
	let twinDrawn = null;
	const twinChanged = (key) => alive && current && (!key || key === twinKey(twinItem)) && twinShown() !== twinDrawn && draw(current);
	const stopTwins = onTwinsChange(twinChanged);
	const readOnly = Boolean(member);
	// Whose copies the section names.
	const whose = () => (member ? `${memberLabel(member)}'s` : 'Your');
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

	// The catalog's error while card detail shows what the phone knows
	// instead (Q-07), else null.
	let unreachable = null;

	function draw(card, failure = null) {
		current = card;
		unreachable = failure;
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

		// The art beside the facts, at about 45 percent of the width, then
		// Your copies and Ver na Liga, so all of them are on the first screen
		// at 360 x 740; the Liga price form and the US and EU markets come
		// after (plans/design-review.md section 3, "Card Detail"; Q-04).
		// replaceChildren prints a null argument as "null", so the optional
		// sections are filtered out when there are none.
		body.replaceChildren(...[
			unreachable ? unreachableNotice(unreachable) : null,
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
			copies,
			ligaRow,
			priceSlot,
			variants && variants.length
				? h('section', {class: 'variants-section'},
					h('h3', null, 'Variants'),
					h('ul', {class: 'variants'}, variants.map((variant) => h('li', null, variantText(variant))))
				)
				: null,
		].filter(Boolean));
	}

	// Shown while TCGdex fails: what follows is the phone's saved record.
	function unreachableNotice(err) {
		return h('div', {class: 'notice card-unreachable', id: 'card-unreachable', role: 'status'},
			h('div', {class: 'card-unreachable-text'},
				h('p', null, 'The card catalog is not answering. This is what the phone has saved.'),
				h('p', {class: 'card-unreachable-why'}, err && err.message ? err.message : errorText(err))
			),
			h('button', {class: 'small', id: 'card-retry', onclick: load, type: 'button'}, 'Try again')
		);
	}

	const copies = h('section', {'aria-labelledby': 'copies-title', class: 'copies', hidden: true});

	// Ver na Liga, or why there is none, right under Your copies, with Add
	// to wishlist beside it.
	const ligaRow = h('div', {class: 'card-liga', hidden: true, id: 'card-liga'});

	// The price, full width under Ver na Liga (js/price-view.js): the Liga
	// price the person typed in and its form, then the US and EU references.
	// The section draws its own Ver na Liga too; css/copies.css hides that
	// one on card detail, where the button above stands for it.
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

		const section = priceSection({
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
			// Nothing of a family member's is ever saved from here.
			save: readOnly ? () => Promise.reject(new Error('A family member\'s cards are view only.')) : undefined,
		});

		priceSlot.replaceChildren(readOnly ? readOnlyPrice(section, member) : section);
	}

	// Ver na Liga: a link to Liga Pokémon's own search, never a fetch from
	// it (DESIGN.md section 10). Liga matches the English name, so the link is
	// built from TCGdex's English record of the same card, and there is none
	// when that record or the set's official count is not available.
	function setLiga(href) {
		ligaHref = href || null;
		drawPrice();
		drawLigaRow();
	}

	// The wishlist item for this card, any language or finish, once read;
	// undefined until then.
	let wished;
	let wishing = false;

	function ligaControl() {
		if (ligaHref) {
			return h('a', {class: 'button primary liga-link', href: ligaHref, id: 'card-liga-link', rel: 'noopener noreferrer', target: '_blank'},
				'Ver na Liga',
				h('span', {'aria-hidden': 'true', class: 'liga-out'}, ' ↗'),
				h('span', {class: 'copies-sr'}, ' (opens Liga Pokémon)')
			);
		}

		const language = priceLanguage();
		const asian = ['ko', 'zh-cn', 'zh-tw'].includes(language);

		return h('p', {class: 'muted liga-none', id: 'card-liga-none'}, asian ? `No Liga link for ${languageLabel(language)} prints.` : 'No Liga link for this card.');
	}

	function wishControl() {
		if (readOnly || wished === undefined) {
			return null;
		}

		if (wished) {
			// Short enough for half the row at 360 px; the language is in the
			// label and the tooltip.
			const which = wished.language ? ` in ${languageName(wished.language)}` : '';

			return link('wishlist', {'aria-label': `On your wishlist${which}. Open the wishlist`, class: 'button wish-on', id: 'card-wished', title: `On your wishlist${which}`},
				h('span', {'aria-hidden': 'true', class: 'wish-check'}, '✓ '),
				'On your wishlist'
			);
		}

		return h('button', {class: 'wish-add', disabled: wishing, id: 'card-wish', onclick: wish, type: 'button'}, 'Add to wishlist');
	}

	async function wish() {
		wishing = true;
		drawLigaRow();

		try {
			wished = await addToWishlist(cardId, {catalog: catalogFor(lang), language: lang});
			toast(`Added to your wishlist (${languageName(lang)}).`);
		}
		catch (err) {
			toast(`Not added to the wishlist. ${errorText(err)}`);
		}
		finally {
			wishing = false;
			drawLigaRow();
		}
	}

	async function readWish() {
		try {
			const catalog = catalogFor(lang);
			const items = await listWishlist();

			wished = items.find((item) => item.card_id === cardId && (item.catalog || 'international') === catalog) || null;
		}
		catch {
			wished = null;
		}

		drawLigaRow();
	}

	// Drawn once the copies are read, like the price, so a Korean copy on a
	// Japanese record never flashes the Japanese button.
	function drawLigaRow() {
		if (!alive || !current || !ownedKnown) {
			return;
		}

		ligaRow.replaceChildren(...[ligaControl(), wishControl()].filter(Boolean));
		ligaRow.hidden = false;
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
	// Korean copies, get none: whether Liga lists them is unchecked. That
	// holds for a Korean copy the scanner saved with no Korean name as much
	// as for an imported one (Q-30): what counts is the copies' language.
	function showJapaneseLiga(card) {
		const set = card.set || {};
		const names = shownNames(card);
		const href = !source && priceLanguage() === 'ja' && names.english
			? ligaUrl({
				catalog: 'ja',
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

	// What one copy's finish is called on its row.
	function finishName(entry, variants) {
		const variant = variants.find((item) => item.variantId && item.variantId === entry.variant_id);

		if (variant) {
			return variantText(variant);
		}

		if (entry.variant_id && unreachable) {
			return 'Finish (catalog offline)';
		}

		return entry.finish_raw
			? `${finishLabel(entry.finish_raw)} (from monprice, finish not matched)`
			: 'Finish not set';
	}

	// The name and number the sheets show under their title.
	function sheetCard(card) {
		const set = card.set || {};
		const official = set.cardCount && set.cardCount.official;

		return {
			id: cardId,
			name: mainName(shownNames(card)),
			number: card.localId ? (official ? `${card.localId} / ${official}` : card.localId) : null,
		};
	}

	function addButton(card, variants) {
		return h('button', {class: 'small copy-add', id: 'copy-add', onclick: () => openAddSheet({
			card: sheetCard(card),
			catalog: catalogFor(lang),
			finishes: finishChoices(variants),
			lang,
			plain: plainVariantId(variants),
		}), type: 'button'}, 'Add a copy');
	}

	// Tick the collections these copies are in (js/collections-view.js, read
	// when the button is tapped, so card detail loads without it).
	function collectButton(live, shownName) {
		return h('button', {'aria-haspopup': 'dialog', class: 'small col-add', id: 'copies-collect', onclick: () => {
			import('./collections-view.js')
				.then((view) => view.openCollectionsSheet({entries: live, name: shownName}))
				.catch((err) => toast(`Collections did not open. ${errorText(err)}`));
		}, type: 'button'}, 'Add to collection');
	}

	let copiesRun = 0;

	async function drawCopies(card, variants) {
		const run = ++copiesRun;
		let mine;
		let record;
		let placed = new Map();

		// A family member's document: their copies and their binders.
		let memberDoc = null;

		try {
			const catalog = catalogFor(lang);

			memberDoc = member ? await memberDocumentKept(member.userId) : null;

			const memberLive = memberDoc ? (memberDoc.cards || []).filter((entry) => entry && !entry.deleted_at) : null;
			const [owned, index] = await Promise.all([memberLive ? ownedFrom(memberLive, catalog) : ownedIn(catalog), cardIndex()]);

			mine = owned.get(cardId);
			record = index.get(`${catalog}|${cardId}`) || null;
		}
		catch (err) {
			ownedKnown = true;
			drawPrice();
			drawLigaRow();

			if (member && alive && run === copiesRun) {
				copies.hidden = false;
				copies.replaceChildren(h('p', {class: 'muted', id: 'copies-member-note'}, memberProblem(member, err)));
			}

			return;
		}

		try {
			placed = await copyPlaces(memberDoc ? memberDoc.binders || [] : null);
		}
		catch {
			// No binder places this time; the copies still show.
		}

		if (!alive || run !== copiesRun) {
			return;
		}

		// The member's photos of their copies join the carousel.
		if (member && photos.setEntries(mine ? mine.entries : [])) {
			render(card);
		}

		const live = mine ? mine.entries : [];
		const names = live.map((entry) => sourceNames(entry, record));
		const next = names.length && names.every(Boolean) ? {...names[0], language: live[0].language} : null;

		if ((next && next.name) !== (source && source.name) || (next && next.setName) !== (source && source.setName)) {
			source = next;
			render(card);
			drawLiga(card);
		}

		owned = live;
		ownedKnown = true;
		drawPrice();

		// Which language decides the Japanese button can change with the
		// copies (Q-30).
		if (lang === 'ja') {
			showJapaneseLiga(card);
		}
		else {
			drawLigaRow();
		}

		// Your wishlist button is not offered on a member's card.
		if (!readOnly) {
			readWish();
		}

		if (!live.length) {
			// A member's card says so; yours offers Add.
			copies.hidden = false;
			copies.replaceChildren(h('div', {class: 'copies-head'},
				h('h3', {id: 'copies-title'}, member ? `Not in ${memberLabel(member)}'s cards` : 'Not in your cards'),
				readOnly ? null : addButton(card, variants)
			));

			return;
		}

		const shownName = (source && source.name) || card.name;
		const flagged = (language) => flagBadge([language], {className: 'flags-inline'});
		const groups = new Map();

		// One row per set of alike copies (same language, finish, and
		// condition; js/copy-sheet.js alikeKey), so its stepper counts them.
		for (const entry of live) {
			const key = alikeKey(entry);
			const group = groups.get(key) || {condition: entry.condition || null, entries: [], finish: finishName(entry, variants), language: entry.language, localNames: new Set(), notes: new Set(), prices: new Set()};

			// Each copy's own name, when it differs from the one shown above.
			if (entry.name_local && entry.name_local !== shownName) {
				group.localNames.add(entry.name_local);
			}

			// Its Liga price, when one is saved on it, and its note.
			if (copyPriceText(entry)) {
				group.prices.add(copyPriceText(entry));
			}

			if (entry.notes) {
				group.notes.add(entry.notes);
			}

			group.entries.push(entry);
			groups.set(key, group);
		}

		// The words of a row. Read only, the language and the count are in
		// them. With a stepper, the stepper shows the count, and the flag
		// alone names the language (its label and tooltip say it in words),
		// so the row stays two lines at most at 360 px.
		const rowContent = (group) => [
			flagged(group.language),
			h('span', {class: 'copy-text'},
				[readOnly ? languageName(group.language) : null, ...group.localNames, group.finish, group.condition].filter(Boolean).join(' · ') + (readOnly && group.entries.length > 1 ? ` ×${group.entries.length}` : '')
			),
			...[...group.prices].map((price) => h('span', {class: 'copy-price'}, price)),
			...group.entries.filter((entry) => placed.has(entry.id)).map((entry) => h('span', {class: 'copy-place'}, placeText(placed.get(entry.id)))),
			...[...group.notes].map((note) => h('span', {class: 'copy-note'}, note)),
		];

		const rowLabel = (group) => [languageName(group.language), group.finish, group.condition].filter(Boolean).join(', ');

		// A redraw (after a step, a sync) keeps the focus on the same control
		// of the same row, so a thumb or a screen reader stays where it was.
		const focused = copies.contains(document.activeElement) ? document.activeElement : null;
		const focusRow = focused && focused.closest('[data-alike]') ? focused.closest('[data-alike]').dataset.alike : null;
		const focusClass = focused ? ['step-less', 'step-more', 'step-count', 'copy-row'].find((name) => focused.classList.contains(name)) : null;

		copies.hidden = false;
		copies.replaceChildren(
			h('div', {class: 'copies-head'},
				h('h3', {id: 'copies-title'}, `${whose()} copies (${live.length})`),
				favoriteControl(live),
				readOnly ? null : addButton(card, variants)
			),
			h('ul', {class: readOnly ? 'variants copy-rows' : 'variants copy-rows editable'}, [...groups.values()].map((group) =>
				readOnly
					? h('li', null, rowContent(group))
					: h('li', {class: 'copy-line', 'data-alike': alikeKey(group.entries[0])},
						h('button', {
							'aria-haspopup': 'dialog',
							class: 'copy-row',
							onclick: () => openEditSheet({
								card: sheetCard(card),
								catalog: catalogFor(lang),
								entries: group.entries,
								finishes: finishChoices(variants),
								places: placed,
							}),
							type: 'button',
						}, rowContent(group)),
						copyStepper({entries: group.entries, label: rowLabel(group), places: placed}).element
					)
			)),
			// Under the rows, so the copies stay on the first screen.
			readOnly ? null : h('div', {class: 'copies-collect-row'}, collectButton(live, shownName))
		);

		if (focusRow && focusClass) {
			const row = [...copies.querySelectorAll('[data-alike]')].find((item) => item.dataset.alike === focusRow);
			const target = row && row.querySelector(`.${focusClass}`);

			if (target && !target.disabled) {
				target.focus({preventScroll: true});
			}
		}
	}

	// The star: the card is a favorite when any copy is, in any language.
	// Yours toggles all your copies of it (is_favorite on each, so a copy
	// kept apart on another phone merges field by field); a member's card
	// shows their star and nothing to press.
	function favoriteControl(live) {
		const on = live.some((entry) => entry.is_favorite === true);

		if (readOnly) {
			return on ? h('span', {class: 'favorite-mark', id: 'favorite-mark'}, '★ Favorite') : null;
		}

		return h('button', {
			'aria-label': 'Favorite',
			'aria-pressed': String(on),
			class: 'small favorite-toggle',
			id: 'favorite-toggle',
			onclick: () => updateCards(live.map((entry) => ({id: entry.id, patch: {is_favorite: !on}}))).catch(() => {}),
			title: on ? 'Remove from favorites' : 'Mark as a favorite',
			type: 'button',
		}, on ? '★' : '☆');
	}

	// What the phone knows about the card while TCGdex fails (Q-07): the
	// card index record My Cards keeps for owned cards, and any full record
	// saved in another language (an English record for a Portuguese copy),
	// shaped like a TCGdex card. Null when the phone knows nothing.
	async function knownCard() {
		const catalog = catalogFor(lang);
		const [index, owned] = await Promise.all([cardIndex().catch(() => new Map()), ownedIn(catalog).catch(() => new Map())]);
		const record = index.get(`${catalog}|${cardId}`) || null;
		const entries = (owned.get(cardId) || {entries: []}).entries;
		const saved = (await savedCardRecords(entries.length ? entries : [{card_id: cardId, catalog, language: lang}]).catch(() => new Map())).get(`${catalog}|${cardId}`) || null;

		if (!record && !saved && !entries.length) {
			return null;
		}

		const localizations = (record && record.localizations) || {};
		const local = localizations[lang] || Object.values(localizations)[0] || {};
		const base = saved || {};
		const set = base.set || {};
		const official = (set.cardCount && set.cardCount.official) || (record && record.official) || null;

		return {
			...base,
			id: cardId,
			image: local.image || base.image || null,
			localId: base.localId || (record && record.collector_number) || cardId,
			name: local.name || base.name || cardId,
			set: {
				...set,
				cardCount: official ? {...(set.cardCount || {}), official} : set.cardCount,
				id: set.id || (record && record.set_id) || null,
				name: local.set_name || set.name || (record && record.set_id) || null,
			},
			variants_detailed: Array.isArray(base.variants_detailed) ? base.variants_detailed : [],
		};
	}

	async function load() {
		try {
			const {data} = await cardDetail(lang, cardId, (fresh) => alive && draw(fresh));

			if (alive) {
				draw(data);
			}
		}
		catch (err) {
			if (!alive) {
				return;
			}

			const known = await knownCard().catch(() => null);

			if (!alive) {
				return;
			}

			if (known) {
				draw(known, err);
			}
			else {
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
	const redrawCopies = () => {
		if (alive && current) {
			drawCopies(current, Array.isArray(current.variants_detailed) ? current.variants_detailed : []);
		}
	};
	const stopWatching = onChange(redrawCopies);

	// A member's name can arrive after the first draw.
	if (member && !member.name) {
		whenMemberName(member.userId, redrawCopies);
	}

	return () => {
		alive = false;
		stopWatching();
		swipe.stop();
		twin.destroy();
		stopTwins();
		closeCopySheet();
		photos.destroy();
	};
}
