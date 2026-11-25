# Changelog

What changed in Card Tracker and when, newest first. **Live** means you can use it at
https://ericthmoritsuka.github.io/pokemon-card-tracker/ (tap Reload when the app says a new
version is installed). **Planned** means it is designed in `DESIGN.md` but not built yet. Times
are Recife time. Each line ends with its commit.

## In Progress (2026-11-24)

- Selling spares on HOTARU (`plans/hotaru-catalog-plan.md`): steps 1, 2, 3, and 5 are live on the tracker's side
  (v101 to v103). HOTARU pull request #5 (cart, Pix, receipts, My orders) waits on Eric rerunning store-orders.sql.
  Next: step 4, sealed products on a HOTARU admin page.
- Waiting on Eric: new binder page photos to recheck the page scan on a real phone.
- Still designed, not built: pack openings, graded cards, Michi art editing, and the tombstone purge (DESIGN.md).

## Live

### 2026-11-25

- **v115:** binder pockets count different cards, not copies, and HOTARU's new address. `9340609`, `9ae9417`, `e14652b`
  - Fixed (Eric: a pocket showed 4 cards and all four were the same card): a list pocket's ×N counts different cards,
    copies of one card in one language being one card whatever their finish (`cardGroups`, `js/binder-rules.js`), and
    its name says both ("2 cards fit, 5 copies"; one card with spares, "4 copies"). Edit pocket shows each card once,
    with ×N for its copies and a badge per finish when they differ (REG beside HOLO or REV; a lone plain print still
    has no corner), and the viewer swipes each card once, its line naming the copies and finishes. A card stands as
    the copy shown, else the copy the default would pick among its copies, passing over copies in use elsewhere
    (`groupFace`), so a pick still stores one copy.
  - Changed: the Shop's HOTARU admin button opens https://lojahotaru.com.br/admin.html, HOTARU's new domain.
  - Suite before release: 165 files, 2,437 pass, 2 fail, both in binder-convert-browser and both its old copy-count
    expectations (three copies of two cards); fixed in `9340609` and passing, with shop-owner-browser and whats-new,
    on the release tree.

- **v114:** kit notes on the card page, the Kit button beside Fill, and the Shop's selection at hand. `093552b`, `549dd93`, `6c6e509`, `9b60528`
  - Added: Edit copy's For sale hint names the kits a copy is in ("In kit Trio: it sells alone or in the kit", and
    "Kept: … and kit Trio with it" when unticked), and starring a card adds "Kit Trio left HOTARU too." to its toast.
    Both read `store_bundles_admin` through `kitNamesFor` (`js/store-publish.js`), and say nothing when it cannot be read.
  - Fixed (Eric: "not looking good"): the Kit button sat among the Shop's text links, squeezed to 60 to 69 px wide and
    wrapping its label; it now sits beside Fill in the price row with the same `button.small`, 44 px tall.
  - Added (Eric): with any card ticked, a bar at the bottom of the Shop offers the count, Clear, a price with Fill,
    and Kit (from two cards), so a selection far down the list needs no scroll back up. It sticks like the Save bar,
    rides above it when both show, keeps room for the Scan button, and slides in only without reduced motion.
  - Suite before release: 165 files, 2,434 pass, 3 fail, all passing alone: moves-browser (the known ERR_ABORTED
    navigation flake), value-history-browser (a price tile timeout), and shop-publish-browser's star test (the unstar
    wait under load; 3/3 alone, and the kit lookup runs after the star, never in its way).

- **v113:** kits on HOTARU, and the Shop filtered by finish. `a6e099e`, `2bdff27`, `60b8fab`, `868883b`, `a0e1eff`, `2fb6c36`, `002218a`
  - Added (Eric): kits, several listed cards sold together on HOTARU at a price he types or a percent off their sum
    (`plans/hotaru-bundles-plan.md`). A percent kit rounds down to the centavo (R$ 15,00 at 5% is R$ 14,25). A kit
    names exact copies; its cards stay for sale one by one, whoever orders first wins, and the kit leaves HOTARU while
    one of them is reserved or sold. `supabase/store-bundles.sql` (run by Eric) adds the kit tables, `save_bundle`,
    `delete_bundle`, `store_bundles_admin`, the public `store_bundles`, `in_kit` on `store_catalog`, and `bundles` on
    `place_order`, which splits a kit's price over its cards so the sale still logs at the order's total.
    `tests/store-bundles-sql-check.sh` checks it in a throwaway Postgres, including a kit racing a single.
  - Added: the Shop's Kit button for two or more ticked cards (the sheet previews the sum and the kit's price), the
    Kits section with Edit, Turn off, and Delete, and kits' cards grouped under their name in Orders
    (`js/kits.js`, `js/shop-kits.js`). After each Publish, a kit whose copy is no longer for sale takes another
    listed copy of the same card, the same condition first. HOTARU's side is its pull request #14.
  - Added: an Every finish filter in the Shop, beside Rarity, to price every reverse holo at once
    (`card-tracker-finish-filter`).
  - Fixed: running `supabase/store.sql` or `store-orders.sql` again after the kits script no longer fails on
    `store_catalog`'s columns or leaves two `place_order` functions: each drops the function before making it.
  - Suite before release: 165 files, 2,434 pass, 0 fail, each file alone with a 900 s timeout.

- **v112:** a new listing gets its card's HOTARU picture, a For sale tag on binder pockets, and the Shop price on Edit copy. `cea9db0`, `5540ed3`, `044e9d4`, `e874419`
  - Fixed: a copy newly listed for a card whose other listing already had a picture went to HOTARU without one,
    because Publish only looked for pictures when no copy of the card had one. Now any listed copy without a
    picture counts, takes the path its sibling already has (no upload), and the "no picture yet" count includes it.
    Not settled yet: some me03, me04, and 30th listings had no picture at all, and the cause was not found.
  - Added: binder pockets that hold a copy on HOTARU show a small For sale tag at the top edge and a thin outline,
    named "For sale on HOTARU" for screen readers, for the owner only.
  - Added: Edit copy shows the Shop price of the copy's finish, and setting it there writes the same price as the
    Shop row (one finish, one price).

### 2026-11-24

- **v111:** For sale on any copy, one pocket per copy, insert pockets, and holo corners. `c96563c`, `1ada41d`, `792b766`, `1e57e2b`, `113fa61`, `2ebd2d4`, `c55382b`, `f380cd6`, `42bc7a0`, `3720139`
  - Added (Eric): For sale on HOTARU is a mark on a copy, and the mark is the listing (`plans/hotaru-for-sale-plan.md`).
    A copy's `for_sale` is true when he puts it up, false when he keeps it, and absent for the spare rule, so a
    priced spare still lists by itself. The Shop lists, per finish, the spares not marked false plus the copies
    marked true, even the last copy, one in a binder, or a favorite (For sale beats the star). Edit copy has the box
    for the owner; taking it off withdraws the copy at once (`withdrawListings`). My Cards tags the copies on
    HOTARU with a For sale chip under the price, clear of the art's corners.
  - Added: the Shop's Sell a card I own (search every copy, mark one, price it) and Add and sell (to Sets, then the
    next Add a copy sheet ticked For sale with a sale price). Its counts are copies: "On HOTARU: N cards, K copies."
  - Added (Eric): a copy fills one binder pocket at a time; list binders that share a copy show a placeholder where
    an older or more specific binder uses it, and a hand pick always shows (`1ada41d`). Add to binder lists every
    binder and says first whether the copy fills its pocket or goes after the list (`extra_cards`, `js/binder-add.js`).
    Insert a pocket before or after, and remove an empty one, in hand and list binders (a `blank` list edit).
  - Added: a HOLO corner on holo cards, including unowned holo-only catalog tiles (the set's printings, read once per
    set), each copy's finish in the binder copy pickers and the tray, and a small English flag for the English
    stand-in image instead of the caption.
  - Fixed: the Shop's owner controls (Add sealed products on HOTARU, and the new buttons) stayed hidden when the Shop
    opened from its address before the session was back; the Shop now hears the owner answer when it comes
    (`onShopOwner`).
  - Suite before release: 163 files, 2,404 pass, 4 fail: whats-new (seven items for a cap of six, merged),
    test-hygiene (an async wait in add-to-binder-browser, now `untilInPage`), twins-browser (the set view's new
    printings query counted as a twin request; exempted), all fixed in `3720139` and passing alone; and the
    scan-holder-browser timing flake, 5/5 alone.

- **v110:** own photos on HOTARU, kept list placeholders, and every language on lists. `7d05de3`, `7a86159`, `b3d7363`, `53b8264`, `68d5ffc`, `79175bd`, `e65003c`, `a702b6e`, `312b057`
  - Added: a card the catalog has no picture for is listed on HOTARU with the owner's own photo, copied to
    `own/<photo id>` in the store bucket (`supabase/store-own-pictures.sql`, run by Eric); a photo that cannot be
    read, or reads empty, is not sent. The Shop offers Add a listing picture for a card with none, reads again the
    sets of cards saved before TCGdex pictured them, and reads the catalog records the phone lacks (the import was
    shadowed by the Shop's own `fillRecords`, so it never ran; now `fillCardRecords`).
  - Changed: a hand-made copy of a catalog card counts with it in the Shop (`catalogTwins`), and a copy saved with
    no catalog counts as international. A hand-made and a scanned reverse of one card stay two rows until the
    copy's finish is picked on its sheet (DESIGN.md, The Shop on HOTARU).
  - Fixed: a price typed the moment the Shop opened was lost, because the list was drawn again under the field;
    the field being typed in now keeps the focus and the caret.
  - Added (Eric): in a binder made from a list, Not this copy here, Keep the placeholder, and Extra pages after the
    list (`binder_picks.skipped`, `extra_pages`).
  - Changed: lists count every language unless some are picked (an untouched Portuguese-only list opens up once),
    and Japanese and Chinese prints with no Pokédex number, and hand-made cards, count on lists and fill list
    binders (`dex_number`, `dexFromName`).
  - Suite before release: 161 files, 2,348 pass, 2 fail: stats-browser (its Kanto list now picks Portuguese by
    hand, `a702b6e`, 4/4) and test-hygiene (two async waits now poll with `untilInPage`, `312b057`; test-hygiene
    6/6, binder-rules 44/44, custom-cards-browser 5/5).

- **v109:** open orders on the Shop bag, set codes, and prices per finish. `9de38d9`, `bf7fce3`, `6875845`, `f644b0a`, `01dcb7d`, `1e4c27c`, `491fd3f`, `08e7b81`
  - Added: the header's Shop bag counts HOTARU's open orders (waiting for payment or for delivery), read when
    the app opens and comes back to the front, every 5 minutes while in front, and at once when the Shop pays,
    delivers, or cancels one (`js/shell.js`, `ORDERS_EVENT` in `js/store-orders.js`). Owner only.
  - Added: Add sealed products on HOTARU, on the owner's Shop, opens `hotaru/admin.html` in the same tab, signed
    in with the tracker's session.
  - Changed: the Shop's set filter is a list (`js/set-picker.js`) showing each set's printed code before its name,
    like (CRI) Caos Ascendente, Scarlet & Violet and Mega Evolution sets and older ones (`printedSetCode`,
    `shopSetCode`), and older Western sets' symbols.
  - Changed: each finish of a card in a language is a Shop row of its own with its own price and a finish tag; a
    price saved before holds on every finish, so nothing was withdrawn. "N of M cards priced" and "On HOTARU"
    count finishes, and a card's finishes share one picture upload.
  - Fixed: a Reverse holo copy was offered on HOTARU as Normal.
  - Also: the PDF export of binders and lists is on the backlog (`plans/roadmap.md`).
  - Suite before release: 159 files, 2,309 pass, 1 fail: v108's star test, which priced one finish of a card
    whose spares the per-finish rows now split; fixed in the test (`08e7b81`), file 4/4 twice.

- **v108:** a favorite card is never a spare. `dc05fa1`, `f68670a`, `0148c04`, `5b46628`, `36c3b4b`
  - Changed (Eric): a favorite is a card he does not trade or sell for anything. One star on any copy keeps every
    copy of the card, in every language and finish, however many and wherever they sit, out of Spares, Trade
    ideas, a family member's spares, and the Shop (`favoriteCards`, `js/wishlist.js`).
  - Added: starring a card the shop owner has priced takes its listings off HOTARU at once, leaving reserved and
    sold copies alone (`store_withdraw`, new `supabase/store-withdraw.sql`, run by Eric before the release).
  - Added: a starred card offers "Also star the Japanese print" (or the international print) when this phone
    knows its confident or confirmed twin, since an Asian print is a card record of its own.
  - Changed: the scanner's Trade or sale never chooses a copy of a favorite by itself, and Save in the trades log
    names each favorite going out and logs it only after "Sell it anyway" (or Trade, Give). Spares no longer
    offers the Favorites filter.
  - Ready for v110: the spare rule takes a `forSale` predicate, since a copy marked For sale will beat the star.
  - Suite before release: 158 files, 2,282 pass, 2 fail: the twins import check (fixed in `36c3b4b`, 24/0) and
    the known moves-browser "a purchase from the scanner" flake, which fails alone on v107 master too.

- **v107:** copies in use in a binder are never spares. `4f3cf0c`, `8da3c26`, `4d0f256`
  - Changed (Eric): a copy in a hand-made binder's pocket, or on top of a pocket in a binder made from a list, is
    in use, so it is never a spare and counts as the copy kept. Three Salamences, one in the 30 anos binder, one
    in Hoenn, one loose, are one spare, the loose one. The copies under a list pocket's top and the copies in a
    binder's tray stay spares (`heldCopies`, `js/binders.js`).
  - Applies everywhere spares are counted: the Shop, so HOTARU no longer lists a card in a binder (opening the
    Shop online republishes); Spares; Trade ideas; a family member's spares; and spares first in the trades log
    and the scanner's Trade or sale.
  - Suite before release: 157 files, 2,270 pass, 0 fail.

- **v106:** set names in a collection that fills itself. `fd9153b`, `4d623a6`
  - Fixed: choosing sets for a rule collection listed codes such as `international|xy3` in place of set names, and
    the collection page described the rule the same way. Both now read the set names, as My Cards and binders do.
  - Suite before release: 157 files, 2,256 pass, 5 fail (scanner timing under load in scan-holder-browser,
    scan-retry-browser, scan-review-browser, and scan.test; each file passes alone).

- **v105:** the Shop in the header, for the family owner only. `3732096`, `a508448`, `81c8d1b`
  - Shop left Spares: a round bag in the header, between Mine and your picture, opens it from any screen and is
    filled while it is open. Only the family's owner sees it (`js/shop-owner.js`, read from the group overview and
    kept on the phone); a member who opens the shop address gets a short notice and a way to Spares. A principal
    designer review moved it to an icon-only circle so the title and Mine fit at 360 to 412 px.
  - Fixed: a Shop opened straight from its address could not find a Japanese or Korean print by its English name.
  - Suite before release: 157 files, 2,260 pass, 1 fail (moves-browser 'a purchase from the scanner', a
    page.goto ERR_ABORTED at line 725 that fails 5 of 6 runs on v104 too).

- **v104:** HOTARU sealed products in the Shop's orders, and one price for ticked cards. `262fc74`, `a6503d7`, `05ae45d`, `e6e3290`
  - Orders with sealed products show them marked Sealed. A sealed product is never missing from the collection;
    Payment received logs only the cards of an order in Trades, naming the sealed products in the note, and an order
    of sealed products alone logs nothing.
  - Shop: tick cards and Fill N selected gives them one price; ticks survive a search; Select all shown and Clear
    selection sit by the price field.
  - `supabase/store-sealed.sql` (sealed products, the owner's save and list, the public store_sealed, and the order
    calls naming each item's kind), verified in a Postgres 16 container; not yet run in the live project.
  - Suite before release: 156 files, 2,258 pass, 0 fail.

- **v103:** HOTARU orders in the Shop. `2e77bbb`, `6cf7ed1`, `1d4ec3b`
  - The Shop's Orders section lists every order waiting for payment and every paid one still to hand over: buyer,
    phone, note, cards, total, time left, and the buyer's Pix receipt when sent. Payment received marks the order paid
    on HOTARU, then logs the sale under the order's ID (never twice), so the copies leave the collection and the
    spares; Log the sale retries a sale that did not log. Delivered and Cancel order close the rest; Payment received
    waits when a copy of the order is gone from the collection.
  - `supabase/store-orders.sql` (run in the live project on 2026-11-24): orders, first to close reserves, 48 hours to
    pay with lazy expiry, receipts in the private `store-receipts` bucket under a secret token, the owner's calls,
    and `order_status` for HOTARU's My orders. Verified in a Postgres 16 container with Supabase stand-ins, including a
    real two-connection race.
  - Suite before release: 156 files, 2,253 pass, 0 fail.

- **v102:** save every Shop price at once. `25c700e`, `4a625ea`, `2383479`
  - Typing a price saves nothing by itself: changed cards are marked, and the bar above the tabs saves them all at
    once, with one Undo, or discards them. Enter moves to the next card; typed prices survive leaving the Shop. A
    typing slip stops the whole save and says where. Price all shown became Fill all shown, which fills the fields.
  - Toasts no longer pile up: a key replaces a screen's earlier toast, and at most three show (`js/shell.js`).
  - Suite before release: 155 files, 2,243 pass; placeholder-fill and value-history-browser failed once each and
    passed alone (10/10 and 3/3).

- **v101:** price spares for HOTARU on the Shop screen. `96251f3`, `1af63a3`, `fec392f`
  - Shop (route `shop`, from Spares): each card with spares gets one sale price typed by hand, with private TCGplayer
    and Cardmarket suggestions in reais and Use, which rounds the higher up to the next R$ 0,50. All, Not priced, and
    Priced, search, set and rarity, and Price all shown, with Undo. No Liga link, by Eric's choice.
  - A priced card's spares are published to the HOTARU catalog (`supabase/store.sql`, run in the live project on
    2026-11-24) on opening the Shop and after each price, once the phone has synced; a cleared price withdraws them,
    never a reserved copy. Each card's picture is copied once into the public `store` bucket. Cards show On HOTARU or
    Reserved by an order.
  - Suite before release: 155 files, 2,243 pass, 0 fail.

### 2026-11-23

- **v100:** trade ideas with each family member. `e8b248b`, `6c70a27`, `117b67a`
  - Trade ideas with <name> (route `family/<id>/ideas`): your spares on their wishlist and their spares on yours, each
    row a wish with the spares that fit it (count, language when the wish takes any, conditions). Built from trade
    matching, deferred on 2026-10-01; Eric picked it on 2026-11-23.
  - Log a trade with <name> opens the trade form as a trade with their name, one of your spares for each of their
    wishes, and one of theirs for each of yours.
  - Reached from Trade ideas on a member's cards (Spares, Wishlist, and Trade ideas on a row of their own) and wishlist,
    and from Profile > Family, which counts your spares on each member's wishlist from the wishlists saved on the phone.

- **v99:** a binder cover can be any color, and a new cover color shows at once. `30b065f`, `5f77311`
  - The last circle under Cover color, the phone's own color picker, is a rainbow captioned Any color until a color of
    one's own is chosen, then that color inside a rainbow ring. It started as the default Navy, so it read as a second
    Navy swatch and Eric did not find it. (Eric, 2026-11-23.)
  - Saving a binder with only a new cover color repaints the open binder at once; before, the pages kept the old color
    until the binder was opened again (only a change of grid or pages repainted it). (Eric, 2026-11-23.)

- **v98:** a tap off the card closes the full-screen card, and a copy two Undos left out comes back. `09139d6`
  - On a card page, a tap anywhere outside the card (or on the empty part of the bars) closes the full-screen viewer, as
    the binder's pocket viewer already did; the X, Escape, and Back still work. (Eric, 2026-11-23.)
  - A copy two phones each logged out while offline, with each phone then undoing its own entry while the other was
    still live there, stayed removed after the sync with both entries undone. Every sync now brings such a copy back,
    into its pocket, tray, and collections where they still wait for it (`js/moves.js` `planStrandedOuts`).

### 2026-11-21

- **v97:** Undo after Start over keeps your newer edits. `52da1dd`
  - Undo stamps the copy it restores at the Undo's time, and the fold that merges it with an added copy you changed took
    the newest copy whole, so the restored copy's older condition, storage, price, notes, grade, language set by hand,
    or finish chosen by hand beat your later edit. The fold now ranks each field by its own edit time, as sync does; a
    favorite, photos, and a Liga price were already kept.

- **v96:** Start over's Undo counts a changed copy merged into its restored twin as merged, not kept, so its numbers add
  up to the collection (QA saw "1 added copy was kept" with 894 copies, not 895). `b31d27a`

### 2026-11-20 (morning)

- **v95:** a quieter version switch, and fixes from two QA passes. `47df826`
  - A waiting version takes over only when the app comes back after at least 5 minutes away and is not touched first,
    never on a screen change, and reloads only once the new worker is activated (10 s, else the Reload toast). A family
    member's view and a card in hand carry over. (QA found the v92 to v94 switch losing a card in hand, Edit binder's
    Grid and Size, Select ticks, and a family view.)
  - Two phones shifting the same binder: a copy the seam leaves in no pocket goes to the nearest free pocket, not the
    tray.
  - Trades and sales marks a copy logged out on two phones on both entries and the month; Undo of one keeps the copy out.
  - A purchase or sale with one total reads "1 of 3 cards bought for"; This copy on a row naming a pocket is that pocket's
    copy, with Which copy to say so; the log form keeps its cards and typing through a reload and never logs twice.
  - Already mine offers the page the read cards already sit on; My Cards search "025/165" matches number and set total;
    Stats counts a card once per language as My Cards does; a family member's rows and search read right.

- **v94:** the version switch waits for unsaved choices and for Undo. `cc0b210`
  - A QA pass found v92's switch throwing away an open Edit binder form with a new colour and grid, as nothing was typed
    and it is an inline form, not a sheet. Any change to any form control now holds the switch until the screen changes,
    and so does a message offering Undo, Undo edit, or Put back.

- **v93:** one set in Phone check, and a binder page waiting to be placed stays in view. `44193e0`
  - Phone check, **A set on this phone**: copies and cards by language, the card records and the set IDs they name,
    Pokémon with no Pokédex number, the Sets ring in the viewing language and in any language, and whether the saved set
    list lists every owned card, with Copy to send it. Nothing is asked of TCGdex. (The Realme's 57 of 161 could not be
    read before its reset; this is for next time.)
  - A page marked Already mine and not placed keeps a dot on the Scan tab, and Clear, which drops it, can be undone.
  - Fixed (tests): the scan frames test's fake camera keeps the card still when a note moves the guide (10 of 10 runs).

- **v92:** every device moves to a new version by itself. `d15de4d`
  - Eric's computer ran v87 for hours while v90 sat installed and waiting, so it showed different data from his phones.
    A waiting version now takes over when the app comes back into view or changes screen, once nothing could be lost:
    online, no import or Start over saving, not signing in, not on Scan or a form screen, no sheet open, nothing typed,
    sync idle. Every edit and the scan tray are already saved on the phone, so they survive the switch. What's new still
    shows once afterwards, Reload still works, and no switch follows another within 10 minutes.

- **v91:** missing small pictures and Portuguese logos fall back. `1dfe08f`
  - TCGdex has some cards' large picture only (the Kanto binder's Arcanine, sv10-028: low.webp 404, high.webp 200); a
    tile or pocket now tries the English small picture, its own large one, then the English large one.
  - A Western set with no logo in its language uses the English logo (Portuguese Fagulhas Impetuosas, Fogo Branco, Raio
    Preto). Temporal Forces, My First Battle, Crown Zenith Galarian Gallery, Delta Reign, and the 30th sets have no logo
    or symbol on TCGdex in any language, so they keep showing their names.

- **v90:** a new set's Pokémon join the Pokédex lists once TCGdex numbers them. `5927a1a`
  - TCGdex listed the 30th Celebration's cards before it gave them Pokédex numbers; the checklists' card map and the
    card details saved then held 147 of Eric's Pokémon with no number, so his 30th Mew was missing from Kanto, and the
    map was not read again for 30 days. A Pokémon saved with no number (a Trainer or Energy never has one) now brings the
    map and its set's details back after 12 hours.

- **v89:** Sets count your cards in the language you view. `7b50ece`
  - A set's ring, its "N / M owned" line, the owned marks, and All / Owned / Missing count only your copies in the
    viewing language (Eric's call, 2026-11-20, reversing the any-language rule in DESIGN.md section 3), for your cards
    and a family member's alike. Every card's picture still shows; a card not owned in that language is dimmed.
  - **Owned: In <language> | Any language** under the Viewing picker brings back the count in any language; each phone
    remembers it. The card page, search, My Cards, goals, checklists, and binders still count every language.

- **v88:** a set's ring is the same on every phone, and a card's picture falls back to another language. `b598881`
  - A copy that came by sync, which this phone's card index has not read yet, now counts in its set's ring by its card
    ID's set (as a family member's cards already did). On Eric's Realme the 30th Celebration ring read 57 of 161 while
    the M53 read 147, with the same 2,208 copies.
  - My Cards reads a set's saved card list again when it lacks cards owned from it (a new set saved before TCGdex listed
    all its cards), at most once per set per visit; the index then gets their names and pictures.
  - A binder pocket or My Cards tile whose chosen language was saved with no picture shows the card's picture from
    another language, as the card page does (a Kanto binder's Arcanine on the computer).

- **v87:** tile prices without the US mark, and Lists' Progress. `443014e`
  - Tile prices drop the "US" chip ("~" marks an estimate); a price typed from Liga carries a small "Liga" tag. The card
    page's price lines are unchanged.
  - Lists: the first part is **Progress**, with Checklists and Goals under their own headings; Add a list folds behind
    "+ New list", and New goal gets the same "+".
  - Tried and dropped: laying out only the tiles near the screen made the first card 0.16 s sooner but scrolling to the
    end slower (5.8 to 7.3 s), so it stays out (DESIGN.md section 8).
  - Fixed (tests): the scan log test's fake camera kept the card still when a note moves the guide, as a real camera does.

- **v86:** a faster start on a slow phone, roomier My Cards and binders, easier scanning, and accessibility fixes. `a4c352c`
  - Opening the app: on a phone-speed CPU the first card shows in 3.5 s instead of 6.6 s, and Show more adds the next
    tiles instead of drawing them all again (scrolling to the end 13.5 s instead of 31 s). Value waits until every
    price is read, so a day's value is never kept from part of the cards.
  - My Cards: the buttons take three short rows, the language flag and finish sit in the card's bottom corner instead
    of over its name, grid tiles keep one line of set text, Filters starts with set and language and shows how many are
    on, Value opens on the total, and Stats shows the value and your lists first. "Owned cards not in any binder" opens
    My Cards filtered to them, without touching your saved filters.
  - Binders: the name and value share a row and the page caption shows the grid, so all nine pockets clear the tab bar.
    Log a trade or sale starts with the cards; a goal's settings are one line, and a finished goal says Complete; a
    copy's row leads with its language and pocket; the wishlist searches by name first and shows each card's price.
  - Scanning reads the collector number first and skips the set code box once the number names the card (about 10 %
    fewer reads). A clear card a little short of sure is taken at once when its set is one of the last few scanned,
    and its number is still read behind it: if the number names another print, it turns to check, and Save waits a few
    seconds for those reads.
  - Accessibility: focus never hides under the header or tab bar, the focus ring shows on the header in every theme,
    fields have visible edges, small buttons and the tray's remove button are at least 44 px, and the scanner says when
    it finds no card or is unsure. A binder page's grid shows all three rows at 360 px.
  - Fixed (reviews): a cached record from another tab is read again when the page comes back into view; another tab's
    account switch no longer keeps a value under the wrong person; Enter in a card's price no longer saves a trade;
    totals say "partly priced" when some copies have no price.

- **v85:** binder page grid and placing, Buy mode, and a clearer scanner. `931de61`
  - Binder page scan: the page opens as a grid while it is read, a language row sets the language of the cards it could
    not read, and **Already mine** matches a page of cards you own to your copies and places them in a binder page or a
    new binder, with Undo. A page marked Already mine is placed before another is read, so its cards never come back as
    new.
  - Scan has **Buy** beside Add and Trade or sale: the cards are logged as a purchase, with where they came from and a
    price for each. Close, Photo, and Page sit beside the shutter, Settings and the torch at the camera's foot.
  - A card to check names the guess ("Wartortle?"), candidates show number and set, and a card that shares its picture
    with a print the catalog has no image of (such as a McDonald's card) asks for its number; that list was narrowed from
    819 to 495 cards by comparing pictures.
  - A pocket's language comes from its stage label and attack text; the read language now only orders the prints, so on
    Eric's three pages sure pockets went from 18 (one wrong) to 19 (none wrong), measured before the twin list was
    narrowed.
  - My Cards shows the first card higher, a card page shows its price beside the picture, a binder on an upright phone
    opens on one page, a jumbo print is named "Holo, Jumbo" and never prices the card, Stats shows your lists' progress,
    and the copy sheet says when the catalog is offline.
  - Fixed: a blurred card held over the last one could be added twice; text under 14 px raised; the Scan button no
    longer covers Save.

### 2026-11-19 (morning)

- **v84:** a binder page's Portuguese or English cards keep their own print and a language. `082dd17`
  - A pocket's label row, cut from a page photo, reads no Latin text whatever the card, and that reading counted as a
    Japanese or Korean card: the Japanese print of the same picture came first. It no longer counts on a page. On Eric's
    three pages, Caterpie, Metapod, Pidgey, and Sandshrew now come out as their Western prints (still asking for a look),
    and a Portuguese Charizard ex, left with no language, takes the default.
  - English against Portuguese is still the default on a pocket; the stage label reader comes next.

- **v83:** Stats, sharing as a picture, printed placeholders, forgiving search, and a sharper binder page scan. `433be30`
  - My Cards, **Stats** (beside Value): copies by language, set, rarity, type, finish, and condition, the ten most
    valuable, the copies with no price and why, and the copies added each month. A family member's cards have their own.
  - **Share** on a card page and **Share page** in a binder make a picture for the phone's share sheet (a download on a
    computer).
  - **Print placeholders** in a binder: real-size paper cards for the pockets still to fill, nine to a sheet.
  - Search forgives a typo when nothing matches as typed ("charzard" finds Charizard), in My Cards and the Sets search.
  - Binder page scan: each card is cut to its own edges and its number read from a larger copy of the photo (on Eric's
    three pages, sure cards went from 9 to 18 of 27), and a panel over the camera shows the read's progress.
  - Fixed (review): a shared picture's decoded images are let go once drawn; Print waits for a card still chosen; the
    page scan's larger copy is let go if the photo cannot be read.

### 2026-11-19 (early morning)

- **v82:** scan a whole binder page, or two pages side by side, from one photo, and fixes from a review of v81. `cf50c4f`
  - Scan, Settings, **Binder page**: take or choose a photo of one page or an open binder. Every card joins the tray, in
    pocket order; the ones not sure ask for a check; empty pockets are skipped. On Eric's photos: single pages 7, 9 and 9
    of 9 right, spreads 113 of 144 right, and no sure answer wrong. A pocket of a Japanese or Chinese print is never sure
    without Asian text read off it.
  - Fixed (independent review): bulk Finish left the old finish word, so the old corner stayed; a matched 1st Edition
    import set to the listed Holo kept its "1st" corner on My Cards; a card dragged to the tray could be another one if a
    sync changed the pocket meanwhile; a day's collection value could dip when a few price reads failed.
  - Fixed: Undo after a bulk Language change ticks exactly the cards ticked before; Needs a photo updates as soon as an
    English print's picture arrives; a Trade can bring in a finish the catalog does not list.

### 2026-11-18 (night)

- **v81:** bulk select, any finish, a pocket's stack as a carousel, and value over time. `d79cf0d`
  - My Cards, **Select**: tick many cards, then set Stored in, Language, Finish, or Condition, add
    them to a binder, mark favorites, or remove them, each with Undo.
  - Any copy can be Normal, Holo, or Reverse holo even when the catalog does not list that finish
    (shown as "not listed"), and one copy of a pile can change on its own.
  - Binders: in a binder from a list, a pocket with several cards swipes through them, and Show
    this one here puts the one in view on top. A hand-made binder offers Make a list binder from
    this, which keeps the cards in its pockets as picks. The card out of its pocket now fits above
    its actions on a phone screen. A card can be dragged from a pocket onto the tray.
  - Value: the Value sheet shows the collection's value over time, and a card page its recent
    Cardmarket averages (30, 7, and 1 day).
  - Photos: Whole picture frames a photo edge to edge, for a picture saved already cropped.
  - Fixed: Liga links for MEP promos search "(020/∞)", as Liga writes them. Needs a photo leaves
    out cards shown with their international print's picture. The scanner knows Delta Reign (me06).

### 2026-11-18 (evening)

- **v80:** a Pictures filter in My Cards. `0f90734`
  - Filters, **Pictures**: No photo, No catalog picture, or Needs a photo (neither): the cards to
    photograph so the scanner learns them, such as the MEP promos.
  - Behind the scenes: the stack a card is read with is decided once per card, a card the text
    route settles loses its stack mark, and photo changes a few seconds apart make one refresh.

- **v79:** the scanner learns from the family's photos too, reads numbers quicker, and a stack fix. `edca715`
  - A family member's front photos of a card the catalog has no picture of teach the scanner on
    every phone of the group, and the scan picker shows the photo of such a card.
  - The number strips and the label row are read from a smaller copy (24 px text rather than
    32): on the lab benchmark OCR was 21 % quicker with no card lost. The text reader starts
    behind the first scanned card, so the first card that needs text does not wait for it.
  - Fixed (found in an independent review): v78's stack hint could take a card the catalog has no
    picture of (an MEP promo among 30th Celebration cards) as a card of the stack's set, sure. It
    now helps only when the picture clearly found the artwork, and counts only cards settled
    without it. Also: photos are not learned for cards the catalog holds under its Portuguese
    entries, the other number strip is read when the picture is far from every candidate, and the
    scan report shows the number strip's sharpness and how long each card waited.

- **v78:** the scanner reads a stack's reprints without their number, and learns cards from your photos. `5829b33`
  - When at least three of the last five cards are from one set and the picture finds a group of
    prints sharing one artwork (30th Celebration reprints older art), the stack's print is the card,
    sure, with no number read; a number read that names another print still wins. In Eric's
    18 November report this rule applied 33 times and was right every time.
  - Cards the catalog has no picture of (all MEP Black Star Promos, 30th Classic Collection, many
    Korean prints) are recognised by the owner's front photos of them, fingerprinted on the phone
    and matched beside the catalog's pictures. Cards the catalog has a picture of are left alone.

### 2026-11-18

- **v77:** a Portuguese or English card that reads no number no longer waits for its name. `59d661f`
  - When the picture is not clear and the number does not read, the name strip is read only while
    Japanese or Korean cards are scanned, whose name route needs it. For Latin cards it was read
    16 times in Eric's 18 November report, about 2 s each, and never led to the card he kept; on
    the lab benchmark leaving it out changed no card.

- **v76:** the scanner names its matches with no download, and skips reads that cannot help. `2104052`
  - The cards a picture matches are named from a table shipped with the app (every card the
    scanner knows by picture), not from TCGdex's set records, so a card shows sooner, and much
    sooner on a set the phone has not seen. In Eric's 18 November report this step took about
    0.9 s on a typical card and up to 10 s on a weak match.
  - When the number does not read on the side most of the candidates print it, the other side is
    read only if one of them prints its number there. In that report the other side was read 28
    times, about 2.5 s each, and never gave a number.
  - On the lab benchmark, the same cards come out right (174 of 174) in about a third less time.

- **v75:** a tidy-up behind the scenes; nothing changes on screen. `4acd1e3`
  - The card page's price panel no longer draws a Ver na Liga that was then hidden.
  - Checklists drop the drawing for hand ticks, retired since v30.
  - Collections and family wishlists use the app's shared helpers for their catalog requests.
  - Every test fakes the exchange-rate site, and a check fails any test that does not.

- **v74:** small fixes from the v71 review. `01fb542`
  - All, Owned, and Missing put each number under its word when they do not fit side by side, on
    a small phone, with larger text, or with a four-digit count, instead of one wrapping alone.
  - A card page picture with no image keeps its text clear of the Official label.
  - Wanting a family member's Korean copies of a Japanese card asks for Korean, not Japanese.
  - Export CSV leaves the language empty for a copy with none, and such a file (or an older one
    with NULL) imports back.

### 2026-11-17

- **v73:** a copy's sheet saves your changes when you close it. `d3fcdde`
  - Close, Back, Escape, a tap outside, or leaving the card saves what you changed, as Save does.
    Before, only Save kept a change such as a finish set to reverse holo.
  - The "Copy saved." toast has Undo, which puts the copy back as it was.
  - Remove copy still saves nothing you changed before tapping it.

### 2026-11-11

- **v72:** save a card's picture from its page. `f7b4177`
  - Right-click the picture on a computer for the browser's own **Save image as**, on the card page
    and full screen.
  - **Save image** under the picture saves the one on screen as a PNG named after the card, such as
    "Pikachu - Surging Sparks 057 (EN).png", and your own photos the same way.
  - The catalog's image server refuses most pictures to the app, so a small Supabase function
    fetches them for anyone signed in. Offline, Save image says it needs a connection.

### 2026-11-09

- **v71:** a Pokémon's cards as a goal, and from there a binder. `0fdc2f6`
  - On "Every Pikachu card", **Make this a goal** asks which languages to include, starting with the
    one shown. Once the goal exists, the same spot links to it ("Your goal: Every card in PT, JA").
  - The goal sits in Lists with the set and artist goals: how many you own, what is missing, set and
    rarity filters, and one tap to put a missing card on your wishlist. Copies with no language count.
  - **New binder**, **From a list**, then the goal gives one pocket per card, oldest set first: the
    cards you own in place, the rest as placeholders that fill when you get them.
  - A family phone still on version 70 hides the goal and keeps it, and its binder, untouched.

- **v70:** from a card's page, open its set or every card of its Pokémon, one language at a time. `8f68302`
  - A card's **Set** opens that set's page, in the card's catalog and language.
  - Under the card, "Every Jigglypuff card" opens every print of that Pokémon, the same screen a
    checklist row opens but with no checklist, with All, Owned, and Missing, the owned marks, and
    one tap to the wishlist. A TAG TEAM card has a link per Pokémon; a Trainer or Energy card has
    none. On a family member's card page only the Set link shows.
  - That screen has a row of flags at the top and shows one language at a time, starting with the
    card's own. A language loads only when its flag is first tapped (so a tap never pulls every
    Asian catalog over mobile data), and its flag then shows its count.
  - The card page keeps **Ver na Liga** on a small phone's first screen: Number and Rarity share a
    line, and a long name with its region wraps instead of running off the edge.

- **v69:** four ways to see your cards on My Cards. `a4234d6`
  - A **View** menu under Sort and Filters offers **Large** (two a row, the art big with the name,
    the number as printed, and the value), **Grid** (the tile as before, and the default),
    **Mini** (the art alone, a binder page's worth at a glance), and **List** (a row per card).
  - The choice is kept on the phone, so My Cards opens the way you left it.
  - A List row shows a thumbnail, the name and value, the set and number, then the language
    ("Language not set" when a copy has none), the finish, and ×N for more than one copy.
  - With large text on a narrow phone, each view gives fewer columns and List rows wrap, never a
    sideways scroll.

- **v68:** a clearer hint for cards you already have, and the scanner on shorter screens. `db8d46f`
  - As a card is matched, a green note over the camera says "✓ Pikachu: you have 2" for a few
    seconds, and its tray card gets a "✓ Have 2" strip and a green rim. Owned only in another
    language, both say which ("Have PT"). In a trade, only cards coming in are told.
  - On a shorter screen (a Realme at 360 x 660 with the zoom row showing), Close, the shutter, and
    Done fell below the screen. The camera now gives up the space instead, down to 200 px; under
    that the panel scrolls with those buttons pinned. With large text on a narrow phone, the
    Settings and Hand-held chips over the camera no longer overlap.
  - Profile shows **Continue with Google** straight away, not only after tapping the email field.

### 2026-11-07

- **v67:** design polish across the scanner, trades, and binders. `f0493bf`
  - One name, **Trade or sale**, for the scanner mode, the trades screen, and a card's button. The
    scanner's button says how many cards it logs ("Log 3 cards").
  - The trade tray's column heads are taller, and the one not in use says "Tap to scan here".
  - Held sideways, the scanner's buttons sit in a column beside the camera, all on screen.
  - Binders: a card out of its pocket offers **Edit pocket**; Lay out from a list is shorter and its
    buttons stay on screen; the card pickers put Sort and Filters on one row; the worth line reads
    "About R$ 4.952 in value"; the sideways page slider has a larger handle.

### 2026-11-06

- **v66:** remove or move a card in any binder, shifting the rest. `9787c35`
  - From a card in a binder (the card taken out of its pocket, or the pocket's sheet): **Remove
    from this binder**, then **Leave the pocket empty** or **Shift the rest back**; and **Move
    to...**, the end of the binder or a page and pocket, with the cards in between shifting. Undo
    on each.
  - Works in binders made from a list too: a card left out or moved is kept as a change to the
    list, so it stays when the binder updates, and a Pokémon that joins the list later still takes
    its place. Cards left out are listed under the pages with **Put back**.
  - Two phones shifting the same binder before they sync keep a sensible order. While family
    phones on older versions sync, a shifted card can end up "Not in a binder" (never deleted).

- **v65:** the binder page slider held sideways, and steadier tests. `50d56ee`
  - Held sideways, a binder's page slider and page menu share one row beside the Scan button, so
    the slider's handle is fully visible above the bottom bar at every phone size.
  - Four tests that failed under load now wait for what really happens (What's new, the scan
    guide, binder page turns, holder hand passes). No change to the app.

- **v64:** steadier holder scanning, easier trades, and the most valuable copy in placeholders. `ea63f14`
  - Holder mode: a blurred capture waits up to 1.5 s for a sharp look of the same spot instead of
    being saved blurred, the same card is not taken twice when a hand passes over it, and no card
    is ever lost. A card added because another landed on it, or one the scanner is not sure of, is
    marked "Check".
  - Trade or sale: a loose copy is taken by itself when the loose copies are alike; it asks only when
    they differ in finish or condition, or only copies in binders fit. Log it shows every card that
    needs a choice on one sheet, and the last pick opens the trades form. Log it waits for a card
    still being taken.
  - Trades and sales has **Scan a trade**, which opens Scan in Trade or sale.
  - Placeholders (Fill placeholders, the automatic fill, Lay out from a list) take your most
    valuable copy that fits; Start over and the trades log keep the oldest.

- **v63:** scan a trade or a sale. `c918349`
  - Scan has two modes: **Add** and **Trade or sale**, switched at the head of the tray. In Trade
    or sale the camera has a teal frame and the tray has two sides, **Going out** and **Coming in**;
    tap a side to send the next scans there.
  - A card going out is matched to a copy you own: a spare first, in the language and finish read.
    When two copies fit, you pick the copy; a card you do not own cannot go out.
  - **Log it** opens the trades form filled in with the cards, the kind (Traded, Sold, or Bought,
    with Gift as the alternative), and today's date. Add who and the price, then Save. Saving and
    Undo are the trades log's own; nothing in your cards changes before Save.

- **v62:** take a card out of its pocket, and lay out a binder from a list. `341151f`
  - Tapping a card in a binder lifts it out over the binder, large, with pinch and double-tap zoom.
    Under it: Details (the pocket's sheet), To the tray, Move, and Card page. Tap outside, swipe
    down, or Back puts it back. Placing a card from the tray still works as before.
  - **Lay out from a list** on a hand-made binder: pick a checklist, and its Pokémon go into the
    empty pockets as placeholders in Pokédex order, from the first empty pocket after the last one
    in use (or every empty pocket from page 1). Pokémon already in the binder are skipped, filled
    pockets never change, and pages can be added when the list does not fit. Cards you own fill
    them now, and new copies fill them as you add them. Undo takes it back; pages it added stay,
    empty.

- **v61:** sort the binder card pickers, a binder's worth, and report cleanup. `981ab96`
  - The pocket chooser and Add cards to the tray have **Sort**: Pokédex number, set (oldest set
    first, then card number), or name. The pick is remembered on each phone and starts at Pokédex.
    Region and other filters work with any order.
  - A binder shows its worth as a line under its name and size ("R$ 1.245 in value", with "~" when
    part of it is a US estimate, "partly priced" when some cards have no price). Tap it for the
    Value sheet.
  - Scan reports sent from Phone check are deleted automatically 30 days after they reach your
    account; Sent reports shows the day for each one.

### 2026-11-05

- **v60:** the scanner cuts a card held low or at a strong slant. `e96962a`
  - When a card runs past the guide's capture (held low, or turned so a corner or its foot leaves
    the frame), the edge found on the capture's border is kept and the missing bottom is placed
    from the top and the width, instead of cutting the card short.
  - The whole-frame search hides a box inside a bigger outline only when that outline really runs
    past the frame, so a card's art is not taken for the card and a card near the border is still
    found.
  - The scan report names which edge was placed.
  - On the lab bench, right card first on cards held low went from 11 to 27 of 40 (guide's capture)
    and 25 to 33 (whole frame); normal captures are cut exactly as before.

- **v59:** send a scan report in one tap. `7f0e026`
  - In Profile, Phone check, **Send report** sends the scan log (with card pictures when Include card
    pictures is on) to a private folder in your account, with an optional note. Only your account
    can see it; your family cannot.
  - **Sent reports** lists what you sent and shows each scan: what was read, the candidates, the card
    saved, and the picture. You can download or delete a report there.
  - Offline, a report waits on the phone and goes up when you are back online.
  - Needs `supabase/scan-reports.sql` run once in the Supabase SQL Editor.

- **v58:** edit a logged move, and list languages in binders. `f70ccba`
  - A sale, purchase, trade, or gift in Trades and sales has **Edit** for its date, who, price,
    and note. Only what you change is saved, so an edit on another phone is kept. To change which
    cards went or came, Undo the move and log it again.
  - A binder made from a list that names languages uses only copies in those languages, and the
    refresh note says when a pocket is emptied because no copy fits it now.
  - A card missing from such a list says which language you own it in, for example "Owned only in
    English".

- **v57:** Portuguese and French card images work better offline. `6e8504f`
  - TCGdex sends a broken header on some Portuguese and French images (not on others in the same
    set), so the phone can only keep those in a form that Chrome counts at about 7 MB each. The app
    now finds out image by image which ones those are, keeps every other image at its real size,
    and remembers what it learned when it restarts, so it no longer downloads the same images
    again on every visit.
  - The broken ones are kept in a space of about a tenth of the phone's storage for the app (about
    120 images on Eric's phone), the most recently seen first. For each, the app also keeps the
    English image of the same card.
  - Offline, a Portuguese or French card whose image is not on the phone shows the English image,
    marked "English image" under the tile (a caption on the card page), instead of the card back.
    Your own photos and family photos still come first: a tile showing one never says "English
    image".
  - If TCGdex fixes the header, the app notices (it tries one of those images again about once an
    hour while in use) and moves the images it kept to their real size.

### 2026-11-04

- **v56:** the scanner reads the names on Japanese and Korean cards. `bf8f0bb`
  - When neither the picture nor the number finds a Japanese or Korean card, the scanner reads its
    name in Japanese or Korean and looks the card up by it. A Korean name finds the Japanese record
    your Korean copies are kept on. A name alone never makes a card sure: you still confirm it.
  - A card you picked as Japanese or Korean (or Set for all) is read in its language at once. Any
    other card is tried in Japanese or Korean only when its name looks like Japanese or Korean
    letters, or your last pick in Scan was Japanese or Korean.
  - The Japanese and Korean reading data (1.5 MB and 1.1 MB) downloads the first time a card needs
    it and is kept for offline use; opening the app downloads nothing more. A card picked as
    Japanese or Korean waits up to 20 seconds for it. Any other card never waits: it starts the
    download, and the cards after it use it.
  - English, Portuguese, Energy, and Trainer cards read as before, with no Japanese or Korean
    download. With no connection before the data was kept, the scanner tries again once the
    phone is back online.

- **v55:** a log of the cards you sell, buy, trade, and give. `a6ba8e2`
  - **Trades**, beside Spares on My Cards (and **Trades and sales** in Profile), opens History.
    **Log a move** records a sale, a purchase, a trade, or a gift: the date, who with, one price for
    the whole move if there was one, and a note. A trade asks whether you paid the cash or got it.
    Type the price as 30,50 or 1.500,00 (1.500 is fifteen hundred); the form shows the amount it
    will save.
  - Cards out are picked from your copies, spares first. They leave your collection, and a card
    that was in a binder leaves its placeholder there. Cards in are picked from the catalog with
    their language, finish, and condition; they go into a waiting placeholder and move a wish to
    Got it, as any card you add does.
  - **Sell or trade** on a copy's sheet and on a card's page starts a move with that copy.
  - **Log a past sale:** the cards out picker also lists the copies you removed in the last 30
    days, newest first. Picking one links it to the move; it stays removed.
  - History lists every move, newest first, with the money in and out each month. A card's page
    says how its copies came and went, such as "Left: sold for R$ 30,00 to Ana, 3 Nov".
  - **Undo**, on the message after saving or on a move in History, puts the cards out back in
    their pockets and removes the cards in, except one you changed since. Photos and notes stay
    with the card all along. Prices only: there is no profit per card.
  - **Undo Start over** waits while a move sold or traded a copy it added, and names that move:
    undo the move first. A move logged before a Start over, or before its Undo, keeps no Undo.

### 2026-11-03

- **v54:** your photos show on every screen, not only in My Cards. `574476c`
  - Every place that draws a card now picks its picture the way My Cards does: the official
    image, else the international print's, else your own photos, with the one you chose with
    **Use as main image** winning. That covers binder pockets, placeholders, the tray and the card
    pickers, Not in a binder, Sets (a set's cards and the card search), a Pokémon's cards, goals,
    the wishlist, and the cards left out of a collection, which now show a card back instead of a
    blank square. A Korean or Japanese print with no official image shows your photo instead of a
    card back.
  - A card you have no copy of any more still shows its photos, in a placeholder, on the wishlist,
    or on a set's page.
  - A family member's spares and collections showed **your** photos on their cards; they now show
    theirs, and their binders, Sets, and goals do too. Their wishlist shows the photos they have
    uploaded.
  - When copies of a card ask which one to remove, the count of photos is right again.

### 2026-10-31

- **v53:** adjust a photo that came out too dark. `5b69998`
  - On a card's page, each photo you took has **Adjust**. **Auto** fixes a dark or flat photo in
    one tap; sliders set Brightness, Contrast, Saturation, and Warmth, and Reset puts them back.
    Hold the photo, or tap Original, to see it as it was.
  - Save puts the adjusted photo in the old one's place, front or back, with the main image pin if
    it had one, and it uploads like a new photo, so it works offline too. A detail copy is adjusted
    the same way; if it cannot be loaded, the new photo is saved without one and the app says so.
  - **Undo edit** on the message after saving brings the old photo back exactly. Family members'
    photos have no Adjust.

- **v52:** binder placeholders fill themselves. `e5edb78`
  - **Fill placeholders**, on each binder and on the Binders list, puts the cards you own into the
    pockets waiting for them, after a preview, with Undo. After Start over it uses the language
    each pocket's card had, so Portuguese and English copies go back to their own binders; press it
    on the phone where you started over, which keeps that record for 7 days.
  - From now on every card you add (scan, import, Start over, Add cards, by hand) goes into a
    waiting placeholder by itself. Turn it off in Profile, Binders.
  - A card on your wishlist moves to Got it with the date when you add it.

- **v51:** Start over with this file. `d92d164`
  - After you pick a monprice file, Import offers **Start over with this file**: every copy you have
    is removed (hand-made cards stay) and every card in the file is added fresh. A copy whose
    photo is still uploading from another phone stays, and the preview says so.
  - Photos, notes, and your main image stay with their cards and show again on the new copies.
    Condition, Stored in, favorites, prices, grades, pack openings, binder spots, and collection
    picks stay with the old copies and are not copied over; the preview says how many, lists the
    cards that will have no copy, and offers Export CSV first.
  - Undo Start over stays on the Import screen for 7 days. It keeps any new copy you changed since
    and says how many, and it is no longer offered once you start over again, on this phone or
    another.
  - A file that lists the same card, language, and finish on two rows now adds every copy, in
    Start over and in the normal import.

### 2026-10-30

- **v50:** delete your photos of cards that now have an official image. `29f53ef`
  - When the catalog adds an official image for a card you photographed, a notice offers to delete
    your photos of its front to save space; photos of the back are kept. Review shows each official
    image beside your photo; photos you chose as the main image start unticked. Delete has Undo, and
    Not now waits until more cards gain an image.

- **v49:** the Sets search finds cards, not only sets. `a7505e2`
  - Type a Pokémon or Trainer name (English or Portuguese), a number like 025 or 025/165, or a set
    code and number like MEW 025, optionally with a kind such as ex, V, VMAX, VSTAR, or SIR. Matching
    sets come first, then card tiles grouped by set, with language flags and your owned copies.
  - Offline it searches the sets already saved on your phone.

- **v48:** photos and notes belong to the card. `32c268f`
  - Your photos, notes, and the image you picked with "Use as main image" are now kept on the card
    (per language), not on one copy. Every copy of the card shows them, and so does the card's page
    when you have no copies left, so deleting copies never loses a photo or a note.
  - The first time the app opens, it moves what your copies had. When several copies of a card had
    different notes, all of them are kept, newest first.
  - A language with no photo of its own shows the photo of another language of the same card.
  - Phones still on the old version keep syncing, but do not show your photos until you tap Reload.
    Run `supabase/card-photos-keep.sql` once in the Supabase SQL Editor before deleting cards to
    start over: it stops an old phone from deleting photo files.

### 2026-10-23

- **v47:** region and generation, and a page slider. `d8aa100`
  - The card page shows which region and generation a Pokemon is from, like "Bulbasaur (Kanto I)";
    regional forms show their form's region, TAG TEAM cards every region, Trainers and Energy none.
  - Binders have a page slider: drag it to see the page numbers and a small preview of each spread,
    and let go to open it; arrow keys work too.

### 2026-10-17

- **v46** (includes v44 and v45, which were never released on their own). `a64f549`
  - **Import from the share sheet** (Android, installed app): share a monprice export or the app's own
    CSV to Card Tracker and Import opens with it; nothing is saved until you tap Save.
  - **Add to binder** on a card's page: pick a binder, then tap an empty pocket, use the next free one,
    or keep it in the tray, with Undo; a waiting placeholder is pointed out.
  - **Shared family photos:** a card with no picture shows a family member's photo, marked "Photo by",
    until you add your own (each phone fetches only the members' small photo index).
  - **Drag between pockets:** press and hold a card, drop it on another pocket to move or swap, with
    Undo; Move to pocket... in the pocket's sheet.
  - **Binder pickers:** one tile per card with a copy count, the Filters sheet (plus a new Artist
    filter, also in My Cards), and the search focused at once only with a mouse.
  - **Bigger binder** on computers and tablets, with minus, Fit, and plus buttons.

### 2026-10-16

- **v43:** binder pickers search like My Cards. `b838d12`
  - Add cards to the tray and the pocket chooser find cards by English name, reading, or any
    language's name (a Japanese Aerodactyl by "aerodactyl").
  - Clear all shows as soon as any filter or search is on, and clears the search too.

- **v42** (pushed before its full test run finished, by mistake; the run then passed, with two
  timeouts that passed alone): Add cards to the tray, from a box or a list. `cd1e464`
  - **From** in Add cards to the tray: a Stored in place (a box), a checklist, a collection, or a goal
    shows only its cards.
  - **Snap** button in the corner editor, remembered; snapping only to real-looking card corners.
  - **Rotate** for binder cover pictures.

- **19:08** Version 41: smarter photo corners, and corners that snap. `46addf1`
  - **Adding a photo** finds the corners with the scanner's card finder, including a silver card on a
    silver surface (worst corner error 1.2 px against 152.6 px on the test image); when unsure, a tip
    suggests a dark or coloured surface.
  - **Corner handles snap** onto detected corners as you drag them, with a light buzz; dragging further
    lets go, and arrow keys never snap. Card photos and binder covers both.

- **16:54** Version 40: a new card means a new picture, and automatic holder mode. `8d3edbb`
  - **Holder mode** compares each settled card's picture with the last card's, so a different card
    is caught even when it lands exactly on the last one; the same card after a drop asks Add a
    copy or Mistake. The rule that skipped such drops as "moved" is gone.
  - **Hand-held pile method:** scan the top card, take it off, and the card underneath is taken.
  - **Automatic holder mode:** on after 2 s of the phone still in its stand, off when it is picked
    up; the chip cycles Auto, Holder, Hand-held.
  - **Wider picture search:** crops shifted 10%, the wrong size, or with a strip of the card below
    are recognised far more often (1,002 of 1,056 test re-crops against 919, none wrong but sure).
  - **Safety:** a silent picture worker is replaced so a card cannot hang on Reading; background
    language checks wait for the cards being read; skipped drops keep their views in the scan log.
  - **Fixed:** a card landing on another could be read as its Japanese twin after the wider search.

### 2026-10-15

- **19:14** Version 39: scanner settings, upside-down cards, and an instant Save. `18f355f`
  - **Save** writes the whole scan session at once (about 0.5 s for 48 cards, was about 15 s of a
    frozen screen) and says "Saving N cards" at once. A card whose read stopped becomes "needs a
    look" instead of blocking Save, and the scan log records the error.
  - **Upside down or on its side:** recognised (91 to 92 of 96 logged crops turned, was 0).
  - **Scanner settings:** a default finish (Normal, Holo, Reverse holo, or Ask), a shutter sound (on
    by default), a gold rim with a star and value for cards worth at least an amount you choose (R$ 50
    at first) with an optional chime, and a rising arrow when Cardmarket is up 15% or more.
  - **Faster:** the full-resolution picture is read in the background worker.
  - **Fixed:** refused photos were sent again after every save; a scanned card could be named by its
    code (swsh3-102) for a moment.

- **11:44** Version 38: languages, lighter sync, and better scan reading. `60f28c6`
  - **Lists count the languages you pick:** a new list starts with Portuguese; lists you already
    have keep counting every language until you change them, and ticking every language means
    Any language again (German, Spanish, Italian, and no-language copies count).
  - **Scanner:** reads the collector number on full-art cards (ringed digits; 134 of 240 test
    captures against 80), and Portuguese, French, and German names, Paradox Pokémon and Trainers
    included, when the picture and number do not settle a card.
  - **Lighter sync:** your other devices read only what a save changed; a small edit with 1,600
    copies moves about 430 KB instead of 1,280 KB, or about 2 KB with the optional
    `supabase/patch-document.sql`. Saves are announced by a light broadcast. My Cards redraws only
    the tiles that changed (about 200 ms after an edit, was 690).
  - **Smaller:** long Japanese and Korean set names show in full in Filters; more Portuguese and
    French pictures stay offline; a card whose twins you turned down is checked again a week later;
    the photo editor names languages instead of codes; scan language chips follow the app's order.

### 2026-10-10

- **01:18** Version 37: small gaps. `c8101df`
  - **Add cards to the tray:** a hand-made binder can take many cards that are not in a binder yet
    in one go, chosen with search and a set filter, with Undo.
  - **Tidy tiles:** a long Japanese or Korean set name ends in an ellipsis instead of a third line
    on small phones; the full name is still read out.
  - **Japanese set pages** show the international print's picture for cards with no image of their
    own, as card pages already did.
  - **Under the hood:** one corner editor for card photos and binder covers, and the wishlist search
    and theme hint fetch TCGdex through the shared module.

- **00:27** Version 36: holder scanning rebuilt from your videos. `0f05d47`
  - **Holder mode** notices each drop by what changed since the last still picture, so cards
    landing on the same spot and a fast drop rhythm are taken, each once and never mid-fall. The
    crop comes from what changed, trimming the strip of the card beneath. Scanning keeps going
    while you check a card, and a slow read no longer holds up the next one.
  - **Review** starts from any card that needs a look, or from the "to check" count, and walks
    through them all. A sheet no longer redraws or shrinks under your finger while open.
  - **Fewer cards to check:** a card whose crop came out a little off is searched again more
    widely. On your 96 logged crops: 92 right first (was 88), 24% to check (was 43%), none wrong
    but sure. On your videos: 37 of 37 and 19 of 20 drops taken once (was 10 and 6).
  - Holder mode holds focus and white balance, and shows a light tip (the torch at 1.4x, or a
    lamp beside the box). The scan log keeps small before and after views of each drop for replay,
    and Share sends it as plain text.

### 2026-10-09

- **20:50** Version 35: the scanner finds the card anywhere, and holder mode. `1e57220`
  - **Card anywhere:** the scanner searches the whole camera view, not just the frame, and cuts
    the card by its own corners, bigger or smaller than the frame, off to one side, or turned. On
    a pile it takes the card on top, not the strip of the one beneath.
  - **Holder mode** (a switch on the scanner), for a phone in a stand: each card you drop is taken
    once it has been still for a moment, never while falling, and "Pile too high: empty the box"
    shows when the top card runs off the view.
  - **Review** opens each card that needs a look in turn ("Card 2 of 5 to check"), with Stop, and
    those cards read only the number in most cases, so they come back much faster.
  - **Fixed:** the same card taken again moments later could join the tray twice; it now asks
    first. The shutter waits up to a second for a whole card.
  - **Scan log:** also records the zoom, holder mode, where the card sat in the view, and how long
    it was still.

- **18:49** Version 34: binders from a list. `55419b0`
  - **New binder, From a list** (or Make a binder on a checklist, goal, or collection): pick the
    list or a filter, an order (Pokédex, set and number, name, release), and a pocket size, and the
    app lays out the pages.
  - Each pocket stands for a Pokémon or card and shows your best copy (most valuable, else rarest,
    else newest), with a count when you have more. Tap it to pick another; the pick sticks. Cards
    you do not have show faded, with Add to wishlist.
  - Opening the binder, or Refresh, fills in cards you got since and says what changed, keeping
    your picks. These binders are views: a card in one still counts as not in a binder.

- **17:26** Version 33: where cards are stored, list order, and simpler prices. `3a625cc`
  - **Stored in:** note where each copy lives. Places you type are saved and offered as buttons,
    can be renamed or removed with Undo, sync between phones, and filter My Cards, Spares, and
    collections. Set the place for many copies at once from a filtered My Cards. The CSV carries
    it.
  - **Edit order:** checklists, goals, collections, and binders can be dragged into order, or moved
    with arrows. Deleting one happens at once with Undo instead of a question.
  - **Collections that fill themselves** can leave a card out, and put it back later.
  - **Prices:** the card page shows TCGplayer and Cardmarket in reais, and a copy whose finish is
    not listed shows the price of one that is, saying so. The Liga form is gone; a Liga price
    typed before stays as one line with Remove, and Ver na Liga still opens Liga.
  - **Fixed:** opening Spares while My Cards was still pricing left some spares with no price, and
    sorting by price did not move cards whose price arrived later.

- **16:10** Version 32: scan card after card. `cc8d063`
  - **Continuous scan:** no sheet opens by itself, even for the first card. A short buzz says the
    card is recognised, a triple buzz that it needs a look, and a count over the camera says how
    many cards are in the tray and how many to check.
  - **Mistakes and copies:** each tray card has an x to throw it away, with Undo, and a Copies
    count for duplicates. The same card twice in a row asks Add a copy or Mistake; with no answer
    it is not added.
  - **Swapping cards:** a card put straight in place of the last one is taken as a new card.
  - **Scan log:** Phone check can record every scan (with a small picture of the card and what you
    finally saved) and save them all in one file to download or share. It replaces the switch
    that opened the report after every scan.

- **14:17** Version 31: a cleaner scanner and app, and What's new. `dbde67a`
  - **Scanner:** a frame with no card in it no longer joins the tray ("That did not look like a
    card"), a card too far away says "Move closer", and reopening Scan with the card you just
    added still in view does not add it again for 10 seconds (the shutter still does).
  - **What's new:** after an update, a short list of what changed shows once. Profile ends with
    the version and opens every release's list.
  - **Liga prices you type** say which finish and language they are for.
  - **Smaller fixes:** theme swatches in Profile stay put when you pick one; a note when the
    phone's clock is off, which would confuse sync.
  - **Under the hood:** one module for TCGdex and one for the phone's storage instead of several
    copies each, shared formatting, binders and wishlist on the theme's colors, the camera code
    moved out of the scan lab, dead code removed, and recorded TCGdex answers for the tests.

### 2026-10-06

- **08:45** Version 30: small fixes from the backlog. `acb42f7`
  - **Want from a family member's cards:** Add to wishlist now shows on a family member's card,
    saves only to your own wishlist, and starts in the language of their copy. The card says
    when they have spares ("Ana has 1 spare"), and their Cards page links to their wishlist.
  - **A smaller value:** sets, checklists, and binders show a Value button that opens the sheet,
    as My Cards does, instead of the big Total, Average, Highest, Lowest box.
  - **Binder placeholders at scan:** a scanned card that a binder pocket is waiting for says
    "Goes in Binder 2, page 7, pocket 4", and Place it there (on by default) puts the saved copy
    in that pocket. Undo session puts the placeholder back.
  - **No more hand ticks on checklists:** a stray tap on a missing Pokémon no longer marks it
    owned. The row opens the Pokémon's cards instead, where the real card can be added. Old hand
    ticks no longer count.
  - **Ver na Liga:** links now find Generations Radiant Collection (`RC19/83`), Scarlet & Violet
    promos (`012/∞`), and McDonald's 2023 (`005/015`) cards.

### 2026-10-03

- **20:05** Version 29: collections and goals. `31e9329`
  - **Collections:** a new part of the Lists tab. Pick cards by hand, or let a collection fill
    itself from a rule (rarity, set, language, type, region, favorites; a "Star" preset gathers
    every SIR and IR). Each shows its count and value and opens like My Cards, with filters and
    the Value sheet. Add a card from its page, or a whole scan from the Done sheet. Two phones
    adding different cards both keep theirs.
  - **Set goals:** track one set as numbered (up to the set number), with secrets (every card),
    or master (every card in every finish, ball patterns and stamps included).
  - **Artist goals:** every card by one illustrator, started from the illustrator's name on a
    card page.
  - Each goal shows a ring and "N of M", All, Owned, and Missing with counts, and one tap to the
    wishlist, and its missing list works offline once opened. Make one from New goal on the Lists
    tab or Make this a goal on a set page.

- **14:30** Version 28: spares, favorites, and cards the catalog lacks. `58b1cc4`
  - **Spares:** a Trade view lists the copies beyond the first of each card in a language, with
    the filter bar and the Value sheet over the spares. Open it from Spares on My Cards or from
    Profile; a family member's spares open read only.
  - **Favorites:** a star on a card page marks the card; favorite tiles show a star, and the
    filters can show only favorites.
  - **Add by hand:** a card the catalog does not have (an Asian print with no record, a promo
    numbered past the set, a letter-numbered energy) can be added from My Cards, from the
    scanner, or from an unmatched row in the import report. It has its own page with copies, a
    photo, edit, and remove, and offers to link to the catalog card once TCGdex adds it.
  - **Restore from your own CSV:** Import also reads the app's own export, restoring copies by
    their id without duplicates; deleted copies stay deleted unless you tick them. The export
    now also carries condition, notes, names, finish, number, and set code.

- **13:14** Version 27: scanner fixes from your tests. `de41a48`
  - A Trainer or Energy card keeps your last Western language when its label row reads nothing
    (those cards have no weakness row). A missing label points to Japanese, Korean, or Chinese
    only for a Pokémon whose picture matches an Asian print.
  - A collector number whose slash was misread as a digit ("022/084" read as "10227084") is now
    understood. It never overrides a sure picture match.
  - The scan report can save capture images: the straightened card and the whole capture, with
    the edges, the crop used, and the read areas drawn on, for the last few scans.

- **12:27** Version 26. `adc0e7b`
  - **Scanner:** on a light table it finds the card's own edge instead of the silver border's
    inner line, which made crops too narrow; it also tries the guide frame itself and slightly
    moved or resized crops when a match is weak. A clear match with a big lead now counts as
    sure. A card with no Latin text starts in your last Asian language (Korean at first), never
    a Western one, with Japanese, Korean, and Chinese first. **Clear** empties the scan tray in
    one tap, with Undo. Cards the picture cannot settle show at once.
  - **Sync:** edits to different parts of one card, binder, list, or wish on two phones now both
    survive: a price and a photo, a note and a condition, pockets in one binder, hand ticks. A
    pocket emptied stays empty, and an untick stays unticked. Older app versions fall back to
    the old rule without losing deletes, photos, cleared pockets, or unticks, and a phone that
    meets newer sync rules says "Update the app to keep syncing".
  - **Sets:** search finds printed codes such as MEW or CRI; All, Owned, and Missing show counts;
    statistics say copies; the Korean screen explains where Korean Scarlet and Violet copies live.
  - **Smaller fixes:** Ver na Liga handles Japanese promo sets; German, Spanish, and Italian
    copies show language names; a tile mixing finishes says which finish its price is for; the
    CSV export has consistent headers and a currency column; tile images no longer repeat the
    card name to screen readers; Profile fits at 200% zoom; Portuguese and French images
    download once instead of twice; Phone check has the scan report switch.

- **10:43** Version 25: the scanner on a real phone. `bdb3474`
  - The guide fits the part of the camera view you can see, so its whole outline shows whatever
    Chrome's and Android's bars take. Before, its bottom could sit under the tray.
  - The picture is taken around the guide with room to spare, so all four card edges are found
    instead of one being guessed, which is what made some matches fail.
  - Auto capture fires sooner with a card held in the hand, and the card no longer has to fill
    the frame exactly.
  - A card is marked sure only when its picture match is close and clearly ahead.
  - Cards recognised by their picture start in the language you last picked (Portuguese at
    first) and show that print's name; the language label is read in the background to correct
    it. They appear at once, with the full record loading behind.

- **09:34** Version 24: the scanner recognises cards by their picture. `c3c56ff`
  - It matches the card's artwork against every card in the catalog in a fraction of a second,
    with no text to read, so full-art cards such as an SIR are found too. On the test set the
    right card comes first 99% of the time, up from 83%, and no card was saved wrongly as sure.
  - Text is read only to choose between prints that share the same art (a reprint, or the
    Japanese print), so most scans skip it entirely, and Scan opens without downloading the
    reading engine.
  - When it is not sure, it shows the five closest cards as pictures to tap. When the picture
    and the number disagree, the card waits for a look instead of being saved.
  - Crops are snapped to the card's true shape, so a strip of table beside the card no longer
    throws the reads off.
  - A Korean card from a set the catalog does not have yet can be added by hand, with its number
    filled in. Traditional Chinese cards are recognised too.
  - The scan report lists the five closest artworks and whether text was read.

- **07:55** Version 23: the second round of audit fixes. `b0bbbd1`
  - **Scanner:** a card held turned up to about 20 degrees is found and captured on its own, and
    stripes or a blank sheet no longer pass as a card. Every scanned card has a **Scan report**
    you can copy and send (the phone, each step's time, what each read got, the cards
    considered), and **Pick a photo** reads a card from your gallery. The language chips start
    with Portuguese and English.
  - **Copies:** each row of Your copies has a "− N +" stepper (tap the number to type a count),
    and a binder's pocket sheet has one too. Removing saves at once, and Undo brings back the
    same copies with their photos and binder pockets.
  - **Family view:** Sets, set pages, and card pages show the member's own cards, with no edit
    buttons. The "Whose cards" sheet shows each person's favorite Pokémon and closes with Back.
  - **Sign-in:** if the server stops accepting your session, the app says "Sign in again" and
    keeps your waiting changes. A photo that did not upload says why, with Retry and Remove in
    Profile.
  - **Faster:** hand ticks on a list are instant, My Cards updates in place after an edit
    instead of reloading, family wishlists download only the wishlists, and a change from another
    phone no longer downloads your whole collection again. Offline, a Portuguese or French card
    whose image is not saved shows its English art.
  - **The Scan button** is a Poké Ball that follows your theme: Nest, Repeat, Dive, Quick,
    Master, Sport, Dusk, Heavy, Ultra, Premier, or Heal Ball, and the red Poké Ball by default.

### 2026-10-02

- **11:08** Version 22: the first round of audit fixes. `0b718b7`
  - **Your cards stay right.** Importing the same monprice file on a second phone, or signed out
    and then signing in, no longer doubles your cards, and a collection already doubled is
    repaired at the next sync (each card keeps its oldest copy, with its photos, Liga price,
    notes, and binder pocket). Something you delete stays deleted, even if another phone edited
    it offline. With the app open in two tabs, both keep their edits. The same wish added on two
    phones becomes one. Removed photos and covers stay on the server for 14 days, so other
    phones never show a broken image.
  - **Import** refuses a Count above 999, asks before saving any row above 50 copies, and reads
    numbers written as ="001".
  - **Card pages:** tap a copy to fix its language, finish, condition, or notes, or remove it
    (with Undo, and a note when it leaves a binder). Add copies by hand, 1 to 20 at a time, even
    for cards you do not own yet. Add to wishlist from the card page. Your copies and Ver na Liga
    are now on the first screen, and the previous and next arrows sit beside Back instead of
    covering them. An owned card opens from what the phone knows while TCGdex is down.
    Portuguese finishes read "Normal" and "Reverse holo" instead of "Normal, Padrão".
  - **My Cards:** a search over your cards (names in any language, sets, numbers, and Pokédex
    numbers such as "#25" or "#1-151"), and a Filters sheet: region or generation, Pokédex range,
    energy type, category, set, language, rarity, price, or not in a binder yet, with sorting by
    newest, oldest, name, Pokédex number, set, or price. Prices fill in by themselves in the
    background and refresh weekly; Japanese, Korean, and Chinese prints say "No price". The big
    Stats panel is now a small Value button that says how many copies are priced.
  - **Binders:** held sideways, both pages fit above the tab bar. Long notes fade with a More
    button instead of stretching the binder. Changing the grid keeps cards in place when it can,
    otherwise moves them up in reading order and adds pages, with a preview first. Each binder
    has a tray of cards to place: tap a card, then a pocket, drag it, or fill the rest in order.
    The placeholder search works offline and skips TCG Pocket. The empty-binder hint matches how
    the phone is held.
  - **Back** closes the open sheet or viewer (Add photo, Cover image, a scanned card, the image
    viewer, a binder pocket) instead of leaving the screen, and the camera always turns off.
  - **Smaller fixes:** a dot on Scan counts unsaved tray cards; a new version waits for Reload,
    so Scan never fails after an update; lists get "Any language" and checklists read past the
    first 300 Asian cards; the Pokémon screen with every finish is fast again; the CSV export
    gives Korean copies their Korean names; the Liga form refuses slips such as a lowest price
    above the average; the stray "null" texts are gone; a password reset also signs out other
    devices.

- **07:17** Version 21: binder pages turn on the middle of the spine, so a page no longer looks
  stuck to its own side and then jumps across at the end of the turn (most visible on wide
  screens). `e611001`

- **05:47** Version 20: international twins. `9c642f9`
  - A Japanese or Korean card with no image or English name of its own borrows them from the
    matching English print, on card pages and in My Cards. When the match is not certain, the
    card page asks you to confirm it.
  - My Cards opens as fast as before; the borrowed images fill in right after.

### 2026-10-01

- **21:48** Version 19: every card of a Pokémon. `5409418`
  - Tap a Pokémon in a checklist to see every card of it, in every catalog, with the copies you
    own and their flags.
  - Each list shows which languages it counts, with Edit to choose. Lists made before this count
    every language and say "All"; ticks still come from a copy in any language.

- **21:47** Version 18: binder spreads. `7515f6d`
  - Binders open as a two-page spread with a page turn; tap a page to zoom in, then a pocket to
    place a card. Presets for common binder sizes, and a cover image.
  - New binders start with 40 pages.
  - Deleting a binder also deletes its cover image from the server, even if you were offline at
    the time.
  - On a phone held sideways, the spread gets more room: the header stops sticking while a
    binder is open.

- **21:19** Version 17: the scanner on cards shown among other things, such as a card on a
  laptop screen. `c2e76d2`
  - Finds the card's own edges, so a heading above it is no longer read as the card's name. Your
    Weedle photo, framed the way the guide asks, is now a sure match every time.
  - Auto capture fires when the card fills the frame from top to bottom.
  - When it is not sure, nothing is picked for you: it shows what it read, the cards it thinks
    are close, and a search already filled in with the name.
  - A misread number can no longer make a card look sure when the name read says another
    Pokémon.
  - Right card first on 195 of 240 test captures (81%), against 192 for version 15 measured the
    same way. The 74% quoted for version 15 came from a run before it was finished.

- **19:53** Version 16: a login for a family member without an email. They pick "Sign in with a
  name and password" and can change the password in Profile. Eric creates the account in the
  Supabase dashboard (see the README); a forgotten password is reset with
  `supabase/reset-password.sql`. `5d27d51`

- **19:34** Version 15: a much better scanner. It reads the name, HP, attack, number, and language
  together, finds a card by name when the number is unreadable, compares the artwork to break
  ties, straightens cards photographed at an angle, and shows what it read with a prefilled
  search when it is unsure. Right card first on 74% of test captures, up from 40%. Your Weedle
  photo matched only when the card filled the frame from top to bottom and you pressed the
  shutter, fixed in version 17. `b7a6145`

- **15:29** Version 14. `23c0c4f`
  - Themes on the twelve TCG energy types (Default, Grass, Fire, Water, Lightning, Psychic,
    Fighting, Darkness, Metal, Dragon, Colorless, Fairy), each with its own palette, frame, and
    a faint header detail. Your favorite Pokémon suggests the energy most of its cards carry.
  - Prices on card pages: Liga Pokémon's lowest NM and average first (typed after Ver na Liga),
    then the US (TCGplayer) and EU (Cardmarket) markets in R$ with a trend.
  - Prices on tiles, statistics on binders, checklists, and sets, and a Stats panel on My
    Cards. The CSV export gains the Liga columns.
  - Tap a card's image for a full-screen viewer with pinch zoom and a Compare mode with synced
    zoom; an optional detail copy of new photos (Profile).

- **15:03** Version 13. `7602a94`
  - New tabs: Cards, Sets, a raised Scan, Binders, and Lists (checklists and wishlist). Profile
    sits behind your avatar and holds themes, favorite Pokémon, family, Import, Export and Share
    CSV, and Phone check.
  - The scanner: auto-capture, a session tray kept as a draft, the language read from each card,
    a finish picker that never remembers, duplicate counts, family wishlist alerts, "needs a
    look" before saving, Set for all, Undo session, and a check-only scan for shops. The reading
    engine downloads the first time Scan opens.
  - Your own card photos: Add photo on a card page, automatic cropping with draggable corners,
    and an image carousel with dots and "Use as main image".
  - A "Mine" switcher in the header for family view only mode, with a Done button.
  - Swipe left and right between cards in the list you opened them from.
  - An offline strip, one card tile everywhere, and the app's font stored in the app.

- **14:03** Version 11, with tabs for Lists and Binders, and Wishlist in the Menu. `07b9efb`
  - Pokémon checklists: Kanto through Paldea, or your own list, ticked from your cards in any
    language, with hand ticks and a Missing filter that works offline.
  - Ver na Liga button on cards, using Liga's exact names and numbers, including Japanese prints.
  - English names over Japanese, Korean, and Chinese names, with readings in parentheses
    ("Ptera VSTAR", "Peutera VSTAR").
  - Country flags instead of language codes on cards.
  - Type themes with game-style frames, and a favorite Pokémon in the header and tab icon
    (Profile).
  - Binders with notes, cover color, pages, placeholders, and "which binder is this card in".
  - Wishlists with priority and notes, and a read-only family view with spare counts.
  - TCG Pocket hidden from Sets; the scan lab no longer needs an Incognito tab.
- **13:48** Scan lab at `/lab/`: measures how well the phone reads cards. Benchmark: the right card first on 82% of clean and 65% of
  degraded captures. `385a02d`
- **12:05** Live sync: an open device picks up changes from another within a minute, or within
  seconds after running `supabase/realtime.sql`. Installed apps get it with the next version.
  `e322ba0`

- **11:02** Korean cards show their Korean name and set name from the monprice import. Re-import
  a list to fill in cards you already had. `3f7b3af`
- **10:45** Share CSV: send your export straight to Google Drive or any app from the phone's share
  sheet. `7b3dd1b`
- **10:42** Sign-in with Google or an email link, sync between your devices, and the family
  group: invite-only, you are the owner, members see each other's cards read only. `672ff3c`
- **09:55** Sets sort newest first correctly on every device (Mega Evolution is at the top).
  `037d242`
- **09:49** Import from monprice (CSV or JSON), My Cards with count and language badges, owned
  rings on set tiles, owned flags in sets with All, Owned, and Missing filters, set sorting, and
  CSV export. Importing again never duplicates. `e3b486c`
- **09:18** Browse every set in seven languages, grouped by series, with set and card pages and
  offline caching. `c6eab21`
- **08:27** Fixed: the offline banner showed the word "null". `a785ce2`
- **08:25** Phone check: camera and offline storage tests, plus a copyable device report.
  Passed on your Android phone and laptop. `0e835b7`

## Planned

### 2026-10-01

- **13:48** Navigation from the staff design review, approved: Cards, Sets, Scan, Binders,
  Lists, Profile behind the avatar; TCG Pocket hidden from Sets. `plans/design-review.md`

- **11:58** Image carousel per card with dots: official image by default, then an international
  print, then your own photos, with "Use as main image". `f7c6ad5`
- **11:58** Your own card photos, cropped and straightened automatically, with draggable
  corners to fix a miss. `345ab24`
- **11:54** International twins: borrow the image (and English name) of the matching English
  print for Japanese and Korean cards. Measured at about 99% accuracy; few of your cards match
  until Storm Emerald's international set exists. `a11ed78`
- **11:43 to 11:48** English names over Asian names, with readings, sourced from PokeAPI and a
  Bulbapedia-built table for trainers. `0c108eb`, `8c71518`, `23503d1`
- **11:13 to 11:43** Liga Pokémon's exact search rules: hyphenated EX, GX, and V names, dropped
  gender symbols, lettered subsets, promos, and separate Japanese pages. `5b02a1f`, `d157a5e`,
  `6904bbb`, `2559f11`
- **11:09** Ver na Liga button (no scraping), manual prices with source and date, and an alert
  when a scanned card is on a family member's wishlist. `460f233`
- **10:58** Pokémon checklists by region (Kanto to Paldea) or custom lists, with hand ticks and a
  Missing only view. `61c6b52`
- **10:24** Korean names from the import, images from your own scans. `4c12fb8`
- **10:26** Favorite Pokémon as avatar, header logo, and tab icon. `d92fb91`
- **09:42** Type themes and binder notes and cover color. `7d06229`
- **09:19** Finishes picked by hand from each card's real finishes; no paid services, ever.
  `e6b99a6`, `bab3904`
- **08:01 to 08:09** Hosting as a PWA on GitHub Pages with Supabase, invite-only family, one JSON
  document per person, one entry per physical card. `78f3555`, `e8ec5dc`, `99549a4`
- **07:36 to 08:06** The design itself: TCGdex as the catalog, language read from each card,
  batch scanning, quantity badges, goals, binders, wishlists, family groups, and the product and
  UX plans. `2ac410d`, `158d8ec`, `6f0da97`, `f9f4a93`

### 2026-09-10

- First design document. `fc4b5f0`
