# QA Audit: Card Tracker, Version 21

- **Date:** 2026-10-02
- **Commit tested:** `02afb5a` (version 21, binder pages turn on the middle of the spine)
- **Tester:** a senior QA tester who collects cards (Portuguese, English, Japanese, and Korean prints, binders, checklists, prices)
- **Scope:** report only. Nothing in the app was changed.

## Setup

- **Server:** `tests/pages-server.mjs` over the worktree, so the app runs under `/pokemon-card-tracker/` with the GitHub Pages 404 redirect.
- **Browser:** Playwright Chromium (headless), touch and a mobile Android user agent, device scale 2.
- **Viewports:** 360 x 800, 390 x 844, 412 x 915 portrait; 844 x 390 landscape; 1280 x 800 desktop. 195 x 422 stands in for 200% page zoom, and a root `font-size: 200%` for large text.
- **Supabase:** always `tests/fake-supabase.mjs` (`page.route` and `routeWebSocket`), behind a catch-all guard that blocks and logs any other `supabase.co` request. Zero requests escaped in any run. No accounts were created anywhere.
- **Liga Pokémon:** every `ligapokemon.com.br` request aborted. Zero were attempted (links were read, never opened).
- **TCGdex, PokeAPI:** real, through the scan harness's disk cache (`routeTcgdex`), so each answer was fetched once. TCGdex 500s and a 6 s delay were simulated with routes.
- **Exchange rates:** frankfurter faked at R$ 5,40 per US$ and R$ 5,88 per euro.
- **Collection data:** an invented monprice CSV and JSON (22 rows: Portuguese, English, Japanese, Korean, and French copies from 151, Chaos Rising, Base Set, and Japanese 151), broken files, and an invented 1,772-copy collection across eight real sets. The family used "Owner" and "Member A" with invented `example.test` and `family.invalid` names.
- **Scanner:** Chrome's fake camera fed Y4M stills built from the Weedle test photo (card width fitting the guide, card height fitting the guide, a 12 degree slant, and the card at 45% size), plus a blank frame, black and white stripes, and a sheet of paper with text. The photo was read in place and never copied into the repo.
- **Offline:** service worker on, first load online, then `context.setOffline(true)`, cold reload, deep links, edits, and back online.
- **Screenshots:** every screenshot named below is kept outside the repo, in `~/dev/projects/card-tracker-audit-2026-10-02/qa/shots/`.

## Summary: What a Collector Hits First

1. A wrong copy cannot be fixed: there is no way to add, remove, or edit one copy by hand, although the import report says to "pick it by hand later" (Q-01).
2. My Cards has no search; with 1,500 tiles you tap "Show more" up to 12 times to find a card (Q-02).
3. With the app open in two tabs and signed out, an edit in one tab silently erases the other tab's edit (Q-34).
4. A typo in an import's Count column (99,999) saves 99,999 copies, a 36 MB document that then syncs, with no way back (Q-08).
5. The scanner sheet prints the word "null" twice for a card it cannot find, and the Add photo sheet prints "nullnull" (Q-15, Q-31).
6. Android Back with a scan sheet or the image viewer open leaves the screen instead of closing it (Q-17).
7. In landscape, the tab bar and the raised Scan button cover the bottom row of a binder spread (Q-23).
8. A family member's view still shows your own rings, your own copies, and your edit buttons (Q-33).
9. A Weedle held at a 12 degree slant is never captured and is not found with the shutter (Q-16).
10. The floating previous and next arrows on card detail sit on top of the copies list and the Ver na Liga button (Q-03).

## Findings

### My Cards and Card Detail

**Q-01. No way to add, remove, or edit a single copy by hand**

- Severity: High. Effort: L.
- Where: every viewport, every theme, online and offline.
- Steps: import `monprice-small.csv`. The report says "Finish not resolved: 1 row. Saved with no finish; pick it by hand later." Open Mewtwo (Korean) or any card, look at Your copies.
- Expected: each copy opens an edit sheet (language, finish, condition, remove), and an unowned card offers Add, as the approved spec says (design review, "Card Detail").
- Actual: Your copies is a plain list with no actions. Copies can only be added by Scan or Import and removed only by Undo session right after a scan. A misread language, a wrong finish, a sold card, or the 99,999 copies from Q-08 cannot be corrected. The roadmap lists removing a copy as a remaining piece; the import report already promises the finish edit.
- Screenshots: `02-card-pt-sv03.5-001-full.png`, `02-card-ja-SV2a-150-full.png`.

**Q-02. My Cards has no search, and long collections page 120 tiles at a time**

- Severity: High. Effort: M.
- Where: all viewports, online and offline.
- Steps: seed 1,772 copies (1,503 tiles). Open Cards. Try to find a given card.
- Expected: "Search first, over owned cards" (design review, "Cards (Home)"), so "do I own this?" in a shop takes one field.
- Actual: only two selects (sort, language). The grid shows 120 tiles and a "Show more (1,383 left)" button; finding a card means repeated taps and scrolling. Performance itself is good (first tile in 0.5 s, 0.7 s at 4x CPU throttling; sorts under 0.25 s).
- Screenshots: `10-p360-x4-scrolled.png`, `01-cards-390.png`.

**Q-03. The previous and next card arrows cover the content under them**

- Severity: Medium. Effort: S.
- Where: 360 and 390 portrait, own cards and family view.
- Steps: open any card from My Cards, scroll so Ver na Liga or Your copies is near the bottom.
- Expected: the arrows sit clear of content, or content leaves room for them.
- Actual: two 48 px white circles float over the left and right edges, hiding the flag and the start of "English · Beedrill · Holo", and the ends of the Ver na Liga button.
- Screenshots: `12-swipe-arrows-scrolled.png`, `07-p390-family-ja-card.png`.

**Q-04. Your copies sits two screens down, under the whole price panel**

- Severity: Medium. Effort: M.
- Where: 360 x 800 and 390 x 844.
- Steps: open Charizard ex (Portuguese, owned).
- Expected: copies and Ver na Liga visible without scrolling at 360 x 740 (design review, block 6 acceptance).
- Actual: the first screen is the art, the facts, and the start of the Liga form; Your copies comes after the Liga form, the US market, and the EU market (about 1,500 px down on Bulbasaur).
- Screenshots: `02-card-pt-sv03.5-006.png`, `02-card-pt-sv03.5-001-full.png`.

**Q-05. Text is cut or wrapped at 360 px: selects, tile lines, header**

- Severity: Low. Effort: S.
- Where: 360 x 800, signed in or out.
- Steps: open My Cards, Sets with Korean viewing, and a family member's cards.
- Expected: two lines at most on tiles; selects readable.
- Actual: "Newest add..." and "Kore..." in selects; Japanese and Korean tiles run to three lines ("#006 · ポケモンカ / ード151"); the header reads "Card Tr..." with "Member A wi..." beside it.
- Screenshots: `01-cards-390.png`, `03-sets-ko.png`, `18-header-360-member.png`.

**Q-06. Portuguese catalog variants carry raw TCGdex labels**

- Severity: Low. Effort: S.
- Where: any viewport, Portuguese card pages.
- Steps: open Bulbasaur in Portuguese.
- Expected: finish names as on English pages ("Normal", "Reverse holo").
- Actual: "Normal, Padrão", "Reverse holo, Padrão", "Normal, Logo da coleção stamp, Padrão": the size label "Padrão" (Standard) is appended to every row and mixed with English words.
- Screenshot: `02-card-pt-sv03.5-001-full.png`.

**Q-07. An owned card cannot be opened while TCGdex is failing**

- Severity: Low. Effort: M.
- Where: any viewport, TCGdex answering 500, card record not cached.
- Steps: route `api.tcgdex.net` to 500, open `cards/pt/sv03.5-006` (owned).
- Expected: the copies and what the phone knows about the card, with a note that the catalog is unreachable.
- Actual: only "Could not load this card. TCGdex answered 500" and Try again; Your copies is not shown. Sets and set pages fail with a clear message and Try again, which is fine.
- Screenshot: `13-tcgdex500-cards_pt_sv03_5_006.png`.

### Import and Export

**Q-08. Import accepts any Count, and 99,999 copies save and sync**

- Severity: High. Effort: S.
- Where: any viewport, signed in.
- Steps: import `weird-rows.csv` (one row with Count 99999). The report reads "Save 100,000 copies". Tap Save.
- Expected: a count far above any real collection is flagged before saving, or capped, or confirmed loudly.
- Actual: "Saved. 99,998 added". My Cards shows "100,024 copies", the Pikachu tile reads ×99999, My Cards now takes 5.4 s to open, and the whole 36.5 MB document was pushed to the server. With Q-01 there is no way to remove them. Rows with Count 0 and unknown language are rejected correctly, and a name with HTML in it is shown as text.
- Screenshots: `15-huge-count.png`, `01-import-weird-rows.csv.png`.

**Q-09. CSV export writes Japanese names for Korean copies**

- Severity: Medium. Effort: S.
- Where: Profile, Export CSV.
- Steps: import the Korean rows, export.
- Expected: the name the app shows (이상해씨, 뮤츠), as monprice gave it.
- Actual: rows with Language `KO` carry `フシギダネ` and `ミュウツー` and the Japanese set name `ポケモンカード151`. No column carries the English name the app shows for Asian prints.
- Evidence: `data/export.csv` in the scratch folder.

**Q-10. CSV columns are inconsistent**

- Severity: Low. Effort: S.
- Where: Export CSV.
- Expected: one naming style and an explicit currency (DESIGN.md section 9: "a currency column is not optional").
- Actual: Title Case headers (`Entry ID`, `Finish Matched`) then `liga_low_nm;liga_avg;price_source;price_date`, with no currency column. The file does have a BOM, quoted names, and `="001"` numbers, as designed.

### Sets

**Q-11. Set search does not find printed set codes**

- Severity: Low. Effort: S.
- Steps: Sets, type `MEW` (or `CRI`).
- Expected: 151 (or Chaos Rising); the placeholder says "Search sets by name or code".
- Actual: "No Portuguese sets match "MEW"". Only TCGdex IDs such as `sv03.5` count as codes; collectors know the printed code.

**Q-12. Logo-less set tiles show the code twice, and segments carry no counts**

- Severity: Low. Effort: S.
- Steps: Sets in English; open 151 in Portuguese.
- Expected: "Without a logo, the name shows once, large"; segments `All 207 | Owned 9 | Missing 198` (design review, Sets).
- Actual: 30th Celebration shows "30th" large and "30th" again small. Segments read All, Owned, Missing with no numbers (Sets, Lists, and the Pokémon screen).
- Screenshots: `01-sets-390.png`, `03-set-pt-151.png`.

**Q-13. Korean viewing lists fifteen sets with the same name**

- Severity: Low. Effort: S.
- Steps: Sets, Viewing Korean.
- Actual: the newest series is Sword & Shield, opening with 15 tiles all named 트리플렛비트 (CS2b, CS2.5, CS4 ... each 101 cards). This is TCGdex data, but a Korean collector gets no hint that their Scarlet & Violet copies live under the Japanese sets (they show there as "Owned in KO").
- Screenshot: `03-sets-ko.png`.

**Q-14. Set statistics count copies but call them cards**

- Severity: Low. Effort: S.
- Steps: open 151 in Portuguese with 9 owned cards (15 copies).
- Actual: "9 / 207 owned" next to "15 cards by US estimate (~)". The Japanese 151 page says "5 / 210 owned" and "6 cards unknown". Say copies.
- Screenshot: `03-set-pt-151.png`.

### Scanner

**Q-15. The scan sheet prints "null" twice for a card it cannot find**

- Severity: Medium. Effort: S.
- Where: 390 x 844, any unmatched capture.
- Steps: open Scan with a blank frame (or paper, or a far card), press the shutter, scroll the sheet.
- Expected: no stray text where the Finish field and the duplicate line are left out.
- Actual: "null" under the language chips and again under Condition. They are text nodes in `.scan-sheet-body`, the same bug the import report had before.
- Screenshot: `08-blank-null-visible.png`.

**Q-16. A card at a 12 degree slant is neither captured nor found**

- Severity: Medium. Effort: L.
- Where: 390 x 844, Weedle photo turned 12 degrees in the frame.
- Steps: open Scan with `weedle-slant`; wait 25 s; press the shutter.
- Expected: the straightening the changelog describes copes with a hand-held tilt.
- Actual: no auto capture; the shutter gives "No card found. Name: ys RISTIS, number: unreadable". The same photo held straight is found (`me04-001`) at both framings in about 3 s from opening, with "You have 1 Portuguese Normal" and the language left for the person to pick.
- Screenshots: `08-weedle-slant-result.png`, `08-weedle-width-result.png`, `08-weedle-height-result.png`.

**Q-17. Android Back with a sheet or viewer open leaves the screen**

- Severity: Medium. Effort: M.
- Where: 390 x 844.
- Steps: (a) Scan with two cards in the tray, tap a tray card to open its sheet, press Back. (b) Card detail, tap the image for the full-screen viewer, press Back.
- Expected: Back closes the sheet or viewer (design review section 5, item 3).
- Actual: (a) the scanner closes and Profile (the previous page) opens; (b) the card page closes and the set opens. Escape does close the viewer, and the binder zoom does close with Back.
- Screenshots: `08c-after-back.png`, `11-viewer.png`.

**Q-18. Unsaved tray cards leave no mark on the Scan tab**

- Severity: Medium. Effort: S.
- Steps: scan two cards with Scan next, then leave Scan.
- Expected: a count dot on Scan so the draft is not forgotten (design review, "A draft resumes").
- Actual: the tab looks the same; the draft is only found by opening Scan.
- Screenshot: `08c-after-back.png`.

**Q-19. Non-cards enter the session, and a far card gets no advice**

- Severity: Low. Effort: M.
- Steps: open Scan with `paper` (a white sheet with text), `blank`, and `weedle-far`.
- Actual: the paper auto-captures and joins the session as "Not found" with the hint "Tilt to cut the glare". A blank frame with the shutter joins as "No card found" instead of "That did not look like a card", which the stripes frame does get. The far card is never captured and the shutter says "The collector number could not be read" instead of "Move closer".
- Screenshots: `08-paper-result.png`, `08-blank-result.png`, `08-weedle-far-result.png`.

**Q-20. Opening Scan again with a card in view adds it again**

- Severity: Low. Effort: S.
- Steps: scan a card into the tray, leave Scan and come back (or reload) with the same card still in front of the camera.
- Actual: each return auto-captures it again: the tray went from 2 to 3 to 4 Weedles. Within one visit the same still card is correctly not taken twice.
- Screenshot: `08c-tray-two.png`.

**Q-21. For an unfound card, the language chips lead with Asian languages**

- Severity: Low. Effort: S.
- Steps: any unmatched capture.
- Actual: Japanese, Korean, Chinese (Simplified), Chinese (Traditional), More. Portuguese and English, the two most common languages here, are behind More. Found cards show English, Portuguese, Japanese, Korean.
- Screenshot: `08-blank-result.png`.

### Binders

**Q-22. Long notes stretch the spread, and the page turn distorts**

- Severity: Medium. Effort: M.
- Where: 390 x 844, notes of 450 characters (the field allows 500).
- Steps: create a binder with long notes, open it, slow animations to 10%, tap the next arrow.
- Expected: the inside cover clips or scrolls its text and the spread keeps the binder's shape.
- Actual: the inside cover grows to fit the notes, so the spread is about twice as tall as a page; page 1's pockets stretch tall during the turn, page 3 fills only the top half with navy below, and the spread jumps back to its normal height when the leaf lands. Notes also break mid-word ("win dow"). With short notes the v21 turn is clean at every size.
- Screenshots: `04-p390-binder-open-full.png`, `04-p390-turn-montage.png`, `04-p360-short-turn-montage.png`.

**Q-23. In landscape the tab bar covers the bottom of the spread**

- Severity: Medium. Effort: M.
- Where: 844 x 390.
- Steps: open a binder sideways.
- Expected: the full spread is editable, which is why the header stops sticking.
- Actual: at the top of the page the spread starts at y 218 and the tab bar at y 325, so only the top third shows. Scrolled down, the third row of pockets still runs under the tab bar, and the raised Scan button covers the inner bottom pockets of both pages. Rotating mid-turn is handled well (the turn finishes and the spread switches to direct mode).
- Screenshots: `16-landscape-top.png`, `04-land-short-after-place.png`, `16-rotated-during-turn.png`.

**Q-24. The empty-binder hint says "Tap a pocket" in portrait**

- Severity: Low. Effort: S.
- Actual: "Nothing in this binder yet. Tap a pocket to place a card you own" while portrait pockets are inert until the page is tapped to zoom. Loose end confirmed.
- Screenshot: `04-p390-short-binder-open-full.png`.

**Q-25. Small touch targets on the binder screen and card back links**

- Severity: Low. Effort: S.
- Actual: page arrows 32 x 52 px, "Got it" 72 x 40 px, the card page back link "‹ 151" 31 px wide (spec asks 48 px).

**Q-26. The pocket picker focuses the search field on open**

- Severity: Low. Effort: S.
- Steps: zoom a page, tap a pocket.
- Actual: focus lands in "Search your cards", so on a phone the keyboard rises over the card list most people scroll instead.
- Screenshot: `04-p390-short-pocket-sheet.png`.

### Lists

**Q-27. Once languages are saved there is no way back to "All"**

- Severity: Low. Effort: S.
- Steps: open Kanto (shows "All, counts copies in any language"), Edit, tick every language, Save.
- Actual: the list now reads "+4 | Portuguese, English, French, Japanese, Korean, Chinese (Simplified), Chinese (Traditional)"; there is no All option, and unticking all is refused ("Pick at least one language"). Loose end confirmed.
- Screenshot: `13-list-all-langs.png`.

**Q-28. Small layout slips in Lists and the Pokémon screen**

- Severity: Low. Effort: S.
- Actual: in the languages editor the two Chinese checkboxes shrink when their labels wrap. The Pokémon screen lists 皮卡丘 twice (Simplified and Traditional are the same).
- Screenshots: `05-p390-lang-edit.png`, `05-p390-pokemon-pikachu.png`.

### Prices and Photos

**Q-29. The Liga form accepts any amount**

- Severity: Low. Effort: S.
- Steps: Charizard ex, Lowest NM `99999999999`, Average `1`, Save.
- Actual: saved as R$ 99.999.999.999,00 with a lowest price above the average, and set totals use it. Letters, negatives, and zero are rejected with a clear message.
- Screenshot: `12-liga-saved.png` (after a valid save).

**Q-30. Ver na Liga appears for a Korean copy on a Japanese record**

- Severity: Low. Effort: S.
- Steps: own a Korean copy of Japanese `M6-010` with no monprice name (as a scan saves it), open it.
- Expected: "No Liga link for Korean prints", as imported Korean copies show.
- Actual: the Japanese Ver na Liga button shows, while the EU line says "not one for this Korean printing".
- Screenshot: `17-twins-M6-010.png`.

**Q-31. The Add photo sheet shows "nullnull"**

- Severity: Medium. Effort: S.
- Steps: card detail of an owned card, Add photo.
- Actual: the line under the title reads "nullnull" (the copy description is missing when there is one copy). The crop that follows works well: the card in the Weedle photo was found and squared.
- Screenshots: `12-photo-sheet.png`, `12-photo-crop.png`.

**Q-32. "Waiting to upload" on photos while signed out**

- Severity: Low. Effort: S.
- Actual: a photo added signed out carries a "Waiting to upload" badge that never clears, since nothing uploads without an account.
- Screenshot: `12-photo-after.png`.

### Family View

**Q-33. The family view shows your data and your edit buttons**

- Severity: Medium. Effort: M.
- Where: 390 x 844, Owner viewing Member A.
- Steps: Mine, Member A's. Open Sets; open Member A's Japanese Pikachu.
- Expected: Sets rings show Member A's cards; edit controls hidden (design review, "Family Read-Only Mode").
- Actual: Sets shows the Owner's "Chaos Rising 3 / 122" though Member A owns none there. The card page says "Your copies (1)" with the Owner's own copy, plus Add photo, Main image, and the Liga price form. Member A's cards, binders, wishlist (priority, note as plain text), and Done all work, and Member A's Japanese entries show English names and twin images.
- Screenshots: `07-p390-family-sets.png`, `07-p390-family-ja-card.png`, `07-p390-family-cards.png`.

### Account and Sync

**Q-34. Two tabs signed out: one tab's edit erases the other's**

- Severity: High (data loss, signed out only). Effort: M.
- Where: two tabs of the same browser (on Android the installed app and a Chrome tab share this storage).
- Steps: signed out, open My Cards in tab A and tab B. Add a card in A. A few seconds later add a different card in B. Reload.
- Expected: both cards kept.
- Actual: A's card is gone from the phone (IndexedDB read directly). Each tab holds its own copy of the document in memory and writes all of it back; tab B also never shows A's change. Signed in, the server merge brought A's card back, so the loss is limited to signed-out use, or an edit whose tab closes before it syncs (not reproduced).
- Screenshot: `14-two-tabs-signed-out.png`.

**Q-35. A revoked session leaves the app stuck with "permission denied"**

- Severity: Medium. Effort: M.
- Steps: signed in, the server stops accepting the session (token and refresh refused), add a card.
- Expected: "Sign in again" with the waiting change kept.
- Actual: the header reads "Not saved, 1 change waiting" with the raw title "permission denied"; Profile still shows the account as signed in with "Error: permission denied" and "The family group could not be read". Nothing offers to sign in again.
- Screenshots: `07-p390-revoked.png`, `07-p390-revoked-profile.png`.

### Accessibility

**Q-36. Tile names repeat the card name**

- Severity: Low. Effort: S.
- Actual: the accessibility tree reads tiles as "Bulbasaur 3 copies Owned Bulbasaur #001 · Owned" and "Mewtwo Printed in Korean 2 copies Mewtwo 뮤츠 (Myucheu) #150 · 포켓몬 카드 151": the image alt repeats the name. Icon buttons are otherwise well named ("Turn the page", "Previous card", "This one: Antique Jaw Fossil").

**Q-37. 200% zoom and large text**

- Severity: Low. Effort: M.
- Actual: at 200% page zoom (195 px wide) Profile scrolls sideways (272 px content); other screens fit. With 200% text, My Cards keeps three columns and names shrink to "Mewt...", "Bulba...", and the page overflows to 438 px at 390.
- Screenshots: `11-zoom200-profile.png`, `11-text200-cards.png`.

**Q-38. Theme swatches move each time a theme is chosen**

- Severity: Low. Effort: S.
- Actual: the preview's height changes per theme, so the swatch grid shifts 10 to 20 px after every pick; a quick second tap can land on the wrong swatch. With a mouse, the hover preview can then show the swatch now under the pointer instead of the chosen one. Contrast is fine: every text role checked passed 4.5:1 in all twelve themes, light and dark.
- Screenshots: `06-themes-light-montage.png`, `06-themes-dark-montage.png`.

## Suspected (Not Reproduced)

- Leaving Import while it says "Saving..." seemed to drop the whole import once (26 copies afterwards, nothing on the server); a second run that waited saved normally.
- Signed in and offline, two tabs could lose an entry if the stale tab is the one left open and the other closes before reconnecting (follows from Q-34; not run).
- Another phone keeping a deleted binder's cover (roadmap loose end): not tested, the fake has no storage bucket in these runs.

## Coverage

| Flow | Tested | Result |
| --- | --- | --- |
| My Cards: sort, language filter, Stats, tiles, flags, ×N | Yes | Works; no search (Q-02); truncation (Q-05) |
| Card detail, swipe between cards | Yes | Swipe works both ways; arrows cover content (Q-03); copies low (Q-04) |
| Zoom and compare viewer | Partly | Opens, traps focus, Escape closes; Back leaves (Q-17); Compare not exercised |
| Own photos: add, crop, carousel | Yes | Crop found the card; "nullnull" (Q-31); badge (Q-32) |
| Sets: seven languages, series, All/Owned/Missing, rings | Yes | Works; Korean data (Q-13); search codes (Q-11) |
| Scan: auto capture, tray, draft, Set for all, Undo, check-only, duplicates | Yes | Weedle found at both framings; double-tap Save saves once; Undo exact; Discard saves nothing; Q-15 to Q-21 |
| Scan: family wishlist alert, finish picker | Partly | Finish chips seen; wishlist alert left to the existing suite |
| Binders: presets, notes, cover color, placeholders, spread, turn, zoom, place | Yes | Clean at 360, 390, 412, landscape, desktop with normal notes; Q-22, Q-23 |
| Binders: cover image upload | No | Needs the storage fake; covered by the suite |
| Binders: old links, delete (also offline), empty hint | Yes | `binders/<id>/5` opens pages 4 and 5; offline delete syncs |
| Lists: Kanto, custom, hand ticks, Missing offline, languages Edit | Yes | Works offline; Q-27, Q-28 |
| Pokémon screen from a checklist | Yes | Works; first visit made 48 API and 23 image requests (Pikachu) |
| Wishlist: add, priority, note, duplicate add | Yes | Works; adding the same card twice keeps one; HTML in notes shown as text |
| International twins: My Cards, card page, confirm prompt | Yes | Confirm shows three candidates; set tiles do not use twins (loose end) |
| Prices: Liga form, US and EU in R$, tiles, stats, CSV | Yes | Works; Q-29; CSV Q-09, Q-10 |
| Themes: twelve, light and dark, favorite suggestion | Yes | All contrast checks pass; Gengar suggests Psychic and applies; Q-38 |
| Profile: import CSV and JSON, twice, export CSV | Yes | Re-import adds nothing; JSON matches CSV keys; bad files explained |
| Profile: Share CSV | No | `navigator.canShare` absent in headless Chromium, button hidden |
| Phone check | Partly | Page opens; camera and storage tests not run |
| Family: Mine switcher, view only, Japanese entries, wishlist, Done | Yes | Works; Q-33 |
| Name and password: wrong, unknown, empty, full address, change password | Yes | Same message for wrong and unknown; native required-field check; password rules clear |
| Google and email link screens | Yes | Both complete against the fake |
| Sign out and back in, shared phone | Yes | Signing out keeps the cards on the phone; another account signing in on that phone does not receive them |
| Revoked session | Yes | Q-35 |
| Offline: cold reload, deep links, edits, back online | Yes | Every cached screen opens; uncached ones explain; 2 changes synced on reconnect |
| Large collection (1,772 copies) | Yes | Fast, also at 4x throttling; Q-02 |
| Breaking: double taps, Back, rotation, long and HTML text, counts, two tabs, slow and failing TCGdex | Yes | No script injection anywhere; Q-08, Q-17, Q-22, Q-34 |
| Accessibility: focus order, traps, names, targets, reduced motion, zoom | Yes | Visible 3 px focus ring; pocket sheet is a modal dialog; reduced motion crossfades the turn; Q-25, Q-36, Q-37 |

## Roadmap Loose Ends

| Item | Status | Note |
| --- | --- | --- |
| Scanner: Weedle real-card test | Confirmed | Fake camera only: sure `me04-001` at both framings, about 3 s from opening, OCR about 0.4 s headless. Real phone still owed. |
| Scanner: strong slant cut at the weakness row | Confirmed | A 12 degree in-plane slant already fails (Q-16). |
| Scanner: regular vertical stripes pass the presence check | Confirmed | Stripes auto-captured once; the next step then said "That did not look like a card". |
| Scanner: commit the benchmark into `lab/` | Confirmed | `lab/js` has no benchmark files. |
| Binders: empty hint says "Tap a pocket" | Confirmed | Q-24. |
| Binders: action buttons no longer stick | Confirmed | Edit, Cover image, Delete sit below the spread in the page flow. |
| Binders: new binders default to 40 pages | Confirmed | Every preset fills 40. |
| Binders: old `binders/<id>/<page>` links | Confirmed | Page 5 opens `?spread=3` (pages 4 and 5). |
| Binders: another phone keeps a deleted cover | Confirmed (not retested) | Not exercised here; no storage fake in these runs. |
| Binders: landscape Scan button over the spine | Changed | Worse than described: the whole tab bar covers the bottom pocket row (Q-23). |
| Pokémon screen: no `languages` field shows "All" and counts any language | Confirmed | Kanto: "All, counts copies in any language", 13 / 151 from five languages. |
| Pokémon screen: no way back to "All" | Confirmed | Q-27. |
| Pokémon screen: first visit's Asian catalog requests | Confirmed | Pikachu's first visit: 48 TCGdex and PokeAPI requests, 23 images; cached after. |
| Pokémon screen: owned rows link to the Pokémon screen | Confirmed | Rows open `lists/<id>/pokemon/<n>`; the circle ticks by hand. |
| Twins: Ver na Liga on a Japanese Trainer | Confirmed | Japanese Erika's Invitation builds `card=Erika's Invitation (161/165)` from the twin's English name and the Japanese number. English 151 has Erika at 160/165 and Giovanni's Charisma at 161/165, so this only works if Liga's Japanese page uses the Japanese number. Japanese 151 Pokémon build the same text as the English card (Pikachu 025/165), so they depend on Liga's edition picker. Not checked against Liga. |
| Twins: set detail tiles do not use twins | Confirmed | Japanese 151 set shows エリカの招待 with no English name. |
| Twins: no test opens a family member's Japanese entries | Confirmed | Still no test; by hand it works (English names, twin images, Japanese Liga link). |
| Twins and the Pokémon screen each fetch their own set list | Confirmed | Two separate requests and caches in the code (`twins.js`, `pokemon-cards.js` `SETS_QUERY`). |
| Twins: Japanese M6 has no English counterpart | Confirmed | `M6-010` shows no twin image; the English name comes from the dex. |

## Things That Work Well

- **Offline is solid.** After one online visit, a cold reload in airplane mode opened My Cards, cached sets, cards, binders, lists with the Missing filter, and Profile; uncached sets and cards say plainly that they download next time. Hand ticks and a binder deletion made offline synced on reconnect.
- **No injection anywhere.** HTML and script in binder names, notes, list names, wishlist notes, display names, and import names were always shown as text.
- **Import is careful.** A clear match report before saving, re-imports that add nothing (CSV and JSON agree on keys), and plain explanations for a non-monprice CSV and broken JSON.
- **The v21 page turn** is smooth and lands without a jump at 360, 390, 412, landscape, and desktop (with normal notes); rotating mid-turn is handled; reduced motion crossfades instead.
- **Scanner on the Weedle photo:** found at both framings, duplicates counted, double-tapped Save saves once, Undo session removes exactly what was saved, Discard writes nothing, the draft survives a reload.
- **Sign-in:** one message for a wrong password and an unknown name, password rules spelled out, a full `@family.invalid` address accepted, and a shared phone keeps each person's cards apart.
- **Themes:** all twelve themes pass contrast in light and dark, and the favorite Pokémon suggestion applies the matching theme.
- **Performance:** 1,772 copies open in about half a second and stay smooth at 4x CPU throttling.
- **Prices** are honest: every estimate is marked "~", the rate and its date are shown, unknown prices are left out of totals, and Asian prints say which market a price belongs to.
