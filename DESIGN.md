# Pokémon Card Collection Tracker

Personal collection tracker. Point a phone camera at a card, identify it, store it,
organize it into collections, and see what it is worth.

Status: phone spike and catalog browser live; no accounts yet. Last updated 2026-10-01.

**Constraint: no paid services, ever.** Every piece runs on a free tier or a free API: GitHub Pages,
TCGdex, the Supabase free tier, on-device OCR, and frankfurter.dev for exchange rates. A feature
that needs a paid service is out of scope until Eric decides otherwise. *(Decided by Eric,
2026-10-01.)*

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
- Store owned cards, one entry per physical card, with the details that vary copy to copy
  (language, condition, variant).
- Filter, search, and sort by price, rarity, date added, set, language, and the rest of the list
  in section 11.
- Group cards into collections, either hand-picked or self-filling from a rule (a Star collection
  that collects every SIR and IR on its own). A card can belong to more than one.
- Track goals: one card of every Pokémon, a set completed at three levels up to a master set, or
  everything of one Pokémon or one artist. Each goal has a missing list.
- Lay out physical binders: pick a grid, place a card in each slot, spread Michi-method art across
  several slots, print the inserts, and always know which binder page a card is in. Each binder has
  notes and a cover color, so it matches the one on the shelf.
- Pick a color theme, one per Pokémon type, with panel frames inspired by the selectable text box
  styles in the games.
- Log pack openings, with what they cost against what they pulled.
- Scan cards one at a time or in a batch session, assigning a whole session to collections at once.
- Flag duplicates at scan time and keep a Trade view of the extras.
- Mark favorites.
- Look up current market price and its trend.
- Export and import CSV, both for backup and for bulk editing in a spreadsheet.
- Import the existing collection from monprice (section 7).
- Separate accounts for a small number of invited users, each
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

**Card identity and card copy are separate records.**
A Brazilian Charizard and an American Charizard share artwork, collector number, and set symbol.
Only the printed text differs. So language is a property of *your copy*, not of the card. If the
catalog ID is the only key, the two copies collapse into one record and the distinction is lost.
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
The screen says `Viewing:` for the display language and `Printed in:` for a card's own language,
so the two never read as the same setting. Each card stores its localized name, set name, and image per language when the catalog has them,
falling back to English. Ownership is computed from copies regardless of language, so a PT copy
shows as owned in the EN view, labeled "owned in PT".

**Owning is the base set; collections are tags on top.**
Every saved copy is in the collection automatically. Collections like Star are optional tags. No
"All" collection exists, because nothing needs one.

**Totals count copies, never memberships.**
Collection value and card counts sum over card entries, never over collection membership. A card
in three collections counts once.

**Duplicates are caught at scan time; Trade is a derived view.**
A single scan of a card already owned asks "You have 1 (PT, holo). Add another?" before saving.
Trade is a query, not a stored collection, so it stays correct after a card is traded away
without anyone remembering to update it. A spare is every copy beyond the first of the same card
in the same language: a PT and an EN copy are both keepers, while a second PT copy is a spare
whatever its variant. *(Decided by Eric, 2026-10-01.)* In Eric's export that is 276 spares across 165 cards.

**Every scan is a session; there is no single or batch mode.**
One scan opens the confirm sheet with the duplicate prompt. "Scan next" drops that card into the
tray and keeps scanning, so a session of one and a session of fifty are the same flow. A mode you
can forget is monprice's language bug in another form. "Discard" closes a scan with nothing
saved, which doubles as the "do I already own this?" check in a shop. *(Decided by Eric, 2026-10-01.)*

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
monprice's `xN` beside the card is easy to miss. Any card image standing for a card owned more
than once (in that language) carries a badge in its top-right corner (`×3`), in grids, collections, the Trade view, and
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

**Each person's cards are one JSON document, merged entry by entry.**
Everything a person owns or arranges (card entries, collections, goals, binders, wishlist,
openings) is one JSON document, the same idea as monprice's export. The phone loads it whole,
keeps it in IndexedDB, and does all filtering, goals, and binder math locally, which is instant at
this size: monprice's JSON for 1,414 rows is 622 KB. Saving merges entry by entry, never the whole
document: every entry has an `id` and an `updated_at`, the newer one wins, and a deletion is kept
as a tombstone (`deleted_at`) so an offline phone cannot bring a deleted card back. No sync engine
and no real conflict resolution; one owner on one or two devices does not need it. *(Decided by Eric, 2026-10-01.)* *(Replaces
the relational schema of the first versions.)*

**One physical card, one entry.**
There is no quantity field. Three Pikachu are three entries, each with its own condition, binder
pocket, and history, and the screen groups them back into one tile with a `×3` badge. Two offline
phones that each add the same card produce two entries instead of overwriting each other into one.
*(Decided by Eric, 2026-10-01.)*

**One account per person, any number of people.**
Each invited user signs in on their own phone, and Eric can invite more. Copies,
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

**The finish is picked by hand from the card's real finishes, with no paid AI.**
After a card is identified, a finish picker lists only that card's own printings from
`variants_detailed`: Spinarak from Darkness Ablaze (`swsh3-102`) offers Normal and Reverse holo;
Prismatic Evolutions Pinsir (`sv08.5-003`) offers Normal, Reverse holo, Poké Ball reverse, and
Master Ball reverse. It starts on the plain print for every card and never remembers the last
pick, because a remembered finish is the sticky-language bug again. "Set all" in a session marks a
whole stack at once. There is no paid vision-model fallback for now: a card the phone cannot
identify shows its top candidates and the user taps one. *(Decided by Eric, 2026-10-01.)*

**Collections are hand-picked or self-filling.**
A self-filling collection is a saved filter: Star is "rarity is `Illustration rare` or
`Special illustration rare`", and it fills itself as cards are saved. Rules match on TCGdex's
English values, because localized records translate them (a Portuguese common reads `Comum`). A
hand-picked collection works as today. Either kind is just a view over the card entries, so neither
changes the totals.

**Goals are their own feature, not collections.**
A collection holds cards you have; a goal measures cards you want against cards you have, and
its most useful output is the missing list. Kinds: one of every Pokémon, a set (three levels), one
Pokémon, one artist. Section 11 has the details.

**A binder is a physical place, so a copy sits in at most one slot.**
Collections are tags and can overlap; a binder slot is a real pocket. Each slot holds one
physical card, and each card entry sits in at most one slot. That rule is what makes "where is
this card?" answerable, and it shows unplaced cards for free.

**Two export formats, not one.**
CSV cannot losslessly hold binders, goals, and photo references, so a CSV "backup" silently drops
data. CSV is for portability and spreadsheet editing. The JSON export is the person's document
exactly as stored, which makes it the real backup.

**CSV round-trip doubles as the bulk-edit surface.**
Fixing twenty mislabeled languages in a spreadsheet and re-importing partly removes the need for
a dedicated desktop bulk-edit view.

**Navigation follows the staff design review.** Five tabs, Cards, Sets, Scan (raised in the
center), Binders, and Lists (Checklists and Wishlist as two segments), with Profile behind a
header avatar holding themes, favorite Pokémon, import and export, Phone check, family, and
sign-in. Family view-only mode is entered from a "Mine" switcher in the header and never
remembered between launches. The full spec is `plans/design-review.md`. *(Approved by Eric,
2026-10-01.)*

**Swipe between cards in the list you came from** (Eric, 2026-10-01; monprice cannot). A card page
opened from a list (My Cards, a set, a checklist, a binder, a wishlist, or search results) keeps
that list, in its current order and filters, as context. Swiping left or right anywhere on the
page except the image moves to the next or previous card; swiping on the image changes the image
in the carousel. A small position line ("12 of 1,359") and edge arrows do the same for one-handed
use, and the browser back button returns to the list at the same scroll position.

**Sets lists physical cards only.** The TCG Pocket series (digital-only cards) is hidden from the
Sets list. *(Decided by Eric, 2026-10-01.)*

## 4. Data Model

Sketch, not final. Three places hold data.

**The catalog, on each phone.** Fetched from TCGdex and kept in IndexedDB, one download per
language so sets and missing lists work offline in a shop. Nothing about ownership lives here.

```
card
  id                      -- TCGdex card ID, e.g. me01-001, S11-057
  catalog                 -- international | ja | ko | zh-cn | zh-tw
  set_id                  -- TCGdex set ID, e.g. me04, M6
  collector_number        -- STRING, never a number. "001" must not become 1.
  types[], rarity         -- rarity as TCGdex's English value, e.g. "Special illustration rare"
  dex_ids[]               -- National Dex numbers; a list, because TAG TEAM cards hold several
  illustrator
  variants[]              -- from variants_detailed: variantId, type, subtype, foil, stamp[],
                          -- tcgplayer and cardmarket product IDs, pricing
  localizations{}         -- per language: name, set_name, image_url
```

**Each person's document, in Supabase and on their phone.** One JSON document per person
(section 3). Every entry carries `id`, `updated_at`, and `deleted_at` for the merge.

```
{
  "cards": [{                     -- one entry per physical card; no quantity
    "id", "card_id", "variant_id",
    "language", "language_source",        -- scan | manual | import
    "condition",                          -- optional, TCGplayer vocabulary
    "purchase_price", "purchase_currency",
    "opening_id", "storage",              -- storage: free text, e.g. "Bulk box A"
    "grader", "grade", "cert_number", "graded_price",   -- optional; TCGdex has no graded data
    "notes", "is_favorite", "photo_path", "created_at"
  }],
  "collections": [{ "id", "name", "rule", "card_ids": [] }],   -- rule null when hand-picked
  "goals":       [{ "id", "kind", "target", "level", "name", "dex_list", "hand_ticks" }],
                                  -- every_pokemon | region | custom_pokemon | set | pokemon | artist
  "binders":     [{ "id", "name", "notes", "cover_color", "rows", "cols", "page_count",
                    "slots": [{ "page", "position",
                                "entry_id" | "want": {card_id, variant_id} | "art": {art_id, tile} }],
                    "art":   [{ "id", "page", "first_position", "rows", "cols", "image_path" }] }],
  "wishlist":    [{ "id", "card_id", "variant_id", "language", "priority", "note" }],
  "openings":    [{ "id", "product", "set_id", "pack_count", "cost", "currency", "opened_at" }],
  "settings":    { "theme", "favorite_pokemon" }   -- follows the person to every device
}
```

**Supabase tables.** Only what the document cannot hold.

```
profiles        user_id, display_name
groups          id, name
group_members   group_id, user_id, role          -- owner | member; only the owner invites
documents       user_id, doc (jsonb), updated_at -- one row per person
storage bucket  owned-card images and uploads (Michi art, card photos)
```

There is no "all cards" collection and no trade collection: both are computed from `cards`
(section 3). Self-filling collections and goals are computed too; only their definitions are
stored.

Note the natural key that identifies a card independent of any API:
`set_code + collector_number + language + variant`.
Carry it in exports so hand-built CSVs still match without an entry ID.

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

**Measured 2026-10-01 (`pt`):** 125 sets in 12 series, 13,907 cards listed (12,746 with images),
33 sets listing no cards. The set files total 1.45 MB; full card records average 2.2 KB, about
30 MB for every card, roughly 5 MB compressed. So the app caches per set as it is opened rather
than downloading a whole language up front.

**Doubled CORS header on images.** Many `assets.tcgdex.net` images send
`access-control-allow-origin: *` twice (seen on most sampled `pt` and `fr` images, no sampled
`en` card image), which browsers reject as a CORS failure. Images therefore load without
`crossorigin`, and the service worker can only keep those as opaque responses, which Chrome
counts at roughly 9 MB of quota each. The opaque image cache is capped at 100 entries; the
lasting fix is the server-side copy of owned-card images (section 3), or TCGdex fixing the header.

**A second free image source.** About 1,750 English and 1,160 Portuguese TCGdex cards have no
image, mostly promos (`smp`, `swshp`, `mep`, `svp`), trainer kits (`tk`), and subsets such as the
Shiny Vault and Galarian Gallery. pokemontcg.io (free, English only, its own ID scheme such as
`swsh12pt5gg-GG01`) has images for the samples checked: `swsh45sv-SV001`, `smp-SM01`,
`swsh12pt5gg-GG01`, `tk1a-1`. Plan: when TCGdex has no image in the viewing language, use the
TCGdex English image, then pokemontcg.io's, through an ID mapping table. *(Planned 2026-10-01.)*

**Korean and other fallback cards: names from the source, images from the owner.** Japanese
`M4` and `M6` list their cards with no images at all (0 of 113 for `M6`, checked 2026-10-01), and
a fallback record carries the catalog's language, so a Korean copy matched to a Japanese record
showed a Japanese name and no picture. Fix: keep the name and set name the source gives (the
monprice export has the Korean ones, for example `니트로 불꽃 에너지` in `닌자스피너`; the scanner
will have the name it read) on the entry as `name_local` and `set_name_local`, and show them before
any catalog name. For images, no free Korean source was found (TCGdex has none for these sets,
pokemontcg.io is English only, and the official Japanese and Korean card databases have no public
API), so the card's own scan photo becomes its image, stored with the owned-card images. Until
then the tile shows the card back with the Korean name. *(Planned 2026-10-01.)*

**English names for Asian prints, original name underneath** (Eric's idea, 2026-10-01). Japanese,
Korean, and Chinese cards show an English name first and their own-language name in smaller text
under it ("Aerodactyl VSTAR" over "プテラVSTAR"). For Pokémon cards the English name is the English
species name for the card's `dexId` (the checklists already cache all 1,025 English names) plus
the mechanic suffix read off the original name (`ex`, `V`, `VMAX`, `VSTAR`, `GX`, `EX`, and Mega
forms). Trainers and Energy have no `dexId`, so their English name comes only from a confirmed
international twin; until then they show the original name alone. The same English name makes
search work in English and enables the Ver na Liga button for Japanese prints, whose Liga pages
use English names (section 10). *(Planned 2026-10-01.)*

**Romanization in parentheses** (Eric, 2026-10-01). The original-language line carries a reading in
parentheses, so a name with unfamiliar characters can still be read: "プテラVSTAR (Ptera VSTAR)",
"프테라VSTAR (Peutera VSTAR)".

- Japanese Pokémon: PokeAPI's official romaji for the species (`ja-roma`, "Ptera" for Aerodactyl,
  checked 2026-10-01) plus the suffix.
- Japanese Trainers and Energy: Hepburn transliteration of kana, on the device, shown only when
  the name is all kana; names with kanji get no reading until a reading dictionary is added.
- Korean, any card: the Revised Romanization of Korea, computed on the device from the Hangul.
- Chinese: pinyin through a vendored free library, lower priority (no Chinese cards are imported
  yet).

**Where the names come from.** PokeAPI (free, an API) carries every species' official names per
language: `ja`, `ja-hrkt`, `ja-roma`, `ko`, `zh-hans`, `zh-hant`, `en`, and more (Aerodactyl:
プテラ, Ptera, 프테라, 化石翼龙 / 化石翼龍; checked 2026-10-01). So besides `dexId`, the English name
can be found by name: strip the mechanic suffix from the card's own name (a Korean copy's
`프테라VSTAR`) and look up the rest among PokeAPI's names in that language. For Trainers and
Energy, which are not species, Bulbapedia lists card names across languages and has a MediaWiki
API; its content is licensed CC BY-NC-SA, which a personal, non-commercial app can use with
attribution. Build a lookup table from it once, ship it in the app with the credit, and never
query it from each phone. *(Suggested by Eric, 2026-10-01.)*

**International twins for Asian prints: measured 2026-10-01.** A matcher over TCGdex data finds
the English print with the same artwork for a Japanese card. Pokémon must agree on `dexId`, `hp`,
attack count and energy costs, and damage, within a release window of 60 days before to 450
days after the Japanese set; then illustrator, Trainer type, effect-text numbers and keywords,
rarity, and the expected English set score the candidates. On 708 cards from six Japanese sets
that have English counterparts (`M3`, `M4`, `M5`, `S11`, `SV10`, `SV6a`) it gave one confident
twin for 94% (Pokémon 97%, Trainers 85%), and all 304 confident picks with images on both sides
showed the same art. It stays quiet without a twin: `M6` has no English set yet, so only 4 of
Eric's 59 Asian cards match today (54 are `M6`). Recent Japanese to English gaps were 56 to 70
days. No other free, permitted source of Asian card images was found (the official Japanese site
forbids reuse; the official Korean sites return 410; TCGplayer grants no new API access).
**Plan:** confident twins lend their image (labelled as the international print) and, for Trainers
and Energy, their English name; ambiguous ones offer a 2 to 3 image picker; weak ones show
nothing; unmatched cards are rechecked periodically. Restrict English candidates to the `swsh`,
`sv`, and `me` series, since Pocket sets share names and illustrators. *(Measured and planned
2026-10-01; a later block.)*

**Own photos, cropped to the card** (Eric, 2026-10-01). Any card can take the owner's photo,
which then shows in place of a missing catalog image (and documents condition). On card detail,
"Add photo" takes a picture or picks one from the gallery; the app finds the card's four edges,
corrects the perspective into a 63:88 card image, and shows four draggable corner handles to fix
a miss before saving. Everything runs on the phone (edge detection and a homography warp on a
canvas, no paid service). The result is stored as a WebP of about 600 x 840 px (around 80 KB) in a
Supabase storage bucket readable by the family, so the free 1 GB holds over 10,000 photos; it
needs one more setup script for the bucket and its policies. The scanner reuses the same
detection and warp, so scanned cards get their photo for free. Auto-detection is most reliable on
a plain, contrasting background; the corner handles cover the rest. *(Planned 2026-10-01.)*

**Image carousel per card** (Eric, 2026-10-01). Card detail shows every image of the card in a
swipeable carousel with dots underneath, shown only when there is more than one. Order, which is
also the default main image: the official catalog image once TCGdex has it (so it takes over by
itself when it appears), then a confident international twin's image (labelled "International
print"), then the owner's own photos (several allowed, front and back). Each image carries its
source label. "Use as main image" pins any one of them as what tiles show; without a pin, the
first available image in that order is used. Tapping opens the image full screen.

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

Plan: text first (section 3, the finish picker decision). OCR the collector number, set total,
name, and the language label, match them against the catalog as text, and compare images only
against the one or two candidates text finds. No paid vision model for now.

**Language detection is now a requirement, not a convenience** (section 3). Script detection
separates Japanese, Korean, and Chinese outright. Among the Latin-script languages, language
detection over the attack and ability text separates Portuguese from English and French. The
result is a proposal on the confirm screen, never a silent save.

**The confirm screen** shows the matched card, the detected language, the variant, and, when the
card is already owned, the duplicate prompt. One tap saves. In a batch session, the same details
appear on each tray card instead, and the session is confirmed as a whole (section 3).

**Wishlist alert on scan.** When a scanned card is on a family member's wishlist (matching its
variant and language when the wishlist item names them), the confirm sheet and the tray tile show
"<member> wants this card". It also works in the check-only scan that saves nothing, so a scan in
a store answers "does anyone want this?". The family's wishlists are kept on the device for
offline use. *(Requested by Eric, 2026-10-01.)*

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
- **Count** expands into that many entries: 1,414 rows become 1,611 card entries.
- **Prices are not imported.** `Average Price` carries no currency, and all 56 Korean rows have
  no price, so prices come fresh from TCGdex.
- **Rarity is not imported.** 51 rows read `Unknown`, so rules such as Star match on TCGdex's
  rarity instead.
- **A match report and review queue** list every row that did not match automatically, before
  anything is saved.
- **Not in the export:** condition, purchase price, and collection membership. Rebuild a
  collection such as Star by exporting it from monprice separately and importing that file as
  tags on copies that already exist. `Todas` itself is not imported as a collection, because
  owning is the base set.

**First import, 2026-10-01 (built and run on the real export):**

- **Set mapping** uses TCGdex's printed abbreviation: `sets?abbreviation.official=eq:CRI` finds
  `me04`, one request per monprice set code, with a release-date check (without it `TR` maps to
  Team Rocket Returns instead of Team Rocket). Names and dates cover the few codes with no
  abbreviation. `30C` is shared by two sets and is split by printed set size.
- **Result:** 1,398 of 1,414 rows matched automatically, 187 of them through a fallback (the
  expected vintage PT and Korean ones, plus PT sets that list few or no cards, such as `30th` with
  2 of 128). 16 rows need manual entry: the 5 expected, 7 `MEE` rows numbered beyond the 8 cards
  TCGdex lists, and 4 basic energies with letter numbers TCGdex does not list.
- **Finishes:** 133 rows keep their raw finish with no variant ID, mostly where TCGdex's only
  variant ID is the placeholder `"generated"`, which names no printing.
- Entries also carry `catalog` (Japanese and Korean IDs can collide), `fallback`, `import_key`
  (what makes reruns safe), and `finish_raw`. A rerun adds nothing.

## 8. Persistence and Auth

Recommended stack: **Supabase** (Postgres, auth, row-level security, file storage on one free
tier). Firebase is an equivalent alternative.

- The phone writes to its copy of the document in IndexedDB first, and merges with Supabase when
  online (section 3).
- Auth by magic link or Google. No passwords. One account per person, invited by Eric (section 3).
- Row-level security from the start: a person writes only their own `documents` row and storage
  files, and reads their own plus those of anyone sharing a group with them.
- Server storage holds only owned-card images and uploads (section 3); the full catalog's images
  stay on each phone.
- **No price history.** Prices are fetched on demand and the 1/7/30 day averages give the trend,
  so nothing has to run nightly. The value-over-time chart is dropped; it is a portfolio, which
  Eric does not want.

**Hosting: an installable web app (PWA) on GitHub Pages, with Supabase behind it.** *(Decided by
Eric, 2026-10-01.)* Free, shared by link instead of an app store, and one codebase for every
family phone. If the web camera proves too weak for batch scanning, wrap the same code as a
native app with Capacitor rather than rewriting.

Facts this rests on, checked 2026-10-01 against published sources:

- Supabase free tier: 500 MB database, 1 GB file storage, and projects pause after 7 days without
  activity. With no nightly job, a weekly scheduled GitHub Actions request keeps it awake.
- iOS home-screen web apps can use the camera (`getUserMedia`, since iOS 13), but drop the camera
  permission whenever the URL hash changes. Route with real paths, never `#` links, or iPhone
  users are asked for the camera again and again. GitHub Pages has no fallback for app routes,
  so real paths need a `404.html` that redirects into the app.
- Anything holding a secret (a vision-model API key) cannot live on GitHub Pages. It goes in a
  Supabase Edge Function.

**Phone test results** (the weekend-zero spike, live at
`https://ericthmoritsuka.github.io/pokemon-card-tracker/`):

| Phone | Mode | Camera | Torch | Zoom and focus | Storage | Offline reload |
| --- | --- | --- | --- | --- | --- | --- |
| Eric: Android 10, Chrome 154 (2026-10-01) | Installed and browser | Rear, 1080 × 1920 default, up to 3840 × 2160, starts in about 530 ms | Supported; toggle worked installed and in the browser | Zoom 1 to 4; manual, single-shot, and continuous focus | 1,600 entries written in about 220 ms, read in about 20 ms; persistent; 10 GB quota | Passed: with no connection, the installed app opened, wrote 1,600 entries, and counted them back |
| Eric's laptop: Linux, Chrome 154 (2026-10-01) | Browser | Webcam, 1920 × 1080, no rear camera | Not supported | Not supported | 1,600 entries written in 121 ms; persistent; 10 GB quota | Not run |
| An iPhone (optional: every invited user has Android) | | Not run yet | | | | |

Verdict for Android: the PWA does everything weekend zero set out to test. Browser tab and
installed app share one storage on Android. The scanner should ask for more than
the default resolution when reading collector numbers.

## 9. Export

**CSV**, one row per card entry, flat.

- Every row carries the entry ID. On import: a known ID updates, a missing ID creates.
  Without this, every re-import silently duplicates the entire collection. This is the single most
  common way this feature goes wrong.
- Import modes: **merge** (default) and **replace everything** (loud confirmation).
- Also carry the natural key so externally authored CSVs match without an entry ID.
- Hand-picked collections in one column, separated by `|`: `Favorites|Vintage Holos`.
  Import splits on the delimiter and creates any collection that does not exist.

**Gotchas, all cheap to prevent up front:**

- Write UTF-8 **with a BOM**, or Excel mangles every `é` in "Pokémon" and every Portuguese name.
- Quote the card name field. Plenty of card names contain commas.
- Collector numbers are strings. Excel turns `001` into `1` and destroys the keys.
- ISO 8601 dates. Money as decimal plus an explicit `currency` column. BRL and USD will coexist
  in the same file, so a currency column is not optional.

**JSON** export is the person's document as stored: the lossless backup.

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

**Liga Pokémon: a link, not a scraper.** Liga Pokémon (`ligapokemon.com.br`) has the Brazilian
prices Eric wants (lowest NM and average) but no public API, and its `robots.txt` (checked
2026-10-01) asks crawlers to wait 360 seconds between requests, disallows its price history pages,
and blocks one crawler outright; the site sits behind Cloudflare. Collecting its prices
automatically would go against the site's stated wishes, so the app does not. Instead each card
gets a **Ver na Liga** button that opens Liga's own search for that card in the browser, and a
copy can carry a manual price with its source and date ("R$45, Liga, 2026-10-01"). *(Decided
2026-10-01.)*

**Liga's query pattern** (checked by hand in a browser, 2026-10-01): Liga's search is
`https://www.ligapokemon.com.br/?view=cards/search&card=<text>`, and it only lands on one card
when the text is exactly the English card name followed by the number and official set total as
printed, in parentheses. `Rattata (019/165)` opens the 151 Rattata (Liga edition code `MEW`), and
`Charizard (4/102)` opens Base Set Charizard ("Coleção Básica"). Build it from TCGdex: the English
`name`, the card's `localId` exactly as given (zero-padded on modern sets, not on vintage), and the
set's `cardCount.official`. When several editions share that text, Liga shows an edition picker
on the card page. Korean and Japanese prints have no reliable Liga equivalent and get no button
until checked.

**Liga's name rules** (Eric's warning, then checked by hand in a browser, 2026-10-01). Liga
hyphenates every uppercase mechanic suffix that TCGdex writes after a space, and a query with the
space finds nothing at all:

| TCGdex name | Liga name | Checked |
| --- | --- | --- |
| `Charizard EX` | `Charizard-EX (11/106)` | yes |
| `Charizard GX` | `Charizard-GX (20/147)` | yes |
| `Charizard VMAX` | `Charizard-VMAX (20/189)` | yes |
| `Charizard ex` (lowercase, modern and EX era) | `Charizard ex (006/165)`, `Charizard ex (105/112)` | yes |
| `Charizard V`, `Charizard VSTAR` | `Charizard-V`, `Charizard-VSTAR (019/159)` | yes |
| `Charizard V-UNION`, `M Charizard EX`, `Reshiram & Charizard GX` | assumed `-V-UNION`, `M Charizard-EX`, `Reshiram & Charizard-GX` | no |
| `Mega Charizard X ex`, `Radiant Charizard` | unchanged: `Mega Charizard X ex (013/094)`, `Radiant Charizard (001/044)` | yes |
| `Nidoran♀`, `Nidoran♂` | `Nidoran (029/151)`, `Nidoran (032/151)`: the symbol is dropped | yes |
| `Farfetch'd`, `Boss's Orders` | unchanged; trainers by English name (Liga shows "Ordem da Chefia / Boss's Orders") | yes |

So: replace a trailing space before `EX`, `GX`, `V`, `VMAX`, `VSTAR`, or `V-UNION` (uppercase,
whole word, at the end of the name) with a hyphen, leave lowercase `ex` and every other name
alone, and keep the number exactly as TCGdex's `localId` (`20`, `019`, `4` all matched). The
unchecked rows are verified on first real use.

**Numbering exceptions** (checked 2026-10-01):

- Lettered subsets carry the letters on both sides: Crown Zenith `GG44` with an official count of
  70 is `Mewtwo-VSTAR (GG44/GG70)`; `(GG44/70)` finds nothing. The same applies to `TG`.
- Promos take the promo number alone: `Charizard-V (SWSH050)` opens the card (Liga itself lists it
  as `SWSH050/71`, a total TCGdex does not have). A set is a promo set when its TCGdex ID ends in
  `p` or its name contains "Promo".
- Liga also has letter-suffixed numbers such as `019a/170` and `048K/069` for prints outside the
  international sets; these are not generated.

**Languages on Liga** (Eric, then checked 2026-10-01): Portuguese and English prints share one card
page, with flags next to each listing showing its language, so the same query serves both. Asian
prints have their own pages, named the same way with the English name and the Asian set's number:
`Aerodactyl-VSTAR (057/100)` opens the Japanese Lost Abyss page, separate from the international
Lost Origin prints (`093/196`, `199/196`), and a Chinese print appears as `(062/131)` in "Azure
Shadow - Pursuit". TCGdex gives Asian records only their own-language name (`プテラVSTAR`), so the
English name must come from elsewhere: for Pokémon, the English species name for the card's
`dexId` plus the mechanic suffix read off the Asian name; for Trainers and Energy, only from the
international twin (section 5). Until then the button covers international cards only. Whether
Liga lists Korean prints at all is unchecked.

Three ways to handle it, and they can coexist:

1. Show the market price, clearly labeled with the market it comes from.
2. Prefer Cardmarket where it covers the language.
3. Manual entry with a source note.

Consequence: any total shown must be honest about which parts are estimated. Value appears on a
card's detail and an opening's summary, not as a headline total.

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

**Pokémon checklists** (requested by Eric, 2026-10-01). A checklist is a goal over a list of
Pokémon, shown as a list to tick off, and lives in the binder area. Presets cover each region by
National Dex number: Kanto 1 to 151, Johto 152 to 251, Hoenn 252 to 386, Sinnoh 387 to 493, Unova
494 to 649, Kalos 650 to 721, Alola 722 to 809, Galar 810 to 898, Hisui 899 to 905, and Paldea 906
to 1025, plus Every Pokémon. A person can also build their own list by picking Pokémon ("every
Eeveelution"). Each entry is ticked automatically once any owned card's `dex_ids` includes that
number, in any language. A person can also tick one by hand (a card bought but not logged yet);
hand ticks show a different mark from owned ones and never count as owned anywhere else. A
**Missing only** filter works offline, so a store visit shows just the gaps ("#107 Hitmonchan").
A checklist can lay out a binder in Dex order with placeholders for the missing ones, which suits
a "Generations 1 and 2" binder.

Ownership in any language counts, the same rule as the set tile rings. Prismatic Evolutions shows
why the levels matter: 131 official cards, 180 in total, and TCGdex counts 268 reverse-holo variants
including the ball patterns.

Each goal shows a progress ring and a **missing list**. The missing list is sortable like any
other view, can be opened offline in a card shop, and sends any card to the wishlist in one tap.
A missing Pokémon is not a card, so the Every Pokémon goal sends that Pokémon's cheapest card by
default, and a long press picks another.

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

Each binder also carries **notes** (free text, for example "Generations 1 and 2") and a **cover
color**, and the binder list draws each one in its cover color so it is easy to match to the real
binder. *(Requested by Eric, 2026-10-01.)*

**Spreads with a page turn** (Eric, 2026-10-01). A binder opens like a real one: page 1 alone on the
right (the inside cover on the left), then two-page spreads (2 and 3, 4 and 5, ...), and a last
page alone when the count is odd. Swiping or the edge arrows turn the page with a CSS 3D flip
around the spine (the page lifts, a shadow sweeps across, it lands on the other side), with a
crossfade under reduced motion. Depth comes from a spine with rings, a soft shadow where pages
curve into the spine, a slight sheen on the pockets, and the cover color showing at the edges. On
a phone in portrait the spread is an overview and tapping a page zooms into it for placing cards;
in landscape, on tablets, and on laptops the spread is large enough to edit directly. Spreads are
also where Michi art can cross facing pages, which settles that open question. *(Planned
2026-10-01, a block after the shell.)*

A binder view answers both questions a collector asks: which pages a card is in, and which owned
cards are not in any binder yet.

### Themes

A theme picker in settings offers one theme per Pokémon type (Water, Fire, Grass, Electric,
Psychic, Fairy, Dark, Dragon, and the rest of the 18), plus the default. A theme sets the accent
color, a light tint on panels, and a panel frame style inspired by the selectable text box frames
in the games' options menus. The 18 type colors come from the pokedex project's `style.css`, so
the two apps share a palette. *(Requested by Eric, 2026-10-01.)*

- Text on every theme meets WCAG AA contrast; bright types such as Electric and Fairy switch text
  to dark automatically.
- Destructive actions stay red in every theme, so danger never changes color.
- The theme is saved in the person's document (`settings.theme`), so it follows them across
  devices once sync exists; before sign-in it lives on the device.

### Favorite Pokémon

Each person can pick a favorite Pokémon. It becomes their avatar in the family switcher, replaces
the logo in the header while they are signed in, sets the browser tab icon, and suggests the
matching type theme (the person can still pick any theme). Images come from the free PokeAPI
sprite repository the pokedex project already uses. It is stored in the document as
`settings.favorite_pokemon` (a National Dex number), so it follows the person across devices.
*(Requested by Eric, 2026-10-01.)*

The home screen icon cannot change per person: an installed web app takes its icon from the one
static manifest every user shares. Native apps can only switch between icons bundled in advance,
which is not worth a native wrapper here.

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

- **Deferred by Eric, 2026-10-01: trade matching.** Show "you have spares of 12 cards on your
  family member's wishlist" and the reverse. Wishlists and the group model are designed so this needs no
  schema change later.
- The rest of the proposals in `plans/ux-plan.md` section 9 and `plans/product-plan.md` section 8
  that are not decided above (undo duration, removing or trading away a card, condition at scan).
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
- That a paused Supabase free project keeps its data.

Checked 2026-10-01 and recorded above: TCGdex language coverage and gaps (section 5), pricing
fields, per-variant prices, and the absence of graded data (section 10), variant detail
including ball patterns and vintage editions (section 3), rarity values and `dex_ids` (sections 3
and 4), the `assets.tcgdex.net` outage (section 3), and the monprice export format (section 7).
pokemontcg.io is no longer the catalog, so its open questions are dropped.

## 14. Suggested Build Order

Follows the release slices in `plans/product-plan.md`. The scanner is in the first release,
because it fixes the problem that makes monprice worth leaving.

**Weekend zero.** Camera capture and offline IndexedDB writes on every invited user's phone. It
settles the iPhone questions before any feature work.

**First release (switch from monprice):**

1. Sign-in for Eric, the per-person document, and the entry-by-entry merge.
2. Catalog download per language from TCGdex, with image caching.
3. monprice import with the match report and review queue; CSV export.
4. The scanner: sessions, the tray, language per card, the confidence gate, duplicates, undo.
5. Set browser with owned rings across languages, search, filter and sort, the Trade view, the
   Star rule and hand-picked collections, prices labeled by market.

**v1.1:** invites, family browsing, wishlists, CSV re-import, the full filter bar, type themes, favorite Pokémon.

**v1.2:** goals with missing lists, binders with placement, placeholders, notes, and cover color.

**Later:** Michi art and print export, the master-set goal, automatic finish detection, pack
openings, graded fields, own photos. A paid vision-model fallback only if the scan lab shows the
phone alone misses too many cards.
