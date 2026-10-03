# Whole-App Audit: Merged and Prioritized

- **Date:** 2026-10-02, at version 21 (commit `02afb5a`).
- **Sources:**
  - `plans/audit-engineering.md`: E-01 to E-38, by a staff software engineer.
  - `plans/audit-qa.md`: Q-01 to Q-38, by a senior QA tester who collects cards.
  - `plans/audit-verify.md`: a second engineer reproduced the engineering findings that were only read in code, and re-rated several.
  - `plans/sync-merge-plan.md`: a commit-by-commit design for the sync block (B below).
  - Eric's notes from the same session: N-01 to N-06.
- **Scope:** report only. Nothing in the app changed. Eric chooses what gets fixed.

**Severity:**
- **Critical:** data loss, a security hole, or the app unusable. None found.
- **High:** a common flow broken, or wrong data shown.
- **Medium:** an edge case wrong, confusing UX, a clear visual bug, or slowness that bites.
- **Low:** polish.

**Effort:** S is under 1 hour, M is 1 to 4 hours, and L is more than 4 hours. Where verification changed a rating, the verified one is shown.

**What holds up:**
- All 28 suites pass (528 tests).
- No HTML is built from strings, and no injection was possible anywhere.
- Row-level security and storage policies match the client.
- No secrets are committed.
- Offline works: cold reload, deep links, and edits that sync on reconnect.
- 1,600 to 1,772 copies open in about half a second, also at 4x CPU throttling.
- All twelve themes pass contrast in light and dark.
- The v21 page turn is clean at every size with normal notes.
- The Weedle photo is a sure `me04-001` at both framings.

## Status

Updated 2026-10-03 with version 26 (`adc0e7b`): block C done (plan commits 8 to 11 and 13; 12, the clock offset, skipped), the remaining Low items done except a residual 15 px swatch shift and Q-30, scanner round 3 (border edges on light tables, sure by lead, Asian language default, Clear), the sw.js per-folder CORS memory, and the Phone check scan report switch. Still open: block H (shared modules), Q-19, Q-20, and real-phone checks of the scanner.

Updated 2026-10-03 with version 23 (`b0bbbd1`). v23 added block F, block J (except the optional sw.js part of E-20), most of block I (Q-16, Q-21, stripes, the benchmark in `lab/bench/`, plus a scan report and Pick a photo), N-07 (copy stepper), and N-08 (Poké Ball Scan disc).

Still open after v23: block C, block H, the remaining Low items, Q-19 (rejecting paper on the shutter, Move closer), Q-20 (re-adding the same card after a return), full-art number reads (the Ampharos SIR's outlined digits), the artwork-first recognizer (prototype in progress), the sw.js per-folder CORS memory for E-20, a Profile switch for the scan report, and `sheets-browser`, which flakes two random tests per run on this machine (v22 too).

Earlier status, with version 22 (`0b718b7`):

**Done in v22:**
- **Block A:** all items.
- **Block B:** plan commits 1 to 6 (deterministic import ids with the repair, sticky deletes, forward-only stamps, wish dedupe, delayed bucket deletes), plus Q-34, Q-08, E-13 (the `="..."` wrapper), and E-37.
- **Block D:** all items. Back closes Add photo, Cover image, the scan sheets, the viewer, and the binder pocket sheet.
- **Block E:** Q-01, Q-02, Q-04, Q-06, Q-07, Q-30, N-04, N-05, and N-06, plus Add to wishlist on card detail.
- **Block G:** all items, including N-02 and N-03.

**Still open:**
- **Block C**, the v23 half of the sync plan.
- **Block F:** Q-33, Q-35, N-01, E-07, and Q-32.
- **Blocks H, I, and J**, and the remaining Low items.
- **Follow-ups found while fixing:**
  - The "Whose cards" sheet still leaves the screen on Back. Moving it onto `openDialogSheet` needs care, because picking a person closes the sheet and changes route at once.
  - The wishlist screen's finish labels still show raw Portuguese words (`variantLabel` in `js/wishlist.js`).
  - Copy removal holds for 8 seconds for Undo, because `js/collection.js` has no `restoreCard`. "Remove all N" saves once per copy; a `deleteCards(ids)` export would fix that.
  - `priceSection` draws its own Ver na Liga, which `css/copies.css` hides on card detail. A `ligaLink: false` option in `js/price-view.js` would be cleaner.
  - The app's own CSV export still cannot be imported back: its columns differ from monprice's, so it needs its own reader (roadmap step 2).
  - Japanese and Korean tile meta lines still wrap to three lines at 360 px (Q-05, tiles part).
  - There is no bulk way to add unplaced cards to a binder's tray.
  - The first background price fill sends about one TCGdex request per international card, two at a time, then only weekly refreshes. TCGdex's GraphQL has no prices.

## Top 12, in the order I would fix them

| # | Item | Severity | Effort | Sources |
| --- | --- | --- | --- | --- |
| 1 | Importing on a second phone (or signed out, then signing in) doubles every card, and nothing undoes it | High | M, plus a repair step (about 9 h with tests) | E-14, E-37 |
| 2 | Import accepts any Count: one row with 99,999 saved a 36.5 MB document that synced | High | S | Q-08 |
| 3 | No way to add, remove, or edit one copy by hand, so a wrong language or finish, a sold card, or #2 cannot be undone | High | L | Q-01 (roadmap step 2) |
| 4 | Two tabs open while signed out: one tab's edit erases the other's | High | M | Q-34 |
| 5 | My Cards has no search, so a 1,500-tile collection is found 120 tiles at a time | High | M | Q-02 |
| 6 | A delete loses to a later offline edit, so deleted cards, binders, lists, and photos come back (photos as broken images) | Medium | M (about 11 h in the sync plan) | E-16 |
| 7 | Android Back leaves sheets and viewers open, or leaves the screen behind them; the camera keeps running; Save after Back writes to the previous card's copy | Medium | M | E-02, E-03, Q-17, verify |
| 8 | A family member's view shows your rings, "Your copies", and your edit buttons | Medium | M | Q-33 |
| 9 | The Pokémon screen with "Count every finish" rebuilds its grid once per record: about 255 rebuilds and 12.6 s for a 250-print Pokémon | Medium | S | E-26, verify |
| 10 | Landscape binder: the spread runs under the tab bar, and the Scan button covers the spine | Medium | M | Q-23, verify |
| 11 | The public repo names a family member and their sign-in name (`plans/roadmap.md:18`), already in git history | Medium | S, plus a decision on history | E-22 |
| 12 | Stray "null" in the scan sheet and "nullnull" in Add photo | Medium | S | Q-15, Q-31 |

## Fix Blocks

Blocks group items that touch the same files, so one agent can take a block with clear boundaries. Hours are rough.

### A. Quick wins (about 10 to 12 h, all S)

Each item is small and independent. A good first release.

| Item | Severity | Effort | Sources |
| --- | --- | --- | --- |
| Cap or confirm huge import counts; cap the Liga form's amounts and refuse lowest above average | High | S | Q-08, Q-29 |
| "null" and "nullnull" text | Medium | S | Q-15, Q-31 |
| Pokémon screen: one draw per animation frame; keep finish records across visits | Medium | S | E-26 |
| Checklists: check the cache for every card, and count only network reads against the 300 limit | Medium | S | E-04 |
| Lists: an "Any language" choice, and stop dropping de, es, it, and no-language copies | Medium | S | E-05, Q-27 (ties to the Open Decision on list languages) |
| Service worker: wait for Reload instead of taking over; always offer Reload after an update | Medium | S | E-19, verify |
| CSV export: Korean copies get their Korean names | Medium | S | Q-09 |
| Card detail: the previous and next arrows stop covering the copies list and Ver na Liga | Medium | S | Q-03 |
| A count dot on the Scan tab while a draft tray holds cards | Medium | S | Q-18 |
| Remove the family member's name from the roadmap | Medium | S | E-22 |
| CSV re-import strips the `="..."` wrapper | Low | S | E-13 |
| `checklistView` added to `ACCOUNT_ROUTES` | Low | S | E-10 |
| Empty-binder hint matches portrait ("Tap a page, then a pocket") | Low | S | Q-24 |
| Binder colours from a document pass through `isHex` | Low | S | E-25 |
| `reset-password.sql` also ends existing sessions; `shouldCreateUser: false` on email sign-in | Low | S | E-23, E-24 |
| Unscoped `.sheet-head` rule in `css/binders.css` | Low | S | E-35 (part) |

### B. Sync you can trust: release v22 (about 23 h, plus Q-34)

The design is in `plans/sync-merge-plan.md`, commits 1 to 7. Every rule is one a v21 phone accepts, so a mixed family keeps working.

| Item | Severity | Effort | Sources |
| --- | --- | --- | --- |
| Import ids derived from the import key (UUIDv5), plus an automatic repair that collapses doubled copies into the oldest one, keeping photos, prices, notes, and binder pockets | High | M (about 9 h) | E-14, E-37 |
| Two signed-out tabs: reload the document before each save, or one writer through a BroadcastChannel lock | High | M | Q-34 |
| Sticky deletes: a deleted thing stays deleted unless restored on purpose; bucket files are deleted only after the server holds the delete, plus a grace period | Medium | M (about 11 h) | E-16, E-21 |
| Stamps that always move forward, so a slow phone clock cannot lose a later edit | Medium | S | E-16 |
| The same wish added on two phones merges into one | Low | S | E-17 |
| Tests for the monprice parser and import | Medium | M | E-37 |

### C. Merging edits field by field: release v23 (about 20 h)

`plans/sync-merge-plan.md`, commits 8 to 13. Binder pockets, hand ticks, a copy's photos, and its Liga price merge item by item, so edits on two phones both survive.

| Item | Severity | Effort | Sources |
| --- | --- | --- | --- |
| Field-by-field merge with a fallback for v21 phones, and a way to stop an outdated app from syncing | Medium (verified down from High: it needs the same person editing the same entry on two phones with one offline) | L | E-15 |

A binder resize must bump a layout version, so pockets from two different grids never mix (see N-02).

### D. Back button, sheets, and cameras (about 6 to 8 h)

One shared sheet helper fixes these together, instead of four copies.

| Item | Severity | Effort | Sources |
| --- | --- | --- | --- |
| Back closes the open sheet or viewer (Add photo, Cover image, scan sheet, image viewer) | Medium | M | E-02, Q-17 |
| The camera always stops: Back during start, a failed `play()`, a hidden page during start, a double start | Medium | S | E-03, verify |
| Save after Back no longer writes to the previous card's copy | Medium | S | verify (read in code) |
| A shared `js/sheet.js` (open, close, focus trap, close on route change) | Medium | M | E-33 (part) |
| Errors stay visible after a second failure; benign background failures stop showing the red banner | Low | S | E-09 |

### E. Copies, search, filters, and card detail (about 15 to 20 h)

This overlaps roadmap step 2.

| Item | Severity | Effort | Sources |
| --- | --- | --- | --- |
| Edit a copy (language, finish, condition) and remove it; Add on an unowned card | High | L | Q-01 |
| Search over owned cards on My Cards | High | M | Q-02 |
| One filter bar for My Cards and the binder's card picker (later the tray and the wishlist): region or generation, energy type, category (Pokémon, Trainer, Energy), set, language, rarity, and not in a binder yet; sort by name, Pokédex number, set and number, date added, or price. It needs `dexId`, `types`, `category`, and `rarity` added to the card index, with one cached GraphQL request per owned set | Medium (a feature) | L (5 to 8 h with the search) | N-04, Q-02 |
| Tiles show a price only for cards whose page was opened: the US estimate lives in the full TCGdex record, which is saved only by card detail or the import. Fill the missing full records in the background for owned international cards (a few at a time, refreshed about weekly), in the same pass as N-04's data step; tiles with no market price say so instead of looking unfinished. Japanese, Korean, and Chinese prints have no market price in TCGdex, so only a typed Liga price fills them | Medium | M | N-05 |
| The Stats panel opens in the middle of My Cards and its totals, average, min, and max cover only the copies that happen to have a price. Replace it with a small "Value" button in the toolbar that opens a sheet (reusable from the Trade view later), led by coverage ("Priced: 412 of 1,600 copies", how many are Asian prints with no market price, how many still need a price), with totals labeled "of the priced copies" and a link to the unpriced list | Medium | S (M with N-05) | N-06 |
| Your copies and Ver na Liga near the top of card detail | Medium | M | Q-04 |
| An owned card opens with its copies while TCGdex is down | Low | M | Q-07 |
| Truncated selects and three-line tiles at 360 px | Low | S | Q-05 |
| Portuguese finish labels without "Padrão" | Low | S | Q-06 |

### F. Family view and account (about 6 to 8 h)

| Item | Severity | Effort | Sources |
| --- | --- | --- | --- |
| Family view shows the member's rings and copies, and no edit buttons | Medium | M | Q-33 |
| A revoked session offers "Sign in again" and keeps waiting changes | Medium | M | Q-35 |
| The "Whose cards" sheet and chip show each person's favorite Pokémon instead of a letter | Low | S for your row, M for members (read only their favorite, not their whole document) | N-01 |
| Refused photo uploads say why, with Retry and Remove; no "Waiting to upload" while signed out | Low | S | E-07, Q-32 |

### G. Binders (about 12 to 18 h)

| Item | Severity | Effort | Sources |
| --- | --- | --- | --- |
| Landscape spread fits above the tab bar, clear of the Scan button | Medium | M | Q-23, verify |
| Long notes no longer stretch the spread or distort the turn | Medium | M | Q-22 |
| Resize: rows and columns keep their places when the grid grows; reflow in reading order only when a card would fall out; placeholders move with the cards; pages added when needed; a preview in the app's own sheet instead of the native confirm | Medium | M | N-02 |
| A per-binder tray of unplaced cards: thumbnails above the tab bar, tap to pick and tap a pocket (drag in landscape and on desktop), and "Fill the rest in order". Cards that fall out on a resize land there, and "Empty into the tray" is a third resize choice | Low (a feature) | L | N-03 |
| The placeholder search uses the shared card search (no Pocket cards, works offline, real set names) | Medium | S | E-32 |
| Covers that arrive later repaint (`onCoversChange`); other phones drop deleted covers | Low | S | E-36, E-21 |
| Touch targets of 44 px; the pocket picker does not raise the keyboard | Low | S | Q-25, Q-26 |
| New binders default to 40 pages, and every preset is 40 | Low | S | roadmap (decide whether to keep) |

### H. Shared modules and cleanup (about 10 to 14 h)

Do this before more features, so future fixes are made once.

| Item | Severity | Effort | Sources |
| --- | --- | --- | --- |
| One TCGdex module: three set-list implementations and four fetch helpers become one | Medium | M | E-29 |
| One IndexedDB cache helper instead of ten openers | Medium | M | E-30 |
| One language table instead of seven (it causes E-05 and E-12) | Medium | M | E-31 |
| Camera, edge-finding, and warp code move out of `lab/` into `js/vision/`; one corner editor | Medium | L | E-33 (rest) |
| Shared `format.js` and `stamp.js` | Low | S | E-34 |
| `css/binders.css`, `css/wishlist.css`, and the corner handles onto design tokens | Low | M | E-35 |
| Delete dead exports, `.wl-badge-on`, and the `lab/js/ocr.js` precache | Low | S | E-36, E-21 |
| Record the two suites that call the live TCGdex into fixtures | Low | S | E-38 |
| `pokemon-cards-browser` is flaky under load: in a full 28-suite run on 2026-10-02 it saw four unexpected `en/sets/<id>` requests (`tests/pokemon-cards-browser.test.mjs:492`), then passed alone. Find which module fetches those sets in the background (likely one of the duplicate set lists, E-29) | Low | S | release check |

### I. Scanner (L, after Eric's real-card test)

| Item | Severity | Effort | Sources |
| --- | --- | --- | --- |
| A card at a 12 degree slant is neither captured nor found | Medium | L | Q-16 |
| Paper and blank frames join the session; a far card gets no "Move closer" | Low | M | Q-19 |
| Opening Scan again with the same card in view adds it again | Low | S | Q-20 |
| Unfound cards lead with Asian languages; Portuguese and English hidden behind More | Low | S | Q-21 |
| Regular vertical stripes pass the presence check | Low | S | roadmap |
| Commit the benchmark (`/tmp/scan-bench`, still present) into `lab/` | Low | S | roadmap |

### J. Performance and network (about 8 h)

None of this is urgent at 1,600 copies.

| Item | Severity | Effort | Sources |
| --- | --- | --- | --- |
| Portuguese and French images: TCGdex sends a doubled CORS header, so only 100 are kept offline; fall back to the English image offline and report the header upstream | Medium | M | E-20 |
| Whole documents move for small changes; the family wishlist cache downloads every member's whole collection at each start | Medium | M | E-18 |
| A hand tick redraws twice and rebuilds the tick set per row | Low | S | E-27, verify |
| My Cards reloads on every save; the card index is parsed whole several times | Low | M | E-28 |
| Overlapping loads can show stale data (run counters) | Low | S | E-08 |
| A checklist or Pokémon screen opened before its list syncs stays on "not here" | Low | S | E-01 |

### Remaining Low items

These can go into any block that touches the same file:
- **Ver na Liga:** a promo flag per catalog for Japanese SM1p to SM5p and SV-P / M-P (E-06); no button for Korean copies on Japanese records (Q-30).
- **Prices and display:** US-style amounts, tile prices across finishes, and copies with no finish (E-11); raw language codes, missing set names, and rejected twins never rechecked (E-12).
- **Sets:** search by printed code such as MEW (Q-11); the code shown twice, and counts on All, Owned, Missing (Q-12); Korean viewing hint (Q-13); "copies", not "cards" (Q-14).
- **Export:** consistent CSV headers and a currency column (Q-10).
- **Lists:** checkbox shrink and the duplicate 皮卡丘 (Q-28).
- **Accessibility:** tile names said twice (Q-36); 200% zoom and text (Q-37); theme swatches shifting (Q-38).

## Roadmap Loose Ends

Both audits checked every bullet. Each status in the table is one of three:
- **Confirmed:** still true.
- **Changed:** true in a different form.
- **Fixed:** no longer true.

| Item | Status |
| --- | --- |
| Scanner: real-card test | Still owed (fake camera passes) |
| Scanner: strong slant cut at the weakness row | Confirmed, and worse: 12 degrees already fails (Q-16) |
| Scanner: stripes pass the presence check | Confirmed |
| Scanner: benchmark not in `lab/` | Confirmed; the files are still in `/tmp/scan-bench` |
| Binders: "Tap a pocket" hint | Confirmed (Q-24) |
| Binders: action buttons no longer stick | Fixed, still holds |
| Binders: 40-page default | Confirmed |
| Binders: old `binders/<id>/<page>` links | Confirmed working; nothing builds them any more |
| Binders: other phones keep a deleted cover | Confirmed in code (E-21) |
| Binders: landscape Scan button over the spine | Changed: the whole spread runs under the tab bar (Q-23) |
| Lists: no `languages` shows "All" | Confirmed |
| Lists: no way back to "All" | Confirmed; ticking every box does not count the same, it drops de, es, it, and no-language copies (E-05) |
| Lists: first visit's Asian requests | Changed: per Japanese or Chinese (Traditional) set, not Korean |
| Lists: owned rows link to the Pokémon screen | Confirmed |
| Twins: Ver na Liga on a Japanese Trainer | Builds `Erika's Invitation (161/165)` from the twin's English name and the Japanese number, as DESIGN.md section 10 says. Still unverified against Liga's Japanese pages |
| Twins: set tiles do not use twins | Confirmed |
| Twins: no test of a member's Japanese cards | Confirmed (works by hand) |
| Twins: two set lists | Changed: three (E-29) |
| Twins: `M6` has no English counterpart | Confirmed; `ko|` catalog entries are never matched, and the recheck runs only when My Cards opens |

## Decisions for Eric

1. **What to fix first.** I suggest A (quick wins), then B (sync, v22), then D and E. C, the v23 merge, can wait until B has run for a while.
2. **E-22:** replace the family member's name in the roadmap. Rewriting git history means a force push on a public repo. The alternative is to accept that it is already out and ask them to use a strong password.
3. **The sync plan's questions** (`plans/sync-merge-plan.md`, section 8):
   - survivor for duplicates: the oldest copy is recommended;
   - grace period before bucket deletes: 14 days proposed;
   - whether to install the server's minimum-version gate, and when;
   - a "Recently deleted" screen, or deletes are permanent;
   - two releases or one;
   - correct a skewed phone clock automatically, or only warn.
4. **Open Decision on list languages:** apply it only together with the single language table (H), or it drops de, es, it, and no-language copies from every list.
5. **Binder resize (N-02) and the tray (N-03):** which behaviors to build, and whether the 40-page default stays.
