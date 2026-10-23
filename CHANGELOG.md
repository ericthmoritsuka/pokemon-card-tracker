# Changelog

What changed in Card Tracker and when, newest first. **Live** means you can use it at
https://ericthmoritsuka.github.io/pokemon-card-tracker/ (tap Reload when the app says a new
version is installed). **Planned** means it is designed in `DESIGN.md` but not built yet. Times
are Recife time. Each line ends with its commit.

## In Progress (2026-10-09)

- Shared modules, wave 2: one language table (on hold). Then the kept items in
  `plans/roadmap.md`.

## Live

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
