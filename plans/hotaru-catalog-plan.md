# Plan: HOTARU Spares Catalog

Draft 2026-11-24, written against `e6b0104` (v100). Eric approved building it on 2026-11-24, one step at a time (section 11).

## 1. Goal

Eric wants to offer his spare singles to people at work. A page on the HOTARU site lists the spares the tracker already knows about, each with a price and a page of its own. A visitor adds cards to a cart, leaves a name and a phone number, and gets a Pix code for the exact total. Eric checks his bank, hands the cards over at the office, and the tracker records the sale.

The cart is a **promise to buy**, not a checkout. Nothing confirms a payment automatically.

**In scope:** a private staging screen in the tracker where Eric prices his spares by hand, with suggested prices beside each, publishing what he prices, the catalog and card pages on HOTARU, the cart and the order form, a Pix copy-and-paste code with a QR code, and an Orders screen in the tracker.

**Also in scope:** sealed products (boosters, boxes, and the like), which are not in the tracker, added by Eric on an admin page on HOTARU (section 8).

**Out of scope:** payment gateways, shipping, stock other than Eric's spares, accounts for buyers, and any automatic collection of Liga Pokémon prices.

**Later, not now:** HOTARU's home page showing the products Eric has at home (Eric, 2026-11-24). The catalog's public table is the natural source, so the home page can read it once the catalog works.

## 2. Decisions Already Made

| Decision | Source |
| --- | --- |
| Plan before building | Eric, 2026-11-24 |
| Each card has one sale price, typed by Eric. Only a priced card appears in the catalog. The suggestions beside it are private, and no Liga link or other reference price reaches buyers, because Eric may price above the market | Eric, 2026-11-24, replacing his earlier choices of automatic prices and the Liga sales average |
| The catalog lives on pages of its own, apart from the fictional mockup | Eric, 2026-11-24 |
| The Pix code uses Eric's random Pix key, kept in HOTARU's configuration rather than in this plan | Eric, 2026-11-24 |
| Liga prices are never collected automatically: its `robots.txt` asks for 360 seconds between requests and the site sits behind Cloudflare | DESIGN.md section 10, 2026-10-01 |
| No paid services, ever. A gateway that confirms Pix payments charges per transaction, so payment confirmation stays manual | DESIGN.md line 8 |
| A confirmed sale (money received, cards handed over) removes the cards from Eric's spares | Eric, 2026-11-24 |
| A cart reserves nothing; the first person to close an order gets the cards reserved, and reserved cards disappear from the catalog until the deal completes or falls through | Eric, 2026-11-24 |
| An open cart warns about cards that are no longer available or temporarily unavailable | Eric, 2026-11-24 |
| A reservation holds until Eric confirms or refuses the order. A payment is a successful sale, so confirming it takes the cards out of the inventory at once. An order not paid within 48 hours is cancelled with its reservation, and the buyer can order again | Eric, 2026-11-24 |
| The tracker's labels are English like the rest of the app; HOTARU's pages are Portuguese | Matches the app, 2026-11-24 |
| Cards are priced in the tracker's Shop screen; sealed products are added on an admin page on HOTARU behind a Supabase sign-in. Both reach the same catalog | Eric, 2026-11-24 |
| HOTARU is 100% virtual: no store, address, pickup, or counter anywhere on the site | Eric, by way of the HOTARU home page session, 2026-11-24 |
| For now only colleagues buy, and delivery is arranged with Eric. The pages say so without naming a place | Eric, 2026-11-24 |
| Card images are cached, never hot-linked, because `assets.tcgdex.net` went down for hours on 2026-10-01 | DESIGN.md line 427 |

## 3. What Already Exists

The tracker does most of the work already. The catalog reuses it rather than computing anything again.

- **Which copies are spares.** `spareEntries(cards)` (`js/wishlist.js:337`) returns every copy beyond the keeper, per card and language. The keeper is the favorite, then the copy added first (`keeperOrder`, `js/wishlist.js:328`). The Trade screen (`js/trade-view.js`) is built on it, so the catalog lists exactly what Trade shows.
- **Market prices in reais.** The card page's price panel (`js/price-view.js`) already shows TCGplayer's market price and Cardmarket's trend from TCGdex, converted with the saved daily rates (`usdToBrl` and `eurToBrl` in `js/prices.js`). The suggestions reuse it.
- **Recording a sale.** A move of kind `sold` (`js/moves.js:80`) takes copies out of the collection with a buyer, a price, and an Undo.
- **Supabase.** Every table revokes `anon` (`supabase/setup.sql:123`), so a visitor without an account reads nothing today. One Edge Function exists (`supabase/functions/tcgdex-image`).

## 4. How It Flows

1. **Price and publish.** In the tracker, Eric opens the **Shop** screen, his private staging page, which lists his spares with suggested prices (section 5). Saving a sale price on a card publishes its spare copies at once: the card picture is uploaded once to a public storage bucket and the copies are written to a public table. Clearing the price takes them out of the catalog. The catalog never needs TCGdex, exchange rates, or Eric's private document.
2. **Browse.** HOTARU's new `avulsas.html` reads the public table in the browser and lists the cards. `carta.html?id=<listing>` shows one card: picture, name, set, number, language, condition, finish, price, and how many are available.
3. **Order.** The cart lives in the visitor's `localStorage`, and putting a card in it reserves nothing: any number of people can hold the same card in their carts. At checkout the visitor types a name, a phone number or extension, and an optional note, and closes the order. Closing calls one database function, which reserves the copies for that order and returns an order code and the total computed on the server. **Whoever closes first gets the cards** (section 7).
4. **Pay.** The confirmation page shows the total, the order code, a Pix copy-and-paste code, and its QR code, with the order code as the Pix transaction ID so Eric can match the payment in his bank statement.
5. **Settle.** Nothing tells the tracker that a Pix arrived, so Eric checks his bank statement. When the money is there he taps **Payment received** on the order in the Shop screen. A payment is the sale: that one step marks the listings sold, so they leave the catalog for good, and logs a `sold` move with the buyer's name and the price, so the copies leave Eric's collection and therefore his spares. Only the sold copies leave: the keeper of each card stays. The order then waits under **To hand over** until Eric taps **Delivered**, which is a reminder only and changes no card.
6. **Or release.** Eric taps **Cancel** to refuse an order at any time before the payment. An order with no payment 48 hours after it was closed is cancelled by itself. Either way the cards go back to the catalog, and the buyer may order again.

## 5. Prices

**One price per card, typed by Eric.** A card's sale price is the only price the catalog knows. A spare without one is not published. There is no automatic price, no fixed-price rule that changes by itself, and no **Not for sale** switch, because leaving a card unpriced keeps it out.

**The Shop screen is the staging page** (`js/shop-view.js`, route `shop`, opened from Shop on the Spares screen). It lists only Eric's spares, one row per card and language, with a search, a set and a rarity filter, and **All**, **Not priced**, and **Priced**. It is a list of its own rather than the Spares grid, because the grid's tiles are links too small to hold a price field. Each row shows:

- **Its sale price,** or **Not priced**, with a field to type or clear it.
- **Suggested prices,** private to this screen: TCGplayer's market price and Cardmarket's trend, each converted to reais with the app's saved daily rates, as the card page already shows them. A **Use** button copies the higher of the two, rounded up to the next R$ 0,50, into the field, and Eric adjusts it before saving. A card with neither shows **No suggestion**. Liga is not read, by the 2026-10-01 decision, and the screen has no Ver na Liga link, by Eric's choice.
- **Published,** **Reserved,** or nothing, from the public table, so Eric sees what buyers see.

The screen opens on **Not priced**, so Eric can work through what is left.

**Pricing many cards at once.** **Price all shown** sets one price on every row the search and filters show. Filtering to set `30th` and rarity Common and setting R$ 1,00 prices them in one step. It writes the same field a single price does, so a later change to one card is just a new price on that card, and a toast's Undo takes either back.

**Where it lives in Eric's document:** a new copy field, `sale_price` (reais, number). It is in `ENTRY_FIELDS` (`js/collection.js:388`), the fields a copy may carry. Two phones merge it by field with no change, since `field_stamps` (`js/merge.js:161`) stamps every field. It is also in `USER_FIELDS` (`js/merge.js:1189`), so it survives when two copies of a card fold into one, and in Start over's `DETAIL_FIELDS` (`js/start-over.js:115`), so a priced copy counts in its warning. An old client keeps unknown fields, as `plans/sync-merge-plan.md` section 0 notes. The price belongs to the card in that language, so it is saved on every copy of the tile, the keeper included, and only the copies `spareEntries` returns are published. A change of keeper, such as a new favorite, then never leaves a spare unpriced, and a card with no spares left publishes nothing.

**Publishing follows the price.** Saving or clearing a price writes the public table at once, which needs a connection; offline, the screen says the change is saved and will publish when back online. Opening the Shop screen also withdraws every published copy that is no longer a spare, such as one traded away in the tracker, and never touches a reserved or sold one.

## 6. Supabase

All new objects go in one script, `supabase/store.sql`, which can be run again safely.

**`store_listings`**: one row per spare copy.

| Column | Notes |
| --- | --- |
| `id` | The copy's own ID from Eric's document, or a new ID for a sealed product unit |
| `kind` | `single` (from the tracker) or `sealed` (from the HOTARU admin page) |
| `title`, `description` | A sealed product's name and text; empty for a single |
| `card_id`, `catalog`, `language`, `variant`, `condition` | From the copy |
| `name`, `set_name`, `number`, `rarity` | From the catalog record, in the copy's language when it has one |
| `image_path` | The picture in the public `store` bucket |
| `price_brl` | Eric's sale price, written when he saves it |
| `status` | `available`, `reserved`, `sold`, or `withdrawn` |
| `order_id` | The order holding it while `reserved` or after `sold` |
| `published_at` | |

Only Eric (the owner) may write. Saving a price inserts or updates the card's spare copies as `available`; clearing it, or the copy no longer being a spare, sets `withdrawn`. Neither touches a `reserved` or `sold` row, so a price change never alters an order already closed.

**`store_orders`** and **`store_order_items`**: the order code (`HTR-0001`, and so on), name, phone, note, total, status (`pending`, `paid`, `cancelled`, `expired`), `delivered_at`, `created_at`, `reserved_until`, and the listings with the price each was sold at. Only Eric reads them.

**`anon` touches no table directly.** It may execute three `security definer` functions, and nothing else:

| Function | What it does |
| --- | --- |
| `store_catalog()` | Returns the `available` listings only. A reserved or sold card is simply absent, so it disappears from the catalog. |
| `listing_status(ids uuid[])` | Returns, for each ID in a visitor's cart, `available`, `reserved`, or `gone` (sold or withdrawn). It returns nothing about the order holding a card. |
| `place_order(items uuid[], name text, phone text, note text)` | Closes a cart (section 7). |

Each of the three first releases expired reservations (section 7), so expiry needs no scheduled job and everything stays on the free tier.

Eric's own functions, for the signed-in owner only: `mark_paid(code)` sets the order `paid` and its listings `sold`; `cancel_order(code)` sets a `pending` order `cancelled` and its listings back to `available`; `mark_delivered(code)` stamps `delivered_at` on a `paid` order.

**Picture bucket:** `store`, public read, owner write. Spares are a few hundred pictures of about 80 KB each, well inside the 1 GB free storage.

## 7. Reservations and the Cart

Eric's rules (2026-11-24): many people may put the same card in their carts, only the first to close the order gets it reserved, a reserved card disappears from the catalog for everyone else, it comes back if the deal falls through, and an open cart warns about cards that are no longer available or are temporarily unavailable.

**First to close wins.** `place_order` reserves with one statement, `update store_listings set status = 'reserved', order_id = <new order> where id = any(items) and status = 'available' returning id`. Postgres locks each row it updates, so when two people close at the same moment the second waits, then finds the row already `reserved` and skips it. If fewer rows come back than were asked for, the function rolls the whole order back and returns the IDs that were not available. Nothing is half reserved, and the page shows the warnings below so the visitor can close again with the rest.

**How a reservation ends.**

| Event | Order | Listings | Catalog |
| --- | --- | --- | --- |
| Eric taps **Payment received** | `paid` | `sold` | Gone for good; the next publish no longer sees the copies, because the `sold` move removed them from the collection |
| Eric taps **Cancel** | `cancelled` | `available` | Back at once |
| `reserved_until` passes while the order is still `pending` | `expired` | `available` | Back on the next call to any public function |

A reservation lasts 48 hours (section 12, answer 6). The Shop screen shows how long each pending order has left, so a payment that arrives near the end is not missed, and the HOTARU confirmation page tells the buyer to pay within 48 hours or the order is cancelled. A Pix that arrives after an order expired is settled between Eric and the buyer: the static code cannot expire.

**Warnings in an open cart.** The cart page, and the cart counter on every catalog page, call `listing_status` for the cart's IDs when the page opens, when the tab comes back into view, every 60 seconds while it is open, and right before closing. Each card that is not `available` gets a notice in place:

| Status | Notice | What the cart does |
| --- | --- | --- |
| `reserved` | **Temporariamente indisponível.** Outra pessoa fechou um pedido com esta carta. Se a compra não for concluída, ela volta ao catálogo. | Keeps the card in the cart, greyed out, left out of the total and of the order. It turns normal again by itself if the reservation ends. |
| `gone` | **Não está mais disponível.** Esta carta foi vendida ou saiu do catálogo. | Leaves the card greyed out with a **Remover** button, out of the total and the order. |

The close button names what will be ordered, such as **Fechar pedido com 3 cartas**, and is disabled when no card in the cart is available. If `place_order` still rejects a card because someone closed in the meantime, the page applies the same notices and asks the visitor to close again.

**Edge cases Eric's screen handles.**

- A reserved copy that Eric traded or removed in the tracker meanwhile: the order shows a warning, and **Payment received** is disabled for it until he cancels the order or swaps the copy.
- **Payment received** needs a connection, because it writes both the order and the `sold` move. It logs the move first and marks the order second, so a failure in between leaves an order Eric can mark again without logging the move twice.
- An order that expires while Eric is marking it paid: `mark_paid` refuses an order that is no longer `pending`, and the screen says so before logging anything.

## 8. HOTARU Pages

HOTARU is static HTML generated by `build.py`, so the new pages are generated shells with a small script that reads Supabase in the browser using the tracker's publishable key, which is public by design.

- **The home page** (`index.html`, as of HOTARU `0a363e6`): the catalog grid goes right after the hero, before `section.store#sobre`. The site shows only what exists, so the header has no cart, search, or account and its menu is Início, Sobre nós, YouTube, and Contato. When the catalog goes live this work adds a **Cartas** menu link and the cart, and only then. Pull HOTARU's `main` before touching `build.py`, `_parts`, or `assets/style.css`, since another session edits the home page; `page()` there links the stylesheet with a content hash, so a CSS change reaches visitors with the page.
- **Words the site does not use until they are true:** shipping, delivery to all of Brazil, installments, Pix, or card payment (Eric, 2026-11-24). Pix appears on `pedido.html` when step 5 ships, and not before.
- **The old mockup** (`loja.html`, `produto-*.html`, `carrinho.html`) is still generated by `build.py` but nothing links to it. The real pages replace it, and the mockup's entries in `build.py` go when they do.
- `avulsas.html`: the grid from `store_catalog()`, with search and filters by set, language, and price, and a cart counter.
- `carta.html?id=<listing>`: one card, with **Adicionar ao carrinho**. A card that is no longer available shows the same notice as the cart instead of the button.
- `pedido.html`: the cart with its notices, the form, and, after `place_order` returns, the Pix code and QR code. It says delivery is arranged with Eric after the payment, and names no place, since HOTARU is virtual.
- `admin.html`: Eric's sign-in, with the tracker's Supabase account, and his sealed products: add one with a name, photo, price, description, and how many units; change its price or units; take it off the catalog. Each unit is its own listing row, so reservations and sales work the same as for a card. The page is reachable only by its address and shows nothing until Eric signs in; the database, not the page, keeps anyone else from writing.

The rest of HOTARU is a mockup with invented products, prices, and an invented address (README). A colleague who lands on the real catalog must not wander into fake products, so the new pages carry a plain header of their own and do not link to the mockup (section 12, answer 1).

## 9. Pix

A static Pix code (BR Code) is a short text in the EMV format with Eric's Pix key, his name, his city, the amount, the transaction ID, and a CRC16 checksum. The page builds it in the browser, so nothing is paid for and no bank API is involved. The QR code comes from a small QR library added to HOTARU, pinned to an exact version.

The amount and the transaction ID go in the code, so the buyer's bank app fills them in. Eric still confirms the payment by looking at his statement.

Before step 5 ships, the generated code is checked against two bank apps by scanning it and stopping before paying.

## 10. Abuse and Privacy

- **Anyone with the link can place an order**, and an order hides its cards from everyone else. The 20-card limit, the reservation that expires by itself, and Eric's **Cancel** button are enough for an audience of colleagues. A captcha is not planned.
- **Orders hold colleagues' names and phone numbers.** Only Eric can read them. The confirmation page says the data is used only to deliver the order.
- **The site is public**, so anyone can see the catalog and its prices.

## 11. Build Order

Each step is usable on its own.

1. **Staging in the tracker:** `sale_price`, the Shop screen with suggestions, **Use**, the filters, and **Price all shown**. No Supabase change yet. *Built 2026-11-24 on branch `store-prices`, not released.*
2. **Publish:** `supabase/store.sql` (listings and the bucket), publishing on save and on clear, withdrawing copies that stopped being spares, and the Published and Reserved marks. *Built 2026-11-24 on branch `store-prices`, not released. Publishing waits until the phone has synced, because the whole set is sent and a phone still reading the collection would withdraw every card. Card pictures sit at `tcgdex/<language>/<series>/<set>/<number>.webp`. The SQL was run against Postgres 16 with stand-ins for Supabase's `auth` and `storage`: the owner publishes, a visitor reads only available listings through `store_catalog()`, nobody else reads or writes the table, a reserved listing never changes, a cleared price withdraws, and a stored picture path survives a republish.*
3. **Catalog:** `avulsas.html` and `carta.html` on HOTARU, read only. Eric can already share the link and sell by message.
4. **Sealed products:** `admin.html` and the `sealed` rows, reusing the catalog and the bucket from steps 2 and 3.
5. **Orders and Pix:** the orders tables, `place_order`, `listing_status`, expiry, `pedido.html` with the cart notices, the Pix code and QR code, and the Orders part of the Shop screen with **Payment received** (the `sold` move), **Delivered**, **Cancel**, and the time each pending order has left.

Tests follow the tracker's habits: unit tests for the suggestion and its rounding, the price patches and their Undo, and the BR Code checksum against a known code, and a browser test per new screen using `tests/fake-rates.mjs`. The reservation rules get SQL tests against a local Supabase: two `place_order` calls racing for the same card (one wins, the other gets the card back as unavailable and reserves nothing), expiry returning cards to `store_catalog()`, a `paid` order never expiring, `mark_paid` refusing an expired order, and `mark_paid` and `cancel_order` moving the listings.

## 12. Questions and Answers

Answered by Eric, 2026-11-24:

1. **Where the catalog lives:** its own pages, apart from the mockup. Showing the products at home on HOTARU's home page may come later.
2. **Prices:** one price per card, typed by Eric on a private staging screen with suggestions; only priced cards are published; no Liga link anywhere (section 5). This replaced his first answer, the Liga NM average of recent sales, once it was clear that value can only be typed by hand.
3. **Pix key:** Eric's random key, kept in HOTARU's configuration.

Taken as recommended, because Eric answered the others and not these. Any of them is easy to change:

4. **Rounding:** the suggestion **Use** copies rounds up to the next R$ 0,50.
5. **How Eric hears about an order:** the Shop screen shows a count of pending orders.
6. **How long a closed order holds the cards:** until Eric marks the payment or cancels, and at most 48 hours without a payment. Eric confirmed this on 2026-11-24, replacing the earlier idea of a **Paid** mark that held cards with no limit.

Answered by Eric, 2026-11-24, after the first build: cards are priced in the tracker and sealed products on HOTARU's admin page; only colleagues buy for now, with delivery arranged with Eric.

Still open. Both block step 5 only:

7. **Name and city on the Pix code,** exactly as Eric's bank shows them for the key. A BR Code carries a name of up to 25 characters and a city of up to 15.
8. **Old orders:** keep them forever, or clear name and phone some time after the sale.
