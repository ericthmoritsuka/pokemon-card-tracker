// Lists: the Pokémon checklists (js/checklists.js). Two screens, each also
// shown read only for a family member:
//   lists                         the person's checklists, with progress
//   lists/<id>                    one checklist in Dex order
//   family/<userId>/lists[/<id>]  a family member's, view only
//
// js/shell.js draws the view-only strip and the "Mine" switcher; the Lists
// tab's Checklists | Wishlist switch is dom.js listsSwitch().

import {currentUser} from './auth.js';
import {isLive, listCards, onChange} from './collection.js';
import {BASE, errorText, go, h, listsSwitch, segmentCounts, showError} from './dom.js';
import {whenMemberName} from './family.js';
import {formatCount, plural} from './format.js';
import {goalsSection} from './goals-view.js';
import {isGoal, listGoals} from './goals.js';
import {searchKey, speciesSearchTerms} from './names.js';
import {languagesControl, pokemonRoute} from './pokemon-cards-view.js';
import {UNDO_MS, orderSection} from './reorder.js';
import {toast} from './shell.js';
import {memberDocument} from './sync.js';
import {valueButton} from './value-sheet.js';
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
	speciesNames,
	progress,
	regionById,
	renameChecklist,
	reorderGoals,
	resolveOwned,
	restoreGoal,
	setDexList,
	sortChecklists,
	spriteUrl,
} from './checklists.js';

// The same order as a set's segments, everywhere: All, Owned, Missing.
const FILTERS = [
	{label: 'All', value: 'all'},
	{label: 'Owned', value: 'owned'},
	{label: 'Missing', value: 'missing'},
];

const FILTER_KEY = 'cardTracker.checklistFilter';

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
		const [goals, entries, targets] = await Promise.all([listChecklists(), listCards(), listGoals()]);

		return {entries, goals, targets};
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
				targets: (doc.goals || []).filter((goal) => isLive(goal) && isGoal(goal)),
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
	// A load asked for while one runs, run once that one ends (E-08).
	let queued = null;
	let names = [];
	let tables = null;

	const heading = h('div', {class: 'view-head'}, h('h2', null, 'Lists'));
	const status = h('p', {'aria-live': 'polite', class: 'muted', id: 'lists-status'});
	const body = h('div', {id: 'lists-body'});
	// Edit order (js/reorder.js): the checklists as rows to drag or move,
	// in place of the tiles while it is open.
	const order = source.readOnly ? null : orderSection({
		describe: (goal) => ({detail: describe(goal), name: goal.name}),
		errorText,
		label: 'Checklists',
		onToggle: (open) => {
			body.hidden = open;
		},
		save: reorderGoals,
		toast,
	});
	const listsHead = h('div', {class: 'lists-head', hidden: true, id: 'lists-head'},
		h('h3', null, 'Checklists'),
		order ? order.button : null
	);

	if (order) {
		order.button.id = 'lists-order';
		order.panel.id = 'lists-order-panel';
	}
	const adder = source.readOnly ? null : addPanel();
	// Set and artist goals (js/goals-view.js).
	const goals = goalsSection({base: source.userId ? `family/${encodeURIComponent(source.userId)}/goals` : 'goals', readOnly: source.readOnly});

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
		listsHead.hidden = !goals.length;

		if (order) {
			order.set(goals);
		}

		if (!goals.length) {
			body.replaceChildren(h('div', {class: 'card empty-state'},
				h('p', {class: 'big'}, 'No lists yet.'),
				source.readOnly
					? null
					: h('p', {class: 'muted'}, 'Add a region to tick off its Pokémon as you collect them. A list ticks itself from your cards, in any language.')
			));

			return;
		}

		body.replaceChildren(h('div', {class: 'list-grid'}, sortChecklists(goals).map((goal) => tile(goal, byDex))));
	}

	async function load({force = false} = {}) {
		if (busy) {
			queued = {force: Boolean(queued && queued.force) || force};

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

			goals.update(data.targets, data.entries);

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

			if (queued && alive) {
				const next = queued;

				queued = null;
				load(next);
			}
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

	root.append(...[heading, listsSwitch('checklists', source.userId || null), status, listsHead, body, order ? order.panel : null, goals.element, adder].filter(Boolean));
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
	let saving = 0;
	// Each load's number: a load that finishes after a newer one started
	// draws nothing (E-08).
	let loadRun = 0;
	// What the drawn list shows, so a load that changes none of it leaves
	// the rows alone (E-27).
	let drawn = null;
	let show = readChoice(FILTER_KEY, FILTERS.map((option) => option.value), 'all');

	const back = link(source.base, {class: 'back'}, '‹ All lists');
	const title = h('h2', {id: 'checklist-title'}, 'List');
	const meta = h('p', {class: 'muted', id: 'checklist-meta'});
	const languages = languagesControl({listId: id, readOnly: source.readOnly});
	const summary = h('p', {class: 'checklist-summary', id: 'checklist-summary'});
	const status = h('p', {'aria-live': 'polite', class: 'muted', id: 'checklist-status'});
	// The value of the owned cards on the list, on demand: a small Value
	// button opens the sheet (js/value-sheet.js), never a big box.
	const statsSlot = h('div', {class: 'checklist-stats', id: 'checklist-stats'});
	let statsEntries = [];
	const valueOpen = valueButton({entries: () => statsEntries, id: 'checklist-value', label: () => `the owned cards on ${goal ? goal.name : 'this list'}`});
	const list = h('ul', {class: 'dex-list', id: 'dex-list'});
	const empty = h('p', {class: 'muted', hidden: true, id: 'checklist-empty'});
	const actions = source.readOnly ? null : h('div', {class: 'actions checklist-actions'});
	const editor = h('div', {hidden: true});
	const notice = h('div', {id: 'checklist-notice'});
	const content = h('div', {id: 'checklist-content'});

	const filter = h('div', {'aria-label': 'Show', class: 'segmented', id: 'checklist-filter', role: 'radiogroup'},
		FILTERS.map(({label, value}) => h('label', null,
			h('input', {checked: value === show, name: 'checklist-filter', onchange: () => {
				show = value;
				saveChoice(FILTER_KEY, value);
				drawList();
			}, type: 'radio', value}),
			h('span', {'data-label': label}, label)
		))
	);


	// hand: handTicks(goal), built once per draw rather than once per row.
	function state(n, hand) {
		const owned = result && result.byDex.get(n);

		if (owned) {
			return {entries: owned, kind: 'owned'};
		}

		return {entries: [], kind: hand.has(n) ? 'hand' : 'missing'};
	}

	const shows = (kind) => (show === 'missing' ? kind === 'missing' : show === 'owned' ? kind !== 'missing' : true);

	// Everything a drawn list depends on.
	const listKey = () => ({
		dex: checklistDex(goal).join(','),
		names,
		result,
		show,
		ticks: Object.keys(goal.hand_ticks || {}).sort().join(','),
	});

	const sameKey = (a, b) => Boolean(a && b) && Object.keys(a).every((key) => a[key] === b[key]);

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
		segmentCounts(filter, {all: counts.total, missing: counts.missing, owned: counts.ticked});
		summary.textContent = `${parts.join(', ')}.`;
	}

	// The owned copies of the list's Pokémon, each once (a TAG TEAM card
	// counts under every Pokémon on it); the button shows only when there
	// are some.
	function drawStats() {
		const seen = new Map();

		for (const n of checklistDex(goal)) {
			for (const entry of (result && result.byDex.get(n)) || []) {
				seen.set(entry.id, entry);
			}
		}

		statsEntries = [...seen.values()];

		if (!statsEntries.length) {
			statsSlot.replaceChildren();
		}
		else if (!statsSlot.contains(valueOpen)) {
			statsSlot.replaceChildren(valueOpen);
		}
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

	// A row opens every card of its Pokémon (js/pokemon-cards-view.js), where
	// a missing one can be added; the mark on the right only shows the state.
	function row(n, hand) {
		const {entries, kind} = state(n, hand);
		const name = nameOf(names, n);
		const entry = link(pokemonRoute(source.base, id, n), {class: 'dex-entry dex-link'},
			sprite(n, name),
			h('span', {class: 'dex-text'},
				h('span', {class: 'dex-num'}, dexLabel(n)),
				h('span', {class: 'dex-name'}, name)
			)
		);
		const tick = h('span', {class: 'dex-tick'}, mark(kind, entries.length));

		return h('li', {class: `dex-row dex-row-linked ${kind}`, 'data-dex': n}, entry, tick);
	}

	function drawList() {
		const hand = handTicks(goal);
		const numbers = checklistDex(goal).filter((n) => shows(state(n, hand).kind));

		list.replaceChildren(...numbers.map((n) => row(n, hand)));
		drawEmpty(numbers.length);
		drawn = listKey();
	}

	// Draws the list only when something it shows changed.
	function drawListIfChanged() {
		if (!sameKey(drawn, listKey())) {
			drawList();
		}
	}

	function drawEmpty(count) {
		empty.hidden = count > 0;
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

		// Deleted at once, with Undo on a toast that brings the list back as
		// it was, in its place (Eric, 2026-10-06).
		remove.addEventListener('click', async () => {
			// Leaving: the save's change event must not redraw this list as
			// "not here" on the way out.
			saving++;

			try {
				const {name} = goal;

				await deleteChecklist(id);
				go('lists');
				toast(`Deleted ${name}.`, {
					action: () => restoreGoal(id).catch((err) => toast(`Could not bring it back. ${errorText(err)}`)),
					actionLabel: 'Undo',
					timeout: UNDO_MS,
				});
			}
			catch (err) {
				saving--;
				showError('The list was not deleted.', err);
			}
		});

		actions.replaceChildren(h('a', {class: 'button', 'data-link': `binders/new/checklist/${encodeURIComponent(id)}`, href: `${BASE}binders/new/checklist/${encodeURIComponent(id)}`, id: 'make-binder'}, 'Make a binder'), rename, remove);

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

	// An error or "not here" shows in its own slot, with the screen hidden
	// behind it, so a later load that finds the list (a first sync on a new
	// phone) shows it again (E-01).
	function showNotice(node) {
		content.hidden = Boolean(node);
		notice.replaceChildren(...[node].filter(Boolean));
	}

	async function load({force = false} = {}) {
		const run = ++loadRun;
		let data;

		try {
			data = await source.load();
		}
		catch (err) {
			if (!alive || run !== loadRun) {
				return;
			}

			showNotice(h('div', {class: 'notice', role: 'alert'}, h('p', null, source.readOnly
				? err.message || errorText(err)
				: `Your lists could not be read from this phone. ${errorText(err)}`)));

			return;
		}

		if (!alive || run !== loadRun) {
			return;
		}

		const found = data.goals.find((item) => item.id === id);

		if (!found) {
			showNotice(h('div', {class: 'card empty-state'},
				h('p', {class: 'big'}, 'This list is not here.'),
				h('p', {class: 'muted'}, 'It may have been deleted on another phone.')
			));

			return;
		}

		showNotice(null);
		goal = found;
		languages.update(goal);
		drawHead();
		drawActions();
		drawListIfChanged();

		const next = cardsSignature(data.entries);

		if (next === signature && !force) {
			// The same cards, though a price on one may have changed.
			if (result) {
				drawStats();
			}

			return;
		}

		const resolved = await resolveOwned(data.entries, {
			force,
			isAlive: () => alive && run === loadRun,
			onProgress: (step) => {
				if (alive && run === loadRun) {
					status.textContent = progressText(step);
				}
			},
		});

		if (!alive || run !== loadRun) {
			return;
		}

		// Set only once these cards are drawn, so a newer load that cut
		// this one short resolves them itself.
		signature = next;
		result = resolved;
		drawHead();
		drawList();
		drawStats();
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

	content.append(...[title, meta, languages.element, summary, statsSlot, status, filter, empty, list, editor, actions].filter(Boolean));
	root.append(back, notice, content);
	load();

	return () => {
		alive = false;
		stop();
	};
}
