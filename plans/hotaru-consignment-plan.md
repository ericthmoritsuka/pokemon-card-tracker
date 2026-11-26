# Consignment: Other People's Cards on HOTARU

Eric, 2026-11-26: he wants to sell cards that belong to other people on HOTARU and keep a
commission. The buyer pays Eric by Pix, as today; Eric then pays the card's owner their share. The
card stays with Eric from the day he receives it until it is delivered or returned, so he never
depends on anyone else to hold the money or the card.

Status: plan only, with the decisions in section 9 answered by Eric on 2026-11-26. Nothing is
built until he says to start. Release slot: the next free tracker version, gated on a new SQL file Eric
runs by hand, plus one HOTARU pull request.

Builds on: `store_listings` (`supabase/store.sql`; `kind` is `single` or `sealed`); `store_sync`
and `store_withdraw`, which touch `kind = 'single'` rows only; `place_order`, which reserves listing
IDs whatever their kind (`supabase/store-bundles.sql`); `mark_paid` (`supabase/store-orders.sql`);
the Shop's order handling in `js/shop.js` (`isCard`, `orderCheck`, `saleFields`), which treats any
kind other than `single` as stock outside the collection; Add and sell (`js/shop-owner.js`), which
sends the owner to find a card and opens the next sheet prepared; `storePicturePath` for TCGdex
pictures.

Words: the tracker's English UI says **Consigned** and **Consignor**; HOTARU says nothing to the
buyer by default (decision 2). Owner-facing Portuguese text, such as the statement in section 6,
says **consignado**, **repasse**, and **comissão**.

## 1. The Deal

The commission comes **out of the sale price**. Eric and the consignor agree on the price the buyer
pays, and the consignor receives that price minus the commission. This keeps prices comparable with
the market, and a later price cut is shared by both.

```
commission = min(price, max(round(price × pct / 100, 2), minimum))
payout     = price − commission
```

Defaults (decision 1): **15%**, **minimum R$ 5,00 per card sold**.

| Price | 15%, minimum R$ 5 | 15%, minimum R$ 10 |
| ---: | --- | --- |
| R$ 20,00 | Commission R$ 5,00 (25%), payout R$ 15,00 | Commission R$ 10,00 (50%), payout R$ 10,00 |
| R$ 50,00 | R$ 7,50, payout R$ 42,50 | R$ 10,00 (20%), payout R$ 40,00 |
| R$ 100,00 | R$ 15,00, payout R$ 85,00 | R$ 15,00, payout R$ 85,00 |
| R$ 400,00 | R$ 60,00, payout R$ 340,00 | R$ 60,00, payout R$ 340,00 |

The minimum only matters for prices under about R$ 33 (minimum R$ 5) or R$ 67 (minimum R$ 10). A R$ 10 minimum takes half of a R$ 20 card, which may put off people with cheaper cards.

**Where the numbers are set:**

- **Shop defaults:** one percent and one minimum, editable in the Consignment section.
- **Per consignor:** an optional percent and minimum that override the defaults (a regular with
  many cards may get 10%).
- **Per card:** when a card is consigned, the sheet copies the consignor's terms into the card and
  lets Eric change them (decision 5). The card keeps those terms until it is sold or returned, so
  changing a default later never changes a deal already made.

## 2. What a Consigned Card Is

A consigned card is a `store_listings` row with **`kind = 'consigned'`**, ID `cons-<uuid>`, and the
same card columns a single has (`card_id`, `catalog`, `language`, `finish`, `condition`, `name`,
`set_name`, `number`, `rarity`, `image_path`, `price_brl`).

It is **not** a copy in Eric's collection: no entry in the collection document, so it never counts
in stats, binders, checklists, spares, trade ideas, or wishlists.

Why a new kind rather than `single` with an owner column:

- `store_sync` withdraws every available `single` the Publish does not send. A consigned `single`
  would disappear on the next Publish unless `store_sync` and `store_withdraw` were redefined.
- `js/shop.js` treats a `single` as a collection copy: `orderCheck` would flag it as missing, and
  Payment received would log it as Eric's sale. With its own kind, both already leave it alone.
- `save_bundle` already accepts `single` listings only, so consigned cards stay out of kits
  (section 8) with no change.

## 3. Server (`supabase/store-consignment.sql`, new)

Run after `store-bundles.sql`. Safe to run again.

- `store_listings`: replace the inline kind check (`store_listings_kind_check`; confirm the name in
  the live project before dropping it) with `kind in ('single', 'sealed', 'consigned')`.
- `store_settings`, one row: `commission_pct numeric(5, 2) default 15`, `min_commission_brl
  numeric(10, 2) default 5`.
- `store_consignors`: `id uuid`, `name` (1 to 80), `phone`, `pix_key`, `commission_pct` and
  `min_commission_brl` (null means the Shop default), `note`, `active`, `created_at`.
- `store_consignments`, one row per consigned listing: `listing_id` (primary key, references
  `store_listings`), `consignor_id`, `commission_pct`, `min_commission_brl`, `received_at`,
  `returned_at`, `note`.
- `store_payouts`, one row per consigned card sold: `id`, `listing_id` (unique, so a payout is
  never created twice), `order_id`, `consignor_id`, `sale_brl`, `commission_brl`, `payout_brl`,
  `created_at`, `paid_at`, `paid_note`.
- Owner-read RLS on all four, like `store_listings`; writes only through the owner calls below.
- `private.commission(price, pct, minimum)`: the formula in section 1.
- Owner calls: `save_store_settings(settings jsonb)`, `save_consignor(consignor jsonb)`,
  `save_consigned(card jsonb)` (creates the listing and its consignment row, or edits price, terms,
  condition, and note while the card is `available` or `withdrawn`), `return_consigned(listing_id)`
  (sets the listing `withdrawn` and `returned_at`; refused while `reserved` or `sold`),
  `relist_consigned(listing_id)`, `mark_payouts_paid(ids uuid[], note text)`, and
  `store_consignment_admin()`, which returns the settings, each consignor with counts (for sale,
  reserved, sold, returned) and balances (waiting for delivery, due, paid), every consigned card
  with its status, and every payout.
- `mark_paid` redefined: after setting the order's listings `sold`, it inserts a payout for each
  consigned listing in the order, from the card's own terms, `on conflict (listing_id) do nothing`.
  `store-orders.sql`'s copy becomes stale, and the file header says so, as with `store_catalog`.
- `private.is_store_path` widened to `consigned/<listing id>.jpg` for Eric's own photo of a
  consigned card, keeping every path `store-own-pictures.sql` allows (`tcgdex/`, `own/`,
  `sealed/`).
- No change to `store_catalog`, `listing_status`, `place_order`, `release_expired`, `cancel_order`,
  `order_status`, or `store_orders_open`: they already carry any kind.

Verified the same way as the earlier store files: a `postgres:16` container with the auth and
storage stubs, covering the commission formula at the edges (price below the minimum, exactly at
the break-even price, centavo rounding), a payout created once when `mark_paid` runs twice, return
refused while reserved, and a Publish (`store_sync`) that leaves consigned rows untouched.

## 4. Tracker: Adding a Consigned Card

- **From the Shop:** a **Consign a card** button in the new Consignment section works like Add and
  sell: Eric finds the card, and its card page opens the **Consign** sheet.
- **From any card page:** a **Consign** button beside Add a copy, shown only to the shop owner, so
  it stays one tap away.
- **The Consign sheet:** consignor (pick one, or **New consignor** inline with name, phone, and Pix
  key), language, finish (the same finish list Add a copy uses, so HOTARU's badges read it), and
  condition, price with the Shop's TCGplayer and Cardmarket suggestions in R$, and the terms
  prefilled from the consignor. A live line shows the split: "Buyer pays R$ 100,00 · Ana gets
  R$ 85,00 · You keep R$ 15,00".
- **Picture:** the TCGdex picture through `storePicturePath`, uploaded the way Publish uploads it
  when the bucket lacks it; or Eric's own photo to `consigned/<listing id>.jpg` when the catalog has
  none or he wants the real card shown.
- Saving calls `save_consigned`. The card is on HOTARU at once; no Publish needed.

## 5. Tracker: the Consignment Section in the Shop

Below Kits, collapsed by default when empty:

- **Defaults:** the Shop percent and minimum, with Edit.
- **Consignors:** one row each with counts and balances ("3 for sale · 2 sold · R$ 127,50 due"),
  and Edit for contact, Pix key, and terms.
- **Cards:** one row per consigned card with its art, consignor, price, terms, and status (for
  sale, reserved, sold, returned), with Edit, **Return to owner** (inline confirm), and **Put back
  on sale** for a returned card.
- **Payouts:** grouped by consignor. A payout is **Waiting for delivery** until the order is
  marked Delivered, then **Due** (decision 4). **Copy Pix key** and **Mark paid** (one consignor's
  due payouts at once, with an optional note).
- **Orders:** an order item that is consigned shows "Consigned · Ana" in the order list, matched
  through `store_consignment_admin`, so `store_orders_open` needs no new column.
- New module `js/shop-consignment.js` (section and sheet) and pure `js/consignment.js` (commission,
  balances, statement text), added to `sw.js`'s precache in the release commit.

Payment received is unchanged. For a consigned item, `saleFields` already keeps it out of the cards'
sale and names it in the note ("HOTARU HTR-0012, with Charizard"); an order of consigned cards alone
logs no sale, which is right, because the cards were never in the collection.

## 6. Statement for the Consignor

**Copy statement** on a consignor's row puts a Portuguese text on the clipboard for WhatsApp:

```
HOTARU · Extrato de Ana · 26/11/2026
À venda (3): Pikachu 25/102 R$ 40,00; ...
Vendidas (2): Charizard 4/102 R$ 100,00, repasse R$ 85,00 (pago 20/11); ...
A receber: R$ 42,50
Já recebido: R$ 85,00
```

There is no consignor login in this plan (section 8).

## 7. HOTARU

- `assets/catalogo.js:741` and `assets/admin.js:434` read cards with `row.kind !== 'single'`.
  Both accept `consigned` as a card, through one `isCardRow` helper.
- Audit every other `kind` branch (cart, `pedido.html`, Meus pedidos, Destaques, `carta.html`'s
  Também à venda) so a consigned card renders exactly as a single. The branches seen so far test
  for `sealed` or `kit` and fall through to the card path, which is what a consigned card needs.
- Default (decision 2): no mark for the buyer. A consigned card and Eric's own copy of the same
  card, language, and finish sit in the same tile and buy box.
- A Playwright check alongside the existing ones: a consigned listing in the catalog, on
  `carta.html`, in the cart, and through `place_order`.

## 8. Not in This Plan

- Consigned cards in kits (`save_bundle` refuses them today) and kits that mix owners.
- A consignment mode in the scanner, for taking in a stack of cards at once.
- A consignor login or page on HOTARU to follow their own cards.
- Refunds after a payment is received (no refund flow exists for any order yet).
- A written agreement generated by the app. Eric agrees terms by message: price, commission, a
  term (suggested 60 days, with a price review at 30), payout after payment and delivery, who
  answers for damage while the card is with Eric, and that the owner can take the card back while
  it is not reserved.

## 9. Decisions

Eric answered 1 to 4 on 2026-11-26, each time choosing the recommended option. Decision 5 was not
asked, so it stays at the recommended option unless he says otherwise.

1. **Defaults:** 15% with a R$ 5,00 minimum per card. **Chosen.** (The alternative was R$ 10,00.)
   Both numbers stay editable in the Shop and per consignor, as Eric asked.
2. **Buyer sees consignment:** no mark. **Chosen.** (The alternative was a "Consignado" tag.)
3. **Where consigned cards are entered:** the tracker. **Chosen.** (The alternative was HOTARU's
   `admin.html`.)
4. **When a payout is due:** after the order is marked Delivered. **Chosen.** (The alternative was
   as soon as the payment is received.)
5. **Terms per card:** each card copies the consignor's terms and can change them. Default, not
   asked.

## 10. Build Order

1. `supabase/store-consignment.sql`, verified in the container; Eric runs it in the SQL Editor.
2. Tracker: `js/consignment.js` with unit tests, then the sheet and the Shop section with browser
   tests; full suite; release through the orchestrator.
3. HOTARU pull request: `isCardRow`, the audit, and the check; merged after the tracker release is
   live and the SQL has run.
4. Live check: Eric consigns one cheap card of his own under a test consignor, places a test order,
   marks it paid and delivered, checks the payout, then returns the card.
