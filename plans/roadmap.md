# Roadmap and Handoff

Written 2026-10-01 at the end of a long build day, so the next session can continue without the
old conversation. Read this first, then `CHANGELOG.md` (what is live and when) and `DESIGN.md`
(requirements and decisions, with their reasons). `plans/design-review.md` is the approved UI
spec; `plans/product-plan.md` and `plans/ux-plan.md` are the earlier plans.

## State Right Now

- **Live:** version **v14** at https://ericthmoritsuka.github.io/pokemon-card-tracker/ (commit
  `23c0c4f`). Tabs Cards, Sets, Scan, Binders, Lists; Profile behind the header avatar. Includes
  the monprice import, sign-in and live sync, the family group, checklists, wishlists, binders
  (single page), the scanner (first version), own photos with the carousel, the zoom and compare
  viewer, the twelve TCG energy themes, and Brazil-first prices.
- **Supabase is fully set up:** `setup.sql`, `realtime.sql`, and `photos.sql` have all been run
  (checked: realtime ready, photo bucket and its four policies present). Sign-ups are closed,
  Google sign-in works, Eric is the owner, and two family members are invited.
- **Scanner v15 is live** (`b7a6145`): parallel reads of name, HP, attack, number, total, label,
  and copyright; a name route; an artwork tiebreak; slant correction; a prefilled search when
  unsure. Benchmark: 74% top-1 over 240 captures (40% before); the Weedle photo
  (`/home/me/Downloads/20261001_152008.jpg`, never copy it into the repo) matches `me04-001`.
  Estimated about 2.4 s per card on a mid-range phone, still above the 2 s target. Ideas from its
  author: redo the full 240-capture benchmark with the final code; measure on the real phone
  (the scanner logs per-read timings); smaller crops or matching as soon as the number reads;
  name lists for translated Pokémon names (Portuguese Paradox Pokémon, French, German, trainers);
  a "read a photo from the gallery" option, since that is how Eric tested.

## Next Steps, in Order

1. **Scanner: done in v15.** Next for it: Eric's real-card test, then the ideas above.
2. **Wire binder spreads** (module committed in `64117ab`: `js/binder-spread.js`,
   `js/binder-cover.js`, `js/binder-presets.js`, `css/binder-spread.css`). The exact
   `js/binders-view.js` diff was saved at `/tmp/bs-integration/binders-view.diff` with its
   generator `/tmp/bs-integration/patch.py`; if `/tmp` was cleared, rebuild it from the module's
   API (`binderSpread({binder, renderPocket(page, position), onPocket, onChange, page, path, base,
   readOnly})`, `presetPicker`, `paintCover`, `pickCoverImage`). The binders view must keep the
   price stats bar added in v14. Add `css/binder-spread.css` to `index.html` (the JS files are
   already in `SHELL`). Then update `tests/binders.test.mjs` selectors (`#pocket-grid`,
   `#page-prev`, `#page-next`, `#page-select`, and pocket labels now "Page P, pocket N").
   Follow-ups: delete a binder's cover file from the bucket when the binder is deleted; landscape
   leaves little height for the spread (shell bars).
3. **Wire every card of a Pokémon** (committed in `f92bebe`: `js/pokemon-cards.js`,
   `js/pokemon-cards-view.js`, `css/pokemon-cards.css`; additive helpers in `js/checklists.js`).
   The integration lines are the `INTEGRATION` table in `tests/pokemon-cards-harness.mjs` (routes
   and account views in `app.js`, the stylesheet, the languages control and the new checklist row
   in `js/checklists-view.js`). Its `checklists-view.js` anchor for `root.append` no longer
   matches, because v14 added the stats bar there: update the anchor, then make the harness assert
   against the real files instead of patching them, as `tests/binders.test.mjs` does. Then update
   `tests/checklists.test.mjs` (owned-row expansion and the read-only `.dex-row button` checks).
4. **Wire international twins** (committed in `ce0cbe6`: `js/twins.js`, `js/twins-view.js`,
   `css/twins.css`). Integration:
   - `js/catalog-views.js`: import `{onTwinsChange, twinName, twinSlides}` from `./twins.js` and
     `{twinConfirm}` from `./twins-view.js`; in `cardView` after the photos setup,
     `const twin = twinConfirm({cardId, catalog: catalogFor(lang)})` and
     `const stopTwins = onTwinsChange(() => alive && current && draw(current))`; wrap the
     shown names so an Asian print without an English name takes `twinName({card_id: cardId,
     catalog: catalogFor(lang)})`; call `twin.check(card)` in `draw`; pass
     `twins: twinSlides(card, {catalog: catalogFor(lang)})` into `photos.show(...)`; place
     `twin.element` right after the card hero; call `twin.destroy()` and `stopTwins()` in cleanup.
   - `js/cards-view.js`: names fall back to `twinName({card_id, catalog})` when no English name
     exists; tile sources get `twinSlides(entry, {size: 'low'})` through `tileSrc(..., {twins})`
     and `withMainPhoto(..., {twins})`; after the first build, `loadTwins()` then rebuild, and
     `refreshTwins(entries)`; subscribe with `onTwinsChange` and unsubscribe in cleanup.
   - Add `css/twins.css` to `index.html` (the JS is already in `SHELL`).
   Note: it matches Japanese records only; Korean copies sit on Japanese records, so they are
   covered. Japanese `M6` (Storm Emerald) has no English counterpart yet, so most of Eric's Korean
   cards stay unmatched until it appears; the weekly recheck fills them in later.
5. **Whole-app audit**, report only: a staff software engineer (bugs, sync and merge, offline and
   the service worker, Supabase RLS and storage policies, unsafe HTML, performance with 1,600+
   cards, duplication between parallel-built modules, dead code, test gaps) writing
   `plans/audit-engineering.md`, and a senior QA tester who collects cards (every flow end to
   end at phone sizes, offline, family, prices, themes, scanner with the Weedle photo, attempts
   to break things, accessibility) writing `plans/audit-qa.md`. Merge into one prioritized list
   for Eric, then fix in blocks.
6. **Remaining pieces for a complete first version:** Add to wishlist on card detail (the export
   `addToWishlist` exists); a Trade view (spares per card and language; none exists yet, and the
   stats bar should go on it); removing or trading away a copy; CSV re-import (strip the `="..."`
   wrapper the export writes around numbers); condition at scan; adding Eric's 16 unmatched cards
   by hand (5 Asian with no catalog records, 7 `MEE` cards numbered past 8, 4 letter-numbered
   energies); design-review polish (counts on All, Owned, Missing; family mode still shows your
   own rings and "Your copies"; truncated selects on My Cards; `css/binders.css` and
   `css/wishlist.css` onto the design tokens; the unused `.wl-badge-on`); README still describes
   the old Menu.
7. **Later, not scheduled:** image-first recognition (DESIGN.md section 6, "Later: image-first
   recognition": fingerprint first, text to break ties), Michi art in binders, pack openings,
   graded cards, Korean and Japanese script detection for the scanner (vendor `jpn` and `kor`
   models).

## Open Decisions for Eric

- **Do a list's languages decide its ticks?** Today a checklist ticks from any language (his Kanto
  list shows 141 of 151). Proposed: lists without a `languages` field keep counting any language;
  new lists follow their setting (Portuguese by default). The change is in `js/checklists-view.js`,
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
  <tmp>/vNN HEAD`, run every suite there, push only if green, then remove the worktree.
- **Suites:** `PLAYWRIGHT=/home/me/dev/projects/pages-workspace/playwright/node_modules/playwright
  node --test --test-timeout=300000 tests/<name>.test.mjs` for `merge`, `names`, `liga`, `themes`,
  `wishlist`, `binders`, `checklists`, `app`, `live-sync`, `themes-app`, `wishlist-browser`,
  `shell`, `scan`, `scan-browser`, `photos`, `photos-browser`, `photos-viewer`,
  `photos-viewer-browser`, `prices`, `prices-browser`, `prices-app`, `binder-spread`,
  `binder-spread-browser`, `pokemon-cards`, `pokemon-cards-browser`, `twins`, `twins-browser`;
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
