// Check spares (Eric, 2026-11-25): every card he has more than once, each
// copy with where it is and why it counts as free or not (js/spare-check.js),
// and "I don't have this one" on each, which logs the copy as given away in
// the trades log (js/moves.js, a gift with no money), so the spares, the
// Shop, and HOTARU follow. Undo on the toast takes the gift back. A copy
// that was offered on HOTARU is withdrawn at once when he is the shop owner
// and online (js/store-publish.js withdrawListings); otherwise the Shop's
// next publish withdraws it, as the copy is gone.
//
// Routes (app.js):
//   trade/check                     every card with more than one copy,
//                                   from the Spares screen
//   trade/check/<lang>/<cardId>     one card in every language, from the
//                                   card page's Check next to the copies

import {artOf, entryInfo, fillRecords} from './binders-view.js';
import {catalogFor, cardIndex, printedCode, viewingLanguage} from './catalog.js';
import {loadDocument, onChange} from './collection.js';
import {languageName} from './copy-sheet.js';
import {isCustomId} from './custom-card.js';
import {BASE, backWords, errorText, h} from './dom.js';
import {formatCount, freeText, plural} from './format.js';
import {applyMove, undoMove} from './moves.js';
import {undoneText} from './moves-view.js';
import {toast} from './shell.js';
import {shopOwnerKnown} from './shop-owner.js';
import {REASONS, goneFields, placeLabel, spareCheck} from './spare-check.js';
import {withdrawListings} from './store-publish.js';
import {FINISHES, entryFinish, tileArt} from './tile.js';

const UNDO_MS = 8000;
const PAGE = 30;

// The phone's own day, YYYY-MM-DD, as the trades log dates a move.
function today() {
	const now = new Date();

	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// "Reverse holo · Near Mint", or "Regular" for the plain print.
function copyWords(entry) {
	const code = entryFinish(entry);

	return [code && FINISHES[code] ? FINISHES[code].label : 'Regular', entry.condition].filter(Boolean).join(' · ');
}

// "Hoenn, page 3, pocket 4", "Loose", or both places of a copy two binders
// claim, so a clash shows rather than hides.
const whereText = (places) => (places.length ? places.map(placeLabel).join(' · also ') : placeLabel(null));

export function spareCheckView(root, {cardId = null, lang = null} = {}) {
	let alive = true;
	let index = new Map();
	let shown = PAGE;
	let focusKey = null;
	const one = cardId ? {card_id: cardId, catalog: isCustomId(cardId) ? 'custom' : catalogFor(lang)} : null;
	const viewing = viewingLanguage();
	const back = one ? `cards/${encodeURIComponent(lang)}/${encodeURIComponent(cardId)}` : 'trade';
	const summary = h('p', {'aria-live': 'polite', class: 'muted', id: 'check-summary'}, 'Reading your cards…');
	const list = h('div', {class: 'check-list', id: 'check-list'});

	root.append(
		h('a', {class: 'back', 'data-link': back, href: BASE + back, id: 'check-back'}, backWords(one ? 'Card' : 'Spares')),
		h('div', {class: 'view-head'}, h('h2', {id: 'check-title', tabindex: '-1'}, 'Check spares')),
		h('p', {class: 'muted check-intro'}, 'Where every copy is, and why it counts as free or not. If you cannot find one, tap I don\'t have this one: it is logged in Trades as given away, so your spares and the Shop follow. Undo takes it back.'),
		summary,
		list
	);

	async function giveAway(row, info, button) {
		button.disabled = true;

		try {
			const {move} = await applyMove(goneFields(row.entry.id, {date: today()}));

			toast(`${info.name} logged as given away.`, {
				action: async () => {
					try {
						toast(undoneText(await undoMove(move.id)), {timeout: UNDO_MS});
					}
					catch (err) {
						toast(err.stale ? err.message : `Not undone. ${errorText(err)}`);
					}
				},
				actionLabel: 'Undo',
				timeout: UNDO_MS,
			});

			// Off HOTARU now, rather than at the next publish.
			if (row.free && shopOwnerKnown() === true && navigator.onLine) {
				withdrawListings([row.entry.id]).catch(() => {});
			}
		}
		catch (err) {
			if (alive && button.isConnected) {
				button.disabled = false;
			}

			toast(`Not saved. ${errorText(err)}`);
		}
	}

	function copyItem(row, info) {
		const reason = REASONS[row.reason];
		const button = h('button', {class: 'small check-gone', type: 'button'}, 'I don\'t have this one');

		button.setAttribute('aria-label', `I don't have this one: ${copyWords(row.entry)}, ${whereText(row.places)}`);
		button.onclick = () => {
			focusKey = row.groupKey;
			giveAway(row, info, button);
		};

		return h('li', {class: row.free ? 'check-copy is-free' : 'check-copy', 'data-entry': row.entry.id},
			h('div', {class: 'check-copy-text'},
				h('span', {class: 'check-copy-what'}, copyWords(row.entry)),
				h('span', {class: 'check-copy-where'}, whereText(row.places)),
				h('span', {class: 'check-copy-why'}, h('span', {class: row.free ? 'check-tag is-free' : 'check-tag'}, reason.label), ` ${reason.text}`)),
			button);
	}

	function groupNode(group) {
		const info = entryInfo(group.rows[0].entry, index, viewing);
		const art = artOf({catalog: group.catalog, card_id: group.card_id, language: group.language}, info, (src) => tileArt({
			count: group.copies,
			decorative: true,
			free: group.free,
			info,
			languages: [group.language],
			src,
			viewing: null,
		}));
		const headingId = `check-${group.key.replace(/[^a-z0-9]+/gi, '-')}`;

		return h('section', {'aria-labelledby': headingId, class: 'card check-group', 'data-key': group.key},
			h('div', {class: 'check-head'},
				h('a', {'aria-hidden': 'true', class: 'check-thumb', 'data-link': info.route, href: BASE + info.route, tabindex: '-1'}, art),
				h('div', {class: 'check-head-text'},
					h('h3', {class: 'check-name', id: headingId, tabindex: '-1'}, h('a', {'data-link': info.route, href: BASE + info.route}, info.name)),
					h('span', {class: 'check-meta'}, [info.number ? `#${info.number}` : null, info.setName, languageName(group.language)].filter(Boolean).join(' · ')),
					h('span', {class: group.free ? 'check-count is-free' : 'check-count'}, freeText(group.copies, group.free)))),
			h('ul', {class: 'check-copies'}, ...group.rows.map((row) => copyItem({...row, groupKey: group.key}, info))));
	}

	function draw(groups) {
		const free = groups.reduce((sum, group) => sum + group.free, 0);
		const copies = groups.reduce((sum, group) => sum + group.copies, 0);

		if (!groups.length) {
			summary.textContent = one ? 'You have no copies of this card.' : 'No card has more than one copy.';
			list.replaceChildren();

			return;
		}

		summary.textContent = one
			? freeText(copies, free)
			: `${plural(groups.length, 'card', 'cards')} with more than one copy: ${plural(copies, 'copy', 'copies')}, ${formatCount(free)} free.`;

		const visible = groups.slice(0, shown);
		const more = groups.length - visible.length;

		const moreButton = more > 0
			? h('button', {class: 'check-more', id: 'check-more', onclick: () => {
				shown += PAGE;
				draw(groups);
			}, type: 'button'}, `Show ${formatCount(Math.min(more, PAGE))} more`)
			: null;

		list.replaceChildren(...visible.map(groupNode), ...(moreButton ? [moreButton] : []));

		// After a copy goes, the focus stays at its card, or at the title
		// when the card left the list.
		if (focusKey !== null) {
			const section = [...list.querySelectorAll('.check-group')].find((node) => node.dataset.key === focusKey);
			const target = section ? section.querySelector('.check-name') : root.querySelector('#check-title');

			focusKey = null;

			if (target) {
				target.focus();
			}
		}

		const missing = visible.map((group) => ({cardId: group.card_id, catalog: group.catalog}));

		fillRecords(missing, index, () => alive).then((next) => {
			if (next && alive) {
				index = next;
				draw(groups);
			}
		}).catch(() => {});
	}

	const check = (doc) => spareCheck(doc, {codeOf: printedCode, only: one});

	(async () => {
		const [doc, found] = await Promise.all([loadDocument(), cardIndex().catch(() => new Map())]);

		if (!alive) {
			return;
		}

		index = found;
		draw(check(doc));
	})().catch((err) => {
		if (alive) {
			summary.textContent = '';
			list.replaceChildren(h('div', {class: 'notice', role: 'alert'}, h('p', null, `Your cards could not be read. ${errorText(err)}`)));
		}
	});

	const stop = onChange((doc) => {
		if (alive && doc && Array.isArray(doc.cards)) {
			draw(check(doc));
		}
	});

	return () => {
		alive = false;
		stop();
	};
}

export const spareCheckRoutes = [
	{pattern: /^trade\/check$/, render: spareCheckView, tab: 'cards', title: 'Check spares | Card Tracker'},
	{keys: ['lang', 'cardId'], pattern: /^trade\/check\/([^/]+)\/([^/]+)$/, render: spareCheckView, tab: 'cards', title: 'Check spares | Card Tracker'},
];

export const spareCheckAccountViews = [spareCheckView];
