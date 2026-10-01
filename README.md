# Card Tracker

An installable web app (PWA) for the family's Pokémon cards. So far it has two parts:

- **Sets:** a catalog browser over the [TCGdex](https://tcgdex.dev) API. Pick a viewing language
  (`Viewing: English ▾`), browse sets by series or search by name or code, open a set's cards, and
  open one card for its image, rarity, illustrator, and variants. A set or card opened once opens
  again with no signal, images included. No ownership or prices yet.
- **Phone check:** the weekend zero tests below, kept so a new phone can still be checked.

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
`/pokemon-card-tracker/sets` locally gives a plain 404 until the service worker has installed.
On GitHub Pages, `404.html` sends the visitor back into the app at the same path.

## How It Is Built

Plain HTML, CSS, and ES modules. No framework and no npm.

| File | Purpose |
| --- | --- |
| `index.html` | The app shell. |
| `app.js` | Router: `sets`, `sets/<lang>/<setId>`, `cards/<lang>/<cardId>`, `check`, `camera`, `storage`. |
| `js/catalog.js` | TCGdex requests, languages, and the IndexedDB cache. |
| `js/catalog-views.js` | Sets, set detail, and card detail views. |
| `js/phone-check.js` | Phone check: device report, Camera test, and Storage test. |
| `js/dom.js` | Shared DOM and error helpers. |
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
