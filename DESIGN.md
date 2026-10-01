# Pokémon Card Collection Tracker

Personal collection tracker. Point a phone camera at a card, identify it, store it,
organize it into collections, and see what it is worth.

Status: design only, nothing built. Last updated 2026-10-01.

## 1. Scope

What it does:

- Identify a physical card by pointing a phone camera at it, including which language it is
  printed in.
- Browse every set and expansion in each language the catalog covers, back to the first
  editions: English, Portuguese, Japanese, Chinese, and Korean at least, French and the others
  when present. Owned cards show as owned in every language view.
- Store owned cards, with the details that vary copy to copy (language, condition, variant,
  quantity).
- Filter and search by type, rarity, set, language, price, collection membership.
- Group cards into user-defined collections (for example, a Star collection for SIRs and IRs).
  A card can belong to more than one.
- Scan cards one at a time or in a batch session, assigning a whole session to collections at once.
- Flag duplicates at scan time and keep a Trade view of the extras.
- Mark favorites.
- Look up current market price and its trend.
- Export and import CSV, both for backup and for bulk editing in a spreadsheet.
- Import the existing collection from monprice (section 7).
- Separate accounts: Eric and his wife each sign in on their own phone and keep their own
  collection.

Out of scope: a portfolio view. monprice has one and it goes unused.

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
first time it is shown.

**Local-first with an offline write queue, server as source of truth.**
Scanning happens in card shops and at events, where reception is bad. An app that needs a live
connection to log a card is an app you stop using. Writes land in IndexedDB immediately and flush
when there is signal.

**No sync engine. Last-write-wins per row.**
Each collection has one owner on one or two devices. Real conflict resolution is not worth the
complexity.

**One account per person, each with a private collection.**
Eric and his wife each sign in on their own phone. Copies, collections, and the Trade view belong
to a user. The card catalog, cached images, and prices are shared, because they describe cards,
not anyone's ownership. Magic link or Google sign-in, no passwords. Every user-owned table carries
`user_id` with row-level security from day one, because retrofitting it is miserable.
*(Revised 2026-10-01. The first version was single-user and only built to allow a second.)*

**Adopt TCGplayer's condition and variant vocabulary verbatim.**
Near Mint / Lightly Played / Moderately Played / Heavily Played / Damaged is the de facto standard
for English cards. Using it as-is means the condition field lines up with the price being fetched
instead of needing a translation table.

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
  rarity
  variants[]              -- TCGdex: normal, holo, reverse, firstEdition, wPromo

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
  variant                 -- normal | holofoil | reverse_holofoil | first_edition | ...
  quantity
  purchase_price
  purchase_currency
  notes
  is_favorite
  photo_url               -- optional, own photo for condition documentation
  created_at / updated_at

collections
  id, user_id, name, description

collection_copies         -- many-to-many; a copy can sit in several collections
  collection_id, copy_id

price_snapshots
  card_id, language, condition, variant, source, price, currency, captured_at
```

There is no "all cards" collection and no trade collection: both are queries over `copies`
(section 3).

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

**Known hard parts:**

- Holo glare wrecks OCR.
- Variants are the real problem. 1st Edition vs Shadowless vs Unlimited, or reverse holo vs normal
  print, are the same artwork and the same collector number but very different cards. All three
  approaches will confidently return the wrong one. Distinguishing them needs the set symbol and
  edition stamp specifically. Eric owns 135 reverse holos and 4 first editions, so this is not an
  edge case.
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
  `FIRST_EDITION`, `UNLIMITED_HOLOFOIL`. Map each to the variant vocabulary.
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
- Row-level security on `user_id` from the start, on every user-owned table. The catalog,
  localizations, cached images, and price snapshots are readable by every signed-in user.
- Own photos and cached card images need blob storage and will dominate storage size. Cheap now,
  annoying to add later.
- **Price history requires something always-on.** A current price can be fetched on demand, but a
  chart of collection value over the last year needs a scheduled job writing snapshots nightly
  whether or not the app is open. This is the one piece that needs more than a database.

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

**The language gap.** Portuguese and Japanese card records also carry `pricing`, but it has not
been checked whether those prices are for that printing or are the English market price
repeated. Until it is, show prices as a reference labeled with their market. Brazilian pricing
largely lives on Brazilian marketplaces such as Liga Pokémon rather than in a drop-in API.

Three ways to handle it, all supported by the `price_snapshots` schema, and they can coexist:

1. Show the market price, clearly labeled with the market it comes from.
2. Prefer Cardmarket where it covers the language.
3. Manual entry with a source note.

Consequence: the collection total must be honest about which parts are estimated.

## 11. Open Questions

- Does Trade count extras per card, or per card and language? A PT and an EN copy of the same
  card may both be keepers.
- Can the two accounts see each other's collection or Trade view, for trading within the
  household? Default until decided: fully private.
- Value-over-time chart? The 1/7/30 day averages may be enough; a longer chart is the main fork
  in how much backend is needed (section 8).
- Phone only, or a real desktop view for bulk editing? CSV round-trip partly covers the latter.
- Store own photos of cards, or rely on catalog artwork only?
- Invent the CSV column spec, or adopt TCGplayer's / Deckbox's?

## 12. Verify Before Building

Claims in this document that were reasoned about but not checked against source:

- Whether TCGdex `pricing` on a non-English card describes that printing (section 10).
- That Korean sets always reuse the Japanese set code and numbering. True for M4 and M6 in
  Eric's export; not checked for other sets.
- TCGdex rate limits and terms for caching images.
- How reliably variant data (`variants`) distinguishes 1st Edition, Shadowless, and Unlimited
  for WotC sets.
- Current TCGplayer API access model, only if TCGdex pricing falls short. Historically
  partner-gated rather than open signup. Do not design around having a key until confirmed.
- Exact TCGplayer CSV column spec, if adopting it.
- What a Brazilian card's copyright line actually reads, as an OCR anchor for language detection.

Checked 2026-10-01 and recorded above: TCGdex language coverage and gaps (section 5), TCGdex
pricing fields (section 10), the `assets.tcgdex.net` outage (section 3), and the monprice export
format (section 7). pokemontcg.io is no longer the catalog, so its open questions are dropped.

## 13. Suggested Build Order

1. Schema and auth in Supabase, with two accounts working from the start. Manual card entry
   only, no camera.
2. CSV export and import, including the UUID round-trip. Early, because it is the backup.
3. monprice import, using the mapping in section 7. Proves the catalog matching on 1,414 real
   rows before the scanner depends on it.
4. Catalog browsing per language against TCGdex, with image caching. Cache into `cards` and
   `card_localizations`.
5. Collections, favorites, filtering, duplicates, and the Trade view.
6. Camera capture plus OCR of the collector number, language detection, the confirm screen, and
   the batch session tray.
   The scanner is the fun part but the least load-bearing: everything works without it, just
   slower to enter cards.
7. Vision-model fallback for variants and set symbols.
8. Pricing display, then price snapshots if the value chart is wanted.
