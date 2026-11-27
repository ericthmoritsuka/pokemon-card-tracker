// The Shop's Consignment (plans/hotaru-consignment-plan.md, Eric
// 2026-11-26): cards other people leave with the shop, sold on HOTARU for a
// commission taken out of the sale price. The buyer pays Eric, as for any
// order; once the order is marked paid, each consigned card in it owes its
// consignor a payout, due once the order is delivered.
//
// A consigned card is never a copy in the collection: it lives on the
// server only (store_listings kind 'consigned'), so Publish, the star
// withdraw, kits, and Payment received's sale in Trades all leave it alone.
//
// Here: the Consignment section in the Shop (the default terms, each
// consignor with their cards, balances, statement, and payouts), the sheet
// that consigns a card from its card page (js/catalog-views.js) or edits
// one, and the consignor sheet. The calls are
// supabase/store-consignment.sql's, for the family's owner only. The numbers
// are js/consignment.js; the styles, css/shop.css.

import {getClient} from './auth.js';
import {h} from './dom.js';
import {CARD_STATES, PAYOUT_STATES, consignedRecord, consignorParts, ownersByListing, parsePercent, split, statementText, termsFor, termsText} from './consignment.js';
import {plural} from './format.js';
import {parseSalePrice, priceForInput} from './moves.js';
import {brCode, pixKey} from './pix.js';
import {finishName, formatBrl} from './prices.js';
import {CONDITIONS} from './scan/session.js';
import {setConsignPick} from './shop-owner.js';
import {openDialogSheet} from './sheet.js';
import {storePicturePath} from './shop.js';
import {STORE_BUCKET, uploadPicture} from './store-publish.js';

async function call(name, args = {}) {
	const client = await getClient();
	const {data, error} = await client.rpc(name, args);

	if (error) {
		throw error;
	}

	return data;
}

const EMPTY = {cards: [], consignors: [], payouts: [], settings: {commission_pct: 15, min_commission_brl: 5}};

export async function readConsignment() {
	const data = await call('store_consignment_admin');

	return data && typeof data === 'object' ? {...EMPTY, ...data} : EMPTY;
}

export const saveConsigned = (record) => call('save_consigned', {card: record});

export const saveConsignor = (record) => call('save_consignor', {consignor: record});

export const saveSettings = (settings) => call('save_store_settings', {settings});

export const returnConsigned = (id) => call('return_consigned', {listing_id: id});

export const relistConsigned = (id) => call('relist_consigned', {listing_id: id});

export const markPayoutsPaid = (ids, note = null) => call('mark_payouts_paid', {ids, note});

// Deleting for good (supabase/store-consignment-delete.sql): only an entry
// with no history, such as one made by mistake.
export const deleteConsigned = (id) => call('delete_consigned', {listing_id: id});

export const deleteConsignor = (id) => call('delete_consignor', {consignor_id: id});

// A deleted card's own picture (consigned/<id>) is its alone, so it goes
// too. The shared TCGdex picture stays: Eric's own singles of that print
// use it. A file left behind does no harm, so a failure is ignored.
async function deletePicture(path) {
	if (!/^consigned\//.test(String(path || ''))) {
		return;
	}

	try {
		const client = await getClient();

		await client.storage.from(STORE_BUCKET).remove([path]);
	}
	catch {
		// Left in the bucket, unseen.
	}
}

// Why a consignment call failed, for the screen.
export function consignErrorText(error) {
	const code = error && error.code;
	const message = String((error && error.message) || '');

	if ((code === 'PGRST202' || code === '42883') && /delete_consign/.test(message)) {
		return 'Deleting is not set up yet: run supabase/store-consignment-delete.sql in the Supabase SQL Editor.';
	}

	if (code === 'PGRST202' || code === '42883' || /store_consignment_admin|save_consigned|save_consignor|save_store_settings/.test(message)) {
		return 'Consignment is not set up yet: run supabase/store-consignment.sql in the Supabase SQL Editor.';
	}

	if (code === '42501') {
		return 'Only the shop\'s owner can do this.';
	}

	return message || 'The server did not answer.';
}

const brl = (value) => formatBrl(Number(value));

// "Charizard #4 · Base Set · Near Mint".
const cardLine = (card) => [[card.name, card.number ? `#${card.number}` : null].filter(Boolean).join(' '), card.set_name, card.finish, card.condition].filter(Boolean).join(' · ');

const stateOf = (card) => (card.status === 'withdrawn' && card.returned_at ? 'returned' : card.status);

// "Buyer pays R$ 100,00 · Ana gets R$ 85,00 · You keep R$ 15,00".
function splitText(price, terms, who) {
	const parts = split(price, terms.commission_pct, terms.min_commission_brl);

	return `Buyer pays ${brl(parts.price)} · ${who || 'The owner'} gets ${brl(parts.payout)} · You keep ${brl(parts.commission)}`;
}

// The QR library (vendor/qrcode-generator-1.4.4.min.js, the one HOTARU's
// Pix uses), read the first time a payment is shown. Resolves to its
// qrcode function, or null when it could not be read (offline, say): the
// copia e cola code still works without it.
let qrLoading = null;

function loadQr() {
	if (window.qrcode) {
		return Promise.resolve(window.qrcode);
	}

	if (!qrLoading) {
		qrLoading = new Promise((resolve) => {
			const script = document.createElement('script');

			script.src = new URL('../vendor/qrcode-generator-1.4.4.min.js', import.meta.url).href;
			script.onload = () => resolve(window.qrcode || null);
			script.onerror = () => {
				qrLoading = null;
				resolve(null);
			};
			document.head.append(script);
		});
	}

	return qrLoading;
}

// What paying a consignor shows: the Pix copia e cola code for the amount,
// with a QR for paying from another phone, and the key as it was read.
function pixPanel(person, amount, toast) {
	const read = person.pix_key ? pixKey(person.pix_key) : {error: `No Pix key for ${person.name} yet: add one with Edit details.`};
	let code = null;

	if (!read.error) {
		try {
			code = brCode({amount, description: 'HOTARU repasse', key: read.key, name: person.name});
		}
		catch (err) {
			read.error = err.message;
		}
	}

	if (!code) {
		return h('p', {class: 'status shop-pix-problem'}, read.error);
	}

	const qr = h('div', {'aria-label': `Pix QR code for ${brl(amount)} to ${person.name}`, class: 'shop-pix-qr', role: 'img'});

	loadQr().then((qrcode) => {
		if (!qrcode) {
			qr.hidden = true;

			return;
		}

		const made = qrcode(0, 'M');

		made.addData(code);
		made.make();
		// An SVG the library makes from the code above, which holds only
		// characters js/pix.js wrote.
		qr.innerHTML = made.createSvgTag({margin: 2, scalable: true});
	});

	return h('div', {class: 'shop-pix', 'data-code': code},
		qr,
		h('p', {class: 'muted shop-pix-key'}, `${read.label}. Your bank app shows the key's holder: check it is ${person.name} before paying.`),
		h('button', {class: 'small primary shop-pix-copy', onclick: async () => toast(await copyText(code) ? 'Pix code copied. Paste it in your bank app\'s Pix copia e cola.' : 'The Pix code could not be copied.'), type: 'button'}, 'Copy Pix code'));
}

async function copyText(text) {
	try {
		await navigator.clipboard.writeText(text);

		return true;
	}
	catch {
		return false;
	}
}

// ------------------------------------------------------------- the section

// The Consignment section. go(route) is the app's router; toast the Shop's;
// onLoad runs after each read, so the order list can name whose card an
// order holds. Shown to the owner once the server answers.
export function consignmentSection({go, onLoad = () => {}, toast}) {
	let alive = true;
	let owner = false;
	let data = EMPTY;
	let loaded = false;
	let problem = null;
	let editingTerms = false;
	let showRemoved = false;
	const asking = new Map();
	const working = new Set();
	const node = h('section', {'aria-labelledby': 'shop-consign-title', class: 'shop-kits shop-consign', hidden: true, id: 'shop-consign'});

	function draw() {
		node.hidden = !owner || (!loaded && !problem);

		if (node.hidden) {
			return;
		}

		const title = h('h3', {id: 'shop-consign-title'}, 'Consignment');

		if (problem) {
			node.replaceChildren(title, h('p', {class: 'muted', id: 'shop-consign-problem', role: 'status'}, problem));

			return;
		}

		const forSale = data.cards.filter((card) => stateOf(card) === 'available').length;
		const active = data.consignors.filter((person) => person.active !== false);
		const removed = data.consignors.filter((person) => person.active === false);

		node.replaceChildren(...[
			title,
			h('p', {class: 'muted', id: 'shop-consign-note'}, active.length
				? `Other people's cards, sold for a commission. ${plural(forSale, 'card')} on HOTARU.`
				: 'Sell other people\'s cards for a commission taken out of the price. Add who leaves cards with you, then consign each card from its card page.'),
			termsNode(),
			h('div', {class: 'shop-kit-actions'},
				h('button', {class: 'small primary', id: 'shop-consign-card', onclick: () => {
					// The next card page opens its Consign sheet by itself, and
					// saving it comes back here (js/catalog-views.js).
					setConsignPick(true);
					go('sets');
					toast('Consign: find the card and open it. Its Consign sheet opens by itself.', {key: 'consign', timeout: 0});
				}, type: 'button'}, 'Consign a card'),
				h('button', {class: 'small', id: 'shop-consign-person', onclick: () => openConsignorSheet({onSaved: load, settings: data.settings, toast}), type: 'button'}, 'Add consignor')),
			...active.map(consignorCard),
			removed.length
				? h('button', {class: 'small', id: 'shop-consign-removed', onclick: () => {
					showRemoved = !showRemoved;
					draw();
				}, type: 'button'}, showRemoved ? 'Hide removed consignors' : `Show removed consignors (${removed.length})`)
				: null,
			...(showRemoved ? removed.map(removedCard) : [])
		// replaceChildren writes a null as text, unlike h().
		].filter(Boolean));
	}

	// What save_consignor takes, from a consignor as the server lists them.
	const consignorRecord = (person, changes) => ({
		active: person.active !== false,
		commission_pct: person.commission_pct,
		id: person.id,
		min_commission_brl: person.min_commission_brl,
		name: person.name,
		note: person.note,
		phone: person.phone,
		pix_key: person.pix_key,
		...changes,
	});

	// What keeps a consignor from being removed: a card still with the shop
	// for sale or in an order, or money not paid to them yet.
	function removeBlock(person) {
		if (Number(person.for_sale) || Number(person.reserved)) {
			return `${person.name} still has cards for sale or in an order. Return them to ${person.name} first.`;
		}

		if (Number(person.waiting_brl) || Number(person.due_brl)) {
			return `${person.name} is still owed ${brl(Number(person.waiting_brl) + Number(person.due_brl))}. Pay it first.`;
		}

		return null;
	}

	// A consignor with nothing in their statement can be deleted for good,
	// rather than removed.
	const hasNothing = (person) => {
		const {cards, payouts} = consignorParts(data, person.id);

		return !cards.length && !payouts.length;
	};

	// The Delete confirm, the same for an active and a removed consignor.
	function deleteAsk(person) {
		const busy = working.has(person.id);

		return [
			h('p', {class: 'shop-kit-ask'}, `Delete ${person.name} for good? They have no cards, so nothing else changes. This cannot be undone.`),
			h('button', {class: 'small', disabled: busy, id: `shop-consign-delete-yes-${person.id}`, onclick: () => act(person.id, async () => {
				asking.delete(person.id);
				await deleteConsignor(person.id);
				toast(`${person.name} deleted.`);
			}), type: 'button'}, 'Delete'),
			h('button', {class: 'small', onclick: () => {
				asking.delete(person.id);
				draw();
			}, type: 'button'}, 'Back'),
		];
	}

	const deleteButton = (person) => h('button', {class: 'small', id: `shop-consign-delete-${person.id}`, onclick: () => {
		asking.set(person.id, 'delete');
		draw();
	}, type: 'button'}, 'Delete');

	// A removed consignor, shown on request: their statement, and Restore.
	function removedCard(person) {
		const busy = working.has(person.id);

		if (asking.get(person.id) === 'delete') {
			return h('article', {class: 'card shop-kit shop-consignor shop-consignor-removed', 'data-id': person.id, id: `consignor-${person.id}`},
				h('h4', {class: 'shop-kit-name'}, `${person.name} (removed)`),
				h('div', {class: 'shop-kit-actions'}, ...deleteAsk(person)));
		}

		return h('article', {class: 'card shop-kit shop-consignor shop-consignor-removed', 'data-id': person.id, id: `consignor-${person.id}`},
			h('h4', {class: 'shop-kit-name'}, `${person.name} (removed)`),
			h('div', {class: 'shop-kit-actions'},
				hasNothing(person) ? deleteButton(person) : null,
				h('button', {class: 'small', disabled: busy, id: `shop-consign-restore-${person.id}`, onclick: () => act(person.id, async () => {
					await saveConsignor(consignorRecord(person, {active: true}));
					toast(`${person.name} is back.`);
				}), type: 'button'}, 'Restore'),
				h('button', {class: 'small', onclick: async () => {
					const copied = await copyText(statementText(person, data, {brl}));

					toast(copied ? `${person.name}'s statement copied.` : 'The statement could not be copied.');
				}, type: 'button'}, 'Copy statement')));
	}

	function termsNode() {
		const settings = data.settings;

		if (!editingTerms) {
			return h('p', {class: 'shop-consign-terms', id: 'shop-consign-terms'},
				`Shop terms: ${termsText(settings, brl)} a card sold. `,
				h('button', {class: 'small', id: 'shop-consign-terms-edit', onclick: () => {
					editingTerms = true;
					draw();
				}, type: 'button'}, 'Change'));
		}

		const pct = h('input', {'aria-label': 'Commission in percent', autocomplete: 'off', class: 'search shop-price-input', id: 'shop-consign-pct', inputmode: 'decimal', type: 'text', value: String(settings.commission_pct).replace('.', ',')});
		const minimum = h('input', {'aria-label': 'Minimum commission in reais', autocomplete: 'off', class: 'search shop-price-input', id: 'shop-consign-min', inputmode: 'decimal', type: 'text', value: priceForInput(Number(settings.min_commission_brl))});
		const error = h('p', {class: 'form-error', hidden: true, id: 'shop-consign-terms-error', role: 'alert'});

		async function save(event) {
			event.preventDefault();

			const typedPct = parsePercent(pct.value);
			const typedMin = minimum.value.trim() === '' || minimum.value.trim() === '0' ? {error: null, value: 0} : parseSalePrice(minimum.value);

			if (typedPct.error || typedPct.value === null || typedMin.error) {
				error.textContent = typedPct.error || typedMin.error || 'Type the percent, such as 15.';
				error.hidden = false;

				return;
			}

			try {
				data.settings = await saveSettings({commission_pct: typedPct.value, min_commission_brl: typedMin.value});
				editingTerms = false;
				toast(`Shop terms: ${termsText(data.settings, brl)}. Cards already consigned keep theirs.`);
				draw();
			}
			catch (err) {
				error.textContent = consignErrorText(err);
				error.hidden = false;
			}
		}

		return h('form', {class: 'shop-kit-form', id: 'shop-consign-terms-form', onsubmit: save},
			h('div', {class: 'shop-kit-amount'}, h('span', {class: 'shop-kit-unit'}, '%'), pct),
			h('div', {class: 'shop-kit-amount'}, h('span', {class: 'shop-kit-unit'}, 'R$ min'), minimum),
			h('p', {class: 'muted'}, 'New cards take these unless their consignor has their own. Cards already consigned keep theirs.'),
			error,
			h('div', {class: 'shop-kit-buttons'},
				h('button', {onclick: () => {
					editingTerms = false;
					draw();
				}, type: 'button'}, 'Back'),
				h('button', {class: 'primary', id: 'shop-consign-terms-save', type: 'submit'}, 'Save')));
	}

	function consignorCard(person) {
		const {cards, payouts} = consignorParts(data, person.id);
		const due = payouts.filter((payout) => payout.state === 'due');
		const busy = working.has(person.id);
		const terms = person.commission_pct === null && person.min_commission_brl === null
			? 'Shop terms'
			: termsText(termsFor(person, data.settings), brl);
		const counts = [
			person.for_sale ? `${person.for_sale} for sale` : null,
			person.reserved ? `${person.reserved} in an order` : null,
			person.sold ? `${person.sold} sold` : null,
			person.returned ? `${person.returned} returned` : null,
		].filter(Boolean).join(' · ') || 'No cards yet';
		const balances = [
			Number(person.waiting_brl) ? `${brl(person.waiting_brl)} waiting for delivery` : null,
			Number(person.due_brl) ? `${brl(person.due_brl)} due` : null,
			Number(person.paid_brl) ? `${brl(person.paid_brl)} paid` : null,
		].filter(Boolean).join(' · ');
		const paying = asking.get(person.id) === 'pay';
		const removing = asking.get(person.id) === 'remove';
		const actions = asking.get(person.id) === 'delete'
			? deleteAsk(person)
			: removing
			? [
				h('p', {class: 'shop-kit-ask'}, `Remove ${person.name}? They leave this list and the Consign sheet. Their sold and returned cards stay in their statement, under Show removed consignors.`),
				h('button', {class: 'small', disabled: busy, id: `shop-consign-remove-yes-${person.id}`, onclick: () => act(person.id, async () => {
					asking.delete(person.id);
					await saveConsignor(consignorRecord(person, {active: false}));
					toast(`${person.name} removed.`);
				}), type: 'button'}, 'Remove'),
				h('button', {class: 'small', onclick: () => {
					asking.delete(person.id);
					draw();
				}, type: 'button'}, 'Back'),
			]
			: paying
			? [
				h('p', {class: 'shop-kit-ask'}, `Send ${brl(person.due_brl)} to ${person.name} by Pix, then mark it paid.`),
				pixPanel(person, Number(person.due_brl), toast),
				h('button', {class: 'small', disabled: busy, id: `shop-consign-paid-${person.id}`, onclick: () => act(person.id, async () => {
					asking.delete(person.id);
					await markPayoutsPaid(due.map((payout) => payout.id));
					toast(`${brl(person.due_brl)} to ${person.name} marked paid.`);
				}), type: 'button'}, 'Mark paid'),
				h('button', {class: 'small', onclick: () => {
					asking.delete(person.id);
					draw();
				}, type: 'button'}, 'Back'),
			]
			: [
				due.length ? h('button', {class: 'small primary', disabled: busy, id: `shop-consign-pay-${person.id}`, onclick: () => {
					asking.set(person.id, 'pay');
					draw();
				}, type: 'button'}, `Pay ${brl(person.due_brl)}`) : null,
				h('button', {class: 'small', id: `shop-consign-statement-${person.id}`, onclick: async () => {
					const copied = await copyText(statementText(person, data, {brl}));

					toast(copied ? `${person.name}'s statement copied. Paste it in WhatsApp.` : 'The statement could not be copied.');
				}, type: 'button'}, 'Copy statement'),
				h('button', {class: 'small', onclick: () => openConsignorSheet({existing: person, onSaved: load, settings: data.settings, toast}), type: 'button'}, 'Edit details'),
				// No cards at all: Delete, as Remove would keep nothing.
				hasNothing(person) ? deleteButton(person) : h('button', {class: 'small', id: `shop-consign-remove-${person.id}`, onclick: () => {
					const block = removeBlock(person);

					if (block) {
						toast(block);

						return;
					}

					asking.set(person.id, 'remove');
					draw();
				}, type: 'button'}, 'Remove'),
			];

		return h('article', {class: 'card shop-kit shop-consignor', 'data-id': person.id, id: `consignor-${person.id}`},
			h('h4', {class: 'shop-kit-name'}, person.name),
			h('p', {class: 'muted'}, [person.phone, terms].filter(Boolean).join(' · ')),
			h('p', {class: 'shop-consignor-counts'}, counts),
			balances ? h('p', {class: 'shop-kit-price shop-consignor-balances'}, balances) : null,
			cards.length ? h('ul', {class: 'shop-kit-cards shop-consigned-list'}, cards.map((card) => cardItem(card, person, payouts))) : null,
			h('div', {class: 'shop-kit-actions'}, ...actions.filter(Boolean))
		);
	}

	function cardItem(card, person, payouts) {
		const state = stateOf(card);
		const payout = payouts.find((one) => one.listing_id === card.id);
		const busy = working.has(card.id);
		const confirming = asking.get(card.id) === 'return';
		const deleting = asking.get(card.id) === 'delete';
		// Never sold: the server also refuses a card that was ever in an
		// order (supabase/store-consignment-delete.sql).
		const deletable = !payout && (state === 'available' || state === 'returned' || state === 'withdrawn');
		// The commission beside the price (Eric, 2026-11-26): what is kept,
		// or would be at this price.
		const money = payout
			? `${brl(payout.sale_brl)} · ${person.name} gets ${brl(payout.payout_brl)} · your cut ${brl(payout.commission_brl)} · ${PAYOUT_STATES[payout.state] || payout.state}`
			: `${brl(card.price_brl)} · ${person.name} gets ${brl(card.payout_brl)} · your cut ${brl(card.commission_brl)}`;
		const buttons = deleting
			? [
				h('span', {class: 'shop-kit-ask'}, `Delete ${card.name} for good? It leaves HOTARU and ${person.name}'s statement, as if never consigned. This cannot be undone. For a card going back to ${person.name}, use Return to owner.`),
				h('button', {class: 'small', disabled: busy, id: `shop-consigned-delete-yes-${card.id}`, onclick: () => act(card.id, async () => {
					asking.delete(card.id);
					const gone = await deleteConsigned(card.id);

					await deletePicture(gone && gone.image_path);
					toast(`${card.name} deleted.`);
				}), type: 'button'}, 'Delete'),
				h('button', {class: 'small', onclick: () => {
					asking.delete(card.id);
					draw();
				}, type: 'button'}, 'Back'),
			]
			: confirming
			? [
				h('span', {class: 'shop-kit-ask'}, `Give ${card.name} back to ${person.name}? It leaves HOTARU.`),
				h('button', {class: 'small', disabled: busy, onclick: () => act(card.id, async () => {
					asking.delete(card.id);
					await returnConsigned(card.id);
					toast(`${card.name} is off HOTARU, marked returned to ${person.name}.`);
				}), type: 'button'}, 'Return'),
				h('button', {class: 'small', onclick: () => {
					asking.delete(card.id);
					draw();
				}, type: 'button'}, 'Back'),
			]
			: [
				state === 'available' || state === 'returned' || state === 'withdrawn'
					? h('button', {class: 'small', disabled: busy, onclick: () => openConsignSheet({existing: card, toast, onSaved: load}), type: 'button'}, 'Edit')
					: null,
				state === 'available'
					? h('button', {class: 'small shop-consigned-return', disabled: busy, onclick: () => {
						asking.set(card.id, 'return');
						draw();
					}, type: 'button'}, 'Return to owner')
					: null,
				state === 'returned'
					? h('button', {class: 'small shop-consigned-relist', disabled: busy, onclick: () => act(card.id, async () => {
						await relistConsigned(card.id);
						toast(`${card.name} is back on HOTARU.`);
					}), type: 'button'}, 'Put back on sale')
					: null,
				deletable
					? h('button', {class: 'small shop-consigned-delete', disabled: busy, id: `shop-consigned-delete-${card.id}`, onclick: () => {
						asking.set(card.id, 'delete');
						draw();
					}, type: 'button'}, 'Delete')
					: null,
			].filter(Boolean);

		return h('li', {class: `shop-consigned${state === 'available' ? '' : ' shop-consigned-off'}`, 'data-id': card.id},
			// A sold card's payout state says it was sold.
			h('span', {class: 'shop-consigned-line'}, payout ? `${cardLine(card)} · ${money}` : `${cardLine(card)} · ${money} · ${CARD_STATES[state] || state}`),
			buttons.length ? h('span', {class: 'shop-kit-actions'}, ...buttons) : null);
	}

	async function act(key, action) {
		working.add(key);
		draw();

		try {
			await action();
		}
		catch (err) {
			toast(consignErrorText(err));
		}
		finally {
			working.delete(key);
		}

		await load();
	}

	async function load() {
		if (!owner) {
			return data;
		}

		try {
			const found = await readConsignment();

			if (!alive) {
				return data;
			}

			data = found;
			loaded = true;
			problem = null;
			onLoad();
		}
		catch (err) {
			if (!alive) {
				return data;
			}

			if (err && err.code === '42501') {
				owner = false;
			}
			else {
				problem = consignErrorText(err);
			}
		}

		draw();

		return data;
	}

	return {
		load,
		node,
		// The consignor's name for a consigned listing, for the order list.
		ownerOf(listingId) {
			return ownersByListing(data).get(listingId) || null;
		},
		setOwner(value) {
			const was = owner;

			owner = value === true;

			if (owner && !was) {
				load();
			}
			else {
				draw();
			}
		},
		stop() {
			alive = false;
		},
	};
}

// ------------------------------------------------------------ the sheets

const field = (label, id, input) => [h('label', {class: 'shop-kit-label', for: id}, label), input];

function sheetFrame(id, title, form) {
	const sheet = h('dialog', {'aria-labelledby': `${id}-title`, class: 'sheet shop-kit-sheet', id});

	sheet.addEventListener('click', (event) => {
		if (event.target === sheet) {
			sheet.close();
		}
	});
	sheet.append(form);
	form.prepend(h('div', {class: 'sheet-head'},
		h('h2', {id: `${id}-title`}, title),
		h('button', {class: 'small', onclick: () => sheet.close(), type: 'button'}, 'Close')));
	document.body.append(sheet);
	openDialogSheet(sheet, {onClose: () => sheet.remove()});
	sheet.scrollTop = 0;

	return sheet;
}

// Reads the terms typed in a percent and a minimum field. Blank means "not
// set", unless required. {error, pct, minimum}.
function readTerms(pctInput, minInput) {
	const pct = parsePercent(pctInput.value);
	const minText = minInput.value.trim();
	const minimum = minText === '' ? {error: null, value: null} : /^0+([.,]0+)?$/.test(minText) ? {error: null, value: 0} : parseSalePrice(minText);

	return {error: pct.error || minimum.error, minimum: minimum.value, pct: pct.value};
}

// Adds a consignor, or edits one (existing). onSaved(consignor) runs after.
export function openConsignorSheet({existing = null, onSaved = () => {}, settings, toast}) {
	const name = h('input', {autocomplete: 'off', class: 'search', id: 'consignor-name', maxlength: 80, type: 'text', value: existing ? existing.name : ''});
	const phone = h('input', {autocomplete: 'off', class: 'search', id: 'consignor-phone', inputmode: 'tel', maxlength: 40, type: 'text', value: existing && existing.phone ? existing.phone : ''});
	const pix = h('input', {autocomplete: 'off', class: 'search', id: 'consignor-pix', maxlength: 140, type: 'text', value: existing && existing.pix_key ? existing.pix_key : ''});
	const pct = h('input', {autocomplete: 'off', class: 'search shop-price-input', id: 'consignor-pct', inputmode: 'decimal', placeholder: String(settings.commission_pct).replace('.', ','), type: 'text', value: existing && existing.commission_pct !== null ? String(existing.commission_pct).replace('.', ',') : ''});
	const minimum = h('input', {autocomplete: 'off', class: 'search shop-price-input', id: 'consignor-min', inputmode: 'decimal', placeholder: priceForInput(Number(settings.min_commission_brl)), type: 'text', value: existing && existing.min_commission_brl !== null ? priceForInput(Number(existing.min_commission_brl)) : ''});
	const note = h('textarea', {class: 'search shop-kit-description', id: 'consignor-note', maxlength: 500, rows: 2});
	const error = h('p', {class: 'form-error', hidden: true, id: 'consignor-error', role: 'alert'});
	const saveButton = h('button', {class: 'primary', id: 'consignor-save', type: 'submit'}, 'Save');
	let sheet;

	note.value = existing && existing.note ? existing.note : '';

	async function save(event) {
		event.preventDefault();

		const terms = readTerms(pct, minimum);

		if (!name.value.trim()) {
			error.textContent = 'Type their name.';
			error.hidden = false;
			name.focus();

			return;
		}

		if (terms.error) {
			error.textContent = terms.error;
			error.hidden = false;

			return;
		}

		if (pix.value.trim() && pixKey(pix.value).error) {
			error.textContent = pixKey(pix.value).error;
			error.hidden = false;
			pix.focus();

			return;
		}

		saveButton.disabled = true;

		try {
			const saved = await saveConsignor({
				active: existing ? existing.active !== false : true,
				commission_pct: terms.pct,
				id: existing ? existing.id : undefined,
				min_commission_brl: terms.minimum,
				name: name.value.trim(),
				note: note.value,
				phone: phone.value,
				pix_key: pix.value,
			});

			sheet.close();
			toast(existing ? `${saved.name} saved.` : `${saved.name} added. Consign their cards from each card's page.`);
			await onSaved(saved);
		}
		catch (err) {
			error.textContent = consignErrorText(err);
			error.hidden = false;
			saveButton.disabled = false;
		}
	}

	sheet = sheetFrame('consignor-sheet', existing ? `Edit ${existing.name}` : 'New consignor', h('form', {class: 'shop-kit-form', onsubmit: save},
		...field('Name', 'consignor-name', name),
		...field('Phone (optional)', 'consignor-phone', phone),
		...field('Pix key (optional)', 'consignor-pix', pix),
		h('p', {class: 'muted'}, `Leave the terms blank for the shop's: ${termsText(settings, brl)}.`),
		h('div', {class: 'shop-kit-amount'}, h('span', {class: 'shop-kit-unit'}, '%'), pct),
		h('div', {class: 'shop-kit-amount'}, h('span', {class: 'shop-kit-unit'}, 'R$ min'), minimum),
		...field('Note (optional)', 'consignor-note', note),
		error,
		h('div', {class: 'shop-kit-buttons'},
			h('button', {onclick: () => sheet.close(), type: 'button'}, 'Cancel'),
			saveButton)));
	name.focus({preventScroll: true});

	return sheet;
}

// Consigns a card, or edits a consigned one (existing, as
// store_consignment_admin lists it). For a new card, card is the print the
// card page shows ({card_id, catalog, language, name, number, set_name,
// rarity, pictureBase}) and finishes the page's finish choices
// ({label, value, variant}). onSaved(card) runs after a save.
export async function openConsignSheet({card = null, existing = null, finishes = [], onSaved = () => {}, toast}) {
	let data;

	try {
		data = await readConsignment();
	}
	catch (err) {
		toast(consignErrorText(err));

		return null;
	}

	const settings = data.settings;
	const NEW = '__new__';
	const people = data.consignors.filter((person) => person.active !== false || (existing && person.id === existing.consignor_id));
	const consignor = h('select', {class: 'search', id: 'consign-consignor'},
		...people.map((person) => h('option', {value: person.id}, person.name)),
		h('option', {value: NEW}, 'New consignor…'));
	const newName = h('input', {autocomplete: 'off', class: 'search', id: 'consign-new-name', maxlength: 80, placeholder: 'Name', type: 'text'});
	const newPhone = h('input', {autocomplete: 'off', class: 'search', id: 'consign-new-phone', inputmode: 'tel', maxlength: 40, placeholder: 'Phone (optional)', type: 'text'});
	const newPix = h('input', {autocomplete: 'off', class: 'search', id: 'consign-new-pix', maxlength: 140, placeholder: 'Pix key (optional)', type: 'text'});
	const newBox = h('div', {class: 'shop-kit-form', hidden: true, id: 'consign-new'}, newName, newPhone, newPix);
	const finish = existing ? null : h('select', {class: 'search', id: 'consign-finish'},
		h('option', {value: ''}, 'Not set'),
		...finishes.map((option) => h('option', {value: option.value}, option.label)));
	const condition = h('select', {class: 'search', id: 'consign-condition'},
		h('option', {value: ''}, 'Not set'),
		...CONDITIONS.map((one) => h('option', {value: one}, one)));
	const price = h('input', {autocomplete: 'off', class: 'search shop-price-input', id: 'consign-price', inputmode: 'decimal', type: 'text'});
	const pct = h('input', {'aria-label': 'Commission in percent', autocomplete: 'off', class: 'search shop-price-input', id: 'consign-pct', inputmode: 'decimal', type: 'text'});
	const minimum = h('input', {'aria-label': 'Minimum commission in reais', autocomplete: 'off', class: 'search shop-price-input', id: 'consign-min', inputmode: 'decimal', type: 'text'});
	const note = h('textarea', {class: 'search shop-kit-description', id: 'consign-note', maxlength: 500, rows: 2});
	const preview = h('p', {'aria-live': 'polite', class: 'muted shop-kit-preview', id: 'consign-split'});
	const error = h('p', {class: 'form-error', hidden: true, id: 'consign-error', role: 'alert'});
	const saveButton = h('button', {class: 'primary', id: 'consign-save', type: 'submit'}, existing ? 'Save' : 'Consign');
	const print = existing || card;
	let sheet;

	if (finish && finishes.length === 1) {
		finish.value = finishes[0].value;
	}

	if (existing) {
		consignor.value = existing.consignor_id;
		condition.value = CONDITIONS.includes(existing.condition) ? existing.condition : '';
		price.value = priceForInput(Number(existing.price_brl));
		note.value = existing.note || '';
	}
	else if (!people.length) {
		consignor.value = NEW;
	}

	const person = () => people.find((one) => one.id === consignor.value) || null;

	// The chosen consignor's terms, or the shop's, as the fields' starting
	// values; an edit starts from the card's own.
	function fillTerms() {
		const terms = existing && consignor.value === existing.consignor_id
			? {commission_pct: Number(existing.commission_pct), min_commission_brl: Number(existing.min_commission_brl)}
			: termsFor(person(), settings);

		pct.value = String(terms.commission_pct).replace('.', ',');
		minimum.value = priceForInput(terms.min_commission_brl) || '0';
	}

	function drawSplit() {
		const typed = parseSalePrice(price.value);
		const terms = readTerms(pct, minimum);
		const who = consignor.value === NEW ? newName.value.trim() : person() && person().name;

		if (typed.error || typed.value === null || terms.error || terms.pct === null) {
			preview.textContent = 'Type the price the buyer pays. The commission comes out of it.';

			return;
		}

		const cut = split(typed.value, terms.pct, terms.minimum || 0);

		// A minimum at or above the price leaves the consignor nothing (QA
		// shop 21): said, not refused, as Eric may mean it.
		preview.textContent = splitText(typed.value, {commission_pct: terms.pct, min_commission_brl: terms.minimum || 0}, who)
			+ (cut.payout <= 0 ? ` Careful: ${who || 'the consignor'} gets nothing at this price, because the minimum commission takes it all.` : '');
	}

	consignor.addEventListener('change', () => {
		newBox.hidden = consignor.value !== NEW;
		fillTerms();
		drawSplit();

		if (consignor.value === NEW) {
			newName.focus();
		}
	});

	for (const input of [price, pct, minimum, newName]) {
		input.addEventListener('input', () => {
			error.hidden = true;
			drawSplit();
		});
	}

	function fail(text, focus) {
		error.textContent = text;
		error.hidden = false;

		if (focus) {
			focus.focus();
		}
	}

	async function save(event) {
		event.preventDefault();

		const typed = parseSalePrice(price.value);
		const terms = readTerms(pct, minimum);

		if (consignor.value === NEW && !newName.value.trim()) {
			return fail('Type the consignor\'s name.', newName);
		}

		if (consignor.value === NEW && newPix.value.trim() && pixKey(newPix.value).error) {
			return fail(pixKey(newPix.value).error, newPix);
		}

		if (typed.error || typed.value === null) {
			return fail(typed.error || 'Type the price the buyer pays.', price);
		}

		if (terms.error || terms.pct === null) {
			return fail(terms.error || 'Type the commission, such as 15.', pct);
		}

		saveButton.disabled = true;

		try {
			let consignorId = consignor.value;

			if (consignorId === NEW) {
				const added = await saveConsignor({name: newName.value.trim(), phone: newPhone.value, pix_key: newPix.value});

				consignorId = added.id;
			}

			const chosen = finish ? finishes.find((option) => option.value === finish.value) : null;
			let imagePath = null;
			let noPicture = false;

			if (!existing && card.pictureBase) {
				const path = storePicturePath(card.pictureBase);

				if (path) {
					const sent = await uploadPicture(card.pictureBase, path).catch(() => false);

					imagePath = sent ? path : null;
					noPicture = !sent;
				}
			}

			const saved = await saveConsigned(consignedRecord(existing ? {...existing} : card, {
				commission_pct: terms.pct,
				condition: condition.value,
				consignor_id: consignorId,
				finish: existing ? existing.finish : chosen ? finishName(chosen.variant) : null,
				image_path: imagePath,
				min_commission_brl: terms.minimum ?? 0,
				note: note.value,
				price_brl: typed.value,
			}));
			const who = consignorId === consignor.value && person() ? person().name : newName.value.trim();

			sheet.close();
			toast(existing
				? `${saved.name} saved: ${brl(saved.price_brl)}, ${who} gets ${brl(saved.payout_brl)}.`
				: `${saved.name} is on HOTARU for ${brl(saved.price_brl)}. ${who} gets ${brl(saved.payout_brl)}.${noPicture ? ' No picture yet: TCGdex did not send it.' : ''}`);
			await onSaved(saved);
		}
		catch (err) {
			fail(consignErrorText(err));
			saveButton.disabled = false;
		}
	}

	fillTerms();
	newBox.hidden = consignor.value !== NEW;

	sheet = sheetFrame('consign-sheet', existing ? `Edit ${existing.name}` : 'Consign a card', h('form', {class: 'shop-kit-form', onsubmit: save},
		h('p', {class: 'muted', id: 'consign-print'}, [print.name, print.number ? `#${print.number}` : null, print.set_name].filter(Boolean).join(' · ')),
		h('p', {class: 'muted'}, 'Someone else\'s card: it goes on HOTARU, never into your collection.'),
		...field('Consignor', 'consign-consignor', consignor),
		newBox,
		...(finish ? field('Finish', 'consign-finish', finish) : []),
		...field('Condition', 'consign-condition', condition),
		...field('Price the buyer pays (R$)', 'consign-price', price),
		h('p', {class: 'shop-kit-label'}, 'Commission'),
		h('div', {class: 'shop-kit-amount'}, h('span', {class: 'shop-kit-unit'}, '%'), pct),
		h('div', {class: 'shop-kit-amount'}, h('span', {class: 'shop-kit-unit'}, 'R$ min'), minimum),
		preview,
		...field('Note (optional)', 'consign-note', note),
		error,
		h('div', {class: 'shop-kit-buttons'},
			h('button', {onclick: () => sheet.close(), type: 'button'}, 'Cancel'),
			saveButton)));
	drawSplit();
	(consignor.value === NEW ? newName : price).focus({preventScroll: true});

	return sheet;
}
