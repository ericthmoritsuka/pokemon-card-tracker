// Lists: the Pokémon checklists (js/checklists.js). Two screens, each also
// shown read only for a family member:
//   lists                         the person's checklists, with progress
//   lists/<id>                    one checklist in Dex order
//   family/<userId>/lists[/<id>]  a family member's, view only
//
// js/shell.js draws the view-only strip and the "Mine" switcher; the Lists
// tab's Checklists | Wishlist switch is dom.js listsSwitch().

import {currentUser} from './auth.js';
import {offerCardList} from './card-swipe.js';
import {cardImage, catalogFor, catalogLanguage, importApi, isLanguage, viewingLanguage} from './catalog.js';
import {mainName, tileNames} from './catalog-views.js';
import {isLive, listCards, onChange} from './collection.js';
import {BASE, errorText, go, h, listsSwitch, showError} from './dom.js';
import {whenMemberName} from './family.js';
import {cardNames, hasOwnNames, searchKey, speciesSearchTerms} from './names.js';
import {memberDocument} from './sync.js';
import {cardTile, groupFinish} from './tile.js';
import {
	MAX_DEX,
	REGIONS,
	checklistDex,
	createChecklist,
	deleteChecklist,
	dexLabel,
	handTicks,
	isChecklist,
	listChecklists,
	nameOf,
	ownedCards,
	speciesNames,
	progress,
	regionById,
	renameChecklist,
	resolveOwned,
	setDexList,
	setHandTick,
	spriteUrl,
} from './checklists.js';

// The same order as a set's segments, everywhere: All, Owned, Missing.
const FILTERS = [
	{label: 'All', value: 'all'},
	{label: 'Owned', value: 'owned'},
	{label: 'Missing', value: 'missing'},
];

const FILTER_KEY = 'cardTracker.checklistFilter';

const formatCount = (n) => Number(n).toLocaleString('en-US');

const plural = (n, one, many) => `${formatCount(n)} ${n === 1 ? one : many}`;

const link = (route, attrs, ...children) => h('a', {...attrs, 'data-link': route, href: BASE + route}, ...children);

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

// ------------------------------------------------------- whose lists

// The signed-in person's own lists, read from the phone.
const MINE = {
	base: 'lists',
	load: async () => {
		const [goals, entries] = await Promise.all([listChecklists(), listCards()]);

		return {entries, goals};
	},
	readOnly: false,
	watch: (reload) => onChange(reload),
};

// A family member's lists, read from the server once per screen. Viewing
// them changes nothing on this phone.
function familySource(userId) {
	let docPromise = null;

	return {
		base: `family/${encodeURIComponent(userId)}/lists`,
		load: async () => {
			if (!currentUser()) {
				throw new Error('Sign in to see your family\'s lists.');
			}

			if (!navigator.onLine) {
				throw new Error('A family member\'s lists show when you are online.');
			}

			docPromise = docPromise || memberDocument(userId).catch((err) => {
				docPromise = null;

				throw err;
			});

			const doc = (await docPromise) || {};

			return {
				entries: (doc.cards || []).filter(isLive),
				goals: (doc.goals || []).filter((goal) => isLive(goal) && isChecklist(goal)),
			};
		},
		readOnly: true,
		userId,
		watch: null,
	};
}

// ----------------------------------------------------- shared pieces

// The ring always comes with its "12 / 151" text, never alone.
function progressBadge({ticked, total, byHand}) {
	const percent = total ? Math.min(100, Math.round((ticked / total) * 100)) : 0;
	const label = `${ticked} of ${total} ticked${byHand ? `, ${byHand} of them by hand` : ''}`;

	return h('span', {'aria-label': label, class: ticked ? 'owned-count owned' : 'owned-count', role: 'img'},
		h('span', {'aria-hidden': 'true', class: 'ring', style: `--p: ${percent}`}),
		h('span', {'aria-hidden': 'true'}, `${ticked} / ${total}`)
	);
}

function describe(goal) {
	const dex = checklistDex(goal);

	if (goal.kind === 'region') {
		const region = regionById(goal.target);

		return region ? `${region.name} · ${dexLabel(region.first)} to ${dexLabel(region.last)}` : 'Region';
	}

	if (goal.kind === 'every_pokemon') {
		return `National Dex · ${dexLabel(1)} to ${dexLabel(MAX_DEX)}`;
	}

	return `Your pick · ${plural(dex.length, 'Pokémon', 'Pokémon')}`;
}

// What resolving the owned cards is doing, for the status line.
function progressText(step) {
	if (!step) {
		return '';
	}

	if (step.stage === 'list') {
		return 'Checking which Pokémon you own: downloading the card list (once, about 750 KB).';
	}

	return `Checking which Pokémon you own: ${formatCount(step.done)} of ${plural(step.total, 'card', 'cards')}.`;
}

// Why some cards could not be counted, or null.
function gapText(result) {
	if (!result) {
		return null;
	}

	if (result.error && result.unresolved) {
		return `${plural(result.unresolved, 'card', 'cards')} could not be checked: the card list did not download (${errorText(result.error)}).`;
	}

	if (result.unresolved && !navigator.onLine) {
		return `${plural(result.unresolved, 'card is', 'cards are')} not checked yet. Open Lists once with a connection to count them.`;
	}

	if (result.unresolved) {
		return `${plural(result.unresolved, 'card', 'cards')} could not be matched to a Pokémon.`;
	}

	return null;
}

// A sprite, or the dex number in a circle when the image fails or is not on
// the phone.
function sprite(n, name) {
	const wrap = h('span', {class: 'sprite-wrap', 'aria-hidden': 'true'});
	const fallback = () => wrap.replaceChildren(h('span', {class: 'sprite-fallback'}, String(n)));
	const img = h('img', {alt: '', class: 'sprite', decoding: 'async', height: 56, loading: 'lazy', title: name, width: 56});

	img.addEventListener('error', fallback, {once: true});
	img.src = spriteUrl(n);
	wrap.append(img);

	return wrap;
}

// ------------------------------------------------- the Pokémon picker

// Search by name or number, tap to add, tap a chip to remove. A name
// matches in English and, once the species tables are on the phone, in
// Japanese, Korean, and Chinese and by the Japanese and Korean readings
// ("Ptera", "Peutera", "プテラ", "프테라" all find Aerodactyl).
function pokemonPicker(names, initial = [], tables = null) {
	const chosen = new Set(initial);
	const search = h('input', {
		'aria-label': 'Search Pokémon by name or number',
		autocomplete: 'off',
		class: 'search',
		id: 'picker-search',
		placeholder: 'Name or number, e.g. Eevee or 133',
		type: 'search',
	});
	const results = h('ul', {class: 'picker-results', id: 'picker-results'});
	const chips = h('div', {'aria-label': 'Chosen Pokémon', class: 'picker-chips', id: 'picker-chips'});
	const count = h('p', {class: 'muted', id: 'picker-count'});

	function drawChips() {
		const list = [...chosen].sort((a, b) => a - b);

		count.textContent = list.length ? `${plural(list.length, 'Pokémon', 'Pokémon')} chosen.` : 'No Pokémon chosen yet.';
		chips.replaceChildren(...list.map((n) => h('button', {
			'aria-label': `Remove ${nameOf(names, n)}`,
			class: 'chip',
			onclick: () => {
				chosen.delete(n);
				drawChips();
				drawResults();
			},
			type: 'button',
		}, `${dexLabel(n)} ${nameOf(names, n)} ×`)));
	}

	function matches(query) {
		const text = query.trim().toLowerCase().replace(/^#/, '');

		if (!text) {
			return [];
		}

		if (/^\d+$/.test(text)) {
			const n = Number(text);

			return n >= 1 && n <= MAX_DEX ? [n] : [];
		}

		const found = [];
		const key = searchKey(text);

		for (let n = 1; n <= MAX_DEX && found.length < 30; n++) {
			if ((names[n] && names[n].toLowerCase().includes(text)) || (key && termsOf(n).some((term) => term.includes(key)))) {
				found.push(n);
			}
		}

		return found;
	}

	const terms = new Map();

	function termsOf(n) {
		if (!terms.has(n)) {
			terms.set(n, speciesSearchTerms(tables, n));
		}

		return terms.get(n);
	}

	function drawResults() {
		const found = matches(search.value);
		const known = names.some(Boolean);

		if (!found.length) {
			results.replaceChildren(search.value.trim()
				? h('li', {class: 'muted'}, known ? 'No Pokémon by that name or number.' : 'Names are not on this phone yet; search by number.')
				: h('li', {class: 'muted'}, known ? 'Type a name or a Dex number.' : 'Type a Dex number (names need one visit with a connection).'));

			return;
		}

		results.replaceChildren(...found.map((n) => {
			const picked = chosen.has(n);

			return h('li', null, h('button', {
				'aria-pressed': picked ? 'true' : 'false',
				class: picked ? 'picker-item picked' : 'picker-item',
				onclick: () => {
					if (chosen.has(n)) {
						chosen.delete(n);
					}
					else {
						chosen.add(n);
					}

					drawChips();
					drawResults();
				},
				type: 'button',
			},
			sprite(n, nameOf(names, n)),
			h('span', {class: 'dex-num'}, dexLabel(n)),
			h('span', {class: 'dex-name'}, nameOf(names, n)),
			h('span', {class: 'picker-state'}, picked ? 'Added' : 'Add')));
		}));
	}

	search.addEventListener('input', drawResults);
	drawChips();
	drawResults();

	return {
		element: h('div', {class: 'picker'}, search, results, count, chips),
		selected: () => [...chosen].sort((a, b) => a - b),
	};
}

// ------------------------------------------------------ list of lists

export const checklistsView = (root) => listsScreen(root, MINE);

export const familyChecklistsView = (root, {userId}) => listsScreen(root, familySource(userId));

function listsScreen(root, source) {
	let alive = true;
	let busy = false;
	let names = [];
	let tables = null;

	const heading = h('div', {class: 'view-head'}, h('h2', null, 'Lists'));
	const status = h('p', {'aria-live': 'polite', class: 'muted', id: 'lists-status'});
	const body = h('div', {id: 'lists-body'});
	const adder = source.readOnly ? null : addPanel();

	if (source.readOnly) {
		whenMemberName(source.userId, (name) => {
			heading.querySelector('h2').textContent = `${name}'s lists`;
			document.title = `${name}'s lists | Card Tracker`;
		});
	}

	function tile(goal, byDex) {
		return link(`${source.base}/${encodeURIComponent(goal.id)}`, {class: 'list-tile'},
			h('span', {class: 'list-name'}, goal.name),
			h('span', {class: 'list-foot'},
				h('span', {class: 'set-meta'}, describe(goal)),
				byDex ? progressBadge(progress(goal, byDex)) : null
			)
		);
	}

	function draw(goals, byDex) {
		if (!goals.length) {
			body.replaceChildren(h('div', {class: 'card empty-state'},
				h('p', {class: 'big'}, 'No lists yet.'),
				source.readOnly
					? null
					: h('p', {class: 'muted'}, 'Add a region to tick off its Pokémon as you collect them. A list ticks itself from your cards, in any language.')
			));

			return;
		}

		const sorted = [...goals].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

		body.replaceChildren(h('div', {class: 'list-grid'}, sorted.map((goal) => tile(goal, byDex))));
	}

	async function load({force = false} = {}) {
		if (busy) {
			return;
		}

		busy = true;

		try {
			let data;

			try {
				data = await source.load();
			}
			catch (err) {
				body.replaceChildren(h('div', {class: 'notice', role: 'alert'}, h('p', null, source.readOnly
					? err.message || errorText(err)
					: `Your lists could not be read from this phone. ${errorText(err)}`)));

				return;
			}

			if (!alive) {
				return;
			}

			// Draw at once without progress, then again once owned cards
			// are resolved.
			draw(data.goals, null);

			if (!data.goals.length) {
				status.textContent = '';

				return;
			}

			const result = await resolveOwned(data.entries, {
				force,
				isAlive: () => alive,
				onProgress: (step) => {
					if (alive) {
						status.textContent = progressText(step);
					}
				},
			});

			if (!alive) {
				return;
			}

			draw(data.goals, result.byDex);
			status.replaceChildren();

			const gap = gapText(result);

			if (gap) {
				status.append(gap, ' ');

				if (result.error) {
					status.append(h('button', {class: 'small', onclick: () => load({force: true}), type: 'button'}, 'Try again'));
				}
			}
		}
		finally {
			busy = false;
		}
	}

	function addPanel() {
		const regionSelect = h('select', {'aria-label': 'Region', id: 'add-region'},
			REGIONS.map((region) => h('option', {value: region.id}, `${region.name} (${dexLabel(region.first)} to ${dexLabel(region.last)})`)),
			h('option', {value: 'every'}, `Every Pokémon (${dexLabel(1)} to ${dexLabel(MAX_DEX)})`)
		);
		const addRegion = h('button', {class: 'primary', id: 'add-region-button', type: 'button'}, 'Add region list');
		const message = h('p', {'aria-live': 'polite', class: 'form-error'});
		const custom = h('div', {hidden: true, id: 'custom-builder'});
		const openCustom = h('button', {id: 'build-own', type: 'button'}, 'Build your own list');

		addRegion.addEventListener('click', async () => {
			addRegion.disabled = true;
			message.textContent = '';

			try {
				const goal = regionSelect.value === 'every'
					? await createChecklist({kind: 'every_pokemon'})
					: await createChecklist({kind: 'region', target: regionSelect.value});

				go(`lists/${encodeURIComponent(goal.id)}`);
			}
			catch (err) {
				message.textContent = `Could not add the list. ${errorText(err)}`;
				addRegion.disabled = false;
			}
		});

		openCustom.addEventListener('click', () => {
			openCustom.hidden = true;

			const nameInput = h('input', {autocomplete: 'off', class: 'search', id: 'custom-name', placeholder: 'e.g. Every Eeveelution', type: 'text'});
			const picker = pokemonPicker(names, [], tables);
			const create = h('button', {class: 'primary', id: 'create-custom', type: 'button'}, 'Create list');
			const cancel = h('button', {type: 'button'}, 'Cancel');
			const error = h('p', {'aria-live': 'polite', class: 'form-error'});

			cancel.addEventListener('click', () => {
				custom.hidden = true;
				custom.replaceChildren();
				openCustom.hidden = false;
			});

			create.addEventListener('click', async () => {
				error.textContent = '';

				const picked = picker.selected();

				if (!picked.length) {
					error.textContent = 'Pick at least one Pokémon.';

					return;
				}

				create.disabled = true;

				try {
					const goal = await createChecklist({dex_list: picked, kind: 'custom_pokemon', name: nameInput.value});

					go(`lists/${encodeURIComponent(goal.id)}`);
				}
				catch (err) {
					error.textContent = `Could not create the list. ${errorText(err)}`;
					create.disabled = false;
				}
			});

			custom.replaceChildren(
				h('label', {for: 'custom-name'}, 'List name'),
				nameInput,
				h('label', {class: 'picker-label', for: 'picker-search'}, 'Pokémon'),
				picker.element,
				error,
				h('div', {class: 'button-row'}, cancel, create)
			);
			custom.hidden = false;
			nameInput.focus();
		});

		return h('section', {class: 'card', id: 'add-list'},
			h('h3', null, 'Add a list'),
			h('label', {for: 'add-region'}, 'A region, by National Dex number'),
			h('span', {class: 'select-wrap'}, regionSelect),
			h('div', {class: 'stack'}, addRegion),
			message,
			h('div', {class: 'stack'}, openCustom),
			custom
		);
	}

	speciesNames().then((all) => {
		tables = all;
		names = all.en;
	});

	const stop = source.watch ? source.watch(() => alive && load()) : () => {};

	root.append(...[heading, listsSwitch('checklists', source.userId || null), status, body, adder].filter(Boolean));
	load();

	return () => {
		alive = false;
		stop();
	};
}

// ------------------------------------------------------ one checklist

export const checklistView = (root, {id}) => checklistScreen(root, MINE, id);

export const familyChecklistView = (root, {id, userId}) => checklistScreen(root, familySource(userId), id);

// Entries of a card list as a signature, so a reload can tell whether the
// cards changed or only the checklist did.
const cardsSignature = (entries) => entries.map((entry) => `${entry.id}:${entry.updated_at}`).join(',');

function checklistScreen(root, source, id) {
	let alive = true;
	let goal = null;
	let names = [];
	let tables = null;
	let result = null;
	let signature = null;
	let expanded = null;
	let saving = 0;
	let show = readChoice(FILTER_KEY, FILTERS.map((option) => option.value), 'all');

	const back = link(source.base, {class: 'back'}, '‹ All lists');
	const title = h('h2', {id: 'checklist-title'}, 'List');
	const meta = h('p', {class: 'muted', id: 'checklist-meta'});
	const summary = h('p', {class: 'checklist-summary', id: 'checklist-summary'});
	const status = h('p', {'aria-live': 'polite', class: 'muted', id: 'checklist-status'});
	const list = h('ul', {class: 'dex-list', id: 'dex-list'});
	const empty = h('p', {class: 'muted', hidden: true, id: 'checklist-empty'});
	const actions = source.readOnly ? null : h('div', {class: 'actions checklist-actions'});
	const editor = h('div', {hidden: true});

	const filter = h('div', {'aria-label': 'Show', class: 'segmented', id: 'checklist-filter', role: 'radiogroup'},
		FILTERS.map(({label, value}) => h('label', null,
			h('input', {checked: value === show, name: 'checklist-filter', onchange: () => {
				show = value;
				saveChoice(FILTER_KEY, value);
				drawList();
			}, type: 'radio', value}),
			h('span', null, label)
		))
	);


	function state(n) {
		const owned = result && result.byDex.get(n);

		if (owned) {
			return {entries: owned, kind: 'owned'};
		}

		return {entries: [], kind: handTicks(goal).has(n) ? 'hand' : 'missing'};
	}

	function drawHead() {
		const counts = progress(goal, result ? result.byDex : new Map());

		title.textContent = goal.name;
		document.title = `${goal.name} | Card Tracker`;
		meta.replaceChildren(describe(goal), ' ', progressBadge(counts));

		const parts = [`${formatCount(counts.owned)} owned`];

		if (counts.byHand) {
			parts.push(`${formatCount(counts.byHand)} marked by hand`);
		}

		parts.push(`${formatCount(counts.missing)} missing`);
		summary.textContent = `${parts.join(', ')}.`;
	}

	function mark(kind, count) {
		if (kind === 'owned') {
			return h('span', {class: 'dex-mark'},
				h('span', {'aria-hidden': 'true', class: 'tick tick-owned'}),
				h('span', {class: 'dex-mark-text'}, plural(count, 'card', 'cards'))
			);
		}

		if (kind === 'hand') {
			return h('span', {class: 'dex-mark'},
				h('span', {'aria-hidden': 'true', class: 'tick tick-hand'}),
				h('span', {class: 'dex-mark-text'}, 'marked by hand')
			);
		}

		return h('span', {class: 'dex-mark'},
			h('span', {'aria-hidden': 'true', class: 'tick tick-missing'}),
			h('span', {class: 'dex-mark-text muted'}, 'missing')
		);
	}

	function ownedPanel(n, entries) {
		const panel = h('div', {class: 'dex-cards', id: `dex-cards-${n}`});
		const viewing = viewingLanguage();

		panel.append(h('p', {class: 'muted'}, 'Loading the cards...'));

		ownedCards(entries).then(async (cards) => {
			const species = await speciesNames().catch(() => null);
			const tiles = await Promise.all(cards.map(async (card) => {
				const base = catalogLanguage(card.catalog);
				const languages = card.entries.map((entry) => entry.language);
				let record = card.record;
				let local = null;

				if (record) {
					const localizations = record.localizations || {};
					const order = [catalogFor(viewing) === card.catalog ? viewing : null, ...languages, base];

					local = order.map((lang) => lang && localizations[lang]).find(Boolean) || Object.values(localizations)[0] || null;
				}
				else {
					// A card this phone never indexed (a family member's, or
					// one synced from another phone): read it, cache first.
					try {
						const detail = await importApi.cardDetail(base, card.cardId);

						if (detail) {
							record = {collector_number: detail.localId};
							local = {image: detail.image || null, lang: base, name: detail.name, set_name: detail.set && detail.set.name};
						}
					}
					catch {
						// The card-back tile carries the card ID.
					}
				}

				const lang = local && isLanguage(local.lang) ? local.lang : base;
				// Asian prints: the English name first, the original under it.
				const names = local && hasOwnNames(lang)
					? cardNames({lang, name: local.name}, species)
					: {english: null, original: (local && local.name) || card.cardId, reading: null};
				const info = {
					name: mainName(names),
					number: record && record.collector_number,
					setName: local && local.set_name,
				};
				const route = `cards/${encodeURIComponent(lang)}/${encodeURIComponent(card.cardId)}`;
				const byLanguage = new Map();

				for (const code of languages) {
					byLanguage.set(code, (byLanguage.get(code) || 0) + 1);
				}

				// The count names the copies in the language the corner shows:
				// the viewing language when one is in it, else the only one.
				const count = byLanguage.has(viewing)
					? byLanguage.get(viewing)
					: byLanguage.size === 1 ? card.entries.length : 0;

				return {
					node: cardTile({
						art: {count, finish: groupFinish(card.entries), info, languages, src: local ? cardImage(local.image, 'low') : null, viewing},
						meta: [info.number ? `#${info.number}` : null, info.setName].filter(Boolean).join(' · '),
						names: tileNames(names, lang),
						route,
					}),
					route,
				};
			}));

			if (alive) {
				panel.replaceChildren(h('div', {class: 'card-grid'}, tiles.map((tile) => tile.node)));
				offerCardList(tiles.map((tile) => tile.route), goal ? goal.name : null);
			}
		}).catch((err) => {
			panel.replaceChildren(h('p', {class: 'muted'}, `The cards could not be listed. ${errorText(err)}`));
		});

		return panel;
	}

	async function toggleHand(n) {
		const on = !handTicks(goal).has(n);
		const before = goal;

		// Shown at once; saved behind.
		goal = {...goal, hand_ticks: {...(goal.hand_ticks || {})}};

		if (on) {
			goal.hand_ticks[n] = new Date().toISOString();
		}
		else {
			delete goal.hand_ticks[n];
		}

		drawHead();
		drawList();
		saving++;

		try {
			await setHandTick(id, n, on);
		}
		catch (err) {
			goal = before;
			drawHead();
			drawList();
			showError('The tick was not saved.', err);
		}
		finally {
			saving--;
		}

		// Quick taps are saved in turn; once the last one is in, the screen
		// reads the stored list back.
		if (!saving && alive) {
			load();
		}
	}

	function row(n) {
		const {entries, kind} = state(n);
		const name = nameOf(names, n);
		const attrs = {class: 'dex-entry', type: 'button'};

		if (kind === 'owned') {
			attrs['aria-expanded'] = expanded === n ? 'true' : 'false';
			attrs.onclick = () => {
				expanded = expanded === n ? null : n;
				drawList();
			};
		}
		else if (!source.readOnly) {
			attrs['aria-pressed'] = kind === 'hand' ? 'true' : 'false';
			attrs['aria-label'] = `${dexLabel(n)} ${name}, ${kind === 'hand' ? 'marked by hand. Tap to clear the mark' : 'missing. Tap to mark by hand'}`;
			attrs.onclick = () => toggleHand(n);
		}
		else {
			attrs.disabled = true;
		}

		const item = h('li', {class: `dex-row ${kind}`, 'data-dex': n},
			h('button', attrs,
				sprite(n, name),
				h('span', {class: 'dex-text'},
					h('span', {class: 'dex-num'}, dexLabel(n)),
					h('span', {class: 'dex-name'}, name)
				),
				mark(kind, entries.length)
			)
		);

		if (kind === 'owned' && expanded === n) {
			item.append(ownedPanel(n, entries));
		}

		return item;
	}

	function drawList() {
		const numbers = checklistDex(goal).filter((n) => {
			const {kind} = state(n);

			if (show === 'missing') {
				return kind === 'missing';
			}

			if (show === 'owned') {
				return kind !== 'missing';
			}

			return true;
		});

		list.replaceChildren(...numbers.map(row));
		empty.hidden = numbers.length > 0;
		empty.textContent = show === 'missing' ? 'Nothing missing. Every Pokémon on this list is ticked.' : 'No Pokémon ticked on this list yet.';
	}

	function drawActions() {
		if (!actions) {
			return;
		}

		const rename = h('button', {id: 'rename-list', type: 'button'}, 'Rename');
		const remove = h('button', {class: 'danger', id: 'delete-list', type: 'button'}, 'Delete list');

		rename.addEventListener('click', async () => {
			const name = window.prompt('List name', goal.name);

			if (name === null || !name.trim() || name.trim() === goal.name) {
				return;
			}

			try {
				goal = await renameChecklist(id, name);
				drawHead();
			}
			catch (err) {
				showError('The list was not renamed.', err);
			}
		});

		remove.addEventListener('click', async () => {
			if (!window.confirm(`Delete "${goal.name}"? Your cards stay as they are.`)) {
				return;
			}

			// Leaving: the save's change event must not redraw this list as
			// "not here" on the way out.
			saving++;

			try {
				await deleteChecklist(id);
				go('lists');
			}
			catch (err) {
				saving--;
				showError('The list was not deleted.', err);
			}
		});

		actions.replaceChildren(rename, remove);

		if (goal.kind === 'custom_pokemon') {
			const edit = h('button', {class: 'wide', id: 'edit-pokemon', type: 'button'}, 'Change the Pokémon');

			edit.addEventListener('click', () => openEditor());
			actions.append(edit);
		}
	}

	function openEditor() {
		const picker = pokemonPicker(names, checklistDex(goal), tables);
		const save = h('button', {class: 'primary', type: 'button'}, 'Save Pokémon');
		const cancel = h('button', {type: 'button'}, 'Cancel');
		const error = h('p', {'aria-live': 'polite', class: 'form-error'});
		const close = () => {
			editor.hidden = true;
			editor.replaceChildren();
		};

		cancel.addEventListener('click', close);
		save.addEventListener('click', async () => {
			const picked = picker.selected();

			if (!picked.length) {
				error.textContent = 'Pick at least one Pokémon.';

				return;
			}

			save.disabled = true;

			try {
				goal = await setDexList(id, picked);
				close();
				drawHead();
				drawList();
			}
			catch (err) {
				error.textContent = `Not saved. ${errorText(err)}`;
				save.disabled = false;
			}
		});

		editor.className = 'card';
		editor.replaceChildren(h('h3', null, 'Change the Pokémon'), picker.element, error, h('div', {class: 'button-row'}, cancel, save));
		editor.hidden = false;
		editor.scrollIntoView({block: 'start'});
	}

	async function load({force = false} = {}) {
		let data;

		try {
			data = await source.load();
		}
		catch (err) {
			root.replaceChildren(...[back, h('div', {class: 'notice', role: 'alert'}, h('p', null, source.readOnly
				? err.message || errorText(err)
				: `Your lists could not be read from this phone. ${errorText(err)}`))].filter(Boolean));

			return;
		}

		if (!alive) {
			return;
		}

		const found = data.goals.find((item) => item.id === id);

		if (!found) {
			root.replaceChildren(...[back, h('div', {class: 'card empty-state'},
				h('p', {class: 'big'}, 'This list is not here.'),
				h('p', {class: 'muted'}, 'It may have been deleted on another phone.')
			)].filter(Boolean));

			return;
		}

		goal = found;
		drawHead();
		drawActions();
		drawList();

		const next = cardsSignature(data.entries);

		if (next === signature && !force) {
			return;
		}

		signature = next;

		const resolved = await resolveOwned(data.entries, {
			force,
			isAlive: () => alive,
			onProgress: (step) => {
				if (alive) {
					status.textContent = progressText(step);
				}
			},
		});

		if (!alive) {
			return;
		}

		result = resolved;
		drawHead();
		drawList();
		status.replaceChildren();

		const gap = gapText(result);

		if (gap) {
			status.append(gap, ' ');

			if (result.error) {
				status.append(h('button', {class: 'small', onclick: () => load({force: true}), type: 'button'}, 'Try again'));
			}
		}
	}

	speciesNames().then((all) => {
		tables = all;
		names = all.en;

		if (alive && goal) {
			drawList();
		}
	});

	// While ticks are being saved, the screen already shows them; reading
	// the stored list back halfway would flicker.
	const stop = source.watch ? source.watch(() => alive && !saving && load()) : () => {};

	root.append(...[back, title, meta, summary, status, filter, empty, list, editor, actions].filter(Boolean));
	load();

	return () => {
		alive = false;
		stop();
	};
}
