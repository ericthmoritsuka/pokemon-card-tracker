# Card Tracker: Weekend Zero Spike

This is not the card tracker yet. It is a small installable web app (PWA) whose only job is to
find out, on each family phone, whether the web platform can do what the real app needs:

- **Camera:** start the rear camera from a web page, at a resolution good enough to read a
  collector number, with torch, zoom, and focus control where the phone offers them.
- **Offline storage:** keep about 1,600 card entries in IndexedDB, read them back fast, and still
  have them after a reload with no signal.
- **Installed mode:** do both from the home screen icon, not only from a browser tab.

The answers decide whether the app stays a PWA on GitHub Pages or gets wrapped as a native app
(`DESIGN.md` section 8, and "Weekend zero" in `plans/product-plan.md` section 5).

Live URL: <https://ericthmoritsuka.github.io/pokemon-card-tracker/>

## Testing on a Phone

Each tester does this once on their own phone, iPhone or Android.

1. Open the live URL in the phone's main browser (Safari on iPhone, Chrome on Android).

1. Install it: on iPhone, tap Share, then Add to Home Screen. On Android, open the browser menu,
   then Install app.

1. Still in the browser tab, run both tests:

   - **Camera:** tap Start camera and allow access. Point it at a card, tap Capture, and turn the
     torch on and off if the button appears.
   - **Storage:** tap Write 1,600 entries.

1. Close the browser tab, open Card Tracker from the home screen icon, and run both tests again.

1. Offline check, still in the installed app: turn on airplane mode, tap Reload page on the
   Storage screen (or close the app fully and reopen it), then tap Count again. The app should
   open and the count should still be 1,600.

1. Turn airplane mode off, go to Home, tap Copy report, and send the report to Eric. On iPhone,
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
`/pokemon-card-tracker/camera` locally gives a plain 404 until the service worker has installed.
On GitHub Pages, `404.html` sends the visitor back into the app at the same path.

## How It Is Built

Plain HTML, CSS, and ES modules. No framework and no npm.

| File | Purpose |
| --- | --- |
| `index.html` | The app shell. |
| `app.js` | Router and the three views: Home, Camera test, and Storage test. |
| `style.css` | Mobile-first styles. |
| `manifest.webmanifest` | Install metadata: name, icons, standalone display, and scope. |
| `sw.js` | Service worker that caches the shell so the app opens offline. |
| `404.html` | Sends an unknown path on GitHub Pages back into the app. |
| `icons/` | App icons, plus the 180 px `apple-touch-icon.png` iOS uses instead of manifest icons. |

Routing uses real paths through the History API (`/pokemon-card-tracker/camera`), never `#`
hashes, because iOS drops the camera permission whenever the hash changes. GitHub Pages has no
fallback for app paths, so `404.html` redirects to `/pokemon-card-tracker/?p=camera`, and
`app.js` puts the original path back with `history.replaceState` before the first render.

**Shipping a change:** bump `VERSION` in `sw.js`. Phones keep serving the cached shell until the
service worker file changes; when it does, the new cache replaces the old one and the app shows
a Reload button.
