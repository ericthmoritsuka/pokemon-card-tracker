// The Shop's Kits (plans/hotaru-bundles-plan.md, Eric 2026-11-25): several
// priced cards sold together on HOTARU at a price Eric types, or at a
// percent off their sum. Tick two or more cards in the Shop and tap Kit N
// selected; the sheet takes a name and the price. The Kits section lists
// every kit with its state, and Edit, Turn off, and Delete. After each
// Publish, a kit whose copy sold, is held by an order, or left the spares
// takes another listed copy of the same card (refill), so it stays on
// HOTARU while one exists. An order's cards are listed under their kit.
//
// The calls are supabase/store-bundles.sql's, for the family's owner only.
// The numbers are js/kits.js; the styles, css/shop.css. js/shop-view.js
// holds the hooks: the button by the ticks, the section, the refill after
// Publish, and the order lists.

import {getClient} from './auth.js';
import {h} from './dom.js';
import {formatCount, plural} from './format.js';
import {copiesInKits, KIT_MAX, KIT_MIN, kitDefaultName, kitPrice, kitRecord, kitSum, orderGroups, parsePercent, percentOff, pickCopy, refillKit} from './kits.js';
import {parsePrice, priceForInput} from './moves.js';
import {formatBrl} from './prices.js';
import {openDialogSheet} from './sheet.js';

async function call(name, args = {}) {
	const client = await getClient();
	const {data, error} = await client.rpc(name, args);

	if (error) {
		throw error;
	}

	return data;
}

export async function listKits() {
	const data = await call('store_bundles_admin');

	return Array.isArray(data) ? data : [];
}

export const saveKit = (record) => call('save_bundle', {kit: record});

export const deleteKit = (id) => call('delete_bundle', {kit_id: id});

// Why a kit call failed, for the Shop screen.
export function kitErrorText(error) {
	const code = error && error.code;
	const message = String((error && error.message) || '');

	if (code === 'PGRST202' || code === '42883' || /store_bundles|save_bundle|delete_bundle/.test(message)) {
		return 'Kits are not set up yet: run supabase/store-bundles.sql in the Supabase SQL Editor.';
	}

	return message || 'The server did not answer.';
}

// A copy's state in a kit, when it is not for sale now.
const STATUS_TEXT = {reserved: 'in an order', sold: 'sold', withdrawn: 'not for sale'};

// "Sprigatito #001 · Near Mint".
const cardLine = (name, number, condition) => [[name, number ? `#${number}` : null].filter(Boolean).join(' '), condition].filter(Boolean).join(' · ');

// "R$ 14,25 · 5% off · R$ 15,00 apart".
function priceLine(kit) {
	const off = kit.price_mode === 'percent' ? Number(kit.discount_pct) : percentOff(Number(kit.price), Number(kit.sum));

	return [formatBrl(kit.price), off ? `${String(off).replace('.', ',')}% off` : null, `${formatBrl(kit.sum)} apart`].filter(Boolean).join(' · ');
}

// The record save_bundle takes, from a kit as store_bundles_admin lists it.
const recordOf = (kit, changes = {}) => kitRecord({
	active: kit.active,
	description: kit.description,
	discount: kit.discount_pct === null ? null : Number(kit.discount_pct),
	id: kit.id,
	items: kit.items.map((item) => item.listing_id),
	mode: kit.price_mode,
	name: kit.name,
	price: kit.price_brl === null ? null : Number(kit.price_brl),
	...changes,
});

// The Kits section. groups() and finishText(group) are the Shop's; toast
// is its toast. Shown to the owner once the kits are read.
// onDraw is told the number of kits after each draw (null while unknown),
// for the Shop's Kits tab.
export function kitsSection({finishText, groups, onDraw = () => {}, toast}) {
	let alive = true;
	let owner = false;
	let kits = [];
	let loaded = false;
	let problem = null;
	const confirming = new Set();
	const working = new Set();
	const node = h('section', {'aria-labelledby': 'shop-kits-title', class: 'shop-kits', hidden: true, id: 'shop-kits'});

	function draw() {
		node.hidden = !owner || (!loaded && !problem);
		onDraw(node.hidden || problem ? null : kits.length);

		if (node.hidden) {
			return;
		}

		if (problem) {
			node.replaceChildren(h('h3', {id: 'shop-kits-title'}, 'Kits'), h('p', {class: 'muted', id: 'shop-kits-problem', role: 'status'}, problem));

			return;
		}

		const live = kits.filter((kit) => kit.available).length;

		node.replaceChildren(
			h('h3', {id: 'shop-kits-title'}, kits.length ? `Kits (${formatCount(kits.length)})` : 'Kits'),
			h('p', {class: 'muted', id: 'shop-kits-note'}, kits.length
				? `${plural(live, 'kit', 'kits')} on HOTARU. Their cards are still sold one by one too.`
				: `On the Prices tab, tick ${KIT_MIN} or more priced cards, then tap Kit selected, to sell them together for less.`),
			...kits.map(kitCard)
		);
	}

	function kitCard(kit) {
		const busy = working.has(kit.id);
		const off = kit.items.filter((item) => item.status !== 'available');
		const state = !kit.active
			? 'Off: not on HOTARU.'
			: off.length
				? `Not on HOTARU: ${off.map((item) => `${item.name} is ${STATUS_TEXT[item.status] || item.status}`).join(', ')}.`
				: 'On HOTARU.';
		const actions = confirming.has(kit.id)
			? [
				h('p', {class: 'shop-kit-ask'}, `Delete ${kit.name}? Its cards stay for sale one by one.`),
				h('button', {disabled: busy, onclick: () => remove(kit), type: 'button'}, 'Delete kit'),
				h('button', {disabled: busy, onclick: () => {
					confirming.delete(kit.id);
					draw();
				}, type: 'button'}, 'Back'),
			]
			: [
				h('button', {class: 'small', disabled: busy, onclick: () => openKitSheet({existing: kit, onSaved: load, toast}), type: 'button'}, 'Edit'),
				h('button', {class: 'small', disabled: busy, onclick: () => turn(kit), type: 'button'}, kit.active ? 'Turn off' : 'Turn on'),
				h('button', {class: 'small', disabled: busy, onclick: () => {
					confirming.add(kit.id);
					draw();
				}, type: 'button'}, 'Delete'),
			];

		return h('article', {class: `card shop-kit${kit.available ? ' shop-kit-live' : ''}`, 'data-id': kit.id, id: `kit-${kit.id}`},
			h('h4', {class: 'shop-kit-name'}, kit.name),
			h('p', {class: 'shop-kit-price'}, priceLine(kit)),
			h('ul', {class: 'shop-kit-cards'}, kit.items.map((item) => h('li', {class: item.status === 'available' ? null : 'shop-kit-off'},
				`${cardLine(item.name, item.number, item.condition)} · ${formatBrl(item.price_brl)}${item.status === 'available' ? '' : ` · ${STATUS_TEXT[item.status] || item.status}`}`))),
			h('p', {class: kit.available ? 'shop-kit-state' : 'status shop-kit-state'}, state),
			h('div', {class: 'shop-kit-actions'}, ...actions)
		);
	}

	async function act(kit, action) {
		working.add(kit.id);
		draw();

		try {
			await action();
		}
		catch (err) {
			toast(`${kit.name}: ${kitErrorText(err)}`);
		}
		finally {
			working.delete(kit.id);
		}

		await load();
	}

	const turn = (kit) => act(kit, async () => {
		await saveKit(recordOf(kit, {active: !kit.active}));
		toast(kit.active ? `${kit.name} is off HOTARU. Its cards are still sold one by one.` : `${kit.name} is back on HOTARU.`);
	});

	const remove = (kit) => act(kit, async () => {
		confirming.delete(kit.id);
		await deleteKit(kit.id);
		toast(`${kit.name} deleted. Its cards stay for sale.`);
	});

	async function load() {
		if (!owner) {
			return kits;
		}

		try {
			const found = await listKits();

			if (!alive) {
				return kits;
			}

			kits = found;
			loaded = true;
			problem = null;
		}
		catch (err) {
			if (!alive) {
				return kits;
			}

			// A family member who is not the shop's owner sees no kits.
			if (err && err.code === '42501') {
				owner = false;
			}
			else {
				problem = kitErrorText(err);
			}
		}

		draw();

		return kits;
	}

	// After a Publish: a kit's copy that is not available takes another
	// listed copy of the same card, if any. states is store_sync's answer.
	async function refill(states) {
		if (!owner) {
			return;
		}

		await load();

		const swapped = [];
		const missing = [];

		for (const kit of kits) {
			if (!alive || !kit.active || kit.items.every((item) => item.status === 'available')) {
				continue;
			}

			const plan = refillKit(kit, groups(), {finishText, skip: copiesInKits(kits, {except: kit.id}), states});

			if (plan.missing.length) {
				missing.push(...plan.missing);
			}

			if (plan.changed) {
				try {
					await saveKit(recordOf(kit, {items: plan.items}));
					swapped.push(kit.name);
				}
				catch (err) {
					toast(`${kit.name} was not refilled. ${kitErrorText(err)}`);
				}
			}
		}

		if (swapped.length && alive) {
			await load();
			toast(`${swapped.join(', ')}: another copy took the place of one that is no longer for sale.`);
		}
	}

	return {
		get kits() {
			return kits;
		},
		load,
		node,
		refill,
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

// The sheet that makes a kit from the ticked groups (chosen), or edits one
// (existing). A new kit takes one copy of each card: listed, for sale now,
// not held by another kit when another copy will do, the best condition
// first. onSaved runs after a save.
export function openKitSheet({chosen = null, existing = null, kits = [], onSaved = () => {}, states = null, toast}) {
	let cards;

	if (existing) {
		cards = existing.items.map((item) => ({condition: item.condition, id: item.listing_id, name: item.name, number: item.number, price: Number(item.price_brl)}));
	}
	else {
		const unpriced = chosen.filter((group) => group.price === null);

		if (unpriced.length) {
			toast(`Give ${unpriced.map((group) => group.info.name).join(', ')} a price first: a kit holds only cards on HOTARU.`);

			return null;
		}

		if (chosen.length < KIT_MIN || chosen.length > KIT_MAX) {
			toast(`A kit holds ${KIT_MIN} to ${KIT_MAX} cards.`);

			return null;
		}

		const others = copiesInKits(kits);
		const taken = new Set();

		cards = [];

		for (const group of chosen) {
			const copy = pickCopy(group, {skip: new Set([...others, ...taken]), states}) || pickCopy(group, {skip: taken, states});

			if (!copy) {
				toast(`${group.info.name} has no copy for sale right now.`);

				return null;
			}

			taken.add(copy.id);
			cards.push({condition: copy.condition || null, id: copy.id, name: group.info.name || group.card_id, number: group.info.number || null, price: group.price});
		}
	}

	const sum = kitSum(cards.map((card) => card.price));
	const sheet = h('dialog', {'aria-labelledby': 'shop-kit-title', class: 'sheet shop-kit-sheet', id: 'shop-kit-sheet'});
	const defaultName = kitDefaultName(cards.map((card) => card.name));
	const nameInput = h('input', {autocomplete: 'off', class: 'search', id: 'shop-kit-name', maxlength: 80, placeholder: defaultName, type: 'text', value: existing ? existing.name : ''});
	const description = h('textarea', {class: 'search shop-kit-description', id: 'shop-kit-description', maxlength: 500, rows: 2});
	let mode = existing ? existing.price_mode : 'percent';
	const amount = h('input', {autocomplete: 'off', class: 'search shop-price-input', id: 'shop-kit-amount', inputmode: 'decimal', type: 'text'});
	const unit = h('span', {class: 'shop-kit-unit', id: 'shop-kit-unit'});
	const preview = h('p', {'aria-live': 'polite', class: 'muted shop-kit-preview', id: 'shop-kit-preview'});
	const error = h('p', {class: 'form-error', hidden: true, id: 'shop-kit-error', role: 'alert'});
	const saveButton = h('button', {class: 'primary', id: 'shop-kit-save', type: 'submit'}, 'Save kit');

	description.value = existing ? existing.description || '' : '';

	if (existing) {
		amount.value = mode === 'fixed' ? priceForInput(Number(existing.price_brl)) : String(existing.discount_pct).replace('.', ',');
	}

	const modes = h('div', {'aria-label': 'Price the kit by', class: 'segmented', id: 'shop-kit-mode', role: 'radiogroup'},
		[['percent', 'Discount'], ['fixed', 'Price']].map(([value, label]) => h('label', null,
			h('input', {checked: value === mode, name: 'shop-kit-mode', onchange: () => {
				mode = value;
				amount.value = '';
				drawAmount();
				amount.focus();
			}, type: 'radio', value}),
			h('span', {'data-label': label}, label))));

	// The price the rule gives, or the reason the amount is not one.
	function reading() {
		if (mode === 'percent') {
			const typed = parsePercent(amount.value);

			return {error: typed.error, price: typed.value === null ? null : kitPrice({discount_pct: typed.value, price_mode: 'percent'}, sum), value: typed.value};
		}

		const typed = parsePrice(amount.value);

		return {error: typed.error, price: typed.value, value: typed.value};
	}

	function drawAmount() {
		unit.textContent = mode === 'percent' ? '% off' : 'R$';
		amount.placeholder = mode === 'percent' ? '5' : priceForInput(sum);
		amount.setAttribute('aria-label', mode === 'percent' ? 'Discount in percent' : 'Kit price in reais');
		drawPreview();
	}

	function drawPreview() {
		const {error: wrong, price} = reading();
		const apart = `${plural(cards.length, 'card')}, ${formatBrl(sum)} apart.`;

		if (wrong || price === null) {
			preview.textContent = apart;

			return;
		}

		const off = mode === 'percent' ? reading().value : percentOff(price, sum);

		preview.textContent = price >= sum
			? `${apart} Kit: ${formatBrl(price)}. No discount: the cards cost ${formatBrl(sum)} apart.`
			: `${apart} Kit: ${formatBrl(price)}${off ? `, ${String(off).replace('.', ',')}% off` : ''}.`;
	}

	amount.addEventListener('input', () => {
		error.hidden = true;
		drawPreview();
	});

	async function save(event) {
		event.preventDefault();

		const {error: wrong, value} = reading();

		if (wrong || value === null) {
			error.textContent = wrong || (mode === 'percent' ? 'Type the discount, such as 5.' : 'Type the kit\'s price.');
			error.hidden = false;
			amount.focus();

			return;
		}

		saveButton.disabled = true;

		try {
			const record = kitRecord({
				active: existing ? existing.active : true,
				description: description.value,
				discount: mode === 'percent' ? value : null,
				id: existing ? existing.id : null,
				items: cards.map((card) => card.id),
				mode,
				name: nameInput.value.trim() || defaultName,
				price: mode === 'fixed' ? value : null,
			});
			const saved = await saveKit(record);

			sheet.close();
			toast(existing ? `${saved.name} saved.` : `${saved.name} is on HOTARU for ${formatBrl(saved.price)}.`);
			await onSaved(saved);
		}
		catch (err) {
			error.textContent = kitErrorText(err);
			error.hidden = false;
			saveButton.disabled = false;
		}
	}

	sheet.addEventListener('click', (event) => {
		if (event.target === sheet) {
			sheet.close();
		}
	});
	sheet.append(h('form', {class: 'shop-kit-form', id: 'shop-kit-form', onsubmit: save},
		h('div', {class: 'sheet-head'},
			h('h2', {id: 'shop-kit-title'}, existing ? 'Edit kit' : 'New kit'),
			h('button', {class: 'small', id: 'shop-kit-close', onclick: () => sheet.close(), type: 'button'}, 'Close')),
		h('ul', {'aria-label': 'Cards in the kit', class: 'shop-kit-cards', id: 'shop-kit-cards'},
			cards.map((card) => h('li', null, `${cardLine(card.name, card.number, card.condition)} · ${formatBrl(card.price)}`))),
		h('p', {class: 'muted'}, 'These exact copies are sold together. Each is still sold alone too; whoever orders first gets it.'),
		h('label', {class: 'shop-kit-label', for: 'shop-kit-name'}, 'Name'),
		nameInput,
		h('label', {class: 'shop-kit-label', for: 'shop-kit-description'}, 'Description (optional)'),
		description,
		modes,
		h('div', {class: 'shop-kit-amount'}, unit, amount),
		preview,
		error,
		h('div', {class: 'shop-kit-buttons'},
			h('button', {onclick: () => sheet.close(), type: 'button'}, 'Cancel'),
			saveButton)));
	document.body.append(sheet);
	drawAmount();
	openDialogSheet(sheet, {onClose: () => sheet.remove()});
	// The amount is what a kit needs; focused without scrolling the sheet
	// past its title.
	amount.focus({preventScroll: true});
	sheet.scrollTop = 0;

	return sheet;
}

// An order's cards: singles with their price, and each kit's cards under
// its name and price. itemLine is the Shop's.
export function orderItemsNode(items, itemLine) {
	return h('ul', {class: 'shop-order-items'}, orderGroups(items).map((one) => (one.kind === 'single'
		? h('li', null, `${itemLine(one.item)} · ${formatBrl(one.item.price_brl)}`)
		: h('li', {class: 'shop-order-kit'},
			h('span', {class: 'shop-order-kit-name'}, `Kit ${one.name} · ${formatBrl(one.price)}`),
			h('ul', null, one.items.map((item) => h('li', null, itemLine(item))))))));
}
