# Image Fingerprints: Results

A prototype of the image-first recognition that DESIGN.md section 6 plans ("fingerprint first, text
to break ties"), measured on 2026-10-03 against the OCR scanner (v22, the same code as v17) on
the same captures. Nothing in the app loads it.

## Summary

- On the scan benchmark's 240 captures, the fingerprint puts the right card first **229 times
  (95 %)** and the right artwork first **237 times (99 %)**. The OCR scanner gets **195 (81 %)**
  on the same captures, re-measured for this comparison with the same result as v17.
- It takes **about 28 ms** from capture to candidates on a laptop (rectify 22 ms, fingerprint 2
  ms, match 4 ms), and **about 109 ms at 4x CPU throttle**, of which the fingerprint and the match
  are 24 ms. The OCR scanner's median is 1.1 to 2.3 s per capture with no throttle.
- No text is read, so Japanese and Korean cards are recognised the same way as English ones:
  96 % artwork first on degraded Japanese images.
- Full-art cards (special illustration rares, illustration rares, gold, full-art ultra rares):
  **98 % artwork first and 93 % exact card first** over 1,123 cards from the Scarlet & Violet and
  Mega Evolution sets, each through 10 degradations.
- The Portuguese Ampharos special illustration rare from Chaos Rising (`me04-090`) is first in
  all 10 degradations, by a wide gap (27.6 to 67.8; wrong answers have a median gap of 1.6). The
  Weedle photo (`me04-001`, a phone photo of a laptop screen) is first with a gap of 39.5.
- The index of all 23,621 cards (English, Portuguese where English has no image, Japanese) is
  **1,378 KB, 1,110 KB gzipped**. A build from an empty cache takes about 18 minutes, nearly all
  of it downloading 23,621 images (about 480 MB on disk) four at a time; with the images cached, 5 minutes;
  with the descriptors cached as well, 2 seconds.
- When the fingerprint is wrong about the exact card, the right card has the same artwork **63 %
  of the time** on degraded images and **73 %** on the benchmark: reprints, a Japanese print and its
  English twin, or a Portuguese card's English image. Text has to break those ties.

**Recommendation: adopt, with changes.** Use the fingerprint as the scanner's first step and keep
OCR only for the tie-breaks below. The changes are in "Integration plan": ship the index through
the service worker, read text only when the first group holds more than one card, and measure on
Eric's phone with real cards before removing the OCR-first route.

## What Was Built

| File | What it does |
| --- | --- |
| `fingerprint.js` | The descriptors, browser and Node alike: a 96 x 134 thumbnail of the straightened card, then a DCT pHash of the art box, a pHash of the whole card face, and a colour layout. |
| `matcher.js` | Loads `index.bin`, fingerprints the crop at 7 small shifts (edges found slightly off), scans every card, returns the 5 best artwork groups with their distances. |
| `pack.js` | The packed index format: a JSON header, then columns per card. |
| `catalog.mjs` | Which TCGdex cards go in, and a gentle downloader (4 at a time, retries, cached, 404s remembered). |
| `build-index.mjs` | Downloads, describes every image in headless Chromium with `fingerprint.js`, groups shared art, writes `index.bin`. |
| `measure.mjs`, `summarize.mjs` | The measurements below. |
| `harness.html`, `harness.js`, `serve.mjs` | The headless page the builder and measurements drive. |
| `index.html`, `page.js` | The Fingerprint Lab: camera or a picked photo, the scanner's own `rectify.js`, then the matcher. Linked from the Scan Lab. |
| `index.bin` | The index, built 2026-10-03 from TCGdex images only. |

### The Descriptors

All three come from one thumbnail of the straightened card, so the crop is read once whatever
its size.

- **Art box pHash**: the illustration window (8 to 92 % across, 11 to 52 % down, as
  `js/scan/artwork.js` uses), averaged to 32 x 32 grey, 2-D DCT, the 128 lowest frequencies (DC
  left out) as bits against their median.
- **Whole card pHash**: the same over the card face inside a thin margin (border and sleeve
  edge). This is what carries full-art cards, whose picture runs past the art box.
- **Colour layout**: the art box as an 8 x 8 grid in YCbCr, each channel's DCT; Y's shape at unit
  length (exposure does not count), Cb and Cr's first three coefficients as signed bytes.

Score per card: `art + 0.5 card + 0.1 colour` on framed cards, `0.6 art + card + 0.1 colour` on
full-art cards (flagged in the index from TCGdex rarities), each distance the best over the
query's 7 shifts. Every card is scanned: two 128-bit Hamming distances for all 23,621, then the
colour layout for the best 400.

### Artwork Groups

Cards are joined into one group when their 128-bit art box hashes are within 18 bits and their
colour layouts agree. 23,621 cards make 19,349 groups; 3,554 groups hold more than one card
(7,826 cards). The largest are what one would expect: the same trainer or energy art across
English and Japanese sets (`me01-130`, `sv01-194`, `SV3a-054`, `SV5a-056`, `SVK-022`, and three
more), and Wizards-era trainers reprinted across Base, Base Set 2, Gym, and Neo. The matcher
returns groups, and the members of a group are what text or the person decides between.

Portuguese cards are not indexed separately: every Portuguese card with an image has the same id
in English, and the English image is used (the Portuguese images also send a doubled CORS
header, DESIGN.md section 5). Only `sm3.5`, whose 85 cards have Portuguese images and no English
ones, is indexed from Portuguese. This also covers a new set whose Portuguese images TCGdex has
not added yet.

## Accuracy

### Scan Benchmark: Fingerprint Against the OCR Scanner

The benchmark's 40 cards (16 modern English, 12 modern Portuguese, 12 Wizards-era English) through
its 6 captures, made by the benchmark's own capture code and straightened by `js/scan/rectify.js`.
The query is each card's `high.webp`; the index holds the `low.webp`, a different rendering.
"Right card first" for the fingerprint is the exact card id; a Portuguese card counts as right
when the English record of the same id is first.

| Capture | OCR scanner: right card first | Fingerprint: right card first | Fingerprint: right art first | Fingerprint: right art in top 5 |
| --- | --- | --- | --- | --- |
| clean | 88 % (35) | 95 % (38) | 100 % (40) | 100 % (40) |
| blur | 70 % (28) | 100 % (40) | 100 % (40) | 100 % (40) |
| glare | 83 % (33) | 93 % (37) | 100 % (40) | 100 % (40) |
| tilt | 88 % (35) | 98 % (39) | 100 % (40) | 100 % (40) |
| jpeg | 80 % (32) | 98 % (39) | 98 % (39) | 100 % (40) |
| nonumber | 80 % (32) | 90 % (36) | 95 % (38) | 95 % (38) |
| **all, 240** | **81 % (195)** | **95 % (229)** | **99 % (237)** | **99 % (238)** |

By group: modern English 96 % right card first, modern Portuguese 90 % (97 % right art), Wizards-era
100 %. The three art misses: `swsh7-210` (no number) as `sm12-192`, `sv02-246` (JPEG 0.3) as
`dp4-28`, `swsh9-045` (no number) as `sv09-017`. Of the 11 wrong first cards, 8 had the right
artwork, so the number or set would have fixed them.

| Time per capture | OCR scanner | Fingerprint |
| --- | --- | --- |
| Laptop, no throttle | median 1.1 to 2.3 s by capture, p90 up to 3.5 s | median 28 ms, p90 35 ms |
| Laptop, 4x CPU throttle | not re-measured (v17: 1.1 to 2.6 s; throttle does not reach OCR workers) | median 109 ms, p90 124 ms (fingerprint 8 ms, match 16 ms, the rest is rectify) |

The index loads and unpacks in 14 ms.

### Degraded TCGdex Images

1,604 cards, each through 10 degradations applied to the straightened card (16,040 queries):

- **Full art**: every special illustration rare (222), illustration rare (715), gold (hyper rare,
  Mega hyper rare, black white rare, shiny ultra rare: 106) of the `sv` and `me` sets, and 80
  random ultra rares, all English.
- **Framed**: 300 random English cards of any era.
- **Japanese**: 120 random Japanese cards.
- **Portuguese**: 60 Portuguese `sv`, `me`, and `swsh` cards, the query being the Portuguese
  image and the right answer the English record.
- The Portuguese Ampharos special illustration rare.

Degradations: `clean` (0.3 px blur, JPEG 0.9); `blur` (2.2 px); `glare` (two bright spots
anywhere); `cast` (warm sepia or cool hue turn); `jpeg40`; `rotate` (3 to 5 degrees left after
rectify); `shift` (the crop off by up to 10 % of the card, part of it as scale); `sleeve` (haze and
a sheen); `foil` (rainbow bands over the art box, or the whole card on full arts); `phone` (milder
blur, cast, glare, rotation, shift, sleeve, and JPEG 0.6 together).

| Query set | n | Exact card first | Art first | Art in top 5 | Errors with the right art (text decides) |
| --- | --- | --- | --- | --- | --- |
| Full art | 11,230 | 93 % | 98 % | 99 % | 65 % (526 of 805) |
| Framed | 3,000 | 91 % | 96 % | 97 % | 49 % (130 of 263) |
| Japanese | 1,200 | 88 % | 96 % | 97 % | 70 % (103 of 147) |
| Portuguese, English image | 600 | 87 % | 96 % | 96 % | 67 % (52 of 78) |
| Ampharos SIR (pt) | 10 | 100 % | 100 % | 100 % | - |
| **All** | **16,040** | **92 %** | **97 %** | **98 %** | **63 % (811 of 1,293)** |

| Full art by rarity | n | Exact card first | Art first | Art in top 5 |
| --- | --- | --- | --- | --- |
| Special illustration rare | 2,220 | 93 % | 98 % | 99 % |
| Illustration rare | 7,150 | 93 % | 98 % | 99 % |
| Gold | 1,060 | 92 % | 97 % | 98 % |
| Ultra rare | 800 | 96 % | 98 % | 99 % |

| Degradation | Exact card first | Art first | Art in top 5 |
| --- | --- | --- | --- |
| clean, blur, cast, jpeg40, foil | 99 % each | 100 % | 100 % |
| sleeve | 97 % | 100 % | 100 % |
| glare | 90 % | 99 % | 100 % |
| rotate (3 to 5 degrees) | 87 % | 100 % | 100 % |
| phone (all, milder) | 85 % | 99 % | 100 % |
| **shift (10 % crop error)** | **65 %** | **72 %** | **81 %** |

Nearly every real miss (449 of 482) is the 10 % crop shift: when `rectify.js` puts the card's
edges a tenth of a card off, the art box no longer lines up. On the benchmark captures
`rectify.js` found every card's edges, and the 7 query shifts (2 to 2.5 %, plus 5 % zoom) recover
smaller errors. A real photo whose edges are badly found would need either better edges or
more shifts at a few milliseconds each.

### Which Descriptor

All degraded queries, right art first (exact card first in the last column):

| Descriptor | Framed | Full art | Japanese | Portuguese | All | Top 5 | Exact |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Art box pHash, 64 bits | 88 % | 90 % | 88 % | 88 % | 90 % | 93 % | 84 % |
| Art box pHash, 128 bits | 92 % | 93 % | 93 % | 92 % | 93 % | 94 % | 88 % |
| Whole card pHash, 64 bits | 80 % | 90 % | 84 % | 81 % | 88 % | 93 % | 83 % |
| Colour layout alone | 72 % | 76 % | 75 % | 75 % | 75 % | 82 % | 71 % |
| Art 64 + colour | 91 % | 93 % | 92 % | 92 % | 92 % | 95 % | 87 % |
| Art 64 + card 64 | 93 % | 96 % | 95 % | 94 % | 96 % | 98 % | 91 % |
| Art 64 + card 64 + colour, full-art weights | 93 % | 96 % | 95 % | 94 % | 96 % | 98 % | 89 % |
| Same without the query shifts | 89 % | 93 % | 92 % | 91 % | 92 % | 95 % | 85 % |
| **Art 128 + card 128 + colour, full-art weights (shipped)** | **96 %** | **98 %** | **96 %** | **96 %** | **97 %** | **98 %** | **92 %** |

The whole card hash is what makes the combination work, on full arts and on framed cards alike
(its text and frame tell sets apart). The colour layout adds little once both hashes are in: it
is kept because it is 16 bytes and breaks some near ties. 128-bit hashes gain about 1.5 points
over 64-bit ones for 16 more bytes per card (1,378 KB against 1,009 KB).

### Auto-Select Threshold

The gap between the first and second group's scores, over all 16,280 queries (degraded and
benchmark):

| Auto-select when the gap is at least | Share selected | Of those, right art |
| --- | --- | --- |
| 6 | 95 % | 99.8 % (24 wrong) |
| 8 | 94 % | 99.9 % (9 wrong) |
| 10 | 93 % | 100 % |
| 12 | 92 % | 100 % |

The median gap is 55 when the first group is right and 1.6 when it is wrong.

### Real Photos

One real photo only, the Weedle (`me04-001`, a phone photo of a laptop screen, read in place):
right card first, gap 39.5. Real cards with real holo foil and sleeves are not measured yet.

## Limits of These Numbers

- The queries are TCGdex scans degraded on a computer, not phone photos of cards. Real foil
  glints, deep shadows, and a card held at a strong slant are only approximated.
- The index covers what TCGdex has images for: English (except TCG Pocket), Japanese S and SV
  sets (3,882 cards), and `sm3.5` in Portuguese. Japanese `M4` and `M6` have no images on TCGdex
  (DESIGN.md section 5), so Korean and Japanese Mega-era prints can only match through an English
  twin, and `M6` has none yet.
- Exact card first counts a reprint with identical art as an error, even though no picture
  method can tell them apart.
- The full-art flag comes from TCGdex rarities (`Ultra Rare` includes some framed ex cards). The
  weights differ only a little, so a wrong flag costs little.

## Integration Plan

**Order of a scan.** Rectify (as now), then fingerprint and match (about 25 ms on a phone-class
CPU). Then:

1. **First group alone and gap of at least 10**: auto-select it. If the group holds one card,
   that is the card. Measured: 93 % of captures, none wrong.
2. **First group holds several cards** (reprints, the Japanese and international prints, a
   Portuguese copy of an English record): OCR only the collector number, total, and the language
   label (or the script check), and use them to choose inside the group. A small crop read, not
   the full read of name, HP, and attack.
3. **Gap under 10**: show the top 5 groups as images to tap, prefilled with the first; run the
   number read in the background and promote a candidate it confirms.
4. **Picture and text disagree** (the number names a card outside the top 5 groups): flag the
   card for a look rather than saving it (DESIGN.md section 6, scan safety).

The finish (reverse holo, Poke Ball) stays the one-tap finish picker; no picture method tells it
apart.

**How the index ships.** `index.bin` (about 1.4 MB, 1.1 MB gzipped over the wire) precached by the
service worker on install, outside the opaque-image cap since it is same-origin. The app loads it
once per visit (14 ms to unpack). A scheduled GitHub Actions job (free for a public repository)
runs `build-index.mjs` weekly with the images cached between runs, so only new sets are
downloaded, and commits the index when it changes; a new `index.bin` is a new service worker
version. Building it on the phone from cached images is not worth it: the phone does not have
most catalog images, and fetching 23,000 of them per device is what the gentle server-side build
avoids. Before the job is scheduled, confirm TCGdex's terms allow bulk image processing for an
index (DESIGN.md section 6 already lists this).

**Size cost.** 1.1 MB more on first install, against 5 to 7 MB for Tesseract and its model,
which the scanner could then load lazily, only when a tie needs text. Adding French or other
catalogs costs nothing for international cards (they share the English art) and about 58 bytes
per card for any catalog with its own images.

**Korean cards.** Korean prints share the Japanese art, and their text is not needed to find the
picture, so a Korean card is matched to the Japanese record of the same art and saved as a Korean
copy of it, which is the fallback DESIGN.md section 5 already describes for Korean sets. The gap
is the Mega era: Japanese `M4` and `M6` have no images on TCGdex, so a Korean `M4` card matches
only through the English twin of its art when one exists (the `me` sets), and `M6` cards, which
have no English set yet, are not found by picture. For those the owner's own scan photo, once
saved, can be added to a per-device extension of the index, so a second copy of the same card is
recognised.

**Before switching the scanner.** Run the Fingerprint Lab on the phone with Eric's 20 to 30 test
cards (Portuguese, Korean, full arts, sleeved), compare with the Scan Lab, and check the 10-point
gap threshold on real photos.

## Rebuilding and Measuring

```sh
export FP_CACHE=~/.cache/pokemon-card-tracker-fingerprints   # outside the repo
export PLAYWRIGHT=/path/to/node_modules/playwright
node lab/fingerprints/build-index.mjs
node lab/fingerprints/measure.mjs --bench lab/bench/dataset.json --timing --throttle 4 --out rows.json
node lab/fingerprints/summarize.mjs rows.json --formula '128-bit art + card + colour, full-art weights'
```

`--photo <file> --box x,y,w,h --truth <id>` adds one photo, read in place. Never commit a personal
photo or anything made from one, and never commit the cache.
