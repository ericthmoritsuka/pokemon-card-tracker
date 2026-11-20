// The Stats screen (DESIGN.md section 11, "Stats"): what a collection holds,
// opened from Stats in the My Cards heading, beside Spares and Trades.
// Totals, then simple bars by language, set, rarity, type, finish, and
// condition, the most valuable cards, the copies with no price, and the
// copies added each month, and, on your own Stats, your lists' progress as
// the Lists tab last counted it. A family member's cards have their own
// Stats, view only. The numbers are js/stats.js; styles are css/stats.css.
//
// Worked out once per visit from what the phone already has: the copies,
// the card index, and the full records saved on the phone (the prices).
// Nothing is downloaded here; My Cards' background pass fills in prices,
// rarities, and types, and this screen says when some are still missing.
// The lists' progress is the count the Lists tab left (js/list-progress.js),
// shown with its day; the part is left out when Lists has counted none.
//
// Every bar is text first: each row reads its label, count, and share, and
// the bar beside them is drawn for the eye only (aria-hidden), so nothing
// rests on a bar's length or color.
//
// Routes (app.js ROUTES):
//   stats                  your own collection
//   family/<id>/stats      a family member's, read only

import {currentUser} from './auth.js';
import {entryInfo} from './binders-view.js';
import {cardIndex, savedCardRecords, setIdOfCard, viewingLanguage} from './catalog.js';
import {listChecklists} from './checklists.js';
import {listCards} from './collection.js';
import {offerCardList} from './card-swipe.js';
import {customRecord} from './custom-card.js';
import {BASE, errorText, h} from './dom.js';
import {whenMemberName} from './family.js';
import {formatCount, plural} from './format.js';
import {listGoals} from './goals.js';
import {languageLabel} from './languages.js';
import {cardStamp, readListProgress} from './list-progress.js';
import {formatBrl, savedRates} from './prices.js';
import {NOT_KNOWN, collectionStats, listsProgress, sharePercent} from './stats.js';
import {memberDocument} from './sync.js';
import {readValueHistory} from './value-history.js';
import {collectionHistory} from './value-history-view.js';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const monthName = (month) => `${MONTH_NAMES[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`;

const copies = (n) => plural(n, 'copy', 'copies');

// "~R$ 120,00" for a US estimate, as the Value sheet writes one.
const amount = (row) => `${row.kind === 'estimate' ? '~' : ''}${formatBrl(row.brl)}`;

let sectionCount = 0;

function section(title, ...children) {
	const id = `stats-section-${++sectionCount}`;

	return h('section', {'aria-labelledby': id, class: 'card stats-section'}, h('h3', {id}, title), ...children);
}

// One breakdown as bars: rows [{label, count}], each bar as long as its
// share of the largest row, its count and share of total as text.
function bars(rows, total, {id = null, percent = true} = {}) {
	const largest = Math.max(1, ...rows.map((row) => row.count));

	return h('ul', {class: 'stats-bars', id},
		rows.map((row) => h('li', {class: 'stats-bar-row', 'data-label': row.label},
			h('span', {class: 'stats-bar-label'}, row.label),
			h('span', {class: 'stats-bar-value'}, percent ? `${formatCount(row.count)} · ${sharePercent(row.count, total)}` : formatCount(row.count)),
			h('span', {'aria-hidden': 'true', class: 'stats-bar-track'},
				h('span', {class: 'stats-bar-fill', style: `width: ${row.count ? Math.max(2, (row.count / largest) * 100) : 0}%`}))
		))
	);
}

// What the copies' card is called and where its page is, in the viewing
// language (js/binders-view.js entryInfo, the trades log's names), with the
// set it counts under in the set bars.
function describer(index, viewing) {
	return (entry) => {
		const info = entryInfo(entry, index, viewing);
		const record = index.get(`${entry.catalog || 'international'}|${entry.card_id}`);
		const setId = entry.catalog === 'custom'
			? entry.set_code || entry.set_name_local || null
			: (record && record.set_id) || setIdOfCard(entry.card_id);

		return {
			name: info.name,
			route: info.route,
			setKey: setId ? `${entry.catalog || 'international'}|${setId}` : null,
			setName: info.setName || setId,
		};
	};
}

function totalsPart(totals) {
	const item = (value, label, id) => h('div', {class: 'stats-total', id},
		h('dt', null, label),
		h('dd', null, formatCount(value)));

	return h('dl', {class: 'card stats-totals', id: 'stats-totals'},
		item(totals.copies, totals.copies === 1 ? 'Copy' : 'Copies', 'stats-copies'),
		item(totals.cards, totals.cards === 1 ? 'Card' : 'Cards', 'stats-cards'),
		item(totals.sets, totals.sets === 1 ? 'Set' : 'Sets', 'stats-sets'),
		item(totals.languages, totals.languages === 1 ? 'Language' : 'Languages', 'stats-languages')
	);
}

function valuablePart(stats) {
	if (!stats.valuable.length) {
		return section('Most valuable', h('p', {class: 'muted', id: 'stats-valuable-none'}, 'No copy has a price yet. Prices download while My Cards is open.'));
	}

	const estimated = stats.valuable.some((row) => row.kind === 'estimate');

	offerCardList(stats.valuable.map((row) => row.route).filter(Boolean), 'Most valuable');

	return section('Most valuable',
		h('ol', {class: 'stats-valuable', id: 'stats-valuable'}, stats.valuable.map((row) => {
			const facts = [row.setName, languageLabel(row.entry.language), row.count > 1 ? `×${row.count}` : null].filter(Boolean).join(' · ');
			const content = [
				h('span', {class: 'stats-valuable-text'},
					h('span', {class: 'stats-valuable-name'}, row.name),
					h('span', {class: 'stats-valuable-facts'}, facts)),
				h('span', {class: 'stats-valuable-price'}, amount(row)),
			];

			return h('li', null, row.route
				? h('a', {class: 'stats-valuable-row', 'data-link': row.route, href: BASE + row.route}, content)
				: h('span', {class: 'stats-valuable-row'}, content));
		})),
		estimated ? h('p', {class: 'muted stats-note'}, '~ is a US market estimate at the dollar rate saved on this phone. Each row is one copy\'s value.') : h('p', {class: 'muted stats-note'}, 'Each row is one copy\'s value.')
	);
}

function unpricedPart(unpriced, total) {
	const lines = [];

	if (unpriced.asian) {
		lines.push(`${copies(unpriced.asian)} ${unpriced.asian === 1 ? 'is a Japanese, Korean, or Chinese print' : 'are Japanese, Korean, or Chinese prints'} with no market price.`);
	}

	if (unpriced.waiting) {
		lines.push(`${copies(unpriced.waiting)} still ${unpriced.waiting === 1 ? 'waits' : 'wait'} for a price; prices download while My Cards is open.`);
	}

	if (unpriced.none) {
		lines.push(`${copies(unpriced.none)} ${unpriced.none === 1 ? 'has' : 'have'} no market price on TCGdex.`);
	}

	if (unpriced.norate) {
		lines.push(`${copies(unpriced.norate)} ${unpriced.norate === 1 ? 'has' : 'have'} a US price but no exchange rate on this phone yet.`);
	}

	return section('No price',
		h('p', {class: 'stats-unpriced', id: 'stats-unpriced'}, unpriced.count
			? `${copies(unpriced.count)} of ${formatCount(total)} ${unpriced.count === 1 ? 'has' : 'have'} no price.`
			: 'Every copy has a price.'),
		lines.length ? h('ul', {class: 'stats-reasons'}, lines.map((line) => h('li', null, line))) : null
	);
}

const countDay = (at) => new Date(at).toLocaleDateString('en-US', {day: 'numeric', month: 'short'});

// Your lists' progress as the Lists tab last counted it: each list's name,
// linked to its screen, its "N of M" and share, and a bar as long as its
// share of the list (for the eye only). Says when it was counted, and when
// the cards have changed since.
function listsPart(lists) {
	const route = (row) => (row.kind === 'goal' ? 'goals/' : 'lists/') + encodeURIComponent(row.id);
	const notes = [
		lists.at ? `As counted on Lists on ${countDay(lists.at)}.` : 'As last counted on Lists.',
		lists.unresolved ? ` ${plural(lists.unresolved, 'card', 'cards')} could not be checked then.` : '',
	].join('');

	return section('Lists',
		h('ul', {class: 'stats-bars', id: 'stats-lists'}, lists.rows.map((row) => h('li', {class: 'stats-bar-row', 'data-label': row.name},
			h('a', {class: 'stats-bar-label', 'data-link': route(row), href: BASE + route(row)}, row.name),
			h('span', {class: 'stats-bar-value'}, `${formatCount(row.owned)} of ${formatCount(row.total)}${row.unit ? ` ${row.unit}` : ''} · ${sharePercent(row.owned, row.total)}`),
			h('span', {'aria-hidden': 'true', class: 'stats-bar-track'},
				h('span', {class: 'stats-bar-fill', style: `width: ${row.owned ? Math.max(2, (row.owned / row.total) * 100) : 0}%`}))
		))),
		h('p', {class: 'muted stats-note', id: 'stats-lists-when'}, notes),
		lists.changed
			? h('p', {class: 'muted stats-note', id: 'stats-lists-changed'}, 'Your cards have changed since. ',
				h('a', {'data-link': 'lists', href: `${BASE}lists`, id: 'stats-lists-open'}, 'Open Lists'), ' to count again.')
			: null
	);
}

// Your lists' saved progress, read from this phone only: null when Lists
// has counted none, or when they cannot be read.
async function savedLists() {
	try {
		const [checklists, goals, stamp] = await Promise.all([listChecklists(), listGoals(), cardStamp()]);

		return listsProgress({checklists, goals, saved: readListProgress(), stamp});
	}
	catch {
		return null;
	}
}

function draw(stats, {history, lists}) {
	const total = stats.totals.copies;
	const top = stats.sets.top;
	const waiting = (rows) => rows.some((row) => row.label === NOT_KNOWN);
	const later = (rows) => (waiting(rows) ? h('p', {class: 'muted stats-note'}, `${NOT_KNOWN} fills in as card details download while My Cards is open.`) : null);

	return [
		totalsPart(stats.totals),
		section('By language', bars(stats.language, total, {id: 'stats-language'})),
		section('By set',
			bars(top, total, {id: 'stats-set'}),
			stats.sets.more ? h('p', {class: 'muted stats-more', id: 'stats-set-more'}, `And ${plural(stats.sets.more, 'more set', 'more sets')}, ${copies(stats.sets.moreCopies)}.`) : null),
		section('By rarity', bars(stats.rarity, total, {id: 'stats-rarity'}), later(stats.rarity)),
		section('By type',
			bars(stats.type, total, {id: 'stats-type'}),
			stats.typeShared ? h('p', {class: 'muted stats-note'}, 'A card of two types counts under both.') : null,
			later(stats.type)),
		section('By finish', bars(stats.finish, total, {id: 'stats-finish'})),
		section('By condition', bars(stats.condition, total, {id: 'stats-condition'})),
		valuablePart(stats),
		unpricedPart(stats.unpriced, total),
		section('Added per month',
			bars(stats.months.map((row) => ({count: row.count, label: monthName(row.month)})), total, {id: 'stats-months', percent: false}),
			h('p', {class: 'muted stats-note'}, [
				stats.before ? `${copies(stats.before)} added before then. ` : '',
				'Imported cards count in the month they were imported.',
			].join(''))),
		lists ? listsPart(lists) : null,
		history ? h('div', {class: 'card stats-section'}, collectionHistory(history)) : null,
	].filter(Boolean);
}

// The screen for some copies. load() gives the live copies; back is where
// "‹" goes; ownHistory adds the value over time kept on this phone (your
// own cards only, as the Value sheet has it); ownLists adds your lists'
// progress as Lists last counted it.
function statsScreen(root, {back, backLabel, load, ownHistory = false, ownLists = false, title}) {
	let alive = true;
	const body = h('div', {class: 'stats-body', id: 'stats-body'}, h('p', {class: 'muted'}, 'Counting…'));

	root.append(
		h('a', {class: 'back', 'data-link': back, href: BASE + back, id: 'stats-back'}, `‹ ${backLabel}`),
		h('div', {class: 'view-head'}, h('h2', null, title)),
		body
	);

	(async () => {
		const [entries, index, lists] = await Promise.all([load(), cardIndex().catch(() => new Map()), ownLists ? savedLists() : null]);
		const saved = await savedCardRecords(entries).catch(() => new Map());

		// A hand-made card's own fields stand in for its record, and it has
		// no market price, as on My Cards.
		for (const entry of entries) {
			const custom = customRecord(entry);

			if (custom) {
				saved.set(`${entry.catalog}|${entry.card_id}`, custom);
			}
		}

		if (!alive) {
			return;
		}

		if (!entries.length) {
			body.replaceChildren(h('div', {class: 'card empty-state', id: 'stats-empty'}, h('p', {class: 'big'}, 'No cards yet'), h('p', {class: 'muted'}, 'Stats show once there are cards.')));

			return;
		}

		const stats = collectionStats(entries, {
			describe: describer(index, viewingLanguage()),
			rates: savedRates(),
			records: new Map([...index, ...saved]),
			saved,
		});
		const user = currentUser();

		body.replaceChildren(...draw(stats, {history: ownHistory ? readValueHistory((user && user.id) || 'local') : null, lists}));
	})().catch((err) => {
		if (alive) {
			body.replaceChildren(h('div', {class: 'notice', role: 'alert'}, h('p', null, err && err.statsText ? err.message : `Stats could not be worked out. ${errorText(err)}`)));
		}
	});

	return () => {
		alive = false;
	};
}

export function statsView(root) {
	return statsScreen(root, {
		back: 'cards',
		backLabel: 'My Cards',
		load: async () => (await listCards()).filter((entry) => entry && !entry.deleted_at),
		ownHistory: true,
		ownLists: true,
		title: 'Stats',
	});
}

// Said as it is, not after "could not be worked out".
const plainError = (message) => Object.assign(new Error(message), {statsText: true});

// A family member's stats, read only: their document is read from the
// server each time, as their My Cards is, and priced with the records and
// rate on this phone.
export function familyStatsView(root, {userId}) {
	whenMemberName(userId, (name) => {
		document.title = `${name}'s stats | Card Tracker`;

		const heading = root.querySelector('.view-head h2');
		const back = root.querySelector('#stats-back');

		if (heading) {
			heading.textContent = `${name}'s stats`;
		}

		if (back) {
			back.textContent = `‹ ${name}'s cards`;
		}
	});

	return statsScreen(root, {
		back: `family/${encodeURIComponent(userId)}`,
		backLabel: 'Their cards',
		load: async () => {
			if (!currentUser()) {
				throw plainError('Sign in to see your family\'s cards.');
			}

			if (!navigator.onLine) {
				throw plainError('A family member\'s cards show when you are online.');
			}

			const doc = await memberDocument(userId);

			return ((doc && doc.cards) || []).filter((entry) => entry && !entry.deleted_at);
		},
		title: 'Family member\'s stats',
	});
}

export const statsRoutes = [
	{pattern: /^stats$/, render: statsView, tab: 'cards', title: 'Stats | Card Tracker'},
	{keys: ['userId'], pattern: /^family\/([^/]+)\/stats$/, render: familyStatsView, tab: 'cards', title: 'Family stats | Card Tracker'},
];

export const statsAccountViews = [statsView, familyStatsView];
