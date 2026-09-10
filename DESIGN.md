# Pokémon Card Collection Tracker

Personal collection tracker. Point a phone camera at a card, identify it, store it,
organize it into collections, and see what it is worth.

Status: design only, nothing built. Last updated 2026-09-10.

## 1. Scope

What it does:

- Identify a physical card by pointing a phone camera at it.
- Store owned cards, with the details that vary copy to copy (language, condition, quantity).
- Filter and search by type, rarity, set, language, price, collection membership.
- Group cards into user-defined collections. A card can belong to more than one.
- Mark favorites.
- Look up current market price.
- Export and import CSV, both for backup and for bulk editing in a spreadsheet.

Single user (private collection), but built so a second user would not require a redesign.

## 2. Decisions and Why

These were settled in discussion. The reasoning matters more than the conclusion, so it is
recorded here rather than just the outcome.

**Card identity and card copy are separate tables.**
A Brazilian Charizard and an American Charizard share artwork, collector number, and set symbol.
Only the printed text differs. So language is a property of *your copy*, not of the card. If the
catalog ID is the only key, the two copies collapse into one row and the distinction is lost.
Everything downstream (filters, pricing, CSV) depends on this split.

**Language is a flag on the copy, not a separate card record.**
Deliberate simplification. The stored artwork and text will be the English printing even for a
Portuguese card, so the record is not perfectly faithful to the physical object. For a private
tracker that is an acceptable trade, and it avoids sourcing a multi-language card catalog that
may not exist in any free API.

**Local-first with an offline write queue, server as source of truth.**
Scanning happens in card shops and at events, where reception is bad. An app that needs a live
connection to log a card is an app you stop using. Writes land in IndexedDB immediately and flush
when there is signal.

**No sync engine. Last-write-wins per row.**
One user, one or two devices. Real conflict resolution is not worth the complexity.

**Login exists for backup and cross-device, not for identity.**
Magic link or Google sign-in. No password. Tables carry `user_id` with row-level security from
day one because retrofitting it is miserable.

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

## 3. Data Model

Sketch, not final DDL.

```
cards                     -- shared catalog, cached from the API, not user-specific
  id                      -- catalog ID (pokemontcg.io)
  tcgplayer_product_id    -- stable external key, store even if unused at first
  set_code
  set_name
  collector_number        -- STRING, never a number. "001" must not become 1.
  name
  types[]
  rarity
  artwork_url

copies                    -- the cards you actually own
  id                      -- UUID. Load-bearing: this is what makes CSV re-import safe.
  user_id
  card_id  -> cards.id
  language                -- EN, PT-BR, JA, FR, DE, IT, ES, ...
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

Note the natural key that identifies a card independent of any API:
`set_code + collector_number + language + condition + variant`.
Carry it in exports so hand-built CSVs still match without a UUID.

## 4. Card Identification

Three approaches, expected to be combined:

1. **OCR the collector number** (bottom-left, e.g. `123/165`) plus the card name, then look up in
   the Pokémon TCG API. Set code plus number is a near-unique key. Cheap, runs client-side with
   Tesseract.js.
2. **Vision model on the captured frame**, via a small backend holding the API key. Least code,
   handles angles and partial occlusion well, fractions of a cent per scan.
3. **Perceptual hash / embedding match** against a prebuilt index of card art. Best for worn or
   foreign-language cards, but requires building and shipping the index.

Likely hybrid: OCR for the collector number, vision model for the set symbol and edition stamp.

**Known hard parts:**

- Holo glare wrecks OCR.
- Variants are the real problem. 1st Edition vs Shadowless vs Unlimited, or reverse holo vs normal
  print, are the same artwork and the same collector number but very different cards. All three
  approaches will confidently return the wrong one. Distinguishing them needs the set symbol and
  edition stamp specifically.
- Language detection is the easy part: run language detect over the OCR'd attack text. Portuguese
  vs English is unmistakable. Japanese is easier still (different script, different set numbering).

## 5. Persistence and Auth

Recommended stack: **Supabase** (Postgres, auth, row-level security, file storage on one free
tier). Firebase is an equivalent alternative.

- Client writes to IndexedDB first, flushes to Supabase when online.
- Auth by magic link or Google. No passwords.
- Row-level security on `user_id` from the start.
- Own photos need blob storage and will dominate storage size. Cheap now, annoying to add later.
- **Price history requires something always-on.** A current price can be fetched on demand, but a
  chart of collection value over the last year needs a scheduled job writing snapshots nightly
  whether or not the app is open. This is the one piece that needs more than a database.

## 6. Import and Export

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

## 7. Pricing

**Primary source: pokemontcg.io**, which embeds TCGplayer prices (US market) and Cardmarket prices
(European market) per card and per variant. If that holds, the TCGplayer API is not needed at all,
which avoids its approval process, rate limits, and data-retention terms.

**The language gap.** TCGplayer indexes the English market. Portuguese copies will resolve to a
card record and a TCGplayer price that is for the *English* printing, not for the copy owned.
Brazilian pricing largely lives on Brazilian marketplaces such as Liga Pokémon rather than in a
drop-in API.

Three ways to handle it, all supported by the `price_snapshots` schema, and they can coexist:

1. Show the English price, clearly labeled as a reference for the English printing.
2. Fall back to Cardmarket where it covers the language.
3. Manual entry with a source note.

Consequence: the collection total must be honest about which parts are estimated.

## 8. Open Questions

- Value-over-time chart? This is the main fork in how much backend is needed (see section 5).
- Phone only, or a real desktop view for bulk editing? CSV round-trip partly covers the latter.
- Store own photos of cards, or rely on catalog artwork only?
- Invent the CSV column spec, or adopt TCGplayer's / Deckbox's?

## 9. Verify Before Building

Claims in this document that were reasoned about but not checked against source:

- Does pokemontcg.io still expose TCGplayer pricing per card and per variant? The whole pricing
  design leans on this.
- Does pokemontcg.io expose any non-English printings? Assumed English-only.
- Current TCGplayer API access model. Historically partner-gated rather than open signup; current
  state unknown. Do not design around having a key until confirmed.
- Exact TCGplayer CSV column spec, if adopting it.
- What a Brazilian card's copyright line actually reads, as an OCR anchor for language detection.

## 10. Suggested Build Order

1. Schema and auth in Supabase. Manual card entry only, no camera.
2. CSV export and import, including the UUID round-trip. Early, because it is the backup.
3. Catalog lookup and search against pokemontcg.io. Cache into `cards`.
4. Collections, favorites, filtering.
5. Camera capture plus OCR of the collector number. The scanner is the fun part but the least
   load-bearing: everything works without it, just slower to enter cards.
6. Vision-model fallback for variants and set symbols.
7. Pricing display, then price snapshots if the value chart is wanted.
