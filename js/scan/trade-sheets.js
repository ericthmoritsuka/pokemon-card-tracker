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

const STATUS_TEXT = {
	finish: 'Pick the finish',
	finishes: 'Loading finishes',
	language: 'Pick the language',
	matching: 'Looking it up…',
	reading: 'Reading…',
	rematch: 'Looking it up…',
	unmatched: 'Not found',
	unsure: 'Needs a look',
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

// Add or Trade or sale, over the camera's top edge, always in view, so a
// card meant for a sale is never added by mistake.
export function modeSwitch(onChoose) {
	const button = (mode, label) => h('button', {
		'aria-checked': 'false',
		class: 'scan-mode-option',
		'data-mode': mode,
		id: `scan-mode-${mode}`,
		onclick: () => onChoose(mode),
		role: 'radio',
		type: 'button',
	}, label);

	return h('div', {'aria-label': 'Scan mode', class: 'scan-mode', id: 'scan-mode', role: 'radiogroup'},
		button('add', 'Add'),
		button('trade', 'Trade or sale'));
}

export function drawModeSwitch(el, mode) {
	for (const option of el.querySelectorAll('[data-mode]')) {
		option.setAttribute('aria-checked', String(option.dataset.mode === mode));
		option.tabIndex = option.dataset.mode === mode ? 0 : -1;
	}
}

// ------------------------------------------------------------ the tray

// The trade tray: two columns, Going out and Coming in. Each column's head
// says how many cards it holds and, pressed, sends the next scans there.
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
			on ? h('span', {class: 'scan-trade-next'}, 'Next scans') : null),
			h('ul', {class: 'scan-trade-rows'}, ...(items.length
				? items.map((item) => tradeRow(item, {languageName, photoUrl: photoUrl(item.id), result: side === 'out' ? results.get(item.id) : null, where}))
				: [h('li', {class: 'scan-trade-empty'}, on ? 'Scan a card' : side === 'out' ? 'Cards you give' : 'Cards you get')])));
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
	const pick = status === 'ask' || (status === 'other' && result.candidates.length);

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
			line ? h('span', {class: 'scan-trade-line'}, line) : null)),
		h('button', {'aria-label': `Remove ${item.card ? item.card.name : 'this scan'}`, class: 'scan-trade-remove', 'data-remove': item.id, title: 'Remove', type: 'button'},
			h('span', {'aria-hidden': 'true'}, '×')),
		pick ? h('button', {'aria-label': `Pick the copy of ${name} that goes out`, class: 'scan-trade-pick', 'data-pick': item.id, type: 'button'}, 'Pick the copy') : null);
}

// ------------------------------------------------------------ a card's sheet

// What a card's confirm sheet says in the trade tray: its side, with Move
// to the other side, and for a card going out the copy that goes, with Pick
// the copy.
export function tradeBlock(item, {languageName = langName, onMove, onPick, result, where}) {
	const side = sideOf(item);
	const other = side === 'out' ? 'in' : 'out';
	const line = side === 'out' ? outLine(result, {languageName, where}) : 'A new copy, added when the move is saved.';
	const canPick = side === 'out' && result && result.candidates.length && result.status !== 'none';

	return h('div', {class: 'scan-frame scan-trade-block', id: 'scan-trade-block'},
		h('p', {id: 'scan-trade-side'}, h('strong', null, SIDE_NAMES[side]), line ? ` · ${line}` : ''),
		h('div', {class: 'scan-row'},
			canPick ? h('button', {class: 'scan-button', id: 'scan-trade-pick', onclick: () => onPick(item.id), type: 'button'}, result.status === 'chosen' ? 'Change the copy' : 'Pick the copy') : null,
			h('button', {class: 'scan-button', id: 'scan-trade-move', onclick: () => onMove(item.id, other), type: 'button'}, `Move to ${SIDE_NAMES[other]}`)));
}

// ------------------------------------------------------------ the copy picker

// Which of Eric's copies goes out for one scanned card: each copy as a
// picture with its language, finish, condition, and where it is (a binder
// pocket, a binder's tray, a storage place, or no binder), spares marked,
// best first. A card standing for several copies picks that many; one copy
// is picked with one tap.
export function copyPicker(ctx, itemId) {
	const titleId = 'scan-copy-title';
	const body = h('div', {class: 'scan-sheet-body'});
	const el = h('div', {'aria-labelledby': titleId, 'aria-modal': 'true', class: 'scan-sheet scan-copy-sheet', id: 'scan-copy-sheet', role: 'dialog'},
		sheetHeader('Which copy goes out?', () => ctx.closeSheet(), titleId),
		body);
	let chosen = null;

	function refresh() {
		const item = findItem(ctx.session, itemId);
		const result = item ? ctx.outResult(itemId) : null;

		if (!item || !result || !result.candidates.length) {
			ctx.closeSheet();

			return;
		}

		const need = result.need;

		if (!chosen) {
			chosen = new Set(result.copies.map((entry) => entry.id));
		}

		const fits = result.status !== 'other';
		const intro = need > 1
			? `Pick the ${need} copies of ${item.card.name} that go out.`
			: fits
				? `${plural(result.candidates.length, 'copy fits', 'copies fit')} the ${langName(item.language)} card you scanned. Pick the one that goes out.`
				: `None of your copies is ${langName(item.language)}${item.variantId ? ' in this finish' : ''}. Pick one only if it is the card in your hand.`;
		const suggested = new Set(result.suggested);
		// Every copy is of the card scanned, so a copy the card index does not
		// name yet shows the scanned card's name and picture.
		const own = {image: item.card.image ? cardImage(item.card.image, 'low') : null, name: item.card.name, number: item.card.localId, setName: item.card.setName || null};
		const tiles = described(result.candidates, ctx.cardIndex, ctx.viewing).map((one) => {
			const known = one.info.name && one.info.name !== one.entry.card_id;
			const described = {...one, info: {...one.info, ...(known ? {} : {name: own.name, number: own.number, setName: own.setName}), image: one.info.image || own.image}};
			const {entry} = described;
			const variant = findVariant(item.variants, entry.variant_id);
			const extra = [
				entry.variant_id ? variantLabel(variant) || 'Finish set' : 'Finish not set',
				whereText(ctx.where.get(entry.id), entry),
				ctx.isSpare(entry.id) ? 'Spare' : null,
			].filter(Boolean).join(' · ');
			const on = chosen.has(entry.id);

			return h('button', {
				'aria-pressed': String(on),
				class: `pick scan-copy${suggested.has(entry.id) ? ' is-suggested' : ''}`,
				'data-entry': entry.id,
				onclick: () => {
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

					refresh();
				},
				type: 'button',
			}, ...copyTile(described, {extra, selected: on}));
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

// ------------------------------------------------------------ before the tray goes

// Asked before the trade tray is thrown away: switching to Add, or Close.
// Nothing in the collection has changed, so throwing it away loses only the
// scans.
export function leaveTradeSheet(ctx, {count, action, onLeave}) {
	const titleId = 'scan-leave-title';
	const el = h('div', {'aria-labelledby': titleId, 'aria-modal': 'true', class: 'scan-sheet scan-leave-sheet', id: 'scan-leave-sheet', role: 'dialog'},
		sheetHeader(`Discard ${plural(count, 'card')}?`, () => ctx.closeSheet(), titleId),
		h('div', {class: 'scan-sheet-body'},
			h('p', {id: 'scan-leave-text'}, `The trade tray holds ${plural(count, 'card')} not logged yet. Nothing in your cards has changed. Log it saves them as a move; ${action.toLowerCase()} throws them away.`),
			h('div', {class: 'scan-row'},
				h('button', {class: 'scan-button', id: 'scan-leave-keep', onclick: () => ctx.closeSheet(), type: 'button'}, 'Keep them'),
				h('button', {class: 'scan-button scan-danger', id: 'scan-leave-go', onclick: onLeave, type: 'button'}, action))));

	return {el, itemId: null, refresh: () => {}};
}
