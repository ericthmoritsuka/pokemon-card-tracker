# Card Tracker

An installable web app (PWA) for a family's Pokémon cards. It keeps the cards on the phone, works
offline, and, once someone signs in, keeps them in Supabase too so a person's devices and family
stay in step. The catalog comes from [TCGdex](https://tcgdex.dev). Prices are the TCGplayer (US) and
Cardmarket (EU) figures that TCGdex carries, converted to reais with a daily exchange rate. Signing
in is optional: signed out, everything stays on the phone.

The bottom bar has five tabs: Cards, Sets, Scan, Binders, and Lists. The round avatar in the header
opens Profile.

## What It Does

### Cards

My Cards is the home tab: the cards on this phone, one tile per card and language.

- A `×N` badge shows more than one copy. A language chip shows when a copy's language differs from
  the viewing language.
- **Search** finds cards by name in any language, set, collector number, or Pokédex number, and
  forgives a typo when nothing matches as typed.
- **Sort and Filters** cover region or generation, Pokédex range, type, category, set, language,
  rarity, artist, price, pictures, where a copy is stored, favorites, and cards not yet in a binder.
- **View** switches between Large, Grid, Mini, and List. The choice stays on the phone.
- **Select** ticks many tiles at once to set Stored in, Language, Finish, or Condition, add them to a
  binder, mark favorites, or remove copies, each with Undo.
- **Value** opens the collection's worth, with its change over time. **Stats** counts copies by
  language, set, rarity, type, finish, and condition. **Spares** lists the copies beyond the first of
  each card and language.
- **Trades** logs sales, purchases, trades, and gifts with the cards that left and came, who with,
  and a price. Each can be edited or undone.
- **Add by hand** records a card the catalog does not have.

A card's page shows its picture, rarity, illustrator, variants, region and generation, and prices.
From it you can:

- add, edit, or remove copies, with Undo, and set each copy's language, finish, and condition, and keep a note on the card;
- mark it a favorite, add it to the wishlist, or add it to a binder;
- take your own photos, cropped and straightened, adjust a dark one, and pick the main image;
- open its set, or every card of the same Pokémon, one language at a time;
- open the card on Liga Pokémon (**Ver na Liga**), save the picture, or share it as a picture.

### Sets

A catalog browser over the TCGdex API, in seven languages: Portuguese, English, Japanese, Korean,
Simplified Chinese, Traditional Chinese, and French.

- Pick a viewing language and an order (newest first, oldest first, or name A to Z), and browse sets
  by series.
- The search box finds sets, and also cards: by name, number, or set code and number, such as
  `MEW 025`.
- Each set tile shows `owned / total` with a ring. A set's page dims the cards you do not own, has All, Owned, and Missing
  views, and has a **Make this a goal** button. Both count only your copies in the viewing language,
  or, with **Owned: Any language**, a copy in any language. A set or card opened once opens again with no signal.

### Scan

The camera reads cards and puts them in a tray, card after card, with no tap between them.

- It finds the card in the camera view, matches the picture against the cards it knows, and reads
  the collector number and name only when the picture cannot settle it. A card it is not sure of is
  marked for a look. Review walks through those cards.
- **For** chooses what the cards are for: Add, Buy, or Trade or sale. Buy and Trade or sale end in
  the trades form, with nothing saved until you save it.
- A phone in a stand takes each card as it is dropped (Holder mode). Automatic mode switches between
  Holder and Hand-held.
- **Photo** reads one card from a picture, and **Page** reads a whole binder page, or two pages side
  by side, from one photo.
- A note says when you already own a card, or when a family member wants it. A binder pocket waiting
  for the card can take it. Scanner settings cover a default finish, a shutter sound, and a gold rim
  for cards worth more than an amount you choose.
- Save writes the whole session at once, with Undo session. A draft left in the tray stays on the
  phone.

### Binders

Binders open as a two-page spread with a page slider.

- Make a binder by hand, with a preset size (4-pocket, 9-pocket zip, 12-pocket) or your own grid,
  notes, a cover color, and a cover picture. Cards go in from a tray, by dragging, or from the card's
  page, and tapping a filled pocket lifts the card out.
- A pocket can hold a placeholder for a card you do not own yet. **Fill placeholders** puts your
  cards into them, and cards you add fill them by themselves unless you turn that off in Profile.
- **From a list** makes a binder from a checklist, a collection, or a goal, one pocket per card or
  Pokémon, and **Refresh** brings it up to date. **Lay out from a list** fills the empty pockets of
  a hand-made binder.
- A binder shows its worth. **Print placeholders** makes paper cards for the empty pockets, and
  **Share page** makes a picture of the open page.
- **Not in a binder** lists the cards that have no pocket.

### Lists

Three parts, switched at the top: Checklists, Wishlist, and Collections.

- **Checklists** are Pokémon lists by region, Kanto to Paldea, or your own. They tick themselves
  from your cards in the languages you choose. **Goals** sit beside them: every card of one set
  (numbered, with secrets, or master set), every card by one artist, or every card of one Pokémon.
- **Wishlist** holds the cards you want, each with an optional language and finish, a priority, and a
  note. A card moves to Got it when you add it.
- **Collections** group your cards, picked by hand or filled by a rule on rarity, set, language, type,
  region, or favorites.

### Profile and Family

- Sign in with an email link, with Google when the project has it turned on, or with an account name
  and a password (Setup, step 5). Profile shows the account, the display name, and the family group,
  and the owner adds members there.
- A **Mine** switcher in the header opens a family member's cards, binders, lists, and wishlist read
  only, and you can add one of their cards to your own wishlist.
- Profile also holds the theme (twelve, one for each energy type and a default), a favorite Pokémon,
  **Import from monprice** (CSV or JSON, with a match report before anything is saved), **Export
  CSV**, Trades and sales, Phone check, and a list of what changed in each version.

### Offline and Sync

- Every edit is saved on the phone first. A strip reads `Offline` with the number of changes
  waiting, and they go up when the connection returns.
- A service worker keeps the app and the card pictures it has seen, so the app opens with no signal.
- Two devices that edit at once are merged entry by entry, so neither loses its changes.
- A new version waits for **Reload**, so a screen never mixes old and new code.

## Setup

The app talks to one Supabase project (`https://ehdkbxrjxsypegbtrxbw.supabase.co`). Its URL and
publishable key are in `js/auth.js`; both are public by design, because row-level security on the
server decides what each person can read and write. Do these steps once, in this order, in the
[Supabase dashboard](https://supabase.com/dashboard). Steps 3 and 4 belong together: until new
sign-ups are off, anyone who finds the app can make an account, and the first account to sign in
after step 1 becomes the family owner.

1. **Run the script.** Open **SQL Editor**, then **New query**, paste all of `supabase/setup.sql`,
   and click **Run**. It is safe to run again later.

1. **Set the addresses.** Open **Authentication**, then **URL Configuration**. Set **Site URL** to
   `https://ericthmoritsuka.github.io/pokemon-card-tracker/` and add the same address under
   **Redirect URLs**. To sign in from a local copy too, also add
   `http://localhost:8000/pokemon-card-tracker/`. Supabase sends a sign-in link only back to an
   address on this list.

1. **Sign in as the owner, right away.** Open the live app, tap **Sign in**, enter your email, tap
   **Send link**, and open the link on the same phone, in the same browser. The first sign-in
   becomes the owner of the family group (it is named Family) and uploads the cards already on the
   phone. Open **Profile** and check that you are listed as **Owner**.

1. **Turn off new sign-ups.** Open **Authentication**, then **Sign In / Providers**, and turn off
   **Allow new users to sign up**. Then open **Authentication**, then **Users**, and check that the
   only account is yours. If anyone else signed in first, delete their account there, then run
   `delete from public.groups;` in the SQL Editor and sign in again: the group is made again with
   you as its owner.

1. **Invite each family member.** In **Authentication**, then **Users**, invite them by email.
   Supabase emails them an invitation link that signs them in to the app. Then, in the app, open
   **Profile** and enter their email under **Add member**. Add member works only for an email
   Supabase already knows, so invite first. A person who was invited but not added can sign in but
   sees no family. Later they can sign in from the app's **Sign in** screen with their email.

   For a family member without an email, choose **Add user**, then **Create new user**, with a
   placeholder address such as `member.a@family.invalid`, a starting password, and **Auto Confirm
   User** on. Add that address under **Add member** in the app. They sign in with **Sign in with a
   name and password**, typing only the name (`member.a`), and should change the password in
   **Profile**. To set a new one when they forget it, run `supabase/reset-password.sql` in the SQL
   Editor; no reset email can reach an `.invalid` address. It also signs that account out on every
   phone.

Supabase's built-in email sends only a few emails an hour on the free plan, and every sign-in link,
resend, and invitation counts. The app keeps people signed in, so a phone needs a link only once.

The free plan pauses a project after 7 days without requests (`DESIGN.md` section 8). While it is
paused, the header shows **Not synced** and edits wait on the phone; restore the project from the
dashboard and they are saved on the next sync.

### Optional: Google Sign-In

The **Continue with Google** button shows only when Google is turned on in the project: the app
reads the project's public auth settings (`/auth/v1/settings`, `external.google`) and hides the
button when that is off or cannot be read. The email link stays the default.

1. In the [Google Cloud console](https://console.cloud.google.com/), open **APIs & Services**, set
   up the **OAuth consent screen** (External, app name Card Tracker), then open **Credentials**,
   **Create credentials**, **OAuth client ID**, and choose **Web application**.

1. Under **Authorized redirect URIs**, add
   `https://ehdkbxrjxsypegbtrxbw.supabase.co/auth/v1/callback`. Save, then copy the client ID and
   the client secret.

1. In Supabase, open **Authentication**, then **Sign In / Providers**, turn on **Google**, and paste
   the client ID and secret. The secret goes only into the dashboard, never into this repo.

1. While the consent screen's publishing status is **Testing**, Google lets only listed test users
   sign in: add each family member's Google address under **Test users**.

New sign-ups stay off, so Google signs in only people who already have an account: the owner and
invited members, by the same email address. In a tab that is already open, the button can take
up to ten minutes to appear, because the tab keeps the settings answer that long.

### Save Image Relay

**Save image** on a card's page saves the catalog picture as a file named after the card. TCGdex
sends a doubled `Access-Control-Allow-Origin` header on most of its pictures, which stops the app
from reading them, so the app asks a small Edge Function, `tcgdex-image`, to fetch the picture for
it. Without the function, those pictures open in a new tab instead. It fetches only TCGdex card
pictures, and only for a signed-in person, and fits the free plan.

1. In the Supabase dashboard, open **Edge Functions**, deploy a new function from the editor, name
   it `tcgdex-image`, replace the sample code with all of `supabase/functions/tcgdex-image/index.ts`,
   and deploy it.

1. In the function's settings, turn off JWT verification and save. The function checks the
   person's sign-in itself, with Supabase Auth: the gateway's check does not accept the project's
   publishable key.

To check it, open a card in the live app while signed in and tap **Save image**: the PNG
downloads with no new tab. Changing the function later means pasting the file again and deploying.

### Optional: Selling Spares on HOTARU

The **Shop** screen (from **Spares**) is where the family's owner prices spares for the HOTARU
catalog (`plans/hotaru-catalog-plan.md`). Pricing works without any setup; publishing needs the
catalog's table, functions, and picture bucket, which `supabase/store.sql` creates.

1. In the Supabase dashboard, open **SQL Editor**, **New query**, paste all of
   `supabase/store.sql`, and click **Run**. It needs `setup.sql` first, and running it again is
   safe.

1. The picture copy uses the **Save Image Relay** above, so deploy `tcgdex-image` too. Without it,
   cards are published with no picture.

Only the owner of the family group publishes; no email address is written into the script. To
check it, open **Shop** while signed in and give a card a price: the line under the totals reads
`On HOTARU: 1 card, …`, and **Table Editor**, `store_listings`, holds one row per spare.

## Accounts and Sync

- **One document per person.** The phone keeps the person's document in IndexedDB as before, and
  `js/sync.js` keeps it merged with that person's row in the `documents` table. The merge is entry
  by entry (`js/merge.js`): the newer `updated_at` wins, a tombstone wins a tie, and a deleted card
  stays deleted as a tombstone.
- **Two devices at once.** The server sets `documents.updated_at` on every write. A save updates the
  row only where `updated_at` still equals the value the phone read; if another device wrote in
  between, nothing matches, so the phone reads again, merges again, and retries. Neither device's
  entries are lost.
- **Offline first.** Every edit is saved on the phone at once and pushed a few seconds later, so a
  burst of edits goes up as one write. Offline, the header reads `Offline, N changes waiting`, and
  the changes go up when the connection returns. The sync also runs when the app is opened or
  brought back to the front. When the row has not changed since the last sync, only its
  `updated_at` is read, not the whole document.
- **Size.** The whole document goes up on each save. A collection of 1,600 imported cards is about
  425 KB. Each save also stores what it changed (`sync_delta`), so a device that saw the version
  just before reads only that, about 1 KB for one edit, instead of the row. Running the optional
  `supabase/patch-document.sql` (SQL Editor, after `setup.sql`) makes the save itself send only
  that too; without it, the app sends the whole document as before. After each save the
  device announces the row's new `updated_at` on a Realtime broadcast channel, so the account's
  other open devices sync within seconds; no SQL is needed for that.
- **The first sign-in** on a phone makes the cards already there the account's cards and uploads
  them. If someone else then signs in on the same phone, the first person's cards are set aside on
  the phone (never merged into the second account) and come back when they sign in again. Signing
  out keeps the cards on the phone.
- **Sign-in** uses Supabase's PKCE flow, so the trip back from an email link or Google carries
  `?code=` in the query rather than a `#` fragment, and the app removes it from the address with
  `history.replaceState`. A dashboard invitation link is the exception: it returns with the session
  in the fragment, which the app reads and removes the same way. A sign-in link has to be opened in
  the browser it was asked for from, because that browser holds the PKCE verifier.
- **The family.** Everyone in the group can read everyone's documents and profiles; each person can
  write only their own. Group membership changes only through the `add_member` and
  `remove_member` functions, which only the owner can call (`supabase/setup.sql`).
- **The Supabase client** is `vendor/supabase-js.js`: `@supabase/supabase-js` 2.117.2 from npm,
  bundled into one ES module with esbuild because the npm package ships no single-file browser
  build. The file's header lists every bundled package, its npm integrity hash, and the build
  command. It loads only once someone signs in or opens Sign in.

## Your Cards on the Phone

- `js/collection.js` keeps one JSON document per person in IndexedDB, shaped like `DESIGN.md`
  section 4. Every card entry has an `id`, `updated_at`, and `deleted_at` (a soft delete), so a
  later sync can merge entry by entry. Each entry also records its `catalog` (`international`,
  `ja`, `ko`, `zh-cn`, `zh-tw`), because the Japanese and Korean catalogs reuse the same card IDs.
- **Import matching** (`js/monprice.js`). A monprice set code is matched to a TCGdex set through
  the set's printed abbreviation (`abbreviation.official`, which the set list can be filtered on),
  checked against the release date. When no set carries the abbreviation, the set name and then
  the release date are tried. Cards then match by collector number (`001/191` is `001`; `4`
  matches `004`). When the row's language lists no such card, the English record is used for
  international prints and the Japanese record for Korean prints, and the copy is marked as a
  fallback. Each finish is matched to a variant ID from the card's `variants_detailed`; the card
  records are read four at a time and kept, so a second run sends almost no requests.
- **Rerun safety:** each imported copy carries an import key (monprice ID, language, finish, and
  copy number). Importing the same file again updates those entries instead of adding them, and
  never brings back a copy that was deleted. Prices and rarity are not imported.
- **CSV export** writes one row per copy with its entry ID, as UTF-8 with a BOM and semicolons like
  monprice. The collector number is written as `="001"` so a spreadsheet keeps it as text.

## Catalog Notes

- Catalog JSON is kept in IndexedDB (`js/catalog.js`): a saved copy shows at once and is refreshed
  in the background at most once an hour.
- Card images are cached by the service worker, cache first. Most English images come back as real
  CORS responses, capped at 3,000. Many Portuguese and French images, and some logos, send
  `Access-Control-Allow-Origin` twice, which fails CORS, so those are fetched without CORS and kept
  as opaque responses. Chrome counts each opaque entry as several MB of quota, so that cache is
  capped at 100. Both caches drop their oldest entries first.
- A missing or failed image shows a card-back tile with the name, number, and set. Offline it reads
  "Image not on this phone".
- Portuguese and French sets that TCGdex lists with no cards (such as `pt` `base1`) show the
  English list with a note. The Korean list ends with a note pointing to the Japanese sets, because
  Korean stops at the SV5 era (`DESIGN.md` section 5).

## Weekend Zero: Phone Check

The phone check is a small test whose only job is to find out, on each family phone, whether the
web platform can do what the real app needs:

- **Camera:** start the rear camera from a web page, at a resolution good enough to read a
  collector number, with torch, zoom, and focus control where the phone offers them.
- **Offline storage:** keep about 1,600 card entries in IndexedDB, read them back fast, and still
  have them after a reload with no signal.
- **Installed mode:** do both from the home screen icon, not only from a browser tab.

The answers decide whether the app stays a PWA on GitHub Pages or gets wrapped as a native app
(`DESIGN.md` section 8, and "Weekend zero" in `plans/product-plan.md` section 5).

Live URL: <https://ericthmoritsuka.github.io/pokemon-card-tracker/>

### Testing on a Phone

Each tester does this once on their own phone, iPhone or Android.

1. Open the live URL in the phone's main browser (Safari on iPhone, Chrome on Android).

1. Install it: on iPhone, tap Share, then Add to Home Screen. On Android, open the browser menu,
   then Install app.

1. Still in the browser tab, open Phone check and run both tests:

   - **Camera:** tap Start camera and allow access. Point it at a card, tap Capture, and turn the
     torch on and off if the button appears.
   - **Storage:** tap Write 1,600 entries.

1. Close the browser tab, open Card Tracker from the home screen icon, and run both tests again.

1. Offline check, still in the installed app: turn on airplane mode, tap Reload page on the
   Storage screen (or close the app fully and reopen it), then tap Count again. The app should
   open and the count should still be 1,600.

1. Turn airplane mode off, go to Phone check, tap Copy report, and send the report to Eric. On iPhone,
   the installed app keeps its results apart from Safari, so if the report shows a test as not
   run, copy the report from the Safari tab too.

The camera result to look for is the video resolution and whether torch and focus are
supported. The storage result to look for is that `storage.persist()` returns `true` and the count
survives the airplane-mode reload.

## Running Locally

No build step and no dependencies. The app expects to live under `/pokemon-card-tracker/`, the
same path GitHub Pages uses, so serve the folder that contains the repo, not the repo itself:

```sh
cd ..
python3 -m http.server
```

Then open <http://localhost:8000/pokemon-card-tracker/>.

`localhost` counts as a secure context, so the camera and service worker work on the computer.
A phone opening the computer's LAN address (`http://192.168.x.x:8000`) does not get a secure
context, so the camera test fails there. Test phones against the live URL.

`python3 -m http.server` does not serve `404.html` for unknown paths, so reloading
`/pokemon-card-tracker/cards` locally gives a plain 404 until the service worker has installed.
On GitHub Pages, `404.html` sends the visitor back into the app at the same path.
`node tests/pages-server.mjs` serves the same folder the way GitHub Pages does, `404.html`
included.

## Tests

None of the tests reach the real Supabase project, make an account, or send an email.

- `node --test tests/merge.test.mjs`: the merge rules.
- `PLAYWRIGHT=<path to node_modules/playwright> node --test tests/app.test.mjs`: headless Chromium
  at 360 × 740 against `tests/pages-server.mjs`. Every Supabase request is answered by
  `tests/fake-supabase.mjs`, which applies the same row rules as `supabase/setup.sql`. It covers
  signed-out use, Sign in, the `?code=` return, an invitation link, Google, the first upload of
  1,600 cards, two devices saving at once, offline changes, Profile as owner and as member, the
  read-only family view, the existing views, and the service worker. The catalog views replay
  recorded TCGdex answers from `tests/tcgdex-fixtures.json` (`tests/tcgdex-replay.mjs`).
- `PLAYWRIGHT=<path to node_modules/playwright> node --test tests/account-password.test.mjs`: the
  same setup, for the name-and-password sign-in, one message for a wrong name or password, the
  account name shown instead of its placeholder address, and Change password in Profile.
- `bash tests/setup-sql-check.sh`: runs `supabase/setup.sql` twice in a throwaway Postgres
  container (Docker or Podman), with a small stand-in for Supabase's `auth` schema, and checks its
  row-level security and functions as three made-up users.

## How It Is Built

Plain HTML, CSS, and ES modules. No framework and no npm.

| File | Purpose |
| --- | --- |
| `index.html` | The app shell. |
| `app.js` | Router: `cards`, `import`, `sets`, `sets/<lang>/<setId>`, `cards/<lang>/<cardId>`, `check`, `camera`, `storage`, `signin`, `profile`, `family/<userId>`; the header's account button and sync status. |
| `js/catalog.js` | TCGdex requests, languages, the IndexedDB cache, and the index of owned cards' names and images. |
| `js/catalog-views.js` | Sets, set detail, and card detail views. |
| `js/collection.js` | The per-person document: add, update, soft delete, list, import, merge in, and which account it belongs to. |
| `js/merge.js` | Merging two versions of a document entry by entry. No DOM, so Node tests it. |
| `js/auth.js` | Supabase Auth: the client, email link, Google, and name-and-password sign-in, the `?code=` return, password change, sign-out. |
| `js/sync.js` | Sync with the `documents` row, the header status, and the family calls. |
| `js/account-views.js` | Sign in and Profile. |
| `js/monprice.js` | monprice CSV and JSON parsing, and matching rows to TCGdex records. |
| `js/import-view.js` | The import screen and its match report. |
| `js/cards-view.js` | My Cards, the CSV export, and a family member's cards, read only. |
| `js/phone-check.js` | Phone check: device report, Camera test, and Storage test. |
| `js/set-check.js` | Phone check's A set on this phone: one set's copies, card records, Sets ring, and saved set lists as the phone holds them, with Copy. |
| `js/dom.js` | Shared DOM, navigation, and error helpers. |
| `vendor/supabase-js.js` | The Supabase client, 2.117.2, bundled into one file. |
| `supabase/setup.sql` | Tables, row-level security, and functions; run once in the SQL Editor. |
| `supabase/reset-password.sql` | Sets a new password for an account-name account and ends its sessions, pasted into the SQL Editor when needed. |
| `tests/` | The tests above, the GitHub Pages stand-in server, and the fake Supabase. |
| `style.css` | Mobile-first styles. |
| `manifest.webmanifest` | Install metadata: name, icons, standalone display, and scope. |
| `sw.js` | Service worker: caches the shell so the app opens offline, and caches card images. |
| `404.html` | Sends an unknown path on GitHub Pages back into the app. |
| `icons/` | App icons, plus the 180 px `apple-touch-icon.png` iOS uses instead of manifest icons. |

Routing uses real paths through the History API (`/pokemon-card-tracker/sets/en/base1`), never `#`
hashes, because iOS drops the camera permission whenever the hash changes. GitHub Pages has no
fallback for app paths, so `404.html` redirects to `/pokemon-card-tracker/?p=sets%2Fen%2Fbase1`, and
`app.js` puts the original path back with `history.replaceState` before the first render.

**Shipping a change:** bump `VERSION` in `sw.js`. Phones keep serving the cached shell until the
service worker file changes; when it does, the new cache replaces the old one and the app shows
a Reload button.
