# Card Tracker

An installable web app (PWA) for the family's Pokémon cards. So far it has these parts:

- **My Cards** (the home tab): the cards saved on this phone, one tile per card and language, with
  a `×N` badge for more than one copy and a language chip when the copy's language differs from
  the viewing language. Sort by date added, name, or set, filter by language, and export a CSV.
- **Import from monprice** (from My Cards or the Menu): pick a monprice CSV or JSON export. Rows
  are matched to TCGdex card records and listed in a match report before anything is saved.
- **Sets:** a catalog browser over the [TCGdex](https://tcgdex.dev) API. Pick a viewing language
  (`Viewing:` English) and an order (newest first, oldest first, or name A to Z), browse sets by
  series or search by name or code, open a set's cards, and open one card for its image, rarity,
  illustrator, variants, and your copies. Each set tile shows `owned / total` with a ring, and a
  set's grid dims the cards not owned. A set or card opened once opens again with no signal.
- **Phone check:** the weekend zero tests below, kept so a new phone can still be checked.
- **Sign in and sync** (from the header): an invited family member signs in with an email link
  (or Google, once it is turned on), or, without an email, with an account name and a password
  (Setup, step 5), and their cards are kept in Supabase as well as on the phone.
  **Profile** (the round avatar) shows the account, the display name, and the family group. A
  family member's cards open read only from the switcher on My Cards.

Signing in is optional. Signed out, the app works as before and keeps everything on the phone.

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
   Editor; no reset email can reach an `.invalid` address.

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
  425 KB.
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
  read-only family view, the existing views, and the service worker. The existing-views test reads
  the real TCGdex API.
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
| `js/dom.js` | Shared DOM, navigation, and error helpers. |
| `vendor/supabase-js.js` | The Supabase client, 2.117.2, bundled into one file. |
| `supabase/setup.sql` | Tables, row-level security, and functions; run once in the SQL Editor. |
| `supabase/reset-password.sql` | Sets a new password for an account-name account, pasted into the SQL Editor when needed. |
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
