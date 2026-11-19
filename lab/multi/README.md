# Several Cards in One Frame

A lab prototype (Eric, 2026-11-18): recognise several cards in one camera frame, a binder page of
3 x 3 pockets in sleeves or a few cards lying on a table, so a whole page is added in one shot. It
measures two ways of finding the cards, each card then matched by the app's own picture route
(`js/scan/identify.js` `identifyPicture`: straighten, fingerprint, match; `js/scan/picture.js`
`pictureVerdict` for sure), so recognition per card is the single-card scanner's. The scanner's
Binder page (`js/scan/page.js`, under its settings) now reads one upright page by the page path,
and two pages side by side (a spread) as described under Two Pages Side by Side; the free path stays
here.

- **Page path** (`js/scan/steady.js` `findPages`, `js/scan/multi.js` `fitPage`, `pageCells`): find
  the page's outline (or a spread's two), set it right by the cards found in it, cut it into rows x
  cols pockets, find the card's own outline in each pocket (`findCard`), and match each pocket. An
  empty pocket is one with no card outline and no colour (`colourfulness`).
- **Free path** (`js/scan/steady.js` `findCards`): find every card-shaped outline in the frame,
  clear of each other, and match each as the scanner matches the card it finds in the frame (a box
  round it, its outline passed on).

## Running It

From the repo root, with Playwright installed somewhere, and the scan benchmark's cache folder
(`lab/bench`, which holds the 40 card images and recorded TCGdex answers):

```sh
BENCH_CACHE=/path/to/bench-cache PLAYWRIGHT=/path/to/node_modules/playwright \
  node lab/multi/run.mjs --pages 20 --loose 24 --single
```

| Option | What it does |
| --- | --- |
| `--pages 20` | Binder page frames (default 20). |
| `--loose 24` | Loose-card frames (default 24): 2, 3, 4, and 5 cards in turn, every fourth with two touching. |
| `--single` | Also each of the 40 cards alone, as the guide's capture holds it, for the per-card comparison. |
| `--paths page,free` | Which paths run (both by default; loose frames run the free path only). |
| `--throttle 4` | Slows the page's CPU four times, as a mid-range phone, while a path runs (the frame is made at full speed). |
| `--side 360` | The longer side of the grey copy the outlines are found on (the app's `FIND_SIDE_CAPTURE`). |
| `--pad 0.1` | How much larger than its card each pocket is cut. |
| `--no-fit`, `--no-refine` | Leave out fitting the page to its cards, or finding each pocket's own card outline. |
| `--shots <dir>` | Writes each frame with the outlines drawn: green the cards, yellow the pages, red the pockets, blue the free path's outlines. |
| `--photos a.jpg,b.jpg` | Real photos instead, read in place: what each pocket and outline was matched to, with the card's names, for judging by eye. |

The frames (`multi.js`) are 1080 x 1920, as the app's camera frame:

- **Pages**: 3 x 3 cards (63 x 88 mm, pockets 3 mm apart) on a black backing, each card up to 1.2
  mm off and 1.2 degrees turned in its pocket, a sleeve haze and the bright lip of each pocket, the
  welds between pockets, one or two glare bands (45 to 90 % white), and 0, 1, or 2 empty pockets
  (4, 3, and 3 pages in 10). The page fills 82 to 93 % of the frame's width, turned up to 3 degrees,
  each corner moved up to 2.5 % for the slant, over a wood table; then blur, light, and JPEG 0.82.
  Each card is about 300 x 420 pixels.
- **Loose**: 2 to 5 cards on dark or light wood, grey cloth, or a white desk, each 25 to 34 % of
  the frame's height, turned up to 12 degrees, with a soft shadow; a glare spot on one card in a
  third of the frames; every fourth frame two cards laid side by side, a hair apart.

Keep card images and photos out of the repo: the cache folder and any photo stay outside it, and
`run.mjs` refuses a cache folder inside it.

## What It Measured

On this laptop, 2026-11-18, picture only (no number read), the outlines found on the 360 px copy.
**Found**: the card was taken as a card (its picture within `NOT_CARD_DISTANCE`). **Right artwork
first**: the right card is in the first group (the same artwork in all its prints). **Right print
first**: the right card is first in it. **Sure**: the picture alone settles the card
(`pictureVerdict`), with no number read; a reprint group is never sure without its number.

| Frames | Path | Cards | Found | Right artwork first | Right print first | Sure | Wrong but sure | False cards | ms per frame (median, p90) | ms per card |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 20 pages | page | 163 | 91 % | 85 % | 72 % | 38 % | 1 | 3 | 3,587, 5,357 | 356 |
| 20 pages | free | 163 | 61 % | 55 % | 47 % | 26 % | 0 | 12 | 2,725, 3,129 | 254 |
| 18 loose, apart | free | 54 | 94 % | 94 % | 87 % | 43 % | 0 | 0 | 618, 1,092 | 220 |
| 6 loose, touching | free | 30 | 83 % | 80 % | 70 % | 27 % | 0 | 1 | 1,067, 2,183 | 242 |
| 40 single cards | single | 40 | 100 % | 100 % | 98 % | 50 % | 0 | 0 | 243 | 243 |

With `--throttle 4` (10 pages, 12 loose frames, the 40 single cards):

| Frames | Path | Found | Right artwork first | Sure | ms per frame (median, p90) | ms per card |
| --- | --- | --- | --- | --- | --- | --- |
| 10 pages | page | 85 % | 78 % | 37 % | 15,072, 23,610 | 1,509 |
| 10 pages | free | 63 % | 56 % | 23 % | 11,069, 12,695 | 1,411 |
| 9 loose, apart | free | 93 % | 93 % | 41 % | 2,662, 4,944 | 983 |
| 40 single cards | single | 100 % | 100 % | 50 % | 1,068 | 1,068 |

- On 17 of the 20 pages the page path found every card and named its artwork; the 3 others lost
  most of their cards to a wrong page outline (a box closed by the line that runs along a row's art
  boxes, which a 3 x 3 page's shape allows). Empty pockets: 14 of 17 judged empty, 3 taken for a
  card (the wide search brings a dark pocket within 53 to 72 of some card, as near as a card under
  glare; the no-outline-and-no-colour test catches most). The one wrong but sure was the right
  artwork's Japanese print (`SV2D-089` for `sv02-246`), which the label row would settle.
- The free path misses a third of a page's cards: their sides run on into their neighbours', and a
  card's two halves (split by its art box's foot) have a lying card's shape. It does well on loose
  cards apart; two cards side by side stay one box.
- The first run, before the fit to the cards and the empty-pocket test, found the same share but
  named fewer prints (67 % against 72 %) and took 12 of 17 empty pockets for cards.

## Real Photos

Eric's Kanto binder (mostly Portuguese prints, some English, holos, sleeves, a desk lamp's glare),
in three sets, each photo through both paths at the size given (the outline search always on a
360 px copy). Judged by the Pokémon's name against the pages shown; a Japanese name was read as its
species. **Sure was never wrong** on any photo, by either path.

| Set | Photos | Cards | Page path: right name, sure | Free path: right name, sure | Seconds per photo (page, free) |
| --- | --- | --- | --- | --- | --- |
| WhatsApp, 576 x 1280 | 5 (3 single pages, 2 spreads) | 63 | 17, 6 | 23, 9 | 6.2, 3.9 |
| Full resolution, cut to 864 x 1920 | 6 (3 spreads, 3 single pages) | 81 | 21, 4 | 25, 6 | 7.1, 4.3 |
| Full resolution, cut to 1728 x 3840 | 6 | 81 | 29, 6 | 29, 8 | 8.6, 5.2 |
| Galaxy S25 via WhatsApp, 738 x 1600 | 4 (3 spreads, 1 single page) | 63 | 4, 2 | 14, 6 | 8.9, 3.7 |

- **A single upright page whose outline is fitted to its cards works**: page 2 (`1000182577`) 9 of
  9 at 1920 and 8 of 9 at 3840, page 3 (`1000182576`) 8 of 9, page 1 (`1000182578` at 3840, and the
  WhatsApp page 1) 7 of 9. Where the fit fails (fewer than three cards outlined, or cards in one
  row), the outline found is the binder's or the sheet's edge and most pockets are cut wrong.
- **Spreads fail on the page path**: two outlines are found on most of them, but rarely close
  enough to the pages for the pockets (best: 8 of 18 on `1000182575` at 3840). The free path names
  1 to 7 cards of a spread's 18.
- The 3840 copies help a little overall; the finding itself runs on a 360 px copy, so resolution
  mostly helps the match and a future number read.

## Two Pages Side by Side

Eric takes a spread with the phone turned (2026-11-19): the photo stands, the two pages lie one
above the other, and the cards' tops point to the photo's right. The lab's spread path above
failed on them for two reasons this measured: a lying page was cut as if its cards' tops pointed
left, so every pocket was upside down; and on the 360 px copy two lying cards one above the other
make a standing card's shape, so `1000182575` was fitted as one page of nine such pairs and read as
nine wrong cards. The scanner now reads a spread this way (`js/scan/page.js` `readPagePixels`):

1. **Tell the turn on a 720 px copy.** `findCards` there found 9 to 14 of Eric's spreads' 9 to 14
   boxes lying, and none to two of his single pages' 7 to 9 (on the 360 px copy, a spread's boxes
   were as often standing pairs). More lying than standing (`multi.js` `cardsLie`, half or more)
   turns the copy a quarter. So does a dark band of rows across the photo's middle (`darkBand`,
   under 0.6 of the median row: 0.29 to 0.44 on Eric's spreads, 0.14 on the test's synthetic one,
   0.74 to 0.88 on his single pages), the spine, which catches clean prints whose art box splits
   each lying card into two standing boxes (the synthetic spread found 3 of 7 lying). A single
   upright page whose outline its cards set right is read as before only when neither says the
   phone was turned.
2. **Split at the spine.** Cards spread wider than one page's three columns (`twoPages`) are two
   pages; the spine is the darkest band of columns in the middle 30 to 70 % (`spineAt`: 34 to 62
   grey on Eric's spreads, against 73 to 109 for the welds between pockets), and each half is cut
   1.5 % of the width past it.
3. **Fit each page from its cards alone** (`multi.js` `fitGrid`): no outline, which was the
   failing step. The cards found at 360, 420, 480, and 300 px (until 8 fit) are merged, each tried
   in each pocket, and the page that puts most of the others in pockets is fitted to them all. On
   the halves this fitted 3 to 9 cards a page; the outline path fitted 0 to 9, and none on 10 of 16
   halves.
4. **Tell which way up from the faces** (`edgeBalance`, `upsideDown`): a card's artwork half is
   busier than its text half on 84 % of Eric's pockets and 33 of the bench's 40 catalog images, so
   the most pockets decide. Each of Eric's spreads voted 13 or more of 18 the right way, and the
   same photos turned half round were turned back.

Pockets are numbered across both pages, the left page's first (1 to 18).

Measured in the app itself (Binder page, a photo from the gallery, headless Chromium on this
laptop, picture and number read as the scanner runs them), judged by the Pokémon's name and by its
pocket (the binder holds the Kanto Pokédex in order). Before is the scanner at v81 plus binder page
scanning (commit `009430e`).

| Photo | Pages | Before: added, right, sure | After: added, right (in its pocket), sure | Seconds after |
| --- | --- | --- | --- | --- |
| `1000182573` | 8 + 9 | refused | 18, 12 (12), 4 | 14.0 |
| `1000182574` | 6 + 7 | refused | 18, 13 (13), 2 | 16.7 |
| `1000182575` | 4 + 5 | 9, 0, 0 (taken as one page) | 17, 16 (16), 5 | 17.0 |
| `s25-1` | 4 + 5 | 9, 7, 3 (taken as one page) | 18, 16 (16), 5 | 12.7 |
| `s25-2` | 8 + 9 | refused | 17, 12 (12), 4 | 14.0 |
| `s25-4` | 6 + 7 | refused | 18, 14 (14), 3 | 13.2 |
| WhatsApp `page-3` | 2 + 3 | 9, 4, 0 (taken as one page) | 18, 17 (17), 7 | 11.9 |
| WhatsApp `page-4` | 6 + 7 | refused | 18, 13 (12), 3 | 13.2 |
| `1000182576` | 3 | 9, 7, 2 | 9, 7, 2 | 9.1 |
| `1000182577` | 2 | 9, 9, 4 | 9, 9, 4 | 8.4 |
| `1000182578` | 1 | 9, 9, 3 | 9, 9, 3 | 8.2 |
| `s25-3` | 3 | 9, 4, 2 (edges unclear) | 9, 8, 2 | 6.9 |
| WhatsApp `page-1` | 4 | not found | 9, 8, 0 | 8.1 |
| WhatsApp `page-2` | 5 | 9, 5, 3 | 9, 5, 3 | 6.2 |
| WhatsApp `page-5` | 1 | 9, 7, 3 | 9, 7, 3 | 6.4 |

- **Spreads**: 113 of 144 cards named right (78 %), all but one in their pockets, 33 sure,
  **none sure and wrong**. The misses are the picture's (glare, holos), not the cut: the pockets
  cut on four of the spreads were checked by eye.
- **Single pages**: none worse; the two whose outline was not set right (`s25-3`, `page-1`) are now
  fitted from their cards. Finding a page took 0.7 to 1.1 s here (the 720 px copy that tells the
  turn is part of it), finding a spread 2.9 to 3.9 s.
- The same spreads turned half round (cards' tops to the left): `1000182574`, `s25-1` 16 of 18 each,
  `s25-2` 8, and `s25-4` one page only (6). A single upright page taken upside down is still read
  upside down, as before: its outline fits, so it never reaches the vote.

## Recommendation

**Build the page path first, for one upright page per shot, with the cards found by the free path
setting the page right**: find the cards first (`findCards`), take the page whose size is about
nine of them (`findPages` `cardArea`), fit it to them (`fitPage`), then match the nine pockets.
Ask for one page, upright, filling the frame (spreads were added later: see Two Pages Side by
Side). Keep the result a review list, never a silent save: every pocket
not sure goes to the tray as today's unsure card, and sure was never wrong on the real photos.

**Speed.** A page takes 3.6 s on this laptop and about 15 s with the CPU slowed four times (p90 24
s), against about 1.1 s of compute per single card, so nine single scans are 10 s of compute but
nine framings by hand (30 to 45 s in all). A page is one framing and runs best in the picture
worker, pocket by pocket, so the tray fills while it reads. Finding the outlines is 0.3 to 0.5 s of
it at full speed (1.7 s slowed): the free search over a page's many lines is the costly part.

**Capture.** A still photo, not a video frame: on a 1080 x 1920 frame a page's cards are about 300
pixels wide, which the picture match handles, but the number read that settles reprints needs
more. Ask for at least 300 px per card width (a page 950 px wide), better 450 px or more (a 12 MP
still, 3000 px across the page, gives about 900): the phone held parallel over the page, no zoom,
the torch off, and a lamp to the side rather than above (its glare band is what the sleeves throw
back). The WhatsApp copies (cards about 150 px wide) still matched 5 to 9 of 9 on single pages whose
outline fitted, so the floor is lower than the number read's.

**Main failure cases.**

- **The page outline**: the sheet's edge, the binder's, or a row's art-box line taken for the page,
  which the fit to the cards repairs only when three or more cards over two rows and two columns
  are outlined.
- **Glare**: a band across a pocket hides the artwork; those pockets come back unsure or are taken
  for empty.
- **Empty pockets**: 3 of 17 taken for a card on the synthetic pages; a card under strong glare can
  be taken for empty.
- **Cards touching** (loose): two cards side by side make a lying card's shape and stay one box.
- **Reprints and language twins**: the picture names the artwork; the print needs the number or the
  label row read, which these runs left out.
- **A pocket's language** (in the app, 2026-11-19): on Eric's three upright pages run through Binder
  page, no Western pocket read its language (every one took the default), and the label row read
  "no Latin text" on Portuguese cards. That reading counted as Asian, so the last Asian pick ordered
  the prints and four Western cards came out as their Japanese twins (Caterpie, Metapod, Pidgey,
  Sandshrew), and a Portuguese Charizard ex was left with no language. On a pocket it no longer
  counts (`js/scan/session.js` `applyRead`, `applyLabel`): all four come out Western, still asking for
  a look, and the Charizard takes the Western default. Japanese, Korean, or Chinese text actually
  read still counts. English against Portuguese stays unsettled on a pocket.

## Checking With Real Photos

Run `--photos` on Eric's binder photos (kept outside the repo), one upright single page per shot at
full resolution and at 1920 px: every pocket's first candidate should name the card in it, empty
pockets none, and no sure answer may be wrong. Then the same pages as WhatsApp copies, and the
spreads, which must never be read as one page.
