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

**One language table.** `js/languages.js` holds every language a copy can be in, one row per
code: `pt`, `en`, `ja`, `ko`, `zh-cn`, `zh-tw`, `fr`, `de`, `it`, `es`. Each row gives the English
name, the flag, the short chip (`CHS`, `CHT`), the `lang` attribute, the catalog its prints are
records in, whether TCGdex has a catalog to browse in it (German, Spanish, and Italian do not),
the catalog a copy may fall back to (Korean on Japanese), the PokeAPI name table, monprice's codes,
and the price rules: no Ver na Liga for Korean or Chinese prints, and market prices only for
English ones. The rows are in the app's order, Portuguese and English first, then Japanese,
Korean, and Chinese, then French, German, Italian, and Spanish; flags, pickers, and copy sheets
follow it. Every other
module reads languages from here. *(Decided 2026-10-15: seven separate lists had drifted, so German,
Spanish, and Italian copies showed raw codes and dropped out of lists.)*

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

**Scanning flows with no tap between cards.** Eric changed the first-scan rule above (and
`plans/design-review.md`'s "The first scan opens the confirm sheet") on 2026-10-09: no sheet opens
by itself after a camera scan, the first of a session included; a tap on its tile opens it, and a
photo picked from the gallery still opens its sheet. Instead, a short buzz says a card was
recognised and a double one that it needs a look, a count over the camera reads "12 cards · 2 to
check", and each tile has an x that removes it with Undo. The same card taken again by auto capture
asks "Same card as the last one." with Add a copy or Mistake (no answer in 8 seconds is Mistake),
and each tray card has a Copies stepper, so a duplicate needs no second scan; the shutter still adds
a separate tile. For testing on real cards, Phone check's Record every scan (off by default, so
nobody records by surprise) keeps each scan's report, the scanner's first answer, and what was
saved, as one file to send. *(Decided by Eric, 2026-10-09.)*

**Send report puts the scan log in the account, not in a file to find.** Testing the scanner on 20
to 30 real cards ended in Download scan log, finding the file, and attaching it somewhere. Phone
check's Scanner card now has Send report, with a short note ("Korean cards, glare"): one tap makes
exactly the file Download makes (with the card pictures when Include card pictures was on while
recording), gzipped where the browser can, and puts it in the private `scan-reports` bucket at
`<user_id>/<sent at>-<scans>.json.gz` (sent at like `20261105T101919.274Z`), with a small
`.meta.json` beside it holding the note and the numbers. Gzip because the pictures are JPEG already
and only the text around them shrinks: a log of 30 cards with pictures is about 1.3 MB as a file and
0.9 MB sent (holder mode, which keeps the view before and after each drop, roughly doubles both). A
log over 5 MiB goes up in parts (`.json.gz.part1of3`), each under the bucket's 6 MB file limit, so
even the log's 500-scan limit fits. The report is kept on the phone first
(`js/scan/report-queue.js`), so with no signal, signed out, or a send cut off part way, it waits and
goes on from the piece that failed when the phone is back online, someone signs in, or the app
starts; a refusal (no bucket yet, too large) is kept with its reason, Try sending again, and Save it
as a file. A report that fails for a while (no connection, a server hiccup) does not hold back the
newer ones: each waits its own turn, 30 seconds and then twice as long each time up to 10 minutes,
and all go at once when the phone is back online. Signed out, Send report lists none of the reports
waiting on the phone, only "Sign in to send reports to your account", so nobody sees or saves
another account's report. The log itself is never touched by a send. After a send, Clear the N scans
sent from this phone is offered, not done: it removes only the scans in the report, so any recorded
since stay. Profile > Phone check > Sent reports lists all the account's reports newest first (date,
scans, size, note), page by page however many there are, and opens one as plain text and real
images, reading only that report's files, readable by a person or by page text extraction on any
device signed in to the account, desktop Chrome included: per scan the time, scanner version, what
was read, the text and picture routes, the candidates with the scanner's answer and the saved one
marked, the picture, and any errors. An open report is also `window.scanReport` (`{base, info,
log}`) for a reader in the browser. Download the scan log file and Delete are there too. A report
still going up (Still going up: 1 of 3 parts) can be deleted as well, with a note that the send
stops, so one whose phone never finishes it is not stuck: before going on from a part sent earlier,
and before the meta file that finishes a report, the phone checks that its parts are still there;
when they are not, it sends nothing more, removes what it sent since, and says "Not sent: it was
deleted from your account on another device" until Remove it drops its copy. Only the sender reads,
lists, or deletes their reports: no family member, nobody signed out, and nobody replaces a sent
file (`supabase/scan-reports.sql`, run once). *(Eric, 2026-11-05; built 2026-11-05.)*

**A sent report deletes itself 30 days after it was sent.** Eric would forget to delete reports by
hand, and SQL cannot delete Storage files, so the app does it with the delete each person already
has on their own files (`scan-reports: delete own`). A minute after the app starts, someone signs
in, or the phone comes back online, and only when signed in and online, the app lists the person's
reports and deletes each one more than `REPORT_KEEP_DAYS` (30) days past both its sent-at time,
read from its name, and the newest of its files in the account (the server's `created_at`), all its
parts and its `.meta.json` in one delete, through the same list and delete as Sent reports
(`createReportCleanup` and `reportDeleteAt` in `js/scan/report-file.js`). Both, because the name's
time is when the report was queued, and a report can wait on its phone for weeks (offline, signed
out on a shared phone, a clock behind): it must not be deleted the day it arrives, nor under a phone
still sending it (its newest part arrived lately). A name with no time in it, and a report whose
listing has no `created_at`, are never deleted, and a report still in the phone's outbox is left
alone. It runs at
most once a day per person on each phone (a time in localStorage, noted before it starts), so a
failure is only a console warning and is tried again on a later day. Sent reports says "Reports are
deleted automatically 30 days after they are sent." and each report shows its day, counted from the
later of the two times ("Deleted Dec 6", or "Deleted soon" once that day is past). *(Eric,
2026-11-06; built 2026-11-06; counted from arrival too after review, 2026-11-06.)*

**Holder mode is a remembered switch, not a second scanner.** For a phone held still in a stand over
cards dropped into a box, auto capture waits for each drop to settle and takes it once; everything
else (the tray, the repeat bar, Review) is the same flow. Details in section 6. *(Decided by Eric,
2026-10-09.)*

**Scan has a Trade or sale mode beside Add.** Eric, 2026-11-06, asked to log trades and sales by
scanning the cards; the mode switch, its own two-sided tray, and Log it into the trades log are in
section 11, "Scan a trade or a sale". Add stays the default and works as before.

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

**Deletes stick, and stamps only move forward.** The audit found that "the newer one wins" let an
offline phone's later edit bring a deleted card, binder, list, or photo back. A tombstone now wins
over any live version unless that version was restored on purpose after the delete
(`restored_at` later than `deleted_at`, written by `restoreEntry` in `js/merge.js`). Nothing in the
app restores yet, so deletes are permanent until a "Recently deleted" screen exists. When a rule
like this picks the older version, the result is stamped 1 ms after both, so it is pushed and a
phone still on v21 (which takes the newer stamp) accepts it. Every write takes its stamp from one
`nextStamp`, which is always later than the version it replaces, so a phone whose clock is behind
can no longer lose a real later edit. There is no clock correction: stamps are monotonic only.
*(Decided 2026-10-02, Eric's audit fixes; design in `plans/sync-merge-plan.md`.)*

**Edits to different parts of one entry both survive.** Two phones that change the same card,
binder, list, or wish between syncs no longer lose one side's change. Every write stamps the
fields it changes (`field_stamps`), so the merge takes each field from the version that changed it
last: a Liga price typed on one phone and a note on another both stay. Binder pockets merge pocket
by pocket by `placed_at`, and taking a card out leaves a cleared marker so the pocket stays empty;
hand ticks merge by dex number against `hand_unticks`; photos are always joined by id; a cover goes
by when the picture was made, and filling in its uploaded path does not count as choosing it again.
Pockets saved for two different layouts or grids never mix: the binder reshaped last keeps its
whole set. A version written by an app before merge_version 2 has no valid stamps, so that pair
falls back to the whole-entry rule above, still keeping photos, cleared pockets, unticks, and
deletes; a pocket or tick only one side holds is kept only when it is newer than the other side's
`since`, because an older app removes them by leaving them out. Edits to the same field at the same
time are still decided by the clock. A phone that finds a document saved under newer merge rules
stops syncing and says "Update the app to keep syncing". An optional server gate
(`supabase/min-client.sql`) refuses saves from older apps once every phone runs the new one.
*(Decided by Eric, 2026-10-03; design in `plans/sync-merge-plan.md` section 2.)*

**One import row is one copy, on every phone.** An imported copy's id is a UUID version 5 of its
`import_key`, so the same file imported on two phones, or signed out before the first sign-in,
gives the same ids instead of doubling the collection. Documents doubled before v22 are repaired by
every merge: live copies that share an `import_key` fold into the oldest one (earliest
`created_at`, then the lowest id), which keeps every photo, its own pin while it still shows an
image, the newest Liga price, and the newest non-empty value of each field a person sets (notes
included). The others become tombstones with `merged_into`, binder pockets that held them are
redirected, and a photo waiting to upload on a folded copy goes up under the survivor. Between two
versions of one imported id, the copy someone used wins over a fresh import of it. *(Decided
2026-10-02, Eric's audit fixes: oldest survives, newest non-empty note.)*

**The same wish on two phones is one wish.** Live wishes for the same card, catalog, language,
and finish fold into the oldest after every merge, taking the priority of the most recently edited
one and the newest non-empty note; the others become tombstones with `merged_into`. A wish id is
not derived from its fields, because an edit can change the language or finish. *(Decided
2026-10-02, Eric's audit fixes.)*

**Two tabs on one phone merge like two phones.** Every save re-reads the stored document in the
same IndexedDB transaction and, when another tab wrote since, merges into it entry by entry
before writing; a BroadcastChannel then tells the other tabs, which merge the stored document into
theirs so they show the change. Signed out, one tab's edit no longer erases another's. *(Decided
2026-10-02, Eric's audit fixes.)*

**Bucket files outlive their removal by 14 days.** A removed photo or binder cover leaves the
phone at once, but its file in the bucket is deleted only after a 14-day grace period, once the
server holds the version that removed it, and only while no live entry or binder still shows it
(`bucketDeleteState` in `js/photos/model.js`). Another phone that still shows the file, or brings
the photo back, never points at a missing file. After every sync each phone also sweeps its own
storage: photos of deleted cards and removed photos, and its owner's covers that no live binder
shows, leave the phone, and a deleted card's photos are queued for the same delayed bucket delete.
Family members' files kept on the phone are never swept. *(Decided 2026-10-02, Eric's audit
fixes.)* *(From v48 a photo belongs to its card's record, so a deleted copy or card no longer
queues or sweeps anything: only removing the photo does. See "Photos and notes belong to the card,
not the copy".)*

**One physical card, one entry.**
There is no quantity field. Three Pikachu are three entries, each with its own condition, binder
pocket, and history, and the screen groups them back into one tile with a `×3` badge. Two offline
phones that each add the same card produce two entries instead of overwriting each other into one.
*(Decided by Eric, 2026-10-01.)*

**One account per person, any number of people.**
Each invited user signs in on their own phone, and Eric can invite more. Copies,
collections, binders, goals, and wishlists belong to a user. The card catalog, cached images, and
prices are shared, because they describe cards, not anyone's ownership. Magic link or Google
sign-in; passwords only for a family member without an email (section 8). Every user-owned table carries `user_id` with row-level security from day
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

**A wish is marked got when a copy that fits it is added** (Eric, 2026-10-31; built 2026-10-31).
When any path adds a copy (section 11, Binders, "Placeholders fill themselves"; the scanner too)
of a card on the wishlist (the same card and catalog, and the wish's language and finish when it
names them), the wish moves to a **Got it** section under the list, with the day it was got. From
there he can clear it (removed, as Remove does) or put it back to wanted with Want again. It is
stored on the wish entry as `got_at` and `got_entry_id` (the copy), merged field by field like the
rest, and Undo of the add clears them while the same copy still marks the wish. A got wish is not
wanted any more: it leaves the family's view of the wishlist and the scanner's "<member> wants
this card", and Add to wishlist or Want on a family member's card puts the same item back to
wanted rather than adding a second one. Start over marks only wishes no copy fitted before it ran.
Older apps carry the two fields along and still show a got wish as wanted.

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
in the carousel. A small position line ("12 of 1,359") between a previous and a next arrow, beside
Back, does the same with a tap, and the browser back button returns to the list at the same scroll
position. The arrows first floated at the bottom corners, where on a phone they covered the copies
list and Ver na Liga, so since 2026-10-02 they sit in the top row and never cover the page.

**Sets lists physical cards only.** The TCG Pocket series (digital-only cards) is hidden from the
Sets list. *(Decided by Eric, 2026-10-01.)*

**Card search in the Sets tab.** The Sets search box finds cards across the whole catalog as well as
sets. It takes a Pokémon or Trainer name in English or Portuguese, and finds the Japanese, Korean,
and Chinese prints of a Pokémon through its English name (js/names.js); a number ("025", or
"025/165" to name the set size too); a set code with a number ("MEW 025"); and the kinds ex, GX, V,
VMAX, VSTAR, promo, SIR, and full art, alone or with a name or number. Sets that match still come
first, as before; the cards follow, one tile per print, grouped under their set, with the Owned mark,
the language flags of the copies, and a flag on an Asian print, and each tile opens the card page.
Online the search asks TCGdex's GraphQL card search (English, Portuguese, and each Asian catalog
whose name for the Pokémon is known); offline, or when TCGdex fails, it looks through the sets
already saved on the phone. A search shows at most 60 cards and says when there are more. Three
limits: SIR and full art are told by rarity, which a saved set does not carry, so offline they find
only cards whose page was opened once; promo and full art alone are too wide for TCGdex and ask for
a name or number online; a number alone searches the international catalog, plus the viewing
language's when it is Asian. The logic is js/card-search.js, with tests/card-search.test.mjs and
tests/sets-card-search-browser.test.mjs. *(Decided by Eric, 2026-10-22; built 2026-10-30.)*

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
(section 3). Every entry carries `id`, `updated_at`, and `deleted_at` for the merge. Two optional
fields serve the merge rules of 2026-10-02 (section 3): `restored_at` on an entry brought back on
purpose after a delete, and `merged_into` on a tombstone left by folding duplicate copies, naming
the copy that holds its photos and pockets now.

The key-by-key merge of 2026-10-03 (section 3) adds optional fields, all carried along unchanged
by older apps:

- `field_stamps` on an entry, `{at, since, <field>: time}`, written by every edit. `at` equals the
  version's `updated_at` while the stamps are trustworthy; an older app's edit moves `updated_at`
  only, so that version falls back to the whole-entry rule. `since` is when the version's history
  became trustworthy (its `created_at`, or the first stamped edit after an older app wrote it). A
  field with no stamp counts as `since`. An entry never edited needs none.
- A cleared pocket in a binder's `slots`: `{page, position, placed_at, cleared: true}`, read as an
  empty pocket.
- `hand_unticks` on a checklist: dex number to the time a hand tick was taken away.
- `merge_version` on the document: the highest merge rules any phone saved it with (2 from
  2026-10-03). `base_stamp` on the document as sent: the server `updated_at` the save was merged
  against, which the optional gate in `supabase/min-client.sql` checks.
- `sync_delta` on the document as sent (from 2026-10-15): what that one save changed,
  `{base, lists, top}`, with `base` equal to `base_stamp`. A device that last saw the row at
  `base` reads only this instead of the whole row. Never kept on the phone. With the optional
  `supabase/patch-document.sql`, the save itself sends only this (`js/merge.js`, "sync deltas").

```
{
  "cards": [{                     -- one entry per physical card; no quantity
    "id", "card_id", "variant_id",
    "language", "language_source",        -- scan | manual | import
    "condition",                          -- optional, TCGplayer vocabulary
    "purchase_price", "purchase_currency",
    "opening_id", "storage",              -- storage: "Stored in", e.g. "Bulk box A" (below)
    "grader", "grade", "cert_number", "graded_price",   -- optional; TCGdex has no graded data
    "notes", "is_favorite", "photo_path", "created_at",
    "left_via", "came_via",               -- the move it left or came with (Trades and Sales)
    "removed_by"                          -- {at, run}: Start over or its Undo removed it (section 7)
  }],
  "collections": [{ "id", "name", "rule", "card_ids": [] }],   -- rule null when hand-picked
  "goals":       [{ "id", "kind", "target", "level", "name", "dex_list", "hand_ticks", "languages",
                    "catalog" }],   -- catalog: a set goal's catalog (international, ja, ...)
                                  -- every_pokemon | region | custom_pokemon | set | pokemon | artist
  "binders":     [{ "id", "name", "notes", "cover_color", "rows", "cols", "page_count",
                    "slots": [{ "page", "position",
                                "entry_id" | "want": {card_id, variant_id} | "art": {art_id, tile} }],
                    "art":   [{ "id", "page", "first_position", "rows", "cols", "image_path" }],
                    "rule":     { "source", "order" },   -- a binder from a list (Binders)
                    "snapshot": { "at", "rule_key", "keys", "shown" } }],
  "binder_picks": [{ "id", "binder_id", "key", "entry_id" }],   -- hand picks in a binder from a list
  "wishlist":    [{ "id", "card_id", "variant_id", "language", "priority", "note",
                    "got_at", "got_entry_id" }],   -- got: a copy that fits was added
  "openings":    [{ "id", "product", "set_id", "pack_count", "cost", "currency", "opened_at" }],
  "storage_places": [{ "id", "name" }],   -- the saved "Stored in" places (below)
  "moves":       [{ "id", "kind", "date", "who", "price", "currency", "money", "note",
                    "out", "past", "in", "undo", "after_run" }],   -- trades and sales (section 11)
  "settings":    { "theme", "favorite_pokemon", "fill_placeholders" }   -- follows the person to every device
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

**Hand-made cards** (Eric, 2026-10-03). A card the catalog does not have (an Asian set TCGdex
lists with no cards, an `MEE` card numbered past the eight TCGdex lists, a basic energy with a
letter for a number) is added by hand. It is no new kind of record and no new list in the
document: each copy is an ordinary entry on the catalog `custom`, with a card id made up once,
`hand_` and 32 hex digits (no hyphen, so nothing reads a set id out of it and asks TCGdex). The
card's own facts ride on every copy: the name and set name in `name_local` and `set_name_local`
(the fields the import already uses for names the catalog lacks), the printed number in
`number_local`, the set code in `set_code`, and the finish in `finish_raw` with monprice's words.
So hand-made cards sync, merge (field by field, with no change to `js/merge.js`), export, and sit
in binders like any other copy, with no server or SQL change. Why not a `custom_cards` list with
the facts once: it needs a new merged list, older apps would drop it, and a copy synced without
its card would show nothing. The cost is the facts repeated per copy, and Edit card patches every
copy (only the ones that differ). My Cards and the export read a stand-in record built from the
copy (`js/custom-card.js customRecord`); the page is `cards/<language>/<hand id>`, with no Liga,
US, or EU price (a Liga price typed on a copy still shows on its row). When the catalog later
lists a card with the same set (by TCGdex id, printed code, or name) and number, the card page
offers to link: the same entries move to the catalog card, keeping photos, notes, prices, and
binder pockets.

**Stored in** (Eric, 2026-10-09). Where each physical copy lives (a box, a deck box, a drawer, a
toploader case) is the copy's `storage`: free text, one line, trimmed, at most 40 characters,
edited in the copy sheet and the Add sheet beside condition and notes. The places are saved in a
list of their own, `storage_places`, added to the first time a place is typed and kept when no
copy is stored there any more (Eric's change of the same day: places are permanent options, not
suggestions read from the copies). The sheets offer them as chips, most used first, so typing is
for a new place; "box a" is the saved "Box A". Manage places renames a place (every copy stored
there follows) or removes one (its copies show Not set; asked first when copies are stored
there), both with Undo. Copies stored in two places are two rows of Your copies, each with its
own stepper, and + adds a copy in the row's place. A copy in a binder pocket shows its pocket and,
when set, its place; neither is made up from the other. My Cards and Trade filter by place (copies
counted) or Not set, and a narrowed My Cards stores all its copies at once ("Set storage for these
N copies", with Undo). The CSV carries a `storage` column, which the own-CSV restore reads back.
Family view shows a member's places, read only. Sync needs no change to `js/merge.js`: `storage` is
merged per field like `notes`, and `storage_places` like any list, entry by entry (a place added
on each phone keeps both; a removed place is a tombstone that stays removed). A place's id comes
from its folded name, so the same place typed on two phones is one entry. Older apps carry both
along: `storage` has been an entry field since the first import, and every app merges an unknown
top-level list entry by entry and saves it back.

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

**Doubled CORS header on images.** Some `assets.tcgdex.net` images send
`access-control-allow-origin: *` twice (seen on most sampled `pt` and `fr` images on 2026-10-01;
on 2026-10-15, 6 of 40 sampled `pt` and `fr` images and no sampled `en` card image; on
2026-11-05, `pt/me/me01/001` and `fr/me/me01/001` doubled and `en/me/me01/001` not), which
browsers reject as a CORS failure. It varies image by image within one set folder, even between
images from the same store: on 2026-11-05 `pt/me/me01/001` was doubled and `002` single, and both
carried an `x-amz-request-id`. The doubled responses carry a second set of CORS headers, which
points to an S3-compatible store whose CORS headers nginx sends on top of its own on some
objects. Images therefore load without `crossorigin`, and the service worker keeps those as opaque
responses, which Chrome counts at a random 0 to 14 MiB of quota each (about 7 MiB on average;
measured, 200 opaque 20 KB images counted about 1.5 GB) although the file on disk is its real
size, about 16 KB for a grid image. The worker handles it in three parts:

- **Per image, with the folder deciding when to try again.** Because it varies image by image, a
  memory per folder is only a hint. Every image not kept yet is fetched in cors mode first, and in
  no-cors mode only when that fails. An image whose cors request failed while its no-cors fetch
  came back opaque is remembered with the time, in the worker's own cache
  (`js/image-folders.js`), so a new worker starts from it: it is fetched straight in no-cors mode
  and tried in cors mode again, skipping the HTTP cache (which keeps the doubled header for a
  year), only when a week has passed, or when its folder (host and language) has had no try for an
  hour (the first remembered image shown takes that try), or when another image of its folder has
  worked since (TCGdex fixed something there). An opaque image whose try works moves to the cors
  cache, giving back its padding; one that fails is not tried again until it is due, by any
  worker. The tries and the English stand-ins below run two at a time. A missing image looks the
  same to the worker (TCGdex answers a 404 without CORS headers, and every no-cors answer is
  opaque), so it is remembered for that image alone and never sends another image to no-cors.
- **Sized by bytes, counted in entries.** The cors cache keeps 3,000 images at their true size
  (about 50 to 120 MB). The opaque cache keeps a tenth of the origin's quota in padded entries at
  8 MiB each, 100 to 1,000 entries, as decided on 2026-10-15: about 120 on Eric's phone (10 GB
  quota), which is about 1 GB in Chrome's site storage figure and about 2 MB on disk, so the
  padding never crowds out the collection and photos that share the quota. Both trim the least
  recently used first. Since only the doubled images are kept opaque, the cap covers the doubled
  share of the Portuguese and French cards seen most recently; the English stand-in covers the
  rest. *(Eric kept the tenth on 2026-11-05 rather than half.)*
- **English stand-in.** For every image kept opaque, the worker also keeps the English image of
  the same card in cors mode, at its true size. When a Portuguese or French image is not on the
  phone, the art shows the English one marked "English image" (a line under a tile's meta line,
  a caption on the art elsewhere), and the card back only when neither is kept. A photo of your
  own or a family member's always wins over the stand-in: a photo that arrives later replaces it
  and its line, and a tile with a "Photo by" line never says "English image".

The lasting fix is TCGdex sending the header once (a report for them is drafted in
`plans/tcgdex-cors-report.txt`), or the server-side copy of owned-card images (section 3).
*(Eric, 2026-11-05.)*

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

**Adjust a photo** (Eric, 2026-10-31; built 2026-10-31). Some photos come out too dark, so on a
card's page each photo the owner took has **Adjust**, never a family member's photo or a member's
read-only card. The sheet shows the photo with **Auto**, a levels stretch that fixes a dark or flat
photo in one tap: one stretch for red, green, and blue together, from the darkest to the lightest
of the three channels once 0.5% of each is set aside at each end, so colours keep their hue, no
channel clips more than 0.5% at either end, and it never inverts; a photo still dark after the
stretch gets its midtones lifted (a gamma, never darker), and the gain is capped at four times so
a flat photo is not stretched into noise. Sliders for **Brightness** (a gamma), **Contrast**,
**Saturation**, and **Warmth** (red and blue scaled in opposite directions, like a white balance)
each run from -100 to 100 and change nothing at 0; **Reset** clears them and Auto. Holding the
photo, or the **Original** toggle, shows it as it was. The pixel work is plain code over the
canvas's pixels, not `ctx.filter` (missing on some Safari), and the preview redraws at most once
per animation frame. **Save** makes a new photo that takes the old one's place: the same card
record, the old one's side and `created_at` (so it sits where the old one did in the carousel), and
the main-image pin on every record that pinned the old one. It is saved and queued like a newly
taken photo, so it works offline, and the old photo is removed the normal way, so its bucket file
goes only after 14 days. A detail copy is downloaded and adjusted with the same settings (Auto's
levels included) to become the new photo's detail copy; when it cannot be loaded, the new photo
is saved without one and the toast says so. The settings are applied and never stored. **Cancel**
changes nothing. After Save a toast offers **Undo edit**, which brings the old photo back and
removes the new one. A tombstone wins every merge, on v51 as on v52, so the old photo comes back
under a new id, as the photo cleanup's Undo does: the same file (path and detail copy), side, and
`created_at`, so it shows in the same place, with every pin on the adjusted photo moved to it, its
files on the phone, and its upload queued again if it had not gone up yet. Its bucket file is still
there, since its delete waits 14 days, and a live photo at the same path cancels that delete on the
phone (`bucketDeleteState`) and on the server (`photo_in_use`, `supabase/card-photos-keep.sql`).
Save keeps the old files as bytes for this, since a file read back from the phone's database may
not read once its row is gone. Undo edit runs in an order that leaves the adjusted photo in place
whatever fails: the files and queue rows, then the old photo on the record, then the pins, then
the adjusted photo removed; a failure before the old photo is on the record takes its files and
rows away again, and every step is safe to run again. A photo's upload and delete share one queue
row, so when an upload finishes, the row is dropped only while it is still that upload: a Save or
Undo edit while the photo goes up writes its delete there, and the file is not left behind. Known
limit: two phones adjusting the same photo before they sync keep both results, two photos where
there was one; either can be removed. Code: `js/photos/adjust.js` (the pixels),
`js/photos/adjust-view.js` (the sheet), `saveAdjustedPhoto` in `js/photos/index.js`, and
`replacePhoto` and `undoReplacePhoto` in `js/photos/store.js`.

**Photos and notes belong to the card, not the copy** (Eric, 2026-10-22 for photos, 2026-10-30 for
notes). A photo taken for a card serves that card, often as its only image, so it must outlive every
copy of it: a card at zero copies keeps its photos and notes, and they show again when the card
comes back. Each person keeps one record per card and language (catalog, card id, language) holding
its photos, notes, and main-image pin, synced and merged like the other lists, and shown on every
copy of that card; a language without its own photo shows another language's. Copies keep only what
is physical: finish, condition, Stored in, favorite, and binder spot. Existing photos and notes move
off the copies once, in place, and the files stay where they are in the bucket. This replaces the
per-copy `photos` and `notes` above, and the sweep in "Bucket files outlive their removal by 14
days" no longer deletes a photo because its card was deleted: only removing the photo itself does.
Motive: Eric rescanned every card into a new monprice list to start his counts over without losing
a photo or a note. *(Decided 2026-10-22 and 2026-10-30; built in v48.)*
Built (v48, 2026-10-30): the list is `card_info` (`js/card-info.js`), one record per catalog, card
id, and language. Notes from several copies of one card are all kept, newest first, each distinct
text once. New photos go in their own bucket folder (`<user>/<photo id>/<photo id>.webp`); moved
photos keep their old paths. Phones on v47 sync the same document for a while, so the move is not a
one-time step: it runs on every load, save, and merge. A v47 phone keeps the `card_info` list (its
merge keeps every top-level list it does not know), but still reads and writes photos and notes on
copies, and deletes the bucket files of a deleted copy's live photos 14 days later. So a moved
photo stays on its copy as a tombstone marked `moved` (a v47 phone no longer shows it, and never
queues its file), a photo a v47 phone adds or removes on a copy reaches the card on the next merge,
and a note it types on a copy joins the card's notes and is cleared from the copy. A photo still
waiting to upload on a v47 phone stays live on its copy until the path is known, and one with a
detail copy for its first day, so that phone still uploads the detail copy. A photo a v47 phone
removed joins the card as removed, so the phone that took it never restores it. A copy a v47 phone
deleted (not merged into another) brings its photos as removed when they have no path, or when the
delete is 14 days old and the card did not already show them, since v47 deleted those files; its
pin is ignored. The family's photo list moved from `photo_index` to `photo_index_v2`: a v47 phone
rebuilds `photo_index` from the copies on every save, so v48 leaves it to v47, and family members
read `photo_index_v2` plus any `photo_index` entry it lacks. Two phones that
each moved different copies' notes before syncing keep both (`mergeCardInfo`). For the cases this
cannot reach (a v47 phone that deleted copies offline, or queued deletes before v48),
`supabase/card-photos-keep.sql` makes the bucket refuse to delete any file a card record still
shows; Eric runs it once. The per-copy fields can be dropped from the move after a min-client bump
that stops v47 phones from writing.

**Offer to delete photos once the catalog has an image** (Eric, 2026-10-22; built 2026-10-30). The
official image already becomes a card's main picture when TCGdex adds one, unless a photo is pinned
as the main image, so a photo taken because the catalog had none mostly takes bucket space. After My
Cards' background pass, which reads each owned card's TCGdex record again once a week, the app looks
at each copy's photos in the copy's own language: the card index recorded that language with no
image, and the TCGdex record saved for that language now has one. A French copy is judged by the
French record, never the English one, and a Korean copy kept on a Japanese record is never offered,
since that catalog holds no Korean art for it. The copy must still carry the person's own front
photos already in the bucket. Back photos are never offered: the official image shows only the
front, and a back photo records the card's condition (decided for Eric on 2026-10-30 while fixing a
review; he can reverse it). The app then shows a notice: "5 cards now have official images. You can
delete your 7 photos of them to save space.", with Review and Not now. The notice counts only the
photos ticked at the start, so a card whose offered photos are all pinned is listed in Review but not
counted, and alone shows no notice. Review lists each photo with the card's official image beside
it, ticked, except a photo pinned as the main image, which starts unticked, and a "Delete N photos"
button. A row whose official image does not load is unticked, cannot be ticked, says the image did
not load, and is not counted in the button. Delete first gives the card index the official image in
that copy's language only, so the tile shows it; if that fails, nothing is deleted and an error
shows. It then removes each ticked photo the normal way (so its bucket file goes 14 days later, and
it leaves the family's photo list too) and offers Undo on a toast. A photo another phone removed
while Review was open is not counted and not brought back by Undo. If a removal fails part way, the
toast offers Undo for the photos removed and says how many could not be deleted, and those cards
are offered again. Undo puts each photo back on the same file under a new id, since a removal always
wins a merge; the live photo at the same path cancels the queued bucket delete, and a pin comes back
with it. Not now, or closing Review, remembers the cards offered on this phone for that person, so
the notice shows again only when another card gains an image. Limits: a photo still waiting to
upload is not offered (it takes no bucket space yet), and a copy in any language but English is
found only once the record in its own language is saved on the phone, since the weekly pass reads
the English record first. Code:
`js/photo-cleanup.js` (the rules) and `js/photo-cleanup-view.js` (the notice and the sheet).

**Import "Match this file"** (Eric, 2026-10-22). The file is the truth for how many copies exist of
each card, language, and finish, copies scanned or added in the app included. Copies are matched by
that count, never by `import_key`: app-added copies have none, and a new monprice list need not
line up with an earlier import's copy indexes. Eric does not care which copy survives, so the
oldest existing copies are kept up to the file's count, the shortfall is added (an earlier deleted
copy never blocks an add), and the extras are removed. Condition, Stored in, and favorite carry
over from removed copies onto the kept or added copies of the same card as far as the new count
allows. A binder pocket whose copy is removed takes another copy of that card, or becomes that
card's placeholder when none is left. Nothing is applied before a preview ("+12 copies, -5 copies,
3 photos kept, 2 pockets became placeholders"), and the result offers Undo. *(Decided 2026-10-22;
not built.)*

**Image carousel per card** (Eric, 2026-10-01). Card detail shows every image of the card in a
swipeable carousel with dots underneath, shown only when there is more than one. Order, which is
also the default main image: the official catalog image once TCGdex has it (so it takes over by
itself when it appears), then a confident international twin's image (labelled "International
print"), then the owner's own photos (several allowed, front and back). Each image carries its
source label. "Use as main image" pins any one of them as what tiles show; without a pin, the
first available image in that order is used. Tapping opens the image full screen.

The main image rule applies on every screen that draws a card, not only My Cards (Eric,
2026-10-31; v54): binder pockets, placeholders, Gone pockets, list pockets and their copy picker,
the card in hand, the tray and its Add cards picker, the owned-card picker, Not in a binder, Sets
(a set's cards and the card search), a Pokémon's cards, goal cells, the wishlist (the person's and
a family member's), and the rows of a collection's left-out sheets, which show the card back when
there is no image. They all go through one helper (`js/photos/index.js` `tileSrc`,
`withMainPhoto`, and `mainArt`, deciding with `js/card-info.js` `mainImageOf`). A card with no copy
there (a placeholder, a wish, a card missing from a set or a goal) reads its card's record, which
keeps its photos and pin at zero copies. A family member's screens read the member's card records,
never the viewer's: a read-only screen that passes none shows no photos rather than the viewer's.
Their wishlist, which reads the wishlist alone and never their whole document, takes their
uploaded photos from the photo index the family shares, without their pin.
Catalog-only by design: the scanner's candidates and search results, the wishlist and placeholder
catalog searches, photo cleanup's official image, and the twin picker.

**Inspection viewer** (Eric, 2026-10-01: "find some details in the card or compare to another card
to figure out if the card is original"). Tapping the card image on its page opens it full screen
with pinch and double-tap zoom and panning (a binder's card out of its pocket zooms with the same
pane, 2026-11-06). **Compare** shows two images side by side (by default
the official image and the person's photo) with zoom and pan synchronized in card coordinates, so
the same corner, font, energy symbol, or holo pattern lines up on both; the link can be turned off.
Official images are about 600 x 825 px, enough for most details but not microprint, and photos are
stored at 600 x 840, so an optional per-device setting keeps a **detail copy** of new photos at
about 1440 x 2016 px (capped at 500 KB each, about 1,800 within the free 1 GB beside the normal
copies),
downloaded only when zooming in.

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

**First phone test (2026-10-01):** a scan of a phone photo of a laptop screen (Weedle, Chaos Rising,
`me04-001`) took far too long and found nothing: the collector number was hidden under an app
label and blurred by screen moire, and the scanner had no route other than the number. Fix in
progress: read the name, HP, and attack name in parallel with the number, total, language label,
and copyright; combine the clues, with the name as a second route and an artwork comparison as a
tiebreaker; warm the engine on opening and use two workers; and when nothing is certain, show
what was read with a prefilled search instead of a dead end.

**Later: image-first recognition** (noted with Eric, 2026-10-01; not scheduled). monprice says it
identifies cards with a custom model trained on over 19,000 cards, returning results in about
0.1 seconds: recognition by picture, not text (its app is closed source and is not inspected). The
free equivalent: a small open image model running on the phone (a few MB, through ONNX Runtime
Web or TensorFlow.js) turns the straightened capture into an embedding; a prebuilt index of
embeddings for every catalog card, made once from TCGdex images by a scheduled GitHub Actions job
(free for public repositories) and quantized to roughly 2 to 5 MB for the international catalog,
gives the nearest candidates in a fraction of a second even when the number is unreadable; OCR
of the number and name then separates reprints with the same art and reads the language. Before
building it: confirm TCGdex's terms allow bulk image processing for an index, pick and measure a
model on phone-class hardware, and decide how often the index rebuilds as new sets appear.
Order, agreed with Eric: the image fingerprint goes first and finds candidates, because artwork
survives blur, glare, angles, and a covered number far better than small text and the lookup is
fast; OCR then breaks ties only among those candidates (reprints with identical art by number and
set total, Portuguese versus English by the language label, Japanese versus international by
script), and a clear disagreement between picture and text flags the card for a look instead of
saving it. Neither method tells the finish apart, which stays the one-tap finish picker. Schedule
after the text-first improvements are tested on real cards.

**Switched to picture first (Eric, 2026-10-03).** On Eric's phone each OCR read took 2 to 11
seconds (5 to 9 per scan), names over artwork read as junk, and a scan failed whenever the number
did not read cleanly, while finding the card's edges took 0.2 to 0.7 seconds and always worked.
The fingerprint prototype (`lab/fingerprints/RESULTS.md`: a DCT hash of the art box and of the
whole card plus a colour layout, matched against an index of every TCGdex image, no model to run)
put the right card first 95 % of the time against 81 % for OCR, in about 28 ms. So the scanner now
straightens the card, fingerprints it (`js/vision/`), and matches it against the index
(`js/vision/index.bin`, precached by the service worker, loaded once per visit):

- The first artwork group leads the second by 10 or more and holds one card: that card, with no
  text read (the prototype measured no wrong art selected at that lead).
- It leads but holds several cards (reprints, a Japanese print and its English twin): only the
  number, total, set code box, and language label are read, to choose inside it.
- The lead is small: the top five are shown as pictures to tap, a number read that names one of
  them promotes it, and a number that names none falls back to the text lookup.
- The picture and a number read disagree: the card needs a look, never a save.

Tesseract now loads only when a card needs text, so Scan opens without its 7 MB. The straightened
crop is snapped to a card's 63 by 88 shape (crops that came out 0.733 to 0.740 wide for their
height missed the read boxes), and when the box was too wide the fingerprint also tries it with
the extra trimmed from either side. A number that names a set the catalog has not got yet (Korean
`M6`) offers "Add by hand". The index holds the English, Portuguese (`sm3.5`), Japanese, and
Traditional Chinese images TCGdex has (25,767 cards, 1.2 MB gzipped); Simplified Chinese has no
images there, so those cards match only through a print with the same art. **Still open:** whether TCGdex's terms allow bulk image processing for
an index, which has to be confirmed before the index rebuild is scheduled.

**The card anywhere in the frame, holder mode, and Review (Eric, 2026-10-09, version 34).** Eric's
scan log of 53 cards dropped one by one into a white box under his phone in a 3D-printed stand
(version 32, 1x and 1.5x zoom) showed: every sure answer right; auto capture keeping up early (a
card every 5 to 6 s) but the shutter used 18 times in the last 20 scans, because as the pile rose
each new card grew past the guide, or landed offset with the top strip of the card beneath showing,
and the edge finder, looking only inside the guide plus its 10 % margin, took the outline of two
cards and cut the new card's bottom (distances 54 to 69, "needs a look"); cards needing a look took
7 to 14 s, nearly all of it OCR; and one auto capture of the same card 2.6 s after the first joined
the tray instead of asking. Decided:

- **The card is looked for in the whole visible frame, in every mode** (`js/scan/steady.js`
  `findCard`): the straight lines of a small copy of the frame (200 px on its longer side, 360 px at
  the moment of capture) make four-sided boxes, and a box is a card when it has a card's 63:88 shape,
  all four sides drawn and stopping at its corners, all four corners inside the frame clear of its
  edge (a box wall or a screen's edge running off the frame is never a card), and print in its
  middle. A larger box round a smaller one wins when the ring between them is a card's border or busy
  with print (a card round its art box: a Sword & Shield art box has a lying card's shape), and a box
  inside another wins on plain ground (a card on a box's floor). The box found is judged on a
  thumbnail with every check the guide's capture had (stripes, a colourless sheet, a card too far
  away), the capture is cut round it from the full-resolution frame, and its outlines go to
  `identify.js` to be cut by their own corners, their edges found again, beside the edge finder's
  crop, for the picture to choose. With no card found, the guide's capture area is used as before.
  The guide stays as a hint and lights up when a card is found anywhere; a card smaller than half the
  guide's height says "Move closer" and is taken only by the shutter.
- **The top card of a pile:** the outline of two stacked cards is too tall for a card's shape, and the
  top card is the one whose four sides are whole; where two cards and their borders cross, up to three
  outlines go to the picture, which picks the top card.
- **Holder mode** (a switch at the foot of the camera, remembered on the phone, off at first): auto
  capture waits for the picture to move (a card falling in) and then stay still for 400 ms, needs a
  whole card found in the frame, and takes it once; the next card landing moves the picture and arms
  the next capture. Motion is measured on the whole view with its overall brightness change taken out
  (the camera re-exposing is not motion). Something moving over the pile with the same card left on
  top takes nothing. A card-shaped outline running off the frame once the picture settles says "Pile
  too high: empty the box." and takes nothing. Hand-held mode keeps its rules, on the card found
  anywhere.
- **The shutter waits up to a second for a whole card:** pressed with no whole card in the frame, it
  takes the first frame within about a second where one is found and still, or the picture anyway
  when the time is up. The shutter always takes a picture.
- **Review runs through the cards that need a look:** Done's Review opens the first; once it is
  settled the next opens by itself, Next card skips one, and after the last the Done sheet comes back.
  Stop, Back, or Close end the run, and the cards left stay marked in the tray.
- **A card the picture narrowed reads only its number:** from the strip its candidates' era prints it
  on (bottom left from Sun & Moon on, bottom right for XY and older), stopping as soon as a number
  reads; the other strip and the sparse passes only when it does not. The label row and the set code
  box are read beside it only when the first group holds several prints (an English card and its
  Japanese twin share a number and total); otherwise the label is read behind the tray, as for a card
  the picture settled.
- **A repeat is told the moment the picture is known:** each capture's picture is kept as soon as it
  is matched, and a capture whose previous one is still being read waits for that read, so the repeat
  bar no longer depends on how fast the phone saves photos.
- **The scan log keeps** the zoom, holder mode on or off, the card found (its box as shares of the
  frame, its shape and turn), how long the picture had been still, and how long the shutter waited
  and whether a whole card came.

**Holder mode by what changed (Eric, 2026-10-09, version 36).** Version 35 never ran on the phone
before Eric's next session, so it was measured on what he recorded instead: two videos of the stand
over the white box (a flashlight at three angles, zoom 1x and 1.4x, slow drops and his own fast
rhythm, and a second video with the phone's torch on), replayed frame by frame through the
scanner's code at its loop rate (`lab/holder/replay.mjs`), and the 96 straightened cards of his two
scan logs with the card he saved for each (`lab/holder/crops.mjs`). Version 35 noticed 10 of 37
drops in the first video and 6 of 20 in the second: after each capture it took a new card landing
in the same place for the card already taken (same box, a small difference), and it waited for one
frame with four clean edges. Decided:

- **Measured on the replay**, version 36 against 35: the first video 37 of 37 drops taken exactly
  once (10), none mid-fall, 35 sure, all right; the torch video 19 of 20 (6), 18 sure, all right
  (the one missed landed while the camera app was still settling its zoom, an artefact of the
  recording). With the main thread held four times as long as the work took here, as on a
  mid-range phone, version 35 took 6 and 3, version 36 still 37 and 19.
- **A card is what changed** (`js/scan/drop.js`): the view is averaged into 4-pixel cells; once it
  has been still for 300 ms and two frames, it is compared with the last still picture, brightness
  matched (the commonest ratio between the two, so a card covering most of the view does not skew
  it), and the largest blob of changed cells is the new card when it is a card's size and shape.
  The still picture then becomes the one to compare with, every still frame, so the next card is
  compared with the pile as it lies, light drift never adds up, and a card that lands while the
  loop was held up is still seen. A card landing on the very spot of the last is a change (its
  picture differs); the same card dropped again on the same spot is not seen, and the shutter
  takes it. What changed and is no card takes nothing, and the scan log says why: nothing to
  speak of (a hand passed), too small, the shape of a strip or a shadow, a card taken away (plainer
  ground where it lay), the light (the same edges lit another way, over most of the view: the lamp
  moved from one side of the box to the other), the last card nudged, or a card off the frame.
- **The crop comes from the change**: its rectangle snapped to 63:88, cut again from its top or
  bottom when a strip of the card beneath moved too, and grown from the picture when only the art
  changed (two cards of one type share their colours below the picture); the outlines `findCard`
  finds over it come first. The picture match chooses among them, as it chose among outlines.
- **Detection never pauses**: it goes on while a sheet is open; the part of the frame watched stays
  put however the screen is laid out after; the picture is matched in a worker
  (`js/scan/see-worker.js`), off the frame loop; the number, when the picture wants it, is read in
  a queue of its own, so a card being read never holds the next card's picture. Every drop adds its
  tile at once. In holder mode each drop is a card, the same card dropped again included (a second
  copy), so the repeat bar never asks.
- **A wider picture search when the plain one is not sure** (`js/vision/fingerprint.js`
  `WIDE_SHIFTS`, `js/scan/picture.js` `matchCrops`): moves of up to 7.5 %, zoomed in 8 and 14 % and
  out 8 %, and the card squeezed by a strip of the card beneath or a side cut short, on the two
  closest crops, with the index screened on each hash's first word so the cost stays low. On the
  log crops: right card first 92 of 96 (88 before), sure 73 (55), none wrong but sure; on 1,056
  re-crops of them, right first 919 (472). The index is unchanged (no rebuild was needed). With it,
  a lead of 15 within distance 55 is sure (it was 20): no wrong first place led by more than 6.
- **A soft frame waits**: a drop whose card is less than 0.45 as sharp as the last few waits up to
  400 ms for a sharper frame.
- **Focus and white balance are held** in holder mode once the camera has found them (where
  Android Chrome offers it), found again every ten cards and when the zoom changes; exposure stays
  continuous.
- **Review starts from any card that needs a look**: its tile (the run goes round the tray from it,
  newest first), the "N to check" count over the camera, Done's Review, and Save while cards need
  a look; after the last card the camera comes back. The open sheet is redrawn only when its card
  changes and never shrinks while open: cards arriving behind the sheet redrew it under Eric's
  finger, and a sheet that shrank put the backdrop where his next tap landed ("I select the card,
  it closes").
- **Light**: on the videos the phone's torch overhead (the glare spot in the middle of the card)
  and a flashlight beside the box both gave sure answers; the flashlight high behind the box gave
  the most cards to check. No glare mask was needed: the picture's low frequencies hardly move
  under a small glare spot. Holder mode shows a one-line tip until dismissed.
- **The scan log keeps** the scanner's version (36) in every entry, each drop's numbers (the share
  changed, the blob, how long it was still and moving, the sharpness, how many outlines agreed),
  the skipped drops as entries of their own with why, how long each card waited in the picture and
  text queues, and two small views of each drop (before and after, about 320 px) for
  `lab/holder/replay-log.mjs`, for the last 80 drops.

**Full-art numbers and names in other languages (2026-10-15, from Eric's kept items of
2026-10-09).** Two gaps in the text the scanner reads when the picture cannot settle a card:

- **Full-art collector numbers are read by their ring** (`js/scan/read.js` `ringedNumbers`).
  Special illustration rares, illustration rares, gold, and full-art ultra rares print the number
  as dark italic digits inside a thick white ring, over the art; read as a strip, the art and the
  lines round it drowned the digits (the Portuguese Ampharos, `me04-090`, never read). For a card
  the picture index flags as full art, the number strip's whitest channel (the least of red,
  green, and blue, so coloured art stays dark) is cut at its whitest 12 %, the white shapes about
  a text line tall and side by side make runs, and what each run's ring encloses is cut out as
  dark digits on white and read as one line, before the strip's own lines, which are read only
  when no run gives a sure number. Measured on 48 full-art TCGdex scans through five simulated
  captures (`lab/bench/fullart.json`, `run.mjs --numbers`), the number reads right on 134 of 240
  (80 before; clean captures 37 of 48 against 21, turned 35 against 21), wrong on 27 (29), with a
  median of 4 OCR calls (5). A strong blur (1.6 px) still reads nothing either way. Contrast,
  threshold, top-hat, and polarity variants of the whole strip were tried first and gained nothing:
  the OCR cannot pick out the digits while the ring and the lines above and below are in the crop.
- **The name when the picture and the number both fail**: `readNumber` then reads the name strip
  too, and `js/scan/picture.js` `pictureMatch` puts the card of the picture's five that bears the
  name first, or offers the cards the name route finds before them. A name never makes a card sure.
- **Names as Western cards print them** (`js/scan/local-names.json`, 79 KB, 36 KB gzipped, built by
  `lab/names/build.mjs`): every species in English, French, and German from PokeAPI (BSD-3-Clause;
  PokeAPI has no Portuguese, and Portuguese cards print the English names), the other spellings
  TCGdex prints carry (MIT; the Portuguese Paradox Pokémon such as "Presa Grande" for Great Tusk,
  Type: Null's "Tipo Nulo", older French and German spellings), and the Trainers from Sun & Moon on
  under their Portuguese, French, and German names (every era's Trainers would take 34 KB gzipped
  for the Trainers alone rather than 22 KB). It is fetched the first time a name is looked up and
  precached by the service worker. `js/scan/evidence.js` `matchNames` scores a read against it as
  the English list was scored (accents and OCR lookalikes folded, words glued together, short names
  exact), screened by letter pairs so the 5,700 spellings stay cheap; a name read in another
  language counts for a card through its English name, and a Trainer's prints are asked of TCGdex
  by its English name (`js/scan/match.js` `namedPrints`, online only).
- **The lab benchmark** (`lab/bench`, 240 captures, same machine, before and after): the picture
  route still puts the right card first on all 240, sure on 202 (198), none wrong but sure; the
  text route (no picture index) on 194 (190). The holder benchmarks match pictures only, which this
  leaves alone.

**Japanese and Korean names (Eric, 2026-11-04; built 2026-11-04).** Most of Eric's Asian cards are
Korean copies kept on Japanese records (section 5), and most of those records have no image, so the
picture route cannot match them; when the collector number does not read either, the scanner had
nothing to go on, because the English model reads no Japanese or Korean. Now the name strip can be
read in either script:

- **Two more models, loaded only when a card asks** (`js/scan/ocr.js` `createAsianReader`):
  Tesseract's `jpn` and `kor` from tessdata_fast (Apache-2.0), gzipped beside the English one in
  `lab/vendor/tesseract/lang` (1.52 MB and 1.11 MB). They run in workers of their own, never in
  place of an English worker, so a Latin card's reads never wait for them: one worker per model on
  a phone with the memory for two English workers (measured in headless Chromium: an English worker
  about 80 MB, a Japanese or Korean one about 35 MB more each), else one worker that switches
  models (about 40 ms for a model loaded before). The page fetches a model before the worker does,
  so a model that cannot be fetched (offline before it was kept) makes no worker at all, and
  nothing is tried again until the phone is back online. The service worker
  keeps them the first time one is used (`sw.js` `ocrResponse`), each under its version (the first
  12 hex digits of the file's SHA-256, `OCR_MODELS`, checked against the files by a test) so a
  changed model is fetched again, and never precaches them, so the app's first load does not grow.
  A load runs outside the reads: no read runs while a worker changes models, and the reads
  waiting on a load race one 20 s limit from its start, together; past it they give up, and later
  reads give up at once until the load settles. Chosen over the integerized tessdata_best models
  (2.0 and 1.6 MB) on the benchmark below, read as known Japanese or Korean cards: Japanese names
  right on 29 of 48 reads against 26, Korean 16 of 32 against 16, in less time.
- **When they load** (`js/scan/cjk.js` `wantsCjk`, `read.js` `readName`): a card whose language
  is already Japanese or Korean (picked by hand, or Set for all) has its name strip read with that
  model only, waiting for it up to 20 s. Otherwise the English read of the strip comes first, and
  the models are asked about only when the strip's tallest line has the shapes of kana, kanji, or
  Hangul (`looksCjk`: glyphs nearly as tall as the tallest, not narrow, mostly ground inside their
  boxes; on the benchmark's name lines 68 % of the Japanese and Korean ones pass and 10 % of the
  Latin ones) or the last language picked in Scan was Japanese or Korean. Only then is the English
  read checked against the Western names (`local-names.js` `latinNameScore`, tens of milliseconds
  on the main thread); a read that names a known Pokémon or Trainer at 0.75 or more, or holds the
  word Energy in a Western language (the Western table holds no Energy), is Latin, a Latin label on
  the label row vetoes the models, and a table that could not load says nothing, so no model is
  read with. A label row with no Latin label is not a reason on its own: Energy and Trainer cards
  have no weakness row. Such a card, its language not known, never waits for a model: it reads
  only with a model already loaded and starts loading the one it wanted for the cards after it.
  The model tried first is the one the strip's closed loops suggest (Hangul is full of them); when
  they do not say, the model already held, then one loaded before, then the last Asian language
  picked (Korean before any), so an unclear card switches models once, not twice. The other is
  tried when the first names nothing. A read that names a card at 0.8 or more is the name; a
  weaker one waits for the English passes and is kept only when they read nothing.
- **Matching** (`cjk.js` `cjkKey`, `matchCjkNames`): full and half width, hiragana and katakana,
  small kana, voicing marks, long vowel marks and the kanji the model reads for katakana (口 for
  ロ, 力 for カ, 一 for ー), and Hangul composed or spelled out are folded to one key, Hangul in jamo
  so a misread stroke costs one letter of several. A Korean name of one or two syllables and a
  Japanese name under three kana must read exactly (the shortest also before the folding: "パウ" is
  not the Trainer "ハウ"), one of three or four kana loses a little more for each misread, and only
  a name of seven or more jamo, or four or more kana, is found inside a longer read (the Japanese
  model reads the stage label glued to the name, "デスナヘビ"); so random Hangul and katakana
  of two to five letters name a Pokémon at 0.7 under 1 % of the time (4 to 7 % before). A Korean
  read is only compared with Korean names. Names the folding cannot tell apart (カラカラ and
  ガラガラ, ポリゴン and its two evolutions, ニドラン♀ and ♂) come back as ties and are all looked
  up, never one of them; a record's own printed name picks its species exactly. The names (`js/scan/asian-names.json`, 43 KB, 17 KB gzipped,
  precached, built by `lab/names/build.mjs`): every species in Japanese and Korean from PokeAPI
  (BSD-3-Clause; `ja-Hrkt` is the same as `ja` for every species) and the 711 Japanese Trainer names
  TCGdex prints from Sun & Moon on (MIT). No free source of Korean Trainer names was found:
  TCGdex's Korean catalog holds 34 Trainer cards, numbered unlike the Japanese records they share
  codes with, and TCGdex's Japanese names of older Pokémon prints are machine translations, so
  neither is used.
- **Finding the prints** (`js/scan/match.js`): a Japanese name finds the species' Japanese prints
  (`pokemon-cards.js` `loadAsian`), a Japanese Trainer's by its Japanese name; a Korean name
  searches the Korean catalog and then the Japanese records Korean copies sit on, the set lists and
  lookups asked all at once within 4 s together (one after another they took up to 16 s on a slow
  link). A record the
  number found agrees with a Japanese or Korean name through the species its own name is
  (`dexOfCjkName`), so a Korean read agrees with the Japanese record. A name alone never makes a
  card sure; with the number and total it can, as before. When the picture is unclear and the
  number does not read, a candidate the name route found for that name is put first, not sure
  (`picture.js` `namedBy`).
- **The lab benchmark** (`lab/bench/asian.json`, `run.mjs --dataset asian.json`, six captures of
  40 cards, text route, same machine, before and after): 16 Japanese Pokémon and 8 Japanese
  Trainers from TCGdex's Japanese scans, and 16 Korean copies made synthetic by painting the Korean
  name over the Japanese scan's (TCGdex has no Korean images; Noto Sans CJK KR Bold, not the
  printed typeface). Japanese names were read right on 56 of 96 Pokémon captures and
  18 of 48 Trainer captures, Korean on 45 of 96 (none before); the right card came first on 186
  of 240 (136), in the first three on 199 (147), and on 21 of the 40 captures with the number
  blurred out (none); sure on 81 (72). Wrong but sure stayed at 1, the same capture before and
  after: a blurred Korean copy whose number reads 120 for 123, with no name read either. The
  median card read 14 OCR calls (13) and took 1.2 s (0.9), 1.8 s at the 90th percentile (1.5),
  inside the 2 s a card; the first model load took 0.4 to 0.8 s and a switch between the two
  models about 40 ms. After (before):

  | Captures | Name right | Right first | Top 3 | Sure | Wrong but sure | OCR calls | ms, median and p90 |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | Japanese Pokémon, 96 | 56 (0) | 77 (55) | 81 (58) | 35 (31) | 0 (0) | 14 (13) | 1308, 1844 (877, 1559) |
  | Japanese Trainers, 48 | 18 (0) | 38 (32) | 39 (32) | 19 (17) | 0 (0) | 16 (14) | 1250, 1563 (865, 1293) |
  | Korean, synthetic, 96 | 45 (0) | 71 (49) | 79 (57) | 27 (24) | 1 (1) | 14 (13) | 1216, 1827 (927, 1428) |

  The Western benchmark (240 captures) is unchanged: the right card first on 194 of 240 both
  times, names right on 164 both times, none wrong but sure, sure on 102 (103: a Latin card whose English read failed was read
  as Japanese junk that named another Pokémon, which held it back from sure), and 11 of the 240
  captures (cards whose English name read failed) read their name strip with a Japanese or
  Korean model as well.
  Measured on a laptop, not a phone (Eric's phone took 2 to 11 s per OCR call, 2026-10-03).
- **After the review of the first draft (2026-11-04, version 56).** The numbers above are the
  first draft's, which a review found loading and waiting for the models on Latin cards (a
  perfect "Fire Energy" read was read again in Korean and Japanese, its label row having no
  weakness), stacking 20 s waits per name line on a slow link, switching models twice per unclear
  card, and naming a Pokémon from 4 to 7 % of random Hangul reads. With the rules above, the same
  benchmark, the same machine, the first draft run again just before (it reproduced the table
  above exactly):

  | Captures | Name right | Right first | Top 3 | Sure | Wrong but sure | ms, median and p90 |
  | --- | --- | --- | --- | --- | --- | --- |
  | Japanese Pokémon, 96 | 37 (56) | 70 (77) | 73 (81) | 35 (35) | 0 (0) | 1352, 2564 (2181, 3159) |
  | Japanese Trainers, 48 | 14 (18) | 37 (38) | 38 (39) | 18 (19) | 0 (0) | 1423, 2344 (2087, 2756) |
  | Korean, synthetic, 96 | 22 (45) | 60 (71) | 68 (79) | 26 (27) | 1 (1) | 1243, 2091 (2212, 3127) |
  | All, 240 | 73 (119) | 167 (186) | 179 (199) | 79 (81) | 1 (1) | 1336, 2398 (2168, 3094) |

  The right card still comes first far more often than with no Japanese and Korean reading (136),
  and on 17 of the 40 captures with the number blurred out (21; none with no reading). The models
  never switched (one worker each; 278 switches before) and the first card that wanted one was
  read without it. Most of the loss is the dropped trigger: 35 of the 46 names no longer read
  right were on strips whose shapes do not look Japanese or Korean, which the first draft read
  because the label row had no Latin label; 10 are reads the stricter matching no longer takes
  (short names that must read exactly, a short Korean name inside a longer read), and 1 was read
  before its model had loaded.
  The times ran on a laptop also running other work, so they say more about the order than the
  size: fewer switches and no reads of Latin strips with the models. The Western benchmark is
  unchanged: right first on 194 of 240, names right on 164, none wrong but sure, sure on 103
  (102 with the first draft), and no Japanese or Korean model loaded at all (the first draft
  loaded one for 11 captures); the `slantfull` pass the same, 31 of 40 first. Measured on a
  laptop, not a phone.
- **Still open:** most of the names the first draft read right and this one does not are on
  strips the shapes test passes over (32 % of the Japanese and Korean name lines). Letting a
  missing Latin label ask again, only once a model is loaded so a Latin pile never downloads one,
  would win some back at the cost of a few extra reads of Latin Trainer cards; it waits for Eric's
  call and his own Korean cards. The Korean captures are synthetic until Eric's own Korean cards
  are scanned; the language is still picked by hand (the name's script is not used to set it).

**The strong-slant cut (roadmap, measured 2026-11-04, fixed 2026-11-05, branch `slant-cut`).** A
card held larger than the guide, or low in it, and turned runs out of the capture, and the
outermost line left on that side is one inside the card (the weakness row, the number strip's rule,
or the border's inner line), so the box stopped there: on the guide's capture, `rectify.js`
`findEdges` and `plausible` and the box search `findQuad` took that line for the bottom and worked
the top out from the width, taking in the table above the card. The whole-frame path (`steady.js`
`findCard`, version 34) was worse: with the card running off the frame, the best box left was its
art box (a Sword & Shield art box has a lying card's shape) or its inner border, and the capture was
cut round it, cutting the card. Fixed:

- **An edge out of the capture is placed, not taken at a line inside the card** (`rectify.js`
  `outOfCapture`). An edge found is inside the card when the two edges across it run on past it to
  the capture's edge (a card's edge has table beyond it; a side only when both its top and bottom
  were found inside the capture and the box is too narrow for its height, since a single line
  across the whole capture, a table's edge or a bar of light taken for the top, runs past both
  sides of a card wholly in it), and a bottom also when the box is too
  short for a card's shape, the top is the card's own (the sides do not run on above it), and the
  capture shows nothing of the sides below the bottom: they leave through its corners, or the
  bottom was found on or just above its last rows (half the shape's slack between sides found
  inside the capture, the whole slack when a side is on its edge, since a top at the border's inner
  line also makes the box 2 to 3 % short). The bottom is then placed from the top and the width,
  past the capture's edge, only where the capture shows no edge and the top steps sharply all along
  and closes at both corners; the crop runs past the capture, its last row repeated, and the box
  hung from the bottom found is kept beside it for the picture to choose. An edge found on the
  capture's last rows is kept where it was found but not judged (its steps cannot be measured
  there). A side is placed from the other side and the height only where that lands past the
  capture's edge; otherwise the box is left as found. `findQuad` gets the mirror of the worked-out
  top: a box with its bottom placed from its top where the capture shows no bottom and the sides
  run out of it. The scan report names the edge placed ("bottom PLACED past the capture's edge",
  or the side).
- **No card in the frame inside a card running off it** (`findCard`): a box inside a card-shaped
  outline with a corner at least 6 % of its width past the frame's edge, the ring between them a
  card's border or print, is part of that card, so no card is found and the guide's capture is
  read. At 6 % no art box is taken on the bench; at 10 % they came back; with no threshold, cards
  held low a pixel or two past the frame lost their whole-frame crop.
- **Two bench passes for the cut foot** (`lab/bench`): `slantfull` centres the card, so only its
  corners run out and its foot stays mostly in the capture; `low` holds it as tall as the capture
  7 % below the middle (its foot 5 to 9 % out) and `lowslant` the same turned 6 to 16 degrees.
  `--geometry` measures the box against the card's corners and `--frame` the whole-frame path.

Measured on a laptop, the branch's scanner against `ac3ba3e` (version 59, the same scanner as
version 56), each pair run side by side (the whole frame on `3eda742`, the guide's capture on
`794712e`, whose straightening is the same); right card first, sure, and wrong but sure, then the
time from straightening to the match (median and 90th percentile, ms):

| Pass | Guide's capture: first | Sure | Wrong, sure | ms | Whole frame: first | Sure | Wrong, sure | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `slantfull` | 31 → 31 | 14 → 14 | 0 → 0 | 1126, 1441 → 1134, 1428 | 24 → 34 | 13 → 20 | 0 → 0 | 1186, 2003 → 1155, 1755 |
| `slant` | 34 → 34 | 19 → 19 | 0 → 0 | 953, 1277 → 954, 1285 | 21 → 36 | 14 → 20 | 0 → 0 | 1213, 1604 → 1245, 1488 |
| `low` | 11 → 27 | 1 → 7 | 0 → 0 | 1243, 1810 → 1191, 1599 | 25 → 33 | 12 → 16 | 0 → 0 | 1152, 1725 → 1113, 1592 |
| `lowslant` | 19 → 34 | 6 → 12 | 0 → 0 | 993, 1469 → 846, 1295 | 16 → 33 | 7 → 21 | 0 → 0 | 1093, 1577 → 920, 1377 |
| `clean` | 37 → 37 | 26 → 26 | 0 → 0 | 867, 1410 → 849, 1364 | 39 → 39 | 32 → 32 | 0 → 0 | 830, 1390 → 780, 1490 |
| `blur` | 28 → 28 | 5 → 5 | 0 → 0 | 1013, 1312 → 1014, 1338 | 28 → 28 | 4 → 4 | 0 → 0 | 1141, 1301 → 1078, 1362 |
| `glare` | 33 → 33 | 20 → 20 | 0 → 0 | 771, 1268 → 785, 1288 | 38 → 38 | 22 → 22 | 0 → 0 | 832, 1451 → 807, 1342 |
| `tilt` | 37 → 37 | 24 → 24 | 0 → 0 | 967, 1428 → 956, 1424 | 38 → 38 | 20 → 20 | 0 → 0 | 936, 1380 → 940, 1394 |
| `jpeg` | 33 → 33 | 22 → 22 | 0 → 0 | 952, 1504 → 923, 1448 | 35 → 35 | 21 → 21 | 0 → 0 | 938, 1379 → 951, 1394 |
| `nonumber` | 26 → 26 | 6 → 6 | 0 → 0 | 951, 1234 → 947, 1233 | 29 → 29 | 8 → 8 | 0 → 0 | 891, 1199 → 991, 1298 |
| Western, 240 | 194 → 194 | 103 → 103 | 0 → 0 | 930, 1390 → 913, 1371 | 207 → 207 | 107 → 107 | 0 → 0 | 928, 1379 → 940, 1387 |
| Japanese and Korean, 240 | 167 → 167 | 79 → 79 | 1 → 1 | 991, 1376 → 997, 1377 | - | - | - | - |

On the guide's capture the box is right (within 4 % of the card) on `slantfull` 37 of 40 (34), `low`
31 (0), and `lowslant` 37 (13); in the whole frame on `slantfull` 40 (27), `slant` 40 (23), `low` 33
(25), and `lowslant` 40 (22). The normal passes (`clean`, `blur`, `glare`, `tilt`, `jpeg`,
`nonumber`) cut every capture exactly as before on both paths, card by card, and no capture lost its
right card but one: `low` `neo1-3` in the whole frame, which version 59 found in the frame by its
art box (a box 41 % off) and named right from the name alone; now that box is not taken, the guide's
capture is read, its foot is out and its box 6 % off, and the name does not read. The Western set
stays at 194 of 240 first (103 sure, none wrong), and the Japanese and Korean set at 167 of 240 (79
sure, the one wrong but sure as before).

A review then found a card wholly inside the capture, its foot on the last rows, beside a line
across the whole capture (a table's edge, or a bar of light taken for its top), cut 20 % off: that
line ran past both sides, so both were placed at the capture's edges. With a side placed only for a
box too narrow between a top and bottom found, and only where it lands past the capture (`18c699a`
against `f38ff8c`, every pass on both paths and both sets), the right card first is the same
everywhere; one more `low` card on the guide's capture is sure (7), and two boxes moved, both still
on the same side of right: `low` `me01-018` on the guide's capture (6 % off either way) and `low`
`swsh3-48` in the whole frame (1.8 to 3.6 % off).

- **Still open:** on `slantfull` the box is right on 37 of 40 but the right card first stays 31:
  the number strip is out of the capture on most of them (numbers read 19 of 40 against 28 on
  `slant`), and the name alone does not settle them. Seven held-low cards in the whole frame are
  not found in it and their guide's capture is cut 4 to 6 % short (the foot just past it, the box
  within half the slack, so not placed). The bottom `findQuad` places is chosen once on the bench
  (`low` `swsh1-111`, and that box is 7 % off), so nearly every placed bottom comes from the
  outermost edges. The captures are synthetic; Eric's own strongly slanted scans would show how
  often the cut happens in the hand.

**A new card means a new picture, automatic holder mode, and read safety (Eric, 2026-10-16,
version 40).** Eric's v38 phone log (51 entries, holder mode at 1x) showed a real card skipped as
"moved" at 20:17:21 (its picture changed a tenth of the view, 29 % of the last card's box, under the
quarter that rule allowed), leaving the scanner idle for 75 s until he pressed the shutter; text reads
waiting 3.5 to 17.2 s in their queue behind label checks; and nothing to say whether a picture ran in
the worker. Decided:

- **A card is new when its picture is** (`js/scan/drop.js` `contentCheck`, `contentAt`): what changed
  says where to look, the card there is printed (the matcher's 64-bit art and face hashes, from a 64 x
  89 thumbnail of the watched view, about 1.3 ms) and compared with the last card's print. 16 bits or
  fewer of 128 apart is the same card, 24 or more a new one. On the log's views two different cards
  one on the other were 34 to 62 apart, on the videos 24 to 62 (24: a Litleo landing square on a
  Darmanitan, two orange Fire cards), the same card settling 12 to 16. A new picture is taken even on
  the very spot of the last; a still picture whose change made no card's shape is checked where the
  last card lay, so a card of the same layout and colours landing square on it is taken too. The
  "moved" rule is gone.
- **The same card again**: after a disturbance like a drop's (two looks moving, peaking at 5 or more,
  starting 0.8 s or more after the last card was taken) the repeat bar asks "Same card as the last
  one" (Add a copy adds one to the last tile) and nothing is taken; after a smaller one (a nudge) or a
  card still settling, nothing happens. A hand passing over the pile asks too: Mistake, or no answer
  for 8 s, dismisses it.
- **Hand-held**: two jumps in a row after a capture (a hand taking the top card off a pile) re-arm auto
  capture, and so does a different print held still twice in a row, however close the two cards are
  in the coarse copy (60 of 90 different consecutive cards in Eric's logs differ by 20 or less there),
  so his pile method (scan the top card, take it off, scan the next) works. A card taken again is told
  by its picture, or by its print when the picture names either unclearly.
- **Measured** (`lab/holder/replay.mjs`, mode v40 against version 39's loop, same machine): the first
  video 36 of 37 drops taken once, 1 missed (both), none doubled or asked; the torch video 19 of 20
  (both; the one missed lands while the camera settles its zoom); with the loop held four times as
  long, the same. The log's 20 drops with views all replay as taken (18 before: two before-views were
  caught mid-fall).
- **Automatic holder mode** (Eric's option 2 of 3; `js/scan/steady.js` `createStance`): the Holder
  switch is a choice of three, remembered on the phone, Auto first. In Auto, holder mode comes on once
  the motion sensors (DeviceMotionEvent) have been still for 2 s (turning under 1.5 degrees a second,
  shake under 0.12 m/s2) with the picture still too, and goes off when the phone is picked up (turning
  past 30 degrees a second or shake past 1.5 m/s2 for 0.2 s); a card falling in moves the picture, not
  the phone. Nothing switches while a picture is taken or matched. With no sensor Auto stays
  hand-held; iOS asks permission on the first tap. The chip reads "Holder (auto)" or "Hand-held", and
  the scan log keeps each switch with its evidence. The limits are typical phone figures, not yet
  measured on Eric's phone.
- **Read safety**: a picture worker silent for 10 s while pictures wait (30 s while its index loads) is
  let go and its pictures are matched on the main thread, from the pixels kept, a spare copy of the
  bitmap held until the worker has read it, or the full capture's JPEG (`identify.js`
  `WORKER_LIMITS`); each report says where its picture ran and why. Label checks run one at a time,
  only once no text read is queued, and their OCR calls give way to a card's (`ocr.js` `createSlots`).
- **The scan log** (scanner 40) keeps skipped drops' views too (120 entries' views), each drop's print
  distance, verdict, and motion frames, the repeats, and the mode switches.

**Holder mode retries a blurred capture and never adds a repeat (Eric, 2026-11-06, version 64).**
Eric's phone log of 2026-11-06 (holder mode, Android 10, cards dropped one by one into the box;
versions 60 to 63 hold the same holder code): of 27 cards taken, 19 were clean, 4 were taken blurred
while his hand brought the next card near the lens, out of focus, over the card on top (each ended
"no card" or was fixed by hand), and 4 were the same card taken again about a second after it, with
that hand over it, so its print read new (he removed them). The cause: the detector judges stillness
on the whole view, so a slow, blurred card over a fifth of it passes, and a still look of it is
judged as a drop.

- **Eric's rule: never lose a card.** A first fix (branch `holder-settle`, built as version 62 and
  never released) held the picture before a drop until the drop settled and was sharp. Two read-only
  reviews of it found ways it lost cards: a card waiting for its focus was passed over when the next
  card landed first, and a hand over a waiting card let it go. It was abandoned. Version 64 keeps
  version 63's frame loop exactly as it is (the base moves on every still look, so every drop is
  still seen) and changes only what a drop's capture does once the loop has decided to take it.
- **A blurred capture is retried, not added** (`js/scan/view.js` `captureDrop`, `retryTick`;
  `js/scan/drop.js` `captureFocus`, `retryVerdict`). The card's focus is measured on the finer view,
  block by block, relative to the view's own contrast, so dim light reads the same (`cardFocus`: a
  printed block is soft when its mean Laplacian is under 0.55 of its mean step), on the outline the
  capture cuts first and on what changed, the worse counting. Sharp (at most 9 % of its printed
  blocks soft, and at least 35 % of it printed), it is added at once, as before. Out of focus, its
  frame is grabbed and kept, and each still look for up to `RETRY_MS` (1.5 s, Eric's fastest rhythm
  was a card every 1.5 s) judges the same spot: sharp and the card taken before it is a repeat
  (logged as `repeat`, never added; the repeat bar asks after a disturbance like a drop's, as for any
  repeat, so a real second copy is one tap away); a spot that looks as it did before the drop
  (under 3 % of its cells changed, the noise of a card lying still on his videos) is a hand that left
  nothing (logged as `blurred, nothing left`); sharp and anything else is the card, added once from
  that look. With no such look in time the kept frame is added all the same. It is marked to check
  only when its match is not sure, by the scanner's usual rule (Eric, 2026-11-06, after Trade or
  sale asked about every card: what the scanner is sure of is never marked): a soft card matched
  surely is added plainly, like a sharp one, and the scan log keeps its focus. A blurred card that
  is not sure shows `?` and counts among the cards to check like any unsure card, and its sheet
  says "Check this one: its picture was blurred."
- **Another card dropped on a waiting one is its own card** (`drop.js` `landedOn`, Eric,
  2026-11-06). A sharp look of the spot replaces the waiting capture only when it is the same card
  settling: no disturbance like a drop's moved the spot since the capture, or the look's print is
  within 23 bits of the waiting capture's (two different cards one on the other were 24 to 62 apart
  on his logs and videos). Otherwise the waiting capture is added first, as it was taken, and the
  new card is added after it as its own, or waits for its own sharper look.
- **Nothing is ever lost on the way.** While a capture waits, a drop on the same spot that still
  reads blurred is the same card looked at again (logged as `blurred, waiting`), and a sharp one is
  the card settled (added, the blurred frame dropped), unless another card landed on it (above); a
  drop anywhere else adds the waiting card first, as it is. The shutter, a zoom change, a camera restart, and closing the scanner add it too.
  Switching Add and Trade or sale and Auto's switch wait for it, as for any card being taken. A hand
  held still over the card on top for longer than 1.5 s is added that way; when it leaves, a sharp
  look of the card beneath on the same spot is a repeat of the card before it, not a new card. A
  card on the very spot of the last, told by its picture alone (`contentAt`), is never taken for
  "nothing left", since its cells barely change. When unsure whether the sharp look is the card before
  (print 17 to 23 bits off), it is added.
- **What it costs.** A clean card is added as before. A card whose own print reads soft (a basic
  Energy's smooth gradient reads 0.2 to 0.6, a card held out of focus about 1) waits 1.5 s, and is
  marked only when its match is not sure. Never losing a card can add one too many: the next card
  in a hand, taken blurred, then dropped on the spot is added twice, the blurred look first (on his
  log those blurred looks were never matched surely, so they are marked); and a card that bounces
  as it settles, with its sharp print 24 bits or more from its blurred one, would be too.
- **Measured on the log** (`lab/holder/replay-log.mjs`, each card taken put through `captureFocus` on
  the straightened picture the log kept, scaled to 200 pixels tall with the contrast of the view
  after): the 19 clean cards are all added at once (0 to 8 % of their printed blocks soft); the 8 bad
  ones (7 removed by Eric, 1 fixed by hand) are all retried (12 to 45 % soft, and the first card of
  the session, a blurred blob, 20 % printed). The log keeps one look per drop, so what the looks after
  each would have shown is not replayed.
- **Measured on the videos of 2026-10-09** (`lab/holder/replay.mjs --mode v64`, against `--mode v40`
  on version 63, the same drop labels, the zoom change in the first video marked): both videos take
  the very same cards in the same order (39 and 22), none lost, none added, none marked to check. One
  capture of the first video read soft (12 % of its blocks) and was taken from the next still look,
  250 ms later; every other one at once. The canvas cards of the browser tests are measured by
  `tests/scan-retry-browser.test.mjs`.
- **The scan log** (scanner 64) keeps each drop's focus and, for a blurred capture, how its wait
  ended (`retry`: sharp, retaken, repeat, nothing left, or kept blurred and why), how long it took,
  over how many looks, and whether a drop-like disturbance moved its spot meanwhile.

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
- **Unmatched rows are added by hand from the report** (Eric, 2026-10-03): each row of "Not
  matched" has Add by hand, which opens the hand-made card sheet (section 4) prefilled with the
  row's name, set, set code, number (before any slash), language, finish, and count. The report
  stays open for the next row.
- **The same screen re-imports the app's own CSV** (Eric, 2026-10-03), told apart by its header
  (`entry_id`, `card_id`, `catalog`); section 9 has the rules.

**Start over with this file** (Eric, 2026-10-30). A clean slate from a full rescan into monprice.
After a monprice file is matched, the report offers "Start over with this file": every live copy
is removed, except hand-made cards, which a monprice file cannot hold, and every matched row is
added as a new copy, built the way the import builds it. A key whose earlier copy was deleted is
added anyway. Each added copy takes a new random id, never one worked out from its key: two
phones that each start over add different copies of each row, and the merge folds them into one
by `import_key`. A key-based id would be the same on both phones, so an Undo on one would remove
the copies the other added and leave none. Rows not matched are not added; the report lists them
with Add by hand as before, and Start over is off, with a line saying why, when no row matched.
Two rows of one monprice ID, language, and finish (a blank finish and "Normal" read the same) each
get their own copies: the copy number in the key runs on across such rows, so the same file still
gives the same keys, in Start over and in the normal import. A copy holding a photo with no path
yet (a v47 phone took it and has not uploaded it) is left as it is, because removing it would give
the photo up; the preview says how many copies stay for that reason.
Card records (`card_info`) are never touched, so photos, notes, and the main-image pin show again
on the cards that get a copy. Each copy's own details (grade and grading, purchase price, typed
Liga price, favorite, condition, Stored in, pack opening, binder spots, hand-picked collection
membership) are not copied to the new copies: Eric chose to lose them for a clean slate. A binder
pocket that held a removed copy becomes that card's placeholder, trays drop removed copies, a list
binder's hand pick of a removed copy goes back to the default so the rule picks again, and
hand-picked collections drop removed copies. With "Fill binder placeholders automatically" on, the
new copies then fill the placeholders waiting for them, the ones just made included (section 11,
Binders, "Placeholders fill themselves"), and a wishlist item that only the file's copies fit (no
copy fitted it before) moves to Got it; Undo puts those pockets and wishes back by the same rule
as the rest (Eric, 2026-10-31; built 2026-10-31).

Nothing is written before a preview and a confirmation. The preview says "Remove N copies, add M
copies, K photos kept, P pockets become placeholders", K counting the photos on the card records a
copy shows afterwards, and "Photos and notes stay with their cards". It also says how many removed
copies have a grade, price, favorite, condition, Stored in, or pack opening, which stay with the
old copies and are not copied over; lists each card, by card and language, that has no copy after
Start over (a card missing from the file, an old fallback copy the file now matches to another
catalog, a card or language corrected by hand), with how many photos and notes its record keeps
but does not show until the card is added again; and lists rows left out because they ask for
more than 50 copies and were not ticked. It offers Export CSV first, the app's own export, which
keeps every copy's details and imports back through the same screen.

Undo, one step, brings the removed copies back and removes the added ones, and puts pockets,
trays, picks, and collection members back, each only while it still holds what Start over wrote,
so an edit another phone synced since stays. An added copy that changed since (graded, priced,
favorited; Undo compares a hash of the copy kept with the undo, leaving out its stamps) stays, with
its pockets, and Undo says how many it kept. A pocket Start over turned into a placeholder gets
its old copy back while it still holds the placeholder, or holds an added copy that Undo removes:
filled since by Fill placeholders, the automatic fill, or by hand. Any other pocket holding an
added copy that goes keeps that card's placeholder, and a tray drops it. A pocket filled since with
a copy Start over did not add (a later import's) keeps that copy, and the old copy comes back in no
pocket. An added copy that another phone's copy was folded into stays. Each Start over marks
the document with its run (`start_over: {id, at}`, synced, the newest run winning the merge). An
Undo from an older run, kept on a phone where the account started over again since, here or on
another phone, is refused with a message and dropped, since it would bring the old copies back
beside the new ones. So is an Undo whose added copies the merge folded into another run's copies
(two phones started over offline, then synced). Each copy Start over removes carries `removed_by:
{at, run}`, its own removal stamp and the run's id, which older phones keep through their merges
as they keep `left_via`; Log a past sale leaves those copies out (section 11, Trades and Sales).
The mark stands only while the copy is still removed at that stamp, since an older phone's Undo
brings a copy back keeping the field. Undo, when it runs, marks the copies it removes the same way
(with its own id), drops the mark from the copies that come back, and marks the document with
itself (`start_over: {id, at, undoes: <run id>}`), so the run is no longer the latest on any
phone: a kept Undo of it elsewhere is refused ("already undone"), and a move logged before the
Undo can no longer be undone (section 11). Undo is also refused, with a message naming the move
and a link to Trades and sales, while a live move logged since names a copy the run added in its
cards out or in, or a copy the run removed in its past sale list: Undo would bring the old copy
back while the move still counts the new one sold, so the card would have two live copies. The
move is undone first, then Start over; the kept Undo stays offered meanwhile. Undo is kept beside
the document (`meta:start-over-undo`), so the import screen offers "Undo Start over" after the
screen was left or the page reloaded: for 7 days, to the account that started over, until it is
used or another Start over replaces it. The change is planned on a copy of the document by one
pure function (`js/start-over.js`) for both the preview and the save, and the document on screen
takes it only once the save succeeds; a failed save changes nothing. An edit made in memory while
the save commits (a tap, a sync merge, a photo upload) is taken in again before the document on
screen takes the save's content.

Known limits. After Undo, a removed copy that another phone edited offline before the run comes
back as this phone's version, without that edit. Two phones that start over offline and undo
before syncing cannot see each other's run, so an Undo there can still leave both runs' copies.
Older phones (v51 to v54) know nothing of moves: their Start over Undo is not refused when a move
counts the run's copies, so they can still bring back two live copies of a sold card, and their
Undo does not mark the document, so a v55 phone still lets a move logged before it be undone.

## 8. Persistence and Auth

Recommended stack: **Supabase** (Postgres, auth, row-level security, file storage on one free
tier). Firebase is an equivalent alternative.

- The phone writes to its copy of the document in IndexedDB first, and merges with Supabase when
  online (section 3).
- **Small saves move little data** (E-18, 2026-10-15). Another device reads only what a save
  changed (`sync_delta`, section 4) when it saw the version just before, and hears about the save
  through a Realtime broadcast that carries only the new `updated_at`, never data, since anyone
  who knows the account's id could listen. The save itself still uploads the whole document
  unless Eric runs the optional `supabase/patch-document.sql`. One note with 1,600 copies and two
  devices open: 1,278 KB in v37, 428 KB without the function, 2 KB with it.
- Auth by magic link or Google. One account per person, invited by Eric (section 3).
- Passwords exist only for a family member without an email. Eric creates the account in the
  Supabase dashboard under a placeholder `@family.invalid` address (`.invalid` is reserved by
  RFC 2606, so no mail can ever go to it) and adds it to the group like any other. The person
  signs in with the account name and a password, and changes the password in Profile. A
  forgotten password cannot be reset by email: Eric sets a new one with
  `supabase/reset-password.sql`, which also ends the account's sessions, so a phone that knew
  the old password does not stay signed in. *(Decided by Eric, 2026-10-01.)*
- Row-level security from the start: a person writes only their own `documents` row and storage
  files, and reads their own plus those of anyone sharing a group with them.
- Server storage holds only owned-card images and uploads (section 3); the full catalog's images
  stay on each phone.
- **No price history.** Prices are fetched on demand and the 1/7/30 day averages give the trend,
  so nothing has to run nightly. The value-over-time chart is dropped; it is a portfolio, which
  Eric does not want.

**Purging old tombstones: designed, not built** (2026-10-15, item 10 of `plans/roadmap.md`). A
deleted entry stays in the document as a tombstone, with every field it had, so the document only
grows. Dropping a tombstone is safe only if no device can still hold the entry alive and push it
back, and the server cannot list the devices: a phone left in a drawer is not known to anyone. What
makes a purge possible anyway, and what still stands in the way:

- **What already helps.** Every app since v26 stops before merging when the server's document
  carries a newer `merge_version` ("Update the app to keep syncing", `js/sync.js` checkRules), and
  `supabase/min-client.sql`, which Eric has run, refuses writes from anything older. So an app that
  purges and writes `merge_version` 3 stops every older app at once, with no new SQL. Every device
  also keeps, after each successful sync, the stamps of every entry the server held (`base` in
  `js/sync.js`, saved in IndexedDB, and left alone when a write fails). An entry this device saw
  on the server that is now gone from it can only have been purged, since nothing else removes
  entries; an entry not in `base` is this device's own, never pushed.
- **The rule, for an app at `merge_version` 3.** When writing, drop top-level tombstones whose
  `deleted_at` is more than 180 days (N at least 90, with margin) before the server's own clock
  (the row's `updated_at`, never the phone's, so a phone whose clock runs ahead cannot purge young
  tombstones). On a full read, drop each local entry that is in `base` but missing from the
  server, unless its `restored_at` is later than the version `base` recorded (a restore made here
  after the last sync wins, as the sticky rule says today). A removal cannot be told in a delta
  (`syncDelta` returns null when the server holds an entry the document lacks), so the write goes
  whole and the other devices read the whole row.
- **Never purged.** Card tombstones: they are how a rerun of the monprice import skips a card the
  owner removed (`planImport`, by `import_key`, whose id an import on another phone makes again),
  and how re-importing the app's own CSV keeps a removed copy removed unless the owner asks to
  bring it back (`planOwnImport`, by id). So the purge covers wishlist entries, lists, goals,
  collections, and binders only, and not those with `merged_into`, which redirect what pointed at
  the entry (`plans/sync-merge-plan.md`, risks).
  Tombstones inside an entry (photos, binder pockets, collection removals): they are small, and
  the photo ones guard the bucket deletes. Each of these could at most be cut to a stub (`id`,
  `import_key`, `deleted_at`, `updated_at`, `merged_into`): still a tombstone to every app, so it
  can never bring an entry back, only shrink it.
- **The 14-day bucket grace** stays far inside N: the phone that deletes a binder queues its
  cover's bucket delete, which goes once the server holds the delete and 14 days have passed
  (`bucketDeleteState`), so by 180 days the file is gone. Were a purge first, the queued delete
  would wait for a version the server no longer holds: a file left behind, never an entry back.
- **Why it is not built.** Writing `merge_version` 3 is a cut-over: every family phone shows
  "Update the app to keep syncing" until it is reloaded, as with `min-client.sql`, so the release
  needs Eric's go-ahead and a moment when he can reload the phones. The proof needs a browser test
  with two app versions at once (a v38 phone that stays offline past the window, then syncs before
  and after reloading, against a v39 phone that purged), plus the restore-against-purge race under
  the compare-and-set retry; neither the fakes nor the suites run two versions today. And the gain
  is small: card tombstones, the bulk of them, must stay, the rest are a few deleted lists and
  wishes, and since v38 a save no longer uploads the whole document. Stubbing card tombstones
  older than N is the larger and safer saving; whether it needs a cut-over depends on how the
  key-by-key merge treats a field one version lacks, to be checked first. Revisit when the document
  nears the free tier's limits or a cut-over is planned anyway.

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

**Re-importing the app's own CSV** (Eric, 2026-10-03). Import accepts the export beside monprice
files and shows a report before saving: new on this phone, already here with changes, already
here and the same, and deleted on this phone.

- A row is the copy with its `entry_id`. Absent, it is added with that id and its `created_at`;
  present and alike, nothing is written; present and different, only the differing fields change,
  stamped as an edit (section 4, `field_stamps`). A row whose id is unknown but whose
  `import_key` a live copy holds is that copy, and a copy the merge folded away (`merged_into`)
  is matched to the copy holding it, so no re-import makes two of one copy.
- A copy deleted on this phone stays deleted unless the person ticks "Bring back", which restores
  it the way Undo does (`restored_at`), so the merge keeps it over the tombstone.
- The export gained the columns a re-import needs, after the old ones so older files still read:
  `condition`, `notes`, `name_local`, `set_name_local`, `finish_raw`, `fallback`, `import_key`,
  `number_local`, `set_code`. An older export leaves those fields alone. A hand-made card's row
  carries its name, set, number, and set code. Not in the CSV: photos, the pinned image, binder
  pockets, and fields the app does not edit yet (purchase price, grading; storage joined the CSV on
  2026-10-09, section 4); a re-import
  leaves them as they are on the phone, and sync brings them back to a wiped phone that signs in.
- Tested as a round trip: export, a wiped phone, import, the same copies; the same file again
  adds nothing.

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
gets a **Ver na Liga** button that opens Liga's own search for that card in the browser.
*(Decided 2026-10-01.)* Until 2026-10-09 a copy could also carry a Liga price typed in by hand;
see "Automatic prices lead" below.

**Liga's query pattern** (checked by hand in a browser, 2026-10-01): Liga's search is
`https://www.ligapokemon.com.br/?view=cards/search&card=<text>`, and it only lands on one card
when the text is exactly the English card name followed by the number and official set total as
printed, in parentheses. `Rattata (019/165)` opens the 151 Rattata (Liga edition code `MEW`), and
`Charizard (4/102)` opens Base Set Charizard ("Coleção Básica"). Build it from TCGdex: the English
`name`, the card's `localId` as given (zero-padded on modern sets, not on vintage), and the
set's `cardCount.official`, padded to the width of a zero-padded number (`Dachsbun (039/091)`,
not `/91`; checked 2026-10-05). When several editions share that text, Liga shows an edition picker
on the card page. Korean and Japanese prints have no reliable Liga equivalent and get no button
until checked.

When the exact query misses, a search for the name alone (`Dachsbun`) lists every print with its
number written the way Liga wants it, so it is the fallback for finding the right form by hand
(checked 2026-10-05). The app still only builds the link and never fetches Liga.

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
alone, and keep the number as TCGdex's `localId` (`20`, `019`, `4` all matched; the numbering
exceptions below are the only places it is padded). The unchecked rows are verified on first real
use.

**Numbering exceptions** (checked 2026-10-01, the last four on 2026-10-05):

- Lettered subsets carry the letters on both sides: Crown Zenith `GG44` with an official count of
  70 is `Mewtwo-VSTAR (GG44/GG70)`; `(GG44/70)` finds nothing. The same applies to `TG`.
- Promos take the promo number alone: `Charizard-V (SWSH050)` opens the card (Liga itself lists it
  as `SWSH050/71`, a total TCGdex does not have), and so do XY promos (`Celebi (XY111)`,
  `Kyogre-EX (XY41)`). A set is a promo set when its TCGdex ID ends in `p` or its name contains
  "Promo".
- Scarlet & Violet promos (TCGdex `svp`) are the exception: the number, padded to three digits,
  over an infinity sign, `Dondozo (012/∞)` (`%E2%88%9E` in the URL).
- Generations' Radiant Collection (TCGdex `g1`, `RC1` to `RC32`) uses the main set's total with no
  letters: `Swirlix (RC19/83)`, `Flareon-EX (RC28/83)`, not `RC19/RC32`. The lettered-subset rule
  does not extend to `RC`.
- McDonald's Collection 2023 (TCGdex `2023sv`) pads both sides to three digits: `Cetitan (005/015)`,
  though TCGdex gives `5` and `15`. Other McDonald's years are unchecked and keep the general rule.
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

**Automatic prices lead; Liga is a link** (Eric, 2026-10-09). The owner does not keep Liga prices
by hand, so the app no longer takes them. Prices come from the automatic providers only:
TCGplayer's US market price and Cardmarket's EU trend price from TCGdex, each converted to reais
with the app's saved daily rates. Ver na Liga stays, unchanged, as the way to see the real
Brazilian price; the app never fetches Liga. This replaces the 2026-10-01 "Brazil first" layout,
in which a Liga lowest NM and average typed in by hand led card detail.

- **Card detail's Price panel** is a short list, not a form and not a box: TCGplayer and
  Cardmarket, each in reais marked approximate ("≈ R$ 23,40"), with the original amount, its kind,
  and its date small under it ("US$ 4,12, TCGplayer market, 8 Oct"), Cardmarket's rising, falling,
  or steady trend as an arrow and a word beside its price, and one short line for the exchange
  rates. Original amounts keep the app's Brazilian number format, so every amount on the panel
  reads the same way.
- **Liga prices kept from before.** Stored `price_manual` data is never deleted by the app. A copy
  that holds one shows a single read-only line under the market prices ("Liga, 1 Oct 2026: lowest
  NM R$ 12,00 · average R$ 15,00 (Holo, Portuguese)"), the same line its "Your copies" row shows,
  with a small Remove that a toast's Undo reverses. Tiles and totals still take a kept Liga price
  before the US estimate, as they did; the statistics bar shows its Liga count and the
  average or lowest NM switch only when some copy holds one.
- **A finish TCGdex does not list** (a monprice "Holo" on a card listed only as Normal) shows the
  price of a finish that exists, the plain Normal or the first listed, and a reverse holo only
  when that is all there is, and says so: "for Normal; your copy is Holo". A listed finish chosen
  on the panel that has no price of its own does the same ("for Holo, Unlimited; none listed for
  Holo, Shadowless"). "No price" appears only when the card has none for any finish. Tiles and
  the Value sheet take the same fallback for a copy whose finish is not listed (the tile's label
  names the finish, the statistics count such copies in a note), but not for a listed finish
  without a price of its own, whose value stays unknown: Base Set Charizard's Shadowless is not
  worth its Unlimited's price. Japanese, Korean, and Chinese prints never borrow a price (see
  "The language gap").

Any list (a binder, a checklist, a set, a collection, the Trade spares, or every card) gets
statistics: total, average, highest and lowest with their cards, and how many values are US
estimates or unknown (and Liga prices, when kept). Each card counts its kept Liga average when
present and the US estimate otherwise, marked as estimated, and an unknown never counts as zero.
Totals never use Cardmarket. The statistics bar sits on binders, checklists, sets, and the Trade
spares; for the whole collection it is on demand, never a headline total on the home screen, which
keeps the "no portfolio" decision. *(Cardmarket restored as a comparison by Eric, 2026-10-01.)*

**Background prices and the Value sheet** (Eric, 2026-10-02). A tile's US estimate comes from the
full TCGdex record card detail saves, so tiles used to show a price only for cards whose page had
been opened. Now, after My Cards first draws, a background pass reads the full record of every
owned international card the phone lacks, two requests at a time, the cards on screen first, and
saves it under card detail's own key; a record older than a week is read again the same way.
TCGdex's GraphQL carries no pricing (checked 2026-10-02), so this is the REST card endpoint, one
request per card. Japanese, Korean, and Chinese prints have no market price and are never asked
for; their tiles, and cards TCGdex has no price for, show a quiet "No price", while a card whose
price is still downloading shows nothing. The Stats toggle and panel on My Cards gave way to a
small **Value** button that opens a bottom sheet led by coverage: "Priced: N of M copies", how many
are Asian prints with no market price, how many still wait for a price, how many TCGdex has no
price for, then the statistics bar under "Of the priced copies", and a link that filters My Cards
to the copies without a price. The sheet takes any list of copies, so the Trade view can open it.

**A binder shows what it is worth** (Eric, 2026-11-06: "you should also show how much the binder
is worth based on the cards in it"; the boxed Value button "does not look pretty"). The total is a
line under the binder's name and size, in the theme's link color with a chevron, that opens the
Value sheet: "R$ 1.245 in value", "~R$ 4.952 in value" when part of it is a US estimate, or
"R$ 50,00 in value, partly priced" when some copies have no price, the Collections list's words;
plain "Value" in the same style when none has one, so the sheet is still reachable, and no line for
a binder with no copies. It stays a real button (a dialog opener, the focus ring, 48 px tall), and
the line is there from the first draw, so the total arriving moves nothing. It is the sheet's own
sum over the same copies (prices.js listStats and valueLabel), in whole reais from R$ 100. It is
read after the pages draw, again when a pocket or a copy's Liga price changes, when the sheet closes
(it may have read a new rate), and on coming back to the app; a later read wins. The binder screen
asks for no prices or rates itself. Sets and checklists keep their small Value button.

Three ways to handle it, and they can coexist:

1. Show the market price, clearly labeled with the market it comes from.
2. Prefer Cardmarket where it covers the language.
3. Manual entry with a source note (dropped 2026-10-09: Ver na Liga links to the Brazilian price
   instead).

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
Eeveelution"). Each entry is ticked automatically once an owned card's `dex_ids` includes that
number, in one of the list's languages (below). A person can also tick one by hand (a card bought but not logged yet);
hand ticks show a different mark from owned ones and never count as owned anywhere else. A
**Missing only** filter works offline, so a store visit shows just the gaps ("#107 Hitmonchan").
A checklist can lay out a binder in Dex order with placeholders for the missing ones, which suits
a "Generations 1 and 2" binder.

**Every card of a Pokémon** (Eric, 2026-10-01: "let me see how many cards for Jigglypuff are out
there and which ones I already have"). In a custom or region checklist, tapping a Pokémon opens
all of its cards, for example "Jigglypuff, 9 of 48 cards": every print across sets, newest first,
including cards it shares with others (TAG TEAM cards list several `dexId` values), with owned
cards flagged (ribbon and language flags) and missing ones dimmed with one tap to the wishlist,
the shared All, Owned, and Missing filter, and a "count every finish" switch for a master
collection. Each list has its own **languages** setting (default Portuguese only; English, Japanese,
Korean, Chinese, French, and the others can be added). It decides both which prints
appear and what counts as owned, in the list's ticks and on this screen alike: a card counts only
when owned in one of the list's languages, so a Portuguese-only list ticks a card only for a
Portuguese copy. **Any language** removes the setting, and so does ticking every language: such a
list counts a copy in any language, German, Spanish, Italian, and copies with no language
recorded included. Lists made before the setting decided ticks have none, so they keep counting
any language until someone picks languages for them; a new list starts with Portuguese.
*(Ticks follow the languages: Eric's open decision, settled 2026-10-15 as the roadmap proposed.)*
**A list's languages decide everything it counts** (Eric, 2026-11-05; built 2026-11-05): its
ticks, counts, progress ring, and Value, the every-card-of-a-Pokémon screen reached from it, and
a binder made from it (`js/checklists.js` `listByDex`, `js/binder-sources.js`). A list without a
`languages` field keeps counting any language, so nothing changes until languages are set, and
**Any language** on the list's languages Edit removes the field again. A Pokémon owned only in
languages the list does not count stays missing, and its row shows the flags of the languages it
is owned in under the mark ("Owned only in English"; `ownedElsewhere`), so it is clear why it is
not ticked. A family member's lists are read with that member's languages, view only. Older
phones keep counting any language: the rule changes no data beyond the existing field. International prints come from the
bulk `id` and `dexId` list the checklists already cache (23,736 cards in one request), so they
work offline; Japanese and Korean prints load from their own catalogs, one request per set, only
when the list includes those languages, and are kept for offline use. TCG Pocket is left out. Every
thumbnail carries language flags in its top-left corner: the languages the person owns it in (a
Portuguese copy shows Brazil, both show Brazil and the United States), and none on a missing card.
*(Languages per list by Eric, 2026-10-01.)*
*(Planned 2026-10-01, a block after the shell.)*

A set or artist goal counts ownership in any language unless it names languages, the same rule
as the set tile rings. Prismatic Evolutions shows
why the levels matter: 131 official cards, 180 in total, and TCGdex counts 268 reverse-holo variants
including the ball patterns.

Each goal shows a progress ring and a **missing list**. The missing list is sortable like any
other view, can be opened offline in a card shop, and sends any card to the wishlist in one tap.
A missing Pokémon is not a card, so the Every Pokémon goal sends that Pokémon's cheapest card by
default, and a long press picks another.

**Set and artist goals** (Eric, 2026-10-03), `js/goals.js` and `js/goals-view.js`. A goal is an
entry in `goals` beside the checklists, saved and merged the same way (field by field): `{kind:
'set', catalog, target: <set id>, level: numbered | secrets | master}` or `{kind: 'artist', target:
<illustrator>}`, with the checklists' **languages** setting (any language by default; one that
names languages counts only copies in them). Goals are made from **New goal** in the Lists tab's
Goals section (a set from the catalog's set list with its level, or an illustrator, suggested from
the owned cards' records), from the set page's **Make this a goal** (which becomes "Your goal:
Master set" once one exists), and from card detail's illustrator line, **All cards by this
artist**, which shows the cards first and keeps them as a goal only on **Keep as a goal**. One
goal per set (per catalog) or illustrator; a set goal's level changes on its own screen.

- **Counting.** Numbered counts the cards numbered 1 to `cardCount.official` (a set numbered
  another way, "SV001", takes its first official cards in number order); with secrets, every card
  in the set; both count a card once, owned in any finish. Master counts each card in each finish
  from TCGdex `variants_detailed` (standard size only, so jumbo prints are left out; normal, holo,
  reverse, Poké Ball and Master Ball patterns, subtypes, and stamps), else from the `variants`
  flags; a card with neither counts once, and the screen says how many. A copy's finish is read
  from its `variant_id` when the card's record is on the phone, else from its finish code, else it
  counts as the plain print. An artist goal counts each print once.
- **Where the cards come from.** A set goal reads the set record the Sets tab keeps, plus one
  GraphQL request for the set's cards with rarity and finishes (GraphQL's `variants_detailed` has
  no `variantId`, checked 2026-10-03, so a finish is told by type, subtype, foil, and stamps). An
  artist goal asks GraphQL for the illustrator (its filter matches any part of the name in any
  case, so the exact name is kept, accents and spacing aside) in the international catalog, plus a
  Japanese, Korean, or Chinese catalog only when the goal's languages name it; TCG Pocket is left
  out and cards are dated with the set index the Pokémon cards screen keeps. Each answer is kept on
  the phone, so the goal and its Missing list open offline once seen.
- **The screen.** The ring and "N of M" (finishes on a master set, cards otherwise), All, Owned,
  and Missing with counts, the shared search and sort bar (set order or name; rarity, and set for
  an artist), the shared tiles with missing cards dimmed and one tap to the wishlist. On a master
  set a part-owned card shows under Owned and Missing, and its wish carries a note naming the
  missing finishes ("Missing: Reverse holo, Master Ball pattern"), since GraphQL gives no variant ID
  to wish for. A family member's goal is read only (`family/<id>/goals/<id>`).

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
page alone when the count is even (a 40-page binder ends with page 40 alone). Swiping or the edge arrows turn the page with a CSS 3D flip
around the spine (the page lifts, a shadow sweeps across, it lands on the other side), with a
crossfade under reduced motion. Depth comes from a soft shadow where pages curve into a
stitched spine, a slight sheen on the pockets, and the cover color showing at the edges.

**No rings, ever** (Eric, 2026-10-01). Collectors avoid ring binders because rings dent the cards
nearest them. The binders TCG collectors use are ringless, with pages bonded or stitched into the
spine, side-loading pockets (the card slides in from the outer side), a zip closure, and padded or
hard covers; the most recommended are Vault X's Exo-Tec zip binders and Ultra PRO's Eclipse PRO
binders (checked 2026-10-01). So the drawing shows a stitched spine with bonded pages, a zipper
around the cover edge, and a thin side-loading slit on each pocket's outer edge. Creating a binder
offers quick picks for the common sizes, which fill in the grid and page count: 4-pocket (2 x 2),
9-pocket (3 x 3, 20 double-sided pages, 360 cards), and 12-pocket (3 x 4, 480 cards).

**Cover image.** A binder's cover is its cover color or an image: a photo of the real binder or any
picture, cropped to the cover's shape and stored like card photos. On
a phone in portrait the spread is an overview and tapping a page zooms into it for placing cards;
in landscape, on tablets, and on laptops the spread is large enough to edit directly. In portrait
the binder shows a gentle, dismissible hint, "Turn your phone sideways to see both pages", a few
times and then never again; rotating switches to the full spread at once, and the app never forces
landscape, so a phone with rotation locked keeps the overview. *(Eric, 2026-10-01.)* Spreads are
also where Michi art can cross facing pages, which settles that open question. *(Planned
2026-10-01, a block after the shell.)*

A binder view answers both questions a collector asks: which pages a card is in, and which owned
cards are not in any binder yet.

**Resizing a binder** (Eric, 2026-10-02). When a binder's grid changes:

- **Growing** (rows and columns both at least the old ones): every card keeps its row and column
  on its page; the new columns and rows appear empty on the right and at the bottom; the pages
  are unchanged.
- **Shrinking or reshaping:** if every placed pocket still fits at its own row and column, the
  positions are kept and the empty edge is cut. Otherwise the whole binder is laid out again in
  reading order (page by page, row by row): pockets with nothing in them close up, while
  placeholders and pockets left empty on purpose keep their place in the sequence and move with
  the cards. Pages are added when needed so nothing falls out, and the editor says so ("This
  binder grows from 12 to 27 pages"), unless the person asked for fewer pages.
- **Fewer pages** can still push cards out, with the warning; those cards land in the binder's
  tray instead of leaving it, and placeholders and empty-on-purpose pockets on the cut pages go.
- **Michi art** is cleared on any change of shape.
- Each binder carries a numeric **`layout`**, one more on every change of shape (and when it is
  emptied into the tray); a binder without it counts as 0. The merge uses it so pockets saved for
  two different grids never mix: the higher layout keeps its whole set (section 3).
- Before saving, the editor shows the first page after the change and what happens to the
  pockets, in the app's own sheet, with **"Empty into the tray and arrange by hand"** as the other
  way: every card goes to the tray in reading order, and placeholders and empty-on-purpose pockets
  are removed.

The 40-page default for new binders and every preset stays (decided).

**The tray** (Eric, 2026-10-02). Each binder has a tray (`staged`, a list of entry ids) of cards
meant for it but not in a pocket yet: cards a resize pushed out, a binder emptied to arrange by
hand, or a card taken out of a pocket with "To the tray". A copy is in at most one tray, and never
in a tray and a pocket at once. The tray is a strip of small thumbnails (about 56 px wide, the
cached card image) docked at the bottom of the binder screen above the tab bar, scrolling
sideways; held sideways it is a column beside the spread, so the spread still fits above the tab
bar. Tap a thumbnail to pick it (it lights up), tap a pocket to place it, and the next tray card is
picked; a card placed on another card swaps with it. Where the spread is directly editable
(sideways, tablets, laptops, a zoomed page) cards can also be dragged onto pockets. **Fill the rest
in order** places the remaining cards in the pockets with nothing in them, in reading order. A copy
deleted from the collection leaves the tray. **Add cards to the tray** (2026-10-10, the audit's
follow-up) fills it in bulk: a sheet lists the copies in no pocket and in no binder's tray, with a
search and a set filter; tap tiles or Select all, then add them all, in name order, with Undo on
the toast. A copy waiting in another binder's tray is not offered, so the picker never takes a
card from the binder it was meant for. A binder made from a list has no tray and no button.

**A card out of its pocket** (Eric, 2026-11-06: "when I'm looking at a card in my binder, I should be
able to see the preview as in a modal if I click the card. Right now a dialog appears at the bottom
with some information. I would like to see the full card too, as if I was taking it out of the slot
and looking at it in real life."; built 2026-11-06), `js/pocket-viewer.js`. A tap on a pocket
holding a card you own lifts the card out: it slides toward the pocket's open side (right on a
right-hand page, left on a left-hand one), then grows to the middle of the screen over the dimmed
binder, and the pocket shows empty while it is out. The image is the copy's main image as its tile
shows it (the person's photo when it is the main image, else the official image in its large size),
and it zooms like the inspection viewer, whose zoom pane it reuses (`zoomPane` in
`js/photos/viewer.js`): pinch, double tap, Ctrl and the wheel, and + and -. Under the card (beside
it held sideways) are its name, its language and pocket, and what the pocket's sheet offers there:

- your own hand-made binder: **Details** (the pocket sheet as before), **To the tray** (only the
  copy shown: when a sync has put another card in the pocket meanwhile, nothing moves and a line
  says so, as in the sheet), **Move**
  (the sheet opened on Move to pocket; not on a one-pocket binder), and **Card page**;
- a binder from a list: Details (its copies sheet) and Card page;
- a family member's binder, read only: Card page alone (the pocket was a link to it before).

A tap outside the card, a swipe down at zoom 1, Escape, Back, or Close put the card back: it
shrinks to the pocket's side and slides in. An action closes it at once and opens its own sheet.
With reduced motion it appears and goes without moving. It is a sheet (`js/sheet.js`): Back closes
it without leaving the binder, Tab stays inside, focus goes to its first action and back to the
pocket after. Taps that place a card are unchanged: with a tray card picked or a card in hand, a
tap on a filled pocket still places or swaps, and never opens it; empty pockets, placeholders, Gone
pockets, and art keep their sheet. In portrait the overview still opens the page first.

**Placeholders fill themselves** (Eric, 2026-10-31; built 2026-10-31), `js/placeholder-fill.js` and
`js/fill-view.js`. A placeholder is a card he wants in that pocket, so whenever he has or adds a
copy of that card, the copy goes there. The need came from Start over: every pocket that held a
removed copy became that card's placeholder, and the new copies sat in no binder, hundreds of
pockets to refill one by one.

- **Which copy goes where.** A copy fits a placeholder of the same card (card id, and catalog when
  the placeholder names one). Only live copies in no pocket of a hand-made binder and in no tray
  are offered; a copy already in a pocket or a tray never moves, and a copy a binder from a list
  shows still counts as in no pocket, since that binder is a view. Placeholders that name a finish
  and a language choose first, then those naming a finish, then a language, then the rest, each
  taking the best copy that fits what it names; a placeholder whose finish or language no copy
  has takes another copy of the card. One copy per pocket, in binder, page, and pocket order.
  **The best copy is the most valuable** (Eric, 2026-11-06; it was the oldest): a Liga price
  typed on it, else TCGplayer in reais at the saved rate, else the rarest (TCGdex's rarity words,
  ranked), else the newest added, a tie to the lowest id: the order a binder from a list picks its
  copy by (`js/binder-rules.js` `copyOrder`, with `js/binder-sources.js` `rankerFor`), read only
  when some hand-made binder holds a placeholder. Only which copy fills a placeholder changed: the
  order between placeholders, the passes above, and copies already in a pocket or a tray are as
  before. Prices and rates are the ones saved on the phone, so two phones agree when they hold the
  same ones. Start over (`planAfterAdding` on its draft) and the trades log plan inside one save
  with no prices at hand, so there the oldest copy still fills, as it does when the prices cannot
  be read.
  Placeholders made by Start over carry the removed copy's language, so the copy that fills them
  again is the most alike. Those v51's Start over made carry none, and an import's copies share
  their created_at, so for a placeholder that names no language the language is the removed
  copy's (`pocketLanguages`): the copy the kept Start over undo (`meta:start-over-undo`, 7 days)
  names for that pocket, whose tombstone is still in the document; without it, the copies of that
  card deleted at the moment the pocket was written (Start over stamps both with the same time),
  when they share one language. Binders keep no history of what a pocket held, so nothing else
  tells. When no language is found and copies in several languages fit, the pocket prefers the
  language most of its binder's cards have (its copies and the placeholders whose language is
  known; none on a tie), and the preview says how many pockets were filled that way. Binders have no language of their own yet.
- **Fill placeholders, now.** A button on each hand-made binder with placeholders, and one on the
  Binders list for every binder. It shows a preview first ("212 cards go into 4 binders; 18
  placeholders have no copy yet.", and "3 pockets have no language saved, so the language of their
  copies is a guess" when that applies), then fills, with Undo on the toast. Undo puts a placeholder
  back only in a pocket that still holds the copy the fill put there, so a card moved or a pocket
  changed on another phone since stays as it is.
- **From now on, by itself.** Every path that adds copies calls one helper with the copies it
  added (`afterAdding`, or `addCopies`, which adds and calls it): the monprice import, a file shared
  to the app (the same Save), the app's own CSV restore, Add a copy on the card page and the
  copy steppers, hand-made cards, and the scanner's save, which passes its own Place it there
  pockets. Start over runs the same step on its draft (`planAfterAdding`), so the pockets it turns
  into placeholders take the new copies at once, and its preview says how many ("12 placeholders
  get a new copy right away."). A trades log calls the same helper. The toast says what happened
  ("3 cards went into binders."); its Undo, or the path's own Undo, takes the pockets back with the
  same rule as above. **Add cards to the tray** puts a picked card the binder has a placeholder for
  into that pocket and the rest in the tray.
- **The setting.** Profile, Binders: "Fill binder placeholders automatically", on by default,
  saved in the document's `settings` as `fill_placeholders` (false when turned off), so it follows
  the person. Off, nothing fills by itself; the Fill placeholders button still works.
- **Fast on big binders.** Pockets are written in one pass per binder (`js/binders.js`
  `fillPlaceholders`, `restorePlaceholders`): one copy and one stamp of each binder however many
  pockets change, so thousands of pockets fill at once.
- **Not counted as placeholders:** a pocket whose copy was deleted (shown as "Gone") holds an
  entry id, not a placeholder, so it does not fill.
- **A Pokémon's placeholder** (laid out from a list, below) takes any copy of a card showing that
  Pokémon, in one of the list's languages when the list named some, the most valuable first (the
  oldest without prices, as above), the binder's most common language first. Card placeholders choose first, in every binder, so a copy goes to
  its own card's placeholder before a Pokémon's that would take it too. Which Pokémon a card shows comes from the Pokédex numbers the
  checklists read (`js/checklists.js` `resolveOwned`), read only when some binder holds such a
  placeholder (`dexOfCopies`). Start over and the trades log fill in one save with no such read, so
  their copies fill a Pokémon's placeholder at the next Fill placeholders or copy added.

**Lay out from a list** (Eric, 2026-11-06: "if I put the Johto list and select a binder for it, it
should imagine I'm adding the Pokémon from Johto in order"; built 2026-11-06), `js/binder-layout.js`.
His region binders are hand-made (Empty binder, filled by hand from the tray), so a binder from a
list does not fit them. **Lay out from a list** on a hand-made binder picks a checklist (a region or
his own Pokémon list, the same lists New binder > From a list offers) and gives the binder's empty
pockets placeholders for the list's Pokémon in Pokédex order:

- **Where.** From the first empty pocket after the last pocket in use (a card, a Gone card, a
  placeholder, art, or one left empty on purpose), because his binders fill in order and a gap
  before the last card is likely his own; the sheet also offers "Every empty pocket from page 1".
  A pocket holding anything never changes, so a pocket left empty on purpose stays empty.
- **Which.** One placeholder per Pokémon on the list the binder does not have yet: a Pokémon is in
  it when a copy in one of its pockets shows it (in any language), or a placeholder stands for it
  (a Pokémon's, or a card's whose record names it).
- **Too many.** The preview says how many do not fit and offers to add the pages that make room at
  the end, up to the 200 a binder can have, and says what still does not fit.
- **Cards he owns.** With "Fill binder placeholders automatically" on, the copies in no pocket and in
  no tray go into their placeholders in the same save (`fillPlan` and `fillPlaceholders`, as Fill
  placeholders does), in the list's languages, the most valuable copy first (`readList` reads
  their prices and rarities; Eric, 2026-11-06); copies added later fill the rest through the same
  automatic fill. A copy in a tray stays there.
- **Preview, save, Undo.** The sheet says what happens before anything is saved ("152 placeholders
  on pages 3 to 19, 23 filled with cards you own.", where it starts, how many are skipped). Lay out
  is one save; Undo on the toast takes out each placeholder and each copy it put in, only where the
  pocket still holds it (a placeholder only with the time the layout gave it, so the same Pokémon
  laid out again later stays). The pages it added stay, empty, and the toast says to remove them in
  Edit binder (decided 2026-11-06 after a review): one phone cannot tell that another has placed a
  card on them that has not synced yet, and its smaller page count would win the merge and drop
  that card (`undoLayOut`).
- **The representation** (decided 2026-11-06). A placeholder was a card (`want: {card_id,
  catalog, variant_id, name, image}`); binders from a list keep Pokémon pockets in their
  `snapshot`, which a hand-made binder does not have. The smallest form older phones keep is the
  same `want` with no card: `{card_id: null, catalog: null, variant_id: null, image: null, name,
  dex}`, plus `languages` (`["en", "pt"]`) when the list names some. Every app since v26 merges a
  binder pocket by pocket and edits a clone of the entry, so a phone on v47 to v61 keeps the slot
  whole when it merges or saves the binder (tested with the frozen v47 merge,
  `tests/binder-layout.test.mjs`). It shows it as a placeholder with the Pokémon's name on the card
  back ("Want"), since `image` is null; its fill and its scanner's "Goes in" match placeholders
  by card id, so they never pick it, and a card it places in that pocket replaces it as for any
  placeholder. The one rough edge: its Open card on that pocket opens a card page for
  no card. A new field on the slot instead (`pokemon`) would have read as an empty pocket there, so
  an older phone would have filled it by Fill the rest in order or a tap without a word.

**Binders from a list** (Eric, 2026-10-05; built 2026-10-09), `js/binder-rules.js`,
`js/binder-sources.js`, and `js/binder-rule-view.js`. New binder offers Empty binder or **From a
list**: the cards (a checklist, a collection, a set or artist goal, or a filter by region, set,
type, and language), an order (Pokédex number, set and number with the oldest set first, name, or
release date with the newest set first; a checklist offers Pokédex number and name), and a pocket
size (the quick picks or any grid). The form counts the pockets and pages as the choice changes,
and the pages follow the pockets, up to the 200 a binder can have. An unnamed binder takes the
list's name. `binders/new/<checklist|collection|goal>/<id>` opens the same form with the list
chosen, for a "Make a binder" button on those screens.

- **A pocket is a Pokémon or a card, not a copy.** A checklist gives one pocket per Pokédex
  entry, and a copy fits when its card's Pokédex numbers include it, in one of the list's
  languages (any language for a list that names none), as the checklist screen ticks it
  (Eric, 2026-11-05; built 2026-11-05, `js/binder-sources.js` `checklistItems`). A collection or a filter gives one pocket per owned card (catalog and
  card id), and a goal one pocket per card of the set or artist, owned or not; their copies are the
  ones the collection holds, the filter matches (a language filter keeps only that language's
  copies), or the goal counts.
- **The copy shown.** The default is the most valuable copy (a Liga price typed on it, else
  TCGplayer in reais at the saved rate), else the rarest (TCGdex's rarity words, ranked), else the
  newest added; a tie goes to the lowest id, so every phone picks the same one. A count shows when
  more copies fit. Tapping the pocket opens every copy that fits, as pictures, with the default
  marked; the one tapped is a **hand pick** (a dot on the pocket), which sticks until "Show the
  default again". A pick follows its Pokémon or card, not its page, so it survives a change of
  order or size.
- **Not owned yet:** the faded placeholder look of hand-made binders, with Want. A card offers
  Add to wishlist; a Pokémon links to its cards on the checklist, to choose the card to wish for.
- **Refresh.** Opening the binder reads its list again and saves only what changed: pockets for
  cards that joined the list, in their order, pockets gone for cards that left it, owned cards
  filled in, pockets emptied, and defaults moved to the best copy now; hand picks stay. A line
  says what changed ("1 pocket added (Charizard); 1 pocket filled with a card you own now
  (Pikachu)."; a pocket that had a copy and has none now, sold or owned only in a language the
  list does not count, is "1 pocket emptied: no copy you own fits it now (Pikachu)."). The Refresh
  button does the same and also asks again what a failed download put off. Opening reads only what
  the list's own screen reads and keeps (the Pokédex numbers of owned cards, a goal's card list),
  so after the first time it is cheap and works offline. When part of the list cannot be read, a
  pocket keeps a stored copy that is still owned, and when none of it can be read the pages stay as
  they were. A list deleted since leaves the pages as they were, with a line saying to choose
  another in Edit binder.
- **A list's languages and a v56 phone** (built 2026-11-05, after a review found the flip-flop). A
  v56 phone fills a checklist's binder from copies in any language, this version only from the
  list's languages, and each saves its own layout on opening, so with both in the family the
  stored layout changed back and forth on every opening. Neither loses anything (a generated
  binder places no copy, and `binder_picks` stay), but every opening was a save and a sync. So for a
  list that names languages, opening also works out the layout as a v56 phone would
  (`checklistAnyItems`), and when the stored layout is exactly that one and the binder records the
  list's current languages (`list_languages`, "en,pt", written by every save of a new layout
  here), the difference is only the languages, which the v56 phone would undo: the pages show the
  list's layout, but opening neither saves it nor says anything (`planRefresh` `languageOnly`).
  **Refresh** still saves it, and so does opening when something a v56 phone would also save
  changed (a new copy, a pocket added) or when the list's languages changed since the binder last
  recorded them. The field sits on the binder rather than in `snapshot`, because a v56 phone
  rewrites `snapshot` whole but keeps a field it does not know, as it clones the entry. The cost:
  until a save here, the binder's count on the Binders screen and a family member's view show the
  stored layout, the v56 one. Chosen over saving only on Refresh, which would leave a new copy in
  the list's languages unsaved until someone pressed it, and over filling binders from any
  language again, against Eric's decision that a list's languages decide its binder (2026-11-05).
- **Edit binder** changes the name, notes, cover, list, order, and pocket size. A change to the
  list, order, or grid shows the new first page and what changes in a sheet before it is saved,
  as a resize does; a change of grid raises `layout`.
- **A view, not a place** (decided 2026-10-09 while building it). A generated binder never places
  a copy: a copy it shows can also sit in a hand-made binder's pocket, and it stays "Not in a binder
  yet" in the Binders tab and the My Cards filter. `placements()` passes over generated binders, so
  the copy sheet's pocket line, card detail's binder line, and the scanner's "Goes in" placeholders
  are about hand-made binders only; a newly scanned card fills a generated binder's pocket at its
  next refresh instead. Spreads, page turns, notes, the cover, Edit order, delete with Undo (picks
  included), and the family read-only view work as for any binder; there is no tray or Michi art.
  A family member's generated binder shows its last layout and picks, read only.
- **Data.** The binder entry keeps its `slots` empty and adds `rule` (`{source: {kind, id} or
  {kind: 'filter', filter}, order}`) and `snapshot` (`{at, rule_key, keys, shown}`: the pockets in
  order as Pokémon keys `dex:25` or card keys `international|sv01-001`, and each pocket's default
  copy), so every phone and the family view show the same pages, and for a checklist that names
  languages `list_languages` (above); `rows`, `cols`, `preset`, and
  `page_count` are the grid and pages as for any binder. Both new fields merge per field like
  `name`, so a rule changed on one phone and a refresh saved on another both stay (the next
  refresh lays out the new rule). Hand picks are a top-level list, `binder_picks`, one entry per
  pocket, `{id: '<binder id>|<key>', binder_id, key, entry_id, created_at, updated_at,
  deleted_at}`, with `entry_id` null for "back to the default". Every app since the first sync
  merges an unknown top-level list entry by entry and saves it back, so two phones picking copies
  for different pockets both keep theirs and the later pick of one pocket wins, with no change to
  `js/merge.js`.
- **Older apps** (v33 checked in a browser): a generated binder shows as an ordinary empty binder
  with its grid and pages, and saving it there (placing a card, rename, resize, cover, delete)
  keeps `rule` and `snapshot`, because every app edits a clone of the entry; `binder_picks` rides
  along as an unknown list. A card an older app places in one of its pockets is ignored here, which
  leaves that copy "Not in a binder".

### Themes

A theme picker in settings offers one theme per Pokémon **TCG energy type**, plus the default:
Grass, Fire, Water, Lightning, Psychic, Fighting, Darkness, Metal, Dragon, Colorless, and Fairy
(retired since Sword & Shield, kept for its era). *(Revised by Eric, 2026-10-01: TCG types, not the
18 game types; saved game-type choices map to their TCG type.)* A theme sets the accent
color, a light tint on panels, and a panel frame style inspired by the selectable text box frames
in the games' options menus. The 18 type colors come from the pokedex project's `style.css`, so
the two apps share a palette. *(Requested by Eric, 2026-10-01.)*

- Text on every theme meets WCAG AA contrast; bright types such as Electric and Fairy switch text
  to dark automatically.
- Destructive actions stay red in every theme, so danger never changes color.
- The raised Scan button is a Poké Ball that follows the theme, one ball type per theme, in the
  spirit of the different balls in the games. *(Eric, 2026-10-02; it was the app's one fixed
  brand mark before.)* The disc keeps 3:1 on the tab bar and the ring and glyph 3:1 on the disc,
  light and dark; the two black balls turn inside out in dark mode (band color as the disc, black
  ring), and the white Premier Ball's red ring carries its edge on the white light-mode bar. The
  small Poké Ball finish badge on tiles stays a red Poké Ball in every theme.

  | Theme | Ball | Disc / ring |
  | --- | --- | --- |
  | Default | Poké Ball | red / white |
  | Grass | Nest Ball | green / white |
  | Fire | Repeat Ball | orange-red / yellow |
  | Water | Dive Ball | deep blue / light blue |
  | Lightning | Quick Ball | blue / yellow |
  | Psychic | Master Ball | purple / pink |
  | Fighting | Sport Ball | brown-orange / cream |
  | Darkness | Dusk Ball | black / green (dark mode: green / black) |
  | Metal | Heavy Ball | steel blue / grey |
  | Dragon | Ultra Ball | black / yellow (dark mode: yellow / black) |
  | Colorless | Premier Ball | white / red, with a red glyph |
  | Fairy | Heal Ball | pink / white |

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

**Built first for My Cards** (Eric, 2026-10-02), as `js/filter-bar.js`, which takes plain items so
the binder card picker, the tray, and the wishlist can reuse it:

- **Search first,** over owned cards and offline: names in every language the phone has for a card
  (shown or not, readings included), the set name, the collector number ("25", "025", or "25/165"),
  and the card ID. A word starting with "#" is a National Dex number or range: "#25" or "#025"
  finds every card whose `dex_ids` include 25, and "#1-151" a range. A search starts the "Show
  more" paging again at the matching tiles. No match offers the Sets catalog.
- **Filters,** in a bottom sheet with the count of active ones on its button, each also shown as a
  clearable chip: region or generation (the checklist presets' Dex ranges, "Kanto (Gen 1)" to
  "Paldea (Gen 9)", Hisui counted as Gen 8), a Pokédex number range (from and to; either alone means
  that one number), energy type (the eleven TCG types, with the themes' colors), category
  (Pokémon, Trainer, Energy), set, language, rarity, priced or not, and not in a binder yet. A card
  with several Dex numbers (a TAG TEAM) fits a region or range when any of them does; a card with
  none (a Trainer, an Energy, or one whose details are not read yet) never fits a Dex filter.
- **Sorts:** newest or oldest added, name, Pokédex number, set and number, price (unknown last).
- The last sort and filters are remembered per screen on the device; the search text is not.
- **The binder pickers sort too** (Eric, 2026-11-06: he filled a binder by region and could only
  get the cards A to Z, and "my binders are all region-related"). The pocket's card chooser and Add
  cards to the tray offer **Pokédex** (the lowest number; the same number by the oldest set, then
  the collector number; no number, such as a Trainer or an Energy, last by name), **Set** (oldest
  set first by release date, a set with no date last, then the collector number read as a number,
  so 2 before 10), and **Name** (A to Z), each shown as "Sort: Pokédex" and so on, since a bare
  "Set" under the tray's set list read as a second set filter. The first time it is Pokédex; the last one picked is kept
  on the phone for both pickers (not synced), and the pickers' filters are not kept. "Set" here is
  the card's expansion, not a Collection. My Cards keeps its own Set, newest first, and does not
  offer the oldest-first one; its Pokédex order takes the same tie order. The chooser's copies in
  no binder yet stay before those in a pocket, each in the sort; Add cards to the tray adds them in
  the order shown.
- **Card details** for the filters (`dex_ids`, `types`, `category`, `rarity`) are added to the card
  index by one TCGdex GraphQL request per owned set, in the background after My Cards first draws,
  two sets at a time; Japanese, Korean, and Chinese sets are read in their own catalogs with the
  `@locale` directive, which returns their types and rarities in English. Each set's answer is
  kept, and asked again after a week only when an owned card was missing from it.

### Trade and Favorites

**The Trade view** (Eric, 2026-10-03), `js/trade-view.js`, route `trade` (a member's, read only:
`family/<id>/trade`). It is My Cards over the spares only, so it has the same bar (search,
set, language, rarity, price sort, Favorites), the same tiles, and the Value sheet with its coverage
line. It is reached from the Spares button beside My Cards' heading and from Profile ("Spares to
trade"). Trade stays a query (section 3), never a stored list.

- A spare is every copy beyond the first of the same card in the same language, whatever its
  finish, counted with the same function a family wishlist uses (`sparesFor`, `js/wishlist.js`).
  The copy kept is a favorite if one is marked, otherwise the one added first; the rest are the
  spares. The default of one kept copy per card and language is not a setting.
- One tile per card and language. The `×N` badge counts spares; the line under the name reads
  "2 spares" with the spares' conditions, the finish badge keeps its corner, and the price is
  the tile's usual one.
- Empty state: says what a spare is (the Portuguese and English example) and links back to My
  Cards. There is no filter bar over nothing.

**Favorites** (Eric, 2026-10-03). A star button on the card page marks the card: it sets
`is_favorite` on every one of your live copies of that card, in every language, and clears it from
all of them on the next tap. The flag stays per copy in the data (section 4), so a merge keeps
it field by field and a copy added later is not starred until the star is tapped again; a card
counts as a favorite when any copy of it is. A tile (one card and language) shows a star in its
bottom-right corner when any of its copies is a favorite. "Favorites only" is a filter in the
shared bar, remembered like the others. A family member's stars show on their tiles and card
pages, with nothing to press.

### Collections

**Collections are a third part of the Lists tab** (Eric, 2026-10-03), `js/collections.js` and
`js/collections-view.js`: Checklists, Wishlist, Collections. Routes `collections` and
`collections/<id>`; a member's, read only: `family/<id>/collections[/<id>]`. Each row shows the
name, the kind, the card count, and the value (the Value sheet's own sums, with "partly priced"
when some copies have no price). A collection's screen is My Cards over the cards it holds, with
the shared bar and the Value sheet, as Trade is. Owning is still the base set: a collection is a
tag, so it never changes a total, and a card can be in any number of them. A collection's count
and value sum over its own copies, once each (section 3: never over memberships).

- **Two kinds, fixed when made.** Hand-picked holds the copies you add; Fills itself holds every
  live copy that fits a rule. Rename, change a rule, or delete from Edit; delete is a soft delete
  with Undo on a toast.
- **A rule is the filter bar's own fields** (rarity, set, language, type, region, Pokédex range,
  favorites), each field holding one or more values, any one of which matches, and every field
  named has to match. A rule must name at least one. Rarity matches TCGdex's English values. The
  Star preset fills rarity with Illustration rare and Special illustration rare. A rule reads
  rarity, types, and Pokédex numbers from the card details; the screen reads any set it lacks
  before it draws, so a collection can briefly miss cards on a phone that has never opened My
  Cards offline.
- **Data.** A `collections` entry is `{id, name, kind, rule, entry_ids, removed_ids, created_at,
  updated_at, deleted_at}`. A hand-picked collection holds copies (card entry ids), not cards:
  `entry_ids` maps each id to when it was added and `removed_ids` to when it was taken out, and
  the merge decides each id on its own (the later stamp stands, a removal wins a tie). Two phones
  adding different cards both keep theirs; a removal sticks; a delete sticks; a name edited on
  one phone and cards added on another both survive. An id folded into another copy by the
  duplicate repair follows it (`merged_into`). A card's copies are all added at once from card
  detail, so a copy bought later is not in the collection until it is added.
- **Adding.** "Add to collection" sits under the copy rows on card detail: a sheet with a
  checkbox per hand-picked collection (ticked, partly ticked, or clear for the card's copies),
  a field to make one and add at once, and a line naming the self-filling collections that hold
  the card. The scanner's Done sheet has "Add all to a collection" beside Set for all: choose or
  make a hand-picked collection, and the copies the save writes join it. My Cards has no
  selection mode yet, so adding several different cards at once from there waits for one.
- **Family.** A member's collections open read only. A self-filling one of theirs is worked out
  with the card details this phone has, so it can be short until their cards are in the index.
- **Leaving cards out of a rule** (Eric, 2026-10-06; built 2026-10-09). A self-filling
  collection keeps adding new matches, but a copy can be left out by hand: untick the rule
  collection in the card's Add to collection sheet, or use Leave cards out on the collection.
  "N cards left out" opens them with Put back. Left-out copies reuse `removed_ids`, and a copy put
  back reuses `entry_ids`, merged per id as for hand-picked collections; apps older than v29
  show left-out cards but keep the maps.

### Order and Undo on Lists and Binders

**Edit order** (Eric, 2026-10-06; built 2026-10-09), `js/reorder.js`. Checklists, goals,
collections, and binders each have an Edit order button: rows with a drag handle (only the handle
drags, so the page still scrolls) and Move up / Move down for keyboard and screen readers. Each
move saves at once with Undo. The position is an optional `order` number on the entry; entries
without one follow, oldest first (collections by name), and a new entry lands last. A move writes
only the moved entry, halfway between its neighbours, so two phones moving different entries
keep both moves. Older apps keep their own sort and carry the field.

**Deletes undo instead of asking** (2026-10-09). Deleting a checklist, goal, binder, or
collection happens at once with "Deleted X." and Undo on a toast, which restores it exactly,
pockets, tray, and order included.

### Pack Openings

An opening is a batch scan session with a product attached: "10 packs of Celebração de 30 Anos,
R$300". Every copy saved in it remembers the opening, so the opening shows what it cost against
what it pulled at today's prices, and the best pull.

### Trades and Sales

(Eric, 2026-10-31; built in v55, `js/moves.js` and `js/moves-view.js`.) A log of how cards came
and went, so the collection follows what happens to the real cards. Each operation is one entry
in a new synced list, `moves`, merged entry by entry like the other lists:

```
"moves": [{ "id", "kind", "date", "who", "price", "currency", "money", "note",
            "out": [entry_id, ...], "past": [entry_id, ...], "in": [entry_id, ...],
            "undo", "created_at", "updated_at", "deleted_at" }]
```

- **kind:** sold, bought, traded, or gift (given, received, or both). A trade has both cards out and
  cards in; a sale has cards out and a price; a purchase has cards in and a price.
- **out:** copies he owns that leave, picked from his collection; the Trade view's spares come first.
  Saving soft-deletes them (as Delete does) and stamps each with `left_via: <move id>`.
- **in:** new copies that arrive, picked from the catalog with language, finish, and condition (as
  Add a copy asks), added as copies with `came_via: <move id>`. They go through the add helper's
  rule (`planAfterAdding`, js/placeholder-fill.js): they fill the binder placeholders waiting for
  them when "Fill binder placeholders automatically" is on, and move the wishes they fit to Got it.
- **price:** one amount for the whole move (sold for R$ 30, bought for R$ 20, cash added to a trade),
  optional, in BRL, USD, or EUR. Prices only: no cost per copy and no profit, by Eric's choice
  (2026-10-31). It is typed the Brazilian or the English way (js/moves.js `parsePrice`): with a
  comma, the dots group thousands and the comma is the decimal point ("1.500,00" is 1500, "30,50"
  is 30.5); without one, a dot followed by exactly three digits groups thousands ("1.500" is 1500),
  and any other dot is the decimal point ("30.5"). Anything else is refused with the expected form,
  and the form shows the amount as it will be saved ("Saved as R$ 1.500,00") as it is typed. **money** says which way it went: in for a sale, out for a purchase, and for a
  trade the form asks ("I paid it" or "I got it"); a gift has no price.
- **undo:** what Undo needs from the save (pockets turned into placeholders, trays, list picks,
  collections, fills, wishes, and a hash of each copy in), kept on the move so any phone can undo
  it later.

A card's page says where each copy came from and where earlier copies went ("Came in: traded with
Bruno, 12 Nov"; "Left: sold for R$ 30,00 to Ana, 3 Dec"), using `came_via` and `left_via`; photos and
notes stay on the card record (see "Photos and notes belong to the card") and a move never touches
them. A History screen (route `trades`) lists every move, newest first, by month, with the money in
and out each month per currency. Undo of a move (on the toast after saving, or Undo this move in
History, which is also how a move is deleted) brings the outgoing copies back without `left_via`
and removes the incoming ones that are unchanged since, the same rules as Start over's Undo (the
copy hash, pockets, trays, picks, collections, fills, and wishes; js/start-over.js `undoSwap`), and
leaves the move as a tombstone. Each move records the document's latest Start over mark when it
was logged (`after_run`, the mark's id or null; js/start-over.js `latestRun`). While the latest
mark is another one, because Start over ran later or Start over's Undo did (on any phone, whatever
its clock says), Undo of the move changes nothing and says which. A move from before `after_run`
compares the mark's stamp with when it was logged. Undo of a move is also refused, naming the
other move, while a later live move has one of its cards in among its cards out (a card traded in,
then sold): that move is undone first, or the card would come back with nothing that brought it.
Start over's Undo is refused the other way round, while a later move counts its copies (section
7). A copy that leaves keeps its binder pocket as a placeholder, as Start over does, and both
share one step for it (js/start-over.js `planSwap`).

**Edit a logged move** (Eric, 2026-11-05; built 2026-11-05). A move's sheet in History has
**Edit** for its date, who, price (with its currency, and for a trade which way the cash went: "I
paid it" or "I got it", as the log form asks), and note. The price is typed and read back as the
log form does (`parsePrice`, "Saved as R$ 1.500,00"). Edit never changes the cards: changing which
cards went out or came in is Undo this move and logging it again. `planEditMove` (js/moves.js)
changes only those six fields and stamps only the ones that changed (js/merge.js `stampEntry`),
so two phones editing different fields both keep their change, as with any other entry. The form
keeps the move it was filled from and saves only the fields changed in it (`base`), so a field
another phone changed while the form was open keeps that change rather than going back to what
the form showed. The price, its currency, and which way the money went are one unit: when any of
them changes, all three are saved as the form shows them and take the same stamp, so the merge
takes all three from the same phone, and a price cleared on one phone and changed on another never
comes out as a price with no currency or way. The form shows the price the Brazilian way
("1.500,00", `priceForInput`) without the phone's pt-BR number data, which some browsers lack. `out`,
`in`, `past`, `undo`, `after_run`, `kind`, and `created_at` stay as they were, so Undo works the
same after an edit. An undone move is a tombstone and cannot be edited, and an edit made on
another phone before it heard of the Undo does not bring the move back (the delete sticks).
History's months and money and the card page's lines follow the edit. A v55 or v56 phone shows
the edited move, with no Edit; older ones merge it entry by entry and keep it whole.

**Where:** Trades beside Spares on My Cards (on a phone the title takes its own line), "Trades and
sales" in Profile, and **Sell or trade** on a copy sheet (the copies it would change) and on a card's
page (its copy, or with several, the card's copies to pick from). Never on a family member's
screens.

**Log a past sale** (Eric, 2026-11-04). He sold and traded cards before the log existed and removed
those copies by hand. The cards out picker has a second tab, Removed lately: the copies removed in
the last 30 days, newest removal first, with the day each was removed. Picking one links it to the
move (`left_via`, and its id in `past`) without changing its deletion. Left out: copies the
duplicate repair folded into another (`merged_into`), copies a live move already names, copies a
Start over or its Undo removed (Start over added them again), and copies an undone move had added.
Undo of the move unlinks them and leaves them removed, so they are offered again. What Start over
and its Undo removed is read from `removed_by` on the copy (section 7). Removals from before that
mark existed have none, so for them the picker also leaves out the copies the kept Start over
undo on this phone names (its removed copies still removed at the stamp it records, and its added
copies once the run was undone somewhere; while the run stands, an added copy removed is a removal
by hand), and a removed copy whose
card a placeholder now waits for, removed at the moment that placeholder was written (Start over
stamps both with the run's time). Only when none of that applies, and the document's latest Start
over mark is from before `removed_by`, does the old rule remain: a copy removed within a minute
after that mark is left out. That rule alone missed an earlier run, Start over's Undo, and a copy
whose stamp was ahead, and hid a real removal right after a run.

**Scan a trade or a sale** (Eric, 2026-11-06: "Maybe I could use the scanner to register the
trades/sales too instead of registering them just manually. Maybe we could have another mode and I
could scan the cards and select a trade/sell/giveaway option so the system could make the
adjustments itself and log the transaction."; `js/scan/trade.js`, `js/scan/trade-sheets.js`).

- **Two modes.** Scan has a mode switch at the head of the tray, under the camera: one button that
  names the mode in use, **Add** (what Scan always did, the default) or **Trade or sale**, and
  switches to the other. It is never over the picture (Eric aims by the card's number strip) or
  under the repeat bar, and it takes no height from the camera, whose band over the guide holds the
  running count; the count beside it shows only when it fits whole. The choice is remembered on the
  phone (`card-tracker:scan-mode`). In Trade or sale the switch is teal, a teal frame runs round
  the camera, and Done reads **Log it**, so a card meant for a sale is never added by mistake. The
  mode does not change while a card is being taken or read, or a gallery photo opened: the switch
  says to wait, and a card is never put in the other mode's tray.
- **Its own tray, two sides.** Trade or sale keeps a tray of its own (the draft's `trade` key), so
  the Add tray waits untouched while it is used. It has two columns, **Going out** and **Coming
  in**; tapping a column's head sends the next scans there, and it starts on Going out. A card
  scanned on the wrong side moves to the other from its sheet. Reading, Review, the repeat bar,
  Copies, and holder mode are the scanner's own, unchanged.
- **A card going out is one of his copies.** It is matched to a live copy of the same card in the
  language and finish the scanner read (a copy saved with no finish, or a scan with none, fits
  any). **Loose copies first** (in no binder pocket and no binder tray), then the very finish read.
  When the loose copies it would choose between are alike (the same finish and the same condition,
  a condition not set counting as its own), it takes one by itself, a spare first (the Trade view's
  rule, `spareEntries`), then the newest added. It asks only when the choice matters: the loose
  copies differ in finish or condition, so the choice changes what leaves, or not enough loose
  copies fit and one would come out of a binder. A loose copy with no finish saved may be the finish
  read too, so it counts for the condition beside the copies in that finish (a Played holo never
  goes silently while a Near Mint copy of unknown finish was the other choice), and when the finish
  read sits only in a binder and the loose copies have no finish saved, it asks rather than take a
  copy of unknown finish (review of 2026-11-06). Then the row says "Pick which copy goes" and
  **Pick the copy** shows the copies as pictures with their language, finish, condition, where
  they are, and Spare. *(Decided by Eric, 2026-11-06, on v63: "the app is asking me about every
  card I'm scanning in the trade to select which copy goes out... didn't you say it would select
  the spare whenever available and then ask if the spare is not available?" v63 took a copy by
  itself only when exactly one was left after narrowing to spares, so two alike spares always
  asked, and it asked whenever the spare, an arbitrary one of his alike copies, sat in a binder
  while another was loose.)* A card he does not own says so on its row
  and is not logged; owned only in another language or finish, it is not logged unless he picks a
  copy. The same copy is never chosen twice: hand picks hold their copies first, then the cards are
  settled in the order scanned. A card standing for several copies takes that many. A copy he
  picked that is gone since (removed on another phone) or went to an earlier card is never swapped
  for another without a word: the card asks again ("The copy you picked is gone; pick again"), and
  Log it waits. Until his cards are read, no card going out is matched ("Checking your cards"), and
  when they cannot be read the row says "Could not read your cards; try again" and Log it waits, so
  an unread list never reads as "not in your cards" and logs a purchase without them.
- **A card coming in** is a new copy as Add would make it (`entriesToSave`: language, finish,
  condition, `language_source: scan`), its Copies as the count.
- **Log it** opens the trades log's form (`trades/new`), filled in: the copies going out, the cards
  coming in, today's date, and the kind the sides suggest (only out: Sold, with Gift named as the
  other choice; only in: Bought, or Gift; both: Traded). He adds who and the price and saves there.
  Saving, the price, the money's direction, `left_via` and `came_via`, placeholders, Undo, and
  History are the trades log's own (`applyMove`); there is no second save path. Log it waits while
  a card needs a look or is still read, and opens that card first. When cards ask for their copy,
  Log it opens **one sheet with every one of them** ("Which copies go out?"), each with its copies
  as the picker shows them, and the cards not logged (not owned, or owned only in another language
  or finish) under them with their row's line. He picks in any order; a card picked stays listed so
  its pick can be changed, and a card that starts asking because its copy went to another joins
  the list. The pick that settles the last one opens the form by itself, and the sheet's Log it
  does the same once all are picked. The row's Pick the copy still picks for one card. *(Eric,
  2026-11-06: "it doesn't show me all the cards I have to pick right away. I have to click Log it
  and another card shows up. Log it, another card shows up. Log it... it's upsetting." v63 opened
  the picker for one card per Log it.)* The form's
  line counts only the copies still in his cards, and says when one handed over is not any more. A
  kind that leaves a side out (Sold with cards coming in, Bought with cards going out) says so
  under the kinds ("The 1 card coming in is not part of a sale; it stays in the scanner's trade
  tray"): that side is not saved, and stays in the trade tray for another move.
- **Nothing changes before Save.** The collection changes only when the move is saved; then the
  sides it saved leave the trade tray. Switching to Add, or Close, with cards in the trade tray asks first ("Keep
  them" or discard). The system Back cannot be asked about, so the tray is kept for the next visit
  instead. A tray left by Log it without saving is there when Scan opens again.
- **Older phones** never see the trade tray (it is a draft on the phone, never synced); the move it
  logs is an ordinary move.
- **Scan the cards** (Eric, 2026-11-06): Trades and sales has a **Scan the cards** button beside
  Log a move, which opens Scan already in Trade or sale. It sets the remembered mode, as the
  scanner's own switch does, so the trade tray opens as it was left, cards and all, and the Add tray
  waits untouched.

**Older phones.** Every app from v21 on merges a top-level list it does not know entry by entry
(js/merge.js `mergeDocuments`), so v54 and older keep `moves` whole, and the server's
`patch_document` writes any list. A merge copies every field of a copy, and an edit changes a copy
in place, so `left_via` and `came_via` survive an older phone's save; it shows the copies as any
other. A copy an older phone changed after it came in counts as changed, so Undo keeps it.

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
