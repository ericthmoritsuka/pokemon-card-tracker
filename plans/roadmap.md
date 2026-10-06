# Roadmap and Handoff

Written 2026-10-01 at the end of a long build day and updated 2026-10-02 after versions 15 to 21 and the whole-app audit,
so the next session can continue without the old conversation. Read this first, then `CHANGELOG.md` (what is live and when) and `DESIGN.md`
(requirements and decisions, with their reasons). `plans/design-review.md` is the approved UI
spec; `plans/product-plan.md` and `plans/ux-plan.md` are the earlier plans.

## State Right Now

- **Live:** version **v30** at https://ericthmoritsuka.github.io/pokemon-card-tracker/ (v30 `acb42f7` adds Want on a family member's card, the Value button on sets, checklists, and binders, the binder placeholder notice at scan, the Liga link fixes, and retires checklist hand ticks; v29 `31e9329` added collections and set and artist goals; v28 added the Trade view, favorites, hand-made cards, and own-CSV restore; v27 added scanner round 4; earlier commit
  `adc0e7b`, with block C's key-by-key sync merge; `supabase/min-client.sql` is optional, for Eric to run only after every family phone has reloaded v26 or later; v25 fixed the guide, capture margin, and language on real phones): the scanner recognises cards by their picture first (js/vision/, lab/fingerprints/RESULTS.md), after the second round of audit fixes in v23 (see `CHANGELOG.md` and the status in
  `plans/audit.md`). Tabs Cards, Sets, Scan, Binders, Lists; Profile behind the header avatar. Includes
  the monprice import, sign-in and live sync, the family group, checklists, wishlists, the
  scanner (v17), own photos with the carousel, the zoom and compare viewer, the twelve TCG energy
  themes, Brazil-first prices, (v16) name-and-password sign-in for a family member without an
  email (`@family.invalid` accounts Eric creates in the dashboard; `supabase/reset-password.sql`
  resets one), (v18) binder spreads, (v19) every card of a Pokémon from a checklist, and (v20)
  international twins on card pages and My Cards, and (v21) binder pages that turn on the middle of
  the spine. Every built module is now wired in.
- **A family member's name-and-password account:** Eric said on 2026-10-01 he
  thinks he created it and added it to the family. Not yet confirmed that the dashboard accepted
  the `.invalid` address or that a sign-in worked; if it refused, change `ACCOUNT_NAME_DOMAIN` in
  `js/auth.js`, the domain in `supabase/reset-password.sql`, and the docs.
- **Supabase is fully set up:** `setup.sql`, `realtime.sql`, and `photos.sql` have all been run
  (checked: realtime ready, photo bucket and its four policies present). Sign-ups are closed,
  Google sign-in works, Eric is the owner, and two family members are invited.
- **Scanner v17 is live** (`b7a6145` for v15, `c2e76d2` for v17): parallel reads of name, HP,
  attack, number, total, label, and copyright; a name route; an artwork tiebreak; slant
  correction; edges that must close at the card's bottom corners (so screen UI and headings stay
  out); auto capture when the card fills the guide's height; nothing preselected unless sure or
  a lead, with the search prefilled otherwise. Benchmark: 195 of 240 right card first (81%; v15
  measured the same way was 192, and its quoted 74% came from a run before it was finished). The
  benchmark scripts are not in the repo: they were in `/tmp/scan-bench` (`run.mjs`, `bench.js`,
  `summarize.py`, run as `REPO=<tree> node run.mjs --noold`) and are lost if `/tmp` is cleared (still there on 2026-10-02).
  The Weedle photo (`/home/me/Downloads/20261001_152008.jpg`, never copy it into the repo) is a
  sure `me04-001` at both framings; capture to result at 4x CPU throttling is 1.1 to 2.3 s warm
  and up to 2.6 s for the first auto capture, near the 2 s target, and throttling does not fully
  reach the OCR workers, so a real phone may be slower. Ideas from the v15 author: measure on the real phone
  (the scanner logs per-read timings); smaller crops or matching as soon as the number reads;
  name lists for translated Pokémon names (Portuguese Paradox Pokémon, French, German, trainers);
  a "read a photo from the gallery" option, since that is how Eric tested.

## Next Steps, in Order

Steps 1 to 4 of the 2026-10-01 list are done: the scanner (v15, fixed in v17), binder spreads
(v18), every card of a Pokémon (v19), and international twins (v20). Loose ends they left, for
the audit below to confirm or drop:

- **Scanner:** Eric's real-card test, then the ideas above. Known gaps: a card filling 100% of the
  guide's height at a strong slant is still cut at the weakness row; perfectly regular vertical
  stripes still pass the presence check. Worth committing the benchmark into `lab/` (it uses
  TCGdex images only) so it survives `/tmp` being cleared.
- **Binders (v18):** the empty-binder hint still says "Tap a pocket", which in portrait means
  tapping the page first; the binder screen's action buttons no longer stick (they covered the
  spread); new binders default to 40 pages; old `binders/<id>/<page>` links open the spread
  holding that page; another phone keeps a deleted binder's cover in its local cache; in
  landscape the raised Scan button sits over the bottom of the spine.
- **Every card of a Pokémon (v19):** a list with no `languages` field shows "All" and counts any
  language. Once Edit saves languages there is no way back to "All" (ticking every box counts the
  same but shows seven flags). On an "All" list the first visit to a Pokémon makes four Asian
  catalog requests plus one per Japanese or Korean set with that Pokémon, cached afterwards. Owned
  rows no longer expand inline; the row links to the Pokémon's screen instead.
- **Twins (v20):** Ver na Liga on a Japanese Trainer now builds its link from the twin's English
  name; check against Liga's Japanese pages that this is right. Set detail tiles do not use twins.
  No test opens a family member's cards with Japanese entries. Twins and the Pokémon screen each
  fetch and cache their own TCGdex set list (twins also asks for card counts): one shared list
  would do. Japanese `M6` (Storm Emerald) has
  no English counterpart yet, so most of Eric's Korean cards stay unmatched until it appears; the
  weekly recheck fills them in later.

1. **Whole-app audit**, report only: a staff software engineer (bugs, sync and merge, offline and
   the service worker, Supabase RLS and storage policies, unsafe HTML, performance with 1,600+
   cards, duplication between parallel-built modules, dead code, test gaps) writing
   `plans/audit-engineering.md`, and a senior QA tester who collects cards (every flow end to
   end at phone sizes, offline, family, prices, themes, scanner with the Weedle photo, attempts
   to break things, accessibility) writing `plans/audit-qa.md`. Merge into one prioritized list
   for Eric, then fix in blocks. **Report delivered 2026-10-02; Eric chose to fix the whole list. v22 shipped blocks A, B
   (the v22 half of the sync plan), D, E, and G; the rest is listed under "Status" in
   `plans/audit.md`.**
   The prioritized list with severity, effort, and fix blocks A to J is `plans/audit.md`; the two
   audits are `plans/audit-engineering.md` and `plans/audit-qa.md`, `plans/audit-verify.md`
   re-checks the engineering findings, and `plans/sync-merge-plan.md` designs the sync block.
   Screenshots stay outside the repo in `~/dev/projects/card-tracker-audit-2026-10-02/`.
2. **Remaining pieces for a complete first version:** Add to wishlist on card detail (the export
   `addToWishlist` exists); a Trade view (spares per card and language; none exists yet, and the
   stats bar should go on it); removing or trading away a copy; CSV re-import (strip the `="..."`
   wrapper the export writes around numbers); condition at scan; adding Eric's 16 unmatched cards
   by hand (5 Asian with no catalog records, 7 `MEE` cards numbered past 8, 4 letter-numbered
   energies); design-review polish (counts on All, Owned, Missing; family mode still shows your
   own rings and "Your copies"; truncated selects on My Cards; `css/binders.css` and
   `css/wishlist.css` onto the design tokens; the unused `.wl-badge-on`); README still describes
   the old Menu.
3. **Later, not scheduled:** image-first recognition (DESIGN.md section 6, "Later: image-first
   recognition": fingerprint first, text to break ties), Michi art in binders, pack openings,
   purchase details (price paid and storage), Korean and Japanese script detection for the
   scanner (vendor `jpn` and `kor` models).
   - **Done in v30:** the big Liga value box (`statsBar` in js/price-view.js: Total, Average,
     Highest, Lowest) still sits inline on a checklist (js/checklists-view.js), a set page
     (js/catalog-views.js), and a binder (js/binders-view.js). Eric dislikes the big box
     (2026-10-06). Swap it for the small Value button and sheet My Cards uses
     (js/value-sheet.js); check it in Chrome at phone width first.
   - **Backlog, not soon:** graded cards (grader, grade, certificate, hand-entered value). Eric
     sees no near demand (2026-10-05); the fields stay reserved in DESIGN.md section 4.
4. **Binder from a list (Eric, 2026-10-05; replaces "a checklist lays out a binder"):** pick
   the cards (a checklist, a collection, or a filter such as region, set, type, language), an
   order (Pokédex number, set and number, name, release), and a pocket size; the app makes the
   binder and works out the pages. Each pocket stands for a Pokémon (or card), not one copy:
   it shows a default (the most valuable or rarest copy), carries a count mark when there are
   more, and tapping it opens a sheet of every owned copy as pictures to pick from. A Pokémon
   not owned shows a faded placeholder with Add to wishlist. Choices stick: Refresh fills new
   pockets and updates only defaults never picked by hand. A generated binder is a view, so a
   card can also sit in another binder. Medium: binders, spreads, the filter bar, checklists,
   and collections already exist.
5. **Liga link rules (from Eric's 76-card Liga lookup, 2026-10-05):** done in v30 except the
   last bullet (manual price finish and language, still to weigh). Fixed in js/liga.js and
   DESIGN.md "Liga's query pattern", with tests:
   - Generations Radiant Collection uses the main set's total: `Swirlix (RC19/83)`, not
     `RC19/RC32`, so the GG/TG rule does not extend to RC.
   - SVP promos use the infinity sign: `Dondozo (012/∞)`. XY promos keep the promo number
     alone (`Celebi (XY111)`), and SWSH050 still works.
   - McDonald's 2023 pads both sides: `Cetitan (005/015)`, though TCGdex gives 5 and 15.
   - When the card number is zero-padded, pad the total to the same width:
     `Dachsbun (039/091)`, not `/91`.
   - A name-only search lists every print with its number form, a fallback when the exact
     query misses.
   - To weigh: a manual Liga price should say its finish and language (Liga averages are per
     finish, and PT and EN share one page with different prices); Reverse and Shattered Holo
     are separate prints; show "no PT listing", never zero.
6. **Reorder and undo on Lists and Binders (Eric, 2026-10-06):** drag and drop to reorder
   checklists, goals, collections, and binders (with a keyboard and screen-reader way too, such
   as Move up and Move down). Today a new list always lands at the bottom, so Eric had to delete
   and recreate every region list to fix one. Also Undo on a toast for list changes, as copies
   already have. The tap was the "missing" mark on a checklist row, which ticks a Pokémon by
   hand. Eric finds the hand tick odd ("trust me, I have it" with no card to show): drop it, or
   at least make a missing row open the Pokémon's cards like an owned row and move "Mark as
   owned without a card" behind a labeled action with Undo. Eric chose to drop it
   (2026-10-06), in v30: a missing row opens the Pokémon's cards, no new hand ticks, and old
   hand ticks stop counting but stay in the document for older clients' sync.
7. **Remove a card from a rule collection (Eric, 2026-10-06):** an automatic collection (a rule
   such as the Star preset) should let a card be taken out by hand. Store the exclusions with
   the collection (copy ids it leaves out, merged like `card_ids`); the rule keeps adding new
   matches. Untick it in the card's Add to collection sheet, and show "N left out" on the
   collection with a way to put them back. Today the sheet lists a rule collection as read only.
8. **Show the app's version (Eric, 2026-10-06):** a small line at the bottom of Profile,
   "Card Tracker v30", read from the active service worker's cache name
   (`card-tracker-shell-<VERSION>`, as Phone check already lists). When a newer worker is
   waiting, say "v30 · v31 ready" with the Reload button. Tiny; ride along with the next release.
9. **Family view (Eric, 2026-10-05):** both done in v30.
   - **Want on a member's card:** a member's card page hides Want with every other edit
     button (`wishControl` returns null when `readOnly`), yet it writes only to the viewer's
     own wishlist. Show it there, default the language to the member's copy, and say "N has
     2 spare" when they hold extras.
   - **Optional: their wishlist one tap closer.** The lens already follows Cards, Binders, and
     Lists, so a member's wishlist is Lists, then Wishlist. A Wishlist link in the heading of
     their Cards page, like the Spares link on yours, would save the step.

## Open Decisions for Eric

- **Do a list's languages decide its ticks?** Today a checklist ticks from any language (his Kanto
  list shows 141 of 151), and since v19 a list without a `languages` field says "All" so the label
  matches. Proposed: lists without a `languages` field keep counting any language; new lists
  follow their setting (Portuguese by default). The change is in `js/checklists-view.js`,
  `checklistScreen`'s `load()`: call `resolveOwned(entriesInLanguages(data.entries,
  listLanguages(found)), ...)`, using the helpers exported from `js/checklists.js`.
- **The family switcher's place:** v13 moved it to a "Mine" chip in the header with a bottom
  sheet; ask whether that works for him.
- **Scanner:** after the improvement lands, Eric tests on 20 to 30 real cards (Portuguese and
  Korean included), ideally through `/lab/` too, and sends the CSV export.

## How We Work (keep doing this)

- **Parallel agents own files.** Give each agent explicit file boundaries; self-contained blocks
  create new files and export route tables or components, and report exact integration lines.
  Shared files (`app.js`, `index.html`, `style.css`, `sw.js`) are edited by one integrator at a
  time.
- **Every module the app loads must be in `SHELL` in `sw.js`**, or the app fails to open offline.
  A test checks that every file in `js/` is listed. Bump `VERSION` on every release; tests read it
  from `sw.js`.
- **Stage exact files**, never `git add -A`, so another agent's in-progress work is not committed.
- **Test the exact commit on a clean worktree before pushing:** `git worktree add --detach
  <tmp>/vNN HEAD`, run every suite there, push only if green, then remove the worktree. A session
  isolated in its own worktree cannot add another, so there use `git archive -o <tmp>/vNN.tar
  <sha>` and unpack it instead (the project needs no install). Browser suites can time out when
  other agents run browsers at the same time (`app`'s 1,600-entry sign-in test did once); re-run
  the suite alone before believing a failure.
- **Suites:** `PLAYWRIGHT=/home/me/dev/projects/pages-workspace/playwright/node_modules/playwright
  node --test --test-timeout=300000 tests/<name>.test.mjs` for `merge`, `names`, `liga`, `themes`,
  `wishlist`, `binders`, `checklists`, `app`, `live-sync`, `themes-app`, `wishlist-browser`,
  `shell`, `scan`, `scan-browser`, `photos`, `photos-browser`, `photos-viewer`,
  `photos-viewer-browser`, `prices`, `prices-browser`, `prices-app`, `binder-spread`,
  `binder-spread-browser`, `pokemon-cards`, `pokemon-cards-browser`, `twins`, `twins-browser`,
  `account-password`, `import`, `sheets-browser`, `copies-browser`, `filter-bar`,
  `my-cards-browser`, `family-browser`, `scan-guide-browser`, `trade-browser`, `favorites-browser`, `custom-cards`, `custom-cards-browser`, `collections`, `collections-browser`, `goals`, `goals-browser`, `scan-placeholder-browser`;
  `photos-sql` needs Docker. Tests fake Supabase (`tests/fake-supabase.mjs`); never call the real
  one, never create accounts, never request ligapokemon.com.br.
- **Rules:** no paid services, ever; no em dashes anywhere; the repo is public, so no personal
  data (never commit the owner's export `/home/me/Downloads/Todas_*` or his photos; tests use
  invented data and neutral names such as "Member A"); commit messages say what changed and why,
  ending with the `Co-Authored-By` trailer; update `CHANGELOG.md` with a dated Live entry and its
  commit after each release; record decisions in `DESIGN.md` with who decided and when.
- **Supabase project:** `https://ehdkbxrjxsypegbtrxbw.supabase.co`, publishable key
  `sb_publishable_Ycfz9bobfuvHWdDKjaoQQA_LDYmm0vJ` (public by design). Never ask for or use the
  secret key or the database password; Eric runs any new SQL in the SQL Editor.
- **Budget:** Eric runs this on spare weekly quota (the week resets Saturday 2:59am Recife time;
  check `/usage`). Delegate builds to fresh agents rather than doing them inside a long session.
