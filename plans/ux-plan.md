# Pokémon Card Tracker: UX and Design Plan

Plan for the first screens; nothing is built. Inputs: `../DESIGN.md` (2026-10-01), monprice store screenshots, the pokedex source. Settled by Eric since `DESIGN.md` was written: nothing is private in a family group; membership is invite-only and only Eric invites; no public sign-up; no pokedex link; card images are cached on the device, and only owned-card images and uploads live on the server.

**(Assumption)** marks my inference. `<member>` stands for any family member.

## 1. Design Principles

1. **The card says what it is.** Language, variant, and match come from the scan and show before saving. Fixes monprice's sticky language setting (`DESIGN.md` §2).
2. **Nothing saves on a guess.** Low confidence blocks the save until a tap, and every save can be undone (§6).
3. **Counts you cannot miss.** Quantity, language, and variant sit on the image's corners. Fixes monprice's easy-to-miss `x2` (§2, §3).
4. **One hand, bad signal.** Scanner controls sit in the bottom third. Every write works offline and says so (§3).
5. **Card art is the hero.** Quiet chrome, cards over numbers. No portfolio view (§1).

## 2. Information Architecture

| monprice tab | This app | Why |
| --- | --- | --- |
| Search | **Sets** | Catalog by language and set, search on top. Keeps monprice's set tiles and ring (§2). |
| Collections | **Cards** (home) | Every owned copy, because owning is the base set (§3). Collections filter it; you never save into one. |
| Scan | **Scan** (center, raised) | The thumb's natural spot. Opens straight to the camera. |
| Portfolio | **Binders** | Portfolio goes unused (§1). Binders mirror real ones and get edited often. |
| Profile | **Goals** | Goals and wishlist both answer "what do I still want?". Settings are rare, so Profile becomes a header avatar. |

- **Collections, Favorites, Trade, Openings:** a chip row on Cards: `All · Favorites · Trade · Star · Openings · + New`. Trade and Openings are derived views, so they sit beside collections.
- **Wishlist:** a second segment on the Goals tab.
- **Family:** a switcher in the header of Cards, Binders, and Goals (`Eric ▾`). Picking a member puts the app in their read-only view, with a banner on every screen: `<member>'s cards · view only · Back to mine`. Scan always saves to you and returns you to your own view.
- **Settings:** the avatar opens Profile: account, family members, monprice import, CSV and JSON export, offline downloads, currency. Only Eric sees **Invite member**. The only entry screen is sign-in.
- **Search:** in Sets it searches the catalog and marks owned cards; in Cards, only what you own.

## 3. Key Flows

### Single scan

1. Tap Scan. The camera opens with a card outline and captures on its own when the card is steady. A large shutter is the fallback.
2. The confirm sheet rises to half height: match, detected language, variant, condition.
3. If owned: `You have 1 (PT, holo). Add another?` If a binder placeholder waits: `Goes in Binder 2, page 7, slot 4`, with **Place it there** on.
4. **Save** shows `Saved Pikachu (PT) · Undo`. **Scan next** drops the card into the tray and the scanner becomes a batch session, with no mode to remember (§9). **Discard** is the shop check: "do I own this?" with nothing written.

Fails: no match (manual search prefilled with the OCR text); several candidates (top three beside the captured photo); camera denied (manual entry, link to settings); glare (`Tilt the card to cut the glare`).

### Batch session

1. Each card lands in the tray with its own language chip. A card held still is not captured twice; the frame must change first.
2. **Low confidence:** amber `?` and a dashed border. **Done** reads `Save 11 · 1 needs a look` and only jumps to that card, whose sheet shows the candidates side by side.
3. **Duplicate:** already owned, or scanned twice in this session, shows the quantity it will have after saving (`x2`). No prompt. A second scan in the same session adds `twice in this session`, so an accidental double capture stands out.
4. **Wrong language for the whole session:** tray menu **Set for all → Language → Korean**. Preview: `Changes 9 cards. Keep the 2 you set by hand?` The same menu sets variant and condition.
5. **Done:** one sheet with optional collections, per-card overrides, and the duplicate decision: `3 duplicates · Add as extras / Review each / Skip`. Then `Saved 12 cards · Undo session`.

Fails: offline matching that needs the server waits, shown as the captured photo with `Waiting for signal` (§6). The tray lives in IndexedDB, so leaving the scanner or closing the app keeps it as a draft.

### A set in another language

1. Sets reads `Viewing: English ▾`. It changes display only, never scanning or saving.
2. Set tiles count owned cards in any language (§3).
3. In English Base Set, the PT Charizard shows in full color with a `PT` chip. Unowned cards are dimmed.
4. In Japanese, the PT copy marks nothing, because Japanese sets are their own records. Korean M4 copies show as `KO`, because they use the Japanese record (§5).

Edge: a vintage set with no Portuguese list shows English records with `No Portuguese list for this set. Showing English.` Korean has no Mega-era sets; a note at the end points to the Japanese ones.

### A binder page with Michi art

1. **New binder:** name, grid (2x2, 3x3, 3x4 as quick picks, a stepper up to 5x4), page count.
2. Tap a pocket. The picker opens on **Not in a binder yet**, with the shared filter bar, plus **Placeholder**, **Michi art**, **Leave empty**.
3. A copy placed elsewhere asks `This copy is in Binder 1, page 3. Move it here?` A spare copy is offered first when quantity allows.
4. **Michi art:** tap the first pocket, tap the last. Upload an image, crop it to the block, and tap the pockets that keep a real card. No drag, so it works one-handed.
5. **Print inserts** makes a PDF.

Fails: an image under 300 DPI warns with its real DPI; shrinking a filled grid shows which pockets fall off first; a copy traded away leaves a placeholder, not a hole **(Assumption: the right default)**.

### Goal missing list to wishlist

1. Goals → **Every Pokémon**: `612 / 1,025`, missing list by Dex number.
2. Each row shows the Pokémon and its cheapest card. The heart wishlists that card; long-press picks another.
3. Goals are offline by default for shop use. Only images already on the phone show (§6).

### A family member's cards

1. `Eric ▾` → **<member>**. The banner turns that member's color.
2. Their Cards, Binders, Goals, and Wishlist show as they see them. Edit controls are hidden, not greyed.
3. Each of their cards says `You have this x2`, trade matching without building it.

Edge: an empty member reads `<member> hasn't added cards yet.` Someone in no group never sees the switcher.

## 4. Screen Inventory

Phone width, about 40 characters.

**Scanner with tray**

```
+--------------------------------------+
| Offline · 4 waiting      [+ Opening] |
|                                      |
|    +----------------------------+    |
|    |                            |    |
|    |     ( card outline )       |    |
|    |                            |    |
|    |       Hold steady          |    |
|    |                            |    |
|    +----------------------------+    |
|                                      |
|  Saved Pikachu 025 PT       [Undo]   |
|--------------------------------------|
| Tray 7                  [Set all v]  |
| +-----+ +-----+ +-----+ +-----+      |
| |PT   | |KO x2| |JA   | |    ?| ...  |
| |     | |     | |     | |     |      |
| |  REV| |     | |  1st| |     |      |
| +-----+ +-----+ +-----+ +-----+      |
|--------------------------------------|
| [Close] [Torch]  (  O  )   [Done 7]  |
+--------------------------------------+
```

**Confirm sheet**

```
+--------------------------------------+
|           (camera, dimmed)           |
|======================================|
| +--------+  Charizard                |
| | photo  |  Base Set · 4/102         |
| | vs     |  Match: high              |
| | catalog|                           |
| +--------+                           |
| Language (read from card)            |
| [PT detected] [EN] [JA] [KO] [More]  |
| Variant                              |
| [Unlimited] [Shadowless] [1st Ed]    |
| Condition  [Not set v]               |
|                                      |
| You have 1 (PT, holo). Add another?  |
| Goes in Binder 2 · p7 · slot 4  [on] |
|                                      |
| [Discard]  [Scan next]  [  Save  ]   |
+--------------------------------------+
```

**Set browser**

```
+--------------------------------------+
| (o) Search cards and sets      [Eric]|
| Viewing: English v      [grid][list] |
| [Filter v] [Sort: Release v]         |
|--------------------------------------|
| Scarlet & Violet                     |
| +----------------+ +----------------+|
| | SVI     (2/198)| | PAL    (41/193)||
| |   [set logo]   | |   [set logo]   ||
| | Scarlet & Viol.| | Paldea Evolved ||
| +----------------+ +----------------+|
| Base                                 |
| +----------------+ +----------------+|
| | BS     (12/102)| | JU      (0/64) ||
| |   [set logo]   | |   [set logo]   ||
| +----------------+ +----------------+|
|--------------------------------------|
| Cards  Sets  ( Scan )  Binders Goals |
+--------------------------------------+
```

`(2/198)` stands for the ring plus the number, as on monprice.

**Card detail**

```
+--------------------------------------+
| <  Charizard               [♡] [...] |
| +----------------------------------+ |
| |PT                            x2  | |
| |                                  | |
| |          [ card art ]            | |
| |                                  | |
| |1st                               | |
| +----------------------------------+ |
| Base Set · 4/102 · Rare Holo         |
| Mitsuhiro Arita                      |
|--------------------------------------|
| Your copies                          |
|  PT · 1st Ed · LP   Binder 1 p3 s5 > |
|  PT · Unlim. · NM   Not in a binder >|
| [+ Add copy]                         |
|--------------------------------------|
| Price (TCGplayer, USD, EN market)    |
|  $412 · 30d trend up 4%              |
| In: Star · Vintage   Goals: 2        |
+--------------------------------------+
```

**Binder page editor**

```
+--------------------------------------+
| <  Binder 2 · Mega          [Print]  |
| Page 7 of 20      3x3      [<] [>]   |
| +----------+----------+----------+   |
| |  card    |  art     |  art     |   |
| |    x1    |  tile    |  tile    |   |
| +----------+----------+----------+   |
| |  art     |  card    |  art     |   |
| |  tile    | featured |  tile    |   |
| +----------+----------+----------+   |
| | :want:   |  empty   |   ( + )  |   |
| | greyed   | on purp. |          |   |
| +----------+----------+----------+   |
|                                      |
| 14 owned cards not in any binder >   |
| [Michi art]  [Placeholder]  [Clear]  |
+--------------------------------------+
```

**Goal progress**

```
+--------------------------------------+
| <  Every Pokémon            [...]    |
|        ( 612 / 1,025 )  60%          |
|  Offline: on      Missing 413        |
| [Filter v] [Sort: Dex # v]           |
|--------------------------------------|
| #004 Charmander                      |
|   cheapest: SV 151 · R$2      [♡]    |
| #007 Squirtle                        |
|   cheapest: MEW 007 · R$3     [♥]    |
| #133 Eevee                           |
|   no image offline [?] · R$4  [♡]    |
|--------------------------------------|
| Cards  Sets  ( Scan )  Binders Goals |
+--------------------------------------+
```

## 5. Component and Badge System

Every badge pairs color with text or a glyph.

| Badge | Looks like | Corner | Shows when |
| --- | --- | --- | --- |
| Quantity | `×3`, dark pill | Top-right | Quantity above 1, or a tray duplicate |
| Language chip | `PT`, outlined pill | Top-left | Copy language differs from the viewing language; always in the tray |
| Variant marker | `REV`, mini Poké Ball, mini Master Ball with `M`, `1st` | Bottom-left | Any variant but the plain print |
| Low confidence | Amber square with `?` | Bottom-right | Match, language, or variant under threshold |
| Owned ring | Ring plus `12 / 102` | Set tile top-right; goal header | Always |
| Placeholder | Greyed art, dashed border, `Want` | Whole binder pocket | A card not owned yet |

Bottom-right is the status corner. It shows one thing, in this order: low confidence, `Waiting for signal`, favorite. Corners never stack, so a reader learns four positions once. Under about 90 px of tile width, only quantity and status show **(Assumption: test the threshold on a phone)**.

A Cards tile is one copy row (card, language, variant, condition), as `copies` stores it. **Group by card** in the filter bar merges rows into one tile with a total and a chip such as `PT+EN`.

## 6. States

- **First run:** an invited person signs in, then sees **Scan your first card** and **Import from monprice**. Sets works at once.
- **After the monprice import:** a summary whose lines each open a filtered list: `1,611 copies imported. 74 use English records. 55 Korean use Japanese records. 5 need manual entry. 135 reverse holos set to plain reverse: check ball patterns.` The chip row says `Import each monprice collection, such as Star, as tags.`
- **Offline:** a slim bar, `Offline · 4 changes waiting`, never a modal. On-device OCR still runs; server matching queues with its photo. This needs a downloaded catalog per language **(Assumption: `DESIGN.md` does not say the catalog is stored for offline lookup)**.
- **Images failing:** a missing image falls back to a card-back tile with name, number, set, and badges, still tappable. Offline it reads `Image not on this phone`, so it does not look broken. The pokedex only does this for cards with no scan; a failed load there leaves a blank, which the 2026-10-01 outage exposed.
- **Loading:** skeleton tiles in the card's 63:88 shape, so the grid does not jump.
- **Errors:** say what failed and what is safe: `Couldn't reach the server. Your 12 cards are saved on this phone.` A failed CSV import lists bad rows by line and imports nothing.

## 7. Visual Direction

Share the pokedex identity, not its device chrome. Its bevels and lens suit one entry at a time and would crowd a grid of art.

- **Type:** Poppins, as in the pokedex, which loads 400 and 700. Add 600 for labels. Check that its figures align for prices **(Assumption)**.
- **Palette** (from `style.css`):
  - Red `#dc0a2d`: the Scan button and destructive confirms only.
  - Yellow `#ffcb05`: owned progress and the active tab. A fill, never text, since it fails contrast on white.
  - Blue `#306cb3` and navy `#1d2e60`: links, selection, text.
  - Surfaces: `#f4f4f6` light, `#16181d` dark **(Assumption)**. The scanner is always dark.
  - The 18 type colors (`.details.fire` and the rest) can tint a One Pokémon goal header.
- **Art as hero:** 8 px gutters, no frames, real-card corner radius, no gradients behind cards, small grey prices. The largest thing on any screen is a card.

## 8. Accessibility and One-Handed Use

- **Tap targets** at least 48 px. Tray tiles are 64 px wide.
- **Thumb reach:** shutter, Done, Torch, Close, and tray sit in the bottom third; the top shows only status. The confirm sheet's buttons sit on its bottom edge. Auto-capture makes most scans tapless.
- **Capture feedback:** sound, an outline flash, and haptics where available.
- **Not color alone:** every badge has text or a glyph. Low confidence is `?` plus a dashed border.
- **Screen readers:** `Charizard, Base Set 4 of 102, Portuguese, 2 copies, 1st Edition`.
- **Hosting** **(Assumption: general platform behavior, not verified)**:
  - **PWA on GitHub Pages:** iOS Safari lacks torch control and vibration, and may evict IndexedDB for a site not on the home screen, which threatens the offline queue. Prompt to install and keep the `waiting` count visible.
  - **Native:** adds torch, haptics, finer focus, and background sync.

## 9. Review of the Requirements

**Change**

- **Drop the single-versus-batch split.** Two behaviors imply a mode, and a forgotten mode is monprice's language bug again. Make every scan a session: a session of one shows the confirm sheet and its duplicate prompt; **Scan next** turns it into a tray. Every recorded decision survives.
- **Undo "until the next scan starts" is too short** with auto-capture, which can start a scan within a second. Keep the banner until the next save, and allow undoing the last session from history.
- **Trade (open question):** count extras per card and language. For a collector of Portuguese cards, a PT and an EN copy are both keepers.

**Missing**

- **A "check, don't save" scan** for shops. Discard covers it, but it may be the most common shop use **(Assumption)**.
- **Removing or trading away a copy:** decrement, delete, and the binder pocket left behind.
- **Condition at scan time.** It drives price, and the camera cannot read it. Default `Not set`, with **Set for all → Near Mint**.
- **Every Pokémon to wishlist.** A missing item is a Pokémon; a wishlist item is a card. I propose the cheapest card by default, with long-press to choose.
- **Michi across facing pages.** `binder_art` holds one page; many layouts span a spread **(Assumption)**. Decide before the editor.

**Overbuilt or deferrable**

- **Print inserts** rest on unverified specs (§11). Ship placement first.
- **Collection value:** keep it to card detail and opening summaries. A total on the Cards header drifts back toward a portfolio.

**Confusing**

- **Viewing language versus printed language** must read differently: `Viewing:` in Sets, `Printed in:` on a copy.
- **Asian prints are separate records** (§3), so "owned in any language" holds within a catalog, not across. A PT copy will never mark a Japanese Charizard. Say so once in Sets, or it reads as a bug.
