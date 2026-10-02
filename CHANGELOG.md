# Changelog

What changed in Card Tracker and when, newest first. **Live** means you can use it at
https://ericthmoritsuka.github.io/pokemon-card-tracker/ (tap Reload when the app says a new
version is installed). **Planned** means it is designed in `DESIGN.md` but not built yet. Times
are Recife time. Each line ends with its commit.

## In Progress (2026-10-02)

- Nothing is waiting to be wired in. Next: a whole-app audit. See `plans/roadmap.md`.

## Live

### 2026-10-02

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
