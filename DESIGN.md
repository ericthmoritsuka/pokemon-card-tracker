# Pokémon Card Collection Tracker

Personal collection tracker. Point a phone camera at a card, identify it, store it,
organize it into collections, and see what it is worth.

Status: design only, nothing built. Last updated 2026-10-01.

Companion plans, written 2026-10-01 by a product review and a UX review of this document:
[`plans/product-plan.md`](plans/product-plan.md) (scope, release slices, success criteria) and
[`plans/ux-plan.md`](plans/ux-plan.md) (navigation, flows, wireframes, badges). Changes they
propose to this document are not applied here until Eric decides on them.

## 1. Scope

What it does:

- Identify a physical card by pointing a phone camera at it, including which language it is
  printed in.
- Browse every set and expansion in each language the catalog covers, back to the first
  editions: English, Portuguese, Japanese, Chinese, and Korean at least, French and the others
  when present. Owned cards show as owned in every language view.
- Store owned cards, with the details that vary copy to copy (language, condition, variant,
  quantity).
- Filter, search, and sort by price, rarity, date added, set, language, and the rest of the list
  in section 11.
- Group cards into collections, either hand-picked or self-filling from a rule (a Star collection
  that collects every SIR and IR on its own). A card can belong to more than one.
- Track goals: one card of every Pokémon, a set completed at three levels up to a master set, or
  everything of one Pokémon or one artist. Each goal has a missing list.
- Lay out physical binders: pick a grid, place a card in each slot, spread Michi-method art across
  several slots, print the inserts, and always know which binder page a card is in.
- Log pack openings, with what they cost against what they pulled.
- Scan cards one at a time or in a batch session, assigning a whole session to collections at once.
- Flag duplicates at scan time and keep a Trade view of the extras.
- Mark favorites.
- Look up current market price and its trend.
- Export and import CSV, both for backup and for bulk editing in a spreadsheet.
- Import the existing collection from monprice (section 7).
- Separate accounts for any number of people (Eric, his wife, and his brother to start), each
  signing in on their own phone and keeping their own collection.
- A family group, invite-only, whose members can browse each other's collections, binders, and
  wishlists.
- Wishlists, so the others can see which cards someone wants.

Out of scope:

- A portfolio view. monprice has one and it goes unused.
- Public sign-up. Only Eric adds people (section 3).
- Any link to the pokedex project. The two stay separate apps, each deployed on its own. *(Decided
  by Eric, 2026-10-01.)*

## 2. What monprice Gets Wrong

The tracker replaces monprice, which Eric uses today. These are the problems that make it
worth replacing, so every one of them is a requirement here.

- **Language is a sticky setting chosen before scanning, and the scan never overrides it.**
  With Korean selected, a Japanese card is saved as the Korean printing. Forget to switch it back
  and a whole batch is saved in the wrong language, and those cards do not show as owned when
  viewing the language they really are. The same holds for batch scans: every card in a session
  gets the one selected language.
- **There is no automatic "all my cards" collection.** Eric keeps one by hand (the export file
  is named `Todas`) and has to select it on every save, so every card is saved at least twice.
- **The profile totals count collection memberships, not cards.** A card saved into two
  collections is counted, and valued, twice.
- **Adding a card to two collections is two separate actions** on the card screen, and the
  "All" collection makes that the normal case.
- **Scanning a card already owned gives no warning,** so there is no way to know which cards are
  spare and can be traded. The only sign of a duplicate is a small `x2` / `xN` counter next to
  the card, which is easy to miss.

What it gets right, and must be kept:

- The catalog goes all the way back to the first editions, in several languages, with prices
  and trends.
- Batch scanning. Cards scanned in a session collect in a list at the bottom of the scanner.
  Tapping one shows its details, adds it to a collection, or removes it from the session. At the
  end the whole session is assigned to a collection in one step, and any single card can be sent
  somewhere else instead.
- Each set tile shows how many of its cards are owned (`2 / 122`), as a number and a ring.

Source: Eric's own use, and monprice's public store screenshots (2026-10-01).

## 3. Decisions and Why

These were settled in discussion. The reasoning matters more than the conclusion, so it is
recorded here rather than just the outcome.

**Card identity and card copy are separate tables.**
A Brazilian Charizard and an American Charizard share artwork, collector number, and set symbol.
Only the printed text differs. So language is a property of *your copy*, not of the card. If the
catalog ID is the only key, the two copies collapse into one row and the distinction is lost.
Everything downstream (filters, pricing, CSV) depends on this split.

**Western-language prints share one card record; Asian prints are their own cards.**
English, Portuguese, French, German, Italian, and Spanish releases of a set use the same set and
collector numbers, so they are one card with the language on the copy. TCGdex uses one ID across
those languages (`me01-001` is Bulbasaur in both `en` and `pt`), and monprice agrees: its IDs
carry `_int_` for all of them, and 72 of Eric's cards sit under one ID in both EN and PT.
Japanese, Korean, and Chinese releases have their own sets, set codes, and numbering, so they
are separate card records. *(Revised 2026-10-01. The first version treated every language as a
flag on one English record.)*

**Language comes from the scan, never from a setting.**
This is the fix for monprice's worst problem. The scanner proposes the language it read off the
card, and the confirm screen shows it with a one-tap change. There is no "current language"
state to forget. Changing a saved copy's language is an ordinary edit, and the CSV round-trip
covers fixing a batch.

**Display follows the viewing language, ownership does not.**
Each card stores its localized name, set name, and image per language when the catalog has them,
falling back to English. Ownership is computed from copies regardless of language, so a PT copy
shows as owned in the EN view, labeled "owned in PT".

**Owning is the base set; collections are tags on top.**
Every saved copy is in the collection automatically. Collections like Star are optional tags. No
"All" collection exists, because nothing needs one.

**Totals count copies, never memberships.**
Collection value and card counts sum over `copies`, not over `collection_copies`. A copy in
three collections counts once.

**Duplicates are caught at scan time; Trade is a derived view.**
A single scan of a card already owned asks "You have 1 (PT, holo). Add another?" before saving.
Trade is a query (copies beyond the first), not a stored collection, so it stays correct after a
card is traded away without anyone remembering to update it.

**A scan session is a tray, and every card in it carries its own language.**
Keep monprice's batch flow (section 2): scanned cards collect in a tray at the bottom of the
scanner, each one can be opened, retagged, or removed, and the session is assigned to
collections in one step with per-card overrides. The difference is that each card's language is
detected on its own, so a session mixing Japanese, Korean, and Portuguese cards saves each one
correctly. Owning is the base set, so a session needs no collection at all to be saved.

**In a session, duplicates are badges, not prompts.**
A prompt per card would break the rhythm of batch scanning. A tray card that is already owned,
or scanned twice in the session, shows the quantity badge below, and the duplicate decision is
made once when the session is saved.

**Quantity is a corner badge, not a trailing counter.**
monprice's `xN` beside the card is easy to miss. Any card image showing a copy owned more than
once carries a badge in its top-right corner (`×3`), in grids, collections, the Trade view, and
the scan tray. When the viewing language differs from the copy's language, a language chip
(`PT`) sits in the opposite corner.

**Set tiles show owned progress across every language.**
Keep monprice's `2 / 122` ring on each set tile, but count a card as owned whatever language the
copy is in, so the ring matches what the collection really holds.

**Catalog source is TCGdex.**
It covers the languages needed, back to Base Set, and embeds prices. The pokedex project already
calls it without an API key. It replaces pokemontcg.io from the first version of this design,
which was assumed English-only and was never checked. Coverage and gaps are in section 5.

**Cache card images; never hot-link them.**
On 2026-10-01 `assets.tcgdex.net` answered nearly every image request with
`503 no available server` while the API stayed up, which blanked the pokedex's card gallery. A
collection app that shows grey tiles during someone else's outage is broken. Store each image the
first time it is shown, in two tiers: every image viewed is cached on the phone, and only images
of owned cards, plus anyone's uploads, are copied to server storage. Copying the whole catalog to
the server will not fit Supabase's free tier, which has 1 GB of file storage (section 8).
*(Revised 2026-10-01.)*

**Local-first with an offline write queue, server as source of truth.**
Scanning happens in card shops and at events, where reception is bad. An app that needs a live
connection to log a card is an app you stop using. Writes land in IndexedDB immediately and flush
when there is signal.

**No sync engine. Last-write-wins per row.**
Each collection has one owner on one or two devices. Real conflict resolution is not worth the
complexity.

**One account per person, any number of people.**
Eric, his wife, and his brother each sign in on their own phone, and more can join. Copies,
collections, binders, goals, and wishlists belong to a user. The card catalog, cached images, and
prices are shared, because they describe cards, not anyone's ownership. Magic link or Google
sign-in, no passwords. Every user-owned table carries `user_id` with row-level security from day
one, because retrofitting it is miserable. *(Revised 2026-10-01. The first version was
single-user and only built to allow a second.)*

**A family group can see each other's cards; only the owner can change them.**
Members of a group browse each other's collections, binders, goals, and wishlists, read-only.
Everyone writes only their own rows. Row-level security expresses both: read where the row's
owner shares a group with you, write where you are the owner. Someone outside every group sees
nothing. Nothing is hidden inside the group, purchase prices included. Revisit only if the app is
ever opened beyond the family. *(Decided by Eric, 2026-10-01.)*

**Membership is invite-only, and only Eric invites.**
There is no public sign-up. Eric's account is the group's owner and the only one that can add or
remove members; an invited person can only sign in. In Supabase terms: open sign-up is turned off,
and invitations are sent from the owner's account. *(Decided by Eric, 2026-10-01.)*

**Wishlists are explicit, and separate from goals.**
A goal's missing list is everything not yet owned, which for "one of every Pokémon" runs to
hundreds of cards and says little about what someone actually wants. A wishlist is a short,
deliberate list: a card, optionally a variant and language, a priority, and a note. A missing
card can be added to the wishlist in one tap. Seeing a family member's wishlist next to your own
spares is the start of trade matching, which is deferred (section 12).

**Adopt TCGplayer's condition vocabulary verbatim.**
Near Mint / Lightly Played / Moderately Played / Heavily Played / Damaged is the de facto standard
for English cards. Using it as-is means the condition field lines up with the price being fetched
instead of needing a translation table.

**A copy's variant is a TCGdex variant ID, not a word.**
TCGdex `variants_detailed` lists every printing of a card with its own `variantId`, and the
distinctions collectors care about are all in it: Poké Ball and Master Ball reverse holos
(`foil: pokeball`, `foil: masterball`), Shadowless and Unlimited (`subtype`), and the 1st Edition
stamp (`stamp: ["1st-edition"]`). Ball-pattern variants carry their own TCGplayer and Cardmarket
products and prices. A free-text variant field could not drive the master-set goal or a
per-variant price. *(Revised 2026-10-01. The first version used TCGplayer's variant words.)*

**Collections are hand-picked or self-filling.**
A self-filling collection is a saved filter: Star is "rarity is `Illustration rare` or
`Special illustration rare`", and it fills itself as cards are saved. Rules match on TCGdex's
English values, because localized records translate them (a Portuguese common reads `Comum`). A
hand-picked collection works as today. Either kind is just a view over `copies`, so neither
changes the totals.

**Goals are their own feature, not collections.**
A collection holds cards you have; a goal measures cards you want against cards you have, and
its most useful output is the missing list. Kinds: one of every Pokémon, a set (three levels), one
Pokémon, one artist. Section 11 has the details.

**A binder is a physical place, so a copy sits in at most one slot.**
Collections are tags and can overlap; a binder slot is a real pocket. Each slot holds one
physical card, so the slots pointing at a copy can never outnumber its `quantity`. That rule is
what makes "where is this card?" answerable, and it shows unplaced copies for free.

**Two export formats, not one.**
CSV cannot losslessly hold collection membership, price history, and photos, so a CSV "backup"
silently drops data. CSV is for portability and spreadsheet editing. JSON is the real backup.

**CSV round-trip doubles as the bulk-edit surface.**
Fixing twenty mislabeled languages in a spreadsheet and re-importing partly removes the need for
a dedicated desktop bulk-edit view.

## 4. Data Model

Sketch, not final DDL.

```
cards                     -- shared catalog, cached from TCGdex, not user-specific
  id                      -- TCGdex card ID, e.g. me01-001, S11-057
  catalog                 -- international | ja | ko | zh-cn | zh-tw
  tcgplayer_product_id    -- stable external key, store even if unused at first
  set_id                  -- TCGdex set ID, e.g. me04, M6
  collector_number        -- STRING, never a number. "001" must not become 1.
  types[]
  rarity                  -- TCGdex English value, e.g. "Special illustration rare"
  dex_ids[]               -- National Dex numbers; a list, because TAG TEAM cards hold several
  illustrator

card_variants             -- from TCGdex variants_detailed
  id                      -- TCGdex variantId
  card_id -> cards.id
  type                    -- normal | holo | reverse
  subtype, foil, stamp[]  -- e.g. shadowless, pokeball / masterball, 1st-edition
  tcgplayer_product_id, cardmarket_product_id

card_localizations        -- one row per language the catalog has the card in
  card_id -> cards.id
  language
  name
  set_name
  image_url               -- source URL
  image_cached_path       -- our own copy (section 3)

copies                    -- the cards you actually own
  id                      -- UUID. Load-bearing: this is what makes CSV re-import safe.
  user_id
  card_id  -> cards.id
  language                -- EN, PT, JA, KO, ZH-CN, ZH-TW, FR, DE, IT, ES, ...
  language_source         -- scan | manual | import
  condition               -- TCGplayer vocabulary
  variant_id -> card_variants.id
  quantity
  purchase_price
  purchase_currency
  opening_id -> openings.id   -- optional, the pack opening it came from
  storage                 -- optional free text for copies not in a binder ("Bulk box A")
  grader, grade, cert_number, graded_price   -- optional; TCGdex has no graded data
  notes
  is_favorite
  photo_url               -- optional, own photo for condition documentation
  created_at / updated_at

collections
  id, user_id, name, description
  rule                    -- null for hand-picked; a saved filter for self-filling

collection_copies         -- hand-picked membership only; a copy can sit in several
  collection_id, copy_id

goals
  id, user_id, kind       -- every_pokemon | set | pokemon | artist
  target                  -- set ID, dex number, or illustrator name
  level                   -- set goals: numbered | with_secrets | master

binders
  id, user_id, name, rows, cols, page_count

binder_slots              -- one row per filled pocket
  binder_id, page, position
  copy_id -> copies.id    -- an owned card, or
  want_card_id, want_variant_id   -- a placeholder for a card not owned yet, or
  art_id, art_tile        -- one tile of a Michi art image

binder_art                -- an uploaded image and the block of slots it spans
  id, user_id, binder_id, page, first_position, rows, cols, image_path

groups                    -- a family group
  id, name

group_members
  group_id, user_id, role -- owner | member

wishlist_items
  id, user_id, card_id
  variant_id, language    -- optional; null means any
  priority, note, created_at

openings                  -- a logged pack opening
  id, user_id, product, set_id, pack_count, cost, currency, opened_at

price_snapshots
  card_id, variant_id, language, condition, source, price, currency, captured_at
```

There is no "all cards" collection and no trade collection: both are queries over `copies`
(section 3). Self-filling collections and goals are queries too; only their definitions are
stored.

Note the natural key that identifies a card independent of any API:
`set_code + collector_number + language + condition + variant`.
Carry it in exports so hand-built CSVs still match without a UUID.

## 5. Catalog: TCGdex Coverage

Checked against `https://api.tcgdex.net/v2/<language>/sets` on 2026-10-01.

| Language | API code | Sets | Notes |
| --- | --- | --- | --- |
| English | `en` | 220 | Through 30th Celebration (`30th`). |
| Portuguese | `pt` | 125 | Through Celebração de 30 Anos, with Portuguese images. Use `pt`, not `pt-br`, which lists only 11 sets. |
| French | `fr` | 202 | |
| Japanese | `ja` | 184 | Includes M4 and M6 complete, with prices. |
| Korean | `ko` | 95 | Stops at the SV5 sets. No Mega-era Korean sets. |
| Chinese (Simplified) | `zh-cn` | 57 | |
| Chinese (Traditional) | `zh-tw` | 98 | |

Gaps that affect Eric's own collection, and the fallback for each:

| Gap | Cards affected | Fallback |
| --- | --- | --- |
| Vintage Portuguese sets are listed with no cards (`pt/sets/base1` reports 102 official cards, lists 0). | 74 PT WotC-era cards | Use the English card record with a PT copy. Same set and number. |
| Korean has no Mega-era sets. | 55 KR cards (M4, M6) | Korean sets use the Japanese set codes (monprice IDs `M4_kr_*`, `M6_kr_*` match Japanese `M4`, `M6`). Use the Japanese card record with a KO copy. |
| Japanese S4a (Shiny Star V) is listed with 0 of 190 cards. | 1 KR card | Manual entry. |
| Simplified Chinese Gem Pack Vol. 4 (`CBB4C`) is listed with 0 of 7 cards. | 4 CHS cards | Manual entry. |

The fallback rule in general: when the copy's language has no catalog record, match the card in
the catalog it was printed from (English for international prints, Japanese for Korean), keep the
copy's real language, and show the fallback's name and image.

## 6. Card Identification

Three approaches, expected to be combined:

1. **OCR the collector number** (bottom-left, e.g. `123/165`) plus the card name, then look up in
   the catalog. Set code plus number is a near-unique key. Cheap, runs client-side with
   Tesseract.js.
2. **Vision model on the captured frame**, via a small backend holding the API key. Least code,
   handles angles and partial occlusion well, fractions of a cent per scan.
3. **Perceptual hash / embedding match** against a prebuilt index of card art. Best for worn or
   foreign-language cards, but requires building and shipping the index.

Likely hybrid: OCR for the collector number, vision model for the set symbol and edition stamp.

**Language detection is now a requirement, not a convenience** (section 3). Script detection
separates Japanese, Korean, and Chinese outright. Among the Latin-script languages, language
detection over the attack and ability text separates Portuguese from English and French. The
result is a proposal on the confirm screen, never a silent save.

**The confirm screen** shows the matched card, the detected language, the variant, and, when the
card is already owned, the duplicate prompt. One tap saves. In a batch session, the same details
appear on each tray card instead, and the session is confirmed as a whole (section 3).

**Scan safety.** Wrong data saved silently is the failure this app exists to stop, so:

- Every match carries a confidence. A low-confidence card is flagged in the tray and needs a tap
  before the session can save. It is never saved on a guess.
- A whole session can be corrected at once: "this session was all Korean", or "all reverse holo".
- The last save can be undone from a banner until the next scan starts.

**Known hard parts:**

- Holo glare wrecks OCR.
- Variants are the real problem. 1st Edition vs Shadowless vs Unlimited, or reverse holo vs normal
  print, are the same artwork and the same collector number but very different cards. All three
  approaches will confidently return the wrong one. Distinguishing them needs the set symbol and
  edition stamp specifically. Eric owns 135 reverse holos and 4 first editions, so this is not an
  edge case. Recent sets add Poké Ball and Master Ball reverse holos, the same card again with a
  different foil pattern.
- Asian prints are numbered within their own sets, so a Korean `81/120` is looked up in the
  Japanese-code set, not an international one.

## 7. Importing From monprice

The existing collection comes from monprice's export, which has two formats with the same rows.
Checked against the 2026-10-01 export of the `Todas` collection: 1,414 rows, 1,611 copies, 90
sets, back to Base Set.

- **CSV:** semicolon-delimited, decimal comma (`0,37`). Columns: `ID`, `Name`, `Number`, `Set`,
  `Series`, `Rarity`, `HP`, `Type`, `Artist`, `Release Date`, `Average Price`, `Count`,
  `Finish Type`, `Reverse Holo`, `Language`.
- **JSON:** an object with `pokemon` and `mtg` arrays. Each entry has `id`, `name`, `number`,
  `set`, `series`, `rarity`, `hp`, `type`, `artist`, `releaseDate`, `averagePrice`, `count`,
  `finishType`, `lang`.
- **IDs:** `<monprice set code>_<int|kr|chs|jp>_<number>`. monprice set codes are not TCGdex
  set IDs (monprice `CRI` is TCGdex `me04`, Chaos Rising), so map sets by name and release date,
  then cards by number.
- **Languages present:** PT 1,239, EN 111, KR 56, CHS 4, JA 3, FR 1.
- **Finish types present:** `NORMAL`, `HOLOFOIL`, `REVERSE_HOLOFOIL`, `UNLIMITED`,
  `FIRST_EDITION`, `UNLIMITED_HOLOFOIL`. Map each to the card's TCGdex variant ID. monprice has no
  ball-pattern finish, so an imported reverse holo is the plain reverse until edited.
- **Count** becomes `quantity`. 91 rows have a count above 1, so the Trade view starts populated.
- **Not in the export:** condition, purchase price, and collection membership. Rebuild a
  collection such as Star by exporting it from monprice separately and importing that file as
  tags on copies that already exist. `Todas` itself is not imported as a collection, because
  owning is the base set.

## 8. Persistence and Auth

Recommended stack: **Supabase** (Postgres, auth, row-level security, file storage on one free
tier). Firebase is an equivalent alternative.

- Client writes to IndexedDB first, flushes to Supabase when online.
- Auth by magic link or Google. No passwords. One account per person (section 3).
- Row-level security on `user_id` from the start, on every user-owned table: write when you own
  the row, read when you own it or share a group with its owner (section 3). The catalog,
  localizations, cached images, and price snapshots are readable by every signed-in user.
- Own photos and cached card images need blob storage and will dominate storage size. Server
  storage holds only owned-card images and uploads (section 3).
- **Price history requires something always-on.** A current price can be fetched on demand, but a
  chart of collection value over the last year needs a scheduled job writing snapshots nightly
  whether or not the app is open. This is the one piece that needs more than a database.

**Hosting: an installable web app (PWA) on GitHub Pages, with Supabase behind it.** *(Decided by
Eric, 2026-10-01.)* Free, shared by link instead of an app store, and one codebase for every
family phone. If the web camera proves too weak for batch scanning, wrap the same code as a
native app with Capacitor rather than rewriting.

Facts this rests on, checked 2026-10-01 against published sources:

- Supabase free tier: 500 MB database, 1 GB file storage, and projects pause after 7 days without
  activity. A nightly price job (a scheduled GitHub Actions run or Supabase cron) keeps it awake.
- iOS home-screen web apps can use the camera (`getUserMedia`, since iOS 13), but drop the camera
  permission whenever the URL hash changes. Route with real paths, never `#` links, or iPhone
  users are asked for the camera again and again. GitHub Pages has no fallback for app routes,
  so real paths need a `404.html` that redirects into the app.
- Anything holding a secret (a vision-model API key) cannot live on GitHub Pages. It goes in a
  Supabase Edge Function.

## 9. Export

**CSV**, one row per copy, flat.

- Every row carries the copy UUID. On import: known UUID updates, missing UUID creates.
  Without this, every re-import silently duplicates the entire collection. This is the single most
  common way this feature goes wrong.
- Import modes: **merge** (default) and **replace everything** (loud confirmation).
- Also carry the natural key so externally authored CSVs match without a UUID.
- Collections in one column, semicolon separated: `Favorites;Vintage Holos;For Trade`.
  Import splits on the delimiter and creates any collection that does not exist.

**Gotchas, all cheap to prevent up front:**

- Write UTF-8 **with a BOM**, or Excel mangles every `é` in "Pokémon" and every Portuguese name.
- Quote the card name field. Plenty of card names contain commas.
- Collector numbers are strings. Excel turns `001` into `1` and destroys the keys.
- ISO 8601 dates. Money as decimal plus an explicit `currency` column. BRL and USD will coexist
  in the same file, so a currency column is not optional.

**JSON** export is the lossless backup: collections, price history, photo references, everything.

**Option not yet decided:** match TCGplayer's or Deckbox's existing CSV column shape instead of
inventing one. Buys import from other collection trackers for free, at the cost of awkward columns.

## 10. Pricing

**Source: TCGdex**, which embeds both markets per card. Checked on `en/cards/base1-58` on
2026-10-01:

- **Cardmarket** (EUR): `avg`, `low`, `trend`, and `avg1` / `avg7` / `avg30`, with `-holo`
  versions of each.
- **TCGplayer** (USD), per variant: `lowPrice`, `midPrice`, `highPrice`, `marketPrice`,
  `directLowPrice`.

The 1, 7, and 30 day averages give a trend without running a snapshot job. BRL comes from a
daily exchange rate; the pokedex already converts with frankfurter.dev.

**Per-variant prices.** Each entry in `variants_detailed` carries its own `pricing` (checked on
`en/cards/sv08.5-001`, where the Poké Ball and Master Ball reverses have their own products). One
exception seen: Base Set Charizard's 1st Edition Shadowless and plain Shadowless share TCGplayer
product `106999`, so the price may not separate them.

**No graded prices.** TCGdex carries no PSA, CGC, or BGS data (no grade field on `base1-4` or
`sv08.5-001`). A graded copy's value is entered by hand into `graded_price`.

**The language gap.** Portuguese and Japanese card records also carry `pricing`, but it has not
been checked whether those prices are for that printing or are the English market price
repeated. Until it is, show prices as a reference labeled with their market. Brazilian pricing
largely lives on Brazilian marketplaces such as Liga Pokémon rather than in a drop-in API.

Three ways to handle it, all supported by the `price_snapshots` schema, and they can coexist:

1. Show the market price, clearly labeled with the market it comes from.
2. Prefer Cardmarket where it covers the language.
3. Manual entry with a source note.

Consequence: the collection total must be honest about which parts are estimated.

## 11. Collecting Features

### Goals

| Goal | Target | Done when |
| --- | --- | --- |
| Every Pokémon | National Dex 1 to 1,025 | At least one card owned whose `dex_ids` includes each number |
| Set, numbered | One set | Every card up to the set's official count (TCGdex `cardCount.official`) |
| Set, with secrets | One set | Every card in the set, secret rares included (`cardCount.total`) |
| Set, master | One set | Every card in every variant, ball patterns and reverses included |
| One Pokémon | A dex number | Every card of that Pokémon, across all sets |
| One artist | An illustrator | Every card by that illustrator |

Ownership in any language counts, the same rule as the set tile rings. Prismatic Evolutions shows
why the levels matter: 131 official cards, 180 in total, and TCGdex counts 268 reverse-holo variants
including the ball patterns.

Each goal shows a progress ring and a **missing list**. The missing list is sortable like any
other view, can be opened offline in a card shop, and sends any card to the wishlist in one tap.

### Binders

A binder mirrors one real binder: a name, a grid, and a page count. Grids run from 1×1 to 5×4 so
any binder fits; the common ones are 2×2, 3×3, and 3×4. Each slot is one of:

- **An owned card.** A specific copy, placed by tapping the slot and picking from the collection.
- **A placeholder.** A card not owned yet, shown greyed out. When that card is scanned later, the
  confirm screen says where it goes: "Binder 2, page 7, slot 4".
- **Michi art.** One tile of an image spread across several slots.
- **Empty on purpose.**

**The Michi method** (after Michi, @peeplop on Instagram) treats a page as one picture instead of
a grid: an illustration sliced into tiles around one or two featured cards, with art standing in
for cards in the other pockets. The app supports it by letting an uploaded image span a block of
slots, slicing it to the grid, and exporting print-ready inserts. Specs from the binder community
guides (not verified here): a pocket insert is 67 × 96 mm, a 3×3 page prints on A4, and inserts
are printed at 300 DPI at 100% scale on matte cardstock.

A binder view answers both questions a collector asks: which pages a card is in, and which owned
cards are not in any binder yet.

### Filters and Sorting

Every card list (sets, collections, binders, goals, wishlists, the Trade view) shares one filter
and sort bar.

- **Filter by:** set, series, language, rarity, type, Pokémon, artist, variant, condition, price
  range, collection, binder (placed or not), goal (missing from), owned or not, duplicates only.
- **Sort by:** price, rarity, date added (newest or oldest first), set release date, collector
  number, name, National Dex number.

### Pack Openings

An opening is a batch scan session with a product attached: "10 packs of Celebração de 30 Anos,
R$300". Every copy saved in it remembers the opening, so the opening shows what it cost against
what it pulled at today's prices, and the best pull.

## 12. Open Questions

- Does Trade count extras per card, or per card and language? A PT and an EN copy of the same
  card may both be keepers.
- **Deferred by Eric, 2026-10-01: trade matching.** Show "you have spares of 12 cards on your
  brother's wishlist" and the reverse. Wishlists and the group model are designed so this needs no
  schema change later.
- Value-over-time chart? The 1/7/30 day averages may be enough; a longer chart is the main fork
  in how much backend is needed (section 8).
- Phone only, or a real desktop view for bulk editing and binder layout? CSV round-trip partly
  covers the former; the Michi layout is easier on a big screen.
- Store own photos of cards, or rely on catalog artwork only?
- Invent the CSV column spec, or adopt TCGplayer's / Deckbox's?

## 13. Verify Before Building

Claims in this document that were reasoned about but not checked against source:

- Whether TCGdex `pricing` on a non-English card describes that printing (section 10).
- That Korean sets always reuse the Japanese set code and numbering. True for M4 and M6 in
  Eric's export; not checked for other sets.
- TCGdex rate limits and terms for caching images.
- That `variants_detailed` is filled in consistently across sets. Checked on two cards only
  (`sv08.5-001`, `base1-4`).
- The Michi insert dimensions and print settings in section 11, taken from community guides.
- Whether the rarity values in a Star rule cover every era's naming (TCGdex lists 42 rarity
  values, including `Illustration rare` and `Special illustration rare`).
- Current TCGplayer API access model, only if TCGdex pricing falls short. Historically
  partner-gated rather than open signup. Do not design around having a key until confirmed.
- Exact TCGplayer CSV column spec, if adopting it.
- What a Brazilian card's copyright line actually reads, as an OCR anchor for language detection.

Checked 2026-10-01 and recorded above: TCGdex language coverage and gaps (section 5), pricing
fields, per-variant prices, and the absence of graded data (section 10), variant detail
including ball patterns and vintage editions (section 3), rarity values and `dex_ids` (sections 3
and 4), the `assets.tcgdex.net` outage (section 3), and the monprice export format (section 7).
pokemontcg.io is no longer the catalog, so its open questions are dropped.

## 14. Suggested Build Order

1. Schema and auth in Supabase, with several accounts and a family group working from the start.
   Manual card entry only, no camera.
2. CSV export and import, including the UUID round-trip. Early, because it is the backup.
3. monprice import, using the mapping in section 7. Proves the catalog matching on 1,414 real
   rows before the scanner depends on it.
4. Catalog browsing per language against TCGdex, with image caching. Cache into `cards`,
   `card_variants`, and `card_localizations`.
5. Collections (hand-picked and self-filling), favorites, the shared filter and sort bar,
   duplicates, and the Trade view.
6. Goals with missing lists, wishlists, and browsing a family member's cards.
7. Binders: grids, placing cards and placeholders, then Michi art and print export.
8. Camera capture plus OCR of the collector number, language detection, the confirm screen, scan
   safety, and the batch session tray. Pack openings ride on the session.
   The scanner is the fun part but the least load-bearing: everything works without it, just
   slower to enter cards.
9. Vision-model fallback for variants and set symbols.
10. Pricing display, then price snapshots if the value chart is wanted.
