# Engineering Audit

- **Date:** 2026-10-02
- **Commit audited:** `02afb5a` (version 21 is live; the roadmap's "State Right Now" still says v20)
- **Scope:** report only. Nothing in the app was changed.

## Method

- **Read** every module touched by sync, auth, the service worker, and the family group, line by line: `js/merge.js`, `js/collection.js`, `js/sync.js`, `js/auth.js`, `js/family.js`, `app.js`, `sw.js`, `404.html`, `index.html`, `js/dom.js`, `js/catalog.js`, `js/cards-view.js`, `js/settings.js`, and the four SQL files.
- **Read with three parallel reviewers, then spot-checked** every claim used here against the code:
  - binders: `js/binders*.js`, `js/binder-*.js`;
  - checklists, the Pokémon screen, twins, names, flags, and Liga;
  - photos, scanner robustness, prices, the wishlist, and the monprice import.
- **Grepped** for every HTML sink (`innerHTML`, `insertAdjacentHTML`, `outerHTML`, `DOMParser`, `srcdoc`), every `href`, `src`, and `style` built from data, and every `indexedDB.open`.
- **Import graph:** built the static and dynamic import graph from `app.js` with a script and compared it with `SHELL` in `sw.js`. Did the same for exports nobody imports.
- **Reproduced in headless Chromium**, with `tests/pages-server.mjs` and `tests/fake-supabase.mjs`, invented data only, and ligapokemon.com.br blocked:
  - the duplicate-import case;
  - the performance of the main screens with an invented collection of 1,600 and 5,000 copies, at 1x and 4x CPU throttling.
- **Reproduced in Node:** merge conflicts, using `js/merge.js`.
- **Live checks:** read TCGdex's image CORS headers with two `curl` requests.
- **Ran every suite** listed in the roadmap.
- **Never contacted** the real Supabase project or Liga.

## Summary

1. **E-14 (High):** importing the same monprice export on a second device, or signed out before the first sign-in, doubles every card after sync. A re-import cannot undo it. Reproduced.
2. **E-15 (High):** edits to different parts of one entry on two devices are silently lost, because the merge keeps the whole newer entry. This covers binder pockets, checklist hand ticks, a copy's photos, and a price typed on one phone against a photo added on the other. Reproduced.
3. **E-16 (Medium):** a delete loses to any later edit from a device that had not synced yet, so deleted cards, binders, lists, and photos come back. A returning photo points at a file that is already deleted. Reproduced.
4. **E-04 (Medium):** checklists read at most the first 300 cards that need a single-card lookup, the same 300 on every visit. Past that, Japanese, Korean, and Chinese cards never tick.
5. **E-02 and E-03 (Medium):** Back leaves the Add photo and Cover image sheets open over the next screen. Several camera start paths leave the camera running.
6. **E-19 (Medium):** a new version takes over open pages at once and deletes the old cache, so the lazily loaded Scan tab can fail until the person taps Reload.
7. **E-20 (Medium):** Portuguese and French card images send a doubled CORS header, verified live. Offline, only the 100 most recent of them are kept.
8. **E-22 (Medium):** the public repo names a family member and their password sign-in name (`plans/roadmap.md:18`).
9. **E-29 to E-33 (Medium):** code built in parallel has drifted apart:
   - three TCGdex set-list implementations;
   - ten IndexedDB openers;
   - seven language tables, which is why German, Spanish, and Italian copies misbehave (E-05, E-12);
   - a second card search that ignores the shared one's offline cache and Pocket filter.
10. **E-37 (Medium):** the monprice parser and `applyImport` have no tests. The changelog's "Importing again never duplicates" has never been tested.

The rest holds up well:

- No HTML is ever built from strings.
- Row-level security and storage policies match how the client uses them.
- `SHELL` lists every module the app loads.
- All 28 suites pass (528 tests).
- At 1,600 copies every main screen draws in under 0.9 s at 4x CPU throttling.

## Findings

### 1. Bugs

**E-01. The checklist and Pokémon screens stay on an error or "This list is not here" after the data arrives**
- Severity: Medium
- Effort: S
- Confidence: Read in code: `js/checklists-view.js:853-870`, `js/pokemon-cards-view.js:729-745`.
- Evidence:
  - On a failed load or a missing list, `load()` calls `root.replaceChildren(back, notice)`, which detaches the screen's title, list, and actions. Those were appended once, at `js/checklists-view.js:940`.
  - The next successful load, started by the document watch at `:938`, calls `drawHead()`, `drawActions()`, and `drawList()` on the detached nodes. The Pokémon screen has the same pattern.
- Impact: opening `lists/<id>` on a new phone before its first sync shows "This list is not here" until the person leaves and comes back, even after the list arrives.
- Fix direction: draw errors into a slot inside the screen, or re-attach the skeleton when a later load succeeds.

**E-02. Back leaves the Add photo and Cover image sheets open over the next screen, with the camera still running**
- Severity: Medium
- Effort: S
- Confidence: Read in code.
- Evidence:
  - `app.js:150-160` only runs the view's cleanup on a route change.
  - The Cover image sheet is appended to `document.body` with `overflow: hidden` (`js/binder-cover.js:753-754`), and its handle is thrown away (`js/binders-view.js:828`, `onclick: () => pickCoverImage({binder})`).
  - The Add photo editor is also appended to `document.body` (`js/photos/editor.js:493`), and nothing closes it on `popstate`.
  - The photo viewer is the exception: the carousel's `destroy()` closes it (`js/photos/carousel.js:388-391`).
- Impact: on Android, the system Back button closes nothing. The sheet covers the new screen, scrolling stays locked, and the Add photo camera keeps the camera light on.
- Fix direction: keep each sheet's `close` handle and call it from the view's cleanup, or close open sheets on `popstate`.

**E-03. The camera is left running in three start paths**
- Severity: Medium
- Effort: S
- Confidence: Read in code.
- Evidence:
  - **Add photo:** Back while the camera is starting calls `start()`, which runs `stopCamera()` while `camera` is still null (`js/photos/editor.js:130-131`, `:203`). When `startCamera` resolves, only `closed` is checked (`:215`), so the stream keeps running behind step 1. A second "Take photo" overwrites `camera`, and the first stream is never stopped.
  - **`startCamera` failures:** it throws on a `play()` failure or on the 10-second no-picture timeout without stopping the tracks it opened (`js/scan/camera.js:78-92`, `lab/js/camera.js:50-62`).
  - **Scanner:** hiding and showing the tab while the camera starts can call `openCamera` twice (`js/scan/view.js:963-981`, `:1103-1109`).
- Impact: the camera light stays on and the battery drains. On some phones the next camera open fails because the device is busy.
- Fix direction: give each start a token or `AbortController`, stop any stream that arrives after it is no longer wanted, and stop the tracks in a `catch` inside `startCamera`.

**E-04. Checklists never look up more than the first 300 cards that need a single-card read**
- Severity: Medium (High once a collection holds more than 300 distinct Asian cards)
- Effort: S
- Confidence: Read in code: `js/checklists.js:433`, `:589-601`.
- Evidence:
  - The bulk map is English only (`:589`), so every Japanese, Korean, and Chinese card lands in `singles`.
  - `wanted = singles.slice(0, SINGLE_CARD_LIMIT)` (300) is taken before any cache check, and the order is stable. The same 300 are read on every visit, cached or not.
  - Cards 301 and up are never read.
- Impact: those cards never tick on any checklist. The status line reports them as unmatched. Each visit also re-reads and clones up to 300 records from IndexedDB.
- Fix direction: check the cache for every card and count only network reads against the limit, or keep a small saved `{card: dex numbers}` map for Asian cards.

**E-05. Edit then Save on an "All" list silently stops counting German, Spanish, and Italian copies, and there is no way back to "All"**
- Severity: Medium
- Effort: S
- Confidence: Read in code.
- Evidence:
  - The editor pre-ticks `listLanguages(goal)`, all seven codes (`js/pokemon-cards-view.js:184`), and Save stores them (`:216`).
  - `LANGUAGES` has only en, pt, fr, ja, ko, zh-cn, zh-tw (`js/catalog.js:9-17`), but the importer stores de, es, and it (`js/monprice.js:10-23`).
  - `copiesByPrint` then filters those copies out (`js/pokemon-cards.js:241`).
  - Once saved, `languages` can never be removed again (`js/checklists.js:280-285`).
- Impact: the roadmap's "ticking every box counts the same" is false, and the counts drop without warning. The Open Decision's proposed `resolveOwned(entriesInLanguages(...))` would drop the same copies on every list.
- Fix direction: add an "Any language" choice that deletes `languages`, and filter by catalog or only when a list names its languages.

**E-06. Ver na Liga leaves out the set total on Japanese SM1p to SM5p cards and gives Japanese promos no button**
- Severity: Medium
- Effort: S
- Confidence: Read in code. The set IDs were checked against TCGdex's `ja/sets`.
- Evidence:
  - `isPromoSet` treats any set ID ending in a lowercase `p` as a promo (`js/liga.js:24-27`). The card page passes the Japanese set ID straight in (`js/catalog-views.js:865-875`).
  - `SM1p` to `SM5p` are regular Japanese expansions (official counts 51, 49, 72, 114, 50). For `SM1p`, `ligaQuery` returns `Pikachu (025)`, without `/051`.
  - The real Japanese promo sets `SV-P` and `M-P` are not detected. With an official count of 0 they return null, so no button appears.
- Impact: the button opens a Liga search that finds nothing, or is missing.
- Fix direction: decide the promo flag per catalog (Japanese promos end in `-P`), and add tests for both cases.

**E-07. A photo upload the server refused shows "Waiting to upload" forever**
- Severity: Medium
- Effort: S
- Confidence: Read in code.
- Evidence:
  - Any 4xx answer is treated as permanent and retried only at the next start or sign-in (`js/photos/store.js:453-457`).
  - The error text is saved on the queue row (`:588`), but only tests read it (`queuedItems`).
  - The carousel knows only "pending" (`js/photos/carousel.js:220`, `:239`).
- Impact: a photo over the bucket's 512 KB limit, or one refused by a policy, never uploads, and nothing says why.
- Fix direction: show the row's error on the photo and in Profile, with Retry and Remove.

**E-08. Overlapping loads can leave a screen showing stale data**
- Severity: Low
- Effort: S
- Confidence: Read in code.
- Evidence:
  - **My Cards:** every document save starts a new `load()` (`js/cards-view.js:755`). `load()` has no run token (`:690-753`), so an older load that finishes last overwrites a newer one.
  - **Lists:** the screen drops a reload while one is busy (`js/checklists-view.js:371-374`). `checklistScreen.load` has no token either (`:846-925`).
  - The Pokémon screen already does this right, with a run counter (`js/pokemon-cards-view.js:339`, `:721`).
- Impact: occasionally a just-synced list or card is missing until the next change.
- Fix direction: use a run counter as the Pokémon screen does, and queue a rerun instead of dropping it.

**E-09. Some errors are lost, and some show as a red "Unhandled error." banner**
- Severity: Low
- Effort: S
- Confidence: Read in code.
- Evidence:
  - **Lost:** after a first save error, `status.replaceWith(...)` targets a detached node, so a second error never shows (`js/binder-cover.js:742`, `js/photos/editor.js:481`).
  - **Banner:** promises with no `catch` at `js/binders-view.js:702`, `:1273`, and `js/binder-spread.js:841-842`, `:880` reach the global handler (`js/dom.js:130-132`), which prints a red banner for benign background failures.
- Impact: a second failure looks like nothing happened, while harmless background failures look alarming.
- Fix direction: update one message element that stays in place, and add `.catch` at those call sites.

**E-10. `checklistView` is missing from `ACCOUNT_ROUTES`**
- Severity: Low
- Effort: S
- Confidence: Read in code: `app.js:70` lists `familyChecklistView` and `checklistsView`, but not `checklistView`.
- Impact: signing in or out while a checklist is open does not redraw it.
- Fix direction: add it to the set.

**E-11. Price entry and display edge cases**
- Severity: Low
- Effort: S
- Confidence: Read in code. `parseBrl` was checked with a Node probe.
- Evidence:
  - **US-style amounts:** `parseBrl("1,234.56")` returns 1.23 with no error (`js/prices.js:84-91`). Brazilian input works: "45,90" is 45.9 and "R$ 1.234,56" is 1234.56.
  - **Mixed finishes on a tile:** tiles group copies by catalog, card, and language (`js/cards-view.js:418`), and `tileValue` shows the newest Liga price of any finish (`js/prices.js:882-907`).
  - **Copies with no finish:** a copy whose finish cannot be told apart is never offered in the Liga price editor (`js/price-view.js:221`, `:238-243`, `:329`; `js/prices.js:519-546`).
- Impact: a mistyped price is saved a thousand times too low, a tile shows a holo's price on normal copies, and some copies can never get a Liga price.
- Fix direction:
  - reject an input that has both separators in US order;
  - label or split a tile price by finish;
  - offer "finish not set" copies in the editor.

**E-12. Edge-case display gaps for unusual languages, sets, and twins**
- Severity: Low
- Effort: S
- Confidence: Read in code.
- Evidence:
  - **Raw language codes:** German, Spanish, and Italian copies show "de", "es", or "it" in Your copies (`js/catalog-views.js:983`), because `languageLabel` falls back to the code (`js/catalog.js:21`). `js/flags.js:267-278` already has the names.
  - **Deleted or renamed Asian sets:** a 404 returns `null` (`js/catalog.js:298-303`), and `js/pokemon-cards.js:577` stores it without counting the set as unread, so the cards show with no set name and no note.
  - **Custom-list picker:** opened before the species names load, it keeps an empty name list for the visit (`js/checklists-view.js:329-330`, `:469`, `:527-530`).
  - **"None of these" on the twin picker:** it saves `rejected` (`js/twins-view.js:120`), but `due()` never rechecks an ambiguous result (`js/twins.js:1051-1053`), despite the comment at `:1136-1137`.
- Impact: small but visible wrong labels and missing names. A rejected twin is never offered again.
- Fix direction: one language table (E-31), a "set not found" note, a redraw when names arrive, and a recheck rule for rejected twins.

**E-13. Re-importing the app's own CSV export fails**
- Severity: Low
- Effort: S
- Confidence: Read in code. A probe gave the number `="001/198"`.
- Evidence: the export wraps numbers as `="001"` (`js/cards-view.js:88`), and `parseCsv` keeps the wrapper (`js/monprice.js:51-99`), so no row matches.
- Impact: the export is not a usable backup through Import. This is still open, as the roadmap says.
- Fix direction: strip `^="(.*)"$` when reading a cell.

### 2. Sync and merge

**E-14. The same import on two devices, or signed out before the first sign-in, doubles every card**
- Severity: High
- Effort: M
- Confidence: Reproduced. Headless Chromium with the fake Supabase, one account, 50 invented rows:
  - the phone imported and synced, which gave 50 copies;
  - a second phone imported the same rows while signed out, then signed in and synced;
  - both phones and the server then held 100 live copies;
  - importing again on the second phone reported `unchanged: 50` and left 100.
- Evidence:
  - `applyImport` matches existing rows by `import_key`, but gives every new row a fresh `id: newId()` (`js/collection.js:322-343`).
  - The merge matches entries by `id` only (`js/merge.js:50-74`).
  - A document no account owns is adopted as-is at sign-in (`js/collection.js:163-167`) and merged with the server's.
  - `byKey` keeps one row per key (`:326-330`), so later imports never see the duplicate.
- Impact: the most natural setup of a second phone (import, then sign in) doubles the collection, and nothing can undo it short of deleting copies one by one. The screen promises the opposite: "Importing the same file again does not add the cards twice" (`js/import-view.js:268`); so does `CHANGELOG.md:120`.
- Fix direction: derive the entry `id` from `import_key`, for example a UUIDv5, which also fits the photo path rule. Alternatively, after each merge keep the oldest live entry per `import_key` and tombstone the others.

**E-15. Edits to different parts of one entry on two devices are silently lost**
- Severity: High. Data loss, but only when two devices edit the same entry between syncs, mostly with one of them offline.
- Effort: L
- Confidence: Reproduced in Node with `js/merge.js`:
  - pockets p1/1 on one phone and p1/2 on another merge to only `[p1/2]`;
  - a Liga price typed on one phone and a photo added to the same copy on another merge to the photo only.
- Evidence:
  - `newerEntry` keeps the whole newer entry (`js/merge.js:34-46`).
  - Nested data lives inside single entries:
    - binder pockets in `slots` (`js/binders.js:13-22`);
    - hand ticks in `goal.hand_ticks` (`js/checklists.js:243-254`);
    - photos in `entry.photos` (`js/collection.js:208`);
    - `price_manual` beside them (`:211`).
  - `mergePhotoLists` exists (`js/photos/model.js`), but only the local photo restore calls it, never the document merge.
  - `tests/binders.test.mjs:268` ("the newer edit of a binder wins, pockets and all") writes the loss into the tests.
  - A background write can cause it too: a cover saved while signed out uploads later and bumps the binder's `updated_at` (`js/binder-cover.js:355-356`).
- Impact: placed cards fall out of their pockets, ticks disappear, and a price or a photo vanishes, all without a message. DESIGN.md section 3 accepted "no real conflict resolution" for whole entries, but these nested lists are where two devices really do edit the same entry.
- Fix direction: merge nested collections key by key inside `mergeEntries`:
  - slots by `page|position`, each with its own stamp and tombstone;
  - ticks by dex number;
  - photos by photo id, with the tombstone winning;
  - a separate stamp for `price_manual`.

**E-16. A delete loses to any later edit from a device that had not synced, so deleted things come back**
- Severity: Medium
- Effort: M
- Confidence: Reproduced in Node. A card deleted at 10:05 on one phone, then given a note at 10:06 on an offline phone, merges back to `deleted_at: null`.
- Evidence:
  - Rule 1 (newer `updated_at` wins) runs before the tombstone rule (`js/merge.js:35-43`). DESIGN.md section 3 promises "an offline phone cannot bring a deleted card back", which holds only when the offline phone made no later edit.
  - **Photos:** removing a photo deletes its bucket file straight away (`js/photos/store.js:426-437`). A resurrected photo entry then points at a missing file and shows broken everywhere except the phone that kept a local copy.
  - **Binders:** the deleting phone queues the cover's bucket delete (`js/binders-view.js:874`), so a resurrected binder's cover download fails and retries every 30 s (`js/binder-cover.js:157`, `:175`).
  - **Clock skew:** a phone whose clock is behind loses its genuinely later edits (probe: a later edit stamped 09:58 lost to 10:05).
- Impact: deleted copies, binders, lists, and photos reappear, some with broken images.
- Fix direction: make a tombstone sticky, so a deleted entry stays deleted unless restored on purpose. Delay bucket deletes until the tombstone has reached the server and no device has re-raised the entry.

**E-17. Adding the same card to the wishlist on two devices makes two items**
- Severity: Low
- Effort: S
- Confidence: Read in code.
- Evidence: `addToWishlist` checks for an existing item on this phone only (`js/wishlist.js:390-399`), and the merge matches by id.
- Impact: a duplicate wish appears. Removing it on one phone leaves the other phone's copy.
- Fix direction: derive the wish id from `card_id|variant_id|language`, or deduplicate after the merge.

**E-18. Whole documents move over the network for small changes**
- Severity: Medium
- Effort: M
- Confidence: Measured and read in code.
- Evidence:
  - The invented 1,600-copy document is 453 KB of JSON (283 bytes a copy, with no photos, prices, or notes), and 1.42 MB at 5,000.
  - Every push uploads the whole document (`js/sync.js:235-239`). Realtime then sends the changed row, `doc` included, to every open device, and each of them downloads the full row again (`js/sync.js:196-197`).
  - The family wishlist cache downloads every member's full document (`js/wishlist.js:545-553` calls `memberDocument`, `js/sync.js:645-653`). It runs at every app start (`app.js:296`), every `online` event, every sign-in, and when the scanner finds the cache older than 10 minutes (`js/wishlist.js:592-619`).
  - Tombstones are never purged, so the document only grows.
- Impact: on mobile data, one tap costs about 1 MB per extra device, and every app start costs a full download of each family member's collection. It is within the free tier for one family today, but it grows with every card and tombstone.
- Fix direction:
  - select `doc->wishlist` (or add an RPC) for the family cache;
  - stop Realtime from shipping `doc`, for example by publishing only `updated_at` through a small side table;
  - purge tombstones older than a few months once every device has synced past them.

**Checks out:**
- The compare-and-set retry loop (`js/sync.js:182-273`) and the own-echo check (`:475`) are correct.
- Switching accounts on one phone stashes the other person's document instead of merging it (`js/collection.js:156-189`).
- Offline edits replay on reconnect, and two devices writing at once keep both (tested in `app.test.mjs:455` and `:509`).
- A family member's documents are only ever read.

### 3. Offline and the service worker

**E-19. A new version takes over open pages at once, so the lazily loaded Scan tab can fail until Reload**
- Severity: Medium
- Effort: S
- Confidence: Read in code.
- Evidence:
  - `install` calls `skipWaiting()` (`sw.js:185`), and `activate` deletes every older shell cache and claims the open pages (`sw.js:190-203`).
  - Module URLs carry no version. The Scan tab's modules load on first open (`js/scan/routes.js:15`), so a page still running the old `dom.js` and `collection.js` gets the new `view.js` from the new cache.
  - If the new version changed an export, the import throws, and the person sees "The scanner did not open." (`js/scan/routes.js:21`).
  - The "A new version is installed" toast does offer Reload (`app.js:252`).
- Impact: after a release, Scan fails until Reload is tapped, for anyone who ignores the toast.
- Fix direction: let the new worker wait, and call `skipWaiting` from the toast's Reload through `postMessage`. Alternatively, keep the previous shell cache until no client uses it.

**E-20. Portuguese and French card images: only 100 are kept offline, and each costs two requests online**
- Severity: Medium
- Effort: M
- Confidence: Reproduced. `curl` on `assets.tcgdex.net/pt/sv/sv01/001/low.webp` returns `access-control-allow-origin: *` twice; the English image returns it once.
- Evidence:
  - The worker tries `cors` first, then falls back to `no-cors` and keeps the opaque response in a cache capped at 100 entries, because Chrome pads each opaque entry by about 9 MB of quota (`sw.js:17-40`, `:236-277`).
  - Every uncached Portuguese or French image costs a failed `cors` request first.
  - My Cards shows Portuguese images when the viewing language is Portuguese (`js/cards-view.js:431-432`).
- Impact: in a shop with no signal and the viewing language set to Portuguese, most tiles show the card back. Sets and card pages in Portuguese behave the same way.
- Fix direction: report the doubled header to TCGdex, which is open source. Meanwhile, use the English image offline when the Portuguese one is not cached, or size the opaque cap from `navigator.storage.estimate()`.

**E-21. Cache housekeeping gaps**
- Severity: Low
- Effort: S
- Confidence: Read in code.
- Evidence:
  - **Unused precache:** `lab/js/ocr.js` is precached (`sw.js:138`), but no app module imports it. The import graph reached 71 modules, and this was the only listed module outside it.
  - **OCR cache:** it is named for the Tesseract version (`sw.js:47`) and is never deleted, so a version change leaves about 7 MB behind.
  - **Binder covers:** cover blobs are removed only on the phone that deletes or replaces them. Another phone, or a family member's phone, keeps them for good (`js/binder-cover.js:122-131`, `:169`).
  - **Card photos:** local photo files of deleted entries are never removed (`js/photos/store.js:465-467`, `:446`).
- Impact: storage grows slowly. The app keeps working.
- Fix direction: drop `lab/js/ocr.js` from `SHELL`, delete old `card-tracker-ocr-*` caches in `activate`, and sweep blobs no live entry or binder references.

**Checks out:**
- `SHELL` lists every module reachable from `app.js`, including `js/scan/*` and `js/photos/*`. This was checked by script, and `tests/scan-harness.mjs:150-155` asserts it too.
- All eight stylesheets, the fonts, flags, icons, and the manifest are precached.
- Navigations get the cached shell, so deep links such as `binders/<id>/<page>` open offline. Online, `404.html` sends them through `?p=`.
- The first open with no connection and no worker cannot work, as expected.

### 4. Supabase row-level security, storage, and secrets

**E-22. The public repo names a family member and their password sign-in name**
- Severity: Medium
- Effort: S, but it is in git history
- Confidence: Read: `plans/roadmap.md:18`.
- Evidence:
  - The line gives a real family member's full name as the `@family.invalid` address they sign in with.
  - The repo's own rules forbid personal data. That address is also the account name for password sign-in (`js/auth.js:208-212`), so it hands a guesser half of a login.
- Impact: personal data is public, and one account is easier to target.
- Fix direction: replace it with "a family member's account", and decide whether to rewrite history or accept it. Ask the member to use a strong password.

**E-23. `reset-password.sql` leaves existing sessions signed in**
- Severity: Low
- Effort: S
- Confidence: Read in code: `supabase/reset-password.sql:188-192` updates `encrypted_password` only.
- Impact: if the password is reset because it leaked, a device already signed in stays signed in, because its refresh token still works.
- Fix direction: also delete that user's rows from `auth.sessions` (refresh tokens follow) in the same script.

**E-24. Closed sign-up rests only on the dashboard switch**
- Severity: Low
- Effort: S
- Confidence: Read in code: `js/auth.js:198` calls `signInWithOtp` without `shouldCreateUser: false`, and the client never calls `signUp`.
- Impact: if "Allow new users to sign up" is ever turned back on, anyone who types an email gets an account. Row-level security still limits them to their own empty row, and `claim_owner` does nothing once the group exists (`supabase/setup.sql:202-213`).
- Fix direction: pass `shouldCreateUser: false` as a second lock.

**Checks out:**
- **Tables:** every table has row-level security on and `anon` revoked (`setup.sql:118-127`). People write only their own `documents` and `profiles` rows (`:154-161`, `:137-144`) and read their own plus their group's (`:133-135`, `:150-152`).
- **Groups and memberships:** they have no write policy, so they change only through owner-checked functions (`:166-175`, `:241-248`, `:278-289`).
- **Non-members:** someone outside the group reads nothing but their own rows.
- **Storage:** paths must be `<own uuid>/<id>/<id>.webp|jpg` to write (`photos.sql:106-113`, `:142-160`), and reads follow the group rule (`:132-140`). Binder covers use `<uid>/binder-<uuid>/<uuid>.webp`, which fits: the middle part is 43 characters of the 64 allowed.
- **Secrets:** only the publishable key is committed. A search found no `service_role` key, secret key, JWT, or password.

### 5. Unsafe HTML

**E-25. A family member's binder colour goes into a `style` attribute unchecked**
- Severity: Low
- Effort: S
- Confidence: Read in code.
- Evidence: `cover()` writes `style: '--cover: ${color}; ...'` from `binder.cover_color` (`js/binders-view.js:420-424`). For family binders the value comes straight from their document, and `isHex` exists but is only applied when saving (`js/binders.js:93`, `:138`). `paintCover` and the spread do the same through `setProperty` (`js/binder-cover.js:192`, `js/binder-spread.js:435`).
- Impact: a crafted document can inject CSS, for example a tracking `url()`. It cannot run script, and only family members can write those documents.
- Fix direction: pass every colour read from a document through `isHex`, falling back to `DEFAULT_COVER`.

**Checks out:**
- No file uses `innerHTML`, `insertAdjacentHTML`, `outerHTML`, `DOMParser`, or `srcdoc`.
- `h()` (`js/dom.js:61-89`) sets text as text nodes and attributes through `setAttribute`, and binds only function values to `on*` keys.
- TCGdex names, CSV text, notes, binder and list names, and family display names are all rendered as text.
- The only data-built links are Liga links: a fixed `https` prefix plus `encodeURIComponent` (`js/liga.js:231-235`).

### 6. Performance with 1,600+ copies

Measured in headless Chromium at 360 x 740, with an invented collection (ten fake sets, copies in pt, en, and fr). TCGdex and PokeAPI were faked and images answered 404, so image decoding is not included. Times are milliseconds from navigation or action to the finished draw.

| What | 1,600 at 1x | 1,600 at 4x CPU | 5,000 at 4x CPU |
| --- | --- | --- | --- |
| My Cards, first 120 tiles (three warm runs) | 354 to 378 | 509 to 814 | 823 to 970 |
| Long tasks in the 1.5 s after first paint | 0 | 60 to 290 | 257 to 476 |
| Sort by name / by set / language filter | 26 / 32 / 31 | 92 / 65 / 65 | 110 / 57 / 52 |
| Show more (120 more tiles) | 56 | 168 | 82 |
| Add one copy until the count updates | 131 | 742 | 564 |
| One `updateCard` save to IndexedDB | 4 | 16 | 18 |
| `mergeDocuments` on the whole document | 11 | 74 | 67 |
| Card index read (`cardIndex()`) | 68 (412 KB) | 197 | 314 (1.29 MB) |
| Set page, 160 cards | 343 | 311 | 684 |
| Card page | 333 | 660 | 627 |
| Kanto checklist over every copy | 311 to 364 | 475 to 478 | 1,242 to 1,277 |
| Lists tab / Binders tab | 261 / 258 | 401 / 397 | 508 / 265 |
| JS heap after the run | 11 MB | 30 MB | 34 MB |

A cold first open of My Cards made 10 set requests to fill the card index, and nothing afterwards. At 1,600 copies the main screens are fast enough, and nothing needs fixing for speed alone. The findings below are where cost grows with use.

**E-26. With "Count every finish" on, the Pokémon screen rebuilds its whole grid for every finish record**
- Severity: Medium
- Effort: S
- Confidence: Read in code.
- Evidence:
  - `js/pokemon-cards-view.js:645-654` calls `draw()` after each record arrives.
  - Each `draw()` scans every entry (`copiesByPrint`), sorts, and rebuilds every tile (`:568-624`).
- Impact: a Pokémon with about 250 prints means about 250 full rebuilds over all entries while the records stream in.
- Fix direction: batch draws to one per animation frame, and memoize `copiesByPrint` per entries array.

**E-27. A hand tick merges and saves the whole document, then redraws every row two or three times**
- Severity: Medium
- Effort: M
- Confidence: Read in code.
- Evidence:
  - `saveGoal` goes through `mergeIntoLocal` (`js/checklists.js:127-132`), which merges all lists (74 ms at 4x for 1,600 copies) and writes the whole document.
  - The screen then draws (`js/checklists-view.js:684-685`) and reloads (`:703-704`, `:877-879`).
  - `state(n)` rebuilds the tick set for each row (`:596`, `:711`, `:734`). The Every Pokémon list has 1,025 rows.
- Impact: ticks feel sluggish on a phone, and each tick also re-runs the dex resolution.
- Fix direction: build the tick set once per draw, patch only the tapped row, and save the goal without a full-document merge.

**E-28. Every save reloads all of My Cards, and the card index is read whole several times per load**
- Severity: Low
- Effort: M
- Confidence: Measured and read in code.
- Evidence:
  - The document watch reruns `load()` on every save, sync merges included (`js/cards-view.js:755`). That re-reads the index, saved records, and twins, and re-runs `refreshTwins` and `fillMissingRecords` (`:690-753`): 742 ms at 4x for one added card.
  - `cardIndex()` parses the whole index into a `Map` on each call: 197 ms at 4x for 1,600 records. It is called from `js/cards-view.js:692`, `js/collection.js:415`, and `js/catalog.js:389`.
  - `saveToCardIndex` reads, modifies, and writes the whole index with no lock (`js/catalog.js:412-424`), so two fills at once can lose records. They are re-fetched later.
- Impact: brief jank after each edit or sync.
- Fix direction: keep the index in memory once read, and patch My Cards from the change instead of reloading it.

### 7. Duplication between modules built in parallel

**E-29. Three TCGdex set-list implementations and four fetch-with-retry helpers**
- Severity: Medium
- Effort: M
- Confidence: Read in code.
- Evidence:
  - **Set lists:**
    - `js/catalog.js:218-243`: REST series plus one request per series, used by Sets, `js/wishlist.js:743`, and `js/scan/match.js:48`;
    - `js/pokemon-cards.js:482`, `:518`: GraphQL;
    - `js/twins.js:842`: GraphQL with card counts.
  - **Fetch helpers:** `catalog.js` `getJson`, `js/checklists.js:370`, `js/pokemon-cards.js:441`, `js/twins.js:774`.
- Impact: a TCGdex change (a new series filter, a hidden Pocket set, a rate limit) must be fixed in three places, and devices download overlapping lists.
- Fix direction: create a shared `js/tcgdex.js` with:
  - `fetchJson` (one retry policy) and `graphql()`;
  - a `pool`/`limiter`;
  - one cached `setIndex(lang)` returning `{id, name, releaseDate, serie, official, total}`, which twins filters by series and the Pokémon screen reads for names and dates.

**E-30. Ten IndexedDB openers, three of them the same `{at, data}` cache**
- Severity: Medium
- Effort: M
- Confidence: Read in code.
- Evidence:
  - The ten openers: `js/catalog.js:76`, `js/pokemon-cards.js:380`, `js/checklists.js:313`, `js/binder-cover.js:68`, `js/phone-check.js:604`, `js/wishlist.js:427`, `js/photos/store.js:52`, `js/collection.js:34`, `js/scan/draft.js:27`, `js/twins.js:581`.
  - `js/catalog.js:61-120`, `js/checklists.js:299-357`, and `js/pokemon-cards.js:366-424` are line for line the same cache.
- Impact: any fix to error handling, blocked upgrades, or eviction must be made ten times.
- Fix direction: create a shared `js/kv-cache.js` with `openStore(name, stores)`, `cacheGet`, `cachePut`, and `kept()`. Twins keeps its `memoryStore` interface on top of it.

**E-31. Language tables in seven places**
- Severity: Medium
- Effort: M
- Confidence: Read in code.
- Evidence: `js/catalog.js:9-30`, `js/flags.js:249-278`, `js/names.js:17`, `js/pokemon-cards.js:34-44`, an inline Asian list at `js/checklists.js:616`, PokeAPI IDs at `js/checklists.js:666`, and `js/monprice.js:10-23`.
- Impact: they already disagree. de, es, and it exist in the importer and flags but not in `LANGUAGES`, which causes E-05 and E-12.
- Fix direction: create a shared `js/languages.js` with one row per code: label, flag, catalog, name language, and whether it can be picked. Every caller derives from it.

**E-32. The binder placeholder search is a second card search that has drifted from the shared one**
- Severity: Medium
- Effort: S
- Confidence: Read in code.
- Evidence: `js/binders-view.js:1151` fetches TCGdex directly, with its own `TCGDEX` constant (`:69`). `js/wishlist.js:803` `searchCards` already caches results for a day, filters out TCG Pocket (`:667`, `:839`), and handles numbers. `js/scan/sheets.js:120` reuses it.
- Impact: placeholder results include Pocket cards, the search fails offline, and tiles show raw set IDs as set names (`js/binders-view.js:1170-1171`).
- Fix direction: call `searchCards(text, lang)`.

**E-33. Four sheet implementations, and forked camera, edge, and warp code**
- Severity: Medium
- Effort: L
- Confidence: Read in code.
- Evidence:
  - **Sheets:** scroll lock, Escape, and focus return are written four times: `js/photos/editor.js:73-109`, `js/photos/viewer.js:942-984`, `js/binder-cover.js:484-512` and `:751-753`, and `js/scan/sheets.js:89`, `:451`, `:523`. The corner editor is nearly copied between `js/photos/editor.js:267-489` and `js/binder-cover.js:595-750`.
  - **Cameras:** two `startCamera`s (`lab/js/camera.js:23`, used by photos, and `js/scan/camera.js:33`).
  - **Edges and warps:** two edge finders (`lab/js/rectify.js` and its fork `js/scan/rectify.js`), two perspective warps (`js/photos/geometry.js:228`, `js/scan/rectify.js:423`), and two canvas encoders (`js/scan/image.js:3-35`, `js/photos/encode.js:36-59`).
- Impact: E-02, E-03, and E-09 exist once per copy. App code also depends on files under `lab/`.
- Fix direction:
  - create a shared `js/sheet.js` with open, close, focus trap, and close on route change;
  - create a shared `js/corners.js` editor;
  - move the camera, rectify, and encode code the app uses out of `lab/` into `js/vision/`, and have the lab import from there.

**E-34. Small helpers copied across files**
- Severity: Low
- Effort: S
- Confidence: Read in code.
- Evidence:
  - `formatCount` in 10 files and `plural` in 9 (for example `js/cards-view.js:35-37`, `js/binders-view.js:73-75`, `js/checklists-view.js:49-51`);
  - `pool` 4 times (`js/cards-view.js:233`, `js/pokemon-cards.js:540`, `js/checklists.js:527`, `js/monprice.js:242`);
  - `nextStamp` 4 times (`js/checklists.js:120`, `js/settings.js:141`, `js/binders.js:183`, `js/wishlist.js:156`);
  - `validDex` 3 times;
  - `readChoice` and `saveChoice` in both checklist and Pokémon views.
- Impact: small drift, such as `plural` without `formatCount` in `js/scan/view.js:31`.
- Fix direction: create a shared `js/format.js` and `js/stamp.js`.

**E-35. Stylesheets bypass the design tokens, and one unscoped rule leaks**
- Severity: Low
- Effort: M (the leak is S)
- Confidence: Read in code. Colours were counted by script.
- Evidence:

  | File | Hard-coded colours | `var(--)` uses |
  | --- | --- | --- |
  | `css/binders.css` | 9 | 26 |
  | `css/binder-spread.css` | 64 | 47 |
  | `css/wishlist.css` | 6 | 19 |
  | `css/photos.css` | 34 | 13 |
  | `css/scan.css` | 55 | 49 |

  - Most of `binder-spread.css` is physical shading. The real bypasses are the corner handles (`css/binder-spread.css:715-730`), a copy of `css/photos.css:628-633` that hard-codes `--navy` and `--yellow` values.
  - `css/wishlist.css` uses `--navy`, which no theme overrides.
  - `.sheet-head` in `css/binders.css:358-364` is not scoped and loads after `style.css`, so it changes the Mine switcher's gap (`js/shell.js:204`) from `var(--space-3)` to 8 px.
- Impact: themes do not reach those parts. The leak is a small visual bug elsewhere in the app.
- Fix direction: scope the binder rule to `.pocket-sheet .sheet-head`, then move the colours onto tokens as the roadmap plans.

### 8. Dead code

**E-36. Unused exports, CSS, and one precache entry**
- Severity: Low
- Effort: S
- Confidence: Read in code. Each name was grepped across `js/`, `lab/`, `tests/`, `*.html`, and `*.css`.
- Evidence:
  - **Never referenced outside their definition:**
    - `onCoversChange` (`js/binder-cover.js:220`): nobody subscribes, so a cover that arrives later never repaints;
    - `locationText` and `placeholdersWaiting` (`js/binders.js:277`, `:582`);
    - `ownedCards` (`js/checklists.js:794`, left from the old inline rows);
    - `lensMember` (`js/shell.js:74`);
    - `pickStatus` (`js/tile.js:193`);
    - `wishFor` (`js/wishlist.js:366`);
    - `engineStarted` (`js/scan/identify.js:60`);
    - `clampCorners` (`js/photos/geometry.js:174`);
    - `cropImage` (`js/scan/rectify.js:594`);
    - `identityClues` (`js/scan/evidence.js:545`);
    - `scanRoutes` (`js/scan/routes.js:32`);
    - `mainImageArt` (`js/photos/index.js:242`), with `.ph-tile-slot` (`css/photos.css:160`);
    - `draftCount` and `DRAFT_EVENT` (`js/scan/draft.js:70`, `:85`): the event is dispatched, and nothing listens;
    - the `onPocket` option (`js/binder-spread.js:299`).
  - **Unused CSS:** `.wl-badge-on` (`css/wishlist.css:42`).
  - **Unused precache:** `lab/js/ocr.js` (`sw.js:138`).
  - **Lab-only files:** `lab/js/main.js` and `lab/js/log.js` (fine, the lab page uses them).
  - **Vendor:** everything in `vendor/` is used.
- Impact: noise for the next agent, and one cover-repaint gap.
- Fix direction: delete them, or wire `onCoversChange` into the binder screens.

### 9. Tests

All suites were run once, with the command from the roadmap. None failed, so none needed a lone rerun.

| Suite | Result | Tests | Seconds |
| --- | --- | --- | --- |
| merge | Pass | 10 | 0 |
| names | Pass | 73 | 0 |
| liga | Pass | 36 | 11 |
| themes | Pass | 9 | 0 |
| wishlist | Pass | 25 | 1 |
| binders | Pass | 25 | 17 |
| checklists | Pass | 2 | 14 |
| app | Pass | 17 | 39 |
| live-sync | Pass | 5 | 18 |
| themes-app | Pass | 7 | 17 |
| wishlist-browser | Pass | 3 | 10 |
| shell | Pass | 14 | 27 |
| scan | Pass | 47 | 2 |
| scan-browser | Pass | 5 | 42 |
| photos | Pass | 27 | 1 |
| photos-browser | Pass | 16 | 14 |
| photos-viewer | Pass | 32 | 0 |
| photos-viewer-browser | Pass | 28 | 31 |
| prices | Pass | 51 | 1 |
| prices-browser | Pass | 10 | 6 |
| prices-app | Pass | 1 | 3 |
| binder-spread | Pass | 18 | 1 |
| binder-spread-browser | Pass | 18 | 24 |
| pokemon-cards | Pass | 17 | 0 |
| pokemon-cards-browser | Pass | 2 | 10 |
| twins | Pass | 22 | 0 |
| twins-browser | Pass | 4 | 12 |
| account-password | Pass | 4 | 10 |
| photos-sql | Not run: needs Docker | | |
| `tests/setup-sql-check.sh` (setup.sql row-level security) | Not run: needs Docker, and is not in the roadmap list | | |

Total: 28 suites, 528 tests, all passing.

**E-37. The monprice parser and `applyImport` have no tests**
- Severity: Medium
- Effort: M
- Confidence: Read: no test file imports `js/monprice.js` or calls `applyImport`. Browser tests only check that the Import screen opens (`tests/app.test.mjs:714`).
- Impact: E-13 and E-14, and the changelog's "Importing again never duplicates", have no test. The 737-line parser is unguarded against the next monprice format change.
- Fix direction: add a Node suite for `parseCsv` and `parseJson` (BOM, CRLF, quotes, the `="..."` wrapper), and a browser test that imports twice on one device and on two devices.

**E-38. Two browser suites depend on the live TCGdex API**
- Severity: Low
- Effort: S
- Confidence: Read in code: `tests/app.test.mjs:690` and `tests/themes-app.test.mjs:393` use `{tcgdex: 'real'}`.
- Impact: a TCGdex outage or data change fails the release gate for reasons unrelated to the code.
- Fix direction: record the responses once into fixtures, as `tests/pokemon-cards-record.mjs` does.

**Important behaviour with no test:**
- the same import on two devices, or signed out and then signed in (E-14);
- two devices editing different pockets, ticks, or photos of one entry (E-15). `tests/binders.test.mjs:268` asserts the loss;
- a delete against a later offline edit (E-16);
- a service worker update while the app is open: the `controllerchange` toast, Reload, and a lazily loaded Scan after the update (E-19);
- a family member's My Cards and card pages with Japanese or Korean entries (roadmap twins bullet; the only family test uses international cards, `tests/pokemon-cards-browser.test.mjs:499`);
- a Japanese Trainer's Ver na Liga link built from its twin, and Japanese promo sets (E-06);
- Back with a sheet open (E-02), and camera start failures (E-03);
- checklists with more than 300 Asian cards (E-04);
- an unknown language (de, es, it) through Edit and Save on a list (E-05);
- the family wishlist cache, which only browser-tests the view;
- `reset-password.sql` and the `@family.invalid` flow beyond sign-in (`tests/account-password.test.mjs` covers sign-in and change only).

### 10. Roadmap loose ends

| Item | Status | Note |
| --- | --- | --- |
| Scanner: a card filling 100% of the guide's height at a strong slant is cut at the weakness row | Confirmed (in code) | `js/scan/rectify.js` and `js/scan/steady.js` are unchanged since v17. Bottom edges come only from 60 to 100% of the height (`js/scan/rectify.js:367`), and nothing handles the weakness row. Not reproduced without a photo. |
| Scanner: perfectly regular vertical stripes pass the presence check | Confirmed | `presence()` returns present for stripes 4 to 20 px apart on the 64 x 88 thumbnail (Node probe); the straight-lines rule lets them through (`js/scan/steady.js:185-188`). |
| Scanner: benchmark not committed in `lab/` | Confirmed | `git ls-files lab` lists no benchmark. |
| Binders: empty-binder hint says "Tap a pocket" | Confirmed | `js/binders-view.js:567`. It also stays when only Gone, Left empty, or art pockets exist (`:690`). |
| Binders: action buttons no longer stick | Fixed already (still holds) | `#binder-body .actions { position: static }` (`css/binders.css:213`), repeated in `css/binder-spread.css:745-753`. |
| Binders: new binders default to 40 pages | Confirmed | `js/binders-view.js:248`; every preset is 40 (`js/binder-presets.js:15-17`). |
| Binders: old `binders/<id>/<page>` links open the spread holding that page | Confirmed | `js/binder-spread.js:110-112`, rewritten to `?spread=` at `:985`. Nothing in the app builds such links any more; the comments at `js/binders-view.js:542-544` are stale. |
| Binders: another phone keeps a deleted binder's cover in its local cache | Confirmed | Only the deleting phone calls `dropBinderCover` (`js/binders-view.js:874`). It is the same for replaced covers (E-21). |
| Binders: in landscape the raised Scan button sits over the bottom of the spine | Confirmed (in code) | The spread reserves `tab-height + 24px` (`css/binder-spread.css:763`), while the Scan disc rises 28 px (`style.css:2421`). Not measured in a browser. |
| Pokémon (v19): a list with no `languages` shows "All" and counts any language | Confirmed | `js/pokemon-cards-view.js:160`, `:174`, `:573`. |
| Pokémon (v19): no way back to "All"; ticking every box counts the same | Changed | No way back is confirmed (`js/checklists.js:280-285`). Ticking every box does not count the same: it drops de, es, and it copies (E-05). |
| Pokémon (v19): an "All" list's first visit makes four Asian catalog requests plus one per Japanese or Korean set | Changed | Confirmed, except that the extra requests are per Japanese or Chinese (Traditional) set. The Korean catalog has no cards (`js/pokemon-cards.js:18-21`, `:555-584`). |
| Pokémon (v19): owned rows link to the Pokémon screen instead of expanding | Confirmed | `js/checklists-view.js:713`; the old `ownedCards` is now dead code (E-36). |
| Twins (v20): Ver na Liga on a Japanese Trainer uses the twin's English name | Confirmed, correct except promos | `js/catalog-views.js:865-879` uses the twin's English name (only for a sure or confirmed match) with the Japanese card's own `localId` and the Japanese set's official total, never the twin's number. That matches DESIGN.md section 10 ("Languages on Liga") and the hyphenation rules in `js/liga.js`. It breaks on Japanese promo detection (E-06). Korean and Chinese prints get no button by design. No test covers the Trainer-with-twin case, and DESIGN.md's "the button covers international cards only" is out of date. |
| Twins (v20): set detail tiles do not use twins | Confirmed | `js/catalog-views.js:509` has no `withTwinName`, unlike `:697`. |
| Twins (v20): no test opens a family member's cards with Japanese entries | Confirmed | See the test-gap list. |
| Twins (v20): twins and the Pokémon screen each fetch their own set list | Changed: three lists | `js/catalog.js:218-243` is a third (E-29). |
| Twins (v20): Japanese `M6` has no English counterpart; the weekly recheck fills cards in later | Confirmed (mechanism) | Korean copies on Japanese records match under `ja|` keys. Entries on the Korean catalog itself (`ko|`) are never matched. The recheck runs only when My Cards opens (`js/cards-view.js:540`). `M6` itself was not checked. |

On the Open Decision about list languages: the proposed `resolveOwned(entriesInLanguages(data.entries, listLanguages(found)), ...)` would also drop de, es, it, and null-language copies on lists that name no languages (`js/checklists.js:274-278`, `:291-295`). Fix E-31 first, or filter only when `namesLanguages(goal)` is true.
