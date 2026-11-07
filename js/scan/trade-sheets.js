// What the scanner's Trade or sale mode draws (js/scan/trade.js; Eric,
// 2026-11-06): the mode switch over the camera, the two-sided tray, the
// line a card's sheet shows about its side and copy, the copy picker, and
// the question asked before the trade tray is thrown away. js/scan/view.js
// runs them; each sheet is {el, itemId, refresh}, as js/scan/sheets.js
// builds them, so the view redraws it after every change.

import {cardImage, languageLabel} from '../catalog.js';
import {h} from '../dom.js';
import {flagBadge, flagLanguageName} from '../flags.js';
import {plural} from '../format.js';
import {copyTile, described} from '../moves-view.js';
import {variantLabel} from '../wishlist.js';
import {findVariant} from './finish.js';
import {blocker, copiesOf, findItem} from './session.js';
import {outLine, SIDE_NAMES, sideOf, whereText} from './trade.js';

export const langName = (code) => flagLanguageName(code) || languageLabel(code);

// The trade tray's button and the sheets that name it: "Log 1 card", "Log 3
// cards", counting the tray as Done counts the Add tray (design polish,
// 2026-11-06; it was "Log it").
export const logLabel = (count) => (count ? `Log ${plural(count, 'card')}` : 'Log cards');

const STATUS_TEXT = {
	finish: 'Pick the finish',
	finishes: 'Loading finishes',
	language: 'Pick the language',
	matching: 'Looking it up…',
	reading: 'Reading…',
	rematch: 'Looking it up…',
	unmatched: 'Not found',
	unsure: 'To check',
	waiting: 'Waiting for signal',
};

function sheetHeader(title, onClose, id) {
	return h('div', {class: 'scan-sheet-head'},
		h('span', {'aria-hidden': 'true', class: 'scan-sheet-grip'}),
		h('h2', {class: 'scan-sheet-title', id}, title),
		h('button', {class: 'scan-text-button', id: 'scan-sheet-close', onclick: onClose, type: 'button'}, 'Close')
	);
}

// ------------------------------------------------------------ the mode switch

// The scanning mode, at the head of the tray under the camera: two
// segments, Add and Trade or sale, the one in use pressed (teal for Trade
// or sale), so the mode is always in sight and never over the picture
// (design review, 2026-11-06). Pressing the other segment asks to switch;
// the view may refuse, and draws the switch again either way. The count
// beside it gives way when the row is short.
export function modeSwitch(onChoose) {
	const segment = (mode, label) => h('button', {'aria-pressed': 'false', class: 'scan-mode-segment', 'data-mode-to': mode, id: `scan-mode-${mode}`, onclick: () => onChoose(mode), type: 'button'}, label);

	return h('div', {'aria-label': 'Scan mode', class: 'scan-mode', 'data-mode': 'add', id: 'scan-mode', role: 'group'},
		segment('add', 'Add'),
		segment('trade', 'Trade or sale'));
}

export function drawModeSwitch(el, mode) {
	el.dataset.mode = mode === 'trade' ? 'trade' : 'add';

	for (const button of el.querySelectorAll('[data-mode-to]')) {
		button.setAttribute('aria-pressed', String(button.dataset.modeTo === el.dataset.mode));
	}
}

// ------------------------------------------------------------ the tray

// The trade tray: two columns, Going out and Coming in. Each column's head
// says how many cards it holds and, pressed, sends the next scans there:
// the column the scans go to has a filled head, the other says "Tap to scan
// here" under its name, and an empty column says what it is for ("Cards you
// give", "Cards you get"; design polish, 2026-11-06).
// A row is a card: its photo, its name, and what happens to it (for a card
// going out, which copy goes, or why none does), with Pick when Eric must
// choose the copy, and an x that takes it out of the tray with Undo.
// Newest first in each column, as the Add tray.
export function tradeColumns({languageName = langName, photoUrl, results, session, where}) {
	const column = (side) => {
		const items = session.items.filter((item) => sideOf(item) === side).reverse();
		const on = (session.side === 'in' ? 'in' : 'out') === side;

		return h('li', {'aria-label': SIDE_NAMES[side], class: `scan-trade-col${on ? ' is-next' : ''}`, 'data-side': side, id: `scan-trade-${side}`},
			h('button', {
				'aria-label': `${SIDE_NAMES[side]}: ${plural(items.length, 'card')}.${on ? ' The next scans go here.' : ' Tap to send the next scans here.'}`,
				'aria-pressed': String(on),
				class: 'scan-trade-head',
				'data-side-to': side,
				id: `scan-side-${side}`,
				type: 'button',
			},
			h('span', {class: 'scan-trade-name'}, SIDE_NAMES[side]),
			h('span', {class: 'scan-trade-count'}, String(items.length)),
			on ? null : h('span', {'aria-hidden': 'true', class: 'scan-trade-next'}, 'Tap to scan here')),
			h('ul', {class: 'scan-trade-rows'}, ...(items.length
				? items.map((item) => tradeRow(item, {languageName, photoUrl: photoUrl(item.id), result: side === 'out' ? results.get(item.id) : null, where}))
				: [h('li', {class: 'scan-trade-empty'}, side === 'out' ? 'Cards you give' : 'Cards you get')])));
	};

	return [column('out'), column('in')];
}

function tradeRow(item, {languageName, photoUrl, result, where}) {
	const reason = blocker(item);
	const side = sideOf(item);
	const name = item.card ? item.card.name : reason ? STATUS_TEXT[reason] || 'Unknown card' : 'Unknown card';
	const copies = copiesOf(item);
	const looks = reason && reason !== 'finishes' && !['reading', 'matching', 'rematch', 'waiting'].includes(reason);
	const status = side === 'out' && !reason && result ? result.status : null;
	const line = reason
		? item.card ? STATUS_TEXT[reason] : null
		: side === 'out'
			? outLine(result, {languageName, where})
			: [languageName(item.language), item.condition].filter(Boolean).join(' · ');
	// Pick when Eric must choose; changing a copy the scanner chose is on the
	// card's sheet (tradeBlock), so the narrow row keeps room for the name.
	// No button when nothing is left to pick: the line says to remove the card.
	const pick = (status === 'ask' || status === 'other') && Boolean((result.candidates || []).length);
	// Beside Pick a copy the row says only how many copies match: the
	// button says what to do (design review, 2026-11-06, 360 px rows).
	const shown = pick && status === 'ask' ? `${result.candidates.length} match` : line;

	return h('li', {class: ['scan-trade-row', looks ? 'is-look' : '', status === 'none' || status === 'other' ? 'is-skipped' : '', status === 'ask' ? 'is-ask' : ''].filter(Boolean).join(' '), 'data-row': item.id, 'data-status': status || reason || 'ready'},
		h('button', {
			'aria-label': [name, item.language ? languageName(item.language) : null, copies > 1 ? `${copies} copies` : null, line].filter(Boolean).join(', '),
			class: 'scan-trade-open',
			'data-item': item.id,
			type: 'button',
		},
		h('span', {class: 'scan-trade-thumb'},
			photoUrl ? h('img', {alt: '', decoding: 'async', src: photoUrl}) : h('span', {class: 'scan-tile-blank'}),
			item.language ? flagBadge([item.language], {className: 'scan-trade-flag'}) : null),
		h('span', {class: 'scan-trade-text'},
			h('span', {class: 'scan-trade-title'}, copies > 1 ? `×${copies} ${name}` : name),
			shown ? h('span', {class: 'scan-trade-line'}, shown) : null)),
		h('button', {'aria-label': `Remove ${item.card ? item.card.name : 'this scan'}`, class: 'scan-trade-remove', 'data-remove': item.id, title: 'Remove', type: 'button'},
			h('span', {'aria-hidden': 'true'}, '×')),
		pick ? h('button', {'aria-label': `Pick the copy of ${name} that goes out`, class: 'scan-trade-pick', 'data-pick': item.id, type: 'button'}, 'Pick a copy') : null);
}

// ------------------------------------------------------------ a card's sheet

// What a card's confirm sheet says in the trade tray: its side, with Move
// to the other side, and for a card going out the copy that goes, with Pick
// the copy.
export function tradeBlock(item, {languageName = langName, onMove, onPick, result, where}) {
	const side = sideOf(item);
	const other = side === 'out' ? 'in' : 'out';
	const line = side === 'out' ? outLine(result, {languageName, where}) : 'A new copy, added when the trade or sale is logged.';
	const canPick = side === 'out' && result && result.candidates.length && result.status !== 'none';

	return h('div', {class: 'scan-frame scan-trade-block', id: 'scan-trade-block'},
		h('p', {id: 'scan-trade-side'}, h('strong', null, SIDE_NAMES[side]), line ? ` · ${line}` : ''),
		h('div', {class: 'scan-row'},
			canPick ? h('button', {class: 'scan-button', id: 'scan-trade-pick', onclick: () => onPick(item.id), type: 'button'}, result.status === 'chosen' ? 'Change the copy' : 'Pick a copy') : null,
			h('button', {class: 'scan-button', id: 'scan-trade-move', onclick: () => onMove(item.id, other), type: 'button'}, `Move to ${SIDE_NAMES[other]}`)));
}

// Where a copy is, short enough for a tile: "Binder A, p. 3", "Binder A,
// tray", its storage place, or "Loose".
function whereShort(where, entry) {
	if (where && where.kind === 'pocket') {
		return `${where.binder_name}, p. ${where.page}`;
	}

	if (where && where.kind === 'tray') {
		return `${where.binder_name}, tray`;
	}

	return entry.storage || 'Loose';
}

// The copies a card going out may take, as tiles (design review,
// 2026-11-06): each copy's picture with its language, then in 14 px its
// condition in bold (and its finish, only when it is known), where it is,
// and Spare and Suggested as chips. A picked tile has a teal ring and a
// check. on(entry) says whether a tile is picked; tap(entry, on) runs when
// it is pressed.
function copyTiles(ctx, item, result, {on, tap}) {
	const suggested = new Set(result.suggested);
	// Every copy is of the card scanned, so a copy the card index does not
	// name yet shows the scanned card's name and picture.
	const own = {image: item.card.image ? cardImage(item.card.image, 'low') : null, name: item.card.name, number: item.card.localId, setName: item.card.setName || null};

	return described(result.candidates, ctx.cardIndex, ctx.viewing).map((one) => {
		const known = one.info.name && one.info.name !== one.entry.card_id;
		const shown = {...one, info: {...one.info, ...(known ? {} : {name: own.name, number: own.number, setName: own.setName}), image: one.info.image || own.image}};
		const {entry} = shown;
		const finish = entry.variant_id ? variantLabel(findVariant(item.variants, entry.variant_id)) : null;
		const place = whereShort(ctx.where.get(entry.id), entry);
		const spare = ctx.isSpare(entry.id);
		const best = suggested.has(entry.id);
		const pressed = on(entry);
		const [art] = copyTile(shown, {selected: pressed});

		return h('button', {
			'aria-label': [entry.condition || 'Condition not set', finish, whereText(ctx.where.get(entry.id), entry), spare ? 'spare' : null, best ? 'suggested' : null].filter(Boolean).join(', '),
			'aria-pressed': String(pressed),
			class: `pick scan-copy${best ? ' is-suggested' : ''}`,
			'data-entry': entry.id,
			onclick: () => tap(entry, pressed),
			type: 'button',
		},
		art,
		h('span', {class: 'scan-copy-line'}, h('strong', null, entry.condition || 'Condition not set'), finish ? ` · ${finish}` : ''),
		h('span', {class: 'scan-copy-where'}, place),
		spare || best ? h('span', {class: 'scan-copy-chips'},
			best ? h('span', {class: 'scan-copy-chip is-suggested'}, 'Suggested') : null,
			spare ? h('span', {class: 'scan-copy-chip'}, 'Spare') : null) : null);
	});
}

// ------------------------------------------------------------ the copy picker

// Which of Eric's copies goes out for one scanned card: each copy as a
// picture with its language, finish, condition, and where it is (a binder
// pocket, a binder's tray, a storage place, or no binder), spares marked,
// best first. A card standing for several copies picks that many; one copy
// is picked with one tap.
// The copies tapped for a card standing for several, as each draw of a
// sheet should show them: until he taps one, the copies the scanner has for
// it now (they change when another card takes one); after, his taps, less
// any copy no longer offered (taken by another card, or gone).
function tappedNow(tapped, result) {
	if (!tapped) {
		return new Set(result.copies.map((entry) => entry.id));
	}

	const offered = new Set(result.candidates.map((entry) => entry.id));

	return new Set([...tapped].filter((id) => offered.has(id)));
}

export function copyPicker(ctx, itemId) {
	const titleId = 'scan-copy-title';
	const body = h('div', {class: 'scan-sheet-body'});
	const el = h('div', {'aria-labelledby': titleId, 'aria-modal': 'true', class: 'scan-sheet scan-copy-sheet', id: 'scan-copy-sheet', role: 'dialog'},
		sheetHeader('Which copy goes out?', () => ctx.closeSheet(), titleId),
		body);
	let tapped = null;
	let chosen = null;

	function refresh() {
		const item = findItem(ctx.session, itemId);
		const result = item ? ctx.outResult(itemId) : null;

		if (!item || !result || !result.candidates.length) {
			ctx.closeSheet();

			return;
		}

		const need = result.need;

		chosen = tappedNow(tapped, result);

		const fits = result.status !== 'other';
		const intro = need > 1
			? `Pick the ${need} copies of ${item.card.name} that go out.`
			: fits
				? `${plural(result.candidates.length, 'copy fits', 'copies fit')} the ${langName(item.language)} card you scanned. Pick the one that goes out.`
				: `None of your copies is ${langName(item.language)}${item.variantId ? ' in this finish' : ''}. Pick one only if it is the card in your hand.`;
		const tiles = copyTiles(ctx, item, result, {
			on: (entry) => chosen.has(entry.id),
			tap: (entry, on) => {
				if (need === 1) {
					ctx.pickCopies(itemId, [entry.id]);
					ctx.closeSheet();

					return;
				}

				if (on) {
					chosen.delete(entry.id);
				}
				else if (chosen.size < need) {
					chosen.add(entry.id);
				}

				tapped = chosen;
				refresh();
			},
		});

		body.replaceChildren(...[
			h('p', {class: 'scan-muted', id: 'scan-copy-intro'}, intro),
			h('div', {class: 'pick-grid scan-copy-grid', id: 'scan-copy-grid'}, ...tiles),
			need > 1 ? h('button', {class: 'scan-button scan-primary scan-wide', disabled: chosen.size !== need, id: 'scan-copy-done', onclick: () => {
				ctx.pickCopies(itemId, [...chosen]);
				ctx.closeSheet();
			}, type: 'button'}, `Done (${chosen.size} of ${need})`) : null,
			result.by === 'hand' ? h('button', {class: 'scan-button scan-wide', id: 'scan-copy-auto', onclick: () => {
				ctx.pickCopies(itemId, []);
				ctx.closeSheet();
			}, type: 'button'}, 'Let the scanner choose') : null,
		].filter(Boolean));
	}

	refresh();

	return {el, itemId, refresh};
}

// ------------------------------------------------------------ every pick at once

// Every card going out whose copy Eric must pick, on one sheet (Eric,
// 2026-11-06: "it doesn't show me all the cards I have to pick right away.
// I have to click Log it and another card shows up. Log it, another card
// shows up. Log it... it's upsetting"). Log it opens it whenever a card
// asks. Each card shows its copies as the copy picker does, and he picks
// them in any order; the pick that settles the last one goes on to the
// trades log's form by itself (ctx.logIt), and Log it at the foot does the
// same once all are picked. A card stays listed once picked, so a pick can
// be changed before that; one that starts asking after a pick (its copy
// went to another card) joins the list. Cards going out that cannot go out
// are listed under them with the line the tray shows, so nothing is a
// surprise. The tray's Pick a copy still opens the copy picker for one
// card.
export function picksSheet(ctx) {
	const titleId = 'scan-picks-title';
	const body = h('div', {class: 'scan-sheet-body'});
	const el = h('div', {'aria-labelledby': titleId, 'aria-modal': 'true', class: 'scan-sheet scan-copy-sheet scan-picks-sheet', id: 'scan-picks-sheet', role: 'dialog'},
		sheetHeader('Which copies go out?', () => ctx.closeSheet(), titleId),
		body);
	const listed = new Set();
	// For a card standing for several copies: the copies tapped so far, kept
	// here until there are as many as it stands for (tappedNow; an untapped
	// card shows the scanner's copies as they are now).
	const tapped = new Map();
	const chosen = new Map();
	const outs = () => ctx.session.items.filter((item) => sideOf(item) === 'out');
	const skipped = (result) => result.status === 'none' || result.status === 'other';

	// The pick that leaves no card asking goes on to the form.
	function onward() {
		if (!ctx.tradeAsks()) {
			ctx.logIt();
		}
	}

	function card(item, result) {
		const need = result.need;
		const nameId = `scan-picks-name-${item.id}`;

		if (need > 1) {
			chosen.set(item.id, tappedNow(tapped.get(item.id), result));
		}

		const tiles = copyTiles(ctx, item, result, {
			on: (entry) => (need > 1 ? chosen.get(item.id).has(entry.id) : result.status === 'chosen' && result.copies.some((one) => one.id === entry.id)),
			tap: (entry, on) => {
				if (need === 1) {
					ctx.pickCopies(item.id, [entry.id]);
					onward();

					return;
				}

				const set = chosen.get(item.id);

				if (on) {
					set.delete(entry.id);
				}
				else if (set.size < need) {
					set.add(entry.id);
				}

				tapped.set(item.id, set);

				if (set.size === need) {
					ctx.pickCopies(item.id, [...set]);
					onward();

					return;
				}

				if (item.picked) {
					ctx.pickCopies(item.id, []);
				}

				refresh();
			},
		});

		return h('section', {'aria-labelledby': nameId, class: 'scan-picks-card', 'data-pick-item': item.id, 'data-status': result.status},
			h('h3', {class: 'scan-picks-name', id: nameId}, [need > 1 ? `×${need} ${item.card.name}` : item.card.name, langName(item.language)].join(' · ')),
			h('p', {class: 'scan-muted scan-picks-line'}, outLine(result, {languageName: langName, where: ctx.where})),
			tiles.length ? h('div', {class: 'pick-grid scan-copy-grid'}, ...tiles) : null);
	}

	function refresh() {
		const rows = [];

		for (const item of outs()) {
			const result = ctx.outResult(item.id);

			if (!item.card || !result) {
				continue;
			}

			if (result.status === 'ask' || skipped(result)) {
				listed.add(item.id);
			}

			if (listed.has(item.id)) {
				rows.push([item, result]);
			}
		}

		const toPick = rows.filter(([, result]) => !skipped(result));

		if (!toPick.length) {
			ctx.closeSheet();

			return;
		}

		const left = toPick.filter(([, result]) => result.status === 'ask').length;
		const notLogged = rows.filter(([, result]) => skipped(result));

		body.replaceChildren(...[
			h('p', {class: 'scan-muted', id: 'scan-picks-intro'}, left
				? `${toPick.some(([, result]) => result.need > 1) ? 'Pick the copies for each card.' : 'Pick one copy for each card.'} The trade form opens when ${toPick.length === 1 ? 'it is' : `all ${toPick.length} are`} picked.`
				: `All picked. ${logLabel(ctx.session.items.length)} opens the trades log.`),
			...toPick.map(([item, result]) => card(item, result)),
			notLogged.length ? h('h3', {class: 'scan-picks-head', id: 'scan-picks-skipped'}, 'Not logged') : null,
			...notLogged.map(([item, result]) => h('section', {class: 'scan-picks-card is-skipped', 'data-pick-item': item.id, 'data-status': result.status},
				h('h3', {class: 'scan-picks-name'}, [item.card.name, langName(item.language)].join(' · ')),
				h('p', {class: 'scan-muted scan-picks-line'}, outLine(result, {languageName: langName, where: ctx.where})))),
			h('button', {class: 'scan-button scan-primary scan-wide', disabled: left > 0, id: 'scan-picks-go', onclick: () => ctx.logIt(), type: 'button'}, left ? `${logLabel(ctx.session.items.length)} (${left} to pick)` : logLabel(ctx.session.items.length)),
		].filter(Boolean));
	}

	refresh();

	return {el, itemId: null, refresh};
}

// ------------------------------------------------------------ before the tray goes

// Asked before the trade tray is thrown away: switching to Add, or Close.
// Nothing in the collection has changed, so throwing it away loses only the
// scans.
export function leaveTradeSheet(ctx, {count, action, onLeave}) {
	const titleId = 'scan-leave-title';
	const el = h('div', {'aria-labelledby': titleId, 'aria-modal': 'true', class: 'scan-sheet scan-leave-sheet', id: 'scan-leave-sheet', role: 'dialog'},
		sheetHeader(`Discard ${plural(count, 'card')}?`, () => ctx.closeSheet(), titleId),
		h('div', {class: 'scan-sheet-body'},
			h('p', {id: 'scan-leave-text'}, `The trade tray holds ${plural(count, 'card')} not logged yet. Nothing in your cards has changed. ${logLabel(count)} saves them in Trades and sales; ${action.toLowerCase()} throws them away.`),
			h('div', {class: 'scan-row'},
				h('button', {class: 'scan-button', id: 'scan-leave-keep', onclick: () => ctx.closeSheet(), type: 'button'}, 'Keep them'),
				h('button', {class: 'scan-button scan-danger', id: 'scan-leave-go', onclick: onLeave, type: 'button'}, action))));

	return {el, itemId: null, refresh: () => {}};
}
