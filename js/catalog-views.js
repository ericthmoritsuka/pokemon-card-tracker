// Catalog browser: Sets, set detail, and card detail.

import {
	LANGUAGES,
	NotOnPhoneError,
	cardDetail,
	cardImage,
	compareNumbers,
	languageLabel,
	logoImage,
	setDetail,
	setList,
	setViewingLanguage,
	viewingLanguage,
} from './catalog.js';
import {BASE, errorText, h} from './dom.js';

// International prints share English card records (DESIGN.md section 3), so
// only these languages fall back to the English list of the same set.
const FALLS_BACK_TO_ENGLISH = new Set(['pt', 'fr']);

const cardsText = (n) => `${n} ${n === 1 ? 'card' : 'cards'}`;

const routeTo = (...parts) => parts.map((part) => encodeURIComponent(part)).join('/');

const link = (route, attrs, ...children) => h('a', {...attrs, 'data-link': route, href: BASE + route}, ...children);

// -------------------------------------------------------- card images

// The service worker may hold an opaque copy of an image, whose status it
// cannot read, so a failed image is dropped from the caches here, where the
// failure is known. The next view fetches it again.
const IMAGE_CACHES = ['card-tracker-images', 'card-tracker-images-opaque'];

function forgetImage(url) {
	if (!('caches' in window)) {
		return;
	}

	for (const name of IMAGE_CACHES) {
		caches.open(name).then((cache) => cache.delete(url)).catch(() => {});
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
		setName ? h('span', null, setName) : null,
		h('span', {class: 'card-back-status'}, imageStatus(missing))
	);
}

// Card art in the 63:88 card shape. It shimmers while the image loads and
// turns into the card-back tile if the image fails.
function cardArt(info, src, {eager = false} = {}) {
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
		alt: info.name,
		decoding: 'async',
		height: 88,
		loading: eager ? 'eager' : 'lazy',
		width: 63,
	});

	img.addEventListener('load', () => frame.classList.remove('loading'), {once: true});
	img.addEventListener('error', () => {
		forgetImage(src);
		frame.classList.remove('loading');
		frame.replaceChildren(cardBack(info, false));
	}, {once: true});
	img.src = src;
	frame.append(img);

	return frame;
}

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
		message = `${what} is not on this phone yet. Connect to the internet and open it once, and it will open offline after that.`;
	}
	else if (err && err.status) {
		message = `Could not load ${what.toLowerCase()}. ${err.message}`;
	}
	else {
		// A dropped connection, or an API error page without CORS headers.
		message = `Could not load ${what.toLowerCase()}. TCGdex, the card catalog, did not answer. Try again in a minute. (${errorText(err)})`;
	}

	return h('div', {class: 'notice', role: 'alert'},
		h('p', null, message),
		h('button', {type: 'button', onclick: retry}, 'Try again')
	);
}

// ------------------------------------------------------------ sets view

export function setsView(root) {
	let alive = true;
	let lang = viewingLanguage();
	let series = null;

	const select = h('select', {id: 'viewing', onchange: () => changeLanguage(select.value)},
		LANGUAGES.map(({code, label}) => h('option', {selected: code === lang, value: code}, label))
	);
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

		return link(routeTo('sets', lang, set.id), {class: 'set-tile'},
			logo,
			h('span', {class: 'set-name'}, set.name),
			h('span', {class: 'set-meta'}, set.id, typeof total === 'number' ? ` · ${cardsText(total)}` : '')
		);
	}

	function draw() {
		if (!series) {
			return;
		}

		const query = search.value.trim().toLowerCase();
		const matches = (set) => !query || set.name.toLowerCase().includes(query) || set.id.toLowerCase().includes(query);
		const groups = series
			.map((serie) => ({...serie, sets: serie.sets.filter(matches)}))
			.filter((serie) => serie.sets.length);

		const children = groups.map((serie) =>
			h('section', {class: 'serie'},
				h('h3', null, serie.name),
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
			h('label', {class: 'viewing', for: 'viewing'}, h('span', null, 'Viewing:'), h('span', {class: 'select-wrap'}, select)),
			search
		),
		list
	);

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
	const grid = h('div', {class: 'card-grid'});

	function draw(set, cards, cardLang) {
		const total = set.cardCount && (set.cardCount.total ?? set.cardCount.official);

		title.textContent = set.name;
		document.title = `${set.name} | Card Tracker`;
		meta.textContent = [set.id, set.serie && set.serie.name, typeof total === 'number' ? cardsText(total) : null, languageLabel(lang)]
			.filter(Boolean)
			.join(' · ');

		if (!cards.length) {
			grid.replaceChildren(h('p', {class: 'muted'}, `TCGdex lists no cards for this set in ${languageLabel(lang)}.`));

			return;
		}

		const sorted = [...cards].sort((a, b) => compareNumbers(a.localId, b.localId));

		grid.replaceChildren(
			...sorted.map((card) => {
				const info = {name: card.name, number: card.localId, setName: set.name};

				return link(routeTo('cards', cardLang, card.id), {class: 'tile'},
					cardArt(info, cardImage(card.image, 'low')),
					h('span', {class: 'tile-name'}, card.name),
					h('span', {class: 'tile-meta'}, `#${card.localId}`)
				);
			})
		);
	}

	async function load() {
		note.hidden = true;
		grid.replaceChildren(...skeletonTiles(12));

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
				grid.replaceChildren(loadFailure(err, 'This set', load));
			}
		}
	}

	root.append(back, title, meta, note, grid);
	load();

	return () => {
		alive = false;
	};
}

// ----------------------------------------------------- card detail view

const VARIANT_TYPES = {holo: 'Holo', normal: 'Normal', reverse: 'Reverse holo'};
const FOILS = {masterball: 'Master Ball pattern', pokeball: 'Poké Ball pattern'};
const STAMPS = {'1st-edition': '1st Edition stamp'};

const sentence = (text) => {
	// "1999-2000-copyright" becomes "1999-2000 copyright".
	const words = String(text).replace(/_+/g, ' ').replace(/-(?=\D)|(?<=\D)-/g, ' ');

	return words.charAt(0).toUpperCase() + words.slice(1);
};

function variantText(variant) {
	const parts = [VARIANT_TYPES[variant.type] || sentence(variant.type || 'Unknown')];

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

	const back = link('sets', {class: 'back'}, '‹ Back');
	const body = h('div', {class: 'card-detail'},
		h('div', {class: 'art loading big-art', 'aria-hidden': 'true'})
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

	function draw(card) {
		const set = card.set || {};
		const official = set.cardCount && set.cardCount.official;
		const number = official ? `${card.localId} / ${official}` : card.localId;
		const info = {name: card.name, number: card.localId, setName: set.name};
		const variants = Array.isArray(card.variants_detailed) ? card.variants_detailed : null;

		document.title = `${card.name} | Card Tracker`;

		if (set.id) {
			back.href = BASE + routeTo('sets', lang, set.id);
			back.dataset.link = routeTo('sets', lang, set.id);
			back.textContent = `‹ ${set.name || set.id}`;
		}

		body.replaceChildren(
			h('div', {class: 'big-art'}, cardArt(info, cardImage(card.image, 'high'), {eager: true})),
			h('div', null,
				h('h2', null, card.name),
				h('dl', {class: 'facts'},
					row('Set', set.name),
					row('Number', number),
					row('Rarity', card.rarity),
					row('Illustrator', card.illustrator),
					row('Catalog', languageLabel(lang))
				),
				variants && variants.length
					? h('section', null,
						h('h3', null, 'Variants'),
						h('ul', {class: 'variants'}, variants.map((variant) => h('li', null, variantText(variant))))
					)
					: null
			)
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

	root.append(back, body);
	load();

	return () => {
		alive = false;
	};
}
