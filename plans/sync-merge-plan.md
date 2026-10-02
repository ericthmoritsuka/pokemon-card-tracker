# Plan: Sync and Merge Fixes

This plan designs the fixes for E-14, E-15, E-16, and E-17, plus the parts of E-18, E-21, and E-37 they touch. The finding numbers refer to `plans/audit-engineering.md`. It was written 2026-10-02 against `02afb5a` (v21). It is a design only: nothing is built yet, and Eric chooses whether and when (see `plans/audit.md`, blocks B and C).

## 0. What the Code Does Today

- **`newerEntry`** (`js/merge.js:34-46`): the newer `updated_at` wins. A tombstone wins only on a tie, and `stableJson` decides the rest.
- **`mergeEntries`** (`:50-74`) matches on `id` only. **`mergeDocuments`** (`:81-111`) lets the local side win for top-level fields.
- **`stamps()`** (`js/merge.js:115-135`) compares entries by `updated_at` alone. `sameContent`, `countChanged`, the push decision (`js/sync.js:216`), and `mergeIntoLocal` (`js/collection.js:136`) all build on it.
  - **This constrains the design:** a merge result whose content differs from either side must also carry a different `updated_at`. Otherwise it is never pushed, or never saved locally.
- **Old (v21) writers keep unknown fields**, so an old client carries new fields along, stale, and never strips them:
  - cards: `Object.assign` onto the stored entry (`js/collection.js:271`, `:290`, `:370`);
  - binders: `structuredClone` (`js/binders.js:324-331`);
  - goals: `structuredClone` (`js/checklists.js:156-171`);
  - wishes: an object spread (`js/wishlist.js:164-176`).
- **v21 deletes nested keys by leaving them out.** `setPocket` filters slots out (`js/binders.js:381`, `:395`), and `setHandTick` deletes the key (`js/checklists.js:243-254`).
  - Photos are the exception: v21 always tombstones them (`js/photos/store.js:404-408`) and never drops one from the array.
- **v21 readers skip what they don't know:** `slotsOf` skips any slot whose `slotKind` is null (`js/binders.js:91`, `:237`), and `handTicks` reads only `Object.keys(goal.hand_ticks)` (`js/checklists.js:67-69`).
- **`doc.version: 1`** exists (`js/collection.js:81`), but nothing reads it. Local wins for top-level fields in `mergeDocuments` (`:85`), so an old client keeps re-pushing its own value. **A document-level version can never gate old clients.**
- **`nextStamp`** is defined three times: `js/binders.js:183`, `js/wishlist.js:156`, and `js/settings.js:141`. Card writes use plain `nowIso()` (`js/collection.js:271`, `:283`, `:308`, `:370`), so a phone whose clock is behind writes stamps older than the version it edited.
- **`import_key`** is `monprice|id|lang|finish|copyIndex` (`js/monprice.js:708`), so one key means one physical copy. Merging two live entries with the same key is always safe.

## 1. E-14: Deterministic Ids for Imported Rows, Plus a Repair

### 1a. Deterministic ids

- **The id function:** `importEntryId(importKey)` in `js/collection.js` returns a UUIDv5 of the key under a fixed app namespace UUID, using `crypto.subtle.digest('SHA-1')`.
  - The call is async, which is fine, because `applyImport` is async.
  - It is available on GitHub Pages (https), on localhost, and in Node 22.
  - If `crypto.subtle` is missing, it falls back to `newId()`, and the repair in 1b covers that device.
- **Photo paths:** the output is 36 characters of lowercase hex and hyphens. That satisfies `is_photo_path`'s `[A-Za-z0-9_-]{1,64}` (`supabase/photos.sql:76`), and `<photo_id>-detail` stays at 43 characters.
- **No user id in the namespace.** The bug case is an import made signed out, before any user id is known. Two family members get the same entry ids for the same file, which is harmless: the documents are separate, and photo paths start with the user id.
- **A pure import step:** extract the body of `applyImport` (`js/collection.js:322-377`) into a pure `planImport(cards, entries, {now, ids})` that returns `{cards, counts}`. `applyImport` precomputes ids for the new keys, then calls it. This covers the `applyImport` half of E-37 and makes the logic testable in Node.
- **Result:** the same import on two v22 phones gives the same ids, so the merge sees one entry per row. The plain fields are equal, and the merged `created_at` takes the earlier one.

### 1b. Repair: collapse live entries that share an `import_key`

The repair must run permanently, not once, because a v21 device's random ids and a v22 device's UUIDv5 ids for the same rows still collide.

**Where it runs:**
- A pure `collapseImportDuplicates(doc)` step at the end of `mergeDocuments`, run on every merge, including `mergeIntoLocal` saves.
- `js/sync.js:212` changes to always call `mergeDocuments(local, remote || {})`, so an already doubled document is repaired at its next sync even when the server has nothing new. `changed` at `:216` already falls back to `countChanged(merged, base)`.

**Groups and survivor:**
- Groups are live cards only, grouped by `import_key`. Tombstones are never merged into a survivor (see Risks).
- The survivor is the copy with the earliest `created_at`, ties broken by the lowest `id`.
  - It fits the reproduced case: phone 1 imported first and holds the pockets, prices, and photos.
  - The rule is deterministic, so every device picks the same survivor.

**What the survivor keeps.** Members are ordered by their per-field stamp, which falls back to `updated_at` until E-15 lands.
- **`photos`:** the union of all members, through `mergePhotoLists` (`js/photos/model.js:221`). Paths keep the dropped entry's folder. `photos.sql` checks only the shape of a path, never that the folder matches a live entry, so nothing breaks.
- **`main_image`:** the survivor's pin if it still points at a live slide; otherwise the newest pin among the other members.
- **`price_manual`:** the newest non-null value.
- **User fields** (`condition`, `purchase_*`, `storage`, `grader`, `grade`, `cert_number`, `graded_price`, `notes`, `opening_id`): per field, the newest non-empty value. `is_favorite` is true if any member has it.
- **Import fields** (`card_id`, `variant_id`, `language`, and the rest): taken from the most recently edited member.
- **`created_at`:** the earliest.

**The other members** become tombstones: `{deleted_at: S, updated_at: S, merged_into: <survivorId>}`. S is the latest `updated_at` in the group plus 1 ms, so every device computes identical results. The survivor also gets `updated_at: S`.

**References:**
- **Binder pockets:** build a redirect map from every card tombstone that has `merged_into`, following chains, and rewrite `slot.entry_id` in every live binder.
  - Keep each slot's `placed_at`, so the existing "placed last wins" rule (`js/binders.js:195-226`) still decides if the survivor ends up in two pockets.
  - A rewritten binder gets its own `updated_at` plus 1 ms.
  - The rewrite runs after every merge, so a stale slot coming back from a device that has not repaired yet is redirected again.
- **The phone's photo queue and `made` rows** (they hold `entry_id`): add `resolveEntry(cards, id)` to `js/collection.js`, which follows `merged_into`.
  - Use it in `freshEntry` (`js/photos/store.js:346`), in `uploadOne`'s lookup (`:459-465`), and in `restoreDroppedPhotos` (`:292-322`).
  - Without it, a waiting upload for a photo on a dropped duplicate silently drops itself: `uploadOne` returns "nothing to send" when the entry is not live.
- **Wishlist links:** nothing to rewrite. Wishes match copies by `card_id`, catalog, language, and variant (`copyFits`, `js/wishlist.js:186`), never by entry id.
- **The scanner's Undo session:** its ids are in memory only, and scanned copies have no `import_key`.

**Old clients** accept the tombstones and the bumped survivor, because both are newer. If a v21 phone edits a dropped duplicate offline, the sticky-tombstone rule in section 3 keeps it deleted, and that edit is lost (see Risks).

## 2. E-15: Merging Key by Key Inside Entries

### Approach

The recommendation is per-key stamps in the data, with a validity check that falls back to today's whole-entry rule whenever a v21 client wrote the version.

A three-way merge against a stored copy of the last server document was considered and rejected. It would need no change to the data shape, but:
- it depends on base bookkeeping on each phone, across sync retries, inserts, and account stashes;
- local saves that race a sync merge would turn into deletions;
- it cannot be tested as pure two-way functions, the way `tests/merge.test.mjs` tests everything today.

### Data shape changes

All the new fields are optional. v21 ignores them and carries them along.

```
entry.field_stamps = {at, since, <field>: iso, ...}   // only after a v22+ edit
binder slot cleared: {page, position, placed_at, cleared: true}
goal.hand_unticks  = {"<dex>": iso}
entry.restored_at, entry.merged_into                    // sections 1 and 3
doc.merge_version  = 2                                  // section 5
```

- **Valid versions:** `valid(e)` is true when `field_stamps.at === updated_at`.
  - An entry with no `field_stamps` also counts as valid when `updated_at === created_at` (never edited), so 1,600 imported entries cost no extra bytes.
  - Any v21 edit moves `updated_at` without touching `field_stamps.at`, so that version stops counting as valid.
- **`since`:** when this version's history last became valid. It is `created_at` for entries made by v22, or the time a v22 edit took over a v21-written version. It bounds how far back v21's remove-by-leaving-out could reach.
- **`stampEntry(before, after, at)`:** a pure helper in `js/merge.js`.
  - It stamps only the top-level fields whose `stableJson` changed, including fields removed outright (`applyImport` deletes keys at `js/collection.js:364-368`).
  - It sets `at`, and keeps `since`, or sets it when the version was not valid before.
  - It never stamps the bookkeeping fields (`id`, `created_at`, `updated_at`, `deleted_at`, `restored_at`, `merged_into`, `field_stamps`) or the keyed collections (`photos`, `slots`, `hand_ticks`, `hand_unticks`).
- **Collections that already carry their own stamps:** slots use `placed_at`, `hand_ticks` values are tick times, and photos have `id` and `deleted_at`.

### `mergeEntry(list, a, b)` in `js/merge.js`

This replaces the per-entry pick inside `mergeEntries`.

1. **Sticky tombstone** (section 3). It applies in every case.
2. **Both versions valid: merge key by key.**
   - **Plain fields, per field:** the larger `field_stamps[field]` wins. A missing stamp counts as `since` or `created_at`, and ties go to `stableJson`. This gives `price_manual` and `main_image` (cards), and the name, grid, and `art` (binders), stamps of their own.
   - **`photos`:** always the union by id, through `mergePhotoLists` (the tombstone wins, then the version that knows its path).
   - **Binder `slots`, by `page|position`:**
     - The larger `placed_at` wins, and on a tie a `cleared` marker wins.
     - A key present on only one side is kept only if its `placed_at` is later than the other side's `since`. Otherwise v21 may have removed it by leaving it out.
     - Art slots (no `placed_at`) come from whichever side won the grid fields.
     - After merging, slots outside the merged grid are dropped (a deterministic version of `updateBinder`'s rule at `js/binders.js:487-509`), so no ghost cards reappear when the grid grows again.
   - **`hand_ticks`, per dex number:** the later of the tick time and `hand_unticks[dex]` wins, and an untick wins a tie. The `since` rule applies here too.
   - **`cover_image`:**
     - both set, different ids: the larger `cover_image.at` (the image's creation time) wins;
     - same id: the version with a `path` wins;
     - one side null: `field_stamps.cover_image` decides.
     - The path fill-in (`js/binder-cover.js:355-356`) must not advance the cover stamp. It can no longer drop pockets, because pockets merge by key; that fixes E-15's background-write case.
3. **Either version not valid (a v21 write): today's rule, but no tombstone is lost.**
   - The winner is `newerEntry(a, b)`.
   - Then: union the photos (always safe, since v21 never drops photos); apply the loser's `cleared` markers and `hand_unticks` that are newer than the winner's value for that key; resolve `cover_image` by `at`.
   - Do not re-add the loser's additions, because v21 may have removed them on purpose.
   - The result is not marked valid.
4. **Bump rule:**
   - If the result's `stableJson` equals a or b, return that object (the photos test at `:398` asserts identity).
   - Otherwise set `updated_at = max(a, b) + 1 ms`, which is deterministic. In the valid case, also set `field_stamps.at` to the same value and `since` to the later of the two.
   - This keeps `stamps()` and `sameContent` correct, and a v21 client takes the result whole because it is newer.

### Writers to change

- **`js/collection.js`:**
  - `updateCard` and `updateCards` (`:263-300`) snapshot the entry, apply the patch, then call `stampEntry`;
  - `deleteCard` (`:303-316`) and the update path of `planImport` call it too;
  - card writes use `nextStamp(entry.updated_at, now)` instead of `nowIso()`.
- **`js/binders.js`:**
  - `copyOf` (`:324`) sets the validity stamp and `since`.
  - `setPocket` (`:351-399`) writes a `cleared` marker at the target pocket when content is null, and at the old pocket when a copy moves. Its `placed_at` is `nextStamp` of the pocket's current `placed_at`, which handles clock skew.
  - `updateBinder`, `setCoverImage`, and `deleteBinder` call `stampEntry`. `setCoverImage(id, image, {fill: true})` skips the cover stamp.
- **`js/binder-cover.js:356`:** passes `{fill: true}`.
- **`js/checklists.js`:**
  - `changeChecklist` (`:156-171`) calls `stampEntry`;
  - `setHandTick` (`:243-254`) writes `hand_unticks[dex]` on an untick and removes it on a tick, both with `nextStamp(max(tick, untick))`.
- **`js/wishlist.js`:** `editedWish` and `deletedWish` (`:164-176`) call `stampEntry`.
- **`js/checklists-view.js:670-682`** needs no change. It is only the optimistic display.

### How an old client interacts

- **New fields survive:** a v21 client does not clobber them. It carries `field_stamps`, `cleared` markers, and `hand_unticks` along unchanged, and v21's `slotsOf` and `handTicks` ignore them.
- **Its edits fall back:** they move `updated_at` past `field_stamps.at`, so v22 falls back to the whole-entry rule for that pair. That is exactly v21's behavior today, minus the lost tombstones.
- **No gate needed:** mixed operation is never worse than v21 talking to v21, so correctness needs no version gate. Section 5 has an optional one.

## 3. E-16: Sticky Tombstones, Delayed Bucket Deletes, Clock Skew

### Sticky tombstones (in `mergeEntry`, all lists)

- **Deleted against live:** the live side wins only if `restored_at > deleted_at`; otherwise the tombstone wins.
  - If the live side was newer, the tombstone gets `max + 1 ms`, so v21 accepts it.
  - Ties already favor tombstones (`js/merge.js:41`).
- **Two tombstones:** plain last-writer-wins.
- **"Restore on purpose":** a deliberate user action that writes `deleted_at: null, restored_at: nextStamp(deleted_at), updated_at: same`.
  - Nothing in the app does this today: import skips deleted keys (`js/collection.js:349-353`), and re-adding a wish makes a new random id.
  - So from v22, deletes are effectively permanent. Define the rule and a `restoreEntry` helper; a "Recently deleted" screen is Eric's call.
- **Photo tombstones** are already sticky (`mergePhotoLists`) and stay that way in every case, including the v21 fallback.

### Delayed bucket deletes

**One decision function:** a pure `bucketDeleteState(row, doc, serverHolds, now, graceMs)` in `js/photos/model.js`, shared by photos and covers, returns `'wait'`, `'go'`, or `'cancel'`.
- **`go`** needs all three:
  - `now >= row.not_before` (the deletion time plus the grace period);
  - the server holds the deleting version, checked as `serverHolds(list, id, entry.updated_at)` for the current local version;
  - no live entry or binder in the document still references `row.path`. This also protects photos moved onto a survivor by section 1b.
- **`cancel`:** the photo or cover is live again, so the queue row is dropped.
- **`wait`:** anything else.

**The server check:** `js/sync.js` exports ``serverHolds = (list, id, at) => base?.get(`${list}|${id}`) === String(at)``. `base` is already updated by `remember()` (`:258`) before `mergeIntoLocal` (`:259`).

**Photos:**
- `removePhotoFromEntry` (`js/photos/store.js:426-437`) stores `not_before` on the delete row.
- `flushQueue` (`:572`) checks the state, and skips with `continue` rather than `break` while waiting. It already re-flushes on every sync save (`:652-656`).
- A sweep queues delayed deletes for the photos of card tombstones that have no `merged_into` (E-21).

**Covers:**
- `dropOld` (`js/binder-cover.js:448-456`) stores `not_before`.
- The delete branch (`:280`) checks the state.
- The cover code subscribes to the sync status and re-flushes on `synced`.
- A local sweep drops cover blobs that no live binder references (E-21: other phones keep them today).

**Local copies** are still deleted straight away. The bucket copy stays for other devices during the grace period.

### Clock skew

1. **Stamps that always move forward:** move `nextStamp` into `js/merge.js`, re-export it from `js/binders.js` (tests import it from there), and use it for every write and every per-key stamp. An edit made after seeing the 10:05 version is then always stamped later, whatever the phone's clock says. That fixes the audit's case where an edit stamped 09:58 lost to 10:05.
2. **Clock-free merging:** sticky tombstones and key-by-key merging make deletes, and edits to different keys, independent of clocks. Only edits to the same key at the same time are still decided by the clock.
3. **Optional offset estimate:** after each write, `js/sync.js` estimates the clock offset as the server's `updated_at` minus the local midpoint of the request, when the round trip is under 2 s.
   - It saves the offset in meta, and `nowIso` and `nextStamp` apply it through a `clockNow()` when it exceeds 60 s.
   - Phone check warns when it exceeds 5 minutes.

## 4. E-17: Duplicate Wishes

**Recommended:** dedupe after the merge, not deterministic ids. `updateWish` can change the language or variant, so an id derived from those fields would stop matching its content, and an edit can create a duplicate even on one phone.

`dedupeWishes(doc)` runs at the end of `mergeDocuments`:
- **Groups:** live wishes, keyed by `catalog|card_id|language||''|variant_id||''` (the same test as `sameWish`, `js/wishlist.js:360`).
- **Survivor:** the earliest `created_at`, ties broken by `id`. It takes the priority and note from the most recently edited member, or the newest non-empty note.
- **The others** become tombstones with `merged_into`, all stamped at the group's latest `updated_at` plus 1 ms.
- **Result:** removing the survivor removes it everywhere.

## 5. Rollout and Backward Compatibility

**Two releases:**
- **v22:** commits 1 to 7 below (ids and repair, sticky tombstones, wish dedupe, delayed deletes). These are self-contained rules that v21 accepts.
- **v23:** commits 8 to 13, the key-by-key merge. It is the larger and riskier change.

Eric makes a JSON export on each phone before v22 goes out.

**Every device does at least one v21 sync after a release.** The service worker calls `skipWaiting` and `clients.claim` (`sw.js:185`, `:201`), and the open page keeps the old JS until Reload (`app.js:249`). The design tolerates this: every mixed case falls back to v21 behavior.

**`doc.version` and `merge_version`:**
- Don't use `doc.version`, because v21 re-pushes its local value.
- v23 writes `merge_version: 2` and takes the larger of the local and remote values in `mergeDocuments`.
- A forward gate from v23 on: when the remote value is higher than the client's own constant, the client stops pushing and shows "Update the app to keep syncing" (status `error`).

**Optional server-side minimum-client gate** (a new `supabase/min-client.sql` Eric pastes, plus a Docker check in `tests/setup-sql-check.sql`):
- **How it works:**
  - v23's `outgoing()` (`js/sync.js:122-130`) adds `base_stamp = stamp`, the server `updated_at` already used for the compare-and-set guard (`:238`).
  - A BEFORE UPDATE trigger rejects the write when `(new.doc->>'base_stamp')::timestamptz is distinct from old.updated_at`.
  - v21 can only carry an older `base_stamp` forward, and server stamps strictly increase (`clock_timestamp()`, `supabase/setup.sql:62`), so every v21 update is refused. Inserts pass.
- **What an old client sees:** "Not saved, N changes waiting", with its edits kept on the phone. After Reload, v23 merges them.
- **No CORS risk:** no custom headers are involved.
- **When to install it:** only after every family phone shows v23. Installed earlier, it blocks nobody's data but stops their syncing.

## 6. Tests to Add or Change

**`tests/merge.test.mjs`** (Node). A fixture, `tests/merge-v21.mjs`, is a frozen copy of `js/merge.js` at `02afb5a`, used to simulate old clients.

Deletes and stamps:
- a delete stays deleted when an offline phone edits the card later (a tombstone at 10:05 against a note at 10:06, both orders, the result stamped later than 10:06)
- a restore on purpose brings an entry back; one older than the delete does not
- the sticky result wins on a v21 phone too (feed the result to v21 `mergeEntries`)
- a result that differs from both sides gets a stamp newer than both; equal content returns the same object
- nextStamp is later than the previous stamp even with a slow clock

Collapsing duplicates:
- duplicates by import key collapse into the oldest copy, keeping photos, Liga price, notes, and the binder pocket
- collapse is the same on every phone, and running it twice changes nothing
- a binder pocket pointing at an older merged id is redirected after any merge
- deleted copies and copies with no import key are never collapsed
- a v21 phone's edit to a collapsed duplicate does not bring it back

Key-by-key merging:
- pockets placed on two phones in one binder both survive
- a cleared pocket stays clear; a later fill wins
- a Liga price on one phone and a photo on the other both survive (the E-15 repro)
- a note and a condition edited on two phones both survive; the same field goes to the later edit
- hand ticks merge by dex; an untick beats an older tick
- a cover upload finishing later neither reverts a newer cover nor drops pockets
- slots outside the merged grid are dropped
- photos always merge by id

Mixed versions:
- a v21 edit falls back to whole-entry but keeps photo tombstones, cleared pockets, and unticks
- a pocket removed by a v21 phone is not re-added by an older v23 copy (the `since` rule)
- three phones, mixed v21 and v23, converge (a seeded random history; all replicas end with equal `stableJson`)
- a newer merge_version stops the push

**`tests/import.test.mjs`** (a new Node suite; add it to the roadmap's suite list):
- importing the same rows twice adds nothing
- a deleted row is not brought back
- a changed match updates in place
- new rows keep the export order
- an imported row's id is the UUIDv5 of its key: version nibble 5, and it matches photos.sql's path segment

**`tests/wishlist.test.mjs`:**
- the same card wished on two phones merges into one item
- a duplicate made by an edit is merged too
- the survivor keeps the earliest date, and the newest note and priority

**`tests/binders.test.mjs`:**
- Rewrite `:268` as "edits to different pockets of one binder on two phones both survive" (c1 at a:1:1, c2 at a:1:2, c3 at a:1:3).
- At `:282`, `count(merged, 'c1')` becomes 1, because the move leaves a `cleared` marker.
- Add: a cleared marker is ignored by slotsOf and slotKind.
- Browser test at `:962`: the cover delete happens only after the server holds the tombstone and the grace period has passed (`context.clock.install()` and `page.clock.setSystemTime`). Offline, it still waits.

**`tests/photos.test.mjs`:**
- Rename `:398` to "the merge keeps photos from both versions".
- Add: bucketDeleteState waits for the grace period and the server, and cancels when the photo is live again.
- Add: a path a live entry still holds is never deleted.

**`tests/photos-browser.test.mjs`** and `tests/photos-harness.mjs` (the harness must start the sync):
- Update `:461` to the delayed delete.
- Add: a photo on a collapsed duplicate still uploads, under the survivor.

**`tests/app.test.mjs`** (browser, fake Supabase):
- the same import on a second phone, signed out then signed in, keeps one copy per row; importing again reports unchanged (the E-14 repro)
- a document already doubled by v21 is repaired at the next sync, pocket and photo kept
- pockets placed on two phones while one is offline both show after sync
- a card deleted on one phone stays deleted after an offline phone edits it

## 7. Work Breakdown

Each commit passes every suite.

| # | Commit | Files | Hours |
| --- | --- | --- | --- |
| 1 | One `nextStamp` in merge.js; card and goal stamps that always move forward | js/merge.js, js/collection.js, js/binders.js, js/wishlist.js, js/settings.js, js/checklists.js, tests/merge.test.mjs | 1.5 |
| 2 | `planImport` and UUIDv5 import ids; import tests (E-14a, E-37) | js/collection.js, tests/import.test.mjs (new), plans/roadmap.md | 3 |
| 3 | Sticky tombstones, `restored_at`, bump rule | js/merge.js, tests/merge.test.mjs, tests/merge-v21.mjs (new), DESIGN.md | 3 |
| 4 | Collapse import duplicates; redirects; sync always merges; photo store follows `merged_into` | js/merge.js, js/sync.js, js/collection.js, js/photos/store.js, tests/merge.test.mjs, tests/app.test.mjs, tests/photos-browser.test.mjs | 6 |
| 5 | Wish dedupe | js/merge.js, tests/wishlist.test.mjs | 1.5 |
| 6 | Delayed bucket deletes; local sweeps (E-21) | js/photos/model.js, js/photos/store.js, js/binder-cover.js, js/sync.js, tests/photos.test.mjs, tests/photos-browser.test.mjs, tests/photos-harness.mjs, tests/binders.test.mjs | 7 |
| 7 | Release v22 (integrator) | sw.js (VERSION), CHANGELOG.md | 1 |
| 8 | Key-by-key merge engine with the v21 fallback (pure; existing data takes the fallback, so behavior is unchanged except the photo union) | js/merge.js, tests/merge.test.mjs, tests/photos.test.mjs | 8 |
| 9 | Writers stamp; `cleared` markers; `hand_unticks`; cover fill flag; fix binders `:268` and `:282` | js/collection.js, js/binders.js, js/binder-cover.js, js/checklists.js, js/wishlist.js, tests/binders.test.mjs, tests/wishlist.test.mjs | 6 |
| 10 | Two-device browser tests for E-15 and E-16 | tests/app.test.mjs | 3 |
| 11 | `merge_version`, the forward stop, `base_stamp`; optional gate SQL | js/sync.js, js/merge.js, supabase/min-client.sql (new), tests/setup-sql-check.sql, tests/app.test.mjs | 3 |
| 12 | (Optional) clock offset estimate and warning | js/sync.js, js/collection.js, js/phone-check.js | 2 |
| 13 | Release v23 (integrator); DESIGN.md sections 3 and 4 | sw.js, CHANGELOG.md, DESIGN.md | 1.5 |

The total is about 46.5 hours, or 44.5 without commit 12. Only commits 7 and 13 touch an integrator-only file (`sw.js`). No new `js/` module is needed, so `SHELL` and the test that `sw.js` lists every module (`tests/binders.test.mjs:353`) are unaffected.

A binder resize (`plans/audit.md`, N-02) should bump a layout version that commit 8 respects, so pockets from two different grids never mix.

## 8. Risks and Decisions

**Risks:**
- **Merge bugs lose data silently.** The mitigations: everything stays pure and tested in Node, a convergence test mixes v21 and v23, and each phone makes a JSON export before rollout.
- **A v21 phone's offline edit to a deleted or collapsed entry is dropped.** That is the intended sticky behavior, but the edit is lost.
- **One deleted copy can come back once.** A tombstone with a v21 random id cannot block a fresh v22 import on another phone (a different id). Deleting live copies because of a tombstone with another id was rejected: after a manual cleanup of duplicates, it would delete the copy Eric kept.
- **The bump rule** moves stamps forward by 1 ms per merge, which is negligible.
- **`merge.js` grows** to about 450 lines.
- **Each local save** costs `stableJson` on pairs that differ, plus a collapse in O(n). That is fine at 1,600 entries.
- **Storage cost:** `cleared` markers cost at most one per pocket, and `field_stamps` appear only on edited entries.
- **If `crypto.subtle` is missing,** ids fall back to random, and section 1b does all the work.
- **Card detail URLs** for a dropped duplicate's id stop resolving. Optionally, redirect them through `resolveEntry` in `js/cards-view.js`.
- **E-18's tombstone purge** would break stickiness and redirects against long-offline devices. Defer the purge until v23 is everywhere, and never purge tombstones that have `merged_into` while any slot or queue row references them.
- **Settings** still merge as one object (`js/merge.js:98-104`), so a theme changed on one phone and a favorite on another lose one of the two. That is out of scope here.

**Questions for Eric:**
1. Is the oldest copy the right survivor for duplicates? For notes, keep the newest non-empty note, or join both?
2. How long should the grace period before bucket deletes be? 14 days is proposed.
3. Install the server minimum-client gate, and when? The proposal is after every family phone shows v23.
4. Add a "Recently deleted" screen, so "restore on purpose" is possible, or are deletes permanent?
5. Two releases (v22 protective fixes, then the v23 key-by-key merge), or one?
6. Correct a skewed phone clock automatically, or only warn?

**Critical files:** `js/merge.js`, `js/collection.js`, `js/binders.js`, `js/sync.js`, and `js/photos/store.js`.
