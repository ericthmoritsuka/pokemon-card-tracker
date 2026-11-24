# For Sale: Any Copy on HOTARU (v110)

Eric, 2026-11-24: the Shop sells only spares, and he also wants to sell cards that are not spares,
and to put a card up for sale straight from the catalog. He chose both ways in ("Sell a card I own"
and "Add and sell"), and that a card bought to resell counts everywhere like any card, with a
visible For sale mark he takes off to keep it. He then agreed that the mark *is* the listing:
marked means on HOTARU, unmarked means it stays his (reconfirmed to the orchestrator session). A For
sale mark on one specific copy beats the favorite star.

Builds on v107 (`shopGroups(cards, {held})`, copies in a binder are not spares), v108 (favorite
cards are not spares, and the `forSale` hook in `spareEntries`), and v109's per-finish groups
(`shop-finish-prices`: a Shop group is one card, language, and finish, keyed by `tileKey` plus the
finish identity, `variant_id` or `raw:<finish_raw>`, each with its own price). Nothing changes on the server:
`store_sync` already takes the whole set of listed copies by copy id.

## 1. The Mark

One field on a copy, `for_sale`, added to `ENTRY_FIELDS` (`js/collection.js`):

| Value | Means | Listed when the card has a price |
| --- | --- | --- |
| absent | Today's rule | Only if the copy is a spare |
| `true` | Eric put this copy up for sale | Always, even a favorite, a binder copy, or the last copy |
| `false` | Eric took it off sale | Never, even as a spare |

The For sale mark the app shows is the **listed** state, so it appears on a priced spare that was
never touched, too. Tapping it off writes `false`, and on writes `true`. Today's 45 priced cards
keep selling with no change, and a new spare of a priced card is listed as it is today.

**Why a third state rather than marking every spare:** a new spare of a priced card would otherwise
need marking by hand, and Eric prices once per card.

**Older apps:** editing a copy assigns only the picked patch onto the entry, so a phone that does
not know `for_sale` keeps it, and the merge takes it field by field (`js/merge.js`, as
`sale_price` since v101). A test saves through a v105-shaped edit and the frozen merge.

## 2. The Listed Set

For one card, language, and finish (one Shop group), with a price:

```
listed = (spares where for_sale !== false) ∪ (copies where for_sale === true)
```

Spares stay decided per card and language (`spareEntries`); each spare then falls in its own
finish's group. `shopGroups` makes a group for a card, language, and finish that has spares **or**
any copy marked `true`,
and gives it `listed` beside `spares`. `listingRows`, `groupMark`, and the Shop's counts read
`listed`; "N spares" stays as text. A group with no spares and only marked copies is a non-spare
sale. v108's `forSale` predicate is how `spareEntries` lets a marked favorite through.

**The star:** v108 withdraws a card from HOTARU at once when its star goes on (`withdrawListings`,
`supabase/store-withdraw.sql`, called from the card page in `js/catalog-views.js`). A copy marked
`true` stays listed, so that call leaves out the marked copies' ids.

A copy held by an open order stays reserved: `store_sync` never touches reserved or sold rows, so
taking the mark off says "Held by order HTR-0012 until it is paid or cancelled" and lists it again
only if the order is cancelled.

## 3. Where Eric Sees and Changes It

- **Card page, Your copies:** a For sale switch on each copy's edit sheet (`js/copy-sheet.js`
  openEditSheet), with a line under it when it matters: "Your only copy", "In <binder>, page 3,
  pocket 5", or "A favorite card". When its finish has no price yet, a Price field sits beside it.
- **My Cards tiles and binder pockets:** a small "For sale" tag when any copy of the tile or the
  pocket's copy is listed, in the header's gold, so a card about to be sold is never a surprise.
- **Shop:** each row says "2 of 3 copies for sale"; the filter gains **For sale, not a spare**.

## 4. Sell a Card I Own

A Shop button opens a search over Eric's own copies (the copies picker the binders use, all
copies, not only loose ones). Picking a copy marks it `true`, closes the picker, and scrolls the
Shop to that card with its price field focused when it has none.

## 5. Add and Sell

A Shop button opens the catalog search; picking a card opens its page with the Add sheet already
open in a **For sale** mode: language, finish, condition, how many, an optional price paid
(`purchase_price`), and the sale price. Saving adds the copies marked `true` and prices that
finish's group, the card's copies in that language and finish (`pricePatches`), so the card is on HOTARU in one step and in My Cards like
any other.

## 6. Selling

Unchanged: Payment received logs the sale under the order's id, and the copy leaves the collection
and every binder, list, and total.

## 7. Tests

Unit (`tests/shop.test.mjs`): the three states, a marked favorite and binder copy listed, a `false`
spare withheld, a group made by a marked copy alone, a marked holo and a plain spare of one card in
separate finish groups with their own prices, `listingRows` and `groupMark` on `listed`.
Browser: the switch on the card page, the tile and pocket tags, Sell a card I own, Add and sell,
taking the mark off a reserved copy, starring a card with a marked copy (the marked copy stays
listed), and an older-app edit keeping the field.

## Files

`js/collection.js` (ENTRY_FIELDS), `js/shop.js`, `js/wishlist.js` (the v108 hook only),
`js/catalog-views.js` (the star's withdraw call skips marked copies),
`js/shop-view.js`, `js/copy-sheet.js`, `js/catalog-views.js` (the card page's Add sheet mode),
`js/cards-view.js` and `js/binders-view.js` (the tag), `style.css` or `css/shop.css`, tests, then
`sw.js`, `js/whats-new.js`, and `CHANGELOG.md` in the release commit.
