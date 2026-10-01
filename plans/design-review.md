# Pokémon Card Tracker: Design Review and Spec

Review of the live site and the unpublished working tree (Lists, Ver na Liga, themes, binders, wishlist) on 2026-10-01, in headless Chromium at 360 x 740 and 412 x 915, light and dark, signed out, `*.supabase.co` blocked, with a 10-row invented monprice CSV imported. Screenshots are in `/tmp/design/`, cited by file name. Inputs: `DESIGN.md`, `plans/ux-plan.md`, `plans/product-plan.md`, monprice store screenshots, the pokedex `style.css`.

**(Assumption)** marks my inference. Everything else was seen on screen or read in the code.

## 1. Verdict

Sound foundations and sharp product thinking, but no shape yet: working pages joined by a tab bar, not a scanner-first app. The scanner, the reason to leave monprice, has no way in.

### What Works

- **Card art leads:** three-across grids, no frames, unowned dimmed and owned in full color (`live-360-light-set-en-owned.png`).
- **The language model reads right:** `Viewing: English`, `Owned in PT`, and a PT copy lighting up the English 151 view match `DESIGN.md` section 3.
- **The image fallback works:** `assets.tcgdex.net` returned 503s during this review and the Portuguese 151 view still drew named placeholders (`live-360-light-set-pt.png`).
- **Honest copy** in the import report and sign-in (`live-360-light-signin.png`).
- **The checklist row** marks with text, never color alone (`local-360-dark-list-kanto.png`).
- **Newest-first sets, All / Owned / Missing, set rings, and dark mode** (`combo-dark.png`) all exist.

### What Is Drifting From the UX Plan

| UX plan | Built | Effect |
| --- | --- | --- |
| Tabs: Cards, Sets, Scan, Binders, Goals | My Cards, Sets, Lists, Phone check | A diagnostic has a tab; Scan has none |
| Profile is a header avatar | Sign in plus a `Menu` repeating tab destinations (`live-360-light-menu-open.png`) | Two navigation systems |
| `×N` top-right above 1; chip only when the language differs | A red ribbon reading `1` on every owned card, and `PT` while viewing Portuguese (`local-412-light-set-pt.png`) | One corner, two meanings; danger red marks ownership |
| Chip row on Cards: All, Favorites, Trade, Star | Two selects and a sticky Export CSV / Import bar (`live-360-light-cards-populated.png`) | Backup tooling outranks the collection |
| Card detail: copies, price, location up top | Art fills the first screen; Liga, copies, and variants are bullets below (`local-360-light-card-en-liga.png`) | "Do I own it, what does it cost" needs a long scroll |
| Calm states | Offline, a set's notice renders in one grid column, a word per line (`small-offline-uncached-set.png`) | Looks broken when trust matters most |
| Poppins, from the pokedex | Online only; offline falls back to the system font (`small-offline-sets.png`) | The typeface changes when signal drops |

Smaller defects: the import report prints a literal `null` (`live-360-light-import-report.png`; a null child passed to `report.replaceChildren` in `js/import-view.js`); logo-less set tiles show the code twice (`live-360-light-sets.png`); Sets lists the digital **Pokémon TCG Pocket** series; selects truncate to `En...` at 360 px; Sets orders segments All, Owned, Missing but Lists All, Missing, Owned; empty rings vanish in dark mode; `Phone check` wraps in the tab bar at 412 px (`combo-412.png`); the `saved for offline use` banner pushes every screen down.

### The Three Biggest Problems

1. **Scanning, the most important feature, has no entry point.** No route, tab, or button. The only camera is the Phone check's camera test (`combo-412.png`, right); the real pipeline lives on a separate lab page. A diagnostic owns a tab, and `Sets` holds the thumb's best spot (`live-360-light-cards-empty.png`). Today the app is a catalog browser with an importer.
2. **The badge system is incoherent, and it is the core promise.** monprice's easy-to-miss `x2` is a reason to leave it. Here top-right is a dark `×2` pill in My Cards and a red ribbon reading `1` in Sets; the language chip shows even when it matches the viewing language; and red, the danger color, means "owned" (`live-360-light-set-en-owned.png`, `local-412-light-set-pt.png`). Nobody learns four corners that each screen redefines.
3. **Hierarchy is page-shaped, not task-shaped.** Each screen is a document: title, explanation, controls, content, sticky buttons. Card detail spends its first screen on art (`local-360-light-card-en-liga.png`); My Cards opens on `13 copies in 10 tiles.` and an Export button; the header spends its width on `Card Tracker`, `Sign in`, and `Menu`. In a shop, one-handed, the answer must be on the first screen.

## 2. Final Information Architecture

### Tabs

```
+--------------------------------------+
| Cards  Sets   ( SCAN )  Binders Lists|
+--------------------------------------+
```

| Position | Tab | Why here |
| --- | --- | --- |
| 1 | **Cards** (home) | Owning is the base set (`DESIGN.md` section 3), so the first screen is what you own. |
| 2 | **Sets** | The catalog: the other half of "do I have this", so it sits beside Cards. |
| 3 | **Scan** | Center and raised: both thumbs reach it without a grip change, and it is the largest target. Opens straight into the camera. |
| 4 | **Binders** | A physical place, edited at home with the binder open. |
| 5 | **Lists** | Checklists, later set goals, and the Wishlist: all answer "what do I still want" and must open offline in a shop. Keep the app's word over the plan's `Goals`. |

Three more ways into Scan, because it must be the easiest thing to reach:

- **A Scan button on every empty state** (`Scan your first card`).
- **An Android icon shortcut:** a `shortcuts` entry in `manifest.webmanifest` opening `/scan`. iOS has no equivalent **(Assumption: current iOS PWA behavior)**.
- **A draft resumes:** unsaved tray cards put a count dot on the Scan tab, which reopens that tray.

### Where Everything Else Lives

| Item | Home | Entry |
| --- | --- | --- |
| Collections, Favorites, Trade, Star, Openings | Cards | Chip row under the search field |
| Wishlist | Lists | Segment: `Checklists / Wishlist` |
| Family | Header | Owner switcher (`Mine v`) on Cards, Binders, Lists; Profile > Family |
| Profile | Header | Avatar at the top right: your favorite Pokémon's sprite, or an initial |
| Settings (theme, favorite Pokémon, appearance) | Profile | Profile > Look |
| Import from monprice, CSV and JSON export | Profile > Your data | Also the Cards empty state |
| Phone check | Profile > This phone | Also offered by the scanner when the camera fails |
| Sign in | Profile | Signed out, the avatar slot shows a person glyph that opens Profile with a Sign in panel at the top |

The `Menu` disclosure and the Phone check tab are removed.

### Family Read-Only Mode

**Enter** from the `Mine v` switcher (a sheet listing members with their favorite Pokémon sprites), from Profile > Family, or by tapping `<member> wants this` on a scan or card.

**While in it:** the header takes the member's theme color and sprite (`Ana's cards`); a sticky strip reads `View only · Done`; Cards, Sets rings, Binders, and Lists show their data; edit controls are hidden, not greyed; their cards show `You have ×2` when you own one, trade matching without building it.

**Exit** with `Done`, your own avatar, or Scan, which always saves to you and says `Back to your cards`. A cold start always opens your own Cards, so the mode never becomes a sticky setting.

## 3. Screen-by-Screen Redesign

All layouts are at 360 px: a 16 px gutter, 328 px content, a three-column card grid of about 104 px tiles with 8 px gaps. The header is 56 px plus the safe area; the tab bar is 64 px plus the safe area.

### Shared Header

```
+--------------------------------------+
| (spr) Cards   Mine v     [o3]  (Eric)|
+--------------------------------------+
```

Favorite sprite, screen name, owner switcher, a sync dot with a waiting count (hidden when idle), and the avatar. Offline adds a 28 px strip: `Offline · 3 changes waiting`. Service worker news becomes a toast.

### Cards (Home)

```
+--------------------------------------+
| (spr) Cards   Mine v           (Eric)|
|--------------------------------------|
| [Q Search my cards               ]   |
| (All 1,611)(Trade 276)(Star)(Fav)(+) |
| Viewing PT v   Newest v    [Filter]  |
|--------------------------------------|
| +--------+ +--------+ +--------+     |
| |EN    ×2| |        | |KO      |     |
| |        | |        | |        |     |
| |        | |        | |        |     |
| |REV     | |1st     | |        |     |
| +--------+ +--------+ +--------+     |
| Pikachu    Charizard  Pikachu        |
| 025 MEW    4 BS       ピカチュウ       |
|                       (Pikachu)      |
|--------------------------------------|
| Cards  Sets   ( SCAN )  Binders Lists|
+--------------------------------------+
```

- **Search first,** over owned cards; no result offers `Search the catalog`.
- **Chips are views:** counts are copies, never memberships; Trade is derived; `+` makes a collection.
- **Viewing language is shared with Sets** and decides when a chip shows (section 4). Viewing PT, only Eric's EN, KO, and JA copies carry one.
- **Filter** opens a sheet with the section 11 filters; active ones show as clearable chips.
- **Tile text:** two lines at most. A Japanese or Korean print shows the English name, then the original with its romanized reading in parentheses.
- **Removed:** the summary sentence, the Export / Import bar (to Profile), the two selects.
- **Empty state:** a card back, `No cards yet`, primary `Scan your first card`, secondary `Import from monprice`.

### Sets and Set Detail

```
+--------------------------------------+
| (spr) Sets                     (Eric)|
| [Q Search sets or cards          ]   |
| Viewing English v      Newest first v|
|--------------------------------------|
| Mega Evolution                 2 / 9 |
| +----------------+ +----------------+|
| |CRI     (o)2/122| |POR    (o)0/124| |
| |  [set logo]    | |  [set logo]    ||
| | Chaos Rising   | | Perfect Order  ||
| +----------------+ +----------------+|
```

```
+--------------------------------------+
| <  151                  ( 6 / 207 )  |
|    MEW · Scarlet & Violet · 2023     |
| Viewing Português v       Number v   |
| [ All 207 | Owned 6 | Missing 201 ]  |
|--------------------------------------|
| +------+ +------+ +------+           |
| |      | |EN  ×3| |      |           |
| | dim  | |      | | dim  |           |
| |      | |   (v)| |      |           |
| +------+ +------+ +------+           |
| 001      025       003               |
| Bulbasaur Pikachu  Venusaur ex       |
+--------------------------------------+
```

- **Set tile:** code chip top-left, ring and `owned / total` top-right (as monprice), logo, name. Without a logo, the name shows once, large.
- **Ring:** 28 px, 4 px stroke, track at 3:1 in both modes; complete fills yellow with a check.
- **TCG Pocket** sits behind `Show digital sets` **(Assumption: physical cards only)**.
- **Set header** carries the big ring. Segments read `All 207 | Owned 6 | Missing 201`, in that order everywhere, Lists included.
- **Owned flag:** a check in a yellow disc, bottom-right, plus full color. No ribbon, no red.
- **Long-press a missing card** to wishlist it, with an Undo toast.

### Card Detail

```
+--------------------------------------+
| <  151                      (♡) (...)|
|--------------------------------------|
| +-----------+  Charizard ex          |
| |PT     ×2  |  006/165 · 151 (MEW)   |
| |           |  Double Rare · Fire    |
| |   art     |  Illus. PLANETA M.     |
| |           |                        |
| |  tap to   |  Market $3.20 (EN)     |
| |  enlarge  |  [ Ver na Liga    -> ] |
| +-----------+                        |
|--------------------------------------|
| Your copies (2)            [+ Add]   |
|  PT · Holo · NM    Binder 1 p3 s5 >  |
|  PT · Holo · --   Not in a binder  > |
|--------------------------------------|
| Ana wants this (PT, any finish)      |
|--------------------------------------|
| Printings: (Normal)(Holo)(Reverse)   |
| In: Star · Kanto list: ticked        |
+--------------------------------------+
```

- **Art at about 45 percent width** beside the facts; tap for a full-screen zoomable viewer.
- **Price and Ver na Liga above the fold.** Price is always labeled by market (not built yet; this reserves its place). Ver na Liga is a secondary button with an outward arrow. Asian prints, which get no link, read `No Liga link for Japanese prints` instead of the button vanishing.
- **Copies are rows** opening an edit sheet (language, finish, condition, slot, remove). Unowned: `Not in your cards` with `Add to wishlist`.
- **Printings are chips,** owned ones checked. Header: favorite and overflow (Share, Move to binder, Remove).

### Scan: Viewfinder and Tray

```
+--------------------------------------+
|      Offline · reads still work      |
|                                      |
|   +------------------------------+   |
|   |                              |   |
|   |       ( card outline )       |   |
|   |                              |   |
|   |   Fill the frame. Hold still.|   |
|   |                              |   |
|   +------------------------------+   |
|                                      |
|  Saved Pikachu (PT)          [Undo]  |
|--------------------------------------|
| Session 7 · 1 needs a look  [Set all]|
| +----+ +----+ +----+ +----+ +----+   |
| |PT  | |KO×2| |JA  | |   ?| |PT  |   |
| |    | |    | |    | |    | |  ♥ |   |
| +----+ +----+ +----+ +----+ +----+   |
|--------------------------------------|
|        (1x)   (1.5x)   (2x)          |
| [Close] [Torch]  (( O ))  [Done 7]   |
+--------------------------------------+
```

- **Always dark** in every theme. The top shows status only; every control is in the bottom 40 percent.
- **Capture:** automatic when steady, with a 72 px shutter fallback; the outline flashes, a haptic fires where supported, and the frame shrinks into the tray.
- **Tray tiles** are 64 px, newest at the left, scrolling sideways, each with its language chip, quantity (`×2`), and status (`?`, or a heart when family wants it). Tap one to open its sheet.
- **The first scan** opens the confirm sheet; `Scan next` sends later cards straight to the tray, the whole single-versus-batch decision (`DESIGN.md` section 3).
- **Done** reads `Done 7 · 1 to check` and jumps to that card first.
- **Camera denied:** `Camera is off`, `Search by name or number`, `Run phone check`. Glare and misses show as one line in the outline: `Tilt to cut the glare`.

### Scan: Confirm Sheet

```
+--------------------------------------+
|        (camera, dimmed, live)        |
|=============== ---- =================|
| +------+  Charizard ex               |
| | your |  006/165 · 151 (MEW)        |
| |photo |  Sure match                 |
| |  vs  |  [Not this card]            |
| |catalog                             |
| +------+                             |
| Printed in        read from the card |
| (PT ✓) (EN) (JA) (KO) (More)         |
| Finish                               |
| (Normal)(Reverse)(Poké Ball)(Master) |
| Condition  (Not set v)               |
|--------------------------------------|
| You have 1 PT Holo. This adds a 2nd. |
| Ana wants this card.                 |
|--------------------------------------|
| [ Discard ]        [ Scan next ]     |
| [               Save               ] |
+--------------------------------------+
```

- **A half sheet** over the live, dimmed camera, so the next card can be lined up.
- **Language names its source:** `read from the card`, or `not sure, pick one` with nothing preselected. Never a remembered default.
- **Finish** lists only this card's printings and starts on the plain print.
- **Duplicate and wishlist lines** sit in the theme's text box frame, where the game-dialog look carries meaning.
- **Save spans the bottom row** for either thumb; Discard (the shop check) and Scan next sit above. Low confidence disables Save until a tap, and says why.
- **Not this card** shows the top three candidates beside the photo, plus `Search`.

### Scan: Done Sheet

```
+--------------------------------------+
| Save this session            [Close] |
|--------------------------------------|
| 12 cards · PT 9 · KO 2 · JA 1        |
| ! 1 needs a look            [Review] |
| 3 you already own                    |
|  (Add as extras) (Review each) (Skip)|
| Add all to   (Star) (+ Collection)   |
| Set for all  (Language)(Finish)(Cond)|
|--------------------------------------|
| [          Save 12 cards           ] |
+--------------------------------------+
```

Then `Saved 12 cards · Undo session`, held until the next save (UX plan section 9). `Set for all` previews: `Changes 9 cards. Keep the 2 you set by hand?`

### Binders

```
+--------------------------------------+
| (spr) Binders  Mine v          (Eric)|
|--------------------------------------|
| +----------------------------------+ |
| |##| Gen 1 and 2          3x3 · 20p| |
| |##| 162 placed · 18 open          | |
| |##| "Generations 1 and 2"         | |
| +----------------------------------+ |
| +----------------------------------+ |
| |##| Mega binder          3x4 · 10p| |
| |##| 40 placed · 80 open           | |
| +----------------------------------+ |
| 41 cards not in any binder        >  |
| [ + New binder ]                     |
+--------------------------------------+
```

```
+--------------------------------------+
| <  Gen 1 and 2               (...)   |
|    Page 7 of 20       < (o o o) >    |
|--------------------------------------|
| +----------+----------+----------+   |
| |  card    |  card ×1 |  Want    |   |
| |          |          |  greyed  |   |
| +----------+----------+----------+   |
| |  card    |  empty   |   ( + )  |   |
| |          |  on purp.|          |   |
| +----------+----------+----------+   |
| |  card    |  card    |  card    |   |
| +----------+----------+----------+   |
|                                      |
| Tap a pocket to place or change it   |
+--------------------------------------+
```

- **A cover color spine** (`##`, 16 px, with the border tinted to match) ties each row to the shelf. Notes are one italic line.
- **Pages swipe,** with dots and arrows. A pocket opens the picker sheet on `Not in a binder yet`.
- **Cover colors:** the 18 type colors plus black, white, and grey **(Assumption: enough for real binders)**.

### Lists: Checklists and Wishlist

```
+--------------------------------------+
| (spr) Lists   Mine v           (Eric)|
| [ Checklists | Wishlist ]            |
|--------------------------------------|
| +----------------------------------+ |
| | (o) Kanto          5 / 151   >   | |
| | (o) Every Pokémon 58 / 1025  >   | |
| +----------------------------------+ |
| [ + Add a list ]                     |
+--------------------------------------+
```

```
+--------------------------------------+
| <  Kanto                 ( 5 / 151 ) |
| [ All 151 | Owned 5 | Missing 146 ]  |
|--------------------------------------|
| (spr) #001 Bulbasaur          ( )    |
| (spr) #004 Charmander     (v) 1 card |
| (spr) #006 Charizard     (v) 3 cards |
| (spr) #007 Squirtle      (/) by hand |
|--------------------------------------|
| Tap the circle to tick by hand       |
+--------------------------------------+
```

- **56 px rows,** sprites in a fixed 40 px box (today they range from tiny to row-filling, `local-360-dark-list-kanto.png`).
- **Three marks:** owned (check, filled disc), hand tick (slash, outlined disc, `by hand`), missing (empty circle).
- **Row opens the Pokémon's cards; the mark ticks by hand.** Two 48 px targets.
- **Wishlist:** rows with a text priority and a note; a member's list shows `You have ×2` on your spares.

### Profile and Themes

```
+--------------------------------------+
| <  Profile                           |
|        (  big Pikachu sprite  )      |
|        Eric · Synced 2 min ago       |
|--------------------------------------|
| Look                                 |
| Favorite Pokémon        Pikachu   >  |
| Theme   (suggested: Electric)        |
| [Def][Fire][Watr][Gras][Elec][Ice]>  |
| Appearance  (System)(Light)(Dark)    |
|--------------------------------------|
| Family     (Ana) (Rui)     [Invite]  |
|--------------------------------------|
| Your data                            |
|  Import from monprice             >  |
|  Export CSV or JSON               >  |
|  Offline downloads                >  |
| This phone                           |
|  Phone check                      >  |
|  Sign out                            |
+--------------------------------------+
```

- **Swatches** are 64 x 48 px framed panels, chosen by sight, applied live with no Save.
- **Invite** is Eric's only. **Appearance** is new **(Assumption: wanted; today the app follows the system)**.
- Signed out, the top block is the sign-in panel and Family is hidden.

## 4. Visual System

### Type Scale (Poppins, Self-Hosted)

Serve Poppins 400, 600, and 700 as WOFF2 from the repo, precached in `sw.js`, so offline looks like online (it is SIL Open Font License, so free). Tabular figures on counts and prices.

| Role | Size / line | Weight | Use |
| --- | --- | --- | --- |
| Display | 28 / 34 | 700 | Ring counts in a set or list header |
| Title | 20 / 28 | 700 | Screen and sheet titles |
| Heading | 16 / 24 | 600 | Section headings, card name in a sheet |
| Body | 16 / 24 | 400 | Prose, rows |
| Small | 14 / 20 | 400 | Tile meta, secondary lines |
| Label | 12 / 16 | 600 | Tab labels, chips, segment labels |
| Badge | 11 / 14 | 700 | Corner badges, uppercase |

Nothing a reader must act on goes below 14 px.

### Spacing, Radius, Elevation

- **Spacing:** 4, 8, 12, 16, 24, 32, 48. Gutter 16, grid gap 8, sections 24 apart.
- **Radius:** card art at 5 percent of tile width (real card corners); badges 4; buttons, inputs, rows 12; sheet tops 20; chips and segments pills. Panels take the theme frame's radius.
- **Elevation:** 0 page; 1 panels (border only); 2 header, tab bar, offline strip (0 1px 3px, 12 percent); 3 sheets, toasts, and the raised Scan button (0 -8px 24px, 24 percent).

### Color Roles

`js/themes.js` already computes AA-safe values. This fixes which roles a theme may touch.

| Role | Themed? | Value |
| --- | --- | --- |
| `bg`, `surface`, `text`, `muted`, `border` | No | Fixed neutrals, light and dark |
| `accent`, `on-accent` | Yes | Header bar, primary buttons, active tab mark, selected chips |
| `accent-strong` | Yes | Links, focus ring, progress ring stroke |
| `panel`, `frame`, `frame-soft` | Yes | Panel tint and text box frame |
| `danger` | No | `#dc0a2d` in every theme |
| `scan` | No | The Scan button: red disc, white ring and glyph, the app's one fixed brand mark |
| `owned` | No | Yellow `#ffcb05` disc with a navy check; complete rings |
| `warn` | No | Amber fill with a `?` glyph, dark text |
| `badge-ink`, `badge-paper` | No | Quantity pill near-black with white text; language chip white with ink text and a 1 px ink border |

Frames go on panels and sheets only, never around card art or on grids. In dark mode the header is the dark surface with an accent bottom bar.

### Badge System

One component, `cardTile()`, draws every card image: grids, tray, pockets, wishlist, checklists.

| Corner | Badge | Shows when |
| --- | --- | --- |
| Top-left | Language chip `PT` | The copy's language differs from the viewing language. Always in the scan tray. |
| Top-right | Quantity `×3` | Two or more copies in that language. Never `×1`. |
| Bottom-left | Finish `REV`, Poké Ball, Master Ball with `M`, `1st` | Any finish but the plain print |
| Bottom-right | One status, first match wins: `?` low confidence, cloud `waiting`, heart `wanted`, check `owned` | Owned shows in catalog views only |

Badges are 20 px tall, inset 4 px, with a 1 px contrasting outline. Below 88 px of tile width only the right-hand corners show.

### Motion

| Event | Motion | Reduced motion |
| --- | --- | --- |
| Capture | 120 ms outline flash, frame shrinks into the tray over 300 ms | Outline color change only |
| Sheet | Rises in 250 ms, ease-out | Fades in 100 ms |
| Tab and screen change | No transition | Same |
| Toast | Slides up 200 ms, stays 5 s, or until the next save for Undo | Appears in place |
| Ring progress | Fills over 400 ms on first draw | Drawn final |
| Skeleton | Shimmer | Static tone |

### States

- **Empty:** a card back, one sentence, one primary action.
- **Loading:** 63:88 skeleton tiles and grey row bars; spinners only inside a working button.
- **Offline:** the strip, never a modal or a notice inside a grid. A missing set gets one full-width panel: `151 is not on this phone yet. It downloads the next time you're online.`
- **Image missing:** a navy card back with name, number, set code, and badges (`Image not on this phone` offline), replacing today's grey box that repeats the tile's name.
- **Error:** what failed and what is safe: `Couldn't reach the server. Your 12 cards are saved on this phone.` plus Retry.

## 5. Accessibility and One-Handed Use

1. **Targets:** at least 48 x 48 px, with 8 px between targets. The Scan tab is 64 px, the shutter 72 px, tray tiles 64 px.
2. **Thumb zone:** every primary action sits in the bottom 40 percent of a 740 px screen. Back stays top-left, paired with edge swipe. Nothing destructive sits in the bottom row without Undo.
3. **Sheets, not pages, for decisions:** confirm, Done, filter, edit copy, pocket picker. Each closes with a swipe down, a Close button, and the system back gesture.
4. **Contrast:** text at 4.5:1, large text and non-text marks (rings, borders of inputs, badge outlines) at 3:1, in all 19 themes and both modes. `tests/themes.test.mjs` asserts it.
5. **Never color alone:** owned is a check and full color; missing is dimmed and labeled in the tile text; low confidence is `?` plus a dashed border; danger has a verb (`Remove 3 cards`).
6. **Screen readers:** tiles read `Charizard ex, 151, 6 of 165, Portuguese, 2 copies, holo, owned`. Rings read `6 of 207 owned`. The tray announces each capture through a polite live region (`Added Pikachu, Portuguese. 7 in session.`). Badges are not separate stops.
7. **Text size:** layouts survive 200 percent text; the tab bar drops labels before wrapping them.
8. **Language markup:** original names carry `lang` (`ja`, `ko`, `zh`) for the right voice and glyphs.
9. **Focus:** a visible 3 px `accent-strong` ring; sheets trap focus and return it to the opener.
10. **No hover-only behavior;** long-press always has a visible alternative (the overflow menu).

## 6. Design-Pass Blocks

One engineer agent per block. Blocks 1 to 3 make the scanner real. Blocks 4 and 5 are foundations that can run beside 2 and 3; the tray adopts `cardTile()` when 4 lands.

### 1. App Shell and the Scan Entry

Five icon tabs with Scan raised center; the new header; remove `Menu` and the Phone check tab; offline strip; toasts; a `/scan` route; the manifest shortcut.

- **Accept:** tab labels fit one line at 360 and 412 px; Scan is one tap from every screen; Phone check and Import open from Profile; nothing shifts when the service worker reports.
- **Files:** `index.html`, `app.js`, `style.css`, `js/dom.js`, `js/account-views.js`, `manifest.webmanifest`, `sw.js`.

### 2. Scanner Viewfinder and Tray

The dark camera screen, auto-capture and shutter, zoom, torch, and the tray as an IndexedDB draft, wired to `lab/js/camera.js`, `rectify.js`, `pipeline.js`, and `match.js`.

- **Accept:** a still card is captured once; the tray survives closing the app; every tray tile shows its own language; camera denied offers search; controls sit in the bottom 40 percent.
- **Files:** new `js/scan-view.js`, `js/scan-session.js`, `css/scan.css`; `app.js`; read-only imports from `lab/js/`.

### 3. Confirm Sheet, Done Sheet, and Undo

The half sheet with candidates, sourced language, finish picker from `variants_detailed`, condition, duplicate and wishlist lines, the confidence gate, the Done sheet, and session Undo.

- **Accept:** no low-confidence save without a tap; nothing remembered between cards; a 12-card mixed session saves each card in its own language; Undo removes exactly what was saved; Discard writes nothing.
- **Files:** `js/scan-view.js`, new `js/scan-sheets.js`, `js/collection.js` (save and undo calls), `js/wishlist.js` (lookup), `css/scan.css`.

### 4. Card Tile and Badge Component

One `cardTile()` with the four-corner contract and the image fallback; replace the red ribbon, the always-on language chip, and per-view badge code.

- **Accept:** identical badges for a card in every view; no `×1`; no chip matching the viewing language; red only on Scan and danger.
- **Files:** new `js/card-tile.js`; `js/cards-view.js`, `js/catalog-views.js`, `js/binders-view.js`, `js/wishlist-view.js`, `js/checklists-view.js`; `style.css`.

### 5. Tokens and Offline Type

Type, spacing, radius, and elevation tokens on `:root`; self-hosted Poppins precached; the color role table applied, including dark-mode header and ring tracks.

- **Accept:** no hard-coded sizes or colors outside tokens in `style.css`; airplane mode shows Poppins; ring tracks reach 3:1 in dark mode; the themes test still passes.
- **Files:** `style.css`, `css/`, `js/themes.js`, `sw.js`, new `fonts/`.

### 6. Card Detail

Art beside facts, the viewer, price and Ver na Liga above the fold, copy rows and edit sheet, printings chips, family wants, English-over-original names.

- **Accept:** at 360 x 740 the copies section and Ver na Liga are visible without scrolling; every copy opens an edit sheet; Asian prints say why there is no Liga link.
- **Files:** `js/catalog-views.js`, `js/liga.js`, `style.css`.

### 7. Cards Home

Search, chip row with copy counts, shared viewing language, the filter sheet, the empty state with Scan, and Export / Import moved to Profile.

- **Accept:** chip counts equal copies, never memberships; the first tile row is visible without scrolling at 360 x 740; the empty state's primary action opens the scanner.
- **Files:** `js/cards-view.js`, `js/collection.js`, `style.css`.

### 8. Sets and Set Detail

Code chip and ring on tiles, the logo-less tile fix, TCG Pocket behind a toggle, the big header ring, counted segments in one order, long-press to wishlist, and the full-width offline panel.

- **Accept:** segments read All, Owned, Missing with counts in Sets and Lists alike; the offline panel spans the grid; no set shows its code twice.
- **Files:** `js/catalog-views.js`, `js/catalog.js`, `js/checklists-view.js`, `style.css`.

### 9. Profile, Themes, and Family Mode

Profile layout, live swatch picker, favorite Pokémon, appearance, family and invite, and the read-only lens with its strip and exits.

- **Accept:** themes apply live and persist; the member strip shows on every tab; Scan exits it; a cold start opens your own Cards.
- **Files:** `js/account-views.js`, `js/themes.js`, `js/cards-view.js`, `js/binders-view.js`, `js/checklists-view.js`, `js/wishlist-view.js`, `app.js`, `style.css`.

### 10. Binders

The binder list with cover color spines and notes, the swipeable page view, the pocket picker sheet, and the unplaced list.

- **Accept:** rows in cover color at AA contrast; pages turn by swipe and button; placing a placed card asks to move it.
- **Files:** `js/binders-view.js`, `js/binders.js`, `style.css`.

### 11. Lists and Wishlist

The `Checklists / Wishlist` segment, fixed sprite boxes, the three tick marks with separate row and mark targets, and wishlist rows with priority and notes.

- **Accept:** hand ticks look different from owned in shape and text; Missing works in airplane mode; tapping a mark never opens the row.
- **Files:** `js/checklists-view.js`, `js/wishlist-view.js`, `css/wishlist.css`, `style.css`.

### 12. States and Accessibility Sweep

Every screen's empty, loading, offline, image-missing, and error state per section 4; accessible names on tiles, rings, and the tray live region; 200 percent text; focus trapping in sheets; the import report's stray `null`.

- **Accept:** a scripted run at 360 and 412 px, light and dark, online and offline, shows no clipped text, no `null`, and no notice inside a grid; axe reports no serious issues.
- **Files:** all view modules, `style.css`, `js/import-view.js`, `tests/app.test.mjs`.
