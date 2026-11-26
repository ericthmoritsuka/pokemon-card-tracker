// Consignment's numbers and words (plans/hotaru-consignment-plan.md, Eric
// 2026-11-26): cards other people leave with the shop, sold on HOTARU for a
// commission taken out of the sale price. No DOM and no server here, so the
// Shop screen (js/shop-consignment.js) and the tests share them.
//
// The formula is supabase/store-consignment.sql's private.commission, done
// in whole centavos so it rounds the same way: the percent of the price,
// rounded half up to the centavo, never less than the minimum, and never
// more than the price.

// Whole centavos from reais, or null for anything that is not a sum.
export function toCents(value) {
	const n = typeof value === 'string' ? Number(value.replace(',', '.')) : Number(value);

	return value === null || value === undefined || value === '' || !Number.isFinite(n) ? null : Math.round(n * 100);
}

const fromCents = (cents) => cents / 100;

// The commission on one sale, in reais. R$ 100,00 at 15% with a R$ 5,00
// minimum is R$ 15,00; R$ 20,00 is R$ 5,00; R$ 4,00 is R$ 4,00.
export function commission(price, pct, minimum) {
	const cents = toCents(price);

	if (cents === null || cents <= 0) {
		return 0;
	}

	// The percent in hundredths, so 12,5% stays exact; then half up.
	const share = Math.floor((cents * Math.round(Number(pct || 0) * 100) + 5000) / 10000);

	return fromCents(Math.min(cents, Math.max(share, toCents(minimum) || 0)));
}

// {price, commission, payout} for one card, all in reais.
export function split(price, pct, minimum) {
	const cut = commission(price, pct, minimum);

	return {commission: cut, payout: fromCents((toCents(price) || 0) - toCents(cut)), price: fromCents(toCents(price) || 0)};
}

// The terms a new card takes: what was typed, else the consignor's, else
// the shop's. Each is {commission_pct, min_commission_brl}, with null for
// "not set".
export function termsFor(consignor, settings, typed = {}) {
	const pick = (key) => [typed[key], consignor && consignor[key], settings && settings[key]].find((value) => value !== null && value !== undefined && value !== '');

	return {
		commission_pct: Number(pick('commission_pct') ?? 0),
		min_commission_brl: Number(pick('min_commission_brl') ?? 0),
	};
}

// "15%, at least R$ 5,00".
export function termsText({commission_pct: pct, min_commission_brl: minimum}, brl) {
	const percent = `${String(Number(pct)).replace('.', ',')}%`;

	return Number(minimum) > 0 ? `${percent}, at least ${brl(Number(minimum))}` : percent;
}

// A percent typed in the sheet: "15", "12,5". {value, error}.
export function parsePercent(text) {
	const clean = String(text ?? '').trim().replace('%', '').replace(',', '.');

	if (!clean) {
		return {error: null, value: null};
	}

	const n = Number(clean);

	if (!Number.isFinite(n) || n < 0 || n > 90) {
		return {error: 'Type a percent from 0 to 90.', value: null};
	}

	return {error: null, value: Math.round(n * 100) / 100};
}

// The state a consigned card's row shows.
export const CARD_STATES = {
	available: 'For sale',
	reserved: 'In an order',
	returned: 'Returned',
	sold: 'Sold',
	withdrawn: 'Not for sale',
};

// The state a payout shows.
export const PAYOUT_STATES = {
	due: 'Due',
	paid: 'Paid',
	waiting: 'Waiting for delivery',
};

// A consignor's cards and payouts, from store_consignment_admin's answer.
export function consignorParts(data, consignorId) {
	const cards = ((data && data.cards) || []).filter((card) => card.consignor_id === consignorId);
	const payouts = ((data && data.payouts) || []).filter((payout) => payout.consignor_id === consignorId);

	return {cards, payouts};
}

// The consignor's name for each consigned listing, so an order can say
// whose card it is.
export function ownersByListing(data) {
	const names = new Map(((data && data.consignors) || []).map((one) => [one.id, one.name]));

	return new Map(((data && data.cards) || []).map((card) => [card.id, names.get(card.consignor_id) || null]));
}

const DAY = new Intl.DateTimeFormat('pt-BR', {day: '2-digit', month: '2-digit', timeZone: 'America/Recife'});
const DATE = new Intl.DateTimeFormat('pt-BR', {day: '2-digit', month: '2-digit', timeZone: 'America/Recife', year: 'numeric'});

// Plain spaces, so the text pastes the same everywhere.
const plainText = (text) => String(text).replace(/[\u00a0\u202f]/g, ' ');

// "Charizard #4".
const cardName = (card) => [card.name, card.number ? `#${card.number}` : null].filter(Boolean).join(' ');

// The statement Eric sends a consignor on WhatsApp, in Portuguese:
//
//   HOTARU · Extrato de Ana · 26/11/2026
//   À venda (1): Pikachu #58 R$ 40,00
//   Vendidas (2): Charizard #4 R$ 100,00, repasse R$ 85,00 (pago 26/11); ...
//   A receber: R$ 15,00
//   Já recebido: R$ 85,00
//
// brl formats reais (js/prices.js formatBrl).
export function statementText(consignor, data, {brl, now = new Date()}) {
	const {cards, payouts} = consignorParts(data, consignor.id);
	const payoutOf = new Map(payouts.map((payout) => [payout.listing_id, payout]));
	const lines = [`HOTARU · Extrato de ${consignor.name} · ${DATE.format(now)}`];
	const list = (label, items, line) => {
		if (items.length) {
			lines.push(`${label} (${items.length}): ${items.map(line).join('; ')}`);
		}
	};
	const status = (card) => (card.status === 'withdrawn' && card.returned_at ? 'returned' : card.status);

	list('À venda', cards.filter((card) => status(card) === 'available'), (card) => `${cardName(card)} ${brl(Number(card.price_brl))}`);
	list('Reservadas', cards.filter((card) => status(card) === 'reserved'), (card) => `${cardName(card)} ${brl(Number(card.price_brl))}`);
	list('Vendidas', cards.filter((card) => status(card) === 'sold'), (card) => {
		const payout = payoutOf.get(card.id);

		if (!payout) {
			return `${cardName(card)} ${brl(Number(card.price_brl))}`;
		}

		const when = payout.paid_at ? `pago ${DAY.format(new Date(payout.paid_at))}` : payout.state === 'due' ? 'a pagar' : 'aguardando entrega';

		return `${cardName(card)} ${brl(Number(payout.sale_brl))}, repasse ${brl(Number(payout.payout_brl))} (${when})`;
	});
	list('Devolvidas', cards.filter((card) => status(card) === 'returned'), cardName);

	const sum = (items) => fromCents(items.reduce((total, payout) => total + toCents(payout.payout_brl), 0));

	lines.push(`A receber: ${brl(sum(payouts.filter((payout) => !payout.paid_at)))}`);
	lines.push(`Já recebido: ${brl(sum(payouts.filter((payout) => payout.paid_at)))}`);

	return plainText(lines.join('\n'));
}

// The record save_consigned takes. card is what the sheet knows of the
// print ({card_id, catalog, language, name, number, set_name, rarity}),
// fields what was typed.
export function consignedRecord(card, fields) {
	const text = (value, max) => {
		const clean = value === null || value === undefined ? '' : String(value).trim();

		return clean ? clean.slice(0, max) : null;
	};

	const record = {
		card_id: text(card.card_id, 64),
		catalog: text(card.catalog, 32),
		commission_pct: fields.commission_pct,
		condition: text(fields.condition, 40),
		consignor_id: fields.consignor_id,
		finish: text(fields.finish, 80),
		language: text(card.language, 16),
		min_commission_brl: fields.min_commission_brl,
		name: text(card.name, 160) || text(card.card_id, 160),
		note: text(fields.note, 500),
		number: text(card.number, 32),
		price_brl: fields.price_brl,
		rarity: text(card.rarity, 80),
		set_name: text(card.set_name, 160),
	};

	if (card.id) {
		record.id = card.id;
	}

	if (fields.image_path) {
		record.image_path = fields.image_path;
	}

	return record;
}
