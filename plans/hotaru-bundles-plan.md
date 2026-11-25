# Kits: Several Cards Sold Together on HOTARU (v113)

Eric, 2026-11-25: he sells the three MEP Black Star Promo starters one by one, and wants to also
offer the trio together at a price that is not the sum. Two ways to price a kit: a price he types,
or a discount in percent off the sum (for example, 5% off for buying all three).

Status, 2026-11-25: Eric chose every default in section 9. Built: `supabase/store-bundles.sql`
(live: Eric ran it, checked by `tests/store-bundles-sql-check.sh`), the Shop's kits (`js/kits.js`,
`js/shop-kits.js`, hooks in `js/shop-view.js`), and HOTARU's Kits (pull request #14). Release slot:
v113; its release commit adds `js/kits.js` and `js/shop-kits.js` to `sw.js`'s precache.

v114 adds the two card page lines: the For sale hint names the kits a copy is in (section 7), and the
star's toast says which kits left HOTARU with it (section 6), both read from `store_bundles_admin` by
`kitNamesFor` (`js/store-publish.js`).

Builds on: `store_listings` (one row per copy, keyed by the copy's ID, `supabase/store.sql`);
`place_order`, which reserves a list of listing IDs all or none (`supabase/store-orders.sql`);
`order_status` and `store_orders_open` as `supabase/store-sealed.sql` last defined them; the Shop's
per-finish groups (v109) and ticks (v104); For sale (v111); the star withdraw (v108,
`store_withdraw`); own-photo pictures (v110).

HOTARU's word is **Kit** (the name Eric types names the kit, such as "Trio inicial MEP"). The
tracker's English UI says **Kit** too, so the two screens match.

## 1. What a Kit Is

A kit is a name, a price rule, and two or more listed cards. It is available on HOTARU only while
every one of its cards is available. Default (decision 1): a kit names **exact copies** (listing
IDs), and the Shop refills a missing copy from the same card on Publish (section 4).

| Field | Meaning |
| --- | --- |
| `id` | uuid |
| `name` | 1 to 80 characters, shown on HOTARU |
| `description` | Optional, up to 500 characters, same formatting as sealed descriptions |
| `price_mode` | `fixed` or `percent` |
| `price_brl` | The typed price, when `fixed` |
| `discount_pct` | 1 to 90, when `percent` |
| `active` | Off hides the kit without deleting it |
| items | 2 to 20 listing IDs, singles only (no sealed product in a kit, for now) |

**The price a buyer pays** is computed on the server at every read and at `place_order`, never
taken from the page:

- `fixed`: `price_brl`.
- `percent`: the sum of the cards' current listing prices, times `1 - discount_pct / 100`, rounded
  **down** to the centavo (decision 2). A single's price change moves the kit's price with it.

A `fixed` kit whose price is not below the sum of its cards gets a warning in the Shop ("No
discount: the cards cost R$ X apart"), not a block; Eric may want it.

## 2. Singles Stay for Sale

Default (decision 3): a card in a kit is still sold on its own. Whoever closes first wins, as
today. When one of a kit's copies is reserved, sold, or withdrawn, the kit leaves the catalog; if
the order is cancelled or expires, the copy comes back and so does the kit.

To keep that from happening while another copy would do, HOTARU's single buttons (quick add and the
buy box on `carta.html`) take a copy **outside** any kit first. `store_catalog` gains an `in_kit`
boolean per listing so HOTARU can sort without reading kits first.

## 3. Server (`supabase/store-bundles.sql`, new)

Run after `store-sealed.sql`. Safe to run again.

- Tables `store_bundles` and `store_bundle_items (bundle_id, listing_id, position)`, owner-read RLS
  like `store_listings`. Writes only through the owner calls.
- `save_bundle(bundle jsonb)`, owner only: validates 2 to 20 distinct single listings that exist,
  the price rule, the name; returns the kit with its computed price. `delete_bundle(id)`, owner
  only. Deleting a kit never touches its listings or past orders.
- `store_bundles_admin()`, owner: every kit with each item's status, so the Shop can show
  "incomplete".
- `store_bundles()`, public: active kits whose items are all available, each with name,
  description, items (listing ID, name, set, number, language, finish, condition, `image_path`,
  single price), sum, price, and `discount_pct` when `percent`. Calls `private.release_expired()`
  first, as `store_catalog` does.
- `store_catalog()` replaced again to add `in_kit`.
- `store_order_items` gains `bundle_id uuid` and `bundle_name text` (both null for a single), so an
  order reads the same after its kit is deleted. `place_order` gains a last parameter,
  `bundles uuid[] default '{}'`. It expands each kit into its listing IDs,
  rejects a listing that appears both alone and in a kit (or in two kits) with error 22023, keeps
  the 20-card limit over the expanded set, and reserves everything in the one statement it uses
  today, so the race rule is unchanged. A kit with a card taken returns
  `{unavailable: [listing IDs], unavailable_kits: [bundle IDs]}` and reserves nothing.
- **Splitting the kit's price over its cards:** each item's `price_brl` is its single price times
  kit price over sum, rounded to the centavo, with the leftover centavos on the dearest card. The
  items still add up to the order total, so the Shop's Payment received (`saleFields` in
  `js/shop.js`, which logs the sale at the items' sum) works unchanged, and a later partial look at
  the order shows sensible per-card prices.
- `order_status` and `store_orders_open` redefined once more to return each item's `bundle_id`
  and the kit's name. This is the third file that defines them; the file header says so, and
  `store-sealed.sql`'s copies become stale (the newest run wins, as with `store_catalog`).
- An old HOTARU page calling `place_order` without `bundles` keeps working: the new parameter
  has a default. The old four-argument function is dropped first so PostgREST does not see two
  candidates, and `store-orders.sql` now drops the five-argument one before recreating its own,
  so rerunning it goes back to orders without kits rather than leaving both. `store.sql` drops
  `store_catalog` before recreating it for the same reason (its columns differ).

Verified the same way as the earlier store files: a `postgres:16` container, including a
two-connection race between a kit and a single that share a copy.

## 4. Tracker: the Shop

- **Make a kit:** tick two or more rows (the v104 ticks), then **Kit N selected** next to Fill N
  selected. The sheet asks for the name, optional description, and the price: a switch between
  **Price** (R$) and **Discount** (%), with the sum of the singles and the result shown live
  ("3 cards, R$ 15,00 apart. Kit: R$ 14,25, 5% off"). Each ticked row contributes one listed copy:
  the best condition among its listed copies.
- **Kits section** below the list: one row per kit with its cards' art, price, state (on HOTARU,
  incomplete, off), and Edit, Off/On, Delete (inline confirm, as Cancel order).
- **Refill on Publish:** when a kit's copy is no longer listed or available, Publish swaps in
  another available listed copy of the same card, language, and finish, preferring the same
  condition, then saves the kit. If none exists, the kit row says which card is missing.
- **Orders:** items of a kit are grouped under the kit's name, with the kit's price.
- New module `js/shop-kits.js` (sheet and section, so `js/shop-view.js` grows by the hooks only),
  added to `sw.js`'s precache in the release commit.

## 5. HOTARU

- **Home and Avulsas:** a **Kits** row above the singles when a kit is available; the tile shows
  the kit's cards fanned (section 7), the name, the struck-through sum, the price, and a "-5%"
  badge for a `percent` kit (for a `fixed` kit, the percent it works out to, rounded down).
- **`kit.html?id=`:** the cards with links to their `carta.html` pages, condition and finish per
  card, the description, the price, and Adicionar.
- **Cart:** a kit is one cart entry, `{kind: 'kit', id, ids: [listing IDs], name, price}`. Adding a
  kit removes those exact copies from the cart if they were there as singles, and says so.
  `listing_status` still checks the expanded IDs; a kit with any card not available shows as
  unavailable with the card named. `pedido.html` sends `bundles` to `place_order`.
- **Meus pedidos:** kit items grouped under the kit name.
- `build.py` gains the Kits page and nav anchor; `assets/catalogo.js` and `style.css` the rest.

## 6. The Star (v108)

Starring a card withdraws its listings at once (`store_withdraw`), so a kit holding that copy stops
being available on HOTARU immediately, which is what a favorite means. In the tracker, when the
starred copy is in a kit, the card page's toast adds "Kit Trio inicial MEP left HOTARU too". The
refill on Publish does not pick a starred copy, because a starred copy is not listed (v108's
`forSale` hook); a copy with an explicit For sale mark still beats the star, as today.

## 7. For Sale (v111)

A kit can hold only listed copies: a priced spare or a copy marked For sale. Taking the For sale
mark off a copy in a kit makes the kit incomplete at the next Publish, and the refill then looks
for another listed copy. The copy sheet's For sale switch says "In kit Trio inicial MEP" under it
when the copy is in one, so the effect is visible before he taps.

## 8. Pictures (v110)

A kit needs no new upload. Its tile and page use each card's own `image_path`, which is already
either the TCGdex picture or Eric's own photo copied into the bucket by v110 (`ownPicturePath`), so
a promo with no TCGdex image (mep-040 to mep-045) shows Eric's photo there as it does on
its single tile. The tile fans up to three cards in CSS; a fourth or more shows "+N". A photo of
the kit itself (all three cards in one shot) is left for later: it would widen
`private.is_store_path` to `kits/<id>/...`.

## 9. Decisions for Eric

**1. Does a kit name exact copies, or any copy of each card?**

| | Exact copies (recommended) | Any copy of each card |
| --- | --- | --- |
| What the buyer sees | The exact condition of every card | A condition that may change at checkout |
| When a kit's copy sells singly | The kit leaves HOTARU until the Shop's next Publish refills it from another copy (Payment received already publishes) | The kit stays while each card has any copy left |
| SQL | Items are listing IDs; `place_order` only expands them | Items are card + language + finish; `place_order` must pick and lock one copy per card (`for update skip locked`), and the cart needs a new status call for kits |
| Order flow | Unchanged race rule; one more test | New race paths to test |

Recommendation: exact copies, because the condition shown is the condition shipped, and the SQL
reuses today's reservation unchanged. The refill on Publish and HOTARU's preference for copies
outside kits make the gap rare; it only shows while a single sale is pending payment.

**2. How is a discounted price rounded?** Recommended: down to the centavo (R$ 15,00 at 5% is
R$ 14,25), so the buyer always gets at least the advertised discount. Alternative: down to R$ 0,50
(R$ 14,00), matching how the Shop's Use button rounds a suggestion up to R$ 0,50. Same cost either way: one
expression in SQL and one in the sheet.

**3. Are a kit's cards still sold one by one?** Recommended: yes; the kit leaves while one is
reserved or sold. Alternative: a card in an active kit is sold only in the kit (`store_catalog`
hides it). That is simpler on the server but stops a buyer who wants just one card.

## 10. Tests

- SQL in the container: save rules, both price modes, rounding, the price split adds up, kit vs
  single race, kit plus overlapping single rejected, expiry brings the kit back, anon cannot read
  kit tables or call owner functions.
- Tracker: `shop-kits` unit (refill choice, price preview, warning), browser (make, edit, off,
  delete, refill, orders grouping), and the star toast.
- HOTARU: a Playwright check like the cart checks (kit tile, page, cart replacement of singles,
  unavailable kit, `pedido.html` sends `bundles`), plus the old cart, sealed, and carousel checks.

## 11. Order of Work

1. `supabase/store-bundles.sql`, verified in the container. Eric runs it (orchestrator batches the
   ask).
1. Tracker Shop kits, feature commit, then v113 through the orchestrator.
1. HOTARU PR (kits pages, cart, pedido) after v113 is live and the SQL has run.
