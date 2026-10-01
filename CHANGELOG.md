# Changelog

What changed in Card Tracker and when, newest first. **Live** means you can use it at
https://ericthmoritsuka.github.io/pokemon-card-tracker/ (tap Reload when the app says a new
version is installed). **Planned** means it is designed in `DESIGN.md` but not built yet. Times
are Recife time. Each line ends with its commit.

## In Progress (2026-10-01)

- Built and tested, waiting to go live together: Pokémon checklists, the Ver na Liga button,
  type themes with game-style frames, favorite Pokémon, binders with notes and cover color, and
  wishlists with a family view.
- Being built: English names over Japanese, Korean, and Chinese names, with readings in
  parentheses, and country flags instead of language codes.
- Next: the new navigation (Cards, Sets, Scan, Binders, Lists) and the scanner, from the
  approved design review.

## Live

### 2026-10-01

- **12:20** Scan lab at `/lab/`: measures how well the phone reads cards (open it in an Incognito
  tab until the next app version). Benchmark: the right card first on 82% of clean and 65% of
  degraded captures. `385a02d`
- **12:15** Live sync: an open device picks up changes from another within a minute, or within
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

- **12:25** Navigation from the staff design review, approved: Cards, Sets, Scan, Binders,
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
