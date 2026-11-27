// The two cleanup screens beside Check spares (Eric, 2026-11-26), for the
// copies that would otherwise be listed wrongly or stay home:
//
//   trade/check/import    Monprice import check (js/import-dup-view.js)
//   trade/check/finish    Copies with no finish (js/unset-finish-view.js)
//
// Check spares shows one line for each under its heading, with how many
// there are to look at (cleanupLinks), and app.js takes the routes from
// here, so the shared files hold a line each.

import {importDuplicates, toCheck} from './import-dup-check.js';
import {importDupAccountViews, importDupRoutes, readImportChecked} from './import-dup-view.js';
import {loadDocument, onChange} from './collection.js';
import {BASE, h} from './dom.js';
import {plural} from './format.js';
import {copyCount, unsetTiles} from './unset-finish.js';
import {unsetFinishAccountViews, unsetFinishRoutes} from './unset-finish-view.js';
import {loadOnePrintings} from './wishlist.js';

// What each line says about its screen, from the cards. Plain words, also
// for none.
export function importCountText(cards, marks = readImportChecked()) {
	const groups = toCheck(importDuplicates(cards), marks);
	const copies = groups.reduce((sum, group) => sum + group.copies, 0);

	return groups.length ? `${plural(groups.length, 'group', 'groups')} to check, ${plural(copies, 'copy', 'copies')}` : 'nothing to check';
}

export function unsetCountText(cards) {
	const tiles = unsetTiles(cards);

	return tiles.length ? `${plural(copyCount(tiles), 'copy', 'copies')} with no finish, ${plural(tiles.length, 'card', 'cards')}` : 'every copy has a finish';
}

// The two lines, counted from the document and kept up to date while the
// screen is open. destroy() stops it.
export function cleanupLinks() {
	let alive = true;
	const importCount = h('span', {class: 'muted', id: 'cleanup-import-count'}, 'Reading…');
	const finishCount = h('span', {class: 'muted', id: 'cleanup-finish-count'}, 'Reading…');
	const line = (route, words, count, id) => h('li', {class: 'cleanup-link'},
		h('a', {'data-link': route, href: BASE + route, id}, words),
		': ',
		count);
	const element = h('ul', {'aria-label': 'Clean up your cards', class: 'cleanup-links', id: 'cleanup-links'},
		line('trade/check/import', 'Monprice import check', importCount, 'cleanup-import'),
		line('trade/check/finish', 'Copies with no finish', finishCount, 'cleanup-finish'));

	function count(doc) {
		if (alive && doc && Array.isArray(doc.cards)) {
			importCount.textContent = importCountText(doc.cards);
			finishCount.textContent = unsetCountText(doc.cards);
		}
	}

	// A card with one printing counts as the spares count it, so the
	// printings are noted before the groups are counted.
	loadOnePrintings().then(loadDocument).then(count).catch(() => {
		if (alive) {
			importCount.textContent = 'could not be counted';
			finishCount.textContent = 'could not be counted';
		}
	});

	const stop = onChange(count);

	return {
		destroy: () => {
			alive = false;
			stop();
		},
		element,
	};
}

export const copyCleanupRoutes = [...importDupRoutes, ...unsetFinishRoutes];

export const copyCleanupAccountViews = [...importDupAccountViews, ...unsetFinishAccountViews];
