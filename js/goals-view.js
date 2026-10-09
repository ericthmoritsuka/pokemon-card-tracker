// Set and artist goals (js/goals.js) on screen:
//   goals/new                       a new goal: a set and its level, or an
//                                   illustrator
//   goals/artist/<name>             every card by an illustrator, opened
//                                   from card detail; the goal when one is
//                                   kept, else the cards with "Keep as a goal"
//   goals/<id>                      one goal
//   family/<userId>/goals/<id>      a family member's, view only
// plus the Goals section of the Lists tab (goalsSection), the set page's
// "Make this a goal" (setGoalControl), and card detail's "All cards by this
// artist" (artistLink).
//
// A goal screen shows its cards as the shared tiles, owned ones in full and
// missing ones dimmed with one tap to the wishlist, the All, Owned, and
// Missing filter with its counts, and the shared search and sort bar
// (js/filter-bar.js). Everything it reads is kept on the phone, so the
// Missing list opens offline in a card shop.
//
// Routes (the integrator adds goalRoutes to app.js ROUTES and
// goalAccountViews to ACCOUNT_ROUTES, css/goals.css to index.html and
// sw.js, and js/goals.js and js/goals-view.js to sw.js).

import {currentUser} from './auth.js';
import {offerCardList} from './card-swipe.js';
import {LANGUAGES, cardImage, catalogFor, catalogLanguage, languageLabel, savedCardRecords, setList, viewingLanguage} from './catalog.js';
import {mainName, namesFor, tileNames} from './catalog-views.js';
import {deleteChecklist, listLanguages, namesLanguages, renameChecklist, reorderGoals, restoreGoal} from './checklists.js';
import {isLive, listCards, onChange} from './collection.js';
import {BASE, errorText, go, h, segmentCounts, showError} from './dom.js';
import {whenMemberName} from './family.js';
import {applyFilters, filterBar, sortItems} from './filter-bar.js';
import {flagBadge} from './flags.js';
import {formatCount, plural} from './format.js';
import {searchKey} from './names.js';
import {languagesControl} from './pokemon-cards-view.js';
import {printKey, wishLanguage} from './pokemon-cards.js';
import {UNDO_MS, orderSection} from './reorder.js';
import {toast} from './shell.js';
import {memberDocument} from './sync.js';
import {cardTile} from './tile.js';
import {addToWishlist, listWishlist} from './wishlist.js';
import {
	SET_LEVELS,
	artistSuggestions,
	computeGoal,
	createGoal,
	describeGoal,
	findGoal,
	getGoal,
	isGoal,
	levelLabel,
	listGoals,
	passesGoalFilter,
	setGoalLevel,
	sortGoals,
} from './goals.js';

const FILTERS = [
	{label: 'All', value: 'all'},
	{label: 'Owned', value: 'owned'},
	{label: 'Missing', value: 'missing'},
];

const FILTER_KEY = 'cardTracker.goalFilter';

const link = (route, attrs, ...children) => h('a', {...attrs, 'data-link': route, href: BASE + route}, ...children);

export const goalRoute = (base, id) => `${base}/${encodeURIComponent(id)}`;

export const artistRoute = (name) => `goals/artist/${encodeURIComponent(name)}`;

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

// The unit a goal counts: finishes on a master set, cards otherwise.
const unitOf = (goal) => (goal && goal.kind === 'set' && goal.level === 'master' ? ['finish', 'finishes'] : ['card', 'cards']);

// The ring always comes with its "N of M", never alone.
function progressRing(goal, tally) {
	const percent = tally.total ? Math.min(100, Math.round((tally.owned / tally.total) * 100)) : 0;
	const text = `${formatCount(tally.owned)} of ${formatCount(tally.total)}`;

	return h('span', {'aria-label': `${text} ${unitOf(goal)[1]} owned`, class: tally.owned ? 'owned-count owned goal-ring' : 'owned-count goal-ring', role: 'img'},
		h('span', {'aria-hidden': 'true', class: 'ring', style: `--p: ${percent}`}),
		h('span', {'aria-hidden': 'true'}, text)
	);
}

// ------------------------------------------------------- the Lists tab

// The Goals section of the Lists tab. base is where goal screens live
// ("goals", or "family/<id>/goals"). update(goals, entries) redraws it.
export function goalsSection({base = 'goals', readOnly = false} = {}) {
	let run = 0;

	const list = h('div', {class: 'list-grid', id: 'goals-list'});
	const newGoal = readOnly ? null : link('goals/new', {class: 'button small goal-new', id: 'goals-new'}, 'New goal');
	const empty = h('p', {class: 'muted', hidden: true, id: 'goals-empty'}, 'Collect a whole set, or every card by an artist you like.');
	// Edit order (js/reorder.js): the goals as rows to drag or move, in
	// place of the tiles while it is open.
	const order = readOnly ? null : orderSection({
		describe: (goal) => ({detail: describeGoal(goal), name: goal.name}),
		errorText,
		label: 'Goals',
		onToggle: (open) => {
			list.hidden = open;

			if (newGoal) {
				newGoal.hidden = open;
			}
		},
		save: reorderGoals,
		toast,
	});

	if (order) {
		order.button.id = 'goals-order';
		order.panel.id = 'goals-order-panel';
	}

	const element = h('section', {class: 'goals-section', hidden: readOnly, id: 'goals-section'},
		h('div', {class: 'goals-head'}, h('h3', null, 'Goals'), h('span', {class: 'goals-head-actions'}, order ? order.button : null, newGoal)),
		empty,
		list,
		order ? order.panel : null
	);

	function tile(goal) {
		const ring = h('span', {class: 'goal-tile-ring'});
		const node = link(goalRoute(base, goal.id), {class: 'list-tile goal-tile', 'data-goal': goal.id},
			h('span', {class: 'list-name'}, goal.name),
			h('span', {class: 'list-foot'}, h('span', {class: 'set-meta'}, describeGoal(goal)), ring)
		);

		return {node, ring};
	}

	async function update(goals, entries) {
		const mine = ++run;
		const sorted = sortGoals((goals || []).filter(isGoal));
		const tiles = sorted.map((goal) => ({goal, ...tile(goal)}));

		if (order) {
			order.set(sorted);
		}

		element.hidden = readOnly && !sorted.length;
		empty.hidden = sorted.length > 0;
		list.replaceChildren(...tiles.map((item) => item.node));

		// Each ring once its cards are read, from the phone when kept.
		for (const item of tiles) {
			computeGoal(item.goal, entries || []).then((result) => {
				if (mine === run && !result.missingList) {
					item.ring.replaceChildren(progressRing(item.goal, result.tally));
				}
			}).catch(() => {
				// No ring this time; the goal's own screen says why.
			});
		}
	}

	return {element, update};
}

// ------------------------------------------------------- whose goal

const MINE = {
	base: 'goals',
	listsBase: 'lists',
	load: async (id) => {
		const [goal, entries, wishlist] = await Promise.all([getGoal(id), listCards(), listWishlist()]);

		return {entries, goal, wishlist};
	},
	readOnly: false,
	watch: (reload) => onChange(reload),
};

function familySource(userId) {
	let docPromise = null;

	return {
		base: `family/${encodeURIComponent(userId)}/goals`,
		listsBase: `family/${encodeURIComponent(userId)}/lists`,
		load: async (id) => {
			if (!currentUser()) {
				throw new Error('Sign in to see your family\'s goals.');
			}

			if (!navigator.onLine) {
				throw new Error('A family member\'s goals show when you are online.');
			}

			docPromise = docPromise || memberDocument(userId).catch((err) => {
				docPromise = null;

				throw err;
			});

			const doc = (await docPromise) || {};
			const goal = (doc.goals || []).find((item) => item.id === id && isLive(item) && isGoal(item)) || null;

			return {entries: (doc.cards || []).filter(isLive), goal, wishlist: []};
		},
		readOnly: true,
		userId,
		watch: null,
	};
}

// An illustrator's cards before they are kept as a goal.
function draftSource(name) {
	const goal = {id: null, kind: 'artist', name, target: name};

	return {
		...MINE,
		draft: true,
		load: async () => {
			const [entries, wishlist] = await Promise.all([listCards(), listWishlist()]);

			return {entries, goal, wishlist};
		},
	};
}

// ------------------------------------------------------- the goal screen

export const goalView = (root, {id}) => goalScreen(root, MINE, id);

export const familyGoalView = (root, {id, userId}) => goalScreen(root, familySource(userId), id);

// Every card by an illustrator: the goal kept for them, else the cards with
// "Keep as a goal".
export function artistView(root, {name}) {
	let alive = true;
	let cleanup = null;

	listGoals().then((goals) => {
		if (!alive) {
			return;
		}

		const kept = findGoal(goals, {kind: 'artist', target: name});

		if (kept) {
			go(goalRoute('goals', kept.id), {replace: true});

			return;
		}

		cleanup = goalScreen(root, draftSource(String(name).trim()), null);
	}).catch((err) => showError('Your goals could not be read from this phone.', err));

	return () => {
		alive = false;

		if (cleanup) {
			cleanup();
		}
	};
}

function goalScreen(root, source, id) {
	let alive = true;
	let goal = null;
	let entries = [];
	let wished = new Set();
	let result = null;
	let loadRun = 0;
	let show = readChoice(FILTER_KEY, FILTERS.map((option) => option.value), 'all');
	let leaving = false;
	const adding = new Set();

	const back = link(source.listsBase, {class: 'back', id: 'goal-back'}, '‹ All lists');
	const title = h('h2', {id: 'goal-title'}, 'Goal');
	const meta = h('p', {class: 'muted goal-meta', id: 'goal-meta'});
	const levelSlot = h('div', {class: 'goal-level-slot', id: 'goal-level-slot'});
	const languages = source.draft ? null : languagesControl({listId: id, readOnly: source.readOnly});
	const summary = h('p', {class: 'checklist-summary', id: 'goal-summary'});
	const status = h('p', {'aria-live': 'polite', class: 'muted', id: 'goal-status'});
	const grid = h('div', {class: 'card-grid pc-grid', id: 'goal-grid'});
	const empty = h('p', {class: 'muted', hidden: true, id: 'goal-empty'});
	const actions = source.readOnly ? null : h('div', {class: 'actions checklist-actions', id: 'goal-actions'});
	const notice = h('div', {id: 'goal-notice'});
	const content = h('div', {id: 'goal-content'});

	const filter = h('div', {'aria-label': 'Show', class: 'segmented', id: 'goal-filter', role: 'radiogroup'},
		FILTERS.map(({label, value}) => h('label', null,
			h('input', {checked: value === show, name: 'goal-filter', onchange: () => {
				show = value;
				saveChoice(FILTER_KEY, value);
				draw();
			}, type: 'radio', value}),
			h('span', {'data-label': label}, label)
		))
	);

	// Search and sort over the goal's cards; set and rarity filters where
	// they say something (an artist's cards span sets).
	let bar = null;
	const barSlot = h('div', {class: 'goal-bar', id: 'goal-bar'});

	function makeBar() {
		if (bar) {
			return;
		}

		bar = filterBar({
			filters: goal.kind === 'artist' ? ['set', 'rarity'] : ['rarity'],
			id: 'goal',
			onChange: () => draw(),
			placeholder: 'Search this goal',
			sort: 'set',
			sorts: ['set', 'name'],
			storageKey: `cardTracker.goalBar.${goal.kind}`,
		});
		barSlot.replaceChildren(bar.element);
	}

	const redraw = () => alive && draw();

	function namesOf(card) {
		return namesFor({lang: catalogLanguage(card.catalog), name: card.name || ''}, redraw);
	}

	// One filter bar item per card.
	function itemOf(state) {
		const {card} = state;
		const names = namesOf(card);

		return {
			key: printKey(card.catalog, card.cardId),
			name: mainName(names) || card.name || card.cardId,
			number: card.localId,
			rarity: card.rarity,
			releaseDate: card.releaseDate,
			search: [names.english, names.original, names.reading, card.name, card.setName, card.localId, card.cardId].filter(Boolean).map(searchKey).join('\n'),
			setKey: `${card.catalog}|${card.setId}`,
			setName: card.setName || card.setId,
			state,
		};
	}

	// ------------------------------------------------------------ head

	function drawHead() {
		title.textContent = goal.name;
		document.title = `${goal.name} | Card Tracker`;

		const parts = [describeGoal(goal)];

		if (goal.kind === 'set' && result && result.set && result.set.name && result.set.name !== goal.name) {
			parts.push(result.set.name);
		}

		if (goal.kind === 'set' && goal.catalog && goal.catalog !== 'international') {
			parts.push(languageLabel(catalogLanguage(goal.catalog)));
		}

		meta.replaceChildren(parts.join(' · '), ...(result && !result.missingList ? [' ', progressRing(goal, result.tally)] : []));

		if (result && !result.missingList) {
			const [one, many] = unitOf(goal);

			summary.textContent = `${formatCount(result.tally.owned)} of ${plural(result.tally.total, one, many)} owned, ${formatCount(result.tally.missing)} missing.`;
		}
		else {
			summary.textContent = '';
		}
	}

	function drawLevel() {
		if (goal.kind !== 'set') {
			levelSlot.replaceChildren();

			return;
		}

		if (source.readOnly) {
			levelSlot.replaceChildren();

			return;
		}

		const select = h('select', {'aria-label': 'Goal level', id: 'goal-level'},
			SET_LEVELS.map((level) => h('option', {selected: level.value === goal.level, value: level.value}, level.label)));
		const hint = (SET_LEVELS.find((level) => level.value === goal.level) || {hint: ''}).hint;

		select.addEventListener('change', async () => {
			select.disabled = true;

			try {
				goal = await setGoalLevel(id, select.value);
				result = null;
				load();
			}
			catch (err) {
				showError('The level was not changed.', err);
				select.value = goal.level;
			}
			finally {
				select.disabled = false;
			}
		});

		levelSlot.replaceChildren(
			h('label', {class: 'goal-level-label', for: 'goal-level'}, 'Level'),
			h('span', {class: 'select-wrap'}, select),
			h('p', {class: 'muted goal-level-hint', id: 'goal-level-hint'}, `${hint}.`)
		);
	}

	function drawStatus(step = null) {
		const parts = [];

		if (step) {
			parts.push(step);
		}

		if (result) {
			if (result.missingList) {
				parts.push(navigator.onLine && result.error
					? `The cards did not load (${errorText(result.error)}).`
					: 'These cards are not on this phone yet. Open this goal once with a connection, and it works offline after that.');
			}
			else if (result.error && !navigator.onLine) {
				parts.push('Some of this goal is not on this phone yet, so it may be incomplete until the next visit with a connection.');
			}

			if (result.tally && result.tally.unknown && goal.level === 'master') {
				parts.push(`${plural(result.tally.unknown, 'card\'s', 'cards\'')} finishes are not known yet, so ${result.tally.unknown === 1 ? 'it counts' : 'they count'} once.`);
			}

			const counts = result.set && result.set.cardCount;
			const expected = counts && (goal.level === 'numbered' ? counts.official : counts.total);

			if (goal.kind === 'set' && typeof expected === 'number' && result.cards.length && result.cards.length < expected) {
				parts.push(`The catalog lists ${formatCount(result.cards.length)} of this set's ${formatCount(expected)} cards so far.`);
			}
		}

		status.textContent = parts.join(' ');

		if (result && result.error && navigator.onLine) {
			status.append(' ', h('button', {class: 'small', id: 'goal-retry', onclick: () => load(), type: 'button'}, 'Try again'));
		}
	}

	// ------------------------------------------------------------ cards

	function wishButton(state) {
		const {card} = state;
		const key = printKey(card.catalog, card.cardId);

		if (wished.has(key)) {
			return h('span', {class: 'pc-wished'}, 'On your wishlist');
		}

		const language = namesLanguages(goal) ? wishLanguage(listLanguages(goal), card.catalog) : null;
		const missing = state.finishes && state.owned ? state.finishes.filter((finish) => !finish.owned).map((finish) => finish.label) : [];
		const button = h('button', {
			'aria-label': `Add ${card.name || card.cardId} #${card.localId} to your wishlist${language ? ` in ${languageLabel(language)}` : ''}`,
			class: 'small pc-wish',
			disabled: adding.has(key),
			type: 'button',
		}, 'Add to wishlist');

		button.addEventListener('click', async () => {
			adding.add(key);
			button.disabled = true;

			try {
				await addToWishlist(card.cardId, {catalog: card.catalog, language, note: missing.length ? `Missing: ${missing.join(', ')}` : undefined});
				wished.add(key);
				toast(`Added to your wishlist${language ? ` (${languageLabel(language)})` : ''}.`);
			}
			catch (err) {
				toast(`Not added to the wishlist. ${errorText(err)}`);
			}
			finally {
				adding.delete(key);

				if (alive) {
					draw();
				}
			}
		});

		return button;
	}

	function cell(item) {
		const {state} = item;
		const {card, copies} = state;
		const lang = catalogLanguage(card.catalog);
		const route = `cards/${encodeURIComponent(lang)}/${encodeURIComponent(card.cardId)}`;
		const names = namesOf(card);
		const owned = state.owned > 0;
		const wanted = wished.has(item.key);
		const finishText = state.finishes ? `${formatCount(state.owned)} of ${plural(state.total, 'finish', 'finishes')}` : null;
		const node = cardTile({
			art: {
				count: copies.length,
				info: {name: mainName(names) || card.name, number: card.localId, setName: card.setName},
				src: cardImage(card.image, 'low'),
				status: owned ? 'owned' : wanted ? 'wanted' : null,
			},
			attrs: {id: `goal-tile-${card.catalog}-${card.cardId}`},
			className: owned ? '' : 'unowned',
			meta: [card.localId ? `#${card.localId}` : null, goal.kind === 'artist' ? card.setName : null, finishText].filter(Boolean).join(' · '),
			names: tileNames(names, lang),
			route,
		});
		const ownedIn = [...new Set(copies.map((entry) => entry.language).filter(Boolean))];

		if (ownedIn.length) {
			node.querySelector('.art-wrap').append(flagBadge(ownedIn, {className: 'badge badge-lang', prefix: 'Owned in'}));
		}

		if (state.finishes) {
			node.title = state.finishes.map((finish) => `${finish.label}${finish.owned ? ' (owned)' : ''}`).join(', ');
		}

		const box = h('div', {
			class: owned ? 'pc-cell pc-owned goal-cell' : 'pc-cell pc-missing goal-cell',
			'data-card': card.cardId,
			'data-catalog': card.catalog,
		}, node);

		// A missing card, or a master card with finishes still to find.
		if (state.missing > 0 && !source.readOnly) {
			box.append(wishButton(state));
		}

		return {node: box, route};
	}

	function draw() {
		if (!goal) {
			return;
		}

		drawHead();

		if (!result || result.missingList) {
			segmentCounts(filter, null);
			grid.replaceChildren();
			empty.hidden = true;
			offerCardList([], goal.name);

			return;
		}

		makeBar();

		const items = result.states.map(itemOf);

		bar.setItems(items);

		const searched = sortItems(applyFilters(items, {filters: bar.state.filters, query: bar.state.query}), bar.state.sort);
		const visible = searched.filter((item) => passesGoalFilter(item.state, show));

		segmentCounts(filter, Object.fromEntries(FILTERS.map(({value}) => [value, searched.filter((item) => passesGoalFilter(item.state, value)).length])));

		const cells = visible.map(cell);

		grid.replaceChildren(...cells.map((item) => item.node));
		empty.hidden = cells.length > 0;
		empty.textContent = !result.cards.length
			? 'The catalog lists no cards here yet.'
			: show === 'missing' && searched.length === items.length ? 'Nothing missing. This goal is complete.' : 'No cards match.';
		offerCardList(cells.map((item) => item.route), goal.name);
	}

	function drawActions() {
		if (!actions) {
			return;
		}

		if (source.draft) {
			const keep = h('button', {class: 'primary wide', id: 'goal-keep', type: 'button'}, 'Keep as a goal');

			keep.addEventListener('click', async () => {
				keep.disabled = true;

				try {
					const made = await createGoal({kind: 'artist', name: goal.name, target: goal.target});

					go(goalRoute('goals', made.id), {replace: true});
				}
				catch (err) {
					keep.disabled = false;
					showError('The goal was not kept.', err);
				}
			});
			actions.replaceChildren(keep);

			return;
		}

		const rename = h('button', {id: 'goal-rename', type: 'button'}, 'Rename');
		const remove = h('button', {class: 'danger', id: 'goal-delete', type: 'button'}, 'Delete goal');

		rename.addEventListener('click', async () => {
			const name = window.prompt('Goal name', goal.name);

			if (name === null || !name.trim() || name.trim() === goal.name) {
				return;
			}

			try {
				goal = await renameChecklist(id, name);
				drawHead();
			}
			catch (err) {
				showError('The goal was not renamed.', err);
			}
		});

		// Deleted at once, with Undo on a toast that brings the goal back as
		// it was, in its place (Eric, 2026-10-06).
		remove.addEventListener('click', async () => {
			leaving = true;

			try {
				const {name} = goal;

				await deleteChecklist(id);
				go(source.listsBase);
				toast(`Deleted ${name}.`, {
					action: () => restoreGoal(id).catch((err) => toast(`Could not bring it back. ${errorText(err)}`)),
					actionLabel: 'Undo',
					timeout: UNDO_MS,
				});
			}
			catch (err) {
				leaving = false;
				showError('The goal was not deleted.', err);
			}
		});

		actions.replaceChildren(rename, remove);
	}

	function showNotice(node) {
		content.hidden = Boolean(node);
		notice.replaceChildren(...[node].filter(Boolean));
	}

	async function load() {
		const run = ++loadRun;
		let data;

		try {
			data = await source.load(id);
		}
		catch (err) {
			if (alive && run === loadRun) {
				showNotice(h('div', {class: 'notice', role: 'alert'}, h('p', null, source.readOnly
					? err.message || errorText(err)
					: `This goal could not be read from this phone. ${errorText(err)}`)));
			}

			return;
		}

		if (!alive || run !== loadRun) {
			return;
		}

		if (!data.goal) {
			showNotice(h('div', {class: 'card empty-state'},
				h('p', {class: 'big'}, 'This goal is not here.'),
				h('p', {class: 'muted'}, 'It may have been deleted on another phone.')
			));

			return;
		}

		showNotice(null);

		const levelChanged = goal && (goal.level !== data.goal.level || JSON.stringify(goal.languages || null) !== JSON.stringify(data.goal.languages || null));

		goal = data.goal;
		entries = data.entries;
		wished = new Set((data.wishlist || []).filter(isLive).map((item) => printKey(item.catalog || 'international', item.card_id)));

		if (languages) {
			languages.update(goal);
		}

		drawLevel();
		drawActions();

		if (levelChanged) {
			result = null;
		}

		draw();
		drawStatus(result ? null : 'Loading the cards...');

		let next;

		try {
			next = await computeGoal(goal, entries);
		}
		catch (err) {
			next = {cards: [], error: err, missingList: true, set: null, states: [], tally: null};
		}

		if (!alive || run !== loadRun) {
			return;
		}

		result = next;
		draw();
		drawStatus();
	}

	// Opened from card detail, Back returns there.
	back.addEventListener('click', (event) => {
		if (source.draft && history.state && history.state.inApp) {
			event.preventDefault();
			event.stopPropagation();
			history.back();
		}
	});

	if (source.draft) {
		back.textContent = '‹ Back';
	}

	if (source.readOnly) {
		whenMemberName(source.userId, (name) => {
			back.textContent = `‹ ${name}'s lists`;
		});
	}

	const stop = source.watch ? source.watch(() => alive && !leaving && load()) : () => {};

	// Not kept yet: "Keep as a goal" comes first, above a long list of cards.
	content.append(...(source.draft
		? [title, meta, summary, actions, status, filter, barSlot, empty, grid]
		: [title, meta, levelSlot, languages && languages.element, summary, status, filter, barSlot, empty, grid, actions]).filter(Boolean));
	root.append(back, notice, content);
	load();

	return () => {
		alive = false;
		stop();

		if (bar) {
			bar.destroy();
		}
	};
}

// ------------------------------------------------------- a new goal

// The catalogs a set goal can be over, with the language their set list is
// read in: the international sets in the viewing language when it is a
// Western one.
function catalogChoices() {
	const viewing = viewingLanguage();
	const western = catalogFor(viewing) === 'international' ? viewing : 'en';

	return [
		{catalog: 'international', label: 'International (Portuguese, English, French...)', lang: western},
		...LANGUAGES.filter((lang) => catalogFor(lang.code) !== 'international').map((lang) => ({catalog: lang.code, label: lang.label, lang: lang.code})),
	];
}

function levelChoices(name, checked = 'numbered') {
	return h('fieldset', {class: 'goal-levels', id: `${name}-levels`},
		h('legend', null, 'Level'),
		SET_LEVELS.map((level) => h('label', {class: 'goal-level-choice'},
			h('input', {checked: level.value === checked, id: `${name}-level-${level.value}`, name: `${name}-level`, type: 'radio', value: level.value}),
			h('span', {class: 'goal-level-text'}, h('strong', null, level.label), h('span', {class: 'muted'}, level.hint))
		))
	);
}

const checkedLevel = (fieldset) => (fieldset.querySelector('input:checked') || {value: 'numbered'}).value;

export function newGoalView(root) {
	let alive = true;
	let kind = 'set';
	let picked = null;
	let sets = [];
	let setRun = 0;

	const back = link('lists', {class: 'back', id: 'goal-back'}, '‹ All lists');
	const kinds = h('div', {'aria-label': 'Goal kind', class: 'goal-kinds', id: 'goal-kinds', role: 'radiogroup'},
		[['set', 'A set', 'Every card of one set, at the level you pick'], ['artist', 'An artist', 'Every card by one illustrator']].map(([value, label, hint]) => h('label', {class: 'goal-kind'},
			h('input', {checked: value === kind, id: `goal-kind-${value}`, name: 'goal-kind', onchange: () => {
				kind = value;
				setPanel.hidden = kind !== 'set';
				artistPanel.hidden = kind !== 'artist';
			}, type: 'radio', value}),
			h('span', {class: 'goal-kind-text'}, h('strong', null, label), h('span', {class: 'muted'}, hint))
		))
	);

	// ------------------------------------------------------------ a set

	const choices = catalogChoices();
	const catalogSelect = h('select', {'aria-label': 'Catalog', id: 'goal-catalog'}, choices.map((choice) => h('option', {value: choice.catalog}, choice.label)));
	const setSearch = h('input', {'aria-label': 'Search sets', autocomplete: 'off', class: 'search', id: 'goal-set-search', placeholder: 'Set name or code, e.g. Prismatic or PRE', type: 'search'});
	const setResults = h('ul', {class: 'goal-set-results', id: 'goal-set-results'});
	const setChosen = h('p', {class: 'goal-set-chosen', id: 'goal-set-chosen'});
	const setLevels = levelChoices('goal');
	const setError = h('p', {'aria-live': 'polite', class: 'form-error', id: 'goal-set-error'});
	const createSet = h('button', {class: 'primary', id: 'goal-create-set', type: 'button'}, 'Create goal');

	const choice = () => choices.find((item) => item.catalog === catalogSelect.value) || choices[0];

	function drawChosen() {
		setChosen.textContent = picked ? `Set: ${picked.name}${picked.code ? ` (${picked.code})` : ''}` : 'No set picked yet.';
	}

	function drawSets() {
		const query = searchKey(setSearch.value);
		const found = (query ? sets.filter((set) => set.search.includes(query)) : sets).slice(0, 30);

		if (!sets.length) {
			return;
		}

		setResults.replaceChildren(...(found.length ? found.map((set) => h('li', null, h('button', {
			'aria-pressed': picked && picked.id === set.id ? 'true' : 'false',
			class: picked && picked.id === set.id ? 'goal-set picked' : 'goal-set',
			'data-set': set.id,
			onclick: () => {
				picked = set;
				drawChosen();
				drawSets();
			},
			type: 'button',
		},
		h('span', {class: 'goal-set-name'}, set.name),
		h('span', {class: 'muted goal-set-meta'}, [set.code, set.serie, typeof set.total === 'number' ? plural(set.total, 'card', 'cards') : null].filter(Boolean).join(' · '))))) : [h('li', {class: 'muted'}, 'No set by that name or code.')]));
	}

	async function loadSets() {
		const run = ++setRun;
		const {lang} = choice();

		picked = null;
		drawChosen();
		setResults.replaceChildren(h('li', {class: 'muted'}, 'Loading the sets...'));

		try {
			const {data} = await setList(lang);

			if (!alive || run !== setRun) {
				return;
			}

			sets = data.flatMap((serie) => serie.sets.map((set) => ({
				code: set.code || null,
				id: set.id,
				name: set.name,
				rank: set.releaseRank ?? Infinity,
				search: [set.name, set.code, set.id, serie.name].filter(Boolean).map(searchKey).join('\n'),
				serie: serie.name,
				total: set.cardCount ? set.cardCount.total ?? set.cardCount.official : null,
			}))).sort((a, b) => a.rank - b.rank);
			drawSets();
		}
		catch (err) {
			if (alive && run === setRun) {
				sets = [];
				setResults.replaceChildren(h('li', {class: 'muted'}, navigator.onLine ? `The sets did not load. ${errorText(err)}` : 'The sets are not on this phone yet. Open Sets once with a connection.'));
			}
		}
	}

	catalogSelect.addEventListener('change', loadSets);
	setSearch.addEventListener('input', drawSets);
	createSet.addEventListener('click', async () => {
		setError.textContent = '';

		if (!picked) {
			setError.textContent = 'Pick a set first.';

			return;
		}

		createSet.disabled = true;

		try {
			const goal = await createGoal({catalog: choice().catalog, kind: 'set', level: checkedLevel(setLevels), name: picked.name, target: picked.id});

			go(goalRoute('goals', goal.id));
		}
		catch (err) {
			setError.textContent = `Could not create the goal. ${errorText(err)}`;
			createSet.disabled = false;
		}
	});

	const setPanel = h('section', {class: 'card goal-panel', id: 'goal-set-panel'},
		h('label', {for: 'goal-catalog'}, 'Catalog'),
		h('span', {class: 'select-wrap'}, catalogSelect),
		h('label', {for: 'goal-set-search'}, 'Set'),
		setSearch,
		setResults,
		setChosen,
		setLevels,
		setError,
		h('div', {class: 'stack'}, createSet)
	);

	// --------------------------------------------------------- an artist

	const artistInput = h('input', {autocomplete: 'off', class: 'search', id: 'goal-artist', list: 'goal-artist-names', placeholder: 'Illustrator, e.g. as on a card', type: 'text'});
	const datalist = h('datalist', {id: 'goal-artist-names'});
	const suggestions = h('div', {'aria-label': 'Illustrators of your cards', class: 'picker-chips goal-artist-chips', id: 'goal-artist-chips'});
	const artistError = h('p', {'aria-live': 'polite', class: 'form-error', id: 'goal-artist-error'});
	const createArtist = h('button', {class: 'primary', id: 'goal-create-artist', type: 'button'}, 'Create goal');

	createArtist.addEventListener('click', async () => {
		artistError.textContent = '';

		const name = artistInput.value.trim();

		if (!name) {
			artistError.textContent = 'Type an illustrator\'s name.';

			return;
		}

		createArtist.disabled = true;

		try {
			const goal = await createGoal({kind: 'artist', name, target: name});

			go(goalRoute('goals', goal.id));
		}
		catch (err) {
			artistError.textContent = `Could not create the goal. ${errorText(err)}`;
			createArtist.disabled = false;
		}
	});

	// Suggestions from the full records of owned cards already on the phone.
	listCards().then((cards) => savedCardRecords(cards)).then((records) => {
		if (!alive) {
			return;
		}

		const names = artistSuggestions(records);

		datalist.replaceChildren(...names.map((name) => h('option', {value: name})));
		suggestions.replaceChildren(...names.slice(0, 8).map((name) => h('button', {
			class: 'chip',
			onclick: () => {
				artistInput.value = name;
				artistInput.focus();
			},
			type: 'button',
		}, name)));
	}).catch(() => {
		// Typing the name still works.
	});

	const artistPanel = h('section', {class: 'card goal-panel', hidden: true, id: 'goal-artist-panel'},
		h('label', {for: 'goal-artist'}, 'Illustrator'),
		artistInput,
		datalist,
		h('p', {class: 'muted'}, 'From your cards:'),
		suggestions,
		artistError,
		h('div', {class: 'stack'}, createArtist)
	);

	drawChosen();
	root.append(back, h('h2', null, 'New goal'), kinds, setPanel, artistPanel);
	loadSets();

	return () => {
		alive = false;
	};
}

// ----------------------------------------------- from the set page

// The set page's goal control: a link to the goal kept for this set, or
// "Make this a goal" with the level. Hidden while a family member's lens is
// on (the caller leaves it out).
export function setGoalControl({lang, nameOf = () => null, setId}) {
	const catalog = catalogFor(lang);
	const element = h('div', {class: 'set-goal', id: 'set-goal'});

	listGoals().then((goals) => {
		const kept = findGoal(goals, {catalog, kind: 'set', target: setId});

		if (kept) {
			element.replaceChildren(link(goalRoute('goals', kept.id), {class: 'button small', id: 'set-goal-link'}, `Your goal: ${levelLabel(kept.level)}`));

			return;
		}

		const open = h('button', {class: 'small', id: 'set-make-goal', type: 'button'}, 'Make this a goal');
		const levels = levelChoices('set-goal');
		const error = h('p', {'aria-live': 'polite', class: 'form-error'});
		const create = h('button', {class: 'primary', id: 'set-goal-create', type: 'button'}, 'Create goal');
		const cancel = h('button', {type: 'button'}, 'Cancel');
		const panel = h('div', {class: 'card goal-panel', hidden: true, id: 'set-goal-panel'}, h('h3', null, 'Make this set a goal'), levels, error, h('div', {class: 'button-row'}, cancel, create));

		open.addEventListener('click', () => {
			panel.hidden = false;
			open.hidden = true;
		});
		cancel.addEventListener('click', () => {
			panel.hidden = true;
			open.hidden = false;
		});
		create.addEventListener('click', async () => {
			create.disabled = true;

			try {
				const goal = await createGoal({catalog, kind: 'set', level: checkedLevel(levels), name: nameOf() || setId, target: setId});

				go(goalRoute('goals', goal.id));
			}
			catch (err) {
				error.textContent = `Could not create the goal. ${errorText(err)}`;
				create.disabled = false;
			}
		});

		element.replaceChildren(open, panel);
	}).catch(() => {
		// No goal control this time; the set itself is unaffected.
	});

	return element;
}

// Card detail's illustrator line: the name, and a link to every card by
// them.
export const artistLink = (name) => [
	h('span', {class: 'illustrator-name'}, name),
	' ',
	link(artistRoute(name), {class: 'illustrator-goal', id: 'card-artist-goal'}, 'All cards by this artist'),
];

// ------------------------------------------------------------ routes

// For app.js ROUTES; goals/new and goals/artist/... before goals/<id>.
export const goalRoutes = [
	{pattern: /^goals\/new$/, render: newGoalView, tab: 'lists', title: 'New goal | Card Tracker'},
	{keys: ['name'], pattern: /^goals\/artist\/([^/]+)$/, render: artistView, tab: 'lists', title: 'Artist | Card Tracker'},
	{keys: ['id'], pattern: /^goals\/([^/]+)$/, render: goalView, tab: 'lists', title: 'Goal | Card Tracker'},
	{keys: ['userId', 'id'], pattern: /^family\/([^/]+)\/goals\/([^/]+)$/, render: familyGoalView, tab: 'lists', title: 'Family goal | Card Tracker'},
];

// For app.js ACCOUNT_ROUTES: each depends on who is signed in.
export const goalAccountViews = [newGoalView, artistView, goalView, familyGoalView];
