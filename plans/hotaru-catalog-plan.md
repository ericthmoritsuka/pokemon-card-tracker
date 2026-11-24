# Plan: HOTARU Spares Catalog

Draft 2026-11-24, written against `e6b0104` (v100). It is a design only: nothing is built yet, and Eric chooses whether and when.

## 1. Goal

Eric wants to offer his spare singles to people at work. A page on the HOTARU site lists the spares the tracker already knows about, each with a price and a page of its own. A visitor adds cards to a cart, leaves a name and a phone number, and gets a Pix code for the exact total. Eric checks his bank, hands the cards over at the office, and the tracker records the sale.

The cart is a **promise to buy**, not a checkout. Nothing confirms a payment automatically.

**In scope:** publishing the spares from the tracker, sale prices (automatic with manual overrides and fixed-price rules), the catalog and card pages on HOTARU, the cart and the order form, a Pix copy-and-paste code with a QR code, and an Orders screen in the tracker.

**Out of scope:** payment gateways, shipping, stock other than Eric's spares, accounts for buyers, and any automatic collection of Liga Pokémon prices.

## 2. Decisions Already Made

| Decision | Source |
| --- | --- |
| Plan before building | Eric, 2026-11-24 |
| A spare with no manual price and no rule shows the Liga price Eric typed, else the TCGplayer estimate in reais | Eric, 2026-11-24 |
| Liga prices are never collected automatically: its `robots.txt` asks for 360 seconds between requests and the site sits behind Cloudflare | DESIGN.md section 10, 2026-10-01 |
| No paid services, ever. A gateway that confirms Pix payments charges per transaction, so payment confirmation stays manual | DESIGN.md line 8 |
| A confirmed sale (money received, cards handed over) removes the cards from Eric's spares | Eric, 2026-11-24 |
| A cart reserves nothing; the first person to close an order gets the cards reserved, and reserved cards disappear from the catalog until the deal completes or falls through | Eric, 2026-11-24 |
| An open cart warns about cards that are no longer available or temporarily unavailable | Eric, 2026-11-24 |
| Card images are cached, never hot-linked, because `assets.tcgdex.net` went down for hours on 2026-10-01 | DESIGN.md line 427 |

## 3. What Already Exists

The tracker does most of the work already. The catalog reuses it rather than computing anything again.

- **Which copies are spares.** `spareEntries(cards)` (`js/wishlist.js:337`) returns every copy beyond the keeper, per card and language. The keeper is the favorite, then the copy added first (`keeperOrder`, `js/wishlist.js:328`). The Trade screen (`js/trade-view.js`) is built on it, so the catalog lists exactly what Trade shows.
- **What a copy is worth.** `copyValue(entry, card, {basis, rates})` (`js/prices.js`) returns the Liga price Eric typed (`price_manual`, average or lowest NM) or the TCGplayer market price converted to reais, and says which one it used.
- **Recording a sale.** A move of kind `sold` (`js/moves.js:80`) takes copies out of the collection with a buyer, a price, and an Undo.
- **Supabase.** Every table revokes `anon` (`supabase/setup.sql:123`), so a visitor without an account reads nothing today. One Edge Function exists (`supabase/functions/tcgdex-image`).

## 4. How It Flows

1. **Publish.** In the tracker, a new **Loja** screen has a **Publicar na HOTARU** button. It takes `spareEntries`, prices each copy (section 5), uploads each card picture once to a public storage bucket, and writes the result to a public table. The prices are frozen at that moment, so the catalog never needs TCGdex, exchange rates, or Eric's private document.
2. **Browse.** HOTARU's new `avulsas.html` reads the public table in the browser and lists the cards. `carta.html?id=<listing>` shows one card: picture, name, set, number, language, condition, finish, price, and how many are available.
3. **Order.** The cart lives in the visitor's `localStorage`, and putting a card in it reserves nothing: any number of people can hold the same card in their carts. At checkout the visitor types a name, a phone number or extension, and an optional note, and closes the order. Closing calls one database function, which reserves the copies for that order and returns an order code and the total computed on the server. **Whoever closes first gets the cards** (section 7).
4. **Pay.** The confirmation page shows the total, the order code, a Pix copy-and-paste code, and its QR code, with the order code as the Pix transaction ID so Eric can match the payment in his bank statement.
5. **Settle.** Once Eric has the money and has handed the cards over, he taps **Venda concluída** on the order in the tracker's Loja screen. That one step marks the listings sold, so they leave the catalog at once, and logs a `sold` move with the buyer's name and the price, so the copies leave Eric's collection and therefore his spares. Only the sold copies leave: the keeper of each card stays.
6. **Or release.** When the deal falls through, Eric taps **Cancelar**, or the reservation runs out (section 7). Either way the cards go back to the catalog.

## 5. Prices

The sale price of a copy is the first of these that exists:

1. **A manual sale price** on that copy, typed in the Loja screen or on the card page.
2. **A fixed-price rule**, the first in Eric's ordered list that matches. A rule matches on any of set, rarity, name contains, and language. Examples: set `30th` and rarity Common costs R$ 1,00; set `30th` and name contains `Pikachu` costs R$ 5,00. Put the Pikachu rule first.
3. **The Liga price Eric typed** on the copy (`price_manual`).
4. **The TCGplayer estimate** in reais.

A copy that none of these prices is listed as **Sob consulta** and cannot go in the cart.

Where the data lives in Eric's document:

- **Manual sale price:** a new copy field, `sale_price` (reais, number). It must be added to `USER_FIELDS` (`js/merge.js:1189`) so two phones merge it by field like `condition`. An old client keeps unknown fields, as `plans/sync-merge-plan.md` section 0 notes, so this is safe.
- **Rules:** a new list, `price_rules`, added to `LISTS` (`js/merge.js:28`) so rules merge entry by entry. Each rule is `{id, order, set_id, rarity, name_contains, language, price, updated_at}`.

The Loja screen shows each listed copy with its price and where it came from (`manual`, `regra`, `Liga`, `estimativa`), so Eric can spot an estimate that looks wrong before publishing.

## 6. Supabase

All new objects go in one script, `supabase/store.sql`, which can be run again safely.

**`store_listings`**: one row per spare copy.

| Column | Notes |
| --- | --- |
| `id` | The copy's own ID from Eric's document |
| `card_id`, `catalog`, `language`, `variant`, `condition` | From the copy |
| `name`, `set_name`, `number`, `rarity` | From the catalog record, in the copy's language when it has one |
| `image_path` | The picture in the public `store` bucket |
| `price_brl`, `price_source` | Frozen at publish |
| `status` | `available`, `reserved`, `sold`, or `withdrawn` |
| `order_id` | The order holding it while `reserved` or after `sold` |
| `published_at` | |

Only Eric (the owner) may write. A publish inserts new spares, updates prices on `available` rows, and sets `withdrawn` on rows that are no longer spares. It never touches a `reserved` or `sold` row.

**`store_orders`** and **`store_order_items`**: the order code (`HTR-0001`, and so on), name, phone, note, total, status (`pending`, `paid`, `completed`, `cancelled`, `expired`), `created_at`, `reserved_until`, and the listings with the price each was sold at. Only Eric reads them.

**`anon` touches no table directly.** It may execute three `security definer` functions, and nothing else:

| Function | What it does |
| --- | --- |
| `store_catalog()` | Returns the `available` listings only. A reserved or sold card is simply absent, so it disappears from the catalog. |
| `listing_status(ids uuid[])` | Returns, for each ID in a visitor's cart, `available`, `reserved`, or `gone` (sold or withdrawn). It returns nothing about the order holding a card. |
| `place_order(items uuid[], name text, phone text, note text)` | Closes a cart (section 7). |

Each of the three first releases expired reservations (section 7), so expiry needs no scheduled job and everything stays on the free tier.

Eric's own functions, for the signed-in owner only: `complete_order(code)` sets the order `completed` and its listings `sold`; `cancel_order(code)` sets it `cancelled` and its listings back to `available`; `mark_paid(code)` sets it `paid`, which stops its reservation from expiring.

**Picture bucket:** `store`, public read, owner write. Spares are a few hundred pictures of about 80 KB each, well inside the 1 GB free storage.

## 7. Reservations and the Cart

Eric's rules (2026-11-24): many people may put the same card in their carts, only the first to close the order gets it reserved, a reserved card disappears from the catalog for everyone else, it comes back if the deal falls through, and an open cart warns about cards that are no longer available or are temporarily unavailable.

**First to close wins.** `place_order` reserves with one statement, `update store_listings set status = 'reserved', order_id = <new order> where id = any(items) and status = 'available' returning id`. Postgres locks each row it updates, so when two people close at the same moment the second waits, then finds the row already `reserved` and skips it. If fewer rows come back than were asked for, the function rolls the whole order back and returns the IDs that were not available. Nothing is half reserved, and the page shows the warnings below so the visitor can close again with the rest.

**How a reservation ends.**

| Event | Order | Listings | Catalog |
| --- | --- | --- | --- |
| Eric taps **Venda concluída** | `completed` | `sold` | Gone for good; the next publish no longer sees the copies, because the `sold` move removed them from the collection |
| Eric taps **Cancelar** | `cancelled` | `available` | Back at once |
| `reserved_until` passes while the order is still `pending` | `expired` | `available` | Back on the next call to any public function |
| Eric taps **Pago** | `paid` | stay `reserved` | Still hidden; a paid order never expires, so a payment that arrives late cannot lose its cards to someone else |

A reservation lasts 48 hours (open question 8).

**Warnings in an open cart.** The cart page, and the cart counter on every catalog page, call `listing_status` for the cart's IDs when the page opens, when the tab comes back into view, every 60 seconds while it is open, and right before closing. Each card that is not `available` gets a notice in place:

| Status | Notice | What the cart does |
| --- | --- | --- |
| `reserved` | **Temporariamente indisponível.** Outra pessoa fechou um pedido com esta carta. Se a compra não for concluída, ela volta ao catálogo. | Keeps the card in the cart, greyed out, left out of the total and of the order. It turns normal again by itself if the reservation ends. |
| `gone` | **Não está mais disponível.** Esta carta foi vendida ou saiu do catálogo. | Leaves the card greyed out with a **Remover** button, out of the total and the order. |

The close button names what will be ordered, such as **Fechar pedido com 3 cartas**, and is disabled when no card in the cart is available. If `place_order` still rejects a card because someone closed in the meantime, the page applies the same notices and asks the visitor to close again.

**Edge cases Eric's screen handles.**

- A reserved copy that Eric traded or removed in the tracker meanwhile: the order shows a warning, and **Venda concluída** is disabled for it until he cancels the order or swaps the copy.
- **Venda concluída** needs a connection, because it writes both the order and the `sold` move. It logs the move first and marks the order second, so a failure in between leaves an order Eric can complete again without logging the move twice.

## 8. HOTARU Pages

HOTARU is static HTML generated by `build.py`, so the new pages are generated shells with a small script that reads Supabase in the browser using the tracker's publishable key, which is public by design.

- `avulsas.html`: the grid from `store_catalog()`, with search and filters by set, language, and price, and a cart counter.
- `carta.html?id=<listing>`: one card, with **Adicionar ao carrinho**. A card that is no longer available shows the same notice as the cart instead of the button.
- `pedido.html`: the cart with its notices, the form, and, after `place_order` returns, the Pix code and QR code.

The rest of HOTARU is a mockup with invented products, prices, and an invented address (README). A colleague who lands on the real catalog must not wander into fake products, so the new pages carry a plain header of their own and do not link to the mockup (open question 1).

## 9. Pix

A static Pix code (BR Code) is a short text in the EMV format with Eric's Pix key, his name, his city, the amount, the transaction ID, and a CRC16 checksum. The page builds it in the browser, so nothing is paid for and no bank API is involved. The QR code comes from a small QR library added to HOTARU, pinned to an exact version.

The amount and the transaction ID go in the code, so the buyer's bank app fills them in. Eric still confirms the payment by looking at his statement.

Before building, the generated code is checked against two bank apps by scanning it and stopping before paying.

## 10. Abuse and Privacy

- **Anyone with the link can place an order**, and an order hides its cards from everyone else. The 20-card limit, the reservation that expires by itself, and Eric's **Cancelar** button are enough for an audience of colleagues. A captcha is not planned.
- **Orders hold colleagues' names and phone numbers.** Only Eric can read them. The confirmation page says the data is used only to deliver the order.
- **The site is public**, so anyone can see the catalog and its prices.

## 11. Build Order

Each step is usable on its own.

1. **Prices in the tracker:** `sale_price`, `price_rules`, the precedence in section 5, and the Loja screen listing spares with prices and their sources. No Supabase change yet.
2. **Publish:** `supabase/store.sql` (listings and the bucket), and the **Publicar na HOTARU** button.
3. **Catalog:** `avulsas.html` and `carta.html` on HOTARU, read only. Eric can already share the link and sell by message.
4. **Orders and Pix:** the orders tables, `place_order`, `listing_status`, expiry, `pedido.html` with the cart notices, the Pix code and QR code, and the Orders part of the Loja screen with **Pago**, **Venda concluída** (the `sold` move), and **Cancelar**.

Tests follow the tracker's habits: unit tests for the price precedence, the rule matching, and the BR Code checksum against a known code, and a browser test per new screen using `tests/fake-rates.mjs`. The reservation rules get SQL tests against a local Supabase: two `place_order` calls racing for the same card (one wins, the other gets the card back as unavailable and reserves nothing), expiry returning cards to `store_catalog()`, a `paid` order never expiring, and `complete_order` and `cancel_order` moving the listings.

## 12. Open Questions for Eric

1. **Where the catalog lives.** Recommended: its own pages on HOTARU with a plain header and no links to the fictional mockup. The alternative is to turn the whole HOTARU site real, which is a bigger job.
2. **Which Liga field.** The tracker values copies by the Liga average by default. For colleagues the lowest NM price may be fairer. Recommended: lowest NM.
3. **Rounding.** Recommended: round automatic prices (Liga and estimate) up to the next R$ 0,50. Manual prices and rules stay as typed.
4. **Every spare, or only chosen ones.** Recommended: every spare by default, with a **Não vender** switch per copy so Eric can keep one back.
5. **Pix key.** Which key goes in the code (a random key keeps the phone number and CPF out of a public page), and the name and city exactly as the bank shows them.
6. **How Eric hears about an order.** Recommended for now: the Loja screen shows a count of pending orders. A push notification or an email is possible later.
7. **Old orders.** Keep them forever, or clear name and phone after delivery.
8. **How long a closed order holds the cards before they return to the catalog.** Recommended: 48 hours, since buyer and seller share an office. Marking the order **Pago** holds the cards with no limit.
