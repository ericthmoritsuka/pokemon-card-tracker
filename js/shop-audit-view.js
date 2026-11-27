// The Shop audit screen (js/shop-audit.js): the live HOTARU single-card
// listings that break the listing invariant, each with the card's picture,
// name, set and number, language, finish, the reason in plain words, and a
// link to the card page. Read only, and the family owner's alone, as the
// Shop is (js/shop-owner.js).
//
// Route (app.js): shop/audit, linked from the Shop.

import {entryInfo} from './binders-view.js';
import {cardIndex, viewingLanguage} from './catalog.js';
import {loadDocument} from './collection.js';
import {BASE, errorText, h} from './dom.js';
import {languageLabel} from './languages.js';
import {finishLabel} from './monprice.js';
import {auditRows, readLiveListings} from './shop-audit.js';
import {checkShopOwner, shopOwnerKnown} from './shop-owner.js';

const head = () => h('div', {class: 'view-head'}, h('h2', null, 'Check live listings'));

function notOwner(root) {
	root.replaceChildren(head(),
		h('div', {class: 'card empty-state', id: 'shop-audit-not-owner'},
			h('p', {class: 'big'}, 'The Shop is for the family\'s owner'),
			h('p', {class: 'muted'}, 'Only the owner\'s HOTARU listings can be checked here.')));
}

// The finish as the listing names it: '' when none was set.
const finishText = (row) => (row.listing.finish ? finishLabel(row.listing.finish) : 'No finish set');

function rowNode(row, index) {
	const listing = row.listing;
	const copy = row.entry || {catalog: listing.catalog || 'international', card_id: listing.card_id, language: listing.language, name_local: listing.name, number_local: listing.number};
	let info = null;

	try {
		info = copy.card_id ? entryInfo(copy, index, viewingLanguage()) : null;
	}
	catch {
		info = null;
	}

	const name = listing.name || (info && info.name) || listing.card_id || listing.id;
	const setLine = [listing.set_name || (info && info.setName), listing.number || (info && info.number) ? `#${listing.number || info.number}` : null].filter(Boolean).join(' · ');
	const art = info && info.image
		? h('img', {alt: '', class: 'shop-art', decoding: 'async', loading: 'lazy', onerror: (event) => event.target.replaceWith(h('div', {'aria-hidden': 'true', class: 'shop-art shop-art-none'})), src: info.image})
		: h('div', {'aria-hidden': 'true', class: 'shop-art shop-art-none'});
	const link = info && info.route
		? h('a', {class: 'shop-name', 'data-link': info.route, href: BASE + info.route}, name)
		: h('span', {class: 'shop-name'}, name);

	return h('li', {class: `card shop-row shop-audit-row shop-audit-${row.reason}`, 'data-id': listing.id},
		art,
		h('div', {class: 'shop-body'},
			link,
			h('p', {class: 'muted shop-meta'}, [setLine, languageLabel(listing.language), finishText(row)].filter(Boolean).join(' · ')),
			h('p', {class: 'shop-state shop-audit-reason'}, row.text)));
}

export function shopAuditScreen(root) {
	let alive = true;
	const status = h('p', {'aria-live': 'polite', class: 'muted', id: 'shop-audit-status'}, 'Reading HOTARU\'s listings…');
	const list = h('ul', {class: 'shop-list', id: 'shop-audit-list'});

	if (shopOwnerKnown() === false) {
		notOwner(root);

		return () => {};
	}

	root.replaceChildren(head(),
		h('p', {class: 'muted'}, 'The cards on sale on HOTARU that should stay home: gone from your cards, in a binder pocket, or the only copy of their finish. Nothing here changes a listing.'),
		status,
		list,
		h('p', null, h('a', {class: 'button small', 'data-link': 'shop', href: `${BASE}shop`}, 'Back to the Shop')));

	checkShopOwner().then((owner) => {
		if (alive && owner === false) {
			notOwner(root);
		}
	}).catch(() => {});

	(async () => {
		try {
			const [doc, listings, index] = await Promise.all([loadDocument(), readLiveListings(), cardIndex().catch(() => new Map())]);

			if (!alive) {
				return;
			}

			const rows = auditRows(doc, listings);

			status.textContent = rows.length
				? `${rows.length} of ${listings.length} live ${listings.length === 1 ? 'listing breaks' : 'listings break'} the rule.`
				: 'Every live listing passes.';
			list.replaceChildren(...rows.map((row) => rowNode(row, index)));
		}
		catch (err) {
			if (alive) {
				status.textContent = `HOTARU's listings could not be read. ${errorText(err)}`;
			}
		}
	})();

	return () => {
		alive = false;
	};
}

export const shopAuditRoutes = [
	{kind: 'shop', pattern: /^shop\/audit$/, render: shopAuditScreen, tab: null, title: 'Check live listings | Card Tracker'},
];

export const shopAuditAccountViews = [shopAuditScreen];
